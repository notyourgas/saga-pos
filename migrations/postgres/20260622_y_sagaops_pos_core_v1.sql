-- SagaOPS POS core metadata
-- Sprint 3 - POS Core

do $$
begin
  create type sagaops.sync_status as enum ('synced', 'pending_sync', 'failed');
exception when duplicate_object then null;
end $$;

alter table sagaops.orders
  add column if not exists idempotency_key text,
  add column if not exists sync_status sagaops.sync_status not null default 'synced',
  add column if not exists source_device_id text;

do $$
begin
  alter table sagaops.orders
    add constraint sagaops_orders_outlet_idempotency_unique unique (outlet_id, idempotency_key);
exception when duplicate_object then null;
end $$;

alter table sagaops.payments
  add column if not exists settlement_status text not null default 'unchecked'
    check (settlement_status in ('unchecked', 'checked', 'settled', 'issue')),
  add column if not exists payment_fee_rupiah integer not null default 0 check (payment_fee_rupiah >= 0);

create table if not exists sagaops.pos_checkout_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  idempotency_key text not null,
  order_id uuid references sagaops.orders(id) on delete set null,
  status sagaops.sync_status not null default 'synced',
  request_hash text,
  response_snapshot jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (outlet_id, idempotency_key)
);

create index if not exists sagaops_orders_sync_status_idx on sagaops.orders(outlet_id, sync_status, created_at);
create index if not exists sagaops_pos_checkout_submissions_lookup_idx
  on sagaops.pos_checkout_submissions(outlet_id, idempotency_key);

alter table sagaops.pos_checkout_submissions enable row level security;
alter table sagaops.pos_checkout_submissions force row level security;

drop policy if exists pos_checkout_submissions_scoped on sagaops.pos_checkout_submissions;
create policy pos_checkout_submissions_scoped on sagaops.pos_checkout_submissions
for all using (
  sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);
