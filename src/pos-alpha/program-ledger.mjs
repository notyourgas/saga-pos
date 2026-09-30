export const WAVE_TITLES = Object.freeze([
  "Program Authority & Scope Lock", "Canonical Source & Delivery Governance", "Product Metrics & Pilot Contract",
  "UX Architecture & Design System", "Platform, Outlet & Device Foundation", "Identity, Session & Permission",
  "Catalog, Modifier & Availability", "Pricing, Tax, Service & Promotion", "Member, Tier & Reward Integration",
  "Cart, Order & Idempotency", "Stock, Availability & Contention", "Cash Payment & Shift Accountability",
  "SagaDev Gateway Dynamic QRIS & Payment Recovery", "Bar/Kitchen Digital Fulfillment", "Nota Checker & Printing",
  "Assisted Cashier Operational App", "Customer Self-Service Kiosk", "Kiosk Safety & Physical Device Policy",
  "POS Admin Web & Owner Dashboard", "Finance, Reports & Reconciliation", "Security, Privacy & Abuse Resistance",
  "Installed Runtime, Updates & Recovery", "Observability, Backup & Incident Operations", "Staging, Hardware UAT, Pilot & Activation",
]);

const BATCH_TITLES = Object.freeze([
  "Product charter", "Physical operating model", "Product authority map", "Status and evidence vocabulary", "RACI and decision authority",
  "SagaOPS baseline freeze", "POS client repository decision", "Admin Web placement", "CI and merge controls", "Release provenance model",
  "Pilot scope", "Pilot duration and volume", "Success metrics", "Stop conditions", "Evidence and retention",
  "Cross-surface journey", "Operational design tokens", "Shared state language", "Responsive rules", "Accessibility baseline",
  "Organization/business/outlet model", "Device registry", "Device credential lifecycle", "Device heartbeat", "Feature/capability manifest",
  "Staff authentication", "Kiosk guest session", "Server-assigned mode", "Step-up and dual control", "Session recovery and logout",
  "Category/product lifecycle", "Variant model", "Modifier groups", "Channel availability", "Catalog read API/cache",
  "Money and rounding", "Tax/service configuration", "Promotion types", "Eligibility and stacking", "Price quote API",
  "Member Code resolution", "NFC optional adapter", "Tier benefit quote", "Reward reserve/commit/release", "Qualified commerce outbox",
  "Ephemeral cart", "Checkout/order creation", "Idempotency model", "Order lifecycle", "Order lookup and history",
  "Tracked/untracked stock", "Reservation and release", "Last-stock contention", "Final deduction and reversal", "Sold-out operations",
  "Open shift", "Cash tender", "Cash movements", "Blind close", "Handover and daily close",
  "SagaDev Gateway product contract", "SagaDev QRIS intent and display", "Signed gateway event convergence", "Crash and restart recovery", "Refund and settlement",
  "Station routing", "Paid fulfillment creation", "KDS queue UX", "Production state", "Remake and exception",
  "Print job model", "Nota checker layout", "Printer adapter", "Retry and ambiguity", "Reprint audit",
  "Cashier shell", "Assisted catalog/cart", "Cash checkout UI", "QRIS checkout UI", "Cashier exception tools",
  "Kiosk welcome/session", "Touch catalog and discovery", "Kiosk cart/modifier", "Kiosk checkout/payment", "Kiosk completion/reset",
  "OS kiosk lockdown", "Inactivity and abandoned session", "Peripheral and network state", "Physical accessibility", "Tamper/privacy hardening",
  "Admin shell and permission", "Catalog/availability admin", "Live owner dashboard", "Operations and device health", "Orders/refunds/support",
  "Daily operational report", "Settlement report", "Shift and closing workspace", "Stock/promo/member reconciliation", "Export and evidence",
  "Threat model", "API and authorization testing", "Secret/PII/log controls", "Abuse and rate limits", "Dependency/SBOM/DAST",
  "Runtime framework spike", "Packaging and signing", "Update policy", "Active transaction protection", "Rollback/last-known-good",
  "Logs/metrics/traces", "Alerts and dashboards", "Backup/PITR/restore", "Incident and support SOP", "Reconciliation and recovery drill",
  "Isolated staging acceptance", "Provider/hardware UAT", "Staff/device commissioning", "Controlled internal pilot", "Pilot exit and activation decision",
]);

