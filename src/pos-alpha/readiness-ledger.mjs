const MICRO_SPRINT_LABELS = Object.freeze(["Contract", "Build", "Verify", "Accept"]);

export const READINESS_WAVES = Object.freeze([
  {
    id: "W25", title: "Durable SagaOPS Runtime", gate: "G25_DURABLE_RUNTIME_ACCEPTED", weight: 4,
    dependencyGates: [],
    batches: [
      ["R001", "Postgres repository adapters", "Backend Architect", "PASS_LOCAL", "0618da1 baseline", "Order, payment, fulfillment, shift, catalog, device, and audit persist through the shared repository contract.", "Stop if UI or client state can become a second authority."],
      ["R002", "Atomic order-payment-fulfillment outbox", "Database & Integration Engineer", "PASS_LOCAL", "R001", "One database transaction and transactional outbox preserve order/payment/fulfillment invariants.", "Stop on partial commit, duplicate fulfillment, or non-idempotent retry."],
      ["R003", "Restart, collision, and concurrency matrix", "QA & Acceptance Engineer", "PASS_LOCAL", "R001-R002", "Real Postgres tests cover restart, double tap, duplicate callback, order-number collision, and last-stock contention.", "Stop on duplicate financial or fulfillment fact."],
      ["R004", "Migration, seed, backup, and restore gate", "DevOps & Release Engineer", "PASS_LOCAL", "R001-R003", "Fresh install, forward migration, disposable restore, and restart recovery pass on isolated Postgres.", "Stop if restore loses ordering, audit, or reconciliation facts."],
    ],
  },
  {
    id: "W26", title: "SagaDev Gateway Sandbox", gate: "G26_SAGADEV_SANDBOX_ACCEPTED", weight: 3,
    dependencyGates: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    batches: [
      ["R005", "Register sagaops and provision scoped HMAC", "Database & Integration Engineer", "BLOCKED_EXTERNAL_INPUT", "G25 + SagaDev sandbox authority", "Product registration, two-way HMAC vault references, rotation, revoke, and kill switch are evidenced without exposing secrets.", "Stop if a central PJP secret reaches Saga POS or source control."],
      ["R006", "Readiness and dynamic checkout acceptance", "Backend Architect", "BLOCKED_EXTERNAL_INPUT", "R005", "Signed readiness and idempotent create produce the expected amount, currency, expiry, order, and product binding.", "Stop on readiness false, amount drift, or duplicate provider intent."],
      ["R007", "Signed event and status recovery", "Security Engineer", "BLOCKED_EXTERNAL_INPUT", "R006", "Replay, mutation, out-of-order, late event, crash, timeout, and status recovery tests fail closed.", "Stop on false paid, signature bypass, state regression, or duplicate fulfillment."],
      ["R008", "Settlement, refund work item, and reconciliation", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R006-R007", "Gross/fee/net settlement and full-refund manual-finance reconciliation match signed SagaDev facts.", "Stop on invented refund success or unresolved settlement mismatch."],
    ],
  },
  {
    id: "W27", title: "Customer Platform Member and Reward", gate: "G27_CUSTOMER_PLATFORM_ACCEPTED", weight: 1,
    dependencyGates: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    batches: [
      ["R009", "Member Code resolution contract", "Backend Architect", "BLOCKED_EXTERNAL_INPUT", "G25 + Customer Platform sandbox", "Masked member projection, eligibility freshness, invalid/locked state, and abuse limits pass.", "Stop if raw Member Code or unnecessary PII is persisted."],
      ["R010", "NFC and Member Code fallback flow", "UX Workflow Architect", "BLOCKED_EXTERNAL_INPUT", "R009 + R015", "Reader absent, disconnect, duplicate tap, reconnect, and manual Member Code fallback remain operable.", "Stop if NFC failure blocks guest checkout."],
      ["R011", "Reward reserve-commit-release-reverse", "Database & Integration Engineer", "BLOCKED_EXTERNAL_INPUT", "R009", "Reward lifecycle is idempotent across paid, failed, timeout, refund, and recovery paths.", "Stop on double redemption or unreleased reservation."],
      ["R012", "Benefit, privacy, and degraded-mode acceptance", "Security Engineer", "BLOCKED_EXTERNAL_INPUT", "R009-R011", "Voyager/Reward/promo exclusivity, rate limits, redaction, outage behavior, and reconciliation pass.", "Stop on stacking bypass, PII leak, or untraceable loyalty state."],
    ],
  },
  {
    id: "W28", title: "Outlet Hardware and Network", gate: "G28_HARDWARE_NETWORK_ACCEPTED", weight: 3,
    dependencyGates: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    batches: [
      ["R013", "Device inventory, mounting, power, and network", "Product Orchestrator", "BLOCKED_EXTERNAL_INPUT", "Approved BOM and outlet access", "Every kiosk, KDS, printer, NFC reader, UPS, router, owner, mode, and physical placement is inventoried.", "Stop on unidentified device, unsafe mounting, or missing backup connectivity."],
      ["R014", "Epson TM-T82X bench and outlet UAT", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R013 + printer hardware", "Ethernet/USB, paper, cutter, timeout, ambiguous outcome, offline, and labeled reprint tests pass.", "Stop if print failure can lose or duplicate the digital order."],
      ["R015", "ACS ACR1552U PC/SC UAT", "Database & Integration Engineer", "BLOCKED_EXTERNAL_INPUT", "R013 + NFC hardware", "Read, debounce, reconnect, revoke, wrong-card, and Member Code fallback tests pass.", "Stop if device input can elevate role or expose member data."],
      ["R016", "Kiosk, KDS, accessibility, and failover UAT", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R013-R015", "Touch, reach, wheelchair position, glare, KDS visibility, network failover, thermal, and service-access checks pass.", "Stop on inaccessible controls, unsafe installation, or checkout during authority loss."],
    ],
  },
  {
    id: "W29", title: "Signed Installed Runtime", gate: "G29_INSTALLED_RUNTIME_ACCEPTED", weight: 2,
    dependencyGates: ["G25_DURABLE_RUNTIME_ACCEPTED", "G28_HARDWARE_NETWORK_ACCEPTED"],
    batches: [
      ["R017", "Edge Assigned Access runtime benchmark", "Frontend Engineer", "BLOCKED_EXTERNAL_INPUT", "G28 target kiosk", "Startup, memory, touch, crash, reconnect, fullscreen, escape prevention, and recovery meet the target device budget.", "Stop if browser escape or performance blocks service."],
      ["R018", "Signed local device bridge", "Security Engineer", "BLOCKED_EXTERNAL_INPUT", "R014-R017", "Printer/NFC bridge has device-scoped trust, signed requests, allowlist, rotation, revoke, and redacted logs.", "Stop on unsigned command, broad hardware access, or secret leakage."],
      ["R019", "Signed package, version policy, and updates", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "R017-R018 + signing custody", "Installer signature, SHA-256, SBOM, recommended/minimum/blocked version, staged update, and rollback are evidenced.", "Stop on unverifiable artifact or incompatible configuration migration."],
      ["R020", "Active-transaction protection and last-known-good", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R019", "Update/crash/power-loss drills preserve cart/payment/fulfillment recovery pointer and restore last-known-good safely.", "Stop if update can interrupt or duplicate a transaction."],
    ],
  },
  {
    id: "W30", title: "Isolated Staging, Security, and Recovery", gate: "G30_STAGING_ACCEPTED", weight: 2,
    dependencyGates: ["G25_DURABLE_RUNTIME_ACCEPTED", "G26_SAGADEV_SANDBOX_ACCEPTED", "G27_CUSTOMER_PLATFORM_ACCEPTED", "G29_INSTALLED_RUNTIME_ACCEPTED"],
    batches: [
      ["R021", "Isolated staging provisioning", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "Approved non-production budget/topology", "TLS, Postgres, queue/outbox, vault refs, domains, deny-production controls, and environment inventory are reproducible.", "Stop if staging shares production data, secret, or mutation authority."],
      ["R022", "Security and abuse acceptance", "Security Engineer", "BLOCKED_EXTERNAL_INPUT", "R021", "DAST, authorization, IDOR, cross-outlet, injection, CSRF, replay, rate, dependency, and secret scans show no Critical/High.", "Stop on unresolved Critical/High or scope escape."],
      ["R023", "Observability and incident rehearsal", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "R021-R022", "Payment uncertainty, queue lag, device outage, cash variance, settlement mismatch, dead letter, and closing alerts reach named owners.", "Stop on silent financial/fulfillment failure or leaking telemetry."],
      ["R024", "PITR restore and recovery acceptance", "Code Review & Production Auditor", "BLOCKED_EXTERNAL_INPUT", "R021-R023", "Encrypted backup, disposable restore, RPO/RTO, payment/cash/stock/outbox recovery, and application rollback are independently verified.", "Stop if restore is incomplete, destructive, or exceeds accepted RPO/RTO."],
    ],
  },
  {
    id: "W31", title: "Staff Commissioning and Operational UAT", gate: "G31_STAFF_UAT_ACCEPTED", weight: 1,
    dependencyGates: ["G28_HARDWARE_NETWORK_ACCEPTED", "G29_INSTALLED_RUNTIME_ACCEPTED", "G30_STAGING_ACCEPTED"],
    batches: [
      ["R025", "Named identities, RBAC, roster, and custody", "Product Orchestrator", "BLOCKED_EXTERNAL_INPUT", "Named pilot staff and devices", "No shared login; each staff/device/outlet assignment, shift, custodian, and revoke path is accepted.", "Stop on shared account or unowned device."],
      ["R026", "Opening, service, outage, and support training", "UX Workflow Architect", "BLOCKED_EXTERNAL_INPUT", "R025 + approved SOP", "Staff completes opening, assisted checkout, pending payment, sold-out, degraded printer/NFC/network, and escalation drills.", "Stop if staff relies on screenshot/manual paid override."],
      ["R027", "Shift, refund, remake, closing, and handover drill", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R025-R026", "Blind close, variance, cash/QRIS refund, remake, settlement, stock, loyalty, and handover reconcile under role controls.", "Stop on unexplained variance or approval bypass."],
      ["R028", "Staff certification and device commissioning", "Code Review & Production Auditor", "BLOCKED_EXTERNAL_INPUT", "R025-R027", "Named staff and every device receive independent pass/fail evidence, issue owner, expiry, and owner acceptance.", "Stop if any critical role or device lacks a qualified fallback."],
    ],
  },
  {
    id: "W32", title: "Controlled Kopi Saga Salak Pilot", gate: "G32_PILOT_ACCEPTED", weight: 2,
    dependencyGates: ["G26_SAGADEV_SANDBOX_ACCEPTED", "G27_CUSTOMER_PLATFORM_ACCEPTED", "G28_HARDWARE_NETWORK_ACCEPTED", "G30_STAGING_ACCEPTED", "G31_STAFF_UAT_ACCEPTED"],
    batches: [
      ["R029", "Pilot authorization, calendar, baseline, and limits", "Product Orchestrator", "BLOCKED_EXTERNAL_INPUT", "Owner-approved pilot window", "Ten operating days or 200 orders, transaction/device limits, baseline metrics, parallel run, support rota, and stop conditions are signed.", "Stop if scope, reviewer, finance owner, or rollback authority is missing."],
      ["R030", "Day-one canary", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "R029", "Limited devices/orders validate opening, cash, real controlled SagaDev checkout, KDS, receipt, closing, kill switch, and rollback.", "Stop immediately on false paid, duplicate order, scope leak, or unrecoverable outage."],
      ["R031", "Representative operating cycle", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R030", "Pilot reaches the later of ten days or 200 orders with daily metric, incident, reconciliation, staff, and customer-friction evidence.", "Pause on threshold breach; do not average away a critical incident."],
      ["R032", "Pilot exit, reconciliation, and owner acceptance", "Code Review & Production Auditor", "BLOCKED_EXTERNAL_INPUT", "R031", "All days, cash, settlement, refund, stock, loyalty, queue, incidents, and residual risks are independently reconciled and accepted.", "No-go on open blocker, unexplained money, or unowned residual risk."],
    ],
  },
  {
    id: "W33", title: "Guarded Production Deployment and Activation", gate: "G33_PRODUCTION_ACTIVATED", weight: 1,
    dependencyGates: ["G32_PILOT_ACCEPTED"],
    batches: [
      ["R033", "Exact release candidate and provenance", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "G32 + production authorization", "Clean exact commit, locked dependencies, SBOM, signed artifacts, hashes, migrations, config matrix, and last-known-good are frozen.", "Stop if artifact differs from accepted pilot source."],
      ["R034", "Backup, deploy, migrate, and rollback gate", "DevOps & Release Engineer", "BLOCKED_EXTERNAL_INPUT", "R033", "Fresh backup/restore proof, atomic deployment, forward-safe migrations, transaction limits, and rollback rehearsal pass.", "Stop on stale backup, pending migration ambiguity, or rollback failure."],
      ["R035", "Production smoke and authenticated UAT", "QA & Acceptance Engineer", "BLOCKED_EXTERNAL_INPUT", "R034", "Public health plus authenticated owner/cashier/bar flows, persistence, refresh, payment recovery, device health, and closing pass.", "Stop on auth/session/scope/payment/closing discrepancy."],
      ["R036", "Separate controlled activation", "Code Review & Production Auditor", "BLOCKED_EXTERNAL_INPUT", "R035 + fresh activation approval", "Outlet/device/transaction limits, kill switch, monitoring, incident owner, and rollback are live before activation approval.", "Deployment alone is not activation; stop without fresh approval."],
    ],
  },
  {
    id: "W34", title: "Business Readiness Acceptance", gate: "G34_BUSINESS_READY", weight: 1,
    dependencyGates: ["G33_PRODUCTION_ACTIVATED"],
    batches: [
      ["R037", "Finance and settlement operating acceptance", "Database & Integration Engineer", "BLOCKED_EXTERNAL_INPUT", "G33 representative production cycle", "Settlement, refund, cash, stock, loyalty, and daily closing reconcile with named finance ownership.", "Stop on unresolved monetary mismatch."],
      ["R038", "Operations, support, and continuity acceptance", "Product Orchestrator", "BLOCKED_EXTERNAL_INPUT", "R037", "Support rota, SLA, spare hardware, vendor escalation, incident comms, backup internet, and recovery ownership are sustainable.", "Stop on single-person dependency without fallback."],
      ["R039", "Independent production audit", "Code Review & Production Auditor", "BLOCKED_EXTERNAL_INPUT", "R037-R038", "Security, availability, performance, finance, privacy, recovery, and operational residual risks are independently rated and owned.", "Stop on Critical/High or unaccepted residual risk."],
      ["R040", "Owner business-ready decision", "Product Orchestrator", "BLOCKED_EXTERNAL_INPUT", "R039", "Demo Owner accepts the operating evidence, commercial fit, responsibilities, and remaining risk in a dated decision record.", "Do not assign 100/100 without explicit owner acceptance."],
    ],
  },
]);

export const ACCEPTED_READINESS_GATES = Object.freeze(["G25_DURABLE_RUNTIME_ACCEPTED"]);

function normalizeBatch(wave, batch) {
  const [id, title, owner, entryStatus, dependencies, evidence, stopCondition] = batch;
  return {
    id, wave: wave.id, gate: wave.gate, title, owner, entryStatus, dependencies, evidence, stopCondition,
    microSprints: MICRO_SPRINT_LABELS.map((label, index) => ({
      id: `${id}.${index + 1}`, label,
      status: entryStatus === "PASS_LOCAL" ? "PASS_LOCAL" : ["PASS_LOCAL_CONTRACT", "PASS_LOCAL_PREP", "BLOCKED_EXTERNAL", "NOT_RUN"][index],
    })),
  };
}

export function buildReadinessLedger() {
  return READINESS_WAVES.flatMap((wave) => wave.batches.map((batch) => normalizeBatch(wave, batch)));
}

export function readinessSummary({ acceptedGates = ACCEPTED_READINESS_GATES, currentScore = 80 } = {}) {
  const accepted = new Set(acceptedGates);
  const knownGates = new Set(READINESS_WAVES.map((wave) => wave.gate));
  for (const gate of accepted) if (!knownGates.has(gate)) throw new Error(`unknown_readiness_gate:${gate}`);
  for (const wave of READINESS_WAVES.filter((item) => accepted.has(item.gate))) {
    for (const dependency of wave.dependencyGates) if (!accepted.has(dependency)) throw new Error(`readiness_gate_dependency_missing:${wave.gate}:${dependency}`);
  }
  const unlockedPoints = READINESS_WAVES.filter((wave) => accepted.has(wave.gate)).reduce((total, wave) => total + wave.weight, 0);
  const ledger = buildReadinessLedger();
  return {
    currentScore,
    unlockedPoints,
    score: currentScore + unlockedPoints,
    projectedScore: currentScore + READINESS_WAVES.reduce((total, wave) => total + wave.weight, 0),
    waves: READINESS_WAVES.length,
    batches: ledger.length,
    microSprints: ledger.flatMap((batch) => batch.microSprints).length,
    passLocalBatches: ledger.filter((batch) => batch.entryStatus === "PASS_LOCAL").length,
    preparedExternalBatches: ledger.filter((batch) => batch.entryStatus === "BLOCKED_EXTERNAL_INPUT").length,
    readyLocalBuildBatches: ledger.filter((batch) => batch.entryStatus === "READY_LOCAL_BUILD").length,
    blockedExternalInputBatches: ledger.filter((batch) => batch.entryStatus === "BLOCKED_EXTERNAL_INPUT").length,
  };
}

export function renderReadinessMarkdown() {
  const ledger = buildReadinessLedger();
  const summary = readinessSummary();
  const lines = [
    "# Saga POS Readiness 80 to 100 Batch Plan", "",
    "Tanggal: 3 September 2026",
    "Status: `W25_PASS_LOCAL / W26-W34_BLOCKED_EXTERNAL_INPUT / IMPLEMENTED_NOT_DEPLOYED / BUSINESS_READY=false`", "",
    `Coverage: **${summary.waves} wave / ${summary.batches} batch / ${summary.microSprints} micro-sprint**.`,
    `Current verified readiness: **${summary.score}/100** (${summary.currentScore} baseline + ${summary.unlockedPoints} accepted gate points). Projected readiness only after every accepted gate: **${summary.projectedScore}/100**.`, "",
    "W25 unlocks four local-readiness points after durable disk-backed Postgres semantics, atomicity, restart, migration registry, recovery, and surface tests passed. It is not external Postgres, staging, or production evidence. Every later wave unlocks its full weight only after all four batches, required evidence, dependency gates, independent review, and its gate decision are accepted.", "",
    "Each batch has four micro-sprints: `.1 Contract`, `.2 Build/Prepare`, `.3 Verify`, and `.4 Accept`. W25 is `PASS_LOCAL`; W26-W34 have local contract/preparation evidence while external verification and acceptance remain blocked/not run.", "",
    "## Score map", "",
    "| Wave | Gate | Weight | Depends on |",
    "|---|---|---:|---|",
  ];
  for (const wave of READINESS_WAVES) lines.push(`| ${wave.id} ${wave.title} | ${wave.gate} | +${wave.weight} | ${wave.dependencyGates.join(", ") || "Verified 80/100 baseline"} |`);
  lines.push("", "## Critical path", "", "```text", "W25 durable runtime [PASS_LOCAL]", "  -> W26 SagaDev + W27 Customer Platform + W28 hardware", "  -> W29 installed runtime", "  -> W30 isolated staging/security/recovery", "  -> W31 staff UAT", "  -> W32 controlled pilot", "  -> W33 production deployment/activation", "  -> W34 business-ready acceptance", "```", "");
  for (const wave of READINESS_WAVES) {
    const batches = ledger.filter((batch) => batch.wave === wave.id);
    lines.push(`## ${wave.id} — ${wave.title} (+${wave.weight})`, "", `Gate: \`${wave.gate}\`.`, "", "| Batch | Scope | Owner | Entry | Dependency | Required evidence | Stop condition |", "|---|---|---|---|---|---|---|");
    for (const batch of batches) lines.push(`| ${batch.id} | ${batch.title} | ${batch.owner} | ${batch.entryStatus} | ${batch.dependencies} | ${batch.evidence} | ${batch.stopCondition} |`);
    lines.push("");
  }
  lines.push("## Execution rules", "", "- W25 is accepted locally. W26, W27, and W28 may proceed in parallel when their external inputs exist.", "- Never place credentials, PII, raw callbacks, receipts, customer data, or device identifiers in this ledger or public evidence.", "- `DEPLOYED`, `ACTIVATED`, and `BUSINESS_READY` require separate decisions and evidence.", "- Any false-paid, duplicate order, cross-outlet access, unexplained settlement/cash variance, or Critical/High security finding is an immediate no-go.", "- Update the current score only through `readinessSummary({ acceptedGates })` after the corresponding gate evidence is accepted.", "");
  return lines.join("\n");
}
