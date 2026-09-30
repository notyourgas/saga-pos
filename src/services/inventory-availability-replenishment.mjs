import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const POLICY_MODES = new Set(["MIN_MAX", "REORDER_POINT", "PAR", "FORECAST_DRIVEN"]);
const PROGRESSION = Object.freeze({ RECOMMENDED: "DRAFT", DRAFT: "APPROVED" });

export function calculateAvailability(input) {
  const itemId = identifier(input?.itemId, "availability_item_required");
  const locationId = identifier(input?.locationId, "availability_location_required");
  const now = instant(input.now);
  const lots = array(input.lots, "availability_lots_required");
  const onHand = lots.reduce((sum, lot) => safeAdd(sum, quantity(lot.quantity, "availability_quantity_invalid")), 0);
  const usableOnHand = lots.reduce((sum, lot) => {
    const eligible = lot.qualityState === "USABLE" && (!lot.expiryAt || new Date(instant(lot.expiryAt)) > new Date(now));
    return safeAdd(sum, eligible ? quantity(lot.quantity, "availability_quantity_invalid") : 0);
  }, 0);
  const reserved = quantity(input.reserved ?? 0, "availability_reserved_invalid");
  const confirmedIncoming = quantity(input.confirmedIncoming ?? 0, "availability_incoming_invalid");
  const confirmedOutgoing = quantity(input.confirmedOutgoing ?? 0, "availability_outgoing_invalid");
  const plannedProduction = quantity(input.plannedProduction ?? 0, "availability_production_invalid");
  return {
    itemId, locationId, onHand, usableOnHand, reserved,
    available: safeSubtract(usableOnHand, reserved),
    incoming: confirmedIncoming,
    projected: safeSum([usableOnHand, -reserved, confirmedIncoming, -confirmedOutgoing, plannedProduction]),
    atp: safeSum([usableOnHand, -reserved, confirmedIncoming, -confirmedOutgoing]),
  };
}

export function resolveMenuAvailability(input) {
  const requirements = array(input?.requirements, "menu_requirements_required");
  if (input.manualSoldOut === true) return blocked("MANUAL_SOLD_OUT");
  if (input.scheduleActive === false) return blocked("SCHEDULE_INACTIVE");
  if (input.catalogEligible === false) return blocked("CATALOG_INELIGIBLE");
  if (input.channelEligible === false) return blocked("CHANNEL_INELIGIBLE");
  if (array(input.operationalBlocks ?? [], "menu_operational_blocks_invalid").length) return blocked("OPERATIONAL_BLOCK");
  if (requirements.length === 0) return blocked("INCOMPLETE_RECIPE");
  const stock = new Map(array(input.stockByItem, "menu_stock_required").map((row) => [identifier(row.itemId, "menu_stock_item_invalid"), row]));
  let maximum = Number.MAX_SAFE_INTEGER;
  let bottleneckItemId = null;
  for (const line of requirements) {
    const itemId = identifier(line.itemId, "menu_requirement_item_invalid");
    const required = positiveInteger(line.quantity, "menu_requirement_quantity_invalid");
    const available = quantity(stock.get(itemId)?.available ?? 0, "menu_stock_quantity_invalid");
    const possible = Math.floor(Math.max(available, 0) / required);
    if (possible < maximum) {
      maximum = possible;
      bottleneckItemId = itemId;
    }
  }
  return { available: maximum > 0, maximumQuantity: requirements.length ? maximum : 0, bottleneckItemId, blockReason: maximum > 0 ? null : "INVENTORY_STOCKOUT" };
}

