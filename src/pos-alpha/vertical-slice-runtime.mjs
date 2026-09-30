import { createHash, randomUUID } from "node:crypto";

import { closeCashSession, openCashSession, recordShiftExpense } from "../services/closing.mjs";
import { getDailyReport, getLiveOwnerDashboard, getPaymentSettlementReport } from "../services/dashboard.mjs";
import { buildOwnerFinancialSummary, ownerFinancialCsv,refundedSaleHasLedger } from "../services/owner-financial-summary.mjs";
import { buildFinanceDailyClosingGate } from "../services/finance-daily-closing-gate.mjs";
import { buildInventoryVarianceReport, inventoryVarianceCsv } from "../services/inventory-variance.mjs";
import { buildTheoreticalIngredientUsage, theoreticalIngredientUsageCsv } from "../services/theoretical-ingredient-usage.mjs";
import { buildOwnerInventoryWorkspace } from "../services/owner-inventory-workspace.mjs";
import { buildPhase3InventorySimulation, buildPhase3OrderKdsReadiness } from "../services/phase3-order-kds-readiness.mjs";
import { HppCatalog } from "./hpp-catalog.mjs";
import { SagadevGatewaySimulator } from "../services/gateway-simulator.mjs";
import { buildCashTenderOptions } from "../services/pos-core.mjs";
import { createRemakeQueueFact, remakeQueueFingerprint } from "../services/remake-queue.mjs";
import { generatePayrollReadyReport } from "../services/staff.mjs";
import { PilotCatalogPricing, PROVISIONAL_PILOT_POLICY, CASHIER_DISCOUNT_AUTHORITY } from "./pilot-policy.mjs";
import { LocalPrintSpooler } from "./print-spooler.mjs";
import { operationalStatus, transitionTicket } from "./fulfillment-state.mjs";
import { buildCashierPromotionReport } from "../services/cashier-promotion-report.mjs";
import { planCashierRefund } from "../services/cashier-refund.mjs";

const TABLE_DEMO_CONTEXT = Symbol("table-demo-context");
const VERIFIED_CASHIER_MEMBER = Symbol("verified-cashier-member");

export function cashierDiscountResource(actor, input, quote) {
  return createHash('sha256').update(JSON.stringify({ actorId:actor.employeeId, operationKey:input.discountOperationKey ?? null, items:quote.items.map(({productId,qty,selections,note,lineTotalRupiah})=>({productId,qty,selections,note,lineTotalRupiah})), orderType:quote.orderType, paymentMethod:String(input.paymentMethod ?? 'CASH').toUpperCase(), manual:quote.benefitSnapshot.manual, totalRupiah:quote.totalRupiah, pricing:quote.pricingPolicySnapshot })).digest('hex');
}

export const SAGA_POS_ALPHA_CONTEXT = Object.freeze({
  scope: "LOCAL_SPRINT_EXECUTION_LAB",
  production: false,
  organizationId: "kopi-saga",
  organizationName: "Kopi Saga",
  outletId: "kopi-saga-salak",
  outletName: "Kopi Saga Salak",
  timezone: "Asia/Jakarta",
  gateway: "SAGADEV_GATEWAY_SIMULATOR",
  memberCode: "LOCAL_FIXTURE_IMPLEMENTED_EXTERNAL_UAT_PENDING",
  reward: "LOCAL_FIXTURE_IMPLEMENTED_EXTERNAL_UAT_PENDING",
  printer: "REQUIRED_FOR_PILOT_NOT_RUN_HARDWARE_UNAVAILABLE",
  nfc: "REQUIRED_FOR_PILOT_NOT_RUN_HARDWARE_UNAVAILABLE",
});

export class PosVerticalSliceRuntime {
  constructor({
    clock = () => new Date(),
    persistenceStatus = "DOMAIN_POSTGRES_EVIDENCE_EXISTS_POS_LAB_IN_MEMORY",
    privatePromotionAuthorizer = null,
    privateCanaryContext = null,
    canaryUsageProvider = () => ({}),
    memberProvider = null,
    kioskGatewayQrisEnabled = true,
    kioskAssistedCashEnabled = false,
    kioskStaticQrisDemoEnabled = false,
    kioskManualQrisEnabled = false,
  } = {}) {
    this.clock = clock;
    this.persistenceStatus = persistenceStatus;
    this.privateCanaryContext = privateCanaryContext ? structuredClone(privateCanaryContext) : null;
    this.canaryUsageProvider = canaryUsageProvider;
    if (memberProvider != null && ["resolve", "summary", "qualify"].some((method) => typeof memberProvider[method] !== "function")) throw new Error("member_provider_invalid");
    this.memberProvider = memberProvider;
    this.kioskGatewayQrisEnabled = kioskGatewayQrisEnabled !== false;
    this.kioskAssistedCashEnabled = kioskAssistedCashEnabled === true;
    this.kioskStaticQrisDemoEnabled = kioskStaticQrisDemoEnabled === true;
    this.kioskManualQrisEnabled = kioskManualQrisEnabled === true;
    this.receivingOutletId = SAGA_POS_ALPHA_CONTEXT.outletId;
    this.gateway = new SagadevGatewaySimulator({ clock });
    this.catalogPricing = new PilotCatalogPricing({ clock, privatePromotionAuthorizer });
    this.hppCatalog = new HppCatalog({ clock, productProvider: () => this.catalogPricing.catalog("ADMIN").flatMap((category) => category.products.map((product) => ({ ...product, categoryId: category.id }))) });
    this.printSpooler = new LocalPrintSpooler({ clock, hardwareAvailable: false });
    this.kioskSessions = new Map();
    this.kioskMemberContexts = new Map();
    this.orders = [];
    this.orderItems = [];
    this.payments = [];
    this.fulfillments = new Map();
    this.checkoutByKey = new Map();
    this.events = [];
    this.sequence = 0;
    this.cashShift = null;
    this.cashMovements = [];
    this.expenses = [];
    this.refunds = [];
    this.remakes = [];
    this.rewardReservations = new Map();
    this.discountApprovals = new Map();
    this.tableOrderSubscribers = new Map();
    this.workforceState = defaultWorkforceState();
    this.devices = [
      { id: "KIOSK-LOCAL-01", label: "Kiosk Salak Fixture", mode: "KIOSK", status: "ONLINE_LOCAL", printer: "NOT_RUN", nfc: "NOT_RUN", version: "0.1.0-local" },
      { id: "KDS-LOCAL-01", label: "Nota Checker Fixture", mode: "KDS", status: "ONLINE_LOCAL", printer: "NOT_RUN", nfc: "NOT_APPLICABLE", version: "0.1.0-local" },
      { id: "CASHIER-LOCAL-01", label: "Cashier Fallback Fixture", mode: "CASHIER", status: "ONLINE_LOCAL", printer: "NOT_RUN", nfc: "NOT_RUN", version: "0.1.0-local" },
    ];
  }

  startKioskSession() {
    const session = {
      id: randomUUID(),
      status: "ACTIVE",
      activeOrderId: null,
      createdAt: this.clock().toISOString(),
    };
    this.kioskSessions.set(session.id, session);
    this.#event("kiosk.session.started", { sessionId: session.id });
    return structuredClone(session);
  }

  kioskState(sessionId) {
    const session = this.#requireKioskSession(sessionId);
    const order = session.activeOrderId
      ? this.orders.find((item) => item.id === session.activeOrderId)
      : null;
    const payment = order ? this.#latestPaymentForOrder(order.id) : null;
    const fulfillment = order ? this.fulfillments.get(order.id) : null;
    const catalog = this.catalogPricing.catalog("KIOSK");

    return {
      context: SAGA_POS_ALPHA_CONTEXT,
      capabilities: {
        serviceAvailable: true,
        memberInput: true,
        memberMode: "code",
        orderTypes: structuredClone(PROVISIONAL_PILOT_POLICY.orderTypes),
        paymentMethods: [...(this.kioskGatewayQrisEnabled ? ["QRIS"] : []), ...(this.kioskManualQrisEnabled ? ["QRIS_STATIC_MANUAL"] : []), ...(this.kioskStaticQrisDemoEnabled ? ["QRIS_STATIC_DEMO"] : []), ...(this.kioskAssistedCashEnabled ? ["CASH_ASSISTED"] : [])],
        manualQris: { enabled: this.kioskManualQrisEnabled, staffConfirmationRequired: true },
        staticQrisDemo: { enabled: this.kioskStaticQrisDemoEnabled, staffConfirmationRequired: true },
        assistedCash: {
          enabled: this.kioskAssistedCashEnabled,
          available: this.kioskAssistedCashEnabled && this.cashShift?.status === "open",
          staffConfirmationRequired: true,
        },
        printerAvailable: false,
        nfcAvailable: false,
        operatorHelp: true,
      },
      session: structuredClone(session),
      catalog,
      catalogEtag: this.catalogPricing.etag("KIOSK"),
      policy: PROVISIONAL_PILOT_POLICY,
      activeOrder: order ? this.#safeOrder(order) : null,
      payment: payment ? this.#safePayment(payment) : null,
      fulfillment: fulfillment ? structuredClone(fulfillment) : null,
      memberContext: this.#safeKioskMemberContext(sessionId, catalog),
    };
  }

