-- SagaPOS ESB-adaptation money ledger v1.
-- Additive expand migration only. It does not enable a payment provider,
-- backfill production data, switch authoritative reads, or authorize deploy.

create unique index if not exists sagaops_outlets_org_id_unique
  on sagaops.outlets(organization_id, id);
create unique index if not exists sagaops_cash_sessions_org_outlet_id_unique
  on sagaops.cash_sessions(organization_id, outlet_id, id);

create table if not exists sagaops.esb_money_operations (
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  operation_key text not null,
  operation_type text not null,
  aggregate_id uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, operation_key),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (length(operation_key) between 1 and 200),
  check (length(request_fingerprint) = 64)
);

create table if not exists sagaops.esb_bills (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete restrict,
  bill_number text not null,
  status text not null default 'OPEN'
    check (status in ('OPEN','PARTIALLY_PAID','PAID','VOIDED')),
  settlement_policy text not null default 'STANDARD'
    check (settlement_policy in ('STANDARD','COMPLIMENTARY','LEGACY_UNVERIFIED')),
  currency text not null default 'IDR' check (currency = 'IDR'),
  allocated_pax integer not null default 0 check (allocated_pax >= 0),
  menu_gross_rupiah bigint not null default 0,
  line_discount_rupiah bigint not null default 0 check (line_discount_rupiah >= 0),
  bill_discount_rupiah bigint not null default 0 check (bill_discount_rupiah >= 0),
  net_menu_rupiah bigint not null default 0,
  tax_rupiah bigint not null default 0,
  service_rupiah bigint not null default 0,
  customer_fee_rupiah bigint not null default 0,
  rounding_adjustment_rupiah bigint not null default 0,
  total_rupiah bigint not null default 0,
  contract_version text not null default 'SAGAPOS_ESB_TRANSACTION_REPORTING_V1',
  pricing_policy_snapshot jsonb not null default '{}'::jsonb,
  allocation_completeness text not null default 'COMPLETE'
    check (allocation_completeness in ('COMPLETE','INCOMPLETE','UNVERIFIED')),
  source_kind text not null default 'NATIVE'
    check (source_kind in ('NATIVE','LEGACY_BILL')),
  source_key text,
  opened_at timestamptz not null default now(),
  paid_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, outlet_id, bill_number),
  unique (organization_id, source_kind, source_key),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (menu_gross_rupiah between 0 and 9007199254740991),
  check (line_discount_rupiah between 0 and 9007199254740991),
  check (bill_discount_rupiah between 0 and 9007199254740991),
  check (net_menu_rupiah between 0 and 9007199254740991),
  check (tax_rupiah between 0 and 9007199254740991),
  check (service_rupiah between 0 and 9007199254740991),
  check (customer_fee_rupiah between 0 and 9007199254740991),
  check (rounding_adjustment_rupiah between -9007199254740991 and 9007199254740991),
  check (total_rupiah between 0 and 9007199254740991),
  check (total_rupiah = net_menu_rupiah + tax_rupiah + service_rupiah + customer_fee_rupiah + rounding_adjustment_rupiah),
  check (net_menu_rupiah = menu_gross_rupiah - line_discount_rupiah - bill_discount_rupiah),
  check (settlement_policy <> 'COMPLIMENTARY' or total_rupiah = 0)
);