export function calculateFutureAtp(input) {
  const asOf = instant(input?.asOf);
  let balance = safeSubtract(quantity(input.usableOnHand, "atp_on_hand_invalid"), quantity(input.reserved ?? 0, "atp_reserved_invalid"));
  const events = [];
  for (const commitment of array(input.commitments ?? [], "atp_commitments_invalid")) {
    events.push({ at: instant(commitment.at), delta: -positiveInteger(commitment.quantity, "atp_commitment_quantity_invalid"), kind: "COMMITMENT" });
  }
  for (const supply of array(input.supplies ?? [], "atp_supplies_invalid")) {
    if (supply.status === "CONFIRMED") events.push({ at: instant(supply.at), delta: positiveInteger(supply.quantity, "atp_supply_quantity_invalid"), kind: "CONFIRMED_SUPPLY" });
  }
  for (const expiry of array(input.expiries ?? [], "atp_expiries_invalid")) {
    events.push({ at: instant(expiry.at), delta: -positiveInteger(expiry.quantity, "atp_expiry_quantity_invalid"), kind: "EXPIRY" });
  }
  const priority = { EXPIRY: 0, COMMITMENT: 1, CONFIRMED_SUPPLY: 2 };
  events.sort((a, b) => a.at.localeCompare(b.at) || priority[a.kind] - priority[b.kind]);
  const timeline = [{ at: asOf, atp: balance, kind: "OPENING" }];
  for (const event of events) {
    if (event.at < asOf) continue;
    balance = safeAdd(balance, event.delta);
    timeline.push({ at: event.at, atp: balance, kind: event.kind });
  }
  const minimumAtp = timeline.reduce((minimum, row) => Math.min(minimum, row.atp), timeline[0].atp);
  return { asOf, currentAtp: timeline[0].atp, minimumAtp, endingAtp: balance, timeline };
}

export class InventoryAvailabilityService {
  constructor({ tenantId, outletId, inventoryPort, clock = () => new Date() } = {}) {
    this.tenantId = identifier(tenantId, "availability_tenant_required");
    this.outletId = identifier(outletId, "availability_outlet_required");
    if (!inventoryPort || typeof inventoryPort.transact !== "function") throw error("availability_inventory_port_required");
    this.inventoryPort = inventoryPort;
    this.clock = clock;
    this.operations = new Map();
    this.inFlight = new Map();
  }

  productCardQuote({ productId, coarseAvailable, cacheObservedAt }) {
    return {
      tenantId: this.tenantId,
      outletId: this.outletId,
      productId: identifier(productId, "availability_product_required"),
      available: Boolean(coarseAvailable),
      confidence: "CACHED_COARSE",
      observedAt: instant(cacheObservedAt),
      requiresCheckoutRevalidation: true,
    };
  }

  async reserveCheckout(input) {
    const operationKey = identifier(input?.operationKey, "availability_operation_key_required");
    const productId = identifier(input?.productId, "availability_product_required");
    const fingerprint = hash({ tenantId: this.tenantId, outletId: this.outletId, productId, configuration: input.configuration });
    const replay = this.operations.get(operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw error("availability_operation_collision", 409);
      return { ...structuredClone(replay.result), idempotentReplay: true };
    }
    const pending = this.inFlight.get(operationKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw error("availability_operation_collision", 409);
      const settled = await pending.promise;
      return { ...structuredClone(settled), idempotentReplay: true };
    }
    const promise = this.inventoryPort.transact(async (transaction) => {
      const resolution = await transaction.validateConfiguration({ tenantId: this.tenantId, outletId: this.outletId, productId, configuration: input.configuration });
      if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) throw error("availability_configuration_invalid");
      if (resolution.tenantId !== this.tenantId || resolution.outletId !== this.outletId) throw error("availability_configuration_scope_invalid", 500);
      const normalized = resolution.normalizedConfiguration;
      if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw error("availability_configuration_invalid");
      const requirements = array(resolution.requirements, "availability_requirements_required").map((line) => ({ itemId: identifier(line.itemId, "availability_item_required"), quantity: positiveInteger(line.quantity, "availability_quantity_invalid") }));
      if (!requirements.length || new Set(requirements.map((line) => line.itemId)).size !== requirements.length) throw error("availability_requirements_invalid");
      const checkoutFingerprint = hash({ tenantId: this.tenantId, outletId: this.outletId, productId, normalizedConfiguration: normalized, requirements });
      const reservation = await transaction.reserveExact({ tenantId: this.tenantId, outletId: this.outletId, operationKey, checkoutFingerprint, requirements, normalizedConfiguration: normalized, occurredAt: instant(this.clock()) });
      validateReservation(reservation, { tenantId: this.tenantId, outletId: this.outletId, operationKey, checkoutFingerprint, requirements });
      return { productId, normalizedConfiguration: normalized, reservation: structuredClone(reservation), idempotentReplay: reservation.idempotentReplay };
    });
    this.inFlight.set(operationKey, { fingerprint, promise });
    try {
      const result = await promise;
      const response = { ...result, idempotentReplay: result.idempotentReplay === true };
      this.operations.set(operationKey, { fingerprint, result: structuredClone(response) });
      return structuredClone(response);
    } finally {
      this.inFlight.delete(operationKey);
    }
  }
}

