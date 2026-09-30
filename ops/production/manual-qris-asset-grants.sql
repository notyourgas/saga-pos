-- The production runtime may read/replace this Owner-managed image only.
-- This grants no new access to payments, settlements, or orders.
grant select,insert,update on sagaops.manual_qris_assets to "sagaops-production";
grant select on public.sagaops_manual_qris_asset_schema_migrations to "sagaops-production";
