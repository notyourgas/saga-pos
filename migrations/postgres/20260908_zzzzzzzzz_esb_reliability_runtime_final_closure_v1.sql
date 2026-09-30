-- SagaPOS ESB DATA-04 / STOCK-05 / SHIFT-01 runtime closure.
-- Additive and forward compatible. No provider, payment rail, printer, or
-- production activation is performed by this migration.

alter table sagaops.esb_reliability_authorizations
  drop constraint if exists esb_reliability_authorizations_action_check;
alter table sagaops.esb_reliability_authorizations
  add constraint esb_reliability_authorizations_action_check
  check (action in (
    'inventory:negative_stock','shift:reopen','shift:close',
    'inventory:purchase','inventory:adjustment','inventory:waste','inventory:reversal'
  ));

alter table sagaops.cash_sessions add column if not exists closing_note text;
alter table sagaops.orders add column if not exists pax_count integer;
alter table sagaops.orders drop constraint if exists orders_pax_count_check;
alter table sagaops.orders add constraint orders_pax_count_check
  check (pax_count is null or pax_count between 1 and 1000);

create table if not exists sagaops.esb_reliability_approval_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  operation_key text not null,
  actor_reference text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  command_snapshot jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED')),
  authorization_id text,
  approved_by_reference text,
  requested_at timestamptz not null,
  approved_at timestamptz,
  unique (organization_id, operation_key),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (authorization_id, organization_id, outlet_id)
    references sagaops.esb_reliability_authorizations(id, organization_id, outlet_id) on delete restrict,
  check ((status='PENDING' and authorization_id is null and approved_by_reference is null and approved_at is null)
    or (status='APPROVED' and authorization_id is not null and approved_by_reference is not null and approved_at is not null)),
  check (approved_by_reference is null or approved_by_reference<>actor_reference)
);

alter table sagaops.esb_reliability_approval_requests enable row level security;
alter table sagaops.esb_reliability_approval_requests force row level security;
drop policy if exists esb_reliability_approval_requests_manager on sagaops.esb_reliability_approval_requests;
create policy esb_reliability_approval_requests_manager on sagaops.esb_reliability_approval_requests
  for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
revoke all on sagaops.esb_reliability_approval_requests from anon, authenticated;

create table if not exists sagaops.esb_inventory_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  ledger_sequence bigint generated always as identity,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  ingredient_id uuid not null,
  operation_key text not null,
  movement_kind text not null check (movement_kind in (
    'CHECKOUT_CONSUMPTION','CHECKOUT_RESTOCK','PURCHASE','ADJUSTMENT','WASTE','REVERSAL'
  )),
  quantity_delta_base numeric(20,6) not null check (quantity_delta_base <> 0),
  before_quantity_base numeric(20,6),
  after_quantity_base numeric(20,6),
  inventory_mode text not null check (inventory_mode in ('TRACKED','UNLIMITED')),
  source_reference text not null check (length(trim(source_reference)) between 1 and 200),
  reversal_of_entry_id uuid,
  authorization_id text,
  actor_reference text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, operation_key),
  unique (organization_id, reversal_of_entry_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, ingredient_id) references sagaops.ingredients(organization_id, id) on delete restrict,
  foreign key (reversal_of_entry_id, organization_id, outlet_id)
    references sagaops.esb_inventory_ledger_entries(id, organization_id, outlet_id) on delete restrict,
  foreign key (authorization_id, organization_id, outlet_id)
    references sagaops.esb_reliability_authorizations(id, organization_id, outlet_id) on delete restrict,
  check ((inventory_mode = 'TRACKED' and before_quantity_base is not null and after_quantity_base is not null)
    or (inventory_mode = 'UNLIMITED' and before_quantity_base is null and after_quantity_base is null)),
  check (inventory_mode = 'UNLIMITED' or after_quantity_base = before_quantity_base + quantity_delta_base),
  check ((movement_kind = 'REVERSAL' and reversal_of_entry_id is not null)
    or (movement_kind <> 'REVERSAL' and reversal_of_entry_id is null)),
  check ((movement_kind = 'CHECKOUT_CONSUMPTION' and authorization_id is null)
    or (movement_kind = 'CHECKOUT_RESTOCK' and authorization_id is null and source_reference like 'legacy:%')
    or (movement_kind = 'REVERSAL' and authorization_id is null and source_reference like 'exception:%')
    or (movement_kind <> 'CHECKOUT_CONSUMPTION' and authorization_id is not null))
);

create unique index if not exists esb_inventory_ledger_manual_source_unique
  on sagaops.esb_inventory_ledger_entries(organization_id,outlet_id,ingredient_id,movement_kind,source_reference)
  where movement_kind in ('PURCHASE','ADJUSTMENT','WASTE');

-- Fail closed if a previous partial run produced a conflicting row. Preserve
-- pre-existing checkout facts when this forward migration is first applied.
do $$
begin
  if exists (
    select 1 from sagaops.esb_inventory_movement_facts source
    join sagaops.esb_inventory_ledger_entries target
      on target.organization_id=source.organization_id and target.operation_key=source.operation_key
    where target.outlet_id<>source.outlet_id or target.ingredient_id<>source.ingredient_id
       or target.movement_kind<>case when source.quantity_delta_base<0 then 'CHECKOUT_CONSUMPTION' else 'CHECKOUT_RESTOCK' end
       or target.quantity_delta_base<>source.quantity_delta_base
       or target.before_quantity_base is distinct from source.before_quantity_base
       or target.after_quantity_base is distinct from source.after_quantity_base
       or target.inventory_mode<>source.inventory_mode
  ) then
    raise exception 'esb_inventory_ledger_backfill_collision' using errcode='23505';
  end if;
