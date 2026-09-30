const HPP_STATUSES = Object.freeze(["NOT_SET", "DRAFT", "VERIFIED", "NEEDS_REVIEW"]);

export function buildOwnerInventoryWorkspace({ hpp, catalog, context, generatedAt, businessDate, source, orders = [], orderItems = [] }) {
  const primaryLocationId = `${context.outletId}:USABLE`;
  const ingredients = (hpp.ingredients ?? []).map((ingredient) => ({
    id: ingredient.id,
    sku: ingredient.code ?? ingredient.sku ?? null,
    name: ingredient.name,
    category: ingredient.category ?? "UMUM",
    categoryId: ingredient.categoryId ?? null,
    type: ingredient.type ?? "RAW_MATERIAL",
    materialType: ingredient.materialType ?? ingredient.type ?? "RAW_MATERIAL",
    sourcingMode: ingredient.sourcingMode ?? (ingredient.purchasable === false ? "MADE_IN_HOUSE" : "PURCHASED"),
    status: ingredient.status ?? "ACTIVE",
    purchasable: ingredient.purchasable ?? true,
    baseUom: ingredient.baseUnit,
    costStatus: ingredient.costStatus ?? (ingredient.costPerUnitRupiah == null ? "UNPRICED" : "PRICED"),
    costSource: ingredient.costSource ?? (ingredient.costPerUnitRupiah == null ? "UNPRICED" : "MANUAL"),
    currentAverageCostPerBaseUnitRupiah: decimalOrNull(ingredient.costPerUnitRupiah),
    lotTrackingPolicy: ingredient.lotTrackingPolicy ?? "NOT_REQUIRED",
    minimumShelfLifeDays: integerOrZero(ingredient.minimumShelfLifeDays),
    revision: ingredient.revision ?? hpp.version,
    updatedAt: ingredient.updatedAt ?? null,
  }));
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const balances = (hpp.inventoryBalances ?? []).map((balance) => ({
    ingredientId: balance.ingredientId,
    ingredientName: ingredientById.get(balance.ingredientId)?.name ?? "Bahan tidak ditemukan",
    locationId: balance.locationId ?? primaryLocationId,
    onHandBase: decimalOrZero(balance.quantityBase),
    reservedBase: decimalOrZero(balance.reservedQuantityBase),
    availableBase: decimalOrZero(balance.availableQuantityBase),
    inventoryValueRupiah: integerOrZero(balance.inventoryValueRupiah),
    averageCostPerBaseUnitRupiah: decimalOrNull(balance.averageCostPerBaseUnitRupiah),
    baseUom: ingredientById.get(balance.ingredientId)?.baseUom ?? null,
  }));
  const catalogProducts = (catalog ?? []).flatMap((category) => (category.products ?? []).map((product) => ({ ...product, categoryName: category.name })));
  const hppByProduct = new Map((hpp.products ?? []).map((product) => [product.id, product]));
  const draftByProduct = new Map((hpp.recipeDrafts ?? []).map((draft) => [draft.productId, draft]));
  const publishedByProduct = new Map();
  for (const published of hpp.publishedRecipes ?? []) {
    const list = publishedByProduct.get(published.productId) ?? [];
    list.push(published);
    publishedByProduct.set(published.productId, list);
  }
  const menus = catalogProducts.map((product) => menuHppRow(product, hppByProduct.get(product.id), draftByProduct.get(product.id), publishedByProduct.get(product.id) ?? []));
  const statusCount = Object.fromEntries(HPP_STATUSES.map((status) => [status, menus.filter((menu) => menu.hppStatus === status).length]));
  const onHandValueRupiah = balances.reduce((sum, balance) => sum + balance.inventoryValueRupiah, 0);
  const verifiedCount = statusCount.VERIFIED;
  const warehouseLedger = buildWarehouseLedger(hpp, ingredientById, balances, primaryLocationId);
  // Bar and Kitchen are fulfillment stations, not separate physical stock stores in this pilot.
  // Preserve old receipt/movement facts, but report one shared on-hand balance per ingredient.
  const locationProjection = {
    rows: balances.map((balance) => ({ ...balance, locationId: primaryLocationId })),
    status: warehouseLedger.reconciliation.status,
    unlocatedMovementCount: 0,
    legacyTransferCount: 0,
  };
  const lotProjection = buildLotReconciliation(hpp, ingredientById, businessDate, warehouseLedger.reconciliation.completeHistory);
  const offlineSales = buildOfflineSaleReconciliation(hpp, ingredientById);
  warehouseLedger.reconciliation.aggregateStatus = warehouseLedger.reconciliation.status;
  warehouseLedger.reconciliation.locationStatus = locationProjection.status;
  warehouseLedger.reconciliation.unlocatedMovementCount = locationProjection.unlocatedMovementCount;
  warehouseLedger.reconciliation.legacyTransferCount = locationProjection.legacyTransferCount;
  warehouseLedger.reconciliation.lotStatus = lotProjection.status;
  if (warehouseLedger.reconciliation.status === "VERIFIED" && locationProjection.status !== "VERIFIED") warehouseLedger.reconciliation.status = "LOCATION_UNVERIFIED";
  if (warehouseLedger.reconciliation.status === "VERIFIED" && !["VERIFIED", "NOT_TRACKED"].includes(lotProjection.status)) warehouseLedger.reconciliation.status = "LOT_UNVERIFIED";
  const quality = buildHppQuality({ menus, ingredients, hpp, orders, orderItems });
  const phase2 = buildPhase2InventoryReadiness({
    ingredients,
    balances,
    menus,
    supplierPackages: hpp.ingredientSupplierPackages ?? [],
    inventoryCounts: hpp.inventoryCounts ?? [],
    generatedAt,
  });

  return {
    schemaVersion: 1,
    generatedAt,
    businessDate,
    revision: hpp.version,
    source,
    activeTab: "ingredients",
    freshness: { status: "FRESH", checkedAt: generatedAt },
    capabilities: {
      ingredientWrite: true,
      ingredientArchive: true,
      conversionWrite: true,
      supplierPackageWrite: true,
      categoryWrite: true,
      purchaseOptionWrite: true,
      referencePriceWrite: true,
      referencePriceHistoryRead: true,
      receiptWrite: true,
      reversalWrite: true,
      transferWrite: false,
      countWrite: true,
      recipeDraftWrite: true,
      recipePublish: true,
      ledgerDetailRead: true,
      prepRecipeWrite: true,
      prepProductionWrite: true,
    },
    summary: {
      ingredientCount: ingredients.length,
      activeIngredientCount: ingredients.filter((ingredient) => ingredient.status === "ACTIVE").length,
      archivedIngredientCount: ingredients.filter((ingredient) => ingredient.status === "ARCHIVED").length,
      unpricedIngredientCount: ingredients.filter((ingredient) => ingredient.costStatus !== "PRICED").length,
      onHandValueRupiah,
      menuCount: menus.length,
      hppNotSetCount: statusCount.NOT_SET,
      hppDraftCount: statusCount.DRAFT,
      hppVerifiedCount: verifiedCount,
      hppNeedsReviewCount: statusCount.NEEDS_REVIEW,
    },
    phase2,
    ingredients: {
      items: ingredients,
      categories: (hpp.materialCategories ?? []).map((item) => ({ ...item })),
      uoms: [...new Set([...ingredients.map((ingredient) => ingredient.baseUom), ...(hpp.ingredientConversions ?? []).flatMap((item) => [item.fromUom, item.toUom])].filter(Boolean))].sort(),
      conversions: (hpp.ingredientConversions ?? []).map((item) => ({ ...item })),
      conversionHistory: (hpp.ingredientConversionHistory ?? []).map((item) => ({ ...item })),
      supplierPackages: (hpp.ingredientSupplierPackages ?? []).map((item) => ({ ...item })),
      supplierPackageHistory: (hpp.ingredientSupplierPackageHistory ?? []).map((item) => ({ ...item })),
      purchaseOptions: (hpp.ingredientSupplierPackages ?? []).filter((item) => item.purchaseOptionId).map((item) => ({ ...item, supplierName: item.supplierName === "Belum ditentukan" ? null : item.supplierName })),
      purchaseOptionHistory: (hpp.ingredientSupplierPackageHistory ?? []).filter((item) => item.purchaseOptionId).map((item) => ({ ...item })),
      referencePriceHistory: (hpp.ingredientReferencePriceVersions ?? []).map((item) => ({ ...item })),
      productionRecipes: (hpp.ingredientProductionRecipes ?? hpp.productionRecipes ?? []).map((item) => ({ ...item })),
    },
    productionRecipes: (hpp.ingredientProductionRecipes ?? hpp.productionRecipes ?? []).map((item) => ({ ...item })),
    warehouse: {
      locations: [{ id: primaryLocationId, name: `${context.outletName} · Penyimpanan bersama`, type: "PRIMARY_USABLE_STOCK" }],
      storagePolicy: "SHARED_WAREHOUSE_BAR_KITCHEN",
      balances,
      locationBalances: locationProjection.rows,
      lotReconciliation: lotProjection,
      expiringLots: buildExpiringLots(hpp, ingredientById, businessDate),
      recentMovements: (hpp.inventoryMovements ?? []).slice(0, 20),
      recentReceipts: (hpp.purchaseReceipts ?? []).filter((receipt) => (receipt.lines ?? []).length > 0).slice(0, 20).map((receipt) => ({
        id: receipt.id,
        idempotencyKey: receipt.idempotencyKey,
        supplierName: receipt.supplierName,
        destinationLocationId: receipt.destinationLocationId ?? primaryLocationId,
        receivedAt: receipt.receivedAt,
        totalCostRupiah: integerOrZero(receipt.totalCostRupiah),
        lines: receipt.lines.map((line) => ({
          ingredientId: line.ingredientId,
          ingredientName: ingredientById.get(line.ingredientId)?.name ?? "Bahan tidak ditemukan",
          baseUom: ingredientById.get(line.ingredientId)?.baseUom ?? "",
          baseQuantity: decimalOrZero(line.baseQuantity),
          totalCostRupiah: integerOrZero(line.totalCostRupiah),
          lots: (receipt.lots ?? []).filter((lot) => lot.ingredientId === line.ingredientId && lot.acceptedPurchaseQuantity > 0).map((lot) => ({
            lotCode: lot.lotCode,
            expiryDate: lot.expiryDate,
          })),
        })),
      })),
      ledgerEntries: warehouseLedger.entries.slice(0, 100),
      ledgerReconciliation: warehouseLedger.reconciliation,
      countSessions: (hpp.inventoryCounts ?? []).slice(0, 10),
      activeReservationCount: integerOrZero(hpp.activeInventoryReservationCount),
      offlineSales,
    },
    hpp: {
      menus,
      drafts: (hpp.recipeDrafts ?? []).map((draft) => ({ ...draft })),
      publishedRecipes: (hpp.publishedRecipes ?? []).map((published) => ({ ...published })),
      coverage: {
        status: menus.length && verifiedCount === menus.length ? "VERIFIED" : "INCOMPLETE",
        percent: menus.length ? Math.round((verifiedCount / menus.length) * 100) : 0,
        blockingIssues: [],
        warnings: menus.filter((menu) => menu.hppStatus !== "VERIFIED").map((menu) => ({ productId: menu.productId, issues: menu.issues })),
      },
      quality,
    },
    conflict: null,
    lastOperation: null,
  };
}