  subscribeTableOrder(sessionId, listener) {
    this.#requireKioskSession(sessionId);
    if (typeof listener !== "function") throw domainError("table_order_subscriber_invalid", 422);
    const subscribers = this.tableOrderSubscribers.get(sessionId) ?? new Set();
    if (subscribers.size >= 3) throw domainError("table_order_stream_limit", 429);
    subscribers.add(listener);
    this.tableOrderSubscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) this.tableOrderSubscribers.delete(sessionId);
    };
  }

  publishTableOrderState(sessionId, reason = "updated") {
    const subscribers = this.tableOrderSubscribers.get(sessionId);
    if (!subscribers?.size) return 0;
    const snapshot = this.kioskState(sessionId);
    let delivered = 0;
    for (const listener of subscribers) {
      try { listener(structuredClone(snapshot), String(reason)); delivered += 1; }
      catch { subscribers.delete(listener); }
    }
    if (!subscribers.size) this.tableOrderSubscribers.delete(sessionId);
    return delivered;
  }

  publishTableOrderByOrder(orderId, reason = "fulfillment_updated") {
    const order = this.orders.find((item) => item.id === orderId && item.channel === "TABLE" && item.testMode === true);
    return order ? this.publishTableOrderState(order.kioskSessionId, reason) : 0;
  }

  quote(sessionId, cart, options = {}) {
    this.#requireKioskSession(sessionId);
    const { memberCode: _untrustedMemberCode, verifiedMemberId: _untrustedMemberId, ...safeOptions } = options ?? {};
    const memberContext = this.kioskMemberContexts.get(sessionId);
    const quote = this.catalogPricing.quote({
      cart,
      ...safeOptions,
      manualDiscount: null,
      discountActor: null,
      verifiedMemberId: memberContext?.memberId,
      verifiedMemberSnapshot: memberContext?.verifiedMemberSnapshot ?? null,
      // This context is runtime-injected; the browser cannot self-authorize.
      privateCanaryContext: this.privateCanaryContext,
      canaryUsage: this.canaryUsageProvider(),
      promotionUsage: this.#promotionUsage(),
    });
    return {
      ...quote,
      assistedCash: this.kioskAssistedCashEnabled ? {
        available: this.cashShift?.status === "open",
        staffConfirmationRequired: true,
        tenderOptions: buildCashTenderOptions(quote.totalRupiah),
      } : null,
    };
  }

  resolveKioskMember(sessionId, { memberCode, orderType } = {}) {
    this.#requireKioskSession(sessionId);
    const normalizedOrderType = String(orderType || "").toUpperCase();
    if (normalizedOrderType && !PROVISIONAL_PILOT_POLICY.orderTypes.includes(normalizedOrderType)) {
      throw domainError("order_type_invalid", 422);
    }
    if (this.memberProvider) return this.#resolveProviderMember(sessionId, { memberCode, orderType: normalizedOrderType });
    return this.#resolveFixtureKioskMember(sessionId, { memberCode, orderType: normalizedOrderType });
  }

  simulateKioskDemoMember(sessionId, { memberCode, orderType, method = "PHONE" } = {}) {
    this.#requireKioskSession(sessionId);
    const normalizedMethod = String(method || "PHONE").trim().toUpperCase();
    if (!["PHONE", "NFC"].includes(normalizedMethod)) throw domainError("member_demo_method_invalid", 422);
    const digits = String(memberCode || "").replace(/\D/g, "");
    if (normalizedMethod === "PHONE" && (digits.length < 9 || digits.length > 15)) throw domainError("member_phone_invalid", 422);
    const normalizedOrderType = String(orderType || "").toUpperCase();
    if (normalizedOrderType && !PROVISIONAL_PILOT_POLICY.orderTypes.includes(normalizedOrderType)) throw domainError("order_type_invalid", 422);
    const publicContext = this.#resolveFixtureKioskMember(sessionId, {
      memberCode: PROVISIONAL_PILOT_POLICY.memberFixture.code,
      orderType: normalizedOrderType,
    });
    publicContext.member = {
      ...publicContext.member,
      displayName: "Member Demo",
      codeMasked: normalizedMethod === "PHONE" ? `08••••••${digits.slice(-2)}` : "NFC •••• DEMO",
    };
    publicContext.source = normalizedMethod === "PHONE" ? "LOCAL_FIXTURE_PHONE_SIMULATOR" : "LOCAL_FIXTURE_NFC_SIMULATOR";
    const stored = this.kioskMemberContexts.get(sessionId);
    stored.publicContext = structuredClone(publicContext);
    this.#event("kiosk.member.demo.resolved", { memberId: stored.memberId, method: normalizedMethod });
    return structuredClone(publicContext);
  }

  #resolveFixtureKioskMember(sessionId, { memberCode, orderType } = {}) {
    const member = this.catalogPricing.resolveMember(memberCode);
    const products = new Map(this.catalogPricing.catalog("KIOSK")
      .flatMap((category) => category.products)
      .map((product) => [product.id, product]));
    const recommendations = PROVISIONAL_PILOT_POLICY.memberFixture.recommendations
      .filter((item) => products.has(item.productId) && products.get(item.productId).available !== false)
      .map((item) => ({ productId: item.productId, reason: item.reason }));
    const publicContext = {
      member: { displayName: member.displayName, codeMasked: member.codeMasked, tier: member.tier },
      recommendations,
      orderType: orderType || null,
      source: "LOCAL_FIXTURE_PERSONALIZATION",
      nfcStatus: "NOT_RUN_HARDWARE_UNAVAILABLE",
    };
    this.kioskMemberContexts.set(sessionId, { memberId: member.memberId, publicContext,
      recommendationCandidates: structuredClone(PROVISIONAL_PILOT_POLICY.memberFixture.recommendations) });
    this.#event("kiosk.member.resolved", { memberId: member.memberId, recommendationCount: recommendations.length });
    return structuredClone(publicContext);
  }

  async synchronizeMemberCommerce(orderId) {
    const order = this.orders.find((item) => item.id === orderId);
    if (!order || !order.memberId || !this.memberProvider || order.testMode === true || !["PAID", "COMPLETED"].includes(order.status)) return { status: "NOT_APPLICABLE" };
    if (order.memberSynchronization?.status === "CONFIRMED") return structuredClone(order.memberSynchronization);
    try {
      const result = await this.memberProvider.qualify({ memberId: order.memberId, eligibleSpend: Math.max(0, order.totalRupiah), sourceType: "COFFEE_ORDER", sourceId: order.id }, `sagapos:coffee:${order.id}`);
      order.memberSynchronization = { status: "CONFIRMED", points: Number(result.points ?? 0), xp: Number(result.xp ?? 0), tier: String(result.tier ?? ""), synchronizedAt: this.clock().toISOString() };
      this.#event("member.commerce.qualified", { orderId: order.id, memberId: order.memberId, points: order.memberSynchronization.points });
    } catch {
      order.memberSynchronization = { status: "RECONCILIATION_REQUIRED", code: "member_qualification_unconfirmed", synchronizedAt: this.clock().toISOString() };
      this.#event("member.commerce.reconciliation_required", { orderId: order.id, memberId: order.memberId });
    }
    return structuredClone(order.memberSynchronization);
  }

  async simulateKioskNfc(sessionId, { orderType } = {}) {
    const publicContext = await this.resolveKioskMember(sessionId, {
      memberCode: PROVISIONAL_PILOT_POLICY.memberFixture.code,
      orderType,
    });
    publicContext.source = "LOCAL_FIXTURE_NFC_SIMULATOR";
    this.kioskMemberContexts.get(sessionId).publicContext.source = publicContext.source;
    this.#event("kiosk.nfc.simulated", { memberId: this.kioskMemberContexts.get(sessionId).memberId });
    return structuredClone(publicContext);
  }

  clearKioskMember(sessionId) {
    this.#requireKioskSession(sessionId);
    const cleared = this.kioskMemberContexts.delete(sessionId);
    this.#event("kiosk.member.cleared", { cleared });
    return { member: null, recommendations: [] };
  }

  async #resolveProviderMember(sessionId, { memberCode, orderType }) {
    let member;
    let summary;
    try {
      member = await this.memberProvider.resolve(memberCode);
      summary = await this.memberProvider.summary(member.id);
    } catch { throw domainError("member_service_unavailable", 503); }
    if (!member || !summary || member.id !== summary.member?.id || member.status !== "ACTIVE") throw domainError("member_service_unavailable", 503);
    const tier = String(summary.tier ?? "").toUpperCase();
    const benefit = summary.loyaltyPolicy?.benefits?.[tier] ?? null;
    const verifiedMemberSnapshot = {
      memberId: member.id,
      displayName: String(member.displayName ?? "Member"),
      codeMasked: String(member.memberCodeMasked ?? "MEMBER"),
      tier,
      discountPercent: benefit?.type === "PERCENT_DISCOUNT" ? Number(benefit.discountPercent ?? 0) : 0,
      discountCapRupiah: benefit?.type === "PERCENT_DISCOUNT" ? Number(benefit.discountCapRupiah ?? 0) : 0,
    };
    const publicContext = {
      member: { displayName: verifiedMemberSnapshot.displayName, codeMasked: verifiedMemberSnapshot.codeMasked, tier },
      recommendations: [], orderType: orderType || null, source: "SAGA_MEMBER_PROVIDER", nfcStatus: "NOT_RUN_HARDWARE_UNAVAILABLE",
      pointsBalance: Math.max(0, Number(summary.pointsBalance ?? 0)),
    };
    this.kioskMemberContexts.set(sessionId, { memberId: member.id, verifiedMemberSnapshot, publicContext, recommendationCandidates: [] });
    this.#event("kiosk.member.resolved", { memberId: member.id, recommendationCount: 0, source: "SAGA_MEMBER_PROVIDER" });
    return structuredClone(publicContext);
  }

  beginTableDemoCheckout(sessionId, input = {}, table = {}) {
    const tableId = String(table.id ?? "").trim();
    const tableLabel = String(table.label ?? "").trim();
    const demoSource = String(table.demoSource ?? "TABLE_QR_DEMO").trim().toUpperCase();
    if (!tableId || tableId.length > 80 || !tableLabel || tableLabel.length > 120) throw domainError("table_order_session_scope_denied", 403);
    if (!["TABLE_QR_DEMO", "KIOSK_DEMO"].includes(demoSource)) throw domainError("demo_order_source_invalid", 422);
    const orderType = String(input.orderType || (demoSource === "KIOSK_DEMO" ? "TAKEAWAY" : "DINE_IN")).trim().toUpperCase();
    const paymentMethod = String(input.paymentMethod || "QRIS").trim().toUpperCase();
    return this.beginKioskCheckout(sessionId, {
      ...input,
      orderType: demoSource === "KIOSK_DEMO" ? orderType : "DINE_IN",
      paymentMethod,
      testMode: true,
      [TABLE_DEMO_CONTEXT]: { tableId, tableLabel, demoSource },
    });
  }

  beginKioskCheckout(sessionId, input = {}) {
    const tableDemoContext = input[TABLE_DEMO_CONTEXT] ?? null;
    const { cart, idempotencyKey, rewardId, promotionCode, orderType, expectedQuote, paymentMethod = "QRIS", receivedRupiah, testMode = false } = input;
    if (typeof testMode !== "boolean") throw domainError("checkout_test_mode_invalid", 422);
    const tableDemo = tableDemoContext !== null;
    const session = this.#requireKioskSession(sessionId);
    const key = String(idempotencyKey ?? "").trim();
    if (!key) throw domainError("idempotency_key_required", 422);
    const scopedKey = `${session.id}:${key}`;
    const existingOrderId = this.checkoutByKey.get(scopedKey);
    if (existingOrderId) {
      const order = this.orders.find((item) => item.id === existingOrderId);
      return { ...this.#checkoutResponse(order), idempotentReplay: true };
    }
    if (session.activeOrderId) {
      const active = this.orders.find((item) => item.id === session.activeOrderId);
      if (active && !["COMPLETED", "CANCELLED", "REFUNDED"].includes(active.status)) {
        throw domainError("active_order_exists", 409);
      }
    }

    const normalizedPaymentMethod = String(paymentMethod || "QRIS").toUpperCase();
    if (!["QRIS", "QRIS_STATIC_MANUAL", "QRIS_STATIC_DEMO", "CASH_ASSISTED"].includes(normalizedPaymentMethod)) throw domainError("payment_method_invalid", 422);
    if (normalizedPaymentMethod === "QRIS" && !testMode && !this.kioskGatewayQrisEnabled) throw domainError("kiosk_gateway_qris_disabled", 409);
    const staticQrisDemo = normalizedPaymentMethod === "QRIS_STATIC_DEMO";
    const staticQrisManual = normalizedPaymentMethod === "QRIS_STATIC_MANUAL";
    if (staticQrisDemo && (!this.kioskStaticQrisDemoEnabled || tableDemo)) throw domainError("kiosk_static_qris_demo_disabled", 409);
    if (staticQrisManual && (!this.kioskManualQrisEnabled || tableDemo || testMode)) throw domainError("kiosk_manual_qris_disabled", 409);
    if (!testMode && normalizedPaymentMethod === "CASH_ASSISTED") {
      if (!this.kioskAssistedCashEnabled) throw domainError("kiosk_assisted_cash_disabled", 409);
      if (this.cashShift?.status !== "open") throw domainError("cash_session_open_required", 409);
    }
    const quote = this.quote(sessionId, cart, { rewardId, promotionCode, orderType, paymentMethod });
    if (expectedQuote !== undefined) assertExpectedCheckoutQuote(expectedQuote, quote, this.clock());
    if (staticQrisDemo && quote.totalRupiah === 0) throw domainError("static_qris_demo_payment_not_required", 409);
    if (staticQrisManual && quote.totalRupiah === 0) throw domainError("manual_qris_payment_not_required", 409);
    const declaredReceivedRupiah = normalizedPaymentMethod === "CASH_ASSISTED" ? Number(receivedRupiah) : null;
    if (normalizedPaymentMethod === "CASH_ASSISTED" && (!Number.isSafeInteger(declaredReceivedRupiah) || declaredReceivedRupiah < quote.totalRupiah)) {
      throw domainError("cash_received_under_amount", 422);
    }
    const verifiedMemberId = this.kioskMemberContexts.get(sessionId)?.memberId ?? null;
    const hppItems = quote.items.map((item) => ({ ...item, ...this.hppCatalog.snapshotOrderItem({ ...item, orderType: orderType ?? null }) }));
    const nextSequence = this.sequence + 1;
    const order = {
      id: randomUUID(),
      orderNumber: `${tableDemo ? tableDemoContext.demoSource === "KIOSK_DEMO" ? "KD" : "TB" : testMode || staticQrisDemo ? "TEST" : "KS"}-${String(nextSequence).padStart(3, "0")}`,
      organizationId: SAGA_POS_ALPHA_CONTEXT.organizationId,
      outletId: SAGA_POS_ALPHA_CONTEXT.outletId,
      channel: tableDemo ? "TABLE" : "KIOSK",
      orderType: quote.orderType,
      memberId: verifiedMemberId,
      status: (testMode && !tableDemo && !staticQrisDemo) || quote.totalRupiah === 0 ? "PAID" : "PAYMENT_PENDING",
      testMode: testMode || staticQrisDemo,
      demoPayment: tableDemo || staticQrisDemo,
      demoSource: tableDemoContext?.demoSource ?? null,
      tableId: tableDemoContext?.tableId ?? null,
      tableLabel: tableDemoContext?.tableLabel ?? null,
      subtotalRupiah: quote.subtotalRupiah,
      discountRupiah: quote.discountRupiah,
      taxRupiah: quote.taxRupiah,
      serviceRupiah: quote.serviceRupiah,
      roundingRupiah: quote.roundingRupiah,
      totalRupiah: quote.totalRupiah,
      totalHppRupiah: hppItems.reduce((sum, item) => sum + item.recipeCostSnapshotRupiah * item.qty, 0),
      hppSnapshotStatus: hppItems.every((item) => item.hppSnapshotStatus === "VERIFIED") ? "VERIFIED" : "INCOMPLETE",
      costCoverage: orderCostCoverage(hppItems),
      businessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone),
      createdAt: this.clock().toISOString(),
      paidAt: (testMode && !tableDemo && !staticQrisDemo) || quote.totalRupiah === 0 ? this.clock().toISOString() : null,
      idempotencyKey: key,
      kioskSessionId: session.id,
      cashSessionId: !testMode && normalizedPaymentMethod === "CASH_ASSISTED" ? this.cashShift.id : null,
      policyStatus: quote.policyStatus,
      catalogVersion: quote.catalogVersion,
      rewardId: quote.reward?.id ?? null,
      promotionCode: quote.promotion?.code ?? null,
    };
    const persistedItems = hppItems.map((item) => ({ ...item, id: randomUUID(), orderId: order.id }));
    if (order.status === "PAID" && !testMode) this.#reserveConfirmedOrder(order, "SYSTEM_KIOSK_CHECKOUT", persistedItems, { allowShortage: true });
    this.sequence = nextSequence;
    this.orders.push(order);
    this.orderItems.push(...persistedItems);

    let payment;
    if (tableDemo && quote.totalRupiah > 0) {
      const gatewayPayment = this.gateway.create({
        orderId: order.id,
        amountRupiah: quote.totalRupiah,
        idempotencyKey: `qris-demo:${scopedKey}`,
      });
      const pending = this.gateway.transition(gatewayPayment.id, "PENDING", `pending:${order.id}:1`).payment;
      payment = {
        id: pending.id,
        orderId: order.id,
        idempotencyKey: pending.idempotencyKey,
        methodNameSnapshot: normalizedPaymentMethod === "CASH_ASSISTED" ? "Tunai Demo SagaPOS" : "QRIS Demo SagaPOS",
        methodType: "qris_demo",
        amountRupiah: quote.totalRupiah,
        status: pending.status,
        settlementStatus: "not_applicable",
        qrPayload: pending.qrPayload,
        expiresAt: pending.expiresAt,
        createdAt: pending.createdAt,
        simulator: true,
        demoOnly: true,
        assistedCash: normalizedPaymentMethod === "CASH_ASSISTED",
        ...(normalizedPaymentMethod === "CASH_ASSISTED" ? {
          receivedRupiah: declaredReceivedRupiah,
          changeRupiah: declaredReceivedRupiah - quote.totalRupiah,
        } : {}),
        attempt: 1,
      };
      this.payments.push(payment);
    } else if (staticQrisDemo) {
      payment = {
        id: randomUUID(), orderId: order.id, methodNameSnapshot: "QRIS Statis DEMO",
        methodType: "qris_manual", amountRupiah: quote.totalRupiah, status: "PENDING",
        settlementStatus: "not_applicable", simulator: true, demoOnly: true,
        staticQrisDemo: true, qrImageUrl: "/assets/qris-static-demo.svg",
      };
      this.payments.push(payment);
    } else if (staticQrisManual) {
      payment = {
        id: randomUUID(), orderId: order.id, methodNameSnapshot: "QRIS Statis Merchant",
        methodType: "qris_manual", amountRupiah: quote.totalRupiah, status: "PENDING",
        settlementStatus: "unchecked", simulator: false, demoOnly: false,
        staticQrisManual: true, qrImageUrl: "/api/kiosk/manual-qris/image",
      };
      this.payments.push(payment);
    } else if (testMode) {
      payment = {
        id: randomUUID(),
        orderId: order.id,
        methodNameSnapshot: "Mode Uji Prototype",
        methodType: "none",
        amountRupiah: 0,
        status: "PAID",
        settlementStatus: "not_applicable",
        simulator: false,
      };
      this.payments.push(payment);
      this.#ensureFulfillment(order);
    } else if (quote.totalRupiah === 0) {
      payment = {
        id: randomUUID(),
        orderId: order.id,
        methodNameSnapshot: "No Payment Required",
        methodType: "none",
        amountRupiah: 0,
        status: "PAID",
        settlementStatus: "not_applicable",
      };
      this.payments.push(payment);
      this.#commitReward(order);
      this.#ensureFulfillment(order);
    } else if (normalizedPaymentMethod === "CASH_ASSISTED") {
      payment = {
        id: randomUUID(),
        orderId: order.id,
        methodNameSnapshot: "Tunai dibantu staf",
        methodType: "cash",
        amountRupiah: quote.totalRupiah,
        receivedRupiah: declaredReceivedRupiah,
        changeRupiah: declaredReceivedRupiah - quote.totalRupiah,
        status: "PENDING",
        settlementStatus: "held",
        assistedCash: true,
      };
      this.payments.push(payment);
    } else {
      const gatewayPayment = this.gateway.create({
        orderId: order.id,
        amountRupiah: quote.totalRupiah,
        idempotencyKey: `qris:${scopedKey}`,
      });
      const pending = this.gateway.transition(gatewayPayment.id, "PENDING", `pending:${order.id}`).payment;
      payment = {
        id: pending.id,
        orderId: order.id,
        methodNameSnapshot: "SagaDev Gateway Simulator",
        methodType: "qris_dynamic",
        amountRupiah: quote.totalRupiah,
        status: pending.status,
        settlementStatus: "unchecked",
        qrPayload: pending.qrPayload,
        expiresAt: pending.expiresAt,
      };
      this.payments.push(payment);
    }

    session.activeOrderId = order.id;
    this.checkoutByKey.set(scopedKey, order.id);
    const eventPaymentMethod = tableDemo
      ? (normalizedPaymentMethod === "CASH_ASSISTED" ? "CASH_DEMO" : "QRIS_DEMO")
      : normalizedPaymentMethod;
    this.#event(tableDemo ? "table.checkout.created" : "kiosk.checkout.created", { orderId: order.id, orderNumber: order.orderNumber, totalRupiah: order.totalRupiah, paymentMethod: eventPaymentMethod, testMode, tableId: order.tableId });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  transitionTableDemoPayment(sessionId, { paymentId, target, callbackId } = {}) {
    const session = this.#requireKioskSession(sessionId);
    const payment = this.payments.find((item) => item.id === paymentId);
    const order = payment ? this.orders.find((item) => item.id === payment.orderId) : null;
    if (!payment || !order) throw domainError("payment_not_found", 404);
    if (order.kioskSessionId !== session.id || order.channel !== "TABLE" || order.testMode !== true || payment.methodType !== "qris_demo") throw domainError("payment_scope_denied", 403);
    const normalizedTarget = String(target ?? "").trim().toUpperCase() === "SUCCESS" ? "PAID" : String(target ?? "").trim().toUpperCase();
    if (!["PAID", "FAILED", "EXPIRED"].includes(normalizedTarget)) throw domainError("demo_payment_target_invalid", 422);
    if (payment.status === normalizedTarget || payment.status === "PAID") return { ...this.#checkoutResponse(order), idempotentReplay: true };
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);
    const eventKey = String(callbackId ?? "").trim();
    if (!eventKey || eventKey.length > 160) throw domainError("callback_id_invalid", 422);
    let result;
    try { result = this.gateway.transition(payment.id, normalizedTarget, eventKey); }
    catch (error) {
      if (String(error?.message).startsWith("payment_transition_invalid:")) throw domainError("demo_payment_transition_invalid", 409);
      throw error;
    }
    payment.status = result.payment.status;
    payment.updatedAt = result.payment.updatedAt;
    if (payment.status === "PAID") {
      payment.paidAt = this.clock().toISOString();
      order.status = "PAID";
      order.paidAt = payment.paidAt;
      this.#ensureFulfillment(order);
    } else if (payment.status === "FAILED") order.status = "PAYMENT_FAILED";
    else if (payment.status === "EXPIRED") order.status = "PAYMENT_EXPIRED";
    this.#event("table.payment.demo.transitioned", { orderId: order.id, paymentId: payment.id, status: payment.status, duplicateCallback: result.duplicate, tableId: order.tableId });
    return { ...this.#checkoutResponse(order), idempotentReplay: result.duplicate };
  }

  retryTableDemoPayment(sessionId, { orderId, idempotencyKey } = {}) {
    const session = this.#requireKioskSession(sessionId);
    const order = this.orders.find((item) => item.id === orderId);
    if (!order || order.kioskSessionId !== session.id || order.channel !== "TABLE" || order.testMode !== true) throw domainError("order_scope_denied", 403);
    const key = String(idempotencyKey ?? "").trim();
    if (!key || key.length > 160) throw domainError("idempotency_key_required", 422);
    const replay = this.payments.find((item) => item.orderId === order.id && item.demoRetryKey === key);
    if (replay) return { ...this.#checkoutResponse(order), idempotentReplay: true };
    const previous = this.#latestPaymentForOrder(order.id);
    if (!previous || previous.methodType !== "qris_demo") throw domainError("payment_not_found", 404);
    if (!["FAILED", "EXPIRED"].includes(previous.status)) throw domainError("payment_retry_not_available", 409);
    const created = this.gateway.create({ orderId: order.id, amountRupiah: order.totalRupiah, idempotencyKey: `qris-demo-retry:${order.id}:${key}` });
    const existing = this.payments.find((item) => item.id === created.id);
    if (existing) return { ...this.#checkoutResponse(order), idempotentReplay: true };
    const pending = this.gateway.transition(created.id, "PENDING", `pending:${created.id}`).payment;
    this.payments.push({
      id: pending.id, orderId: order.id, methodNameSnapshot: "QRIS Demo SagaPOS", methodType: "qris_demo",
      idempotencyKey: pending.idempotencyKey,
      amountRupiah: order.totalRupiah, status: "PENDING", settlementStatus: "not_applicable",
      qrPayload: pending.qrPayload, expiresAt: pending.expiresAt, createdAt: pending.createdAt, updatedAt: pending.updatedAt, simulator: true, demoOnly: true,
      attempt: Number(previous.attempt ?? 1) + 1, demoRetryKey: key,
    });
    order.status = "PAYMENT_PENDING";
    this.#event("table.payment.demo.retried", { orderId: order.id, priorPaymentId: previous.id, paymentId: pending.id, tableId: order.tableId });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  tableDemoState(orderId, { organizationId, outletId } = {}) {
    const order = this.orders.find((item) => item.id === orderId);
    if (!order || order.channel !== "TABLE" || order.testMode !== true || order.demoPayment !== true) throw domainError("table_demo_order_not_found", 404);
    const scopedOrder = {
      ...structuredClone(order),
      organizationId: organizationId ?? order.organizationId,
      outletId: outletId ?? order.outletId,
      memberId: null,
    };
    return {
      revision: Number(order.demoRevision ?? 0),
      order: scopedOrder,
      items: structuredClone(this.orderItems.filter((item) => item.orderId === orderId)),
      payments: structuredClone(this.payments.filter((item) => item.orderId === orderId)),
      fulfillment: structuredClone(this.fulfillments.get(orderId) ?? null),
    };
  }

  kioskStaticDemoState(orderId, { organizationId, outletId } = {}) {
    const order = this.orders.find((item) => item.id === orderId);
    const payment = this.payments.find((item) => item.orderId === orderId && item.staticQrisDemo === true);
    if (!order || !payment || order.channel !== "KIOSK" || order.testMode !== true || order.demoPayment !== true) throw domainError("kiosk_static_demo_order_not_found", 404);
    return {
      revision: Number(order.demoRevision ?? 0),
      order: { ...structuredClone(order), organizationId: organizationId ?? order.organizationId, outletId: outletId ?? order.outletId, memberId: null },
      items: structuredClone(this.orderItems.filter((item) => item.orderId === orderId)),
      payments: [structuredClone(payment)],
      fulfillment: structuredClone(this.fulfillments.get(orderId) ?? null),
    };
  }

  restoreKioskStaticDemoState(record = {}) {
    const state = structuredClone(record.state ?? record);
    const order = state.order;
    if (!order || order.channel !== "KIOSK" || order.testMode !== true || order.demoPayment !== true || !Array.isArray(state.items) || state.payments?.length !== 1 || state.payments[0].staticQrisDemo !== true) throw domainError("kiosk_static_demo_restore_invalid", 500);
    order.demoRevision = Number(record.revision ?? state.revision ?? 0);
    this.orders = this.orders.filter((item) => item.id !== order.id);
    this.orderItems = this.orderItems.filter((item) => item.orderId !== order.id);
    this.payments = this.payments.filter((item) => item.orderId !== order.id);
    this.fulfillments.delete(order.id);
    for (const [key, value] of this.checkoutByKey) if (value === order.id) this.checkoutByKey.delete(key);
    this.orders.push(order);
    this.orderItems.push(...state.items);
    this.payments.push(...state.payments);
    if (state.fulfillment) this.fulfillments.set(order.id, state.fulfillment);
    this.checkoutByKey.set(`${order.kioskSessionId}:${order.idempotencyKey}`, order.id);
    const session = this.kioskSessions.get(order.kioskSessionId);
    if (session) session.activeOrderId = order.id;
    this.sequence = Math.max(this.sequence, Number(String(order.orderNumber).split("-").at(-1)) || 0);
    return this.kioskStaticDemoState(order.id);
  }

  restoreTableDemoState(record = {}) {
    const state = structuredClone(record.state ?? record);
    const order = state.order;
    if (!order || order.channel !== "TABLE" || order.testMode !== true || order.demoPayment !== true) throw domainError("table_demo_restore_invalid", 500);
    if (!Array.isArray(state.items) || !Array.isArray(state.payments) || state.payments.some((payment) => payment.orderId !== order.id || payment.methodType !== "qris_demo" || payment.demoOnly !== true)) throw domainError("table_demo_restore_invalid", 500);
    order.demoRevision = Number(record.revision ?? state.revision ?? order.demoRevision ?? 0);
    this.orders = this.orders.filter((item) => item.id !== order.id);
    this.orderItems = this.orderItems.filter((item) => item.orderId !== order.id);
    this.payments = this.payments.filter((item) => item.orderId !== order.id);
    this.fulfillments.delete(order.id);
    for (const [key, value] of this.checkoutByKey) if (value === order.id) this.checkoutByKey.delete(key);
    this.orders.push(order);
    this.orderItems.push(...state.items);
    this.payments.push(...state.payments);
    if (state.fulfillment) this.fulfillments.set(order.id, state.fulfillment);
    this.checkoutByKey.set(`${order.kioskSessionId}:${order.idempotencyKey}`, order.id);
    const session = this.kioskSessions.get(order.kioskSessionId);
    if (session) session.activeOrderId = order.id;
    for (const payment of state.payments) {
      this.gateway.restore({
        id: payment.id,
        orderId: payment.orderId,
        amountRupiah: payment.amountRupiah,
        idempotencyKey: payment.idempotencyKey,
        status: payment.status,
        qrPayload: payment.qrPayload,
        expiresAt: payment.expiresAt,
        createdAt: payment.createdAt,
        ...(payment.updatedAt ? { updatedAt: payment.updatedAt } : {}),
      }, { replace: true });
    }
    this.sequence = Math.max(this.sequence, Number(String(order.orderNumber).split("-").at(-1)) || 0);
    return this.tableDemoState(order.id);
  }

  refreshKioskPayment(sessionId, { paymentId } = {}) {
    const session = this.#requireKioskSession(sessionId);
    const payment = this.payments.find((item) => item.id === paymentId);
    const order = payment ? this.orders.find((item) => item.id === payment.orderId) : null;
    if (!payment || !order || order.kioskSessionId !== session.id) throw domainError("payment_scope_denied", 403);
    if (!(payment.methodType === "cash" && payment.assistedCash === true) && payment.staticQrisDemo !== true && payment.staticQrisManual !== true) throw domainError("gateway_status_not_available", 409);
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  confirmKioskStaticQrisDemo(actor, { paymentId } = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    const payment = this.payments.find((item) => item.id === paymentId && item.staticQrisDemo === true);
    if (!payment) throw domainError("static_qris_demo_payment_not_found", 404);
    const order = this.orders.find((item) => item.id === payment.orderId && item.channel === "KIOSK" && item.testMode === true);
    if (!order) throw domainError("payment_scope_denied", 403);
    if (payment.status === "PAID") return { ...this.#checkoutResponse(order), idempotentReplay: true };
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);
    const paidAt = this.clock().toISOString();
    payment.status = "PAID";
    payment.paidAt = paidAt;
    order.status = "PAID";
    order.paidAt = paidAt;
    order.cashierUserId = actor.employeeId;
    this.#ensureFulfillment(order);
    this.#event("payment.qris_static_demo.staff_confirmed", { actorId: actor.employeeId, orderId: order.id, paymentId: payment.id, synthetic: true });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  confirmKioskManualQris(actor, { paymentId, merchantReference, observedAmountRupiah } = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    const payment = this.payments.find((item) => item.id === paymentId && item.staticQrisManual === true);
    const order = payment ? this.orders.find((item) => item.id === payment.orderId && ['KIOSK', 'CASHIER'].includes(item.channel)) : null;
    if (!payment || !order || order.testMode === true || order.demoPayment === true) throw domainError("payment_scope_denied", 403);
    if (!Number.isSafeInteger(observedAmountRupiah) || observedAmountRupiah !== payment.amountRupiah) throw domainError("merchant_qris_amount_mismatch", 422);
    if (!/^[A-Z0-9][A-Z0-9._/-]{5,79}$/.test(String(merchantReference ?? "").trim().toUpperCase())) throw domainError("merchant_qris_reference_invalid", 422);
    const reference = String(merchantReference).trim().toUpperCase();
    if (this.payments.some(p => p.id !== payment.id && p.staticQrisManual && p.referenceNumber === reference)) throw domainError('merchant_qris_reference_reused',409);
    if (payment.status === 'PAID') {
      if (payment.referenceNumber !== reference) throw domainError('merchant_qris_reference_reused',409);
      return { ...this.#checkoutResponse(order), idempotentReplay: true };
    }
    if (payment.status !== 'PENDING') throw domainError('payment_not_pending',409);
    const paidAt = this.clock().toISOString();
    payment.status = "PAID";
    payment.paidAt = paidAt;
    payment.referenceNumber = reference;
    order.status = "PAID";
    order.paidAt = paidAt;
    if (order.channel !== 'CASHIER') order.cashierUserId = actor.employeeId;
    this.#reserveConfirmedOrder(order, actor.employeeId, undefined, { allowShortage: true });
    this.#commitReward(order);
    this.#ensureFulfillment(order);
    this.#event("payment.qris_manual.staff_confirmed", { actorId: actor.employeeId, orderId: order.id, paymentId: payment.id });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  confirmKioskAssistedCash(actor, { paymentId, receivedRupiah } = {}) {
    this.#requireCashShift(actor);
    const payment = this.payments.find((item) => item.id === paymentId && item.methodType === "cash" && item.assistedCash === true);
    if (!payment) throw domainError("assisted_cash_payment_not_found", 404);
    const order = this.orders.find((item) => item.id === payment.orderId && item.channel === "KIOSK");
    if (!order || order.cashSessionId !== this.cashShift.id) throw domainError("payment_scope_denied", 403);
    if (payment.status === "PAID") {
      const replayTenderRupiah = Number(receivedRupiah);
      if (!Number.isSafeInteger(replayTenderRupiah) || replayTenderRupiah !== payment.receivedRupiah
        || payment.changeRupiah !== replayTenderRupiah - payment.amountRupiah) {
        throw domainError("assisted_cash_confirmation_conflict", 409);
      }
      return { ...this.#checkoutResponse(order), idempotentReplay: true };
    }
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);
    const actualReceivedRupiah = Number(receivedRupiah);
    if (!Number.isSafeInteger(actualReceivedRupiah) || actualReceivedRupiah < payment.amountRupiah) throw domainError("cash_received_under_amount", 422);
    const paidAt = this.clock().toISOString();
    payment.receivedRupiah = actualReceivedRupiah;
    payment.changeRupiah = actualReceivedRupiah - payment.amountRupiah;
    payment.status = "PAID";
    payment.settlementStatus = "settled";
    payment.paidAt = paidAt;
    order.status = "PAID";
    order.paidAt = paidAt;
    order.cashierUserId = actor.employeeId;
    this.#reserveConfirmedOrder(order, actor.employeeId, undefined, { allowShortage: true });
    this.cashMovements.push({ id: randomUUID(), type: "SALE", orderId: order.id, amountRupiah: order.totalRupiah, occurredAt: paidAt, actorId: actor.employeeId });
    this.#commitReward(order);
    this.#ensureFulfillment(order);
    this.#event("payment.cash_assisted.paid", { actorId: actor.employeeId, orderId: order.id, paymentId: payment.id, changeRupiah: payment.changeRupiah });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  simulateQrisPaid(sessionId, { paymentId, callbackId } = {}) {
    const session = this.#requireKioskSession(sessionId);
    const payment = this.payments.find((item) => item.id === paymentId);
    if (!payment) throw domainError("payment_not_found", 404);
    if (payment.staticQrisDemo === true || payment.staticQrisManual === true) throw domainError("static_qris_staff_confirmation_required", 403);
    const order = this.orders.find((item) => item.id === payment.orderId);
    if (!order || order.kioskSessionId !== session.id) throw domainError("payment_scope_denied", 403);

    if (payment.status === "PAID") {
      return { ...this.#checkoutResponse(order), idempotentReplay: true };
    }
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);

    const result = this.gateway.transition(payment.id, "PAID", callbackId || `paid:${payment.id}`);
    payment.status = result.payment.status;
    payment.paidAt = this.clock().toISOString();
    order.status = "PAID";
    order.paidAt = payment.paidAt;
    this.#reserveConfirmedOrder(order, "SYSTEM_PAYMENT_CONFIRMED", undefined, { allowShortage: true });
    this.#commitReward(order);
    this.#ensureFulfillment(order);
    this.#event("payment.qris.paid", { orderId: order.id, paymentId: payment.id, duplicateCallback: result.duplicate });
    return { ...this.#checkoutResponse(order), idempotentReplay: result.duplicate };
  }

  confirmVerifiedQrisPaid({ paymentId, paidAt = this.clock().toISOString(), providerEventKey } = {}) {
    const payment = this.payments.find((item) => item.id === paymentId && item.methodType === "qris_dynamic");
    if (!payment) throw domainError("payment_not_found", 404);
    const order = this.orders.find((item) => item.id === payment.orderId);
    if (!order) throw domainError("payment_scope_denied", 403);
    if (payment.status === "PAID") return { ...this.#checkoutResponse(order), idempotentReplay: true };
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);
    payment.status = "PAID";
    payment.paidAt = paidAt;
    payment.settlementStatus = "unchecked";
    order.status = "PAID";
    order.paidAt = paidAt;
    this.#reserveConfirmedOrder(order, "SYSTEM_PAYMENT_CONFIRMED", undefined, { allowShortage: true });
    this.#commitReward(order);
    this.#ensureFulfillment(order);
    this.#event("payment.qris.paid", {
      orderId: order.id,
      paymentId: payment.id,
      verificationSource: "sagadev_gateway_status",
      providerEventKey: providerEventKey ?? null,
    });
    return { ...this.#checkoutResponse(order), idempotentReplay: false };
  }

  cashierState(actor) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    return {
      context: SAGA_POS_ALPHA_CONTEXT,
      role: actor.role.toUpperCase(),
      actor: structuredClone(actor),
      catalog: this.catalogPricing.catalog("CASHIER"),
      policy: PROVISIONAL_PILOT_POLICY,
      shift: this.cashShift ? structuredClone(this.cashShift) : null,
      cashControl: this.dashboard(this.cashShift?.businessDate?.slice(0,10)).cashControl,
      expenses: structuredClone(this.expenses.filter(item => item.cashSessionId === this.cashShift?.id)),
      manualQrisAvailable: this.kioskManualQrisEnabled,
      manualDiscountAllowed: actor.role === "owner",
      manualDiscountStaffLimitRupiah: this.catalogPricing.manualDiscountStaffLimitRupiah,
      rewardRedemptionMode:this.productionMemberGuard ? 'NOT_CONNECTED' : 'FIXTURE_ONLY',
      tenderOptions: buildCashTenderOptions(20_000),
      pendingCashAssists: this.payments
        .filter((payment) => payment.methodType === "cash" && payment.assistedCash === true && payment.status === "PENDING")
        .map((payment) => {
          const order = this.orders.find((item) => item.id === payment.orderId);
          return {
            order: this.#safeOrder(order),
            payment: this.#safePayment(payment),
            tenderOptions: buildCashTenderOptions(payment.amountRupiah),
          };
        })
        .filter((item) => item.order),
      pendingStaticQrisDemos: this.payments
        .filter((payment) => payment.staticQrisDemo === true && payment.status === "PENDING")
        .map((payment) => ({ order: this.#safeOrder(this.orders.find((item) => item.id === payment.orderId)), payment: this.#safePayment(payment) })),
      pendingManualQris: this.payments
        .filter((payment) => payment.staticQrisManual === true && payment.status === "PENDING")
        .map((payment) => ({ order: this.#safeOrder(this.orders.find((item) => item.id === payment.orderId)), payment: this.#safePayment(payment) })),
      recentOrders: this.orders.filter((order) => order.channel === "CASHIER" && (actor.role === 'owner' || order.cashierUserId === actor.employeeId)).slice(-20).reverse().map((order) => ({ ...this.#safeOrder(order), payment: this.#safePayment(this.#latestPaymentForOrder(order.id) ?? {}) })),
      integrations: this.#integrationStatus(),
    };
  }

  cashierRecovery(actor, key) {
    if (!actor || !['cashier', 'owner'].includes(actor.role)) throw domainError('cashier_role_denied', 403);
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(String(key ?? ''))) throw domainError('idempotency_key_required', 422);
    const orderId = this.checkoutByKey.get(`cashier:${actor.employeeId}:${key}`);
    const order = this.orders.find(item => item.id === orderId && item.channel === 'CASHIER' && item.cashierUserId === actor.employeeId);
    return order ? { found: true, ...this.#checkoutResponse(order) } : { found: false };
  }

  cashierQuote(actor, input = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    if(this.productionMemberGuard && input.rewardId)throw domainError('production_reward_not_available',409);
    if(this.productionMemberGuard && input.memberCode && !input[VERIFIED_CASHIER_MEMBER])throw domainError('production_member_service_required',503);
    const paymentMethod = String(input.paymentMethod ?? "CASH").toUpperCase();
    if (!["CASH", "QRIS", "QRIS_STATIC_MANUAL"].includes(paymentMethod)) throw domainError("payment_method_invalid", 422);
    if (paymentMethod === 'QRIS_STATIC_MANUAL' && !this.kioskManualQrisEnabled) throw domainError('manual_qris_unavailable', 409);
    const quote = this.catalogPricing.quote({
      cart: input.cart,
      memberCode: input[VERIFIED_CASHIER_MEMBER] ? undefined : input.memberCode,
      verifiedMemberId: input[VERIFIED_CASHIER_MEMBER]?.memberId,
      verifiedMemberSnapshot: input[VERIFIED_CASHIER_MEMBER] ?? null,
      rewardId: input.rewardId,
      promotionCode: input.promotionCode,
      automaticPromotions: input.automaticPromotions !== false,
      manualDiscount: input.manualDiscount ?? null,
      discountActor: actor,
      [CASHIER_DISCOUNT_AUTHORITY]: true,
      orderType: input.orderType,
      paymentMethod,
      privateCanaryContext: this.privateCanaryContext,
      canaryUsage: this.canaryUsageProvider(),
      promotionUsage: this.#promotionUsage(),
    });
    if (input.manualDiscount && actor.role !== 'owner' && input[CASHIER_DISCOUNT_AUTHORITY] !== true) {
      const limit = this.catalogPricing.manualDiscountStaffLimitRupiah;
      const manual = quote.benefitSnapshot.manual;
      if (quote.discountRupiah > limit) {
        const approval = this.discountApprovals.get(input.discountAuthorizationId);
        const resourceId = cashierDiscountResource(actor, input, quote);
        if (!approval || approval.status !== 'AVAILABLE' || approval.actorId !== actor.employeeId || approval.resourceId !== resourceId || approval.operationKey !== input.discountOperationKey || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= this.clock().getTime()) throw domainError('manual_discount_approval_required', 409);
        Object.assign(manual, { authorizationId: input.discountAuthorizationId, operationKey: approval.operationKey, resourceId, approvedBy: approval.approvedBy });
      }
      manual.staffLimitRupiah = limit;
    }
    return {
      ...quote,
      tenderOptions: buildCashTenderOptions(quote.totalRupiah),
      quoteAuthority: "SAGAOPS_LOCAL_SERVER",
    };
  }

  discountApprovalState(actor) {
    if (!actor?.employeeId || !['owner', 'cashier'].includes(actor.role)) throw domainError('cashier_role_denied', 403);
    return { staffLimitRupiah: this.catalogPricing.manualDiscountStaffLimitRupiah, requests: [...this.discountApprovals.entries()].filter(([key,item]) => key === item.requestId && (actor.role === 'owner' || item.actorId === actor.employeeId)).map(([,item]) => structuredClone(item)) };
  }

  discountApprovalCommand(actor, input) {
    if (!actor?.employeeId || actor.role !== 'cashier') throw domainError('cashier_role_denied', 403);
    if (!/^discount:[A-Za-z0-9_-]{1,80}$/.test(input.discountOperationKey ?? '')) throw domainError('discount_operation_key_required', 422);
    if (!input.manualDiscount) throw domainError('manual_discount_invalid', 422);
    const quote = this.cashierQuote(actor, { ...input, [CASHIER_DISCOUNT_AUTHORITY]: true });
    const resourceId = cashierDiscountResource(actor, input, quote);
    return { resourceId, operationKey: input.discountOperationKey, actorId: actor.employeeId, amountRupiah: quote.discountRupiah, totalRupiah: quote.totalRupiah, manualDiscount: quote.benefitSnapshot.manual, items: quote.items.map(({productId, productNameSnapshot, qty}) => ({productId, productNameSnapshot, qty})) };
  }

  requestDiscountApproval(actor, input = {}) {
    const command = this.discountApprovalCommand(actor, input);
    const existing = [...this.discountApprovals.values()].find(item => item.operationKey === command.operationKey);
    if (existing) {
      if (existing.resourceId !== command.resourceId || existing.actorId !== actor.employeeId) throw domainError('discount_request_changed', 409);
      return structuredClone(existing);
    }
    const request = { ...command, requestId: randomUUID(), status: 'PENDING', createdAt: this.clock().toISOString() };
    this.discountApprovals.set(request.requestId, request);
    return structuredClone(request);
  }

  approveDiscount(actor, {requestId} = {}) {
    if (actor?.role !== 'owner' || !actor.employeeId) throw domainError('owner_required', 403);
    const request = this.discountApprovals.get(requestId);
    if (!request) throw domainError('approval_request_not_found', 404);
    if (request.actorId === actor.employeeId) throw domainError('maker_checker_distinct_principals_required', 403);
    if (request.status !== 'PENDING') return structuredClone(request);
    const authorizationId = randomUUID();
    Object.assign(request, {authorizationId, status: 'AVAILABLE', approvedBy: actor.employeeId, expiresAt: new Date(this.clock().getTime() + 15 * 60_000).toISOString()});
    this.discountApprovals.set(authorizationId, request);
    return structuredClone(request);
  }

  openCashShift(actor, { openingCashRupiah = 300_000, shiftName = "Shift Lokal", note = '' } = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    if (this.cashShift?.status === "open") {
      if (this.cashShift.openedByUserId !== actor.employeeId && actor.role !== "owner") throw domainError("shift_owned_by_other_staff", 409);
      return { shift: structuredClone(this.cashShift), idempotentReplay: true };
    }
    const previousCashSession = this.cashShift?.status === 'closed' ? this.cashShift : null;
    if (!Number.isSafeInteger(openingCashRupiah) || openingCashRupiah < 0) throw domainError('opening_cash_invalid', 422);
    if (previousCashSession && openingCashRupiah !== previousCashSession.cashToLeaveRupiah && !String(note).trim()) throw domainError('opening_variance_note_required', 422);
    this.cashShift = openCashSession({
      id: randomUUID(), organizationId: SAGA_POS_ALPHA_CONTEXT.organizationId,
      outletId: SAGA_POS_ALPHA_CONTEXT.outletId,
      businessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone),
      shiftName: String(shiftName).trim().slice(0, 60) || "Shift Lokal",
      openedByUserId: actor.employeeId,
      openingCashRupiah: Number(openingCashRupiah), activeSessions: [],
      previousCashSession,
    });
    this.cashShift.handoverStatus = previousCashSession ? 'confirmed' : 'not_required';
    this.cashShift.openingNote = String(note).trim().slice(0, 240);
    this.#event("cash.shift.opened", { actorId: actor.employeeId, shiftId: this.cashShift.id, openingCashRupiah: this.cashShift.openingCashRupiah });
    return { shift: structuredClone(this.cashShift), idempotentReplay: false };
  }

  closeCashShift(actor, { actualCashRupiah, cashToLeaveRupiah = 300_000, note } = {}) {
    this.#requireCashShift(actor);
    const pendingCashAssists = this.payments.filter((payment) => payment.methodType === "cash" && payment.assistedCash === true && payment.status === "PENDING");
    if (pendingCashAssists.length) return { status: "open", blocked: true, blockReason: "pending_cash_assists_required", pendingCashAssists: pendingCashAssists.length };
    const pendingManualQris = this.payments.filter(p => p.staticQrisManual && p.status === 'PENDING' && this.orders.some(o => o.id === p.orderId && (!o.cashSessionId || o.cashSessionId === this.cashShift.id)));
    if (pendingManualQris.length) return {status:'open',blocked:true,blockReason:'pending_manual_qris_required',pendingManualQris:pendingManualQris.length};
    if (!Number.isSafeInteger(actualCashRupiah) || actualCashRupiah < 0) throw domainError("cash_count_required", 422);
    if (!Number.isSafeInteger(cashToLeaveRupiah) || cashToLeaveRupiah < 0 || cashToLeaveRupiah > actualCashRupiah) throw domainError("cash_to_leave_invalid", 422);
    const orderIds = new Set(this.orders.filter((order) => order.cashSessionId === this.cashShift.id).map((order) => order.id));
    const cashPayments = this.payments.filter((payment) => orderIds.has(payment.orderId) && payment.methodType === "cash" && ['PAID', 'REFUNDED'].includes(payment.status));
    const cashRefunds = this.cashMovements.filter(m => m.type === 'REFUND' && (m.cashSessionId ?? this.orders.find(o => o.id === m.orderId)?.cashSessionId) === this.cashShift.id).map(m => ({ amountRupiah: Math.abs(m.amountRupiah) }));
    const result = closeCashSession({
      cashSession: this.cashShift, cashPayments, cashToLeaveRupiah: Number(cashToLeaveRupiah),
      cashRefunds, expenses: this.expenses.filter(e => e.cashSessionId === this.cashShift.id && e.status === 'recorded'),
      actualCashRupiah, note: String(note ?? "").trim() || undefined,
      closedByUserId: actor.employeeId,
    });
    if (result.approvalRequired && actor.role !== "owner") return { ...result, status: "closing", blocked: true, blockReason: "cash_variance_owner_required" };
    if (!result.blocked) this.cashShift = { ...this.cashShift, ...result };
    this.#event(result.blocked ? "cash.shift.close_blocked" : "cash.shift.closed", { actorId: actor.employeeId, varianceRupiah: result.varianceRupiah });
    return structuredClone(result);
  }

  recordCashierExpense(actor, input = {}) {
    this.#requireCashShift(actor);
    if (input.cashSessionId && input.cashSessionId !== this.cashShift.id) throw domainError('expense_shift_changed',409);
    const key = String(input.idempotencyKey ?? '');
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(key)) throw domainError('idempotency_key_required', 422);
    if (!Number.isSafeInteger(input.amountRupiah) || input.amountRupiah <= 0 || input.amountRupiah > 1_000_000_000) throw domainError('expense_amount_required', 422);
    if (!['cash_drawer', 'owner_transfer', 'external_petty_cash', 'other'].includes(input.source)) throw domainError('expense_source_invalid', 422);
    const category = String(input.category ?? '').trim(), reason = String(input.reason ?? '').trim();
    if (!category || category.length > 80 || !reason || reason.length > 240) throw domainError('expense_detail_required', 422);
    const evidenceReference = String(input.evidenceReference ?? '').trim();
    if (!evidenceReference || evidenceReference.length > 200) throw domainError('expense_evidence_required', 422);
    const id = createHash('sha256').update(`expense:${this.cashShift.id}:${actor.employeeId}:${key}`).digest('hex').slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    const command = { amountRupiah: input.amountRupiah, category, reason, source: input.source, evidenceReference };
    const existing = this.expenses.find(e => e.id === id);
    if (existing) {
      if (Object.entries(command).some(([k,v]) => existing[k] !== v)) throw domainError('expense_retry_conflict', 409);
      return { expense: structuredClone(existing), idempotentReplay: true };
    }
    if (input.source === 'cash_drawer' && input.amountRupiah > this.cashierState(actor).cashControl.expectedCashRupiah) throw domainError('cash_drawer_insufficient',409);
    const expense = { ...recordShiftExpense({ cashSession: this.cashShift, expense: { ...command, id, createdByUserId: actor.employeeId, createdAt: this.clock().toISOString() } }), evidenceReference };
    this.expenses.push(expense);
    this.#event('cash.expense.recorded', { ...expense, actorId: actor.employeeId });
    return { expense: structuredClone(expense), idempotentReplay: false };
  }

  voidCashierExpense(actor, { expenseId, reason } = {}) {
    if (actor?.role !== 'owner' && !actor?.permissions?.includes('finance.approve')) throw domainError('expense_approval_required',403);
    this.#requireCashShift(actor);
    if (!String(reason ?? '').trim() || String(reason).length > 240) throw domainError('expense_correction_reason_required',422);
    const expense = this.expenses.find(e => e.id === expenseId && e.cashSessionId === this.cashShift.id);
    if (!expense) throw domainError('expense_not_found',404);
    if (expense.status === 'voided') {
      if (expense.voidReason !== String(reason).trim()) throw domainError('expense_retry_conflict',409);
      return { expense: structuredClone(expense), idempotentReplay: true };
    }
    expense.status = 'voided'; expense.voidReason = String(reason).trim(); expense.voidedAt = this.clock().toISOString();
    this.#event('cash.expense.voided', { expenseId, reason:expense.voidReason, actorId:actor.employeeId });
    return { expense: structuredClone(expense), idempotentReplay:false };
  }

  cashierCheckout(actor, input = {}) {
    this.#requireCashShift(actor);
    const idempotencyKey = String(input.idempotencyKey ?? "").trim();
    if (!idempotencyKey) throw domainError("idempotency_key_required", 422);
    const scopedKey = `cashier:${actor.employeeId}:${idempotencyKey}`;
    const checkoutFingerprint = createHash('sha256').update(JSON.stringify({cart:input.cart,orderType:input.orderType ?? 'TAKEAWAY',paymentMethod:String(input.paymentMethod ?? 'CASH').toUpperCase(),receivedRupiah:input.receivedRupiah ?? null,memberCode:input.memberCode ?? null,rewardId:input.rewardId ?? null,promotionCode:input.promotionCode ?? null,...(Object.hasOwn(input,'automaticPromotions') || Object.hasOwn(input,'manualDiscount')?{automaticPromotions:input.automaticPromotions!==false,manualDiscount:input.manualDiscount??null}:{}),expectedTotalRupiah:input.expectedTotalRupiah ?? null})).digest('hex');
    const existingOrderId = this.checkoutByKey.get(scopedKey);
    if (existingOrderId) {
      const existing = this.orders.find((order) => order.id === existingOrderId);
      const payment = this.payments.find((item) => item.orderId === existingOrderId);
      if (payment?.methodType === "cash") {
        const receivedRupiah = Number(input.receivedRupiah ?? existing.totalRupiah);
        if (String(input.paymentMethod ?? "CASH").toUpperCase() !== "CASH"
          || !Number.isSafeInteger(receivedRupiah) || receivedRupiah !== payment.receivedRupiah
          || payment.changeRupiah !== receivedRupiah - payment.amountRupiah) {
          throw domainError("cashier_cash_confirmation_conflict", 409);
        }
      }
      if (existing.checkoutFingerprint && existing.checkoutFingerprint !== checkoutFingerprint) throw domainError('cashier_checkout_retry_conflict',409);
      return { ...this.#checkoutResponse(existing), idempotentReplay: true };
    }
    const paymentMethod = String(input.paymentMethod ?? "CASH").toUpperCase();
    if (!["CASH", "QRIS", "QRIS_STATIC_MANUAL"].includes(paymentMethod)) throw domainError("payment_method_invalid", 422);
    const quote = this.cashierQuote(actor, input);
    if (input.expectedTotalRupiah != null && (!Number.isSafeInteger(input.expectedTotalRupiah) || input.expectedTotalRupiah !== quote.totalRupiah)) throw domainError('cashier_quote_changed', 409);
    if(input.expectedBenefitFingerprint!=null && input.expectedBenefitFingerprint!==quote.benefitFingerprint)throw domainError('cashier_quote_changed',409);
    const hppItems = quote.items.map((item) => ({ ...item, ...this.hppCatalog.snapshotOrderItem({ ...item, orderType: input.orderType ?? null }) }));
    const verifiedMemberId = input[VERIFIED_CASHIER_MEMBER]?.memberId ?? (input.memberCode ? this.catalogPricing.resolveMember(input.memberCode).memberId : null);
    const cashReceivedRupiah = paymentMethod === "CASH" ? Number(input.receivedRupiah ?? quote.totalRupiah) : null;
    if (paymentMethod === "CASH" && (!Number.isInteger(cashReceivedRupiah) || cashReceivedRupiah < quote.totalRupiah)) {
      throw domainError("cash_received_under_amount", 422);
    }
    const nextSequence = this.sequence + 1;
    const paid = paymentMethod === "CASH" || quote.totalRupiah === 0;
    const order = {
      id: randomUUID(), orderNumber: `KS-${String(nextSequence).padStart(3, "0")}`,
      organizationId: SAGA_POS_ALPHA_CONTEXT.organizationId, outletId: SAGA_POS_ALPHA_CONTEXT.outletId,
      channel: "CASHIER", orderType: quote.orderType, cashierUserId: actor.employeeId,
      cashSessionId: this.cashShift.id,
      memberId: verifiedMemberId, status: paid ? "PAID" : "PAYMENT_PENDING",
      subtotalRupiah: quote.subtotalRupiah, discountRupiah: quote.discountRupiah,
      taxRupiah: quote.taxRupiah, serviceRupiah: quote.serviceRupiah,
      roundingRupiah: quote.roundingRupiah, totalRupiah: quote.totalRupiah,
      totalHppRupiah: hppItems.reduce((sum, item) => sum + item.recipeCostSnapshotRupiah * item.qty, 0), hppSnapshotStatus: hppItems.every((item) => item.hppSnapshotStatus === "VERIFIED") ? "VERIFIED" : "INCOMPLETE", businessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone),
      costCoverage: orderCostCoverage(hppItems),
      createdAt: this.clock().toISOString(), paidAt: paid ? this.clock().toISOString() : null,
      idempotencyKey, checkoutFingerprint, policyStatus: quote.policyStatus, catalogVersion: quote.catalogVersion,
      rewardId: quote.reward?.id ?? null, promotionCode: quote.promotion?.code ?? null,
      benefitSnapshot: structuredClone(quote.benefitSnapshot), pricingPolicySnapshot: structuredClone(quote.pricingPolicySnapshot),
    };
    const persistedItems = hppItems.map((item) => ({ ...item, id: randomUUID(), orderId: order.id }));
    order.benefitSnapshot.allocations=order.benefitSnapshot.allocations.map((allocation,index)=>({...allocation,orderItemId:persistedItems[index].id}));
    if (paid) this.#reserveConfirmedOrder(order, actor.employeeId, persistedItems, { allowShortage: true });
    this.sequence = nextSequence;
    this.orders.push(order);
    this.orderItems.push(...persistedItems);
    let payment;
    if (quote.totalRupiah === 0) {
      payment = { id: randomUUID(), orderId: order.id, methodNameSnapshot: "No Payment Required", methodType: "none", amountRupiah: 0, receivedRupiah: 0, changeRupiah: 0, status: "PAID", settlementStatus: "not_applicable" };
    } else if (paymentMethod === "CASH") {
      payment = { id: randomUUID(), orderId: order.id, methodNameSnapshot: "Cash", methodType: "cash", amountRupiah: quote.totalRupiah, receivedRupiah: cashReceivedRupiah, changeRupiah: cashReceivedRupiah - quote.totalRupiah, status: "PAID", settlementStatus: "settled", paidAt: order.paidAt };
      this.cashMovements.push({ id: randomUUID(), type: "SALE", orderId: order.id, amountRupiah: quote.totalRupiah, occurredAt: order.paidAt, actorId: actor.employeeId });
    } else if (paymentMethod === 'QRIS_STATIC_MANUAL') {
      payment = { id: randomUUID(), orderId: order.id, methodNameSnapshot: 'QRIS Statis Merchant', methodType: 'qris_manual', amountRupiah: quote.totalRupiah, status: 'PENDING', settlementStatus: 'unchecked', simulator: false, demoOnly: false, staticQrisManual: true, qrImageUrl: '/api/cashier/manual-qris/image' };
    } else {
      const gatewayPayment = this.gateway.create({ orderId: order.id, amountRupiah: quote.totalRupiah, idempotencyKey: `cashier-qris:${scopedKey}` });
      const pending = this.gateway.transition(gatewayPayment.id, "PENDING", `pending:${order.id}`).payment;
      payment = { id: pending.id, orderId: order.id, methodNameSnapshot: "SagaDev Gateway Simulator", methodType: "qris_dynamic", amountRupiah: quote.totalRupiah, receivedRupiah: quote.totalRupiah, changeRupiah: 0, status: "PENDING", settlementStatus: "unchecked", expiresAt: pending.expiresAt };
    }
    this.payments.push(payment);
    this.checkoutByKey.set(scopedKey, order.id);
    if (quote.benefitSnapshot.manual?.authorizationId) this.discountApprovals.get(quote.benefitSnapshot.manual.authorizationId).status = 'CONSUMED';
    if (paid) { this.#commitReward(order); this.#ensureFulfillment(order); }
    this.#event("cashier.checkout.created", { actorId: actor.employeeId, orderId: order.id, paymentMethod, totalRupiah: order.totalRupiah });
    return { ...this.#checkoutResponse(order), tenderOptions: buildCashTenderOptions(order.totalRupiah), idempotentReplay: false };
  }

  settleOperatorQris(actor, { paymentId, callbackId } = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    const payment = this.payments.find((item) => item.id === paymentId && item.methodType === "qris_dynamic");
    if (!payment) throw domainError("payment_not_found", 404);
    const order = this.orders.find((item) => item.id === payment.orderId);
    if (payment.status === "PAID") return { ...this.#checkoutResponse(order), idempotentReplay: true };
    if (payment.status !== "PENDING") throw domainError("payment_not_pending", 409);
    const result = this.gateway.transition(payment.id, "PAID", callbackId || `operator-paid:${payment.id}`);
    payment.status = "PAID";
    payment.paidAt = this.clock().toISOString();
    order.status = "PAID";
    order.paidAt = payment.paidAt;
    this.#reserveConfirmedOrder(order, actor.employeeId, undefined, { allowShortage: true });
    this.#commitReward(order);
    this.#ensureFulfillment(order);
    this.#event("payment.qris.paid", { actorId: actor.employeeId, orderId: order.id, paymentId: payment.id });
    return { ...this.#checkoutResponse(order), idempotentReplay: result.duplicate };
  }

  promotionReport(role, input = {}) {
    if (role !== "owner") throw domainError("owner_required",403);
    return buildCashierPromotionReport(this.orders,{...input,refunds:this.refunds});
  }

  async prepareCashierInput(actor, input) {
    if (input.rewardId && this.productionMemberGuard) throw domainError("production_reward_not_available",409);
    if (!input.memberCode || input[VERIFIED_CASHIER_MEMBER] || (!this.memberProvider && !this.productionMemberGuard)) return input;
    if (!this.memberProvider) throw domainError("production_member_service_required",503);
    let member,summary;
    try {member=await this.memberProvider.resolve(input.memberCode);summary=await this.memberProvider.summary(member.id);}
    catch {throw domainError("member_service_unavailable",503);}
    if (!member || member.status!=="ACTIVE" || summary?.member?.id!==member.id) throw domainError("member_service_unavailable",503);
    const tier=String(summary.tier??'').toUpperCase(),benefit=summary.loyaltyPolicy?.benefits?.[tier];
    return {...input,[VERIFIED_CASHIER_MEMBER]:{memberId:member.id,displayName:String(member.displayName??'Member'),codeMasked:String(member.memberCodeMasked??'MEMBER'),tier,discountPercent:benefit?.type==='PERCENT_DISCOUNT'?Number(benefit.discountPercent??0):0,discountCapRupiah:benefit?.type==='PERCENT_DISCOUNT'?Number(benefit.discountCapRupiah??0):0}};
  }

  previewPromotion(actor, { promotion, cart } = {}) {
    if (actor?.role !== "owner") throw domainError("owner_required",403);
    const preview=new PilotCatalogPricing({clock:this.clock,authoredPromotionEngineEnabled:true});
    preview.restoreState(this.catalogPricing.exportState());preview.publishedSnapshot=null;
    const saved=preview.upsertPromotion({...promotion,expectedVersion:preview.version,actorId:actor.employeeId,reason:promotion?.reason||"Preview Owner tanpa perubahan data"});
    preview.setPromotionStatus({promotionId:saved.promotionId,status:"ACTIVE",expectedVersion:preview.version,actorId:actor.employeeId,reason:"Preview tanpa aktivasi production"});
    return preview.quote({cart,promotionCode:saved.next.code,paymentMethod:"CASH",orderType:"TAKEAWAY"});
  }

  adminState(role) {
    if (!["owner", "admin", "manager"].includes(role)) throw domainError("owner_required", 403);
    const now = this.clock().toISOString();
    const dashboard = this.dashboard();
    const businessOrders = this.orders.filter((order) => order.testMode !== true);
    const businessOrderIds = new Set(businessOrders.map((order) => order.id));
    const daily = getDailyReport({ businessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone), orders: businessOrders.map((order) => ({ ...order, status: order.status === "COMPLETED" ? "paid" : String(order.status).toLowerCase() })), orderItems: this.orderItems.filter((item) => businessOrderIds.has(item.orderId)), payments: this.payments.filter((payment) => payment.status === "PAID" && businessOrderIds.has(payment.orderId)).map((payment) => ({ ...payment, status: "paid" })), inventoryMovements: inventoryReportMovements(this.hppCatalog.view(), SAGA_POS_ALPHA_CONTEXT.timezone), cashSessions: this.cashShift ? [this.cashShift] : [] });
    return {
      context: SAGA_POS_ALPHA_CONTEXT,
      policy: PROVISIONAL_PILOT_POLICY,
      catalog: this.catalogPricing.catalog("ADMIN"),
      catalogVersion: this.catalogPricing.version,
      availabilityHistory: this.catalogPricing.availabilityHistory({ limit: 20 }),
      productHistory: structuredClone(this.catalogPricing.productAudit.slice(-20).reverse()),
      menuWorkspace: this.catalogPricing.workspaceState(),
      pricingConfiguration: this.catalogPricing.pricingConfiguration({ auditLimit: 20 }),
      promotionConfiguration: this.catalogPricing.promotionConfiguration({ auditLimit: 20 }),
      promotionReport: role === "owner" ? this.promotionReport(role) : null,
      variantConfiguration: this.catalogPricing.variantConfiguration({ auditLimit: 20 }),
      modifierConfiguration: this.catalogPricing.modifierConfiguration({ auditLimit: 20 }),
      orderingSettings: structuredClone(this.catalogPricing.orderingSettings),
      orderingHistory: structuredClone(this.catalogPricing.orderingAudit.slice(-20).reverse()),
      hpp: this.hppCatalog.view(),
      dashboard,
      reports: {
        daily: { ...daily, netSalesRupiah: dashboard.netSalesRupiah, aovRupiah: dashboard.aovRupiah, totalHppRupiah: dashboard.totalHppRupiah, grossProfitRupiah: dashboard.grossProfitRupiah, grossMarginPct: dashboard.grossMarginPct, costStatus: dashboard.costStatus, financialSummary: dashboard.financialSummary },
        settlement: getPaymentSettlementReport({ payments: this.payments.filter((payment) => payment.status === "PAID" && businessOrderIds.has(payment.orderId)).map((payment) => ({ ...payment, status: "paid" })) }),
      },
      devices: structuredClone(this.devices),
      printJobs: this.printSpooler.list(),
      refunds: structuredClone(this.refunds),
      remakes: structuredClone(this.remakes),
      integrations: this.#integrationStatus(),
      generatedAt: now,
    };
  }

  adminAction(role, actorId, action, payload = {}) {
    if (!["owner", "admin", "manager"].includes(role)) throw domainError("owner_required", 403);
    if (role === "admin" && !String(action).startsWith("catalog.")) throw domainError("owner_required", 403);
    if (['catalog.workspace.voucher.batch.issue','catalog.workspace.voucher.batch.status'].includes(action)) {
      if(role !== 'owner')throw domainError('owner_required',403);
      const before=this.catalogPricing.exportState();
      try {this.catalogPricing.beginWorkspace();return action.endsWith('.issue') ? this.catalogPricing.issueVoucherBatch({...payload,actorId}) : this.catalogPricing.setVoucherBatchStatus({...payload,actorId});}
      catch(error){this.catalogPricing.restoreState(before);throw error;}
    }
    if (action === 'catalog.discount_limit.update') {
      if (role !== 'owner') throw domainError('owner_required', 403);
      if (!Number.isSafeInteger(payload.staffLimitRupiah) || payload.staffLimitRupiah < 0 || payload.staffLimitRupiah > 100000000 || !String(payload.reason ?? '').trim() || String(payload.reason).length > 160) throw domainError('discount_limit_invalid', 422);
      if (payload.expectedVersion !== this.catalogPricing.version) throw domainError('catalog_version_conflict', 409);
      this.catalogPricing.manualDiscountStaffLimitRupiah = payload.staffLimitRupiah;
      this.catalogPricing.version++;
      this.catalogPricing.promotionAudit.push({type:'discount.limit.updated',actorId,reason:payload.reason,staffLimitRupiah:payload.staffLimitRupiah,occurredAt:this.clock().toISOString(),version:this.catalogPricing.version});
      return {staffLimitRupiah:payload.staffLimitRupiah,version:this.catalogPricing.version};
    }
    if (role === "manager" && (!String(action).startsWith("catalog.") || ["catalog.workspace.publish", "catalog.publication.rollback", "catalog.product.publish"].includes(action))) throw domainError("catalog_publish_owner_required", 403);
    if (["hpp.purchase_order.receive", "hpp.purchase.receive"].includes(action)) {
      action = "hpp.purchase_receipt.post";
      payload = normalizeRuntimeReceiptPayload(payload, this.receivingOutletId, true);
    } else if (action === "hpp.purchase_receipt.post") {
      payload = normalizeRuntimeReceiptPayload(payload, this.receivingOutletId, false);
    } else if (action === "hpp.purchase_receipt.inspection.decide") {
      payload = normalizeRuntimeInspectionPayload(payload, this.receivingOutletId);
    } else if (action === "hpp.inventory.record") {
      payload = normalizeOwnerInventoryMovementPayload(payload, this.receivingOutletId);
    } else if (action === "hpp.inventory.transfer") {
      throw domainError("inventory_transfer_not_needed_shared_storage", 409);
    }
    if (action === "catalog.availability") return this.catalogPricing.setAvailability({ ...payload, actorId });
    if (action === "catalog.availability.draft") return this.catalogPricing.stageAvailability({ ...payload, actorId });
    if (action === "catalog.workspace.product.create") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.createProduct({ ...payload, actorId }); }
    if (action === "catalog.workspace.product.update") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.updateProduct({ ...payload, actorId }); }
    if (action === "catalog.workspace.product.reorder") return this.catalogPricing.reorderProducts({ ...payload, actorId });
    if (action === "catalog.workspace.category.create") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.createCategory({ ...payload, actorId }); }
    if (action === "catalog.workspace.category.update") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.updateCategory({ ...payload, actorId }); }
    if (action === "catalog.workspace.product.media.update") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.updateProductMedia({ ...payload, actorId }); }
    if (action === "catalog.workspace.product.media.remove") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.removeProductMedia({ ...payload, actorId }); }
    if (action === "catalog.workspace.promotion.upsert") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.upsertPromotion({ ...payload, actorId }); }
    if (action === "catalog.workspace.promotion.status") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.setPromotionStatus({ ...payload, actorId }); }
    if (action === "catalog.workspace.variant.group.upsert") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.upsertVariantGroup({ ...payload, actorId }); }
    if (action === "catalog.workspace.variant.option.upsert") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.upsertVariantOption({ ...payload, actorId }); }
    if (action === "catalog.workspace.modifier.group.upsert") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.upsertModifierGroup({ ...payload, actorId }); }
    if (action === "catalog.workspace.modifier.option.upsert") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.upsertModifierOption({ ...payload, actorId }); }
    if (action === "catalog.workspace.ordering.update") { this.catalogPricing.beginWorkspace(); return this.catalogPricing.updateOrdering({ ...payload, actorId }); }
    if (action === "catalog.category.create") return this.catalogPricing.createCategory({ ...payload, actorId });
    if (action === "catalog.category.update") return this.catalogPricing.updateCategory({ ...payload, actorId });
    if (action === "catalog.product.create") return this.catalogPricing.createProduct({ ...payload, actorId });
    if (action === "catalog.product.update") return this.catalogPricing.updateProduct({ ...payload, actorId });
    if (action === "catalog.product.archive") return this.catalogPricing.archiveProduct({ ...payload, actorId });
    if (action === "catalog.product.restore") return this.catalogPricing.restoreProduct({ ...payload, actorId });
    if (action === "catalog.workspace.bulk") return this.catalogPricing.bulkWorkspaceAction({ ...payload, actorId });
    if (action === "catalog.workspace.publish") return this.catalogPricing.publishWorkspace({ ...payload, actorId });
    if (action === "catalog.publication.rollback") return this.catalogPricing.rollbackPublication({ ...payload, actorId });
    if (action === "catalog.product.media.update") return this.catalogPricing.updateProductMedia({ ...payload, actorId });
    if (action === "catalog.product.media.remove") return this.catalogPricing.removeProductMedia({ ...payload, actorId });
    if (action === "catalog.product.publish") return this.catalogPricing.publishProduct({ ...payload, actorId });
    if (action === "catalog.pricing.update") return this.catalogPricing.updatePricingPolicy({ ...payload, actorId });
    if (action === "catalog.promotion.upsert") return this.catalogPricing.upsertPromotion({ ...payload, actorId });
    if (action === "catalog.promotion.status") return this.catalogPricing.setPromotionStatus({ ...payload, actorId });
    if (action === "catalog.variant.group.upsert") return this.catalogPricing.upsertVariantGroup({ ...payload, actorId });
    if (action === "catalog.variant.option.upsert") return this.catalogPricing.upsertVariantOption({ ...payload, actorId });
    if (action === "catalog.modifier.group.upsert") return this.catalogPricing.upsertModifierGroup({ ...payload, actorId });
    if (action === "catalog.modifier.option.upsert") return this.catalogPricing.upsertModifierOption({ ...payload, actorId });
    if (action === "catalog.ordering.update") return this.catalogPricing.updateOrdering({ ...payload, actorId });
    if (action === "prototype.orders.clear") return this.#clearPrototypeOrders({ ...payload, actorId });
    if (action === "hpp.ingredient.upsert") return this.hppCatalog.upsertIngredient({ ...payload, actorId });
    if (action === "hpp.ingredient.master.upsert") return this.hppCatalog.upsertIngredientMaster({ ...payload, actorId });
    if (action === "hpp.ingredient.archive") return this.hppCatalog.archiveIngredient({ ...payload, actorId });
    if (action === "hpp.ingredient.conversion.upsert") return this.hppCatalog.upsertIngredientConversion({ ...payload, actorId });
    if (action === "hpp.ingredient.supplier_package.upsert") return this.hppCatalog.upsertIngredientSupplierPackage({ ...payload, actorId });
    if (action === "hpp.material_category.create") return this.hppCatalog.createMaterialCategory({ ...payload, actorId });
    if (action === "hpp.material_category.update") return this.hppCatalog.updateMaterialCategory({ ...payload, actorId });
    if (action === "hpp.material_category.archive") return this.hppCatalog.archiveMaterialCategory({ ...payload, actorId });
    if (action === "hpp.ingredient.purchase_option.upsert") return this.hppCatalog.upsertIngredientPurchaseOption({ ...payload, actorId });
    if (action === "hpp.ingredient.reference_price.record") return this.hppCatalog.recordIngredientReferencePrice({ ...payload, actorId });
    if (action === "hpp.ingredient.reference_price.correct") return this.hppCatalog.correctIngredientReferencePrice({ ...payload, actorId });
    if (action === "hpp.ingredient.reference_price.void") return this.hppCatalog.voidIngredientReferencePrice({ ...payload, actorId });
    if (action === "hpp.ingredient.wizard.create") return this.hppCatalog.createIngredientFromWizard({ ...payload, actorId });
    if (action === "hpp.production_recipe.upsert") return this.hppCatalog.upsertIngredientProductionRecipe({ ...payload, actorId });
    if (action === "hpp.production.void") return this.hppCatalog.voidProductionExecution({ ...payload, actorId });
    if (action === "hpp.production.correct") return this.hppCatalog.correctProductionExecution({ ...payload, actorId });
    if (action === "hpp.supplier.upsert") return this.hppCatalog.upsertSupplier({ ...payload, actorId });
    if (action === "hpp.purchase_order.create") return this.hppCatalog.createPurchaseOrder({ ...payload, actorId });
    if (action === "hpp.purchase_order.amend") return this.hppCatalog.amendPurchaseOrder({ ...payload, actorId });
    if (action === "hpp.purchase_order.cancel") return this.hppCatalog.cancelPurchaseOrder({ ...payload, actorId });
    if (action === "hpp.purchase_receipt.post") return this.hppCatalog.postPurchaseReceipt({ ...payload, actorId });
    if (action === "hpp.purchase_receipt.inspection.decide") return this.hppCatalog.decidePurchaseReceiptInspection({ ...payload, actorId });
    if (action === "hpp.purchase_order.receive") return this.hppCatalog.receivePurchaseOrder({ ...payload, actorId });
    if (action === "hpp.purchase_invoice.match") return this.hppCatalog.matchPurchaseInvoice({ ...payload, actorId });
    if (action === "hpp.purchase_invoice.post") return this.hppCatalog.postPurchaseInvoice({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase_invoice.payment.record") return this.hppCatalog.recordPurchaseInvoicePayment({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase_invoice.credit.post") return this.hppCatalog.postPurchaseInvoiceCredit({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase_invoice.credit_reversal.decide") return this.hppCatalog.decidePurchaseInvoiceCreditReversal({ ...payload, actorId, actorRole: role });
    if (action === "hpp.supplier_return.create") return this.hppCatalog.createSupplierReturn({ ...payload, actorId, actorRole: role });
    if (action === "hpp.supplier_replacement.receive") return this.hppCatalog.receiveSupplierReplacement({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase.receive") return this.hppCatalog.receivePurchase({ ...payload, actorId });
    if (action === "hpp.inventory.record") return this.hppCatalog.recordInventoryMovement({ ...payload, actorId });
    if (action === "hpp.inventory.reverse") return this.hppCatalog.reverseInventoryMovement({ ...payload, actorId });
    if (action === "hpp.inventory.transfer") return this.hppCatalog.transferInventory({ ...payload, actorId });
    if (action === "hpp.inventory.count.complete") return this.hppCatalog.completeInventoryCount({ ...payload, actorId });
    if (action === "hpp.inventory.period.close") return this.hppCatalog.closeInventoryPeriod({ ...payload, actorId });
    if (action === "hpp.recipe.line.upsert") return this.hppCatalog.upsertRecipeLine({ ...payload, actorId });
    if (action === "hpp.recipe.line.remove") return this.hppCatalog.removeRecipeLine({ ...payload, actorId });
    if (action === "hpp.recipe_draft.line.upsert") return this.hppCatalog.upsertRecipeDraftLine({ ...payload, actorId });
    if (action === "hpp.recipe_draft.lines.upsert") return this.hppCatalog.upsertRecipeDraftLines({ ...payload, actorId });
    if (action === "hpp.recipe_draft.line.remove") return this.hppCatalog.removeRecipeDraftLine({ ...payload, actorId });
    if (action === "hpp.recipe_draft.line.reorder") return this.hppCatalog.reorderRecipeDraftLines({ ...payload, actorId });
    if (action === "hpp.recipe_draft.publish") return this.hppCatalog.publishRecipeDraft({ ...payload, actorId });
    if (action === "hpp.modifier_recipe.line.upsert") return this.hppCatalog.upsertModifierRecipeLine({ ...payload, actorId });
    if (action === "hpp.modifier_recipe.line.remove") return this.hppCatalog.removeModifierRecipeLine({ ...payload, actorId });
    if (action === "hpp.fulfillment_recipe.line.upsert") return this.hppCatalog.upsertFulfillmentRecipeLine({ ...payload, actorId });
    if (action === "hpp.fulfillment_recipe.line.remove") return this.hppCatalog.removeFulfillmentRecipeLine({ ...payload, actorId });
    if (action === "hpp.gate.update") return this.hppCatalog.setGate({ ...payload, actorId });
    if (action === "payment.settlement.review") return this.#reviewPaymentSettlement(actorId, payload);
    if (action === "order.refund") return this.#refundOrder(actorId, payload);
    if (action === "order.remake") return this.#remakeOrder(actorId, payload);
    if (action === "order.remake.start") return this.#startRemake(actorId, payload);
    if (action === "print.reprint") return this.printSpooler.reprint(payload.printJobId, { actorId, reason: payload.reason });
    throw domainError("admin_action_not_found", 404);
  }

  apState(role) {
    if (role !== "finance") throw domainError("finance_role_denied", 403);
    const hpp = this.hppCatalog.view();
    const accountsPayableAging = buildAccountsPayableAging({
      purchaseInvoices: this.hppCatalog.exportState().purchaseInvoices,
      asOfBusinessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone),
    });
    return {
      context: SAGA_POS_ALPHA_CONTEXT,
      version: hpp.version,
      readyCount: hpp.purchaseInvoiceReadyCount,
      approvedCount: hpp.purchaseInvoiceApprovedCount,
      postedCount: hpp.purchaseInvoicePostedCount,
      paidCount: hpp.purchaseInvoicePaidCount,
      openPayableRupiah: hpp.openPayableRupiah,
      paidPayableRupiah: hpp.paidPayableRupiah,
      invoices: hpp.purchaseInvoices,
      payments: hpp.purchaseInvoicePayments,
      pendingCreditCount: hpp.purchaseInvoiceCreditPendingCount,
      postedCreditCount: hpp.purchaseInvoiceCreditPostedCount,
      creditReversalPendingCount: hpp.purchaseInvoiceCreditReversalPendingCount,
      reversedCreditCount: hpp.purchaseInvoiceCreditReversedCount,
      postedCreditRupiah: hpp.postedCreditRupiah,
      credits: hpp.purchaseInvoiceCredits,
      supplierReturns: hpp.supplierReturns,
      accountsPayableAging,
      supplierReturnAwaitingCreditCount: hpp.supplierReturnAwaitingCreditCount,
      supplierReturnCreditPendingPostCount: hpp.supplierReturnCreditPendingPostCount,
      generatedAt: this.clock().toISOString(),
    };
  }

  apAction(role, actorId, action, payload = {}) {
    if (role !== "finance") throw domainError("finance_role_denied", 403);
    if (action === "hpp.purchase_invoice.approval.decide") return this.hppCatalog.decidePurchaseInvoiceApproval({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase_invoice.credit.record") return this.hppCatalog.recordPurchaseInvoiceCredit({ ...payload, actorId, actorRole: role });
    if (action === "hpp.purchase_invoice.credit_reversal.request") return this.hppCatalog.requestPurchaseInvoiceCreditReversal({ ...payload, actorId, actorRole: role });
    throw domainError("ap_action_not_found", 404);
  }

  exportOrdersCsv(role) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const rows = [["order_number", "business_date", "channel", "status", "total_rupiah", "payment_method", "test_mode"]];
    for (const order of this.orders) {
      const payment = this.payments.find((item) => item.orderId === order.id);
      rows.push([order.orderNumber, order.businessDate, order.channel, order.status, order.totalRupiah, payment?.methodType ?? "none", order.testMode === true]);
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\n");
  }

  ownerOrders(role, input = {}, { paginate = true } = {}) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const { mode = "live", date = businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone), q = "", channel = "ALL", status = "ALL", page = "1" } = input;
    if (!['live', 'history'].includes(mode) || !['ALL', 'CASHIER', 'KIOSK', 'TABLE'].includes(channel)
      || !['ALL', 'PENDING', 'NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'READY', 'COMPLETED', 'ATTENTION'].includes(status)
      || typeof q !== 'string' || q.length > 80 || !/^\d{1,6}$/.test(String(page)) || Number(page) < 1) throw domainError('order_filter_invalid', 422);
    normalizeBusinessDate(date);
    // ponytail: reuse the outlet-scoped hydrated runtime; move filtering to indexed SQL if history exceeds memory capacity.
    const scope = this.ids ?? SAGA_POS_ALPHA_CONTEXT;
    const itemsByOrder = new Map(), paymentsByOrder = new Map();
    const pendingRefunds = new Set(this.refunds.filter(refund => refund.status === 'PENDING_MANUAL_FINANCE_RECONCILIATION').map(refund => refund.orderId));
    for (const [records, grouped] of [[this.orderItems, itemsByOrder], [this.payments, paymentsByOrder]]) for (const record of records) {
      if (!grouped.has(record.orderId)) grouped.set(record.orderId, []);
      grouped.get(record.orderId).push(record);
    }
    const rows = this.orders.filter(order => order.testMode !== true && order.organizationId === scope.organizationId && order.outletId === scope.outletId).map(order => {
      const ticket = this.fulfillments.get(order.id);
      const payments = paymentsByOrder.get(order.id) ?? [];
      const payment = payments.findLast(item => item.status === 'PAID') ?? payments.at(-1);
      const paymentStatus = payment?.status ?? 'NONE';
      const kitchenStatus = ticket?.status ?? 'NONE';
      const attention = ['FAILED', 'EXPIRED'].includes(paymentStatus) || pendingRefunds.has(order.id) || (['PAID', 'COMPLETED'].includes(order.status) && !ticket);
      return {
        id: order.id, orderNumber: order.orderNumber, businessDate: order.businessDate, createdAt: order.createdAt, paidAt: order.paidAt ?? null,
        channel: order.channel, orderType: order.orderType, orderStatus: order.status, paymentStatus, kitchenStatus, attention,
        totalRupiah: order.totalRupiah,
        items: (itemsByOrder.get(order.id) ?? []).map(item => ({ name: item.productNameSnapshot, qty: item.qty })),
        paymentMethod: payment?.methodNameSnapshot ?? 'Belum memilih pembayaran',
        active: paymentStatus === 'PENDING' || ['NEW', 'ACKNOWLEDGED', 'IN_PROGRESS', 'READY'].includes(kitchenStatus),
      };
    });
    const counts = {
      pending: rows.filter(row => row.paymentStatus === 'PENDING').length,
      new: rows.filter(row => ['NEW', 'ACKNOWLEDGED'].includes(row.kitchenStatus)).length,
      preparing: rows.filter(row => row.kitchenStatus === 'IN_PROGRESS').length,
      ready: rows.filter(row => row.kitchenStatus === 'READY').length,
      attention: rows.filter(row => row.attention).length,
    };
    const query = q.trim().toLocaleLowerCase('id');
    const filtered = rows.filter(row => (mode === 'live' ? row.active || row.attention : row.businessDate === date)
      && (channel === 'ALL' || row.channel === channel)
      && (status === 'ALL' || (status === 'PENDING' ? row.paymentStatus === 'PENDING' : status === 'ATTENTION' ? row.attention : row.kitchenStatus === status))
      && (!query || `${row.orderNumber} ${row.items.map(item => item.name).join(' ')}`.toLocaleLowerCase('id').includes(query)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const pageSize = 20;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(Number(page), pageCount);
    return { mode, date, q: q.trim(), channel, status, page: currentPage, pageSize, pageCount, total: filtered.length,
      serverTime: this.clock().toISOString(), shift: this.cashShift ? { status: this.cashShift.status, businessDate: this.cashShift.businessDate } : null,
      counts, rows: paginate ? filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize) : filtered };
  }

  ownerOrderDetail(role, id) {
    if (role !== 'owner') throw domainError('owner_required', 403);
    const scope = this.ids ?? SAGA_POS_ALPHA_CONTEXT;
    const order = this.orders.find(item => item.id === id && item.testMode !== true && item.organizationId === scope.organizationId && item.outletId === scope.outletId);
    if (!order) throw domainError('order_not_found', 404);
    const ticket = this.fulfillments.get(id);
    return {
      id, orderNumber: order.orderNumber, businessDate: order.businessDate, channel: order.channel, orderType: order.orderType,
      orderStatus: order.status, kitchenStatus: ticket?.status ?? 'NONE',
      subtotalRupiah: order.subtotalRupiah, discountRupiah: order.discountRupiah, taxRupiah: order.taxRupiah,
      serviceRupiah: order.serviceRupiah, roundingRupiah: order.roundingRupiah, totalRupiah: order.totalRupiah,
      refunds:structuredClone(this.refunds.filter(refund=>refund.orderId === id)),
      cashRefundAvailable:this.cashShift?.status === 'open' && this.payments.filter(payment=>payment.orderId === id && ['PAID','REFUNDED'].includes(payment.status)).length === 1 && this.payments.some(payment=>payment.orderId === id && payment.methodType === 'cash' && payment.status === 'PAID' && payment.amountRupiah === order.totalRupiah),
      items: this.orderItems.filter(item => item.orderId === id).map(item => ({ id:item.id,name: item.productNameSnapshot, qty: item.qty, refundableQty:item.qty-this.refunds.filter(refund=>refund.orderId === id).reduce((sum,refund)=>sum+(refund.items?.find(line=>line.orderItemId === item.id)?.qty??(refund.full || !refund.items?item.qty:0)),0),unitPriceRupiah: item.unitPriceRupiah, lineTotalRupiah: item.lineTotalRupiah, note: item.note ?? '',
        selections: (item.selections ?? []).map(selection => ({ name: selection.optionLabel ?? selection.optionNameSnapshot ?? selection.name ?? selection.optionName ?? '', group: selection.groupLabel ?? selection.groupNameSnapshot ?? selection.groupName ?? '' })) })),
      payments: this.payments.filter(item => item.orderId === id).map(item => ({ method: item.methodNameSnapshot, status: item.status, amountRupiah: item.amountRupiah, receivedRupiah: item.receivedRupiah ?? null, changeRupiah: item.changeRupiah ?? null, settlementStatus: item.settlementStatus ?? null })),
      timeline: [['Dibuat', order.createdAt], ['Pembayaran diterima', order.paidAt], ['Diterima dapur', ticket?.acknowledgedAt], ['Mulai dibuat', ticket?.prepStartedAt], ['Siap diserahkan', ticket?.readyAt], ['Dibuat ulang', ticket?.remadeAt], ['Selesai', ticket?.completedAt]].filter(([, at]) => at).sort((a, b) => a[1].localeCompare(b[1])).map(([label, at]) => ({ label, at })),
    };
  }

  previewOwnerRefund(role, {orderId,items,reason,idempotencyKey} = {}) {
    this.ownerOrderDetail(role,orderId);
    return planCashierRefund({order:this.orders.find(order=>order.id === orderId),orderItems:this.orderItems.filter(item=>item.orderId === orderId),refunds:this.refunds,items,reason,idempotencyKey});
  }

  exportOwnerOrdersCsv(role, input) {
    const result = this.ownerOrders(role, input, { paginate: false });
    const rows = [['order_number', 'business_date', 'channel', 'payment_status', 'kitchen_status', 'total_rupiah']];
    for (const row of result.rows) rows.push([row.orderNumber, row.businessDate, row.channel, row.paymentStatus, row.kitchenStatus, row.totalRupiah]);
    return rows.map(row => row.map(csvSafeCell).join(',')).join('\n');
  }

  operatorState(role, { reportDate, openingCountId, closingCountId } = {}) {
    if (role === "bar") {
      return {
        context: SAGA_POS_ALPHA_CONTEXT,
        role: "BAR",
        serverTime: this.clock().toISOString(),
        queue: this.fulfillmentQueue(),
      };
    }
    if (role === "owner") {
      return {
        context: SAGA_POS_ALPHA_CONTEXT,
        role: "OWNER",
        serverTime: this.clock().toISOString(),
        dashboard: this.dashboard(reportDate, { openingCountId, closingCountId }),
        queue: this.fulfillmentQueue(),
        orders: this.orders.filter((item) => item.status === "PAID" && item.testMode !== true).map((item) => this.#safeOrder(item)).reverse(),
        prototypeOrders: this.orders.filter((item) => item.testMode === true).map((item) => this.#safeOrder(item)).reverse(),
        events: structuredClone(this.events.slice(-30).reverse()),
        integrations: this.#integrationStatus(),
        catalog: this.catalogPricing.catalog("ADMIN"),
        catalogVersion: this.catalogPricing.version,
        catalogHistory: structuredClone(this.catalogPricing.productAudit.slice(-30).reverse()),
        orderingSettings: structuredClone(this.catalogPricing.orderingSettings),
      };
    }
    if (role === "cashier") return this.cashierState({ employeeId: "CASHIER-01", displayName: "Cashier 01", role: "cashier", mode: "CASHIER" });
    throw domainError("operator_role_denied", 403);
  }

  inventoryWorkspaceState(role) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const generatedAt = this.clock().toISOString();
    return buildOwnerInventoryWorkspace({
      hpp: this.hppCatalog.view(),
      catalog: this.catalogPricing.catalog("ADMIN"),
      context: { ...SAGA_POS_ALPHA_CONTEXT, organizationId: this.ids?.organizationId ?? SAGA_POS_ALPHA_CONTEXT.organizationId,
        outletId: this.receivingOutletId },
      generatedAt,
      businessDate: businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone),
      source: this.persistenceStatus,
      orders: this.orders,
      orderItems: this.orderItems,
    });
  }

  phase3ReadinessState(role, { tableOrder = {}, paymentMode = "OFF" } = {}) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return buildPhase3OrderKdsReadiness({
      catalog: this.catalogPricing.catalog("ADMIN"),
      hpp: this.hppCatalog.view(),
      fulfillments: [...this.fulfillments.values()],
      tableOrder,
      paymentMode,
      generatedAt: this.clock().toISOString(),
    });
  }

  async inventoryWorkspaceAction(role, actorId, command = {}) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const actions = {
      "ingredient.upsert": "hpp.ingredient.master.upsert",
      "ingredient.archive": "hpp.ingredient.archive",
      "ingredient.conversion.upsert": "hpp.ingredient.conversion.upsert",
      "ingredient.supplier-package.upsert": "hpp.ingredient.supplier_package.upsert",
      "ingredient.purchase-option.upsert": "hpp.ingredient.purchase_option.upsert",
      "ingredient.reference-price.record": "hpp.ingredient.reference_price.record",
      "ingredient.reference-price.correct": "hpp.ingredient.reference_price.correct",
      "ingredient.reference-price.void": "hpp.ingredient.reference_price.void",
      "purchase-option.upsert": "hpp.ingredient.purchase_option.upsert",
      "category.create": "hpp.material_category.create",
      "category.update": "hpp.material_category.update",
      "category.archive": "hpp.material_category.archive",
      "ingredient.wizard.create": "hpp.ingredient.wizard.create",
      "warehouse.receipt.post": "hpp.purchase_receipt.post",
      "warehouse.movement.record": "hpp.inventory.record",
      "warehouse.movement.reverse": "hpp.inventory.reverse",
      "warehouse.transfer.record": "hpp.inventory.transfer",
      "warehouse.count.complete": "hpp.inventory.count.complete",
      "hpp.draft-line.upsert": "hpp.recipe_draft.line.upsert",
      "hpp.draft-lines.upsert": "hpp.recipe_draft.lines.upsert",
      "hpp.draft-line.remove": "hpp.recipe_draft.line.remove",
      "hpp.draft-line.reorder": "hpp.recipe_draft.line.reorder",
      "hpp.draft.publish": "hpp.recipe_draft.publish",
    };
    const internalAction = actions[command.action];
    if (!internalAction) throw domainError("inventory_action_not_found", 404);
    if (command.action === "warehouse.transfer.record") throw domainError("inventory_transfer_not_needed_shared_storage", 409);
    if (!Number.isSafeInteger(command.expectedRevision)) throw domainError("hpp_version_required", 422);
    if (typeof command.reason !== "string" || !command.reason.trim() || command.reason.trim().length > 160) throw domainError("hpp_reason_required", 422);
    if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) throw domainError("inventory_action_payload_invalid", 422);
    const payload = command.action === "warehouse.receipt.post"
      ? normalizeRuntimeReceiptPayload(normalizeOwnerInventoryReceiptPayload(this.hppCatalog, command.payload,
        this.clock().toISOString(), this.receivingOutletId), this.receivingOutletId, true)
      : command.action === "warehouse.movement.record"
          ? normalizeOwnerInventoryMovementPayload(command.payload, this.receivingOutletId)
        : command.payload;
    const operation = await this.adminAction(role, actorId, internalAction, {
      ...payload,
      expectedVersion: command.expectedRevision,
      reason: command.reason,
    });
    const workspace = await this.inventoryWorkspaceState(role);
    return {
      operation,
      workspace: {
        ...workspace,
        lastOperation: inventoryOperationMessage(command.action, operation),
      },
    };
  }

  ingredientPriceImpact(role, filters = {}) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const ingredientId = String(filters.ingredientId ?? "").trim();
    const hpp = this.hppCatalog.view();
    const ingredient = hpp.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const month = filters.month == null || filters.month === "" ? null : String(filters.month);
    if (month !== null && !/^\d{4}-\d{2}$/.test(month)) throw domainError("ingredient_price_history_month_invalid", 422);
    const supplierValue = filters.supplier == null ? "" : normalizeSupplierDisplayName(filters.supplier);
    const supplierKey = !supplierValue || supplierValue.toUpperCase() === "ALL" ? null : normalizeSupplierKey(supplierValue);
    const sourceValue = filters.source == null ? "" : String(filters.source).trim().toUpperCase();
    const source = !sourceValue || sourceValue === "ALL" ? null : sourceValue;
    const allowedSources = new Set(["REFERENCE_PRICE", "ACTUAL_RECEIPT", "PRODUCT_SELLING_PRICE"]);
    if (source !== null && !allowedSources.has(source)) throw domainError("ingredient_price_history_source_invalid", 422);
    const state = this.hppCatalog.exportState();
    const allReferenceHistory = normalizeReferencePriceHistory((hpp.ingredientReferencePriceVersions ?? []).filter((item) => item.ingredientId === ingredientId));
    const referenceHistory = allReferenceHistory;
    const receiptHistory = state.purchaseReceipts.flatMap((receipt) => (receipt.lines ?? []).filter((line) => line.ingredientId === ingredientId).map((line) => ({
      id: `${receipt.id}:${ingredientId}`, source: "ACTUAL_RECEIPT", timestamp: receipt.receivedAt, occurredAt: receipt.receivedAt,
      supplierName: receipt.supplierName ?? null, actorId: receipt.actorId ?? null, reason: receipt.reason ?? "Penerimaan pembelian",
      purchaseReceiptId: receipt.id, referencePriceRupiah: line.purchaseOptionSnapshot?.referencePriceRupiah ?? null,
      actualTotalCostRupiah: line.totalCostRupiah, actualBaseQuantity: line.baseQuantity,
      packageLabel: line.purchaseUnitLabel ?? null, baseQuantity: line.baseQuantity, totalCostRupiah: line.totalCostRupiah,
      unitCostPerBaseUnitRupiah: line.baseQuantity > 0 ? Math.round(line.totalCostRupiah / line.baseQuantity * 1_000_000) / 1_000_000 : null,
      unitCostRupiah: line.baseQuantity > 0 ? Math.round(line.totalCostRupiah / line.baseQuantity * 1_000_000) / 1_000_000 : null,
    })));
    const affectedProductIds = new Set([...this.hppCatalog.recipes.values(), ...this.hppCatalog.recipeDrafts.values()].filter((recipe) => recipe.items?.some((line) => line.ingredientId === ingredientId)).map((recipe) => recipe.productId));
    const costByProduct = new Map(hpp.products.map((product) => [product.id, product]));
    const productHistory = this.catalogPricing.productAudit.filter((event) => affectedProductIds.has(event.productId) && event.previous?.priceRupiah !== event.next?.priceRupiah).map((event) => {
      const bookHpp = costByProduct.get(event.productId)?.hppRupiah ?? null;
      return {
        id: `product-price:${event.productId}:${event.version}`, source: "PRODUCT_SELLING_PRICE", timestamp: event.occurredAt, occurredAt: event.occurredAt,
        productId: event.productId, menuName: event.next.name, actorId: event.actorId, reason: event.reason,
        previousSellingPriceRupiah: event.previous.priceRupiah, nextSellingPriceRupiah: event.next.priceRupiah,
        hppRupiahUnchanged: bookHpp, hppBasis: "CURRENT_BOOK_COST",
        previousMarginPct: bookHpp == null ? null : marginPercent(event.previous.priceRupiah, bookHpp),
        nextMarginPct: bookHpp == null ? null : marginPercent(event.next.priceRupiah, bookHpp),
      };
    });
    const supplierDisplays = supplierDisplayMap([...allReferenceHistory, ...receiptHistory]);
    const supplier = supplierKey === null ? null : supplierDisplays.get(supplierKey) ?? supplierValue;
    const matches = (item) => (!month || jakartaMonth(item.timestamp) === month) && (!supplierKey || normalizeSupplierKey(item.supplierName) === supplierKey) && (!source || item.source === source);
    const filteredHistory = [...referenceHistory, ...receiptHistory, ...productHistory].filter(matches).sort(compareImpactHistoryDesc);
    const historyPage = paginateImpactHistory(filteredHistory, filters.cursor, filters.limit);
    const effectiveReferences = effectiveReferencePriceHistory(allReferenceHistory, this.clock().toISOString());
    const latestReference = effectiveReferences[0] ?? null;
    const currentOption = hpp.ingredientSupplierPackages.find((item) => item.ingredientId === ingredientId && item.purchaseOptionId === latestReference?.purchaseOptionId)
      ?? hpp.ingredientSupplierPackages.find((item) => item.ingredientId === ingredientId && item.preferred)
      ?? hpp.ingredientSupplierPackages.find((item) => item.ingredientId === ingredientId);
    const latestPrice = latestReference?.referencePriceRupiah ?? currentOption?.referencePriceRupiah ?? null;
    const simulation = currentOption && latestPrice ? this.hppCatalog.simulateIngredientReferencePriceImpact({ ingredientId, purchaseOptionId: currentOption.purchaseOptionId, referencePriceRupiah: latestPrice }) : { summary: { affectedMenuCount: affectedProductIds.size, activeMenuCount: 0, inactiveMenuCount: 0, partialMenuCount: 0, changesBookCost: false }, menuImpacts: [] };
    const availableSuppliers = [...supplierDisplays.values()].sort((a, b) => a.localeCompare(b, "id"));
    const filteredSupplierDisplays = supplierDisplayMap(filteredHistory);
    const suppliers = [...filteredSupplierDisplays.entries()].map(([key, name]) => {
      const rows = filteredHistory.filter((item) => normalizeSupplierKey(item.supplierName) === key && item.unitCostRupiah != null);
      const totalBase = rows.reduce((sum, item) => sum + Number(item.baseQuantity ?? 0), 0);
      const totalCost = rows.reduce((sum, item) => sum + Number(item.totalCostRupiah ?? 0), 0);
      const costs = rows.map((item) => item.unitCostRupiah);
      const monthly = supplierMonthlyAggregates(rows);
      const weightedUnitCostRupiah = totalBase > 0 ? Math.round(totalCost / totalBase * 1_000_000) / 1_000_000 : null;
      return { supplierName: name, supplierKey: key, eventCount: rows.length, latestUnitCostPerBaseUnitRupiah: rows[0]?.unitCostRupiah ?? null, weightedUnitCostRupiah, minUnitCostRupiah: costs.length ? Math.min(...costs) : null, maxUnitCostRupiah: costs.length ? Math.max(...costs) : null, monthly, fullAggregate: { eventCount: rows.length, baseQuantity: totalBase, totalCostRupiah: totalCost, weightedUnitCostRupiah } };
    });
    const cheapestSupplierCost = suppliers.map((item) => item.weightedUnitCostRupiah ?? item.latestUnitCostPerBaseUnitRupiah).filter((item) => item != null).sort((a, b) => a - b)[0] ?? null;
    for (const item of suppliers) {
      const comparable = item.weightedUnitCostRupiah ?? item.latestUnitCostPerBaseUnitRupiah;
      item.diffFromCheapestRupiah = comparable == null || cheapestSupplierCost == null ? null : Math.round((comparable - cheapestSupplierCost) * 1_000_000) / 1_000_000;
      item.diffFromCheapestPct = comparable == null || !cheapestSupplierCost ? null : Math.round((comparable / cheapestSupplierCost - 1) * 10_000) / 100;
    }
    simulation.menuImpacts = simulation.menuImpacts.map((item) => {
      const currentLine = this.hppCatalog.view().products.find((product) => product.id === item.productId)?.costLines?.find((line) => line.ingredientId === ingredientId);
      const baselineHppRupiah = item.currentBook.hppRupiah;
      const simulatedHppRupiah = item.referenceScenario.hppRupiah;
      return { ...item, baselineHppRupiah, simulatedHppRupiah, deltaHppRupiah: baselineHppRupiah == null || simulatedHppRupiah == null ? null : simulatedHppRupiah - baselineHppRupiah, deltaHppPct: baselineHppRupiah > 0 && simulatedHppRupiah != null ? Math.round((simulatedHppRupiah / baselineHppRupiah - 1) * 10_000) / 100 : null, baselineMarginPct: item.currentBook.marginPct, simulatedMarginPct: item.referenceScenario.marginPct, marginDeltaPp: item.currentBook.marginPct == null || item.referenceScenario.marginPct == null ? null : Math.round((item.referenceScenario.marginPct - item.currentBook.marginPct) * 100) / 100, ingredientEffectiveQuantity: currentLine?.qty ?? null, baselineUnitCost: currentLine?.unitCostRupiah ?? null };
    });
    const alerts = [];
    const chronologicalPrices = effectiveReferences.slice().sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.sequence - b.sequence);
    alerts.push(...monthlyReferencePriceIncreaseAlerts(chronologicalPrices));
    const changesByMonth = new Map();
    for (const item of chronologicalPrices) changesByMonth.set(jakartaMonth(item.effectiveAt), (changesByMonth.get(jakartaMonth(item.effectiveAt)) ?? 0) + 1);
    for (const [eventMonth, changeCount] of changesByMonth) if (changeCount >= 3) alerts.push({ type: "FREQUENT_CHANGES", severity: "INFO", month: eventMonth, changeCount });
    for (const impact of simulation.menuImpacts) {
      const target = costByProduct.get(impact.productId)?.targetMarginPct ?? null;
      const margin = impact.referenceScenario.marginPct;
      if (target !== null && margin !== null && margin < target) alerts.push({ type: "MARGIN_BELOW_TARGET", severity: "WARNING", productId: impact.productId, menuName: impact.menuName, marginPct: margin, targetMarginPct: target });
    }
    const pricedSuppliers = suppliers.filter((item) => item.latestUnitCostPerBaseUnitRupiah != null);
    const cheapest = pricedSuppliers.reduce((best, item) => best == null || item.latestUnitCostPerBaseUnitRupiah < best.latestUnitCostPerBaseUnitRupiah ? item : best, null);
    if (cheapest) for (const item of pricedSuppliers) if (item.latestUnitCostPerBaseUnitRupiah >= cheapest.latestUnitCostPerBaseUnitRupiah * 1.05) alerts.push({ type: "SUPPLIER_ABOVE_CHEAPEST", severity: "INFO", supplierName: item.supplierName, cheapestSupplierName: cheapest.supplierName, premiumPct: Math.round((item.latestUnitCostPerBaseUnitRupiah / cheapest.latestUnitCostPerBaseUnitRupiah - 1) * 10_000) / 100 });
    return structuredClone({ ingredient, filters: { month, supplier, source, availableSuppliers }, summary: { ...simulation.summary, eventCount: filteredHistory.length, alertCount: alerts.length }, history: historyPage.items, supplierComparison: suppliers, menuImpacts: simulation.menuImpacts, alerts, completeHistory: historyPage.nextCursor === null, page: { limit: historyPage.limit, nextCursor: historyPage.nextCursor, total: filteredHistory.length } });
  }

  fulfillmentQueue() {
    return [...this.fulfillments.values()]
      .filter((item) => !["COMPLETED", "CANCELLED"].includes(item.status))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((item) => structuredClone({ ...item, operationalStatus: operationalStatus(item) }));
  }

  #clearPrototypeOrders({ confirmation, reason, actorId } = {}) {
    if (confirmation !== "HAPUS ORDER UJI") throw domainError("prototype_clear_confirmation_required", 422);
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 160) throw domainError("prototype_clear_reason_required", 422);
    const prototypeOrderIds = new Set(this.orders.filter((item) => item.testMode === true).map((item) => item.id));
    if (!prototypeOrderIds.size) return { clearedOrders: 0, clearedQueueItems: 0, unchanged: true };
    const clearedQueueItems = [...prototypeOrderIds].filter((orderId) => this.fulfillments.has(orderId)).length;
    this.orders = this.orders.filter((item) => !prototypeOrderIds.has(item.id));
    this.orderItems = this.orderItems.filter((item) => !prototypeOrderIds.has(item.orderId));
    this.payments = this.payments.filter((item) => !prototypeOrderIds.has(item.orderId));
    for (const orderId of prototypeOrderIds) this.fulfillments.delete(orderId);
    for (const session of this.kioskSessions.values()) if (prototypeOrderIds.has(session.activeOrderId)) session.activeOrderId = null;
    for (const [key, orderId] of this.checkoutByKey) if (prototypeOrderIds.has(orderId)) this.checkoutByKey.delete(key);
    const clearedAt = this.clock().toISOString();
    this.#event("prototype.orders.cleared", { actorId, reason: reason.trim(), clearedOrders: prototypeOrderIds.size, clearedQueueItems });
    return { clearedOrders: prototypeOrderIds.size, clearedQueueItems, clearedAt };
  }

  advanceFulfillment(role, { orderId, target, station, reason } = {}) {
    if (!["bar", "owner"].includes(role)) throw domainError("fulfillment_role_denied", 403);
    const fulfillment = this.fulfillments.get(orderId);
    if (!fulfillment) throw domainError("fulfillment_not_found", 404);
    const next = transitionTicket(fulfillment, { target, station, reason }, this.clock().toISOString());
    const order = this.orders.find((item) => item.id === orderId);
    if (!next.idempotentReplay && !fulfillment.prepStartedAt && next.status === "IN_PROGRESS" && order) {
      const preparing = this.#consumePreparingOrder(order, next.prepStartedAt);
      if (order.testMode === true) next.phase3Simulation = preparing;
    }
    this.fulfillments.set(orderId, next);
    if (next.status === "COMPLETED" && order) order.status = "COMPLETED";
    if (!next.idempotentReplay) this.#event("fulfillment.status.changed", { orderId, target: next.status, action: next.action, operationalStatus: next.operationalStatus, station, role, reason: next.lastActionReason ?? null, remakeCount: next.remakeCount ?? 0 });
    return structuredClone(next);
  }

  dashboard(reportDate = businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone), { openingCountId, closingCountId, cashMovementLimit = 12 } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !Number.isFinite(Date.parse(reportDate)) || new Date(reportDate).toISOString().slice(0, 10) !== reportDate) throw domainError("report_date_invalid", 422);
    const businessOrders = this.orders.filter((item) => item.testMode !== true);
    const businessOrderIds = new Set(businessOrders.map((item) => item.id));
    const businessItems = this.orderItems.filter((item) => businessOrderIds.has(item.orderId));
    const businessPayments = this.payments.filter((item) => businessOrderIds.has(item.orderId));
    const paidSales = businessOrders.filter(order=>['PAID','COMPLETED'].includes(order.status) || (order.status === 'REFUNDED' && refundedSaleHasLedger(order,this.refunds)));
    const orders = paidSales.filter((item) => String(item.businessDate).slice(0, 10) === reportDate).map((item) => ({ ...item, status: "paid" }));
    const ids = new Set(orders.map((item) => item.id));
    const reportItems = this.orderItems.filter((item) => ids.has(item.orderId));
    const previousReportDate = addBusinessDays(reportDate, -1);
    const previousOrders = paidSales.filter((item) => String(item.businessDate).slice(0, 10) === previousReportDate);
    const previousIds = new Set(previousOrders.map((item) => item.id));
    const previousItems = this.orderItems.filter((item) => previousIds.has(item.orderId));
    const hppFullState = this.hppCatalog.exportState();
    const financialSummary = buildOwnerFinancialSummary({ orders: businessOrders, payments: businessPayments, orderItems: reportItems, refunds: this.refunds, hppState: hppFullState, businessDate: reportDate });
    const previousFinancialSummary = buildOwnerFinancialSummary({ orders: businessOrders, payments: businessPayments, orderItems: previousItems, refunds: this.refunds, hppState: hppFullState, businessDate: previousReportDate });
    const theoreticalIngredientUsage = buildTheoreticalIngredientUsage({ orders: orders.map(order=>({...order,status:'PAID'})), orderItems: reportItems, businessDate: reportDate });
    const varianceSelection = normalizeInventoryVarianceSelection({ openingCountId, closingCountId });
    let inventoryVariance;
    try {
      inventoryVariance = buildInventoryVarianceReport({ hppState: this.hppCatalog.exportState(), orders: businessOrders, orderItems: businessItems, ...varianceSelection });
    } catch (error) {
      if (["inventory_variance_count_not_found", "inventory_variance_period_invalid"].includes(error.message)) throw domainError(error.message, 422);
      throw error;
    }
    const hppState = this.hppCatalog.view();
    const accountsPayableAging = buildAccountsPayableAging({
      purchaseInvoices: hppFullState.purchaseInvoices,
      asOfBusinessDate: reportDate,
    });
    const inventoryMovements = inventoryReportMovements(hppState, SAGA_POS_ALPHA_CONTEXT.timezone).filter((item) => item.businessDate === reportDate);
    const cashControl = buildCashControlSummary({
      reportDate,
      cashShift: this.cashShift,
      cashMovements: this.cashMovements,
      expenses: this.expenses,
      cashMovementLimit,
      orders: businessOrders,
      payments: businessPayments,
      now: this.clock(),
    });
    const paymentSettlement = buildPaymentSettlementSummary({
      reportDate,
      orders,
      payments: businessPayments,
      now: this.clock(),
    });
    return { ...getLiveOwnerDashboard({
      orders,
      payments: businessPayments.filter((item) => ['PAID','REFUNDED'].includes(item.status) && ids.has(item.orderId)).map(item=>({...item,status:'PAID'})),
      orderItems: reportItems,
      inventoryMovements,
      now: this.clock().toISOString(),
    }), businessDate: reportDate, timezone: SAGA_POS_ALPHA_CONTEXT.timezone,
    financialSummary,
    cashControl,
    paymentSettlement,
    financeDailyClosingGate: buildFinanceDailyClosingGate({ financial: financialSummary, cashControl, paymentSettlement, inventoryVariance }),
    periodComparison: buildDashboardPeriodComparison({
      reportDate,
      currentOrders: orders,
      currentFinancialSummary: financialSummary,
      previousReportDate,
      previousOrders,
      previousFinancialSummary,
    }),
    trendComparison: buildDashboardTrendComparison({
      reportDate,
      orders: businessOrders.map(order=>paidSales.includes(order)?{...order,status:'PAID'}:order),
      payments: businessPayments.map(payment=>payment.status === 'REFUNDED' && paidSales.some(order=>order.id === payment.orderId)?{...payment,status:'PAID'}:payment),
      orderItems: businessItems,
    }),
    theoreticalIngredientUsage,
    inventoryVariance,
    workforce: buildWorkforceDashboardSummary({
      reportDate,
      now: this.clock().toISOString(),
      workforceState: this.workforceState,
      cashShift: this.cashShift,
    }),
    member: buildMemberDashboardSummary({
      reportDate,
      orders,
      orderItems: reportItems,
      catalog: this.catalogPricing.catalog("KIOSK"),
      rewardReservations: [...this.rewardReservations.values()],
    }),
    purchasing: {
      hppVersion: hppState.version,
      supplierCount: hppState.supplierCount,
      suppliers: hppState.suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name, leadTimeDays: supplier.leadTimeDays, active: supplier.active })),
      purchaseIngredients: hppState.ingredients.map((ingredient) => ({ id: ingredient.id, name: ingredient.name, baseUnit: ingredient.baseUnit })),
      purchaseOrderCount: hppState.purchaseOrderCount,
      openPurchaseOrderCount: hppState.purchaseOrders.filter((order) => ["OPEN", "PARTIALLY_RECEIVED"].includes(order.status)).length,
      recentPurchaseOrders: hppState.purchaseOrders.slice(0, 8).map((order) => ({
        supplierName: order.supplierNameSnapshot,
        expectedDate: order.expectedDate,
        totalOrderedRupiah: order.totalOrderedRupiah,
        lineCount: order.lineCount,
        revision: order.revision ?? 1,
        status: order.status,
      })),
      purchaseInvoiceCount: hppState.purchaseInvoiceCount,
      matchedInvoiceCount: hppState.purchaseInvoiceMatchedCount,
      blockedInvoiceCount: hppState.purchaseInvoices.filter((invoice) => invoice.matchStatus === "EXCEPTION").length,
      accountsPayableAging,
      readyForApprovalRupiah: hppState.purchaseInvoices.filter((invoice) => invoice.paymentReadiness === "READY_FOR_APPROVAL").reduce((sum, invoice) => sum + invoice.totalInvoiceRupiah, 0),
      readyForApprovalCount: hppState.purchaseInvoiceReadyCount,
      approvedNotPostedCount: hppState.purchaseInvoiceApprovedCount,
      postedUnpaidCount: hppState.purchaseInvoicePostedCount,
      openPayableRupiah: hppState.openPayableRupiah,
      paidPayableRupiah: hppState.paidPayableRupiah,
      purchaseInvoicePaymentCount: hppState.purchaseInvoicePaymentCount,
      pendingCreditCount: hppState.purchaseInvoiceCreditPendingCount,
      postedCreditCount: hppState.purchaseInvoiceCreditPostedCount,
      postedCreditRupiah: hppState.postedCreditRupiah,
      creditReversalPendingCount: hppState.purchaseInvoiceCreditReversalPendingCount,
      reversedCreditCount: hppState.purchaseInvoiceCreditReversedCount,
      supplierReturnCount: hppState.supplierReturnCount,
      supplierReturnAwaitingCreditCount: hppState.supplierReturnAwaitingCreditCount,
      supplierReturnCreditPendingPostCount: hppState.supplierReturnCreditPendingPostCount,
      supplierReturnAwaitingReplacementCount: hppState.supplierReturnAwaitingReplacementCount,
      supplierReturnOpenValueRupiah: hppState.supplierReturnOpenValueRupiah,
      recentInvoices: hppState.purchaseInvoices.slice(0, 8).map((invoice) => ({ invoiceNumber: invoice.invoiceNumber, supplierName: invoice.supplierNameSnapshot, invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate, daysUntilDue: invoice.payableEntry ? daysBetweenBusinessDates(reportDate, invoice.dueDate) : null, outstandingRupiah: invoice.payableEntry?.outstandingRupiah ?? 0, totalInvoiceRupiah: invoice.totalInvoiceRupiah, totalVarianceRupiah: invoice.totalVarianceRupiah, matchStatus: invoice.matchStatus, paymentReadiness: invoice.paymentReadiness })),
      recentPayments: hppState.purchaseInvoicePayments.slice(0, 8).map((payment) => {
        const invoice = hppState.purchaseInvoices.find((item) => item.id === payment.purchaseInvoiceId);
        return {
          reference: payment.reference,
          paidDate: payment.paidDate,
          method: payment.method,
          amountRupiah: payment.amountRupiah,
          supplierName: payment.supplierNameSnapshot,
          invoiceNumber: invoice?.invoiceNumber ?? "Invoice tidak ditemukan",
          status: payment.status,
          recordedAt: payment.recordedAt,
        };
      }),
      recentCredits: hppState.purchaseInvoiceCredits.slice(0, 8).map((credit) => { const latestReversal = credit.reversalHistory.at(-1); return { creditNoteNumber: credit.creditNoteNumber, supplierName: credit.supplierNameSnapshot, creditDate: credit.creditDate, amountRupiah: credit.amountRupiah, creditType: credit.creditType, status: credit.status, returnReference: credit.returnReferenceSnapshot, reversalStatus: latestReversal?.status ?? null, reversalReason: latestReversal?.decision?.reason ?? latestReversal?.requestReason ?? null }; }),
      recentSupplierReturns: hppState.supplierReturns.slice(0, 8).map((item) => ({ returnReference: item.returnReference, supplierName: item.supplierNameSnapshot, shippedAt: item.shippedAt, totalReturnValueRupiah: item.totalReturnValueRupiah, disposition: item.disposition, status: item.status, creditMemoId: item.creditMemoId })),
    },
    netSalesRupiah: financialSummary.menuSalesRupiah,
    billedSalesRupiah: financialSummary.totalRupiah,
    aovRupiah: financialSummary.menuSalesRupiah == null ? null : orders.length ? Math.round(financialSummary.menuSalesRupiah / orders.length) : 0,
    totalHppRupiah: financialSummary.cost.theoreticalHppRupiah,
    grossProfitRupiah: financialSummary.cost.grossProfitRupiah,
    grossMarginPct: Number.isSafeInteger(financialSummary.cost.grossProfitRupiah) && financialSummary.menuSalesRupiah > 0 ? Math.round((financialSummary.cost.grossProfitRupiah / financialSummary.menuSalesRupiah) * 10_000) / 100 : null,
    costStatus: financialSummary.cost.status,
    };
  }

  exportOwnerFinancialCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return ownerFinancialCsv(this.dashboard(reportDate).financialSummary);
  }

  exportSalesPeriodComparisonCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return salesPeriodComparisonCsv(this.dashboard(reportDate).periodComparison);
  }

  exportSalesTrendComparisonCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return salesTrendComparisonCsv(this.dashboard(reportDate).trendComparison);
  }

  exportCashControlCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return cashControlCsv(this.dashboard(reportDate, { cashMovementLimit: Infinity }).cashControl);
  }

  exportPaymentSettlementCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return paymentSettlementCsv(this.dashboard(reportDate).paymentSettlement);
  }

  exportTheoreticalIngredientUsageCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return theoreticalIngredientUsageCsv(this.dashboard(reportDate).theoreticalIngredientUsage);
  }

  exportInventoryVarianceCsv(role, selection = {}) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return inventoryVarianceCsv(this.dashboard(undefined, selection).inventoryVariance);
  }

  exportHppQualityCsv(role) {
    if (role !== "owner") throw domainError("owner_required", 403);
    return hppQualityCsv(this.inventoryWorkspaceState(role).hpp.quality);
  }

  exportSupplierPaymentsCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const effectiveDate = normalizeBusinessDate(reportDate || businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone));
    const state = this.hppCatalog.exportState();
    const invoices = new Map(state.purchaseInvoices.map((invoice) => [invoice.id, invoice]));
    const rows = [
      [
        "business_date",
        "reference",
        "supplier",
        "invoice_number",
        "paid_date",
        "method",
        "amount_rupiah",
        "current_invoice_outstanding_rupiah",
        "current_invoice_status",
        "recorded_by",
        "recorded_at",
        "status",
        "reason",
      ],
    ];
    for (const payment of state.purchaseInvoicePayments.filter((item) => item.paidDate === effectiveDate)) {
      const invoice = invoices.get(payment.purchaseInvoiceId);
      rows.push([
        effectiveDate,
        payment.reference,
        payment.supplierNameSnapshot,
        invoice?.invoiceNumber ?? "INVOICE_NOT_FOUND",
        payment.paidDate,
        payment.method,
        payment.amountRupiah,
        invoice?.payableEntry?.outstandingRupiah ?? "",
        invoice?.payableEntry?.status ?? invoice?.paymentReadiness ?? "UNKNOWN",
        payment.recordedByActorId,
        payment.recordedAt,
        payment.status,
        payment.reason,
      ]);
    }
    return rows.map((row) => row.map(csvSafeCell).join(",")).join("\r\n");
  }

  exportAccountsPayableAgingCsv(role, reportDate) {
    if (role !== "owner") throw domainError("owner_required", 403);
    const effectiveDate = normalizeBusinessDate(reportDate || businessDate(this.clock(), SAGA_POS_ALPHA_CONTEXT.timezone));
    const aging = buildAccountsPayableAging({
      purchaseInvoices: this.hppCatalog.exportState().purchaseInvoices,
      asOfBusinessDate: effectiveDate,
    });
    const rows = [
      ["as_of_business_date", "bucket", "supplier", "invoice_number", "invoice_date", "due_date", "days_until_due", "original_invoice_rupiah", "credited_rupiah", "paid_rupiah", "outstanding_rupiah", "status"],
      [effectiveDate, "SUMMARY_OVERDUE", "", "", "", "", "", "", "", "", aging.overdue.rupiah, `${aging.overdue.count} invoice`],
      [effectiveDate, "SUMMARY_DUE_TODAY", "", "", "", "", "", "", "", "", aging.dueToday.rupiah, `${aging.dueToday.count} invoice`],
      [effectiveDate, "SUMMARY_DUE_NEXT_7_DAYS", "", "", "", "", "", "", "", "", aging.dueNext7Days.rupiah, `${aging.dueNext7Days.count} invoice`],
      [effectiveDate, "SUMMARY_LATER", "", "", "", "", "", "", "", "", aging.later.rupiah, `${aging.later.count} invoice`],
    ];
    for (const row of aging.rows) {
      rows.push([
        effectiveDate,
        agingBucket(row.daysUntilDue),
        row.supplierName,
        row.invoiceNumber,
        row.invoiceDate,
        row.dueDate,
        row.daysUntilDue,
        row.amountRupiah,
        row.creditedRupiah,
        row.paidRupiah,
        row.outstandingRupiah,
        row.status,
      ]);
    }
    return rows.map((row) => row.map(csvSafeCell).join(",")).join("\r\n");
  }

  #ensureFulfillment(order) {
    const existing = this.fulfillments.get(order.id);
    if (existing) return existing;
    const items = this.orderItems.filter((item) => item.orderId === order.id);
    const printJob = this.printSpooler.create({
      orderId: order.id, orderNumber: order.orderNumber, destination: "BAR",
      payload: { orderNumber: order.orderNumber, items: items.map((item) => ({ name: item.productNameSnapshot, qty: item.qty, selections: item.selections ?? [], note: item.note ?? "" })) },
    });
    const fulfillment = {
      id: randomUUID(),
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: "NEW",
      channel: order.channel,
      orderType: order.orderType,
      tableId: order.tableId ?? null,
      tableLabel: order.tableLabel ?? null,
      demoSource: order.demoSource ?? null,
      testMode: order.testMode === true,
      createdAt: this.clock().toISOString(),
      paidAt: order.paidAt,
      items: items.map((item) => ({
        productId: item.productId,
        name: item.productNameSnapshot,
        qty: item.qty,
        station: item.stationSnapshot,
        selections: structuredClone(item.selections ?? []),
        note: item.note ?? "",
      })),
      printJob: { ...printJob, requiredForFulfillment: false },
    };
    this.fulfillments.set(order.id, fulfillment);
    this.#event("fulfillment.created", { orderId: order.id, fulfillmentId: fulfillment.id });
    return fulfillment;
  }

  #consumePreparingOrder(order, preparingAt) {
    if (order.testMode === true) return buildPhase3InventorySimulation({
      order,
      orderItems: this.orderItems.filter((item) => item.orderId === order.id),
      hpp: this.hppCatalog.view(),
      simulatedAt: preparingAt,
    });
    return this.hppCatalog.consumePreparingOrder({
      orderId: order.id,
      orderNumber: order.orderNumber,
      paidAt: order.paidAt,
      testMode: order.testMode === true,
      preparingAt,
      items: this.orderItems.filter((item) => item.orderId === order.id),
    });
  }

  #reserveConfirmedOrder(order, actorId, items = this.orderItems.filter((item) => item.orderId === order.id), { allowShortage = false } = {}) {
    return this.hppCatalog.reserveOrderInventory({
      orderId: order.id,
      orderNumber: order.orderNumber,
      reservedAt: order.paidAt ?? order.createdAt,
      actorId,
      items,
      allowShortage,
    });
  }

  #checkoutResponse(order) {
    const payment = this.#latestPaymentForOrder(order.id);
    const fulfillment = this.fulfillments.get(order.id);
    return {
      order: this.#safeOrder(order),
      payment: payment ? this.#safePayment(payment) : null,
      fulfillment: fulfillment ? structuredClone(fulfillment) : null,
      receipt: ["PAID", "COMPLETED"].includes(order.status)
        ? { orderNumber: order.orderNumber, totalRupiah: order.totalRupiah, method: payment?.methodNameSnapshot ?? "NONE", digital: true }
        : null,
    };
  }

  #latestPaymentForOrder(orderId) {
    for (let index = this.payments.length - 1; index >= 0; index -= 1) {
      if (this.payments[index].orderId === orderId) return this.payments[index];
    }
    return null;
  }

  #safeOrder(order) {
    return {
      ...structuredClone(order),
      refundHistory: this.refunds.filter(refund=>refund.orderId === order.id).map(refund=>({
        id:refund.id,createdAt:refund.createdAt,status:refund.status,
        amountRupiah:Number.isSafeInteger(refund.amountRupiah) && refund.amountRupiah >= 0 ? refund.amountRupiah : null,
        items:refund.items?.map(item=>({orderItemId:item.orderItemId,qty:item.qty,totalRupiah:item.totalRupiah})) ?? null,
      })),
      items: this.orderItems.filter((item) => item.orderId === order.id).map((item) => structuredClone(item)),
    };
  }

  #safePayment(payment) {
    return {
      id: payment.id,
      orderId: payment.orderId,
      methodNameSnapshot: payment.methodNameSnapshot,
      methodType: payment.methodType,
      amountRupiah: payment.amountRupiah,
      status: payment.status,
      settlementStatus: payment.settlementStatus,
      providerFeeRupiah: payment.providerFeeRupiah ?? null,
      netSettlementRupiah: payment.netSettlementRupiah ?? null,
      settlementReview: payment.settlementReview ? structuredClone(payment.settlementReview) : null,
      expiresAt: payment.expiresAt ?? null,
      receivedRupiah: payment.receivedRupiah ?? payment.amountRupiah,
      changeRupiah: payment.changeRupiah ?? 0,
      paidAt: payment.paidAt ?? null,
      qrPayload: payment.qrPayload ?? null,
      qrImageDataUrl: payment.qrImageDataUrl ?? null,
      checkoutUrl: payment.checkoutUrl ?? null,
      gatewayMode: payment.gatewayMode ?? null,
      simulator: payment.simulator === true || (payment.methodType === "qris_dynamic" && payment.provider !== "sagadev_gateway"),
      demoOnly: payment.demoOnly === true,
      attempt: payment.attempt ?? null,
      assistedCash: payment.assistedCash === true || (payment.methodType === "cash" && payment.status === "PENDING"),
      staticQrisDemo: payment.staticQrisDemo === true,
      staticQrisManual: payment.staticQrisManual === true,
      qrImageUrl: payment.staticQrisDemo === true || payment.staticQrisManual === true ? payment.qrImageUrl : null,
    };
  }

  #requireCashShift(actor) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw domainError("cashier_role_denied", 403);
    if (!this.cashShift || this.cashShift.status !== "open") throw domainError("cash_session_open_required", 409);
    if (actor.role !== "owner" && this.cashShift.openedByUserId !== actor.employeeId) throw domainError("shift_owned_by_other_staff", 403);
  }

  #commitReward(order) {
    if (!order.rewardId) return null;
    const existing = this.rewardReservations.get(order.id);
    if (existing) return existing;
    const reservation = { id: randomUUID(), orderId: order.id, rewardId: order.rewardId, status: "COMMITTED_LOCAL", committedAt: this.clock().toISOString() };
    this.rewardReservations.set(order.id, reservation);
    this.#event("reward.committed", { orderId: order.id, rewardId: order.rewardId });
    return reservation;
  }

  #promotionUsage() {
    const usage = Object.create(null);
    for (const order of this.orders) {
      // Pending/unknown reserves quota. Refunded vouchers stay used by policy.
      if (!order.promotionCode) continue;
      const payments=this.payments.filter(payment=>payment.orderId===order.id);
      if(!['PAID','COMPLETED','REFUNDED'].includes(order.status) && payments.length && payments.every(payment=>['CANCELLED','FAILED','EXPIRED'].includes(payment.status)))continue;
      usage[order.promotionCode] = (usage[order.promotionCode] ?? 0) + 1;
      const promotion=order.benefitSnapshot?.promotion;
      if(order.memberId && promotion?.id){const key=`member:${promotion.campaignId ?? promotion.id}:${order.memberId}`;usage[key]=(usage[key]??0)+1;}
    }
    return usage;
  }

  #reviewPaymentSettlement(actorId, {
    paymentId,
    decision,
    expectedStatus,
    providerFeeRupiah,
    netSettlementRupiah,
    evidenceReference,
    reason,
  } = {}) {
    const payment = this.payments.find((item) => item.id === paymentId);
    const order = payment ? this.orders.find((item) => item.id === payment.orderId) : null;
    if (!payment || !order) throw domainError("payment_not_found", 404);
    if (order.testMode === true) throw domainError("prototype_payment_settlement_denied", 409);
    if (payment.status !== "PAID") throw domainError("payment_not_paid", 409);
    if (["cash", "none"].includes(payment.methodType)) throw domainError("payment_settlement_not_applicable", 409);
    const normalizedDecision = String(decision ?? "").trim().toUpperCase();
    if (!["SETTLED", "ISSUE"].includes(normalizedDecision)) throw domainError("settlement_decision_invalid", 422);
    const normalizedExpected = String(expectedStatus ?? "").trim().toLowerCase();
    if (!normalizedExpected) throw domainError("settlement_expected_status_required", 422);
    const fee = Number(providerFeeRupiah);
    const net = Number(netSettlementRupiah);
    if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(net) || net < 0 || fee + net > payment.amountRupiah) {
      throw domainError("settlement_amount_invalid", 422);
    }
    const varianceRupiah = payment.amountRupiah - fee - net;
    if (normalizedDecision === "SETTLED" && varianceRupiah !== 0) throw domainError("settlement_balance_mismatch", 422);
    const evidence = String(evidenceReference ?? "").trim();
    const normalizedReason = String(reason ?? "").trim();
    if (evidence.length < 4 || evidence.length > 120) throw domainError("settlement_evidence_reference_invalid", 422);
    if (normalizedReason.length < 8 || normalizedReason.length > 300) throw domainError("settlement_reason_invalid", 422);
    const evidenceHash = createHash("sha256").update(evidence).digest("hex");
    const targetStatus = normalizedDecision === "SETTLED" ? "settled" : "issue";
    const sameReview = payment.settlementStatus === targetStatus
      && payment.providerFeeRupiah === fee
      && payment.netSettlementRupiah === net
      && payment.settlementReview?.evidenceHash === evidenceHash
      && payment.settlementReview?.reason === normalizedReason;
    if (sameReview) return { payment: this.#safePayment(payment), idempotentReplay: true };
    if (payment.settlementStatus !== normalizedExpected) throw domainError("settlement_status_conflict", 409);
    const reviewedAt = this.clock().toISOString();
    payment.settlementStatus = targetStatus;
    payment.providerFeeRupiah = fee;
    payment.netSettlementRupiah = net;
    payment.settlementReview = {
      decision: normalizedDecision,
      evidenceHash,
      reason: normalizedReason,
      reviewedAt,
      reviewedBy: actorId,
      varianceRupiah,
    };
    this.#event("payment.settlement.reviewed", {
      actorId,
      paymentId: payment.id,
      orderId: order.id,
      decision: normalizedDecision,
      providerFeeRupiah: fee,
      netSettlementRupiah: net,
      varianceRupiah,
      evidenceHash,
    });
    return { payment: this.#safePayment(payment), idempotentReplay: false };
  }

  #refundOrder(actorId, { orderId, reason, items, idempotencyKey, ...unsupported } = {}) {
    if(Object.keys(unsupported).length)throw domainError('partial_refund_not_available',409);
    if (!String(reason ?? "").trim()) throw domainError("refund_reason_required", 422);
    const order = this.orders.find((item) => item.id === orderId);
    if (!order) throw domainError("order_not_found", 404);
    const legacyPending=this.refunds.find(item=>item.orderId === orderId && item.status === 'PENDING_MANUAL_FINANCE_RECONCILIATION' && !item.operationKey);
    if (legacyPending && items === undefined && !idempotencyKey) {
      if (legacyPending.reason && legacyPending.reason !== String(reason).trim()) throw domainError('refund_retry_conflict',409);
      return {...structuredClone(legacyPending),idempotentReplay:true};
    }
    const plan=planCashierRefund({order,orderItems:this.orderItems.filter(item=>item.orderId === order.id),refunds:this.refunds,items,reason,idempotencyKey});
    if (plan.idempotentReplay) return plan;
    const pending = this.refunds.find(item => item.orderId === orderId && item.status === 'PENDING_MANUAL_FINANCE_RECONCILIATION');
    if (pending) {
      if (pending.reason !== String(reason).trim()) throw domainError('refund_retry_conflict',409);
      return {...structuredClone(pending),idempotentReplay:true};
    }
    const payment = this.payments.find((item) => item.orderId === order.id);
    if (items !== undefined && payment?.methodType !== 'cash') throw domainError('partial_refund_payment_not_available',409);
    const fulfillment = this.fulfillments.get(order.id);
    const refundAt = this.clock().toISOString();
    if (payment?.methodType === 'cash' && this.cashShift?.status !== 'open') throw domainError('cash_refund_open_session_required',409);
    if (plan.full) this.hppCatalog.releaseOrderInventory({ orderId, releasedAt: refundAt, reason: String(reason).trim(), actorId });
    if (plan.full && fulfillment && ["NEW", "IN_PROGRESS"].includes(fulfillment.status)) fulfillment.status = "CANCELLED";
    const gatewayRefund = ['qris_dynamic','qris_manual'].includes(payment?.methodType);
    if (!gatewayRefund && plan.full) {
      order.status = "REFUNDED";
      if (payment) payment.status = "REFUNDED";
    }
    const refund = {
      ...plan,id: randomUUID(), orderId,
      reason: String(reason).trim(), actorId,
      status: gatewayRefund ? "PENDING_MANUAL_FINANCE_RECONCILIATION" : "REFUNDED_LOCAL",
      provider: gatewayRefund ? (payment.methodType === 'qris_manual' ? 'merchant_qris_manual' : 'sagadev_gateway') : null,
      mutatesGatewayPayment: false,
      createdAt: refundAt,
    };
    this.refunds.push(refund);
    if (payment?.methodType === "cash") this.cashMovements.push({ id: refund.id, type: "REFUND", orderId, cashSessionId: this.cashShift.id, amountRupiah: -refund.amountRupiah, actorId, occurredAt: refund.createdAt });
    const reward = this.rewardReservations.get(order.id);
    if (reward && !gatewayRefund && plan.full) { reward.status = "REVERSED_LOCAL"; reward.reversedAt = refund.createdAt; }
    this.#event(gatewayRefund ? "order.refund.requested" : "order.refunded", { actorId, orderId, amountRupiah: refund.amountRupiah,full:plan.full });
    return structuredClone(refund);
  }

  #remakeOrder(actorId, { orderId, reason, idempotencyKey } = {}) {
    const normalizedReason = String(reason ?? "").trim();
    if (!normalizedReason) throw domainError("remake_reason_required", 422);
    const normalizedKey = idempotencyKey == null ? null : String(idempotencyKey).trim();
    if (normalizedKey !== null && !validRuntimeIdentifier(normalizedKey)) throw domainError("remake_queue_idempotency_key_invalid", 422);
    if (normalizedKey !== null) {
      const replay = this.remakes.find((item) => item.queueIdempotencyKey === normalizedKey);
      if (replay) {
        const fingerprint = remakeQueueFingerprint({ orderId, reason: normalizedReason, actorId });
        if (replay.queueFingerprint !== fingerprint) throw domainError("remake_queue_idempotency_conflict", 409);
        return { ...structuredClone(replay), idempotentReplay: true };
      }
    }
    const order = this.orders.find((item) => item.id === orderId);
    if (!order || !["PAID", "COMPLETED"].includes(order.status)) throw domainError("order_not_remakeable", 409);
    const remake = createRemakeQueueFact({
      id: randomUUID(), orderId, reason: normalizedReason, actorId,
      idempotencyKey: normalizedKey, createdAt: this.clock().toISOString(),
    });
    this.remakes.push(remake);
    this.#event("order.remake.queued", { actorId, orderId, remakeId: remake.id, idempotencyKey: remake.queueIdempotencyKey });
    return { ...structuredClone(remake), idempotentReplay: false };
  }

  #startRemake(actorId, { remakeId, productionStartId, idempotencyKey, reason } = {}) {
    if (!validRuntimeIdentifier(remakeId) || !validRuntimeIdentifier(productionStartId)
      || !validRuntimeIdentifier(idempotencyKey) || !String(reason ?? "").trim()) throw domainError("remake_start_input_invalid", 422);
    const prior = this.hppCatalog.exportState().saleConsumptions.find((item) => item.productionStartId === productionStartId
      || item.productionStartIdempotencyKey === idempotencyKey || item.remakeId === remakeId);
    const remake = this.remakes.find((item) => item.id === remakeId);
    if (!prior && !remake) throw domainError("remake_not_found", 404);
    if (!prior && remake.status !== "QUEUED_LOCAL") throw domainError("remake_start_state_conflict", 409);
    const order = this.orders.find((item) => item.id === (prior?.orderId ?? remake.orderId));
    if (!order || (!prior && !["PAID", "COMPLETED"].includes(order.status))) throw domainError("order_not_remakeable", 409);
    const startedAt = prior?.occurredAt ?? this.clock().toISOString();
    const result = this.hppCatalog.consumePreparingOrder({
      orderId: order.id,
      orderNumber: order.orderNumber,
      paidAt: order.paidAt,
      preparingAt: startedAt,
      productionStartId,
      idempotencyKey,
      consumptionReason: "REMAKE",
      remakeId,
      reason: String(reason).trim(),
      actorId,
      items: this.orderItems.filter((item) => item.orderId === order.id),
    });
    if (remake && !result.idempotentReplay) {
      remake.status = "IN_PROGRESS";
      remake.productionStartId = productionStartId;
      remake.productionStartIdempotencyKey = idempotencyKey;
      remake.startedAt = startedAt;
      remake.startedBy = actorId;
      remake.startReason = String(reason).trim();
      remake.consumptionId = result.consumption.id;
      this.#event("order.remake.started", { actorId, orderId: order.id, remakeId, productionStartId, consumptionId: result.consumption.id });
    }
    return {
      remakeId,
      productionStartId,
      consumptionId: result.consumption.id,
      startedAt: result.consumption.occurredAt,
      idempotentReplay: result.idempotentReplay,
    };
  }

  #integrationStatus() {
    return {
      qris: "SAGADEV_GATEWAY_LOCAL_SIMULATOR_PRODUCT_CONTRACT_LOCKED_SANDBOX_PENDING",
      member: "LOCAL_FIXTURE_EXTERNAL_CONTRACT_PENDING",
      reward: "LOCAL_FIXTURE_EXTERNAL_CONTRACT_PENDING",
      printer: "REQUIRED_FOR_PILOT_NOT_RUN_HARDWARE_UNAVAILABLE",
      nfc: "REQUIRED_FOR_PILOT_NOT_RUN_HARDWARE_UNAVAILABLE",
      persistence: this.persistenceStatus,
      staging: "NOT_AUTHORIZED_NOT_RUN",
      production: "NOT_AUTHORIZED_NOT_RUN",
    };
  }

  #requireKioskSession(sessionId) {
    const session = this.kioskSessions.get(sessionId);
    if (!session || session.status !== "ACTIVE") throw domainError("kiosk_session_required", 401);
    return session;
  }

  #safeKioskMemberContext(sessionId, catalog) {
    const context = this.kioskMemberContexts.get(sessionId);
    if (!context) return null;
    const { nfcStatus: _nfcStatus, ...safeContext } = context.publicContext;
    const available = new Set(catalog.flatMap((category) => category.products)
      .filter((product) => product.available !== false).map((product) => product.id));
    return structuredClone({ ...safeContext, recommendations: (context.recommendationCandidates ?? safeContext.recommendations).filter((item) => available.has(item.productId)) });
  }

  #event(type, payload) {
    this.events.push({ id: randomUUID(), type, payload: structuredClone(payload), occurredAt: this.clock().toISOString() });
  }
}

