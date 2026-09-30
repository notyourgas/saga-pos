const transitions = {
  NEW: ["ACKNOWLEDGED", "IN_PROGRESS", "CANCELLED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["READY", "CANCELLED"],
  READY: ["COMPLETED", "REMAKE"],
  COMPLETED: [],
  CANCELLED: [],
};

const aliases = Object.freeze({ PREPARING: "IN_PROGRESS", SERVED: "COMPLETED" });

export function stationProgress(ticket) {
  const stations = [...new Set(ticket.items.map((item) => String(item.station ?? "bar").toLowerCase()))];
  return Object.fromEntries(stations.map((station) => [station,
    ticket.stationProgress?.[station] ?? (["READY", "COMPLETED"].includes(ticket.status) ? "READY" : "PENDING"),
  ]));
}

export function transitionTicket(ticket, { target, station, reason } = {}, now) {
  const next = structuredClone(ticket);
  const requestedAction = String(target ?? "").toUpperCase();
  const normalizedTarget = aliases[requestedAction] ?? requestedAction;
  next.stationProgress = stationProgress(ticket);
  const names = Object.keys(next.stationProgress);
  const selected = station === undefined ? null : String(station).toLowerCase();
  if (selected !== null && !names.includes(selected)) throw failure("fulfillment_station_invalid", 422);
  if (selected !== null && normalizedTarget !== "READY") throw failure("fulfillment_station_action_invalid", 422);
  if (ticket.status === normalizedTarget) return { ...next, action: requestedAction, operationalStatus: operationalStatus(next), idempotentReplay: true };
  if (!transitions[ticket.status]?.includes(normalizedTarget)) throw failure("fulfillment_transition_invalid", 409);
  const actionReason = String(reason ?? "").trim();
  if (actionReason.length > 200) throw failure("fulfillment_action_reason_invalid", 422);
  if (normalizedTarget === "REMAKE") {
    next.status = "ACKNOWLEDGED";
    next.stationProgress = Object.fromEntries(names.map((name) => [name, "PENDING"]));
    next.remakeCount = Number(ticket.remakeCount ?? 0) + 1;
    next.remadeAt = now;
    next.prepStartedAt = null;
    next.readyAt = null;
    next.completedAt = null;
  } else if (normalizedTarget === "READY") {
    if (names.length > 1 && !selected) throw failure("fulfillment_station_required", 422);
    if (selected && next.stationProgress[selected] === "READY") return { ...next, idempotentReplay: true };
    if (!names.length) throw failure("fulfillment_items_required", 409);
    next.stationProgress[selected ?? names[0]] = "READY";
    next.status = Object.values(next.stationProgress).every((value) => value === "READY") ? "READY" : "IN_PROGRESS";
  } else next.status = normalizedTarget;
  if (actionReason) next.lastActionReason = actionReason;
  next.updatedAt = now;
  if (next.status === "IN_PROGRESS" && !next.prepStartedAt) next.prepStartedAt = now;
  if (next.status === "READY") next.readyAt = now;
  if (next.status === "COMPLETED") next.completedAt = now;
  return { ...next, action: requestedAction, operationalStatus: operationalStatus(next), idempotentReplay: false };
}

export function operationalStatus(ticket) {
  if (ticket?.remakeCount > 0 && ticket?.status === "ACKNOWLEDGED") return "REMAKE";
  return ({ NEW: "NEW", ACKNOWLEDGED: "ACKNOWLEDGED", IN_PROGRESS: "PREPARING", READY: "READY", COMPLETED: "SERVED", CANCELLED: "CANCELLED" })[ticket?.status] ?? ticket?.status;
}

function failure(code, statusCode) { return Object.assign(new Error(code), { code, statusCode }); }
