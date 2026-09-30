import { createHash } from "node:crypto";

export const INVENTORY_REPORTING_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_B20_V1";
export const INVENTORY_REPORTING_SOURCE_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_SOURCE_V1";
export const INVENTORY_METRIC_DICTIONARY_VERSION = "SAGAPOS_INVENTORY_METRICS_2026_09_V1";

const SCALE = 1_000_000n;
const POSTED = "POSTED";
const MOVEMENT_KINDS = new Set([
  "PURCHASE_RECEIPT", "SUPPLIER_RETURN", "SALE_CONSUMPTION", "WASTE", "ADJUSTMENT",
  "TRANSFER_OUT", "TRANSFER_IN", "PRODUCTION_INPUT", "PRODUCTION_OUTPUT",
]);
const TRANSFER_KINDS = new Set(["TRANSFER_OUT", "TRANSFER_IN"]);
const PRODUCTION_KINDS = new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]);
const CHANNELS = new Set(["KIOSK", "CASHIER", "DELIVERY", "OTHER"]);
const MAX_COMPANY_OUTLETS = 50;

export const INVENTORY_METRIC_DICTIONARY = deepFreeze({
  version: INVENTORY_METRIC_DICTIONARY_VERSION,
  intervalBoundary: "START_INCLUSIVE_END_EXCLUSIVE",
  currency: "IDR",
  quantityScale: 6,
  metrics: {
    "inventory.stock.closing_quantity": metric("Opening quantity plus posted movement quantity through period end.", "OUTLET_ITEM_LOCATION", "EFFECTIVE_AT", ["POSTED movements"], ["draft/void movements"], "movementFacts"),
    "inventory.stock.closing_value": metric("Opening inventory value plus posted movement value through period end.", "OUTLET_ITEM_LOCATION", "EFFECTIVE_AT", ["POSTED movements"], ["draft/void movements"], "movementFacts"),
    "inventory.cost.current_recipe_hpp": metric("Current approved recipe cost at the report cutoff; never summed from historical transaction rows.", "CURRENT_RECIPE_VERSION", "SNAPSHOT_CUTOFF", ["one current recipe-cost fact per outlet and menu variant"], ["historical transaction snapshots", "incomplete cost"], "recipeCostFacts"),
    "inventory.cost.transaction_hpp": metric("Immutable recipe/HPP snapshot stored on each physical sale line, including remake production starts.", "SALE_LINE", "TRANSACTION_AT", ["complete-cost sale facts"], ["incomplete cost"], "saleFacts"),
    "inventory.cogs.theoretical": metric("Recipe-theoretical sales cost at the sale-line grain.", "SALE_LINE", "TRANSACTION_AT", ["complete-cost sale facts"], ["incomplete cost"], "saleFacts"),
    "inventory.cogs.posted": metric("Immutable COGS posted when inventory consumption occurred.", "SALE_LINE", "TRANSACTION_AT", ["posted consumption facts"], ["unposted and incomplete cost"], "saleFacts"),
    "inventory.cogs.adjusted": metric("Posted COGS plus immutable later cost adjustments.", "SALE_LINE", "TRANSACTION_AT", ["posted COGS and adjustments"], ["incomplete cost"], "saleFacts"),
    "inventory.usage.recorded": metric("Physical usage recorded by the inventory ledger, excluding separately classified waste.", "ITEM_PERIOD", "EFFECTIVE_AT", ["recorded consumption"], ["waste and unexplained count variance"], "varianceFacts"),
    "inventory.usage.count_actual": metric("Usage derived from opening, posted flows, and closing physical count.", "ITEM_PERIOD", "COUNT_AT", ["valid count-pair facts"], ["periods without a valid count pair"], "varianceFacts"),
    "inventory.variance.waterfall_quantity": metric("Theoretical plus usage, yield, waste, and unexplained quantity equals count-derived actual.", "ITEM_PERIOD", "PERIOD", ["complete quantity facts"], ["cross-unit aggregation"], "varianceFacts"),
    "inventory.variance.waterfall_value": metric("Theoretical plus usage, purchase-price, yield, waste, and unexplained value equals count-derived actual.", "ITEM_PERIOD", "PERIOD", ["complete value facts"], ["incomplete cost"], "varianceFacts"),
    "inventory.transfer.company_net": metric("Paired internal transfer-in and transfer-out net at company scope without becoming consumption.", "TRANSFER", "EFFECTIVE_AT", ["matched posted transfer pairs"], ["unmatched company transfer"], "movementFacts"),
    "inventory.production.transform": metric("Production inputs and outputs remain a transformation group; only yield variance is variance.", "PRODUCTION_RUN", "EFFECTIVE_AT", ["posted production movements"], ["unmatched production movement"], "movementFacts/productionFacts"),
    "inventory.profitability.margin": metric("Net menu revenue less adjusted COGS for complete-cost sale lines only.", "MENU_VARIANT_MODIFIER_CHANNEL", "TRANSACTION_AT", ["complete-cost paid sale lines"], ["incomplete cost sale lines"], "saleFacts"),
    "inventory.supplier.scorecard": metric("Accepted/rejected quantity and on-time delivery from supplier source documents.", "SUPPLIER_PERIOD", "EFFECTIVE_AT", ["posted supplier facts"], ["incomplete supplier facts"], "supplierFacts"),
    "inventory.replenishment.recommendation": metric("Projected shortage and recommendation from the versioned planning source.", "ITEM_LOCATION", "OBSERVED_AT", ["current posted planning facts"], ["stale/unapproved planning facts"], "replenishmentFacts"),
    "inventory.data_quality.issue": metric("Fail-closed source, cost, scope, and reconciliation issues.", "SOURCE_FACT", "OBSERVED_AT", ["explicit issues and generated exclusions"], [], "qualityFacts/source validation"),
  },
});

export const INVENTORY_REPORT_FAMILY_REGISTRY = deepFreeze({
  version: "SAGAPOS_INVENTORY_REPORT_FAMILIES_2026_09_V1",
  families: {
    stockBalance: { path: "reports.stockBalance", metricIds: ["inventory.stock.closing_quantity"] },
    stockCard: { path: "reports.stockCard", metricIds: ["inventory.stock.closing_quantity", "inventory.stock.closing_value"] },
    stockValuation: { path: "reports.stockValuation", metricIds: ["inventory.stock.closing_value"] },
    costHppCogs: { path: "costLayers", metricIds: ["inventory.cost.current_recipe_hpp", "inventory.cost.transaction_hpp", "inventory.cogs.theoretical", "inventory.cogs.posted", "inventory.cogs.adjusted"] },
    wasteShrinkage: { path: "reports.wasteShrinkage", metricIds: ["inventory.variance.waterfall_quantity"] },
    ingredientTheoreticalActual: { path: "varianceWaterfalls", metricIds: ["inventory.usage.recorded", "inventory.usage.count_actual", "inventory.variance.waterfall_quantity", "inventory.variance.waterfall_value"] },
    profitability: { path: "reports.profitability", metricIds: ["inventory.profitability.margin"] },
    supplierScorecard: { path: "reports.supplierScorecard", metricIds: ["inventory.supplier.scorecard"] },
    production: { path: "reports.production", metricIds: ["inventory.production.transform"] },
    forecastReplenishment: { path: "reports.forecastReplenishment", metricIds: ["inventory.replenishment.recommendation"] },
    dataQuality: { path: "reports.dataQuality", metricIds: ["inventory.data_quality.issue"] },
  },
});

export class InventoryReportingError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = "InventoryReportingError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function sealInventoryReportingSource(input = {}) {
  const normalized = normalizeSource(input, false);
  return deepFreeze({ ...normalized, sourceFingerprint: sha256(normalized) });
}

