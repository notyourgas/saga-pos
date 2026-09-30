-- Immutable reporting calendar/location authority. Existing periods are not
-- backfilled from current outlet state: absence of a captured fact must remain
-- an explicit historical-authority failure.

create table if not exists sagaops.inventory_reporting_calendar_location_facts (
  organization_id uuid not null,
  outlet_id uuid not null,
  sequence integer not null check (sequence > 0),
  effective_at timestamptz not null,
  outlet_active boolean not null,
  outlet_label text not null check (length(outlet_label) between 1 and 120),
  timezone text not null check (length(timezone) between 1 and 80),
  business_date_cutoff_local time without time zone not null,
  usable_location_id uuid,
  usable_location_count integer not null check (usable_location_count between 0 and 100001),
  location_revision integer not null check (location_revision >= 0),
  location_terminal_fact_hash text,
  fact_hash text not null check (fact_hash ~ '^[0-9a-f]{64}$'),
  fact_document jsonb not null check (jsonb_typeof(fact_document) = 'object'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, outlet_id, sequence),
  unique (organization_id, outlet_id, effective_at),
  unique (organization_id, outlet_id, fact_hash),
  foreign key (organization_id, outlet_id)
    references sagaops.outlets(organization_id, id) on delete restrict,
  check ((usable_location_count = 1) = (usable_location_id is not null)),
  check ((location_revision = 0) = (location_terminal_fact_hash is null)),
  check (location_terminal_fact_hash is null or location_terminal_fact_hash ~ '^[0-9a-f]{64}$'),
  check ((fact_document->>'organizationId' = organization_id::text) is true),
  check ((fact_document->>'outletId' = outlet_id::text) is true),
  check (((fact_document->>'sequence')::integer = sequence) is true),
  check (((fact_document->>'effectiveAt')::timestamptz = effective_at) is true),
  check (((fact_document->>'outletActive')::boolean = outlet_active) is true),
  check ((fact_document->>'outletLabel' = outlet_label) is true),
  check ((fact_document->>'timeZone' = timezone) is true),
  check (((fact_document->>'businessDateCutoffLocal')::time = business_date_cutoff_local) is true),
  check ((fact_document->>'usableLocationId' is not distinct from usable_location_id::text)),
  check (((fact_document->>'usableLocationCount')::integer = usable_location_count) is true),
  check (((fact_document->>'locationRevision')::integer = location_revision) is true),
  check ((fact_document->>'locationTerminalFactHash' is not distinct from location_terminal_fact_hash)),
  check ((fact_document->>'factHash' = fact_hash) is true)
);

create index if not exists inventory_reporting_calendar_location_effective_idx
  on sagaops.inventory_reporting_calendar_location_facts(organization_id, outlet_id, effective_at desc, sequence desc);

