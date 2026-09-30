-- SagaOPS staff, shift scheduling, attendance, and payroll-ready foundation
-- Sprint 6 Backend Foundation

do $$
begin
  create type sagaops.staff_role as enum ('cashier', 'barista', 'manager', 'kitchen', 'hr', 'other');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.rate_type as enum ('per_shift', 'per_hour', 'monthly_allocation');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.attendance_status as enum (
    'present',
    'late',
    'absent',
    'sick',
    'leave',
    'incomplete',
    'manually_corrected',
    'unscheduled'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type sagaops.payroll_adjustment_type as enum ('bonus', 'deduction', 'kasbon', 'correction', 'overtime');
exception when duplicate_object then null;
end $$;

create table if not exists sagaops.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete set null,
  user_profile_id uuid references sagaops.user_profiles(id) on delete set null,
  full_name text not null,
  phone text,
  role sagaops.staff_role not null,
  pin_hash text,
  hourly_rate_rupiah integer not null default 0,
  shift_rate_rupiah integer not null default 0,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists sagaops_staff_profiles_org_idx on sagaops.staff_profiles(organization_id);
create index if not exists sagaops_staff_profiles_outlet_idx on sagaops.staff_profiles(outlet_id);

create table if not exists sagaops.shift_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  name text not null,
  start_time text not null,
  end_time text not null,
  grace_period_minutes integer not null default 0,
  rate_type sagaops.rate_type not null default 'per_shift',
  rate_amount_rupiah integer not null default 0,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint sagaops_shift_templates_org_outlet_name_unique unique (organization_id, outlet_id, name),
  constraint sagaops_shift_templates_time_format check (
    start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  )
);

create index if not exists sagaops_shift_templates_org_outlet_idx on sagaops.shift_templates(organization_id, outlet_id);

create table if not exists sagaops.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  staff_id uuid not null references sagaops.staff_profiles(id) on delete cascade,
  shift_template_id uuid references sagaops.shift_templates(id) on delete set null,
  business_date date not null,
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  shift_name text not null,
  role_label text,
  grace_period_minutes integer not null default 0,
  rate_type sagaops.rate_type not null default 'per_shift',
  rate_amount_rupiah integer not null default 0,
  notes text,
  status text not null default 'scheduled',
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sagaops_shift_schedules_time_order check (scheduled_end_at > scheduled_start_at)
);

create index if not exists sagaops_shift_schedules_staff_time_idx on sagaops.shift_schedules(staff_id, scheduled_start_at);
create index if not exists sagaops_shift_schedules_outlet_time_idx on sagaops.shift_schedules(outlet_id, scheduled_start_at);

create table if not exists sagaops.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  staff_id uuid not null references sagaops.staff_profiles(id) on delete cascade,
  shift_schedule_id uuid references sagaops.shift_schedules(id) on delete set null,
  check_in_at timestamptz,
  check_out_at timestamptz,
  status sagaops.attendance_status not null,
  is_unscheduled boolean not null default false,
  late_minutes integer not null default 0,
  early_leave_minutes integer not null default 0,
  worked_minutes integer not null default 0,
  overtime_candidate_minutes integer not null default 0,
  approved_overtime_minutes integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sagaops_attendance_logs_checkout_after_checkin check (check_out_at is null or check_in_at is null or check_out_at >= check_in_at)
);

create index if not exists sagaops_attendance_logs_staff_time_idx on sagaops.attendance_logs(staff_id, check_in_at);
create index if not exists sagaops_attendance_logs_outlet_time_idx on sagaops.attendance_logs(outlet_id, check_in_at);

