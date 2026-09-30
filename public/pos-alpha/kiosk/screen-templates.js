import { escapeHtml, formatCountdown, maskReference, rupiah, safePngDataUrl } from "./formatters.js";
import { icon } from "./icons.js";
import { SCREENS } from "./flow-machine.js";
import { paymentCheckPresentation, paymentRecoveryPresentation } from "./payment-confidence.js";
import { productAssetPath } from "./product-assets.js";

export function renderScreen(screen, model) {
  if (model.checkoutAttempt) return shell(`${topbar()}
    <div class="screen-heading"><h1 id="checkout-recovery-heading" tabindex="-1">Memastikan pesananmu</h1>
    <p role="status">${model.checkoutLoading ? "Sedang menghubungkan ke server…" : "Status pesanan belum dapat dipastikan."}</p></div>
    <div class="quote-card checkout-attempt-summary"><h2>Pilihan yang dikirim</h2>
    <p class="checkout-attempt-order-type">${model.checkoutAttempt.orderType === "TAKEAWAY" ? "Bawa Pulang" : "Makan di Sini"}</p>
    <ul class="checkout-attempt-list" tabindex="0" aria-label="Menu dalam pesanan yang sedang diperiksa">${model.checkoutAttempt.cart.map(line=>attemptChoiceLine(line,model)).join("")}</ul>
    <p class="checkout-attempt-total">Total saat dikirim <strong>${rupiah(model.checkoutAttempt.expectedQuote.totalRupiah)}</strong></p>
    <p>Menu dan jumlah dikunci sementara agar pesanan tidak berubah saat koneksi dipulihkan.</p>
    <p>Jangan bayar ulang. Jika belum bisa tersambung, minta bantuan kasir.</p></div>
    ${model.checkoutError ? `<p class="inline-error" role="alert">${escapeHtml(model.checkoutError)}</p>` : ""}
    <footer class="screen-action-stack">${primary(model.checkoutLoading ? "Memeriksa…" : "Periksa Pesanan", "checkout", { disabled: model.checkoutLoading || model.networkOnline === false })}</footer>`, "checkout-recovery-screen");
  const render = renderers[screen] || renderOutOfService;
  return render(model);
}

const renderers = {
  [SCREENS.WELCOME]: renderWelcome,
  [SCREENS.ORDER_TYPE]: renderOrderType,
  [SCREENS.BROWSE]: renderBrowse,
  [SCREENS.MODIFIER]: renderModifier,
  [SCREENS.CART]: renderCart,
  [SCREENS.MEMBER]: renderMember,
  [SCREENS.MEMBER_WELCOME]: renderMemberWelcome,
  [SCREENS.PAYMENT_METHOD]: renderPaymentMethod,
  [SCREENS.PAYMENT_PENDING]: renderPaymentPending,
  [SCREENS.PAYMENT_RECOVERY]: renderPaymentRecovery,
  [SCREENS.SUCCESS]: renderSuccess,
  [SCREENS.OUT_OF_SERVICE]: renderOutOfService,
};

function attemptChoiceLine(line, model) {
  const details=(line.selections || []).map(selection=>selection.optionLabel).filter(Boolean).join(" · ");
  return `<li><span><span class="attempt-choice-name">${escapeHtml(model.productById(line.productId)?.name || "Menu pesanan")}</span>${details ? `<small class="attempt-choice-detail">${escapeHtml(details)}</small>` : ""}${line.note ? `<small class="attempt-choice-note">Catatan: ${escapeHtml(line.note)}</small>` : ""}</span><strong>${escapeHtml(line.qty)}×</strong></li>`;
}

function shell(content, className = "") {
  return `<section class="kiosk-screen ${className}">${content}</section>`;
}

function brand() {
  return '<div class="brand-wordmark"><img src="/assets/brand/kopi-saga-logo-cream-v1.svg" alt="Kopi Saga" width="1087" height="850"></div>';
}

function topbar({ progress, backAction, backLabel = "Kembali" } = {}) {
  const helpAction = `<button class="icon-text-action help-action" type="button" data-action="help">${icon("help")}<span>Bantuan</span></button>`;
  return `<header class="screen-topbar">
    ${backAction ? `<button class="icon-text-action" type="button" data-action="${backAction}">${icon("arrow-left")}<span>${escapeHtml(backLabel)}</span></button>` : brand()}
    ${progress ? `<div class="topbar-actions"><div class="progress-pill" aria-label="Langkah ${escapeHtml(progress)}"><strong>${escapeHtml(progress.slice(0, 1))}</strong><span>${escapeHtml(progress.slice(1))}</span></div>${helpAction}</div>` : helpAction}
  </header>`;
}

function primary(label, action, { disabled = false, iconName = "arrow-right", id = "" } = {}) {
  return `<button ${id ? `id="${id}"` : ""} class="primary-action" type="button" data-action="${action}" ${disabled ? "disabled" : ""}><span>${escapeHtml(label)}</span><span class="action-icon">${icon(iconName)}</span></button>`;
}

function isPrototypeMode(model) {
  return model.snapshot?.context?.paymentMode === "OFF";
}

function prototypeNotice(model) {
  return isPrototypeMode(model) ? `<div class="prototype-notice" role="status">${icon("alert")}<span><strong>Mode Uji</strong> Order hanya masuk antrean uji; tidak dicatat sebagai penjualan dan tidak mengurangi stok.</span></div>` : "";
}

function renderWelcome(model) {
  const heroDrinkAsset = productAssetPath("es-kopi-saga");
  return shell(`${topbar()}
    <div class="welcome-layout">
      <div class="welcome-copy">
        <p class="index-label">SELF ORDER · 01</p>
        <h1>Ngopi enak,<br>pesan sendiri.</h1>
        <p>Pilih minumanmu, bayar, lalu pantau nomor pesanan di bar.</p>
      </div>
      <div class="hero-drink" aria-hidden="true">
        <span class="hero-orbit"></span>
        <img class="hero-drink-image" data-kiosk-image src="${escapeHtml(heroDrinkAsset)}" alt="" width="512" height="768" fetchpriority="high" decoding="async">
        <span class="image-load-fallback hero-image-fallback">${icon("coffee")}<small>Visual minuman belum termuat</small></span>
        <span class="spark spark-one">✦</span><span class="spark spark-two">✦</span>
      </div>
    </div>
    ${prototypeNotice(model)}
    <footer class="screen-action-stack">
      ${primary("Mulai Pesan", "start-order", { id: "start-order" })}
    </footer>`, "welcome-screen");
}

function renderOrderType(model) {
  const choice = model.orderType;
  return shell(`${topbar({ progress: "1 dari 5", backAction: "back-welcome" })}
    <div class="screen-heading">
      <p class="index-label">PESANAN · 01</p>
      <h1>Mau dinikmati di mana?</h1>
    </div>
    <div class="choice-grid order-type-grid" role="radiogroup" aria-label="Tipe pesanan">
      ${orderTypeCard("DINE_IN", "Makan di Sini", "Kami siapkan untuk dinikmati di kedai.", choice)}
      ${orderTypeCard("TAKEAWAY", "Bawa Pulang", "Dikemas praktis untuk perjalananmu.", choice)}
    </div>
    <footer class="screen-action-stack">${primary("Pilih Menu", "continue-menu", { disabled: !choice })}</footer>`, "decision-screen");
}

