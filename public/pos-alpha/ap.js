const loginView = document.querySelector("#ap-login");
const appView = document.querySelector("#ap-app");
const loginForm = document.querySelector("#login-form");
const content = document.querySelector("#ap-content");
const toast = document.querySelector("#global-status");
let state; let csrfToken = ""; let toastTimer;

loginForm.addEventListener("submit", login);
document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#refresh-button").addEventListener("click", refresh);
content.addEventListener("submit", handleSubmit);
try { await refresh(); showApp(); } catch { showLogin(); }

async function login(event) {
  event.preventDefault();
  document.querySelector("#login-status").textContent = "";
  try {
    const result = await request("/api/operator/login", { method: "POST", body: Object.fromEntries(new FormData(loginForm).entries()) });
    if (result.actor.role !== "finance") throw new Error("Role Finance diperlukan.");
    await refresh(); showApp();
  } catch (error) { document.querySelector("#login-status").textContent = error.message; }
}

async function logout() { await request("/api/operator/logout", { method: "POST", csrf: true }); state = null; csrfToken = ""; showLogin(); }
async function refresh() { state = await request("/api/ap/state"); csrfToken = state.csrfToken; render(); }
function showApp() { loginView.hidden = true; appView.hidden = false; document.querySelector("#actor-badge").textContent = `${state.actor.displayName} · FINANCE`; }
function showLogin() { appView.hidden = true; loginView.hidden = false; }

