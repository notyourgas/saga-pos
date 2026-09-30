import { productAssetPath, PRODUCT_ASSET_REVIEW_STATUS } from "/menu-product-assets.js";

const app = document.querySelector("#app");
const tableChip = document.querySelector("#table-chip");
const tableLabel = document.querySelector("#table-label");
const toast = document.querySelector("#toast");
const productDialog = document.querySelector("#order-product-dialog");
const productDialogContent = document.querySelector("#order-product-content");
const surface = document.body.dataset.orderSurface === "kiosk" ? "kiosk" : "table";
const apiBase = surface === "kiosk" ? "/api/menu-kiosk" : "/api/table";
const sourceLabel = surface === "kiosk" ? "KIOSK DEMO" : "ORDER DARI MEJA";

const state = {
  snapshot: null, csrfToken: "", categoryId: "", query: "", cart: new Map(), quote: null, checkout: null, busy: false, stream: null, freshness: null,
  screen: surface === "kiosk" ? "home" : "menu", orderType: "", member: null, memberCode: "", memberSource: "", paymentMethod: "QRIS",
  cashReceivedRupiah: 0, modifierDraft: null, reviewPage: 0,
};
const REVIEW_PAGE_SIZE = 5;
function setScreen(screen) { state.screen = screen; app.dataset.screen = screen; }
let statusRetryTimer = null;
let statusRetryDelayMs = 5000;
app.addEventListener("click", handleClick);
productDialog.addEventListener("click", handleClick);
productDialog.addEventListener("click", (event) => { if (event.target === productDialog) productDialog.close(); });
productDialog.addEventListener("cancel", () => { productDialogContent.innerHTML = ""; });
app.addEventListener("input", (event) => {
  if (event.target.matches("[data-menu-search]")) { state.query = event.target.value.slice(0, 60); renderMenu(); const search = app.querySelector("[data-menu-search]"); search?.focus(); search?.setSelectionRange(state.query.length, state.query.length); }
  if (event.target.matches("[data-member-phone]")) state.memberCode = event.target.value.replace(/[^0-9+ -]/g, "").slice(0, 20);
  if (event.target.matches("[data-modifier-note]") && state.modifierDraft) state.modifierDraft.note = event.target.value.slice(0, 120);
});
window.addEventListener("pagehide", stopStatusStream);
window.addEventListener("online", () => {
  if (state.checkout?.order && !state.stream && typeof EventSource === "function") connectStatusStream();
});
await bootstrap();

async function bootstrap() {
  const token = new URL(location.href).searchParams.get("t") || "";
  if (surface === "table" && location.pathname === "/menu/qr" && token && location.hostname === "dashboard.pos.example.invalid") {
    location.replace(`https://pos.example.invalid/order?t=${encodeURIComponent(token)}`);
    return;
  }
  if (surface === "table" && !token) return renderError("QR meja belum terbaca", "Buka halaman ini dengan memindai QR yang tersedia di meja.", "table_token_missing");
  try {
    const snapshot = await api(`${apiBase}/bootstrap`, { method: "POST", body: surface === "kiosk" ? {} : { token } });
    state.snapshot = snapshot;
    state.csrfToken = snapshot.csrfToken;
    state.categoryId = "all";
    tableLabel.textContent = snapshot.table.label;
    tableChip.hidden = false;
    if (snapshot.activeOrder) {
      state.checkout = { order: snapshot.activeOrder, payment: snapshot.payment, fulfillment: snapshot.fulfillment };
      renderPayment();
      connectStatusStream();
    } else if (surface === "kiosk") renderHome();
    else renderMenu();
  } catch (error) {
    renderError(surface === "kiosk" ? "Kiosk demo belum tersedia" : "QR meja tidak dapat digunakan", error.message, error.code);
  }
}

function renderHome() {
  setScreen("home");
  app.innerHTML = `<section class="kiosk-flow-shell"><section class="hero order-hero kiosk-welcome-hero"><div class="order-hero-copy"><p class="eyebrow">KIOSK DEMO · KOPI SAGA</p><h2 class="kiosk-campaign-title">BAGEL + BEVERAGE 25K</h2><h1>Ngopi enak,<br>pesan sendiri.</h1><p>Pilih menu, atur pesanan, lalu pantau statusnya dalam satu alur yang jelas.</p><span class="hero-note">PEMBAYARAN SIMULASI · AMAN UNTUK DEMO</span></div><picture class="campaign-hero-media" aria-hidden="true"><img src="/assets/menu/v2/es-kopi-saga-dummy-v1.svg" alt="" width="512" height="768" fetchpriority="high" decoding="async"></picture><div class="kiosk-welcome-actions"><button class="primary" type="button" data-start-order>Mulai Pesan <span aria-hidden="true">→</span></button></div></section></section>`;
}

function renderOrderType() {
  setScreen("order-type");
  app.innerHTML = `<section class="kiosk-flow-shell"><div class="flow-progress"><span>ALUR PEMESANAN</span><span>1 dari 5</span></div><button class="secondary-action flow-back" type="button" data-flow-back="home">Kembali</button><div class="flow-heading"><p class="eyebrow">CARA MENIKMATI</p><h1>Pesananmu untuk di mana?</h1><p>Pilih makan di tempat atau bawa pulang. Pilihan ini akan diteruskan bersama nomor pesanan ke antrean KDS demo.</p></div><div class="flow-choice-grid"><button class="flow-choice" type="button" data-order-type="DINE_IN"><small>01 · PILIH</small><strong>Makan di Sini</strong><span>Nikmati pesanan di area Kopi Saga.</span></button><button class="flow-choice" type="button" data-order-type="TAKEAWAY"><small>02 · PILIH</small><strong>Bawa Pulang</strong><span>Kami siapkan pesanan untuk dibawa.</span></button></div></section>`;
}

