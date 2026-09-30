-- SagaOPS Core MVP schema
-- Sprint 2 Backend Foundation
-- Scope: organization/outlet/auth mapping, catalog, recipe/HPP,
-- POS order/payment, inventory ledger, purchase order, closing, audit.

create extension if not exists pgcrypto;

create schema if not exists sagaops;

do $$
begin
  create type sagaops.user_role as enum ('owner', 'manager', 'cashier_barista', 'hr_admin');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.record_status as enum ('active', 'inactive', 'archived');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.product_status as enum ('draft', 'active', 'inactive', 'archived');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.product_type as enum ('recipe_product', 'stock_item_product', 'bundle_product');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.base_unit as enum ('gram', 'ml', 'pcs');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.order_status as enum ('draft', 'paid', 'voided', 'refunded', 'partially_refunded');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.order_type as enum ('dine_in', 'takeaway', 'delivery_manual');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.payment_method_type as enum ('cash', 'qris_manual', 'transfer', 'debit_card', 'e_wallet', 'other');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.payment_status as enum ('paid', 'voided', 'refunded', 'partially_refunded');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.inventory_movement_type as enum (
    'opening_stock',
    'purchase_received',
    'sale_consumption',
    'waste',
    'internal_usage',
    'adjustment_positive',
    'adjustment_negative',
    'stock_opname_correction'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.purchase_order_status as enum ('draft', 'ordered', 'partially_received', 'received', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.cash_session_status as enum ('open', 'closing', 'closed', 'approved');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.approval_status as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null;
end $$;

create or replace function sagaops.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists sagaops.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  owner_auth_user_id uuid references auth.users(id) on delete set null,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists sagaops.outlets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  timezone text not null default 'Asia/Jakarta',
  address text,
  phone text,
  tax_rate_bps integer not null default 0 check (tax_rate_bps >= 0),
  service_rate_bps integer not null default 0 check (service_rate_bps >= 0),
  price_tax_inclusive boolean not null default true,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, code)
);

create table if not exists sagaops.user_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  email text unique,
  full_name text not null,
  phone text,
  manager_pin_hash text,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sagaops.outlet_user_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  user_profile_id uuid not null references sagaops.user_profiles(id) on delete cascade,
  role sagaops.user_role not null,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, outlet_id, user_profile_id, role)
);

create table if not exists sagaops.product_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists sagaops.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  category_id uuid references sagaops.product_categories(id) on delete set null,
  name text not null,
  sku text,
  product_type sagaops.product_type not null default 'recipe_product',
  status sagaops.product_status not null default 'draft',
  price_rupiah integer not null default 0 check (price_rupiah >= 0),
  is_pinned boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, name)
);

create table if not exists sagaops.ingredients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  name text not null,
  base_unit sagaops.base_unit not null,
  cost_per_unit_rupiah integer not null default 0 check (cost_per_unit_rupiah >= 0),
  low_threshold_qty numeric(14,3) not null default 0,
  critical_threshold_qty numeric(14,3) not null default 0,
  par_level_qty numeric(14,3) not null default 0,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, name)
);

create table if not exists sagaops.recipes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references sagaops.products(id) on delete cascade,
  name text not null default 'Default Recipe',
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, name)
);

create table if not exists sagaops.recipe_items (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references sagaops.recipes(id) on delete cascade,
  ingredient_id uuid not null references sagaops.ingredients(id),
  qty numeric(14,3) not null check (qty > 0),
  created_at timestamptz not null default now(),
  unique (recipe_id, ingredient_id)
);

create table if not exists sagaops.payment_methods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  name text not null,
  method_type sagaops.payment_method_type not null,
  status sagaops.record_status not null default 'active',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, outlet_id, name)
);

create table if not exists sagaops.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  opened_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  closed_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  business_date date not null,
  shift_name text not null,
  status sagaops.cash_session_status not null default 'open',
  opening_cash_rupiah integer not null default 0 check (opening_cash_rupiah >= 0),
  expected_cash_rupiah integer not null default 0,
  actual_cash_rupiah integer,
  cash_to_leave_rupiah integer not null default 0,
  deposit_cash_rupiah integer,
  variance_rupiah integer,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sagaops.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  cash_session_id uuid references sagaops.cash_sessions(id) on delete set null,
  order_number text not null,
  order_type sagaops.order_type not null default 'dine_in',
  status sagaops.order_status not null default 'draft',
  subtotal_rupiah integer not null default 0 check (subtotal_rupiah >= 0),
  discount_rupiah integer not null default 0 check (discount_rupiah >= 0),
  tax_rupiah integer not null default 0 check (tax_rupiah >= 0),
  service_rupiah integer not null default 0 check (service_rupiah >= 0),
  total_rupiah integer not null default 0 check (total_rupiah >= 0),
  total_hpp_rupiah integer not null default 0 check (total_hpp_rupiah >= 0),
  paid_at timestamptz,
  business_date date not null,
  cashier_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  unique (outlet_id, order_number)
);

create table if not exists sagaops.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sagaops.orders(id) on delete cascade,
  product_id uuid references sagaops.products(id) on delete set null,
  product_name_snapshot text not null,
  qty numeric(12,3) not null check (qty > 0),
  unit_price_rupiah integer not null check (unit_price_rupiah >= 0),
  line_total_rupiah integer not null check (line_total_rupiah >= 0),
  recipe_cost_snapshot_rupiah integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists sagaops.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sagaops.orders(id) on delete cascade,
  payment_method_id uuid references sagaops.payment_methods(id) on delete set null,
  method_name_snapshot text not null,
  method_type sagaops.payment_method_type not null,
  status sagaops.payment_status not null default 'paid',
  amount_rupiah integer not null check (amount_rupiah >= 0),
  received_rupiah integer not null default 0 check (received_rupiah >= 0),
  change_rupiah integer not null default 0 check (change_rupiah >= 0),
  reference_number text,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists sagaops.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  ingredient_id uuid not null references sagaops.ingredients(id) on delete cascade,
  qty_on_hand numeric(14,3) not null default 0,
  stock_value_rupiah integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (outlet_id, ingredient_id)
);