function render() {
  const ready = state.invoices.filter((invoice) => invoice.paymentReadiness === "READY_FOR_APPROVAL");
  const posted = state.invoices.filter((invoice) => invoice.paymentReadiness === "POSTED_UNPAID" && invoice.payableEntry?.outstandingRupiah > 0);
  const payments = state.payments ?? [];
  const aging = state.accountsPayableAging ?? {};
  const returnCreditCards = state.supplierReturns.filter((item) => item.disposition === "CREDIT_EXPECTED" && item.status === "SHIPPED_AWAITING_CREDIT").map((item) => {
    const candidates = posted.filter((invoice) => invoice.purchaseOrderId === item.purchaseOrderId && invoice.supplierId === item.supplierId);
    const invoice = candidates.length === 1 ? candidates[0] : null;
    if (!invoice) return `<article class="ap-review-card"><div class="ap-review-heading"><div><p class="eyebrow">Perlu resolusi invoice</p><h2>${escapeHtml(item.returnReference)}</h2><p>${escapeHtml(item.supplierNameSnapshot)}</p></div><strong>${rupiah(item.totalReturnValueRupiah)}</strong></div><p class="ap-boundary">Credit belum dapat ditautkan karena invoice posted untuk purchase order ini tidak tunggal. Verifikasi dokumen asal bersama Owner; jangan pilih invoice secara perkiraan.</p></article>`;
    if (item.totalReturnValueRupiah > invoice.payableEntry.outstandingRupiah) return `<article class="ap-review-card"><div class="ap-review-heading"><div><p class="eyebrow">Outstanding tidak cukup</p><h2>${escapeHtml(item.returnReference)}</h2><p>${escapeHtml(item.supplierNameSnapshot)} · invoice ${escapeHtml(invoice.invoiceNumber)}</p></div><strong>${rupiah(item.totalReturnValueRupiah)}</strong></div><p class="ap-boundary">Nilai retur melebihi outstanding invoice. Koreksi credit sebelumnya atau minta Owner melakukan resolusi; tidak ada perubahan otomatis.</p></article>`;
    return `<article class="ap-review-card"><div class="ap-review-heading"><div><p class="eyebrow">Retur sudah dikirim</p><h2>${escapeHtml(item.returnReference)}</h2><p>${escapeHtml(item.supplierNameSnapshot)} · invoice ${escapeHtml(invoice.invoiceNumber)}</p></div><strong>${rupiah(item.totalReturnValueRupiah)}</strong></div><p class="ap-boundary">Catat credit note supplier untuk retur ini. Nominal dikunci sesuai nilai barang yang keluar; utang baru berubah setelah Owner memposting.</p><form class="ap-credit-form"><input type="hidden" name="idempotencyKey" value="return-credit-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseInvoiceId" value="${escapeHtml(invoice.id)}"><input type="hidden" name="supplierReturnId" value="${escapeHtml(item.id)}"><input type="hidden" name="creditType" value="GOODS_RETURN"><label>Nomor credit note<input name="creditNoteNumber" maxlength="80" placeholder="Contoh: CN-RETUR-001" required></label><div class="hpp-form-row"><label>Tanggal credit<input name="creditDate" type="date" min="${escapeHtml(invoice.invoiceDate)}" value="${escapeHtml(state.generatedAt.slice(0, 10))}" required></label><label>Nilai retur (Rp)<input name="amountRupiah" type="number" value="${item.totalReturnValueRupiah}" readonly required></label></div><label>Catatan Finance<input name="reason" maxlength="160" placeholder="Credit note supplier telah dicocokkan dengan retur" required></label><p role="status"></p><button class="button button-primary" type="submit">Tautkan credit retur</button></form></article>`;
  }).join("");
  const cards = ready.map((invoice) => `<article class="ap-review-card"><div class="ap-review-heading"><div><p class="eyebrow">Menunggu keputusan</p><h2>${escapeHtml(invoice.invoiceNumber)}</h2><p>${escapeHtml(invoice.supplierNameSnapshot)} · jatuh tempo ${escapeHtml(invoice.dueDate)}</p></div><strong>${rupiah(invoice.totalInvoiceRupiah)}</strong></div><dl class="ap-match-grid"><div><dt>PO</dt><dd>${escapeHtml(invoice.purchaseOrderId.slice(0, 8))}</dd></div><div><dt>Quantity</dt><dd>${invoice.lines.every((line) => line.quantityMatch) ? "Cocok" : "Selisih"}</dd></div><div><dt>Harga</dt><dd>${invoice.lines.every((line) => line.priceMatch) ? "Cocok" : "Selisih"}</dd></div><div><dt>Biaya</dt><dd>${invoice.additionalFees.every((fee) => fee.feeMatch) ? "Cocok" : "Selisih"}</dd></div></dl><p class="ap-boundary">Keputusan ini tidak membuat pembayaran. Setelah disetujui, Owner lain harus memposting utang AP.</p><form class="ap-decision-form"><input type="hidden" name="idempotencyKey" value="invoice-decision-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseInvoiceId" value="${escapeHtml(invoice.id)}"><label>Catatan reviewer<input name="reason" maxlength="160" placeholder="Contoh: bukti PO dan receipt sudah ditinjau" required></label><p role="status"></p><div class="ap-decision-actions"><button class="button button-danger" name="decision" value="REJECT" type="submit">Tolak</button><button class="button button-primary" name="decision" value="APPROVE" type="submit">Setujui invoice</button></div></form></article>`).join("");
  const creditCards = posted.map((invoice) => {
    const reserved = state.credits.filter((credit) => credit.purchaseInvoiceId === invoice.id && credit.status === "PENDING_OWNER_POST").reduce((sum, credit) => sum + credit.amountRupiah, 0);
    const available = invoice.payableEntry.outstandingRupiah - reserved;
    return `<article class="ap-review-card"><div class="ap-review-heading"><div><p class="eyebrow">Koreksi harga supplier</p><h2>${escapeHtml(invoice.invoiceNumber)}</h2><p>${escapeHtml(invoice.supplierNameSnapshot)} · outstanding ${rupiah(invoice.payableEntry.outstandingRupiah)}</p></div><strong>${rupiah(available)}</strong></div><p class="ap-boundary">Credit memo hanya mengurangi utang AP. Stok, HPP pembelian, dan pembayaran tidak berubah.</p>${available > 0 ? `<form class="ap-credit-form"><input type="hidden" name="idempotencyKey" value="invoice-credit-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="purchaseInvoiceId" value="${escapeHtml(invoice.id)}"><label>Nomor credit note<input name="creditNoteNumber" maxlength="80" placeholder="Contoh: CN-DUMMY-001" required></label><div class="hpp-form-row"><label>Tanggal credit<input name="creditDate" type="date" min="${escapeHtml(invoice.invoiceDate)}" value="${escapeHtml(state.generatedAt.slice(0, 10))}" required></label><label>Nominal credit (Rp)<input name="amountRupiah" type="number" min="1" max="${available}" step="1" required></label></div><label>Jenis koreksi<select name="creditType"><option value="PRICE_CORRECTION">Koreksi harga</option><option value="SERVICE_CREDIT">Kompensasi layanan</option><option value="OTHER_NON_STOCK">Lainnya · non-stok</option></select></label><label>Catatan Finance<input name="reason" maxlength="160" placeholder="Contoh: credit note supplier sudah diverifikasi" required></label><p role="status"></p><button class="button button-primary" type="submit">Ajukan credit memo</button></form>` : `<p><strong>Seluruh outstanding sudah dicadangkan</strong><br><small>Menunggu Owner memposting credit memo yang ada.</small></p>`}</article>`;
  }).join("");
  const history = state.invoices.map((invoice) => {
    const entry = invoice.payableEntry;
    const status = entry ? payableStatusLabel(entry.status) : statusLabel(invoice.paymentReadiness);
    const detail = entry ? `Outstanding ${rupiah(entry.outstandingRupiah)} · paid ${rupiah(entry.paidRupiah ?? 0)} · credit ${rupiah(entry.creditedRupiah ?? 0)}` : "Belum diposting sebagai AP";
    return `<tr><th scope="row">${escapeHtml(invoice.invoiceNumber)}<small>${escapeHtml(invoice.supplierNameSnapshot)}</small></th><td>${rupiah(invoice.totalInvoiceRupiah)}</td><td><span class="hpp-status ${entry?.outstandingRupiah === 0 ? "is-matched" : ""}">${escapeHtml(status)}</span><small>${detail}</small></td></tr>`;
  }).join("");
  const paymentHistory = payments.map((payment) => {
    const invoice = state.invoices.find((item) => item.id === payment.purchaseInvoiceId);
    return `<tr><th scope="row">${escapeHtml(payment.reference)}<small>${escapeHtml(payment.supplierNameSnapshot)}</small></th><td>${escapeHtml(payment.paidDate)}<small>${escapeHtml(paymentMethodLabel(payment.method))}</small></td><td>${rupiah(payment.amountRupiah)}<small>Invoice ${escapeHtml(invoice?.invoiceNumber ?? "tidak ditemukan")}</small></td><td><span class="hpp-status is-matched">TERCATAT</span><small>${escapeHtml(payment.reason)}</small></td></tr>`;
  }).join("");
  const creditHistory = state.credits.map((credit) => {
    const latestReversal = credit.reversalHistory.at(-1);
    const pendingReversal = latestReversal?.status === "PENDING_OWNER_DECISION";
    const status = credit.status === "REVERSED" ? "DIBALIKKAN" : credit.status === "POSTED" ? "POSTED" : "MENUNGGU OWNER";
    const reversalAction = credit.status === "POSTED" && !pendingReversal
      ? `<form class="ap-credit-reversal-form"><input type="hidden" name="idempotencyKey" value="credit-reversal-request-${escapeHtml(crypto.randomUUID())}"><input type="hidden" name="creditMemoId" value="${escapeHtml(credit.id)}"><label><span class="sr-only">Alasan reversal ${escapeHtml(credit.creditNoteNumber)}</span><input name="reason" maxlength="160" placeholder="Alasan koreksi credit memo" required></label><p role="status"></p><button class="button button-secondary" type="submit">Minta reversal</button></form>`
      : pendingReversal ? `<small>Menunggu keputusan Owner · outstanding belum berubah</small>`
        : credit.status === "REVERSED" ? `<small>Outstanding dipulihkan · histori tetap tersimpan</small>` : "";
    return `<tr><th scope="row">${escapeHtml(credit.creditNoteNumber)}<small>${escapeHtml(credit.supplierNameSnapshot)}</small></th><td>${escapeHtml(credit.creditDate)}${credit.returnReferenceSnapshot ? `<small>Retur ${escapeHtml(credit.returnReferenceSnapshot)}</small>` : ""}</td><td>${rupiah(credit.amountRupiah)}</td><td><span class="hpp-status">${status}</span><small>${escapeHtml(creditTypeLabel(credit.creditType))}${latestReversal ? ` · reversal ${escapeHtml(latestReversal.status)}` : ""}</small>${reversalAction}</td></tr>`;
  }).join("");
  content.innerHTML = `<section class="admin-command ap-command"><div><p class="eyebrow">Pemisahan tugas</p><h2>${ready.length ? `${ready.length} invoice perlu ditinjau` : "Tidak ada invoice menunggu review"}</h2><p>Pembuat invoice tidak dapat menjadi reviewer. Posting utang, pencatatan pembayaran supplier, dan keputusan reversal credit memo dilakukan Owner setelah input Finance.</p></div><div class="admin-freshness"><span>DATA SERVER · ${escapeHtml(state.context.timezone)}</span><strong>v${state.version}</strong><small>Finance read-only untuk payment</small></div></section><section class="admin-metrics">${metric("Menunggu review", state.readyCount, "Cocok PO + receipt", "tone-warning")}${metric("Outstanding", rupiah(state.openPayableRupiah), "Belum dibayar", "tone-clear")}${metric("Supplier paid", rupiah(state.paidPayableRupiah ?? 0), `${state.paidCount ?? 0} invoice lunas/tercatat`, "tone-clear")}${metric("Jatuh tempo ≤7 hari", rupiah((aging.dueToday?.rupiah ?? 0) + (aging.dueNext7Days?.rupiah ?? 0)), `${(aging.dueToday?.count ?? 0) + (aging.dueNext7Days?.count ?? 0)} invoice`, "tone-warning")}${metric("Lewat tempo", rupiah(aging.overdue?.rupiah ?? 0), `${aging.overdue?.count ?? 0} invoice`, (aging.overdue?.count ?? 0) ? "tone-warning" : "tone-clear")}${metric("Reversal menunggu", state.creditReversalPendingCount, "Perlu keputusan Owner", "tone-warning")}</section><section class="ap-review-grid">${cards || '<div class="operator-empty compact"><strong>Antrean review bersih</strong><p>Invoice cocok baru akan muncul setelah dibuat oleh Owner.</p></div>'}</section><section class="admin-ops-card"><div class="section-heading"><div><p class="eyebrow">Retur → credit</p><h2>Tautkan barang keluar dengan dokumen supplier</h2><p>Satu retur, satu credit note aktif, satu jejak audit. Credit yang dibalik tetap ada dan retur dapat ditautkan ke dokumen koreksi.</p></div></div><div class="ap-review-grid">${returnCreditCards || '<div class="operator-empty compact"><strong>Tidak ada retur menunggu credit</strong><p>Retur fisik baru muncul setelah Owner mencatat barang dikirim kembali.</p></div>'}</div></section><section class="admin-ops-card"><div class="section-heading"><div><p class="eyebrow">Credit memo non-stok</p><h2>Koreksi kewajiban supplier</h2><p>Gunakan hanya untuk koreksi harga atau kompensasi yang tidak terkait perpindahan barang.</p></div></div><div class="ap-review-grid">${creditCards || '<div class="operator-empty compact"><strong>Belum ada utang yang dapat dikoreksi</strong><p>Credit memo tersedia setelah invoice diposting sebagai utang AP.</p></div>'}</div></section><section class="admin-ops-card"><div class="section-heading"><div><p class="eyebrow">Payment visibility</p><h2>Settlement supplier tercatat Owner</h2><p>Finance dapat melihat status pembayaran dan referensi internal untuk rekonsiliasi dokumen, tanpa tombol transfer atau payment provider action.</p></div></div>${paymentHistory ? `<div class="hpp-receipt-table" role="region" aria-label="Riwayat pembayaran supplier" tabindex="0"><table><caption>Pembayaran supplier tercatat</caption><thead><tr><th scope="col">Referensi</th><th scope="col">Tanggal & metode</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${paymentHistory}</tbody></table></div>` : '<div class="operator-empty compact"><strong>Belum ada pembayaran supplier tercatat</strong><p>Payment ledger akan muncul setelah Owner mencatat settlement manual dari Admin.</p></div>'}</section><section class="admin-ops-card"><div class="section-heading"><div><p class="eyebrow">Audit ringkas</p><h2>Status invoice dan koreksi terbaru</h2></div></div><div class="hpp-receipt-table" role="region" aria-label="Riwayat approval invoice" tabindex="0"><table><thead><tr><th scope="col">Invoice</th><th scope="col">Nilai</th><th scope="col">Status</th></tr></thead><tbody>${history}</tbody></table></div>${creditHistory ? `<div class="hpp-receipt-table" role="region" aria-label="Riwayat credit memo" tabindex="0"><table><caption>Credit memo terbaru</caption><thead><tr><th scope="col">Credit note</th><th scope="col">Tanggal</th><th scope="col">Nilai</th><th scope="col">Status & tindakan</th></tr></thead><tbody>${creditHistory}</tbody></table></div>` : ""}</section>`;
}

