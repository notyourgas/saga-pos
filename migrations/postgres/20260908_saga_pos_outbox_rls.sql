-- Row level security for the transactional integration outbox. The private
-- POS service may process only events inside its authenticated organization
-- and outlet; anonymous and direct authenticated clients remain revoked.
drop policy if exists sagaops_integration_outbox_service_scope on public.sagaops_integration_outbox;
create policy sagaops_integration_outbox_service_scope on public.sagaops_integration_outbox
for all
using (
  case
    when outlet_id is null then sagaops.has_org_role(
      organization_id,
      array['owner','manager','cashier_barista']::sagaops.user_role[]
    )
    else sagaops.has_outlet_role(
      outlet_id,
      array['owner','manager','cashier_barista']::sagaops.user_role[]
    )
  end
)
with check (
  case
    when outlet_id is null then sagaops.has_org_role(
      organization_id,
      array['owner','manager','cashier_barista']::sagaops.user_role[]
    )
    else sagaops.has_outlet_role(
      outlet_id,
      array['owner','manager','cashier_barista']::sagaops.user_role[]
    )
  end
);

revoke all on public.sagaops_integration_outbox from anon, authenticated;