function renderMember() {
  setScreen("member");
  app.innerHTML = `<section class="kiosk-flow-shell"><div class="flow-progress"><span>ALUR PEMESANAN</span><span>2 dari 5</span></div><button class="secondary-action flow-back" type="button" data-flow-back="order-type">Kembali</button><div class="flow-heading"><p class="eyebrow">MEMBER · OPSIONAL</p><h1>Punya Saga Member?</h1><p>Hubungkan akun demo lewat simulasi NFC atau nomor telepon. Tidak ada data customer nyata yang digunakan atau disimpan.</p></div><div class="member-grid"><article class="member-card"><p class="eyebrow">TAP NFC · SIMULATOR</p><h2>Tempelkan kartu atau HP</h2><p>Simulasikan pembacaan NFC tanpa perangkat dan credential nyata.</p><button class="primary" type="button" data-member-nfc ${state.busy ? "disabled" : ""}>${state.busy ? "Membaca…" : "Simulasikan Tap NFC"}</button></article><article class="member-card"><p class="eyebrow">NOMOR TELEPON · SIMULATOR</p><h2>Cari akun member</h2><p>Masukkan nomor demo 9–15 digit untuk melihat alurnya.</p><input type="tel" inputmode="tel" autocomplete="off" data-member-phone value="${escapeHtml(state.memberCode)}" placeholder="Contoh 000000000"><button class="primary" type="button" data-member-phone-submit ${state.busy ? "disabled" : ""}>Hubungkan Member</button></article></div><div class="kiosk-flow-actions"><button class="secondary-action" type="button" data-member-skip>Lanjut Tanpa Member</button></div></section>`;
}

function renderMemberWelcome() {
  setScreen("member-welcome");
  app.innerHTML = `<section class="kiosk-flow-shell"><div class="flow-progress"><span>MEMBER TERHUBUNG</span><span>3 dari 5</span></div><div class="flow-heading"><p class="eyebrow">SAGA MEMBER · DEMO</p><h1>Selamat datang, ${escapeHtml(state.member?.displayName || "Member Demo")}.</h1><p>${escapeHtml(state.member?.tier || "Member Saga")} · identitas ditampilkan dalam bentuk tersamarkan.</p></div><div class="member-status"><span><small>AKUN DEMO</small><strong>${escapeHtml(state.member?.codeMasked || "••••")}</strong></span><span>${escapeHtml(state.memberSource.replaceAll("_", " "))}</span></div><div class="kiosk-flow-actions"><button class="primary" type="button" data-browse-menu>Lihat Menu</button><button class="secondary-action" type="button" data-change-member>Ganti Member</button></div></section>`;
}

function renderMenu() {
  setScreen("menu");
  const catalog = state.snapshot.catalog || [];
  const category = state.categoryId === "all" ? { id: "all", name: "Semua menu", products: catalog.flatMap((item) => item.products || []) } : catalog.find((item) => item.id === state.categoryId) || catalog[0];
  const visibleProducts = (category?.products || []).filter((product) => !state.query || product.name.toLocaleLowerCase("id").includes(state.query.toLocaleLowerCase("id")));
  const featured = catalog.flatMap((item) => item.products || []).filter((product) => product.available !== false).slice(0, 3);
  const menuIntro = surface === "kiosk"
    ? `<section class="order-menu-intro"><p class="eyebrow">${sourceLabel} · ${escapeHtml(state.snapshot.table.label)}</p><h1>Pilih menu favoritmu.</h1><p>Gunakan pencarian atau kategori untuk menemukan pesanan lebih cepat.</p></section>`
    : `<section class="hero order-hero compact-order-hero"><div class="order-hero-copy"><p class="eyebrow">${sourceLabel} · ${escapeHtml(state.snapshot.table.label)}</p><h1>Temukan rasa favoritmu.</h1><p>Pesan dari meja dengan langkah singkat dan status yang mudah dipantau.</p><span class="hero-note">PEMBAYARAN SIMULASI · AMAN UNTUK DEMO</span></div><picture class="campaign-hero-media" aria-hidden="true"><img src="/assets/menu/v2/es-kopi-saga-dummy-v1.svg" alt="" width="512" height="768" fetchpriority="high" decoding="async"></picture></section>`;
  app.innerHTML = `${menuIntro}
    <section class="catalog-toolbar"><label class="order-search"><span class="sr-only">Cari menu</span><input type="search" data-menu-search value="${escapeHtml(state.query)}" placeholder="Cari menu, kopi, atau bagel…" autocomplete="off"><button class="order-search-clear" type="button" data-clear-menu-search aria-label="Hapus pencarian" ${state.query ? "" : "hidden"}>×</button></label>
    <nav class="category-tabs" aria-label="Kategori menu"><button class="category-tab" type="button" data-category="all" aria-pressed="${category?.id === "all"}">Semua · ${catalog.reduce((sum, item) => sum + (item.products?.length || 0), 0)}</button>${catalog.map((item) => `<button class="category-tab" type="button" data-category="${escapeHtml(item.id)}" aria-pressed="${item.id === category?.id}">${escapeHtml(item.name)} · ${item.products?.length || 0}</button>`).join("")}</nav></section>
    <div class="section-heading menu-heading"><div><p class="eyebrow">MENU LENGKAP</p><h2>${escapeHtml(category?.name || "Semua menu")}</h2></div><span>${visibleProducts.length} item</span></div>
    <section class="menu-grid" aria-label="Menu ${escapeHtml(category?.name || "")}">${visibleProducts.length ? visibleProducts.map(productCard).join("") : `<div class="menu-empty"><strong>Menu belum ditemukan.</strong><span>Coba kata lain atau pilih kategori Semua.</span><button class="secondary-action" type="button" data-clear-menu-search>Hapus pencarian</button></div>`}</section>
    ${featured.length && category?.id === "all" && !state.query ? `<section class="favorite-section" aria-labelledby="favorite-title"><div class="section-heading"><div><p class="eyebrow">PILIHAN HARI INI</p><h2 id="favorite-title">Favorit di Kopi Saga</h2></div><span>${featured.length} menu</span></div><div class="favorite-rail">${featured.map((product) => favoriteCard(product)).join("")}</div></section>` : ""}
    ${cartBar()}`;
  bindImageFallbacks();
}

