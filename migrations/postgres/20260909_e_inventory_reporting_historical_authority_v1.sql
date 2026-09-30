-- Additive immutable history emitted from canonical SagaPOS authorities.
-- This file is intentionally not in the runtime manifest in this lane.

create table if not exists sagaops.inventory_reporting_master_snapshots (
  organization_id uuid not null,
  outlet_id uuid not null,
  hpp_revision integer not null check (hpp_revision > 0),
  catalog_revision integer not null check (catalog_revision > 0),
  hpp_snapshot jsonb not null check (jsonb_typeof(hpp_snapshot) = 'object'),
  catalog_snapshot jsonb not null check (jsonb_typeof(catalog_snapshot) = 'object'),
  bound_at timestamptz not null,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, outlet_id, catalog_revision, hpp_revision),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict
);

create index if not exists inventory_reporting_master_snapshot_cutoff_idx
  on sagaops.inventory_reporting_master_snapshots(organization_id, outlet_id, bound_at desc, hpp_revision desc);

create table if not exists sagaops.inventory_reporting_order_line_snapshots (
  organization_id uuid not null,
  outlet_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  payment_id uuid not null,
  authority_status text not null check (authority_status in ('VERIFIED_PAYMENT_EVENT','UNVERIFIED_BACKFILL')),
  line_count integer not null check (line_count > 0),
  channel text not null,
  subtotal_rupiah bigint not null check (subtotal_rupiah between 0 and 9007199254740991),
  discount_rupiah bigint not null check (discount_rupiah between 0 and 9007199254740991),
  total_hpp_rupiah bigint not null check (total_hpp_rupiah between 0 and 9007199254740991),
  order_hpp_snapshot_status text not null,
  paid_at timestamptz not null,
  product_name_snapshot text not null,
  quantity_base numeric(20,6) not null check (quantity_base > 0),
  line_total_rupiah bigint not null check (line_total_rupiah between 0 and 9007199254740991),
  recipe_cost_snapshot_rupiah bigint not null check (recipe_cost_snapshot_rupiah between 0 and 9007199254740991),
  line_hpp_snapshot_status text not null,
  recipe_version_snapshot integer check (recipe_version_snapshot is null or recipe_version_snapshot > 0),
  recipe_snapshot jsonb not null check (jsonb_typeof(recipe_snapshot) = 'object'),
  modifier_snapshot jsonb not null check (jsonb_typeof(modifier_snapshot) = 'array'),
  product_reference_snapshot text,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, outlet_id, order_id, order_line_id),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict,
  foreign key (order_id) references sagaops.orders(id) on delete restrict,
  foreign key (order_line_id) references sagaops.order_items(id) on delete restrict,
  foreign key (payment_id) references sagaops.payments(id) on delete restrict
);

create index if not exists inventory_reporting_order_snapshot_cutoff_idx
  on sagaops.inventory_reporting_order_line_snapshots(organization_id, outlet_id, paid_at, order_id, order_line_id);

create table if not exists sagaops.inventory_reporting_production_facts (
  organization_id uuid not null,
  outlet_id uuid not null,
  production_id text not null check (length(production_id) between 1 and 128),
  execution_id text not null check (length(execution_id) between 1 and 128),
  source_state_revision integer not null check (source_state_revision > 0),
  source_state_hash text not null check (source_state_hash ~ '^[0-9a-f]{64}$'),
  source_execution_hash text not null check (source_execution_hash ~ '^[0-9a-f]{64}$'),
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  fact_document jsonb not null check (jsonb_typeof(fact_document) = 'object'),
  completed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, outlet_id, production_id),
  unique (organization_id, outlet_id, execution_id),
  unique (organization_id, outlet_id, fact_hash),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict,
  check ((fact_document->>'productionId' = production_id) is true),
  check ((fact_document->>'executionId' = execution_id) is true),
  check (((fact_document->>'sourceStateRevision')::integer = source_state_revision) is true),
  check ((fact_document->>'sourceStateHash' = source_state_hash) is true),
  check ((fact_document->>'sourceExecutionHash' = source_execution_hash) is true),
  check ((fact_document->>'factHash' = fact_hash) is true),
  check (((fact_document->>'completedAt')::timestamptz = completed_at) is true)
);