export function buildPhase2InventoryReadiness({ ingredients = [], balances = [], menus = [], supplierPackages = [], inventoryCounts = [], generatedAt = new Date().toISOString() } = {}) {
  const activeIngredients = ingredients.filter((item) => item?.status === "ACTIVE");
  const purchasedIngredients = activeIngredients.filter((item) => item?.sourcingMode !== "MADE_IN_HOUSE" && item?.purchasable !== false);
  const pricedIngredientIds = new Set(activeIngredients.filter((item) => item?.costStatus === "PRICED" && Number.isFinite(Number(item?.currentAverageCostPerBaseUnitRupiah))).map((item) => item.id));
  const packageIngredientIds = new Set(supplierPackages.filter((item) => item?.status !== "INACTIVE").map((item) => item?.ingredientId).filter(Boolean));
  const balanceIngredientIds = new Set(balances.map((item) => item?.ingredientId).filter(Boolean));
  const activeMenuRows = menus.filter((item) => item?.menuStatus === "ACTIVE");

  const missingCost = activeIngredients.filter((item) => !pricedIngredientIds.has(item.id));
  const missingPackage = purchasedIngredients.filter((item) => !packageIngredientIds.has(item.id));
  const missingBalance = activeIngredients.filter((item) => !balanceIngredientIds.has(item.id));
  const latestCompletedCount = inventoryCounts
    .filter((item) => item?.status === "COMPLETED")
    .slice()
    .sort((left, right) => String(right?.completedAt ?? "").localeCompare(String(left?.completedAt ?? "")))[0] ?? null;
  const latestCountIngredientIds = new Set((latestCompletedCount?.lines ?? []).map((item) => item?.ingredientId).filter(Boolean));
  const countMissing = activeIngredients.filter((item) => !latestCountIngredientIds.has(item.id));
  const incompleteMenus = activeMenuRows.filter((item) => item?.hppStatus !== "VERIFIED");

  const databaseChecks = [
    readinessCheck("active-ingredients", "Database bahan memiliki bahan aktif", activeIngredients.length > 0, `${activeIngredients.length} bahan aktif`),
    readinessCheck("ingredient-costs", "Semua bahan aktif memiliki biaya", activeIngredients.length > 0 && missingCost.length === 0, missingCost.length ? `${missingCost.length} bahan belum punya biaya` : `${activeIngredients.length}/${activeIngredients.length} bahan memiliki biaya`),
    readinessCheck("purchase-options", "Setiap bahan yang dibeli memiliki satuan beli", activeIngredients.length > 0 && (purchasedIngredients.length === 0 || missingPackage.length === 0), !activeIngredients.length ? "Belum ada bahan aktif" : missingPackage.length ? `${missingPackage.length} bahan belum punya satuan beli` : `${purchasedIngredients.length}/${purchasedIngredients.length} bahan pembelian siap`),
  ];
  const warehouseChecks = [
    readinessCheck("operational-balances", "Semua bahan aktif masuk saldo operasional", activeIngredients.length > 0 && missingBalance.length === 0, missingBalance.length ? `${missingBalance.length} bahan belum memiliki saldo gudang` : `${activeIngredients.length}/${activeIngredients.length} bahan memiliki saldo`),
    readinessCheck("opening-count", "Full stock count terbaru mencakup semua bahan aktif", activeIngredients.length > 0 && missingBalance.length === 0 && Boolean(latestCompletedCount) && countMissing.length === 0, !latestCompletedCount ? "Belum ada full stock count" : countMissing.length ? `${countMissing.length} bahan belum tercakup count terbaru` : `Count ${String(latestCompletedCount.completedAt ?? "").slice(0, 10)} lengkap`),
  ];
  const hppChecks = [
    readinessCheck("active-menus", "Menu aktif tersedia untuk dihitung", activeMenuRows.length > 0, `${activeMenuRows.length} menu aktif`),
    readinessCheck("verified-recipes", "Seluruh menu aktif memiliki HPP terverifikasi", activeMenuRows.length > 0 && incompleteMenus.length === 0, incompleteMenus.length ? `${incompleteMenus.length} menu perlu diselesaikan` : `${activeMenuRows.length}/${activeMenuRows.length} HPP menu terverifikasi`),
  ];
  const stages = [
    readinessStage("database", "1. Database bahan", "#inventory/database", databaseChecks, [
      ...missingCost.map((item) => queueItem("INGREDIENT_COST", item.id, item.name, "Lengkapi biaya bahan", "#inventory/database")),
      ...missingPackage.map((item) => queueItem("PURCHASE_OPTION", item.id, item.name, "Tambahkan satuan beli supplier", "#inventory/database")),
    ]),
    readinessStage("warehouse", "2. Baseline gudang", "#inventory/warehouse", warehouseChecks, [
      ...missingBalance.map((item) => queueItem("OPENING_STOCK", item.id, item.name, "Masukkan stok awal atau penerimaan", "#inventory/warehouse")),
      ...(latestCompletedCount && countMissing.length === 0 && missingBalance.length === 0 ? [] : [queueItem("FULL_COUNT", "latest", "Full stock count", latestCompletedCount ? "Ulangi count agar mencakup seluruh bahan" : "Hitung stok fisik setelah semua saldo bahan tersedia", "#inventory/warehouse")]),
    ]),
    readinessStage("hpp", "3. Resep & HPP menu", "#inventory/hpp", hppChecks, incompleteMenus.map((item) => queueItem("MENU_HPP", item.productId, item.menuName, hppAction(item.hppStatus), "#inventory/hpp", item.hppStatus))),
  ];
  const totalChecks = stages.reduce((sum, item) => sum + item.totalChecks, 0);
  const readyChecks = stages.reduce((sum, item) => sum + item.readyChecks, 0);
  const score = totalChecks ? Math.round(readyChecks / totalChecks * 100) : 0;
  return {
    version: 1,
    phase: "PHASE_2_INVENTORY_HPP",
    state: score === 100 ? "READY" : readyChecks ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    operationalDataReady: score === 100,
    generatedAt,
    note: "Phase 2 hanya dinyatakan siap jika bahan, baseline stok fisik, dan HPP menu berasal dari data tersimpan. Nilai kosong tidak dianggap nol.",
    stages,
  };
}

