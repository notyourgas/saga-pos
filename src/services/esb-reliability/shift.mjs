import { deepFreeze, immutableSnapshot, reliabilityError, requireSafeMoney, requireText } from "./contract.mjs";

const CASH_DIRECTIONS = Object.freeze({
  CASH_SALE: 1,
  CASH_REFUND: -1,
  CASH_IN: 1,
  CASH_OUT: -1,
  CASH_DROP: -1,
});

export function buildShiftCashLedger(input) {
  const openingCashRupiah = requireNonNegativeMoney(input.openingCashRupiah, "shift_opening_cash_invalid");
  const operationKeys = new Set();
  const entries = (input.movements ?? []).map((movement) => {
    const kind = requireText(movement.kind, "cash_movement_kind_required", 40);
    const direction = CASH_DIRECTIONS[kind];
    if (!direction) throw reliabilityError("cash_movement_kind_invalid", { kind });
    const operationKey = requireText(movement.operationKey, "cash_movement_operation_key_required", 160);
    if (operationKeys.has(operationKey)) throw reliabilityError("cash_movement_operation_duplicate", { operationKey });
    operationKeys.add(operationKey);
    const amountRupiah = requireNonNegativeMoney(movement.amountRupiah, "cash_movement_amount_invalid");
    if (amountRupiah === 0) throw reliabilityError("cash_movement_amount_invalid");
    return deepFreeze({
      operationKey,
      kind,
      amountRupiah,
      signedAmountRupiah: safeAdd(0, direction * amountRupiah),
      sourceId: requireText(movement.sourceId, "cash_movement_source_required", 100),
    });
  });
  const expectedCashRupiah = entries.reduce((sum, entry) => safeAdd(sum, entry.signedAmountRupiah), openingCashRupiah);
  const declaredCashRupiah = input.declaredCashRupiah == null ? null : requireNonNegativeMoney(input.declaredCashRupiah, "shift_declared_cash_invalid");
  return deepFreeze({
    openingCashRupiah,
    entries,
    expectedCashRupiah,
    declaredCashRupiah,
    varianceRupiah: declaredCashRupiah == null ? null : safeAdd(declaredCashRupiah, -expectedCashRupiah),
    formula: "opening + cash_sales - cash_refunds + cash_in - cash_out - cash_drops",
  });
}

export function prepareCashDrop(input) {
  assertShiftScope(input.shift, input);
  if (input.shift.status !== "OPEN") throw reliabilityError("cash_drop_open_shift_required");
  const amountRupiah = requireNonNegativeMoney(input.amountRupiah, "cash_drop_amount_invalid");
  if (amountRupiah === 0) throw reliabilityError("cash_drop_amount_invalid");
  const reason = requireText(input.reason, "cash_drop_reason_required", 240);
  const actorId = requireText(input.actor?.id, "cash_drop_actor_required", 100);
  if (!input.actor?.permissions?.includes("shift:cash_drop")) throw reliabilityError("cash_drop_permission_denied");
  const operationKey = requireText(input.operationKey, "cash_drop_operation_key_required", 160);
  const occurredAt = requireIso(input.occurredAt, "cash_drop_occurred_at_invalid");
  return deepFreeze({
    movement: {
      organizationId: input.shift.organizationId,
      outletId: input.shift.outletId,
      shiftId: input.shift.id,
      kind: "CASH_DROP",
      amountRupiah,
      signedAmountRupiah: -amountRupiah,
      operationKey,
      actorId,
      reason,
      occurredAt,
    },
    audit: {
      action: "shift.cash_drop",
      actorId,
      entityId: input.shift.id,
      operationKey,
      before: immutableSnapshot({ expectedCashRupiah: input.shift.expectedCashRupiah ?? null }),
      after: immutableSnapshot({ cashDropRupiah: amountRupiah }),
      reason,
      occurredAt,
    },
  });
}