function assertExpectedCheckoutQuote(expected, current, now) {
  const fingerprint = String(expected?.fingerprint ?? "").trim();
  const catalogVersion = Number(expected?.catalogVersion);
  const totalRupiah = Number(expected?.totalRupiah);
  const expiresAt = Date.parse(String(expected?.expiresAt ?? ""));
  if (!/^[a-f0-9]{64}$/.test(fingerprint)
    || !Number.isInteger(catalogVersion)
    || !Number.isInteger(totalRupiah)
    || totalRupiah < 0
    || !Number.isFinite(expiresAt)) {
    throw domainError("checkout_quote_invalid", 422);
  }
  if (expiresAt <= now.getTime()) throw domainError("checkout_quote_expired", 409);
  if (fingerprint !== current.quoteFingerprint
    || catalogVersion !== current.catalogVersion
    || totalRupiah !== current.totalRupiah) {
    throw domainError("checkout_quote_changed", 409);
  }
}

function inventoryReportMovements(hpp, timezone) {
  const receipts = (hpp.purchaseReceipts ?? []).map((receipt) => ({ businessDate: businessDate(new Date(receipt.receivedAt), timezone), movementType: "purchase_received", valueDeltaRupiah: receipt.totalCostRupiah }));
  const supplierReturns = (hpp.supplierReturns ?? []).flatMap((item) => [
    { businessDate: businessDate(new Date(item.shippedAt), timezone), movementType: "supplier_return", valueDeltaRupiah: -item.totalReturnValueRupiah },
    ...(item.replacementReceipt ? [{ businessDate: businessDate(new Date(item.replacementReceipt.receivedAt), timezone), movementType: "supplier_replacement", valueDeltaRupiah: item.totalReturnValueRupiah }] : []),
  ]);
  const deductions = (hpp.inventoryMovements ?? []).filter((movement) => movement.movementType !== "CYCLE_COUNT").map((movement) => ({
    businessDate: businessDate(new Date(movement.occurredAt), timezone),
    movementType: movement.movementType === "SALE_CONSUMPTION" ? "sale_consumption" : "waste",
    valueDeltaRupiah: movement.inventoryValueDeltaRupiah,
  }));
  return [...receipts, ...supplierReturns, ...deductions];
}

