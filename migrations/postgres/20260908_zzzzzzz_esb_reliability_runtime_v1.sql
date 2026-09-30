-- SagaPOS ESB-adaptation Gate 5 reliability runtime expansion.
-- Additive only. This migration does not activate printer hardware, payment
-- providers, offline auto-resolution, or production traffic.

create unique index if not exists sagaops_ingredients_org_id_unique
  on sagaops.ingredients(organization_id, id);
create unique index if not exists sagaops_cash_sessions_org_outlet_id_unique
  on sagaops.cash_sessions(organization_id, outlet_id, id);

create table if not exists sagaops.esb_reliability_operations (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  operation_key text not null,
  operation_kind text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, operation_key),
  unique (organization_id, outlet_id, operation_key),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (length(operation_key) between 1 and 200)
);

create table if not exists sagaops.esb_inventory_balances (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  ingredient_id uuid not null,
  inventory_mode text not null check (inventory_mode in ('TRACKED','UNLIMITED')),
  quantity_base numeric(20,6) not null default 0,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, outlet_id, ingredient_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, ingredient_id) references sagaops.ingredients(organization_id, id) on delete cascade,
  check (inventory_mode = 'UNLIMITED' or quantity_base >= -99999999999999.999999)
);

create table if not exists sagaops.esb_reliability_authorizations (
  id text not null,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  action text not null check (action in ('inventory:negative_stock','shift:reopen')),
  resource_type text not null,
  resource_id text not null,
  actor_reference text not null,
  requested_by_reference text not null,
  approved_by_reference text not null,
  binding_hash text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE','CONSUMED','REVOKED','EXPIRED')),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_operation_key text,
  primary key (organization_id, id),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (expires_at > issued_at),
  check (requested_by_reference <> approved_by_reference and approved_by_reference <> actor_reference),
  check ((status = 'CONSUMED' and consumed_at is not null and consumed_operation_key is not null)
    or (status <> 'CONSUMED' and consumed_at is null and consumed_operation_key is null))
);

create table if not exists sagaops.esb_inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  operation_key text not null,
  status text not null check (status = 'RESERVED'),
  override_authorization_id text,
  result_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, operation_key),
  foreign key (organization_id, outlet_id, operation_key) references sagaops.esb_reliability_operations(organization_id, outlet_id, operation_key) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (override_authorization_id, organization_id, outlet_id) references sagaops.esb_reliability_authorizations(id, organization_id, outlet_id) on delete restrict
);

create table if not exists sagaops.esb_recipe_consumption_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  reservation_id uuid not null,
  operation_key text not null,
  order_line_reference text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, operation_key),
  foreign key (reservation_id, organization_id, outlet_id) references sagaops.esb_inventory_reservations(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_inventory_movement_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  reservation_id uuid not null,
  recipe_snapshot_id uuid not null,
  ingredient_id uuid not null,
  operation_key text not null,
  quantity_delta_base numeric(20,6) not null check (quantity_delta_base <> 0),
  before_quantity_base numeric(20,6),
  after_quantity_base numeric(20,6),
  inventory_mode text not null check (inventory_mode in ('TRACKED','UNLIMITED')),
  created_at timestamptz not null default now(),
  unique (organization_id, operation_key),
  unique (id, organization_id, outlet_id),
  foreign key (reservation_id, organization_id, outlet_id) references sagaops.esb_inventory_reservations(id, organization_id, outlet_id) on delete restrict,
  foreign key (recipe_snapshot_id, organization_id, outlet_id) references sagaops.esb_recipe_consumption_snapshots(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, ingredient_id) references sagaops.ingredients(organization_id, id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check ((inventory_mode = 'TRACKED' and before_quantity_base is not null and after_quantity_base is not null)
    or (inventory_mode = 'UNLIMITED' and before_quantity_base is null and after_quantity_base is null))
);

create table if not exists sagaops.esb_shift_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  cash_session_id uuid not null,
  operation_key text not null,
  event_type text not null check (event_type in ('CASH_DROP','SHIFT_REOPENED')),
  actor_reference text not null,
  authorization_id text,
  reason text not null check (length(trim(reason)) between 1 and 240),
  event_snapshot jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, operation_key),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id, cash_session_id) references sagaops.cash_sessions(organization_id, outlet_id, id) on delete restrict,
  foreign key (authorization_id, organization_id, outlet_id) references sagaops.esb_reliability_authorizations(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_shift_cash_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  cash_session_id uuid not null,
  shift_event_id uuid not null,
  operation_key text not null,
  movement_kind text not null check (movement_kind in ('CASH_SALE','CASH_REFUND','CASH_IN','CASH_OUT','CASH_DROP')),
  signed_amount_rupiah bigint not null check (signed_amount_rupiah <> 0 and signed_amount_rupiah between -9007199254740991 and 9007199254740991),
  source_reference text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, operation_key),
  foreign key (shift_event_id, organization_id, outlet_id) references sagaops.esb_shift_events(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id, cash_session_id) references sagaops.cash_sessions(organization_id, outlet_id, id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_print_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  bill_id uuid not null,
  logical_job_id text not null,
  source_logical_job_id text,
  destination text not null check (destination in ('KITCHEN','BAR','CHECKER','STICKER')),
  copy_number integer not null default 0 check (copy_number >= 0),
  copy_kind text not null check (copy_kind in ('ORIGINAL','REPRINT')),
  status text not null default 'QUEUED' check (status in ('QUEUED','PRINTED','FAILED','UNKNOWN')),
  hardware_activation text not null default 'OFF_REQUIRES_PHYSICAL_UAT' check (hardware_activation = 'OFF_REQUIRES_PHYSICAL_UAT'),
  station_snapshot jsonb not null,
  template_snapshot jsonb not null,
  sale_snapshot jsonb not null,
  content_snapshot jsonb not null,
  reprint_authorization jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, logical_job_id),
  unique (organization_id, bill_id, destination, copy_number),
  foreign key (bill_id, organization_id, outlet_id) references sagaops.esb_bills(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check ((copy_kind = 'ORIGINAL' and copy_number = 0 and source_logical_job_id is null and reprint_authorization is null)
    or (copy_kind = 'REPRINT' and copy_number > 0 and source_logical_job_id is not null and reprint_authorization is not null))
);

