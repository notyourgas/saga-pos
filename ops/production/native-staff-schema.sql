-- Native SagaPOS employee access, own schedules and attendance. No SagaWork dependency.
-- Separate additive schema: never change the main 34-entry SagaPOS runtime ledger.
create table if not exists public.sagaops_native_staff_schema_migrations (
  name text primary key,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
alter table public.sagaops_native_staff_schema_migrations enable row level security;
alter table public.sagaops_native_staff_schema_migrations force row level security;
drop policy if exists native_staff_schema_runtime_read on public.sagaops_native_staff_schema_migrations;
create policy native_staff_schema_runtime_read on public.sagaops_native_staff_schema_migrations
  for select to "sagaops-production" using (true);
grant select on public.sagaops_native_staff_schema_migrations to "sagaops-production";
revoke all on public.sagaops_native_staff_schema_migrations from anon,authenticated;
grant usage on schema sagaops to "sagaops-production";
do $$ begin create type sagaops.staff_role as enum ('cashier','barista','manager','kitchen','hr','other');
exception when duplicate_object then null; end $$;
do $$ begin create type sagaops.attendance_status as enum ('present','late','absent','sick','leave','incomplete','manually_corrected','unscheduled');
exception when duplicate_object then null; end $$;

create table if not exists sagaops.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid references sagaops.outlets(id),
  full_name text not null,
  role sagaops.staff_role not null,
  status sagaops.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists native_staff_profiles_org_outlet_idx on sagaops.staff_profiles(organization_id,outlet_id);

create table if not exists sagaops.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  business_date date not null,
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  shift_name text not null,
  grace_period_minutes integer not null default 0,
  notes text,
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_shift_time_order check (scheduled_end_at > scheduled_start_at)
);
create index if not exists native_shift_staff_time_idx on sagaops.shift_schedules(staff_id,scheduled_start_at);

create table if not exists sagaops.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  shift_schedule_id uuid references sagaops.shift_schedules(id),
  check_in_at timestamptz,
  check_out_at timestamptz,
  status sagaops.attendance_status not null,
  is_unscheduled boolean not null default false,
  late_minutes integer not null default 0,
  worked_minutes integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_attendance_time_order check (check_out_at is null or check_in_at is null or check_out_at >= check_in_at)
);
create index if not exists native_attendance_staff_time_idx on sagaops.attendance_logs(staff_id,check_in_at);
create unique index if not exists native_attendance_one_per_shift on sagaops.attendance_logs(staff_id,shift_schedule_id) where shift_schedule_id is not null;

alter table sagaops.staff_profiles enable row level security;
alter table sagaops.staff_profiles force row level security;
alter table sagaops.shift_schedules enable row level security;
alter table sagaops.shift_schedules force row level security;
alter table sagaops.attendance_logs enable row level security;
alter table sagaops.attendance_logs force row level security;
drop policy if exists native_staff_owner on sagaops.staff_profiles;
create policy native_staff_owner on sagaops.staff_profiles for all
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_shift_owner on sagaops.shift_schedules;
create policy native_shift_owner on sagaops.shift_schedules for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_attendance_owner on sagaops.attendance_logs;
create policy native_attendance_owner on sagaops.attendance_logs for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
grant select,insert,update,delete on sagaops.staff_profiles,sagaops.shift_schedules,sagaops.attendance_logs to "sagaops-production";
revoke all on sagaops.staff_profiles,sagaops.shift_schedules,sagaops.attendance_logs from anon,authenticated;

alter table sagaops.staff_profiles add column if not exists employee_code text;
create unique index if not exists sagaops_staff_employee_code_unique
  on sagaops.staff_profiles (organization_id, lower(employee_code)) where employee_code is not null;
create sequence if not exists sagaops.native_staff_code_sequence;

create table if not exists sagaops.native_staff_credentials (
  staff_id uuid primary key references sagaops.staff_profiles(id) on delete cascade,
  organization_id uuid not null references sagaops.organizations(id),
  password_hash text not null,
  state text not null check (state in ('temporary','active','suspended')),
  temporary_expires_at timestamptz,
  password_changed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_staff_temporary_expiry check (state <> 'temporary' or temporary_expires_at is not null)
);
create index if not exists native_staff_credentials_org_idx on sagaops.native_staff_credentials(organization_id);

