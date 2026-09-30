const PREFIX = "KIOSK_STATIC_DEMO_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class KioskStaticDemoKdsOutboxWorker {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("kiosk_static_demo_kds_db_required");
    this.db = db; this.clock = clock;
  }

  async health() {
    const row = (await this.db.query(`select to_regclass('sagaops.kiosk_static_demo_kds_inbox') is not null inbox_ready,
      to_regclass('sagaops.kiosk_static_demo_kds_projection') is not null projection_ready,
      to_regclass('sagaops.kiosk_static_demo_kds_failures') is not null failures_ready`)).rows[0];
    return { ready: row.inbox_ready && row.projection_ready, scope: "KIOSK_STATIC_DEMO_KDS_POSTGRES", businessFactsAffected: false };
  }

  async metrics({ organizationId, outletId }) {
    checkScope(organizationId, outletId);
    const row = (await this.db.query(`select count(*) filter(where status='pending')::int pending,
      count(*) filter(where status='published')::int published,
      count(*) filter(where status='dead_letter')::int dead_lettered,
      min(created_at) filter(where status='pending') oldest_pending_at,
      (select count(*)::int from sagaops.kiosk_static_demo_kds_inbox where organization_id=$1 and outlet_id=$2) inbox
      from public.sagaops_integration_outbox where organization_id=$1 and outlet_id=$2 and left(event_type,18)='KIOSK_STATIC_DEMO_'`, [organizationId, outletId])).rows[0];
    return { pending: Number(row.pending), published: Number(row.published), deadLettered: Number(row.dead_lettered), inbox: Number(row.inbox), oldestPendingAt: row.oldest_pending_at, demoOnly: true };
  }

  async drain({ organizationId, outletId, limit = 100 }) {
    checkScope(organizationId, outletId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("kiosk_static_demo_kds_limit_invalid");
    const result = { processed: 0, projected: 0, deduplicated: 0, deadLettered: 0 };
    for (let index = 0; index < limit; index += 1) {
      const item = await this.db.transaction(async (tx) => {
        const row = (await tx.query(`select id,event_id,event_type,organization_id,outlet_id,payload from public.sagaops_integration_outbox
          where organization_id=$1 and outlet_id=$2 and left(event_type,18)='KIOSK_STATIC_DEMO_' and status='pending' and available_at <= $3
          order by created_at,event_id for update skip locked limit 1`, [organizationId, outletId, this.clock().toISOString()])).rows[0];
        if (!row) return null;
        const payload = row.payload;
        if (!row.event_type.startsWith(PREFIX) || payload?.organizationId !== organizationId || payload?.outletId !== outletId || payload?.source !== "KIOSK" || payload?.demoOnly !== true || payload?.businessFact !== false || !UUID.test(String(payload?.aggregateId)) || !Number.isSafeInteger(payload?.revision) || payload.revision < 1 || !["PENDING", "PAID"].includes(payload.paymentStatus)) {
          const at = this.clock().toISOString();
          await tx.query(`update public.sagaops_integration_outbox set status='dead_letter',attempts=attempts+1 where id=$1 and status='pending'`, [row.id]);
          await tx.query(`insert into sagaops.kiosk_static_demo_kds_failures (event_id,organization_id,outlet_id,error_code,failed_at)
            values($1,$2,$3,'kiosk_static_demo_kds_payload_invalid',$4) on conflict(event_id) do nothing`, [row.event_id, organizationId, outletId, at]);
          return { deadLettered: true };
        }
        const inserted = (await tx.query(`insert into sagaops.kiosk_static_demo_kds_inbox (event_id,organization_id,outlet_id,order_id,source_revision,processed_at)
          values($1,$2,$3,$4,$5,$6) on conflict(event_id) do nothing returning event_id`, [row.event_id, organizationId, outletId, payload.aggregateId, payload.revision, this.clock().toISOString()])).rowCount === 1;
        let projected = false;
        if (inserted) projected = (await tx.query(`insert into sagaops.kiosk_static_demo_kds_projection (order_id,organization_id,outlet_id,source_revision,order_status,payment_status,fulfillment_status,demo_only,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,true,$8) on conflict(order_id) do update set source_revision=excluded.source_revision,
          order_status=excluded.order_status,payment_status=excluded.payment_status,fulfillment_status=excluded.fulfillment_status,updated_at=excluded.updated_at
          where sagaops.kiosk_static_demo_kds_projection.organization_id=excluded.organization_id
            and sagaops.kiosk_static_demo_kds_projection.outlet_id=excluded.outlet_id
            and sagaops.kiosk_static_demo_kds_projection.source_revision < excluded.source_revision returning order_id`,
          [payload.aggregateId, organizationId, outletId, payload.revision, payload.status, payload.paymentStatus, payload.fulfillmentStatus, this.clock().toISOString()])).rowCount === 1;
        await tx.query(`update public.sagaops_integration_outbox set status='published',attempts=attempts+1,published_at=$2 where id=$1 and status='pending'`, [row.id, this.clock().toISOString()]);
        return { projected, deduplicated: !inserted };
      });
      if (!item) break;
      result.processed += 1;
      if (item.deadLettered) result.deadLettered += 1;
      if (item.projected) result.projected += 1;
      if (item.deduplicated) result.deduplicated += 1;
    }
    return result;
  }
}

function checkScope(organizationId, outletId) {
  if (!UUID.test(String(organizationId)) || !UUID.test(String(outletId))) throw new Error("kiosk_static_demo_kds_scope_invalid");
}
