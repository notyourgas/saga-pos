// ACKNOWLEDGED is a sub-state of the legacy waiting/new storage state. This
// server-written projection keeps the pinned SQL enum/migration ledger intact.
// Never infer an operational state from arbitrary client input or stale payload.
const allowed = new Set(["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"]);
const key = "fulfillmentLifecycleV1";
const storageStatus = (status) => status === "ACKNOWLEDGED" ? "NEW" : status;

export function durableFulfillmentProjection(row) {
  const legacy = String(row?.status ?? "").toUpperCase();
  if (!allowed.has(legacy) || legacy === "ACKNOWLEDGED") throw failure();
  const lifecycle = row.payload_snapshot?.[key];
  if (lifecycle === undefined) return { status: legacy };
  if (!lifecycle || Array.isArray(lifecycle) || lifecycle.version !== 1
    || !allowed.has(lifecycle.status)
    || !Number.isSafeInteger(lifecycle.remakeCount) || lifecycle.remakeCount < 0) throw failure();
  for (const timestamp of [lifecycle.acknowledgedAt, lifecycle.remadeAt]) {
    if (timestamp != null && (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp)) throw failure();
  }
  if (storageStatus(lifecycle.status) !== legacy) {
    // A rollback writer ignores this additive payload and advances the legacy
    // scalar. Accept only forward legacy progress; never resurrect ACK/READY
    // over a newer authoritative scalar or permit a reverse/corrupt projection.
    const rank = { NEW: 0, ACKNOWLEDGED: 0, IN_PROGRESS: 1, READY: 2, COMPLETED: 3 };
    const forward = rank[legacy] > rank[lifecycle.status]
      || legacy === "CANCELLED" && ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(lifecycle.status);
    if (!forward) throw failure();
    return { status: legacy, acknowledgedAt: lifecycle.acknowledgedAt ?? null, remakeCount: lifecycle.remakeCount, remadeAt: lifecycle.remadeAt ?? null, lastActionReason: lifecycle.lastActionReason ?? null };
  }
  return {
    status: lifecycle.status, acknowledgedAt: lifecycle.acknowledgedAt ?? null,
    remakeCount: lifecycle.remakeCount, remadeAt: lifecycle.remadeAt ?? null,
    lastActionReason: lifecycle.lastActionReason ?? null,
  };
}

export function durableFulfillmentSnapshot(payload, ticket, timestamp) {
  const previous = payload?.[key];
  return {
    ...payload, stationProgress: ticket.stationProgress,
    [key]: {
      version: 1, status: ticket.status,
      acknowledgedAt: ticket.action === "ACKNOWLEDGED" ? timestamp : previous?.acknowledgedAt ?? null,
      remakeCount: ticket.remakeCount ?? 0, remadeAt: ticket.remadeAt ?? null,
      lastActionReason: ticket.lastActionReason ?? null,
    },
  };
}

export function durableFulfillmentStorageStatus(ticket) {
  if (!allowed.has(ticket?.status)) throw failure();
  return storageStatus(ticket.status).toLowerCase();
}

function failure() { return Object.assign(new Error("fulfillment_persistence_projection_invalid"), { code: "fulfillment_persistence_projection_invalid", statusCode: 409 }); }
