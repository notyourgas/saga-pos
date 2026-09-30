-- Durable inventory planning state. Source inclusion does not authorize target execution.

create table if not exists sagaops.inventory_planning_aggregates (
  organization_id uuid not null,
  outlet_id uuid not null,
  revision integer not null default 0 check (revision >= 0),
  -- HMAC input is stored as opaque canonical JSON text. jsonb would reorder keys
  -- and invalidate an otherwise authentic state during a read/restart.
  state_document text not null check (jsonb_typeof(state_document::jsonb)='object'),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null,
  primary key (organization_id,outlet_id),
  foreign key (organization_id,outlet_id) references sagaops.outlets(organization_id,id) on delete restrict,
  check ((state_document::jsonb->>'integrityHash'=state_hash) is true),
  check ((state_document::jsonb->>'tenantId'=organization_id::text || ':' || outlet_id::text) is true)
);

create table if not exists sagaops.inventory_planning_operations (
  organization_id uuid not null,
  outlet_id uuid not null,
  operation_key text not null check (length(operation_key) between 1 and 128),
  operation_fingerprint text not null check (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  committed_revision integer not null check (committed_revision > 0),
  actor_reference text not null check (length(actor_reference) between 1 and 128),
  occurred_at timestamptz not null,
  primary key (organization_id,outlet_id,operation_key),
  unique (organization_id,outlet_id,committed_revision),
  foreign key (organization_id,outlet_id) references sagaops.inventory_planning_aggregates(organization_id,outlet_id) on delete restrict
);

create or replace function sagaops.guard_inventory_planning_aggregate_cas()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin
  if tg_op='DELETE' then raise exception 'inventory_planning_aggregate_delete_denied' using errcode='55000'; end if;
  if new.organization_id<>old.organization_id or new.outlet_id<>old.outlet_id or new.revision<>old.revision+1 then
    raise exception 'inventory_planning_aggregate_cas_invalid' using errcode='55000';
  end if;
  return new;
end;
$$;

create or replace function sagaops.prevent_inventory_planning_operation_mutation()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin raise exception 'inventory_planning_operation_append_only' using errcode='55000'; end;
$$;

drop trigger if exists inventory_planning_aggregate_cas_guard on sagaops.inventory_planning_aggregates;
create trigger inventory_planning_aggregate_cas_guard before update or delete on sagaops.inventory_planning_aggregates
for each row execute function sagaops.guard_inventory_planning_aggregate_cas();
drop trigger if exists inventory_planning_operation_append_only on sagaops.inventory_planning_operations;
create trigger inventory_planning_operation_append_only before update or delete on sagaops.inventory_planning_operations
for each row execute function sagaops.prevent_inventory_planning_operation_mutation();

alter table sagaops.inventory_planning_aggregates enable row level security;
alter table sagaops.inventory_planning_aggregates force row level security;
alter table sagaops.inventory_planning_operations enable row level security;
alter table sagaops.inventory_planning_operations force row level security;

create policy inventory_planning_aggregate_scope on sagaops.inventory_planning_aggregates for all
using (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));
create policy inventory_planning_operation_scope on sagaops.inventory_planning_operations for all
using (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));

revoke all on sagaops.inventory_planning_aggregates,sagaops.inventory_planning_operations from anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on sagaops.inventory_planning_aggregates to service_role;
    grant select,insert on sagaops.inventory_planning_operations to service_role;
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-private') then
    grant select,insert,update on sagaops.inventory_planning_aggregates to "sagaops-private";
    grant select,insert on sagaops.inventory_planning_operations to "sagaops-private";
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-production') then
    grant select,insert,update on sagaops.inventory_planning_aggregates to "sagaops-production";
    grant select,insert on sagaops.inventory_planning_operations to "sagaops-production";
  end if;
end $$;
