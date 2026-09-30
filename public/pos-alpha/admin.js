const loginView = document.querySelector("#operator-login");
const appView = document.querySelector("#admin-app");
const loginForm = document.querySelector("#login-form");
let content = document.querySelector("#admin-content");
const toast = document.querySelector("#global-status");
let state; let csrfToken = "";
let staticDemoAsset = null;
let manualQrisAsset = null;
let catalogQuery = "";
let categoryFilter = "all";
let availabilityFilter = "all";
let historyFilter = "all";
let pendingAvailability = null;
let catalogConflict = false;
let menuWorkspaceTab = "products";
let menuProductQuery = "";
let menuCategoryFilter = "all";
let menuStationFilter = "all";
let menuStatusFilter = "all";
let menuSelected = new Set();
let menuDialog = null;
let menuDragProductId = null;
let menuPage = 1;
const MENU_PAGE_SIZE = 7;
let menuAvailabilityRoute = window.location.pathname === "/admin/menu/availability";
let dedicatedMenuWorkspace = window.location.pathname === "/admin/menu" || menuAvailabilityRoute;
let embeddedDashboardWorkspace = false;
let embeddedNavigate = null;
let toastTimer;

if (loginForm && content && appView) {
  loginForm.addEventListener("submit", login);
  document.querySelector("#logout-button")?.addEventListener("click", logout);
  attachAdminListeners(content);
  try { await refresh(); showApp(); } catch { showLogin(); }
}

function attachAdminListeners(target) {
  target.addEventListener("click", action);
  target.addEventListener("input", updateCatalogView, { capture: true });
  target.addEventListener("change", updateCatalogView, { capture: true });
  for (const handler of [saveDiscountLimit, filterPromotionReport, saveProduct, saveMenuDialog, createProduct, createCategory, savePromotionDraft, savePricingPolicy,
    saveVariantGroup, saveVariantOption, saveModifierGroup, saveModifierOption, saveOrdering, saveEsbCatalogDraft,
    saveHppIngredient, saveHppSupplier, saveHppPurchaseOrder, amendHppPurchaseOrder, cancelHppPurchaseOrder,
    saveHppPurchaseOrderReceipt, saveHppPurchaseInvoice, postHppPurchaseInvoice, recordHppPurchaseInvoicePayment,
    postHppPurchaseInvoiceCredit, decideHppPurchaseInvoiceCreditReversal, saveHppSupplierReturn,
    receiveHppSupplierReplacement, saveHppPurchase, saveHppInventoryCount, saveHppInventoryPeriod,
    saveHppInventoryMovement, saveHppRecipe, removeHppRecipe, saveHppModifierRecipe, removeHppModifierRecipe,
    saveHppFulfillmentRecipe, removeHppFulfillmentRecipe, saveHppGate, saveStaticDemoQr, saveManualQrisAsset]) target.addEventListener("submit", handler);
  target.addEventListener("keydown", handleMenuKeydown);
  target.addEventListener("dragstart", handleMenuDragStart);
  target.addEventListener("dragover", handleMenuDragOver);
  target.addEventListener("drop", handleMenuDrop);
}

export async function mountDashboardMenuWorkspace({ host, area = "products", navigate } = {}) {
  if (!(host instanceof HTMLElement)) throw new Error("dashboard_menu_host_required");
  const allowedAreas = new Set(["products", "categories", "modifiers", "promotions", "publication", "kiosk", "availability"]);
  const nextArea = allowedAreas.has(area) ? area : "products";
  embeddedDashboardWorkspace = true;
  dedicatedMenuWorkspace = true;
  menuAvailabilityRoute = nextArea === "availability";
  menuWorkspaceTab = menuAvailabilityRoute ? "products" : nextArea;
  embeddedNavigate = typeof navigate === "function" ? navigate : null;
  content = host;
  if (document.documentElement.dataset.dashboardMenuWorkspaceBound !== "true") {
    attachAdminListeners(document);
    document.documentElement.dataset.dashboardMenuWorkspaceBound = "true";
  }
  host.dataset.menuWorkspaceBound = "true";
  host.setAttribute("aria-busy", "true");
  host.innerHTML = '<div class="operator-empty"><span aria-hidden="true">⌛</span><h2>Memuat Menu & promo</h2><p>Mengambil katalog dan draft terbaru dari server.</p></div>';
  try {
    await refresh();
  } catch (error) {
    host.innerHTML = `<div class="operator-empty" role="alert"><span aria-hidden="true">!</span><h2>Menu & promo belum dapat dimuat</h2><p>${escapeHtml(menuErrorMessage(error))}</p><button class="button button-secondary" type="button" data-menu-retry>Muat ulang</button></div>`;
  } finally {
    host.removeAttribute("aria-busy");
  }
}

export function setDashboardMenuArea(area = "products") {
  if (!embeddedDashboardWorkspace || !state || !content?.isConnected) return;
  const allowedAreas = new Set(["products", "categories", "modifiers", "promotions", "publication", "kiosk", "availability"]);
  const nextArea = allowedAreas.has(area) ? area : "products";
  menuAvailabilityRoute = nextArea === "availability";
  menuWorkspaceTab = menuAvailabilityRoute ? "products" : nextArea;
  render();
}

async function login(event) { event.preventDefault(); document.querySelector("#login-status").textContent = ""; try { const result = await request("/api/operator/login", { method: "POST", body: Object.fromEntries(new FormData(loginForm).entries()) }); if (dedicatedMenuWorkspace ? !["owner", "admin", "manager"].includes(result.actor.role) : result.actor.role !== "owner") throw new Error(dedicatedMenuWorkspace ? "Role Owner, Admin, atau Manager diperlukan." : "Owner role diperlukan."); await refresh(); showApp(); } catch (error) { document.querySelector("#login-status").textContent = error.message; } }
async function logout() { await request("/api/operator/logout", { method: "POST", csrf: true }); state = null; csrfToken = ""; showLogin(); }
async function refresh() {
  state = await request("/api/admin/state");
  csrfToken = state.csrfToken;
  staticDemoAsset = state.context?.scope === "PRIVATE_STAGING_SIMULATOR" && state.actor?.role === "owner"
    ? await request("/api/admin/static-qris-demo/asset").catch(() => null) : null;
  manualQrisAsset = state.context?.scope === "PRODUCTION_RUNTIME" && state.actor?.role === "owner"
    ? await request("/api/admin/manual-qris/asset").catch(() => null) : null;
  render();
}
function showApp() { loginView.hidden = true; appView.hidden = false; document.body.classList.toggle("menu-b7-route", dedicatedMenuWorkspace); document.body.classList.toggle("menu-b7-availability-route", menuAvailabilityRoute); document.querySelector("#actor-badge").textContent = `${state.actor.displayName} · ${String(state.actor.role).toUpperCase()}`; if (dedicatedMenuWorkspace) document.querySelector("#admin-app .operator-header h1").textContent = menuAvailabilityRoute ? "Availability menu" : "Menu & promo"; }
function showLogin() { appView.hidden = true; loginView.hidden = false; }

function render() {
  const products = state.catalog.flatMap((category) => category.products.map((product) => ({ ...product, categoryId: category.id, categoryName: category.name })));
  const soldOut = products.filter((product) => !product.available).length;
  const scheduledRestore = products.filter((product) => !product.available && product.availabilityRestoresAt).length;
  const history = state.availabilityHistory || [];
  const generatedAt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: state.context.timezone }).format(new Date(state.generatedAt));
  if (dedicatedMenuWorkspace) {
    content.innerHTML = renderMenuPromoShell(state, products);
    requestAnimationFrame(() => content.querySelector("[data-autofocus]")?.focus());
    return;
  }
  content.innerHTML = `
    ${renderMenuPromoShell(state, products)}
    <section class="admin-command"><div><p class="eyebrow">Kontrol menu hari ini</p><h2>${soldOut ? `${soldOut} menu sedang sold out` : "Semua menu siap dijual"}</h2><p>Perubahan dikonfirmasi satu per satu dan langsung menjadi sumber ketersediaan Kiosk/Cashier lokal.</p></div><div class="admin-freshness"><span>DATA SERVER · ${escapeHtml(state.context.timezone)}</span><strong>${generatedAt}</strong><small>Catalog versi ${state.catalogVersion}</small></div></section>
    ${catalogConflict ? `<section class="admin-conflict" role="alert"><span aria-hidden="true">!</span><div><strong>Status menu berubah di tab atau perangkat lain</strong><p>Data terbaru versi ${state.catalogVersion} sudah dimuat. Tinjau status menu sebelum mencoba lagi.</p></div><button class="button button-ghost" data-dismiss-conflict>Tutup</button></section>` : ""}
    <section class="admin-metrics">${metric("Menu tersedia", products.length - soldOut, `dari ${products.length} menu`, "tone-ready")}${metric("Sold out", soldOut, soldOut ? `${scheduledRestore} terjadwal pulih` : "Tidak ada hambatan", soldOut ? "tone-warning" : "tone-clear")}${metric("Device lokal", state.devices.length, "Belum commissioned", "tone-device")}${metric("QRIS belum dicek", state.reports.settlement.uncheckedCount ?? 0, "Verifikasi di laporan", (state.reports.settlement.uncheckedCount ?? 0) ? "tone-warning" : "tone-clear")}</section>
    <section class="admin-workspace">
      <article class="admin-catalog-card"><div class="section-heading"><div><p class="eyebrow">Availability desk</p><h2>Quick sold-out</h2></div><span class="admin-count" id="catalog-result-count" role="status" aria-live="polite" aria-atomic="true"></span></div>
        <div class="admin-catalog-tools"><label class="admin-search"><span>Cari menu</span><input id="admin-catalog-search" type="search" placeholder="Contoh: latte" autocomplete="off" value="${escapeHtml(catalogQuery)}"></label><fieldset><legend>Status menu</legend><div class="admin-filter-row"><button class="admin-filter" data-availability-filter="all" aria-pressed="${availabilityFilter === "all"}">Semua</button><button class="admin-filter" data-availability-filter="available" aria-pressed="${availabilityFilter === "available"}">Tersedia</button><button class="admin-filter" data-availability-filter="sold-out" aria-pressed="${availabilityFilter === "sold-out"}">Sold out</button></div></fieldset></div>
        <div class="admin-category-row" aria-label="Filter kategori">${[{ id: "all", name: "Semua kategori" }, ...state.catalog].map((category) => `<button class="admin-category" data-category-filter="${category.id}" aria-pressed="${categoryFilter === category.id}">${escapeHtml(category.name)}</button>`).join("")}</div>
        <div class="admin-product-list">${products.map(productCard).join("")}</div><div class="admin-empty" hidden><strong>Menu tidak ditemukan</strong><span>Coba kata kunci atau filter lain.</span></div>
      </article>
      <div class="admin-side-stack">
        ${pendingAvailability ? confirmationCard(products.find((product) => product.id === pendingAvailability.productId)) : `<article class="admin-guide-card"><p class="eyebrow">Cara aman</p><h2>Tiga langkah</h2><ol><li><span>1</span><div><strong>Pilih menu</strong><small>Cari atau filter kategori.</small></div></li><li><span>2</span><div><strong>Cek dampak</strong><small>Status berlaku pada katalog lokal.</small></div></li><li><span>3</span><div><strong>Konfirmasi alasan</strong><small>Versi katalog naik setelah server menerima.</small></div></li></ol></article>`}
        <article class="admin-ops-card"><p class="eyebrow">Kesehatan perangkat</p><h2>Endpoint operasional</h2><div class="device-list">${state.devices.map((device) => `<div><strong>${escapeHtml(device.label)}</strong><span>${escapeHtml(device.mode)} · ${escapeHtml(device.status)}</span><small>Printer ${escapeHtml(device.printer)} · NFC ${escapeHtml(device.nfc)}</small></div>`).join("")}</div></article>
      </div>
    </section>
    <section class="admin-ops-card"><p class="eyebrow">Pengaturan katalog</p><h2>Pengaturan menu</h2><p>Harga baru berlaku untuk pesanan berikutnya. Pesanan yang sudah dibuat tidak diubah.</p>
      <form id="product-editor"><label>Menu<select name="productId" aria-label="Menu" required>${products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} · ${rupiah(product.priceRupiah)}</option>`).join("")}</select></label>
      <label>Nama baru<input name="name" maxlength="80" required value="${escapeHtml(products[0]?.name)}"></label>
      <label>Harga baru (Rp)<input name="priceRupiah" type="number" min="100" max="10000000" step="1" required value="${products[0]?.priceRupiah ?? 100}"></label>
      <label>Kategori menu<select name="categoryId">${state.catalog.map((category) => `<option value="${escapeHtml(category.id)}" ${category.id === products[0]?.categoryId ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label>
      <label>Tujuan produksi<select name="station"><option value="bar" ${products[0]?.station === "bar" ? "selected" : ""}>BAR · minuman</option><option value="food" ${products[0]?.station === "food" ? "selected" : ""}>FOOD · makanan</option></select></label>
      <label>Status penjualan<select name="status"><option value="active" ${products[0]?.status === "active" ? "selected" : ""}>Aktif</option><option value="archived" ${products[0]?.status === "archived" ? "selected" : ""}>Arsip · sembunyikan dari pelanggan</option></select></label>
      <label>Urutan tampil<input name="sortRank" type="number" min="0" max="999" step="1" required value="${products[0]?.sortRank ?? 0}"><small>Angka kecil tampil lebih dahulu. Angka sama mengikuti urutan bawaan.</small></label>
      <p>Arsip tidak menghapus transaksi. Perubahan tujuan produksi hanya berlaku pada pesanan baru.</p>
      <label>Alasan perubahan<input name="reason" maxlength="160" required></label>
      <p id="product-editor-status" role="status"></p><button class="button button-primary" type="submit">Simpan pengaturan menu</button></form>
      <h3>Perubahan katalog terbaru</h3>${(state.productHistory || []).length ? `<ul>${state.productHistory.map(productHistoryRow).join("")}</ul>` : "<p>Belum ada perubahan nama atau harga.</p>"}
    </section>
    ${renderPricingWorkspace(state.pricingConfiguration)}
    ${renderVariantWorkspace(state.variantConfiguration, products)}
    ${renderModifierWorkspace(state.modifierConfiguration, products)}
    ${renderEsbCatalogWorkspace(state.esbCatalog, products)}
    ${renderHppWorkspace(state.hpp)}
    <section class="admin-ops-card"><p class="eyebrow">Kontrol layanan · WIB</p><h2>Pesanan baru ${state.orderingSettings?.paused ? "sedang dijeda" : "tidak dijeda"}</h2><p>Jeda dan jam layanan membatasi checkout baru. Pesanan yang sudah dibuat tetap bisa dibayar dan dikerjakan bar.</p>
      <form id="ordering-editor"><label>Penerimaan pesanan<select name="paused"><option value="false" ${!state.orderingSettings?.paused ? "selected" : ""}>Terima pesanan baru</option><option value="true" ${state.orderingSettings?.paused ? "selected" : ""}>Jeda pesanan baru</option></select></label>
      <label>Aturan jam<select name="enforceHours"><option value="false" ${!state.orderingSettings?.enforceHours ? "selected" : ""}>Belum diterapkan</option><option value="true" ${state.orderingSettings?.enforceHours ? "selected" : ""}>Terapkan jam WIB</option></select></label>
      ${[["opensAt", "Jam buka"], ["lastOrderAt", "Pesanan terakhir"], ["closesAt", "Jam tutup"]].map(([name, label]) => `<label>${label}<input name="${name}" type="time" required value="${escapeHtml(state.orderingSettings?.[name])}"></label>`).join("")}
      <label>Alasan pengaturan layanan<input name="reason" maxlength="160" required></label><p role="status" id="ordering-editor-status"></p><button class="button button-primary">Simpan pengaturan layanan</button></form>
      <h3>Riwayat layanan</h3>${state.orderingHistory?.length ? `<ul>${state.orderingHistory.map((entry) => `<li>${entry.next.paused ? "Jeda" : "Terima pesanan"} · ${escapeHtml(entry.next.opensAt)}–${escapeHtml(entry.next.lastOrderAt)} WIB · ${escapeHtml(entry.reason)} · v${entry.version}</li>`).join("")}</ul>` : "<p>Belum ada perubahan layanan.</p>"}</section>
    ${availabilityHistory(history)}
    <section class="admin-lower-grid"><article class="admin-ops-card"><p class="eyebrow">Rekonsiliasi</p><h2>Ringkasan finansial lokal</h2><div class="boundary-status"><div><span>Coverage HPP</span><strong>${state.reports.daily.financialSummary?.cost?.coveragePct ?? 0}%</strong><small>${state.reports.daily.financialSummary?.cost?.excludedOrderCount ?? 0} order belum dihitung ke total HPP</small></div><div><span>Laba kotor</span><strong>${Number.isSafeInteger(state.reports.daily.grossProfitRupiah) ? rupiah(state.reports.daily.grossProfitRupiah) : "Belum terverifikasi"}</strong><small>Hanya tersedia saat coverage HPP 100%</small></div><div><span>Penjualan menu</span><strong>${Number.isSafeInteger(state.reports.daily.netSalesRupiah) ? rupiah(state.reports.daily.netSalesRupiah) : "Belum tersedia"}</strong><small>Setelah diskon, tanpa pajak/layanan</small></div><div><span>Settlement belum dicek</span><strong>${state.reports.settlement.uncheckedCount ?? 0}</strong></div></div><a href="/dashboard" class="button button-ghost">Buka rincian keuangan owner</a></article><article class="admin-ops-card"><p class="eyebrow">Batas pilot</p><h2>Integrasi eksternal</h2><div class="integration-list admin-integrations">${Object.entries(state.integrations).map(([key, value]) => integrationRow(key, value)).join("")}</div></article></section>`;
  applyCatalogFilters();
  if (pendingAvailability) requestAnimationFrame(() => content.querySelector("[data-confirm-availability]")?.focus());
}

async function action(event) {
  const discountApproval=event.target.closest('[data-discount-approve]');
  if(discountApproval){discountApproval.disabled=true;try{await request('/api/cashier/discount-approvals/approve',{method:'POST',csrf:true,body:{requestId:discountApproval.dataset.discountApprove}});await refresh();announce('Diskon disetujui untuk pesanan ini selama 15 menit.');}catch(error){discountApproval.disabled=false;announce(error.message,true);}return;}
  if(event.target.closest('[data-promo-close]')) {document.querySelector('#owner-promo-dialog')?.close();return;}
  const promoOpen=event.target.closest('[data-promo-open],[data-promo-edit]');
  if(promoOpen) {
    const dialog=document.querySelector('#owner-promo-dialog'),form=dialog.querySelector('form');
    if(!form.elements.batchCount)form.insertAdjacentHTML('afterbegin','<label>Jumlah voucher dalam batch<input name="batchCount" type="number" min="1" max="100" step="1" value="1"><small>Lebih dari satu: kolom kode menjadi awalan kode unik, maksimal 20 karakter.</small></label><label>Maksimum pemakaian per Member dalam program ini<input name="perMemberLimit" type="number" min="1" max="1000000000" step="1" placeholder="Kosong: tidak dibatasi"><small>Jika diisi, kode Member harus terverifikasi. Diskon tier tidak digabung dengan voucher.</small></label>');
    form.reset();
    const rule=state.promotionConfiguration.rules.find(rule=>rule.id===promoOpen.dataset.promoEdit);
    form.elements.promotionId.value=rule?.id??'';
    form.elements.perMemberLimit.value=rule?.perMemberLimit??'';
    if(rule) {
      for(const key of ['name','code','type','priority','stackPolicy','minimumSpendRupiah','capRupiah','buyQuantity','getQuantity','rewardProductId','quotaLimit']) if(form.elements[key])form.elements[key].value=rule[key]??'';
      form.elements.activationMode.value=rule.activationMode??'CODE';form.elements.value.value=rule.type==='PERCENT'?rule.value/100:rule.value;
      form.elements.startsAt.value=dateTimeLocalValue(new Date(rule.startsAt),'Asia/Jakarta');form.elements.endsAt.value=rule.endsAt?dateTimeLocalValue(new Date(rule.endsAt),'Asia/Jakarta'):'';
      for(const input of form.querySelectorAll('[name=weekdays]'))input.checked=(rule.schedule?.weekdays??[1,2,3,4,5,6,7]).includes(Number(input.value));
      for(const input of form.querySelectorAll('[name=eligibleProductIds]'))input.checked=rule.eligibleProductIds.includes(input.value);
      form.elements.allDay.checked=rule.schedule?.allDay!==false;form.elements.startLocal.value=rule.schedule?.startLocal?.slice(0,5)??'00:00';form.elements.endLocal.value=rule.schedule?.endLocal?.slice(0,5)??'23:59';
    }
    form.querySelector('[role=status]').textContent='';updatePromotionFields(form);dialog.showModal();return;
  }
  const preview=event.target.closest('[data-promo-preview]');
  if(preview) {
    const form=preview.closest('form');preview.disabled=true;
    try {const result=await request('/api/admin/promotion-preview',{method:'POST',csrf:true,body:{promotion:promotionFormPayload(form),cart:[{productId:form.elements.previewProductId.value,qty:Number(form.elements.previewQty.value)}]}});form.querySelector('[role=status]').textContent=`Preview server: subtotal ${rupiah(result.subtotalRupiah)} · diskon ${rupiah(result.discountRupiah)} · total ${rupiah(result.totalRupiah)}. Belum disimpan atau dipakai.`;}
    catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{preview.disabled=false;}return;
  }
  const dashboardMenuLink = event.target.closest?.('a[href^="#catalog/"]');
  if (embeddedDashboardWorkspace && dashboardMenuLink) {
    event.preventDefault();
    const area = dashboardMenuLink.getAttribute("href").replace("#catalog/", "");
    const sameArea = location.hash === `#catalog/${area}`;
    embeddedNavigate?.(area);
    if (sameArea) setDashboardMenuArea(area);
    return;
  }
  const menuRetry = event.target.closest("[data-menu-retry]");
  if (menuRetry) { await refresh(); return; }
  const menuClose = event.target.closest("[data-menu-close]");
  if (menuClose) { menuDialog = null; render(); return; }
  const menuLogout = event.target.closest("[data-menu-logout]");
  if (menuLogout) { await logout(); return; }
  const menuPageButton = event.target.closest("[data-menu-page]");
  if (menuPageButton) { menuPage = Number(menuPageButton.dataset.menuPage); render(); requestAnimationFrame(() => content.querySelector(".menu-b7-table-wrap")?.focus()); return; }
  if (event.target.matches("[data-menu-dialog-backdrop]")) { menuDialog = null; render(); return; }
  const menuAdd = event.target.closest("[data-menu-add]");
  if (menuAdd) { menuDialog = { type: "product" }; render(); return; }
  const menuEdit = event.target.closest("[data-menu-edit]");
  if (menuEdit) { menuDialog = { type: "product", productId: menuEdit.dataset.menuEdit }; render(); return; }
  const menuArchive = event.target.closest("[data-menu-archive]");
  if (menuArchive) { menuDialog = { type: "archive", productId: menuArchive.dataset.menuArchive }; render(); return; }
  const menuRestore = event.target.closest("[data-menu-restore]");
  if (menuRestore) { menuDialog = { type: "restore", productId: menuRestore.dataset.menuRestore }; render(); return; }
  const openPublish = event.target.closest("[data-menu-open-publish]");
  if (openPublish) { menuDialog = { type: "publish" }; render(); return; }
  const availabilityDraft = event.target.closest("[data-menu-availability]");
  if (availabilityDraft) { await stageMenuAvailability(availabilityDraft); return; }
  const clearSelection = event.target.closest("[data-menu-clear-selection]");
  if (clearSelection) { menuSelected.clear(); render(); return; }
  const bulkAction = event.target.closest("[data-menu-bulk]");
  if (bulkAction) { await commitMenuBulk(bulkAction.dataset.menuBulk); return; }
  const resetFilter = event.target.closest("[data-menu-reset-filter]");
  if (resetFilter) { menuProductQuery = ""; menuCategoryFilter = "all"; menuStationFilter = "all"; menuStatusFilter = "all"; render(); return; }
  const rollback = event.target.closest("[data-menu-rollback]");
  if (rollback) { await rollbackMenuPublication(rollback.dataset.menuRollback); return; }
  const categoryEdit = event.target.closest("[data-menu-category-edit]");
  if (categoryEdit) { menuDialog = { type: "category", categoryId: categoryEdit.dataset.menuCategoryEdit }; render(); return; }
  const menuTab = event.target.closest("[data-menu-tab]");
  if (menuTab) {
    menuWorkspaceTab = menuTab.dataset.menuTab;
    if (embeddedDashboardWorkspace && embeddedNavigate) {
      const sameArea = location.hash === `#catalog/${menuWorkspaceTab}`;
      embeddedNavigate(menuWorkspaceTab);
      if (sameArea) render();
      return;
    }
    render(); requestAnimationFrame(() => content.querySelector("[role='tabpanel']")?.focus()); return;
  }
  const promotionStatus = event.target.closest("[data-promotion-status]");
  if (promotionStatus) { await changePromotionStatus(promotionStatus); return; }
  const publishCatalogButton = event.target.closest("[data-esb-catalog-publish]");
  if (publishCatalogButton) { await publishEsbCatalog(publishCatalogButton); return; }
  const addPurchaseOrderLine = event.target.closest("[data-po-line-add]");
  if (addPurchaseOrderLine) {
    const form = addPurchaseOrderLine.closest(".hpp-po-lines-form");
    const lines = form?.querySelector(".hpp-po-lines");
    const template = form?.querySelector("template[data-po-line-template]");
    if (!form || !lines || !template || lines.children.length >= 100) return;
    lines.append(template.content.cloneNode(true));
    updatePurchaseOrderDraft(form);
    lines.lastElementChild?.querySelector("select")?.focus();
    return;
  }
  const removePurchaseOrderLine = event.target.closest("[data-po-line-remove]");
  if (removePurchaseOrderLine) {
    const form = removePurchaseOrderLine.closest(".hpp-po-lines-form");
    const row = removePurchaseOrderLine.closest(".hpp-po-line");
    if (!form || !row || form.querySelectorAll(".hpp-po-line").length <= 1) return;
    const fallbackFocus = row.previousElementSibling?.querySelector("[data-po-line-remove]") || form.querySelector("[data-po-line-add]");
    row.remove();
    updatePurchaseOrderDraft(form);
    fallbackFocus?.focus();
    return;
  }
  const archivedButton = event.target.closest("[data-edit-archived]");
  if (archivedButton) {
    const select = content.querySelector("#product-editor select[name='productId']");
    select.value = archivedButton.dataset.editArchived;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    content.querySelector("#product-editor select[name='status']").focus();
    return;
  }
  const dismissConflict = event.target.closest("[data-dismiss-conflict]");
  if (dismissConflict) { catalogConflict = false; render(); return; }
  const historyButton = event.target.closest("[data-history-filter]");
  if (historyButton) { historyFilter = historyButton.dataset.historyFilter; render(); return; }
  const categoryButton = event.target.closest("[data-category-filter]");
  if (categoryButton) { categoryFilter = categoryButton.dataset.categoryFilter; render(); return; }
  const statusButton = event.target.closest("[data-availability-filter]");
  if (statusButton) { availabilityFilter = statusButton.dataset.availabilityFilter; render(); return; }
  const cancelButton = event.target.closest("[data-cancel-availability]");
  if (cancelButton) { const returnFocus = pendingAvailability?.productId; pendingAvailability = null; render(); requestAnimationFrame(() => content.querySelector(`[data-product="${returnFocus}"]`)?.focus()); return; }
  const confirmButton = event.target.closest("[data-confirm-availability]");
  if (confirmButton) { await commitAvailability(confirmButton); return; }
  const productButton = event.target.closest("[data-product]");
  if (!productButton) return;
  catalogConflict = false;
  pendingAvailability = { productId: productButton.dataset.product, available: productButton.dataset.available === "true" };
  render();
}

function renderMenuPromoShell(currentState, products) {
  if (!currentState.featureFlags?.menuUiV2) return "";
  if (menuAvailabilityRoute) return renderMenuAvailabilityShell(currentState, products);
  const owner = ["owner", "admin"].includes(currentState.actor?.role);
  const tabs = owner ? [
    ["products", "Produk"], ["categories", "Kategori"], ["modifiers", "Modifier & Add-on"],
    ["promotions", "Promo"], ["publication", "Publikasi"], ["kiosk", "Pengaturan Kiosk"],
  ] : [["products", "Produk"]];
  if (!tabs.some(([id]) => id === menuWorkspaceTab)) menuWorkspaceTab = "products";
  const panels = {
    products: renderMenuProductsPanel(currentState, products),
    categories: renderMenuCategoriesPanel(currentState),
    modifiers: `<div class="menu-b7-section-head"><div><p class="eyebrow">Pilihan penjualan</p><h3>Modifier & Add-on</h3><p>Harga dan batas pilihan dihitung server serta ikut publication.</p></div></div>${renderVariantWorkspace(currentState.variantConfiguration, products)}${renderModifierWorkspace(currentState.modifierConfiguration, products)}`,
    promotions: renderPromotionWorkspace(currentState.promotionConfiguration, products, currentState.featureFlags.promoEngineV1, currentState.generatedAt, currentState.context.timezone),
    publication: renderMenuPublicationPanel(currentState),
    kiosk: `${renderManualQrisAssetPanel()}${renderMenuKioskPanel(currentState)}`,
  };
  const workspace = currentState.menuWorkspace ?? { draftCount: 0, publishedRevision: 0 };
  const localDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: currentState.context.timezone }).format(new Date());
  const localDay = new Intl.DateTimeFormat("id-ID", { weekday: "long", hour: "2-digit", minute: "2-digit", timeZone: currentState.context.timezone }).format(new Date());
  const menuAction = owner && menuWorkspaceTab === "products"
    ? `<button class="button button-primary" type="button" data-menu-add ${currentState.featureFlags.catalogWorkspaceV2 ? "" : "disabled"}>＋ Tambah produk</button>`
    : "";
  const menuDescription = {
    products: owner ? "Cari produk, ubah detail sebagai draft, atau atur ketersediaan langsung." : "Cari produk, ubah detail sebagai draft, atau atur ketersediaan langsung. Owner memublikasikan draft.",
    categories: "Susun kategori; perubahan tampil di Kasir dan Kiosk setelah publikasi.",
    modifiers: "Atur pilihan dan harga tambahan sebagai draft katalog.",
    promotions: "Tinjau promo dan simpan perubahan sebelum dipublikasikan.",
    publication: `${workspace.draftCount} perubahan draft menunggu tinjauan; Kasir dan Kiosk tetap memakai revisi aktif.`,
    kiosk: "Pratinjau kanal dan atur jam layanan serta aset Kiosk.",
  }[menuWorkspaceTab];
  if (embeddedDashboardWorkspace) return `<section class="menu-v2-shell menu-b7-workspace dashboard-menu-native" aria-labelledby="menu-v2-title">
    <div class="menu-b7-page-head"><div><p class="eyebrow">Workspace katalog</p><h2 id="menu-v2-title">Menu & promo</h2><p>${menuDescription}</p></div><div><a class="button button-secondary" href="#catalog/availability">Mode availability</a>${menuWorkspaceTab === "kiosk" ? `<a class="button button-secondary" href="/kiosk" target="_blank" rel="noopener">Lihat Kiosk</a>` : ""}${menuAction}</div></div>
    <div class="menu-b7-context dashboard-menu-context"><span>Outlet</span><strong>${escapeHtml(currentState.context.outletName ?? "Kopi Saga Salak")}</strong><span>${escapeHtml(localDate)} · ${escapeHtml(localDay)}</span></div>
    <div class="menu-v2-tabs" role="tablist" aria-label="Menu dan promo">${tabs.map(([id, label]) => `<button type="button" role="tab" data-menu-tab="${id}" aria-selected="${menuWorkspaceTab === id}" tabindex="${menuWorkspaceTab === id ? 0 : -1}">${escapeHtml(label)}${id === "publication" && workspace.draftCount ? `<span class="menu-b7-tab-count">${workspace.draftCount}</span>` : ""}</button>`).join("")}</div>
    <div class="menu-v2-panel" role="tabpanel" tabindex="-1" aria-label="${escapeHtml(tabs.find(([id]) => id === menuWorkspaceTab)?.[1])}">${panels[menuWorkspaceTab] ?? panels.products}</div>
    ${renderMenuDialog(currentState, products)}
  </section>`;
  return `<section class="menu-v2-shell menu-b7-workspace" aria-labelledby="menu-v2-title"><div class="menu-b7-app-shell">
    ${renderMenuNavigation(currentState)}
    <div class="menu-b7-main"><header class="menu-b7-topbar"><div class="menu-b7-breadcrumb"><span>Kelola</span><i>/</i><strong>Menu & promo</strong></div><div class="menu-b7-context"><div class="menu-b7-outlet"><span aria-hidden="true">▣</span><strong>${escapeHtml(currentState.context.outletName ?? "Kopi Saga Salak")}</strong><span aria-hidden="true">⌄</span></div><div class="menu-b7-date"><span aria-hidden="true">□</span><div><strong>${escapeHtml(localDate)}</strong><small>${escapeHtml(localDay)}</small></div></div></div></header>
    <main class="menu-b7-content"><div class="menu-b7-page-head"><div><h2 id="menu-v2-title">Menu & promo</h2><p>${menuDescription}</p></div><div><a class="button button-secondary" href="/admin/menu/availability">Mode availability</a>${menuWorkspaceTab === "kiosk" ? `<a class="button button-secondary" href="/kiosk" target="_blank" rel="noopener">Lihat Kiosk</a>` : ""}${menuAction}</div></div>
    <div class="menu-v2-tabs" role="tablist" aria-label="Menu dan promo">${tabs.map(([id, label]) => `<button type="button" role="tab" data-menu-tab="${id}" aria-selected="${menuWorkspaceTab === id}" tabindex="${menuWorkspaceTab === id ? 0 : -1}">${escapeHtml(label)}${id === "publication" && workspace.draftCount ? `<span class="menu-b7-tab-count">${workspace.draftCount}</span>` : ""}</button>`).join("")}</div>
    <div class="menu-v2-panel" role="tabpanel" tabindex="-1" aria-label="${escapeHtml(tabs.find(([id]) => id === menuWorkspaceTab)?.[1])}">${panels[menuWorkspaceTab] ?? panels.products}</div></main></div>
    ${renderMenuDialog(currentState, products)}
  </div></section>`;
}

