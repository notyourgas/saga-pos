-- Gate 3 runtime closure: permit a bill void only when the immutable scoped
-- exception event already exists in the same transaction. This replaces the
-- stricter Gate 8 guard additively; no historical migration checksum changes.
-- Existing row level security policies remain authoritative; this migration
-- only narrows the trigger-backed mutation contract.

alter table sagaops.outlets
  add column if not exists business_date_cutoff_local time without time zone not null default '04:00:00';

create or replace function sagaops.guard_esb_bill_mutation()
returns trigger
language plpgsql
set search_path = sagaops, public
as $$
declare
  succeeded_applied bigint;
  exception_backed_void boolean := false;
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

  if old.status in ('OPEN','PARTIALLY_PAID') and new.status = 'VOIDED' and new.voided_at is not null then
    select exists(
      select 1
        from sagaops.esb_exception_events event
       where event.organization_id=old.organization_id
         and event.outlet_id=old.outlet_id
         and event.resource_type='bill'
         and event.resource_id=old.id::text
         and event.exception_kind in ('CANCEL_PRE_PRODUCTION','VOID_POST_PRODUCTION')
         and event.after_snapshot->>'billState'='VOIDED'
         and event.occurred_at=new.voided_at
    ) into exception_backed_void;
  end if;

  if old.status = 'PAID' and new.status <> 'PAID' then
    raise exception 'esb_paid_bill_terminal' using errcode = '23514';
  elsif old.status = 'VOIDED' and new.status <> 'VOIDED' then
    raise exception 'esb_voided_bill_terminal' using errcode = '23514';
  elsif old.status = 'PARTIALLY_PAID' and new.status not in ('PARTIALLY_PAID','PAID') and not exception_backed_void then
    raise exception 'esb_bill_status_transition_invalid' using errcode = '23514';
  elsif old.status = 'OPEN' and new.status not in ('OPEN','PARTIALLY_PAID','PAID') and not exception_backed_void then
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
  if new.status = 'VOIDED' then
    if not exception_backed_void then
      raise exception 'esb_bill_void_requires_exception_adapter' using errcode = '23514';
    end if;
  elsif new.voided_at is not null then
    raise exception 'esb_bill_void_timestamp_invalid' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists esb_bill_mutation_guard on sagaops.esb_bills;
create trigger esb_bill_mutation_guard
before update or delete on sagaops.esb_bills
for each row execute function sagaops.guard_esb_bill_mutation();
