const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const content = document.querySelector("#page-content");
const globalStatus = document.querySelector("#global-status");
const pageTitle = document.querySelector("#page-title");

let snapshot = null;
let csrfToken = null;
let route = "overview";
let lastResult = null;

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "";
  const body = Object.fromEntries(new FormData(loginForm));
  try {
    await request("/api/login", { method: "POST", body });
    loginForm.reset();
    loginForm.elements.organizationSlug.value = "kopi-saga";
    await refresh();
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await request("/api/logout", { method: "POST", csrf: true }); } finally { showLogin(); }
});

document.querySelector(".tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-route]");
  if (!button) return;
  route = button.dataset.route;
  render();
  content.focus?.();
});

content.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  let payload = {};
  if (action === "feature.toggle") payload = { name: button.dataset.name, enabled: button.dataset.enabled === "true" };
  if (action === "integration.probe") payload = { name: button.dataset.name };
  await runAction(button, action, payload);
});

content.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;
  event.preventDefault();
  await runAction(form.querySelector("button[type='submit']"), form.dataset.action, Object.fromEntries(new FormData(form)));
});

boot();

async function boot() {
  try { await refresh(); } catch { showLogin(); }
}

async function refresh() {
  const state = await request("/api/state");
  csrfToken = state.csrfToken;
  delete state.csrfToken;
  snapshot = state;
  loginView.hidden = true;
  appView.hidden = false;
  document.querySelector("#actor-badge").textContent = snapshot.actor.roleLabel;
  document.querySelector("#outlet-badge").textContent = snapshot.context.outlet;
  render();
}

function showLogin() {
  snapshot = null;
  csrfToken = null;
  appView.hidden = true;
  loginView.hidden = false;
  loginForm.elements.employeeId.focus();
}

async function runAction(control, action, payload) {
  const original = control?.textContent;
  if (control) { control.disabled = true; control.textContent = "Memproses…"; }
  try {
    const response = await request("/api/actions", { method: "POST", csrf: true, body: { action, payload } });
    lastResult = { action, result: response.result };
    toast(`${labelAction(action)} selesai.`);
    await refresh();
  } catch (error) {
    lastResult = { action, error: error.code, message: error.message };
    toast(error.message, true);
    render();
  } finally {
    if (control?.isConnected) { control.disabled = false; control.textContent = original; }
  }
}

function render() {
  if (!snapshot) return;
  document.querySelectorAll("[data-route]").forEach((button) => button.setAttribute("aria-current", button.dataset.route === route ? "page" : "false"));
  const labels = { overview: "Ringkasan UAT", shift: "Shift & Closing", pos: "POS & Member", controls: "Kontrol & Keamanan", evidence: "Bukti Sesi" };
  pageTitle.textContent = labels[route];
  content.innerHTML = ({ overview: overviewView, shift: shiftView, pos: posView, controls: controlsView, evidence: evidenceView })[route]();
}

function overviewView() {
  const owner = snapshot.actor.role === "owner";
  return `
    <div class="page-intro"><div><p class="eyebrow">Konteks yang berwenang</p><h2>${e(snapshot.actor.displayName)} · ${e(snapshot.actor.roleLabel)}</h2><p>Role dan outlet berasal dari sesi server.</p></div><span class="badge success">READY · LOCAL ONLY</span></div>
    <div class="grid">
      <article class="card"><p class="meta">Penjualan fixture</p><p class="metric">${rupiah(snapshot.dashboard.netSalesRupiah)}</p><p class="muted">${snapshot.dashboard.totalOrders} order · sumber ${e(snapshot.dashboard.source)}</p></article>
      <article class="card"><p class="meta">Shift aktif</p><p class="metric">${snapshot.shift ? e(snapshot.shift.status.toUpperCase()) : "TUTUP"}</p><p class="muted">${snapshot.shift ? (snapshot.shift.ownedByCurrentSession ? "Milik sesi ini" : "Milik sesi lain") : "Belum ada kas aktif"}</p></article>
      <article class="card"><p class="meta">Member fixture</p><p class="metric">${snapshot.member.pointsBalance} P</p><p class="muted">${snapshot.member.xpBalance} XP · ${e(snapshot.member.tier)}</p></article>
      <article class="card wide"><h3>Perangkat dan outlet</h3><dl class="boundary-list"><div><dt>Device</dt><dd>${e(snapshot.context.deviceLabel)} · ${e(snapshot.context.deviceId)}</dd></div><div><dt>Outlet</dt><dd>${e(snapshot.context.outlet)}</dd></div><div><dt>Mode</dt><dd>${e(snapshot.context.mode)}</dd></div></dl><div class="status-row"><span class="badge warning">NFC NOT RUN</span><span class="badge warning">Printer NOT RUN</span><span class="badge neutral">Gateway simulator</span></div></article>
      <article class="card"><h3>Probe keamanan</h3><p class="muted">Akses outlet lain harus ditolak tanpa mengembalikan data.</p><div class="actions"><button class="button secondary" data-action="probe.cross_outlet">Uji cross-outlet</button>${owner ? '<button class="button danger" data-action="scenario.reset">Reset fixture</button>' : ''}</div></article>
      ${resultBlock()}
    </div>`;
}

