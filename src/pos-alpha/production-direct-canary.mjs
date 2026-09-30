import { createHash } from "node:crypto";

export const TRIAL99_PRODUCTION_DIRECT_POLICY = Object.freeze({
  route: "production_direct_controlled_canary",
  productCode: "sagaops",
  promotionCode: "TRIAL99",
  discountPercent: 99,
  privateOnly: true,
  maxTransactions: 5,
  maxCartLines: 1,
  maxCartQuantity: 1,
  maximumSinglePaymentRupiah: 220,
  maximumAuthorizedRupiah: 1_100,
});

const REQUIRED_REFS = ["credentialRef", "signerRef", "verifierRef"];

export function evaluateProductionDirectCanaryConfig(config = {}, { clock = () => new Date() } = {}) {
  assertNoSecretValues(config);
  const missing = [];
  const exact = (field, expected) => { if (config[field] !== expected) missing.push(field); };
  exact("route", TRIAL99_PRODUCTION_DIRECT_POLICY.route);
  exact("productCode", TRIAL99_PRODUCTION_DIRECT_POLICY.productCode);
  exact("promotionCode", TRIAL99_PRODUCTION_DIRECT_POLICY.promotionCode);
  exact("discountPercent", TRIAL99_PRODUCTION_DIRECT_POLICY.discountPercent);
  exact("privateOnly", true);
  exact("maxTransactions", TRIAL99_PRODUCTION_DIRECT_POLICY.maxTransactions);
  for (const field of ["enabled", "productRegistered", "transactionsEnabled", "productionHostAllowlisted", "callbackReady", "killSwitchReady"]) {
    if (config[field] !== true) missing.push(field);
  }
  for (const field of REQUIRED_REFS) if (!isVaultRef(config[field])) missing.push(field);
  for (const field of ["ownerAuthorizationRef", "financeOwnerRef", "settlementRef"]) {
    if (!isPrivateRef(config[field])) missing.push(field);
  }
  for (const field of ["gatewayUrl", "callbackUrl"]) if (!isProductionHttpsUrl(config[field])) missing.push(field);
  const allowedDevices = Array.isArray(config.allowedDeviceRefs) ? config.allowedDeviceRefs : [];
  if (allowedDevices.length === 0 || allowedDevices.some((value) => !isPrivateRef(value))) missing.push("allowedDeviceRefs");
  const windowStart = timestamp(config.windowStart);
  const windowEnd = timestamp(config.windowEnd);
  if (windowStart == null) missing.push("windowStart");
  if (windowEnd == null || (windowStart != null && windowEnd <= windowStart)) missing.push("windowEnd");
  const now = clock().getTime();
  const windowOpen = windowStart != null && windowEnd != null && now >= windowStart && now <= windowEnd;
  return {
    result: missing.length === 0 ? (windowOpen ? "READY_FOR_EXPLICIT_LIVE_CANARY_NOT_EXECUTED" : "CONFIG_COMPLETE_WINDOW_CLOSED") : "BLOCKED_FAIL_CLOSED",
    ready: missing.length === 0 && windowOpen,
    missingFields: [...new Set(missing)],
    windowOpen,
    productionMutationAllowed: false,
    valuesRedacted: true,
  };
}

