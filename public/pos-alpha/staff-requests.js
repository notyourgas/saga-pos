const states = { submitted: "Diajukan", needs_information: "Perlu informasi", supervisor_approved: "Disetujui atasan", approved: "Disetujui", rejected: "Ditolak", withdrawn: "Ditarik", cancel_requested: "Pembatalan diajukan", cancelled: "Dibatalkan", appealed: "Banding diajukan" };
const categories = { annual_leave: "Cuti tahunan", sick: "Sakit", personal_permission: "Izin pribadi", unpaid_leave: "Cuti tanpa upah", overtime: "Lembur", special_leave: "Cuti khusus" };
const node = (tag, text, parent) => { const element = document.createElement(tag); element.textContent = text; parent?.append(element); return element; };
const minutes = (value) => value === null ? "Belum ditetapkan" : `${new Intl.NumberFormat("id-ID").format(value)} menit`;
const when = (value, timezone) => new Intl.DateTimeFormat("id-ID", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function createStaffRequests({ api, sessionExpired }) {
  const root = document.getElementById("requests-workspace");
  const status = document.getElementById("requests-status"), rows = document.getElementById("requests-list"), detail = document.getElementById("request-detail");
  const filter = document.getElementById("requests-filter"), refresh = document.getElementById("requests-refresh"), next = document.getElementById("requests-next");
  for (const [value, label] of Object.entries(states)) { const option = node("option", label, filter); option.value = value; }
  let allowed = false, cursor = null, listRead = null, detailRead = null, revision = 0, opener = null;
  function closeDetail(focus = false) {
    detailRead?.abort(); detailRead = null; detail.replaceChildren(); detail.hidden = true;
    root.append(detail);
    opener?.setAttribute("aria-expanded", "false");
    if (focus && opener?.isConnected) opener.focus();
    opener = null;
  }
  function reset() {
    revision++; allowed = false; listRead?.abort(); listRead = null; closeDetail(); cursor = null;
    rows.replaceChildren(); status.textContent = ""; root.hidden = true; filter.value = ""; next.hidden = true;
  }
  function controls(busy) { refresh.disabled = !allowed || busy; filter.disabled = !allowed || busy; next.disabled = !allowed || busy; }
  function enable(value) {
    reset(); allowed = value === true; root.hidden = false; controls(false);
    status.textContent = allowed ? "Muat permohonan untuk melihat status terbaru. Hanya data milikmu." : "Akses permohonan belum diberikan. Hubungi pengelola; tidak perlu meminta hak HR.";
  }
  function failure(error, isDetail) {
    if (error.status === 401) { reset(); sessionExpired(); return; }
    if (error.status === 403) { reset(); enable(false); return; }
    status.textContent = error.status === 400 || error.status === 422 ? "Halaman tidak berlaku. Pilih Muat permohonanku untuk memulai lagi." : error.status === 404 && isDetail ? "Permohonan tidak tersedia untuk aksesmu. Muat ulang daftar." : "Permohonan belum dapat dimuat. Data lama disembunyikan; coba muat ulang.";
  }
  function summary(item, parent) {
    node("p", `${categories[item.category]} · ${states[item.state]}`, parent);
    node("p", `${when(item.startsAt, item.timezone)} – ${when(item.endsAt, item.timezone)} · ${item.timezone}`, parent);
    node("p", `${item.locationName} · Diminta ${minutes(item.requestedMinutes)} · Disetujui ${minutes(item.approvedMinutes)}`, parent);
  }
  async function showDetail(item, button) {
    closeDetail(); const controller = new AbortController(); detailRead = controller; const current = revision;
    opener = button; button.setAttribute("aria-expanded", "true"); detail.hidden = false;
    button.closest("article").after(detail);
    node("p", "Memuat detail…", detail);
    const close = node("button", "Tutup detail", detail); close.className = "button button-ghost"; close.addEventListener("click", () => closeDetail(true));
    const content = node("div", "", detail);
    try {
      const { data } = await api("/api/staff/requests/detail", { workforceRequestId: item.id }, controller.signal);
      if (detailRead !== controller || current !== revision || !allowed || document.hidden) return;
      detail.firstElementChild.remove();
      const heading = node("h3", data.request.policyName, content); heading.tabIndex = -1;
      summary(data.request, content); node("p", `Pemohon: ${data.request.employeeName}`, content);
      node("h4", "Alasan permohonan", content); node("p", data.request.reason, content);
      node("h4", "Riwayat status", content);
      if (data.historyTruncated) node("p", "Menampilkan maksimal 100 perubahan terbaru, bukan seluruh riwayat.", content);
      const history = node("ol", "", content);
      for (const event of data.history) node("li", `${when(event.occurredAt, data.request.timezone)} · ${states[event.fromState] ?? event.fromState ?? "Awal"} → ${states[event.toState] ?? event.toState}${event.reason === null ? "" : ` · ${event.reason}`}`, history);
      if (!data.history.length) node("p", "Belum ada riwayat yang tersedia.", content);
      node("h4", "Tahap persetujuan", content);
      const steps = node("ol", "", content);
      for (const step of data.approvalSteps) node("li", `Tahap ${step.stepOrder} · ${{ pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak", skipped: "Dilewati" }[step.state]}${step.decidedAt === null ? "" : ` · ${when(step.decidedAt, data.request.timezone)}`}${step.reason === null ? "" : ` · ${step.reason}`}`, steps);
      if (!data.approvalSteps.length) node("p", "Belum ada tahap persetujuan.", content);
      status.textContent = "Detail diperbarui. Halaman ini hanya untuk membaca.";
      heading.focus();
    } catch (error) {
      if (detailRead !== controller || current !== revision) return;
      closeDetail(true); failure(error, true);
    } finally { if (detailRead === controller) detailRead = null; }
  }
  async function load(useCursor = false) {
    if (!allowed || listRead || document.hidden) return;
    const input = { limit: 20, ...(filter.value ? { state: filter.value } : {}), ...(useCursor && cursor ? { cursor } : {}) };
    const controller = new AbortController(); listRead = controller; const current = ++revision;
    closeDetail(); rows.replaceChildren(); cursor = null; next.hidden = true; controls(true); status.textContent = "Memuat permohonan terbaru…";
    try {
      const { data } = await api("/api/staff/requests/list", input, controller.signal);
      if (listRead !== controller || current !== revision || !allowed || document.hidden) return;
      for (const item of data.items) {
        const article = node("article", "", rows); article.className = "dashboard-card staff-request-card";
        node("h3", item.policyName, article); summary(item, article);
        const button = node("button", `Lihat detail ${item.policyName}`, article); button.className = "button button-ghost";
        button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", "request-detail");
        button.addEventListener("click", () => { if (opener === button) closeDetail(true); else void showDetail(item, button); });
      }
      cursor = data.nextCursor; next.hidden = cursor === null;
      status.textContent = data.items.length ? `${data.items.length} permohonan ditampilkan. ${cursor === null ? "Tidak ada halaman berikutnya pada pembacaan ini." : "Pilih Berikutnya untuk melihat permohonan lebih lama."}` : "Belum ada permohonan sesuai filter ini.";
    } catch (error) {
      if (listRead !== controller || current !== revision) return;
      rows.replaceChildren(); failure(error, false);
    } finally { if (listRead === controller) { listRead = null; controls(false); } }
  }
  refresh.addEventListener("click", () => void load());
  next.addEventListener("click", () => void load(true));
  filter.addEventListener("change", () => void load());
  return { reset, enable };
}