function productCard(product) {
  const qty = state.cart.get(product.id)?.qty || 0;
  const available = product.available !== false;
  const imageUrl = productImage(product);
  const previewImage = isPreviewImage(product);
  return `<button class="product" type="button" data-open-product="${escapeHtml(product.id)}" ${available ? "" : "disabled"} aria-label="${escapeHtml(product.name)}, ${rupiah(product.priceRupiah)}${qty ? `, ${qty} di keranjang` : ""}"><span class="product-visual"><span class="photo-fallback" aria-hidden="true">${escapeHtml(product.name.slice(0, 1))}</span><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.imageAlt || product.name)}" loading="lazy" decoding="async" data-product-image>${previewImage ? '<span class="photo-label">FOTO PREVIEW</span>' : ""}${available ? "" : '<span class="availability-label">HABIS</span>'}${qty ? `<span class="cart-count">${qty}</span>` : ""}</span><span class="product-copy"><span class="product-kicker">KOPI SAGA</span><span class="product-title">${escapeHtml(product.name)}</span><span class="product-price">${compactRupiah(product.priceRupiah)}</span><span class="product-cta">${available ? "Lihat menu" : "Sedang habis"}<span class="product-cta-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M6.75 12h10.5M13.25 8l4 4-4 4"/></svg></span></span></span></button>`;
}

function favoriteCard(product) {
  return `<button class="favorite-card" type="button" data-open-product="${escapeHtml(product.id)}"><img src="${escapeHtml(productImage(product))}" alt="" loading="lazy" decoding="async" data-product-image><span><small>FAVORIT</small><strong>${escapeHtml(product.name)}</strong><em>${compactRupiah(product.priceRupiah)}</em></span></button>`;
}

function productImage(product) {
  return typeof product.imageUrl === "string" && product.imageUrl.length > 0 ? product.imageUrl : productAssetPath(product.id);
}

function isPreviewImage(product) {
  return !(typeof product.imageUrl === "string" && product.imageUrl.length > 0) && PRODUCT_ASSET_REVIEW_STATUS.illustrativeDummyProductIds.includes(product.id);
}

function bindImageFallbacks() {
  app.querySelectorAll("[data-product-image]").forEach((image) => image.addEventListener("error", () => {
    image.closest(".product-visual")?.classList.add("is-broken");
    image.removeAttribute("src");
  }, { once: true }));
}

function cartBar() {
  const count = [...state.cart.values()].reduce((sum, item) => sum + item.qty, 0);
  if (!count) return "";
  const estimate = [...state.cart.values()].reduce((sum, item) => sum + item.qty * (item.product.priceRupiah + (item.selections || []).reduce((subtotal, selection) => subtotal + Number(selection.priceDeltaRupiah || 0), 0)), 0);
  return `<aside class="cart-bar" aria-label="Keranjang"><div class="cart-copy"><small>${count} item · perkiraan</small><strong>${rupiah(estimate)}</strong></div><button class="primary" type="button" data-review>Review</button></aside>`;
}

