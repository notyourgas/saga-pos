export const EXCEPTION_KINDS = Object.freeze({
  CANCEL_PRE_PRODUCTION: "CANCEL_PRE_PRODUCTION",
  VOID_POST_PRODUCTION: "VOID_POST_PRODUCTION",
  CASH_REFUND: "CASH_REFUND",
  PROVIDER_REFUND: "PROVIDER_REFUND",
  PAYMENT_CORRECTION: "PAYMENT_CORRECTION",
  PAYMENT_REVERSAL: "PAYMENT_REVERSAL",
  PAYMENT_RECLASSIFICATION: "PAYMENT_RECLASSIFICATION",
});

export const STOCK_DISPOSITIONS = Object.freeze([
  "RETURN_TO_STOCK",
  "WASTE",
  "NO_STOCK_CHANGE",
]);

export const PERIOD_STATES = Object.freeze(["OPEN", "CLOSED", "LOCKED", "UNVERIFIED"]);

const definitions = Object.freeze({
  [EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION]: Object.freeze({
    phase: "BEFORE_PRODUCTION",
    permission: "exception:cancel",
    actionAuthorizationRequired: false,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: false,
  }),
  [EXCEPTION_KINDS.VOID_POST_PRODUCTION]: Object.freeze({
    phase: "AFTER_PRODUCTION",
    permission: "exception:void",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: true,
    supportsHistoricalOverride: true,
  }),
  [EXCEPTION_KINDS.CASH_REFUND]: Object.freeze({
    phase: "AFTER_PAYMENT",
    permission: "exception:refund_cash",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: true,
  }),
  [EXCEPTION_KINDS.PROVIDER_REFUND]: Object.freeze({
    phase: "AFTER_PAYMENT",
    permission: "exception:refund_provider",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: true,
  }),
  [EXCEPTION_KINDS.PAYMENT_CORRECTION]: Object.freeze({
    phase: "AFTER_PAYMENT",
    permission: "exception:payment_correction",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: true,
  }),
  [EXCEPTION_KINDS.PAYMENT_REVERSAL]: Object.freeze({
    phase: "AFTER_PAYMENT",
    permission: "exception:payment_reversal",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: true,
  }),
  [EXCEPTION_KINDS.PAYMENT_RECLASSIFICATION]: Object.freeze({
    phase: "AFTER_PAYMENT",
    permission: "exception:payment_reclassification",
    actionAuthorizationRequired: true,
    reasonRequired: true,
    stockDispositionRequired: false,
    supportsHistoricalOverride: true,
  }),
});

export const EXCEPTION_PERSISTENCE_PORT_V1 = deepFreeze({
  version: 1,
  transactionBoundary: [
    "assert_current_resource_version",
    "consume_action_authorization_compare_and_set",
    "append_exception_event",
    "append_immutable_audit_event",
    "enqueue_outbox_when_required",
  ],
  requiredUniqueScopes: [
    ["organization_id", "operation_key"],
    ["organization_id", "authorization_id"],
    ["organization_id", "approval_id"],
  ],
  appendOnly: ["exception_event", "audit_event"],
  integrationStatus: "POSTGRES_ADAPTER_AVAILABLE_ROUTE_NOT_WIRED",
});

export function getExceptionDefinition(kind) {
  const definition = definitions[kind];
  if (!definition) throw exceptionError("exception_kind_invalid");
  return definition;
}

export function exceptionError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = deepFreeze(structuredCloneSafe(details));
  return error;
}

export function requireText(value, code, maximum = 200) {
  if (typeof value !== "string" || value.trim().length === 0) throw exceptionError(code);
  const normalized = value.trim();
  if (normalized.length > maximum) throw exceptionError(`${code}_too_long`, { maximum });
  return normalized;
}

export function requireIsoDate(value, code) {
  const text = requireText(value, code, 64);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw exceptionError(code);
  return date;
}

export function requireSafeRupiah(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw exceptionError(code);
  return value;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw exceptionError("exception_snapshot_invalid");
  }
  return deepFreeze(structuredCloneSafe(value));
}

function structuredCloneSafe(value) {
  return value === undefined ? {} : structuredClone(value);
}