export function buildInventoryReportingProjection({ query: rawQuery, source: rawSource } = {}) {
  const query = normalizeQuery(rawQuery);
  const source = normalizeSource(rawSource, true);
  assertSourceFilter(query, source.appliedFilter);
  assertFactScopes(query, source);

  const movement = buildMovementReports(query, source.movementFacts);
  const variance = buildVarianceReports(source.varianceFacts);
  const legacyGapCompleteness = summarizeLegacyPaidOrderGaps(source.qualityFacts);
  const profitability = buildProfitability(source.saleFacts, legacyGapCompleteness);
  const suppliers = buildSupplierScorecard(source.supplierFacts);
  const production = buildProductionReport(source.productionFacts, movement.productionGroups);
  const replenishment = buildReplenishmentReport(source.replenishmentFacts);
  const dataQuality = buildDataQuality(source.qualityFacts, profitability.excludedIncomplete, movement.negativeBalances, variance.incompleteSourceRefs, movement.transferIssues);
  const costLayers = buildCostLayers(query, source.recipeCostFacts, source.saleFacts, legacyGapCompleteness);
  const drilldowns = buildDrilldowns({ source, movement, variance, profitability, suppliers, production, replenishment, dataQuality, legacyGapCompleteness });

  const projection = {
    contract: INVENTORY_REPORTING_CONTRACT,
    version: 1,
    metricDictionaryVersion: INVENTORY_METRIC_DICTIONARY.version,
    reportFamilyRegistryVersion: INVENTORY_REPORT_FAMILY_REGISTRY.version,
    query,
    sourceFingerprint: source.sourceFingerprint,
    status: dataQuality.issues.length ? "PARTIAL" : "COMPLETE",
    reports: {
      stockBalance: movement.stockBalance,
      stockCard: movement.stockCard,
      stockValuation: movement.stockValuation,
      wasteShrinkage: { movements: movement.wasteMovements, variance: variance.wasteShrinkage },
      profitability,
      supplierScorecard: suppliers,
      production,
      forecastReplenishment: replenishment,
      dataQuality,
    },
    costLayers,
    usage: variance.usage,
    varianceWaterfalls: variance.waterfalls,
    companyFlow: {
      internalTransfers: movement.internalTransfers,
      productionTransformations: production.transformations,
      finalConsumptionValueRupiah: movement.finalConsumptionValueRupiah,
    },
    drilldowns,
  };
  const reportFingerprint = sha256(projection);
  return deepFreeze({ ...projection, reportFingerprint });
}

export function restoreInventoryReportingProjection({ query, source, projection } = {}) {
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw failure("inventory_reporting_projection_invalid");
  const rebuilt = buildInventoryReportingProjection({ query, source });
  if (canonical(rebuilt) !== canonical(projection)) throw failure("inventory_reporting_projection_tampered");
  return rebuilt;
}

function buildMovementReports(query, facts) {
  const balances = new Map();
  const periodFacts = [];
  const transferGroups = new Map();
  const productionGroups = new Map();
  const wasteMovements = [];
  let finalConsumptionValue = 0n;
  for (const fact of facts) {
    const at = Date.parse(fact.effectiveAt);
    const start = Date.parse(query.periodStartUtc);
    const end = Date.parse(query.periodEndUtc);
    const key = `${fact.outletId}\u0000${fact.itemId}\u0000${fact.locationId}`;
    const row = balances.get(key) ?? {
      outletId: fact.outletId, itemId: fact.itemId, locationId: fact.locationId,
      openingQuantityUnits: 0n, openingValue: 0n, periodQuantityUnits: 0n, periodValue: 0n,
      sourceRefs: [],
    };
    const quantity = parseQuantity(fact.quantityDeltaBase, "inventory_reporting_movement_quantity_invalid");
    const value = BigInt(fact.inventoryValueDeltaRupiah);
    if (at < start) {
      row.openingQuantityUnits += quantity;
      row.openingValue += value;
    } else if (at < end) {
      row.periodQuantityUnits += quantity;
      row.periodValue += value;
      row.sourceRefs.push(fact.sourceRef);
      periodFacts.push(fact);
      if (fact.movementKind === "WASTE") wasteMovements.push(stockCardRow(fact));
      if (["SALE_CONSUMPTION", "WASTE"].includes(fact.movementKind)) finalConsumptionValue += -value;
      if (TRANSFER_KINDS.has(fact.movementKind)) appendMap(transferGroups, `${fact.transferId}\u0000${fact.itemId}`, fact);
      if (PRODUCTION_KINDS.has(fact.movementKind)) appendMap(productionGroups, fact.productionId, fact);
    }
    balances.set(key, row);
  }

  const stockBalance = [...balances.values()].map((row) => {
    const closingQuantity = row.openingQuantityUnits + row.periodQuantityUnits;
    const closingValue = row.openingValue + row.periodValue;
    return {
      outletId: row.outletId, itemId: row.itemId, locationId: row.locationId,
      openingQuantityBase: formatQuantity(row.openingQuantityUnits),
      openingValueRupiah: safeMoney(row.openingValue),
      periodNetQuantityBase: formatQuantity(row.periodQuantityUnits),
      periodNetValueRupiah: safeMoney(row.periodValue),
      closingQuantityBase: formatQuantity(closingQuantity),
      closingValueRupiah: safeMoney(closingValue),
      requiresReview: closingQuantity < 0n || closingValue < 0n,
      sourceRefs: uniqueRefs(row.sourceRefs),
    };
  }).sort(compareKeys("outletId", "itemId", "locationId"));

  const stockValuation = stockBalance.map((row) => ({
    outletId: row.outletId, itemId: row.itemId, locationId: row.locationId,
    quantityBase: row.closingQuantityBase,
    inventoryValueRupiah: row.closingValueRupiah,
    averageCostPerBaseUnitRupiah: averageUnitCost(row.closingValueRupiah, parseQuantity(row.closingQuantityBase)),
    costComplete: !row.requiresReview,
    sourceRefs: row.sourceRefs,
  }));

  const transferResults = [...transferGroups.values()].map((rows) => query.scopeLevel === "COMPANY"
    ? validateCompanyTransferGroup(rows)
    : validateOutletTransferGroup(rows));
  const internalTransfers = transferResults.flatMap((result) => result.transfer ? [result.transfer] : []);
  const transferIssues = transferResults.flatMap((result) => result.issue ? [result.issue] : []);
  const negativeBalances = stockBalance.filter((row) => row.requiresReview).map((row) => ({
    code: "NEGATIVE_OR_INVALID_CLOSING_BALANCE", severity: "ERROR", sourceRefs: row.sourceRefs,
  }));
  return {
    stockBalance,
    stockCard: periodFacts.map(stockCardRow).sort(compareKeys("effectiveAt", "factId")),
    stockValuation,
    wasteMovements: wasteMovements.sort(compareKeys("effectiveAt", "factId")),
    internalTransfers: internalTransfers.sort(compareKeys("transferId", "itemId")),
    transferIssues: transferIssues.sort(compareKeys("code", "issueId")),
    productionGroups,
    negativeBalances,
    finalConsumptionValueRupiah: safeMoney(finalConsumptionValue),
  };
}

function buildVarianceReports(facts) {
  const groups = new Map();
  for (const fact of facts) appendMap(groups, fact.itemId, fact);
  const rows = [...groups.entries()].map(([itemId, itemFacts]) => buildItemVariance(itemId, itemFacts)).sort(compareKeys("itemId"));
  return {
    usage: rows.map((row) => row.usage),
    waterfalls: rows.map((row) => row.waterfalls),
    wasteShrinkage: rows.map((row) => row.wasteShrinkage),
    incompleteSourceRefs: uniqueRefs(rows.flatMap((row) => row.incompleteSourceRefs)),
  };
}

