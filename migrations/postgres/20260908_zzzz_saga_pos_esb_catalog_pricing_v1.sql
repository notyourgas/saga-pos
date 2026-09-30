-- SagaPOS ESB-adaptation Gate 4 catalog/pricing expand migration.
-- Additive only. Inclusion in the immutable runtime manifest does not authorize
-- production application or feature activation. Promotion still requires the
-- Implementation Lead's backup/restore, target-engine, expected-current,
-- rollback-compatibility, and direct-production gates.

create unique index if not exists sagaops_products_org_id_unique
  on sagaops.products(organization_id, id);
create unique index if not exists sagaops_promotion_rules_org_id_unique
  on sagaops.promotion_rules(organization_id, id);
create unique index if not exists sagaops_product_variants_org_id_unique
  on sagaops.product_variants(organization_id, id);
create unique index if not exists sagaops_product_variants_org_product_id_unique
  on sagaops.product_variants(organization_id, product_id, id);

create table if not exists sagaops.pricing_policy_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  policy_code text not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','published','retired')),
  currency text not null default 'IDR' check (currency = 'IDR'),
  timezone text not null,
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  service_rate_bps integer not null default 0 check (service_rate_bps between 0 and 10000),
  price_includes_tax boolean not null default false,
  price_includes_service boolean not null default false,
  service_taxable boolean not null default false,
  tax_discount_timing text not null default 'after_discount' check (tax_discount_timing in ('before_discount','after_discount')),
  rounding_mode text not null default 'none' check (rounding_mode in ('none','up','down','nearest_half_up')),
  rounding_step_rupiah bigint not null default 1 check (rounding_step_rupiah between 1 and 100000),
  valid_from timestamptz not null,
  valid_to timestamptz,
  policy_snapshot jsonb not null,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (valid_to is null or valid_to > valid_from),
  check ((status = 'published' and published_at is not null) or status <> 'published'),
  unique (organization_id, policy_code, version),
  unique (organization_id, id)
);

create table if not exists sagaops.price_books (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  code text not null,
  name text not null,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, code),
  unique (organization_id, id)
);

create table if not exists sagaops.price_book_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  price_book_id uuid not null,
  pricing_policy_version_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','published','retired')),
  currency text not null default 'IDR' check (currency = 'IDR'),
  valid_from timestamptz not null,
  valid_to timestamptz,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (valid_to is null or valid_to > valid_from),
  check ((status = 'published' and published_at is not null) or status <> 'published'),
  foreign key (organization_id, price_book_id) references sagaops.price_books(organization_id, id) on delete cascade,
  foreign key (organization_id, pricing_policy_version_id) references sagaops.pricing_policy_versions(organization_id, id),
  unique (organization_id, price_book_id, version),
  unique (organization_id, id)
);

create table if not exists sagaops.price_book_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  price_book_version_id uuid not null,
  product_id uuid not null,
  variant_id uuid references sagaops.product_variants(id),
  price_rupiah bigint not null check (price_rupiah between 0 and 9007199254740991),
  free_price_enabled boolean not null default false,
  minimum_free_price_rupiah bigint not null check (minimum_free_price_rupiah between 0 and 9007199254740991),
  maximum_free_price_rupiah bigint not null check (maximum_free_price_rupiah between 0 and 9007199254740991),
  pos_enabled boolean not null default true,
  online_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  check (minimum_free_price_rupiah <= maximum_free_price_rupiah),
  check (free_price_enabled or (minimum_free_price_rupiah = price_rupiah and maximum_free_price_rupiah = price_rupiah)),
  foreign key (organization_id, price_book_version_id) references sagaops.price_book_versions(organization_id, id) on delete cascade,
  foreign key (organization_id, product_id) references sagaops.products(organization_id, id),
  foreign key (organization_id, product_id, variant_id) references sagaops.product_variants(organization_id, product_id, id),
  unique (organization_id, id)
);

create unique index if not exists sagaops_price_book_entry_identity_unique
  on sagaops.price_book_entries(price_book_version_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists sagaops.promotion_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  promotion_rule_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','published','retired')),
  record_active boolean not null default false,
  promotion_type text not null check (promotion_type in ('percent','fixed','fixed_price')),
  promotion_value bigint not null check (promotion_value between 0 and 9007199254740991),
  minimum_spend_rupiah bigint not null default 0 check (minimum_spend_rupiah between 0 and 9007199254740991),
  cap_rupiah bigint check (cap_rupiah between 0 and 9007199254740991),
  priority integer not null default 100,
  stack_policy text not null default 'exclusive' check (stack_policy in ('exclusive','compatible')),
  stack_group text,
  valid_from timestamptz not null,
  valid_to timestamptz,
  schedule_snapshot jsonb,
  eligibility_snapshot jsonb not null default '{}'::jsonb,
  rule_snapshot jsonb not null,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (valid_to is null or valid_to > valid_from),
  check ((promotion_type = 'percent' and promotion_value between 0 and 10000) or promotion_type <> 'percent'),
  check ((status = 'published' and published_at is not null) or status <> 'published'),
  foreign key (organization_id, promotion_rule_id) references sagaops.promotion_rules(organization_id, id) on delete cascade,
  unique (organization_id, promotion_rule_id, version),
  unique (organization_id, id)
);

create table if not exists sagaops.catalog_pricing_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  operation_key text not null,
  price_book_version_id uuid not null,
  pricing_policy_version_id uuid not null,
  contract_version integer not null default 1 check (contract_version > 0),
  currency text not null default 'IDR' check (currency = 'IDR'),
  total_rupiah bigint not null check (total_rupiah between 0 and 9007199254740991),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  quoted_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, price_book_version_id) references sagaops.price_book_versions(organization_id, id),
  foreign key (organization_id, pricing_policy_version_id) references sagaops.pricing_policy_versions(organization_id, id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  unique (organization_id, operation_key)
);

