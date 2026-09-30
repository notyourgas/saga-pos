create table sagaops.pos_http_sessions (
  token_hash text primary key check (length(token_hash)=64),
  organization_id uuid not null references sagaops.organizations(id),
  outlet_id uuid not null references sagaops.outlets(id),
  kind text not null check (kind in ('kiosk','operator')),
  subject jsonb not null check (jsonb_typeof(subject)='object'),
  csrf_token text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > created_at)
);
create index pos_http_sessions_expiry on sagaops.pos_http_sessions(expires_at);
alter table sagaops.pos_http_sessions enable row level security;
alter table sagaops.pos_http_sessions force row level security;
-- Backend service only. No direct browser/database access policy.
revoke all on sagaops.pos_http_sessions from anon, authenticated;