function readinessCheck(id, label, complete, detail) {
  return { id, label, complete: complete === true, detail: String(detail ?? "") };
}

function readinessStage(id, label, href, checks, queue) {
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = totalChecks ? Math.round(readyChecks / totalChecks * 100) : 0;
  return { id, label, href, state: score === 100 ? "READY" : readyChecks ? "PARTIAL" : "MISSING", score, readyChecks, totalChecks, checks, queue: queue.slice(0, 50), queueTotal: queue.length };
}

function queueItem(type, entityId, label, action, href, status = null) {
  return { type, entityId, label: String(label ?? "Item tanpa nama"), action, href, ...(status ? { status } : {}) };
}

function hppAction(status) {
  if (status === "DRAFT") return "Review lalu publish resep";
  if (status === "NEEDS_REVIEW") return "Tinjau ulang biaya lalu publish revisi";
  return "Tambahkan komponen resep dan publish";
}

function buildOfflineSaleReconciliation(hpp, ingredientById) {
  const offlineSales = (hpp.saleConsumptions ?? [])
    .filter((consumption) => consumption?.sourceEvent)
    .sort((left, right) => String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? "")));
  const reviewItems = offlineSales.filter((consumption) => consumption.requiresReview === true
    || consumption.status !== "APPLIED"
    || (consumption.lines ?? []).some((line) => line.status !== "APPLIED" || Number(line.shortageBase) > 0));
  return {
    status: reviewItems.length ? "NEEDS_REVIEW" : "RECONCILED",
    totalCount: offlineSales.length,
    needsReviewCount: reviewItems.length,
    shortageLineCount: reviewItems.reduce((sum, consumption) => sum
      + (consumption.lines ?? []).filter((line) => Number(line.shortageBase) > 0).length, 0),
    items: reviewItems.slice(0, 20).map((consumption) => ({
      orderNumber: consumption.orderNumber,
      occurredAt: consumption.occurredAt,
      status: consumption.status,
      itemCount: integerOrZero(consumption.itemCount),
      requiresReview: consumption.requiresReview === true,
      lines: (consumption.lines ?? []).map((line) => ({
        ingredientId: line.ingredientId,
        ingredientName: ingredientById.get(line.ingredientId)?.name ?? "Bahan tidak ditemukan",
        baseUom: ingredientById.get(line.ingredientId)?.baseUom ?? "unit",
        quantityRequiredBase: decimalOrZero(line.quantityRequiredBase),
        quantityAppliedBase: decimalOrZero(line.quantityAppliedBase),
        shortageBase: decimalOrZero(line.shortageBase),
        status: line.status,
      })),
    })),
  };
}

