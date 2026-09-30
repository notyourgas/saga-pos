-- SagaOPS security, setup wizard, sync status, and beta hardening foundation
-- Sprint 7 Backend Foundation

alter table sagaops.approvals
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists decision_note text;

alter table sagaops.audit_logs
  add column if not exists staff_id uuid references sagaops.staff_profiles(id) on delete set null,
  add column if not exists role_snapshot text,
  add column if not exists source_device_id text,
  add column if not exists old_values jsonb not null default '{}'::jsonb,
  add column if not exists new_values jsonb not null default '{}'::jsonb;

create table if not exists sagaops.setup_wizard_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  status text not null default 'in_progress',
  score_pct integer not null default 0,
  checklist_json jsonb not null default '{}'::jsonb,
  completed_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sagaops_setup_wizard_states_unique unique (organization_id, outlet_id),
  constraint sagaops_setup_wizard_states_score check (score_pct >= 0 and score_pct <= 100)
);

create table if not exists sagaops.pos_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  device_code text not null,
  name text not null,
  status sagaops.record_status not null default 'active',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sagaops_pos_devices_outlet_code_unique unique (outlet_id, device_code)
);

create table if not exists sagaops.sync_error_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  pos_device_id uuid references sagaops.pos_devices(id) on delete set null,
  source_device_id text,
  severity text not null,
  status_color text not null,
  message text not null,
  technical_detail text,
  reference_type text,
  reference_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint sagaops_sync_error_logs_severity check (severity in ('info', 'warning', 'error')),
  constraint sagaops_sync_error_logs_status_color check (status_color in ('green', 'yellow', 'red'))
);

create index if not exists sagaops_sync_error_logs_outlet_time_idx on sagaops.sync_error_logs(outlet_id, created_at);
create index if not exists sagaops_sync_error_logs_unresolved_idx on sagaops.sync_error_logs(resolved_at) where resolved_at is null;

create table if not exists sagaops.approval_pin_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  approver_user_id uuid references sagaops.user_profiles(id) on delete set null,
  source_device_id text,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sagaops_approval_pin_attempts_user_idx on sagaops.approval_pin_attempts(approver_user_id, last_attempt_at);

grant select, insert, update, delete on all tables in schema sagaops to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'setup_wizard_states',
    'pos_devices',
    'sync_error_logs',
    'approval_pin_attempts'
  ]
  loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

drop policy if exists setup_wizard_states_read_admin on sagaops.setup_wizard_states;
create policy setup_wizard_states_read_admin on sagaops.setup_wizard_states
for select using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists setup_wizard_states_write_admin on sagaops.setup_wizard_states;
create policy setup_wizard_states_write_admin on sagaops.setup_wizard_states
for all using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists pos_devices_read_operational on sagaops.pos_devices;
create policy pos_devices_read_operational on sagaops.pos_devices
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

drop policy if exists pos_devices_write_manager on sagaops.pos_devices;
create policy pos_devices_write_manager on sagaops.pos_devices
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

drop policy if exists sync_error_logs_read_manager on sagaops.sync_error_logs;
create policy sync_error_logs_read_manager on sagaops.sync_error_logs
for select using (
  outlet_id is null
  and sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or outlet_id is not null
  and sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
);

drop policy if exists sync_error_logs_insert_operational on sagaops.sync_error_logs;
create policy sync_error_logs_insert_operational on sagaops.sync_error_logs
for insert with check (
  outlet_id is null
  and sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or outlet_id is not null
  and sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);

drop policy if exists sync_error_logs_update_manager on sagaops.sync_error_logs;
create policy sync_error_logs_update_manager on sagaops.sync_error_logs
for update using (
  outlet_id is null
  and sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or outlet_id is not null
  and sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
)
with check (
  outlet_id is null
  and sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or outlet_id is not null
  and sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
);

drop policy if exists approval_pin_attempts_admin on sagaops.approval_pin_attempts;
create policy approval_pin_attempts_admin on sagaops.approval_pin_attempts
for all using (
  sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or approver_user_id = sagaops.current_user_profile_id()
)
with check (
  sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])
  or approver_user_id = sagaops.current_user_profile_id()
);