export function analyzeDemand(input) {
  const periods = array(input?.periods, "forecast_periods_required").map((period) => ({
    sold: quantity(period.sold, "forecast_sold_invalid"),
    stockout: period.stockout === true,
    outlier: ["PROMO", "BULK", "EVENT"].includes(period.outlier) ? period.outlier : null,
  }));
  const regular = periods.filter((period) => !period.stockout && !period.outlier);
  const censored = periods.filter((period) => period.stockout);
  const outliers = periods.filter((period) => Boolean(period.outlier));
  let baseDemand;
  if (regular.length) {
    const total = regular.reduce((sum, period) => safeAdd(sum, period.sold), 0);
    baseDemand = Math.ceil(total / regular.length);
  } else if (input.staticFallback != null) {
    baseDemand = positiveInteger(input.staticFallback, "forecast_static_fallback_invalid");
  } else {
    throw error("forecast_uncensored_history_required");
  }
  return { baseDemand, observedPeriods: periods.length, regularPeriods: regular.length, stockoutCensoredPeriods: censored.length, outlierPeriods: outliers.length };
}

export function translateProductDemand(input) {
  const productDemand = positiveInteger(input?.productDemand, "forecast_product_demand_invalid");
  return array(input.requirements, "forecast_requirements_required").map((line) => ({
    itemId: identifier(line.itemId, "forecast_item_required"),
    materialDemand: safeMultiply(productDemand, positiveInteger(line.quantity, "forecast_requirement_invalid")),
    recipeVersion: positiveInteger(line.recipeVersion, "forecast_recipe_version_invalid"),
    configurationMix: String(line.configurationMix ?? "BASE"),
    channelMix: String(line.channelMix ?? "ALL"),
  }));
}

export class ReplenishmentPlanner {
  constructor({ tenantId, clock = () => new Date(), authorizeControlledApproval = () => false, state = null, stateIntegrityKey = null } = {}) {
    this.tenantId = identifier(tenantId, "replenishment_tenant_required");
    this.clock = clock;
    this.authorizeControlledApproval = authorizeControlledApproval;
    this.stateIntegrityKey = stateIntegrityKey == null ? null : integrityKey(stateIntegrityKey);
    this.policies = new Map();
    this.recommendations = new Map();
    this.policyOperations = new Map();
    this.recommendationOperations = new Map();
    this.progressOperations = new Map();
    this.audit = [];
    if (state != null) this.#restore(state);
  }