function buildHppQuality({ menus, ingredients, hpp, orders, orderItems }) {
  const menuRows = menus.map((menu) => ({
    recordType: "MENU",
    entityId: menu.productId,
    entityName: menu.menuName,
    status: menu.hppStatus,
    costCoverage: menu.costCoverage,
    issue: menu.issues.join("|"),
    orderStatus: "",
    quantity: "",
    reportableHppRupiah: menu.costCoverage === "COMPLETE" ? menu.currentHppRupiah : null,
  }));
  const ingredientRows = ingredients.filter((ingredient) => ingredient.costStatus !== "PRICED").map((ingredient) => ({
    recordType: "INGREDIENT",
    entityId: ingredient.id,
    entityName: ingredient.name,
    status: ingredient.status,
    costCoverage: "MISSING",
    issue: "INGREDIENT_COST_MISSING",
    orderStatus: "",
    quantity: "",
    reportableHppRupiah: null,
  }));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const saleRows = orderItems.filter((item) => orderById.has(item.orderId)).map((item) => {
    const order = orderById.get(item.orderId);
    const coverage = ["COMPLETE", "PARTIAL", "MISSING"].includes(item.costCoverage)
      ? item.costCoverage
      : item.hppSnapshotStatus === "VERIFIED" ? "COMPLETE" : item.recipeSnapshot?.lines?.length ? "PARTIAL" : "MISSING";
    return {
      recordType: "SALE_ITEM",
      entityId: order.orderNumber,
      entityName: item.productNameSnapshot ?? item.name ?? item.productId,
      status: item.hppSnapshotStatus ?? "UNVERIFIED",
      costCoverage: coverage,
      issue: coverage === "COMPLETE" ? "" : "SALE_HPP_COVERAGE_INCOMPLETE",
      orderStatus: order.status,
      quantity: item.qty,
      reportableHppRupiah: coverage === "COMPLETE" ? item.recipeCostSnapshotRupiah * item.qty : null,
    };
  });
  const saleCoverageCount = Object.fromEntries(["COMPLETE", "PARTIAL", "MISSING"].map((coverage) => [coverage, saleRows.filter((row) => row.costCoverage === coverage).length]));
  const orderStatusCount = Object.fromEntries([...new Set(orders.map((order) => order.status))].sort().map((status) => [status, orders.filter((order) => order.status === status).length]));
  const reservations = hpp.inventoryReservations ?? [];
  const consumptions = hpp.saleConsumptions ?? [];
  return {
    definitionVersion: 1,
    status: menus.every((menu) => menu.hppStatus === "VERIFIED") && ingredients.every((ingredient) => ingredient.costStatus === "PRICED") ? "VERIFIED" : "NEEDS_ATTENTION",
    summary: {
      menuCount: menus.length,
      verifiedMenuCount: menus.filter((menu) => menu.hppStatus === "VERIFIED").length,
      notSetMenuCount: menus.filter((menu) => menu.hppStatus === "NOT_SET").length,
      draftMenuCount: menus.filter((menu) => menu.hppStatus === "DRAFT").length,
      needsReviewMenuCount: menus.filter((menu) => menu.hppStatus === "NEEDS_REVIEW").length,
      unpricedIngredientCount: ingredientRows.length,
      saleItemCount: saleRows.length,
      saleCoverageCount,
      orderStatusCount,
      reservationCount: hpp.inventoryReservationCount ?? reservations.length,
      activeReservationCount: reservations.filter((item) => item.status === "ACTIVE").length,
      releasedReservationCount: hpp.releasedInventoryReservationCount ?? reservations.filter((item) => item.status === "RELEASED").length,
      consumedReservationCount: hpp.consumedInventoryReservationCount ?? reservations.filter((item) => item.status === "CONSUMED").length,
      consumptionCount: hpp.saleConsumptionCount ?? consumptions.length,
    },
    rows: [...menuRows, ...ingredientRows, ...saleRows],
  };
}

