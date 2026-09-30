import {
  bindAccessibleDialog,
  bindUnsavedChangesDialog,
  bindUnsavedForm,
  createUnsavedChangesGuard,
  mountReportShell,
  renderSemanticTable,
} from "./esb-ui-state-system.js";

const METRIC_LABELS = Object.freeze([
  ["netMenuSales", "Penjualan menu bersih"],
  ["refunds", "Refund berhasil"],
  ["netSalesAfterRefund", "Penjualan setelah refund"],
  ["appliedPayment", "Pembayaran diterapkan"],
  ["averageBill", "Rata-rata bill"],
  ["averagePax", "Rata-rata pax"],
  ["cogs", "HPP"],
  ["grossMargin", "Margin kotor"],
  ["expectedSettlement", "Settlement diharapkan"],
  ["actualSettlement", "Settlement aktual"],
]);

const SAFE_EXPORT_PREFIX = "/api/operator/reports/";

export function mountOwnerReportIntegration(root, {
  loadReport,
  initialFilters = {},
  outletLabel = "Outlet sesi Owner",
  targetWindow = globalThis.window,
} = {}) {
  if (!root?.addEventListener) throw new TypeError("owner_report_root_required");
  if (typeof loadReport !== "function") throw new TypeError("owner_report_loader_required");

  root.innerHTML = integrationTemplate({ initialFilters, outletLabel });
  const form = root.querySelector("[data-owner-report-filter]");
  const reportRoot = root.querySelector("[data-owner-report-shell]");
  const kpiRoot = root.querySelector("[data-owner-report-kpis]");
  const status = root.querySelector("[data-owner-report-status]");
  const detailButton = root.querySelector("[data-owner-report-detail-open]");
  const exportLink = root.querySelector("[data-owner-report-export]");
  const detailDialog = root.querySelector("[data-owner-report-detail-dialog]");
  const detailBody = root.querySelector("[data-owner-report-detail-body]");
  const detailClose = root.querySelector("[data-owner-report-detail-close]");
  const unsavedDialog = root.querySelector("[data-owner-report-unsaved-dialog]");
  const discardButton = root.querySelector("[data-discard]");
  const stayButton = root.querySelector("[data-stay]");

  const guard = createUnsavedChangesGuard({ targetWindow });
  guard.install();
  const formBinding = bindUnsavedForm(form, guard);
  const unsavedBinding = bindUnsavedChangesDialog({
    dialog: unsavedDialog,
    guard,
    discardButton,
    stayButton,
  });
  const detailBinding = bindAccessibleDialog(detailDialog, { initialFocusSelector: "[data-owner-report-detail-close]" });

  let currentModel = stateModel("loading", outletLabel);
  let requestSequence = 0;
  let controller = new AbortController();
  const shell = mountReportShell(reportRoot, currentModel, {
    onStateAction(action) {
      if (action === "retry") void reload();
      else form.querySelector("input, select")?.focus();
    },
    onMetricRecovered(result) {
      status.textContent = `Metrik wajib dipulihkan ke ${result.option.label}.`;
    },
  });

  const resetActions = () => {
    detailButton.disabled = true;
    detailButton.setAttribute("aria-disabled", "true");
    exportLink.hidden = true;
    exportLink.removeAttribute("href");
    detailBody.replaceChildren();
    kpiRoot.replaceChildren();
  };

  const showState = (kind, overrides = {}) => {
    resetActions();
    currentModel = { ...currentModel, state: { kind, ...overrides } };
    shell.update(currentModel);
  };

  const reload = async () => {
    const sequence = ++requestSequence;
    controller.abort();
    controller = new AbortController();
    showState("loading");
    status.textContent = "Memuat snapshot authoritative…";
    try {
      const response = await loadReport(readFilters(form), { signal: controller.signal });
      if (sequence !== requestSequence) return;
      const payload = normalizeOwnerReportPayload(response, { baseUrl: targetWindow?.location?.origin });
      currentModel = { ...payload.model, state: payload.model.state ?? null };
      shell.update(currentModel);
      renderKpis(kpiRoot, payload.model.authoritativeValues);
      detailBody.innerHTML = renderSemanticTable(payload.detail);
      detailButton.disabled = payload.detail.rows.length === 0;
      detailButton.setAttribute("aria-disabled", String(payload.detail.rows.length === 0));
      exportLink.href = payload.export.href;
      exportLink.hidden = false;
      exportLink.download = payload.export.filename || "sagapos-owner-report.csv";
      status.textContent = payload.model.state?.kind === "empty"
        ? "Snapshot authoritative tersedia tanpa transaksi untuk filter ini."
        : `Snapshot authoritative siap · ${payload.model.reportFingerprint.slice(0, 12)}.`;
      guard.markSaved();
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== requestSequence) return;
      const locked = error?.status === 401 || error?.status === 403;
      showState(locked ? "locked" : "error", locked
        ? { message: "Sesi Owner tidak memiliki scope laporan ini. Hak akses diperiksa di server." }
        : { title: "Laporan authoritative belum tersedia", message: "Adapter laporan server belum siap atau koneksi gagal. Tidak ada angka fallback yang ditampilkan." });
      status.textContent = locked ? "Akses laporan ditolak server." : "Laporan gagal dimuat tanpa menggunakan data pengganti.";
    }
  };

  const submit = (event) => {
    event.preventDefault();
    void reload();
  };
  const openDetail = () => detailBinding.open(detailButton);
  const closeDetail = () => detailBinding.close("close");
  form.addEventListener("submit", submit);
  detailButton.addEventListener("click", openDetail);
  detailClose.addEventListener("click", closeDetail);
  void reload();

  return Object.freeze({
    reload,
    isDirty: guard.isDirty,
    requestNavigation({ trigger, navigate } = {}) {
      return unsavedBinding.request({ trigger, navigate });
    },
    destroy() {
      requestSequence += 1;
      controller.abort();
      form.removeEventListener("submit", submit);
      detailButton.removeEventListener("click", openDetail);
      detailClose.removeEventListener("click", closeDetail);
      detailBinding.destroy();
      unsavedBinding.destroy();
      formBinding.destroy();
      guard.destroy();
      shell.destroy();
      root.replaceChildren();
    },
  });
}