async function handleClick(event) {
  if (event.target.closest("[data-clear-menu-search]")) { state.query = ""; return renderMenu(); }
  if (event.target.closest("[data-start-order]")) return renderOrderType();
  const flowBack = event.target.closest("[data-flow-back]");
  if (flowBack) return flowBack.dataset.flowBack === "home" ? renderHome() : renderOrderType();
  const orderType = event.target.closest("[data-order-type]");
  if (orderType) { state.orderType = orderType.dataset.orderType; return renderMember(); }
  if (event.target.closest("[data-member-nfc]")) return resolveMember("NFC");
  if (event.target.closest("[data-member-phone-submit]")) return resolveMember("PHONE");
  if (event.target.closest("[data-member-skip]")) { state.member = null; state.memberSource = ""; state.screen = "menu"; return renderMenu(); }
  if (event.target.closest("[data-browse-menu]")) { state.screen = "menu"; return renderMenu(); }
  if (event.target.closest("[data-change-member]")) return renderMember();
  const openProductButton = event.target.closest("[data-open-product]");
  if (openProductButton) return openProduct(openProductButton.dataset.openProduct);
  if (event.target.closest("[data-close-product]")) { productDialog.close(); productDialogContent.innerHTML = ""; return; }
  const category = event.target.closest("[data-category]");
  if (category) {
    state.categoryId = category.dataset.category;
    renderMenu();
    return revealActiveCategory();
  }
  const add = event.target.closest("[data-add]");
  if (add) return changeQuantity(add.dataset.add, 1);
  const remove = event.target.closest("[data-remove]");
  if (remove) return changeQuantity(remove.dataset.remove, -1);
  if (event.target.closest("[data-review]")) return review();
  const reviewPage = event.target.closest("[data-review-page]");
  if (reviewPage) { state.reviewPage = Number(reviewPage.dataset.reviewPage); return renderReview(); }
  if (event.target.closest("[data-back]")) return renderMenu();
  const modifierOption = event.target.closest("[data-modifier-option]");
  if (modifierOption) return toggleModifier(modifierOption);
  const modifierQty = event.target.closest("[data-modifier-qty]");
  if (modifierQty) { state.modifierDraft.qty = Math.max(1, Math.min(20, state.modifierDraft.qty + Number(modifierQty.dataset.modifierQty))); return renderProductDialog(state.modifierDraft.product.id); }
  if (event.target.closest("[data-save-modifier]")) return saveModifier();
  if (event.target.closest("[data-continue-payment]")) return renderPaymentMethod();
  const paymentMethod = event.target.closest("[data-payment-method]");
  if (paymentMethod) { state.paymentMethod = paymentMethod.dataset.paymentMethod; if (state.paymentMethod === "CASH_ASSISTED" && !state.cashReceivedRupiah) state.cashReceivedRupiah = state.quote?.assistedCash?.tenderOptions?.[0]?.receivedRupiah || state.quote.totalRupiah; return renderPaymentMethod(); }
  const cashTender = event.target.closest("[data-cash-tender]");
  if (cashTender) { state.cashReceivedRupiah = Number(cashTender.dataset.cashTender); return renderPaymentMethod(); }
  if (event.target.closest("[data-retry-page]")) return location.reload();
  if (event.target.closest("[data-help]")) return showToast("Silakan panggil staf Kopi Saga di area bar. Jangan pindahkan QR dari meja ini.");
  if (event.target.closest("[data-demo-pay]")) return beginDemoCheckout();
  const transition = event.target.closest("[data-payment-target]");
  if (transition) return transitionDemoPayment(transition.dataset.paymentTarget);
  if (event.target.closest("[data-retry-payment]")) return retryDemoPayment();
  if (event.target.closest("[data-refresh-order]")) return refreshOrder();
  if (event.target.closest("[data-repeat-order]")) return resetKiosk();
}

function revealActiveCategory() {
  requestAnimationFrame(() => {
    const active = app.querySelector('.category-tabs [aria-pressed="true"]');
    if (!active) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
  });
}

async function resolveMember(method) {
  if (state.busy) return;
  const digits = state.memberCode.replace(/\D/g, "");
  if (method === "PHONE" && (digits.length < 9 || digits.length > 15)) return showToast("Masukkan nomor telepon demo 9–15 digit.");
  state.busy = true;
  renderMember();
  try {
    const result = await api(`${apiBase}/member/${method === "NFC" ? "simulate-nfc" : "resolve"}`, { method: "POST", csrf: true, body: { orderType: state.orderType, ...(method === "PHONE" ? { memberCode: digits } : {}) } });
    state.member = result.member;
    state.memberSource = result.source || "SIMULATOR";
    renderMemberWelcome();
  } catch (error) { showToast(error.message); renderMember(); }
  finally { state.busy = false; }
}

function changeQuantity(productId, delta) {
  const product = state.snapshot.catalog.flatMap((item) => item.products || []).find((item) => item.id === productId);
  if (!product || product.available === false) return;
  const qty = Math.max(0, Math.min(20, (state.cart.get(productId)?.qty || 0) + delta));
  if (!qty) state.cart.delete(productId); else state.cart.set(productId, { product, qty });
  state.quote = null;
  renderMenu();
  renderProductDialog(productId);
}

function openProduct(productId) {
  if (surface === "kiosk") {
    const product = productById(productId);
    if (!product || product.available === false) return;
    const existing = state.cart.get(productId);
    state.modifierDraft = { product, qty: existing?.qty || 1, selections: structuredClone(existing?.selections || []), note: existing?.note || "" };
  }
  renderProductDialog(productId);
  if (!productDialog.open) productDialog.showModal();
}

function renderProductDialog(productId) {
  const product = productById(productId);
  if (!product) return;
  if (surface === "kiosk") return renderKioskProductDialog(product);
  const qty = state.cart.get(product.id)?.qty || 0;
  const available = product.available !== false;
  productDialogContent.innerHTML = `<article class="product-detail"><button class="dialog-close" type="button" data-close-product aria-label="Tutup detail menu">×</button><div class="product-detail-visual"><span class="photo-fallback" aria-hidden="true">${escapeHtml(product.name.slice(0, 1))}</span><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.imageAlt || product.name)}" data-product-image>${isPreviewImage(product) ? '<span class="photo-label">FOTO PREVIEW</span>' : ""}</div><div class="product-detail-copy"><p class="eyebrow">KOPI SAGA · MENU DETAIL</p><h2 id="order-product-title">${escapeHtml(product.name)}</h2><p class="product-description">Disajikan sesuai standar Kopi Saga. Informasi nutrisi dan copy final menggunakan data dummy terlabel sampai konten operasional disetujui.</p><div class="detail-meta"><span><small>Harga</small><strong>${rupiah(product.priceRupiah)}</strong></span><span><small>Pesanan</small><strong>${qty} item</strong></span></div>${available ? `<div class="detail-actions"><div class="qty-controls" aria-label="Jumlah ${escapeHtml(product.name)}"><button class="icon-button secondary" type="button" data-remove="${escapeHtml(product.id)}" aria-label="Kurangi ${escapeHtml(product.name)}">−</button><span class="qty" aria-live="polite">${qty}</span><button class="icon-button" type="button" data-add="${escapeHtml(product.id)}" aria-label="Tambah ${escapeHtml(product.name)}">+</button></div><button class="primary detail-done" type="button" data-close-product>${qty ? "Selesai" : "Kembali"}</button></div>` : '<span class="sold-out">Menu sedang habis</span>'}</div></article>`;
  bindDialogImageFallback();
}

