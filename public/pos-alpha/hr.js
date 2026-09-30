const $ = (id) => document.getElementById(id);
let csrf = "";
let busy = false;
let mutationBusy = false;
let schedulingWriteLocked = false;
let credentialEmployee = null;
let credentialTimer;

const viewDefinition = {
  overview: { operation: "people.list", caption: "Tim hari ini", labels: ["Nama staf", "Kode", "Status", "Akses"] },
  people: { operation: "people.list", caption: "Daftar staf", labels: ["Nama staf", "Kode", "Status", "Akses"] },
  workspaces: { operation: "workspaces.list", caption: "Daftar Workspace", labels: ["Workspace", "Zona waktu", "Status"] },
  templates: { operation: "shiftTemplates.list", caption: "Template shift", labels: ["Template", "Workspace", "Jam", "Istirahat", "Status", "Tindakan"] },
  schedules: { operation: "schedules.list", caption: "Jadwal staf", labels: ["Tanggal", "Staf", "Workspace", "Waktu", "Status", "Tindakan"] },
  requests: { operation: "requests.list", caption: "Permohonan staf", labels: ["Pemohon", "Jenis", "Periode", "Status", "Alasan", "Tindak lanjut"] },
  swapReviews: { operation: "swaps.pending", caption: "Review swap menunggu HR", labels: ["Pemohon", "Target", "Shift asal", "Shift target", "Alasan", "Tindakan"] },
  workHours: { operation: "reports.workHours", caption: "Jam kerja payroll-ready", labels: ["Staf", "Periode", "Hadir", "Terlambat", "Belum checkout", "Estimasi payable", "Detail"] },
  payroll: { operation: "payroll.periods", caption: "Periode payroll (hanya baca)", labels: ["Kode", "Periode", "Siklus", "Status", "Versi", "Detail"] },
};

const viewMeta = {
  overview: { title: "Ringkasan Tim", subtitle: "Pantau kondisi dan kebutuhan tim hari ini dalam satu pandangan.", kicker: "Tim hari ini", heading: "Kesiapan operasional", attention: "Lengkapi akses staf dan tinjau permohonan sebelum jam operasional berikutnya." },
  people: { title: "Karyawan", subtitle: "Kelola profil, tarif, akses, dan status tim dari satu tempat.", kicker: "Data tim", heading: "Daftar karyawan", attention: "Periksa profil dan akses yang belum lengkap sebelum jadwal diterbitkan." },
  workspaces: { title: "Lokasi kerja", subtitle: "Pastikan lokasi, zona waktu, dan radius absensi sesuai operasional gerai.", kicker: "Lokasi", heading: "Workspace operasional", attention: "Koordinat dan radius menentukan validasi absensi staf di lapangan." },
  templates: { title: "Template Shift", subtitle: "Standarkan jam kerja agar penyusunan jadwal lebih cepat dan konsisten.", kicker: "Pola kerja", heading: "Template shift", attention: "Terbitkan hanya template yang jam dan waktu istirahatnya sudah diperiksa." },
  schedules: { title: "Jadwal Tim", subtitle: "Atur jadwal mingguan dan tinjau konflik sebelum shift diterbitkan.", kicker: "Periode berjalan", heading: "Jadwal staf", attention: "Draft tetap aman sampai owner menerbitkannya setelah pengecekan." },
  requests: { title: "Permohonan Tim", subtitle: "Tinjau izin, cuti, dan kebutuhan staf tanpa kehilangan konteks jadwal.", kicker: "Kotak masuk", heading: "Permohonan staf", attention: "Keputusan menyimpan alasan agar riwayat persetujuan dapat diaudit." },
  swapReviews: { title: "Tinjau Tukar Shift", subtitle: "Pastikan pertukaran menjaga cakupan peran dan tidak menimbulkan konflik.", kicker: "Persetujuan", heading: "Tukar shift menunggu review", attention: "Setelah disetujui, perubahan jadwal harus terkonfirmasi sebelum aksi berikutnya." },
  workHours: { title: "Absensi Tim", subtitle: "Periksa jam hadir, keterlambatan, dan checkout sebelum rekap gaji.", kicker: "Kehadiran", heading: "Jam kerja payroll-ready", attention: "Selesaikan catatan belum checkout agar estimasi gaji tidak bias." },
  payroll: { title: "Rekap Gaji", subtitle: "Tinjau periode dan kesiapan sumber data sebelum proses payroll berikutnya.", kicker: "Payroll", heading: "Periode penggajian", attention: "Nilai akhir tetap mengikuti snapshot dan aturan payroll HR SagaPOS." },
};

