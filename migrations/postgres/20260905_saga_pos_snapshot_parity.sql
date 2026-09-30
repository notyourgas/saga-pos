-- Additive snapshots; existing row level security policies remain in force.
-- External identifiers are opaque references, not local UUID foreign keys.
alter table sagaops.orders
  add column if not exists member_reference text,
  add column if not exists cashier_reference text;
alter table sagaops.order_items
  add column if not exists product_reference_snapshot text,
  add column if not exists station_snapshot text not null default 'bar';
alter table sagaops.cash_sessions
  add column if not exists opened_by_reference text;