create table if not exists sagaops.attendance_adjustments (
  id uuid primary key default gen_random_uuid(),
  attendance_log_id uuid not null references sagaops.attendance_logs(id) on delete cascade,
  requested_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  approved_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  reason text not null,
  affects_payroll boolean not null default false,
  payroll_impact_minutes integer not null default 0,
  payroll_impact_rupiah integer not null default 0,
  status sagaops.approval_status not null default 'pending',
  requested_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists sagaops_attendance_adjustments_log_idx on sagaops.attendance_adjustments(attendance_log_id);

create table if not exists sagaops.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  staff_id uuid not null references sagaops.staff_profiles(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  business_date date not null,
  type sagaops.payroll_adjustment_type not null,
  amount_rupiah integer not null,
  notes text not null,
  status sagaops.approval_status not null default 'pending',
  created_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  approved_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint sagaops_payroll_adjustments_period_order check (period_end >= period_start)
);

create index if not exists sagaops_payroll_adjustments_staff_period_idx on sagaops.payroll_adjustments(staff_id, period_start, period_end);

grant select, insert, update, delete on all tables in schema sagaops to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'staff_profiles',
    'shift_templates',
    'shift_schedules',
    'attendance_logs',
    'attendance_adjustments',
    'payroll_adjustments'
  ]
  loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

drop policy if exists staff_profiles_read_hr_manager on sagaops.staff_profiles;
create policy staff_profiles_read_hr_manager on sagaops.staff_profiles
for select using (
  sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  or user_profile_id = sagaops.current_user_profile_id()
);

drop policy if exists staff_profiles_write_hr_manager on sagaops.staff_profiles;
create policy staff_profiles_write_hr_manager on sagaops.staff_profiles
for all using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists shift_templates_read_scoped on sagaops.shift_templates;
create policy shift_templates_read_scoped on sagaops.shift_templates
for select using (sagaops.can_read_org(organization_id));

drop policy if exists shift_templates_write_hr_manager on sagaops.shift_templates;
create policy shift_templates_write_hr_manager on sagaops.shift_templates
for all using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists shift_schedules_read_operational on sagaops.shift_schedules;
create policy shift_schedules_read_operational on sagaops.shift_schedules
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]));

drop policy if exists shift_schedules_write_hr_manager on sagaops.shift_schedules;
create policy shift_schedules_write_hr_manager on sagaops.shift_schedules
for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists attendance_logs_read_operational on sagaops.attendance_logs;
create policy attendance_logs_read_operational on sagaops.attendance_logs
for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]));

drop policy if exists attendance_logs_insert_operational on sagaops.attendance_logs;
create policy attendance_logs_insert_operational on sagaops.attendance_logs
for insert with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]));

drop policy if exists attendance_logs_update_operational on sagaops.attendance_logs;
create policy attendance_logs_update_operational on sagaops.attendance_logs
for update using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista','hr_admin']::sagaops.user_role[]));

drop policy if exists attendance_adjustments_read_hr_manager on sagaops.attendance_adjustments;
create policy attendance_adjustments_read_hr_manager on sagaops.attendance_adjustments
for select using (
  exists (
    select 1
    from sagaops.attendance_logs al
    where al.id = attendance_adjustments.attendance_log_id
      and sagaops.has_outlet_role(al.outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  )
);

drop policy if exists attendance_adjustments_insert_hr_manager on sagaops.attendance_adjustments;
create policy attendance_adjustments_insert_hr_manager on sagaops.attendance_adjustments
for insert with check (
  exists (
    select 1
    from sagaops.attendance_logs al
    where al.id = attendance_adjustments.attendance_log_id
      and sagaops.has_outlet_role(al.outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  )
);

drop policy if exists attendance_adjustments_update_hr_manager on sagaops.attendance_adjustments;
create policy attendance_adjustments_update_hr_manager on sagaops.attendance_adjustments
for update using (
  exists (
    select 1
    from sagaops.attendance_logs al
    where al.id = attendance_adjustments.attendance_log_id
      and sagaops.has_outlet_role(al.outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  )
)
with check (
  exists (
    select 1
    from sagaops.attendance_logs al
    where al.id = attendance_adjustments.attendance_log_id
      and sagaops.has_outlet_role(al.outlet_id, array['owner','manager','hr_admin']::sagaops.user_role[])
  )
);

drop policy if exists payroll_adjustments_read_hr_manager on sagaops.payroll_adjustments;
create policy payroll_adjustments_read_hr_manager on sagaops.payroll_adjustments
for select using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));

drop policy if exists payroll_adjustments_write_hr_manager on sagaops.payroll_adjustments;
create policy payroll_adjustments_write_hr_manager on sagaops.payroll_adjustments
for all using (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]))
with check (sagaops.has_org_role(organization_id, array['owner','manager','hr_admin']::sagaops.user_role[]));
