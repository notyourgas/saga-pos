import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export class NfcBridgeSimulator {
  constructor({ sharedSecret, deviceRegistry, clock = () => new Date(), debounceMs = 1200 } = {}) { if (String(sharedSecret ?? "").length < 32) throw new Error("bridge_secret_too_short"); this.secretHash = hash(sharedSecret); this.deviceRegistry = deviceRegistry; this.clock = clock; this.debounceMs = debounceMs; this.lastRead = new Map(); this.connected = false; this.deviceId = null; }
  connect({ deviceId, sharedSecret }) { if (!safeEqual(this.secretHash, hash(sharedSecret))) throw new Error("bridge_auth_invalid"); this.deviceRegistry.heartbeat(deviceId, `nfc-bridge:${deviceId}`); this.connected = true; this.deviceId = deviceId; return this.health(); }
  disconnect() { this.connected = false; return this.health(); }
  read(credential) { if (!this.connected) throw new Error("bridge_disconnected"); const fingerprint = hash(credential).toString("hex"); const previous = this.lastRead.get(fingerprint); const at = this.clock().getTime(); if (previous !== undefined && at - previous < this.debounceMs) return { accepted: false, reason: "DUPLICATE_TAP", deviceId: this.deviceId }; this.lastRead.set(fingerprint, at); return { accepted: true, readId: randomUUID(), credential, deviceId: this.deviceId, readAt: this.clock().toISOString() }; }
  health() { return { connected: this.connected, mode: "SIMULATOR", deviceId: this.deviceId, physicalReaderValidated: false }; }
}
const hash = (value) => createHash("sha256").update(String(value)).digest();
const safeEqual = (left, right) => left.length === right.length && timingSafeEqual(left, right);