function buildAccountsPayableAging({ purchaseInvoices = [], asOfBusinessDate }) {
  const rows = purchaseInvoices
    .filter((invoice) => invoice.paymentReadiness === "POSTED_UNPAID" && invoice.payableEntry?.outstandingRupiah > 0)
    .map((invoice) => ({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      supplierId: invoice.supplierId,
      supplierName: invoice.supplierNameSnapshot,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      amountRupiah: invoice.payableEntry.amountRupiah,
      creditedRupiah: invoice.payableEntry.creditedRupiah,
      paidRupiah: invoice.payableEntry.paidRupiah,
      outstandingRupiah: invoice.payableEntry.outstandingRupiah,
      daysUntilDue: daysBetweenBusinessDates(asOfBusinessDate, invoice.dueDate),
      status: invoice.payableEntry.status,
    }))
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.dueDate.localeCompare(b.dueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber, "id"));
  const bucket = (predicate) => rows.filter(predicate).reduce((summary, row) => ({
    count: summary.count + 1,
    rupiah: summary.rupiah + row.outstandingRupiah,
  }), { count: 0, rupiah: 0 });
  const overdue = bucket((row) => row.daysUntilDue < 0);
  const dueToday = bucket((row) => row.daysUntilDue === 0);
  const dueNext7Days = bucket((row) => row.daysUntilDue > 0 && row.daysUntilDue <= 7);
  const later = bucket((row) => row.daysUntilDue > 7);
  return {
    asOfBusinessDate,
    openCount: rows.length,
    openRupiah: rows.reduce((sum, row) => sum + row.outstandingRupiah, 0),
    overdue,
    dueToday,
    dueNext7Days,
    later,
    nextDueDate: rows[0]?.dueDate ?? null,
    oldestOverdueDays: rows.find((row) => row.daysUntilDue < 0)?.daysUntilDue ? Math.abs(rows.find((row) => row.daysUntilDue < 0).daysUntilDue) : 0,
    rows: rows.slice(0, 8),
  };
}