const EXTERNAL = new Map([
  [4, "Independent reviewer identity and RACI acceptance are pending."],
  [11, "Pilot policy is owner-approved; named calendar window, staff roster, and commissioning evidence are pending."],
  [22, "Real device credential issue/rotation needs commissioned hardware and a private vault."],
  [41, "Physical NFC reader is not available for UAT."],
  [42, "Customer Platform tier quote contract needs an authorized integration environment."],
  [43, "Reward reserve/commit/release needs an authorized Customer Platform environment."],
  [60, "SagaDev Gateway is owner-selected; sandbox product registration and two-way HMAC credentials are unavailable."],
  [61, "Real dynamic checkout and expiry need SagaDev Gateway sandbox evidence."],
  [62, "Signed event verification needs SagaDev Gateway sandbox callback evidence."],
  [63, "Cross-process recovery needs a durable deployed runtime and SagaDev status API."],
  [64, "Manual refund and settlement acceptance needs SagaDev Gateway sandbox settlement data."],
  [72, "Physical USB/LAN thermal printer is unavailable."],
  [73, "Printer timeout and unknown-outcome acceptance needs physical hardware."],
  [74, "Physical reprint output cannot be accepted without a printer."],
  [85, "OS kiosk lockdown needs the selected kiosk device and operating system."],
  [86, "Abandoned-session physical acceptance needs the selected kiosk device."],
  [87, "Peripheral/network acceptance needs outlet hardware and network."],
  [88, "Reach-height and wheelchair review must be performed on the physical installation."],
  [89, "Tamper and residue acceptance needs the commissioned kiosk."],
  [105, "Installed runtime framework choice needs target hardware performance evidence."],
  [106, "Installer signing needs final runtime, signing identity, and secure key custody."],
  [107, "Update rollout acceptance needs a commissioned installed runtime."],
  [108, "Active-transaction update protection needs installed runtime UAT."],
  [109, "Last-known-good rollback needs signed installed artifacts."],
  [112, "Production-grade encrypted backup/PITR restore needs isolated infrastructure."],
  [115, "Isolated staging has not been authorized or provisioned."],
  [116, "SagaDev Gateway, printer, NFC, kiosk, and KDS hardware UAT are not available."],
  [117, "Real staff identities, device inventory, and training evidence are pending."],
  [118, "Controlled pilot requires a separate owner authorization and operating window."],
  [119, "Pilot exit and production activation require pilot evidence and independent audit."],
]);

const SIMULATED = new Set([14, 21, 23, 28, 31, 32, 36, 37, 38, 40, 44, 51, 52, 53, 57, 58, 59, 70, 84, 93, 97, 98, 99, 104, 110, 111, 113, 114]);

const EVIDENCE_BY_WAVE = Object.freeze([
  "Product lock, master strategy, owner decisions", "Git branch/SHA, local checks, separate release boundary", "Pilot contract and closure register",
  "Kiosk/Cashier/KDS/Admin responsive UI and accessibility E2E", "Device registry, context manifest, health endpoint", "HttpOnly sessions, CSRF, same-origin and role tests",
  "PilotCatalogPricing catalog lifecycle and availability audit", "Server quote, integer Rupiah, policy fixtures and stacking tests", "Member/Reward local fixture plus integration service tests",
  "Idempotent kiosk/cashier checkout and order history", "Inventory domain and contention tests", "Cash shift, tender, variance, handover and closing tests",
  "SagaDev Gateway simulator, product contract, callback, recovery and settlement tests", "Exactly-once fulfillment and KDS browser E2E", "LocalPrintSpooler and NOT_RUN hardware boundary",
  "Cashier fallback browser flow", "Kiosk browser flow, modifier/member/reward fixture", "Policy contract and physical closure items",
  "Admin availability, dashboard, device health, refund/export controls", "Dashboard reports, closing and CSV export", "Threat model, auth negative tests, npm audit and secret scan",
  "Installed-runtime policy and external closure items", "Local logs/evidence and PostgreSQL restore harness", "Explicit NOT_RUN staging/hardware/pilot/activation gates",
]);

