import { buildAuditEvent, can } from "./permissions.mjs";

const approvalRoles = new Set(["owner", "manager"]);
const requiredSetupSteps = [
  ["outlet", "Outlet", "outlets"],
  ["payment_method", "Payment Method", "paymentMethods"],
  ["menu", "Menu", "products"],
  ["ingredient", "Ingredient", "ingredients"],
  ["opening_stock", "Opening Stock", "inventoryBalances"],
  ["staff", "Staff", "staffProfiles"],
  ["shift_template", "Shift Template", "shiftTemplates"],
  ["test_transaction", "Test Transaction", "testTransactions"],
];

export function requestApproval(input) {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("approval_reason_required");
  }

  const now = input.requestedAt ?? new Date().toISOString();
  const approval = {
    id: input.id,
    organizationId: input.organizationId,
    outletId: input.outletId ?? null,
    actionType: input.actionType,
    entityType: input.entityType,
    entityId: input.entityId,
    status: "pending",
    reason: input.reason.trim(),
    requestedByUserId: input.requestedBy?.userProfileId,
    approvedByUserId: null,
    requestedAt: now,
    decidedAt: null,
    metadata: input.metadata ?? {},
  };

  return {
    approval,
    audit: buildAuditEvent({
      organizationId: input.organizationId,
      outletId: input.outletId,
      actorUserId: input.requestedBy?.userProfileId,
      action: "approval.requested",
      entityType: input.entityType,
      entityId: input.entityId,
      detail: `${input.actionType} approval requested`,
      metadata: {
        actorRole: input.requestedBy?.role,
        actionType: input.actionType,
        reason: approval.reason,
        sourceDeviceId: input.sourceDeviceId,
      },
    }),
  };
}

export function verifyApprovalPin(input) {
  const approver = input.approver;
  if (!approvalRoles.has(approver?.role)) {
    throw new Error("approval_role_denied");
  }

  const now = parseDate(input.now ?? new Date().toISOString());
  if (input.lockedUntil && now.getTime() < parseDate(input.lockedUntil).getTime()) {
    return {
      ok: false,
      locked: true,
      lockedUntil: parseDate(input.lockedUntil).toISOString(),
      nextFailedAttempts: normalizeCount(input.failedAttempts),
      audit: approvalPinAudit(input, "approval.pin_blocked", now),
    };
  }

  const isValid = input.verifyPin ? input.verifyPin(approver, input.pin) : approver.managerPinHash === `pin:${input.pin}`;
  if (isValid) {
    return {
      ok: true,
      locked: false,
      nextFailedAttempts: 0,
      audit: approvalPinAudit(input, "approval.pin_accepted", now),
    };
  }

  const nextFailedAttempts = normalizeCount(input.failedAttempts) + 1;
  const locked = nextFailedAttempts >= normalizeCount(input.maxAttempts ?? 3);
  const lockedUntil = locked ? addMinutes(now, input.lockMinutes ?? 5).toISOString() : null;

  return {
    ok: false,
    locked,
    lockedUntil,
    nextFailedAttempts,
    audit: approvalPinAudit(input, "approval.pin_failed", now, { locked, lockedUntil }),
  };
}

export function decideApprovalWithPin(input) {
  if (!can(input.approver?.role, "approval:decide")) {
    throw new Error("approval_decide_denied");
  }

  if (!input.pinResult?.ok) {
    throw new Error("approval_pin_required");
  }

  if (!["approved", "rejected"].includes(input.decision)) {
    throw new Error("approval_decision_invalid");
  }

  const decidedAt = input.decidedAt ?? new Date().toISOString();
  const approval = {
    ...input.approval,
    status: input.decision,
    approvedByUserId: input.approver.userProfileId,
    decidedAt,
    decisionNote: input.note,
  };

  return {
    approval,
    audit: buildAuditEvent({
      organizationId: approval.organizationId,
      outletId: approval.outletId,
      actorUserId: input.approver.userProfileId,
      action: `approval.${input.decision}`,
      entityType: approval.entityType,
      entityId: approval.entityId,
      detail: `${approval.actionType} ${input.decision}`,
      metadata: {
        approverRole: input.approver.role,
        actionType: approval.actionType,
        decision: input.decision,
        note: input.note,
      },
    }),
  };
}