function buildItemVariance(itemId, facts) {
  let theoreticalQ = 0n; let recordedQ = 0n; let actualQ = 0n; let yieldQ = 0n; let wasteQ = 0n;
  let theoreticalV = 0n; let recordedCurrentV = 0n; let recordedV = 0n; let actualV = 0n; let yieldV = 0n; let wasteV = 0n;
  const quantityRefs = []; const valueRefs = []; const incompleteSourceRefs = [];
  for (const fact of facts) {
    theoreticalQ += parseQuantity(fact.theoreticalUsageQuantityBase);
    recordedQ += parseQuantity(fact.recordedUsageQuantityBase);
    actualQ += parseQuantity(fact.countDerivedActualQuantityBase);
    yieldQ += parseQuantity(fact.yieldVarianceQuantityBase);
    wasteQ += parseQuantity(fact.wasteQuantityBase);
    quantityRefs.push(fact.sourceRef);
    if (!fact.costComplete) { incompleteSourceRefs.push(fact.sourceRef); continue; }
    theoreticalV += BigInt(fact.theoreticalUsageValueRupiah);
    recordedCurrentV += BigInt(fact.recordedUsageAtCurrentCostRupiah);
    recordedV += BigInt(fact.recordedUsageValueRupiah);
    actualV += BigInt(fact.countDerivedActualValueRupiah);
    yieldV += BigInt(fact.yieldVarianceValueRupiah);
    wasteV += BigInt(fact.wasteValueRupiah);
    valueRefs.push(fact.sourceRef);
  }
  const usageQ = recordedQ - theoreticalQ;
  const unexplainedQ = actualQ - recordedQ - yieldQ - wasteQ;
  const quantityComponents = [
    component("THEORETICAL", theoreticalQ, quantityRefs), component("USAGE", usageQ, quantityRefs),
    component("PURCHASE_PRICE", 0n, quantityRefs), component("YIELD", yieldQ, quantityRefs),
    component("WASTE", wasteQ, quantityRefs), component("UNEXPLAINED", unexplainedQ, quantityRefs),
  ];
  if (quantityComponents.reduce((sum, item) => sum + parseQuantity(item.amount), 0n) !== actualQ) throw failure("inventory_reporting_quantity_waterfall_unbalanced");

  let value = null;
  if (incompleteSourceRefs.length === 0) {
    const usageV = recordedCurrentV - theoreticalV;
    const priceV = recordedV - recordedCurrentV;
    const unexplainedV = actualV - recordedV - yieldV - wasteV;
    const components = [
      moneyComponent("THEORETICAL", theoreticalV, valueRefs), moneyComponent("USAGE", usageV, valueRefs),
      moneyComponent("PURCHASE_PRICE", priceV, valueRefs), moneyComponent("YIELD", yieldV, valueRefs),
      moneyComponent("WASTE", wasteV, valueRefs), moneyComponent("UNEXPLAINED", unexplainedV, valueRefs),
    ];
    if (components.reduce((sum, item) => sum + BigInt(item.amountRupiah), 0n) !== actualV) throw failure("inventory_reporting_value_waterfall_unbalanced");
    value = { status: "COMPLETE", actualValueRupiah: safeMoney(actualV), components, sourceRefs: uniqueRefs(valueRefs) };
  } else {
    value = { status: "INCOMPLETE", actualValueRupiah: null, components: [], sourceRefs: uniqueRefs(incompleteSourceRefs) };
  }
  return {
    usage: {
      itemId,
      theoreticalQuantityBase: formatQuantity(theoreticalQ),
      recordedQuantityBase: formatQuantity(recordedQ),
      countDerivedActualQuantityBase: formatQuantity(actualQ),
      sourceRefs: uniqueRefs(quantityRefs),
    },
    waterfalls: {
      itemId,
      quantity: { status: "COMPLETE", actualQuantityBase: formatQuantity(actualQ), components: quantityComponents, sourceRefs: uniqueRefs(quantityRefs) },
      value,
    },
    wasteShrinkage: { itemId, wasteQuantityBase: formatQuantity(wasteQ), unexplainedQuantityBase: formatQuantity(unexplainedQ), sourceRefs: uniqueRefs(quantityRefs) },
    incompleteSourceRefs,
  };
}

function buildCostLayers(query, recipeCosts, sales, legacyGapCompleteness) {
  const fields = {
    transactionHppRupiah: "inventory.cost.transaction_hpp",
    theoreticalSalesCogsRupiah: "inventory.cogs.theoretical",
    postedCogsRupiah: "inventory.cogs.posted",
    adjustedCogsRupiah: "inventory.cogs.adjusted",
  };
  const current = query.scopeLevel === "COMPANY"
    ? {
      metricId: "inventory.cost.current_recipe_hpp",
      valueRupiah: null,
      knownValueRupiah: null,
      complete: false,
      availability: "UNAVAILABLE_NON_ADDITIVE_COMPANY",
      incompleteSourceCount: recipeCosts.filter((fact) => !fact.costComplete || fact.hppRupiah == null).length,
      sourceRefs: uniqueRefs(recipeCosts.map((fact) => fact.sourceRef)),
    }
    : summarizeCostLayer(recipeCosts, "hppRupiah", "inventory.cost.current_recipe_hpp");
  return { currentRecipeHppRupiah: current, ...Object.fromEntries(Object.entries(fields).map(([field, metricId]) => {
    let known = 0n; const refs = []; let incomplete = legacyGapCompleteness.affectedCount;
    for (const fact of sales) {
      if (fact[field] == null || fact.costComplete !== true) { incomplete += 1; continue; }
      known += BigInt(fact[field]); refs.push(fact.sourceRef);
    }
    const result = {
      metricId, valueRupiah: incomplete === 0 ? safeMoney(known) : null,
      knownValueRupiah: safeMoney(known), complete: incomplete === 0,
      incompleteSourceCount: incomplete, sourceRefs: uniqueRefs(refs),
    };
    if (legacyGapCompleteness.affectedCount > 0) {
      result.incompleteSourceRefs = legacyGapCompleteness.sourceRefs;
      result.incompleteSourceCountTruncated = legacyGapCompleteness.truncated;
    }
    return [field, result];
  })) };
}

function summarizeCostLayer(facts, field, metricId) {
  let known = 0n; const refs = []; let incomplete = 0;
  for (const fact of facts) {
    if (fact[field] == null || fact.costComplete !== true) { incomplete += 1; continue; }
    known += BigInt(fact[field]); refs.push(fact.sourceRef);
  }
  return { metricId, valueRupiah: incomplete === 0 ? safeMoney(known) : null, knownValueRupiah: safeMoney(known), complete: incomplete === 0, incompleteSourceCount: incomplete, sourceRefs: uniqueRefs(refs) };
}

function buildProfitability(facts, legacyGapCompleteness) {
  const excludedIncomplete = [];
  const dimensions = { menu: new Map(), variant: new Map(), modifier: new Map(), channel: new Map() };
  for (const fact of facts) {
    if (!fact.costComplete) {
      excludedIncomplete.push({ saleLineId: fact.saleLineId, reason: "COST_INCOMPLETE", sourceRef: fact.sourceRef });
      continue;
    }
    appendProfit(dimensions.menu, fact.menuItemId, fact.menuItemName, fact);
    if (fact.variantId) appendProfit(dimensions.variant, fact.variantId, fact.variantName, fact);
    if (fact.modifierId) appendProfit(dimensions.modifier, fact.modifierId, fact.modifierName, fact);
    appendProfit(dimensions.channel, fact.channel, fact.channel, fact);
  }
  const result = {
    costPolicy: "EXCLUDE_INCOMPLETE_FROM_MARGIN_RANKING",
    menu: rankProfit(dimensions.menu), variant: rankProfit(dimensions.variant),
    modifier: rankProfit(dimensions.modifier), channel: rankProfit(dimensions.channel),
    excludedIncomplete: excludedIncomplete.sort(compareKeys("saleLineId")),
  };
  if (legacyGapCompleteness.affectedCount === 0) return result;
  const knownMargin = result.menu.reduce((sum, row) => sum + BigInt(row.marginRupiah), 0n);
  const incompleteRows = (rows) => rows.map((row) => ({
    ...row,
    knownAdjustedCogsRupiah: row.adjustedCogsRupiah,
    knownMarginRupiah: row.marginRupiah,
    adjustedCogsRupiah: null,
    marginRupiah: null,
  }));
  return {
    ...result,
    status: "PARTIAL",
    marginRupiah: null,
    knownMarginRupiah: safeMoney(knownMargin),
    incompleteSourceCount: legacyGapCompleteness.affectedCount,
    incompleteSourceCountTruncated: legacyGapCompleteness.truncated,
    incompleteSourceRefs: legacyGapCompleteness.sourceRefs,
    menu: incompleteRows(result.menu),
    variant: incompleteRows(result.variant),
    modifier: incompleteRows(result.modifier),
    channel: incompleteRows(result.channel),
  };
}

