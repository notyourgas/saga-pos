import { receiptFacts, createReceiptDraft, captureReceiptDraft, renderReceiptFields, buildReceiptCommand, receiptPreview, addReceiptLot } from "./owner-po-receiving.js";
import { invoiceEvidence, invoiceFacts, createInvoiceDraft, captureInvoiceDraft, renderInvoiceFields, buildInvoiceCommand, invoicePreview, renderInvoiceHistory, invoiceStatus } from "./owner-invoice-match.js";
// Owner-only existing actions. Invoice matching never approves, posts AP, or pays.
export function createOwnerPoControls({ request, onChanged, onReceiptCommitted = () => {} }) {
  let host;
  let state = fresh();
  function fresh() { return { data: null, selected: null, mode: "detail", draft: null, busy: false, blocked: false, uncertain: null, committed: false, message: "" }; }
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const money = (value) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value || 0);
  const labels = { OPEN: "Menunggu barang", PARTIALLY_RECEIVED: "Diterima sebagian", RECEIVED: "Selesai", CANCELLED: "Dibatalkan" };
  const editable = (po) => po?.status === "OPEN" && po.lines.every((line) => !line.deliveredPurchaseQuantity);
  const cancellable = (po) => ["OPEN", "PARTIALLY_RECEIVED"].includes(po?.status);
  const selected = () => state.data?.purchaseOrders?.find((po) => po.id === state.selected) || (["receive", "invoice"].includes(state.mode) ? state.openingPo : null);
  const matchedReceipt = () => state.data?.purchaseReceipts?.find((receipt) => receipt.idempotencyKey === state.uncertain?.payload.idempotencyKey && receipt.purchaseOrderId === state.selected);
  const matchedInvoice = () => state.data?.purchaseInvoices?.find((invoice) => invoice.idempotencyKey === state.uncertain?.payload.idempotencyKey && invoice.purchaseOrderId === state.selected);
  const keySeen = () => state.mode === "invoice" ? matchedInvoice() : state.mode === "receive" ? matchedReceipt() : selected()?.changes?.some((change) => change.idempotencyKey === state.uncertain?.payload.idempotencyKey);
  function capture() {
    const form = host?.querySelector("form");
    if (!form || state.busy || state.blocked || state.committed) return;
    if (state.mode === "amend") state.draft = { supplierId: form.elements.supplierId.value, expectedDate: form.elements.expectedDate.value,
      reason: form.elements.reason.value, lines: [...form.querySelectorAll("fieldset")].map((row) => Object.fromEntries([...row.querySelectorAll("[name]")].map((field) => [field.name, field.value]))) };
    if (state.mode === "cancel") state.draft = { reason: form.elements.reason.value, confirmed: form.elements.confirmed.checked };
    if (state.mode === "receive") captureReceiptDraft(form, state.draft);
    if (state.mode === "invoice") captureInvoiceDraft(form, state.draft);
    syncPreview();
  }
  function syncPreview() {
    const invoiceSummary = host?.querySelector("[data-invoice-preview]");
    if (invoiceSummary) {
      const preview = invoicePreview(state.openingHpp, state.openingPo, state.draft);
      invoiceSummary.textContent = preview.text;
      host.querySelector("[data-save-invoice]").textContent = ["REVIEW", "BLOCKED"].includes(preview.status) ? "Simpan hasil dengan selisih" : "Catat invoice";
    }
    const receiptSummary = host?.querySelector("[data-receipt-preview]");
    if (receiptSummary) receiptSummary.textContent = receiptPreview(state.openingPo, state.data.ingredients, state.draft);
    const summary = host?.querySelector("[data-po-preview]");
    if (!summary || state.mode !== "amend") return;
    const total = state.draft.lines.reduce((sum, line) => sum + Math.round(Number(line.orderedPurchaseQuantity) * Number(line.unitCostRupiah)), 0);
    summary.textContent = `Nilai PO setelah revisi: ${Number.isSafeInteger(total) && total > 0 ? money(total) : "periksa jumlah dan harga"}. Stok dan pembayaran belum berubah.`;
  }
  function draw() {
    if (!host?.isConnected) return;
    const focus = host.querySelector("dialog")?.contains(document.activeElement) ? document.activeElement : null;
    const focusName = focus?.name;
    const focusIndex = focus ? [...host.querySelectorAll(`[name='${focusName}']`)].indexOf(focus) : 0;
    const po = selected();
    const rows = (state.data?.purchaseOrders ?? []).map((order) => `<tr><th scope="row">${esc(order.supplierNameSnapshot)}<small>Revisi ${order.revision}</small></th><td>${esc(order.expectedDate)}</td><td>${labels[order.status] ?? "Perlu diperiksa"}</td><td>${money(order.totalOrderedRupiah)}</td><td><button class="button button-ghost" type="button" data-detail="${esc(order.id)}" ${state.busy ? "disabled" : ""}>Kelola PO ${esc(order.supplierNameSnapshot)}</button></td></tr>`).join("");
    host.innerHTML = `<article class="dashboard-card span-12"><div class="section-heading"><div><h2>Kelola purchase order</h2><p class="card-subtitle">Revisi, terima barang, atau tutup sisa pesanan langsung di sini. Penerimaan menambah stok yang diterima baik; invoice dan pembayaran tetap terpisah.</p></div><button class="button button-ghost" type="button" data-load ${state.busy ? "disabled" : ""}>${state.data ? "Perbarui daftar PO" : "Tampilkan PO"}</button></div><p class="owner-card-note">${state.data ? "Menampilkan hingga 20 PO terbaru. Buka rincian untuk melihat bahan dan riwayat." : "Klik Tampilkan PO untuk mengambil detail terbaru."}</p>${rows ? `<div class="dashboard-table" role="region" aria-label="Kelola purchase order" tabindex="0"><table><thead><tr><th>Supplier</th><th>Perkiraan tiba</th><th>Status</th><th>Nilai rencana</th><th>Tindakan</th></tr></thead><tbody>${rows}</tbody></table></div>` : state.data ? "<p>Belum ada PO.</p>" : ""}${!po ? `<p role="status">${esc(state.message)}</p>` : ""}</article>${po ? dialog(po) : ""}`;
    const modal = host.querySelector("dialog");
    if (modal && state.mode === "detail") {
      modal.querySelector("form").insertAdjacentHTML("beforeend", renderInvoiceHistory(state.data, po));
      const evidence = invoiceEvidence(state.data, po);
      modal.querySelector("form").insertAdjacentHTML("beforeend", evidence.eligible ? `<button class="button button-primary" type="button" data-invoice ${state.busy ? "disabled" : ""}>Catat invoice${evidence.acceptedReceipt ? "" : " · bukti belum terverifikasi"}</button>` : '<p class="owner-card-note">Invoice memerlukan penerimaan dengan baris barang diterima. Stok hasil pemeriksaan saja belum cukup.</p>');
    }
    if (modal && state.mode === "invoice") {
      modal.querySelector("h2").textContent = "Catat invoice supplier";
      if (!invoiceEvidence(state.openingHpp, state.openingPo).complete) modal.querySelector("h2").insertAdjacentHTML("afterend", '<p class="owner-card-note">Riwayat yang tampil terbatas; sisa belum ditagih belum dapat dipastikan. Hasil server setelah simpan adalah rujukan.</p>');
      if (state.invoice) modal.querySelector("form").insertAdjacentHTML("beforeend", `<p class="owner-card-note" data-invoice-result>Invoice ${esc(state.invoice.invoiceNumber)} · ${esc(invoiceStatus(state.invoice))}. Stok dan pembayaran tidak berubah.</p>`);
    }
    syncPreview();
    if (modal) {
      modal.showModal();
      modal.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
      if (state.busy) modal.querySelectorAll("input, select, button").forEach((field) => { field.disabled = true; });
      if (focusName) modal.querySelectorAll(`[name='${focusName}']`)[focusIndex]?.focus();
    }
  }
  function dialog(po) {
    const ingredients = state.data.ingredients ?? [];
    const lines = po.lines.map((line) => `<li><strong>${esc(ingredients.find((item) => item.id === line.ingredientId)?.name || "Bahan")}</strong> · dipesan ${line.orderedPurchaseQuantity} ${esc(line.purchaseUnitLabel)} · diterima baik ${line.receivedPurchaseQuantity || 0} · ditolak ${line.rejectedPurchaseQuantity || 0} · sisa ${Math.max(0, line.orderedPurchaseQuantity - (line.deliveredPurchaseQuantity || 0))}</li>`).join("");
    const locked = state.busy || state.blocked || state.committed;
    const disabled = locked ? "disabled" : "";
    let form = "";
    if (state.mode === "amend") {
      const draft = state.draft;
      const fields = draft.lines.map((line, index) => `<fieldset class="owner-po-line"><legend>Bahan ${index + 1}</legend><label>Bahan<select name="ingredientId" required ${disabled}>${ingredients.map((item) => `<option value="${esc(item.id)}" ${item.id === line.ingredientId ? "selected" : ""}>${esc(item.name)} · ${esc(item.baseUnit)}</option>`).join("")}</select></label><div class="owner-po-fields">${[["purchaseUnitLabel", "Nama kemasan", "text"], ["orderedPurchaseQuantity", "Jumlah kemasan", "number"], ["baseUnitsPerPurchaseUnit", "Isi per kemasan", "number"], ["unitCostRupiah", "Harga per kemasan (Rp)", "number"]].map(([name, label, type]) => `<label>${label}<input name="${name}" type="${type}" value="${esc(line[name])}" ${type === "number" ? `min="${name === "unitCostRupiah" ? 1 : 0.001}" max="${name === "unitCostRupiah" ? 1000000000 : 1000000}" step="${name === "unitCostRupiah" ? 1 : 0.001}"` : 'maxlength="80"'} required ${disabled}></label>`).join("")}</div><button class="button button-ghost" type="button" data-remove="${index}" ${locked || draft.lines.length === 1 ? "disabled" : ""}>Hapus bahan ${index + 1}</button></fieldset>`).join("");
      form = `<label>Supplier<select name="supplierId" required ${disabled}>${state.data.suppliers.filter((item) => item.active || item.id === draft.supplierId).map((item) => `<option value="${esc(item.id)}" ${item.id === draft.supplierId ? "selected" : ""}>${esc(item.name)}${item.active ? "" : " (nonaktif — pilih pengganti)"}</option>`).join("")}</select></label><label>Perkiraan tiba<input name="expectedDate" type="date" value="${esc(draft.expectedDate)}" required ${disabled}></label>${fields}<button class="button button-ghost" type="button" data-add ${locked || draft.lines.length >= 100 ? "disabled" : ""}>Tambah bahan</button><label>Alasan revisi<input name="reason" maxlength="160" value="${esc(draft.reason)}" required ${disabled}></label><button class="button button-primary" type="submit" ${disabled}>Simpan revisi PO</button>`;
    } else if (state.mode === "cancel") form = `<p class="form-status">Pembatalan tidak dapat dibatalkan. Stok, biaya, penerimaan dan invoice yang sudah tercatat tetap utuh; hanya sisa pesanan ditutup.</p><label>Alasan pembatalan<input name="reason" maxlength="160" value="${esc(state.draft.reason)}" required ${disabled}></label><label><input name="confirmed" type="checkbox" required ${state.draft.confirmed ? "checked" : ""} ${disabled}> Saya memahami stok yang diterima tidak dibalik.</label><button class="button button-danger" type="submit" ${disabled}>${po.status === "PARTIALLY_RECEIVED" ? "Batalkan sisa pesanan" : "Batalkan PO"}</button>`;
    else if (state.mode === "receive") form = renderReceiptFields(state.openingPo, state.data.ingredients, state.draft, disabled);
    else if (state.mode === "invoice") form = renderInvoiceFields(state.openingPo, state.openingHpp.ingredients, state.draft, disabled);
    const history = (po.changes ?? []).map((change) => `<li>${esc(change.action === "AMENDED" ? "Direvisi" : "Dibatalkan")} · ${esc(change.occurredAt)} · ${esc(change.reason)}</li>`).join("");
return `<dialog class="owner-po-dialog" aria-labelledby="po-control-title"><form class="owner-po-form" aria-busy="${state.busy}"><div class="section-heading"><div><h2 id="po-control-title">${state.mode === "amend" ? "Revisi PO" : state.mode === "cancel" ? "Konfirmasi pembatalan PO" : state.mode === "receive" ? "Terima barang dari PO" : "Rincian PO"}</h2><p>${esc(po.supplierNameSnapshot)} · revisi ${po.revision} · ${labels[po.status]}</p></div><button class="button button-ghost" type="button" data-close ${state.busy || state.uncertain ? "disabled" : ""}>Tutup</button></div><ul>${lines}</ul>${po.cancelReason ? `<p>Alasan pembatalan: ${esc(po.cancelReason)}</p>` : ""}${history ? `<details><summary>Riwayat perubahan</summary><ul>${history}</ul></details>` : ""}${form}${state.mode === "amend" ? '<p class="owner-card-note" data-po-preview aria-live="polite"></p>' : ""}${state.mode === "detail" ? `<div class="button-row">${editable(po) ? '<button class="button button-primary" type="button" data-amend>Revisi PO</button>' : '<p>Rincian terkunci: PO sudah diterima atau ditutup.</p>'}${cancellable(po) ? `<button class="button button-primary" type="button" data-receive>Terima barang</button><button class="button button-danger" type="button" data-cancel>${po.status === "PARTIALLY_RECEIVED" ? "Batalkan sisa pesanan" : "Batalkan PO"}</button>` : ""}</div>` : ""}${state.receipt ? `<p class="owner-card-note">Penerimaan ${esc(state.receipt.id)} tercatat: ${state.receipt.deliveredLines?.reduce((sum, line) => sum + line.deliveredPurchaseQuantity, 0) || 0} kemasan datang, ${state.receipt.rejectedLines?.reduce((sum, line) => sum + line.rejectedPurchaseQuantity, 0) || 0} ditolak. Nilai stok ${money(state.receipt.totalCostRupiah)}. Invoice dan pembayaran tidak berubah.</p>` : ""}<p role="status" aria-live="polite">${esc(state.message)}</p><div class="button-row"><button class="button button-ghost" type="button" data-load ${state.busy ? "disabled" : ""}>Perbarui data PO</button>${state.uncertain ? '<button class="button button-primary" type="button" data-replay>Periksa ulang penyimpanan yang sama</button>' : ""}</div></form></dialog>`;
  }
  function close() {
    if (state.busy || state.uncertain) return;
    const id = state.selected;
    host?.querySelector("dialog")?.close();
    state.selected = null; state.draft = null; state.message = ""; state.mode = "detail"; state.committed = false; state.blocked = false;
    draw();
    [...(host?.querySelectorAll("[data-detail]") ?? [])].find((button) => button.dataset.detail === id)?.focus();
  }
  async function load() {
    if (state.busy) return;
    capture();
    const session = state;
    state.busy = true; state.message = "Mengambil data PO terbaru…"; draw();
    try {
      const data = await request("/api/admin/state");
      if (state !== session) return;
      state.data = data.hpp;
      if (state.uncertain) {
        if (keySeen()) { if (state.mode === "receive") { state.receipt = matchedReceipt(); onReceiptCommitted(); } if (state.mode === "invoice") state.invoice = matchedInvoice(); state.uncertain = null; state.committed = true; state.message = "Perubahan tersimpan. Riwayat server sudah dikonfirmasi."; }
        else state.message = "Hasil belum dapat dipastikan. Periksa ulang penyimpanan yang sama tanpa mengganti data.";
      } else if (state.committed) state.message = "Perubahan tersimpan. Data terbaru sudah dimuat.";
      else if (state.selected && state.mode !== "detail") {
        if (state.mode === "invoice") {
          const current = data.hpp.purchaseOrders.find((order) => order.id === state.selected);
          state.blocked = invoiceFacts(data.hpp, current) !== state.openingFacts;
          state.message = state.blocked ? "Data invoice berubah. Draft tetap tersedia; tutup dan buka ulang untuk review. Versi draft tidak diganti." : "Data diperbarui. Periksa draft sebelum menyimpan.";
        } else if (state.mode === "receive") {
          const current = data.hpp.purchaseOrders.find((order) => order.id === state.selected);
          state.blocked = data.hpp.version !== state.expectedVersion || receiptFacts(current) !== state.openingFacts;
          state.message = state.blocked ? "Data penerimaan berubah. Draft tetap tersedia; tutup dan buka ulang untuk memeriksa sisa PO. Versi draft tidak diganti." : "Data diperbarui. Periksa draft sebelum menyimpan.";
        } else if (!selected() || state.openingRevision !== selected().revision || (state.mode === "amend" && !editable(selected()))) {
          state.blocked = true; state.message = "PO berubah di tempat lain. Draft tetap tersedia. Tutup lalu buka rincian terbaru sebelum membuat perubahan baru.";
        } else { state.expectedVersion = data.hpp.version; state.blocked = false; state.message = "Data diperbarui. Periksa draft sebelum menyimpan."; }
      } else state.message = "Data PO diperbarui.";
      if (state.mode === "receive" && state.committed) await onChanged({ receipt: true, isCurrent: () => state === session });
      if (state.mode === "invoice" && state.committed) await onChanged({ receipt: false, isCurrent: () => state === session });
    } catch { if (state === session) state.message = state.committed ? "Perubahan tersimpan, tetapi data terbaru belum berhasil dimuat. Perbarui data PO; jangan simpan ulang." : "Data PO belum berhasil dimuat. Coba perbarui lagi."; }
    finally { if (state === session) { state.busy = false; draw(); } }
  }
  async function save(replay = false) {
    if (state.busy || (!replay && (state.blocked || state.committed))) return;
    const form = host.querySelector("form");
    if (!replay && !form.reportValidity()) return;
    capture();
    const session = state;
    let command = state.uncertain;
    if (!replay) {
      const draft = state.draft;
      if (state.mode === "amend" && new Set(draft.lines.map((line) => line.ingredientId)).size !== draft.lines.length) { state.message = "Satu bahan hanya boleh muncul sekali. Gabungkan jumlahnya."; draw(); return; }
      if (state.mode === "invoice") {
        try { command = buildInvoiceCommand({ hpp: state.openingHpp, po: state.openingPo, draft, expectedVersion: state.expectedVersion, idempotencyKey: state.key }); }
        catch (error) { state.message = error.message; draw(); return; }
      } else if (state.mode === "receive") {
        try { command = buildReceiptCommand({ po: state.openingPo, ingredients: state.data.ingredients, draft, expectedVersion: state.expectedVersion, idempotencyKey: state.key, businessDate: state.businessDate, destinationLocationId: state.destinationLocationId }); }
        catch (error) { state.message = error.message; draw(); return; }
      } else command = { action: `hpp.purchase_order.${state.mode === "amend" ? "amend" : "cancel"}`, payload: { purchaseOrderId: state.selected, expectedVersion: state.expectedVersion, reason: draft.reason.trim(), idempotencyKey: state.key,
        ...(state.mode === "amend" ? { supplierId: draft.supplierId, expectedDate: draft.expectedDate, lines: draft.lines.map((line) => ({ ingredientId: line.ingredientId, purchaseUnitLabel: line.purchaseUnitLabel.trim(), orderedPurchaseQuantity: Number(line.orderedPurchaseQuantity), baseUnitsPerPurchaseUnit: Number(line.baseUnitsPerPurchaseUnit), unitCostRupiah: Number(line.unitCostRupiah) })) } : {}) } };
    }
    if (!command) return;
    state.busy = true; state.message = "Menyimpan perubahan PO…"; draw();
    try {
      const result = await request("/api/admin/actions", { method: "POST", csrf: true, body: command });
      if (state !== session) return;
      if (state.mode === "receive") { state.receipt = result.receipt; onReceiptCommitted(); }
      if (state.mode === "invoice") state.invoice = result.invoice;
      state.committed = true; state.blocked = true; state.uncertain = null;
      state.message = "Perubahan tersimpan. Memuat data terbaru…";
      draw();
      try {
        const data = await request("/api/admin/state");
        if (state !== session) return;
        state.data = data.hpp; state.message = "Perubahan tersimpan. Data terbaru sudah dimuat.";
        await onChanged({ receipt: state.mode === "receive", isCurrent: () => state === session });
      } catch { if (state === session) state.message = "Perubahan tersimpan, tetapi data terbaru belum berhasil dimuat. Perbarui data PO; jangan simpan ulang."; }
    } catch (error) {
      if (state !== session) return;
      if (!error.status || error.status >= 500) { state.uncertain = command; state.blocked = true; state.message = "Hasil penyimpanan belum dapat dipastikan. Periksa data atau ulangi penyimpanan identik; jangan membuat perubahan baru."; }
      else {
        state.blocked = !["receive", "invoice"].includes(state.mode) || ![400, 422].includes(error.status);
        state.message = ({ purchase_lot_required: "Lot wajib diisi untuk bahan ini.", purchase_lot_expiry_invalid: "Tanggal kedaluwarsa lot tidak valid.", purchase_lot_shelf_life_insufficient: "Masa simpan lot terlalu singkat. Periksa tanggal kedaluwarsa.", hpp_version_conflict: state.mode === "receive" ? "Data penerimaan berubah. Tutup dan buka ulang untuk memeriksa sisa PO; draft lama tidak boleh dikirim." : "Data pembelian berubah. Perbarui data PO dan periksa draft sebelum menyimpan lagi.", purchase_order_edit_locked_after_receipt: "Barang sudah mulai diterima. Revisi terkunci; perbarui dan periksa rincian PO.", purchase_order_cancelled: "PO sudah dibatalkan. Perbarui data untuk melihat riwayat.", purchase_order_cancel_completed: "PO sudah diterima lengkap. Tidak dapat dibatalkan.", supplier_inactive: "Supplier nonaktif. Perbarui data lalu pilih supplier aktif.", purchase_order_action_idempotency_conflict: "Percobaan simpan ini sudah dipakai untuk data berbeda. Periksa riwayat PO." })[error.code] || "Perubahan ditolak. Periksa jumlah, alasan penolakan, lot dan masa simpan. Data tidak disimpan.";
        if (state.mode === "receive" && error.code === "purchase_lot_shelf_life_invalid") state.message = "Masa simpan lot terlalu singkat. Periksa tanggal kedaluwarsa.";
        if (state.mode === "invoice") state.message = ({ purchase_invoice_receipt_required: "Belum ada penerimaan dengan baris barang diterima. Stok hasil pemeriksaan saja belum cukup untuk invoice.", purchase_invoice_total_invalid: "Total invoice atau nilai referensi PO tidak valid; jumlah terlalu kecil dapat membulat menjadi nol.", purchase_invoice_number_conflict: "Nomor invoice supplier sudah tercatat. Draft tetap tersedia; jangan mengganti nomor untuk menghindari duplikasi.", purchase_invoice_idempotency_conflict: "Kunci penyimpanan ini sudah dipakai untuk invoice berbeda. Tutup lalu periksa riwayat.", hpp_version_conflict: "Data invoice berubah. Tutup dan buka ulang untuk review; versi draft tidak diganti." })[error.code] || "Invoice ditolak. Periksa nomor, tanggal, jumlah, harga, dan biaya. Draft tetap tersedia; data tidak disimpan.";
      }
    } finally { if (state === session) { state.busy = false; draw(); } }
  }
  async function openReceipt() {
    const session = state, id = state.selected;
    state.busy = true; state.message = "Memeriksa PO, lokasi dan tanggal server…"; draw();
    try {
      const data = await request("/api/admin/state");
      if (state !== session) return;
      const workspace = await request("/api/operator/inventory-workspace");
      if (state !== session) return;
      const po = data.hpp.purchaseOrders.find((order) => order.id === id), location = workspace.warehouse?.locations?.find((item) => item.type === "PRIMARY_USABLE_STOCK");
      if (data.hpp.version !== workspace.revision || !cancellable(po) || !location?.id?.endsWith(":USABLE")) throw new Error("Data PO atau lokasi berubah. Perbarui rincian lalu coba lagi.");
      state.data = data.hpp; state.mode = "receive"; state.openingPo = structuredClone(po); state.openingFacts = receiptFacts(po);
      state.draft = createReceiptDraft(po, data.hpp.ingredients); state.expectedVersion = data.hpp.version;
      state.businessDate = workspace.businessDate; state.destinationLocationId = location.id; state.key = `owner-receipt-${crypto.randomUUID()}`;
      state.message = "Isi barang yang datang. Jumlah baik saja yang menambah stok.";
    } catch (error) { if (state === session) state.message = error.message || "Data penerimaan belum dapat dimuat."; }
    finally { if (state === session) { state.busy = false; draw(); } }
  }
  async function openInvoice() {
    const session = state, id = state.selected;
    state.busy = true; state.message = "Memeriksa bukti invoice terbaru…"; draw();
    try {
      const data = await request("/api/admin/state");
      if (state !== session) return;
      const po = data.hpp.purchaseOrders.find((order) => order.id === id);
      if (!po || !invoiceEvidence(data.hpp, po).eligible) throw new Error("Invoice memerlukan penerimaan dengan baris barang diterima. Perbarui rincian PO.");
      state.data = data.hpp; state.mode = "invoice"; state.openingPo = structuredClone(po); state.openingHpp = structuredClone(data.hpp);
      state.openingFacts = invoiceFacts(data.hpp, po); state.expectedVersion = data.hpp.version; state.draft = createInvoiceDraft(po);
      state.key = `owner-invoice-${crypto.randomUUID()}`; state.invoice = null; state.blocked = false; state.committed = false;
      state.message = "Isi dokumen supplier. Preview bukan approval; status akhir mengikuti server.";
    } catch (error) { if (state === session) state.message = error.message || "Bukti invoice belum dapat dimuat."; }
    finally { if (state === session) { state.busy = false; draw(); } }
  }
  function click(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled || state.busy) return;
    if (button.hasAttribute("data-load")) { load(); return; }
    if (button.hasAttribute("data-close")) { close(); return; }
    if (button.hasAttribute("data-replay")) { save(true); return; }
    if (button.dataset.detail) { state.selected = button.dataset.detail; state.mode = "detail"; state.draft = null; state.receipt = null; state.invoice = null; state.committed = false; state.blocked = false; state.message = ""; draw(); return; }
    const po = selected();
    if (button.hasAttribute("data-receive") && cancellable(po)) { openReceipt(); return; }
    if (button.hasAttribute("data-invoice") && state.mode === "detail") { openInvoice(); return; }
    if (state.mode === "receive" && !state.blocked && !state.committed) {
      if (button.hasAttribute("data-add-lot")) { capture(); addReceiptLot(state.draft, Number(button.dataset.addLot)); draw(); return; }
      if (button.hasAttribute("data-remove-lot")) { capture(); const [index, lot] = button.dataset.removeLot.split(":").map(Number); if (state.draft.lines[index].lots.length > 1) state.draft.lines[index].lots.splice(lot, 1); draw(); return; }
    }
    if (button.hasAttribute("data-amend") && editable(po)) {
      state.mode = "amend"; state.draft = { supplierId: po.supplierId, expectedDate: po.expectedDate, reason: "", lines: structuredClone(po.lines) };
    } else if (button.hasAttribute("data-cancel") && cancellable(po)) { state.mode = "cancel"; state.draft = { reason: "", confirmed: false }; }
    else if (button.hasAttribute("data-add") && state.draft.lines.length < 100) { capture(); state.draft.lines.push({ ingredientId: state.data.ingredients[0]?.id || "", purchaseUnitLabel: "", orderedPurchaseQuantity: "", baseUnitsPerPurchaseUnit: "", unitCostRupiah: "" }); draw(); return; }
    else if (button.hasAttribute("data-remove") && state.draft.lines.length > 1) { capture(); state.draft.lines.splice(Number(button.dataset.remove), 1); draw(); return; }
    else return;
    state.expectedVersion = state.data.version; state.openingRevision = po.revision; state.key = `owner-po-${crypto.randomUUID()}`; draw();
  }
  return {
    mount(element) { capture(); host = element; if (!host) return; host.onclick = click; host.oninput = capture; host.onsubmit = (event) => { event.preventDefault(); save(); }; draw(); },
    reset() { state = fresh(); host?.querySelector("dialog")?.close(); host = null; },
  };
}
