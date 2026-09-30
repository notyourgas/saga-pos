import { createHash } from "node:crypto";

export class PaymentIntentRecoveryStore {
  constructor({ storage }) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") throw new Error("recovery_storage_required");
    this.storage = storage;
  }

  save({ outletId, deviceId, orderId, paymentId, idempotencyKey, amountRupiah, status }) {
    if (!outletId || !deviceId || !orderId || !paymentId || !idempotencyKey || !Number.isInteger(amountRupiah)) throw new Error("payment_recovery_input_invalid");
    const key = this.#key(outletId, deviceId);
    const record = { outletId, deviceId, orderId, paymentId, idempotencyKey, amountRupiah, status, savedAt: new Date().toISOString() };
    this.storage.setItem(key, JSON.stringify(record));
    return structuredClone(record);
  }

  load({ outletId, deviceId }) {
    const raw = this.storage.getItem(this.#key(outletId, deviceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.outletId !== outletId || parsed.deviceId !== deviceId) throw new Error("payment_recovery_scope_mismatch");
    return structuredClone(parsed);
  }

  async resume({ outletId, deviceId, gateway }) {
    const record = this.load({ outletId, deviceId });
    if (!record) return { found: false };
    const recovery = await gateway.recoverUncertain(record.paymentId);
    if (recovery.resolved) this.storage.removeItem(this.#key(outletId, deviceId));
    else this.storage.setItem(this.#key(outletId, deviceId), JSON.stringify({ ...record, status: recovery.payment.status, lastCheckedAt: new Date().toISOString() }));
    return { found: true, record, recovery };
  }

  #key(outletId, deviceId) {
    return "sagaops:payment-recovery:" + createHash("sha256").update(outletId + ":" + deviceId).digest("hex");
  }
}

export class ReceiptPrinterBoundary {
  constructor({ adapter = null, clock = () => new Date() } = {}) {
    this.adapter = adapter;
    this.clock = clock;
    this.audit = [];
  }

  async print({ order, receipt, actorId, reprint = false }) {
    if (!order?.id || order.status !== "paid" || !receipt || !actorId) throw new Error("print_receipt_input_invalid");
    const label = reprint ? "REPRINT" : "ORIGINAL";
    if (!this.adapter) {
      const result = { status: "SKIPPED_PRINTER_UNAVAILABLE", orderId: order.id, label, orderRemainsPaid: true };
      this.audit.push({ action: "receipt.print_skipped", orderId: order.id, actorId, label, occurredAt: this.clock().toISOString() });
      return result;
    }
    await this.adapter.print({ ...receipt, label });
    this.audit.push({ action: reprint ? "receipt.reprinted" : "receipt.printed", orderId: order.id, actorId, label, occurredAt: this.clock().toISOString() });
    return { status: "PRINTED", orderId: order.id, label, orderRemainsPaid: true };
  }
}