function handleSubmit(event) {
  if (event.target.classList.contains("ap-credit-reversal-form")) return requestCreditReversal(event);
  if (event.target.classList.contains("ap-credit-form")) return recordCredit(event);
  return decide(event);
}

async function decide(event) {
  if (!event.target.classList.contains("ap-decision-form")) return;
  event.preventDefault();
  const form = event.target;
  const submitter = event.submitter;
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((button) => { button.disabled = true; });
  const values = Object.fromEntries(new FormData(form));
  try {
    const result = await request("/api/ap/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.approval.decide", payload: { idempotencyKey: values.idempotencyKey, purchaseInvoiceId: values.purchaseInvoiceId, decision: submitter.value, expectedVersion: state.version, reason: values.reason } } });
    await refresh(); announce(result.invoice.paymentReadiness === "APPROVED_NOT_POSTED" ? "Invoice disetujui. Menunggu Owner memposting utang AP." : "Invoice ditolak dan tetap diblokir.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; buttons.forEach((button) => { button.disabled = false; }); }
}

async function recordCredit(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/ap/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.credit.record", payload: { idempotencyKey: values.idempotencyKey, purchaseInvoiceId: values.purchaseInvoiceId, supplierReturnId: values.supplierReturnId || undefined, creditNoteNumber: values.creditNoteNumber, creditDate: values.creditDate, amountRupiah: Number(values.amountRupiah), creditType: values.creditType, expectedVersion: state.version, reason: values.reason } } });
    await refresh(); announce("Credit memo diajukan. Menunggu Owner memposting koreksi utang; belum ada pembayaran.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; button.disabled = false; }
}

async function requestCreditReversal(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type='submit']");
  if (button.disabled) return;
  button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    await request("/api/ap/actions", { method: "POST", csrf: true, body: { action: "hpp.purchase_invoice.credit_reversal.request", payload: { idempotencyKey: values.idempotencyKey, creditMemoId: values.creditMemoId, expectedVersion: state.version, reason: values.reason } } });
    await refresh(); announce("Permintaan reversal dikirim. Outstanding, stok, dan pembayaran belum berubah.");
  } catch (error) { form.querySelector("[role='status']").textContent = error.message; button.disabled = false; }
}

