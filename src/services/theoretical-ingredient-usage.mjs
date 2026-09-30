const PAID_STATUSES = new Set(["PAID", "COMPLETED"]);
const BASE_UNITS = new Set(["gram", "ml", "pcs"]);

export function buildTheoreticalIngredientUsage({ orders = [], orderItems = [], businessDate } = {}) {
  assertBusinessDate(businessDate);
  const selectedOrders = orders.filter((order) => PAID_STATUSES.has(order.status) && String(order.businessDate).slice(0, 10) === businessDate);
  const orderIds = new Set();
  for (const order of selectedOrders) {
    if (typeof order.id !== "string" || !order.id || orderIds.has(order.id)) throw new Error("theoretical_usage_duplicate_order");
    orderIds.add(order.id);
  }

  const selectedItems = orderItems.filter((item) => orderIds.has(item.orderId));
  const itemIds = new Set();
  const orderIdsWithItems = new Set();
  const rowsByIngredient = new Map();
  const incompleteProducts = new Set();
  const modifierBlockedProducts = new Set();
  let soldItemQuantity = 0;
  let verifiedItemQuantity = 0;
  let verifiedTheoreticalCostRupiah = 0;

  for (const item of selectedItems) {
    if (typeof item.id !== "string" || !item.id || itemIds.has(item.id)) throw new Error("theoretical_usage_duplicate_item");
    itemIds.add(item.id);
    orderIdsWithItems.add(item.orderId);
    if (!Number.isSafeInteger(item.qty) || item.qty <= 0 || typeof item.productNameSnapshot !== "string" || !item.productNameSnapshot.trim()) throw new Error("theoretical_usage_snapshot_invalid");
    soldItemQuantity = safeAdd(soldItemQuantity, item.qty);

    const snapshot = item.recipeSnapshot;
    if (snapshot?.modifierCostStatus === "UNMAPPED_PRICED_MODIFIER") {
      modifierBlockedProducts.add(item.productNameSnapshot);
    }
    if (item.hppSnapshotStatus !== "VERIFIED") {
      incompleteProducts.add(item.productNameSnapshot);
      continue;
    }
    if (!snapshot || snapshot.status !== "VERIFIED" || !Array.isArray(snapshot.lines) || !snapshot.lines.length) throw new Error("theoretical_usage_snapshot_invalid");
    verifiedItemQuantity = safeAdd(verifiedItemQuantity, item.qty);
    const ingredientIdsInItem = new Set();

    for (const line of snapshot.lines) {
      validateLine(line);
      if (ingredientIdsInItem.has(line.ingredientId)) throw new Error("theoretical_usage_snapshot_invalid");
      ingredientIdsInItem.add(line.ingredientId);
      const quantityBase = safeQuantity(line.qty * item.qty);
      const theoreticalCostRupiah = safeMultiplyMoney(line.costRupiah, item.qty);
      verifiedTheoreticalCostRupiah = safeAdd(verifiedTheoreticalCostRupiah, theoreticalCostRupiah);
      // Name or base-unit changes must not rewrite history or make the whole report unavailable.
      // Keep distinct immutable variants instead of adding incompatible quantities together.
      const groupingKey = JSON.stringify([line.ingredientId, line.name, line.unit]);
      const existing = rowsByIngredient.get(groupingKey);
      const row = existing ?? { ingredientId: line.ingredientId, name: line.name, unit: line.unit, quantityBase: 0, theoreticalCostRupiah: 0, products: new Map() };
      row.quantityBase = safeQuantity(row.quantityBase + quantityBase);
      row.theoreticalCostRupiah = safeAdd(row.theoreticalCostRupiah, theoreticalCostRupiah);
      row.products.set(item.productNameSnapshot, safeAdd(row.products.get(item.productNameSnapshot) ?? 0, item.qty));
      rowsByIngredient.set(groupingKey, row);
    }
  }

  const missingOrderCount = selectedOrders.length - orderIdsWithItems.size;
  const allVerified = selectedOrders.length > 0 && missingOrderCount === 0 && soldItemQuantity > 0 && verifiedItemQuantity === soldItemQuantity;
  const status = !selectedOrders.length ? "NO_SALES" : allVerified ? "VERIFIED" : verifiedItemQuantity > 0 ? "PARTIAL" : "INCOMPLETE";
  const rows = [...rowsByIngredient.values()].map((row) => ({
    ingredientId: row.ingredientId,
    name: row.name,
    unit: row.unit,
    quantityBase: row.quantityBase,
    theoreticalCostRupiah: row.theoreticalCostRupiah,
    sourceProducts: [...row.products].map(([name, qty]) => ({ name, qty })).sort((a, b) => a.name.localeCompare(b.name, "id")),
  })).sort((a, b) => b.theoreticalCostRupiah - a.theoreticalCostRupiah || a.name.localeCompare(b.name, "id"));

  return {
    version: 1,
    businessDate,
    basis: "PAID_COMPLETED_ORDER_RECIPE_SNAPSHOT",
    status,
    orderCount: selectedOrders.length,
    missingOrderCount,
    soldItemQuantity,
    verifiedItemQuantity,
    excludedItemQuantity: soldItemQuantity - verifiedItemQuantity,
    coveragePct: soldItemQuantity ? Math.round(verifiedItemQuantity / soldItemQuantity * 100) : selectedOrders.length ? 0 : null,
    verifiedTheoreticalCostRupiah,
    theoreticalCostRupiah: allVerified ? verifiedTheoreticalCostRupiah : null,
    incompleteProducts: [...incompleteProducts].sort((a, b) => a.localeCompare(b, "id")),
    modifierBlockedProducts: [...modifierBlockedProducts].sort((a, b) => a.localeCompare(b, "id")),
    rows,
    actualUsageStatus: "REQUIRES_OPENING_AND_CLOSING_COUNTS",
    modifierRecipeStatus: modifierBlockedProducts.size ? "UNMAPPED_PRICED_MODIFIER" : "BASE_RECIPE_ONLY",
  };
}

