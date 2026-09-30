export const PHASE8A_OPERATIONAL_DATA_VERSION = "PHASE8A_OPERATIONAL_DATA_V1";

export function buildPhase8AOperationalDataReadiness({
  inventoryWorkspace = {},
  catalog = [],
  transactionCatalog = [],
  catalogWorkspace = {},
  inventoryReporting = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const phase2 = plain(inventoryWorkspace.phase2) ? inventoryWorkspace.phase2 : {};
  const phase2Stages = new Map((Array.isArray(phase2.stages) ? phase2.stages : []).map((stage) => [stage.id, stage]));
  const products = flattenCatalog(catalog);
  const activeProducts = products.filter(isActiveProduct);
  const transactionProducts = flattenCatalog(transactionCatalog).filter(isActiveProduct);
  const transactionById = new Map(transactionProducts.map((product) => [product.id, product]));
  const invalidPrices = activeProducts.filter((product) => !Number.isSafeInteger(product?.priceRupiah) || product.priceRupiah <= 0);
  const draftCount = optionalCount(catalogWorkspace.draftCount);
  const publishedRevision = optionalCount(catalogWorkspace.publishedRevision);
  const menuById = new Map((Array.isArray(inventoryWorkspace.hpp?.menus) ? inventoryWorkspace.hpp.menus : []).map((menu) => [menu.productId, menu]));
  const catalogParityIssues = activeProducts.filter((product) => {
    const transaction = transactionById.get(product.id);
    return !transaction || transaction.priceRupiah !== product.priceRupiah || String(transaction.name ?? "") !== String(product.name ?? "");
  });
  const unpublishedHpp = transactionProducts.filter((product) => {
    const menu = menuById.get(product.id);
    return !menu || menu.menuStatus !== "ACTIVE" || menu.hppStatus !== "VERIFIED" || !Number.isSafeInteger(menu.publishedVersion) || menu.publishedVersion < 1
      || menu.sellingPriceRupiah !== product.priceRupiah;
  });
  const activeIngredientIds = new Set((inventoryWorkspace.ingredients?.items ?? []).filter((item) => item?.status === "ACTIVE").map((item) => item.id));
  const openingCount = (inventoryWorkspace.warehouse?.countSessions ?? []).find((item) => item?.status === "COMPLETED" && item?.countKind === "OPENING_BASELINE") ?? null;
  const openingIds = new Set((openingCount?.lines ?? []).map((line) => line?.ingredientId));
  const openingComplete = activeIngredientIds.size > 0 && openingCount && [...activeIngredientIds].every((id) => openingIds.has(id));
  const ledger = plain(inventoryWorkspace.warehouse?.ledgerReconciliation) ? inventoryWorkspace.warehouse.ledgerReconciliation : {};
  const offlineSales = plain(inventoryWorkspace.warehouse?.offlineSales) ? inventoryWorkspace.warehouse.offlineSales : {};
  const reporting = normalizeReporting(inventoryReporting);

  const checks = [
    check("ingredients", "Database bahan lengkap", phase2Stages.get("database")?.state === "READY", stageDetail(phase2Stages.get("database"), "Bahan, biaya, dan satuan beli belum lengkap."), "#inventory/database"),
    check("opening-stock", "Baseline stok awal resmi lengkap", openingComplete === true, openingComplete ? `Opening baseline ${openingCount.businessDate ?? String(openingCount.completedAt).slice(0, 10)} mencakup ${activeIngredientIds.size} bahan.` : "Buat opening baseline yang mencakup seluruh bahan aktif, termasuk stok nol.", "#inventory/warehouse"),
    check("hpp", "Resep published dan HPP sesuai harga transaksi", transactionProducts.length > 0 && unpublishedHpp.length === 0, unpublishedHpp.length ? `${unpublishedHpp.length} menu transaksi belum memiliki resep published yang sesuai harga.` : `${transactionProducts.length}/${transactionProducts.length} menu transaksi memiliki HPP published.`, "#inventory/hpp"),
    check("ledger", "Ledger persediaan dapat direkonsiliasi", ledger.status === "VERIFIED", ledger.status === "VERIFIED" ? `${boundedCount(ledger.entryCount)} entri konsisten.` : `Status ledger ${safeLabel(ledger.status)}.`, "#inventory/warehouse"),
    check("offline-sales", "Penjualan offline tidak menyisakan selisih", offlineSales.status === "RECONCILED" && boundedCount(offlineSales.needsReviewCount) === 0, offlineSales.status === "RECONCILED" ? "Tidak ada konsumsi offline yang menunggu review." : `${boundedCount(offlineSales.needsReviewCount)} transaksi perlu rekonsiliasi.`, "#inventory/warehouse"),
    check("active-menu", "Menu aktif tersedia", activeProducts.length > 0, `${activeProducts.length} menu aktif.`, "#catalog/products"),
    check("menu-price", "Harga jual seluruh menu aktif valid", activeProducts.length > 0 && invalidPrices.length === 0, invalidPrices.length ? `${invalidPrices.length} menu memiliki harga kosong atau tidak valid.` : `${activeProducts.length}/${activeProducts.length} harga valid.`, "#catalog/products"),
    check("catalog-draft", "Tidak ada perubahan katalog yang belum dipublish", draftCount === 0 && publishedRevision !== null && publishedRevision > 0, draftCount === null ? "Status draft katalog belum tersedia." : draftCount ? `${draftCount} perubahan masih berupa draft.` : publishedRevision ? `Katalog published revisi ${publishedRevision}.` : "Katalog belum pernah dipublish.", "#catalog/products"),
    check("catalog-parity", "Menu dan harga Kasir/Kiosk sama dengan dashboard", transactionProducts.length > 0 && activeProducts.length === transactionProducts.length && catalogParityIssues.length === 0, catalogParityIssues.length ? `${catalogParityIssues.length} menu/harga belum sama dengan versi transaksi.` : `${transactionProducts.length} menu published sama dengan dashboard.`, "#catalog/products"),
    check("reporting-mode", "Inventory reporting memakai PostgreSQL", reporting.mode === "POSTGRES" && reporting.configured, reporting.mode === "POSTGRES" ? "Provider PostgreSQL terkonfigurasi." : "Inventory reporting masih OFF.", "#reports"),
    check("reporting-runtime", "Projection, worker, dan invalidation siap", reporting.ready && reporting.projection === "INJECTED" && reporting.worker === "READY" && reporting.invalidation?.status === "READY", reportingRuntimeDetail(reporting), "#reports"),
    check("reporting-freshness", "Projection inventory masih segar", reporting.freshness?.status === "FRESH", reporting.freshness?.status === "FRESH" ? `Usia ${reporting.freshness.ageSeconds} detik dari batas ${reporting.freshness.maxAgeSeconds} detik.` : `Freshness ${safeLabel(reporting.freshness?.status)}.`, "#reports"),
    check("reporting-quality", "Queue dan data historis bersih", reportingQueueClean(reporting), reportingQualityDetail(reporting), "#reports"),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  const actionQueue = checks.filter((item) => !item.complete).map(({ id, label, detail, href }) => ({ id, label, action: detail, href }));
  return Object.freeze({
    version: PHASE8A_OPERATIONAL_DATA_VERSION,
    phase: "PHASE_8A_OPERATIONAL_DATA",
    state: score === 100 ? "READY" : readyChecks ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    operationalDataReady: phase2.operationalDataReady === true,
    transactionDataReady: activeProducts.length > 0 && invalidPrices.length === 0 && draftCount === 0 && publishedRevision > 0 && catalogParityIssues.length === 0 && unpublishedHpp.length === 0,
    reportingReady: checks.filter((item) => item.id.startsWith("reporting-")).every((item) => item.complete),
    activationSafe: score === 100,
    businessFactsAffected: false,
    generatedAt,
    note: score === 100
      ? "Data bahan, stok fisik, HPP, menu, harga, dan inventory reporting siap untuk gate transaksi terbatas."
      : "Phase 8A tetap fail-closed: data kosong tidak dianggap nol dan reporting OFF tidak dianggap siap.",
    checks: Object.freeze(checks),
    actionQueue: Object.freeze(actionQueue),
  });
}

function flattenCatalog(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => Array.isArray(entry?.products) ? entry.products : []).filter(plain);
}

function isActiveProduct(product) {
  return String(product?.status ?? "").toLowerCase() === "active";
}

function normalizeReporting(value) {
  const source = plain(value) ? value : {};
  return {
    mode: String(source.mode ?? "OFF").toUpperCase(),
    configured: source.configured === true,
    ready: source.ready === true,
    projection: String(source.projection ?? "OFF").toUpperCase(),
    worker: String(source.worker ?? "OFF").toUpperCase(),
    invalidation: plain(source.invalidation) ? source.invalidation : null,
    freshness: plain(source.freshness) ? source.freshness : null,
    queue: plain(source.queue) ? source.queue : null,
    dataQuality: plain(source.dataQuality) ? source.dataQuality : null,
  };
}

function reportingQueueClean(reporting) {
  return reporting.ready === true
    && reporting.queue?.deadLetter === 0
    && reporting.queue?.expiredLease === 0
    && reporting.dataQuality?.legacyPaidOrderGapBacklog === 0
    && reporting.dataQuality?.truncated === false;
}

function reportingRuntimeDetail(reporting) {
  if (reporting.mode !== "POSTGRES") return "Aktifkan hanya setelah preflight dan backup/restore lulus.";
  if (!reporting.ready) return "Runtime reporting belum ready.";
  if (reporting.worker !== "READY") return "Worker reporting belum ready.";
  if (reporting.invalidation?.status !== "READY") return "Invalidation reporting belum ready.";
  return "Projection, worker, dan invalidation siap.";
}

function reportingQualityDetail(reporting) {
  if (!reporting.queue || !reporting.dataQuality) return "Queue atau data-quality health belum tersedia.";
  const issues = [];
  if (reporting.queue.deadLetter) issues.push(`${reporting.queue.deadLetter} dead-letter`);
  if (reporting.queue.expiredLease) issues.push(`${reporting.queue.expiredLease} lease kedaluwarsa`);
  if (reporting.dataQuality.legacyPaidOrderGapBacklog) issues.push(`${reporting.dataQuality.legacyPaidOrderGapBacklog} paid order historis belum lengkap`);
  if (reporting.dataQuality.truncated) issues.push("audit gap terpotong");
  return issues.length ? issues.join(" · ") : "Tidak ada dead-letter, lease kedaluwarsa, atau gap historis.";
}

function stageDetail(stage, fallback) {
  if (!plain(stage)) return fallback;
  if (stage.state === "READY") return `${boundedCount(stage.readyChecks)}/${boundedCount(stage.totalChecks)} gate selesai.`;
  const first = Array.isArray(stage.checks) ? stage.checks.find((item) => item?.complete !== true) : null;
  return first?.detail ? String(first.detail) : fallback;
}

function check(id, label, complete, detail, href) {
  return Object.freeze({ id, label, complete: complete === true, detail: String(detail ?? ""), href });
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
}

function optionalCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function safeLabel(value) {
  const normalized = String(value ?? "BELUM TERSEDIA").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 40);
  return normalized || "BELUM TERSEDIA";
}

function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
