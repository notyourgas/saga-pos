const addRupiah = (left, right) => {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("cogs_reconciliation_amount_overflow");
  return value;
};

const addQuantity = (left, right) => {
  const value = Math.round((left + right) * 1000) / 1000;
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw new Error("cogs_reconciliation_quantity_overflow");
  return value;
};

export function buildCogsReconciliation({ saleConsumptions = [], cogsAdjustments = [], orderIds = null } = {}) {
  if (!Array.isArray(saleConsumptions) || !Array.isArray(cogsAdjustments)) throw new Error("cogs_reconciliation_fact_invalid");
  if (orderIds !== null && !Array.isArray(orderIds)) throw new Error("cogs_reconciliation_order_invalid");
  const requestedOrderIds = orderIds == null ? null : new Set(orderIds);
  if (requestedOrderIds && (requestedOrderIds.size !== orderIds.length || [...requestedOrderIds].some((id) => typeof id !== "string" || !id))) throw new Error("cogs_reconciliation_order_invalid");
  const consumptions = saleConsumptions.filter((item) => requestedOrderIds === null || requestedOrderIds.has(item.orderId));
  const consumptionIds = new Set(consumptions.map((item) => item.id));
  if (consumptionIds.size !== consumptions.length) throw new Error("cogs_reconciliation_fact_invalid");
  const adjustments = cogsAdjustments.filter((item) => consumptionIds.has(item.consumptionId));
  const adjustmentsByLine = new Map();
  for (const adjustment of adjustments) {
    const key = `${adjustment.consumptionId}\u0000${adjustment.ingredientId}`;
    const group = adjustmentsByLine.get(key) ?? [];
    group.push(adjustment);
    adjustmentsByLine.set(key, group);
  }

  const rows = consumptions.map((consumption) => {
    let postedCogsRupiah = 0;
    let cogsAdjustmentRupiah = 0;
    let provisionalShortageCogsRupiah = 0;
    let unresolvedShortageQuantityBase = 0;
    let unresolvedProvisionalCogsRupiah = 0;
    let missingProvisionalCostLineCount = 0;
    let missingProvisionalCostQuantityBase = 0;
    for (const line of consumption.lines) {
      if (!Number.isSafeInteger(line.postedCogsRupiah) || line.postedCogsRupiah < 0
        || !Number.isSafeInteger(line.provisionalShortageCostRupiah) || line.provisionalShortageCostRupiah < 0
        || !Number.isFinite(line.shortageBase) || line.shortageBase < 0 || Math.round(line.shortageBase * 1000) / 1000 !== line.shortageBase) throw new Error("cogs_reconciliation_fact_invalid");
      postedCogsRupiah = addRupiah(postedCogsRupiah, line.postedCogsRupiah);
      provisionalShortageCogsRupiah = addRupiah(provisionalShortageCogsRupiah, line.provisionalShortageCostRupiah);
      const lineAdjustments = adjustmentsByLine.get(`${consumption.id}\u0000${line.ingredientId}`) ?? [];
      const resolvedQuantity = lineAdjustments.reduce((sum, item) => addQuantity(sum, item.quantityResolvedBase), 0);
      const resolvedProvisional = lineAdjustments.reduce((sum, item) => addRupiah(sum, item.provisionalCostRupiah), 0);
      if (resolvedQuantity > line.shortageBase || resolvedProvisional > line.provisionalShortageCostRupiah) throw new Error("cogs_reconciliation_fact_invalid");
      cogsAdjustmentRupiah = lineAdjustments.reduce((sum, item) => addRupiah(sum, item.adjustmentRupiah), cogsAdjustmentRupiah);
      const unresolvedLineQuantityBase = addQuantity(line.shortageBase, -resolvedQuantity);
      unresolvedShortageQuantityBase = addQuantity(unresolvedShortageQuantityBase, unresolvedLineQuantityBase);
      unresolvedProvisionalCogsRupiah = addRupiah(unresolvedProvisionalCogsRupiah, line.provisionalShortageCostRupiah - resolvedProvisional);
      if (unresolvedLineQuantityBase > 0 && (!Number.isFinite(line.provisionalShortageUnitCostRupiah) || line.provisionalShortageUnitCostRupiah <= 0)) {
        missingProvisionalCostLineCount += 1;
        missingProvisionalCostQuantityBase = addQuantity(missingProvisionalCostQuantityBase, unresolvedLineQuantityBase);
      }
    }
    return {
      orderId: consumption.orderId,
      orderNumber: consumption.orderNumber,
      consumptionId: consumption.id,
      occurredAt: consumption.occurredAt,
      postedCogsRupiah,
      cogsAdjustmentRupiah,
      adjustedCogsRupiah: addRupiah(postedCogsRupiah, cogsAdjustmentRupiah),
      provisionalShortageCogsRupiah,
      unresolvedShortageQuantityBase,
      unresolvedProvisionalCogsRupiah,
      missingProvisionalCostLineCount,
      missingProvisionalCostQuantityBase,
      status: missingProvisionalCostLineCount > 0 ? "COST_MISSING" : unresolvedShortageQuantityBase > 0 ? "PROVISIONAL_OPEN" : "RECONCILED",
    };
  });

  const postedCogsRupiah = rows.reduce((sum, row) => addRupiah(sum, row.postedCogsRupiah), 0);
  const cogsAdjustmentRupiah = rows.reduce((sum, row) => addRupiah(sum, row.cogsAdjustmentRupiah), 0);
  const unresolvedShortageQuantityBase = rows.reduce((sum, row) => addQuantity(sum, row.unresolvedShortageQuantityBase), 0);
  const unresolvedProvisionalCogsRupiah = rows.reduce((sum, row) => addRupiah(sum, row.unresolvedProvisionalCogsRupiah), 0);
  const missingProvisionalCostLineCount = rows.reduce((sum, row) => sum + row.missingProvisionalCostLineCount, 0);
  const missingProvisionalCostQuantityBase = rows.reduce((sum, row) => addQuantity(sum, row.missingProvisionalCostQuantityBase), 0);
  const missingConsumptionOrderCount = requestedOrderIds === null ? 0 : [...requestedOrderIds].filter((orderId) => !consumptions.some((item) => item.orderId === orderId)).length;
  return {
    version: 1,
    basis: "IMMUTABLE_SALE_CONSUMPTION_POSTED_PLUS_SHORTAGE_REVALUATION",
    status: missingProvisionalCostLineCount > 0 ? "COST_MISSING" : missingConsumptionOrderCount > 0 ? "PARTIAL" : !rows.length ? "EMPTY" : unresolvedShortageQuantityBase > 0 ? "PROVISIONAL_OPEN" : "RECONCILED",
    requestedOrderCount: requestedOrderIds?.size ?? new Set(rows.map((row) => row.orderId)).size,
    consumptionCount: rows.length,
    missingConsumptionOrderCount,
    adjustmentCount: adjustments.length,
    postedCogsRupiah,
    cogsAdjustmentRupiah,
    adjustedCogsRupiah: addRupiah(postedCogsRupiah, cogsAdjustmentRupiah),
    provisionalShortageCogsRupiah: rows.reduce((sum, row) => addRupiah(sum, row.provisionalShortageCogsRupiah), 0),
    unresolvedShortageQuantityBase,
    unresolvedProvisionalCogsRupiah,
    missingProvisionalCostLineCount,
    missingProvisionalCostQuantityBase,
    rows,
  };
}
