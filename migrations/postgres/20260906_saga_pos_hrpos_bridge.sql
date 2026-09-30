create table sagaops.hrpos_flows (
  flow_hash text primary key check(length(flow_hash)=64),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  state_hash text not null check(length(state_hash)=64),
  ciphertext text not null,
  expires_at timestamptz not null
);
create index hrpos_flows_expiry on sagaops.hrpos_flows(expires_at);
create table sagaops.hrpos_bridges (
  session_hash text primary key check(length(session_hash)=64),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  ciphertext text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  remote_revocation_pending boolean not null default false
);
create index hrpos_bridges_expiry on sagaops.hrpos_bridges(expires_at);
alter table sagaops.hrpos_flows enable row level security;
alter table sagaops.hrpos_flows force row level security;
alter table sagaops.hrpos_bridges enable row level security;
alter table sagaops.hrpos_bridges force row level security;
revoke all on sagaops.hrpos_flows, sagaops.hrpos_bridges from anon, authenticated;
