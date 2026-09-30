import { createHash } from "node:crypto";

import { HppCatalog } from "../pos-alpha/hpp-catalog.mjs";
import { PilotCatalogPricing } from "../pos-alpha/pilot-policy.mjs";
import { deriveHppInventoryMovementFacts } from "./hpp-inventory-movement-ledger.mjs";
import {
  buildInventoryReportingProjection,
  INVENTORY_REPORTING_SOURCE_CONTRACT,
  sealInventoryReportingSource,
} from "./inventory-reporting-b20.mjs";
import { InventoryValuationLedger } from "./inventory-valuation.mjs";
import { ReplenishmentPlanner } from "./inventory-availability-replenishment.mjs";
import { validateInventoryReportingProductionDocument } from "./inventory-reporting-historical-authority-postgres.mjs";

export const INVENTORY_REPORTING_POSTGRES_PROVIDER_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_B20_POSTGRES_V1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const WASTE_TYPES = new Set(["SPOILAGE_WASTE", "PRODUCTION_WASTE", "DAMAGED", "LOSS_THEFT"]);
const RECEIPT_TYPES = new Set(["PURCHASE_RECEIPT", "PURCHASE_INSPECTION_ACCEPT", "SUPPLIER_REPLACEMENT"]);
const LEGACY_GAP_V2_PAYLOAD_SQL = `jsonb_typeof(gap.payload)='object'
  and gap.payload - array['schemaVersion','gapKey','reason','paidAt','sourceEventFingerprint']::text[] = '{}'::jsonb
  and coalesce(gap.payload->>'schemaVersion','')='2'
  and coalesce(gap.payload->>'reason','')='PAID_ORDER_WITHOUT_LINE_SNAPSHOT'
  and coalesce(gap.payload->>'gapKey','') ~ '^[0-9a-f]{32}$'
  and coalesce(gap.payload->>'sourceEventFingerprint','') ~ '^[0-9a-f]{64}$'
  and coalesce(gap.payload->>'paidAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$'`;

