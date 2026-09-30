const familyMeta = Object.freeze({
  stockBalance: { title: "Saldo stok", columns: [["Item", "itemId"], ["Lokasi", "locationId"], ["Saldo awal", "openingQuantityBase", "quantity"], ["Perubahan", "periodNetQuantityBase", "quantity"], ["Saldo akhir", "closingQuantityBase", "quantity"], ["Nilai akhir", "closingValueRupiah", "money"], ["Sumber", "sourceRefs", "sources"]] },
  stockCard: { title: "Kartu stok", columns: [["Waktu", "effectiveAt", "datetime"], ["Jenis", "movementKind"], ["Item", "itemId"], ["Lokasi", "locationId"], ["Perubahan", "quantityDeltaBase", "quantity"], ["Nilai", "inventoryValueDeltaRupiah", "money"], ["Sumber", "sourceRef", "source"]] },
  stockValuation: { title: "Valuasi persediaan", columns: [["Item", "itemId"], ["Lokasi", "locationId"], ["Jumlah", "quantityBase", "quantity"], ["Nilai persediaan", "inventoryValueRupiah", "money"], ["Biaya / unit", "averageCostPerBaseUnitRupiah", "money"], ["Sumber", "sourceRefs", "sources"]] },
  costHppCogs: { title: "HPP & COGS", columns: [["Lapisan biaya", "metric"], ["Nilai", "valueRupiah", "money"], ["Nilai diketahui", "knownValueRupiah", "money"], ["Lengkap", "complete", "boolean"], ["Sumber", "sourceRefs", "sources"]] },
  wasteShrinkage: { title: "Waste & shrinkage", columns: [["Bagian", "section"], ["Item", "itemId"], ["Jenis", "movementKind"], ["Waste", "wasteQuantityBase", "quantity"], ["Tidak terjelaskan", "unexplainedQuantityBase", "quantity"], ["Nilai", "inventoryValueDeltaRupiah", "money"], ["Sumber", "sourceRefs", "sources"]] },
  ingredientTheoreticalActual: { title: "Variance bahan", columns: [["Item", "itemId"], ["Aktual kuantitas", "quantity.actualQuantityBase", "quantity"], ["Status nilai", "value.status"], ["Aktual nilai", "value.actualValueRupiah", "money"], ["Sumber", "quantity.sourceRefs", "sources"]] },
  profitability: { title: "Profitabilitas", columns: [["Bagian", "section"], ["Menu / dimensi", "label"], ["Jumlah", "quantityBase", "quantity"], ["Pendapatan bersih", "netRevenueRupiah", "money"], ["COGS disesuaikan", "adjustedCogsRupiah", "money"], ["Margin", "marginRupiah", "money"], ["Sumber", "sourceRefs", "sources"]] },
  supplierScorecard: { title: "Kinerja supplier", columns: [["Supplier", "supplierId"], ["Dipesan", "orderedQuantityBase", "quantity"], ["Diterima", "acceptedQuantityBase", "quantity"], ["Ditolak", "rejectedQuantityBase", "quantity"], ["Nilai diterima", "acceptedValueRupiah", "money"], ["Tepat waktu", "onTimeBps", "bps"], ["Sumber", "sourceRefs", "sources"]] },
  production: { title: "Transformasi produksi", columns: [["Produksi", "productionId"], ["Nilai input", "inputValueRupiah", "money"], ["Nilai output", "outputValueRupiah", "money"], ["Selisih hasil", "yieldVarianceQuantityBase", "quantity"], ["Perubahan nilai", "transformValueDeltaRupiah", "money"], ["Sumber", "sourceRefs", "sources"]] },
  forecastReplenishment: { title: "Forecast & replenishment", columns: [["Item", "itemId"], ["Lokasi", "locationId"], ["Proyeksi kekurangan", "projectedShortageQuantityBase", "quantity"], ["Rekomendasi", "recommendedQuantityBase", "quantity"], ["Kebijakan", "policyVersion"], ["Diamati", "observedAt", "datetime"], ["Sumber", "sourceRefs", "sources"]] },
  dataQuality: { title: "Kualitas data", columns: [["Kode", "code"], ["Dampak", "severity"], ["Referensi", "issueId"], ["Sumber", "sourceRefs", "sources"]] },
});