export function createTrial99ProductionAuthorizer(config = {}, { clock = () => new Date() } = {}) {
  const preflight = evaluateProductionDirectCanaryConfig(config, { clock });
  if (!preflight.ready) throw new Error(`trial99_canary_not_ready:${preflight.missingFields.join(",") || "window_closed"}`);
  const allowedDevices = new Set(config.allowedDeviceRefs);
  const passportId = `trial99-${createHash("sha256").update([
    config.ownerAuthorizationRef,
    config.windowStart,
    config.windowEnd,
    ...[...allowedDevices].sort(),
  ].join("|")).digest("hex").slice(0, 16)}`;

  const authorize = ({ operation, promotionCode, deviceRef, privateCanary, cartLines, cartQuantity, amountRupiah } = {}, usage = {}) => {
    if (operation !== "PAYMENT_CREATE") return deny("OPERATION_DENIED");
    if (config.killSwitchEngaged === true) return deny("KILL_SWITCH_ENGAGED");
    if (!evaluateProductionDirectCanaryConfig(config, { clock }).ready) return deny("WINDOW_OR_CONFIG_CLOSED");
    if (promotionCode !== TRIAL99_PRODUCTION_DIRECT_POLICY.promotionCode) return deny("PROMOTION_SCOPE_DENIED");
    if (privateCanary !== true) return deny("PUBLIC_CHANNEL_DENIED");
    if (!allowedDevices.has(deviceRef)) return deny("DEVICE_NOT_ALLOWLISTED");
    if (cartLines !== 1 || cartQuantity !== 1) return deny("SINGLE_ITEM_REQUIRED");
    if (!Number.isInteger(amountRupiah) || amountRupiah < 1 || amountRupiah > TRIAL99_PRODUCTION_DIRECT_POLICY.maximumSinglePaymentRupiah) {
      return deny("PAYMENT_AMOUNT_OUT_OF_BOUNDS");
    }
    const createdPayments = nonNegativeInteger(usage.createdPayments);
    const successfulPayments = nonNegativeInteger(usage.successfulPayments);
    const authorizedRupiah = nonNegativeInteger(usage.authorizedRupiah);
    if (createdPayments >= TRIAL99_PRODUCTION_DIRECT_POLICY.maxTransactions || successfulPayments >= TRIAL99_PRODUCTION_DIRECT_POLICY.maxTransactions) {
      return deny("TRANSACTION_CAP_REACHED");
    }
    if (authorizedRupiah + amountRupiah > TRIAL99_PRODUCTION_DIRECT_POLICY.maximumAuthorizedRupiah) return deny("MONETARY_CAP_REACHED");
    return {
      allowed: true,
      code: "TRIAL99_PRODUCTION_DIRECT_AUTHORIZED",
      passportId,
      limits: {
        maxTransactions: TRIAL99_PRODUCTION_DIRECT_POLICY.maxTransactions,
        maximumAuthorizedRupiah: TRIAL99_PRODUCTION_DIRECT_POLICY.maximumAuthorizedRupiah,
      },
    };
  };

  return {
    passportId,
    authorizeOperation: authorize,
    authorizePromotion({ promotionCode, deviceRef, privateCanary, cartLines, cartQuantity, subtotalRupiah, usage = {} } = {}) {
      if (promotionCode !== TRIAL99_PRODUCTION_DIRECT_POLICY.promotionCode) throw new Error("trial99_promotion_scope_denied");
      if (!Number.isInteger(subtotalRupiah) || subtotalRupiah <= 0) throw new Error("trial99_subtotal_invalid");
      const discountRupiah = Math.floor(subtotalRupiah * TRIAL99_PRODUCTION_DIRECT_POLICY.discountPercent / 100);
      const amountRupiah = subtotalRupiah - discountRupiah;
      const result = authorize({ operation: "PAYMENT_CREATE", promotionCode, deviceRef, privateCanary, cartLines, cartQuantity, amountRupiah }, usage);
      if (!result.allowed) throw new Error(`trial99_promotion_not_authorized:${result.code}`);
      return {
        applied: true,
        code: TRIAL99_PRODUCTION_DIRECT_POLICY.promotionCode,
        name: "Private production canary 99%",
        discountPercent: TRIAL99_PRODUCTION_DIRECT_POLICY.discountPercent,
        discountRupiah,
        privateOnly: true,
        authorizationPassportId: passportId,
      };
    },
  };
}

function deny(code) { return { allowed: false, code }; }

function nonNegativeInteger(value) {
  const normalized = value ?? 0;
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : Number.MAX_SAFE_INTEGER;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isVaultRef(value) { return /^vault:\/\/[a-z0-9/_-]+$/i.test(value ?? ""); }
function isPrivateRef(value) { return /^(private-ref|restricted):\/\/[a-z0-9/_-]+$/i.test(value ?? ""); }

function isProductionHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      && !/(^|[.-])(example|invalid|test)([.-]|$)/i.test(url.hostname);
  } catch { return false; }
}

function assertNoSecretValues(value, path = "root") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/(password|secret|token|api[_-]?key|private[_-]?key|hmac[_-]?key)/i.test(key)) throw new Error(`raw_secret_field_denied:${path}.${key}`);
    assertNoSecretValues(child, `${path}.${key}`);
  }
}
