-- SagaOPS RLS and permission foundation
-- Sprint 2 Backend Foundation - Part 2
-- Target runtime: Supabase Postgres with auth.uid().

create or replace function sagaops.current_user_profile_id()
returns uuid
language sql
stable
security definer
set search_path = sagaops, public
as $$
  select id
  from sagaops.user_profiles
  where auth_user_id = auth.uid()
    and status = 'active'
  limit 1
$$;

create or replace function sagaops.has_org_role(target_organization_id uuid, allowed_roles sagaops.user_role[])
returns boolean
language sql
stable
security definer
set search_path = sagaops, public
as $$
  select exists (
    select 1
    from sagaops.outlet_user_roles our
    where our.organization_id = target_organization_id
      and our.user_profile_id = sagaops.current_user_profile_id()
      and our.role = any(allowed_roles)
      and our.status = 'active'
  )
$$;

create or replace function sagaops.has_outlet_role(target_outlet_id uuid, allowed_roles sagaops.user_role[])
returns boolean
language sql
stable
security definer
set search_path = sagaops, public
as $$
  select exists (
    select 1
    from sagaops.outlets o
    join sagaops.outlet_user_roles our
      on our.organization_id = o.organization_id
     and (our.outlet_id = o.id or our.outlet_id is null)
    where o.id = target_outlet_id
      and our.user_profile_id = sagaops.current_user_profile_id()
      and our.role = any(allowed_roles)
      and our.status = 'active'
      and o.status = 'active'
  )
$$;

create or replace function sagaops.can_read_org(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = sagaops, public
as $$
  select exists (
    select 1
    from sagaops.organizations org
    where org.id = target_organization_id
      and (
        org.owner_auth_user_id = auth.uid()
        or sagaops.has_org_role(
          target_organization_id,
          array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]
        )
      )
  )
$$;

grant usage on schema sagaops to authenticated;
grant select, insert, update, delete on all tables in schema sagaops to authenticated;
grant usage, select on all sequences in schema sagaops to authenticated;

alter default privileges in schema sagaops
grant select, insert, update, delete on tables to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'outlets',
    'user_profiles',
    'outlet_user_roles',
    'product_categories',
    'products',
    'ingredients',
    'recipes',
    'recipe_items',
    'payment_methods',
    'cash_sessions',
    'orders',
    'order_items',
    'payments',
    'inventory_balances',
    'inventory_movements',
    'suppliers',
    'purchase_orders',
    'purchase_order_items',
    'expenses',
    'daily_closings',
    'approvals',
    'audit_logs'
  ]
  loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

drop policy if exists organizations_read on sagaops.organizations;
create policy organizations_read on sagaops.organizations
for select using (sagaops.can_read_org(id));

drop policy if exists organizations_insert_owner on sagaops.organizations;
create policy organizations_insert_owner on sagaops.organizations
for insert with check (owner_auth_user_id = auth.uid());

