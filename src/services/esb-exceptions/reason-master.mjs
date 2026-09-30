import {
  EXCEPTION_KINDS,
  deepFreeze,
  exceptionError,
  getExceptionDefinition,
  requireIsoDate,
  requireText,
} from "./contract.mjs";

const exceptionKindSet = new Set(Object.values(EXCEPTION_KINDS));

export function createReasonMaster(input) {
  const permittedKinds = [...new Set(input.permittedKinds ?? [])];
  if (permittedKinds.length === 0 || permittedKinds.some((kind) => !exceptionKindSet.has(kind))) {
    throw exceptionError("reason_master_kinds_invalid");
  }

  const effectiveFrom = requireIsoDate(input.effectiveFrom, "reason_master_effective_from_invalid");
  const effectiveUntil = input.effectiveUntil === null || input.effectiveUntil === undefined
    ? null
    : requireIsoDate(input.effectiveUntil, "reason_master_effective_until_invalid");
  if (effectiveUntil && effectiveUntil.getTime() <= effectiveFrom.getTime()) {
    throw exceptionError("reason_master_window_invalid");
  }

  return deepFreeze({
    id: requireText(input.id, "reason_master_id_required", 100),
    version: requirePositiveInteger(input.version, "reason_master_version_invalid"),
    organizationId: requireText(input.organizationId, "organization_id_required", 100),
    outletId: input.outletId === null || input.outletId === undefined
      ? null
      : requireText(input.outletId, "outlet_id_invalid", 100),
    code: requireText(input.code, "reason_master_code_required", 64).toUpperCase(),
    label: requireText(input.label, "reason_master_label_required", 160),
    permittedKinds: deepFreeze(permittedKinds),
    active: input.active === true,
    requiresNote: input.requiresNote === true,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: effectiveUntil?.toISOString() ?? null,
  });
}

export function selectReasonSnapshot({ master, kind, organizationId, outletId, occurredAt, note }) {
  getExceptionDefinition(kind);
  if (!master?.active) throw exceptionError("reason_master_inactive");
  if (master.organizationId !== organizationId) throw exceptionError("reason_master_organization_mismatch");
  if (master.outletId !== null && master.outletId !== outletId) throw exceptionError("reason_master_outlet_mismatch");
  if (!master.permittedKinds?.includes(kind)) throw exceptionError("reason_master_action_mismatch");

  const at = requireIsoDate(occurredAt, "exception_occurred_at_invalid");
  const from = requireIsoDate(master.effectiveFrom, "reason_master_effective_from_invalid");
  const until = master.effectiveUntil ? requireIsoDate(master.effectiveUntil, "reason_master_effective_until_invalid") : null;
  if (at.getTime() < from.getTime() || (until && at.getTime() >= until.getTime())) {
    throw exceptionError("reason_master_outside_effective_window");
  }

  const normalizedNote = typeof note === "string" ? note.trim() : "";
  if (master.requiresNote && normalizedNote.length === 0) throw exceptionError("reason_note_required");
  if (normalizedNote.length > 500) throw exceptionError("reason_note_too_long", { maximum: 500 });

  return deepFreeze({
    reasonId: master.id,
    reasonVersion: master.version,
    code: master.code,
    label: master.label,
    note: normalizedNote || null,
    selectedForKind: kind,
    selectedAt: at.toISOString(),
  });
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw exceptionError(code);
  return value;
}