function renderMenuNavigation(currentState) {
  const navItems = [["⌂", "Beranda", "/dashboard"], ["▥", "Penjualan", "/dashboard#sales"], ["▤", "Pesanan", "/dashboard#orders"], ["☕", "Menu & promo", "/dashboard#catalog/products", true], ["◇", "Stok & HPP", "/dashboard#inventory"], ["⌁", "Pembelian", "/dashboard#purchasing"], ["▣", "Keuangan", "/dashboard#finance"], ["♧", "Tim & shift", "/dashboard#workforce"], ["♙", "Member", "/dashboard#member"], ["⚙", "Pengaturan", "/dashboard#settings"]];
  return `<aside class="menu-b7-sidebar" aria-label="Navigasi utama"><div class="menu-b7-brand"><span>KS</span><div><strong>Saga POS</strong><small>${escapeHtml(currentState.context.outletName ?? "Kopi Saga Salak")}</small></div></div><nav>${navItems.map(([icon, label, href, active]) => `<a href="${href}" ${active ? 'aria-current="page" class="is-active"' : ""} title="${escapeHtml(label)}"><span aria-hidden="true">${icon}</span><b>${escapeHtml(label)}</b></a>`).join("")}</nav><a class="menu-b7-open-cashier" href="/cashier"><span aria-hidden="true">▣</span><b>Buka Kasir</b></a><div class="menu-b7-user"><span>${escapeHtml((currentState.actor.displayName || "A").slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(currentState.actor.displayName)}</strong><small>${escapeHtml(currentState.context.outletName ?? "Kopi Saga Salak")}</small></div><button type="button" data-menu-logout aria-label="Keluar dari Saga POS" title="Keluar">›</button></div></aside>`;
}

function renderMenuProductsPanel(currentState, products) {
  const owner = ["owner", "admin"].includes(currentState.actor?.role);
  const normalizedQuery = menuProductQuery.trim().toLocaleLowerCase("id-ID");
  const filtered = products.filter((product) => {
    const queryMatch = !normalizedQuery || `${product.name} ${product.categoryName}`.toLocaleLowerCase("id-ID").includes(normalizedQuery);
    const categoryMatch = menuCategoryFilter === "all" || product.categoryId === menuCategoryFilter;
    const stationMatch = menuStationFilter === "all" || product.station === menuStationFilter;
    const statusMatch = menuStatusFilter === "all" || (menuStatusFilter === "available" ? product.available : menuStatusFilter === "sold-out" ? !product.available : product.status === menuStatusFilter);
    return queryMatch && categoryMatch && stationMatch && statusMatch;
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / MENU_PAGE_SIZE));
  menuPage = Math.min(Math.max(1, menuPage), pageCount);
  const pageStart = (menuPage - 1) * MENU_PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + MENU_PAGE_SIZE);
  const workspace = currentState.menuWorkspace ?? { draftCount: 0 };
  const selectedVisible = paged.filter((product) => menuSelected.has(product.id));
  const rows = paged.map((product) => `<tr data-menu-row="${escapeHtml(product.id)}" data-menu-category-id="${escapeHtml(product.categoryId)}"><td>${owner ? `<input type="checkbox" data-menu-select="${escapeHtml(product.id)}" aria-label="Pilih ${escapeHtml(product.name)}" ${menuSelected.has(product.id) ? "checked" : ""}>` : ""}</td><td><div class="menu-b7-product">${owner ? `<button type="button" draggable="true" class="menu-b7-drag" data-menu-drag-handle="${escapeHtml(product.id)}" aria-label="Ubah urutan ${escapeHtml(product.name)}" title="Seret atau gunakan panah atas/bawah">⋮⋮</button>` : ""}<span class="menu-b7-thumb">${menuProductImage(product)}</span><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.id)}</small></div></div></td><td>${escapeHtml(product.categoryName)}</td><td><strong>${rupiah(product.priceRupiah)}</strong></td><td>${escapeHtml(product.station === "bar" ? "Bar" : "Food")}</td><td><button type="button" class="menu-b7-toggle ${product.available ? "is-on" : ""}" role="switch" aria-checked="${product.available}" data-menu-availability="${escapeHtml(product.id)}" data-available="${!product.available}" aria-label="${product.available ? "Tandai habis" : "Tandai tersedia"} ${escapeHtml(product.name)}"><span></span></button><span data-menu-availability-label>${product.available ? "Tersedia" : "Habis"}${product.availabilityDraft ? " · draft" : ""}</span><small class="menu-b7-inline-error" role="alert"></small></td><td><span class="menu-b7-badge is-${escapeHtml(product.status)}">${product.status === "active" ? "Terbit" : product.status === "draft" ? "Draft" : "Arsip"}</span></td><td><div class="menu-b7-row-actions"><button type="button" data-menu-edit="${escapeHtml(product.id)}" aria-label="Edit ${escapeHtml(product.name)}">Edit</button>${owner ? (product.status === "archived" ? `<button type="button" data-menu-restore="${escapeHtml(product.id)}" aria-label="Pulihkan ${escapeHtml(product.name)}">Pulihkan</button>` : `<button type="button" data-menu-archive="${escapeHtml(product.id)}" aria-label="Arsipkan ${escapeHtml(product.name)}">Arsip</button>`) : ""}</div></td></tr>`).join("");
  return `<div class="menu-b7-stats"><div><strong>${products.length}</strong><span>produk</span></div><i></i><div><strong>${products.filter((item) => item.available).length}</strong><span>tersedia</span></div><i></i><div><strong>${products.filter((item) => !item.available).length}</strong><span>habis</span></div><i></i><div><strong>${workspace.draftCount}</strong><span>draft</span></div>${owner ? `<button type="button" data-menu-open-publish ${workspace.draftCount ? "" : "disabled"}>Tinjau & publikasi →</button>` : `<span class="menu-b7-owner-note">Owner yang mempublikasikan</span>`}</div>
    <div class="menu-b7-toolbar"><label><span class="sr-only">Cari nama menu</span><input id="menu-b7-search" type="search" placeholder="Cari nama menu..." value="${escapeHtml(menuProductQuery)}"></label><label><span class="sr-only">Kategori</span><select id="menu-b7-category"><option value="all">Semua kategori</option>${currentState.catalog.map((category) => `<option value="${escapeHtml(category.id)}" ${menuCategoryFilter === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label><label><span class="sr-only">Stasiun</span><select id="menu-b7-station"><option value="all">Semua stasiun</option><option value="bar" ${menuStationFilter === "bar" ? "selected" : ""}>Bar</option><option value="food" ${menuStationFilter === "food" ? "selected" : ""}>Food</option></select></label><label><span class="sr-only">Status</span><select id="menu-b7-status"><option value="all">Semua status</option><option value="available" ${menuStatusFilter === "available" ? "selected" : ""}>Tersedia</option><option value="sold-out" ${menuStatusFilter === "sold-out" ? "selected" : ""}>Habis</option><option value="draft" ${menuStatusFilter === "draft" ? "selected" : ""}>Draft</option><option value="active" ${menuStatusFilter === "active" ? "selected" : ""}>Terbit</option><option value="archived" ${menuStatusFilter === "archived" ? "selected" : ""}>Arsip</option></select></label></div>
    ${owner && menuSelected.size ? `<div class="menu-b7-bulk" role="region" aria-label="Aksi massal"><div><strong>${menuSelected.size} dipilih</strong><button type="button" data-menu-clear-selection>Batalkan</button></div><div><button type="button" data-menu-bulk="move-up">Naikkan urutan</button><button type="button" data-menu-bulk="move-down">Turunkan urutan</button><button type="button" data-menu-bulk="available">Tandai tersedia</button><button type="button" data-menu-bulk="sold-out">Tandai habis</button><button type="button" data-menu-bulk="archive" class="danger">Arsipkan</button></div></div>` : ""}
    <div class="menu-b7-table-wrap" tabindex="-1"><table class="menu-b7-table"><thead><tr><th>${owner ? `<input type="checkbox" data-menu-select-all aria-label="Pilih semua produk di halaman ini" ${paged.length && selectedVisible.length === paged.length ? "checked" : ""}>` : ""}</th><th>Produk</th><th>Kategori</th><th>Harga</th><th>Stasiun</th><th>Ketersediaan</th><th>Publikasi</th><th>Aksi</th></tr></thead><tbody>${rows || `<tr><td colspan="8"><div class="menu-b7-empty"><strong>Tidak ada produk ditemukan</strong><span>Coba ubah kata kunci atau filter.</span><button type="button" data-menu-reset-filter>Reset filter</button></div></td></tr>`}</tbody></table></div>
    <div class="menu-b7-pagination"><span>Menampilkan ${filtered.length ? `${pageStart + 1}–${Math.min(pageStart + MENU_PAGE_SIZE, filtered.length)}` : "0"} dari ${filtered.length} hasil · ${products.length} produk</span><div><button type="button" data-menu-page="${menuPage - 1}" ${menuPage === 1 ? "disabled" : ""} aria-label="Halaman sebelumnya">‹</button>${paginationItems(menuPage, pageCount).map((page) => page === "ellipsis" ? `<span class="menu-b7-page-ellipsis" aria-hidden="true">…</span>` : `<button type="button" data-menu-page="${page}" ${page === menuPage ? 'class="is-current" aria-current="page"' : ""} aria-label="Halaman ${page}">${page}</button>`).join("")}<button type="button" data-menu-page="${menuPage + 1}" ${menuPage === pageCount ? "disabled" : ""} aria-label="Halaman berikutnya">›</button></div></div>`;
}

function paginationItems(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  const ordered = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  return ordered.flatMap((page, index) => index && page - ordered[index - 1] > 1 ? ["ellipsis", page] : [page]);
}

function menuProductImage(product) {
  const defaults = {
    "americano": "/assets/menu/v1/americano-v1.svg", "cafe-latte": "/assets/menu/v1/cafe-latte-v1.svg", "cappucino": "/assets/menu/v1/cappucino-v2.svg", "moccacino": "/assets/menu/v1/moccacino-v2.svg",
    "es-kopi-saga": "/assets/menu/v2/es-kopi-saga-dummy-v1.svg", "saga-premiyum": "/assets/menu/v2/saga-premiyum-dummy-v1.svg", "magnosiyum": "/assets/menu/v2/magnosiyum-dummy-v1.svg",
    "matcha": "/assets/menu/v1/matcha-v1.svg", "chocolate": "/assets/menu/v1/chocolate-v1.svg", "red-velvet": "/assets/menu/v1/red-velvet-v1.svg",
    "brr-patabim": "/assets/menu/v2/brr-patabim-dummy-v1.svg", "tralalelow": "/assets/menu/v2/tralalelow-dummy-v1.svg", "si-biyu": "/assets/menu/v2/si-biyu-dummy-v1.svg", "oyen-sunkist": "/assets/menu/v2/oyen-sunkist-dummy-v1.svg",
    "mohito": "/assets/menu/v2/mohito-dummy-v1.svg", "range-bliss": "/assets/menu/v2/range-bliss-dummy-v1.svg", "lychee-ti": "/assets/menu/v1/lychee-ti-v1.svg", "lemon-ti": "/assets/menu/v1/lemon-ti-v1.svg",
    "creamcheese-bagel": "/assets/menu/v3/creamcheese-bagel-dummy-v1.svg", "strawberry-bagel": "/assets/menu/v3/strawberry-bagel-dummy-v1.svg", "ham-fresh-bagel": "/assets/menu/v3/ham-fresh-bagel-dummy-v1.svg", "moka-bagel": "/assets/menu/v3/moka-bagel-dummy-v1.svg",
  };
  const source = product.imageUrl || defaults[product.id];
  return source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(product.imageAlt || `Foto ${product.name}`)}" width="52" height="52" loading="lazy">` : escapeHtml(product.name.slice(0, 2).toUpperCase());
}