function orderTypeCard(value, label, description, selected) {
  const active = selected === value;
  return `<button class="choice-card ${active ? "is-selected" : ""}" type="button" role="radio" aria-checked="${active}" data-action="select-order-type" data-value="${value}">
    <span class="choice-icon">${icon(value === "DINE_IN" ? "coffee" : "bag")}</span>
    <span class="choice-copy"><strong>${label}</strong><small>${description}</small></span>
    <span class="selection-mark">${active ? icon("check") : ""}</span>
  </button>`;
}

function renderBrowse(model) {
  const catalog = personalizedCatalog(model);
  const category = catalog.find((item) => item.id === model.selectedCategory) || catalog[0];
  const cartCount = countItems(model.cart);
  return shell(`${topbar({ progress: "3 dari 5", backAction: model.member ? "back-member-welcome" : "back-member" })}
    <div class="screen-heading compact-heading browse-heading">
      <div class="browse-heading-copy">
        <p class="index-label">KOPI SAGA · MENU</p>
        <h1>Pilih menu favoritmu</h1>
        <p class="browse-editorial-line">Rasa yang akrab, dibuat lebih dekat.</p>
      </div>
      <aside class="browse-context-card" aria-label="Tentang kategori ${escapeHtml(category.name)}">
        <div class="browse-context-top"><span>Sedang dilihat</span><span class="browse-context-count"><strong>${String(category.products.length).padStart(2, "0")}</strong><small>menu</small></span></div>
        <h2 id="category-summary">${escapeHtml(category.name)}</h2>
        <p>${escapeHtml(categoryDescription(category.id))}</p>
      </aside>
    </div>
    ${recoveryNotice(model)}
    <div class="menu-layout">
      <nav class="category-rail" aria-label="Kategori menu">
        ${catalog.map((item) => categoryCard(item, item.id === category.id)).join("")}
      </nav>
      <div class="product-grid" aria-labelledby="category-summary">
        ${category.products.map((product, index) => productCard(product, category.id, index)).join("")}
      </div>
    </div>
    <footer class="cart-dock ${cartCount ? "has-items" : ""}">
      <div><span>${cartCount} item</span><strong>${rupiah(estimatedCartTotal(model))}</strong></div>
      <button type="button" data-action="open-cart" ${cartCount ? "" : "disabled"}>${icon("bag")}<span>Lihat Pesanan</span>${icon("arrow-right")}</button>
    </footer>`, "browse-screen");
}

function categoryDescription(categoryId) {
  return {
    "for-you": "Pilihan berdasarkan akun member demo ini. Harga dan ketersediaan tetap diperiksa oleh SagaOPS.",
    classic: "Kopi hitam dan susu yang familiar. Sentuh fotonya untuk atur rasa dan jumlah.",
    kupsus: "Racikan khas Kopi Saga yang creamy dan berkarakter. Sentuh untuk pilih racikannya.",
    nonkop: "Pilihan lembut tanpa kopi untuk jeda santai. Sentuh untuk atur pesananmu.",
    mocktail: "Rasa buah yang segar dan playful. Sentuh untuk pilih dan atur jumlahnya.",
    soda: "Soda dingin dengan sensasi ringan. Sentuh untuk pilih rasa favoritmu.",
    tea: "Teh buah yang ringan dan wangi. Sentuh untuk atur pesananmu.",
    bagel: "Bagel gurih-manis untuk camilan atau teman minum. Sentuh untuk memilih.",
  }[categoryId] || "Pilih menu yang paling pas untuk pesananmu.";
}

function personalizedCatalog(model) {
  if (!model.member || !model.recommendations?.length) return model.catalog;
  const products = model.recommendations.map((item) => model.productById(item.productId)).filter((product) => product && product.available !== false);
  return products.length ? [{ id: "for-you", name: "Untukmu", products }, ...model.catalog] : model.catalog;
}

function categoryCard(category, active) {
  const asset = category.products[0]?.imageUrl || productAssetPath(category.products[0]?.id);
  return `<button class="category-card tone-${escapeHtml(category.id)}" type="button" data-action="select-category" data-value="${escapeHtml(category.id)}" aria-current="${active ? "true" : "false"}">
    <span class="category-photo has-image" aria-hidden="true"><img data-kiosk-image src="${escapeHtml(asset)}" alt="" loading="eager" fetchpriority="low" decoding="async"><span class="category-photo-fallback">Foto belum termuat</span></span>
    <span class="category-name">${escapeHtml(category.name)}</span>
  </button>`;
}

function productCard(product, categoryId, index) {
  const available = product.available !== false && product.status !== "sold_out";
  return `<button class="product-card" type="button" data-action="open-product" data-product="${escapeHtml(product.id)}" ${available ? "" : "disabled"} aria-label="${escapeHtml(product.name)}, ${catalogPrice(product.priceRupiah)}${available ? "" : ", habis"}">
    <span class="product-index">${categoryId === "kupsus" ? "MENU KHAS" : "PILIH"}</span>
    ${productVisual(product, categoryId, "", { eager: index < 2 })}
    <span class="product-copy"><strong>${escapeHtml(product.name)}</strong><small>${available ? catalogPrice(product.priceRupiah) : "Habis"}</small></span>
    <span class="add-control" aria-hidden="true">${icon("plus")}</span>
  </button>`;
}

