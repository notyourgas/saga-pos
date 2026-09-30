const EVENT_TYPES = new Set([
  "TABLE_DEMO_CHECKOUT_CREATED_V1",
  "TABLE_DEMO_PAYMENT_PAID_V1",
  "TABLE_DEMO_PAYMENT_FAILED_V1",
  "TABLE_DEMO_PAYMENT_EXPIRED_V1",
  "TABLE_DEMO_PAYMENT_RETRIED_V1",
  "TABLE_DEMO_KDS_ACKNOWLEDGED_V1",
  "TABLE_DEMO_KDS_PREPARING_V1",
  "TABLE_DEMO_KDS_READY_V1",
  "TABLE_DEMO_KDS_SERVED_V1",
  "TABLE_DEMO_KDS_CANCELLED_V1",
  "TABLE_DEMO_KDS_REMAKE_V1",
]);

export class TableDemoKdsOutboxWorker {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("table_demo_kds_db_required");
    this.db = db;
    this.clock = clock;
  }

  async health() {
    const row = (await this.db.query(`select
      to_regclass('sagaops.table_demo_kds_inbox') is not null inbox_ready,
      to_regclass('sagaops.table_demo_kds_projection') is not null projection_ready,
      to_regclass('sagaops.table_demo_kds_failures') is not null failures_ready`)).rows[0] ?? {};
    return { ready: row.inbox_ready === true && row.projection_ready === true && row.failures_ready === true, scope: "TABLE_ORDER_DEMO_KDS_PROJECTION", businessFactsAffected: false };
  }

  async metrics({ organizationId, outletId } = {}) {
    requireUuid(organizationId, "table_demo_kds_organization_invalid");
    requireUuid(outletId, "table_demo_kds_outlet_invalid");
    const row = (await this.db.query(
      `select
         count(*) filter (where status='pending')::int pending,
         count(*) filter (where status='published')::int published,
         count(*) filter (where status='dead_letter')::int dead_letter,
         min(created_at) filter (where status='pending') oldest_pending_at,
         (select count(*)::int from sagaops.table_demo_kds_inbox where organization_id=$1 and outlet_id=$2) inbox,
         (select count(*)::int from sagaops.table_demo_kds_projection where organization_id=$1 and outlet_id=$2) projections,
         (select count(*)::int from sagaops.table_demo_kds_failures where organization_id=$1 and outlet_id=$2 and resolved_at is null) unresolved_failures
       from public.sagaops_integration_outbox
       where organization_id=$1 and outlet_id=$2 and event_type like 'TABLE_DEMO_%'`,
      [organizationId, outletId],
    )).rows[0];
    return {
      pending: Number(row.pending), published: Number(row.published), deadLetter: Number(row.dead_letter),
      inbox: Number(row.inbox), projections: Number(row.projections), unresolvedFailures: Number(row.unresolved_failures),
      oldestPendingAt: iso(row.oldest_pending_at), scope: { organizationId, outletId }, demoOnly: true,
    };
  }

  async retryDeadLetter({ organizationId, outletId, eventId, actorReference, reason } = {}) {
    requireUuid(organizationId, "table_demo_kds_organization_invalid");
    requireUuid(outletId, "table_demo_kds_outlet_invalid");
    requireUuid(eventId, "table_demo_kds_event_invalid");
    const actor = bounded(actorReference, 120, "table_demo_kds_actor_invalid");
    const recoveryReason = bounded(reason, 500, "table_demo_kds_recovery_reason_invalid");
    const now = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        `select id,event_id,event_type,organization_id,outlet_id,payload,status
           from public.sagaops_integration_outbox
          where event_id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [eventId, organizationId, outletId],
      )).rows[0];
      if (!row || row.status !== "dead_letter") throw workerError("table_demo_kds_dead_letter_not_found", 404);
      validatePayload(row);
      await tx.query(
        `update public.sagaops_integration_outbox
            set status='pending',available_at=$2,published_at=null
          where id=$1 and status='dead_letter'`,
        [row.id, now],
      );
      await tx.query(
        `update sagaops.table_demo_kds_failures
            set retry_count=retry_count+1,last_retried_at=$2
          where event_id=$1 and resolved_at is null`,
        [eventId, now],
      );
      await tx.query(
        `insert into sagaops.table_demo_kds_recovery_audit
          (event_id,organization_id,outlet_id,actor_reference,reason,requeued_at)
         values($1,$2,$3,$4,$5,$6)`,
        [eventId, organizationId, outletId, actor, recoveryReason, now],
      );
      return { eventId, status: "pending", requeuedAt: now, actorReference: actor };
    });
  }

  async drain({ organizationId, outletId, limit = 100 } = {}) {
    requireUuid(organizationId, "table_demo_kds_organization_invalid");
    requireUuid(outletId, "table_demo_kds_outlet_invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw workerError("table_demo_kds_limit_invalid", 422);
    const result = { processed: 0, projected: 0, deduplicated: 0, deadLettered: 0 };
    for (let index = 0; index < limit; index += 1) {
      const item = await this.#consumeOne({ organizationId, outletId });
      if (!item) break;
      result.processed += 1;
      if (item.projected) result.projected += 1;
      if (item.deduplicated) result.deduplicated += 1;
      if (item.deadLettered) result.deadLettered += 1;
    }
    return result;
  }

  async #consumeOne({ organizationId, outletId }) {
    const now = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        `select id,event_id,event_type,organization_id,outlet_id,payload
           from public.sagaops_integration_outbox
          where organization_id=$1 and outlet_id=$2 and status='pending'
            and event_type like 'TABLE_DEMO_%' and available_at <= $3
          order by created_at,event_id
          for update skip locked limit 1`,
        [organizationId, outletId, now],
      )).rows[0];
      if (!row) return null;

      let payload;
      try {
        payload = validatePayload(row);
      } catch (error) {
        const errorCode = typeof error?.code === "string" ? error.code : "table_demo_kds_payload_invalid";
        await tx.query(
          `update public.sagaops_integration_outbox
              set status='dead_letter',attempts=attempts+1
            where id=$1 and status='pending'`,
          [row.id],
        );
        await tx.query(
          `insert into sagaops.table_demo_kds_failures
            (event_id,organization_id,outlet_id,error_code,failed_at,retry_count)
           values($1,$2,$3,$4,$5,0)
           on conflict(event_id) do update set error_code=excluded.error_code,failed_at=excluded.failed_at,resolved_at=null`,
          [row.event_id, organizationId, outletId, errorCode, now],
        );
        return { deadLettered: true, code: errorCode };
      }

      const inserted = (await tx.query(
        `insert into sagaops.table_demo_kds_inbox
          (event_id,organization_id,outlet_id,order_id,event_type,source_revision,payload_redacted,processed_at)
         values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         on conflict(event_id) do nothing returning event_id`,
        [row.event_id, organizationId, outletId, payload.aggregateId, row.event_type, payload.revision, JSON.stringify(payload), now],
      )).rowCount === 1;

      let projected = false;
      if (inserted) {
        projected = (await tx.query(
          `insert into sagaops.table_demo_kds_projection
            (order_id,organization_id,outlet_id,source_revision,order_status,payment_status,fulfillment_status,table_label,demo_only,updated_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
           on conflict(order_id) do update set
             source_revision=excluded.source_revision,
             order_status=excluded.order_status,
             payment_status=excluded.payment_status,
             fulfillment_status=excluded.fulfillment_status,
             table_label=excluded.table_label,
             updated_at=excluded.updated_at
           where sagaops.table_demo_kds_projection.organization_id=excluded.organization_id
             and sagaops.table_demo_kds_projection.outlet_id=excluded.outlet_id
             and sagaops.table_demo_kds_projection.source_revision < excluded.source_revision
           returning order_id`,
          [payload.aggregateId, organizationId, outletId, payload.revision, payload.status, payload.paymentStatus, payload.fulfillmentStatus, payload.tableLabel, now],
        )).rowCount === 1;
      }

      await tx.query(
        `update public.sagaops_integration_outbox
            set status='published',attempts=attempts+1,published_at=$2
          where id=$1 and status='pending'`,
        [row.id, now],
      );
      await tx.query(
        `update sagaops.table_demo_kds_failures set resolved_at=$2
          where event_id=$1 and resolved_at is null`,
        [row.event_id, now],
      );
      return { projected, deduplicated: !inserted };
    });
  }
}

export class TableDemoKdsWorkerSupervisor {
  constructor({ worker, scope, clock = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, baseDelayMs = 1_000, maxDelayMs = 30_000, batchLimit = 100 } = {}) {
    if (!worker?.drain) throw new Error("table_demo_kds_worker_required");
    requireUuid(scope?.organizationId, "table_demo_kds_organization_invalid");
    requireUuid(scope?.outletId, "table_demo_kds_outlet_invalid");
    if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 100 || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw workerError("table_demo_kds_backoff_invalid", 422);
    this.worker = worker;
    this.scope = Object.freeze({ organizationId: scope.organizationId, outletId: scope.outletId, limit: batchLimit });
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.active = false;
    this.running = false;
    this.timer = null;
    this.consecutiveFailures = 0;
    this.nextDelayMs = baseDelayMs;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastResult = null;
  }

  start() {
    if (this.active) return false;
    this.active = true;
    this.#schedule(0);
    return true;
  }

  stop() {
    this.active = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return { skipped: true, reason: "already_running" };
    this.running = true;
    this.lastRunAt = this.clock().toISOString();
    try {
      const result = await this.worker.drain(this.scope);
      this.consecutiveFailures = 0;
      this.nextDelayMs = this.baseDelayMs;
      this.lastSuccessAt = this.clock().toISOString();
      this.lastError = null;
      this.lastResult = structuredClone(result);
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.nextDelayMs = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (this.consecutiveFailures - 1)));
      this.lastError = { code: String(error?.code ?? "table_demo_kds_worker_failed"), at: this.clock().toISOString() };
      return { failed: true, error: this.lastError };
    } finally {
      this.running = false;
      if (this.active) this.#schedule(this.nextDelayMs);
    }
  }

  snapshot() {
    return structuredClone({
      active: this.active, running: this.running, consecutiveFailures: this.consecutiveFailures,
      nextDelayMs: this.nextDelayMs, lastRunAt: this.lastRunAt, lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError, lastResult: this.lastResult, scope: this.scope,
    });
  }

  #schedule(delayMs) {
    if (!this.active) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.runOnce(); }, delayMs);
    this.timer?.unref?.();
  }
}

function validatePayload(row) {
  if (!EVENT_TYPES.has(row.event_type)) throw workerError("table_demo_kds_event_type_invalid", 422);
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : structuredClone(row.payload);
  if (!payload || payload.contractVersion !== "SAGAPOS_TABLE_DEMO_V1" || payload.source !== "TABLE"
    || payload.demoOnly !== true || payload.businessFact !== false) throw workerError("table_demo_kds_contract_invalid", 422);
  if (!["TABLE_QR_DEMO", "KIOSK_DEMO"].includes(payload.demoSource ?? "TABLE_QR_DEMO")) throw workerError("table_demo_kds_source_invalid", 422);
  if (payload.organizationId !== row.organization_id || payload.outletId !== row.outlet_id) throw workerError("table_demo_kds_scope_invalid", 403);
  requireUuid(payload.aggregateId, "table_demo_kds_order_invalid");
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw workerError("table_demo_kds_revision_invalid", 422);
  if (typeof payload.tableLabel !== "string" || !payload.tableLabel.trim() || payload.tableLabel.length > 120) throw workerError("table_demo_kds_table_invalid", 422);
  return payload;
}

function requireUuid(value, code) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""))) throw workerError(code, 422);
}

function bounded(value, limit, code) {
  const text = String(value ?? "").trim();
  if (!text || text.length > limit) throw workerError(code, 422);
  return text;
}

function iso(value) { return value instanceof Date ? value.toISOString() : value ?? null; }

function workerError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