  upsertPolicy(input) {
    const itemId = identifier(input?.itemId, "replenishment_item_required");
    const locationId = identifier(input?.locationId, "replenishment_location_required");
    const mode = String(input.mode ?? "").toUpperCase();
    if (!POLICY_MODES.has(mode)) throw error("replenishment_policy_mode_invalid");
    const values = {
      itemId, locationId, mode,
      minimum: quantity(input.minimum ?? 0, "replenishment_minimum_invalid"),
      maximum: quantity(input.maximum ?? 0, "replenishment_maximum_invalid"),
      reorderPoint: quantity(input.reorderPoint ?? 0, "replenishment_point_invalid"),
      par: quantity(input.par ?? 0, "replenishment_par_invalid"),
      staticFallback: positiveInteger(input.staticFallback ?? 1, "replenishment_fallback_invalid"),
    };
    if (values.maximum && values.maximum < values.minimum) throw error("replenishment_policy_range_invalid");
    const key = `${itemId}:${locationId}`;
    const current = this.policies.get(key);
    const expectedRevision = input.expectedRevision == null ? (current ? null : 0) : quantity(input.expectedRevision, "replenishment_policy_revision_invalid");
    const actorId = identifier(input.actorId ?? "SYSTEM", "replenishment_actor_required");
    const reason = text(input.reason ?? "INITIAL_POLICY", "replenishment_reason_required");
    const operationKey = identifier(input.operationKey ?? `POLICY:${hash({ tenantId: this.tenantId, values, expectedRevision, actorId, reason }).slice(0, 64)}`, "replenishment_operation_key_required");
    const fingerprint = hash({ tenantId: this.tenantId, values, expectedRevision, actorId, reason });
    const replay = operationReplay(this.policyOperations, operationKey, fingerprint);
    if (replay) return { ...replay, idempotentReplay: true };
    if (expectedRevision == null) throw error("replenishment_policy_revision_required", 409);
    if ((current?.revision ?? 0) !== expectedRevision) throw error("replenishment_policy_revision_conflict", 409);
    const policy = { ...values, revision: safeAdd(expectedRevision, 1), changedAt: instant(this.clock()), changedBy: actorId, changeReason: reason };
    const auditEvent = this.#createAudit("POLICY_UPSERTED", operationKey, { key, revision: policy.revision, actorId, reason });
    this.policies.set(key, policy);
    this.policyOperations.set(operationKey, { fingerprint, result: structuredClone(policy) });
    this.audit.push(auditEvent);
    return { ...structuredClone(policy), idempotentReplay: false };
  }

