import { deepFreeze, exceptionError, getExceptionDefinition, requireText } from "./contract.mjs";

const executePermissions = Object.freeze({
  owner: new Set(["*"]),
  manager: new Set([
    "exception:cancel",
    "exception:void",
    "exception:refund_cash",
    "exception:refund_provider",
    "exception:payment_correction",
    "exception:payment_reversal",
    "exception:payment_reclassification",
  ]),
  cashier_barista: new Set(["exception:cancel"]),
});

const requestRoles = new Set(["owner", "manager", "cashier_barista"]);
const approvalRoles = new Set(["owner", "manager"]);

export function assertActorScope({ actor, organizationId, outletId }) {
  if (!actor || typeof actor !== "object") throw deniedError("exception_auth_required", { actor: null, organizationId, outletId });
  const actorId = requireText(actor.userProfileId, "exception_actor_id_required", 100);
  const role = requireText(actor.role, "exception_actor_role_required", 64);
  const scopedOrganization = requireText(actor.organizationId, "exception_actor_organization_required", 100);
  if (scopedOrganization !== organizationId) {
    throw deniedError("exception_organization_scope_denied", { actor, organizationId, outletId });
  }
  if (!Array.isArray(actor.outletIds) || !actor.outletIds.includes(outletId)) {
    throw deniedError("exception_outlet_scope_denied", { actor, organizationId, outletId });
  }
  return { actorId, role };
}

export function assertExceptionPermission({ actor, organizationId, outletId, kind, capability = "EXECUTE" }) {
  const { actorId, role } = assertActorScope({ actor, organizationId, outletId });
  const definition = getExceptionDefinition(kind);

  if (capability === "REQUEST") {
    if (!requestRoles.has(role)) throw deniedError("exception_request_permission_denied", { actor, organizationId, outletId, kind, capability });
  } else if (capability === "APPROVE") {
    if (!approvalRoles.has(role)) throw deniedError("exception_approval_permission_denied", { actor, organizationId, outletId, kind, capability });
  } else if (capability === "EXECUTE") {
    const permissions = executePermissions[role] ?? new Set();
    if (!permissions.has("*") && !permissions.has(definition.permission)) {
      throw deniedError("exception_execute_permission_denied", {
        actor,
        organizationId,
        outletId,
        kind,
        capability,
        permission: definition.permission,
      });
    }
  } else {
    throw exceptionError("exception_capability_invalid");
  }

  return Object.freeze({ actorId, role, capability, permission: definition.permission });
}

export function assertMakerChecker({ requestedByUserId, approvedByUserId, executorUserId }) {
  const maker = requireText(requestedByUserId, "exception_maker_required", 100);
  const checker = requireText(approvedByUserId, "exception_checker_required", 100);
  const executor = requireText(executorUserId, "exception_executor_required", 100);
  if (maker === checker) throw exceptionError("exception_maker_checker_same_actor");
  if (executor === checker) throw exceptionError("exception_checker_cannot_execute_approved_action");
  return Object.freeze({ maker, checker, executor });
}

function deniedError(code, { actor, organizationId, outletId, kind = null, capability = null, permission = null }) {
  const error = exceptionError(code, { kind, capability, permission });
  error.audit = deepFreeze({
    organizationId: organizationId ?? null,
    outletId: outletId ?? null,
    actorUserId: actor?.userProfileId ?? null,
    roleSnapshot: actor?.role ?? null,
    action: "exception.permission.denied",
    entityType: "exception_permission",
    entityId: kind,
    oldValues: {},
    newValues: {},
    metadata: { denialCode: code, kind, capability, permission },
    createdAt: new Date().toISOString(),
  });
  return error;
}
