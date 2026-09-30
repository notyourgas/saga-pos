-- SagaPOS ESB money-ledger security hardening v1.
-- Additive guards only: immutable facts stay append-only and mutable aggregate
-- projections may move only through evidence-backed state transitions.
-- Existing forced row level security policies remain enabled on every table.

create or replace function sagaops.prevent_esb_money_fact_mutation()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  raise exception 'esb_money_fact_append_only' using errcode = '55000';
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'esb_money_operations','esb_bill_lines','esb_bill_adjustments',
    'esb_bill_payment_allocations','esb_payment_events','esb_cash_movements',
    'esb_settlement_lines'
  ] loop
    execute format('drop trigger if exists esb_money_fact_append_only on sagaops.%I', table_name);
    execute format(
      'create trigger esb_money_fact_append_only before update or delete on sagaops.%I for each row execute function sagaops.prevent_esb_money_fact_mutation()',
      table_name
    );
  end loop;
end $$;

create or replace function sagaops.guard_esb_bill_mutation()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
declare succeeded_applied bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'esb_bill_delete_denied' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.outlet_id is distinct from old.outlet_id
    or new.order_id is distinct from old.order_id
    or new.bill_number is distinct from old.bill_number
    or new.settlement_policy is distinct from old.settlement_policy
    or new.currency is distinct from old.currency
    or new.allocated_pax is distinct from old.allocated_pax
    or new.menu_gross_rupiah is distinct from old.menu_gross_rupiah
    or new.line_discount_rupiah is distinct from old.line_discount_rupiah
    or new.bill_discount_rupiah is distinct from old.bill_discount_rupiah
    or new.net_menu_rupiah is distinct from old.net_menu_rupiah
    or new.tax_rupiah is distinct from old.tax_rupiah
    or new.service_rupiah is distinct from old.service_rupiah
    or new.customer_fee_rupiah is distinct from old.customer_fee_rupiah
    or new.rounding_adjustment_rupiah is distinct from old.rounding_adjustment_rupiah
    or new.total_rupiah is distinct from old.total_rupiah
    or new.contract_version is distinct from old.contract_version
    or new.pricing_policy_snapshot is distinct from old.pricing_policy_snapshot
    or new.allocation_completeness is distinct from old.allocation_completeness
    or new.source_kind is distinct from old.source_kind
    or new.source_key is distinct from old.source_key
    or new.opened_at is distinct from old.opened_at
    or new.created_at is distinct from old.created_at then
    raise exception 'esb_bill_financial_snapshot_immutable' using errcode = '55000';
  end if;

  if old.status = 'PAID' and new.status <> 'PAID' then
    raise exception 'esb_paid_bill_terminal' using errcode = '23514';
  elsif old.status = 'VOIDED' and new.status <> 'VOIDED' then
    raise exception 'esb_voided_bill_terminal' using errcode = '23514';
  elsif old.status = 'PARTIALLY_PAID' and new.status not in ('PARTIALLY_PAID','PAID') then
    raise exception 'esb_bill_status_transition_invalid' using errcode = '23514';
  elsif old.status = 'OPEN' and new.status not in ('OPEN','PARTIALLY_PAID','PAID') then
    raise exception 'esb_bill_status_transition_invalid' using errcode = '23514';
  end if;

  if new.status in ('PARTIALLY_PAID','PAID') then
    select coalesce(sum(allocation.applied_rupiah), 0)::bigint
      into succeeded_applied
      from sagaops.esb_bill_payment_allocations allocation
      join sagaops.esb_payment_attempts payment
        on payment.id = allocation.payment_attempt_id
       and payment.organization_id = allocation.organization_id
       and payment.outlet_id = allocation.outlet_id
     where allocation.bill_id = new.id
       and allocation.organization_id = new.organization_id
       and allocation.outlet_id = new.outlet_id
       and payment.status = 'SUCCEEDED';
    if new.status = 'PARTIALLY_PAID' and not (succeeded_applied > 0 and succeeded_applied < new.total_rupiah) then
      raise exception 'esb_partial_bill_payment_evidence_invalid' using errcode = '23514';
    end if;
    if new.status = 'PAID'
      and not (succeeded_applied = new.total_rupiah
        or (new.total_rupiah = 0 and new.settlement_policy = 'COMPLIMENTARY')) then
      raise exception 'esb_paid_bill_payment_evidence_invalid' using errcode = '23514';
    end if;
  end if;

  if new.status = 'PAID' and new.paid_at is null then
    raise exception 'esb_paid_bill_timestamp_required' using errcode = '23514';
  elsif new.status <> 'PAID' and new.paid_at is not null then
    raise exception 'esb_unpaid_bill_timestamp_denied' using errcode = '23514';
  end if;
  if new.voided_at is not null then
    raise exception 'esb_bill_void_requires_exception_adapter' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_bill_mutation_guard on sagaops.esb_bills;