async function api(path, body, signal) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error", signal, ...(body ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status });
  return response.json();
}
async function boundedApi(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try { return await api(path, body, controller.signal); }
  finally { clearTimeout(timer); controller.abort(); }
}
function message(value) { $("status").textContent = value; }
function localDate(offsetDays = 0) { const date = new Date(); date.setDate(date.getDate() + offsetDays); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"); }
function text(value) { return typeof value === "string" && value ? value : "—"; }
function dateTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }); }
function rupiah(value) { return Number.isFinite(value) ? `Rp ${new Intl.NumberFormat("id-ID").format(value)}` : "—"; }
function requestCategory(value) {
  return { annual_leave: "Cuti tahunan", sick: "Sakit", personal_permission: "Izin pribadi", unpaid_leave: "Cuti tanpa upah", overtime: "Lembur", special_leave: "Cuti khusus" }[value] ?? text(value);
}
function isUlid(value) { return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value); }
function clearCredential() { clearTimeout(credentialTimer); $("credential-result").replaceChildren(); credentialEmployee = null; if ($("credential-dialog").open) $("credential-dialog").close(); }
function clearPrivate() { clearCredential(); $("rows").replaceChildren(); $("roles").replaceChildren(); $("summary").textContent = ""; for (const id of ["create-staff", "create-workspace", "create-template", "create-schedule"]) $(id).reset(); $("search").value = ""; $("workspace").hidden = true; }
function failure(error) {
  clearPrivate();
  if ([401, 403].includes(error.status)) { $("login").hidden = false; message("Sesi atau izin tidak tersedia. Masuk kembali melalui Owner Dashboard."); }
  else message("Data belum dapat dimuat. Periksa koneksi lalu muat ulang halaman. Data lama disembunyikan untuk menjaga privasi.");
}
function appendCells(row, values) { for (const value of values) { const cell = document.createElement("td"); cell.textContent = text(value); row.append(cell); } }
function actionButton(label, handler, disabled = false) { const button = document.createElement("button"); button.className = "button button-ghost"; button.type = "button"; button.textContent = label; button.disabled = disabled; button.addEventListener("click", handler); return button; }
function openDetail(kicker, title, sections, callout) {
  $("detail-kicker").textContent = kicker; $("detail-title").textContent = title; $("detail-content").replaceChildren();
  for (const [heading, values] of sections) {
    const section = document.createElement("section"); section.className = "hr-detail-section";
    const h3 = document.createElement("h3"); h3.textContent = heading; const list = document.createElement("dl");
    for (const [label, value] of values) { const term = document.createElement("dt"); term.textContent = label; const description = document.createElement("dd"); description.textContent = text(value); list.append(term, description); }
    section.append(h3, list); $("detail-content").append(section);
  }
  if (callout) { const note = document.createElement("p"); note.className = "hr-detail-callout"; note.textContent = callout; $("detail-content").append(note); }
  if (!$("detail-dialog").open) $("detail-dialog").showModal();
}
async function openPersonDetail(item) {
  openDetail("Detail karyawan", text(item.preferredName), [["Profil", [["Kode staf", item.employeeCode], ["Status", item.status], ["Akses login", item.hasLogin ? "Aktif" : "Belum diterbitkan"]]], ["Data terhubung", [["Status", "Memuat profil terbaru…"]]]], "Tarif dan ketersediaan tidak dibuat dari asumsi. Field tersebut tampil setelah kontrak sumber data tersedia.");
  if (!item.id) return;
  try {
    const { data } = await boundedApi("/api/hr/command", { operation: "people.get", input: { employeeId: item.id } });
    if (!$("detail-dialog").open || data?.id !== item.id) return;
    const placements = Array.isArray(data.workspaceAssignments) ? data.workspaceAssignments.map((entry) => entry.workspaceName).filter(Boolean).join(", ") : "—";
    openDetail("Detail karyawan", text(data.preferredName), [["Profil", [["Nama resmi", data.legalName], ["Kode staf", data.employeeCode], ["Status", data.status], ["Email", data.email], ["Telepon", data.phoneE164]]], ["Penempatan", [["Workspace", placements || "Belum ditempatkan"], ["Akses login", data.hasLogin ? "Aktif" : "Belum diterbitkan"], ["Status akses", data.accessStatus], ["Status akun", data.accountStatus]]], ["Tarif & ketersediaan", [["Tarif efektif", "Kontrak belum tersedia"], ["Ketersediaan", "Kontrak belum tersedia"]]]], "Tarif dan ketersediaan belum tersedia pada kontrak HR native saat ini; UI tidak mengarang angka atau jadwal staf.");
  } catch (error) { if ([401, 403].includes(error.status)) failure(error); else message("Detail profil belum dapat dimuat. Ringkasan daftar tetap ditampilkan."); }
}
function lockSchedulingWrites() {
  schedulingWriteLocked = true;
  for (const button of document.querySelectorAll("[data-scheduling-write]")) button.disabled = true;
}
function validateSwapReview(data, swapRequestId, decision) {
  const value = data?.data;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["id", "state", "scheduleIds"].includes(key)) || value.id !== swapRequestId) throw new Error("uncertain_swap_review");
  if (decision === "reject" && value.state === "rejected" && !Object.hasOwn(value, "scheduleIds")) return { state: "rejected" };
  if (decision === "approve" && value.state === "applied" && Array.isArray(value.scheduleIds) && value.scheduleIds.length >= 1 && value.scheduleIds.length <= 2 && value.scheduleIds.every(isUlid)) return { state: "applied" };
  throw new Error("uncertain_swap_review");
}
function validateRequestReview(data, workforceRequestId, decision) {
  const value = data?.data;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["id", "state", "version"].includes(key)) || value.id !== workforceRequestId) throw new Error("uncertain_request_review");
  if (decision === "reject" && value.state === "rejected") return value;
  if (decision === "approve" && ["approved", "supervisor_approved"].includes(value.state)) return value;
  throw new Error("uncertain_request_review");
}
async function confirmedMutation(operation, input, success) {
  if (mutationBusy) return;
  if (schedulingWriteLocked && ["shiftTemplates.status", "schedules.create", "schedules.publish", "swaps.review", "requests.review"].includes(operation)) { message("Aksi jadwal atau persetujuan dikunci karena hasil sebelumnya belum pasti. Muat ulang halaman sebelum melanjutkan."); return; }
  mutationBusy = true;
  try {
    const result = await boundedApi("/api/hr/command", { operation, input });
    const successMessage = typeof success === "function" ? success(result) : success;
    await load();
    message(successMessage);
  }
  catch (error) {
    if ([401, 403].includes(error.status)) failure(error);
    else {
      if (["shiftTemplates.status", "schedules.create", "schedules.publish", "swaps.review", "requests.review"].includes(operation)) lockSchedulingWrites();
      message("Perubahan belum terkonfirmasi. Aksi jadwal atau persetujuan dikunci; muat ulang halaman dan periksa data terbaru sebelum mencoba lagi.");
    }
  }
  finally { mutationBusy = false; }
}
function reasonFor(label) {
  const reason = window.prompt(`${label}. Masukkan alasan (minimal 10 karakter):`);
  if (reason === null) return null;
  if (reason.trim().length < 10 || reason.trim().length > 255) { message("Alasan harus berisi 10–255 karakter."); return null; }
  return reason.trim();
}
function rowFor(view, item) {
  const row = document.createElement("tr");
  if (["overview", "people"].includes(view)) {
    appendCells(row, [item.preferredName, item.employeeCode, item.status]);
    const cell = document.createElement("td");
    cell.append(actionButton("Detail", () => void openPersonDetail(item)));
    if (item.id && !item.hasLogin) cell.append(actionButton("Akses awal", () => { clearCredential(); credentialEmployee = item.id; $("credential-person").textContent = `${text(item.preferredName)} · ${text(item.employeeCode)}`; $("issue-credential").disabled = false; $("credential-dialog").showModal(); }));
    else if (item.hasLogin) { const access = document.createElement("span"); access.textContent = "Sudah tersedia"; cell.append(access); }
    row.append(cell);
  } else if (view === "workspaces") appendCells(row, [item.name, item.timezone, item.status]);
  else if (view === "templates") {
    appendCells(row, [item.name, item.workspaceName, `${text(item.localStartTime)}–${text(item.localEndTime)}`, Number.isInteger(item.breakMinutes) ? `${item.breakMinutes} menit` : "—", item.status]);
    const cell = document.createElement("td");
    const action = item.status === "draft" ? "publish" : item.status === "active" ? "retire" : null;
    cell.append(actionButton("Detail", () => openDetail("Template shift", text(item.name), [["Jam kerja", [["Workspace", item.workspaceName], ["Mulai", item.localStartTime], ["Selesai", item.localEndTime], ["Istirahat", Number.isInteger(item.breakMinutes) ? `${item.breakMinutes} menit` : "—"]]], ["Status", [["Status template", item.status]]]], "Perubahan template berlaku melalui versi efektif agar jadwal lama tetap dapat diaudit.")));
    if (action && item.id) { const button = actionButton(action === "publish" ? "Terbitkan" : "Pensiunkan", () => { const reason = reasonFor(action === "publish" ? "Terbitkan template" : "Pensiunkan template"); if (reason) void confirmedMutation("shiftTemplates.status", { templateId: item.id, payload: { action, reason } }, "Status template berhasil diperbarui."); }, schedulingWriteLocked); button.dataset.schedulingWrite = "true"; cell.append(button); }
    row.append(cell);
  } else if (view === "schedules") {
    appendCells(row, [item.businessDate, item.employeeName, item.locationName, `${dateTime(item.scheduledStartAt)} – ${dateTime(item.scheduledEndAt)}`, item.state]);
    const cell = document.createElement("td");
    cell.append(actionButton("Detail", () => openDetail("Detail shift", `${text(item.employeeName)} · ${text(item.businessDate)}`, [["Penempatan", [["Karyawan", item.employeeName], ["Workspace", item.locationName], ["Tanggal", item.businessDate]]], ["Waktu", [["Mulai", dateTime(item.scheduledStartAt)], ["Selesai", dateTime(item.scheduledEndAt)], ["Status", item.state]]]], item.state === "draft" ? "Shift masih berupa draft dan belum terlihat sebagai jadwal final staf." : "Shift sudah diterbitkan dari sumber jadwal.")));
    if (item.state === "draft" && item.id) { const button = actionButton("Terbitkan", () => { const reason = reasonFor("Terbitkan jadwal"); if (reason) void confirmedMutation("schedules.publish", { scheduleId: item.id, reason }, "Jadwal berhasil diterbitkan."); }, schedulingWriteLocked); button.dataset.schedulingWrite = "true"; cell.append(button); }
    row.append(cell);
  } else if (view === "requests") {
    appendCells(row, [item.employeeName ?? item.requesterName, requestCategory(item.category), `${dateTime(item.startsAt)} – ${dateTime(item.endsAt)}`, item.state, item.reason]);
    const cell = document.createElement("td");
    cell.append(actionButton("Detail", () => openDetail("Tinjau permohonan", text(item.employeeName ?? item.requesterName), [["Permohonan", [["Jenis", requestCategory(item.category)], ["Status", item.state], ["Mulai", dateTime(item.startsAt)], ["Selesai", dateTime(item.endsAt)]]], ["Alasan", [["Catatan staf", item.reason], ["Tahap persetujuan", Number.isInteger(item.currentApprovalStep) ? `Tahap ${item.currentApprovalStep}` : "Review HR"]]]], "Setiap keputusan memerlukan alasan dan dicatat sebagai audit di sumber HR.")));
    if (item.id && ["submitted", "needs_information", "supervisor_approved"].includes(item.state)) {
      const reject = actionButton("Tolak", () => { const reason = reasonFor("Tolak permohonan staf"); if (reason) void confirmedMutation("requests.review", { workforceRequestId: item.id, payload: { decision: "reject", reason } }, (result) => { validateRequestReview(result, item.id, "reject"); return "Permohonan ditolak dengan audit HR."; }); }, schedulingWriteLocked);
      const approve = actionButton("Setujui", () => { const reason = reasonFor("Setujui permohonan staf"); if (reason) void confirmedMutation("requests.review", { workforceRequestId: item.id, payload: { decision: "approve", reason } }, (result) => { validateRequestReview(result, item.id, "approve"); return "Permohonan disetujui dengan audit HR."; }); }, schedulingWriteLocked);
      reject.dataset.schedulingWrite = "true"; approve.dataset.schedulingWrite = "true";
      cell.append(reject, approve);
    } else {
      const step = Number.isInteger(item.currentApprovalStep) ? `Tahap ${item.currentApprovalStep}` : "Review HR";
      cell.textContent = `${step}. Keputusan final tetap melalui workflow HR SagaPOS.`;
    }
    row.append(cell);
  } else if (view === "swapReviews") {
    appendCells(row, [item.requesterName, item.targetName, `${dateTime(item.sourceStartAt)} – ${dateTime(item.sourceEndAt)}`, `${dateTime(item.targetStartAt)} – ${dateTime(item.targetEndAt)}`, item.reason]);
    const cell = document.createElement("td");
    cell.append(actionButton("Detail", () => openDetail("Tinjau tukar shift", `${text(item.requesterName)} → ${text(item.targetName)}`, [["Shift asal", [["Pemohon", item.requesterName], ["Mulai", dateTime(item.sourceStartAt)], ["Selesai", dateTime(item.sourceEndAt)]]], ["Shift target", [["Karyawan", item.targetName], ["Mulai", dateTime(item.targetStartAt)], ["Selesai", dateTime(item.targetEndAt)]]], ["Konteks", [["Alasan", item.reason]]]], "Persetujuan hanya berhasil setelah HR SagaPOS mengembalikan hasil terkonfirmasi dan jadwal diterapkan.")));
    if (item.id) {
      const reject = actionButton("Tolak", () => { const reason = reasonFor("Tolak swap"); if (reason) void confirmedMutation("swaps.review", { swapRequestId: item.id, payload: { decision: "reject", reason } }, (result) => { const final = validateSwapReview(result, item.id, "reject"); return final.state === "rejected" ? "Swap ditolak dengan audit HR." : "Review swap selesai."; }); }, schedulingWriteLocked);
      const approve = actionButton("Setujui", () => { const reason = reasonFor("Setujui swap"); if (reason) void confirmedMutation("swaps.review", { swapRequestId: item.id, payload: { decision: "approve", reason } }, (result) => { const final = validateSwapReview(result, item.id, "approve"); return final.state === "applied" ? "Swap disetujui dan jadwal diterapkan." : "Review swap selesai."; }); }, schedulingWriteLocked);
      reject.dataset.schedulingWrite = "true"; approve.dataset.schedulingWrite = "true";
      cell.append(reject, approve);
    } else cell.textContent = "—";
    row.append(cell);
  } else if (view === "workHours") {
    appendCells(row, [item.employeeName ?? item.staffName, `${text(item.periodStart)}–${text(item.periodEnd)}`, Number.isInteger(item.presentDays) ? `${item.presentDays} hari` : text(item.present), Number.isInteger(item.lateMinutes) ? `${item.lateMinutes} menit` : text(item.late), Number.isInteger(item.incompleteCheckouts) ? `${item.incompleteCheckouts}` : text(item.incomplete), rupiah(item.estimatedPayableRupiah)]);
    const cell = document.createElement("td"); cell.append(actionButton("Periksa", () => openDetail("Periksa absensi", text(item.employeeName ?? item.staffName), [["Periode", [["Mulai", item.periodStart], ["Selesai", item.periodEnd]]], ["Kehadiran", [["Hari hadir", Number.isInteger(item.presentDays) ? `${item.presentDays} hari` : item.present], ["Terlambat", Number.isInteger(item.lateMinutes) ? `${item.lateMinutes} menit` : item.late], ["Belum checkout", item.incompleteCheckouts], ["Estimasi payable", rupiah(item.estimatedPayableRupiah)]]]], "Estimasi hanya dapat difinalkan setelah pengecualian dan checkout yang belum lengkap diselesaikan."))); row.append(cell);
  } else {
    appendCells(row, [item.code, `${text(item.startsOn)}–${text(item.endsOn)}`, item.cycle, item.state, Number.isInteger(item.version) ? String(item.version) : "—"]);
    const cell = document.createElement("td"); cell.append(actionButton("Detail", () => openDetail("Detail periode gaji", text(item.code), [["Periode", [["Mulai", item.startsOn], ["Selesai", item.endsOn], ["Siklus", item.cycle]]], ["Status", [["Tahap", item.state], ["Versi", item.version]]]], "Nominal final mengikuti snapshot tarif dan komponen payroll HR SagaPOS; halaman ini tidak mengarang nilai yang belum tersedia."))); row.append(cell);
  }
  return row;
}
function currentInput(view) {
  if (["overview", "people"].includes(view)) return { search: $("search").value.trim(), limit: 100 };
  if (view === "schedules" || view === "workHours") return { from: $("from").value, to: $("to").value };
  return {};
}
function updateMetrics(view, data) {
  const active = data.filter((item) => ["active", "approved", "published", "open"].includes(item.status ?? item.state)).length;
  const pending = data.filter((item) => ["draft", "submitted", "needs_information", "supervisor_approved"].includes(item.status ?? item.state)).length;
  const complete = data.length ? Math.round((data.filter((item) => item.id || item.employeeCode || item.code).length / data.length) * 100) : 0;
  const metricSets = {
    overview: [["Dijadwalkan", data.length, "Tim terdaftar"], ["Status aktif", active, "Siap operasional"], ["Akses belum dibuat", data.filter((item) => !item.hasLogin).length, "Perlu tindakan"], ["Kesiapan data", `${complete}%`, "Identitas terbaca"]],
    people: [["Total karyawan", data.length, "Dalam akses Anda"], ["Status aktif", active, "Siap dijadwalkan"], ["Akses belum dibuat", data.filter((item) => !item.hasLogin).length, "Perlu akses awal"], ["Kesiapan data", `${complete}%`, "Identitas terbaca"]],
    schedules: [["Total shift", data.length, "Rentang terpilih"], ["Sudah terbit", active, "Terlihat staf"], ["Masih draft", pending, "Perlu ditinjau"], ["Kesiapan jadwal", `${data.length ? Math.round((active / data.length) * 100) : 0}%`, "Berdasarkan status"]],
    requests: [["Total permohonan", data.length, "Dalam kotak masuk"], ["Selesai", active, "Sudah diputuskan"], ["Menunggu", pending, "Perlu keputusan"], ["Kelengkapan", `${complete}%`, "Referensi tersedia"]],
    swapReviews: [["Tukar shift", data.length, "Menunggu review"], ["Terkonfirmasi", active, "Sudah diterapkan"], ["Perlu ditinjau", data.length - active, "Belum diputuskan"], ["Kelengkapan", `${complete}%`, "Referensi tersedia"]],
    workHours: [["Karyawan", data.length, "Dalam rekap"], ["Hadir", data.reduce((sum, item) => sum + (Number(item.presentDays) || 0), 0), "Hari tercatat"], ["Belum checkout", data.reduce((sum, item) => sum + (Number(item.incompleteCheckouts) || 0), 0), "Perlu koreksi"], ["Kesiapan data", `${complete}%`, "Sumber terhubung"]],
    payroll: [["Periode", data.length, "Tersedia"], ["Periode aktif", active, "Siap diproses"], ["Draft / review", pending, "Belum dikunci"], ["Kesiapan data", `${complete}%`, "Referensi tersedia"]],
    templates: [["Template", data.length, "Tersedia"], ["Aktif", active, "Bisa dipakai"], ["Draft", pending, "Perlu diterbitkan"], ["Kesiapan", `${complete}%`, "Referensi tersedia"]],
    workspaces: [["Workspace", data.length, "Dalam organisasi"], ["Aktif", active, "Bisa dipakai"], ["Tidak aktif", data.length - active, "Perlu ditinjau"], ["Kesiapan", `${complete}%`, "Referensi tersedia"]],
  };
  const values = metricSets[view] ?? metricSets.people;
  values.forEach(([label, value, note], index) => { const n = index + 1; $(`metric-label-${n}`).textContent = label; $(`metric-value-${n}`).textContent = String(value); $(`metric-note-${n}`).textContent = note; });
  if (view === "requests") { $("request-badge").textContent = String(pending); $("request-badge").hidden = pending === 0; }
}
async function load() {
  if (busy) return;
  busy = true; $("rows").replaceChildren(); message("Memuat data terbaru…");
  try {
    const view = $("view").value; const definition = viewDefinition[view];
    const { data } = await api("/api/hr/command", { operation: definition.operation, input: currentInput(view) });
    if (!Array.isArray(data)) throw new Error("unexpected_response");
    const header = document.createElement("tr");
    for (const label of definition.labels) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = label; header.append(cell); }
    $("head").replaceChildren(header); for (const item of data) $("rows").append(rowFor(view, item));
    $("caption").textContent = definition.caption;
    $("summary").textContent = data.length ? `${data.length} hasil${["overview", "people"].includes(view) && data.length === 100 ? " · Maksimal 100; gunakan pencarian untuk mempersempit hasil" : ""}.` : "Belum ada data yang sesuai akses atau rentang ini.";
    $("empty-state").hidden = data.length !== 0;
    $("head").parentElement.hidden = data.length === 0;
    updateMetrics(view, data);
    message("Data terbaru berhasil dimuat.");
  } catch (error) { failure(error); } finally { busy = false; }
}
function fillOptions(select, rows, label) {
  select.replaceChildren(); const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = label; select.append(placeholder);
  for (const item of rows) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name ?? `${item.preferredName} · ${item.employeeCode}`; select.append(option); }
}
async function loadOptions() {
  const [{ data: workspaces }, { data: scheduling }] = await Promise.all([
    api("/api/hr/command", { operation: "workspaces.list", input: {} }), api("/api/hr/command", { operation: "schedules.options", input: {} }),
  ]);
  if (!Array.isArray(workspaces) || !Array.isArray(scheduling?.locations) || !Array.isArray(scheduling?.employees)) throw new Error("unexpected_response");
  const active = workspaces.filter((item) => item.status === "active");
  fillOptions($("staff-workspace"), active, "Pilih Workspace aktif"); fillOptions($("template-workspace"), active, "Pilih Workspace aktif");
  fillOptions($("schedule-workspace"), scheduling.locations, "Pilih Workspace"); fillOptions($("schedule-employee"), scheduling.employees, "Pilih staf");
}
function updateView() {
  const view = $("view").value; $("search-label").hidden = !["overview", "people"].includes(view); $("from-label").hidden = !["schedules", "workHours"].includes(view); $("to-label").hidden = !["schedules", "workHours"].includes(view);
  for (const tool of document.querySelectorAll("[data-tool]")) tool.hidden = tool.dataset.tool !== view;
  const meta = viewMeta[view] ?? viewMeta.people;
  $("page-title").textContent = meta.title; $("page-subtitle").textContent = meta.subtitle; $("section-kicker").textContent = meta.kicker; $("caption-heading").textContent = meta.heading; $("attention-copy").textContent = meta.attention;
  const navButtons = [...document.querySelectorAll("[data-view-target]")];
  navButtons.forEach((button) => { const active = button.dataset.viewTarget === view; if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  const url = new URL(location.href); if (view === "overview") url.searchParams.delete("view"); else url.searchParams.set("view", view); history.replaceState(null, "", url);
}
async function submitForm(form, operation, buildInput, success) {
  if (mutationBusy) return; if (schedulingWriteLocked && ["shiftTemplates.create", "schedules.create"].includes(operation)) { message("Aksi jadwal dikunci karena hasil sebelumnya belum pasti. Muat ulang halaman sebelum melanjutkan."); return; }
  mutationBusy = true; const button = form.querySelector("button"); button.disabled = true;
  try { await boundedApi("/api/hr/command", { operation, input: buildInput(Object.fromEntries(new FormData(form))) }); form.reset(); if (form.id === "create-template") $("template-effective").value = localDate(); if (form.id === "create-schedule") $("schedule-date").value = localDate(); await loadOptions(); await load(); message(success); }
  catch (error) { if ([401, 403].includes(error.status)) failure(error); else { if (["shiftTemplates.create", "schedules.create"].includes(operation)) lockSchedulingWrites(); message("Penyimpanan belum terkonfirmasi. Aksi jadwal dikunci; muat ulang halaman dan periksa data terbaru sebelum mengirim ulang."); } }
  finally { mutationBusy = false; button.disabled = schedulingWriteLocked && ["shiftTemplates.create", "schedules.create"].includes(operation); }
}
$("create-workspace").addEventListener("submit", (event) => { event.preventDefault(); void submitForm(event.currentTarget, "locations.create", (input) => ({ ...input, latitude: Number(input.latitude), longitude: Number(input.longitude), radiusM: Number(input.radiusM), status: "active" }), "Workspace berhasil disimpan."); });
$("create-staff").addEventListener("submit", (event) => { event.preventDefault(); void submitForm(event.currentTarget, "people.create", (input) => input, "Staf berhasil disimpan. Akses login diterbitkan terpisah."); });
$("create-template").addEventListener("submit", (event) => { event.preventDefault(); void submitForm(event.currentTarget, "shiftTemplates.create", (raw) => { const payload = { ...raw, breakMinutes: Number(raw.breakMinutes) }; if (!payload.roleLabel) delete payload.roleLabel; return { payload }; }, "Template draft berhasil disimpan."); });
$("create-schedule").addEventListener("submit", (event) => { event.preventDefault(); void submitForm(event.currentTarget, "schedules.create", (input) => { input.breakMinutes = Number(input.breakMinutes); input.acknowledgeWarnings = []; if (!input.roleLabel) delete input.roleLabel; return input; }, "Jadwal draft berhasil disimpan."); });
$("close-credential").addEventListener("click", clearCredential);
$("credential-dialog").addEventListener("cancel", clearCredential);
$("close-detail").addEventListener("click", () => $("detail-dialog").close());
$("detail-dialog").addEventListener("cancel", () => $("detail-dialog").close());
document.addEventListener("visibilitychange", () => { if (document.hidden) { clearCredential(); if (mutationBusy) { lockSchedulingWrites(); message("Halaman berpindah saat perubahan jadwal diproses. Aksi jadwal dikunci sampai halaman dimuat ulang."); } } });
window.addEventListener("pagehide", () => { if (mutationBusy) lockSchedulingWrites(); });
$("issue-credential").addEventListener("click", async () => {
  if (!credentialEmployee || mutationBusy) return;
  const employeeId = credentialEmployee; mutationBusy = true; $("issue-credential").disabled = true;
  try {
    const { data } = await api("/api/hr/command", { operation: "people.credentials", input: { employeeId, payload: { expiresInHours: 24 } } });
    if (credentialEmployee !== employeeId || !$("credential-dialog").open) return;
    for (const [label, value] of [["Organisasi", data.organizationSlug], ["Kode staf", data.employeeCode], ["Kata sandi sementara", data.temporaryPassword], ["Berlaku sampai", data.expiresAt]]) { const paragraph = document.createElement("p"); paragraph.textContent = `${label}: ${value}`; $("credential-result").append(paragraph); }
    credentialTimer = setTimeout(clearCredential, 60000);
  } catch { $("credential-result").textContent = "Penerbitan belum terkonfirmasi. Periksa status akun; jangan menerbitkan ulang otomatis."; }
  finally { mutationBusy = false; }
});
$("connect").addEventListener("click", async () => { $("connect").disabled = true; try { const result = await api("/api/hrpos/start", { role: "hr" }); location.assign(result.redirectUrl); } catch { message("Login belum dapat dimulai. Silakan coba lagi."); $("connect").disabled = false; } });
$("view").addEventListener("change", updateView);
$("filter").addEventListener("submit", (event) => { event.preventDefault(); void load(); });
for (const button of document.querySelectorAll("[data-view-target], [data-jump-view]")) button.addEventListener("click", () => {
  const target = button.dataset.viewTarget ?? button.dataset.jumpView;
  if (!viewDefinition[target]) return;
  $("view").value = target; updateView(); void load();
});
for (const button of document.querySelectorAll("[data-open-tool]")) button.addEventListener("click", () => {
  const view = $("view").value;
  const tool = document.querySelector(`[data-tool="${view}"]`);
  if (!tool) { message("Penambahan untuk tampilan ini mengikuti alur review HR SagaPOS."); return; }
  tool.open = true; tool.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  tool.querySelector("input, select")?.focus({ preventScroll: true });
});
$("logout").addEventListener("click", async () => { clearPrivate(); try { await api("/api/operator/logout", {}); location.replace("/hr"); } catch { message("Data disembunyikan, tetapi keluar belum terkonfirmasi. Coba tombol Keluar kembali."); } });
async function start() {
  $("from").value = localDate(-7); $("to").value = localDate(14); $("template-effective").value = localDate(); $("schedule-date").value = localDate();
  const requestedView = new URL(location.href).searchParams.get("view");
  if (viewDefinition[requestedView]) $("view").value = requestedView;
  updateView();
  $("connect").hidden = Boolean(document.body.dataset.production);
  try {
    const config = await api("/api/hrpos/config"); if (!config.enabled) { message("Integrasi HR belum diaktifkan di environment ini."); return; }
    $("login").hidden = false; const state = await api("/api/hr/state"); csrf = state.csrfToken; $("login").hidden = true; $("workspace").hidden = false; $("logout").hidden = false;
    if (state.singleOwnerSession) message("Terhubung otomatis melalui sesi Owner SagaPOS. Tidak ada login HR kedua.");
    if (!state.singleOwnerSession) for (const role of state.actor.roles.filter((role) => role !== "hr")) { const button = actionButton(`Buka ${{ owner: "Dashboard", cashier: "Kasir", bar: "KDS" }[role]}`, async () => { button.disabled = true; try { const result = await api("/api/hrpos/role", { role }); location.assign(result.redirectUrl); } catch (error) { failure(error); button.disabled = false; } }); $("roles").append(button); }
    await Promise.all([load(), loadOptions()]);
  } catch (error) { failure(error); }
}
void start();