create index if not exists inventory_reporting_production_cutoff_idx
  on sagaops.inventory_reporting_production_facts(organization_id, outlet_id, completed_at, production_id);

create or replace function sagaops.capture_inventory_reporting_master_snapshot()
returns trigger language plpgsql security definer set search_path = sagaops, public as $$
declare
  selected_organization_id uuid;
  selected_outlet_id uuid;
  selected_hpp_revision integer;
  selected_catalog_revision integer;
  selected_hpp_snapshot jsonb;
  selected_catalog_snapshot jsonb;
  selected_bound_at timestamptz;
  existing_row sagaops.inventory_reporting_master_snapshots%rowtype;
begin
  select h.organization_id,h.outlet_id,h.revision,c.revision,h.snapshot,c.snapshot,greatest(h.updated_at,c.updated_at)
    into selected_organization_id,selected_outlet_id,selected_hpp_revision,selected_catalog_revision,
         selected_hpp_snapshot,selected_catalog_snapshot,selected_bound_at
    from sagaops.pos_hpp_catalog_state h join sagaops.pos_catalog_state c
      on c.organization_id=h.organization_id and c.outlet_id=h.outlet_id
   where h.organization_id=new.organization_id and h.outlet_id=new.outlet_id;
  if selected_organization_id is null then return new; end if;
  select * into existing_row from sagaops.inventory_reporting_master_snapshots
   where organization_id=selected_organization_id and outlet_id=selected_outlet_id
     and catalog_revision=selected_catalog_revision and hpp_revision=selected_hpp_revision;
  if found then
    if existing_row.hpp_snapshot <> selected_hpp_snapshot
      or existing_row.catalog_snapshot <> selected_catalog_snapshot
      or existing_row.bound_at <> selected_bound_at then
      raise exception 'inventory_reporting_master_snapshot_collision' using errcode='55000';
    end if;
    return new;
  end if;
  begin
    insert into sagaops.inventory_reporting_master_snapshots(
      organization_id,outlet_id,hpp_revision,catalog_revision,hpp_snapshot,catalog_snapshot,bound_at
    ) values (
      selected_organization_id,selected_outlet_id,selected_hpp_revision,selected_catalog_revision,
      selected_hpp_snapshot,selected_catalog_snapshot,selected_bound_at
    );
  exception when unique_violation then
    select * into existing_row from sagaops.inventory_reporting_master_snapshots
     where organization_id=selected_organization_id and outlet_id=selected_outlet_id
       and catalog_revision=selected_catalog_revision and hpp_revision=selected_hpp_revision;
    if not found or existing_row.hpp_snapshot <> selected_hpp_snapshot
      or existing_row.catalog_snapshot <> selected_catalog_snapshot
      or existing_row.bound_at <> selected_bound_at then
      raise exception 'inventory_reporting_master_snapshot_collision' using errcode='55000';
    end if;
  end;
  return new;
end;
$$;

drop trigger if exists inventory_reporting_hpp_snapshot_capture on sagaops.pos_hpp_catalog_state;
create trigger inventory_reporting_hpp_snapshot_capture
after insert or update on sagaops.pos_hpp_catalog_state
for each row execute function sagaops.capture_inventory_reporting_master_snapshot();
drop trigger if exists inventory_reporting_catalog_snapshot_capture on sagaops.pos_catalog_state;
create trigger inventory_reporting_catalog_snapshot_capture
after insert or update on sagaops.pos_catalog_state
for each row execute function sagaops.capture_inventory_reporting_master_snapshot();

create or replace function sagaops.capture_inventory_reporting_paid_order()
returns trigger language plpgsql security definer set search_path = sagaops, public as $$
declare
  captured_line_count integer;
  inserted_line_count integer;