end $$;

-- Preserve pre-existing checkout facts when this forward migration is first
-- applied. Future checkouts write both the recipe fact and this shared ledger
-- in the same transaction.
insert into sagaops.esb_inventory_ledger_entries
  (organization_id,outlet_id,ingredient_id,operation_key,movement_kind,quantity_delta_base,
   before_quantity_base,after_quantity_base,inventory_mode,source_reference,occurred_at,created_at)
select organization_id,outlet_id,ingredient_id,operation_key,
       case when quantity_delta_base<0 then 'CHECKOUT_CONSUMPTION' else 'CHECKOUT_RESTOCK' end,
       quantity_delta_base,before_quantity_base,after_quantity_base,inventory_mode,
       case when quantity_delta_base<0 then reservation_id::text else 'legacy:' || reservation_id::text end,
       created_at,created_at
  from sagaops.esb_inventory_movement_facts
on conflict (organization_id, operation_key) do nothing;

create index if not exists esb_inventory_ledger_reconstruct_idx
  on sagaops.esb_inventory_ledger_entries(organization_id,outlet_id,ingredient_id,ledger_sequence);

create table if not exists sagaops.esb_shift_closures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  cash_session_id uuid not null,
  operation_key text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  authorization_id text,
  actor_reference text not null,
  opening_cash_rupiah bigint not null check (opening_cash_rupiah >= 0),
  expected_cash_rupiah bigint not null check (expected_cash_rupiah >= 0),
  declared_cash_rupiah bigint not null check (declared_cash_rupiah >= 0),
  variance_rupiah bigint not null,
  cash_to_leave_rupiah bigint not null check (cash_to_leave_rupiah >= 0),
  deposit_cash_rupiah bigint not null check (deposit_cash_rupiah >= 0),
  close_revision integer not null check (close_revision >= 1),
  movement_count integer not null check (movement_count >= 0),
  ledger_fingerprint text not null check (ledger_fingerprint ~ '^[0-9a-f]{64}$'),
  close_snapshot jsonb not null,
  closed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, operation_key),
  unique (organization_id, outlet_id, cash_session_id, close_revision),
  foreign key (organization_id,outlet_id,cash_session_id)
    references sagaops.cash_sessions(organization_id,outlet_id,id) on delete restrict,
  foreign key (authorization_id,organization_id,outlet_id)
    references sagaops.esb_reliability_authorizations(id,organization_id,outlet_id) on delete restrict,
  foreign key (organization_id,outlet_id) references sagaops.outlets(organization_id,id) on delete cascade
  ,check (cash_to_leave_rupiah + deposit_cash_rupiah = declared_cash_rupiah)
);

create or replace function sagaops.guard_esb_open_cash_session_movement()
returns trigger language plpgsql set search_path=sagaops,public as $$
declare current_status sagaops.cash_session_status;
begin
  if new.cash_session_id is null then return new; end if;
  select status into current_status from sagaops.cash_sessions
   where organization_id=new.organization_id and outlet_id=new.outlet_id and id=new.cash_session_id
   for update;
  if current_status is null then
    raise exception 'cash_session_not_found' using errcode='23503';
  end if;
  if current_status <> 'open' then
    raise exception 'cash_session_open_required' using errcode='55000';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_cash_movement_requires_open_shift on sagaops.esb_cash_movements;
create trigger esb_cash_movement_requires_open_shift before insert on sagaops.esb_cash_movements
  for each row execute function sagaops.guard_esb_open_cash_session_movement();
drop trigger if exists esb_shift_cash_movement_requires_open_shift on sagaops.esb_shift_cash_movements;
create trigger esb_shift_cash_movement_requires_open_shift before insert on sagaops.esb_shift_cash_movements
  for each row execute function sagaops.guard_esb_open_cash_session_movement();

drop trigger if exists esb_inventory_ledger_append_only on sagaops.esb_inventory_ledger_entries;
create trigger esb_inventory_ledger_append_only
  before update or delete on sagaops.esb_inventory_ledger_entries
  for each row execute function sagaops.prevent_esb_reliability_fact_mutation();
drop trigger if exists esb_shift_closure_append_only on sagaops.esb_shift_closures;
create trigger esb_shift_closure_append_only
  before update or delete on sagaops.esb_shift_closures
  for each row execute function sagaops.prevent_esb_reliability_fact_mutation();

alter table sagaops.esb_inventory_ledger_entries enable row level security;
alter table sagaops.esb_inventory_ledger_entries force row level security;
drop policy if exists esb_inventory_ledger_entries_read on sagaops.esb_inventory_ledger_entries;
create policy esb_inventory_ledger_entries_read on sagaops.esb_inventory_ledger_entries for select
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
;
drop policy if exists esb_inventory_ledger_entries_write on sagaops.esb_inventory_ledger_entries;
create policy esb_inventory_ledger_entries_write on sagaops.esb_inventory_ledger_entries for insert
  with check (
    sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
    or (
      sagaops.has_outlet_role(outlet_id, array['cashier_barista']::sagaops.user_role[])
      and authorization_id is null
      and (movement_kind='CHECKOUT_CONSUMPTION' or (movement_kind='REVERSAL' and source_reference like 'exception:%'))
    )
  );

alter table sagaops.esb_shift_closures enable row level security;
alter table sagaops.esb_shift_closures force row level security;
drop policy if exists esb_shift_closures_scope on sagaops.esb_shift_closures;
create policy esb_shift_closures_scope on sagaops.esb_shift_closures for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

revoke all on sagaops.esb_inventory_ledger_entries,sagaops.esb_shift_closures from anon,authenticated;
