import { createHash } from "node:crypto";

const ALLOWED = {
  CREATED: new Set(["CREATED", "PENDING", "PAID", "FAILED", "EXPIRED", "CANCELLED"]),
  PENDING: new Set(["PENDING", "PAID", "FAILED", "EXPIRED", "CANCELLED"]),
  PAID: new Set(["PAID", "REFUNDED", "PARTIALLY_REFUNDED"]),
  PARTIALLY_REFUNDED: new Set(["PARTIALLY_REFUNDED", "REFUNDED"]),
  FAILED: new Set(["FAILED"]),
  EXPIRED: new Set(["EXPIRED"]),
  CANCELLED: new Set(["CANCELLED"]),
  REFUNDED: new Set(["REFUNDED"]),
};

const EVENT_STATUS = Object.freeze({
  "commerce.order.payment_pending.v1": "PENDING",
  "commerce.order.payment_paid.v1": "PAID",
  "commerce.order.payment_expired.v1": "EXPIRED",
  "commerce.order.payment_failed.v1": "FAILED",
  "commerce.order.payment_refunded.v1": "REFUNDED",
});

export class SagadevGatewayClient {
  constructor({
    baseUrl,
    productCode = "sagaops",
    contractVersion = "1.0",
    credentialRef,
    transport,
    signRequest,
    verifyWebhook,
    clock = () => new Date(),
    maxPollAttempts = 3,
    environment = "staging",
    productionHostAllowlist = [],
    authorizeOperation = null,
  } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") throw new Error("gateway_https_required");
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(productCode)) throw new Error("gateway_product_code_invalid");
    if (!/^\d+\.\d+$/.test(contractVersion)) throw new Error("gateway_contract_version_invalid");
    if (environment === "production") {
      if (!productionHostAllowlist.includes(url.hostname)) throw new Error("gateway_production_host_not_allowlisted");
      if (typeof authorizeOperation !== "function") throw new Error("gateway_production_authorizer_required");
    } else if (/(^|[.-])(prod|production)([.-]|$)/i.test(url.hostname)) {
      throw new Error("gateway_non_production_https_required");
    }
    if (!/^vault:\/\/[a-z0-9/_-]+$/.test(credentialRef ?? "")) throw new Error("gateway_vault_credential_required");
    if (typeof transport !== "function" || typeof signRequest !== "function" || typeof verifyWebhook !== "function") {
      throw new Error("gateway_transport_signer_and_verifier_required");
    }
    this.baseUrl = url.origin;
    this.productCode = productCode;
    this.contractVersion = contractVersion;
    this.credentialRef = credentialRef;
    this.transport = transport;
    this.signRequest = signRequest;
    this.verifyWebhook = verifyWebhook;
    this.clock = clock;
    this.maxPollAttempts = maxPollAttempts;
    this.environment = environment;
    this.authorizeOperation = authorizeOperation;
    this.payments = new Map();
    this.paymentByIdempotency = new Map();
    this.webhookInbox = new Map();
  }

  get paymentBasePath() {
    return `/internal/v1/products/${this.productCode}/order-payments`;
  }

  async readiness() {
    const response = unwrap(await this.#request("GET", `${this.paymentBasePath}/readiness`));
    return {
      ready: response.ready === true,
      transactionsEnabled: response.transactionsEnabled === true,
      environment: response.environment ?? this.environment,
      productRegistered: response.productRegistered === true,
      providerVisibleToProduct: response.providerVisibleToProduct === true,
      providerBoundaryConfirmed: response.providerVisibleToProduct === false,
      environmentConfirmed: response.environment === this.environment,
      callbackReady: response.callbackReady === true,
      killSwitchReady: response.killSwitchReady === true,
      killSwitchEngaged: response.killSwitchEngaged === true,
      windowOpen: response.windowOpen === true,
      deliveryMode: response.deliveryMode ?? null,
      limits: response.limits && typeof response.limits === "object" ? structuredClone(response.limits) : null,
      gatewayEnvironment: response.gatewayEnvironment ?? null,
      productCode: this.productCode,
      contractVersion: this.contractVersion,
    };
  }

  async createPayment({
    orderId,
    orderNumber,
    amountRupiah,
    idempotencyKey,
    description,
    redirectUrl,
    expiresAt,
    activationContext = null,
    usage = {},
  }) {
    if (!orderId || !idempotencyKey || !Number.isInteger(amountRupiah) || amountRupiah <= 0) {
      throw new Error("gateway_payment_input_invalid");
    }
    const known = this.paymentByIdempotency.get(idempotencyKey);
    if (known) return structuredClone(this.payments.get(known));
    const authorization = this.#authorize("PAYMENT_CREATE", { ...activationContext, amountRupiah }, usage);
    const response = unwrap(await this.#request("POST", this.paymentBasePath, {
      idempotencyKey,
      merchantOrderId: orderNumber ?? orderId,
      amount: amountRupiah,
      currency: "IDR",
      description: description ?? `Saga POS ${orderNumber ?? orderId}`,
      redirectUrl: redirectUrl ?? null,
      expiresAt: expiresAt ?? null,
    }, idempotencyKey));
    const providerReference = response.reference;
    const paymentId = response.paymentIntentId ?? providerReference;
    const checkoutUrl = response.checkoutUrl ?? null;
    const qrPayload = response.qrPayload ?? checkoutUrl;
    const responseStatus = normalizeStatus(response.status ?? "PENDING");
    if (!paymentId || !providerReference || !qrPayload || !["CREATED", "PENDING"].includes(responseStatus)) {
      throw new Error("gateway_create_response_invalid");
    }
    if (response.amount !== undefined && response.amount !== amountRupiah) throw new Error("gateway_amount_mismatch");
    if (response.currency !== undefined && response.currency !== "IDR") throw new Error("gateway_currency_mismatch");
    const payment = {
      id: paymentId,
      provider: "sagadev_gateway",
      providerReference,
      productCode: this.productCode,
      orderId,
      merchantOrderId: orderNumber ?? orderId,
      amountRupiah,
      currency: "IDR",
      status: responseStatus,
      checkoutUrl,
      qrPayload,
      expiresAt: response.expiresAt ?? expiresAt ?? null,
      gatewayMode: response.gatewayMode ?? this.environment,
      idempotencyKey,
      activationPassportId: authorization?.passportId ?? null,
      updatedAt: this.clock().toISOString(),
    };
    this.payments.set(payment.id, payment);
    this.paymentByIdempotency.set(idempotencyKey, payment.id);
    return structuredClone(payment);
  }

  restorePayment(payment = {}) {
    const restored = {
      id: String(payment.id ?? "").trim(),
      provider: "sagadev_gateway",
      providerReference: String(payment.providerReference ?? "").trim(),
      productCode: this.productCode,
      orderId: String(payment.orderId ?? "").trim(),
      merchantOrderId: String(payment.merchantOrderId ?? "").trim(),
      amountRupiah: payment.amountRupiah,
      currency: "IDR",
      status: normalizeStatus(payment.status),
      checkoutUrl: payment.checkoutUrl ?? null,
      qrPayload: payment.qrPayload ?? null,
      expiresAt: payment.expiresAt ?? null,
      gatewayMode: payment.gatewayMode ?? this.environment,
      idempotencyKey: String(payment.idempotencyKey ?? "").trim(),
      activationPassportId: null,
      updatedAt: this.clock().toISOString(),
    };
    if (!restored.id || !restored.providerReference || !restored.orderId || !restored.merchantOrderId
      || !restored.idempotencyKey || !Number.isInteger(restored.amountRupiah) || restored.amountRupiah <= 0) {
      throw new Error("gateway_restored_payment_invalid");
    }
    const knownId = this.paymentByIdempotency.get(restored.idempotencyKey);
    if (knownId && knownId !== restored.id) throw new Error("gateway_restored_idempotency_conflict");
    const known = this.payments.get(restored.id);
    if (known && (known.providerReference !== restored.providerReference || known.amountRupiah !== restored.amountRupiah)) {
      throw new Error("gateway_restored_payment_conflict");
    }
    this.payments.set(restored.id, restored);
    this.paymentByIdempotency.set(restored.idempotencyKey, restored.id);
    return structuredClone(restored);
  }

  ingestWebhook({ headers, rawBody }) {
    if (this.verifyWebhook({ headers, rawBody, productCode: this.productCode, contractVersion: this.contractVersion }) !== true) {
      throw new Error("gateway_webhook_signature_invalid");
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new Error("gateway_webhook_body_invalid");
    }
    const data = event?.data;
    const eventId = event?.eventId ?? event?.id;
    const target = EVENT_STATUS[event?.eventType];
    const paymentId = data?.paymentIntentId ?? this.#findPaymentIdByReference(data?.reference);
    if (!eventId || !target || !paymentId || !data) throw new Error("gateway_webhook_body_invalid");
    const hash = createHash("sha256").update(rawBody).digest("hex");
    const previous = this.webhookInbox.get(eventId);
    if (previous && previous.hash !== hash) throw new Error("gateway_webhook_replay_mismatch");
    if (previous) return { replay: true, payment: structuredClone(this.payments.get(paymentId)) };
    const payment = this.#payment(paymentId);
    if (data.currency !== undefined && data.currency !== "IDR") throw new Error("gateway_currency_mismatch");
    if (data.merchantOrderId !== undefined && data.merchantOrderId !== payment.merchantOrderId) {
      throw new Error("gateway_order_mismatch");
    }
    const converged = this.#converge(paymentId, target, data.amount);
    if (data.feeAmount !== undefined) converged.feeRupiah = normalizeNonNegativeMoney(data.feeAmount);
    if (data.netAmount !== undefined) converged.netSettlementRupiah = normalizeNonNegativeMoney(data.netAmount);
    this.payments.set(paymentId, structuredClone(converged));
    this.webhookInbox.set(eventId, { hash, paymentId, receivedAt: this.clock().toISOString() });
    return { replay: false, payment: structuredClone(converged) };
  }

  async recoverUncertain(paymentId) {
    const known = this.#payment(paymentId);
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt += 1) {
      const response = unwrap(await this.#request("GET", `${this.paymentBasePath}/${encodeURIComponent(known.providerReference)}`));
      if (response.checkoutUrl !== undefined) known.checkoutUrl = response.checkoutUrl;
      if (response.qrPayload !== undefined) known.qrPayload = response.qrPayload;
      if (response.expiresAt !== undefined) known.expiresAt = response.expiresAt;
      const target = normalizeStatus(response.status);
      const payment = this.#converge(paymentId, target, response.amount);
      if (!["CREATED", "PENDING"].includes(payment.status)) return { resolved: true, attempts: attempt, payment };
    }
    return {
      resolved: false,
      attempts: this.maxPollAttempts,
      payment: structuredClone(this.#payment(paymentId)),
      operatorAction: "KEEP_ORDER_UNPAID_AND_RETRY_STATUS",
    };
  }

  refundDisposition({ paymentId, amountRupiah }) {
    const payment = this.#payment(paymentId);
    if (payment.status !== "PAID" || amountRupiah !== payment.amountRupiah) throw new Error("gateway_full_refund_input_invalid");
    return {
      paymentId,
      amountRupiah,
      mode: "MANUAL_FINANCE",
      status: "MANAGER_APPROVAL_AND_RECONCILIATION_REQUIRED",
      mutatesPayment: false,
    };
  }

  async refund() {
    throw new Error("gateway_refund_api_not_contractually_available");
  }

  reconcileSettlement(rows) {
    const mismatches = [];
    for (const row of rows) {
      const paymentId = row.paymentIntentId ?? row.payment_id ?? this.#findPaymentIdByReference(row.reference);
      const payment = this.payments.get(paymentId);
      const actualStatus = normalizeStatus(row.status);
      const actualAmount = row.amount ?? row.amount_rupiah;
      if (!payment) mismatches.push({ paymentId: paymentId ?? row.reference, code: "UNKNOWN_PROVIDER_PAYMENT" });
      else if (payment.status !== actualStatus || payment.amountRupiah !== actualAmount) {
        mismatches.push({
          paymentId,
          code: "STATE_OR_AMOUNT_MISMATCH",
          expected: { status: payment.status, amountRupiah: payment.amountRupiah },
          actual: { status: actualStatus, amountRupiah: actualAmount },
        });
      }
    }
    return { matched: mismatches.length === 0, checked: rows.length, mismatches };
  }

  async #request(method, path, body = null, idempotencyKey = null) {
    const rawBody = body == null ? "" : JSON.stringify(body);
    const headers = await this.signRequest({
      method,
      path,
      rawBody,
      bodyHash: createHash("sha256").update(rawBody).digest("hex"),
      credentialRef: this.credentialRef,
      productCode: this.productCode,
      contractVersion: this.contractVersion,
      idempotencyKey,
    });
    assertSignedHeaders(headers, this.contractVersion);
    return this.transport({ method, path, headers, body, rawBody, idempotencyKey });
  }

  #converge(paymentId, target, amountRupiah) {
    const payment = this.#payment(paymentId);
    if (amountRupiah !== undefined && amountRupiah !== payment.amountRupiah) throw new Error("gateway_amount_mismatch");
    if (!ALLOWED[payment.status]?.has(target)) throw new Error(`gateway_state_regression:${payment.status}:${target}`);
    payment.status = target;
    payment.updatedAt = this.clock().toISOString();
    return structuredClone(payment);
  }

  #authorize(operation, context, usage) {
    if (this.environment !== "production") return null;
    const result = this.authorizeOperation({ operation, ...(context ?? {}) }, usage ?? {});
    if (result?.allowed !== true) throw new Error(`gateway_production_not_authorized:${result?.code ?? "UNKNOWN"}`);
    return result;
  }

  #findPaymentIdByReference(reference) {
    if (!reference) return null;
    return [...this.payments.values()].find((payment) => payment.providerReference === reference)?.id ?? null;
  }

  #payment(id) {
    const payment = this.payments.get(id);
    if (!payment) throw new Error("gateway_payment_not_found");
    return payment;
  }
}

function unwrap(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function normalizeStatus(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!Object.hasOwn(ALLOWED, normalized)) throw new Error("gateway_status_invalid");
  return normalized;
}

function normalizeNonNegativeMoney(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("gateway_money_invalid");
  return value;
}

function assertSignedHeaders(headers, contractVersion) {
  if (!headers || typeof headers !== "object") throw new Error("gateway_signed_headers_invalid");
  const required = ["X-Saga-Key-Id", "X-Saga-Timestamp", "X-Saga-Nonce", "X-Saga-Signature", "X-Correlation-Id"];
  if (required.some((name) => !String(headers[name] ?? "").trim())) throw new Error("gateway_signed_headers_invalid");
  if (!String(headers["X-Saga-Signature"]).startsWith("v1=")) throw new Error("gateway_signature_version_invalid");
  if (headers["X-Saga-Contract-Version"] !== contractVersion) throw new Error("gateway_contract_header_invalid");
}
