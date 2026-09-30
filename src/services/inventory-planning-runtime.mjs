import { createHash } from "node:crypto";

import {
  ReplenishmentPlanner,
  calculateAvailability,
  calculateFutureAtp,
} from "./inventory-availability-replenishment.mjs";

const AVAILABILITY_ROLES = new Set(["owner", "cashier", "bar"]);
const REPLENISHMENT_READ_ROLES = new Set(["owner", "finance"]);
const POLICY_KEYS = new Set(["operationKey", "itemId", "locationId", "mode", "minimum", "maximum", "reorderPoint", "par", "staticFallback", "expectedRevision", "reason"]);
const RECOMMENDATION_KEYS = new Set(["operationKey", "itemId", "locationId", "safetyStock", "leadTimeDemand", "supplierReliabilityBps", "moq", "packSize", "storageCap", "budgetQuantityCap", "leadTimeDays", "forecastConfidence", "needBy"]);

export class InventoryPlanningRuntime {
  constructor({ ids, inventoryReadProvider, replenishmentStore, stateIntegrityKey, clock = () => new Date(), maxCasAttempts = 3 } = {}) {
    this.ids = Object.freeze({
      organizationId: identifier(ids?.organizationId, "inventory_planning_organization_required"),
      outletId: identifier(ids?.outletId, "inventory_planning_outlet_required"),
    });
    if (!inventoryReadProvider || typeof inventoryReadProvider.loadAvailability !== "function") throw runtimeError("inventory_planning_read_provider_required");
    if (!replenishmentStore || typeof replenishmentStore.load !== "function" || typeof replenishmentStore.compareAndSwap !== "function") throw runtimeError("replenishment_store_required");
    if (!Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1 || maxCasAttempts > 5) throw runtimeError("replenishment_cas_attempts_invalid");
    this.inventoryReadProvider = inventoryReadProvider;
    this.replenishmentStore = replenishmentStore;
    this.stateIntegrityKey = stateIntegrityKey;
    this.clock = clock;
    this.maxCasAttempts = maxCasAttempts;
  }

  async availability(actor, input = {}) {
    authorize(actor, AVAILABILITY_ROLES, "inventory_availability_role_denied");
    requireInputObject(input);
    rejectScopeOverride(input);
    const snapshot = await this.#loadInventory(input);
    let availability;
    try {
      availability = calculateAvailability({
        itemId: snapshot.itemId,
        locationId: snapshot.locationId,
        now: snapshot.observedAt,
        lots: snapshot.lots,
        reserved: snapshot.reserved,
        confirmedIncoming: snapshot.confirmedIncoming,
        confirmedOutgoing: snapshot.confirmedOutgoing,
        plannedProduction: snapshot.plannedProduction,
      });
    } catch {
      throw runtimeError("inventory_planning_provider_output_invalid", 500);
    }
    return {
      source: "DURABLE_INVENTORY_READ_PROVIDER",
      sourceRevision: snapshot.revision,
      observedAt: snapshot.observedAt,
      availability,
    };
  }

  async atp(actor, input = {}) {
    authorize(actor, AVAILABILITY_ROLES, "inventory_availability_role_denied");
    requireInputObject(input);
    rejectScopeOverride(input);
    const asOf = input.asOf == null ? null : instant(input.asOf);
    const snapshot = await this.#loadInventory(input);
    let timeline;
    try {
      const availability = calculateAvailability({ itemId: snapshot.itemId, locationId: snapshot.locationId, now: snapshot.observedAt, lots: snapshot.lots, reserved: snapshot.reserved, confirmedIncoming: snapshot.confirmedIncoming, confirmedOutgoing: snapshot.confirmedOutgoing, plannedProduction: snapshot.plannedProduction });
      timeline = calculateFutureAtp({ asOf: asOf ?? snapshot.observedAt, usableOnHand: availability.usableOnHand, reserved: snapshot.reserved, commitments: snapshot.commitments, supplies: snapshot.supplies, expiries: snapshot.expiries });
    } catch {
      throw runtimeError("inventory_planning_provider_output_invalid", 500);
    }
    return { source: "DURABLE_INVENTORY_READ_PROVIDER", sourceRevision: snapshot.revision, observedAt: snapshot.observedAt, ...timeline };
  }

