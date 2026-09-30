const areas = [
  ["overview", "Ringkasan"],
  ["people", "Staf & akun"],
  ["schedules", "Jadwal"],
  ["approvals", "Persetujuan"],
  ["attendance", "Absensi & laporan"],
];
const activeRequestStates = new Set(["submitted", "supervisor_approved", "needs_information"]);
const rosterLeaveCategories = new Set(["annual_leave", "sick", "personal_permission", "unpaid_leave", "special_leave"]);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const text = (value) => escapeHtml(value || "—");
const dateTime = (value) => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? escapeHtml(new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }).format(date))
    : "—";
};

export function createOwnerHrDashboard({ command, businessDate }) {
  let root = null;
  let state = { status: "idle", data: null, error: "" };
  let generation = 0;
  let mutationPending = false;
  let writesLocked = false;
  let dialog = null;
  let credential = null;
  let credentialTimer = null;
  let notice = "";
  let peopleSearch = "";
  let scheduleWindow = "first";
  let scheduleWorkspace = "";
  let secondary = { status: "idle", data: null, error: "", range: null };

  function area() {
    const requested = location.hash.replace(/^#/, "").split("/")[1];
    return areas.some(([id]) => id === requested) ? requested : "overview";
  }

  function clearCredential() {
    clearTimeout(credentialTimer);
    credentialTimer = null;
    credential = null;
  }

  function reset() {
    generation += 1;
    state = { status: "idle", data: null, error: "" };
    mutationPending = false;
    writesLocked = false;
    dialog = null;
    notice = "";
    peopleSearch = "";
    scheduleWindow = "first";
    scheduleWorkspace = "";
    secondary = { status: "idle", data: null, error: "", range: null };
    clearCredential();
    paint();
  }

  function mount(element) {
    if (root && root !== element) {
      dialog = null;
      clearCredential();
    }
    root = element;
    paint();
  }

  async function load({ force = false } = {}) {
    if (state.status === "loading") return;
    if (!force && state.status === "ready" && state.data?.businessDate === businessDate()) {
      if (area() === "attendance" && secondary.status === "idle") void loadSecondary();
      return;
    }
    const day = businessDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) {
      state = { status: "error", data: null, error: "Tanggal bisnis HR belum tersedia." };
      paint();
      return;
    }
    const requestGeneration = ++generation;
    const rangeEnd = new Date(Date.parse(`${day}T00:00:00.000Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    dialog = null;
    clearCredential();
    state = { status: "loading", data: null, error: "" };
    secondary = { status: "idle", data: null, error: "", range: null };
    notice = "";
    paint();
    try {
      const [people, workspaces, schedules, options, requests, swaps, templates] = await Promise.all([
        command("people.list", { limit: 100 }),
        command("workspaces.list", {}),
        command("schedules.list", { from: day, to: rangeEnd }),
        command("schedules.options", {}),
        command("requests.list", {}),
        command("swaps.pending", {}),
        command("shiftTemplates.list", {}),
      ]);
      if (requestGeneration !== generation) return;
      const rows = [people, workspaces, schedules, requests, swaps, templates].map((result) => result?.data);
      if (!rows.every(Array.isArray) || !Array.isArray(options?.data?.employees) || !Array.isArray(options?.data?.locations)) throw new Error("Data HR tidak sesuai kontrak.");
      state = {
        status: "ready",
        data: { people: rows[0], workspaces: rows[1], schedules: rows[2], options: options.data, requests: rows[3], swaps: rows[4], templates: rows[5], businessDate: day, observedAt: new Date().toISOString() },
        error: "",
      };
    } catch (error) {
      if (requestGeneration !== generation) return;
      state = { status: "error", data: null, error: error.status === 401 || error.status === 403
        ? "Sesi Owner tidak memiliki akses HR yang aktif. Periksa pemetaan akun Owner ke SagaWork."
        : "Data HR belum dapat dimuat. Tidak ada angka fixture yang ditampilkan; coba muat ulang." };
    }
    paint();
    if (state.status === "ready" && area() === "attendance") void loadSecondary();
  }

  async function loadSecondary({ force = false } = {}) {
    if (state.status !== "ready" || secondary.status === "loading" || (!force && secondary.status === "ready")) return;
    const currentGeneration = generation;
    const to = state.data.businessDate;
    const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    secondary = { status: "loading", data: null, error: "", range: { from, to } };
    paint();
    try {
      const [exceptions, corrections, report] = await Promise.all([
        command("attendance.exceptions", { state: "open" }),
        command("corrections.list", {}),
        command("reports.workHours", { from, to }),
      ]);
      if (currentGeneration !== generation) return;
      if (!Array.isArray(exceptions?.data) || !Array.isArray(corrections?.data) || !Array.isArray(report?.data?.rows) || !Array.isArray(report.data.blockers)) throw new Error("Kontrak absensi tidak valid.");
      secondary = { status: "ready", data: { exceptions: exceptions.data, corrections: corrections.data, report: report.data }, error: "", range: { from, to } };
    } catch (error) {
      if (currentGeneration !== generation) return;
      secondary = { status: "error", data: null, error: error.status === 401 || error.status === 403 ? "Akses absensi/laporan belum diizinkan untuk akun ini." : "Absensi/laporan belum dapat dimuat. Data lain tetap tersedia.", range: { from, to } };
    }
    paint();
  }

  function navigation() {
    return `<nav class="owner-hr-tabs" aria-label="Area HR">${areas.map(([id, label]) => `<a href="#workforce/${id}" ${area() === id ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }

  function empty(label) {
    return `<p class="owner-card-note">${escapeHtml(label)}</p>`;
  }

  function rosterImpact(shift, requests) {
    if (!shift.employeeId || !["draft", "published"].includes(shift.state)) return null;
    const startsAt = Date.parse(shift.scheduledStartAt);
    const endsAt = Date.parse(shift.scheduledEndAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) return null;
    let approved = 0;
    let pending = 0;
    for (const request of requests) {
      if (request.employeeId !== shift.employeeId || !rosterLeaveCategories.has(request.category)) continue;
      const requestStart = Date.parse(request.startsAt);
      const requestEnd = Date.parse(request.endsAt);
      if (!Number.isFinite(requestStart) || !Number.isFinite(requestEnd) || requestStart >= requestEnd || requestStart >= endsAt || startsAt >= requestEnd) continue;
      if (request.state === "approved") approved += 1;
      else if (activeRequestStates.has(request.state)) pending += 1;
    }
    return approved || pending ? { approved, pending } : null;
  }

  function overview(data) {
    const todaySchedules = data.schedules.filter((shift) => shift.businessDate === data.businessDate);
    const activeStaff = data.people.filter((person) => person.status === "active").length;
    const publishedShifts = todaySchedules.filter((shift) => shift.state === "published").length;
    const openRequests = data.requests.filter((request) => activeRequestStates.has(request.state)).length;
    const impactedShifts = data.schedules.filter((shift) => rosterImpact(shift, data.requests)).length;
    return `<section class="metric-grid owner-metrics" aria-label="Ringkasan HR dari SagaWork">
      <article class="metric-card"><p>Staf aktif</p><strong>${activeStaff}${data.people.length === 100 ? "+" : ""}</strong><span>${data.people.length === 100 ? "Daftar dibatasi 100; gunakan pencarian di tahap berikut" : "Data HR aktual"}</span></article>
      <article class="metric-card"><p>Shift terbit hari ini</p><strong>${publishedShifts}</strong><span>${todaySchedules.length - publishedShifts} draft hari ini</span></article>
      <article class="metric-card"><p>Permintaan terbuka</p><strong>${openRequests}</strong><span>Izin dan lembur menunggu keputusan</span></article>
      <article class="metric-card"><p>Tukar shift menunggu HR</p><strong>${data.swaps.length}</strong><span>Review di Persetujuan</span></article>
    </section><section class="dashboard-grid">
      <article class="dashboard-card span-7"><div class="section-heading"><div><h2>Jadwal hari ini</h2><p class="card-subtitle">Hanya jadwal yang diterbitkan dianggap berlaku.</p></div><a class="button button-ghost" href="#workforce/schedules">Kelola jadwal</a></div>${todaySchedules.length ? scheduleTable(todaySchedules.slice(0, 8), false, data.requests) : empty("Belum ada jadwal pada tanggal bisnis ini.")}</article>
      <article class="dashboard-card span-5"><h2>Yang perlu ditindak</h2><ul class="readiness-list"><li><span>Permintaan staf</span><strong>${openRequests}</strong></li><li><span>Tukar shift</span><strong>${data.swaps.length}</strong></li><li><span>Draft jadwal hari ini</span><strong>${todaySchedules.length - publishedShifts}</strong></li><li><span>Shift dengan indikasi bentrok izin</span><strong>${impactedShifts}</strong></li></ul><p class="owner-card-note">Indikasi dari jadwal dan permintaan yang dimuat; bukan keputusan otomatis atau total seluruh organisasi.</p><div class="button-row"><a class="button button-primary" href="#workforce/approvals">Buka persetujuan</a><a class="button button-ghost" href="#workforce/schedules">Periksa roster</a></div></article>
      <article class="dashboard-card span-12"><h2>Absensi & payroll</h2><p class="owner-card-note">Ringkasan absensi dan nominal payroll belum disambungkan ke read model ini. Tidak ditampilkan sebagai Rp0 atau angka sintetis. Pembayaran payroll tetap OFF.</p></article>
    </section>`;
  }

  function people(data) {
    const query = peopleSearch.trim().toLocaleLowerCase("id-ID");
    const visible = data.people.filter((person) => !query || `${person.preferredName ?? ""} ${person.employeeCode ?? ""}`.toLocaleLowerCase("id-ID").includes(query));
    const rows = visible.map((person) => {
      const lifecycleAction = person.accessStatus === "active" ? "suspend_access" : person.accessStatus === "suspended" && person.accountStatus === "active" && !["terminated", "archived"].includes(person.status) ? "restore_access" : null;
      const accountActions = !person.hasLogin
        ? `<button class="button button-ghost" type="button" data-hr-credential="${escapeHtml(person.id)}" ${writesLocked ? "disabled" : ""}>Terbitkan akses awal</button>`
        : `<button class="button button-ghost" type="button" data-hr-reset="${escapeHtml(person.id)}" ${writesLocked ? "disabled" : ""}>Reset akses Staff</button> ${lifecycleAction ? `<button class="button button-ghost" type="button" data-hr-lifecycle="${escapeHtml(person.id)}" data-action="${lifecycleAction}" ${writesLocked ? "disabled" : ""}>${lifecycleAction === "restore_access" ? "Pulihkan akses" : "Tangguhkan akses"}</button>` : ""}`;
      return `<tr><th scope="row">${text(person.preferredName)}</th><td>${text(person.employeeCode)}</td><td>${text(person.status)}</td><td>${person.hasLogin ? `${text(person.accessStatus || "Akun tersedia")} · ${text(person.accountStatus)}` : "Belum ada akun"}</td><td><button class="button button-ghost" type="button" data-hr-edit="${escapeHtml(person.id)}" ${writesLocked ? "disabled" : ""}>Edit data</button> ${accountActions}</td></tr>`;
    }).join("");
    return `<article class="dashboard-card"><div class="section-heading"><div><h2>Staf & akun</h2><p class="card-subtitle">Buat staf dahulu, lalu terbitkan akses awal. Akun Staff tidak otomatis mendapat hak HR atau kasir.</p></div><button class="button button-primary" type="button" data-hr-open="staff" ${writesLocked ? "disabled" : ""}>+ Tambah staf</button></div>
      <label>Cari dari daftar yang dimuat<input data-hr-search type="search" value="${escapeHtml(peopleSearch)}" placeholder="Nama atau kode staf" maxlength="120"></label>
      ${data.people.length === 100 ? '<p class="inventory-inline-warning" role="note">100 staf pertama ditampilkan. Daftar ini belum membuktikan total seluruh staf.</p>' : ""}
      ${rows ? `<div class="dashboard-table" role="region" aria-label="Daftar staf HR" tabindex="0"><table><thead><tr><th scope="col">Staf</th><th scope="col">Kode</th><th scope="col">Status</th><th scope="col">Akses</th><th scope="col">Kelola</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty(data.people.length ? "Tidak ada staf yang cocok dalam daftar yang dimuat." : "Belum ada staf. Tambahkan staf pertama untuk mulai menjadwalkan shift.")}
      <p class="owner-card-note">Akun approver/Supervisor belum bisa dibuat dari integrasi ini. Penerbitan dan reset di atas khusus akun Staff; hak approval mengikuti akun dan scope yang sudah dikelola SagaWork.</p>
    </article>`;
  }

  function reviewableDraft(shift) {
    if (shift?.state !== "draft" || !shift.id || !shift.employeeId || !shift.locationId || !shift.employeeName || !shift.locationName || !/^\d{4}-\d{2}-\d{2}$/.test(shift.businessDate)) return false;
    const start = Date.parse(shift.scheduledStartAt);
    const end = Date.parse(shift.scheduledEndAt);
    return Number.isFinite(start) && Number.isFinite(end) && start < end;
  }

  function scheduleTable(rows, actions = true, requests = []) {
    return `<div class="dashboard-table" role="region" aria-label="Jadwal HR" tabindex="0"><table><thead><tr><th scope="col">Tanggal</th><th scope="col">Staf</th><th scope="col">Workspace</th><th scope="col">Jam</th><th scope="col">Status</th><th scope="col">Dampak izin</th>${actions ? '<th scope="col">Aksi</th>' : ""}</tr></thead><tbody>${rows.map((shift) => {
      const impact = rosterImpact(shift, requests);
      return `<tr><td>${text(shift.businessDate)}</td><th scope="row">${text(shift.employeeName)}</th><td>${text(shift.locationName)}</td><td>${dateTime(shift.scheduledStartAt)} – ${dateTime(shift.scheduledEndAt)}</td><td>${text(shift.state)}</td><td>${impact ? `${impact.approved ? `${impact.approved} izin disetujui` : ""}${impact.approved && impact.pending ? " · " : ""}${impact.pending ? `${impact.pending} permintaan menunggu` : ""}` : "—"}</td>${actions ? `<td>${reviewableDraft(shift) ? `<button class="button button-ghost" type="button" data-hr-publish="${escapeHtml(shift.id)}" ${writesLocked ? "disabled" : ""}>Terbitkan</button>` : shift.state === "draft" ? "Data draft tidak lengkap" : "—"}</td>` : ""}</tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function usableTemplateDate(template, data) {
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const timestamp = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
    };
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (template.status !== "active" || template.versionStatus !== "active" || !template.versionId
      || !data.options.locations.some((workspace) => workspace.id === template.locationId)
      || !time.test(template.localStartTime) || !time.test(template.localEndTime)
      || !Number.isInteger(template.breakMinutes) || template.breakMinutes < 0 || template.breakMinutes > 240
      || !validDate(template.effectiveFrom) || (template.effectiveTo && !validDate(template.effectiveTo))) return null;
    const businessDay = template.effectiveFrom > data.businessDate ? template.effectiveFrom : data.businessDate;
    return template.effectiveTo && template.effectiveTo < businessDay ? null : businessDay;
  }

  function schedules(data) {
    const dateAfter = (offset) => new Date(Date.parse(`${data.businessDate}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const windows = { first: [data.businessDate, dateAfter(6)], second: [dateAfter(7), dateAfter(13)], all: [data.businessDate, dateAfter(14)] };
    const [from, to] = windows[scheduleWindow] ?? windows.first;
    const workspaceNames = [...new Set(data.schedules.map((shift) => shift.locationName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id-ID"));
    const visibleSchedules = data.schedules.filter((shift) => shift.businessDate >= from && shift.businessDate <= to && (!scheduleWorkspace || shift.locationName === scheduleWorkspace));
    const templates = data.templates.map((template) => `<tr><th scope="row">${text(template.name)}</th><td>${text(template.workspaceName)}</td><td>${text(template.localStartTime)} – ${text(template.localEndTime)}</td><td>${text(template.status)}</td><td>${template.status === "draft" ? `<button class="button button-ghost" type="button" data-hr-template="${escapeHtml(template.id)}" ${writesLocked ? "disabled" : ""}>Terbitkan template</button>` : usableTemplateDate(template, data) ? `<button class="button button-ghost" type="button" data-hr-use-template="${escapeHtml(template.versionId)}" ${writesLocked ? "disabled" : ""}>Pakai pola</button>` : "—"}</td></tr>`).join("");
    return `<section class="dashboard-grid"><article class="dashboard-card span-12"><div class="section-heading"><div><h2>Jadwal staf</h2><p class="card-subtitle">Jadwal baru dibuat sebagai draft; terbitkan setelah jam dan staf benar.</p></div><button class="button button-primary" type="button" data-hr-open="schedule" ${writesLocked ? "disabled" : ""}>+ Tambah jadwal</button></div>
      <div class="owner-hr-form-grid"><label>Periode jadwal<select data-hr-schedule-window><option value="first" ${scheduleWindow === "first" ? "selected" : ""}>7 hari awal</option><option value="second" ${scheduleWindow === "second" ? "selected" : ""}>7 hari berikutnya</option><option value="all" ${scheduleWindow === "all" ? "selected" : ""}>Semua 15 hari</option></select></label><label>Filter Workspace<select data-hr-schedule-workspace><option value="">Semua Workspace</option>${workspaceNames.map((name) => `<option value="${escapeHtml(name)}" ${scheduleWorkspace === name ? "selected" : ""}>${text(name)}</option>`).join("")}</select></label></div>
      <p class="owner-card-note" role="status">${visibleSchedules.length} jadwal ditampilkan · ${escapeHtml(from)} sampai ${escapeHtml(to)}. Filter hanya mengubah tampilan; jadwal berlaku tetap harus diterbitkan.</p>
      ${visibleSchedules.length ? scheduleTable(visibleSchedules, true, data.requests) : empty(data.schedules.length ? "Tidak ada jadwal yang cocok pada periode dan Workspace ini." : "Belum ada jadwal untuk 15 hari ke depan.")}<p class="owner-card-note">Dampak izin adalah indikasi dari rentang waktu dan ID staf yang sama. Periksa keputusan permintaan dan sesuaikan roster secara manual; perubahan filter tidak mengubah jadwal.</p></article>
      <article class="dashboard-card span-12"><div class="section-heading"><div><h3>Template shift</h3><p class="card-subtitle">Atur pola jam sekali, lalu gunakan saat membuat jadwal.</p></div><button class="button button-ghost" type="button" data-hr-open="template" ${writesLocked ? "disabled" : ""}>+ Tambah template</button></div>${templates ? `<div class="dashboard-table" role="region" aria-label="Template shift HR" tabindex="0"><table><thead><tr><th>Template</th><th>Workspace</th><th>Jam</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${templates}</tbody></table></div>` : empty("Belum ada template shift.")}</article></section>`;
  }

  function approvals(data) {
    const pending = data.requests.filter((request) => activeRequestStates.has(request.state));
    const swaps = data.swaps.map((swap) => `<tr><th scope="row">${text(swap.requesterName)}</th><td>${text(swap.targetName)}</td><td>${dateTime(swap.sourceStartAt)} – ${dateTime(swap.sourceEndAt)}</td><td>${text(swap.reason)}</td><td><button class="button button-ghost" type="button" data-hr-swap="${escapeHtml(swap.id)}" data-decision="reject" ${writesLocked ? "disabled" : ""}>Tolak</button> <button class="button button-primary" type="button" data-hr-swap="${escapeHtml(swap.id)}" data-decision="approve" ${writesLocked ? "disabled" : ""}>Setujui</button></td></tr>`).join("");
    return `<section class="dashboard-grid"><article class="dashboard-card span-12"><h2>Persetujuan HR</h2><p class="card-subtitle">Satu sesi Owner. Hak, scope outlet, dan larangan satu aktor menyetujui dua tahap tetap diperiksa SagaWork.</p></article>
      <article class="dashboard-card span-12"><h3>Permintaan izin & lembur · ${pending.length} terbuka</h3><p class="owner-card-note">Tahap pertama review Supervisor, tahap kedua keputusan HR/Owner. Jika Owner sudah melakukan tahap pertama, SagaWork akan menolak keputusan kedua dari akun yang sama.</p>${pending.length ? `<div class="dashboard-table" role="region" aria-label="Permintaan HR terbuka" tabindex="0"><table><thead><tr><th scope="col">Staf</th><th scope="col">Jenis</th><th scope="col">Status</th><th scope="col">Periode</th><th scope="col">Keputusan</th></tr></thead><tbody>${pending.slice(0, 20).map((request) => `<tr><th scope="row">${text(request.employeeName)}</th><td>${text(request.policyName)}</td><td>${text(request.state)}</td><td>${dateTime(request.startsAt)} – ${dateTime(request.endsAt)}</td><td>${request.id ? `<button class="button button-ghost" type="button" data-hr-request="${escapeHtml(request.id)}" data-decision="reject" ${writesLocked ? "disabled" : ""}>Tolak</button> <button class="button button-primary" type="button" data-hr-request="${escapeHtml(request.id)}" data-decision="approve" ${writesLocked ? "disabled" : ""}>${request.state === "supervisor_approved" ? "Setujui final" : "Review tahap 1"}</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : empty("Tidak ada permintaan yang menunggu keputusan.")}</article>
      <article class="dashboard-card span-12"><h3>Tukar shift · ${data.swaps.length} menunggu</h3>${swaps ? `<div class="dashboard-table" role="region" aria-label="Tukar shift menunggu HR" tabindex="0"><table><thead><tr><th scope="col">Pemohon</th><th scope="col">Target</th><th scope="col">Shift</th><th scope="col">Alasan</th><th scope="col">Keputusan</th></tr></thead><tbody>${swaps}</tbody></table></div>` : empty("Tidak ada tukar shift yang menunggu review.")}</article></section>`;
  }

  function staffDialog(data) {
    const workspaces = data.workspaces.filter((workspace) => workspace.status === "active");
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><form data-hr-form="staff"><h2 id="owner-hr-dialog-title">Tambah staf</h2><p>Buat data staf di HR. Stok, POS, dan akses login tidak berubah sampai akses awal diterbitkan.</p><div class="owner-hr-form-grid">
      <label>Kode staf<input name="employeeCode" maxlength="48" required></label><label>Nama panggilan<input name="preferredName" maxlength="120" required></label><label>Nama resmi<input name="legalName" maxlength="180" required></label>
      <label>Jenis kerja<select name="employmentType"><option value="permanent">Tetap</option><option value="contract">Kontrak</option><option value="part_time">Paruh waktu</option><option value="daily">Harian</option></select></label>
      <label>Tanggal mulai<input name="startsOn" type="date" required></label><label>Workspace utama<select name="primaryWorkspaceId" required><option value="">Pilih Workspace</option>${workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}">${text(workspace.name)}</option>`).join("")}</select></label></div>
      ${workspaces.length ? "" : '<p role="alert">Belum ada Workspace aktif. Buat Workspace melalui setup HR sebelum menambah staf.</p>'}
      <div class="button-row"><button class="button button-ghost" type="button" data-hr-close>Batal</button><button class="button button-primary" type="submit" ${mutationPending || !workspaces.length ? "disabled" : ""}>Simpan staf</button></div></form></dialog>`;
  }

  function scheduleDialog(data) {
    const template = data.templates.find((item) => item.versionId === dialog?.templateVersionId);
    const templateDay = template ? usableTemplateDate(template, data) : null;
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><form data-hr-form="schedule"><h2 id="owner-hr-dialog-title">Tambah jadwal</h2><p>Draft tidak tampil sebagai jadwal berlaku sampai diterbitkan.${templateDay ? ` Pola ${text(template.name)} hanya menyalin isian; jadwal tidak terhubung otomatis dengan template.` : ""}</p><div class="owner-hr-form-grid">
      <label>Staf<select name="employeeId" required><option value="">Pilih staf</option>${data.options.employees.map((person) => `<option value="${escapeHtml(person.id)}">${text(person.preferredName)} · ${text(person.employeeCode)}</option>`).join("")}</select></label>
      <label>Workspace<select name="locationId" required><option value="">Pilih Workspace</option>${data.options.locations.map((workspace) => `<option value="${escapeHtml(workspace.id)}" ${templateDay && workspace.id === template.locationId ? "selected" : ""}>${text(workspace.name)}</option>`).join("")}</select></label>
      <label>Tanggal kerja<input name="businessDate" type="date" value="${escapeHtml(templateDay || data.businessDate)}" ${templateDay ? `min="${escapeHtml(template.effectiveFrom)}" ${template.effectiveTo ? `max="${escapeHtml(template.effectiveTo)}"` : ""}` : ""} required></label><label>Mulai<input name="localStartTime" type="time" value="${templateDay ? escapeHtml(template.localStartTime) : ""}" required></label><label>Selesai<input name="localEndTime" type="time" value="${templateDay ? escapeHtml(template.localEndTime) : ""}" required></label>
      <label>Istirahat (menit)<input name="breakMinutes" type="number" min="0" max="240" value="${templateDay ? escapeHtml(template.breakMinutes) : "0"}" required></label><label>Peran (opsional)<input name="roleLabel" maxlength="100" value="${templateDay ? escapeHtml(template.roleLabel ?? "") : ""}"></label></div>
      <div class="button-row"><button class="button button-ghost" type="button" data-hr-close>Batal</button><button class="button button-primary" type="submit" ${mutationPending ? "disabled" : ""}>Simpan draft</button></div></form></dialog>`;
  }

  function publishDialog(data) {
    const shift = data.schedules.find((item) => item.id === dialog.scheduleId && reviewableDraft(item));
    if (!shift) return "";
    const impact = rosterImpact(shift, data.requests);
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><form data-hr-publish-form><h2 id="owner-hr-dialog-title">Review sebelum terbitkan jadwal</h2><p>Setelah diterbitkan, jadwal ini dianggap berlaku untuk staf. Backend HR tetap memeriksa status draft, hak Workspace, dan menyimpan alasan pada audit.</p>
      <dl><dt>Staf</dt><dd>${text(shift.employeeName)}</dd><dt>Workspace</dt><dd>${text(shift.locationName)}</dd><dt>Tanggal kerja</dt><dd>${text(shift.businessDate)}</dd><dt>Jam</dt><dd>${dateTime(shift.scheduledStartAt)} – ${dateTime(shift.scheduledEndAt)}</dd><dt>Status</dt><dd>Draft</dd></dl>
      <p class="owner-card-note">${impact ? `${impact.approved ? `${impact.approved} izin disetujui` : ""}${impact.approved && impact.pending ? " · " : ""}${impact.pending ? `${impact.pending} permintaan menunggu` : ""}. Periksa dampaknya pada roster sebelum melanjutkan.` : "Tidak ada indikasi bentrok izin pada data yang dimuat; ini bukan jaminan seluruh permintaan sudah tercakup."}</p>
      ${impact ? '<label><input name="reviewedLeave" type="checkbox" required> Saya sudah memeriksa dampak izin pada roster</label>' : ""}
      <label>Alasan penerbitan<textarea name="reason" minlength="10" maxlength="255" required></textarea></label>
      <div class="button-row"><button class="button button-ghost" type="button" data-hr-close>Batal</button><button class="button button-primary" type="submit" ${mutationPending || writesLocked ? "disabled" : ""}>Ya, terbitkan jadwal</button></div></form></dialog>`;
  }

  function templateDialog(data) {
    const workspaces = data.workspaces.filter((workspace) => workspace.status === "active");
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><form data-hr-form="template"><h2 id="owner-hr-dialog-title">Tambah template shift</h2><p>Template dibuat draft dan belum berlaku sampai diterbitkan.</p><div class="owner-hr-form-grid">
      <label>Nama template<input name="name" maxlength="120" required></label><label>Workspace<select name="locationId" required><option value="">Pilih Workspace</option>${workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}">${text(workspace.name)}</option>`).join("")}</select></label>
      <label>Mulai<input name="localStartTime" type="time" required></label><label>Selesai<input name="localEndTime" type="time" required></label><label>Istirahat (menit)<input name="breakMinutes" type="number" min="0" max="240" value="0" required></label>
      <label>Kompensasi istirahat<select name="breakCompensation"><option value="unpaid">Tidak dibayar</option><option value="paid">Dibayar</option></select></label><label>Berlaku mulai<input name="effectiveFrom" type="date" value="${escapeHtml(data.businessDate)}" required></label><label>Peran (opsional)<input name="roleLabel" maxlength="100"></label></div>
      <div class="button-row"><button class="button button-ghost" type="button" data-hr-close>Batal</button><button class="button button-primary" type="submit" ${mutationPending || !workspaces.length ? "disabled" : ""}>Simpan template</button></div></form></dialog>`;
  }

  function editDialog(data) {
    const person = data.people.find((item) => item.id === dialog.employeeId);
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><form data-hr-form="edit"><h2 id="owner-hr-dialog-title">Edit data staf</h2><p>${text(person?.employeeCode)} · Hak akses akun tidak berubah melalui edit data.</p><div class="owner-hr-form-grid"><label>Nama panggilan<input name="preferredName" maxlength="120" value="${escapeHtml(person?.preferredName)}" required></label><label>Nama resmi<input name="legalName" maxlength="180" value="${escapeHtml(person?.legalName)}" required></label><label>Alasan perubahan<input name="reason" minlength="5" maxlength="255" required></label></div><div class="button-row"><button class="button button-ghost" type="button" data-hr-close>Batal</button><button class="button button-primary" type="submit" ${mutationPending ? "disabled" : ""}>Simpan perubahan</button></div></form></dialog>`;
  }

  function credentialDialog(data) {
    const person = data.people.find((item) => item.id === dialog.employeeId);
    return `<dialog class="owner-hr-dialog" data-hr-dialog aria-labelledby="owner-hr-dialog-title"><h2 id="owner-hr-dialog-title">${dialog.kind === "reset" ? "Reset akses Staff" : "Terbitkan akses awal"}</h2><p>${text(person?.preferredName)} · ${text(person?.employeeCode)}</p><p>Password sementara hanya tampil sekali dan harus dibagikan secara privat. ${dialog.kind === "reset" ? "Sesi Staff yang lama akan dicabut." : "Hak approver, HR, dan kasir tidak diberikan otomatis."}</p>
      ${dialog.kind === "reset" && !credential ? '<label>Alasan reset<input data-hr-reset-reason minlength="10" maxlength="255" required></label>' : ""}
      ${credential ? `<div class="owner-hr-credential" role="status"><p>Kode perusahaan: ${text(credential.organizationSlug)}</p><p>Kode staf: ${text(credential.employeeCode)}</p><p>Password sementara: ${text(credential.temporaryPassword)}</p><p>Berlaku sampai: ${dateTime(credential.expiresAt)}</p></div>` : `<button class="button button-primary" type="button" data-hr-issue ${mutationPending ? "disabled" : ""}>Ya, terbitkan akses</button>`}
      <button class="button button-ghost" type="button" data-hr-close>Tutup & hapus tampilan</button></dialog>`;
  }

  function attendance() {
    if (secondary.status === "idle" || secondary.status === "loading") return '<article class="dashboard-card" role="status">Memuat absensi dan laporan 7 hari…</article>';
    if (secondary.status === "error") return `<article class="dashboard-card" role="alert"><h3>Absensi/laporan belum tersedia</h3><p>${escapeHtml(secondary.error)}</p><button class="button button-ghost" type="button" data-hr-secondary-refresh>Coba lagi</button></article>`;
    const { exceptions, corrections, report } = secondary.data;
    const openCorrections = corrections.filter((item) => !["approved", "rejected", "cancelled"].includes(item.state));
    return `<section class="dashboard-grid"><article class="dashboard-card span-12"><h2>Absensi & laporan jam kerja</h2><p class="card-subtitle">${text(secondary.range.from)}–${text(secondary.range.to)} · sumber SagaWork · ${text(report.state)}. Data yang belum final tidak dianggap payroll siap bayar.</p><button class="button button-ghost" type="button" data-hr-secondary-refresh>Perbarui absensi</button></article>
      <article class="dashboard-card span-12"><h3>Perlu ditindak</h3><p>${exceptions.length} exception terbuka · ${openCorrections.length} koreksi terbuka · ${report.blockers.length} blocker laporan.</p>${exceptions.length ? `<div class="dashboard-table" role="region" aria-label="Exception absensi" tabindex="0"><table><thead><tr><th>Staf</th><th>Workspace</th><th>Jenis</th><th>Tingkat</th><th>SLA</th></tr></thead><tbody>${exceptions.slice(0, 30).map((item) => `<tr><th>${text(item.employeeName)}</th><td>${text(item.locationName)}</td><td>${text(item.type)}</td><td>${text(item.severity)}</td><td>${dateTime(item.slaDueAt)}</td></tr>`).join("")}</tbody></table></div>` : empty("Tidak ada exception terbuka.")}</article>
      <article class="dashboard-card span-12"><h3>Koreksi absensi</h3>${openCorrections.length ? `<div class="dashboard-table" role="region" aria-label="Koreksi absensi" tabindex="0"><table><thead><tr><th>Staf</th><th>Workspace</th><th>Jenis</th><th>Status</th></tr></thead><tbody>${openCorrections.slice(0, 30).map((item) => `<tr><th>${text(item.employeeName)}</th><td>${text(item.locationName)}</td><td>${text(item.category)}</td><td>${text(item.state)}</td></tr>`).join("")}</tbody></table></div>` : empty("Tidak ada koreksi terbuka.")}</article>
      <article class="dashboard-card span-12"><h3>Jam kerja terlapor</h3><p>${report.rows.length} shift tercatat. ${report.blockers.length ? "Ada blocker; cek perbaikan absensi sebelum finalisasi." : "Tidak ada blocker pada rentang ini."}</p><p class="owner-card-note">Nominal payroll dan pembayaran tetap OFF. Laporan ini tidak memicu pembayaran.</p></article></section>`;
  }

  function paint() {
    if (!root) return;
    const data = state.data;
    root.innerHTML = `<header class="inventory-workspace-heading"><div><p class="eyebrow">HR · satu dashboard Owner</p><h2>Tim, jadwal, dan keputusan</h2><p>Akun Owner yang sama mengelola HR melalui izin SagaWork. Tidak ada login HR kedua.</p></div><button class="button button-ghost" type="button" data-hr-refresh ${state.status === "loading" ? "disabled" : ""}>Perbarui data</button></header>
      ${navigation()}<p class="owner-hr-data-note" role="status">${state.status === "ready" ? `SagaWork · diperbarui ${dateTime(data.observedAt)} · tanggal bisnis ${escapeHtml(data.businessDate)} WIB` : "Data HR aktual, tanpa fixture."}</p>
      ${notice ? `<p class="form-status" role="status">${escapeHtml(notice)}</p>` : ""}
      ${writesLocked ? '<p class="inventory-inline-warning" role="alert">Hasil aksi belum pasti. Periksa data dan histori, lalu muat ulang dashboard sebelum mencoba aksi baru.</p>' : ""}
      ${state.status === "loading" ? '<article class="dashboard-card" role="status">Memuat data HR dari SagaWork…</article>' : state.status === "error" ? `<article class="dashboard-card" role="alert"><h3>HR belum dapat ditampilkan</h3><p>${escapeHtml(state.error)}</p><button class="button button-ghost" type="button" data-hr-refresh>Coba lagi</button></article>` : state.status === "ready"
        ? area() === "people" ? people(data) : area() === "schedules" ? schedules(data) : area() === "approvals" ? approvals(data) : area() === "attendance" ? attendance() : overview(data)
        : '<article class="dashboard-card" role="status">Menyiapkan data HR…</article>'}
      ${state.status === "ready" && dialog ? dialog.kind === "staff" ? staffDialog(data) : dialog.kind === "schedule" ? scheduleDialog(data) : dialog.kind === "template" ? templateDialog(data) : dialog.kind === "publish" ? publishDialog(data) : dialog.kind === "edit" ? editDialog(data) : credentialDialog(data) : ""}`;
    root.querySelectorAll("[data-hr-refresh]").forEach((button) => button.addEventListener("click", () => void load({ force: true })));
    root.querySelectorAll("[data-hr-open]").forEach((button) => button.addEventListener("click", () => { dialog = { kind: button.dataset.hrOpen }; paint(); }));
    root.querySelectorAll("[data-hr-use-template]").forEach((button) => button.addEventListener("click", () => { dialog = { kind: "schedule", templateVersionId: button.dataset.hrUseTemplate }; paint(); }));
    root.querySelector("[data-hr-search]")?.addEventListener("input", (event) => { peopleSearch = event.target.value; const selection = event.target.selectionStart; paint(); const search = root?.querySelector("[data-hr-search]"); search?.focus(); search?.setSelectionRange(selection, selection); });
    root.querySelector("[data-hr-schedule-window]")?.addEventListener("change", (event) => { scheduleWindow = event.target.value; paint(); root?.querySelector("[data-hr-schedule-window]")?.focus(); });
    root.querySelector("[data-hr-schedule-workspace]")?.addEventListener("change", (event) => { scheduleWorkspace = event.target.value; paint(); root?.querySelector("[data-hr-schedule-workspace]")?.focus(); });
    root.querySelectorAll("[data-hr-edit]").forEach((button) => button.addEventListener("click", () => { dialog = { kind: "edit", employeeId: button.dataset.hrEdit }; paint(); }));
    root.querySelectorAll("[data-hr-reset]").forEach((button) => button.addEventListener("click", () => { dialog = { kind: "reset", employeeId: button.dataset.hrReset }; paint(); }));
    root.querySelectorAll("[data-hr-lifecycle]").forEach((button) => button.addEventListener("click", () => void lifecycle(button.dataset.hrLifecycle, button.dataset.action)));
    root.querySelectorAll("[data-hr-credential]").forEach((button) => button.addEventListener("click", () => { dialog = { kind: "credential", employeeId: button.dataset.hrCredential }; paint(); }));
    root.querySelectorAll("[data-hr-close]").forEach((button) => button.addEventListener("click", closeDialog));
    root.querySelector("[data-hr-dialog]")?.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
    root.querySelector("[data-hr-dialog]")?.showModal();
    root.querySelectorAll("[data-hr-form]").forEach((form) => form.addEventListener("submit", (event) => { event.preventDefault(); void submitForm(form); }));
    root.querySelector("[data-hr-publish-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity() || mutationPending || writesLocked) return;
      const scheduleId = dialog?.scheduleId;
      if (!state.data?.schedules.some((shift) => shift.id === scheduleId && reviewableDraft(shift))) return;
      const reason = form.elements.reason.value.trim();
      dialog = null;
      void decide("schedules.publish", { scheduleId }, "Terbitkan jadwal", reason);
    });
    root.querySelector("[data-hr-issue]")?.addEventListener("click", () => void issueCredential());
    root.querySelectorAll("[data-hr-publish]").forEach((button) => button.addEventListener("click", () => {
      const scheduleId = button.dataset.hrPublish;
      if (!writesLocked && state.data?.schedules.some((shift) => shift.id === scheduleId && reviewableDraft(shift))) { dialog = { kind: "publish", scheduleId }; paint(); }
    }));
    root.querySelectorAll("[data-hr-template]").forEach((button) => button.addEventListener("click", () => void decide("shiftTemplates.status", { templateId: button.dataset.hrTemplate, action: "publish" }, "Terbitkan template")));
    root.querySelectorAll("[data-hr-request]").forEach((button) => button.addEventListener("click", () => void reviewRequest(button.dataset.hrRequest, button.dataset.decision)));
    root.querySelector("[data-hr-secondary-refresh]")?.addEventListener("click", () => void loadSecondary({ force: true }));
    root.querySelectorAll("[data-hr-swap]").forEach((button) => button.addEventListener("click", () => void decide("swaps.review", { swapRequestId: button.dataset.hrSwap, decision: button.dataset.decision }, button.dataset.decision === "approve" ? "Setujui tukar shift" : "Tolak tukar shift")));
  }

  function closeDialog() {
    if (mutationPending) return;
    const credentialWasShown = Boolean(credential);
    dialog = null;
    clearCredential();
    paint();
    if (credentialWasShown) void load({ force: true });
    root?.querySelector('[data-hr-open], [data-hr-credential]')?.focus();
  }

  async function submitForm(form) {
    if (mutationPending || writesLocked) return;
    if (!form.reportValidity()) return;
    const input = Object.fromEntries(new FormData(form));
    const operation = form.dataset.hrForm === "staff" ? "people.create" : form.dataset.hrForm === "edit" ? "people.update" : form.dataset.hrForm === "template" ? "shiftTemplates.create" : "schedules.create";
    if (operation === "people.update") {
      const employeeId = dialog?.employeeId;
      if (!employeeId) return;
      const patch = { preferredName: input.preferredName, legalName: input.legalName, reason: input.reason };
      Object.keys(input).forEach((key) => delete input[key]);
      input.employeeId = employeeId;
      input.patch = patch;
    }
    if (operation === "shiftTemplates.create") {
      input.breakMinutes = Number(input.breakMinutes);
      input.effectiveTo = null;
      if (!input.roleLabel) input.roleLabel = null;
    }
    if (operation === "schedules.create") {
      input.breakMinutes = Number(input.breakMinutes);
      input.acknowledgeWarnings = [];
      if (!input.roleLabel) delete input.roleLabel;
    }
    mutationPending = true;
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      await command(operation, operation === "shiftTemplates.create" ? { payload: input } : input);
      dialog = null;
      await load({ force: true });
      if (state.status !== "ready") throw new Error("HR refresh belum terkonfirmasi.");
      notice = operation === "people.create" ? "Staf berhasil dibuat. Terbitkan akses awal dari daftar staf." : operation === "people.update" ? "Data staf berhasil diperbarui." : operation === "shiftTemplates.create" ? "Draft template berhasil dibuat." : "Draft jadwal berhasil disimpan. Terbitkan setelah review.";
    } catch {
      writesLocked = true;
      notice = "Penyimpanan belum terkonfirmasi. Perbarui data untuk memastikan hasilnya; jangan kirim ulang otomatis.";
    } finally {
      mutationPending = false;
      paint();
    }
  }

  async function issueCredential() {
    if (mutationPending || writesLocked || !["credential", "reset"].includes(dialog?.kind)) return;
    const employeeId = dialog.employeeId;
    const isReset = dialog.kind === "reset";
    const reason = root?.querySelector("[data-hr-reset-reason]")?.value?.trim();
    if (isReset && (!reason || reason.length < 10 || reason.length > 255)) { notice = "Alasan reset harus 10–255 karakter."; paint(); return; }
    mutationPending = true;
    paint();
    try {
      const result = await command(isReset ? "people.resetAccess" : "people.credentials", { employeeId, payload: isReset ? { reason } : { expiresInHours: 24 } });
      if (dialog?.employeeId !== employeeId) return;
      if (!result?.data?.temporaryPassword || !result.data.employeeCode || !result.data.organizationSlug || !result.data.expiresAt) throw new Error("Credential tidak lengkap.");
      credential = result.data;
      credentialTimer = setTimeout(() => { clearCredential(); dialog = null; paint(); }, 60_000);
      notice = isReset ? "Akses Staff di-reset; sesi lama dicabut. Bagikan password sementara secara privat." : "Akses awal diterbitkan. Salin dan bagikan secara privat sebelum tampilan tertutup.";
    } catch {
      writesLocked = true;
      notice = "Penerbitan akses belum terkonfirmasi. Periksa status akun; jangan menerbitkan ulang otomatis.";
    } finally {
      mutationPending = false;
      paint();
    }
  }

  async function decide(operation, values, label, confirmedReason = null) {
    if (mutationPending || writesLocked) return;
    const reason = confirmedReason ?? window.prompt(`${label}. Masukkan alasan (10–255 karakter):`);
    if (reason == null) return;
    if (reason.trim().length < 10 || reason.trim().length > 255) { notice = "Alasan harus 10–255 karakter."; paint(); return; }
    const input = operation === "schedules.publish" ? { scheduleId: values.scheduleId, reason: reason.trim() }
      : operation === "shiftTemplates.status" ? { templateId: values.templateId, payload: { action: values.action, reason: reason.trim() } }
      : { swapRequestId: values.swapRequestId, payload: { decision: values.decision, reason: reason.trim() } };
    mutationPending = true;
    paint();
    try {
      const result = await command(operation, input);
      if (operation === "schedules.publish" && (result?.data?.id !== values.scheduleId || result.data.state !== "published")) throw new Error("Penerbitan belum pasti.");
      if (operation === "swaps.review" && (result?.data?.id !== values.swapRequestId || !["applied", "rejected"].includes(result.data.state))) throw new Error("Keputusan belum pasti.");
      await load({ force: true });
      if (state.status !== "ready") throw new Error("HR refresh belum terkonfirmasi.");
      notice = operation === "schedules.publish" ? "Jadwal berhasil diterbitkan." : operation === "shiftTemplates.status" ? "Template shift berhasil diterbitkan." : "Keputusan tukar shift tersimpan.";
    } catch {
      writesLocked = true;
      notice = "Keputusan belum terkonfirmasi. Perbarui data dan periksa histori sebelum mencoba lagi.";
    } finally {
      mutationPending = false;
      paint();
    }
  }

  async function lifecycle(employeeId, action) {
    if (mutationPending || writesLocked || !["suspend_access", "restore_access"].includes(action)) return;
    const person = state.data?.people.find((item) => item.id === employeeId);
    if (!person?.hasLogin) return;
    const reason = window.prompt(`${action === "suspend_access" ? "Tangguhkan" : "Pulihkan"} akses Staff ${person.employeeCode}. Alasan (10–255 karakter):`);
    if (reason == null) return;
    if (reason.trim().length < 10 || reason.trim().length > 255) { notice = "Alasan harus 10–255 karakter."; paint(); return; }
    mutationPending = true;
    paint();
    try {
      await command("people.lifecycle", { employeeId, payload: { action, reason: reason.trim() } });
      await load({ force: true });
      if (state.status !== "ready") throw new Error("Status akses belum terkonfirmasi.");
      notice = action === "suspend_access" ? "Akses Staff ditangguhkan." : "Akses Staff dipulihkan.";
    } catch {
      writesLocked = true;
      notice = "Perubahan akses belum terkonfirmasi. Periksa status akun sebelum mencoba ulang.";
    } finally { mutationPending = false; paint(); }
  }

  async function reviewRequest(workforceRequestId, decision) {
    if (mutationPending || writesLocked || !["approve", "reject"].includes(decision)) return;
    const request = state.data?.requests.find((item) => item.id === workforceRequestId);
    if (!request || !["submitted", "supervisor_approved"].includes(request.state)) return;
    const label = request.state === "supervisor_approved" ? "keputusan final HR" : "review tahap 1";
    const reason = window.prompt(`${decision === "approve" ? "Setujui" : "Tolak"} ${label} untuk ${request.employeeName}. Alasan (10–500 karakter):`);
    if (reason == null) return;
    if (reason.trim().length < 10 || reason.trim().length > 500) { notice = "Alasan harus 10–500 karakter."; paint(); return; }
    const payload = { decision, reason: reason.trim() };
    if (decision === "approve" && request.state === "supervisor_approved" && request.category === "overtime") {
      const minutes = window.prompt(`Menit lembur final (maksimum ${request.requestedMinutes}):`);
      if (minutes == null) return;
      const approvedMinutes = Number(minutes);
      if (!Number.isInteger(approvedMinutes) || approvedMinutes < 1 || approvedMinutes > request.requestedMinutes) { notice = "Menit lembur harus positif dan tidak melebihi pengajuan."; paint(); return; }
      payload.approvedMinutes = approvedMinutes;
    }
    mutationPending = true;
    paint();
    try {
      const result = await command("requests.review", { workforceRequestId, payload });
      if (!result?.data || result.data.id !== workforceRequestId) throw new Error("Hasil review belum pasti.");
      await load({ force: true });
      if (state.status !== "ready") throw new Error("Review belum terkonfirmasi.");
      notice = "Keputusan tersimpan sesuai tahap. Jika masih menunggu tahap kedua, gunakan akun approver lain.";
    } catch {
      writesLocked = true;
      notice = "Keputusan belum terkonfirmasi atau ditolak oleh aturan dua approver/scope. Periksa histori sebelum mencoba ulang.";
    } finally { mutationPending = false; paint(); }
  }

  document.addEventListener("visibilitychange", () => { if (document.hidden) { clearCredential(); if (["credential", "reset"].includes(dialog?.kind)) dialog = null; if (mutationPending) writesLocked = true; paint(); } });
  window.addEventListener("pagehide", () => { clearCredential(); if (mutationPending) writesLocked = true; });
  return { mount, load, reset };
}
