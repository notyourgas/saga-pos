-- Isolated SagaPOS table-order demo persistence.
-- This extension is intentionally outside the fixed 34-entry runtime migration ledger.
-- It stores simulator aggregates only; rows are never revenue, settlement, inventory, or loyalty facts.

create table if not exists public.sagaops_table_demo_schema_migrations (
  name text primary key,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);

create table if not exists sagaops.table_demo_aggregates (
  order_id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  kiosk_session_id uuid not null references sagaops.kiosk_sessions(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 1 and 160),
  revision bigint not null check (revision > 0),
  state jsonb not null check (
    state->'order'->>'channel' = 'TABLE'
    and state->'order'->>'testMode' = 'true'
    and state->'order'->>'demoPayment' = 'true'
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (organization_id,outlet_id,kiosk_session_id,idempotency_key),
  check (updated_at >= created_at)
);

create table if not exists sagaops.table_demo_events (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  event_key text not null check (length(event_key) between 1 and 200),
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  order_id uuid not null references sagaops.table_demo_aggregates(order_id) on delete restrict,
  event_type text not null check (event_type in (
    'TABLE_DEMO_CHECKOUT_CREATED_V1','TABLE_DEMO_PAYMENT_PAID_V1',
    'TABLE_DEMO_PAYMENT_FAILED_V1','TABLE_DEMO_PAYMENT_EXPIRED_V1',
    'TABLE_DEMO_PAYMENT_RETRIED_V1','TABLE_DEMO_KDS_PREPARING_V1',
    'TABLE_DEMO_KDS_READY_V1','TABLE_DEMO_KDS_SERVED_V1',
    'TABLE_DEMO_KDS_ACKNOWLEDGED_V1','TABLE_DEMO_KDS_CANCELLED_V1',
    'TABLE_DEMO_KDS_REMAKE_V1'
  )),
  payload_redacted jsonb not null,
  result_state jsonb not null,
  result_revision bigint not null check (result_revision > 0),
  outbox_event_id uuid not null unique references public.sagaops_integration_outbox(event_id) on delete restrict,
  occurred_at timestamptz not null,
  primary key (organization_id,event_key)
);

create table if not exists sagaops.table_demo_kds_inbox (
  event_id uuid primary key references public.sagaops_integration_outbox(event_id) on delete restrict,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.table_demo_aggregates(order_id) on delete restrict,
  event_type text not null check (event_type like 'TABLE_DEMO_%'),
  source_revision bigint not null check (source_revision > 0),
  payload_redacted jsonb not null check (
    payload_redacted->>'source' = 'TABLE'
    and payload_redacted->>'demoOnly' = 'true'
    and payload_redacted->>'businessFact' = 'false'
  ),
  processed_at timestamptz not null,
  unique (organization_id,outlet_id,order_id,source_revision)
);

create table if not exists sagaops.table_demo_kds_projection (
  order_id uuid primary key references sagaops.table_demo_aggregates(order_id) on delete restrict,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  source_revision bigint not null check (source_revision > 0),
  order_status text not null,
  payment_status text,
  fulfillment_status text,
  table_label text not null check (length(table_label) between 1 and 120),
  demo_only boolean not null check (demo_only),
  updated_at timestamptz not null
);

create table if not exists sagaops.table_demo_kds_failures (
  event_id uuid primary key references public.sagaops_integration_outbox(event_id) on delete restrict,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  error_code text not null check (length(error_code) between 1 and 120),
  failed_at timestamptz not null,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_retried_at timestamptz,
  resolved_at timestamptz
);

create table if not exists sagaops.table_demo_kds_recovery_audit (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.sagaops_integration_outbox(event_id) on delete restrict,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  actor_reference text not null check (length(actor_reference) between 1 and 120),
  reason text not null check (length(reason) between 1 and 500),
  requeued_at timestamptz not null
);

create index if not exists table_demo_aggregate_scope_idx
  on sagaops.table_demo_aggregates(organization_id,outlet_id,updated_at desc);
create index if not exists table_demo_event_order_idx
  on sagaops.table_demo_events(organization_id,outlet_id,order_id,occurred_at);
create index if not exists table_demo_kds_projection_scope_idx
  on sagaops.table_demo_kds_projection(organization_id,outlet_id,updated_at desc);

alter table public.sagaops_table_demo_schema_migrations enable row level security;
alter table public.sagaops_table_demo_schema_migrations force row level security;
alter table sagaops.table_demo_aggregates enable row level security;
alter table sagaops.table_demo_aggregates force row level security;
alter table sagaops.table_demo_events enable row level security;
alter table sagaops.table_demo_events force row level security;
alter table sagaops.table_demo_kds_inbox enable row level security;
alter table sagaops.table_demo_kds_inbox force row level security;
alter table sagaops.table_demo_kds_projection enable row level security;
alter table sagaops.table_demo_kds_projection force row level security;
alter table sagaops.table_demo_kds_failures enable row level security;
alter table sagaops.table_demo_kds_failures force row level security;
alter table sagaops.table_demo_kds_recovery_audit enable row level security;
alter table sagaops.table_demo_kds_recovery_audit force row level security;

drop policy if exists table_demo_schema_runtime_read on public.sagaops_table_demo_schema_migrations;
create policy table_demo_schema_runtime_read on public.sagaops_table_demo_schema_migrations
  for select to "sagaops-production" using (true);
drop policy if exists table_demo_aggregate_runtime on sagaops.table_demo_aggregates;
create policy table_demo_aggregate_runtime on sagaops.table_demo_aggregates for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));
drop policy if exists table_demo_event_runtime on sagaops.table_demo_events;
create policy table_demo_event_runtime on sagaops.table_demo_events for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));
drop policy if exists table_demo_kds_inbox_runtime on sagaops.table_demo_kds_inbox;
create policy table_demo_kds_inbox_runtime on sagaops.table_demo_kds_inbox for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));
drop policy if exists table_demo_kds_projection_runtime on sagaops.table_demo_kds_projection;
create policy table_demo_kds_projection_runtime on sagaops.table_demo_kds_projection for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));
drop policy if exists table_demo_kds_failures_runtime on sagaops.table_demo_kds_failures;
create policy table_demo_kds_failures_runtime on sagaops.table_demo_kds_failures for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));
drop policy if exists table_demo_kds_recovery_audit_runtime on sagaops.table_demo_kds_recovery_audit;
create policy table_demo_kds_recovery_audit_runtime on sagaops.table_demo_kds_recovery_audit for all to "sagaops-production"
  using (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner','manager','cashier_barista']::sagaops.user_role[]));

grant select on public.sagaops_table_demo_schema_migrations to "sagaops-production";
grant select,insert,update on sagaops.table_demo_aggregates to "sagaops-production";
grant select,insert on sagaops.table_demo_events to "sagaops-production";
grant select,insert on sagaops.table_demo_kds_inbox to "sagaops-production";
grant select,insert,update on sagaops.table_demo_kds_projection to "sagaops-production";
grant select,insert,update on sagaops.table_demo_kds_failures to "sagaops-production";
grant select,insert on sagaops.table_demo_kds_recovery_audit to "sagaops-production";
grant usage,select on sequence sagaops.table_demo_kds_recovery_audit_id_seq to "sagaops-production";
revoke all on public.sagaops_table_demo_schema_migrations,sagaops.table_demo_aggregates,sagaops.table_demo_events,sagaops.table_demo_kds_inbox,sagaops.table_demo_kds_projection,sagaops.table_demo_kds_failures,sagaops.table_demo_kds_recovery_audit from anon,authenticated;
