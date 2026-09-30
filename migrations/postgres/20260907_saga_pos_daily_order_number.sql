-- Queue numbers reset per outlet and business date. The previous constraint
-- incorrectly made the human-facing number globally unique for an outlet.
-- Row level security policies on orders remain enforced and unchanged.
alter table sagaops.orders
  drop constraint if exists orders_outlet_id_order_number_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'sagaops.orders'::regclass
      and conname = 'orders_outlet_business_date_order_number_key'
  ) then
    alter table sagaops.orders
      add constraint orders_outlet_business_date_order_number_key
      unique (outlet_id, business_date, order_number);
  end if;
end $$;
