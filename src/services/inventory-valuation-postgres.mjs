import { randomUUID } from "node:crypto";

import {
  InventoryValuationError,
  InventoryValuationLedger,
  inventoryValuationFingerprint,
} from "./inventory-valuation.mjs";

const COMMAND_METHODS = Object.freeze({
  PROVISIONAL_RECEIPT: "recordProvisionalReceipt",
  INVENTORY_CONSUMPTION: "recordConsumption",
  PRODUCTION_TRANSFORMATION: "recordProductionTransformation",
  RECEIPT_REVALUATION: "recordReceiptRevaluation",
});

export class InventoryValuationPersistenceError extends Error {
  constructor(code, { statusCode = 500, currentRevision, detail } = {}) {
    super(code);
    this.name = "InventoryValuationPersistenceError";
    this.code = code;
    this.statusCode = statusCode;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
    if (detail !== undefined) this.detail = detail;
  }
}

export class InventoryValuationPostgresAdapter {
  constructor({ db, ledgerFactory = () => new InventoryValuationLedger(), idFactory = randomUUID, faultInjector = async () => {} } = {}) {
    if (!db?.query || !db?.transaction) throw persistenceFailure("valuation_postgres_database_required");
    if (typeof ledgerFactory !== "function" || typeof idFactory !== "function" || typeof faultInjector !== "function") throw persistenceFailure("valuation_persistence_dependency_invalid");
    this.db = db;
    this.ledgerFactory = ledgerFactory;
    this.idFactory = idFactory;
    this.faultInjector = faultInjector;
  }

  async load(input = {}) {
    const scope = normalizeScope(input);
    return this.#loadFrom(this.db, scope);
  }