create table if not exists sagaops.esb_bill_lines (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  bill_id uuid not null,
  order_item_id uuid references sagaops.order_items(id) on delete restrict,
  stable_line_id text not null,
  line_kind text not null default 'MAIN'
    check (line_kind in ('MAIN','MODIFIER','BUNDLE_COMPONENT')),
  item_reference text,
  item_name_snapshot text not null,
  quantity numeric(20,6) not null check (quantity > 0),
  unit_price_rupiah bigint not null,
  menu_gross_rupiah bigint not null,
  line_discount_rupiah bigint not null default 0 check (line_discount_rupiah >= 0),
  bill_discount_rupiah bigint not null default 0 check (bill_discount_rupiah >= 0),
  net_menu_rupiah bigint not null,
  tax_rupiah bigint not null default 0,
  service_rupiah bigint not null default 0,
  customer_fee_rupiah bigint not null default 0,
  rounding_adjustment_rupiah bigint not null default 0,
  total_rupiah bigint not null,
  policy_snapshot jsonb not null default '{}'::jsonb,
  allocation_completeness text not null default 'COMPLETE'
    check (allocation_completeness in ('COMPLETE','INCOMPLETE','UNVERIFIED')),
  created_at timestamptz not null default now(),
  unique (bill_id, stable_line_id),
  unique (id, organization_id, outlet_id),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (bill_id, organization_id, outlet_id)
    references sagaops.esb_bills(id, organization_id, outlet_id) on delete cascade,
  check (unit_price_rupiah between 0 and 9007199254740991),
  check (menu_gross_rupiah between 0 and 9007199254740991),
  check (line_discount_rupiah between 0 and 9007199254740991),
  check (bill_discount_rupiah between 0 and 9007199254740991),
  check (net_menu_rupiah between 0 and 9007199254740991),
  check (tax_rupiah between 0 and 9007199254740991),
  check (service_rupiah between 0 and 9007199254740991),
  check (customer_fee_rupiah between 0 and 9007199254740991),
  check (rounding_adjustment_rupiah between -9007199254740991 and 9007199254740991),
  check (total_rupiah between 0 and 9007199254740991),
  check (net_menu_rupiah = menu_gross_rupiah - line_discount_rupiah - bill_discount_rupiah),
  check (total_rupiah = net_menu_rupiah + tax_rupiah + service_rupiah + customer_fee_rupiah + rounding_adjustment_rupiah)
);

create table if not exists sagaops.esb_bill_adjustments (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  bill_id uuid not null,
  bill_line_id uuid,
  adjustment_kind text not null
    check (adjustment_kind in ('LINE_DISCOUNT','BILL_DISCOUNT','TAX','SERVICE','CUSTOMER_FEE','ROUNDING','COMPLIMENTARY')),
  amount_rupiah bigint not null,
  policy_reference text,
  allocation_basis_rupiah bigint,
  created_at timestamptz not null default now(),
  foreign key (bill_id, organization_id, outlet_id)
    references sagaops.esb_bills(id, organization_id, outlet_id) on delete cascade,
  foreign key (bill_line_id, organization_id, outlet_id)
    references sagaops.esb_bill_lines(id, organization_id, outlet_id) on delete cascade,
  check (amount_rupiah between -9007199254740991 and 9007199254740991),
  check (allocation_basis_rupiah is null or allocation_basis_rupiah between 0 and 9007199254740991)
);

create table if not exists sagaops.esb_payment_attempts (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete restrict,
  status text not null default 'CREATED'
    check (status in ('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED','REVERSED')),
  method_type text not null,
  method_name_snapshot text not null,
  verification_level text not null default 'MANUAL'
    check (verification_level in ('CASH','MANUAL','PROVIDER_VERIFIED','LEGACY_UNVERIFIED')),
  provider text,
  provider_reference text,
  tendered_rupiah bigint not null default 0 check (tendered_rupiah >= 0),
  applied_rupiah bigint not null default 0 check (applied_rupiah >= 0),
  change_rupiah bigint not null default 0 check (change_rupiah >= 0),
  currency text not null default 'IDR' check (currency = 'IDR'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  succeeded_at timestamptz,
  unique (id, organization_id, outlet_id),
  check (tendered_rupiah <= 9007199254740991),
  check (applied_rupiah <= 9007199254740991),
  check (change_rupiah <= 9007199254740991),
  check (tendered_rupiah = applied_rupiah + change_rupiah),
  check ((verification_level <> 'PROVIDER_VERIFIED') or provider is not null)
);

create table if not exists sagaops.esb_bill_payment_allocations (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  bill_id uuid not null,
  payment_attempt_id uuid not null,
  applied_rupiah bigint not null check (applied_rupiah > 0),
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (bill_id, payment_attempt_id),
  foreign key (bill_id, organization_id, outlet_id)
    references sagaops.esb_bills(id, organization_id, outlet_id) on delete restrict,
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  check (applied_rupiah <= 9007199254740991)
);

create table if not exists sagaops.esb_payment_events (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  payment_attempt_id uuid not null,
  provider text,
  external_event_id text,
  event_type text not null,
  status_before text not null,
  status_after text not null,
  event_fingerprint text not null check (length(event_fingerprint) = 64),
  event_payload_redacted jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  check ((provider is null and external_event_id is null) or (provider is not null and external_event_id is not null))
);

create unique index if not exists esb_payment_events_provider_unique
  on sagaops.esb_payment_events(organization_id, provider, external_event_id)
  where external_event_id is not null;

create table if not exists sagaops.esb_cash_movements (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  cash_session_id uuid references sagaops.cash_sessions(id) on delete restrict,
  payment_attempt_id uuid,
  movement_type text not null
    check (movement_type in ('PAYMENT_APPLIED','REFUND','OPENING','DROP','EXPENSE','ADJUSTMENT','CLOSING')),
  amount_rupiah bigint not null,
  business_date date not null,
  occurred_at timestamptz not null,
  note text,
  created_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  foreign key (organization_id, outlet_id, cash_session_id)
    references sagaops.cash_sessions(organization_id, outlet_id, id) on delete restrict,
  check (amount_rupiah <> 0),
  check (amount_rupiah between -9007199254740991 and 9007199254740991)
);

create table if not exists sagaops.esb_provider_settlements (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  provider text not null,
  provider_settlement_reference text,
  status text not null default 'UNMATCHED'
    check (status in ('UNMATCHED','EXPECTED','AVAILABLE','PAID_OUT','DISPUTED')),
  applied_rupiah bigint not null default 0 check (applied_rupiah >= 0),
  merchant_fee_rupiah bigint not null default 0 check (merchant_fee_rupiah >= 0),
  refund_rupiah bigint not null default 0 check (refund_rupiah >= 0),
  expected_payout_rupiah bigint not null default 0,
  actual_payout_rupiah bigint,
  currency text not null default 'IDR' check (currency = 'IDR'),
  period_start_utc timestamptz not null,
  period_end_utc timestamptz not null,
  available_at timestamptz,
  paid_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, outlet_id),
  unique (organization_id, provider, provider_settlement_reference),
  foreign key (organization_id, outlet_id) references sagaops.outlets(organization_id, id) on delete cascade,
  check (applied_rupiah <= 9007199254740991),
  check (merchant_fee_rupiah <= 9007199254740991),
  check (refund_rupiah <= 9007199254740991),
  check (expected_payout_rupiah between -9007199254740991 and 9007199254740991),
  check (actual_payout_rupiah is null or actual_payout_rupiah between -9007199254740991 and 9007199254740991),
  check (period_start_utc < period_end_utc),
  check (expected_payout_rupiah = applied_rupiah - merchant_fee_rupiah - refund_rupiah)
);

