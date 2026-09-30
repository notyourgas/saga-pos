-- SagaPOS ESB catalog runtime and Owner Admin expand migration.
-- Additive only. Runtime guard remains OFF unless a reviewed release explicitly
-- selects DUAL_WRITE_V1. Published versions and assignment history are retained.

alter table sagaops.price_book_entries
  add column if not exists product_reference text,
  add column if not exists product_name_snapshot text;

alter table sagaops.price_book_entries
  add constraint sagaops_price_book_entry_name_snapshot_valid
  check (product_name_snapshot is null or length(trim(product_name_snapshot)) between 1 and 120);

create unique index if not exists sagaops_products_org_sku_unique
  on sagaops.products(organization_id, sku)
  where sku is not null;

create unique index if not exists sagaops_price_book_entry_reference_unique
  on sagaops.price_book_entries(price_book_version_id, product_reference)
  where product_reference is not null;

create unique index if not exists sagaops_price_book_version_book_integrity_unique
  on sagaops.price_book_versions(organization_id, id, price_book_id);

create table if not exists sagaops.outlet_price_book_assignments (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid primary key,
  price_book_id uuid not null,
  price_book_version_id uuid not null,
  revision integer not null default 1 check (revision > 0),
  assigned_by_user_id uuid not null references sagaops.user_profiles(id),
  assigned_at timestamptz not null default now(),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, price_book_id)
    references sagaops.price_books(organization_id, id),
  foreign key (organization_id, price_book_version_id, price_book_id)
    references sagaops.price_book_versions(organization_id, id, price_book_id),
  unique (organization_id, outlet_id),
  unique (organization_id, outlet_id, price_book_version_id)
);

create table if not exists sagaops.outlet_price_book_assignment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  price_book_id uuid not null,
  price_book_version_id uuid not null,
  previous_price_book_version_id uuid,
  revision integer not null check (revision > 0),
  operation_key text not null,
  actor_user_id uuid not null references sagaops.user_profiles(id),
  reason text not null check (length(trim(reason)) between 1 and 240),
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, price_book_id)
    references sagaops.price_books(organization_id, id),
  foreign key (organization_id, price_book_version_id)
    references sagaops.price_book_versions(organization_id, id),
  foreign key (organization_id, previous_price_book_version_id)
    references sagaops.price_book_versions(organization_id, id),
  unique (organization_id, operation_key),
  unique (organization_id, outlet_id, revision)
);

create table if not exists sagaops.catalog_free_price_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null,
  price_book_entry_id uuid not null,
  operation_key text not null,
  actor_user_id uuid not null references sagaops.user_profiles(id),
  approved_by_user_id uuid not null references sagaops.user_profiles(id),
  original_price_rupiah bigint not null check (original_price_rupiah between 0 and 9007199254740991),
  requested_price_rupiah bigint not null check (requested_price_rupiah between 0 and 9007199254740991),
  reason text not null check (length(trim(reason)) between 1 and 240),
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_operation_key text,
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, price_book_entry_id)
    references sagaops.price_book_entries(organization_id, id),
  check (approved_at < expires_at),
  check ((consumed_at is null and consumed_by_operation_key is null)
      or (consumed_at is not null and consumed_by_operation_key is not null)),
  unique (organization_id, operation_key),
  unique (organization_id, id)
);

create index if not exists sagaops_outlet_price_book_version_idx
  on sagaops.outlet_price_book_assignments(organization_id, price_book_version_id);
create index if not exists sagaops_catalog_free_price_lookup_idx
  on sagaops.catalog_free_price_authorizations(organization_id, outlet_id, id, expires_at)
  where consumed_at is null;

create or replace function sagaops.prevent_esb_assignment_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'price_book_assignment_history_append_only';
end;
$$;

create trigger esb_assignment_event_append_only
  before update or delete on sagaops.outlet_price_book_assignment_events
  for each row execute function sagaops.prevent_esb_assignment_event_mutation();

