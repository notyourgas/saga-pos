-- Extend the existing approval mechanism. Existing actions and data are retained.
alter table sagaops.esb_reliability_authorizations
  drop constraint if exists esb_reliability_authorizations_action_check;
alter table sagaops.esb_reliability_authorizations
  add constraint esb_reliability_authorizations_action_check check (action in (
    'inventory:negative_stock','shift:reopen','shift:close',
    'inventory:purchase','inventory:adjustment','inventory:waste','inventory:reversal',
    'cashier:discount'
  ));
alter table sagaops.esb_reliability_authorizations enable row level security;
alter table sagaops.esb_reliability_authorizations force row level security;