  async append(input = {}) {
    const command = normalizeAppend(input);
    return this.db.transaction((tx) => this.#appendTo(tx, command));
  }

  async appendInTransaction(tx, input = {}) {
    if (!tx?.query) throw persistenceFailure("valuation_postgres_transaction_required");
    return this.#appendTo(tx, normalizeAppend(input));
  }

  async loadInTransaction(tx, input = {}) {
    if (!tx?.query) throw persistenceFailure("valuation_postgres_transaction_required");
    return this.#loadFrom(tx, normalizeScope(input));
  }

  async #appendTo(tx, command) {
    const commandFingerprint = inventoryValuationFingerprint({
      commandType: command.commandType,
      scope: command.scope,
      command: command.command,
      actorReference: command.actorReference,
      reason: command.reason,
    });
    return (async () => {
      const existing = (await tx.query(
        `select outlet_id,valuation_scope_id,command_fingerprint,result_document,result_fingerprint,committed_revision
           from sagaops.inventory_valuation_operations
          where organization_id=$1 and operation_key=$2
          for update`,
        [command.scope.organizationId, command.command.operationKey],
      )).rows[0];
      if (existing) {
        if (existing.command_fingerprint !== commandFingerprint) throw persistenceFailure("valuation_persistence_idempotency_conflict", { statusCode: 409 });
        let persistedResult;
        try {
          persistedResult = jsonValue(existing.result_document);
        } catch {
          throw persistenceFailure("valuation_persistence_operation_tampered");
        }
        if (existing.result_fingerprint !== inventoryValuationFingerprint(persistedResult)) throw persistenceFailure("valuation_persistence_operation_tampered");
        await this.#validateReplay(tx, command, existing, persistedResult);
        return { ...persistedResult, idempotentReplay: true };
      }

      if (command.expectedRevision === 0) {
        await tx.query(
          `insert into sagaops.inventory_valuation_aggregates
            (organization_id,outlet_id,valuation_scope_id,revision,updated_at)
           values ($1,$2,$3,0,$4)
           on conflict (organization_id,outlet_id,valuation_scope_id) do nothing`,
          [command.scope.organizationId, command.scope.outletId, command.scope.valuationScopeId, command.command.occurredAt],
        );
      }
      const aggregate = (await tx.query(
        `select revision from sagaops.inventory_valuation_aggregates
          where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3
          for update`,
        scopeParams(command.scope),
      )).rows[0];
      const currentRevision = aggregate ? Number(aggregate.revision) : 0;
      if (!aggregate || currentRevision !== command.expectedRevision) {
        throw persistenceFailure("valuation_persistence_revision_conflict", { statusCode: 409, currentRevision });
      }

      const restored = await this.#loadFrom(tx, command.scope, currentRevision);
      const domainResult = restored.ledger[COMMAND_METHODS[command.commandType]](command.command);
      const fact = domainResult.fact;
      const nextRevision = currentRevision + 1;
      if (fact.sequence !== nextRevision) throw persistenceFailure("valuation_persistence_sequence_invalid");
      await tx.query(
        `insert into sagaops.inventory_valuation_facts
          (organization_id,outlet_id,valuation_scope_id,sequence,fact_id,fact_hash,fact_document,recorded_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [...scopeParams(command.scope), nextRevision, fact.factId, fact.factHash, JSON.stringify(fact), fact.occurredAt],
      );
      const updated = (await tx.query(
        `update sagaops.inventory_valuation_aggregates
            set revision=revision+1,updated_at=$5
          where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3 and revision=$4
          returning revision`,
        [...scopeParams(command.scope), currentRevision, fact.occurredAt],
      )).rows[0];
      if (!updated || Number(updated.revision) !== nextRevision) throw persistenceFailure("valuation_persistence_revision_conflict", { statusCode: 409, currentRevision });

      const outboxEventId = uuid(this.idFactory(), "valuation_outbox_event_id_invalid");
      const outboxRowId = uuid(this.idFactory(), "valuation_outbox_row_id_invalid");
      const outboxPayload = {
        schemaVersion: 1,
        aggregateType: "INVENTORY_VALUATION",
        organizationId: command.scope.organizationId,
        outletId: command.scope.outletId,
        valuationScopeId: command.scope.valuationScopeId,
        operationKey: command.command.operationKey,
        revision: nextRevision,
        factId: fact.factId,
        factHash: fact.factHash,
        factType: fact.type,
        actorReference: command.actorReference,
        reason: command.reason,
      };
      await tx.query(
        `insert into public.sagaops_integration_outbox
          (id,organization_id,outlet_id,event_id,event_type,payload,status,available_at,created_at)
         values ($1,$2,$3,$4,'INVENTORY_VALUATION_FACT_APPENDED_V1',$5::jsonb,'pending',$6,$6)`,
        [outboxRowId, command.scope.organizationId, command.scope.outletId, outboxEventId, JSON.stringify(outboxPayload), fact.occurredAt],
      );
      const persistedResult = {
        ...domainResult,
        idempotentReplay: false,
        revision: nextRevision,
        outboxEventId,
      };
      const resultFingerprint = inventoryValuationFingerprint(persistedResult);
      await tx.query(
        `insert into sagaops.inventory_valuation_operations
          (organization_id,outlet_id,valuation_scope_id,operation_key,command_fingerprint,result_document,result_fingerprint,committed_revision,created_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [...scopeParams(command.scope), command.command.operationKey, commandFingerprint, JSON.stringify(persistedResult), resultFingerprint, nextRevision, fact.occurredAt],
      );
      await this.faultInjector("after_inventory_valuation_outbox", {
        transaction: tx,
        operationKey: command.command.operationKey,
        revision: nextRevision,
        outboxEventId,
      });
      return structuredClone(persistedResult);
    })();
  }

  async pendingOutbox(input = {}) {
    const scope = normalizeScope(input);
    const rows = (await this.db.query(
      `select event_id,event_type,payload,status,attempts,available_at,created_at
         from public.sagaops_integration_outbox
        where organization_id=$1 and outlet_id=$2
          and payload->>'valuationScopeId'=$3 and status='pending'
        order by created_at,event_id`,
      scopeParams(scope),
    )).rows;
    return rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      payload: jsonValue(row.payload),
      status: row.status,
      attempts: Number(row.attempts),
      availableAt: isoValue(row.available_at),
      createdAt: isoValue(row.created_at),
    }));
  }

  async #validateReplay(tx, command, operation, persistedResult) {
    const revision = Number(operation.committed_revision);
    if (operation.outlet_id !== command.scope.outletId
      || operation.valuation_scope_id !== command.scope.valuationScopeId
      || !Number.isSafeInteger(revision) || revision < 1
      || !plainObject(persistedResult)
      || persistedResult.idempotentReplay !== false
      || persistedResult.revision !== revision) {
      throw persistenceFailure("valuation_persistence_operation_tampered");
    }

    let committed;
    let expectedDomainResult;
    try {
      committed = await this.#loadFrom(tx, command.scope, revision);
      const committedFact = committed.state.facts.at(-1);
      if (!committedFact) throw persistenceFailure("valuation_persistence_operation_tampered");
      const prior = await this.#loadFrom(tx, command.scope, revision - 1);
      const verifier = new InventoryValuationLedger({ idFactory: () => committedFact.factId });
      verifier.restoreState(prior.state);
      expectedDomainResult = verifier[COMMAND_METHODS[command.commandType]](command.command);
    } catch (error) {
      if (error instanceof InventoryValuationPersistenceError && error.code === "valuation_persistence_operation_tampered") throw error;
      throw persistenceFailure("valuation_persistence_operation_tampered", { detail: error?.code });
    }

    const outboxEventId = uuid(persistedResult.outboxEventId, "valuation_persistence_operation_tampered");
    const expectedResult = { ...expectedDomainResult, idempotentReplay: false, revision, outboxEventId };
    if (inventoryValuationFingerprint(persistedResult) !== inventoryValuationFingerprint(expectedResult)) {
      throw persistenceFailure("valuation_persistence_operation_tampered");
    }

    const fact = committed.state.facts.at(-1);
    const outbox = (await tx.query(
      `select organization_id,outlet_id,event_type,payload
         from public.sagaops_integration_outbox
        where event_id=$1`,
      [outboxEventId],
    )).rows[0];
    const expectedPayload = {
      schemaVersion: 1,
      aggregateType: "INVENTORY_VALUATION",
      organizationId: command.scope.organizationId,
      outletId: command.scope.outletId,
      valuationScopeId: command.scope.valuationScopeId,
      operationKey: command.command.operationKey,
      revision,
      factId: fact.factId,
      factHash: fact.factHash,
      factType: fact.type,
      actorReference: command.actorReference,
      reason: command.reason,
    };
    if (!outbox
      || outbox.organization_id !== command.scope.organizationId
      || outbox.outlet_id !== command.scope.outletId
      || outbox.event_type !== "INVENTORY_VALUATION_FACT_APPENDED_V1"
      || inventoryValuationFingerprint(jsonValue(outbox.payload)) !== inventoryValuationFingerprint(expectedPayload)) {
      throw persistenceFailure("valuation_persistence_operation_tampered");
    }
  }

  async #loadFrom(db, scope, lockedRevision = undefined) {
    const aggregate = lockedRevision === undefined
      ? (await db.query(
        `select revision from sagaops.inventory_valuation_aggregates
          where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3`,
        scopeParams(scope),
      )).rows[0]
      : { revision: lockedRevision };
    const revisionClause = lockedRevision === undefined ? "" : " and sequence <= $4";
    const rows = (await db.query(
      `select sequence,fact_id,fact_hash,fact_document
         from sagaops.inventory_valuation_facts
        where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3
        ${revisionClause}
        order by sequence`,
      lockedRevision === undefined ? scopeParams(scope) : [...scopeParams(scope), lockedRevision],
    )).rows;
    const revision = aggregate ? Number(aggregate.revision) : 0;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== rows.length) throw persistenceFailure("valuation_persistence_state_tampered");
    const ledger = this.ledgerFactory();
    const state = ledger.exportState();
    state.facts = rows.map((row, index) => {
      const fact = jsonValue(row.fact_document);
      if (Number(row.sequence) !== index + 1 || fact.sequence !== Number(row.sequence) || fact.factId !== row.fact_id || fact.factHash !== row.fact_hash) {
        throw persistenceFailure("valuation_persistence_state_tampered");
      }
      return fact;
    });
    try {
      ledger.restoreState(state);
    } catch (error) {
      if (error instanceof InventoryValuationError) throw persistenceFailure("valuation_persistence_state_tampered", { detail: error.code });
      throw error;
    }
    return { revision, ledger, state: ledger.exportState() };
  }
}

