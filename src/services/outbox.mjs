export class InMemoryOutbox {
  constructor() { this.events = new Map(); }
  enqueue(event) { if (!this.events.has(event.event_id)) this.events.set(event.event_id, { event: structuredClone(event), status: "PENDING", attempts: 0 }); return structuredClone(this.events.get(event.event_id)); }
  async drain(publish, maxAttempts = 5) { const results = []; for (const item of this.events.values()) { if (item.status !== "PENDING") continue; item.attempts += 1; try { await publish(item.event); item.status = "PUBLISHED"; item.publishedAt = new Date().toISOString(); } catch (error) { item.lastError = String(error.message ?? error); if (item.attempts >= maxAttempts) item.status = "DEAD_LETTER"; } results.push(structuredClone(item)); } return results; }
  pending() { return [...this.events.values()].filter((item) => item.status === "PENDING").map((item) => structuredClone(item)); }
  deadLetters() { return [...this.events.values()].filter((item) => item.status === "DEAD_LETTER").map((item) => structuredClone(item)); }
  replayDeadLetter(eventId, { actor, reason }) {
    const item = this.events.get(eventId);
    if (!item || item.status !== "DEAD_LETTER") throw new Error("outbox_dead_letter_not_found");
    if (!new Set(["MANAGER", "OWNER"]).has(actor?.role) || !String(reason ?? "").trim()) throw new Error("outbox_replay_approval_required");
    item.status = "PENDING";
    item.replay = { actorId: actor.id, reason: String(reason).trim(), requestedAt: new Date().toISOString(), priorAttempts: item.attempts };
    item.lastError = null;
    return structuredClone(item);
  }
}

export function buildCoffeeLifecycleEvent({ eventId, type, order, memberId, organizationId, outletId, reason = null, occurredAt = new Date().toISOString() }) {
  const eventTypes = { PAID: "coffee.order.commerce_qualified.v1", REFUNDED: "coffee.order.refund_accepted.v1", VOIDED: "coffee.order.voided.v1" };
  if (!eventTypes[type] || !eventId || !order?.id || !organizationId || !outletId) throw new Error("coffee_lifecycle_event_invalid");
  if (type === "PAID" && !memberId) throw new Error("coffee_lifecycle_member_required");
  return {
    event_id: eventId, event_type: eventTypes[type], schema_version: 1, occurred_at: occurredAt,
    producer: "sagaops", organization_id: organizationId, business_id: "kopi-saga", outlet_id: outletId,
    tenant_id: null, correlation_id: order.id, causation_id: null,
    subject: { type: memberId ? "member" : "order", id: memberId ?? order.id },
    payload: { order_id: order.id, member_id: memberId ?? null, eligible_spend: Math.max(0, Number(order.eligibleSpendRupiah ?? order.totalRupiah ?? 0)), reason },
    metadata: { classification: "internal", traceparent: null },
  };
}
