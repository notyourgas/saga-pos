import { createHash } from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9._:-]{8,80}$/;

export function createRemakeQueueFact({ id, orderId, reason, actorId, idempotencyKey, createdAt } = {}) {
  if (!validIdentifier(id) || !validText(orderId, 80) || !validText(actorId, 80) || !validIsoTimestamp(createdAt)) {
    throw remakeQueueError("remake_queue_input_invalid", 422);
  }
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason || normalizedReason.length > 160) throw remakeQueueError("remake_reason_required", 422);
  const queueIdempotencyKey = idempotencyKey == null ? `remake:${id}` : String(idempotencyKey).trim();
  if (!IDENTIFIER.test(queueIdempotencyKey)) throw remakeQueueError("remake_queue_idempotency_key_invalid", 422);
  const queueFingerprint = remakeQueueFingerprint({ orderId, reason: normalizedReason, actorId });
  return {
    id,
    orderId,
    reason: normalizedReason,
    actorId,
    status: "QUEUED_LOCAL",
    createsPayment: false,
    createsLoyalty: false,
    queueIdempotencyKey,
    queueFingerprint,
    createdAt,
  };
}

export function validateRemakeQueueFact(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw remakeQueueError("remake_queue_state_invalid", 500);
  let normalized;
  try {
    normalized = createRemakeQueueFact({
      id: value.id,
      orderId: value.orderId,
      reason: value.reason,
      actorId: value.actorId,
      idempotencyKey: value.queueIdempotencyKey,
      createdAt: value.createdAt,
    });
  } catch {
    throw remakeQueueError("remake_queue_state_invalid", 500);
  }
  if (value.status !== normalized.status || value.createsPayment !== false || value.createsLoyalty !== false
    || value.queueFingerprint !== normalized.queueFingerprint) throw remakeQueueError("remake_queue_state_invalid", 500);
  return normalized;
}

export function remakeQueueAuditPayload(value) {
  const fact = validateRemakeQueueFact(value);
  return { schemaVersion: 1, ...fact };
}

export function remakeQueueFactFromAudit(row) {
  const payload = row?.payload_redacted;
  const expectedPayloadKeys = [
    "actorId", "createdAt", "createsLoyalty", "createsPayment", "id", "orderId", "queueFingerprint",
    "queueIdempotencyKey", "reason", "schemaVersion", "status",
  ];
  if (!payload || Object.keys(payload).sort().join("\u0000") !== expectedPayloadKeys.sort().join("\u0000")
    || payload.schemaVersion !== 1 || row.event_type !== "order.remake.queued"
    || row.aggregate_type !== "remake" || row.aggregate_id !== payload.id
    || row.actor_reference !== payload.actorId || row.correlation_id !== payload.queueIdempotencyKey
    || normalizeIso(row.occurred_at) !== payload.createdAt) throw remakeQueueError("remake_queue_state_invalid", 500);
  return validateRemakeQueueFact(payload);
}

export function restoreRemakeQueueFacts(audits) {
  if (!Array.isArray(audits)) throw remakeQueueError("remake_queue_state_invalid", 500);
  const facts = audits.filter((row) => row.event_type === "order.remake.queued").map(remakeQueueFactFromAudit);
  const ids = new Set();
  const keys = new Set();
  for (const fact of facts) {
    if (ids.has(fact.id) || keys.has(fact.queueIdempotencyKey)) throw remakeQueueError("remake_queue_state_invalid", 500);
    ids.add(fact.id);
    keys.add(fact.queueIdempotencyKey);
  }
  return facts;
}

export function remakeQueueFingerprint({ orderId, reason, actorId } = {}) {
  return createHash("sha256").update(JSON.stringify({ orderId, reason, actorId })).digest("hex");
}

export function remakeQueueError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizeIso(value) {
  try { return new Date(value).toISOString(); } catch { return null; }
}
