import { createHash, randomUUID } from "node:crypto";

const CONTRACT = "SAGAPOS_INVENTORY_WASTE_COUNT_V1";
const STATE_VERSION = 1;
const ZERO_HASH = "0".repeat(64);

export const INVENTORY_CONSUMPTION_DISPOSITIONS = Object.freeze([
  "WASTE", "SPOILAGE", "DAMAGE", "REMAKE", "STAFF_INTERNAL", "SAMPLING",
  "COMPLIMENTARY", "TRANSFER_LOSS", "OTHER",
]);
export const INVENTORY_COUNT_TYPES = Object.freeze(["FULL", "CYCLE", "SPOT", "OPENING"]);
export const INVENTORY_COUNT_MODES = Object.freeze(["FREEZE", "LIVE"]);

const DISPOSITIONS = new Set(INVENTORY_CONSUMPTION_DISPOSITIONS);
const COUNT_TYPES = new Set(INVENTORY_COUNT_TYPES);
const COUNT_MODES = new Set(INVENTORY_COUNT_MODES);
const REVIEW_DECISIONS = new Set(["APPROVE", "REJECT_CLASSIFICATION", "RECLASSIFY"]);
const VARIANCE_CLASSIFICATIONS = new Set(["MISSING_RECEIPT", "MISSING_TRANSFER", "UNRECORDED_WASTE", "DAMAGE", "OTHER_EVIDENCED"]);

export class InventoryWasteCountError extends Error {
  constructor(code, statusCode = 422, detail) {
    super(code);
    this.name = "InventoryWasteCountError";
    this.code = code;
    this.statusCode = statusCode;
    if (detail !== undefined) this.detail = detail;
  }
}

export class InventoryWasteCountWorkflow {
  constructor({ hppCatalog, organizationId, outletId, clock = () => new Date(), idFactory = randomUUID, lotProvider = () => [], productionConsumptionProvider } = {}) {
    if (!hppCatalog?.view || !hppCatalog?.exportState || !hppCatalog?.restoreState || !hppCatalog?.recordInventoryMovement) throw failure("inventory_control_hpp_catalog_required");
    if (typeof clock !== "function" || typeof idFactory !== "function" || typeof lotProvider !== "function") throw failure("inventory_control_dependency_invalid");
    this.hppCatalog = hppCatalog;
    this.scope = deepFreeze({ organizationId: uuid(organizationId, "inventory_control_scope_invalid"), outletId: uuid(outletId, "inventory_control_scope_invalid") });
    this.clock = clock;
    this.idFactory = idFactory;
    this.lotProvider = lotProvider;
    this.productionConsumptionProvider = productionConsumptionProvider ?? (() => this.hppCatalog.exportState().saleConsumptions ?? []);
    this.events = [];
    this.operations = new Map();
    this.consumptions = [];
    this.consumptionReviews = [];
    this.preparedClassifications = [];
    this.countSessions = [];
    this.varianceClassifications = [];
  }

  get revision() { return this.events.length; }