create table if not exists sagaops.esb_print_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  print_job_id uuid not null,
  attempt_id text not null,
  outcome text not null check (outcome in ('PRINTED','FAILED','UNKNOWN')),
  adapter text not null,
  attempted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, attempt_id),
  foreign key (print_job_id, organization_id, outlet_id) references sagaops.esb_print_jobs(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_offline_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  operation_id text not null,
  device_id text not null,
  local_operation_id text not null,
  operation_kind text not null,
  operation_fingerprint text not null check (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  base_versions jsonb not null,
  payload_snapshot jsonb not null,
  status text not null default 'PENDING_REPLAY' check (status in ('PENDING_REPLAY','APPLIED','REVIEW_REQUIRED','REJECTED')),
  occurred_at timestamptz not null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, outlet_id, operation_id),
  unique (organization_id, outlet_id, device_id, local_operation_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_offline_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  offline_operation_id uuid not null,
  decision text not null check (decision in ('REVIEW_REQUIRED','ACCEPT_SERVER_REQUOTE','REJECT_OFFLINE_OPERATION')),
  conflict_snapshot jsonb not null,
  decided_by_reference text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (offline_operation_id, organization_id, outlet_id) references sagaops.esb_offline_operations(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check ((decision = 'REVIEW_REQUIRED' and decided_by_reference is null and decided_at is null)
    or (decision <> 'REVIEW_REQUIRED' and decided_by_reference is not null and decided_at is not null))
);

create index if not exists esb_reliability_operation_outlet_idx on sagaops.esb_reliability_operations(organization_id, outlet_id, created_at);
create index if not exists esb_inventory_movement_lookup_idx on sagaops.esb_inventory_movement_facts(organization_id, outlet_id, ingredient_id, created_at);
create index if not exists esb_shift_event_lookup_idx on sagaops.esb_shift_events(organization_id, outlet_id, cash_session_id, occurred_at);
create index if not exists esb_print_queue_idx on sagaops.esb_print_jobs(organization_id, outlet_id, status, created_at);
create index if not exists esb_offline_replay_idx on sagaops.esb_offline_operations(organization_id, outlet_id, status, occurred_at);

create or replace function sagaops.prevent_esb_reliability_fact_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'esb_reliability_fact_append_only' using errcode = '55000';
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_reliability_operations','esb_inventory_reservations','esb_recipe_consumption_snapshots',
    'esb_inventory_movement_facts','esb_shift_events','esb_shift_cash_movements','esb_print_attempts'
  ] loop
    execute format('drop trigger if exists esb_reliability_fact_append_only on sagaops.%I', table_name);
    execute format('create trigger esb_reliability_fact_append_only before update or delete on sagaops.%I for each row execute function sagaops.prevent_esb_reliability_fact_mutation()', table_name);
  end loop;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_reliability_operations','esb_inventory_balances','esb_reliability_authorizations',
    'esb_inventory_reservations','esb_recipe_consumption_snapshots','esb_inventory_movement_facts',
    'esb_shift_events','esb_shift_cash_movements','esb_print_jobs','esb_print_attempts',
    'esb_offline_operations','esb_offline_conflicts'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
    execute format(
      'create policy %I on sagaops.%I for all using (sagaops.has_outlet_role(outlet_id, array[''owner'',''manager'',''cashier_barista'']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array[''owner'',''manager'',''cashier_barista'']::sagaops.user_role[]))',
      table_name || '_scope', table_name
    );
  end loop;
end $$;

revoke all on sagaops.esb_reliability_operations, sagaops.esb_inventory_balances,
  sagaops.esb_reliability_authorizations, sagaops.esb_inventory_reservations,
  sagaops.esb_recipe_consumption_snapshots, sagaops.esb_inventory_movement_facts,
  sagaops.esb_shift_events, sagaops.esb_shift_cash_movements,
  sagaops.esb_print_jobs, sagaops.esb_print_attempts,
  sagaops.esb_offline_operations, sagaops.esb_offline_conflicts
from anon, authenticated;