begin
  if new.status::text <> 'paid' or (tg_op = 'UPDATE' and old.status::text = 'paid') then
    return new;
  end if;
  select count(*)::integer into captured_line_count from sagaops.order_items where order_id=new.order_id;
  if captured_line_count < 1 then
    raise exception 'inventory_reporting_paid_order_lines_required' using errcode='55000';
  end if;
  if exists(select 1 from sagaops.inventory_reporting_order_line_snapshots where organization_id=(select organization_id from sagaops.orders where id=new.order_id) and order_id=new.order_id) then
    if exists(select 1 from sagaops.inventory_reporting_order_line_snapshots where order_id=new.order_id and payment_id<>new.id) then
      raise exception 'inventory_reporting_paid_order_snapshot_collision' using errcode='55000';
    end if;
    return new;
  end if;
  insert into sagaops.inventory_reporting_order_line_snapshots(
    organization_id,outlet_id,order_id,order_line_id,payment_id,authority_status,line_count,
    channel,subtotal_rupiah,discount_rupiah,total_hpp_rupiah,order_hpp_snapshot_status,paid_at,
    product_name_snapshot,quantity_base,line_total_rupiah,recipe_cost_snapshot_rupiah,
    line_hpp_snapshot_status,recipe_version_snapshot,recipe_snapshot,modifier_snapshot,product_reference_snapshot
  )
  select o.organization_id,o.outlet_id,o.id,i.id,new.id,'VERIFIED_PAYMENT_EVENT',captured_line_count,
         coalesce(o.channel::text,'other'),o.subtotal_rupiah,o.discount_rupiah,o.total_hpp_rupiah,
         o.hpp_snapshot_status,new.paid_at,i.product_name_snapshot,i.qty,i.line_total_rupiah,
         i.recipe_cost_snapshot_rupiah,i.hpp_snapshot_status,i.recipe_version_snapshot,
         i.recipe_snapshot_json,coalesce(i.modifier_snapshot,'[]'::jsonb),i.product_reference_snapshot
    from sagaops.orders o join sagaops.order_items i on i.order_id=o.id
   where o.id=new.order_id;
  get diagnostics inserted_line_count = row_count;
  if inserted_line_count <> captured_line_count then
    raise exception 'inventory_reporting_paid_order_snapshot_collision' using errcode='55000';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_reporting_paid_order_capture on sagaops.payments;
create trigger inventory_reporting_paid_order_capture
after insert or update of status on sagaops.payments
for each row execute function sagaops.capture_inventory_reporting_paid_order();

create or replace function sagaops.prevent_inventory_reporting_history_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'inventory_reporting_history_append_only' using errcode='55000';
end;
$$;

drop trigger if exists inventory_reporting_master_snapshot_append_only on sagaops.inventory_reporting_master_snapshots;
create trigger inventory_reporting_master_snapshot_append_only before update or delete on sagaops.inventory_reporting_master_snapshots
for each row execute function sagaops.prevent_inventory_reporting_history_mutation();
drop trigger if exists inventory_reporting_order_snapshot_append_only on sagaops.inventory_reporting_order_line_snapshots;
create trigger inventory_reporting_order_snapshot_append_only before update or delete on sagaops.inventory_reporting_order_line_snapshots
for each row execute function sagaops.prevent_inventory_reporting_history_mutation();
drop trigger if exists inventory_reporting_production_fact_append_only on sagaops.inventory_reporting_production_facts;
create trigger inventory_reporting_production_fact_append_only before update or delete on sagaops.inventory_reporting_production_facts
for each row execute function sagaops.prevent_inventory_reporting_history_mutation();

alter table sagaops.inventory_reporting_master_snapshots enable row level security;
alter table sagaops.inventory_reporting_master_snapshots force row level security;
alter table sagaops.inventory_reporting_order_line_snapshots enable row level security;
alter table sagaops.inventory_reporting_order_line_snapshots force row level security;
alter table sagaops.inventory_reporting_production_facts enable row level security;
alter table sagaops.inventory_reporting_production_facts force row level security;