function renderMenuAvailabilityShell(currentState, products) {
  const normalizedQuery = menuProductQuery.trim().toLocaleLowerCase("id-ID");
  const filtered = products.filter((product) => (!normalizedQuery || product.name.toLocaleLowerCase("id-ID").includes(normalizedQuery)) && (menuCategoryFilter === "all" || product.categoryId === menuCategoryFilter) && product.status !== "archived");
  const cards = filtered.map((product) => `<article data-menu-row="${escapeHtml(product.id)}"><div class="menu-b7-product"><span class="menu-b7-thumb">${menuProductImage(product)}</span><div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.categoryName)} · ${product.station === "bar" ? "Bar" : "Food"}</small></div></div><div><span data-menu-availability-label>${product.available ? "Tersedia" : "Habis"}</span><button type="button" class="menu-b7-toggle ${product.available ? "is-on" : ""}" role="switch" aria-checked="${product.available}" data-menu-availability="${escapeHtml(product.id)}" data-available="${!product.available}" aria-label="${product.available ? "Tandai habis" : "Tandai tersedia"} ${escapeHtml(product.name)}"><span></span></button><small class="menu-b7-inline-error" role="alert"></small></div></article>`).join("");
  if (embeddedDashboardWorkspace) return `<section class="menu-v2-shell menu-b7-workspace menu-b7-availability dashboard-menu-native" aria-labelledby="menu-v2-title"><div class="menu-b7-page-head"><div><p class="eyebrow">Mode operasional</p><h2 id="menu-v2-title">Tersedia / Habis</h2><p>Perubahan berlaku langsung ke Kasir dan Kiosk serta dicatat pada audit.</p></div><div><a href="#catalog/products" class="button button-secondary">Workspace lengkap</a><a href="/kiosk" class="button button-secondary" target="_blank" rel="noopener">Lihat Kiosk</a></div></div><div class="menu-v2-panel"><div class="menu-b7-toolbar menu-b7-availability-toolbar"><label><span class="sr-only">Cari nama menu</span><input id="menu-b7-search" type="search" placeholder="Cari menu..." value="${escapeHtml(menuProductQuery)}"></label><label><span class="sr-only">Kategori</span><select id="menu-b7-category"><option value="all">Semua kategori</option>${currentState.catalog.map((category) => `<option value="${escapeHtml(category.id)}" ${menuCategoryFilter === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label></div><div class="menu-b7-availability-grid">${cards || `<div class="menu-b7-empty"><strong>Menu tidak ditemukan</strong><span>Ubah pencarian atau kategori.</span></div>`}</div></div></section>`;
  return `<section class="menu-v2-shell menu-b7-workspace menu-b7-availability" aria-labelledby="menu-v2-title"><header class="menu-b7-topbar"><div class="menu-b7-brand"><span>KS</span><div><strong>Availability menu</strong><small>${escapeHtml(currentState.context.outletName ?? "Kopi Saga Salak")}</small></div></div><div class="menu-b7-context"><a href="/admin/menu" class="button button-ghost">Workspace lengkap</a><span>${escapeHtml(currentState.actor.displayName)} · ${String(currentState.actor.role).toUpperCase()}</span></div></header><div class="menu-b7-page-head"><div><p class="eyebrow">Mode operasional</p><h2 id="menu-v2-title">Tersedia / Habis</h2><p>Perubahan di route ini berlaku langsung ke Kasir dan Kiosk serta tercatat di audit.</p></div><a class="button button-secondary" href="/kiosk" target="_blank" rel="noopener">Lihat Kiosk</a></div><div class="menu-v2-panel"><div class="menu-b7-toolbar menu-b7-availability-toolbar"><label><span class="sr-only">Cari nama menu</span><input id="menu-b7-search" type="search" placeholder="Cari menu..." value="${escapeHtml(menuProductQuery)}"></label><label><span class="sr-only">Kategori</span><select id="menu-b7-category"><option value="all">Semua kategori</option>${currentState.catalog.map((category) => `<option value="${escapeHtml(category.id)}" ${menuCategoryFilter === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label></div><div class="menu-b7-availability-grid">${cards || `<div class="menu-b7-empty"><strong>Menu tidak ditemukan</strong><span>Ubah pencarian atau kategori.</span></div>`}</div></div></section>`;
}

function renderMenuCategoriesPanel(currentState) {
  return `<div class="menu-b7-section-head"><div><p class="eyebrow">Struktur katalog</p><h3>Kategori</h3><p>Kategori dan urutannya baru terlihat di Kasir/Kiosk setelah publication.</p></div></div><div class="menu-v2-category-list">${currentState.catalog.map((item, index) => `<article><strong>${escapeHtml(item.name)}</strong><span>${item.products.length} produk</span><small>Urutan ${item.sortRank ?? index}</small><button type="button" class="button button-ghost" data-menu-category-edit="${escapeHtml(item.id)}">Edit kategori</button></article>`).join("")}</div><form id="menu-v2-category-create" class="menu-v2-form"><h3>Tambah kategori</h3><label>Nama kategori<input name="name" maxlength="60" required></label><label>Alasan<input name="reason" maxlength="160" required></label><button class="button button-primary" ${currentState.featureFlags.catalogWorkspaceV2 ? "" : "disabled"}>Tambah sebagai draft</button><p role="status"></p></form>`;
}

function renderMenuPublicationPanel(currentState) {
  const workspace = currentState.menuWorkspace ?? { draftCount: 0, changes: [], publications: [], publishedRevision: 0 };
  return `<div class="menu-b7-publication-head"><div><p class="eyebrow">Release katalog</p><h3>${workspace.draftCount} perubahan siap ditinjau</h3><p>Kasir dan Kiosk tetap memakai revision ${workspace.publishedRevision || 0} sampai publication berhasil.</p></div><button type="button" class="button button-primary" data-menu-open-publish ${workspace.draftCount ? "" : "disabled"}>Tinjau & publikasi</button></div><div class="menu-b7-review-list">${workspace.changes.length ? workspace.changes.map((change) => `<article><span>${escapeHtml(change.summary)}</span><strong>${escapeHtml(change.entityId)}</strong><small>${escapeHtml(change.reason)} · v${change.version}</small></article>`).join("") : `<div class="menu-b7-empty"><strong>Belum ada perubahan draft</strong><span>Edit katalog untuk memulai publication berikutnya.</span></div>`}</div><div class="menu-b7-history"><h3>Riwayat publication</h3>${workspace.publications.length ? workspace.publications.map((publication) => `<article><div><strong>Revision ${publication.revision}</strong><span>${publication.changeCount} perubahan · ${escapeHtml(publication.note || publication.reason)}</span></div><code>${escapeHtml(publication.snapshotHash?.slice(0, 12))}</code>${publication.snapshotAvailable ? `<button type="button" class="button button-ghost" data-menu-rollback="${escapeHtml(publication.id)}">Rollback sebagai revision baru</button>` : ""}</article>`).join("") : "<p>Belum ada publication dari workspace Batch 7.</p>"}</div>`;
}

function renderMenuKioskPanel(currentState) {
  return `<div class="menu-v2-summary"><div><span>Penerimaan order</span><strong>${currentState.orderingSettings?.paused ? "Dijeda" : "Aktif"}</strong></div><div><span>Jam layanan</span><strong>${escapeHtml(currentState.orderingSettings?.opensAt)}–${escapeHtml(currentState.orderingSettings?.lastOrderAt)}</strong></div><div><span>Published revision</span><strong>${currentState.menuWorkspace?.publishedRevision ?? 0}</strong></div></div><div class="menu-v2-actions"><a class="button button-secondary" href="/kiosk" target="_blank" rel="noopener">Pratinjau Kiosk</a><p>Kiosk dan Kasir hanya membaca snapshot publication lengkap; availability operasional tetap dapat dioverride dari route cepat.</p></div>${staticDemoAsset ? `<section class="menu-v2-form" aria-labelledby="static-demo-title"><h3 id="static-demo-title">QRIS Statis · DEMO terisolasi</h3><p><strong>Bukan pembayaran nyata.</strong> PNG ini hanya untuk simulasi di private staging. Konfirmasi kasir tidak mencatat pendapatan.</p><img src="/api/kiosk/static-qris-demo/image" alt="Gambar QR uji saat ini; jangan dipakai untuk membayar" width="180" height="180"><p>Status: ${staticDemoAsset.configured ? `PNG tersimpan · revision ${staticDemoAsset.revision}` : "Placeholder non-scannable"}</p><form id="static-demo-qr-form"><label>Ganti PNG uji<input name="image" type="file" accept="image/png" required></label><p>Maksimal 256 KB, 64–2048 piksel. Gambar hanya berlaku bagi outlet ini.</p><p role="status"></p><button class="button button-primary" type="submit">Simpan gambar demo</button></form></section>` : ""}<form id="ordering-editor" class="menu-v2-form"><h3>Jam dan penerimaan order</h3><label>Penerimaan pesanan<select name="paused"><option value="false" ${!currentState.orderingSettings?.paused ? "selected" : ""}>Terima pesanan baru</option><option value="true" ${currentState.orderingSettings?.paused ? "selected" : ""}>Jeda pesanan baru</option></select></label><label>Aturan jam<select name="enforceHours"><option value="false" ${!currentState.orderingSettings?.enforceHours ? "selected" : ""}>Belum diterapkan</option><option value="true" ${currentState.orderingSettings?.enforceHours ? "selected" : ""}>Terapkan jam WIB</option></select></label>${[["opensAt", "Jam buka"], ["lastOrderAt", "Pesanan terakhir"], ["closesAt", "Jam tutup"]].map(([name, label]) => `<label>${label}<input name="${name}" type="time" required value="${escapeHtml(currentState.orderingSettings?.[name])}"></label>`).join("")}<label>Alasan<input name="reason" maxlength="160" required></label><p role="status" id="ordering-editor-status"></p><button class="button button-primary">Simpan sebagai draft</button></form>`;
}

function renderManualQrisAssetPanel() {
  if (!manualQrisAsset) return "";
  const checkoutStatus = manualQrisAsset.checkoutEnabled
    ? "Checkout QRIS statis aktif untuk Kiosk outlet ini setelah PNG tersimpan. Unggahan tidak mengonfirmasi pembayaran atau mengirim order ke KDS."
    : "Checkout QRIS statis belum aktif. PNG merchant asli yang valid harus tersimpan terlebih dahulu; setelah itu metode Kiosk tersedia dan tetap menunggu konfirmasi kasir.";
  return `<section class="menu-v2-form" aria-labelledby="manual-qris-asset-title"><h3 id="manual-qris-asset-title">QRIS Statis Merchant · Aset asli</h3><p>Unggah PNG QRIS milik merchant. <strong>${checkoutStatus}</strong> Kasir wajib memeriksa transaksi di aplikasi merchant sebelum menandai lunas pada alur terpisah.</p>${manualQrisAsset.configured ? `<img src="/api/admin/manual-qris/image" alt="QRIS merchant tersimpan untuk outlet ini" width="180" height="180"><p>PNG tersimpan · revision ${manualQrisAsset.revision}</p>` : "<p>Belum ada PNG merchant. Pembayaran QRIS statis tetap terkunci.</p>"}<form id="manual-qris-asset-form"><label>PNG QRIS merchant<input name="image" type="file" accept="image/png" required></label><p>Maksimal 256 KB, 64–2048 piksel. Hanya Owner dapat mengganti aset outlet ini.</p><p role="status"></p><button class="button button-primary" type="submit">Simpan PNG merchant</button></form></section>`;
}

async function saveManualQrisAsset(event) {
  if (event.target.id !== "manual-qris-asset-form") return;
  event.preventDefault();
  const form = event.target;
  const status = form.querySelector('[role="status"]');
  const button = form.querySelector("button");
  const file = form.elements.image.files?.[0];
  if (!file || file.type !== "image/png" || file.size > 256 * 1024) { status.textContent = "Pilih PNG maksimal 256 KB."; return; }
  button.disabled = true;
  try {
    const imageDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    await request("/api/admin/manual-qris/asset", { method: "POST", csrf: true,
      body: { imageDataUrl, expectedRevision: manualQrisAsset.revision } });
    await refresh();
    announce("PNG merchant tersimpan. Checkout QRIS statis tetap terkunci sampai verifikasi alur kasir selesai.");
  } catch (error) { status.textContent = menuErrorMessage(error); button.disabled = false; }
}

async function saveStaticDemoQr(event) {
  if (event.target.id !== "static-demo-qr-form") return;
  event.preventDefault();
  const form = event.target;
  const status = form.querySelector('[role="status"]');
  const button = form.querySelector("button");
  const file = form.elements.image.files?.[0];
  if (!file || file.type !== "image/png" || file.size > 256 * 1024) { status.textContent = "Pilih PNG maksimal 256 KB."; return; }
  button.disabled = true;
  try {
    const imageDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
    await request("/api/admin/static-qris-demo/asset", { method: "POST", csrf: true, body: { imageDataUrl, expectedRevision: staticDemoAsset.revision } });
    await refresh();
    announce("Gambar QR uji tersimpan di Postgres terisolasi. Mode pembayaran tetap DEMO.");
  } catch (error) { status.textContent = menuErrorMessage(error); button.disabled = false; }
}

function renderProductEditorialFields(product) {
  const details = product?.catalogDetails ?? {};
  const nutrition = details.nutritionEstimate ?? {};
  const nutritionFields = [["caloriesKcal", "Kalori (kkal)"], ["sugarG", "Gula (g)"], ["proteinG", "Protein (g)"], ["fatG", "Lemak (g)"], ["caffeineMg", "Kafein (mg)"], ["servingMl", "Sajian (ml)"]];
  return `<fieldset class="menu-b7-media"><legend>Konten e-catalogue</legend><label>Deskripsi singkat<input name="shortDescription" maxlength="160" value="${escapeHtml(details.shortDescription ?? "")}" placeholder="Satu kalimat untuk kartu menu"></label><label>Deskripsi lengkap<textarea name="description" maxlength="600" placeholder="Karakter rasa dan pengalaman produk">${escapeHtml(details.description ?? "")}</textarea></label><div class="menu-b7-form-grid"><label>Profil rasa (pisahkan koma)<input name="profileTags" value="${escapeHtml((details.profileTags ?? []).join(", "))}"></label><label>Alergen (pisahkan koma)<input name="allergens" value="${escapeHtml((details.allergens ?? []).join(", "))}"></label><label>Badge, maksimal 2<input name="badges" value="${escapeHtml((details.badges ?? []).join(", "))}"></label><label>ID produk alternatif<input name="alternativeProductIds" value="${escapeHtml((details.alternativeProductIds ?? []).join(", "))}"></label></div></fieldset><fieldset class="menu-b7-media"><legend>Estimasi Resep (opsional, bukan uji laboratorium)</legend><div class="menu-b7-form-grid">${nutritionFields.map(([name, label]) => `<label>${label}<input name="${name}" type="number" min="0" step="0.1" value="${nutrition[name] ?? ""}"></label>`).join("")}</div><label>Tanggal pembaruan sumber resep<input name="nutritionSourceUpdatedAt" type="date" value="${escapeHtml(nutrition.sourceUpdatedAt?.slice(0, 10) ?? "")}"></label></fieldset>`;
}

function renderMenuDialog(currentState, products) {
  if (!menuDialog) return "";
  const product = menuDialog.productId ? products.find((item) => item.id === menuDialog.productId) : null;
  const category = menuDialog.categoryId ? currentState.catalog.find((item) => item.id === menuDialog.categoryId) : null;
  if (menuDialog.type === "product") return `<div class="menu-b7-overlay" data-menu-dialog-backdrop><section class="menu-b7-modal" role="dialog" aria-modal="true" aria-labelledby="menu-b7-dialog-title"><header><div><p class="eyebrow">SagaPOS · Menu</p><h3 id="menu-b7-dialog-title">${product ? "Edit produk" : "Tambah produk"}</h3></div><button type="button" data-menu-close aria-label="Tutup dialog">×</button></header><form id="menu-b7-product-form"><input type="hidden" name="productId" value="${escapeHtml(product?.id ?? "")}"><div class="menu-b7-stepper"><span class="is-active">1</span><b>Informasi dasar</b><i></i><span>2</span><b>Editorial</b><i></i><span>3</span><b>Tinjau</b></div><label>Nama produk<input data-autofocus name="name" maxlength="80" value="${escapeHtml(product?.name ?? "")}" required></label><div class="menu-b7-form-grid"><label>Kategori<select name="categoryId">${currentState.catalog.map((category) => `<option value="${escapeHtml(category.id)}" ${product?.categoryId === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")}</select></label><label>Harga jual<div class="menu-b7-money"><span>Rp</span><input name="priceRupiah" type="number" min="100" max="10000000" value="${product?.priceRupiah ?? 15000}" required></div></label></div><label>Stasiun produksi<select name="station"><option value="bar" ${product?.station === "bar" ? "selected" : ""}>Bar</option><option value="food" ${product?.station === "food" ? "selected" : ""}>Food</option></select></label>${renderProductEditorialFields(product)}<fieldset class="menu-b7-media"><legend>Foto produk (opsional)</legend><label>Pilih foto<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Teks alternatif<input name="altText" maxlength="120" value="${escapeHtml(product?.imageAlt ?? product?.name ?? "")}" placeholder="Deskripsi singkat foto"></label><div class="menu-b7-form-grid"><label>Posisi horizontal<input name="cropX" type="range" min="0" max="100" value="50"></label><label>Posisi vertikal<input name="cropY" type="range" min="0" max="100" value="50"></label></div><label>Zoom<input name="zoom" type="range" min="100" max="200" value="100"></label><small>Foto dipotong menjadi WebP persegi 768 px dan metadata sumber tidak ikut disimpan.</small></fieldset><label>Alasan perubahan<input name="reason" maxlength="160" required></label><div class="menu-b7-draft-note"><strong>Disimpan sebagai draft</strong><span>Perubahan tidak tampil di Kasir/Kiosk sebelum publication.</span></div><p role="alert"></p><footer><button type="button" class="button button-secondary" data-menu-close>Batal</button><button class="button button-primary">Simpan dan lanjut</button></footer></form></section></div>`;
  if (["archive", "restore"].includes(menuDialog.type) && product) { const restoring = menuDialog.type === "restore"; return `<div class="menu-b7-overlay" data-menu-dialog-backdrop><section class="menu-b7-modal is-compact" role="dialog" aria-modal="true" aria-labelledby="menu-b7-dialog-title"><header><div><p class="eyebrow">Perubahan lifecycle</p><h3 id="menu-b7-dialog-title">${restoring ? "Pulihkan" : "Arsipkan"} ${escapeHtml(product.name)}?</h3></div><button type="button" data-menu-close aria-label="Tutup dialog">×</button></header><form id="menu-b7-archive-form"><input type="hidden" name="productId" value="${escapeHtml(product.id)}"><input type="hidden" name="mode" value="${menuDialog.type}"><p>${restoring ? "Produk akan kembali ke katalog setelah publication." : "Produk disembunyikan setelah publication; transaksi dan HPP lama tetap tersimpan."}</p><label>Alasan<textarea data-autofocus name="reason" maxlength="160" required>${restoring ? "Produk dijual kembali" : "Menu tidak dijual sementara"}</textarea></label><p role="alert"></p><footer><button type="button" class="button button-secondary" data-menu-close>Batal</button><button class="button ${restoring ? "button-primary" : "button-danger"}">${restoring ? "Pulihkan sebagai draft" : "Arsipkan sebagai draft"}</button></footer></form></section></div>`; }
  if (menuDialog.type === "category" && category) return `<div class="menu-b7-overlay" data-menu-dialog-backdrop><section class="menu-b7-modal is-compact" role="dialog" aria-modal="true" aria-labelledby="menu-b7-dialog-title"><header><div><p class="eyebrow">Struktur katalog</p><h3 id="menu-b7-dialog-title">Edit kategori</h3></div><button type="button" data-menu-close aria-label="Tutup dialog">×</button></header><form id="menu-b7-category-form"><input type="hidden" name="categoryId" value="${escapeHtml(category.id)}"><label>Nama kategori<input data-autofocus name="name" maxlength="60" value="${escapeHtml(category.name)}" required></label><label>Urutan<input name="sortRank" type="number" min="0" max="999" value="${category.sortRank ?? 0}" required></label><label><input name="archived" type="checkbox"> Arsipkan kategori</label><label>Alasan<input name="reason" maxlength="160" required></label><p role="alert"></p><footer><button type="button" class="button button-secondary" data-menu-close>Batal</button><button class="button button-primary">Simpan sebagai draft</button></footer></form></section></div>`;
  if (menuDialog.type === "publish") { const workspace = currentState.menuWorkspace; return `<div class="menu-b7-overlay" data-menu-dialog-backdrop><section class="menu-b7-modal is-compact" role="dialog" aria-modal="true" aria-labelledby="menu-b7-dialog-title"><header><div><p class="eyebrow">Publication review</p><h3 id="menu-b7-dialog-title">Publikasikan perubahan</h3></div><button type="button" data-menu-close aria-label="Tutup dialog">×</button></header><form id="menu-b7-publish-form"><div class="menu-b7-publish-hero"><strong>${workspace?.draftCount ?? 0} perubahan siap diterbitkan</strong><span>Snapshot atomik akan dikirim ke Kasir dan Kiosk.</span></div><div class="menu-b7-review-list is-modal">${(workspace?.changes ?? []).map((change) => `<article><span>${escapeHtml(change.summary)}</span><strong>${escapeHtml(change.entityId)}</strong></article>`).join("")}</div><label>Catatan publication<input data-autofocus name="note" maxlength="240" placeholder="Contoh: Pembaruan menu sore"></label><label>Alasan persetujuan<input name="reason" maxlength="160" required value="Perubahan menu sudah ditinjau Owner"></label><p role="alert"></p><footer><button type="button" class="button button-secondary" data-menu-close>Kembali</button><button type="submit" class="button button-primary">Publikasikan sekarang</button></footer></form></section></div>`; }
  return "";
}

function productEditorialPayload(values) {
  const nutritionKeys = ["caloriesKcal", "sugarG", "proteinG", "fatG", "caffeineMg", "servingMl"];
  const nutritionValues = Object.fromEntries(nutritionKeys.filter((key) => values[key] !== "").map((key) => [key, Number(values[key])]));
  const nutritionEstimate = Object.keys(nutritionValues).length ? { ...nutritionValues, sourceUpdatedAt: values.nutritionSourceUpdatedAt ? new Date(`${values.nutritionSourceUpdatedAt}T00:00:00+07:00`).toISOString() : "" } : null;
  return {
    shortDescription: values.shortDescription,
    description: values.description,
    profileTags: commaList(values.profileTags),
    allergens: commaList(values.allergens),
    badges: commaList(values.badges),
    alternativeProductIds: commaList(values.alternativeProductIds),
    nutritionEstimate,
  };
}

function commaList(value) { return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean); }

async function saveMenuDialog(event) {
  if (event.target.id === "menu-b7-product-form") {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form));
    const product = values.productId ? state.catalog.flatMap((category) => category.products.map((item) => ({ ...item, categoryId: category.id }))).find((item) => item.id === values.productId) : null;
    const actionName = product ? "catalog.workspace.product.update" : "catalog.workspace.product.create";
    const catalogDetails = productEditorialPayload(values);
    const payload = product ? { productId: product.id, name: values.name, priceRupiah: Number(values.priceRupiah), categoryId: values.categoryId, station: values.station, status: product.status, sortRank: product.sortRank ?? 0, catalogDetails, expectedVersion: state.catalogVersion, reason: values.reason } : { name: values.name, priceRupiah: Number(values.priceRupiah), categoryId: values.categoryId, station: values.station, customizationProfile: "beverage", catalogDetails, expectedVersion: state.catalogVersion, reason: values.reason };
    try {
      const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: actionName, payload } });
      const image = form.elements.image?.files?.[0];
      if (image) {
        const imageDataUrl = await cropMenuImage(image, Number(values.cropX), Number(values.cropY), Number(values.zoom));
        await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.product.media.update", payload: { productId: product?.id ?? result.product.id, imageDataUrl, altText: values.altText || values.name, expectedVersion: result.version, reason: values.reason } } });
      }
      menuDialog = null; await refresh(); announce(product ? "Perubahan produk tersimpan sebagai draft." : "Produk baru tersimpan sebagai draft.");
    }
    catch (error) { form.querySelector("[role='alert']").textContent = menuErrorMessage(error); }
    return;
  }
  if (event.target.id === "menu-b7-archive-form") {
    event.preventDefault();
    const form = event.target; const values = Object.fromEntries(new FormData(form));
    const actionName = values.mode === "restore" ? "catalog.product.restore" : "catalog.product.archive";
    try { await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: actionName, payload: { productId: values.productId, expectedVersion: state.catalogVersion, reason: values.reason } } }); menuDialog = null; menuSelected.delete(values.productId); await refresh(); announce(values.mode === "restore" ? "Pemulihan produk disimpan sebagai draft." : "Pengarsipan produk disimpan sebagai draft."); }
    catch (error) { form.querySelector("[role='alert']").textContent = menuErrorMessage(error); }
    return;
  }
  if (event.target.id === "menu-b7-publish-form") {
    event.preventDefault();
    const form = event.target; const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button[type='submit']"); button.disabled = true;
    try { const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.publish", payload: { expectedVersion: state.catalogVersion, reason: values.reason, note: values.note } } }); menuDialog = null; menuSelected.clear(); await refresh(); announce(`Revision ${result.publication.revision} berhasil dipublikasikan.`); }
    catch (error) { form.querySelector("[role='alert']").textContent = menuErrorMessage(error); button.disabled = false; }
    return;
  }
  if (event.target.id === "menu-b7-category-form") {
    event.preventDefault();
    const form = event.target; const values = Object.fromEntries(new FormData(form));
    try { await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.category.update", payload: { categoryId: values.categoryId, name: values.name, sortRank: Number(values.sortRank), archived: values.archived === "on", expectedVersion: state.catalogVersion, reason: values.reason } } }); menuDialog = null; await refresh(); announce("Kategori diperbarui sebagai draft."); }
    catch (error) { form.querySelector("[role='alert']").textContent = menuErrorMessage(error); }
  }
}

async function stageMenuAvailability(button) {
  const nextAvailable = button.dataset.available === "true";
  const previousAvailable = button.getAttribute("aria-checked") === "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-checked", String(nextAvailable));
  button.classList.toggle("is-on", nextAvailable);
  const row = button.closest("[data-menu-row]");
  const label = row?.querySelector("[data-menu-availability-label]");
  const inlineError = row?.querySelector(".menu-b7-inline-error");
  if (label) label.textContent = `${nextAvailable ? "Tersedia" : "Habis"}${menuAvailabilityRoute ? "" : " · menyimpan…"}`;
  if (inlineError) inlineError.textContent = "";
  try {
    const actionName = menuAvailabilityRoute ? "catalog.availability" : "catalog.availability.draft";
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: actionName, payload: { productId: button.dataset.menuAvailability, available: nextAvailable, expectedVersion: state.catalogVersion, reason: menuAvailabilityRoute ? "Perubahan availability operasional" : "Perubahan availability dari workspace Menu", ...(menuAvailabilityRoute && !nextAvailable ? { resetMode: "manual" } : {}) } } });
    await refresh(); announce(menuAvailabilityRoute ? "Availability langsung tersinkron ke Kasir dan Kiosk." : "Perubahan availability tersimpan sebagai draft.");
  } catch (error) { button.setAttribute("aria-checked", String(previousAvailable)); button.classList.toggle("is-on", previousAvailable); button.removeAttribute("aria-busy"); if (label) label.textContent = previousAvailable ? "Tersedia" : "Habis"; if (inlineError) inlineError.textContent = "Gagal disimpan. Coba lagi."; announce(menuErrorMessage(error), true); button.disabled = false; }
}

async function commitMenuBulk(operation) {
  const productIds = [...menuSelected];
  if (!productIds.length) return;
  if (["move-up", "move-down"].includes(operation)) {
    try { await reorderSelectedProducts(operation === "move-up" ? -1 : 1); menuSelected.clear(); await refresh(); announce(`${productIds.length} produk diurutkan sebagai draft.`); }
    catch (error) { announce(menuErrorMessage(error), true); }
    return;
  }
  const payload = { productIds, operation: operation === "available" || operation === "sold-out" ? "availability" : operation, available: operation === "available" ? true : operation === "sold-out" ? false : null, expectedVersion: state.catalogVersion, reason: `Aksi massal ${operation} dari workspace Menu` };
  try { await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.bulk", payload } }); menuSelected.clear(); await refresh(); announce(`${productIds.length} produk diproses sebagai draft.`); }
  catch (error) { announce(menuErrorMessage(error), true); }
}

async function rollbackMenuPublication(publicationId) {
  if (!window.confirm("Buat revision baru dari snapshot publication ini?")) return;
  try { await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.publication.rollback", payload: { publicationId, expectedVersion: state.catalogVersion, reason: "Rollback publication oleh Owner" } } }); await refresh(); announce("Rollback diterbitkan sebagai revision baru."); }
  catch (error) { announce(menuErrorMessage(error), true); }
}

function handleMenuKeydown(event) {
  if (!dedicatedMenuWorkspace && !embeddedDashboardWorkspace) return;
  const dragHandle = event.target.closest?.("[data-menu-drag-handle]");
  if (dragHandle && ["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    reorderMenuProduct(dragHandle.dataset.menuDragHandle, event.key === "ArrowUp" ? -1 : 1, null, dragHandle);
    return;
  }
  if (event.key === "Escape" && menuDialog) { event.preventDefault(); menuDialog = null; render(); return; }
  const tab = event.target.closest?.("[role='tab']");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    const tabs = [...content.querySelectorAll("[role='tab']")];
    const current = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].click(); requestAnimationFrame(() => content.querySelectorAll("[role='tab']")[next]?.focus()); return;
  }
  const dialog = event.target.closest?.("[role='dialog']");
  if (dialog && event.key === "Tab") {
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]")];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}

function handleMenuDragStart(event) {
  const handle = event.target.closest?.("[data-menu-drag-handle]");
  const row = event.target.closest?.("[data-menu-row]");
  if (!handle || !row) return;
  menuDragProductId = row.dataset.menuRow;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", menuDragProductId);
}

function handleMenuDragOver(event) {
  const row = event.target.closest?.("[data-menu-row]");
  if (!row || !menuDragProductId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function handleMenuDrop(event) {
  const row = event.target.closest?.("[data-menu-row]");
  const sourceId = menuDragProductId || event.dataTransfer.getData("text/plain");
  menuDragProductId = null;
  if (!row || !sourceId || sourceId === row.dataset.menuRow) return;
  event.preventDefault();
  reorderMenuProduct(sourceId, 0, row.dataset.menuRow, null);
}

async function reorderMenuProduct(productId, delta, targetProductId = null, focusTarget = null) {
  const categories = state.catalog.map((category) => ({ ...category, products: [...category.products] }));
  const category = categories.find((item) => item.products.some((product) => product.id === productId));
  const targetCategory = targetProductId ? categories.find((item) => item.products.some((product) => product.id === targetProductId)) : category;
  if (!category || category.id !== targetCategory?.id) { announce("Urutan hanya dapat dipindah di dalam kategori yang sama.", true); return; }
  const orderedProductIds = category.products.map((product) => product.id);
  const from = orderedProductIds.indexOf(productId);
  const to = targetProductId ? orderedProductIds.indexOf(targetProductId) : Math.max(0, Math.min(orderedProductIds.length - 1, from + delta));
  if (from === to) return;
  orderedProductIds.splice(to, 0, orderedProductIds.splice(from, 1)[0]);
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.product.reorder", payload: { categoryId: category.id, orderedProductIds, expectedVersion: state.catalogVersion, reason: "Urutan menu diperbarui dari workspace" } } });
    await refresh(); announce("Urutan produk tersimpan sebagai draft.");
    requestAnimationFrame(() => content.querySelector(`[data-menu-drag-handle="${CSS.escape(productId)}"]`)?.focus());
  } catch (error) { announce(menuErrorMessage(error), true); focusTarget?.focus(); }
}

async function reorderSelectedProducts(delta) {
  let expectedVersion = state.catalogVersion;
  for (const category of state.catalog) {
    const orderedProductIds = category.products.map((product) => product.id);
    let changed = false;
    if (delta < 0) {
      for (let index = 1; index < orderedProductIds.length; index += 1) if (menuSelected.has(orderedProductIds[index]) && !menuSelected.has(orderedProductIds[index - 1])) { [orderedProductIds[index - 1], orderedProductIds[index]] = [orderedProductIds[index], orderedProductIds[index - 1]]; changed = true; }
    } else {
      for (let index = orderedProductIds.length - 2; index >= 0; index -= 1) if (menuSelected.has(orderedProductIds[index]) && !menuSelected.has(orderedProductIds[index + 1])) { [orderedProductIds[index], orderedProductIds[index + 1]] = [orderedProductIds[index + 1], orderedProductIds[index]]; changed = true; }
    }
    if (!changed) continue;
    const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.workspace.product.reorder", payload: { categoryId: category.id, orderedProductIds, expectedVersion, reason: "Urutan massal menu diperbarui" } } });
    expectedVersion = result.version;
  }
}

function menuErrorMessage(error) {
  const messages = { catalog_version_conflict: "Data berubah di perangkat lain. Muat ulang dan tinjau ulang draft.", catalog_workspace_empty: "Belum ada perubahan yang dapat dipublikasikan.", catalog_category_in_use: "Pindahkan atau arsipkan produk aktif sebelum mengarsipkan kategori.", product_not_archived: "Produk ini tidak lagi berada di arsip." };
  return messages[error.code] ?? error.message;
}

async function cropMenuImage(file, cropX = 50, cropY = 50, zoom = 100) {
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type) || file.size > 8_000_000) throw new Error("Foto harus PNG, JPEG, atau WebP maksimal 8 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas"); canvas.width = 768; canvas.height = 768;
    const context = canvas.getContext("2d", { alpha: false });
    const scale = Math.max(768 / bitmap.width, 768 / bitmap.height) * Math.max(1, zoom / 100);
    const sourceWidth = 768 / scale; const sourceHeight = 768 / scale;
    const sourceX = (bitmap.width - sourceWidth) * Math.max(0, Math.min(100, cropX)) / 100;
    const sourceY = (bitmap.height - sourceHeight) * Math.max(0, Math.min(100, cropY)) / 100;
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, 768, 768);
    return canvas.toDataURL("image/webp", .82);
  } finally { bitmap.close(); }
}

function productHistoryRow(entry) {
  if (entry.type === "catalog.category.created") return `<li>Kategori ${escapeHtml(entry.categoryId)} dibuat · ${escapeHtml(entry.reason)} · v${entry.version}</li>`;
  if (entry.type === "catalog.product.created") return `<li>${escapeHtml(entry.next?.name ?? entry.productId)} dibuat sebagai draft · ${escapeHtml(entry.reason)} · v${entry.version}</li>`;
  if (entry.type === "catalog.product.published") return `<li>${escapeHtml(entry.productId)} dipublish · ${escapeHtml(entry.reason)} · v${entry.version}</li>`;
  if (entry.type?.startsWith("catalog.product.media.")) return `<li>Media ${escapeHtml(entry.productId)} diperbarui · ${escapeHtml(entry.reason)} · v${entry.version}</li>`;
  return `<li>${escapeHtml(entry.next?.name ?? entry.productId ?? entry.type)}${entry.previous?.priceRupiah != null && entry.next?.priceRupiah != null ? `: ${rupiah(entry.previous.priceRupiah)} → ${rupiah(entry.next.priceRupiah)}` : ""} · ${escapeHtml(entry.reason)} · v${entry.version}</li>`;
}

function renderPromotionWorkspace(configuration = {}, products = [], enabled = false, generatedAt = new Date().toISOString(), timezone = "Asia/Jakarta") {
  const rules = configuration.rules ?? [];
  const now = new Date(generatedAt);
  const start = dateTimeLocalValue(now, timezone);
  const end = dateTimeLocalValue(new Date(now.getTime() + 7 * 24 * 60 * 60_000), timezone);
  return `<div class="menu-v2-promo-grid"><div><button type="button" class="button button-primary" data-promo-open ${enabled ? "" : "disabled"}>Tambah promo / voucher</button><p>Draft tidak mengubah checkout sampai diaktifkan dan dipublikasikan.</p></div><dialog id="owner-promo-dialog" class="cashier-dialog promotion-dialog" aria-labelledby="owner-promo-title"><header><h3 id="owner-promo-title">Atur promo / voucher</h3><button type="button" class="button button-secondary" data-promo-close>Tutup pengaturan promo</button></header><form id="menu-v2-promotion" class="menu-v2-form"><input name="promotionId" type="hidden"><label>Cara memakai<select name="activationMode"><option value="CODE">Kode promo bersama</option><option value="AUTOMATIC">Otomatis sesuai syarat</option><option value="VOUCHER">Voucher unik sekali pakai</option></select></label><label>Nama promo<input name="name" maxlength="120" required></label><label>Kode<input name="code" maxlength="64" pattern="[A-Za-z0-9_-]+" required></label><label>Jenis<select name="type"><option value="PERCENT">Diskon persen</option><option value="FIXED">Potongan rupiah</option><option value="FIXED_PRICE">Harga khusus</option><option value="BUNDLE">Paket / bundle</option><option value="BUY_X_GET_Y">Beli X gratis Y</option><option value="FREE_ITEM">Gratis item</option></select></label><label>Nilai<input name="value" type="number" min="0" required><small>Persen memakai angka 1–100; tipe lain memakai rupiah.</small></label><label>Minimum belanja<input name="minimumSpendRupiah" type="number" min="0" value="0"></label><label>Maksimum diskon<input name="capRupiah" type="number" min="0" placeholder="Opsional"></label><label>Prioritas<input name="priority" type="number" min="0" max="1000000" value="100" required></label><label>Stacking<select name="stackPolicy"><option value="EXCLUSIVE">Eksklusif</option></select></label><label>Mulai<input name="startsAt" type="datetime-local" value="${start}" required></label><label>Selesai<input name="endsAt" type="datetime-local" value="${end}"></label><fieldset><legend>Hari aktif</legend>${["Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu"].map((day,index)=>`<label><input name="weekdays" type="checkbox" value="${index+1}" checked>${day}</label>`).join("")}</fieldset><label><input name="allDay" type="checkbox" checked>Sepanjang hari</label><label>Jam mulai<input name="startLocal" type="time" value="00:00"></label><label>Jam selesai<input name="endLocal" type="time" value="23:59"></label><label>Beli X<input name="buyQuantity" type="number" min="1" value="1"></label><label>Gratis Y<input name="getQuantity" type="number" min="1" value="1"></label><label>Produk hadiah<select name="rewardProductId"><option value="">Tidak dipilih</option>${products.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label><fieldset><legend>Menu yang mendapat promo</legend><p>Tidak memilih menu berarti semua menu.</p>${products.map(item=>`<label><input name="eligibleProductIds" type="checkbox" value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</label>`).join("")}</fieldset><label>Kuota total<input name="quotaLimit" type="number" min="1" placeholder="Opsional"></label><label>Alasan<input name="reason" maxlength="160" required></label><label>Menu untuk preview<select name="previewProductId">${products.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></label><label>Jumlah preview<input name="previewQty" type="number" min="1" max="20" value="1"></label><button type="button" class="button button-secondary" data-promo-preview>Preview perhitungan</button><button class="button button-primary" ${enabled ? "" : "disabled"}>Simpan promo draft</button><p role="status"></p></form></dialog><div class="menu-v2-rules"><h3>Daftar promo</h3>${rules.length ? rules.map((rule) => `<article><div><strong>${escapeHtml(rule.name)}</strong><code>${escapeHtml(rule.code)}</code></div><span class="menu-v2-status">${escapeHtml(rule.effectiveState)}</span><p>${escapeHtml(rule.type)} · v${rule.version} · prioritas ${rule.priority}</p><div><button type="button" class="button button-secondary" data-promo-edit="${escapeHtml(rule.id)}">Edit draft</button>${rule.status !== "ACTIVE" && rule.status !== "ARCHIVED" ? `<button class="button button-primary" data-promotion-status="ACTIVE" data-promotion-id="${escapeHtml(rule.id)}">Aktifkan</button>` : ""}${rule.status === "ACTIVE" ? `<button class="button button-secondary" data-promotion-status="PAUSED" data-promotion-id="${escapeHtml(rule.id)}">Jeda</button>` : ""}${rule.status !== "ARCHIVED" ? `<button class="button button-ghost" data-promotion-status="ARCHIVED" data-promotion-id="${escapeHtml(rule.id)}">Arsipkan</button>` : ""}</div></article>`).join("") : "<p>Belum ada promo yang ditulis. Promo draft tidak memengaruhi checkout.</p>"}</div>${renderPromotionReport(state?.promotionReport)}</div>`;
}