function renderKioskProductDialog(product) {
  const draft = state.modifierDraft;
  const groups = [...(product.variantGroups || []), ...(product.modifierGroups || [])].filter((group) => group.active !== false);
  const selected = new Set((draft.selections || []).map((item) => `${item.groupId}:${item.optionId}`));
  const unitTotal = Number(product.priceRupiah || 0) + draft.selections.reduce((sum, item) => sum + Number(item.priceDeltaRupiah || 0), 0);
  productDialogContent.innerHTML = `<article class="product-detail"><button class="dialog-close" type="button" data-close-product aria-label="Tutup detail menu">×</button><div class="product-detail-visual"><span class="photo-fallback" aria-hidden="true">${escapeHtml(product.name.slice(0, 1))}</span><img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.imageAlt || product.name)}" data-product-image>${isPreviewImage(product) ? '<span class="photo-label">FOTO PREVIEW</span>' : ""}</div><div class="product-detail-copy"><p class="eyebrow">KOPI SAGA · PILIH MODIFIER</p><h2 id="order-product-title">${escapeHtml(product.name)}</h2><p class="product-description">Atur pilihan sesuai selera. Informasi nutrisi dan copy final masih berupa data dummy terlabel.</p>${groups.length ? `<div class="modifier-groups">${groups.map((group) => `<fieldset class="modifier-group"><legend>${escapeHtml(group.label)} · maks. ${Number(group.max || 1)}</legend><div class="modifier-options">${(group.options || []).filter((option) => option.active !== false && option.available !== false).map((option) => { const isSelected = selected.has(`${group.id}:${option.id}`); return `<button class="modifier-option" type="button" data-modifier-option data-group="${escapeHtml(group.id)}" data-group-label="${escapeHtml(group.label)}" data-option="${escapeHtml(option.id)}" data-option-label="${escapeHtml(option.label)}" data-price="${Number(option.priceDeltaRupiah || 0)}" data-max="${Number(group.max || 1)}" aria-pressed="${isSelected}">${escapeHtml(option.label)}${option.priceDeltaRupiah ? `<small>+${rupiah(option.priceDeltaRupiah)}</small>` : ""}</button>`; }).join("")}</div></fieldset>`).join("")}</div>` : '<p class="notice"><strong>Resep standar.</strong> Menu ini tidak memiliki pilihan tambahan.</p>'}<label class="modifier-note">Catatan opsional<input type="text" maxlength="120" data-modifier-note value="${escapeHtml(draft.note)}" placeholder="Contoh: tanpa sedotan"></label><div class="detail-meta"><span><small>Harga per item</small><strong>${rupiah(unitTotal)}</strong></span><span><small>Total</small><strong>${rupiah(unitTotal * draft.qty)}</strong></span></div><div class="detail-actions"><div class="qty-controls" aria-label="Jumlah ${escapeHtml(product.name)}"><button class="icon-button secondary" type="button" data-modifier-qty="-1" aria-label="Kurangi ${escapeHtml(product.name)}">−</button><span class="qty" aria-live="polite">${draft.qty}</span><button class="icon-button" type="button" data-modifier-qty="1" aria-label="Tambah ${escapeHtml(product.name)}">+</button></div><button class="primary detail-done" type="button" data-save-modifier>Masukkan Keranjang</button></div></div></article>`;
  bindDialogImageFallback();
}

function toggleModifier(button) {
  if (!state.modifierDraft) return;
  const groupId = button.dataset.group;
  const optionId = button.dataset.option;
  const key = `${groupId}:${optionId}`;
  const current = state.modifierDraft.selections || [];
  const exists = current.some((item) => `${item.groupId}:${item.optionId}` === key);
  if (exists) state.modifierDraft.selections = current.filter((item) => `${item.groupId}:${item.optionId}` !== key);
  else {
    const otherGroups = current.filter((item) => item.groupId !== groupId);
    const sameGroup = current.filter((item) => item.groupId === groupId);
    const max = Math.max(1, Number(button.dataset.max || 1));
    state.modifierDraft.selections = [...otherGroups, ...sameGroup.slice(Math.max(0, sameGroup.length - max + 1)), { groupId, groupLabel: button.dataset.groupLabel, optionId, optionLabel: button.dataset.optionLabel, priceDeltaRupiah: Number(button.dataset.price || 0) }];
  }
  renderKioskProductDialog(state.modifierDraft.product);
}

function saveModifier() {
  const draft = state.modifierDraft;
  if (!draft) return;
  state.cart.set(draft.product.id, { product: draft.product, qty: draft.qty, selections: structuredClone(draft.selections), note: draft.note });
  state.quote = null;
  productDialog.close();
  productDialogContent.innerHTML = "";
  state.modifierDraft = null;
  renderMenu();
}

function productById(productId) { return state.snapshot.catalog.flatMap((item) => item.products || []).find((item) => item.id === productId); }

function bindDialogImageFallback() {
  productDialogContent.querySelectorAll("[data-product-image]").forEach((image) => image.addEventListener("error", () => {
    image.parentElement?.classList.add("is-broken");
    image.removeAttribute("src");
  }, { once: true }));
}