function buildSupplierScorecard(facts) {
  const groups = new Map();
  for (const fact of facts) {
    const row = groups.get(fact.supplierId) ?? { supplierId: fact.supplierId, ordered: 0n, accepted: 0n, rejected: 0n, deliveries: 0, onTime: 0, value: 0n, sourceRefs: [] };
    row.ordered += parseQuantity(fact.orderedQuantityBase);
    row.accepted += parseQuantity(fact.acceptedQuantityBase);
    row.rejected += parseQuantity(fact.rejectedQuantityBase);
    row.deliveries += 1; row.onTime += fact.onTime ? 1 : 0;
    row.value += BigInt(fact.acceptedValueRupiah); row.sourceRefs.push(fact.sourceRef);
    groups.set(fact.supplierId, row);
  }
  return [...groups.values()].map((row) => ({
    supplierId: row.supplierId, orderedQuantityBase: formatQuantity(row.ordered),
    acceptedQuantityBase: formatQuantity(row.accepted), rejectedQuantityBase: formatQuantity(row.rejected),
    acceptedValueRupiah: safeMoney(row.value), deliveryCount: row.deliveries,
    onTimeBps: ratioBps(row.onTime, row.deliveries), acceptanceBps: ratioBps(row.accepted, row.ordered),
    sourceRefs: uniqueRefs(row.sourceRefs),
  })).sort(compareKeys("supplierId"));
}

function buildProductionReport(facts, movementGroups) {
  const factById = new Map(facts.map((fact) => [fact.productionId, fact]));
  const ids = new Set([...factById.keys(), ...movementGroups.keys()]);
  const transformations = [...ids].map((productionId) => {
    const movements = movementGroups.get(productionId) ?? [];
    const inputs = movements.filter((row) => row.movementKind === "PRODUCTION_INPUT");
    const outputs = movements.filter((row) => row.movementKind === "PRODUCTION_OUTPUT");
    if (!inputs.length || !outputs.length) throw failure("inventory_reporting_production_pair_invalid", productionId);
    const fact = factById.get(productionId);
    if (!fact) throw failure("inventory_reporting_production_fact_missing", productionId);
    if (movements.some((row) => row.organizationId !== fact.organizationId || row.outletId !== fact.outletId)) throw failure("inventory_reporting_production_scope_mismatch", productionId);
    const inputValue = inputs.reduce((sum, row) => sum - BigInt(row.inventoryValueDeltaRupiah), 0n);
    const outputValue = outputs.reduce((sum, row) => sum + BigInt(row.inventoryValueDeltaRupiah), 0n);
    const refs = uniqueRefs([...movements.map((row) => row.sourceRef), ...(fact ? [fact.sourceRef] : [])]);
    return {
      productionId,
      inputLines: inputs.map(stockCardRow).sort(compareKeys("factId")),
      outputLines: outputs.map(stockCardRow).sort(compareKeys("factId")),
      inputValueRupiah: safeMoney(inputValue), outputValueRupiah: safeMoney(outputValue),
      transformValueDeltaRupiah: safeMoney(outputValue - inputValue),
      expectedOutputQuantityBase: fact?.expectedOutputQuantityBase ?? null,
      actualOutputQuantityBase: fact?.actualOutputQuantityBase ?? null,
      yieldVarianceQuantityBase: fact ? formatQuantity(parseQuantity(fact.actualOutputQuantityBase) - parseQuantity(fact.expectedOutputQuantityBase)) : null,
      sourceRefs: refs,
    };
  }).sort(compareKeys("productionId"));
  return { transformations };
}

function buildReplenishmentReport(facts) {
  return facts.map((fact) => ({
    replenishmentId: fact.replenishmentId, itemId: fact.itemId, locationId: fact.locationId,
    projectedShortageQuantityBase: fact.projectedShortageQuantityBase,
    recommendedQuantityBase: fact.recommendedQuantityBase,
    policyVersion: fact.policyVersion, observedAt: fact.observedAt, sourceRefs: [fact.sourceRef],
  })).sort(compareKeys("itemId", "locationId", "replenishmentId"));
}

function buildDataQuality(facts, excluded, negativeBalances, incompleteVariance, transferIssues) {
  const issues = [
    ...facts.map((fact) => ({
      issueId: fact.issueId, code: fact.code, severity: fact.severity, sourceRefs: [fact.sourceRef],
      ...(fact.affectedCount === undefined ? {} : { affectedCount: fact.affectedCount, truncated: fact.truncated }),
    })),
    ...excluded.map((row) => ({ issueId: `cost:${row.saleLineId}`, code: "COST_INCOMPLETE", severity: "ERROR", sourceRefs: [row.sourceRef] })),
    ...negativeBalances.map((row, index) => ({ issueId: `balance:${index}`, ...row })),
    ...incompleteVariance.map((sourceRef, index) => ({ issueId: `variance:${index}`, code: "VARIANCE_VALUE_INCOMPLETE", severity: "ERROR", sourceRefs: [sourceRef] })),
    ...transferIssues,
  ].sort(compareKeys("severity", "code", "issueId"));
  return { status: issues.length ? "PARTIAL" : "COMPLETE", issues };
}

function buildDrilldowns({ source, movement, variance, profitability, suppliers, production, replenishment, dataQuality, legacyGapCompleteness }) {
  const map = Object.fromEntries(Object.keys(INVENTORY_METRIC_DICTIONARY.metrics).map((key) => [key, []]));
  const movementRefs = source.movementFacts.map((fact) => fact.sourceRef);
  map["inventory.stock.closing_quantity"] = uniqueRefs(movementRefs);
  map["inventory.stock.closing_value"] = uniqueRefs(movementRefs);
  map["inventory.cost.current_recipe_hpp"] = uniqueRefs(source.recipeCostFacts.map((fact) => fact.sourceRef));
  map["inventory.cost.transaction_hpp"] = uniqueRefs([...costRefs(source, "transactionHppRupiah"), ...legacyGapCompleteness.sourceRefs]);
  map["inventory.cogs.theoretical"] = uniqueRefs([...costRefs(source, "theoreticalSalesCogsRupiah"), ...legacyGapCompleteness.sourceRefs]);
  map["inventory.cogs.posted"] = uniqueRefs([...costRefs(source, "postedCogsRupiah"), ...legacyGapCompleteness.sourceRefs]);
  map["inventory.cogs.adjusted"] = uniqueRefs([...costRefs(source, "adjustedCogsRupiah"), ...legacyGapCompleteness.sourceRefs]);
  map["inventory.usage.recorded"] = uniqueRefs(variance.usage.flatMap((row) => row.sourceRefs));
  map["inventory.usage.count_actual"] = uniqueRefs(variance.usage.flatMap((row) => row.sourceRefs));
  map["inventory.variance.waterfall_quantity"] = uniqueRefs(variance.waterfalls.flatMap((row) => row.quantity.sourceRefs));
  map["inventory.variance.waterfall_value"] = uniqueRefs(variance.waterfalls.flatMap((row) => row.value.sourceRefs));
  map["inventory.transfer.company_net"] = uniqueRefs(movement.internalTransfers.flatMap((row) => row.sourceRefs));
  map["inventory.production.transform"] = uniqueRefs(production.transformations.flatMap((row) => row.sourceRefs));
  map["inventory.profitability.margin"] = uniqueRefs([...source.saleFacts.filter((fact) => fact.costComplete).map((fact) => fact.sourceRef), ...legacyGapCompleteness.sourceRefs]);
  map["inventory.supplier.scorecard"] = uniqueRefs(suppliers.flatMap((row) => row.sourceRefs));
  map["inventory.replenishment.recommendation"] = uniqueRefs(replenishment.flatMap((row) => row.sourceRefs));
  map["inventory.data_quality.issue"] = uniqueRefs(dataQuality.issues.flatMap((row) => row.sourceRefs));
  return map;
}

