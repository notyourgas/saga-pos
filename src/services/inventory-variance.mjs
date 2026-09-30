const PAID_STATUSES = new Set(["PAID", "COMPLETED"]);
const BASE_UNITS = new Set(["gram", "ml", "pcs"]);
const EXPLAINED_DEPLETION_TYPES = new Set(["SPOILAGE_WASTE", "PRODUCTION_WASTE", "DAMAGED", "INTERNAL_USE", "SAMPLES_PROMOTIONAL", "LOSS_THEFT"]);
const BOUNDARY = "OPENING_EXCLUSIVE_CLOSING_INCLUSIVE";
const MAX_EVIDENCE_ENTRIES = 200;

export function buildInventoryVarianceReport({ hppState = {}, orders = [], orderItems = [], openingCountId, closingCountId } = {}) {
  const facts = validateAndIndexHppFacts(hppState);
  const availableCounts = [...facts.counts].sort((a, b) => a.completedAt.localeCompare(b.completedAt)).map(countSummary);
  if (availableCounts.length < 2) return emptyReport(availableCounts, facts.usePreparingBoundary);

  const opening = openingCountId ? facts.countById.get(openingCountId) : facts.counts.at(-2);
  const closing = closingCountId ? facts.countById.get(closingCountId) : facts.counts.at(-1);
  if (!opening || !closing) throw new Error("inventory_variance_count_not_found");
  if (Date.parse(opening.completedAt) >= Date.parse(closing.completedAt) || opening.id === closing.id) throw new Error("inventory_variance_period_invalid");

  const blockers = new Set();
  const openingLines = indexCountLines(opening);
  const closingLines = indexCountLines(closing);
  const ingredientIds = new Set([...openingLines.keys(), ...closingLines.keys()]);
  if (openingLines.size !== closingLines.size || [...ingredientIds].some((id) => !openingLines.has(id) || !closingLines.has(id))) blockers.add("COUNT_COVERAGE_MISMATCH");

  const purchasesByIngredient = new Map();
  let purchaseReceiptCount = 0;
  let supplierReturnCount = 0;
  let supplierReplacementReceiptCount = 0;
  for (const receipt of facts.receipts) {
    if (!withinPeriod(receipt.receivedAt, opening.completedAt, closing.completedAt)) continue;
    purchaseReceiptCount += 1;
    for (const line of receipt.lines) {
      const row = purchasesByIngredient.get(line.ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
      row.quantityBase = safeQuantity(row.quantityBase + line.baseQuantity);
      row.valueRupiah = safeMoney(row.valueRupiah + line.totalCostRupiah);
      row.entries.push({
        reference: receipt.id,
        occurredAt: receipt.receivedAt,
        supplierName: evidenceText(receipt.supplierName, "Supplier tidak dicatat", 120),
        reason: evidenceText(receipt.reason, "Alasan tidak dicatat", 160),
        quantityBase: line.baseQuantity,
        valueRupiah: line.totalCostRupiah,
      });
      purchasesByIngredient.set(line.ingredientId, row);
      ingredientIds.add(line.ingredientId);
    }
  }
  for (const supplierReturn of facts.supplierReturns) {
    if (withinPeriod(supplierReturn.shippedAt, opening.completedAt, closing.completedAt)) {
      supplierReturnCount += 1;
      for (const line of supplierReturn.lines) {
        const row = purchasesByIngredient.get(line.ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
        row.quantityBase = safeSignedQuantity(row.quantityBase - line.baseQuantity);
        row.valueRupiah = safeSignedMoney(row.valueRupiah - line.returnValueRupiah);
        row.entries.push({ evidenceType: "SUPPLIER_RETURN", reference: supplierReturn.returnReference, occurredAt: supplierReturn.shippedAt, supplierName: supplierReturn.supplierNameSnapshot, reason: supplierReturn.reason, quantityBase: -line.baseQuantity, valueRupiah: -line.returnValueRupiah });
        purchasesByIngredient.set(line.ingredientId, row); ingredientIds.add(line.ingredientId);
      }
    }
    if (supplierReturn.replacementReceipt && withinPeriod(supplierReturn.replacementReceipt.receivedAt, opening.completedAt, closing.completedAt)) {
      supplierReplacementReceiptCount += 1;
      for (const line of supplierReturn.lines) {
        const row = purchasesByIngredient.get(line.ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
        row.quantityBase = safeSignedQuantity(row.quantityBase + line.baseQuantity);
        row.valueRupiah = safeSignedMoney(row.valueRupiah + line.returnValueRupiah);
        row.entries.push({ evidenceType: "SUPPLIER_REPLACEMENT", reference: supplierReturn.replacementReceipt.receiptReference, occurredAt: supplierReturn.replacementReceipt.receivedAt, supplierName: supplierReturn.supplierNameSnapshot, reason: supplierReturn.replacementReceipt.reason, quantityBase: line.baseQuantity, valueRupiah: line.returnValueRupiah });
        purchasesByIngredient.set(line.ingredientId, row); ingredientIds.add(line.ingredientId);
      }
    }
  }

  const wasteByIngredient = new Map();
  for (const movement of facts.movements) {
    if (!EXPLAINED_DEPLETION_TYPES.has(movement.movementType) || !withinPeriod(movement.occurredAt, opening.completedAt, closing.completedAt)) continue;
    validateDepletionMovement(movement, facts.ingredientById);
    const row = wasteByIngredient.get(movement.ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
    row.quantityBase = safeQuantity(row.quantityBase + movement.quantityInputBase);
    row.valueRupiah = safeMoney(row.valueRupiah + Math.abs(movement.inventoryValueDeltaRupiah));
    row.entries.push({
      reference: movement.id,
      occurredAt: movement.occurredAt,
      movementType: movement.movementType,
      reason: evidenceText(movement.reason, "Alasan tidak dicatat", 160),
      quantityBase: movement.quantityInputBase,
      valueRupiah: Math.abs(movement.inventoryValueDeltaRupiah),
    });
    wasteByIngredient.set(movement.ingredientId, row);
  }

  const theoretical = buildPeriodTheoretical({
    orders,
    orderItems,
    saleConsumptions: facts.usePreparingBoundary ? facts.saleConsumptions : null,
    openingAt: opening.completedAt,
    closingAt: closing.completedAt,
    ingredientById: facts.ingredientById,
  });
  theoretical.blockers.forEach((item) => blockers.add(item));
  theoretical.rows.forEach((_row, ingredientId) => ingredientIds.add(ingredientId));

  const rows = [...ingredientIds].map((ingredientId) => {
    const ingredient = facts.ingredientById.get(ingredientId);
    const openingLine = openingLines.get(ingredientId);
    const closingLine = closingLines.get(ingredientId);
    const purchase = purchasesByIngredient.get(ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
    const explained = wasteByIngredient.get(ingredientId) ?? { quantityBase: 0, valueRupiah: 0, entries: [] };
    const theory = theoretical.rows.get(ingredientId) ?? { quantityBase: 0, valueRupiah: 0, sourceProducts: new Map() };
    if (!ingredient || !openingLine || !closingLine) blockers.add("COUNT_COVERAGE_MISMATCH");
    const openingValue = openingLine ? anchorValue(openingLine, opening, facts.movementById) : null;
    const closingValue = closingLine ? anchorValue(closingLine, closing, facts.movementById) : null;
    const actualQuantityBase = openingLine && closingLine ? safeSignedQuantity(openingLine.quantityAfterBase + purchase.quantityBase - closingLine.quantityAfterBase) : null;
    const actualValueRupiah = openingValue != null && closingValue != null ? safeSignedMoney(openingValue + purchase.valueRupiah - closingValue) : null;
    if (actualQuantityBase != null && actualQuantityBase < 0) blockers.add("NEGATIVE_ACTUAL_USAGE");
    if (actualValueRupiah != null && actualValueRupiah < 0) blockers.add("NEGATIVE_ACTUAL_VALUE");
    const varianceQuantityBase = actualQuantityBase == null || theoretical.status !== "VERIFIED" ? null : safeSignedQuantity(actualQuantityBase - theory.quantityBase);
    const varianceValueRupiah = actualValueRupiah == null || theoretical.status !== "VERIFIED" ? null : safeSignedMoney(actualValueRupiah - theory.valueRupiah);
    return {
      ingredientId,
      name: ingredient?.name ?? "Bahan tidak dikenal",
      unit: ingredient?.baseUnit ?? null,
      openingQuantityBase: openingLine?.quantityAfterBase ?? null,
      purchaseQuantityBase: purchase.quantityBase,
      closingQuantityBase: closingLine?.quantityAfterBase ?? null,
      actualQuantityBase,
      theoreticalQuantityBase: theory.quantityBase,
      varianceQuantityBase,
      openingValueRupiah: openingValue,
      purchaseValueRupiah: purchase.valueRupiah,
      closingValueRupiah: closingValue,
      actualValueRupiah,
      theoreticalValueRupiah: theory.valueRupiah,
      varianceValueRupiah,
      recordedWasteQuantityBase: explained.quantityBase,
      recordedWasteValueRupiah: explained.valueRupiah,
      sourceProducts: [...theory.sourceProducts].map(([name, qty]) => ({ name, qty })).sort((a, b) => a.name.localeCompare(b.name, "id")),
      purchaseEvidenceEntries: purchase.entries,
      depletionEvidenceEntries: explained.entries,
    };
  }).sort((a, b) => Math.abs(b.varianceValueRupiah ?? -1) - Math.abs(a.varianceValueRupiah ?? -1) || a.name.localeCompare(b.name, "id"));
  const evidence = attachEvidence(rows);

  const verified = blockers.size === 0 && theoretical.status === "VERIFIED" && rows.every((row) => row.actualValueRupiah != null && row.varianceValueRupiah != null);
  return {
    version: 1,
    status: verified ? "VERIFIED" : "PARTIAL",
    basis: facts.usePreparingBoundary
      ? "FULL_COUNTS_NET_PURCHASE_RECEIPTS_PREPARING_RECIPE_SNAPSHOTS"
      : "FULL_COUNTS_NET_PURCHASE_RECEIPTS_PAID_RECIPE_SNAPSHOTS_LEGACY",
    boundary: BOUNDARY,
    openingCount: countSummary(opening),
    closingCount: countSummary(closing),
    availableCounts,
    purchaseReceiptCount,
    supplierReturnCount,
    supplierReplacementReceiptCount,
    orderCount: theoretical.orderCount,
    soldItemQuantity: theoretical.soldItemQuantity,
    verifiedItemQuantity: theoretical.verifiedItemQuantity,
    coveragePct: theoretical.coveragePct,
    actualUsageValueRupiah: verified ? sumRows(rows, "actualValueRupiah") : null,
    theoreticalUsageValueRupiah: verified ? sumRows(rows, "theoreticalValueRupiah") : null,
    varianceValueRupiah: verified ? sumRows(rows, "varianceValueRupiah") : null,
    recordedWasteValueRupiah: sumRows(rows, "recordedWasteValueRupiah"),
    evidence,
    blockers: [...blockers].sort(),
    rows,
  };
}

export function inventoryVarianceCsv(report) {
  if (!report || report.version !== 1 || !Array.isArray(report.rows)) throw new Error("inventory_variance_report_invalid");
  const rows = [
    ["Saga POS - actual vs theoretical"],
    ["Status", report.status],
    ["Batas periode", report.boundary],
    ["Count pembuka", report.openingCount?.completedAt ?? "Belum tersedia"],
    ["Count penutup", report.closingCount?.completedAt ?? "Belum tersedia"],
    ["Coverage resep", report.coveragePct == null ? "N/A" : `${report.coveragePct}%`],
    ["Nilai pemakaian aktual", report.actualUsageValueRupiah],
    ["Nilai pemakaian teoretis", report.theoreticalUsageValueRupiah],
    ["Nilai varians", report.varianceValueRupiah],
    ["Blocker", report.blockers?.join("; ") ?? ""],
    [],
    ["Bahan", "Satuan", "Stok awal", "Pembelian", "Stok akhir", "Aktual", "Teoretis", "Varians", "Waste tercatat", "Nilai aktual", "Nilai teoretis", "Nilai varians", "Sumber menu", "Jumlah receipt", "Jumlah pengurangan", "Bukti dibatasi"],
    ...report.rows.map((row) => [row.name, row.unit, row.openingQuantityBase, row.purchaseQuantityBase, row.closingQuantityBase, row.actualQuantityBase, row.theoreticalQuantityBase, row.varianceQuantityBase, row.recordedWasteQuantityBase, row.actualValueRupiah, row.theoreticalValueRupiah, row.varianceValueRupiah, row.sourceProducts.map((item) => `${item.name} x ${item.qty}`).join("; "), row.purchaseEvidence?.totalCount ?? 0, row.depletionEvidence?.totalCount ?? 0, row.purchaseEvidence?.truncated || row.depletionEvidence?.truncated ? "YA" : "TIDAK"]),
    [],
    ["Audit trail terbatas", `${report.evidence?.shownEntries ?? 0} dari ${report.evidence?.totalEntries ?? 0} bukti; maksimum ${report.evidence?.maxEntries ?? MAX_EVIDENCE_ENTRIES}`],
    ["Bahan", "Jenis bukti", "Waktu", "Referensi", "Supplier", "Alasan", "Jumlah", "Satuan", "Nilai"],
    ...report.rows.flatMap((row) => [
      ...(row.purchaseEvidence?.entries ?? []).map((entry) => [row.name, entry.evidenceType ?? "RECEIPT", entry.occurredAt, entry.reference, entry.supplierName, entry.reason, entry.quantityBase, row.unit, entry.valueRupiah]),
      ...(row.depletionEvidence?.entries ?? []).map((entry) => [row.name, entry.movementType, entry.occurredAt, entry.reference, "", entry.reason, entry.quantityBase, row.unit, entry.valueRupiah]),
    ]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function validateAndIndexHppFacts(state) {
  if (!state || !Array.isArray(state.ingredients) || !Array.isArray(state.inventoryCounts) || !Array.isArray(state.purchaseReceipts) || !Array.isArray(state.inventoryMovements) || (state.supplierReturns !== undefined && !Array.isArray(state.supplierReturns))) throw new Error("inventory_variance_fact_invalid");
  const ingredientById = new Map();
  for (const ingredient of state.ingredients) {
    if (!ingredient || typeof ingredient.id !== "string" || !ingredient.id || ingredientById.has(ingredient.id) || typeof ingredient.name !== "string" || !ingredient.name.trim() || !BASE_UNITS.has(ingredient.baseUnit)) throw new Error("inventory_variance_fact_invalid");
    ingredientById.set(ingredient.id, ingredient);
  }
  const movementById = new Map();
  for (const movement of state.inventoryMovements) {
    if (!movement || typeof movement.id !== "string" || !movement.id || movementById.has(movement.id)) throw new Error("inventory_variance_fact_invalid");
    movementById.set(movement.id, movement);
  }
  const countById = new Map();
  for (const count of state.inventoryCounts) {
    if (!count || typeof count.id !== "string" || !count.id || countById.has(count.id) || count.status !== "COMPLETED" || !validTimestamp(count.completedAt) || !Array.isArray(count.lines) || count.lineCount !== count.lines.length || count.lines.length === 0) throw new Error("inventory_variance_fact_invalid");
    const countLines = indexCountLines(count);
    if ([...countLines.keys()].some((ingredientId) => !ingredientById.has(ingredientId))) throw new Error("inventory_variance_fact_invalid");
    countById.set(count.id, count);
  }
  const receiptIds = new Set();
  for (const receipt of state.purchaseReceipts) {
    if (!receipt || typeof receipt.id !== "string" || !receipt.id || receiptIds.has(receipt.id) || !validTimestamp(receipt.receivedAt) || !Array.isArray(receipt.lines) || (!receipt.lines.length && !Array.isArray(receipt.rejectedLines)) || !Number.isSafeInteger(receipt.totalCostRupiah) || receipt.totalCostRupiah < 0) throw new Error("inventory_variance_fact_invalid");
    receiptIds.add(receipt.id);
    let total = 0;
    const ids = new Set();
    for (const line of receipt.lines) {
      if (!line || !ingredientById.has(line.ingredientId) || ids.has(line.ingredientId) || !validPositiveQuantity(line.baseQuantity) || !Number.isSafeInteger(line.totalCostRupiah) || line.totalCostRupiah <= 0) throw new Error("inventory_variance_fact_invalid");
      ids.add(line.ingredientId); total = safeMoney(total + line.totalCostRupiah);
    }
    if (total !== receipt.totalCostRupiah) throw new Error("inventory_variance_fact_invalid");
  }
  const supplierReturnIds = new Set();
  for (const item of state.supplierReturns ?? []) {
    if (!item || typeof item.id !== "string" || !item.id || supplierReturnIds.has(item.id) || typeof item.returnReference !== "string" || !item.returnReference.trim()
      || typeof item.supplierNameSnapshot !== "string" || !item.supplierNameSnapshot.trim() || !validTimestamp(item.shippedAt) || !Array.isArray(item.lines) || !item.lines.length
      || !Number.isSafeInteger(item.totalReturnValueRupiah) || item.totalReturnValueRupiah <= 0) throw new Error("inventory_variance_fact_invalid");
    supplierReturnIds.add(item.id);
    let total = 0;
    const ids = new Set();
    for (const line of item.lines) {
      if (!line || !ingredientById.has(line.ingredientId) || ids.has(line.ingredientId) || !validPositiveQuantity(line.baseQuantity) || !Number.isSafeInteger(line.returnValueRupiah) || line.returnValueRupiah <= 0) throw new Error("inventory_variance_fact_invalid");
      ids.add(line.ingredientId); total = safeMoney(total + line.returnValueRupiah);
    }
    if (total !== item.totalReturnValueRupiah || (item.replacementReceipt && (!validTimestamp(item.replacementReceipt.receivedAt) || typeof item.replacementReceipt.receiptReference !== "string" || !item.replacementReceipt.receiptReference.trim()))) throw new Error("inventory_variance_fact_invalid");
  }
  const counts = [...countById.values()].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const usePreparingBoundary = Number.isSafeInteger(state.stateVersion) && state.stateVersion >= 17;
  if (usePreparingBoundary && !Array.isArray(state.saleConsumptions)) throw new Error("inventory_variance_fact_invalid");
  const saleConsumptions = state.saleConsumptions ?? [];
  const consumptionOrders = new Set();
  for (const consumption of saleConsumptions) {
    if (!consumption || typeof consumption.orderId !== "string" || !consumption.orderId || consumptionOrders.has(consumption.orderId)
      || consumption.trigger !== "PREPARING" && consumption.trigger !== "PAYMENT_PAID_LEGACY"
      || !validTimestamp(consumption.occurredAt)) throw new Error("inventory_variance_fact_invalid");
    consumptionOrders.add(consumption.orderId);
  }
  return { ingredientById, movementById, countById, counts, receipts: state.purchaseReceipts, supplierReturns: state.supplierReturns ?? [], movements: state.inventoryMovements, saleConsumptions, usePreparingBoundary };
}

function indexCountLines(count) {
  const map = new Map();
  for (const line of count.lines) {
    if (!line || typeof line.ingredientId !== "string" || !line.ingredientId || map.has(line.ingredientId) || !validQuantity(line.quantityAfterBase) || typeof line.movementId !== "string" || !line.movementId) throw new Error("inventory_variance_fact_invalid");
    map.set(line.ingredientId, line);
  }
  return map;
}

function anchorValue(line, count, movementById) {
  const movement = movementById.get(line.movementId);
  if (!movement || movement.ingredientId !== line.ingredientId || movement.countSessionId !== count.id || movement.movementType !== "CYCLE_COUNT" || movement.occurredAt !== count.completedAt || !Number.isSafeInteger(movement.inventoryValueAfterRupiah) || movement.inventoryValueAfterRupiah < 0) throw new Error("inventory_variance_fact_invalid");
  return movement.inventoryValueAfterRupiah;
}

function buildPeriodTheoretical({ orders, orderItems, saleConsumptions, openingAt, closingAt, ingredientById }) {
  if (!Array.isArray(orders) || !Array.isArray(orderItems)) throw new Error("inventory_variance_fact_invalid");
  const blockers = new Set();
  const selected = [];
  const allOrderIds = new Set();
  const orderById = new Map();
  for (const order of orders) {
    if (!order || typeof order.id !== "string" || !order.id || allOrderIds.has(order.id)) throw new Error("inventory_variance_fact_invalid");
    allOrderIds.add(order.id);
    orderById.set(order.id, order);
    if (saleConsumptions !== null) continue;
    if (!PAID_STATUSES.has(order.status)) continue;
    if (!validTimestamp(order.paidAt)) { blockers.add("PAID_TIMESTAMP_MISSING"); continue; }
    if (withinPeriod(order.paidAt, openingAt, closingAt)) selected.push(order);
  }
  if (saleConsumptions !== null) {
    for (const consumption of saleConsumptions) {
      if (!withinPeriod(consumption.occurredAt, openingAt, closingAt)) continue;
      const order = orderById.get(consumption.orderId);
      if (!order) { blockers.add("CONSUMPTION_ORDER_MISSING"); continue; }
      selected.push(order);
    }
  }
  const selectedIds = new Set(selected.map((order) => order.id));
  const rows = new Map();
  const itemIds = new Set();
  const orderIdsWithItems = new Set();
  let soldItemQuantity = 0;
  let verifiedItemQuantity = 0;
  for (const item of orderItems.filter((row) => selectedIds.has(row.orderId))) {
    if (!item || typeof item.id !== "string" || !item.id || itemIds.has(item.id) || !Number.isSafeInteger(item.qty) || item.qty <= 0 || typeof item.productNameSnapshot !== "string" || !item.productNameSnapshot.trim()) throw new Error("inventory_variance_fact_invalid");
    itemIds.add(item.id); orderIdsWithItems.add(item.orderId); soldItemQuantity = safeMoney(soldItemQuantity + item.qty);
    if (item.hppSnapshotStatus !== "VERIFIED" || !item.recipeSnapshot || item.recipeSnapshot.status !== "VERIFIED" || !Array.isArray(item.recipeSnapshot.lines) || item.recipeSnapshot.lines.length === 0) { blockers.add("RECIPE_COVERAGE_INCOMPLETE"); continue; }
    verifiedItemQuantity = safeMoney(verifiedItemQuantity + item.qty);
    const lineIds = new Set();
    for (const line of item.recipeSnapshot.lines) {
      if (!line || !ingredientById.has(line.ingredientId) || lineIds.has(line.ingredientId) || !validPositiveQuantity(line.qty) || line.unit !== ingredientById.get(line.ingredientId).baseUnit || !Number.isFinite(line.unitCostRupiah) || line.unitCostRupiah < 0 || !Number.isSafeInteger(line.costRupiah) || line.costRupiah < 0 || line.complete !== true || Math.round(line.qty * line.unitCostRupiah) !== line.costRupiah) throw new Error("inventory_variance_fact_invalid");
      lineIds.add(line.ingredientId);
      const row = rows.get(line.ingredientId) ?? { quantityBase: 0, valueRupiah: 0, sourceProducts: new Map() };
      row.quantityBase = safeQuantity(row.quantityBase + line.qty * item.qty);
      row.valueRupiah = safeMoney(row.valueRupiah + line.costRupiah * item.qty);
      row.sourceProducts.set(item.productNameSnapshot, safeMoney((row.sourceProducts.get(item.productNameSnapshot) ?? 0) + item.qty));
      rows.set(line.ingredientId, row);
    }
  }
  if (selected.some((order) => !orderIdsWithItems.has(order.id))) blockers.add("ORDER_ITEM_MISSING");
  const status = blockers.has("RECIPE_COVERAGE_INCOMPLETE") || blockers.has("ORDER_ITEM_MISSING") ? "PARTIAL" : "VERIFIED";
  return { rows, blockers, status, orderCount: selected.length, soldItemQuantity, verifiedItemQuantity, coveragePct: soldItemQuantity ? Math.round(verifiedItemQuantity / soldItemQuantity * 100) : selected.length ? 0 : 100 };
}

function validateDepletionMovement(movement, ingredientById) {
  if (!ingredientById.has(movement.ingredientId) || !validPositiveQuantity(movement.quantityInputBase) || !Number.isSafeInteger(movement.inventoryValueDeltaRupiah) || movement.inventoryValueDeltaRupiah > 0 || !validTimestamp(movement.occurredAt)) throw new Error("inventory_variance_fact_invalid");
}

function attachEvidence(rows) {
  let remaining = MAX_EVIDENCE_ENTRIES;
  let totalEntries = 0;
  let shownEntries = 0;
  for (const row of rows) {
    const purchases = row.purchaseEvidenceEntries.map((entry) => ({ kind: "purchase", entry }));
    const depletions = row.depletionEvidenceEntries.map((entry) => ({ kind: "depletion", entry }));
    const combined = [...purchases, ...depletions].sort((a, b) => b.entry.occurredAt.localeCompare(a.entry.occurredAt) || a.entry.reference.localeCompare(b.entry.reference));
    totalEntries += combined.length;
    const selected = combined.slice(0, remaining);
    remaining -= selected.length;
    shownEntries += selected.length;
    const purchaseEntries = selected.filter((item) => item.kind === "purchase").map((item) => item.entry);
    const depletionEntries = selected.filter((item) => item.kind === "depletion").map((item) => item.entry);
    row.purchaseEvidence = { totalCount: purchases.length, shownCount: purchaseEntries.length, truncated: purchaseEntries.length < purchases.length, entries: purchaseEntries };
    row.depletionEvidence = { totalCount: depletions.length, shownCount: depletionEntries.length, truncated: depletionEntries.length < depletions.length, entries: depletionEntries };
    delete row.purchaseEvidenceEntries;
    delete row.depletionEvidenceEntries;
  }
  return { maxEntries: MAX_EVIDENCE_ENTRIES, shownEntries, totalEntries, truncated: shownEntries < totalEntries };
}

function evidenceText(value, fallback, maxLength) {
  if (value == null) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f]/.test(value)) throw new Error("inventory_variance_fact_invalid");
  return value.trim();
}

function emptyReport(availableCounts, usePreparingBoundary) {
  return { version: 1, status: "REQUIRES_TWO_COUNTS", basis: usePreparingBoundary ? "FULL_COUNTS_NET_PURCHASE_RECEIPTS_PREPARING_RECIPE_SNAPSHOTS" : "FULL_COUNTS_NET_PURCHASE_RECEIPTS_PAID_RECIPE_SNAPSHOTS_LEGACY", boundary: BOUNDARY, openingCount: null, closingCount: null, availableCounts, purchaseReceiptCount: 0, supplierReturnCount: 0, supplierReplacementReceiptCount: 0, orderCount: 0, soldItemQuantity: 0, verifiedItemQuantity: 0, coveragePct: null, actualUsageValueRupiah: null, theoreticalUsageValueRupiah: null, varianceValueRupiah: null, recordedWasteValueRupiah: 0, evidence: { maxEntries: MAX_EVIDENCE_ENTRIES, shownEntries: 0, totalEntries: 0, truncated: false }, blockers: ["TWO_FULL_COUNTS_REQUIRED"], rows: [] };
}

function countSummary(count) { return { id: count.id, completedAt: count.completedAt, lineCount: count.lineCount, reason: count.reason ?? "" }; }
function withinPeriod(value, openingAt, closingAt) { return Date.parse(value) > Date.parse(openingAt) && Date.parse(value) <= Date.parse(closingAt); }
function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validQuantity(value) { return Number.isFinite(value) && value >= 0 && Math.round(value * 1000) === value * 1000; }
function validPositiveQuantity(value) { return validQuantity(value) && value > 0; }
function safeQuantity(value) { const rounded = Math.round(value * 1000) / 1000; if (!Number.isFinite(rounded) || rounded < 0 || rounded > Number.MAX_SAFE_INTEGER / 1000) throw new Error("inventory_variance_overflow"); return rounded; }
function safeSignedQuantity(value) { const rounded = Math.round(value * 1000) / 1000; if (!Number.isFinite(rounded) || Math.abs(rounded) > Number.MAX_SAFE_INTEGER / 1000) throw new Error("inventory_variance_overflow"); return rounded; }
function safeMoney(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error("inventory_variance_overflow"); return value; }
function safeSignedMoney(value) { if (!Number.isSafeInteger(value)) throw new Error("inventory_variance_overflow"); return value; }
function sumRows(rows, key) { return rows.reduce((sum, row) => safeSignedMoney(sum + row[key]), 0); }
function csvCell(value) { let text = value == null ? "" : String(value); if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; }