const filter = document.querySelector("#report-filter");
const statePanel = document.querySelector("#state-panel");
const reportView = document.querySelector("#report-view");
const reportStatus = document.querySelector("#report-status");
const summaryCards = document.querySelector("#summary-cards");
const summaryTitle = document.querySelector("#summary-title");
const scopeSummary = document.querySelector("#scope-summary");
const periodLabel = document.querySelector("#report-period");
const calendarNote = document.querySelector("#calendar-note");
const viewHint = document.querySelector("#view-hint");
const tablePanel = document.querySelector("#report-table-panel");
const columns = document.querySelector("#report-columns");
const rows = document.querySelector("#report-rows");
const empty = document.querySelector("#empty-state");
const tableStatus = document.querySelector("#table-status");
const previous = document.querySelector("#previous-page");
const next = document.querySelector("#next-page");
const pageLabel = document.querySelector("#page-label");
const csvLink = document.querySelector("#csv-link");
const dialog = document.querySelector("#source-dialog");
const sourceDetail = document.querySelector("#source-detail");
let activeFamily = "stockBalance";
let nextCursor = null;
let cursor = null;
let cursorHistory = [];
let reportFingerprint = null;
let reportCalendar = null;
let reportScope = null;
let reportGeneration = 0;
let familyGeneration = 0;
let familyAbortController = null;
let sourceAbortController = null;

filter.addEventListener("submit", (event) => { event.preventDefault(); loadReport(); });
for (const input of filter.elements.view) input.addEventListener("change", () => loadReport());
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => selectFamily(tab.dataset.family));
  tab.addEventListener("keydown", moveTabFocus);
}
previous.addEventListener("click", () => { cursor = cursorHistory.pop() ?? null; loadFamily(); });
next.addEventListener("click", () => { if (!nextCursor) return; cursorHistory.push(cursor); cursor = nextCursor; loadFamily(); });

loadReport();

async function loadReport() {
  const generation = ++reportGeneration;
  familyAbortController?.abort(); sourceAbortController?.abort();
  if (dialog.open) dialog.close();
  reportFingerprint = null; csvLink.removeAttribute("href");
  reportView.hidden = true;
  tablePanel.setAttribute("aria-busy", "true");
  showState("loading", "Menyiapkan laporan", "Menarik snapshot dari provider laporan yang terhubung.");
  cursor = null; cursorHistory = [];
  try {
    const summary = await request(`/api/admin/reports/inventory?${baseParams()}`);
    if (generation !== reportGeneration) return;
    reportFingerprint = summary.reportFingerprint; reportCalendar = summary.calendar; reportScope = summary.scope;
    applyServerContext(summary); renderSummary(summary);
    reportView.hidden = false; statePanel.hidden = true;
    await loadFamily(generation);
  } catch (error) { if (generation === reportGeneration && error.name !== "AbortError") showFailure(error); }
}

async function selectFamily(family) {
  activeFamily = family; cursor = null; cursorHistory = [];
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.family === family;
    tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  tablePanel.setAttribute("aria-labelledby", `tab-${family}`);
  document.querySelector("#detail-title").textContent = familyMeta[family].title;
  await loadFamily();
}

async function loadFamily(expectedReportGeneration = reportGeneration) {
  const generation = ++familyGeneration;
  familyAbortController?.abort(); familyAbortController = new AbortController();
  const family = activeFamily; const expectedFingerprint = reportFingerprint; const selectedCursor = cursor;
  rows.replaceChildren(); empty.hidden = true; tableStatus.textContent = "Memuat rincian…";
  tablePanel.setAttribute("aria-busy", "true"); csvLink.removeAttribute("href");
  if (!expectedFingerprint) return;
  const params = baseParams();
  const fingerprintParam = `&expectedReportFingerprint=${encodeURIComponent(expectedFingerprint)}`;
  const cursorParam = selectedCursor ? `&cursor=${encodeURIComponent(selectedCursor)}` : "";
  try {
    const payload = await request(`/api/admin/reports/inventory/families/${family}?${params}&limit=25${fingerprintParam}${cursorParam}`, familyAbortController.signal);
    if (generation !== familyGeneration || expectedReportGeneration !== reportGeneration || family !== activeFamily) return;
    if (payload.family !== family || payload.reportFingerprint !== expectedFingerprint || payload.scope?.level !== reportScope?.level) throw Object.assign(new Error("projection_changed"), { status: 409 });
    renderTable(payload, family);
    csvLink.href = `/api/admin/reports/inventory/families/${family}.csv?${params}${fingerprintParam}`;
  } catch (error) {
    if (generation !== familyGeneration || error.name === "AbortError") return;
    tableStatus.textContent = error.status === 503 ? "Provider laporan belum tersedia." : error.status === 409 ? "Snapshot laporan berubah. Terapkan ulang periode untuk memuat snapshot terbaru." : "Rincian laporan gagal dimuat.";
  } finally { if (generation === familyGeneration) tablePanel.setAttribute("aria-busy", "false"); }
}