drop policy if exists organizations_update_owner_manager on sagaops.organizations;
create policy organizations_update_owner_manager on sagaops.organizations
for update using (sagaops.has_org_role(id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists outlets_read on sagaops.outlets;
create policy outlets_read on sagaops.outlets
for select using (sagaops.can_read_org(organization_id));

drop policy if exists outlets_write_owner_manager on sagaops.outlets;
create policy outlets_write_owner_manager on sagaops.outlets
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists user_profiles_read_scoped on sagaops.user_profiles;
create policy user_profiles_read_scoped on sagaops.user_profiles
for select using (
  id = sagaops.current_user_profile_id()
  or exists (
    select 1 from sagaops.outlet_user_roles our
    where our.user_profile_id = user_profiles.id
      and sagaops.has_org_role(our.organization_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  )
);

drop policy if exists user_profiles_update_self_or_admin on sagaops.user_profiles;
create policy user_profiles_update_self_or_admin on sagaops.user_profiles
for update using (
  id = sagaops.current_user_profile_id()
  or exists (
    select 1 from sagaops.outlet_user_roles our
    where our.user_profile_id = user_profiles.id
      and sagaops.has_org_role(our.organization_id, array['owner','hr_admin']::sagaops.user_role[])
  )
)
with check (
  id = sagaops.current_user_profile_id()
  or exists (
    select 1 from sagaops.outlet_user_roles our
    where our.user_profile_id = user_profiles.id
      and sagaops.has_org_role(our.organization_id, array['owner','hr_admin']::sagaops.user_role[])
  )
);

drop policy if exists outlet_user_roles_admin on sagaops.outlet_user_roles;
create policy outlet_user_roles_admin on sagaops.outlet_user_roles
for all using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','hr_admin']::sagaops.user_role[]));

drop policy if exists catalog_read on sagaops.product_categories;
create policy catalog_read on sagaops.product_categories
for select using (sagaops.can_read_org(organization_id));

drop policy if exists catalog_write on sagaops.product_categories;
create policy catalog_write on sagaops.product_categories
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists products_read on sagaops.products;
create policy products_read on sagaops.products
for select using (sagaops.can_read_org(organization_id));

drop policy if exists products_write on sagaops.products;
create policy products_write on sagaops.products
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists ingredients_read on sagaops.ingredients;
create policy ingredients_read on sagaops.ingredients
for select using (sagaops.can_read_org(organization_id));

drop policy if exists ingredients_write on sagaops.ingredients;
create policy ingredients_write on sagaops.ingredients
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists recipes_read on sagaops.recipes;
create policy recipes_read on sagaops.recipes
for select using (
  exists (
    select 1 from sagaops.products p
    where p.id = recipes.product_id
      and sagaops.can_read_org(p.organization_id)
  )
);

drop policy if exists recipes_write on sagaops.recipes;
create policy recipes_write on sagaops.recipes
for all using (
  exists (
    select 1 from sagaops.products p
    where p.id = recipes.product_id
      and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1 from sagaops.products p
    where p.id = recipes.product_id
      and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[])
  )
);

drop policy if exists recipe_items_read on sagaops.recipe_items;
create policy recipe_items_read on sagaops.recipe_items
for select using (
  exists (
    select 1
    from sagaops.recipes r
    join sagaops.products p on p.id = r.product_id
    where r.id = recipe_items.recipe_id
      and sagaops.can_read_org(p.organization_id)
  )
);

drop policy if exists recipe_items_write on sagaops.recipe_items;
create policy recipe_items_write on sagaops.recipe_items
for all using (
  exists (
    select 1
    from sagaops.recipes r
    join sagaops.products p on p.id = r.product_id
    where r.id = recipe_items.recipe_id
      and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1
    from sagaops.recipes r
    join sagaops.products p on p.id = r.product_id
    where r.id = recipe_items.recipe_id
      and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[])
  )
);

drop policy if exists payment_methods_read on sagaops.payment_methods;
create policy payment_methods_read on sagaops.payment_methods
for select using (sagaops.can_read_org(organization_id));

drop policy if exists payment_methods_write on sagaops.payment_methods;
create policy payment_methods_write on sagaops.payment_methods
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists cash_sessions_read on sagaops.cash_sessions;
create policy cash_sessions_read on sagaops.cash_sessions
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists cash_sessions_write_operational on sagaops.cash_sessions;
create policy cash_sessions_write_operational on sagaops.cash_sessions
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists orders_read on sagaops.orders;
create policy orders_read on sagaops.orders
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists orders_write_pos on sagaops.orders;
create policy orders_write_pos on sagaops.orders
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists order_items_scoped on sagaops.order_items;
create policy order_items_scoped on sagaops.order_items
for all using (
  exists (
    select 1 from sagaops.orders o
    where o.id = order_items.order_id
      and sagaops.has_outlet_role(o.outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1 from sagaops.orders o
    where o.id = order_items.order_id
      and sagaops.has_outlet_role(o.outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
  )
);

drop policy if exists payments_scoped on sagaops.payments;
create policy payments_scoped on sagaops.payments
for all using (
  exists (
    select 1 from sagaops.orders o
    where o.id = payments.order_id
      and sagaops.has_outlet_role(o.outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1 from sagaops.orders o
    where o.id = payments.order_id
      and sagaops.has_outlet_role(o.outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
  )
);

drop policy if exists inventory_balances_read on sagaops.inventory_balances;
create policy inventory_balances_read on sagaops.inventory_balances
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists inventory_movements_read on sagaops.inventory_movements;
create policy inventory_movements_read on sagaops.inventory_movements
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists inventory_movements_insert_operational on sagaops.inventory_movements;
create policy inventory_movements_insert_operational on sagaops.inventory_movements
for insert with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists suppliers_read on sagaops.suppliers;
create policy suppliers_read on sagaops.suppliers
for select using (sagaops.can_read_org(organization_id));

drop policy if exists suppliers_write on sagaops.suppliers;
create policy suppliers_write on sagaops.suppliers
for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists purchase_orders_read on sagaops.purchase_orders;
create policy purchase_orders_read on sagaops.purchase_orders
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists purchase_orders_write_manager on sagaops.purchase_orders;
create policy purchase_orders_write_manager on sagaops.purchase_orders
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists purchase_order_items_scoped on sagaops.purchase_order_items;
create policy purchase_order_items_scoped on sagaops.purchase_order_items
for all using (
  exists (
    select 1 from sagaops.purchase_orders po
    where po.id = purchase_order_items.purchase_order_id
      and sagaops.has_outlet_role(po.outlet_id, array['owner','manager']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1 from sagaops.purchase_orders po
    where po.id = purchase_order_items.purchase_order_id
      and sagaops.has_outlet_role(po.outlet_id, array['owner','manager']::sagaops.user_role[])
  )
);

drop policy if exists expenses_read on sagaops.expenses;
create policy expenses_read on sagaops.expenses
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists expenses_insert_operational on sagaops.expenses;
create policy expenses_insert_operational on sagaops.expenses
for insert with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists daily_closings_read on sagaops.daily_closings;
create policy daily_closings_read on sagaops.daily_closings
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists daily_closings_write_manager on sagaops.daily_closings;
create policy daily_closings_write_manager on sagaops.daily_closings
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists approvals_read on sagaops.approvals;
create policy approvals_read on sagaops.approvals
for select using (sagaops.can_read_org(organization_id));

drop policy if exists approvals_insert_request on sagaops.approvals;
create policy approvals_insert_request on sagaops.approvals
for insert with check (sagaops.can_read_org(organization_id));

drop policy if exists approvals_update_manager on sagaops.approvals;
create policy approvals_update_manager on sagaops.approvals
for update using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists audit_logs_read_owner_manager on sagaops.audit_logs;
create policy audit_logs_read_owner_manager on sagaops.audit_logs
for select using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists audit_logs_insert_scoped on sagaops.audit_logs;
create policy audit_logs_insert_scoped on sagaops.audit_logs
for insert with check (sagaops.can_read_org(organization_id));