create table if not exists sagaops.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  ingredient_id uuid not null references sagaops.ingredients(id),
  movement_type sagaops.inventory_movement_type not null,
  qty_delta numeric(14,3) not null,
  unit sagaops.base_unit not null,
  unit_cost_rupiah integer not null default 0,
  value_delta_rupiah integer not null default 0,
  balance_after_qty numeric(14,3),
  reference_type text,
  reference_id uuid,
  reference_code text,
  note text,
  business_date date not null,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists sagaops.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  name text not null,
  contact_name text,
  phone text,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists sagaops.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  supplier_id uuid references sagaops.suppliers(id) on delete set null,
  po_number text not null,
  status sagaops.purchase_order_status not null default 'draft',
  total_estimated_rupiah integer not null default 0,
  ordered_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, po_number)
);

create table if not exists sagaops.purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references sagaops.purchase_orders(id) on delete cascade,
  ingredient_id uuid not null references sagaops.ingredients(id),
  ordered_qty numeric(14,3) not null check (ordered_qty >= 0),
  received_qty numeric(14,3) not null default 0 check (received_qty >= 0),
  unit sagaops.base_unit not null,
  unit_cost_rupiah integer not null default 0,
  estimated_total_rupiah integer not null default 0,
  created_at timestamptz not null default now(),
  unique (purchase_order_id, ingredient_id)
);

create table if not exists sagaops.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  cash_session_id uuid references sagaops.cash_sessions(id) on delete set null,
  category text not null,
  amount_rupiah integer not null check (amount_rupiah >= 0),
  reason text not null,
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists sagaops.daily_closings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  business_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'locked')),
  net_sales_rupiah integer not null default 0,
  total_orders integer not null default 0,
  total_hpp_rupiah integer not null default 0,
  total_purchase_received_rupiah integer not null default 0,
  total_waste_rupiah integer not null default 0,
  cash_variance_rupiah integer not null default 0,
  snapshot_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, business_date)
);

create table if not exists sagaops.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  action_type text not null,
  entity_type text,
  entity_id uuid,
  status sagaops.approval_status not null default 'pending',
  reason text,
  requested_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  approved_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists sagaops.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  actor_user_id uuid references sagaops.user_profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists sagaops_outlets_organization_id_idx on sagaops.outlets(organization_id);
create index if not exists sagaops_user_roles_user_idx on sagaops.outlet_user_roles(user_profile_id);
create index if not exists sagaops_products_org_status_idx on sagaops.products(organization_id, status);
create index if not exists sagaops_ingredients_org_idx on sagaops.ingredients(organization_id);
create index if not exists sagaops_orders_outlet_business_date_idx on sagaops.orders(outlet_id, business_date);
create index if not exists sagaops_orders_cash_session_idx on sagaops.orders(cash_session_id);
create index if not exists sagaops_inventory_movements_lookup_idx on sagaops.inventory_movements(outlet_id, ingredient_id, created_at);
create index if not exists sagaops_inventory_movements_reference_idx on sagaops.inventory_movements(reference_type, reference_id);
create index if not exists sagaops_inventory_movements_business_date_idx on sagaops.inventory_movements(outlet_id, business_date);
create index if not exists sagaops_cash_sessions_lookup_idx on sagaops.cash_sessions(outlet_id, business_date, status);
create index if not exists sagaops_purchase_orders_outlet_status_idx on sagaops.purchase_orders(outlet_id, status);
create index if not exists sagaops_audit_logs_org_time_idx on sagaops.audit_logs(organization_id, created_at);
create index if not exists sagaops_audit_logs_entity_idx on sagaops.audit_logs(entity_type, entity_id);

drop trigger if exists sagaops_organizations_touch_updated_at on sagaops.organizations;
create trigger sagaops_organizations_touch_updated_at
before update on sagaops.organizations
for each row execute function sagaops.touch_updated_at();

drop trigger if exists sagaops_outlets_touch_updated_at on sagaops.outlets;
create trigger sagaops_outlets_touch_updated_at
before update on sagaops.outlets
for each row execute function sagaops.touch_updated_at();

drop trigger if exists sagaops_products_touch_updated_at on sagaops.products;
create trigger sagaops_products_touch_updated_at
before update on sagaops.products
for each row execute function sagaops.touch_updated_at();

drop trigger if exists sagaops_ingredients_touch_updated_at on sagaops.ingredients;
create trigger sagaops_ingredients_touch_updated_at
before update on sagaops.ingredients
for each row execute function sagaops.touch_updated_at();

drop trigger if exists sagaops_purchase_orders_touch_updated_at on sagaops.purchase_orders;
create trigger sagaops_purchase_orders_touch_updated_at
before update on sagaops.purchase_orders
for each row execute function sagaops.touch_updated_at();

drop trigger if exists sagaops_daily_closings_touch_updated_at on sagaops.daily_closings;
create trigger sagaops_daily_closings_touch_updated_at
before update on sagaops.daily_closings
for each row execute function sagaops.touch_updated_at();
