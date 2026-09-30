-- HR roster v2. Draft rosters are deliberately separate from shift_schedules.
-- Only an explicit publish copies a validated snapshot into shift_schedules.
create table if not exists sagaops.native_shift_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  name text not null check (length(trim(name)) between 1 and 80),
  code text not null check (code ~ '^[A-Z0-9_-]{1,8}$'),
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0 check (break_minutes between 0 and 240),
  late_grace_minutes integer not null default 0 check (late_grace_minutes between 0 and 120),
  color text not null default 'brand' check (color in ('brand','blue','violet','success')),
  band text not null check (band in ('morning','day','evening','night')),
  role_requirements jsonb not null default '[]'::jsonb,
  state text not null default 'active' check (state in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_shift_template_duration check (
    mod((extract(epoch from (end_time-start_time))/60)::integer + 1440,1440) between 60 and 720
    and break_minutes < mod((extract(epoch from (end_time-start_time))/60)::integer + 1440,1440)
  ),
  constraint native_shift_template_roles_array check (jsonb_typeof(role_requirements)='array')
);
create unique index if not exists native_shift_template_code_unique
  on sagaops.native_shift_templates(organization_id,outlet_id,code);
create unique index if not exists native_shift_template_tenant_unique
  on sagaops.native_shift_templates(id,organization_id,outlet_id);
create index if not exists native_shift_template_active_idx
  on sagaops.native_shift_templates(organization_id,outlet_id,state);

create table if not exists sagaops.native_roster_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','review','published','archived')),
  rules jsonb not null default '{"minimumRestHours":11,"maxConsecutiveDays":6,"maxWeeklyHours":48}'::jsonb,
  version integer not null default 1 check (version > 0),
  published_by uuid references sagaops.user_profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_roster_period_order check (period_end >= period_start),
  constraint native_roster_period_max_span check (period_end <= period_start + 62)
);
create unique index if not exists native_roster_period_unique
  on sagaops.native_roster_periods(organization_id,outlet_id,period_start,period_end);
create unique index if not exists native_roster_period_tenant_unique
  on sagaops.native_roster_periods(id,organization_id,outlet_id);
create index if not exists native_roster_period_status_idx
  on sagaops.native_roster_periods(organization_id,outlet_id,status,period_start desc);

create unique index if not exists native_staff_profile_tenant_unique
  on sagaops.staff_profiles(id,organization_id,outlet_id);
create unique index if not exists native_shift_schedule_tenant_unique
  on sagaops.shift_schedules(id,organization_id,outlet_id);

create table if not exists sagaops.native_roster_assignments (
  id uuid primary key default gen_random_uuid(),
  roster_period_id uuid not null references sagaops.native_roster_periods(id) on delete cascade,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  shift_template_id uuid not null references sagaops.native_shift_templates(id),
  business_date date not null,
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  shift_name_snapshot text not null,
  grace_minutes_snapshot integer not null default 0,
  role_snapshot sagaops.staff_role not null,
  source text not null default 'manual' check (source in ('manual','generated','copied')),
  locked boolean not null default false,
  notes text,
  explanation jsonb not null default '{}'::jsonb,
  published_schedule_id uuid references sagaops.shift_schedules(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_roster_assignment_time_order check (scheduled_end_at > scheduled_start_at),
  constraint native_roster_assignment_period_tenant foreign key (roster_period_id,organization_id,outlet_id)
    references sagaops.native_roster_periods(id,organization_id,outlet_id) on delete cascade,
  constraint native_roster_assignment_staff_tenant foreign key (staff_id,organization_id,outlet_id)
    references sagaops.staff_profiles(id,organization_id,outlet_id),
  constraint native_roster_assignment_template_tenant foreign key (shift_template_id,organization_id,outlet_id)
    references sagaops.native_shift_templates(id,organization_id,outlet_id),
  constraint native_roster_assignment_schedule_tenant foreign key (published_schedule_id,organization_id,outlet_id)
    references sagaops.shift_schedules(id,organization_id,outlet_id)
);
create unique index if not exists native_roster_assignment_staff_day_unique
  on sagaops.native_roster_assignments(roster_period_id,staff_id,business_date);
create index if not exists native_roster_assignment_period_date_idx
  on sagaops.native_roster_assignments(roster_period_id,business_date,scheduled_start_at);

create table if not exists sagaops.native_staff_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null check (kind in ('unavailable','preferred')),
  preferred_template_id uuid references sagaops.native_shift_templates(id),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint native_staff_availability_order check (ends_at > starts_at),
  constraint native_staff_availability_preference check (kind='preferred' or preferred_template_id is null),
  constraint native_staff_availability_staff_tenant foreign key (staff_id,organization_id,outlet_id)
    references sagaops.staff_profiles(id,organization_id,outlet_id),
  constraint native_staff_availability_template_tenant foreign key (preferred_template_id,organization_id,outlet_id)
    references sagaops.native_shift_templates(id,organization_id,outlet_id)
);
create index if not exists native_staff_availability_range_idx
  on sagaops.native_staff_availability(organization_id,outlet_id,staff_id,starts_at,ends_at);