function renderModifier(model) {
  const product = model.modifierDraft?.product;
  if (!product) return renderBrowse(model);
  const isFood = product.customizationProfile === "none";
  const groups = [...(product.variantGroups || []), ...(product.modifierGroups || [])];
  const selectionIds = new Set(model.modifierDraft.selections.map((item) => `${item.groupId}:${item.optionId}`));
  const total = product.priceRupiah + model.modifierDraft.selections.reduce((sum, item) => sum + Number(item.priceDeltaRupiah || 0), 0);
  return shell(`${topbar({ backAction: "close-modifier" })}
    <div class="modifier-title"><p class="index-label">${isFood ? "ATUR BAGEL" : "ATUR MINUMAN"}</p><h1>Sesuaikan pesananmu</h1></div>
    <div class="modifier-hero">
      ${productVisual(product, model.productCategory(product.id), "modifier-visual")}
      <div><small>${isFood ? "Bagel pilihan" : "Minuman pilihan"}</small><h2>${escapeHtml(product.name)}</h2><p>${rupiah(product.priceRupiah)}</p></div>
    </div>
    <div id="modifier-options" class="modifier-content" role="region" aria-label="Pilihan dan catatan pesanan" tabindex="0">
      ${groups.map((group) => `<fieldset class="option-group option-group-${escapeHtml(group.id)}"><legend>${escapeHtml(group.label)}</legend><small class="option-helper">${group.id === "addons" ? "Opsional · pilih hingga dua tambahan" : "Opsional · resep standar tetap digunakan bila tidak dipilih"}</small><div class="option-chips">${group.options.map((option) => {
        const selected = selectionIds.has(`${group.id}:${option.id}`);
        return `<button type="button" class="option-chip ${selected ? "is-selected" : ""}" data-action="toggle-modifier" data-group="${escapeHtml(group.id)}" data-group-label="${escapeHtml(group.label)}" data-option="${escapeHtml(option.id)}" data-option-label="${escapeHtml(option.label)}" data-price="${Number(option.priceDeltaRupiah || 0)}" data-max="${Number(group.max || 1)}" aria-pressed="${selected}"><span class="option-label">${escapeHtml(option.label)}</span>${option.priceDeltaRupiah ? `<small>+${rupiah(option.priceDeltaRupiah)}</small>` : ""}<span class="option-choice-marker" aria-hidden="true">${selected ? icon("check") : icon("plus")}</span></button>`;
      }).join("")}</div></fieldset>`).join("")}
      <label class="note-field modifier-note-field"><span>${isFood ? "Catatan penyajian" : "Catatan untuk barista"} <small>Opsional</small></span><input id="modifier-note" type="text" maxlength="120" autocomplete="off" value="${escapeHtml(model.modifierDraft.note)}" placeholder="${isFood ? "Contoh: potong dua" : "Contoh: tanpa sedotan"}"><small>Maksimal 120 karakter</small></label>
      <div class="quantity-row modifier-quantity-row"><span>${isFood ? "Jumlah bagel" : "Jumlah minuman"}</span><div class="quantity-control"><button type="button" data-action="modifier-qty" data-delta="-1" aria-label="Kurangi jumlah">${icon("minus")}</button><strong>${model.modifierDraft.qty}</strong><button type="button" data-action="modifier-qty" data-delta="1" aria-label="Tambah jumlah">${icon("plus")}</button></div></div>
    </div>
    <footer class="screen-action-stack modifier-checkout-bar"><div class="modifier-total"><span>Total</span><strong>${rupiah(total * model.modifierDraft.qty)}</strong></div>${primary(model.modifierDraft.editingLineId ? "Simpan Perubahan" : "Tambah ke Pesanan", "save-modifier")}</footer>`, "modifier-screen");
}

function renderCart(model) {
  const rows = [...model.cart.values()];
  const quote = model.quote;
  const directQris = usesSingleQris(model) && !model.capabilities.memberInput;
  const prototypeMode = isPrototypeMode(model);
  const checkoutLabel = model.checkoutLoading ? (prototypeMode ? "Mengirim pesanan uji…" : "Menyiapkan QRIS…") : prototypeMode ? "Kirim Pesanan Uji" : directQris ? "Bayar dengan QRIS" : "Lanjut Pembayaran";
  const nextOrderType = model.orderType === "DINE_IN" ? "TAKEAWAY" : "DINE_IN";
  const nextOrderTypeLabel = nextOrderType === "DINE_IN" ? "Makan di Sini" : "Bawa Pulang";
  return shell(`${topbar({ progress: "4 dari 5", backAction: "back-menu" })}
    <div class="screen-heading compact-heading"><p class="index-label">PESANAN · PERIKSA</p><h1>Periksa pesananmu</h1></div>
    ${prototypeNotice(model)}
    <div class="cart-order-type"><div><small>Cara menikmati</small><strong>${model.orderType === "DINE_IN" ? "Makan di Sini" : "Bawa Pulang"}</strong></div><button type="button" data-action="cart-order-type" data-value="${nextOrderType}" aria-label="Ubah menjadi ${nextOrderTypeLabel}">Ubah</button></div>
    ${model.member ? `<div class="cart-member-summary"><div>${icon("check")}<span><small>Saga Member</small><strong>${escapeHtml(model.member.displayName)} · ${escapeHtml(model.member.tier)}</strong></span></div><button type="button" data-action="change-member">Ganti</button></div>` : ""}
    ${recoveryNotice(model)}
    ${model.storageWarning && rows.length ? '<p class="connectivity-note cart-storage-notice" role="status">Penyimpanan browser terbatas. Pesanan tetap bisa dilanjutkan; hindari memuat ulang halaman sebelum membayar.</p>' : ""}
    <div class="cart-review-table" role="region" aria-label="Daftar item pesanan">
      <div class="cart-review-header" aria-hidden="true"><span>Menu</span><span>Jumlah</span><span>Aksi</span></div>
      <div class="cart-review-list">
        ${rows.map((line, index) => cartRow(line, model.productById(line.productId), index)).join("")}
      </div>
    </div>
    ${model.removedLine ? `<div class="undo-banner" role="status"><span><strong>${escapeHtml(model.removedLine.productName)}</strong> dihapus dari pesanan.</span><button type="button" data-action="undo-remove">Urungkan</button></div>` : ""}
    <button class="add-more-action" type="button" data-action="back-menu">${icon("plus")}<span>Tambah Menu</span></button>
    <div class="quote-card" aria-busy="${model.quoteLoading}">
      ${model.quoteLoading ? '<p role="status">Menghitung total terbaru…</p><p>Pesananmu tetap tersimpan. Tunggu sebelum melanjutkan pembayaran.</p>' : model.quoteError ? `<p class="inline-error" role="alert">${escapeHtml(model.quoteError)}</p>${rows.length ? `<p>Menu dan pilihanmu tetap tersimpan. Hitung ulang total tanpa mengulang pesanan.</p><button type="button" class="secondary-action" data-action="retry-quote" ${model.networkOnline === false || model.checkoutLoading ? "disabled" : ""}>Hitung ulang total</button>` : ""}` : quoteRows(quote, rows, model)}
    </div>
    ${model.checkoutError ? `<p class="inline-error" role="alert">${escapeHtml(model.checkoutError)}</p>` : ""}
    ${model.networkOnline === false ? '<p class="connectivity-note" role="status">Sambungkan kembali internet untuk melanjutkan pembayaran.</p>' : ""}
    <footer class="screen-action-stack">${primary(checkoutLabel, "continue-payment", { id: "checkout-button", disabled: !rows.length || model.quoteLoading || model.checkoutLoading || model.networkOnline === false || Boolean(model.quoteError) })}</footer>`, "cart-screen");
}

function recoveryNotice(model) {
  return model.cartRecoveryNotice
    ? `<div class="cart-recovery-notice" role="status">${icon("refresh")}<span>${escapeHtml(model.cartRecoveryNotice)}</span><button type="button" data-action="dismiss-cart-recovery" aria-label="Tutup pemberitahuan pemulihan">${icon("check")}</button></div>`
    : "";
}