function defaultWorkforceState() {
  return {
    source: "SAGA_POS_SYNTHETIC_WORKFORCE_FIXTURE",
    integrationStatus: "SAGAWORK_BRIDGE_SYNTHETIC_VALIDATED_EXTERNAL_VAULT_PENDING",
    payrollActivationStatus: "PAYROLL_PAYOUT_OFF_OWNER_APPROVAL_REQUIRED",
    staffProfiles: [
      { id: "staff-ayu", fullName: "Ayu Prameswari", role: "Barista", status: "active", pinHash: "pin:1101" },
      { id: "staff-bima", fullName: "Bima Raka", role: "Kitchen Prep", status: "active", pinHash: "pin:1102" },
      { id: "staff-citra", fullName: "Citra Lestari", role: "Kasir", status: "active", pinHash: "pin:1103" },
      { id: "staff-doni", fullName: "Doni Mahendra", role: "Runner", status: "active", pinHash: "pin:1104" },
    ],
    dailyPlan: [
      { id: "opening-bar", staffId: "staff-ayu", shiftName: "Opening bar", startTime: "07:00", endTime: "15:00", rateType: "per_shift", rateAmountRupiah: 95000 },
      { id: "prep-stock", staffId: "staff-bima", shiftName: "Prep & stok", startTime: "08:00", endTime: "16:00", rateType: "per_shift", rateAmountRupiah: 90000 },
      { id: "cashier-mid", staffId: "staff-citra", shiftName: "Kasir mid", startTime: "10:00", endTime: "18:00", rateType: "per_shift", rateAmountRupiah: 90000 },
    ],
    attendancePlan: [
      { staffId: "staff-ayu", shiftPlanId: "opening-bar", checkInTime: "06:58", checkOutTime: null, status: "present", lateMinutes: 0 },
      { staffId: "staff-bima", shiftPlanId: "prep-stock", checkInTime: "08:11", checkOutTime: null, status: "late", lateMinutes: 11 },
    ],
    openRequests: [
      { type: "leave", label: "Cuti menunggu keputusan", count: 1 },
      { type: "swap", label: "Tukar shift menunggu keputusan", count: 1 },
    ],
  };
}

