-- Durable B20 rebuild control plane and immutable report projections.
-- These tables contain derived reporting state; inventory/source authorities remain unchanged.

create table if not exists sagaops.inventory_reporting_jobs (
  organization_id uuid not null,
  job_id text not null check (length(job_id) between 1 and 128),
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  query_fingerprint text not null check (query_fingerprint ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  outlet_ids uuid[] not null check (cardinality(outlet_ids) between 1 and 1000),
  period_start_utc timestamptz not null,
  period_end_utc timestamptz not null,
  snapshot_cutoff_utc timestamptz not null,
  max_attempts integer not null check (max_attempts between 1 and 10),
  status text not null check (status in ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD_LETTER','INVALIDATED')),
  attempt_count integer not null check (attempt_count between 0 and 10 and attempt_count <= max_attempts),
  next_attempt_at timestamptz,
  completed_at timestamptz,
  lease_worker_id text check (lease_worker_id is null or length(lease_worker_id) between 1 and 128),
  lease_claimed_at timestamptz,
  lease_expires_at timestamptz,
  lease_fence bigint,
  projection_fingerprint text check (projection_fingerprint is null or projection_fingerprint ~ '^[0-9a-f]{64}$'),
  result_ref text check (result_ref is null or length(result_ref) between 1 and 128),
  revision bigint not null check (revision > 0),
  state_document jsonb not null check (jsonb_typeof(state_document)='object'),
  state_mac text not null check (state_mac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (organization_id,job_id),
  unique (organization_id,idempotency_key),
  check (period_start_utc < period_end_utc and period_end_utc <= snapshot_cutoff_utc),
  check ((state_document->'command'->'query'->>'organizationId'=organization_id::text) is true),
  check ((state_document->>'jobId'=job_id) is true),
  check ((state_document->>'status'=status) is true),
  check (((state_document->>'revision')::bigint=revision) is true),
  check ((state_document->'command'->>'idempotencyKey'=idempotency_key) is true),
  check ((state_document->'command'->>'commandFingerprint'=command_fingerprint) is true),
  check ((state_document->'command'->>'queryFingerprint'=query_fingerprint) is true),
  check ((state_document->'command'->>'sourceFingerprint'=source_fingerprint) is true),
  check (((state_document->>'attemptCount')::integer=attempt_count) is true),
  check (
    (status='RUNNING' and lease_worker_id is not null and lease_claimed_at is not null and lease_expires_at > lease_claimed_at and lease_fence=revision)
    or
    (status<>'RUNNING' and lease_worker_id is null and lease_claimed_at is null and lease_expires_at is null and lease_fence is null)
  )
);

create index if not exists inventory_reporting_jobs_due_idx
  on sagaops.inventory_reporting_jobs(organization_id,status,next_attempt_at,lease_expires_at,job_id);
create index if not exists inventory_reporting_jobs_scope_period_idx
  on sagaops.inventory_reporting_jobs using gin(outlet_ids);
create index if not exists inventory_reporting_jobs_query_idx
  on sagaops.inventory_reporting_jobs(organization_id,query_fingerprint,updated_at desc);

create table if not exists sagaops.inventory_reporting_job_events (
  organization_id uuid not null,
  job_id text not null,
  revision bigint not null check (revision > 0),
  outlet_ids uuid[] not null check (cardinality(outlet_ids) between 1 and 1000),
  status text not null check (status in ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD_LETTER','INVALIDATED')),
  attempt_count integer not null check (attempt_count between 0 and 10),
  failure_code text check (failure_code is null or failure_code ~ '^[A-Za-z0-9_]{1,120}$'),
  occurred_at timestamptz not null,
  event_document jsonb not null check (jsonb_typeof(event_document)='object'),
  event_mac text not null check (event_mac ~ '^[0-9a-f]{64}$'),
  primary key (organization_id,job_id,revision),
  foreign key (organization_id,job_id) references sagaops.inventory_reporting_jobs(organization_id,job_id) on delete restrict
);

create table if not exists sagaops.inventory_reporting_projections (
  organization_id uuid not null,
  job_id text not null,
  outlet_ids uuid[] not null check (cardinality(outlet_ids) between 1 and 1000),
  job_revision bigint not null check (job_revision > 0),
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  query_fingerprint text not null check (query_fingerprint ~ '^[0-9a-f]{64}$'),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  projection_fingerprint text not null check (projection_fingerprint ~ '^[0-9a-f]{64}$'),
  projection_document jsonb not null check (jsonb_typeof(projection_document)='object'),
  projection_mac text not null check (projection_mac ~ '^[0-9a-f]{64}$'),
  source_references jsonb not null check (jsonb_typeof(source_references)='array'),
  persisted_at timestamptz not null,
  primary key (organization_id,job_id),
  foreign key (organization_id,job_id) references sagaops.inventory_reporting_jobs(organization_id,job_id) on delete restrict,
  check ((projection_document->>'reportFingerprint'=projection_fingerprint) is true)
);

create index if not exists inventory_reporting_projections_query_idx
  on sagaops.inventory_reporting_projections(organization_id,query_fingerprint,persisted_at desc);

create table if not exists sagaops.inventory_reporting_invalidations (
  organization_id uuid not null,
  event_id text not null check (length(event_id) between 1 and 128),
  outlet_id uuid not null,
  outlet_ids uuid[] not null check (cardinality(outlet_ids)=1 and outlet_ids[1]=outlet_id),
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  changed_at timestamptz not null,
  detected_at timestamptz not null,
  event_document jsonb not null check (jsonb_typeof(event_document)='object'),
  event_mac text not null check (event_mac ~ '^[0-9a-f]{64}$'),
  primary key (organization_id,event_id),
  foreign key (organization_id,outlet_id) references sagaops.outlets(organization_id,id) on delete restrict
);

create table if not exists sagaops.inventory_reporting_invalidation_jobs (
  organization_id uuid not null,
  event_id text not null,
  job_id text not null,
  outlet_ids uuid[] not null check (cardinality(outlet_ids) between 1 and 1000),
  invalidated_revision bigint not null check (invalidated_revision > 0),
  invalidated_at timestamptz not null,
  primary key (organization_id,event_id,job_id),
  foreign key (organization_id,event_id) references sagaops.inventory_reporting_invalidations(organization_id,event_id) on delete restrict,
  foreign key (organization_id,job_id) references sagaops.inventory_reporting_jobs(organization_id,job_id) on delete restrict
);

create or replace function sagaops.guard_inventory_reporting_job_cas()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin
  if tg_op='DELETE' then raise exception 'inventory_reporting_job_delete_denied' using errcode='55000'; end if;
  if new.organization_id<>old.organization_id
     or new.job_id<>old.job_id
     or new.idempotency_key<>old.idempotency_key
     or new.command_fingerprint<>old.command_fingerprint
     or new.query_fingerprint<>old.query_fingerprint
     or new.source_fingerprint<>old.source_fingerprint
     or new.outlet_ids<>old.outlet_ids
     or new.period_start_utc<>old.period_start_utc
     or new.period_end_utc<>old.period_end_utc
     or new.snapshot_cutoff_utc<>old.snapshot_cutoff_utc
     or new.max_attempts<>old.max_attempts
     or new.revision<>old.revision+1 then
    raise exception 'inventory_reporting_job_cas_invalid' using errcode='55000';
  end if;
  if not (
    (old.status in ('PENDING','RETRY_WAIT','RUNNING') and new.status='RUNNING')
    or (old.status='RUNNING' and new.status in ('RETRY_WAIT','SUCCEEDED','DEAD_LETTER'))
    or (old.status='SUCCEEDED' and new.status='INVALIDATED')
  ) then
    raise exception 'inventory_reporting_job_transition_invalid' using errcode='55000';
  end if;
  return new;
end;
$$;

create or replace function sagaops.prevent_inventory_reporting_append_mutation()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin raise exception 'inventory_reporting_record_append_only' using errcode='55000'; end;
$$;

create or replace function sagaops.validate_inventory_reporting_outlet_scope()
returns trigger language plpgsql set search_path=sagaops,public as $$
begin
  if cardinality(new.outlet_ids)<>(select count(distinct scoped.outlet_id) from unnest(new.outlet_ids) as scoped(outlet_id))
     or exists(
       select 1 from unnest(new.outlet_ids) as scoped(outlet_id)
       where not exists(select 1 from sagaops.outlets o where o.organization_id=new.organization_id and o.id=scoped.outlet_id)
     ) then
    raise exception 'inventory_reporting_outlet_scope_invalid' using errcode='23514';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_reporting_job_cas_guard on sagaops.inventory_reporting_jobs;
create trigger inventory_reporting_job_cas_guard before update or delete on sagaops.inventory_reporting_jobs
for each row execute function sagaops.guard_inventory_reporting_job_cas();
drop trigger if exists inventory_reporting_jobs_outlet_scope on sagaops.inventory_reporting_jobs;
create trigger inventory_reporting_jobs_outlet_scope before insert or update on sagaops.inventory_reporting_jobs
for each row execute function sagaops.validate_inventory_reporting_outlet_scope();

drop trigger if exists inventory_reporting_job_events_append_only on sagaops.inventory_reporting_job_events;
create trigger inventory_reporting_job_events_append_only before update or delete on sagaops.inventory_reporting_job_events
for each row execute function sagaops.prevent_inventory_reporting_append_mutation();
drop trigger if exists inventory_reporting_job_events_outlet_scope on sagaops.inventory_reporting_job_events;
create trigger inventory_reporting_job_events_outlet_scope before insert or update on sagaops.inventory_reporting_job_events
for each row execute function sagaops.validate_inventory_reporting_outlet_scope();
drop trigger if exists inventory_reporting_projections_append_only on sagaops.inventory_reporting_projections;
create trigger inventory_reporting_projections_append_only before update or delete on sagaops.inventory_reporting_projections
for each row execute function sagaops.prevent_inventory_reporting_append_mutation();
drop trigger if exists inventory_reporting_projections_outlet_scope on sagaops.inventory_reporting_projections;
create trigger inventory_reporting_projections_outlet_scope before insert or update on sagaops.inventory_reporting_projections
for each row execute function sagaops.validate_inventory_reporting_outlet_scope();
drop trigger if exists inventory_reporting_invalidations_append_only on sagaops.inventory_reporting_invalidations;
create trigger inventory_reporting_invalidations_append_only before update or delete on sagaops.inventory_reporting_invalidations
for each row execute function sagaops.prevent_inventory_reporting_append_mutation();
drop trigger if exists inventory_reporting_invalidations_outlet_scope on sagaops.inventory_reporting_invalidations;
create trigger inventory_reporting_invalidations_outlet_scope before insert or update on sagaops.inventory_reporting_invalidations
for each row execute function sagaops.validate_inventory_reporting_outlet_scope();
drop trigger if exists inventory_reporting_invalidation_jobs_append_only on sagaops.inventory_reporting_invalidation_jobs;
create trigger inventory_reporting_invalidation_jobs_append_only before update or delete on sagaops.inventory_reporting_invalidation_jobs
for each row execute function sagaops.prevent_inventory_reporting_append_mutation();
drop trigger if exists inventory_reporting_invalidation_jobs_outlet_scope on sagaops.inventory_reporting_invalidation_jobs;
create trigger inventory_reporting_invalidation_jobs_outlet_scope before insert or update on sagaops.inventory_reporting_invalidation_jobs
for each row execute function sagaops.validate_inventory_reporting_outlet_scope();

alter table sagaops.inventory_reporting_jobs enable row level security;
alter table sagaops.inventory_reporting_jobs force row level security;
alter table sagaops.inventory_reporting_job_events enable row level security;
alter table sagaops.inventory_reporting_job_events force row level security;
alter table sagaops.inventory_reporting_projections enable row level security;
alter table sagaops.inventory_reporting_projections force row level security;
alter table sagaops.inventory_reporting_invalidations enable row level security;
alter table sagaops.inventory_reporting_invalidations force row level security;
alter table sagaops.inventory_reporting_invalidation_jobs enable row level security;
alter table sagaops.inventory_reporting_invalidation_jobs force row level security;

create policy inventory_reporting_jobs_scope on sagaops.inventory_reporting_jobs for all
using (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])))
with check (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])));
create policy inventory_reporting_job_events_scope on sagaops.inventory_reporting_job_events for all
using (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])))
with check (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])));
create policy inventory_reporting_projections_scope on sagaops.inventory_reporting_projections for all
using (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])))
with check (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])));
create policy inventory_reporting_invalidations_scope on sagaops.inventory_reporting_invalidations for all
using (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]))
with check (current_user in ('postgres','service_role') or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[]));
create policy inventory_reporting_invalidation_jobs_scope on sagaops.inventory_reporting_invalidation_jobs for all
using (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])))
with check (current_user in ('postgres','service_role') or not exists(select 1 from unnest(outlet_ids) outlet_id where not sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])));

revoke all on sagaops.inventory_reporting_jobs,sagaops.inventory_reporting_job_events,sagaops.inventory_reporting_projections,sagaops.inventory_reporting_invalidations,sagaops.inventory_reporting_invalidation_jobs from anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on sagaops.inventory_reporting_jobs to service_role;
    grant select,insert on sagaops.inventory_reporting_job_events,sagaops.inventory_reporting_projections,sagaops.inventory_reporting_invalidations,sagaops.inventory_reporting_invalidation_jobs to service_role;
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-private') then
    grant select,insert,update on sagaops.inventory_reporting_jobs to "sagaops-private";
    grant select,insert on sagaops.inventory_reporting_job_events,sagaops.inventory_reporting_projections,sagaops.inventory_reporting_invalidations,sagaops.inventory_reporting_invalidation_jobs to "sagaops-private";
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-production') then
    grant select,insert,update on sagaops.inventory_reporting_jobs to "sagaops-production";
    grant select,insert on sagaops.inventory_reporting_job_events,sagaops.inventory_reporting_projections,sagaops.inventory_reporting_invalidations,sagaops.inventory_reporting_invalidation_jobs to "sagaops-production";
  end if;
end $$;