create trigger esb_bill_mutation_guard
before update or delete on sagaops.esb_bills
for each row execute function sagaops.guard_esb_bill_mutation();

create or replace function sagaops.guard_esb_payment_attempt_mutation()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'esb_payment_attempt_delete_denied' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.outlet_id is distinct from old.outlet_id
    or new.order_id is distinct from old.order_id
    or new.method_type is distinct from old.method_type
    or new.method_name_snapshot is distinct from old.method_name_snapshot
    or new.provider is distinct from old.provider
    or new.provider_reference is distinct from old.provider_reference
    or new.tendered_rupiah is distinct from old.tendered_rupiah
    or new.applied_rupiah is distinct from old.applied_rupiah
    or new.change_rupiah is distinct from old.change_rupiah
    or new.currency is distinct from old.currency
    or new.created_at is distinct from old.created_at then
    raise exception 'esb_payment_attempt_snapshot_immutable' using errcode = '55000';
  end if;

  if new.status is distinct from old.status then
    if (old.status || '->' || new.status) not in (
      'CREATED->PENDING','CREATED->SUCCEEDED','CREATED->FAILED','CREATED->EXPIRED',
      'PENDING->SUCCEEDED','PENDING->FAILED','PENDING->EXPIRED','SUCCEEDED->REVERSED'
    ) then
      raise exception 'esb_payment_status_transition_invalid' using errcode = '23514';
    end if;
    if not exists (
      select 1 from sagaops.esb_payment_events event
       where event.payment_attempt_id = old.id
         and event.organization_id = old.organization_id
         and event.outlet_id = old.outlet_id
         and event.status_before = old.status
         and event.status_after = new.status
    ) then
      raise exception 'esb_payment_status_event_required' using errcode = '23514';
    end if;
  end if;

  if new.verification_level is distinct from old.verification_level then
    if not (old.verification_level = 'MANUAL'
      and new.verification_level = 'PROVIDER_VERIFIED'
      and new.provider is not null
      and new.status = 'SUCCEEDED'
      and exists (
        select 1 from sagaops.esb_payment_events event
         where event.payment_attempt_id = old.id
           and event.organization_id = old.organization_id
           and event.outlet_id = old.outlet_id
           and event.provider = new.provider
           and event.external_event_id is not null
           and event.status_after = 'SUCCEEDED'
      )) then
      raise exception 'esb_payment_verification_transition_invalid' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists esb_payment_attempt_mutation_guard on sagaops.esb_payment_attempts;
create trigger esb_payment_attempt_mutation_guard
before update or delete on sagaops.esb_payment_attempts
for each row execute function sagaops.guard_esb_payment_attempt_mutation();

create or replace function sagaops.guard_esb_provider_settlement_mutation()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'esb_provider_settlement_delete_denied' using errcode = '55000';
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.outlet_id is distinct from old.outlet_id
    or new.provider is distinct from old.provider
    or new.provider_settlement_reference is distinct from old.provider_settlement_reference
    or new.applied_rupiah is distinct from old.applied_rupiah
    or new.merchant_fee_rupiah is distinct from old.merchant_fee_rupiah
    or new.refund_rupiah is distinct from old.refund_rupiah
    or new.expected_payout_rupiah is distinct from old.expected_payout_rupiah
    or new.currency is distinct from old.currency
    or new.period_start_utc is distinct from old.period_start_utc
    or new.period_end_utc is distinct from old.period_end_utc
    or new.created_at is distinct from old.created_at then
    raise exception 'esb_provider_settlement_snapshot_immutable' using errcode = '55000';
  end if;
  if old.status = 'PAID_OUT' and new.status <> 'PAID_OUT' then
    raise exception 'esb_provider_settlement_terminal' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_provider_settlement_mutation_guard on sagaops.esb_provider_settlements;
create trigger esb_provider_settlement_mutation_guard
before update or delete on sagaops.esb_provider_settlements
for each row execute function sagaops.guard_esb_provider_settlement_mutation();

revoke all on sagaops.esb_money_operations, sagaops.esb_bills,
  sagaops.esb_bill_lines, sagaops.esb_bill_adjustments,
  sagaops.esb_payment_attempts, sagaops.esb_bill_payment_allocations,
  sagaops.esb_payment_events, sagaops.esb_cash_movements,
  sagaops.esb_provider_settlements, sagaops.esb_settlement_lines
from anon;
