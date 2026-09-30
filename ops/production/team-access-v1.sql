-- Additive optional core module. No staff, payment or runtime-ledger changes.
create table if not exists sagaops.team_access_state (
  organization_id uuid primary key references sagaops.organizations(id),
  state jsonb not null check (jsonb_typeof(state)='object' and (state->>'revision')::bigint >= 1)
);
create table if not exists sagaops.team_access_audit (
  organization_id uuid not null references sagaops.organizations(id),
  revision bigint not null,
  event jsonb not null,
  created_at timestamptz not null default now(),
  primary key(organization_id,revision)
);
alter table sagaops.team_access_state enable row level security;
alter table sagaops.team_access_state force row level security;
alter table sagaops.team_access_audit enable row level security;
alter table sagaops.team_access_audit force row level security;
create policy team_access_state_owner on sagaops.team_access_state for all to "sagaops-production"
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
create policy team_access_audit_read on sagaops.team_access_audit for select to "sagaops-production"
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
create policy team_access_audit_append on sagaops.team_access_audit for insert to "sagaops-production"
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
grant select,insert,update on sagaops.team_access_state to "sagaops-production";
grant select,insert on sagaops.team_access_audit to "sagaops-production";
revoke all on sagaops.team_access_state,sagaops.team_access_audit from anon,authenticated;
-- Ledger stays separate from the main migration manifest.
create table if not exists public.sagaops_team_access_schema_migrations (
  name text primary key, checksum text not null check(checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz not null default now()
);
alter table public.sagaops_team_access_schema_migrations enable row level security;
alter table public.sagaops_team_access_schema_migrations force row level security;
create policy team_access_schema_read on public.sagaops_team_access_schema_migrations for select to "sagaops-production" using(true);
grant select on public.sagaops_team_access_schema_migrations to "sagaops-production";
revoke all on public.sagaops_team_access_schema_migrations from anon,authenticated;