function normalizeSource(input, requireFingerprint) {
  exactObject(input, requireFingerprint
    ? ["appliedFilter", "authorityBindings", "movementFacts", "productionFacts", "qualityFacts", "recipeCostFacts", "replenishmentFacts", "saleFacts", "sourceContract", "sourceFingerprint", "supplierFacts", "varianceFacts"]
    : ["appliedFilter", "authorityBindings", "movementFacts", "productionFacts", "qualityFacts", "recipeCostFacts", "replenishmentFacts", "saleFacts", "sourceContract", "supplierFacts", "varianceFacts"],
  "inventory_reporting_source_invalid");
  if (input.sourceContract !== INVENTORY_REPORTING_SOURCE_CONTRACT) throw failure("inventory_reporting_source_contract_invalid");
  const appliedFilter = normalizeFilter(input.appliedFilter);
  const normalized = {
    sourceContract: INVENTORY_REPORTING_SOURCE_CONTRACT,
    appliedFilter,
    authorityBindings: normalizeAuthorityBindings(input.authorityBindings, appliedFilter.outletIds),
    movementFacts: normalizeUnique(input.movementFacts, normalizeMovement, "factId"),
    recipeCostFacts: normalizeUnique(input.recipeCostFacts, normalizeRecipeCost, "recipeCostId"),
    varianceFacts: normalizeUnique(input.varianceFacts, normalizeVariance, "varianceId"),
    saleFacts: normalizeUnique(input.saleFacts, normalizeSale, "saleLineId"),
    supplierFacts: normalizeUnique(input.supplierFacts, normalizeSupplier, "supplierFactId"),
    productionFacts: normalizeUnique(input.productionFacts, normalizeProduction, "productionId"),
    replenishmentFacts: normalizeUnique(input.replenishmentFacts, normalizeReplenishment, "replenishmentId"),
    qualityFacts: normalizeUnique(input.qualityFacts, normalizeQuality, "issueId"),
  };
  assertUniqueRecipeCostGrain(normalized.recipeCostFacts);
  for (const family of ["movementFacts", "recipeCostFacts", "varianceFacts", "saleFacts", "supplierFacts", "productionFacts", "replenishmentFacts", "qualityFacts"]) assertUniqueSourceReferences(normalized[family], family);
  if (requireFingerprint) {
    const expected = sha256(normalized);
    if (input.sourceFingerprint !== expected) throw failure("inventory_reporting_source_tampered");
    return { ...normalized, sourceFingerprint: expected };
  }
  return normalized;
}

function normalizeQuery(input) {
  exactObject(input, ["currency", "includedStatuses", "organizationId", "outletIds", "periodEndUtc", "periodStartUtc", "policyVersion", "scopeLevel", "snapshotCutoffUtc"], "inventory_reporting_query_invalid");
  const organizationId = text(input.organizationId, "inventory_reporting_scope_invalid");
  const outletIds = uniqueStrings(input.outletIds, "inventory_reporting_scope_invalid");
  const scopeLevel = enumeration(input.scopeLevel, new Set(["OUTLET", "COMPANY"]), "inventory_reporting_scope_invalid");
  if ((scopeLevel === "OUTLET" && outletIds.length !== 1) || outletIds.length > MAX_COMPANY_OUTLETS) throw failure("inventory_reporting_scope_invalid");
  const periodStartUtc = instant(input.periodStartUtc, "inventory_reporting_period_invalid");
  const periodEndUtc = instant(input.periodEndUtc, "inventory_reporting_period_invalid");
  const snapshotCutoffUtc = instant(input.snapshotCutoffUtc, "inventory_reporting_period_invalid");
  if (Date.parse(periodStartUtc) >= Date.parse(periodEndUtc) || Date.parse(snapshotCutoffUtc) < Date.parse(periodEndUtc)) throw failure("inventory_reporting_period_invalid");
  if (canonical(input.includedStatuses) !== canonical([POSTED]) || input.currency !== "IDR") throw failure("inventory_reporting_policy_invalid");
  return { organizationId, outletIds, scopeLevel, periodStartUtc, periodEndUtc, snapshotCutoffUtc, includedStatuses: [POSTED], currency: "IDR", policyVersion: text(input.policyVersion, "inventory_reporting_policy_invalid") };
}

function normalizeFilter(input) {
  exactObject(input, ["currency", "includedStatuses", "organizationId", "outletIds", "periodEndUtc", "periodStartUtc", "policyVersion", "scopeLevel", "snapshotCutoffUtc"], "inventory_reporting_source_filter_invalid");
  return normalizeQuery(input);
}

function assertSourceFilter(query, filter) {
  if (canonical(query) !== canonical(filter)) throw failure("inventory_reporting_source_filter_mismatch");
}

function assertFactScopes(query, source) {
  const outletIds = new Set(query.outletIds);
  for (const family of ["movementFacts", "recipeCostFacts", "varianceFacts", "saleFacts", "supplierFacts", "productionFacts", "replenishmentFacts", "qualityFacts"]) {
    for (const fact of source[family]) {
      if (fact.organizationId !== query.organizationId || !outletIds.has(fact.outletId)) throw failure("inventory_reporting_fact_scope_mismatch", `${family}:${fact.organizationId}:${fact.outletId}`);
    }
  }
  const end = Date.parse(query.periodEndUtc);
  const start = Date.parse(query.periodStartUtc);
  const cutoff = Date.parse(query.snapshotCutoffUtc);
  if (source.movementFacts.some((fact) => Date.parse(fact.effectiveAt) >= end)) throw failure("inventory_reporting_fact_period_mismatch", "movementFacts");
  if (source.recipeCostFacts.some((fact) => Date.parse(fact.effectiveAt) > cutoff)) throw failure("inventory_reporting_fact_period_mismatch", "recipeCostFacts");
  if (source.saleFacts.some((fact) => Date.parse(fact.transactionAt) < start || Date.parse(fact.transactionAt) >= end)) throw failure("inventory_reporting_fact_period_mismatch", "saleFacts");
  if (source.varianceFacts.some((fact) => fact.periodStartUtc !== query.periodStartUtc || fact.periodEndUtc !== query.periodEndUtc)) throw failure("inventory_reporting_fact_period_mismatch", "varianceFacts");
  if (source.supplierFacts.some((fact) => Date.parse(fact.effectiveAt) < start || Date.parse(fact.effectiveAt) >= end)) throw failure("inventory_reporting_fact_period_mismatch", "supplierFacts");
  if (source.productionFacts.some((fact) => Date.parse(fact.completedAt) < start || Date.parse(fact.completedAt) >= end)) throw failure("inventory_reporting_fact_period_mismatch", "productionFacts");
  if (source.replenishmentFacts.some((fact) => Date.parse(fact.observedAt) > cutoff)) throw failure("inventory_reporting_fact_period_mismatch", "replenishmentFacts");
  if (source.qualityFacts.some((fact) => Date.parse(fact.observedAt) > cutoff)) throw failure("inventory_reporting_fact_period_mismatch", "qualityFacts");
}

