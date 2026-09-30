-- Additive, server-scoped inventory location registry and immutable history.
-- Inclusion in the source manifest does not authorize target execution.

create table if not exists sagaops.inventory_location_aggregates (
  organization_id uuid not null,
  outlet_id uuid not null,
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null,
  primary key (organization_id, outlet_id),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict
);

create table if not exists sagaops.inventory_location_facts (
  organization_id uuid not null,
  outlet_id uuid not null,
  sequence integer not null check (sequence > 0),
  fact_id uuid not null,
  operation_key text not null check (length(operation_key) between 1 and 120),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  fact_document jsonb not null check (jsonb_typeof(fact_document) = 'object'),
  actor_reference text not null check (length(actor_reference) between 1 and 120),
  reason text not null check (length(reason) between 1 and 240),
  occurred_at timestamptz not null,
  primary key (organization_id, outlet_id, sequence),
  unique (organization_id, outlet_id, fact_id),
  unique (organization_id, outlet_id, operation_key),
  unique (organization_id, outlet_id, fact_hash),
  foreign key (organization_id, outlet_id)
    references sagaops.inventory_location_aggregates(organization_id, outlet_id) on delete restrict,
  check (((fact_document->>'sequence')::integer = sequence) is true),
  check (((fact_document->>'factId')::uuid = fact_id) is true),
  check ((fact_document->>'operationKey' = operation_key) is true),
  check ((fact_document->>'requestFingerprint' = request_fingerprint) is true),
  check ((fact_document->>'factHash' = fact_hash) is true),
  check ((jsonb_typeof(fact_document->'scope') = 'object') is true),
  check ((fact_document->'scope'->>'organizationId' = organization_id::text) is true),
  check ((fact_document->'scope'->>'outletId' = outlet_id::text) is true),
  check ((fact_document->>'actorId' = actor_reference) is true),
  check ((fact_document->>'reason' = reason) is true),
  check (((fact_document->>'occurredAt')::timestamptz = occurred_at) is true),
  check ((fact_document->>'type' in (
    'LOCATION_CREATED','STOCK_RECEIVED','STOCK_RESERVED','STOCK_RESERVATION_RELEASED',
    'STOCK_TRANSFERRED','WORKSTATION_ASSIGNED','PRODUCTION_CONSUMED','LOCATION_CLOSED'
  )) is true)
);

create index if not exists inventory_location_fact_occurred_idx
  on sagaops.inventory_location_facts(organization_id, outlet_id, occurred_at, sequence);

create or replace function sagaops.prevent_inventory_location_fact_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'inventory_location_fact_append_only' using errcode = '55000';
end;
$$;

create or replace function sagaops.guard_inventory_location_aggregate_cas()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_location_aggregate_delete_denied' using errcode = '55000';
  end if;
  if new.organization_id <> old.organization_id
    or new.outlet_id <> old.outlet_id
    or new.revision <> old.revision + 1 then
    raise exception 'inventory_location_aggregate_cas_invalid' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_location_fact_append_only on sagaops.inventory_location_facts;
create trigger inventory_location_fact_append_only
before update or delete on sagaops.inventory_location_facts
for each row execute function sagaops.prevent_inventory_location_fact_mutation();

drop trigger if exists inventory_location_aggregate_cas_guard on sagaops.inventory_location_aggregates;
create trigger inventory_location_aggregate_cas_guard
before update or delete on sagaops.inventory_location_aggregates
for each row execute function sagaops.guard_inventory_location_aggregate_cas();

alter table sagaops.inventory_location_aggregates enable row level security;
alter table sagaops.inventory_location_aggregates force row level security;
alter table sagaops.inventory_location_facts enable row level security;
alter table sagaops.inventory_location_facts force row level security;

drop policy if exists inventory_location_aggregate_service_scope on sagaops.inventory_location_aggregates;
create policy inventory_location_aggregate_service_scope on sagaops.inventory_location_aggregates
for all using (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

drop policy if exists inventory_location_fact_service_scope on sagaops.inventory_location_facts;
create policy inventory_location_fact_service_scope on sagaops.inventory_location_facts
for all using (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

revoke all on sagaops.inventory_location_aggregates,
  sagaops.inventory_location_facts
from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema sagaops to service_role';
    execute 'grant select, insert, update on sagaops.inventory_location_aggregates to service_role';
    execute 'grant select, insert on sagaops.inventory_location_facts to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'sagaops-private') then
    execute 'grant usage on schema sagaops to "sagaops-private"';
    execute 'grant select, insert, update on sagaops.inventory_location_aggregates to "sagaops-private"';
    execute 'grant select, insert on sagaops.inventory_location_facts to "sagaops-private"';
  end if;
end $$;