create or replace function sagaops.validate_esb_free_price_use()
returns trigger language plpgsql as $$
declare auth_record record;
begin
  select * into auth_record
    from sagaops.catalog_free_price_authorizations
   where organization_id = new.organization_id
     and id::text = new.authorization_id
   for update;
  if not found
     or auth_record.outlet_id <> new.outlet_id
     or auth_record.price_book_entry_id <> new.price_book_entry_id
     or auth_record.operation_key <> new.operation_key
     or auth_record.actor_user_id <> new.actor_user_id
     or auth_record.approved_by_user_id <> new.approved_by_user_id
     or auth_record.original_price_rupiah <> new.original_price_rupiah
     or auth_record.requested_price_rupiah <> new.requested_price_rupiah
     or auth_record.reason <> new.reason
     or auth_record.approved_at <> new.authorized_at
     or auth_record.expires_at <> new.expires_at
     or auth_record.consumed_at is not null
     or new.occurred_at < auth_record.approved_at
     or new.occurred_at >= auth_record.expires_at then
    raise exception 'free_price_authorization_invalid_or_consumed';
  end if;
  update sagaops.catalog_free_price_authorizations
     set consumed_at = new.occurred_at,
         consumed_by_operation_key = new.operation_key
   where organization_id = new.organization_id and id = auth_record.id;
  return new;
end;
$$;

create trigger esb_free_price_use_validate
  before insert on sagaops.free_price_authorization_uses
  for each row execute function sagaops.validate_esb_free_price_use();

create or replace function sagaops.prevent_esb_free_price_authorization_rewrite()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'free_price_authorization_immutable';
  end if;
  if old.consumed_at is not null
     or new.id <> old.id
     or new.organization_id <> old.organization_id
     or new.outlet_id <> old.outlet_id
     or new.price_book_entry_id <> old.price_book_entry_id
     or new.operation_key <> old.operation_key
     or new.actor_user_id <> old.actor_user_id
     or new.approved_by_user_id <> old.approved_by_user_id
     or new.original_price_rupiah <> old.original_price_rupiah
     or new.requested_price_rupiah <> old.requested_price_rupiah
     or new.reason <> old.reason
     or new.approved_at <> old.approved_at
     or new.expires_at <> old.expires_at
     or new.consumed_at is null
     or new.consumed_by_operation_key <> old.operation_key then
    raise exception 'free_price_authorization_immutable';
  end if;
  return new;
end;
$$;

create trigger esb_free_price_authorization_consume_only
  before update or delete on sagaops.catalog_free_price_authorizations
  for each row execute function sagaops.prevent_esb_free_price_authorization_rewrite();

alter table sagaops.outlet_price_book_assignments enable row level security;
alter table sagaops.outlet_price_book_assignments force row level security;
alter table sagaops.outlet_price_book_assignment_events enable row level security;
alter table sagaops.outlet_price_book_assignment_events force row level security;
alter table sagaops.catalog_free_price_authorizations enable row level security;
alter table sagaops.catalog_free_price_authorizations force row level security;

create policy esb_outlet_price_book_assignment_read on sagaops.outlet_price_book_assignments
  for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_outlet_price_book_assignment_owner_write on sagaops.outlet_price_book_assignments
  for all using (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]));
create policy esb_outlet_price_book_event_read on sagaops.outlet_price_book_assignment_events
  for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_outlet_price_book_event_owner_insert on sagaops.outlet_price_book_assignment_events
  for insert with check (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]));
create policy esb_catalog_free_price_owner_read on sagaops.catalog_free_price_authorizations
  for select using (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]));
create policy esb_catalog_free_price_owner_insert on sagaops.catalog_free_price_authorizations
  for insert with check (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]));
create policy esb_catalog_free_price_runtime_consume on sagaops.catalog_free_price_authorizations
  for update using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists esb_pricing_policy_write on sagaops.pricing_policy_versions;
drop policy if exists esb_price_book_write on sagaops.price_books;
drop policy if exists esb_price_book_version_write on sagaops.price_book_versions;
drop policy if exists esb_price_book_entry_write on sagaops.price_book_entries;
drop policy if exists esb_promotion_version_write on sagaops.promotion_versions;
create policy esb_pricing_policy_owner_write on sagaops.pricing_policy_versions
  for all using (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]));
create policy esb_price_book_owner_write on sagaops.price_books
  for all using (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]));
create policy esb_price_book_version_owner_write on sagaops.price_book_versions
  for all using (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]));
create policy esb_price_book_entry_owner_write on sagaops.price_book_entries
  for all using (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]));
create policy esb_promotion_version_owner_write on sagaops.promotion_versions
  for all using (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner']::sagaops.user_role[]));

revoke all on sagaops.outlet_price_book_assignments,
  sagaops.outlet_price_book_assignment_events,
  sagaops.catalog_free_price_authorizations from anon;
