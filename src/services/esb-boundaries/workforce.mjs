import { WORKFORCE_BOUNDARY_V1, boundaryError, deepFreeze, requiredId } from "./contract.mjs";

const FORBIDDEN_LOCAL_KEYS = new Set([
  "employee", "employees", "employeerecords", "staffprofiles", "attendance", "attendancelogs", "payroll", "payrollentries",
]);

export class SagaWorkWorkforceBoundary {
  constructor({ bridge }) {
    if (!bridge?.enabled || typeof bridge.delegateOwner !== "function" || typeof bridge.command !== "function") {
      throw boundaryError("sagawork_boundary_configuration_invalid", 503);
    }
    this.bridge = bridge;
    this.contract = WORKFORCE_BOUNDARY_V1;
    this.enabled = true;
  }

  async delegateOwner({ posOwnerAuthUserId, makeSession }) {
    requiredId(posOwnerAuthUserId, "sagawork_owner_id_required");
    return this.bridge.delegateOwner({ posOwnerAuthUserId, makeSession });
  }

  async command(sessionHash, operation, input = {}) {
    assertReferenceOnly(input);
    return this.bridge.command(sessionHash, operation, input);
  }

  descriptor() { return deepFreeze({ ...this.contract, enabled: true }); }
}

export function createWorkforceReference({ sagaWorkOrganizationId, membershipId, employeeId = null } = {}) {
  return deepFreeze({
    authority: "SAGAWORK",
    persistence: "REFERENCE_ONLY",
    sagaWorkOrganizationId: requiredId(sagaWorkOrganizationId, "sagawork_organization_id_required"),
    membershipId: requiredId(membershipId, "sagawork_membership_id_required"),
    employeeId: employeeId == null ? null : requiredId(employeeId, "sagawork_employee_id_invalid"),
  });
}

export function assertReferenceOnly(value) {
  walk(value, new Set());
  return value;
}

function walk(value, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw boundaryError("sagawork_payload_cycle_invalid");
  seen.add(value);
  if (!Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const canonicalKey = key.replace(/[_-]/gu, "").toLowerCase();
      if (FORBIDDEN_LOCAL_KEYS.has(canonicalKey)) throw boundaryError("sagawork_local_duplication_denied", 409, { key });
      walk(child, seen);
    }
  } else {
    for (const child of value) walk(child, seen);
  }
  seen.delete(value);
}
