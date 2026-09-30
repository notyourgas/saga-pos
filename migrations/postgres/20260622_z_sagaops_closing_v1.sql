-- SagaOPS Sprint 4 closing foundation
-- Shift closing, cash handover, expense source, and daily closing totals.

do $$
begin
  create type sagaops.expense_source as enum ('cash_drawer', 'owner_transfer', 'external_petty_cash', 'other');
exception when duplicate_object then null;
end $$;

alter table sagaops.cash_sessions
  add column if not exists expected_opening_cash_rupiah integer not null default 0,
  add column if not exists opening_variance_rupiah integer not null default 0,
  add column if not exists previous_cash_session_id uuid references sagaops.cash_sessions(id) on delete set null,
  add column if not exists handover_status text not null default 'not_required'
    check (handover_status in ('not_required', 'pending_confirmation', 'confirmed', 'variance_flagged')),
  add column if not exists variance_status text not null default 'info'
    check (variance_status in ('info', 'note_required', 'manager_review', 'approval_required')),
  add column if not exists closing_note text;

alter table sagaops.expenses
  add column if not exists source sagaops.expense_source not null default 'cash_drawer',
  add column if not exists status text not null default 'recorded'
    check (status in ('recorded', 'voided', 'corrected')),
  add column if not exists voided_at timestamptz,
  add column if not exists corrected_expense_id uuid references sagaops.expenses(id) on delete set null;

create table if not exists sagaops.cash_handover_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  previous_cash_session_id uuid not null references sagaops.cash_sessions(id) on delete cascade,
  next_cash_session_id uuid not null references sagaops.cash_sessions(id) on delete cascade,
  expected_opening_cash_rupiah integer not null default 0,
  confirmed_opening_cash_rupiah integer not null default 0,
  variance_rupiah integer not null default 0,
  variance_status text not null default 'info'
    check (variance_status in ('info', 'note_required', 'manager_review', 'approval_required')),
  note text,
  confirmed_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (previous_cash_session_id, next_cash_session_id)
);

alter table sagaops.daily_closings
  add column if not exists gross_profit_rupiah integer not null default 0,
  add column if not exists total_expense_rupiah integer not null default 0,
  add column if not exists total_cash_drawer_expense_rupiah integer not null default 0,
  add column if not exists total_opening_cash_rupiah integer not null default 0,
  add column if not exists total_expected_cash_rupiah integer not null default 0,
  add column if not exists total_actual_cash_rupiah integer not null default 0,
  add column if not exists total_deposit_cash_rupiah integer not null default 0,
  add column if not exists total_cash_left_rupiah integer not null default 0,
  add column if not exists issue_flags jsonb not null default '[]'::jsonb,
  add column if not exists submitted_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists locked_by_user_id uuid references sagaops.user_profiles(id) on delete set null,
  add column if not exists locked_at timestamptz;

create index if not exists sagaops_cash_sessions_previous_idx
  on sagaops.cash_sessions(previous_cash_session_id);
create index if not exists sagaops_expenses_session_source_idx
  on sagaops.expenses(cash_session_id, source, status);
create index if not exists sagaops_cash_handover_lookup_idx
  on sagaops.cash_handover_confirmations(outlet_id, previous_cash_session_id, next_cash_session_id);
create index if not exists sagaops_daily_closings_status_idx
  on sagaops.daily_closings(outlet_id, business_date, status);

alter table sagaops.cash_handover_confirmations enable row level security;
alter table sagaops.cash_handover_confirmations force row level security;

drop policy if exists cash_handover_confirmations_scoped on sagaops.cash_handover_confirmations;
create policy cash_handover_confirmations_scoped on sagaops.cash_handover_confirmations
for all using (
  sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
)
with check (
  sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])
);