async function createProduct(event) {
  if (event.target.id !== "menu-v2-product-create") return;
  event.preventDefault();
  const form = event.target; const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.product.create", payload: { name: values.name, priceRupiah: Number(values.priceRupiah), categoryId: values.categoryId, station: values.station, customizationProfile: "beverage", expectedVersion: state.catalogVersion, reason: values.reason } } });
    menuWorkspaceTab = "products"; await refresh(); announce("Produk disimpan sebagai draft.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
}

async function createCategory(event) {
  if (event.target.id !== "menu-v2-category-create") return;
  event.preventDefault();
  const form = event.target; const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.category.create"), payload: { name: values.name, expectedVersion: state.catalogVersion, reason: values.reason } } });
    menuWorkspaceTab = "categories"; await refresh(); announce("Kategori baru tersimpan.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
}

async function savePromotionDraft(event) {
  if (event.target.id !== "menu-v2-promotion") return;
  event.preventDefault();
  const form = event.target;
  try {
    const payload=promotionFormPayload(form);
    const count=Number(form.elements.batchCount?.value || 1),batch=payload.activationMode==='VOUCHER' && count>1 && !payload.promotionId;
    await request("/api/admin/actions", { method: "POST", csrf: true, body: batch ? {action:'catalog.workspace.voucher.batch.issue',payload:{count,prefix:payload.code,promotion:payload,expectedVersion:state.catalogVersion,reason:payload.reason}} : { action: menuDraftAction("catalog.promotion.upsert"), payload } });
    menuWorkspaceTab = "promotions"; await refresh(); announce("Promo disimpan sebagai draft. Checkout belum berubah.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
}

function promotionFormPayload(form) {
  const data=new FormData(form),v=Object.fromEntries(data),optional=value=>value===''||value==null?null:Number(value);
  return { promotionId:v.promotionId||undefined,code:v.code,name:v.name,type:v.type,activationMode:v.activationMode,
    value:['BUY_X_GET_Y','FREE_ITEM'].includes(v.type)?0:Number(v.value)*(v.type==='PERCENT'?100:1),
    minimumSpendRupiah:Number(v.minimumSpendRupiah||0),capRupiah:optional(v.capRupiah),priority:Number(v.priority),stackPolicy:'EXCLUSIVE',
    startsAt:jakartaDateTimeLocalToIso(v.startsAt),endsAt:v.endsAt?jakartaDateTimeLocalToIso(v.endsAt):null,
    schedule:{timezone:'Asia/Jakarta',weekdays:data.getAll('weekdays').map(Number),allDay:form.elements.allDay.checked,startLocal:v.startLocal,endLocal:v.endLocal},
    eligibleProductIds:data.getAll('eligibleProductIds'),buyQuantity:v.type==='BUY_X_GET_Y'?Number(v.buyQuantity):null,getQuantity:v.type==='BUY_X_GET_Y'?Number(v.getQuantity):null,
    rewardProductId:v.type==='FREE_ITEM'?v.rewardProductId||null:null,rewardQuantity:1,quotaLimit:v.activationMode==='VOUCHER'?1:optional(v.quotaLimit),perMemberLimit:optional(v.perMemberLimit),expectedVersion:state.catalogVersion,reason:v.reason };
}

function updatePromotionFields(form) {
  const type=form.elements.type.value;
  if(form.elements.batchCount){const enabled=state.actor.role==='owner' && form.elements.activationMode.value==='VOUCHER' && !form.elements.promotionId.value;form.elements.batchCount.disabled=!enabled;form.elements.batchCount.closest('label').hidden=!enabled;}
  for(const name of ['buyQuantity','getQuantity','rewardProductId']) {const show=name==='rewardProductId'?type==='FREE_ITEM':type==='BUY_X_GET_Y';form.elements[name].closest('label').hidden=!show;form.elements[name].disabled=!show;}
  form.elements.value.closest('label').hidden=['BUY_X_GET_Y','FREE_ITEM'].includes(type);form.elements.value.disabled=['BUY_X_GET_Y','FREE_ITEM'].includes(type);
  form.elements.quotaLimit.disabled=form.elements.activationMode.value==='VOUCHER';if(form.elements.quotaLimit.disabled)form.elements.quotaLimit.value='1';
  for(const name of ['startLocal','endLocal']){form.elements[name].disabled=form.elements.allDay.checked;form.elements[name].closest('label').hidden=form.elements.allDay.checked;}
}

document.addEventListener('change',event=>{if(event.target.closest('#menu-v2-promotion'))updatePromotionFields(event.target.closest('form'));});

function renderPromotionReport(report) {
  if(!report)return '';
  return `${renderDiscountApprovals()}${renderVoucherBatches()}<section class="menu-v2-rules"><h3>Pemakaian promo & diskon</h3><p>${escapeHtml(report.basis)}</p><form id="promotion-report-filter" class="menu-v2-form"><label>Dari tanggal<input name="from" type="date" value="${escapeHtml(report.from)}"></label><label>Sampai tanggal<input name="to" type="date" value="${escapeHtml(report.to)}"></label><button type="submit" class="button button-secondary">Tampilkan laporan</button><p role="status"></p></form>${report.groups.length?report.groups.map(group=>`<article><strong>${escapeHtml(group.name??group.source)}</strong><p>${group.paidCount} transaksi dibayar · ${group.pendingCount} menunggu · ${group.refundedCount} refund</p><p>Diskon tercatat ${rupiah(group.discountRupiah)} · diskon transaksi refund ${rupiah(group.refundedDiscountRupiah)} · penerimaan neto termasuk pajak/layanan ${rupiah(group.netSalesRupiah)}</p><p>Margin sebelum biaya operasional: ${group.grossProfitRupiah===null?"Belum dapat dihitung · lengkapi HPP":rupiah(group.grossProfitRupiah)}</p></article>`).join(''):'<p>Belum ada transaksi dengan rincian promo pada versi ini.</p>'}${report.legacyDiscountOrderCount?`<p>${report.legacyDiscountOrderCount} transaksi lama belum memiliki rincian sumber diskon; tidak direkayasa menjadi promo tertentu.</p>`:''}${report.manualDiscounts.map(item=>`<p>${escapeHtml(item.orderNumber)} · ${rupiah(item.amountRupiah)} · ${escapeHtml(item.actorId)} · ${escapeHtml(item.reason)} · ${escapeHtml(item.status)}</p>`).join('')}</section>`;
}

function renderDiscountApprovals(){
  const approvals=state.discountApprovals;if(!approvals)return '';
  if(approvals.available===false)return '<section class="menu-v2-rules"><h3>Approval diskon</h3><p role="status">Approval diskon belum tersedia pada backend ini. Diskon staf tetap diblokir; katalog dan pengaturan lain tetap dapat digunakan.</p></section>';
  return `<section class="menu-v2-rules"><h3>Batas & persetujuan diskon staf</h3><form id="cashier-discount-limit" class="menu-v2-form"><label>Batas tanpa persetujuan per tagihan (Rp)<input name="staffLimitRupiah" type="number" min="0" max="100000000" step="1" value="${approvals.staffLimitRupiah}" required></label><label>Alasan pengaturan<input name="reason" maxlength="160" required></label><button class="button button-primary">Simpan batas staf</button><p role="status"></p></form>${approvals.requests.filter(item=>item.status==='PENDING').map(item=>`<article><strong>${escapeHtml(item.actorId)} · ${rupiah(item.amountRupiah)}</strong><p>${escapeHtml(item.items.map(line=>`${line.qty} × ${line.productNameSnapshot}`).join(' · '))}</p><p>${escapeHtml(item.manualDiscount.reason)} · total setelah diskon ${rupiah(item.totalRupiah)}</p><button type="button" class="button button-primary" data-discount-approve="${escapeHtml(item.requestId)}">Setujui diskon pesanan ini</button></article>`).join('')||'<p>Tidak ada permintaan diskon yang menunggu persetujuan.</p>'}<p>Persetujuan sekali pakai, berlaku 15 menit, dan hanya untuk staf serta isi pesanan yang diperiksa.</p></section>`;
}
function renderVoucherBatches(){
  if(state.actor.role!=='owner')return '';
  const batches=new Map();for(const rule of state.promotionConfiguration?.rules??[]){if(!rule.campaignId)continue;const batch=batches.get(rule.campaignId)??{name:rule.name,count:0,perMemberLimit:rule.perMemberLimit};batch.count++;batches.set(rule.campaignId,batch);}
  return [...batches].map(([id,batch])=>`<article><strong>${escapeHtml(batch.name)} · ${batch.count} kode unik</strong><p>Batas per Member: ${batch.perMemberLimit??'Tidak dibatasi'} · satu kali per kode. Perubahan tetap draft sampai dipublikasikan.</p>${[['ACTIVE','Aktifkan batch'],['PAUSED','Jeda batch'],['ARCHIVED','Arsipkan batch']].map(([status,label])=>`<button class="button button-secondary" type="button" data-promotion-status="${status}" data-voucher-campaign="${escapeHtml(id)}">${label}</button>`).join('')}</article>`).join('');
}
async function saveDiscountLimit(event){
  if(event.target.id!=='cashier-discount-limit')return;event.preventDefault();
  const values=Object.fromEntries(new FormData(event.target));
  try{await request('/api/admin/actions',{method:'POST',csrf:true,body:{action:'catalog.discount_limit.update',payload:{staffLimitRupiah:Number(values.staffLimitRupiah),reason:values.reason,expectedVersion:state.catalogVersion}}});await refresh();announce('Batas diskon staf tersimpan.');}
  catch(error){event.target.querySelector('[role=status]').textContent=error.message;}
}

async function filterPromotionReport(event) {
  if(event.target.id!=="promotion-report-filter")return;
  event.preventDefault();const v=Object.fromEntries(new FormData(event.target));
  try{state.promotionReport=await request('/api/admin/promotion-report?'+new URLSearchParams(v));render();}
  catch(error){event.target.querySelector('[role=status]').textContent=error.message;}
}

function dateTimeLocalValue(value, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function jakartaDateTimeLocalToIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Waktu promo tidak valid.");
  return new Date(`${value}:00+07:00`).toISOString();
}

async function changePromotionStatus(button) {
  if (!state.featureFlags?.promoEngineV1) return;
  const reason = button.dataset.promotionStatus === "ACTIVE" ? "Aktivasi promo oleh Owner" : button.dataset.promotionStatus === "PAUSED" ? "Promo dijeda oleh Owner" : "Promo diarsipkan oleh Owner";
  button.disabled = true;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: button.dataset.voucherCampaign ? 'catalog.workspace.voucher.batch.status' : menuDraftAction("catalog.promotion.status"), payload: { promotionId: button.dataset.promotionId, campaignId:button.dataset.voucherCampaign, status: button.dataset.promotionStatus, expectedVersion: state.catalogVersion, reason } } });
    menuWorkspaceTab = "promotions"; await refresh(); announce("Status promo diperbarui.");
  } catch (error) { announce(error.message, true); button.disabled = false; }
}

async function saveEsbCatalogDraft(event) {
  if (event.target.id !== "esb-catalog-draft") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const products = state.catalog.flatMap((category) => category.products).filter((product) => product.status === "active");
  const payload = {
    code: values.code,
    name: values.name,
    validFrom: new Date(values.validFrom).toISOString(),
    reason: values.reason,
    operationKey: `catalog-draft-${crypto.randomUUID()}`,
    policy: {
      timezone: state.context.timezone,
      taxRateBps: Number(values.taxRateBps),
      serviceRateBps: Number(values.serviceRateBps),
      priceIncludesTax: values.priceIncludesTax === "on",
      priceIncludesService: values.priceIncludesService === "on",
      serviceTaxable: values.serviceTaxable === "on",
      taxDiscountTiming: values.taxDiscountTiming,
      roundingMode: values.roundingMode,
      roundingStepRupiah: Number(values.roundingStepRupiah),
    },
    entries: products.map((product) => ({
      productReference: product.id,
      productName: product.name,
      priceRupiah: product.priceRupiah,
      freePriceEnabled: false,
      minimumFreePriceRupiah: product.priceRupiah,
      maximumFreePriceRupiah: product.priceRupiah,
      posEnabled: product.available !== false,
    })),
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "esb.catalog.draft.create", payload } });
    await refresh();
    announce("Draft price book dibuat dari katalog server. Tinjau hash lalu publish sebagai versi immutable.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = error.message;
  } finally { button.disabled = false; }
}

async function publishEsbCatalog(button) {
  if (button.disabled) return;
  const reason = window.prompt("Alasan publish versi harga ini?");
  if (!reason?.trim()) return;
  button.disabled = true;
  try {
    await request("/api/admin/actions", {
      method: "POST", csrf: true,
      body: { action: "esb.catalog.version.publish", payload: {
        versionId: button.dataset.esbCatalogPublish,
        expectedDraftHash: button.dataset.draftHash,
        operationKey: `catalog-publish-${crypto.randomUUID()}`,
        reason: reason.trim(),
      } },
    });
    await refresh();
    announce("Versi harga dipublish dan ditautkan ke outlet. Histori versi sebelumnya tetap immutable.");
  } catch (error) { announce(error.message, true); }
  finally { button.disabled = false; }
}

function renderEsbCatalogWorkspace(esbCatalog, products) {
  if (!esbCatalog || esbCatalog.mode === "UNAVAILABLE") return `<section class="admin-ops-card"><p class="eyebrow">Price book runtime</p><h2>Belum tersedia</h2><p>Runtime versioned catalog belum dipasang. Checkout tetap memakai katalog legacy.</p></section>`;
  const drafts = esbCatalog.versions.filter((version) => version.status === "DRAFT");
  const versions = esbCatalog.versions.map((version) => `<li><strong>${escapeHtml(version.code)} v${version.version}</strong> · ${escapeHtml(version.status)} · ${version.entryCount} menu${version.assigned ? ` · AKTIF OUTLET r${version.assignmentRevision}` : ""}${version.status === "DRAFT" && version.draftHash ? ` <button class="button button-primary" type="button" data-esb-catalog-publish="${escapeHtml(version.versionId)}" data-draft-hash="${escapeHtml(version.draftHash)}">Publish versi ${version.version}</button>` : ""}</li>`).join("");
  const localNow = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return `<section class="admin-ops-card" aria-labelledby="esb-catalog-title"><p class="eyebrow">Price book authoritative · ${escapeHtml(esbCatalog.runtimeGuard)}</p><h2 id="esb-catalog-title">Versi harga per outlet</h2><p>Draft menyalin ${products.filter((product) => product.status === "active").length} menu aktif dari katalog server. Publish membuat snapshot immutable; checkout DUAL_WRITE tetap OFF sampai release gate mengaktifkannya.</p>
    <form id="esb-catalog-draft"><label>Kode price book<input name="code" value="DEFAULT_POS" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]+" required></label><label>Nama price book<input name="name" value="Harga POS Default" maxlength="120" required></label><label>Berlaku mulai<input name="validFrom" type="datetime-local" value="${localNow}" required></label><label>Pajak (basis points)<input name="taxRateBps" type="number" min="0" max="10000" step="1" value="0" required></label><label>Layanan (basis points)<input name="serviceRateBps" type="number" min="0" max="10000" step="1" value="0" required></label><label><input name="priceIncludesTax" type="checkbox"> Harga termasuk pajak</label><label><input name="priceIncludesService" type="checkbox"> Harga termasuk layanan</label><label><input name="serviceTaxable" type="checkbox"> Layanan dikenai pajak</label><label>Waktu diskon pajak<select name="taxDiscountTiming"><option value="AFTER_DISCOUNT">Setelah diskon</option><option value="BEFORE_DISCOUNT">Sebelum diskon</option></select></label><label>Pembulatan<select name="roundingMode"><option value="NONE">Tanpa pembulatan</option><option value="NEAREST_HALF_UP">Terdekat · half up</option><option value="UP">Ke atas</option><option value="DOWN">Ke bawah</option></select></label><label>Langkah pembulatan (Rp)<input name="roundingStepRupiah" type="number" min="1" max="100000" step="1" value="1" required></label><label>Alasan pembuatan<input name="reason" maxlength="240" required></label><p role="status"></p><button class="button button-primary" type="submit" ${drafts.length ? "disabled" : ""}>Buat draft immutable</button></form>
    <h3>Riwayat versi</h3>${versions ? `<ul>${versions}</ul>` : "<p>Belum ada price book versioned.</p>"}</section>`;
}

function updateCatalogView(event) {
  if (event.target.id === "menu-b7-search") { menuProductQuery = event.target.value; menuPage = 1; const position = event.target.selectionStart; render(); requestAnimationFrame(() => { const input = content.querySelector("#menu-b7-search"); input?.focus(); input?.setSelectionRange(position, position); }); return; }
  if (event.target.id === "menu-b7-category") { menuCategoryFilter = event.target.value; menuPage = 1; render(); return; }
  if (event.target.id === "menu-b7-station") { menuStationFilter = event.target.value; menuPage = 1; render(); return; }
  if (event.target.id === "menu-b7-status") { menuStatusFilter = event.target.value; menuPage = 1; render(); return; }
  if (event.target.matches("[data-menu-select]")) { if (event.target.checked) menuSelected.add(event.target.dataset.menuSelect); else menuSelected.delete(event.target.dataset.menuSelect); render(); return; }
  if (event.target.matches("[data-menu-select-all]")) {
    const visible = [...content.querySelectorAll("[data-menu-select]")].map((input) => input.dataset.menuSelect);
    for (const id of visible) event.target.checked ? menuSelected.add(id) : menuSelected.delete(id);
    render(); return;
  }
  const purchaseOrderForm = event.target.closest?.(".hpp-po-lines-form");
  if (purchaseOrderForm) updatePurchaseOrderDraft(purchaseOrderForm);
  const purchaseOrderReceiptForm = event.target.closest?.(".hpp-po-receive-form");
  if (purchaseOrderReceiptForm) updatePurchaseOrderReceiptForm(purchaseOrderReceiptForm);
  const purchaseInvoiceForm = event.target.closest?.(".hpp-invoice-form");
  if (purchaseInvoiceForm) updatePurchaseInvoiceDraft(purchaseInvoiceForm);
  const countForm = event.target.closest?.("#hpp-full-inventory-count");
  if (countForm?.dataset.reviewed === "true") {
    countForm.dataset.reviewed = "false";
    countForm.querySelector("button[type='submit']").textContent = "Review lengkap & selesaikan count";
    countForm.querySelector("[role='status']").textContent = "Data berubah. Review ulang seluruh hasil fisik sebelum konfirmasi.";
  }
  if (event.target.name === "productId") {
    const product = state.catalog.flatMap((category) => category.products).find((item) => item.id === event.target.value);
    const form = content.querySelector("#product-editor");
    if (product) {
      form.elements.name.value = product.name; form.elements.priceRupiah.value = product.priceRupiah;
      form.elements.categoryId.value = product.categoryId; form.elements.station.value = product.station;
      form.elements.status.value = product.status; form.elements.sortRank.value = product.sortRank ?? 0;
    }
  }
  if (event.target.name === "ingredientId" && event.target.closest("#hpp-ingredient-editor")) {
    const ingredient = state.hpp.ingredients.find((item) => item.id === event.target.value);
    const form = content.querySelector("#hpp-ingredient-editor");
    form.elements.name.value = ingredient?.name ?? "";
    form.elements.baseUnit.value = ingredient?.baseUnit ?? "gram";
    form.elements.costPerUnitRupiah.value = ingredient?.costPerUnitRupiah ?? "";
  }
  if (event.target.id === "admin-catalog-search") { catalogQuery = event.target.value; applyCatalogFilters(); }
}

async function saveProduct(event) {
  if (event.target.id !== "product-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.priceRupiah = Number(payload.priceRupiah);
  payload.sortRank = Number(payload.sortRank);
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.product.update", payload } });
    await refresh();
    announce("Nama dan harga menu tersimpan. Pesanan sebelumnya tetap tidak berubah.");
  } catch (error) {
    form.querySelector("#product-editor-status").textContent = error.code === "catalog_version_conflict" ? "Katalog sudah berubah. Muat ulang halaman dan tinjau harga terbaru sebelum menyimpan lagi." : error.message;
  } finally { button.disabled = false; }
}

async function saveOrdering(event) {
  if (event.target.id !== "ordering-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.paused = payload.paused === "true";
  payload.enforceHours = payload.enforceHours === "true";
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.ordering.update"), payload } });
    await refresh();
    announce("Pengaturan layanan tersimpan. Pesanan yang sudah masuk tetap diproses.");
  } catch (error) {
    form.querySelector("#ordering-editor-status").textContent = error.code === "catalog_version_conflict" ? "Katalog sudah berubah. Muat ulang dan tinjau pengaturan terbaru." : error.message;
  } finally { button.disabled = false; }
}