function applyServerContext(payload) {
  if (payload.calendar) {
    filter.elements.periodStart.value = payload.calendar.periodStartDate;
    filter.elements.periodEnd.value = payload.calendar.periodEndDate;
    filter.elements.snapshotCutoff.value = payload.calendar.snapshotCutoffDate;
    calendarNote.textContent = `Kalender ${payload.calendar.timeZone} · pergantian hari bisnis ${payload.calendar.businessDateCutoffLocal}.`;
  }
  const allowed = new Set(payload.scope?.availableViews ?? []);
  for (const input of filter.elements.view) input.disabled = !allowed.has(input.value);
  viewHint.textContent = allowed.has("COMPANY") ? "Mode perusahaan menjumlahkan hanya metrik yang bersifat aditif." : "Mode perusahaan tidak diotorisasi untuk sesi ini.";
}

function renderSummary(payload) {
  const company = payload.scope?.level === "COMPANY";
  reportStatus.textContent = payload.status === "PARTIAL" ? "PERLU DITINJAU" : "LENGKAP";
  reportStatus.className = `status-pill ${payload.status === "PARTIAL" ? "partial" : "complete"}`;
  summaryTitle.textContent = company ? "Total perusahaan" : "Angka utama outlet";
  scopeSummary.textContent = company ? `${payload.scope.outletCount} outlet terotorisasi. Rincian di bawah tetap menyebut outlet asal.` : payload.scope?.label ?? "Outlet aktif";
  periodLabel.textContent = payload.calendar ? `${localDateLabel(payload.calendar.periodStartDate)} – ${localDateLabel(payload.calendar.periodEndDate)} · ${payload.calendar.timeZone}` : `${dateTimeLabel(payload.query.periodStartUtc)} – ${dateTimeLabel(payload.query.periodEndUtc)}`;
  const recipeAvailability = payload.cardAvailability?.currentRecipeHppRupiah;
  const cards = [
    ["Baris saldo", payload.cards.stockLineCount, "baris"],
    ["Nilai persediaan", payload.cards.closingInventoryValueRupiah, "money"],
    ["HPP resep saat ini", payload.cards.currentRecipeHppRupiah, "money", recipeAvailability?.reason === "NON_ADDITIVE_COMPANY" ? "Tidak tersedia sebagai total perusahaan karena metrik ini tidak aditif." : null],
    ["COGS disesuaikan", payload.cards.adjustedCogsRupiah, "money"],
    ["Margin", payload.cards.profitabilityMarginRupiah, "money"],
    ["Isu kualitas data", payload.cards.dataQualityIssueCount, "issue"],
  ];
  summaryCards.replaceChildren(...cards.map(([label, value, type, note]) => {
    const card = element("article", "metric-card");
    card.append(element("p", "", label), element("strong", value == null ? "unknown" : "", display(value, type)), element("small", "", note ?? (value == null ? "Data belum lengkap" : type === "issue" && value > 0 ? "Perlu pemeriksaan" : "Berdasarkan snapshot terpilih")));
    return card;
  }));
}

function renderTable(payload, family) {
  const config = familyMeta[family];
  const tableColumns = payload.scope?.level === "COMPANY" ? [["Cakupan", "reportScope.label"], ...config.columns] : config.columns;
  columns.replaceChildren(...tableColumns.map(([label]) => element("th", "", label)));
  for (const row of payload.rows) {
    const tr = document.createElement("tr");
    const rowContext = `${row.reportScope?.label ?? payload.scope?.label ?? "cakupan laporan"}, ${display(get(row, config.columns[0][1]))}`;
    for (const [, path, type] of tableColumns) {
      const td = document.createElement("td"); const value = get(row, path);
      if (type === "sources") renderSources(td, value ?? (row.sourceRef ? [row.sourceRef] : []), payload.reportFingerprint, rowContext);
      else if (type === "source") renderSources(td, value ? [value] : [], payload.reportFingerprint, rowContext);
      else { td.textContent = display(value, type); if (value == null) td.className = "unknown"; }
      tr.append(td);
    }
    rows.append(tr);
  }
  empty.hidden = payload.rows.length !== 0; nextCursor = payload.page.nextCursor;
  previous.disabled = cursorHistory.length === 0; next.disabled = !nextCursor;
  pageLabel.textContent = `${payload.page.returned} dari ${payload.page.total} baris`;
  tableStatus.textContent = payload.status === "PARTIAL" ? "PARTIAL: sebagian nilai belum lengkap dan ditampilkan sebagai Tidak diketahui." : "Data lengkap untuk snapshot ini.";
}

