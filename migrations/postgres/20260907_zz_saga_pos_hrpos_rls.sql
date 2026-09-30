alter table sagaops.hrpos_flows enable row level security;
alter table sagaops.hrpos_flows force row level security;
alter table sagaops.hrpos_bridges enable row level security;
alter table sagaops.hrpos_bridges force row level security;

drop policy if exists hrpos_flows_runtime_scope on sagaops.hrpos_flows;
create policy hrpos_flows_runtime_scope on sagaops.hrpos_flows
for all
using (
  sagaops.can_read_org(organization_id)
  and sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','hr_admin']::sagaops.user_role[]
  )
)
with check (
  sagaops.can_read_org(organization_id)
  and sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','hr_admin']::sagaops.user_role[]
  )
);

drop policy if exists hrpos_bridges_runtime_scope on sagaops.hrpos_bridges;
create policy hrpos_bridges_runtime_scope on sagaops.hrpos_bridges
for all
using (
  sagaops.can_read_org(organization_id)
  and sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','hr_admin']::sagaops.user_role[]
  )
)
with check (
  sagaops.can_read_org(organization_id)
  and sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','hr_admin']::sagaops.user_role[]
  )
);