export function normalizeOwnerReportPayload(input, { baseUrl = globalThis.location?.origin } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("owner_report_payload_required");
  const model = input.model;
  const detail = input.detail;
  const exportConfig = input.export;
  const fingerprint = requireText(model?.reportFingerprint, "model.reportFingerprint");
  if (!model?.metadata || !model?.metric || !model?.authoritativeValues) throw new Error("owner_report_model_incomplete");
  if (!Array.isArray(detail?.columns) || !Array.isArray(detail?.rows)) throw new Error("owner_report_detail_incomplete");
  if (requireText(detail.reportFingerprint, "detail.reportFingerprint") !== fingerprint) throw new Error("owner_report_fingerprint_mismatch");
  if (requireText(exportConfig?.reportFingerprint, "export.reportFingerprint") !== fingerprint) throw new Error("owner_report_fingerprint_mismatch");
  for (const [key] of METRIC_LABELS) requireText(model.authoritativeValues[key], `authoritativeValues.${key}`);
  const href = normalizeExportHref(exportConfig.href, baseUrl);
  return Object.freeze({
    model,
    detail: Object.freeze({ caption: requireText(detail.caption, "detail.caption"), columns: detail.columns, rows: detail.rows }),
    export: Object.freeze({ href, filename: normalizeFilename(exportConfig.filename), reportFingerprint: fingerprint }),
  });
}

