GRANT USAGE ON SCHEMA sagaops,auth,public TO "sagaops-production";
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA sagaops TO "sagaops-production";
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA sagaops TO "sagaops-production";
GRANT SELECT ON auth.users,public.sagaops_private_schema_migrations TO "sagaops-production";
GRANT SELECT ON public.sagaops_native_staff_schema_migrations TO "sagaops-production";
GRANT SELECT ON public.sagaops_table_demo_schema_migrations TO "sagaops-production";
GRANT SELECT,INSERT,UPDATE,DELETE ON public.sagaops_integration_outbox TO "sagaops-production";

-- Phase 8A: reporting projections/events are append-only for the runtime.
-- The job queue requires UPDATE for leases and retry state, but never DELETE.
REVOKE DELETE ON sagaops.inventory_reporting_jobs FROM "sagaops-production";
REVOKE UPDATE,DELETE ON sagaops.inventory_reporting_job_events FROM "sagaops-production";
REVOKE UPDATE,DELETE ON sagaops.inventory_reporting_projections FROM "sagaops-production";
REVOKE UPDATE,DELETE ON sagaops.inventory_reporting_invalidations FROM "sagaops-production";
REVOKE UPDATE,DELETE ON sagaops.inventory_reporting_invalidation_jobs FROM "sagaops-production";
