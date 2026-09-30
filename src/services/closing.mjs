const defaultVarianceThresholds = {
  infoMaxRupiah: 1000,
  noteRequiredMaxRupiah: 10000,
  managerReviewMaxRupiah: 25000,
};

const cashDrawerExpenseSources = new Set(["cash_drawer", undefined, null]);

export function openCashSession(input) {
  if (input.activeSessions?.some((session) => session.outletId === input.outletId && session.status === "open")) {
    throw new Error("cash_session_already_open");
  }

  const openingCashRupiah = normalizeMoney(input.openingCashRupiah);
  const expectedOpeningCashRupiah = input.previousCashSession
    ? normalizeMoney(input.previousCashSession.cashToLeaveRupiah)
    : openingCashRupiah;

  return {
    id: input.id,
    organizationId: input.organizationId,
    outletId: input.outletId,
    openedByUserId: input.openedByUserId,
    businessDate: input.businessDate,
    shiftName: input.shiftName,
    status: "open",
    openingCashRupiah,
    expectedOpeningCashRupiah,
    openingVarianceRupiah: openingCashRupiah - expectedOpeningCashRupiah,
    previousCashSessionId: input.previousCashSession?.id ?? null,
    handoverStatus: input.previousCashSession ? "pending_confirmation" : "not_required",
    openedAt: input.openedAt ?? new Date().toISOString(),
  };
}

export function recordShiftExpense({ cashSession, expense }) {
  if (!cashSession || cashSession.status !== "open") {
    throw new Error("cash_session_open_required");
  }

  const amountRupiah = normalizeMoney(expense.amountRupiah);
  if (amountRupiah <= 0) {
    throw new Error("expense_amount_required");
  }

  const source = expense.source ?? "cash_drawer";
  const affectsCashDrawer = cashDrawerExpenseSources.has(source);

  return {
    id: expense.id,
    organizationId: cashSession.organizationId,
    outletId: cashSession.outletId,
    cashSessionId: cashSession.id,
    category: expense.category,
    amountRupiah,
    reason: expense.reason,
    source,
    status: "recorded",
    affectsCashDrawer,
    createdByUserId: expense.createdByUserId,
    createdAt: expense.createdAt ?? new Date().toISOString(),
  };
}

export function closeCashSession(input) {
  if (input.cashSession?.status && input.cashSession.status !== "open") {
    throw new Error("cash_session_already_closed");
  }

  const openingCashRupiah = normalizeMoney(input.openingCashRupiah ?? input.cashSession?.openingCashRupiah ?? 0);
  const cashSalesRupiah = sumAmounts(input.cashPayments);
  const cashRefundsRupiah = sumAmounts(input.cashRefunds);
  const expensesRupiah = sumCashDrawerExpenses(input.expenses);
  const nonCashExpenseRupiah = sumNonCashDrawerExpenses(input.expenses);
  const cashToLeaveRupiah = normalizeMoney(input.cashToLeaveRupiah ?? 0);
  const expectedCashRupiah = openingCashRupiah + cashSalesRupiah - cashRefundsRupiah - expensesRupiah;
  const actualCashRupiah = normalizeMoney(input.actualCashRupiah ?? expectedCashRupiah);
  const depositCashRupiah = Math.max(0, actualCashRupiah - cashToLeaveRupiah);
  const varianceRupiah = actualCashRupiah - expectedCashRupiah;
  const variance = classifyCashVariance(varianceRupiah, input.varianceThresholds);

  if (variance.noteRequired && !input.note) {
    return {
      status: "closing",
      blocked: true,
      blockReason: "cash_variance_note_required",
      expectedCashRupiah,
      actualCashRupiah,
      cashToLeaveRupiah,
      depositCashRupiah,
      varianceRupiah,
      varianceStatus: variance.status,
      noteRequired: true,
      approvalRequired: variance.approvalRequired,
      summary: buildShiftSummary({ openingCashRupiah, cashSalesRupiah, cashRefundsRupiah, expensesRupiah, nonCashExpenseRupiah }),
    };
  }

  return {
    id: input.cashSession?.id,
    status: "closed",
    closedByUserId: input.closedByUserId,
    expectedCashRupiah,
    actualCashRupiah,
    cashToLeaveRupiah,
    depositCashRupiah,
    varianceRupiah,
    varianceStatus: variance.status,
    noteRequired: variance.noteRequired,
    managerReviewRequired: variance.managerReviewRequired,
    approvalRequired: variance.approvalRequired,
    note: input.note,
    closedAt: input.closedAt ?? new Date().toISOString(),
    summary: buildShiftSummary({ openingCashRupiah, cashSalesRupiah, cashRefundsRupiah, expensesRupiah, nonCashExpenseRupiah }),
  };
}

