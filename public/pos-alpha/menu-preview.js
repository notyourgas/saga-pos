import { productAssetPath, PRODUCT_ASSET_REVIEW_STATUS } from "/menu-product-assets.js";

const CACHE_KEY = "kopi-saga.public-catalog.v2";
const STATUS_CACHE_MAX_AGE_MS = 5 * 60_000;
const CONTENT_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
const ANALYTICS_EVENTS = new Set(["catalog_view", "category_select", "search_submit", "product_open", "promo_open", "retry", "member_connect"]);
const app = document.querySelector("#catalog");
const dialog = document.querySelector("#product-dialog");
const dialogContent = document.querySelector("#dialog-content");
const networkStatus = document.querySelector("#network-status");
const catalogHeroImage = document.querySelector("#catalog-hero-image");
const route = routeState(location.pathname, new URL(location.href).searchParams);
const state = { payload: null, categoryId: "all", query: "", busy: false, opener: null, returnTargetProductId: null, cacheMode: "LIVE" };

document.querySelector("#surface-pill").textContent = route.surfaceLabel;
document.body.dataset.surface = route.surface;
document.querySelector(`[data-nav="${route.section}"]`)?.setAttribute("aria-current", "page");
app.addEventListener("click", handleClick);
app.addEventListener("input", handleInput);
app.addEventListener("keydown", handleKeydown);
dialog.addEventListener("click", (event) => {
  if (event.target === dialog || event.target.closest("[data-close-dialog]")) return closeDialog();
  const product = event.target.closest("[data-product]");
  if (product) openProduct(product.dataset.product, state.opener);
});
dialog.addEventListener("toggle", handleAccordionToggle, true);
dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
dialog.addEventListener("close", handleDialogClosed);
window.addEventListener("popstate", syncUrlState);
window.addEventListener("hashchange", syncUrlState);
window.addEventListener("offline", () => announceNetwork("Koneksi terputus. Menu terakhir tetap dapat dilihat."));
window.addEventListener("online", () => { announceNetwork("Koneksi kembali. Memperbarui menu…"); void loadCatalog({ quiet: true }); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.payload && Date.now() - Date.parse(state.payload.freshness.checkedAt) > 60_000) void loadCatalog({ quiet: true });
});

await loadCatalog();

