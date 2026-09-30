-- Owner-approved Saga POS pilot decisions.
-- This migration is additive and does not activate SagaDev Gateway production.

alter table sagaops.payment_intents
  alter column provider set default 'sagadev_gateway',
  add column if not exists provider_product_code text not null default 'sagaops',
  add column if not exists gateway_mode text,
  add column if not exists provider_fee_rupiah bigint check (provider_fee_rupiah is null or provider_fee_rupiah >= 0),
  add column if not exists net_settlement_rupiah bigint check (net_settlement_rupiah is null or net_settlement_rupiah >= 0),
  add column if not exists settlement_status text not null default 'unchecked'
    check (settlement_status in ('unchecked','matched','mismatch','held','reconciled'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sagaops_payment_intents_sagadev_provider'
      and conrelid = 'sagaops.payment_intents'::regclass
  ) then
    alter table sagaops.payment_intents
      add constraint sagaops_payment_intents_sagadev_provider
      check (provider = 'sagadev_gateway' and provider_product_code = 'sagaops') not valid;
  end if;
end $$;

create table if not exists sagaops.gateway_refund_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete restrict,
  payment_intent_id uuid not null references sagaops.payment_intents(id) on delete restrict,
  amount_rupiah bigint not null check (amount_rupiah > 0),
  refund_scope text not null default 'full' check (refund_scope = 'full'),
  processing_mode text not null default 'manual_finance'
    check (processing_mode = 'manual_finance'),
  status text not null default 'requested'
    check (status in ('requested','approved','finance_processing','reconciled','rejected')),
  reason text not null,
  requested_by_user_id uuid not null references sagaops.user_profiles(id),
  approved_by_user_id uuid references sagaops.user_profiles(id),
  evidence_reference_hash text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  reconciled_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (payment_intent_id)
);

alter table sagaops.gateway_refund_requests enable row level security;
revoke all on sagaops.gateway_refund_requests from anon, authenticated;

drop policy if exists sagaops_gateway_refund_read on sagaops.gateway_refund_requests;
create policy sagaops_gateway_refund_read on sagaops.gateway_refund_requests
for select using (
  sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
);

drop policy if exists sagaops_gateway_refund_write on sagaops.gateway_refund_requests;
create policy sagaops_gateway_refund_write on sagaops.gateway_refund_requests
for all using (
  sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
) with check (
  sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])
);
