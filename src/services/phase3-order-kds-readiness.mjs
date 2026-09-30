export const PHASE3_ORDER_KDS_VERSION = 1;

export function buildPhase3InventorySimulation({ order = {}, orderItems = [], hpp = {}, simulatedAt = new Date().toISOString() } = {}) {
  const items = array(orderItems);
  const balanceByIngredient = new Map(array(hpp.inventoryBalances).map((item) => [item.ingredientId, item]));
  const ingredientById = new Map(array(hpp.ingredients).map((item) => [item.id, item]));
  const aggregate = new Map();
  let incompleteItemCount = 0;

  for (const item of items) {
    const quantity = positive(item.qty);
    const recipe = object(item.recipeSnapshot);
    const lines = array(recipe.lines);
    const verified = item.hppSnapshotStatus === "VERIFIED" && recipe.status === "VERIFIED" && lines.length > 0 && quantity != null;
    if (!verified) {
      incompleteItemCount += 1;
      continue;
    }
    for (const line of lines) {
      const ingredientId = string(line.ingredientId);
      const recipeQuantity = positive(line.qty);
      if (!ingredientId || recipeQuantity == null || line.complete === false) {
        incompleteItemCount += 1;
        continue;
      }
      const requiredQuantityBase = round(recipeQuantity * quantity);
      const existing = aggregate.get(ingredientId) ?? { ingredientId, requiredQuantityBase: 0 };
      existing.requiredQuantityBase = round(existing.requiredQuantityBase + requiredQuantityBase);
      aggregate.set(ingredientId, existing);
    }
  }

  const lines = [...aggregate.values()].map((line) => {
    const ingredient = ingredientById.get(line.ingredientId);
    const balance = balanceByIngredient.get(line.ingredientId);
    const availableQuantityBase = finite(balance?.availableQuantityBase) ?? finite(balance?.quantityBase);
    const missingBalance = availableQuantityBase == null;
    const shortageQuantityBase = missingBalance ? null : round(Math.max(0, line.requiredQuantityBase - availableQuantityBase));
    return {
      ...line,
      ingredientName: ingredient?.name ?? "Bahan tidak ditemukan",
      baseUnit: ingredient?.baseUnit ?? null,
      availableQuantityBase,
      missingBalance,
      sufficient: !missingBalance && shortageQuantityBase === 0,
      shortageQuantityBase,
    };
  }).sort((a, b) => a.ingredientName.localeCompare(b.ingredientName, "id"));

  const missingBalanceCount = lines.filter((item) => item.missingBalance).length;
  const shortageCount = lines.filter((item) => !item.missingBalance && !item.sufficient).length;
  const totalHppRupiah = items.length > 0 && incompleteItemCount === 0
    ? items.reduce((sum, item) => sum + integer(item.recipeCostSnapshotRupiah) * integer(item.qty), 0)
    : null;
  const state = incompleteItemCount > 0 || lines.length === 0
    ? "INCOMPLETE_RECIPE"
    : missingBalanceCount > 0 || shortageCount > 0
      ? "SHORTAGE"
      : "READY";

  return {
    version: PHASE3_ORDER_KDS_VERSION,
    state,
    simulatedAt,
    orderNumber: string(order.orderNumber) || null,
    inventoryChanged: false,
    businessFactsAffected: false,
    ingredientCount: lines.length,
    sufficientCount: lines.filter((item) => item.sufficient).length,
    shortageCount,
    missingBalanceCount,
    incompleteItemCount,
    hppSnapshotStatus: incompleteItemCount === 0 && items.length > 0 ? "VERIFIED" : "INCOMPLETE",
    totalHppRupiah,
    lines,
  };
}

export function buildPhase3OrderKdsReadiness({ catalog = [], hpp = {}, fulfillments = [], tableOrder = {}, paymentMode = "OFF", generatedAt = new Date().toISOString() } = {}) {
  const products = array(catalog).flatMap((category) => array(category?.products)).filter((item) => item?.status === "active" && item?.archived !== true);
  const hppProducts = new Map(array(hpp.products).map((item) => [item.id, item]));
  const verifiedProducts = products.filter((item) => hppProducts.get(item.id)?.hppStatus === "VERIFIED");
  const ingredients = array(hpp.ingredients).filter((item) => String(item?.status ?? "ACTIVE").toUpperCase() !== "ARCHIVED");
  const balances = new Map(array(hpp.inventoryBalances).map((item) => [item.ingredientId, item]));
  const balancedIngredients = ingredients.filter((item) => balances.has(item.id));
  const rehearsals = array(fulfillments).filter((item) => item?.testMode === true && item?.phase3Simulation?.version === PHASE3_ORDER_KDS_VERSION);
  const successfulRehearsals = rehearsals.filter((item) => item.phase3Simulation.state === "READY" && item.phase3Simulation.inventoryChanged === false);
  const isolated = tableOrder?.businessFactsAffected === false;
  const checks = [
    check("payment-off", "Pembayaran nyata tetap nonaktif", String(paymentMode).toUpperCase() === "OFF", `Mode pembayaran ${String(paymentMode).toUpperCase() || "UNKNOWN"}`),
    check("table-isolated", "Order meja uji terisolasi dari fakta bisnis", isolated, isolated ? "businessFactsAffected=false" : "Isolasi order uji belum terbukti"),
    check("kds-ready", "Antrean KDS persisten siap", tableOrder?.ready === true, tableOrder?.ready === true ? "Health Table Order/KDS siap" : "Health Table Order/KDS belum siap"),
    check("menu-hpp", "Menu aktif memiliki HPP terverifikasi", products.length > 0 && verifiedProducts.length === products.length, `${verifiedProducts.length}/${products.length} menu aktif`),
    check("inventory-balances", "Bahan aktif memiliki saldo operasional", ingredients.length > 0 && balancedIngredients.length === ingredients.length, `${balancedIngredients.length}/${ingredients.length} bahan memiliki saldo`),
    check("rehearsal", "Order uji pernah mencapai Mulai Buat", successfulRehearsals.length > 0, successfulRehearsals.length > 0 ? `${successfulRehearsals.length} rehearsal aman` : "Belum ada rehearsal READY pada kandidat ini"),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  return {
    version: PHASE3_ORDER_KDS_VERSION,
    phase: "PHASE_3_ORDER_KDS_HPP",
    state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    generatedAt,
    note: "Order uji memvalidasi alur Kiosk/Table Order ke KDS dan dampak stok/HPP secara simulasi. Stok produksi hanya berubah pada order bisnis ketika Mulai Buat.",
    checks,
  };
}

function check(id, label, complete, detail) { return { id, label, complete: complete === true, detail: String(detail ?? "") }; }
function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function string(value) { return typeof value === "string" ? value.trim() : ""; }
function finite(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null; }
function positive(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
function integer(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function round(value) { return Math.round((value + Number.EPSILON) * 1000) / 1000; }