async function review() {
  if (!state.cart.size || state.busy) return;
  state.busy = true;
  try {
    state.quote = await api(`${apiBase}/quote`, { method: "POST", csrf: true, body: { cart: cartPayload(), ...(surface === "kiosk" ? { orderType: state.orderType } : {}) } });
    state.reviewPage = 0;
    renderReview();
  } catch (error) {
    showToast(error.message);
  } finally { state.busy = false; }
}

function renderReview() {
  setScreen("review");
  const lines = state.quote.items || [];
  const detailByProduct = new Map([...state.cart.values()].map((item) => [item.product.id, item]));
  const pageCount = surface === "kiosk" ? Math.max(1, Math.ceil(lines.length / REVIEW_PAGE_SIZE)) : 1;
  state.reviewPage = Math.max(0, Math.min(state.reviewPage, pageCount - 1));
  const visibleLines = surface === "kiosk" ? lines.slice(state.reviewPage * REVIEW_PAGE_SIZE, (state.reviewPage + 1) * REVIEW_PAGE_SIZE) : lines;
  app.innerHTML = `<section class="review"><div><p class="eyebrow">REVIEW · ${escapeHtml(state.snapshot.table.label)}</p><h1>Periksa pesananmu.</h1></div>${surface === "kiosk" ? `<div class="member-status"><span><small>CARA MENIKMATI</small><strong>${state.orderType === "DINE_IN" ? "Makan di Sini" : "Bawa Pulang"}</strong></span><span>${state.member ? escapeHtml(state.member.codeMasked) : "Tanpa member"}</span></div>` : ""}<div class="review-card">${visibleLines.map((line) => { const detail = detailByProduct.get(line.productId); const options = detail?.selections?.map((item) => item.optionLabel).filter(Boolean).join(" · "); return `<div class="review-line"><span>${line.qty}× ${escapeHtml(line.productNameSnapshot || line.productName || line.name || "Menu")}${options ? `<small>${escapeHtml(options)}</small>` : ""}</span><strong>${rupiah(line.lineTotalRupiah ?? line.totalRupiah ?? 0)}</strong></div>`; }).join("")}${pageCount > 1 ? `<nav class="review-pages" aria-label="Halaman detail pesanan"><button class="secondary-action" type="button" data-review-page="${state.reviewPage - 1}" ${state.reviewPage === 0 ? "disabled" : ""}>Sebelumnya</button><span>${state.reviewPage + 1} dari ${pageCount}</span><button class="secondary-action" type="button" data-review-page="${state.reviewPage + 1}" ${state.reviewPage === pageCount - 1 ? "disabled" : ""}>Berikutnya</button></nav>` : ""}<div class="review-total"><span>Total</span><span>${rupiah(state.quote.totalRupiah)}</span></div></div><div class="notice"><strong>${surface === "kiosk" ? "Mode simulasi." : "QRIS demo saja."}</strong> Pembayaran ini tidak memindahkan uang dan tidak masuk laporan keuangan.</div><div class="actions"><button class="primary" type="button" ${surface === "kiosk" ? "data-continue-payment" : "data-demo-pay"}>${surface === "kiosk" ? "Lanjut ke Pembayaran" : "Buat QRIS demo"}</button><button class="secondary-action" type="button" data-back>Ubah pesanan</button></div></section>`;
}

function renderPaymentMethod() {
  setScreen("payment-method");
  const total = state.quote.totalRupiah;
  const options = state.quote.assistedCash?.tenderOptions || [];
  const cash = state.paymentMethod === "CASH_ASSISTED";
  app.innerHTML = `<section class="review"><div><p class="eyebrow">PEMBAYARAN · SIMULATOR</p><h1>Pilih cara bayar.</h1><p>Periksa total lalu pilih QRIS atau tunai demo.</p></div><div class="payment-method-grid" role="group" aria-label="Metode pembayaran"><button class="payment-method" type="button" data-payment-method="QRIS" aria-pressed="${!cash}"><small>SIMULATOR</small><strong>QRIS</strong><span>Pindai QR demo lalu simulasikan hasil.</span></button><button class="payment-method" type="button" data-payment-method="CASH_ASSISTED" aria-pressed="${cash}"><small>DIBANTU STAF · SIMULATOR</small><strong>Tunai</strong><span>Pilih nominal uang dan simulasikan penerimaan.</span></button></div>${cash ? `<div class="notice"><strong>Nominal disiapkan</strong><div class="cash-tenders">${options.map((option) => `<button type="button" data-cash-tender="${option.receivedRupiah}" aria-pressed="${Number(state.cashReceivedRupiah) === option.receivedRupiah}">${escapeHtml(option.label)}${option.changeRupiah ? ` · kembali ${rupiah(option.changeRupiah)}` : " · uang pas"}</button>`).join("")}</div></div>` : ""}<div class="review-card"><div class="review-line"><span>Metode</span><strong>${cash ? "Tunai demo" : "QRIS demo"}</strong></div>${cash ? `<div class="review-line"><span>Uang disiapkan</span><strong>${rupiah(state.cashReceivedRupiah)}</strong></div>` : ""}<div class="review-total"><span>Total</span><span>${rupiah(total)}</span></div></div><div class="actions"><button class="primary" type="button" data-demo-pay ${cash && state.cashReceivedRupiah < total ? "disabled" : ""}>${cash ? "Bayar Tunai (Simulasi)" : "Buat QRIS Demo"}</button><button class="secondary-action" type="button" data-review>Kembali ke Detail</button></div></section>`;
}