create table if not exists sagaops.native_staff_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  schedule_id uuid references sagaops.shift_schedules(id),
  target_staff_id uuid references sagaops.staff_profiles(id),
  target_schedule_id uuid references sagaops.shift_schedules(id),
  category text not null check (category in ('schedule_change','shift_swap','leave','permission','sick','overtime')),
  reason text not null check (length(trim(reason)) between 10 and 500),
  starts_at timestamptz,
  ends_at timestamptz,
  state text not null default 'submitted' check (state in ('submitted','peer_accepted','approved','rejected','withdrawn')),
  reviewer_note text,
  reviewed_by uuid references sagaops.user_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_staff_swap_target check (category <> 'shift_swap' or (target_staff_id is not null and target_schedule_id is not null)),
  constraint native_staff_request_range check ((starts_at is null and ends_at is null) or (starts_at is not null and ends_at > starts_at))
);
create index if not exists native_staff_requests_staff_idx on sagaops.native_staff_requests(staff_id,created_at desc);
create index if not exists native_staff_requests_target_idx on sagaops.native_staff_requests(target_staff_id,state);

alter table sagaops.pos_http_sessions drop constraint if exists pos_http_sessions_kind_check;
alter table sagaops.pos_http_sessions add constraint pos_http_sessions_kind_check check (kind in ('kiosk','operator','staff'));

alter table sagaops.native_staff_credentials enable row level security;
alter table sagaops.native_staff_credentials force row level security;
alter table sagaops.native_staff_requests enable row level security;
alter table sagaops.native_staff_requests force row level security;

drop policy if exists native_staff_credentials_owner on sagaops.native_staff_credentials;
create policy native_staff_credentials_owner on sagaops.native_staff_credentials for all
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_staff_requests_owner on sagaops.native_staff_requests;
create policy native_staff_requests_owner on sagaops.native_staff_requests for all
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_staff_requests_own_read on sagaops.native_staff_requests;
create policy native_staff_requests_own_read on sagaops.native_staff_requests for select
  using (staff_id::text = current_setting('app.native_staff_id',true)
    or target_staff_id::text = current_setting('app.native_staff_id',true));
drop policy if exists native_staff_requests_own_insert on sagaops.native_staff_requests;
create policy native_staff_requests_own_insert on sagaops.native_staff_requests for insert
  with check (staff_id::text = current_setting('app.native_staff_id',true));

drop policy if exists staff_profiles_native_own_read on sagaops.staff_profiles;
create policy staff_profiles_native_own_read on sagaops.staff_profiles for select
  using (id::text = current_setting('app.native_staff_id',true));
drop policy if exists shift_schedules_native_own_read on sagaops.shift_schedules;
create policy shift_schedules_native_own_read on sagaops.shift_schedules for select
  using (staff_id::text = current_setting('app.native_staff_id',true) and status <> 'cancelled');
drop policy if exists attendance_logs_native_own_read on sagaops.attendance_logs;
create policy attendance_logs_native_own_read on sagaops.attendance_logs for select
  using (staff_id::text = current_setting('app.native_staff_id',true));
drop policy if exists attendance_logs_native_own_insert on sagaops.attendance_logs;
create policy attendance_logs_native_own_insert on sagaops.attendance_logs for insert
  with check (staff_id::text = current_setting('app.native_staff_id',true));
drop policy if exists attendance_logs_native_own_update on sagaops.attendance_logs;
create policy attendance_logs_native_own_update on sagaops.attendance_logs for update
  using (staff_id::text = current_setting('app.native_staff_id',true))
  with check (staff_id::text = current_setting('app.native_staff_id',true));
create unique index if not exists attendance_logs_one_open_native_staff on sagaops.attendance_logs(staff_id)
  where check_in_at is not null and check_out_at is null;

grant usage,select on sequence sagaops.native_staff_code_sequence to "sagaops-production";
grant select,insert,update,delete on sagaops.native_staff_credentials,sagaops.native_staff_requests to "sagaops-production";
revoke all on sagaops.native_staff_credentials,sagaops.native_staff_requests from anon,authenticated;
