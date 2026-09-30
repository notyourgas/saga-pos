# ESB-adaptation catalog/pricing foundation

Status: `LOCAL_VALIDATED / IMPLEMENTED_NOT_DEPLOYED`.

This module is an additive Gate 4 boundary. Its PostgreSQL adapter is wired into
the durable production runtime for an explicitly configured `DUAL_WRITE_V1`
candidate, while the production default remains `OFF / LEGACY_V1`. It does not
replace the current `PilotCatalogPricing`, mutate legacy orders, or activate a
provider. ESB was used only as workflow research; this is a SagaPOS contract,
not ESB source or database behavior.

## Public adapter and runtime

Import only `index.mjs`. `createPostgresEsbCatalogRuntime` now performs this
authorized server-side sequence:

1. Load one published `price_book_version` and its published
   `pricing_policy_version` inside the authorized tenant/outlet scope.
2. Convert persisted rows with `createPriceBookVersion` and
   `createPricingPolicyVersion`; reject a version outside `[valid_from,valid_to)`.
3. Convert active promotion rows with `createPromotionVersion`.
4. Call `createCatalogQuote` on the server. Never calculate authoritative tax,
   service, discounts, or totals in the browser.
5. In the same database transaction as the order/bill write, persist the whole
   returned snapshot in `catalog_pricing_snapshots`. Persist each returned
   `freePriceAudit` in `free_price_authorization_uses`; its unique authorization
   and operation keys are the durable one-time-use gate.
6. Store `snapshotHash` on the downstream bill/order allocation. Refund and
   history readers use the stored snapshot and never re-run current catalog
   pricing.

The adapter must map module errors to the existing API error envelope without
changing their fail-closed status codes. The Lead owns `server.mjs`, repository
composition, OpenAPI root, `schema.ts`, the runtime migration manifest, and
feature activation.

## Frozen semantics

- IDR uses safe integer rupiah; rates use integer basis points.
- Included components are decomposed with largest remainder. Excluded
  components use integer half-up rate multiplication.
- Bill rounding happens once after line totals; its adjustment is signed.
- Promotion validity is half-open and evaluated in an IANA timezone. An active
  record can be scheduled, expired, or outside its local schedule.
- Compatible promotions apply by priority against the remaining eligible base;
  exclusive or duplicate stack groups fail closed.
- Modifier min/max is validated server-side and the selected option/version is
  snapshotted.
- Free price requires a one-time authorization bound to actor, action,
  price-book-entry resource, original value, requested value, expiry, reason,
  and operation key.

## Migration handoff

`migrations/postgres/20260908_zzzz_saga_pos_esb_catalog_pricing_v1.sql` is an
expand-only candidate. It creates versioned price/policy/promotion tables,
immutable pricing snapshots, durable free-price consumption, tenant-scoped
foreign keys, forced RLS, and append-only triggers.

The migration is included in `saga-pos-runtime-manifest.txt` by the serial
runtime-integration slice. Inclusion binds it to an immutable candidate; it does
not authorize production application or feature activation. Before promotion,
the release gate must review existing PostgreSQL data for FK/index
compatibility, run encrypted backup plus disposable restore, rehearse the
expand migration, verify the previous release still boots against the expanded
schema, and keep all external/payment flags off. Code rollback leaves these
additive tables in place; dropping them is not the rollback path.

## Acceptance boundary

Module-level tests cover `DATA-01`, `DATA-02`, `DATA-05`, and `PRICE-01` through
`PRICE-10`. The runtime slice adds Owner-only author/publish actions, exact
outlet-to-version assignment, persisted server quote snapshots, action-bound
free-price authorization, RBAC, history, concurrency, browser, and restart-safe
PostgreSQL evidence. The full local suite passes, but native target-engine
rehearsal, authenticated production UAT, release promotion, and activation are
still separate gates. No production deployment or activation is performed by
this slice.
