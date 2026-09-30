export const BUSINESS_MASTER_READINESS_VERSION = 1;

export function buildBusinessMasterReadiness({ adminState = {}, staffState = null, context = {}, generatedAt = new Date().toISOString() } = {}) {
  const categories = array(adminState.catalog).filter((item) => item?.archived !== true);
  const products = categories.flatMap((item) => array(item?.products)).filter((item) => item?.status === "active" && item?.archive == null);
  const pricedProducts = products.filter((item) => positiveMoney(item?.priceRupiah));
  const productsWithMedia = products.filter((item) => nonEmpty(item?.imageUrl));
  const customizationProducts = products.filter((item) => item?.customizationProfile !== "none");
  const productsWithOptions = customizationProducts.filter((item) => activeOptionCount(item?.variantGroups) + activeOptionCount(item?.modifierGroups) > 0);
  const publishedRevision = integer(adminState.menuWorkspace?.publishedRevision);

  const hpp = object(adminState.hpp);
  const ingredients = array(hpp.ingredients);
  const pricedIngredients = ingredients.filter((item) => item?.costStatus === "PRICED" || nonNegativeMoney(item?.costPerUnitRupiah));
  const suppliers = array(hpp.suppliers).filter((item) => item?.active !== false);
  const supplierPackages = array(hpp.ingredientSupplierPackages).filter((item) => item?.status !== "INACTIVE");
  const hppCoverage = boundedPercent(hpp.coveragePct);

  const staffAvailable = staffState != null;
  const staff = array(staffState?.staff);
  const activeStaff = staff.filter((item) => String(item?.status).toLowerCase() === "active");
  const usableAccounts = activeStaff.filter((item) => !["suspended", "disabled", "revoked"].includes(String(item?.accountState).toLowerCase()) && nonEmpty(item?.accountState));
  const activeTemplates = array(staffState?.shiftTemplates).filter((item) => String(item?.state).toLowerCase() === "active");
  const policy = object(staffState?.attendancePolicy);
  const locationConfigured = finiteCoordinate(policy.outletLatitude, -90, 90) && finiteCoordinate(policy.outletLongitude, -180, 180);

  const memberProvider = String(context.memberMode ?? "").toUpperCase() === "PROVIDER";
  const integrationMember = String(adminState.integrations?.member ?? "").toUpperCase();
  const integrationReward = String(adminState.integrations?.reward ?? "").toUpperCase();
  const memberContractHealthy = providerReady(integrationMember);
  const rewardContractHealthy = providerReady(integrationReward);

  const ordering = object(adminState.orderingSettings);
  const pricing = object(adminState.pricingConfiguration?.settings);
  const pricingAuditCount = array(adminState.pricingConfiguration?.audit).length;
  const hoursPresent = time(ordering.opensAt) && time(ordering.lastOrderAt) && time(ordering.closesAt);
  const pricingPolicyValid = validPricingPolicy(pricing);

  const domains = [
    domain("catalog", "Menu & harga", "#catalog", [
      check("categories", "Kategori menu tersedia", categories.length > 0, `${categories.length} kategori aktif`),
      check("products", "Menu aktif dan harga valid", products.length > 0 && pricedProducts.length === products.length, `${pricedProducts.length}/${products.length} menu memiliki harga positif`),
      check("media", "Foto menu lengkap", products.length > 0 && productsWithMedia.length === products.length, `${productsWithMedia.length}/${products.length} menu memiliki foto`),
      check("options", "Varian dan modifier siap", products.length > 0 && (customizationProducts.length === 0 || productsWithOptions.length === customizationProducts.length), `${productsWithOptions.length}/${customizationProducts.length} menu kustom punya pilihan`),
      check("published", "Perubahan pernah dipublikasikan Owner", publishedRevision > 0, publishedRevision > 0 ? `Publikasi revisi ${publishedRevision}` : "Belum ada bukti publikasi Owner"),
    ]),
    domain("inventory", "Bahan, supplier & HPP", "#inventory/database", [
      check("ingredients", "Database bahan terisi", ingredients.length > 0, `${ingredients.length} bahan`),
      check("ingredient-cost", "Biaya bahan lengkap", ingredients.length > 0 && pricedIngredients.length === ingredients.length, `${pricedIngredients.length}/${ingredients.length} bahan memiliki biaya`),
      check("suppliers", "Supplier aktif tersedia", suppliers.length > 0, `${suppliers.length} supplier aktif`),
      check("purchase-packages", "Satuan beli supplier tersedia", supplierPackages.length > 0, `${supplierPackages.length} kemasan/satuan beli`),
      check("hpp", "HPP seluruh menu terverifikasi", Number(hppCoverage) === 100, `${hppCoverage ?? 0}% cakupan HPP`),
    ]),
    domain("workforce", "Tim & jadwal", "#workforce", [
      check("staff", "Empat akun staf aktif", staffAvailable && activeStaff.length >= 4, staffAvailable ? `${activeStaff.length}/4 staf aktif` : "Layanan staf belum tersedia"),
      check("accounts", "Akun staf dapat digunakan", staffAvailable && activeStaff.length >= 4 && usableAccounts.length >= activeStaff.length, staffAvailable ? `${usableAccounts.length}/${activeStaff.length} akun siap` : "Layanan staf belum tersedia"),
      check("shifts", "Template shift Pagi dan Sore tersedia", staffAvailable && activeTemplates.length >= 2, staffAvailable ? `${activeTemplates.length}/2 template aktif` : "Layanan staf belum tersedia"),
      check("attendance-location", "Titik absensi outlet tersimpan", staffAvailable && locationConfigured, locationConfigured ? "Koordinat outlet tersedia" : "Koordinat outlet belum lengkap"),
      check("attendance-evidence", "GPS dan foto wajah diwajibkan", staffAvailable && policy.gpsRequired === true && policy.selfieRequired === true, policy.gpsRequired === true && policy.selfieRequired === true ? "GPS dan selfie aktif" : "Aturan bukti absensi belum lengkap"),
    ]),
    domain("member", "Member & reward", "#member", [
      check("member-mode", "SagaPOS memakai provider member", memberProvider, memberProvider ? "Mode PROVIDER" : "Provider member belum aktif"),
      check("member-contract", "Kontrak member terverifikasi", memberProvider && memberContractHealthy, memberContractHealthy ? "Provider member siap" : "Perlu verifikasi kontrak dari Saga Platform"),
      check("reward-contract", "Katalog reward terverifikasi", memberProvider && rewardContractHealthy, rewardContractHealthy ? "Provider reward siap" : "Perlu verifikasi reward dari Saga Platform"),
    ]),
    domain("outlet", "Aturan outlet", "#settings", [
      check("timezone", "Zona waktu outlet tersedia", nonEmpty(context.timezone), context.timezone || "Belum diatur"),
      check("hours", "Jam buka, last order, dan tutup valid", hoursPresent, hoursPresent ? `${ordering.opensAt}–${ordering.closesAt}; last order ${ordering.lastOrderAt}` : "Jam layanan belum lengkap"),
      check("hours-enforced", "Jam layanan diterapkan", ordering.enforceHours === true, ordering.enforceHours === true ? "Pembatasan jam aktif" : "Pembatasan jam belum aktif"),
      check("pricing", "Kebijakan pajak/service valid", pricingPolicyValid, pricingPolicyValid ? formatPricingPolicy(pricing) : "Konfigurasi pajak/service tidak valid"),
      check("pricing-confirmed", "Kebijakan harga pernah dikonfirmasi Owner", pricingAuditCount > 0, pricingAuditCount > 0 ? `${pricingAuditCount} perubahan tercatat` : "Belum ada bukti konfirmasi Owner"),
    ]),
  ];

  const totalChecks = domains.reduce((sum, item) => sum + item.totalChecks, 0);
  const readyChecks = domains.reduce((sum, item) => sum + item.readyChecks, 0);
  const score = totalChecks ? Math.round(readyChecks / totalChecks * 100) : 0;
  return {
    version: BUSINESS_MASTER_READINESS_VERSION,
    phase: "PHASE_1_MASTER_DATA",
    state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    generatedAt,
    note: "Nilai dihitung dari data server. Data yang belum ada atau belum terverifikasi tidak dianggap selesai.",
    domains,
  };
}