create table if not exists sagaops.native_roster_generation_runs (
  id uuid primary key default gen_random_uuid(),
  roster_period_id uuid not null references sagaops.native_roster_periods(id) on delete cascade,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  algorithm_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  conflicts jsonb not null default '[]'::jsonb,
  created_by uuid references sagaops.user_profiles(id),
  created_at timestamptz not null default now(),
  constraint native_roster_generation_period_tenant foreign key (roster_period_id,organization_id,outlet_id)
    references sagaops.native_roster_periods(id,organization_id,outlet_id) on delete cascade
);
create index if not exists native_roster_generation_period_idx
  on sagaops.native_roster_generation_runs(roster_period_id,created_at desc);

create table if not exists sagaops.native_roster_audit_log (
  id uuid primary key default gen_random_uuid(),
  roster_period_id uuid references sagaops.native_roster_periods(id) on delete set null,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  action text not null check (action in ('period_created','assignment_saved','bulk_assigned','pattern_copied','generated','status_changed','published','swap_approved')),
  actor_user_id uuid references sagaops.user_profiles(id),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint native_roster_audit_period_tenant foreign key (roster_period_id,organization_id,outlet_id)
    references sagaops.native_roster_periods(id,organization_id,outlet_id)
);
create index if not exists native_roster_audit_period_idx
  on sagaops.native_roster_audit_log(roster_period_id,created_at desc);

create or replace function sagaops.native_roster_guard_shift_schedules()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' then
    if coalesce(current_setting('app.native_roster_publish',true),'')<>'authorized' then
      raise exception 'native_roster_publish_required' using errcode='42501';
    end if;
    return new;
  end if;
  if coalesce(current_setting('app.native_roster_mutation',true),'')<>'authorized' then
    raise exception 'native_roster_mutation_required' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists native_roster_guard_shift_schedules on sagaops.shift_schedules;
create trigger native_roster_guard_shift_schedules
before insert or update or delete on sagaops.shift_schedules
for each row execute function sagaops.native_roster_guard_shift_schedules();

alter table sagaops.native_shift_templates enable row level security;
alter table sagaops.native_shift_templates force row level security;
alter table sagaops.native_roster_periods enable row level security;
alter table sagaops.native_roster_periods force row level security;
alter table sagaops.native_roster_assignments enable row level security;
alter table sagaops.native_roster_assignments force row level security;
alter table sagaops.native_staff_availability enable row level security;
alter table sagaops.native_staff_availability force row level security;
alter table sagaops.native_roster_generation_runs enable row level security;
alter table sagaops.native_roster_generation_runs force row level security;
alter table sagaops.native_roster_audit_log enable row level security;
alter table sagaops.native_roster_audit_log force row level security;

drop policy if exists native_shift_templates_owner on sagaops.native_shift_templates;
create policy native_shift_templates_owner on sagaops.native_shift_templates for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_roster_periods_owner on sagaops.native_roster_periods;
create policy native_roster_periods_owner on sagaops.native_roster_periods for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_roster_assignments_owner on sagaops.native_roster_assignments;
create policy native_roster_assignments_owner on sagaops.native_roster_assignments for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_staff_availability_owner on sagaops.native_staff_availability;
create policy native_staff_availability_owner on sagaops.native_staff_availability for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_roster_generation_owner on sagaops.native_roster_generation_runs;
create policy native_roster_generation_owner on sagaops.native_roster_generation_runs for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_roster_audit_owner on sagaops.native_roster_audit_log;
create policy native_roster_audit_owner on sagaops.native_roster_audit_log for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));

grant select,insert,update,delete on sagaops.native_shift_templates,sagaops.native_roster_periods,
  sagaops.native_roster_assignments,sagaops.native_staff_availability to "sagaops-production";
grant select,insert on sagaops.native_roster_generation_runs,sagaops.native_roster_audit_log to "sagaops-production";
revoke all on sagaops.native_shift_templates,sagaops.native_roster_periods,sagaops.native_roster_assignments,
  sagaops.native_staff_availability,sagaops.native_roster_generation_runs,sagaops.native_roster_audit_log from anon,authenticated;