function normalizeRecipeCost(value) {
  exactObject(value, ["approvalStatus", "costComplete", "effectiveAt", "hppRupiah", "menuItemId", "organizationId", "outletId", "quantityBase", "recipeCostId", "sourceRef", "variantId"], "inventory_reporting_recipe_cost_invalid");
  const costComplete = value.costComplete === true;
  const hppRupiah = value.hppRupiah == null ? null : nonnegativeMoney(value.hppRupiah);
  if (costComplete && hppRupiah == null) throw failure("inventory_reporting_cost_incomplete_conflict");
  return {
    recipeCostId: text(value.recipeCostId), organizationId: text(value.organizationId), outletId: text(value.outletId),
    menuItemId: text(value.menuItemId), variantId: optionalText(value.variantId), quantityBase: positiveQuantity(value.quantityBase),
    hppRupiah, costComplete, effectiveAt: instant(value.effectiveAt), approvalStatus: enumeration(value.approvalStatus, new Set(["APPROVED"]), "inventory_reporting_recipe_status_invalid"), sourceRef: normalizeRef(value.sourceRef),
  };
}

function normalizeMovement(value) {
  exactObject(value, ["effectiveAt", "factId", "inventoryValueDeltaRupiah", "itemId", "locationId", "movementKind", "organizationId", "outletId", "productionId", "quantityDeltaBase", "sourceRef", "status", "transferId"], "inventory_reporting_movement_invalid");
  const kind = enumeration(value.movementKind, MOVEMENT_KINDS, "inventory_reporting_movement_invalid");
  const transferId = optionalText(value.transferId);
  const productionId = optionalText(value.productionId);
  if (TRANSFER_KINDS.has(kind) !== Boolean(transferId) || PRODUCTION_KINDS.has(kind) !== Boolean(productionId)) throw failure("inventory_reporting_movement_link_invalid");
  const quantity = parseQuantity(value.quantityDeltaBase, "inventory_reporting_movement_quantity_invalid");
  const inventoryValue = money(value.inventoryValueDeltaRupiah);
  if ((["TRANSFER_OUT", "PRODUCTION_INPUT", "SALE_CONSUMPTION", "WASTE", "SUPPLIER_RETURN"].includes(kind) && quantity >= 0n)
    || (["TRANSFER_IN", "PRODUCTION_OUTPUT", "PURCHASE_RECEIPT"].includes(kind) && quantity <= 0n)) throw failure("inventory_reporting_movement_sign_invalid");
  if ((quantity < 0n && inventoryValue > 0) || (quantity > 0n && inventoryValue < 0)) throw failure("inventory_reporting_movement_value_sign_invalid");
  return {
    factId: text(value.factId), organizationId: text(value.organizationId), outletId: text(value.outletId),
    itemId: text(value.itemId), locationId: text(value.locationId), movementKind: kind,
    quantityDeltaBase: formatQuantity(quantity), inventoryValueDeltaRupiah: inventoryValue,
    transferId, productionId, effectiveAt: instant(value.effectiveAt), status: enumeration(value.status, new Set([POSTED]), "inventory_reporting_status_invalid"),
    sourceRef: normalizeRef(value.sourceRef),
  };
}

function normalizeVariance(value) {
  const keys = ["adjustedCogsRupiah", "costComplete", "countDerivedActualQuantityBase", "countDerivedActualValueRupiah", "currentRecipeHppRupiah", "itemId", "organizationId", "outletId", "periodEndUtc", "periodStartUtc", "postedCogsRupiah", "recordedUsageAtCurrentCostRupiah", "recordedUsageQuantityBase", "recordedUsageValueRupiah", "sourceRef", "status", "theoreticalSalesCogsRupiah", "theoreticalUsageQuantityBase", "theoreticalUsageValueRupiah", "transactionHppRupiah", "varianceId", "wasteQuantityBase", "wasteValueRupiah", "yieldVarianceQuantityBase", "yieldVarianceValueRupiah"];
  exactObject(value, keys, "inventory_reporting_variance_invalid");
  const costComplete = value.costComplete === true;
  const moneyFields = ["theoreticalUsageValueRupiah", "recordedUsageAtCurrentCostRupiah", "recordedUsageValueRupiah", "countDerivedActualValueRupiah", "yieldVarianceValueRupiah", "wasteValueRupiah", "currentRecipeHppRupiah", "transactionHppRupiah", "theoreticalSalesCogsRupiah", "postedCogsRupiah", "adjustedCogsRupiah"];
  const normalized = {
    varianceId: text(value.varianceId), organizationId: text(value.organizationId), outletId: text(value.outletId), itemId: text(value.itemId), costComplete,
    periodStartUtc: instant(value.periodStartUtc), periodEndUtc: instant(value.periodEndUtc), status: enumeration(value.status, new Set([POSTED]), "inventory_reporting_status_invalid"),
    theoreticalUsageQuantityBase: nonnegativeQuantity(value.theoreticalUsageQuantityBase),
    recordedUsageQuantityBase: nonnegativeQuantity(value.recordedUsageQuantityBase),
    countDerivedActualQuantityBase: nonnegativeQuantity(value.countDerivedActualQuantityBase),
    yieldVarianceQuantityBase: formatQuantity(parseQuantity(value.yieldVarianceQuantityBase)),
    wasteQuantityBase: nonnegativeQuantity(value.wasteQuantityBase), sourceRef: normalizeRef(value.sourceRef),
  };
  for (const field of moneyFields) normalized[field] = value[field] == null ? null : (field === "yieldVarianceValueRupiah" ? money(value[field]) : nonnegativeMoney(value[field]));
  if (costComplete && moneyFields.some((field) => normalized[field] == null)) throw failure("inventory_reporting_cost_incomplete_conflict");
  return normalized;
}

function normalizeSale(value) {
  const keys = ["adjustedCogsRupiah", "channel", "cogsAdjustmentRupiah", "costComplete", "currentRecipeHppRupiah", "menuItemId", "menuItemName", "modifierId", "modifierName", "netRevenueRupiah", "organizationId", "outletId", "postedCogsRupiah", "quantityBase", "saleLineId", "sourceRef", "status", "theoreticalSalesCogsRupiah", "transactionAt", "transactionHppRupiah", "variantId", "variantName"];
  exactObject(value, keys, "inventory_reporting_sale_invalid");
  const costComplete = value.costComplete === true;
  const result = {
    saleLineId: text(value.saleLineId), organizationId: text(value.organizationId), outletId: text(value.outletId), menuItemId: text(value.menuItemId), menuItemName: text(value.menuItemName),
    variantId: optionalText(value.variantId), variantName: optionalText(value.variantName), modifierId: optionalText(value.modifierId), modifierName: optionalText(value.modifierName),
    channel: enumeration(value.channel, CHANNELS, "inventory_reporting_channel_invalid"), quantityBase: positiveQuantity(value.quantityBase),
    netRevenueRupiah: nonnegativeMoney(value.netRevenueRupiah), costComplete, transactionAt: instant(value.transactionAt), status: enumeration(value.status, new Set([POSTED]), "inventory_reporting_status_invalid"), sourceRef: normalizeRef(value.sourceRef),
  };
  for (const field of ["currentRecipeHppRupiah", "transactionHppRupiah", "theoreticalSalesCogsRupiah", "postedCogsRupiah", "cogsAdjustmentRupiah", "adjustedCogsRupiah"]) result[field] = value[field] == null ? null : (field === "cogsAdjustmentRupiah" ? money(value[field]) : nonnegativeMoney(value[field]));
  if (costComplete && ["currentRecipeHppRupiah", "transactionHppRupiah", "theoreticalSalesCogsRupiah", "postedCogsRupiah", "cogsAdjustmentRupiah", "adjustedCogsRupiah"].some((field) => result[field] == null)) throw failure("inventory_reporting_cost_incomplete_conflict");
  if (Boolean(result.variantId) !== Boolean(result.variantName) || Boolean(result.modifierId) !== Boolean(result.modifierName)) throw failure("inventory_reporting_sale_dimension_invalid");
  if (costComplete && result.postedCogsRupiah + result.cogsAdjustmentRupiah !== result.adjustedCogsRupiah) throw failure("inventory_reporting_cogs_reconciliation_invalid");
  return result;
}