function menuHppRow(product, legacyHpp, draft, publishedVersions) {
  const recipeItems = legacyHpp?.recipeItems ?? [];
  const missingCostCount = integerOrZero(legacyHpp?.missingCostIngredientCount);
  const missingIngredientCount = integerOrZero(legacyHpp?.missingIngredientCount);
  const latestPublished = publishedVersions.slice().sort((a, b) => b.version - a.version)[0] ?? null;
  const currentCostLines = legacyHpp?.costLines ?? [];
  const publishedCostsStillCurrent = latestPublished ? latestPublished.items.every((line) => {
    const current = currentCostLines.find((item) => item.ingredientId === line.ingredientId);
    return current && current.complete && current.qty === line.qty && current.unitCostRupiah === line.unitCostRupiahSnapshot;
  }) && latestPublished.items.length === currentCostLines.length : false;
  let hppStatus = "NOT_SET";
  if (draft) hppStatus = "DRAFT";
  else if (latestPublished && legacyHpp?.hppStatus === "VERIFIED" && publishedCostsStillCurrent) hppStatus = "VERIFIED";
  else if (latestPublished) hppStatus = "NEEDS_REVIEW";
  else if (recipeItems.length && legacyHpp?.hppStatus === "VERIFIED") hppStatus = "VERIFIED";
  else if (recipeItems.length && missingCostCount) hppStatus = "NEEDS_REVIEW";
  else if (recipeItems.length) hppStatus = "DRAFT";
  const issues = missingIngredientCount
    ? ["RECIPE_INGREDIENT_REFERENCE_BROKEN"]
    : hppStatus === "NOT_SET"
    ? ["RECIPE_NOT_SET"]
    : hppStatus === "NEEDS_REVIEW"
      ? [missingCostCount ? "INGREDIENT_COST_MISSING" : "PUBLISHED_COST_CHANGED"]
      : hppStatus === "DRAFT"
        ? ["RECIPE_NOT_PUBLISHED"]
        : [];
  return {
    productId: product.id,
    menuName: product.name,
    categoryName: product.categoryName ?? null,
    menuStatus: product.status === "active" ? "ACTIVE" : "INACTIVE",
    hppStatus,
    costCoverage: legacyHpp?.hppStatus === "VERIFIED" ? "COMPLETE" : recipeItems.length || draft?.items?.length ? "PARTIAL" : "MISSING",
    currentHppRupiah: legacyHpp?.hppStatus === "VERIFIED" ? integerOrZero(legacyHpp.hppRupiah) : null,
    grossMarginPct: legacyHpp?.hppStatus === "VERIFIED" && Number.isFinite(Number(legacyHpp.marginPct)) ? Number(legacyHpp.marginPct) : null,
    sellingPriceRupiah: integerOrZero(product.priceRupiah),
    draftVersion: draft?.version ?? null,
    draft: draft ? { ...draft } : null,
    draftHppRupiah: draft?.simulation?.hppRupiah ?? null,
    draftMarginPct: draft?.simulation?.marginPct ?? null,
    publishedVersion: latestPublished?.version ?? null,
    missingCostIngredientCount: missingCostCount,
    missingIngredientCount,
    latestPublished,
    publishedVersionCount: publishedVersions.length,
    issues,
  };
}