create or replace function sagaops.capture_inventory_reporting_calendar_location_authority(
  selected_organization_id uuid,
  selected_outlet_id uuid
)
returns void language plpgsql security definer set search_path = sagaops, public as $$
declare
  selected_outlet sagaops.outlets%rowtype;
  selected_location_id uuid;
  selected_location_count integer;
  selected_location_revision integer := 0;
  selected_terminal_hash text;
  selected_sequence integer;
  selected_effective_at timestamptz := date_trunc('milliseconds',clock_timestamp());
  selected_document jsonb;
  selected_hash_payload text;
  selected_hash text;
  previous_row sagaops.inventory_reporting_calendar_location_facts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(selected_organization_id::text || ':' || selected_outlet_id::text, 7720));
  select * into selected_outlet from sagaops.outlets
   where organization_id=selected_organization_id and id=selected_outlet_id;
  if not found then return; end if;

  select coalesce(a.revision,0),terminal.fact_hash
    into selected_location_revision,selected_terminal_hash
    from (select 1 marker) seed
    left join sagaops.inventory_location_aggregates a
      on a.organization_id=selected_organization_id and a.outlet_id=selected_outlet_id
    left join lateral (
      select f.fact_hash from sagaops.inventory_location_facts f
       where f.organization_id=selected_organization_id and f.outlet_id=selected_outlet_id
       order by f.sequence desc limit 1
    ) terminal on true;

  with created as (
    select (f.fact_document->'request'->>'locationId')::uuid location_id,
           f.fact_document->'request' request_document,
           f.sequence
      from sagaops.inventory_location_facts f
     where f.organization_id=selected_organization_id and f.outlet_id=selected_outlet_id
       and f.fact_document->>'type'='LOCATION_CREATED'
  ), usable as (
    select c.location_id
      from created c
     where c.request_document->>'type'='INTERNAL'
       and c.request_document->>'custodyOrganizationId'=selected_organization_id::text
       and c.request_document->>'economicOwnerOrganizationId'=selected_organization_id::text
       and not exists (
         select 1 from sagaops.inventory_location_facts closed
          where closed.organization_id=selected_organization_id and closed.outlet_id=selected_outlet_id
            and closed.sequence>c.sequence and closed.fact_document->>'type'='LOCATION_CLOSED'
            and closed.fact_document->'request'->>'locationId'=c.location_id::text
       )
  )
  select (array_agg(location_id order by location_id))[1],count(*)::integer into selected_location_id,selected_location_count from usable;
  if selected_location_count <> 1 then selected_location_id := null; end if;

  select * into previous_row from sagaops.inventory_reporting_calendar_location_facts
   where organization_id=selected_organization_id and outlet_id=selected_outlet_id
   order by sequence desc limit 1;
  if found and previous_row.outlet_active=(selected_outlet.status='active' and selected_outlet.archived_at is null)
    and previous_row.outlet_label=selected_outlet.name and previous_row.timezone=selected_outlet.timezone
    and previous_row.business_date_cutoff_local=selected_outlet.business_date_cutoff_local
    and previous_row.usable_location_id is not distinct from selected_location_id
    and previous_row.usable_location_count=selected_location_count
    and previous_row.location_revision=selected_location_revision
    and previous_row.location_terminal_fact_hash is not distinct from selected_terminal_hash then
    return;
  end if;

  if previous_row.effective_at is not null then
    selected_effective_at := greatest(selected_effective_at,previous_row.effective_at+interval '1 millisecond');
  end if;
  selected_sequence := coalesce(previous_row.sequence,0)+1;
  selected_hash_payload := jsonb_build_array(
    selected_organization_id,selected_outlet_id,selected_sequence,selected_effective_at,
    (selected_outlet.status='active' and selected_outlet.archived_at is null),selected_outlet.name,
    selected_outlet.timezone,selected_outlet.business_date_cutoff_local::text,selected_location_id,
    selected_location_count,selected_location_revision,selected_terminal_hash
  )::text;
  selected_document := jsonb_build_object(
    'organizationId',selected_organization_id,'outletId',selected_outlet_id,'sequence',selected_sequence,
    'effectiveAt',selected_effective_at,'outletActive',(selected_outlet.status='active' and selected_outlet.archived_at is null),
    'outletLabel',selected_outlet.name,'timeZone',selected_outlet.timezone,
    'businessDateCutoffLocal',selected_outlet.business_date_cutoff_local::text,
    'usableLocationId',selected_location_id,'usableLocationCount',selected_location_count,
    'locationRevision',selected_location_revision,'locationTerminalFactHash',selected_terminal_hash,
    'hashPayload',selected_hash_payload
  );
  selected_hash := encode(sha256(convert_to(selected_hash_payload,'UTF8')),'hex');
  selected_document := selected_document || jsonb_build_object('factHash',selected_hash);
  insert into sagaops.inventory_reporting_calendar_location_facts(
    organization_id,outlet_id,sequence,effective_at,outlet_active,outlet_label,timezone,
    business_date_cutoff_local,usable_location_id,usable_location_count,location_revision,
    location_terminal_fact_hash,fact_hash,fact_document,recorded_at
  ) values (
    selected_organization_id,selected_outlet_id,selected_sequence,selected_effective_at,
    (selected_outlet.status='active' and selected_outlet.archived_at is null),selected_outlet.name,
    selected_outlet.timezone,selected_outlet.business_date_cutoff_local,selected_location_id,
    selected_location_count,selected_location_revision,selected_terminal_hash,selected_hash,
    selected_document,selected_effective_at
  );
end;
$$;

