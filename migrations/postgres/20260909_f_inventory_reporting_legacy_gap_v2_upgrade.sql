-- Additive upgrade from the byte-frozen original #30. Raw original rows use
-- their captured payment occurrence; later privacy-safe V1 rows are upgraded
-- only when one exact order and a still-paid earliest payment can be resolved.

drop trigger if exists inventory_reporting_legacy_gap_append_only on public.sagaops_integration_outbox;
lock table public.sagaops_integration_outbox in share row exclusive mode;
drop index if exists public.inventory_reporting_legacy_order_gap_unique;

with raw_resolution as (
  select gap.id gap_id,
         o.id order_id,
         p.id payment_id,
         to_char(p.paid_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') paid_at_text,
         count(*) over(partition by gap.id) resolution_count
    from public.sagaops_integration_outbox gap
    join sagaops.orders o
      on o.organization_id=gap.organization_id
     and o.outlet_id=gap.outlet_id
     and o.id::text=gap.payload->>'orderId'
    join sagaops.payments p
      on p.order_id=o.id
     and p.id::text=gap.payload->>'paymentId'
     and p.paid_at is not null
   where gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
     and jsonb_typeof(gap.payload)='object'
     and gap.payload - array['orderId','paymentId','reason']::text[] = '{}'::jsonb
     and gap.payload->>'reason'='PAID_ORDER_WITHOUT_LINE_SNAPSHOT'
), unique_raw_resolution as (
  select * from raw_resolution where resolution_count=1
)
update public.sagaops_integration_outbox gap
   set payload=jsonb_build_object(
     'schemaVersion',2,
     'gapKey',md5('inventory-reporting-legacy-order-gap-v1:' || gap.organization_id::text || ':' || resolved.order_id::text),
     'reason','PAID_ORDER_WITHOUT_LINE_SNAPSHOT',
     'paidAt',resolved.paid_at_text,
     'sourceEventFingerprint',encode(sha256(convert_to(
       'inventory-reporting-legacy-order-gap-v2:' || gap.organization_id::text || ':' || gap.outlet_id::text || ':' ||
       resolved.order_id::text || ':' || resolved.payment_id::text || ':' || resolved.paid_at_text,
       'UTF8'
     )),'hex')
   )
  from unique_raw_resolution resolved
 where gap.id=resolved.gap_id;

with resolvable as (
  select gap.id gap_id,
         o.id order_id,
         p.id payment_id,
         p.paid_at,
         to_char(p.paid_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') paid_at_text,
         count(*) over(partition by gap.id) resolution_count
    from public.sagaops_integration_outbox gap
    join sagaops.orders o
      on o.organization_id=gap.organization_id
     and o.outlet_id=gap.outlet_id
     and gap.payload->>'gapKey'=md5(
       'inventory-reporting-legacy-order-gap-v1:' || gap.organization_id::text || ':' || o.id::text
     )
    join lateral (
      select candidate.id,candidate.paid_at
        from sagaops.payments candidate
       where candidate.order_id=o.id
         and candidate.status::text='paid'
         and candidate.paid_at is not null
       order by candidate.paid_at,candidate.id
       limit 1
    ) p on true
   where gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
     and jsonb_typeof(gap.payload)='object'
     and gap.payload - array['schemaVersion','gapKey','reason']::text[] = '{}'::jsonb
     and gap.payload->>'schemaVersion'='1'
     and gap.payload->>'reason'='PAID_ORDER_WITHOUT_LINE_SNAPSHOT'
     and gap.payload->>'gapKey' ~ '^[0-9a-f]{32}$'
), unique_resolution as (
  select * from resolvable where resolution_count=1
)
update public.sagaops_integration_outbox gap
   set payload=jsonb_build_object(
     'schemaVersion',2,
     'gapKey',gap.payload->>'gapKey',
     'reason','PAID_ORDER_WITHOUT_LINE_SNAPSHOT',
     'paidAt',resolved.paid_at_text,
     'sourceEventFingerprint',encode(sha256(convert_to(
       'inventory-reporting-legacy-order-gap-v2:' || gap.organization_id::text || ':' || gap.outlet_id::text || ':' ||
       resolved.order_id::text || ':' || resolved.payment_id::text || ':' || resolved.paid_at_text,
       'UTF8'
     )),'hex')
   )
  from unique_resolution resolved
 where gap.id=resolved.gap_id;

create unique index if not exists inventory_reporting_legacy_order_gap_unique
  on public.sagaops_integration_outbox(organization_id, outlet_id, (payload->>'gapKey'))
  where event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1';

create or replace function sagaops.emit_inventory_reporting_legacy_order_gap(
  selected_organization_id uuid,
  selected_outlet_id uuid,
  selected_order_id uuid,
  selected_payment_id uuid,
  selected_paid_at timestamptz
)
returns void language plpgsql security definer set search_path = sagaops, public as $$
declare
  selected_gap_key text := md5('inventory-reporting-legacy-order-gap-v1:' || selected_organization_id::text || ':' || selected_order_id::text);
  selected_paid_at_text text := to_char(selected_paid_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  selected_source_event_fingerprint text := encode(sha256(convert_to(
    'inventory-reporting-legacy-order-gap-v2:' || selected_organization_id::text || ':' || selected_outlet_id::text || ':' ||
    selected_order_id::text || ':' || selected_payment_id::text || ':' || selected_paid_at_text,
    'UTF8'
  )),'hex');
  selected_payload jsonb;
  existing_payload jsonb;
begin
  if selected_payment_id is null or selected_paid_at is null then
    raise exception 'inventory_reporting_legacy_order_gap_source_invalid' using errcode='22023';
  end if;
  selected_payload := jsonb_build_object(
    'schemaVersion',2,
    'gapKey',selected_gap_key,
    'reason','PAID_ORDER_WITHOUT_LINE_SNAPSHOT',
    'paidAt',selected_paid_at_text,
    'sourceEventFingerprint',selected_source_event_fingerprint
  );
  select payload into existing_payload
    from public.sagaops_integration_outbox
   where organization_id=selected_organization_id and outlet_id=selected_outlet_id
     and event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
     and payload->>'gapKey'=selected_gap_key;
  if found then
    if jsonb_typeof(existing_payload) is distinct from 'object'
       or existing_payload - array['schemaVersion','gapKey','reason','paidAt','sourceEventFingerprint']::text[] <> '{}'::jsonb
       or existing_payload->>'gapKey' is distinct from selected_gap_key
       or existing_payload->>'reason' is distinct from 'PAID_ORDER_WITHOUT_LINE_SNAPSHOT'
       or existing_payload->>'schemaVersion' is distinct from '2'
       or coalesce(existing_payload->>'paidAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
       or coalesce(existing_payload->>'sourceEventFingerprint','') !~ '^[0-9a-f]{64}$' then
      raise exception 'inventory_reporting_legacy_order_gap_collision' using errcode='55000';
    end if;
    return;
  end if;
  begin
    insert into public.sagaops_integration_outbox(
      organization_id,outlet_id,event_id,event_type,payload,status,available_at,created_at
    ) values (
      selected_organization_id,selected_outlet_id,gen_random_uuid(),
      'INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1',selected_payload,'pending',clock_timestamp(),clock_timestamp()
    );
  exception when unique_violation then
    select payload into existing_payload
      from public.sagaops_integration_outbox
     where organization_id=selected_organization_id and outlet_id=selected_outlet_id
       and event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
       and payload->>'gapKey'=selected_gap_key;
    if not found
       or jsonb_typeof(existing_payload) is distinct from 'object'
       or existing_payload - array['schemaVersion','gapKey','reason','paidAt','sourceEventFingerprint']::text[] <> '{}'::jsonb
       or existing_payload->>'gapKey' is distinct from selected_gap_key
       or existing_payload->>'reason' is distinct from 'PAID_ORDER_WITHOUT_LINE_SNAPSHOT'
       or existing_payload->>'schemaVersion' is distinct from '2'
       or coalesce(existing_payload->>'paidAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
       or coalesce(existing_payload->>'sourceEventFingerprint','') !~ '^[0-9a-f]{64}$' then
      raise exception 'inventory_reporting_legacy_order_gap_collision' using errcode='55000';
    end if;
  end;
end;
$$;

revoke all on function sagaops.emit_inventory_reporting_legacy_order_gap(uuid,uuid,uuid,uuid,timestamptz) from public,anon,authenticated;

create or replace function sagaops.capture_inventory_reporting_paid_order()
returns trigger language plpgsql security definer set search_path = sagaops, public as $$
declare
  captured_line_count integer;
  inserted_line_count integer;
begin
  if new.status::text <> 'paid' or (tg_op = 'UPDATE' and old.status::text = 'paid') then
    return new;
  end if;
  select count(*)::integer into captured_line_count from sagaops.order_items where order_id=new.order_id;
  if captured_line_count < 1 then
    perform sagaops.emit_inventory_reporting_legacy_order_gap(o.organization_id,o.outlet_id,o.id,new.id,new.paid_at)
      from sagaops.orders o where o.id=new.order_id;
    return new;
  end if;
  if exists(select 1 from sagaops.inventory_reporting_order_line_snapshots where organization_id=(select organization_id from sagaops.orders where id=new.order_id) and order_id=new.order_id) then
    if exists(select 1 from sagaops.inventory_reporting_order_line_snapshots where order_id=new.order_id and payment_id<>new.id) then
      raise exception 'inventory_reporting_paid_order_snapshot_collision' using errcode='55000';
    end if;
    return new;
  end if;
  insert into sagaops.inventory_reporting_order_line_snapshots(
    organization_id,outlet_id,order_id,order_line_id,payment_id,authority_status,line_count,
    channel,subtotal_rupiah,discount_rupiah,total_hpp_rupiah,order_hpp_snapshot_status,paid_at,
    product_name_snapshot,quantity_base,line_total_rupiah,recipe_cost_snapshot_rupiah,
    line_hpp_snapshot_status,recipe_version_snapshot,recipe_snapshot,modifier_snapshot,product_reference_snapshot
  )
  select o.organization_id,o.outlet_id,o.id,i.id,new.id,'VERIFIED_PAYMENT_EVENT',captured_line_count,
         coalesce(o.channel::text,'other'),o.subtotal_rupiah,o.discount_rupiah,o.total_hpp_rupiah,
         o.hpp_snapshot_status,new.paid_at,i.product_name_snapshot,i.qty,i.line_total_rupiah,
         i.recipe_cost_snapshot_rupiah,i.hpp_snapshot_status,i.recipe_version_snapshot,
         i.recipe_snapshot_json,coalesce(i.modifier_snapshot,'[]'::jsonb),i.product_reference_snapshot
    from sagaops.orders o join sagaops.order_items i on i.order_id=o.id
   where o.id=new.order_id;
  get diagnostics inserted_line_count = row_count;
  if inserted_line_count <> captured_line_count then
    raise exception 'inventory_reporting_paid_order_snapshot_collision' using errcode='55000';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_reporting_paid_order_capture on sagaops.payments;
create trigger inventory_reporting_paid_order_capture
after insert or update of status on sagaops.payments
for each row execute function sagaops.capture_inventory_reporting_paid_order();

drop function if exists sagaops.emit_inventory_reporting_legacy_order_gap(uuid,uuid,uuid);

create or replace function sagaops.prevent_inventory_reporting_legacy_gap_mutation()
returns trigger language plpgsql set search_path = sagaops, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_reporting_history_append_only' using errcode='55000';
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.outlet_id is distinct from old.outlet_id
     or new.event_id is distinct from old.event_id
     or new.event_type is distinct from old.event_type
     or new.payload is distinct from old.payload
     or new.created_at is distinct from old.created_at then
    raise exception 'inventory_reporting_history_append_only' using errcode='55000';
  end if;
  return new;
end;
$$;

create trigger inventory_reporting_legacy_gap_append_only
before update or delete on public.sagaops_integration_outbox
for each row when (old.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1')
execute function sagaops.prevent_inventory_reporting_legacy_gap_mutation();

alter table public.sagaops_integration_outbox enable row level security;
alter table public.sagaops_integration_outbox force row level security;

-- Backfill only current, provable paid occurrences. Existing line-less orders
-- that were blocked by the original #30 receive no invented sale or cost data.
select sagaops.emit_inventory_reporting_legacy_order_gap(o.organization_id,o.outlet_id,o.id,p.id,p.paid_at)
  from sagaops.orders o
  join lateral (
    select candidate.id,candidate.paid_at
      from sagaops.payments candidate
     where candidate.order_id=o.id
       and candidate.status::text='paid'
       and candidate.paid_at is not null
     order by candidate.paid_at,candidate.id
     limit 1
  ) p on true
 where not exists(select 1 from sagaops.order_items item where item.order_id=o.id);