function buildWorkforceDashboardSummary({ reportDate, now, workforceState, cashShift }) {
  const schedules = workforceState.dailyPlan.map((plan) => {
    const scheduledStartAt = `${reportDate}T${plan.startTime}:00.000Z`;
    const scheduledEndAt = `${reportDate}T${plan.endTime}:00.000Z`;
    return {
      id: `schedule-${reportDate}-${plan.id}`,
      organizationId: SAGA_POS_ALPHA_CONTEXT.organizationId,
      outletId: SAGA_POS_ALPHA_CONTEXT.outletId,
      businessDate: reportDate,
      staffId: plan.staffId,
      shiftTemplateId: plan.id,
      shiftName: plan.shiftName,
      scheduledStartAt,
      scheduledEndAt,
      gracePeriodMinutes: 5,
      rateType: plan.rateType,
      rateAmountRupiah: plan.rateAmountRupiah,
      status: "scheduled",
    };
  });
  const attendanceLogs = workforceState.attendancePlan.map((plan) => {
    const schedule = schedules.find((item) => item.staffId === plan.staffId && item.shiftTemplateId === plan.shiftPlanId);
    return {
      id: `attendance-${reportDate}-${plan.shiftPlanId}`,
      organizationId: SAGA_POS_ALPHA_CONTEXT.organizationId,
      outletId: SAGA_POS_ALPHA_CONTEXT.outletId,
      staffId: plan.staffId,
      businessDate: reportDate,
      shiftScheduleId: schedule?.id ?? null,
      checkInAt: `${reportDate}T${plan.checkInTime}:00.000Z`,
      checkOutAt: plan.checkOutTime ? `${reportDate}T${plan.checkOutTime}:00.000Z` : null,
      status: plan.status,
      lateMinutes: plan.lateMinutes,
      workedMinutes: plan.checkOutTime ? minutesBetweenTimes(plan.checkInTime, plan.checkOutTime) : 0,
      earlyLeaveMinutes: 0,
      overtimeCandidateMinutes: 0,
    };
  });
  const payroll = generatePayrollReadyReport({
    periodStart: reportDate,
    periodEnd: reportDate,
    staffProfiles: workforceState.staffProfiles,
    schedules,
    attendanceLogs,
    payrollAdjustments: [],
    lateDeductionPerMinuteRupiah: 500,
  });
  const absentCount = schedules.filter((schedule) => !attendanceLogs.some((log) => log.shiftScheduleId === schedule.id)).length;
  const requestCount = workforceState.openRequests.reduce((sum, item) => sum + item.count, 0);
  return {
    source: workforceState.source,
    integrationStatus: workforceState.integrationStatus,
    payrollActivationStatus: workforceState.payrollActivationStatus,
    activeStaffCount: workforceState.staffProfiles.filter((profile) => profile.status === "active").length,
    scheduledTodayCount: schedules.length,
    presentTodayCount: payroll.summary.totalPresent,
    lateTodayCount: payroll.summary.totalLate,
    absentTodayCount: Math.max(0, absentCount),
    incompleteAttendanceCount: payroll.summary.totalIncomplete,
    unscheduledAttendanceCount: payroll.summary.totalUnscheduled,
    openRequestCount: requestCount,
    estimatedPayableRupiah: payroll.summary.estimatedPayableRupiah,
    cashierShiftLinked: cashShift?.status === "open",
    generatedAt: now,
    openRequests: structuredClone(workforceState.openRequests),
    roster: schedules.slice(0, 6).map((schedule) => {
      const staff = workforceState.staffProfiles.find((profile) => profile.id === schedule.staffId);
      const attendance = attendanceLogs.find((log) => log.shiftScheduleId === schedule.id);
      return {
        staffName: staff?.fullName ?? "Staf tidak dikenal",
        role: staff?.role ?? "Staff",
        shiftName: schedule.shiftName,
        time: `${schedule.scheduledStartAt.slice(11, 16)}-${schedule.scheduledEndAt.slice(11, 16)}`,
        attendanceStatus: attendance?.status ?? "scheduled",
        lateMinutes: attendance?.lateMinutes ?? 0,
      };
    }),
    payrollRows: payroll.rows.slice(0, 6).map((row) => ({
      staffName: row.fullName,
      role: row.role,
      scheduled: row.totalScheduledShifts,
      present: row.totalPresent,
      late: row.totalLate,
      incomplete: row.totalIncomplete,
      estimatedPayableRupiah: row.estimatedPayableRupiah,
    })),
  };
}

