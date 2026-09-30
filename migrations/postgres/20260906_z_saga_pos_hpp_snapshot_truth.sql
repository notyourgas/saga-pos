-- Immutable recipe-cost evidence for historical HPP reporting.
-- Existing orders remain explicitly unverified; migration never fabricates cost truth.
-- Row level security policies on orders and order_items remain authoritative.

alter table sagaops.orders
  add column if not exists hpp_snapshot_status text not null default 'unverified'
  check (hpp_snapshot_status in ('verified', 'incomplete', 'unverified', 'not_applicable'));

alter table sagaops.order_items
  add column if not exists hpp_snapshot_status text not null default 'unverified'
  check (hpp_snapshot_status in ('verified', 'incomplete', 'unverified', 'not_applicable')),
  add column if not exists recipe_version_snapshot integer
  check (recipe_version_snapshot is null or recipe_version_snapshot > 0),
  add column if not exists recipe_snapshot_json jsonb not null default '{}'::jsonb
  check (jsonb_typeof(recipe_snapshot_json) = 'object');

comment on column sagaops.order_items.recipe_snapshot_json is
  'Immutable checkout-time recipe/cost evidence. Never rewritten by later recipe or ingredient cost changes.';