function decimalOrNull(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(6);
}

function decimalOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(6) : "0.000000";
}

function integerOrZero(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function buildWarehouseLedger(hpp, ingredientById, balances, primaryLocationId) {
  const receiptEntries = (hpp.purchaseReceipts ?? []).flatMap((receipt) => (receipt.lines ?? []).map((line) => ({
    id: `receipt:${receipt.id}:${line.ingredientId}`,
    sourceType: "PURCHASE_RECEIPT",
    sourceLabel: receipt.supplierName,
    referenceId: receipt.id,
    ingredientId: line.ingredientId,
    ingredientName: ingredientById.get(line.ingredientId)?.name ?? "Bahan tidak ditemukan",
    locationId: receipt.destinationLocationId ?? primaryLocationId,
    quantityDeltaBase: decimalOrZero(line.baseQuantity),
    inventoryValueDeltaRupiah: integerOrZero(line.totalCostRupiah),
    unitCostSnapshotRupiah: line.baseQuantity > 0 ? decimalOrNull(line.totalCostRupiah / line.baseQuantity) : null,
    occurredAt: receipt.receivedAt,
    actorId: receipt.actorId,
    reason: receipt.reason,
    lotCode: receipt.lots?.find((lot) => lot.ingredientId === line.ingredientId)?.lotCode ?? null,
    expiryDate: receipt.lots?.find((lot) => lot.ingredientId === line.ingredientId)?.expiryDate ?? null,
    reversible: false,
  })));
  const movementEntries = (hpp.inventoryMovements ?? []).map((movement) => ({
    id: `movement:${movement.id}`,
    sourceType: movement.movementType,
    sourceLabel: movement.referenceCode ?? movement.reason,
    referenceId: movement.referenceId ?? movement.countSessionId ?? movement.id,
    ingredientId: movement.ingredientId,
    ingredientName: ingredientById.get(movement.ingredientId)?.name ?? "Bahan tidak ditemukan",
    locationId: movement.locationId ?? null,
    quantityDeltaBase: decimalOrZero(movement.quantityDeltaBase),
    inventoryValueDeltaRupiah: Number.isSafeInteger(movement.inventoryValueDeltaRupiah) ? movement.inventoryValueDeltaRupiah : 0,
    unitCostSnapshotRupiah: decimalOrNull(movement.unitCostSnapshotRupiah),
    occurredAt: movement.occurredAt,
    actorId: movement.actorId,
    reason: movement.reason,
    movementId: movement.id,
    reversible: !["REVERSAL", "TRANSFER_OUT", "TRANSFER_IN", "SALE_CONSUMPTION", "PRODUCTION_INPUT", "PRODUCTION_OUTPUT"].includes(movement.movementType)
      && !(hpp.inventoryMovements ?? []).some((candidate) => candidate.reversalOfMovementId === movement.id),
  }));
  const entries = [...receiptEntries, ...movementEntries].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt) || b.id.localeCompare(a.id));
  const completeHistory = integerOrZero(hpp.purchaseReceiptCount) === (hpp.purchaseReceipts ?? []).length
    && integerOrZero(hpp.inventoryMovementCount) === (hpp.inventoryMovements ?? []).length
    && integerOrZero(hpp.purchaseReceiptInspectionDecisionCount) === 0
    && !(hpp.supplierReturns ?? []).some((item) => item.status === "REPLACED");
  const rebuilt = new Map();
  for (const entry of entries) {
    const current = rebuilt.get(entry.ingredientId) ?? { quantityBase: 0, inventoryValueRupiah: 0 };
    rebuilt.set(entry.ingredientId, {
      quantityBase: Number(decimalOrZero(current.quantityBase + Number(entry.quantityDeltaBase))),
      inventoryValueRupiah: current.inventoryValueRupiah + entry.inventoryValueDeltaRupiah,
    });
  }
  const mismatches = balances.flatMap((balance) => {
    const calculated = rebuilt.get(balance.ingredientId) ?? { quantityBase: 0, inventoryValueRupiah: 0 };
    return Number(balance.onHandBase) === calculated.quantityBase && balance.inventoryValueRupiah === calculated.inventoryValueRupiah
      ? []
      : [{ ingredientId: balance.ingredientId, expectedQuantityBase: balance.onHandBase, rebuiltQuantityBase: decimalOrZero(calculated.quantityBase), expectedValueRupiah: balance.inventoryValueRupiah, rebuiltValueRupiah: calculated.inventoryValueRupiah }];
  });
  return {
    entries,
    reconciliation: {
      status: completeHistory && mismatches.length === 0 ? "VERIFIED" : completeHistory ? "MISMATCH" : "PARTIAL_HISTORY",
      completeHistory,
      entryCount: entries.length,
      mismatchCount: mismatches.length,
      mismatches,
    },
  };
}

