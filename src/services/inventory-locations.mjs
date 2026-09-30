import { createHash, randomUUID } from "node:crypto";

const CONTRACT = "SAGAPOS_INVENTORY_LOCATIONS_V1";
const STATE_VERSION = 1;
const ZERO_HASH = "0".repeat(64);
const SCALE = 1_000_000n;

export const INVENTORY_LOCATION_TYPES = Object.freeze([
  "INTERNAL",
  "SUPPLIER_VIRTUAL",
  "CUSTOMER_VIRTUAL",
  "WASTE",
  "TRANSIT",
  "QUARANTINE",
  "RETURN_STAGING",
  "ADJUSTMENT_COUNTERPART",
]);

const TYPE_POLICY = Object.freeze({
  INTERNAL: policy(true, true, true, ["USABLE"]),
  SUPPLIER_VIRTUAL: policy(false, false, true, ["INCOMING"]),
  CUSTOMER_VIRTUAL: policy(false, false, true, []),
  WASTE: policy(false, false, true, ["WASTE"]),
  TRANSIT: policy(false, true, true, ["TRANSIT"]),
  QUARANTINE: policy(false, true, true, ["QUARANTINE"]),
  RETURN_STAGING: policy(false, true, true, ["RETURN_STAGING"]),
  ADJUSTMENT_COUNTERPART: policy(false, false, true, ["ADJUSTMENT"]),
});

export class InventoryLocationError extends Error {
  constructor(code, statusCode = 422, detail) {
    super(code);
    this.name = "InventoryLocationError";
    this.code = code;
    this.statusCode = statusCode;
    if (detail !== undefined) this.detail = detail;
  }
}

export class InventoryLocationLedger {
  #scope;
  #idFactory;
  #facts = [];
  #operations = new Map();
  #locations = new Map();
  #positions = new Map();
  #workstations = new Map();
  #businessIds = new Map();

  constructor({ organizationId, outletId, idFactory = randomUUID } = {}) {
    this.#scope = normalizeScope({ organizationId, outletId });
    if (typeof idFactory !== "function") throw failure("inventory_location_id_factory_invalid");
    this.#idFactory = idFactory;
  }

  get revision() {
    return this.#facts.length;
  }

