-- Additive procurement linkage for native staff receiving.
-- Companion migration: the fixed 34-entry SagaPOS runtime manifest stays unchanged.

alter table sagaops.inventory_receipt_drafts add column if not exists supplier_id text;
alter table sagaops.inventory_receipt_drafts add column if not exists purchase_order_id text;
alter table sagaops.inventory_receipt_drafts add column if not exists procurement_snapshot jsonb not null default '{}'::jsonb;
alter table sagaops.inventory_receipt_drafts add column if not exists additional_fees jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_procurement_link_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_procurement_link_valid
      check (purchase_order_id is null or supplier_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_procurement_snapshot_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_procurement_snapshot_valid
      check (jsonb_typeof(procurement_snapshot)='object');
  end if;
  if not exists (select 1 from pg_constraint where conname='inventory_receipt_additional_fees_valid') then
    alter table sagaops.inventory_receipt_drafts add constraint inventory_receipt_additional_fees_valid
      check (jsonb_typeof(additional_fees)='array' and jsonb_array_length(additional_fees) <= 10);
  end if;
end $$;

create index if not exists inventory_receipt_drafts_supplier_idx
  on sagaops.inventory_receipt_drafts(organization_id,outlet_id,supplier_id,created_at desc)
  where supplier_id is not null;
create index if not exists inventory_receipt_drafts_purchase_order_idx
  on sagaops.inventory_receipt_drafts(organization_id,outlet_id,purchase_order_id,created_at desc)
  where purchase_order_id is not null;

grant select,insert,update on sagaops.inventory_receipt_drafts to "sagaops-production";
