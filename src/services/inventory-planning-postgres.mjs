import { ReplenishmentPlanner } from "./inventory-availability-replenishment.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export class InventoryPlanningPostgresAdapter {
  constructor({ db, ids, stateIntegrityKey, clock = () => new Date(), faultInjector = async () => {} } = {}) {
    if (!db?.query || !db?.transaction) throw failure("inventory_planning_postgres_database_required");
    if (typeof stateIntegrityKey !== "string" || Buffer.byteLength(stateIntegrityKey.trim()) < 32) throw failure("inventory_planning_state_integrity_key_invalid");
    if (typeof faultInjector !== "function") throw failure("inventory_planning_postgres_dependency_invalid");
    this.db = db;
    this.ids = Object.freeze({
      organizationId: uuid(ids?.organizationId, "inventory_planning_postgres_scope_invalid"),
      outletId: uuid(ids?.outletId, "inventory_planning_postgres_scope_invalid"),
    });
    this.stateIntegrityKey = stateIntegrityKey.trim();
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  async assertReady({ authUserId } = {}) {
    const identity = uuid(authUserId, "inventory_planning_postgres_auth_identity_invalid");
    const result = await this.db.query(
      `select current_setting('row_security') row_security,
              current_setting('app.current_user_id', true) auth_user_id,
              bool_and(c.relrowsecurity and c.relforcerowsecurity) forced_rls,
              count(*)::integer table_count
         from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='sagaops'
          and c.relname=any($1::text[])
          and c.relkind='r'
        group by current_setting('row_security'),current_setting('app.current_user_id', true)`,
      [["pos_hpp_catalog_state", "inventory_planning_aggregates", "inventory_planning_operations"]],
    );
    const row = result.rows[0];
    if (!row || row.row_security !== "on" || row.auth_user_id !== identity || row.forced_rls !== true || Number(row.table_count) !== 3) {
      throw failure("inventory_planning_postgres_rls_not_ready");
    }
    const scope = (await this.db.query(
      `select exists(
         select 1 from sagaops.outlets o
          join sagaops.organizations g on g.id=o.organization_id
         where o.organization_id=$1 and o.id=$2 and g.owner_auth_user_id=auth.uid()
       ) scope_visible`,
      scopeParams(this.ids),
    )).rows[0];
    if (scope?.scope_visible !== true) throw failure("inventory_planning_postgres_scope_not_visible");
    return { ready: true, ...this.ids, forcedRls: true };
  }

  async loadAvailability(input = {}) {
    const scope = scopeInput(input, this.ids);
    const itemId = identifier(input.itemId, "inventory_planning_item_invalid");
    const locationId = identifier(input.locationId, "inventory_planning_location_invalid");
    const expectedLocation = `${scope.outletId}:USABLE`;
    if (locationId !== expectedLocation) throw failure("inventory_planning_location_not_canonical", 422);

    // One statement provides one MVCC snapshot: state, revision and observed time
    // cannot be mixed across commits even with a pooled connection.
    const row = (await this.db.query(
      `select organization_id,outlet_id,revision,snapshot,updated_at
         from sagaops.pos_hpp_catalog_state
        where organization_id=$1 and outlet_id=$2`,
      scopeParams(scope),
    )).rows[0];
    if (!row) throw failure("inventory_planning_inventory_snapshot_missing", 503);
    if (row.organization_id !== scope.organizationId || row.outlet_id !== scope.outletId) throw failure("inventory_planning_postgres_scope_mismatch");
    const state = jsonObject(row.snapshot, "inventory_planning_inventory_snapshot_invalid");
    const revision = nonNegativeInteger(Number(row.revision), "inventory_planning_inventory_snapshot_invalid");
    const observedAt = iso(row.updated_at, "inventory_planning_inventory_snapshot_invalid");
    const balance = array(state.inventoryBalances, "inventory_planning_inventory_snapshot_invalid").find((entry) => entry?.ingredientId === itemId);
    if (!balance) throw failure("inventory_planning_item_not_found", 404);
    const onHand = wholeQuantity(balance.quantityBase, "inventory_planning_inventory_quantity_not_discrete");
    const reserved = array(state.inventoryReservations ?? [], "inventory_planning_inventory_snapshot_invalid")
      .filter((reservation) => reservation?.status === "ACTIVE")
      .flatMap((reservation) => array(reservation.lines, "inventory_planning_inventory_snapshot_invalid"))
      .filter((line) => line?.ingredientId === itemId)
      .reduce((sum, line) => safeAdd(sum, wholeQuantity(line.quantityReservedBase, "inventory_planning_inventory_quantity_not_discrete")), 0);
    const incoming = projectIncoming(state.purchaseOrders ?? [], itemId);

    return {
      ...scope,
      itemId,
      locationId,
      revision,
      observedAt,
      lots: [{ quantity: onHand, qualityState: "USABLE" }],
      reserved,
      confirmedIncoming: incoming.quantity,
      confirmedOutgoing: 0,
      plannedProduction: 0,
      commitments: [],
      supplies: incoming.supplies,
      expiries: [],
    };
  }

  async validatePolicyTarget(input = {}) {
    const scope = scopeInput(input, this.ids);
    const itemId = identifier(input.itemId, "inventory_planning_item_invalid");
    const locationId = identifier(input.locationId, "inventory_planning_location_invalid");
    const expectedLocation = `${scope.outletId}:USABLE`;
    if (locationId !== expectedLocation) throw failure("inventory_planning_location_not_canonical", 422);

    const row = (await this.db.query(
      `select organization_id,outlet_id,snapshot
         from sagaops.pos_hpp_catalog_state
        where organization_id=$1 and outlet_id=$2`,
      scopeParams(scope),
    )).rows[0];
    if (!row) throw failure("inventory_planning_inventory_snapshot_missing", 503);
    if (row.organization_id !== scope.organizationId || row.outlet_id !== scope.outletId) throw failure("inventory_planning_postgres_scope_mismatch");
    const state = jsonObject(row.snapshot, "inventory_planning_inventory_snapshot_invalid");
    const ingredient = array(state.ingredients, "inventory_planning_inventory_snapshot_invalid")
      .find((entry) => entry?.id === itemId && entry?.status === "ACTIVE");
    if (!ingredient) throw failure("inventory_planning_item_not_found", 404);
    return { ...scope, itemId, locationId, valid: true };
  }

  async load(input = {}) {
    const scope = scopeInput(input, this.ids);
    const row = (await this.db.query(
      `select organization_id,outlet_id,revision,state_document,state_hash
         from sagaops.inventory_planning_aggregates
        where organization_id=$1 and outlet_id=$2`,
      scopeParams(scope),
    )).rows[0];
    if (!row) return { ...scope, revision: 0, state: this.#emptyState() };
    const revision = nonNegativeInteger(Number(row.revision), "inventory_planning_persisted_state_invalid");
    const state = jsonObject(row.state_document, "inventory_planning_persisted_state_invalid");
    if (row.organization_id !== scope.organizationId || row.outlet_id !== scope.outletId || state.integrityHash !== row.state_hash) {
      throw failure("inventory_planning_persisted_state_invalid");
    }
    this.#verifyState(state);
    return { ...scope, revision, state };
  }

  async compareAndSwap(input = {}) {
    const scope = scopeInput(input, this.ids);
    const expectedRevision = nonNegativeInteger(input.expectedRevision, "inventory_planning_revision_invalid");
    const operationKey = identifier(input.operationKey, "inventory_planning_operation_key_invalid");
    const operationFingerprint = digest(input.operationFingerprint, "inventory_planning_operation_fingerprint_invalid");
    const actorId = identifier(input.actorId, "inventory_planning_actor_invalid");
    const state = jsonObject(input.state, "inventory_planning_persisted_state_invalid");
    const stateHash = digest(state.integrityHash, "inventory_planning_persisted_state_invalid");
    const occurredAt = iso(input.occurredAt ?? this.clock(), "inventory_planning_timestamp_invalid");
    this.#verifyState(state);

    return this.db.transaction(async (tx) => {
      const replay = (await tx.query(
        `select operation_fingerprint,state_hash,committed_revision
           from sagaops.inventory_planning_operations
          where organization_id=$1 and outlet_id=$2 and operation_key=$3`,
        [...scopeParams(scope), operationKey],
      )).rows[0];
      if (replay) {
        if (replay.operation_fingerprint !== operationFingerprint) throw failure("inventory_planning_operation_collision", 409);
        // Another worker may have committed the same command with a different
        // clock-derived state hash. Force the caller to reload the committed
        // aggregate so it returns that durable result rather than local state.
        if (replay.state_hash !== stateHash) throw failure("inventory_planning_revision_conflict", 409);
        return persisted(scope, operationKey, operationFingerprint, stateHash, Number(replay.committed_revision));
      }

      if (expectedRevision === 0) {
        await tx.query(
          `insert into sagaops.inventory_planning_aggregates
            (organization_id,outlet_id,revision,state_document,state_hash,updated_at)
           values ($1,$2,0,$3,$4,$5)
           on conflict (organization_id,outlet_id) do nothing`,
          [...scopeParams(scope), JSON.stringify(this.#emptyState()), this.#emptyState().integrityHash, occurredAt],
        );
      }
      const aggregate = (await tx.query(
        `select revision from sagaops.inventory_planning_aggregates
          where organization_id=$1 and outlet_id=$2 for update`,
        scopeParams(scope),
      )).rows[0];
      const currentRevision = aggregate ? Number(aggregate.revision) : -1;
      if (currentRevision !== expectedRevision) throw failure("inventory_planning_revision_conflict", 409);
      const nextRevision = expectedRevision + 1;
      const updated = (await tx.query(
        `update sagaops.inventory_planning_aggregates
            set revision=$3,state_document=$4,state_hash=$5,updated_at=$6
          where organization_id=$1 and outlet_id=$2 and revision=$7
          returning revision`,
        [...scopeParams(scope), nextRevision, JSON.stringify(state), stateHash, occurredAt, expectedRevision],
      )).rows[0];
      if (Number(updated?.revision) !== nextRevision) throw failure("inventory_planning_revision_conflict", 409);
      await tx.query(
        `insert into sagaops.inventory_planning_operations
          (organization_id,outlet_id,operation_key,operation_fingerprint,state_hash,committed_revision,actor_reference,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [...scopeParams(scope), operationKey, operationFingerprint, stateHash, nextRevision, actorId, occurredAt],
      );
      await this.faultInjector("before_inventory_planning_commit", { transaction: tx, revision: nextRevision, operationKey });
      return persisted(scope, operationKey, operationFingerprint, stateHash, nextRevision);
    });
  }

  #emptyState() {
    return new ReplenishmentPlanner({ tenantId: `${this.ids.organizationId}:${this.ids.outletId}`, stateIntegrityKey: this.stateIntegrityKey, clock: this.clock }).snapshot();
  }

  #verifyState(state) {
    try {
      new ReplenishmentPlanner({ tenantId: `${this.ids.organizationId}:${this.ids.outletId}`, stateIntegrityKey: this.stateIntegrityKey, clock: this.clock, state });
    } catch {
      throw failure("inventory_planning_persisted_state_invalid");
    }
  }
}

export function createInventoryPlanningPostgresRuntimeOptions({ db, ids, stateIntegrityKey, clock, faultInjector } = {}) {
  const adapter = new InventoryPlanningPostgresAdapter({ db, ids, stateIntegrityKey, clock, faultInjector });
  return { adapter, inventoryReadProvider: adapter, replenishmentStore: adapter };
}

function projectIncoming(orders, itemId) {
  let quantity = 0;
  const supplies = [];
  for (const order of array(orders, "inventory_planning_inventory_snapshot_invalid")) {
    if (!order || !["OPEN", "PARTIALLY_RECEIVED"].includes(order.status)) continue;
    const expectedAt = dateStart(order.expectedDate);
    for (const line of array(order.lines, "inventory_planning_inventory_snapshot_invalid")) {
      if (line?.ingredientId !== itemId) continue;
      const remainingPurchase = Math.max(0, numeric(line.orderedPurchaseQuantity) - numeric(line.deliveredPurchaseQuantity ?? 0));
      const baseQuantity = wholeQuantity(remainingPurchase * numeric(line.baseUnitsPerPurchaseUnit), "inventory_planning_inventory_quantity_not_discrete");
      quantity = safeAdd(quantity, baseQuantity);
      if (baseQuantity > 0) supplies.push({ at: expectedAt, quantity: baseQuantity, status: "CONFIRMED" });
    }
  }
  return { quantity, supplies };
}

function persisted(scope, operationKey, operationFingerprint, stateHash, revision) {
  return { ...scope, operationKey, operationFingerprint, stateHash, revision: nonNegativeInteger(revision, "inventory_planning_persisted_state_invalid") };
}
function scopeInput(input, expected) {
  const scope = { organizationId: uuid(input?.organizationId, "inventory_planning_postgres_scope_invalid"), outletId: uuid(input?.outletId, "inventory_planning_postgres_scope_invalid") };
  if (scope.organizationId !== expected.organizationId || scope.outletId !== expected.outletId) throw failure("inventory_planning_postgres_scope_mismatch", 403);
  return scope;
}
function scopeParams(scope) { return [scope.organizationId, scope.outletId]; }
function uuid(value, code) { if (typeof value !== "string" || !UUID.test(value)) throw failure(code); return value.toLowerCase(); }
function identifier(value, code) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw failure(code, 422); return value; }
function digest(value, code) { if (typeof value !== "string" || !SHA256.test(value)) throw failure(code); return value; }
function jsonObject(value, code) { const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure(code); return parsed; }
function array(value, code) { if (!Array.isArray(value)) throw failure(code); return value; }
function nonNegativeInteger(value, code) { if (!Number.isSafeInteger(value) || value < 0) throw failure(code); return value; }
function numeric(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0) throw failure("inventory_planning_inventory_snapshot_invalid"); return number; }
function wholeQuantity(value, code) { const number = numeric(value); if (!Number.isSafeInteger(number)) throw failure(code, 500); return number; }
function safeAdd(left, right) { const value = left + right; if (!Number.isSafeInteger(value) || value < 0) throw failure("inventory_planning_inventory_snapshot_invalid"); return value; }
function iso(value, code) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw failure(code); return date.toISOString(); }
function dateStart(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure("inventory_planning_inventory_snapshot_invalid"); return `${value}T00:00:00.000Z`; }
function failure(code, statusCode = 500) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
