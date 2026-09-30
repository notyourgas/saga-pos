export const ESB_BOUNDARY_CONTRACT_VERSION = 1;

export const EXTERNAL_CAPABILITIES = Object.freeze([
  "MARKETPLACE",
  "ONLINE_ORDER",
  "PAYOUT",
  "EMAIL",
  "DEVICE",
  "PROVIDER_GENERIC",
]);

export const CAPABILITY_STATUS = Object.freeze({
  DISABLED: "DISABLED_BY_DEFAULT",
  CONTRACT_ONLY: "CONTRACT_ONLY",
  SYNTHETIC_READY: "SYNTHETIC_READY",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
});

export const DATA_MODES = Object.freeze({
  SYNTHETIC: "SYNTHETIC",
  REAL: "REAL",
});

export const TABLE_ROOM_CONTRACT_V1 = deepFreeze({
  version: ESB_BOUNDARY_CONTRACT_VERSION,
  status: "OPERATOR_EVIDENCE_REQUIRED",
  runtimeEnabled: false,
  persistenceImplemented: false,
  reason: "ESB UI showed room/table controls, but SagaPOS operator need and live workflow have not been proven.",
});

export const WORKFORCE_BOUNDARY_V1 = deepFreeze({
  authority: "SAGAWORK",
  localPersistence: "REFERENCE_ONLY",
  ownerAccess: "DELEGATED_EXISTING_POS_SESSION",
  forbiddenLocalAggregates: ["EMPLOYEE", "ATTENDANCE", "PAYROLL"],
});

export function boundaryError(code, statusCode = 422, details = undefined) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = deepFreeze(structuredClone(details));
  return error;
}

export function requiredText(value, code, maximum = 160) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/u.test(normalized)) throw boundaryError(code);
  return normalized;
}

export function requiredCode(value, code) {
  const normalized = requiredText(value, code, 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/u.test(normalized)) throw boundaryError(code);
  return normalized;
}

export function requiredId(value, code) {
  const normalized = requiredText(value, code, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(normalized)) throw boundaryError(code);
  return normalized;
}

export function assertDataMode(value) {
  if (!Object.values(DATA_MODES).includes(value)) throw boundaryError("boundary_data_mode_invalid");
  return value;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
