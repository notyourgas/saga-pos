-- Additive read access for the canonical organization owner. Reporting remains
-- read-only; existing outlet-scoped write policies are unchanged.
-- Both canonical location tables already have FORCE ROW LEVEL SECURITY; this
-- migration adds only the narrowly scoped SELECT policies below.

drop policy if exists inventory_location_aggregate_company_owner_read on sagaops.inventory_location_aggregates;
create policy inventory_location_aggregate_company_owner_read on sagaops.inventory_location_aggregates
for select using (
  exists (
    select 1 from sagaops.organizations organization_owner
     where organization_owner.id=inventory_location_aggregates.organization_id
       and organization_owner.owner_auth_user_id=auth.uid()
       and organization_owner.status='active'
       and organization_owner.archived_at is null
  )
);

drop policy if exists inventory_location_fact_company_owner_read on sagaops.inventory_location_facts;
create policy inventory_location_fact_company_owner_read on sagaops.inventory_location_facts
for select using (
  exists (
    select 1 from sagaops.organizations organization_owner
     where organization_owner.id=inventory_location_facts.organization_id
       and organization_owner.owner_auth_user_id=auth.uid()
       and organization_owner.status='active'
       and organization_owner.archived_at is null
  )
);