async function beginDemoCheckout() {
  if (!state.quote || state.busy) return;
  state.busy = true;
  try {
    const cart = cartPayload();
    const expectedQuote = { fingerprint: state.quote.quoteFingerprint, catalogVersion: state.quote.catalogVersion, totalRupiah: state.quote.totalRupiah, expiresAt: state.quote.expiresAt };
    state.checkout = await api(`${apiBase}/checkouts`, { method: "POST", csrf: true, body: { cart, expectedQuote, idempotencyKey: sessionKey(`${surface}-checkout`), ...(surface === "kiosk" ? { orderType: state.orderType, paymentMethod: state.paymentMethod, ...(state.paymentMethod === "CASH_ASSISTED" ? { receivedRupiah: state.cashReceivedRupiah } : {}) } : {}) } });
    renderPayment();
    connectStatusStream();
  } catch (error) { showToast(error.message); }
  finally { state.busy = false; }
}

function cartPayload() {
  return [...state.cart.values()].map(({ product, qty, selections = [], note = "" }) => ({ productId: product.id, qty, selections, note }));
}

function renderPayment() {
  setScreen("payment");
  const { order, payment, fulfillment } = state.checkout;
  const terminalFailure = ["FAILED", "EXPIRED"].includes(payment?.status);
  const paid = payment?.status === "PAID";
  const fulfillmentLabel = fulfillment ? fulfillmentStatus(fulfillment.status) : "Belum dikirim ke bar";
  if (surface === "kiosk" && paid) return renderKioskSuccess(order, payment, fulfillmentLabel);
  const cash = surface === "kiosk" && payment?.assistedCash === true;
  app.innerHTML = `<section class="review"><div><p class="eyebrow">${escapeHtml(order.orderNumber)} · ${escapeHtml(state.snapshot.table.label)}</p><h1>${paid ? "Pesanan diteruskan ke bar." : terminalFailure ? "Pembayaran demo belum berhasil." : cash ? "Serahkan tunai ke staf." : "Pindai QRIS demo."}</h1></div>
    <div class="review-card"><div class="review-line"><span>Status pembayaran</span><strong>${escapeHtml(payment?.status || "-")}</strong></div><div class="review-line"><span>Status dapur</span><strong>${escapeHtml(fulfillmentLabel)}</strong></div><div class="review-total"><span>Total demo</span><span>${rupiah(payment?.amountRupiah)}</span></div>${payment?.qrPayload && !paid && !terminalFailure ? `<code class="demo-qr">${escapeHtml(payment.qrPayload)}</code>` : ""}</div>
    <div class="notice"><strong>Mode demonstrasi.</strong> Tidak ada uang, settlement, stok, reward, atau laporan bisnis yang berubah.</div>
    <p class="freshness" role="status">${escapeHtml(freshnessLabel())}</p>
    <div class="actions">${!paid && !terminalFailure ? `<button class="primary" type="button" data-payment-target="SUCCESS">${cash ? "Simulasikan Tunai Diterima" : surface === "kiosk" ? "Simulasikan Pembayaran Berhasil" : "Simulasikan berhasil"}</button>${cash ? "" : '<button class="secondary-action" type="button" data-payment-target="FAILED">Simulasikan gagal</button><button class="secondary-action" type="button" data-payment-target="EXPIRED">Simulasikan kedaluwarsa</button>'}` : ""}${terminalFailure ? `<button class="primary" type="button" data-retry-payment>Coba QRIS demo lagi</button>` : ""}${paid ? `<button class="secondary-action" type="button" data-refresh-order>Perbarui status pesanan</button>` : ""}</div></section>`;
}

function renderKioskSuccess(order, payment, fulfillmentLabel) {
  setScreen("success");
  app.innerHTML = `<section class="review"><div><p class="eyebrow">PEMBAYARAN BERHASIL · SIMULATOR</p><h1>Pesanan masuk ke bar.</h1><p>Simpan nomor pesanan dan tunggu dipanggil.</p></div><div class="success-number"><div><small>NOMOR PESANAN</small><strong>${escapeHtml(order.orderNumber)}</strong></div></div><div class="review-card"><div class="review-line"><span>Cara menikmati</span><strong>${order.orderType === "DINE_IN" ? "Makan di Sini" : "Bawa Pulang"}</strong></div><div class="review-line"><span>Status pembayaran</span><strong>${escapeHtml(payment.status)}</strong></div><div class="review-line"><span>Status KDS</span><strong>${escapeHtml(fulfillmentLabel)}</strong></div><div class="review-line"><span>Settlement</span><strong>${escapeHtml(payment.settlementStatus || "not_applicable")}</strong></div><div class="review-total"><span>Total demo</span><span>${rupiah(payment.amountRupiah)}</span></div></div><div class="notice"><strong>Simulasi selesai.</strong> Tidak ada uang, stok, reward, atau laporan bisnis yang berubah.</div><p class="freshness" role="status">${escapeHtml(freshnessLabel())}</p><div class="actions"><button class="primary" type="button" data-repeat-order>Pesan Lagi</button><button class="secondary-action" type="button" data-refresh-order>Perbarui Status KDS</button></div></section>`;
}

async function transitionDemoPayment(target) {
  if (!state.checkout?.payment || state.busy) return;
  state.busy = true;
  try {
    state.checkout = await api(`${apiBase}/payments/simulate`, { method: "POST", csrf: true, body: { paymentId: state.checkout.payment.id, target, callbackId: sessionKey(`${surface}-payment-${state.checkout.payment.id}-${target}`) } });
    renderPayment();
  } catch (error) { showToast(error.message); }
  finally { state.busy = false; }
}

