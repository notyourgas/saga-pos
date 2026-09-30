import { createHash } from "node:crypto";
import { RELIABILITY_PERSISTENCE_PORT_V1, deepFreeze, immutableSnapshot, reliabilityError, requireText } from "./contract.mjs";

export function createOfflineOperation(input) {
  const organizationId = requireText(input.organizationId, "organization_id_required", 100);
  const outletId = requireText(input.outletId, "outlet_id_required", 100);
  const deviceId = requireText(input.deviceId, "offline_device_id_required", 100);
  const localOperationId = requireText(input.localOperationId, "offline_local_operation_id_required", 100);
  const kind = requireText(input.kind, "offline_operation_kind_required", 80);
  const payload = immutableSnapshot(input.payload, "offline_payload_required");
  const baseVersions = normalizeVersions(input.baseVersions);
  const occurredAt = requireIso(input.occurredAt, "offline_occurred_at_invalid");
  const operationId = `OFFLINE_V1:${fingerprint([organizationId, outletId, deviceId, localOperationId])}`;
  return deepFreeze({
    contractVersion: 1,
    operationId,
    organizationId,
    outletId,
    deviceId,
    localOperationId,
    kind,
    baseVersions,
    payload,
    fingerprint: fingerprint({ kind, baseVersions, payload }),
    status: "PENDING_REPLAY",
    occurredAt,
  });
}

export function evaluateOfflineConflict(operation, currentVersions) {
  const normalized = normalizeOperation(operation);
  const current = normalizeVersions(currentVersions);
  const conflicts = [];
  for (const field of ["catalogVersion", "pricingPolicyVersion", "recipeVersion"]) {
    if (normalized.baseVersions[field] !== current[field]) {
      conflicts.push({ field, offlineVersion: normalized.baseVersions[field], currentVersion: current[field] });
    }
  }
  if (conflicts.length === 0) return deepFreeze({ decision: "APPLY", conflicts: [], operatorActionRequired: false });
  return deepFreeze({
    decision: "REVIEW_REQUIRED",
    conflicts,
    operatorActionRequired: true,
    allowedOperatorActions: ["ACCEPT_SERVER_REQUOTE", "REJECT_OFFLINE_OPERATION"],
    silentOverwriteAllowed: false,
  });
}

export function planOfflineReplay(input) {
  if (!Array.isArray(input.operations)) throw reliabilityError("offline_operations_required");
  const applied = new Map((input.appliedOperations ?? []).map((item) => [item.operationId, item.fingerprint]));
  const seen = new Map();
  const actions = [];
  const sorted = input.operations.map(normalizeOperation).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.operationId.localeCompare(right.operationId));
  for (const operation of sorted) {
    const previousFingerprint = seen.get(operation.operationId) ?? applied.get(operation.operationId);
    if (previousFingerprint) {
      if (previousFingerprint !== operation.fingerprint) throw reliabilityError("offline_operation_collision", { operationId: operation.operationId });
      actions.push({ operationId: operation.operationId, decision: "ALREADY_APPLIED_OR_QUEUED", sideEffectAllowed: false });
      continue;
    }
    seen.set(operation.operationId, operation.fingerprint);
    const currentVersions = input.currentVersionsByOperation?.[operation.operationId];
    if (!currentVersions) {
      actions.push({ operationId: operation.operationId, decision: "RETRY_LATER", reason: "SERVER_VERSION_UNAVAILABLE", sideEffectAllowed: false });
      continue;
    }
    const conflict = evaluateOfflineConflict(operation, currentVersions);
    actions.push({ operationId: operation.operationId, ...conflict, sideEffectAllowed: conflict.decision === "APPLY" });
  }
  return deepFreeze({ actions, uniqueOperationCount: seen.size, persistence: RELIABILITY_PERSISTENCE_PORT_V1 });
}

export function prepareAtomicOfflineCommit(operation) {
  const normalized = normalizeOperation(operation);
  return deepFreeze({
    operation: normalized,
    requiredTransactionSteps: [
      "insert_operation_on_unique_organization_outlet_operation_id",
      "append_commerce_or_inventory_fact",
      "append_immutable_audit_event",
      "enqueue_outbox_in_same_transaction",
    ],
    crashRecovery: "REPLAY_PENDING_OUTBOX_WITHOUT_RECREATING_BUSINESS_FACT",
    persistence: RELIABILITY_PERSISTENCE_PORT_V1,
  });
}

export function advanceOutboxItem(item, input) {
  const snapshot = immutableSnapshot(item, "outbox_item_invalid");
  requireText(snapshot.operationId, "outbox_operation_id_required", 260);
  if (!Number.isSafeInteger(snapshot.attemptCount) || snapshot.attemptCount < 0) throw reliabilityError("outbox_attempt_count_invalid");
  const attemptId = requireText(input.attemptId, "outbox_attempt_id_required", 100);
  const history = snapshot.attemptHistory ?? [];
  if (!Array.isArray(history)) throw reliabilityError("outbox_attempt_history_invalid");
  if (history.some((attempt) => attempt.attemptId === attemptId)) return snapshot;
  const outcome = requireText(input.outcome, "outbox_outcome_required", 40);
  if (!["DELIVERED", "RETRYABLE_FAILURE", "TERMINAL_FAILURE"].includes(outcome)) throw reliabilityError("outbox_outcome_invalid");
  const nextStatus = outcome === "DELIVERED" ? "DELIVERED" : outcome === "TERMINAL_FAILURE" ? "DEAD_LETTER" : "PENDING_RETRY";
  return deepFreeze({
    ...snapshot,
    status: nextStatus,
    attemptCount: snapshot.attemptCount + 1,
    attemptHistory: [...history, { attemptId, outcome, attemptedAt: requireIso(input.attemptedAt, "outbox_attempt_time_invalid") }],
  });
}

function normalizeOperation(operation) {
  const snapshot = immutableSnapshot(operation, "offline_operation_invalid");
  requireText(snapshot.operationId, "offline_operation_id_required", 420);
  const kind = requireText(snapshot.kind, "offline_operation_kind_required", 80);
  const suppliedFingerprint = requireText(snapshot.fingerprint, "offline_operation_fingerprint_required", 128);
  const occurredAt = requireIso(snapshot.occurredAt, "offline_occurred_at_invalid");
  const baseVersions = normalizeVersions(snapshot.baseVersions);
  const payload = immutableSnapshot(snapshot.payload, "offline_payload_required");
  const expectedFingerprint = fingerprint({ kind, baseVersions, payload });
  if (suppliedFingerprint !== expectedFingerprint) throw reliabilityError("offline_operation_fingerprint_mismatch");
  return deepFreeze({ ...snapshot, kind, occurredAt, baseVersions, payload, fingerprint: expectedFingerprint });
}

function normalizeVersions(value) {
  if (!value || typeof value !== "object") throw reliabilityError("offline_base_versions_required");
  const result = {};
  for (const field of ["catalogVersion", "pricingPolicyVersion", "recipeVersion"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) throw reliabilityError("offline_base_version_invalid", { field });
    result[field] = value[field];
  }
  return deepFreeze(result);
}

function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requireIso(value, code) {
  const text = requireText(value, code, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw reliabilityError(code);
  return parsed.toISOString();
}
