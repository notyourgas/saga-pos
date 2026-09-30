-- SagaPOS staff receiving business correctness V3.
-- Additive companion to immutable V1 and V2; retained e5e291 runtime ignores
-- these nullable/defaulted fields and tables during rollback.

alter table sagaops.inventory_receipt_drafts add column if not exists supplier_normalized text;
alter table sagaops.inventory_receipt_drafts add column if not exists document_normalized text;
alter table sagaops.inventory_receipt_drafts add column if not exists duplicate_of_receipt_id uuid references sagaops.inventory_receipt_drafts(id);
alter table sagaops.inventory_receipt_drafts add column if not exists duplicate_override_reason text;
alter table sagaops.inventory_receipt_drafts add column if not exists duplicate_override_by text;
alter table sagaops.inventory_receipt_drafts add column if not exists duplicate_override_at timestamptz;
alter table sagaops.inventory_receipt_drafts add column if not exists posting_started_at timestamptz;
alter table sagaops.inventory_receipt_drafts add column if not exists posting_last_attempt_at timestamptz;
alter table sagaops.inventory_receipt_drafts add column if not exists posting_attempt_count integer not null default 0;
alter table sagaops.inventory_receipt_drafts add column if not exists posting_claim_token_hash text;
alter table sagaops.inventory_receipt_drafts add column if not exists posting_claimed_at timestamptz;

alter table sagaops.inventory_receipt_draft_lines add column if not exists reference_cost_rupiah bigint;
alter table sagaops.inventory_receipt_draft_lines add column if not exists price_variance_bps integer;
alter table sagaops.inventory_receipt_draft_lines add column if not exists accepted_cost_rupiah bigint;
alter table sagaops.inventory_receipt_draft_lines add column if not exists rejected_cost_rupiah bigint;
alter table sagaops.inventory_receipt_draft_lines add column if not exists damaged_cost_rupiah bigint;
alter table sagaops.inventory_receipt_draft_lines add column if not exists pending_cost_rupiah bigint;
alter table sagaops.inventory_receipt_draft_lines add column if not exists allocated_fee_rupiah bigint not null default 0;
alter table sagaops.inventory_receipt_draft_lines add column if not exists cost_allocation_status text not null default 'LEGACY_UNSPECIFIED';