  async replenishment(actor, input = {}) {
    authorize(actor, REPLENISHMENT_READ_ROLES, "replenishment_read_role_denied");
    requireInputObject(input);
    rejectScopeOverride(input);
    const loaded = await this.#loadPlanner();
    const snapshot = loaded.planner.snapshot();
    const itemId = optionalIdentifier(input.itemId, "replenishment_item_required");
    const locationId = optionalIdentifier(input.locationId, "replenishment_location_required");
    return {
      source: "DURABLE_REPLENISHMENT_STORE",
      revision: loaded.revision,
      policies: snapshot.policies.filter((row) => (!itemId || row.itemId === itemId) && (!locationId || row.locationId === locationId)).map(publicPolicy),
      recommendations: snapshot.recommendations.filter((row) => (!itemId || row.itemId === itemId) && (!locationId || row.locationId === locationId)).map(publicRecommendation),
      auditCount: snapshot.audit.length,
    };
  }

  async recommend(actor, input = {}) {
    const actorId = authorize(actor, new Set(["owner"]), "replenishment_recommend_role_denied");
    requireInputObject(input);
    rejectScopeOverride(input);
    rejectUnknownKeys(input, RECOMMENDATION_KEYS);
    if (input.forecastConfidence != null && (typeof input.forecastConfidence !== "string" || !input.forecastConfidence.trim() || input.forecastConfidence.length > 40)) throw runtimeError("replenishment_confidence_invalid", 422);
    const operationKey = identifier(input.operationKey, "replenishment_operation_key_required");
    const needBy = instant(input.needBy);
    const inventory = await this.#authoritativeRecommendationInventory({ ...input, needBy });
    const command = { ...input, needBy, ...inventory };
    const operationFingerprint = fingerprint({ scope: this.ids, actorId, command });
    for (let attempt = 1; attempt <= this.maxCasAttempts; attempt += 1) {
      const loaded = await this.#loadPlanner();
      let recommendation;
      try {
        recommendation = loaded.planner.recommend({ ...command, operationKey });
      } catch (error) {
        throw exposeDomainError(error);
      }
      if (recommendation.idempotentReplay) return { ...publicRecommendation(recommendation), persistenceRevision: loaded.revision };
      const state = loaded.planner.snapshot();
      let persisted;
      try {
        persisted = await this.replenishmentStore.compareAndSwap({
          ...this.ids,
          expectedRevision: loaded.revision,
          operationKey,
          operationFingerprint,
          actorId,
          state,
          occurredAt: instant(this.clock()),
        });
      } catch (error) {
        if (error?.code === "inventory_planning_revision_conflict" || error?.message === "inventory_planning_revision_conflict") continue;
        if (error?.code === "inventory_planning_operation_collision") throw runtimeError("inventory_planning_operation_collision", 409);
        throw providerError();
      }
      validatePersisted(persisted, { ...this.ids, expectedRevision: loaded.revision, operationKey, operationFingerprint, stateHash: state.integrityHash });
      return { ...publicRecommendation(recommendation), persistenceRevision: persisted.revision };
    }
    throw runtimeError("inventory_planning_revision_conflict", 409);
  }