export class InventoryReportingPostgresError extends Error {
  constructor(code, { statusCode = 500, detail } = {}) {
    super(code);
    this.name = "InventoryReportingPostgresError";
    this.code = code;
    this.statusCode = statusCode;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Reads B20 facts from committed PostgreSQL authorities. Scope and time policy
 * are supplied by the trusted server callback; request payloads cannot select a
 * tenant, outlet, period, status, currency, location or policy version.
 */
export class InventoryReportingB20PostgresProvider {
  constructor({ db, policyProvider, planningStateIntegrityKey } = {}) {
    if (!db?.transaction) throw failure("inventory_reporting_postgres_database_required");
    if (typeof policyProvider !== "function") {
      throw failure("inventory_reporting_postgres_dependency_invalid");
    }
    if (typeof planningStateIntegrityKey !== "string" || Buffer.byteLength(planningStateIntegrityKey, "utf8") < 32) {
      throw failure("inventory_reporting_planning_integrity_key_required");
    }
    this.db = db;
    this.policyProvider = policyProvider;
    this.planningStateIntegrityKey = planningStateIntegrityKey;
  }

  async load(request = {}) {
    return this.loadForQuery(request);
  }

  async loadForQuery(request = {}) {
    const normalizedRequest = normalizeRequest(request);
    const policy = normalizePolicy(await this.policyProvider({ requestId: normalizedRequest.requestId, query: deepFreeze(structuredClone(normalizedRequest.query)) }));
    if (canonical(normalizedRequest.query) !== canonical(queryFromPolicy(policy))) throw failure("inventory_reporting_scope_override_denied", { statusCode: 403 });
    return this.db.transaction(async (tx) => {
      if (!tx?.query) throw failure("inventory_reporting_postgres_transaction_required");
      await tx.query("set transaction isolation level repeatable read read only");
      const params = [policy.organizationId, policy.outletIds, policy.snapshotCutoffUtc];
      const hppResult = await tx.query(HPP_SQL, params);
      const catalogResult = await tx.query(CATALOG_SQL, params);
      const ledgerResult = await tx.query(LEDGER_SQL, params);
      const orderResult = await tx.query(ORDER_SQL, [policy.organizationId, policy.outletIds, policy.periodStartUtc, policy.periodEndUtc, policy.snapshotCutoffUtc]);
      const legacyGapResult = await tx.query(LEGACY_GAP_SQL, [policy.organizationId, policy.outletIds, policy.periodStartUtc, policy.periodEndUtc, policy.snapshotCutoffUtc]);
      const valuationResult = await tx.query(VALUATION_SQL, params);
      const planningResult = await tx.query(PLANNING_SQL, params);
      const productionResult = await tx.query(PRODUCTION_SQL, [policy.organizationId, policy.outletIds, policy.periodStartUtc, policy.periodEndUtc, policy.snapshotCutoffUtc]);
      assertResultBounds({ hppRows: hppResult.rows, catalogRows: catalogResult.rows, ledgerRows: ledgerResult.rows, orderRows: orderResult.rows, legacyGapRows: legacyGapResult.rows, valuationRows: valuationResult.rows, planningRows: planningResult.rows, productionRows: productionResult.rows }, policy.outletIds.length);
      return buildResult({
        policy,
        hppRows: hppResult.rows,
        catalogRows: catalogResult.rows,
        ledgerRows: ledgerResult.rows,
        orderRows: orderResult.rows,
        legacyGapRows: legacyGapResult.rows,
        valuationRows: valuationResult.rows,
        planningRows: planningResult.rows,
        productionRows: productionResult.rows,
        planningStateIntegrityKey: this.planningStateIntegrityKey,
      });
    });
  }

  async assertReady(request = {}) {
    const normalizedRequest = normalizeRequest(request);
    const policy = normalizePolicy(await this.policyProvider({ requestId: normalizedRequest.requestId, query: deepFreeze(structuredClone(normalizedRequest.query)) }));
    if (canonical(normalizedRequest.query) !== canonical(queryFromPolicy(policy))) throw failure("inventory_reporting_scope_override_denied", { statusCode: 403 });
    return this.db.transaction(async (tx) => {
      await tx.query("set transaction isolation level repeatable read read only");
      const result = await tx.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='sagaops' and c.relname=any($1::text[]) order by c.relname`, [REQUIRED_TABLES]);
      const tableNames = result.rows.map((row) => row.relname).sort();
      if (canonical(tableNames) !== canonical([...REQUIRED_TABLES].sort()) || result.rows.some((row) => row.relrowsecurity !== true || row.relforcerowsecurity !== true)) throw failure("inventory_reporting_postgres_rls_not_ready");
      const outboxRls = (await tx.query(`select c.relname,c.relrowsecurity,c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname='sagaops_integration_outbox'`)).rows;
      if (outboxRls.length !== 1 || outboxRls[0].relrowsecurity !== true || outboxRls[0].relforcerowsecurity !== true) throw failure("inventory_reporting_postgres_rls_not_ready");
      const visible = await tx.query(`select
        (select count(distinct outlet_id)::int from sagaops.inventory_reporting_master_snapshots where organization_id=$1 and outlet_id=any($2::uuid[])) hpp_count,
        (select count(distinct outlet_id)::int from sagaops.inventory_reporting_master_snapshots where organization_id=$1 and outlet_id=any($2::uuid[])) catalog_count,
        (select count(*)::int from (
          select 1 from public.sagaops_integration_outbox gap
           where gap.organization_id=$1 and gap.outlet_id=any($2::uuid[])
             and gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
             and (${LEGACY_GAP_V2_PAYLOAD_SQL})
           limit 1001
        ) bounded_legacy_gaps) legacy_order_gap_count,
        (select count(*)::int from (
          select 1 from public.sagaops_integration_outbox gap
           where gap.organization_id=$1 and gap.outlet_id=any($2::uuid[])
             and gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
             and not (${LEGACY_GAP_V2_PAYLOAD_SQL})
           limit 1
        ) bounded_invalid_legacy_gaps) legacy_order_gap_invalid_count`, [policy.organizationId, policy.outletIds]);
      const scopeRow = visible.rows[0];
      if (!scopeRow || Number(scopeRow.hpp_count) !== policy.outletIds.length || Number(scopeRow.catalog_count) !== policy.outletIds.length) throw failure("inventory_reporting_postgres_scope_not_ready");
      if (nonnegativeInteger(scopeRow.legacy_order_gap_invalid_count, "inventory_reporting_legacy_gap_count_invalid") !== 0) throw failure("inventory_reporting_legacy_gap_payload_invalid");
      const legacyOrderGapCount = nonnegativeInteger(scopeRow.legacy_order_gap_count, "inventory_reporting_legacy_gap_count_invalid");
      return deepFreeze({
        ready: true,
        organizationId: policy.organizationId,
        outletIds: policy.outletIds,
        forcedRls: true,
        scopeVisible: true,
        historicalAuthority: "IMMUTABLE_REVISION_BINDING",
        dataQuality: {
          legacyPaidOrderGapBacklog: Math.min(legacyOrderGapCount, 1_000),
          truncated: legacyOrderGapCount > 1_000,
        },
      });
    });
  }
}

const REQUIRED_TABLES = Object.freeze(["hpp_inventory_movement_facts", "inventory_planning_aggregates", "inventory_reporting_master_snapshots", "inventory_reporting_order_line_snapshots", "inventory_reporting_production_facts", "inventory_valuation_aggregates", "inventory_valuation_facts", "order_items", "orders", "pos_catalog_state", "pos_hpp_catalog_state"]);
const MAX_LEDGER_ROWS = 100_000;
const MAX_ORDER_ROWS = 50_000;
const MAX_VALUATION_ROWS = 100_000;

export function inventoryReportingQueryFingerprint(query) {
  return digest(normalizeQuery(query));
}

/** Runtime ports for the Owner read API and the durable B20 rebuild job. */
export function createInventoryReportingB20PostgresRuntimeAdapter({ provider } = {}) {
  if (!provider?.loadForQuery) throw failure("inventory_reporting_postgres_provider_required");
  return Object.freeze({
    async assertReady(input = {}) {
      if (typeof provider.assertReady !== "function") throw failure("inventory_reporting_postgres_provider_not_ready");
      return provider.assertReady(input);
    },
    async prepareSource(input = {}) {
      const command = normalizeJobInput(input, false);
      const loaded = await provider.loadForQuery({ requestId: command.commandId, query: command.query });
      return deepFreeze({
        commandId: command.commandId,
        queryFingerprint: command.queryFingerprint,
        sourceFingerprint: loaded.source.sourceFingerprint,
        evidenceFingerprint: loaded.evidence.evidenceFingerprint,
      });
    },
    async loadSource(input = {}) {
      const command = normalizeJobInput(input, true);
      const loaded = await provider.loadForQuery({ requestId: command.commandId, query: command.query });
      if (loaded.source.sourceFingerprint !== command.expectedSourceFingerprint) throw failure("inventory_reporting_source_changed", { statusCode: 409 });
      return loaded.source;
    },
    async readProjection(input = {}) {
      const query = projectionQuery(input);
      const queryFingerprint = inventoryReportingQueryFingerprint(query);
      const loaded = await provider.loadForQuery({ requestId: `OWNER_READ:${queryFingerprint.slice(0, 32)}`, query });
      return buildInventoryReportingProjection({ query: loaded.query, source: loaded.source });
    },
    async resolveSourceReference(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input).sort()) !== canonical(["expectedSourceFingerprint", "query", "sourceRef"])) throw failure("inventory_reporting_source_resolver_invalid", { statusCode: 422 });
      const query = normalizeQuery(input.query);
      const sourceRef = normalizeSourceRef(input.sourceRef);
      const expectedSourceFingerprint = requiredDigest(input.expectedSourceFingerprint, "inventory_reporting_source_fingerprint_invalid");
      const queryFingerprint = inventoryReportingQueryFingerprint(query);
      const loaded = await provider.loadForQuery({ requestId: `OWNER_DRILLDOWN:${queryFingerprint.slice(0, 32)}`, query });
      if (loaded.source.sourceFingerprint !== expectedSourceFingerprint) throw failure("inventory_reporting_source_changed", { statusCode: 409 });
      const matches = [];
      for (const family of ["movementFacts", "recipeCostFacts", "varianceFacts", "saleFacts", "supplierFacts", "productionFacts", "replenishmentFacts", "qualityFacts"]) {
        for (const fact of loaded.source[family]) if (canonical(fact.sourceRef) === canonical(sourceRef)) matches.push({ family, fact: structuredClone(fact) });
      }
      if (!matches.length) throw failure("inventory_reporting_source_reference_not_found", { statusCode: 404 });
      return sourceRecord(sourceRef, matches[0]);
    },
    async shutdown() {
      if (typeof provider.shutdown === "function") await provider.shutdown();
      return Object.freeze({ stopped: true });
    },
  });
}

function sourceRecord(sourceRef, match) {
  const fact = match.fact;
  const occurredAt = fact.effectiveAt ?? fact.transactionAt ?? fact.completedAt ?? fact.observedAt ?? fact.periodEndUtc ?? null;
  const label = safeSourceText(`${match.family}:${fact.movementKind ?? fact.menuItemName ?? fact.code ?? fact.itemId ?? sourceRef.type}`, 160);
  const status = safeSourceText(fact.status ?? fact.approvalStatus ?? (fact.costComplete === false ? "INCOMPLETE" : "POSTED"), 40);
  const detail = safeSourceText(fact.code ?? fact.movementKind ?? fact.menuItemName ?? fact.itemId ?? "Source fact terikat pada report fingerprint.", 500);
  return deepFreeze({ ...sourceRef, label, status, occurredAt, documentNumber: null, detail });
}

function normalizeJobInput(input, requireExpected) {
  const keys = requireExpected ? ["commandId", "expectedSourceFingerprint", "query", "queryFingerprint"] : ["commandId", "query", "queryFingerprint"];
  if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input).sort()) !== canonical(keys.sort())) throw failure("inventory_reporting_job_source_invalid", { statusCode: 422 });
  const query = normalizeQuery(input.query);
  const queryFingerprint = requiredDigest(input.queryFingerprint, "inventory_reporting_query_fingerprint_invalid");
  if (queryFingerprint !== inventoryReportingQueryFingerprint(query)) throw failure("inventory_reporting_query_fingerprint_mismatch", { statusCode: 409 });
  return {
    commandId: requiredText(input.commandId, "inventory_reporting_job_source_invalid"),
    query,
    queryFingerprint,
    ...(requireExpected ? { expectedSourceFingerprint: requiredDigest(input.expectedSourceFingerprint, "inventory_reporting_source_fingerprint_invalid") } : {}),
  };
}

function projectionQuery(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input)) !== canonical(["query"])) throw failure("inventory_reporting_projection_read_invalid", { statusCode: 422 });
  return normalizeQuery(input.query);
}

function normalizeSourceRef(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input).sort()) !== canonical(["id", "lineId", "type"])) throw failure("inventory_reporting_source_resolver_invalid", { statusCode: 422 });
  return { type: sourceIdentifier(input.type), id: sourceIdentifier(input.id), lineId: input.lineId == null ? null : sourceIdentifier(input.lineId) };
}

const HPP_SQL = `select organization_id,outlet_id,hpp_revision revision,hpp_snapshot snapshot,bound_at updated_at,
       catalog_revision,bound_at,captured_at
  from (select h.*,row_number() over(partition by outlet_id order by bound_at desc,captured_at desc,hpp_revision desc,catalog_revision desc) authority_rank
          from sagaops.inventory_reporting_master_snapshots h
         where organization_id=$1 and outlet_id=any($2::uuid[]) and bound_at <= $3 and captured_at <= $3) ranked
 where authority_rank=1 order by outlet_id`;

const CATALOG_SQL = `select organization_id,outlet_id,catalog_revision revision,catalog_snapshot snapshot,bound_at updated_at,
       hpp_revision,bound_at,captured_at
  from (select h.*,row_number() over(partition by outlet_id order by bound_at desc,captured_at desc,hpp_revision desc,catalog_revision desc) authority_rank
          from sagaops.inventory_reporting_master_snapshots h
         where organization_id=$1 and outlet_id=any($2::uuid[]) and bound_at <= $3 and captured_at <= $3) ranked
 where authority_rank=1 order by outlet_id`;

const LEGACY_GAP_SQL = `select requested.outlet_id,
       (select count(*)::integer from (
          select 1
            from public.sagaops_integration_outbox gap
           where gap.organization_id=$1 and gap.outlet_id=requested.outlet_id
             and gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
             and gap.created_at <= $5
             and (${LEGACY_GAP_V2_PAYLOAD_SQL})
             and (case when coalesce(gap.payload->>'paidAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then gap.payload->>'paidAt' end)::timestamptz >= $3
             and (case when coalesce(gap.payload->>'paidAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then gap.payload->>'paidAt' end)::timestamptz < $4
             and (case when coalesce(gap.payload->>'paidAt','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then gap.payload->>'paidAt' end)::timestamptz <= $5
           order by (gap.payload->>'paidAt')::timestamptz,gap.event_id limit 1001
       ) bounded) gap_count,
       (select count(*)::integer from (
          select 1
            from public.sagaops_integration_outbox gap
           where gap.organization_id=$1 and gap.outlet_id=requested.outlet_id
             and gap.event_type='INVENTORY_REPORTING_LEGACY_ORDER_GAP_V1'
             and gap.created_at <= $5
             and not (${LEGACY_GAP_V2_PAYLOAD_SQL})
           limit 1
       ) invalid_bounded) invalid_count
  from unnest($2::uuid[]) requested(outlet_id)
 order by requested.outlet_id`;

const LEDGER_SQL = `select ledger_sequence,movement_id,organization_id,outlet_id,movement_type,source_type,source_id,
       source_line_id,ingredient_id,location_id,quantity_delta_base,inventory_value_delta_rupiah,
       quantity_before_base,quantity_after_base,inventory_value_before_rupiah,inventory_value_after_rupiah,
       effective_at,created_at,actor_reference,reason,audit_reference,reference_type,reference_id,reference_code,reversal_of_movement_id,
       source_event_id,source_device_id,source_local_sequence,hpp_version,requires_rebuild,movement_fingerprint
  from sagaops.hpp_inventory_movement_facts
 where organization_id=$1 and outlet_id=any($2::uuid[]) and created_at <= $3
 order by outlet_id,ledger_sequence limit 100001`;

const ORDER_SQL = `select organization_id,outlet_id,order_id,channel,subtotal_rupiah,discount_rupiah,
       total_hpp_rupiah,order_hpp_snapshot_status hpp_snapshot_status,paid_at,captured_at updated_at,
       order_line_id sale_line_id,product_name_snapshot,quantity_base qty,line_total_rupiah,recipe_cost_snapshot_rupiah,
       line_hpp_snapshot_status line_hpp_status,recipe_version_snapshot,recipe_snapshot recipe_snapshot_json,
       modifier_snapshot,product_reference_snapshot,payment_id,authority_status,line_count
  from sagaops.inventory_reporting_order_line_snapshots
 where organization_id=$1 and outlet_id=any($2::uuid[])
   and paid_at >= $3 and paid_at < $4 and captured_at <= $5
 order by outlet_id,paid_at,order_id,order_line_id limit 50001`;

const VALUATION_SQL = `select organization_id,outlet_id,valuation_scope_id,sequence,fact_id,fact_hash,fact_document,recorded_at
  from sagaops.inventory_valuation_facts
 where organization_id=$1 and outlet_id=any($2::uuid[]) and recorded_at <= $3
 order by outlet_id,valuation_scope_id,sequence limit 100001`;

const PLANNING_SQL = `select organization_id,outlet_id,revision,state_document,state_hash,updated_at
  from sagaops.inventory_planning_aggregates
 where organization_id=$1 and outlet_id=any($2::uuid[]) and updated_at <= $3
 order by outlet_id`;

const PRODUCTION_SQL = `select organization_id,outlet_id,production_id,execution_id,source_state_revision,
       source_state_hash,source_execution_hash,fact_hash,fact_document,completed_at,recorded_at
  from sagaops.inventory_reporting_production_facts
 where organization_id=$1 and outlet_id=any($2::uuid[])
   and completed_at >= $3 and completed_at < $4 and recorded_at <= $5
 order by outlet_id,completed_at,production_id limit 50001`;

function buildResult({ policy, hppRows, catalogRows, ledgerRows, orderRows, legacyGapRows, valuationRows, planningRows, productionRows, planningStateIntegrityKey }) {
  const hppByOutlet = new Map();
  const productsByOutlet = new Map();
  const authorityRevisions = [];
  const qualityFacts = [];
  for (const outletId of policy.outletIds) {
    const binding = policy.calendarLocationAuthorityBindings[outletId];
    authorityRevisions.push({ authority: "REPORTING_CALENDAR_LOCATION", outletId, revision: binding.revision, fingerprint: binding.fingerprint });
  }
  for (const outletId of policy.outletIds) {
    const row = hppRows.find((candidate) => candidate.organization_id === policy.organizationId && candidate.outlet_id === outletId);
    if (!row) throw failure("inventory_reporting_hpp_authority_missing", { detail: outletId });
    const catalogRow = catalogRows.find((candidate) => candidate.organization_id === policy.organizationId && candidate.outlet_id === outletId);
    if (!catalogRow) throw failure("inventory_reporting_product_authority_missing", { detail: outletId });
    if (instantMs(row.updated_at) > instantMs(policy.snapshotCutoffUtc) || instantMs(catalogRow.updated_at) > instantMs(policy.snapshotCutoffUtc)) throw failure("inventory_reporting_authority_cutoff_invalid", { detail: outletId });
    if (row.catalog_revision !== catalogRow.revision || catalogRow.hpp_revision !== row.revision || iso(row.captured_at) !== iso(catalogRow.captured_at)) throw failure("inventory_reporting_master_binding_mismatch", { detail: outletId });
    const snapshot = jsonObject(row.snapshot, "inventory_reporting_hpp_snapshot_invalid");
    const catalogSnapshot = jsonObject(catalogRow.snapshot, "inventory_reporting_product_authority_invalid");
    let products;
    try {
      const catalog = new PilotCatalogPricing();
      catalog.restoreState(catalogSnapshot);
      products = catalog.catalog("ADMIN").flatMap((category) => category.products);
    } catch (error) {
      throw failure("inventory_reporting_product_authority_invalid", { detail: error?.code ?? error?.message });
    }
    try {
      new HppCatalog({ productProvider: () => products }).restoreState(snapshot);
    } catch (error) {
      throw failure("inventory_reporting_hpp_snapshot_tampered", { detail: error?.code ?? error?.message });
    }
    const revision = positiveInteger(row.revision, "inventory_reporting_hpp_revision_invalid");
    hppByOutlet.set(outletId, snapshot);
    productsByOutlet.set(outletId, structuredClone(products));
    authorityRevisions.push({ authority: "HPP_CATALOG", outletId, revision, fingerprint: digest(snapshot) });
    authorityRevisions.push({ authority: "POS_CATALOG", outletId, revision: positiveInteger(catalogRow.revision, "inventory_reporting_product_revision_invalid"), fingerprint: digest(catalogSnapshot) });
  }

  const verifiedLedger = verifyLedger({ policy, hppByOutlet, ledgerRows });
  const valuationEvidence = verifyValuation({ policy, rows: valuationRows });
  const planningEvidence = verifyPlanning({ policy, rows: planningRows, planningStateIntegrityKey });
  authorityRevisions.push(...verifiedLedger.revisions, ...valuationEvidence.revisions, ...planningEvidence.revisions);

  const historicalProduction = buildProductionFacts({ policy, rows: productionRows, qualityFacts });
  qualityFacts.push(...buildLegacyGapQualityFacts({ policy, rows: legacyGapRows }));
  reconcileProductionFacts({ policy, documents: historicalProduction.documents, ledgerRows: verifiedLedger.rows });
  const movementFacts = verifiedLedger.rows
    .filter((row) => instantMs(row.created_at) <= instantMs(policy.snapshotCutoffUtc) && instantMs(row.effective_at) < instantMs(policy.periodEndUtc))
    .map(toMovementFact);
  for (const row of verifiedLedger.rows.filter((item) => item.requires_rebuild === true)) {
    qualityFacts.push(quality(policy, row.outlet_id, "MOVEMENT_REBUILD_REQUIRED", "ERROR", ref("HPP_MOVEMENT_LEDGER", row.movement_id, row.source_line_id)));
  }

  const recipeCostFacts = [];
  for (const outletId of policy.outletIds) {
    const snapshot = hppByOutlet.get(outletId);
    const catalog = new HppCatalog({ productProvider: () => productsByOutlet.get(outletId) });
    catalog.restoreState(snapshot);
    const recipeByProduct = new Map(snapshot.recipes.map((recipe) => [recipe.productId, recipe]));
    for (const product of catalog.view().products) {
      const recipe = recipeByProduct.get(product.id);
      if (!recipe || instantMs(recipe.updatedAt) > instantMs(policy.snapshotCutoffUtc)) {
        qualityFacts.push(quality(policy, outletId, "RECIPE_AT_CUTOFF_UNAVAILABLE", "WARNING", ref("HPP_RECIPE", product.id, null)));
        continue;
      }
      recipeCostFacts.push({
        recipeCostId: `${outletId}:${product.id}:${recipe.version}`,
        organizationId: policy.organizationId,
        outletId,
        menuItemId: product.id,
        variantId: null,
        quantityBase: "1.000000",
        hppRupiah: product.hppStatus === "VERIFIED" ? product.hppRupiah : null,
        costComplete: product.hppStatus === "VERIFIED",
        effectiveAt: iso(recipe.updatedAt),
        approvalStatus: "APPROVED",
        sourceRef: ref("HPP_RECIPE", recipe.id, String(recipe.version)),
      });
    }
  }

  const saleFacts = buildSaleFacts({ policy, orderRows, hppByOutlet, productsByOutlet, qualityFacts, valuationEvidence });
  const varianceFacts = buildVarianceFacts({ policy, hppByOutlet, verifiedLedger, qualityFacts });
  const supplierFacts = buildSupplierFacts({ policy, hppByOutlet });
  const replenishmentFacts = buildReplenishmentFacts({ policy, planningEvidence, qualityFacts });
  for (const outletId of policy.outletIds) {
    if (!valuationEvidence.revisions.some((entry) => entry.outletId === outletId)) {
      qualityFacts.push(quality(policy, outletId, "VALUATION_AUTHORITY_EMPTY", "WARNING", ref("VALUATION_AUTHORITY", outletId, null)));
    }
  }

  const query = queryFromPolicy(policy);
  const authorityBindings = buildAuthorityBindings(policy.outletIds, authorityRevisions);
  const source = sealInventoryReportingSource({
    sourceContract: INVENTORY_REPORTING_SOURCE_CONTRACT,
    appliedFilter: query,
    authorityBindings,
    movementFacts,
    recipeCostFacts,
    varianceFacts,
    saleFacts,
    supplierFacts,
    productionFacts: historicalProduction.productionFacts,
    replenishmentFacts,
    qualityFacts: deduplicateQuality(qualityFacts),
  });
  const evidenceBody = {
    providerContract: INVENTORY_REPORTING_POSTGRES_PROVIDER_CONTRACT,
    transactionIsolation: "REPEATABLE_READ_READ_ONLY",
    historicalMode: "IMMUTABLE_REVISION_BOUND_AUTHORITY_AT_CUTOFF",
    authorityRevisions: authorityRevisions.sort(compare("authority", "outletId", "scopeId")),
    query,
    sourceFingerprint: source.sourceFingerprint,
  };
  return deepFreeze({ query, source, evidence: { ...evidenceBody, evidenceFingerprint: digest(evidenceBody) } });
}

function buildAuthorityBindings(outletIds, authorityRevisions) {
  return outletIds.map((outletId) => {
    const rows = authorityRevisions
      .filter((entry) => entry.outletId === outletId)
      .map((entry) => ({
        authority: requiredText(entry.authority, "inventory_reporting_authority_binding_invalid"),
        scopeId: entry.scopeId == null ? null : requiredText(entry.scopeId, "inventory_reporting_authority_binding_invalid"),
        revision: nonnegativeInteger(entry.revision, "inventory_reporting_authority_binding_invalid"),
        fingerprint: requiredDigest(entry.fingerprint, "inventory_reporting_authority_binding_invalid"),
      }))
      .sort(compare("authority", "scopeId", "revision", "fingerprint"));
    if (!rows.length) throw failure("inventory_reporting_authority_binding_invalid");
    const revision = safeBigInt(rows.reduce((sum, entry) => sum + BigInt(entry.revision), 0n));
    if (revision < 1) throw failure("inventory_reporting_authority_binding_invalid");
    return { outletId, revision, fingerprint: digest(rows) };
  }).sort(compare("outletId"));
}

function verifyLedger({ policy, hppByOutlet, ledgerRows }) {
  const expectedByKey = new Map();
  const revisions = [];
  for (const outletId of policy.outletIds) {
    const expected = deriveHppInventoryMovementFacts({
      snapshot: hppByOutlet.get(outletId),
      organizationId: policy.organizationId,
      outletId,
      usableLocationId: policy.usableLocationIds[outletId],
    });
    for (const fact of expected) expectedByKey.set(`${outletId}\u0000${fact.movementId}`, fact);
  }
  const seen = new Set();
  const matchedExpected = new Set();
  const maxSequence = new Map();
  for (const row of ledgerRows) {
    if (row.organization_id !== policy.organizationId || !policy.outletIds.includes(row.outlet_id)) throw failure("inventory_reporting_ledger_scope_mismatch");
    const key = `${row.outlet_id}\u0000${row.movement_id}`;
    if (seen.has(key)) throw failure("inventory_reporting_ledger_duplicate");
    seen.add(key);
    const document = ledgerDocument(row);
    const { fingerprint, ...fingerprintBody } = document;
    if (fingerprint !== createHash("sha256").update(JSON.stringify(fingerprintBody)).digest("hex")) throw failure("inventory_reporting_ledger_tampered", { detail: row.movement_id });
    if (decimalUnits(row.quantity_after_base) !== decimalUnits(row.quantity_before_base) + decimalUnits(row.quantity_delta_base)
      || money(row.inventory_value_after_rupiah) !== safeAdd(row.inventory_value_before_rupiah, row.inventory_value_delta_rupiah)) throw failure("inventory_reporting_ledger_balance_chain_invalid", { detail: row.movement_id });
    const expected = expectedByKey.get(key);
    if (expected) {
      if (!ledgerMatches(row, expected)) throw failure("inventory_reporting_ledger_tampered", { detail: row.movement_id });
      matchedExpected.add(key);
    } else if (!new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(row.movement_type)) {
      throw failure("inventory_reporting_ledger_tampered", { detail: row.movement_id });
    }
    const sequence = positiveInteger(row.ledger_sequence, "inventory_reporting_ledger_sequence_invalid");
    if (sequence <= (maxSequence.get(row.outlet_id) ?? 0)) throw failure("inventory_reporting_ledger_sequence_invalid");
    maxSequence.set(row.outlet_id, Math.max(maxSequence.get(row.outlet_id) ?? 0, sequence));
  }
  if (matchedExpected.size !== expectedByKey.size) throw failure("inventory_reporting_ledger_incomplete");
  for (const outletId of policy.outletIds) revisions.push({ authority: "HPP_MOVEMENT_LEDGER", outletId, revision: maxSequence.get(outletId) ?? 0, fingerprint: digest(ledgerRows.filter((row) => row.outlet_id === outletId).map(ledgerCanonical)) });
  return { rows: ledgerRows, revisions };
}

function ledgerMatches(row, expected) {
  const actual = ledgerDocument(row);
  const comparableKeys = ["movementId", "organizationId", "outletId", "movementType", "sourceType", "sourceId", "sourceLineId", "ingredientId", "locationId", "quantityDeltaBase", "inventoryValueDeltaRupiah", "effectiveAt", "actorReference", "reason", "auditReference", "referenceType", "referenceId", "referenceCode", "reversalOfMovementId", "sourceEventId", "sourceDeviceId", "sourceLocalSequence", "hppVersion"];
  return canonical(Object.fromEntries(comparableKeys.map((key) => [key, actual[key]]))) === canonical(Object.fromEntries(comparableKeys.map((key) => [key, expected[key]])));
}

function ledgerDocument(row) {
  return {
    movementId: row.movement_id, organizationId: row.organization_id, outletId: row.outlet_id,
    movementType: row.movement_type, sourceType: row.source_type, sourceId: row.source_id,
    sourceLineId: row.source_line_id, ingredientId: row.ingredient_id, locationId: row.location_id,
    quantityDeltaBase: quantity(row.quantity_delta_base), inventoryValueDeltaRupiah: money(row.inventory_value_delta_rupiah),
    quantityBeforeBase: quantity(row.quantity_before_base), quantityAfterBase: quantity(row.quantity_after_base),
    inventoryValueBeforeRupiah: money(row.inventory_value_before_rupiah), inventoryValueAfterRupiah: money(row.inventory_value_after_rupiah),
    effectiveAt: iso(row.effective_at), actorReference: row.actor_reference, reason: row.reason,
    auditReference: row.audit_reference, referenceType: row.reference_type,
    referenceId: row.reference_id, referenceCode: row.reference_code ?? null,
    reversalOfMovementId: row.reversal_of_movement_id ?? null, sourceEventId: row.source_event_id ?? null,
    sourceDeviceId: row.source_device_id ?? null, sourceLocalSequence: row.source_local_sequence == null ? null : Number(row.source_local_sequence),
    hppVersion: Number(row.hpp_version), fingerprint: row.movement_fingerprint,
  };
}

function verifyValuation({ policy, rows }) {
  const groups = group(rows, (row) => `${row.outlet_id}\u0000${row.valuation_scope_id}`);
  const revisions = [];
  const consumptionsByOutlet = new Map();
  for (const [key, facts] of groups) {
    const [outletId, scopeId] = key.split("\u0000");
    const revision = facts.length;
    const state = new InventoryValuationLedger().exportState();
    state.facts = facts.map((row, index) => {
      const document = jsonObject(row.fact_document, "inventory_reporting_valuation_fact_invalid");
      if (Number(row.sequence) !== index + 1 || document.sequence !== Number(row.sequence) || document.factId !== row.fact_id || document.factHash !== row.fact_hash) throw failure("inventory_reporting_valuation_fact_tampered", { detail: row.fact_id });
      return document;
    });
    try {
      const ledger = new InventoryValuationLedger();
      ledger.restoreState(state);
      const view = ledger.viewScope({ organizationId: policy.organizationId, outletId, valuationScopeId: scopeId });
      const target = consumptionsByOutlet.get(outletId) ?? new Map();
      for (const consumption of view.consumptions) {
        if (target.has(consumption.id)) throw failure("inventory_reporting_valuation_consumption_duplicate", { detail: consumption.id });
        target.set(consumption.id, consumption);
      }
      consumptionsByOutlet.set(outletId, target);
    } catch (error) { throw failure("inventory_reporting_valuation_fact_tampered", { detail: error?.code }); }
    revisions.push({ authority: "INVENTORY_VALUATION", outletId, scopeId, revision, fingerprint: digest(state.facts) });
  }
  for (const row of rows) {
    if (row.organization_id !== policy.organizationId || !policy.outletIds.includes(row.outlet_id)) throw failure("inventory_reporting_valuation_scope_mismatch");
    if (instantMs(row.recorded_at) > instantMs(policy.snapshotCutoffUtc)) throw failure("inventory_reporting_valuation_cutoff_invalid");
    if (!DIGEST.test(row.fact_hash)) throw failure("inventory_reporting_valuation_fact_tampered");
  }
  return { revisions, consumptionsByOutlet };
}

function verifyPlanning({ policy, rows, planningStateIntegrityKey }) {
  const states = new Map();
  const revisions = [];
  for (const row of rows) {
    if (row.organization_id !== policy.organizationId || !policy.outletIds.includes(row.outlet_id)) throw failure("inventory_reporting_planning_scope_mismatch");
    if (instantMs(row.updated_at) > instantMs(policy.snapshotCutoffUtc)) throw failure("inventory_reporting_planning_cutoff_invalid");
    const state = jsonObject(row.state_document, "inventory_reporting_planning_state_invalid");
    if (state.integrityHash !== row.state_hash || !DIGEST.test(row.state_hash)) throw failure("inventory_reporting_planning_state_tampered");
    try {
      new ReplenishmentPlanner({ tenantId: `${policy.organizationId}:${row.outlet_id}`, stateIntegrityKey: planningStateIntegrityKey, state });
    } catch (error) {
      throw failure("inventory_reporting_planning_state_tampered", { detail: error?.code ?? error?.message });
    }
    const revision = nonnegativeInteger(row.revision, "inventory_reporting_planning_revision_invalid");
    states.set(row.outlet_id, state);
    revisions.push({ authority: "INVENTORY_PLANNING", outletId: row.outlet_id, revision, fingerprint: row.state_hash });
  }
  return { states, revisions };
}

function toMovementFact(row) {
  const mapped = mapMovement(row.movement_type);
  return {
    factId: row.movement_id,
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    itemId: row.ingredient_id,
    locationId: row.location_id,
    movementKind: mapped,
    quantityDeltaBase: quantity(row.quantity_delta_base),
    inventoryValueDeltaRupiah: money(row.inventory_value_delta_rupiah),
    transferId: mapped.startsWith("TRANSFER_") ? row.reference_id : null,
    productionId: mapped.startsWith("PRODUCTION_") ? row.reference_id : null,
    effectiveAt: iso(row.effective_at),
    status: "POSTED",
    sourceRef: ref("HPP_MOVEMENT_LEDGER", row.movement_id, row.source_line_id),
  };
}

function mapMovement(value) {
  if (RECEIPT_TYPES.has(value)) return "PURCHASE_RECEIPT";
  if (value === "SUPPLIER_RETURN") return "SUPPLIER_RETURN";
  if (value === "SALE_CONSUMPTION") return "SALE_CONSUMPTION";
  if (WASTE_TYPES.has(value)) return "WASTE";
  if (["TRANSFER_OUT", "TRANSFER_IN", "PRODUCTION_INPUT", "PRODUCTION_OUTPUT"].includes(value)) return value;
  return "ADJUSTMENT";
}

function buildProductionFacts({ policy, rows }) {
  const productionFacts = [];
  const documents = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.organization_id !== policy.organizationId || !policy.outletIds.includes(row.outlet_id)) throw failure("inventory_reporting_production_scope_mismatch");
    if (instantMs(row.completed_at) < instantMs(policy.periodStartUtc) || instantMs(row.completed_at) >= instantMs(policy.periodEndUtc) || instantMs(row.recorded_at) > instantMs(policy.snapshotCutoffUtc)) throw failure("inventory_reporting_production_cutoff_invalid");
    const document = validateInventoryReportingProductionDocument(jsonObject(row.fact_document, "inventory_reporting_production_fact_invalid"));
    if (document.organizationId !== row.organization_id || document.outletId !== row.outlet_id
      || document.productionId !== row.production_id || document.executionId !== row.execution_id
      || document.sourceStateRevision !== Number(row.source_state_revision) || document.sourceStateHash !== row.source_state_hash
      || document.sourceExecutionHash !== row.source_execution_hash || document.factHash !== row.fact_hash
      || document.completedAt !== iso(row.completed_at)) throw failure("inventory_reporting_production_fact_tampered");
    if (seen.has(document.productionId)) throw failure("inventory_reporting_production_fact_duplicate");
    seen.add(document.productionId);
    documents.push(document);
    productionFacts.push({
      productionId: document.productionId,
      organizationId: document.organizationId,
      outletId: document.outletId,
      expectedOutputQuantityBase: document.plannedOutput.quantityBase,
      actualOutputQuantityBase: document.actualOutput.quantityBase,
      completedAt: document.completedAt,
      status: "COMPLETED",
      sourceRef: ref("PRODUCTION_EXECUTION", document.executionId, null),
    });
  }
  return { documents, productionFacts };
}

function reconcileProductionFacts({ policy, documents, ledgerRows }) {
  const relevantRows = ledgerRows.filter((row) => new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(row.movement_type)
    && instantMs(row.created_at) <= instantMs(policy.snapshotCutoffUtc)
    && instantMs(row.effective_at) >= instantMs(policy.periodStartUtc)
    && instantMs(row.effective_at) < instantMs(policy.periodEndUtc));
  const rowsByProduction = group(relevantRows, (row) => row.reference_id);
  const documentsByProduction = new Map(documents.map((document) => [document.productionId, document]));
  if (rowsByProduction.size !== documentsByProduction.size || [...rowsByProduction.keys()].some((id) => !documentsByProduction.has(id))) throw failure("inventory_reporting_production_fact_missing");
  for (const document of documents) {
    const rows = rowsByProduction.get(document.productionId) ?? [];
    if (!rows.length || rows.some((row) => row.source_type !== "PRODUCTION_EXECUTION" || row.source_id !== document.executionId || row.reference_id !== document.productionId || row.outlet_id !== document.outletId)) throw failure("inventory_reporting_production_source_mismatch", { detail: document.productionId });
    const expected = [
      ...document.inputs.map((line) => ["PRODUCTION_INPUT", line.itemId, line.locationId, formatUnits(-decimalUnits(line.quantityBase)), -line.inventoryValueRupiah]),
      ["PRODUCTION_OUTPUT", document.actualOutput.itemId, document.actualOutput.locationId, document.actualOutput.quantityBase, document.actualOutput.inventoryValueRupiah],
    ].sort(compare(0, 1, 2));
    const actualMap = new Map();
    for (const row of rows) {
      const key = canonical([row.movement_type, row.ingredient_id, row.location_id]);
      const aggregate = actualMap.get(key) ?? { kind: row.movement_type, itemId: row.ingredient_id, locationId: row.location_id, quantity: 0n, value: 0 };
      aggregate.quantity += decimalUnits(row.quantity_delta_base);
      aggregate.value = safeAdd(aggregate.value, money(row.inventory_value_delta_rupiah));
      actualMap.set(key, aggregate);
    }
    const actual = [...actualMap.values()].map((row) => [row.kind, row.itemId, row.locationId, formatUnits(row.quantity), row.value]).sort(compare(0, 1, 2));
    if (canonical(actual) !== canonical(expected)) throw failure("inventory_reporting_production_ledger_mismatch", { detail: document.productionId });
  }
}

export function reconcileInventoryReportingProductionAuthority({ organizationId, outletIds, periodStartUtc, periodEndUtc, snapshotCutoffUtc, documents, ledgerRows } = {}) {
  const policy = {
    organizationId: requiredText(organizationId, "inventory_reporting_policy_invalid"),
    outletIds: Array.isArray(outletIds) ? outletIds.map((value) => requiredText(value, "inventory_reporting_policy_invalid")) : [],
    periodStartUtc: iso(periodStartUtc),
    periodEndUtc: iso(periodEndUtc),
    snapshotCutoffUtc: iso(snapshotCutoffUtc),
  };
  if (!policy.outletIds.length || !Array.isArray(documents) || !Array.isArray(ledgerRows)) throw failure("inventory_reporting_production_authority_invalid", { statusCode: 422 });
  const normalizedDocuments = documents.map((document) => validateInventoryReportingProductionDocument(document));
  reconcileProductionFacts({ policy, documents: normalizedDocuments, ledgerRows });
  return Object.freeze({ documentCount: normalizedDocuments.length });
}

function buildSaleFacts({ policy, orderRows, hppByOutlet, productsByOutlet, qualityFacts, valuationEvidence }) {
  const rowsByOrder = group(orderRows, (row) => row.order_id);
  const facts = [];
  const seenLines = new Set();
  const currentCostsByOutlet = new Map(policy.outletIds.map((outletId) => {
    const catalog = new HppCatalog({ productProvider: () => productsByOutlet.get(outletId) });
    catalog.restoreState(hppByOutlet.get(outletId));
    return [outletId, new Map(catalog.view().products.map((product) => [product.id, product]))];
  }));
  for (const [orderId, rows] of rowsByOrder) {
    if (rows.some((row) => row.organization_id !== policy.organizationId || !policy.outletIds.includes(row.outlet_id))) throw failure("inventory_reporting_order_scope_mismatch");
    if (rows.some((row) => row.order_id !== orderId || row.outlet_id !== rows[0].outlet_id)) throw failure("inventory_reporting_order_fanout_invalid");
    if (rows.some((row) => instantMs(row.paid_at) < instantMs(policy.periodStartUtc) || instantMs(row.paid_at) >= instantMs(policy.periodEndUtc) || instantMs(row.updated_at) > instantMs(policy.snapshotCutoffUtc))) throw failure("inventory_reporting_order_cutoff_invalid");
    if (rows.some((row) => Number(row.line_count) !== rows.length || row.payment_id !== rows[0].payment_id || row.authority_status !== rows[0].authority_status)) throw failure("inventory_reporting_order_snapshot_incomplete");
    for (const row of rows) {
      if (seenLines.has(row.sale_line_id)) throw failure("inventory_reporting_order_line_duplicate", { detail: row.sale_line_id });
      seenLines.add(row.sale_line_id);
    }
    const outletId = rows[0].outlet_id;
    const snapshot = hppByOutlet.get(outletId);
    const consumptions = snapshot.saleConsumptions.filter((entry) => entry.orderId === orderId && instantMs(entry.occurredAt) <= instantMs(policy.snapshotCutoffUtc));
    const originals = consumptions.filter((entry) => entry.consumptionReason === "ORIGINAL");
    const immutableLinkComplete = originals.length === 1 && orderMatchesConsumption(rows, originals[0]);
    const valuationByConsumption = valuationEvidence.consumptionsByOutlet.get(outletId) ?? new Map();
    const valuedConsumptions = consumptions.map((entry) => valuationByConsumption.get(entry.id));
    const valuationComplete = immutableLinkComplete && consumptions.length > 0 && valuedConsumptions.every(Boolean);
    const hppPostedTotal = immutableLinkComplete ? consumptions.flatMap((entry) => entry.lines).reduce((sum, line) => safeAdd(sum, line.postedCogsRupiah), 0) : null;
    const postedTotal = valuationComplete ? valuedConsumptions.reduce((sum, entry) => safeAdd(sum, entry.postedCogsRupiah), 0) : null;
    const adjustmentTotal = valuationComplete ? valuedConsumptions.reduce((sum, entry) => safeAdd(sum, entry.cogsAdjustmentRupiah), 0) : null;
    if (valuationComplete && postedTotal !== hppPostedTotal) throw failure("inventory_reporting_valuation_cogs_parity_mismatch", { detail: orderId });
    const revenueAllocations = allocateInteger(Math.max(0, money(rows[0].subtotal_rupiah) - money(rows[0].discount_rupiah)), rows.map((row) => money(row.line_total_rupiah)));
    const hppWeights = rows.map((row) => safeMultiply(money(row.recipe_cost_snapshot_rupiah), decimalUnits(row.qty)));
    const postedAllocations = postedTotal == null ? rows.map(() => null) : allocateInteger(postedTotal, hppWeights);
    const adjustmentAllocations = adjustmentTotal == null ? rows.map(() => null) : allocateSignedInteger(adjustmentTotal, hppWeights);
    const products = currentCostsByOutlet.get(outletId);
    const orderCostComplete = rows.every((row) => String(row.line_hpp_status).toUpperCase() === "VERIFIED")
      && String(rows[0].hpp_snapshot_status).toUpperCase() === "VERIFIED"
      && immutableLinkComplete
      && valuationComplete
      && rows[0].authority_status === "VERIFIED_PAYMENT_EVENT";
    rows.forEach((row, index) => {
      const productId = requiredText(row.product_reference_snapshot, "inventory_reporting_sale_product_missing");
      const modifiers = jsonArray(row.modifier_snapshot, "inventory_reporting_sale_modifier_invalid");
      const modifier = modifierDimension(modifiers);
      const current = products.get(productId);
      const complete = orderCostComplete
        && postedAllocations[index] != null && adjustmentAllocations[index] != null
        && current?.hppStatus === "VERIFIED" && Number.isSafeInteger(current.hppRupiah);
      const transactionHpp = complete ? safeMoneyFromScaled(hppWeights[index]) : null;
      facts.push({
        saleLineId: row.sale_line_id,
        organizationId: policy.organizationId,
        outletId,
        menuItemId: productId,
        menuItemName: requiredText(row.product_name_snapshot),
        variantId: null,
        variantName: null,
        modifierId: modifier?.id ?? null,
        modifierName: modifier?.name ?? null,
        channel: mapChannel(row.channel),
        quantityBase: quantity(row.qty),
        netRevenueRupiah: revenueAllocations[index],
        costComplete: complete,
        currentRecipeHppRupiah: complete && current ? money(current.hppRupiah) : null,
        transactionHppRupiah: transactionHpp,
        theoreticalSalesCogsRupiah: transactionHpp,
        postedCogsRupiah: complete ? postedAllocations[index] : null,
        cogsAdjustmentRupiah: complete ? adjustmentAllocations[index] : null,
        adjustedCogsRupiah: complete ? safeAdd(postedAllocations[index], adjustmentAllocations[index]) : null,
        transactionAt: iso(row.paid_at),
        status: "POSTED",
        sourceRef: ref("ORDER_ITEM_SNAPSHOT", orderId, row.sale_line_id),
      });
      if (!complete) qualityFacts.push(quality(policy, outletId, "SALE_COST_INCOMPLETE", "ERROR", ref("ORDER_ITEM_SNAPSHOT", orderId, row.sale_line_id)));
    });
    if (!immutableLinkComplete) qualityFacts.push(quality(policy, outletId, "SALE_CONSUMPTION_LINK_AMBIGUOUS", "ERROR", ref("ORDER", orderId, "SALE_CONSUMPTION_LINK_AMBIGUOUS")));
    if (!valuationComplete) qualityFacts.push(quality(policy, outletId, "VALUATION_CONSUMPTION_MISSING", "ERROR", ref("ORDER", orderId, "VALUATION_CONSUMPTION_MISSING")));
    if (rows[0].authority_status !== "VERIFIED_PAYMENT_EVENT") qualityFacts.push(quality(policy, outletId, "ORDER_HISTORY_BACKFILL_UNVERIFIED", "ERROR", ref("ORDER", orderId, "ORDER_HISTORY_BACKFILL_UNVERIFIED")));
    if (consumptions.some((entry) => entry.consumptionReason === "REMAKE")) qualityFacts.push(quality(policy, outletId, "REMAKE_COGS_INCLUDED", "INFO", ref("ORDER", orderId, "REMAKE_COGS_INCLUDED")));
  }
  return facts;
}

function orderMatchesConsumption(rows, consumption) {
  const orderQuantities = new Map();
  const orderProducts = rows.map((row) => row.product_reference_snapshot);
  const consumptionProducts = (consumption.items ?? []).map((item) => item.productId);
  if (new Set(orderProducts).size !== orderProducts.length || new Set(consumptionProducts).size !== consumptionProducts.length) return false;
  for (const row of rows) {
    const productId = row.product_reference_snapshot;
    if (typeof productId !== "string" || !productId) return false;
    orderQuantities.set(productId, (orderQuantities.get(productId) ?? 0n) + decimalUnits(row.qty));
  }
  const consumptionQuantities = new Map();
  for (const item of consumption.items ?? []) {
    if (typeof item.productId !== "string") return false;
    consumptionQuantities.set(item.productId, (consumptionQuantities.get(item.productId) ?? 0n) + decimalUnits(item.qty));
  }
  return canonical([...orderQuantities.entries()].sort()) === canonical([...consumptionQuantities.entries()].sort());
}

function buildVarianceFacts({ policy, hppByOutlet, verifiedLedger, qualityFacts }) {
  const results = [];
  for (const outletId of policy.outletIds) {
    const snapshot = hppByOutlet.get(outletId);
    const period = snapshot.inventoryPeriods.find((entry) => entry.status === "CLOSED" && iso(entry.periodStartAt) === policy.periodStartUtc && iso(entry.periodEndAt) === policy.periodEndUtc);
    if (!period) {
      qualityFacts.push(quality(policy, outletId, "COUNT_PAIR_UNAVAILABLE", "WARNING", ref("INVENTORY_PERIOD", outletId, null)));
      continue;
    }
    const opening = snapshot.inventoryCounts.find((entry) => entry.id === period.openingCountId && entry.status === "COMPLETED");
    const closing = snapshot.inventoryCounts.find((entry) => entry.id === period.closingCountId && entry.status === "COMPLETED");
    if (!opening || !closing) throw failure("inventory_reporting_count_pair_tampered");
    const openingByItem = new Map(opening.lines.map((line) => [line.ingredientId, decimalUnits(line.quantityAfterBase)]));
    const closingByItem = new Map(closing.lines.map((line) => [line.ingredientId, decimalUnits(line.quantityAfterBase)]));
    if (openingByItem.size !== closingByItem.size || [...openingByItem.keys()].some((key) => !closingByItem.has(key))) throw failure("inventory_reporting_count_pair_tampered");
    const rows = verifiedLedger.rows.filter((row) => row.outlet_id === outletId && instantMs(row.created_at) <= instantMs(policy.snapshotCutoffUtc) && instantMs(row.effective_at) >= instantMs(policy.periodStartUtc) && instantMs(row.effective_at) < instantMs(policy.periodEndUtc));
    for (const itemId of openingByItem.keys()) {
      const itemRows = rows.filter((row) => row.ingredient_id === itemId);
      if (itemRows.some((row) => new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(row.movement_type))) {
        qualityFacts.push(quality(policy, outletId, "VARIANCE_PRODUCTION_YIELD_UNAVAILABLE", "ERROR", ref("INVENTORY_PERIOD", period.id, itemId)));
        continue;
      }
      const recognizedFlow = itemRows.filter((row) => RECEIPT_TYPES.has(row.movement_type)
        || new Set(["SUPPLIER_RETURN", "TRANSFER_IN", "TRANSFER_OUT"]).has(row.movement_type))
        .reduce((sum, row) => sum + decimalUnits(row.quantity_delta_base), 0n);
      const recordedRows = itemRows.filter((row) => row.movement_type === "SALE_CONSUMPTION");
      const wasteRows = itemRows.filter((row) => WASTE_TYPES.has(row.movement_type));
      const recordedQuantity = -recordedRows.reduce((sum, row) => sum + decimalUnits(row.quantity_delta_base), 0n);
      const wasteQuantity = -wasteRows.reduce((sum, row) => sum + decimalUnits(row.quantity_delta_base), 0n);
      const actualQuantity = openingByItem.get(itemId) + recognizedFlow - closingByItem.get(itemId);
      if (actualQuantity < 0n || recordedQuantity < 0n || wasteQuantity < 0n) throw failure("inventory_reporting_variance_quantity_invalid", { detail: itemId });
      const consumptions = snapshot.saleConsumptions.filter((entry) => instantMs(entry.occurredAt) >= instantMs(policy.periodStartUtc) && instantMs(entry.occurredAt) < instantMs(policy.periodEndUtc));
      const theoreticalQuantity = consumptions.flatMap((entry) => entry.lines).filter((line) => line.ingredientId === itemId).reduce((sum, line) => sum + decimalUnits(line.quantityRequiredBase), 0n);
      const ingredient = snapshot.ingredients.find((entry) => entry.id === itemId);
      const complete = Number.isSafeInteger(ingredient?.costPerUnitRupiah) && ingredient.costPerUnitRupiah >= 0;
      const theoreticalValue = complete ? scaledMoney(theoreticalQuantity, ingredient.costPerUnitRupiah) : null;
      const recordedCurrentValue = complete ? scaledMoney(recordedQuantity, ingredient.costPerUnitRupiah) : null;
      const recordedValue = complete ? -recordedRows.reduce((sum, row) => safeAdd(sum, money(row.inventory_value_delta_rupiah)), 0) : null;
      const actualValue = complete ? scaledMoney(actualQuantity, ingredient.costPerUnitRupiah) : null;
      const wasteValue = complete ? -wasteRows.reduce((sum, row) => safeAdd(sum, money(row.inventory_value_delta_rupiah)), 0) : null;
      results.push({
        varianceId: `${outletId}:${period.id}:${itemId}`,
        organizationId: policy.organizationId,
        outletId,
        itemId,
        periodStartUtc: policy.periodStartUtc,
        periodEndUtc: policy.periodEndUtc,
        status: "POSTED",
        theoreticalUsageQuantityBase: formatUnits(theoreticalQuantity),
        recordedUsageQuantityBase: formatUnits(recordedQuantity),
        countDerivedActualQuantityBase: formatUnits(actualQuantity),
        yieldVarianceQuantityBase: "0.000000",
        wasteQuantityBase: formatUnits(wasteQuantity),
        costComplete: complete,
        theoreticalUsageValueRupiah: theoreticalValue,
        recordedUsageAtCurrentCostRupiah: recordedCurrentValue,
        recordedUsageValueRupiah: recordedValue,
        countDerivedActualValueRupiah: actualValue,
        yieldVarianceValueRupiah: complete ? 0 : null,
        wasteValueRupiah: wasteValue,
        currentRecipeHppRupiah: complete ? ingredient.costPerUnitRupiah : null,
        transactionHppRupiah: theoreticalValue,
        theoreticalSalesCogsRupiah: theoreticalValue,
        postedCogsRupiah: recordedValue,
        adjustedCogsRupiah: recordedValue,
        sourceRef: ref("INVENTORY_PERIOD", period.id, itemId),
      });
      if (!complete) qualityFacts.push(quality(policy, outletId, "VARIANCE_COST_INCOMPLETE", "ERROR", ref("INVENTORY_PERIOD", period.id, itemId)));
    }
  }
  return results;
}

function buildSupplierFacts({ policy, hppByOutlet }) {
  const facts = [];
  for (const outletId of policy.outletIds) {
    const snapshot = hppByOutlet.get(outletId);
    const orders = new Map(snapshot.purchaseOrders.map((entry) => [entry.id, entry]));
    for (const receipt of snapshot.purchaseReceipts.filter((entry) => instantMs(entry.receivedAt) >= instantMs(policy.periodStartUtc) && instantMs(entry.receivedAt) < instantMs(policy.periodEndUtc))) {
      const order = orders.get(receipt.purchaseOrderId);
      if (!order || !receipt.supplierId) continue;
      let ordered = 0n; let accepted = 0n; let rejected = 0n;
      for (const line of receipt.lines) {
        const unitsPerPurchase = decimalUnits(line.baseUnitsPerPurchaseUnit);
        accepted += multiplyUnits(decimalUnits(line.purchaseQuantity), unitsPerPurchase);
        rejected += multiplyUnits(decimalUnits(line.rejectedPurchaseQuantity), unitsPerPurchase);
        ordered += multiplyUnits(decimalUnits(line.orderedRemainingBefore ?? line.deliveredPurchaseQuantity), unitsPerPurchase);
      }
      if (accepted + rejected > ordered) ordered = accepted + rejected;
      facts.push({
        supplierFactId: `${outletId}:${receipt.id}`,
        organizationId: policy.organizationId,
        outletId,
        supplierId: receipt.supplierId,
        orderedQuantityBase: formatUnits(ordered),
        acceptedQuantityBase: formatUnits(accepted),
        rejectedQuantityBase: formatUnits(rejected),
        acceptedValueRupiah: money(receipt.totalCostRupiah),
        onTime: receipt.receivedAt.slice(0, 10) <= order.expectedDate,
        effectiveAt: iso(receipt.receivedAt),
        status: "POSTED",
        sourceRef: ref("PURCHASE_RECEIPT", receipt.id, null),
      });
    }
  }
  return facts;
}

function buildReplenishmentFacts({ policy, planningEvidence, qualityFacts }) {
  const facts = [];
  for (const outletId of policy.outletIds) {
    const state = planningEvidence.states.get(outletId);
    if (!state) {
      qualityFacts.push(quality(policy, outletId, "PLANNING_AUTHORITY_EMPTY", "WARNING", ref("PLANNING_AUTHORITY", outletId, null)));
      continue;
    }
    for (const recommendation of state.recommendations.filter((entry) => entry.status === "APPROVED")) {
      const observedAt = iso(recommendation.inventoryObservedAt ?? recommendation.progressedAt ?? recommendation.createdAt);
      if (instantMs(observedAt) > instantMs(policy.snapshotCutoffUtc)) continue;
      facts.push({
        replenishmentId: recommendation.id,
        organizationId: policy.organizationId,
        outletId,
        itemId: recommendation.itemId,
        locationId: recommendation.locationId,
        projectedShortageQuantityBase: formatUnits(BigInt(Math.max(0, recommendation.rawNeed)) * 1_000_000n),
        recommendedQuantityBase: formatUnits(BigInt(recommendation.roundedRecommendation) * 1_000_000n),
        policyVersion: `REVISION:${recommendation.policyRevision}`,
        observedAt,
        status: "APPROVED",
        sourceRef: ref("PLANNING_RECOMMENDATION", recommendation.id, String(recommendation.statusRevision)),
      });
    }
  }
  return facts;
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("inventory_reporting_request_invalid", { statusCode: 422 });
  const keys = Object.keys(input);
  if (canonical(keys.sort()) !== canonical(["query", "requestId"])) throw failure("inventory_reporting_scope_override_denied", { statusCode: 403 });
  return { requestId: requiredText(input.requestId, "inventory_reporting_request_invalid"), query: normalizeQuery(input.query) };
}

function normalizeQuery(input) {
  const keys = ["currency", "includedStatuses", "organizationId", "outletIds", "periodEndUtc", "periodStartUtc", "policyVersion", "scopeLevel", "snapshotCutoffUtc"];
  if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input).sort()) !== canonical(keys.sort())) throw failure("inventory_reporting_request_invalid", { statusCode: 422 });
  const organizationId = uuid(input.organizationId, "inventory_reporting_request_invalid");
  const outletIds = uniqueUuids(input.outletIds);
  if (outletIds.length > 50) throw failure("inventory_reporting_request_invalid", { statusCode: 422 });
  const scopeLevel = input.scopeLevel;
  if (!new Set(["OUTLET", "COMPANY"]).has(scopeLevel) || (scopeLevel === "OUTLET" && outletIds.length !== 1)) throw failure("inventory_reporting_request_invalid", { statusCode: 422 });
  const periodStartUtc = iso(input.periodStartUtc); const periodEndUtc = iso(input.periodEndUtc); const snapshotCutoffUtc = iso(input.snapshotCutoffUtc);
  if (instantMs(periodStartUtc) >= instantMs(periodEndUtc) || instantMs(snapshotCutoffUtc) < instantMs(periodEndUtc) || input.currency !== "IDR" || canonical(input.includedStatuses) !== canonical(["POSTED"])) throw failure("inventory_reporting_request_invalid", { statusCode: 422 });
  return { organizationId, outletIds, scopeLevel, periodStartUtc, periodEndUtc, snapshotCutoffUtc, includedStatuses: ["POSTED"], currency: "IDR", policyVersion: requiredText(input.policyVersion) };
}

function normalizePolicy(input) {
  const baseKeys = ["currency", "includedStatuses", "organizationId", "outletIds", "periodEndUtc", "periodStartUtc", "policyVersion", "scopeLevel", "snapshotCutoffUtc", "usableLocationIds"];
  const keys = input && Object.hasOwn(input, "calendarLocationAuthorityBindings") ? ["calendarLocationAuthorityBindings", ...baseKeys] : baseKeys;
  if (!input || typeof input !== "object" || Array.isArray(input) || canonical(Object.keys(input).sort()) !== canonical(keys.sort())) throw failure("inventory_reporting_policy_invalid");
  const organizationId = uuid(input.organizationId, "inventory_reporting_policy_invalid");
  const outletIds = uniqueUuids(input.outletIds);
  if (outletIds.length > 50) throw failure("inventory_reporting_policy_invalid");
  const scopeLevel = input.scopeLevel;
  if (!new Set(["OUTLET", "COMPANY"]).has(scopeLevel) || (scopeLevel === "OUTLET" && outletIds.length !== 1)) throw failure("inventory_reporting_policy_invalid");
  const periodStartUtc = iso(input.periodStartUtc); const periodEndUtc = iso(input.periodEndUtc); const snapshotCutoffUtc = iso(input.snapshotCutoffUtc);
  if (instantMs(periodStartUtc) >= instantMs(periodEndUtc) || instantMs(snapshotCutoffUtc) < instantMs(periodEndUtc)) throw failure("inventory_reporting_policy_invalid");
  if (instantMs(periodEndUtc) - instantMs(periodStartUtc) > 366 * 24 * 60 * 60 * 1000) throw failure("inventory_reporting_policy_invalid");
  if (input.currency !== "IDR" || canonical(input.includedStatuses) !== canonical(["POSTED"])) throw failure("inventory_reporting_policy_invalid");
  if (!input.usableLocationIds || typeof input.usableLocationIds !== "object" || Array.isArray(input.usableLocationIds) || canonical(Object.keys(input.usableLocationIds).sort()) !== canonical([...outletIds].sort())) throw failure("inventory_reporting_policy_invalid");
  const usableLocationIds = Object.fromEntries(outletIds.map((outletId) => [outletId, requiredText(input.usableLocationIds[outletId], "inventory_reporting_policy_invalid")]));
  const suppliedBindings = input.calendarLocationAuthorityBindings ?? Object.fromEntries(outletIds.map((outletId) => [outletId, {
    revision: 1,
    fingerprint: digest({ authority: "LEGACY_EXACT_POLICY", organizationId, outletId, usableLocationId: usableLocationIds[outletId], policyVersion: input.policyVersion }),
  }]));
  if (typeof suppliedBindings !== "object" || Array.isArray(suppliedBindings)
    || canonical(Object.keys(suppliedBindings).sort()) !== canonical([...outletIds].sort())) throw failure("inventory_reporting_policy_invalid");
  const calendarLocationAuthorityBindings = Object.fromEntries(outletIds.map((outletId) => {
    const binding = suppliedBindings[outletId];
    if (!binding || typeof binding !== "object" || Array.isArray(binding) || canonical(Object.keys(binding).sort()) !== canonical(["fingerprint", "revision"])) throw failure("inventory_reporting_policy_invalid");
    return [outletId, { revision: positiveInteger(binding.revision, "inventory_reporting_policy_invalid"), fingerprint: requiredDigest(binding.fingerprint, "inventory_reporting_policy_invalid") }];
  }));
  return { organizationId, outletIds, scopeLevel, periodStartUtc, periodEndUtc, snapshotCutoffUtc, includedStatuses: ["POSTED"], currency: "IDR", policyVersion: requiredText(input.policyVersion), usableLocationIds, calendarLocationAuthorityBindings };
}

function queryFromPolicy(policy) {
  const { usableLocationIds: _locations, calendarLocationAuthorityBindings: _authority, ...query } = policy;
  return query;
}

function assertResultBounds(rows, outletCount) {
  if (!Array.isArray(rows.hppRows) || !Array.isArray(rows.catalogRows) || !Array.isArray(rows.ledgerRows) || !Array.isArray(rows.orderRows) || !Array.isArray(rows.legacyGapRows) || !Array.isArray(rows.valuationRows) || !Array.isArray(rows.planningRows) || !Array.isArray(rows.productionRows)) throw failure("inventory_reporting_postgres_result_invalid");
  if (rows.hppRows.length > outletCount || rows.catalogRows.length > outletCount || rows.planningRows.length > outletCount
    || rows.legacyGapRows.length !== outletCount || rows.ledgerRows.length > MAX_LEDGER_ROWS || rows.orderRows.length > MAX_ORDER_ROWS || rows.productionRows.length > MAX_ORDER_ROWS || rows.valuationRows.length > MAX_VALUATION_ROWS) throw failure("inventory_reporting_postgres_result_limit_exceeded", { statusCode: 413 });
}

function buildLegacyGapQualityFacts({ policy, rows }) {
  const seen = new Set();
  const facts = [];
  for (const row of rows) {
    const outletId = uuid(row?.outlet_id, "inventory_reporting_legacy_gap_scope_invalid");
    if (!policy.outletIds.includes(outletId) || seen.has(outletId)) throw failure("inventory_reporting_legacy_gap_scope_invalid");
    seen.add(outletId);
    if (nonnegativeInteger(row?.invalid_count, "inventory_reporting_legacy_gap_payload_invalid") !== 0) throw failure("inventory_reporting_legacy_gap_payload_invalid");
    const count = nonnegativeInteger(row?.gap_count, "inventory_reporting_legacy_gap_count_invalid");
    if (count > 1_001) throw failure("inventory_reporting_legacy_gap_count_invalid");
    if (count === 0) continue;
    const aggregateRef = ref("LEGACY_PAID_ORDER_GAP_AGGREGATE", digest({ organizationId: policy.organizationId, outletId, periodStartUtc: policy.periodStartUtc, periodEndUtc: policy.periodEndUtc, snapshotCutoffUtc: policy.snapshotCutoffUtc }).slice(0, 32), null);
    facts.push({
      ...quality(policy, outletId, "LEGACY_PAID_ORDER_GAP", "ERROR", aggregateRef),
      affectedCount: Math.min(count, 1_000),
      truncated: count > 1_000,
    });
  }
  if (seen.size !== policy.outletIds.length) throw failure("inventory_reporting_legacy_gap_scope_invalid");
  return facts;
}

function quality(policy, outletId, code, severity, sourceRef) {
  return { issueId: `${outletId}:${code}:${sourceRef.id}:${sourceRef.lineId ?? ""}`, organizationId: policy.organizationId, outletId, code, severity, observedAt: policy.snapshotCutoffUtc, status: "OPEN", sourceRef };
}

function deduplicateQuality(values) {
  return [...new Map(values.map((value) => [value.issueId, value])).values()];
}

function ledgerCanonical(row) {
  return [Number(row.ledger_sequence), row.movement_id, row.movement_fingerprint, Boolean(row.requires_rebuild)];
}

function ref(type, id, lineId) { return { type: sourceIdentifier(type), id: sourceIdentifier(id), lineId: lineId == null ? null : sourceIdentifier(lineId) }; }
function jsonObject(value, code) { try { const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw failure(code); } }
function jsonArray(value, code) { try { const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value ?? []); if (!Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw failure(code); } }
function modifierDimension(values) { if (!values.length) return null; const normalized = values.map((value) => ({ id: requiredText(value.id ?? value.modifierId ?? value.optionId), name: requiredText(value.name ?? value.label ?? value.optionName) })).sort(compare("id", "name")); return { id: `COMBO:${digest(normalized).slice(0, 24)}`, name: normalized.map((value) => value.name).join(" + ").slice(0, 160) }; }
function mapChannel(value) { const normalized = String(value ?? "OTHER").toUpperCase(); return new Set(["KIOSK", "CASHIER", "DELIVERY"]).has(normalized) ? normalized : "OTHER"; }
function allocateInteger(total, weights) { return allocateSignedInteger(total, weights.map((value) => BigInt(value))); }
function allocateSignedInteger(total, weights) { const amount = BigInt(total); const sign = amount < 0n ? -1n : 1n; const absolute = amount < 0n ? -amount : amount; const normalized = weights.map((value) => BigInt(value)); const denominator = normalized.reduce((sum, value) => sum + value, 0n); if (denominator === 0n) return normalized.map((_, index) => index === 0 ? Number(amount) : 0); const base = normalized.map((weight) => absolute * weight / denominator); let remainder = absolute - base.reduce((sum, value) => sum + value, 0n); for (let index = 0; remainder > 0n; index = (index + 1) % base.length) { base[index] += 1n; remainder -= 1n; } return base.map((value) => safeBigInt(value * sign)); }
function scaledMoney(units, unitCost) { return safeBigInt((units * BigInt(unitCost) + 500_000n) / 1_000_000n); }
function safeMoneyFromScaled(value) { return safeBigInt((value + 500_000n) / 1_000_000n); }
function safeMultiply(moneyValue, units) { return BigInt(moneyValue) * units; }
function multiplyUnits(left, right) { return (left * right + 500_000n) / 1_000_000n; }
function safeAdd(left, right) { const value = Number(left) + Number(right); if (!Number.isSafeInteger(value)) throw failure("inventory_reporting_amount_overflow"); return value; }
function money(value) { const number = Number(value); if (!Number.isSafeInteger(number)) throw failure("inventory_reporting_amount_invalid"); return number; }
function safeBigInt(value) { const number = Number(value); if (!Number.isSafeInteger(number)) throw failure("inventory_reporting_amount_overflow"); return number; }
function decimalUnits(value) { const text = typeof value === "number" ? value.toFixed(6) : String(value); if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(text)) throw failure("inventory_reporting_quantity_invalid"); const negative = text.startsWith("-"); const [whole, fraction = ""] = (negative ? text.slice(1) : text).split("."); const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")); return negative ? -units : units; }
function quantity(value) { return formatUnits(decimalUnits(value)); }
function formatUnits(value) { const negative = value < 0n; const absolute = negative ? -value : value; return `${negative ? "-" : ""}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`; }
function iso(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw failure("inventory_reporting_timestamp_invalid"); return date.toISOString(); }
function instantMs(value) { return Date.parse(iso(value)); }
function uuid(value, code) { if (typeof value !== "string" || !UUID.test(value)) throw failure(code); return value.toLowerCase(); }
function uniqueUuids(value) { if (!Array.isArray(value) || !value.length) throw failure("inventory_reporting_policy_invalid"); const rows = value.map((item) => uuid(item, "inventory_reporting_policy_invalid")).sort(); if (new Set(rows).size !== rows.length) throw failure("inventory_reporting_policy_invalid"); return rows; }
function requiredText(value, code = "inventory_reporting_text_invalid") { if (typeof value !== "string" || !value.trim() || value.trim().length > 160) throw failure(code); return value.trim(); }
function sourceIdentifier(value) { const result = String(value ?? "").trim(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result)) throw failure("inventory_reporting_source_resolver_invalid", { statusCode: 422 }); return result; }
function safeSourceText(value, max) { const result = String(value ?? "").replace(/[<>\u0000]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return result || "UNAVAILABLE"; }
function requiredDigest(value, code) { if (typeof value !== "string" || !DIGEST.test(value)) throw failure(code); return value; }
function positiveInteger(value, code) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw failure(code); return number; }
function nonnegativeInteger(value, code) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw failure(code); return number; }
function group(values, keyOf) { const map = new Map(); for (const value of values) { const key = keyOf(value); const rows = map.get(key) ?? []; rows.push(value); map.set(key, rows); } return map; }
function compare(...keys) { return (left, right) => { for (const key of keys) { const result = String(left[key] ?? "").localeCompare(String(right[key] ?? "")); if (result) return result; } return 0; }; }
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { if (typeof value === "bigint") return JSON.stringify(value.toString()); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function failure(code, options = {}) { return new InventoryReportingPostgresError(code, options); }