export function theoreticalIngredientUsageCsv(report) {
  if (!report || report.version !== 1 || !Array.isArray(report.rows)) throw new Error("theoretical_usage_report_invalid");
  const totalScope = report.theoreticalCostRupiah == null ? "Verified subset only" : "Complete verified coverage";
  const rows = [
    ["Saga POS - pemakaian bahan teoretis"],
    ["Tanggal bisnis WIB", report.businessDate],
    ["Basis", "Order PAID/COMPLETED x immutable recipe snapshot"],
    ["Status", report.status],
    ["Coverage menu terjual", report.coveragePct == null ? "N/A" : `${report.coveragePct}%`],
    ["Biaya teoretis subset terverifikasi", report.verifiedTheoreticalCostRupiah],
    ["Biaya teoretis seluruh penjualan", report.theoreticalCostRupiah],
    ["Scope nilai", totalScope],
    ["Pemakaian aktual", "Belum tersedia; memerlukan stock count pembuka dan penutup"],
    ["Modifier", report.modifierRecipeStatus === "UNMAPPED_PRICED_MODIFIER" ? `Priced modifier belum punya mapping HPP: ${(report.modifierBlockedProducts ?? []).join("; ")}` : "Resep dasar saja; tidak ada priced modifier yang mengubah HPP pada snapshot ini"],
    [],
    ["Bahan", "Jumlah teoretis", "Satuan dasar", "Biaya snapshot Rupiah", "Sumber menu"],
    ...report.rows.map((row) => [row.name, row.quantityBase, row.unit, row.theoreticalCostRupiah, row.sourceProducts.map((item) => `${item.name} x ${item.qty}`).join("; ")]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function validateLine(line) {
  if (!line || typeof line.ingredientId !== "string" || !line.ingredientId || typeof line.name !== "string" || !line.name.trim() || !BASE_UNITS.has(line.unit) || !Number.isFinite(line.qty) || line.qty <= 0 || !Number.isFinite(line.unitCostRupiah) || line.unitCostRupiah < 0 || !Number.isSafeInteger(line.costRupiah) || line.costRupiah < 0 || line.complete !== true) throw new Error("theoretical_usage_snapshot_invalid");
  if (Math.round(line.qty * line.unitCostRupiah) !== line.costRupiah) throw new Error("theoretical_usage_snapshot_invalid");
}

function safeQuantity(value) {
  const rounded = Math.round(value * 1000) / 1000;
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > Number.MAX_SAFE_INTEGER / 1000) throw new Error("theoretical_usage_overflow");
  return rounded;
}

function safeMultiplyMoney(value, multiplier) {
  const result = value * multiplier;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("theoretical_usage_overflow");
  return result;
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("theoretical_usage_overflow");
  return result;
}

function assertBusinessDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("report_date_invalid");
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
