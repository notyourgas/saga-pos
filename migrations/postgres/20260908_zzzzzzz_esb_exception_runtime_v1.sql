-- SagaPOS ESB Gate 3 exception runtime v1.
-- Additive only. Provider refund is an internal reconciliation work item; this
-- migration does not call a provider, return funds, or enable payment rails.

create table if not exists sagaops.esb_exception_reason_versions (
  id text not null,
  version integer not null check (version > 0),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid,
  code text not null,
  label text not null,
  permitted_kinds text[] not null,
  active boolean not null,
  requires_note boolean not null default false,
  effective_from timestamptz not null,
  effective_until timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, id, version),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (effective_until is null or effective_until > effective_from)
);

create table if not exists sagaops.esb_exception_periods (
  organization_id uuid not null,
  outlet_id uuid not null,
  business_date date not null,
  state text not null check (state in ('OPEN','CLOSED','LOCKED')),
  close_id text,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, outlet_id, business_date),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (state = 'OPEN' or close_id is not null)
);

create table if not exists sagaops.esb_exception_approvals (
  id text not null,
  organization_id uuid not null,
  outlet_id uuid not null,
  action_type text not null,
  entity_type text not null,
  entity_id text not null,
  requested_by_user_id text not null,
  approved_by_user_id text not null,
  approved_by_role text not null,
  status text not null check (status = 'APPROVED'),
  approved_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (requested_by_user_id <> approved_by_user_id)
);

create table if not exists sagaops.esb_action_authorizations (
  id text not null,
  organization_id uuid not null,
  outlet_id uuid not null,
  approval_id text not null,
  action_type text not null,
  resource_type text not null,
  resource_id text not null,
  executor_user_id text not null,
  executor_role text not null,
  binding_hash text not null check (length(binding_hash) = 64),
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE','CONSUMED')),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_operation_key text,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, approval_id),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (approval_id, organization_id, outlet_id)
    references sagaops.esb_exception_approvals(id, organization_id, outlet_id) on delete restrict,
  check (expires_at > issued_at),
  check ((status = 'AVAILABLE' and consumed_at is null and consumed_operation_key is null)
      or (status = 'CONSUMED' and consumed_at is not null and consumed_operation_key is not null))
);

create table if not exists sagaops.esb_exception_resource_versions (
  organization_id uuid not null,
  outlet_id uuid not null,
  resource_type text not null,
  resource_id text not null,
  current_version integer not null default 0 check (current_version >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, resource_type, resource_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_exception_operations (
  organization_id uuid not null,
  outlet_id uuid not null,
  operation_key text not null,
  exception_kind text not null,
  resource_type text not null,
  resource_id text not null,
  request_fingerprint text not null check (length(request_fingerprint) = 64),
  result_event_id uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, operation_key),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_exception_events (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  exception_kind text not null,
  resource_type text not null,
  resource_id text not null,
  resource_version integer not null check (resource_version > 0),
  operation_key text not null,
  actor_user_id text not null,
  actor_role_snapshot text not null,
  reason_id text not null,
  reason_version integer not null,
  authorization_id text,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  effect_snapshot jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, resource_type, resource_id, resource_version),
  unique (organization_id, operation_key),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, reason_id, reason_version)
    references sagaops.esb_exception_reason_versions(organization_id, id, version) on delete restrict,
  foreign key (authorization_id, organization_id, outlet_id)
    references sagaops.esb_action_authorizations(id, organization_id, outlet_id) on delete restrict
);

alter table sagaops.esb_exception_operations
  add constraint esb_exception_operation_result_fk
  foreign key (result_event_id, organization_id, outlet_id)
    references sagaops.esb_exception_events(id, organization_id, outlet_id) on delete restrict;

