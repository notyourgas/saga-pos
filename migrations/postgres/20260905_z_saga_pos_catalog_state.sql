-- Private operational configuration. Never grant kiosk clients direct writes.
create table sagaops.pos_catalog_state (
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid primary key references sagaops.outlets(id),
  revision integer not null check (revision > 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  updated_at timestamptz not null default now()
);
alter table sagaops.pos_catalog_state enable row level security;
alter table sagaops.pos_catalog_state force row level security;
create policy pos_catalog_owner on sagaops.pos_catalog_state for all
  using (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[])
    and sagaops.can_read_org(organization_id))
  with check (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[])
    and exists(select 1 from sagaops.outlets o where o.id = outlet_id and o.organization_id = pos_catalog_state.organization_id));
revoke all on sagaops.pos_catalog_state from anon;
