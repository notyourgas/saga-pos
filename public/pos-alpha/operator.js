import { mountOwnerReportIntegration } from "./ui/esb-owner-report-integration.js";
import { createOwnerNativeStaffDashboard } from "./ui/owner-native-staff-dashboard.js";
import { createOperatorApiClient } from "./operator-api-client.js";
import { createOwnerPoControls } from "./ui/owner-po-controls.js";
import { mountDashboardMenuWorkspace, setDashboardMenuArea } from "./admin.js";

const surface = location.pathname === "/dashboard" ? "dashboard" : "kds";
const dashboardModules = [
  { id: "overview", label: "Beranda", section: "home", icon: "home" },
  { id: "sales", label: "Penjualan", section: "operations", icon: "trending-up" },
  { id: "orders", label: "Pesanan", section: "operations", icon: "clipboard" },
  { id: "catalog", label: "Menu & promo", section: "catalog", icon: "coffee" },
  { id: "inventory", label: "Stok & HPP", section: "inventory", icon: "package" },
  { id: "purchasing", label: "Pembelian", section: "inventory", icon: "shopping-bag" },
  { id: "workforce", label: "Tim & shift", section: "people", icon: "users" },
  { id: "member", label: "Member", section: "people", icon: "user-check" },
  { id: "finance", label: "Keuangan", section: "finance", icon: "credit-card" },
  { id: "reports", label: "Laporan", section: "finance", icon: "bar-chart-2" },
  { id: "readiness", label: "Kesiapan bisnis", section: "system", icon: "check-circle" },
  { id: "integrations", label: "Integrasi", section: "system", icon: "link" },
  { id: "settings", label: "Pengaturan", section: "system", icon: "settings" },
];
const dashboardNavigationSections = [
  { id: "operations", label: "Operasional", icon: "activity" },
  { id: "catalog", label: "Menu & Katalog", icon: "coffee" },
  { id: "inventory", label: "Stok & Pembelian", icon: "package" },
  { id: "people", label: "Tim & Pelanggan", icon: "users" },
  { id: "finance", label: "Keuangan & Laporan", icon: "pie-chart" },
  { id: "system", label: "Sistem", icon: "sliders" },
];
const featherPaths = {
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  "bar-chart-2": '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  "check-circle": '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  "chevron-down": '<polyline points="6 9 12 15 18 9"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
  coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4Z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
  "credit-card": '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  "pie-chart": '<path d="M21.21 15.89A10 10 0 1 1 8.11 2.99"/><path d="M22 12A10 10 0 0 0 12 2v10Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.12.6.65 1.03 1.27 1.03H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z"/>',
  "shopping-bag": '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  "trending-up": '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  "user-check": '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
};
function featherIconMarkup(name) {
  return `<svg class="feather" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${featherPaths[name] ?? featherPaths.activity}</svg>`;
}
const dashboardModuleIds = new Set(dashboardModules.map((item) => item.id));
const catalogAreaIds = new Set(["products", "categories", "modifiers", "promotions", "publication", "kiosk", "availability"]);
const inventoryAreas = [
  { id: "database", label: "Bahan" },
  { id: "warehouse", label: "Gudang" },
  { id: "hpp", label: "HPP Menu" },
];
const inventoryAreaIds = new Set([...inventoryAreas.map((item) => item.id), "finalize"]);
const ingredientCategoryFallbacks = [
  ["Kopi", "KOP", "gram", "AMBIENT"], ["Susu & Dairy", "SUS", "ml", "CHILLED"], ["Susu Nabati", "NAB", "ml", "AMBIENT"],
  ["Teh", "TEH", "gram", "AMBIENT"], ["Cokelat & Kakao", "CKL", "gram", "AMBIENT"], ["Matcha", "MTC", "gram", "AMBIENT"],
  ["Bubuk Minuman", "BUB", "gram", "AMBIENT"], ["Sirup & Perisa", "SIR", "ml", "AMBIENT"], ["Gula & Pemanis", "GUL", "gram", "AMBIENT"],
  ["Buah Segar", "BUA", "gram", "CHILLED"], ["Puree & Konsentrat", "PUR", "ml", "CHILLED"], ["Jus & Minuman Dasar", "JUS", "ml", "AMBIENT"],
  ["Air", "AIR", "ml", "AMBIENT"], ["Es", "ICE", "gram", "FROZEN"], ["Topping & Garnish", "TOP", "gram", "CHILLED"],
  ["Saus & Spread", "SAU", "gram", "CHILLED"], ["Roti & Bakery", "ROT", "pcs", "AMBIENT"], ["Tepung & Baking", "TPG", "gram", "AMBIENT"],
  ["Telur", "TLR", "pcs", "CHILLED"], ["Keju", "KEJ", "gram", "CHILLED"], ["Mentega & Lemak", "LMA", "gram", "CHILLED"],
  ["Daging & Protein", "PRT", "gram", "FROZEN"], ["Sayur & Herbal", "SAY", "gram", "CHILLED"], ["Bumbu & Kondimen", "BUM", "gram", "AMBIENT"],
  ["Frozen Food", "FRZ", "pcs", "FROZEN"], ["Bahan Setengah Jadi", "SET", "gram", "CHILLED"], ["Makanan Siap Jual", "SIJ", "pcs", "CHILLED"],
  ["Kemasan Minuman", "KMM", "pcs", "AMBIENT"], ["Kemasan Makanan", "KMF", "pcs", "AMBIENT"], ["Sedotan & Alat Makan", "ALM", "pcs", "AMBIENT"],
  ["Tisu & Napkin", "TSU", "pcs", "AMBIENT"], ["Label & Stiker", "LBL", "pcs", "AMBIENT"], ["Bahan Kebersihan", "BRS", "pcs", "AMBIENT"],
  ["Perlengkapan Operasional", "OPS", "pcs", "AMBIENT"], ["Gas & Bahan Bakar", "GAS", "pcs", "AMBIENT"], ["Barang Dagangan", "DAG", "pcs", "AMBIENT"],
  ["Lainnya", "OTH", "pcs", "AMBIENT"],
].map(([name, prefix, suggestedBaseUnit, storageType]) => ({ id: `fallback:${prefix}`, name, prefix, suggestedBaseUnit, storageType, status: "ACTIVE", fallback: true }));
const ingredientWizardStorageKey = "sagapos.owner.ingredient-wizard.v1";
let dashboardModule = getDashboardModule();
let readinessArea = getReadinessArea();
let inventoryArea = getInventoryArea();
let inventoryFocusAfterHash = null;
let closingFocusAfterHash = null;
let financialDetailsOpen = false;
let closingSimulationOpen = false;
let dashboardSections = {};
try { dashboardSections = JSON.parse(localStorage.getItem("sagapos.dashboard.sections") || "{}"); } catch { /* Navigation remains usable when storage is unavailable. */ }
if (!dashboardSections || typeof dashboardSections !== "object") dashboardSections = {};
let salesTrendsOpen = false;
let memberDiagnosticsOpen = false;
let orderFilters = { q: "", channel: "ALL", status: "ALL", date: "", page: 1 };
let ownerOrderList = { data: null, loading: false, error: "" };
let ownerOrderRequest = 0;
let ownerDetailRequest = 0;
let orderFilterDraft = null;
for (const type of ['input', 'change']) document.addEventListener(type, event => {
  const form = event.target.closest?.('#owner-order-filter');
  if (form) orderFilterDraft = Object.fromEntries(new FormData(form));
});
const openVarianceEvidenceIds = new Set();
document.addEventListener("toggle", (event) => {
  if (event.target.id === "owner-financial-details") financialDetailsOpen = event.target.open;
  if (event.target.id === "owner-closing-simulation") closingSimulationOpen = event.target.open;
  if (event.target.id === "owner-sales-trends") salesTrendsOpen = event.target.open;
  if (event.target.id === "owner-member-diagnostics") memberDiagnosticsOpen = event.target.open;
  if (event.target.matches?.(".owner-variance-evidence-row")) {
    const ingredientId = event.target.dataset.ingredientId;
    if (event.target.open) openVarianceEvidenceIds.add(ingredientId);
    else openVarianceEvidenceIds.delete(ingredientId);
  }
}, true);
const loginView = document.querySelector("#operator-login");
const appView = document.querySelector("#operator-app");
const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const loginIdentityFields = document.querySelector("#login-identity-fields");
const loginSubmit = document.querySelector("#login-submit");
const passwordInput = document.querySelector("#operator-password");
const passwordToggle = document.querySelector("#password-toggle");
const content = document.querySelector("#operator-content");
const globalStatus = document.querySelector("#global-status");
const employeeInput = document.querySelector("#employee-id");
const dashboardSidebar = document.querySelector("#dashboard-sidebar");
const dashboardMenuButton = document.querySelector("#dashboard-menu-button");
const dashboardRefreshButton = document.querySelector("#dashboard-refresh-button");
const dashboardMobileNavigation = document.querySelector("#dashboard-mobile-navigation");
const dashboardMobile = window.matchMedia("(max-width: 760px)");
const dashboardBackdrop = document.querySelector("#dashboard-nav-backdrop");
let csrfToken = "";
const request = createOperatorApiClient({
  getCsrfToken: () => csrfToken,
  onAuthenticationRequired: () => {
    loginStatus.textContent = "Sesi Anda sudah berakhir. Silakan masuk kembali.";
    showLogin();
  },
});
let snapshot;
const ownerPoControls = createOwnerPoControls({ request,
  onReceiptCommitted: () => { inventoryWorkspace = { status: "idle", data: null, error: null, stale: false }; },
  onChanged: async ({ receipt = false, isCurrent = () => true } = {}) => {
    if (receipt) {
      const workspace = await request("/api/operator/inventory-workspace");
      if (!isCurrent()) return;
      inventoryWorkspace = { status: "ready", data: workspace, error: null, stale: false };
    }
    if (isCurrent()) await refresh();
  },
});
let pollTimer;
let kdsFilter = "ALL";
let kdsModeFilter = "ALL";
let reportDate = "";
let inventoryCountPair = { openingCountId: "", closingCountId: "" };
let refreshing = false;
let refreshQueued = false;
let refreshPromise = null;
let sessionRevision = 0;
let inventoryWorkspace = { status: "idle", data: null, error: null, stale: false };
let supplierEditor = { open: false, id: null, draft: null, saving: false };
let orderingEditor = { draft: null, expectedVersion: null, saving: false, blocked: false, confirmed: false, status: "", statusDanger: false };
let purchaseOrderEditor = { open: false, draft: null, attemptKey: null, saving: false, status: "" };
let replenishmentState = { status: "idle", data: null, error: null };
let inventoryEditorId = null;
let ingredientWizard = null;
let prepRecipeEditor = null;
let prepRecipeReturnId = null;
let prepProductionDialog = null;
let ingredientPriceImpact = null;
let ingredientPriceImpactReturnId = null;
let inventoryMutationPending = false;
let minimumStockEditorId = null;
let minimumStockPending = false;
let minimumStockReturnFocus = null;
let warehouseReceiptAttemptKey = readWarehouseReceiptAttemptKey();
let warehouseReceiptOpen = false;
let warehouseCountOpen = false;
let warehouseCountDraftRevision = null;
let warehouseCountDraftLines = {};
let warehouseCountDraftReason = "Full stock count gudang utama";
let warehouseCountMovementChecked = false;
let warehouseSearchQuery = "";
let warehouseLedgerFilter = { ingredientId: "", sourceType: "ALL", locationId: "ALL", fromDate: "", toDate: "" };
let staffReceiptQueue = { status: "idle", data: null, error: null };
let staffReceiptFilters = { status: "ALL", query: "" };
let staffReceiptDetail = { status: "idle", id: null, data: null, error: null };
let staffReceiptReviewPending = false;
let staffReceiptEvidenceId = null;
let staffReceiptCapabilities = { status: "idle", data: null, error: null };
let staffReceiptCapabilityPending = false;
let hppMenuFilter = "ALL";
let hppMenuQuery = "";
let hppEditorProductId = null;
let hppComponentEditor = null;
let hppComponentDirty = false;
let hppDiscardIntent = null;
let hppDiscardTrigger = null;
let hppRemoveConfirmationId = null;
let hppReviewOpen = false;
let ownerReportIntegration = null;
let businessMasterReadiness = { status: "idle", data: null, error: null };
let phase5MemberState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
let phase5MemberDraft = { scenario: "HAPPY_PATH", eligibleSpendRupiah: 50000, rewardCostPoints: 100, idempotencyKey: "owner-phase5-rehearsal" };
let phase6ClosingState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
let phase6ClosingDraft = { scenario: "CLEAN_CLOSE", expectedCashRupiah: 1500000, declaredCashRupiah: 1500000, idempotencyKey: "owner-phase6-rehearsal" };
let phase7ResilienceState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
let phase7ResilienceDraft = { scenario: "RUSH_HOUR", requestedOrders: 200, concurrentUsers: 24, idempotencyKey: "owner-phase7-rehearsal" };
const ownerHrDashboard = createOwnerNativeStaffDashboard({
  read: () => request('/api/operator/native-staff/state'),
  report: ({ from, to }) => request(`/api/operator/native-staff/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  write: (operation, input) => request(`/api/operator/native-staff/${operation}`, { method:'POST', csrf:true, body:input }),
});
const protectedVercelPreview = /^saga-pos-operator-private(?:-|\.)/.test(location.hostname) && location.hostname.endsWith(".vercel.app");

content.addEventListener("cancel", (event) => {
  if (event.target.id === "owner-po-dialog" && purchaseOrderEditor.saving) event.preventDefault();
  if (event.target.id === "owner-supplier-dialog" && supplierEditor.saving) event.preventDefault();
}, true);

content.addEventListener("close", (event) => {
  if (["owner-po-dialog", "owner-supplier-dialog"].includes(event.target.id) && event.target !== content.querySelector(`#${event.target.id}`)) return;
  if (event.target.id === "owner-po-dialog") {
    purchaseOrderEditor = { open: false, draft: null, attemptKey: null, saving: false, status: "" };
    requestAnimationFrame(() => content.querySelector("[data-owner-po-open]")?.focus());
    return;
  }
  if (event.target.id !== "owner-supplier-dialog") return;
  const editedId = supplierEditor.id;
  supplierEditor = { open: false, id: null, draft: null, saving: false };
  content.querySelector(`[data-owner-supplier-edit="${editedId ?? ""}"]`)?.focus();
}, true);

content.addEventListener("submit", async (event) => {
  if (event.target.matches("#owner-po-form")) {
    event.preventDefault();
    await submitOwnerPurchaseOrder(event.target);
    return;
  }
  if (event.target.matches("#owner-supplier-form")) {
    event.preventDefault();
    await submitOwnerSupplier(event.target);
    return;
  }
  if (event.target.matches("#phase7-resilience-simulator")) {
    event.preventDefault();
    await runPhase7ResilienceSimulation(event.target);
    return;
  }
  if (event.target.matches("#phase6-closing-simulator")) {
    event.preventDefault();
    await runPhase6ClosingSimulation(event.target);
    return;
  }
  if (event.target.matches("#phase5-member-simulator")) {
    event.preventDefault();
    await runPhase5MemberSimulation(event.target);
    return;
  }
  if (event.target.matches("#catalog-ordering-settings")) {
    event.preventDefault();
    await submitCatalogOrdering(event.target);
    return;
  }
  if (event.target.matches("#catalog-category-create")) {
    event.preventDefault();
    await submitCatalogCategory(event.target);
    return;
  }
  if (event.target.matches("#catalog-product-create")) {
    event.preventDefault();
    await submitCatalogProduct(event.target);
    return;
  }
  if (event.target.matches(".catalog-product-edit")) {
    event.preventDefault();
    await submitCatalogProductEdit(event.target);
    return;
  }
  if (event.target.matches("#prep-recipe-form")) {
    event.preventDefault();
    await submitPrepRecipe(event.target);
    return;
  }
  if (event.target.matches("#prep-production-form")) {
    event.preventDefault();
    await submitPrepProduction(event.target);
    return;
  }
  if (event.target.matches("#minimum-stock-form")) {
    event.preventDefault();
    await submitMinimumStock(event.target);
    return;
  }
  if (event.target.matches("#ingredient-wizard-form")) {
    event.preventDefault();
    await submitIngredientWizard(event.target);
    return;
  }
  if (event.target.matches("#ingredient-price-impact-filter")) {
    event.preventDefault();
    const values = new FormData(event.target);
    if (!ingredientPriceImpact) return;
    ingredientPriceImpact.filters = {
      month: String(values.get("month") ?? ingredientPriceImpact.filters.month),
      supplier: String(values.get("supplier") ?? "ALL"),
      source: String(values.get("source") ?? "ACTUAL_RECEIPT"),
    };
    await loadIngredientPriceImpact({ focus: "results" });
    return;
  }
  if (event.target.matches("#ingredient-price-reference-form")) {
    event.preventDefault();
    await submitIngredientPriceReference(event.target);
    return;
  }
  if (event.target.matches("#ingredient-master-form")) {
    event.preventDefault();
    await submitIngredientMaster(event.target);
    return;
  }
  if (event.target.matches("#ingredient-conversion-form")) {
    event.preventDefault();
    await submitIngredientConversion(event.target);
    return;
  }
  if (event.target.matches("#ingredient-package-form")) {
    event.preventDefault();
    await submitIngredientPackage(event.target);
    return;
  }
  if (event.target.matches("#ingredient-archive-form")) {
    event.preventDefault();
    const values = new FormData(event.target);
    event.target.closest("dialog")?.close();
    await runInventoryCommand("ingredient.archive", { ingredientId: values.get("ingredientId") }, values.get("reason"));
    return;
  }
  if (event.target.matches("#warehouse-receipt-form")) {
    event.preventDefault();
    await submitWarehouseReceipt(event.target);
    return;
  }
  if (event.target.matches("#warehouse-movement-form")) {
    event.preventDefault();
    await submitWarehouseMovement(event.target);
    return;
  }
  if (event.target.matches("#warehouse-transfer-form")) {
    event.preventDefault();
    await submitWarehouseTransfer(event.target);
    return;
  }
  if (event.target.matches("#warehouse-count-form")) {
    event.preventDefault();
    await submitWarehouseCount(event.target);
    return;
  }
  if (event.target.matches("#warehouse-stock-search-form")) {
    event.preventDefault();
    applyWarehouseStockSearch();
    return;
  }
  if (event.target.matches("#warehouse-ledger-filter")) {
    event.preventDefault();
    const values = new FormData(event.target);
    warehouseLedgerFilter = {
      ingredientId: String(values.get("ingredientId") ?? ""),
      sourceType: String(values.get("sourceType") ?? "ALL"),
      locationId: String(values.get("locationId") ?? "ALL"),
      fromDate: String(values.get("fromDate") ?? ""),
      toDate: String(values.get("toDate") ?? ""),
    };
    render();
    return;
  }
  if (event.target.matches("#staff-receipt-filter")) {
    event.preventDefault();
    const values = new FormData(event.target);
    staffReceiptFilters = {
      status: String(values.get("status") ?? "ALL"),
      query: String(values.get("query") ?? "").trim().slice(0, 80),
    };
    render();
    return;
  }
  if (event.target.matches("#staff-receipt-review-form")) {
    event.preventDefault();
    await submitStaffReceiptReview(event.target, event.submitter);
    return;
  }
  if (event.target.matches("[data-staff-receipt-capability-form]")) {
    event.preventDefault();
    await submitStaffReceiptCapabilities(event.target);
    return;
  }
  if (event.target.matches("#hpp-menu-filter")) {
    event.preventDefault();
    const values = new FormData(event.target);
    hppMenuFilter = String(values.get("status") ?? "ALL");
    hppMenuQuery = String(values.get("query") ?? "").trim();
    render();
    return;
  }
  if (event.target.matches("#hpp-draft-line-form")) {
    event.preventDefault();
    await submitHppDraftLine(event.target);
    return;
  }
  if (event.target.matches("#hpp-publish-form")) {
    event.preventDefault();
    await submitHppPublish(event.target);
    return;
  }
  if (event.target.matches(".owner-settlement-review-form")) {
    event.preventDefault();
    await submitPaymentSettlementReview(event.target);
    return;
  }
  if (event.target.matches("#owner-order-filter")) {
    event.preventDefault();
    orderFilters = { ...orderFilters, ...Object.fromEntries(new FormData(event.target)), page: 1 };
    orderFilterDraft = null;
    await loadOwnerOrders();
    return;
  }
  if (event.target.matches("#owner-report-filter")) {
    event.preventDefault();
    reportDate = new FormData(event.target).get("reportDate") || "";
    try { await refresh(); } catch (error) { announce(error.message, true); }
    return;
  }
  if (!event.target.matches("#owner-variance-filter")) return;
  event.preventDefault();
  const previous = { ...inventoryCountPair };
  const values = new FormData(event.target);
  inventoryCountPair = { openingCountId: values.get("openingCountId") || "", closingCountId: values.get("closingCountId") || "" };
  try { await refresh(); } catch (error) { inventoryCountPair = previous; announce(error.message, true); }
});

content.addEventListener("change", (event) => {
  if (event.target.closest("#catalog-ordering-settings")) {
    collectOrderingDraft(event.target.form);
    return;
  }
  if (event.target.closest("#owner-po-form")) {
    updateOwnerPurchaseOrderDraft(content.querySelector("#owner-po-form"));
    return;
  }
  const prepRecipeForm = event.target.closest("#prep-recipe-form");
  if (prepRecipeForm) {
    collectPrepRecipeDraft(prepRecipeForm);
    prepRecipeEditor.dirty = true;
    syncPrepRecipeReview(prepRecipeForm);
    return;
  }
  const prepProductionForm = event.target.closest("#prep-production-form");
  if (prepProductionForm) {
    collectPrepProductionDraft(prepProductionForm);
    prepProductionDialog.dirty = true;
    if (event.target.name === "inputMode" && !prepProductionDialog.productionOrderId) {
      render();
      requestAnimationFrame(() => content.querySelector("#prep-production-form [name=inputMode]")?.focus());
      return;
    }
    syncPrepProductionReview(prepProductionForm);
    return;
  }
  if (event.target.matches("#warehouse-count-form [name=countMovementChecked]")) {
    warehouseCountMovementChecked = event.target.checked;
    return;
  }
  if (event.target.closest("#hpp-draft-line-form")) hppComponentDirty = true;
  if (event.target.matches("#hpp-draft-line-form [data-hpp-component-source]")) {
    syncHppGuidedEstimate(event.target.form);
    if (hppComponentEditor) hppComponentEditor.lines = readHppComponentRows(event.target.form, { raw: true });
    return;
  }
  if (event.target.closest("#ingredient-wizard-form")) {
    const form = event.target.form;
    if (event.target.matches("[name=categoryId], [name=baseUnit], [name=purchaseMode]")) invalidateIngredientPackageVerification(form);
    collectIngredientWizardDraft(form);
    if (event.target.matches("[name=categoryId], [name=baseUnit], [name=purchaseMode], [name=sourcingMode]")) {
      const changedName = event.target.name;
      const changedValue = event.target.value;
      if (event.target.matches("[name=categoryId]")) applyIngredientCategorySuggestion(form, event.target.value);
      render();
      requestAnimationFrame(() => {
        const nextForm = content.querySelector("#ingredient-wizard-form");
        const nextControl = ["purchaseMode", "sourcingMode"].includes(changedName)
          ? nextForm?.querySelector(`[name="${changedName}"][value="${CSS.escape(changedValue)}"]`)
          : nextForm?.elements[changedName];
        nextControl?.focus();
        syncIngredientWizardSummary(nextForm);
      });
      return;
    }
    syncIngredientWizardSummary(form);
    return;
  }
  const referencePriceForm = event.target.closest("#ingredient-price-reference-form");
  if (referencePriceForm) {
    const option = referencePriceForm.elements.purchaseOptionId?.selectedOptions?.[0];
    if (event.target.name === "purchaseOptionId" && option?.dataset.currentPrice) referencePriceForm.elements.referencePriceRupiah.value = option.dataset.currentPrice;
    syncIngredientPriceSimulation(referencePriceForm);
    return;
  }
  if (event.target.matches("#warehouse-purchase-option")) {
    syncWarehouseReceiptPurchaseOption(event.target);
    return;
  }
  const receiptForm = event.target.closest("#warehouse-receipt-form");
  if (receiptForm) {
    syncWarehouseReceiptLotFields(receiptForm);
    syncWarehouseReceiptPreview(receiptForm);
    return;
  }
  if (!event.target.matches("#owner-variance-filter select")) return;
  syncInventoryCountOptions(event.target.form);
});

content.addEventListener("input", (event) => {
  if (event.target.closest("#catalog-ordering-settings")) {
    collectOrderingDraft(event.target.form);
    return;
  }
  if (event.target.closest("#owner-po-form")) {
    updateOwnerPurchaseOrderDraft(content.querySelector("#owner-po-form"));
    return;
  }
  const prepRecipeForm = event.target.closest("#prep-recipe-form");
  if (prepRecipeForm) {
    collectPrepRecipeDraft(prepRecipeForm);
    syncPrepRecipeReview(prepRecipeForm);
    return;
  }
  const prepProductionForm = event.target.closest("#prep-production-form");
  if (prepProductionForm) {
    collectPrepProductionDraft(prepProductionForm);
    syncPrepProductionReview(prepProductionForm);
    return;
  }
  if (event.target.closest("#warehouse-count-form")) {
    if (warehouseCountDraftRevision == null) warehouseCountDraftRevision = inventoryWorkspace.data?.revision ?? null;
    if (event.target.name.startsWith("quantity:")) warehouseCountDraftLines[event.target.name.slice("quantity:".length)] = event.target.value;
    if (event.target.name === "reason") warehouseCountDraftReason = event.target.value;
    return;
  }
  if (event.target.matches("#warehouse-stock-search")) {
    warehouseSearchQuery = event.target.value.slice(0, 80);
    applyWarehouseStockSearch();
    return;
  }
  const receiptForm = event.target.closest("#warehouse-receipt-form");
  if (receiptForm) {
    syncWarehouseReceiptLotFields(receiptForm);
    syncWarehouseReceiptPreview(receiptForm);
    return;
  }
  const hppForm = event.target.closest("#hpp-draft-line-form");
  if (hppForm) {
    hppComponentDirty = true;
    syncHppGuidedEstimate(hppForm);
    if (hppComponentEditor) {
      hppComponentEditor.lines = readHppComponentRows(hppForm, { raw: true });
      hppComponentEditor.reason = hppForm.elements.reason?.value ?? "";
    }
    return;
  }
  const form = event.target.closest("#ingredient-wizard-form");
  if (!form) {
    const pricePreview = event.target.closest("#ingredient-price-reference-form");
    if (pricePreview) syncIngredientPriceSimulation(pricePreview);
    return;
  }
  if (event.target.name === "customCategoryPrefix") event.target.setCustomValidity("");
  if (["purchaseUnit", "innerUnit", "innerUnitsPerPurchaseUnit", "baseUnitsPerInnerUnit", "baseUnitsPerPurchaseUnit"].includes(event.target.name)) invalidateIngredientPackageVerification(form);
  collectIngredientWizardDraft(form);
  syncIngredientWizardSummary(form);
});

content.addEventListener("cancel", (event) => {
  if (event.target.id === "staff-receipt-evidence-dialog") {
    event.preventDefault();
    staffReceiptEvidenceId = null;
    render();
  } else if (event.target.id === "staff-receipt-detail-dialog") {
    event.preventDefault();
    closeStaffReceiptDetail();
  } else if (event.target.id === "warehouse-receipt-dialog") {
    event.preventDefault();
    closeWarehouseReceiptDialog();
  } else if (event.target.id === "hpp-recipe-dialog") {
    event.preventDefault();
    requestHppComponentExit(event.target, "menu");
  } else if (event.target.id === "ingredient-editor-dialog") {
    event.preventDefault();
    const form = event.target.querySelector("#ingredient-wizard-form");
    if (form) collectIngredientWizardDraft(form);
    persistIngredientWizardDraft();
    ingredientWizard = null;
    render();
    requestAnimationFrame(() => content.querySelector("[data-ingredient-wizard-open='resume'], [data-ingredient-wizard-open='new']")?.focus());
  } else if (event.target.id === "ingredient-price-impact-dialog") {
    event.preventDefault();
    closeIngredientPriceImpact();
  } else if (event.target.id === "prep-recipe-dialog") {
    event.preventDefault();
    closePrepRecipeEditor();
  } else if (event.target.id === "prep-production-dialog") {
    event.preventDefault();
    closePrepProductionDialog();
  }
}, true);

document.body.classList.add(`surface-${surface}`);
const simpleProductionDashboard = surface === "dashboard" && document.body.dataset.production === "true";
employeeInput.value = surface === "dashboard" ? simpleProductionDashboard ? "" : "OWNER-DEMO" : document.body.dataset.production ? "" : "BAR-01";
document.querySelector("#surface-title").textContent = surface === "dashboard" ? "Beranda" : "Nota Checker · KDS";
document.querySelector("#login-title").textContent = surface === "dashboard" ? simpleProductionDashboard ? "Masuk ke Saga POS" : "Masuk ke Owner Dashboard" : "Masuk ke Nota Checker";
document.title = surface === "dashboard" ? "Saga POS · Owner Dashboard" : "Saga POS · Nota Checker";

if (surface === "dashboard") {
  if (simpleProductionDashboard) {
    loginView.classList.add("owner-login-simple");
    loginIdentityFields.hidden = true;
    employeeInput.required = false;
    employeeInput.disabled = true;
    document.querySelector("#login-description").textContent = "Akses Owner Dashboard dengan satu password.";
    document.querySelector("#password-label").textContent = "Password Owner";
    loginSubmit.textContent = "Masuk ke Dashboard";
  }
  dashboardSidebar.hidden = false;
  dashboardMenuButton.hidden = false;
  document.querySelector("#dashboard-cashier-link").hidden = false;
  document.querySelector("#dashboard-kds-link").hidden = false;
  dashboardSidebar.innerHTML = dashboardNavigation();
  dashboardSidebar.addEventListener("toggle", (event) => {
    const section = event.target.dataset.dashboardSection;
    if (!dashboardNavigationSections.some((item) => item.id === section)) return;
    dashboardSections[section] = event.target.open;
    try { localStorage.setItem("sagapos.dashboard.sections", JSON.stringify(dashboardSections)); } catch { /* Storage is optional. */ }
  }, true);
  dashboardMobileNavigation.hidden = false;
  dashboardMobileNavigation.innerHTML = dashboardMobileNavigationMarkup();
  dashboardSidebar.querySelector(".dashboard-nav-close").addEventListener("click", closeDashboardNavigation);
  dashboardMobileNavigation.querySelector("[data-dashboard-mobile-more]").addEventListener("click", toggleDashboardNavigation);
  dashboardBackdrop.addEventListener("click", closeDashboardNavigation);
  dashboardMobile.addEventListener("change", () => {
    closeDashboardNavigation();
    if (dashboardMobile.matches && !appView.hidden) dashboardMenuButton.focus();
  });
  closeDashboardNavigation();
  dashboardMenuButton.addEventListener("click", toggleDashboardNavigation);
  dashboardRefreshButton.hidden = false;
  dashboardRefreshButton.addEventListener("click", async () => {
    try {
      await refresh();
      if (dashboardModule === "readiness") await loadBusinessMasterReadiness({ force: true });
      if (dashboardModule === "inventory") await loadInventoryWorkspace({ force: true });
      if (dashboardModule === "workforce") await ownerHrDashboard.load({ force: true });
      if (dashboardModule === "member") await loadPhase5MemberLifecycle({ force: true });
      if (dashboardModule === "readiness" && readinessArea === "closing") await loadPhase6FinanceClosing({ force: true });
      if (dashboardModule === "readiness" && readinessArea === "pilot") await loadPhase7ResiliencePilot({ force: true });
    } catch (error) { announce(error.message, true); }
  });
  dashboardSidebar.addEventListener("click", async (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    if (ownerReportIntegration?.isDirty()) {
      event.preventDefault();
      await ownerReportIntegration.requestNavigation({ trigger: link, navigate: () => { location.hash = link.hash; } });
    }
    closeDashboardNavigation();
  });
  window.addEventListener("hashchange", async () => {
    const previousModule = dashboardModule;
    const previousInventoryArea = inventoryArea;
    dashboardModule = getDashboardModule();
    readinessArea = getReadinessArea();
    inventoryArea = getInventoryArea();
    if (inventoryArea !== previousInventoryArea) warehouseReceiptOpen = false;
    if (previousModule === "catalog" && dashboardModule === "catalog") {
      setDashboardMenuArea(getCatalogArea());
      syncDashboardChrome();
      requestAnimationFrame(() => content.querySelector("[role='tabpanel']")?.focus());
      return;
    }
    if (dashboardModule === "overview" && reportDate) {
      reportDate = "";
      try { await refresh(); } catch (error) { announce(error.message, true); }
    } else {
      render();
      if (dashboardModule === "orders") {
        if (previousModule !== "orders" || ownerOrderList.data?.mode !== ownerOrderMode()) { orderFilters.page = 1; ownerOrderList.data = null; }
        await loadOwnerOrders();
      }
      if (dashboardModule === "readiness") await loadBusinessMasterReadiness();
      if (dashboardModule === "inventory" && inventoryWorkspace.status === "idle") await loadInventoryWorkspace();
      if (dashboardModule === "workforce") await ownerHrDashboard.load();
      if (dashboardModule === "member") await loadPhase5MemberLifecycle();
      if (dashboardModule === "readiness" && readinessArea === "closing") await loadPhase6FinanceClosing();
      if (dashboardModule === "readiness" && readinessArea === "pilot") await loadPhase7ResiliencePilot();
    }
    const requestedFocus = inventoryFocusAfterHash;
    inventoryFocusAfterHash = null;
    const closingFocus = closingFocusAfterHash;
    closingFocusAfterHash = null;
    requestAnimationFrame(() => {
      const panel = closingFocus && content.querySelector(closingFocus);
      if (panel) { panel.tabIndex = -1; panel.focus(); panel.scrollIntoView({ block: 'start' }); }
      else if (requestedFocus === "ingredient-wizard") focusIngredientWizardStep();
      else document.querySelector("#surface-title")?.focus();
    });
  });
  document.addEventListener("keydown", (event) => {
    if (!document.body.classList.contains("dashboard-nav-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDashboardNavigation();
    } else if (event.key === "Tab") {
      const controls = [...dashboardSidebar.querySelectorAll("a[href], button:not([disabled]), summary")];
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  });
}

loginForm.addEventListener("submit", login);
passwordToggle.addEventListener("click", () => {
  const reveal = passwordInput.type === "password";
  passwordInput.type = reveal ? "text" : "password";
  passwordToggle.textContent = reveal ? "Sembunyikan" : "Lihat";
  passwordToggle.setAttribute("aria-pressed", String(reveal));
  passwordInput.focus();
});
document.querySelector("#logout-button").addEventListener("click", logout);
content.addEventListener("click", async (event) => {
  const purchasingJump = event.target.closest('[data-purchasing-jump]');
  if (purchasingJump) {
    const panel = content.querySelector(`#${purchasingJump.dataset.purchasingJump}`);
    if (panel) { panel.tabIndex = -1; panel.focus(); panel.scrollIntoView({ block: "start" }); }
    return;
  }
  if (event.target.closest('[data-closing-orders]')) {
    orderFilters = { q: '', channel: 'ALL', status: 'ALL', date: snapshot.dashboard.businessDate, page: 1 };
    orderFilterDraft = null;
  }
  const closingLink = event.target.closest('[data-closing-target]');
  if (closingLink) {
    const panel = content.querySelector(closingLink.dataset.closingTarget);
    if (panel) { event.preventDefault(); panel.tabIndex = -1; panel.focus(); panel.scrollIntoView({ block: 'start' }); return; }
    closingFocusAfterHash = closingLink.dataset.closingTarget;
  }
  const orderDetailButton = event.target.closest("[data-owner-order-detail]");
  if (orderDetailButton) { await openOwnerOrderDetail(orderDetailButton.dataset.ownerOrderDetail, orderDetailButton); return; }
  const orderPageButton = event.target.closest("[data-owner-order-page]");
  if (orderPageButton) { orderFilters.page = Number(orderPageButton.dataset.ownerOrderPage); await loadOwnerOrders(); return; }
  if (event.target.closest("[data-owner-orders-refresh]")) { await refresh(); return; }
  if (event.target.closest("[data-ordering-refresh]")) {
    await refreshOrderingSettings();
    return;
  }
  if (event.target.closest("[data-ordering-discard]")) {
    if (orderingEditor.saving || orderingEditor.blocked) return;
    orderingEditor = { draft: null, expectedVersion: null, saving: false, blocked: false, confirmed: false, status: "Perubahan yang belum disimpan dibatalkan.", statusDanger: false };
    render({ captureOrderingDraft: false });
    content.querySelector("#catalog-ordering-settings [name='opensAt']")?.focus();
    return;
  }
  if (event.target.closest("[data-owner-po-open]")) {
    const purchasing = snapshot?.dashboard?.purchasing;
    if (!purchasing?.suppliers?.some((supplier) => supplier.active) || !purchasing?.purchaseIngredients?.length) {
      announce("Buat supplier aktif dan bahan terlebih dahulu sebelum menyusun PO.", true);
      return;
    }
    purchaseOrderEditor = { open: true, draft: null, attemptKey: `po-${crypto.randomUUID()}`, saving: false, status: "" };
    render();
    requestAnimationFrame(() => content.querySelector("#owner-po-form [name='supplierId']")?.focus());
    return;
  }
  if (event.target.closest("[data-owner-po-close]")) {
    content.querySelector("#owner-po-dialog")?.close();
    return;
  }
  if (event.target.closest("[data-owner-po-add]")) {
    const form = content.querySelector("#owner-po-form");
    const draft = collectOwnerPurchaseOrderDraft(form);
    if (draft.lines.length >= 100) return;
    draft.lines.push({ ingredientId: "", purchaseUnitLabel: "", orderedPurchaseQuantity: "", baseUnitsPerPurchaseUnit: "", unitCostRupiah: "" });
    purchaseOrderEditor.draft = draft;
    form.remove();
    render();
    requestAnimationFrame(() => content.querySelector("#owner-po-form .owner-po-line:last-of-type [name='ingredientId']")?.focus());
    return;
  }
  const removePoLine = event.target.closest("[data-owner-po-remove]");
  if (removePoLine) {
    const form = content.querySelector("#owner-po-form");
    const draft = collectOwnerPurchaseOrderDraft(form);
    if (draft.lines.length <= 1) return;
    draft.lines.splice(Number(removePoLine.dataset.ownerPoRemove), 1);
    purchaseOrderEditor.draft = draft;
    form.remove();
    render();
    return;
  }
  const supplierOpen = event.target.closest("[data-owner-supplier-edit]");
  if (supplierOpen) {
    if (supplierEditor.saving) return;
    const id = supplierOpen.dataset.ownerSupplierEdit || null;
    const existing = snapshot?.dashboard?.purchasing?.suppliers?.find((supplier) => supplier.id === id);
    if (id && !existing) { announce("Supplier tidak ditemukan. Perbarui halaman dan coba lagi.", true); return; }
    supplierEditor = { open: true, id, draft: existing ? { name: existing.name, leadTimeDays: String(existing.leadTimeDays), active: String(existing.active), reason: "" } : null, saving: false };
    render();
    content.querySelector("#owner-supplier-form [name='name']")?.focus();
    return;
  }
  if (event.target.closest("[data-owner-supplier-close]")) {
    closeOwnerSupplierEditor();
    return;
  }
  if (event.target.closest("[data-owner-supplier-refresh]")) {
    if (supplierEditor.saving) return;
    const editor = supplierEditor;
    try {
      await refresh();
      if (supplierEditor !== editor) return;
      editor.status = "Data supplier diperbarui. Periksa draft sebelum menyimpan lagi.";
      editor.statusDanger = false;
    } catch {
      if (supplierEditor !== editor) return;
      editor.status = "Data terbaru belum dapat dimuat. Draft tetap tersedia; coba perbarui lagi.";
      editor.statusDanger = true;
    }
    render();
    return;
  }
  if (event.target.matches("[data-business-readiness-retry]")) {
    await loadBusinessMasterReadiness({ force: true });
    return;
  }
  const clearPrototype = event.target.closest("button[data-clear-prototype-orders]");
  if (clearPrototype) {
    const reason = window.prompt("Alasan membersihkan order uji:", "Bersihkan antrean setelah pengujian owner");
    if (!reason?.trim() || !window.confirm("Hapus seluruh order dan tiket Mode Uji? Data bisnis tidak akan disentuh.")) return;
    clearPrototype.disabled = true;
    try {
      const result = await catalogAction("prototype.orders.clear", { confirmation: "HAPUS ORDER UJI", reason: reason.trim() });
      await refresh();
      announce(`${result.clearedOrders} order uji dan ${result.clearedQueueItems} tiket berhasil dibersihkan.`);
    } catch (error) { announce(error.message, true); clearPrototype.disabled = false; }
    return;
  }
  const removePhoto = event.target.closest("button[data-catalog-photo-remove]");
  if (removePhoto) {
    if (!window.confirm(`Hapus foto ${removePhoto.dataset.catalogName}? Menu tetap tersimpan.`)) return;
    removePhoto.disabled = true;
    try {
      await catalogAction("catalog.product.media.remove", { productId: removePhoto.dataset.catalogPhotoRemove, expectedVersion: snapshot.catalogVersion, reason: "Hapus foto dari Dashboard Owner" });
      await refresh();
      announce(`Foto ${removePhoto.dataset.catalogName} berhasil dihapus.`);
    } catch (error) { announce(error.message, true); removePhoto.disabled = false; }
    return;
  }
  const publishMenu = event.target.closest("button[data-catalog-publish]");
  if (publishMenu) {
    if (!window.confirm(`Publikasikan ${publishMenu.dataset.catalogName} ke Kiosk dan Cashier?`)) return;
    publishMenu.disabled = true;
    try {
      await catalogAction("catalog.product.publish", { productId: publishMenu.dataset.catalogPublish, expectedVersion: snapshot.catalogVersion, reason: "Dipublikasikan dari Dashboard Owner" });
      await refresh();
      announce(`${publishMenu.dataset.catalogName} sudah tampil pada katalog Kiosk.`);
    } catch (error) { announce(error.message, true); }
    return;
  }
  const staffReceiptOpen = event.target.closest("button[data-staff-receipt-open]");
  if (staffReceiptOpen) {
    await loadStaffReceiptDetail(staffReceiptOpen.dataset.staffReceiptOpen);
    return;
  }
  if (event.target.closest("button[data-staff-receipt-close]")) {
    closeStaffReceiptDetail();
    return;
  }
  const evidenceOpen = event.target.closest("button[data-staff-receipt-evidence]");
  if (evidenceOpen) {
    staffReceiptEvidenceId = evidenceOpen.dataset.staffReceiptEvidence;
    render();
    requestAnimationFrame(() => content.querySelector("#staff-receipt-evidence-title")?.focus());
    return;
  }
  if (event.target.closest("button[data-staff-evidence-close]")) {
    staffReceiptEvidenceId = null;
    render();
    requestAnimationFrame(() => content.querySelector("#staff-receipt-detail-title")?.focus());
    return;
  }
  const movementLink = event.target.closest("button[data-staff-receipt-movement]");
  if (movementLink) {
    const ingredientId = movementLink.dataset.staffReceiptIngredient || "";
    warehouseLedgerFilter = { ...warehouseLedgerFilter, ingredientId, sourceType: "PURCHASE_RECEIPT" };
    const ingredient = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === ingredientId);
    if (ingredient?.name) warehouseSearchQuery = ingredient.name;
    staffReceiptDetail = { status: "idle", id: null, data: null, error: null };
    staffReceiptEvidenceId = null;
    render();
    requestAnimationFrame(() => {
      const target = content.querySelector("#warehouse-receipt-history");
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.focus();
    });
    return;
  }
  if (event.target.closest("button[data-staff-receipt-retry]")) {
    await loadStaffReceipts({ force: true });
    return;
  }
  if (event.target.closest("button[data-staff-receipt-clear-filter]")) {
    staffReceiptFilters = { status: "ALL", query: "" };
    render();
    requestAnimationFrame(() => content.querySelector("#staff-receipt-filter [name=query]")?.focus());
    return;
  }
  if (event.target.closest("a[data-warehouse-count-shortcut]")) warehouseCountOpen = true;
  const countSummary = event.target.closest("summary[data-warehouse-count-toggle]");
  if (countSummary) {
    warehouseCountOpen = !warehouseCountOpen;
    if (warehouseCountOpen && warehouseCountDraftRevision == null) warehouseCountDraftRevision = inventoryWorkspace.data?.revision ?? null;
    render();
    if (warehouseCountOpen) requestAnimationFrame(() => content.querySelector("#warehouse-count-form input[type=number]")?.focus());
    return;
  }
  if (event.target.closest("button[data-warehouse-count-reset]")) {
    warehouseCountOpen = true;
    warehouseCountDraftRevision = inventoryWorkspace.data?.revision ?? null;
    warehouseCountDraftLines = {};
    warehouseCountDraftReason = "Full stock count gudang utama";
    warehouseCountMovementChecked = false;
    render();
    requestAnimationFrame(() => content.querySelector("#warehouse-count-form input[type=number]")?.focus());
    return;
  }
  const reverse = event.target.closest("[data-warehouse-reverse]");
  if (reverse) {
    const ingredient = reverse.dataset.warehouseIngredient || "bahan";
    if (!window.confirm(`Koreksi transaksi stok ${ingredient}? Histori asli tetap disimpan.`)) return;
    await runInventoryCommand("warehouse.movement.reverse", {
      idempotencyKey: inventoryOperationKey("owner-reversal"), movementId: reverse.dataset.warehouseReverse,
    }, `Koreksi transaksi stok ${ingredient}`);
    return;
  }
  if (event.target.closest("button[data-hpp-ingredient-recovery]")) {
    hppEditorProductId = null;
    hppComponentEditor = null;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    ingredientWizard = createIngredientWizardState();
    inventoryArea = "database";
    inventoryFocusAfterHash = "ingredient-wizard";
    location.hash = "inventory/database";
    return;
  }
  if (event.target.closest("button[data-hpp-menu-reset]")) {
    hppMenuFilter = "ALL";
    hppMenuQuery = "";
    render();
    requestAnimationFrame(() => content.querySelector("#hpp-menu-filter [name=query]")?.focus());
    return;
  }
  const receiptOpen = event.target.closest("button[data-warehouse-receipt-open]");
  if (receiptOpen) {
    warehouseReceiptOpen = true;
    render();
    requestAnimationFrame(() => content.querySelector("#warehouse-purchase-option, #warehouse-receipt-form [name=ingredientId]")?.focus());
    return;
  }
  const receiptClose = event.target.closest("button[data-warehouse-receipt-close]");
  if (receiptClose) {
    closeWarehouseReceiptDialog();
    return;
  }
  const prepRecipeOpen = event.target.closest("button[data-prep-recipe-open]");
  if (prepRecipeOpen) {
    openPrepRecipeEditor(prepRecipeOpen.dataset.prepRecipeOpen);
    return;
  }
  if (event.target.closest("button[data-prep-recipe-close]")) {
    closePrepRecipeEditor();
    return;
  }
  const prepComponentAdd = event.target.closest("button[data-prep-component-add]");
  if (prepComponentAdd && prepRecipeEditor) {
    collectPrepRecipeDraft(prepComponentAdd.form);
    prepRecipeEditor.components.push({ ingredientId: "", quantityBase: "" });
    render();
    requestAnimationFrame(() => content.querySelector("[data-prep-component-row]:last-of-type select")?.focus());
    return;
  }
  const prepComponentRemove = event.target.closest("button[data-prep-component-remove]");
  if (prepComponentRemove && prepRecipeEditor) {
    collectPrepRecipeDraft(prepComponentRemove.form);
    const index = Number(prepComponentRemove.dataset.prepComponentRemove);
    if (prepRecipeEditor.components.length > 1 && Number.isInteger(index)) prepRecipeEditor.components.splice(index, 1);
    render();
    requestAnimationFrame(() => content.querySelector(`[data-prep-component-row="${Math.max(0, index - 1)}"] select`)?.focus());
    return;
  }
  const prepProductionOpen = event.target.closest("button[data-prep-production-open]");
  if (prepProductionOpen) {
    openPrepProductionDialog(prepProductionOpen.dataset.prepProductionOpen, prepProductionOpen.dataset.productionOrderId || null);
    return;
  }
  if (event.target.closest("button[data-prep-production-close]")) {
    closePrepProductionDialog();
    return;
  }
  const prepProductionVoid = event.target.closest("button[data-prep-production-void]");
  if (prepProductionVoid) {
    await cancelPrepProduction(prepProductionVoid.dataset.prepProductionVoid);
    return;
  }
  const priorityRetry = event.target.closest("button[data-purchase-priority-retry]");
  if (priorityRetry) {
    await loadReplenishmentPolicies();
    return;
  }
  const priorityMinimum = event.target.closest("button[data-purchase-priority-minimum]");
  if (priorityMinimum) {
    const edit = content.querySelector(`[data-minimum-stock-edit="${CSS.escape(priorityMinimum.dataset.purchasePriorityMinimum)}"]`);
    edit?.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(() => edit?.focus());
    return;
  }
  const priorityReceive = event.target.closest("button[data-purchase-priority-receive]");
  if (priorityReceive) {
    warehouseReceiptOpen = true;
    render();
    const form = content.querySelector("#warehouse-receipt-form");
    const select = form?.querySelector("#warehouse-purchase-option");
    const purchaseOptionId = priorityReceive.dataset.purchasePriorityReceive;
    if (!form || !select || ![...select.options].some((option) => option.value === purchaseOptionId)) {
      announce("Kemasan utama belum tersedia di formulir penerimaan.", true);
      return;
    }
    select.value = purchaseOptionId;
    syncWarehouseReceiptPurchaseOption(select);
    form.elements.purchaseQuantity.value = "";
    form.elements.totalCostRupiah.value = "";
    requestAnimationFrame(() => select.focus());
    return;
  }
  const priorityPackage = event.target.closest("button[data-purchase-priority-package]");
  if (priorityPackage) {
    const ingredient = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === priorityPackage.dataset.purchasePriorityPackage && item.status === "ACTIVE");
    if (!ingredient) {
      announce("Bahan aktif belum tersedia.", true);
      return;
    }
    ingredientWizard = createIngredientWizardState({ mode: "purchase-option", ingredientId: ingredient.id, name: ingredient.name, categoryName: ingredient.category, categoryId: ingredient.categoryId || "", baseUnit: ingredient.baseUom, step: 3 });
    inventoryArea = "database";
    location.hash = "inventory/database";
    render();
    requestAnimationFrame(() => focusIngredientWizardStep());
    return;
  }
  const minimumStockEdit = event.target.closest("button[data-minimum-stock-edit]");
  if (minimumStockEdit) {
    minimumStockEditorId = minimumStockEdit.dataset.minimumStockEdit;
    minimumStockReturnFocus = minimumStockEditorId;
    replenishmentState = { ...replenishmentState, error: null };
    render();
    requestAnimationFrame(() => {
      const dialog = content.querySelector("#minimum-stock-dialog");
      dialog?.showModal();
      dialog?.querySelector("[name=reorderPoint]")?.focus();
    });
    return;
  }
  if (event.target.closest("button[data-minimum-stock-cancel]")) {
    const returnId = minimumStockReturnFocus;
    minimumStockEditorId = null;
    render();
    requestAnimationFrame(() => content.querySelector(`[data-minimum-stock-edit="${CSS.escape(returnId || "")}"]`)?.focus());
    return;
  }
  const wizardOpen = event.target.closest("button[data-ingredient-wizard-open]");
  if (wizardOpen) {
    openIngredientWizard({ resume: wizardOpen.dataset.ingredientWizardOpen === "resume" });
    return;
  }
  if (event.target.closest("button[data-ingredient-wizard-discard]")) {
    clearIngredientWizardDraft();
    ingredientWizard = null;
    render();
    requestAnimationFrame(() => content.querySelector("[data-ingredient-wizard-open='new']")?.focus());
    return;
  }
  if (event.target.closest("button[data-ingredient-wizard-close]")) {
    const form = content.querySelector("#ingredient-wizard-form");
    if (form) collectIngredientWizardDraft(form);
    persistIngredientWizardDraft();
    ingredientWizard = null;
    render();
    announce("Draft bahan tersimpan di perangkat ini.");
    requestAnimationFrame(() => content.querySelector("[data-ingredient-wizard-open='resume']")?.focus());
    return;
  }
  const successAction = event.target.closest("button[data-ingredient-success]");
  if (successAction && ingredientWizard?.result) {
    const action = successAction.dataset.ingredientSuccess;
    if (action === "next") {
      clearIngredientWizardDraft();
      ingredientWizard = createIngredientWizardState();
      render();
      requestAnimationFrame(() => focusIngredientWizardStep());
    } else if (action === "package") {
      ingredientWizard = createIngredientWizardState({ mode: "purchase-option", ingredientId: ingredientWizard.result.ingredientId, name: ingredientWizard.result.name, categoryName: ingredientWizard.result.categoryName, baseUnit: ingredientWizard.result.baseUnit, step: 3 });
      render();
      requestAnimationFrame(() => focusIngredientWizardStep());
    } else if (action === "stock") {
      ingredientWizard = null;
      location.hash = "inventory/warehouse";
    } else if (action === "database") {
      ingredientWizard = null;
      render();
      requestAnimationFrame(() => content.querySelector("[data-ingredient-wizard-open='new']")?.focus());
    }
    return;
  }
  const inventoryRefresh = event.target.closest("button[data-inventory-refresh]");
  if (inventoryRefresh) {
    await loadInventoryWorkspace({ force: true });
    return;
  }
  const ingredientEdit = event.target.closest("button[data-ingredient-edit]");
  if (ingredientEdit) {
    inventoryEditorId = ingredientEdit.dataset.ingredientEdit;
    render();
    requestAnimationFrame(() => content.querySelector("#ingredient-name")?.focus());
    return;
  }
  const priceImpactOpen = event.target.closest("button[data-ingredient-price-impact]");
  if (priceImpactOpen) {
    const ingredientId = priceImpactOpen.dataset.ingredientPriceImpact;
    const ingredient = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === ingredientId);
    if (!ingredient) {
      announce("Bahan tidak ditemukan. Perbarui data lalu coba lagi.", true);
      return;
    }
    ingredientPriceImpactReturnId = ingredientId;
    ingredientPriceImpact = {
      ingredientId,
      status: "loading",
      data: null,
      error: null,
      referenceFormOpen: false,
      saving: false,
      filters: { month: defaultIngredientPriceMonth(), supplier: "ALL", source: "ACTUAL_RECEIPT" },
    };
    render();
    requestAnimationFrame(() => content.querySelector("#ingredient-price-impact-title")?.focus());
    await loadIngredientPriceImpact({ focus: "heading", renderLoading: false });
    return;
  }
  if (event.target.closest("button[data-ingredient-price-impact-close]")) {
    closeIngredientPriceImpact();
    return;
  }
  if (event.target.closest("button[data-ingredient-price-impact-retry]")) {
    await loadIngredientPriceImpact({ focus: "heading" });
    return;
  }
  if (event.target.closest("button[data-ingredient-price-impact-more]")) {
    await loadIngredientPriceImpact({ focus: "results", append: true, renderLoading: false });
    return;
  }
  if (event.target.closest("button[data-ingredient-price-reference-open]")) {
    if (!ingredientPriceImpact) return;
    ingredientPriceImpact.referenceFormOpen = true;
    render();
    requestAnimationFrame(() => {
      const form = content.querySelector("#ingredient-price-reference-form");
      syncIngredientPriceSimulation(form);
      form?.elements.referencePriceRupiah?.focus();
    });
    return;
  }
  if (event.target.closest("button[data-ingredient-price-reference-cancel]")) {
    if (!ingredientPriceImpact) return;
    ingredientPriceImpact.referenceFormOpen = false;
    render();
    requestAnimationFrame(() => content.querySelector("[data-ingredient-price-reference-open]")?.focus());
    return;
  }
  const hppEdit = event.target.closest("button[data-hpp-edit]");
  if (hppEdit) {
    hppEditorProductId = hppEdit.dataset.hppEdit;
    hppComponentEditor = null;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    render();
    requestAnimationFrame(() => content.querySelector("#hpp-builder-title")?.focus());
    return;
  }
  const phase2HppEdit = event.target.closest("button[data-phase2-hpp-edit]");
  if (phase2HppEdit) {
    hppEditorProductId = phase2HppEdit.dataset.phase2HppEdit;
    hppComponentEditor = null;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    location.hash = "inventory/hpp";
    return;
  }
  const hppComponentAdd = event.target.closest("button[data-hpp-component-add]");
  if (hppComponentAdd) {
    hppComponentEditor = { productId: hppComponentAdd.dataset.hppComponentAdd, ingredientId: "", lines: [emptyHppComponentLine()] };
    hppComponentDirty = false;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    render();
    requestAnimationFrame(() => content.querySelector("#hpp-component-title")?.focus());
    return;
  }
  const hppComponentEdit = event.target.closest("button[data-hpp-line-edit]");
  if (hppComponentEdit) {
    hppComponentEditor = { productId: hppComponentEdit.dataset.hppProduct, ingredientId: hppComponentEdit.dataset.hppLineEdit };
    hppComponentDirty = false;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    render();
    requestAnimationFrame(() => {
      syncHppGuidedEstimate(content.querySelector("#hpp-draft-line-form"));
      content.querySelector("#hpp-component-title")?.focus();
    });
    return;
  }
  const hppComponentCancel = event.target.closest("button[data-hpp-component-cancel]");
  if (hppComponentCancel) {
    requestHppComponentExit(hppComponentCancel, "component");
    return;
  }
  if (event.target.closest("button[data-hpp-unsaved-stay]")) {
    content.querySelector("#hpp-unsaved-dialog")?.close("stay");
    return;
  }
  if (event.target.closest("button[data-hpp-unsaved-discard]")) {
    hppComponentDirty = false;
    content.querySelector("#hpp-unsaved-dialog")?.close("discard");
    return;
  }
  const hppComponentRowAdd = event.target.closest("button[data-hpp-component-row-add]");
  if (hppComponentRowAdd) {
    const form = hppComponentRowAdd.form;
    hppComponentEditor = { ...hppComponentEditor, lines: [...readHppComponentRows(form, { raw: true }), emptyHppComponentLine()] };
    hppComponentDirty = true;
    render();
    requestAnimationFrame(() => content.querySelector("[data-hpp-component-entry]:last-of-type [data-hpp-component-source]")?.focus());
    return;
  }
  const hppComponentRowRemove = event.target.closest("button[data-hpp-component-row-remove]");
  if (hppComponentRowRemove) {
    const form = hppComponentRowRemove.form;
    const index = Number(hppComponentRowRemove.dataset.hppComponentRowRemove);
    const lines = readHppComponentRows(form, { raw: true });
    if (lines.length <= 1 || !Number.isInteger(index) || index < 0 || index >= lines.length) return;
    lines.splice(index, 1);
    hppComponentEditor = { ...hppComponentEditor, lines };
    hppComponentDirty = true;
    render();
    requestAnimationFrame(() => content.querySelector(`[data-hpp-component-entry="${Math.max(0, index - 1)}"] [data-hpp-component-source]`)?.focus());
    return;
  }
  const hppReview = event.target.closest("button[data-hpp-review-open]");
  if (hppReview) {
    hppReviewOpen = true;
    hppComponentEditor = null;
    hppRemoveConfirmationId = null;
    render();
    requestAnimationFrame(() => content.querySelector("#hpp-review-title")?.focus());
    return;
  }
  if (event.target.closest("button[data-hpp-review-close]")) {
    hppReviewOpen = false;
    render();
    requestAnimationFrame(() => content.querySelector("[data-hpp-review-open]")?.focus());
    return;
  }
  const hppQualityFilter = event.target.closest("button[data-hpp-quality-filter]");
  if (hppQualityFilter) {
    hppMenuFilter = hppQualityFilter.dataset.hppQualityFilter;
    hppEditorProductId = null;
    render();
    requestAnimationFrame(() => content.querySelector("#hpp-menu-filter")?.scrollIntoView({ block: "center" }));
    return;
  }
  const hppMenuSwitch = event.target.closest("button[data-hpp-menu-switch]");
  if (hppMenuSwitch) {
    requestHppComponentExit(hppMenuSwitch, "menu");
    return;
  }
  if (event.target.closest("button[data-hpp-edit-cancel]")) {
    requestHppComponentExit(event.target, "menu");
    return;
  }
  const hppRemoveRequest = event.target.closest("button[data-hpp-line-remove-request]");
  if (hppRemoveRequest) {
    hppRemoveConfirmationId = hppRemoveRequest.dataset.hppLineRemoveRequest;
    render();
    requestAnimationFrame(() => content.querySelector(`[data-hpp-line-remove-confirm="${CSS.escape(hppRemoveConfirmationId)}"]`)?.focus());
    return;
  }
  if (event.target.closest("button[data-hpp-line-remove-cancel]")) {
    const returnId = hppRemoveConfirmationId;
    hppRemoveConfirmationId = null;
    render();
    requestAnimationFrame(() => content.querySelector(`[data-hpp-line-remove-request="${CSS.escape(returnId || "")}"]`)?.focus());
    return;
  }
  const hppRemove = event.target.closest("button[data-hpp-line-remove-confirm]");
  if (hppRemove) {
    hppRemoveConfirmationId = null;
    await runInventoryCommand("hpp.draft-line.remove", { productId: hppRemove.dataset.hppProduct, ingredientId: hppRemove.dataset.hppLineRemoveConfirm }, "Menghapus komponen dari draft HPP");
    return;
  }
  const hppMove = event.target.closest("button[data-hpp-line-move]");
  if (hppMove) {
    await moveHppDraftLine(hppMove.dataset.hppProduct, hppMove.dataset.hppIngredient, Number(hppMove.dataset.hppLineMove));
    return;
  }
  if (event.target.closest("button[data-ingredient-edit-cancel]")) {
    inventoryEditorId = null;
    render();
    requestAnimationFrame(() => content.querySelector("#ingredient-code")?.focus());
    return;
  }
  const ingredientArchive = event.target.closest("button[data-ingredient-archive]");
  if (ingredientArchive) {
    const dialog = content.querySelector("#ingredient-archive-dialog");
    const item = inventoryWorkspace.data?.ingredients?.items?.find((candidate) => candidate.id === ingredientArchive.dataset.ingredientArchive);
    if (dialog && item) {
      dialog.querySelector("input[name=ingredientId]").value = item.id;
      dialog.querySelector("[data-archive-name]").textContent = item.name;
      dialog.showModal();
      requestAnimationFrame(() => dialog.querySelector("button[value=cancel]")?.focus());
    }
    return;
  }
  const closeDialog = event.target.closest("button[data-dialog-close]");
  if (closeDialog) { closeDialog.closest("dialog")?.close(); return; }
  const latestButton = event.target.closest("button[data-variance-latest]");
  if (latestButton) {
    inventoryCountPair = { openingCountId: "", closingCountId: "" };
    try { await refresh(); } catch (error) { announce(error.message, true); }
    return;
  }
  const filterButton = event.target.closest("button[data-kds-filter]");
  if (filterButton) {
    kdsFilter = filterButton.dataset.kdsFilter;
    render();
    return;
  }
  const modeButton = event.target.closest("button[data-kds-mode]");
  if (modeButton) {
    kdsModeFilter = modeButton.dataset.kdsMode;
    render();
    return;
  }
  const button = event.target.closest("button[data-fulfillment]");
  if (!button) return;
  button.disabled = true;
  try {
    await request("/api/operator/fulfillment", { method: "POST", csrf: true, body: { orderId: button.dataset.order, target: button.dataset.fulfillment, station: button.dataset.station, reason: button.dataset.reason } });
    await refresh();
  } catch (error) {
    announce(error.message, true);
    button.disabled = false;
  }
});

content.addEventListener("close", (event) => {
  if (event.target.matches?.("#hpp-unsaved-dialog")) {
    const intent = hppDiscardIntent;
    const trigger = hppDiscardTrigger;
    hppDiscardIntent = null;
    hppDiscardTrigger = null;
    if (event.target.returnValue === "discard") performHppComponentExit(intent);
    else requestAnimationFrame(() => trigger?.isConnected && trigger.focus());
    return;
  }
  if (!event.target.matches?.("#minimum-stock-dialog")) return;
  const returnId = minimumStockReturnFocus;
  minimumStockEditorId = null;
  requestAnimationFrame(() => content.querySelector(`[data-minimum-stock-edit="${CSS.escape(returnId || "")}"]`)?.focus());
}, true);

content.addEventListener("cancel", (event) => {
  if (!event.target.matches?.("#hpp-unsaved-dialog")) return;
  event.preventDefault();
  event.target.close("stay");
}, true);

window.addEventListener("beforeunload", (event) => {
  if (!hppComponentDirty && !prepRecipeEditor?.dirty && !prepProductionDialog?.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

content.addEventListener("keydown", (event) => {
  const activeTab = event.target.closest("[data-inventory-area]");
  if (!activeTab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...content.querySelectorAll("[data-inventory-area]")];
  const currentIndex = tabs.indexOf(activeTab);
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (currentIndex + 1) % tabs.length : (currentIndex - 1 + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[nextIndex].click();
});

try {
  if (protectedVercelPreview) await previewLogin();
  await refresh();
  if (!continueToCashier()) showApp();
} catch (error) {
  if (error.status !== 401) announce(error.message, true);
  showLogin();
}

async function login(event) {
  event.preventDefault();
  loginStatus.textContent = "";
  if (!loginForm.reportValidity()) return;
  loginSubmit.disabled = true;
  const idleLabel = loginSubmit.textContent;
  loginSubmit.textContent = "Memeriksa…";
  const values = Object.fromEntries(new FormData(loginForm).entries());
  values.surface = surface;
  try {
    const result = await request("/api/operator/login", { method: "POST", body: values });
    if (result.actor.role === 'owner' && continueToCashier()) return;
    const next = new URLSearchParams(location.search).get("next");
    if (document.body.dataset.production && ["/kiosk", "/hr"].includes(next)) { location.replace(next); return; }
    if ((surface === "dashboard" && result.actor.role !== "owner") || (surface === "kds" && !["bar", "owner"].includes(result.actor.role))) {
      throw new Error("Role ini tidak sesuai dengan perangkat operasional.");
    }
    await refresh();
    showApp();
  } catch (error) {
    loginStatus.textContent = error.status === 401 ? "Password tidak cocok. Coba lagi." : "Login belum berhasil. Coba beberapa saat lagi.";
    passwordInput.select();
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = idleLabel;
  }
}

function continueToCashier() {
  if (surface === 'dashboard' && document.body.dataset.production === 'true' && new URLSearchParams(location.search).get('next') === '/cashier') {
    location.replace('/cashier');
    return true;
  }
  return false;
}

async function previewLogin() {
  return request("/api/operator/preview-login", { method: "POST", body: { surface } });
}

async function logout() {
  clearInterval(pollTimer);
  clearIngredientWizardDraft();
  await request("/api/operator/logout", { method: "POST", csrf: true });
  clearWarehouseReceiptAttemptKey();
  snapshot = null;
  csrfToken = "";
  openVarianceEvidenceIds.clear();
  inventoryWorkspace = { status: "idle", data: null, error: null, stale: false };
  inventoryEditorId = null;
  ingredientWizard = null;
  warehouseCountOpen = false;
  warehouseCountDraftRevision = null;
  warehouseCountDraftLines = {};
  warehouseCountDraftReason = "Full stock count gudang utama";
  warehouseCountMovementChecked = false;
  staffReceiptQueue = { status: "idle", data: null, error: null };
  staffReceiptFilters = { status: "ALL", query: "" };
  staffReceiptDetail = { status: "idle", id: null, data: null, error: null };
  staffReceiptEvidenceId = null;
  staffReceiptCapabilities = { status: "idle", data: null, error: null };
  loginForm.reset();
  employeeInput.value = surface === "dashboard" ? simpleProductionDashboard ? "" : "OWNER-DEMO" : document.body.dataset.production ? "" : "BAR-01";
  passwordInput.type = "password";
  passwordToggle.textContent = "Lihat";
  passwordToggle.setAttribute("aria-pressed", "false");
  showLogin();
}

async function refresh() {
  if (refreshing) { refreshQueued = true; return refreshPromise; }
  refreshing = true;
  refreshPromise = performRefresh();
  return refreshPromise;
}

async function performRefresh() {
  const requestedSession = sessionRevision;
  const requestedDate = reportDate;
  const requestedPair = JSON.stringify(inventoryCountPair);
  try {
  const params = new URLSearchParams();
  if (surface === "dashboard" && requestedDate) params.set("reportDate", requestedDate);
  if (surface === "dashboard" && inventoryCountPair.openingCountId && inventoryCountPair.closingCountId) {
    params.set("openingCountId", inventoryCountPair.openingCountId);
    params.set("closingCountId", inventoryCountPair.closingCountId);
  }
  const nextSnapshot = await request(`/api/operator/state${params.size ? `?${params}` : ""}`);
  if (requestedSession !== sessionRevision) return;
  if (requestedDate !== reportDate || requestedPair !== JSON.stringify(inventoryCountPair)) { refreshQueued = true; return; }
  snapshot = nextSnapshot;
  csrfToken = snapshot.csrfToken;
  if (surface === "dashboard" && snapshot.actor.role !== "owner") throw new Error("Owner role diperlukan untuk dashboard.");
  if (surface === "dashboard" && dashboardModule === "orders") await loadOwnerOrders({ renderPage: false });
  if (requestedSession !== sessionRevision || !snapshot) return;
  render();
  if (snapshot.permissions && !snapshot.permissions.includes('kds.write')) document.querySelectorAll('[data-fulfillment], [data-station-action]').forEach(el => { el.hidden = true; });
  } finally { refreshing = false; if (refreshQueued) { refreshQueued = false; await refresh(); } }
}

async function loadBusinessMasterReadiness({ force = false } = {}) {
  if (!force && ["loading", "ready"].includes(businessMasterReadiness.status)) return;
  businessMasterReadiness = { status: "loading", data: businessMasterReadiness.data, error: null };
  if (snapshot && dashboardModule === "readiness") render();
  try {
    const response = await request("/api/operator/business-master-readiness");
    businessMasterReadiness = { status: "ready", data: { ...response.data, phase3: response.phase3, phase4: response.phase4, phase5: response.phase5, phase6: response.phase6, phase7: response.phase7, phase8a: response.phase8a }, error: null };
  } catch (error) {
    businessMasterReadiness = { status: "error", data: businessMasterReadiness.data, error };
  }
  if (snapshot && dashboardModule === "readiness") render();
}

async function loadPhase5MemberLifecycle({ force = false } = {}) {
  if (!force && ["loading", "ready"].includes(phase5MemberState.status)) return;
  phase5MemberState = { ...phase5MemberState, status: "loading", error: null };
  if (snapshot && dashboardModule === "member") render();
  try {
    const data = await request("/api/operator/member-lifecycle");
    phase5MemberState = { status: "ready", readiness: data.readiness, scenarios: data.scenarios ?? [], result: phase5MemberState.result, error: null };
  } catch (error) {
    phase5MemberState = { ...phase5MemberState, status: "error", error: error.message };
  }
  if (snapshot && dashboardModule === "member") render();
}

async function runPhase5MemberSimulation(form) {
  const values = new FormData(form);
  phase5MemberDraft = {
    scenario: String(values.get("scenario") ?? "HAPPY_PATH"),
    eligibleSpendRupiah: Number(values.get("eligibleSpendRupiah")),
    rewardCostPoints: Number(values.get("rewardCostPoints")),
    idempotencyKey: String(values.get("idempotencyKey") ?? ""),
  };
  phase5MemberState = { ...phase5MemberState, status: "running", error: null };
  render();
  try {
    const result = await request("/api/operator/member-lifecycle/simulate", {
      method: "POST",
      csrf: true,
      body: {
        ...phase5MemberDraft,
      },
    });
    phase5MemberState = { ...phase5MemberState, status: "ready", result, error: null };
    render();
    announce("Simulasi lifecycle member selesai tanpa mengubah poin pelanggan.");
  } catch (error) {
    phase5MemberState = { ...phase5MemberState, status: "error", error: error.message };
    render();
    announce(error.message, true);
  }
}

async function loadPhase6FinanceClosing({ force = false } = {}) {
  if (!force && ["loading", "ready"].includes(phase6ClosingState.status)) return;
  phase6ClosingState = { ...phase6ClosingState, status: "loading", error: null };
  if (snapshot && dashboardModule === "readiness" && readinessArea === "closing") render();
  try {
    const data = await request("/api/operator/finance-closing");
    phase6ClosingState = { status: "ready", readiness: data.readiness, scenarios: data.scenarios ?? [], result: phase6ClosingState.result, error: null };
  } catch (error) {
    phase6ClosingState = { ...phase6ClosingState, status: "error", error: error.message };
  }
  if (snapshot && dashboardModule === "readiness" && readinessArea === "closing") render();
}

async function runPhase6ClosingSimulation(form) {
  const values = new FormData(form);
  phase6ClosingDraft = {
    scenario: String(values.get("scenario") ?? "CLEAN_CLOSE"),
    expectedCashRupiah: Number(values.get("expectedCashRupiah")),
    declaredCashRupiah: Number(values.get("declaredCashRupiah")),
    idempotencyKey: String(values.get("idempotencyKey") ?? ""),
  };
  phase6ClosingState = { ...phase6ClosingState, status: "running", error: null };
  render();
  try {
    const result = await request("/api/operator/finance-closing/simulate", { method: "POST", csrf: true, body: phase6ClosingDraft });
    phase6ClosingState = { ...phase6ClosingState, status: "ready", result, error: null };
    render();
    announce(result.decision === "BLOCKED" ? "Simulasi selesai. Tindakan koreksi tersedia sebelum closing." : "Simulasi closing bersih selesai tanpa mengubah fakta bisnis.");
  } catch (error) {
    phase6ClosingState = { ...phase6ClosingState, status: "error", error: error.message };
    render();
    announce(error.message, true);
  }
}

async function loadPhase7ResiliencePilot({ force = false } = {}) {
  if (!force && ["loading", "ready"].includes(phase7ResilienceState.status)) return;
  phase7ResilienceState = { ...phase7ResilienceState, status: "loading", error: null };
  if (snapshot && dashboardModule === "readiness" && readinessArea === "pilot") render();
  try {
    const data = await request("/api/operator/resilience-pilot");
    phase7ResilienceState = { status: "ready", readiness: data.readiness, scenarios: data.scenarios ?? [], result: phase7ResilienceState.result, error: null };
  } catch (error) {
    phase7ResilienceState = { ...phase7ResilienceState, status: "error", error: error.message };
  }
  if (snapshot && dashboardModule === "readiness" && readinessArea === "pilot") render();
}

async function runPhase7ResilienceSimulation(form) {
  const values = new FormData(form);
  phase7ResilienceDraft = {
    scenario: String(values.get("scenario") ?? "RUSH_HOUR"),
    requestedOrders: Number(values.get("requestedOrders")),
    concurrentUsers: Number(values.get("concurrentUsers")),
    idempotencyKey: String(values.get("idempotencyKey") ?? ""),
  };
  phase7ResilienceState = { ...phase7ResilienceState, status: "running", error: null };
  render();
  try {
    const result = await request("/api/operator/resilience-pilot/simulate", { method: "POST", csrf: true, body: phase7ResilienceDraft });
    phase7ResilienceState = { ...phase7ResilienceState, status: "ready", result, error: null };
    render();
    announce(result.decision === "SIMULATION_PASS" ? "Pilot satu shift selesai tanpa mengubah fakta bisnis." : "Pilot simulasi selesai. Action queue tersedia untuk Owner dan Finance.");
  } catch (error) {
    phase7ResilienceState = { ...phase7ResilienceState, status: "error", error: error.message };
    render();
    announce(error.message, true);
  }
}

async function loadInventoryWorkspace({ force = false } = {}) {
  if (surface !== "dashboard" || dashboardModule !== "inventory") return;
  if (inventoryWorkspace.status === "loading" && !force) return;
  const previous = inventoryWorkspace.data;
  inventoryWorkspace = { status: "loading", data: previous, error: null, stale: false };
  if (snapshot) render();
  try {
    const data = await request("/api/operator/inventory-workspace");
    inventoryWorkspace = { status: "ready", data, error: null, stale: false };
    await Promise.all([
      loadReplenishmentPolicies({ renderAfter: false }),
      loadStaffReceipts({ renderAfter: false }),
      loadStaffReceiptCapabilities({ renderAfter: false }),
    ]);
  } catch (error) {
    if (error.status === 401) { showLogin(); return; }
    inventoryWorkspace = previous
      ? { status: "ready", data: previous, error: error.message, stale: true }
      : { status: "error", data: null, error: error.message, stale: false };
  }
  if (snapshot && dashboardModule === "inventory") render();
}

async function loadStaffReceipts({ force = false, renderAfter = true } = {}) {
  if (surface !== "dashboard" || dashboardModule !== "inventory") return;
  if (staffReceiptQueue.status === "loading" && !force) return;
  const previous = staffReceiptQueue.data;
  staffReceiptQueue = { status: "loading", data: previous, error: null };
  if (renderAfter && snapshot) render();
  try {
    const data = await request("/api/operator/inventory-receipts");
    staffReceiptQueue = { status: "ready", data, error: null };
  } catch (error) {
    staffReceiptQueue = { status: "error", data: previous, error: error.message };
  }
  if (renderAfter && snapshot && dashboardModule === "inventory") render();
}

async function loadStaffReceiptCapabilities({ force = false, renderAfter = true } = {}) {
  if (surface !== "dashboard" || dashboardModule !== "inventory") return;
  if (staffReceiptCapabilities.status === "loading" && !force) return;
  const previous = staffReceiptCapabilities.data;
  staffReceiptCapabilities = { status: "loading", data: previous, error: null };
  if (renderAfter && snapshot) render();
  try {
    const [nativeStaff, assignments] = await Promise.all([
      request("/api/operator/native-staff/state"),
      request("/api/operator/inventory-receipts/capabilities"),
    ]);
    staffReceiptCapabilities = { status: "ready", data: {
      staff: nativeStaff.data?.staff ?? nativeStaff.staff ?? [],
      assignments: assignments.assignments ?? assignments.items ?? assignments.staff ?? [],
    }, error: null };
  } catch (error) {
    staffReceiptCapabilities = { status: "error", data: previous, error: error.message };
  }
  if (renderAfter && snapshot && dashboardModule === "inventory") render();
}

async function loadStaffReceiptDetail(receiptId) {
  if (!receiptId || staffReceiptDetail.status === "loading") return;
  staffReceiptEvidenceId = null;
  staffReceiptDetail = { status: "loading", id: receiptId, data: null, error: null };
  render();
  try {
    const data = await request(`/api/operator/inventory-receipts/${encodeURIComponent(receiptId)}`);
    staffReceiptDetail = { status: "ready", id: receiptId, data, error: null };
  } catch (error) {
    staffReceiptDetail = { status: "error", id: receiptId, data: null, error: error.message };
  }
  render();
  requestAnimationFrame(() => content.querySelector("#staff-receipt-detail-title")?.focus());
}

function closeStaffReceiptDetail() {
  const receiptId = staffReceiptDetail.id;
  staffReceiptDetail = { status: "idle", id: null, data: null, error: null };
  staffReceiptEvidenceId = null;
  render();
  requestAnimationFrame(() => content.querySelector(`[data-staff-receipt-open="${CSS.escape(receiptId || "")}"]`)?.focus());
}

async function submitStaffReceiptReview(form, submitter) {
  if (staffReceiptReviewPending || staffReceiptDetail.status !== "ready") return;
  const values = new FormData(form, submitter);
  const decision = String(values.get("decision") ?? "");
  if (!["APPROVE", "REJECT", "NEEDS_CORRECTION"].includes(decision)) return;
  const approvalBlockers = staffReceiptApprovalBlockers(staffReceiptDetail.data);
  if (decision === "APPROVE" && approvalBlockers.length) {
    const message = `Receipt belum dapat diposting: ${approvalBlockers.map((item) => item.label).join(", ")}. Pilih Minta perbaikan.`;
    const status = form.querySelector("[data-staff-receipt-review-status]");
    if (status) status.textContent = message;
    announce(message, true);
    return;
  }
  staffReceiptReviewPending = true;
  const status = form.querySelector("[data-staff-receipt-review-status]");
  if (status) status.textContent = "Menyimpan keputusan…";
  try {
    await request(`/api/operator/inventory-receipts/${encodeURIComponent(staffReceiptDetail.id)}/review`, {
      method: "POST", csrf: true,
      body: {
        decision,
        note: String(values.get("reason") ?? "").trim(),
        expectedRevision: staffReceiptDetail.data?.revision ?? staffReceiptDetail.data?.receipt?.revision ?? null,
        idempotencyKey: `staff-receipt-review:${staffReceiptDetail.id}:r${staffReceiptDetail.data?.revision ?? staffReceiptDetail.data?.receipt?.revision ?? "unknown"}:${decision}`,
      },
    });
    const receiptId = staffReceiptDetail.id;
    await loadInventoryWorkspace({ force: true });
    await loadStaffReceiptDetail(receiptId);
    announce(decision === "APPROVE" ? "Penerimaan disetujui" : decision === "REJECT" ? "Penerimaan ditolak" : "Perbaikan diminta");
  } catch (error) {
    if (status) status.textContent = error.message;
    announce(error.message, true);
  } finally {
    staffReceiptReviewPending = false;
  }
}

async function submitStaffReceiptCapabilities(form) {
  if (staffReceiptCapabilityPending) return;
  const values = new FormData(form);
  const staffId = String(values.get("staffId") ?? "");
  if (!staffId) return;
  staffReceiptCapabilityPending = true;
  const status = form.querySelector("[data-staff-capability-status]");
  if (status) status.textContent = "Menyimpan izin…";
  try {
    await request("/api/operator/inventory-receipts/capabilities", {
      method: "POST", csrf: true,
      body: { staffId, capabilities: values.getAll("capabilities").map(String) },
    });
    await loadStaffReceiptCapabilities({ force: true, renderAfter: false });
    render();
    announce("Izin Barang Datang diperbarui");
    requestAnimationFrame(() => content.querySelector(`[data-staff-receipt-capability-form][data-staff-id="${CSS.escape(staffId)}"] summary`)?.focus());
  } catch (error) {
    if (status) status.textContent = error.message;
    announce(error.message, true);
  } finally {
    staffReceiptCapabilityPending = false;
  }
}

async function loadReplenishmentPolicies({ renderAfter = true } = {}) {
  replenishmentState = { status: "loading", data: replenishmentState.data, error: null };
  try {
    const data = await request("/api/operator/replenishment");
    replenishmentState = { status: "ready", data, error: null };
  } catch (error) {
    replenishmentState = { status: "error", data: null, error: error.message };
  }
  if (renderAfter && snapshot && dashboardModule === "inventory") render();
}

async function submitMinimumStock(form) {
  if (minimumStockPending) return;
  const values = new FormData(form);
  const itemId = String(values.get("itemId") ?? "");
  const policy = minimumStockPolicy(itemId);
  minimumStockPending = true;
  const status = form.querySelector("#minimum-stock-status");
  if (status) status.textContent = "Menyimpan minimum stok…";
  try {
    await request("/api/admin/replenishment/policies", {
      method: "POST", csrf: true,
      body: {
        operationKey: String(values.get("operationKey")), itemId,
        mode: "REORDER_POINT", minimum: 0, maximum: 0,
        reorderPoint: Number(values.get("reorderPoint")), par: 0, staticFallback: 1,
        expectedRevision: policy?.revision ?? 0,
        reason: String(values.get("reason") ?? ""),
      },
    });
    clearMinimumStockAttemptKey(itemId);
    minimumStockEditorId = null;
    await loadReplenishmentPolicies({ renderAfter: false });
    render();
    announce("Minimum stok tersimpan");
    requestAnimationFrame(() => content.querySelector(`[data-minimum-stock-edit="${CSS.escape(itemId)}"]`)?.focus());
  } catch (error) {
    if (error.status === 409) {
      clearMinimumStockAttemptKey(itemId);
      await loadReplenishmentPolicies({ renderAfter: false });
      replenishmentState = { ...replenishmentState, error: "Aturan berubah di perangkat lain. Buka kembali lalu simpan ulang." };
      minimumStockEditorId = null;
      render();
    } else if (status) {
      status.textContent = error.message;
    }
    announce(error.message, true);
  } finally {
    minimumStockPending = false;
  }
}

async function submitIngredientMaster(form) {
  const values = new FormData(form);
  const rawCost = String(values.get("costPerUnitRupiah") ?? "").trim();
  const sourcingMode = String(values.get("sourcingMode") ?? "PURCHASED");
  await runInventoryCommand("ingredient.upsert", {
    ...(values.get("ingredientId") ? { ingredientId: values.get("ingredientId") } : {}),
    code: values.get("code"), name: values.get("name"), category: values.get("category"), baseUnit: values.get("baseUnit"),
    sourcingMode, materialType: sourcingMode === "MADE_IN_HOUSE" ? "PREP_ITEM" : "RAW_MATERIAL",
    purchasable: sourcingMode === "MADE_IN_HOUSE" ? false : values.get("purchasable") === "on",
    costPerUnitRupiah: sourcingMode === "MADE_IN_HOUSE" || rawCost === "" ? null : Number(rawCost),
    lotTrackingPolicy: values.get("lotTrackingPolicy"), minimumShelfLifeDays: Number(values.get("minimumShelfLifeDays") || 0),
  }, values.get("reason"), { onSuccess: () => { inventoryEditorId = null; } });
}

async function submitIngredientConversion(form) {
  const values = new FormData(form);
  await runInventoryCommand("ingredient.conversion.upsert", {
    ingredientId: values.get("ingredientId"), fromUom: values.get("fromUom"), toUom: values.get("toUom"), factor: Number(values.get("factor")),
  }, values.get("reason"));
}

async function submitIngredientPackage(form) {
  const values = new FormData(form);
  await runInventoryCommand("ingredient.supplier-package.upsert", {
    ingredientId: values.get("ingredientId"), supplierName: values.get("supplierName"), packageLabel: values.get("packageLabel"),
    purchaseUom: values.get("purchaseUom"), quantityPerPackage: Number(values.get("quantityPerPackage")), barcode: values.get("barcode") || null,
  }, values.get("reason"));
}

async function submitWarehouseReceipt(form) {
  const values = new FormData(form);
  const purchaseOptionId = String(values.get("purchaseOptionId") ?? "").trim();
  const lotCode = String(values.get("lotCode") ?? "").trim();
  const purchaseQuantity = Number(values.get("purchaseQuantity"));
  await runInventoryCommand("warehouse.receipt.post", {
    idempotencyKey: values.get("idempotencyKey") || warehouseReceiptAttemptKey,
    supplierName: values.get("supplierName"), destinationLocationId: values.get("destinationLocationId"),
    lines: [{
      ingredientId: values.get("ingredientId"),
      ...(purchaseOptionId ? { purchaseOptionId } : { packageLabel: values.get("packageLabel"), purchaseUom: values.get("purchaseUom") }),
      purchaseQuantity,
      totalCostRupiah: Number(values.get("totalCostRupiah")),
      ...(lotCode ? { lots: [{ lotCode, expiryDate: values.get("expiryDate"), deliveredPurchaseQuantity: purchaseQuantity, acceptedPurchaseQuantity: purchaseQuantity, rejectedPurchaseQuantity: 0, quarantinedPurchaseQuantity: 0, pendingInspectionPurchaseQuantity: 0 }] } : {}),
    }],
  }, values.get("reason"), { onSuccess: () => {
    clearWarehouseReceiptAttemptKey();
    warehouseReceiptOpen = false;
    requestAnimationFrame(() => content.querySelector("#warehouse-receipt-history")?.focus());
  } });
}

async function submitWarehouseTransfer(form) {
  const values = new FormData(form);
  await runInventoryCommand("warehouse.transfer.record", {
    idempotencyKey: inventoryOperationKey("owner-transfer"), ingredientId: values.get("ingredientId"),
    quantityBase: Number(values.get("quantityBase")), sourceLocationId: values.get("sourceLocationId"), destinationLocationId: values.get("destinationLocationId"),
  }, values.get("reason"), { onSuccess: () => form.reset() });
}

async function submitWarehouseMovement(form) {
  const values = new FormData(form);
  await runInventoryCommand("warehouse.movement.record", {
    idempotencyKey: inventoryOperationKey("owner-movement"),
    movementType: values.get("movementType"),
    ingredientId: values.get("ingredientId"),
    quantityBase: Number(values.get("quantityBase")),
    locationId: values.get("locationId"),
    effectiveAt: values.get("effectiveAt") ? new Date(values.get("effectiveAt")).toISOString() : undefined,
  }, values.get("reason"), { onSuccess: () => form.reset(), statusSelector: "#warehouse-movement-status" });
}

async function submitWarehouseCount(form) {
  const values = new FormData(form);
  const lines = [...form.querySelectorAll("[data-count-ingredient]")].map((input) => ({
    ingredientId: input.dataset.countIngredient,
    quantityBase: Number(input.value),
    ...(values.get("countKind") === "OPENING_BASELINE" ? { unitCostPerBaseUnitRupiah: Number(input.dataset.unitCost) } : {}),
  }));
  await runInventoryCommand("warehouse.count.complete", {
    idempotencyKey: inventoryOperationKey("owner-count"),
    countKind: values.get("countKind") || "CYCLE",
    businessDate: values.get("businessDate") || undefined,
    lines,
  }, values.get("reason"), { expectedRevision: warehouseCountDraftRevision ?? Number(form.dataset.countRevision), onSuccess: () => {
    warehouseCountOpen = false;
    warehouseCountDraftRevision = null;
    warehouseCountDraftLines = {};
    warehouseCountDraftReason = "Full stock count gudang utama";
    warehouseCountMovementChecked = false;
  } });
}

async function submitHppDraftLine(form) {
  const values = new FormData(form);
  const components = readHppComponentRows(form);
  if (!components.length || !validateHppComponentRows(form)) return;
  if (!form.elements.reason.checkValidity()) {
    form.elements.reason.reportValidity();
    form.elements.reason.focus();
    return;
  }
  await runInventoryCommand("hpp.draft-lines.upsert", {
    productId: values.get("productId"), components,
  }, values.get("reason"), { onSuccess: () => { hppComponentDirty = false; hppComponentEditor = null; } });
}

function emptyHppComponentLine() {
  return { lineType: "INGREDIENT", ingredientId: "", quantity: "", uom: "", yieldPct: 100 };
}

function readHppComponentRows(form, { raw = false } = {}) {
  if (!form) return [];
  return [...form.querySelectorAll("[data-hpp-component-entry]")].map((row) => {
    const line = {
      lineType: row.querySelector("[data-hpp-component-type]")?.value ?? "INGREDIENT",
      ingredientId: row.querySelector("[data-hpp-component-source]")?.value ?? "",
      quantity: row.querySelector("[data-hpp-component-quantity]")?.value ?? "",
      uom: row.querySelector("[data-hpp-component-uom]")?.value ?? "",
      yieldPct: row.querySelector("[data-hpp-component-yield]")?.value ?? "100",
    };
    return raw ? line : { ...line, quantity: Number(line.quantity), yieldPct: Number(line.yieldPct) };
  });
}

function requestHppComponentExit(trigger, intent) {
  if (!hppComponentDirty) {
    performHppComponentExit(intent);
    return;
  }
  hppDiscardIntent = intent;
  hppDiscardTrigger = trigger;
  const dialog = content.querySelector("#hpp-unsaved-dialog");
  dialog?.showModal();
  requestAnimationFrame(() => dialog?.querySelector("[data-hpp-unsaved-stay]")?.focus());
}

function performHppComponentExit(intent) {
  const editingId = hppComponentEditor?.ingredientId ?? "";
  const productId = hppEditorProductId;
  hppComponentDirty = false;
  hppComponentEditor = null;
  if (intent === "menu") {
    hppEditorProductId = null;
    hppRemoveConfirmationId = null;
    hppReviewOpen = false;
    render();
    requestAnimationFrame(() => {
      const menuButton = productId ? content.querySelector(`[data-hpp-edit="${CSS.escape(productId)}"]`) : null;
      (menuButton || content.querySelector("#hpp-menu-filter [name=query]"))?.focus();
    });
    return;
  }
  render();
  requestAnimationFrame(() => {
    const selector = editingId ? `[data-hpp-line-edit="${CSS.escape(editingId)}"]` : "[data-hpp-component-add]";
    content.querySelector(selector)?.focus();
  });
}

async function submitHppPublish(form) {
  const values = new FormData(form);
  await runInventoryCommand("hpp.draft.publish", { productId: values.get("productId") }, values.get("reason"), { onSuccess: () => {
    hppReviewOpen = false;
    hppComponentEditor = null;
    hppEditorProductId = null;
  } });
}

function syncHppGuidedEstimate(form) {
  if (!form) return;
  const rows = [...form.querySelectorAll("[data-hpp-component-entry]")];
  const selectedIds = new Map();
  let batchCost = 0;
  let replacedCost = 0;
  let allComplete = rows.length > 0;
  for (const row of rows) {
    const source = row.querySelector("[data-hpp-component-source]");
    const option = source?.selectedOptions?.[0];
    const uom = String(option?.dataset.baseUom ?? "");
    const uomField = row.querySelector("[data-hpp-component-uom]");
    if (uomField) uomField.value = uom;
    const quantity = Number(row.querySelector("[data-hpp-component-quantity]")?.value);
    const yieldPct = Number(row.querySelector("[data-hpp-component-yield]")?.value);
    const effectiveQuantity = Math.round((quantity / (yieldPct / 100)) * 1_000) / 1_000;
    const valid = Boolean(source?.value) && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(yieldPct) && yieldPct > 0 && yieldPct <= 100
      && Number.isFinite(effectiveQuantity) && effectiveQuantity > 0 && effectiveQuantity <= 1_000_000;
    const priced = option?.dataset.costStatus === "PRICED" && Number.isFinite(Number(option.dataset.unitCost));
    const lineCost = valid && priced ? Math.round(effectiveQuantity * Number(option.dataset.unitCost)) : null;
    row.querySelector("[data-hpp-row-unit]").textContent = uom || "Pilih sumber";
    row.querySelector("[data-hpp-row-cost]").textContent = lineCost == null ? (valid ? "Biaya belum tersedia" : "Belum dihitung") : rupiah(lineCost);
    row.querySelector("[data-hpp-row-effective]").textContent = valid ? `${formatPlainNumber(effectiveQuantity)} ${uom}` : "Belum dihitung";
    if (source?.value) selectedIds.set(source.value, (selectedIds.get(source.value) ?? 0) + 1);
    if (lineCost == null) allComplete = false;
    else batchCost += lineCost;
    const existingCost = Number(option?.dataset.existingCost || 0);
    if (Number.isFinite(existingCost)) replacedCost += existingCost;
  }
  for (const row of rows) {
    const source = row.querySelector("[data-hpp-component-source]");
    source?.setCustomValidity(source.value && selectedIds.get(source.value) > 1 ? "Sumber yang sama hanya boleh dipakai satu kali." : "");
  }
  const duplicate = [...selectedIds.values()].some((count) => count > 1);
  if (duplicate || form.dataset.validationAttempted === "true") updateHppComponentValidationFeedback(form);
  else {
    const batchError = form.querySelector("[data-hpp-batch-error]");
    if (batchError) batchError.textContent = "";
    form.querySelectorAll('[data-hpp-component-entry] [aria-invalid="true"]').forEach((field) => field.removeAttribute("aria-invalid"));
  }
  const draftIsComplete = form.dataset.draftComplete === "true";
  const hasDraft = form.dataset.hasDraft === "true";
  const draftTotal = Number(form.dataset.draftTotal);
  const canProject = allComplete && !duplicate && (!hasDraft || draftIsComplete) && Number.isFinite(draftTotal);
  const projectedTotal = canProject ? draftTotal - replacedCost + batchCost : null;
  form.dataset.projectedTotal = projectedTotal == null ? "" : String(projectedTotal);
  const projectedLabel = form.querySelector("[data-hpp-live-total]");
  const grossLabel = form.querySelector("[data-hpp-live-gross]");
  const marginLabel = form.querySelector("[data-hpp-live-margin]");
  const note = form.querySelector("[data-hpp-live-note]");
  if (projectedLabel) projectedLabel.textContent = projectedTotal == null ? "Belum dapat dihitung" : rupiah(projectedTotal);
  const sellingPrice = Number(form.dataset.sellingPrice);
  const grossProfit = projectedTotal == null || !Number.isFinite(sellingPrice) ? null : sellingPrice - projectedTotal;
  const marginPct = grossProfit == null || sellingPrice <= 0 ? null : Math.round((grossProfit / sellingPrice) * 10_000) / 100;
  form.dataset.projectedGross = grossProfit == null ? "" : String(grossProfit);
  form.dataset.projectedMargin = marginPct == null ? "" : String(marginPct);
  if (grossLabel) grossLabel.textContent = grossProfit == null ? "Belum dapat dihitung" : rupiah(grossProfit);
  if (marginLabel) marginLabel.textContent = marginPct == null ? "Belum dapat dihitung" : `${marginPct}%`;
  if (note) note.textContent = canProject ? `${rows.length} komponen siap disimpan ke draft. Margin kotor hanya memakai komponen HPP yang tercatat; biaya operasional dan pembayaran belum dihitung.` : "Lengkapi bahan dan takaran. Bahan tanpa biaya tetap boleh disimpan sebagai draft, tetapi belum bisa dipublikasikan.";
}

function moveHppComponentStep(form, step, { validate = true } = {}) {
  if (!form || ![1, 2].includes(step)) return false;
  const current = form.querySelector(`[data-hpp-component-panel="${form.dataset.step || 1}"]`);
  if (validate && current && (!validateHppComponentPanel(current) || !validateHppComponentRows(form))) return false;
  form.dataset.step = String(step);
  form.dataset.reviewed = step === 2 ? "true" : "false";
  form.querySelectorAll("[data-hpp-component-panel]").forEach((panel) => { panel.hidden = panel.dataset.hppComponentPanel !== String(step); });
  form.closest(".hpp-component-wizard")?.querySelectorAll("[data-hpp-component-step]").forEach((item) => {
    const itemStep = Number(item.dataset.hppComponentStep);
    item.classList.toggle("is-complete", itemStep < step);
    item.classList.toggle("is-current", itemStep === step);
    if (itemStep === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  syncHppGuidedEstimate(form);
  const heading = form.querySelector(`[data-hpp-component-panel="${step}"] h3`);
  requestAnimationFrame(() => heading?.focus());
  return true;
}

function validateHppComponentPanel(panel) {
  const fields = [...panel.querySelectorAll("input, select")].filter((field) => !field.disabled && field.type !== "hidden");
  const invalid = fields.find((field) => !field.checkValidity());
  if (!invalid) return true;
  invalid.reportValidity();
  invalid.focus();
  return false;
}

function invalidateHppComponentReview(form) {
  if (!form) return;
  form.dataset.reviewed = "false";
  if (form.dataset.step === "2") moveHppComponentStep(form, 1, { validate: false });
}

function openHppComponentReview(form) {
  const panel = form?.querySelector('[data-hpp-component-panel="1"]');
  if (!form || !panel || !validateHppComponentRows(form)) return false;
  syncHppGuidedEstimate(form);
  const review = form.querySelector("[data-hpp-batch-review-list]");
  if (review) review.innerHTML = [...form.querySelectorAll("[data-hpp-component-entry]")].map((row, index) => {
    const option = row.querySelector("[data-hpp-component-source]")?.selectedOptions?.[0];
    const quantity = Number(row.querySelector("[data-hpp-component-quantity]")?.value);
    const yieldPct = Number(row.querySelector("[data-hpp-component-yield]")?.value);
    const uom = row.querySelector("[data-hpp-component-uom]")?.value ?? "";
    const name = option?.dataset.ingredientName || option?.textContent?.split(" · ")[0] || "Komponen";
    return `<li><span><strong>${index + 1}. ${escapeHtml(name)}</strong><small>${row.querySelector("[data-hpp-component-type]")?.value === "PACKAGING" ? "Kemasan" : "Bahan"} · ${formatPlainNumber(quantity)} ${escapeHtml(uom)} · yield ${formatPlainNumber(yieldPct)}%</small></span><strong>${escapeHtml(row.querySelector("[data-hpp-row-cost]")?.textContent || "Belum dihitung")}</strong></li>`;
  }).join("");
  const projectedTotal = Number(form.dataset.projectedTotal);
  const projectedGross = Number(form.dataset.projectedGross);
  const projectedMargin = Number(form.dataset.projectedMargin);
  setHppComponentReviewValue(form, "total", form.dataset.projectedTotal === "" ? "Belum dapat dihitung" : rupiah(projectedTotal));
  setHppComponentReviewValue(form, "gross", form.dataset.projectedGross === "" ? "Belum dapat dihitung" : rupiah(projectedGross));
  setHppComponentReviewValue(form, "margin", form.dataset.projectedMargin === "" ? "Belum dapat dihitung" : `${projectedMargin}%`);
  return moveHppComponentStep(form, 2, { validate: false });
}

function validateHppComponentRows(form) {
  form.dataset.validationAttempted = "true";
  syncHppGuidedEstimate(form);
  return updateHppComponentValidationFeedback(form, { focus: true, report: true });
}

function updateHppComponentValidationFeedback(form, { focus = false, report = false } = {}) {
  const fields = [...form.querySelectorAll("[data-hpp-component-entry] input, [data-hpp-component-entry] select")];
  const invalid = fields.find((field) => !field.checkValidity());
  fields.forEach((field) => {
    if (!field.checkValidity()) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  });
  const feedback = form.querySelector("[data-hpp-batch-error]");
  if (!invalid) {
    if (feedback) feedback.textContent = "";
    return true;
  }
  const row = invalid.closest("[data-hpp-component-entry]");
  const componentNumber = Number(row?.dataset.hppComponentEntry ?? 0) + 1;
  let guidance = "periksa data komponen ini.";
  if (invalid.matches("[data-hpp-component-source]")) {
    guidance = invalid.validity.customError
      ? "nama komponen ini sudah dipakai. Pilih bahan atau kemasan yang berbeda."
      : "pilih nama komponen dari Database Bahan.";
  } else if (invalid.matches("[data-hpp-component-quantity]")) {
    guidance = "isi pemakaian per menu antara 0,001 dan 1.000.000.";
  } else if (invalid.matches("[data-hpp-component-yield]")) {
    guidance = "isi yield antara 0,001% dan 100%.";
  } else if (invalid.matches("[data-hpp-component-uom]")) {
    guidance = "pilih nama komponen agar satuannya terisi otomatis.";
  }
  if (feedback) feedback.textContent = `Komponen ${componentNumber}: ${guidance}`;
  if (report) invalid.reportValidity();
  if (focus) invalid.focus();
  return false;
}

function setHppComponentReviewValue(form, key, value) {
  form.querySelectorAll(`[data-hpp-component-review-value="${key}"]`).forEach((element) => { element.textContent = value; });
}

async function moveHppDraftLine(productId, ingredientId, direction) {
  const menu = inventoryWorkspace.data?.hpp?.menus?.find((item) => item.productId === productId);
  const ids = menu?.draft?.items?.map((item) => item.ingredientId) ?? [];
  const index = ids.indexOf(ingredientId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
  [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
  await runInventoryCommand("hpp.draft-line.reorder", { productId, ingredientIds: ids }, "Mengubah urutan komponen draft HPP", {
    onSuccess: () => requestAnimationFrame(() => content.querySelector(`[data-hpp-line-edit="${CSS.escape(ingredientId)}"]`)?.focus()),
  });
}

function hppCostSourceLabel(source) {
  return ({ MOVING_WEIGHTED_AVERAGE: "Biaya rata-rata gudang", PURCHASE_OPTION_REFERENCE: "Harga referensi pembelian", MANUAL: "Harga referensi bahan", UNPRICED: "Biaya belum tersedia" })[source] ?? (source ? "Biaya bahan saat ini" : "Biaya belum tersedia");
}

function inventoryOperationKey(prefix) {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function readWarehouseReceiptAttemptKey() {
  try { return sessionStorage.getItem("sagapos:warehouse-receipt-attempt") || null; }
  catch { return null; }
}

function ensureWarehouseReceiptAttemptKey() {
  if (!warehouseReceiptAttemptKey) warehouseReceiptAttemptKey = inventoryOperationKey("owner-receipt");
  try { sessionStorage.setItem("sagapos:warehouse-receipt-attempt", warehouseReceiptAttemptKey); }
  catch { /* The in-memory key still protects retries while this document remains open. */ }
  return warehouseReceiptAttemptKey;
}

function clearWarehouseReceiptAttemptKey() {
  warehouseReceiptAttemptKey = null;
  try { sessionStorage.removeItem("sagapos:warehouse-receipt-attempt"); }
  catch { /* No persistent browser storage is available. */ }
}

async function runInventoryCommand(action, payload, reason, { onSuccess, statusSelector = "#inventory-mutation-status", expectedRevision } = {}) {
  if (inventoryMutationPending || !inventoryWorkspace.data) return;
  inventoryMutationPending = true;
  const status = content.querySelector(statusSelector);
  if (status) status.textContent = "Menyimpan perubahan…";
  try {
    const result = await request("/api/operator/inventory-actions", {
      method: "POST", csrf: true,
      body: { action, expectedRevision: expectedRevision ?? inventoryWorkspace.data.revision, reason: String(reason ?? ""), payload },
    });
    csrfToken = result.csrfToken || csrfToken;
    onSuccess?.();
    inventoryWorkspace = { status: "ready", data: result.workspace, error: null, stale: false };
    render();
    announce(result.workspace.lastOperation?.title || "Perubahan tersimpan");
  } catch (error) {
    if (action === "warehouse.receipt.post" && !error.status && payload.idempotencyKey) {
      try {
        const workspace = await request("/api/operator/inventory-workspace");
        const saved = workspace.warehouse?.recentReceipts?.some((receipt) => receipt.idempotencyKey === payload.idempotencyKey);
        inventoryWorkspace = { status: "ready", data: workspace, error: null, stale: false };
        if (saved) {
          clearWarehouseReceiptAttemptKey();
          warehouseReceiptOpen = false;
          render();
          announce("Penerimaan sudah tersimpan. Respons awal terputus, tetapi stok tidak diterima dua kali.");
          return;
        }
        render();
      } catch (reconcileError) {
        if (reconcileError.status === 401) { showLogin(); return; }
      }
      const uncertain = "Hasil penerimaan belum pasti. Periksa riwayat stok masuk sebelum mencoba ulang. Jangan ubah angka dengan kunci percobaan yang sama.";
      const currentStatus = content.querySelector(statusSelector);
      if (currentStatus) currentStatus.textContent = uncertain;
      announce(uncertain, true);
      return;
    }
    if (error.status === 409 && inventoryWorkspace.data) {
      inventoryWorkspace.data = { ...inventoryWorkspace.data, conflict: { title: "Perubahan belum disimpan", message: error.message } };
      render();
    } else {
      const currentStatus = content.querySelector(statusSelector);
      if (currentStatus) currentStatus.textContent = error.message;
    }
    announce(error.message, true);
  } finally {
    inventoryMutationPending = false;
  }
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  document.querySelector("#actor-badge").textContent = `${snapshot.actor.displayName} · ${snapshot.actor.mode}`;
  document.querySelector("#delivery-scope").textContent = snapshot.context.production ? "SAGAPOS · OWNER" : snapshot.context.scope === "VERCEL_AUTH_OPERATOR_PREVIEW" ? "VERCEL AUTH · OPERATOR PREVIEW" : "LOCAL VERTICAL SLICE 01";
  document.querySelector("#delivery-persistence").textContent = snapshot.context.production
    ? snapshot.context.paymentMode === "OFF" ? "Data tersimpan · pembayaran nonaktif" : snapshot.context.paymentMode === "GATEWAY" ? "Data tersimpan · mode gateway" : "Data tersimpan · mode pembayaran belum terverifikasi"
    : snapshot.context.persistence === "EPHEMERAL_SERVERLESS_PREVIEW" ? "Data simulator sementara · bukan production" : "Data fixture · bukan production";
  document.querySelector("#service-state-label").textContent = snapshot.context.production ? "Runtime production" : snapshot.context.scope === "VERCEL_AUTH_OPERATOR_PREVIEW" ? "Preview ready" : "Local ready";
  document.querySelector("#logout-button").hidden = protectedVercelPreview;
  clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (surface === "dashboard" && !["overview", "orders"].includes(dashboardModule)) return;
    if (orderFilterDraft || document.querySelector("#owner-order-detail-dialog") || document.activeElement?.closest("#owner-order-filter, #owner-report-filter, #owner-financial-panel, #owner-variance-filter")) return;
    refresh().catch((error) => {
      announce("Koneksi terputus. Data terakhir mungkin belum terbaru; mencoba terhubung kembali.", true);
      if (error.status === 401) showLogin();
    });
  }, 2000);
  if (dashboardModule === "readiness") loadBusinessMasterReadiness();
  if (dashboardModule === "inventory" && inventoryWorkspace.status === "idle") loadInventoryWorkspace();
  if (dashboardModule === "workforce") ownerHrDashboard.load();
  if (dashboardModule === "member") loadPhase5MemberLifecycle();
  if (dashboardModule === "readiness" && readinessArea === "closing") loadPhase6FinanceClosing();
  if (dashboardModule === "readiness" && readinessArea === "pilot") loadPhase7ResiliencePilot();
}

function showLogin() {
  ownerPoControls.reset();
  sessionRevision += 1;
  ownerOrderRequest += 1;
  ownerDetailRequest += 1;
  document.querySelector("#owner-order-detail-dialog")?.close();
  orderFilters = { q: "", channel: "ALL", status: "ALL", date: "", page: 1 };
  ownerOrderList = { data: null, loading: false, error: "" };
  orderFilterDraft = null;
  refreshQueued = false;
  closingSimulationOpen = false;
  content.querySelectorAll("#owner-supplier-dialog, #owner-po-dialog").forEach((dialog) => { if (dialog.open) dialog.close(); });
  if (surface === "dashboard") closeDashboardNavigation();
  openVarianceEvidenceIds.clear();
  clearIngredientWizardDraft();
  ingredientWizard = null;
  prepRecipeEditor = null;
  prepRecipeReturnId = null;
  prepProductionDialog = null;
  ingredientPriceImpact = null;
  ingredientPriceImpactReturnId = null;
  warehouseReceiptOpen = false;
  warehouseCountOpen = false;
  warehouseCountDraftRevision = null;
  warehouseCountDraftLines = {};
  warehouseCountDraftReason = "Full stock count gudang utama";
  warehouseCountMovementChecked = false;
  supplierEditor = { open: false, id: null, draft: null, saving: false };
  orderingEditor = { draft: null, expectedVersion: null, saving: false, blocked: false, confirmed: false, status: "", statusDanger: false };
  purchaseOrderEditor = { open: false, draft: null, attemptKey: null, saving: false, status: "" };
  inventoryWorkspace = { status: "idle", data: null, error: null, stale: false };
  staffReceiptQueue = { status: "idle", data: null, error: null };
  staffReceiptFilters = { status: "ALL", query: "" };
  staffReceiptDetail = { status: "idle", id: null, data: null, error: null };
  staffReceiptEvidenceId = null;
  staffReceiptCapabilities = { status: "idle", data: null, error: null };
  ownerHrDashboard.reset();
  businessMasterReadiness = { status: "idle", data: null, error: null };
  phase5MemberState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
  phase5MemberDraft = { scenario: "HAPPY_PATH", eligibleSpendRupiah: 50000, rewardCostPoints: 100, idempotencyKey: "owner-phase5-rehearsal" };
  memberDiagnosticsOpen = false;
  phase6ClosingState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
  phase6ClosingDraft = { scenario: "CLEAN_CLOSE", expectedCashRupiah: 1500000, declaredCashRupiah: 1500000, idempotencyKey: "owner-phase6-rehearsal" };
  phase7ResilienceState = { status: "idle", readiness: null, scenarios: [], result: null, error: null };
  phase7ResilienceDraft = { scenario: "RUSH_HOUR", requestedOrders: 200, concurrentUsers: 24, idempotencyKey: "owner-phase7-rehearsal" };
  snapshot = null;
  csrfToken = "";
  appView.hidden = true;
  loginView.hidden = false;
  clearInterval(pollTimer);
  requestAnimationFrame(() => passwordInput.focus());
}

function render({ captureOrderingDraft = true } = {}) {
  const previousOrderingForm = content.querySelector("#catalog-ordering-settings");
  const orderingFocus = previousOrderingForm?.contains(document.activeElement) ? document.activeElement.name : null;
  if (captureOrderingDraft && previousOrderingForm && orderingEditor.draft && !orderingEditor.saving) collectOrderingDraft(previousOrderingForm);
  const previousPoForm = purchaseOrderEditor.open ? content.querySelector("#owner-po-form") : null;
  if (previousPoForm && !purchaseOrderEditor.saving) purchaseOrderEditor.draft = collectOwnerPurchaseOrderDraft(previousPoForm);
  const previousSupplierForm = supplierEditor.open ? content.querySelector("#owner-supplier-form") : null;
  if (previousSupplierForm && !supplierEditor.saving && !previousSupplierForm.querySelector("[name='name']").disabled) supplierEditor.draft = Object.fromEntries(new FormData(previousSupplierForm));
  const previousReceiptForm = warehouseReceiptOpen ? content.querySelector("#warehouse-receipt-form") : null;
  const receiptDraft = previousReceiptForm ? Object.fromEntries(new FormData(previousReceiptForm)) : null;
  const receiptExtraOpen = previousReceiptForm?.querySelector("#warehouse-receipt-extra")?.open ?? false;
  const receiptFocusName = previousReceiptForm?.contains(document.activeElement) ? document.activeElement.name : null;
  ownerReportIntegration?.destroy();
  ownerReportIntegration = null;
  content.innerHTML = surface === "dashboard" ? dashboardApplicationView() : kdsView();
  ownerPoControls.mount(content.querySelector("#owner-po-controls"));
  const orderingForm = content.querySelector("#catalog-ordering-settings");
  if (orderingForm) {
    if (orderingEditor.draft) {
      for (const [name, value] of Object.entries(orderingEditor.draft)) {
        const control = orderingForm.elements[name];
        if (control.type === "checkbox") control.checked = value;
        else control.value = value;
      }
    }
    const status = orderingForm.querySelector("[role='status']");
    status.textContent = orderingEditor.status;
    status.classList.toggle("form-status", orderingEditor.statusDanger);
    status.classList.toggle("owner-card-note", !orderingEditor.statusDanger);
    orderingForm.setAttribute("aria-busy", String(orderingEditor.saving));
    if (orderingEditor.saving) orderingForm.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
    else {
      orderingForm.querySelector("button[type='submit']").disabled = orderingEditor.blocked;
      orderingForm.querySelector("[data-ordering-discard]").disabled = orderingEditor.blocked || !orderingEditor.draft;
      if (orderingFocus) orderingForm.elements[orderingFocus]?.focus();
    }
  }
  if (purchaseOrderEditor.open) {
    content.querySelector("#owner-po-dialog")?.showModal();
    updateOwnerPurchaseOrderDraft(content.querySelector("#owner-po-form"));
  }
  if (supplierEditor.open) {
    content.querySelector("#owner-supplier-dialog")?.showModal();
    const form = content.querySelector("#owner-supplier-form");
    const status = form.querySelector("[role='status']");
    status.textContent = supplierEditor.status ?? "";
    status.classList.toggle("form-status", supplierEditor.statusDanger !== false);
    status.classList.toggle("owner-card-note", supplierEditor.statusDanger === false);
    if (supplierEditor.saving) form.querySelectorAll("input, select, button").forEach((control) => { control.disabled = true; });
  }
  content.querySelector("#phase7-resilience-simulator [name='idempotencyKey']")?.setAttribute("aria-label", "Idempotency pilot key");
  if (surface === "dashboard") {
    syncDashboardChrome();
    if (dashboardModule === "catalog") {
      const host = content.querySelector("#dashboard-menu-workspace");
      mountDashboardMenuWorkspace({
        host,
        area: getCatalogArea(),
        navigate: (area) => {
          const nextHash = `#catalog/${area}`;
          if (location.hash !== nextHash) location.hash = nextHash;
        },
      }).catch((error) => announce(error.message, true));
    }
    syncInventoryCountOptions(content.querySelector("#owner-variance-filter"));
    applyWarehouseStockSearch();
    const receiptDialog = warehouseReceiptOpen ? content.querySelector("#warehouse-receipt-dialog") : null;
    if (receiptDialog) {
      const form = receiptDialog.querySelector("#warehouse-receipt-form");
      if (receiptDraft) {
        const select = form.querySelector("#warehouse-purchase-option");
        if (select && [...select.options].some((option) => option.value === receiptDraft.purchaseOptionSelection)) {
          select.value = receiptDraft.purchaseOptionSelection;
          syncWarehouseReceiptPurchaseOption(select);
        }
        for (const name of ["ingredientId", "packageLabel", "purchaseUom", "purchaseQuantity", "totalCostRupiah", "supplierName", "lotCode", "expiryDate", "reason"]) {
          if (receiptDraft[name] != null && form.elements[name]) form.elements[name].value = receiptDraft[name];
        }
        const extra = form.querySelector("#warehouse-receipt-extra");
        if (extra) extra.open = extra.open || receiptExtraOpen;
        syncWarehouseReceiptLotFields(form);
        syncWarehouseReceiptPreview(form);
      }
      receiptDialog.showModal();
      if (receiptFocusName) form.elements[receiptFocusName]?.focus();
    }
    const staffReceiptDialog = staffReceiptDetail.id ? content.querySelector("#staff-receipt-detail-dialog") : null;
    if (staffReceiptDialog) staffReceiptDialog.showModal();
    const staffEvidenceDialog = staffReceiptEvidenceId ? content.querySelector("#staff-receipt-evidence-dialog") : null;
    if (staffEvidenceDialog) staffEvidenceDialog.showModal();
    const hppDialog = hppEditorProductId ? content.querySelector("#hpp-recipe-dialog") : null;
    if (hppDialog) {
      hppDialog.showModal();
      syncHppGuidedEstimate(hppDialog.querySelector("#hpp-draft-line-form"));
    }
    const ingredientDialog = ingredientWizard ? content.querySelector("#ingredient-editor-dialog") : null;
    if (ingredientDialog) {
      ingredientDialog.showModal();
      syncIngredientWizardSummary(ingredientDialog.querySelector("#ingredient-wizard-form"));
    }
    const prepRecipeDialog = prepRecipeEditor ? content.querySelector("#prep-recipe-dialog") : null;
    if (prepRecipeDialog) {
      prepRecipeDialog.showModal();
      syncPrepRecipeReview(prepRecipeDialog.querySelector("#prep-recipe-form"));
    }
    const prepProductionModal = prepProductionDialog ? content.querySelector("#prep-production-dialog") : null;
    if (prepProductionModal) {
      prepProductionModal.showModal();
      syncPrepProductionReview(prepProductionModal.querySelector("#prep-production-form"));
    }
    const ingredientPriceDialog = ingredientPriceImpact ? content.querySelector("#ingredient-price-impact-dialog") : null;
    if (ingredientPriceDialog) {
      ingredientPriceDialog.showModal();
      syncIngredientPriceSimulation(ingredientPriceDialog.querySelector("#ingredient-price-reference-form"));
    }
    if (dashboardModule === "reports") {
      ownerReportIntegration = mountOwnerReportIntegration(content.querySelector("#esb-owner-report-integration"), {
        outletLabel: snapshot.context.outletName || "Kopi Saga Salak · outlet sesi Owner",
        initialFilters: { businessDate: snapshot.dashboard.businessDate },
        loadReport: loadEsbOwnerReport,
      });
    }
    ownerHrDashboard.mount(dashboardModule === "workforce" ? content.querySelector("#owner-hr-dashboard") : null);
  }
}

function kdsView() {
  const queue = snapshot.queue;
  const prototypeCount = queue.filter((item) => item.testMode === true).length;
  const counts = Object.fromEntries(["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "READY"].map((status) => [status, queue.filter((item) => item.status === status).length]));
  const modeQueue = kdsModeFilter === "DEMO" ? queue.filter((item) => item.testMode === true) : kdsModeFilter === "LIVE" ? queue.filter((item) => item.testMode !== true) : queue;
  const visibleQueue = kdsFilter === "ALL" ? modeQueue : modeQueue.filter((item) => item.status === kdsFilter);
  const oldest = queue.length ? ticketAge(queue[0]).minutes : 0;
  return `
    <section class="operator-intro kds-command"><div><p class="eyebrow">Bar Control · Live Queue</p><h2>${queue.length ? `${queue.length} pesanan perlu tindakan` : "Bar siap menerima pesanan"}</h2><p>Tiket tertua selalu di depan. Harga dan data member tidak ditampilkan.</p></div><div class="hardware-state"><span>Digital queue</span><strong>AUTHORITY</strong><small>Printer belum tersedia</small></div></section>
    ${prototypeCount ? `<div class="prototype-queue-notice" role="status"><strong>${prototypeCount} tiket Mode Uji</strong><span>Tiket UJI terisolasi dari penjualan dan settlement. Saat Mulai Buat, stok/HPP diperiksa sebagai simulasi tanpa mengurangi stok produksi.</span></div>` : ""}
    <section class="kds-overview" aria-label="Ringkasan antrean">
      ${queueMetric("Baru", counts.NEW, "Masuk antrean", "new")}
      ${queueMetric("Diterima", counts.ACKNOWLEDGED, "Menunggu dibuat", "acknowledged")}
      ${queueMetric("Diproses", counts.IN_PROGRESS, "Sedang dibuat", "in_progress")}
      ${queueMetric("Siap", counts.READY, "Menunggu diambil", "ready")}
      ${queueMetric("Terlama", queue.length ? `${oldest} mnt` : "—", queue.length ? urgencyCopy(oldest) : "Belum ada tiket", urgencyLevel(oldest))}
    </section>
    <nav class="kds-filters" aria-label="Filter status pesanan">
      <button type="button" data-kds-mode="ALL" aria-pressed="${kdsModeFilter === "ALL"}"><span>Gabungan</span><strong>${queue.length}</strong></button>
      <button type="button" data-kds-mode="LIVE" aria-pressed="${kdsModeFilter === "LIVE"}"><span>Operasional</span><strong>${queue.length - prototypeCount}</strong></button>
      <button type="button" data-kds-mode="DEMO" aria-pressed="${kdsModeFilter === "DEMO"}"><span>Simulasi</span><strong>${prototypeCount}</strong></button>
      ${kdsFilterButton("ALL", "Semua", queue.length)}
      ${kdsFilterButton("NEW", "Baru", counts.NEW)}
      ${kdsFilterButton("ACKNOWLEDGED", "Diterima", counts.ACKNOWLEDGED)}
      ${kdsFilterButton("IN_PROGRESS", "Diproses", counts.IN_PROGRESS)}
      ${kdsFilterButton("READY", "Siap", counts.READY)}
    </nav>
    <section class="kds-grid" aria-label="Antrean pesanan">
      ${visibleQueue.length ? visibleQueue.map((item, index) => kdsCard(item, index)).join("") : kdsEmpty(queue.length)}
    </section>`;
}

function kdsCard(item, index) {
  const demoSourceLabel = item.demoSource === "KIOSK_DEMO" ? "KIOSK DEMO" : item.demoSource === "TABLE_QR_DEMO" ? "QR MEJA DEMO" : "MODE UJI";
  const stations = [...new Set(item.items.map((product) => String(product.station || "bar").toLowerCase()))];
  const stationActions = item.status === "IN_PROGRESS" && stations.length > 1 ? `<div class="kds-station-actions" aria-label="Penyelesaian station">${stations.map((station) => {
    const ready = item.stationProgress?.[station] === "READY";
    return `<button type="button" class="button kds-primary-action" data-order="${escapeHtml(item.orderId)}" data-fulfillment="READY" data-station="${escapeHtml(station)}" ${ready ? "disabled" : ""}>${escapeHtml(station.toUpperCase())} · ${ready ? "Sudah siap" : "Tandai siap"}</button>`;
  }).join("")}</div>` : "";
  const next = ({ NEW: ["ACKNOWLEDGED", "Terima Pesanan"], ACKNOWLEDGED: ["PREPARING", "Mulai Buat"], IN_PROGRESS: ["READY", "Tandai Siap"], READY: ["SERVED", "Sudah Diantar"] })[item.status];
  const exception = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS"].includes(item.status)
    ? ["CANCELLED", "Batal", "Pembatalan operasional dari KDS"]
    : item.status === "READY" ? ["REMAKE", "Ulang", "Remake operasional dari KDS"] : null;
  const statusLabel = ({ NEW: "Baru", ACKNOWLEDGED: "Diterima", IN_PROGRESS: "Diproses", READY: "Siap" })[item.status] || item.operationalStatus || item.status;
  const age = ticketAge(item);
  const phase3 = item.testMode === true ? phase3SimulationView(item) : "";
  return `<article class="kds-card status-${escapeHtml(item.status.toLowerCase())} urgency-${age.level} ${item.testMode === true ? "is-test" : ""}" data-order-id="${escapeHtml(item.orderId)}">
    <header><div class="kds-ticket-identity"><span class="ticket-rank">${String(index + 1).padStart(2, "0")}</span><div><span class="status-label">${item.testMode === true ? `${demoSourceLabel} · ` : ""}${escapeHtml(statusLabel)}</span><h2>${escapeHtml(item.orderNumber)}</h2></div></div><div class="ticket-age"><strong>${age.minutes} mnt</strong><time datetime="${escapeHtml(item.createdAt)}">Masuk ${formatTime(item.createdAt)}</time></div></header>
    <ul>${item.items.map(kdsItem).join("")}</ul>
    ${phase3}
    ${stationActions}
    <div class="kds-footer"><span>${escapeHtml(item.demoSource === "KIOSK_DEMO" ? "Kiosk Demo · Bawa pulang" : item.tableLabel ? `${item.tableLabel} · Makan di sini` : (({ DINE_IN: "Makan di sini", TAKEAWAY: "Bawa pulang" })[item.orderType] || item.channel))}</span><div class="kds-card-actions">${exception ? `<button class="button button-ghost" type="button" data-order="${escapeHtml(item.orderId)}" data-fulfillment="${exception[0]}" data-reason="${escapeHtml(exception[2])}">${exception[1]}</button>` : ""}${next && !stationActions ? `<button class="button kds-primary-action" type="button" data-order="${escapeHtml(item.orderId)}" data-fulfillment="${next[0]}">${next[1]} <span aria-hidden="true">→</span></button>` : ""}</div></div>
  </article>`;
}

function phase3SimulationView(item) {
  const simulation = item.phase3Simulation;
  if (!simulation) return '<div class="kds-stock-simulation is-pending"><strong>Simulasi stok belum dijalankan</strong><span>Klik Mulai Buat untuk memeriksa resep, saldo bahan, dan HPP tanpa mengubah stok produksi.</span></div>';
  const labels = {
    READY: ["Simulasi stok siap", `${simulation.ingredientCount} bahan cukup · HPP ${rupiah(simulation.totalHppRupiah ?? 0)}`],
    SHORTAGE: ["Stok simulasi belum cukup", `${simulation.shortageCount + simulation.missingBalanceCount} bahan perlu ditindak di Gudang`],
    INCOMPLETE_RECIPE: ["Resep/HPP belum lengkap", `${simulation.incompleteItemCount} item perlu dilengkapi di Stok & HPP`],
  };
  const [title, detail] = labels[simulation.state] ?? ["Simulasi perlu diperiksa", "Buka Stok & HPP untuk meninjau data bahan."];
  return `<div class="kds-stock-simulation is-${escapeHtml(String(simulation.state || "unknown").toLowerCase())}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)} · stok produksi tidak berubah</span></div>`;
}

function kdsItem(product) {
  const name = product.name || product.productName || "Menu";
  const modifiers = (product.selections || product.modifiers || []).map((item) => item.optionLabel || item.label || item.optionId).filter(Boolean);
  return `<li><strong>${Number(product.qty || 0)}×</strong><div><span class="kds-item-name">${escapeHtml(name)}</span>${modifiers.length ? `<small>${escapeHtml(modifiers.join(" · "))}</small>` : ""}${product.note ? `<em>Catatan: ${escapeHtml(product.note)}</em>` : ""}</div></li>`;
}

function kdsFilterButton(value, label, count) {
  const active = kdsFilter === value;
  return `<button type="button" data-kds-filter="${value}" aria-pressed="${active}"><span>${label}</span><strong>${count}</strong></button>`;
}

function queueMetric(label, value, note, tone) {
  return `<article class="kds-metric tone-${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
}

function ticketAge(item) {
  const serverNow = new Date(snapshot.serverTime || Date.now()).getTime();
  const createdAt = new Date(item.createdAt).getTime();
  const minutes = Number.isFinite(serverNow) && Number.isFinite(createdAt) ? Math.max(0, Math.floor((serverNow - createdAt) / 60_000)) : 0;
  return { minutes, level: urgencyLevel(minutes) };
}

function urgencyLevel(minutes) {
  if (minutes >= 10) return "urgent";
  if (minutes >= 5) return "attention";
  return "steady";
}

function urgencyCopy(minutes) {
  if (minutes >= 10) return "Prioritaskan sekarang";
  if (minutes >= 5) return "Perlu perhatian";
  return "Dalam ritme";
}

function kdsEmpty(hasQueue) {
  return hasQueue
    ? '<div class="operator-empty"><span>◎</span><h2>Tidak ada tiket di filter ini</h2><p>Pilih status lain untuk melihat antrean aktif.</p></div>'
    : '<div class="operator-empty"><span>✓</span><h2>Antrean kosong</h2><p>Pesanan yang sudah dibayar akan muncul otomatis.</p></div>';
}

function getDashboardModule() {
  const requested = location.hash.replace(/^#/, "").split("/")[0];
  return dashboardModuleIds.has(requested) ? requested : "overview";
}

function getReadinessArea() {
  const [module, requestedArea] = location.hash.replace(/^#/, "").split("/");
  return module === "readiness" && ["pilot", "closing"].includes(requestedArea) ? requestedArea : "status";
}

function getInventoryArea() {
  const [module, requestedArea] = location.hash.replace(/^#/, "").split("/");
  if (module !== "inventory") return "database";
  return inventoryAreaIds.has(requestedArea) ? requestedArea : "warehouse";
}

function getCatalogArea() {
  const [module, requestedArea] = location.hash.replace(/^#/, "").split("/");
  if (module !== "catalog") return "products";
  return catalogAreaIds.has(requestedArea) ? requestedArea : "products";
}

function dashboardNavigationLink(item) {
  const badge = ["orders", "finance", "readiness"].includes(item.id) ? `<span class="dashboard-nav-badge" data-nav-badge="${item.id}" aria-hidden="true" hidden></span>` : "";
  return `<a href="#${item.id}" data-dashboard-module="${item.id}">${featherIconMarkup(item.icon)}<span>${escapeHtml(item.label)}</span>${badge}</a>`;
}

function dashboardNavigation() {
  const home = dashboardModules.find((item) => item.id === "overview");
  return `<div class="dashboard-nav-heading"><div class="dashboard-brand"><span aria-hidden="true">KS</span><div><strong>Saga POS</strong><small>Kopi Saga Salak</small></div></div><button class="dashboard-nav-close" type="button" aria-label="Tutup menu navigasi"><span aria-hidden="true">×</span></button></div>
    <nav class="dashboard-navigation" aria-label="Navigasi Owner Dashboard">
      <div class="dashboard-nav-home">${dashboardNavigationLink(home)}</div>
      ${dashboardNavigationSections.map((section) => `<details class="dashboard-nav-section" data-dashboard-section="${section.id}" ${dashboardSections[section.id] === false ? "" : "open"}><summary>${featherIconMarkup(section.icon)}<span>${escapeHtml(section.label)}</span>${featherIconMarkup("chevron-down")}</summary><div>${dashboardModules.filter((item) => item.section === section.id).map(dashboardNavigationLink).join("")}</div></details>`).join("")}
    </nav>
    <div class="dashboard-app-links"><span>Buka aplikasi</span><a href="/cashier">${featherIconMarkup("credit-card")}<span>Kasir</span></a><a href="/kds">${featherIconMarkup("monitor")}<span>KDS</span></a><a href="/login/staff">${featherIconMarkup("smartphone")}<span>Portal staf</span></a></div>`;
}

function dashboardMobileNavigationMarkup() {
  const entries = [
    ["overview", "Beranda", "home"], ["orders", "Operasional", "clipboard"], ["catalog", "Menu", "coffee"], ["workforce", "Tim", "users"],
  ];
  return `${entries.map(([id, label, icon]) => `<a href="#${id}" data-dashboard-mobile-module="${id}">${featherIconMarkup(icon)}<span>${label}</span></a>`).join("")}<button type="button" data-dashboard-mobile-more aria-label="Buka menu lainnya">${featherIconMarkup("menu")}<span>Lainnya</span></button>`;
}

function dashboardBreadcrumb(active) {
  if (active.id === "overview") return '<nav class="dashboard-breadcrumb" aria-label="Breadcrumb"><span aria-current="page">Beranda</span></nav>';
  const section = dashboardNavigationSections.find((item) => item.id === active.section);
  const currentLabel = active.id === "readiness" && readinessArea === "closing" ? "Uji closing" : active.id === "readiness" && readinessArea === "pilot" ? "Simulasi & recovery" : active.label;
  return `<nav class="dashboard-breadcrumb" aria-label="Breadcrumb"><a href="#overview">Beranda</a><span aria-hidden="true">/</span><span>${escapeHtml(section?.label ?? "Dashboard")}</span><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(currentLabel)}</span></nav>`;
}

function syncDashboardNavigationBadges() {
  if (!snapshot) return;
  const queueCount = (snapshot.queue ?? []).filter((item) => item.testMode !== true && ["NEW", "IN_PROGRESS", "READY"].includes(item.status)).length;
  const financeIssues = Number(snapshot.dashboard?.financialSummary?.issueCount ?? 0);
  const readinessIssues = Number(businessMasterReadiness.data?.blockingCount ?? 0);
  for (const [id, count] of [["orders", queueCount], ["finance", financeIssues], ["readiness", readinessIssues]]) {
    const badge = dashboardSidebar.querySelector(`[data-nav-badge="${id}"]`);
    if (!badge) continue;
    badge.hidden = count <= 0;
    badge.textContent = "";
    badge.dataset.count = count > 99 ? "99+" : String(count);
    const link = badge.closest("a");
    if (link) link.title = count > 0 ? `${count} perlu ditindak` : "";
  }
}

function syncDashboardChrome() {
  const active = dashboardModules.find((item) => item.id === dashboardModule) ?? dashboardModules[0];
  document.querySelector("#surface-title").textContent = active.id === "readiness" && readinessArea === "closing" ? "Uji closing" : active.id === "readiness" && readinessArea === "pilot" ? "Simulasi & recovery" : active.label;
  document.querySelector("#surface-eyebrow").textContent = `Kopi Saga Salak · ${snapshot.dashboard.businessDate} WIB`;
  document.title = `Saga POS · ${active.label}`;
  dashboardSidebar.querySelectorAll("[data-dashboard-module]").forEach((link) => {
    if (link.dataset.dashboardModule === active.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const activeSection = dashboardSidebar.querySelector(`[data-dashboard-section="${active.section}"]`);
  if (activeSection && dashboardSections[active.section] !== false) activeSection.open = true;
  dashboardMobileNavigation.querySelectorAll("[data-dashboard-mobile-module]").forEach((link) => {
    if (link.dataset.dashboardMobileModule === active.id || (link.dataset.dashboardMobileModule === "orders" && ["sales", "orders"].includes(active.id))) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const more = dashboardMobileNavigation.querySelector("[data-dashboard-mobile-more]");
  more.classList.toggle("is-active", !["overview", "sales", "orders", "catalog", "workforce"].includes(active.id));
  syncDashboardNavigationBadges();
}

function toggleDashboardNavigation() {
  if (!dashboardMobile.matches || document.body.classList.contains("dashboard-nav-open")) return closeDashboardNavigation();
  dashboardSidebar.inert = false;
  dashboardSidebar.setAttribute("role", "dialog");
  dashboardSidebar.setAttribute("aria-modal", "true");
  document.body.classList.add("dashboard-nav-open");
  dashboardBackdrop.hidden = false;
  document.querySelector(".operator-app-main").inert = true;
  dashboardMenuButton.setAttribute("aria-expanded", "true");
  dashboardMenuButton.querySelector(".sr-only").textContent = "Tutup navigasi dashboard";
  dashboardSidebar.querySelector("a[aria-current='page']")?.focus();
}

function closeDashboardNavigation() {
  const hadFocus = dashboardSidebar.contains(document.activeElement);
  document.body.classList.remove("dashboard-nav-open");
  dashboardBackdrop.hidden = true;
  document.querySelector(".operator-app-main").inert = false;
  dashboardSidebar.removeAttribute("role");
  dashboardSidebar.removeAttribute("aria-modal");
  dashboardSidebar.inert = dashboardMobile.matches;
  dashboardMenuButton.setAttribute("aria-expanded", "false");
  dashboardMenuButton.querySelector(".sr-only").textContent = "Buka navigasi dashboard";
  if (hadFocus && dashboardMobile.matches) dashboardMenuButton.focus();
}

function dashboardApplicationView() {
  const data = snapshot.dashboard;
  const active = dashboardModules.find((item) => item.id === dashboardModule) ?? dashboardModules[0];
  const pages = {
    overview: ownerOverviewPage,
    readiness: ownerBusinessReadinessPage,
    sales: ownerSalesPage,
    orders: ownerOrdersPage,
    catalog: ownerCatalogPage,
    inventory: ownerInventoryPage,
    purchasing: ownerPurchasingPage,
    finance: ownerFinancePage,
    workforce: ownerWorkforcePage,
    member: ownerMemberPage,
    integrations: ownerIntegrationsPage,
    reports: ownerReportsPage,
    settings: ownerSettingsPage,
  };
  return `<section class="dashboard-module" data-active-module="${dashboardModule}">
    <div class="dashboard-module-context"><div class="dashboard-module-copy">${dashboardBreadcrumb(active)}<p>${escapeHtml(dashboardPageDescription(dashboardModule))}</p></div><div class="dashboard-module-meta"><span>Data server</span><strong>${formatTime(snapshot.serverTime)} WIB</strong><small>${data.source === "daily_closing_snapshot" ? "Catatan penutupan harian" : data.source === "live_transactions" ? "Transaksi server" : "Sumber server"}</small></div></div>
    ${pages[dashboardModule](data)}
  </section>`;
}

function dashboardPageDescription(module) {
  return ({
    overview: "Pantau kondisi outlet dan hal yang perlu ditindak sekarang.", readiness: readinessArea === "pilot" ? "Uji satu shift, recovery, dan kesiapan pilot tanpa mencampurnya dengan laporan keuangan." : "Lengkapi master data bisnis dari satu daftar yang membaca kondisi server.", sales: "Analisis penjualan, metode pembayaran, dan jam ramai.", orders: "Pantau antrean live atau cari riwayat pesanan dari server.",
    catalog: "Akses pengelolaan menu, ketersediaan, harga, dan kesiapan promo.", inventory: "Periksa pemakaian bahan, HPP, hasil penghitungan fisik, dan selisih stok.", purchasing: "Telusuri penerimaan bahan dan kesiapan proses pembelian.",
    finance: "Cocokkan penjualan, tagihan, pembayaran, dan cakupan biaya.", workforce: "Akses shift, jadwal, absensi, dan kesiapan payroll.", member: "Pantau kesiapan integrasi member, reward, dan promosi pelanggan.",
    integrations: "Periksa koneksi layanan dan perangkat operasional.", reports: "Unduh laporan owner yang tersedia dari sumber server.", settings: "Buka kontrol menu, jam layanan, perangkat, dan kebijakan outlet.",
  })[module] ?? "Owner workspace";
}

function readinessNavigation() {
  return `<nav class="dashboard-subnavigation" aria-label="Kesiapan dan simulasi"><a href="#readiness" ${readinessArea === "status" ? 'aria-current="page"' : ""}>Kesiapan bisnis</a><a href="#readiness/pilot" ${readinessArea === "pilot" ? 'aria-current="page"' : ""}>Simulasi & recovery</a><a href="#readiness/closing" ${readinessArea === "closing" ? 'aria-current="page"' : ""}>Uji closing</a></nav>`;
}

function ownerBusinessReadinessPage() {
  if (readinessArea === "closing") return `${readinessNavigation()}<article class="dashboard-card"><h2>Uji closing</h2><p>Simulasi terpisah dari transaksi operasional dan tidak menutup shift kasir.</p><a href="#finance/cash">Kembali ke kas & closing</a></article><details id="owner-closing-simulation" class="dashboard-card owner-closing-simulation" ${closingSimulationOpen ? 'open' : ''}><summary>Simulasi closing — bukan transaksi operasional</summary>${ownerPhase6FinanceClosingView()}</details>`;
  if (readinessArea === "pilot") return `${readinessNavigation()}${ownerPhase7ResilienceView()}`;
  if (["idle", "loading"].includes(businessMasterReadiness.status)) {
    return `${readinessNavigation()}<article class="dashboard-card business-readiness-loading" role="status"><span class="status-badge">Memeriksa</span><h2>Membaca master data bisnis…</h2><p>Menu, bahan, tim, member, dan aturan outlet sedang diperiksa dari server.</p></article>`;
  }
  if (businessMasterReadiness.status === "error" && !businessMasterReadiness.data) {
    return `${readinessNavigation()}<article class="dashboard-card business-readiness-error" role="alert"><span class="status-badge is-warning">Belum tersedia</span><h2>Pemeriksaan belum dapat dimuat</h2><p>${escapeHtml(businessMasterReadiness.error?.message ?? "Coba muat ulang halaman.")}</p><button class="button button-primary" type="button" data-business-readiness-retry>Coba lagi</button></article>`;
  }
  const data = businessMasterReadiness.data;
  const gateReady = data.activationSafe === true;
  const domains = (data.domains ?? []).map((domain) => {
    const checks = (domain.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-incomplete"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
    return `<article class="dashboard-card business-readiness-domain" data-readiness-domain="${escapeHtml(domain.id)}"><div class="business-readiness-domain-head"><div><h2>${escapeHtml(domain.label)}</h2><p>${domain.readyChecks}/${domain.totalChecks} pemeriksaan selesai</p></div><strong>${domain.score}%</strong></div><div class="business-readiness-progress" role="progressbar" aria-label="Kesiapan ${escapeHtml(domain.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${domain.score}"><span style="width:${domain.score}%"></span></div><ul>${checks}</ul><a class="button button-ghost" href="${escapeHtml(domain.href)}">Buka pengaturan</a></article>`;
  }).join("");
  return `${readinessNavigation()}<section class="business-readiness-hero ${gateReady ? "is-ready" : "is-blocked"}" aria-labelledby="business-readiness-title"><div><p class="eyebrow">Phase 1 · master data bisnis</p><h2 id="business-readiness-title">${gateReady ? "Master data siap digunakan" : `${data.blockingCount} hal masih perlu dilengkapi`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} lengkap</span></div></section><section class="business-readiness-summary" aria-label="Keputusan aktivasi"><span class="status-badge ${gateReady ? "is-ready" : "is-warning"}">${gateReady ? "Siap diaktifkan" : "Belum siap diaktifkan"}</span><p>${gateReady ? "Semua bukti master data terbaca dari server." : "Fitur tetap dapat diuji, tetapi data yang belum lengkap tidak dianggap sebagai fakta bisnis final."}</p><time datetime="${escapeHtml(data.generatedAt)}">Diperiksa ${dateTime(data.generatedAt)}</time></section><section class="business-readiness-grid">${domains}</section>${phase3ReadinessView(data.phase3)}${phase4ReadinessView(data.phase4)}${phase5ReadinessView(data.phase5)}${phase6ReadinessView(data.phase6)}${phase7ReadinessView(data.phase7)}${phase8AReadinessView(data.phase8a)}${phase8BReadinessView(data.phase8b)}`;
}

function phase8AReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-incomplete"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  const next = (data.actionQueue ?? [])[0];
  return `<section class="phase8a-readiness" aria-labelledby="phase8a-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 8A · data operasional & inventory reporting</p><h2 id="phase8a-readiness-title">${ready ? "Data transaksi dan laporan siap" : `${data.blockingCount} gate Phase 8A tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card">${next ? `<aside class="inventory-state-card is-stale"><span aria-hidden="true">→</span><div><h3>Pekerjaan berikutnya</h3><p>${escapeHtml(next.label)}: ${escapeHtml(next.action)}</p></div><a class="button button-primary" href="${escapeHtml(next.href)}">Kerjakan</a></aside>` : ""}<ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="#inventory/finalize">Finalisasi stok & HPP</a><a class="button button-ghost" href="#catalog/products">Periksa menu published</a><a class="button button-ghost" href="/inventory-reports">Buka laporan inventory</a></div></article></section>`;
}

function phase8BReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-incomplete"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `<section class="phase8b-readiness" aria-labelledby="phase8b-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 8B · SagaDev Gateway</p><h2 id="phase8b-readiness-title">${ready ? "Canary pembayaran siap diotorisasi" : `${data.blockingCount} gate Phase 8B tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="business-readiness-summary"><span class="status-badge ${ready ? "is-ready" : "is-warning"}">${ready ? "Belum dijalankan" : "Pembayaran tetap OFF"}</span><p>Provider pembayaran dan secret tidak pernah ditampilkan ke SagaPOS. Refund tetap manual sampai kontrak berikutnya tersedia.</p></div></article></section>`;
}

function phase3ReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-incomplete"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `<section class="phase3-readiness" aria-labelledby="phase3-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 3 · order → KDS → stok/HPP</p><h2 id="phase3-readiness-title">${ready ? "Rehearsal operasional siap" : `${data.blockingCount} gate Phase 3 tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="/kiosk" target="_blank" rel="noopener">Buat order uji</a><a class="button button-ghost" href="/kds" target="_blank" rel="noopener">Buka KDS</a><a class="button button-ghost" href="#inventory/finalize">Lengkapi stok & HPP</a></div></article></section>`;
}

function phase4ReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-incomplete"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `<section class="phase4-readiness" aria-labelledby="phase4-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 4 · HR, roster, absensi & Staff Portal</p><h2 id="phase4-readiness-title">${ready ? "Siklus tenaga kerja siap" : `${data.blockingCount} gate Phase 4 tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="#workforce">Kelola tim & shift</a><a class="button button-ghost" href="https://staff.example.invalid/login/staff" target="_blank" rel="noopener">Buka Staff Portal</a></div></article></section>`;
}

function phase5ReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-blocked"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `<section class="phase5-readiness" aria-labelledby="phase5-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 5 · Saga Member lifecycle</p><h2 id="phase5-readiness-title">${ready ? "Earn, redeem, dan reversal siap" : `${data.blockingCount} gate Phase 5 tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="#member">Buka simulator member</a><a class="button button-ghost" href="https://member.example.invalid/member" target="_blank" rel="noopener">Buka Saga Member</a></div></article></section>`;
}

function phase6ReadinessView(data) {
  if (!data) return "";
  const ready = data.activationSafe === true;
  const checks = (data.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : "is-blocked"}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
  return `<section class="phase6-readiness" aria-labelledby="phase6-readiness-title"><article class="business-readiness-hero ${ready ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 6 · reporting, finance & closing</p><h2 id="phase6-readiness-title">${ready ? "Closing dan exception siap" : `${data.blockingCount} gate Phase 6 tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="#finance">Buka kontrol closing</a><a class="button button-ghost" href="#reports">Buka laporan Owner</a></div></article></section>`;
}

function phase7ReadinessView(data) {
  if (!data) return "";
  const target = data.targetAchieved === true;
  const checks = (data.checks ?? []).map((item) => `<li><span>${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></span><strong>${item.complete ? "Siap" : "Belum"}</strong></li>`).join("");
  return `<section class="phase7-readiness" aria-labelledby="phase7-readiness-title"><article class="business-readiness-hero ${target ? "is-ready" : "is-blocked"}"><div><p class="eyebrow">Phase 7 · recovery, load, SOP & pilot</p><h2 id="phase7-readiness-title">${target ? "Target teknis Phase 7 tercapai" : `${data.blockingCount} gate Phase 7 tersisa`}</h2><p>${escapeHtml(data.note)}</p></div><div class="business-readiness-score"><strong>${data.score}%</strong><span>${data.readyChecks}/${data.totalChecks} gate</span></div></article><article class="dashboard-card phase3-readiness-card"><ul>${checks}</ul><div class="button-row"><a class="button button-primary" href="#readiness/pilot">Buka simulasi & recovery</a><a class="button button-ghost" href="#reports">Buka laporan Owner</a></div></article></section>`;
}

function ownerPeriodToolbar(data, note) {
  return `<form id="owner-report-filter" class="owner-report-filter dashboard-period-filter"><label for="report-date">Tanggal bisnis (WIB)</label><input id="report-date" name="reportDate" type="date" required value="${escapeHtml(data.businessDate)}"><button class="button" type="submit">Tampilkan laporan</button><p>${escapeHtml(note)}</p></form>`;
}

function ownerOverviewPage(data) {
  const payments = Object.values(data.paymentMethod || {});
  const uncheckedPayments = payments.reduce((sum, item) => sum + Number(item.uncheckedCount || 0), 0);
  const businessQueue = snapshot.queue.filter((item) => item.testMode !== true);
  const prototypeCount = snapshot.queue.length - businessQueue.length;
  const queueCounts = Object.fromEntries(["NEW", "IN_PROGRESS", "READY"].map((status) => [status, businessQueue.filter((item) => item.status === status).length]));
  const oldestMinutes = businessQueue.length ? ticketAge(businessQueue[0]).minutes : 0;
  const attentionItems = buildOwnerAttention({ uncheckedPayments, oldestMinutes, queueCounts, financialIssues: data.financialSummary?.issueCount ?? 0, recipeUsage: data.theoreticalIngredientUsage, inventoryVariance: data.inventoryVariance, pendingCashAssists: data.cashControl?.pendingAssistCount ?? 0 });
  return `<section class="metric-grid owner-metrics" aria-label="Ringkasan outlet hari ini">
      ${metric("Penjualan menu", financialMoney(data.financialSummary?.menuSalesRupiah), "Setelah diskon", "sales")}
      ${metric("Pesanan terbayar", data.totalOrders, "Kiosk dan kasir", "orders")}
      ${metric("Rata-rata order", financialMoney(data.aovRupiah), "Per order", "aov")}
      ${metric("Pembayaran tercatat", financialMoney(data.financialSummary?.collectedRupiah), uncheckedPayments ? `${uncheckedPayments} belum dicek` : "Sesuai catatan POS", uncheckedPayments ? "urgent" : "queue")}
    </section>
    <section class="owner-now-grid dashboard-overview-grid">
      <article class="dashboard-card owner-attention"><div class="section-heading"><div><h2>Perlu ditindak</h2><p class="card-subtitle">Prioritas berbasis fakta server.</p></div><span class="owner-count ${attentionItems.length ? "is-warning" : ""}">${attentionItems.length}</span></div>${attentionItems.length ? `<ul>${attentionItems.map(ownerAttentionItem).join("")}</ul>` : '<div class="owner-clear is-neutral"><span aria-hidden="true">—</span><div><strong>Tidak ada alert pada data yang tersedia</strong><p>Closing dan kelengkapan biaya tetap diperiksa terpisah.</p></div></div>'}<a class="owner-next-action" href="#finance/cash">Periksa kas & closing →</a></article>
      <article class="dashboard-card owner-queue"><div class="section-heading"><div><h2>Operasional live</h2><p class="card-subtitle">Hanya antrean bisnis; order uji dipisahkan.</p></div><a href="/kds">Buka KDS</a></div><div class="owner-queue-stages">${ownerQueueStage("Baru", queueCounts.NEW, "Masuk")}${ownerQueueStage("Diproses", queueCounts.IN_PROGRESS, "Dibuat")}${ownerQueueStage("Siap", queueCounts.READY, "Diambil")}</div>${businessQueue.length ? `<p class="owner-card-note">Tiket tertua ${oldestMinutes} menit.</p>` : '<p class="owner-card-note">Belum ada tiket bisnis aktif.</p>'}${prototypeCount ? `<p class="owner-card-note is-prototype">${prototypeCount} tiket uji terpisah tersedia di KDS.</p>` : ""}</article>
    </section>
    <section class="dashboard-grid dashboard-analysis-grid">
      <article class="dashboard-card span-7">${ownerHourlySalesView(data.hourlySales)}</article>
      <article class="dashboard-card span-5"><div class="section-heading"><div><h2>Menu teratas</h2><p class="card-subtitle">Berdasarkan jumlah item.</p></div><a href="#sales">Lihat analisis</a></div>${ownerTopProductsView(data.topProducts)}</article>
      <article class="dashboard-card span-7"><div class="section-heading"><div><h2>Transaksi terbaru</h2><p class="card-subtitle">Maksimal 8 transaksi terbayar.</p></div><a href="#orders/history">Lihat riwayat</a></div>${ownerOrdersTable(data, true)}</article>
      <article class="dashboard-card span-5"><div class="section-heading"><div><h2>Pembayaran</h2><p class="card-subtitle">Pencairan dana dari penyedia pembayaran tetap perlu dicocokkan.</p></div><a href="#finance">Buka keuangan</a></div>${ownerPaymentBreakdownView(payments)}</article>
    </section>`;
}

function ownerSalesPage(data) {
  const payments = Object.values(data.paymentMethod || {});
  const area = location.hash.split('/')[1] || 'summary';
  const section = area === 'menu' ? `<section class="dashboard-grid" aria-label="Menu dan jam ramai"><article class="dashboard-card span-7">${ownerHourlySalesView(data.hourlySales)}</article><article class="dashboard-card span-5"><div class="section-heading"><div><h2>Menu teratas</h2><p class="card-subtitle">Nilai menu sebelum diskon transaksi.</p></div></div>${ownerTopProductsView(data.topProducts)}</article></section>`
    : area === 'payments' ? `<article class="dashboard-card"><div class="section-heading"><div><h2>Metode pembayaran</h2><p class="card-subtitle">Pembayaran tercatat di POS belum membuktikan dana masuk ke rekening.</p></div><a href="#finance">Cocokkan dana di Keuangan</a></div>${ownerPaymentBreakdownView(payments)}</article>`
      : `${ownerPeriodComparisonView(data.periodComparison)}<details id="owner-sales-trends" class="owner-sales-trends" ${salesTrendsOpen ? 'open' : ''}><summary>Perbandingan minggu & bulan</summary>${ownerTrendComparisonView(data.trendComparison)}</details>`;
  return `${ownerOperationsNavigation()}${ownerPeriodToolbar(data, "Seluruh angka mengikuti tanggal bisnis terpilih; antrean live tidak ikut dihitung.")}
    <nav class="dashboard-subnavigation" aria-label="Analisis penjualan">${[['summary', 'Ringkasan'], ['menu', 'Menu & jam ramai'], ['payments', 'Pembayaran']].map(([id, label]) => `<a href="#sales/${id}" ${(area === id || (id === 'summary' && !['menu', 'payments'].includes(area))) ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<a href="/api/operator/reports/financial.csv?reportDate=${encodeURIComponent(data.businessDate)}" download>Unduh laporan tanggal ini</a></nav>
    <section class="metric-grid owner-metrics" aria-label="Ringkasan penjualan">${metric("Penjualan menu", financialMoney(data.financialSummary?.menuSalesRupiah), "Setelah diskon · tanpa pajak/layanan", "sales")}${metric("Transaksi terbayar", data.totalOrders, "Pada tanggal bisnis terpilih", "orders")}${metric("Rata-rata transaksi", financialMoney(data.aovRupiah), "Per transaksi terbayar", "aov")}${metric("HPP teoretis", data.costStatus === "VERIFIED" ? financialMoney(data.totalHppRupiah) : "Belum lengkap", data.costStatus === "VERIFIED" ? "Cakupan lengkap" : "Cakupan belum lengkap", "queue")}</section>
    ${section}`;
}

function ownerOperationsNavigation() {
  return `<nav class="dashboard-subnavigation owner-operations-navigation" aria-label="Operasional dan penjualan">${[["orders", "Pesanan"], ["sales", "Penjualan"], ["finance", "Kas & shift kasir"]].map(([id, label]) => `<a href="#${id}" ${dashboardModule === id ? 'aria-current="page"' : ""}>${escapeHtml(label)}</a>`).join("")}</nav>`;
}

function ownerPeriodComparisonView(comparison = {}) {
  const status = comparison.status === "COMPARABLE" ? "is-ready" : "is-warning";
  const current = comparison.current ?? {};
  const previous = comparison.previous ?? {};
  const delta = comparison.delta ?? {};
  return `<article class="dashboard-card span-12 owner-period-comparison"><div class="section-heading"><div><h2>Bandingkan dengan hari sebelumnya</h2><p class="card-subtitle">Tanggal bisnis ${escapeHtml(comparison.reportDate ?? "—")} dibanding ${escapeHtml(comparison.previousReportDate ?? "—")}; antrean live tidak ikut dihitung.</p></div><span class="status-badge ${status}">${comparison.status === "COMPARABLE" ? "Bisa dibandingkan" : "Belum ada pembanding"}</span></div>
    <div class="comparison-grid" role="list" aria-label="Perbandingan performa penjualan">
      ${comparisonTile("Penjualan menu", current.menuSalesRupiah, previous.menuSalesRupiah, comparison.status === "COMPARABLE" ? delta.menuSalesRupiah : null, delta.menuSalesPct, "rupiah")}
      ${comparisonTile("Transaksi terbayar", current.orderCount, previous.orderCount, comparison.status === "COMPARABLE" ? delta.orderCount : null, delta.orderPct, "count")}
      ${comparisonTile("Rata-rata transaksi", current.aovRupiah, previous.aovRupiah, comparison.status === "COMPARABLE" ? delta.aovRupiah : null, null, "rupiah")}
      ${comparisonTile("Laba kotor teoretis", current.grossProfitRupiah, previous.grossProfitRupiah, comparison.status === "COMPARABLE" ? delta.grossProfitRupiah : null, null, "rupiah")}
    </div>
    <p class="owner-card-note">${comparison.status === "COMPARABLE" ? "Perubahan ini menunjukkan tren harian. Penutupan kas tetap memerlukan pencocokan pembayaran dan HPP lengkap." : "Perbandingan akan aktif setelah ada transaksi terbayar pada hari bisnis sebelumnya."}</p></article>`;
}

function comparisonTile(label, current, previous, delta, pct, type) {
  const tone = Number(delta) > 0 ? "is-up" : Number(delta) < 0 ? "is-down" : "is-flat";
  return `<div class="comparison-tile ${tone}" role="listitem"><span>${escapeHtml(label)}</span><strong>${formatComparisonValue(current, type)}</strong><small>Sebelumnya ${formatComparisonValue(previous, type)}</small><b>${formatComparisonDelta(delta, pct, type)}</b></div>`;
}

function formatComparisonValue(value, type) {
  if (value == null) return "Belum lengkap";
  return type === "rupiah" ? rupiah(value) : String(value);
}

function formatComparisonDelta(delta, pct, type) {
  if (delta == null) return "Perubahan belum tersedia";
  const sign = delta > 0 ? "+" : "";
  const base = type === "rupiah" ? `${sign}${rupiah(delta)}` : `${sign}${delta}`;
  return pct == null ? base : `${base} · ${sign}${pct}%`;
}

function ownerTrendComparisonView(comparisons = []) {
  const rows = comparisons.map((comparison) => `<tr><th scope="row">${escapeHtml(comparison.label)}</th><td>${escapeHtml(comparison.currentStartDate)} – ${escapeHtml(comparison.currentEndDate)}<small>${comparison.dayCount} hari</small></td><td>${escapeHtml(comparison.previousStartDate)} – ${escapeHtml(comparison.previousEndDate)}<small>${comparison.status === "COMPARABLE" ? "Bisa dibandingkan" : "Belum ada transaksi terbayar"}</small></td><td><strong>${financialMoney(comparison.current?.menuSalesRupiah)}</strong><small>${formatComparisonDelta(comparison.delta?.menuSalesRupiah, comparison.delta?.menuSalesPct, "rupiah")}</small></td><td><strong>${comparison.current?.orderCount ?? 0}</strong><small>${formatComparisonDelta(comparison.delta?.orderCount, comparison.delta?.orderPct, "count")}</small></td><td>${financialMoney(comparison.current?.aovRupiah)}</td><td>${financialMoney(comparison.current?.grossProfitRupiah)}<small>${comparison.current?.costStatus === "VERIFIED" ? "HPP lengkap" : "HPP belum lengkap"}</small></td></tr>`).join("");
  return `<article class="dashboard-card span-12"><div class="section-heading"><div><h2>Tren minggu & bulan berjalan</h2><p class="card-subtitle">Dibandingkan dengan periode sebelumnya yang sama panjang. Pembayaran dan HPP belum tentu final.</p></div><a class="button button-ghost" href="/api/operator/reports/sales-trend-comparison.csv?reportDate=${encodeURIComponent(comparisons[0]?.reportDate ?? "")}" download>Unduh tren CSV</a></div><div class="dashboard-table" role="region" aria-label="Perbandingan tren penjualan minggu dan bulan" tabindex="0"><table><caption>Perbandingan tren penjualan</caption><thead><tr><th scope="col">Cakupan</th><th scope="col">Periode ini</th><th scope="col">Pembanding</th><th scope="col">Penjualan</th><th scope="col">Transaksi</th><th scope="col">Rata-rata transaksi</th><th scope="col">Laba kotor teoretis</th></tr></thead><tbody>${rows}</tbody></table></div><p class="owner-card-note">Penutupan final tetap menunggu pencocokan dana penyedia pembayaran/bank, HPP aktual, dan penguncian periode.</p></article>`;
}

function ownerOrdersPage(data) {
  const list = ownerOrderList.data;
  const live = ownerOrderMode() === 'live';
  const filters = orderFilterDraft ?? orderFilters;
  const counts = list?.counts;
  const count = key => counts ? counts[key] : '—';
  const shiftNote = !list ? 'Memuat status shift kas…' : !list.shift ? 'Belum ada shift kas' : `Shift kas ${list.shift.status === 'open' ? 'terbuka' : list.shift.status === 'closed' ? 'ditutup' : 'menunggu penutupan'} · ${list.shift.businessDate}`;
  const select = (name, label, options) => `<label>${label}<select name="${name}">${options.map(([value, title]) => `<option value="${value}" ${filters[name] === value ? 'selected' : ''}>${title}</option>`).join('')}</select></label>`;
  const rows = (list?.rows ?? []).map(row => ({ ...row, paymentMethod: ownerOrderLabel(row.paymentMethod) }));
  return `${ownerOperationsNavigation()}<section class="owner-command"><div><p class="eyebrow">Operasional outlet · Live</p><h2>Antrean kerja</h2><p>Pembayaran dan dapur ditampilkan terpisah. Pesanan uji tidak masuk ke daftar ini.</p><p class="owner-card-note">${escapeHtml(shiftNote)}</p></div><div class="owner-freshness"><span>Terakhir diperbarui (WIB)</span><strong>${list ? formatTime(list.serverTime) : 'Memuat…'}</strong><div class="owner-order-actions"><a class="button button-ghost" href="/cashier">Buka kasir</a><a class="button button-ghost" href="/kds">Buka KDS</a></div></div></section>
    <section class="metric-grid owner-metrics" aria-label="Antrean live seluruh outlet">${metric('Menunggu pembayaran', count('pending'), 'Selesaikan melalui kasir', 'sales')}${metric('Sedang dibuat', counts ? counts.new + counts.preparing : '—', counts ? `${counts.new} menunggu proses · ${counts.preparing} diproses` : 'Mengambil data server', 'orders')}${metric('Siap diserahkan', count('ready'), 'Serahkan melalui KDS', 'aov')}${metric('Perlu diperiksa', count('attention'), 'Pembayaran gagal / kedaluwarsa, refund, atau tiket belum ada', 'queue')}</section>
    <nav class="dashboard-subnavigation" aria-label="Daftar pesanan"><a href="#orders" ${live ? 'aria-current="page"' : ''}>Antrean live</a><a href="#orders/history" ${!live ? 'aria-current="page"' : ''}>Riwayat pesanan</a></nav>
    <article class="dashboard-card" aria-busy="${ownerOrderList.loading}"><div class="section-heading"><div><h2>${live ? 'Pesanan aktif & perlu diperiksa' : 'Riwayat pesanan'}</h2><p class="card-subtitle">${live ? 'Semua tanggal yang masih aktif. Jumlah kartu di atas selalu seluruh antrean live, bukan hasil filter.' : 'Semua status pada tanggal bisnis terpilih, termasuk yang belum terbayar.'}</p></div><button class="button button-ghost" data-owner-orders-refresh>Perbarui antrean</button></div>
    <form id="owner-order-filter" class="owner-order-filter"><label>Cari nomor / menu<input name="q" type="search" maxlength="80" placeholder="Nomor pesanan atau nama menu" value="${escapeHtml(filters.q)}"></label>${!live ? `<label>Tanggal bisnis (WIB)<input name="date" type="date" required value="${escapeHtml(filters.date || list?.date || data.businessDate)}"></label>` : ''}${select('status', 'Status pesanan', [['ALL', 'Semua status'], ['PENDING', 'Menunggu pembayaran'], ['NEW', 'Baru masuk dapur'], ['ACKNOWLEDGED', 'Diterima dapur'], ['IN_PROGRESS', 'Sedang dibuat'], ['READY', 'Siap diserahkan'], ['COMPLETED', 'Selesai'], ['ATTENTION', 'Perlu diperiksa']])}${select('channel', 'Sumber pesanan', [['ALL', 'Semua sumber'], ['CASHIER', 'Kasir'], ['KIOSK', 'Kiosk'], ['TABLE', 'Meja']])}<button class="button" type="submit">Terapkan filter</button></form>
    <p class="owner-card-note" role="status">${ownerOrderList.error ? `Data belum diperbarui: ${escapeHtml(ownerOrderList.error)}. Coba Perbarui antrean; data terakhir tetap ditampilkan.` : ownerOrderList.loading ? 'Memuat pesanan dari server…' : list ? `${list.total} pesanan cocok · halaman ${list.page} dari ${list.pageCount} · ${live ? 'antrean live' : escapeHtml(list.date)}.` : 'Menyiapkan daftar pesanan…'}</p>
    ${rows.length ? `<div class="dashboard-table" role="region" aria-label="Daftar pesanan server" tabindex="0"><table><caption class="sr-only">${live ? 'Antrean pesanan live' : 'Riwayat pesanan pada tanggal terpilih'}</caption><thead><tr><th scope="col">Pesanan</th><th scope="col">Menu / sumber</th><th scope="col">Pembayaran</th><th scope="col">Dapur</th><th scope="col">Total</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row"><button class="owner-order-number" data-owner-order-detail="${escapeHtml(row.id)}">${escapeHtml(row.orderNumber)}</button><small>${formatTime(row.createdAt)} WIB${live && row.active ? ` · ${ticketAge(row).minutes} menit` : ` · ${escapeHtml(row.businessDate)}`}</small></th><td>${escapeHtml(row.items.map(item => `${item.qty}× ${item.name}`).join(', '))}<small>${escapeHtml(ownerOrderLabel(row.channel))}</small></td><td><span class="status-badge ${row.paymentStatus === 'PAID' ? 'is-ready' : 'is-warning'}">${escapeHtml(ownerOrderLabel(row.paymentStatus))}</span><small>${escapeHtml(row.paymentMethod)}</small></td><td>${escapeHtml(ownerOrderLabel(row.kitchenStatus))}${row.attention ? '<small>Perlu diperiksa</small>' : ''}</td><td><strong>${financialMoney(row.totalRupiah)}</strong></td></tr>`).join('')}</tbody></table></div>` : !ownerOrderList.loading && !ownerOrderList.error ? '<div class="operator-empty compact"><p>Tidak ada pesanan yang cocok. Ganti filter atau buka riwayat tanggal lain.</p></div>' : ''}
    ${list ? `<div class="owner-order-actions"><button class="button button-ghost" data-owner-order-page="${list.page - 1}" ${list.page === 1 || ownerOrderList.loading ? 'disabled' : ''}>Sebelumnya</button><span>Halaman ${list.page} / ${list.pageCount}</span><button class="button button-ghost" data-owner-order-page="${list.page + 1}" ${list.page === list.pageCount || ownerOrderList.loading ? 'disabled' : ''}>Berikutnya</button><a class="button button-ghost" href="/api/operator/orders.csv?${escapeHtml(ownerOrderParams(list))}" download>Unduh hasil filter CSV</a></div>` : ''}</article>`;
}

function ownerOrderMode() { return location.hash.split('/')[1] === 'history' ? 'history' : 'live'; }

function ownerOrderParams(filters = orderFilters) {
  return new URLSearchParams({ mode: ownerOrderMode(), date: filters.date || snapshot.dashboard.businessDate, q: filters.q, channel: filters.channel, status: filters.status, page: String(filters.page) });
}

async function loadOwnerOrders({ renderPage = true } = {}) {
  const revision = ++ownerOrderRequest, session = sessionRevision, key = String(ownerOrderParams());
  ownerOrderList = { ...ownerOrderList, loading: true, error: '' };
  if (renderPage && snapshot && dashboardModule === 'orders') render();
  try {
    const data = await request(`/api/operator/orders?${key}`);
    if (revision !== ownerOrderRequest || session !== sessionRevision || key !== String(ownerOrderParams())) return;
    orderFilters.page = data.page;
    ownerOrderList = { data, loading: false, error: '' };
  } catch (error) {
    if (revision !== ownerOrderRequest || session !== sessionRevision) return;
    ownerOrderList = { ...ownerOrderList, loading: false, error: error.message };
    if (error.status === 401) { showLogin(); return; }
  }
  if (renderPage && snapshot && dashboardModule === 'orders') render();
}

function ownerOrderLabel(value) {
  if (value === 'Cash') return 'Tunai';
  if (value === 'No Payment Required') return 'Tanpa pembayaran';
  if (value === 'ACKNOWLEDGED') return 'Diterima dapur';
  return ({ CASHIER: 'Kasir', KIOSK: 'Kiosk', TABLE: 'Meja', DINE_IN: 'Makan di tempat', TAKEAWAY: 'Bawa pulang', PAID: 'Terbayar', PENDING: 'Menunggu pembayaran', PAYMENT_PENDING: 'Menunggu pembayaran', FAILED: 'Gagal', EXPIRED: 'Kedaluwarsa', REFUNDED: 'Dikembalikan', NONE: 'Belum ada', NEW: 'Baru masuk', IN_PROGRESS: 'Sedang dibuat', READY: 'Siap diserahkan', COMPLETED: 'Selesai', CANCELLED: 'Dibatalkan' })[value] ?? value ?? 'Belum tersedia';
}

async function openOwnerOrderDetail(id, trigger) {
  document.querySelector('#owner-order-detail-dialog')?.close();
  const revision = ++ownerDetailRequest, session = sessionRevision;
  const dialog = document.createElement('dialog');
  dialog.id = 'owner-order-detail-dialog';
  dialog.className = 'owner-order-detail-dialog';
  dialog.setAttribute('aria-labelledby', 'owner-order-detail-title');
  const header = title => `<div class="section-heading"><h2 id="owner-order-detail-title">${escapeHtml(title)}</h2><form method="dialog"><button class="button button-ghost" aria-label="Tutup detail pesanan">Tutup</button></form></div>`;
  dialog.innerHTML = `${header('Detail pesanan')}<p role="status">Memuat detail dari server…</p>`;
  appView.append(dialog);
  dialog.addEventListener('close', () => { ownerDetailRequest++; dialog.remove(); if (trigger.isConnected) trigger.focus(); else content.querySelector('[data-owner-order-detail]')?.focus(); }, { once: true });
  dialog.showModal();
  try {
    const order = await request(`/api/operator/orders/${encodeURIComponent(id)}`);
    if (revision !== ownerDetailRequest || session !== sessionRevision || !dialog.open) return;
    for (const payment of order.payments) payment.method = ownerOrderLabel(payment.method);
    const amounts = [['Subtotal', order.subtotalRupiah], ['Diskon', order.discountRupiah], ['Pajak', order.taxRupiah], ['Layanan', order.serviceRupiah], ['Pembulatan', order.roundingRupiah], ['Total tagihan', order.totalRupiah]];
    dialog.innerHTML = `${header(order.orderNumber)}<p class="owner-card-note">${escapeHtml(order.businessDate)} · ${escapeHtml(ownerOrderLabel(order.channel))} · ${escapeHtml(ownerOrderLabel(order.orderType))}</p><div class="owner-order-detail-status"><p><span>Pesanan</span><strong>${escapeHtml(ownerOrderLabel(order.orderStatus))}</strong></p><p><span>Dapur</span><strong>${escapeHtml(ownerOrderLabel(order.kitchenStatus))}</strong></p></div>
      <h3>Rincian menu</h3><ul class="owner-order-items">${order.items.map(item => `<li><div><strong>${item.qty}× ${escapeHtml(item.name)}</strong><small>${financialMoney(item.unitPriceRupiah)} per item${item.selections.length ? ` · ${escapeHtml(item.selections.map(selection => [selection.group, selection.name].filter(Boolean).join(': ')).join(', '))}` : ''}</small>${item.note ? `<small>Catatan: ${escapeHtml(item.note)}</small>` : ''}</div><strong>${financialMoney(item.lineTotalRupiah)}</strong></li>`).join('')}</ul>
      <dl class="owner-order-amounts">${amounts.map(([label, amount]) => `<div><dt>${label}</dt><dd>${financialMoney(amount)}</dd></div>`).join('')}</dl><h3>Pembayaran</h3>${order.payments.length ? order.payments.map(payment => `<div class="owner-order-payment"><strong>${escapeHtml(payment.method)} · ${escapeHtml(ownerOrderLabel(payment.status))}</strong><p>Nominal ${financialMoney(payment.amountRupiah)}${payment.receivedRupiah !== null ? ` · diterima ${financialMoney(payment.receivedRupiah)}` : ''}${payment.changeRupiah !== null ? ` · kembalian ${financialMoney(payment.changeRupiah)}` : ''}</p></div>`).join('') : '<p>Belum ada pembayaran.</p>'}<p class="owner-card-note">Terbayar di POS tidak membuktikan pencairan dana ke rekening. Refund perlu dicocokkan di Keuangan.</p>
      <h3>Jejak waktu (WIB)</h3><ol class="owner-order-timeline">${order.timeline.map(event => `<li><span>${escapeHtml(event.label)}</span><time datetime="${escapeHtml(event.at)}">${escapeHtml(formatDate(event.at))} · ${formatTime(event.at)}</time></li>`).join('')}</ol><div class="owner-order-actions"><a class="button button-ghost" href="/cashier">Buka kasir</a><a class="button button-ghost" href="/kds">Buka KDS</a><a class="button button-ghost" href="#finance" data-order-detail-navigation>Keuangan</a></div>`;
    dialog.querySelector('.owner-order-actions').before(Object.assign(document.createElement('section'),{innerHTML:renderOwnerRefund(order)}));
    bindOwnerRefund(dialog,order,trigger);
    dialog.querySelector('[data-order-detail-navigation]').addEventListener('click', async event => {
      event.preventDefault();
      dialog.close();
      reportDate = order.businessDate;
      location.hash = 'finance';
      try { await refresh(); } catch (error) { announce(error.message, true); }
    });
    dialog.querySelector('button').focus();
  } catch (error) {
    if (revision !== ownerDetailRequest || session !== sessionRevision || !dialog.open) return;
    if (error.status === 401) { showLogin(); return; }
    dialog.innerHTML = `${header('Detail belum tersedia')}<p role="alert">${escapeHtml(error.message)}. Tutup dan coba lagi dari daftar pesanan.</p>`;
  }
}

function renderOwnerRefund(order) {
  const history=(order.refunds??[]).map(refund=>`<li>${escapeHtml(formatDate(refund.createdAt))} · ${financialMoney(refund.amountRupiah)} · ${escapeHtml(refund.reason??'Catatan lama')} · ${refund.status === 'REFUNDED_LOCAL'?'Tunai dikembalikan':'Menunggu rekonsiliasi'}</li>`).join('');
  return `<h3>Riwayat refund</h3>${history?`<ul>${history}</ul>`:'<p>Belum ada refund.</p>'}${order.cashRefundAvailable?`<details><summary class="button button-ghost">Refund tunai per item</summary><form id="owner-refund-form" class="menu-v2-form"><p>Nominal memakai harga, diskon, pajak, dan layanan transaksi asli. Refund sebagian tidak membatalkan proses dapur atau mengembalikan stok; seluruh item masih tercatat.</p>${order.items.filter(item=>item.refundableQty>0).map(item=>`<label>${escapeHtml(item.name)} · sisa ${item.refundableQty}<input type="number" data-refund-item="${escapeHtml(item.id)}" min="0" max="${item.refundableQty}" step="1" value="0" required></label>`).join('')}<label>Alasan refund<input name="reason" maxlength="160" required></label><button type="button" class="button button-ghost" data-refund-preview>Periksa nominal refund</button><p role="status" aria-live="polite"></p><button type="submit" class="button button-primary" disabled>Konfirmasi & kembalikan tunai</button></form></details>`:'<p class="owner-card-note">Refund tunai membutuhkan pembayaran tunai dan shift kas terbuka. QRIS tetap melalui rekonsiliasi, bukan tombol tunai.</p>'}`;
}

function bindOwnerRefund(dialog,order,trigger) {
  const form=dialog.querySelector('#owner-refund-form');if(!form)return;
  const status=form.querySelector('[role=status]'),submit=form.querySelector('[type=submit]'),preview=form.querySelector('[data-refund-preview]');
  let command=null,busy=false,uncertain=false;
  form.addEventListener('input',()=>{if(!busy&&!uncertain){command=null;submit.disabled=true;status.textContent='Rincian berubah. Periksa nominal kembali.';}});
  preview.addEventListener('click',async()=>{
    if(busy||uncertain||!form.reportValidity())return;
    busy=true;preview.disabled=true;
    try {
      command={orderId:order.id,items:[...form.querySelectorAll('[data-refund-item]')].filter(input=>Number(input.value)>0).map(input=>({orderItemId:input.dataset.refundItem,qty:Number(input.value)})),reason:form.elements.reason.value,idempotencyKey:`refund:${crypto.randomUUID()}`};
      const plan=await request('/api/admin/refund-preview',{method:'POST',csrf:true,body:command});
      status.textContent=`Kembalikan ${financialMoney(plan.amountRupiah)} dari laci kas. ${plan.full?'Ini menyelesaikan refund seluruh sisa pesanan.':'Sisa pesanan tetap aktif.'}`;submit.disabled=false;
    } catch(error){command=null;submit.disabled=true;status.textContent=error.message;}
    finally{busy=false;preview.disabled=false;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!command||busy)return;busy=true;submit.disabled=true;preview.disabled=true;
    try {
      await catalogAction('order.refund',command);uncertain=false;
      dialog.close();await refresh();await openOwnerOrderDetail(order.id,trigger);announce('Refund tunai tercatat; kas dan riwayat diperbarui.');
    } catch(error){
      uncertain=!error.status||error.status>=500;
      status.textContent=uncertain?'Hasil belum terkonfirmasi. Coba ulang permintaan yang sama; jangan membuat refund pengganti.':error.message;
      for(const input of form.querySelectorAll('input'))input.disabled=uncertain;
    } finally{busy=false;if(dialog.open){submit.disabled=!uncertain;preview.disabled=uncertain;}}
  });
}

function ownerCatalogPage() {
  return `<section id="dashboard-menu-workspace" class="dashboard-menu-workspace" aria-live="polite"><div class="operator-empty"><span aria-hidden="true">⌛</span><h2>Memuat Menu & promo</h2><p>Mengambil workspace katalog terbaru dari server.</p></div></section>`;
}

async function catalogAction(action, payload) {
  return request("/api/admin/actions", { method: "POST", csrf: true, body: { action, payload } });
}

async function submitPaymentSettlementReview(form) {
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector("[role=status]");
  button.disabled = true;
  status.textContent = "Menyimpan review…";
  try {
    const values = new FormData(form);
    await catalogAction("payment.settlement.review", {
      paymentId: values.get("paymentId"),
      decision: values.get("decision"),
      expectedStatus: values.get("expectedStatus"),
      providerFeeRupiah: Number(values.get("providerFeeRupiah")),
      netSettlementRupiah: Number(values.get("netSettlementRupiah")),
      evidenceReference: values.get("evidenceReference"),
      reason: values.get("reason"),
    });
    await refresh();
    announce("Review settlement tersimpan. Tidak ada perubahan pada provider atau rekening bank.");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function submitCatalogCategory(form) {
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector("[role=status]");
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    await catalogAction("catalog.category.create", { name: values.name, reason: values.reason, expectedVersion: snapshot.catalogVersion });
    await refresh();
    announce("Kategori menu berhasil dibuat.");
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

function collectOrderingDraft(form) {
  if (!form || orderingEditor.saving || form.elements.opensAt.disabled) return;
  const draft = {
    acceptOrders: form.elements.acceptOrders.checked,
    enforceHours: form.elements.enforceHours.checked,
    opensAt: form.elements.opensAt.value,
    lastOrderAt: form.elements.lastOrderAt.value,
    closesAt: form.elements.closesAt.value,
    reason: form.elements.reason.value,
  };
  const ordering = snapshot.orderingSettings;
  if (!orderingEditor.draft && !draft.reason && draft.acceptOrders === !ordering.paused && draft.enforceHours === ordering.enforceHours && draft.opensAt === ordering.opensAt && draft.lastOrderAt === ordering.lastOrderAt && draft.closesAt === ordering.closesAt) return;
  const changed = JSON.stringify(orderingEditor.draft) !== JSON.stringify(draft);
  orderingEditor.draft = draft;
  orderingEditor.expectedVersion ??= snapshot.catalogVersion;
  if (changed && !orderingEditor.blocked) {
    orderingEditor.status = "";
    orderingEditor.statusDanger = false;
    form.querySelector("[role='status']").textContent = "";
  }
  const discard = form.querySelector("[data-ordering-discard]");
  if (discard) discard.disabled = orderingEditor.blocked;
}

async function refreshOrderingSettings() {
  if (orderingEditor.saving) return;
  collectOrderingDraft(content.querySelector("#catalog-ordering-settings"));
  const editor = orderingEditor;
  editor.saving = true;
  editor.status = "Memuat pengaturan terbaru…";
  editor.statusDanger = false;
  render();
  try {
    await refresh();
    if (orderingEditor !== editor) return;
    if (editor.confirmed) editor.draft = null;
    editor.confirmed = false;
    editor.expectedVersion = editor.draft ? snapshot.catalogVersion : null;
    editor.blocked = false;
    editor.status = "Data terbaru dimuat. Periksa draft dan pengaturan yang berlaku sebelum menyimpan.";
  } catch (error) {
    if (orderingEditor !== editor) return;
    editor.status = error.message;
    editor.statusDanger = true;
  } finally {
    if (orderingEditor === editor) { editor.saving = false; if (snapshot) render(); }
  }
}

async function submitCatalogOrdering(form) {
  if (orderingEditor.saving || orderingEditor.blocked || !form.reportValidity()) return;
  collectOrderingDraft(form);
  const editor = orderingEditor;
  const values = editor.draft;
  editor.saving = true;
  editor.status = "Sedang menyimpan pengaturan…";
  editor.statusDanger = false;
  render();
  try {
    await catalogAction("catalog.ordering.update", {
      paused: !editor.draft.acceptOrders,
      enforceHours: editor.draft.enforceHours,
      opensAt: editor.draft.opensAt,
      lastOrderAt: editor.draft.lastOrderAt,
      closesAt: editor.draft.closesAt,
      reason: editor.draft.reason,
      expectedVersion: editor.expectedVersion,
    });
    if (orderingEditor !== editor) return;
    editor.confirmed = true;
    await refresh();
    if (orderingEditor !== editor) return;
    editor.draft = null;
    editor.expectedVersion = null;
    editor.confirmed = false;
    editor.status = "Pengaturan tersimpan dan data terbaru sudah dimuat.";
    announce(values.acceptOrders ? "Pesanan baru di kasir dan kiosk dapat diterima sesuai jam layanan." : "Pesanan baru di kasir dan kiosk dijeda. Pesanan yang sudah masuk tetap diproses.");
  } catch (error) {
    if (orderingEditor !== editor) return;
    editor.blocked = editor.confirmed || error.status === 409 || !error.status;
    editor.status = editor.confirmed ? "Pengaturan tersimpan, tetapi data terbaru belum dapat dimuat. Klik Perbarui data sebelum menyimpan lagi." : error.status === 409 ? "Pengaturan berubah di sesi lain. Draft Anda tetap ada. Klik Perbarui data, periksa pengaturan yang berlaku, lalu tinjau draft sebelum menyimpan." : !error.status ? "Hasil simpan belum pasti karena koneksi terputus. Klik Perbarui data dan periksa pengaturan yang berlaku sebelum mencoba lagi." : error.message;
    editor.statusDanger = true;
  } finally {
    if (orderingEditor === editor) { editor.saving = false; if (snapshot) render(); }
  }
}

async function submitCatalogProduct(form) {
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector("[role=status]");
  button.disabled = true;
  try {
    const values = new FormData(form);
    const created = await catalogAction("catalog.product.create", {
      name: values.get("name"), priceRupiah: Number(values.get("priceRupiah")), categoryId: values.get("categoryId"),
      station: values.get("station"), customizationProfile: values.get("customizationProfile"), reason: values.get("reason"), expectedVersion: snapshot.catalogVersion,
    });
    const photo = values.get("photo");
    if (photo instanceof File && photo.size) {
      await catalogAction("catalog.product.media.update", { productId: created.product.id, imageDataUrl: await catalogPhotoDataUrl(photo), altText: created.product.name, reason: "Foto menu baru dari Dashboard Owner", expectedVersion: created.version });
    }
    await refresh();
    announce(`${created.product.name} tersimpan sebagai draft. Tinjau lalu publish ke Kiosk.`);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

async function submitCatalogProductEdit(form) {
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector("[role=status]");
  button.disabled = true;
  try {
    const values = new FormData(form);
    const saved = await catalogAction("catalog.product.update", {
      productId: values.get("productId"), name: values.get("name"), priceRupiah: Number(values.get("priceRupiah")), categoryId: values.get("categoryId"), station: values.get("station"), status: values.get("status"), sortRank: Number(values.get("sortRank")), reason: values.get("reason"), expectedVersion: snapshot.catalogVersion,
    });
    const photo = values.get("photo");
    if (photo instanceof File && photo.size) {
      await catalogAction("catalog.product.media.update", { productId: values.get("productId"), imageDataUrl: await catalogPhotoDataUrl(photo), altText: values.get("name"), reason: "Foto menu diperbarui dari Dashboard Owner", expectedVersion: saved.version ?? snapshot.catalogVersion });
    }
    await refresh();
    announce(`${values.get("name")} berhasil diperbarui.`);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

async function catalogPhotoDataUrl(file) {
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type) || file.size > 12_000_000) throw new Error("Foto harus JPG, PNG, atau WebP dengan ukuran awal maksimal 12 MB.");
  const image = await decodeCatalogImage(file);
  try {
    for (const [maxSide, quality] of [[1600, .82], [1280, .74], [960, .68]]) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(32, Math.round(image.width * scale));
      canvas.height = Math.max(32, Math.round(image.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Foto belum dapat diproses di perangkat ini.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (blob && blob.size <= 600_000) return fileToDataUrl(blob);
    }
    throw new Error("Foto masih terlalu besar setelah diperkecil. Gunakan foto dengan detail atau dimensi lebih rendah.");
  } finally {
    image.close?.();
  }
}

async function decodeCatalogImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* fallback below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    throw new Error("Foto rusak atau tidak dapat dibaca. Pilih foto lain.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Foto belum dapat dibaca. Pilih foto lain dan coba lagi."));
    reader.readAsDataURL(file);
  });
}

function ownerInventoryPage(data) {
  const active = [...inventoryAreas, { id: "finalize", label: "Diagnostik" }].find((item) => item.id === inventoryArea) ?? inventoryAreas[0];
  const tabs = inventoryAreas.map((item) => `<a id="inventory-tab-${item.id}" href="#inventory/${item.id}" role="tab" data-inventory-area="${item.id}" aria-selected="${item.id === active.id}" aria-controls="inventory-workspace-panel" tabindex="${item.id === active.id ? "0" : "-1"}">${escapeHtml(item.label)}</a>`).join("");
  return `<section class="inventory-workspace-shell" aria-labelledby="inventory-workspace-title">
    <div class="inventory-workspace-heading"><div><p class="eyebrow">Operasional persediaan</p><h2 id="inventory-workspace-title">Stok & HPP</h2><p>Kelola bahan, stok fisik, dan kesiapan biaya menu dalam satu dashboard Owner.</p></div><button class="button button-ghost" type="button" data-inventory-refresh ${inventoryWorkspace.status === "loading" ? "disabled" : ""}>Perbarui data</button></div>
    <nav class="inventory-workspace-tabs" role="tablist" aria-label="Area Stok dan HPP">${tabs}${active.id === "finalize" ? `<a id="inventory-tab-finalize" href="#inventory/finalize" role="tab" data-inventory-area="finalize" aria-selected="true" aria-controls="inventory-workspace-panel" tabindex="0">Diagnostik</a>` : ""}</nav>
    <section id="inventory-workspace-panel" class="inventory-workspace-panel" role="tabpanel" aria-labelledby="inventory-tab-${active.id}" tabindex="0">${ownerInventoryWorkspaceState(data, active.id)}</section>
    <p class="inventory-source-note"><a href="#inventory/finalize">Diagnostik persediaan</a> · Checklist teknis disimpan terpisah dari pekerjaan stok harian.</p>
  </section>`;
}

function ownerInventoryWorkspaceState(dashboardData, area) {
  const { status, data, error, stale } = inventoryWorkspace;
  if (status === "idle" || (status === "loading" && !data)) return ownerInventoryLoadingState();
  if (status === "error") return `<article class="inventory-state-card is-error" role="alert"><span aria-hidden="true">!</span><div><h3>Data stok belum dapat dimuat</h3><p>${escapeHtml(error || "Koneksi ke server belum tersedia.")}</p></div><button class="button" type="button" data-inventory-refresh>Coba lagi</button></article>`;
  const notices = `${stale ? `<article class="inventory-state-card is-stale" role="status"><span aria-hidden="true">↻</span><div><h3>Menampilkan data terakhir</h3><p>Pembaruan gagal: ${escapeHtml(error)}. Data di bawah mungkin belum terbaru.</p></div><button class="button" type="button" data-inventory-refresh>Coba perbarui</button></article>` : ""}${data.conflict ? `<article class="inventory-state-card is-conflict" role="alert"><span aria-hidden="true">!</span><div><h3>${escapeHtml(data.conflict.title || "Perubahan perlu ditinjau")}</h3><p>${escapeHtml(data.conflict.message || "Data berubah di perangkat lain. Muat ulang sebelum melanjutkan.")}</p></div><button class="button" type="button" data-inventory-refresh>Muat data terbaru</button></article>` : ""}${data.lastOperation ? `<article class="inventory-state-card is-success" role="status"><span aria-hidden="true">✓</span><div><h3>${escapeHtml(data.lastOperation.title || "Perubahan tersimpan")}</h3><p>${escapeHtml(data.lastOperation.message || "Data terbaru sudah tersedia di dashboard.")}</p></div></article>` : ""}`;
  const summary = data.summary ?? {};
  const theoretical = dashboardData.theoreticalIngredientUsage;
  const coverageMetric = area === "warehouse" && theoretical?.soldItemQuantity > 0
    ? metric("Cakupan resep terjual", theoretical.coveragePct == null ? "N/A" : `${theoretical.coveragePct}%`, `${theoretical.verifiedItemQuantity} dari ${theoretical.soldItemQuantity} item`, "aov")
    : metric("Menu terverifikasi", `${summary.hppVerifiedCount ?? 0}/${summary.menuCount ?? 0}`, `${data.hpp?.coverage?.percent ?? 0}% cakupan`, "aov");
  const metrics = `<section class="inventory-summary-grid" aria-label="Ringkasan Stok dan HPP">${metric("Database bahan", summary.ingredientCount ?? 0, `${summary.unpricedIngredientCount ?? 0} belum punya biaya`, "sales")}${metric("Nilai stok", rupiah(summary.onHandValueRupiah ?? 0), `${data.warehouse?.balances?.length ?? 0} saldo bahan`, "orders")}${coverageMetric}${metric("Perlu dilengkapi", (summary.hppNotSetCount ?? 0) + (summary.hppDraftCount ?? 0) + (summary.hppNeedsReviewCount ?? 0), "HPP tidak menghalangi pembuatan menu", "queue")}</section>`;
  const source = `<p class="inventory-source-note">Data bisnis ${escapeHtml(data.businessDate || dashboardData.businessDate)} · revisi ${escapeHtml(data.revision)} · diperbarui ${dateTime(data.generatedAt)}</p>`;
  return `${notices}${metrics}${area === "finalize" ? ownerPhase2FinalizationArea(data) : area === "database" ? ownerIngredientArea(data) : area === "warehouse" ? ownerWarehouseArea(data, dashboardData) : ownerHppArea(data, dashboardData)}${source}`;
}

function ownerPhase2FinalizationArea(data) {
  const phase = data.phase2 ?? { score: 0, blockingCount: 0, stages: [], state: "MISSING" };
  const stages = (phase.stages ?? []).map((stage) => {
    const checks = (stage.checks ?? []).map((item) => `<li class="${item.complete ? "is-complete" : ""}"><span aria-hidden="true">${item.complete ? "✓" : "!"}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></div></li>`).join("");
    const queue = (stage.queue ?? []).slice(0, 8).map((item) => `<li><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.action)}</small></span>${item.type === "MENU_HPP" ? `<button class="button button-ghost button-small" type="button" data-phase2-hpp-edit="${escapeHtml(item.entityId)}">Kerjakan</button>` : `<a class="button button-ghost button-small" href="${escapeHtml(item.href)}">Buka</a>`}</li>`).join("");
    return `<article class="dashboard-card phase2-stage-card" data-phase2-stage="${escapeHtml(stage.id)}"><div class="phase2-stage-heading"><div><h2>${escapeHtml(stage.label)}</h2><p>${stage.readyChecks}/${stage.totalChecks} gate selesai</p></div><strong>${stage.score}%</strong></div><div class="business-readiness-progress" role="progressbar" aria-label="Kesiapan ${escapeHtml(stage.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${stage.score}"><span style="width:${stage.score}%"></span></div><ul class="phase2-check-list">${checks}</ul>${queue ? `<div class="phase2-queue"><h3>Pekerjaan berikutnya · ${stage.queueTotal}</h3><ul>${queue}</ul>${stage.queueTotal > 8 ? `<p>${stage.queueTotal - 8} item lain tersedia di area kerja.</p>` : ""}</div>` : '<p class="phase2-stage-ready">Tahap ini lengkap dari data server.</p>'}<a class="button ${stage.state === "READY" ? "button-ghost" : "button-primary"}" href="${escapeHtml(stage.href)}">${stage.state === "READY" ? "Periksa data" : "Lanjutkan tahap ini"}</a></article>`;
  }).join("");
  return `<section class="phase2-finalization" aria-labelledby="phase2-title"><article class="phase2-hero ${phase.state === "READY" ? "is-ready" : ""}"><div><p class="eyebrow">Phase 2 · data operasional</p><h2 id="phase2-title">Bahan → stok fisik → HPP menu</h2><p>${escapeHtml(phase.note || "Selesaikan urutan kerja Phase 2 dari data server.")}</p></div><div class="phase2-score"><strong>${phase.score}%</strong><span>${phase.blockingCount} gate tersisa</span></div></article><div class="phase2-sequence" aria-label="Urutan finalisasi Phase 2">${stages}</div><aside class="inventory-state-card is-stale phase2-boundary"><span aria-hidden="true">i</span><div><h3>Batas hasil Phase 2</h3><p>HPP di sini adalah HPP teoretis dari resep dan biaya bahan. HPP aktual periode tetap membutuhkan stock count pembuka dan penutup serta seluruh penerimaan, waste, dan koreksi tercatat.</p></div></aside></section>`;
}

function ownerInventoryLoadingState() {
  return `<section class="inventory-loading" aria-label="Memuat data Stok dan HPP" aria-busy="true"><span class="sr-only">Memuat data stok dan HPP</span>${[1, 2, 3, 4].map(() => '<div class="inventory-skeleton"><i></i><b></b><small></small></div>').join("")}</section>`;
}

function createIngredientWizardState(overrides = {}) {
  return {
    step: 1,
    mode: "create",
    categoryId: "",
    customCategoryName: "",
    customCategoryPrefix: "",
    name: "",
    baseUnit: "ml",
    sourcingMode: "PURCHASED",
    purchaseMode: "DIRECT",
    purchaseUnit: "botol",
    innerUnit: "botol",
    innerUnitsPerPurchaseUnit: "12",
    baseUnitsPerInnerUnit: "1000",
    baseUnitsPerPurchaseUnit: "1000",
    referencePriceRupiah: "",
    supplierName: "",
    preferred: true,
    packageVerified: false,
    lotTrackingPolicy: "NOT_REQUIRED",
    minimumShelfLifeDays: "0",
    ingredientId: "",
    categoryName: "",
    result: null,
    ...overrides,
  };
}

function openIngredientWizard({ resume = false } = {}) {
  let restored = null;
  if (resume) {
    try { restored = JSON.parse(sessionStorage.getItem(ingredientWizardScopedStorageKey()) || "null"); } catch { restored = null; }
  }
  ingredientWizard = createIngredientWizardState(restored && !restored.result ? restored : {});
  render();
  requestAnimationFrame(() => focusIngredientWizardStep());
}

function persistIngredientWizardDraft() {
  if (!ingredientWizard || ingredientWizard.result || ingredientWizard.mode === "purchase-option") return;
  try { sessionStorage.setItem(ingredientWizardScopedStorageKey(), JSON.stringify({ ...ingredientWizard, result: null })); } catch { /* Storage can be unavailable in restricted browsers. */ }
}

function clearIngredientWizardDraft() {
  try { sessionStorage.removeItem(ingredientWizardScopedStorageKey()); } catch { /* Non-critical. */ }
}

function ingredientWizardScopedStorageKey() {
  const organizationId = snapshot?.context?.organizationId || snapshot?.context?.organizationSlug || "unknown-organization";
  const outletId = snapshot?.context?.outletId || "unknown-outlet";
  return `${ingredientWizardStorageKey}:${organizationId}:${outletId}`;
}

function hasIngredientWizardDraft() {
  try { return Boolean(sessionStorage.getItem(ingredientWizardScopedStorageKey())); } catch { return false; }
}

function collectIngredientWizardDraft(form) {
  if (!ingredientWizard || !form) return;
  const values = new FormData(form);
  for (const key of ["categoryId", "customCategoryName", "customCategoryPrefix", "name", "baseUnit", "sourcingMode", "purchaseMode", "purchaseUnit", "innerUnit", "innerUnitsPerPurchaseUnit", "baseUnitsPerInnerUnit", "baseUnitsPerPurchaseUnit", "referencePriceRupiah", "supplierName", "lotTrackingPolicy", "minimumShelfLifeDays"]) {
    if (values.has(key)) ingredientWizard[key] = String(values.get(key) ?? "");
  }
  ingredientWizard.preferred = values.has("preferred");
  ingredientWizard.packageVerified = ingredientWizard.sourcingMode === "MADE_IN_HOUSE" || values.has("packageVerified");
}

function invalidateIngredientPackageVerification(form) {
  ingredientWizard.packageVerified = false;
  const checkbox = form.elements.packageVerified;
  if (checkbox) checkbox.checked = false;
}

function applyIngredientCategorySuggestion(form, categoryId) {
  if (!ingredientWizard || categoryId === "__custom__") return;
  const category = inventoryIngredientCategories(inventoryWorkspace.data).find((item) => item.id === categoryId);
  if (!category) return;
  ingredientWizard.packageVerified = false;
  ingredientWizard.baseUnit = category.suggestedBaseUnit || ingredientWizard.baseUnit;
  const suggestion = ingredientPackagingSuggestion(category.name, ingredientWizard.baseUnit);
  ingredientWizard.purchaseMode = suggestion.purchaseMode;
  ingredientWizard.purchaseUnit = suggestion.purchaseUnit;
  ingredientWizard.innerUnit = suggestion.innerUnit;
  ingredientWizard.innerUnitsPerPurchaseUnit = String(suggestion.innerUnitsPerPurchaseUnit);
  ingredientWizard.baseUnitsPerInnerUnit = String(suggestion.baseUnitsPerInnerUnit);
  ingredientWizard.baseUnitsPerPurchaseUnit = String(suggestion.baseUnitsPerPurchaseUnit);
}

function ingredientPackagingSuggestion(categoryName, baseUnit) {
  const normalized = String(categoryName).toLocaleLowerCase("id-ID");
  if (normalized.includes("susu")) return { purchaseMode: "LARGE", purchaseUnit: "karton", innerUnit: "botol", innerUnitsPerPurchaseUnit: 12, baseUnitsPerInnerUnit: 1000, baseUnitsPerPurchaseUnit: 12000 };
  if (normalized.includes("sirup") || normalized.includes("jus")) return { purchaseMode: "DIRECT", purchaseUnit: "botol", innerUnit: "botol", innerUnitsPerPurchaseUnit: 1, baseUnitsPerInnerUnit: 750, baseUnitsPerPurchaseUnit: 750 };
  if (normalized.includes("kopi") || normalized.includes("tepung") || normalized.includes("bubuk") || normalized.includes("gula")) return { purchaseMode: "DIRECT", purchaseUnit: "bag", innerUnit: "bag", innerUnitsPerPurchaseUnit: 1, baseUnitsPerInnerUnit: 1000, baseUnitsPerPurchaseUnit: 1000 };
  if (normalized.includes("telur")) return { purchaseMode: "DIRECT", purchaseUnit: "tray", innerUnit: "tray", innerUnitsPerPurchaseUnit: 1, baseUnitsPerInnerUnit: 30, baseUnitsPerPurchaseUnit: 30 };
  if (normalized.includes("kemasan") || normalized.includes("sedotan") || normalized.includes("label") || baseUnit === "pcs") return { purchaseMode: "LARGE", purchaseUnit: "karton", innerUnit: "pcs", innerUnitsPerPurchaseUnit: 1000, baseUnitsPerInnerUnit: 1, baseUnitsPerPurchaseUnit: 1000 };
  return { purchaseMode: "DIRECT", purchaseUnit: baseUnit, innerUnit: baseUnit, innerUnitsPerPurchaseUnit: 1, baseUnitsPerInnerUnit: 1, baseUnitsPerPurchaseUnit: 1 };
}

function inventoryIngredientCategories(data) {
  const categories = data?.ingredients?.categories;
  return Array.isArray(categories) && categories.length
    ? categories.filter((item) => item.status !== "ARCHIVED").sort((a, b) => a.name.localeCompare(b.name, "id"))
    : ingredientCategoryFallbacks;
}

function ingredientWizardCategory(data) {
  return inventoryIngredientCategories(data).find((item) => item.id === ingredientWizard?.categoryId) ?? null;
}

function ingredientWizardCodePreview(data) {
  const category = ingredientWizardCategory(data);
  const prefix = ingredientWizard?.categoryId === "__custom__" ? String(ingredientWizard.customCategoryPrefix || "BAR").toUpperCase() : category?.prefix || "BAR";
  const used = (data?.ingredients?.items ?? []).map((item) => String(item.sku || "")).filter((sku) => sku.startsWith(`${prefix}-`)).map((sku) => Number(sku.slice(prefix.length + 1))).filter(Number.isSafeInteger);
  return `${prefix}-${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
}

function ingredientWizardNumbers() {
  const large = ingredientWizard?.purchaseMode === "LARGE";
  const innerCount = large ? Number(ingredientWizard.innerUnitsPerPurchaseUnit) : 1;
  const basePerInner = large ? Number(ingredientWizard.baseUnitsPerInnerUnit) : Number(ingredientWizard?.baseUnitsPerPurchaseUnit);
  const totalBase = innerCount > 0 && basePerInner > 0 ? innerCount * basePerInner : 0;
  const price = ingredientWizard?.referencePriceRupiah === "" ? null : Number(ingredientWizard.referencePriceRupiah);
  return { large, innerCount, basePerInner, totalBase, price, unitCost: price != null && price > 0 && totalBase > 0 ? price / totalBase : null };
}

function syncIngredientWizardSummary(form) {
  if (!ingredientWizard || !form) return;
  const { large, innerCount, basePerInner, totalBase, price, unitCost } = ingredientWizardNumbers();
  const madeInHouse = ingredientWizard.sourcingMode === "MADE_IN_HOUSE";
  const baseUnit = ingredientWizard.baseUnit || "unit";
  const set = (selector, value) => { const node = form.querySelector(selector); if (node) node.textContent = value; };
  set("[data-wizard-total-base]", totalBase > 0 ? `${formatPlainNumber(totalBase)} ${baseUnit}` : "Lengkapi konversi");
  set("[data-wizard-unit-cost]", unitCost == null ? "Biaya belum tersedia" : `${formatRupiahDecimal(unitCost)} / ${baseUnit}`);
  set("[data-wizard-inner-cost]", price != null && price > 0 && large && innerCount > 0 ? `${rupiah(price / innerCount)} / ${ingredientWizard.innerUnit || "satuan isi"}` : "—");
  set("[data-wizard-conversion-copy]", large ? `1 ${ingredientWizard.purchaseUnit || "kemasan"} = ${formatPlainNumber(innerCount)} ${ingredientWizard.innerUnit || "isi"} = ${formatPlainNumber(totalBase)} ${baseUnit}` : `1 ${ingredientWizard.purchaseUnit || "kemasan"} = ${formatPlainNumber(totalBase)} ${baseUnit}`);
  const category = ingredientWizardCategory(inventoryWorkspace.data);
  const categoryName = ingredientWizard.categoryId === "__custom__" ? ingredientWizard.customCategoryName : category?.name || ingredientWizard.categoryName;
  set("[data-ingredient-review-value='identity']", `${ingredientWizard.name || "Nama belum diisi"} · ${ingredientWizardCodePreview(inventoryWorkspace.data)}`);
  set("[data-ingredient-review-value='category']", `${categoryName || "Kategori belum dipilih"} · ${baseUnit}`);
  set("[data-ingredient-review-value='source']", madeInHouse ? "Dibuat sendiri · stok hasil produksi" : "Dibeli dari supplier");
  set("[data-ingredient-review-value='package']", madeInHouse ? "Tidak memakai pilihan pembelian" : ingredientWizardConversionCopy());
  set("[data-ingredient-review-value='price']", madeInHouse ? "Dihitung dari bahan resep produksi" : price == null ? "Belum diisi — boleh dilengkapi nanti" : `${rupiah(price)} per ${ingredientWizard.purchaseUnit || "kemasan"}`);
  set("[data-ingredient-review-value='cost']", madeInHouse ? "Terbentuk saat produksi batch selesai" : unitCost == null || totalBase <= 0 ? "Biaya belum tersedia" : `${formatRupiahDecimal(unitCost)} / ${baseUnit}`);
  set("[data-ingredient-review-state='identity']", ingredientWizard.name.trim() ? "Lengkap" : "Perlu diisi");
  set("[data-ingredient-review-state='package']", madeInHouse ? "Resep diatur setelah bahan disimpan" : ingredientWizard.packageVerified ? "Sudah diperiksa" : "Perlu diperiksa");
  const reviewMark = form.querySelector("[data-ingredient-review-mark]");
  if (reviewMark) {
    const ready = Boolean(ingredientWizard.name.trim() && (madeInHouse || ingredientWizard.packageVerified));
    reviewMark.textContent = ready ? "✓" : "!";
    reviewMark.classList.toggle("is-pending", !ready);
  }
}

function validateIngredientWizardForm(form) {
  const controls = [...form.querySelectorAll("input, select")].filter((control) => !control.disabled && control.type !== "hidden");
  for (const control of controls) {
    if (!control.checkValidity()) {
      control.reportValidity();
      control.focus();
      return false;
    }
  }
  if (ingredientWizard.categoryId === "__custom__" && !/^[A-Z0-9]{2,5}$/.test(ingredientWizard.customCategoryPrefix.toUpperCase())) {
    const prefix = form.elements.customCategoryPrefix;
    prefix?.setCustomValidity("Gunakan 2–5 huruf atau angka."); prefix?.reportValidity(); prefix?.focus();
    return false;
  }
  return true;
}

function focusIngredientWizardStep() {
  const heading = content.querySelector("#ingredient-wizard-title");
  heading?.focus();
  syncIngredientWizardSummary(content.querySelector("#ingredient-wizard-form"));
}

async function submitIngredientWizard(form) {
  collectIngredientWizardDraft(form);
  if (!validateIngredientWizardForm(form)) return;
  if (inventoryMutationPending) return;
  inventoryMutationPending = true;
  const status = form.querySelector("#ingredient-wizard-status");
  const submit = form.querySelector("[data-ingredient-wizard-save]");
  if (submit) submit.disabled = true;
  if (status) status.textContent = ingredientWizard.sourcingMode === "MADE_IN_HOUSE" ? "Menyimpan bahan olahan…" : "Menyimpan bahan dan pilihan pembelian…";
  try {
    const category = ingredientWizardCategory(inventoryWorkspace.data);
    const categoryName = ingredientWizard.categoryId === "__custom__" ? ingredientWizard.customCategoryName : category?.name || ingredientWizard.categoryName;
    let ingredientId = ingredientWizard.ingredientId;
    const { large, totalBase, price } = ingredientWizardNumbers();
    const label = large
      ? `${capitalizeUnit(ingredientWizard.purchaseUnit)} ${formatPlainNumber(Number(ingredientWizard.innerUnitsPerPurchaseUnit))} ${ingredientWizard.innerUnit}`
      : `${capitalizeUnit(ingredientWizard.purchaseUnit)} ${formatPlainNumber(Number(ingredientWizard.baseUnitsPerPurchaseUnit))} ${ingredientWizard.baseUnit}`;
    const purchaseOption = {
      label,
      purchaseUnit: ingredientWizard.purchaseUnit,
      ...(large ? {
        innerUnit: ingredientWizard.innerUnit,
        innerUnitsPerPurchaseUnit: Number(ingredientWizard.innerUnitsPerPurchaseUnit),
        baseUnitsPerInnerUnit: Number(ingredientWizard.baseUnitsPerInnerUnit),
      } : { baseUnitsPerPurchaseUnit: Number(ingredientWizard.baseUnitsPerPurchaseUnit) }),
      referencePriceRupiah: price == null ? null : Math.round(price),
      ...(ingredientWizard.supplierName.trim() ? { supplierName: ingredientWizard.supplierName.trim() } : {}),
      preferred: ingredientWizard.preferred,
    };
    let result;
    if (ingredientWizard.mode === "purchase-option") {
      if (!ingredientId) throw new Error("ID bahan belum tersedia. Muat ulang sebelum menambah kemasan.");
      result = await requestInventoryWizardAction("ingredient.purchase-option.upsert", { ingredientId, ...purchaseOption }, "Menambahkan pilihan pembelian dari form Owner");
    } else if (ingredientWizard.sourcingMode === "MADE_IN_HOUSE") {
      result = await requestHppAdminAction("hpp.ingredient.upsert", {
        name: ingredientWizard.name.trim(),
        categoryId: ingredientWizard.categoryId === "__custom__" ? null : ingredientWizard.categoryId,
        category: categoryName,
        baseUnit: ingredientWizard.baseUnit,
        sourcingMode: "MADE_IN_HOUSE",
        materialType: "PREP_ITEM",
        purchasable: false,
        costPerUnitRupiah: null,
        lotTrackingPolicy: ingredientWizard.lotTrackingPolicy,
        minimumShelfLifeDays: Number(ingredientWizard.minimumShelfLifeDays || 0),
        expectedVersion: Number(inventoryWorkspace.data?.revision ?? 0),
        reason: "Menambahkan bahan olahan dari Database Bahan",
      });
      ingredientId = result.next?.id || result.operation?.next?.id || result.operation?.ingredient?.id || result.ingredient?.id;
    } else {
      result = await requestInventoryWizardAction("ingredient.wizard.create", {
        ...(ingredientWizard.categoryId === "__custom__" ? { category: { name: ingredientWizard.customCategoryName, prefix: ingredientWizard.customCategoryPrefix.toUpperCase(), suggestedBaseUnit: ingredientWizard.baseUnit } } : category?.fallback ? { category: { name: category.name, prefix: category.prefix, suggestedBaseUnit: ingredientWizard.baseUnit, storageType: category.storageType } } : { categoryId: ingredientWizard.categoryId }),
        name: ingredientWizard.name,
        baseUnit: ingredientWizard.baseUnit,
        purchasable: true,
        lotTrackingPolicy: ingredientWizard.lotTrackingPolicy,
        minimumShelfLifeDays: Number(ingredientWizard.minimumShelfLifeDays || 0),
        purchaseOption,
      }, "Menambahkan bahan lengkap dari form Owner");
      ingredientId = result.operation?.next?.id || result.operation?.ingredient?.id;
    }
    if (!ingredientId) throw new Error("Bahan tersimpan, tetapi ID bahan belum diterima. Muat ulang data sebelum melanjutkan.");
    clearIngredientWizardDraft();
    ingredientWizard = {
      ...ingredientWizard,
      result: { ingredientId, name: ingredientWizard.name, categoryName, baseUnit: ingredientWizard.baseUnit, sourcingMode: ingredientWizard.sourcingMode, code: result?.next?.code || result?.next?.sku || result?.operation?.next?.code || result?.operation?.next?.sku || result?.operation?.ingredient?.code || inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === ingredientId)?.sku || ingredientWizardCodePreview(inventoryWorkspace.data) },
    };
    render();
    requestAnimationFrame(() => content.querySelector("[data-prep-recipe-open], [data-ingredient-success='stock']")?.focus());
    announce(ingredientWizard.result.sourcingMode === "MADE_IN_HOUSE" ? "Bahan olahan berhasil disimpan. Atur resep sebelum produksi batch." : "Bahan dan pilihan pembelian berhasil disimpan.");
  } catch (error) {
    const current = content.querySelector("#ingredient-wizard-status");
    if (current) current.textContent = error.message;
    announce(error.message, true);
  } finally {
    inventoryMutationPending = false;
    const currentSubmit = content.querySelector("[data-ingredient-wizard-save]");
    if (currentSubmit) currentSubmit.disabled = false;
  }
}

async function requestInventoryWizardAction(action, payload, reason) {
  const result = await request("/api/operator/inventory-actions", {
    method: "POST", csrf: true,
    body: { action, expectedRevision: inventoryWorkspace.data.revision, reason, payload },
  });
  csrfToken = result.csrfToken || csrfToken;
  inventoryWorkspace = { status: "ready", data: result.workspace, error: null, stale: false };
  return result;
}

async function requestHppAdminAction(action, payload) {
  const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action, payload } });
  csrfToken = result.csrfToken || csrfToken;
  if (result.workspace) inventoryWorkspace = { status: "ready", data: result.workspace, error: null, stale: false };
  else {
    const data = await request("/api/operator/inventory-workspace");
    inventoryWorkspace = { status: "ready", data, error: null, stale: false };
  }
  return result;
}

function formatPlainNumber(value) { return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 6 }).format(Number(value) || 0); }
function formatRupiahDecimal(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 4 }).format(Number(value)); }
function capitalizeUnit(value) { const normalized = String(value || "Kemasan").trim(); return normalized ? normalized[0].toLocaleUpperCase("id-ID") + normalized.slice(1) : "Kemasan"; }

function ownerIngredientWizard(data) {
  if (ingredientWizard.result) return `<dialog id="ingredient-editor-dialog" class="ingredient-editor-dialog" aria-labelledby="ingredient-success-title">${ownerIngredientWizardSuccess()}</dialog>`;
  const categories = inventoryIngredientCategories(data);
  if (ingredientWizard.mode !== "purchase-option" && !ingredientWizard.categoryId && categories[0]) {
    ingredientWizard.categoryId = categories[0].id;
    applyIngredientCategorySuggestion(null, categories[0].id);
  }
  const category = ingredientWizardCategory(data);
  const isCustom = ingredientWizard.categoryId === "__custom__";
  const numbers = ingredientWizardNumbers();
  const categoryOptions = categories.map((item) => `<option value="${escapeHtml(item.id)}" ${ingredientWizard.categoryId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const modeTitle = ingredientWizard.mode === "purchase-option" ? `Tambah pilihan pembelian ${escapeHtml(ingredientWizard.name)}` : "Tambah bahan baru";
  return `<dialog id="ingredient-editor-dialog" class="ingredient-editor-dialog" aria-labelledby="ingredient-wizard-title" aria-describedby="ingredient-editor-description"><section class="ingredient-wizard-shell ingredient-editor-shell" aria-labelledby="ingredient-wizard-title">
    <header class="ingredient-wizard-header ingredient-editor-header"><div><p class="eyebrow">Database bahan</p><h1 id="ingredient-wizard-title" tabindex="-1">${modeTitle}</h1><p id="ingredient-editor-description">Lengkapi data bahan dalam satu layar. Stok belum bertambah sampai Anda mencatat penerimaan di Gudang.</p></div><button class="ingredient-editor-dismiss" type="button" data-ingredient-wizard-close aria-label="Simpan draft dan tutup">×</button></header>
    <form id="ingredient-wizard-form" class="ingredient-wizard-form ingredient-editor-form" novalidate>
      ${ingredientWizard.mode === "purchase-option" ? `<input type="hidden" name="name" value="${escapeHtml(ingredientWizard.name)}"><input type="hidden" name="baseUnit" value="${escapeHtml(ingredientWizard.baseUnit)}"><input type="hidden" name="categoryId" value="${escapeHtml(ingredientWizard.categoryId)}">` : ""}
      <section class="ingredient-wizard-panel" data-wizard-panel="1"  aria-labelledby="wizard-category-title"><p class="ingredient-wizard-kicker">Mulai dari kelompok bahan</p><h2 id="wizard-category-title" tabindex="-1">Bahan ini termasuk kategori apa?</h2><p class="ingredient-wizard-lead">Kategori membantu kode dan satuan terisi otomatis. Anda tetap bisa mengubah sarannya.</p>
        <label class="ingredient-wizard-field">Kategori bahan<select name="categoryId" required ${ingredientWizard.mode === "purchase-option" ? "disabled" : ""}>${categoryOptions}<option value="__custom__" ${isCustom ? "selected" : ""}>+ Buat kategori sendiri</option></select><small>Ketik nama bahan nanti; kategori cukup dipilih satu kali.</small></label>
        ${isCustom ? `<div class="ingredient-wizard-grid"><label class="ingredient-wizard-field">Nama kategori<input name="customCategoryName" value="${escapeHtml(ingredientWizard.customCategoryName)}" maxlength="60" placeholder="Contoh: Bahan fermentasi" required></label><label class="ingredient-wizard-field">Prefix kode<input name="customCategoryPrefix" value="${escapeHtml(ingredientWizard.customCategoryPrefix)}" maxlength="5" pattern="[A-Za-z0-9]{2,5}" placeholder="FER" required><small>2–5 huruf/angka; hanya ditentukan saat kategori dibuat.</small></label></div>` : `<article class="ingredient-wizard-category-note"><span>${escapeHtml(category?.prefix || "BAR")}</span><div><strong>${escapeHtml(category?.name || "Kategori bahan")}</strong><p>Kode otomatis diawali ${escapeHtml(category?.prefix || "BAR")} · saran satuan ${escapeHtml(category?.suggestedBaseUnit || "pcs")} · penyimpanan ${escapeHtml(ingredientStorageLabel(category?.storageType))}</p></div></article>`}
      </section>
      <section class="ingredient-wizard-panel" data-wizard-panel="2"  aria-labelledby="wizard-info-title"><p class="ingredient-wizard-kicker">Identitas bahan</p><h2 id="wizard-info-title" tabindex="-1">Apa bahan yang akan dicatat?</h2><p class="ingredient-wizard-lead">Kode dibuat server agar tidak bentrok dengan bahan lain.</p>
        ${ingredientWizard.mode === "purchase-option" ? '<input type="hidden" name="sourcingMode" value="PURCHASED">' : `<fieldset class="ingredient-source-choice"><legend>Sumber bahan</legend><div class="ingredient-wizard-choice-grid"><label class="ingredient-wizard-choice ${ingredientWizard.sourcingMode !== "MADE_IN_HOUSE" ? "is-selected" : ""}"><input type="radio" name="sourcingMode" value="PURCHASED" ${ingredientWizard.sourcingMode !== "MADE_IN_HOUSE" ? "checked" : ""}><span aria-hidden="true">↓</span><strong>Dibeli dari supplier</strong><small>Gunakan kemasan dan harga pembelian.</small></label><label class="ingredient-wizard-choice ${ingredientWizard.sourcingMode === "MADE_IN_HOUSE" ? "is-selected" : ""}"><input type="radio" name="sourcingMode" value="MADE_IN_HOUSE" ${ingredientWizard.sourcingMode === "MADE_IN_HOUSE" ? "checked" : ""}><span aria-hidden="true">↻</span><strong>Dibuat sendiri</strong><small>Bahan olahan dengan stok dari produksi batch.</small></label></div></fieldset>`}
        <div class="ingredient-wizard-grid"><label class="ingredient-wizard-field ingredient-wizard-field-wide">Nama bahan<input name="name" value="${escapeHtml(ingredientWizard.name)}" maxlength="80" autocomplete="off" placeholder="Contoh: Susu UHT Full Cream" required ${ingredientWizard.mode === "purchase-option" ? "readonly" : ""}></label><label class="ingredient-wizard-field">Kode bahan<input value="${escapeHtml(ingredientWizardCodePreview(data))}" readonly aria-describedby="ingredient-code-help"><small id="ingredient-code-help">Preview; kode final dikunci server saat disimpan.</small></label><label class="ingredient-wizard-field">Satuan dasar<select name="baseUnit" required ${ingredientWizard.mode === "purchase-option" ? "disabled" : ""}>${["gram", "ml", "pcs"].map((unit) => `<option value="${unit}" ${ingredientWizard.baseUnit === unit ? "selected" : ""}>${unit}</option>`).join("")}</select><small>Resep HPP dan saldo gudang memakai satuan ini.</small></label><label class="ingredient-wizard-field">Pelacakan batch<select name="lotTrackingPolicy" ${ingredientWizard.mode === "purchase-option" ? "disabled" : ""}><option value="NOT_REQUIRED" ${ingredientWizard.lotTrackingPolicy !== "REQUIRED" ? "selected" : ""}>Tidak wajib</option><option value="REQUIRED" ${ingredientWizard.lotTrackingPolicy === "REQUIRED" ? "selected" : ""}>Wajib batch & expiry</option></select></label><label class="ingredient-wizard-field">Minimal masa simpan (hari)<input name="minimumShelfLifeDays" type="number" min="0" max="3650" step="1" value="${escapeHtml(ingredientWizard.minimumShelfLifeDays)}" ${ingredientWizard.mode === "purchase-option" ? "disabled" : ""}><small>Penerimaan yang terlalu dekat kedaluwarsa akan ditolak.</small></label></div>
      </section>
      ${ingredientWizard.sourcingMode === "MADE_IN_HOUSE" ? `<section class="ingredient-wizard-panel ingredient-prep-guidance" aria-labelledby="wizard-prep-title"><p class="ingredient-wizard-kicker">Bahan olahan</p><h2 id="wizard-prep-title">Stok dibuat melalui produksi batch</h2><p>Supplier, pilihan pembelian, dan harga acuan tidak diperlukan. Setelah bahan tersimpan, atur resep olahan lalu catat produksi batch di Gudang. Biaya bahan olahan dihitung dari komponen yang benar-benar dipakai.</p><ul><li>Stok tidak bertambah saat master disimpan.</li><li>Resep HPP menu dapat memakai stok bahan olahan ini.</li><li>Produksi tidak mempublikasikan HPP atau mengubah harga jual.</li></ul></section>` : `
      <section class="ingredient-wizard-panel" data-wizard-panel="3"  aria-labelledby="wizard-package-title"><p class="ingredient-wizard-kicker">Cara pembelian</p><h2 id="wizard-package-title" tabindex="-1">Biasanya Anda membeli dalam bentuk apa?</h2><p class="ingredient-wizard-lead">Angka isi terisi sebagai contoh kategori. Periksa label kemasan barang Anda; pilihan ini menentukan stok dan biaya per satuan setelah barang diterima.</p>
        <div class="ingredient-wizard-choice-grid" role="radiogroup" aria-label="Cara pembelian"><label class="ingredient-wizard-choice ${ingredientWizard.purchaseMode === "DIRECT" ? "is-selected" : ""}"><input type="radio" name="purchaseMode" value="DIRECT" ${ingredientWizard.purchaseMode === "DIRECT" ? "checked" : ""}><span aria-hidden="true">1×</span><strong>Beli satuan</strong><small>Botol, bag, tray, kilogram, atau satuan lain.</small></label><label class="ingredient-wizard-choice ${ingredientWizard.purchaseMode === "LARGE" ? "is-selected" : ""}"><input type="radio" name="purchaseMode" value="LARGE" ${ingredientWizard.purchaseMode === "LARGE" ? "checked" : ""}><span aria-hidden="true">□</span><strong>Beli kemasan besar</strong><small>Karton atau dus yang berisi beberapa satuan kecil.</small></label></div>
        ${numbers.large ? `<div class="ingredient-wizard-grid"><label class="ingredient-wizard-field">Nama kemasan besar<input name="purchaseUnit" value="${escapeHtml(ingredientWizard.purchaseUnit)}" maxlength="30" placeholder="karton" required></label><label class="ingredient-wizard-field">Isi setiap kemasan<input name="innerUnitsPerPurchaseUnit" value="${escapeHtml(ingredientWizard.innerUnitsPerPurchaseUnit)}" type="number" min="0.000001" max="1000000000" step="0.000001" required></label><label class="ingredient-wizard-field">Satuan isi<input name="innerUnit" value="${escapeHtml(ingredientWizard.innerUnit)}" maxlength="30" placeholder="botol" required></label><label class="ingredient-wizard-field">Isi per satuan kecil (${escapeHtml(ingredientWizard.baseUnit)})<input name="baseUnitsPerInnerUnit" value="${escapeHtml(ingredientWizard.baseUnitsPerInnerUnit)}" type="number" min="0.000001" max="1000000000" step="0.000001" required></label></div>` : `<div class="ingredient-wizard-grid"><label class="ingredient-wizard-field">Dibeli sebagai<input name="purchaseUnit" value="${escapeHtml(ingredientWizard.purchaseUnit)}" maxlength="30" placeholder="botol, bag, tray" required></label><label class="ingredient-wizard-field">Isi per satuan (${escapeHtml(ingredientWizard.baseUnit)})<input name="baseUnitsPerPurchaseUnit" value="${escapeHtml(ingredientWizard.baseUnitsPerPurchaseUnit)}" type="number" min="0.000001" max="1000000000" step="0.000001" required><small>Contoh: satu botol berisi 1.000 ml.</small></label></div>`}
        <article class="ingredient-wizard-equation" aria-live="polite"><span>Konversi yang akan disimpan</span><strong data-wizard-conversion-copy>${escapeHtml(ingredientWizardConversionCopy())}</strong></article>
        <label class="ingredient-wizard-check ingredient-wizard-field-wide"><input name="packageVerified" type="checkbox" required ${ingredientWizard.packageVerified ? "checked" : ""}><span><strong>Saya sudah cocokkan isi kemasan dengan barang yang dibeli</strong><small>Jika angka contoh diubah, periksa dan centang ulang sebelum menyimpan.</small></span></label>
      </section>
      <section class="ingredient-wizard-panel" data-wizard-panel="4"  aria-labelledby="wizard-price-title"><p class="ingredient-wizard-kicker">Harga acuan</p><h2 id="wizard-price-title" tabindex="-1">Berapa harga belinya?</h2><p class="ingredient-wizard-lead">Harga boleh dikosongkan. Sistem akan menandainya “Biaya belum tersedia”, bukan Rp0.</p>
        <div class="ingredient-wizard-price-layout"><div class="ingredient-wizard-grid"><label class="ingredient-wizard-field">Harga per ${escapeHtml(ingredientWizard.purchaseUnit || "kemasan")}<span class="ingredient-wizard-money"><span>Rp</span><input name="referencePriceRupiah" value="${escapeHtml(ingredientWizard.referencePriceRupiah)}" type="number" min="1" max="1000000000" step="1" inputmode="numeric" placeholder="240000"></span></label><label class="ingredient-wizard-field">Supplier <small>(opsional)</small><input name="supplierName" value="${escapeHtml(ingredientWizard.supplierName)}" maxlength="80" placeholder="Contoh: Supplier Susu A"></label><label class="ingredient-wizard-check ingredient-wizard-field-wide"><input name="preferred" type="checkbox" ${ingredientWizard.preferred ? "checked" : ""}><span><strong>Jadikan pilihan pembelian utama</strong><small>Diprioritaskan saat mencatat barang masuk.</small></span></label></div>${ingredientWizardCostCard()}</div>
      </section>`}
      <section class="ingredient-wizard-panel" data-wizard-panel="5"  aria-labelledby="wizard-review-title"><p class="ingredient-wizard-kicker">Periksa sebelum simpan</p><h2 id="wizard-review-title" tabindex="-1">Apakah semuanya sudah benar?</h2><p class="ingredient-wizard-lead">Histori stok belum berubah. Bahan baru dipakai saat Anda menerima barang atau memasukkannya ke HPP.</p>${ownerIngredientWizardReview(data)}<p id="ingredient-wizard-status" class="form-status ingredient-wizard-status" role="status" aria-live="polite"></p></section>
      <footer class="ingredient-wizard-actions ingredient-editor-actions"><div><span>Draft dapat dilanjutkan dari perangkat ini.</span><p id="ingredient-wizard-footer-status" class="form-status ingredient-wizard-status" role="status" aria-live="polite"></p></div><button class="button button-ghost" type="button" data-ingredient-wizard-close>Simpan draft & tutup</button><button class="button button-primary" type="submit" data-ingredient-wizard-save ${inventoryMutationPending ? "disabled" : ""}>${inventoryMutationPending ? "Menyimpan…" : ingredientWizard.mode === "purchase-option" ? "Simpan pilihan" : "Simpan bahan"}</button></footer>
    </form>
  </section></dialog>`;
}

function ingredientWizardConversionCopy() {
  const { large, innerCount, totalBase } = ingredientWizardNumbers();
  return large ? `1 ${ingredientWizard.purchaseUnit || "kemasan"} = ${formatPlainNumber(innerCount)} ${ingredientWizard.innerUnit || "isi"} = ${formatPlainNumber(totalBase)} ${ingredientWizard.baseUnit}` : `1 ${ingredientWizard.purchaseUnit || "kemasan"} = ${formatPlainNumber(totalBase)} ${ingredientWizard.baseUnit}`;
}

function ingredientWizardCostCard() {
  const { large, innerCount, totalBase, price, unitCost } = ingredientWizardNumbers();
  return `<aside class="ingredient-wizard-cost" aria-label="Ringkasan perhitungan"><p>Hitungan otomatis</p><div><span>Total isi</span><strong data-wizard-total-base>${totalBase > 0 ? `${formatPlainNumber(totalBase)} ${escapeHtml(ingredientWizard.baseUnit)}` : "Lengkapi konversi"}</strong></div>${large ? `<div><span>Harga per ${escapeHtml(ingredientWizard.innerUnit || "satuan isi")}</span><strong data-wizard-inner-cost>${price != null && price > 0 && innerCount > 0 ? rupiah(price / innerCount) : "—"}</strong></div>` : ""}<div class="is-emphasis"><span>Biaya dasar</span><strong data-wizard-unit-cost>${unitCost == null ? "Biaya belum tersedia" : `${formatRupiahDecimal(unitCost)} / ${escapeHtml(ingredientWizard.baseUnit)}`}</strong></div><small>Harga aktual dan moving average diperbarui saat penerimaan Gudang.</small></aside>`;
}

function ownerIngredientWizardReview(data) {
  const category = ingredientWizardCategory(data);
  const categoryName = ingredientWizard.categoryId === "__custom__" ? ingredientWizard.customCategoryName : category?.name || ingredientWizard.categoryName;
  const { price, totalBase, unitCost } = ingredientWizardNumbers();
  const madeInHouse = ingredientWizard.sourcingMode === "MADE_IN_HOUSE";
  const ready = Boolean(ingredientWizard.name.trim() && (madeInHouse || ingredientWizard.packageVerified));
  const checks = [
    ["Identitas", `${ingredientWizard.name} · ${ingredientWizardCodePreview(data)}`],
    ["Kategori & satuan", `${categoryName || "Belum dipilih"} · ${ingredientWizard.baseUnit}`],
    ["Sumber bahan", madeInHouse ? "Dibuat sendiri · stok hasil produksi" : "Dibeli dari supplier"],
    ["Kemasan", madeInHouse ? "Tidak memakai pilihan pembelian" : ingredientWizardConversionCopy()],
    ["Harga acuan", madeInHouse ? "Dihitung dari bahan resep produksi" : price == null ? "Belum diisi — boleh dilengkapi nanti" : `${rupiah(price)} per ${ingredientWizard.purchaseUnit}`],
    ["Biaya dasar", madeInHouse ? "Terbentuk saat produksi batch selesai" : unitCost == null || totalBase <= 0 ? "Biaya belum tersedia" : `${formatRupiahDecimal(unitCost)} / ${ingredientWizard.baseUnit}`],
  ];
  return `<article class="ingredient-wizard-review" data-ingredient-review><div class="ingredient-wizard-review-mark ${ready ? "" : "is-pending"}" data-ingredient-review-mark aria-hidden="true">${ready ? "✓" : "!"}</div><dl>${checks.map(([label, value], index) => `<div><dt>${escapeHtml(label)}</dt><dd data-ingredient-review-value="${["identity", "category", "source", "package", "price", "cost"][index]}">${escapeHtml(value)}</dd></div>`).join("")}</dl><p><strong data-ingredient-review-state="package">${madeInHouse ? "Resep diatur setelah bahan disimpan" : ingredientWizard.packageVerified ? "Sudah diperiksa" : "Perlu diperiksa"}</strong>${madeInHouse ? " · bahan olahan belum menambah stok." : " · cocokkan isi kemasan dengan barang yang dibeli."}</p><p><strong>Setelah disimpan:</strong> bahan tersedia di Database, Gudang, dan HPP. ${madeInHouse ? "Atur resep olahan lalu catat produksi batch untuk membentuk stok dan biaya." : "Stok tetap nol sampai ada penerimaan."}</p></article>`;
}

function ownerIngredientWizardSuccess() {
  const result = ingredientWizard.result;
  const madeInHouse = result.sourcingMode === "MADE_IN_HOUSE";
  return `<section class="ingredient-wizard-shell ingredient-wizard-success" aria-labelledby="ingredient-success-title"><div class="ingredient-wizard-success-mark" aria-hidden="true">✓</div><p class="eyebrow">Bahan berhasil dibuat</p><h1 id="ingredient-success-title">${escapeHtml(result.name)} siap digunakan</h1><p><strong>${escapeHtml(result.code)}</strong> · ${escapeHtml(result.categoryName)} · satuan dasar ${escapeHtml(result.baseUnit)}. Pilih langkah berikutnya sesuai kebutuhan Anda.</p><div class="ingredient-wizard-success-actions">${madeInHouse ? `<button class="button button-primary" type="button" data-prep-recipe-open="${escapeHtml(result.ingredientId)}">Atur resep olahan</button>` : `<button class="button button-primary" type="button" data-ingredient-success="stock">Masukkan stok awal</button><button class="button button-ghost" type="button" data-ingredient-success="package">Tambah pilihan kemasan</button>`}<button class="button button-ghost" type="button" data-ingredient-success="next">Tambah bahan berikutnya</button><button class="button button-quiet" type="button" data-ingredient-success="database">Kembali ke database</button></div></section>`;
}

function ingredientStorageLabel(value) { return ({ AMBIENT: "suhu ruang", CHILLED: "dingin", FROZEN: "beku" })[value] || "sesuai kebutuhan"; }

function isPrepIngredient(item) {
  return item?.sourcingMode === "MADE_IN_HOUSE" || item?.materialType === "PREP_ITEM" || item?.itemType === "PREP_ITEM";
}

function productionRecipes(data = inventoryWorkspace.data) {
  const recipes = data?.productionRecipes ?? data?.ingredients?.productionRecipes ?? data?.production?.recipes ?? [];
  return Array.isArray(recipes) ? recipes : [];
}

function productionOrders(data = inventoryWorkspace.data) {
  const orders = data?.productionOrders ?? data?.production?.orders ?? [];
  return Array.isArray(orders) ? orders : [];
}

function prepRecipeFor(ingredientId, data = inventoryWorkspace.data) {
  return productionRecipes(data).find((recipe) => recipe.outputIngredientId === ingredientId || recipe.output?.ingredientId === ingredientId) ?? null;
}

function prepIngredientUnitCost(item) {
  const value = item?.currentAverageCostPerBaseUnitRupiah ?? item?.costPerUnitRupiah;
  return value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

function openPrepRecipeEditor(ingredientId) {
  const item = inventoryWorkspace.data?.ingredients?.items?.find((candidate) => candidate.id === ingredientId)
    ?? (ingredientWizard?.result?.ingredientId === ingredientId ? { id: ingredientId, name: ingredientWizard.result.name, baseUom: ingredientWizard.result.baseUnit, sourcingMode: "MADE_IN_HOUSE", materialType: "PREP_ITEM" } : null);
  if (!item || !isPrepIngredient(item)) { announce("Bahan olahan tidak ditemukan. Perbarui data lalu coba lagi.", true); return; }
  const recipe = prepRecipeFor(ingredientId);
  prepRecipeReturnId = ingredientId;
  prepRecipeEditor = {
    outputIngredientId: ingredientId,
    outputQuantityBase: String(recipe?.outputQuantityBase ?? recipe?.output?.quantityBase ?? 1000),
    yieldTolerancePct: String(Number(recipe?.yieldToleranceBps ?? 500) / 100),
    components: (recipe?.components?.length ? recipe.components : [{ ingredientId: "", quantityBase: "" }]).map((component) => ({
      ingredientId: component.ingredientId ?? component.itemId ?? "",
      quantityBase: String(component.quantityBase ?? component.quantity ?? ""),
    })),
    expectedVersion: Number(inventoryWorkspace.data?.revision ?? 0),
    reason: recipe ? "Memperbarui resep bahan olahan" : "Membuat resep bahan olahan",
    saving: false,
    dirty: false,
  };
  ingredientWizard = null;
  render();
  requestAnimationFrame(() => content.querySelector("#prep-recipe-title")?.focus());
}

function closePrepRecipeEditor() {
  if (prepRecipeEditor?.saving) return;
  if (prepRecipeEditor?.dirty && !window.confirm("Perubahan resep belum disimpan. Buang perubahan dan tutup?")) return;
  const returnId = prepRecipeReturnId;
  prepRecipeEditor = null;
  prepRecipeReturnId = null;
  render();
  requestAnimationFrame(() => content.querySelector(`[data-prep-recipe-open="${CSS.escape(returnId || "")}"]`)?.focus());
}

function collectPrepRecipeDraft(form) {
  if (!prepRecipeEditor || !form) return;
  const values = new FormData(form);
  prepRecipeEditor.outputQuantityBase = String(values.get("outputQuantityBase") ?? prepRecipeEditor.outputQuantityBase);
  prepRecipeEditor.yieldTolerancePct = String(values.get("yieldTolerancePct") ?? prepRecipeEditor.yieldTolerancePct);
  prepRecipeEditor.reason = String(values.get("reason") ?? prepRecipeEditor.reason);
  prepRecipeEditor.components = [...form.querySelectorAll("[data-prep-component-row]")].map((row, index) => ({
    ingredientId: String(values.get(`componentIngredientId:${index}`) ?? ""),
    quantityBase: String(values.get(`componentQuantityBase:${index}`) ?? ""),
  }));
}

function prepRecipeEstimate(editor = prepRecipeEditor) {
  const ingredients = inventoryWorkspace.data?.ingredients?.items ?? [];
  const outputQuantity = Number(editor?.outputQuantityBase);
  let complete = outputQuantity > 0;
  let totalCost = 0;
  const components = (editor?.components ?? []).map((line) => {
    const ingredient = ingredients.find((item) => item.id === line.ingredientId);
    const quantity = Number(line.quantityBase);
    const unitCost = prepIngredientUnitCost(ingredient);
    const cost = ingredient && quantity > 0 && unitCost != null ? quantity * unitCost : null;
    if (cost == null) complete = false;
    else totalCost += cost;
    return { ...line, ingredient, quantity, unitCost, cost };
  });
  return { outputQuantity, components, complete, totalCost, unitCost: complete && outputQuantity > 0 ? totalCost / outputQuantity : null };
}

function syncPrepRecipeReview(form) {
  if (!form || !prepRecipeEditor) return;
  const estimate = prepRecipeEstimate();
  const duplicateIds = prepRecipeEditor.components.map((item) => item.ingredientId).filter(Boolean).filter((id, index, ids) => ids.indexOf(id) !== index);
  form.querySelectorAll("[data-prep-component-row]").forEach((row, index) => {
    const line = estimate.components[index];
    const unit = row.querySelector("[data-prep-component-unit]");
    const cost = row.querySelector("[data-prep-component-cost]");
    if (unit) unit.textContent = line?.ingredient?.baseUom ?? "unit";
    if (cost) cost.textContent = line?.cost == null ? "Biaya belum tersedia" : rupiah(Math.round(line.cost));
  });
  const total = form.querySelector("[data-prep-review-total]");
  const outputQuantity = form.querySelector("[data-prep-review-output]");
  const unitCost = form.querySelector("[data-prep-review-unit-cost]");
  const tolerance = form.querySelector("[data-prep-review-tolerance]");
  const warning = form.querySelector("[data-prep-review-warning]");
  if (total) total.textContent = estimate.complete ? rupiah(Math.round(estimate.totalCost)) : "Belum dapat dihitung";
  if (outputQuantity) outputQuantity.textContent = formatInventoryQuantity(estimate.outputQuantity, (inventoryWorkspace.data?.ingredients?.items ?? []).find((item) => item.id === prepRecipeEditor.outputIngredientId)?.baseUom ?? "unit");
  if (unitCost) unitCost.textContent = estimate.unitCost == null ? "Belum dapat dihitung" : `${formatRupiahDecimal(estimate.unitCost)} / ${(inventoryWorkspace.data?.ingredients?.items ?? []).find((item) => item.id === prepRecipeEditor.outputIngredientId)?.baseUom ?? "unit"}`;
  if (tolerance) tolerance.textContent = `${formatPlainNumber(prepRecipeEditor.yieldTolerancePct)}% dari hasil rencana`;
  if (warning) warning.textContent = duplicateIds.length ? "Satu bahan dipilih lebih dari sekali. Gabungkan jumlahnya sebelum menyimpan." : estimate.complete ? "Simulasi memakai biaya komponen saat ini. Biaya aktual terbentuk saat batch selesai." : "Lengkapi komponen dan pastikan semua bahan mempunyai biaya.";
}

async function submitPrepRecipe(form) {
  collectPrepRecipeDraft(form);
  if (!form.reportValidity() || !prepRecipeEditor || prepRecipeEditor.saving) return;
  const ids = prepRecipeEditor.components.map((item) => item.ingredientId);
  if (new Set(ids).size !== ids.length) { const warning = form.querySelector("[data-prep-review-warning]"); if (warning) warning.textContent = "Satu bahan dipilih lebih dari sekali. Gabungkan jumlahnya sebelum menyimpan."; return; }
  prepRecipeEditor.saving = true;
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  const status = form.querySelector("[data-prep-recipe-status]");
  if (status) status.textContent = "Menyimpan resep olahan…";
  try {
    await requestHppAdminAction("hpp.production_recipe.upsert", {
      operationKey: inventoryOperationKey("prep-production-recipe"),
      outputIngredientId: prepRecipeEditor.outputIngredientId,
      outputQuantityBase: Number(prepRecipeEditor.outputQuantityBase),
      components: prepRecipeEditor.components.map((item) => ({ ingredientId: item.ingredientId, quantityBase: Number(item.quantityBase) })),
      yieldToleranceBps: Math.round(Number(prepRecipeEditor.yieldTolerancePct) * 100),
      expectedVersion: prepRecipeEditor.expectedVersion,
      reason: prepRecipeEditor.reason.trim(),
    });
    const returnId = prepRecipeEditor.outputIngredientId;
    prepRecipeEditor = null;
    prepRecipeReturnId = null;
    render();
    announce("Resep bahan olahan berhasil disimpan. Stok belum berubah.");
    requestAnimationFrame(() => content.querySelector(`[data-prep-recipe-open="${CSS.escape(returnId)}"]`)?.focus());
  } catch (error) {
    prepRecipeEditor.saving = false;
    if (button) button.disabled = false;
    if (status) status.textContent = error.message;
    announce(error.message, true);
  }
}

function ownerPrepRecipeDialog(data) {
  if (!prepRecipeEditor) return "";
  const output = data.ingredients?.items?.find((item) => item.id === prepRecipeEditor.outputIngredientId)
    ?? { id: prepRecipeEditor.outputIngredientId, name: ingredientWizard?.result?.name ?? "Bahan olahan", baseUom: ingredientWizard?.result?.baseUnit ?? "unit" };
  const ingredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE" && item.id !== output.id);
  const optionHtml = (selectedId) => ingredients.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.baseUom)}${prepIngredientUnitCost(item) == null ? " · biaya belum tersedia" : ` · ${formatRupiahDecimal(prepIngredientUnitCost(item))}/${escapeHtml(item.baseUom)}`}</option>`).join("");
  const rows = prepRecipeEditor.components.map((line, index) => `<article class="prep-component-row" data-prep-component-row="${index}"><div class="prep-component-heading"><strong>Komponen ${index + 1}</strong>${prepRecipeEditor.components.length > 1 ? `<button class="button button-quiet button-small" type="button" data-prep-component-remove="${index}" aria-label="Hapus komponen ${index + 1}">Hapus</button>` : ""}</div><div class="prep-component-fields"><label>Bahan<select name="componentIngredientId:${index}" required><option value="">Pilih dari Database Bahan</option>${optionHtml(line.ingredientId)}</select></label><label>Jumlah<input name="componentQuantityBase:${index}" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(line.quantityBase)}" required></label><p><span>Satuan</span><strong data-prep-component-unit>${escapeHtml(ingredients.find((item) => item.id === line.ingredientId)?.baseUom ?? "unit")}</strong></p><p><span>Estimasi biaya</span><strong data-prep-component-cost>Belum dapat dihitung</strong></p></div></article>`).join("");
  const estimate = prepRecipeEstimate();
  const impact = prepRecipeImpactSummary(output.id, data);
  return `<dialog id="prep-recipe-dialog" class="prep-dialog" aria-labelledby="prep-recipe-title"><form id="prep-recipe-form" class="prep-dialog-shell"><header class="prep-dialog-header"><div><p class="eyebrow">Database Bahan · bahan olahan</p><h1 id="prep-recipe-title" tabindex="-1">Atur resep ${escapeHtml(output.name)}</h1><p>Satu layar untuk komponen, hasil rencana, dan simulasi biaya. Menyimpan resep tidak menambah stok atau mempublikasikan HPP menu.</p></div><button class="ingredient-editor-dismiss" type="button" data-prep-recipe-close aria-label="Tutup resep olahan">×</button></header><div class="prep-dialog-grid"><section class="prep-form-pane" aria-labelledby="prep-recipe-form-title"><h2 id="prep-recipe-form-title">Formula produksi</h2><div class="prep-output-fields"><label>Hasil rencana<input name="outputQuantityBase" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(prepRecipeEditor.outputQuantityBase)}" required><small>${escapeHtml(output.baseUom)} per satu kali resep</small></label><label>Toleransi susut<input name="yieldTolerancePct" type="number" min="0" max="25" step="0.01" inputmode="decimal" value="${escapeHtml(prepRecipeEditor.yieldTolerancePct)}" required><small>Maksimal 25% dari hasil rencana</small></label></div><div class="prep-component-list">${rows}</div><button class="button button-ghost" type="button" data-prep-component-add>+ Tambah komponen</button><label class="prep-reason">Alasan perubahan<input name="reason" maxlength="160" value="${escapeHtml(prepRecipeEditor.reason)}" required></label></section><aside class="prep-review-pane" aria-labelledby="prep-recipe-review-title" aria-live="polite"><p class="eyebrow">Review langsung</p><h2 id="prep-recipe-review-title">Biaya resep</h2><dl><div><dt>Hasil rencana</dt><dd data-prep-review-output>${formatInventoryQuantity(estimate.outputQuantity, output.baseUom)}</dd></div><div><dt>Total biaya komponen</dt><dd data-prep-review-total>${estimate.complete ? rupiah(Math.round(estimate.totalCost)) : "Belum dapat dihitung"}</dd></div><div><dt>Estimasi biaya hasil</dt><dd data-prep-review-unit-cost>${estimate.unitCost == null ? "Belum dapat dihitung" : `${formatRupiahDecimal(estimate.unitCost)} / ${escapeHtml(output.baseUom)}`}</dd></div><div><dt>Batas susut</dt><dd data-prep-review-tolerance>${formatPlainNumber(prepRecipeEditor.yieldTolerancePct)}% dari hasil rencana</dd></div><div><dt>Batch pending versi lama</dt><dd>${impact.pendingOrders}</dd></div><div><dt>Dampak turunan</dt><dd>${impact.prepCount} bahan olahan · ${impact.menuCount} menu</dd></div></dl><p class="owner-card-note" data-prep-review-warning>${estimate.complete ? "Simulasi memakai biaya komponen saat ini. Biaya aktual terbentuk saat batch selesai." : "Lengkapi komponen dan pastikan semua bahan mempunyai biaya."}</p><div class="prep-review-guard"><strong>Jejak perubahan</strong><p>Batch pending tetap memakai snapshot resep lamanya. Dampak HPP turunan dihitung ulang oleh server setelah resep tersimpan.</p></div></aside></div><footer class="prep-dialog-actions"><p class="form-status" role="status" aria-live="polite" data-prep-recipe-status></p><button class="button button-ghost" type="button" data-prep-recipe-close>Batal</button><button class="button button-primary" type="submit" ${prepRecipeEditor.saving ? "disabled" : ""}>Simpan resep olahan</button></footer></form></dialog>`;
}

function prepRecipeImpactSummary(outputIngredientId, data = inventoryWorkspace.data) {
  const affected = new Set([outputIngredientId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of productionRecipes(data)) {
      const outputId = recipe.outputIngredientId ?? recipe.output?.ingredientId ?? recipe.output?.itemId;
      const usesAffected = (recipe.components ?? recipe.resolvedLines ?? []).some((line) => affected.has(line.ingredientId ?? line.itemId));
      if (outputId && usesAffected && !affected.has(outputId)) { affected.add(outputId); changed = true; }
    }
  }
  const menus = data?.hpp?.menus ?? [];
  const menuCount = menus.filter((menu) => [menu.draft?.items, menu.published?.items, menu.publishedRecipe?.items]
    .some((items) => Array.isArray(items) && items.some((line) => affected.has(line.ingredientId ?? line.itemId)))).length;
  const pendingOrders = productionOrders(data).filter((order) => order.status === "PLANNED"
    && (order.recipeSnapshot?.output?.itemId === outputIngredientId || order.outputIngredientId === outputIngredientId || order.plannedOutput?.itemId === outputIngredientId)).length;
  return { pendingOrders, prepCount: Math.max(0, affected.size - 1), menuCount };
}

function ownerIngredientArea(data) {
  const items = data.ingredients?.items ?? [];
  const categories = inventoryIngredientCategories(data);
  const editor = items.find((item) => item.id === inventoryEditorId) ?? null;
  const prepEditor = isPrepIngredient(editor);
  const costManaged = prepEditor || editor?.costSource === "PURCHASE_MOVING_AVERAGE";
  const ingredientForm = editor ? `<article class="dashboard-card inventory-master-card"><div class="section-heading"><div><p class="eyebrow">Edit master</p><h2>Edit ${escapeHtml(editor.name)}</h2><p class="card-subtitle">Identitas sistem tetap sama untuk Gudang dan HPP.</p></div><button class="button button-ghost" type="button" data-ingredient-edit-cancel>Batal edit</button></div>
    <form id="ingredient-master-form" class="inventory-master-form">${editor ? `<input type="hidden" name="ingredientId" value="${escapeHtml(editor.id)}">` : ""}
      <label for="ingredient-code">Kode bahan<input id="ingredient-code" name="code" value="${escapeHtml(editor?.sku ?? "")}" maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,39}" autocomplete="off" required><small>Contoh: MILK-UHT-01</small></label>
      <label for="ingredient-name">Nama bahan<input id="ingredient-name" name="name" value="${escapeHtml(editor?.name ?? "")}" maxlength="80" autocomplete="off" required></label>
      <label for="ingredient-source">Sumber bahan<select id="ingredient-source" name="sourcingMode" required><option value="PURCHASED" ${prepEditor ? "" : "selected"}>Dibeli dari supplier</option><option value="MADE_IN_HOUSE" ${prepEditor ? "selected" : ""}>Dibuat sendiri · bahan olahan</option></select><small>Bahan olahan membentuk stok melalui produksi batch.</small></label>
      <label for="ingredient-category">Kategori<select id="ingredient-category" name="category" required>${editor?.category && !categories.some((category) => category.name === editor.category) ? `<option value="${escapeHtml(editor.category)}" selected>${escapeHtml(editor.category)} · kategori lama</option>` : ""}${categories.map((category) => `<option value="${escapeHtml(category.name)}" ${editor?.category === category.name ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label>
      <label for="ingredient-base-uom">Satuan dasar<select id="ingredient-base-uom" name="baseUnit" required>${["gram", "ml", "pcs"].map((uom) => `<option value="${uom}" ${editor?.baseUom === uom ? "selected" : ""}>${uom}</option>`).join("")}</select><small>Setelah ada histori operasional, satuan ini terkunci.</small></label>
      <label for="ingredient-cost">Biaya per satuan (opsional)<input id="ingredient-cost" name="costPerUnitRupiah" type="number" min="0" max="10000000" step="0.000001" value="${escapeHtml(editor?.currentAverageCostPerBaseUnitRupiah ?? "")}" ${costManaged ? "readonly" : ""}><small>${prepEditor ? "Dikelola otomatis dari moving average hasil produksi batch." : costManaged ? "Dikelola otomatis dari rata-rata pembelian." : "Kosong akan tampil sebagai Belum ada biaya, bukan Rp0."}</small></label>
      <label class="inventory-checkbox"><input name="purchasable" type="checkbox" ${editor?.purchasable === false || prepEditor ? "" : "checked"} ${prepEditor ? "disabled" : ""}><span>Dapat dibeli dari supplier</span></label>
      <label>Pelacakan batch<select name="lotTrackingPolicy"><option value="NOT_REQUIRED" ${editor?.lotTrackingPolicy !== "REQUIRED" ? "selected" : ""}>Tidak wajib</option><option value="REQUIRED" ${editor?.lotTrackingPolicy === "REQUIRED" ? "selected" : ""}>Wajib batch & expiry</option></select></label>
      <label>Minimal masa simpan (hari)<input name="minimumShelfLifeDays" type="number" min="0" max="3650" step="1" value="${escapeHtml(editor?.minimumShelfLifeDays ?? 0)}"></label>
      <label class="inventory-form-wide" for="ingredient-reason">Alasan perubahan<input id="ingredient-reason" name="reason" maxlength="160" value="${editor ? "Memperbarui master bahan" : "Menambahkan master bahan"}" required></label>
      <div class="inventory-form-actions inventory-form-wide"><button class="button button-primary" type="submit" ${inventoryMutationPending ? "disabled" : ""}>Simpan perubahan</button><p id="inventory-mutation-status" class="form-status" role="status" aria-live="polite"></p></div>
    </form></article>` : `<article class="dashboard-card ingredient-wizard-entry"><div><p class="eyebrow">Database bahan</p><h2>Tambah dan cek bahan dalam satu layar</h2><p>Isi identitas, kemasan, dan harga. Review diperbarui langsung sebelum data disimpan.</p></div><div class="button-row"><button class="button button-primary" type="button" data-ingredient-wizard-open="new">+ Tambah bahan</button>${hasIngredientWizardDraft() ? '<button class="button button-ghost" type="button" data-ingredient-wizard-open="resume">Lanjutkan draft</button><button class="button button-quiet" type="button" data-ingredient-wizard-discard>Hapus draft</button>' : ""}</div></article>`;
  const purchaseOptions = data.ingredients?.purchaseOptions ?? [];
  const rows = items.map((item) => { const optionCount = purchaseOptions.filter((option) => option.ingredientId === item.id).length; const prep = isPrepIngredient(item); const recipe = prep ? prepRecipeFor(item.id, data) : null; return `<tr data-material-card="${escapeHtml(item.id)}"><th scope="row">${escapeHtml(item.name)}<small>${escapeHtml(item.sku || "Kode belum dilengkapi")} · ${escapeHtml(item.category || "Umum")} · ${prep ? `bahan olahan · stok hasil produksi${recipe ? ` · resep v${escapeHtml(recipe.version ?? 1)}` : " · resep belum diatur"}` : `${optionCount} pilihan beli`}</small></th><td data-label="Satuan dasar">${escapeHtml(item.baseUom)}</td><td data-label="Biaya rata-rata">${item.currentAverageCostPerBaseUnitRupiah == null ? "Belum ada" : `${formatRupiahDecimal(Number(item.currentAverageCostPerBaseUnitRupiah))} / ${escapeHtml(item.baseUom)}`}</td><td data-label="Status"><span class="status-badge ${item.status === "ARCHIVED" ? "is-muted" : prep && !recipe ? "is-warning" : item.costStatus === "PRICED" ? "is-ready" : "is-warning"}">${item.status === "ARCHIVED" ? "Diarsipkan" : prep && !recipe ? "Aktif · resep belum diatur" : prep ? "Aktif · bahan olahan" : item.costStatus === "PRICED" ? "Aktif · ada biaya" : "Aktif · biaya kosong"}</span></td><td data-label="Aksi"><div class="inventory-row-actions">${prep ? `<button class="button button-primary" type="button" data-prep-recipe-open="${escapeHtml(item.id)}" ${item.status === "ARCHIVED" ? "disabled" : ""}>${recipe ? "Edit resep olahan" : "Atur resep olahan"}</button>` : `<button class="button button-ghost" type="button" data-ingredient-price-impact="${escapeHtml(item.id)}" aria-label="Riwayat harga dan dampak margin ${escapeHtml(item.name)}">Riwayat & dampak</button>`}<button class="button button-ghost" type="button" data-ingredient-edit="${escapeHtml(item.id)}" ${item.status === "ARCHIVED" ? "disabled" : ""}>Edit bahan</button><button class="button button-danger" type="button" data-ingredient-archive="${escapeHtml(item.id)}" ${item.status === "ARCHIVED" ? "disabled" : ""}>Arsipkan</button></div></td></tr>`; }).join("");
  const list = items.length ? `<article class="dashboard-card"><div class="section-heading"><div><h2>Database bahan</h2><p class="card-subtitle">Identitas kanonik yang dipakai Gudang serta resep HPP.</p></div><span class="status-badge is-ready">${items.length} bahan</span></div><div class="dashboard-table inventory-material-table" role="region" aria-label="Daftar bahan" tabindex="0"><table><thead><tr><th scope="col">Bahan</th><th scope="col">Satuan dasar</th><th scope="col">Biaya rata-rata</th><th scope="col">Status</th><th scope="col">Aksi</th></tr></thead><tbody>${rows}</tbody></table></div></article>` : `<article class="dashboard-card inventory-empty"><span aria-hidden="true">DB</span><div><h2>Database bahan masih kosong</h2><p>Isi form di atas untuk membuat bahan pertama. Harga boleh dikosongkan dan akan ditandai jelas.</p></div></article>`;
  const activeItems = items.filter((item) => item.status === "ACTIVE");
  const ingredientOptions = activeItems.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.baseUom)}</option>`).join("");
  const conversions = data.ingredients?.conversions ?? [];
  const packages = data.ingredients?.supplierPackages ?? [];
  const unitTools = activeItems.length ? `<details class="inventory-advanced-tools"><summary>Pengaturan lanjutan & data lama</summary><p>Gunakan hanya untuk referensi kemasan lama. Bahan baru sebaiknya ditambah melalui form utama agar konversinya dihitung otomatis.</p><section class="inventory-tool-grid">
    <article class="dashboard-card"><div class="section-heading"><div><h2>Konversi satuan</h2><p class="card-subtitle">Buat rantai seperti karton → botol → ml. Versi lama tetap tersimpan.</p></div><span class="status-badge ${conversions.length ? "is-ready" : "is-warning"}">${conversions.length} aturan</span></div><form id="ingredient-conversion-form" class="inventory-compact-form"><label>Bahan<select name="ingredientId" required>${ingredientOptions}</select></label><label>Satuan asal<input name="fromUom" placeholder="carton" maxlength="30" required></label><label>Satuan tujuan<input name="toUom" placeholder="bottle" maxlength="30" required></label><label>1 asal =<input name="factor" type="number" min="0.000001" max="1000000000" step="0.000001" placeholder="12" required></label><label class="inventory-form-wide">Alasan<input name="reason" maxlength="160" value="Menambahkan konversi satuan bahan" required></label><button class="button button-primary" type="submit">Simpan konversi</button></form>${conversions.length ? `<ul class="inventory-reference-list">${conversions.map((item) => `<li><span>${escapeHtml(items.find((candidate) => candidate.id === item.ingredientId)?.name || "Bahan")}</span><strong>1 ${escapeHtml(item.fromUom)} = ${escapeHtml(item.factor)} ${escapeHtml(item.toUom)}</strong><small>versi ${escapeHtml(item.sequence)}</small></li>`).join("")}</ul>` : '<p class="owner-card-note">Konversi kg → gram dan liter → ml tersedia sebagai standar. Tambahkan kemasan khusus bisnis di sini.</p>'}</article>
    <article class="dashboard-card"><div class="section-heading"><div><h2>Pilihan pembelian</h2><p class="card-subtitle">Referensi pembelian; tidak pernah mengganti identitas bahan atau menambah stok.</p></div><span class="status-badge ${packages.length ? "is-ready" : "is-warning"}">${packages.length} pilihan</span></div><form id="ingredient-package-form" class="inventory-compact-form"><label>Bahan<select name="ingredientId" required>${ingredientOptions}</select></label><label>Supplier<input name="supplierName" maxlength="80" required></label><label>Nama kemasan<input name="packageLabel" maxlength="80" placeholder="Karton 12 botol" required></label><label>Satuan beli<input name="purchaseUom" maxlength="30" placeholder="carton" required></label><label>Isi per kemasan<input name="quantityPerPackage" type="number" min="0.000001" max="1000000000" step="0.000001" placeholder="12" required></label><label>Barcode (opsional)<input name="barcode" maxlength="80"></label><label class="inventory-form-wide">Alasan<input name="reason" maxlength="160" value="Menambahkan referensi kemasan supplier" required></label><button class="button button-primary" type="submit">Simpan kemasan lama</button></form>${packages.length ? `<ul class="inventory-reference-list">${packages.map((item) => item.purchaseOptionId ? `<li><span>${escapeHtml(item.supplierName || "Supplier belum dipilih")}</span><strong>${escapeHtml(item.label)}${item.preferred ? " · utama" : ""}</strong><small>1 ${escapeHtml(item.purchaseUnit)} = ${escapeHtml(item.baseUnitsPerPurchaseUnit)} ${escapeHtml(items.find((candidate) => candidate.id === item.ingredientId)?.baseUom || "unit")} · ${item.referencePriceRupiah == null ? "biaya belum tersedia" : `${rupiah(item.referencePriceRupiah)} acuan`}</small></li>` : `<li><span>${escapeHtml(item.supplierName)}</span><strong>${escapeHtml(item.packageLabel)}</strong><small>${escapeHtml(item.quantityPerPackage)} ${escapeHtml(item.purchaseUom)} · ${escapeHtml(items.find((candidate) => candidate.id === item.ingredientId)?.name || "Bahan")}</small></li>`).join("")}</ul>` : ""}</article>
  </section></details>` : "";
  const dialog = `<dialog id="ingredient-archive-dialog" class="inventory-confirm-dialog" aria-labelledby="ingredient-archive-title"><form id="ingredient-archive-form"><input type="hidden" name="ingredientId"><p class="eyebrow">Arsip, bukan hapus</p><h2 id="ingredient-archive-title">Arsipkan <span data-archive-name></span>?</h2><p>Bahan hanya dapat diarsipkan bila belum memiliki stok, transaksi, atau resep. Histori tidak akan dihapus.</p><label>Alasan<input name="reason" maxlength="160" value="Mengarsipkan bahan yang tidak digunakan" required></label><div class="button-row"><button class="button button-ghost" type="button" value="cancel" data-dialog-close>Batal</button><button class="button button-danger" type="submit">Ya, arsipkan</button></div></form></dialog>`;
  return `${ingredientForm}${list}${unitTools}${dialog}${ingredientWizard ? ownerIngredientWizard(data) : ""}${ingredientPriceImpact ? ownerIngredientPriceImpactDialog(data) : ""}${prepRecipeEditor ? ownerPrepRecipeDialog(data) : ""}`;
}

function defaultIngredientPriceMonth() {
  const businessDate = String(snapshot?.dashboard?.businessDate ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return businessDate.slice(0, 7);
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date()).slice(0, 7);
}

function defaultIngredientPriceEffectiveDate() {
  const businessDate = String(snapshot?.dashboard?.businessDate ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return businessDate;
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date());
}

function closeIngredientPriceImpact() {
  const returnId = ingredientPriceImpactReturnId;
  ingredientPriceImpact = null;
  ingredientPriceImpactReturnId = null;
  render();
  requestAnimationFrame(() => content.querySelector(`[data-ingredient-price-impact="${CSS.escape(returnId || "")}"]`)?.focus());
}

async function loadIngredientPriceImpact({ focus = "results", renderLoading = true, append = false } = {}) {
  if (!ingredientPriceImpact) return;
  const ingredientId = ingredientPriceImpact.ingredientId;
  const filters = { ...ingredientPriceImpact.filters };
  const previousData = ingredientPriceImpact.data;
  const cursor = append ? previousData?.page?.nextCursor : null;
  if (append && !cursor) return;
  if (renderLoading) {
    ingredientPriceImpact = { ...ingredientPriceImpact, status: "loading", error: null };
    render();
  }
  try {
    const data = await requestIngredientPriceImpact({ ingredientId, ...filters, cursor });
    if (!ingredientPriceImpact || ingredientPriceImpact.ingredientId !== ingredientId) return;
    const merged = append && previousData
      ? { ...data, history: [...previousData.history, ...data.history] }
      : data;
    ingredientPriceImpact = { ...ingredientPriceImpact, status: "ready", data: merged, error: null, filters };
  } catch (error) {
    if (!ingredientPriceImpact || ingredientPriceImpact.ingredientId !== ingredientId) return;
    ingredientPriceImpact = { ...ingredientPriceImpact, status: "error", data: null, error: error.message || "Riwayat harga belum dapat dimuat." };
  }
  render();
  requestAnimationFrame(() => content.querySelector(focus === "heading" ? "#ingredient-price-impact-title" : "#ingredient-price-impact-results")?.focus());
}

async function requestIngredientPriceImpact({ ingredientId, month, supplier, source, cursor = null }) {
  const params = new URLSearchParams({ ingredientId, month, supplier, source, limit: "50" });
  if (cursor) params.set("cursor", cursor);
  try {
    const result = await request(`/api/operator/inventory/ingredient-price-impact?${params}`);
    return normalizeIngredientPriceImpact(result?.data ?? result?.priceImpact ?? result, inventoryWorkspace.data, { ingredientId, month, supplier, source });
  } catch (error) {
    if (error.status !== 404) throw error;
    return buildLocalIngredientPriceImpact(inventoryWorkspace.data, { ingredientId, month, supplier, source });
  }
}

async function submitIngredientPriceReference(form) {
  if (!ingredientPriceImpact || ingredientPriceImpact.saving) return;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  const button = form.querySelector("button[type=submit]");
  const status = form.querySelector("[data-price-reference-status]");
  ingredientPriceImpact.saving = true;
  if (button) button.disabled = true;
  if (status) status.textContent = "Menyimpan harga acuan…";
  try {
    const reason = String(values.get("reason") ?? "").trim();
    const result = await request("/api/operator/inventory-actions", {
      method: "POST", csrf: true,
      body: {
        action: "ingredient.reference-price.record",
        expectedRevision: inventoryWorkspace.data.revision,
        reason,
        payload: {
          operationKey: inventoryOperationKey("ingredient-reference-price"),
          purchaseOptionId: String(values.get("purchaseOptionId") ?? ""),
          referencePriceRupiah: Number(values.get("referencePriceRupiah")),
          effectiveAt: ingredientPriceEffectiveAt(values.get("effectiveAt")),
        },
      },
    });
    csrfToken = result.csrfToken || csrfToken;
    if (result.workspace) inventoryWorkspace = { status: "ready", data: result.workspace, error: null, stale: false };
    ingredientPriceImpact.referenceFormOpen = false;
    ingredientPriceImpact.saving = false;
    ingredientPriceImpact.filters = { ...ingredientPriceImpact.filters, source: "REFERENCE_PRICE" };
    await loadIngredientPriceImpact({ focus: "results" });
    announce("Harga acuan tersimpan. Timeline dan simulasi sudah diperbarui.");
  } catch (error) {
    ingredientPriceImpact.saving = false;
    if (button) button.disabled = false;
    if (status) status.textContent = error.message;
    announce(error.message, true);
  }
}

function normalizeIngredientPriceImpact(raw, workspace, filters) {
  const source = raw && typeof raw === "object" ? raw : {};
  const localIngredient = workspace?.ingredients?.items?.find((item) => item.id === filters.ingredientId) ?? {};
  const sourceIngredient = source.ingredient ?? {};
  const ingredient = {
    ...localIngredient,
    ...sourceIngredient,
    baseUom: sourceIngredient.baseUom ?? sourceIngredient.baseUnit ?? localIngredient.baseUom ?? localIngredient.baseUnit,
  };
  const history = (source.history ?? source.timeline ?? []).map((item, index) => ({
    id: item.id ?? `history-${index}`,
    occurredAt: item.timestamp ?? item.effectiveAt ?? item.occurredAt ?? item.date ?? null,
    supplierName: item.supplierName ?? item.supplier ?? "Supplier belum dicatat",
    packageLabel: item.packageLabel ?? item.packageSnapshot?.label ?? item.purchaseUnitLabel ?? item.label ?? "Kemasan tidak dicatat",
    baseQuantity: ingredientPriceNumber(item.actualBaseQuantity ?? item.baseQuantity ?? item.packageSnapshot?.baseUnitsPerPurchaseUnit ?? item.quantityBase),
    totalCostRupiah: ingredientPriceNumber(item.actualTotalCostRupiah ?? item.totalCostRupiah ?? item.referencePriceRupiah ?? item.totalRupiah),
    unitCostRupiah: ingredientPriceNumber(item.unitCostRupiah ?? item.unitCostPerBaseUnitRupiah ?? item.normalizedUnitCostRupiah),
    deltaRupiah: ingredientPriceNumber(item.deltaRupiah ?? item.unitCostDeltaRupiah),
    deltaPct: ingredientPriceNumber(item.deltaPct ?? item.changePct),
    source: item.source ?? filters.source,
    productId: item.productId ?? null,
    menuName: item.menuName ?? null,
    reason: item.reason ?? null,
    previousSellingPriceRupiah: ingredientPriceNumber(item.previousSellingPriceRupiah),
    nextSellingPriceRupiah: ingredientPriceNumber(item.nextSellingPriceRupiah),
    hppRupiahUnchanged: ingredientPriceNumber(item.hppRupiahUnchanged),
    previousMarginPct: ingredientPriceNumber(item.previousMarginPct),
    nextMarginPct: ingredientPriceNumber(item.nextMarginPct),
  })).sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")));
  const priceHistory = history.filter((item) => item.source !== "PRODUCT_SELLING_PRICE" && item.unitCostRupiah != null);
  const chronologicalPrices = priceHistory.slice().sort((a, b) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")));
  chronologicalPrices.forEach((item, index) => {
    const previous = chronologicalPrices[index - 1]?.unitCostRupiah ?? null;
    item.deltaRupiah = previous == null ? null : item.unitCostRupiah - previous;
    item.deltaPct = previous > 0 ? ((item.unitCostRupiah - previous) / previous) * 100 : null;
  });
  const comparisons = (source.supplierComparison ?? source.suppliers ?? []).map((item) => ({
    supplierName: item.supplierName ?? item.name ?? "Supplier belum dicatat",
    receiptCount: Number(item.eventCount ?? item.receiptCount ?? item.sampleCount ?? 0),
    latestUnitCostRupiah: ingredientPriceNumber(item.latestUnitCostPerBaseUnitRupiah ?? item.latestUnitCostRupiah ?? item.latestPriceRupiah),
    weightedAverageUnitCostRupiah: ingredientPriceNumber(item.weightedUnitCostRupiah ?? item.weightedAverageUnitCostRupiah ?? item.averageUnitCostRupiah),
    lowestUnitCostRupiah: ingredientPriceNumber(item.minUnitCostRupiah ?? item.lowestUnitCostRupiah),
    highestUnitCostRupiah: ingredientPriceNumber(item.maxUnitCostRupiah ?? item.highestUnitCostRupiah),
    differenceVsLowestRupiah: ingredientPriceNumber(item.diffFromCheapestRupiah ?? item.differenceVsLowestRupiah),
    differenceVsLowestPct: ingredientPriceNumber(item.diffFromCheapestPct ?? item.differenceVsLowestPct),
    monthly: (item.monthly ?? []).map((period) => ({
      month: period.month,
      eventCount: Number(period.eventCount ?? 0),
      cumulativeChangePct: ingredientPriceNumber(period.cumulativeChangePct),
    })),
  }));
  const impacts = (source.menuImpacts ?? source.impacts ?? []).map((item) => {
    const baselineHppRupiah = ingredientPriceNumber(item.baselineHppRupiah ?? item.currentBook?.hppRupiah ?? item.currentHppRupiah ?? item.publishedHppRupiah);
    const simulatedHppRupiah = ingredientPriceNumber(item.simulatedHppRupiah ?? item.referenceScenario?.hppRupiah ?? item.projectedHppRupiah);
    const baselineMarginPct = ingredientPriceNumber(item.baselineMarginPct ?? item.currentBook?.marginPct ?? item.currentMarginPct);
    const simulatedMarginPct = ingredientPriceNumber(item.simulatedMarginPct ?? item.referenceScenario?.marginPct ?? item.projectedMarginPct);
    return {
      productId: item.productId ?? item.menuId ?? "",
      menuName: item.menuName ?? item.productName ?? "Menu",
      menuStatus: item.menuStatus ?? null,
      status: item.status ?? null,
      publishedVersion: item.publishedVersion ?? item.recipeVersion ?? null,
      sellingPriceVersion: item.sellingPriceVersion ?? item.productPriceVersion ?? null,
      sellingPriceEffectiveAt: item.sellingPriceEffectiveAt ?? item.productPriceEffectiveAt ?? null,
      sellingPriceRupiah: ingredientPriceNumber(item.sellingPriceRupiah ?? item.currentSellingPriceRupiah),
      baselineHppRupiah,
      simulatedHppRupiah,
      baselineMarginPct,
      simulatedMarginPct,
      deltaHppRupiah: ingredientPriceNumber(item.deltaHppRupiah ?? (baselineHppRupiah != null && simulatedHppRupiah != null ? simulatedHppRupiah - baselineHppRupiah : null)),
      deltaHppPct: ingredientPriceNumber(item.deltaHppPct ?? (baselineHppRupiah > 0 && simulatedHppRupiah != null ? ((simulatedHppRupiah - baselineHppRupiah) / baselineHppRupiah) * 100 : null)),
      marginDeltaPp: ingredientPriceNumber(item.marginDeltaPp ?? item.marginChangePp ?? (baselineMarginPct != null && simulatedMarginPct != null ? simulatedMarginPct - baselineMarginPct : null)),
      ingredientEffectiveQuantity: ingredientPriceNumber(item.ingredientEffectiveQuantity ?? item.effectiveQuantityBase ?? item.quantityBase),
      baselineUnitCostRupiah: ingredientPriceNumber(item.baselineUnitCostRupiah ?? item.baselineUnitCost ?? item.publishedUnitCostRupiah ?? ingredient.currentBookUnitCostRupiah ?? ingredient.costPerUnitRupiah),
      changesBookCost: source.summary?.changesBookCost ?? null,
    };
  });
  const alerts = (source.alerts ?? []).map((item, index) => normalizeIngredientPriceAlert(item, index));
  const availableSuppliers = [...new Set([
    ...(source.filters?.availableSuppliers ?? source.availableSuppliers ?? []).map((item) => typeof item === "string" ? item : item.name ?? item.supplierName),
    ...history.map((item) => item.supplierName),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
  const summary = source.summary ?? {};
  const latestUnitCostRupiah = ingredientPriceNumber(summary.latestUnitCostRupiah ?? summary.latestActualUnitCostRupiah ?? priceHistory[0]?.unitCostRupiah);
  const previousUnitCostRupiah = ingredientPriceNumber(summary.previousUnitCostRupiah ?? summary.baselineUnitCostRupiah ?? priceHistory[1]?.unitCostRupiah);
  return {
    ingredient,
    filters: { ...filters, availableSuppliers },
    summary: {
      latestUnitCostRupiah,
      previousUnitCostRupiah,
      deltaRupiah: ingredientPriceNumber(summary.deltaRupiah ?? summary.changeRupiah ?? (latestUnitCostRupiah != null && previousUnitCostRupiah != null ? latestUnitCostRupiah - previousUnitCostRupiah : null)),
      deltaPct: ingredientPriceNumber(summary.deltaPct ?? summary.changePct ?? (latestUnitCostRupiah != null && previousUnitCostRupiah > 0 ? ((latestUnitCostRupiah - previousUnitCostRupiah) / previousUnitCostRupiah) * 100 : null)),
      currentAverageCostRupiah: ingredientPriceNumber(summary.currentAverageCostRupiah ?? ingredient.currentAverageCostPerBaseUnitRupiah ?? ingredient.currentBookUnitCostRupiah ?? ingredient.costPerUnitRupiah),
      sampleCount: Number(summary.eventCount ?? summary.sampleCount ?? history.length),
      changesBookCost: summary.changesBookCost ?? null,
    },
    history,
    supplierComparison: comparisons,
    menuImpacts: impacts,
    alerts,
    completeHistory: source.completeHistory !== false,
    page: {
      limit: Number(source.page?.limit ?? history.length),
      nextCursor: source.page?.nextCursor ?? null,
      total: Number(source.page?.total ?? history.length),
    },
    note: source.note ?? null,
  };
}

function normalizeIngredientPriceAlert(item, index) {
  const code = item.code ?? item.type ?? `ALERT_${index + 1}`;
  const configured = {
    PRICE_INCREASE_HIGH: {
      title: "Kenaikan harga acuan tinggi",
      message: `Harga acuan naik ${formatPercent(item.increasePct ?? 0)}%: ${rupiah(item.baselinePriceRupiah ?? 0)} → ${rupiah(item.nextPriceRupiah ?? 0)}.`,
      recommendation: "Pertimbangkan evaluasi supplier dan dampak menu.",
    },
    FREQUENT_CHANGES: {
      title: "Harga sering berubah",
      message: `${Number(item.changeCount ?? 0)} perubahan tercatat pada ${item.month || "bulan ini"}.`,
      recommendation: "Pertimbangkan konfirmasi daftar harga supplier.",
    },
    MARGIN_BELOW_TARGET: {
      title: `Margin ${item.menuName || "menu"} di bawah target`,
      message: `${formatPercent(item.marginPct ?? 0)}% dibanding target ${formatPercent(item.targetMarginPct ?? 0)}%.`,
      recommendation: "Pertimbangkan evaluasi harga jual atau resep.",
    },
    SUPPLIER_ABOVE_CHEAPEST: {
      title: `${item.supplierName || "Supplier"} lebih mahal`,
      message: `${formatPercent(item.premiumPct ?? 0)}% di atas ${item.cheapestSupplierName || "supplier termurah"}.`,
      recommendation: "Pertimbangkan evaluasi supplier sebelum pembelian berikutnya.",
    },
  }[code] ?? {};
  const severityValue = String(item.severity ?? "INFO").toUpperCase();
  return {
    code,
    title: item.title ?? item.label ?? configured.title ?? "Perlu ditinjau",
    message: item.message ?? item.description ?? configured.message ?? "Periksa perubahan harga dan dampaknya sebelum mengambil keputusan.",
    recommendation: item.recommendation ?? item.actionText ?? configured.recommendation ?? "Pertimbangkan evaluasi supplier dan resep terkait.",
    severity: ["HIGH", "WARNING", "INFO"].includes(severityValue) ? severityValue : "INFO",
  };
}

function buildLocalIngredientPriceImpact(workspace, filters) {
  const ingredient = workspace?.ingredients?.items?.find((item) => item.id === filters.ingredientId) ?? {};
  const actual = (workspace?.warehouse?.recentReceipts ?? []).flatMap((receipt) => (receipt.lines ?? [])
    .filter((line) => line.ingredientId === filters.ingredientId && Number(line.baseQuantity) > 0 && Number(line.totalCostRupiah) > 0)
    .map((line) => ({
      id: `${receipt.id}:${line.ingredientId}`, occurredAt: receipt.receivedAt, supplierName: receipt.supplierName || "Supplier belum dicatat",
      packageLabel: line.packageLabel ?? line.purchaseUnitLabel ?? "Penerimaan aktual", baseQuantity: Number(line.baseQuantity), totalCostRupiah: Number(line.totalCostRupiah),
      unitCostRupiah: Number(line.totalCostRupiah) / Number(line.baseQuantity), source: "ACTUAL_RECEIPT",
    })));
  const reference = (workspace?.ingredients?.purchaseOptionHistory ?? workspace?.ingredients?.purchaseOptions ?? [])
    .filter((item) => item.ingredientId === filters.ingredientId && item.referencePriceRupiah != null && Number(item.baseUnitsPerPurchaseUnit) > 0)
    .map((item) => ({
      id: item.id ?? `${item.purchaseOptionId}:${item.sequence}`, occurredAt: item.createdAt ?? null, supplierName: item.supplierName || "Supplier belum dicatat",
      packageLabel: item.label || item.packageLabel || "Harga acuan", baseQuantity: Number(item.baseUnitsPerPurchaseUnit), totalCostRupiah: Number(item.referencePriceRupiah),
      unitCostRupiah: Number(item.referencePriceRupiah) / Number(item.baseUnitsPerPurchaseUnit), source: "REFERENCE_PRICE",
    }));
  const allRows = (filters.source === "REFERENCE_PRICE" ? reference : filters.source === "PRODUCT_SELLING_PRICE" ? [] : actual)
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
  const monthRows = allRows.filter((item) => !item.occurredAt || String(item.occurredAt).slice(0, 7) === filters.month)
    .filter((item) => filters.supplier === "ALL" || item.supplierName === filters.supplier);
  monthRows.forEach((item, index) => {
    const prior = index ? monthRows[index - 1].unitCostRupiah : null;
    item.deltaRupiah = prior == null ? null : item.unitCostRupiah - prior;
    item.deltaPct = prior > 0 ? ((item.unitCostRupiah - prior) / prior) * 100 : null;
  });
  const history = monthRows.slice().reverse();
  const supplierGroups = new Map();
  for (const row of monthRows) {
    const group = supplierGroups.get(row.supplierName) ?? [];
    group.push(row); supplierGroups.set(row.supplierName, group);
  }
  const weighted = [...supplierGroups.entries()].map(([supplierName, rows]) => {
    const totalBase = rows.reduce((sum, row) => sum + row.baseQuantity, 0);
    const totalCost = rows.reduce((sum, row) => sum + row.totalCostRupiah, 0);
    return { supplierName, receiptCount: rows.length, latestUnitCostRupiah: rows.at(-1)?.unitCostRupiah ?? null, weightedAverageUnitCostRupiah: totalBase > 0 ? totalCost / totalBase : null, lowestUnitCostRupiah: Math.min(...rows.map((row) => row.unitCostRupiah)), highestUnitCostRupiah: Math.max(...rows.map((row) => row.unitCostRupiah)) };
  }).sort((a, b) => (a.weightedAverageUnitCostRupiah ?? Infinity) - (b.weightedAverageUnitCostRupiah ?? Infinity));
  const cheapest = weighted[0]?.weightedAverageUnitCostRupiah ?? null;
  weighted.forEach((item) => { item.differenceVsLowestRupiah = cheapest == null ? null : item.weightedAverageUnitCostRupiah - cheapest; item.differenceVsLowestPct = cheapest > 0 ? (item.differenceVsLowestRupiah / cheapest) * 100 : null; });
  const latest = history[0]?.unitCostRupiah ?? null;
  const previous = history[1]?.unitCostRupiah ?? null;
  const menuImpacts = (workspace?.hpp?.menus ?? []).flatMap((menu) => {
    const published = menu.latestPublished;
    const line = published?.items?.find((item) => item.ingredientId === filters.ingredientId);
    if (!published || !line) return [];
    const baselineHpp = Number(published.hppRupiahSnapshot);
    const selling = Number(published.sellingPriceRupiahSnapshot ?? menu.sellingPriceRupiah);
    const oldContribution = Number(line.costRupiahSnapshot);
    const oldUnitCost = Number(line.unitCostRupiahSnapshot);
    const quantity = oldUnitCost > 0 ? oldContribution / oldUnitCost : null;
    const simulated = latest != null && quantity != null ? baselineHpp - oldContribution + quantity * latest : null;
    return [{
      productId: menu.productId, menuName: menu.menuName, publishedVersion: published.version, sellingPriceRupiah: selling,
      baselineHppRupiah: baselineHpp, simulatedHppRupiah: simulated, baselineMarginPct: selling > 0 ? ((selling - baselineHpp) / selling) * 100 : null,
      simulatedMarginPct: selling > 0 && simulated != null ? ((selling - simulated) / selling) * 100 : null,
      deltaHppRupiah: simulated == null ? null : simulated - baselineHpp, deltaHppPct: baselineHpp > 0 && simulated != null ? ((simulated - baselineHpp) / baselineHpp) * 100 : null,
      marginDeltaPp: selling > 0 && simulated != null ? (((selling - simulated) / selling) - ((selling - baselineHpp) / selling)) * 100 : null,
      ingredientEffectiveQuantity: quantity, baselineUnitCostRupiah: oldUnitCost,
    }];
  }).sort((a, b) => (a.marginDeltaPp ?? 0) - (b.marginDeltaPp ?? 0));
  return normalizeIngredientPriceImpact({
    ingredient,
    history,
    supplierComparison: weighted,
    menuImpacts,
    completeHistory: false,
    note: "Fallback memakai data workspace terbaru. Histori bulanan lengkap menunggu endpoint server.",
    filters: { availableSuppliers: [...new Set([...actual, ...reference].map((item) => item.supplierName))] },
    summary: {
      latestUnitCostRupiah: latest, previousUnitCostRupiah: previous,
      deltaRupiah: latest != null && previous != null ? latest - previous : null,
      deltaPct: latest != null && previous > 0 ? ((latest - previous) / previous) * 100 : null,
      currentAverageCostRupiah: ingredient.currentAverageCostPerBaseUnitRupiah,
      sampleCount: history.length,
    },
  }, workspace, filters);
}

function ownerIngredientPriceImpactDialog(workspace) {
  const state = ingredientPriceImpact;
  const ingredient = workspace.ingredients?.items?.find((item) => item.id === state.ingredientId) ?? state.data?.ingredient ?? {};
  const title = `Riwayat harga & dampak ${ingredient.name || "bahan"}`;
  let body;
  if (state.status === "loading") {
    body = `<section class="price-impact-state" aria-busy="true"><span class="price-impact-loader" aria-hidden="true"></span><h3>Memuat riwayat harga</h3><p>Menyiapkan harga aktual, pembanding supplier, dan simulasi margin menu.</p></section>`;
  } else if (state.status === "error") {
    body = `<section class="price-impact-state is-error" role="alert"><span aria-hidden="true">!</span><h3>Riwayat harga belum dapat dimuat</h3><p>${escapeHtml(state.error)}</p><button class="button button-primary" type="button" data-ingredient-price-impact-retry>Coba lagi</button></section>`;
  } else {
    body = ownerIngredientPriceImpactReady(state.data, workspace);
  }
  return `<dialog id="ingredient-price-impact-dialog" class="ingredient-price-impact-dialog" aria-labelledby="ingredient-price-impact-title" aria-describedby="ingredient-price-impact-description"><article class="price-impact-shell"><header class="price-impact-header"><div><p class="eyebrow">Database bahan · analisis Owner</p><h2 id="ingredient-price-impact-title" tabindex="-1">${escapeHtml(title)}</h2><p id="ingredient-price-impact-description">Bandingkan harga per ${escapeHtml(ingredient.baseUom || "satuan dasar")} dan lihat simulasi HPP. Tidak ada stok, HPP published, atau harga jual yang berubah otomatis.</p></div><button class="price-impact-dismiss" type="button" data-ingredient-price-impact-close aria-label="Tutup riwayat harga">×</button></header>${body}</article></dialog>`;
}

function ownerIngredientPriceImpactReady(data, workspace) {
  const { ingredient, filters, summary, history, supplierComparison, menuImpacts, alerts } = data;
  const supplierOptions = filters.availableSuppliers.map((name) => `<option value="${escapeHtml(name)}" ${filters.supplier === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const previousLabel = summary.previousUnitCostRupiah == null ? "Belum ada pembanding" : ingredientUnitCost(summary.previousUnitCostRupiah, ingredient.baseUom);
  const deltaLabel = summary.deltaRupiah == null || summary.deltaPct == null ? "N/A · data belum cukup" : `${signedIngredientUnitCost(summary.deltaRupiah, ingredient.baseUom)} · ${signedPercent(summary.deltaPct)}`;
  const moreHistory = data.page?.nextCursor ? `<div class="price-history-more"><button class="button button-ghost" type="button" data-ingredient-price-impact-more>Muat riwayat berikutnya</button><small>${history.length} dari ${data.page.total} data ditampilkan</small></div>` : "";
  const historyContent = history.length ? `<ol class="price-history-list">${history.map((item) => ownerIngredientPriceHistoryRow(item, ingredient)).join("")}</ol>${moreHistory}` : `<div class="price-impact-empty"><span aria-hidden="true">↔</span><h4>Belum ada harga pada filter ini</h4><p>Pilih bulan, supplier, atau sumber harga lain. Nilai kosong tidak dihitung sebagai Rp0.</p></div>`;
  const comparisonContent = supplierComparison.length ? `<div class="supplier-price-grid">${supplierComparison.map((item) => { const period = item.monthly?.find((entry) => entry.month === filters.month); return `<article class="supplier-price-card"><div><span>${item.differenceVsLowestPct === 0 ? "Harga terendah" : `${item.receiptCount} data`}</span><h4>${escapeHtml(item.supplierName)}</h4></div><dl><div><dt>Rata-rata tertimbang</dt><dd>${ingredientUnitCost(item.weightedAverageUnitCostRupiah, ingredient.baseUom)}</dd></div><div><dt>Harga terakhir</dt><dd>${ingredientUnitCost(item.latestUnitCostRupiah, ingredient.baseUom)}</dd></div><div><dt>Perubahan kumulatif</dt><dd>${period?.cumulativeChangePct == null ? "N/A" : signedPercent(period.cumulativeChangePct)} · ${period?.eventCount ?? item.receiptCount} data</dd></div><div><dt>Rentang</dt><dd>${item.lowestUnitCostRupiah == null ? "N/A" : `${ingredientUnitCost(item.lowestUnitCostRupiah, ingredient.baseUom)} – ${ingredientUnitCost(item.highestUnitCostRupiah, ingredient.baseUom)}`}</dd></div><div><dt>Vs termurah</dt><dd>${item.differenceVsLowestPct == null ? "N/A" : `${signedIngredientUnitCost(item.differenceVsLowestRupiah, ingredient.baseUom)} · ${signedPercent(item.differenceVsLowestPct)}`}</dd></div></dl></article>`; }).join("")}</div>` : `<div class="price-impact-empty compact"><h4>Perbandingan supplier belum tersedia</h4><p>Butuh minimal satu harga valid dari supplier pada bulan yang dipilih.</p></div>`;
  const impacts = menuImpacts.length ? menuImpacts.map((item) => ownerIngredientMenuImpactCard(item, ingredient)).join("") : `<div class="price-impact-empty"><span aria-hidden="true">HPP</span><h4>Belum ada menu terdampak</h4><p>Bahan ini belum ada dalam resep published, atau kontrak dampak belum menyediakan data lengkap.</p></div>`;
  const alertPanel = alerts.length ? `<aside class="price-impact-alerts" aria-label="Rekomendasi operasional">${alerts.map((item) => `<article class="is-${item.severity.toLowerCase()}"><span aria-hidden="true">${item.severity === "HIGH" ? "!" : "i"}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.recommendation)}</small></div></article>`).join("")}</aside>` : "";
  const purchaseOptions = (workspace.ingredients?.purchaseOptions ?? []).filter((item) => item.ingredientId === ingredient.id);
  const referenceEditor = ownerIngredientReferencePriceForm(data, purchaseOptions);
  return `<form id="ingredient-price-impact-filter" class="price-impact-filter"><label>Bulan<input name="month" type="month" value="${escapeHtml(filters.month)}" required></label><label>Supplier<select name="supplier"><option value="ALL">Semua supplier</option>${supplierOptions}</select></label><label>Sumber harga<select name="source"><option value="ACTUAL_RECEIPT" ${filters.source === "ACTUAL_RECEIPT" ? "selected" : ""}>Harga beli aktual</option><option value="REFERENCE_PRICE" ${filters.source === "REFERENCE_PRICE" ? "selected" : ""}>Harga acuan</option><option value="PRODUCT_SELLING_PRICE" ${filters.source === "PRODUCT_SELLING_PRICE" ? "selected" : ""}>Harga jual menu</option></select></label><button class="button button-primary" type="submit">Terapkan filter</button></form><section id="ingredient-price-impact-results" class="price-impact-results" tabindex="-1" aria-live="polite"><div class="price-impact-summary"><article><span>Harga terbaru</span><strong>${ingredientUnitCost(summary.latestUnitCostRupiah, ingredient.baseUom)}</strong><small>${escapeHtml(ingredientPriceSourceLabel(filters.source))}</small></article><article><span>Harga pembanding</span><strong>${previousLabel}</strong><small>Data sebelumnya pada filter</small></article><article><span>Perubahan</span><strong>${deltaLabel}</strong><small>(baru − pembanding) ÷ pembanding</small></article><article><span>Biaya rata-rata stok</span><strong>${ingredientUnitCost(summary.currentAverageCostRupiah, ingredient.baseUom)}</strong><small>MWA saat ini · berbeda dari harga acuan</small></article></div>${data.note ? `<p class="price-impact-note"><strong>Catatan data:</strong> ${escapeHtml(data.note)}</p>` : ""}${alertPanel}<div class="price-impact-actions"><div><strong>Harga acuan pembelian</strong><p>Mencatat referensi baru tidak menambah stok dan tidak mempublikasikan ulang HPP.</p></div>${purchaseOptions.length ? `<button class="button button-primary" type="button" data-ingredient-price-reference-open ${ingredientPriceImpact.referenceFormOpen ? "hidden" : ""}>Catat harga acuan baru</button>` : `<span class="status-badge is-warning">Pilihan pembelian belum tersedia</span>`}</div>${referenceEditor}<div class="price-impact-workspace"><div class="price-impact-main"><section class="price-impact-section"><div class="price-impact-section-heading"><div><p class="eyebrow">Timeline</p><h3>Riwayat ${escapeHtml(ingredientPriceSourceLabel(filters.source).toLowerCase())}</h3></div><span class="status-badge">${summary.sampleCount} data</span></div>${historyContent}</section><section class="price-impact-section"><div class="price-impact-section-heading"><div><p class="eyebrow">Supplier</p><h3>Perbandingan harga ternormalisasi</h3></div></div><p class="price-impact-explainer">Rata-rata tertimbang memakai total biaya ÷ total ${escapeHtml(ingredient.baseUom)}. Kemasan berbeda tetap dibandingkan pada satuan dasar yang sama.</p>${comparisonContent}</section></div><aside class="price-impact-menu-panel" aria-labelledby="price-impact-menu-title"><div><p class="eyebrow">Simulasi · tidak menyimpan</p><h3 id="price-impact-menu-title">Dampak HPP & margin menu</h3><p>Margin berubah ditulis dalam poin persentase (pp). Published version tetap utuh sampai Owner membuat dan mempublikasikan revisi HPP.</p></div><div class="price-impact-menu-list">${impacts}</div></aside></div></section>`;
}

function ownerIngredientPriceHistoryRow(item, ingredient) {
  if (item.source === "PRODUCT_SELLING_PRICE") {
    const priceChange = item.previousSellingPriceRupiah == null || item.nextSellingPriceRupiah == null ? "Harga jual tidak tersedia" : `${rupiah(item.previousSellingPriceRupiah)} → ${rupiah(item.nextSellingPriceRupiah)}`;
    const marginChange = item.previousMarginPct == null || item.nextMarginPct == null ? "Margin belum dapat dihitung" : `Margin ${formatPercent(item.previousMarginPct)}% → ${formatPercent(item.nextMarginPct)}% (${signedPp(item.nextMarginPct - item.previousMarginPct)})`;
    return `<li><time datetime="${escapeHtml(item.occurredAt || "")}">${escapeHtml(ingredientPriceDate(item.occurredAt))}</time><div><strong>${escapeHtml(item.menuName || "Menu")}</strong><span>${escapeHtml(item.reason || "Perubahan harga jual")}${item.hppRupiahUnchanged == null ? "" : ` · simulasi dengan HPP saat ini ${rupiah(item.hppRupiahUnchanged)}`}</span></div><div><strong>${priceChange}</strong><span>${marginChange}</span></div></li>`;
  }
  return `<li><time datetime="${escapeHtml(item.occurredAt || "")}">${escapeHtml(ingredientPriceDate(item.occurredAt))}</time><div><strong>${escapeHtml(item.supplierName)}</strong><span>${escapeHtml(item.packageLabel)} · ${item.baseQuantity == null ? "Kuantitas tidak tersedia" : `${formatPlainNumber(item.baseQuantity)} ${escapeHtml(ingredient.baseUom)}`}</span></div><div><strong>${ingredientUnitCost(item.unitCostRupiah, ingredient.baseUom)}</strong><span>${item.deltaPct == null ? "Pembanding belum tersedia" : `${signedIngredientUnitCost(item.deltaRupiah, ingredient.baseUom)} · ${signedPercent(item.deltaPct)}`}</span></div></li>`;
}

function ingredientPriceSourceLabel(source) {
  return ({ ACTUAL_RECEIPT: "Harga beli aktual", REFERENCE_PRICE: "Harga acuan", PRODUCT_SELLING_PRICE: "Harga jual menu" })[source] ?? "Riwayat harga";
}

function signedPp(value) {
  if (value == null) return "N/A";
  return `${value > 0 ? "naik" : value < 0 ? "turun" : "tetap"} ${formatAbsolutePercent(value)} pp`;
}

function ownerIngredientReferencePriceForm(data, purchaseOptions) {
  if (!ingredientPriceImpact.referenceFormOpen || !purchaseOptions.length) return "";
  const optionRows = purchaseOptions.map((item) => `<option value="${escapeHtml(item.purchaseOptionId || item.id)}" data-base-quantity="${escapeHtml(item.baseUnitsPerPurchaseUnit)}" data-purchase-unit="${escapeHtml(item.purchaseUnit)}" data-current-price="${item.referencePriceRupiah == null ? "" : escapeHtml(item.referencePriceRupiah)}">${escapeHtml(item.label)} · ${escapeHtml(item.supplierName || "Supplier belum dipilih")}</option>`).join("");
  const impacts = data.menuImpacts.map((item) => `<article data-price-simulation-menu data-quantity-base="${item.ingredientEffectiveQuantity == null ? "" : escapeHtml(item.ingredientEffectiveQuantity)}" data-baseline-unit-cost="${item.baselineUnitCostRupiah == null ? "" : escapeHtml(item.baselineUnitCostRupiah)}" data-baseline-hpp="${item.baselineHppRupiah == null ? "" : escapeHtml(item.baselineHppRupiah)}" data-selling-price="${item.sellingPriceRupiah == null ? "" : escapeHtml(item.sellingPriceRupiah)}"><strong>${escapeHtml(item.menuName)}</strong><span data-price-simulation-hpp>HPP menunggu harga</span><span data-price-simulation-margin>Margin menunggu harga</span></article>`).join("");
  return `<section class="price-reference-editor" aria-labelledby="price-reference-title"><div class="price-impact-section-heading"><div><p class="eyebrow">Input perubahan harga</p><h3 id="price-reference-title">Catat harga acuan baru</h3><p>Harga ini menjadi referensi pembelian. Biaya rata-rata stok baru berubah saat penerimaan aktual.</p></div><button class="button button-ghost" type="button" data-ingredient-price-reference-cancel>Batal</button></div><form id="ingredient-price-reference-form"><div class="price-reference-fields"><label>Pilihan pembelian<select name="purchaseOptionId" required>${optionRows}</select></label><label>Harga acuan baru (Rp)<input name="referencePriceRupiah" type="number" min="1" max="1000000000" step="1" inputmode="numeric" required></label><label>Tanggal efektif<input name="effectiveAt" type="date" value="${escapeHtml(defaultIngredientPriceEffectiveDate())}" required></label><label class="price-reference-reason">Alasan perubahan<input name="reason" minlength="5" maxlength="160" placeholder="Contoh: Daftar harga supplier September" required></label></div><div class="price-reference-preview"><div><span>Biaya dasar hasil konversi</span><strong data-price-reference-unit-cost>Isi harga untuk melihat simulasi</strong><small>Simulasi ini bukan MWA dan tidak mengubah stok.</small></div><div class="price-reference-menu-preview">${impacts || "<p>Belum ada resep published yang memakai bahan ini.</p>"}</div></div><p class="form-status" role="status" aria-live="polite" data-price-reference-status></p><div class="price-reference-footer"><button class="button button-ghost" type="button" data-ingredient-price-reference-cancel>Batal</button><button class="button button-primary" type="submit" ${ingredientPriceImpact.saving ? "disabled" : ""}>${ingredientPriceImpact.saving ? "Menyimpan…" : "Simpan harga acuan"}</button></div></form></section>`;
}

function ownerIngredientMenuImpactCard(item, ingredient) {
  const hppDelta = item.deltaHppRupiah == null || item.deltaHppPct == null ? "N/A" : `${formatSignedRupiah(Math.round(item.deltaHppRupiah))} · ${signedPercent(item.deltaHppPct)}`;
  const marginDelta = item.marginDeltaPp == null ? "N/A" : `${item.marginDeltaPp > 0 ? "Naik" : item.marginDeltaPp < 0 ? "Turun" : "Tetap"} ${formatAbsolutePercent(item.marginDeltaPp)} pp`;
  const tone = item.marginDeltaPp == null ? "is-muted" : item.marginDeltaPp < 0 ? "is-warning" : "is-ready";
  const sellingContext = item.sellingPriceVersion || item.sellingPriceEffectiveAt ? `${item.sellingPriceVersion ? `Harga jual v${escapeHtml(item.sellingPriceVersion)}` : "Harga jual"}${item.sellingPriceEffectiveAt ? ` · ${escapeHtml(ingredientPriceDate(item.sellingPriceEffectiveAt))}` : ""}` : "Harga jual saat ini";
  return `<article class="price-impact-menu-card" data-menu-impact="${escapeHtml(item.productId)}"><div class="price-impact-menu-heading"><div><h4>${escapeHtml(item.menuName)}</h4><span>${escapeHtml(sellingContext)} · ${item.sellingPriceRupiah == null ? "N/A" : rupiah(item.sellingPriceRupiah)}${item.publishedVersion ? ` · HPP published v${escapeHtml(item.publishedVersion)}` : ""}</span></div><span class="status-badge ${tone}">${escapeHtml(marginDelta)}</span></div><dl><div><dt>HPP</dt><dd>${item.baselineHppRupiah == null ? "N/A" : rupiah(item.baselineHppRupiah)} → ${item.simulatedHppRupiah == null ? "N/A" : rupiah(Math.round(item.simulatedHppRupiah))}</dd></div><div><dt>Perubahan HPP</dt><dd>${escapeHtml(hppDelta)}</dd></div><div><dt>Margin kotor</dt><dd>${item.baselineMarginPct == null ? "N/A" : `${formatPercent(item.baselineMarginPct)}%`} → ${item.simulatedMarginPct == null ? "N/A" : `${formatPercent(item.simulatedMarginPct)}%`}</dd></div><div><dt>Pemakaian ${escapeHtml(ingredient.baseUom || "bahan")}</dt><dd>${item.ingredientEffectiveQuantity == null ? "Tidak tersedia" : formatPlainNumber(item.ingredientEffectiveQuantity)}</dd></div></dl><a class="button button-ghost" href="#inventory/hpp">Buka HPP menu</a></article>`;
}

function syncIngredientPriceSimulation(form) {
  if (!form) return;
  const option = form.elements.purchaseOptionId?.selectedOptions?.[0];
  const price = Number(form.elements.referencePriceRupiah?.value);
  const baseQuantity = Number(option?.dataset.baseQuantity);
  const unitCost = price > 0 && baseQuantity > 0 ? price / baseQuantity : null;
  const baseUnit = ingredientPriceImpact?.data?.ingredient?.baseUom || "satuan dasar";
  const unitLabel = form.querySelector("[data-price-reference-unit-cost]");
  if (unitLabel) unitLabel.textContent = unitCost == null ? "Isi harga untuk melihat simulasi" : `${formatRupiahDecimal(unitCost)} / ${baseUnit}`;
  form.querySelectorAll("[data-price-simulation-menu]").forEach((card) => {
    const quantity = Number(card.dataset.quantityBase);
    const baselineUnit = Number(card.dataset.baselineUnitCost);
    const baselineHpp = Number(card.dataset.baselineHpp);
    const selling = Number(card.dataset.sellingPrice);
    const complete = unitCost != null && quantity >= 0 && baselineUnit > 0 && baselineHpp >= 0 && selling > 0;
    const nextHpp = complete ? baselineHpp + quantity * (unitCost - baselineUnit) : null;
    const nextMargin = nextHpp == null ? null : ((selling - nextHpp) / selling) * 100;
    const baselineMargin = selling > 0 && baselineHpp >= 0 ? ((selling - baselineHpp) / selling) * 100 : null;
    const hpp = card.querySelector("[data-price-simulation-hpp]");
    const margin = card.querySelector("[data-price-simulation-margin]");
    if (hpp) hpp.textContent = nextHpp == null ? "HPP belum dapat disimulasikan" : `HPP ${rupiah(Math.round(baselineHpp))} → ${rupiah(Math.round(nextHpp))}`;
    if (margin) margin.textContent = nextMargin == null || baselineMargin == null ? "Margin belum dapat disimulasikan" : `Margin ${formatPercent(baselineMargin)}% → ${formatPercent(nextMargin)}% (${nextMargin - baselineMargin >= 0 ? "naik" : "turun"} ${formatAbsolutePercent(nextMargin - baselineMargin)} pp)`;
  });
}

function ingredientPriceNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ingredientPriceEffectiveAt(value) {
  const date = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000+07:00`).toISOString() : date;
}

function ingredientUnitCost(value, unit) { return value == null ? "Belum tersedia" : `${formatRupiahDecimal(value)} / ${escapeHtml(unit || "unit")}`; }
function signedIngredientUnitCost(value, unit) { return value == null ? "N/A" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatRupiahDecimal(Math.abs(value))} / ${escapeHtml(unit || "unit")}`; }
function formatPercent(value) { return new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(value)); }
function formatAbsolutePercent(value) { return formatPercent(Math.abs(Number(value))); }
function signedPercent(value) { return value == null ? "N/A" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatAbsolutePercent(value)}%`; }
function ingredientPriceDate(value) {
  if (!value) return "Tanggal belum tersedia";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }).format(date);
}

function minimumStockPolicy(ingredientId) {
  return (replenishmentState.data?.policies ?? []).find((policy) => policy.itemId === ingredientId) ?? null;
}

function minimumStockThreshold(policy) {
  if (!policy) return null;
  if (policy.mode === "REORDER_POINT") return Number(policy.reorderPoint);
  if (policy.mode === "MIN_MAX") return Number(policy.minimum);
  if (policy.mode === "PAR") return Number(policy.par);
  return null;
}

function minimumStockStatus(ingredient, balance) {
  if (replenishmentState.status === "loading") return { label: "Memuat status", tone: "warning", threshold: null };
  if (replenishmentState.status === "error") return { label: "Status belum tersedia", tone: "warning", threshold: null };
  const policy = minimumStockPolicy(ingredient.id);
  const threshold = minimumStockThreshold(policy);
  if (!policy || !Number.isFinite(threshold)) return { label: "Belum diatur", tone: "warning", threshold: null };
  const available = Number(balance?.availableBase ?? 0);
  return available <= threshold
    ? { label: "Perlu beli", tone: "blocked", threshold }
    : { label: "Stok aman", tone: "ready", threshold };
}

function minimumStockAttemptKey(ingredientId) {
  const organization = snapshot?.context?.organizationId || "organization";
  const outlet = snapshot?.context?.outletId || "outlet";
  const storageKey = `sagapos:minimum-stock:${organization}:${outlet}:${ingredientId}`;
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) return stored;
    const created = inventoryOperationKey("owner-minimum-stock");
    sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return inventoryOperationKey("owner-minimum-stock");
  }
}

function clearMinimumStockAttemptKey(ingredientId) {
  const organization = snapshot?.context?.organizationId || "organization";
  const outlet = snapshot?.context?.outletId || "outlet";
  try { sessionStorage.removeItem(`sagapos:minimum-stock:${organization}:${outlet}:${ingredientId}`); }
  catch { /* In-memory retry protection remains available for the current submit. */ }
}

function minimumStockDialog(data) {
  if (!minimumStockEditorId) return "";
  const ingredient = (data.ingredients?.items ?? []).find((item) => item.id === minimumStockEditorId && item.status === "ACTIVE");
  if (!ingredient) return "";
  const balance = (data.warehouse?.balances ?? []).find((item) => item.ingredientId === ingredient.id);
  const policy = minimumStockPolicy(ingredient.id);
  const threshold = minimumStockThreshold(policy);
  return `<dialog id="minimum-stock-dialog" class="inventory-confirm-dialog minimum-stock-dialog" aria-labelledby="minimum-stock-title"><form id="minimum-stock-form"><input type="hidden" name="itemId" value="${escapeHtml(ingredient.id)}"><input type="hidden" name="operationKey" value="${escapeHtml(minimumStockAttemptKey(ingredient.id))}"><p class="eyebrow">Pengingat pembelian</p><h2 id="minimum-stock-title">Atur minimum ${escapeHtml(ingredient.name)}</h2><dl class="minimum-stock-current"><div><dt>Satuan dasar</dt><dd>${escapeHtml(ingredient.baseUom)}</dd></div><div><dt>Stok tersedia</dt><dd>${balance ? formatInventoryQuantity(balance.availableBase ?? 0, ingredient.baseUom) : "Belum ada saldo"}</dd></div></dl><label>Stok minimum<input name="reorderPoint" type="number" min="1" max="1000000000" step="1" inputmode="numeric" value="${threshold == null ? "" : escapeHtml(threshold)}" required><small>Sistem menandai Perlu beli saat stok tersedia sama atau di bawah angka ini.</small></label><label>Alasan perubahan<input name="reason" maxlength="160" value="Menetapkan minimum stok operasional" required></label><p id="minimum-stock-status" class="form-status" role="status" aria-live="polite">${escapeHtml(replenishmentState.error || "")}</p><div class="button-row"><button class="button button-ghost" type="button" data-minimum-stock-cancel>Batal</button><button class="button button-primary" type="submit" ${minimumStockPending ? "disabled" : ""}>Simpan minimum</button></div></form></dialog>`;
}

function warehousePurchasePriority(data) {
  if (replenishmentState.status === "loading" || replenishmentState.status === "idle") {
    return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-loading" data-purchase-priority-state="loading" aria-busy="true"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>Memeriksa prioritas belanja…</h2><p class="card-subtitle">Mencocokkan stok tersedia dengan minimum setiap bahan.</p></div></div></article>`;
  }
  if (replenishmentState.status === "error") {
    return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-warning" data-purchase-priority-state="error"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>Prioritas belum dapat diperiksa</h2><p class="card-subtitle">Aturan minimum stok tidak dapat dimuat. Perbarui data sebelum mengambil keputusan pembelian.</p></div><button class="button button-ghost" type="button" data-purchase-priority-retry>Coba lagi</button></div></article>`;
  }
  const ingredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE");
  if (!ingredients.length) {
    return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-warning" data-purchase-priority-state="unset"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>Belum ada bahan aktif</h2><p class="card-subtitle">Tambahkan bahan agar minimum stok dan prioritas belanja dapat digunakan.</p></div><a class="button button-primary" href="#inventory/database">Tambah bahan</a></div></article>`;
  }
  const balances = data.warehouse?.balances ?? [];
  const purchaseOptions = data.ingredients?.purchaseOptions ?? [];
  const rows = ingredients.map((ingredient) => {
    const balance = balances.find((item) => item.ingredientId === ingredient.id) ?? null;
    const threshold = minimumStockThreshold(minimumStockPolicy(ingredient.id));
    const available = balance ? Number(balance.availableBase) : 0;
    const preferred = purchaseOptions.filter((option) => option.ingredientId === ingredient.id && option.preferred === true);
    return { ingredient, balance, threshold, available, preferred: preferred.length === 1 ? preferred[0] : null };
  });
  const needsBuy = rows.filter((item) => Number.isFinite(item.threshold) && item.available <= item.threshold)
    .sort((a, b) => (a.available / Math.max(a.threshold, 1)) - (b.available / Math.max(b.threshold, 1)) || a.ingredient.name.localeCompare(b.ingredient.name, "id"));
  const unsetCount = rows.filter((item) => !Number.isFinite(item.threshold)).length;
  if (!needsBuy.length && unsetCount) {
    const firstUnset = rows.find((item) => !Number.isFinite(item.threshold));
    return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-warning" data-purchase-priority-state="unset"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>Minimum stok belum lengkap</h2><p class="card-subtitle">${unsetCount} bahan belum memiliki batas minimum, jadi status aman belum dapat dipastikan.</p></div><button class="button button-ghost" type="button" data-purchase-priority-minimum="${escapeHtml(firstUnset?.ingredient.id || "")}">Atur minimum</button></div></article>`;
  }
  if (!needsBuy.length) {
    return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-safe" data-purchase-priority-state="safe"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>Semua stok di atas minimum</h2><p class="card-subtitle">Tidak ada bahan yang perlu ditindak berdasarkan stok tersedia saat ini.</p></div><span class="status-badge is-ready" role="status" aria-live="polite">Semua aman</span></div></article>`;
  }
  const items = needsBuy.map(({ ingredient, balance, threshold, available, preferred }) => {
    const availability = balance ? `Tersedia ${formatInventoryQuantity(available, ingredient.baseUom)} · minimum ${formatInventoryQuantity(threshold, ingredient.baseUom)}` : `Belum pernah menerima stok · minimum ${formatInventoryQuantity(threshold, ingredient.baseUom)}`;
    const packageState = !preferred ? "missing-preferred" : preferred.referencePriceRupiah == null ? "missing-price" : !preferred.supplierName ? "missing-supplier" : "ready";
    const packageDetail = preferred
      ? `<p data-purchase-priority-package-state="${packageState}"><strong>${escapeHtml(preferred.label)}</strong> · 1 ${escapeHtml(preferred.purchaseUnit)} = ${formatInventoryQuantity(preferred.baseUnitsPerPurchaseUnit, ingredient.baseUom)}<br>${escapeHtml(preferred.supplierName || "Supplier belum diisi")} · ${preferred.referencePriceRupiah == null ? "Harga acuan belum diisi" : `Acuan ${rupiah(preferred.referencePriceRupiah)} per ${escapeHtml(preferred.purchaseUnit)}`}</p>`
      : `<p data-purchase-priority-package-state="missing-preferred">Kemasan pembelian utama belum diatur. Saga tidak menebak kemasan, supplier, harga, atau jumlah beli.</p>`;
    const action = preferred
      ? `<button class="button button-primary" type="button" data-purchase-priority-receive="${escapeHtml(preferred.purchaseOptionId || preferred.id)}" aria-label="Catat barang datang untuk ${escapeHtml(ingredient.name)}">Catat barang datang</button>`
      : `<button class="button button-ghost" type="button" data-purchase-priority-package="${escapeHtml(ingredient.id)}" aria-label="Atur kemasan utama untuk ${escapeHtml(ingredient.name)}">Atur kemasan utama</button>`;
    return `<li data-purchase-priority-item="${escapeHtml(ingredient.id)}"><div><h3>${escapeHtml(ingredient.name)}</h3><p data-purchase-priority-availability>${escapeHtml(availability)}</p>${packageDetail}</div>${action}</li>`;
  }).join("");
  const uncertainty = unsetCount ? `<p class="warehouse-purchase-priority-note">${unsetCount} bahan lain belum memiliki minimum.</p>` : "";
  return `<article id="warehouse-purchase-priority" class="dashboard-card warehouse-purchase-priority is-needs-buy" data-purchase-priority-state="needs-buy"><div class="section-heading"><div><p class="eyebrow">Prioritas belanja</p><h2>${needsBuy.length} bahan perlu dibeli</h2><p class="card-subtitle">Gunakan kemasan utama sebagai referensi lalu masukkan jumlah dan invoice yang benar-benar datang.</p></div><span class="status-badge is-blocked" role="status" aria-live="polite">Perlu tindakan</span></div>${uncertainty}<ul class="warehouse-purchase-priority-list">${items}</ul></article>`;
}

function prepDefaultDateTime() {
  const value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
  return value.slice(0, 16);
}

function prepDefaultExpiryDate(minimumDays = 1, from = new Date()) {
  const date = new Date(from.getTime() - from.getTimezoneOffset() * 60000);
  date.setDate(date.getDate() + Math.max(1, Number(minimumDays) || 1));
  return date.toISOString().slice(0, 10);
}

function productionExecutions(data = inventoryWorkspace.data) {
  const executions = data?.productionExecutions ?? data?.production?.executions ?? [];
  return Array.isArray(executions) ? executions : [];
}

function prepProductionRecipe(dialog = prepProductionDialog) {
  if (dialog?.recipeSnapshot) {
    const snapshot = dialog.recipeSnapshot;
    return {
      id: snapshot.recipeId,
      version: snapshot.recipeVersion,
      outputQuantityBase: snapshot.output?.quantity,
      output: snapshot.output,
      components: (snapshot.resolvedLines ?? []).map((line) => ({ ingredientId: line.itemId, quantityBase: line.normalizedQuantity, uom: line.normalizedUom })),
      yieldToleranceBps: dialog.yieldToleranceBps ?? 0,
      snapshot: true,
    };
  }
  return prepRecipeFor(dialog?.outputIngredientId);
}

function prepProductionMessage(error) {
  const messages = {
    production_revision_conflict: "Batch berubah di perangkat lain. Muat ulang data sebelum melanjutkan.",
    production_inventory_shortage: "Stok tersedia tidak cukup setelah memperhitungkan reservasi pesanan.",
    production_reserved_stock_conflict: "Sebagian stok sudah dialokasikan untuk pesanan. Kurangi batch atau tambah stok.",
    production_output_above_plan: "Hasil aktual melewati batas resep. Periksa pengukuran atau buat rencana baru.",
    production_output_yield_invalid: "Hasil aktual berada di luar toleransi resep.",
    production_measured_input_variance: "Pemakaian aktual berada di luar batas resep. Periksa takaran dan alasan produksi.",
    production_output_lot_conflict: "Kode lot sudah digunakan. Gunakan kode lot unik untuk batch ini.",
    production_output_lot_invalid: "Format kode lot tidak valid. Gunakan huruf, angka, titik, garis bawah, titik dua, atau tanda minus.",
    production_output_lot_required: "Kode lot hasil wajib diisi.",
    production_output_expiry_invalid: "Tanggal kedaluwarsa harus memenuhi masa simpan bahan olahan.",
    production_output_expired: "Tanggal kedaluwarsa batch sudah lewat.",
    production_output_shelf_life_too_short: "Masa simpan batch lebih pendek dari aturan bahan olahan.",
    inventory_period_closed: "Tanggal tersebut berada pada periode stok yang sudah ditutup.",
    production_order_not_found: "Rencana batch tidak ditemukan. Muat ulang daftar produksi.",
    production_order_not_completable: "Rencana ini sudah selesai, dibatalkan, atau kedaluwarsa.",
    production_recipe_snapshot_authority_mismatch: "Versi resep batch tidak lagi valid. Batalkan dan buat rencana baru.",
  };
  return messages[error?.code] ?? error?.message ?? "Produksi belum dapat disimpan.";
}

function prepWarehouseLocationId(data = inventoryWorkspace.data) {
  return data?.warehouse?.locations?.find((item) => item.status !== "ARCHIVED")?.id
    ?? data?.warehouse?.defaultLocationId ?? "MAIN";
}

function openPrepProductionDialog(ingredientId, productionOrderId = null) {
  const ingredient = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === ingredientId);
  const plannedOrder = productionOrderId
    ? productionOrders().find((item) => (item.id ?? item.productionOrderId) === productionOrderId && item.status === "PLANNED")
    : null;
  const recipe = plannedOrder?.recipeSnapshot
    ? { outputQuantityBase: plannedOrder.recipeSnapshot.output?.quantity }
    : prepRecipeFor(ingredientId);
  if (!ingredient || !isPrepIngredient(ingredient)) { announce("Bahan olahan tidak ditemukan.", true); return; }
  if (productionOrderId && !plannedOrder) { announce("Rencana batch tidak ditemukan atau sudah tidak aktif. Muat ulang data.", true); return; }
  if (!recipe) { announce("Atur resep olahan sebelum membuat produksi batch.", true); return; }
  const outputQuantity = recipe.outputQuantityBase ?? recipe.output?.quantityBase ?? recipe.output?.quantity ?? 1;
  const plannedQuantity = plannedOrder?.plannedOutput?.quantity ?? plannedOrder?.plannedOutputQuantity ?? outputQuantity;
  const minimumShelfLifeDays = Math.max(1, Number(ingredient.minimumShelfLifeDays) || 1);
  const recipeForInputs = plannedOrder?.recipeSnapshot
    ? { outputQuantityBase: plannedOrder.recipeSnapshot.output?.quantity, components: plannedOrder.recipeSnapshot.resolvedLines?.map((line) => ({ ingredientId: line.itemId, quantityBase: line.normalizedQuantity })) ?? [] }
    : recipe;
  const scale = Number(recipeForInputs.outputQuantityBase ?? recipeForInputs.output?.quantity ?? 0) > 0
    ? Number(plannedQuantity) / Number(recipeForInputs.outputQuantityBase ?? recipeForInputs.output?.quantity)
    : 1;
  prepProductionDialog = {
    outputIngredientId: ingredientId,
    plannedOutputQuantity: String(plannedQuantity),
    actualOutputQuantity: String(plannedQuantity),
    lotId: `${String(ingredient.sku || ingredient.name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "PREP"}-${Date.now().toString().slice(-8)}`,
    expiryDate: prepDefaultExpiryDate(minimumShelfLifeDays),
    completedAt: prepDefaultDateTime(),
    reason: `Produksi batch ${ingredient.name}`,
    confirmed: false,
    varianceConfirmed: false,
    inputMode: plannedOrder?.inputMode ?? "BACKFLUSH",
    measuredInputs: (recipeForInputs.components ?? []).map((line) => ({
      itemId: line.ingredientId ?? line.itemId,
      normalizedQuantity: String(Number(line.quantityBase ?? line.quantity ?? line.normalizedQuantity ?? 0) * scale),
    })),
    recipeSnapshot: plannedOrder?.recipeSnapshot ?? null,
    recipeVersion: plannedOrder?.recipeSnapshot?.recipeVersion ?? prepRecipeFor(ingredientId)?.version ?? 1,
    yieldToleranceBps: Number(plannedOrder?.yieldToleranceBps ?? prepRecipeFor(ingredientId)?.yieldToleranceBps ?? 0),
    minimumShelfLifeDays,
    planOperationKey: inventoryOperationKey("prep-production-plan"),
    completeOperationKey: inventoryOperationKey("prep-production-complete"),
    productionOrderId: plannedOrder?.id ?? plannedOrder?.productionOrderId ?? null,
    productionRevision: Number(inventoryWorkspace.data?.production?.revision ?? plannedOrder?.revision ?? 0),
    saving: false,
    dirty: false,
  };
  render();
  requestAnimationFrame(() => content.querySelector("#prep-production-title")?.focus());
}

function closePrepProductionDialog() {
  if (prepProductionDialog?.saving) return;
  if (prepProductionDialog?.dirty && !window.confirm("Data produksi belum disimpan. Buang perubahan dan tutup?")) return;
  const returnId = prepProductionDialog?.outputIngredientId;
  prepProductionDialog = null;
  render();
  requestAnimationFrame(() => content.querySelector(`[data-prep-production-open="${CSS.escape(returnId || "")}"]`)?.focus());
}

function collectPrepProductionDraft(form) {
  if (!prepProductionDialog || !form) return;
  const values = new FormData(form);
  for (const key of ["plannedOutputQuantity", "actualOutputQuantity", "lotId", "expiryDate", "completedAt", "reason", "inputMode"]) {
    prepProductionDialog[key] = String(values.get(key) ?? "");
  }
  prepProductionDialog.confirmed = values.has("confirmed");
  prepProductionDialog.varianceConfirmed = values.has("varianceConfirmed");
  prepProductionDialog.measuredInputs = prepProductionDialog.measuredInputs.map((line, index) => ({
    ...line, normalizedQuantity: String(values.get(`actualInput:${index}`) ?? line.normalizedQuantity),
  }));
}

function prepProductionEstimate(dialog = prepProductionDialog) {
  const recipe = prepProductionRecipe(dialog);
  const ingredients = inventoryWorkspace.data?.ingredients?.items ?? [];
  const balances = inventoryWorkspace.data?.warehouse?.balances ?? [];
  const recipeOutput = Number(recipe?.outputQuantityBase ?? recipe?.output?.quantityBase ?? recipe?.output?.quantity ?? 0);
  const plannedOutput = Number(dialog?.plannedOutputQuantity);
  const actualOutput = Number(dialog?.actualOutputQuantity);
  const scale = recipeOutput > 0 && plannedOutput > 0 ? plannedOutput / recipeOutput : 0;
  let totalCost = 0;
  let completeCost = scale > 0;
  const components = (recipe?.components ?? recipe?.resolvedLines ?? []).map((line, index) => {
    const ingredientId = line.ingredientId ?? line.itemId;
    const ingredient = ingredients.find((item) => item.id === ingredientId);
    const required = Number(line.quantityBase ?? line.quantity ?? line.normalizedQuantity ?? 0) * scale;
    const measured = dialog?.inputMode === "MEASURED" ? Number(dialog.measuredInputs?.[index]?.normalizedQuantity) : required;
    const balance = balances.find((item) => item.ingredientId === ingredientId);
    const available = Number(balance?.availableBase ?? balance?.onHandBase ?? 0);
    const unitCost = prepIngredientUnitCost(ingredient) ?? (balance?.averageCostPerBaseUnitRupiah == null ? null : Number(balance.averageCostPerBaseUnitRupiah));
    const cost = unitCost == null ? null : measured * unitCost;
    if (cost == null) completeCost = false;
    else totalCost += cost;
    const varianceQuantity = measured - required;
    const variancePct = required > 0 ? varianceQuantity / required * 100 : 0;
    return { ingredient, required, measured, varianceQuantity, variancePct, available, enough: available >= measured, cost };
  });
  const lossQuantity = Number.isFinite(plannedOutput) && Number.isFinite(actualOutput) ? Math.max(0, plannedOutput - actualOutput) : 0;
  const toleranceQuantity = plannedOutput * Number(dialog?.yieldToleranceBps ?? recipe?.yieldToleranceBps ?? 0) / 10000;
  const normalLossQuantity = Math.min(lossQuantity, toleranceQuantity);
  const abnormalLossQuantity = Math.max(0, lossQuantity - toleranceQuantity);
  const abovePlanQuantity = Math.max(0, actualOutput - plannedOutput);
  const yieldPct = plannedOutput > 0 ? actualOutput / plannedOutput * 100 : 0;
  const abnormalInput = components.some((item) => Math.abs(item.variancePct) > 10);
  const hasAbnormalVariance = abnormalLossQuantity > 0 || abovePlanQuantity > 0 || abnormalInput;
  return { recipe, plannedOutput, actualOutput, scale, components, totalCost, completeCost, lossQuantity, lossPct: plannedOutput > 0 ? lossQuantity / plannedOutput * 100 : 0, toleranceQuantity, normalLossQuantity, abnormalLossQuantity, abovePlanQuantity, yieldPct, hasAbnormalVariance, outputUnitCost: completeCost && actualOutput > 0 ? totalCost / actualOutput : null, allAvailable: components.every((item) => item.enough) };
}

function syncPrepProductionReview(form) {
  if (!form || !prepProductionDialog) return;
  const estimate = prepProductionEstimate();
  const output = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === prepProductionDialog.outputIngredientId);
  const set = (selector, value) => { const node = form.querySelector(selector); if (node) node.textContent = value; };
  set("[data-prep-production-plan]", formatInventoryQuantity(estimate.plannedOutput, output?.baseUom));
  set("[data-prep-production-actual]", formatInventoryQuantity(estimate.actualOutput, output?.baseUom));
  set("[data-prep-production-loss]", `${formatInventoryQuantity(estimate.lossQuantity, output?.baseUom)} · ${formatPlainNumber(estimate.lossPct)}%`);
  set("[data-prep-production-yield]", `${formatPlainNumber(estimate.yieldPct)}%`);
  set("[data-prep-production-normal-loss]", formatInventoryQuantity(estimate.normalLossQuantity, output?.baseUom));
  set("[data-prep-production-abnormal-loss]", formatInventoryQuantity(estimate.abnormalLossQuantity, output?.baseUom));
  set("[data-prep-production-above-plan]", formatInventoryQuantity(estimate.abovePlanQuantity, output?.baseUom));
  set("[data-prep-production-cost]", estimate.completeCost ? rupiah(Math.round(estimate.totalCost)) : "Belum dapat dihitung");
  set("[data-prep-production-unit-cost]", estimate.outputUnitCost == null ? "Belum dapat dihitung" : `${formatRupiahDecimal(estimate.outputUnitCost)} / ${output?.baseUom ?? "unit"}`);
  const warning = form.querySelector("[data-prep-production-warning]");
  if (warning) warning.textContent = !estimate.allAvailable
    ? "Stok bahan input belum cukup setelah memperhitungkan pemakaian yang dimasukkan."
    : estimate.abovePlanQuantity > 0
      ? "Hasil aktual melebihi rencana. Server akan menolak hasil di luar batas resep. Periksa kembali pengukuran."
      : estimate.hasAbnormalVariance
        ? "Ada penyimpangan di luar toleransi. Periksa takaran dan beri konfirmasi tambahan."
        : estimate.completeCost ? "Stok input cukup berdasarkan saldo saat ini. Sistem memeriksa ulang reservasi ketika Anda mengonfirmasi." : "Stok tersedia, tetapi biaya salah satu bahan belum tersedia.";
  const varianceConfirmation = form.querySelector("[data-prep-variance-confirmation]");
  if (varianceConfirmation) varianceConfirmation.hidden = !estimate.hasAbnormalVariance;
  form.querySelectorAll("[data-prep-input-row]").forEach((row, index) => {
    const item = estimate.components[index];
    row.classList.toggle("is-insufficient", !item?.enough);
    const required = row.querySelector("[data-prep-input-required]");
    const available = row.querySelector("[data-prep-input-available]");
    if (required) required.textContent = formatInventoryQuantity(item?.required, item?.ingredient?.baseUom);
    if (available) available.textContent = formatInventoryQuantity(item?.available, item?.ingredient?.baseUom);
    const variance = row.querySelector("[data-prep-input-variance]");
    if (variance) variance.textContent = `${item?.varianceQuantity >= 0 ? "+" : ""}${formatInventoryQuantity(item?.varianceQuantity, item?.ingredient?.baseUom)} · ${item?.variancePct >= 0 ? "+" : ""}${formatPlainNumber(item?.variancePct)}%`;
  });
  const completion = new Date(form.elements.completedAt?.value);
  const expiry = form.elements.expiryDate;
  if (!Number.isNaN(completion.getTime()) && expiry) {
    const minimumExpiry = prepDefaultExpiryDate(prepProductionDialog.minimumShelfLifeDays, completion);
    expiry.min = minimumExpiry;
    expiry.setCustomValidity(expiry.value && expiry.value < minimumExpiry ? `Minimal kedaluwarsa ${minimumExpiry} sesuai masa simpan bahan.` : "");
  }
  const lot = form.elements.lotId;
  if (lot) {
    const duplicate = productionExecutions().some((execution) => execution.id !== prepProductionDialog.executionId && execution.actualOutput?.lotId === lot.value.trim());
    lot.setCustomValidity(duplicate ? "Kode lot sudah digunakan oleh batch lain." : "");
  }
}

async function submitPrepProduction(form) {
  collectPrepProductionDraft(form);
  if (!form.reportValidity() || !prepProductionDialog || prepProductionDialog.saving) return;
  const estimate = prepProductionEstimate();
  if (!estimate.allAvailable) { const warning = form.querySelector("[data-prep-production-warning]"); if (warning) warning.textContent = "Stok bahan input belum cukup. Isi stok atau kurangi rencana produksi."; return; }
  if (estimate.abovePlanQuantity > 0) { const warning = form.querySelector("[data-prep-production-warning]"); if (warning) warning.textContent = "Hasil aktual tidak boleh melebihi rencana batch. Periksa pengukuran atau buat rencana baru."; return; }
  if (estimate.hasAbnormalVariance && !prepProductionDialog.varianceConfirmed) { const warning = form.querySelector("[data-prep-production-warning]"); if (warning) warning.textContent = "Konfirmasi penyimpangan hasil atau pemakaian sebelum menyimpan."; return; }
  prepProductionDialog.saving = true;
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  const status = form.querySelector("[data-prep-production-status]");
  if (status) status.textContent = prepProductionDialog.productionOrderId ? "Menyelesaikan batch yang sudah direncanakan…" : "Merencanakan dan menyelesaikan batch…";
  try {
    const output = inventoryWorkspace.data.ingredients.items.find((item) => item.id === prepProductionDialog.outputIngredientId);
    if (!prepProductionDialog.productionOrderId) {
      const plan = await requestHppAdminAction("hpp.production.plan", {
        operationKey: prepProductionDialog.planOperationKey,
        outputIngredientId: prepProductionDialog.outputIngredientId,
        plannedOutput: { itemId: prepProductionDialog.outputIngredientId, quantity: String(prepProductionDialog.plannedOutputQuantity), normalizedUom: output.baseUom },
        inputMode: prepProductionDialog.inputMode,
        expectedRevision: prepProductionDialog.productionRevision,
        reason: prepProductionDialog.reason.trim(),
      });
      const order = plan.productionOrder ?? plan.operation?.productionOrder ?? plan.operation?.next;
      prepProductionDialog.productionOrderId = order?.id ?? order?.productionOrderId;
      prepProductionDialog.productionRevision = Number(order?.revision ?? prepProductionDialog.productionRevision + 1);
      if (!prepProductionDialog.productionOrderId) throw new Error("Rencana produksi tersimpan, tetapi ID batch belum diterima. Muat ulang sebelum mencoba lagi.");
    }
    await requestHppAdminAction("hpp.production.complete", {
      operationKey: prepProductionDialog.completeOperationKey,
      productionOrderId: prepProductionDialog.productionOrderId,
      inputLocationId: prepWarehouseLocationId(), outputLocationId: prepWarehouseLocationId(),
      actualOutput: {
        itemId: prepProductionDialog.outputIngredientId,
        usableQuantity: String(prepProductionDialog.actualOutputQuantity),
        normalizedUom: output.baseUom,
        lotId: prepProductionDialog.lotId.trim(),
        ...(prepProductionDialog.expiryDate ? { expiryAt: `${prepProductionDialog.expiryDate}T23:59:59.000+07:00` } : {}),
      },
      ...(prepProductionDialog.inputMode === "MEASURED" ? { actualInputs: estimate.components.map((item) => ({ itemId: item.ingredient.id, normalizedQuantity: String(item.measured), normalizedUom: item.ingredient.baseUom })) } : {}),
      completedAt: new Date(prepProductionDialog.completedAt).toISOString(),
      expectedRevision: prepProductionDialog.productionRevision,
      reason: prepProductionDialog.reason.trim(),
    });
    const returnId = prepProductionDialog.outputIngredientId;
    prepProductionDialog = null;
    render();
    announce("Produksi batch selesai. Stok input berkurang dan stok bahan olahan bertambah.");
    requestAnimationFrame(() => content.querySelector(`[data-prep-production-open="${CSS.escape(returnId)}"]`)?.focus());
  } catch (error) {
    prepProductionDialog.saving = false;
    if (button) button.disabled = false;
    const message = prepProductionMessage(error);
    if (status) status.textContent = prepProductionDialog.productionOrderId ? `${message} Rencana batch tetap tersimpan; perbaiki data lalu coba lagi.` : message;
    announce(message, true);
  }
}

async function cancelPrepProduction(productionOrderId) {
  if (!productionOrderId || inventoryMutationPending) return;
  if (!window.confirm("Batalkan rencana produksi ini? Stok belum berubah dan histori pembatalan tetap disimpan.")) return;
  inventoryMutationPending = true;
  try {
    const order = productionOrders().find((item) => (item.id ?? item.productionOrderId) === productionOrderId);
    await requestHppAdminAction("hpp.production.cancel", {
      operationKey: inventoryOperationKey("prep-production-cancel"), productionOrderId,
      expectedRevision: Number(inventoryWorkspace.data?.production?.revision ?? order?.revision ?? 0),
      reason: "Membatalkan rencana produksi bahan olahan",
    });
    render();
    announce("Rencana produksi dibatalkan. Stok tidak berubah.");
  } catch (error) { announce(prepProductionMessage(error), true); }
  finally { inventoryMutationPending = false; }
}

function ownerPrepProductionPanel(data) {
  const prepItems = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE" && isPrepIngredient(item));
  if (!prepItems.length) return `<article class="dashboard-card prep-production-card"><div class="section-heading"><div><p class="eyebrow">Produksi batch</p><h2>Belum ada bahan olahan</h2><p class="card-subtitle">Buat bahan dengan sumber “Dibuat sendiri”, lalu atur resepnya dari Database Bahan.</p></div><a class="button button-primary" href="#inventory/database">Buka Database Bahan</a></div></article>`;
  const rows = prepItems.map((item) => {
    const recipe = prepRecipeFor(item.id, data);
    const balance = data.warehouse?.balances?.find((entry) => entry.ingredientId === item.id);
    return `<li><div><strong>${escapeHtml(item.name)}</strong><span>${recipe ? `Resep v${escapeHtml(recipe.version ?? 1)} · hasil ${formatInventoryQuantity(recipe.outputQuantityBase ?? recipe.output?.quantityBase, item.baseUom)}` : "Resep belum diatur"}</span><small>Stok hasil produksi ${formatInventoryQuantity(balance?.availableBase ?? 0, item.baseUom)}</small></div><button class="button ${recipe ? "button-primary" : "button-ghost"}" type="button" data-${recipe ? "prep-production-open" : "prep-recipe-open"}="${escapeHtml(item.id)}">${recipe ? "Produksi batch" : "Atur resep"}</button></li>`;
  }).join("");
  const plannedRows = productionOrders(data).filter((item) => item.status === "PLANNED").map((item) => {
    const outputId = item.outputIngredientId ?? item.plannedOutput?.itemId ?? item.recipeSnapshot?.output?.itemId;
    const ingredient = prepItems.find((candidate) => candidate.id === outputId);
    const orderId = item.id ?? item.productionOrderId;
    return `<li><div><strong>${escapeHtml(ingredient?.name ?? "Batch bahan olahan")}</strong><span>Rencana ${formatInventoryQuantity(item.plannedOutput?.quantity ?? item.plannedOutputQuantity, ingredient?.baseUom)} · resep v${escapeHtml(item.recipeSnapshot?.recipeVersion ?? "-")}</span><small>${escapeHtml(orderId)} · ${escapeHtml(item.inputMode === "MEASURED" ? "Pemakaian diukur" : "Pemakaian standar")}</small></div>${ingredient ? `<div class="button-row"><button class="button button-primary" type="button" data-prep-production-open="${escapeHtml(ingredient.id)}" data-production-order-id="${escapeHtml(orderId)}">Lanjutkan batch</button><button class="button button-danger" type="button" data-prep-production-void="${escapeHtml(orderId)}">Batalkan rencana</button></div>` : '<span class="status-badge is-muted">Bahan tidak ditemukan</span>'}</li>`;
  }).join("");
  const historyRows = productionExecutions(data).slice().sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, 10).map((execution) => {
    const ingredient = prepItems.find((item) => item.id === execution.actualOutput?.itemId);
    const yieldData = execution.yield ?? {};
    return `<li><div><strong>${escapeHtml(ingredient?.name ?? "Batch bahan olahan")}</strong><span>${formatInventoryQuantity(execution.actualOutput?.usableQuantity, ingredient?.baseUom)} · yield ${escapeHtml(yieldData.yieldPct ?? "-")}% · resep v${escapeHtml(execution.recipeVersion ?? "-")}</span><small>${escapeHtml(execution.completedAt ? formatDate(execution.completedAt) : "Waktu tidak tersedia")} · lot ${escapeHtml(execution.actualOutput?.lotId ?? "-")} · ${escapeHtml(execution.id ?? "-")}</small></div><span class="status-badge ${Number(yieldData.abnormalWasteQuantity ?? 0) > 0 ? "is-warning" : "is-ready"}">${Number(yieldData.abnormalWasteQuantity ?? 0) > 0 ? "Periksa variance" : "Selesai"}</span></li>`;
  }).join("");
  const history = historyRows ? `<details class="prep-planned-orders" data-prep-production-history><summary>Riwayat batch terbaru</summary><ul class="prep-production-list">${historyRows}</ul>${productionExecutions(data).length > 10 ? `<p class="owner-card-note">10 dari ${productionExecutions(data).length} batch ditampilkan. Gunakan laporan produksi untuk histori lengkap.</p>` : ""}</details>` : "";
  return `<article class="dashboard-card prep-production-card"><div class="section-heading"><div><p class="eyebrow">Produksi batch</p><h2>Buat stok bahan olahan</h2><p class="card-subtitle">Periksa kebutuhan input, estimasi biaya, hasil aktual, susut, lot, dan expiry sebelum mengonfirmasi.</p></div><span class="status-badge is-ready">${prepItems.length} bahan olahan</span></div><ul class="prep-production-list">${rows}</ul>${plannedRows ? `<details class="prep-planned-orders"><summary>Rencana yang belum selesai</summary><ul class="prep-production-list">${plannedRows}</ul></details>` : ""}${history}</article>`;
}

function ownerPrepProductionDialog(data) {
  if (!prepProductionDialog) return "";
  const output = data.ingredients?.items?.find((item) => item.id === prepProductionDialog.outputIngredientId);
  const estimate = prepProductionEstimate();
  const inputRows = estimate.components.map((item, index) => `<li data-prep-input-row="${index}" class="${item.enough ? "" : "is-insufficient"}"><div><strong>${escapeHtml(item.ingredient?.name ?? "Bahan")}</strong><span>Standar <b data-prep-input-required>${formatInventoryQuantity(item.required, item.ingredient?.baseUom)}</b></span>${prepProductionDialog.inputMode === "MEASURED" ? `<label>Pemakaian aktual<input name="actualInput:${index}" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(prepProductionDialog.measuredInputs[index]?.normalizedQuantity ?? item.required)}" required><small>${escapeHtml(item.ingredient?.baseUom ?? "unit")}</small></label><small>Variance <b data-prep-input-variance>${item.varianceQuantity >= 0 ? "+" : ""}${formatInventoryQuantity(item.varianceQuantity, item.ingredient?.baseUom)} · ${item.variancePct >= 0 ? "+" : ""}${formatPlainNumber(item.variancePct)}%</b></small>` : ""}</div><small>Tersedia <b data-prep-input-available>${formatInventoryQuantity(item.available, item.ingredient?.baseUom)}</b></small></li>`).join("");
  const resumed = Boolean(prepProductionDialog.productionOrderId);
  const minimumExpiry = prepDefaultExpiryDate(prepProductionDialog.minimumShelfLifeDays, new Date(prepProductionDialog.completedAt));
  return `<dialog id="prep-production-dialog" class="prep-dialog" aria-labelledby="prep-production-title"><form id="prep-production-form" class="prep-dialog-shell"><header class="prep-dialog-header"><div><p class="eyebrow">Gudang · Produksi batch</p><h1 id="prep-production-title" tabindex="-1">Produksi ${escapeHtml(output?.name ?? "bahan olahan")}</h1><p>${resumed ? `Melanjutkan ${escapeHtml(prepProductionDialog.productionOrderId)} dengan snapshot resep v${escapeHtml(prepProductionDialog.recipeVersion)}.` : "Sistem membuat rencana lalu menyelesaikan batch setelah konfirmasi."} Stok dan reservasi diperiksa ulang saat disimpan.</p></div><button class="ingredient-editor-dismiss" type="button" data-prep-production-close aria-label="Tutup produksi batch">×</button></header><div class="prep-dialog-grid"><section class="prep-form-pane"><h2>Rencana & hasil aktual</h2><div class="prep-output-fields"><label>Hasil direncanakan<input name="plannedOutputQuantity" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(prepProductionDialog.plannedOutputQuantity)}" ${resumed ? "readonly aria-readonly=\"true\"" : ""} required><small>${escapeHtml(output?.baseUom ?? "unit")}${resumed ? " · dikunci saat batch direncanakan" : ""}</small></label><label>Hasil aktual yang bisa dipakai<input name="actualOutputQuantity" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(prepProductionDialog.actualOutputQuantity)}" required><small>${escapeHtml(output?.baseUom ?? "unit")} setelah susut</small></label><label>Metode pemakaian<select name="inputMode" ${resumed ? "disabled" : ""}><option value="BACKFLUSH" ${prepProductionDialog.inputMode === "BACKFLUSH" ? "selected" : ""}>Standar resep</option><option value="MEASURED" ${prepProductionDialog.inputMode === "MEASURED" ? "selected" : ""}>Diukur aktual</option></select>${resumed ? `<input type="hidden" name="inputMode" value="${escapeHtml(prepProductionDialog.inputMode)}">` : ""}</label><label>Waktu selesai<input name="completedAt" type="datetime-local" value="${escapeHtml(prepProductionDialog.completedAt)}" required></label><label>Kode lot hasil<input name="lotId" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" value="${escapeHtml(prepProductionDialog.lotId)}" required><small>Huruf, angka, titik, garis bawah, titik dua, atau tanda minus.</small></label><label>Tanggal kedaluwarsa<input name="expiryDate" type="date" min="${escapeHtml(minimumExpiry)}" value="${escapeHtml(prepProductionDialog.expiryDate)}" required><small>Minimal ${escapeHtml(prepProductionDialog.minimumShelfLifeDays)} hari setelah produksi; lot dipakai untuk traceability dan FEFO.</small></label></div><h3>${prepProductionDialog.inputMode === "MEASURED" ? "Pemakaian bahan aktual" : "Ketersediaan bahan input"}</h3><ul class="prep-input-list">${inputRows}</ul><label class="prep-reason">Catatan produksi<input name="reason" maxlength="160" value="${escapeHtml(prepProductionDialog.reason)}" required></label></section><aside class="prep-review-pane" data-prep-production-review aria-live="polite"><p class="eyebrow">Review sebelum konfirmasi</p><h2>Dampak batch</h2><dl><div><dt>Rencana hasil</dt><dd data-prep-production-plan>${formatInventoryQuantity(estimate.plannedOutput, output?.baseUom)}</dd></div><div><dt>Hasil aktual</dt><dd data-prep-production-actual>${formatInventoryQuantity(estimate.actualOutput, output?.baseUom)}</dd></div><div><dt>Yield aktual</dt><dd data-prep-production-yield>${formatPlainNumber(estimate.yieldPct)}%</dd></div><div><dt>Susut total</dt><dd data-prep-production-loss>${formatInventoryQuantity(estimate.lossQuantity, output?.baseUom)} · ${formatPlainNumber(estimate.lossPct)}%</dd></div><div><dt>Susut normal</dt><dd data-prep-production-normal-loss>${formatInventoryQuantity(estimate.normalLossQuantity, output?.baseUom)}</dd></div><div><dt>Susut abnormal</dt><dd data-prep-production-abnormal-loss>${formatInventoryQuantity(estimate.abnormalLossQuantity, output?.baseUom)}</dd></div><div><dt>Hasil di atas rencana</dt><dd data-prep-production-above-plan>${formatInventoryQuantity(estimate.abovePlanQuantity, output?.baseUom)}</dd></div><div><dt>Estimasi biaya input</dt><dd data-prep-production-cost>${estimate.completeCost ? rupiah(Math.round(estimate.totalCost)) : "Belum dapat dihitung"}</dd></div><div><dt>Moving average hasil produksi</dt><dd data-prep-production-unit-cost>${estimate.outputUnitCost == null ? "Belum dapat dihitung" : `${formatRupiahDecimal(estimate.outputUnitCost)} / ${escapeHtml(output?.baseUom ?? "unit")}`}</dd></div></dl><p class="owner-card-note" data-prep-production-warning>${estimate.allAvailable ? "Stok input cukup berdasarkan saldo saat ini. Sistem memeriksa ulang reservasi ketika Anda mengonfirmasi." : "Stok bahan input belum cukup. Produksi akan ditolak sampai saldo tersedia."}</p><label class="prep-confirm" data-prep-variance-confirmation ${estimate.hasAbnormalVariance ? "" : "hidden"}><input name="varianceConfirmed" type="checkbox" ${estimate.hasAbnormalVariance ? "required" : ""} ${prepProductionDialog.varianceConfirmed ? "checked" : ""}><span><strong>Saya sudah memeriksa penyimpangan batch</strong><small>Konfirmasi ini tidak melewati guard server atau approval yang diwajibkan.</small></span></label><label class="prep-confirm"><input name="confirmed" type="checkbox" required ${prepProductionDialog.confirmed ? "checked" : ""}><span><strong>Saya sudah memeriksa hasil fisik batch</strong><small>Konfirmasi mengurangi stok input dan menambah lot bahan olahan. HPP menu dan harga jual tidak dipublikasikan otomatis.</small></span></label></aside></div><footer class="prep-dialog-actions"><p class="form-status" role="status" aria-live="polite" data-prep-production-status></p><button class="button button-ghost" type="button" data-prep-production-close>Batal</button><button class="button button-primary" type="submit" data-prep-production-save ${prepProductionDialog.saving ? "disabled" : ""}>Konfirmasi produksi batch</button></footer></form></dialog>`;
}

function ownerWarehouseArea(data, dashboardData) {
  const balances = data.warehouse?.balances ?? [];
  const activeIngredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE");
  const receivableIngredients = activeIngredients.filter((item) => item.purchasable !== false && item.sourcingMode !== "MADE_IN_HOUSE" && item.materialType !== "PREP_ITEM");
  const ingredientOptions = receivableIngredients.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.baseUom)}</option>`).join("");
  const stockRows = activeIngredients.map((ingredient) => {
    const balance = balances.find((item) => item.ingredientId === ingredient.id);
    const batchNeedsReview = (data.warehouse?.lotReconciliation?.trackedIngredientIds ?? []).includes(ingredient.id)
      && data.warehouse?.lotReconciliation?.status !== "VERIFIED";
    const minimumStatus = minimumStockStatus(ingredient, balance);
    return { ingredient, balance, minimumStatus: batchNeedsReview ? { ...minimumStatus, label: "Periksa batch", tone: "blocked" } : minimumStatus };
  });
  const needsBuyCount = stockRows.filter(({ minimumStatus }) => minimumStatus.label === "Perlu beli").length;
  const minimumNotSetCount = stockRows.filter(({ minimumStatus }) => minimumStatus.label === "Belum diatur").length;
  let reorderSummary = replenishmentState.status === "error" ? { label: "Status minimum belum tersedia", tone: "warning" }
    : replenishmentState.status === "loading" ? { label: "Memuat status minimum", tone: "warning" }
      : needsBuyCount ? { label: `${needsBuyCount} perlu dibeli`, tone: "blocked" }
        : minimumNotSetCount ? { label: `${minimumNotSetCount} minimum belum diatur`, tone: "warning" }
           : { label: "Semua stok aman", tone: "ready" };
  if (!["VERIFIED", "NOT_TRACKED"].includes(data.warehouse?.lotReconciliation?.status)) {
    reorderSummary = { label: "Stok batch perlu diperiksa", tone: "blocked" };
  }
  const stockRowMarkup = stockRows.map(({ ingredient, balance, minimumStatus: status }) => {
    const hasBalance = Boolean(balance);
    const onHand = hasBalance ? formatInventoryQuantity(balance.onHandBase ?? 0, ingredient.baseUom) : "Belum ada saldo";
    const batchNeedsReview = (data.warehouse?.lotReconciliation?.trackedIngredientIds ?? []).includes(ingredient.id)
      && data.warehouse?.lotReconciliation?.status !== "VERIFIED";
    const available = batchNeedsReview ? "Periksa batch" : hasBalance ? formatInventoryQuantity(balance.availableBase ?? 0, ingredient.baseUom) : "Belum ada saldo";
    const averageCost = hasBalance && balance.averageCostPerBaseUnitRupiah != null ? rupiah(Number(balance.averageCostPerBaseUnitRupiah)) : "Belum ada";
    const inventoryValue = hasBalance && balance.inventoryValueRupiah != null ? rupiah(balance.inventoryValueRupiah) : "Belum tersedia";
    return `<tr data-reorder-item="${escapeHtml(ingredient.id)}" data-warehouse-stock-row data-warehouse-search-value="${escapeHtml(ingredient.name)}"><th scope="row">${escapeHtml(ingredient.name)}<small><span data-reorder-status class="status-badge is-${status.tone}">${escapeHtml(status.label)}</span></small></th><td data-label="Stok tercatat" data-stock-field="on-hand">${onHand}</td><td data-label="Bisa dipakai" data-stock-field="available">${available}</td><td data-label="Minimum" data-stock-field="minimum">${status.threshold == null ? "Minimum belum diatur" : formatInventoryQuantity(status.threshold, ingredient.baseUom)}</td><td data-label="Biaya rata-rata / unit" data-stock-field="average-cost">${averageCost}</td><td data-label="Nilai stok" data-stock-field="inventory-value">${inventoryValue}</td><td data-label="Tindakan"><button class="button button-ghost button-small" type="button" data-minimum-stock-edit="${escapeHtml(ingredient.id)}" aria-label="Atur minimum untuk ${escapeHtml(ingredient.name)}">Atur minimum</button></td></tr>`;
  }).join("");
  const balanceView = stockRows.length
    ? `<article id="warehouse-stock-balance" class="dashboard-card inventory-stock-card" aria-labelledby="warehouse-stock-balance-title"><div class="section-heading"><div><h2 id="warehouse-stock-balance-title">Stok saat ini</h2><p class="card-subtitle">Stok tersedia dan minimum memakai data bisnis yang sama. Pembelian hari ini ${rupiah(dashboardData.purchaseTodayRupiah ?? 0)} · waste/pengurangan ${rupiah(dashboardData.wasteTodayRupiah ?? 0)}.</p></div><div class="inventory-stock-summary"><span id="warehouse-reorder-summary" class="status-badge is-${reorderSummary.tone}" role="status" aria-live="polite">${escapeHtml(reorderSummary.label)}</span><span class="status-badge ${data.warehouse?.ledgerReconciliation?.status === "VERIFIED" ? "is-ready" : "is-warning"}">${data.warehouse?.ledgerReconciliation?.status === "VERIFIED" ? "Ledger cocok" : "Histori perlu review"}</span></div></div>${replenishmentState.status === "error" ? `<p class="inventory-inline-warning" role="status">Status minimum belum dapat dimuat. Saldo tetap bisa digunakan dan tidak dianggap aman secara otomatis.</p>` : ""}<div class="dashboard-table inventory-balance-table" role="region" aria-labelledby="warehouse-stock-balance-title" tabindex="0"><table><caption class="sr-only">Saldo bahan di gudang dan pengaturan stok minimum</caption><thead><tr><th scope="col">Bahan & status</th><th scope="col">On-hand</th><th scope="col">Tersedia</th><th scope="col">Minimum</th><th scope="col">MWA / unit</th><th scope="col">Nilai</th><th scope="col"><span class="sr-only">Tindakan</span></th></tr></thead><tbody>${stockRowMarkup}</tbody></table></div><p class="inventory-inline-empty" data-warehouse-stock-no-results hidden>Tidak ada stok bahan yang cocok dengan pencarian ini.</p></article>`
    : `<article class="dashboard-card inventory-empty"><span aria-hidden="true">ST</span><div><h2>Gudang belum memiliki saldo</h2><p>Penerimaan pertama akan membentuk saldo serta biaya rata-rata. Dashboard tidak menebak jumlah fisik.</p></div></article>`;
  const primaryAction = receivableIngredients.length
    ? `<button class="button button-primary" type="button" data-warehouse-receipt-open>Tambah stok masuk</button>`
    : `<a class="button button-primary" href="#inventory/database">Tambah bahan dulu</a>`;
  const overview = `<article class="dashboard-card warehouse-overview-card"><div class="section-heading"><div><p class="eyebrow">Gudang</p><h2>Stok bahan</h2><p class="card-subtitle">Lihat jumlah yang tersedia atau catat barang yang baru datang.</p></div>${primaryAction}</div><form id="warehouse-stock-search-form" class="warehouse-stock-search" role="search"><label for="warehouse-stock-search">Cari bahan di gudang</label><input id="warehouse-stock-search" name="query" type="search" maxlength="80" autocomplete="off" placeholder="Contoh: susu atau gula" value="${escapeHtml(warehouseSearchQuery)}" aria-describedby="warehouse-stock-search-help"><button class="button button-ghost" type="submit">Cari bahan</button><p id="warehouse-stock-search-help" role="status" aria-live="polite" data-warehouse-search-status></p></form></article>`;
  const reconciliationStatus = data.warehouse?.ledgerReconciliation?.status;
  const checkedBalanceView = balanceView.replace("Histori perlu review", reconciliationStatus === "LOCATION_UNVERIFIED"
    ? "Lokasi belum terverifikasi" : reconciliationStatus === "LOT_UNVERIFIED" ? "Batch belum terverifikasi" : "Histori perlu review");
  const expiryPanel = ownerWarehouseExpiryPanel(data);
  const checkedExpiryPanel = ["VERIFIED", "NOT_TRACKED", "EXPIRED_STOCK"].includes(data.warehouse?.lotReconciliation?.status)
    ? expiryPanel : expiryPanel.replace("Gunakan lebih dulu", "Tanggal kedaluwarsa")
      .replace("Urutan tanggal terdekat membantu tim memakai bahan yang lebih dulu kedaluwarsa.", "Sisa batch belum terbukti; periksa fisik sebelum memilih bahan.");
  return `${overview}${ownerOfflineSaleReconciliationPanel(data)}${ownerStaffReceiptPanel()}${ownerPrepProductionPanel(data)}${checkedExpiryPanel}${checkedBalanceView}${ownerWarehouseStockCountPanel(data)}${ownerWarehouseMovementPanel(data, activeIngredients)}${ownerWarehouseReceiptHistory(data)}${ownerWarehouseCorrectionsPanel(data)}${minimumStockDialog(data)}${warehouseReceiptOpen && receivableIngredients.length ? ownerWarehouseReceiptDialog(data, ingredientOptions) : ""}${prepProductionDialog ? ownerPrepProductionDialog(data) : ""}`;
}

function ownerOfflineSaleReconciliationPanel(data) {
  const reconciliation = data.warehouse?.offlineSales;
  if (!reconciliation) return "";
  const items = reconciliation.items ?? [];
  const badge = reconciliation.needsReviewCount
    ? `<span class="status-badge is-blocked">${reconciliation.needsReviewCount} penjualan perlu ditinjau</span>`
    : `<span class="status-badge is-ready">Tidak ada exception</span>`;
  if (!items.length) {
    return `<article class="dashboard-card warehouse-offline-reconciliation"><div class="section-heading"><div><p class="eyebrow">Rekonsiliasi offline</p><h2>Penjualan offline terkendali</h2><p class="card-subtitle">Penjualan dari perangkat offline akan muncul di sini bila stok menjadi minus atau pemakaian bahan tidak lengkap.</p></div>${badge}</div><p class="owner-card-note">${reconciliation.totalCount ? `${reconciliation.totalCount} penjualan offline sudah masuk ledger tanpa exception terbuka.` : "Belum ada penjualan offline yang perlu dicocokkan."}</p></article>`;
  }
  const rows = items.flatMap((item) => (item.lines ?? []).filter((line) => Number(line.shortageBase) > 0 || line.status !== "APPLIED").map((line) => `<tr><th scope="row">${escapeHtml(item.orderNumber)}<small>${dateTime(item.occurredAt)}</small></th><td>${escapeHtml(line.ingredientName)}</td><td>${formatInventoryQuantity(line.quantityRequiredBase, line.baseUom)}</td><td>${formatInventoryQuantity(line.quantityAppliedBase, line.baseUom)}</td><td><strong>${formatInventoryQuantity(line.shortageBase, line.baseUom)}</strong></td><td><span class="status-badge is-blocked">Perlu stock count</span></td></tr>`)).join("");
  return `<article class="dashboard-card warehouse-offline-reconciliation is-blocked" aria-labelledby="warehouse-offline-reconciliation-title"><div class="section-heading"><div><p class="eyebrow">Rekonsiliasi offline</p><h2 id="warehouse-offline-reconciliation-title">Penjualan offline perlu dicocokkan</h2><p class="card-subtitle">Transaksi tetap disimpan sebagai fakta penjualan. Kekurangan stok tidak ditutup otomatis agar Owner dapat menghitung fisik dan mencatat koreksi yang dapat diaudit.</p></div>${badge}</div><div class="dashboard-table" role="region" aria-labelledby="warehouse-offline-reconciliation-title" tabindex="0"><table><caption class="sr-only">Penjualan offline dengan kekurangan stok</caption><thead><tr><th>Pesanan</th><th>Bahan</th><th>Seharusnya</th><th>Terpakai</th><th>Selisih</th><th>Tindakan</th></tr></thead><tbody>${rows}</tbody></table></div><p class="owner-card-note">Lakukan full stock count pada panel di bawah, lalu catat penerimaan atau koreksi fisik. Jangan menghapus transaksi offline asli.</p></article>`;
}

function ownerStaffReceiptPanel() {
  if (staffReceiptQueue.status === "idle" || (staffReceiptQueue.status === "loading" && !staffReceiptQueue.data)) {
    return `<article id="staff-receipt-queue" class="dashboard-card staff-receipt-panel" aria-busy="true"><div class="section-heading"><div><p class="eyebrow">Penerimaan karyawan</p><h2>Memuat barang datang…</h2><p class="card-subtitle">Mengambil receipt, exception, dan bukti yang terhubung ke Gudang.</p></div></div></article>`;
  }
  const payload = staffReceiptQueue.data ?? {};
  const allReceipts = Array.isArray(payload) ? payload : payload.receipts ?? payload.items ?? [];
  const normalizedQuery = staffReceiptFilters.query.toLocaleLowerCase("id-ID");
  const receipts = allReceipts.filter((receipt) => {
    const statusMatches = staffReceiptFilters.status === "ALL" || receipt.status === staffReceiptFilters.status;
    const lines = receipt.lines ?? [];
    const searchable = [receipt.supplierName, receipt.documentNumber, receipt.actorName, receipt.actor?.name, receipt.actor?.displayName, staffReceiptActorName(receipt.actorStaffId),
      ...lines.map((line) => line.ingredientName ?? line.name)].filter(Boolean).join(" ").toLocaleLowerCase("id-ID");
    return statusMatches && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
  const summary = payload.summary ?? {};
  const pending = summary.pendingReviewCount ?? summary.pendingReview ?? allReceipts.filter((receipt) => receipt.status === "PENDING_REVIEW").length;
  const posting = summary.postingCount ?? summary.posting ?? allReceipts.filter((receipt) => receipt.status === "POSTING").length;
  const posted = summary.postedCount ?? summary.posted ?? allReceipts.filter((receipt) => receipt.status === "POSTED").length;
  const exceptionCount = summary.exceptionCount ?? allReceipts.filter((receipt) => (receipt.exceptions ?? receipt.exceptionReasons ?? []).length).length;
  const evidenceMissing = summary.missingEvidenceCount ?? allReceipts.filter((receipt) => receipt.evidenceComplete === false || receipt.verifiedPhotoCount === 0).length;
  const cards = allReceipts.length ? receipts.map(ownerStaffReceiptQueueItem).join("") : "";
  const error = staffReceiptQueue.status === "error"
    ? `<div class="inventory-inline-warning staff-receipt-unavailable" role="status"><div><strong>Penerimaan karyawan belum terhubung</strong><span>${escapeHtml(staffReceiptQueue.error || "Endpoint belum tersedia.")}</span></div><button class="button button-ghost" type="button" data-staff-receipt-retry>Coba lagi</button></div>` : "";
  const empty = !allReceipts.length
    ? `<div class="inventory-empty staff-receipt-empty"><span aria-hidden="true">IN</span><div><h3>Belum ada barang datang dari karyawan</h3><p>Receipt akan muncul setelah karyawan mengirim form Barang Datang.</p></div></div>`
    : !receipts.length
      ? `<div class="inventory-empty staff-receipt-empty"><span aria-hidden="true">?</span><div><h3>Tidak ada receipt yang cocok</h3><p>Ubah status atau kata pencarian.</p><button class="button button-ghost" type="button" data-staff-receipt-clear-filter>Hapus filter</button></div></div>` : "";
  return `<section id="staff-receipt-queue" class="dashboard-card staff-receipt-panel" aria-labelledby="staff-receipt-title"><div class="section-heading"><div><p class="eyebrow">Penerimaan karyawan · hari ini</p><h2 id="staff-receipt-title">Barang datang dari portal staff</h2><p class="card-subtitle">Cocokkan actor, supplier, bahan, exception, evidence, dan movement sebelum menutup penerimaan.</p></div><span class="status-badge ${pending || posting ? "is-warning" : "is-ready"}">${pending ? `${pending} menunggu review` : posting ? `${posting} sinkronisasi stok` : "Tidak ada antrean"}</span></div>
    <div class="staff-receipt-summary" aria-label="Ringkasan penerimaan hari ini"><div><span>Kiriman</span><strong>${summary.todayCount ?? summary.total ?? allReceipts.length}</strong></div><div><span>Sinkronisasi stok</span><strong>${posting}</strong></div><div><span>Sudah masuk stok</span><strong>${posted}</strong></div><div><span>Dengan exception</span><strong>${exceptionCount}</strong></div><div><span>Evidence belum lengkap</span><strong>${evidenceMissing}</strong></div></div>
    <form id="staff-receipt-filter" class="inventory-filter-form staff-receipt-filter"><label>Cari supplier, bahan, actor, atau dokumen<input name="query" type="search" maxlength="80" autocomplete="off" value="${escapeHtml(staffReceiptFilters.query)}" placeholder="Contoh: susu atau Rani"></label><label>Status<select name="status">${["ALL", "PENDING_REVIEW", "POSTING", "POSTED", "NEEDS_CORRECTION", "REJECTED", "SUBMITTED", "DRAFT"].map((status) => `<option value="${status}" ${staffReceiptFilters.status === status ? "selected" : ""}>${escapeHtml(staffReceiptStatusLabel(status))}</option>`).join("")}</select></label><button class="button button-ghost" type="submit">Terapkan filter</button></form>
    ${error}${cards ? `<div class="staff-receipt-list">${cards}</div>` : empty}
    <p class="inventory-filter-summary" role="status" aria-live="polite">${receipts.length} dari ${allReceipts.length} receipt ditampilkan.</p>${ownerStaffReceiptCapabilityManager()}
    ${staffReceiptDetail.id ? ownerStaffReceiptDetailDialog() : ""}${staffReceiptEvidenceId ? ownerStaffReceiptEvidenceDialog() : ""}</section>`;
}

function ownerStaffReceiptQueueItem(receipt) {
  const lines = receipt.lines ?? [];
  const exceptions = receipt.exceptions ?? receipt.exceptionReasons ?? receipt.reviewReasons ?? [];
  const actor = receipt.actorName ?? receipt.actor?.displayName ?? receipt.actor?.name ?? staffReceiptActorName(receipt.actorStaffId);
  const receivedAt = receipt.serverReceivedAt ?? receipt.submittedAt ?? receipt.createdAt;
  const photoCount = receipt.photoCount ?? receipt.evidenceCount ?? receipt.verifiedPhotoCount ?? (receipt.evidence ?? []).length;
  const tone = receipt.status === "POSTED" ? "is-ready" : receipt.status === "REJECTED" ? "is-blocked" : "is-warning";
  const lineNames = lines.slice(0, 3).map((line) => line.ingredientName ?? line.name ?? "Bahan").join(" · ");
  const receiptId = staffReceiptIdentity(receipt);
  return `<article class="staff-receipt-card" data-staff-receipt-id="${escapeHtml(receiptId)}"><div class="staff-receipt-card-main"><div><span class="status-badge ${tone}">${escapeHtml(staffReceiptStatusLabel(receipt.status))}</span><h3>${escapeHtml(receipt.supplierName || "Supplier belum dipilih")}</h3><p>${escapeHtml(actor)} · ${dateTime(receivedAt)} · ${escapeHtml(receipt.outletName || receipt.locationName || "Outlet sesi")}</p></div><dl><div><dt>Bahan</dt><dd>${lines.length || receipt.lineCount || 0}</dd></div><div><dt>Foto</dt><dd>${photoCount}</dd></div><div><dt>Exception</dt><dd>${exceptions.length || receipt.exceptionCount || 0}</dd></div></dl></div>${lineNames ? `<p class="staff-receipt-line-preview">${escapeHtml(lineNames)}${lines.length > 3 ? ` · +${lines.length - 3} lainnya` : ""}</p>` : ""}<div class="staff-receipt-card-actions"><span>${escapeHtml(receipt.documentNumber || "Tanpa nomor dokumen")}</span><button class="button button-ghost" type="button" data-staff-receipt-open="${escapeHtml(receiptId)}">Buka & review</button></div></article>`;
}

function ownerStaffReceiptDetailDialog() {
  if (staffReceiptDetail.status === "loading") return `<dialog id="staff-receipt-detail-dialog" class="staff-receipt-dialog" aria-labelledby="staff-receipt-detail-title"><div class="staff-receipt-dialog-header"><div><p class="eyebrow">Penerimaan karyawan</p><h2 id="staff-receipt-detail-title" tabindex="-1">Memuat rincian…</h2></div><button class="warehouse-receipt-dismiss" type="button" data-staff-receipt-close aria-label="Tutup rincian penerimaan">×</button></div><div class="staff-receipt-dialog-body" aria-busy="true"><p role="status">Mengambil receipt dan evidence terverifikasi.</p></div></dialog>`;
  if (staffReceiptDetail.status === "error") return `<dialog id="staff-receipt-detail-dialog" class="staff-receipt-dialog" aria-labelledby="staff-receipt-detail-title"><div class="staff-receipt-dialog-header"><div><p class="eyebrow">Penerimaan karyawan</p><h2 id="staff-receipt-detail-title" tabindex="-1">Rincian tidak dapat dibuka</h2></div><button class="warehouse-receipt-dismiss" type="button" data-staff-receipt-close aria-label="Tutup rincian penerimaan">×</button></div><div class="staff-receipt-dialog-body"><p class="inventory-inline-warning" role="alert">${escapeHtml(staffReceiptDetail.error)}</p></div></dialog>`;
  const payload = staffReceiptDetail.data ?? {};
  const receipt = payload.receipt ?? payload;
  const lines = receipt.lines ?? payload.lines ?? [];
  const evidence = receipt.evidence ?? payload.evidence ?? [];
  const events = payload.events ?? receipt.events ?? [];
  const exceptions = [...new Map([...(receipt.exceptions ?? receipt.exceptionReasons ?? payload.exceptions ?? []), ...lines.flatMap((line) => line.exceptionReasons ?? [])].map((item) => [staffReceiptReasonCode(item), item])).values()];
  const actor = receipt.actorName ?? receipt.actor?.displayName ?? receipt.actor?.name ?? staffReceiptActorName(receipt.actorStaffId);
  const posting = receipt.status === "POSTING";
  const reviewed = !["PENDING_REVIEW", "SUBMITTED", "POSTING"].includes(receipt.status);
  const mayReview = operatorHasReceiptCapability(payload, "inventory.receipt.review");
  const mayReadEvidence = operatorHasReceiptCapability(payload, "inventory.receipt.evidence.read");
  const lineRows = lines.map((line) => {
    const ingredient = line.ingredient ?? {};
    const purchase = line.purchaseOption ?? {};
    const unit = line.purchaseUnit ?? line.uom ?? line.baseUom ?? purchase.purchaseUnit ?? ingredient.baseUom ?? "unit";
    const delivered = line.deliveredQuantity ?? line.deliveredPurchaseQuantity ?? line.purchaseQuantity ?? line.quantity ?? 0;
    const accepted = line.acceptedQuantity ?? delivered;
    const rejected = line.rejectedQuantity ?? 0;
    const damaged = line.damagedQuantity ?? 0;
    const pendingInspection = line.pendingInspectionQuantity ?? line.pendingInspectionPurchaseQuantity ?? Math.max(0, Number(delivered) - Number(accepted) - Number(rejected) - Number(damaged));
    return `<li><div><strong>${escapeHtml(line.ingredientName ?? line.name ?? ingredient.name ?? "Bahan")}</strong>${staffReceiptCostAudit(line, purchase, accepted)}<small>${line.lotCode ? `Lot ${escapeHtml(line.lotCode)}` : "Tanpa lot"}${line.expiryDate ? ` · exp ${escapeHtml(line.expiryDate)}` : ""}</small></div><dl class="staff-receipt-disposition" aria-label="Disposition ${escapeHtml(line.ingredientName ?? line.name ?? ingredient.name ?? "bahan")}"><div><dt>Dikirim</dt><dd>${formatPlainNumber(delivered)} ${escapeHtml(unit)}</dd></div><div><dt>Diterima</dt><dd>${formatPlainNumber(accepted)} ${escapeHtml(unit)}</dd></div><div><dt>Ditolak</dt><dd>${formatPlainNumber(rejected)} ${escapeHtml(unit)}</dd></div><div><dt>Rusak / karantina</dt><dd>${formatPlainNumber(damaged)} ${escapeHtml(unit)}</dd></div><div><dt>Pending inspection</dt><dd>${formatPlainNumber(pendingInspection)} ${escapeHtml(unit)}</dd></div></dl>${line.movementId || receipt.movementId || receipt.postedReceiptId ? `<button class="button button-quiet button-small" type="button" data-staff-receipt-movement="${escapeHtml(line.movementId || receipt.movementId || receipt.postedReceiptId)}" data-staff-receipt-ingredient="${escapeHtml(line.ingredientId || "")}">Lihat movement</button>` : ""}</li>`;
  }).join("");
  const exceptionMarkup = exceptions.length ? `<ul class="staff-receipt-exceptions">${exceptions.map((item) => `<li><strong>${escapeHtml(item.label ?? staffReceiptExceptionLabel(item.code ?? item.type ?? item))}</strong>${item.message || item.detail ? `<span>${escapeHtml(item.message ?? item.detail)}</span>` : ""}</li>`).join("")}</ul>` : `<p class="owner-card-note">Tidak ada exception tercatat.</p>`;
  const eventMarkup = events.length ? `<ol class="staff-receipt-events">${events.map((item) => `<li><span>${escapeHtml(staffReceiptEventLabel(item.eventType ?? item.type))}<small>${escapeHtml(item.actorReference ?? staffReceiptActorName(item.actorStaffId))}</small></span><time datetime="${escapeHtml(item.occurredAt ?? "")}">${dateTime(item.occurredAt)}</time></li>`).join("")}</ol>` : `<p class="owner-card-note">Timeline audit belum tersedia untuk receipt ini.</p>`;
  const evidenceMarkup = mayReadEvidence ? ownerStaffReceiptEvidenceGrid(evidence) : `<p class="inventory-inline-warning">Akun ini belum memiliki capability membaca evidence.</p>`;
  const approvalBlockers = staffReceiptApprovalBlockers(payload);
  const blockerMarkup = approvalBlockers.length ? `<div class="inventory-inline-warning staff-receipt-cost-blocker" role="alert"><strong>Receipt belum dapat diposting</strong><span>Perbaiki ${escapeHtml(approvalBlockers.map((item) => item.label.toLocaleLowerCase("id-ID")).join(", "))}. Pilih Minta perbaikan dan tulis data yang harus dilengkapi.</span><ul>${approvalBlockers.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.guidance)}</span></li>`).join("")}</ul></div>` : "";
  const reviewForm = posting && mayReview
    ? `<form id="staff-receipt-review-form" class="staff-receipt-review"><div class="inventory-inline-warning staff-receipt-posting-notice" role="status"><strong>Posting stok belum selesai</strong><span>Receipt sedang atau sempat tersendat saat sinkronisasi. Coba sinkronkan lagi; data receipt tidak dapat diedit pada status ini.</span></div><input type="hidden" name="reason" value="${escapeHtml(receipt.reviewNote || "Mencoba kembali sinkronisasi posting stok")}"><div class="staff-receipt-review-actions"><button class="button button-primary" type="submit" name="decision" value="APPROVE" ${staffReceiptReviewPending ? "disabled" : ""}>Coba sinkronkan lagi</button></div><p class="form-status" role="status" aria-live="polite" data-staff-receipt-review-status></p></form>`
    : !reviewed && mayReview ? `<form id="staff-receipt-review-form" class="staff-receipt-review">${blockerMarkup}<label>Catatan keputusan<textarea name="reason" maxlength="500" rows="3" required placeholder="Tulis hasil pemeriksaan fisik, foto, jumlah, dan harga."></textarea></label><div class="staff-receipt-review-actions"><button class="button button-primary" type="submit" name="decision" value="APPROVE" ${staffReceiptReviewPending || approvalBlockers.length ? 'disabled aria-describedby="staff-receipt-approval-blocker-help"' : ""}>Setujui & posting</button><button class="button button-ghost" type="submit" name="decision" value="NEEDS_CORRECTION" ${staffReceiptReviewPending ? "disabled" : ""}>Minta perbaikan</button><button class="button button-danger" type="submit" name="decision" value="REJECT" ${staffReceiptReviewPending ? "disabled" : ""}>Tolak</button></div>${approvalBlockers.length ? '<p id="staff-receipt-approval-blocker-help" class="owner-card-note">Approval aktif setelah seluruh blocker posting diselesaikan.</p>' : ""}<p class="form-status" role="status" aria-live="polite" data-staff-receipt-review-status></p></form>`
      : `<p class="owner-card-note">${reviewed ? `Keputusan: ${escapeHtml(staffReceiptStatusLabel(receipt.status))}${receipt.reviewReason || receipt.reviewNote ? ` · ${escapeHtml(receipt.reviewReason ?? receipt.reviewNote)}` : ""}.` : "Capability review belum tersedia untuk akun ini."}</p>`;
  const totalCost = receipt.totalCostRupiah ?? (lines.length && lines.every((line) => line.costRupiah != null) ? lines.reduce((sum, line) => sum + Number(line.costRupiah), 0) : null);
  return `<dialog id="staff-receipt-detail-dialog" class="staff-receipt-dialog" aria-labelledby="staff-receipt-detail-title"><div class="staff-receipt-dialog-header"><div><p class="eyebrow">${escapeHtml(receipt.documentNumber || "Penerimaan karyawan")}</p><h2 id="staff-receipt-detail-title" tabindex="-1">${escapeHtml(receipt.supplierName || "Barang datang")}</h2><p>${escapeHtml(actor)} · ${dateTime(receipt.serverReceivedAt ?? receipt.submittedAt ?? receipt.createdAt)}</p></div><button class="warehouse-receipt-dismiss" type="button" data-staff-receipt-close aria-label="Tutup rincian penerimaan">×</button></div><div class="staff-receipt-dialog-body"><section class="staff-receipt-detail-summary"><div><span>Status</span><strong>${escapeHtml(staffReceiptStatusLabel(receipt.status))}</strong></div><div><span>Outlet</span><strong>${escapeHtml(receipt.outletName || receipt.locationName || "Outlet sesi")}</strong></div><div><span>Nilai</span><strong>${totalCost == null ? "Terbatas" : rupiah(totalCost)}</strong></div><div><span>Evidence</span><strong>${evidence.length} foto</strong></div></section>${ownerStaffReceiptTimeAudit(receipt)}<section><h3>Bahan diterima</h3><ul class="staff-receipt-lines">${lineRows || "<li>Belum ada baris bahan.</li>"}</ul></section><section><h3>Exception & pemeriksaan</h3>${exceptionMarkup}</section><section><div class="section-heading"><div><h3>Foto evidence</h3><p class="card-subtitle">Foto kiriman, bahan, label lot/expiry, dokumen, dan kerusakan.</p></div></div>${evidenceMarkup}</section><section><h3>Timeline audit</h3>${eventMarkup}</section>${ownerStaffReceiptCapabilitySnapshot(receipt, payload)}${reviewForm}</div></dialog>`;
}

function ownerStaffReceiptEvidenceGrid(evidence) {
  if (!evidence.length) return `<div class="inventory-empty staff-evidence-empty"><span aria-hidden="true">IMG</span><div><h4>Belum ada foto</h4><p>Receipt tidak dapat dianggap lengkap bila kebijakan mewajibkan evidence.</p></div></div>`;
  return `<div class="staff-evidence-grid">${evidence.map((item, index) => { const id = item.id ?? item.evidenceId; const url = item.contentUrl ?? item.thumbnailUrl ?? item.readUrl ?? item.url ?? (id && staffReceiptDetail.id ? `/api/operator/inventory-receipts/${encodeURIComponent(staffReceiptDetail.id)}/photos/${encodeURIComponent(id)}/content` : ""); const confidence = staffEvidenceTimeConfidence(item); return `<button type="button" data-staff-receipt-evidence="${escapeHtml(id)}" aria-label="Buka foto ${index + 1}: ${escapeHtml(staffEvidenceCategoryLabel(item.category))}">${url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="staff-evidence-placeholder" aria-hidden="true">IMG</span>'}<span><strong>${escapeHtml(staffEvidenceCategoryLabel(item.category))}</strong><small>${escapeHtml(item.caption || item.status || "Evidence")}</small><small>${escapeHtml(confidence.label)} · ${escapeHtml(staffEvidenceProvenance(item))}</small></span></button>`; }).join("")}</div>`;
}

function ownerStaffReceiptEvidenceDialog() {
  const payload = staffReceiptDetail.data ?? {};
  const receipt = payload.receipt ?? payload;
  const evidence = [...(receipt.evidence ?? payload.evidence ?? [])];
  const item = evidence.find((candidate) => String(candidate.id ?? candidate.evidenceId) === String(staffReceiptEvidenceId));
  if (!item) return "";
  const evidenceId = item.id ?? item.evidenceId;
  const url = item.contentUrl ?? item.readUrl ?? item.url ?? item.thumbnailUrl ?? `/api/operator/inventory-receipts/${encodeURIComponent(staffReceiptDetail.id)}/photos/${encodeURIComponent(evidenceId)}/content`;
  const confidence = staffEvidenceTimeConfidence(item);
  return `<dialog id="staff-receipt-evidence-dialog" class="staff-evidence-dialog" aria-labelledby="staff-receipt-evidence-title"><div class="staff-receipt-dialog-header"><div><p class="eyebrow">Evidence ${escapeHtml(staffEvidenceCategoryLabel(item.category))}</p><h2 id="staff-receipt-evidence-title" tabindex="-1">${escapeHtml(item.caption || receipt.supplierName || "Foto penerimaan")}</h2></div><button class="warehouse-receipt-dismiss" type="button" data-staff-evidence-close aria-label="Tutup foto evidence">×</button></div><figure>${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.caption || staffEvidenceCategoryLabel(item.category))}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="staff-evidence-placeholder">Foto belum tersedia</div>'}<figcaption><strong>${escapeHtml(item.ingredientName || "Foto kiriman")}</strong><span>Diambil: ${item.capturedAt ? dateTime(item.capturedAt) : "tidak dilaporkan"} · Upload server: ${item.uploadedAt ? dateTime(item.uploadedAt) : "tidak tersedia"}</span><span>${escapeHtml(confidence.label)} — ${escapeHtml(confidence.detail)}</span><span>${escapeHtml(staffEvidenceProvenance(item))}${item.width && item.height ? ` · ${escapeHtml(`${item.width}×${item.height}`)}` : ""}${item.byteSize ? ` · ${escapeHtml(staffEvidenceByteSize(item.byteSize))}` : ""}</span></figcaption></figure></dialog>`;
}

function ownerStaffReceiptCapabilityManager() {
  if (staffReceiptCapabilities.status === "idle" || (staffReceiptCapabilities.status === "loading" && !staffReceiptCapabilities.data)) {
    return `<details class="staff-capability-manager"><summary>Atur akses Barang Datang</summary><p role="status" aria-busy="true">Memuat akun karyawan…</p></details>`;
  }
  if (staffReceiptCapabilities.status === "error" && !staffReceiptCapabilities.data) {
    return `<details class="staff-capability-manager"><summary>Atur akses Barang Datang</summary><div class="inventory-inline-warning" role="status"><strong>Pengaturan izin belum tersedia</strong><span>${escapeHtml(staffReceiptCapabilities.error)}</span></div></details>`;
  }
  const staff = (staffReceiptCapabilities.data?.staff ?? []).filter((person) => person.accountState !== "suspended" && person.status !== "inactive");
  const assignments = staffReceiptCapabilities.data?.assignments ?? [];
  const capabilityNames = [
    ["inventory.receipt.capture", "Buat draft", "Mengisi receipt dan menambahkan foto."],
    ["inventory.receipt.submit", "Kirim receipt", "Mengirim receipt untuk diproses."],
    ["inventory.receipt.post", "Posting langsung", "Receipt normal dapat langsung menambah stok."],
    ["inventory.receipt.review", "Review exception", "Menyetujui atau menolak receipt exception."],
    ["inventory.receipt.cost.write", "Isi harga", "Melihat dan mengisi nilai pembelian."],
    ["inventory.receipt.evidence.read", "Lihat evidence", "Membuka foto receipt setelah tersimpan."],
  ];
  const rows = staff.map((person) => {
    const staffId = person.id ?? person.staffId;
    const assignment = assignments.find((item) => String(item.staffId ?? item.id) === String(staffId));
    const granted = new Set(assignment?.capabilities ?? person.inventoryReceiptCapabilities ?? []);
    return `<form class="staff-capability-form" data-staff-receipt-capability-form data-staff-id="${escapeHtml(staffId)}"><input type="hidden" name="staffId" value="${escapeHtml(staffId)}"><details><summary><span><strong>${escapeHtml(person.name ?? person.displayName ?? person.employeeCode ?? "Karyawan")}</strong><small>${escapeHtml(person.employeeCode ?? person.role ?? "Akun staff")} · ${granted.size}/6 izin aktif</small></span><span aria-hidden="true">⌄</span></summary><fieldset><legend>Pilih izin penerimaan barang</legend>${capabilityNames.map(([value, label, note]) => `<label><input type="checkbox" name="capabilities" value="${value}" ${granted.has(value) ? "checked" : ""}><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(note)}</small></span></label>`).join("")}</fieldset><div class="staff-capability-actions"><p class="form-status" role="status" aria-live="polite" data-staff-capability-status></p><button class="button button-primary" type="submit" ${staffReceiptCapabilityPending ? "disabled" : ""}>Simpan izin</button></div></details></form>`;
  }).join("");
  return `<details class="staff-capability-manager"><summary><span><strong>Atur akses Barang Datang</strong><small>Aktifkan per karyawan; jabatan tidak memberi akses otomatis.</small></span><span class="status-badge">${staff.length} akun</span></summary><div class="staff-capability-manager-body"><p>Untuk pencatat biasa, aktifkan Buat draft, Kirim receipt, dan Lihat evidence. Posting langsung serta harga sebaiknya hanya untuk petugas yang ditunjuk.</p>${rows || '<p class="owner-card-note">Belum ada akun karyawan aktif.</p>'}</div></details>`;
}

function ownerStaffReceiptCapabilitySnapshot(receipt, payload) {
  const capabilities = receipt.actorCapabilitySnapshot ?? receipt.actorCapabilities ?? payload.actorCapabilities;
  if (!capabilities) return "";
  const names = ["inventory.receipt.capture", "inventory.receipt.submit", "inventory.receipt.post", "inventory.receipt.review", "inventory.receipt.cost.write", "inventory.receipt.evidence.read"];
  return `<details class="staff-receipt-capabilities"><summary>Izin karyawan saat receipt dibuat</summary><ul>${names.map((name) => { const enabled = Array.isArray(capabilities) ? capabilities.includes(name) : Boolean(capabilities[name]); return `<li><span>${escapeHtml(name)}</span><strong class="${enabled ? "is-enabled" : ""}">${enabled ? "Aktif" : "Tidak aktif"}</strong></li>`; }).join("")}</ul><p>Izin ini adalah snapshot audit. Perubahan akun karyawan dilakukan dari pengaturan tim.</p></details>`;
}

function operatorHasReceiptCapability(payload, capability) {
  const capabilities = payload.operatorCapabilities ?? payload.capabilities;
  if (!capabilities) return true;
  return Array.isArray(capabilities) ? capabilities.includes(capability) : capabilities[capability] === true;
}

function staffReceiptApprovalBlockers(payload = {}) {
  const receipt = payload?.receipt ?? payload ?? {};
  const lines = receipt.lines ?? payload?.lines ?? [];
  const reportedSources = [payload?.approvalBlockers, receipt.approvalBlockers, payload?.approval?.blockers, receipt.approval?.blockers, payload?.review?.blockingReasons, receipt.review?.blockingReasons, payload?.postingBlockers, receipt.postingBlockers, payload?.blockingExceptions, receipt.blockingExceptions, payload?.blockingExceptionReasons, receipt.blockingExceptionReasons];
  const reported = reportedSources.find(Array.isArray);
  const fallbackCodes = new Set(["ACCEPTED_QUANTITY_REQUIRED", "REJECTED_QUANTITY", "COST_REQUIRES_REVIEW", "INGREDIENT_DUPLICATE", "CONDITION_INVALID", "LOT_REQUIRED", "EXPIRY_REQUIRED", "SHELF_LIFE_TOO_SHORT"]);
  const reasons = [
    ...(receipt.exceptions ?? receipt.exceptionReasons ?? payload?.exceptions ?? []),
    ...lines.flatMap((line) => line.exceptions ?? line.exceptionReasons ?? []),
  ];
  const candidates = reported ?? reasons.filter((item) => { const code = staffReceiptReasonCode(item); return fallbackCodes.has(code) || code.startsWith("CANONICAL_"); });
  if (!reported) {
    const ingredientIds = new Set();
    for (const line of lines) {
      const delivered = Number(line.deliveredQuantity ?? line.deliveredPurchaseQuantity ?? line.purchaseQuantity ?? line.quantity ?? 0);
      const accepted = Number(line.acceptedQuantity ?? 0);
      const rejected = Number(line.rejectedQuantity ?? 0);
      const damaged = Number(line.damagedQuantity ?? 0);
      const ingredientId = String(line.ingredientId ?? "");
      if (accepted <= 0) candidates.push("ACCEPTED_QUANTITY_REQUIRED");
      if (rejected > 0) candidates.push("REJECTED_QUANTITY");
      if (line.costRupiah == null || !Number.isSafeInteger(Number(line.costRupiah)) || Number(line.costRupiah) <= 0) candidates.push("COST_REQUIRES_REVIEW");
      if (ingredientId && ingredientIds.has(ingredientId)) candidates.push("INGREDIENT_DUPLICATE");
      ingredientIds.add(ingredientId);
      const condition = String(line.conditionCode ?? "GOOD");
      const classified = accepted + rejected + damaged;
      if ((condition === "GOOD" && (rejected > 0 || damaged > 0)) || (condition === "DAMAGED" && damaged <= 0) || (condition === "REJECTED" && rejected <= 0) || (condition === "SHORT" && classified >= delivered)) candidates.push("CONDITION_INVALID");
      const ingredient = line.ingredient ?? {};
      if (ingredient.lotTrackingPolicy === "REQUIRED" && !line.lotCode) candidates.push("LOT_REQUIRED");
      if (Number(ingredient.minimumShelfLifeDays ?? 0) > 0 && !line.expiryDate) candidates.push("EXPIRY_REQUIRED");
    }
  }
  const unique = new Map();
  for (const item of candidates) {
    const code = staffReceiptReasonCode(item);
    if (!code || unique.has(code)) continue;
    unique.set(code, {
      code,
      label: item?.label ?? staffReceiptExceptionLabel(code),
      guidance: item?.message ?? item?.guidance ?? staffReceiptBlockerGuidance(code),
    });
  }
  if (!unique.size && (payload?.approvalBlocked === true || receipt.approvalBlocked === true)) {
    unique.set("APPROVAL_BLOCKED", { code: "APPROVAL_BLOCKED", label: "Pemeriksaan backend belum selesai", guidance: "Minta perbaikan dan periksa ulang detail receipt sebelum posting." });
  }
  return [...unique.values()];
}

function staffReceiptReasonCode(item) {
  return String(item?.code ?? item?.reason ?? item?.type ?? item ?? "").trim().toUpperCase();
}

function staffReceiptBlockerGuidance(code) {
  return ({
    ACCEPTED_QUANTITY_REQUIRED: "Isi jumlah yang benar-benar diterima; nilai nol tidak dapat menambah stok.",
    REJECTED_QUANTITY: "Barang ditolak memerlukan koreksi atau referensi PO sebelum receipt dapat diposting.",
    COST_REQUIRES_REVIEW: "Lengkapi harga final atau nota agar HPP tidak terbentuk dari biaya kosong.",
    INGREDIENT_DUPLICATE: "Gabungkan bahan yang sama menjadi satu baris disposition yang konsisten.",
    CONDITION_INVALID: "Samakan kondisi barang dengan jumlah diterima, ditolak, rusak, dan pending inspection.",
    LOT_REQUIRED: "Isi nomor lot untuk bahan yang wajib dilacak.",
    EXPIRY_REQUIRED: "Isi tanggal kedaluwarsa untuk bahan dengan aturan masa simpan.",
    SHELF_LIFE_TOO_SHORT: "Ganti atau koreksi barang karena masa simpannya lebih pendek dari kebijakan bahan.",
  })[code] ?? (code.startsWith("CANONICAL_") ? "Posting canonical menolak data ini. Minta perbaikan lalu kirim ulang receipt." : "Selesaikan pemeriksaan backend ini sebelum posting stok.");
}

function staffReceiptCostAudit(line, purchase, acceptedQuantity) {
  const cost = line.totalCostRupiah ?? line.costRupiah;
  const source = line.costSource ?? line.cost?.source ?? "UNAVAILABLE";
  const referencePerUnit = line.referencePriceRupiah ?? line.referenceCostPerUnitRupiah ?? purchase.referencePriceRupiah ?? purchase.referenceCostRupiah;
  const referenceTotal = line.referenceTotalRupiah ?? (Number.isFinite(Number(referencePerUnit)) && Number(referencePerUnit) > 0 ? Number(referencePerUnit) * Number(acceptedQuantity) : null);
  const variance = line.costVarianceRupiah ?? line.priceVarianceRupiah ?? (cost != null && referenceTotal != null ? Number(cost) - Number(referenceTotal) : null);
  const variancePct = line.costVariancePct ?? line.priceVariancePct ?? (variance != null && Number(referenceTotal) !== 0 ? Number(variance) / Number(referenceTotal) * 100 : null);
  const sourceLabel = ({ STAFF_CONFIRMED: "Diisi karyawan", APPROVED_OPTION: "Harga acuan pilihan beli", OWNER_CONFIRMED: "Dikonfirmasi Owner", UNAVAILABLE: "Sumber belum tersedia" })[source] ?? String(source).replaceAll("_", " ");
  return `<span class="staff-receipt-cost-value">${cost == null ? "Biaya disembunyikan/belum final" : rupiah(cost)}</span><small class="staff-receipt-cost-audit">Sumber: ${escapeHtml(sourceLabel)}${referenceTotal == null ? " · Referensi tidak tersedia" : ` · Referensi ${rupiah(referenceTotal)}`}${variance == null ? " · Variance belum tersedia" : ` · Variance ${variance >= 0 ? "+" : "−"}${rupiah(Math.abs(variance))}${variancePct == null ? "" : ` (${variancePct >= 0 ? "+" : "−"}${formatPlainNumber(Math.abs(variancePct))}%)`}`}</small>`;
}

function ownerStaffReceiptTimeAudit(receipt) {
  const physicalAt = receipt.physicalOccurredAt ?? receipt.physicalReceivedAt ?? receipt.receivedAt ?? receipt.capturedAt;
  const serverAt = receipt.serverReceivedAt ?? receipt.createdAt;
  return `<section class="staff-receipt-time-audit" aria-labelledby="staff-receipt-time-title"><h3 id="staff-receipt-time-title">Waktu operasional</h3><dl><div><dt>Fisik diterima</dt><dd>${physicalAt ? dateTime(physicalAt) : "Tidak dilaporkan"}</dd></div><div><dt>Tanggal bisnis</dt><dd>${escapeHtml(receipt.businessDate || "Tidak tersedia")}</dd></div><div><dt>Server mencatat</dt><dd>${serverAt ? dateTime(serverAt) : "Tidak tersedia"}</dd></div><div><dt>Dikirim untuk review</dt><dd>${receipt.submittedAt ? dateTime(receipt.submittedAt) : "Belum dikirim"}</dd></div></dl></section>`;
}

function staffEvidenceTimeConfidence(item) {
  if (item.timeConfidence) return { label: String(item.timeConfidenceLabel ?? item.timeConfidence), detail: String(item.timeConfidenceDetail ?? "Nilai confidence dilaporkan oleh server.") };
  if (!item.capturedAt) return { label: "Waktu foto tidak tersedia", detail: "Gunakan waktu upload server sebagai batas audit, bukan waktu pengambilan fisik." };
  if (!item.uploadedAt) return { label: "Waktu upload belum tersedia", detail: "Waktu pengambilan berasal dari perangkat dan belum dapat dibandingkan dengan server." };
  const captured = new Date(item.capturedAt).getTime();
  const uploaded = new Date(item.uploadedAt).getTime();
  if (!Number.isFinite(captured) || !Number.isFinite(uploaded)) return { label: "Waktu evidence tidak valid", detail: "Periksa metadata evidence sebelum mengambil keputusan." };
  const deltaMinutes = Math.round(Math.abs(uploaded - captured) / 60_000);
  if (captured > uploaded + 5 * 60_000) return { label: "Jam perangkat tidak konsisten", detail: `Foto tercatat ${deltaMinutes} menit setelah waktu upload server.` };
  if (deltaMinutes <= 15) return { label: "Waktu foto konsisten", detail: `Selisih perangkat dan upload server ${deltaMinutes} menit.` };
  return { label: "Jeda upload perlu review", detail: `Foto baru terunggah sekitar ${deltaMinutes} menit setelah diambil.` };
}

function staffEvidenceProvenance(item) {
  const source = item.provenanceLabel ?? item.provenance ?? item.sourceLabel ?? item.source ?? "Upload portal staff";
  const checksum = String(item.checksum ?? item.checksumSha256 ?? "");
  return `${source}${checksum ? ` · SHA-256 …${checksum.slice(-8)}` : " · checksum tidak tersedia"}`;
}

function staffEvidenceByteSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "ukuran tidak tersedia";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatPlainNumber(bytes / 1024)} KB`;
  return `${formatPlainNumber(bytes / 1024 / 1024)} MB`;
}

function staffReceiptIdentity(receipt) { return receipt?.id ?? receipt?.receiptId ?? ""; }

function staffReceiptActorName(staffId) {
  const person = (staffReceiptCapabilities.data?.staff ?? []).find((item) => String(item.id ?? item.staffId) === String(staffId));
  return person?.name ?? person?.displayName ?? person?.employeeCode ?? staffId ?? "Karyawan";
}

function staffReceiptStatusLabel(status) {
  return ({ ALL: "Semua status", DRAFT: "Draft", SUBMITTED: "Dikirim", PENDING_REVIEW: "Menunggu review", POSTING: "Sinkronisasi stok", POSTED: "Sudah masuk stok", NEEDS_CORRECTION: "Perlu diperbaiki", REQUESTED_CORRECTION: "Perlu diperbaiki", CORRECTION_REQUESTED: "Perlu diperbaiki", REJECTED: "Ditolak" })[status] ?? String(status || "Status belum tersedia").replaceAll("_", " ");
}

function staffReceiptExceptionLabel(value) {
  return ({ ACCEPTED_QUANTITY_REQUIRED: "Jumlah diterima wajib diisi", REJECTED_QUANTITY: "Barang ditolak perlu dikoreksi", COST_REQUIRES_REVIEW: "Harga perlu diverifikasi", INGREDIENT_DUPLICATE: "Bahan tercatat ganda", CONDITION_INVALID: "Disposition tidak sesuai kondisi", LOT_REQUIRED: "Nomor lot wajib diisi", EXPIRY_REQUIRED: "Tanggal kedaluwarsa wajib diisi", SHELF_LIFE_TOO_SHORT: "Masa simpan terlalu pendek", PRICE_OUT_OF_TOLERANCE: "Harga di luar toleransi", QUANTITY_MISMATCH: "Jumlah tidak sesuai", DAMAGED_ITEM: "Barang rusak", DAMAGED_QUANTITY: "Barang rusak masuk karantina", REJECTED_ITEM: "Barang ditolak", MISSING_EVIDENCE: "Evidence belum lengkap", RECEIPT_EVIDENCE_REQUIRED: "Foto kiriman wajib dilengkapi", LINE_EVIDENCE_REQUIRED: "Foto bahan wajib dilengkapi", LOT_EXPIRY_EVIDENCE_REQUIRED: "Foto lot dan expiry wajib dilengkapi", MISSING_LOT: "Lot belum diisi", MISSING_EXPIRY: "Expiry belum diisi", BACKDATED: "Tanggal mundur", NOT_SAME_BUSINESS_DAY: "Tanggal bisnis berbeda", SUPPLIER_REQUIRED: "Supplier wajib diisi", STAFF_POST_NOT_ALLOWED: "Posting memerlukan review Owner", UNKNOWN_ITEM: "Bahan tidak dikenal" })[value] ?? String(value || "Perlu review").replaceAll("_", " ");
}

function staffEvidenceCategoryLabel(value) {
  return ({ DELIVERY_OVERVIEW: "Kondisi kiriman", ITEM_CONDITION: "Kondisi bahan", LOT_EXPIRY_LABEL: "Label lot & expiry", DOCUMENT: "Nota / surat jalan", DAMAGE: "Kerusakan", OTHER: "Lainnya" })[value] ?? "Foto evidence";
}

function staffReceiptEventLabel(value) {
  return ({ DRAFT_CREATED: "Draft dibuat", DRAFT_UPDATED: "Draft diperbarui", PHOTO_INITIALIZED: "Upload foto dimulai", PHOTO_VERIFIED: "Foto terverifikasi", RECEIPT_SUBMITTED: "Receipt dikirim", REVIEW_REQUESTED: "Review diminta", POSTING_STAGED: "Sinkronisasi stok dimulai", POSTING_RETURNED_TO_REVIEW: "Posting dikembalikan untuk review", REVIEW_APPROVE: "Disetujui Owner", REVIEW_REJECT: "Ditolak Owner", REVIEW_NEEDS_CORRECTION: "Perbaikan diminta", RECEIPT_POSTED: "Stok diposting" })[value] ?? String(value || "Aktivitas receipt").replaceAll("_", " ");
}

function ownerWarehouseStockCountPanel(data) {
  const balances = data.warehouse?.balances ?? [];
  const balanceByIngredient = new Map(balances.map((item) => [item.ingredientId, item]));
  const activeIngredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE");
  if (!activeIngredients.length) return "";
  const openingBaseline = !(data.warehouse?.countSessions ?? []).some((item) => item.countKind === "OPENING_BASELINE");
  const countItems = openingBaseline ? activeIngredients.map((ingredient) => ({
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    baseUom: ingredient.baseUom,
    onHandBase: balanceByIngredient.get(ingredient.id)?.onHandBase ?? "0.000000",
    unitCost: Number(ingredient.currentAverageCostPerBaseUnitRupiah),
  })) : balances;
  if (!warehouseCountOpen && !balances.length) return `<details id="warehouse-stock-count" class="inventory-advanced-tools warehouse-count-tools"><summary data-warehouse-count-toggle>${openingBaseline ? "Masukkan stok awal" : "Hitung stok fisik"}</summary></details>`;
  if (!warehouseCountOpen) requestAnimationFrame(() => content.querySelector("#warehouse-stock-count")?.removeAttribute("open"));
  if (warehouseCountOpen && warehouseCountDraftRevision == null) warehouseCountDraftRevision = data.revision;
  const revision = warehouseCountDraftRevision ?? data.revision;
  const stale = String(revision) !== String(data.revision);
  const missingOpeningCost = openingBaseline && countItems.some((item) => !Number.isFinite(item.unitCost) || item.unitCost <= 0);
  const countInputs = countItems.map((item) => {
    const value = Object.hasOwn(warehouseCountDraftLines, item.ingredientId) ? warehouseCountDraftLines[item.ingredientId] : "";
    return `<label>${escapeHtml(item.ingredientName)}<input data-count-ingredient="${escapeHtml(item.ingredientId)}" data-unit-cost="${escapeHtml(item.unitCost ?? "")}" name="quantity:${escapeHtml(item.ingredientId)}" type="number" min="0" max="1000000000" step="0.000001" placeholder="Isi hasil hitung fisik" value="${escapeHtml(value)}" required><small>${escapeHtml(item.baseUom)} · angka sistem ${formatInventoryQuantity(item.onHandBase, item.baseUom)}${openingBaseline ? ` · biaya ${Number.isFinite(item.unitCost) && item.unitCost > 0 ? rupiah(item.unitCost) : "belum diisi"}/${escapeHtml(item.baseUom)}` : ""}</small></label>`;
  }).join("");
  return `<details id="warehouse-stock-count" class="inventory-advanced-tools warehouse-count-tools" open><summary data-warehouse-count-toggle>${openingBaseline ? "Masukkan stok awal" : "Hitung stok fisik"}</summary><article class="dashboard-card inventory-count-card"><div class="section-heading"><div><p class="eyebrow">${openingBaseline ? "Baseline pembukaan" : "Rekonsiliasi fisik"}</p><h2>${openingBaseline ? "Stok awal outlet" : "Full stock count"}</h2><p class="card-subtitle">${openingBaseline ? "Isi jumlah fisik semua bahan, termasuk angka nol. Ini bukan pembelian supplier dan akan dicatat sebagai baseline pembukaan." : "Isi hasil hitung fisik setiap bahan; angka sistem hanya pembanding. Berhenti memakai bahan sejenak atau catat semua pemakaian dan penerimaan selama menghitung."}</p></div><span class="status-badge is-warning">${countItems.length} bahan</span></div>${missingOpeningCost ? '<p class="inventory-inline-warning" role="alert">Masih ada bahan tanpa biaya positif. Lengkapi biaya di Database bahan sebelum membuat stok awal.</p>' : ""}<p class="owner-card-note">Jika stok bergerak sebelum disimpan, hitung ulang. Perubahan versi lain akan ditolak agar angka lama tidak menimpa stok terbaru.</p>${stale ? '<p class="inventory-inline-warning" role="status">Stok berubah sejak penghitungan dimulai. Mulai hitung ulang sebelum menyimpan hasil.</p>' : ""}<form id="warehouse-count-form" class="inventory-compact-form" data-count-revision="${escapeHtml(revision)}"><input type="hidden" name="countKind" value="${openingBaseline ? "OPENING_BASELINE" : "CYCLE"}"><input type="hidden" name="businessDate" value="${escapeHtml(data.businessDate)}">${countInputs}<label class="inventory-form-wide">Alasan<input name="reason" maxlength="160" value="${escapeHtml(openingBaseline ? "Stok awal fisik outlet" : warehouseCountDraftReason)}" required></label><label class="inventory-form-wide"><input name="countMovementChecked" type="checkbox" required ${warehouseCountMovementChecked ? "checked" : ""}> Saya sudah memasukkan semua pergerakan stok selama penghitungan dan angka ini sesuai kondisi fisik saat disimpan.</label><div class="inventory-form-actions inventory-form-wide"><button class="button button-primary" type="submit" ${stale || missingOpeningCost ? "disabled" : ""}>Selesaikan stock count</button><button class="button button-ghost" type="button" data-warehouse-count-reset>Mulai hitung ulang</button></div></form></article></details>`;
}

function ownerWarehouseCorrectionsPanel(data) {
  const entries = (data.warehouse?.ledgerEntries ?? []).filter((item) => item.movementId).slice(0, 12);
  if (!entries.length) return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Koreksi transaksi</p><h2>Belum ada transaksi yang perlu dikoreksi</h2><p class="card-subtitle">Waste dan adjustment akan muncul di sini tanpa menghapus histori aslinya.</p></div></div></article>`;
  const rows = entries.map((item) => `<tr><th scope="row">${escapeHtml(item.ingredientName)}<small>${escapeHtml(warehouseMovementLabel(item.sourceType))}</small></th><td>${dateTime(item.occurredAt)}</td><td>${formatSignedInventoryQuantity(item.quantityDeltaBase)}</td><td>${item.reversible ? `<button class="button button-quiet button-small" type="button" data-warehouse-reverse="${escapeHtml(item.movementId)}" data-warehouse-ingredient="${escapeHtml(item.ingredientName)}">Koreksi transaksi</button>` : '<span class="status-badge is-muted">Terkunci</span>'}</td></tr>`).join("");
  return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Koreksi transaksi</p><h2>Movement stok terbaru</h2><p class="card-subtitle">Koreksi membuat reversal baru; catatan asli tidak pernah dihapus.</p></div></div><div class="dashboard-table" role="region" aria-label="Transaksi stok yang dapat dikoreksi" tabindex="0"><table><thead><tr><th>Bahan</th><th>Waktu</th><th>Perubahan</th><th>Aksi</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function ownerWarehouseExpiryPanel(data) {
  const lots = data.warehouse?.expiringLots ?? [];
  const lotStatus = data.warehouse?.lotReconciliation?.status ?? "NOT_TRACKED";
  const lotUnverified = !["VERIFIED", "NOT_TRACKED", "EXPIRED_STOCK"].includes(lotStatus);
  if (!lots.length && lotUnverified) return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Prioritas FEFO</p><h2>Batch belum dapat diverifikasi</h2><p class="card-subtitle">Histori batch atau pemakaian belum lengkap. Periksa stok fisik sebelum memutuskan bahan aman digunakan.</p></div><span class="status-badge is-warning">Perlu pemeriksaan</span></div></article>`;
  if (!lots.length) return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Prioritas FEFO</p><h2>Tidak ada peringatan batch terlacak</h2><p class="card-subtitle">Batch terlacak yang kedaluwarsa dalam 30 hari akan tampil paling awal di sini.</p></div><span class="status-badge is-ready">Tidak ada peringatan</span></div></article>`;
  const locations = new Map((data.warehouse?.locations ?? []).map((item) => [item.id, item.name]));
  const expiredCount = lots.filter((lot) => lot.urgency === "EXPIRED").length;
  const criticalCount = lots.filter((lot) => lot.urgency === "CRITICAL").length;
  const rows = lots.map((lot) => {
    const action = lot.urgency === "EXPIRED" ? "Pisahkan" : lotUnverified ? "Periksa fisik" : lot.urgency === "CRITICAL" ? "Gunakan dulu" : "Pantau";
    return `<tr><th scope="row">${escapeHtml(lot.ingredientName)}<small>Batch ${escapeHtml(lot.lotCode)}</small></th><td><strong>${escapeHtml(expiryPriorityLabel(lot.daysUntilExpiry))}</strong><small>${escapeHtml(lot.expiryDate)}</small></td><td>${escapeHtml(sharedStorageHistoryLabel(lot.locationId, locations))}</td><td>${formatPlainNumber(lot.acceptedPurchaseQuantity)}${lot.purchaseUnitLabel ? ` <small>${escapeHtml(lot.purchaseUnitLabel)}</small>` : ""}</td><td><span class="status-badge ${lot.urgency === "EXPIRED" ? "is-blocked" : "is-warning"}">${action}</span></td></tr>`;
  }).join("");
  return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Prioritas FEFO</p><h2>${lots.length} batch perlu diperiksa</h2><p class="card-subtitle">Urutan tanggal terdekat membantu tim memakai bahan yang lebih dulu kedaluwarsa.</p></div><div class="inventory-stock-summary">${expiredCount ? `<span class="status-badge is-blocked">${expiredCount} lewat tanggal</span>` : ""}${criticalCount ? `<span class="status-badge is-warning">${criticalCount} dalam 7 hari</span>` : ""}</div></div><div class="dashboard-table" role="region" aria-label="Prioritas batch berdasarkan kedaluwarsa" tabindex="0"><table><thead><tr><th>Bahan</th><th>Gunakan lebih dulu</th><th>Lokasi masuk</th><th>Diterima</th><th>Tindakan</th></tr></thead><tbody>${rows}</tbody></table></div><p class="owner-card-note">Jumlah di atas adalah jumlah saat diterima, bukan sisa batch saat ini. Pisahkan bahan lewat tanggal dan catat pengurangannya sebagai waste agar stok tetap dapat diaudit.</p></article>`;
}

function expiryPriorityLabel(daysUntilExpiry) {
  const days = Number(daysUntilExpiry);
  if (!Number.isInteger(days)) return "Tanggal perlu diperiksa";
  if (days < 0) return `Lewat ${Math.abs(days)} hari`;
  if (days === 0) return "Hari ini";
  return `${days} hari lagi`;
}

function sharedStorageHistoryLabel(locationId, locationNames) {
  if (locationNames.has(locationId)) return locationNames.get(locationId);
  const primary = [...locationNames.values()][0] || "Penyimpanan bersama";
  if (String(locationId).endsWith(":BAR")) return `${primary} (catatan lama: Bar)`;
  if (String(locationId).endsWith(":KITCHEN")) return `${primary} (catatan lama: Dapur)`;
  return "Lokasi tidak tercatat";
}

function ownerWarehouseTransferPanel(data, ingredientOptions) {
  const locations = data.warehouse?.locations ?? [];
  const locationName = new Map(locations.map((item) => [item.id, item.name]));
  const locationVerified = data.warehouse?.ledgerReconciliation?.locationStatus === "VERIFIED";
  const balances = locationVerified ? (data.warehouse?.locationBalances ?? []).filter((item) => Number(item.onHandBase) !== 0) : [];
  const rows = balances.map((item) => `<tr><th scope="row">${escapeHtml(item.ingredientName || item.ingredientId)}</th><td>${escapeHtml(locationName.get(item.locationId) || item.locationId)}</td><td>${formatInventoryQuantity(item.onHandBase, item.baseUom)}</td></tr>`).join("");
  const locationOptions = locations.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  const destinationOptions = locations.map((item, index) => `<option value="${escapeHtml(item.id)}" ${index === 1 ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const balancePanel = !locationVerified ? '<p class="owner-card-note">Saldo per lokasi belum terverifikasi. Cocokkan dengan hitung fisik sebelum transfer.</p>'
    : rows ? `<div class="dashboard-table" role="region" aria-label="Saldo per lokasi" tabindex="0"><table><thead><tr><th>Bahan</th><th>Lokasi</th><th>Jumlah</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="owner-card-note">Belum ada saldo per lokasi.</p>';
  return `<article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Lokasi stok</p><h2>Transfer antar lokasi</h2><p class="card-subtitle">Pindahkan bahan dari Gudang Utama ke Bar atau Dapur. Total stok dan nilai persediaan tetap sama.</p></div></div><form id="warehouse-transfer-form" class="inventory-compact-form"><label>Bahan<select name="ingredientId" required>${ingredientOptions}</select></label><label>Dari<select name="sourceLocationId" required>${locationOptions}</select></label><label>Ke<select name="destinationLocationId" required>${destinationOptions}</select></label><label>Jumlah dasar<input name="quantityBase" type="number" min="0.000001" max="1000000000" step="0.000001" required></label><label class="inventory-form-wide">Alasan<input name="reason" maxlength="160" value="Memindahkan stok antar lokasi" required></label><button class="button button-primary" type="submit">Transfer stok</button><p id="inventory-mutation-status" class="form-status" role="status" aria-live="polite"></p></form>${balancePanel}</article>`;
}

function normalizeWarehouseSearch(value) {
  return String(value ?? "").trim().toLocaleLowerCase("id-ID").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function applyWarehouseStockSearch() {
  const input = content.querySelector("#warehouse-stock-search");
  if (!input) return;
  const query = normalizeWarehouseSearch(input.value);
  warehouseSearchQuery = input.value.slice(0, 80);
  const filterRows = (selector) => {
    const rows = [...content.querySelectorAll(selector)];
    let visible = 0;
    rows.forEach((row) => {
      const matches = !query || normalizeWarehouseSearch(row.dataset.warehouseSearchValue).includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    return { total: rows.length, visible };
  };
  const stock = filterRows("[data-warehouse-stock-row]");
  const receipts = filterRows("[data-warehouse-receipt-row]");
  const status = content.querySelector("[data-warehouse-search-status]");
  if (status) status.textContent = query
    ? `${stock.visible} bahan dan ${receipts.visible} penerimaan ditemukan.`
    : `${stock.total} bahan aktif dan ${receipts.total} penerimaan terbaru.`;
  const stockEmpty = content.querySelector("[data-warehouse-stock-no-results]");
  if (stockEmpty) stockEmpty.hidden = !query || stock.visible > 0;
  const receiptEmpty = content.querySelector("[data-warehouse-receipt-no-results]");
  if (receiptEmpty) receiptEmpty.hidden = !query || receipts.visible > 0;
}

function ownerWarehouseMovementPanel(data, ingredients) {
  if (!ingredients.length || !(data.warehouse?.balances ?? []).length) return "";
  const ingredientOptions = ingredients.filter((ingredient) => (data.warehouse?.balances ?? []).some((balance) => balance.ingredientId === ingredient.id))
    .map((ingredient) => `<option value="${escapeHtml(ingredient.id)}">${escapeHtml(ingredient.name)} · ${escapeHtml(ingredient.baseUom)}</option>`).join("");
  const sharedLocationId = data.warehouse?.locations?.[0]?.id ?? "";
  return `<article class="dashboard-card warehouse-movement-card"><div class="section-heading"><div><p class="eyebrow">Stok fisik berkurang</p><h2>Waste & pemakaian internal</h2><p class="card-subtitle">Gudang, Bar, dan Dapur memakai satu saldo stok. Catat bahan, jumlah, dan alasan tanpa membuka halaman lain.</p></div></div><details><summary>Catat stok berkurang</summary><form id="warehouse-movement-form" class="inventory-compact-form"><input type="hidden" name="locationId" value="${escapeHtml(sharedLocationId)}"><label>Bahan<select name="ingredientId" required>${ingredientOptions}</select></label><label>Jenis<select name="movementType" required><option value="SPOILAGE_WASTE">Rusak / basi</option><option value="PRODUCTION_WASTE">Waste produksi</option><option value="DAMAGED">Kemasan rusak</option><option value="INTERNAL_USE">Pemakaian internal</option><option value="SAMPLES_PROMOTIONAL">Sampel / promosi</option><option value="LOSS_THEFT">Hilang</option></select></label><label>Jumlah satuan dasar<input name="quantityBase" type="number" min="0.000001" max="1000000000" step="0.000001" required></label><label class="inventory-form-wide">Alasan<input name="reason" maxlength="160" required></label><button class="button button-primary" type="submit">Catat pengurangan stok</button><p id="warehouse-movement-status" class="form-status" role="status" aria-live="polite"></p></form></details></article>`;
}

function ownerWarehouseReceiptDialog(data, ingredientOptions) {
  const balances = data.warehouse?.balances ?? [];
  const ingredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE" && item.purchasable !== false && item.sourcingMode !== "MADE_IN_HOUSE" && item.materialType !== "PREP_ITEM");
  ensureWarehouseReceiptAttemptKey();
  const purchaseOptions = (data.ingredients?.purchaseOptions ?? [])
    .filter((option) => ingredients.some((ingredient) => ingredient.id === option.ingredientId))
    .sort((a, b) => Number(Boolean(b.preferred)) - Number(Boolean(a.preferred)) || String(a.label).localeCompare(String(b.label), "id"));
  const selectedOption = purchaseOptions[0];
  const selectedIngredient = ingredients.find((item) => item.id === selectedOption?.ingredientId)
    ?? ingredients.find((item) => item.status === "ACTIVE");
  const purchaseOptionFields = purchaseOptions.length
    ? `<label class="inventory-form-wide">Bahan dan satuan beli<select id="warehouse-purchase-option" name="purchaseOptionSelection" aria-describedby="warehouse-purchase-option-help warehouse-reference-price" required>${purchaseOptions.map((option) => { const ingredient = ingredients.find((item) => item.id === option.ingredientId); const balance = balances.find((item) => item.ingredientId === option.ingredientId); return `<option value="${escapeHtml(option.purchaseOptionId || option.id)}" data-ingredient-id="${escapeHtml(option.ingredientId)}" data-ingredient-name="${escapeHtml(ingredient?.name || "Bahan")}" data-package-label="${escapeHtml(option.label)}" data-purchase-uom="${escapeHtml(option.purchaseUnit)}" data-base-uom="${escapeHtml(ingredient?.baseUom || "unit dasar")}" data-base-quantity="${escapeHtml(option.baseUnitsPerPurchaseUnit)}" data-reference-price="${option.referencePriceRupiah == null ? "" : escapeHtml(option.referencePriceRupiah)}" data-current-on-hand="${escapeHtml(balance?.onHandBase ?? 0)}" data-current-value="${escapeHtml(balance?.inventoryValueRupiah ?? 0)}" data-lot-required="${ingredient?.lotTrackingPolicy === "REQUIRED" ? "true" : "false"}">${escapeHtml(ingredient?.name || "Bahan")} · ${escapeHtml(option.label)}${option.preferred ? " · utama" : ""}</option>`; }).join("")}</select><small id="warehouse-purchase-option-help">${escapeHtml(selectedOption ? `1 ${selectedOption.purchaseUnit} = ${formatPlainNumber(selectedOption.baseUnitsPerPurchaseUnit)} ${selectedIngredient?.baseUom || "unit dasar"}` : "Pilih satuan pembelian tersimpan")}</small></label><input type="hidden" name="purchaseOptionId" value="${escapeHtml(selectedOption?.purchaseOptionId || selectedOption?.id || "")}"><input type="hidden" name="ingredientId" value="${escapeHtml(selectedOption?.ingredientId || "")}"><input type="hidden" name="packageLabel" value="${escapeHtml(selectedOption?.label || "")}"><input type="hidden" name="purchaseUom" value="${escapeHtml(selectedOption?.purchaseUnit || "")}">`
    : `<label>Bahan<select name="ingredientId" required>${ingredientOptions}</select></label><label>Nama kemasan<input name="packageLabel" maxlength="80" placeholder="Contoh: botol 1 liter" required></label><label>Satuan beli<input name="purchaseUom" maxlength="30" placeholder="Contoh: botol" required></label>`;
  const referencePrice = selectedOption?.referencePriceRupiah == null ? "Belum tersedia" : `${rupiah(selectedOption.referencePriceRupiah)} per ${selectedOption.purchaseUnit}`;
  const lotRequired = selectedIngredient?.lotTrackingPolicy === "REQUIRED";
  return `<dialog id="warehouse-receipt-dialog" class="warehouse-receipt-dialog" aria-labelledby="warehouse-receipt-title" aria-describedby="warehouse-receipt-description">
    <div class="warehouse-receipt-header"><div><p class="eyebrow">Gudang · barang masuk</p><h2 id="warehouse-receipt-title">Tambah stok masuk</h2><p id="warehouse-receipt-description">Isi bahan dan jumlah yang datang. Stok masuk ke penyimpanan bersama tanpa pindah halaman.</p></div><button class="warehouse-receipt-dismiss" type="button" data-warehouse-receipt-close aria-label="Tutup tambah stok masuk">×</button></div>
    <form id="warehouse-receipt-form" class="warehouse-receipt-form"><input type="hidden" name="idempotencyKey" value="${escapeHtml(warehouseReceiptAttemptKey)}"><input type="hidden" name="destinationLocationId" value="${escapeHtml(data.warehouse?.locations?.[0]?.id ?? "")}">
      <div class="inventory-compact-form warehouse-receipt-fields">${purchaseOptionFields}
        <label>Jumlah diterima<input name="purchaseQuantity" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" aria-describedby="warehouse-quantity-help" required><small id="warehouse-quantity-help">Dalam ${escapeHtml(selectedOption?.purchaseUnit || "satuan beli")} yang dipilih di atas.</small></label>
        <label>Total biaya pembelian<input name="totalCostRupiah" type="number" min="1" max="1000000000" step="1" inputmode="numeric" required><small>Isi total untuk jumlah yang diterima, bukan harga satuan.</small></label>
        <label class="inventory-form-wide">Supplier<input name="supplierName" maxlength="80" value="${escapeHtml(selectedOption?.supplierName || "")}" required></label>
        <p id="warehouse-reference-price" class="warehouse-reference-price inventory-form-wide"><span>Harga acuan</span><strong data-warehouse-receipt-value="reference">${escapeHtml(referencePrice)}</strong><small>Hanya acuan; biaya aktual mengikuti pembelian ini.</small></p>
      </div>
      <details id="warehouse-receipt-extra" class="warehouse-receipt-extra" ${lotRequired ? "open" : ""}><summary data-warehouse-receipt-extra-summary>${lotRequired ? "Batch wajib diisi" : "Batch dan catatan (jika ada)"}</summary><div class="inventory-compact-form warehouse-receipt-fields">
        <label>Kode batch<input name="lotCode" maxlength="80" ${lotRequired ? "required" : ""}></label>
        <label>Tanggal kedaluwarsa<input name="expiryDate" type="date" ${lotRequired ? "required" : ""}></label>
        <label class="inventory-form-wide">Catatan penerimaan<input name="reason" maxlength="160" value="Penerimaan barang ke stok" required></label>
      </div></details>
      <aside class="warehouse-receipt-preview" aria-labelledby="warehouse-receipt-preview-title" aria-live="polite"><div><p class="eyebrow">Perkiraan otomatis</p><h3 id="warehouse-receipt-preview-title">Dampak ke stok</h3><p data-warehouse-receipt-note>Isi jumlah dan biaya untuk melihat perkiraan.</p></div><dl><div><dt>Jumlah dasar diterima</dt><dd data-warehouse-receipt-value="base">Belum dihitung</dd></div><div><dt>Stok setelah masuk</dt><dd data-warehouse-receipt-value="next-stock">Belum dihitung</dd></div><div><dt>Biaya / satuan dasar</dt><dd data-warehouse-receipt-value="unit-cost">Belum dihitung</dd></div><div><dt>Biaya rata-rata baru</dt><dd data-warehouse-receipt-value="next-mwa">Belum dihitung</dd></div><div class="warehouse-receipt-preview-secondary"><dt>Nilai stok baru</dt><dd data-warehouse-receipt-value="next-value">Belum dihitung</dd></div></dl></aside>
      <p class="owner-card-note warehouse-receipt-location">Masuk ke penyimpanan bersama untuk Gudang, Bar, dan Dapur.</p>
      <p id="inventory-mutation-status" class="form-status warehouse-receipt-status" role="status" aria-live="polite"></p>
      <div class="warehouse-receipt-actions"><button class="button button-ghost" type="button" data-warehouse-receipt-close>Batal</button><button class="button button-primary" type="submit" ${inventoryMutationPending ? "disabled" : ""}>Simpan stok masuk</button></div>
    </form></dialog>`;
}

function syncWarehouseReceiptPurchaseOption(select) {
  const form = select.form;
  const option = select.selectedOptions[0];
  if (!form || !option) return;
  form.elements.ingredientId.value = option.dataset.ingredientId || "";
  form.elements.purchaseOptionId.value = option.value;
  form.elements.packageLabel.value = option.dataset.packageLabel || "";
  form.elements.purchaseUom.value = option.dataset.purchaseUom || "";
  const purchaseOption = (inventoryWorkspace.data?.ingredients?.purchaseOptions ?? []).find((item) => (item.purchaseOptionId || item.id) === option.value);
  form.elements.supplierName.value = purchaseOption?.supplierName || "";
  const ingredient = inventoryWorkspace.data?.ingredients?.items?.find((item) => item.id === option.dataset.ingredientId);
  const lotRequired = option.dataset.lotRequired === "true";
  syncWarehouseReceiptLotFields(form);
  const extra = form.querySelector("#warehouse-receipt-extra");
  if (extra && lotRequired) extra.open = true;
  const extraSummary = form.querySelector("[data-warehouse-receipt-extra-summary]");
  if (extraSummary) extraSummary.textContent = lotRequired ? "Batch wajib diisi" : "Batch dan catatan (jika ada)";
  const help = form.querySelector("#warehouse-purchase-option-help");
  if (help) help.textContent = `1 ${option.dataset.purchaseUom} = ${formatPlainNumber(option.dataset.baseQuantity)} ${ingredient?.baseUom || "unit dasar"}`;
  const quantityHelp = form.querySelector("#warehouse-quantity-help");
  if (quantityHelp) quantityHelp.textContent = `Dalam ${option.dataset.purchaseUom || "satuan beli"} yang dipilih di atas.`;
  syncWarehouseReceiptPreview(form);
}

function syncWarehouseReceiptLotFields(form) {
  const option = form.querySelector("#warehouse-purchase-option")?.selectedOptions?.[0];
  const ingredient = (inventoryWorkspace.data?.ingredients?.items ?? []).find((item) => item.id === form.elements.ingredientId?.value);
  const tracked = option?.dataset.lotRequired === "true" || ingredient?.lotTrackingPolicy === "REQUIRED";
  const lotCode = form.elements.lotCode;
  const expiryDate = form.elements.expiryDate;
  if (!lotCode || !expiryDate) return;
  lotCode.required = tracked || Boolean(expiryDate.value);
  expiryDate.required = tracked || Boolean(lotCode.value.trim());
  if (tracked) form.querySelector("#warehouse-receipt-extra").open = true;
  const summary = form.querySelector("[data-warehouse-receipt-extra-summary]");
  if (summary) summary.textContent = tracked ? "Batch wajib diisi" : "Batch dan catatan (jika ada)";
}

function closeWarehouseReceiptDialog() {
  if (inventoryMutationPending) return;
  warehouseReceiptOpen = false;
  clearWarehouseReceiptAttemptKey();
  render();
  requestAnimationFrame(() => content.querySelector("[data-warehouse-receipt-open]")?.focus());
}

function syncWarehouseReceiptPreview(form) {
  if (!form) return;
  const option = form.querySelector("#warehouse-purchase-option")?.selectedOptions?.[0] ?? form.elements.ingredientId?.selectedOptions?.[0];
  const quantity = Number(form.elements.purchaseQuantity?.value);
  const totalCost = Number(form.elements.totalCostRupiah?.value);
  const baseUnitsPerPurchase = Number(option?.dataset.baseQuantity);
  const baseUom = String(option?.dataset.baseUom || "unit dasar");
  const purchaseUom = String(option?.dataset.purchaseUom || form.elements.purchaseUom?.value || "kemasan");
  const referencePrice = option?.dataset.referencePrice ? `${rupiah(Number(option.dataset.referencePrice))} per ${purchaseUom}` : "Biaya acuan belum tersedia";
  setWarehouseReceiptValue(form, "reference", referencePrice);
  setWarehouseReceiptValue(form, "ingredient", option?.dataset.ingredientName || option?.textContent?.trim() || "Bahan");
  setWarehouseReceiptValue(form, "package", option?.dataset.packageLabel || form.elements.packageLabel?.value || purchaseUom);
  setWarehouseReceiptValue(form, "supplier", form.elements.supplierName?.value.trim() || "Belum diisi");

  const validInput = Number.isFinite(quantity) && quantity >= 0.001 && quantity <= 1_000_000 && Number.isInteger(totalCost) && totalCost >= 1;
  if (!validInput) {
    for (const key of ["purchase", "base", "invoice", "package-cost", "unit-cost", "next-stock", "next-value", "next-mwa"]) setWarehouseReceiptValue(form, key, "Belum dihitung");
    const note = form.querySelector("[data-warehouse-receipt-note]");
    if (note) note.textContent = "Isi jumlah dan total invoice untuk melihat perhitungan.";
    return;
  }

  setWarehouseReceiptValue(form, "purchase", `${formatPlainNumber(quantity)} ${purchaseUom}`);
  setWarehouseReceiptValue(form, "invoice", rupiah(totalCost));
  setWarehouseReceiptValue(form, "package-cost", `${formatRupiahDecimal(totalCost / quantity)} / ${purchaseUom}`);
  const canNormalize = Number.isFinite(baseUnitsPerPurchase) && baseUnitsPerPurchase > 0;
  if (!canNormalize) {
    for (const key of ["base", "unit-cost", "next-stock", "next-value", "next-mwa"]) setWarehouseReceiptValue(form, key, "Dihitung server saat disimpan");
    const note = form.querySelector("[data-warehouse-receipt-note]");
    if (note) note.textContent = "Konversi kemasan lama belum tersedia di preview; server tetap memvalidasinya saat penyimpanan.";
    return;
  }

  const normalizedQuantity = quantity * baseUnitsPerPurchase;
  const currentOnHand = Number(option?.dataset.currentOnHand || 0);
  const currentValue = Number(option?.dataset.currentValue || 0);
  const nextOnHand = currentOnHand + normalizedQuantity;
  const nextValue = currentValue + totalCost;
  const unitCost = totalCost / normalizedQuantity;
  const nextMwa = nextValue / nextOnHand;
  setWarehouseReceiptValue(form, "base", `${formatPlainNumber(normalizedQuantity)} ${baseUom}`);
  setWarehouseReceiptValue(form, "unit-cost", `${formatRupiahDecimal(unitCost)} / ${baseUom}`);
  setWarehouseReceiptValue(form, "next-stock", `${formatPlainNumber(nextOnHand)} ${baseUom}`);
  setWarehouseReceiptValue(form, "next-value", rupiah(nextValue));
  setWarehouseReceiptValue(form, "next-mwa", `${formatRupiahDecimal(nextMwa)} / ${baseUom}`);
  const note = form.querySelector("[data-warehouse-receipt-note]");
  if (note) note.textContent = "Estimasi memakai saldo saat ini; angka final dikunci server setelah konfirmasi.";
}

function setWarehouseReceiptValue(form, key, value) {
  form.querySelectorAll(`[data-warehouse-receipt-value="${key}"]`).forEach((element) => { element.textContent = value; });
}

function ownerWarehouseReceiptHistory(data) {
  const receipts = data.warehouse?.recentReceipts ?? [];
  const locationNames = new Map((data.warehouse?.locations ?? []).map((item) => [item.id, item.name]));
  const rows = receipts.map((receipt) => {
    const locationName = sharedStorageHistoryLabel(receipt.destinationLocationId, locationNames);
    const lines = receipt.lines ?? [];
    const searchValue = [receipt.supplierName, locationName, ...lines.flatMap((line) => [line.ingredientName, ...(line.lots ?? []).map((lot) => lot.lotCode)])].filter(Boolean).join(" ");
    const lineRows = lines.map((line) => `<tr><th scope="row">${escapeHtml(line.ingredientName)}</th><td data-label="Stok masuk">+${formatPlainNumber(line.baseQuantity)} ${escapeHtml(line.baseUom)}</td><td data-label="Nilai">${rupiah(line.totalCostRupiah)}</td><td data-label="Batch">${(line.lots ?? []).length ? line.lots.map((lot) => `${escapeHtml(lot.lotCode)} · exp ${escapeHtml(lot.expiryDate)}`).join("<br>") : "—"}</td></tr>`).join("");
    return `<details class="warehouse-receipt-item" data-warehouse-receipt-row data-warehouse-search-value="${escapeHtml(searchValue)}"><summary><strong>${escapeHtml(receipt.supplierName || "Penerimaan stok")}</strong><span>${dateTime(receipt.receivedAt)} · ${escapeHtml(locationName)}</span><b>${lines.length} bahan · ${rupiah(receipt.totalCostRupiah)}</b></summary><div class="dashboard-table" role="region" aria-label="Rincian penerimaan dari ${escapeHtml(receipt.supplierName || "supplier")}" tabindex="0"><table><caption class="sr-only">Bahan yang diterima dalam satu transaksi</caption><thead><tr><th scope="col">Bahan</th><th scope="col">Stok masuk</th><th scope="col">Nilai</th><th scope="col">Batch</th></tr></thead><tbody>${lineRows}</tbody></table></div></details>`;
  }).join("");
  const body = rows
    ? `<div class="warehouse-receipt-list">${rows}</div><p class="inventory-inline-empty" data-warehouse-receipt-no-results hidden>Tidak ada riwayat stok masuk yang cocok dengan pencarian ini.</p>`
    : `<div class="inventory-empty warehouse-history-empty"><span aria-hidden="true">+</span><div><h3>Belum ada stok masuk</h3><p>Gunakan tombol Tambah stok masuk di atas untuk mencatat barang yang datang.</p></div></div>`;
  return `<article id="warehouse-receipt-history" class="dashboard-card inventory-ledger-card" tabindex="-1"><div class="section-heading"><div><h2>Riwayat stok masuk</h2><p class="card-subtitle">Menampilkan hingga 20 transaksi stok masuk terbaru. Buka transaksi untuk melihat bahan, nilai, dan batch.</p></div><span class="status-badge ${receipts.length ? "is-ready" : "is-warning"}">${receipts.length} penerimaan</span></div>${body}</article>`;
}

function ownerWarehouseLedger(data) {
  const reconciliation = data.warehouse?.ledgerReconciliation ?? {};
  const entries = (data.warehouse?.ledgerEntries ?? []).filter((entry) => {
    const date = String(entry.occurredAt ?? "").slice(0, 10);
    return (!warehouseLedgerFilter.ingredientId || entry.ingredientId === warehouseLedgerFilter.ingredientId)
      && (warehouseLedgerFilter.sourceType === "ALL" || entry.sourceType === warehouseLedgerFilter.sourceType)
      && (warehouseLedgerFilter.locationId === "ALL" || entry.locationId === warehouseLedgerFilter.locationId)
      && (!warehouseLedgerFilter.fromDate || date >= warehouseLedgerFilter.fromDate)
      && (!warehouseLedgerFilter.toDate || date <= warehouseLedgerFilter.toDate);
  });
  const types = [...new Set((data.warehouse?.ledgerEntries ?? []).map((item) => item.sourceType))].sort();
  const ingredients = data.ingredients?.items ?? [];
  const ingredientFilterOptions = ingredients.map((item) => `<option value="${escapeHtml(item.id)}" ${warehouseLedgerFilter.ingredientId === item.id ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.baseUom)}</option>`).join("");
  const locationOptions = (data.warehouse?.locations ?? []).map((item) => `<option value="${escapeHtml(item.id)}" ${warehouseLedgerFilter.locationId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
  const rows = entries.map((item) => `<tr><th scope="row">${escapeHtml(item.ingredientName)}<small>${escapeHtml(warehouseMovementLabel(item.sourceType))}</small></th><td>${dateTime(item.occurredAt)}<small>${escapeHtml(item.actorId || "Sistem")}</small></td><td>${formatSignedInventoryQuantity(item.quantityDeltaBase)}<small>${escapeHtml(item.reason || "—")}</small></td><td>${formatSignedInventoryValue(item.inventoryValueDeltaRupiah)}</td><td>${escapeHtml(item.sourceLabel || item.referenceId || "—")}${item.reversible ? `<small><button class="button button-quiet button-small" type="button" data-warehouse-reverse="${escapeHtml(item.movementId)}" data-warehouse-ingredient="${escapeHtml(item.ingredientName)}">Koreksi transaksi</button></small>` : ""}</td></tr>`).join("");
  return `<article class="dashboard-card inventory-ledger-card"><div class="section-heading"><div><h2>Kartu stok</h2><p class="card-subtitle">Receipt, waste, adjustment, count, konsumsi, dan reversal tampil sebagai histori immutable.</p></div><span class="status-badge ${reconciliation.status === "VERIFIED" ? "is-ready" : "is-warning"}">${reconciliation.status === "VERIFIED" ? "Saldo cocok" : "Histori parsial"}</span></div><form id="warehouse-ledger-filter" class="inventory-filter-form"><label>Bahan<select name="ingredientId"><option value="">Semua bahan</option>${ingredientFilterOptions}</select></label><label>Lokasi<select name="locationId"><option value="ALL">Semua lokasi</option>${locationOptions}</select></label><label>Sumber<select name="sourceType"><option value="ALL">Semua movement</option>${types.map((type) => `<option value="${escapeHtml(type)}" ${warehouseLedgerFilter.sourceType === type ? "selected" : ""}>${escapeHtml(warehouseMovementLabel(type))}</option>`).join("")}</select></label><label>Dari tanggal<input name="fromDate" type="date" value="${escapeHtml(warehouseLedgerFilter.fromDate)}"></label><label>Sampai tanggal<input name="toDate" type="date" value="${escapeHtml(warehouseLedgerFilter.toDate)}"></label><button class="button button-ghost" type="submit">Terapkan filter</button></form>${rows ? `<div class="dashboard-table" role="region" aria-label="Kartu stok gudang" tabindex="0"><table><thead><tr><th scope="col">Bahan</th><th scope="col">Waktu & actor</th><th scope="col">Perubahan</th><th scope="col">Nilai</th><th scope="col">Sumber</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="owner-card-note">Belum ada movement untuk filter ini.</p>`}<p class="inventory-ledger-note">${entries.length}/${reconciliation.entryCount ?? 0} entri ditampilkan · ${reconciliation.mismatchCount ?? 0} mismatch${reconciliation.completeHistory ? "" : " · histori dibatasi oleh read model"}</p></article>`;
}

function warehouseMovementLabel(type) { return ({ PURCHASE_RECEIPT: "Penerimaan", SPOILAGE_WASTE: "Rusak / basi", PRODUCTION_WASTE: "Waste produksi", DAMAGED: "Rusak", INTERNAL_USE: "Pemakaian internal", SAMPLES_PROMOTIONAL: "Sampel / promosi", LOSS_THEFT: "Hilang", CYCLE_COUNT: "Stock count", SALE_CONSUMPTION: "Pemakaian penjualan", TRANSFER_OUT: "Transfer keluar", TRANSFER_IN: "Transfer masuk", REVERSAL: "Reversal" })[type] ?? type; }
function formatSignedInventoryQuantity(value) { const number = Number(value); return `${number > 0 ? "+" : ""}${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(number)}`; }
function formatSignedInventoryValue(value) { const number = Number(value); return `${number > 0 ? "+" : number < 0 ? "−" : ""}${new Intl.NumberFormat("id-ID").format(Math.abs(number))} rupiah`; }

function ownerHppArea(data, dashboardData) {
  const allMenus = data.hpp?.menus ?? [];
  const statusMenus = hppMenuFilter === "ALL" ? allMenus : allMenus.filter((menu) => menu.hppStatus === hppMenuFilter);
  const normalizedQuery = hppMenuQuery.toLocaleLowerCase("id-ID");
  const menus = normalizedQuery
    ? statusMenus.filter((menu) => `${menu.menuName} ${menu.categoryName ?? ""}`.toLocaleLowerCase("id-ID").includes(normalizedQuery))
    : statusMenus;
  if (!allMenus.length) return `<article class="dashboard-card inventory-empty"><span aria-hidden="true">HPP</span><div><h2>Belum ada menu untuk dihitung</h2><p>Buat menu terlebih dahulu. Pengaturan HPP boleh dilakukan sesudahnya tanpa menghambat menu tersimpan.</p></div></article>`;
  const editor = allMenus.find((menu) => menu.productId === hppEditorProductId) ?? null;
  const ingredients = (data.ingredients?.items ?? []).filter((item) => item.status === "ACTIVE");
  const ingredientRecovery = !ingredients.length ? `<article class="inventory-state-card is-stale hpp-ingredient-recovery" role="status" data-hpp-ingredient-recovery-card><span aria-hidden="true">1</span><div><h3>Database bahan belum siap</h3><p>Buat bahan pertama sebelum menyusun komponen HPP. Form Database Bahan akan terbuka dalam pop-up.</p></div><button class="button button-primary" type="button" data-hpp-ingredient-recovery>Buat bahan pertama</button></article>` : "";
  const rows = menus.map((menu) => {
    const action = menu.draftVersion ? "Lanjutkan draft" : menu.publishedVersion ? "Buat revisi" : "Atur HPP";
    const costNote = menu.missingIngredientCount > 0 ? "Referensi bahan perlu diperbaiki"
      : menu.missingCostIngredientCount > 0 ? "Biaya bahan saat ini belum lengkap"
      : menu.currentHppRupiah != null && menu.hppStatus === "NEEDS_REVIEW" ? "HPP terkini; perlu diverifikasi ulang"
      : menu.currentHppRupiah != null && menu.draftVersion ? "HPP versi lama tetap aktif; revisi masih draft"
      : menu.currentHppRupiah != null ? ""
      : menu.draftVersion ? "Draft tersimpan; belum diterbitkan"
      : menu.publishedVersion ? "Versi lama tersimpan; HPP saat ini perlu ditinjau"
      : "Simpan resep, lalu review dan publish";
    const costCell = `${menu.currentHppRupiah == null ? "Belum tersedia" : rupiah(menu.currentHppRupiah)}${costNote ? `<small>${escapeHtml(costNote)}</small>` : ""}`;
    const publishedLabel = menu.publishedVersion ? `Published v${menu.publishedVersion}${menu.hppStatus === "VERIFIED" ? "" : " (histori)"}` : "Belum published";
    return `<tr data-hpp-menu-item="${escapeHtml(menu.productId)}"><th scope="row">${escapeHtml(menu.menuName)}<small>${escapeHtml(menu.categoryName || "Tanpa kategori")}</small></th><td data-label="Harga jual">${rupiah(menu.sellingPriceRupiah)}</td><td data-label="HPP">${costCell}${menu.draftHppRupiah == null ? "" : `<small>Simulasi draft ${rupiah(menu.draftHppRupiah)}</small>`}</td><td data-label="Margin kotor">${menu.grossMarginPct == null ? "Belum tersedia" : `${menu.grossMarginPct}%`}${menu.draftMarginPct == null ? "" : `<small>Simulasi draft ${menu.draftMarginPct}%</small>`}</td><td data-label="Status HPP"><span class="status-badge ${menu.hppStatus === "VERIFIED" ? "is-ready" : "is-warning"}">${escapeHtml(hppStatusLabel(menu.hppStatus))}</span><small>${publishedLabel}</small></td><td data-label="Aksi"><button class="button button-ghost" type="button" data-hpp-edit="${escapeHtml(menu.productId)}" aria-label="${escapeHtml(`${action} untuk ${menu.menuName}`)}">${action}</button></td></tr>`;
  }).join("");
  const filter = `<form id="hpp-menu-filter" class="inventory-filter-form hpp-menu-filter"><label>Cari menu atau kategori<input name="query" type="search" value="${escapeHtml(hppMenuQuery)}" placeholder="Contoh: latte atau classic" autocomplete="off"></label><label>Status<select name="status"><option value="ALL">Semua status</option>${["NOT_SET", "DRAFT", "VERIFIED", "NEEDS_REVIEW"].map((status) => `<option value="${status}" ${hppMenuFilter === status ? "selected" : ""}>${hppStatusLabel(status)}</option>`).join("")}</select></label><button class="button button-ghost" type="submit">Tampilkan hasil</button></form><p id="hpp-menu-results" class="inventory-filter-summary" role="status" aria-live="polite" aria-atomic="true">${menus.length} dari ${allMenus.length} menu ditampilkan.</p>`;
  const history = (data.hpp?.publishedRecipes ?? []).slice(0, 12).map((item) => {
    const menu = allMenus.find((candidate) => candidate.productId === item.productId);
    return `<li><span>${escapeHtml(menu?.menuName ?? item.productId)}<small>${dateTime(item.publishedAt)} · ${escapeHtml(item.publishedBy)}</small></span><strong>v${item.version} · ${rupiah(item.hppRupiahSnapshot)}</strong><small>${item.marginPctSnapshot}% margin kotor · ${item.items.length} baris</small></li>`;
  }).join("");
  const table = rows ? `<div class="dashboard-table hpp-menu-table" role="region" aria-label="Daftar HPP menu" aria-describedby="hpp-menu-results" tabindex="0"><table><caption id="hpp-menu-table-caption" class="sr-only">Daftar HPP menu</caption><thead><tr><th scope="col">Menu</th><th scope="col">Harga jual</th><th scope="col">HPP</th><th scope="col">Margin kotor</th><th scope="col">Status HPP</th><th scope="col">Aksi</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="inventory-empty hpp-menu-empty"><span aria-hidden="true">?</span><div><h3>Menu tidak ditemukan</h3><p>Coba kata kunci lain atau pilih status berbeda.</p><button class="button button-ghost" type="button" data-hpp-menu-reset>Hapus filter</button></div></div>';
  const historyPanel = history ? `<article class="dashboard-card"><div class="section-heading"><div><h2>Histori published</h2><p class="card-subtitle">Snapshot resep dan biaya immutable; perubahan master tidak menulis ulang versi lama.</p></div><span class="status-badge is-ready">${data.hpp.publishedRecipes.length} versi</span></div><ul class="inventory-reference-list hpp-history-list">${history}</ul></article>` : "";
  const recipeDialog = editor ? `<dialog id="hpp-recipe-dialog" class="hpp-recipe-dialog" aria-labelledby="hpp-builder-title" aria-describedby="hpp-recipe-description">${ownerHppRecipeBuilder(editor, ingredients, allMenus.length)}</dialog>` : "";
  return `${ingredientRecovery}<article class="dashboard-card hpp-menu-list"><div class="section-heading"><div><p class="eyebrow">Pilih menu</p><h2>HPP Menu</h2><p class="card-subtitle">Klik Atur HPP untuk membuka resep menu. Bahan dan takaran dapat ditambah dalam satu pop-up; menu tanpa HPP tetap bisa dibuat.</p></div><span class="status-badge ${data.hpp?.coverage?.status === "VERIFIED" ? "is-ready" : "is-warning"}">${data.hpp?.coverage?.percent ?? 0}% terverifikasi</span></div>${filter}${table}</article>${ownerHppQualityArea(data, dashboardData)}${historyPanel}${recipeDialog}`;
}

function ownerHppQualityArea(data, dashboardData) {
  const quality = data.hpp?.quality ?? {};
  const summary = quality.summary ?? {};
  const coverage = summary.saleCoverageCount ?? {};
  const theoretical = dashboardData.theoreticalIngredientUsage ?? {};
  const variance = dashboardData.inventoryVariance ?? {};
  const statusCards = [
    ["VERIFIED", "Terverifikasi", summary.verifiedMenuCount ?? 0, "Siap menjadi snapshot transaksi"],
    ["NOT_SET", "Belum diatur", summary.notSetMenuCount ?? 0, "Penjualan tetap boleh, biaya tidak diklaim"],
    ["DRAFT", "Draft", summary.draftMenuCount ?? 0, "Belum dipakai checkout"],
    ["NEEDS_REVIEW", "Perlu ditinjau", summary.needsReviewMenuCount ?? 0, "Biaya atau referensi berubah"],
  ].map(([status, label, count, note]) => `<button class="hpp-quality-card" type="button" data-hpp-quality-filter="${status}"><span>${escapeHtml(label)}</span><strong>${count}</strong><small>${escapeHtml(note)}</small></button>`).join("");
  const workflow = [
    ["Reservasi aktif", summary.activeReservationCount ?? 0, "Order confirmed; on-hand belum berkurang."],
    ["Reservasi dilepas", summary.releasedReservationCount ?? 0, "Batal sebelum produksi; stok tersedia kembali."],
    ["Sudah dikonsumsi", summary.consumedReservationCount ?? 0, "PREPARING; pengurangan terjadi tepat sekali."],
    ["Movement konsumsi", summary.consumptionCount ?? 0, "Retry tidak membuat movement kedua."],
  ].map(([label, value, note]) => `<li><span>${escapeHtml(label)}<small>${escapeHtml(note)}</small></span><strong>${value}</strong></li>`).join("");
  const saleCoverage = summary.saleItemCount
    ? `${coverage.COMPLETE ?? 0} lengkap · ${coverage.PARTIAL ?? 0} parsial · ${coverage.MISSING ?? 0} tanpa HPP`
    : "Belum ada item penjualan";
  const theoreticalLabel = theoretical.soldItemQuantity > 0 ? `${theoretical.coveragePct ?? 0}% dari ${theoretical.soldItemQuantity} item` : "Belum ada penjualan hari ini";
  const varianceLabel = variance.status === "VERIFIED" ? "Count lengkap" : variance.status === "NO_SALES" ? "Tidak ada penjualan" : "Butuh count pembuka & penutup";
  return `<section class="dashboard-card hpp-quality-panel" aria-labelledby="hpp-quality-title"><div class="section-heading"><div><p class="eyebrow">Quality control · semua status</p><h2 id="hpp-quality-title">Kesiapan HPP & konsumsi</h2><p class="card-subtitle">Satu definisi dipakai oleh kartu, detail menu, dan export. Item tanpa HPP ditandai missing—bukan biaya Rp0.</p></div><a class="button button-ghost" href="/api/operator/reports/hpp-quality.csv" download>Unduh quality CSV</a></div><div class="hpp-quality-grid" aria-label="Drill-down status HPP">${statusCards}</div><section class="inventory-tool-grid hpp-quality-detail"><article><h3>Penjualan & coverage</h3><ul class="readiness-list"><li><span>Item seluruh status order<small>${escapeHtml(Object.entries(summary.orderStatusCount ?? {}).map(([status, count]) => `${status}: ${count}`).join(" · ") || "Belum ada order")}</small></span><strong>${summary.saleItemCount ?? 0}</strong></li><li><span>Coverage biaya<small>Incomplete tidak dijumlahkan sebagai HPP final.</small></span><strong>${escapeHtml(saleCoverage)}</strong></li><li><span>Pemakaian teoretis hari ini<small>${escapeHtml(theoretical.status ?? "NO_SALES")}</small></span><strong>${escapeHtml(theoreticalLabel)}</strong></li><li><span>Actual vs theoretical<small>${escapeHtml(variance.status ?? "REQUIRES_TWO_COUNTS")}</small></span><strong>${escapeHtml(varianceLabel)}</strong></li></ul><div class="button-row"><a class="button button-ghost" href="#reports">Buka laporan variance</a><a class="button button-ghost" href="/api/operator/reports/theoretical-usage.csv?reportDate=${encodeURIComponent(dashboardData.businessDate)}" download>Unduh pemakaian</a></div></article><article><h3>Lifecycle stok penjualan</h3><ul class="readiness-list">${workflow}</ul></article></section>${(summary.unpricedIngredientCount ?? 0) ? `<p class="inventory-state-card is-stale"><span aria-hidden="true">!</span><span><strong>${summary.unpricedIngredientCount} bahan belum punya biaya</strong><small>Lengkapi di Database Bahan agar resep dapat dipublikasikan tanpa silent zero.</small></span><a class="button button-ghost" href="#inventory/database">Buka bahan</a></p>` : ""}</section>`;
}

function ownerHppRecipeBuilder(menu, ingredients, menuCount) {
  const draftItems = menu.draft?.items ?? menu.latestPublished?.items ?? [];
  const simulationLines = menu.draft?.simulation?.lines ?? (menu.latestPublished?.items ?? []).map((item) => ({ ingredientId: item.ingredientId, complete: true, costRupiah: item.costRupiahSnapshot }));
  const missingCost = draftItems.some((line) => ingredients.find((item) => item.id === line.ingredientId)?.costStatus !== "PRICED");
  const displayedHpp = menu.draft ? menu.draftHppRupiah : menu.currentHppRupiah;
  const draftComplete = Boolean(draftItems.length) && !missingCost && displayedHpp != null;
  const displayedMargin = menu.draft ? menu.draftMarginPct : menu.grossMarginPct;
  const grossProfit = displayedHpp == null ? null : Number(menu.sellingPriceRupiah) - Number(displayedHpp);
  const componentOpen = hppComponentEditor?.productId === menu.productId;
  const editingLine = componentOpen && hppComponentEditor.ingredientId ? draftItems.find((item) => item.ingredientId === hppComponentEditor.ingredientId) : null;
  const statusText = menu.draft ? `Draft v${menu.draftVersion}` : menu.publishedVersion ? `Published v${menu.publishedVersion}` : "Belum diatur";
  const rows = draftItems.map((line, index) => {
    const ingredient = ingredients.find((item) => item.id === line.ingredientId);
    const simulation = simulationLines.find((item) => item.ingredientId === line.ingredientId);
    const removeOpen = hppRemoveConfirmationId === line.ingredientId;
    const controls = menu.draft ? `<div class="hpp-component-actions"><button class="button button-ghost" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-line-edit="${escapeHtml(line.ingredientId)}">Edit</button><button class="button button-ghost" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-ingredient="${escapeHtml(line.ingredientId)}" data-hpp-line-move="-1" ${index === 0 ? "disabled" : ""} aria-label="Naikkan ${escapeHtml(ingredient?.name ?? "komponen")}">Naik</button><button class="button button-ghost" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-ingredient="${escapeHtml(line.ingredientId)}" data-hpp-line-move="1" ${index === draftItems.length - 1 ? "disabled" : ""} aria-label="Turunkan ${escapeHtml(ingredient?.name ?? "komponen")}">Turun</button><button class="button button-ghost" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-line-remove-request="${escapeHtml(line.ingredientId)}">Hapus</button></div>` : `<div class="hpp-component-actions"><button class="button button-ghost" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-line-edit="${escapeHtml(line.ingredientId)}">Edit & buat revisi</button></div>`;
    const confirmation = removeOpen ? `<div class="hpp-remove-confirmation" role="alert"><p>Hapus ${escapeHtml(ingredient?.name ?? "komponen ini")} dari draft?</p><div class="button-row"><button class="button button-danger" type="button" data-hpp-product="${escapeHtml(menu.productId)}" data-hpp-line-remove-confirm="${escapeHtml(line.ingredientId)}">Ya, hapus</button><button class="button button-ghost" type="button" data-hpp-line-remove-cancel>Batal</button></div></div>` : "";
    return `<li class="hpp-component-card"><div class="hpp-component-main"><span class="hpp-component-index">${index + 1}</span><div><strong>${escapeHtml(ingredient?.name ?? line.ingredientNameSnapshot ?? "Bahan tidak ditemukan")}</strong><small>${line.lineType === "PACKAGING" ? "Kemasan" : "Bahan"} · ${formatPlainNumber(line.quantity)} ${escapeHtml(line.uom)} · yield ${formatPlainNumber(line.yieldPct)}%</small><small>${escapeHtml(hppCostSourceLabel(ingredient?.costSource))}</small></div></div><div class="hpp-component-cost"><span>Biaya komponen</span><strong>${simulation?.complete ? rupiah(simulation.costRupiah) : "Belum tersedia"}</strong></div>${controls}${confirmation}</li>`;
  }).join("");
  const summary = `<aside class="hpp-summary-card" aria-labelledby="hpp-summary-title"><div><p class="eyebrow">Ringkasan langsung</p><h3 id="hpp-summary-title">HPP satu porsi</h3></div><dl class="hpp-summary-grid"><div><dt>Harga jual</dt><dd>${rupiah(menu.sellingPriceRupiah)}</dd></div><div><dt>Total HPP</dt><dd>${displayedHpp == null ? "Belum dapat dihitung" : rupiah(displayedHpp)}</dd></div><div><dt>Laba kotor menu</dt><dd>${grossProfit == null ? "Belum dapat dihitung" : rupiah(grossProfit)}</dd></div><div><dt>Margin kotor</dt><dd>${displayedMargin == null ? "Belum dapat dihitung" : `${displayedMargin}%`}</dd></div></dl><p class="owner-card-note">${missingCost ? "Ada bahan tanpa biaya. Nilainya tidak dianggap Rp0 dan draft belum dapat dipublikasikan." : draftItems.length ? "Semua komponen memiliki referensi biaya saat ini." : "Tambahkan komponen untuk mulai menghitung HPP."}</p>${menu.draft ? `<p class="owner-card-note" role="status">${menu.currentHppRupiah == null ? "Ini simulasi draft. HPP aktif masih belum tersedia sampai Review & publish selesai." : "Ini simulasi revisi draft. HPP dari versi sebelumnya tetap aktif sampai revisi dipublikasikan."}</p>` : ""}<p class="owner-card-note">Margin kotor hanya memakai komponen HPP yang tercatat; biaya operasional dan pembayaran belum masuk. Ini bukan laba bersih.</p>${draftItems.length && !hppReviewOpen ? `<button class="button button-primary" type="button" data-hpp-review-open ${missingCost || !menu.draft ? "disabled" : ""}>Review & publish</button>` : ""}</aside>`;
  const componentWizard = componentOpen ? ownerHppRecipeEntryForm(menu, ingredients, draftItems, simulationLines, draftComplete, editingLine) : "";
  const publishReview = hppReviewOpen ? `<section class="hpp-component-review" aria-labelledby="hpp-review-title"><div class="section-heading"><div><p class="eyebrow">Pemeriksaan akhir</p><h3 id="hpp-review-title" tabindex="-1">Review HPP ${escapeHtml(menu.menuName)}</h3><p class="card-subtitle">Pastikan komponen, total HPP, dan margin kotor sudah sesuai sebelum membuat versi published.</p></div><button class="button button-ghost" type="button" data-hpp-review-close>Kembali mengedit</button></div><ol class="hpp-review-list">${draftItems.map((line, index) => { const ingredient = ingredients.find((item) => item.id === line.ingredientId); const simulation = simulationLines.find((item) => item.ingredientId === line.ingredientId); return `<li><span>${index + 1}. ${escapeHtml(ingredient?.name ?? "Bahan")}</span><small>${formatPlainNumber(line.quantity)} ${escapeHtml(line.uom)} · yield ${formatPlainNumber(line.yieldPct)}%</small><strong>${simulation?.complete ? rupiah(simulation.costRupiah) : "Biaya belum tersedia"}</strong></li>`; }).join("")}</ol><div class="hpp-review-summary">${summary}</div><form id="hpp-publish-form" class="hpp-publish-form"><input type="hidden" name="productId" value="${escapeHtml(menu.productId)}"><label>Catatan versi<input name="reason" maxlength="160" value="Memverifikasi dan mempublikasikan HPP menu" required></label><button class="button button-primary" type="submit" ${missingCost ? "disabled" : ""}>Publish versi ${menu.publishedVersion ? menu.publishedVersion + 1 : 1}</button><p class="owner-card-note">Versi ini belum terbit. Setelah tombol ditekan dan berhasil disimpan, cek “Published v${menu.publishedVersion ? menu.publishedVersion + 1 : 1}” serta nilai HPP pada baris menu.</p><p id="inventory-mutation-status" class="form-status" role="status" aria-live="polite"></p></form></section>` : "";
  if (componentWizard || publishReview) return `<article class="dashboard-card inventory-master-card hpp-recipe-builder" aria-labelledby="hpp-builder-title"><div class="section-heading hpp-builder-heading"><div><p class="eyebrow">${escapeHtml(statusText)} · ${escapeHtml(menu.categoryName || "Menu")}</p><h2 id="hpp-builder-title">${escapeHtml(menu.menuName)}</h2><p id="hpp-recipe-description" class="card-subtitle">Atur resep tanpa berpindah halaman. Stok gudang tidak berubah saat HPP diedit.</p></div><button class="button button-ghost" type="button" data-hpp-menu-switch>Tutup pop-up</button></div>${componentWizard || publishReview}</article>`;
  const componentList = rows
    ? `<ol class="hpp-component-list">${rows}</ol>`
    : !ingredients.length
      ? `<div class="inventory-empty-state hpp-ingredient-recovery" data-hpp-ingredient-recovery-card><h3>Belum ada bahan aktif</h3><p>Buat bahan pertama agar komponen HPP dapat dipilih dari sumber yang benar.</p><button class="button button-primary" type="button" data-hpp-ingredient-recovery>Buat bahan pertama</button></div>`
      : `<div class="inventory-empty-state"><h3>Belum ada komponen</h3><p>Pilih Tambah komponen untuk memasukkan bahan pertama. Sistem tidak memilih bahan secara otomatis.</p></div>`;
  return `<article class="dashboard-card inventory-master-card hpp-recipe-builder" aria-labelledby="hpp-builder-title"><div class="section-heading hpp-builder-heading"><div><p class="eyebrow">${escapeHtml(statusText)} · ${escapeHtml(menu.categoryName || "Menu")}</p><h2 id="hpp-builder-title" tabindex="-1">${escapeHtml(menu.menuName)}</h2><p id="hpp-recipe-description" class="card-subtitle">Tambahkan bahan dan takaran langsung di pop-up ini. Menu tetap bisa dijual meski HPP belum dipublikasikan.</p></div><button class="button button-ghost" type="button" data-hpp-menu-switch>Tutup pop-up</button></div><div class="hpp-builder-workspace"><section aria-labelledby="hpp-component-list-title"><div class="section-heading"><div><h3 id="hpp-component-list-title">Resep menu</h3><p class="card-subtitle">Klik Edit pada bahan lama atau Tambah bahan untuk komponen baru.</p></div>${ingredients.length ? `<button class="button button-primary" type="button" data-hpp-component-add="${escapeHtml(menu.productId)}">Tambah bahan</button>` : ""}</div>${componentList}</section>${summary}</div></article>`;
}

function ownerHppRecipeEntryForm(menu, ingredients, workingItems, simulationLines, draftComplete, editingLine) {
  const editingId = editingLine?.ingredientId ?? "";
  const selectable = editingLine ? ingredients.filter((item) => item.id === editingId) : ingredients.filter((item) => !workingItems.some((line) => line.ingredientId === item.id));
  const lines = hppComponentEditor?.lines?.length ? hppComponentEditor.lines : [editingLine ? {
    lineType: editingLine.lineType, ingredientId: editingLine.ingredientId, quantity: editingLine.quantity,
    uom: editingLine.uom, yieldPct: editingLine.yieldPct,
  } : emptyHppComponentLine()];
  const options = (selectedId) => selectable.map((item) => {
    const simulation = simulationLines.find((line) => line.ingredientId === item.id);
    const rawCost = item.currentAverageCostPerBaseUnitRupiah;
    const unitCost = item.costStatus === "PRICED" && rawCost !== null && rawCost !== "" && Number.isFinite(Number(rawCost)) ? Number(rawCost) : null;
    const prepLabel = isPrepIngredient(item) ? " · bahan olahan · stok hasil produksi" : "";
    return `<option value="${escapeHtml(item.id)}" data-ingredient-name="${escapeHtml(item.name)}" data-base-uom="${escapeHtml(item.baseUom)}" data-cost-status="${unitCost == null ? "UNPRICED" : "PRICED"}" data-unit-cost="${unitCost == null ? "" : escapeHtml(unitCost)}" data-existing-cost="${simulation?.complete ? escapeHtml(simulation.costRupiah) : ""}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}${prepLabel} · ${escapeHtml(item.baseUom)}${unitCost == null ? " · biaya belum tersedia" : ` · ${rupiah(unitCost)}/${escapeHtml(item.baseUom)}`}</option>`;
  }).join("");
  const rows = lines.map((line, index) => {
    const unit = ingredients.find((item) => item.id === line.ingredientId)?.baseUom ?? line.uom ?? "";
    return `<article class="hpp-batch-row" data-hpp-component-entry="${index}" aria-labelledby="hpp-recipe-row-title-${index}"><div class="hpp-batch-row-heading"><div><span>Bahan ${index + 1}</span><h3 id="hpp-recipe-row-title-${index}">${escapeHtml(ingredients.find((item) => item.id === line.ingredientId)?.name ?? "Pilih bahan")}</h3></div>${!editingLine && lines.length > 1 ? `<button class="button button-ghost" type="button" data-hpp-component-row-remove="${index}" aria-label="Hapus bahan ${index + 1}">Hapus baris</button>` : ""}</div><div class="hpp-batch-fields"><label>Jenis<select name="lineType:${index}" data-hpp-component-type><option value="INGREDIENT" ${line.lineType !== "PACKAGING" ? "selected" : ""}>Bahan</option><option value="PACKAGING" ${line.lineType === "PACKAGING" ? "selected" : ""}>Kemasan</option></select></label><label class="hpp-batch-source">Bahan dari Database<select name="ingredientId:${index}" data-hpp-component-source aria-describedby="hpp-component-error-summary" required><option value="" disabled ${!line.ingredientId ? "selected" : ""}>Pilih bahan</option>${options(line.ingredientId)}</select></label><label>Dipakai per porsi<input name="quantity:${index}" data-hpp-component-quantity aria-describedby="hpp-component-error-summary" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(line.quantity)}" required></label><label>Satuan<input name="uom:${index}" data-hpp-component-uom value="${escapeHtml(unit)}" readonly required></label><details class="hpp-batch-yield" ${Number(line.yieldPct) !== 100 ? "open" : ""}><summary>Susut / yield (opsional)</summary><label>Yield (%)<input name="yieldPct:${index}" data-hpp-component-yield type="number" min="0.001" max="100" step="0.001" inputmode="decimal" value="${escapeHtml(line.yieldPct ?? 100)}" required></label></details></div><dl class="hpp-batch-row-result" aria-live="polite"><div><dt>Satuan</dt><dd data-hpp-row-unit>${escapeHtml(unit || "Pilih bahan")}</dd></div><div><dt>Setelah susut</dt><dd data-hpp-row-effective>Belum dihitung</dd></div><div><dt>Biaya bahan</dt><dd data-hpp-row-cost>Belum dihitung</dd></div></dl></article>`;
  }).join("");
  const draftTotal = draftComplete ? Number(menu.draft ? menu.draftHppRupiah : menu.currentHppRupiah) : 0;
  const reason = hppComponentEditor?.reason ?? (editingLine ? "Memperbarui bahan pada resep HPP" : "Menambahkan bahan pada resep HPP");
  return `<section class="hpp-recipe-entry" aria-labelledby="hpp-component-title"><div class="section-heading"><div><p class="eyebrow">${editingLine ? "Edit bahan" : "Tambah bahan"}</p><h3 id="hpp-component-title" tabindex="-1">${editingLine ? "Perbarui takaran" : "Masukkan bahan dan takaran"}</h3><p class="card-subtitle">Satu layar saja. Tambahkan beberapa bahan sekaligus, lalu simpan sebagai draft.</p></div><button class="button button-ghost" type="button" data-hpp-component-cancel>Kembali ke resep</button></div><form id="hpp-draft-line-form" class="hpp-recipe-entry-form" novalidate data-has-draft="${workingItems.length ? "true" : "false"}" data-draft-complete="${draftComplete ? "true" : "false"}" data-draft-total="${escapeHtml(draftTotal)}" data-selling-price="${escapeHtml(menu.sellingPriceRupiah)}"><input type="hidden" name="productId" value="${escapeHtml(menu.productId)}"><div class="hpp-batch-list">${rows}</div><p id="hpp-component-error-summary" class="form-status is-error" role="alert" aria-live="assertive" data-hpp-batch-error></p>${!editingLine && lines.length < selectable.length ? '<button class="button button-ghost hpp-batch-add" type="button" data-hpp-component-row-add>+ Tambah bahan lain</button>' : ""}<aside class="hpp-live-estimate hpp-batch-summary" aria-labelledby="hpp-live-title" aria-live="polite"><div><p class="eyebrow">Pratinjau resep</p><h3 id="hpp-live-title">HPP setelah disimpan</h3><p data-hpp-live-note>Isi bahan dan takaran untuk melihat biaya.</p></div><dl><div><dt>Harga jual</dt><dd>${rupiah(menu.sellingPriceRupiah)}</dd></div><div><dt>Total HPP</dt><dd data-hpp-live-total>Belum dapat dihitung</dd></div><div><dt>Laba kotor</dt><dd data-hpp-live-gross>Belum dapat dihitung</dd></div><div><dt>Margin kotor</dt><dd data-hpp-live-margin>Belum dapat dihitung</dd></div></dl></aside><p class="owner-card-note">Simulasi bukan laba bersih. Stok Gudang tidak berubah; resep published lama tetap berlaku sampai versi baru dipublikasikan.</p><label class="hpp-component-reason">Catatan perubahan<input name="reason" maxlength="160" value="${escapeHtml(reason)}" required></label><div class="hpp-wizard-actions"><button class="button button-ghost" type="button" data-hpp-component-cancel>Batal</button><button class="button button-primary" type="submit">${editingLine ? "Simpan perubahan ke draft" : "Simpan bahan ke draft"}</button></div><p id="inventory-mutation-status" class="form-status" role="status" aria-live="polite"></p></form><dialog id="hpp-unsaved-dialog" class="inventory-confirm-dialog" aria-labelledby="hpp-unsaved-title"><form method="dialog"><p class="eyebrow">Perubahan belum disimpan</p><h2 id="hpp-unsaved-title">Perubahan resep belum disimpan</h2><p>Perubahan untuk ${escapeHtml(menu.menuName)} belum masuk ke draft HPP.</p><div class="button-row"><button class="button button-primary" type="button" data-hpp-unsaved-stay>Lanjutkan mengedit</button><button class="button button-ghost" type="button" data-hpp-unsaved-discard>Buang perubahan</button></div></form></dialog></section>`;
}

function ownerHppComponentWizard(menu, ingredients, workingItems, simulationLines, draftComplete, editingLine) {
  const editingId = editingLine?.ingredientId ?? "";
  const selectable = editingLine ? ingredients.filter((item) => item.id === editingId) : ingredients.filter((item) => !workingItems.some((line) => line.ingredientId === item.id));
  const editorLines = hppComponentEditor?.lines?.length ? hppComponentEditor.lines : [editingLine ? {
    lineType: editingLine.lineType, ingredientId: editingLine.ingredientId, quantity: editingLine.quantity,
    uom: editingLine.uom, yieldPct: editingLine.yieldPct,
  } : emptyHppComponentLine()];
  const optionHtml = (selectedId) => selectable.map((item) => {
    const simulation = simulationLines.find((line) => line.ingredientId === item.id);
    const rawUnitCost = item.currentAverageCostPerBaseUnitRupiah;
    const unitCost = item.costStatus === "PRICED" && rawUnitCost !== null && rawUnitCost !== "" && Number.isFinite(Number(rawUnitCost)) ? Number(rawUnitCost) : null;
    const prepLabel = isPrepIngredient(item) ? " · bahan olahan · stok hasil produksi" : "";
    return `<option value="${escapeHtml(item.id)}" data-ingredient-name="${escapeHtml(item.name)}" data-base-uom="${escapeHtml(item.baseUom)}" data-cost-source="${escapeHtml(item.costSource || "UNPRICED")}" data-cost-status="${unitCost == null ? "UNPRICED" : "PRICED"}" data-unit-cost="${unitCost == null ? "" : escapeHtml(unitCost)}" data-existing-cost="${simulation?.complete ? escapeHtml(simulation.costRupiah) : ""}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}${prepLabel} · ${escapeHtml(item.baseUom)}${unitCost == null ? " · biaya belum tersedia" : ` · ${rupiah(unitCost)}/${escapeHtml(item.baseUom)}`}</option>`;
  }).join("");
  const componentRows = editorLines.map((line, index) => {
    const unit = ingredients.find((item) => item.id === line.ingredientId)?.baseUom ?? line.uom ?? "";
    return `<article class="hpp-batch-row" data-hpp-component-entry="${index}" aria-labelledby="hpp-batch-row-title-${index}"><div class="hpp-batch-row-heading"><div><span>Komponen ${index + 1}</span><h3 id="hpp-batch-row-title-${index}">${line.ingredientId ? escapeHtml(ingredients.find((item) => item.id === line.ingredientId)?.name ?? "Komponen") : "Pilih sumber & pemakaian"}</h3></div>${!editingLine && editorLines.length > 1 ? `<button class="button button-ghost" type="button" data-hpp-component-row-remove="${index}" aria-label="Hapus komponen ${index + 1}">Hapus</button>` : ""}</div><div class="hpp-batch-fields"><label>Jenis komponen<select name="lineType:${index}" data-hpp-component-type><option value="INGREDIENT" ${line.lineType !== "PACKAGING" ? "selected" : ""}>Bahan</option><option value="PACKAGING" ${line.lineType === "PACKAGING" ? "selected" : ""}>Kemasan</option></select></label><label class="hpp-batch-source">Nama komponen<select name="ingredientId:${index}" data-hpp-component-source aria-describedby="hpp-component-error-summary" required ${editingLine ? 'aria-readonly="true"' : ""}>${editingLine ? "" : '<option value="" disabled ' + (!line.ingredientId ? "selected" : "") + '>Pilih dari Database Bahan</option>'}${optionHtml(line.ingredientId)}</select><small>Sumber biaya dan satuan mengikuti Database Bahan.</small></label><label>Pemakaian per menu<input name="quantity:${index}" data-hpp-component-quantity aria-describedby="hpp-component-error-summary" type="number" min="0.001" max="1000000" step="0.001" inputmode="decimal" value="${escapeHtml(line.quantity)}" required><small>Takaran bersih untuk satu porsi.</small></label><label>Satuan<input name="uom:${index}" data-hpp-component-uom aria-describedby="hpp-component-error-summary" value="${escapeHtml(unit)}" readonly required></label><details class="hpp-batch-yield" ${Number(line.yieldPct) !== 100 ? "open" : ""}><summary>Susut / yield (opsional)</summary><label>Yield (%)<input name="yieldPct:${index}" data-hpp-component-yield aria-describedby="hpp-component-error-summary" type="number" min="0.001" max="100" step="0.001" inputmode="decimal" value="${escapeHtml(line.yieldPct ?? 100)}" required></label></details></div><dl class="hpp-batch-row-result" aria-live="polite"><div><dt>Satuan</dt><dd data-hpp-row-unit>${escapeHtml(unit || "Pilih sumber")}</dd></div><div><dt>Setelah susut</dt><dd data-hpp-row-effective>Belum dihitung</dd></div><div><dt>Biaya komponen</dt><dd data-hpp-row-cost>Belum dihitung</dd></div></dl></article>`;
  }).join("");
  const draftTotal = draftComplete ? Number(menu.draft ? menu.draftHppRupiah : menu.currentHppRupiah) : 0;
  const stepLabels = ["Susun komponen", "Review HPP & margin"];
  const steps = stepLabels.map((label, index) => `<li class="${index === 0 ? "is-current" : ""}" ${index === 0 ? 'aria-current="step"' : ""} data-hpp-component-step="${index + 1}"><span>${index + 1}</span><strong>${escapeHtml(label)}</strong></li>`).join("");
  return `<section class="hpp-component-wizard" aria-labelledby="hpp-component-title"><div class="section-heading"><div><p class="eyebrow">${editingLine ? "Edit komponen" : "Komponen menu"}</p><h2 id="hpp-component-title" tabindex="-1">${editingLine ? "Perbarui komponen HPP" : "Tambah beberapa komponen HPP"}</h2><p class="card-subtitle">Pilih sumber dan atur pemakaian dalam satu layar, lalu cek HPP dan margin sebelum menyimpan. Stok gudang tidak berubah.</p></div><button class="button button-ghost" type="button" data-hpp-component-cancel>Batal</button></div><nav class="hpp-guided-progress" aria-label="Tahapan komponen"><ol>${steps}</ol></nav><form id="hpp-draft-line-form" class="hpp-wizard-form" data-step="1" data-reviewed="false" data-has-draft="${workingItems.length ? "true" : "false"}" data-draft-complete="${draftComplete ? "true" : "false"}" data-draft-total="${escapeHtml(draftTotal)}" data-selling-price="${escapeHtml(menu.sellingPriceRupiah)}"><input type="hidden" name="productId" value="${escapeHtml(menu.productId)}">
    <section data-hpp-component-panel="1" aria-labelledby="hpp-component-source-title"><div class="hpp-batch-section-heading"><div><h3 id="hpp-component-source-title" tabindex="-1">1. Sumber & pemakaian komponen</h3><p>Tambahkan seluruh bahan dan kemasan untuk satu menu di sini.</p></div><span class="status-badge">${editorLines.length} komponen</span></div><div class="hpp-batch-list">${componentRows}</div><p id="hpp-component-error-summary" class="form-status is-error" role="alert" aria-live="assertive" data-hpp-batch-error></p>${!editingLine && editorLines.length < selectable.length ? '<button class="button button-ghost hpp-batch-add" type="button" data-hpp-component-row-add>+ Tambah komponen lain</button>' : ""}<aside class="hpp-live-estimate hpp-batch-summary" aria-labelledby="hpp-live-title" aria-live="polite"><div><p class="eyebrow">Pratinjau langsung</p><h3 id="hpp-live-title">HPP menu setelah disimpan</h3><p data-hpp-live-note>Lengkapi sumber dan pemakaian untuk melihat estimasi.</p></div><dl><div><dt>Harga jual</dt><dd>${rupiah(menu.sellingPriceRupiah)}</dd></div><div><dt>Total HPP</dt><dd data-hpp-live-total>Belum dapat dihitung</dd></div><div><dt>Laba kotor menu</dt><dd data-hpp-live-gross>Belum dapat dihitung</dd></div><div><dt>Margin kotor menu</dt><dd data-hpp-live-margin>Belum dapat dihitung</dd></div></dl></aside><div class="hpp-wizard-actions"><button class="button button-ghost" type="button" data-hpp-component-cancel>Batal</button><button class="button button-primary" type="button" data-hpp-component-next>Review HPP & margin</button></div></section>
    <section data-hpp-component-panel="2" aria-labelledby="hpp-component-review-title" hidden><div class="hpp-batch-section-heading"><div><h3 id="hpp-component-review-title" tabindex="-1">2. Review komponen</h3><p>Pastikan komponen, takaran, dan HPP sudah sesuai. Margin kotor hanya memakai komponen yang tercatat.</p></div></div><ol class="hpp-review-list hpp-batch-review-list" data-hpp-batch-review-list></ol><dl class="hpp-component-review-grid hpp-batch-review-summary"><div><dt>Harga jual</dt><dd>${rupiah(menu.sellingPriceRupiah)}</dd></div><div><dt>Total HPP setelah disimpan</dt><dd data-hpp-component-review-value="total">-</dd></div><div><dt>Laba kotor menu</dt><dd data-hpp-component-review-value="gross">-</dd></div><div><dt>Margin kotor menu</dt><dd data-hpp-component-review-value="margin">-</dd></div></dl><p class="owner-card-note">Biaya operasional dan biaya pembayaran belum masuk ke margin ini; hasilnya bukan laba bersih.</p><label class="hpp-component-reason">Catatan perubahan<input name="reason" maxlength="160" value="${editingLine ? "Memperbarui komponen draft HPP" : "Menambahkan beberapa komponen draft HPP"}" required></label><div class="hpp-wizard-actions"><button class="button button-ghost" type="button" data-hpp-component-back="1">Kembali atur komponen</button><button class="button button-primary" type="submit">${editingLine ? "Simpan perubahan" : `Simpan ${editorLines.length} komponen ke draft`}</button></div><p id="inventory-mutation-status" class="form-status" role="status" aria-live="polite"></p></section>
  </form><dialog id="hpp-unsaved-dialog" class="inventory-confirm-dialog" aria-labelledby="hpp-unsaved-title"><form method="dialog"><p class="eyebrow">Perubahan belum disimpan</p><h2 id="hpp-unsaved-title">Perubahan komponen belum disimpan</h2><p>Perubahan untuk ${escapeHtml(menu.menuName)} belum masuk ke draft HPP. Lanjutkan mengedit atau buang perubahan ini.</p><div class="button-row"><button class="button button-primary" type="button" data-hpp-unsaved-stay>Lanjutkan mengedit</button><button class="button button-ghost" type="button" data-hpp-unsaved-discard>Buang perubahan</button></div></form></dialog></section>`;
}

function hppStatusLabel(status) { return ({ NOT_SET: "Belum diatur", DRAFT: "Draft", VERIFIED: "Terverifikasi", NEEDS_REVIEW: "Perlu ditinjau" })[status] ?? status; }
function formatInventoryQuantity(value, unit) { const number = Number(value); return `${Number.isFinite(number) ? new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(number) : "0"} ${escapeHtml(unit || "unit")}`; }

function collectOwnerPurchaseOrderDraft(form) {
  if (!form) return purchaseOrderEditor.draft;
  return {
    supplierId: form.elements.supplierId.value,
    expectedDate: form.elements.expectedDate.value,
    reason: form.elements.reason.value,
    lines: [...form.querySelectorAll(".owner-po-line")].map((row) => Object.fromEntries([...row.querySelectorAll("input[name], select[name]")].map((field) => [field.name, field.value]))),
  };
}

function updateOwnerPurchaseOrderDraft(form) {
  if (!form) return false;
  const draft = collectOwnerPurchaseOrderDraft(form);
  const ids = draft.lines.map((line) => line.ingredientId).filter(Boolean);
  const duplicate = new Set(ids).size !== ids.length;
  const total = draft.lines.reduce((sum, line) => {
    const quantity = Number(line.orderedPurchaseQuantity);
    const cost = Number(line.unitCostRupiah);
    if (!quantity || !cost) return sum;
    const next = sum + Math.round(quantity * cost);
    return Number.isSafeInteger(next) && next > 0 ? next : NaN;
  }, 0);
  form.querySelector("[data-owner-po-total]").textContent = Number.isSafeInteger(total) ? rupiah(total) : "Total perlu diperiksa";
  form.querySelector("[data-owner-po-count]").textContent = `${draft.lines.length} bahan`;
  form.querySelector("[data-owner-po-validation]").textContent = duplicate ? "Satu bahan hanya boleh muncul sekali. Gabungkan jumlahnya dalam satu item." : "";
  form.querySelector("button[type='submit']").disabled = duplicate || !Number.isSafeInteger(total) || purchaseOrderEditor.saving;
  if (purchaseOrderEditor.saving) form.querySelectorAll("input, select, button").forEach((control) => { control.disabled = true; });
  return !duplicate && Number.isSafeInteger(total);
}

function ownerPurchaseOrderComposer(purchasing) {
  const suppliers = (purchasing.suppliers ?? []).filter((supplier) => supplier.active);
  const ingredients = purchasing.purchaseIngredients ?? [];
  const available = suppliers.length > 0 && ingredients.length > 0;
  const draft = purchaseOrderEditor.draft ?? { supplierId: "", expectedDate: "", reason: "", lines: [{ ingredientId: "", purchaseUnitLabel: "", orderedPurchaseQuantity: "", baseUnitsPerPurchaseUnit: "", unitCostRupiah: "" }] };
  const supplierOptions = suppliers.map((supplier) => `<option value="${escapeHtml(supplier.id)}" ${draft.supplierId === supplier.id ? "selected" : ""}>${escapeHtml(supplier.name)} · ${Number(supplier.leadTimeDays) || 0} hari</option>`).join("");
  const lines = draft.lines.map((line, index) => `<fieldset class="owner-po-line"><legend>Bahan ${index + 1}</legend><label>Bahan<select name="ingredientId" required><option value="">Pilih bahan</option>${ingredients.map((ingredient) => `<option value="${escapeHtml(ingredient.id)}" ${line.ingredientId === ingredient.id ? "selected" : ""}>${escapeHtml(ingredient.name)} · ${escapeHtml(ingredient.baseUnit)}</option>`).join("")}</select></label><div class="owner-po-fields"><label>Nama kemasan<input name="purchaseUnitLabel" maxlength="80" placeholder="Contoh: karton 12 botol" value="${escapeHtml(line.purchaseUnitLabel)}" required></label><label>Jumlah kemasan<input name="orderedPurchaseQuantity" type="number" min="0.001" max="1000000" step="0.001" value="${escapeHtml(line.orderedPurchaseQuantity)}" required></label><label>Isi per kemasan dalam satuan dasar<input name="baseUnitsPerPurchaseUnit" type="number" min="0.001" max="1000000" step="0.001" value="${escapeHtml(line.baseUnitsPerPurchaseUnit)}" required></label><label>Harga per kemasan (Rp)<input name="unitCostRupiah" type="number" min="1" max="1000000000" step="1" value="${escapeHtml(line.unitCostRupiah)}" required></label></div><button class="button button-ghost button-small" type="button" data-owner-po-remove="${index}" ${draft.lines.length === 1 ? "disabled" : ""}>Hapus bahan ${index + 1}</button></fieldset>`).join("");
  const dialog = purchaseOrderEditor.open ? `<dialog id="owner-po-dialog" class="owner-po-dialog" aria-labelledby="owner-po-title"><form id="owner-po-form" class="owner-po-form"><div class="section-heading"><div><p class="eyebrow">Pembelian · rencana internal</p><h2 id="owner-po-title">Buat purchase order</h2><p class="card-subtitle">PO belum mengirim pesan ke supplier dan belum menambah stok. Barang masuk dicatat terpisah.</p></div><button class="button button-ghost button-small" type="button" data-owner-po-close>Tutup</button></div><div class="owner-po-fields"><label>Supplier<select name="supplierId" required><option value="">Pilih supplier aktif</option>${supplierOptions}</select></label><label>Perkiraan tiba<input name="expectedDate" type="date" value="${escapeHtml(draft.expectedDate)}" required></label></div><div class="owner-po-lines">${lines}</div><button class="button button-ghost" type="button" data-owner-po-add ${draft.lines.length >= 100 ? "disabled" : ""}>Tambah bahan</button><div class="owner-po-summary" aria-live="polite"><span data-owner-po-count>${draft.lines.length} bahan</span><strong data-owner-po-total>Rp0</strong></div><p data-owner-po-validation role="alert"></p><label>Alasan pembuatan PO<input name="reason" maxlength="160" placeholder="Contoh: restock untuk minggu depan" value="${escapeHtml(draft.reason)}" required></label><p class="form-status" role="status" aria-live="polite">${escapeHtml(purchaseOrderEditor.status)}</p><div class="button-row"><button class="button button-ghost" type="button" data-owner-po-close>Batal</button><button class="button button-primary" type="submit" ${purchaseOrderEditor.saving ? "disabled" : ""}>Simpan PO internal</button></div></form></dialog>` : "";
  return `<article class="dashboard-card span-12 owner-po-composer"><div class="section-heading"><div><h2>Rencanakan pembelian</h2><p class="card-subtitle">Pilih supplier dan beberapa bahan, lalu cek nilai PO sebelum disimpan. Stok baru bertambah setelah penerimaan barang.</p></div><button class="button button-primary" type="button" data-owner-po-open ${available ? "" : "disabled"}>Buat PO</button></div>${available ? "" : `<p class="owner-card-note">${suppliers.length ? "Buat bahan di Stok & HPP lebih dulu." : "Tambahkan supplier aktif sebelum membuat PO."}</p>`}</article>${dialog}`;
}

async function submitOwnerPurchaseOrder(form) {
  if (purchaseOrderEditor.saving || !form.reportValidity() || !updateOwnerPurchaseOrderDraft(form)) return;
  const purchasing = snapshot?.dashboard?.purchasing;
  if (!Number.isSafeInteger(purchasing?.hppVersion)) { purchaseOrderEditor.status = "Data pembelian belum siap. Perbarui dashboard sebelum menyimpan."; render(); return; }
  const draft = collectOwnerPurchaseOrderDraft(form);
  const attemptKey = purchaseOrderEditor.attemptKey;
  purchaseOrderEditor.draft = draft;
  purchaseOrderEditor.saving = true;
  purchaseOrderEditor.status = "Sedang menyimpan PO internal…";
  form.querySelector(".form-status").textContent = purchaseOrderEditor.status;
  updateOwnerPurchaseOrderDraft(form);
  const payload = { idempotencyKey: attemptKey, supplierId: draft.supplierId, expectedDate: draft.expectedDate, reason: draft.reason.trim(), expectedVersion: purchasing.hppVersion,
    lines: draft.lines.map((line) => ({ ingredientId: line.ingredientId, purchaseUnitLabel: line.purchaseUnitLabel.trim(), orderedPurchaseQuantity: Number(line.orderedPurchaseQuantity), baseUnitsPerPurchaseUnit: Number(line.baseUnitsPerPurchaseUnit), unitCostRupiah: Number(line.unitCostRupiah) })) };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_order.create", payload } });
  } catch (error) {
    if (purchaseOrderEditor.attemptKey !== attemptKey) return;
    const labels = { hpp_version_conflict: "Data pembelian berubah di tempat lain. Perbarui dashboard lalu periksa sebelum menyimpan lagi.", purchase_order_ingredient_duplicate: "Satu bahan hanya boleh muncul sekali. Gabungkan jumlahnya.", supplier_inactive: "Supplier ini sudah nonaktif. Pilih supplier aktif.", supplier_not_found: "Supplier tidak ditemukan. Perbarui dashboard dan pilih lagi.", ingredient_not_found: "Bahan tidak ditemukan. Perbarui dashboard dan pilih bahan yang masih tersedia.", purchase_order_expected_date_invalid: "Periksa tanggal perkiraan tiba.", purchase_order_lines_invalid: "PO harus berisi 1–100 bahan.", purchase_unit_label_invalid: "Isi nama kemasan untuk setiap bahan, maksimal 80 karakter.", purchase_order_quantity_invalid: "Jumlah kemasan harus lebih dari nol dan maksimal 1.000.000.", purchase_conversion_invalid: "Isi per kemasan harus lebih dari nol dan maksimal 1.000.000 satuan dasar.", purchase_order_unit_cost_invalid: "Harga kemasan harus berupa rupiah bulat, antara Rp1 dan Rp1 miliar.", purchase_order_total_invalid: "Total PO di luar batas yang dapat disimpan. Periksa jumlah dan harga.", purchase_order_idempotency_conflict: "Rencana berubah setelah percobaan simpan. Tutup form, periksa daftar PO, lalu buat rencana baru." };
    purchaseOrderEditor.status = labels[error.code] ?? "PO belum dapat dipastikan tersimpan. Periksa daftar PO terbaru sebelum mencoba lagi; percobaan ulang memakai kunci yang sama.";
    purchaseOrderEditor.saving = false;
    render();
    return;
  }
  if (purchaseOrderEditor.attemptKey !== attemptKey) return;
  purchaseOrderEditor = { open: false, draft: null, attemptKey: null, saving: false, status: "" };
  try { await refresh(); announce("PO internal tersimpan. Belum ada barang masuk atau pesan yang dikirim ke supplier."); }
  catch { announce("PO tersimpan, tetapi daftar belum dapat dimuat ulang. Perbarui dashboard sebelum mencoba lagi.", true); }
  requestAnimationFrame(() => content.querySelector("[data-owner-po-open]")?.focus());
}

function ownerSupplierSection(purchasing) {
  const suppliers = purchasing.suppliers ?? [];
  const rows = suppliers.map((supplier) => `<li class="owner-supplier-row"><span><strong>${escapeHtml(supplier.name)}</strong><small>Lead time ${Number(supplier.leadTimeDays) || 0} hari</small></span><span class="status-badge ${supplier.active ? "is-ready" : "is-warning"}">${supplier.active ? "Aktif" : "Nonaktif"}</span><button class="button button-ghost button-small" type="button" data-owner-supplier-edit="${escapeHtml(supplier.id)}" aria-label="Edit supplier ${escapeHtml(supplier.name)}">Edit</button></li>`).join("");
  const existing = supplierEditor.id ? suppliers.find((supplier) => supplier.id === supplierEditor.id) : null;
  const draft = supplierEditor.draft ?? (existing ? { name: existing.name, leadTimeDays: String(existing.leadTimeDays), active: String(existing.active), reason: "" } : { name: "", leadTimeDays: "3", active: "true", reason: "" });
  const dialog = supplierEditor.open ? `<dialog id="owner-supplier-dialog" class="owner-supplier-dialog" aria-labelledby="owner-supplier-title"><form id="owner-supplier-form" class="owner-supplier-form"><div class="section-heading"><div><p class="eyebrow">Master pembelian</p><h2 id="owner-supplier-title">${existing ? "Edit supplier" : "Tambah supplier"}</h2><p class="card-subtitle">Data ini dipakai untuk PO berikutnya. Menyimpan supplier tidak membuat pesanan atau menghubungi pihak luar.</p></div><button class="button button-ghost button-small" type="button" data-owner-supplier-close aria-label="Tutup pengaturan supplier">Tutup</button></div><label>Nama supplier<input name="name" maxlength="80" value="${escapeHtml(draft.name)}" required></label><label>Lead time standar (hari)<input name="leadTimeDays" type="number" min="0" max="365" step="1" value="${escapeHtml(draft.leadTimeDays)}" required></label><label>Status<select name="active"><option value="true" ${draft.active === "true" ? "selected" : ""}>Aktif</option><option value="false" ${draft.active === "false" ? "selected" : ""}>Nonaktif</option></select></label><label>Alasan perubahan<input name="reason" maxlength="160" value="${escapeHtml(draft.reason)}" placeholder="Contoh: pemasok utama bahan kopi" required></label><p class="form-status" role="status" aria-live="polite"></p><div class="button-row"><button class="button button-ghost" type="button" data-owner-supplier-refresh>Perbarui data</button><button class="button button-ghost" type="button" data-owner-supplier-close>Batal</button><button class="button button-primary" type="submit" ${supplierEditor.saving ? "disabled" : ""}>${existing ? "Simpan perubahan" : "Simpan supplier"}</button></div></form></dialog>` : "";
  return `<article id="owner-purchasing-suppliers" class="dashboard-card span-12 owner-suppliers"><div class="section-heading"><div><h2>Supplier</h2><p class="card-subtitle">Kelola nama, status, dan perkiraan waktu pasok langsung di dashboard. Supplier nonaktif tidak dapat dipakai untuk PO baru.</p></div><button class="button button-primary" type="button" data-owner-supplier-edit="">Tambah supplier</button></div>${rows ? `<ul class="owner-supplier-list">${rows}</ul>` : `<p class="owner-card-note">Belum ada supplier. Tambahkan supplier sebelum membuat PO.</p>`}</article>${dialog}${ownerPurchaseOrderComposer(purchasing)}`;
}

function closeOwnerSupplierEditor() {
  if (supplierEditor.saving) return;
  const dialog = content.querySelector("#owner-supplier-dialog");
  if (dialog?.open) dialog.close();
  else supplierEditor = { open: false, id: null, draft: null, saving: false };
}

async function submitOwnerSupplier(form) {
  if (supplierEditor.saving || !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const purchasing = snapshot?.dashboard?.purchasing;
  if (!Number.isSafeInteger(purchasing?.hppVersion)) { form.querySelector("[role='status']").textContent = "Data supplier belum siap. Perbarui dashboard dan coba lagi."; return; }
  const editor = supplierEditor;
  editor.draft = values;
  editor.saving = true;
  editor.status = "Sedang menyimpan supplier…";
  editor.statusDanger = false;
  render();
  const payload = {
    ...(editor.id ? { supplierId: editor.id } : {}),
    name: String(values.name).trim(), leadTimeDays: Number(values.leadTimeDays), active: values.active === "true",
    expectedVersion: purchasing.hppVersion, reason: String(values.reason).trim(),
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.supplier.upsert", payload } });
  } catch (error) {
    if (supplierEditor !== editor) return;
    const labels = { hpp_version_conflict: "Data supplier berubah di tempat lain. Perbarui dashboard sebelum menyimpan lagi.", supplier_name_conflict: "Nama supplier sudah dipakai. Gunakan nama lain.", supplier_name_invalid: "Nama supplier tidak valid.", supplier_lead_time_invalid: "Lead time harus 0–365 hari." };
    editor.status = labels[error.code] ?? "Supplier belum dapat dipastikan tersimpan. Periksa daftar supplier sebelum mencoba lagi.";
    editor.statusDanger = true;
    editor.saving = false;
    render();
    return;
  }
  if (supplierEditor !== editor) return;
  const action = editor.id ? "diperbarui" : "ditambahkan";
  let refreshFailed = false;
  try { await refresh(); } catch { refreshFailed = true; }
  if (supplierEditor !== editor) return;
  supplierEditor = { open: false, id: null, draft: null, saving: false };
  render();
  announce(refreshFailed ? `Supplier ${action}, tetapi daftar belum dapat dimuat ulang. Perbarui dashboard sebelum mencoba lagi.` : `Supplier ${action}. Belum ada PO yang dibuat atau dikirim.`, refreshFailed);
  content.querySelector(`[data-owner-supplier-edit="${editor.id ?? ""}"]`)?.focus();
}

function ownerPurchasingPage(data) {
  const evidence = data.inventoryVariance?.evidence;
  const purchasing = data.purchasing ?? {};
  const purchaseOrderRows = (purchasing.recentPurchaseOrders ?? []).map((order) => `<tr><th scope="row">${escapeHtml(order.supplierName)}<small>Revisi ${Number(order.revision) || 1}</small></th><td>${escapeHtml(order.expectedDate)}</td><td>${Number(order.lineCount) || 0} item</td><td>${rupiah(order.totalOrderedRupiah)}</td><td><span class="status-badge ${order.status === "RECEIVED" ? "is-ready" : "is-warning"}">${escapeHtml(({ OPEN: "Menunggu barang", PARTIALLY_RECEIVED: "Diterima sebagian", RECEIVED: "Selesai", CANCELLED: "Dibatalkan" })[order.status] ?? "Perlu diperiksa")}</span></td></tr>`).join("");
  const invoiceRows = (purchasing.recentInvoices ?? []).map((invoice) => `<tr><th scope="row">${escapeHtml(invoice.invoiceNumber)}<small>${escapeHtml(invoice.supplierName)}</small></th><td>${escapeHtml(invoice.invoiceDate)}<small>Jatuh tempo ${escapeHtml(invoice.dueDate)}</small></td><td>${rupiah(invoice.totalInvoiceRupiah)}<small>Variance ${formatSignedRupiah(invoice.totalVarianceRupiah)}</small></td><td><span class="status-badge ${["APPROVED_NOT_POSTED", "POSTED_UNPAID"].includes(invoice.paymentReadiness) ? "is-ready" : "is-warning"}">${escapeHtml(({ READY_FOR_APPROVAL: "Review Finance", APPROVED_NOT_POSTED: "Siap posting", POSTED_UNPAID: "Posted · unpaid", REJECTED: "Ditolak", BLOCKED: "Exception" })[invoice.paymentReadiness] ?? invoice.paymentReadiness)}</span></td></tr>`).join("");
  const paymentRows = (purchasing.recentPayments ?? []).map((payment) => `<tr><th scope="row">${escapeHtml(payment.reference)}<small>${escapeHtml(payment.supplierName)}</small></th><td>${escapeHtml(payment.paidDate)}<small>${escapeHtml(paymentMethodLabel(payment.method))} · ${escapeHtml(payment.invoiceNumber)}</small></td><td>${rupiah(payment.amountRupiah)}</td><td><span class="status-badge is-ready">${escapeHtml(payment.status === "RECORDED" ? "Tercatat" : payment.status)}</span></td></tr>`).join("");
  const creditRows = (purchasing.recentCredits ?? []).map((credit) => { const status = credit.status === "REVERSED" ? "Dibalikkan" : credit.reversalStatus === "PENDING_OWNER_DECISION" ? "Reversal menunggu" : credit.status === "POSTED" ? "Posted" : "Menunggu Owner"; return `<tr><th scope="row">${escapeHtml(credit.creditNoteNumber)}<small>${escapeHtml(credit.supplierName)}</small></th><td>${escapeHtml(credit.creditDate)}${credit.reversalReason ? `<small>${escapeHtml(credit.reversalReason)}</small>` : ""}</td><td>${rupiah(credit.amountRupiah)}</td><td><span class="status-badge ${credit.status === "POSTED" && !credit.reversalStatus ? "is-ready" : "is-warning"}">${escapeHtml(status)}</span></td></tr>`; }).join("");
  const returnRows = (purchasing.recentSupplierReturns ?? []).map((item) => { const status = ({ REPLACED: "Replacement diterima", SHIPPED_AWAITING_CREDIT: "Menunggu credit", CREDIT_RECEIVED_PENDING_POST: "Credit menunggu posting", CREDIT_POSTED: "Credit posted", SHIPPED_AWAITING_REPLACEMENT: "Menunggu replacement" })[item.status] ?? item.status; return `<tr><th scope="row">${escapeHtml(item.returnReference)}<small>${escapeHtml(item.supplierName)}</small></th><td>${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeZone: state.context.timezone }).format(new Date(item.shippedAt)))}</td><td>${rupiah(item.totalReturnValueRupiah)}</td><td><span class="status-badge ${["REPLACED", "CREDIT_POSTED"].includes(item.status) ? "is-ready" : "is-warning"}">${escapeHtml(status)}</span></td></tr>`; }).join("");
  const purchasingNav = `<nav class="owner-purchasing-nav" aria-label="Tahap pembelian"><button type="button" data-purchasing-jump="owner-purchasing-flow">Ringkasan</button><button type="button" data-purchasing-jump="owner-purchasing-suppliers">Supplier</button><button type="button" data-purchasing-jump="owner-purchasing-po">Purchase order</button><a href="#inventory/warehouse">Penerimaan di Gudang</a><button type="button" data-purchasing-jump="owner-purchasing-invoices">Invoice & retur</button><button type="button" data-purchasing-jump="owner-purchasing-payments">Pembayaran tercatat</button><a href="/ap">Review AP</a></nav>`;
  return `<section class="metric-grid owner-metrics">${metric("PO aktif", purchasing.openPurchaseOrderCount ?? 0, `${purchasing.purchaseOrderCount ?? 0} total PO`, "sales")}${metric("Review Finance", purchasing.readyForApprovalCount ?? 0, `${rupiah(purchasing.readyForApprovalRupiah)} menunggu`, "orders")}${metric("Jatuh tempo ≤7 hari", rupiah((purchasing.accountsPayableAging?.dueToday?.rupiah ?? 0) + (purchasing.accountsPayableAging?.dueNext7Days?.rupiah ?? 0)), `${(purchasing.accountsPayableAging?.dueToday?.count ?? 0) + (purchasing.accountsPayableAging?.dueNext7Days?.count ?? 0)} invoice`, (purchasing.accountsPayableAging?.overdue?.count ?? 0) ? "urgent" : "queue")}${metric("Supplier paid", rupiah(purchasing.paidPayableRupiah ?? 0), `${purchasing.purchaseInvoicePaymentCount ?? 0} payment tercatat`, "aov")}</section>${purchasingNav}<section class="dashboard-grid"><article id="owner-purchasing-flow" class="dashboard-card span-5"><div class="section-heading"><div><h2>Alur pembelian</h2><p class="card-subtitle">PO → penerimaan → pencocokan → persetujuan → pencatatan; aging AP membantu prioritas bayar tanpa membuat pembayaran.</p></div></div><ul class="readiness-list"><li><span>Supplier</span><strong>${purchasing.supplierCount ?? 0}</strong></li><li><span>Exception diblokir</span><strong>${purchasing.blockedInvoiceCount ?? 0}</strong></li><li><span>Retur terbuka</span><strong>${(purchasing.supplierReturnAwaitingCreditCount ?? 0) + (purchasing.supplierReturnAwaitingReplacementCount ?? 0)}</strong></li><li><span>Credit posted aktif</span><strong>${purchasing.postedCreditCount ?? 0}</strong></li><li><span>Outstanding AP</span><strong>${rupiah(purchasing.openPayableRupiah)}</strong></li><li><span>Bukti penerimaan</span><strong>${evidence ? `${evidence.shownEntries}/${evidence.totalEntries}` : "Belum tersedia"}</strong></li></ul><div class="button-row"><a class="button button-ghost" href="/ap">Review AP</a></div><p class="owner-card-note">Buat, revisi dan batalkan PO melalui kontrol Pembelian di bawah. Persetujuan AP tetap terpisah sesuai peran Finance.</p></article>${ownerAccountsPayableAgingView(purchasing.accountsPayableAging)}<article id="owner-purchasing-po" class="dashboard-card span-12"><div class="section-heading"><div><h2>Purchase order terbaru</h2><p class="card-subtitle">Rencana pembelian internal dari sumber data yang sama dengan penerimaan barang; tidak berarti barang sudah datang atau dibayar.</p></div><span class="status-badge ${purchaseOrderRows ? "is-ready" : "is-warning"}">${purchasing.openPurchaseOrderCount ?? 0} PO aktif</span></div>${purchaseOrderRows ? `<div class="dashboard-table owner-purchase-orders" role="region" aria-label="Purchase order terbaru" tabindex="0"><table><caption>PO terbaru dan status penerimaan</caption><thead><tr><th scope="col">Supplier</th><th scope="col">Perkiraan tiba</th><th scope="col">Item</th><th scope="col">Nilai rencana</th><th scope="col">Status</th></tr></thead><tbody>${purchaseOrderRows}</tbody></table></div>` : `<p class="owner-card-note">Belum ada PO. Daftar ini terisi setelah rencana pembelian dibuat.</p>`}</article><div id="owner-po-controls" class="span-12"></div>${ownerSupplierSection(purchasing)}<article id="owner-purchasing-payments" class="dashboard-card span-7"><div class="section-heading"><div><h2>Payment run supplier</h2><p class="card-subtitle">Riwayat cash-out manual yang dicatat Owner untuk rekonsiliasi vendor; tidak mengirim uang dan tidak memanggil provider.</p></div><span class="status-badge ${paymentRows ? "is-ready" : "is-warning"}">${purchasing.purchaseInvoicePaymentCount ?? 0} payment</span></div>${paymentRows ? `<div class="dashboard-table" role="region" aria-label="Riwayat payment supplier" tabindex="0"><table><caption>Payment supplier tercatat</caption><thead><tr><th scope="col">Referensi</th><th scope="col">Tanggal & invoice</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${paymentRows}</tbody></table></div><a class="button button-ghost" href="/api/operator/reports/supplier-payments.csv?reportDate=${encodeURIComponent(data.businessDate)}" download>Unduh payment supplier CSV</a>` : `<p class="owner-card-note">Belum ada pembayaran supplier tercatat. Setelah Owner mencatat settlement di Admin, dashboard menampilkan referensi untuk rekonsiliasi vendor.</p>`}</article><article id="owner-purchasing-invoices" class="dashboard-card span-7"><div class="section-heading"><div><h2>Kontrol invoice & retur</h2><p class="card-subtitle">Credit mengurangi outstanding; reversal memulihkannya tanpa menghapus histori atau mengubah stok.</p></div></div>${invoiceRows ? `<div class="dashboard-table" role="region" aria-label="Invoice supplier terbaru" tabindex="0"><table><thead><tr><th scope="col">Invoice</th><th scope="col">Tanggal</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${invoiceRows}</tbody></table></div>` : `<p>Belum ada invoice supplier yang dicocokkan.</p>`}${creditRows ? `<div class="dashboard-table" role="region" aria-label="Credit memo supplier terbaru" tabindex="0"><table><caption>Credit memo dan reversal</caption><thead><tr><th scope="col">Credit note</th><th scope="col">Tanggal & alasan</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${creditRows}</tbody></table></div>` : ""}${returnRows ? `<div class="dashboard-table" role="region" aria-label="Retur supplier terbaru" tabindex="0"><table><caption>Retur fisik & replacement</caption><thead><tr><th scope="col">Referensi</th><th scope="col">Dikirim</th><th scope="col">Nilai stok</th><th scope="col">Status</th></tr></thead><tbody>${returnRows}</tbody></table></div>` : ""}</article></section>`;
}

function ownerAccountsPayableAgingView(aging = {}) {
  const rows = aging.rows ?? [];
  const agingRows = [
    ["Lewat tempo", aging.overdue?.count ?? 0, aging.overdue?.rupiah ?? 0, "Harus direview sebelum order supplier berikutnya."],
    ["Jatuh tempo hari ini", aging.dueToday?.count ?? 0, aging.dueToday?.rupiah ?? 0, "Prioritas cash-out hari berjalan."],
    ["1–7 hari", aging.dueNext7Days?.count ?? 0, aging.dueNext7Days?.rupiah ?? 0, "Siapkan payment run berikutnya."],
    [">7 hari", aging.later?.count ?? 0, aging.later?.rupiah ?? 0, "Belum mendesak, tetap masuk forecast."],
  ].map(([label, count, rupiahValue, note]) => `<li><span>${escapeHtml(label)}<small>${escapeHtml(note)}</small></span><strong>${count} · ${rupiah(rupiahValue)}</strong></li>`).join("");
  const payableRows = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.invoiceNumber)}<small>${escapeHtml(row.supplierName)}</small></th><td>${escapeHtml(row.dueDate)}<small>${dueLabel(row.daysUntilDue)}</small></td><td>${rupiah(row.outstandingRupiah)}</td></tr>`).join("");
  return `<article class="dashboard-card span-7"><div class="section-heading"><div><p class="eyebrow">Aging AP · ${escapeHtml(aging.asOfBusinessDate ?? "")}</p><h2>Aging utang supplier</h2><p class="card-subtitle">Membaca invoice posted-unpaid dan credit aktif; tidak membuat payment atau transfer uang.</p></div><span class="status-badge ${(aging.overdue?.count ?? 0) ? "is-warning" : "is-ready"}">${aging.openCount ?? 0} invoice</span></div><ul class="readiness-list">${agingRows}</ul>${payableRows ? `<div class="dashboard-table" role="region" aria-label="Utang supplier berdasarkan jatuh tempo" tabindex="0"><table><caption>Invoice terbuka terdekat</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Jatuh tempo</th><th scope="col">Outstanding</th></tr></thead><tbody>${payableRows}</tbody></table></div>` : `<p class="owner-card-note">Tidak ada utang supplier terbuka pada snapshot ini.</p>`}<a class="button button-ghost" href="/api/operator/reports/accounts-payable-aging.csv?reportDate=${encodeURIComponent(aging.asOfBusinessDate ?? "")}" download>Unduh aging AP CSV</a></article>`;
}

function ownerFinancePage(data) {
  const areas = [["summary", "Ringkasan"], ["cash", "Kas & closing"], ["settlement", "Settlement"], ["payables", "Utang supplier"]];
  const requested = location.hash.split("/")[1];
  const area = areas.some(([id]) => id === requested) ? requested : "summary";
  const cash = data.cashControl ?? {};
  const settlement = data.paymentSettlement ?? {};
  const gate = data.financeDailyClosingGate;
  const sections = {
    cash: () => `${ownerCashControlView(cash)}${ownerClosingReadinessView(data)}<a class="owner-next-action" href="#readiness/closing">Buka uji closing terpisah →</a>`,
    settlement: () => `${ownerPaymentSettlementView(settlement)}${ownerFinancialView(data.financialSummary)}`,
    payables: () => `<section class="dashboard-grid">${ownerAccountsPayableAgingView(data.purchasing?.accountsPayableAging)}<article class="dashboard-card span-5"><h2>Catatan pembayaran supplier</h2><p>Invoice, pembayaran dan kredit memakai catatan AP yang sama dengan Pembelian. Mencatat pembayaran tidak mengirim dana.</p><div class="button-row"><a class="button button-primary" href="/ap">Buka review AP</a><a class="button button-ghost" href="#purchasing">Buka Pembelian</a></div><a href="/api/operator/reports/supplier-payments.csv?reportDate=${encodeURIComponent(data.businessDate)}" download>Unduh pembayaran supplier CSV</a></article></section>`,
    summary: () => `<section class="metric-grid owner-metrics" aria-label="Ringkasan keuangan">${metric("Kas seharusnya", cash.shift ? financialMoney(cash.expectedCashRupiah) : "Belum ada shift", "Shift terakhir pada tanggal ini", "sales")}${metric("Selisih kas", cash.varianceRupiah == null ? "Belum dihitung" : financialMoney(cash.varianceRupiah), "Kas fisik − kas seharusnya", cash.varianceRupiah ? "urgent" : "queue")}${metric("Bukti closing", gate ? `${gate.passedCount}/${gate.totalCount}` : "Belum tersedia", "Bukti lengkap pada snapshot", "orders")}${metric("Utang supplier", financialMoney(data.purchasing?.openPayableRupiah), "Invoice terbuka dari AP", "aov")}</section><section class="dashboard-action-grid owner-finance-actions">${[["cash", "Kas & closing", "Hitung kas, periksa selisih, dan lengkapi bukti penutupan."], ["settlement", "Settlement", "Cocokkan pembayaran POS dengan bukti penyedia pembayaran/bank."], ["payables", "Utang supplier", "Periksa jatuh tempo, pembayaran tercatat, dan kredit supplier."]].map(([id, label, note]) => `<article class="dashboard-card"><h2>${label}</h2><p>${note}</p><a class="button button-ghost" href="#finance/${id}">Buka ${label.toLowerCase()}</a></article>`).join("")}</section><p class="owner-card-note">Hari tanpa transaksi tidak otomatis siap closing. Pembayaran POS bukan bukti dana masuk bank; HPP dan laba yang belum lengkap tidak dianggap Rp0.</p>`,
  };
  return `${ownerOperationsNavigation()}${ownerPeriodToolbar(data, "Kas dan laporan mengikuti tanggal bisnis yang dipilih; antrean pesanan tetap live.")}<nav class="dashboard-subnavigation owner-finance-navigation" aria-label="Keuangan">${areas.map(([id, label]) => `<a href="#finance/${id}" ${area === id ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>${sections[area]()}`;
}

function ownerPhase7ResilienceView() {
  if (["idle", "loading"].includes(phase7ResilienceState.status)) return '<article class="dashboard-card" role="status"><span class="status-badge">Memeriksa</span><h2>Menyiapkan pilot Phase 7…</h2></article>';
  const readiness = phase7ResilienceState.readiness;
  const result = phase7ResilienceState.result;
  const scenarioOptions = (phase7ResilienceState.scenarios ?? []).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === phase7ResilienceDraft.scenario ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const error = phase7ResilienceState.error ? `<p class="form-status is-error" role="alert">${escapeHtml(phase7ResilienceState.error)}</p>` : "";
  const resultView = result ? `<article class="dashboard-card phase7-pilot-result"><div class="section-heading"><div><p class="eyebrow">Hasil pilot · ${escapeHtml(result.operationId)}</p><h3>${escapeHtml(result.scenarioLabel)}</h3><p class="card-subtitle">Fingerprint ${escapeHtml(result.replayFingerprint.slice(0, 16))} · tidak ada transaksi bisnis yang dibuat.</p></div><span class="status-badge ${result.decision === "SIMULATION_PASS" ? "is-ready" : "is-warning"}">${result.decision === "SIMULATION_PASS" ? "Simulasi lulus" : "Perlu review"}</span></div><section class="metric-grid owner-metrics">${metric("Order uji", result.metrics.completedOrders, "Selesai", "sales")}${metric("Concurrent", result.concurrentUsers, "Pengguna simulasi", "orders")}${metric("p95", `${result.metrics.p95LatencyMs} ms`, "Budget 1.500 ms", "aov")}${metric("Duplicate write", result.metrics.duplicateBusinessWrites, "Fakta bisnis", result.metrics.duplicateBusinessWrites ? "urgent" : "queue")}</section><ol class="phase7-runbook">${(result.runbook ?? []).map((item) => `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.action)}</span><small>${escapeHtml(item.owner)}</small></li>`).join("")}</ol>${result.actionQueue.length ? `<ul class="readiness-list">${result.actionQueue.map((item) => `<li><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.owner)}</strong></li>`).join("")}</ul>` : ""}<p class="owner-card-note">${escapeHtml(result.note)}</p></article>` : "";
  return `<section class="phase7-pilot-console" aria-labelledby="phase7-pilot-title"><article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Phase 7 · operational resilience</p><h2 id="phase7-pilot-title">Simulasi satu shift</h2><p class="card-subtitle">Rehearsal opening, jam ramai, gangguan, rekonsiliasi, dan closing tanpa uang atau data pelanggan nyata.</p></div><span class="status-badge ${readiness?.targetAchieved ? "is-ready" : "is-warning"}">${readiness?.score ?? 0}% · ${readiness?.readyChecks ?? 0}/${readiness?.totalChecks ?? 0}</span></div><form id="phase7-resilience-simulator" class="phase7-pilot-form"><label>Kondisi operasional<select name="scenario" required>${scenarioOptions}</select></label><label>Jumlah order uji<input name="requestedOrders" type="number" min="1" max="5000" step="1" value="${phase7ResilienceDraft.requestedOrders}" required></label><label>Pengguna bersamaan<input name="concurrentUsers" type="number" min="1" max="200" step="1" value="${phase7ResilienceDraft.concurrentUsers}" required></label><label>Idempotency key<input name="idempotencyKey" pattern="[A-Za-z0-9._:-]{8,120}" value="${escapeHtml(phase7ResilienceDraft.idempotencyKey)}" required></label><button class="button button-primary" type="submit" ${phase7ResilienceState.status === "running" ? "disabled" : ""}>${phase7ResilienceState.status === "running" ? "Menjalankan…" : "Jalankan satu shift simulasi"}</button>${error}</form><p class="owner-card-note">Target Phase 7 adalah 96%. Gate 100% tetap pilot manusia pada outlet nyata.</p></article>${resultView}</section>`;
}

function ownerPhase6FinanceClosingView() {
  if (["idle", "loading"].includes(phase6ClosingState.status)) return '<article class="dashboard-card" role="status"><span class="status-badge">Memeriksa</span><h2>Menyiapkan kontrol closing…</h2></article>';
  const readiness = phase6ClosingState.readiness;
  const result = phase6ClosingState.result;
  const scenarioOptions = (phase6ClosingState.scenarios ?? []).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === phase6ClosingDraft.scenario ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const error = phase6ClosingState.error ? `<p class="form-status is-error" role="alert">${escapeHtml(phase6ClosingState.error)}</p>` : "";
  const resultView = result ? `<article class="dashboard-card phase6-closing-result"><div class="section-heading"><div><p class="eyebrow">Hasil rehearsal · ${escapeHtml(result.operationId)}</p><h3>${escapeHtml(result.scenarioLabel)}</h3><p class="card-subtitle">Fingerprint ${escapeHtml(result.replayFingerprint.slice(0, 16))} · provider dan ledger tidak disentuh.</p></div><span class="status-badge ${result.decision === "BLOCKED" ? "is-warning" : "is-ready"}">${result.decision === "BLOCKED" ? "Closing diblokir" : "Siap submit simulasi"}</span></div><section class="metric-grid owner-metrics">${metric("Kas seharusnya", rupiah(result.expectedCashRupiah), "Dari POS", "sales")}${metric("Kas dihitung", rupiah(result.declaredCashRupiah), "Input rehearsal", "orders")}${metric("Selisih", rupiah(result.varianceRupiah), result.varianceStatus, result.varianceRupiah ? "urgent" : "queue")}${metric("Tindakan", result.actionQueue.length, "Sebelum closing", "aov")}</section><ul class="readiness-list">${(result.checks ?? []).map((item) => `<li><span>${escapeHtml(item.label)}<small>${escapeHtml(item.action)}</small></span><strong>${item.complete ? "Siap" : escapeHtml(item.owner)}</strong></li>`).join("")}</ul><p class="owner-card-note">${escapeHtml(result.note)}</p></article>` : "";
  return `<section class="phase6-closing-console" aria-labelledby="phase6-closing-title"><article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Phase 6 · finance control center</p><h2 id="phase6-closing-title">Uji closing & exception</h2><p class="card-subtitle">Rehearsal Owner memeriksa urutan closing dan tindakan koreksi tanpa mengubah uang, ledger, settlement, atau stok.</p></div><span class="status-badge ${readiness?.activationSafe ? "is-ready" : "is-warning"}">${readiness?.score ?? 0}% · ${readiness?.readyChecks ?? 0}/${readiness?.totalChecks ?? 0}</span></div><form id="phase6-closing-simulator" class="phase6-closing-form"><label>Skenario<select name="scenario" required>${scenarioOptions}</select></label><label>Kas seharusnya<input name="expectedCashRupiah" type="number" min="0" max="1000000000" step="1000" value="${phase6ClosingDraft.expectedCashRupiah}" required></label><label>Kas hasil hitung<input name="declaredCashRupiah" type="number" min="0" max="1000000000" step="1000" value="${phase6ClosingDraft.declaredCashRupiah}" required></label><label>Idempotency key<input name="idempotencyKey" pattern="[A-Za-z0-9._:-]{8,120}" value="${escapeHtml(phase6ClosingDraft.idempotencyKey)}" required></label><button class="button button-primary" type="submit" ${phase6ClosingState.status === "running" ? "disabled" : ""}>${phase6ClosingState.status === "running" ? "Menjalankan…" : "Jalankan rehearsal"}</button>${error}</form><p class="owner-card-note">Gate terakhir adalah satu closing shift nyata yang dikontrol dan diterima Owner/Finance.</p></article>${resultView}</section>`;
}

function ownerClosingReadinessView(data) {
  const gate = data.financeDailyClosingGate;
  const checks = gate?.checks ?? [];
  const readyCount = gate?.passedCount ?? 0;
  const totalCount = gate?.totalCount ?? 0;
  const actions = {
    paid_orders: ['/cashier', 'Buka kasir'],
    order_payment: ['#orders/history', 'Periksa pesanan'],
    cash_count: ['/cashier', 'Hitung & tutup kas di kasir'],
    settlement: ['#finance/settlement', 'Periksa pembayaran', '.owner-payment-settlement'],
    refund: ['#finance/settlement', 'Periksa laporan refund', '#owner-financial-panel'],
    recipe_cost: ['#inventory/hpp', 'Lengkapi HPP menu'],
    actual_cost: ['#inventory/warehouse', 'Hitung stok'],
  };
  const flow = [
    "Hitung cash drawer dan selisih kasir.",
    "Cocokkan QRIS/gateway ke settlement provider.",
    "Pastikan resep, receipt, waste, dan stock count lengkap.",
    "Periksa refund dan biaya sebelum memakai angka sebagai laba final.",
  ];
  return `<section class="dashboard-grid owner-closing-readiness" aria-label="Checklist closing owner">
    <article class="dashboard-card span-7">
      <div class="section-heading"><div><p class="eyebrow">Closing harian · ${escapeHtml(data.businessDate)}</p><h2>Checklist closing owner</h2><p class="card-subtitle">Bukti transaksi, kas, settlement, refund, dan HPP harus lengkap; hari tanpa transaksi tidak otomatis siap.</p></div><span class="status-badge ${totalCount > 0 && readyCount === totalCount ? "is-ready" : "is-warning"}">${readyCount}/${totalCount} bukti lengkap</span></div>
      <ul class="readiness-list">${checks.map((item) => {
        const action = !item.passed && actions[item.id];
        return `<li><span>${escapeHtml(item.label)}<small>${item.passed ? "Bukti pada snapshot ini tersedia." : escapeHtml(item.action)}</small></span><div class="owner-closing-action"><strong>${item.passed ? "Lengkap" : "Perlu tindakan"}</strong>${action ? `<a class="button button-ghost" href="${action[0]}" ${action[2] ? `data-closing-target="${action[2]}"` : ''} ${item.id === 'order_payment' ? 'data-closing-orders' : ''}>${action[1]}</a>` : !item.passed && item.id === 'bank_payout' ? '<small>Integrasi bank belum tersedia</small>' : ''}</div></li>`;
      }).join("") || "<li>Data closing belum tersedia. Muat ulang dashboard.</li>"}</ul>
    </article>
    <article class="dashboard-card span-5">
      <div class="section-heading"><div><p class="eyebrow">Urutan kerja</p><h2>Jangan tutup hari dari angka paid saja</h2><p class="card-subtitle">Payment gateway, cash drawer, dan HPP punya bukti berbeda.</p></div></div>
      <ol class="owner-closing-flow">${flow.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
      <p class="owner-card-note">${gate?.profitReady ? "Biaya dan laba sudah diverifikasi." : "Laba bersih belum dapat dinyatakan final dari laporan ini; biaya dan payout bank tetap memerlukan rekonsiliasi terpisah."}</p>
    </article>
  </section>`;
}

function ownerCashControlView(data = {}) {
  const statusLabels = {
    NO_CASH_SESSION: "Belum ada shift kas",
    PENDING_ASSISTANCE_REQUIRED: "Tunai belum diterima",
    OPEN_SHIFT_COUNT_REQUIRED: "Shift kas masih terbuka",
    CLOSED_MATCHED: "Kas ditutup · cocok",
    CLOSED_VARIANCE_REVIEW: "Kas ditutup · ada selisih",
  };
  const movementRows = (data.movements || []).map((movement) => `<tr><th scope="row">${escapeHtml(({ SALE: 'Penjualan tunai', REFUND: 'Refund tunai' })[movement.type] ?? movement.type)}</th><td>${dateTime(movement.occurredAt)}</td><td>${movement.orderId ? `<button class="button button-ghost" data-owner-order-detail="${escapeHtml(movement.orderId)}">Lihat pesanan</button>` : '—'}</td><td>${financialMoney(movement.amountRupiah)}</td></tr>`).join("");
  const pendingRows = (data.pendingAssists || []).map((item) => `<tr><th scope="row">${escapeHtml(item.orderNumber)}<small>${item.ageMinutes} menit</small></th><td>${rupiah(item.amountRupiah)}</td><td>${rupiah(item.declaredReceivedRupiah)}</td><td>${rupiah(item.expectedChangeRupiah)}</td></tr>`).join("");
  const warnings = (data.warnings || []).map((warning) => `<li><span>${escapeHtml(warning)}</span><strong>Review</strong></li>`).join("");
  return `<article class="dashboard-card owner-cash-control"><div class="section-heading"><div><p class="eyebrow">Kas & shift kasir · ${escapeHtml(data.reportDate ?? "")}</p><h2>Ringkasan kas shift</h2><p class="card-subtitle">Kas seharusnya = modal awal + penjualan tunai − refund tunai. QRIS dan rekening bank dihitung terpisah.</p></div><span class="status-badge ${data.status === "CLOSED_MATCHED" ? "is-ready" : "is-warning"}">${escapeHtml(statusLabels[data.status] ?? "Perlu diperiksa")}</span></div>
    <section class="metric-grid owner-metrics owner-cash-metrics" aria-label="Angka kas shift">${metric("Modal awal", data.shift ? financialMoney(data.openingCashRupiah) : 'Belum ada shift', data.shift?.shiftName ?? 'Buka shift dari kasir', "queue")}${metric("Penjualan tunai", financialMoney(data.shiftCashSalesRupiah), 'Shift terakhir · tanpa kembalian', "sales")}${metric("Refund tunai", financialMoney(data.shiftCashRefundsRupiah), 'Shift terakhir · mengurangi laci', "orders")}${metric("Kas seharusnya", data.shift ? financialMoney(data.expectedCashRupiah) : 'Belum ada shift', 'Modal + penjualan − refund', "sales")}${metric("Kas hasil hitung", data.actualCashRupiah == null ? 'Belum dihitung' : financialMoney(data.actualCashRupiah), 'Uang fisik saat tutup shift', "queue")}${metric("Selisih kas", data.varianceRupiah == null ? 'Belum dihitung' : financialMoney(data.varianceRupiah), 'Hasil hitung − kas seharusnya', data.varianceRupiah ? "urgent" : "aov")}</section>
    <p class="owner-card-note">Angka di atas untuk shift terakhir pada tanggal ini. Total harian: penjualan tunai ${financialMoney(data.cashSalesRupiah)} · refund tunai ${financialMoney(data.cashRefundsRupiah)}. Rincian harian ada di CSV.</p>
    <p class="owner-card-note">${data.shift?.status === 'closed' ? `Shift kas sudah ditutup. Kas ditinggalkan ${financialMoney(data.cashToLeaveRupiah)} · untuk disetor ${financialMoney(data.depositCashRupiah)}. ` : ''}Tutup shift kas bukan berarti laporan keuangan lengkap atau laba bersih sudah final.</p>
    <div class="button-row"><a class="button button-primary" href="/cashier">${data.shift?.status === 'open' ? 'Hitung & tutup kas di kasir' : 'Buka kasir'}</a><a class="button button-ghost" href="#sales/payments">Lihat penjualan & pembayaran</a></div>
    ${warnings ? `<ul class="readiness-list cash-control-warnings">${warnings}</ul>` : ""}
    ${pendingRows ? `<section class="owner-cash-assist-review" aria-labelledby="owner-cash-assist-title"><div class="section-heading"><div><h3 id="owner-cash-assist-title">Tunai kiosk menunggu kasir</h3><p class="card-subtitle">Nominal ini belum masuk cash sales, stok, KDS, atau laporan paid sebelum uang fisik diterima.</p></div><a class="button button-primary" href="/cashier">Buka Kasir</a></div><div class="dashboard-table" role="region" aria-label="Pembayaran tunai kiosk yang menunggu kasir" tabindex="0"><table><caption>Antrean bantuan tunai</caption><thead><tr><th scope="col">Order</th><th scope="col">Tagihan</th><th scope="col">Uang rencana</th><th scope="col">Kembalian estimasi</th></tr></thead><tbody>${pendingRows}</tbody></table></div></section>` : ""}
    ${movementRows ? `<div class="dashboard-table" role="region" aria-label="Pergerakan kas" tabindex="0"><table><caption>Pergerakan kas terbaru · ${(data.movements || []).length} dari ${data.movementCount ?? 0}</caption><thead><tr><th scope="col">Tipe</th><th scope="col">Waktu (WIB)</th><th scope="col">Pesanan</th><th scope="col">Nilai</th></tr></thead><tbody>${movementRows}</tbody></table></div>` : `<p class="owner-card-note">Belum ada pergerakan kas pada tanggal ini.</p>`}
    <a class="button button-ghost" href="/api/operator/reports/cash-control.csv?reportDate=${encodeURIComponent(data.reportDate ?? "")}" download>Unduh rincian kas CSV</a></article>`;
}

function ownerPaymentSettlementView(data = {}) {
  const statusLabels = {
    READY_FOR_CLOSING: "Settlement bersih",
    SETTLEMENT_REQUIRED: "Perlu settlement",
    SETTLEMENT_ISSUE_REVIEW: "Issue settlement",
  };
  const methodRows = (data.methods || []).map((method) => `<tr><th scope="row">${escapeHtml(method.methodName)}<small>${escapeHtml(method.methodType)}</small></th><td>${method.count}</td><td>${rupiah(method.totalRupiah)}</td><td>${method.cashDrawerCount ? `${method.cashDrawerCount} cash drawer` : `${method.settledCount} settled`}</td><td class="${method.uncheckedCount ? "text-warning" : ""}">${method.uncheckedCount ? `${method.uncheckedCount} · ${rupiah(method.uncheckedRupiah)}` : "0"}</td><td class="${method.issueCount ? "text-warning" : ""}">${method.issueCount ? `${method.issueCount} · ${rupiah(method.issueRupiah)}` : "0"}</td></tr>`).join("");
  const paymentRows = (data.payments || []).map((payment) => `<tr><th scope="row">${escapeHtml(payment.orderNumber)}<small>Ref ${escapeHtml(payment.evidenceRef)}</small></th><td>${escapeHtml(payment.methodName)}</td><td>${rupiah(payment.amountRupiah)}</td><td>${escapeHtml(payment.settlementStatus)}${payment.providerFeeRupiah == null ? "" : `<small>Fee ${rupiah(payment.providerFeeRupiah)} · net ${rupiah(payment.netSettlementRupiah ?? 0)}</small>`}</td><td>${dateTime(payment.paidAt)}<small>${payment.ageMinutes == null ? "Belum ada waktu paid" : `${payment.ageMinutes} menit`}</small></td><td>${paymentSettlementReviewControl(payment)}</td></tr>`).join("");
  const warnings = (data.warnings || []).map((warning) => `<li><span>${escapeHtml(warning)}</span><strong>Finance</strong></li>`).join("");
  return `<article class="dashboard-card owner-payment-settlement"><div class="section-heading"><div><p class="eyebrow">Payment settlement · ${escapeHtml(data.reportDate ?? "")}</p><h2>Kontrol settlement payment</h2><p class="card-subtitle">Membaca paid payment per order dan memisahkan cash drawer, QRIS/gateway unchecked, settled, dan issue. Tidak mengubah provider atau bank.</p></div><span class="status-badge ${data.status === "READY_FOR_CLOSING" ? "is-ready" : "is-warning"}">${escapeHtml(statusLabels[data.status] ?? "Perlu review")}</span></div>
    <section class="metric-grid owner-metrics">${metric("Payment paid", data.totalPaymentCount ?? 0, rupiah(data.totalRupiah ?? 0), "sales")}${metric("Belum settlement", rupiah(data.uncheckedRupiah ?? 0), `${data.uncheckedCount ?? 0} payment`, (data.uncheckedCount ?? 0) ? "urgent" : "queue")}${metric("Issue", rupiah(data.issueRupiah ?? 0), `${data.issueCount ?? 0} payment`, (data.issueCount ?? 0) ? "urgent" : "orders")}${metric("Umur tertua", data.oldestUnsettledMinutes == null ? "—" : `${data.oldestUnsettledMinutes} mnt`, "Unsettled non-cash", "aov")}</section>
    ${warnings ? `<ul class="readiness-list cash-control-warnings">${warnings}</ul>` : ""}
    ${methodRows ? `<div class="dashboard-table" role="region" aria-label="Ringkasan settlement payment per metode" tabindex="0"><table><caption>Settlement per metode</caption><thead><tr><th scope="col">Metode</th><th scope="col">Trx</th><th scope="col">Total</th><th scope="col">Beres</th><th scope="col">Unchecked</th><th scope="col">Issue</th></tr></thead><tbody>${methodRows}</tbody></table></div>` : `<p class="owner-card-note">Belum ada payment paid pada tanggal ini.</p>`}
    ${paymentRows ? `<div class="dashboard-table" role="region" aria-label="Payment settlement terbaru" tabindex="0"><table><caption>Payment settlement terbaru</caption><thead><tr><th scope="col">Order</th><th scope="col">Metode</th><th scope="col">Nilai</th><th scope="col">Status settlement</th><th scope="col">Paid</th><th scope="col">Review Owner</th></tr></thead><tbody>${paymentRows}</tbody></table></div>` : ""}
    <a class="button button-ghost" href="/api/operator/reports/payment-settlement.csv?reportDate=${encodeURIComponent(data.reportDate ?? "")}" download>Unduh settlement CSV</a></article>`;
}

function paymentSettlementReviewControl(payment) {
  if (["cash", "none"].includes(payment.methodType)) return '<span class="status-badge is-ready">Cash drawer</span>';
  if (payment.settlementStatus === "settled") {
    const evidence = payment.settlementEvidenceHash ? payment.settlementEvidenceHash.slice(0, 12) : "audit tersimpan";
    return `<span class="status-badge is-ready">Cocok</span><small class="settlement-review-meta">${escapeHtml(evidence)}${payment.settlementReviewedAt ? ` · ${dateTime(payment.settlementReviewedAt)}` : ""}</small>`;
  }
  const fee = payment.providerFeeRupiah ?? 0;
  const net = payment.netSettlementRupiah ?? Math.max(0, payment.amountRupiah - fee);
  return `<details class="settlement-review-control"><summary>${payment.settlementStatus === "issue" ? "Review ulang" : "Cocokkan"}</summary><form class="owner-settlement-review-form"><input type="hidden" name="paymentId" value="${escapeHtml(payment.paymentId)}"><input type="hidden" name="expectedStatus" value="${escapeHtml(payment.settlementStatus)}"><label>Keputusan<select name="decision" required><option value="SETTLED">Cocok & selesai</option><option value="ISSUE" ${payment.settlementStatus === "issue" ? "selected" : ""}>Tandai issue</option></select></label><label>Fee provider<input name="providerFeeRupiah" type="number" min="0" max="${payment.amountRupiah}" step="1" value="${fee}" required></label><label>Net diterima<input name="netSettlementRupiah" type="number" min="0" max="${payment.amountRupiah}" step="1" value="${net}" required></label><label>Referensi statement<input name="evidenceReference" maxlength="120" minlength="4" autocomplete="off" required><small>Disimpan sebagai hash, bukan referensi mentah.</small></label><label>Catatan pemeriksaan<textarea name="reason" minlength="8" maxlength="300" rows="2" required></textarea></label><p class="settlement-review-boundary">Hanya mencatat hasil rekonsiliasi; tidak menghubungi gateway atau bank.</p><button class="button button-primary" type="submit">Simpan review</button><p class="form-status" role="status" aria-live="polite"></p></form></details>`;
}

function ownerWorkforcePage() {
  return `<section id="owner-hr-dashboard" class="owner-hr-dashboard" aria-label="HR dan tim"></section>`;
}

function ownerMemberPage(data) {
  const member = data.member ?? {};
  const recommendationPreview = Boolean(member.activeFixtureTier);
  const recommendationRows = (member.recommendations ?? []).map((item) => `<tr><th scope="row">${escapeHtml(item.productName)}<small>${escapeHtml(item.reason)}</small></th><td>${item.priceRupiah == null ? "—" : rupiah(item.priceRupiah)}</td><td><span class="status-badge ${item.available ? "is-ready" : "is-warning"}">${item.available ? "Tersedia" : "Tidak tersedia"}</span></td></tr>`).join("");
  const topRows = (member.topProducts ?? []).map((item, index) => `<li><span>${index + 1}</span><div><strong>${escapeHtml(item.name)}</strong><small>${item.qty} item member</small></div><b>${rupiah(item.salesRupiah)}</b></li>`).join("");
  const privacyRows = (member.privacyRules ?? []).map((item) => `<li><span>${escapeHtml(item)}</span><strong>Wajib</strong></li>`).join("");
  return `<section class="metric-grid owner-metrics" aria-label="Ringkasan member dan loyalty">${metric("Order member", member.identifiedOrderCount ?? 0, `Tanggal ${data.businessDate}`, "orders")}${metric("Nilai member", rupiah(member.identifiedSalesRupiah ?? 0), "Agregat masked", "sales")}${metric("Diskon member", rupiah(member.memberDiscountRupiah ?? 0), "Dari quote server", "aov")}${metric("Reward committed", member.rewardCommittedCount ?? 0, `${member.rewardReversedCount ?? 0} reversed`, "queue")}</section>
    <section class="dashboard-grid">
      <article class="dashboard-card span-7"><div class="section-heading"><div><h2>${recommendationPreview ? "Contoh rekomendasi" : "Rekomendasi member"}</h2><p class="card-subtitle">${recommendationPreview ? "Skenario pilot dari katalog; belum menjadi rekomendasi pelanggan nyata." : "Dipakai kiosk setelah member terkonfirmasi; ketersediaan mengikuti katalog server."}</p></div><span class="status-badge is-warning">${escapeHtml(memberStatusLabel(member.externalStatus))}</span></div>${recommendationRows ? `<div class="dashboard-table" role="region" aria-label="${recommendationPreview ? "Contoh rekomendasi" : "Rekomendasi member"}" tabindex="0"><table><caption>${recommendationPreview ? "Contoh rekomendasi dari katalog" : "Rekomendasi member masked"}</caption><thead><tr><th scope="col">Menu</th><th scope="col">Harga</th><th scope="col">Status</th></tr></thead><tbody>${recommendationRows}</tbody></table></div>` : '<p class="owner-card-note">Belum ada rekomendasi yang aman ditampilkan.</p>'}</article>
      <article class="dashboard-card span-5"><div class="section-heading"><div><h2>Customer Platform</h2><p class="card-subtitle">Dashboard hanya memakai agregat POS lokal sampai kontrak eksternal siap.</p></div></div><ul class="readiness-list"><li><span>Sumber data</span><strong>${escapeHtml(memberSourceLabel(member.source))}</strong></li><li><span>Status koneksi</span><strong>${escapeHtml(memberStatusLabel(member.externalStatus))}</strong></li><li><span>Pesanan dengan promo</span><strong>${member.promotionOrderCount ?? 0}</strong></li></ul></article>
      <article class="dashboard-card span-5"><div class="section-heading"><div><h2>Menu member teratas</h2><p class="card-subtitle">Akan terisi dari transaksi member paid.</p></div></div>${topRows ? `<ol class="rank-list">${topRows}</ol>` : '<div class="operator-empty compact"><p>Belum ada transaksi member paid pada tanggal ini.</p></div>'}</article>
      <article class="dashboard-card span-7"><div class="section-heading"><div><h2>Aturan privasi loyalty</h2><p class="card-subtitle">Mencegah dashboard menjadi tempat bocor data pelanggan.</p></div><span class="status-badge ${recommendationPreview ? "is-warning" : "is-ready"}">${member.availableRecommendationCount ?? 0}/${member.recommendationCount ?? 0} ${recommendationPreview ? "item contoh tersedia" : "rekomendasi tersedia"}</span></div><ul class="readiness-list">${privacyRows}</ul></article>
    </section><details id="owner-member-diagnostics" class="owner-member-diagnostics" ${memberDiagnosticsOpen ? "open" : ""}><summary>Diagnostik Member · simulasi tanpa transaksi nyata</summary>${ownerPhase5MemberLifecycleView()}</details>`;
}

function ownerPhase5MemberLifecycleView() {
  if (["idle", "loading"].includes(phase5MemberState.status)) return '<article class="dashboard-card" role="status"><span class="status-badge">Memeriksa</span><h2>Menyiapkan simulasi Saga Member…</h2></article>';
  const readiness = phase5MemberState.readiness;
  const result = phase5MemberState.result;
  const scenarioOptions = (phase5MemberState.scenarios ?? []).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === phase5MemberDraft.scenario ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const resultView = result ? `<article class="dashboard-card phase5-member-result"><div class="section-heading"><div><p class="eyebrow">Hasil simulasi · ${escapeHtml(result.operationId)}</p><h3>${escapeHtml(result.scenarioLabel)}</h3><p class="card-subtitle">Fingerprint replay ${escapeHtml(result.replayFingerprint.slice(0, 16))} · provider tidak dipanggil · fakta bisnis tidak berubah.</p></div><span class="status-badge ${result.reconciliation?.required ? "is-warning" : "is-ready"}">${result.reconciliation?.required ? "Perlu rekonsiliasi" : "Converged"}</span></div><section class="metric-grid owner-metrics">${metric("Earn", `${result.earnedPoints} poin`, rupiah(result.eligibleSpendRupiah), "sales")}${metric("Redeem", `${result.rewardCostPoints} poin`, "Reserve → commit", "queue")}${metric("Sesudah reversal", `${result.projectedBalanceAfterReversal} poin`, "Proyeksi kembali", "aov")}</section><ol class="phase5-member-steps">${(result.steps ?? []).map((step) => `<li><span>${escapeHtml(step.id)}</span><div><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.status)}</small></div><b>${step.points} poin</b></li>`).join("")}</ol>${result.reconciliation?.required ? `<div class="business-readiness-summary"><span class="status-badge is-warning">${escapeHtml(result.reconciliation.target)}</span><p>${escapeHtml(result.reconciliation.action)} · owner: ${escapeHtml(result.reconciliation.owner)}</p></div>` : ""}<p class="owner-card-note">${escapeHtml(result.note)}</p></article>` : "";
  const error = phase5MemberState.error ? `<p class="form-status is-error" role="alert">${escapeHtml(phase5MemberState.error)}</p>` : "";
  return `<section class="phase5-member-console" aria-labelledby="phase5-member-console-title"><article class="dashboard-card"><div class="section-heading"><div><p class="eyebrow">Diagnostik · lifecycle loyalty</p><h2 id="phase5-member-console-title">Uji earn → redeem → reversal</h2><p class="card-subtitle">Simulator Owner tidak memakai data pelanggan dan tidak menulis poin nyata.</p></div><span class="status-badge ${readiness?.activationSafe ? "is-ready" : "is-warning"}">${readiness?.score ?? 0}% · ${readiness?.readyChecks ?? 0}/${readiness?.totalChecks ?? 0} pemeriksaan teknis</span></div><form id="phase5-member-simulator" class="phase5-member-form"><label>Skenario<select name="scenario" required>${scenarioOptions}</select></label><label>Nilai belanja eligible<input name="eligibleSpendRupiah" type="number" min="1000" max="100000000" step="1000" value="${phase5MemberDraft.eligibleSpendRupiah}" required></label><label>Biaya reward (poin)<input name="rewardCostPoints" type="number" min="1" max="1000000" step="1" value="${phase5MemberDraft.rewardCostPoints}" required></label><label>Idempotency key<input name="idempotencyKey" pattern="[A-Za-z0-9._:-]{8,120}" value="${escapeHtml(phase5MemberDraft.idempotencyKey)}" required></label><button class="button button-primary" type="submit" ${phase5MemberState.status === "running" ? "disabled" : ""}>${phase5MemberState.status === "running" ? "Menjalankan…" : "Jalankan simulasi"}</button>${error}</form><p class="owner-card-note">Gate tersisa adalah UAT mutasi provider terkontrol; simulator ini sengaja tidak mengaktifkan loyalty nyata.</p></article>${resultView}</section>`;
}

function memberStatusLabel(value) {
  return value === "CUSTOMER_PLATFORM_EXTERNAL_CONTRACT_PENDING" ? "Kontrak eksternal pending" : value ?? "UNVERIFIED";
}

function memberSourceLabel(value) {
  return value === "LOCAL_AGGREGATE_ONLY_NO_RAW_MEMBER_PII" ? "Agregat POS lokal" : value ?? "UNVERIFIED";
}

function ownerIntegrationsPage() {
  const integrations = snapshot.integrations || {};
  const groups = [["Pembayaran", ["qris"]], ["Member & reward", ["member", "reward"]], ["Perangkat", ["printer", "nfc"]], ["Layanan", ["persistence", "staging", "production"]]];
  const known = new Set(groups.flatMap(([, keys]) => keys));
  const other = Object.keys(integrations).filter((key) => !known.has(key));
  if (other.length) groups.push(["Layanan lain", other]);
  return `<article class="dashboard-card"><div class="section-heading"><div><h2>Integrasi</h2><p class="card-subtitle">Mode runtime dan kebutuhan verifikasi; bukan bukti transaksi atau perangkat sudah siap.</p></div></div>${groups.filter(([, keys]) => keys.some((key) => key in integrations)).map(([label, keys]) => `<section class="owner-integration-group" aria-label="${label}"><h3>${label}</h3><div class="integration-list owner-integrations">${keys.filter((key) => key in integrations).map((key) => ownerIntegrationRow(key, integrations[key])).join("")}</div></section>`).join("")}</article>`;
}

function ownerReportsPage(data) {
  const dateQuery = reportDate ? `?reportDate=${encodeURIComponent(data.businessDate)}` : "";
  const reporting = snapshot.inventoryReportingStatus;
  const reportingReady = reporting?.ready === true;
  const reportingLabel = reportingReady ? "Laporan aktif" : reporting?.mode === "OFF" ? "Belum diaktifkan" : "Laporan belum siap";
  const reportingNote = reportingReady
    ? "Lihat histori stok, valuasi, HPP, dan sumber data laporan inventory."
    : reporting?.mode === "OFF"
      ? "Layanan laporan inventory belum diaktifkan. Laporan lain di bawah tetap dapat diunduh."
      : "Layanan laporan inventory belum siap. Periksa status layanan sebelum memakai datanya.";
  return `<section id="esb-owner-report-integration" aria-label="Laporan operasional Owner"><p role="status">Menyiapkan laporan otoritatif…</p></section><div class="esb-owner-report-legacy-heading"><h2>Laporan operasional tambahan</h2><p class="card-subtitle">Pilih ekspor menurut pekerjaan. Data memakai tanggal bisnis yang dipilih, kecuali varians stok yang memakai pasangan penghitungan.</p></div>
    <section class="report-download-group" aria-labelledby="report-sales-title"><h3 id="report-sales-title">Penjualan</h3><div class="report-download-grid">
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Keuangan</h4><p>Pesanan, tagihan, pembayaran, selisih, dan kelengkapan data HPP.</p><a class="button button-primary" href="/api/operator/reports/financial.csv${dateQuery}" download>Unduh laporan keuangan</a></article>
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Perbandingan penjualan</h4><p>Bandingkan hari bisnis terpilih dengan hari sebelumnya tanpa mencampur antrean live.</p><a class="button button-ghost" href="/api/operator/reports/sales-period-comparison.csv${dateQuery}" download>Unduh perbandingan sales</a></article>
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Tren WTD/MTD</h4><p>Bandingkan minggu dan bulan berjalan dengan periode sebelumnya yang setara.</p><a class="button button-ghost" href="/api/operator/reports/sales-trend-comparison.csv${dateQuery}" download>Unduh trend sales</a></article>
    </div></section><section class="report-download-group" aria-labelledby="report-cash-title"><h3 id="report-cash-title">Kas & pembayaran</h3><div class="report-download-grid">
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Cash drawer</h4><p>Kas awal, penjualan tunai, refund, kas yang diharapkan, hitungan aktual, dan selisih.</p><a class="button button-ghost" href="/api/operator/reports/cash-control.csv${dateQuery}" download>Unduh cash control</a></article>
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Settlement pembayaran</h4><p>Pisahkan kas, QRIS yang belum diperiksa, settled, issue, dan rincian per pesanan.</p><a class="button button-ghost" href="/api/operator/reports/payment-settlement.csv${dateQuery}" download>Unduh settlement payment</a></article>
    </div></section><section class="report-download-group" aria-labelledby="report-supplier-title"><h3 id="report-supplier-title">Supplier & AP</h3><div class="report-download-grid">
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Aging AP</h4><p>Invoice supplier terbuka, jatuh tempo, credit, pembayaran, dan outstanding.</p><a class="button button-ghost" href="/api/operator/reports/accounts-payable-aging.csv${dateQuery}" download>Unduh aging AP</a></article>
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Pembayaran supplier</h4><p>Referensi pembayaran manual untuk rekonsiliasi; tidak mengirim dana.</p><a class="button button-ghost" href="/api/operator/reports/supplier-payments.csv${dateQuery}" download>Unduh payment supplier</a></article>
    </div></section><section class="report-download-group" aria-labelledby="report-inventory-title"><h3 id="report-inventory-title">Inventory & HPP</h3><div class="report-download-grid">
    <article class="dashboard-card"><span class="status-badge ${reportingReady ? "is-ready" : "is-warning"}">${reportingLabel}</span><h4>Laporan inventory</h4><p>${reportingNote}</p>${reportingReady ? `<a class="button button-primary" href="/inventory-reports">Buka laporan inventory</a>` : `<span class="disabled-action" aria-disabled="true">Laporan belum tersedia</span>`}</article>
    <article class="dashboard-card"><span class="status-badge is-ready">Khusus Owner</span><h4>Pemakaian bahan</h4><p>Pemakaian berdasarkan resep saat transaksi terbayar, sesuai tanggal bisnis.</p><a class="button button-ghost" href="/api/operator/reports/theoretical-usage.csv${dateQuery}" download>Unduh pemakaian bahan</a></article>
    <article class="dashboard-card"><span class="status-badge ${data.inventoryVariance?.status === "VERIFIED" ? "is-ready" : "is-warning"}">Perlu dua penghitungan stok lengkap</span><h4>Varians stok</h4><p>Bandingkan pemakaian aktual dengan resep serta bukti penerimaan dan bahan terbuang.</p><a class="button button-ghost" href="/api/operator/reports/inventory-variance.csv" download>Unduh varians stok</a></article>
    </div></section>${ownerInventoryVarianceView(data.inventoryVariance)}`;
}

async function loadEsbOwnerReport(filters, { signal } = {}) {
  const params = new URLSearchParams(filters);
  const response = await fetch(`/api/operator/reports/esb-owner?${params}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || "Laporan authoritative belum tersedia."), { status: response.status });
  return payload;
}

function ownerSettingsPage() {
  const ordering = snapshot.orderingSettings;
  const payment = ownerIntegrationState("qris", snapshot.integrations?.qris);
  const member = ownerIntegrationState("member", snapshot.integrations?.member);
  return `<section class="dashboard-card catalog-ordering-card owner-settings-ordering" aria-labelledby="owner-settings-ordering-title">
    <div class="section-heading"><div><p class="eyebrow">Outlet aktif · ${escapeHtml(snapshot.context?.outletName ?? "Kopi Saga Salak")}</p><h2 id="owner-settings-ordering-title">Jam layanan & pemesanan</h2><p class="card-subtitle">Pengaturan ini berlaku untuk pesanan baru di kasir dan kiosk. Pesanan yang sudah masuk tetap diproses.</p></div><span class="status-badge ${ordering.paused ? "is-warning" : "is-ready"}">${ordering.paused ? "Kasir & kiosk dijeda" : "Kasir & kiosk menerima pesanan"}</span></div>
    <form id="catalog-ordering-settings">
      <div class="owner-settings-switches"><label class="catalog-checkbox"><input name="acceptOrders" type="checkbox" ${ordering.paused ? "" : "checked"}>Terima pesanan baru di kasir & kiosk</label><label class="catalog-checkbox"><input name="enforceHours" type="checkbox" ${ordering.enforceHours ? "checked" : ""}>Batasi kasir & kiosk sesuai jam layanan</label></div>
      <div class="owner-settings-hours"><label>Mulai buka<input name="opensAt" type="time" value="${escapeHtml(ordering.opensAt)}" required></label><label>Pesanan terakhir<input name="lastOrderAt" type="time" value="${escapeHtml(ordering.lastOrderAt)}" required></label><label>Tutup outlet<input name="closesAt" type="time" value="${escapeHtml(ordering.closesAt)}" required></label></div>
      <label>Alasan perubahan<input name="reason" type="text" maxlength="160" placeholder="Contoh: jam layanan hari ini berubah" required></label><div class="button-row owner-settings-submit"><button class="button button-primary" type="submit">Simpan pengaturan</button><button class="button button-ghost" type="button" data-ordering-refresh>Perbarui data</button><button class="button button-ghost" type="button" data-ordering-discard>Batalkan perubahan</button><p role="status" aria-live="polite"></p></div>
      <p class="owner-card-note">Saat ini berlaku: ${escapeHtml(ordering.opensAt)}–${escapeHtml(ordering.closesAt)}, pesanan terakhir ${escapeHtml(ordering.lastOrderAt)} · ${ordering.paused ? "pesanan dijeda" : "menerima pesanan"} · ${ordering.enforceHours ? "batas jam aktif" : "batas jam nonaktif"}. Draft belum berlaku sampai berhasil disimpan.</p>
    </form><p class="owner-card-note">Menjeda pesanan juga menahan quote baru di kasir, bukan hanya kiosk. Jam memakai WIB untuk outlet ini. Jika data berubah di sesi lain, perbarui halaman lalu cek ulang sebelum menyimpan.</p>
  </section><section class="dashboard-action-grid owner-settings-links" aria-label="Pengaturan lainnya">
    <article class="dashboard-card dashboard-action-card"><h2>Outlet</h2><p>${escapeHtml(snapshot.context?.outletName ?? "Kopi Saga Salak")} adalah satu-satunya outlet aktif. Penggantian outlet belum tersedia.</p><span class="disabled-action" aria-disabled="true">Satu outlet aktif</span></article>
    <article class="dashboard-card dashboard-action-card"><h2>Menu & kiosk</h2><p>Atur menu, ketersediaan, dan tampilan kiosk di modul Menu & promo tanpa pindah aplikasi.</p><a class="button button-ghost" href="#catalog">Buka Menu & promo</a></article>
    <article class="dashboard-card dashboard-action-card"><h2>Pembayaran & perangkat</h2><p>Gateway: ${escapeHtml(payment.label)}. Member: ${escapeHtml(member.label)}. Pengaktifan provider atau perangkat nyata memerlukan verifikasi terpisah.</p><a class="button button-ghost" href="#integrations">Lihat integrasi</a></article>
    <article class="dashboard-card dashboard-action-card"><h2>${snapshot.actor?.teamManaged ? "Tim & Akses" : "Akses staf"}</h2><p>${snapshot.actor?.teamManaged ? "Buat role, pilih fitur, dan tetapkan akun staf pribadi." : "Kelola akun, jadwal, dan absensi staf dari Tim & shift."}</p><a class="button button-ghost" href="${snapshot.actor?.teamManaged ? "/team-access" : "#workforce"}">${snapshot.actor?.teamManaged ? "Buka Tim & Akses" : "Buka Tim & shift"}</a></article>
  </section>`;
}

function ownerHourlySalesView(rows = []) {
  if (!rows.length) return '<div class="section-heading"><div><h2>Penjualan per jam</h2><p class="card-subtitle">Belum ada transaksi pada periode ini.</p></div></div><div class="operator-empty compact"><p>Grafik akan muncul setelah pembayaran tercatat.</p></div>';
  const max = Math.max(...rows.map((row) => Number(row.netSalesRupiah || 0)), 1);
  return `<div class="section-heading"><div><h2>Penjualan per jam</h2><p class="card-subtitle">Nilai tagihan terbayar per jam, termasuk pajak/layanan; bukan penjualan menu bersih.</p></div></div><ol class="hourly-chart" aria-label="Penjualan per jam">${rows.map((row) => `<li><span>${escapeHtml(row.hour)}</span><div><i style="--bar-size:${Math.max(4, Math.round((Number(row.netSalesRupiah || 0) / max) * 100))}%"></i></div><strong>${rupiah(row.netSalesRupiah)}</strong><small>${row.totalOrders} order</small></li>`).join("")}</ol>`;
}

function ownerTopProductsView(rows = []) {
  return rows.length ? `<ol class="rank-list">${rows.slice(0, 5).map((item, index) => `<li><span>${index + 1}</span><div><strong>${escapeHtml(item.name)}</strong><small>${item.qty} item</small></div><b>${rupiah(item.salesRupiah)}</b></li>`).join("")}</ol>` : '<div class="operator-empty compact"><p>Belum ada data menu.</p></div>';
}

function ownerPaymentBreakdownView(payments = []) {
  return payments.length ? `<div class="payment-breakdown">${payments.map(ownerPaymentRow).join("")}</div>` : '<div class="operator-empty compact"><p>Belum ada pembayaran terkonfirmasi di POS.</p></div>';
}

function ownerOrdersTable(data, compact) {
  const periodLabel = reportDate ? escapeHtml(data.businessDate) : "hari ini";
  return data.recentOrders.length ? `<div class="table-wrap dashboard-table" role="region" aria-label="Transaksi terbaru" tabindex="0"><table><caption class="sr-only">Pesanan terbayar terbaru ${periodLabel}</caption><thead><tr><th scope="col">Order</th><th scope="col">Menu</th><th scope="col">Metode</th><th scope="col">Total</th></tr></thead><tbody>${data.recentOrders.slice(0, compact ? 5 : 8).map((order) => `<tr><th scope="row"><strong>${escapeHtml(order.orderNumber)}</strong><small>${formatTime(order.paidAt || order.createdAt)}</small></th><td>${escapeHtml(order.items.map((item) => `${item.qty}× ${item.productNameSnapshot}`).join(", "))}</td><td>${escapeHtml(order.payments.map((item) => item.methodNameSnapshot).join(", "))}</td><td><strong>${rupiah(order.totalRupiah)}</strong></td></tr>`).join("")}</tbody></table></div>` : '<div class="operator-empty compact"><p>Belum ada transaksi terbayar pada tanggal ini.</p></div>';
}

function dashboardView() {
  const data = snapshot.dashboard;
  const isToday = !reportDate;
  const payments = Object.values(data.paymentMethod || {});
  const uncheckedPayments = payments.reduce((sum, item) => sum + Number(item.uncheckedCount || 0), 0);
  const queueCounts = Object.fromEntries(["NEW", "IN_PROGRESS", "READY"].map((status) => [status, snapshot.queue.filter((item) => item.status === status).length]));
  const oldestMinutes = snapshot.queue.length ? ticketAge(snapshot.queue[0]).minutes : 0;
  const attentionItems = buildOwnerAttention({ uncheckedPayments, oldestMinutes, queueCounts, financialIssues: data.financialSummary?.issueCount ?? 0, recipeUsage: data.theoreticalIngredientUsage, inventoryVariance: data.inventoryVariance });
  const html = `
    <section class="owner-command" aria-labelledby="owner-now-title">
      <div><p class="eyebrow">Live outlet · ${formatDate(snapshot.serverTime)}</p><h2 id="owner-now-title">${attentionItems.length ? `${attentionItems.length} hal perlu dilihat` : "Operasional terkendali"}</h2><p>Ringkasan hanya memakai fakta order dan payment dari server.</p></div>
      <div class="owner-freshness"><span>Terakhir diperbarui</span><strong>${formatTime(snapshot.serverTime)}</strong><small>${escapeHtml(data.source)}</small></div>
    </section>
    <section class="metric-grid owner-metrics" aria-label="Ringkasan penjualan ${escapeHtml(data.businessDate)}">
      ${metric("Penjualan menu", financialMoney(data.financialSummary?.menuSalesRupiah), "Setelah diskon · tanpa pajak/layanan", "sales")}
      ${metric("Order", data.totalOrders, "Kiosk + assisted", "orders")}
      ${metric("Rata-rata menu", financialMoney(data.aovRupiah), "Per order · tanpa pajak/layanan", "aov")}
      ${metric("Antrean aktif", snapshot.queue.length, oldestMinutes ? `Tertua ${oldestMinutes} menit` : "Belum ada tiket", oldestMinutes >= 10 ? "urgent" : "queue")}
    </section>
    <section class="owner-now-grid">
      <article class="dashboard-card owner-attention"><div class="section-heading"><div><p class="eyebrow">Sekarang</p><h2>Perlu ditindak</h2></div><span class="owner-count">${attentionItems.length}</span></div>
        ${attentionItems.length ? `<ul>${attentionItems.map(ownerAttentionItem).join("")}</ul>` : '<div class="owner-clear"><span aria-hidden="true">✓</span><div><strong>Tidak ada alert aktif</strong><p>Antrean dan payment check berada dalam batas lokal.</p></div></div>'}
      </article>
      <article class="dashboard-card owner-queue"><div class="section-heading"><div><p class="eyebrow">Produksi</p><h2>Ritme antrean</h2></div><strong>${snapshot.queue.length} aktif</strong></div>
        <div class="owner-queue-stages">${ownerQueueStage("Baru", queueCounts.NEW, "Masuk")}${ownerQueueStage("Diproses", queueCounts.IN_PROGRESS, "Dibuat")}${ownerQueueStage("Siap", queueCounts.READY, "Diambil")}</div>
        <p class="owner-card-note">Tiket tertua selalu menjadi prioritas KDS. Dashboard tidak mengubah status produksi.</p>
      </article>
    </section>
    <form id="owner-report-filter" class="owner-report-filter"><label for="report-date">Tanggal bisnis (WIB)</label><input id="report-date" name="reportDate" type="date" required value="${escapeHtml(data.businessDate)}"><button class="button" type="submit">Tampilkan laporan</button><p>Penjualan: ${escapeHtml(data.businessDate)}. Antrean di atas tetap live, bukan histori.</p></form>
    ${ownerFinancialView(data.financialSummary)}
    <section class="dashboard-grid owner-detail-grid">
      <article class="dashboard-card span-7"><div class="section-heading"><div><p class="eyebrow">${isToday ? "Hari ini" : escapeHtml(data.businessDate)}</p><h2>Order terbaru</h2></div><span class="service-state"><span class="dot"></span> Live server</span></div>
        ${data.recentOrders.length ? `<div class="table-wrap"><table><caption class="sr-only">Pesanan terbayar terbaru hari ini</caption><thead><tr><th scope="col">Order</th><th scope="col">Menu</th><th scope="col">Metode</th><th scope="col">Total</th></tr></thead><tbody>${data.recentOrders.slice(0, 8).map((order) => `<tr><th scope="row"><strong>${escapeHtml(order.orderNumber)}</strong><small>${formatTime(order.paidAt || order.createdAt)}</small></th><td>${escapeHtml(order.items.map((item) => `${item.qty}× ${item.productNameSnapshot}`).join(", "))}</td><td>${escapeHtml(order.payments.map((item) => item.methodNameSnapshot).join(", "))}</td><td><strong>${rupiah(order.totalRupiah)}</strong></td></tr>`).join("")}</tbody></table></div>` : '<div class="operator-empty compact"><p>Belum ada transaksi terbayar hari ini.</p></div>'}
      </article>
      <article class="dashboard-card span-5"><p class="eyebrow">Hari ini</p><h2>Menu teratas</h2>${data.topProducts.length ? `<ol class="rank-list">${data.topProducts.slice(0, 5).map((item, index) => `<li><span>${index + 1}</span><div><strong>${escapeHtml(item.name)}</strong><small>${item.qty} item</small></div><b>${rupiah(item.salesRupiah)}</b></li>`).join("")}</ol>` : '<div class="operator-empty compact"><p>Data akan muncul setelah pembayaran.</p></div>'}</article>
      <article class="dashboard-card span-7"><div class="section-heading"><div><p class="eyebrow">Verifikasi</p><h2>Metode pembayaran</h2></div><span class="owner-count ${uncheckedPayments ? "is-warning" : ""}">${uncheckedPayments} belum dicek</span></div>
        ${payments.length ? `<div class="payment-breakdown">${payments.map(ownerPaymentRow).join("")}</div>` : '<div class="operator-empty compact"><p>Belum ada pembayaran terkonfirmasi di POS.</p></div>'}
      </article>
      <article class="dashboard-card span-5"><p class="eyebrow">Persediaan · ${isToday ? "hari ini" : escapeHtml(data.businessDate)}</p><h2>Pembelian & pengurangan</h2><div class="boundary-status"><div><span>Bahan diterima</span><strong>${rupiah(data.purchaseTodayRupiah)}</strong><small>Berdasarkan receipt tersimpan</small></div><div><span>Waste / pengurangan</span><strong>${rupiah(data.wasteTodayRupiah)}</strong><small>Tidak termasuk selisih cycle count</small></div></div><a class="button button-ghost" href="#inventory/warehouse">Kelola stok & HPP</a></article>
      ${ownerTheoreticalUsageView(data.theoreticalIngredientUsage)}
      ${ownerInventoryVarianceView(data.inventoryVariance)}
      <article class="dashboard-card span-12"><p class="eyebrow">Boundary pilot</p><h2>Kesiapan integrasi</h2><div class="integration-list owner-integrations">${Object.entries(snapshot.integrations || {}).map(([key, value]) => ownerIntegrationRow(key, value)).join("")}</div></article>
    </section>`;
  return reportDate ? html.replaceAll("Hari ini", escapeHtml(data.businessDate)).replaceAll("hari ini", escapeHtml(data.businessDate)) : html;
}

function ownerInventoryVarianceView(data) {
  if (!data) return '<article class="dashboard-card span-12"><h2>Varians stok belum tersedia</h2><p>Muat ulang setelah koneksi pulih.</p></article>';
  const preparingBoundary = data.basis.includes("PREPARING_RECIPE_SNAPSHOTS");
  const theoreticalTiming = preparingBoundary
    ? "Data baru menghitung resep saat menu mulai dibuat; transaksi legacy tertentu masih memakai waktu pembayaran."
    : "Data lama menghitung resep berdasarkan waktu pembayaran; bandingkan dengan catatan stok pada periode yang sama.";
  if (data.status === "REQUIRES_TWO_COUNTS") {
    const completedCounts = data.availableCounts.length;
    const nextStep = completedCounts === 0
      ? "Belum ada hitungan lengkap. Hitung stok pembuka, lalu hitung stok penutup setelah periode berjalan."
      : "Satu hitungan lengkap sudah ada. Lakukan hitungan berikutnya setelah periode berjalan untuk membandingkan pemakaian.";
    return `<article id="owner-inventory-variance" class="dashboard-card span-12 owner-variance" aria-labelledby="owner-variance-title">
      <div class="section-heading"><div><p class="eyebrow">Stok aktual × resep</p><h2 id="owner-variance-title">Varians bahan per periode</h2></div><span class="owner-count is-warning">Perlu 2 hitungan</span></div>
      <div class="owner-variance-prerequisite"><strong>${completedCounts} dari 2 hitungan lengkap tersimpan</strong><p>${nextStep}</p><p>Dua hitungan diperlukan agar stok awal + penerimaan bersih − stok akhir dapat dibandingkan dengan resep. ${theoreticalTiming} Ini belum menjadi HPP aktual final.</p><a class="button button-ghost" href="#inventory/warehouse" data-warehouse-count-shortcut>Buka Gudang untuk hitung stok</a></div>
    </article>`;
  }
  const formatQuantity = (value, unit) => value == null ? "Belum valid" : `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(value)} ${escapeHtml(unit || "")}`;
  const labels = { VERIFIED: "Periode terverifikasi", PARTIAL: "Cakupan belum lengkap" };
  const countOption = (count, selectedId) => `<option value="${escapeHtml(count.id)}" data-completed-at="${escapeHtml(count.completedAt)}" ${count.id === selectedId ? "selected" : ""}>${formatDate(count.completedAt)} · ${formatTime(count.completedAt)} · ${escapeHtml(count.reason || "Hitung stok lengkap")}</option>`;
  const selectionParams = new URLSearchParams({ openingCountId: data.openingCount.id, closingCountId: data.closingCount.id });
  const rows = data.rows.map((row) => `<tr><th scope="row"><strong>${escapeHtml(row.name)}</strong><small>${row.sourceProducts.length ? row.sourceProducts.map((item) => `${item.qty}× ${escapeHtml(item.name)}`).join(" · ") : "Belum ada pemakaian dari menu"}</small></th><td>${formatQuantity(row.openingQuantityBase, row.unit)}</td><td>${formatQuantity(row.purchaseQuantityBase, row.unit)}</td><td>${formatQuantity(row.closingQuantityBase, row.unit)}</td><td><strong>${formatQuantity(row.actualQuantityBase, row.unit)}</strong></td><td>${formatQuantity(row.theoreticalQuantityBase, row.unit)}</td><td><strong>${formatQuantity(row.varianceQuantityBase, row.unit)}</strong><small>${row.recordedWasteQuantityBase ? `${formatQuantity(row.recordedWasteQuantityBase, row.unit)} bahan terbuang tercatat` : "Tanpa bahan terbuang tercatat"}</small></td></tr>`).join("");
  const evidenceRows = data.rows.filter((row) => row.purchaseEvidence?.totalCount || row.depletionEvidence?.totalCount).map((row) => ownerVarianceEvidenceRow(row, formatQuantity)).join("");
  const readyPrerequisites = preparingBoundary
    ? "Kedua penghitungan lengkap, waktu mulai dibuat atau fallback legacy tercatat, dan cakupan resep 100%."
    : "Kedua penghitungan lengkap, seluruh pesanan terbayar memiliki waktu pembayaran, dan cakupan resep 100%.";
  return `<article id="owner-inventory-variance" class="dashboard-card span-12 owner-variance" aria-labelledby="owner-variance-title">
    <div class="section-heading"><div><p class="eyebrow">Antara 2 hitungan</p><h2 id="owner-variance-title">Aktual vs teoretis</h2><p>${formatDate(data.openingCount.completedAt)} ${formatTime(data.openingCount.completedAt)} → ${formatDate(data.closingCount.completedAt)} ${formatTime(data.closingCount.completedAt)}</p></div><span class="owner-count ${data.status === "VERIFIED" ? "" : "is-warning"}">${labels[data.status] || "Perlu diperiksa"}</span></div>
    <form id="owner-variance-filter" class="owner-variance-filter"><div><label for="variance-opening-count">Hitungan pembuka</label><select id="variance-opening-count" name="openingCountId" required>${data.availableCounts.map((count) => countOption(count, data.openingCount.id)).join("")}</select></div><span aria-hidden="true">→</span><div><label for="variance-closing-count">Hitungan penutup</label><select id="variance-closing-count" name="closingCountId" required>${data.availableCounts.map((count) => countOption(count, data.closingCount.id)).join("")}</select></div><button class="button" type="submit" data-variance-submit>Bandingkan periode</button><button class="button button-ghost" type="button" data-variance-latest ${inventoryCountPair.openingCountId ? "" : "disabled"}>Kembali ke hitungan terbaru</button><p id="variance-filter-help" aria-live="polite">Pilih dua penghitungan stok lengkap. Penerimaan dibaca setelah pembuka hingga penutup, termasuk waktu penutup. ${theoreticalTiming}</p></form>
    <div class="owner-variance-metrics"><div><span>Pemakaian aktual</span><strong>${financialMoney(data.actualUsageValueRupiah)}</strong><small>Stok awal + penerimaan bersih − stok akhir</small></div><div><span>Pemakaian teoretis</span><strong>${financialMoney(data.theoreticalUsageValueRupiah)}</strong><small>Resep saat ${preparingBoundary ? "menu mulai dibuat" : "transaksi terbayar"} × ${data.soldItemQuantity} item</small></div><div><span>Selisih belum terjelaskan</span><strong>${financialMoney(data.varianceValueRupiah)}</strong><small>Termasuk perbedaan porsi, penyusutan, dan kesalahan hitung</small></div><div><span>Bahan terbuang tercatat</span><strong>${rupiah(data.recordedWasteValueRupiah)}</strong><small>Bukti penyebab, tidak dikurangkan dua kali</small></div></div>
    ${data.blockers.length ? `<div class="owner-usage-boundary"><strong>Jangan gunakan sebagai HPP aktual final</strong><p>${data.blockers.map(varianceBlockerLabel).join(" · ")}</p></div>` : `<div class="owner-variance-ready"><strong>Periode dapat dibandingkan</strong><p>${readyPrerequisites} Selidiki bahan dengan nilai selisih terbesar lebih dulu.</p></div>`}
    <div class="table-wrap owner-variance-table" role="region" aria-label="Rincian pemakaian aktual dan berdasarkan resep per bahan" tabindex="0"><table><caption class="sr-only">Stok pembuka, pembelian, stok penutup, pemakaian aktual, teoretis, dan varians</caption><thead><tr><th scope="col">Bahan & sumber</th><th scope="col">Awal</th><th scope="col">Masuk bersih</th><th scope="col">Akhir</th><th scope="col">Aktual</th><th scope="col">Teoretis</th><th scope="col">Varians</th></tr></thead><tbody>${rows}</tbody></table></div>
    <section class="owner-variance-evidence" aria-labelledby="owner-variance-evidence-title"><div class="section-heading"><div><p class="eyebrow">Jejak sumber</p><h3 id="owner-variance-evidence-title">Bukti pembelian & pengurangan</h3><p>Buka bahan untuk melihat penerimaan dan alasan bahan terbuang pada periode terpilih.</p></div><span class="owner-count ${data.evidence?.truncated ? "is-warning" : ""}">${data.evidence?.shownEntries ?? 0}/${data.evidence?.totalEntries ?? 0} bukti</span></div>${evidenceRows ? `<div class="owner-variance-evidence-list">${evidenceRows}</div>` : '<div class="operator-empty compact"><p>Belum ada penerimaan atau pengurangan bahan yang tercatat pada periode ini.</p></div>'}${data.evidence?.truncated ? `<p class="owner-card-note">Tampilan dibatasi ${data.evidence.maxEntries} bukti terbaru pada bahan dengan selisih terbesar. CSV membawa cakupan yang sama dan menandai baris yang terpotong.</p>` : ""}</section>
    <p class="owner-card-note">Periode dimulai setelah penghitungan pembuka hingga penghitungan penutup, termasuk waktu penutup. ${theoreticalTiming} Penghitungan mencatat stok fisik; laporan ini tidak mengubah stok atau pembayaran.</p>
    <a class="button button-ghost" href="/api/operator/reports/inventory-variance.csv?${selectionParams}" download>Unduh perbandingan pemakaian CSV</a>
  </article>`;
}

function syncInventoryCountOptions(form) {
  if (!form) return;
  const opening = form.elements.openingCountId;
  const closing = form.elements.closingCountId;
  const submit = form.querySelector("[data-variance-submit]");
  const help = form.querySelector("#variance-filter-help");
  const openingAt = Date.parse(opening.selectedOptions[0]?.dataset.completedAt || "");
  let firstValid;
  for (const option of closing.options) {
    option.disabled = !Number.isFinite(openingAt) || Date.parse(option.dataset.completedAt || "") <= openingAt;
    if (!option.disabled && !firstValid) firstValid = option;
  }
  if (!closing.selectedOptions[0] || closing.selectedOptions[0].disabled) {
    if (firstValid) firstValid.selected = true;
    else closing.selectedIndex = -1;
  }
  const valid = Boolean(firstValid && closing.value);
  submit.disabled = !valid;
  help.textContent = valid
    ? "Pilih dua penghitungan stok lengkap. Penjualan dan penerimaan dibaca setelah pembuka hingga penutup, termasuk waktu penutup."
    : "Belum ada penghitungan penutup yang lebih baru. Pilih penghitungan pembuka sebelumnya.";
}

function varianceBlockerLabel(code) {
  return ({ COUNT_COVERAGE_MISMATCH: "Daftar bahan pada penghitungan pembuka dan penutup berbeda", PAID_TIMESTAMP_MISSING: "Ada pesanan terbayar tanpa waktu pembayaran yang terverifikasi", RECIPE_COVERAGE_INCOMPLETE: "Catatan resep belum lengkap", ORDER_ITEM_MISSING: "Ada order tanpa item", NEGATIVE_ACTUAL_USAGE: "Pemakaian aktual bernilai negatif", NEGATIVE_ACTUAL_VALUE: "Nilai pemakaian aktual negatif" })[code] || code;
}

function ownerVarianceEvidenceRow(row, formatQuantity) {
  const purchases = row.purchaseEvidence?.entries ?? [];
  const depletions = row.depletionEvidence?.entries ?? [];
  const purchaseCount = row.purchaseEvidence?.totalCount ?? 0;
  const depletionCount = row.depletionEvidence?.totalCount ?? 0;
  const label = `${row.name} · ${purchaseCount} penerimaan · ${depletionCount} pengurangan`;
  const truncated = row.purchaseEvidence?.truncated || row.depletionEvidence?.truncated;
  const sourcePreview = purchases[0]?.supplierName ?? (depletions[0] ? varianceEvidenceTypeLabel(depletions[0].movementType) : truncated ? "Bukti di luar batas tampilan" : "Tanpa sumber tercatat");
  const purchaseItems = purchases.map((entry) => `<li><div><strong>${escapeHtml(entry.supplierName)}</strong><small>${formatDate(entry.occurredAt)} · ${formatTime(entry.occurredAt)} WIB · Ref ${escapeHtml(shortEvidenceReference(entry.reference))}</small></div><span><strong>${formatQuantity(entry.quantityBase, row.unit)} · ${rupiah(entry.valueRupiah)}</strong><small>${escapeHtml(entry.reason)}</small></span></li>`).join("");
  const depletionItems = depletions.map((entry) => `<li><div><strong>${escapeHtml(varianceEvidenceTypeLabel(entry.movementType))}</strong><small>${formatDate(entry.occurredAt)} · ${formatTime(entry.occurredAt)} WIB · Ref ${escapeHtml(shortEvidenceReference(entry.reference))}</small></div><span><strong>${formatQuantity(entry.quantityBase, row.unit)} · ${rupiah(entry.valueRupiah)}</strong><small>${escapeHtml(entry.reason)}</small></span></li>`).join("");
  const purchaseEmpty = row.purchaseEvidence?.truncated ? `<p>${row.purchaseEvidence.shownCount} dari ${purchaseCount} penerimaan masuk batas tampilan.</p>` : "<p>Belum ada penerimaan pada periode ini.</p>";
  const depletionEmpty = row.depletionEvidence?.truncated ? `<p>${row.depletionEvidence.shownCount} dari ${depletionCount} pengurangan masuk batas tampilan.</p>` : "<p>Belum ada pengurangan bernama pada periode ini.</p>";
  return `<details class="owner-variance-evidence-row" role="group" data-ingredient-id="${escapeHtml(row.ingredientId)}" aria-label="${escapeHtml(label)}"${openVarianceEvidenceIds.has(row.ingredientId) ? " open" : ""}><summary><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(sourcePreview)}</small></span><span><strong>${purchaseCount} penerimaan · ${depletionCount} pengurangan</strong><small>${truncated ? "Sebagian bukti ditampilkan" : "Bukti periode lengkap"}</small></span></summary><div class="owner-variance-evidence-body"><section><h4>Penerimaan pembelian</h4>${purchaseItems ? `<ul>${purchaseItems}</ul>` : purchaseEmpty}</section><section><h4>Bahan terbuang & pengurangan</h4>${depletionItems ? `<ul>${depletionItems}</ul>` : depletionEmpty}</section></div></details>`;
}

function varianceEvidenceTypeLabel(type) {
  return ({ SPOILAGE_WASTE: "Waste / basi", PRODUCTION_WASTE: "Waste produksi", DAMAGED: "Rusak", INTERNAL_USE: "Pemakaian internal", SAMPLES_PROMOTIONAL: "Sampel / promosi", LOSS_THEFT: "Hilang / theft" })[type] || type;
}

function shortEvidenceReference(value) {
  const reference = String(value ?? "");
  return reference.length > 10 ? `…${reference.slice(-8)}` : reference;
}

function ownerTheoreticalUsageView(data) {
  if (!data) return '<article class="dashboard-card span-12"><h2>Pemakaian bahan belum tersedia</h2><p>Muat ulang setelah koneksi pulih.</p></article>';
  const labels = { VERIFIED: "Cakupan lengkap", PARTIAL: "Cakupan sebagian", INCOMPLETE: "Resep belum lengkap", NO_SALES: "Belum ada penjualan" };
  const quantity = (value) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(value);
  const rows = data.rows.map((row) => `<tr><th scope="row"><strong>${escapeHtml(row.name)}</strong><small>${row.sourceProducts.map((item) => `${item.qty}× ${escapeHtml(item.name)}`).join(" · ")}</small></th><td><strong>${quantity(row.quantityBase)} ${escapeHtml(row.unit)}</strong></td><td>${rupiah(row.theoreticalCostRupiah)}</td></tr>`).join("");
  const modifierWarning = data.modifierRecipeStatus === "UNMAPPED_PRICED_MODIFIER"
    ? `<p class="owner-card-note"><strong>Modifier perlu mapping HPP:</strong> ${(data.modifierBlockedProducts ?? []).map(escapeHtml).join(", ")}. Tambahan berbayar tidak dimasukkan ke laba final sampai recipe delta dibuat.</p>`
    : "";
  return `<article id="owner-theoretical-usage" class="dashboard-card span-12 owner-usage" aria-labelledby="owner-usage-title">
    <div class="section-heading"><div><p class="eyebrow">Resep × menu terbayar · ${escapeHtml(data.businessDate)}</p><h2 id="owner-usage-title">Pemakaian bahan teoretis</h2></div><span class="owner-count ${data.status === "VERIFIED" || data.status === "NO_SALES" ? "" : "is-warning"}">${labels[data.status] || "Perlu diperiksa"}</span></div>
    <div class="owner-usage-summary"><div><span>Cakupan menu terjual</span><strong>${data.coveragePct == null ? "N/A" : `${data.coveragePct}%`}</strong><small>${data.verifiedItemQuantity} dari ${data.soldItemQuantity} item memiliki catatan resep lengkap</small></div><div><span>Biaya resep terverifikasi</span><strong>${rupiah(data.verifiedTheoreticalCostRupiah)}</strong><small>${data.theoreticalCostRupiah == null && data.soldItemQuantity ? "Hanya bagian terverifikasi, belum seluruh penjualan" : "Total seluruh penjualan dalam cakupan"}</small></div></div>
    ${rows ? `<div class="table-wrap owner-usage-table" role="region" aria-label="Rincian pemakaian bahan teoretis" tabindex="0"><table><caption class="sr-only">Bahan menurut resep saat transaksi terbayar</caption><thead><tr><th scope="col">Bahan & sumber menu</th><th scope="col">Terpakai teoretis</th><th scope="col">Biaya resep tercatat</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="operator-empty compact"><p>Data muncul setelah pesanan terbayar memiliki catatan resep lengkap.</p></div>'}
    <div class="owner-usage-boundary"><strong>Belum pemakaian aktual</strong><p>Angka ini memakai resep yang tercatat saat transaksi. Selisih aktual memerlukan stok pembuka dan penutup; tambahan atau pilihan berbayar yang belum dipetakan tidak dianggap berbiaya Rp0 atau dihitung sebagai laba final.</p></div>
    ${data.incompleteProducts?.length ? `<p class="owner-card-note"><strong>Resep perlu dilengkapi:</strong> ${data.incompleteProducts.map(escapeHtml).join(", ")}</p>` : ""}
    ${modifierWarning}
    <a class="button button-ghost" href="/api/operator/reports/theoretical-usage.csv?reportDate=${encodeURIComponent(data.businessDate)}" download>Unduh pemakaian bahan CSV</a>
  </article>`;
}

function financialMoney(value) { return Number.isSafeInteger(value) ? rupiah(value) : "Belum tersedia"; }
function ownerFinancialView(data) {
  if (!data) return '<section class="dashboard-card"><h2>Rincian keuangan belum tersedia</h2><p>Muat ulang setelah koneksi pulih.</p></section>';
  const labels = { MATCHED: "Sesuai catatan POS", NEEDS_REVIEW: "Perlu diperiksa", EMPTY: "Tidak ada order dalam cakupan" };
  const rowLabels = { MATCHED: "Sesuai", PAYMENT_MISMATCH: "Selisih pembayaran", ORDER_TOTAL_MISMATCH: "Komponen total berbeda", INVALID_AMOUNT: "Nilai belum valid" };
  const costLabels = { VERIFIED: "HPP teoretis lengkap", PARTIAL: "HPP teoretis baru sebagian", INCOMPLETE: "HPP teoretis belum lengkap", NO_SALES: "Belum ada penjualan" };
  const line = (label, value, note = "") => `<div><dt>${label}${note ? `<small>${note}</small>` : ""}</dt><dd>${financialMoney(value)}</dd></div>`;
  return `<section id="owner-financial-panel" class="dashboard-card owner-financial" aria-labelledby="financial-title">
    <div class="section-heading"><div><p class="eyebrow">Tanggal bisnis · ${escapeHtml(data.businessDate)} WIB</p><h2 id="financial-title">Dari penjualan ke pembayaran</h2></div><span class="owner-count ${data.issueCount ? "is-warning" : ""}">${labels[data.state] || "Perlu diperiksa"}</span></div>
    <div class="owner-financial-grid"><dl class="owner-money-lines">
      ${line("Subtotal menu", data.subtotalRupiah)}${line("Diskon", data.discountRupiah, "Dikurangkan dari subtotal")}${line("Penjualan menu", data.menuSalesRupiah, "Subtotal − diskon")}${line("Pajak", data.taxRupiah)}${line("Biaya layanan", data.serviceRupiah)}${line("Pembulatan", data.roundingRupiah)}${line("Total tagihan", data.totalRupiah)}${line("Pembayaran tercatat", data.collectedRupiah, "Nilai teralokasi, bukan uang diserahkan sebelum kembalian")}${line("Selisih pembayaran", data.differenceRupiah, "Pembayaran tercatat − total tagihan")}
    </dl><div class="owner-cost-boundary"><h3>${costLabels[data.cost.status] || "Status HPP perlu diperiksa"}</h3><p><strong>${data.cost.coveragePct == null ? "N/A" : `${data.cost.coveragePct}%`} order</strong> memiliki catatan biaya saat transaksi yang lengkap. ${data.cost.excludedOrderCount} order dikeluarkan dari perhitungan total agar biaya kosong tidak dianggap Rp0.</p><dl>${line("Penjualan terverifikasi", data.cost.verifiedSalesRupiah)}${line("HPP bagian terverifikasi", data.cost.verifiedTheoreticalHppRupiah)}${line("HPP teoretis total", data.cost.theoreticalHppRupiah)}${line("Laba kotor total", data.cost.grossProfitRupiah)}${line("HPP aktual", data.cost.actualHppRupiah)}${line("Laba bersih", data.cost.netProfitRupiah)}</dl><p>HPP total dan laba kotor hanya ditampilkan saat cakupan 100%. HPP aktual tetap membutuhkan stok awal, pembelian, stok akhir, bahan terbuang, dan penyesuaian; laba bersih juga memerlukan biaya penyedia pembayaran serta biaya operasional.</p>${data.cost.incompleteProducts?.length ? `<p><strong>Perlu dilengkapi:</strong> ${data.cost.incompleteProducts.map(escapeHtml).join(", ")}</p>` : ""}</div></div>
    <p class="owner-card-note">Cakupan: ${data.orderCount} penjualan asli pada tanggal transaksi. ${data.excludedRefundedOrderCount} refund lama tanpa rincian lengkap dan ${data.excludedPendingOrderCount} pesanan menunggu pembayaran dikecualikan. Refund tidak menghapus penjualan pada tanggal sebelumnya.</p>
    <dl class="owner-money-lines">${line('Tunai dikembalikan tanggal ini',data.refundActivity?.completedLocalRupiah??0)}${line('Penerimaan tercatat setelah refund tanggal ini',data.netCollectedAfterRefundRupiah,'Bukan settlement bank atau laba bersih')}${line('Penjualan menu setelah refund tanggal ini',data.netMenuSalesAfterRefundRupiah,'Pajak/layanan bukan pendapatan menu; bahan terpakai tidak otomatis kembali')}${line('Laba kotor teoretis setelah refund tanggal ini',data.cost.grossProfitAfterRefundRupiah,'Hanya jika HPP dan alokasi refund lengkap; bukan laba bersih')}${line('Refund manual belum terkonfirmasi',data.refundActivity?.pendingManualRupiah??0)}</dl>
    <p class="owner-card-note">${data.refundActivity?.eventCount??0} tindakan refund tanggal ini; ${data.refundActivity?.pendingManualCount??0} menunggu rekonsiliasi dan ${data.refundActivity?.invalidEventCount??0} belum memiliki nilai yang valid. Permintaan QRIS bukan bukti dana dikembalikan. HPP/laba kotor di atas memakai penjualan asli, sebelum penyesuaian refund.</p>
    <p class="owner-card-note">${data.issueCount ? `${data.issueCount} order perlu diperiksa; selisih antarorder tidak saling menghapus.` : "Kesesuaian di sini hanya antara pesanan dan pembayaran yang tercatat di POS."} Dana dari penyedia pembayaran atau bank tetap perlu dicocokkan secara terpisah.</p>
    <a class="button button-ghost" href="/api/operator/reports/financial.csv?reportDate=${encodeURIComponent(data.businessDate)}" download>Unduh rincian CSV</a>
    <details id="owner-financial-details" ${financialDetailsOpen ? "open" : ""}><summary>Rincian ${data.rows.length} order dalam cakupan</summary><ul class="owner-financial-orders">${data.rows.map((row) => `<li><div><strong>${escapeHtml(row.orderNumber || "Order")}</strong><span>${rowLabels[row.state] || "Perlu diperiksa"}</span></div><dl>${line("Tagihan", row.totalRupiah)}${line("Pembayaran", row.collectedRupiah)}${line("Selisih", row.differenceRupiah)}${line("Status HPP", row.hppState)}${line("HPP teoretis", row.theoreticalHppRupiah)}</dl></li>`).join("") || "<li>Belum ada order dalam cakupan tanggal ini.</li>"}</ul></details>
  </section>`;
}

function buildOwnerAttention({ uncheckedPayments, oldestMinutes, queueCounts, financialIssues = 0, recipeUsage, inventoryVariance, pendingCashAssists = 0 }) {
  const items = [];
  if (pendingCashAssists) items.push({ tone: "urgent", label: "Tunai kiosk", title: `${pendingCashAssists} pembayaran menunggu kasir`, note: "Uang belum dianggap diterima. Buka Kasir, cek uang fisik, lalu konfirmasi nominal aktual dan kembalian." });
  if (financialIssues) items.push({ tone: "urgent", label: "Rekonsiliasi", title: `${financialIssues} order perlu diperiksa`, note: "Buka rincian penjualan dan pembayaran; selisih total nol belum tentu semua order sesuai." });
  if (oldestMinutes >= 10) items.push({ tone: "urgent", label: "Antrean", title: `Tiket tertua ${oldestMinutes} menit`, note: "Prioritaskan di KDS; dashboard hanya memantau." });
  else if (oldestMinutes >= 5) items.push({ tone: "warning", label: "Antrean", title: `Tiket tertua ${oldestMinutes} menit`, note: "Pantau ritme bar sebelum melewati 10 menit." });
  if (uncheckedPayments) items.push({ tone: "warning", label: "Payment", title: `${uncheckedPayments} settlement belum dicek`, note: "Verifikasi terhadap provider sebelum closing." });
  if (recipeUsage?.soldItemQuantity > 0 && recipeUsage.status !== "VERIFIED") items.push({ tone: "warning", label: "Resep", title: `Cakupan resep ${recipeUsage.coveragePct ?? 0}%`, note: `${recipeUsage.excludedItemQuantity} item belum memiliki catatan resep lengkap; total HPP dan pemakaian bahan tetap parsial.` });
  if (recipeUsage?.modifierRecipeStatus === "UNMAPPED_PRICED_MODIFIER") items.push({ tone: "warning", label: "Modifier", title: "Tambahan berbayar belum punya HPP", note: "Extra shot/oat milk tidak boleh dihitung sebagai laba final sampai mapping konsumsi dibuat." });
  if (inventoryVariance?.status === "PARTIAL") items.push({ tone: "warning", label: "Stok", title: "Varians periode belum valid", note: "Periksa kelengkapan penghitungan stok, waktu pembayaran, dan catatan resep sebelum memakai HPP aktual." });
  if (queueCounts.READY >= 3) items.push({ tone: "warning", label: "Pickup", title: `${queueCounts.READY} order menunggu diambil`, note: "Pastikan nomor antrean sudah dipanggil." });
  return items;
}

function cashClosingLabel(data = {}) {
  if (data.pendingAssistCount) return `${data.pendingAssistCount} bantuan pending`;
  if (data.status === "OPEN_SHIFT_COUNT_REQUIRED") return "Hitung kas fisik";
  if (data.status === "CLOSED_VARIANCE_REVIEW") return "Review selisih";
  return "Perlu review";
}

function ownerAttentionItem(item) {
  const target = ({ "Tunai kiosk": "/cashier", Rekonsiliasi: "#finance/settlement", Antrean: "#orders", Payment: "#finance/settlement", Resep: "#inventory/hpp", Modifier: "#inventory/hpp", Stok: "#inventory/warehouse", Pickup: "/kds" })[item.label] ?? "#orders";
  return `<li class="tone-${item.tone}"><span>${escapeHtml(item.label)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.note)}</p><a href="${target}">Buka ${escapeHtml(item.label.toLowerCase())} →</a></div></li>`;
}

function ownerQueueStage(label, value, note) {
  return `<div><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(note)}</small></div>`;
}

function ownerPaymentRow(item) {
  const unchecked = Number(item.uncheckedCount || 0);
  return `<div><span><strong>${escapeHtml(item.methodName || "Payment")}</strong><small>${Number(item.count || 0)} transaksi</small></span><span><strong>${rupiah(item.amountRupiah)}</strong><small class="${unchecked ? "text-warning" : ""}">${unchecked ? `${unchecked} belum dicek` : "Terverifikasi"}</small></span></div>`;
}

function integrationLabel(key) {
  return ({ qris: "QRIS gateway", member: "Customer Platform", reward: "Reward", printer: "Printer", nfc: "NFC", persistence: "Database", staging: "Staging", production: "Production" })[key] || key.replaceAll("_", " ");
}

function ownerIntegrationState(key, rawValue) {
  const value = String(rawValue || "").toUpperCase();
  let state = { label: "Perlu verifikasi", note: "Status belum diklasifikasikan", tone: "warning" };
  if (snapshot.context?.production) {
    if (key === "qris") return snapshot.context.paymentMode === "OFF"
      ? { label: "Pembayaran nonaktif", note: "Tidak ada pembayaran provider aktif dari mode runtime ini", tone: "blocked" }
      : snapshot.context.paymentMode === "GATEWAY"
        ? { label: "Gateway dikonfigurasi", note: "Mode runtime bukan bukti canary, transaksi, atau settlement sudah lulus", tone: "warning" }
        : { label: "Mode belum terverifikasi", note: "Periksa konfigurasi pembayaran sebelum digunakan", tone: "warning" };
    if (key === "member") return snapshot.context.memberMode === "PROVIDER"
      ? { label: "Provider dikonfigurasi", note: "Koneksi dan UAT Member perlu verifikasi terpisah", tone: "warning" }
      : snapshot.context.memberMode === "OFF"
        ? { label: "Belum diaktifkan", note: "Integrasi Member tidak aktif pada mode runtime ini", tone: "blocked" }
        : { label: "Mode belum terverifikasi", note: "Periksa konfigurasi Member sebelum digunakan", tone: "warning" };
    if (key === "reward") return snapshot.context.memberMode === "OFF"
      ? { label: "Belum diaktifkan", note: "Reward Member tidak aktif pada mode runtime ini", tone: "blocked" }
      : { label: "Belum diverifikasi", note: "Reward memerlukan kontrak dan UAT tersendiri", tone: "warning" };
    if (key === "persistence") return snapshot.context.persistence === "NATIVE_POSTGRES_SINGLE_WRITER"
      ? { label: "Mode PostgreSQL", note: "Konfigurasi runtime; pemulihan dan UAT tetap perlu bukti", tone: "local" }
      : { label: "Mode belum terverifikasi", note: "Periksa sumber penyimpanan sebelum digunakan", tone: "warning" };
    if (key === "production") return { label: "Runtime production", note: "Aktifnya layanan tidak berarti seluruh fitur siap bisnis", tone: "local" };
    if (key === "staging") return { label: "Tidak digunakan", note: "Pilot ini langsung memakai domain production", tone: "local" };
  }
  if (value.includes("LOCAL_SIMULATOR")) state = { label: "Simulator lokal", note: "Belum payment production", tone: "warning" };
  else if (value.includes("EXTERNAL_CONTRACT_PENDING")) state = { label: "Kontrak pending", note: "Belum diuji eksternal", tone: "warning" };
  else if (value.includes("HARDWARE_UNAVAILABLE")) state = { label: "Belum tersedia", note: "Hardware belum diuji", tone: "blocked" };
  else if (value.includes("POSTGRES_EVIDENCE_EXISTS") || value.includes("POS_LAB_IN_MEMORY")) state = { label: "Lokal tervalidasi", note: "External runtime belum diuji", tone: "local" };
  else if (value.includes("NOT_AUTHORIZED") || value.includes("NOT_RUN")) state = { label: "Belum diotorisasi", note: "Tidak dijalankan", tone: "blocked" };
  else if (value.includes("READY") || value.includes("ACTIVE")) state = { label: "Siap", note: "Status server aktif", tone: "ready" };
  return state;
}

function ownerIntegrationRow(key, rawValue) {
  const state = ownerIntegrationState(key, rawValue);
  return `<div class="tone-${state.tone}"><span>${escapeHtml(integrationLabel(key))}</span><strong>${escapeHtml(state.label)}</strong><small>${escapeHtml(state.note)}</small></div>`;
}

function metric(label, value, note, tone = "default") { return `<article class="metric-card tone-${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`; }

function announce(message, danger = false) {
  globalStatus.textContent = message;
  globalStatus.dataset.danger = danger ? "true" : "false";
  globalStatus.hidden = false;
  window.setTimeout(() => { globalStatus.hidden = true; }, 2800);
}

function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function formatSignedRupiah(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${rupiah(number)}`; }
function formatTime(value) { return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date(value)); }
function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(date);
}
function formatDate(value) { return new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Jakarta" }).format(new Date(value)); }
function dueLabel(daysUntilDue) { const days = Number(daysUntilDue); if (!Number.isFinite(days)) return "Belum diposting"; if (days < 0) return `${Math.abs(days)} hari lewat tempo`; if (days === 0) return "Jatuh tempo hari ini"; return `${days} hari lagi`; }
function paymentMethodLabel(method) { return ({ BANK_TRANSFER: "Transfer bank", CASH: "Tunai", E_WALLET: "E-wallet", OTHER: "Lainnya" })[method] || String(method ?? "Metode tidak diketahui"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