function cartRow(line, product, index) {
  const details = line.selections.map((item) => item.optionLabel).filter(Boolean).join(" · ") || "Default";
  const unitPrice = Number(product?.priceRupiah || 0) + line.selections.reduce((sum, item) => sum + Number(item.priceDeltaRupiah || 0), 0);
  const removeMode = line.qty <= 1;
  return `<article class="cart-review-row">
    <div class="cart-line-main"><span class="cart-item-index">${String(index + 1).padStart(2, "0")}</span>${miniProductVisual(product)}<div class="cart-line-copy"><strong>${escapeHtml(product?.name || line.productId)}</strong><small>${escapeHtml(details)}${line.note ? ` · ${escapeHtml(line.note)}` : ""}</small><span class="line-price">Satuan ${rupiah(unitPrice)}</span><strong class="cart-line-total">${rupiah(unitPrice * line.qty)}</strong></div></div>
    <div class="cart-line-quantity"><span class="visually-hidden">Jumlah ${escapeHtml(product?.name)}</span><div class="quantity-control"><button type="button" data-action="cart-qty" data-line="${escapeHtml(line.id)}" data-delta="-1" aria-label="Kurangi ${escapeHtml(product?.name)}" ${removeMode ? "disabled" : ""}>${icon("minus")}</button><strong>${line.qty}</strong><button type="button" data-action="cart-qty" data-line="${escapeHtml(line.id)}" data-delta="1" aria-label="Tambah ${escapeHtml(product?.name)}">${icon("plus")}</button></div><small>${line.qty} × ${rupiah(unitPrice)}</small></div>
    <div class="cart-line-actions"><button type="button" data-action="edit-line" data-line="${escapeHtml(line.id)}">${icon("edit")}<span>Ubah</span></button><button type="button" data-action="remove-line" data-line="${escapeHtml(line.id)}" aria-label="Hapus ${escapeHtml(product?.name)}">${icon("trash")}<span>Hapus</span></button></div>
  </article>`;
}

function quoteRows(quote, rows, model) {
  const subtotal = quote?.subtotalRupiah ?? estimatedCartTotal(model);
  const discount = quote?.discountRupiah ?? 0;
  const total = quote?.totalRupiah ?? subtotal;
  return `<div><span>Subtotal</span><strong>${rupiah(subtotal)}</strong></div>${discount ? `<div class="discount-row"><span>Diskon</span><strong>−${rupiah(discount)}</strong></div>` : ""}<div class="total-row"><span>Total</span><strong>${rupiah(total)}</strong></div><p>Total sudah dikonfirmasi. Perubahan pesanan akan dihitung ulang.</p>`;
}

function renderMember(model) {
  const codeLoading = model.memberLoading && model.memberLoadingMethod === "code";
  const nfcLoading = model.memberLoading && model.memberLoadingMethod === "nfc";
  const nfcOffline = model.networkOnline === false;
  const actionLabel = codeLoading ? "Memeriksa member…" : model.memberError ? "Coba lagi" : "Hubungkan akun";
  const guestLabel = model.memberError ? "Lanjut sebagai guest" : "Lanjut tanpa member";
  const memberMode = String(model.capabilities?.memberMode || "code").toLowerCase();
  const codeOnly = memberMode === "code";
  const fieldLabel = codeOnly ? "Kode member" : "Nomor HP atau kode member";
  const fieldPlaceholder = codeOnly ? "Contoh: SG-XXXX-000" : "Masukkan nomor atau kode";
  return shell(`${topbar({ progress: "2 dari 5", backAction: model.memberReturnScreen === SCREENS.CART ? "back-cart" : "back-order-type" })}
    <div class="screen-heading compact-heading"><p class="index-label">MEMBER · OPSIONAL</p><h1>Punya Saga Member?</h1><p>Kenali akunmu sebelum memilih menu untuk membuka rekomendasi yang lebih personal.</p></div>
    ${model.capabilities.nfcSimulatorAvailable ? `<button class="nfc-access-card is-demo-ready" type="button" data-action="simulate-nfc" aria-label="Simulasikan Tap NFC untuk menghubungkan Saga Member" ${model.memberLoading || nfcOffline ? "disabled" : ""}>
      <span class="nfc-access-icon">${icon("scan")}</span>
      <div><small>Tap NFC · SIMULATOR</small><strong>${nfcOffline ? "Tap NFC perlu koneksi" : nfcLoading ? "Membaca kartu demo…" : "Coba alur Tap NFC"}</strong><p>${nfcOffline ? "Sambungkan internet untuk verifikasi, atau lanjutkan sebagai guest." : "Simulasikan kartu Saga tanpa perangkat fisik atau data customer nyata."}</p></div>
      <span class="nfc-status-pill" aria-live="polite">${nfcOffline ? "Offline" : nfcLoading ? "Membaca" : "Demo siap"}</span>
    </button>` : `<section class="nfc-access-card ${model.capabilities.nfcAvailable ? "is-ready" : "is-unavailable"}" aria-label="Status NFC">
      <span class="nfc-access-icon">${icon("scan")}</span>
      <div><small>Tap NFC</small><strong>${model.capabilities.nfcAvailable ? "Tempelkan kartu atau HP" : "Belum tersedia di kiosk ini"}</strong><p>${model.capabilities.nfcAvailable ? "Tahan sebentar sampai akunmu ditemukan." : "Gunakan kode member untuk melanjutkan. Guest tetap bisa memesan."}</p></div>
      <span class="nfc-status-pill">${model.capabilities.nfcAvailable ? "Siap" : "Tidak aktif"}</span>
    </section>`}
    <div class="member-divider"><span>${codeOnly ? "atau gunakan kode" : "atau gunakan nomor HP"}</span></div>
    <label class="member-field"><span>${fieldLabel}</span><input id="member-code" type="text" inputmode="${codeOnly ? "text" : "tel"}" autocapitalize="characters" autocomplete="off" spellcheck="false" aria-describedby="member-privacy" value="${escapeHtml(model.memberCode)}" placeholder="${fieldPlaceholder}"></label>
    <p id="member-privacy" class="privacy-hint">${codeOnly ? "Kode" : "Nomor atau kode"} hanya dipakai untuk verifikasi server. Kode tidak disimpan di browser dan layar hanya menampilkan versi tersamarkan.</p>
    ${model.memberError ? `<section class="member-recovery-card" role="alert">${icon("alert")}<div><strong>Member belum dapat diperiksa</strong><p>${escapeHtml(model.memberError)}</p><span>Belum ada akun, benefit, order, atau pembayaran yang dibuat.</span></div></section>` : ""}
    ${model.checkoutError ? `<p class="inline-error" role="alert">${escapeHtml(model.checkoutError)}</p>` : ""}
    ${model.networkOnline === false ? '<p class="connectivity-note" role="status">Sambungkan kembali internet untuk melanjutkan pembayaran.</p>' : ""}
    <footer class="screen-action-stack">${primary(actionLabel, "submit-member", { disabled: !String(model.memberCode || "").trim() || model.memberLoading || model.networkOnline === false })}<button class="secondary-action" type="button" data-action="skip-member" ${model.memberLoading ? "disabled" : ""}>${guestLabel}</button></footer>`, "member-screen");
}

function renderMemberWelcome(model) {
  const recommendations = (model.recommendations || []).map((item) => ({ ...item, product: model.productById(item.productId) })).filter((item) => item.product && item.product.available !== false);
  return shell(`${topbar({ progress: "3 dari 5", backAction: "back-member" })}
    <section class="member-welcome-banner">
      <span class="member-welcome-icon">${icon("check")}</span>
      <div><p class="index-label">MEMBER · TERHUBUNG</p><h1>Selamat datang, ${escapeHtml(model.member?.displayName || "Member Saga")}</h1><p>${escapeHtml(model.member?.tier || "Member Saga")} · Rekomendasi ini disiapkan dari akun demo dan ketersediaan menu saat ini.</p></div>
    </section>
    ${model.memberRecoveryNotice ? `<p class="member-resume-notice" role="status">${icon("refresh")}<span>${escapeHtml(model.memberRecoveryNotice)}</span></p>` : ""}
    <section class="member-recommendations" aria-labelledby="member-recommendation-title">
      <header><div><small>PILIHAN PERSONAL</small><h2 id="member-recommendation-title">Mungkin kamu suka</h2></div><span>${recommendations.length} menu</span></header>
      <div class="recommendation-table">${recommendations.length ? recommendations.map((item) => recommendationRow(item)).join("") : '<div class="recommendation-empty"><strong>Belum ada rekomendasi tersedia</strong><span>Membermu tetap terhubung. Lihat semua menu untuk memilih yang tersedia.</span></div>'}</div>
    </section>
    <footer class="screen-action-stack">${primary("Lihat Semua Menu", "continue-recommendations")}</footer>`, "member-welcome-screen");
}