create table if not exists sagaops.esb_settlement_lines (
  id uuid primary key,
  organization_id uuid not null,
  outlet_id uuid not null,
  settlement_id uuid not null,
  payment_attempt_id uuid not null,
  applied_rupiah bigint not null check (applied_rupiah >= 0),
  merchant_fee_rupiah bigint not null default 0 check (merchant_fee_rupiah >= 0),
  refund_rupiah bigint not null default 0 check (refund_rupiah >= 0),
  expected_payout_rupiah bigint not null,
  created_at timestamptz not null default now(),
  unique (settlement_id, payment_attempt_id),
  unique (payment_attempt_id),
  foreign key (settlement_id, organization_id, outlet_id)
    references sagaops.esb_provider_settlements(id, organization_id, outlet_id) on delete cascade,
  foreign key (payment_attempt_id, organization_id, outlet_id)
    references sagaops.esb_payment_attempts(id, organization_id, outlet_id) on delete restrict,
  check (applied_rupiah <= 9007199254740991),
  check (merchant_fee_rupiah <= 9007199254740991),
  check (refund_rupiah <= 9007199254740991),
  check (expected_payout_rupiah between -9007199254740991 and 9007199254740991),
  check (expected_payout_rupiah = applied_rupiah - merchant_fee_rupiah - refund_rupiah)
);

create index if not exists esb_bills_report_idx
  on sagaops.esb_bills(organization_id, outlet_id, status, paid_at);
create index if not exists esb_bill_lines_bill_idx
  on sagaops.esb_bill_lines(bill_id, stable_line_id);
create index if not exists esb_payment_attempts_order_idx
  on sagaops.esb_payment_attempts(organization_id, outlet_id, order_id, status);
create index if not exists esb_payment_events_attempt_idx
  on sagaops.esb_payment_events(payment_attempt_id, received_at);
create index if not exists esb_cash_movements_report_idx
  on sagaops.esb_cash_movements(organization_id, outlet_id, business_date, occurred_at);
create index if not exists esb_settlements_report_idx
  on sagaops.esb_provider_settlements(organization_id, outlet_id, status, period_end_utc);

