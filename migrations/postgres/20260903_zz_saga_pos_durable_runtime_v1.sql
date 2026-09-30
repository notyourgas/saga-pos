-- Durable Saga POS local/staging contract.
-- Additive only. This migration does not authorize provider, staging, or production activation.

alter type sagaops.payment_method_type add value if not exists 'qris_dynamic';
alter type sagaops.payment_method_type add value if not exists 'none';
alter type sagaops.payment_status add value if not exists 'pending';
alter type sagaops.payment_status add value if not exists 'failed';
alter type sagaops.payment_status add value if not exists 'expired';
alter type sagaops.payment_status add value if not exists 'cancelled';

alter table sagaops.orders
  add column if not exists channel text not null default 'cashier'
    check (channel in ('kiosk','cashier','admin','api')),
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists kiosk_session_id uuid,
  add column if not exists catalog_version bigint,
  add column if not exists member_id uuid,
  add column if not exists policy_status text,
  add column if not exists rounding_rupiah integer not null default 0;

create unique index if not exists sagaops_order_idempotency_idx
  on sagaops.orders(organization_id, outlet_id, channel, idempotency_key)
  where idempotency_key is not null;

alter table sagaops.order_items
  add column if not exists modifier_snapshot jsonb not null default '[]'::jsonb;

alter table sagaops.payments
  alter column paid_at drop not null,
  add column if not exists idempotency_key text,
  add column if not exists provider text,
  add column if not exists provider_reference text,
  add column if not exists settlement_status text not null default 'unchecked'
    check (settlement_status in ('not_applicable','unchecked','matched','mismatch','held','reconciled','settled')),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists sagaops_payment_idempotency_idx
  on sagaops.payments(order_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists sagaops.pos_order_counters (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  business_date date not null,
  next_value integer not null default 0 check (next_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (outlet_id, business_date)
);

create table if not exists sagaops.kiosk_sessions (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  status text not null default 'active' check (status in ('active','completed','expired','reset')),
  active_order_id uuid references sagaops.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sagaops.pos_provider_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  provider text not null,
  provider_event_key text not null,
  payment_id uuid references sagaops.payments(id) on delete restrict,
  event_type text not null,
  event_fingerprint text not null,
  received_at timestamptz not null default now(),
  unique (organization_id, provider, provider_event_key)
);

create table if not exists sagaops.pos_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  actor_reference text,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid,
  correlation_id text,
  payload_redacted jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists sagaops_kiosk_session_active_idx
  on sagaops.kiosk_sessions(outlet_id, status, updated_at desc);
create index if not exists sagaops_provider_event_payment_idx
  on sagaops.pos_provider_events(payment_id, received_at desc);
create index if not exists sagaops_audit_aggregate_idx
  on sagaops.pos_audit_events(organization_id, aggregate_type, aggregate_id, occurred_at);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'pos_order_counters','kiosk_sessions','pos_provider_events','pos_audit_events'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

create policy pos_counter_read on sagaops.pos_order_counters for select
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_counter_write on sagaops.pos_order_counters for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

create policy kiosk_session_read on sagaops.kiosk_sessions for select
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy kiosk_session_write on sagaops.kiosk_sessions for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

create policy pos_provider_event_read on sagaops.pos_provider_events for select
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy pos_provider_event_write on sagaops.pos_provider_events for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

create policy pos_audit_read on sagaops.pos_audit_events for select
  using (sagaops.can_read_org(organization_id));
create policy pos_audit_write on sagaops.pos_audit_events for insert
  with check (sagaops.has_org_role(organization_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

revoke all on sagaops.pos_order_counters, sagaops.kiosk_sessions,
  sagaops.pos_provider_events, sagaops.pos_audit_events from anon;
