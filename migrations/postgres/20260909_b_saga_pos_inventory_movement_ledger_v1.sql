-- Additive canonical HPP inventory movement facts. This ledger is an immutable
-- projection of HPP quantity authority; it does not own or mutate a stock balance.

create table if not exists sagaops.hpp_inventory_movement_facts (
  ledger_sequence bigint generated always as identity,
  movement_id text not null check (length(movement_id) between 1 and 120),
  organization_id uuid not null,
  outlet_id uuid not null,
  movement_type text not null check (length(movement_type) between 1 and 80),
  source_type text not null check (length(source_type) between 1 and 80),
  source_id text not null check (length(source_id) between 1 and 160),
  source_line_id text not null check (length(source_line_id) between 1 and 160),
  ingredient_id text not null check (length(ingredient_id) between 1 and 160),
  location_id text not null check (length(location_id) between 1 and 160),
  quantity_delta_base numeric(20,6) not null,
  inventory_value_delta_rupiah bigint not null,
  quantity_before_base numeric(20,6) not null check (quantity_before_base >= 0),
  quantity_after_base numeric(20,6) not null check (quantity_after_base >= 0),
  inventory_value_before_rupiah bigint not null check (inventory_value_before_rupiah >= 0),
  inventory_value_after_rupiah bigint not null check (inventory_value_after_rupiah >= 0),
  effective_at timestamptz not null,
  created_at timestamptz not null,
  actor_reference text not null check (length(actor_reference) between 1 and 160),
  reason text not null check (length(trim(reason)) between 1 and 240),
  audit_reference text not null check (length(audit_reference) between 1 and 160),
  reference_type text not null check (length(reference_type) between 1 and 80),
  reference_id text not null check (length(reference_id) between 1 and 160),
  reference_code text,
  reversal_of_movement_id text,
  source_event_id text,
  source_device_id text,
  source_local_sequence bigint,
  hpp_version integer not null check (hpp_version > 0),
  requires_rebuild boolean not null default false,
  movement_fingerprint text not null check (movement_fingerprint ~ '^[0-9a-f]{64}$'),
  primary key (organization_id, outlet_id, movement_id),
  unique (organization_id, outlet_id, source_type, source_id, source_line_id),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict,
  foreign key (organization_id, outlet_id, reversal_of_movement_id)
    references sagaops.hpp_inventory_movement_facts(organization_id, outlet_id, movement_id) on delete restrict,
  check (quantity_after_base = quantity_before_base + quantity_delta_base),
  check (inventory_value_after_rupiah = inventory_value_before_rupiah + inventory_value_delta_rupiah),
  check ((movement_type = 'REVERSAL' and reversal_of_movement_id is not null)
    or movement_type <> 'REVERSAL'),
  check ((source_type = 'OFFLINE_EVENT' and source_event_id=source_id and source_device_id is not null and source_local_sequence is not null)
    or (source_type <> 'OFFLINE_EVENT' and source_event_id is null and source_device_id is null and source_local_sequence is null))
);

create unique index if not exists hpp_inventory_offline_event_line_unique
  on sagaops.hpp_inventory_movement_facts(organization_id,outlet_id,source_event_id,source_line_id)
  where source_event_id is not null;
create unique index if not exists hpp_inventory_offline_device_sequence_line_unique
  on sagaops.hpp_inventory_movement_facts(organization_id,outlet_id,source_device_id,source_local_sequence,source_line_id)
  where source_device_id is not null;
create index if not exists hpp_inventory_movement_rebuild_idx
  on sagaops.hpp_inventory_movement_facts(organization_id,outlet_id,location_id,ingredient_id,effective_at,ledger_sequence);

create or replace view sagaops.hpp_inventory_stock_projection as
select organization_id,outlet_id,location_id,ingredient_id,
       sum(quantity_delta_base)::numeric(20,6) as quantity_base,
       sum(inventory_value_delta_rupiah)::bigint as inventory_value_rupiah,
       max(effective_at) as latest_effective_at,
       count(*)::bigint as movement_count
  from sagaops.hpp_inventory_movement_facts
 group by organization_id,outlet_id,location_id,ingredient_id;

create or replace function sagaops.prevent_hpp_inventory_movement_fact_mutation()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin
  raise exception 'hpp_inventory_movement_fact_append_only' using errcode='55000';
end;
$$;

drop trigger if exists hpp_inventory_movement_fact_append_only on sagaops.hpp_inventory_movement_facts;
create trigger hpp_inventory_movement_fact_append_only
before update or delete on sagaops.hpp_inventory_movement_facts
for each row execute function sagaops.prevent_hpp_inventory_movement_fact_mutation();

alter table sagaops.hpp_inventory_movement_facts enable row level security;
alter table sagaops.hpp_inventory_movement_facts force row level security;
drop policy if exists hpp_inventory_movement_fact_scope on sagaops.hpp_inventory_movement_facts;
create policy hpp_inventory_movement_fact_scope on sagaops.hpp_inventory_movement_facts for all
using (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

revoke all on sagaops.hpp_inventory_movement_facts from anon,authenticated;
do $$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select,insert on sagaops.hpp_inventory_movement_facts to service_role';
    execute 'grant select on sagaops.hpp_inventory_stock_projection to service_role';
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-private') then
    execute 'grant select,insert on sagaops.hpp_inventory_movement_facts to "sagaops-private"';
    execute 'grant select on sagaops.hpp_inventory_stock_projection to "sagaops-private"';
  end if;
end $$;
