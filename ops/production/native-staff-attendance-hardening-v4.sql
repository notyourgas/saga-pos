-- Native SagaPOS attendance abuse-resistance v4.
-- Additive and rollback-compatible: the previous runtime ignores this ledger.
create table if not exists sagaops.native_attendance_audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  actor_profile_id uuid references sagaops.user_profiles(id),
  actor_reference text not null check (length(actor_reference) between 1 and 80),
  event_type text not null check (event_type ~ '^attendance\.[a-z0-9_.-]{3,80}$'),
  aggregate_id uuid,
  payload_redacted jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_redacted)='object'),
  occurred_at timestamptz not null default now()
);

create index if not exists native_attendance_audit_scope_idx
  on sagaops.native_attendance_audit_log(organization_id,outlet_id,occurred_at desc);
create index if not exists native_attendance_audit_aggregate_idx
  on sagaops.native_attendance_audit_log(aggregate_id,occurred_at desc);

create table if not exists sagaops.native_attendance_evidence_fingerprints (
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  checksum char(64) not null check (checksum ~ '^[0-9a-f]{64}$'),
  first_staff_id uuid not null references sagaops.staff_profiles(id),
  first_evidence_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id,outlet_id,checksum)
);

create table if not exists sagaops.native_attendance_challenges (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  shift_schedule_id uuid not null references sagaops.shift_schedules(id),
  action text not null check (action in ('CLOCK_IN','CLOCK_OUT','CORRECTION')),
  token_hash char(64) not null check (token_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid not null,
  policy_version integer not null check (policy_version>0),
  session_binding_hash char(64),
  capture_prompt text not null check (capture_prompt ~ '^SAGA-[A-F0-9]{6}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (staff_id,action,idempotency_key)
);

create table if not exists sagaops.native_attendance_evidence (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  staff_id uuid not null references sagaops.staff_profiles(id),
  shift_schedule_id uuid not null references sagaops.shift_schedules(id),
  challenge_id uuid not null references sagaops.native_attendance_challenges(id),
  event_type text not null check (event_type in ('CLOCK_IN','CLOCK_OUT','CORRECTION')),
  object_key text not null unique,
  status text not null check (status in ('INITIALIZED','VERIFIED','LINKED','EXPIRED')),
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  checksum char(64) not null check (checksum ~ '^[0-9a-f]{64}$'),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  captured_at timestamptz not null,
  latitude double precision,
  longitude double precision,
  accuracy_meters double precision,
  distance_meters double precision,
  geofence_status text not null check (geofence_status in ('INSIDE','OUTSIDE','POOR_ACCURACY','NOT_CONFIGURED','NOT_REQUIRED')),
  policy_version integer not null check (policy_version>0),
  session_binding_hash char(64),
  risk_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_flags)='array'),
  expires_at timestamptz not null,
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists native_attendance_challenges_expiry_idx on sagaops.native_attendance_challenges(expires_at);
create index if not exists native_attendance_evidence_staff_idx on sagaops.native_attendance_evidence(staff_id,captured_at desc);
create index if not exists native_attendance_evidence_expiry_idx on sagaops.native_attendance_evidence(expires_at) where status in ('INITIALIZED','VERIFIED');

alter table sagaops.native_attendance_audit_log enable row level security;
alter table sagaops.native_attendance_audit_log force row level security;
alter table sagaops.native_attendance_evidence_fingerprints enable row level security;
alter table sagaops.native_attendance_evidence_fingerprints force row level security;
alter table sagaops.native_attendance_challenges enable row level security;
alter table sagaops.native_attendance_challenges force row level security;
alter table sagaops.native_attendance_evidence enable row level security;
alter table sagaops.native_attendance_evidence force row level security;
drop policy if exists native_attendance_audit_owner on sagaops.native_attendance_audit_log;
create policy native_attendance_audit_owner on sagaops.native_attendance_audit_log for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_attendance_fingerprint_owner on sagaops.native_attendance_evidence_fingerprints;
create policy native_attendance_fingerprint_owner on sagaops.native_attendance_evidence_fingerprints for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_attendance_fingerprint_own_read on sagaops.native_attendance_evidence_fingerprints;
create policy native_attendance_fingerprint_own_read on sagaops.native_attendance_evidence_fingerprints for select
  using (first_staff_id::text=current_setting('app.native_staff_id',true));
drop policy if exists native_attendance_fingerprint_own_insert on sagaops.native_attendance_evidence_fingerprints;
create policy native_attendance_fingerprint_own_insert on sagaops.native_attendance_evidence_fingerprints for insert
  with check (first_staff_id::text=current_setting('app.native_staff_id',true));
drop policy if exists native_attendance_challenges_owner on sagaops.native_attendance_challenges;
create policy native_attendance_challenges_owner on sagaops.native_attendance_challenges for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_attendance_challenges_own on sagaops.native_attendance_challenges;
create policy native_attendance_challenges_own on sagaops.native_attendance_challenges for all
  using (staff_id::text=current_setting('app.native_staff_id',true))
  with check (staff_id::text=current_setting('app.native_staff_id',true));
drop policy if exists native_attendance_evidence_owner on sagaops.native_attendance_evidence;
create policy native_attendance_evidence_owner on sagaops.native_attendance_evidence for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists native_attendance_evidence_own on sagaops.native_attendance_evidence;
create policy native_attendance_evidence_own on sagaops.native_attendance_evidence for all
  using (staff_id::text=current_setting('app.native_staff_id',true))
  with check (staff_id::text=current_setting('app.native_staff_id',true));

grant select,insert on sagaops.native_attendance_audit_log to "sagaops-production";
revoke update,delete,truncate,references,trigger on sagaops.native_attendance_audit_log from "sagaops-production";
grant select,insert on sagaops.native_attendance_evidence_fingerprints to "sagaops-production";
revoke update,delete,truncate,references,trigger on sagaops.native_attendance_evidence_fingerprints from "sagaops-production";
grant select,insert,update,delete on sagaops.native_attendance_challenges,sagaops.native_attendance_evidence to "sagaops-production";
revoke all on sagaops.native_attendance_audit_log from anon,authenticated;
revoke all on sagaops.native_attendance_evidence_fingerprints from anon,authenticated;
revoke all on sagaops.native_attendance_challenges,sagaops.native_attendance_evidence from anon,authenticated;