  createLocation(input = {}) {
    return this.#execute("LOCATION_CREATED", normalizeCreateLocation(input, this.#locations, this.#scope), (request) => {
      if (this.#locations.has(request.locationId)) throw failure("inventory_location_id_conflict", 409);
      if ([...this.#locations.values()].some((item) => item.code === request.code && item.status === "ACTIVE")) throw failure("inventory_location_code_conflict", 409);
    });
  }

  recordReceipt(input = {}) {
    return this.#execute("STOCK_RECEIVED", normalizeReceipt(input, this.#locations), (request) => assertBusinessIdAvailable(this.#businessIds, "receipt", request.receiptId));
  }

  reserveStock(input = {}) {
    return this.#execute("STOCK_RESERVED", normalizeReservation(input, this.#locations, this.#positions), (request) => assertBusinessIdAvailable(this.#businessIds, "reservation", request.reservationId));
  }

  releaseReservation(input = {}) {
    return this.#execute("STOCK_RESERVATION_RELEASED", normalizeReservationRelease(input, this.#businessIds), (request) => assertBusinessIdAvailable(this.#businessIds, "reservation-release", request.reservationId));
  }

  transferStock(input = {}) {
    return this.#execute("STOCK_TRANSFERRED", normalizeTransfer(input, this.#locations, this.#positions), (request) => assertBusinessIdAvailable(this.#businessIds, "transfer", request.transferId));
  }

  assignWorkstation(input = {}) {
    return this.#execute("WORKSTATION_ASSIGNED", normalizeWorkstation(input, this.#locations));
  }

  consumeProduction(input = {}) {
    return this.#execute("PRODUCTION_CONSUMED", normalizeProduction(input, this.#locations, this.#positions, this.#workstations), (request) => assertBusinessIdAvailable(this.#businessIds, "production", request.productionStartId));
  }

  closeLocation(input = {}) {
    return this.#execute("LOCATION_CLOSED", normalizeClosure(input, this.#locations, this.#positions, this.#workstations));
  }

  eligibility(locationId) {
    const location = this.#locations.get(cleanId(locationId, "inventory_location_id_invalid"));
    if (!location) throw failure("inventory_location_not_found", 404);
    return eligibilityView(location);
  }

  view() {
    const locations = [...this.#locations.values()].map((location) => ({
      ...structuredClone(location),
      ancestry: ancestry(location, this.#locations),
      eligibility: eligibilityView(location),
    })).sort((left, right) => left.code.localeCompare(right.code));
    const balances = [...this.#positions.values()].filter((position) => position.quantityUnits !== 0n || position.reservedUnits !== 0n).map((position) => balanceView(position, this.#locations.get(position.locationId))).sort(compareBalance);
    const quantityTotals = {
      onHandBase: formatUnits(sumUnits(balances, "onHandBase")),
      availableBase: formatUnits(sumUnits(balances, "availableBase")),
      reservedBase: formatUnits(sumUnits(balances, "reservedBase")),
      inTransitBase: formatUnits(sumUnits(balances, "inTransitBase")),
      quarantineBase: formatUnits(sumUnits(balances, "quarantineBase")),
      incomingBase: formatUnits(sumUnits(balances, "incomingBase")),
    };
    return structuredClone({
      contract: CONTRACT,
      scope: this.#scope,
      revision: this.revision,
      locations,
      balances,
      quantityTotals,
      workstations: [...this.#workstations.values()].map((item) => structuredClone(item)).sort((left, right) => left.workstationId.localeCompare(right.workstationId)),
      facts: this.#facts,
    });
  }

  exportState() {
    return structuredClone({ contract: CONTRACT, stateVersion: STATE_VERSION, scope: this.#scope, facts: this.#facts });
  }

  restoreState(state) {
    try {
      exactKeys(state, ["contract", "facts", "scope", "stateVersion"], "inventory_location_state_tampered");
      if (state.contract !== CONTRACT || state.stateVersion !== STATE_VERSION || canonical(state.scope) !== canonical(this.#scope) || !Array.isArray(state.facts) || state.facts.length > 100_000) throw failure("inventory_location_state_tampered", 500);
      const candidate = new InventoryLocationLedger({ ...this.#scope, idFactory: this.#idFactory });
      for (const fact of state.facts) candidate.#appendPersisted(fact);
      this.#facts = candidate.#facts;
      this.#operations = candidate.#operations;
      this.#locations = candidate.#locations;
      this.#positions = candidate.#positions;
      this.#workstations = candidate.#workstations;
      this.#businessIds = candidate.#businessIds;
    } catch (error) {
      if (error instanceof InventoryLocationError && error.code === "inventory_location_state_tampered") throw error;
      throw failure("inventory_location_state_tampered", 500, error?.code);
    }
  }

  #execute(type, normalized, preflight = () => {}) {
    const { envelope, request } = normalized;
    const requestFingerprint = hash({ type, request });
    const replay = this.#operations.get(envelope.operationKey);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint || replay.type !== type) throw failure("inventory_location_idempotency_conflict", 409);
      return this.#response(replay, true);
    }
    if (envelope.expectedRevision !== this.revision) throw failure("inventory_location_revision_conflict", 409, this.revision);
    preflight(request);
    const factWithoutHash = {
      factId: uuid(this.#idFactory(), "inventory_location_fact_id_invalid"),
      sequence: this.revision + 1,
      type,
      scope: this.#scope,
      operationKey: envelope.operationKey,
      requestFingerprint,
      previousFactHash: this.#facts.at(-1)?.factHash ?? ZERO_HASH,
      occurredAt: envelope.occurredAt,
      actorId: envelope.actorId,
      reason: envelope.reason,
      request,
    };
    const fact = deepFreeze({ ...factWithoutHash, factHash: hash(factWithoutHash) });
    this.#apply(fact);
    this.#facts.push(fact);
    this.#operations.set(fact.operationKey, fact);
    return this.#response(fact, false);
  }

  #appendPersisted(input) {
    exactKeys(input, ["actorId", "factHash", "factId", "occurredAt", "operationKey", "previousFactHash", "reason", "request", "requestFingerprint", "scope", "sequence", "type"], "inventory_location_state_tampered");
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== this.revision + 1
      || canonical(input.scope) !== canonical(this.#scope)
      || input.previousFactHash !== (this.#facts.at(-1)?.factHash ?? ZERO_HASH)
      || input.requestFingerprint !== hash({ type: input.type, request: input.request })) throw failure("inventory_location_state_tampered", 500);
    const withoutHash = { ...structuredClone(input) };
    delete withoutHash.factHash;
    if (input.factHash !== hash(withoutHash)) throw failure("inventory_location_state_tampered", 500);
    const normalized = normalizePersistedRequest(input.type, input, {
      locations: this.#locations,
      positions: this.#positions,
      workstations: this.#workstations,
      businessIds: this.#businessIds,
      scope: this.#scope,
    });
    if (canonical(normalized.envelope) !== canonical({ operationKey: input.operationKey, expectedRevision: input.sequence - 1, occurredAt: input.occurredAt, actorId: input.actorId, reason: input.reason })
      || canonical(normalized.request) !== canonical(input.request)) throw failure("inventory_location_state_tampered", 500);
    if (this.#operations.has(input.operationKey)) throw failure("inventory_location_state_tampered", 500);
    const fact = deepFreeze(structuredClone(input));
    this.#apply(fact);
    this.#facts.push(fact);
    this.#operations.set(fact.operationKey, fact);
  }

  #apply(fact) {
    const request = fact.request;
    if (fact.type === "LOCATION_CREATED") {
      if (this.#locations.has(request.locationId)) throw failure("inventory_location_state_tampered", 500);
      if (request.parentLocationId && !this.#locations.has(request.parentLocationId)) throw failure("inventory_location_state_tampered", 500);
      this.#locations.set(request.locationId, deepFreeze({
        id: request.locationId, code: request.code, name: request.name, type: request.type,
        parentLocationId: request.parentLocationId, custodyOrganizationId: request.custodyOrganizationId,
        economicOwnerOrganizationId: request.economicOwnerOrganizationId, valuationScopeId: request.valuationScopeId,
        status: "ACTIVE", createdAt: fact.occurredAt, mergedIntoLocationId: null,
      }));
      return;
    }
    if (fact.type === "STOCK_RECEIVED") {
      uniqueBusinessId(this.#businessIds, "receipt", request.receiptId, fact.factId);
      for (const line of request.lines) addPosition(this.#positions, request.locationId, line, parseUnits(line.quantityBase), line.inventoryValueRupiah, 0n);
      return;
    }
    if (fact.type === "STOCK_RESERVED") {
      uniqueBusinessId(this.#businessIds, "reservation", request.reservationId, fact.factId);
      addPosition(this.#positions, request.locationId, request, 0n, 0, parseUnits(request.quantityBase));
      return;
    }
    if (fact.type === "STOCK_RESERVATION_RELEASED") {
      const original = this.#facts.find((item) => item.type === "STOCK_RESERVED" && item.request.reservationId === request.reservationId);
      if (!original) throw failure("inventory_location_state_tampered", 500);
      addPosition(this.#positions, original.request.locationId, original.request, 0n, 0, -parseUnits(original.request.quantityBase));
      this.#businessIds.set(`reservation-release:${request.reservationId}`, fact.factId);
      return;
    }
    if (fact.type === "STOCK_TRANSFERRED") {
      uniqueBusinessId(this.#businessIds, "transfer", request.transferId, fact.factId);
      const quantity = parseUnits(request.quantityBase);
      addPosition(this.#positions, request.sourceLocationId, request, -quantity, -request.transferredValueRupiah, 0n);
      addPosition(this.#positions, request.destinationLocationId, request, quantity, request.transferredValueRupiah, 0n);
      return;
    }
    if (fact.type === "WORKSTATION_ASSIGNED") {
      this.#workstations.set(request.workstationId, deepFreeze({ workstationId: request.workstationId, locationId: request.locationId, assignedAt: fact.occurredAt }));
      return;
    }
    if (fact.type === "PRODUCTION_CONSUMED") {
      uniqueBusinessId(this.#businessIds, "production", request.productionStartId, fact.factId);
      addPosition(this.#positions, request.locationId, request, -parseUnits(request.quantityBase), -request.consumedValueRupiah, 0n);
      return;
    }
    if (fact.type === "LOCATION_CLOSED") {
      const source = this.#locations.get(request.locationId);
      if (!source || source.status !== "ACTIVE") throw failure("inventory_location_state_tampered", 500);
      if (request.mergeIntoLocationId) {
        for (const line of request.positions) {
          const quantity = parseUnits(line.quantityBase);
          const reserved = parseUnits(line.reservedBase);
          addPosition(this.#positions, request.locationId, line, -quantity, -line.inventoryValueRupiah, -reserved);
          addPosition(this.#positions, request.mergeIntoLocationId, line, quantity, line.inventoryValueRupiah, reserved);
        }
        for (const childId of request.childLocationIds) {
          const child = this.#locations.get(childId);
          this.#locations.set(childId, deepFreeze({ ...child, parentLocationId: request.mergeIntoLocationId }));
        }
        for (const workstationId of request.workstationIds) {
          const workstation = this.#workstations.get(workstationId);
          this.#workstations.set(workstationId, deepFreeze({ ...workstation, locationId: request.mergeIntoLocationId, assignedAt: fact.occurredAt }));
        }
      }
      this.#locations.set(source.id, deepFreeze({ ...source, status: request.mergeIntoLocationId ? "MERGED" : "CLOSED", mergedIntoLocationId: request.mergeIntoLocationId, closedAt: fact.occurredAt }));
      return;
    }
    throw failure("inventory_location_state_tampered", 500);
  }

  #response(fact, idempotentReplay) {
    const common = { fact: structuredClone(fact), revision: fact.sequence, idempotentReplay };
    if (fact.type === "LOCATION_CREATED" || fact.type === "LOCATION_CLOSED") return { ...common, location: structuredClone(this.#locations.get(fact.request.locationId)) };
    if (fact.type === "STOCK_TRANSFERRED") return { ...common, transferId: fact.request.transferId, transferredValueRupiah: fact.request.transferredValueRupiah, sameValuationScope: fact.request.sameValuationScope, valuationPreserved: true };
    if (fact.type === "WORKSTATION_ASSIGNED") return { ...common, workstation: structuredClone(this.#workstations.get(fact.request.workstationId)) };
    return common;
  }
}

function normalizeCreateLocation(input, locations, scope) {
  const envelope = normalizeEnvelope(input);
  const parentLocationId = optionalUuid(input.parentLocationId, "inventory_location_parent_invalid");
  if (parentLocationId) {
    const parent = activeLocation(locations, parentLocationId);
    if (parent.type !== "INTERNAL") throw failure("inventory_location_parent_invalid");
  }
  const type = cleanEnum(input.type, INVENTORY_LOCATION_TYPES, "inventory_location_type_invalid");
  if (parentLocationId && type !== "INTERNAL") throw failure("inventory_location_parent_invalid");
  const custodyOrganizationId = uuid(input.custodyOrganizationId, "inventory_location_custody_invalid");
  if (type === "INTERNAL" && custodyOrganizationId !== scope.organizationId) throw failure("inventory_location_custody_scope_invalid");
  return { envelope, request: {
    locationId: uuid(input.locationId, "inventory_location_id_invalid"),
    code: cleanText(input.code, 40, "inventory_location_code_invalid").toUpperCase(),
    name: cleanText(input.name, 120, "inventory_location_name_invalid"), type, parentLocationId,
    custodyOrganizationId,
    economicOwnerOrganizationId: uuid(input.economicOwnerOrganizationId, "inventory_location_owner_invalid"),
    valuationScopeId: cleanText(input.valuationScopeId, 120, "inventory_location_valuation_scope_invalid"),
  } };
}

function normalizeReceipt(input, locations) {
  const envelope = normalizeEnvelope(input);
  const location = activeLocation(locations, input.locationId);
  const disposition = cleanEnum(input.disposition, TYPE_POLICY[location.type].receiptDispositions, "inventory_location_receipt_destination_ineligible");
  const receiptId = uuid(input.receiptId, "inventory_location_receipt_id_invalid");
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500) throw failure("inventory_location_receipt_lines_invalid");
  const keys = new Set();
  const lines = input.lines.map((line) => normalizeStockLine(line, keys)).sort(compareStockLine);
  return { envelope, request: { receiptId, locationId: location.id, disposition, lines } };
}

function normalizeReservation(input, locations, positions) {
  const envelope = normalizeEnvelope(input);
  const location = activeLocation(locations, input.locationId);
  if (!TYPE_POLICY[location.type].productionConsumption) throw failure("inventory_location_reservation_ineligible");
  const request = normalizeStockIdentity(input);
  request.reservationId = uuid(input.reservationId, "inventory_location_reservation_id_invalid");
  request.locationId = location.id;
  request.quantityBase = positiveQuantity(input.quantityBase);
  const position = positions.get(positionKey(request.locationId, request.ingredientId, request.economicOwnerOrganizationId));
  if (!position || position.quantityUnits - position.reservedUnits < parseUnits(request.quantityBase)) throw failure("inventory_location_available_insufficient", 409);
  return { envelope, request };
}

function normalizeReservationRelease(input, businessIds) {
  const envelope = normalizeEnvelope(input);
  const reservationId = uuid(input.reservationId, "inventory_location_reservation_id_invalid");
  if (!businessIds.has(`reservation:${reservationId}`)) throw failure("inventory_location_reservation_not_found", 404);
  return { envelope, request: { reservationId } };
}

function normalizeTransfer(input, locations, positions) {
  const envelope = normalizeEnvelope(input);
  const source = activeLocation(locations, input.sourceLocationId);
  const destination = activeLocation(locations, input.destinationLocationId);
  if (source.id === destination.id || !TYPE_POLICY[source.type].transferSource || !TYPE_POLICY[destination.type].transferDestination) throw failure("inventory_location_transfer_ineligible");
  if ((source.type === "QUARANTINE" || source.type === "RETURN_STAGING") && destination.type !== source.type) throw failure("inventory_location_transfer_ineligible");
  const request = normalizeStockIdentity(input);
  request.transferId = uuid(input.transferId, "inventory_location_transfer_id_invalid");
  request.sourceLocationId = source.id;
  request.destinationLocationId = destination.id;
  request.quantityBase = positiveQuantity(input.quantityBase);
  const position = positions.get(positionKey(source.id, request.ingredientId, request.economicOwnerOrganizationId));
  const quantity = parseUnits(request.quantityBase);
  if (!position || position.quantityUnits - position.reservedUnits < quantity) throw failure("inventory_location_available_insufficient", 409);
  request.transferredValueRupiah = proportionalValue(position.inventoryValueRupiah, position.quantityUnits, quantity);
  request.sameValuationScope = source.valuationScopeId === destination.valuationScopeId;
  return { envelope, request };
}

function normalizeWorkstation(input, locations) {
  const envelope = normalizeEnvelope(input);
  const location = activeLocation(locations, input.locationId);
  if (!TYPE_POLICY[location.type].productionConsumption) throw failure("inventory_location_production_destination_ineligible");
  return { envelope, request: { workstationId: cleanText(input.workstationId, 80, "inventory_location_workstation_id_invalid"), locationId: location.id } };
}

function normalizeProduction(input, locations, positions, workstations) {
  const envelope = normalizeEnvelope(input);
  const workstationId = cleanText(input.workstationId, 80, "inventory_location_workstation_id_invalid");
  const workstation = workstations.get(workstationId);
  if (!workstation) throw failure("inventory_location_workstation_not_mapped", 409);
  const location = activeLocation(locations, workstation.locationId);
  if (!TYPE_POLICY[location.type].productionConsumption) throw failure("inventory_location_production_destination_ineligible");
  const request = normalizeStockIdentity(input);
  request.productionStartId = cleanText(input.productionStartId, 120, "inventory_location_production_start_invalid");
  request.workstationId = workstationId;
  request.locationId = location.id;
  request.quantityBase = positiveQuantity(input.quantityBase);
  const position = positions.get(positionKey(location.id, request.ingredientId, request.economicOwnerOrganizationId));
  const quantity = parseUnits(request.quantityBase);
  if (!position || position.quantityUnits - position.reservedUnits < quantity) throw failure("inventory_location_available_insufficient", 409);
  request.consumedValueRupiah = proportionalValue(position.inventoryValueRupiah, position.quantityUnits, quantity);
  return { envelope, request };
}

function normalizeClosure(input, locations, positions, workstations) {
  const envelope = normalizeEnvelope(input);
  const source = activeLocation(locations, input.locationId);
  const mergeIntoLocationId = optionalUuid(input.mergeIntoLocationId, "inventory_location_merge_target_invalid");
  const children = [...locations.values()].filter((item) => item.parentLocationId === source.id && item.status === "ACTIVE");
  const sourcePositions = [...positions.values()].filter((item) => item.locationId === source.id && (item.quantityUnits !== 0n || item.reservedUnits !== 0n));
  const assigned = [...workstations.values()].filter((item) => item.locationId === source.id);
  if (!mergeIntoLocationId && (children.length || sourcePositions.length || assigned.length)) throw failure("inventory_location_close_requires_merge", 409);
  if (sourcePositions.some((item) => item.quantityUnits < item.reservedUnits)) throw failure("inventory_location_state_tampered", 500);
  if (mergeIntoLocationId) {
    const target = activeLocation(locations, mergeIntoLocationId);
    if (target.id === source.id || isDescendant(target.id, source.id, locations) || target.type !== source.type
      || target.custodyOrganizationId !== source.custodyOrganizationId
      || target.economicOwnerOrganizationId !== source.economicOwnerOrganizationId
      || target.valuationScopeId !== source.valuationScopeId) throw failure("inventory_location_merge_target_invalid");
  }
  const positionsSnapshot = sourcePositions.map((item) => ({
    ingredientId: item.ingredientId, economicOwnerOrganizationId: item.economicOwnerOrganizationId,
    quantityBase: formatUnits(item.quantityUnits), reservedBase: formatUnits(item.reservedUnits), inventoryValueRupiah: item.inventoryValueRupiah,
  })).sort(compareStockLine);
  return { envelope, request: {
    locationId: source.id, mergeIntoLocationId,
    childLocationIds: children.map((item) => item.id).sort(),
    workstationIds: assigned.map((item) => item.workstationId).sort(),
    positions: positionsSnapshot,
  } };
}

function normalizePersistedRequest(type, fact, state) {
  const base = { operationKey: fact.operationKey, expectedRevision: fact.sequence - 1, occurredAt: fact.occurredAt, actorId: fact.actorId, reason: fact.reason, ...structuredClone(fact.request) };
  if (type === "LOCATION_CREATED") return normalizeCreateLocation(base, state.locations, state.scope);
  if (type === "STOCK_RECEIVED") return normalizeReceipt(base, state.locations);
  if (type === "STOCK_RESERVED") return normalizeReservation(base, state.locations, state.positions);
  if (type === "STOCK_RESERVATION_RELEASED") return normalizeReservationRelease(base, state.businessIds);
  if (type === "STOCK_TRANSFERRED") return normalizeTransfer(base, state.locations, state.positions);
  if (type === "WORKSTATION_ASSIGNED") return normalizeWorkstation(base, state.locations);
  if (type === "PRODUCTION_CONSUMED") return normalizeProduction(base, state.locations, state.positions, state.workstations);
  if (type === "LOCATION_CLOSED") return normalizeClosure(base, state.locations, state.positions, state.workstations);
  throw failure("inventory_location_state_tampered", 500);
}

function normalizeEnvelope(input) {
  return {
    operationKey: cleanText(input.operationKey, 120, "inventory_location_operation_key_invalid"),
    expectedRevision: nonnegativeInteger(input.expectedRevision, "inventory_location_revision_invalid"),
    occurredAt: timestamp(input.occurredAt, "inventory_location_timestamp_invalid"),
    actorId: cleanText(input.actorId, 120, "inventory_location_actor_invalid"),
    reason: cleanText(input.reason, 240, "inventory_location_reason_invalid"),
  };
}

function normalizeScope(input) {
  return deepFreeze({
    organizationId: uuid(input.organizationId, "inventory_location_scope_invalid"),
    outletId: uuid(input.outletId, "inventory_location_scope_invalid"),
  });
}

function normalizeStockLine(line, keys) {
  if (!line || typeof line !== "object" || Array.isArray(line)) throw failure("inventory_location_stock_line_invalid");
  const normalized = normalizeStockIdentity(line);
  const key = `${normalized.ingredientId}\u0000${normalized.economicOwnerOrganizationId}`;
  if (keys.has(key)) throw failure("inventory_location_stock_line_duplicate");
  keys.add(key);
  return { ...normalized, quantityBase: positiveQuantity(line.quantityBase), inventoryValueRupiah: positiveMoney(line.inventoryValueRupiah) };
}

function normalizeStockIdentity(input) {
  return {
    ingredientId: cleanText(input.ingredientId, 120, "inventory_location_ingredient_id_invalid"),
    economicOwnerOrganizationId: uuid(input.economicOwnerOrganizationId, "inventory_location_owner_invalid"),
  };
}

function activeLocation(locations, value) {
  const id = uuid(value, "inventory_location_id_invalid");
  const location = locations.get(id);
  if (!location) throw failure("inventory_location_not_found", 404);
  if (location.status !== "ACTIVE") throw failure("inventory_location_inactive", 409);
  return location;
}

function eligibilityView(location) {
  const type = TYPE_POLICY[location.type];
  const active = location.status === "ACTIVE";
  return {
    receipt: active && type.receiptDispositions.length > 0,
    transferSource: active && type.transferSource,
    transferDestination: active && type.transferDestination,
    productionConsumption: active && type.productionConsumption,
    receiptDispositions: [...type.receiptDispositions],
  };
}

function policy(productionConsumption, transferSource, transferDestination, receiptDispositions) {
  return Object.freeze({ productionConsumption, transferSource, transferDestination, receiptDispositions: Object.freeze(receiptDispositions) });
}

function addPosition(positions, locationId, line, quantityDelta, valueDelta, reservedDelta) {
  const key = positionKey(locationId, line.ingredientId, line.economicOwnerOrganizationId);
  const prior = positions.get(key) ?? { locationId, ingredientId: line.ingredientId, economicOwnerOrganizationId: line.economicOwnerOrganizationId, quantityUnits: 0n, reservedUnits: 0n, inventoryValueRupiah: 0 };
  const next = { ...prior, quantityUnits: prior.quantityUnits + quantityDelta, reservedUnits: prior.reservedUnits + reservedDelta, inventoryValueRupiah: prior.inventoryValueRupiah + valueDelta };
  if (next.quantityUnits < 0n || next.reservedUnits < 0n || next.reservedUnits > next.quantityUnits || !Number.isSafeInteger(next.inventoryValueRupiah) || next.inventoryValueRupiah < 0 || (next.quantityUnits === 0n && next.inventoryValueRupiah !== 0)) throw failure("inventory_location_position_invalid", 500);
  positions.set(key, next);
}

function balanceView(position, location) {
  const quantity = position.quantityUnits;
  const reserved = location.type === "INTERNAL" ? position.reservedUnits : 0n;
  const onHand = location.type === "INTERNAL" ? quantity : 0n;
  return {
    locationId: position.locationId,
    ingredientId: position.ingredientId,
    custodyOrganizationId: location.custodyOrganizationId,
    economicOwnerOrganizationId: position.economicOwnerOrganizationId,
    valuationScopeId: location.valuationScopeId,
    quantityBase: formatUnits(quantity),
    inventoryValueRupiah: position.inventoryValueRupiah,
    averageCostPerBaseUnitRupiah: unitCost(position.inventoryValueRupiah, quantity),
    onHandBase: formatUnits(onHand),
    availableBase: formatUnits(onHand - reserved),
    reservedBase: formatUnits(reserved),
    inTransitBase: formatUnits(location.type === "TRANSIT" ? quantity : 0n),
    quarantineBase: formatUnits(location.type === "QUARANTINE" ? quantity : 0n),
    incomingBase: formatUnits(location.type === "SUPPLIER_VIRTUAL" ? quantity : 0n),
  };
}

function ancestry(location, locations) {
  const ids = [];
  const seen = new Set([location.id]);
  let parentId = location.parentLocationId;
  while (parentId) {
    if (seen.has(parentId)) throw failure("inventory_location_state_tampered", 500);
    seen.add(parentId);
    ids.unshift(parentId);
    parentId = locations.get(parentId)?.parentLocationId ?? null;
  }
  return ids;
}

function isDescendant(candidateId, ancestorId, locations) {
  let current = locations.get(candidateId);
  while (current?.parentLocationId) {
    if (current.parentLocationId === ancestorId) return true;
    current = locations.get(current.parentLocationId);
  }
  return false;
}

function uniqueBusinessId(map, kind, id, factId) {
  const key = `${kind}:${id}`;
  if (map.has(key)) throw failure("inventory_location_state_tampered", 500);
  map.set(key, factId);
}

function assertBusinessIdAvailable(map, kind, id) {
  if (map.has(`${kind}:${id}`)) throw failure("inventory_location_business_id_conflict", 409);
}

function proportionalValue(value, availableUnits, quantityUnits) {
  if (quantityUnits === availableUnits) return value;
  return safeNumber(divideHalfUp(BigInt(value) * quantityUnits, availableUnits), "inventory_location_value_overflow");
}

function unitCost(value, units) {
  if (units === 0n) return "0.000000";
  return formatUnits(divideHalfUp(BigInt(value) * SCALE * SCALE, units));
}

function divideHalfUp(numerator, denominator) {
  if (denominator <= 0n) throw failure("inventory_location_quantity_invalid");
  return (numerator + denominator / 2n) / denominator;
}

function sumUnits(rows, key) {
  return rows.reduce((sum, row) => sum + parseUnits(row[key]), 0n);
}

function positiveQuantity(value) {
  const units = parseUnits(value);
  if (units <= 0n) throw failure("inventory_location_quantity_invalid");
  return formatUnits(units);
}

function parseUnits(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,12})\.\d{6}$/.test(value)) throw failure("inventory_location_quantity_invalid");
  const [whole, decimal] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(decimal);
}

function formatUnits(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  return `${negative ? "-" : ""}${absolute / SCALE}.${String(absolute % SCALE).padStart(6, "0")}`;
}

function positiveMoney(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure("inventory_location_value_invalid");
  return value;
}

function nonnegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(code);
  return value;
}

function safeNumber(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw failure(code);
  return number;
}

function cleanText(value, max, code) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure(code);
  return value;
}

function cleanEnum(value, allowed, code) {
  if (!allowed.includes(value)) throw failure(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure(code);
  return value.toLowerCase();
}

function optionalUuid(value, code) {
  return value == null ? null : uuid(value, code);
}

function timestamp(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure(code);
  return value;
}

function positionKey(locationId, ingredientId, ownerId) {
  return `${locationId}\u0000${ingredientId}\u0000${ownerId}`;
}

function compareStockLine(left, right) {
  return left.ingredientId.localeCompare(right.ingredientId) || left.economicOwnerOrganizationId.localeCompare(right.economicOwnerOrganizationId);
}

function compareBalance(left, right) {
  return left.locationId.localeCompare(right.locationId) || compareStockLine(left, right);
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure(code, 500);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function failure(code, statusCode = 422, detail) {
  return new InventoryLocationError(code, statusCode, detail);
}