  recommend(input) {
    const itemId = identifier(input?.itemId, "replenishment_item_required");
    const locationId = identifier(input?.locationId, "replenishment_location_required");
    const policy = this.policies.get(`${itemId}:${locationId}`);
    if (!policy) throw error("replenishment_policy_not_found", 404);
    const usable = quantity(input.usableOnHand, "replenishment_stock_invalid");
    const reserved = quantity(input.reserved ?? 0, "replenishment_reserved_invalid");
    const incoming = quantity(input.confirmedIncoming ?? 0, "replenishment_incoming_invalid");
    const outgoing = quantity(input.confirmedOutgoing ?? 0, "replenishment_outgoing_invalid");
    const expiring = quantity(input.expiringBeforeNeed ?? 0, "replenishment_expiry_invalid");
    const inventorySourceRevision = input.inventorySourceRevision == null ? null : quantity(input.inventorySourceRevision, "replenishment_inventory_revision_invalid");
    const inventoryObservedAt = input.inventoryObservedAt == null ? null : instant(input.inventoryObservedAt);
    if ((inventorySourceRevision == null) !== (inventoryObservedAt == null)) throw error("replenishment_inventory_source_invalid");
    const safety = quantity(input.safetyStock ?? 0, "replenishment_safety_invalid");
    const leadTimeDemand = quantity(input.leadTimeDemand ?? policy.staticFallback, "replenishment_demand_invalid");
    const reliabilityBps = boundedInteger(input.supplierReliabilityBps ?? 10000, "replenishment_reliability_invalid", 1, 10000);
    const effectiveSupply = Math.max(0, safeSum([usable, -reserved, -outgoing, -expiring, incoming]));
    let target;
    if (policy.mode === "MIN_MAX") target = policy.maximum;
    else if (policy.mode === "PAR") target = policy.par;
    else if (policy.mode === "REORDER_POINT") target = effectiveSupply <= policy.reorderPoint ? safeSum([policy.reorderPoint, leadTimeDemand, safety]) : effectiveSupply;
    else target = safeSum([leadTimeDemand, safety, ceilRatio(leadTimeDemand, 10000 - reliabilityBps, 10000)]);
    const rawNeed = Math.max(0, safeSubtract(target, effectiveSupply));
    const moq = positiveInteger(input.moq ?? 1, "replenishment_moq_invalid");
    const packSize = positiveInteger(input.packSize ?? 1, "replenishment_pack_invalid");
    let rounded = rawNeed === 0 ? 0 : roundUpToMultiple(Math.max(rawNeed, moq), packSize);
    const caps = [];
    if (input.storageCap != null) caps.push(quantity(input.storageCap, "replenishment_storage_invalid"));
    if (input.budgetQuantityCap != null) caps.push(quantity(input.budgetQuantityCap, "replenishment_budget_invalid"));
    const cap = caps.length ? Math.min(...caps) : null;
    const capConstrained = cap != null && rounded > cap;
    if (capConstrained) {
      const feasible = roundDownToMultiple(cap, packSize);
      rounded = feasible >= moq ? feasible : 0;
    }
    const needBy = instant(input.needBy);
    const leadTimeDays = boundedInteger(input.leadTimeDays ?? 0, "replenishment_lead_time_invalid", 0, 36500);
    const orderByDate = new Date(needBy);
    orderByDate.setUTCDate(orderByDate.getUTCDate() - leadTimeDays);
    const operationKey = identifier(input.operationKey ?? `RECOMMEND:${hash({ tenantId: this.tenantId, itemId, locationId, needBy, policyRevision: policy.revision, rawNeed, rounded }).slice(0, 64)}`, "replenishment_operation_key_required");
    const fingerprint = hash({ tenantId: this.tenantId, itemId, locationId, policyRevision: policy.revision, usable, reserved, incoming, outgoing, expiring, inventorySourceRevision, inventoryObservedAt, safety, leadTimeDemand, reliabilityBps, moq, packSize, cap, needBy, leadTimeDays, confidence: input.forecastConfidence ?? null });
    const replay = operationReplay(this.recommendationOperations, operationKey, fingerprint);
    if (replay) return { ...replay, idempotentReplay: true };
    const id = hash({ tenantId: this.tenantId, operationKey, fingerprint }).slice(0, 32);
    const recommendation = {
      id, tenantId: this.tenantId, itemId, locationId, status: "RECOMMENDED", policyMode: policy.mode,
      policyRevision: policy.revision, statusRevision: 1,
      rawNeed, roundedRecommendation: rounded, needBy, orderBy: orderByDate.toISOString(),
      confidence: input.forecastConfidence ?? (policy.mode === "FORECAST_DRIVEN" ? "MEDIUM" : "STATIC"),
      ...(inventorySourceRevision == null ? {} : { inventorySourceRevision, inventoryObservedAt }),
      rationale: { effectiveSupply, target, leadTimeDemand, safetyStock: safety, supplierReliabilityBps: reliabilityBps, expiringBeforeNeed: expiring, moq, packSize, capConstrained },
      createdAt: instant(this.clock()),
    };
    const auditEvent = this.#createAudit("RECOMMENDATION_CREATED", operationKey, { recommendationId: id, policyRevision: policy.revision });
    this.recommendations.set(id, recommendation);
    this.recommendationOperations.set(operationKey, { fingerprint, result: structuredClone(recommendation) });
    this.audit.push(auditEvent);
    return { ...structuredClone(recommendation), idempotentReplay: false };
  }

  progress({ operationKey: requestedOperationKey, recommendationId, targetStatus, controlledAutoApproval = false, actorId, reason }) {
    const normalizedRecommendationId = identifier(recommendationId, "replenishment_recommendation_required");
    const normalizedActorId = identifier(actorId, "replenishment_actor_required");
    const normalizedReason = text(reason, "replenishment_reason_required");
    const operationKey = identifier(requestedOperationKey ?? `PROGRESS:${hash({ tenantId: this.tenantId, recommendationId: normalizedRecommendationId, targetStatus, actorId: normalizedActorId, reason: normalizedReason }).slice(0, 64)}`, "replenishment_operation_key_required");
    const fingerprint = hash({ tenantId: this.tenantId, recommendationId: normalizedRecommendationId, targetStatus, controlledAutoApproval, actorId: normalizedActorId, reason: normalizedReason });
    const replay = operationReplay(this.progressOperations, operationKey, fingerprint);
    if (replay) return { ...replay, idempotentReplay: true };
    const current = this.recommendations.get(normalizedRecommendationId);
    if (!current) throw error("replenishment_recommendation_not_found", 404);
    const expected = PROGRESSION[current.status];
    if (targetStatus !== expected) throw error("replenishment_progression_invalid", 409);
    if (targetStatus === "APPROVED" && (controlledAutoApproval !== true || this.authorizeControlledApproval({ tenantId: this.tenantId, recommendation: structuredClone(current), actorId: normalizedActorId, reason: normalizedReason }) !== true)) throw error("replenishment_auto_approval_not_authorized", 403);
    const next = { ...current, status: targetStatus, statusRevision: safeAdd(current.statusRevision, 1), actorId: normalizedActorId, reason: normalizedReason, progressedAt: instant(this.clock()) };
    const auditEvent = this.#createAudit("RECOMMENDATION_PROGRESS", operationKey, { recommendationId: current.id, from: current.status, to: targetStatus, actorId: normalizedActorId, reason: normalizedReason });
    this.recommendations.set(current.id, next);
    this.progressOperations.set(operationKey, { fingerprint, result: structuredClone(next) });
    this.audit.push(auditEvent);
    return { ...structuredClone(next), idempotentReplay: false };
  }