  recordConsumption(input = {}) {
    const envelope = this.#envelope(input);
    const request = {
      disposition: enumeration(input.disposition, DISPOSITIONS, "inventory_consumption_disposition_invalid"),
      reasonCode: reasonCode(input.reasonCode),
      inventoryKind: enumeration(input.inventoryKind, new Set(["RAW_MATERIAL", "FINISHED_GOOD"]), "inventory_consumption_kind_invalid"),
      ingredientId: text(input.ingredientId, 120, "inventory_consumption_ingredient_invalid"),
      quantityBase: quantity(input.quantityBase, false, "inventory_consumption_quantity_invalid"),
      sourceType: text(input.sourceType, 80, "inventory_consumption_source_invalid"),
      sourceId: text(input.sourceId, 120, "inventory_consumption_source_invalid"),
      lotReference: optionalText(input.lotReference, 120, "inventory_consumption_lot_invalid"),
    };
    const replay = this.#replay("CONSUMPTION_RECORDED", envelope, request);
    if (replay) return { consumption: this.#consumptionView(replay.payload.id), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    const hppBefore = this.hppCatalog.exportState();
    try {
      const movement = this.hppCatalog.recordInventoryMovement({
        idempotencyKey: derivedKey("consume", `${this.scope.organizationId}:${this.scope.outletId}:${envelope.operationKey}`),
        movementType: movementType(request.disposition), ingredientId: request.ingredientId,
        quantityBase: request.quantityBase, effectiveAt: envelope.occurredAt,
        expectedVersion: this.hppCatalog.view().version, actorId: envelope.actorId, reason: envelope.reason,
      }).movement;
      const payload = {
        id: uuid(this.idFactory(), "inventory_consumption_id_invalid"), ...request,
        hppMovementId: movement.id, quantityDeltaBase: movement.quantityDeltaBase,
        inventoryValueDeltaRupiah: movement.inventoryValueDeltaRupiah,
        physicalOccurred: true, reviewStatus: "POST_REVIEW_REQUIRED", actorId: envelope.actorId,
        reason: envelope.reason, recordedAt: envelope.occurredAt,
      };
      const event = this.#commit("CONSUMPTION_RECORDED", envelope, request, payload);
      return { consumption: this.#consumptionView(event.payload.id), idempotentReplay: false, revision: this.revision };
    } catch (error) {
      this.hppCatalog.restoreState(hppBefore);
      throw error;
    }
  }

  reviewConsumption(input = {}) {
    const envelope = this.#envelope(input);
    const request = {
      consumptionId: uuid(input.consumptionId, "inventory_consumption_id_invalid"),
      decision: enumeration(input.decision, REVIEW_DECISIONS, "inventory_consumption_review_invalid"),
      reasonCode: reasonCode(input.reasonCode),
      replacementDisposition: input.decision === "RECLASSIFY" ? enumeration(input.replacementDisposition, DISPOSITIONS, "inventory_consumption_disposition_invalid") : null,
    };
    const replay = this.#replay("CONSUMPTION_REVIEWED", envelope, request);
    if (replay) return { review: structuredClone(replay.payload), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    if (!this.consumptions.some((item) => item.id === request.consumptionId)) throw failure("inventory_consumption_not_found", 404);
    if (this.consumptionReviews.some((item) => item.consumptionId === request.consumptionId)) throw failure("inventory_consumption_already_reviewed", 409);
    const payload = { id: uuid(this.idFactory(), "inventory_consumption_review_id_invalid"), ...request, actorId: envelope.actorId, reason: envelope.reason, reviewedAt: envelope.occurredAt };
    const event = this.#commit("CONSUMPTION_REVIEWED", envelope, request, payload);
    return { review: structuredClone(event.payload), idempotentReplay: false, revision: this.revision };
  }

  reclassifyPreparedConsumption(input = {}) {
    const envelope = this.#envelope(input);
    const request = {
      productionConsumptionId: text(input.productionConsumptionId, 120, "inventory_prepared_consumption_invalid"),
      disposition: enumeration(input.disposition, DISPOSITIONS, "inventory_consumption_disposition_invalid"),
      reasonCode: reasonCode(input.reasonCode),
    };
    const replay = this.#replay("PREPARED_RECLASSIFIED", envelope, request);
    if (replay) return { classification: structuredClone(replay.payload), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    if (!this.productionConsumptionProvider().some((item) => item.id === request.productionConsumptionId)) throw failure("inventory_prepared_consumption_not_found", 404);
    if (this.preparedClassifications.some((item) => item.productionConsumptionId === request.productionConsumptionId)) throw failure("inventory_prepared_consumption_already_classified", 409);
    const payload = { id: uuid(this.idFactory(), "inventory_prepared_classification_id_invalid"), ...request, deductedAgain: false, actorId: envelope.actorId, reason: envelope.reason, classifiedAt: envelope.occurredAt };
    const event = this.#commit("PREPARED_RECLASSIFIED", envelope, request, payload);
    return { classification: structuredClone(event.payload), idempotentReplay: false, revision: this.revision };
  }

  lotAvailability({ asOf } = {}) {
    const timestamp = iso(asOf, "inventory_lot_availability_time_invalid");
    const hppState = this.hppCatalog.exportState();
    const ingredientIds = new Set(hppState.ingredients.map((item) => item.id));
    const rows = this.lotProvider({ scope: this.scope, hppState });
    if (!Array.isArray(rows)) throw failure("inventory_lot_snapshot_invalid", 500);
    return rows.map((row) => {
      if (!row || typeof row !== "object" || !text(row.lotId, 120, "inventory_lot_snapshot_invalid") || !text(row.ingredientId, 120, "inventory_lot_snapshot_invalid") || !ingredientIds.has(row.ingredientId)) throw failure("inventory_lot_snapshot_invalid", 500);
      const expiryAt = iso(row.expiryAt, "inventory_lot_snapshot_invalid");
      const quantityBase = quantity(row.quantityBase, true, "inventory_lot_snapshot_invalid");
      return { lotId: row.lotId, ingredientId: row.ingredientId, expiryAt, quantityBase, availabilityStatus: Date.parse(expiryAt) <= Date.parse(timestamp) ? "BLOCKED_EXPIRED" : quantityBase > 0 ? "AVAILABLE" : "DEPLETED" };
    });
  }

  startCount(input = {}) {
    const envelope = this.#envelope(input);
    const balances = this.hppCatalog.view().inventoryBalances;
    const countType = enumeration(input.countType, COUNT_TYPES, "inventory_count_type_invalid");
    const mode = enumeration(input.mode, COUNT_MODES, "inventory_count_mode_invalid");
    const official = input.official === true;
    if (input.official !== true && input.official !== false) throw failure("inventory_count_official_invalid");
    const blind = input.blind === undefined ? official : boolean(input.blind, "inventory_count_blind_invalid");
    if (official && blind !== true) throw failure("inventory_count_official_blind_required");
    if (!Array.isArray(input.ingredientIds) || !input.ingredientIds.length || input.ingredientIds.length > 500) throw failure("inventory_count_scope_invalid");
    const ingredientIds = [...new Set(input.ingredientIds.map((item) => text(item, 120, "inventory_count_scope_invalid")))].sort();
    if (ingredientIds.length !== input.ingredientIds.length) throw failure("inventory_count_scope_invalid");
    const balancesById = new Map(balances.map((item) => [item.ingredientId, item]));
    if (ingredientIds.some((id) => !balancesById.has(id))) throw failure("inventory_count_scope_invalid");
    if ((countType === "FULL" || countType === "OPENING") && (ingredientIds.length !== balances.length || ingredientIds.some((id) => !balancesById.has(id)))) throw failure("inventory_count_incomplete");
    const request = { countType, mode, official, blind, ingredientIds, toleranceBase: quantity(input.toleranceBase, true, "inventory_count_tolerance_invalid") };
    const replay = this.#replay("COUNT_STARTED", envelope, request);
    if (replay) return { session: this.#sessionView(replay.payload.id, false), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    const payload = {
      id: uuid(this.idFactory(), "inventory_count_session_id_invalid"), scope: this.scope, ...request,
      cutoffHppVersion: this.hppCatalog.view().version, cutoffAt: envelope.occurredAt,
      status: "OPEN", actorId: envelope.actorId, reason: envelope.reason,
      lines: ingredientIds.map((ingredientId) => ({ ingredientId, expectedQuantityBase: balancesById.get(ingredientId).quantityBase })),
    };
    const event = this.#commit("COUNT_STARTED", envelope, request, payload);
    return { session: this.#sessionView(event.payload.id, false), idempotentReplay: false, revision: this.revision };
  }

  recordCountLine(input = {}) {
    const envelope = this.#envelope(input);
    const sessionId = uuid(input.countSessionId, "inventory_count_session_id_invalid");
    const session = this.#session(sessionId);
    const physicalQuantityBase = input.physicalQuantityBase === null ? null : quantity(input.physicalQuantityBase, true, "inventory_count_quantity_invalid");
    if (physicalQuantityBase === 0 && input.zeroConfirmed !== true) throw failure("inventory_count_zero_confirmation_required");
    if (physicalQuantityBase !== 0 && input.zeroConfirmed !== undefined && input.zeroConfirmed !== false) throw failure("inventory_count_zero_confirmation_invalid");
    const observedAt = physicalQuantityBase === null ? null : session.mode === "LIVE"
      ? iso(input.observedAt, "inventory_count_observation_time_required")
      : input.observedAt == null ? envelope.occurredAt : iso(input.observedAt, "inventory_count_observation_time_invalid");
    if (observedAt && (Date.parse(observedAt) < Date.parse(session.cutoffAt) || Date.parse(observedAt) > Date.parse(envelope.occurredAt))) throw failure("inventory_count_observation_time_invalid");
    const request = { countSessionId: sessionId, ingredientId: text(input.ingredientId, 120, "inventory_count_ingredient_invalid"), physicalQuantityBase, zeroConfirmed: physicalQuantityBase === 0, observedAt };
    const replay = this.#replay("COUNT_LINE_RECORDED", envelope, request);
    if (replay) return { attempt: structuredClone(replay.payload), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    if (session.status !== "OPEN" || !session.lines.some((line) => line.ingredientId === request.ingredientId)) throw failure("inventory_count_line_invalid", 409);
    const priorAttempts = session.attempts.filter((item) => item.ingredientId === request.ingredientId);
    const payload = { id: uuid(this.idFactory(), "inventory_count_attempt_id_invalid"), ...request, attemptNumber: priorAttempts.length + 1, actorId: envelope.actorId, recordedAt: envelope.occurredAt };
    const event = this.#commit("COUNT_LINE_RECORDED", envelope, request, payload);
    return { attempt: structuredClone(event.payload), idempotentReplay: false, revision: this.revision };
  }

  completeCount(input = {}) {
    const envelope = this.#envelope(input);
    const request = {
      countSessionId: uuid(input.countSessionId, "inventory_count_session_id_invalid"),
      approvalActorId: optionalText(input.approvalActorId, 80, "inventory_count_approval_actor_invalid"),
      pendingSourceCorrections: references(input.pendingSourceCorrections ?? [], "inventory_count_source_correction_invalid"),
      correctedSourceReferences: references(input.correctedSourceReferences ?? [], "inventory_count_source_correction_invalid"),
    };
    const replay = this.#replay("COUNT_COMPLETED", envelope, request);
    if (replay) return { session: this.#sessionView(request.countSessionId, true), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    const session = this.#session(request.countSessionId);
    if (session.status !== "OPEN") throw failure("inventory_count_state_invalid", 409);
    if (request.pendingSourceCorrections.length) throw failure("inventory_count_source_correction_required", 409);
    const completionAt = envelope.occurredAt;
    const hppState = this.hppCatalog.exportState();
    const lines = session.lines.map((line) => {
      const attempts = session.attempts.filter((item) => item.ingredientId === line.ingredientId);
      const last = attempts.at(-1);
      if (!last || last.physicalQuantityBase === null) throw failure("inventory_count_blank_line", 409, line.ingredientId);
      const compensationQuantityBase = session.mode === "LIVE" ? movementCompensation(hppState.inventoryMovements, line.ingredientId, last.observedAt, completionAt) : 0;
      const reconciledQuantityBase = roundedQuantity(last.physicalQuantityBase + compensationQuantityBase);
      if (reconciledQuantityBase < 0) throw failure("inventory_count_compensation_invalid", 409);
      const varianceQuantityBase = roundedQuantity(reconciledQuantityBase - line.expectedQuantityBase);
      const exceedsTolerance = Math.abs(varianceQuantityBase) > session.toleranceBase;
      if (exceedsTolerance && attempts.length < 2) throw failure("inventory_count_recount_required", 409, line.ingredientId);
      if (exceedsTolerance && !request.approvalActorId) throw failure("inventory_count_approval_required", 409, line.ingredientId);
      return { ingredientId: line.ingredientId, expectedQuantityBase: line.expectedQuantityBase, physicalQuantityBase: last.physicalQuantityBase, observationAt: last.observedAt, compensationQuantityBase, reconciledQuantityBase, varianceQuantityBase, attemptCount: attempts.length, exceedsTolerance, classification: "SHRINKAGE" };
    });
    const hppBefore = this.hppCatalog.exportState();
    try {
      for (const line of lines) {
        const result = this.hppCatalog.recordInventoryMovement({
          idempotencyKey: derivedKey("count", `${session.id}:${line.ingredientId}`), movementType: "CYCLE_COUNT",
          ingredientId: line.ingredientId, quantityBase: line.reconciledQuantityBase,
          expectedVersion: this.hppCatalog.view().version, actorId: envelope.actorId, reason: envelope.reason,
        });
        line.hppMovementId = result.movement.id;
        line.quantityDeltaBase = result.movement.quantityDeltaBase;
        line.inventoryValueDeltaRupiah = result.movement.inventoryValueDeltaRupiah;
      }
      const payload = { countSessionId: session.id, completedAt: completionAt, actorId: envelope.actorId, reason: envelope.reason, approvalActorId: request.approvalActorId, correctedSourceReferences: request.correctedSourceReferences, lines };
      this.#commit("COUNT_COMPLETED", envelope, request, payload);
      return { session: this.#sessionView(session.id, true), idempotentReplay: false, revision: this.revision };
    } catch (error) {
      this.hppCatalog.restoreState(hppBefore);
      throw error;
    }
  }

  reclassifyVariance(input = {}) {
    const envelope = this.#envelope(input);
    const request = {
      countSessionId: uuid(input.countSessionId, "inventory_count_session_id_invalid"),
      ingredientId: text(input.ingredientId, 120, "inventory_count_ingredient_invalid"),
      classification: enumeration(input.classification, VARIANCE_CLASSIFICATIONS, "inventory_count_variance_classification_invalid"),
      evidenceReference: text(input.evidenceReference, 120, "inventory_count_variance_evidence_required"),
    };
    const replay = this.#replay("VARIANCE_RECLASSIFIED", envelope, request);
    if (replay) return { classification: structuredClone(replay.payload), idempotentReplay: true, revision: this.revision };
    this.#assertRevision(envelope.expectedRevision);
    const session = this.#session(request.countSessionId);
    if (session.status !== "COMPLETED" || !session.completion.lines.some((line) => line.ingredientId === request.ingredientId && line.varianceQuantityBase !== 0)) throw failure("inventory_count_variance_not_found", 404);
    if (this.varianceClassifications.some((item) => item.countSessionId === request.countSessionId && item.ingredientId === request.ingredientId)) throw failure("inventory_count_variance_already_classified", 409);
    const payload = { id: uuid(this.idFactory(), "inventory_count_variance_classification_id_invalid"), ...request, previousClassification: "SHRINKAGE", actorId: envelope.actorId, reason: envelope.reason, reclassifiedAt: envelope.occurredAt };
    const event = this.#commit("VARIANCE_RECLASSIFIED", envelope, request, payload);
    return { classification: structuredClone(event.payload), idempotentReplay: false, revision: this.revision };
  }

  view({ revealExpected = false } = {}) {
    return structuredClone({
      contract: CONTRACT, scope: this.scope, revision: this.revision,
      consumptions: this.consumptions.map((item) => this.#consumptionView(item.id)),
      consumptionReviews: this.consumptionReviews,
      preparedClassifications: this.preparedClassifications,
      countSessions: this.countSessions.map((item) => this.#sessionView(item.id, revealExpected)),
      varianceClassifications: this.varianceClassifications,
    });
  }

  exportState() {
    return structuredClone({ contract: CONTRACT, stateVersion: STATE_VERSION, scope: this.scope, events: this.events });
  }

  restoreState(input) {
    try {
      exactKeys(input, ["contract", "events", "scope", "stateVersion"], "inventory_control_state_tampered");
      if (input.contract !== CONTRACT || input.stateVersion !== STATE_VERSION || canonical(input.scope) !== canonical(this.scope) || !Array.isArray(input.events) || input.events.length > 100_000) throw failure("inventory_control_state_tampered", 500);
      const candidate = new InventoryWasteCountWorkflow({ hppCatalog: this.hppCatalog, ...this.scope, clock: this.clock, idFactory: this.idFactory, lotProvider: this.lotProvider, productionConsumptionProvider: this.productionConsumptionProvider });
      for (const event of input.events) candidate.#appendPersisted(event);
      this.events = candidate.events;
      this.operations = candidate.operations;
      this.consumptions = candidate.consumptions;
      this.consumptionReviews = candidate.consumptionReviews;
      this.preparedClassifications = candidate.preparedClassifications;
      this.countSessions = candidate.countSessions;
      this.varianceClassifications = candidate.varianceClassifications;
    } catch (error) {
      if (error instanceof InventoryWasteCountError && error.code === "inventory_control_state_tampered") throw error;
      throw failure("inventory_control_state_tampered", 500, error?.code);
    }
  }

  #envelope(input) {
    return {
      operationKey: text(input.operationKey, 120, "inventory_control_operation_key_invalid"),
      expectedRevision: integer(input.expectedRevision, "inventory_control_revision_invalid"),
      actorId: text(input.actorId, 80, "inventory_control_actor_invalid"),
      reason: text(input.reason, 240, "inventory_control_reason_invalid"),
      occurredAt: input.occurredAt == null ? this.clock().toISOString() : iso(input.occurredAt, "inventory_control_timestamp_invalid"),
    };
  }

  #replay(type, envelope, request) {
    const event = this.operations.get(envelope.operationKey);
    if (!event) return null;
    if (event.type !== type || event.requestFingerprint !== requestFingerprint(type, request, envelope)) throw failure("inventory_control_idempotency_conflict", 409);
    return event;
  }

  #assertRevision(expected) {
    if (expected !== this.revision) throw failure("inventory_control_revision_conflict", 409, this.revision);
  }

  #commit(type, envelope, request, payload) {
    const withoutHash = {
      sequence: this.revision + 1, type, operationKey: envelope.operationKey,
      requestFingerprint: requestFingerprint(type, request, envelope), request: structuredClone(request),
      actorId: envelope.actorId, reason: envelope.reason, occurredAt: envelope.occurredAt,
      previousEventHash: this.events.at(-1)?.eventHash ?? ZERO_HASH, payload: structuredClone(payload),
    };
    const event = deepFreeze({ ...withoutHash, eventHash: hash(withoutHash) });
    this.#apply(event);
    this.events.push(event);
    this.operations.set(event.operationKey, event);
    return event;
  }

  #appendPersisted(input) {
    exactKeys(input, ["actorId", "eventHash", "occurredAt", "operationKey", "payload", "previousEventHash", "reason", "request", "requestFingerprint", "sequence", "type"], "inventory_control_state_tampered");
    const withoutHash = structuredClone(input); delete withoutHash.eventHash;
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== this.revision + 1
      || input.previousEventHash !== (this.events.at(-1)?.eventHash ?? ZERO_HASH)
      || input.eventHash !== hash(withoutHash) || input.requestFingerprint !== requestFingerprint(input.type, input.request, input)
      || this.operations.has(input.operationKey)) throw failure("inventory_control_state_tampered", 500);
    text(input.operationKey, 120, "inventory_control_state_tampered"); text(input.actorId, 80, "inventory_control_state_tampered"); text(input.reason, 240, "inventory_control_state_tampered"); iso(input.occurredAt, "inventory_control_state_tampered");
    const event = deepFreeze(structuredClone(input));
    this.#apply(event, true);
    this.events.push(event);
    this.operations.set(event.operationKey, event);
  }

  #apply(event, restoring = false) {
    const payload = structuredClone(event.payload);
    if (event.type === "CONSUMPTION_RECORDED") {
      if (this.consumptions.some((item) => item.id === payload.id)) throw failure("inventory_control_state_tampered", 500);
      const movement = this.hppCatalog.exportState().inventoryMovements.find((item) => item.id === payload.hppMovementId);
      if (!movement || movement.ingredientId !== payload.ingredientId || movement.quantityDeltaBase !== -payload.quantityBase || movement.inventoryValueDeltaRupiah !== payload.inventoryValueDeltaRupiah) throw failure("inventory_control_state_tampered", 500);
      this.consumptions.push(payload); return;
    }
    if (event.type === "CONSUMPTION_REVIEWED") {
      if (!this.consumptions.some((item) => item.id === payload.consumptionId) || this.consumptionReviews.some((item) => item.consumptionId === payload.consumptionId)) throw failure("inventory_control_state_tampered", 500);
      this.consumptionReviews.push(payload); return;
    }
    if (event.type === "PREPARED_RECLASSIFIED") {
      if (this.preparedClassifications.some((item) => item.productionConsumptionId === payload.productionConsumptionId) || payload.deductedAgain !== false) throw failure("inventory_control_state_tampered", 500);
      if (restoring && !this.productionConsumptionProvider().some((item) => item.id === payload.productionConsumptionId)) throw failure("inventory_control_state_tampered", 500);
      this.preparedClassifications.push(payload); return;
    }
    if (event.type === "COUNT_STARTED") {
      if (this.countSessions.some((item) => item.id === payload.id) || payload.status !== "OPEN" || canonical(payload.scope) !== canonical(this.scope) || !Array.isArray(payload.lines) || !payload.lines.length) throw failure("inventory_control_state_tampered", 500);
      this.countSessions.push({ ...payload, attempts: [], completion: null }); return;
    }
    if (event.type === "COUNT_LINE_RECORDED") {
      const session = this.#session(payload.countSessionId);
      if (session.status !== "OPEN" || !session.lines.some((line) => line.ingredientId === payload.ingredientId) || payload.attemptNumber !== session.attempts.filter((item) => item.ingredientId === payload.ingredientId).length + 1) throw failure("inventory_control_state_tampered", 500);
      session.attempts.push(payload); return;
    }
    if (event.type === "COUNT_COMPLETED") {
      const session = this.#session(payload.countSessionId);
      if (session.status !== "OPEN" || !Array.isArray(payload.lines) || payload.lines.length !== session.lines.length) throw failure("inventory_control_state_tampered", 500);
      const movements = new Map(this.hppCatalog.exportState().inventoryMovements.map((item) => [item.id, item]));
      for (const line of payload.lines) {
        const movement = movements.get(line.hppMovementId);
        if (!movement || movement.movementType !== "CYCLE_COUNT" || movement.ingredientId !== line.ingredientId || movement.quantityDeltaBase !== line.quantityDeltaBase || movement.inventoryValueDeltaRupiah !== line.inventoryValueDeltaRupiah) throw failure("inventory_control_state_tampered", 500);
      }
      session.status = "COMPLETED"; session.completion = payload; return;
    }
    if (event.type === "VARIANCE_RECLASSIFIED") {
      const session = this.#session(payload.countSessionId);
      if (session.status !== "COMPLETED" || !session.completion.lines.some((line) => line.ingredientId === payload.ingredientId && line.varianceQuantityBase !== 0) || this.varianceClassifications.some((item) => item.countSessionId === payload.countSessionId && item.ingredientId === payload.ingredientId)) throw failure("inventory_control_state_tampered", 500);
      this.varianceClassifications.push(payload); return;
    }
    throw failure("inventory_control_state_tampered", 500);
  }

  #session(id) {
    const session = this.countSessions.find((item) => item.id === id);
    if (!session) throw failure("inventory_count_session_not_found", 404);
    return session;
  }

  #sessionView(id, revealExpected) {
    const session = this.#session(id);
    const completionByIngredient = new Map((session.completion?.lines ?? []).map((line) => [line.ingredientId, line]));
    return {
      id: session.id, scope: session.scope, countType: session.countType, mode: session.mode, official: session.official, blind: session.blind,
      cutoffHppVersion: session.cutoffHppVersion, cutoffAt: session.cutoffAt, toleranceBase: session.toleranceBase, status: session.status,
      correctedSourceReferences: session.completion?.correctedSourceReferences ?? [], approvalActorId: session.completion?.approvalActorId ?? null,
      completedAt: session.completion?.completedAt ?? null,
      lines: session.lines.map((line) => {
        const attempts = session.attempts.filter((item) => item.ingredientId === line.ingredientId);
        const last = attempts.at(-1);
        const completion = completionByIngredient.get(line.ingredientId);
        const expected = session.blind && session.status === "OPEN" && !revealExpected ? null : line.expectedQuantityBase;
        return completion ? { ...completion, attempts: structuredClone(attempts) } : {
          ingredientId: line.ingredientId, expectedQuantityBase: expected, attemptCount: attempts.length, attempts: structuredClone(attempts),
          observedVarianceBase: last?.physicalQuantityBase == null ? null : roundedQuantity(last.physicalQuantityBase - line.expectedQuantityBase),
        };
      }),
    };
  }

  #consumptionView(id) {
    const item = this.consumptions.find((entry) => entry.id === id);
    const review = this.consumptionReviews.find((entry) => entry.consumptionId === id);
    return { ...structuredClone(item), reviewStatus: review ? review.decision === "APPROVE" ? "APPROVED" : "RECLASSIFICATION_REQUIRED" : item.reviewStatus, review: review ? structuredClone(review) : null };
  }
}