function domain(id, label, href, checks) {
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = totalChecks ? Math.round(readyChecks / totalChecks * 100) : 0;
  return { id, label, href, state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING", score, readyChecks, totalChecks, checks };
}

function check(id, label, complete, detail) {
  return { id, label, complete: complete === true, detail: String(detail ?? "") };
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : []; }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function integer(value) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0; }
function positiveMoney(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0; }
function nonNegativeMoney(value) { if (value == null || value === "") return false; const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0; }
function boundedPercent(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null; }
function time(value) { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function finiteCoordinate(value, minimum, maximum) { if (value == null || value === "") return false; const parsed = Number(value); return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum; }
function activeOptionCount(groups) { return array(groups).filter((group) => group?.active !== false).reduce((sum, group) => sum + array(group?.options).filter((item) => item?.active !== false).length, 0); }
function providerReady(value) { return /(?:READY|HEALTHY|ACTIVE|PROVIDER)/.test(value) && !/(?:PENDING|OFF|DISABLED|UNAVAILABLE|FIXTURE)/.test(value); }
function validPricingPolicy(settings) {
  if (!settings || typeof settings !== "object") return false;
  const tax = Number(settings.taxRateBps);
  const service = Number(settings.serviceRateBps);
  return Number.isInteger(tax) && tax >= 0 && tax <= 10_000 && Number.isInteger(service) && service >= 0 && service <= 10_000
    && (!settings.taxEnabled || tax > 0) && (!settings.serviceEnabled || service > 0);
}
function formatPricingPolicy(settings) {
  const tax = settings.taxEnabled ? `Pajak ${Number(settings.taxRateBps) / 100}%` : "Tanpa pajak";
  const service = settings.serviceEnabled ? `service ${Number(settings.serviceRateBps) / 100}%` : "tanpa service";
  return `${tax}; ${service}`;
}