create table if not exists sagaops.esb_refund_requests (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  exception_event_id uuid not null unique,
  payment_attempt_id uuid not null,
  bill_id uuid not null,
  refund_kind text not null check (refund_kind in ('CASH_REFUND','PROVIDER_REFUND')),
  status text not null check (status in ('REQUESTED','RECONCILIATION_PENDING')),
  requested_rupiah bigint not null check (requested_rupiah > 0 and requested_rupiah <= 9007199254740991),
  funds_returned boolean not null default false check (funds_returned = false),
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  foreign key (bill_id, organization_id, outlet_id)
    references sagaops.esb_bills(id, organization_id, outlet_id) on delete restrict,
  foreign key (exception_event_id, organization_id, outlet_id)
    references sagaops.esb_exception_events(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_refund_lines (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  refund_request_id uuid not null,
  bill_line_id uuid not null,
  payment_allocation_id uuid not null,
  net_rupiah bigint not null default 0,
  tax_rupiah bigint not null default 0,
  service_rupiah bigint not null default 0,
  customer_fee_rupiah bigint not null default 0,
  rounding_rupiah bigint not null default 0,
  total_rupiah bigint not null check (total_rupiah > 0),
  original_allocation_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (refund_request_id, bill_line_id, payment_allocation_id),
  foreign key (refund_request_id, organization_id, outlet_id)
    references sagaops.esb_refund_requests(id, organization_id, outlet_id) on delete restrict,
  foreign key (bill_line_id, organization_id, outlet_id)
    references sagaops.esb_bill_lines(id, organization_id, outlet_id) on delete restrict,
  foreign key (payment_allocation_id, organization_id, outlet_id)
    references sagaops.esb_bill_payment_allocations(id, organization_id, outlet_id) on delete restrict,
  check (net_rupiah >= 0 and tax_rupiah >= 0 and service_rupiah >= 0 and customer_fee_rupiah >= 0),
  check (rounding_rupiah between -9007199254740991 and 9007199254740991),
  check (total_rupiah = net_rupiah + tax_rupiah + service_rupiah + customer_fee_rupiah + rounding_rupiah)
);

create table if not exists sagaops.esb_provider_refund_work_items (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  refund_request_id uuid not null unique,
  status text not null default 'RECONCILIATION_PENDING' check (status = 'RECONCILIATION_PENDING'),
  provider_call_enabled boolean not null default false check (provider_call_enabled = false),
  created_at timestamptz not null default now(),
  foreign key (refund_request_id, organization_id, outlet_id)
    references sagaops.esb_refund_requests(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_exception_stock_dispositions (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  exception_event_id uuid not null unique,
  disposition text not null check (disposition in ('RETURN_TO_STOCK','WASTE','NO_STOCK_CHANGE')),
  reservation_disposition text,
  automatic_stock_return boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (exception_event_id, organization_id, outlet_id)
    references sagaops.esb_exception_events(id, organization_id, outlet_id) on delete restrict,
  check (automatic_stock_return = (disposition = 'RETURN_TO_STOCK'))
);

create table if not exists sagaops.esb_payment_reclassifications (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  exception_event_id uuid not null unique,
  payment_attempt_id uuid not null,
  from_method_id text not null,
  to_method_id text not null,
  amount_rupiah bigint not null check (amount_rupiah > 0 and amount_rupiah <= 9007199254740991),
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  foreign key (exception_event_id, organization_id, outlet_id)
    references sagaops.esb_exception_events(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (from_method_id <> to_method_id)
);

create table if not exists sagaops.esb_payment_reclassification_entries (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  reclassification_id uuid not null,
  entry_kind text not null check (entry_kind in ('REVERSAL','APPLY')),
  method_id text not null,
  signed_amount_rupiah bigint not null check (signed_amount_rupiah <> 0),
  created_at timestamptz not null default now(),
  unique (reclassification_id, entry_kind),
  foreign key (reclassification_id, organization_id, outlet_id)
    references sagaops.esb_payment_reclassifications(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create table if not exists sagaops.esb_exception_audit_events (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  exception_event_id uuid not null,
  actor_user_id text not null,
  actor_role_snapshot text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  old_values jsonb not null,
  new_values jsonb not null,
  metadata jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (exception_event_id, organization_id, outlet_id)
    references sagaops.esb_exception_events(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade
);

create or replace function sagaops.prevent_esb_exception_fact_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  raise exception 'esb_exception_fact_append_only' using errcode = '55000';
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_exception_reason_versions','esb_exception_approvals',
    'esb_exception_events','esb_refund_requests','esb_refund_lines',
    'esb_provider_refund_work_items','esb_exception_stock_dispositions',
    'esb_payment_reclassifications','esb_payment_reclassification_entries',
    'esb_exception_audit_events'
  ] loop
    execute format('drop trigger if exists esb_exception_fact_append_only on sagaops.%I', table_name);
    execute format('create trigger esb_exception_fact_append_only before update or delete on sagaops.%I for each row execute function sagaops.prevent_esb_exception_fact_mutation()', table_name);
  end loop;
end $$;

create or replace function sagaops.guard_esb_exception_operation_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'esb_exception_operation_delete_denied' using errcode = '55000';
  end if;
  if new.organization_id is distinct from old.organization_id or new.outlet_id is distinct from old.outlet_id
    or new.operation_key is distinct from old.operation_key or new.exception_kind is distinct from old.exception_kind
    or new.resource_type is distinct from old.resource_type or new.resource_id is distinct from old.resource_id
    or new.request_fingerprint is distinct from old.request_fingerprint or new.created_at is distinct from old.created_at
    or old.result_event_id is not null or new.result_event_id is null then
    raise exception 'esb_exception_operation_result_cas_invalid' using errcode = '55000';
  end if;
  if not exists (
    select 1 from sagaops.esb_exception_events event
     where event.id=new.result_event_id and event.organization_id=new.organization_id
       and event.outlet_id=new.outlet_id and event.operation_key=new.operation_key
       and event.exception_kind=new.exception_kind and event.resource_type=new.resource_type
       and event.resource_id=new.resource_id
  ) then
    raise exception 'esb_exception_operation_result_scope_invalid' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_exception_operation_guard on sagaops.esb_exception_operations;
create trigger esb_exception_operation_guard before update or delete on sagaops.esb_exception_operations
for each row execute function sagaops.guard_esb_exception_operation_mutation();

create or replace function sagaops.assert_esb_refund_line_original_scope()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if not exists (
    select 1
      from sagaops.esb_refund_requests refund
      join sagaops.esb_bill_lines line
        on line.id=new.bill_line_id and line.bill_id=refund.bill_id
       and line.organization_id=refund.organization_id and line.outlet_id=refund.outlet_id
      join sagaops.esb_bill_payment_allocations allocation
        on allocation.id=new.payment_allocation_id and allocation.bill_id=refund.bill_id
       and allocation.payment_attempt_id=refund.payment_attempt_id
       and allocation.organization_id=refund.organization_id and allocation.outlet_id=refund.outlet_id
     where refund.id=new.refund_request_id
       and refund.organization_id=new.organization_id and refund.outlet_id=new.outlet_id
  ) then
    raise exception 'esb_refund_original_allocation_scope_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_refund_line_original_scope on sagaops.esb_refund_lines;
create trigger esb_refund_line_original_scope before insert on sagaops.esb_refund_lines
for each row execute function sagaops.assert_esb_refund_line_original_scope();

create or replace function sagaops.guard_esb_action_authorization_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'esb_action_authorization_delete_denied' using errcode = '55000';
  end if;
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
    or new.outlet_id is distinct from old.outlet_id or new.approval_id is distinct from old.approval_id
    or new.action_type is distinct from old.action_type or new.resource_type is distinct from old.resource_type
    or new.resource_id is distinct from old.resource_id or new.executor_user_id is distinct from old.executor_user_id
    or new.executor_role is distinct from old.executor_role or new.binding_hash is distinct from old.binding_hash
    or new.issued_at is distinct from old.issued_at or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at then
    raise exception 'esb_action_authorization_binding_immutable' using errcode = '55000';
  end if;
  if not (old.status = 'AVAILABLE' and new.status = 'CONSUMED'
    and old.consumed_at is null and new.consumed_at is not null
    and old.consumed_operation_key is null and new.consumed_operation_key is not null) then
    raise exception 'esb_action_authorization_cas_invalid' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_action_authorization_guard on sagaops.esb_action_authorizations;
create trigger esb_action_authorization_guard before update or delete on sagaops.esb_action_authorizations
for each row execute function sagaops.guard_esb_action_authorization_mutation();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_exception_reason_versions','esb_exception_periods','esb_exception_approvals',
    'esb_action_authorizations','esb_exception_resource_versions','esb_exception_operations',
    'esb_exception_events','esb_refund_requests','esb_refund_lines',
    'esb_provider_refund_work_items','esb_exception_stock_dispositions',
    'esb_payment_reclassifications','esb_payment_reclassification_entries','esb_exception_audit_events'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
    execute format('create policy %I on sagaops.%I for all using (case when outlet_id is null then sagaops.has_org_role(organization_id, array[''owner'',''manager'']::sagaops.user_role[]) else sagaops.has_outlet_role(outlet_id, array[''owner'',''manager'']::sagaops.user_role[]) end) with check (case when outlet_id is null then sagaops.has_org_role(organization_id, array[''owner'',''manager'']::sagaops.user_role[]) else sagaops.has_outlet_role(outlet_id, array[''owner'',''manager'']::sagaops.user_role[]) end)', table_name || '_scope', table_name);
  end loop;
end $$;

revoke all on sagaops.esb_exception_reason_versions, sagaops.esb_exception_periods,
  sagaops.esb_exception_approvals, sagaops.esb_action_authorizations,
  sagaops.esb_exception_resource_versions, sagaops.esb_exception_operations,
  sagaops.esb_exception_events, sagaops.esb_refund_requests, sagaops.esb_refund_lines,
  sagaops.esb_provider_refund_work_items, sagaops.esb_exception_stock_dispositions,
  sagaops.esb_payment_reclassifications, sagaops.esb_payment_reclassification_entries,
  sagaops.esb_exception_audit_events from anon, authenticated;