drop policy if exists inventory_reporting_master_snapshot_scope on sagaops.inventory_reporting_master_snapshots;
create policy inventory_reporting_master_snapshot_scope on sagaops.inventory_reporting_master_snapshots for all
using (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));
drop policy if exists inventory_reporting_order_snapshot_scope on sagaops.inventory_reporting_order_line_snapshots;
create policy inventory_reporting_order_snapshot_scope on sagaops.inventory_reporting_order_line_snapshots for all
using (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));
drop policy if exists inventory_reporting_production_fact_scope on sagaops.inventory_reporting_production_facts;
create policy inventory_reporting_production_fact_scope on sagaops.inventory_reporting_production_facts for all
using (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role','sagaops-private') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));

revoke all on sagaops.inventory_reporting_master_snapshots,
  sagaops.inventory_reporting_order_line_snapshots,
  sagaops.inventory_reporting_production_facts from anon,authenticated;

do $$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select,insert on sagaops.inventory_reporting_master_snapshots, sagaops.inventory_reporting_order_line_snapshots, sagaops.inventory_reporting_production_facts to service_role';
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-private') then
    execute 'grant select,insert on sagaops.inventory_reporting_master_snapshots, sagaops.inventory_reporting_order_line_snapshots, sagaops.inventory_reporting_production_facts to "sagaops-private"';
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-reporting') then
    execute 'grant usage on schema sagaops to "sagaops-reporting"';
    execute 'grant select on sagaops.inventory_reporting_master_snapshots, sagaops.inventory_reporting_order_line_snapshots, sagaops.inventory_reporting_production_facts to "sagaops-reporting"';
  end if;
end $$;

-- Existing rows cannot be proven immutable before this migration. Retain them
-- for explicit partial reporting only; new payment events are verified above.
insert into sagaops.inventory_reporting_order_line_snapshots(
  organization_id,outlet_id,order_id,order_line_id,payment_id,authority_status,line_count,
  channel,subtotal_rupiah,discount_rupiah,total_hpp_rupiah,order_hpp_snapshot_status,paid_at,
  product_name_snapshot,quantity_base,line_total_rupiah,recipe_cost_snapshot_rupiah,
  line_hpp_snapshot_status,recipe_version_snapshot,recipe_snapshot,modifier_snapshot,product_reference_snapshot
)
select o.organization_id,o.outlet_id,o.id,i.id,p.id,'UNVERIFIED_BACKFILL',count(*) over(partition by o.id),
       coalesce(o.channel::text,'other'),o.subtotal_rupiah,o.discount_rupiah,o.total_hpp_rupiah,o.hpp_snapshot_status,
       coalesce(o.paid_at,p.paid_at),i.product_name_snapshot,i.qty,i.line_total_rupiah,i.recipe_cost_snapshot_rupiah,
       i.hpp_snapshot_status,i.recipe_version_snapshot,i.recipe_snapshot_json,coalesce(i.modifier_snapshot,'[]'::jsonb),
       i.product_reference_snapshot
  from sagaops.orders o join sagaops.order_items i on i.order_id=o.id
  join lateral (select p.* from sagaops.payments p where p.order_id=o.id and p.status::text='paid' order by p.paid_at,p.id limit 1) p on true
 where o.status::text='paid';

insert into sagaops.inventory_reporting_master_snapshots(
  organization_id,outlet_id,hpp_revision,catalog_revision,hpp_snapshot,catalog_snapshot,bound_at
)
select h.organization_id,h.outlet_id,h.revision,c.revision,h.snapshot,c.snapshot,greatest(h.updated_at,c.updated_at)
  from sagaops.pos_hpp_catalog_state h join sagaops.pos_catalog_state c
    on c.organization_id=h.organization_id and c.outlet_id=h.outlet_id;