export function buildProgramLedger() {
  if (BATCH_TITLES.length !== 120) throw new Error("batch_title_count_invalid");
  return BATCH_TITLES.map((title, index) => {
    const wave = Math.floor(index / 5);
    const externalReason = EXTERNAL.get(index);
    const classification = externalReason ? "BLOCKED_EXTERNAL" : SIMULATED.has(index) ? "LOCAL_SIMULATED" : "PASS_LOCAL";
    const phases = classification === "PASS_LOCAL"
      ? ["PASS_LOCAL", "PASS_LOCAL", "PASS_LOCAL", "PASS_LOCAL"]
      : classification === "LOCAL_SIMULATED"
        ? ["PASS_LOCAL", "LOCAL_SIMULATED", "PASS_LOCAL_SIMULATION", "EXTERNAL_ACCEPTANCE_PENDING"]
        : ["PASS_LOCAL_CONTRACT", "BLOCKED_EXTERNAL", "NOT_RUN", "NOT_RUN"];
    return {
      id: `B${String(index).padStart(3, "0")}`,
      wave: `W${String(wave).padStart(2, "0")}`,
      waveTitle: WAVE_TITLES[wave], title, classification, phases,
      evidence: EVIDENCE_BY_WAVE[wave], externalReason: externalReason ?? null,
    };
  });
}

export function programSummary(ledger = buildProgramLedger()) {
  const batches = Object.groupBy(ledger, (batch) => batch.classification);
  const microSprints = ledger.flatMap((batch) => batch.phases);
  return {
    waves: new Set(ledger.map((batch) => batch.wave)).size,
    batches: ledger.length,
    microSprints: microSprints.length,
    passLocalBatches: batches.PASS_LOCAL?.length ?? 0,
    simulatedBatches: batches.LOCAL_SIMULATED?.length ?? 0,
    blockedExternalBatches: batches.BLOCKED_EXTERNAL?.length ?? 0,
    passLocalMicroSprints: microSprints.filter((status) => status.startsWith("PASS_LOCAL")).length,
    simulatedMicroSprints: microSprints.filter((status) => status === "LOCAL_SIMULATED").length,
    pendingMicroSprints: microSprints.filter((status) => ["BLOCKED_EXTERNAL", "NOT_RUN", "EXTERNAL_ACCEPTANCE_PENDING"].includes(status)).length,
  };
}

export function renderProgramMarkdown(ledger = buildProgramLedger()) {
  const summary = programSummary(ledger);
  const lines = [
    "# Saga POS 120 Batch Execution Ledger", "",
    "Status: `LOCAL_EXECUTION_COMPLETE_WITH_EXTERNAL_CLOSURE / NOT_DEPLOYED / BUSINESS_READY=false`",
    "Tanggal: 3 September 2026", "",
    `Coverage: **${summary.waves} wave / ${summary.batches} batch / ${summary.microSprints} micro-sprint**.`, "",
    `- PASS_LOCAL batch: ${summary.passLocalBatches}`,
    `- LOCAL_SIMULATED batch: ${summary.simulatedBatches}`,
    `- BLOCKED_EXTERNAL batch: ${summary.blockedExternalBatches}`,
    `- Micro-sprint dengan local pass evidence: ${summary.passLocalMicroSprints}`,
    `- Micro-sprint simulated build: ${summary.simulatedMicroSprints}`,
    `- Micro-sprint external acceptance pending/NOT_RUN: ${summary.pendingMicroSprints}`, "",
    "`LOCAL_SIMULATED` tidak sama dengan provider/hardware PASS. `BLOCKED_EXTERNAL` berarti contract telah dikerjakan tetapi build/acceptance memerlukan authority atau evidence di luar local workspace.", "",
    "| Batch | Wave | Scope | Classification | Contract | Build | Verify | Accept | Evidence / closure |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const batch of ledger) {
    lines.push(`| ${batch.id} | ${batch.wave} | ${batch.title} | ${batch.classification} | ${batch.phases.join(" | ")} | ${batch.externalReason ?? batch.evidence} |`);
  }
  lines.push("", "## External closure register", "");
  for (const batch of ledger.filter((item) => item.externalReason)) lines.push(`- **${batch.id} ${batch.title}:** ${batch.externalReason}`);
  lines.push("");
  return lines.join("\n");
}