create or replace function sagaops.esb_money_assert_order_scope()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if not exists (
    select 1 from sagaops.orders o
     where o.id = new.order_id
       and o.organization_id = new.organization_id
       and o.outlet_id = new.outlet_id
  ) then
    raise exception 'esb_money_order_scope_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function sagaops.esb_money_assert_bill_line_scope()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if new.order_item_id is not null and not exists (
    select 1 from sagaops.esb_bills b
    join sagaops.order_items oi on oi.id = new.order_item_id and oi.order_id = b.order_id
    where b.id = new.bill_id
      and b.organization_id = new.organization_id
      and b.outlet_id = new.outlet_id
  ) then
    raise exception 'esb_bill_line_order_item_scope_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function sagaops.esb_money_assert_adjustment_scope()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if new.bill_line_id is not null and not exists (
    select 1 from sagaops.esb_bill_lines line
    where line.id = new.bill_line_id
      and line.bill_id = new.bill_id
      and line.organization_id = new.organization_id
      and line.outlet_id = new.outlet_id
  ) then
    raise exception 'esb_bill_adjustment_line_scope_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function sagaops.esb_money_assert_payment_allocation_scope()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if not exists (
    select 1 from sagaops.esb_bills bill
    join sagaops.esb_payment_attempts payment
      on payment.id = new.payment_attempt_id
     and payment.order_id = bill.order_id
     and payment.organization_id = bill.organization_id
     and payment.outlet_id = bill.outlet_id
    where bill.id = new.bill_id
      and bill.organization_id = new.organization_id
      and bill.outlet_id = new.outlet_id
  ) then
    raise exception 'esb_payment_allocation_order_scope_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_bills_order_scope on sagaops.esb_bills;
create trigger esb_bills_order_scope
before insert or update of organization_id,outlet_id,order_id on sagaops.esb_bills
for each row execute function sagaops.esb_money_assert_order_scope();

drop trigger if exists esb_payment_attempts_order_scope on sagaops.esb_payment_attempts;
create trigger esb_payment_attempts_order_scope
before insert or update of organization_id,outlet_id,order_id on sagaops.esb_payment_attempts
for each row execute function sagaops.esb_money_assert_order_scope();

drop trigger if exists esb_bill_lines_order_item_scope on sagaops.esb_bill_lines;
create trigger esb_bill_lines_order_item_scope
before insert or update of organization_id,outlet_id,bill_id,order_item_id on sagaops.esb_bill_lines
for each row execute function sagaops.esb_money_assert_bill_line_scope();

drop trigger if exists esb_bill_adjustments_line_scope on sagaops.esb_bill_adjustments;
create trigger esb_bill_adjustments_line_scope
before insert or update of organization_id,outlet_id,bill_id,bill_line_id on sagaops.esb_bill_adjustments
for each row execute function sagaops.esb_money_assert_adjustment_scope();

drop trigger if exists esb_payment_allocations_order_scope on sagaops.esb_bill_payment_allocations;
create trigger esb_payment_allocations_order_scope
before insert or update of organization_id,outlet_id,bill_id,payment_attempt_id on sagaops.esb_bill_payment_allocations
for each row execute function sagaops.esb_money_assert_payment_allocation_scope();

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_money_operations','esb_bills','esb_bill_lines','esb_bill_adjustments',
    'esb_payment_attempts','esb_bill_payment_allocations','esb_payment_events',
    'esb_cash_movements','esb_provider_settlements','esb_settlement_lines'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

create policy esb_money_operations_scope on sagaops.esb_money_operations for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));

create policy esb_bills_scope on sagaops.esb_bills for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_bill_lines_scope on sagaops.esb_bill_lines for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_bill_adjustments_scope on sagaops.esb_bill_adjustments for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_payment_attempts_scope on sagaops.esb_payment_attempts for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_bill_payment_allocations_scope on sagaops.esb_bill_payment_allocations for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_payment_events_scope on sagaops.esb_payment_events for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_cash_movements_scope on sagaops.esb_cash_movements for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy esb_provider_settlements_scope on sagaops.esb_provider_settlements for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy esb_settlement_lines_scope on sagaops.esb_settlement_lines for all
  using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

revoke all on sagaops.esb_money_operations, sagaops.esb_bills,
  sagaops.esb_bill_lines, sagaops.esb_bill_adjustments,
  sagaops.esb_payment_attempts, sagaops.esb_bill_payment_allocations,
  sagaops.esb_payment_events, sagaops.esb_cash_movements,
  sagaops.esb_provider_settlements, sagaops.esb_settlement_lines
from anon;
