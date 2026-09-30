-- Row level security for the POS HTTP session store. It is server-only at the API boundary, but the
-- private runtime still uses a least-privilege PostgreSQL role. Authorize that
-- role through the same organization/outlet identity used by all POS facts.
drop policy if exists pos_http_sessions_service_scope on sagaops.pos_http_sessions;
create policy pos_http_sessions_service_scope on sagaops.pos_http_sessions
for all
using (
  sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','cashier_barista']::sagaops.user_role[]
  )
)
with check (
  sagaops.has_outlet_role(
    outlet_id,
    array['owner','manager','cashier_barista']::sagaops.user_role[]
  )
);

revoke all on sagaops.pos_http_sessions from anon, authenticated;
