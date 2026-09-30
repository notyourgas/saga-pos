import { createHash } from "node:crypto";
import { CAPABILITY_STATUS, boundaryError, deepFreeze, requiredId } from "./contract.mjs";

export class ProviderOperationCoordinator {
  constructor({ adapter, scopeAuthorizer }) {
    if (!adapter || typeof adapter.execute !== "function" || typeof scopeAuthorizer !== "function") throw boundaryError("provider_operation_configuration_invalid", 503);
    this.adapter = adapter;
    this.scopeAuthorizer = scopeAuthorizer;
    this.operations = new Map();
  }

  async execute({ principal, resource, operationKey, payload = {} } = {}) {
    const scope = this.scopeAuthorizer(principal, resource);
    operationKey = requiredId(operationKey, "provider_operation_key_required");
    const fingerprint = digest(payload);
    const key = [scope.tenantId, scope.organizationId, scope.outletId, this.adapter.capability, operationKey].join(":");
    const current = this.operations.get(key);
    if (current && current.fingerprint !== fingerprint) throw boundaryError("provider_operation_key_conflict", 409);
    if (current?.status === "SUCCEEDED") return deepFreeze({ ...current.public, replayed: true });
    if (current?.status === CAPABILITY_STATUS.RECONCILIATION_REQUIRED) throw boundaryError("provider_operation_reconciliation_required", 409);
    if (current?.status === "FAILED_TERMINAL") throw boundaryError("provider_operation_terminal", 409);
    if (current?.pending) return current.pending;

    const attempts = (current?.attempts ?? 0) + 1;
    const context = { scope, operationKey, idempotencyKey: key, payload, attempt: attempts, dataMode: this.adapter.dataMode };
    let resolvePending;
    let rejectPending;
    const pending = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
    const pendingState = { fingerprint, status: "PENDING", attempts, pending };
    this.operations.set(key, pendingState);
    void (async () => {
      try {
        const result = await this.adapter.execute(context);
        const publicResult = deepFreeze({ operationKey, status: "SUCCEEDED", attempts, replayed: false, dataMode: this.adapter.dataMode, result });
        this.operations.set(key, { fingerprint, status: "SUCCEEDED", attempts, public: publicResult });
        resolvePending(publicResult);
      } catch (error) {
        const status = error?.sideEffectUnknown === true
          ? CAPABILITY_STATUS.RECONCILIATION_REQUIRED
          : error?.retryable === true ? "FAILED_RETRYABLE" : "FAILED_TERMINAL";
        this.operations.set(key, { fingerprint, status, attempts, lastErrorCode: safeCode(error) });
        rejectPending(error);
      }
    })();
    return pending;
  }

  status({ principal, resource, operationKey }) {
    const scope = this.scopeAuthorizer(principal, resource);
    const key = [scope.tenantId, scope.organizationId, scope.outletId, this.adapter.capability, requiredId(operationKey, "provider_operation_key_required")].join(":");
    const operation = this.operations.get(key);
    return operation ? deepFreeze({ status: operation.status, attempts: operation.attempts, lastErrorCode: operation.lastErrorCode ?? null }) : null;
  }
}

function digest(value) {
  const budget = { nodes: 0, keys: 0 };
  assertJsonValue(value, new Set(), budget, 0);
  const encoded = stableStringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 8192) throw boundaryError("provider_operation_payload_invalid");
  return createHash("sha256").update(encoded).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function safeCode(error) {
  return String(error?.code ?? "provider_operation_failed").replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 120);
}

function assertJsonValue(value, seen, budget, depth) {
  if (depth > 16 || ++budget.nodes > 512) throw boundaryError("provider_operation_payload_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw boundaryError("provider_operation_payload_invalid");
    return;
  }
  if (typeof value !== "object") throw boundaryError("provider_operation_payload_invalid");
  if (seen.has(value)) throw boundaryError("provider_operation_payload_invalid");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertJsonValue(child, seen, budget, depth + 1);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw boundaryError("provider_operation_payload_invalid");
    for (const [key, child] of Object.entries(value)) {
      if (!key || /[\u0000-\u001f]/u.test(key)) throw boundaryError("provider_operation_payload_invalid");
      if (++budget.keys > 256) throw boundaryError("provider_operation_payload_invalid");
      assertJsonValue(child, seen, budget, depth + 1);
    }
  }
  seen.delete(value);
}