function recommendationRow({ product, reason }) {
  return `<button class="recommendation-row" type="button" data-action="open-product" data-product="${escapeHtml(product.id)}" aria-label="${escapeHtml(product.name)}, ${escapeHtml(reason)}, ${rupiah(product.priceRupiah)}">
    ${miniProductVisual(product)}
    <span class="recommendation-copy"><small>${escapeHtml(reason)}</small><strong>${escapeHtml(product.name)}</strong><span>${rupiah(product.priceRupiah)}</span></span>
    <span class="recommendation-action">${icon("arrow-right")}</span>
  </button>`;
}

function renderPaymentMethod(model) {
  const quote = model.quote || {};
  const total = quote.totalRupiah ?? estimatedCartTotal(model);
  const subtotal = quote.subtotalRupiah ?? estimatedCartTotal(model);
  const member = quote.member;
  const memberDiscount = Number(quote.memberDiscountRupiah || 0);
  const assistedCashEnabled = model.capabilities?.assistedCash?.enabled === true;
  const gatewayQrisEnabled = model.capabilities?.paymentMethods?.includes("QRIS") !== false;
  const staticQrisDemoEnabled = model.capabilities?.staticQrisDemo?.enabled === true;
  const manualQrisEnabled = model.capabilities?.manualQris?.enabled === true;
  const assistedCashAvailable = model.capabilities?.assistedCash?.available === true;
  const cashSelected = model.paymentMethod === "CASH_ASSISTED";
  const staticSelected = model.paymentMethod === "QRIS_STATIC_DEMO";
  const manualSelected = model.paymentMethod === "QRIS_STATIC_MANUAL";
  const dynamicQrisLabel = model.snapshot?.context?.production === true ? "QRIS Gateway" : "QRIS Dinamis (Simulasi)";
  const cashReceived = Number(model.cashReceivedRupiah || 0);
  const cashDifference = cashReceived - total;
  if (isPrototypeMode(model)) return shell(`${topbar({ progress: "5 dari 5", backAction: "back-cart" })}
    <div class="screen-heading"><p class="index-label">MODE UJI · KONFIRMASI</p><h1>Kirim pesanan uji</h1><p>Tidak ada pembayaran, penjualan, pemotongan stok, HPP, atau settlement yang dibuat.</p></div>
    ${prototypeNotice(model)}
    <section class="payment-breakdown-card" aria-label="Rincian simulasi"><div><span>Nilai menu simulasi</span><strong>${rupiah(total)}</strong></div><div class="total-row"><span>Dibayar</span><strong>Rp0</strong></div></section>
    ${model.checkoutError ? `<p class="inline-error" role="alert">${escapeHtml(model.checkoutError)}</p>` : ""}
    <footer class="screen-action-stack">${primary(model.checkoutLoading ? "Mengirim pesanan uji…" : "Kirim ke Antrean Uji", "checkout", { disabled: model.checkoutLoading || model.networkOnline === false })}</footer>`, "payment-method-screen prototype-payment-screen");
  return shell(`${topbar({ progress: "5 dari 5", backAction: "back-cart" })}
    <div class="screen-heading"><p class="index-label">PEMBAYARAN · KONFIRMASI</p><h1>${member ? "Benefit member terpasang" : "Periksa pembayaran"}</h1><p>Pastikan metode, benefit, dan totalnya benar sebelum melanjutkan.</p></div>
    <div class="payment-review-grid">
      <section class="payment-confirmation-card member-confirmation ${member ? "is-confirmed" : ""}" aria-label="Status member">
        <span class="confirmation-icon">${icon(member ? "check" : "user")}</span>
        <div><small>Member</small><strong>${escapeHtml(member?.codeMasked || "Tanpa member")}</strong><span>${member ? `${escapeHtml(member.tier || "Member Saga")} · Hemat ${rupiah(memberDiscount)}` : "Tidak ada benefit member"}</span></div>
      </section>
      <section class="payment-confirmation-card" aria-label="Metode pembayaran">
        <span class="confirmation-icon">${icon("scan")}</span>
        <div><small>Metode pembayaran</small><strong>${cashSelected ? "Tunai dibantu staf" : staticSelected ? "QRIS Statis DEMO" : manualSelected ? "QRIS Statis Merchant" : dynamicQrisLabel}</strong><span>${cashSelected ? "Uang baru dicatat setelah staf menerima" : staticSelected ? "Dummy; kasir konfirmasi simulasi" : manualSelected ? "Kasir cek aplikasi merchant sebelum pesanan dikirim" : "QR dibuat setelah konfirmasi"}</span></div>
      </section>
    </div>
    ${assistedCashEnabled || staticQrisDemoEnabled || manualQrisEnabled ? `<div class="payment-method-switch" role="group" aria-label="Pilih metode pembayaran">
      ${gatewayQrisEnabled ? `<button type="button" data-action="select-payment-method" data-value="QRIS" aria-pressed="${!cashSelected && !staticSelected && !manualSelected}" class="${cashSelected || staticSelected || manualSelected ? "" : "is-selected"}">${icon("scan")}<span><strong>${dynamicQrisLabel}</strong><small>Otomatis setelah terkonfirmasi</small></span></button>` : ""}
      ${manualQrisEnabled ? `<button type="button" data-action="select-payment-method" data-value="QRIS_STATIC_MANUAL" aria-pressed="${manualSelected}" class="${manualSelected ? "is-selected" : ""}">${icon("scan")}<span><strong>QRIS Statis Merchant</strong><small>Bayar sesuai total · kasir cek merchant</small></span></button>` : ""}
      ${staticQrisDemoEnabled ? `<button type="button" data-action="select-payment-method" data-value="QRIS_STATIC_DEMO" aria-pressed="${staticSelected}" class="${staticSelected ? "is-selected" : ""}">${icon("scan")}<span><strong>QRIS Statis DEMO</strong><small>Dummy · konfirmasi kasir</small></span></button>` : ""}
      ${assistedCashEnabled ? `
      <button type="button" data-action="select-payment-method" data-value="CASH_ASSISTED" aria-pressed="${cashSelected}" class="cash-assist-choice ${cashSelected ? "is-selected" : ""}" ${assistedCashAvailable ? "" : "disabled"}>${icon("user")}<span><strong>Tunai</strong><small>${assistedCashAvailable ? "Dibantu staf" : "Shift kasir belum aktif"}</small></span></button>
      ` : ""}
    </div>` : ""}
    ${cashSelected ? `<section class="cash-assist-card" aria-labelledby="cash-assist-title">
      <header><div><small>TUNAI · NOMINAL DISIAPKAN</small><h2 id="cash-assist-title">Berapa uang yang kamu serahkan?</h2></div><span>Staf konfirmasi</span></header>
      <div class="cash-assist-options">${(quote.assistedCash?.tenderOptions || []).map((option) => `<button type="button" data-action="select-cash-tender" data-value="${option.receivedRupiah}" class="${cashReceived === option.receivedRupiah ? "is-selected" : ""}"><strong>${escapeHtml(option.label)}</strong><small>${option.changeRupiah ? `Kembali ${rupiah(option.changeRupiah)}` : "Uang pas"}</small></button>`).join("")}</div>
      <label class="cash-assist-custom">Nominal lain (Rp)<input id="cash-received" inputmode="numeric" autocomplete="off" value="${cashReceived || ""}" placeholder="Contoh 100000" aria-describedby="cash-assist-status"></label>
      <p id="cash-assist-status" class="cash-assist-status" data-state="${cashDifference >= 0 && cashReceived ? "ready" : cashReceived ? "short" : "idle"}" role="status" aria-live="polite">${cashReceived === 0 ? "Pilih nominal atau masukkan uang yang disiapkan." : cashDifference >= 0 ? `Perkiraan kembalian ${rupiah(cashDifference)}. Staf akan menghitung ulang.` : `Nominal masih kurang ${rupiah(Math.abs(cashDifference))}.`}</p>
      <p class="cash-assist-safety"><strong>Belum dianggap lunas.</strong> Serahkan uang kepada staf; pesanan masuk antrean bar setelah staf mengonfirmasi penerimaan.</p>
    </section>` : ""}
    <section class="payment-breakdown-card" aria-label="Rincian total pembayaran">
      <div><span>Subtotal</span><strong>${rupiah(subtotal)}</strong></div>
      ${memberDiscount ? `<div class="discount-row"><span>Benefit member</span><strong>−${rupiah(memberDiscount)}</strong></div>` : ""}
      <div class="total-row"><span>Total pembayaran</span><strong>${rupiah(total)}</strong></div>
    </section>
    <button class="help-button" type="button" data-action="help">${icon("help")}<span>Butuh bantuan?</span></button>
    ${model.checkoutError ? `<p class="inline-error" role="alert">${escapeHtml(model.checkoutError)}</p>` : ""}
    ${model.networkOnline === false ? '<p class="connectivity-note" role="status">Sambungkan kembali internet untuk membuat pembayaran.</p>' : ""}
    <footer class="screen-action-stack">${primary(model.checkoutLoading ? (cashSelected ? "Memanggil staf…" : staticSelected ? "Membuat pesanan uji…" : "Menyiapkan QRIS…") : cashSelected ? (cashDifference >= 0 ? `Bayar tunai · kembali ${rupiah(cashDifference)}` : `Pilih nominal minimal ${rupiah(total)}`) : staticSelected ? "Coba QRIS Statis DEMO" : manualSelected ? `Tampilkan QRIS merchant · ${rupiah(total)}` : `Bayar ${rupiah(total)} dengan QRIS`, "checkout", { disabled: model.checkoutLoading || model.networkOnline === false || (cashSelected && cashReceived < total) })}</footer>`, "payment-method-screen");
}