export function confirmCashHandover(input) {
  if (!input.previousCashSession || input.previousCashSession.status !== "closed") {
    throw new Error("previous_cash_session_closed_required");
  }

  if (!input.nextCashSession || input.nextCashSession.status !== "open") {
    throw new Error("next_cash_session_open_required");
  }

  const expectedOpeningCashRupiah = normalizeMoney(input.previousCashSession.cashToLeaveRupiah);
  const confirmedOpeningCashRupiah = normalizeMoney(input.confirmedOpeningCashRupiah);
  const varianceRupiah = confirmedOpeningCashRupiah - expectedOpeningCashRupiah;
  const variance = classifyCashVariance(varianceRupiah, input.varianceThresholds);

  return {
    previousCashSessionId: input.previousCashSession.id,
    nextCashSessionId: input.nextCashSession.id,
    expectedOpeningCashRupiah,
    confirmedOpeningCashRupiah,
    varianceRupiah,
    varianceStatus: variance.status,
    noteRequired: variance.noteRequired,
    approvalRequired: variance.approvalRequired,
    note: input.note,
    confirmedByUserId: input.confirmedByUserId,
    confirmedAt: input.confirmedAt ?? new Date().toISOString(),
  };
}

export function generateDailyClosingDraft(input) {
  const openSessions = input.cashSessions.filter((session) => ["open", "closing"].includes(session.status));
  if (openSessions.length > 0) {
    throw new Error("daily_closing_has_open_shift");
  }

  const paidOrders = input.orders.filter((order) => ["paid", "pending_sync"].includes(order.status));
  const netSalesRupiah = sumAmounts(paidOrders, "totalRupiah");
  const totalHppRupiah = sumAmounts(paidOrders, "totalHppRupiah");
  const paymentBreakdown = buildPaymentBreakdown(input.payments);
  const shiftSummaries = input.cashSessions.map(summarizeClosedShift);
  const cashVarianceRupiah = shiftSummaries.reduce((sum, shift) => sum + shift.varianceRupiah, 0);
  const issueFlags = buildDailyIssueFlags({ cashSessions: input.cashSessions, payments: input.payments, integrationChecks: input.integrationChecks });

  return {
    organizationId: input.organizationId,
    outletId: input.outletId,
    businessDate: input.businessDate,
    status: "draft",
    netSalesRupiah,
    totalOrders: paidOrders.length,
    totalHppRupiah,
    grossProfitRupiah: netSalesRupiah - totalHppRupiah,
    totalExpenseRupiah: sumAmounts(input.expenses),
    totalCashDrawerExpenseRupiah: sumCashDrawerExpenses(input.expenses),
    totalPurchaseReceivedRupiah: sumMovementValue(input.inventoryMovements, "purchase_received"),
    totalWasteRupiah: Math.abs(sumMovementValue(input.inventoryMovements, "waste")),
    cashVarianceRupiah,
    cash: {
      totalOpeningCashRupiah: sumAmounts(input.cashSessions, "openingCashRupiah"),
      totalExpectedCashRupiah: sumAmounts(input.cashSessions, "expectedCashRupiah"),
      totalActualCashRupiah: sumAmounts(input.cashSessions, "actualCashRupiah"),
      totalDepositCashRupiah: sumAmounts(input.cashSessions, "depositCashRupiah"),
      totalCashLeftRupiah: sumAmounts(input.cashSessions, "cashToLeaveRupiah"),
      totalCashVarianceRupiah: cashVarianceRupiah,
    },
    paymentBreakdown,
    shiftSummaries,
    issueFlags,
    snapshotJson: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      paymentBreakdown,
      shiftSummaries,
      issueFlags,
    },
  };
}

export function submitDailyClosing(draft, input = {}) {
  if (draft.status !== "draft") {
    throw new Error("daily_closing_draft_required");
  }

  return {
    ...draft,
    status: "submitted",
    submittedByUserId: input.submittedByUserId,
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };
}

export function lockDailyClosing(closing, input = {}) {
  if (!["submitted", "approved"].includes(closing.status)) {
    throw new Error("daily_closing_submitted_required");
  }

  if (closing.issueFlags?.some((issue) => issue.blocking) && input.force !== true) {
    throw new Error("daily_closing_blocking_issues");
  }

  return {
    ...closing,
    status: "locked",
    lockedByUserId: input.lockedByUserId,
    lockedAt: input.lockedAt ?? new Date().toISOString(),
  };
}

export function classifyCashVariance(varianceRupiah, thresholds = defaultVarianceThresholds) {
  const absVariance = Math.abs(normalizeMoney(varianceRupiah));

  if (absVariance <= thresholds.infoMaxRupiah) {
    return {
      status: "info",
      noteRequired: false,
      managerReviewRequired: false,
      approvalRequired: false,
    };
  }

  if (absVariance <= thresholds.noteRequiredMaxRupiah) {
    return {
      status: "note_required",
      noteRequired: true,
      managerReviewRequired: false,
      approvalRequired: false,
    };
  }

  if (absVariance <= thresholds.managerReviewMaxRupiah) {
    return {
      status: "manager_review",
      noteRequired: true,
      managerReviewRequired: true,
      approvalRequired: false,
    };
  }

  return {
    status: "approval_required",
    noteRequired: true,
    managerReviewRequired: true,
    approvalRequired: true,
  };
}

