import { randomUUID } from "node:crypto";

const TRANSITIONS = { CREATED: ["PENDING", "EXPIRED", "CANCELLED"], PENDING: ["PAID", "FAILED", "EXPIRED", "CANCELLED"], PAID: ["REFUNDED"], FAILED: [], EXPIRED: [], CANCELLED: [], REFUNDED: [] };

export class SagadevGatewaySimulator {
  constructor({ clock = () => new Date() } = {}) { this.clock = clock; this.payments = new Map(); this.callbacks = new Set(); }
  create({ orderId, amountRupiah, idempotencyKey }) { const prior = [...this.payments.values()].find((item) => item.idempotencyKey === idempotencyKey); if (prior) return structuredClone(prior); const payment = { id: randomUUID(), orderId, amountRupiah, idempotencyKey, status: "CREATED", qrPayload: `SAGADEV-LOCAL-${randomUUID()}`, expiresAt: new Date(this.clock().getTime() + 10 * 60_000).toISOString(), createdAt: this.clock().toISOString() }; this.payments.set(payment.id, payment); return structuredClone(payment); }
  restore(input = {}, { replace = false } = {}) {
    const payment = structuredClone(input);
    if (!payment.id || !payment.orderId || !Number.isSafeInteger(payment.amountRupiah) || payment.amountRupiah < 0) throw new Error("payment_restore_invalid");
    if (!Object.hasOwn(TRANSITIONS, payment.status)) throw new Error("payment_restore_status_invalid");
    if (!payment.idempotencyKey || !payment.qrPayload || !payment.expiresAt) throw new Error("payment_restore_invalid");
    const existing = this.payments.get(payment.id);
    if (!replace && existing && JSON.stringify(existing) !== JSON.stringify(payment)) throw new Error("payment_restore_conflict");
    this.payments.set(payment.id, payment);
    return structuredClone(payment);
  }
  snapshot() { return { payments: structuredClone([...this.payments]), callbacks: structuredClone([...this.callbacks]) }; }
  replace(snapshot = {}) {
    if (!Array.isArray(snapshot.payments) || !Array.isArray(snapshot.callbacks)) throw new Error("gateway_snapshot_invalid");
    this.payments = new Map();
    for (const [, payment] of snapshot.payments) this.restore(payment);
    this.callbacks = new Set(snapshot.callbacks.map((value) => String(value)));
  }
  transition(paymentId, target, callbackId = randomUUID()) { if (this.callbacks.has(callbackId)) return { duplicate: true, payment: structuredClone(this.payments.get(paymentId)) }; const payment = this.payments.get(paymentId); if (!payment) throw new Error("payment_not_found"); if (!TRANSITIONS[payment.status]?.includes(target)) throw new Error(`payment_transition_invalid:${payment.status}:${target}`); this.callbacks.add(callbackId); payment.status = target; payment.updatedAt = this.clock().toISOString(); return { duplicate: false, payment: structuredClone(payment) }; }
  expireDue() { const expired = []; for (const payment of this.payments.values()) if (["CREATED", "PENDING"].includes(payment.status) && new Date(payment.expiresAt) <= this.clock()) expired.push(this.transition(payment.id, "EXPIRED", `expiry:${payment.id}`).payment); return expired; }
}