  auditTrail() {
    return structuredClone(this.audit);
  }

  snapshot() {
    if (!this.stateIntegrityKey) throw error("replenishment_state_integrity_key_required", 500);
    const body = {
      version: 1,
      tenantId: this.tenantId,
      policies: [...this.policies.values()].map((value) => structuredClone(value)),
      recommendations: [...this.recommendations.values()].map((value) => structuredClone(value)),
      operations: {
        policy: [...this.policyOperations.entries()].map((value) => structuredClone(value)),
        recommendation: [...this.recommendationOperations.entries()].map((value) => structuredClone(value)),
        progress: [...this.progressOperations.entries()].map((value) => structuredClone(value)),
      },
      audit: structuredClone(this.audit),
    };
    return { ...body, integrityHash: keyedHash(body, this.stateIntegrityKey) };
  }

  #restore(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw error("replenishment_state_invalid");
    const { integrityHash, ...body } = structuredClone(state);
    if (!this.stateIntegrityKey) throw error("replenishment_state_integrity_key_required", 500);
    if (typeof integrityHash !== "string" || !secureEqual(keyedHash(body, this.stateIntegrityKey), integrityHash)) throw error("replenishment_state_tampered", 409);
    if (body.version !== 1 || body.tenantId !== this.tenantId) throw error("replenishment_state_scope_invalid", 409);
    const policies = array(body.policies, "replenishment_state_invalid");
    const recommendations = array(body.recommendations, "replenishment_state_invalid");
    const operations = body.operations;
    const audit = array(body.audit, "replenishment_state_invalid");
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) throw error("replenishment_state_invalid");
    this.policies = restoreUniqueMap(policies, (policy) => `${identifier(policy.itemId, "replenishment_state_invalid")}:${identifier(policy.locationId, "replenishment_state_invalid")}`);
    this.recommendations = restoreUniqueMap(recommendations, (recommendation) => identifier(recommendation.id, "replenishment_state_invalid"));
    this.policyOperations = restoreOperationMap(operations.policy);
    this.recommendationOperations = restoreOperationMap(operations.recommendation);
    this.progressOperations = restoreOperationMap(operations.progress);
    for (const policy of this.policies.values()) positiveInteger(policy.revision, "replenishment_state_invalid");
    for (const recommendation of this.recommendations.values()) {
      if (!["RECOMMENDED", "DRAFT", "APPROVED"].includes(recommendation.status)) throw error("replenishment_state_invalid");
      positiveInteger(recommendation.statusRevision, "replenishment_state_invalid");
      if (recommendation.inventorySourceRevision != null || recommendation.inventoryObservedAt != null) {
        quantity(recommendation.inventorySourceRevision, "replenishment_state_invalid");
        instant(recommendation.inventoryObservedAt);
      }
    }
    this.audit = audit;
  }

  #createAudit(type, operationKey, detail) {
    const sequence = this.audit.length + 1;
    const event = { sequence, type, operationKey, tenantId: this.tenantId, detail: structuredClone(detail), occurredAt: instant(this.clock()) };
    event.id = hash(event);
    return event;
  }
}