function renderPaymentPending(model) {
  const payment = model.payment || {};
  if (payment.assistedCash === true) return renderAssistedCashPending(model);
  if (payment.staticQrisDemo === true) return renderStaticQrisDemoPending(model);
  if (payment.staticQrisManual === true) return renderManualQrisPending(model);
  const check = paymentCheckPresentation({ attempt: model.paymentCheckAttempt, loading: model.paymentCheckLoading, lastCheckedAt: model.paymentLastCheckedAt });
  const total = payment.amountRupiah ?? model.order?.totalRupiah ?? 0;
  const safeQrImage = safePngDataUrl(payment.qrImageDataUrl);
  const qr = payment.simulator === false && safeQrImage
    ? `<img class="live-qr" src="${escapeHtml(safeQrImage)}" alt="Kode QRIS untuk pembayaran pesanan ini">`
    : '<div class="simulated-qr" aria-label="QRIS simulator lokal, bukan QR pembayaran nyata"><span>QRIS</span><small>SIMULATOR</small></div>';
  return shell(`${topbar()}
    <div class="screen-heading compact-heading"><p class="index-label">PEMBAYARAN · QRIS</p><h1>Scan QRIS</h1><p>Gunakan aplikasi pembayaran di ponselmu.</p></div>
    <div class="qr-card"><div id="qr-visual" class="qr-visual">${qr}<div id="qr-expiry-overlay" class="qr-expiry-overlay" role="status" hidden><strong>Waktu QRIS habis</strong><small>Kami sedang memastikan status pembayaran</small></div></div><div class="qr-facts"><div><span>Total pembayaran</span><strong>${rupiah(total)}</strong></div><div><span id="payment-validity-label">${icon("clock")} Berlaku</span><strong id="payment-countdown">${payment.expiresAt ? formatCountdown(payment.expiresAt) : "--:--"}</strong><small>Ref ${maskReference(payment.providerReference || payment.id)}</small></div></div></div>
    <ol class="payment-steps" aria-label="Langkah pembayaran QRIS">
      <li><span>1</span><div><strong>Scan QRIS</strong><small>Arahkan kamera aplikasi pembayaran.</small></div></li>
      <li><span>2</span><div><strong>Selesaikan pembayaran</strong><small>Pastikan totalnya ${rupiah(total)}.</small></div></li>
      <li class="is-current"><span>3</span><div><strong>Tunggu konfirmasi</strong><small>Layar akan lanjut otomatis setelah pembayaran terkonfirmasi.</small></div></li>
    </ol>
    ${model.quote?.member ? `<p class="member-payment-note">${icon("check")}<span>Benefit ${escapeHtml(model.quote.member.codeMasked)} sudah diterapkan · Hemat ${rupiah(model.quote.memberDiscountRupiah || 0)}</span></p>` : ""}
    <div id="payment-status" class="pending-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="${Boolean(model.paymentCheckLoading)}"><span class="status-spinner" aria-hidden="true"></span><div><strong id="payment-status-title">${escapeHtml(check.title)}</strong><small id="payment-status-detail">${escapeHtml(check.detail)}</small><small id="payment-last-checked" class="last-checked" ${check.lastCheckedLabel ? "" : "hidden"}>${escapeHtml(check.lastCheckedLabel || "")}</small></div></div>
    ${payment.simulator !== false ? '<button id="simulate-paid" class="secondary-action" type="button" data-action="simulate-paid">Simulasikan Pembayaran Berhasil</button>' : ""}
    ${payment.simulator === false ? `<button id="check-payment" class="secondary-action" type="button" data-action="check-payment" ${model.paymentCheckLoading || model.networkOnline === false ? "disabled" : ""}>${icon("refresh")}<span>${check.automaticCheckPaused ? "Cek Status Lagi" : "Cek Status Sekarang"}</span></button>` : ""}
    <button class="help-button" type="button" data-action="help">${icon("help")}<span>Butuh bantuan?</span></button>
    <p class="payment-safety-note"><strong>Jangan scan atau bayar dua kali.</strong> Kami akan memberi tahu setelah pembayaran terkonfirmasi.</p>`, "payment-pending-screen");
}

