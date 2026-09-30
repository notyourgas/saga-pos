-- Saga POS local program contract. Applying outside an isolated environment
-- requires separate backup, restore, vault, and release approval evidence.

create table if not exists sagaops.product_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  product_id uuid not null references sagaops.products(id) on delete cascade,
  code text not null,
  name text not null,
  price_delta_rupiah bigint not null default 0,
  status text not null default 'active' check (status in ('draft','active','inactive','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, code)
);

create table if not exists sagaops.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  name text not null,
  minimum_selections integer not null default 0 check (minimum_selections >= 0),
  maximum_selections integer not null default 1 check (maximum_selections >= minimum_selections),
  status text not null default 'active' check (status in ('draft','active','inactive','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sagaops.modifier_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  modifier_group_id uuid not null references sagaops.modifier_groups(id) on delete cascade,
  code text not null,
  name text not null,
  price_delta_rupiah bigint not null default 0,
  station_route text,
  status text not null default 'active' check (status in ('draft','active','inactive','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (modifier_group_id, code)
);

create table if not exists sagaops.product_modifier_groups (
  product_id uuid not null references sagaops.products(id) on delete cascade,
  modifier_group_id uuid not null references sagaops.modifier_groups(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (product_id, modifier_group_id)
);

create table if not exists sagaops.product_channel_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  product_id uuid not null references sagaops.products(id) on delete cascade,
  channel text not null check (channel in ('kiosk','cashier','admin')),
  available boolean not null default true,
  pause_reason text,
  starts_at timestamptz,
  ends_at timestamptz,
  version bigint not null default 1,
  updated_by_user_id uuid references sagaops.user_profiles(id),
  updated_at timestamptz not null default now(),
  unique (outlet_id, product_id, channel)
);

create table if not exists sagaops.pos_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  device_code text not null,
  name text not null,
  status sagaops.record_status not null default 'active',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, device_code)
);

alter table sagaops.pos_devices
  add column if not exists mode text,
  add column if not exists operational_status text not null default 'pending',
  add column if not exists app_version text,
  add column if not exists credential_hash text,
  add column if not exists credential_rotated_at timestamptz,
  add column if not exists custodian text,
  add column if not exists capability_manifest jsonb not null default '{}'::jsonb;

create table if not exists sagaops.device_heartbeats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  device_id uuid not null references sagaops.pos_devices(id) on delete cascade,
  connectivity text not null,
  printer_status text,
  nfc_status text,
  kds_status text,
  capability_manifest jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);

create table if not exists sagaops.promotion_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  code text not null,
  name text not null,
  rule_type text not null check (rule_type in ('percent','fixed','fixed_price','bundle','buy_x_get_y','free_item')),
  rule_payload jsonb not null,
  priority integer not null default 100,
  stack_policy text not null default 'exclusive' check (stack_policy in ('exclusive','compatible')),
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','active','paused','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table if not exists sagaops.payment_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete cascade,
  provider text not null,
  provider_reference text,
  amount_rupiah bigint not null check (amount_rupiah >= 0),
  status text not null check (status in ('created','pending','paid','failed','expired','cancelled','refunded','unknown')),
  idempotency_key text not null,
  expires_at timestamptz,
  paid_at timestamptz,
  last_provider_sequence bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create table if not exists sagaops.fulfillment_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete cascade,
  station text not null,
  status text not null default 'new' check (status in ('new','in_progress','ready','completed','cancelled')),
  payload_snapshot jsonb not null,
  priority integer not null default 100,
  prep_started_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, station)
);

create table if not exists sagaops.print_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid not null references sagaops.orders(id) on delete cascade,
  destination text not null,
  payload_version integer not null default 1,
  payload_snapshot jsonb not null,
  status text not null check (status in ('queued','printing','printed','failed','unknown','not_run_hardware_unavailable')),
  copy_number integer not null default 0,
  label text not null default 'ORIGINAL',
  attempts integer not null default 0,
  requested_by_user_id uuid references sagaops.user_profiles(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, destination, copy_number)
);