async function saveModifierGroup(event) {
  if (!event.target.matches(".modifier-group-editor")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  if (!payload.groupId) delete payload.groupId;
  payload.required = payload.required === "true";
  payload.active = payload.active === "true";
  payload.min = Number(payload.min);
  payload.max = Number(payload.max);
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.modifier.group.upsert"), payload } });
    await refresh();
    announce(payload.groupId ? "Grup modifier diperbarui." : "Grup modifier baru dibuat.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
  finally { button.disabled = false; }
}

async function savePricingPolicy(event) {
  if (event.target.id !== "pricing-policy-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    taxEnabled: values.taxEnabled === "true",
    taxRateBps: Math.round(Number(values.taxPercent) * 100),
    serviceEnabled: values.serviceEnabled === "true",
    serviceRateBps: Math.round(Number(values.servicePercent) * 100),
    serviceTaxable: values.serviceTaxable === "true",
    taxDiscountTiming: values.taxDiscountTiming,
    roundingMode: values.roundingMode,
    roundingStepRupiah: Number(values.roundingStepRupiah),
    reason: values.reason,
    expectedVersion: state.catalogVersion,
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.pricing.update", payload } });
    await refresh();
    announce("Kebijakan pajak, service, dan pembulatan tersimpan untuk pesanan baru.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = error.code === "catalog_version_conflict" ? "Katalog sudah berubah. Muat ulang dan tinjau kebijakan terbaru." : error.message;
  } finally { button.disabled = false; }
}

function renderPricingWorkspace(configuration = {}) {
  const settings = configuration.settings || {};
  const selected = (actual, expected) => actual === expected ? "selected" : "";
  const taxPercent = Number(settings.taxRateBps || 0) / 100;
  const servicePercent = Number(settings.serviceRateBps || 0) / 100;
  const audit = configuration.audit || [];
  return `<section class="admin-ops-card admin-pricing-workspace" aria-labelledby="pricing-policy-title"><div class="section-heading"><div><p class="eyebrow">Kebijakan transaksi · server-owned</p><h2 id="pricing-policy-title">Pajak, service, dan pembulatan</h2><p>Checkout Kiosk dan Cashier selalu menghitung ulang dari kebijakan versi aktif. Nilai awal aman tetap OFF sampai status usaha dan ketentuan wilayah dikonfirmasi Owner.</p></div><span class="admin-count">v${state.catalogVersion}</span></div>
    <form id="pricing-policy-editor" class="admin-modifier-form">
      <label>Pajak transaksi<select name="taxEnabled"><option value="false" ${selected(settings.taxEnabled, false)}>OFF · tidak dipungut</option><option value="true" ${selected(settings.taxEnabled, true)}>ON · aktif untuk pesanan baru</option></select></label>
      <label>Tarif pajak (%)<input name="taxPercent" type="number" min="0" max="100" step="0.01" required value="${taxPercent}"><small>Contoh acuan PBJT DKI 10%; jangan aktifkan sebelum status usaha dan wilayah dipastikan.</small></label>
      <label>Service charge<select name="serviceEnabled"><option value="false" ${selected(settings.serviceEnabled, false)}>OFF · tidak dipungut</option><option value="true" ${selected(settings.serviceEnabled, true)}>ON · aktif untuk pesanan baru</option></select></label>
      <label>Tarif service (%)<input name="servicePercent" type="number" min="0" max="100" step="0.01" required value="${servicePercent}"></label>
      <label>Service masuk dasar pajak<select name="serviceTaxable"><option value="false" ${selected(settings.serviceTaxable, false)}>Tidak</option><option value="true" ${selected(settings.serviceTaxable, true)}>Ya</option></select></label>
      <label>Waktu hitung pajak<select name="taxDiscountTiming"><option value="AFTER_DISCOUNT" ${selected(settings.taxDiscountTiming, "AFTER_DISCOUNT")}>Setelah diskon</option><option value="BEFORE_DISCOUNT" ${selected(settings.taxDiscountTiming, "BEFORE_DISCOUNT")}>Sebelum diskon</option></select></label>
      <label>Metode pembulatan<select name="roundingMode"><option value="NONE" ${selected(settings.roundingMode, "NONE")}>Tanpa pembulatan</option><option value="NEAREST_HALF_UP" ${selected(settings.roundingMode, "NEAREST_HALF_UP")}>Ke nilai terdekat</option><option value="DOWN" ${selected(settings.roundingMode, "DOWN")}>Ke bawah</option><option value="UP" ${selected(settings.roundingMode, "UP")}>Ke atas</option></select></label>
      <label>Satuan pembulatan<select name="roundingStepRupiah">${[1, 10, 50, 100, 500, 1000].map((step) => `<option value="${step}" ${selected(settings.roundingStepRupiah, step)}>${rupiah(step)}</option>`).join("")}</select><small>Pilih Rp1 saat metode tanpa pembulatan.</small></label>
      <label class="admin-modifier-reason">Alasan perubahan<input name="reason" maxlength="160" required placeholder="Contoh: Konfigurasi PBJT outlet telah dikonfirmasi"></label>
      <p role="status"></p><button class="button button-primary" type="submit">Simpan kebijakan transaksi</button>
    </form>
    <h3>Riwayat kebijakan</h3>${audit.length ? `<ul class="admin-modifier-audit">${audit.map((entry) => `<li><strong>v${entry.version}</strong> Pajak ${entry.next.taxEnabled ? `${entry.next.taxRateBps / 100}%` : "OFF"} · Service ${entry.next.serviceEnabled ? `${entry.next.serviceRateBps / 100}%` : "OFF"} · ${escapeHtml(entry.reason)}</li>`).join("")}</ul>` : "<p>Belum ada perubahan. Default aman: pajak OFF, service OFF, tanpa pembulatan.</p>"}
  </section>`;
}

async function saveVariantGroup(event) {
  if (!event.target.matches(".variant-group-editor")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  if (!payload.groupId) delete payload.groupId;
  payload.required = payload.required === "true";
  payload.active = payload.active === "true";
  payload.min = Number(payload.min);
  payload.max = Number(payload.max);
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.variant.group.upsert"), payload } });
    await refresh();
    announce(payload.groupId ? "Grup varian diperbarui." : "Grup varian baru dibuat.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
  finally { button.disabled = false; }
}

async function saveVariantOption(event) {
  if (!event.target.matches(".variant-option-editor")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = new FormData(form);
  const payload = Object.fromEntries(values);
  if (!payload.optionId) delete payload.optionId;
  payload.priceDeltaRupiah = Number(payload.priceDeltaRupiah);
  payload.active = payload.active === "true";
  payload.productIds = values.getAll("productIds");
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.variant.option.upsert"), payload } });
    await refresh();
    announce(payload.optionId ? "Pilihan varian diperbarui." : "Pilihan varian baru dibuat.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
  finally { button.disabled = false; }
}

async function saveModifierOption(event) {
  if (!event.target.matches(".modifier-option-editor")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = new FormData(form);
  const payload = Object.fromEntries(values);
  if (!payload.optionId) delete payload.optionId;
  payload.priceDeltaRupiah = Number(payload.priceDeltaRupiah);
  payload.active = payload.active === "true";
  payload.productIds = values.getAll("productIds");
  payload.expectedVersion = state.catalogVersion;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: menuDraftAction("catalog.modifier.option.upsert"), payload } });
    await refresh();
    announce(payload.optionId ? "Pilihan modifier diperbarui." : "Pilihan modifier baru dibuat.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; }
  finally { button.disabled = false; }
}

function renderModifierWorkspace(configuration = {}, products = []) {
  const groups = configuration.groups || [];
  const productOptions = (selected = []) => products.map((product) => `<option value="${escapeHtml(product.id)}" ${selected.includes(product.id) ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("");
  const groupForm = (group = {}) => `<form class="modifier-group-editor admin-modifier-form"><input type="hidden" name="groupId" value="${escapeHtml(group.id || "")}"><label>Nama grup<input name="label" maxlength="60" required value="${escapeHtml(group.label || "")}" placeholder="Contoh: Pilihan susu"></label><label>Wajib dipilih<select name="required"><option value="false" ${!group.required ? "selected" : ""}>Opsional</option><option value="true" ${group.required ? "selected" : ""}>Wajib</option></select></label><label>Minimum<input name="min" type="number" min="0" max="8" value="${group.min ?? 0}" required></label><label>Maksimum<input name="max" type="number" min="1" max="8" value="${group.max ?? 1}" required></label><label>Status<select name="active"><option value="true" ${group.active !== false ? "selected" : ""}>Aktif</option><option value="false" ${group.active === false ? "selected" : ""}>Nonaktif</option></select></label><label class="admin-modifier-reason">Alasan<input name="reason" maxlength="160" required placeholder="Alasan perubahan"></label><p role="status"></p><button class="button button-primary" type="submit">${group.id ? "Simpan grup" : "Buat grup"}</button></form>`;
  const optionForm = (group, option = {}) => `<form class="modifier-option-editor admin-modifier-form"><input type="hidden" name="groupId" value="${escapeHtml(group.id)}"><input type="hidden" name="optionId" value="${escapeHtml(option.id || "")}"><label>Nama pilihan<input name="label" maxlength="60" required value="${escapeHtml(option.label || "")}" placeholder="Contoh: Oat Milk"></label><label>Tambahan harga<input name="priceDeltaRupiah" type="number" min="0" max="10000000" step="1" required value="${option.priceDeltaRupiah ?? 0}"></label><label>Status<select name="active"><option value="true" ${option.active !== false ? "selected" : ""}>Aktif</option><option value="false" ${option.active === false ? "selected" : ""}>Nonaktif</option></select></label><label>Cakupan menu<select name="productIds" multiple size="5" aria-label="Cakupan menu ${escapeHtml(option.label || "baru")}">${productOptions(option.productIds || [])}</select><small>Kosong berarti tersedia untuk semua menu yang dapat dimodifikasi.</small></label><label class="admin-modifier-reason">Alasan<input name="reason" maxlength="160" required placeholder="Alasan perubahan"></label><p role="status"></p><button class="button button-secondary" type="submit">${option.id ? "Simpan pilihan" : "Tambah pilihan"}</button></form>`;
  const cards = groups.map((group) => `<article class="admin-modifier-card"><header><div><span class="availability-badge">${group.active === false ? "NONAKTIF" : group.required ? "WAJIB" : "OPSIONAL"}</span><h3>${escapeHtml(group.label)}</h3><p>Pilih ${group.min}–${group.max} · ${group.options.length} opsi</p></div></header>${groupForm(group)}<div class="admin-modifier-options">${group.options.map((option) => optionForm(group, option)).join("")}${optionForm(group)}</div></article>`).join("");
  return `<section class="admin-ops-card admin-modifier-workspace"><div class="section-heading"><div><p class="eyebrow">Modifier & add-on</p><h2>Atur pilihan pelanggan dari sumber server</h2><p>Harga, batas pilihan, status, dan cakupan menu dikunci server. Perubahan hanya berlaku untuk pesanan baru.</p></div><span class="admin-count">${groups.length} GRUP</span></div><details class="admin-modifier-create"><summary>Buat grup modifier baru</summary>${groupForm()}</details><div class="admin-modifier-grid">${cards || "<p>Belum ada modifier. Buat grup pertama untuk mulai.</p>"}</div>${configuration.audit?.length ? `<h3>Riwayat modifier</h3><ul class="admin-modifier-audit">${configuration.audit.map((entry) => `<li><strong>${entry.type.endsWith("group.upserted") ? "Grup" : "Pilihan"}</strong> ${escapeHtml(entry.next?.label || entry.groupId)} · ${escapeHtml(entry.reason)} · v${entry.version}</li>`).join("")}</ul>` : ""}</section>`;
}

function renderVariantWorkspace(configuration = {}, products = []) {
  const groups = configuration.groups || [];
  const productOptions = (selected = []) => products.map((product) => `<option value="${escapeHtml(product.id)}" ${selected.includes(product.id) ? "selected" : ""}>${escapeHtml(product.name)}</option>`).join("");
  const groupForm = (group = {}) => `<form class="variant-group-editor admin-modifier-form"><input type="hidden" name="groupId" value="${escapeHtml(group.id || "")}"><label>Nama grup<input name="label" maxlength="60" required value="${escapeHtml(group.label || "")}" placeholder="Contoh: Ukuran minuman"></label><label>Wajib dipilih<select name="required"><option value="false" ${!group.required ? "selected" : ""}>Opsional</option><option value="true" ${group.required ? "selected" : ""}>Wajib</option></select></label><label>Minimum<input name="min" type="number" min="0" max="8" value="${group.min ?? 0}" required></label><label>Maksimum<input name="max" type="number" min="1" max="8" value="${group.max ?? 1}" required></label><label>Status<select name="active"><option value="true" ${group.active !== false ? "selected" : ""}>Aktif</option><option value="false" ${group.active === false ? "selected" : ""}>Nonaktif</option></select></label><label class="admin-modifier-reason">Alasan<input name="reason" maxlength="160" required placeholder="Alasan perubahan"></label><p role="status"></p><button class="button button-primary" type="submit">${group.id ? "Simpan grup" : "Buat grup"}</button></form>`;
  const optionForm = (group, option = {}) => `<form class="variant-option-editor admin-modifier-form"><input type="hidden" name="groupId" value="${escapeHtml(group.id)}"><input type="hidden" name="optionId" value="${escapeHtml(option.id || "")}"><label>Nama pilihan<input name="label" maxlength="60" required value="${escapeHtml(option.label || "")}" placeholder="Contoh: Large"></label><label>Tambahan harga<input name="priceDeltaRupiah" type="number" min="0" max="10000000" step="1" required value="${option.priceDeltaRupiah ?? 0}"></label><label>Status<select name="active"><option value="true" ${option.active !== false ? "selected" : ""}>Aktif</option><option value="false" ${option.active === false ? "selected" : ""}>Nonaktif</option></select></label><label>Cakupan menu<select name="productIds" multiple size="5" aria-label="Cakupan menu varian ${escapeHtml(option.label || "baru")}">${productOptions(option.productIds || [])}</select><small>Kosong berarti tersedia untuk semua menu yang dapat dikustomisasi.</small></label><label class="admin-modifier-reason">Alasan<input name="reason" maxlength="160" required placeholder="Alasan perubahan"></label><p role="status"></p><button class="button button-secondary" type="submit">${option.id ? "Simpan pilihan" : "Tambah pilihan"}</button></form>`;
  const cards = groups.map((group) => `<article class="admin-modifier-card"><header><div><span class="availability-badge">${group.active === false ? "NONAKTIF" : group.required ? "WAJIB" : "OPSIONAL"}</span><h3>${escapeHtml(group.label)}</h3><p>Pilih ${group.min}–${group.max} · ${group.options.length} opsi</p></div></header>${groupForm(group)}<div class="admin-modifier-options">${group.options.map((option) => optionForm(group, option)).join("")}${optionForm(group)}</div></article>`).join("");
  return `<section class="admin-ops-card admin-modifier-workspace admin-variant-workspace"><div class="section-heading"><div><p class="eyebrow">Varian produk</p><h2>Atur suhu, ukuran, dan pilihan utama</h2><p>Varian membentuk versi produk yang dipilih pelanggan. Harga, batas pilihan, status, dan cakupan menu selalu divalidasi server.</p></div><span class="admin-count">${groups.length} GRUP</span></div><details class="admin-modifier-create admin-variant-create"><summary>Buat grup varian baru</summary>${groupForm()}</details><div class="admin-modifier-grid">${cards || "<p>Belum ada varian. Buat grup pertama untuk mulai.</p>"}</div>${configuration.audit?.length ? `<h3>Riwayat varian</h3><ul class="admin-modifier-audit">${configuration.audit.map((entry) => `<li><strong>${entry.type.endsWith("group.upserted") ? "Grup" : "Pilihan"}</strong> ${escapeHtml(entry.next?.label || entry.groupId)} · ${escapeHtml(entry.reason)} · v${entry.version}</li>`).join("")}</ul>` : ""}</section>`;
}

async function saveHppIngredient(event) {
  if (event.target.id !== "hpp-ingredient-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  if (!payload.ingredientId) delete payload.ingredientId;
  payload.costPerUnitRupiah = payload.costPerUnitRupiah === "" ? null : Number(payload.costPerUnitRupiah);
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.ingredient.upsert", payload } });
    await refresh();
    announce("Master bahan dan biaya satuan tersimpan.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function saveHppSupplier(event) {
  if (event.target.id !== "hpp-supplier-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.leadTimeDays = Number(payload.leadTimeDays);
  payload.active = payload.active === "true";
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.supplier.upsert", payload } });
    await refresh();
    announce("Supplier tersimpan sebagai master purchasing yang dapat digunakan ulang.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function saveHppPurchaseOrder(event) {
  if (event.target.id !== "hpp-purchase-order-create") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  form.dataset.poSubmitting = "true";
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    idempotencyKey: values.idempotencyKey, supplierId: values.supplierId, expectedDate: values.expectedDate,
    reason: values.reason, expectedVersion: state.hpp.version,
    lines: collectPurchaseOrderLines(form),
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_order.create", payload } });
    await refresh();
    announce("Purchase order tersimpan sebagai rencana internal. Belum dikirim ke supplier.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { delete form.dataset.poSubmitting; button.disabled = false; if (form.isConnected) updatePurchaseOrderDraft(form); }
}

async function amendHppPurchaseOrder(event) {
  if (!event.target.classList.contains("hpp-po-amend-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  form.dataset.poSubmitting = "true";
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    idempotencyKey: values.idempotencyKey, purchaseOrderId: values.purchaseOrderId,
    supplierId: values.supplierId, expectedDate: values.expectedDate, reason: values.reason,
    expectedVersion: state.hpp.version,
    lines: collectPurchaseOrderLines(form),
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_order.amend", payload } });
    await refresh();
    announce("Revisi PO tersimpan. Belum ada stok yang berubah dan supplier tidak dihubungi otomatis.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { delete form.dataset.poSubmitting; button.disabled = false; if (form.isConnected) updatePurchaseOrderDraft(form); }
}

async function cancelHppPurchaseOrder(event) {
  if (!event.target.classList.contains("hpp-po-cancel-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = { idempotencyKey: values.idempotencyKey, purchaseOrderId: values.purchaseOrderId, reason: values.reason, expectedVersion: state.hpp.version };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_order.cancel", payload } });
    await refresh();
    announce("PO dibatalkan. Sisa pesanan ditutup; stok yang sudah diterima tetap tercatat.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function saveHppPurchaseOrderReceipt(event) {
  if (!event.target.classList.contains("hpp-po-receive-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  form.dataset.submitting = "true";
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const purchaseQuantity = Number(values.purchaseQuantity || 0);
  const rejectedPurchaseQuantity = Number(values.rejectedPurchaseQuantity || 0);
  const remaining = Number(values.remainingPurchaseQuantity);
  if (purchaseQuantity + rejectedPurchaseQuantity <= 0 || purchaseQuantity + rejectedPurchaseQuantity > remaining) {
    form.querySelector("[role='status']").textContent = `Jumlah diterima + ditolak harus 0,001–${formatQuantity(remaining)}.`;
    delete form.dataset.submitting;
    button.disabled = false;
    return;
  }
  const payload = {
    idempotencyKey: values.idempotencyKey,
    purchaseOrderId: values.purchaseOrderId,
    reason: values.reason,
    expectedVersion: state.hpp.version,
    lines: [{ ingredientId: values.ingredientId, purchaseQuantity, rejectedPurchaseQuantity, ...(rejectedPurchaseQuantity > 0 ? { rejectionReason: values.rejectionReason } : {}) }],
    additionalFees: Number(values.additionalFeeRupiah || 0) > 0 ? [{ type: values.additionalFeeType, amountRupiah: Number(values.additionalFeeRupiah) }] : [],
  };
  try {
    const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_order.receive", payload } });
    await refresh();
    announce(result.purchaseOrder.status === "RECEIVED" ? "Penerimaan PO selesai. Barang baik masuk stok; selisih dan biaya tercatat." : "Penerimaan PO tersimpan. Barang baik masuk stok dan sisa pesanan tetap terbuka.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { delete form.dataset.submitting; button.disabled = false; }
}

async function saveHppPurchaseInvoice(event) {
  if (!event.target.classList.contains("hpp-invoice-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const lines = [...form.querySelectorAll("[data-invoice-line]")].map((row) => ({
    ingredientId: row.dataset.ingredientId,
    invoiceQuantity: Number(row.querySelector("[name='invoiceQuantity']").value),
    unitPriceRupiah: Number(row.querySelector("[name='unitPriceRupiah']").value),
  }));
  const feeAmount = Number(values.additionalFeeRupiah || 0);
  const totalInvoiceRupiah = lines.reduce((sum, line) => sum + Math.round(line.invoiceQuantity * line.unitPriceRupiah), 0) + feeAmount;
  const payload = {
    idempotencyKey: values.idempotencyKey, purchaseOrderId: values.purchaseOrderId,
    invoiceNumber: values.invoiceNumber, invoiceDate: values.invoiceDate, dueDate: values.dueDate,
    lines, additionalFees: feeAmount > 0 ? [{ type: values.additionalFeeType, amountRupiah: feeAmount }] : [],
    totalInvoiceRupiah, expectedVersion: state.hpp.version, reason: values.reason,
  };
  try {
    const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.match", payload } });
    await refresh();
    announce(result.invoice.matchStatus === "MATCHED" ? "Invoice cocok dengan PO dan penerimaan. Siap masuk proses approval, belum dibayar." : "Invoice tersimpan sebagai exception dan diblokir dari proses pembayaran.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function postHppPurchaseInvoice(event) {
  if (!event.target.classList.contains("hpp-invoice-post-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.post", payload: { idempotencyKey: values.idempotencyKey, purchaseInvoiceId: values.purchaseInvoiceId, expectedVersion: state.hpp.version, reason: values.reason } } });
    await refresh();
    announce("Invoice diposting sebagai utang AP terbuka. Belum ada pembayaran yang dibuat.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function recordHppPurchaseInvoicePayment(event) {
  if (!event.target.classList.contains("hpp-invoice-payment-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    idempotencyKey: values.idempotencyKey,
    purchaseInvoiceId: values.purchaseInvoiceId,
    paidDate: values.paidDate,
    amountRupiah: Number(values.amountRupiah),
    method: values.method,
    reference: values.reference,
    expectedVersion: state.hpp.version,
    reason: values.reason,
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.payment.record", payload } });
    await refresh();
    announce("Pembayaran supplier dicatat sebagai settlement internal. Tidak ada transfer bank atau API payment yang dijalankan.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function postHppPurchaseInvoiceCredit(event) {
  if (!event.target.classList.contains("hpp-credit-post-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.credit.post", payload: { idempotencyKey: values.idempotencyKey, creditMemoId: values.creditMemoId, expectedVersion: state.hpp.version, reason: values.reason } } });
    await refresh();
    announce("Credit memo diposting untuk mengurangi utang AP. Stok dan pembayaran tidak berubah.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function decideHppPurchaseInvoiceCreditReversal(event) {
  if (!event.target.classList.contains("hpp-credit-reversal-form")) return;
  event.preventDefault();
  const form = event.target;
  const buttons = [...form.querySelectorAll("button[type='submit']")];
  if (buttons.some((button) => button.disabled)) return;
  buttons.forEach((button) => { button.disabled = true; });
  const values = Object.fromEntries(new FormData(form));
  const decision = event.submitter?.value;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.credit_reversal.decide", payload: { idempotencyKey: values.idempotencyKey, creditMemoId: values.creditMemoId, decision, expectedVersion: state.hpp.version, reason: values.reason } } });
    await refresh();
    announce(decision === "APPROVE" ? "Reversal disetujui. Outstanding dipulihkan; stok dan pembayaran tidak berubah." : "Reversal ditolak. Credit memo dan outstanding tetap berlaku.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

async function saveHppSupplierReturn(event) {
  if (!event.target.classList.contains("hpp-supplier-return-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.supplier_return.create", payload: { idempotencyKey: values.idempotencyKey, purchaseReceiptId: values.purchaseReceiptId, returnReference: values.returnReference, disposition: values.disposition, lines: [{ ingredientId: values.ingredientId, returnPurchaseQuantity: Number(values.returnPurchaseQuantity) }], expectedVersion: state.hpp.version, reason: values.reason } } });
    await refresh();
    announce(values.disposition === "REPLACEMENT_EXPECTED" ? "Retur dikirim dan stok dikurangi. Menunggu replacement diterima." : "Retur dikirim dan stok dikurangi. Credit supplier masih harus diterima dan diproses Finance.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function receiveHppSupplierReplacement(event) {
  if (!event.target.classList.contains("hpp-supplier-replacement-form")) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.supplier_replacement.receive", payload: { idempotencyKey: values.idempotencyKey, supplierReturnId: values.supplierReturnId, receiptReference: values.receiptReference, expectedVersion: state.hpp.version, reason: values.reason } } });
    await refresh();
    announce("Replacement diterima dan stok/nilai persediaan dipulihkan. Tidak ada pembayaran baru.");
  } catch (error) { form.querySelector("[role='status']").textContent = hppErrorMessage(error); }
  finally { button.disabled = false; }
}

async function saveHppPurchase(event) {
  if (event.target.id !== "hpp-purchase-receipt") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    idempotencyKey: values.idempotencyKey,
    supplierName: values.supplierName,
    reason: values.reason,
    expectedVersion: state.hpp.version,
    lines: [{
      ingredientId: values.ingredientId,
      purchaseUnitLabel: values.purchaseUnitLabel,
      purchaseQuantity: Number(values.purchaseQuantity),
      baseUnitsPerPurchaseUnit: Number(values.baseUnitsPerPurchaseUnit),
      totalCostRupiah: Number(values.totalCostRupiah),
    }],
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase.receive", payload } });
    await refresh();
    announce("Penerimaan tersimpan. Stok, nilai persediaan, dan moving-average HPP diperbarui.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function saveHppInventoryCount(event) {
  if (event.target.id !== "hpp-full-inventory-count") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  if (form.dataset.reviewed !== "true") {
    if (!form.reportValidity()) return;
    form.dataset.reviewed = "true";
    form.querySelector("[role='status']").textContent = `Review ${form.querySelectorAll("[data-count-ingredient]").length} hasil fisik. Tekan sekali lagi untuk mengunci sesi; tindakan ini tidak dapat diedit.`;
    button.textContent = "Konfirmasi & selesaikan full count";
    button.focus();
    return;
  }
  button.disabled = true;
  const values = new FormData(form);
  const payload = {
    idempotencyKey: values.get("idempotencyKey"),
    reason: values.get("reason"),
    expectedVersion: state.hpp.version,
    lines: [...form.querySelectorAll("[data-count-ingredient]")].map((input) => ({ ingredientId: input.dataset.countIngredient, quantityBase: Number(input.value) })),
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.inventory.count.complete", payload } });
    await refresh();
    announce("Full count selesai. Semua saldo bahan direkonsiliasi dalam satu sesi audit.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function saveHppInventoryPeriod(event) {
  if (event.target.id !== "hpp-inventory-period-close") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = {
    idempotencyKey: values.idempotencyKey,
    openingCountId: values.openingCountId,
    closingCountId: values.closingCountId,
    reason: values.reason,
    expectedVersion: state.hpp.version,
  };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.inventory.period.close", payload } });
    await refresh();
    announce("Periode inventory ditutup. Pasangan count dan batas versi kini terkunci untuk audit.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function saveHppInventoryMovement(event) {
  if (event.target.id !== "hpp-inventory-movement") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  const payload = { idempotencyKey: values.idempotencyKey, movementType: values.movementType, ingredientId: values.ingredientId, quantityBase: Number(values.quantityBase), reason: values.reason, expectedVersion: state.hpp.version };
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.inventory.record", payload } });
    await refresh();
    announce(values.movementType === "CYCLE_COUNT" ? "Cycle count tersimpan. Saldo fisik dan nilai persediaan direkonsiliasi." : "Pengurangan stok tersimpan lengkap dengan alasan dan nilai HPP.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function saveHppRecipe(event) {
  if (event.target.id !== "hpp-recipe-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.qty = Number(payload.qty);
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.recipe.line.upsert", payload } });
    await refresh();
    announce("Komponen resep tersimpan dan simulasi HPP diperbarui.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function removeHppRecipe(event) {
  if (!event.target.matches(".hpp-remove-form")) return;
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form));
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.recipe.line.remove", payload } });
    await refresh();
    announce("Komponen resep dihapus. Coverage HPP dihitung ulang.");
  } catch (error) { announce(hppErrorMessage(error), true); }
}

async function saveHppModifierRecipe(event) {
  if (event.target.id !== "hpp-modifier-recipe-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  const [groupId, optionId] = String(payload.modifierKey || "").split(":");
  delete payload.modifierKey;
  payload.groupId = groupId;
  payload.optionId = optionId;
  payload.qty = Number(payload.qty);
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.modifier_recipe.line.upsert", payload } });
    await refresh();
    announce("Recipe delta modifier tersimpan. HPP add-on kini bisa masuk snapshot checkout.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function removeHppModifierRecipe(event) {
  if (!event.target.matches(".hpp-modifier-remove-form")) return;
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form));
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.modifier_recipe.line.remove", payload } });
    await refresh();
    announce("Recipe delta modifier dihapus. Checkout terkait kembali menjadi gap HPP.");
  } catch (error) { announce(hppErrorMessage(error), true); }
}

async function saveHppFulfillmentRecipe(event) {
  if (event.target.id !== "hpp-fulfillment-recipe-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.qty = Number(payload.qty);
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.fulfillment_recipe.line.upsert", payload } });
    await refresh();
    announce("Recipe packaging tersimpan. Order Take Away kini bisa membawa HPP cup/lid/bag.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

async function removeHppFulfillmentRecipe(event) {
  if (!event.target.matches(".hpp-fulfillment-remove-form")) return;
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form));
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.fulfillment_recipe.line.remove", payload } });
    await refresh();
    announce("Recipe packaging dihapus. Take Away terkait kembali menjadi gap HPP.");
  } catch (error) { announce(hppErrorMessage(error), true); }
}

async function saveHppGate(event) {
  if (event.target.id !== "hpp-gate-editor") return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  const payload = Object.fromEntries(new FormData(form));
  payload.enabled = payload.enabled === "true";
  payload.expectedVersion = state.hpp.version;
  try {
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "hpp.gate.update", payload } });
    await refresh();
    announce(payload.enabled ? "Gate resep minuman aktif." : "Gate resep kembali ke mode draft.");
  } catch (error) {
    form.querySelector("[role='status']").textContent = hppErrorMessage(error);
  } finally { button.disabled = false; }
}

function applyCatalogFilters() {
  const normalizedQuery = catalogQuery.trim().toLocaleLowerCase("id-ID");
  let visibleCount = 0;
  for (const card of content.querySelectorAll(".admin-product-card")) {
    const matchesQuery = !normalizedQuery || card.dataset.search.includes(normalizedQuery);
    const matchesCategory = categoryFilter === "all" || card.dataset.category === categoryFilter;
    const matchesAvailability = availabilityFilter === "all" || card.dataset.availability === availabilityFilter;
    card.hidden = !(matchesQuery && matchesCategory && matchesAvailability);
    if (!card.hidden) visibleCount += 1;
  }
  const count = content.querySelector("#catalog-result-count");
  if (count) count.textContent = `${visibleCount} menu`;
  const empty = content.querySelector(".admin-empty");
  if (empty) empty.hidden = visibleCount !== 0;
}

async function commitAvailability(button) {
  const reason = content.querySelector("#availability-reason")?.value;
  if (!reason) { announce("Pilih alasan perubahan terlebih dahulu.", true); return; }
  button.disabled = true;
  const action = pendingAvailability;
  try {
    const resetMode = action.available ? undefined : content.querySelector("#availability-reset")?.value;
    await request("/api/admin/actions", { method: "POST", csrf: true, body: { action: "catalog.availability", payload: { productId: action.productId, available: action.available, reason, resetMode, expectedVersion: state.catalogVersion } } });
    pendingAvailability = null;
    catalogConflict = false;
    await refresh();
    announce(`${action.available ? "Menu dipulihkan" : "Menu ditandai sold out"}. Catalog sekarang versi ${state.catalogVersion}.`);
  } catch (error) {
    if (error.code === "catalog_version_conflict") {
      pendingAvailability = null;
      catalogConflict = true;
      await refresh();
      announce("Perubahan dibatalkan. Data katalog terbaru sudah dimuat.", true);
      return;
    }
    announce(error.message, true);
    button.disabled = false;
  }
}

function productCard(product) {
  if (product.status === "archived") return `<article class="admin-product-card is-sold-out" data-category="${escapeHtml(product.categoryId)}" data-availability="sold-out" data-search="${escapeHtml(`${product.name} ${product.categoryName}`.toLocaleLowerCase("id-ID"))}"><div><span class="availability-badge">Arsip</span><small>${escapeHtml(product.categoryName)}</small></div><h3>${escapeHtml(product.name)}</h3><p>${rupiah(product.priceRupiah)}</p><small>Tidak tampil untuk pelanggan. Riwayat pesanan tetap tersimpan.</small><button class="button button-secondary" data-edit-archived="${escapeHtml(product.id)}">Ubah status arsip</button></article>`;
  const available = product.available !== false;
  const restoreHint = !available ? availabilityRestoreLabel(product.availabilityRestoresAt) : "";
  return `<article class="admin-product-card ${available ? "is-available" : "is-sold-out"}" data-category="${product.categoryId}" data-availability="${available ? "available" : "sold-out"}" data-search="${escapeHtml(`${product.name} ${product.categoryName}`.toLocaleLowerCase("id-ID"))}"><div><span class="availability-badge">${available ? "Tersedia" : "Sold out"}</span><small>${escapeHtml(product.categoryName)}</small></div><h3>${escapeHtml(product.name)}</h3><p>${rupiah(product.priceRupiah)}</p>${restoreHint ? `<small class="availability-window">${escapeHtml(restoreHint)}</small>` : ""}<button class="button ${available ? "button-secondary" : "button-primary"}" data-product="${product.id}" data-available="${!available}" aria-label="${available ? "Set sold out" : "Pulihkan"} ${escapeHtml(product.name)}">${available ? "Set sold out" : "Pulihkan"}</button></article>`;
}

function confirmationCard(product) {
  const restoring = pendingAvailability.available;
  const options = restoring ? ["Bahan tersedia lagi", "Quality check selesai", "Owner override terverifikasi"] : ["Bahan utama habis", "Quality hold", "Dihentikan untuk shift ini"];
  const resetControl = restoring ? "" : `<label for="availability-reset">Pulihkan otomatis</label><select id="availability-reset"><option value="30_minutes">Dalam 30 menit</option><option value="60_minutes">Dalam 60 menit</option><option value="end_of_day" selected>Akhir hari · ${escapeHtml(state.orderingSettings?.closesAt || "22:00")} WIB</option><option value="manual">Sampai dipulihkan manual</option></select><small class="availability-reset-help">Waktu berasal dari server. Menu juga bisa dipulihkan lebih cepat secara manual.</small>`;
  return `<article class="admin-confirm-card" role="alertdialog" aria-modal="false" aria-labelledby="availability-confirm-title" aria-describedby="availability-confirm-impact"><p class="eyebrow">Konfirmasi perubahan</p><span class="confirmation-intent ${restoring ? "is-restore" : "is-stop"}">${restoring ? "PULIHKAN" : "STOP PENJUALAN"}</span><h2 id="availability-confirm-title">${escapeHtml(product.name)}</h2><p id="availability-confirm-impact">${restoring ? "Menu kembali bisa dipesan dari Kiosk dan Cashier lokal." : "Menu langsung dinonaktifkan dari Kiosk dan Cashier lokal."}</p><label for="availability-reason">Alasan wajib</label><select id="availability-reason"><option value="">Pilih alasan</option>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("")}</select>${resetControl}<div class="admin-confirm-actions"><button class="button button-ghost" data-cancel-availability>Batal</button><button class="button ${restoring ? "button-primary" : "button-danger"}" data-confirm-availability>${restoring ? "Ya, pulihkan" : "Ya, set sold out"}</button></div><small>Catalog versi ${state.catalogVersion} · server akan menaikkan versi setelah berhasil.</small></article>`;
}

function availabilityHistory(history) {
  const filtered = history.filter((event) => historyFilter === "all" || (historyFilter === "sold-out" ? !event.available : event.available));
  return `<section class="admin-history-card"><div class="section-heading"><div><p class="eyebrow">Jejak perubahan</p><h2>Riwayat availability</h2><p>Fakta terbaru dari server, maksimal 20 perubahan.</p></div><div class="admin-history-filters" aria-label="Filter riwayat"><button data-history-filter="all" aria-pressed="${historyFilter === "all"}">Semua</button><button data-history-filter="sold-out" aria-pressed="${historyFilter === "sold-out"}">Sold out</button><button data-history-filter="restored" aria-pressed="${historyFilter === "restored"}">Dipulihkan</button></div></div>${filtered.length ? `<div class="admin-history-table"><table><caption>Riwayat perubahan ketersediaan menu terbaru</caption><thead><tr><th scope="col">Menu</th><th scope="col">Perubahan</th><th scope="col">Alasan</th><th scope="col">Owner</th><th scope="col">Waktu</th><th scope="col">Versi</th></tr></thead><tbody>${filtered.map(historyRow).join("")}</tbody></table></div>` : `<div class="admin-history-empty"><span>Belum ada perubahan</span><p>${history.length ? "Tidak ada riwayat untuk filter ini." : "Perubahan sold-out atau pemulihan akan muncul di sini."}</p></div>`}</section>`;
}

function historyRow(event) {
  const restored = event.available;
  const formattedTime = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(event.occurredAt));
  const schedule = event.restoresAt ? availabilityRestoreLabel(event.restoresAt) : (event.restoredAutomatically ? "Pulih otomatis oleh server" : "");
  return `<tr><th scope="row">${escapeHtml(event.productName)}</th><td><span class="history-status ${restored ? "is-restored" : "is-sold-out"}">${restored ? "Dipulihkan" : "Sold out"}</span><small>${event.previousAvailable ? "Tersedia" : "Sold out"} → ${restored ? "Tersedia" : "Sold out"}</small></td><td>${escapeHtml(event.reason)}${schedule ? `<small class="history-schedule">${escapeHtml(schedule)}</small>` : ""}</td><td>${escapeHtml(event.actorId)}</td><td><time datetime="${escapeHtml(event.occurredAt)}">${escapeHtml(formattedTime)}</time></td><td>v${escapeHtml(event.version)}</td></tr>`;
}

function availabilityRestoreLabel(value) {
  if (!value) return "Pulih manual";
  const formatted = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(value));
  return `Pulih otomatis ${formatted}`;
}

function collectPurchaseOrderLines(form) {
  return [...form.querySelectorAll(".hpp-po-line")].map((row) => ({
    ingredientId: row.querySelector("[name='ingredientId']")?.value,
    purchaseUnitLabel: row.querySelector("[name='purchaseUnitLabel']")?.value,
    orderedPurchaseQuantity: Number(row.querySelector("[name='orderedPurchaseQuantity']")?.value),
    baseUnitsPerPurchaseUnit: Number(row.querySelector("[name='baseUnitsPerPurchaseUnit']")?.value),
    unitCostRupiah: Number(row.querySelector("[name='unitCostRupiah']")?.value),
  }));
}

function updatePurchaseOrderDraft(form) {
  const rows = [...form.querySelectorAll(".hpp-po-line")];
  const lineCount = form.querySelector("[data-po-line-count]");
  const total = form.querySelector("[data-po-total]");
  if (!rows.length || !lineCount || !total) return;
  rows.forEach((row, index) => {
    const number = index + 1;
    row.querySelector("[data-po-line-number]").textContent = `Item ${number}`;
    row.querySelector("[data-po-field='ingredient']").textContent = `Bahan item ${number}`;
    row.querySelector("[data-po-field='unit']").textContent = `Nama kemasan item ${number}`;
    row.querySelector("[data-po-field='quantity']").textContent = `Jumlah dipesan item ${number}`;
    row.querySelector("[data-po-field='conversion']").textContent = `Isi per kemasan item ${number}`;
    row.querySelector("[data-po-field='cost']").textContent = `Biaya per kemasan (Rp) item ${number}`;
    const remove = row.querySelector("[data-po-line-remove]");
    remove.disabled = rows.length === 1;
    remove.setAttribute("aria-label", `Hapus item ${number}`);
  });
  const lines = collectPurchaseOrderLines(form);
  const selectedIds = lines.map((line) => line.ingredientId).filter(Boolean);
  const duplicate = new Set(selectedIds).size !== selectedIds.length;
  const safeTotal = lines.reduce((sum, line) => {
    if (sum === null) return null;
    if (!(line.orderedPurchaseQuantity > 0) || !(line.unitCostRupiah > 0)) return sum;
    const lineTotal = line.orderedPurchaseQuantity * line.unitCostRupiah;
    const next = sum + lineTotal;
    if (!Number.isSafeInteger(lineTotal) || lineTotal <= 0 || !Number.isSafeInteger(next)) return null;
    return next;
  }, 0);
  lineCount.textContent = `${rows.length} item`;
  total.textContent = safeTotal === null ? "Total perlu diperiksa" : rupiah(safeTotal);
  const duplicateStatus = form.querySelector("[data-po-duplicate-status]");
  duplicateStatus.textContent = duplicate ? "Satu bahan tidak boleh muncul dua kali. Gabungkan jumlahnya dalam satu item." : "";
  form.querySelector("button[type='submit']").disabled = duplicate || form.dataset.poDisabled === "true" || form.dataset.poSubmitting === "true";
}

function renderPurchaseOrderLine(line, ingredients, index = 0) {
  const number = index + 1;
  const options = ingredients.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === line?.ingredientId ? "selected" : ""}>${escapeHtml(item.name)} · ${escapeHtml(item.baseUnit)}${item.costStatus === "PRICED" ? ` · ${rupiahPerUnit(item.costPerUnitRupiah)}` : " · belum diberi biaya"}</option>`).join("");
  return `<fieldset class="hpp-po-line"><legend data-po-line-number>Item ${number}</legend><label><span data-po-field="ingredient">Bahan item ${number}</span><select name="ingredientId" required>${options}</select></label><div class="hpp-form-row"><label><span data-po-field="unit">Nama kemasan item ${number}</span><input name="purchaseUnitLabel" maxlength="80" placeholder="bag 1 kg" value="${escapeHtml(line?.purchaseUnitLabel ?? "")}" required></label><label><span data-po-field="quantity">Jumlah dipesan item ${number}</span><input name="orderedPurchaseQuantity" type="number" min="0.001" max="1000000" step="0.001" value="${line?.orderedPurchaseQuantity ?? ""}" required></label></div><div class="hpp-form-row"><label><span data-po-field="conversion">Isi per kemasan item ${number}</span><input name="baseUnitsPerPurchaseUnit" type="number" min="0.001" max="1000000" step="0.001" value="${line?.baseUnitsPerPurchaseUnit ?? ""}" required></label><label><span data-po-field="cost">Biaya per kemasan (Rp) item ${number}</span><input name="unitCostRupiah" type="number" min="1" max="1000000000" step="1" value="${line?.unitCostRupiah ?? ""}" required></label></div><button class="button button-ghost hpp-po-line-remove" type="button" data-po-line-remove aria-label="Hapus item ${number}">Hapus item</button></fieldset>`;
}

function renderPurchaseOrderDraftTools(ingredients, lineCount, totalRupiah) {
  return `<template data-po-line-template>${renderPurchaseOrderLine(null, ingredients, 0)}</template><div class="hpp-po-draft-actions"><button class="button button-ghost" type="button" data-po-line-add>Tambah item</button><div class="hpp-po-draft-summary" aria-live="polite"><span data-po-line-count>${lineCount} item</span><strong data-po-total>${rupiah(totalRupiah)}</strong></div></div><p class="hpp-po-duplicate-status" data-po-duplicate-status role="alert"></p>`;
}

function updatePurchaseOrderReceiptForm(form) {
  const accepted = Number(form.elements.purchaseQuantity?.value || 0);
  const rejected = Number(form.elements.rejectedPurchaseQuantity?.value || 0);
  const remaining = Number(form.elements.remainingPurchaseQuantity?.value || 0);
  const rejectionReason = form.elements.rejectionReason;
  const feeType = form.elements.additionalFeeType;
  const feeAmount = Number(form.elements.additionalFeeRupiah?.value || 0);
  if (rejectionReason) rejectionReason.required = rejected > 0;
  if (feeType) feeType.required = feeAmount > 0;
  const validQuantity = accepted + rejected > 0 && accepted + rejected <= remaining;
  const status = form.querySelector("[data-receive-plan]");
  if (status) status.textContent = validQuantity
    ? `${formatQuantity(accepted)} masuk stok · ${formatQuantity(rejected)} ditolak · ${formatQuantity(remaining - accepted - rejected)} tetap ditunggu`
    : `Jumlah diterima + ditolak harus 0,001–${formatQuantity(remaining)}.`;
  const button = form.querySelector("button[type='submit']");
  if (button && form.dataset.submitting !== "true") button.disabled = !validQuantity;
}

function updatePurchaseInvoiceDraft(form) {
  const lines = [...form.querySelectorAll("[data-invoice-line]")];
  let invoiceItems = 0;
  let expectedItems = 0;
  let valid = lines.length > 0;
  for (const row of lines) {
    const quantity = Number(row.querySelector("[name='invoiceQuantity']")?.value);
    const unitPrice = Number(row.querySelector("[name='unitPriceRupiah']")?.value);
    const available = Number(row.dataset.availableQuantity);
    const expectedPrice = Number(row.dataset.expectedUnitPrice);
    if (!(quantity > 0 && quantity <= 1_000_000 && Number.isSafeInteger(unitPrice) && unitPrice > 0)) valid = false;
    invoiceItems += Math.round(quantity * unitPrice) || 0;
    expectedItems += Math.round(quantity * expectedPrice) || 0;
    row.dataset.state = quantity <= available && unitPrice === expectedPrice ? "matched" : "exception";
  }
  const feeInput = form.elements.additionalFeeRupiah;
  const selectedFee = form.elements.additionalFeeType?.selectedOptions?.[0];
  const availableFee = Number(selectedFee?.dataset.availableAmount || 0);
  if (feeInput) {
    feeInput.dataset.availableAmount = String(availableFee);
    const helper = feeInput.closest("label")?.querySelector("small");
    if (helper) helper.textContent = `Maksimal belum ditagih ${rupiah(availableFee)}`;
  }
  const fee = Number(feeInput?.value || 0);
  if (!Number.isSafeInteger(fee) || fee < 0) valid = false;
  const total = invoiceItems + fee;
  const expected = expectedItems + Math.min(fee, availableFee);
  const matched = valid && lines.every((row) => row.dataset.state === "matched") && fee <= availableFee;
  const totalView = form.querySelector("[data-invoice-total]");
  const status = form.querySelector("[data-invoice-match]");
  if (totalView) totalView.textContent = rupiah(total);
  if (status) {
    status.dataset.state = matched ? "matched" : "exception";
    status.innerHTML = matched
      ? `<strong>COCOK · siap diajukan</strong><small>PO, barang diterima, dan invoice selaras. Pembayaran belum dilakukan.</small>`
      : `<strong>EXCEPTION · pembayaran diblokir</strong><small>Periksa kuantitas diterima, harga PO, atau biaya. Selisih nilai ${rupiah(total - expected)}.</small>`;
  }
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = !valid;
}

function renderHppWorkspace(hpp) {
  const ingredients = hpp?.ingredients ?? [];
  const products = hpp?.products ?? [];
  const ingredientOptions = ingredients.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.baseUnit)}${item.costStatus === "PRICED" ? ` · ${rupiahPerUnit(item.costPerUnitRupiah)}` : " · belum diberi biaya"}</option>`).join("");
  const productOptions = products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} · ${product.station === "bar" ? "Minuman" : "Makanan"}</option>`).join("");
  const pricedModifierOptions = uniqueModifierOptions((state.catalog ?? []).flatMap((category) => category.products ?? []));
  const modifierOptions = pricedModifierOptions.map((option) => `<option value="${escapeHtml(`${option.groupId}:${option.optionId}`)}">${escapeHtml(option.optionLabel)} · ${escapeHtml(option.groupLabel)} · ${rupiah(option.priceDeltaRupiah)}</option>`).join("");
  const ingredientById = new Map(ingredients.map((item) => [item.id, item]));
  const modifierRecipeRows = renderModifierRecipeRows(hpp?.modifierRecipes ?? [], ingredientById);
  const fulfillmentRecipeRows = renderFulfillmentRecipeRows(hpp?.fulfillmentRecipes ?? [], ingredientById);
  const suppliers = hpp?.suppliers ?? [];
  const supplierOptions = suppliers.filter((item) => item.active).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · lead ${item.leadTimeDays} hari</option>`).join("");
  const purchaseOrders = hpp?.purchaseOrders ?? [];
  const purchaseOrderRows = purchaseOrders.map((order) => `<tr><th scope="row">${escapeHtml(order.supplierNameSnapshot)}<small>Revisi ${order.revision ?? 1}</small></th><td>${escapeHtml(order.expectedDate)}</td><td>${order.lines.map((line) => `${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")} · baik ${formatQuantity(line.receivedPurchaseQuantity)} · ditolak ${formatQuantity(line.rejectedPurchaseQuantity ?? 0)} / ${formatQuantity(line.orderedPurchaseQuantity)} ${escapeHtml(line.purchaseUnitLabel)}`).join("<br>")}</td><td>${rupiah(order.totalOrderedRupiah)}</td><td>${escapeHtml(order.status === "CANCELLED" ? order.cancelReason : order.reason)}<small>${escapeHtml(order.status === "CANCELLED" ? order.cancelledBy : order.actorId)}</small></td><td>${purchaseOrderStatusLabel(order)}</td></tr>`).join("");
  const purchaseOrderReceiving = purchaseOrders.filter((order) => !["RECEIVED", "CANCELLED"].includes(order.status)).flatMap((order) => order.lines.filter((line) => (line.receivedPurchaseQuantity + (line.rejectedPurchaseQuantity ?? 0)) < line.orderedPurchaseQuantity).map((line) => { const remaining = Math.round((line.orderedPurchaseQuantity - line.receivedPurchaseQuantity - (line.rejectedPurchaseQuantity ?? 0)) * 1000) / 1000; const ingredient = ingredientById.get(line.ingredientId); return `<form class="hpp-po-receive-form hpp-editor-card"><input type="hidden" name="idempotencyKey" value="po-receipt-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseOrderId" value="${escapeHtml(order.id)}"><input type="hidden" name="ingredientId" value="${escapeHtml(line.ingredientId)}"><input type="hidden" name="remainingPurchaseQuantity" value="${remaining}"><div><p class="eyebrow">Terima & periksa PO</p><h3>${escapeHtml(ingredient?.name ?? "Bahan")}</h3><small>${escapeHtml(order.supplierNameSnapshot)} · sisa ${formatQuantity(remaining)} ${escapeHtml(line.purchaseUnitLabel)}</small></div><div class="hpp-po-receive-summary"><span>Dipesan <strong>${formatQuantity(line.orderedPurchaseQuantity)}</strong></span><span>Baik <strong>${formatQuantity(line.receivedPurchaseQuantity)}</strong></span><span>Ditolak <strong>${formatQuantity(line.rejectedPurchaseQuantity ?? 0)}</strong></span></div><div class="hpp-form-row"><label>Barang baik diterima<input name="purchaseQuantity" type="number" min="0" max="${remaining}" step="0.001" value="${remaining}" required></label><label>Barang ditolak<input name="rejectedPurchaseQuantity" type="number" min="0" max="${remaining}" step="0.001" value="0" required></label></div><label>Alasan barang ditolak<select name="rejectionReason"><option value="">Pilih bila ada penolakan</option><option value="DAMAGED">Rusak saat tiba</option><option value="MISSING">Tidak dipenuhi supplier</option><option value="WRONG_ITEM">Barang tidak sesuai</option><option value="EXPIRED">Kedaluwarsa</option></select></label><div class="hpp-form-row"><label>Biaya tambahan<select name="additionalFeeType"><option value="">Tanpa biaya</option><option value="SHIPPING">Pengiriman</option><option value="HANDLING">Penanganan</option><option value="OTHER">Lainnya</option></select></label><label>Nominal biaya (Rp)<input name="additionalFeeRupiah" type="number" min="0" max="1000000000" step="1" value="0"></label></div><p class="hpp-po-receive-plan" data-receive-plan aria-live="polite">${formatQuantity(remaining)} masuk stok · 0 ditolak · 0 tetap ditunggu</p><p class="hpp-po-receive-help">Tolak hanya bila supplier tidak akan memenuhi item ini. Biarkan sebagai sisa bila masih backorder. Biaya dialokasikan ke barang baik dan masuk moving-average HPP.</p><label>Catatan pemeriksaan<input name="reason" maxlength="160" placeholder="Contoh: cocok dengan surat jalan; satu karton rusak" required></label><p role="status"></p><button class="button button-primary" type="submit">Simpan pemeriksaan barang</button></form>`; })).join("");
  const purchaseOrderManagement = purchaseOrders.filter((order) => !["RECEIVED", "CANCELLED"].includes(order.status)).map((order) => {
    const canAmend = order.status === "OPEN";
    const supplierChoices = suppliers.filter((item) => item.active || item.id === order.supplierId).map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === order.supplierId ? "selected" : ""}>${escapeHtml(item.name)}${item.active ? "" : " · nonaktif"}</option>`).join("");
    const amendForm = canAmend ? `<form class="hpp-po-amend-form hpp-po-control-form hpp-po-lines-form"><input type="hidden" name="idempotencyKey" value="po-amend-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseOrderId" value="${escapeHtml(order.id)}"><label>Supplier<select name="supplierId" required>${supplierChoices}</select></label><label>Perkiraan tiba<input name="expectedDate" type="date" value="${escapeHtml(order.expectedDate)}" required></label><div class="hpp-po-lines">${order.lines.map((line, index) => renderPurchaseOrderLine(line, ingredients, index)).join("")}</div>${renderPurchaseOrderDraftTools(ingredients, order.lineCount, order.totalOrderedRupiah)}<label>Alasan revisi<input name="reason" maxlength="160" placeholder="Contoh: koreksi quotation supplier" required></label><p role="status"></p><button class="button button-secondary" type="submit">Simpan revisi PO</button></form>` : `<p class="hpp-po-lock-note">Detail PO terkunci karena sebagian barang sudah diterima. Batalkan sisa dan buat PO baru bila rencana berubah.</p>`;
    return `<article class="hpp-po-manage-card"><div><p class="eyebrow">Kontrol PO · revisi ${order.revision ?? 1}</p><h4>${escapeHtml(order.supplierNameSnapshot)}</h4><small>${purchaseOrderStatusLabel(order)} · ${rupiah(order.totalOrderedRupiah)}</small></div>${amendForm}<form class="hpp-po-cancel-form hpp-po-control-form is-cancel"><input type="hidden" name="idempotencyKey" value="po-cancel-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseOrderId" value="${escapeHtml(order.id)}"><label>Alasan pembatalan / penutupan sisa<input name="reason" maxlength="160" placeholder="Contoh: supplier tidak dapat memenuhi sisa" required></label><label class="hpp-period-confirm"><input name="confirmed" type="checkbox" required> Saya memahami tindakan ini tidak dapat dibatalkan dan tidak membalik stok yang sudah diterima.</label><p role="status"></p><button class="button button-danger" type="submit">Batalkan PO & tutup sisa</button></form></article>`;
  }).join("");
  const purchaseInvoices = hpp?.purchaseInvoices ?? [];
  const matchedInvoices = purchaseInvoices.filter((invoice) => invoice.matchStatus === "MATCHED");
  const invoiceQty = new Map();
  const invoiceFees = new Map();
  for (const invoice of matchedInvoices) {
    for (const line of invoice.lines) invoiceQty.set(`${invoice.purchaseOrderId}:${line.ingredientId}`, (invoiceQty.get(`${invoice.purchaseOrderId}:${line.ingredientId}`) ?? 0) + line.invoiceQuantity);
    for (const fee of invoice.additionalFees) invoiceFees.set(`${invoice.purchaseOrderId}:${fee.type}`, (invoiceFees.get(`${invoice.purchaseOrderId}:${fee.type}`) ?? 0) + fee.amountRupiah);
  }
  const receivedFees = new Map();
  for (const receipt of hpp?.purchaseReceipts ?? []) for (const fee of receipt.additionalFees ?? []) receivedFees.set(`${receipt.purchaseOrderId}:${fee.type}`, (receivedFees.get(`${receipt.purchaseOrderId}:${fee.type}`) ?? 0) + fee.amountRupiah);
  const invoiceDate = String(state.generatedAt).slice(0, 10);
  const invoiceDueDate = datePlusDays(invoiceDate, 7);
  const paymentDate = invoiceDate;
  const purchaseInvoiceAuthoring = purchaseOrders.map((order) => {
    const availableLines = order.lines.map((line) => ({ ...line, availableInvoiceQuantity: Math.round((line.receivedPurchaseQuantity - (invoiceQty.get(`${order.id}:${line.ingredientId}`) ?? 0)) * 1000) / 1000 })).filter((line) => line.availableInvoiceQuantity > 0);
    if (!availableLines.length) return "";
    const feeAvailability = ["SHIPPING", "HANDLING", "OTHER"].map((type) => ({ type, available: (receivedFees.get(`${order.id}:${type}`) ?? 0) - (invoiceFees.get(`${order.id}:${type}`) ?? 0) })).filter((item) => item.available > 0);
    const selectedFee = feeAvailability[0] ?? { type: "SHIPPING", available: 0 };
    const expectedItems = availableLines.reduce((sum, line) => sum + Math.round(line.availableInvoiceQuantity * line.unitCostRupiah), 0);
    return `<form class="hpp-invoice-form hpp-editor-card"><input type="hidden" name="idempotencyKey" value="invoice-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseOrderId" value="${escapeHtml(order.id)}"><div><p class="eyebrow">Three-way match</p><h3>${escapeHtml(order.supplierNameSnapshot)}</h3><small>${availableLines.length} line diterima belum ditagih · PO ${purchaseOrderStatusLabel(order)}</small></div><div class="hpp-form-row"><label>Nomor invoice<input name="invoiceNumber" maxlength="80" placeholder="Contoh: INV-DUMMY-001" required></label><label>Tanggal invoice<input name="invoiceDate" type="date" value="${invoiceDate}" required></label></div><label>Jatuh tempo<input name="dueDate" type="date" value="${invoiceDueDate}" required></label><div class="hpp-invoice-lines">${availableLines.map((line) => `<div class="hpp-invoice-line" data-invoice-line data-ingredient-id="${escapeHtml(line.ingredientId)}" data-available-quantity="${line.availableInvoiceQuantity}" data-expected-unit-price="${line.unitCostRupiah}"><strong>${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")}</strong><small>Diterima belum ditagih ${formatQuantity(line.availableInvoiceQuantity)} ${escapeHtml(line.purchaseUnitLabel)} · harga PO ${rupiah(line.unitCostRupiah)}</small><div class="hpp-form-row"><label>Jumlah invoice<input name="invoiceQuantity" type="number" min="0.001" max="1000000" step="0.001" value="${line.availableInvoiceQuantity}" required></label><label>Harga/unit invoice<input name="unitPriceRupiah" type="number" min="1" max="1000000000" step="1" value="${line.unitCostRupiah}" required></label></div></div>`).join("")}</div><div class="hpp-form-row"><label>Biaya invoice<select name="additionalFeeType">${["SHIPPING", "HANDLING", "OTHER"].map((type) => { const available = (receivedFees.get(`${order.id}:${type}`) ?? 0) - (invoiceFees.get(`${order.id}:${type}`) ?? 0); return `<option value="${type}" data-available-amount="${available}" ${type === selectedFee.type ? "selected" : ""}>${purchaseFeeLabel(type)}</option>`; }).join("")}</select></label><label>Nominal biaya (Rp)<input name="additionalFeeRupiah" type="number" min="0" max="1000000000" step="1" value="${selectedFee.available}" data-available-amount="${selectedFee.available}"><small>Maksimal belum ditagih ${rupiah(selectedFee.available)}</small></label></div><div class="hpp-invoice-total"><span>Total invoice dari line</span><strong data-invoice-total>${rupiah(expectedItems + selectedFee.available)}</strong></div><p class="hpp-invoice-match" data-invoice-match data-state="matched"><strong>COCOK · siap diajukan</strong><small>PO, barang diterima, dan invoice selaras. Pembayaran belum dilakukan.</small></p><label>Catatan pemeriksaan<input name="reason" maxlength="160" placeholder="Contoh: invoice dummy cocok dengan receipt" required></label><p role="status"></p><button class="button button-primary" type="submit">Simpan hasil pencocokan</button></form>`;
  }).join("");
  const purchaseInvoiceRows = purchaseInvoices.map((invoice) => {
    const outstanding = invoice.payableEntry?.outstandingRupiah ?? 0;
    const paid = invoice.payableEntry?.paidRupiah ?? 0;
    const payableCopy = invoice.paymentReadiness === "POSTED_UNPAID"
      ? outstanding > 0 ? `Outstanding ${rupiah(outstanding)} · dibayar ${rupiah(paid)}` : `Lunas dicatat · dibayar ${rupiah(paid)}`
      : invoice.paymentReadiness === "APPROVED_NOT_POSTED" ? "Disetujui Finance · perlu posting"
        : invoice.paymentReadiness === "READY_FOR_APPROVAL" ? "Menunggu reviewer Finance" : "Tidak dapat diposting";
    const paymentForm = invoice.paymentReadiness === "POSTED_UNPAID" && outstanding > 0 ? `<form class="hpp-invoice-payment-form"><input type="hidden" name="idempotencyKey" value="invoice-payment-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseInvoiceId" value="${escapeHtml(invoice.id)}"><div class="hpp-form-row"><label><span class="sr-only">Tanggal pembayaran ${escapeHtml(invoice.invoiceNumber)}</span><input name="paidDate" type="date" value="${escapeHtml(paymentDate)}" min="${escapeHtml(invoice.invoiceDate)}" required></label><label><span class="sr-only">Nominal pembayaran ${escapeHtml(invoice.invoiceNumber)}</span><input name="amountRupiah" type="number" min="1" max="${outstanding}" step="1" value="${outstanding}" required></label></div><label><span class="sr-only">Metode pembayaran ${escapeHtml(invoice.invoiceNumber)}</span><select name="method" required><option value="BANK_TRANSFER">Transfer bank</option><option value="CASH">Tunai</option><option value="E_WALLET">E-wallet</option><option value="OTHER">Lainnya</option></select></label><label><span class="sr-only">Referensi pembayaran ${escapeHtml(invoice.invoiceNumber)}</span><input name="reference" maxlength="80" placeholder="Ref pembayaran manual" required></label><label><span class="sr-only">Alasan settlement ${escapeHtml(invoice.invoiceNumber)}</span><input name="reason" maxlength="160" placeholder="Bukti bayar diverifikasi Owner" required></label><p class="ap-boundary">Mencatat pembayaran manual saja; tidak mengirim uang atau memanggil payment provider.</p><p role="status"></p><button class="button button-primary" type="submit">Catat pembayaran</button></form>` : "";
    const postForm = invoice.paymentReadiness === "APPROVED_NOT_POSTED" ? `<form class="hpp-invoice-post-form"><input type="hidden" name="idempotencyKey" value="invoice-post-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseInvoiceId" value="${escapeHtml(invoice.id)}"><label><span class="sr-only">Alasan posting ${escapeHtml(invoice.invoiceNumber)}</span><input name="reason" maxlength="160" placeholder="Referensi posting AP" required></label><p role="status"></p><button class="button button-primary" type="submit">Posting utang AP</button></form>` : "";
    return `<tr><th scope="row">${escapeHtml(invoice.invoiceNumber)}<small>${escapeHtml(invoice.supplierNameSnapshot)}</small></th><td>${escapeHtml(invoice.invoiceDate)}<small>Jatuh tempo ${escapeHtml(invoice.dueDate)}</small></td><td>${invoice.lines.map((line) => `${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")} · ${formatQuantity(line.invoiceQuantity)} · ${line.quantityMatch ? "qty cocok" : "qty selisih"} · ${line.priceMatch ? "harga cocok" : `harga selisih ${formatSignedRupiah(line.varianceRupiah)}`}`).join("<br>")}</td><td>${rupiah(invoice.totalInvoiceRupiah)}<small>Variance ${formatSignedRupiah(invoice.totalVarianceRupiah)}</small><small>Credit ${rupiah(invoice.payableEntry?.creditedRupiah ?? 0)} · Paid ${rupiah(paid)}</small></td><td><span class="hpp-status ${invoice.matchStatus === "MATCHED" ? "is-matched" : "is-exception"}">${invoice.matchStatus === "MATCHED" ? "COCOK" : "EXCEPTION"}</span><small>Workflow Finance</small><small>${purchaseInvoiceStatusLabel(invoice.paymentReadiness)}</small><small>${payableCopy}</small>${postForm}${paymentForm}</td></tr>`;
  }).join("");
  const invoiceById = new Map(purchaseInvoices.map((invoice) => [invoice.id, invoice]));
  const purchasePaymentRows = (hpp?.purchaseInvoicePayments ?? []).map((payment) => {
    const invoice = invoiceById.get(payment.purchaseInvoiceId);
    return `<tr><th scope="row">${escapeHtml(payment.reference)}<small>${escapeHtml(payment.supplierNameSnapshot)}</small></th><td>${escapeHtml(payment.paidDate)}<small>${purchasePaymentMethodLabel(payment.method)}</small></td><td>${rupiah(payment.amountRupiah)}<small>Invoice ${escapeHtml(invoice?.invoiceNumber ?? "tidak ditemukan")}</small></td><td><span class="hpp-status is-matched">TERCATAT</span><small>${escapeHtml(payment.reason)}</small><small>${escapeHtml(payment.recordedByActorId)}</small></td></tr>`;
  }).join("");
  const purchaseCreditRows = (hpp?.purchaseInvoiceCredits ?? []).map((credit) => {
    const invoice = invoiceById.get(credit.purchaseInvoiceId);
    const latestReversal = credit.reversalHistory.at(-1);
    const status = credit.status === "REVERSED" ? "DIBALIKKAN" : credit.status === "POSTED" ? "POSTED" : "MENUNGGU OWNER";
    let actionCopy = `<small>Mengurangi outstanding · Finance dapat meminta reversal</small>`;
    if (credit.status === "PENDING_OWNER_POST") actionCopy = `<form class="hpp-credit-post-form"><input type="hidden" name="idempotencyKey" value="credit-post-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="creditMemoId" value="${escapeHtml(credit.id)}"><label><span class="sr-only">Alasan posting credit ${escapeHtml(credit.creditNoteNumber)}</span><input name="reason" maxlength="160" placeholder="Referensi posting credit" required></label><p role="status"></p><button class="button button-primary" type="submit">Posting credit memo</button></form>`;
    else if (latestReversal?.status === "PENDING_OWNER_DECISION") actionCopy = `<small>Finance: ${escapeHtml(latestReversal.requestReason)}</small><form class="hpp-credit-reversal-form"><input type="hidden" name="idempotencyKey" value="credit-reversal-decision-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="creditMemoId" value="${escapeHtml(credit.id)}"><label><span class="sr-only">Alasan keputusan reversal ${escapeHtml(credit.creditNoteNumber)}</span><input name="reason" maxlength="160" placeholder="Bukti keputusan Owner" required></label><p role="status"></p><div class="ap-decision-actions"><button class="button button-danger" name="decision" value="REJECT" type="submit">Tolak reversal</button><button class="button button-primary" name="decision" value="APPROVE" type="submit">Setujui reversal</button></div></form>`;
    else if (credit.status === "REVERSED") actionCopy = `<small>Outstanding dipulihkan · histori credit tetap tersimpan</small>`;
    else if (latestReversal?.status === "REJECTED") actionCopy = `<small>Reversal terakhir ditolak · credit tetap berlaku</small>`;
    return `<tr><th scope="row">${escapeHtml(credit.creditNoteNumber)}<small>${escapeHtml(credit.supplierNameSnapshot)}</small></th><td>${escapeHtml(credit.creditDate)}<small>${escapeHtml(creditTypeLabel(credit.creditType))}${credit.returnReferenceSnapshot ? ` · ${escapeHtml(credit.returnReferenceSnapshot)}` : ""}</small></td><td>${rupiah(credit.amountRupiah)}<small>Invoice ${escapeHtml(invoice?.invoiceNumber ?? "tidak ditemukan")}</small></td><td><span class="hpp-status">${status}</span>${actionCopy}</td></tr>`;
  }).join("");
  const balances = new Map((hpp?.inventoryBalances ?? []).map((item) => [item.ingredientId, item]));
  const supplierReturns = hpp?.supplierReturns ?? [];
  const returnedByReceiptLine = new Map();
  for (const item of supplierReturns) for (const line of item.lines) returnedByReceiptLine.set(`${item.purchaseReceiptId}:${line.ingredientId}`, Math.round(((returnedByReceiptLine.get(`${item.purchaseReceiptId}:${line.ingredientId}`) ?? 0) + line.returnPurchaseQuantity) * 1000) / 1000);
  const purchaseReturnAuthoring = (hpp?.purchaseReceipts ?? []).filter((receipt) => receipt.supplierId).flatMap((receipt) => receipt.lines.map((line) => {
    const available = Math.round((line.purchaseQuantity - (returnedByReceiptLine.get(`${receipt.id}:${line.ingredientId}`) ?? 0)) * 1000) / 1000;
    if (available <= 0) return "";
    const ingredient = ingredientById.get(line.ingredientId);
    return `<form class="hpp-supplier-return-form hpp-editor-card"><input type="hidden" name="idempotencyKey" value="supplier-return-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseReceiptId" value="${escapeHtml(receipt.id)}"><input type="hidden" name="ingredientId" value="${escapeHtml(line.ingredientId)}"><div><p class="eyebrow">Return to vendor</p><h3>${escapeHtml(ingredient?.name ?? "Bahan")}</h3><small>${escapeHtml(receipt.supplierName)} · tersedia untuk retur ${formatQuantity(available)} ${escapeHtml(line.purchaseUnitLabel)}</small></div><label>Referensi retur<input name="returnReference" maxlength="80" placeholder="Contoh: RTV-DUMMY-001" required></label><div class="hpp-form-row"><label>Jumlah retur (kemasan)<input name="returnPurchaseQuantity" type="number" min="0.001" max="${available}" step="0.001" required></label><label>Tindak lanjut<select name="disposition"><option value="REPLACEMENT_EXPECTED">Minta penggantian</option><option value="CREDIT_EXPECTED">Minta credit supplier</option></select></label></div><p class="ap-boundary">Submit mencatat barang dikirim balik dan langsung mengurangi stok. Credit atau replacement belum dianggap diterima.</p><label>Alasan / kondisi barang<input name="reason" maxlength="160" placeholder="Contoh: segel rusak setelah penerimaan" required></label><p role="status"></p><button class="button button-danger" type="submit">Catat barang dikirim balik</button></form>`;
  })).join("");
  const purchaseReturnRows = supplierReturns.map((item) => `<tr><th scope="row">${escapeHtml(item.returnReference)}<small>${escapeHtml(item.supplierNameSnapshot)}</small></th><td>${item.lines.map((line) => `${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")} · ${formatQuantity(line.returnPurchaseQuantity)} ${escapeHtml(line.purchaseUnitLabel)}`).join("<br>")}</td><td>${rupiah(item.totalReturnValueRupiah)}<small>${item.disposition === "REPLACEMENT_EXPECTED" ? "Penggantian" : "Credit supplier"}</small></td><td><span class="hpp-status">${supplierReturnStatusLabel(item.status)}</span>${item.status === "SHIPPED_AWAITING_REPLACEMENT" ? `<form class="hpp-supplier-replacement-form"><input type="hidden" name="idempotencyKey" value="replacement-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="supplierReturnId" value="${escapeHtml(item.id)}"><label><span class="sr-only">Referensi replacement ${escapeHtml(item.returnReference)}</span><input name="receiptReference" maxlength="80" placeholder="Referensi replacement" required></label><label><span class="sr-only">Catatan penerimaan replacement ${escapeHtml(item.returnReference)}</span><input name="reason" maxlength="160" placeholder="Catatan pemeriksaan barang" required></label><p role="status"></p><button class="button button-primary" type="submit">Terima replacement</button></form>` : item.status === "SHIPPED_AWAITING_CREDIT" ? `<small>Finance menunggu dokumen credit supplier; utang belum berubah.</small>` : item.status === "CREDIT_RECEIVED_PENDING_POST" ? `<small>Credit diterima · menunggu posting Owner.</small>` : item.status === "CREDIT_POSTED" ? `<small>Credit supplier sudah diposting.</small>` : `<small>${escapeHtml(item.replacementReceipt?.receiptReference ?? "Replacement diterima")}</small>`}</td></tr>`).join("");
  const shortageConsumptions = (hpp?.saleConsumptions ?? []).filter((item) => item.status === "SHORTAGE");
  const balanceOptions = ingredients.filter((item) => balances.has(item.id)).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${formatQuantity(balances.get(item.id).quantityBase)} ${escapeHtml(item.baseUnit)}</option>`).join("");
  const receiptRows = (hpp?.purchaseReceipts ?? []).map((receipt) => `<tr><th scope="row">${escapeHtml(receipt.supplierName)}</th><td><time datetime="${escapeHtml(receipt.receivedAt)}">${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(receipt.receivedAt)))}</time></td><td>${receipt.lines.map((line) => `${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")} · baik ${formatQuantity(line.purchaseQuantity)} ${escapeHtml(line.purchaseUnitLabel)} → ${formatQuantity(line.baseQuantity)} ${escapeHtml(ingredientById.get(line.ingredientId)?.baseUnit ?? "")}`).join("<br>") || "Tidak ada barang baik"}${(receipt.rejectedLines ?? []).map((line) => `<small>${escapeHtml(ingredientById.get(line.ingredientId)?.name ?? "Bahan")} · ditolak ${formatQuantity(line.rejectedPurchaseQuantity)} · ${escapeHtml(purchaseRejectionLabel(line.rejectionReason))}</small>`).join("")}</td><td>${rupiah(receipt.totalCostRupiah)}<small>Item ${rupiah(receipt.totalItemCostRupiah ?? receipt.totalCostRupiah)} · biaya ${rupiah(receipt.totalAdditionalFeesRupiah ?? 0)}</small></td><td>${escapeHtml(receipt.reason)}</td></tr>`).join("");
  const movementRows = (hpp?.inventoryMovements ?? []).map((movement) => { const ingredient = ingredientById.get(movement.ingredientId); const shortage = Number(movement.shortageBase ?? 0); return `<tr><th scope="row">${escapeHtml(inventoryMovementLabel(movement.movementType))}${movement.referenceCode ? `<small>${escapeHtml(movement.referenceCode)}</small>` : ""}</th><td>${escapeHtml(ingredient?.name ?? "Bahan")}</td><td>${formatQuantity(movement.quantityBeforeBase)} → ${formatQuantity(movement.quantityAfterBase)} ${escapeHtml(ingredient?.baseUnit ?? "")}<small>${formatSignedQuantity(movement.quantityDeltaBase)} ${escapeHtml(ingredient?.baseUnit ?? "")}${shortage > 0 ? ` · kekurangan ${formatQuantity(shortage)} ${escapeHtml(ingredient?.baseUnit ?? "")}` : ""}</small></td><td>${formatSignedRupiah(movement.inventoryValueDeltaRupiah)}</td><td>${escapeHtml(movement.reason)}<small>${escapeHtml(movement.actorId)} · <time datetime="${escapeHtml(movement.occurredAt)}">${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(movement.occurredAt)))}</time></small></td></tr>`; }).join("");
  const managedIngredients = ingredients.filter((item) => balances.has(item.id));
  const countRows = (hpp?.inventoryCounts ?? []).map((count) => `<tr><th scope="row"><time datetime="${escapeHtml(count.completedAt)}">${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(count.completedAt)))}</time></th><td><details class="hpp-count-details"><summary>${count.lineCount} bahan · lihat rincian</summary><ul>${count.lines.map((line) => { const ingredient = ingredientById.get(line.ingredientId); return `<li><strong>${escapeHtml(ingredient?.name ?? "Bahan")}</strong><span>${formatQuantity(line.quantityBeforeBase)} → ${formatQuantity(line.quantityAfterBase)} ${escapeHtml(ingredient?.baseUnit ?? "")}</span><small>${formatSignedRupiah(line.inventoryValueDeltaRupiah)}</small></li>`; }).join("")}</ul></details></td><td>${formatSignedRupiah(count.lines.reduce((sum, line) => sum + line.inventoryValueDeltaRupiah, 0))}</td><td>${escapeHtml(count.reason)}<small>${escapeHtml(count.actorId)}</small></td><td>SELESAI</td></tr>`).join("");
  const counts = hpp?.inventoryCounts ?? [];
  const countById = new Map(counts.map((count) => [count.id, count]));
  const countOptions = counts.map((count) => `<option value="${escapeHtml(count.id)}">${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(count.completedAt)))} · ${count.lineCount} bahan</option>`).join("");
  const periodRows = (hpp?.inventoryPeriods ?? []).map((period) => `<tr><th scope="row">${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(period.periodStartAt)))}</th><td>${escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: state.context.timezone }).format(new Date(period.periodEndAt)))}</td><td>v${period.openingVersion} → v${period.closingVersion}</td><td>${escapeHtml(period.reason)}<small>${escapeHtml(period.actorId)} · ${countById.has(period.closingCountId) ? "count terverifikasi" : "arsip count"}</small></td><td>DITUTUP</td></tr>`).join("");
  return `<section class="admin-ops-card hpp-workspace" id="hpp-workspace">
    <div class="section-heading"><div><p class="eyebrow">Recipe costing · owner only</p><h2>Recipe & HPP readiness</h2><p>Masukkan biaya per satuan terkecil, lalu susun pemakaian setiap menu. Pesanan menyimpan snapshot agar perubahan hari ini tidak menulis ulang laporan lama.</p></div><span class="hpp-gate-badge ${hpp?.gateEnabled ? "is-active" : "is-draft"}">${hpp?.gateEnabled ? "GATE AKTIF" : "DRAFT"}</span></div>
    <div class="hpp-summary">
      <article><span>Coverage semua menu</span><strong>${hpp?.coveragePct ?? 0}%</strong><small>${hpp?.verifiedProductCount ?? 0} dari ${hpp?.activeProductCount ?? 0} menu terverifikasi</small></article>
      <article><span>Coverage minuman</span><strong>${hpp?.beverageCoveragePct ?? 0}%</strong><small>Wajib 100% sebelum gate dapat diaktifkan</small></article>
      <article><span>Master bahan</span><strong>${ingredients.length}</strong><small>${ingredients.filter((item) => item.costStatus === "UNPRICED").length} belum memiliki biaya · ${hpp?.purchaseReceiptCount ?? 0} penerimaan</small></article>
      <article><span>Konsumsi saat persiapan</span><strong>${hpp?.saleConsumptionCount ?? 0}</strong><small>${shortageConsumptions.length ? `${shortageConsumptions.length} order perlu stock count karena shortage` : "Otomatis, idempotent, dan dapat diaudit"}</small></article>
    </div>
    <div class="hpp-editor-grid">
      <form id="hpp-ingredient-editor" class="hpp-editor-card"><div><p class="eyebrow">1 · Master bahan</p><h3>Biaya per satuan dasar</h3></div>
        <label>Pilih data<select name="ingredientId"><option value="">+ Bahan baru</option>${ingredientOptions}</select></label>
        <label>Nama bahan<input name="name" maxlength="80" placeholder="Contoh: biji kopi house blend" required></label>
        <div class="hpp-form-row"><label>Satuan dasar<select name="baseUnit"><option value="gram">gram</option><option value="ml">ml</option><option value="pcs">pcs</option></select></label><label>Biaya / satuan (Rp)<input name="costPerUnitRupiah" type="number" min="0" max="10000000" step="1" placeholder="Kosong = belum ada biaya"></label></div>
        <label>Alasan perubahan<input name="reason" maxlength="160" placeholder="Contoh: invoice supplier September" required></label><p role="status"></p><button class="button button-primary" type="submit">Simpan bahan</button>
      </form>
      <form id="hpp-recipe-editor" class="hpp-editor-card"><div><p class="eyebrow">2 · Komponen resep</p><h3>Hubungkan bahan ke menu</h3></div>
        <label>Menu<select name="productId" required ${products.length ? "" : "disabled"}>${productOptions}</select></label>
        <label>Bahan<select name="ingredientId" required ${ingredients.length ? "" : "disabled"}>${ingredients.length ? ingredientOptions : '<option value="">Buat master bahan terlebih dahulu</option>'}</select></label>
        <label>Jumlah pemakaian<input name="qty" type="number" min="0.001" max="1000000" step="0.001" placeholder="Contoh: 18" required ${ingredients.length ? "" : "disabled"}></label>
        <label>Alasan perubahan<input name="reason" maxlength="160" placeholder="Contoh: recipe card bar v2" required ${ingredients.length ? "" : "disabled"}></label><p role="status"></p><button class="button button-primary" type="submit" ${ingredients.length ? "" : "disabled"}>Tambahkan ke resep</button>
      </form>
      <form id="hpp-modifier-recipe-editor" class="hpp-editor-card"><div><p class="eyebrow">2B · Recipe delta modifier</p><h3>Biaya tambahan menu</h3><small>Mapping ini membuat Extra Shot/Oat Milk ikut masuk snapshot HPP dan konsumsi stok.</small></div>
        <label>Modifier berbayar<select name="modifierKey" required ${modifierOptions ? "" : "disabled"}>${modifierOptions || '<option value="">Tidak ada modifier berbayar</option>'}</select></label>
        <label>Bahan<select name="ingredientId" required ${ingredients.length ? "" : "disabled"}>${ingredients.length ? ingredientOptions : '<option value="">Buat master bahan terlebih dahulu</option>'}</select></label>
        <label>Jumlah delta<input name="qty" type="number" min="0.001" max="1000000" step="0.001" placeholder="Contoh: 7" required ${ingredients.length && modifierOptions ? "" : "disabled"}></label>
        <label>Alasan perubahan<input name="reason" maxlength="160" placeholder="Contoh: recipe delta Extra Shot" required ${ingredients.length && modifierOptions ? "" : "disabled"}></label><p role="status"></p><button class="button button-primary" type="submit" ${ingredients.length && modifierOptions ? "" : "disabled"}>Simpan recipe delta</button>
      </form>
      <form id="hpp-fulfillment-recipe-editor" class="hpp-editor-card"><div><p class="eyebrow">2C · Packaging order</p><h3>Biaya Take Away</h3><small>Mapping cup, lid, sleeve, paper bag, atau segel per item agar packaging tidak hilang dari HPP.</small></div>
        <div class="hpp-form-row"><label>Tipe order<select name="orderType" required><option value="TAKEAWAY">Take Away</option></select></label><label>Station<select name="station" required><option value="bar">BAR · minuman</option><option value="food">FOOD · makanan</option></select></label></div>
        <label>Bahan packaging<select name="ingredientId" required ${ingredients.length ? "" : "disabled"}>${ingredients.length ? ingredientOptions : '<option value="">Buat master bahan packaging terlebih dahulu</option>'}</select></label>
        <label>Jumlah per item<input name="qty" type="number" min="0.001" max="1000000" step="0.001" placeholder="Contoh: 1" required ${ingredients.length ? "" : "disabled"}></label>
        <label>Alasan perubahan<input name="reason" maxlength="160" placeholder="Contoh: cup PET 16 oz untuk minuman takeaway" required ${ingredients.length ? "" : "disabled"}></label><p role="status"></p><button class="button button-primary" type="submit" ${ingredients.length ? "" : "disabled"}>Simpan packaging HPP</button>
      </form>
    </div>
    <div class="hpp-receipt-table" role="region" aria-label="Recipe delta modifier berbayar" tabindex="0">${modifierRecipeRows ? `<table><caption>Mapping HPP modifier berbayar</caption><thead><tr><th scope="col">Modifier</th><th scope="col">Bahan</th><th scope="col">Jumlah</th><th scope="col">Aksi</th></tr></thead><tbody>${modifierRecipeRows}</tbody></table>` : `<p class="hpp-empty-receipt">Modifier berbayar belum punya recipe delta. Add-on tetap dijual sesuai harga server, tetapi laba/HPP ditandai parsial sampai mapping dibuat.</p>`}</div>
    <div class="hpp-receipt-table" role="region" aria-label="Recipe packaging Take Away" tabindex="0">${fulfillmentRecipeRows ? `<table><caption>Mapping HPP packaging per item</caption><thead><tr><th scope="col">Order</th><th scope="col">Bahan</th><th scope="col">Jumlah</th><th scope="col">Aksi</th></tr></thead><tbody>${fulfillmentRecipeRows}</tbody></table>` : `<p class="hpp-empty-receipt">Packaging Take Away belum punya recipe. Dine-in tetap tidak memakai packaging; Take Away ditandai parsial sampai cup/lid/bag dimapping.</p>`}</div>
    <section class="hpp-purchase-panel"><div class="section-heading"><div><p class="eyebrow">3 · Supplier & purchase order</p><h3>Rencanakan pembelian sebelum menerima stok</h3><p>Supplier reusable dan PO internal menyimpan expected date, kemasan, kuantitas serta unit cost. PO tidak mengirim pesan eksternal dan belum menambah stok sebelum penerimaan dicatat.</p></div><span class="hpp-gate-badge ${hpp?.purchaseOrderCount ? "is-active" : "is-draft"}">${hpp?.purchaseOrderCount ?? 0} PO</span></div>
      <div class="hpp-editor-grid"><form id="hpp-supplier-editor" class="hpp-editor-card"><div><p class="eyebrow">Master supplier</p><h3>Identitas operasional minimum</h3></div><label>Nama supplier<input name="name" maxlength="80" placeholder="Contoh: Roastery partner (dummy)" required></label><label>Lead time standar (hari)<input name="leadTimeDays" type="number" min="0" max="365" step="1" value="3" required></label><label>Status<select name="active"><option value="true">Aktif</option><option value="false">Nonaktif</option></select></label><label>Alasan<input name="reason" maxlength="160" placeholder="Contoh: setup supplier sintetis" required></label><p role="status"></p><button class="button button-primary" type="submit">Simpan supplier</button></form>
      <form id="hpp-purchase-order-create" class="hpp-editor-card hpp-po-lines-form" data-po-disabled="${supplierOptions && ingredients.length ? "false" : "true"}"><input type="hidden" name="idempotencyKey" value="po-${escapeHtml(crypto.randomUUID())}"><div><p class="eyebrow">Purchase order internal</p><h3>Rencana pembelian multi-item</h3><small>Tambahkan sampai 100 bahan. Ringkasan biaya dihitung di layar dan diverifikasi ulang oleh server.</small></div><label>Supplier<select name="supplierId" required ${supplierOptions ? "" : "disabled"}>${supplierOptions || '<option value="">Buat supplier lebih dulu</option>'}</select></label><label>Perkiraan tiba<input name="expectedDate" type="date" required ${supplierOptions ? "" : "disabled"}></label><div class="hpp-po-lines">${ingredients.length ? renderPurchaseOrderLine(null, ingredients, 0) : '<p class="hpp-empty-receipt">Buat bahan lebih dulu.</p>'}</div>${ingredients.length ? renderPurchaseOrderDraftTools(ingredients, 1, 0) : ""}<label>Alasan<input name="reason" maxlength="160" placeholder="Contoh: restock buffer tiga hari" required></label><p role="status"></p><button class="button button-primary" type="submit" ${supplierOptions && ingredients.length ? "" : "disabled"}>Buat PO internal</button></form></div>
      <div class="hpp-receipt-table" role="region" aria-label="Purchase order internal" tabindex="0">${purchaseOrderRows ? `<table><caption>PO terbaru, maksimal 20</caption><thead><tr><th scope="col">Supplier</th><th scope="col">Expected</th><th scope="col">Item</th><th scope="col">Nilai</th><th scope="col">Alasan</th><th scope="col">Status</th></tr></thead><tbody>${purchaseOrderRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada PO. Data dummy harus diberi label dan dapat diganti sebelum operasional.</p>`}</div>
      ${purchaseOrderManagement ? `<div class="hpp-po-manage-grid" aria-label="Kontrol revisi dan pembatalan PO">${purchaseOrderManagement}</div>` : ""}
      ${purchaseOrderReceiving ? `<div class="hpp-po-receive-grid" aria-label="PO menunggu penerimaan">${purchaseOrderReceiving}</div>` : `<p class="hpp-empty-receipt hpp-po-complete">Tidak ada PO yang menunggu penerimaan.</p>`}
    </section>
    <section class="hpp-purchase-panel"><div class="section-heading"><div><p class="eyebrow">4 · Invoice & AP control</p><h3>Cocokkan PO, barang diterima, dan invoice</h3><p>Invoice parsial dibandingkan dengan kuantitas receipt, harga PO, dan biaya tambahan yang belum ditagih. Hasil exception otomatis diblokir; hasil cocok baru siap diajukan, bukan dibayar.</p></div><span class="hpp-gate-badge ${(hpp?.purchaseInvoiceCount ?? 0) ? "is-active" : "is-draft"}">${hpp?.purchaseInvoiceMatchedCount ?? 0} / ${hpp?.purchaseInvoiceCount ?? 0} COCOK</span></div>
      ${purchaseInvoiceAuthoring ? `<div class="hpp-invoice-grid" aria-label="Invoice supplier menunggu pencocokan">${purchaseInvoiceAuthoring}</div>` : `<p class="hpp-empty-receipt">Belum ada receipt baik yang belum ditagih. Terima barang dari PO terlebih dahulu.</p>`}
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat pencocokan invoice supplier" tabindex="0">${purchaseInvoiceRows ? `<table><caption>Invoice supplier terbaru, maksimal 20</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Tanggal</th><th scope="col">Pencocokan line</th><th scope="col">Nilai</th><th scope="col">Status AP</th></tr></thead><tbody>${purchaseInvoiceRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada invoice supplier dicocokkan.</p>`}</div>
      ${purchaseCreditRows ? `<div class="hpp-receipt-table" role="region" aria-label="Credit memo supplier" tabindex="0"><table><caption>Credit memo non-stok terbaru</caption><thead><tr><th scope="col">Credit note</th><th scope="col">Tanggal & jenis</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${purchaseCreditRows}</tbody></table></div>` : ""}
      ${purchasePaymentRows ? `<div class="hpp-receipt-table" role="region" aria-label="Pembayaran supplier tercatat" tabindex="0"><table><caption>Settlement pembayaran supplier internal</caption><thead><tr><th scope="col">Referensi</th><th scope="col">Tanggal & metode</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${purchasePaymentRows}</tbody></table></div>` : ""}
    </section>
    <section class="hpp-purchase-panel"><div class="section-heading"><div><p class="eyebrow">5 · Retur & replacement supplier</p><h3>Pisahkan perpindahan fisik dari credit</h3><p>Retur selalu menunjuk receipt asal dan mengurangi stok saat barang dikirim. Replacement baru memulihkan stok setelah benar-benar diterima; permintaan credit tetap menunggu dokumen Finance.</p></div><span class="hpp-gate-badge ${(hpp?.supplierReturnCount ?? 0) ? "is-active" : "is-draft"}">${hpp?.supplierReturnCount ?? 0} RETUR</span></div>
      ${purchaseReturnAuthoring ? `<div class="hpp-invoice-grid" aria-label="Barang tersedia untuk retur supplier">${purchaseReturnAuthoring}</div>` : `<p class="hpp-empty-receipt">Tidak ada quantity receipt yang masih dapat diretur.</p>`}
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat retur dan replacement supplier" tabindex="0">${purchaseReturnRows ? `<table><caption>Retur supplier terbaru, maksimal 20</caption><thead><tr><th scope="col">Referensi</th><th scope="col">Barang</th><th scope="col">Nilai & tindak lanjut</th><th scope="col">Status</th></tr></thead><tbody>${purchaseReturnRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada retur fisik supplier.</p>`}</div>
    </section>
    <section class="hpp-purchase-panel"><div class="section-heading"><div><p class="eyebrow">6 · Penerimaan tanpa PO</p><h3>Konversi kemasan & moving average</h3><p>Gunakan jalur ini hanya bila barang datang tanpa PO internal. Masukkan total biaya invoice; penerimaan yang terkait PO wajib memakai kartu “Terima dari PO” agar sisa pesanan tetap akurat.</p></div></div>
      <form id="hpp-purchase-receipt" class="hpp-purchase-form"><input type="hidden" name="idempotencyKey" value="purchase-${escapeHtml(crypto.randomUUID())}"><label>Supplier<input name="supplierName" maxlength="80" placeholder="Contoh: Roastery partner" required></label><label>Bahan<select name="ingredientId" required ${ingredients.length ? "" : "disabled"}>${ingredients.length ? ingredientOptions : '<option value="">Buat master bahan lebih dulu</option>'}</select></label><label>Nama kemasan<input name="purchaseUnitLabel" maxlength="80" placeholder="Contoh: bag 1 kg" required></label><label>Jumlah kemasan<input name="purchaseQuantity" type="number" min="0.001" max="1000000" step="0.001" value="1" required></label><label>Isi per kemasan<input name="baseUnitsPerPurchaseUnit" type="number" min="0.001" max="1000000" step="0.001" placeholder="Contoh: 1000" required><small>Gunakan satuan dasar bahan: gram, ml, atau pcs.</small></label><label>Total biaya bahan (Rp)<input name="totalCostRupiah" type="number" min="1" max="1000000000" step="1" required></label><label class="hpp-purchase-reason">Alasan penerimaan<input name="reason" maxlength="160" placeholder="Contoh: invoice supplier 006" required></label><p role="status"></p><button class="button button-primary" type="submit" ${ingredients.length ? "" : "disabled"}>Terima & hitung biaya</button></form>
      <div class="hpp-balance-grid">${ingredients.map((ingredient) => { const balance = balances.get(ingredient.id); return `<article><span>${escapeHtml(ingredient.name)}</span><strong>${balance ? `${formatQuantity(balance.quantityBase)} ${escapeHtml(ingredient.baseUnit)}` : "Belum ada penerimaan"}</strong><small>${balance ? `${rupiah(balance.inventoryValueRupiah)} · rata-rata ${rupiahPerUnit(balance.averageCostPerBaseUnitRupiah)}/${escapeHtml(ingredient.baseUnit)}` : "Biaya masih manual atau belum tersedia"}</small></article>`; }).join("")}</div>
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat penerimaan bahan" tabindex="0">${receiptRows ? `<table><caption>Penerimaan terbaru, maksimal 20 receipt</caption><thead><tr><th scope="col">Supplier</th><th scope="col">Diterima</th><th scope="col">Konversi</th><th scope="col">Biaya</th><th scope="col">Alasan</th></tr></thead><tbody>${receiptRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada penerimaan. Biaya manual tetap ditandai sampai receipt pertama disimpan.</p>`}</div>
    </section>
    <section class="hpp-full-count-panel"><div class="section-heading"><div><p class="eyebrow">7 · Full inventory count</p><h3>Hitung semua bahan sebagai satu sesi</h3><p>Isi hasil fisik setiap bahan. Kolom sengaja kosong agar petugas tidak menyalin saldo sistem. Server menolak count parsial dan membatalkan seluruh perubahan jika satu baris gagal.</p></div><span class="hpp-gate-badge ${hpp?.inventoryCountCount ? "is-active" : "is-draft"}">${hpp?.inventoryCountCount ?? 0} SELESAI</span></div>
      <form id="hpp-full-inventory-count" class="hpp-full-count-form"><input type="hidden" name="idempotencyKey" value="full-count-${escapeHtml(crypto.randomUUID())}"><div class="hpp-count-grid">${managedIngredients.length ? managedIngredients.map((ingredient) => { const balance = balances.get(ingredient.id); return `<label><span>${escapeHtml(ingredient.name)}</span><small>Saldo sistem ${formatQuantity(balance.quantityBase)} ${escapeHtml(ingredient.baseUnit)}</small><input data-count-ingredient="${escapeHtml(ingredient.id)}" type="number" min="0" max="1000000000000" step="0.001" inputmode="decimal" placeholder="Hasil fisik" aria-label="Hasil fisik ${escapeHtml(ingredient.name)} (${escapeHtml(ingredient.baseUnit)})" required></label>`; }).join("") : `<p class="hpp-empty-receipt">Belum ada bahan dengan penerimaan. Full count baru tersedia setelah saldo awal tercatat.</p>`}</div><label class="hpp-full-count-reason">Alasan / referensi sesi<input name="reason" maxlength="160" required placeholder="Contoh: full count tutup bulan September"></label><p role="status"></p><button class="button button-primary" type="submit" ${managedIngredients.length ? "" : "disabled"}>Review lengkap & selesaikan count</button></form>
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat full inventory count" tabindex="0">${countRows ? `<table><caption>Sesi full count selesai, maksimal 10 sesi</caption><thead><tr><th scope="col">Selesai</th><th scope="col">Coverage</th><th scope="col">Selisih nilai</th><th scope="col">Alasan & pelaku</th><th scope="col">Status</th></tr></thead><tbody>${countRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada full count selesai. Cycle count di bawah tidak digunakan sebagai anchor periode.</p>`}</div>
    </section>
    <section class="hpp-full-count-panel"><div class="section-heading"><div><p class="eyebrow">8 · Tutup periode inventory</p><h3>Kunci pasangan count untuk audit</h3><p>Pilih count pembuka dan penutup yang sudah selesai. Server mengunci urutan, coverage bahan dan batas versi; periode berikutnya harus dimulai dari count penutup terakhir.</p></div><span class="hpp-gate-badge ${(hpp?.inventoryPeriodCount ?? 0) ? "is-active" : "is-draft"}">${hpp?.inventoryPeriodCount ?? 0} DITUTUP</span></div>
      <form id="hpp-inventory-period-close" class="hpp-purchase-form"><input type="hidden" name="idempotencyKey" value="period-${escapeHtml(crypto.randomUUID())}"><label>Count pembuka<select name="openingCountId" required ${counts.length >= 2 ? "" : "disabled"}>${countOptions}</select></label><label>Count penutup<select name="closingCountId" required ${counts.length >= 2 ? "" : "disabled"}>${countOptions}</select></label><label class="hpp-purchase-reason">Alasan dan periode<input name="reason" maxlength="160" required placeholder="Contoh: tutup inventory 1–7 September"></label><label class="hpp-period-confirm"><input name="confirmed" type="checkbox" required> Saya sudah meninjau variance dan memahami periode tidak dapat diedit.</label><p role="status"></p><button class="button button-primary" type="submit" ${counts.length >= 2 ? "" : "disabled"}>Tutup periode inventory</button></form>
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat periode inventory tertutup" tabindex="0">${periodRows ? `<table><caption>Periode tertutup terbaru, maksimal 10</caption><thead><tr><th scope="col">Pembuka</th><th scope="col">Penutup</th><th scope="col">Batas versi</th><th scope="col">Alasan & pelaku</th><th scope="col">Status</th></tr></thead><tbody>${periodRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada periode ditutup. Dibutuhkan dua full count dengan coverage bahan yang sama.</p>`}</div>
    </section>
    <section class="hpp-inventory-panel"><div class="section-heading"><div><p class="eyebrow">9 · Ledger stok</p><h3>Penjualan, count, dan waste dalam satu riwayat</h3><p>Order baru mengurangi bahan setelah pembayaran terkonfirmasi. Cycle count berisi jumlah fisik yang terlihat; shortage ditandai untuk diperiksa tanpa membatalkan pembayaran.</p></div><span class="hpp-gate-badge is-draft">${hpp?.inventoryMovementCount ?? 0} CATATAN</span></div>
      <form id="hpp-inventory-movement" class="hpp-purchase-form"><input type="hidden" name="idempotencyKey" value="movement-${escapeHtml(crypto.randomUUID())}"><label>Jenis pencatatan<select name="movementType"><option value="CYCLE_COUNT">Cycle count · saldo fisik</option><option value="SPOILAGE_WASTE">Basi / kedaluwarsa</option><option value="PRODUCTION_WASTE">Waste produksi</option><option value="DAMAGED">Rusak</option><option value="INTERNAL_USE">Pemakaian internal</option><option value="SAMPLES_PROMOTIONAL">Sampel / promosi</option><option value="LOSS_THEFT">Hilang / pencurian</option></select></label><label>Bahan<select name="ingredientId" required ${balanceOptions ? "" : "disabled"}>${balanceOptions || '<option value="">Terima bahan lebih dulu</option>'}</select></label><label>Jumlah satuan dasar<input name="quantityBase" type="number" min="0" max="1000000000000" step="0.001" required placeholder="Contoh: 950"><small>Cycle count = saldo aktual. Lainnya = jumlah pengurangan.</small></label><label class="hpp-purchase-reason">Alasan / bukti operasional<input name="reason" maxlength="160" required placeholder="Contoh: hitung tutup shift 6 September"></label><p role="status"></p><button class="button button-primary" type="submit" ${balanceOptions ? "" : "disabled"}>Simpan pencatatan stok</button></form>
      <div class="hpp-receipt-table" role="region" aria-label="Riwayat cycle count dan pengurangan stok" tabindex="0">${movementRows ? `<table><caption>Riwayat stok terbaru, maksimal 20 catatan</caption><thead><tr><th scope="col">Jenis</th><th scope="col">Bahan</th><th scope="col">Sebelum → sesudah</th><th scope="col">Dampak nilai</th><th scope="col">Alasan & pelaku</th></tr></thead><tbody>${movementRows}</tbody></table>` : `<p class="hpp-empty-receipt">Belum ada cycle count atau waste. Mulai setelah penerimaan pertama agar nilai HPP memiliki sumber.</p>`}</div>
    </section>
    <div class="hpp-product-list" role="region" aria-label="Daftar status resep dan HPP menu" tabindex="0"><div class="section-heading"><div><p class="eyebrow">10 · Audit menu</p><h3>HPP, margin, dan target</h3></div><small>Harga saran dibulatkan ke Rp500</small></div>${products.map((product) => renderHppProduct(product, ingredientById)).join("")}</div>
    <form id="hpp-gate-editor" class="hpp-gate-control"><div><p class="eyebrow">11 · Release guard</p><h3>Wajibkan resep minuman lengkap</h3><p>Saat aktif, checkout minuman tanpa resep terverifikasi ditolak dan perubahan biaya tidak boleh diam-diam merusak coverage.</p></div><label>Mode<select name="enabled"><option value="false" ${!hpp?.gateEnabled ? "selected" : ""}>Draft · masih melengkapi resep</option><option value="true" ${hpp?.gateEnabled ? "selected" : ""}>Aktif · blokir resep minuman tidak lengkap</option></select></label><label>Alasan perubahan<input name="reason" maxlength="160" required placeholder="Contoh: seluruh recipe card sudah disetujui"></label><p role="status"></p><button class="button button-primary" type="submit">Simpan gate</button></form>
  </section>`;
}

function renderHppProduct(product, ingredientById) {
  const verified = product.hppStatus === "VERIFIED";
  const lines = product.recipeItems.map((line) => {
    const ingredient = ingredientById.get(line.ingredientId);
    return `<li><div><strong>${escapeHtml(ingredient?.name ?? "Bahan tidak ditemukan")}</strong><small>${escapeHtml(line.qty)} ${escapeHtml(ingredient?.baseUnit ?? "")}${ingredient?.costStatus === "UNPRICED" ? " · biaya belum ada" : ""}</small></div><form class="hpp-remove-form"><input type="hidden" name="productId" value="${escapeHtml(product.id)}"><input type="hidden" name="ingredientId" value="${escapeHtml(line.ingredientId)}"><label><span class="sr-only">Alasan hapus ${escapeHtml(ingredient?.name ?? "bahan")}</span><input name="reason" maxlength="160" required placeholder="Alasan hapus"></label><button class="button button-ghost" type="submit">Hapus</button></form></li>`;
  }).join("");
  return `<article class="hpp-product-row ${verified ? "is-verified" : "is-incomplete"}"><div class="hpp-product-title"><span class="hpp-status">${verified ? "TERVERIFIKASI" : "BELUM LENGKAP"}</span><h4>${escapeHtml(product.name)}</h4><small>${product.station === "bar" ? "Minuman" : "Makanan"} · target margin ${product.targetMarginPct}% · recipe v${product.recipeVersion ?? "—"}</small></div><div class="hpp-product-metrics"><div><span>HPP</span><strong>${verified ? rupiah(product.hppRupiah) : "—"}</strong></div><div><span>Margin</span><strong>${verified ? `${product.marginPct}%` : "—"}</strong></div><div><span>Harga saran</span><strong>${verified ? rupiah(product.suggestedPriceRupiah) : "—"}</strong></div></div><div class="hpp-recipe-lines">${lines ? `<ul>${lines}</ul>` : `<p>Belum ada bahan. Tambahkan komponen resep untuk mulai menghitung HPP.</p>`}</div></article>`;
}

function uniqueModifierOptions(products) {
  const seen = new Set();
  const rows = [];
  for (const product of products) {
    for (const group of product.modifierGroups ?? []) {
      for (const option of group.options ?? []) {
        if (!Number.isSafeInteger(option.priceDeltaRupiah) || option.priceDeltaRupiah <= 0) continue;
        const key = `${group.id}:${option.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ groupId: group.id, groupLabel: group.label, optionId: option.id, optionLabel: option.label, priceDeltaRupiah: option.priceDeltaRupiah });
      }
    }
  }
  return rows.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, "id") || a.optionLabel.localeCompare(b.optionLabel, "id"));
}

