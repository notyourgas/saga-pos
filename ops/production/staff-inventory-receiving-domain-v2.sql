-- SagaPOS staff receiving domain hardening V2.
-- Additive companion migration. V1 remains immutable for retained rollback.

alter table sagaops.staff_inventory_capabilities add column if not exists outlet_id uuid;

update sagaops.staff_inventory_capabilities c
   set outlet_id=p.outlet_id
  from sagaops.staff_profiles p
 where p.id=c.staff_id
   and p.organization_id=c.organization_id
   and c.outlet_id is null;

do $$ begin
  if exists (select 1 from sagaops.staff_inventory_capabilities where outlet_id is null) then
    raise exception 'staff_inventory_capability_outlet_backfill_failed';
  end if;
end $$;

-- Retained V1 runtime does not send outlet_id yet. Derive it from the
-- organization-scoped staff profile so V2 can be installed before activation
-- and the retained runtime remains usable during rollback.
create or replace function sagaops.staff_inventory_capability_set_outlet()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog,sagaops
as $$
begin
  if new.outlet_id is null then
    select p.outlet_id
      into new.outlet_id
      from sagaops.staff_profiles p
     where p.id=new.staff_id
       and p.organization_id=new.organization_id;
  end if;
  if new.outlet_id is null then
    raise exception 'staff_inventory_capability_outlet_required';
  end if;
  return new;
end;
$$;

revoke all on function sagaops.staff_inventory_capability_set_outlet() from public;
drop trigger if exists staff_inventory_capability_set_outlet on sagaops.staff_inventory_capabilities;
create trigger staff_inventory_capability_set_outlet
before insert or update of organization_id,staff_id,outlet_id
on sagaops.staff_inventory_capabilities
for each row execute function sagaops.staff_inventory_capability_set_outlet();

alter table sagaops.staff_inventory_capabilities alter column outlet_id set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='staff_profiles_receiving_scope_unique') then
    alter table sagaops.staff_profiles add constraint staff_profiles_receiving_scope_unique
      unique (id,organization_id,outlet_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_drafts_scope_unique') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_drafts_scope_unique
      unique (id,organization_id,outlet_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_drafts_actor_scope_unique') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_drafts_actor_scope_unique
      unique (id,organization_id,outlet_id,actor_staff_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_lines_scope_unique') then
    alter table sagaops.inventory_receipt_draft_lines add constraint inventory_receipt_lines_scope_unique
      unique (id,receipt_id,organization_id,outlet_id);
  end if;
end $$;

alter table sagaops.staff_inventory_capabilities drop constraint if exists staff_inventory_capabilities_pkey;
alter table sagaops.staff_inventory_capabilities
  add constraint staff_inventory_capabilities_pkey primary key (organization_id,outlet_id,staff_id,capability);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='staff_inventory_capabilities_staff_scope_fk') then
    alter table sagaops.staff_inventory_capabilities add constraint staff_inventory_capabilities_staff_scope_fk
      foreign key (staff_id,organization_id,outlet_id)
      references sagaops.staff_profiles(id,organization_id,outlet_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_drafts_staff_scope_fk') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_drafts_staff_scope_fk
      foreign key (actor_staff_id,organization_id,outlet_id)
      references sagaops.staff_profiles(id,organization_id,outlet_id);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_lines_parent_scope_fk') then
    alter table sagaops.inventory_receipt_draft_lines add constraint inventory_receipt_lines_parent_scope_fk
      foreign key (receipt_id,organization_id,outlet_id)
      references sagaops.inventory_receipt_drafts(id,organization_id,outlet_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_evidence_parent_scope_fk') then
    alter table sagaops.inventory_receipt_evidence add constraint inventory_receipt_evidence_parent_scope_fk
      foreign key (receipt_id,organization_id,outlet_id)
      references sagaops.inventory_receipt_drafts(id,organization_id,outlet_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_evidence_line_scope_fk') then
    alter table sagaops.inventory_receipt_evidence add constraint inventory_receipt_evidence_line_scope_fk
      foreign key (receipt_line_id,receipt_id,organization_id,outlet_id)
      references sagaops.inventory_receipt_draft_lines(id,receipt_id,organization_id,outlet_id) on delete cascade;
  end if;
end $$;

drop index if exists sagaops.staff_inventory_capabilities_org_idx;
create index staff_inventory_capabilities_org_idx
  on sagaops.staff_inventory_capabilities(organization_id,outlet_id,staff_id)
  where enabled=true;

alter table sagaops.inventory_receipt_operations
  drop constraint if exists inventory_receipt_operations_operation_type_check;
alter table sagaops.inventory_receipt_operations
  add constraint inventory_receipt_operations_operation_type_check
  check (operation_type in ('UPDATE','SUBMIT','REVIEW'));

drop policy if exists staff_inventory_capabilities_owner on sagaops.staff_inventory_capabilities;
create policy staff_inventory_capabilities_owner on sagaops.staff_inventory_capabilities for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));

drop policy if exists staff_inventory_capabilities_own_read on sagaops.staff_inventory_capabilities;
create policy staff_inventory_capabilities_own_read on sagaops.staff_inventory_capabilities for select
  using (staff_id::text=current_setting('app.native_staff_id',true));

drop policy if exists inventory_receipt_lines_staff on sagaops.inventory_receipt_draft_lines;
create policy inventory_receipt_lines_staff on sagaops.inventory_receipt_draft_lines for all
  using (exists (
    select 1 from sagaops.inventory_receipt_drafts r
     where r.id=inventory_receipt_draft_lines.receipt_id
       and r.organization_id=inventory_receipt_draft_lines.organization_id
       and r.outlet_id=inventory_receipt_draft_lines.outlet_id
       and r.actor_staff_id::text=current_setting('app.native_staff_id',true)
  ))
  with check (exists (
    select 1 from sagaops.inventory_receipt_drafts r
     where r.id=inventory_receipt_draft_lines.receipt_id
       and r.organization_id=inventory_receipt_draft_lines.organization_id
       and r.outlet_id=inventory_receipt_draft_lines.outlet_id
       and r.actor_staff_id::text=current_setting('app.native_staff_id',true)
  ));

drop policy if exists inventory_receipt_evidence_staff on sagaops.inventory_receipt_evidence;
create policy inventory_receipt_evidence_staff on sagaops.inventory_receipt_evidence for all
  using (exists (
    select 1 from sagaops.inventory_receipt_drafts r
     where r.id=inventory_receipt_evidence.receipt_id
       and r.organization_id=inventory_receipt_evidence.organization_id
       and r.outlet_id=inventory_receipt_evidence.outlet_id
       and r.actor_staff_id::text=current_setting('app.native_staff_id',true)
  ))
  with check (
    actor_staff_id::text=current_setting('app.native_staff_id',true)
    and exists (
      select 1 from sagaops.inventory_receipt_drafts r
       where r.id=inventory_receipt_evidence.receipt_id
         and r.organization_id=inventory_receipt_evidence.organization_id
         and r.outlet_id=inventory_receipt_evidence.outlet_id
         and r.actor_staff_id=inventory_receipt_evidence.actor_staff_id
    )
  );