function buildLocationBalances(balances, receipts, movements, primaryLocationId, completeHistory) {
  const positions = new Map();
  const legacyTransferCount = movements.filter((movement) => movement.movementType === "TRANSFER_OUT" && movement.locationAuthorityVersion !== 1).length;
  let unlocatedMovementCount = 0;
  let negativeLocationCount = 0;
  const events = [
    ...receipts.flatMap((receipt) => (receipt.lines ?? []).map((line) => ({ version: receipt.version, ingredientId: line.ingredientId, locationId: receipt.destinationLocationId ?? primaryLocationId, delta: Number(line.baseQuantity) }))),
    ...movements.map((movement) => ({ version: movement.version, ingredientId: movement.ingredientId, locationId: movement.locationId ?? null, delta: Number(movement.quantityDeltaBase) })),
  ].sort((left, right) => left.version - right.version);
  for (const event of events) {
    if (!event.delta) continue;
    let locationId = event.locationId;
    if (!locationId) {
      const nonPrimaryStockExists = [...positions].some(([key, quantity]) => key.startsWith(`${event.ingredientId}\u0000`)
        && key !== `${event.ingredientId}\u0000${primaryLocationId}` && quantity > 0);
      const candidates = [...positions].filter(([key, quantity]) => key.startsWith(`${event.ingredientId}\u0000`) && (event.delta > 0 || quantity >= -event.delta));
      if (candidates.length === 1) locationId = candidates[0][0].split("\u0000")[1];
      if (!locationId || nonPrimaryStockExists) unlocatedMovementCount++;
    }
    if (!locationId) continue;
    const key = `${event.ingredientId}\u0000${locationId}`;
    const next = Number(((positions.get(key) ?? 0) + event.delta).toFixed(6));
    if (next < 0) negativeLocationCount++;
    positions.set(key, next);
  }
  const mismatches = balances.filter((balance) => {
    const rebuilt = Number([...positions].filter(([key]) => key.startsWith(`${balance.ingredientId}\u0000`)).reduce((sum, [, quantity]) => sum + quantity, 0).toFixed(6));
    return rebuilt !== Number(balance.onHandBase);
  });
  const status = !completeHistory ? "PARTIAL_HISTORY"
    : unlocatedMovementCount || legacyTransferCount || negativeLocationCount || mismatches.length ? "UNVERIFIED" : "VERIFIED";
  const rows = [...positions].map(([key, quantity]) => {
    const [ingredientId, locationId] = key.split("\u0000");
    const aggregate = balances.find((balance) => balance.ingredientId === ingredientId) ?? {};
    return {
      ...aggregate, ingredientId, locationId, onHandBase: decimalOrZero(quantity),
      availableBase: status === "VERIFIED" ? decimalOrZero(quantity) : null,
      reservedBase: null,
      inventoryValueRupiah: status === "VERIFIED" && Number(aggregate.onHandBase) > 0
        ? Math.round(aggregate.inventoryValueRupiah * quantity / Number(aggregate.onHandBase)) : null,
    };
  }).filter((item) => Number(item.onHandBase) !== 0 || item.locationId === primaryLocationId);
  return { rows, status, unlocatedMovementCount, legacyTransferCount, negativeLocationCount, mismatchCount: mismatches.length };
}

function buildLotReconciliation(hpp, ingredientById, businessDate, completeHistory) {
  const tracked = new Set([...ingredientById.values()].filter((ingredient) => ingredient.lotTrackingPolicy === "REQUIRED").map((ingredient) => ingredient.id));
  const remainingProductionLots = deriveProductionLotRemaining(hpp.inventoryMovements ?? []);
  for (const receipt of hpp.purchaseReceipts ?? []) for (const lot of receipt.lots ?? []) if (lot.acceptedPurchaseQuantity > 0) tracked.add(lot.ingredientId);
  for (const movement of hpp.inventoryMovements ?? []) if (movement.outputLot) tracked.add(movement.ingredientId);
  const unallocatedMovementCount = (hpp.inventoryMovements ?? []).filter((movement) => tracked.has(movement.ingredientId)
    && Number(movement.quantityDeltaBase) !== 0 && !movement.lotCode && !movement.outputLot
    && !(Array.isArray(movement.allocations) && movement.allocations.some((allocation) => allocation?.lotId && !String(allocation.lotId).startsWith("UNTRACKED:")))).length;
  const expiredLotCount = (hpp.purchaseReceipts ?? []).flatMap((receipt) => receipt.lots ?? [])
    .filter((lot) => lot.acceptedPurchaseQuantity > 0 && lot.expiryDate < businessDate).length
    + (hpp.inventoryMovements ?? []).filter((movement) => movement.outputLot?.quantityBase > 0
      && movement.outputLot.expiryAt.slice(0, 10) < businessDate
      && Number(remainingProductionLots.get(`${movement.ingredientId}\u0000${movement.outputLot.lotId}`) ?? 0) > 0).length;
  const status = !tracked.size ? "NOT_TRACKED" : !completeHistory ? "PARTIAL_HISTORY"
    : unallocatedMovementCount ? "UNVERIFIED" : expiredLotCount ? "EXPIRED_STOCK" : "VERIFIED";
  return { status, trackedIngredientCount: tracked.size, trackedIngredientIds: [...tracked].sort(), unallocatedMovementCount, expiredLotCount };
}

