import { createHash } from "node:crypto";

import { ProductionExecutionService } from "./production-execution.mjs";

export const INVENTORY_REPORTING_HISTORICAL_AUTHORITY_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_HISTORICAL_AUTHORITY_V1";

export class InventoryReportingHistoricalAuthorityPostgres {
  constructor({ db, authorize } = {}) {
    if (!db?.transaction || typeof authorize !== "function") throw failure("inventory_reporting_historical_dependency_invalid");
    this.db = db;
    this.authorize = authorize;
  }

  async appendProductionCompletion(input = {}) {
    const document = await this.prepareProductionCompletion(input);
    return this.db.transaction((tx) => persistInventoryReportingProductionDocument(tx, document));
  }

  async prepareProductionCompletion(input = {}) {
    exact(input, ["organizationId", "outletId", "productionOrderId", "state"]);
    const organizationId = identifier(input.organizationId, "inventory_reporting_historical_scope_invalid");
    const outletId = identifier(input.outletId, "inventory_reporting_historical_scope_invalid");
    const productionOrderId = identifier(input.productionOrderId, "inventory_reporting_production_id_invalid");
    if (await this.authorize({ organizationId, outletId, action: "inventory_reporting.production.persist" }) !== true) throw failure("inventory_reporting_historical_forbidden", 403);
    return productionDocument({ organizationId, outletId, productionOrderId, state: input.state });
  }

  async appendPreparedProductionCompletion(document) {
    const validated = validateInventoryReportingProductionDocument(document);
    if (await this.authorize({ organizationId: validated.organizationId, outletId: validated.outletId, action: "inventory_reporting.production.persist" }) !== true) {
      throw failure("inventory_reporting_historical_forbidden", 403);
    }
    return this.db.transaction((tx) => persistInventoryReportingProductionDocument(tx, validated));
  }
}

export async function persistInventoryReportingProductionDocument(tx, value) {
  if (!tx?.query) throw failure("inventory_reporting_historical_dependency_invalid");
  const document = validateInventoryReportingProductionDocument(value);
  const inserted = await tx.query(`insert into sagaops.inventory_reporting_production_facts(
    organization_id,outlet_id,production_id,execution_id,source_state_revision,source_state_hash,
    source_execution_hash,fact_hash,fact_document,completed_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
    on conflict(organization_id,outlet_id,production_id) do nothing returning fact_hash`, [
    document.organizationId, document.outletId, document.productionId, document.executionId, document.sourceStateRevision,
    document.sourceStateHash, document.sourceExecutionHash, document.factHash, JSON.stringify(document), document.completedAt,
  ]);
  if (inserted.rows[0]) return Object.freeze({ idempotentReplay: false, productionId: document.productionId, factHash: document.factHash });
  const existing = await tx.query(`select fact_hash from sagaops.inventory_reporting_production_facts
    where organization_id=$1 and outlet_id=$2 and production_id=$3`, [document.organizationId, document.outletId, document.productionId]);
  if (existing.rows[0]?.fact_hash !== document.factHash) throw failure("inventory_reporting_production_fact_conflict", 409);
  return Object.freeze({ idempotentReplay: true, productionId: document.productionId, factHash: document.factHash });
}

export function createInventoryReportingAwareProductionExecution(input = {}) {
  exact(input, ["authorize", "db", "production"]);
  const { db, authorize, production } = input;
  if (!production || typeof production !== "object" || Array.isArray(production) || Object.hasOwn(production, "completionHistoryPort")) throw failure("inventory_reporting_production_composition_invalid", 422);
  const { initialState = null, statePort = null, ...serviceOptions } = production;
  if (statePort !== null && typeof statePort?.save !== "function") throw failure("inventory_reporting_production_state_port_invalid", 422);
  const historicalAuthority = new InventoryReportingHistoricalAuthorityPostgres({ db, authorize });
  const enhancedDurability = statePort !== null && typeof statePort?.commitCompletion === "function";
  const collector = enhancedDurability ? completionHistoryCollector(historicalAuthority) : null;
  const core = new ProductionExecutionService({ ...serviceOptions, completionHistoryPort: collector ?? historicalAuthority });
  if (initialState !== null) core.restoreState(structuredClone(initialState));
  const service = statePort === null ? core : durableService(core, statePort, { historicalAuthority, collector });
  return Object.freeze({ service, historicalAuthority });
}

