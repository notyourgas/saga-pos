-- This grants only synthetic kiosk-demo tables to the production runtime.
-- No grants on sales, payments, cash, settlement, or payout tables are added.
grant select,insert,update on sagaops.kiosk_static_demo_aggregates to "sagaops-production";
grant select,insert on sagaops.kiosk_static_demo_events to "sagaops-production";
grant select,insert,update on sagaops.kiosk_static_demo_assets to "sagaops-production";
grant select,insert on sagaops.kiosk_static_demo_kds_inbox to "sagaops-production";
grant select,insert,update on sagaops.kiosk_static_demo_kds_projection to "sagaops-production";
grant select,insert on sagaops.kiosk_static_demo_kds_failures to "sagaops-production";
