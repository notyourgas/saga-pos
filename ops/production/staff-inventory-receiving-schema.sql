-- SagaPOS native staff receiving and photo evidence.
-- Additive companion to native-staff-schema.sql; intentionally outside the
-- fixed SagaPOS main runtime migration ledger.

create table if not exists sagaops.staff_inventory_capabilities (
  organization_id uuid not null references sagaops.organizations(id),
  staff_id uuid not null references sagaops.staff_profiles(id) on delete cascade,
  capability text not null check (capability in (
    'inventory.receipt.capture',
    'inventory.receipt.submit',
    'inventory.receipt.post',
    'inventory.receipt.review',
    'inventory.receipt.cost.write',
    'inventory.receipt.evidence.read'
  )),
  enabled boolean not null default true,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key (staff_id,capability)
);
create index if not exists staff_inventory_capabilities_org_idx
  on sagaops.staff_inventory_capabilities(organization_id,staff_id) where enabled=true;

create table if not exists sagaops.inventory_receipt_drafts (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  actor_staff_id uuid not null references sagaops.staff_profiles(id),
  supplier_name text,
  document_number text,
  note text,
  business_date date not null,
  server_received_at timestamptz not null,
  status text not null check (status in ('DRAFT','PENDING_REVIEW','POSTING','NEEDS_CORRECTION','REJECTED','POSTED')),
  idempotency_key text not null,
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  submit_idempotency_key text,
  review_idempotency_key text,
  revision integer not null default 1 check (revision > 0),
  exception_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(exception_reasons)='array'),
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  submitted_at timestamptz,
  posted_at timestamptz,
  posted_receipt_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,actor_staff_id,idempotency_key),
  constraint inventory_receipt_review_state check (
    (status not in ('REJECTED','NEEDS_CORRECTION') or (reviewed_by is not null and reviewed_at is not null))
    and (status <> 'POSTED' or (posted_receipt_id is not null and posted_at is not null))
  )
);
create index if not exists inventory_receipt_drafts_staff_time_idx
  on sagaops.inventory_receipt_drafts(actor_staff_id,created_at desc);
create index if not exists inventory_receipt_drafts_owner_queue_idx
  on sagaops.inventory_receipt_drafts(organization_id,outlet_id,status,created_at desc);

create table if not exists sagaops.inventory_receipt_draft_lines (
  id uuid primary key,
  receipt_id uuid not null references sagaops.inventory_receipt_drafts(id) on delete cascade,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  ingredient_id text not null,
  client_reference text,
  ingredient_snapshot jsonb not null check (jsonb_typeof(ingredient_snapshot)='object'),
  purchase_option_snapshot jsonb not null check (jsonb_typeof(purchase_option_snapshot)='object'),
  delivered_quantity numeric(24,6) not null check (delivered_quantity > 0),
  accepted_quantity numeric(24,6) not null check (accepted_quantity >= 0),
  rejected_quantity numeric(24,6) not null check (rejected_quantity >= 0),
  damaged_quantity numeric(24,6) not null check (damaged_quantity >= 0),
  normalized_base_quantity numeric(24,6) not null check (normalized_base_quantity >= 0),
  lot_code text,
  expiry_date date,
  condition_code text not null,
  cost_rupiah bigint check (cost_rupiah is null or cost_rupiah > 0),
  cost_source text,
  exception_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(exception_reasons)='array'),
  note text,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_receipt_line_quantity_balance
    check (accepted_quantity + rejected_quantity + damaged_quantity <= delivered_quantity)
);
create index if not exists inventory_receipt_lines_receipt_idx
  on sagaops.inventory_receipt_draft_lines(receipt_id,sort_order,id);
create unique index if not exists inventory_receipt_lines_client_reference_unique
  on sagaops.inventory_receipt_draft_lines(receipt_id,client_reference) where client_reference is not null;
create index if not exists inventory_receipt_lines_ingredient_idx
  on sagaops.inventory_receipt_draft_lines(organization_id,outlet_id,ingredient_id);