function durableService(core, statePort, { historicalAuthority, collector }) {
  let queue = Promise.resolve();
  const run = (operation) => {
    const next = queue.then(operation, operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const invoke = (method, input) => run(async () => {
    const before = core.exportState();
    let completionCommitAttempted = false;
    let canonicalRestored = false;
    try {
      if (method === "complete" && collector) {
        collector.begin();
        statePort.beginCompletion?.();
      }
      const result = await core[method](input);
      const state = core.exportState();
      if (method === "complete" && collector) {
        const fact = collector.take();
        if (result.idempotentReplay) await historicalAuthority.appendPreparedProductionCompletion(fact);
        else {
          completionCommitAttempted = true;
          await statePort.commitCompletion({ state, result, fact });
        }
      } else await statePort.save(state);
      return result;
    } catch (error) {
      if (method === "complete" && collector && completionCommitAttempted && completionRecoveryRequired(error)
        && typeof statePort.recoverCompletion === "function" && typeof statePort.applyCompletionRecovery === "function") {
        try {
          collector.reset();
          statePort.abortCompletion?.();
          const recovered = await statePort.recoverCompletion({ input, error });
          core.restoreState(structuredClone(recovered.state));
          statePort.applyCompletionRecovery(recovered);
          canonicalRestored = true;
          if (recovered.proofError || !recovered.fact) throw failure(recovered.proofError ?? "production_execution_completion_recovery_unproven", 409);
          collector.begin();
          const replay = await core.complete(input);
          const replayFact = collector.take();
          if (!replay.idempotentReplay || replayFact.factHash !== recovered.fact.factHash) {
            throw failure("production_execution_completion_recovery_unproven", 409);
          }
          return replay;
        } catch (recoveryError) {
          if (canonicalRestored) {
            throw annotatedError(recoveryError, { commitError: error });
          }
          error = annotatedError(error, { recoveryError });
        }
      }
      if (!canonicalRestored) try { core.restoreState(before); } catch (rollbackError) { error = annotatedError(error, { rollbackError }); }
      throw error;
    } finally {
      if (method === "complete" && collector) {
        collector.reset();
        statePort.abortCompletion?.();
      }
    }
  });
  return Object.freeze({
    plan: (input) => invoke("plan", input),
    complete: (input) => invoke("complete", input),
    cancel: (input) => invoke("cancel", input),
    expire: (input) => invoke("expire", input),
    view: () => core.view(),
    exportState: () => core.exportState(),
  });
}

function completionHistoryCollector(authority) {
  let active = false;
  let document = null;
  return Object.freeze({
    begin() {
      if (active) throw failure("inventory_reporting_production_completion_overlap", 409);
      active = true;
      document = null;
    },
    async appendProductionCompletion(input) {
      if (!active || document !== null) throw failure("inventory_reporting_production_completion_history_invalid", 500);
      document = await authority.prepareProductionCompletion(input);
    },
    take() {
      if (!active || document === null) throw failure("inventory_reporting_production_completion_history_missing", 500);
      return structuredClone(document);
    },
    reset() { active = false; document = null; },
  });
}

export function validateInventoryReportingProductionDocument(value) {
  const version = Number(value?.schemaVersion);
  exact(value, version === 2
    ? ["actualOutput", "completedAt", "executionId", "factHash", "inputs", "loss", "organizationId", "outletId", "plannedOutput", "productionId", "schemaVersion", "sourceExecutionHash", "sourceStateHash", "sourceStateRevision"]
    : ["actualOutput", "completedAt", "executionId", "factHash", "inputs", "organizationId", "outletId", "plannedOutput", "productionId", "schemaVersion", "sourceExecutionHash", "sourceStateHash", "sourceStateRevision"]);
  if (![1, 2].includes(version)) throw failure("inventory_reporting_production_fact_invalid");
  const normalized = {
    schemaVersion: version,
    organizationId: identifier(value.organizationId, "inventory_reporting_production_fact_invalid"),
    outletId: identifier(value.outletId, "inventory_reporting_production_fact_invalid"),
    productionId: identifier(value.productionId, "inventory_reporting_production_fact_invalid"),
    executionId: identifier(value.executionId, "inventory_reporting_production_fact_invalid"),
    sourceStateRevision: positiveInteger(value.sourceStateRevision),
    sourceStateHash: digestText(value.sourceStateHash),
    sourceExecutionHash: digestText(value.sourceExecutionHash),
    completedAt: timestamp(value.completedAt),
    plannedOutput: plannedOutput(value.plannedOutput),
    actualOutput: output(value.actualOutput),
    inputs: inputs(value.inputs),
    ...(version === 2 ? { loss: productionLoss(value.loss) } : {}),
  };
  if (normalized.plannedOutput.itemId !== normalized.actualOutput.itemId || normalized.plannedOutput.locationId !== normalized.actualOutput.locationId) throw failure("inventory_reporting_production_output_ambiguous");
  const inputValueRupiah = normalized.inputs.reduce((sum, line) => safeAdd(sum, line.inventoryValueRupiah), 0);
  if (version === 1 ? inputValueRupiah !== normalized.actualOutput.inventoryValueRupiah
    : inputValueRupiah !== safeAdd(normalized.actualOutput.inventoryValueRupiah, normalized.loss.abnormalValueRupiah)) throw failure("inventory_reporting_production_value_unbalanced");
  if (version === 2 && productionAbnormalLossValue(inputValueRupiah, normalized.actualOutput.quantityBase, normalized.loss.abnormalQuantityBase) !== normalized.loss.abnormalValueRupiah) throw failure("inventory_reporting_production_loss_authority_mismatch");
  if (version === 2) {
    const plannedUnits = decimalUnits(normalized.plannedOutput.quantityBase);
    const actualUnits = decimalUnits(normalized.actualOutput.quantityBase);
    const shortfallUnits = plannedUnits > actualUnits ? plannedUnits - actualUnits : 0n;
    if (decimalUnits(normalized.loss.normalQuantityBase) + decimalUnits(normalized.loss.abnormalQuantityBase) !== shortfallUnits) throw failure("inventory_reporting_production_loss_quantity_unbalanced");
  }
  const factHash = digest(normalized);
  if (value.factHash !== factHash) throw failure("inventory_reporting_production_fact_tampered");
  return Object.freeze({ ...normalized, factHash });
}

function productionDocument({ organizationId, outletId, productionOrderId, state }) {
  const restored = new ProductionExecutionService({
    tenantId: organizationId,
    outletId,
    inventoryPort: { transact: async () => { throw failure("inventory_reporting_production_write_denied"); } },
    recipeSnapshotProvider: () => null,
  });
  restored.restoreState(structuredClone(state));
  const matches = state.operations.filter((operation) => operation?.result?.execution?.productionOrderId === productionOrderId);
  if (matches.length !== 1) throw failure("inventory_reporting_production_completion_ambiguous");
  const execution = matches[0].result.execution;
  if (execution.productionOrderId !== productionOrderId || execution.tenantId !== organizationId || execution.outletId !== outletId) throw failure("inventory_reporting_production_scope_mismatch");
  const allocationsByItem = new Map();
  for (const allocation of execution.inputLotAllocations) {
    const itemId = identifier(allocation.itemId, "inventory_reporting_production_input_invalid");
    const current = allocationsByItem.get(itemId) ?? { quantityUnits: 0n, valueRupiah: 0 };
    current.quantityUnits += decimalUnits(allocation.normalizedQuantity);
    current.valueRupiah = safeAdd(current.valueRupiah, rupiah(allocation.consumedValueRupiah));
    allocationsByItem.set(itemId, current);
  }
  const actualInputs = execution.actualInputs.map((line) => {
    const itemId = identifier(line.itemId, "inventory_reporting_production_input_invalid");
    const allocation = allocationsByItem.get(itemId);
    const quantityUnits = decimalUnits(line.normalizedQuantity);
    if (!allocation || allocation.quantityUnits !== quantityUnits) throw failure("inventory_reporting_production_input_ambiguous");
    allocationsByItem.delete(itemId);
    return { itemId, locationId: identifier(execution.inputLocationId, "inventory_reporting_production_input_invalid"), quantityBase: formatUnits(quantityUnits), inventoryValueRupiah: allocation.valueRupiah };
  });
  if (allocationsByItem.size) throw failure("inventory_reporting_production_input_ambiguous");
  const inputValue = actualInputs.reduce((sum, line) => safeAdd(sum, line.inventoryValueRupiah), 0);
  const hasLossAuthority = execution.lossPolicy === "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1"
    && execution.lossValuationPolicy === "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1"
    && Number.isSafeInteger(execution.abnormalLossValueRupiah) && execution.actualOutputInventoryValueRupiah !== undefined;
  const outputValue = rupiah(hasLossAuthority ? execution.actualOutputInventoryValueRupiah : execution.actualConsumedValueRupiah);
  const loss = hasLossAuthority ? {
    policy: execution.lossPolicy,
    valuationMethod: execution.lossValuationPolicy,
    normalQuantityBase: nonnegativeQuantity(execution.yield?.normalLossQuantity),
    abnormalQuantityBase: nonnegativeQuantity(execution.yield?.abnormalWasteQuantity),
    abnormalValueRupiah: nonnegativeMoney(execution.abnormalLossValueRupiah),
  } : null;
  if (hasLossAuthority
    ? inputValue !== safeAdd(outputValue, loss.abnormalValueRupiah)
      || productionAbnormalLossValue(inputValue, quantity(execution.actualOutput.usableQuantity), loss.abnormalQuantityBase) !== loss.abnormalValueRupiah
    : inputValue !== outputValue) throw failure("inventory_reporting_production_value_unbalanced");
  const body = {
    schemaVersion: hasLossAuthority ? 2 : 1,
    organizationId,
    outletId,
    productionId: productionOrderId,
    executionId: identifier(execution.id, "inventory_reporting_production_execution_invalid"),
    sourceStateRevision: positiveInteger(state.revision),
    sourceStateHash: digestText(state.stateHash),
    sourceExecutionHash: digestText(execution.hash),
    completedAt: timestamp(execution.completedAt),
    plannedOutput: { itemId: identifier(execution.plannedOutput.itemId), locationId: identifier(execution.outputLocationId), quantityBase: quantity(execution.plannedOutput.quantity) },
    actualOutput: { itemId: identifier(execution.actualOutput.itemId), locationId: identifier(execution.outputLocationId), quantityBase: quantity(execution.actualOutput.usableQuantity), inventoryValueRupiah: outputValue },
    inputs: actualInputs.sort(compare("itemId", "locationId")),
    ...(hasLossAuthority ? { loss } : {}),
  };
  return validateInventoryReportingProductionDocument({ ...body, factHash: digest(body) });
}

function output(value) {
  exact(value, ["inventoryValueRupiah", "itemId", "locationId", "quantityBase"]);
  return { itemId: identifier(value.itemId), locationId: identifier(value.locationId), quantityBase: positiveQuantity(value.quantityBase), inventoryValueRupiah: nonnegativeMoney(value.inventoryValueRupiah) };
}

function productionLoss(value) {
  exact(value, ["abnormalQuantityBase", "abnormalValueRupiah", "normalQuantityBase", "policy", "valuationMethod"]);
  if (value.policy !== "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1"
    || value.valuationMethod !== "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1") throw failure("inventory_reporting_production_loss_invalid");
  const normalQuantityBase = nonnegativeQuantity(value.normalQuantityBase);
  const abnormalQuantityBase = nonnegativeQuantity(value.abnormalQuantityBase);
  const abnormalValueRupiah = nonnegativeMoney(value.abnormalValueRupiah);
  if (decimalUnits(abnormalQuantityBase) === 0n && abnormalValueRupiah !== 0) throw failure("inventory_reporting_production_loss_invalid");
  return { policy: value.policy, valuationMethod: value.valuationMethod, normalQuantityBase, abnormalQuantityBase, abnormalValueRupiah };
}

function plannedOutput(value) {
  exact(value, ["itemId", "locationId", "quantityBase"]);
  return { itemId: identifier(value.itemId), locationId: identifier(value.locationId), quantityBase: positiveQuantity(value.quantityBase) };
}

function inputs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw failure("inventory_reporting_production_input_invalid");
  const seen = new Set();
  return value.map((line) => {
    const result = output(line);
    if (seen.has(result.itemId)) throw failure("inventory_reporting_production_input_ambiguous");
    seen.add(result.itemId);
    return result;
  }).sort(compare("itemId", "locationId"));
}

function exact(value, keys) { if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure("inventory_reporting_historical_input_invalid", 422); }
function identifier(value, code = "inventory_reporting_identifier_invalid") { const result = String(value ?? "").trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw failure(code); return result; }
function digestText(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure("inventory_reporting_digest_invalid"); return value; }
function timestamp(value) { const date = new Date(value); if (Number.isNaN(date.getTime())) throw failure("inventory_reporting_timestamp_invalid"); return date.toISOString(); }
function positiveInteger(value) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw failure("inventory_reporting_revision_invalid"); return result; }
function nonnegativeMoney(value) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw failure("inventory_reporting_money_invalid"); return result; }
function rupiah(value) { const text = String(value); if (!/^\d+(?:\.0{1,6})?$/.test(text)) throw failure("inventory_reporting_production_value_precision_unavailable"); return nonnegativeMoney(text.split(".")[0]); }
function decimalUnits(value) { const text = String(value); if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw failure("inventory_reporting_quantity_invalid"); const [whole, fraction = ""] = text.split("."); return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0")); }
function positiveQuantity(value) { const result = decimalUnits(value); if (result <= 0n) throw failure("inventory_reporting_quantity_invalid"); return formatUnits(result); }
function nonnegativeQuantity(value) { const result = decimalUnits(value); if (result < 0n) throw failure("inventory_reporting_quantity_invalid"); return formatUnits(result); }
function quantity(value) { return positiveQuantity(value); }
function formatUnits(value) { return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, "0")}`; }
function safeAdd(left, right) { const value = left + right; if (!Number.isSafeInteger(value)) throw failure("inventory_reporting_money_invalid"); return value; }
function productionAbnormalLossValue(inputValueRupiah, outputQuantityBase, abnormalQuantityBase) {
  const abnormalUnits = decimalUnits(abnormalQuantityBase);
  if (abnormalUnits === 0n) return 0;
  const denominator = decimalUnits(outputQuantityBase) + abnormalUnits;
  const numerator = BigInt(inputValueRupiah) * abnormalUnits;
  const value = numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("inventory_reporting_money_invalid");
  return Number(value);
}
function compare(...keys) { return (left, right) => { for (const key of keys) { const result = String(left[key] ?? "").localeCompare(String(right[key] ?? "")); if (result) return result; } return 0; }; }
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function completionRecoveryRequired(error) { return error?.productionCommitOutcome === "UNKNOWN" || error?.code === "hpp_persistence_version_conflict" || error?.message === "hpp_persistence_version_conflict"; }
function annotatedError(source, annotations) {
  const message = source instanceof Error ? source.message : String(source ?? "inventory_reporting_production_error");
  const error = new Error(message, source instanceof Error ? { cause: source } : undefined);
  error.name = source?.name ?? "Error";
  for (const key of ["code", "status", "statusCode", "productionCommitOutcome"]) if (source?.[key] !== undefined) error[key] = source[key];
  Object.assign(error, annotations);
  return error;
}
function failure(code, statusCode = 500) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