  async upsertPolicy(actor, input = {}) {
    const actorId = authorize(actor, new Set(["owner"]), "replenishment_policy_role_denied");
    requireInputObject(input);
    rejectScopeOverride(input);
    rejectUnknownKeys(input, POLICY_KEYS);
    const operationKey = identifier(input.operationKey, "replenishment_operation_key_required");
    const itemId = identifier(input.itemId, "replenishment_item_required");
    const locationId = input.locationId == null
      ? `${this.ids.outletId}:USABLE`
      : identifier(input.locationId, "replenishment_location_required");
    const expectedRevision = requestRevision(input.expectedRevision);
    const reason = boundedText(input.reason, "replenishment_reason_required", 240);
    // Policy setup must also work before the first receipt creates a balance.
    // The provider validates the active ingredient and canonical location without
    // requiring discrete stock. Older providers retain the availability fallback.
    if (typeof this.inventoryReadProvider.validatePolicyTarget === "function") {
      try {
        await this.inventoryReadProvider.validatePolicyTarget({ ...this.ids, itemId, locationId });
      } catch (error) {
        if (error?.code === "inventory_planning_item_not_found") throw runtimeError(error.code, 404);
        if (error?.code === "inventory_planning_location_not_canonical") throw runtimeError(error.code, 422);
        throw providerError();
      }
    } else {
      await this.#loadInventory({ itemId, locationId });
    }
    const command = { ...input, operationKey, itemId, locationId, expectedRevision, reason, actorId };
    const operationFingerprint = fingerprint({ scope: this.ids, actorId, command });
    for (let attempt = 1; attempt <= this.maxCasAttempts; attempt += 1) {
      const loaded = await this.#loadPlanner();
      let policy;
      try {
        policy = loaded.planner.upsertPolicy(command);
      } catch (error) {
        throw exposeDomainError(error);
      }
      if (policy.idempotentReplay) return { ...publicPolicy(policy), persistenceRevision: loaded.revision };
      const state = loaded.planner.snapshot();
      let persisted;
      try {
        persisted = await this.replenishmentStore.compareAndSwap({
          ...this.ids,
          expectedRevision: loaded.revision,
          operationKey,
          operationFingerprint,
          actorId,
          state,
          occurredAt: instant(this.clock()),
        });
      } catch (error) {
        if (error?.code === "inventory_planning_revision_conflict" || error?.message === "inventory_planning_revision_conflict") continue;
        if (error?.code === "inventory_planning_operation_collision") throw runtimeError("inventory_planning_operation_collision", 409);
        throw providerError();
      }
      validatePersisted(persisted, { ...this.ids, expectedRevision: loaded.revision, operationKey, operationFingerprint, stateHash: state.integrityHash });
      return { ...publicPolicy(policy), persistenceRevision: persisted.revision };
    }
    throw runtimeError("inventory_planning_revision_conflict", 409);
  }

  async #authoritativeRecommendationInventory(input) {
    const snapshot = await this.#loadInventory(input);
    try {
      const availability = calculateAvailability({
        itemId: snapshot.itemId,
        locationId: snapshot.locationId,
        now: snapshot.observedAt,
        lots: snapshot.lots,
        reserved: snapshot.reserved,
        confirmedIncoming: snapshot.confirmedIncoming,
        confirmedOutgoing: snapshot.confirmedOutgoing,
        plannedProduction: snapshot.plannedProduction,
      });
      return {
        usableOnHand: availability.usableOnHand,
        reserved: availability.reserved,
        confirmedIncoming: availability.incoming,
        confirmedOutgoing: providerQuantity(snapshot.confirmedOutgoing),
        expiringBeforeNeed: expiriesBeforeNeed(snapshot.expiries, snapshot.observedAt, input.needBy),
        inventorySourceRevision: snapshot.revision,
        inventoryObservedAt: snapshot.observedAt,
      };
    } catch {
      throw runtimeError("inventory_planning_provider_output_invalid", 500);
    }
  }

  async #loadInventory(input) {
    const itemId = identifier(input.itemId, "availability_item_required");
    const locationId = identifier(input.locationId, "availability_location_required");
    let result;
    try {
      result = await this.inventoryReadProvider.loadAvailability({ ...this.ids, itemId, locationId });
    } catch (error) {
      if (error?.code === "inventory_planning_item_not_found") throw runtimeError(error.code, 404);
      if (error?.code === "inventory_planning_location_not_canonical") throw runtimeError(error.code, 422);
      throw providerError();
    }
    return validateInventorySnapshot(result, { ...this.ids, itemId, locationId });
  }

  async #loadPlanner() {
    let loaded;
    try {
      loaded = await this.replenishmentStore.load(this.ids);
    } catch {
      throw providerError();
    }
    validateLoadedPlanner(loaded, this.ids);
    try {
      const planner = new ReplenishmentPlanner({
        tenantId: `${this.ids.organizationId}:${this.ids.outletId}`,
        clock: this.clock,
        stateIntegrityKey: this.stateIntegrityKey,
        state: loaded.state,
      });
      return { revision: loaded.revision, planner };
    } catch (error) {
      if (String(error?.message ?? "").startsWith("replenishment_state_")) throw runtimeError("inventory_planning_persisted_state_invalid", 500);
      throw exposeDomainError(error);
    }
  }
}

