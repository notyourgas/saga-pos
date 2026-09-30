import { deepFreeze, immutableSnapshot, reliabilityError, requireText } from "./contract.mjs";

export const PRINT_HARDWARE_ACTIVATION = "OFF_REQUIRES_PHYSICAL_UAT";
export const PRINT_DESTINATIONS = Object.freeze(["KITCHEN", "BAR", "CHECKER", "STICKER"]);

export function buildPrintJobs(input) {
  const organizationId = requireText(input.organizationId, "organization_id_required", 100);
  const outletId = requireText(input.outletId, "outlet_id_required", 100);
  const billId = requireText(input.billId, "print_bill_id_required", 100);
  const saleSnapshot = immutableSnapshot(input.saleSnapshot, "print_sale_snapshot_required");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw reliabilityError("print_lines_required");
  const routes = normalizeRoutes(input.routes);
  const byRoute = new Map(routes.map((route) => [route.destination, { route, lines: [] }]));

  for (const line of input.lines) {
    const lineId = requireText(line.lineId, "print_line_id_required", 100);
    const destinations = [...new Set(line.destinations ?? [])];
    if (destinations.length === 0) throw reliabilityError("print_line_destination_required", { lineId });
    for (const destination of destinations) {
      const target = byRoute.get(destination);
      if (!target) throw reliabilityError("print_route_not_found", { lineId, destination });
      target.lines.push(deepFreeze({ ...structuredClone(line), lineId, destinations: [destination] }));
    }
  }

  return [...byRoute.values()].filter((entry) => entry.lines.length > 0).map(({ route, lines }) => deepFreeze({
    logicalJobId: `${requireText(input.operationKey, "print_operation_key_required", 160)}:${route.destination}`,
    organizationId,
    outletId,
    billId,
    destination: route.destination,
    copyNumber: 0,
    copyKind: "ORIGINAL",
    status: "QUEUED",
    hardwareActivation: PRINT_HARDWARE_ACTIVATION,
    stationSnapshot: route.stationSnapshot,
    templateSnapshot: route.templateSnapshot,
    saleSnapshot,
    contentSnapshot: { lines },
    attempts: [],
    salesMutationAllowed: false,
  }));
}

export function recordPrintAttempt(job, input) {
  const snapshot = normalizeJob(job);
  const attemptId = requireText(input.attemptId, "print_attempt_id_required", 100);
  if (snapshot.attempts.some((attempt) => attempt.attemptId === attemptId)) return snapshot;
  if (!["QUEUED", "FAILED", "UNKNOWN"].includes(snapshot.status)) throw reliabilityError("print_retry_state_invalid");
  const outcome = requireText(input.outcome, "print_attempt_outcome_required", 40);
  if (!["PRINTED", "FAILED", "UNKNOWN"].includes(outcome)) throw reliabilityError("print_attempt_outcome_invalid");
  const attemptedAt = requireIso(input.attemptedAt, "print_attempt_time_invalid");
  const adapter = requireText(input.adapter, "print_adapter_required", 80);
  return deepFreeze({
    ...snapshot,
    status: outcome,
    attempts: [...snapshot.attempts, { attemptId, outcome, attemptedAt, adapter }],
    salesMutationAllowed: false,
  });
}

export function prepareReprint(sourceJob, input) {
  const source = normalizeJob(sourceJob);
  const actorId = requireText(input.actorId, "print_reprint_actor_required", 100);
  const reason = requireText(input.reason, "print_reprint_reason_required", 240);
  const copyNumber = input.copyNumber;
  if (!Number.isSafeInteger(copyNumber) || copyNumber < 1) throw reliabilityError("print_reprint_copy_number_invalid");
  return deepFreeze({
    ...source,
    logicalJobId: requireText(input.logicalJobId, "print_reprint_job_id_required", 180),
    sourceLogicalJobId: source.logicalJobId,
    copyNumber,
    copyKind: "REPRINT",
    status: "QUEUED",
    attempts: [],
    reprintAuthorization: { actorId, reason, requestedAt: requireIso(input.requestedAt, "print_reprint_time_invalid") },
    salesMutationAllowed: false,
  });
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) throw reliabilityError("print_routes_required");
  const destinations = new Set();
  return routes.map((route) => {
    const destination = requireText(route.destination, "print_destination_required", 40);
    if (!PRINT_DESTINATIONS.includes(destination) || destinations.has(destination)) throw reliabilityError("print_destination_invalid", { destination });
    destinations.add(destination);
    const stationSnapshot = immutableSnapshot(route.stationSnapshot, "print_station_snapshot_required");
    const templateSnapshot = immutableSnapshot(route.templateSnapshot, "print_template_snapshot_required");
    requireText(stationSnapshot.stationId, "print_station_id_required", 100);
    requirePositiveVersion(stationSnapshot.version, "print_station_version_invalid");
    requireText(templateSnapshot.templateId, "print_template_id_required", 100);
    requirePositiveVersion(templateSnapshot.version, "print_template_version_invalid");
    return deepFreeze({ destination, stationSnapshot, templateSnapshot });
  });
}

function normalizeJob(job) {
  const snapshot = immutableSnapshot(job, "print_job_invalid");
  requireText(snapshot.logicalJobId, "print_job_id_required", 180);
  requireText(snapshot.billId, "print_bill_id_required", 100);
  if (!Array.isArray(snapshot.attempts)) throw reliabilityError("print_attempts_invalid");
  if (!snapshot.stationSnapshot || !snapshot.templateSnapshot || !snapshot.contentSnapshot) throw reliabilityError("print_job_snapshot_missing");
  return snapshot;
}

function requirePositiveVersion(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw reliabilityError(code);
  return value;
}

function requireIso(value, code) {
  const text = requireText(value, code, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw reliabilityError(code);
  return parsed.toISOString();
}