function renderSources(cell, refs, expectedFingerprint, rowContext) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) { cell.textContent = "Tidak ada"; return; }
  const button = element("button", "source-button", `${list.length} sumber`);
  button.type = "button"; button.setAttribute("aria-label", `Lihat ${list.length} sumber untuk ${rowContext}`);
  button.addEventListener("click", () => showSource(list[0], expectedFingerprint)); cell.append(button);
}

async function showSource(ref, expectedFingerprint) {
  const expectedGeneration = reportGeneration;
  sourceAbortController?.abort(); sourceAbortController = new AbortController();
  sourceDetail.textContent = "Memuat rincian…"; dialog.showModal();
  try {
    const params = new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(baseParams())), expectedReportFingerprint: expectedFingerprint, type: ref.type, id: ref.id });
    if (ref.lineId) params.set("lineId", ref.lineId);
    const payload = await request(`/api/admin/reports/inventory/source?${params}`, sourceAbortController.signal);
    if (expectedGeneration !== reportGeneration || expectedFingerprint !== reportFingerprint) return;
    const dl = element("dl", "detail-list");
    for (const [label, value] of [["Cakupan", payload.scope?.label], ["Dokumen", payload.record.label], ["Status", payload.record.status], ["Nomor", payload.record.documentNumber], ["Waktu", payload.record.occurredAt ? dateTimeLabel(payload.record.occurredAt) : null], ["Keterangan", payload.record.detail]]) dl.append(element("dt", "", label), element("dd", value == null ? "unknown" : "", value ?? "Tidak diketahui"));
    sourceDetail.replaceChildren(dl);
  } catch (error) {
    if (error.name === "AbortError" || expectedGeneration !== reportGeneration) return;
    sourceDetail.textContent = "Rincian sumber tidak tersedia atau tidak termasuk dalam cakupan laporan ini.";
  }
}

function showFailure(error) {
  reportView.hidden = true; tablePanel.setAttribute("aria-busy", "false");
  if ([401, 403].includes(error.status)) showState("locked", "Akses Owner diperlukan", "Masuk melalui Dashboard atau Admin dengan akun Owner untuk membuka laporan inventory.", "/admin", "Buka halaman Admin");
  else if (error.status === 503) showState("error", "Provider laporan belum terhubung", "Data laporan tidak ditampilkan sampai provider authoritative dan kalender bisnis tersedia.");
  else showState("error", "Laporan gagal dimuat", "Periksa periode dan koneksi lalu coba kembali.");
}

function moveTabFocus(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('[role="tab"]')]; const current = tabs.indexOf(event.currentTarget);
  const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[target].focus(); selectFamily(tabs[target].dataset.family);
}

function showState(kind, title, message, href, action) {
  statePanel.hidden = false; statePanel.className = `state-panel ${kind}`;
  const content = [element("h2", "", title), element("p", "", message)];
  if (kind === "loading") content.unshift(element("div", "spinner")); statePanel.replaceChildren(...content);
  if (href) { const link = element("a", "secondary-action", action); link.href = href; statePanel.append(link); }
  reportStatus.textContent = kind === "loading" ? "MEMUAT" : kind === "locked" ? "TERKUNCI" : "TIDAK TERSEDIA"; reportStatus.className = "status-pill";
}

async function request(url, signal) {
  const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin", signal });
  if (!response.ok) { const error = new Error("request_failed"); error.status = response.status; throw error; }
  return response.json();
}

function baseParams() {
  const data = new FormData(filter); const params = new URLSearchParams({ view: data.get("view") || "OUTLET" });
  const dates = ["periodStart", "periodEnd", "snapshotCutoff"];
  if (dates.every((name) => data.get(name))) for (const name of dates) params.set(`${name}Date`, data.get(name));
  return params.toString();
}

function display(value, type) {
  if (value == null) return "Tidak diketahui";
  if (type === "money") return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
  if (type === "quantity") return `${value} unit dasar`;
  if (type === "boolean") return value ? "Ya" : "Tidak";
  if (type === "bps") return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value / 100)}%`;
  if (type === "datetime") return dateTimeLabel(value);
  if (type === "issue") return `${value} isu`;
  if (type === "baris") return `${value} baris`;
  return String(value).replaceAll("_", " ");
}
function get(value, path) { return path.split(".").reduce((item, key) => item?.[key], value); }
function element(tag, className = "", text = "") { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function localDateLabel(value) { const [year, month, day] = value.split("-").map(Number); const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"]; return `${day} ${months[month - 1]} ${year}`; }
function dateTimeLabel(value) { return reportCalendar?.timeZone ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: reportCalendar.timeZone }).format(new Date(value)) : value; }
