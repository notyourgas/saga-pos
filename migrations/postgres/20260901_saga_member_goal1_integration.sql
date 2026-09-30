-- Goal 1 local/staging contract. Applying to a shared database requires separate approval and backup evidence.
alter table if exists public.orders add column if not exists member_id uuid;
alter table if exists public.orders add column if not exists member_code_hash text;
alter table if exists public.orders add column if not exists reward_reservation_id uuid;

create table if not exists public.sagaops_integration_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid,
  event_id uuid not null unique,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','published','dead_letter')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.sagaops_integration_outbox enable row level security;
revoke all on public.sagaops_integration_outbox from anon, authenticated;

create table if not exists public.sagaops_gateway_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  outlet_id uuid not null,
  order_id uuid not null,
  provider text not null default 'sagadev_gateway',
  provider_reference text,
  amount_rupiah bigint not null check (amount_rupiah >= 0),
  status text not null check (status in ('created','pending','paid','failed','expired','cancelled','refunded')),
  idempotency_key text not null,
  raw_callback_restricted jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

alter table public.sagaops_gateway_payments enable row level security;
revoke all on public.sagaops_gateway_payments from anon, authenticated;
