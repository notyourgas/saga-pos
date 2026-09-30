import { createHash } from "node:crypto";

import { deterministicEsbUuid } from "../services/esb-runtime/checkout-adapter.mjs";

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

export class TableDemoPostgresStore {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("table_demo_db_required");
    this.db = db;
    this.clock = clock;
  }

  async health() {
    const result = await this.db.query(`
      select
        to_regclass('sagaops.table_demo_aggregates') is not null aggregates_ready,
        to_regclass('sagaops.table_demo_events') is not null events_ready,
        to_regclass('public.sagaops_integration_outbox') is not null outbox_ready
    `);
    const row = result.rows[0] ?? {};
    return {
      ready: row.aggregates_ready === true && row.events_ready === true && row.outbox_ready === true,
      scope: "TABLE_ORDER_DEMO_POSTGRES_ISOLATED",
      businessFactsAffected: false,
    };
  }

  async load({ organizationId, outletId } = {}) {
    requireUuid(organizationId, "table_demo_organization_invalid");
    requireUuid(outletId, "table_demo_outlet_invalid");
    const result = await this.db.query(
      `select order_id,revision,state,created_at,updated_at
         from sagaops.table_demo_aggregates
        where organization_id=$1 and outlet_id=$2
        order by created_at,order_id`,
      [organizationId, outletId],
    );
    return result.rows.map(mapAggregate);
  }

  async persist({ organizationId, outletId, orderId, kioskSessionId, idempotencyKey, expectedRevision, state, eventKey, eventType, actorReference = "SYSTEM_TABLE_DEMO" } = {}) {
    const normalized = validateWrite({ organizationId, outletId, orderId, kioskSessionId, idempotencyKey, expectedRevision, state, eventKey, eventType, actorReference });
    const now = this.clock().toISOString();
    const fingerprint = sha256(stableJson({
      organizationId, outletId, orderId, eventType,
      actorReference: normalized.actorReference,
      paymentId: normalized.state.payments.at(-1)?.id ?? null,
      paymentStatus: normalized.state.payments.at(-1)?.status ?? null,
    }));
    const eventId = deterministicEsbUuid(`table-demo:${organizationId}:${eventKey}`);
    return this.db.transaction(async (tx) => {
      const replay = (await tx.query(
        `select event_fingerprint,result_state,result_revision,outbox_event_id
           from sagaops.table_demo_events
          where organization_id=$1 and event_key=$2`,
        [organizationId, eventKey],
      )).rows[0];
      if (replay) {
        if (replay.event_fingerprint !== fingerprint) throw storeError("table_demo_event_idempotency_conflict", 409);
        return {
          state: structuredClone(replay.result_state),
          revision: Number(replay.result_revision),
          outboxEventId: replay.outbox_event_id,
          idempotentReplay: true,
        };
      }

      const current = (await tx.query(
        `select revision,state
           from sagaops.table_demo_aggregates
          where organization_id=$1 and outlet_id=$2 and order_id=$3
          for update`,
        [organizationId, outletId, orderId],
      )).rows[0];
      const currentRevision = current ? Number(current.revision) : 0;
      if (currentRevision !== expectedRevision) throw storeError("table_demo_revision_conflict", 409);
      const revision = currentRevision + 1;
      const persistedState = { ...normalized.state, revision };

      if (current) {
        await tx.query(
          `update sagaops.table_demo_aggregates
              set revision=$4,state=$5::jsonb,updated_at=$6
            where organization_id=$1 and outlet_id=$2 and order_id=$3`,
          [organizationId, outletId, orderId, revision, JSON.stringify(persistedState), now],
        );
      } else {
        await tx.query(
          `insert into sagaops.table_demo_aggregates
            (order_id,organization_id,outlet_id,kiosk_session_id,idempotency_key,revision,state,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`,
          [orderId, organizationId, outletId, kioskSessionId, idempotencyKey, revision, JSON.stringify(persistedState), now],
        );
      }

      const outboxPayload = {
        contractVersion: "SAGAPOS_TABLE_DEMO_V1",
        aggregateId: orderId,
        organizationId,
        outletId,
        source: "TABLE",
        demoSource: normalized.state.order.demoSource ?? "TABLE_QR_DEMO",
        demoOnly: true,
        businessFact: false,
        revision,
        status: normalized.state.order.status,
        paymentStatus: normalized.state.payments.at(-1)?.status ?? null,
        fulfillmentStatus: normalized.state.fulfillment?.status ?? null,
        tableLabel: normalized.state.order.tableLabel,
        occurredAt: now,
      };
      await tx.query(
        `insert into public.sagaops_integration_outbox
          (id,organization_id,outlet_id,event_id,event_type,payload,status,attempts,available_at,created_at)
         values($1,$2,$3,$1,$4,$5::jsonb,'pending',0,$6,$6)`,
        [eventId, organizationId, outletId, eventType, JSON.stringify(outboxPayload), now],
      );
      await tx.query(
        `insert into sagaops.table_demo_events
          (organization_id,outlet_id,event_key,event_fingerprint,order_id,event_type,payload_redacted,result_state,result_revision,outbox_event_id,occurred_at)
         values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
        [organizationId, outletId, eventKey, fingerprint, orderId, eventType, JSON.stringify(outboxPayload), JSON.stringify(persistedState), revision, eventId, now],
      );
      return { state: persistedState, revision, outboxEventId: eventId, idempotentReplay: false };
    });
  }
}

function validateWrite(input) {
  requireUuid(input.organizationId, "table_demo_organization_invalid");
  requireUuid(input.outletId, "table_demo_outlet_invalid");
  requireUuid(input.orderId, "table_demo_order_invalid");
  requireUuid(input.kioskSessionId, "table_demo_session_invalid");
  const idempotencyKey = bounded(input.idempotencyKey, 160, "table_demo_idempotency_key_invalid");
  const eventKey = bounded(input.eventKey, 200, "table_demo_event_key_invalid");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw storeError("table_demo_revision_invalid", 422);
  if (!EVENT_TYPES.has(input.eventType)) throw storeError("table_demo_event_type_invalid", 422);
  const state = structuredClone(input.state);
  if (!state || state.order?.id !== input.orderId || state.order?.kioskSessionId !== input.kioskSessionId) throw storeError("table_demo_state_scope_invalid", 422);
  if (state.order.organizationId !== input.organizationId || state.order.outletId !== input.outletId) throw storeError("table_demo_state_scope_invalid", 422);
  if (state.order.channel !== "TABLE" || state.order.testMode !== true || state.order.demoPayment !== true) throw storeError("table_demo_state_not_isolated", 422);
  if (!state.order.tableId || !state.order.tableLabel || state.order.memberId != null) throw storeError("table_demo_state_privacy_invalid", 422);
  if (!["TABLE_QR_DEMO", "KIOSK_DEMO"].includes(state.order.demoSource ?? "TABLE_QR_DEMO")) throw storeError("table_demo_source_invalid", 422);
  if (!Array.isArray(state.items) || !Array.isArray(state.payments) || state.payments.some((payment) => payment.orderId !== input.orderId || payment.methodType !== "qris_demo" || payment.demoOnly !== true)) throw storeError("table_demo_payment_state_invalid", 422);
  if (state.fulfillment && (state.fulfillment.orderId !== input.orderId || !["PAID", "COMPLETED"].includes(state.order.status))) throw storeError("table_demo_fulfillment_state_invalid", 422);
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw storeError("table_demo_state_too_large", 413);
  return { state, idempotencyKey, eventKey, actorReference: bounded(input.actorReference, 120, "table_demo_actor_invalid") };
}

function mapAggregate(row) {
  return { orderId: row.order_id, revision: Number(row.revision), state: structuredClone(row.state), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function iso(value) { return value instanceof Date ? value.toISOString() : value; }
function requireUuid(value, code) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""))) throw storeError(code, 422); }
function bounded(value, limit, code) { const text = String(value ?? "").trim(); if (!text || text.length > limit) throw storeError(code, 422); return text; }
function storeError(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
