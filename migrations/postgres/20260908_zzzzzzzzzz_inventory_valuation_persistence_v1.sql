-- Additive inventory valuation persistence. Manifest inclusion does not
-- authorize deployment or target-database mutation.

-- Older SagaOPS schemas key outlets by id and by (organization_id, code), while
-- valuation needs an exact organization/outlet ownership foreign key. Add the
-- compatible candidate key before creating valuation tables.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sagaops_outlets_org_id_unique'
      and conrelid = 'sagaops.outlets'::regclass
  ) and not exists (
    select 1
    from pg_class classes
    join pg_namespace namespaces on namespaces.oid = classes.relnamespace
    where namespaces.nspname = 'sagaops'
      and classes.relname = 'sagaops_outlets_org_id_unique'
  ) then
    alter table sagaops.outlets
      add constraint sagaops_outlets_org_id_unique unique (organization_id, id);
  end if;
end $$;

create table if not exists sagaops.inventory_valuation_aggregates (
  organization_id uuid not null,
  outlet_id uuid not null,
  valuation_scope_id text not null check (length(valuation_scope_id) between 1 and 120),
  revision integer not null default 0 check (revision >= 0),
  updated_at timestamptz not null,
  primary key (organization_id, outlet_id, valuation_scope_id),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict
);

create table if not exists sagaops.inventory_valuation_facts (
  organization_id uuid not null,
  outlet_id uuid not null,
  valuation_scope_id text not null,
  sequence integer not null check (sequence > 0),
  fact_id text not null check (length(fact_id) between 1 and 120),
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  fact_document jsonb not null check (jsonb_typeof(fact_document) = 'object'),
  recorded_at timestamptz not null,
  primary key (organization_id, outlet_id, valuation_scope_id, sequence),
  unique (organization_id, fact_id),
  unique (organization_id, fact_hash),
  foreign key (organization_id, outlet_id, valuation_scope_id)
    references sagaops.inventory_valuation_aggregates(organization_id, outlet_id, valuation_scope_id) on delete restrict,
  check ((jsonb_typeof(fact_document->'sequence') = 'number') is true),
  check (((fact_document->>'sequence')::integer = sequence) is true),
  check ((fact_document->>'factId' = fact_id) is true),
  check ((fact_document->>'factHash' = fact_hash) is true),
  check ((jsonb_typeof(fact_document->'scope') = 'object') is true),
  check ((fact_document->'scope'->>'organizationId' = organization_id::text) is true),
  check ((fact_document->'scope'->>'outletId' = outlet_id::text) is true),
  check ((fact_document->'scope'->>'valuationScopeId' = valuation_scope_id) is true),
  check (((fact_document->>'occurredAt')::timestamptz = recorded_at) is true),
  check ((fact_document->>'type' in ('PROVISIONAL_RECEIPT','INVENTORY_CONSUMPTION','RECEIPT_REVALUATION')) is true)
);

