// Matching only: the existing Owner action records evidence, never approval/AP/payment.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
const round = (value) => Math.round(value * 1000) / 1000;
const fees = { SHIPPING: "Ongkir invoice", HANDLING: "Penanganan invoice", OTHER: "Biaya lainnya invoice" };
const readiness = { READY_FOR_APPROVAL: "Cocok · menunggu Finance", VARIANCE_REVIEW_REQUIRED: "Selisih harga · perlu review Finance", BLOCKED: "Bukti/jumlah/biaya tidak sesuai · diblokir", APPROVED_NOT_POSTED: "Disetujui Finance · belum dibukukan", REJECTED: "Ditolak Finance", POSTED_UNPAID: "Dibukukan · belum lunas" };
export const invoiceStatus = (invoice) => invoice.payableEntry ? `${({ OPEN: "Utang terbuka", PARTIALLY_CREDITED: "Sebagian dikreditkan", CLOSED_BY_CREDIT: "Ditutup dengan kredit", PARTIALLY_PAID: "Dibayar sebagian", PARTIALLY_PAID_AND_CREDITED: "Sebagian dibayar dan dikreditkan", PAID: "Lunas", CLOSED_BY_CREDIT_AND_PAYMENT: "Ditutup dengan kredit dan pembayaran" })[invoice.payableEntry.status] || "Periksa status utang"} · sisa ${money(invoice.payableEntry.outstandingRupiah)}` : readiness[invoice.paymentReadiness] || "Periksa status invoice";
export function invoiceEvidence(hpp, po) {
  const complete = [["purchaseReceiptCount", "purchaseReceipts"], ["purchaseReceiptInspectionDecisionCount", "purchaseReceiptInspectionDecisions"], ["purchaseInvoiceCount", "purchaseInvoices"]].every(([count, list]) => Number.isInteger(hpp[count]) && hpp[count] === hpp[list]?.length);
  const receipts = (hpp.purchaseReceipts || []).filter((receipt) => receipt.purchaseOrderId === po.id);
  const acceptedReceipt = receipts.some((receipt) => receipt.lines?.length > 0);
  return { complete, receipts, acceptedReceipt, eligible: acceptedReceipt || (!complete && po.lines.some((line) => line.receivedPurchaseQuantity > 0)) };
}
export const invoiceFacts = (hpp, po) => JSON.stringify([hpp.version, po, hpp.purchaseReceipts, hpp.purchaseReceiptInspectionDecisions, hpp.purchaseInvoices, hpp.purchaseReceiptCount, hpp.purchaseReceiptInspectionDecisionCount, hpp.purchaseInvoiceCount]);
export function createInvoiceDraft(po) {
  return { invoiceNumber: "", invoiceDate: "", dueDate: "", reason: "", confirmed: false, fees: Object.fromEntries(Object.keys(fees).map((type) => [type, ""])), lines: po.lines.map((line) => ({ ingredientId: line.ingredientId, invoiceQuantity: "", unitPriceRupiah: "" })) };
}
export function captureInvoiceDraft(form, draft) {
  const previous = JSON.stringify([draft.lines, draft.fees]);
  for (const name of ["invoiceNumber", "invoiceDate", "dueDate", "reason"]) draft[name] = form.elements[name].value;
  for (const type of Object.keys(fees)) draft.fees[type] = form.elements[`invoice-fee-${type}`].value;
  for (const [index, line] of draft.lines.entries()) for (const name of ["invoiceQuantity", "unitPriceRupiah"]) line[name] = form.elements[`invoice-${index}-${name}`].value;
  draft.confirmed = form.elements.confirmed.checked && previous === JSON.stringify([draft.lines, draft.fees]);
  form.elements.confirmed.checked = draft.confirmed;
}
function amounts(po, draft) {
  const lines = [];
  for (const row of draft.lines) {
    const quantity = Number(row.invoiceQuantity), price = Number(row.unitPriceRupiah);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1000000 || Math.abs(quantity - round(quantity)) > 1e-8) throw new Error("Jumlah invoice maksimal tiga angka desimal, nol atau positif.");
    if (!quantity) continue;
    const original = po.lines.find((line) => line.ingredientId === row.ingredientId);
    if (!original || lines.some((line) => line.ingredientId === row.ingredientId)) throw new Error("Bahan invoice harus unik dan berasal dari PO ini.");
    if (!Number.isSafeInteger(price) || price <= 0 || price > 1000000000) throw new Error("Harga invoice harus rupiah bulat positif, maksimal Rp1 miliar.");
    const invoiceLineTotalRupiah = Math.round(quantity * price);
    if (!Number.isSafeInteger(invoiceLineTotalRupiah) || invoiceLineTotalRupiah <= 0) throw new Error("Nilai setiap baris invoice harus rupiah bulat positif; jumlah terlalu kecil dapat membulat menjadi nol.");
    lines.push({ ingredientId: row.ingredientId, invoiceQuantity: quantity, unitPriceRupiah: price, invoiceLineTotalRupiah });
  }
  if (!lines.length || lines.length > 100) throw new Error("Isi sedikitnya satu bahan yang tercantum pada invoice.");
  const additionalFees = Object.keys(fees).map((type) => ({ type, amountRupiah: Number(draft.fees[type] || 0) }));
  const feeTotal = additionalFees.reduce((sum, fee) => sum + fee.amountRupiah, 0);
  if (additionalFees.some((fee) => !Number.isSafeInteger(fee.amountRupiah) || fee.amountRupiah < 0) || feeTotal > 1000000000) throw new Error("Biaya invoice harus rupiah bulat; total maksimal Rp1 miliar.");
  const totalInvoiceRupiah = lines.reduce((sum, line) => sum + line.invoiceLineTotalRupiah, 0) + feeTotal;
  const expectedMatchedTotalRupiah = lines.reduce((sum, line) => sum + Math.round(line.invoiceQuantity * po.lines.find((item) => item.ingredientId === line.ingredientId).unitCostRupiah), 0) + feeTotal;
  if (![totalInvoiceRupiah, expectedMatchedTotalRupiah].every((total) => Number.isSafeInteger(total) && total > 0)) throw new Error("Total invoice dan nilai referensi PO harus rupiah bulat positif; jumlah terlalu kecil dapat membulat menjadi nol.");
  return { lines, additionalFees: additionalFees.filter((fee) => fee.amountRupiah > 0), totalInvoiceRupiah, expectedMatchedTotalRupiah };
}
export function invoicePreview(hpp, po, draft) {
  try {
    const value = amounts(po, draft), evidence = invoiceEvidence(hpp, po);
    const base = `Total invoice ${money(value.totalInvoiceRupiah)} · referensi ${money(value.expectedMatchedTotalRupiah)}.`;
    if (!evidence.complete) return { ...value, status: "UNVERIFIED", text: `${base} Riwayat yang tampil terbatas; sisa belum ditagih belum dapat dipastikan. Hasil server setelah simpan adalah rujukan.` };
    if (!evidence.acceptedReceipt) return { ...value, status: "RECEIPT_REQUIRED", text: `${base} Belum ada penerimaan dengan baris barang diterima. Stok hasil pemeriksaan saja belum cukup untuk invoice.` };
    const previous = (hpp.purchaseInvoices || []).filter((invoice) => invoice.purchaseOrderId === po.id && invoice.matchStatus === "MATCHED");
    const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);
    const quantitiesMatch = value.lines.every((line) => {
      const paid = sum(evidence.receipts.flatMap((receipt) => receipt.lines).filter((row) => row.ingredientId === line.ingredientId), "paidPurchaseQuantity");
      const inspected = sum((hpp.purchaseReceiptInspectionDecisions || []).filter((row) => row.purchaseOrderId === po.id && row.ingredientId === line.ingredientId && row.decision === "ACCEPT"), "purchaseQuantity");
      const billed = sum(previous.flatMap((invoice) => invoice.lines).filter((row) => row.ingredientId === line.ingredientId), "invoiceQuantity");
      return line.invoiceQuantity <= round(Math.max(0, paid + inspected - billed));
    });
    const feesMatch = value.additionalFees.every((fee) => fee.amountRupiah <= Math.max(0, sum(evidence.receipts.flatMap((receipt) => receipt.additionalFees).filter((row) => row.type === fee.type), "amountRupiah") - sum(previous.flatMap((invoice) => invoice.additionalFees).filter((row) => row.type === fee.type), "amountRupiah")));
    const pricesMatch = value.lines.every((line) => line.unitPriceRupiah === po.lines.find((row) => row.ingredientId === line.ingredientId).unitCostRupiah);
    const status = quantitiesMatch && feesMatch && pricesMatch ? "MATCHED" : quantitiesMatch && feesMatch && Math.abs(value.totalInvoiceRupiah - value.expectedMatchedTotalRupiah) * 10 <= value.expectedMatchedTotalRupiah ? "REVIEW" : "BLOCKED";
    return { ...value, status, text: `${base} Perkiraan: ${status === "MATCHED" ? "cocok · menunggu Finance" : status === "REVIEW" ? "selisih harga · perlu review Finance" : "bukti/jumlah/biaya tidak sesuai · diblokir"}. Status akhir mengikuti server; stok dan pembayaran tidak berubah.` };
  } catch (error) { return { status: "INVALID", text: error.message }; }
}
export function buildInvoiceCommand({ hpp, po, draft, expectedVersion, idempotencyKey }) {
  const value = amounts(po, draft), number = draft.invoiceNumber.trim(), reason = draft.reason.trim();
  if (!number || number.length > 80 || /[\u0000-\u001f<>]/.test(number)) throw new Error("Isi nomor invoice asli, maksimal 80 karakter tanpa karakter kontrol atau tanda sudut.");
  const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!validDate(draft.invoiceDate) || !validDate(draft.dueDate) || draft.dueDate < draft.invoiceDate) throw new Error("Tanggal invoice dan jatuh tempo harus valid; jatuh tempo tidak boleh lebih awal.");
  if (!reason || reason.length > 160) throw new Error("Isi catatan review invoice, maksimal 160 karakter.");
  const preview = invoicePreview(hpp, po, draft);
  if (preview.status === "RECEIPT_REQUIRED") throw new Error(preview.text);
  if (preview.status !== "MATCHED" && !draft.confirmed) throw new Error("Konfirmasi bahwa selisih atau bukti terbatas telah diperiksa sebelum mencatat invoice.");
  return { action: "hpp.purchase_invoice.match", payload: { purchaseOrderId: po.id, idempotencyKey, invoiceNumber: number, invoiceDate: draft.invoiceDate, dueDate: draft.dueDate, lines: value.lines, additionalFees: value.additionalFees, totalInvoiceRupiah: value.totalInvoiceRupiah, expectedVersion, reason } };
}
export function renderInvoiceFields(po, ingredients, draft, disabled) {
  const input = (name, label, value, type = "text", rules = "") => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${rules} ${disabled}></label>`;
  return `<p>Salin invoice supplier apa adanya. Kosongkan jumlah bahan yang tidak ditagih. Pencatatan ini tidak menambah stok, menyetujui invoice, membuat utang, atau membayar.</p><div class="owner-po-fields">${input("invoiceNumber", "Nomor invoice", draft.invoiceNumber, "text", 'maxlength="80" required')}${input("invoiceDate", "Tanggal invoice", draft.invoiceDate, "date", "required")}${input("dueDate", "Jatuh tempo", draft.dueDate, "date", "required")}</div>${draft.lines.map((line, index) => { const original = po.lines.find((row) => row.ingredientId === line.ingredientId); return `<fieldset class="owner-po-line"><legend>${esc(ingredients.find((row) => row.id === line.ingredientId)?.name || "Bahan")} · ${esc(original.purchaseUnitLabel)}</legend><p>Referensi PO terkunci: ${money(original.unitCostRupiah)} per ${esc(original.purchaseUnitLabel)} · isi ${original.baseUnitsPerPurchaseUnit} ${esc(ingredients.find((row) => row.id === line.ingredientId)?.baseUnit)}.</p><div class="owner-po-fields">${input(`invoice-${index}-invoiceQuantity`, "Jumlah ditagih (kemasan)", line.invoiceQuantity, "number", 'min="0" max="1000000" step="0.001"')}${input(`invoice-${index}-unitPriceRupiah`, "Harga invoice per kemasan (Rp)", line.unitPriceRupiah, "number", 'min="1" max="1000000000" step="1"')}</div></fieldset>`; }).join("")}<fieldset class="owner-po-line"><legend>Biaya invoice (Rp)</legend><div class="owner-po-fields">${Object.entries(fees).map(([type, label]) => input(`invoice-fee-${type}`, label, draft.fees[type], "number", 'min="0" max="1000000000" step="1"')).join("")}</div></fieldset>${input("reason", "Catatan review invoice", draft.reason, "text", 'maxlength="160" required')}<p class="owner-card-note" data-invoice-preview aria-live="polite"></p><label><input name="confirmed" type="checkbox" ${draft.confirmed ? "checked" : ""} ${disabled}> Saya telah memeriksa selisih atau riwayat yang terbatas. Hasil ini belum berarti invoice disetujui atau dibayar.</label><button class="button button-primary" type="submit" data-save-invoice ${disabled}>Catat invoice</button>`;
}
export function renderInvoiceHistory(hpp, po) {
  const rows = (hpp.purchaseInvoices || []).filter((invoice) => invoice.purchaseOrderId === po.id);
  return `<section aria-label="Invoice PO"><h3>Invoice PO</h3>${rows.length ? `<ul>${rows.map((invoice) => `<li><strong>${esc(invoice.invoiceNumber)}</strong> · ${money(invoice.totalInvoiceRupiah)} · ${esc(invoiceStatus(invoice))}</li>`).join("")}</ul>` : "<p>Belum ada invoice pada riwayat yang tampil.</p>"}<p>Menampilkan hingga 20 invoice terbaru. Approval Finance dan pembukuan/pembayaran tetap terpisah.</p></section>`;
}