create or replace function sagaops.capture_inventory_reporting_calendar_location_from_outlet()
returns trigger language plpgsql security definer set search_path = sagaops, public as $$
begin
  perform sagaops.capture_inventory_reporting_calendar_location_authority(new.organization_id,new.id);
  return new;
end;
$$;

create or replace function sagaops.capture_inventory_reporting_calendar_location_from_aggregate()
returns trigger language plpgsql security definer set search_path = sagaops, public as $$
declare selected_type text;
begin
  select fact_document->>'type' into selected_type from sagaops.inventory_location_facts
   where organization_id=new.organization_id and outlet_id=new.outlet_id and sequence=new.revision;
  if selected_type in ('LOCATION_CREATED','LOCATION_CLOSED') then
    perform sagaops.capture_inventory_reporting_calendar_location_authority(new.organization_id,new.outlet_id);
  end if;
  return new;
end;
$$;

create or replace function sagaops.prevent_inventory_reporting_calendar_location_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'inventory_reporting_calendar_location_append_only' using errcode='55000';
end;
$$;

drop trigger if exists inventory_reporting_calendar_location_outlet_capture on sagaops.outlets;
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema='sagaops' and table_name='outlets'
         and column_name in ('name','timezone','business_date_cutoff_local','status','archived_at')) = 5 then
    execute 'create trigger inventory_reporting_calendar_location_outlet_capture
      after insert or update of name,timezone,business_date_cutoff_local,status,archived_at on sagaops.outlets
      for each row execute function sagaops.capture_inventory_reporting_calendar_location_from_outlet()';
  end if;
end $$;

drop trigger if exists inventory_reporting_calendar_location_aggregate_capture on sagaops.inventory_location_aggregates;
create trigger inventory_reporting_calendar_location_aggregate_capture
after insert or update of revision on sagaops.inventory_location_aggregates
for each row execute function sagaops.capture_inventory_reporting_calendar_location_from_aggregate();

drop trigger if exists inventory_reporting_calendar_location_append_only on sagaops.inventory_reporting_calendar_location_facts;
create trigger inventory_reporting_calendar_location_append_only
before update or delete on sagaops.inventory_reporting_calendar_location_facts
for each row execute function sagaops.prevent_inventory_reporting_calendar_location_mutation();

alter table sagaops.inventory_reporting_calendar_location_facts enable row level security;
alter table sagaops.inventory_reporting_calendar_location_facts force row level security;

drop policy if exists inventory_reporting_calendar_location_service_read on sagaops.inventory_reporting_calendar_location_facts;
create policy inventory_reporting_calendar_location_service_read on sagaops.inventory_reporting_calendar_location_facts
for select using (
  current_user in ('postgres','service_role','sagaops-private')
  or sagaops.has_outlet_role(outlet_id,array['owner','manager']::sagaops.user_role[])
);

revoke all on function sagaops.capture_inventory_reporting_calendar_location_authority(uuid,uuid) from public,anon,authenticated;
revoke all on function sagaops.capture_inventory_reporting_calendar_location_from_outlet() from public,anon,authenticated;
revoke all on function sagaops.capture_inventory_reporting_calendar_location_from_aggregate() from public,anon,authenticated;
revoke all on function sagaops.prevent_inventory_reporting_calendar_location_mutation() from public,anon,authenticated;

revoke all on sagaops.inventory_reporting_calendar_location_facts from anon,authenticated;
do $$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select on sagaops.inventory_reporting_calendar_location_facts to service_role';
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-private') then
    execute 'grant select on sagaops.inventory_reporting_calendar_location_facts to "sagaops-private"';
  end if;
  if exists(select 1 from pg_roles where rolname='sagaops-reporting') then
    execute 'grant select on sagaops.inventory_reporting_calendar_location_facts to "sagaops-reporting"';
  end if;
end $$;

-- Establish authority only from migration time forward. This deliberately does
-- not claim that current settings were true for older reporting periods.
do $$ declare selected record;
begin
  if (select count(*) from information_schema.columns
       where table_schema='sagaops' and table_name='outlets'
         and column_name in ('name','timezone','business_date_cutoff_local','status','archived_at')) = 5 then
    for selected in select organization_id,id from sagaops.outlets loop
      perform sagaops.capture_inventory_reporting_calendar_location_authority(selected.organization_id,selected.id);
    end loop;
  end if;
end $$;
