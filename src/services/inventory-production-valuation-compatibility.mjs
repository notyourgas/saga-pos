import { InventoryValuationPostgresAdapter } from "./inventory-valuation-postgres.mjs";
import { validateInventoryReportingProductionDocument } from "./inventory-reporting-historical-authority-postgres.mjs";
import { inventoryValuationFingerprint } from "./inventory-valuation.mjs";

export const INVENTORY_PRODUCTION_VALUATION_COMPATIBILITY_CONTRACT = "SAGAPOS_INVENTORY_PRODUCTION_VALUATION_COMPATIBILITY_V1";
export const INVENTORY_PRODUCTION_ROLLBACK_MODES = Object.freeze({
  CURRENT: "SUPPORTS_PRODUCTION_TRANSFORMATION",
  READ_ONLY: "READ_ONLY_FORWARD_SCHEMA_COMPATIBILITY",
  LEGACY_READ_WRITE: "LEGACY_READ_WRITE",
});

const MAX_SCOPES = 50;
const MAX_FACTS = 100_000;
const DEFAULT_MAX_FACTS = 10_000;

export class InventoryProductionValuationCompatibilityError extends Error {
  constructor(code, assessment) {
    super(code);
    this.name = "InventoryProductionValuationCompatibilityError";
    this.code = code;
    if (assessment) this.assessment = assessment;
  }
}

