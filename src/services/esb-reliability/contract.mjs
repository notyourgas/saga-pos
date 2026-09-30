export const RELIABILITY_CONTRACT_VERSION = 1;
export const QUANTITY_SCALE = 6;
export const QUANTITY_FACTOR = 1_000_000n;

export const RELIABILITY_PERSISTENCE_PORT_V1 = deepFreeze({
  version: RELIABILITY_CONTRACT_VERSION,
  transactionBoundary: [
    "find_operation_by_unique_scope",
    "consume_action_authorization_compare_and_set",
    "lock_inventory_balances_in_stable_order_for_update",
    "append_inventory_reservation_and_movements",
    "update_inventory_balances",
    "append_audit_event",
    "enqueue_outbox",
  ],
  requiredUniqueScopes: [
    ["organization_id", "operation_key"],
    ["organization_id", "outlet_id", "offline_operation_id"],
    ["organization_id", "logical_print_job_id", "copy_number"],
  ],
  integrationStatus: "ADAPTER_REQUIRED_BEFORE_RUNTIME_USE",
});

export const POSTGRES_LAST_STOCK_LOCK_SQL = Object.freeze({
  lockBalances: `select ingredient_id, quantity_base, inventory_mode, version
from sagaops.inventory_balances
where organization_id = $1 and outlet_id = $2 and ingredient_id = any($3::uuid[])
order by ingredient_id
for update`,
  updateBalance: `update sagaops.inventory_balances
set quantity_base = $1, version = version + 1, updated_at = $2
where organization_id = $3 and outlet_id = $4 and ingredient_id = $5 and version = $6`,
  note: "Run inside one PostgreSQL transaction after operation-key lookup; the ordered FOR UPDATE prevents last-stock races and lock-order deadlocks.",
});

export function reliabilityError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = deepFreeze(structuredClone(details));
  return error;
}

export function requireText(value, code, maximum = 160) {
  if (typeof value !== "string" || value.trim().length === 0) throw reliabilityError(code);
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u001f]/u.test(normalized)) throw reliabilityError(`${code}_invalid`);
  return normalized;
}

export function requireSafeMoney(value, code) {
  if (!Number.isSafeInteger(value)) throw reliabilityError(code);
  return value;
}

export function parseQuantity(value, code = "quantity_invalid") {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) throw reliabilityError(code);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * QUANTITY_FACTOR + BigInt(fraction.padEnd(QUANTITY_SCALE, "0"));
}

export function formatQuantity(value) {
  if (typeof value !== "bigint" || value < 0n) throw reliabilityError("quantity_invalid");
  const whole = value / QUANTITY_FACTOR;
  const fraction = String(value % QUANTITY_FACTOR).padStart(QUANTITY_SCALE, "0");
  return `${whole}.${fraction}`;
}

export function multiplyQuantity(left, right) {
  const product = parseQuantity(left) * parseQuantity(right);
  return formatQuantity(divideHalfUp(product, QUANTITY_FACTOR));
}

export function sumQuantities(values) {
  return formatQuantity(values.reduce((sum, value) => sum + parseQuantity(value), 0n));
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableSnapshot(value, code = "snapshot_invalid") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw reliabilityError(code);
  return deepFreeze(structuredClone(value));
}

function divideHalfUp(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}