function summarizeClosedShift(session) {
  return {
    cashSessionId: session.id,
    shiftName: session.shiftName,
    openingCashRupiah: normalizeMoney(session.openingCashRupiah),
    expectedCashRupiah: normalizeMoney(session.expectedCashRupiah),
    actualCashRupiah: normalizeMoney(session.actualCashRupiah),
    cashToLeaveRupiah: normalizeMoney(session.cashToLeaveRupiah),
    depositCashRupiah: normalizeMoney(session.depositCashRupiah),
    varianceRupiah: normalizeMoney(session.varianceRupiah),
    varianceStatus: session.varianceStatus ?? classifyCashVariance(session.varianceRupiah).status,
    closedByUserId: session.closedByUserId,
  };
}

function buildDailyIssueFlags({ cashSessions, payments, integrationChecks = {} }) {
  const issues = [];

  for (const session of cashSessions) {
    const variance = classifyCashVariance(session.varianceRupiah);
    if (variance.managerReviewRequired || variance.approvalRequired) {
      issues.push({
        code: "cash_variance_review",
        severity: variance.approvalRequired ? "high" : "medium",
        blocking: variance.approvalRequired,
        cashSessionId: session.id,
        message: `Cash variance needs ${variance.approvalRequired ? "approval" : "manager review"}`,
      });
    }
  }

  const uncheckedNonCashCount = payments.filter(
    (payment) => payment.methodType !== "cash" && ["unchecked", undefined, null].includes(payment.settlementStatus),
  ).length;

  if (uncheckedNonCashCount > 0) {
    issues.push({
      code: "non_cash_unchecked",
      severity: "low",
      blocking: false,
      count: uncheckedNonCashCount,
      message: "Non-cash payment still needs settlement check",
    });
  }

  const integrationRules = [
    ["outboxPending", "outbox_pending", "high", true],
    ["paymentMismatches", "payment_mismatch", "high", true],
    ["loyaltyMismatches", "loyalty_mismatch", "high", true],
    ["rewardHoldsExpired", "reward_hold_expired", "medium", false],
    ["questMismatches", "quest_mismatch", "medium", false],
  ];
  for (const [field, code, severity, blocking] of integrationRules) {
    const count = normalizeMoney(integrationChecks[field] ?? 0);
    if (count > 0) issues.push({ code, severity, blocking, count, message: `${field} requires reconciliation` });
  }

  return issues;
}

function buildPaymentBreakdown(payments = []) {
  return payments.reduce((acc, payment) => {
    const key = payment.methodNameSnapshot ?? payment.methodType;
    acc[key] ??= {
      methodName: key,
      methodType: payment.methodType,
      amountRupiah: 0,
      count: 0,
      uncheckedCount: 0,
    };
    acc[key].amountRupiah += normalizeMoney(payment.amountRupiah);
    acc[key].count += 1;
    if (payment.methodType !== "cash" && ["unchecked", undefined, null].includes(payment.settlementStatus)) {
      acc[key].uncheckedCount += 1;
    }
    return acc;
  }, {});
}

function buildShiftSummary({ openingCashRupiah, cashSalesRupiah, cashRefundsRupiah, expensesRupiah, nonCashExpenseRupiah }) {
  return {
    openingCashRupiah,
    cashSalesRupiah,
    cashRefundsRupiah,
    expensesRupiah,
    nonCashExpenseRupiah,
  };
}

function sumCashDrawerExpenses(expenses = []) {
  return expenses
    .filter((expense) => cashDrawerExpenseSources.has(expense.source))
    .reduce((sum, expense) => sum + normalizeMoney(expense.amountRupiah), 0);
}

function sumNonCashDrawerExpenses(expenses = []) {
  return expenses
    .filter((expense) => !cashDrawerExpenseSources.has(expense.source))
    .reduce((sum, expense) => sum + normalizeMoney(expense.amountRupiah), 0);
}

function sumMovementValue(movements = [], movementType) {
  return movements
    .filter((movement) => movement.movementType === movementType)
    .reduce((sum, movement) => sum + normalizeMoney(movement.valueDeltaRupiah), 0);
}

function sumAmounts(rows = [], field = "amountRupiah") {
  return rows.reduce((sum, row) => sum + normalizeMoney(row[field]), 0);
}

function normalizeMoney(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) {
    throw new Error("money_amount_invalid");
  }
  return Math.round(amount);
}