function normalizeSupplier(value) {
  exactObject(value, ["acceptedQuantityBase", "acceptedValueRupiah", "effectiveAt", "onTime", "orderedQuantityBase", "organizationId", "outletId", "rejectedQuantityBase", "sourceRef", "status", "supplierFactId", "supplierId"], "inventory_reporting_supplier_invalid");
  const result = { supplierFactId: text(value.supplierFactId), organizationId: text(value.organizationId), outletId: text(value.outletId), supplierId: text(value.supplierId), orderedQuantityBase: nonnegativeQuantity(value.orderedQuantityBase), acceptedQuantityBase: nonnegativeQuantity(value.acceptedQuantityBase), rejectedQuantityBase: nonnegativeQuantity(value.rejectedQuantityBase), acceptedValueRupiah: nonnegativeMoney(value.acceptedValueRupiah), onTime: boolean(value.onTime), effectiveAt: instant(value.effectiveAt), status: enumeration(value.status, new Set([POSTED]), "inventory_reporting_status_invalid"), sourceRef: normalizeRef(value.sourceRef) };
  if (parseQuantity(result.acceptedQuantityBase) + parseQuantity(result.rejectedQuantityBase) > parseQuantity(result.orderedQuantityBase)) throw failure("inventory_reporting_supplier_quantity_invalid");
  return result;
}

function normalizeProduction(value) {
  exactObject(value, ["actualOutputQuantityBase", "completedAt", "expectedOutputQuantityBase", "organizationId", "outletId", "productionId", "sourceRef", "status"], "inventory_reporting_production_invalid");
  return { productionId: text(value.productionId), organizationId: text(value.organizationId), outletId: text(value.outletId), expectedOutputQuantityBase: positiveQuantity(value.expectedOutputQuantityBase), actualOutputQuantityBase: positiveQuantity(value.actualOutputQuantityBase), completedAt: instant(value.completedAt), status: enumeration(value.status, new Set(["COMPLETED"]), "inventory_reporting_production_status_invalid"), sourceRef: normalizeRef(value.sourceRef) };
}

function normalizeReplenishment(value) {
  exactObject(value, ["itemId", "locationId", "observedAt", "organizationId", "outletId", "policyVersion", "projectedShortageQuantityBase", "recommendedQuantityBase", "replenishmentId", "sourceRef", "status"], "inventory_reporting_replenishment_invalid");
  return { replenishmentId: text(value.replenishmentId), organizationId: text(value.organizationId), outletId: text(value.outletId), itemId: text(value.itemId), locationId: text(value.locationId), projectedShortageQuantityBase: nonnegativeQuantity(value.projectedShortageQuantityBase), recommendedQuantityBase: nonnegativeQuantity(value.recommendedQuantityBase), policyVersion: text(value.policyVersion), observedAt: instant(value.observedAt), status: enumeration(value.status, new Set(["APPROVED"]), "inventory_reporting_replenishment_status_invalid"), sourceRef: normalizeRef(value.sourceRef) };
}

function normalizeQuality(value) {
  const hasAggregate = Object.hasOwn(value ?? {}, "affectedCount") || Object.hasOwn(value ?? {}, "truncated");
  exactObject(value, ["code", "issueId", "observedAt", "organizationId", "outletId", "severity", "sourceRef", "status", ...(hasAggregate ? ["affectedCount", "truncated"] : [])], "inventory_reporting_quality_invalid");
  const result = { issueId: text(value.issueId), organizationId: text(value.organizationId), outletId: text(value.outletId), code: text(value.code), severity: enumeration(value.severity, new Set(["INFO", "WARNING", "ERROR"]), "inventory_reporting_quality_invalid"), observedAt: instant(value.observedAt), status: enumeration(value.status, new Set(["OPEN"]), "inventory_reporting_quality_status_invalid"), sourceRef: normalizeRef(value.sourceRef) };
  if (result.code === "LEGACY_PAID_ORDER_GAP") {
    if (!hasAggregate || !Number.isSafeInteger(value.affectedCount) || value.affectedCount < 1 || value.affectedCount > 1_000 || typeof value.truncated !== "boolean") throw failure("inventory_reporting_quality_aggregate_invalid");
    result.affectedCount = value.affectedCount;
    result.truncated = value.truncated;
  } else if (hasAggregate) throw failure("inventory_reporting_quality_aggregate_invalid");
  return result;
}

function validateCompanyTransferGroup(rows) {
  const transferId = rows[0].transferId;
  const itemId = rows[0].itemId;
  const sourceRefs = uniqueRefs(rows.map((row) => row.sourceRef));
  const issue = (code) => ({ issueId: `transfer:${transferId}:${itemId}`, code, severity: "ERROR", sourceRefs });
  const outgoing = rows.filter((row) => row.movementKind === "TRANSFER_OUT");
  const incoming = rows.filter((row) => row.movementKind === "TRANSFER_IN");
  if (rows.length !== 2 || outgoing.length !== 1 || incoming.length !== 1) return { issue: issue("COMPANY_TRANSFER_PAIR_INCOMPLETE") };
  const [out] = outgoing;
  const [into] = incoming;
  if (out.outletId === into.outletId) return { issue: issue("COMPANY_TRANSFER_OUTLET_INVALID") };
  if (out.effectiveAt !== into.effectiveAt) return { issue: issue("COMPANY_TRANSFER_CUTOFF_INCOMPATIBLE") };
  if (parseQuantity(out.quantityDeltaBase) !== -parseQuantity(into.quantityDeltaBase)) return { issue: issue("COMPANY_TRANSFER_QUANTITY_MISMATCH") };
  if (BigInt(out.inventoryValueDeltaRupiah) !== -BigInt(into.inventoryValueDeltaRupiah)) return { issue: issue("COMPANY_TRANSFER_VALUE_MISMATCH") };
  return {
    transfer: {
      transferId,
      itemId,
      netQuantityBase: "0.000000",
      netValueRupiah: 0,
      treatedAsFinalConsumption: false,
      sourceRefs,
    },
  };
}

function validateOutletTransferGroup(rows) {
  const transferId = rows[0].transferId;
  const itemId = rows[0].itemId;
  const quantity = rows.reduce((sum, row) => sum + parseQuantity(row.quantityDeltaBase), 0n);
  const value = rows.reduce((sum, row) => sum + BigInt(row.inventoryValueDeltaRupiah), 0n);
  return {
    transfer: {
      transferId,
      itemId,
      netQuantityBase: formatQuantity(quantity),
      netValueRupiah: safeMoney(value),
      treatedAsFinalConsumption: false,
      sourceRefs: uniqueRefs(rows.map((row) => row.sourceRef)),
    },
  };
}

