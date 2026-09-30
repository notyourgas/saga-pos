export const PHASE4_WORKFORCE_READINESS_VERSION = 1;

export function buildPhase4WorkforceReadiness({ staffState = null, attendanceHealth = null, portal = {}, generatedAt = new Date().toISOString() } = {}) {
  const state = object(staffState);
  const staff = array(state.staff);
  const activeStaff = staff.filter((item) => lower(item?.status) === "active");
  const loginReadyStaff = activeStaff.filter((item) => ["active", "temporary"].includes(lower(item?.accountState)));
  const activeTemplates = array(state.shiftTemplates).filter((item) => lower(item?.state) === "active");
  const periods = array(state.rosterPeriods);
  const assignments = array(state.rosterAssignments);
  const publishedPeriods = periods.filter((item) => lower(item?.status) === "published" && nonEmpty(item?.publishedAt));
  const publishedPeriodIds = new Set(publishedPeriods.map((item) => String(item.id)));
  const publishedAssignments = assignments.filter((item) => nonEmpty(item?.publishedScheduleId) && publishedPeriodIds.has(String(item?.periodId)));
  const policy = object(state.attendancePolicy);
  const health = object(attendanceHealth);
  const healthPolicy = object(health.policy);
  const coordinatesConfigured = healthPolicy.coordinatesConfigured === true
    || (finiteCoordinate(policy.outletLatitude, -90, 90) && finiteCoordinate(policy.outletLongitude, -180, 180));
  const attendancePolicyReady = lower(healthPolicy.enforcementState || policy.enforcementState) === "active"
    && coordinatesConfigured
    && (healthPolicy.gpsRequired ?? policy.gpsRequired) === true
    && (healthPolicy.selfieRequired ?? policy.selfieRequired) === true;
  const requestCategories = array(portal.requestCategories).map(lower).filter(Boolean);
  const requestFlowReady = ["leave", "permission", "sick", "overtime", "shift_swap"].every((category) => requestCategories.includes(category));
  const canonicalPortalReady = portal.pwa === true && portal.canonicalPath === "/login/staff";
  const attendance = array(state.attendance);
  const requests = array(state.requests);
  const pilotEvidenceReady = publishedAssignments.length > 0 && attendance.length > 0 && requests.some((item) => ["approved", "rejected"].includes(lower(item?.state)));

  const checks = [
    check("staff-accounts", "Akun staf aktif dapat login", activeStaff.length > 0 && loginReadyStaff.length === activeStaff.length, `${loginReadyStaff.length}/${activeStaff.length} akun staf aktif siap`),
    check("shift-templates", "Template shift operasional tersedia", activeTemplates.length >= 2, `${activeTemplates.length} template shift aktif`),
    check("published-roster", "Roster pernah dipublikasikan", publishedPeriods.length > 0 && publishedAssignments.length > 0, `${publishedAssignments.length} jadwal dari ${publishedPeriods.length} periode terbit`),
    check("request-flow", "Pengajuan dan approval staf lengkap", requestFlowReady, requestFlowReady ? "Izin, sakit, lembur, dan tukar shift tersedia" : "Kategori pengajuan belum lengkap"),
    check("attendance-policy", "Absensi mewajibkan GPS dan foto wajah", attendancePolicyReady, attendancePolicyReady ? "Lokasi outlet, GPS, dan selfie aktif" : "Kebijakan atau titik outlet belum lengkap"),
    check("attendance-runtime", "Penyimpanan bukti absensi sehat", health.ready === true && health.operationalReady === true, health.ready === true ? `Runtime ${health.operationalReady === true ? "operasional" : "belum operasional"}` : "Storage bukti belum siap"),
    check("staff-portal", "Staff Portal PWA memakai URL kanonik", canonicalPortalReady, canonicalPortalReady ? "/login/staff · PWA mobile-first" : "URL atau PWA Staff Portal belum siap"),
    check("pilot-evidence", "Siklus staf pernah diuji end-to-end", pilotEvidenceReady, pilotEvidenceReady ? "Roster, absensi, dan keputusan approval memiliki bukti" : "Belum ada bukti lengkap roster → absensi → approval"),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  return {
    version: PHASE4_WORKFORCE_READINESS_VERSION,
    phase: "PHASE_4_WORKFORCE_STAFF_PORTAL",
    state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    generatedAt,
    note: "Kesiapan Phase 4 dihitung dari akun staf, template shift, roster terbit, kebijakan dan storage absensi, Staff Portal PWA, serta bukti siklus operasional. Data pribadi tidak disertakan.",
    checks,
  };
}

function check(id, label, complete, detail) { return { id, label, complete: complete === true, detail: String(detail ?? "") }; }
function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function lower(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function nonEmpty(value) { return typeof value === "string" ? value.trim().length > 0 : value != null; }
function finiteCoordinate(value, min, max) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= min && parsed <= max; }