export function buildSetupReadiness(input) {
  const steps = requiredSetupSteps.map(([key, label, field]) => {
    const rows = input[field] ?? [];
    const complete = rows.some((row) => row.status === undefined || ["active", "paid", "synced"].includes(row.status));
    return {
      key,
      label,
      complete,
      count: rows.length,
    };
  });
  const completedCount = steps.filter((step) => step.complete).length;
  const scorePct = Math.round((completedCount / steps.length) * 100);

  return {
    status: completedCount === steps.length ? "completed" : "in_progress",
    scorePct,
    canFinish: completedCount === steps.length,
    completedCount,
    totalCount: steps.length,
    steps,
    missingSteps: steps.filter((step) => !step.complete).map((step) => step.key),
  };
}

export function getConnectionSyncStatus(input) {
  const unresolvedErrors = input.unresolvedErrors ?? [];
  const failedSubmissions = input.failedSubmissions ?? [];
  const pendingSubmissions = input.pendingSubmissions ?? [];
  const online = input.online !== false;
  const serverReachable = input.serverReachable !== false;
  const hasError = unresolvedErrors.some((error) => error.severity === "error") || failedSubmissions.length > 0;

  if (!online || !serverReachable || hasError) {
    return {
      statusColor: "red",
      severity: "error",
      canAcceptPayment: false,
      retryEnabled: true,
      userMessage: "Koneksi server bermasalah. Coba lagi sebentar.",
      reasonCodes: buildReasonCodes({ online, serverReachable, hasError, pendingSubmissions, latencyMs: input.latencyMs }),
    };
  }

  if (pendingSubmissions.length > 0 || Number(input.latencyMs ?? 0) > 1500 || unresolvedErrors.some((error) => error.severity === "warning")) {
    return {
      statusColor: "yellow",
      severity: "warning",
      canAcceptPayment: true,
      retryEnabled: true,
      userMessage: "Data belum sepenuhnya tersinkron.",
      reasonCodes: buildReasonCodes({ online, serverReachable, hasError, pendingSubmissions, latencyMs: input.latencyMs }),
    };
  }

  return {
    statusColor: "green",
    severity: "info",
    canAcceptPayment: true,
    retryEnabled: false,
    userMessage: "Semua data tersinkron.",
    reasonCodes: [],
  };
}

export function createSyncErrorLog(input) {
  const severity = input.severity ?? "warning";
  return {
    id: input.id,
    organizationId: input.organizationId,
    outletId: input.outletId ?? null,
    sourceDeviceId: input.sourceDeviceId,
    severity,
    statusColor: severity === "error" ? "red" : severity === "warning" ? "yellow" : "green",
    message: input.message,
    technicalDetail: input.technicalDetail,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    resolvedAt: null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function approvalPinAudit(input, action, now, extraMetadata = {}) {
  return buildAuditEvent({
    organizationId: input.organizationId,
    outletId: input.outletId,
    actorUserId: input.approver?.userProfileId,
    action,
    entityType: "approval_pin",
    detail: action,
    metadata: {
      actorRole: input.approver?.role,
      sourceDeviceId: input.sourceDeviceId,
      ...extraMetadata,
    },
    createdAt: now.toISOString(),
  });
}

function buildReasonCodes({ online, serverReachable, hasError, pendingSubmissions, latencyMs }) {
  const codes = [];
  if (!online) {
    codes.push("offline");
  }
  if (!serverReachable) {
    codes.push("server_unreachable");
  }
  if (hasError) {
    codes.push("sync_error");
  }
  if ((pendingSubmissions ?? []).length > 0) {
    codes.push("pending_sync");
  }
  if (Number(latencyMs ?? 0) > 1500) {
    codes.push("slow_connection");
  }
  return codes;
}

function addMinutes(date, minutes) {
  return new Date(parseDate(date).getTime() + normalizeCount(minutes) * 60 * 1000);
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date_invalid");
  }
  return date;
}

function normalizeCount(value) {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) {
    throw new Error("count_invalid");
  }
  return Math.max(0, Math.round(count));
}