function normalizeAppend(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw persistenceFailure("valuation_persistence_command_invalid");
  const scope = normalizeScope(input);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw persistenceFailure("valuation_persistence_revision_invalid");
  if (!COMMAND_METHODS[input.commandType]) throw persistenceFailure("valuation_persistence_command_type_invalid");
  if (!input.command || typeof input.command !== "object" || Array.isArray(input.command)) throw persistenceFailure("valuation_persistence_command_invalid");
  for (const key of ["organizationId", "outletId", "valuationScopeId"]) {
    if (input.command[key] !== scope[key]) throw persistenceFailure("valuation_persistence_scope_mismatch", { statusCode: 403 });
  }
  if (!cleanText(input.command.operationKey, 120) || !cleanText(input.command.occurredAt, 40)) throw persistenceFailure("valuation_persistence_command_invalid");
  const actorReference = cleanText(input.actorReference, 120);
  const reason = cleanText(input.reason, 240);
  if (!actorReference || !reason) throw persistenceFailure("valuation_persistence_audit_context_required");
  return { scope, expectedRevision: input.expectedRevision, commandType: input.commandType, command: structuredClone(input.command), actorReference, reason };
}

function normalizeScope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw persistenceFailure("valuation_persistence_scope_invalid");
  return {
    organizationId: uuid(input.organizationId, "valuation_persistence_scope_invalid"),
    outletId: uuid(input.outletId, "valuation_persistence_scope_invalid"),
    valuationScopeId: cleanText(input.valuationScopeId, 120) || fail("valuation_persistence_scope_invalid"),
  };
}

function scopeParams(scope) {
  return [scope.organizationId, scope.outletId, scope.valuationScopeId];
}

function jsonValue(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoValue(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uuid(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw persistenceFailure(code);
  return value.toLowerCase();
}

function cleanText(value, maxLength) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function fail(code) {
  throw persistenceFailure(code);
}

function persistenceFailure(code, options = {}) {
  return new InventoryValuationPersistenceError(code, options);
}