export function createInventoryProductionValuationCompatibilityGuard({ db, valuationAdapter = null, maxFacts = DEFAULT_MAX_FACTS } = {}) {
  if (!db?.query || !Number.isSafeInteger(maxFacts) || maxFacts < 1 || maxFacts > MAX_FACTS) throw failure("inventory_production_valuation_compatibility_dependency_invalid");
  const adapter = valuationAdapter ?? new InventoryValuationPostgresAdapter({ db });
  if (typeof adapter?.load !== "function") throw failure("inventory_production_valuation_compatibility_dependency_invalid");

  const assess = async (input = {}) => {
    const scope = normalizeScope(input);
    const outletIds = scope.scopes.map((item) => item.outletId);
    const visible = (await db.query(
      `select id from sagaops.outlets where organization_id=$1 and id=any($2::uuid[]) order by id`,
      [scope.organizationId, outletIds],
    )).rows;
    if (visible.length !== scope.scopes.length || visible.some((row, index) => row.id !== [...outletIds].sort()[index])) {
      throw failure("inventory_production_valuation_scope_not_visible");
    }

    const reportingRows = (await db.query(
      `select organization_id,outlet_id,production_id,execution_id,fact_hash,fact_document
         from sagaops.inventory_reporting_production_facts
        where organization_id=$1 and outlet_id=any($2::uuid[])
        order by outlet_id,production_id limit $3`,
      [scope.organizationId, outletIds, maxFacts + 1],
    )).rows;
    if (reportingRows.length > maxFacts) throw failure("inventory_production_valuation_compatibility_bound_exceeded");

    const reporting = new Map();
    for (const row of reportingRows) {
      const document = validateInventoryReportingProductionDocument(jsonValue(row.fact_document));
      if (row.organization_id !== document.organizationId || row.outlet_id !== document.outletId
        || row.production_id !== document.productionId || row.execution_id !== document.executionId || row.fact_hash !== document.factHash) {
        throw failure("inventory_production_reporting_fact_tampered");
      }
      const key = productionKey(document.outletId, document.productionId);
      if (reporting.has(key)) throw failure("inventory_production_reporting_fact_ambiguous");
      reporting.set(key, document);
    }

    const transformations = new Map();
    let valuationFactCount = 0;
    for (const item of scope.scopes) {
      const aggregate = (await db.query(
        `select revision from sagaops.inventory_valuation_aggregates
          where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3`,
        [scope.organizationId, item.outletId, item.valuationScopeId],
      )).rows[0];
      const revision = aggregate ? Number(aggregate.revision) : 0;
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > maxFacts || valuationFactCount + revision > maxFacts) {
        throw failure("inventory_production_valuation_compatibility_bound_exceeded");
      }
      let loaded;
      try {
        loaded = await adapter.load({ organizationId: scope.organizationId, outletId: item.outletId, valuationScopeId: item.valuationScopeId });
      } catch {
        throw failure("inventory_production_valuation_fact_tampered");
      }
      valuationFactCount += loaded.revision;
      const productions = new Map(loaded.ledger.viewScope({ organizationId: scope.organizationId, outletId: item.outletId, valuationScopeId: item.valuationScopeId })
        .productions.map((value) => [value.productionId, value]));
      for (const fact of loaded.state.facts.filter((value) => value.type === "PRODUCTION_TRANSFORMATION")) {
        const production = productions.get(fact.request.productionId);
        if (!production || production.valuationFactId !== fact.factId) throw failure("inventory_production_valuation_fact_tampered");
        const key = productionKey(item.outletId, fact.request.productionId);
        if (transformations.has(key)) throw failure("inventory_production_valuation_fact_ambiguous");
        transformations.set(key, { fact, production, valuationScopeId: item.valuationScopeId });
      }
    }

    const operationRows = (await db.query(
      `select outlet_id,valuation_scope_id,operation_key,committed_revision,result_document,result_fingerprint
         from sagaops.inventory_valuation_operations
        where organization_id=$1 and outlet_id=any($2::uuid[])
          and result_document->'fact'->>'type'='PRODUCTION_TRANSFORMATION'
        order by outlet_id,valuation_scope_id,operation_key limit $3`,
      [scope.organizationId, outletIds, maxFacts + 1],
    )).rows;
    if (operationRows.length > maxFacts) throw failure("inventory_production_valuation_compatibility_bound_exceeded");
    const operations = new Map();
    for (const row of operationRows) {
      const result = jsonValue(row.result_document);
      const key = operationKey(row.outlet_id, row.valuation_scope_id, row.operation_key);
      if (operations.has(key) || row.result_fingerprint !== inventoryValuationFingerprint(result)) throw failure("inventory_production_valuation_operation_tampered");
      operations.set(key, { row, result });
    }

    let missingValuationCount = 0;
    let orphanValuationCount = 0;
    let parityMismatchCount = 0;
    let operationMismatchCount = 0;
    for (const [key, document] of reporting) {
      const transformation = transformations.get(key);
      if (!transformation) missingValuationCount += 1;
      else if (!productionParity(document, transformation)) parityMismatchCount += 1;
    }
    for (const key of transformations.keys()) if (!reporting.has(key)) orphanValuationCount += 1;
    for (const { fact, valuationScopeId } of transformations.values()) {
      const operation = operations.get(operationKey(fact.scope.outletId, valuationScopeId, fact.operationKey));
      if (!operation || operation.row.committed_revision !== fact.sequence
        || operation.result?.revision !== fact.sequence || operation.result?.fact?.factId !== fact.factId
        || operation.result?.fact?.factHash !== fact.factHash) operationMismatchCount += 1;
    }
    for (const operation of operations.values()) {
      const fact = operation.result?.fact;
      const transformation = fact && transformations.get(productionKey(operation.row.outlet_id, fact.request?.productionId));
      if (!transformation || transformation.fact.operationKey !== operation.row.operation_key) operationMismatchCount += 1;
    }
    const status = missingValuationCount === 0 && orphanValuationCount === 0 && parityMismatchCount === 0 && operationMismatchCount === 0 ? "READY" : "BLOCKED";
    return deepFreeze({
      contract: INVENTORY_PRODUCTION_VALUATION_COMPATIBILITY_CONTRACT,
      status,
      scopeCount: scope.scopes.length,
      reportingProductionCount: reporting.size,
      valuationTransformationCount: transformations.size,
      missingValuationCount,
      orphanValuationCount,
      parityMismatchCount,
      operationMismatchCount,
      rollbackRequirement: transformations.size === 0 ? "NONE" : "READ_ONLY_OR_TRANSFORMATION_AWARE_RUNTIME",
    });
  };

  return Object.freeze({
    assess,
    async assertReady(input) {
      const assessment = await assess(input);
      if (assessment.status !== "READY") throw failure("inventory_production_valuation_backlog_detected", assessment);
      return assessment;
    },
  });
}