function normalizeAuthorityBindings(values, expectedOutletIds) {
  if (!Array.isArray(values) || values.length !== expectedOutletIds.length || values.length > MAX_COMPANY_OUTLETS) throw failure("inventory_reporting_authority_binding_invalid");
  const rows = values.map((value) => {
    exactObject(value, ["fingerprint", "outletId", "revision"], "inventory_reporting_authority_binding_invalid");
    const fingerprint = String(value.fingerprint ?? "");
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw failure("inventory_reporting_authority_binding_invalid");
    return { outletId: text(value.outletId, "inventory_reporting_authority_binding_invalid"), revision: positiveSafeInteger(value.revision, "inventory_reporting_authority_binding_invalid"), fingerprint };
  }).sort(compareKeys("outletId"));
  if (canonical(rows.map((row) => row.outletId)) !== canonical([...expectedOutletIds].sort())) throw failure("inventory_reporting_authority_binding_invalid");
  return rows;
}

function appendProfit(map, id, label, fact) {
  const row = map.get(id) ?? { id, label, quantity: 0n, revenue: 0n, adjustedCogs: 0n, sourceRefs: [] };
  row.quantity += parseQuantity(fact.quantityBase); row.revenue += BigInt(fact.netRevenueRupiah); row.adjustedCogs += BigInt(fact.adjustedCogsRupiah); row.sourceRefs.push(fact.sourceRef); map.set(id, row);
}

function rankProfit(map) {
  return [...map.values()].map((row) => ({ id: row.id, label: row.label, quantityBase: formatQuantity(row.quantity), netRevenueRupiah: safeMoney(row.revenue), adjustedCogsRupiah: safeMoney(row.adjustedCogs), marginRupiah: safeMoney(row.revenue - row.adjustedCogs), sourceRefs: uniqueRefs(row.sourceRefs) }))
    .sort((left, right) => right.marginRupiah - left.marginRupiah || left.id.localeCompare(right.id));
}

function stockCardRow(fact) {
  return { factId: fact.factId, movementKind: fact.movementKind, outletId: fact.outletId, itemId: fact.itemId, locationId: fact.locationId, quantityDeltaBase: fact.quantityDeltaBase, inventoryValueDeltaRupiah: fact.inventoryValueDeltaRupiah, effectiveAt: fact.effectiveAt, sourceRef: fact.sourceRef };
}

function component(kind, amount, refs) { return { kind, amount: formatQuantity(amount), sourceRefs: uniqueRefs(refs) }; }
function moneyComponent(kind, amount, refs) { return { kind, amountRupiah: safeMoney(amount), sourceRefs: uniqueRefs(refs) }; }
function metric(formula, scope, timeBasis, inclusions, exclusions, source) { return { formula, scope, timeBasis, inclusions, exclusions, source, version: 1 }; }
function costRefs(source, field) { return uniqueRefs(source.saleFacts.filter((fact) => fact.costComplete && fact[field] != null).map((fact) => fact.sourceRef)); }

function summarizeLegacyPaidOrderGaps(facts) {
  const legacy = facts.filter((fact) => fact.code === "LEGACY_PAID_ORDER_GAP");
  const affected = legacy.reduce((sum, fact) => sum + BigInt(fact.affectedCount), 0n);
  if (affected > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("inventory_reporting_quality_aggregate_invalid");
  return { affectedCount: Number(affected), truncated: legacy.some((fact) => fact.truncated), sourceRefs: uniqueRefs(legacy.map((fact) => fact.sourceRef)) };
}

function assertUniqueRecipeCostGrain(facts) {
  const grains = new Set();
  for (const fact of facts) {
    const grain = `${fact.organizationId}\u0000${fact.outletId}\u0000${fact.menuItemId}\u0000${fact.variantId ?? ""}`;
    if (grains.has(grain)) throw failure("inventory_reporting_recipe_cost_grain_duplicate", grain);
    grains.add(grain);
  }
}

function assertUniqueSourceReferences(facts, family) {
  const seen = new Set();
  for (const fact of facts) {
    const key = canonical(fact.sourceRef);
    if (seen.has(key)) throw failure("inventory_reporting_duplicate_source_reference", `${family}:${key}`);
    seen.add(key);
  }
}

function normalizeUnique(values, normalizer, idField) {
  if (!Array.isArray(values)) throw failure("inventory_reporting_source_invalid", idField);
  const rows = values.map(normalizer).sort((left, right) => left[idField].localeCompare(right[idField]));
  const duplicate = rows.find((row, index) => index > 0 && rows[index - 1][idField] === row[idField]);
  if (duplicate) throw failure("inventory_reporting_duplicate_fact", `${idField}:${duplicate[idField]}`);
  return rows;
}

function normalizeRef(value) {
  exactObject(value, ["id", "lineId", "type"], "inventory_reporting_source_reference_invalid");
  return { type: text(value.type), id: text(value.id), lineId: value.lineId == null ? null : text(value.lineId) };
}

function uniqueRefs(values) {
  const map = new Map(values.map((ref) => [canonical(ref), ref]));
  return [...map.values()].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function appendMap(map, key, value) { const rows = map.get(key) ?? []; rows.push(value); map.set(key, rows); }
function compareKeys(...keys) { return (left, right) => { for (const key of keys) { const result = String(left[key]).localeCompare(String(right[key])); if (result) return result; } return 0; }; }

function parseQuantity(value, code = "inventory_reporting_quantity_invalid") {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,17})\.\d{6}$/.test(value) || value === "-0.000000") throw failure(code);
  const negative = value.startsWith("-"); const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction);
  return negative ? -result : result;
}
function nonnegativeQuantity(value) { const result = parseQuantity(value); if (result < 0n) throw failure("inventory_reporting_quantity_negative"); return formatQuantity(result); }
function positiveQuantity(value) { const result = parseQuantity(value); if (result <= 0n) throw failure("inventory_reporting_quantity_not_positive"); return formatQuantity(result); }
function formatQuantity(value) { const negative = value < 0n; const absolute = negative ? -value : value; return `${negative ? "-" : ""}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(6, "0")}`; }
function averageUnitCost(value, quantity) { if (quantity <= 0n) return null; return Number(roundDivide(BigInt(value) * SCALE, quantity)); }
function ratioBps(numerator, denominator) { if (denominator === 0 || denominator === 0n) return null; return Number(roundDivide(BigInt(numerator) * 10_000n, BigInt(denominator))); }
function roundDivide(numerator, denominator) { const negative = numerator < 0n !== denominator < 0n; const a = numerator < 0n ? -numerator : numerator; const b = denominator < 0n ? -denominator : denominator; let q = a / b; if ((a % b) * 2n >= b) q += 1n; return negative ? -q : q; }
function safeMoney(value) { const result = Number(value); if (!Number.isSafeInteger(result)) throw failure("inventory_reporting_amount_overflow"); return result; }
function money(value) { if (!Number.isSafeInteger(value)) throw failure("inventory_reporting_amount_invalid"); return value; }
function positiveSafeInteger(value, code) { if (!Number.isSafeInteger(value) || value < 1) throw failure(code); return value; }
function nonnegativeMoney(value) { const result = money(value); if (result < 0) throw failure("inventory_reporting_amount_negative"); return result; }
function boolean(value) { if (typeof value !== "boolean") throw failure("inventory_reporting_boolean_invalid"); return value; }
function instant(value, code = "inventory_reporting_instant_invalid") { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) throw failure(code); return value; }
function enumeration(value, allowed, code) { if (!allowed.has(value)) throw failure(code); return value; }
function text(value, code = "inventory_reporting_text_invalid") { if (typeof value !== "string" || !value.trim() || value.trim().length > 160) throw failure(code); return value.trim(); }
function optionalText(value) { return value == null ? null : text(value); }
function uniqueStrings(value, code) { if (!Array.isArray(value) || !value.length) throw failure(code); const rows = value.map((item) => text(item, code)).sort(); if (new Set(rows).size !== rows.length) throw failure(code); return rows; }
function exactObject(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure(code); }
function sha256(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
function failure(code, detail) { return new InventoryReportingError(code, detail); }