create table if not exists sagaops.reward_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid not null references sagaops.outlets(id) on delete cascade,
  order_id uuid references sagaops.orders(id) on delete set null,
  external_reservation_id text,
  member_code_hash text not null,
  reward_id text not null,
  status text not null check (status in ('reserved','committed','released','reversed','unknown')),
  idempotency_key text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create table if not exists sagaops.operational_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references sagaops.organizations(id) on delete cascade,
  outlet_id uuid references sagaops.outlets(id) on delete cascade,
  severity text not null check (severity in ('sev1','sev2','sev3','sev4')),
  source text not null,
  summary text not null,
  status text not null default 'open' check (status in ('open','mitigated','resolved','closed')),
  correlation_id text,
  restricted_detail jsonb,
  opened_by_user_id uuid references sagaops.user_profiles(id),
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists sagaops_availability_outlet_channel_idx on sagaops.product_channel_availability(outlet_id, channel, available);
create index if not exists sagaops_device_heartbeat_lookup_idx on sagaops.device_heartbeats(device_id, observed_at desc);
create index if not exists sagaops_payment_intent_order_idx on sagaops.payment_intents(order_id, status);
create index if not exists sagaops_fulfillment_queue_idx on sagaops.fulfillment_tickets(outlet_id, station, status, created_at);
create index if not exists sagaops_print_job_queue_idx on sagaops.print_jobs(outlet_id, destination, status, created_at);
create index if not exists sagaops_incident_open_idx on sagaops.operational_incidents(organization_id, status, severity);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'product_variants','modifier_groups','modifier_options','product_modifier_groups',
    'product_channel_availability','pos_devices','device_heartbeats','promotion_rules',
    'payment_intents','fulfillment_tickets','print_jobs','reward_reservations','operational_incidents'
  ] loop
    execute format('alter table sagaops.%I enable row level security', table_name);
    execute format('alter table sagaops.%I force row level security', table_name);
  end loop;
end $$;

create policy pos_program_org_read_variants on sagaops.product_variants for select using (sagaops.can_read_org(organization_id));
create policy pos_program_org_write_variants on sagaops.product_variants for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy pos_program_org_read_modifier_groups on sagaops.modifier_groups for select using (sagaops.can_read_org(organization_id));
create policy pos_program_org_write_modifier_groups on sagaops.modifier_groups for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));
create policy pos_program_org_read_modifier_options on sagaops.modifier_options for select using (sagaops.can_read_org(organization_id));
create policy pos_program_org_write_modifier_options on sagaops.modifier_options for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

create policy pos_program_product_modifier_read on sagaops.product_modifier_groups for select using (exists (select 1 from sagaops.products p where p.id=product_id and sagaops.can_read_org(p.organization_id)));
create policy pos_program_product_modifier_write on sagaops.product_modifier_groups for all using (exists (select 1 from sagaops.products p where p.id=product_id and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[]))) with check (exists (select 1 from sagaops.products p where p.id=product_id and sagaops.has_org_role(p.organization_id, array['owner','manager']::sagaops.user_role[])));

create policy pos_program_availability_read on sagaops.product_channel_availability for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_availability_write on sagaops.product_channel_availability for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

create policy pos_program_device_read on sagaops.pos_devices for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy pos_program_device_write on sagaops.pos_devices for all using (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner']::sagaops.user_role[]));
create policy pos_program_heartbeat_read on sagaops.device_heartbeats for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));

create policy pos_program_promotion_read on sagaops.promotion_rules for select using (sagaops.can_read_org(organization_id));
create policy pos_program_promotion_write on sagaops.promotion_rules for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

create policy pos_program_payment_read on sagaops.payment_intents for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_payment_write on sagaops.payment_intents for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_fulfillment_read on sagaops.fulfillment_tickets for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_fulfillment_write on sagaops.fulfillment_tickets for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_print_read on sagaops.print_jobs for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_print_write on sagaops.print_jobs for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_reward_read on sagaops.reward_reservations for select using (sagaops.has_outlet_role(outlet_id, array['owner','manager']::sagaops.user_role[]));
create policy pos_program_reward_write on sagaops.reward_reservations for all using (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[])) with check (sagaops.has_outlet_role(outlet_id, array['owner','manager','cashier_barista']::sagaops.user_role[]));
create policy pos_program_incident_read on sagaops.operational_incidents for select using (sagaops.can_read_org(organization_id));
create policy pos_program_incident_write on sagaops.operational_incidents for all using (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[])) with check (sagaops.has_org_role(organization_id, array['owner','manager']::sagaops.user_role[]));

revoke all on all tables in schema sagaops from anon;