function shiftView() {
  const expected = Number(snapshot.shift?.currentExpectedCashRupiah ?? 300000);
  return `
    <div class="page-intro"><div><p class="eyebrow">Kas & ownership</p><h2>${snapshot.shift ? "Shift sedang aktif" : "Belum ada shift aktif"}</h2><p>STAFF hanya dapat mengubah shift miliknya; OWNER dapat mengawasi dan menutup.</p></div></div>
    <div class="grid">
      <article class="card wide"><h3>Status shift</h3>${snapshot.shift ? `<p class="metric">${e(snapshot.shift.shiftName)}</p><p class="muted">Dibuka oleh ${e(snapshot.shift.openedByUserId)} · kas awal ${rupiah(snapshot.shift.openingCashRupiah)}</p>` : '<div class="empty">Buka shift untuk menjalankan checkout.</div>'}
        ${snapshot.shift ? "" : `<form class="form-grid" data-action="shift.open"><label>Nama shift<input name="shiftName" value="Pilot ${e(snapshot.actor.roleLabel)}" required></label><label>Kas awal<input name="openingCashRupiah" type="number" min="0" step="1000" value="300000" required></label><div class="full"><button class="button primary" type="submit">Buka shift</button></div></form>`}
      </article>
      <article class="card"><h3>Ownership probe</h3><p class="muted">Khusus STAFF: mencoba shift persona lain harus DENIED.</p><button class="button secondary" data-action="probe.other_shift" ${snapshot.actor.role === "owner" ? "disabled" : ""}>Uji shift staff lain</button></article>
      <article class="card full"><h3>Tutup shift</h3><p class="muted">Masukkan selisih material tanpa alasan untuk melihat blocker, lalu isi alasan dan ulangi.</p>
        <form class="form-grid" data-action="shift.close"><label>Kas aktual<input name="actualCashRupiah" type="number" min="0" step="1000" value="${expected + 15000}" required></label><label>Kas ditinggalkan<input name="cashToLeaveRupiah" type="number" min="0" step="1000" value="300000" required></label><label class="full">Alasan selisih<textarea name="note" placeholder="Kosongkan pada percobaan pertama"></textarea></label><div class="full"><button class="button primary" type="submit" ${snapshot.shift ? "" : "disabled"}>Tutup shift</button></div></form>
      </article>
      ${resultBlock()}
    </div>`;
}

function posView() {
  if (snapshot.actor.roleLabel === "STAFF-01") return staffOnePos();
  if (snapshot.actor.roleLabel === "STAFF-02") return staffTwoPos();
  return `<div class="callout">OWNER menggunakan halaman ini untuk meninjau hasil. Jalankan checkout dari profil STAFF-01 dan STAFF-02 yang terisolasi.</div><div class="grid"><article class="card"><p class="meta">Order fixture</p><p class="metric">${snapshot.orders.length}</p></article><article class="card"><p class="meta">Points / XP</p><p class="metric">${snapshot.member.pointsBalance} / ${snapshot.member.xpBalance}</p></article>${resultBlock()}</div>`;
}

function staffOnePos() {
  return `<div class="page-intro"><div><p class="eyebrow">STAFF-01 · Cash</p><h2>Member Code dan checkout idempotent</h2><p>${e(snapshot.member.codeMasked)} · ${e(snapshot.member.benefit)}</p></div></div><div class="grid">
    <article class="card wide"><h3>Cash checkout</h3><p class="muted">2 × Saga Latte, Voyager 10%, receipt browser fallback, Points dan XP.</p><div class="actions"><button class="button primary" data-action="checkout.cash" ${snapshot.shift ? "" : "disabled"}>Bayar cash</button><button class="button secondary" data-action="checkout.replay">Ulangi idempotency key</button><button class="button secondary" data-action="payment.recover">Pulihkan payment</button></div></article>
    <article class="card"><p class="meta">Order terlihat</p><p class="metric">${snapshot.orders.length}</p><p class="muted">Hanya order STAFF-01.</p></article>${resultBlock()}</div>`;
}