create table if not exists sagaops.inventory_valuation_operations (
  organization_id uuid not null,
  outlet_id uuid not null,
  valuation_scope_id text not null,
  operation_key text not null check (length(operation_key) between 1 and 120),
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  result_document jsonb not null check (jsonb_typeof(result_document) = 'object'),
  result_fingerprint text not null check (result_fingerprint ~ '^[0-9a-f]{64}$'),
  committed_revision integer not null check (committed_revision > 0),
  created_at timestamptz not null,
  primary key (organization_id, operation_key),
  foreign key (organization_id, outlet_id, valuation_scope_id)
    references sagaops.inventory_valuation_aggregates(organization_id, outlet_id, valuation_scope_id) on delete restrict,
  foreign key (organization_id, outlet_id, valuation_scope_id, committed_revision)
    references sagaops.inventory_valuation_facts(organization_id, outlet_id, valuation_scope_id, sequence) on delete restrict,
  check ((jsonb_typeof(result_document->'revision') = 'number') is true),
  check (((result_document->>'revision')::integer = committed_revision) is true),
  check ((jsonb_typeof(result_document->'idempotentReplay') = 'boolean') is true),
  check (((result_document->>'idempotentReplay')::boolean = false) is true),
  check ((jsonb_typeof(result_document->'fact') = 'object') is true),
  check ((jsonb_typeof(result_document->'fact'->'sequence') = 'number') is true),
  check (((result_document->'fact'->>'sequence')::integer = committed_revision) is true),
  check ((result_document->'fact'->>'factId' is not null) is true),
  check ((result_document->'fact'->>'factHash' ~ '^[0-9a-f]{64}$') is true),
  check ((jsonb_typeof(result_document->'fact'->'scope') = 'object') is true),
  check ((result_document->'fact'->'scope'->>'organizationId' = organization_id::text) is true),
  check ((result_document->'fact'->'scope'->>'outletId' = outlet_id::text) is true),
  check ((result_document->'fact'->'scope'->>'valuationScopeId' = valuation_scope_id) is true),
  check ((result_document->'fact'->>'operationKey' = operation_key) is true),
  check ((result_document->'fact'->>'type' in ('PROVISIONAL_RECEIPT','INVENTORY_CONSUMPTION','RECEIPT_REVALUATION')) is true),
  check ((result_document->>'outboxEventId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is true)
);

create index if not exists inventory_valuation_aggregate_outlet_updated_idx
  on sagaops.inventory_valuation_aggregates(organization_id, outlet_id, updated_at desc);
create index if not exists inventory_valuation_fact_recorded_idx
  on sagaops.inventory_valuation_facts(organization_id, outlet_id, valuation_scope_id, recorded_at, sequence);
create index if not exists inventory_valuation_operation_scope_created_idx
  on sagaops.inventory_valuation_operations(organization_id, outlet_id, valuation_scope_id, created_at);
create unique index if not exists inventory_valuation_outbox_operation_unique
  on public.sagaops_integration_outbox(
    organization_id,
    outlet_id,
    (payload->>'valuationScopeId'),
    (payload->>'operationKey')
  ) where event_type = 'INVENTORY_VALUATION_FACT_APPENDED_V1';

create or replace function sagaops.prevent_inventory_valuation_fact_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'inventory_valuation_fact_append_only' using errcode = '55000';
end;
$$;

create or replace function sagaops.prevent_inventory_valuation_operation_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'inventory_valuation_operation_append_only' using errcode = '55000';
end;
$$;

create or replace function sagaops.guard_inventory_valuation_aggregate_cas()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_valuation_aggregate_delete_denied' using errcode = '55000';
  end if;
  if new.organization_id <> old.organization_id
    or new.outlet_id <> old.outlet_id
    or new.valuation_scope_id <> old.valuation_scope_id
    or new.revision <> old.revision + 1 then
    raise exception 'inventory_valuation_aggregate_cas_invalid' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_valuation_fact_append_only on sagaops.inventory_valuation_facts;
create trigger inventory_valuation_fact_append_only
before update or delete on sagaops.inventory_valuation_facts
for each row execute function sagaops.prevent_inventory_valuation_fact_mutation();

drop trigger if exists inventory_valuation_operation_append_only on sagaops.inventory_valuation_operations;
create trigger inventory_valuation_operation_append_only
before update or delete on sagaops.inventory_valuation_operations
for each row execute function sagaops.prevent_inventory_valuation_operation_mutation();

drop trigger if exists inventory_valuation_aggregate_cas_guard on sagaops.inventory_valuation_aggregates;
create trigger inventory_valuation_aggregate_cas_guard
before update or delete on sagaops.inventory_valuation_aggregates
for each row execute function sagaops.guard_inventory_valuation_aggregate_cas();

alter table sagaops.inventory_valuation_aggregates enable row level security;
alter table sagaops.inventory_valuation_aggregates force row level security;
alter table sagaops.inventory_valuation_facts enable row level security;
alter table sagaops.inventory_valuation_facts force row level security;
alter table sagaops.inventory_valuation_operations enable row level security;
alter table sagaops.inventory_valuation_operations force row level security;

drop policy if exists inventory_valuation_aggregate_service_scope on sagaops.inventory_valuation_aggregates;
create policy inventory_valuation_aggregate_service_scope on sagaops.inventory_valuation_aggregates
for all using (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

drop policy if exists inventory_valuation_fact_service_scope on sagaops.inventory_valuation_facts;
create policy inventory_valuation_fact_service_scope on sagaops.inventory_valuation_facts
for all using (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

drop policy if exists inventory_valuation_operation_service_scope on sagaops.inventory_valuation_operations;
create policy inventory_valuation_operation_service_scope on sagaops.inventory_valuation_operations
for all using (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  current_user in ('postgres', 'service_role')
  or sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

revoke all on sagaops.inventory_valuation_aggregates,
  sagaops.inventory_valuation_facts,
  sagaops.inventory_valuation_operations
from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema sagaops to service_role';
    execute 'grant select, insert, update on sagaops.inventory_valuation_aggregates to service_role';
    execute 'grant select, insert on sagaops.inventory_valuation_facts to service_role';
    execute 'grant select, insert on sagaops.inventory_valuation_operations to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'sagaops-private') then
    execute 'grant usage on schema sagaops to "sagaops-private"';
    execute 'grant select, insert, update on sagaops.inventory_valuation_aggregates to "sagaops-private"';
    execute 'grant select, insert on sagaops.inventory_valuation_facts to "sagaops-private"';
    execute 'grant select, insert on sagaops.inventory_valuation_operations to "sagaops-private"';
  end if;
end $$;