function validateInventorySnapshot(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  if (value.organizationId !== expected.organizationId || value.outletId !== expected.outletId || value.itemId !== expected.itemId || value.locationId !== expected.locationId) throw runtimeError("inventory_planning_provider_scope_invalid", 500);
  const revision = nonNegativeInteger(value.revision, "inventory_planning_provider_output_invalid");
  const observedAt = providerInstant(value.observedAt);
  if (!Array.isArray(value.lots)) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  return {
    ...structuredClone(value),
    revision,
    observedAt,
    reserved: value.reserved ?? 0,
    confirmedIncoming: value.confirmedIncoming ?? 0,
    confirmedOutgoing: value.confirmedOutgoing ?? 0,
    plannedProduction: value.plannedProduction ?? 0,
    commitments: value.commitments ?? [],
    supplies: value.supplies ?? [],
    expiries: value.expiries ?? [],
  };
}

function expiriesBeforeNeed(expiries, observedAt, needBy) {
  if (!Array.isArray(expiries)) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  const observedMs = Date.parse(observedAt);
  const needByMs = Date.parse(needBy);
  let total = 0n;
  for (const expiry of expiries) {
    if (!expiry || typeof expiry !== "object" || Array.isArray(expiry)) throw runtimeError("inventory_planning_provider_output_invalid", 500);
    const atMs = Date.parse(providerInstant(expiry.at));
    const quantity = providerQuantity(expiry.quantity);
    if (atMs >= observedMs && atMs <= needByMs) total += BigInt(quantity);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  }
  return Number(total);
}

function providerQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  return value;
}

function providerInstant(value) {
  if (!(value instanceof Date) && (typeof value !== "string" || value.trim() === "")) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw runtimeError("inventory_planning_provider_output_invalid", 500);
  return date.toISOString();
}

function validateLoadedPlanner(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.organizationId !== scope.organizationId || value.outletId !== scope.outletId || !value.state) throw runtimeError("inventory_planning_provider_scope_invalid", 500);
  const revision = nonNegativeInteger(value.revision, "inventory_planning_provider_output_invalid");
  if (revision === Number.MAX_SAFE_INTEGER) throw runtimeError("inventory_planning_provider_output_invalid", 500);
}

function validatePersisted(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.organizationId !== expected.organizationId || value.outletId !== expected.outletId
    || value.operationKey !== expected.operationKey || value.operationFingerprint !== expected.operationFingerprint
    || value.stateHash !== expected.stateHash || value.revision !== expected.expectedRevision + 1) {
    throw runtimeError("inventory_planning_provider_output_invalid", 500);
  }
}

function publicPolicy(value) {
  const { tenantId: _tenantId, ...result } = structuredClone(value);
  return result;
}

function publicRecommendation(value) {
  const { tenantId: _tenantId, ...result } = structuredClone(value);
  return result;
}

function authorize(actor, roles, code) {
  const role = String(actor?.role ?? "").toLowerCase();
  const actorId = actor?.employeeId ?? actor?.userAccountId ?? actor?.userProfileId;
  if (!roles.has(role) || !actorId) throw runtimeError(code, 403);
  return identifier(actorId, "inventory_planning_actor_invalid");
}

function rejectScopeOverride(input) {
  if (input.organizationId != null || input.outletId != null || input.tenantId != null) throw runtimeError("inventory_planning_scope_override_denied", 403);
}

function requireInputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw runtimeError("inventory_planning_request_invalid", 422);
}

function rejectUnknownKeys(input, allowed) {
  if (Object.keys(input).some((key) => !allowed.has(key))) throw runtimeError("inventory_planning_request_invalid", 422);
}

function optionalIdentifier(value, code) {
  return value == null || value === "" ? null : identifier(value, code);
}

function requestRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw runtimeError("replenishment_policy_revision_invalid", 422);
  return value;
}

function boundedText(value, code, maxLength) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw runtimeError(code, 422);
  return value;
}

function identifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw runtimeError(code, 422);
  return normalized;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw runtimeError(code, 500);
  return value;
}

function instant(value) {
  if (!(value instanceof Date) && (typeof value !== "string" || value.trim() === "")) throw runtimeError("inventory_planning_timestamp_invalid", 422);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw runtimeError("inventory_planning_timestamp_invalid", 422);
  return date.toISOString();
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exposeDomainError(error) {
  const code = String(error?.code ?? error?.message ?? "");
  if (/^(availability|atp|forecast|replenishment|inventory_planning)_[a-z0-9_]{1,70}$/.test(code)) return runtimeError(code, Number(error?.statusCode ?? error?.status ?? 422));
  return runtimeError("inventory_planning_request_invalid", 422);
}

function providerError() {
  return runtimeError("inventory_planning_provider_unavailable", 503);
}

function runtimeError(code, statusCode = 422) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