export function assertInventoryProductionRollbackCompatibility({ assessment, rollbackMode } = {}) {
  if (!assessment || assessment.contract !== INVENTORY_PRODUCTION_VALUATION_COMPATIBILITY_CONTRACT || assessment.status !== "READY") {
    throw failure("inventory_production_valuation_assessment_required");
  }
  if (!Object.values(INVENTORY_PRODUCTION_ROLLBACK_MODES).includes(rollbackMode)) throw failure("inventory_production_rollback_mode_invalid");
  if (rollbackMode === INVENTORY_PRODUCTION_ROLLBACK_MODES.LEGACY_READ_WRITE && assessment.valuationTransformationCount > 0) {
    throw failure("inventory_production_rollback_read_write_incompatible", assessment);
  }
  return deepFreeze({
    ready: true,
    rollbackMode,
    businessMutationAllowed: rollbackMode !== INVENTORY_PRODUCTION_ROLLBACK_MODES.READ_ONLY,
  });
}

function normalizeScope(value) {
  if (!plain(value) || !exactKeys(value, ["organizationId", "scopes"]) || !uuid(value.organizationId)
    || !Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > MAX_SCOPES) {
    throw failure("inventory_production_valuation_scope_invalid");
  }
  const seen = new Set();
  const scopes = value.scopes.map((item) => {
    if (!plain(item) || !exactKeys(item, ["outletId", "valuationScopeId"]) || !uuid(item.outletId)
      || typeof item.valuationScopeId !== "string" || item.valuationScopeId.length < 1 || item.valuationScopeId.length > 120
      || seen.has(item.outletId.toLowerCase())) throw failure("inventory_production_valuation_scope_invalid");
    const outletId = item.outletId.toLowerCase();
    seen.add(outletId);
    return { outletId, valuationScopeId: item.valuationScopeId };
  }).sort((left, right) => left.outletId.localeCompare(right.outletId));
  return { organizationId: value.organizationId.toLowerCase(), scopes };
}

function productionParity(document, { fact, production, valuationScopeId }) {
  const expectedLoss = document.schemaVersion === 2 ? document.loss : {
    policy: "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1",
    valuationMethod: "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1",
    normalQuantityBase: subtractQuantity(document.plannedOutput.quantityBase, document.actualOutput.quantityBase),
    abnormalQuantityBase: "0.000000",
    abnormalValueRupiah: 0,
  };
  if (document.executionId !== fact.request.executionId || document.completedAt !== fact.occurredAt
    || document.completedAt !== fact.effectiveAt || document.plannedOutput.quantityBase !== fact.request.plannedOutputQuantityBase
    || document.actualOutput.locationId !== valuationScopeId || document.actualOutput.itemId !== production.output.ingredientId
    || document.actualOutput.quantityBase !== production.output.quantityBase
    || document.actualOutput.inventoryValueRupiah !== production.output.postedInventoryValueRupiah
    || fact.request.loss.policy !== expectedLoss.policy || production.loss.policy !== expectedLoss.policy
    || production.loss.normalQuantityBase !== expectedLoss.normalQuantityBase
    || production.loss.abnormalQuantityBase !== expectedLoss.abnormalQuantityBase
    || production.loss.abnormalValueRupiah !== expectedLoss.abnormalValueRupiah) return false;
  const left = document.inputs.map((line) => [line.itemId, line.locationId, line.quantityBase, line.inventoryValueRupiah]).sort(compareTuple);
  const right = production.inputs.map((line) => [line.ingredientId, valuationScopeId, line.quantityBase, line.postedInventoryValueRupiah]).sort(compareTuple);
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareTuple(left, right) { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }
function subtractQuantity(left, right) {
  const difference = decimalUnits(left) - decimalUnits(right);
  if (difference < 0n) throw failure("inventory_production_reporting_fact_tampered");
  return `${difference / 1_000_000n}.${(difference % 1_000_000n).toString().padStart(6, "0")}`;
}
function decimalUnits(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw failure("inventory_production_reporting_fact_tampered");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
function productionKey(outletId, productionId) { return `${outletId}\u0000${productionId}`; }
function operationKey(outletId, valuationScopeId, value) { return `${outletId}\u0000${valuationScopeId}\u0000${value}`; }
function jsonValue(value) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { throw failure("inventory_production_reporting_fact_tampered"); } }
function uuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) { return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function deepFreeze(value) { for (const nested of Object.values(value)) if (nested && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested); return Object.freeze(value); }
function failure(code, assessment) { return new InventoryProductionValuationCompatibilityError(code, assessment); }