function integrationTemplate({ initialFilters, outletLabel }) {
  const businessDate = normalizeDate(initialFilters.businessDate) || new Date().toISOString().slice(0, 10);
  const fromDate = normalizeDate(initialFilters.fromDate) || businessDate;
  const toDate = normalizeDate(initialFilters.toDate) || businessDate;
  const timeBasis = ["ORDERED_AT", "PAID_AT", "BUSINESS_DATE"].includes(initialFilters.timeBasis) ? initialFilters.timeBasis : "PAID_AT";
  const rankingKind = ["MAIN", "MODIFIER", "BUNDLE_COMPONENT"].includes(initialFilters.rankingKind) ? initialFilters.rankingKind : "MAIN";
  return `<section class="esb-owner-report-workspace" aria-labelledby="esb-owner-report-title">
    <header class="esb-owner-report-heading"><div><p class="eyebrow">Snapshot server · Owner-only</p><h2 id="esb-owner-report-title">Laporan operasional</h2><p>Filter, KPI, grafik, rincian, dan CSV harus membawa fingerprint snapshot yang sama.</p></div><p data-owner-report-status role="status" aria-live="polite"></p></header>
    <form class="esb-owner-report-filter" data-owner-report-filter>
      <label>Outlet<span class="esb-owner-report-readonly">${escapeHtml(outletLabel)}</span></label>
      <label>Dari<input type="date" name="fromDate" required value="${escapeHtml(fromDate)}"></label>
      <label>Sampai<input type="date" name="toDate" required value="${escapeHtml(toDate)}"></label>
      <label>Basis waktu<select name="timeBasis" required><option value="ORDERED_AT"${timeBasis === "ORDERED_AT" ? " selected" : ""}>Waktu pesanan</option><option value="PAID_AT"${timeBasis === "PAID_AT" ? " selected" : ""}>Waktu pembayaran</option><option value="BUSINESS_DATE"${timeBasis === "BUSINESS_DATE" ? " selected" : ""}>Tanggal bisnis</option></select></label>
      <label>Kelompok ranking<select name="rankingKind" required><option value="MAIN"${rankingKind === "MAIN" ? " selected" : ""}>Menu utama</option><option value="MODIFIER"${rankingKind === "MODIFIER" ? " selected" : ""}>Modifier</option><option value="BUNDLE_COMPONENT"${rankingKind === "BUNDLE_COMPONENT" ? " selected" : ""}>Komponen bundle</option></select></label>
      <button class="button button-primary" type="submit">Tampilkan laporan</button>
    </form>
    <section class="esb-owner-report-kpis" data-owner-report-kpis aria-label="KPI authoritative"></section>
    <div data-owner-report-shell></div>
    <div class="esb-owner-report-actions"><button class="button button-ghost" type="button" data-owner-report-detail-open disabled aria-disabled="true">Buka rincian bill</button><a class="button button-primary" data-owner-report-export hidden>Unduh CSV snapshot</a></div>
    <dialog class="esb-owner-report-detail" data-owner-report-detail-dialog aria-labelledby="esb-owner-detail-title"><div class="esb-owner-report-dialog-heading"><div><p class="eyebrow">Snapshot yang sama</p><h2 id="esb-owner-detail-title">Rincian bill</h2></div><button class="button button-ghost" type="button" data-owner-report-detail-close>Tutup rincian</button></div><div data-owner-report-detail-body></div></dialog>
    <dialog class="esb-owner-report-unsaved" data-owner-report-unsaved-dialog aria-labelledby="esb-owner-unsaved-title"><h2 id="esb-owner-unsaved-title">Perubahan filter belum diterapkan</h2><p>Tampilkan laporan lebih dulu atau buang perubahan sebelum berpindah halaman.</p><div class="esb-owner-report-actions"><button class="button button-ghost" type="button" data-stay>Tetap di sini</button><button class="button button-primary" type="button" data-discard>Buang dan lanjut</button></div></dialog>
  </section>`;
}

function stateModel(kind, outletLabel) {
  return {
    id: "owner-operational-report",
    title: "Laporan Owner",
    description: "Angka hanya ditampilkan setelah snapshot authoritative lolos kontrak server.",
    metadata: { outlet: outletLabel },
    metric: { value: "net_menu_sales", defaultValue: "net_menu_sales", options: [{ value: "net_menu_sales", label: "Penjualan menu bersih" }] },
    points: [{ label: "Belum tersedia", value: 0, formattedValue: "—" }],
    columns: [{ key: "label", label: "Item" }, { key: "value", label: "Nilai" }],
    rows: [],
    authoritativeValues: Object.fromEntries(METRIC_LABELS.map(([key]) => [key, "—"])),
    state: { kind },
    reportFingerprint: "pending-authoritative-snapshot",
  };
}

function renderKpis(root, values) {
  root.replaceChildren(...METRIC_LABELS.map(([key, label]) => {
    const article = root.ownerDocument.createElement("article");
    const heading = root.ownerDocument.createElement("span");
    const value = root.ownerDocument.createElement("strong");
    heading.textContent = label;
    value.textContent = values[key];
    article.append(heading, value);
    return article;
  }));
}

function readFilters(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const fromDate = normalizeDate(values.fromDate);
  const toDate = normalizeDate(values.toDate);
  if (!fromDate || !toDate || fromDate > toDate) throw Object.assign(new Error("Periode laporan tidak valid."), { status: 422 });
  return Object.freeze({ fromDate, toDate, timeBasis: values.timeBasis, rankingKind: values.rankingKind });
}

function normalizeExportHref(value, baseUrl) {
  const text = requireText(value, "export.href");
  if (!baseUrl) {
    if (!text.startsWith(SAFE_EXPORT_PREFIX)) throw new Error("owner_report_export_href_invalid");
    return text;
  }
  const target = new URL(text, baseUrl);
  const base = new URL(baseUrl);
  if (target.origin !== base.origin || !target.pathname.startsWith(SAFE_EXPORT_PREFIX)) throw new Error("owner_report_export_href_invalid");
  return `${target.pathname}${target.search}`;
}

function normalizeFilename(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9._-]+\.csv$/.test(text) ? text : "sagapos-owner-report.csv";
}

function normalizeDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? "" : text;
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`owner_report_field_required:${field}`);
  return value.trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);
}