function minutesBetweenTimes(startTime, endTime) {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return Math.max(0, (endHour * 60 + endMinute) - (startHour * 60 + startMinute));
}

function buildMemberDashboardSummary({ reportDate, orders, orderItems, catalog, rewardReservations }) {
  const products = new Map(catalog.flatMap((category) => category.products.map((product) => [product.id, product])));
  const memberOrders = orders.filter((order) => order.memberId);
  const memberOrderIds = new Set(memberOrders.map((order) => order.id));
  const memberItems = orderItems.filter((item) => memberOrderIds.has(item.orderId));
  const topProducts = [...memberItems.reduce((byProduct, item) => {
    const current = byProduct.get(item.productId) ?? { productId: item.productId, name: item.productNameSnapshot, qty: 0, salesRupiah: 0 };
    current.qty += item.qty;
    current.salesRupiah += item.lineTotalRupiah;
    byProduct.set(item.productId, current);
    return byProduct;
  }, new Map()).values()].sort((a, b) => b.qty - a.qty || b.salesRupiah - a.salesRupiah || a.name.localeCompare(b.name, "id")).slice(0, 5);
  const reservationsByOrder = new Map(rewardReservations.map((reward) => [reward.orderId, reward]));
  const rewardCommittedCount = memberOrders.filter((order) => reservationsByOrder.get(order.id)?.status === "COMMITTED_LOCAL").length;
  const rewardReversedCount = memberOrders.filter((order) => reservationsByOrder.get(order.id)?.status === "REVERSED_LOCAL").length;
  const recommendations = PROVISIONAL_PILOT_POLICY.memberFixture.recommendations.map((item) => {
    const product = products.get(item.productId);
    return {
      productId: item.productId,
      productName: product?.name ?? item.productId,
      reason: item.reason,
      available: Boolean(product && product.available !== false),
      priceRupiah: product?.priceRupiah ?? null,
    };
  });
  return {
    source: "LOCAL_AGGREGATE_ONLY_NO_RAW_MEMBER_PII",
    externalStatus: "CUSTOMER_PLATFORM_EXTERNAL_CONTRACT_PENDING",
    reportDate,
    maskedFixtureCode: PROVISIONAL_PILOT_POLICY.memberFixture.codeMasked,
    activeFixtureTier: PROVISIONAL_PILOT_POLICY.memberFixture.tier,
    identifiedOrderCount: memberOrders.length,
    identifiedSalesRupiah: memberOrders.reduce((sum, order) => sum + order.totalRupiah, 0),
    memberDiscountRupiah: memberOrders.reduce((sum, order) => sum + (order.discountRupiah ?? 0), 0),
    rewardCommittedCount,
    rewardReversedCount,
    promotionOrderCount: memberOrders.filter((order) => order.promotionCode).length,
    availableRecommendationCount: recommendations.filter((item) => item.available).length,
    recommendationCount: recommendations.length,
    recommendations,
    topProducts,
    privacyRules: [
      "Dashboard hanya menampilkan agregat dan kode masked.",
      "Nomor telepon, kode mentah, token, dan profil pelanggan tidak dirender.",
      "Reward/promo eksternal tetap pending sampai Customer Platform UAT.",
    ],
  };
}

function buildDashboardPeriodComparison({ reportDate, currentOrders, currentFinancialSummary, previousReportDate, previousOrders, previousFinancialSummary }) {
  const current = periodComparisonPoint(currentOrders, currentFinancialSummary);
  const previous = periodComparisonPoint(previousOrders, previousFinancialSummary);
  return {
    basis: "PREVIOUS_BUSINESS_DAY",
    reportDate,
    previousReportDate,
    status: previous.orderCount > 0 ? "COMPARABLE" : "NO_PREVIOUS_DAY_PAID_ORDERS",
    current,
    previous,
    delta: {
      orderCount: current.orderCount - previous.orderCount,
      menuSalesRupiah: safeDelta(current.menuSalesRupiah, previous.menuSalesRupiah),
      aovRupiah: safeDelta(current.aovRupiah, previous.aovRupiah),
      grossProfitRupiah: safeDelta(current.grossProfitRupiah, previous.grossProfitRupiah),
      menuSalesPct: safePctDelta(current.menuSalesRupiah, previous.menuSalesRupiah),
      orderPct: safePctDelta(current.orderCount, previous.orderCount),
    },
  };
}