export function prepareShiftReopen(input) {
  assertShiftScope(input.shift, input);
  if (input.shift.status !== "CLOSED") throw reliabilityError("shift_reopen_closed_required");
  if (!["OPEN", "CLOSED", "LOCKED"].includes(input.periodState)) throw reliabilityError("shift_reopen_period_state_unverified");
  if (input.periodState === "LOCKED") throw reliabilityError("shift_reopen_period_locked");
  const operationKey = requireText(input.operationKey, "shift_reopen_operation_key_required", 160);
  const actorId = requireText(input.actor?.id, "shift_reopen_actor_required", 100);
  if (!input.actor?.permissions?.includes("shift:reopen")) throw reliabilityError("shift_reopen_permission_denied");
  const occurredAt = requireIso(input.occurredAt, "shift_reopen_occurred_at_invalid");
  const authorizationDecision = assertAuthorization(input.authorization, input, actorId, operationKey, occurredAt);
  assertOutletPolicy(input.outletPolicy, input.shift.id);
  const reason = requireText(input.reason, "shift_reopen_reason_required", 240);
  const before = immutableSnapshot(input.shift);
  const after = immutableSnapshot({ ...input.shift, status: "OPEN", reopenedAt: occurredAt, reopenedByActorId: actorId });
  return deepFreeze({
    event: {
      eventType: "SHIFT_REOPENED",
      organizationId: input.shift.organizationId,
      outletId: input.shift.outletId,
      shiftId: input.shift.id,
      operationKey,
      authorizationId: input.authorization.id,
      actorId,
      reason,
      before,
      after,
      occurredAt,
    },
    audit: { action: "shift.reopen", entityId: input.shift.id, operationKey, actorId, reason, before, after, occurredAt, authorizationId: input.authorization.id },
    authorizationDecision,
    next: after,
  });
}

function assertAuthorization(authorization, input, actorId, operationKey, occurredAt) {
  if (!authorization || authorization.status !== "ISSUED") throw reliabilityError("shift_reopen_authorization_required");
  const expected = {
    actorId,
    action: "shift:reopen",
    resourceType: "shift",
    resourceId: input.shift.id,
    organizationId: input.shift.organizationId,
    outletId: input.shift.outletId,
    operationKey,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (authorization[field] !== value) throw reliabilityError("shift_reopen_authorization_scope_mismatch", { field });
  }
  const expiresAt = requireIso(authorization.expiresAt, "shift_reopen_authorization_expiry_invalid");
  if (Date.parse(expiresAt) <= Date.parse(occurredAt)) throw reliabilityError("shift_reopen_authorization_expired");
  return deepFreeze({
    beforeStatus: "ISSUED",
    after: { ...structuredClone(authorization), status: "CONSUMED", consumedAt: occurredAt, consumedByOperationKey: operationKey },
    persistenceRequirement: "COMPARE_AND_SET_ISSUED_TO_CONSUMED_IN_SAME_TRANSACTION",
  });
}

function assertOutletPolicy(policy, reopeningShiftId) {
  if (!policy || !["SINGLE_ACTIVE", "MULTIPLE_NAMED"].includes(policy.mode)) throw reliabilityError("shift_outlet_policy_required");
  const activeShiftIds = policy.activeShiftIds ?? [];
  if (!Array.isArray(activeShiftIds)) throw reliabilityError("shift_outlet_policy_invalid");
  if (policy.mode === "SINGLE_ACTIVE" && activeShiftIds.some((id) => id !== reopeningShiftId)) throw reliabilityError("shift_reopen_active_shift_conflict");
  if (policy.mode === "MULTIPLE_NAMED" && !requireText(policy.shiftName, "shift_name_required", 80)) throw reliabilityError("shift_name_required");
}

function assertShiftScope(shift, input) {
  if (!shift || typeof shift !== "object") throw reliabilityError("shift_required");
  requireText(shift.id, "shift_id_required", 100);
  requireText(shift.organizationId, "organization_id_required", 100);
  requireText(shift.outletId, "outlet_id_required", 100);
  if (input.organizationId && input.organizationId !== shift.organizationId) throw reliabilityError("shift_organization_scope_mismatch");
  if (input.outletId && input.outletId !== shift.outletId) throw reliabilityError("shift_outlet_scope_mismatch");
}

function requireNonNegativeMoney(value, code) {
  const amount = requireSafeMoney(value, code);
  if (amount < 0) throw reliabilityError(code);
  return amount;
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw reliabilityError("cash_movement_overflow");
  return result;
}

function requireIso(value, code) {
  const text = requireText(value, code, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw reliabilityError(code);
  return parsed.toISOString();
}
