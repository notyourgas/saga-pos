const rolePermissions = {
  owner: ["*"],
  manager: [
    "catalog:read",
    "catalog:write",
    "recipe:read",
    "recipe:write",
    "inventory:read",
    "inventory:write",
    "pos:checkout",
    "pos:void",
    "purchase:read",
    "purchase:write",
    "closing:shift",
    "closing:daily",
    "dashboard:read",
    "report:hpp",
    "report:margin",
    "audit:read",
    "approval:decide",
    "setup:write",
    "sync:read",
  ],
  cashier_barista: [
    "catalog:read",
    "inventory:read",
    "inventory:write_basic",
    "pos:checkout",
    "closing:shift",
    "dashboard:read_limited",
    "attendance:write",
  ],
  hr_admin: [
    "staff:read",
    "staff:write",
    "attendance:read",
    "attendance:write",
    "payroll:read",
    "payroll:write",
    "setup:write",
  ],
};

export function can(role, action) {
  const permissions = rolePermissions[role] ?? [];
  return permissions.includes("*") || permissions.includes(action);
}

export function assertPermission(role, action) {
  if (!can(role, action)) {
    throw new Error(`permission_denied:${action}`);
  }
  return true;
}

export function requiresManagerApproval(action) {
  return ["pos:void", "inventory:negative_stock", "inventory:large_correction", "payment:refund"].includes(action);
}

export function buildAuditEvent({
  organizationId,
  outletId,
  actorUserId,
  staffId,
  roleSnapshot,
  sourceDeviceId,
  action,
  entityType,
  entityId,
  detail,
  oldValues = {},
  newValues = {},
  metadata = {},
  createdAt,
}) {
  return {
    organizationId,
    outletId,
    actorUserId,
    staffId,
    roleSnapshot,
    sourceDeviceId,
    action,
    entityType,
    entityId,
    detail,
    oldValues,
    newValues,
    metadata,
    createdAt: createdAt ?? new Date().toISOString(),
  };
}