create table if not exists sagaops.inventory_receipt_evidence (
  id uuid primary key,
  receipt_id uuid not null references sagaops.inventory_receipt_drafts(id) on delete cascade,
  receipt_line_id uuid references sagaops.inventory_receipt_draft_lines(id) on delete cascade,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  category text not null check (category in ('DELIVERY_OVERVIEW','ITEM_CONDITION','LOT_EXPIRY_LABEL','DOCUMENT','DAMAGE','OTHER')),
  object_key text not null unique,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  byte_size bigint not null check (byte_size between 1 and 26214400),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width between 1 and 20000),
  height integer not null check (height between 1 and 20000),
  captured_at timestamptz,
  uploaded_at timestamptz,
  verified_at timestamptz,
  actor_staff_id uuid not null references sagaops.staff_profiles(id),
  caption text,
  sort_order integer not null default 0 check (sort_order >= 0),
  status text not null check (status in ('PENDING','UPLOADED','VERIFIED','FAILED','SUPERSEDED')),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_receipt_evidence_verified check (
    status <> 'VERIFIED' or (uploaded_at is not null and verified_at is not null)
  )
);
create unique index if not exists inventory_receipt_evidence_active_checksum_unique
  on sagaops.inventory_receipt_evidence(receipt_id,checksum_sha256) where status <> 'SUPERSEDED';
create index if not exists inventory_receipt_evidence_receipt_idx
  on sagaops.inventory_receipt_evidence(receipt_id,receipt_line_id,sort_order,id);
create index if not exists inventory_receipt_evidence_orphan_idx
  on sagaops.inventory_receipt_evidence(status,created_at) where status in ('PENDING','FAILED');

create table if not exists sagaops.inventory_receipt_operations (
  receipt_id uuid not null references sagaops.inventory_receipt_drafts(id) on delete cascade,
  operation_key text not null,
  command_fingerprint text not null check (command_fingerprint ~ '^[0-9a-f]{64}$'),
  operation_type text not null check (operation_type in ('UPDATE')),
  committed_revision integer not null check (committed_revision > 0),
  created_at timestamptz not null default now(),
  primary key (receipt_id,operation_key)
);

create table if not exists sagaops.inventory_receipt_events (
  id uuid primary key,
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid references sagaops.outlets(id),
  receipt_id uuid references sagaops.inventory_receipt_drafts(id),
  actor_reference text not null,
  actor_staff_id uuid references sagaops.staff_profiles(id),
  event_type text not null,
  payload_redacted jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_redacted)='object'),
  occurred_at timestamptz not null
);
create index if not exists inventory_receipt_events_receipt_idx
  on sagaops.inventory_receipt_events(receipt_id,occurred_at,id);

alter table sagaops.staff_inventory_capabilities enable row level security;
alter table sagaops.staff_inventory_capabilities force row level security;
alter table sagaops.inventory_receipt_drafts enable row level security;
alter table sagaops.inventory_receipt_drafts force row level security;
alter table sagaops.inventory_receipt_draft_lines enable row level security;
alter table sagaops.inventory_receipt_draft_lines force row level security;
alter table sagaops.inventory_receipt_evidence enable row level security;
alter table sagaops.inventory_receipt_evidence force row level security;
alter table sagaops.inventory_receipt_operations enable row level security;
alter table sagaops.inventory_receipt_operations force row level security;
alter table sagaops.inventory_receipt_events enable row level security;
alter table sagaops.inventory_receipt_events force row level security;

drop policy if exists staff_inventory_capabilities_owner on sagaops.staff_inventory_capabilities;
create policy staff_inventory_capabilities_owner on sagaops.staff_inventory_capabilities for all
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
drop policy if exists staff_inventory_capabilities_own_read on sagaops.staff_inventory_capabilities;
create policy staff_inventory_capabilities_own_read on sagaops.staff_inventory_capabilities for select
  using (staff_id::text=current_setting('app.native_staff_id',true));

