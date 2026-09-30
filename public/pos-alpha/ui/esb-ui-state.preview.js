import {
  bindUnsavedChangesDialog,
  bindUnsavedForm,
  createUnsavedChangesGuard,
  mountReportShell,
} from "./esb-ui-state-system.js";

const reportRoot = document.querySelector("#report-preview");
const status = document.querySelector("#preview-status");
const baseReport = {
  id: "sales-category",
  title: "Penjualan per kategori",
  description: "Satu kontrak untuk ringkasan visual dan tabel yang dapat digunakan tanpa persepsi warna.",
  metadata: {
    outlet: "Kopi Saga Salak",
    period: "8 September 2026",
    timeBasis: "Waktu pembayaran",
    includedStatuses: "PAID",
    cutoff: "15.30 WIB",
    freshness: "30 detik lalu",
    denominator: "Penjualan menu bersih",
    currency: "IDR",
    policyVersion: "pricing-v1",
    completeness: "Lengkap",
  },
  metric: {
    value: "revenue",
    defaultValue: "revenue",
    options: [
      { value: "", label: "Pilih metrik" },
      { value: "revenue", label: "Nilai penjualan" },
      { value: "quantity", label: "Jumlah terjual" },
    ],
  },
  chartLabel: "Nilai penjualan bersih per kategori",
  tableCaption: "Nilai penjualan bersih per kategori, IDR",
  points: [
    { label: "Kopi", value: 74000, formattedValue: "Rp74.000" },
    { label: "Non-kopi", value: 51000, formattedValue: "Rp51.000" },
    { label: "Makanan", value: 25000, formattedValue: "Rp25.000" },
  ],
  columns: [
    { key: "category", label: "Kategori" },
    { key: "revenue", label: "Nilai penjualan" },
    { key: "share", label: "Porsi" },
  ],
  rows: [
    { category: "Kopi", revenue: "Rp74.000", share: "49,3%" },
    { category: "Non-kopi", revenue: "Rp51.000", share: "34,0%" },
    { category: "Makanan", revenue: "Rp25.000", share: "16,7%" },
  ],
};

let selectedState = null;
const report = mountReportShell(reportRoot, baseReport, {
  onStateAction(action) { status.textContent = `Aksi state dipilih: ${action}.`; },
  onMetricRecovered(result) { status.textContent = `Metrik wajib dipulihkan ke ${result.option.label}.`; },
});

document.querySelector(".preview-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-preview-state]");
  if (!button) return;
  selectedState = button.dataset.previewState === "ready" ? null : { kind: button.dataset.previewState };
  report.update({ state: selectedState });
  status.textContent = selectedState ? `State ${selectedState.kind} ditampilkan.` : "Data laporan ditampilkan.";
});

const form = document.querySelector("#settings-form");
const guard = createUnsavedChangesGuard();
guard.install();
bindUnsavedForm(form, guard);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  guard.markSaved();
  status.textContent = "Perubahan disimpan.";
});

const dialog = document.querySelector("#unsaved-dialog");
const unsavedDialog = bindUnsavedChangesDialog({
  dialog,
  guard,
  discardButton: dialog.querySelector("[data-discard]"),
  stayButton: dialog.querySelector("[data-stay]"),
});
document.querySelector("#leave-report").addEventListener("click", async (event) => {
  const accepted = await unsavedDialog.request({
    trigger: event.currentTarget,
    navigate: () => { status.textContent = "Perubahan dibuang; navigasi dapat dilanjutkan."; },
  });
  if (!accepted) status.textContent = "Tetap di laporan; perubahan tidak hilang.";
});