function buildExpiringLots(hpp, ingredientById, businessDate) {
  const receipts = hpp.purchaseReceipts ?? [];
  const today = businessDate;
  const todayEpoch = Date.parse(`${today}T00:00:00Z`);
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  const until = horizon.toISOString().slice(0, 10);
  const purchased = receipts.flatMap((receipt) => (receipt.lots ?? []).filter((lot) => lot.expiryDate <= until).map((lot) => {
    const line = (receipt.lines ?? []).find((item) => item.ingredientId === lot.ingredientId);
    const daysUntilExpiry = Math.round((Date.parse(`${lot.expiryDate}T00:00:00Z`) - todayEpoch) / 86_400_000);
    return {
      receiptId: receipt.id,
      receiptNumber: receipt.receiptNumber ?? null,
      supplierName: receipt.supplierName ?? null,
      ingredientId: lot.ingredientId,
      ingredientName: ingredientById.get(lot.ingredientId)?.name ?? "Bahan tidak ditemukan",
      locationId: receipt.destinationLocationId ?? null,
      lotCode: lot.lotCode,
      expiryDate: lot.expiryDate,
      daysUntilExpiry,
      acceptedPurchaseQuantity: decimalOrZero(lot.acceptedPurchaseQuantity),
      remainingPurchaseQuantity: null,
      purchaseUnitLabel: line?.purchaseUnitLabel ?? null,
      status: daysUntilExpiry < 0 ? "EXPIRED" : "EXPIRING_SOON",
      urgency: daysUntilExpiry < 0 ? "EXPIRED" : daysUntilExpiry <= 7 ? "CRITICAL" : "WARNING",
      quantityMeaning: "RECEIVED_NOT_REMAINING",
    };
  }));
  const remainingByLot = deriveProductionLotRemaining(hpp.inventoryMovements ?? []);
  const produced = (hpp.inventoryMovements ?? []).filter((movement) => movement.movementType === "PRODUCTION_OUTPUT"
      && movement.outputLot?.expiryAt?.slice(0, 10) <= until
      && Number(remainingByLot.get(`${movement.ingredientId}\u0000${movement.outputLot.lotId}`) ?? 0) > 0)
    .map((movement) => {
      const expiryDate = movement.outputLot.expiryAt.slice(0, 10);
      const daysUntilExpiry = Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - todayEpoch) / 86_400_000);
      return {
        receiptId: null,
        receiptNumber: movement.referenceCode ?? null,
        supplierName: null,
        productionExecutionId: movement.sourceId ?? movement.executionId ?? null,
        ingredientId: movement.ingredientId,
        ingredientName: ingredientById.get(movement.ingredientId)?.name ?? "Bahan tidak ditemukan",
        locationId: movement.locationId ?? null,
        lotCode: movement.outputLot.lotId,
        expiryDate,
        daysUntilExpiry,
        acceptedPurchaseQuantity: null,
        producedQuantity: decimalOrZero(movement.outputLot.quantityBase),
        remainingPurchaseQuantity: decimalOrZero(remainingByLot.get(`${movement.ingredientId}\u0000${movement.outputLot.lotId}`) ?? 0),
        purchaseUnitLabel: ingredientById.get(movement.ingredientId)?.baseUom ?? null,
        status: daysUntilExpiry < 0 ? "EXPIRED" : "EXPIRING_SOON",
        urgency: daysUntilExpiry < 0 ? "EXPIRED" : daysUntilExpiry <= 7 ? "CRITICAL" : "WARNING",
        quantityMeaning: "DERIVED_PRODUCTION_LOT_REMAINING",
      };
    });
  return [...purchased, ...produced].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.ingredientName.localeCompare(b.ingredientName, "id"));
}

function deriveProductionLotRemaining(movements) {
  const positions = new Map();
  const lotsByIngredient = new Map();
  const ordered = [...movements].sort((a, b) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")) || Number(a.version ?? 0) - Number(b.version ?? 0));
  for (const movement of ordered) {
    const quantity = Number(movement.quantityDeltaBase ?? 0);
    if (movement.movementType === "PRODUCTION_OUTPUT" && movement.outputLot && quantity > 0) {
      const key = `${movement.ingredientId}\u0000${movement.outputLot.lotId}`;
      positions.set(key, decimalOrZero(movement.outputLot.quantityBase));
      const list = lotsByIngredient.get(movement.ingredientId) ?? [];
      list.push({ key, expiryAt: movement.outputLot.expiryAt, producedAt: movement.outputLot.producedAt });
      lotsByIngredient.set(movement.ingredientId, list);
      continue;
    }
    if (quantity >= 0) continue;
    let remaining = Math.abs(quantity);
    const candidates = [...(lotsByIngredient.get(movement.ingredientId) ?? [])]
      .filter((lot) => lot.producedAt <= movement.occurredAt && (positions.get(lot.key) ?? 0) > 0)
      .sort((a, b) => a.expiryAt.localeCompare(b.expiryAt) || a.producedAt.localeCompare(b.producedAt));
    for (const lot of candidates) {
      if (remaining <= 0) break;
      const available = positions.get(lot.key) ?? 0;
      const used = Math.min(available, remaining);
      positions.set(lot.key, decimalOrZero(available - used));
      remaining = decimalOrZero(remaining - used);
    }
  }
  return positions;
}