function renderModifierRecipeRows(recipes, ingredientById) {
  return recipes.flatMap((recipe) => recipe.items.map((line) => {
    const ingredient = ingredientById.get(line.ingredientId);
    return `<tr><th scope="row">${escapeHtml(recipe.optionId)}<small>${escapeHtml(recipe.groupId)} · v${recipe.version}</small></th><td>${escapeHtml(ingredient?.name ?? "Bahan tidak ditemukan")}</td><td>${formatQuantity(line.qty)} ${escapeHtml(ingredient?.baseUnit ?? "")}</td><td><form class="hpp-modifier-remove-form"><input type="hidden" name="groupId" value="${escapeHtml(recipe.groupId)}"><input type="hidden" name="optionId" value="${escapeHtml(recipe.optionId)}"><input type="hidden" name="ingredientId" value="${escapeHtml(line.ingredientId)}"><label><span class="sr-only">Alasan hapus recipe delta ${escapeHtml(recipe.optionId)}</span><input name="reason" maxlength="160" required placeholder="Alasan hapus"></label><button class="button button-ghost" type="submit">Hapus</button></form></td></tr>`;
  })).join("");
}

function renderFulfillmentRecipeRows(recipes, ingredientById) {
  return recipes.flatMap((recipe) => recipe.items.map((line) => {
    const ingredient = ingredientById.get(line.ingredientId);
    const orderLabel = recipe.orderType === "TAKEAWAY" ? "Take Away" : recipe.orderType;
    const stationLabel = recipe.station === "bar" ? "BAR · minuman" : "FOOD · makanan";
    return `<tr><th scope="row">${escapeHtml(orderLabel)}<small>${escapeHtml(stationLabel)} · v${recipe.version}</small></th><td>${escapeHtml(ingredient?.name ?? "Bahan tidak ditemukan")}</td><td>${formatQuantity(line.qty)} ${escapeHtml(ingredient?.baseUnit ?? "")}</td><td><form class="hpp-fulfillment-remove-form"><input type="hidden" name="orderType" value="${escapeHtml(recipe.orderType)}"><input type="hidden" name="station" value="${escapeHtml(recipe.station)}"><input type="hidden" name="ingredientId" value="${escapeHtml(line.ingredientId)}"><label><span class="sr-only">Alasan hapus packaging ${escapeHtml(orderLabel)} ${escapeHtml(stationLabel)}</span><input name="reason" maxlength="160" required placeholder="Alasan hapus"></label><button class="button button-ghost" type="submit">Hapus</button></form></td></tr>`;
  })).join("");
}