function buildCashControlSummary({ reportDate, cashShift, cashMovements, expenses = [], cashMovementLimit = 12, orders = [], payments = [], now = new Date() }) {
  const shiftMatchesDate = cashShift && String(cashShift.businessDate).slice(0, 10) === reportDate;
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const pendingAssists = payments
    .filter((payment) => payment.methodType === "cash" && payment.assistedCash === true && payment.status === "PENDING")
    .map((payment) => ({ payment, order: ordersById.get(payment.orderId) }))
    .filter(({ order }) => order && order.testMode !== true && String(order.businessDate).slice(0, 10) === reportDate)
    .map(({ payment, order }) => ({
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountRupiah: payment.amountRupiah,
      declaredReceivedRupiah: payment.receivedRupiah,
      expectedChangeRupiah: payment.changeRupiah,
      createdAt: order.createdAt,
      ageMinutes: Math.max(0, Math.floor((now.getTime() - new Date(order.createdAt).getTime()) / 60_000)),
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const movements = cashMovements
    .filter((movement) => ordersById.has(movement.orderId) && businessDate(new Date(movement.occurredAt), SAGA_POS_ALPHA_CONTEXT.timezone) === reportDate)
    .map((movement) => ({
      occurredAt: movement.occurredAt,
      type: movement.type,
      orderId: movement.orderId ?? null,
      cashSessionId: movement.cashSessionId ?? ordersById.get(movement.orderId)?.cashSessionId,
      amountRupiah: movement.amountRupiah,
      actorId: movement.actorId,
    }))
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
  const cashSalesRupiah = movements.filter((movement) => movement.type === "SALE").reduce((sum, movement) => sum + movement.amountRupiah, 0);
  const cashRefundsRupiah = Math.abs(movements.filter((movement) => movement.type === "REFUND").reduce((sum, movement) => sum + movement.amountRupiah, 0));
  const shiftMovements = shiftMatchesDate ? cashMovements.filter(m => ordersById.has(m.orderId) && (m.cashSessionId ?? ordersById.get(m.orderId)?.cashSessionId) === cashShift.id) : [];
  const recordedExpenses = expenses.filter(e => e.status === 'recorded' && businessDate(new Date(e.createdAt), SAGA_POS_ALPHA_CONTEXT.timezone) === reportDate);
  const shiftExpenses = expenses.filter(e => e.status === 'recorded' && e.cashSessionId === cashShift?.id);
  const shiftExpenseRupiah = shiftExpenses.filter(e => e.source === 'cash_drawer').reduce((n,e) => n+e.amountRupiah,0);
  const shiftCashSalesRupiah = shiftMovements.filter(movement => movement.type === 'SALE').reduce((sum, movement) => sum + movement.amountRupiah, 0);
  const shiftCashRefundsRupiah = Math.abs(shiftMovements.filter(movement => movement.type === 'REFUND').reduce((sum, movement) => sum + movement.amountRupiah, 0));
  const openingCashRupiah = shiftMatchesDate ? cashShift.openingCashRupiah : 0;
  const expectedCashRupiah = shiftMatchesDate && cashShift.status === "closed" ? cashShift.expectedCashRupiah : openingCashRupiah + shiftCashSalesRupiah - shiftCashRefundsRupiah - shiftExpenseRupiah;
  const actualCashRupiah = shiftMatchesDate && cashShift.status === "closed" ? cashShift.actualCashRupiah : null;
  const varianceRupiah = shiftMatchesDate && cashShift.status === "closed" ? cashShift.varianceRupiah : null;
  const status = pendingAssists.length
    ? "PENDING_ASSISTANCE_REQUIRED"
    : !shiftMatchesDate
      ? "NO_CASH_SESSION"
      : cashShift.status === "open"
        ? "OPEN_SHIFT_COUNT_REQUIRED"
        : varianceRupiah === 0
          ? "CLOSED_MATCHED"
          : "CLOSED_VARIANCE_REVIEW";
  return {
    version: 1,
    reportDate,
    basis: "POS_CASH_SESSION_AND_CASH_MOVEMENTS",
    status,
    shift: shiftMatchesDate ? {
      id: cashShift.id,
      shiftName: cashShift.shiftName,
      openedByUserId: cashShift.openedByUserId,
      openedAt: cashShift.openedAt,
      closedByUserId: cashShift.closedByUserId ?? null,
      closedAt: cashShift.closedAt ?? null,
      status: cashShift.status,
      openingVarianceRupiah: cashShift.openingVarianceRupiah ?? 0,
      handoverStatus: cashShift.handoverStatus ?? "not_required",
    } : null,
    openingCashRupiah,
    cashSalesRupiah,
    cashRefundsRupiah,
    shiftExpenseRupiah,
    totalExpenseRupiah: recordedExpenses.reduce((n,e) => n+e.amountRupiah,0),
    nonCashExpenseRupiah: shiftExpenses.filter(e => e.source !== 'cash_drawer').reduce((n,e) => n+e.amountRupiah,0),
    shiftCashSalesRupiah: shiftMatchesDate ? shiftCashSalesRupiah : null,
    shiftCashRefundsRupiah: shiftMatchesDate ? shiftCashRefundsRupiah : null,
    expectedCashRupiah,
    actualCashRupiah,
    varianceRupiah,
    cashToLeaveRupiah: shiftMatchesDate && cashShift.status === "closed" ? cashShift.cashToLeaveRupiah : null,
    depositCashRupiah: shiftMatchesDate && cashShift.status === "closed" ? cashShift.depositCashRupiah : null,
    movementCount: movements.length,
    movements: movements.slice(0, cashMovementLimit),
    pendingAssistCount: pendingAssists.length,
    pendingAssistRupiah: pendingAssists.reduce((sum, item) => sum + item.amountRupiah, 0),
    oldestPendingAssistMinutes: pendingAssists[0]?.ageMinutes ?? null,
    pendingAssists: pendingAssists.slice(0, 12),
    warnings: [
      ...(!shiftMatchesDate ? ["Belum ada shift kas untuk tanggal bisnis ini."] : []),
      ...(shiftMatchesDate && movements.length > shiftMovements.length ? ['Sebagian pergerakan kas hari ini berada di luar shift terakhir. Ringkasan shift bukan total kas seluruh hari; periksa rincian harian.'] : []),
      ...(pendingAssists.length ? [`${pendingAssists.length} pembayaran tunai kiosk masih menunggu penerimaan fisik oleh kasir.`] : []),
      ...(shiftMatchesDate && cashShift.status === "open" ? ["Hitung fisik belum masuk; expected cash belum final."] : []),
      ...(varianceRupiah ? ["Variance kas perlu review sebelum closing final."] : []),
    ],
  };
}

function buildPaymentSettlementSummary({ reportDate, orders, payments, now }) {
  const ids = new Set(orders.filter((order) => ["PAID", "COMPLETED", "paid", "pending_sync"].includes(order.status)).map((order) => order.id));
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const reportPayments = payments
    .filter((payment) => payment.status === "PAID" && ids.has(payment.orderId))
    .map((payment) => {
      const order = ordersById.get(payment.orderId);
      const paidAt = payment.paidAt ?? order?.paidAt ?? order?.createdAt ?? null;
      const ageMinutes = paidAt ? Math.max(0, Math.floor((now.getTime() - new Date(paidAt).getTime()) / 60_000)) : null;
      return {
        orderNumber: order?.orderNumber ?? "ORDER_NOT_FOUND",
        orderId: payment.orderId,
        paymentId: payment.id,
        methodName: payment.methodNameSnapshot ?? payment.methodType,
        methodType: payment.methodType,
        amountRupiah: payment.amountRupiah,
        status: payment.status,
        settlementStatus: payment.methodType === "cash" ? "cash_drawer" : payment.settlementStatus ?? "unchecked",
        paidAt,
        ageMinutes,
        evidenceRef: shortEvidenceReference(payment.id),
        providerFeeRupiah: payment.providerFeeRupiah ?? null,
        netSettlementRupiah: payment.netSettlementRupiah ?? null,
        settlementVarianceRupiah: payment.settlementReview?.varianceRupiah ?? null,
        settlementReviewedAt: payment.settlementReview?.reviewedAt ?? null,
        settlementReviewedBy: payment.settlementReview?.reviewedBy ?? null,
        settlementEvidenceHash: payment.settlementReview?.evidenceHash ?? null,
      };
    })
    .sort((a, b) => String(b.paidAt ?? "").localeCompare(String(a.paidAt ?? "")));
  const methods = Object.values(reportPayments.reduce((acc, payment) => {
    const key = payment.methodName;
    acc[key] ??= {
      methodName: payment.methodName,
      methodType: payment.methodType,
      count: 0,
      totalRupiah: 0,
      settledCount: 0,
      settledRupiah: 0,
      uncheckedCount: 0,
      uncheckedRupiah: 0,
      issueCount: 0,
      issueRupiah: 0,
      cashDrawerCount: 0,
      cashDrawerRupiah: 0,
      oldestUnsettledMinutes: null,
    };
    acc[key].count += 1;
    acc[key].totalRupiah += payment.amountRupiah;
    if (payment.settlementStatus === "cash_drawer") {
      acc[key].cashDrawerCount += 1;
      acc[key].cashDrawerRupiah += payment.amountRupiah;
    } else if (payment.settlementStatus === "settled" || payment.settlementStatus === "not_applicable") {
      acc[key].settledCount += 1;
      acc[key].settledRupiah += payment.amountRupiah;
    } else if (payment.settlementStatus === "issue") {
      acc[key].issueCount += 1;
      acc[key].issueRupiah += payment.amountRupiah;
      acc[key].oldestUnsettledMinutes = Math.max(acc[key].oldestUnsettledMinutes ?? 0, payment.ageMinutes ?? 0);
    } else {
      acc[key].uncheckedCount += 1;
      acc[key].uncheckedRupiah += payment.amountRupiah;
      acc[key].oldestUnsettledMinutes = Math.max(acc[key].oldestUnsettledMinutes ?? 0, payment.ageMinutes ?? 0);
    }
    return acc;
  }, {})).sort((a, b) => b.uncheckedRupiah + b.issueRupiah - (a.uncheckedRupiah + a.issueRupiah) || b.totalRupiah - a.totalRupiah);
  const uncheckedCount = methods.reduce((sum, method) => sum + method.uncheckedCount, 0);
  const uncheckedRupiah = methods.reduce((sum, method) => sum + method.uncheckedRupiah, 0);
  const issueCount = methods.reduce((sum, method) => sum + method.issueCount, 0);
  const issueRupiah = methods.reduce((sum, method) => sum + method.issueRupiah, 0);
  const oldestUnsettledMinutes = methods.reduce((oldest, method) => Math.max(oldest, method.oldestUnsettledMinutes ?? 0), 0) || null;
  const status = issueCount ? "SETTLEMENT_ISSUE_REVIEW" : uncheckedCount ? "SETTLEMENT_REQUIRED" : "READY_FOR_CLOSING";
  return {
    version: 1,
    reportDate,
    basis: "PAID_PAYMENT_BY_ORDER_BUSINESS_DATE",
    status,
    totalPaymentCount: reportPayments.length,
    totalRupiah: reportPayments.reduce((sum, payment) => sum + payment.amountRupiah, 0),
    uncheckedCount,
    uncheckedRupiah,
    issueCount,
    issueRupiah,
    oldestUnsettledMinutes,
    methods,
    payments: reportPayments.slice(0, 12),
    warnings: [
      ...(uncheckedCount ? [`${uncheckedCount} payment non-cash belum dicocokkan ke settlement provider atau bank.`] : []),
      ...(issueCount ? [`${issueCount} payment punya status issue dan perlu review finance.`] : []),
      ...(methods.some((method) => method.cashDrawerCount) ? ["Cash diselesaikan melalui cash drawer control, bukan settlement bank."] : []),
    ],
  };
}

function buildDashboardTrendComparison({ reportDate, orders, payments, orderItems }) {
  return [
    buildDashboardRangeComparison({
      basis: "WEEK_TO_DATE",
      label: "Minggu berjalan",
      reportDate,
      currentStartDate: startOfBusinessWeek(reportDate),
      currentEndDate: reportDate,
      orders,
      payments,
      orderItems,
    }),
    buildDashboardRangeComparison({
      basis: "MONTH_TO_DATE",
      label: "Bulan berjalan",
      reportDate,
      currentStartDate: `${reportDate.slice(0, 8)}01`,
      currentEndDate: reportDate,
      orders,
      payments,
      orderItems,
    }),
  ];
}

function buildDashboardRangeComparison({ basis, label, reportDate, currentStartDate, currentEndDate, orders, payments, orderItems }) {
  const dayCount = daysBetweenBusinessDates(currentStartDate, currentEndDate) + 1;
  const previousStartDate = addBusinessDays(currentStartDate, -dayCount);
  const previousEndDate = addBusinessDays(currentStartDate, -1);
  const current = financialRangePoint({ orders, payments, orderItems, startDate: currentStartDate, endDate: currentEndDate });
  const previous = financialRangePoint({ orders, payments, orderItems, startDate: previousStartDate, endDate: previousEndDate });
  return {
    basis,
    label,
    reportDate,
    currentStartDate,
    currentEndDate,
    previousStartDate,
    previousEndDate,
    dayCount,
    status: previous.orderCount > 0 ? "COMPARABLE" : "NO_PREVIOUS_PERIOD_PAID_ORDERS",
    current,
    previous,
    delta: {
      orderCount: current.orderCount - previous.orderCount,
      menuSalesRupiah: safeDelta(current.menuSalesRupiah, previous.menuSalesRupiah),
      aovRupiah: safeDelta(current.aovRupiah, previous.aovRupiah),
      grossProfitRupiah: safeDelta(current.grossProfitRupiah, previous.grossProfitRupiah),
      menuSalesPct: safePctDelta(current.menuSalesRupiah, previous.menuSalesRupiah),
      orderPct: safePctDelta(current.orderCount, previous.orderCount),
    },
  };
}

function financialRangePoint({ orders, payments, orderItems, startDate, endDate }) {
  const summaries = businessDateRange(startDate, endDate).map((date) => {
    const dayOrders = orders.filter((item) => String(item.businessDate).slice(0, 10) === date && ["PAID", "COMPLETED"].includes(item.status));
    const dayOrderIds = new Set(dayOrders.map((item) => item.id));
    return buildOwnerFinancialSummary({
      orders,
      payments,
      orderItems: orderItems.filter((item) => dayOrderIds.has(item.orderId)),
      businessDate: date,
    });
  });
  const orderCount = summaries.reduce((sum, item) => sum + item.orderCount, 0);
  const menuSalesRupiah = summaries.reduce((sum, item) => sum + (Number.isSafeInteger(item.menuSalesRupiah) ? item.menuSalesRupiah : 0), 0);
  const salesSummaries = summaries.filter((item) => item.orderCount > 0);
  const allCostVerified = salesSummaries.length > 0 && salesSummaries.every((item) => item.cost.status === "VERIFIED");
  const anyCostVerified = salesSummaries.some((item) => item.cost.verifiedOrderCount > 0);
  const grossProfitRupiah = allCostVerified ? salesSummaries.reduce((sum, item) => sum + item.cost.grossProfitRupiah, 0) : null;
  return {
    startDate,
    endDate,
    orderCount,
    menuSalesRupiah,
    aovRupiah: orderCount ? Math.round(menuSalesRupiah / orderCount) : 0,
    grossProfitRupiah,
    costStatus: !orderCount ? "NO_SALES" : allCostVerified ? "VERIFIED" : anyCostVerified ? "PARTIAL" : "INCOMPLETE",
  };
}

function businessDateRange(startDate, endDate) {
  const days = [];
  for (let date = startDate; daysBetweenBusinessDates(date, endDate) >= 0; date = addBusinessDays(date, 1)) days.push(date);
  return days;
}

function startOfBusinessWeek(reportDate) {
  const date = new Date(`${reportDate}T00:00:00.000Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function salesPeriodComparisonCsv(comparison) {
  const rows = [
    ["report_date", "previous_report_date", "basis", "status", "metric", "current", "previous", "delta", "delta_pct", "cost_status"],
  ];
  const metricRows = [
    ["menu_sales_rupiah", comparison.current.menuSalesRupiah, comparison.previous.menuSalesRupiah, comparison.delta.menuSalesRupiah, comparison.delta.menuSalesPct, ""],
    ["order_count", comparison.current.orderCount, comparison.previous.orderCount, comparison.delta.orderCount, comparison.delta.orderPct, ""],
    ["aov_rupiah", comparison.current.aovRupiah, comparison.previous.aovRupiah, comparison.delta.aovRupiah, "", ""],
    ["theoretical_gross_profit_rupiah", comparison.current.grossProfitRupiah, comparison.previous.grossProfitRupiah, comparison.delta.grossProfitRupiah, "", comparison.current.costStatus],
  ];
  for (const [metricName, current, previous, delta, pct, costStatus] of metricRows) {
    rows.push([
      comparison.reportDate,
      comparison.previousReportDate,
      comparison.basis,
      comparison.status,
      metricName,
      csvNumber(current),
      csvNumber(previous),
      csvNumber(delta),
      pct === "" ? "" : csvNumber(pct),
      costStatus,
    ]);
  }
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function salesTrendComparisonCsv(comparisons) {
  const rows = [
    ["report_date", "basis", "label", "current_start_date", "current_end_date", "previous_start_date", "previous_end_date", "day_count", "status", "metric", "current", "previous", "delta", "delta_pct", "cost_status"],
  ];
  for (const comparison of comparisons) {
    const metricRows = [
      ["menu_sales_rupiah", comparison.current.menuSalesRupiah, comparison.previous.menuSalesRupiah, comparison.delta.menuSalesRupiah, comparison.delta.menuSalesPct, ""],
      ["order_count", comparison.current.orderCount, comparison.previous.orderCount, comparison.delta.orderCount, comparison.delta.orderPct, ""],
      ["aov_rupiah", comparison.current.aovRupiah, comparison.previous.aovRupiah, comparison.delta.aovRupiah, "", ""],
      ["theoretical_gross_profit_rupiah", comparison.current.grossProfitRupiah, comparison.previous.grossProfitRupiah, comparison.delta.grossProfitRupiah, "", comparison.current.costStatus],
    ];
    for (const [metricName, current, previous, delta, pct, costStatus] of metricRows) {
      rows.push([
        comparison.reportDate,
        comparison.basis,
        comparison.label,
        comparison.currentStartDate,
        comparison.currentEndDate,
        comparison.previousStartDate,
        comparison.previousEndDate,
        comparison.dayCount,
        comparison.status,
        metricName,
        csvNumber(current),
        csvNumber(previous),
        csvNumber(delta),
        pct === "" ? "" : csvNumber(pct),
        costStatus,
      ]);
    }
  }
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function cashControlCsv(report) {
  const rows = [
    ["report_date", "basis", "status", "shift_id", "shift_name", "opened_by", "opened_at", "closed_by", "closed_at", "opening_cash", "cash_sales", "cash_refunds", "expected_cash", "actual_cash", "variance", "cash_to_leave", "deposit_cash", "shift_cash_sales", "shift_cash_refunds"],
    [
      report.reportDate,
      report.basis,
      report.status,
      report.shift?.id ?? "",
      report.shift?.shiftName ?? "",
      report.shift?.openedByUserId ?? "",
      report.shift?.openedAt ?? "",
      report.shift?.closedByUserId ?? "",
      report.shift?.closedAt ?? "",
      csvNumber(report.openingCashRupiah),
      csvNumber(report.cashSalesRupiah),
      csvNumber(report.cashRefundsRupiah),
      csvNumber(report.expectedCashRupiah),
      csvNumber(report.actualCashRupiah),
      csvNumber(report.varianceRupiah),
      csvNumber(report.cashToLeaveRupiah),
      csvNumber(report.depositCashRupiah),
      csvNumber(report.shiftCashSalesRupiah),
      csvNumber(report.shiftCashRefundsRupiah),
    ],
    [],
    ["movement_occurred_at", "type", "order_id", "amount_rupiah", "actor_id"],
    ...report.movements.map((movement) => [movement.occurredAt, movement.type, movement.orderId, movement.amountRupiah, movement.actorId]),
    [],
    ["warning"],
    ...report.warnings.map((warning) => [warning]),
  ];
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function paymentSettlementCsv(report) {
  const rows = [
    ["report_date", "basis", "status", "total_payment_count", "total_rupiah", "unchecked_count", "unchecked_rupiah", "issue_count", "issue_rupiah", "oldest_unsettled_minutes"],
    [report.reportDate, report.basis, report.status, report.totalPaymentCount, report.totalRupiah, report.uncheckedCount, report.uncheckedRupiah, report.issueCount, report.issueRupiah, csvNumber(report.oldestUnsettledMinutes)],
    [],
    ["method_name", "method_type", "count", "total_rupiah", "settled_count", "settled_rupiah", "cash_drawer_count", "cash_drawer_rupiah", "unchecked_count", "unchecked_rupiah", "issue_count", "issue_rupiah", "oldest_unsettled_minutes"],
    ...report.methods.map((method) => [method.methodName, method.methodType, method.count, method.totalRupiah, method.settledCount, method.settledRupiah, method.cashDrawerCount, method.cashDrawerRupiah, method.uncheckedCount, method.uncheckedRupiah, method.issueCount, method.issueRupiah, csvNumber(method.oldestUnsettledMinutes)]),
    [],
    ["order_number", "method_name", "method_type", "amount_rupiah", "payment_status", "settlement_status", "provider_fee_rupiah", "net_settlement_rupiah", "variance_rupiah", "paid_at", "age_minutes", "evidence_ref", "reviewed_at", "reviewed_by", "settlement_evidence_hash"],
    ...report.payments.map((payment) => [payment.orderNumber, payment.methodName, payment.methodType, payment.amountRupiah, payment.status, payment.settlementStatus, csvNumber(payment.providerFeeRupiah), csvNumber(payment.netSettlementRupiah), csvNumber(payment.settlementVarianceRupiah), payment.paidAt, csvNumber(payment.ageMinutes), payment.evidenceRef, payment.settlementReviewedAt, payment.settlementReviewedBy, payment.settlementEvidenceHash]),
    [],
    ["warning"],
    ...report.warnings.map((warning) => [warning]),
  ];
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function csvNumber(value) {
  return value == null ? "" : value;
}

function shortEvidenceReference(value) {
  const text = String(value ?? "");
  return text.length <= 10 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function periodComparisonPoint(orders, financialSummary) {
  const orderCount = orders.length;
  const menuSalesRupiah = financialSummary.menuSalesRupiah;
  const grossProfitRupiah = financialSummary.cost?.grossProfitRupiah ?? null;
  return {
    orderCount,
    menuSalesRupiah,
    aovRupiah: Number.isSafeInteger(menuSalesRupiah) && orderCount ? Math.round(menuSalesRupiah / orderCount) : orderCount ? null : 0,
    grossProfitRupiah,
    costStatus: financialSummary.cost?.status ?? "UNVERIFIED",
  };
}

function safeDelta(current, previous) {
  return Number.isSafeInteger(current) && Number.isSafeInteger(previous) ? current - previous : null;
}

function safePctDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10_000) / 100;
}

function addBusinessDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetweenBusinessDates(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

function agingBucket(daysUntilDue) {
  if (daysUntilDue < 0) return "OVERDUE";
  if (daysUntilDue === 0) return "DUE_TODAY";
  if (daysUntilDue <= 7) return "DUE_NEXT_7_DAYS";
  return "LATER";
}

function businessDate(now, timezone) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeBusinessDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) throw domainError("report_date_invalid", 422);
  return text;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvSafeCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function orderCostCoverage(items) {
  if (items.every((item) => item.costCoverage === "COMPLETE")) return "COMPLETE";
  return items.some((item) => item.costCoverage === "COMPLETE" || item.costCoverage === "PARTIAL") ? "PARTIAL" : "MISSING";
}

function hppQualityCsv(quality) {
  const rows = [
    ["record_type", "entity_id", "entity_name", "status", "cost_coverage", "issue", "order_status", "quantity", "reportable_hpp_rupiah"],
    ...(quality?.rows ?? []).map((row) => [row.recordType, row.entityId, row.entityName, row.status, row.costCoverage, row.issue, row.orderStatus, row.quantity, row.reportableHppRupiah]),
  ];
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

function normalizeInventoryVarianceSelection({ openingCountId, closingCountId } = {}) {
  const opening = optionalCountId(openingCountId);
  const closing = optionalCountId(closingCountId);
  if (Boolean(opening) !== Boolean(closing)) throw domainError("inventory_variance_count_pair_required", 422);
  return opening ? { openingCountId: opening, closingCountId: closing } : {};
}

function optionalCountId(value) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw domainError("inventory_variance_count_id_invalid", 422);
  return value;
}

function normalizeRuntimeReceiptPayload(payload, outletId, legacy) {
  const locations = {
    usable: `${outletId}:USABLE`,
    quarantine: `${outletId}:QUARANTINE`,
    rejected: `${outletId}:REJECTED`,
    pendingInspection: `${outletId}:INSPECTION`,
  };
  const lines = Array.isArray(payload?.lines) ? payload.lines.map((line) => {
    const acceptedPurchaseQuantity = line?.acceptedPurchaseQuantity ?? line?.purchaseQuantity ?? 0;
    const rejectedPurchaseQuantity = line?.rejectedPurchaseQuantity ?? 0;
    const quarantinedPurchaseQuantity = line?.quarantinedPurchaseQuantity ?? 0;
    const pendingInspectionPurchaseQuantity = line?.pendingInspectionPurchaseQuantity ?? 0;
    return legacy ? {
      ...line,
      deliveredPurchaseQuantity: line?.deliveredPurchaseQuantity
        ?? acceptedPurchaseQuantity + rejectedPurchaseQuantity + quarantinedPurchaseQuantity + pendingInspectionPurchaseQuantity,
      acceptedPurchaseQuantity,
      rejectedPurchaseQuantity,
      quarantinedPurchaseQuantity,
      pendingInspectionPurchaseQuantity,
    } : line;
  }) : payload?.lines;
  const has = (field) => Array.isArray(lines) && lines.some((line) => Number(line?.[field] ?? 0) > 0);
  const expected = {
    destinationLocationId: legacy
      ? normalizeOwnerInventoryLocation(payload?.destinationLocationId, outletId, true)
      : has("quarantinedPurchaseQuantity") || has("rejectedPurchaseQuantity") || has("pendingInspectionPurchaseQuantity")
        ? locations.usable : normalizeOwnerInventoryLocation(payload?.destinationLocationId, outletId),
    quarantineLocationId: has("quarantinedPurchaseQuantity") ? locations.quarantine : undefined,
    rejectionLocationId: has("rejectedPurchaseQuantity") ? locations.rejected : undefined,
    pendingInspectionLocationId: has("pendingInspectionPurchaseQuantity") ? locations.pendingInspection : undefined,
  };
  if (!legacy && (payload?.destinationLocationId !== expected.destinationLocationId
    || payload?.quarantineLocationId !== expected.quarantineLocationId
    || payload?.rejectionLocationId !== expected.rejectionLocationId
    || payload?.pendingInspectionLocationId !== expected.pendingInspectionLocationId)) {
    throw domainError("purchase_receipt_location_not_authorized", 403);
  }
  return { ...payload, ...expected, lines };
}

function normalizeRuntimeInspectionPayload(payload, outletId) {
  const expected = payload?.decision === "ACCEPT" ? `${outletId}:USABLE` : payload?.decision === "REJECT" ? `${outletId}:REJECTED` : null;
  if (!expected || payload?.destinationLocationId !== expected) throw domainError("purchase_inspection_location_not_authorized", 403);
  return { ...payload, destinationLocationId: expected };
}

function inventoryOperationMessage(action, operation) {
  const messages = {
    "ingredient.upsert": ["Bahan tersimpan", `Data ${operation.next?.name ?? "bahan"} kini dipakai oleh Database, Gudang, dan HPP dengan ID yang sama.`],
    "ingredient.archive": ["Bahan diarsipkan", `${operation.next?.name ?? "Bahan"} disembunyikan dari pilihan aktif tanpa menghapus histori.`],
    "ingredient.conversion.upsert": ["Konversi tersimpan", "Versi konversi baru berlaku ke depan; catatan versi sebelumnya tetap utuh."],
    "ingredient.supplier-package.upsert": ["Kemasan supplier tersimpan", "Referensi kemasan ditautkan ke bahan tanpa mengganti identitas bahan."],
    "ingredient.purchase-option.upsert": ["Pilihan pembelian tersimpan", "Konversi dan harga acuan tersedia untuk penerimaan stok; harga invoice tetap menjadi nilai aktual."],
    "ingredient.reference-price.record": ["Harga acuan tersimpan", "Versi harga baru tercatat tanpa mengubah harga penerimaan aktual atau moving average stok."],
    "ingredient.reference-price.correct": ["Koreksi harga tersimpan", "Versi lama tetap ada dan ditautkan ke koreksi baru."],
    "ingredient.reference-price.void": ["Versi harga dibatalkan", "Catatan lama tetap ada dan dibatalkan melalui event void."],
    "purchase-option.upsert": ["Pilihan pembelian tersimpan", "Konversi dan harga acuan tersedia untuk penerimaan stok; harga invoice tetap menjadi nilai aktual."],
    "category.create": ["Kategori bahan dibuat", `${operation.next?.name ?? "Kategori"} tersedia pada wizard bahan.`],
    "category.update": ["Kategori bahan diperbarui", "Nama dan rekomendasi kategori berlaku untuk pengisian berikutnya; kode bahan lama tidak berubah."],
    "category.archive": ["Kategori bahan diarsipkan", "Kategori disembunyikan dari pilihan baru tanpa mengubah bahan dan histori lama."],
    "ingredient.wizard.create": ["Bahan berhasil dibuat", `${operation.ingredient?.name ?? "Bahan"} beserta kategori dan pilihan pembeliannya tersimpan sebagai satu perubahan.`],
    "warehouse.receipt.post": ["Penerimaan stok tersimpan", `${operation.receipt?.lines?.length ?? 0} bahan masuk ke stok tersedia dan biaya rata-rata diperbarui.`],
    "warehouse.movement.record": ["Pergerakan stok tersimpan", "Jumlah dan nilai stok diperbarui tanpa menghapus histori sebelumnya."],
    "warehouse.movement.reverse": ["Koreksi stok tersimpan", "Transaksi lama tetap terlihat dan dibalik melalui catatan reversal baru."],
    "warehouse.transfer.record": ["Transfer stok selesai", "Stok berpindah lokasi tanpa mengubah total jumlah atau nilai persediaan."],
    "warehouse.count.complete": ["Stock count selesai", `${operation.count?.lineCount ?? 0} bahan direkonsiliasi melalui movement yang dapat diaudit.`],
    "hpp.draft-line.upsert": ["Draft HPP tersimpan · belum dipublish", `Perubahan draft versi ${operation.draft?.version ?? "baru"} hanya dipakai untuk simulasi. Review dan publish diperlukan agar HPP menu diterbitkan.`],
    "hpp.draft-lines.upsert": ["Draft HPP tersimpan · belum dipublish", `${operation.componentCount ?? operation.ingredientIds?.length ?? "Beberapa"} komponen disimpan bersama ke draft versi ${operation.draft?.version ?? "baru"}; edit dan publish HPP tidak mengubah stok atau transaksi.`],
    "hpp.draft-line.remove": ["Baris draft dihapus", "Resep aktif dan histori published tidak berubah."],
    "hpp.draft-line.reorder": ["Urutan komponen tersimpan", "Urutan tampilan draft diperbarui tanpa mengubah jumlah, biaya, stok, atau resep aktif."],
    "hpp.draft.publish": ["HPP menu dipublikasikan", `Versi ${operation.published?.version ?? "baru"} sekarang menjadi resep aktif; snapshot biaya sebelumnya tetap utuh.`],
  };
  const [title, message] = messages[action] ?? ["Perubahan tersimpan", "Data terbaru sudah tersedia di dashboard."];
  return { title, message, revision: operation.version ?? null };
}

function marginPercent(sellingPriceRupiah, hppRupiah) {
  return sellingPriceRupiah > 0 ? Math.round(((sellingPriceRupiah - hppRupiah) / sellingPriceRupiah) * 10_000) / 100 : 0;
}

function normalizeReferencePriceHistory(items) {
  const sorted = items.slice().sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.sequence - b.sequence);
  let baseline = null;
  const normalized = sorted.map((item) => {
    const unitCostRupiah = item.unitCostPerBaseUnitRupiah;
    const previous = baseline;
    if (item.entryType !== "VOID") baseline = item;
    return {
      ...item, source: "REFERENCE_PRICE", timestamp: item.effectiveAt, occurredAt: item.recordedAt,
      packageLabel: item.packageSnapshot?.label ?? null,
      baseQuantity: item.packageSnapshot?.baseUnitsPerPurchaseUnit ?? null,
      totalCostRupiah: item.referencePriceRupiah,
      unitCostRupiah,
      previousReferencePriceRupiah: previous?.referencePriceRupiah ?? null,
      deltaRupiah: previous?.referencePriceRupiah != null && item.referencePriceRupiah != null ? item.referencePriceRupiah - previous.referencePriceRupiah : null,
      deltaPct: previous?.referencePriceRupiah > 0 && item.referencePriceRupiah != null ? Math.round((item.referencePriceRupiah / previous.referencePriceRupiah - 1) * 10_000) / 100 : null,
    };
  });
  return normalized.sort((a, b) => b.sequence - a.sequence);
}

function effectiveReferencePriceHistory(items, asOf) {
  const applicable = items.filter((item) => item.effectiveAt <= asOf);
  const supersededOrVoided = new Set(applicable.map((item) => item.targetPriceVersionId).filter(Boolean));
  return applicable.filter((item) => item.entryType !== "VOID" && !supersededOrVoided.has(item.id))
    .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.sequence - a.sequence);
}

function compareImpactHistoryDesc(a, b) {
  return String(b.timestamp).localeCompare(String(a.timestamp)) || String(b.id).localeCompare(String(a.id));
}

function paginateImpactHistory(items, cursor, limit) {
  const pageSize = limit == null || limit === "" ? 50 : Number(limit);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw domainError("ingredient_price_history_limit_invalid", 422);
  let start = 0;
  if (cursor != null && cursor !== "") {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); } catch { throw domainError("ingredient_price_history_cursor_invalid", 422); }
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((item) => typeof item !== "string" || !item)) throw domainError("ingredient_price_history_cursor_invalid", 422);
    const index = items.findIndex((item) => item.timestamp === decoded[0] && item.id === decoded[1]);
    if (index < 0) throw domainError("ingredient_price_history_cursor_invalid", 422);
    start = index + 1;
  }
  const pageItems = items.slice(start, start + pageSize);
  const hasMore = start + pageItems.length < items.length;
  const last = pageItems.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([last.timestamp, last.id])).toString("base64url") : null;
  return { items: pageItems, limit: pageSize, nextCursor };
}

function jakartaMonth(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

function normalizeSupplierDisplayName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function normalizeSupplierKey(value) {
  const display = normalizeSupplierDisplayName(value);
  return display ? display.toLocaleLowerCase("id") : null;
}

function supplierDisplayMap(items) {
  const displays = new Map();
  for (const item of items.slice().sort(compareImpactHistoryDesc)) {
    const key = normalizeSupplierKey(item.supplierName);
    if (key && !displays.has(key)) displays.set(key, normalizeSupplierDisplayName(item.supplierName));
  }
  return displays;
}

function supplierMonthlyAggregates(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const month = jakartaMonth(row.timestamp);
    if (!month) continue;
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month).push(row);
  }
  return [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([month, monthRows]) => {
    const chronological = monthRows.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
    const totalBase = monthRows.reduce((sum, item) => sum + Number(item.baseQuantity ?? 0), 0);
    const totalCost = monthRows.reduce((sum, item) => sum + Number(item.totalCostRupiah ?? 0), 0);
    const baseline = chronological[0]?.unitCostRupiah ?? null;
    const latest = chronological.at(-1)?.unitCostRupiah ?? null;
    return {
      month, eventCount: monthRows.length, baseQuantity: totalBase, totalCostRupiah: totalCost,
      weightedUnitCostRupiah: totalBase > 0 ? Math.round(totalCost / totalBase * 1_000_000) / 1_000_000 : null,
      baselineUnitCostRupiah: baseline, latestUnitCostRupiah: latest,
      cumulativeChangePct: baseline > 0 && latest != null ? Math.round((latest / baseline - 1) * 10_000) / 100 : null,
    };
  });
}

function monthlyReferencePriceIncreaseAlerts(chronologicalPrices) {
  const grouped = new Map();
  for (const item of chronologicalPrices) {
    const month = jakartaMonth(item.effectiveAt);
    if (!month) continue;
    if (!grouped.has(month)) grouped.set(month, []);
    grouped.get(month).push(item);
  }
  const alerts = [];
  let prior = null;
  for (const [month, items] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const baseline = prior ?? items[0];
    const next = items.at(-1);
    const increasePct = baseline !== next && baseline.referencePriceRupiah > 0
      ? Math.round((next.referencePriceRupiah - baseline.referencePriceRupiah) / baseline.referencePriceRupiah * 10_000) / 100
      : 0;
    if (increasePct >= 5) alerts.push({ type: "PRICE_INCREASE_HIGH", severity: "WARNING", month, timestamp: next.effectiveAt, increasePct, cumulativeIncreasePct: increasePct, baselinePriceRupiah: baseline.referencePriceRupiah, nextPriceRupiah: next.referencePriceRupiah });
    prior = next;
  }
  return alerts;
}

function normalizeOwnerInventoryReceiptPayload(hppCatalog, payload, occurredAt, outletId) {
  if (!payload || !Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 100) {
    throw domainError("purchase_lines_invalid", 422);
  }
  const lines = payload.lines.map((line) => {
    const purchaseQuantity = Number(line?.purchaseQuantity);
    if (!Number.isFinite(purchaseQuantity) || purchaseQuantity <= 0) throw domainError("purchase_quantity_invalid", 422);
    const purchaseOption = line?.purchaseOptionId
      ? hppCatalog.view().ingredientSupplierPackages.find((item) => (item.purchaseOptionId ?? item.packageId) === line.purchaseOptionId)
      : null;
    if (line?.purchaseOptionId && (!purchaseOption || purchaseOption.ingredientId !== line.ingredientId)) throw domainError("ingredient_purchase_option_not_found", 404);
    if (purchaseOption) {
      return {
        ingredientId: line.ingredientId,
        purchaseUnitLabel: purchaseOption.label ?? purchaseOption.packageLabel,
        purchaseQuantity,
        baseUnitsPerPurchaseUnit: purchaseOption.baseUnitsPerPurchaseUnit ?? purchaseOption.quantityPerPackage,
        totalCostRupiah: line.totalCostRupiah,
        ...ownerReceiptDispositionFields(line),
        ...(Array.isArray(line.lots) ? { lots: line.lots } : {}),
        purchaseOptionSnapshot: {
          purchaseOptionId: purchaseOption.purchaseOptionId ?? purchaseOption.packageId,
          sequence: purchaseOption.sequence,
          purchaseUnit: purchaseOption.purchaseUnit ?? purchaseOption.purchaseUom,
          innerUnit: purchaseOption.innerUnit ?? null,
          innerUnitsPerPurchaseUnit: purchaseOption.innerUnitsPerPurchaseUnit ?? null,
          baseUnitsPerInnerUnit: purchaseOption.baseUnitsPerInnerUnit ?? null,
          baseUnitsPerPurchaseUnit: purchaseOption.baseUnitsPerPurchaseUnit ?? purchaseOption.quantityPerPackage,
          referencePriceRupiah: purchaseOption.referencePriceRupiah ?? null,
        },
      };
    }
    const purchaseUom = typeof line?.purchaseUom === "string" ? line.purchaseUom.trim() : "";
    if (!purchaseUom) throw domainError("purchase_unit_label_invalid", 422);
    const normalizedUnit = hppCatalog.normalizeIngredientQuantity({
      ingredientId: line.ingredientId,
      quantity: 1,
      uom: purchaseUom,
      occurredAt,
    });
    return {
      ingredientId: line.ingredientId,
      purchaseUnitLabel: typeof line.packageLabel === "string" && line.packageLabel.trim() ? line.packageLabel.trim() : purchaseUom,
      purchaseQuantity,
      baseUnitsPerPurchaseUnit: normalizedUnit.normalizedQuantity,
      totalCostRupiah: line.totalCostRupiah,
      ...ownerReceiptDispositionFields(line),
      ...(Array.isArray(line.lots) ? { lots: line.lots } : {}),
    };
  });
  return {
    idempotencyKey: payload.idempotencyKey,
    businessDate: payload.businessDate,
    supplierName: payload.supplierName,
    ...(payload.purchaseOrderId ? { purchaseOrderId: payload.purchaseOrderId } : {}),
    lines,
    additionalFees: Array.isArray(payload.additionalFees) ? payload.additionalFees : [],
    destinationLocationId: normalizeOwnerInventoryLocation(payload.destinationLocationId, outletId, true),
    // Logical dispositions within the single outlet, not extra usable stores.
    rejectionLocationId: lines.some(l => Number(l.rejectedPurchaseQuantity)>0) ? `${outletId}:REJECTED` : undefined,
    quarantineLocationId: lines.some(l => Number(l.quarantinedPurchaseQuantity)>0) ? `${outletId}:QUARANTINE` : undefined,
    pendingInspectionLocationId: lines.some(l => Number(l.pendingInspectionPurchaseQuantity)>0) ? `${outletId}:PENDING_INSPECTION` : undefined,
  };
}

function ownerReceiptDispositionFields(line) {
  const fields = {};
  for (const key of ["acceptedPurchaseQuantity", "deliveredPurchaseQuantity", "rejectedPurchaseQuantity", "quarantinedPurchaseQuantity", "pendingInspectionPurchaseQuantity", "rejectionReason"]) {
    if (line?.[key] !== undefined) fields[key] = line[key];
  }
  return fields;
}

function normalizeOwnerInventoryTransferPayload(payload, outletId) {
  return {
    ...payload,
    sourceLocationId: normalizeOwnerInventoryLocation(payload?.sourceLocationId, outletId),
    destinationLocationId: normalizeOwnerInventoryLocation(payload?.destinationLocationId, outletId),
  };
}

function normalizeOwnerInventoryMovementPayload(payload, outletId) {
  return { ...payload, locationId: normalizeOwnerInventoryLocation(payload?.locationId, outletId, true), sharedStorage: true };
}

function normalizeOwnerInventoryLocation(value, outletId, defaultToPrimary = false) {
  const allowed = new Set([`${outletId}:USABLE`]);
  if (defaultToPrimary && (value === undefined || value === null || value === "")) return `${outletId}:USABLE`;
  if (!allowed.has(value)) throw domainError("inventory_location_not_authorized", 403);
  return value;
}

function domainError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validRuntimeIdentifier(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 80 && /^[A-Za-z0-9._:-]+$/.test(value);
}