do $$ begin
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_posting_attempt_count_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_posting_attempt_count_valid
      check (posting_attempt_count >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_posting_claim_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_posting_claim_valid
      check ((posting_claim_token_hash is null) = (posting_claimed_at is null));
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_duplicate_override_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_duplicate_override_valid
      check ((duplicate_override_at is null and duplicate_override_by is null and duplicate_override_reason is null)
        or (duplicate_of_receipt_id is not null and duplicate_override_at is not null and duplicate_override_by is not null and duplicate_override_reason is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_line_variance_valid') then
    alter table sagaops.inventory_receipt_draft_lines add constraint inventory_receipt_line_variance_valid
      check ((reference_cost_rupiah is null and price_variance_bps is null)
        or (reference_cost_rupiah > 0 and price_variance_bps is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_line_allocation_nonnegative') then
    alter table sagaops.inventory_receipt_draft_lines add constraint inventory_receipt_line_allocation_nonnegative
      check ((accepted_cost_rupiah is null or accepted_cost_rupiah >= 0)
        and (rejected_cost_rupiah is null or rejected_cost_rupiah >= 0)
        and (damaged_cost_rupiah is null or damaged_cost_rupiah >= 0)
        and (pending_cost_rupiah is null or pending_cost_rupiah >= 0)
        and allocated_fee_rupiah >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_line_allocation_status_valid') then
    alter table sagaops.inventory_receipt_draft_lines add constraint inventory_receipt_line_allocation_status_valid
      check (cost_allocation_status in ('LEGACY_UNSPECIFIED','FULLY_ACCEPTED','REQUIRES_OWNER_ALLOCATION'));
  end if;
end $$;

create table if not exists sagaops.inventory_receipt_delivery_identities (
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  business_date date not null,
  supplier_normalized text not null,
  document_normalized text not null,
  canonical_receipt_id uuid not null references sagaops.inventory_receipt_drafts(id),
  created_at timestamptz not null default now(),
  primary key (organization_id,outlet_id,business_date,supplier_normalized,document_normalized),
  unique (canonical_receipt_id,organization_id,outlet_id),
  foreign key (canonical_receipt_id,organization_id,outlet_id)
    references sagaops.inventory_receipt_drafts(id,organization_id,outlet_id)
);

update sagaops.inventory_receipt_drafts
   set supplier_normalized=lower(regexp_replace(trim(supplier_name),'[[:space:]]+',' ','g')),
       document_normalized=upper(regexp_replace(trim(document_number),'[^A-Za-z0-9]+','','g'))
 where supplier_name is not null and document_number is not null
   and (supplier_normalized is null or document_normalized is null);

insert into sagaops.inventory_receipt_delivery_identities
  (organization_id,outlet_id,business_date,supplier_normalized,document_normalized,canonical_receipt_id,created_at)
select distinct on (r.organization_id,r.outlet_id,r.business_date,r.supplier_normalized,r.document_normalized)
       r.organization_id,r.outlet_id,r.business_date,r.supplier_normalized,r.document_normalized,r.id,r.created_at
  from sagaops.inventory_receipt_drafts r
 where r.supplier_normalized is not null and r.document_normalized is not null
 order by r.organization_id,r.outlet_id,r.business_date,r.supplier_normalized,r.document_normalized,r.created_at,r.id
on conflict (organization_id,outlet_id,business_date,supplier_normalized,document_normalized) do nothing;

update sagaops.inventory_receipt_drafts r
   set duplicate_of_receipt_id=d.canonical_receipt_id,
       exception_reasons=case when r.exception_reasons ? 'DUPLICATE_DELIVERY' then r.exception_reasons else r.exception_reasons || '["DUPLICATE_DELIVERY"]'::jsonb end
  from sagaops.inventory_receipt_delivery_identities d
 where r.organization_id=d.organization_id and r.outlet_id=d.outlet_id and r.business_date=d.business_date
   and r.supplier_normalized=d.supplier_normalized and r.document_normalized=d.document_normalized
   and r.id<>d.canonical_receipt_id and r.duplicate_of_receipt_id is null;

create table if not exists sagaops.inventory_receipt_correction_requests (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  receipt_id uuid not null references sagaops.inventory_receipt_drafts(id),
  request_key text not null,
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  reason text not null,
  requested_by text not null,
  status text not null check (status in ('BLOCKED_CANONICAL_UNSUPPORTED')),
  created_at timestamptz not null default now(),
  unique (receipt_id,request_key),
  foreign key (receipt_id,organization_id,outlet_id)
    references sagaops.inventory_receipt_drafts(id,organization_id,outlet_id)
);

create or replace function sagaops.claim_staff_receipt_delivery_identity(
  p_receipt_id uuid,
  p_actor_staff_id uuid,
  p_organization_id uuid,
  p_outlet_id uuid,
  p_business_date date,
  p_supplier_normalized text,
  p_document_normalized text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog,sagaops
as $$
declare
  claimed_receipt_id uuid;
begin
  if not exists (
    select 1 from sagaops.inventory_receipt_drafts r
     where r.id=p_receipt_id and r.actor_staff_id=p_actor_staff_id
       and r.organization_id=p_organization_id and r.outlet_id=p_outlet_id
       and r.business_date=p_business_date
  ) then
    raise exception 'staff_receipt_delivery_identity_scope_invalid';
  end if;
  insert into sagaops.inventory_receipt_delivery_identities
    (organization_id,outlet_id,business_date,supplier_normalized,document_normalized,canonical_receipt_id)
  values
    (p_organization_id,p_outlet_id,p_business_date,p_supplier_normalized,p_document_normalized,p_receipt_id)
  on conflict (organization_id,outlet_id,business_date,supplier_normalized,document_normalized) do nothing;
  select d.canonical_receipt_id into claimed_receipt_id
    from sagaops.inventory_receipt_delivery_identities d
   where d.organization_id=p_organization_id and d.outlet_id=p_outlet_id
     and d.business_date=p_business_date and d.supplier_normalized=p_supplier_normalized
     and d.document_normalized=p_document_normalized;
  return claimed_receipt_id;
end;
$$;
revoke all on function sagaops.claim_staff_receipt_delivery_identity(uuid,uuid,uuid,uuid,date,text,text) from public;
grant execute on function sagaops.claim_staff_receipt_delivery_identity(uuid,uuid,uuid,uuid,date,text,text) to "sagaops-production";

create or replace function sagaops.rebind_staff_receipt_delivery_identity(
  p_receipt_id uuid,
  p_actor_staff_id uuid,
  p_organization_id uuid,
  p_outlet_id uuid,
  p_business_date date,
  p_supplier_normalized text,
  p_document_normalized text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog,sagaops
as $$
declare
  claimed_receipt_id uuid;
begin
  if not exists (
    select 1 from sagaops.inventory_receipt_drafts r
     where r.id=p_receipt_id and r.actor_staff_id=p_actor_staff_id
       and r.organization_id=p_organization_id and r.outlet_id=p_outlet_id
       and r.business_date=p_business_date and r.status in ('DRAFT','NEEDS_CORRECTION')
  ) then
    raise exception 'staff_receipt_delivery_identity_scope_invalid';
  end if;
  if exists (select 1 from sagaops.inventory_receipt_drafts r where r.duplicate_of_receipt_id=p_receipt_id) then
    raise exception 'staff_receipt_delivery_identity_has_duplicates';
  end if;
  delete from sagaops.inventory_receipt_delivery_identities d where d.canonical_receipt_id=p_receipt_id;
  if p_supplier_normalized is null or p_document_normalized is null then
    return p_receipt_id;
  end if;
  insert into sagaops.inventory_receipt_delivery_identities
    (organization_id,outlet_id,business_date,supplier_normalized,document_normalized,canonical_receipt_id)
  values
    (p_organization_id,p_outlet_id,p_business_date,p_supplier_normalized,p_document_normalized,p_receipt_id)
  on conflict (organization_id,outlet_id,business_date,supplier_normalized,document_normalized) do nothing;
  select d.canonical_receipt_id into claimed_receipt_id
    from sagaops.inventory_receipt_delivery_identities d
   where d.organization_id=p_organization_id and d.outlet_id=p_outlet_id
     and d.business_date=p_business_date and d.supplier_normalized=p_supplier_normalized
     and d.document_normalized=p_document_normalized;
  return claimed_receipt_id;
end;
$$;
revoke all on function sagaops.rebind_staff_receipt_delivery_identity(uuid,uuid,uuid,uuid,date,text,text) from public;
grant execute on function sagaops.rebind_staff_receipt_delivery_identity(uuid,uuid,uuid,uuid,date,text,text) to "sagaops-production";

create index if not exists inventory_receipt_posting_recovery_idx
  on sagaops.inventory_receipt_drafts(organization_id,outlet_id,posting_last_attempt_at,id)
  where status='POSTING';
create index if not exists inventory_receipt_duplicate_idx
  on sagaops.inventory_receipt_drafts(organization_id,outlet_id,business_date,supplier_normalized,document_normalized);

alter table sagaops.inventory_receipt_delivery_identities enable row level security;
alter table sagaops.inventory_receipt_delivery_identities force row level security;
alter table sagaops.inventory_receipt_correction_requests enable row level security;
alter table sagaops.inventory_receipt_correction_requests force row level security;

drop policy if exists inventory_receipt_delivery_identities_owner on sagaops.inventory_receipt_delivery_identities;
create policy inventory_receipt_delivery_identities_owner on sagaops.inventory_receipt_delivery_identities for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists inventory_receipt_delivery_identities_staff on sagaops.inventory_receipt_delivery_identities;
create policy inventory_receipt_delivery_identities_staff on sagaops.inventory_receipt_delivery_identities for all
  using (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=canonical_receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)))
  with check (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=canonical_receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)));

drop policy if exists inventory_receipt_correction_requests_owner on sagaops.inventory_receipt_correction_requests;
create policy inventory_receipt_correction_requests_owner on sagaops.inventory_receipt_correction_requests for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));

grant select,insert on sagaops.inventory_receipt_delivery_identities to "sagaops-production";
grant select,insert on sagaops.inventory_receipt_correction_requests to "sagaops-production";
revoke all on sagaops.inventory_receipt_delivery_identities,sagaops.inventory_receipt_correction_requests from anon,authenticated;