function renderStaticQrisDemoPending(model) {
  const payment = model.payment || {};
  return shell(`${topbar()}
    <div class="screen-heading centered-heading"><p class="index-label">QRIS STATIS · SIMULATOR</p><h1>Menunggu konfirmasi kasir</h1><p>QR di bawah hanya dummy. Jangan pindai atau kirim uang.</p></div>
    <div class="qr-card"><div class="qr-visual"><img class="live-qr" src="${payment.qrImageUrl === "/api/kiosk/static-qris-demo/image" ? payment.qrImageUrl : "/assets/qris-static-demo.svg"}" alt="Gambar QRIS statis untuk simulasi, jangan digunakan untuk membayar" loading="eager"></div><div class="qr-facts"><div><span>Nomor pesanan uji</span><strong>${escapeHtml(model.order?.orderNumber || "—")}</strong></div><div><span>Nilai simulasi</span><strong>${rupiah(payment.amountRupiah || 0)}</strong></div></div></div>
    <p class="payment-safety-note"><strong>DEMO · Tidak ada uang yang perlu dibayar.</strong> Hanya kasir yang dapat menyetujui simulasi ini. Pesanan belum masuk KDS.</p>
    <div id="payment-status" class="pending-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false"><span class="status-spinner" aria-hidden="true"></span><div><strong id="payment-status-title">Menunggu kasir</strong><small id="payment-status-detail">Minta kasir membuka antrean QRIS Statis DEMO.</small><small id="payment-last-checked" class="last-checked" hidden></small></div></div>
    <button id="check-payment" class="secondary-action" type="button" data-action="check-payment" ${model.networkOnline === false ? "disabled" : ""}>${icon("refresh")}<span>Cek Status Sekarang</span></button>
    <button class="help-button" type="button" data-action="help">${icon("help")}<span>Butuh bantuan?</span></button>`, "payment-pending-screen static-qris-demo-pending-screen");
}

function renderManualQrisPending(model) {
  const payment = model.payment || {};
  return shell(`${topbar()}
    <div class="screen-heading centered-heading"><p class="index-label">QRIS STATIS · MERCHANT</p><h1>Bayar, lalu tunggu kasir</h1><p>Masukkan nominal tepat ${rupiah(payment.amountRupiah || 0)} di aplikasi pembayaran. QRIS ini belum menandai pesanan lunas secara otomatis.</p></div>
    <div class="qr-card"><div class="qr-visual"><img class="live-qr" src="/api/kiosk/manual-qris/image" alt="QRIS statis milik merchant untuk pembayaran" loading="eager"></div><div class="qr-facts"><div><span>Pesanan</span><strong>${escapeHtml(model.order?.orderNumber || "—")}</strong></div><div><span>Nominal tepat</span><strong>${rupiah(payment.amountRupiah || 0)}</strong></div></div></div>
    <p class="payment-safety-note"><strong>Jangan bayar dua kali.</strong> Tunjukkan transaksi kepada kasir. Pesanan baru masuk KDS setelah kasir memeriksa aplikasi merchant dan mengonfirmasi nominal serta referensinya.</p>
    <div id="payment-status" class="pending-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false"><span class="status-spinner" aria-hidden="true"></span><div><strong id="payment-status-title">Menunggu verifikasi kasir</strong><small id="payment-status-detail">Belum tercatat lunas; minta bantuan kasir jika status tidak berubah.</small><small id="payment-last-checked" class="last-checked" hidden></small></div></div>
    <button id="check-payment" class="secondary-action" type="button" data-action="check-payment" ${model.networkOnline === false ? "disabled" : ""}>${icon("refresh")}<span>Cek Status Sekarang</span></button>
    <button class="help-button" type="button" data-action="help">${icon("help")}<span>Butuh bantuan?</span></button>`, "payment-pending-screen manual-qris-pending-screen");
}

function renderAssistedCashPending(model) {
  const payment = model.payment || {};
  const order = model.order || {};
  return shell(`${topbar()}
    <div class="cash-wait-medallion" aria-hidden="true">${icon("user")}</div>
    <div class="screen-heading centered-heading"><p class="index-label">PEMBAYARAN · TUNAI</p><h1>Serahkan uang ke staf</h1><p>Pesananmu tersimpan, tetapi belum masuk antrean bar.</p></div>
    <section class="cash-wait-card" aria-label="Rincian pembayaran tunai">
      <div><span>Nomor pesanan</span><strong>${escapeHtml(order.orderNumber || "—")}</strong></div>
      <div><span>Total</span><strong>${rupiah(payment.amountRupiah)}</strong></div>
      <div><span>Uang disiapkan</span><strong>${rupiah(payment.receivedRupiah)}</strong></div>
      <div class="cash-change-row"><span>Perkiraan kembalian</span><strong>${rupiah(payment.changeRupiah)}</strong></div>
    </section>
    <ol class="payment-steps" aria-label="Langkah pembayaran tunai">
      <li><span>1</span><div><strong>Panggil staf</strong><small>Tunjukkan nomor pesanan ini.</small></div></li>
      <li class="is-current"><span>2</span><div><strong>Serahkan uang</strong><small>Staf menghitung nominal aktual.</small></div></li>
      <li><span>3</span><div><strong>Tunggu konfirmasi</strong><small>Pesanan masuk bar setelah lunas.</small></div></li>
    </ol>
    <div id="payment-status" class="pending-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="${Boolean(model.paymentCheckLoading)}"><span class="status-spinner" aria-hidden="true"></span><div><strong id="payment-status-title">Menunggu konfirmasi staf</strong><small id="payment-status-detail">Serahkan uang ke staf. Pesanan belum masuk antrean bar sebelum uang diterima.</small><small id="payment-last-checked" class="last-checked" ${model.paymentLastCheckedAt ? "" : "hidden"}>${model.paymentLastCheckedAt ? "Status baru diperiksa" : ""}</small></div></div>
    ${payment.simulator !== false ? '<button id="simulate-paid" class="secondary-action" type="button" data-action="simulate-paid">Simulasikan Tunai Diterima</button>' : `<button id="check-payment" class="secondary-action" type="button" data-action="check-payment" ${model.paymentCheckLoading || model.networkOnline === false ? "disabled" : ""}>${icon("refresh")}<span>Cek Status Sekarang</span></button>`}
    <button class="help-button" type="button" data-action="help">${icon("help")}<span>Butuh bantuan?</span></button>
    <p class="payment-safety-note"><strong>Jangan serahkan uang dua kali.</strong> Staf kasir menjadi konfirmasi final pembayaran.</p>`, "payment-pending-screen assisted-cash-pending-screen");
}