function blocked(blockReason) {
  return { available: false, maximumQuantity: 0, bottleneckItemId: null, blockReason };
}

function validateReservation(reservation, expected) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) throw error("availability_reservation_invalid", 500);
  identifier(reservation.id, "availability_reservation_invalid");
  if (reservation.status !== "ACTIVE" || typeof reservation.idempotentReplay !== "boolean") throw error("availability_reservation_invalid", 500);
  if (reservation.tenantId !== expected.tenantId || reservation.outletId !== expected.outletId || reservation.operationKey !== expected.operationKey) throw error("availability_reservation_scope_invalid", 500);
  if (reservation.checkoutFingerprint !== expected.checkoutFingerprint) throw error("availability_reservation_fingerprint_invalid", 500);
  const requirements = array(reservation.requirements, "availability_reservation_requirements_invalid").map((line) => ({ itemId: identifier(line.itemId, "availability_item_required"), quantity: positiveInteger(line.quantity, "availability_quantity_invalid") }));
  if (hash(requirements) !== hash(expected.requirements)) throw error("availability_reservation_requirements_invalid", 500);
}

function operationReplay(operations, operationKey, fingerprint) {
  const existing = operations.get(operationKey);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) throw error("replenishment_operation_collision", 409);
  return structuredClone(existing.result);
}

function restoreUniqueMap(values, keyOf) {
  const result = new Map();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error("replenishment_state_invalid");
    const key = keyOf(value);
    if (result.has(key)) throw error("replenishment_state_invalid");
    result.set(key, structuredClone(value));
  }
  return result;
}

function restoreOperationMap(entries) {
  const result = new Map();
  for (const entry of array(entries, "replenishment_state_invalid")) {
    if (!Array.isArray(entry) || entry.length !== 2) throw error("replenishment_state_invalid");
    const operationKey = identifier(entry[0], "replenishment_state_invalid");
    const record = entry[1];
    if (!record || typeof record !== "object" || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !record.result || typeof record.result !== "object") throw error("replenishment_state_invalid");
    if (result.has(operationKey)) throw error("replenishment_state_invalid");
    result.set(operationKey, structuredClone(record));
  }
  return result;
}

function array(value, code) {
  if (!Array.isArray(value)) throw error(code);
  return value;
}

function quantity(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw error(code);
  return value;
}

function safeAdd(left, right) {
  const result = BigInt(left) + BigInt(right);
  return safeBigInt(result);
}

function safeSubtract(left, right) {
  const result = BigInt(left) - BigInt(right);
  return safeBigInt(result);
}

function safeSum(values) {
  return safeBigInt(values.reduce((sum, value) => sum + BigInt(value), 0n));
}

function safeMultiply(left, right) {
  return safeBigInt(BigInt(left) * BigInt(right));
}

function ceilRatio(value, multiplier, divisor) {
  return safeBigInt((BigInt(value) * BigInt(multiplier) + BigInt(divisor) - 1n) / BigInt(divisor));
}

function roundUpToMultiple(value, multiple) {
  return safeBigInt(((BigInt(value) + BigInt(multiple) - 1n) / BigInt(multiple)) * BigInt(multiple));
}

function roundDownToMultiple(value, multiple) {
  return safeBigInt((BigInt(value) / BigInt(multiple)) * BigInt(multiple));
}

function safeBigInt(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw error("inventory_planning_quantity_overflow");
  return Number(value);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw error(code);
  return value;
}

function boundedInteger(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw error(code);
  return value;
}

function identifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw error(code);
  return normalized;
}

function text(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) throw error(code);
  return normalized;
}

function instant(value) {
  if (!(value instanceof Date) && (typeof value !== "string" || value.trim() === "")) throw error("inventory_planning_timestamp_invalid");
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw error("inventory_planning_timestamp_invalid");
  return date.toISOString();
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function keyedHash(value, key) {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function integrityKey(value) {
  const normalized = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (normalized.length < 32) throw error("replenishment_state_integrity_key_invalid");
  return normalized;
}

function secureEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function error(message, status = 422) {
  const result = new Error(message);
  result.status = status;
  return result;
}