function staffTwoPos() {
  const status = snapshot.gatewayPayment?.status ?? "BELUM ADA";
  return `<div class="page-intro"><div><p class="eyebrow">STAFF-02 · QRIS</p><h2>Simulator, refund, dan recovery</h2><p>Tidak ada QRIS nyata atau mutasi eksternal.</p></div><span class="badge neutral">${e(status)}</span></div><div class="grid">
    <article class="card wide"><h3>QRIS lifecycle</h3><div class="actions"><button class="button primary" data-action="payment.qris.create" ${snapshot.shift ? "" : "disabled"}>Buat QRIS pending</button><button class="button secondary" data-action="payment.qris.paid">Simulasikan paid</button><button class="button secondary" data-action="payment.recover">Resume setelah reload</button><button class="button danger" data-action="payment.qris.refund">Simulasikan refund</button></div></article>
    <article class="card"><h3>Reward failure</h3><p class="muted">Reservasi harus RELEASED bila persistence checkout gagal.</p><button class="button secondary" data-action="reward.force_failure" ${snapshot.shift ? "" : "disabled"}>Paksa gagal & release</button></article>
    <article class="card"><p class="meta">Order terlihat</p><p class="metric">${snapshot.orders.length}</p><p class="muted">Data STAFF-01 tidak ikut tampil.</p></article>${resultBlock()}</div>`;
}

function controlsView() {
  const owner = snapshot.actor.role === "owner";
  if (!owner) return `<div class="callout">Kontrol sensitif hanya tersedia untuk OWNER. Gunakan probe cross-outlet dan shift untuk memverifikasi fail-closed.</div><div class="grid"><article class="card"><button class="button secondary" data-action="probe.cross_outlet">Uji cross-outlet</button></article>${resultBlock()}</div>`;
  return `<div class="page-intro"><div><p class="eyebrow">OWNER · Step-up</p><h2>Approval dan optional-off</h2><p>Maker STAFF-01 harus berbeda dari checker OWNER.</p></div></div><div class="grid">
    <article class="card wide"><h3>Reward approval</h3><form class="form-grid" data-action="approval.reward"><label>PIN approval sementara<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><div class="full"><button class="button primary" type="submit">Approve sebagai OWNER</button></div></form></article>
    ${Object.entries(snapshot.featureFlags).map(([name, enabled]) => `<article class="card"><h3>${e(featureLabel(name))}</h3><p class="metric">${enabled ? "ON" : "OFF"}</p><div class="actions"><button class="button ${enabled ? "danger" : "secondary"}" data-action="feature.toggle" data-name="${e(name)}" data-enabled="${enabled ? "false" : "true"}">${enabled ? "Matikan" : "Aktifkan"}</button><button class="button ghost" data-action="integration.probe" data-name="${e(name)}">Uji fallback</button></div></article>`).join("")}
    <article class="card full"><h3>Reconciliation</h3><div class="status-row">${Object.entries(snapshot.reconciliation).map(([key, value]) => `<span class="badge neutral">${e(key)}: ${e(value)}</span>`).join("")}</div><button class="button secondary" data-action="closing.reconcile">Jalankan rekonsiliasi</button></article>${resultBlock()}</div>`;
}

function evidenceView() {
  const events = snapshot.events;
  return `<div class="page-intro"><div><p class="eyebrow">Audit lokal</p><h2>${events.length} event terlihat untuk sesi ini</h2><p>Event ini berisi fixture dan tidak membuktikan produksi.</p></div></div>${events.length ? `<ol class="event-list">${events.map((event) => `<li class="event"><time>${e(formatTime(event.occurredAt))}</time><code>${e(event.type)}</code><span><strong>${e(event.actorLabel)}</strong> · ${e(event.message)}</span></li>`).join("")}</ol>` : '<div class="empty">Belum ada event untuk profil ini.</div>'}${resultBlock()}`;
}

function resultBlock() {
  if (!lastResult) return "";
  return `<article class="card full"><h3>Hasil tindakan terakhir</h3><div class="result">${e(JSON.stringify(lastResult, null, 2))}</div></article>`;
}

async function request(url, { method = "GET", body, csrf = false } = {}) {
  const response = await fetch(url, { method, credentials: "same-origin", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || "Permintaan gagal.");
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function toast(message, danger = false) {
  globalStatus.textContent = message;
  globalStatus.style.background = danger ? "#9f2f2a" : "#261c16";
  globalStatus.hidden = false;
  window.setTimeout(() => { globalStatus.hidden = true; }, 3200);
}

function labelAction(action) { return ({ "shift.open": "Buka shift", "shift.close": "Tutup shift", "checkout.cash": "Cash checkout", "checkout.replay": "Idempotency replay", "payment.qris.create": "QRIS pending", "payment.qris.paid": "QRIS paid", "payment.qris.refund": "QRIS refund", "reward.force_failure": "Reward release", "approval.reward": "Reward approval", "probe.cross_outlet": "Cross-outlet probe", "probe.other_shift": "Other-shift probe", "scenario.reset": "Reset fixture", "closing.reconcile": "Reconciliation" })[action] || action; }
function featureLabel(name) { return ({ reward: "Reward", sagaBook: "Saga Book", push: "Push notification" })[name] || name; }
function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function formatTime(value) { return new Intl.DateTimeFormat("id-ID", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Jakarta" }).format(new Date(value)); }
function e(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