create table if not exists sagaops.free_price_authorization_uses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  authorization_id text not null,
  operation_key text not null,
  permission text not null check (permission = 'POS_CATALOG_FREE_PRICE_APPLY'),
  action text not null check (action = 'PRICE_OVERRIDE'),
  resource_type text not null check (resource_type = 'PRICE_BOOK_ENTRY'),
  price_book_entry_id uuid not null,
  actor_user_id uuid not null references sagaops.user_profiles(id),
  approved_by_user_id uuid not null references sagaops.user_profiles(id),
  original_price_rupiah bigint not null check (original_price_rupiah between 0 and 9007199254740991),
  requested_price_rupiah bigint not null check (requested_price_rupiah between 0 and 9007199254740991),
  reason text not null check (length(trim(reason)) between 1 and 240),
  authorized_at timestamptz not null,
  expires_at timestamptz not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, price_book_entry_id) references sagaops.price_book_entries(organization_id, id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (authorized_at <= occurred_at and occurred_at < expires_at),
  unique (organization_id, authorization_id),
  unique (organization_id, operation_key)
);

create index if not exists sagaops_pricing_policy_effective_idx
  on sagaops.pricing_policy_versions(organization_id, status, valid_from, valid_to);
create index if not exists sagaops_price_book_effective_idx
  on sagaops.price_book_versions(organization_id, price_book_id, status, valid_from, valid_to);
create index if not exists sagaops_price_book_entry_lookup_idx
  on sagaops.price_book_entries(price_book_version_id, product_id, variant_id);
create index if not exists sagaops_promotion_effective_idx
  on sagaops.promotion_versions(organization_id, record_active, valid_from, valid_to, priority);
create index if not exists sagaops_catalog_pricing_snapshot_outlet_time_idx
  on sagaops.catalog_pricing_snapshots(organization_id, outlet_id, quoted_at desc);
create index if not exists sagaops_catalog_pricing_snapshot_hash_idx
  on sagaops.catalog_pricing_snapshots(organization_id, snapshot_hash);

create or replace function sagaops.prevent_esb_published_pricing_version_mutation()
returns trigger language plpgsql as $$
begin
  if old.status in ('published','retired') then
    raise exception 'published_pricing_version_immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function sagaops.prevent_esb_published_price_entry_mutation()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from sagaops.price_book_versions version
    where version.organization_id = old.organization_id
      and version.id = old.price_book_version_id
      and version.status in ('published','retired')
  ) then
    raise exception 'published_price_book_entry_immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function sagaops.prevent_esb_append_only_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'pricing_history_append_only';
end;
$$;

create trigger esb_pricing_policy_version_immutable
  before update or delete on sagaops.pricing_policy_versions
  for each row execute function sagaops.prevent_esb_published_pricing_version_mutation();
create trigger esb_price_book_version_immutable
  before update or delete on sagaops.price_book_versions
  for each row execute function sagaops.prevent_esb_published_pricing_version_mutation();
create trigger esb_promotion_version_immutable
  before update or delete on sagaops.promotion_versions
  for each row execute function sagaops.prevent_esb_published_pricing_version_mutation();
create trigger esb_price_book_entry_immutable
  before update or delete on sagaops.price_book_entries
  for each row execute function sagaops.prevent_esb_published_price_entry_mutation();
create trigger esb_catalog_pricing_snapshot_append_only
  before update or delete on sagaops.catalog_pricing_snapshots
  for each row execute function sagaops.prevent_esb_append_only_mutation();
create trigger esb_free_price_authorization_use_append_only
  before update or delete on sagaops.free_price_authorization_uses
  for each row execute function sagaops.prevent_esb_append_only_mutation();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'pricing_policy_versions','price_books','price_book_versions','price_book_entries',
    'promotion_versions','catalog_pricing_snapshots','free_price_authorization_uses'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

create policy esb_pricing_policy_read on sagaops.pricing_policy_versions
  for select using (sagaops.can_read_org(organization_id));
create policy esb_pricing_policy_write on sagaops.pricing_policy_versions
  for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_price_book_read on sagaops.price_books
  for select using (sagaops.can_read_org(organization_id));
create policy esb_price_book_write on sagaops.price_books
  for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_price_book_version_read on sagaops.price_book_versions
  for select using (sagaops.can_read_org(organization_id));
create policy esb_price_book_version_write on sagaops.price_book_versions
  for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_price_book_entry_read on sagaops.price_book_entries
  for select using (sagaops.can_read_org(organization_id));
create policy esb_price_book_entry_write on sagaops.price_book_entries
  for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_promotion_version_read on sagaops.promotion_versions
  for select using (sagaops.can_read_org(organization_id));
create policy esb_promotion_version_write on sagaops.promotion_versions
  for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_catalog_snapshot_read on sagaops.catalog_pricing_snapshots
  for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_catalog_snapshot_insert on sagaops.catalog_pricing_snapshots
  for insert with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_free_price_use_read on sagaops.free_price_authorization_uses
  for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_free_price_use_insert on sagaops.free_price_authorization_uses
  for insert with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

revoke all on sagaops.pricing_policy_versions, sagaops.price_books,
  sagaops.price_book_versions, sagaops.price_book_entries,
  sagaops.promotion_versions, sagaops.catalog_pricing_snapshots,
  sagaops.free_price_authorization_uses from anon;