function hppErrorMessage(error) {
  const messages = {
    hpp_version_conflict: "Data HPP berubah di perangkat lain. Muat ulang lalu tinjau data terbaru.",
    hpp_gate_would_break: "Lengkapi semua resep minuman dan biaya bahannya sebelum mengaktifkan gate.",
    hpp_modifier_gate_would_break: "Lengkapi recipe delta semua modifier berbayar sebelum mengaktifkan gate.",
    hpp_modifier_recipe_required: "Modifier berbayar ini belum memiliki recipe delta HPP.",
    fulfillment_recipe_key_invalid: "Tipe order atau station packaging tidak valid. Muat ulang data lalu coba lagi.",
    fulfillment_recipe_quantity_invalid: "Jumlah packaging harus lebih dari 0 dan maksimal tiga angka desimal.",
    fulfillment_recipe_line_not_found: "Komponen packaging tidak ditemukan. Muat ulang lalu coba lagi.",
    modifier_recipe_key_invalid: "Modifier tidak valid. Muat ulang katalog lalu pilih modifier berbayar yang tersedia.",
    modifier_recipe_quantity_invalid: "Jumlah delta modifier harus lebih dari 0 dan maksimal tiga angka desimal.",
    modifier_recipe_line_not_found: "Komponen recipe delta modifier tidak ditemukan. Muat ulang lalu coba lagi.",
    ingredient_name_conflict: "Nama bahan sudah digunakan. Pilih data tersebut untuk memperbaruinya.",
    ingredient_cost_invalid: "Biaya bahan harus angka rupiah bulat, minimal Rp0.",
    recipe_quantity_invalid: "Jumlah pemakaian harus lebih dari 0 dan maksimal tiga angka desimal.",
    supplier_name_invalid: "Nama supplier wajib diisi, maksimal 80 karakter tanpa markup.",
    supplier_lead_time_invalid: "Lead time harus berupa hari bulat antara 0 dan 365.",
    supplier_name_conflict: "Nama supplier sudah digunakan.",
    supplier_inactive: "Supplier nonaktif tidak dapat dipakai membuat PO baru.",
    purchase_order_expected_date_invalid: "Isi tanggal perkiraan tiba yang valid.",
    purchase_order_quantity_invalid: "Jumlah PO harus lebih dari 0 dan maksimal tiga angka desimal.",
    purchase_order_unit_cost_invalid: "Biaya per kemasan harus berupa rupiah bulat lebih dari 0.",
    purchase_order_idempotency_conflict: "Nomor PO internal sudah dipakai untuk data berbeda.",
    purchase_order_action_idempotency_conflict: "Aksi PO sudah diproses dengan data berbeda. Muat ulang dan periksa riwayat.",
    purchase_order_not_found: "PO tidak ditemukan. Muat ulang lalu pilih data terbaru.",
    purchase_order_edit_locked_after_receipt: "Detail PO sudah terkunci karena penerimaan dimulai. Batalkan sisa lalu buat PO baru bila rencana berubah.",
    purchase_order_cancelled: "PO sudah dibatalkan dan tidak dapat diubah atau menerima stok lagi.",
    purchase_order_cancel_completed: "PO yang sudah diterima lengkap tidak dapat dibatalkan. Gunakan proses koreksi stok terpisah.",
    purchase_order_already_received: "PO sudah diterima lengkap dan tidak dapat menambah stok lagi.",
    purchase_order_quantity_exceeds_remaining: "Jumlah diterima melebihi sisa PO. Periksa barang fisik dan sisa pesanan.",
    purchase_order_receipt_quantity_required: "Isi jumlah barang baik atau barang ditolak.",
    purchase_rejected_quantity_invalid: "Jumlah ditolak harus 0 atau lebih dan maksimal tiga angka desimal.",
    purchase_rejection_reason_required: "Pilih alasan untuk barang yang ditolak.",
    purchase_rejection_reason_without_quantity: "Hapus alasan penolakan bila tidak ada barang yang ditolak.",
    purchase_fee_invalid: "Pilih satu jenis biaya dengan nominal rupiah bulat lebih dari Rp0.",
    purchase_fee_total_invalid: "Total biaya tambahan melewati batas aman.",
    purchase_fee_without_accepted_stock: "Biaya tambahan hanya dapat dialokasikan bila ada barang baik yang masuk stok.",
    purchase_invoice_number_invalid: "Nomor invoice wajib diisi, maksimal 80 karakter tanpa markup.",
    purchase_invoice_date_invalid: "Tanggal invoice dan jatuh tempo harus valid; jatuh tempo tidak boleh lebih awal.",
    purchase_invoice_quantity_invalid: "Jumlah invoice harus lebih dari 0 dan maksimal tiga angka desimal.",
    purchase_invoice_unit_price_invalid: "Harga invoice per unit harus berupa rupiah bulat lebih dari 0.",
    purchase_invoice_total_mismatch: "Total invoice tidak sama dengan jumlah line dan biaya. Periksa dokumen sumber.",
    purchase_invoice_receipt_required: "Belum ada barang baik yang diterima untuk dicocokkan dengan invoice ini.",
    purchase_invoice_number_conflict: "Nomor invoice supplier sudah pernah dicatat. Periksa riwayat sebelum melanjutkan.",
    purchase_invoice_idempotency_conflict: "Pencocokan invoice sudah diproses dengan data berbeda. Muat ulang riwayat.",
    purchase_invoice_post_state_invalid: "Invoice harus disetujui reviewer Finance sebelum diposting.",
    purchase_invoice_poster_separation_required: "Pencatat AP harus berbeda dari reviewer Finance.",
    purchase_invoice_action_idempotency_conflict: "Aksi invoice sudah diproses dengan data berbeda. Muat ulang riwayat.",
    purchase_invoice_credit_post_state_invalid: "Credit memo tidak lagi menunggu posting. Muat ulang riwayat.",
    purchase_invoice_credit_poster_separation_required: "Owner yang memposting harus berbeda dari Finance pembuat credit memo.",
    purchase_invoice_credit_state_invalid: "Invoice tidak memiliki outstanding yang dapat dikoreksi.",
    purchase_invoice_payment_role_denied: "Hanya Owner yang boleh mencatat pembayaran supplier.",
    purchase_invoice_payment_state_invalid: "Invoice tidak memiliki outstanding yang dapat dibayar.",
    purchase_invoice_payment_credit_pending: "Selesaikan credit memo atau reversal yang masih pending sebelum mencatat pembayaran.",
    purchase_invoice_payment_date_invalid: "Tanggal pembayaran tidak valid untuk invoice ini.",
    purchase_invoice_payment_method_invalid: "Pilih metode pembayaran supplier yang valid.",
    purchase_invoice_payment_reference_invalid: "Referensi pembayaran wajib diisi tanpa karakter khusus.",
    purchase_invoice_payment_amount_invalid: "Nominal pembayaran harus lebih dari nol dan tidak melebihi outstanding.",
    purchase_invoice_payment_idempotency_conflict: "Referensi pembayaran sudah dipakai untuk data berbeda.",
    purchase_invoice_credit_reversal_state_invalid: "Credit memo tidak dapat direversal pada status saat ini. Muat ulang riwayat.",
    purchase_invoice_credit_reversal_pending: "Credit memo sudah menunggu keputusan reversal.",
    purchase_invoice_credit_reversal_separation_required: "Owner pemutus harus berbeda dari Finance pemohon reversal.",
    purchase_invoice_credit_reversal_decision_invalid: "Pilih setujui atau tolak untuk keputusan reversal.",
    purchase_invoice_credit_reversal_idempotency_conflict: "Referensi keputusan reversal sudah dipakai untuk data berbeda.",
    purchase_order_line_not_found: "Bahan tidak terdapat pada PO tersebut.",
    purchase_order_cost_mismatch: "Nilai penerimaan tidak sama dengan biaya yang dikunci pada PO.",
    purchase_order_line_mismatch: "Kemasan atau konversi tidak sama dengan PO. Buat penerimaan tanpa PO bila dokumen sumber memang berbeda.",
    purchase_order_receipt_ingredient_duplicate: "Satu bahan hanya boleh diterima satu kali dalam satu submit.",
    purchase_idempotency_conflict: "Nomor penerimaan sudah dipakai untuk data berbeda. Muat ulang dan periksa receipt.",
    purchase_conversion_invalid: "Isi per kemasan harus lebih dari 0 dan maksimal tiga angka desimal.",
    purchase_quantity_invalid: "Jumlah barang baik harus 0 atau lebih dan maksimal tiga angka desimal.",
    purchase_cost_invalid: "Total biaya barang harus berupa rupiah bulat dan sesuai jumlah yang diterima.",
    purchase_unit_cost_overflow: "Biaya per satuan hasil konversi terlalu besar. Periksa jumlah kemasan, isi, dan total biaya.",
    inventory_movement_type_invalid: "Pilih jenis pencatatan stok yang tersedia.",
    inventory_quantity_invalid: "Jumlah harus maksimal tiga angka desimal. Pengurangan harus lebih dari 0; cycle count boleh 0.",
    inventory_quantity_insufficient: "Jumlah pengurangan melebihi saldo. Lakukan cycle count jika saldo sistem perlu dikoreksi.",
    inventory_value_overflow: "Nilai persediaan hasil count berada di luar batas aman. Periksa jumlah dan satuan dasar.",
    inventory_cost_required: "Bahan belum memiliki saldo bernilai. Simpan penerimaan bahan terlebih dahulu.",
    inventory_movement_idempotency_conflict: "Nomor pencatatan sudah dipakai untuk data berbeda. Muat ulang dan periksa riwayat.",
    inventory_count_lines_invalid: "Full count harus berisi sedikitnya satu bahan.",
    inventory_count_incomplete: "Full count belum lengkap. Isi semua bahan yang memiliki saldo sebelum menyelesaikan sesi.",
    inventory_count_ingredient_duplicate: "Satu bahan tercatat lebih dari sekali pada sesi ini.",
    inventory_count_idempotency_conflict: "Nomor sesi full count sudah digunakan untuk data berbeda. Muat ulang dan periksa riwayat.",
    inventory_period_count_not_found: "Count pembuka atau penutup tidak ditemukan. Muat ulang data terbaru.",
    inventory_period_order_invalid: "Count penutup harus lebih baru daripada count pembuka.",
    inventory_period_coverage_mismatch: "Coverage bahan kedua count berbeda. Buat full count baru dengan bahan yang sama.",
    inventory_period_sequence_conflict: "Periode berikutnya harus dimulai dari count penutup terakhir.",
    inventory_period_already_closed: "Count penutup tersebut sudah digunakan pada periode tertutup.",
    inventory_period_idempotency_conflict: "Nomor penutupan periode sudah dipakai untuk pasangan count berbeda.",
    ingredient_unit_locked_after_receipt: "Satuan dasar terkunci karena sudah memiliki riwayat penerimaan.",
    ingredient_cost_purchase_managed: "Biaya bahan ini dikelola otomatis dari moving average penerimaan.",
  };
  return messages[error.code] ?? error.message;
}