async function retryDemoPayment() {
  if (!state.checkout?.order || state.busy) return;
  state.busy = true;
  try {
    state.checkout = await api(`${apiBase}/payments/retry`, { method: "POST", csrf: true, body: { orderId: state.checkout.order.id, idempotencyKey: sessionKey(`${surface}-retry-${state.checkout.order.id}-${(state.checkout.payment?.attempt || 1) + 1}`) } });
    renderPayment();
  } catch (error) { showToast(error.message); }
  finally { state.busy = false; }
}

async function refreshOrder() {
  if (state.busy) return;
  state.busy = true;
  try {
    const snapshot = await api(`${apiBase}/state`);
    state.snapshot = snapshot;
    state.csrfToken = snapshot.csrfToken;
    state.checkout = { order: snapshot.activeOrder, payment: snapshot.payment, fulfillment: snapshot.fulfillment };
    renderPayment();
  } catch (error) { showToast(error.message); }
  finally { state.busy = false; }
}

async function resetKiosk() {
  if (surface !== "kiosk" || state.busy) return;
  state.busy = true;
  stopStatusStream();
  statusRetryDelayMs = 5000;
  try {
    const snapshot = await api(`${apiBase}/bootstrap`, { method: "POST", body: { forceFresh: true } });
    Object.assign(state, { snapshot, csrfToken: snapshot.csrfToken, categoryId: "all", query: "", cart: new Map(), quote: null, checkout: null, busy: false, stream: null, freshness: null, screen: "home", orderType: "", member: null, memberCode: "", memberSource: "", paymentMethod: "QRIS", cashReceivedRupiah: 0, modifierDraft: null });
    tableLabel.textContent = snapshot.table.label;
    renderHome();
  } catch (error) { showToast(error.message); state.busy = false; }
}

function stopStatusStream() {
  if (statusRetryTimer) clearTimeout(statusRetryTimer);
  statusRetryTimer = null;
  state.stream?.close();
  state.stream = null;
}

function connectStatusStream() {
  if (!state.checkout?.order) return;
  stopStatusStream();
  state.freshness = { connected: false, at: new Date().toISOString() };
  if (typeof EventSource !== "function") { renderPayment(); return; }
  const stream = new EventSource(`${apiBase}/events`, { withCredentials: true });
  state.stream = stream;
  stream.addEventListener("snapshot", (event) => {
    if (state.stream !== stream) return;
    const snapshot = JSON.parse(event.data);
    state.snapshot = snapshot;
    state.csrfToken = snapshot.csrfToken;
    state.freshness = { connected: true, at: snapshot.freshness?.at || new Date().toISOString() };
    statusRetryDelayMs = 5000;
    if (snapshot.activeOrder?.id === state.checkout?.order?.id) {
      state.checkout = { order: snapshot.activeOrder, payment: snapshot.payment, fulfillment: snapshot.fulfillment };
      renderPayment();
    }
  });
  stream.addEventListener("session-expired", (event) => {
    stopStatusStream();
    state.checkout = null;
    const payload = JSON.parse(event.data || "{}");
    renderError(surface === "kiosk" ? "Sesi kiosk berakhir" : "Sesi meja berakhir", surface === "kiosk" ? "Mulai ulang demo untuk melanjutkan." : "Pindai ulang QR yang tersedia di meja untuk melanjutkan.", payload.code || "order_session_invalid");
  });
  stream.onerror = () => {
    if (state.stream !== stream) return;
    stream.close();
    state.stream = null;
    state.freshness = { connected: false, at: new Date().toISOString() };
    if (state.checkout) renderPayment();
    const delay = statusRetryDelayMs;
    statusRetryDelayMs = Math.min(30_000, delay * 2);
    statusRetryTimer = window.setTimeout(() => { statusRetryTimer = null; if (state.checkout?.order) connectStatusStream(); }, delay);
  };
}

function freshnessLabel() {
  if (!state.freshness) return "Status dapat diperbarui manual.";
  return state.freshness.connected ? "Status tersambung langsung ke bar." : "Koneksi status terputus sementara · mencoba menyambung kembali.";
}

function sessionKey(name) {
  const key = `sagapos:${name}`;
  let value = sessionStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); sessionStorage.setItem(key, value); }
  return value;
}

function fulfillmentStatus(value) { return ({ NEW: "Menunggu konfirmasi bar", ACKNOWLEDGED: "Sudah diterima bar", IN_PROGRESS: "Sedang dibuat", READY: "Siap diantar", COMPLETED: "Sudah disajikan", CANCELLED: "Dibatalkan" })[value] || value || "Belum dikirim ke bar"; }

function renderError(title, message, code) {
  tableChip.hidden = true;
  app.innerHTML = `<section class="error-state"><p class="eyebrow">${sourceLabel}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><button class="primary" type="button" data-retry-page>Coba lagi</button><button class="help-link" type="button" data-help>Minta bantuan staf</button><span class="error-code">${escapeHtml(code || "table_order_error")}</span></section>`;
}

async function api(path, { method = "GET", body, csrf = false } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-csrf-token"] = state.csrfToken;
  const response = await fetch(path, { method, credentials: "same-origin", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error?.message || "Layanan belum dapat dihubungi."); error.code = payload.error?.code || "request_failed"; throw error; }
  return payload;
}

function showToast(message) { toast.textContent = message; toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, 5000); }
function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function compactRupiah(value) { return `${Math.round(Number(value || 0) / 1000)}K`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
