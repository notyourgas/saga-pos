import { createHash, randomUUID } from "node:crypto";

const EVENTS = new Set([
  "KIOSK_STATIC_DEMO_CHECKOUT_CREATED_V1", "KIOSK_STATIC_DEMO_STAFF_CONFIRMED_V1",
  "KIOSK_STATIC_DEMO_KDS_ACKNOWLEDGED_V1", "KIOSK_STATIC_DEMO_KDS_PREPARING_V1",
  "KIOSK_STATIC_DEMO_KDS_READY_V1", "KIOSK_STATIC_DEMO_KDS_SERVED_V1",
  "KIOSK_STATIC_DEMO_KDS_CANCELLED_V1", "KIOSK_STATIC_DEMO_KDS_REMAKE_V1",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

export class KioskStaticDemoPostgresStore {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("kiosk_static_demo_db_required");
    this.db = db;
    this.clock = clock;
  }

  async health() {
    const row = (await this.db.query(`select
      to_regclass('sagaops.kiosk_static_demo_aggregates') is not null aggregates_ready,
      to_regclass('sagaops.kiosk_static_demo_events') is not null events_ready,
      to_regclass('sagaops.kiosk_static_demo_assets') is not null assets_ready,
      to_regclass('public.sagaops_integration_outbox') is not null outbox_ready`)).rows[0];
    return { ready: Object.values(row).every((value) => value === true), scope: "KIOSK_STATIC_DEMO_POSTGRES_ISOLATED", businessFactsAffected: false };
  }

  async load({ organizationId, outletId }) {
    scope(organizationId, outletId);
    const rows = (await this.db.query(`select revision,state from sagaops.kiosk_static_demo_aggregates
      where organization_id=$1 and outlet_id=$2 order by created_at,order_id`, [organizationId, outletId])).rows;
    return rows.map((row) => ({ revision: Number(row.revision), state: structuredClone(row.state) }));
  }

  async persist({ organizationId, outletId, orderId, kioskSessionId, idempotencyKey, expectedRevision, state, eventKey, eventType, actorReference = "SYSTEM_KIOSK_STATIC_DEMO" }) {
    scope(organizationId, outletId);
    for (const value of [orderId, kioskSessionId]) if (!UUID.test(String(value))) throw error("kiosk_static_demo_scope_invalid", 422);
    if (!EVENTS.has(eventType)) throw error("kiosk_static_demo_event_invalid", 422);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw error("kiosk_static_demo_revision_invalid", 422);
    for (const [value, limit] of [[idempotencyKey, 160], [eventKey, 200], [actorReference, 120]]) if (!String(value ?? "").trim() || String(value).length > limit) throw error("kiosk_static_demo_key_invalid", 422);
    const next = structuredClone(state);
    const order = next?.order;
    if (order?.id !== orderId || order.kioskSessionId !== kioskSessionId || order.organizationId !== organizationId || order.outletId !== outletId || order.channel !== "KIOSK" || order.testMode !== true || order.demoPayment !== true || order.memberId != null || order.tableId != null) throw error("kiosk_static_demo_state_not_isolated", 422);
    if (!Array.isArray(next.items) || !Array.isArray(next.payments) || next.payments.length !== 1 || next.payments.some((payment) => payment.orderId !== orderId || payment.methodType !== "qris_manual" || payment.staticQrisDemo !== true || payment.demoOnly !== true || !["PENDING", "PAID"].includes(payment.status))) throw error("kiosk_static_demo_payment_invalid", 422);
    if (next.fulfillment && (next.fulfillment.orderId !== orderId || order.status !== "PAID")) throw error("kiosk_static_demo_fulfillment_invalid", 422);
    if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) throw error("kiosk_static_demo_state_too_large", 413);
    const now = this.clock().toISOString();
    const fingerprint = hash(JSON.stringify({ organizationId, outletId, orderId, eventType, actorReference, paymentStatus: next.payments[0].status, fulfillmentStatus: next.fulfillment?.status ?? null }));
    return this.db.transaction(async (tx) => {
      const replay = (await tx.query(`select event_fingerprint,result_state,result_revision from sagaops.kiosk_static_demo_events where organization_id=$1 and event_key=$2`, [organizationId, eventKey])).rows[0];
      if (replay) {
        if (replay.event_fingerprint !== fingerprint) throw error("kiosk_static_demo_idempotency_conflict", 409);
        return { state: structuredClone(replay.result_state), revision: Number(replay.result_revision), idempotentReplay: true };
      }
      const current = (await tx.query(`select revision from sagaops.kiosk_static_demo_aggregates where organization_id=$1 and outlet_id=$2 and order_id=$3 for update`, [organizationId, outletId, orderId])).rows[0];
      if (Number(current?.revision ?? 0) !== expectedRevision) throw error("kiosk_static_demo_revision_conflict", 409);
      const revision = expectedRevision + 1;
      next.revision = revision;
      if (current) await tx.query(`update sagaops.kiosk_static_demo_aggregates set revision=$4,state=$5::jsonb,updated_at=$6 where organization_id=$1 and outlet_id=$2 and order_id=$3`, [organizationId, outletId, orderId, revision, JSON.stringify(next), now]);
      else await tx.query(`insert into sagaops.kiosk_static_demo_aggregates (order_id,organization_id,outlet_id,kiosk_session_id,idempotency_key,revision,state,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`, [orderId, organizationId, outletId, kioskSessionId, idempotencyKey, revision, JSON.stringify(next), now]);
      const payload = { contractVersion: "SAGAPOS_KIOSK_STATIC_DEMO_V1", aggregateId: orderId, organizationId, outletId, source: "KIOSK", demoOnly: true, businessFact: false, revision, status: order.status, paymentStatus: next.payments[0].status, fulfillmentStatus: next.fulfillment?.status ?? null, occurredAt: now };
      const eventId = randomUUID();
      await tx.query(`insert into public.sagaops_integration_outbox (id,organization_id,outlet_id,event_id,event_type,payload,status,attempts,available_at,created_at) values($1,$2,$3,$1,$4,$5::jsonb,'pending',0,$6,$6)`, [eventId, organizationId, outletId, eventType, JSON.stringify(payload), now]);
      await tx.query(`insert into sagaops.kiosk_static_demo_events (organization_id,outlet_id,event_key,event_fingerprint,order_id,event_type,payload_redacted,result_state,result_revision,outbox_event_id,actor_reference,occurred_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`, [organizationId, outletId, eventKey, fingerprint, orderId, eventType, JSON.stringify(payload), JSON.stringify(next), revision, eventId, actorReference, now]);
      return { state: next, revision, idempotentReplay: false };
    });
  }

  async loadAsset({ organizationId, outletId }) {
    scope(organizationId, outletId);
    const row = (await this.db.query(`select png_bytes,sha256,revision,updated_at from sagaops.kiosk_static_demo_assets where organization_id=$1 and outlet_id=$2`, [organizationId, outletId])).rows[0];
    return row ? { bytes: Buffer.from(row.png_bytes), sha256: row.sha256, revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString() } : null;
  }

  async replaceAsset({ organizationId, outletId, pngBytes, expectedRevision, actorReference }) {
    scope(organizationId, outletId);
    const bytes = Buffer.from(pngBytes ?? []);
    if (bytes.length < 24 || bytes.length > 256 * 1024 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw error("kiosk_static_demo_png_invalid", 422);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 64 || height < 64 || width > 2048 || height > 2048) throw error("kiosk_static_demo_png_dimensions_invalid", 422);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !String(actorReference ?? "").trim()) throw error("kiosk_static_demo_asset_revision_invalid", 422);
    const digest = hash(bytes), now = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const current = (await tx.query(`select revision from sagaops.kiosk_static_demo_assets where organization_id=$1 and outlet_id=$2 for update`, [organizationId, outletId])).rows[0];
      if (Number(current?.revision ?? 0) !== expectedRevision) throw error("kiosk_static_demo_asset_conflict", 409);
      const revision = expectedRevision + 1;
      if (current) await tx.query(`update sagaops.kiosk_static_demo_assets set png_bytes=$3,sha256=$4,revision=$5,updated_at=$6,actor_reference=$7 where organization_id=$1 and outlet_id=$2`, [organizationId, outletId, bytes, digest, revision, now, String(actorReference).slice(0, 120)]);
      else await tx.query(`insert into sagaops.kiosk_static_demo_assets (organization_id,outlet_id,png_bytes,sha256,revision,updated_at,actor_reference) values ($1,$2,$3,$4,$5,$6,$7)`, [organizationId, outletId, bytes, digest, revision, now, String(actorReference).slice(0, 120)]);
      return { sha256: digest, revision, updatedAt: now, demoOnly: true };
    });
  }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function scope(organizationId, outletId) { if (!UUID.test(String(organizationId)) || !UUID.test(String(outletId))) throw error("kiosk_static_demo_scope_invalid", 422); }
function error(code, statusCode) { const result = new Error(code); result.code = code; result.statusCode = statusCode; return result; }