function integrationRow(key, rawValue) {
  const labels = { qris: "QRIS gateway", member: "Saga Member", reward: "Reward", printer: "Printer", nfc: "NFC", persistence: "Penyimpanan", staging: "Staging", production: "Production" };
  const value = String(rawValue || "").toUpperCase();
  let status = { label: "Perlu verifikasi", note: "Status belum diklasifikasikan", tone: "warning" };
  if (value.includes("LOCAL_SIMULATOR")) status = { label: "Simulator lokal", note: "Belum payment production", tone: "warning" };
  else if (value.includes("EXTERNAL_CONTRACT_PENDING")) status = { label: "Kontrak pending", note: "Belum diuji eksternal", tone: "warning" };
  else if (value.includes("HARDWARE_UNAVAILABLE")) status = { label: "Belum tersedia", note: "Hardware belum diuji", tone: "blocked" };
  else if (value.includes("POSTGRES_EVIDENCE_EXISTS") || value.includes("POS_LAB_IN_MEMORY")) status = { label: "Lokal tervalidasi", note: "Runtime eksternal belum diuji", tone: "local" };
  else if (value.includes("NOT_AUTHORIZED") || value.includes("NOT_RUN")) status = { label: "Belum diotorisasi", note: "Tidak dijalankan", tone: "blocked" };
  else if (value.includes("READY") || value.includes("ACTIVE")) status = { label: "Siap", note: "Status server aktif", tone: "ready" };
  return `<div class="tone-${status.tone}"><span>${escapeHtml(labels[key] || key.replaceAll("_", " "))}</span><strong>${escapeHtml(status.label)}</strong><small>${escapeHtml(status.note)}</small></div>`;
}
async function request(url, { method = "GET", body, csrf = false } = {}) { const response = await fetch(url, { method, credentials: "same-origin", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error?.message || "Permintaan gagal."); error.status = response.status; error.code = data.error?.code; throw error; } return data; }
function menuDraftAction(action) { if (!dedicatedMenuWorkspace) return action; const mapping = { "catalog.category.create": "catalog.workspace.category.create", "catalog.promotion.upsert": "catalog.workspace.promotion.upsert", "catalog.promotion.status": "catalog.workspace.promotion.status", "catalog.variant.group.upsert": "catalog.workspace.variant.group.upsert", "catalog.variant.option.upsert": "catalog.workspace.variant.option.upsert", "catalog.modifier.group.upsert": "catalog.workspace.modifier.group.upsert", "catalog.modifier.option.upsert": "catalog.workspace.modifier.option.upsert", "catalog.ordering.update": "catalog.workspace.ordering.update" }; return mapping[action] ?? action; }
function metric(label, value, note, tone = "") { return `<article class="metric-card ${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`; }
function announce(message, danger = false) { clearTimeout(toastTimer); toast.textContent = message; toast.dataset.danger = danger ? "true" : "false"; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 2600); }
function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function rupiahPerUnit(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 1, maximumFractionDigits: 3 }).format(Number(value || 0)); }
function formatQuantity(value) { return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(value || 0)); }
function formatSignedQuantity(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${formatQuantity(number)}`; }
function formatSignedRupiah(value) { const number = Number(value || 0); return `${number > 0 ? "+" : ""}${rupiah(number)}`; }
function inventoryMovementLabel(type) { return ({ SALE_CONSUMPTION: "Pemakaian saat persiapan", CYCLE_COUNT: "Cycle count", SPOILAGE_WASTE: "Basi / kedaluwarsa", PRODUCTION_WASTE: "Waste produksi", DAMAGED: "Rusak", INTERNAL_USE: "Pemakaian internal", SAMPLES_PROMOTIONAL: "Sampel / promosi", LOSS_THEFT: "Hilang / pencurian" })[type] ?? type; }
function purchaseRejectionLabel(type) { return ({ DAMAGED: "rusak saat tiba", MISSING: "tidak dipenuhi supplier", WRONG_ITEM: "barang tidak sesuai", EXPIRED: "kedaluwarsa" })[type] ?? type; }
function purchaseFeeLabel(type) { return ({ SHIPPING: "Pengiriman", HANDLING: "Penanganan", OTHER: "Lainnya" })[type] ?? type; }
function purchaseInvoiceStatusLabel(status) { return ({ READY_FOR_APPROVAL: "MENUNGGU APPROVAL", APPROVED_NOT_POSTED: "DISETUJUI", REJECTED: "DITOLAK", BLOCKED: "EXCEPTION", POSTED_UNPAID: "POSTED · BELUM DIBAYAR" })[status] ?? status; }
function creditTypeLabel(type) { return ({ PRICE_CORRECTION: "Koreksi harga", SERVICE_CREDIT: "Kompensasi layanan", OTHER_NON_STOCK: "Lainnya · non-stok", GOODS_RETURN: "Credit retur barang" })[type] ?? type; }
function purchasePaymentMethodLabel(method) { return ({ BANK_TRANSFER: "Transfer bank", CASH: "Tunai", E_WALLET: "E-wallet", OTHER: "Lainnya" })[method] ?? method; }
function supplierReturnStatusLabel(status) { return ({ SHIPPED_AWAITING_CREDIT: "MENUNGGU CREDIT", CREDIT_RECEIVED_PENDING_POST: "CREDIT MENUNGGU POSTING", CREDIT_POSTED: "CREDIT POSTED", SHIPPED_AWAITING_REPLACEMENT: "MENUNGGU REPLACEMENT", REPLACED: "REPLACEMENT DITERIMA" })[status] ?? status; }
function datePlusDays(value, days) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function purchaseOrderStatusLabel(order) { if (order.status === "CANCELLED") { const received = order.lines.reduce((sum, line) => sum + line.receivedPurchaseQuantity, 0); return received > 0 ? "DIBATALKAN · STOK DITERIMA TETAP" : "DIBATALKAN"; } if (order.lines.length === 1) { const line = order.lines[0]; const processed = line.receivedPurchaseQuantity + (line.rejectedPurchaseQuantity ?? 0); if (order.status === "RECEIVED") return `SELESAI ${formatQuantity(processed)} / ${formatQuantity(line.orderedPurchaseQuantity)}`; if (order.status === "PARTIALLY_RECEIVED") return `PARTIAL ${formatQuantity(processed)} / ${formatQuantity(line.orderedPurchaseQuantity)}`; } const completeLines = order.lines.filter((line) => line.receivedPurchaseQuantity + (line.rejectedPurchaseQuantity ?? 0) === line.orderedPurchaseQuantity).length; return order.status === "RECEIVED" ? "PENERIMAAN SELESAI" : order.status === "PARTIALLY_RECEIVED" ? `PARTIAL · ${completeLines} / ${order.lineCount} BARIS` : "OPEN · INTERNAL"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
