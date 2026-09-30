import { randomUUID } from "node:crypto";

import { InventoryLocationError, InventoryLocationLedger } from "./inventory-locations.mjs";

const ACTIONS = Object.freeze([
  "createLocation",
  "recordReceipt",
  "reserveStock",
  "releaseReservation",
  "transferStock",
  "assignWorkstation",
  "consumeProduction",
  "closeLocation",
]);

export class InventoryLocationPersistenceError extends Error {
  constructor(code, { statusCode = 500, currentRevision, detail } = {}) {
    super(code);
    this.name = "InventoryLocationPersistenceError";
    this.code = code;
    this.statusCode = statusCode;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
    if (detail !== undefined) this.detail = detail;
  }
}

export class InventoryLocationsPostgresAdapter {
  constructor({ db, authorize, idFactory = randomUUID, faultInjector = async () => {} } = {}) {
    if (!db?.query || !db?.transaction) throw failure("inventory_location_database_required");
    if (typeof authorize !== "function") throw failure("inventory_location_authorizer_required");
    if (typeof idFactory !== "function" || typeof faultInjector !== "function") throw failure("inventory_location_persistence_dependency_invalid");
    this.db = db;
    this.authorize = authorize;
    this.idFactory = idFactory;
    this.faultInjector = faultInjector;
    for (const action of ACTIONS) this[action] = (input = {}) => this.#execute(action, input);
  }

  async load(input = {}) {
    const context = contextInput(input);
    await this.#authorize(context, "load");
    return this.#loadFrom(this.db, context.scope);
  }

  async #execute(action, input) {
    const context = contextInput(input);
    await this.#authorize(context, action);
    const command = commandInput(input, context.actorReference);
    return this.db.transaction(async (tx) => {
      if (command.expectedRevision === 0) {
        await tx.query(
          `insert into sagaops.inventory_location_aggregates(organization_id,outlet_id,revision,updated_at)
           values ($1,$2,0,$3) on conflict (organization_id,outlet_id) do nothing`,
          [context.scope.organizationId, context.scope.outletId, command.occurredAt],
        );
      }
      const aggregate = (await tx.query(
        `select revision from sagaops.inventory_location_aggregates
          where organization_id=$1 and outlet_id=$2 for update`,
        scopeParams(context.scope),
      )).rows[0];
      const currentRevision = aggregate ? Number(aggregate.revision) : 0;
      if (!aggregate) throw failure("inventory_location_revision_conflict", { statusCode: 409, currentRevision });
      const restored = await this.#loadFrom(tx, context.scope, currentRevision);
      let result;
      try {
        result = restored.ledger[action](command);
      } catch (error) {
        if (error instanceof InventoryLocationError) throw failure(error.code, { statusCode: error.statusCode, currentRevision: error.detail });
        throw error;
      }
      if (result.idempotentReplay) return result;
      const fact = result.fact;
      if (fact.sequence !== currentRevision + 1) throw failure("inventory_location_persistence_sequence_invalid");
      await tx.query(
        `insert into sagaops.inventory_location_facts
          (organization_id,outlet_id,sequence,fact_id,operation_key,request_fingerprint,fact_hash,fact_document,actor_reference,reason,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [...scopeParams(context.scope), fact.sequence, fact.factId, fact.operationKey, fact.requestFingerprint, fact.factHash, JSON.stringify(fact), context.actorReference, fact.reason, fact.occurredAt],
      );
      const updated = (await tx.query(
        `update sagaops.inventory_location_aggregates set revision=revision+1,updated_at=$4
          where organization_id=$1 and outlet_id=$2 and revision=$3 returning revision`,
        [...scopeParams(context.scope), currentRevision, fact.occurredAt],
      )).rows[0];
      if (!updated || Number(updated.revision) !== fact.sequence) throw failure("inventory_location_revision_conflict", { statusCode: 409, currentRevision });
      await tx.query(
        `insert into sagaops.pos_audit_events
          (organization_id,outlet_id,actor_reference,aggregate_type,aggregate_id,event_type,correlation_id,payload_redacted,occurred_at)
         values ($1,$2,$3,'inventory_location',$4,$5,$6,$7::jsonb,$8)`,
        [...scopeParams(context.scope), context.actorReference, fact.factId, `inventory.location.${fact.type.toLowerCase()}`, fact.operationKey, JSON.stringify({ sequence: fact.sequence, factType: fact.type }), fact.occurredAt],
      );
      await this.faultInjector("before_inventory_location_commit", { transaction: tx, fact });
      return result;
    });
  }

  async #authorize(context, action) {
    const allowed = await this.authorize({ ...context.scope, actorReference: context.actorReference, action });
    if (allowed !== true) throw failure("inventory_location_scope_denied", { statusCode: 403 });
  }

  async #loadFrom(db, scope, lockedRevision = undefined) {
    const aggregate = lockedRevision === undefined
      ? (await db.query("select revision from sagaops.inventory_location_aggregates where organization_id=$1 and outlet_id=$2", scopeParams(scope))).rows[0]
      : { revision: lockedRevision };
    const facts = (await db.query(
      `select sequence,fact_id,operation_key,request_fingerprint,fact_hash,fact_document,actor_reference,reason,occurred_at
         from sagaops.inventory_location_facts
        where organization_id=$1 and outlet_id=$2 order by sequence`,
      scopeParams(scope),
    )).rows;
    const revision = aggregate ? Number(aggregate.revision) : 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== facts.length) throw failure("inventory_location_persistence_state_tampered");
    const ledger = new InventoryLocationLedger({ ...scope, idFactory: this.idFactory });
    const state = ledger.exportState();
    state.facts = facts.map((row, index) => {
      let fact;
      try { fact = jsonValue(row.fact_document); } catch { throw failure("inventory_location_persistence_state_tampered"); }
      if (Number(row.sequence) !== index + 1 || fact.sequence !== Number(row.sequence) || fact.factId !== row.fact_id
        || fact.operationKey !== row.operation_key || fact.requestFingerprint !== row.request_fingerprint || fact.factHash !== row.fact_hash
        || fact.actorId !== row.actor_reference || fact.reason !== row.reason || fact.occurredAt !== iso(row.occurred_at)) throw failure("inventory_location_persistence_state_tampered");
      return fact;
    });
    try {
      ledger.restoreState(state);
    } catch (error) {
      if (error instanceof InventoryLocationError) throw failure("inventory_location_persistence_state_tampered", { detail: error.code });
      throw error;
    }
    return { revision, ledger, state: ledger.exportState(), view: ledger.view() };
  }
}

function contextInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("inventory_location_context_invalid");
  return {
    scope: {
      organizationId: uuid(input.organizationId, "inventory_location_scope_invalid"),
      outletId: uuid(input.outletId, "inventory_location_scope_invalid"),
    },
    actorReference: cleanText(input.actorReference, 120, "inventory_location_actor_invalid"),
  };
}

function commandInput(input, actorReference) {
  const command = structuredClone(input);
  delete command.organizationId;
  delete command.outletId;
  delete command.actorReference;
  command.actorId = actorReference;
  return command;
}

function scopeParams(scope) {
  return [scope.organizationId, scope.outletId];
}

function jsonValue(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uuid(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure(code);
  return value.toLowerCase();
}

function cleanText(value, max, code) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure(code);
  return value;
}

function failure(code, options = {}) {
  return new InventoryLocationPersistenceError(code, options);
}