drop policy if exists inventory_receipt_drafts_owner on sagaops.inventory_receipt_drafts;
create policy inventory_receipt_drafts_owner on sagaops.inventory_receipt_drafts for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists inventory_receipt_drafts_staff on sagaops.inventory_receipt_drafts;
create policy inventory_receipt_drafts_staff on sagaops.inventory_receipt_drafts for all
  using (actor_staff_id::text=current_setting('app.native_staff_id',true))
  with check (actor_staff_id::text=current_setting('app.native_staff_id',true));

drop policy if exists inventory_receipt_lines_owner on sagaops.inventory_receipt_draft_lines;
create policy inventory_receipt_lines_owner on sagaops.inventory_receipt_draft_lines for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists inventory_receipt_lines_staff on sagaops.inventory_receipt_draft_lines;
create policy inventory_receipt_lines_staff on sagaops.inventory_receipt_draft_lines for all
  using (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)))
  with check (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)));

drop policy if exists inventory_receipt_evidence_owner on sagaops.inventory_receipt_evidence;
create policy inventory_receipt_evidence_owner on sagaops.inventory_receipt_evidence for all
  using (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_outlet_role(outlet_id,array['owner']::sagaops.user_role[]));
drop policy if exists inventory_receipt_evidence_staff on sagaops.inventory_receipt_evidence;
create policy inventory_receipt_evidence_staff on sagaops.inventory_receipt_evidence for all
  using (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)))
  with check (actor_staff_id::text=current_setting('app.native_staff_id',true));

drop policy if exists inventory_receipt_operations_owner on sagaops.inventory_receipt_operations;
create policy inventory_receipt_operations_owner on sagaops.inventory_receipt_operations for all
  using (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and sagaops.has_outlet_role(r.outlet_id,array['owner']::sagaops.user_role[])))
  with check (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and sagaops.has_outlet_role(r.outlet_id,array['owner']::sagaops.user_role[])));
drop policy if exists inventory_receipt_operations_staff on sagaops.inventory_receipt_operations;
create policy inventory_receipt_operations_staff on sagaops.inventory_receipt_operations for all
  using (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)))
  with check (exists (select 1 from sagaops.inventory_receipt_drafts r where r.id=receipt_id and r.actor_staff_id::text=current_setting('app.native_staff_id',true)));

drop policy if exists inventory_receipt_events_owner on sagaops.inventory_receipt_events;
create policy inventory_receipt_events_owner on sagaops.inventory_receipt_events for all
  using (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]))
  with check (sagaops.has_org_role(organization_id,array['owner']::sagaops.user_role[]));
drop policy if exists inventory_receipt_events_staff_read on sagaops.inventory_receipt_events;
create policy inventory_receipt_events_staff_read on sagaops.inventory_receipt_events for select
  using (actor_staff_id::text=current_setting('app.native_staff_id',true));
drop policy if exists inventory_receipt_events_staff_insert on sagaops.inventory_receipt_events;
create policy inventory_receipt_events_staff_insert on sagaops.inventory_receipt_events for insert
  with check (actor_staff_id::text=current_setting('app.native_staff_id',true));

grant select,insert,update,delete on
  sagaops.staff_inventory_capabilities,
  sagaops.inventory_receipt_drafts,
  sagaops.inventory_receipt_draft_lines,
  sagaops.inventory_receipt_evidence,
  sagaops.inventory_receipt_operations
to "sagaops-production";
grant select,insert on sagaops.inventory_receipt_events to "sagaops-production";
revoke all on
  sagaops.staff_inventory_capabilities,
  sagaops.inventory_receipt_drafts,
  sagaops.inventory_receipt_draft_lines,
  sagaops.inventory_receipt_evidence,
  sagaops.inventory_receipt_operations,
  sagaops.inventory_receipt_events
from anon,authenticated;