async function loadCatalog({ quiet = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  app.setAttribute("aria-busy", "true");
  if (!quiet) app.innerHTML = loadingMarkup();
  try {
    const response = await fetch("/api/menu/catalog", { credentials: "same-origin", headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || "Menu belum dapat dimuat."), { code: payload?.error?.code || `http_${response.status}` });
    assertCatalogContract(payload);
    state.payload = payload;
    state.cacheMode = "LIVE";
    writeCatalogCache(payload);
    readUrlFilters();
    render();
    syncUrlState();
    emitAnalytics("catalog_view", { cache_mode: state.cacheMode });
    if (quiet) announceNetwork("Menu sudah diperbarui.");
  } catch (error) {
    const cached = readCatalogCache();
    if (cached) {
      state.payload = cached.payload;
      state.cacheMode = cached.mode;
      readUrlFilters();
      render();
      syncUrlState();
      announceNetwork(cached.mode === "CONTENT_ONLY" ? "Menampilkan isi menu tersimpan; status stok dan promo disembunyikan." : "Menampilkan menu tersimpan sementara koneksi dipulihkan.");
      emitAnalytics("catalog_view", { cache_mode: state.cacheMode });
    } else if (isMaintenanceError(error)) renderMaintenance();
    else if (quiet && state.payload) announceNetwork("Pembaruan gagal. Menampilkan menu terakhir.");
    else renderError(error.message, error.code);
  } finally {
    state.busy = false;
    app.setAttribute("aria-busy", "false");
  }
}

function render() {
  updateReferenceHeader();
  if (route.section === "promo") return renderPromotions();
  if (route.section === "member") return renderMember();
  const categories = state.payload.catalog || [];
  const products = visibleProducts(categories);
  const featured = flattenedProducts().find(({ product }) => product.available !== false) ?? flattenedProducts()[0];
  const favorites = flattenedProducts().filter(({ product }) => product.available !== false).slice(0, 3);
  const activePromotion = state.cacheMode === "CONTENT_ONLY" ? null : state.payload.promotions?.[0];
  const activeCategory = state.categoryId === "all" ? "Semua menu" : categories.find((item) => item.id === state.categoryId)?.name || "Menu";
  app.innerHTML = `
    <section class="hero" aria-labelledby="menu-title"><div class="hero-copy"><p class="eyebrow">KOPI SAGA · COFFEE WITH CHARACTER</p><h1 id="menu-title">Temukan rasa favoritmu.</h1><p>Pilih yang pas untuk harimu—kopi, nonkopi, dan bagel dengan harga yang jelas dan pilihan yang mudah dicari.</p><a class="hero-link" href="#menu-list">Mulai lihat menu <span aria-hidden="true">→</span></a><span class="hero-brand-line" aria-hidden="true">FRESHLY MADE<br>EVERY DAY</span></div>${heroVisual(state.payload.productCount)}</section>
    ${cacheNoticeMarkup()}${storeStatusMarkup()}
    <section class="catalog-toolbar" id="menu-list" aria-label="Filter katalog"><div class="search-wrap" role="search"><label class="sr-only" for="catalog-search">Cari menu</label>${searchIcon()}<input id="catalog-search" type="search" value="${escapeHtml(state.query)}" placeholder="Cari kopi, nonkopi, atau bagel" autocomplete="off" maxlength="80" data-search><button class="clear-search" type="button" data-clear-search aria-label="Hapus pencarian" ${state.query ? "" : "hidden"}>×</button></div><nav class="category-rail" aria-label="Kategori menu">${categoryChip("all", "Semua", state.categoryId === "all")}${categories.map((category) => categoryChip(category.id, category.name, state.categoryId === category.id)).join("")}</nav></section>
    <div class="catalog-heading"><div><p class="eyebrow">KATALOG</p><h2>${escapeHtml(activeCategory)}</h2></div><p aria-live="polite">${products.length} dari ${state.payload.productCount} menu</p></div>
    <section class="menu-grid" aria-label="Daftar ${escapeHtml(activeCategory)}">${products.length ? products.map(({ product, category }) => productCard(product, category)).join("") : emptyMarkup()}</section>
    ${state.categoryId === "all" && !state.query ? `<section class="favorite-section" aria-labelledby="favorite-title"><div class="section-title-row"><h2 id="favorite-title">Favorit di Saga</h2><a href="#menu-list">Kembali ke semua menu ↑</a></div><div class="favorite-rail">${favorites.map(({ product }) => favoriteCard(product)).join("")}${activePromotion ? activePromotionCard(activePromotion) : ""}</div></section>` : ""}
    ${promoStrip()}${freshnessCard()}`;
  if (featured) mountHeroImage(featured.product);
  bindImageFallbacks(app);
}

function updateReferenceHeader() {
  const store = state.payload?.store;
  const hours = document.querySelector("#header-hours");
  const locationLabel = document.querySelector("#header-location");
  if (hours && store?.opensAt && store?.closesAt) hours.textContent = `Buka · ${store.opensAt}–${store.closesAt}`;
  if (locationLabel && store?.locationLabel) locationLabel.textContent = `⌖ ${store.locationLabel}`;
}

function renderPromotions() {
  const promotions = state.payload.promotions || [];
  app.innerHTML = `<section class="editorial-page" aria-labelledby="promo-title"><p class="eyebrow">PROMO KOPI SAGA</p><h1 id="promo-title">Yang sedang<br><em>berlangsung.</em></h1><p>Promo berasal dari konfigurasi SagaPOS yang aktif—bukan contoh atau klaim buatan katalog.</p>${cacheNoticeMarkup()}<div class="promo-grid">${promotions.length ? promotions.map(promotionCard).join("") : `<article class="quiet-card"><span>${state.cacheMode === "CONTENT_ONLY" ? "STATUS PROMO OFFLINE" : "BELUM ADA PROMO AKTIF"}</span><h2>${state.cacheMode === "CONTENT_ONLY" ? "Hubungkan kembali untuk memeriksa promo." : "Nikmati menu dengan harga reguler."}</h2><p>${state.cacheMode === "CONTENT_ONLY" ? "Promo lama tidak ditampilkan agar periode dan kuota tidak menyesatkan." : "Promo akan tampil setelah diterbitkan pengelola."}</p></article>`}</div><a class="text-link" href="/menu">Kembali ke semua menu →</a></section>${freshnessCard()}`;
}

function renderMember() {
  const memberUrl = safeExternalUrl(state.payload.member?.url);
  app.innerHTML = `<section class="member-page" aria-labelledby="member-title" data-member-state="${memberUrl ? "guest" : "error"}"><div><p class="eyebrow">SAGA MEMBER · ${memberUrl ? "GUEST" : "ERROR"}</p><h1 id="member-title">Benefit kamu,<br><em>tetap milikmu.</em></h1><p>Katalog publik ini tidak membaca akun, poin, tier, token, atau data pribadi. ${memberUrl ? "Lanjutkan ke Saga Member untuk akses yang dipersonalisasi." : "Tautan Saga Member belum tersedia."}</p>${memberUrl ? `<a class="member-link" href="${escapeHtml(memberUrl)}" rel="external noopener" data-member-connect>Buka Saga Member <span aria-hidden="true">↗</span></a>` : `<button class="retry-button" type="button" data-retry>Coba lagi</button>`}</div><aside class="privacy-card"><span>PRIVASI</span><strong>Tanpa pelacakan akun</strong><p>Tidak ada identitas meja, checkout, pembayaran, ataupun personalisasi pada halaman ini.</p></aside></section>${cacheNoticeMarkup()}${freshnessCard()}`;
}

function visibleProducts(categories) {
  const query = state.query.trim().toLocaleLowerCase("id");
  return categories.flatMap((category) => category.products.map((product) => ({ category, product }))).filter(({ category }) => state.categoryId === "all" || category.id === state.categoryId).filter(({ category, product }) => !query || `${product.name} ${category.name} ${(product.profileTags || []).join(" ")}`.toLocaleLowerCase("id").includes(query));
}
function flattenedProducts() { return (state.payload?.catalog || []).flatMap((category) => category.products.map((product) => ({ category, product }))); }

function heroVisual(productCount) {
  return `<figure class="hero-visual"><span data-hero-image-slot></span><figcaption><span>MENU HARI INI</span><strong>${escapeHtml(productCount)} pilihan</strong><small>Harga dan detail terbaru</small></figcaption></figure>`;
}

function favoriteCard(product) {
  const media = mediaFor(product);
  return `<button class="favorite-card" type="button" data-product="${escapeHtml(product.id)}"><img src="${escapeHtml(media.src)}" alt="" width="320" height="240" loading="lazy" decoding="async" data-product-image><span><small>${escapeHtml(product.name)}</small><strong>${displayPrice(product.priceRupiah)}</strong><b aria-hidden="true">→</b></span></button>`;
}

function activePromotionCard(promotion) {
  return `<a class="favorite-card favorite-promo" href="/menu/promo"><span><small>PROMO AKTIF</small><strong>${escapeHtml(promotion.name)}</strong><b>Lihat syarat →</b></span></a>`;
}

function mountHeroImage(product) {
  const slot = app.querySelector("[data-hero-image-slot]");
  if (!slot || !catalogHeroImage) return;
  const media = mediaFor(product);
  catalogHeroImage.classList.remove("catalog-hero-image-bootstrap");
  catalogHeroImage.removeAttribute("aria-hidden");
  catalogHeroImage.alt = product.imageAlt || product.name;
  catalogHeroImage.dataset.productImage = "";
  if (catalogHeroImage.getAttribute("src") !== media.src) catalogHeroImage.src = media.src;
  slot.replaceWith(catalogHeroImage);
}

function productCard(product, category) {
  const media = mediaFor(product);
  const availability = product.available === false ? ", sedang habis" : product.available == null ? ", status ketersediaan belum diperbarui" : "";
  return `<button class="product-card ${product.available === false ? "is-sold" : ""} ${product.available == null ? "is-unknown" : ""}" type="button" data-product="${escapeHtml(product.id)}" aria-label="Lihat detail ${escapeHtml(product.name)}${availability}"><span class="product-media"><span class="photo-fallback" aria-hidden="true">${escapeHtml(product.name.slice(0, 1))}</span><img src="${escapeHtml(media.src)}" alt="${escapeHtml(product.imageAlt || product.name)}" width="640" height="640" sizes="(min-width:1024px) 276px,(min-width:600px) 30vw,46vw" loading="lazy" fetchpriority="low" decoding="async" data-product-image>${media.preview ? '<span class="photo-label">FOTO PREVIEW</span>' : ""}${product.badges?.slice(0, 1).map((badge) => `<span class="product-badge">${escapeHtml(badge)}</span>`).join("") || ""}${product.available === false ? '<span class="availability-label">HABIS</span>' : product.available == null ? '<span class="availability-label is-unknown">STATUS OFFLINE</span>' : ""}</span><span class="product-body"><span class="product-category">${escapeHtml(category.name)}</span><h3>${escapeHtml(product.name)}</h3>${product.shortDescription ? `<span class="product-description">${escapeHtml(product.shortDescription)}</span>` : ""}<span class="product-bottom"><span class="product-price">${displayPrice(product.priceRupiah)}</span><span class="detail-hint">Lihat detail <span class="detail-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M6.75 12h10.5M13.25 8l4 4-4 4"/></svg></span></span></span></span></button>`;
}

function openProduct(productId, opener = null, { fromUrl = false } = {}) {
  const entry = flattenedProducts().find(({ product }) => product.id === productId);
  if (!entry) return clearInvalidHash();
  state.opener = opener || document.activeElement;
  if (opener?.closest?.("#catalog")) state.returnTargetProductId = productId;
  const { category, product } = entry;
  const media = mediaFor(product);
  const customizations = (product.customizations || []).filter((group) => group.options?.length);
  const alternatives = (product.alternativeProductIds || []).map((id) => flattenedProducts().find(({ product: item }) => item.id === id)?.product).filter(Boolean);
  dialogContent.innerHTML = `<div class="dialog-media"><span class="photo-fallback" aria-hidden="true">${escapeHtml(product.name.slice(0, 1))}</span><img src="${escapeHtml(media.src)}" alt="${escapeHtml(product.imageAlt || product.name)}" width="640" height="640" data-product-image></div><div class="dialog-body"><button class="dialog-x" type="button" data-close-dialog aria-label="Tutup detail">×</button><div><p class="dialog-kicker">${escapeHtml(category.name)} · ${availabilityText(product.available)}</p><h2 id="dialog-title">${escapeHtml(product.name)}</h2><p class="dialog-description">${escapeHtml(product.description || product.shortDescription || "Detail rasa sedang disiapkan oleh pengelola katalog.")}</p></div><div class="dialog-price">${displayPrice(product.priceRupiah)}</div>${product.contentStatus === "DUMMY_PREVIEW_ONLY" ? '<p class="dialog-note">Konten dan angka nutrisi masih berupa data dummy untuk uji tampilan.</p>' : ""}${tagList("Profil rasa", product.profileTags)}${tagList("Alergen", product.allergens)}${customizationsMarkup(customizations)}${nutritionMarkup(product.nutritionEstimate, product.contentStatus === "DUMMY_PREVIEW_ONLY")}${alternatives.length ? `<section class="alternative-list"><h3>Alternatif yang tersedia</h3>${alternatives.map((item) => `<button type="button" data-product="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${displayPrice(item.priceRupiah)}</button>`).join("")}</section>` : ""}<p class="dialog-note">Katalog lihat-saja. Silakan pesan langsung ke kru Kopi Saga.</p><button class="dialog-close" type="button" data-close-dialog>Tutup</button></div>`;
  bindImageFallbacks(dialogContent); showDialog();
  if (!fromUrl) setDialogHash(`product=${encodeURIComponent(product.id)}`);
  emitAnalytics("product_open", { product_id: product.id, category_id: category.id });
}

function openPromotion(promotionId, opener = null, { fromUrl = false } = {}) {
  const promotion = state.payload?.promotions?.find((item) => item.id === promotionId);
  if (!promotion) return clearInvalidHash();
  state.opener = opener || document.activeElement;
  dialogContent.innerHTML = `<div class="dialog-body promo-dialog-body"><button class="dialog-x" type="button" data-close-dialog aria-label="Tutup detail promo">×</button><div><p class="dialog-kicker">PROMO AKTIF</p><h2 id="dialog-title">${escapeHtml(promotion.name)}</h2><p class="promo-offer">${escapeHtml(promotionOffer(promotion))}</p></div><section class="promo-terms" aria-labelledby="promo-terms-title"><h3 id="promo-terms-title">Syarat promo</h3><dl>${promoTermRows(promotion)}</dl></section><p class="dialog-note">Informasi promo saja. Katalog ini tidak menerima checkout atau pembayaran.</p><button class="dialog-close" type="button" data-close-dialog>Tutup</button></div>`;
  showDialog();
  if (!fromUrl) setDialogHash(`promo=${encodeURIComponent(promotion.id)}`);
  emitAnalytics("promo_open", { promo_id: promotion.id });
}

function showDialog() { document.body.classList.add("dialog-open"); if (!dialog.open) dialog.showModal(); queueMicrotask(() => dialog.querySelector("[data-close-dialog]")?.focus()); }
function closeDialog() { if (!dialog.open) return; if (/^#(?:product|promo)=/.test(location.hash) && history.length > 1) history.back(); else { clearInvalidHash(); dialog.close(); } }
function handleDialogClosed() { if (dialog.open) return; document.body.classList.remove("dialog-open"); const opener = state.opener; const returnTargetProductId = state.returnTargetProductId; state.opener = null; state.returnTargetProductId = null; requestAnimationFrame(() => { if (dialog.open) return; const target = opener?.isConnected ? opener : returnTargetProductId ? app.querySelector(`[data-product="${returnTargetProductId}"]`) : null; target?.focus({ preventScroll: true }); }); }
function handleAccordionToggle(event) { if (!(event.target instanceof HTMLDetailsElement) || !event.target.open) return; dialog.querySelectorAll("details[open]").forEach((item) => { if (item !== event.target) item.open = false; }); }

function customizationsMarkup(groups) { return groups.length ? `<details class="catalog-details"><summary>Pilihan tersedia</summary><div>${groups.map((group) => `<p><strong>${escapeHtml(group.name)}</strong><br>${group.options.map((option) => `${escapeHtml(option.name)}${option.priceDeltaRupiah ? ` (${signedCatalogPrice(option.priceDeltaRupiah)})` : ""}`).join(" · ")}</p>`).join("")}</div></details>` : ""; }
function nutritionMarkup(nutrition, preview = false) {
  if (!nutrition) return "";
  const fields = [["caloriesKcal", "Kalori", "kkal"], ["sugarG", "Gula", "g"], ["proteinG", "Protein", "g"], ["fatG", "Lemak", "g"], ["caffeineMg", "Kafein", "mg"], ["servingMl", "Sajian", "ml"]].filter(([key]) => Number.isFinite(nutrition[key]));
  return fields.length ? `<details class="catalog-details"><summary>Estimasi Resep${preview ? " · Preview" : ""}</summary><div class="nutrition-grid">${fields.map(([key, label, unit]) => `<span><small>${label}</small><strong>${escapeHtml(nutrition[key])} ${unit}</strong></span>`).join("")}</div><p>${preview ? "Data dummy untuk uji tampilan; " : ""}estimasi resep, bukan hasil laboratorium. Sumber diperbarui ${formatDate(nutrition.sourceUpdatedAt)}.</p></details>` : "";
}
function tagList(label, tags) { return tags?.length ? `<div class="tag-row"><span>${escapeHtml(label)}</span>${tags.map((tag) => `<small>${escapeHtml(tag)}</small>`).join("")}</div>` : ""; }
function promotionCard(promotion) { return `<button class="promo-card" type="button" data-promotion="${escapeHtml(promotion.id)}" aria-label="Lihat syarat promo ${escapeHtml(promotion.name)}"><span>AKTIF</span><strong>${escapeHtml(promotionOffer(promotion))}</strong><h2>${escapeHtml(promotion.name)}</h2><p>${promotion.minimumSpendRupiah ? `Minimum transaksi ${catalogPrice(promotion.minimumSpendRupiah)}.` : "Tanpa minimum transaksi yang dipublikasikan."}${promotion.endsAt ? ` Berlaku sampai ${formatDate(promotion.endsAt)}.` : ""}</p><small>Lihat syarat lengkap →</small></button>`; }
function promoTermRows(promotion) {
  const rows = [["Periode", `${formatDate(promotion.startsAt)}${promotion.endsAt ? `–${formatDate(promotion.endsAt)}` : "–tanpa tanggal akhir yang dipublikasikan"}`], ["Minimum transaksi", promotion.minimumSpendRupiah ? catalogPrice(promotion.minimumSpendRupiah) : "Tidak dipublikasikan"], ["Maksimum potongan", promotion.capRupiah ? catalogPrice(promotion.capRupiah) : "Tidak dipublikasikan"], ["Penggabungan", promotion.stackPolicy === "COMPATIBLE" ? "Dapat digabung sesuai aturan kasir" : "Tidak dapat digabung dengan promo lain"], ["Kuota", Number.isInteger(promotion.quotaLimit) ? `${promotion.quotaLimit} penggunaan` : "Tidak dipublikasikan"], ["Batas per transaksi", Number.isInteger(promotion.perOrderLimit) ? `${promotion.perOrderLimit} kali` : "Tidak dipublikasikan"], ["Produk/kategori", promotion.eligibilitySummary || "Berlaku sesuai validasi SagaPOS saat transaksi"]];
  return rows.map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}
function promoStrip() { const count = state.payload.promotions?.length || 0; return `<aside class="promo-strip"><div><span>PROMO</span><strong>${count ? `${count} promo sedang aktif` : state.cacheMode === "CONTENT_ONLY" ? "Status promo perlu koneksi" : "Belum ada promo aktif"}</strong></div><a href="/menu/promo">Lihat detail <span aria-hidden="true">→</span></a></aside>`; }
function storeStatusMarkup() {
  const store = state.payload.store;
  if (store.statusUnknown || state.cacheMode === "CONTENT_ONLY") return `<aside class="store-status is-unknown" role="status"><span aria-hidden="true"></span><div><strong>Status layanan belum dapat diperbarui</strong><small>Konfirmasi ketersediaan dan jam layanan kepada kru.</small></div></aside>`;
  const closed = store.orderingPaused || (store.hoursEnforced && !withinHours(store));
  return `<aside class="store-status ${closed ? "is-closed" : ""}" role="status"><span aria-hidden="true"></span><div><strong>${closed ? "Kedai sedang tutup—katalog tetap bisa dilihat" : "Katalog aktif"}</strong><small>${store.locationLabel ? `${escapeHtml(store.locationLabel)} · ` : ""}Jam layanan ${escapeHtml(store.opensAt)}–${escapeHtml(store.closesAt)} WIB · pemesanan terakhir ${escapeHtml(store.lastOrderAt)}</small></div></aside>`;
}
function cacheNoticeMarkup() { return state.cacheMode === "LIVE" ? "" : `<aside class="cache-notice" role="status"><strong>Mode offline</strong><span>${state.cacheMode === "CONTENT_ONLY" ? "Isi menu tersimpan ditampilkan; stok, jam, dan promo disembunyikan sampai koneksi pulih." : "Menu tersimpan baru-baru ini ditampilkan sementara koneksi dipulihkan."}</span></aside>`; }
function freshnessCard() { return `<aside class="freshness-card"><p><strong>Katalog terbit SagaPOS</strong><br>${escapeHtml(freshnessLabel(state.payload.freshness.checkedAt))} · revision ${escapeHtml(state.payload.freshness.publishedRevision ?? 0)}${state.cacheMode === "LIVE" ? "" : " · cache"}</p><button class="refresh-button" type="button" data-refresh aria-label="Perbarui katalog">↻</button></aside>`; }

function handleClick(event) {
  const category = event.target.closest("[data-category]");
  if (category) {
    state.categoryId = category.dataset.category;
    updateFilterUrl();
    emitAnalytics("category_select", { category_id: state.categoryId });
    render();
    return revealActiveCategory();
  }
  if (event.target.closest("[data-clear-search]")) { state.query = ""; updateFilterUrl(); return render(); }
  if (event.target.closest("[data-refresh], [data-retry]")) { emitAnalytics("retry"); return void loadCatalog({ quiet: Boolean(state.payload) }); }
  const product = event.target.closest("[data-product]"); if (product) return openProduct(product.dataset.product, product);
  const promotion = event.target.closest("[data-promotion]"); if (promotion) return openPromotion(promotion.dataset.promotion, promotion);
  if (event.target.closest("[data-member-connect]")) emitAnalytics("member_connect");
}
function handleInput(event) { if (!event.target.matches("[data-search]")) return; state.query = event.target.value.slice(0, 80); updateFilterUrl(); render(); const search = app.querySelector("[data-search]"); search?.focus(); search?.setSelectionRange(state.query.length, state.query.length); }
function handleKeydown(event) { if (event.key !== "Enter" || !event.target.matches("[data-search]")) return; event.preventDefault(); emitAnalytics("search_submit", { result_count: visibleProducts(state.payload.catalog || []).length, query_length_bucket: queryLengthBucket(state.query) }); }

function revealActiveCategory() {
  requestAnimationFrame(() => {
    const active = app.querySelector('.category-rail [aria-pressed="true"]');
    if (!active) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
  });
}

function readUrlFilters() { const params = new URLSearchParams(location.search); const category = params.get("category") || "all"; const valid = new Set(["all", ...(state.payload?.catalog || []).map((item) => item.id)]); state.categoryId = valid.has(category) ? category : "all"; state.query = (params.get("q") || "").slice(0, 80); }
function updateFilterUrl() { const url = new URL(location.href); if (state.categoryId === "all") url.searchParams.delete("category"); else url.searchParams.set("category", state.categoryId); if (state.query) url.searchParams.set("q", state.query); else url.searchParams.delete("q"); history.replaceState({ catalog: true }, "", `${url.pathname}${url.search}${url.hash}`); }
function syncUrlState() {
  if (!state.payload) return;
  const previousCategoryId = state.categoryId;
  const previousQuery = state.query;
  readUrlFilters();
  const filtersChanged = previousCategoryId !== state.categoryId || previousQuery !== state.query;
  const product = location.hash.match(/^#product=([a-z0-9-]{1,80})$/i); const promo = location.hash.match(/^#promo=([a-z0-9-]{1,80})$/i);
  if (product) return openProduct(decodeURIComponent(product[1]), null, { fromUrl: true });
  if (promo) return openPromotion(decodeURIComponent(promo[1]), null, { fromUrl: true });
  if (dialog.open) { dialog.close(); return; }
  if (state.opener) return;
  // popstate and hashchange may straddle the dialog close event. Keep the opener
  // mounted when only the dialog hash changed, regardless of their event order.
  if (filtersChanged) render();
}
function setDialogHash(value) { const url = new URL(location.href); url.hash = value; history.pushState({ catalogDialog: value }, "", `${url.pathname}${url.search}${url.hash}`); }
function clearInvalidHash() { if (!location.hash) return; const url = new URL(location.href); url.hash = ""; history.replaceState({ catalog: true }, "", `${url.pathname}${url.search}`); }

function routeState(pathname, searchParams = new URLSearchParams()) {
  if (pathname === "/menu/promo") return { surface: "catalogue", surfaceLabel: "E-CATALOGUE", section: "promo" };
  if (pathname === "/menu/member") return { surface: "catalogue", surfaceLabel: "E-CATALOGUE", section: "member" };
  if (searchParams.get("source") === "table") return { surface: "qr-menu", surfaceLabel: "QR MENU MEJA", section: "menu" };
  return { surface: "catalogue", surfaceLabel: "E-CATALOGUE", section: "menu" };
}
function mediaFor(product) { const persisted = typeof product.imageUrl === "string" && product.imageUrl.length > 0; return { src: persisted ? product.imageUrl : productAssetPath(product.id), preview: !persisted && PRODUCT_ASSET_REVIEW_STATUS.illustrativeDummyProductIds.includes(product.id) }; }
function bindImageFallbacks(root) { root.querySelectorAll("[data-product-image]").forEach((image) => image.addEventListener("error", () => { image.closest(".product-media, .dialog-media, .hero-visual")?.classList.add("is-broken"); image.removeAttribute("src"); }, { once: true })); }
function withinHours(store) { const now = new Intl.DateTimeFormat("en-GB", { timeZone: store.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()); return now >= store.opensAt && now < store.lastOrderAt; }
function assertCatalogContract(payload) { if (payload.surfaceMode !== "CATALOG_PREVIEW" || payload.readOnly !== true || payload.capabilities?.cart !== false || payload.capabilities?.checkout !== false || payload.capabilities?.payment !== false || payload.capabilities?.tableIdentity !== false || payload.capabilities?.kdsDispatch !== false) throw Object.assign(new Error("Kontrak katalog tidak aman."), { code: "catalog_contract_invalid" }); }
function writeCatalogCache(payload) { try { const cachedPayload = structuredClone(payload); cachedPayload.catalog = cachedPayload.catalog.map((category) => ({ ...category, products: category.products.map((product) => ({ ...product, imageUrl: /^https?:\/\/|^\//.test(product.imageUrl || "") ? product.imageUrl : null })) })); localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 2, revision: payload.freshness.publishedRevision, storedAt: Date.now(), payload: cachedPayload })); } catch { /* optional */ } }
function readCatalogCache() {
  try {
    const record = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (record?.version !== 2 || !record.payload || !Number.isFinite(record.storedAt) || record.revision !== record.payload?.freshness?.publishedRevision) return null; assertCatalogContract(record.payload);
    const age = Date.now() - record.storedAt; if (age < 0 || age > CONTENT_CACHE_MAX_AGE_MS) return null;
    const payload = structuredClone(record.payload);
    if (age > STATUS_CACHE_MAX_AGE_MS) { payload.promotions = []; payload.store = { ...payload.store, statusUnknown: true }; payload.catalog = payload.catalog.map((category) => ({ ...category, products: category.products.map((product) => ({ ...product, available: null })) })); return { payload, mode: "CONTENT_ONLY" }; }
    return { payload, mode: "FRESH_CACHE" };
  } catch { return null; }
}
function emitAnalytics(name, properties = {}) { if (!ANALYTICS_EVENTS.has(name)) return; const keys = new Set(["cache_mode", "category_id", "product_id", "promo_id", "result_count", "query_length_bucket"]); const safe = Object.fromEntries(Object.entries(properties).filter(([key, value]) => keys.has(key) && ["string", "number", "boolean"].includes(typeof value))); const event = { event: name, surface: route.surface, section: route.section, ...safe }; globalThis.dataLayer = Array.isArray(globalThis.dataLayer) ? globalThis.dataLayer : []; globalThis.dataLayer.push(event); globalThis.dispatchEvent(new CustomEvent("saga:catalog-analytics", { detail: event })); }

function isMaintenanceError(error) { return ["maintenance", "production_maintenance", "service_maintenance", "http_503"].includes(error?.code); }
function safeExternalUrl(value) { try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; } }
function availabilityText(value) { return value === false ? "SEDANG HABIS" : value == null ? "STATUS BELUM DIPERBARUI" : "TERSEDIA"; }
function promotionOffer(promotion) { return promotion.type === "PERCENT" ? `${Number(promotion.value) / 100}%` : ["FIXED", "FIXED_PRICE"].includes(promotion.type) ? catalogPrice(promotion.value) : "Promo"; }
function displayPrice(value) { return state.cacheMode === "CONTENT_ONLY" ? `Harga terakhir · ${catalogPrice(value)}` : catalogPrice(value); }
function queryLengthBucket(value) { const length = value.trim().length; return length === 0 ? "0" : length <= 3 ? "1-3" : length <= 10 ? "4-10" : "11-80"; }
function catalogPrice(value) { const amount = Number(value || 0); return Number.isSafeInteger(amount) && amount % 1000 === 0 ? `${amount / 1000}K` : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(amount); }
function signedCatalogPrice(value) { const amount = Number(value || 0); return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${catalogPrice(Math.abs(amount))}`; }
function categoryChip(id, label, active) { return `<button class="category-chip" type="button" data-category="${escapeHtml(id)}" aria-pressed="${active}">${escapeHtml(label)}</button>`; }
function loadingMarkup() { return '<section class="loading-state" aria-label="Memuat katalog"><span class="spinner" aria-hidden="true"></span><p>Menyiapkan menu Kopi Saga…</p></section>'; }
function emptyMarkup() { return '<div class="empty-state"><h2>Menu tidak ditemukan.</h2><p>Coba kata lain atau pilih kategori Semua.</p></div>'; }
function renderMaintenance() { app.innerHTML = '<section class="error-state maintenance-state"><p class="eyebrow">PEMELIHARAAN</p><h1>Katalog sedang dirawat.</h1><p>Kami sedang menyiapkan pembaruan. Coba lagi sebentar lagi.</p><button class="retry-button" type="button" data-retry>Coba lagi</button><span class="error-code">catalog_maintenance</span></section>'; }
function renderError(message, code) { app.innerHTML = `<section class="error-state"><p class="eyebrow">KATALOG MENU</p><h1>Menu belum dapat dibuka.</h1><p>${escapeHtml(message)}</p><button class="retry-button" type="button" data-retry>Coba lagi</button><span class="error-code">${escapeHtml(code || "catalog_unavailable")}</span></section>`; }
function announceNetwork(message) { networkStatus.textContent = message; networkStatus.hidden = false; clearTimeout(announceNetwork.timer); announceNetwork.timer = setTimeout(() => { networkStatus.hidden = true; }, 4000); }
function freshnessLabel(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? "Status sinkronisasi tidak tersedia" : `Disinkronkan ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(time)} WIB`; }
function formatDate(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? "tidak tersedia" : new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(time); }
function searchIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>'; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