async function request(url, { method = "GET", body, csrf = false } = {}) { const response = await fetch(url, { method, credentials: "same-origin", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error?.message || "Permintaan gagal."); error.code = data.error?.code; throw error; } return data; }
function metric(label, value, note, tone = "") { return `<article class="metric-card ${tone}"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></article>`; }
function statusLabel(status) { return ({ READY_FOR_APPROVAL: "MENUNGGU APPROVAL", APPROVED_NOT_POSTED: "DISETUJUI", REJECTED: "DITOLAK", BLOCKED: "EXCEPTION", POSTED_UNPAID: "POSTED · BELUM DIBAYAR" })[status] ?? status; }
function creditTypeLabel(type) { return ({ PRICE_CORRECTION: "Koreksi harga", SERVICE_CREDIT: "Kompensasi layanan", OTHER_NON_STOCK: "Lainnya · non-stok", GOODS_RETURN: "Credit retur barang" })[type] ?? type; }
function payableStatusLabel(status) { return ({ OPEN: "OPEN", PARTIALLY_CREDITED: "PARTIAL CREDIT", CLOSED_BY_CREDIT: "CLOSED BY CREDIT", PARTIALLY_PAID: "PARTIAL PAID", PARTIALLY_PAID_AND_CREDITED: "PARTIAL PAID + CREDIT", PAID: "PAID", CLOSED_BY_CREDIT_AND_PAYMENT: "PAID + CREDIT" })[status] ?? status; }
function paymentMethodLabel(method) { return ({ BANK_TRANSFER: "Transfer bank", CASH: "Tunai", E_WALLET: "E-wallet", OTHER: "Lainnya" })[method] ?? method; }
function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function announce(message) { clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3000); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
