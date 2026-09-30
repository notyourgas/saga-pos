import { createHash, timingSafeEqual } from "node:crypto";
import {
  deepFreeze,
  exceptionError,
  getExceptionDefinition,
  requireIsoDate,
  requireText,
} from "./contract.mjs";
import { assertActorScope, assertExceptionPermission, assertMakerChecker } from "./permissions.mjs";

export function issueActionAuthorization(input) {
  const approvalStatus = String(input.approval?.status ?? "").toUpperCase();
  if (approvalStatus !== "APPROVED") throw exceptionError("action_authorization_approval_required");

  const kind = input.kind;
  const definition = getExceptionDefinition(kind);
  if (!definition.actionAuthorizationRequired) throw exceptionError("action_authorization_not_required_for_kind");

  const organizationId = requireText(input.organizationId, "organization_id_required", 100);
  const outletId = requireText(input.outletId, "outlet_id_required", 100);
  const resourceType = requireText(input.resourceType, "authorization_resource_type_required", 80);
  const resourceId = requireText(input.resourceId, "authorization_resource_id_required", 100);
  const executorUserId = requireText(input.executorUserId, "exception_executor_required", 100);
  const executorRole = requireText(input.executorRole, "exception_executor_role_required", 64);
  const issuedAt = requireIsoDate(input.issuedAt, "authorization_issued_at_invalid");
  const expiresAt = requireIsoDate(input.expiresAt, "authorization_expires_at_invalid");
  if (expiresAt.getTime() <= issuedAt.getTime()) throw exceptionError("authorization_expiry_invalid");

  const actors = assertMakerChecker({
    requestedByUserId: input.approval.requestedByUserId,
    approvedByUserId: input.approval.approvedByUserId,
    executorUserId,
  });
  if (input.approval.organizationId !== organizationId || input.approval.outletId !== outletId) {
    throw exceptionError("action_authorization_approval_scope_mismatch");
  }
  if (input.approval.actionType !== kind || input.approval.entityType !== resourceType || input.approval.entityId !== resourceId) {
    throw exceptionError("action_authorization_approval_binding_mismatch");
  }
  assertExceptionPermission({
    actor: {
      userProfileId: actors.checker,
      role: input.approval.approvedByRole,
      organizationId,
      outletIds: [outletId],
    },
    organizationId,
    outletId,
    kind,
    capability: "APPROVE",
  });

  const binding = {
    organizationId,
    outletId,
    kind,
    resourceType,
    resourceId,
    executorUserId,
    executorRole,
  };

  return deepFreeze({
    id: requireText(input.id, "authorization_id_required", 100),
    approvalId: requireText(input.approval.id, "approval_id_required", 100),
    ...binding,
    requestedByUserId: actors.maker,
    approvedByUserId: actors.checker,
    approvedByRole: input.approval.approvedByRole,
    status: "AVAILABLE",
    bindingHash: hashBinding(binding),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
    consumedOperationKey: null,
  });
}

export function consumeActionAuthorization({ authorization, actor, request, now }) {
  if (!authorization || typeof authorization !== "object") throw exceptionError("action_authorization_required");
  if (authorization.status !== "AVAILABLE") throw exceptionError("action_authorization_already_used");

  const at = requireIsoDate(now, "authorization_consume_time_invalid");
  const expiresAt = requireIsoDate(authorization.expiresAt, "authorization_expires_at_invalid");
  if (at.getTime() >= expiresAt.getTime()) throw exceptionError("action_authorization_expired");

  assertActorScope({ actor, organizationId: request.organizationId, outletId: request.outletId });
  const binding = {
    organizationId: requireText(request.organizationId, "organization_id_required", 100),
    outletId: requireText(request.outletId, "outlet_id_required", 100),
    kind: request.kind,
    resourceType: requireText(request.resourceType, "authorization_resource_type_required", 80),
    resourceId: requireText(request.resourceId, "authorization_resource_id_required", 100),
    executorUserId: requireText(actor.userProfileId, "exception_actor_id_required", 100),
    executorRole: requireText(actor.role, "exception_actor_role_required", 64),
  };
  getExceptionDefinition(binding.kind);

  const actualHash = hashBinding(binding);
  if (!safeHashEqual(authorization.bindingHash, actualHash)) {
    throw exceptionError("action_authorization_binding_mismatch");
  }

  const operationKey = requireText(request.operationKey, "operation_key_required", 160);
  const consumed = deepFreeze({
    ...authorization,
    status: "CONSUMED",
    consumedAt: at.toISOString(),
    consumedOperationKey: operationKey,
  });

  return deepFreeze({
    authorization: consumed,
    compareAndSet: {
      authorizationId: authorization.id,
      expectedStatus: "AVAILABLE",
      expectedBindingHash: authorization.bindingHash,
    },
    audit: {
      organizationId: binding.organizationId,
      outletId: binding.outletId,
      actorUserId: binding.executorUserId,
      roleSnapshot: binding.executorRole,
      action: "exception.authorization.consumed",
      entityType: "action_authorization",
      entityId: authorization.id,
      oldValues: { status: "AVAILABLE" },
      newValues: { status: "CONSUMED" },
      metadata: { kind: binding.kind, resourceType: binding.resourceType, resourceId: binding.resourceId, operationKey },
      createdAt: at.toISOString(),
    },
  });
}

function hashBinding(binding) {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

function safeHashEqual(expected, actual) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