function movementType(disposition) {
  return ({ WASTE: "PRODUCTION_WASTE", SPOILAGE: "SPOILAGE_WASTE", DAMAGE: "DAMAGED", REMAKE: "PRODUCTION_WASTE", STAFF_INTERNAL: "INTERNAL_USE", SAMPLING: "SAMPLES_PROMOTIONAL", COMPLIMENTARY: "INTERNAL_USE", TRANSFER_LOSS: "LOSS_THEFT", OTHER: "LOSS_THEFT" })[disposition];
}

function movementCompensation(movements, ingredientId, observedAt, completedAt) {
  return roundedQuantity(movements.filter((item) => item.ingredientId === ingredientId && item.occurredAt > observedAt && item.occurredAt <= completedAt).reduce((sum, item) => sum + item.quantityDeltaBase, 0));
}

function derivedKey(prefix, value) { return `${prefix}:${createHash("sha256").update(value).digest("hex")}`; }
function requestFingerprint(type, request, envelope) { return hash({ type, request, actorId: envelope.actorId, reason: envelope.reason }); }
function reasonCode(value) { if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(value)) throw failure("inventory_control_reason_code_invalid"); return value; }
function references(value, code) { if (!Array.isArray(value) || value.length > 100) throw failure(code); const rows = value.map((item) => text(item, 160, code)); if (new Set(rows).size !== rows.length) throw failure(code); return rows.sort(); }
function optionalText(value, max, code) { return value == null ? null : text(value, max, code); }
function text(value, max, code) { if (typeof value !== "string" || value !== value.trim() || !value || value.length > max || /[\u0000-\u001f\u007f<>]/.test(value)) throw failure(code); return value; }
function uuid(value, code) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure(code); return value.toLowerCase(); }
function integer(value, code) { if (!Number.isSafeInteger(value) || value < 0) throw failure(code); return value; }
function boolean(value, code) { if (typeof value !== "boolean") throw failure(code); return value; }
function enumeration(value, allowed, code) { if (!allowed.has(value)) throw failure(code); return value; }
function quantity(value, allowZero, code) { if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0) || value > 1_000_000_000_000 || roundedQuantity(value) !== value) throw failure(code); return value; }
function roundedQuantity(value) { return Math.round(value * 1000) / 1000; }
function iso(value, code) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure(code); return value; }
function exactKeys(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure(code, 500); }
function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); } return value; }
function failure(code, statusCode = 422, detail) { return new InventoryWasteCountError(code, statusCode, detail); }
