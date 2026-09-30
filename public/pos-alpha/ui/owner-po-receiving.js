// Pure UI contract for the existing strict PO receipt action. Server remains authoritative.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
const round = (value) => Math.round(value * 1000) / 1000;
const feeLabels = { SHIPPING: "Ongkir", HANDLING: "Penanganan", OTHER: "Biaya lainnya" };
const rejectionLabels = { DAMAGED: "Rusak", MISSING: "Isi kemasan kurang", WRONG_ITEM: "Barang salah", EXPIRED: "Kedaluwarsa" };
const blankLot = () => ({ lotCode: "", expiryDate: "", acceptedPurchaseQuantity: "", rejectedPurchaseQuantity: "" });
export const receiptFacts = (po) => JSON.stringify([po?.id, po?.status, po?.revision, po?.lines]);
export function createReceiptDraft(po, ingredients) {
  return { reason: "", fees: Object.fromEntries(Object.keys(feeLabels).map((type) => [type, ""])), lines: po.lines.map((line) => ({ ingredientId: line.ingredientId, acceptedPurchaseQuantity: "", rejectedPurchaseQuantity: "", rejectionReason: "", lots: ingredients.find((item) => item.id === line.ingredientId)?.lotTrackingPolicy === "REQUIRED" ? [blankLot()] : [] })) };
}
export function captureReceiptDraft(form, draft) {
  draft.reason = form.elements.reason.value;
  for (const type of Object.keys(feeLabels)) draft.fees[type] = form.elements[`fee-${type}`].value;
  for (const [index, line] of draft.lines.entries()) {
    for (const name of ["acceptedPurchaseQuantity", "rejectedPurchaseQuantity", "rejectionReason"]) line[name] = form.elements[`receipt-${index}-${name}`].value;
    for (const [lotIndex, lot] of line.lots.entries()) for (const name of Object.keys(lot)) lot[name] = form.elements[`lot-${index}-${lotIndex}-${name}`].value;
  }
}
export function addReceiptLot(draft, index) { if (draft.lines[index]?.lots.length < 50) draft.lines[index].lots.push(blankLot()); }
export function renderReceiptFields(po, ingredients, draft, disabled) {
  const input = (name, label, value, type = "number") => `<label>${label}<input name="${esc(name)}" value="${esc(value)}" type="${type}" ${type === "number" ? 'min="0" max="1000000" step="0.001"' : type === "text" ? 'maxlength="80"' : ""} ${disabled}></label>`;
  const lines = draft.lines.map((line, index) => {
    const ordered = po.lines.find((item) => item.ingredientId === line.ingredientId);
    const ingredient = ingredients.find((item) => item.id === line.ingredientId);
    return `<fieldset class="owner-po-line"><legend>${esc(ingredient?.name || "Bahan")} · ${esc(ordered.purchaseUnitLabel)}</legend><p>Harga terkunci ${money(ordered.unitCostRupiah)} / kemasan · isi ${ordered.baseUnitsPerPurchaseUnit} ${esc(ingredient?.baseUnit)} · sisa ${round(ordered.orderedPurchaseQuantity - (ordered.deliveredPurchaseQuantity || 0))} kemasan.</p><div class="owner-po-fields">${input(`receipt-${index}-acceptedPurchaseQuantity`, "Diterima baik (kemasan)", line.acceptedPurchaseQuantity)}${input(`receipt-${index}-rejectedPurchaseQuantity`, "Ditolak (kemasan)", line.rejectedPurchaseQuantity)}<label>Alasan barang ditolak<select name="receipt-${index}-rejectionReason" ${disabled}><option value="">Pilih jika ada penolakan</option>${Object.entries(rejectionLabels).map(([value, label]) => `<option value="${value}" ${line.rejectionReason === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>${line.lots.length ? `<p>Lot wajib untuk seluruh barang yang datang, termasuk yang ditolak. Total lot harus sesuai jumlah baik dan ditolak. Tanggal kedaluwarsa tetap wajib memenuhi masa simpan minimum.</p>${line.lots.map((lot, lotIndex) => `<div class="owner-po-line" data-receipt-lot><h3>Lot ${lotIndex + 1}</h3><div class="owner-po-fields">${input(`lot-${index}-${lotIndex}-lotCode`, "Kode lot", lot.lotCode, "text")}${input(`lot-${index}-${lotIndex}-expiryDate`, "Kedaluwarsa", lot.expiryDate, "date")}${input(`lot-${index}-${lotIndex}-acceptedPurchaseQuantity`, "Baik dalam lot (kemasan)", lot.acceptedPurchaseQuantity)}${input(`lot-${index}-${lotIndex}-rejectedPurchaseQuantity`, "Ditolak dalam lot (kemasan)", lot.rejectedPurchaseQuantity)}</div>${line.lots.length > 1 ? `<button class="button button-ghost" type="button" data-remove-lot="${index}:${lotIndex}" ${disabled}>Hapus lot ${lotIndex + 1}</button>` : ""}</div>`).join("")}<button class="button button-ghost" type="button" data-add-lot="${index}" ${disabled || (line.lots.length >= 50 ? "disabled" : "")}>Tambah lot untuk ${esc(ingredient?.name || "bahan")}</button>` : ""}</fieldset>`;
  }).join("");
  return `<p>Isi hanya barang yang benar-benar datang. Kosong berarti tidak diterima; barang yang belum datang tetap menjadi sisa pesanan. Karantina, pemeriksaan khusus, atau kelebihan kiriman memerlukan alur penerimaan lanjutan.</p>${lines}<fieldset class="owner-po-line"><legend>Biaya tambahan (Rp)</legend><p>Hanya untuk stok yang diterima baik. Dibagi menurut nilai barang, bukan jumlah kemasan. Tidak mencatat invoice atau pembayaran.</p><div class="owner-po-fields">${Object.entries(feeLabels).map(([type, label]) => `<label>${label}<input name="fee-${type}" type="number" min="0" max="1000000000" step="1" value="${esc(draft.fees[type])}" ${disabled}></label>`).join("")}</div></fieldset><label>Catatan penerimaan<input name="reason" maxlength="160" required value="${esc(draft.reason)}" ${disabled}></label><p class="owner-card-note" data-receipt-preview aria-live="polite"></p><button class="button button-primary" type="submit" ${disabled}>Simpan penerimaan</button>`;
}
function quantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000 || Math.abs(number - round(number)) > 1e-8) throw new Error("Jumlah kemasan harus nol atau positif, maksimal tiga angka desimal.");
  return number;
}
export function buildReceiptCommand({ po, ingredients, draft, expectedVersion, idempotencyKey, businessDate, destinationLocationId }) {
  if (!["OPEN", "PARTIALLY_RECEIVED"].includes(po.status)) throw new Error("PO sudah ditutup. Buka rincian terbaru.");
  if (!draft.reason.trim() || draft.reason.trim().length > 160) throw new Error("Isi catatan penerimaan, maksimal 160 karakter.");
  if (!destinationLocationId?.endsWith(":USABLE") || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error("Lokasi atau tanggal server belum siap. Tutup dan buka ulang penerimaan.");
  const lines = [];
  for (const draftLine of draft.lines) {
    const ordered = po.lines.find((line) => line.ingredientId === draftLine.ingredientId);
    if (!ordered || lines.some((line) => line.ingredientId === draftLine.ingredientId)) throw new Error("Bahan penerimaan tidak cocok dengan PO.");
    const accepted = quantity(draftLine.acceptedPurchaseQuantity), rejected = quantity(draftLine.rejectedPurchaseQuantity), delivered = round(accepted + rejected);
    if (!delivered) continue;
    if (delivered > round(ordered.orderedPurchaseQuantity - (ordered.deliveredPurchaseQuantity || 0))) throw new Error("Jumlah yang datang melebihi sisa PO. Periksa kembali kemasan.");
    if (rejected && !Object.hasOwn(rejectionLabels, draftLine.rejectionReason)) throw new Error("Pilih alasan untuk setiap barang yang ditolak.");
    const line = { ingredientId: ordered.ingredientId, deliveredPurchaseQuantity: delivered, acceptedPurchaseQuantity: accepted, rejectedPurchaseQuantity: rejected, ...(rejected ? { rejectionReason: draftLine.rejectionReason } : {}) };
    if (ingredients.find((item) => item.id === ordered.ingredientId)?.lotTrackingPolicy === "REQUIRED") {
      if (!draftLine.lots.length) throw new Error("Isi lot untuk bahan yang wajib dilacak.");
      line.lots = draftLine.lots.map((lot) => {
        const good = quantity(lot.acceptedPurchaseQuantity), bad = quantity(lot.rejectedPurchaseQuantity);
        if (!lot.lotCode.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(lot.expiryDate) || !round(good + bad)) throw new Error("Lengkapi kode, kedaluwarsa, dan jumlah setiap lot yang datang.");
        return { lotCode: lot.lotCode.trim(), expiryDate: lot.expiryDate, acceptedPurchaseQuantity: good, rejectedPurchaseQuantity: bad, deliveredPurchaseQuantity: round(good + bad) };
      });
      if (new Set(line.lots.map((lot) => lot.lotCode)).size !== line.lots.length || round(line.lots.reduce((sum, lot) => sum + lot.acceptedPurchaseQuantity, 0)) !== accepted || round(line.lots.reduce((sum, lot) => sum + lot.rejectedPurchaseQuantity, 0)) !== rejected) throw new Error("Kode lot harus berbeda dan total baik/ditolak dalam lot harus sama dengan jumlah bahan.");
    }
    lines.push(line);
  }
  if (!lines.length) throw new Error("Isi setidaknya satu barang yang datang, baik atau ditolak.");
  const additionalFees = Object.keys(feeLabels).map((type) => ({ type, amountRupiah: Number(draft.fees[type] || 0) }));
  if (additionalFees.some((fee) => !Number.isSafeInteger(fee.amountRupiah) || fee.amountRupiah < 0) || additionalFees.reduce((sum, fee) => sum + fee.amountRupiah, 0) > 1000000000) throw new Error("Biaya harus rupiah bulat, nol atau positif; total maksimal Rp1 miliar.");
  if (!lines.some((line) => line.acceptedPurchaseQuantity > 0) && additionalFees.some((fee) => fee.amountRupiah)) throw new Error("Semua barang ditolak: biaya tambahan harus nol karena tidak ada stok diterima baik.");
  return { action: "hpp.purchase_receipt.post", payload: { purchaseOrderId: po.id, expectedVersion, idempotencyKey, businessDate, destinationLocationId, reason: draft.reason.trim(), lines, additionalFees: additionalFees.filter((fee) => fee.amountRupiah > 0), ...(lines.some((line) => line.rejectedPurchaseQuantity > 0) ? { rejectionLocationId: destinationLocationId.replace(/:USABLE$/, ":REJECTED") } : {}) } };
}
export function receiptPreview(po, ingredients, draft) {
  try {
    const rows = draft.lines.map((line) => {
      const ordered = po.lines.find((item) => item.ingredientId === line.ingredientId);
      const accepted = quantity(line.acceptedPurchaseQuantity), rejected = quantity(line.rejectedPurchaseQuantity);
      return { id: line.ingredientId, accepted, rejected, cost: Math.round(accepted * ordered.unitCostRupiah), base: round(accepted * ordered.baseUnitsPerPurchaseUnit), remaining: round(ordered.orderedPurchaseQuantity - (ordered.deliveredPurchaseQuantity || 0) - accepted - rejected) };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const fee = Object.values(draft.fees).reduce((sum, value) => sum + Number(value || 0), 0), total = rows.reduce((sum, row) => sum + row.cost, 0);
    if (!Number.isSafeInteger(fee) || fee < 0 || rows.some((row) => row.remaining < 0) || (fee && !total)) return "Periksa jumlah barang dan biaya sebelum menyimpan.";
    let allocated = 0;
    const last = rows.findLastIndex((row) => row.cost > 0);
    return rows.map((row, index) => {
      const share = row.cost && total ? (index === last ? fee - allocated : Number(BigInt(fee) * BigInt(row.cost) / BigInt(total))) : 0; allocated += share;
      const ingredient = ingredients.find((item) => item.id === row.id);
      return `${ingredient?.name || "Bahan"}: stok +${row.base} ${ingredient?.baseUnit || ""}, ditolak ${row.rejected} kemasan, sisa ${row.remaining} kemasan, nilai ${money(row.cost + share)}`;
    }).join(". ") + `. Total nilai stok ${money(total + fee)}. Invoice dan pembayaran tidak berubah.`;
  } catch { return "Periksa jumlah barang dan biaya sebelum menyimpan."; }
}