function productVisual(product, categoryId, extraClass = "", { eager = false } = {}) {
  const productId = typeof product === "string" ? product : product?.id;
  const asset = (typeof product === "object" && product?.imageUrl) || productAssetPath(productId);
  if (asset) return `<span class="product-visual has-image tone-${escapeHtml(categoryId)} ${escapeHtml(extraClass)}" aria-hidden="true"><img data-kiosk-image src="${escapeHtml(asset)}" alt="" loading="${eager ? "eager" : "lazy"}" fetchpriority="${eager ? "high" : "low"}" decoding="async"><span class="image-load-fallback">${icon("coffee")}<small>Foto belum termuat</small></span></span>`;
  return `<span class="product-visual tone-${escapeHtml(categoryId)} ${escapeHtml(extraClass)}" aria-hidden="true"><span></span></span>`;
}

function miniProductVisual(product) {
  const productId = typeof product === "string" ? product : product?.id;
  const asset = (typeof product === "object" && product?.imageUrl) || productAssetPath(productId);
  if (asset) return `<div class="mini-product-visual has-image" aria-hidden="true"><img data-kiosk-image src="${escapeHtml(asset)}" alt="" loading="lazy" decoding="async"><span class="image-load-fallback">${icon("coffee")}</span></div>`;
  return '<div class="mini-product-visual tone-neutral" aria-hidden="true"></div>';
}

function renderPaymentRecovery(model) {
  const recovery = paymentRecoveryPresentation(model.payment?.status);
  return shell(`${topbar()}
    <div class="recovery-illustration" aria-hidden="true"><span>${icon("alert")}</span><i></i></div>
    <div class="screen-heading centered-heading"><p class="index-label">${escapeHtml(recovery.eyebrow)}</p><h1>${escapeHtml(recovery.title)}</h1><p>${escapeHtml(model.recoveryMessage || recovery.description)}</p></div>
    <div class="recovery-note" role="alert">${icon("alert")}<span>${escapeHtml(recovery.safety)}</span></div>
    <div class="recovery-order-fact"><span>Pesanan</span><strong>${escapeHtml(model.order?.orderNumber || "Belum tersedia")}</strong><small>Pesanan belum masuk antrean bar sampai pembayaran terkonfirmasi.</small></div>
    <footer class="screen-action-stack">${primary(model.reconcileLoading ? "Memeriksa status…" : recovery.retryLabel, "reconcile-payment", { iconName: "refresh", disabled: model.reconcileLoading || model.networkOnline === false })}<button class="secondary-action" type="button" data-action="help">${icon("help")}<span>Panduan bantuan</span></button></footer>`, "recovery-screen");
}

function renderSuccess(model) {
  const order = model.order || {};
  const items = order.items || [];
  const publicMenuDemo = model.snapshot?.context?.surface === "MENU_KIOSK_DEMO";
  const prototypeMode = !publicMenuDemo && (order.testMode === true || isPrototypeMode(model));
  return shell(`${topbar()}
    <div class="success-medallion">${icon("check")}</div>
    <div class="screen-heading centered-heading success-heading"><p class="index-label">${prototypeMode ? "MODE UJI · MASUK KE BAR" : "PESANAN · MASUK KE BAR"}</p><h1>${prototypeMode ? "Pesanan uji berhasil dibuat" : model.payment?.assistedCash ? (publicMenuDemo ? "Pembayaran tunai berhasil" : "Tunai diterima staf") : "Pembayaran berhasil"}</h1><p>${prototypeMode ? "Tidak ada pembayaran atau transaksi bisnis yang dicatat" : "Simpan nomor pesananmu"}</p></div>
    ${prototypeNotice(model)}
    <strong id="success-order" class="queue-number">${escapeHtml(order.orderNumber || "—")}</strong>
    <p class="pickup-copy">Tunggu nomor dipanggil di bar</p>
    <div class="success-summary"><span>${countOrderItems(order)} item · ${order.orderType === "TAKEAWAY" ? "Bawa Pulang" : "Makan di Sini"}</span><strong>Total ${rupiah(order.totalRupiah)}</strong></div>
    <section class="success-order-details" aria-labelledby="success-detail-title">
      <header><h2 id="success-detail-title">Detail pesanan</h2><span>${items.length} menu</span></header>
      <div class="success-order-scroll" role="region" aria-label="Daftar detail pesanan" tabindex="0"><ul>${items.map(successOrderLine).join("")}</ul></div>
    </section>
    <div class="success-timing-control" role="group" aria-labelledby="success-reset-copy">
      <p id="success-reset-copy" class="reset-copy">Layar dibersihkan otomatis dalam <span id="success-countdown">30</span> detik untuk menjaga privasi.</p>
      <button class="success-extend-action" type="button" data-action="extend-success">${icon("clock")}<span>Tambah 20 detik</span></button>
    </div>
    <footer class="screen-action-stack">${primary(publicMenuDemo ? "Pesan Lagi" : "Selesai", "finish-order", { id: "new-order" })}</footer>`, "success-screen");
}

function successOrderLine(item) {
  const name = item.productNameSnapshot || item.name || item.productId || "Minuman";
  const details = (item.selections || []).map((selection) => selection.optionLabel || selection.option).filter(Boolean);
  if (item.note) details.push(`Catatan: ${item.note}`);
  const unitPrice = Number(item.unitPriceRupiah || 0);
  const lineTotal = Number(item.lineTotalRupiah ?? unitPrice * Number(item.qty || 0));
  return `<li><div><strong>${Number(item.qty || 0)}× ${escapeHtml(name)}</strong>${details.length ? `<small>${escapeHtml(details.join(" · "))}</small>` : ""}</div><span>${rupiah(lineTotal)}</span></li>`;
}

function renderOutOfService(model) {
  return shell(`${topbar()}
    <div class="outage-symbol">${icon("alert")}</div>
    <div class="screen-heading centered-heading"><p class="index-label">LAYANAN · JEDA</p><h1>${model.resetPending ? "Menutup sesi sebelumnya" : "Kiosk sedang tidak tersedia"}</h1><p>${model.resetPending ? "Jika sudah membayar, jangan bayar ulang. Tunggu sesi ditutup atau minta bantuan kasir." : "Silakan pesan di kasir. Tidak ada pembayaran baru yang dibuat."}</p></div>
    ${model.outageMessage ? `<p class="inline-error">${escapeHtml(model.outageMessage)}</p>` : ""}
    <footer class="screen-action-stack">${primary(model.resetLoading ? "Menyiapkan sesi…" : "Coba Lagi", "retry-boot", { iconName: "refresh", disabled: model.resetLoading })}</footer>`, "outage-screen");
}

function countItems(cart) {
  return [...cart.values()].reduce((sum, line) => sum + line.qty, 0);
}

function countOrderItems(order) {
  return (order?.items || []).reduce((sum, line) => sum + Number(line.qty || 0), 0);
}

function estimatedCartTotal(model) {
  return [...model.cart.values()].reduce((sum, line) => {
    const product = model.productById(line.productId);
    const additions = line.selections.reduce((value, item) => value + Number(item.priceDeltaRupiah || 0), 0);
    return sum + ((product?.priceRupiah || 0) + additions) * line.qty;
  }, 0);
}

function catalogPrice(value) {
  const amount = Number(value || 0);
  return Number.isSafeInteger(amount) && amount % 1000 === 0 ? `${amount / 1000}K` : new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(amount);
}

function usesSingleQris(model) {
  const methods = model.capabilities?.paymentMethods || [];
  return methods.length === 1 && methods[0] === "QRIS";
}
