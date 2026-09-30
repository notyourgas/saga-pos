import { createHash } from "node:crypto";
import {
  REPORT_CONTRACT_VERSION,
  REPORT_LINE_KINDS,
  addAmounts,
  assertAppliedFilter,
  assertUniqueRows,
  checkedAdd,
  deepFreeze,
  normalizeReportQuery,
  reportingError,
  requireIsoInstant,
  requireSafeInteger,
  requireText,
  roundRatio,
} from "./contract.mjs";

const PAYMENT_STATES = new Set(["CREATED", "PENDING", "SUCCEEDED", "FAILED", "EXPIRED", "REVERSED"]);
const REFUND_STATES = new Set(["REQUESTED", "PENDING", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "CANCELLED"]);
const SETTLEMENT_STATES = new Set(["UNMATCHED", "EXPECTED", "AVAILABLE", "PAID_OUT", "DISPUTED"]);
const COGS_STATES = new Set(["UNKNOWN", "INCOMPLETE", "COMPLETE"]);
const PAYMENT_VERIFICATION = Object.freeze({
  CASH: ["CASH_ACCEPTED_EVENT", "VERIFIED"],
  PROVIDER_VERIFIED: ["EXTERNAL_PROVIDER_EVENT", "VERIFIED"],
  MANUAL: ["MANUAL_OR_PENDING", "MANUAL"],
  LEGACY_UNVERIFIED: ["LEGACY_IMPORT", "UNVERIFIED"],
});

export function createEsbOwnerReportingService({ reportSourcePort, clock = () => new Date().toISOString() } = {}) {
  if (typeof reportSourcePort?.loadAuthorizedReportSource !== "function") {
    throw reportingError("report_source_port_required");
  }
  return Object.freeze({
    async build(input) {
      const query = normalizeReportQuery(input);
      const source = await reportSourcePort.loadAuthorizedReportSource(query);
      return buildOwnerReportFromSource({ query, source, generatedAtUtc: clock() });
    },
  });
}

export function buildOwnerReportFromSource({ query: rawQuery, source = {}, generatedAtUtc } = {}) {
  const query = rawQuery?.contractVersion === REPORT_CONTRACT_VERSION ? rawQuery : normalizeReportQuery(rawQuery);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw reportingError("report_source_invalid");
  assertAppliedFilter(query, source.appliedFilter);
  const generatedAt = requireIsoInstant(generatedAtUtc, "generatedAtUtc");
  const freshnessSeconds = Math.floor((Date.parse(generatedAt) - Date.parse(query.snapshotCutoffUtc)) / 1000);
  if (freshnessSeconds < 0) throw reportingError("report_generated_before_snapshot_cutoff");

  const bills = Array.isArray(source.bills) ? source.bills : [];
  const payments = Array.isArray(source.payments) ? source.payments : [];
  const refunds = Array.isArray(source.refunds) ? source.refunds : [];
  const settlements = Array.isArray(source.settlements) ? source.settlements : [];
  const cashMovements = Array.isArray(source.cashMovements) ? source.cashMovements : [];
  const saleLines = Array.isArray(source.saleLines) ? source.saleLines : [];

  const billIds = assertUniqueRows(bills, "bill");
  assertUniqueRows(payments, "payment");
  assertUniqueRows(refunds, "refund");
  assertUniqueRows(settlements, "settlement");
  assertUniqueRows(cashMovements, "cash_movement");
  assertUniqueRows(saleLines, "sale_line");

  const allowedOutlets = new Set(query.outletIds);
  const billById = new Map();
  for (const bill of bills) {
    assertScopedRow(bill, query, allowedOutlets, "bill");
    if (bill.status !== "PAID") throw reportingError("report_non_included_bill", bill.id);
    const values = moneyFields(bill, [
      "menuGrossRupiah", "lineDiscountRupiah", "billDiscountRupiah", "netMenuRupiah",
      "taxRupiah", "serviceRupiah", "customerFeeRupiah", "roundingAdjustmentRupiah", "totalRupiah",
    ], new Set(["roundingAdjustmentRupiah"]));
    const expectedNetMenu = checkedAdd(checkedAdd(values.menuGrossRupiah, -values.lineDiscountRupiah, "bill.netMenu"), -values.billDiscountRupiah, "bill.netMenu");
    if (values.netMenuRupiah !== expectedNetMenu) {
      throw reportingError("report_bill_net_invariant_failed", bill.id);
    }
    const expectedTotal = [values.taxRupiah, values.serviceRupiah, values.customerFeeRupiah, values.roundingAdjustmentRupiah]
      .reduce((total, value) => checkedAdd(total, value, "bill.total"), values.netMenuRupiah);
    if (values.totalRupiah !== expectedTotal) {
      throw reportingError("report_bill_total_invariant_failed", bill.id);
    }
    requireSafeInteger(bill.allocatedPax, "bill.allocatedPax", { nonNegative: true });
    billById.set(bill.id, { ...bill, ...values, billNumber: requireText(bill.billNumber, "bill.billNumber") });
  }

  const paymentsByBill = new Map();
  for (const payment of payments) {
    assertScopedRow(payment, query, allowedOutlets, "payment");
    if (!PAYMENT_STATES.has(payment.status)) throw reportingError("report_payment_status_invalid", payment.id);
    requireSafeInteger(payment.appliedRupiah, "payment.appliedRupiah", { nonNegative: true });
    requireSafeInteger(payment.tenderedRupiah, "payment.tenderedRupiah", { nonNegative: true });
    requireSafeInteger(payment.changeRupiah, "payment.changeRupiah", { nonNegative: true });
    if (payment.tenderedRupiah !== checkedAdd(payment.appliedRupiah, payment.changeRupiah, "payment.tendered")) throw reportingError("report_payment_tender_invariant_failed", payment.id);
    const expectedVerification = PAYMENT_VERIFICATION[payment.verificationLevel];
    if (!expectedVerification) throw reportingError("report_payment_verification_level_invalid", payment.id);
    if (payment.evidenceSource !== expectedVerification[0] || payment.evidenceStatus !== expectedVerification[1]) throw reportingError("report_payment_verification_evidence_invalid", payment.id);
    if (expectedVerification[1] === "VERIFIED") {
      if (!/^[0-9a-f]{64}$/.test(payment.evidenceFingerprint ?? "")) throw reportingError("report_payment_verification_evidence_invalid", payment.id);
      requireIsoInstant(payment.verifiedAt, "payment.verifiedAt");
    } else if (payment.evidenceFingerprint != null || payment.verifiedAt != null) {
      throw reportingError("report_payment_verification_evidence_invalid", payment.id);
    }
    const normalizedPayment = {
      ...payment,
      paymentAttemptId: requireText(payment.paymentAttemptId, "payment.paymentAttemptId"),
      methodNameSnapshot: requireText(payment.methodNameSnapshot, "payment.methodNameSnapshot"),
    };
    const billId = requireKnownBill(payment, billIds, "payment");
    if (payment.status === "SUCCEEDED") append(paymentsByBill, billId, normalizedPayment);
  }

  const refundsByBill = new Map();
  const reconciliationRefunds = [];
  for (const refund of refunds) {
    assertScopedRow(refund, query, allowedOutlets, "refund");
    if (!REFUND_STATES.has(refund.status)) throw reportingError("report_refund_status_invalid", refund.id);
    requireSafeInteger(refund.totalRupiah, "refund.totalRupiah", { nonNegative: true });
    requireSafeInteger(refund.netMenuRupiah, "refund.netMenuRupiah", { nonNegative: true });
    if (refund.netMenuRupiah > refund.totalRupiah) throw reportingError("report_refund_component_invalid", refund.id);
    const billId = requireKnownBill(refund, billIds, "refund");
    if (refund.status === "SUCCEEDED") append(refundsByBill, billId, refund);
    if (["FAILED", "RECONCILIATION_REQUIRED"].includes(refund.status)) reconciliationRefunds.push(refund.id);
  }

  for (const movement of cashMovements) {
    assertScopedRow(movement, query, allowedOutlets, "cashMovement");
    requireSafeInteger(movement.amountRupiah, "cashMovement.amountRupiah");
    if (movement.amountRupiah === 0) throw reportingError("report_cash_movement_zero", movement.id);
  }

  let actualSettlementCount = 0;
  for (const settlement of settlements) {
    assertScopedRow(settlement, query, allowedOutlets, "settlement");
    if (!SETTLEMENT_STATES.has(settlement.status)) throw reportingError("report_settlement_status_invalid", settlement.id);
    for (const field of ["appliedRupiah", "merchantFeeRupiah", "refundRupiah"]) requireSafeInteger(settlement[field], `settlement.${field}`, { nonNegative: true });
    requireSafeInteger(settlement.expectedPayoutRupiah, "settlement.expectedPayoutRupiah");
    const expectedPayout = checkedAdd(checkedAdd(settlement.appliedRupiah, -settlement.merchantFeeRupiah, "settlement.expectedPayout"), -settlement.refundRupiah, "settlement.expectedPayout");
    if (settlement.expectedPayoutRupiah !== expectedPayout) {
      throw reportingError("report_settlement_invariant_failed", settlement.id);
    }
    if (settlement.actualPayoutRupiah !== null && settlement.actualPayoutRupiah !== undefined) {
      requireSafeInteger(settlement.actualPayoutRupiah, "settlement.actualPayoutRupiah");
      actualSettlementCount += 1;
    }
  }

  const lineGroups = new Map(REPORT_LINE_KINDS.map((kind) => [kind, new Map()]));
  const linesByBill = new Map();
  let cogsEligibleLineCount = 0;
  let cogsCompleteLineCount = 0;
  let knownPartialCogsRupiah = 0;
  for (const line of saleLines) {
    assertScopedRow(line, query, allowedOutlets, "saleLine");
    const billId = requireKnownBill(line, billIds, "saleLine");
    if (!REPORT_LINE_KINDS.includes(line.lineKind)) throw reportingError("report_line_kind_invalid", line.id);
    const itemId = requireText(line.itemId, "saleLine.itemId");
    const itemNameSnapshot = requireText(line.itemNameSnapshot, "saleLine.itemNameSnapshot");
    const quantityMicros = parseQuantityMicros(line.quantity);
    requireSafeInteger(line.netMenuRupiah, "saleLine.netMenuRupiah", { nonNegative: true });
    const state = requireText(line.cogsCompleteness, "saleLine.cogsCompleteness");
    if (!COGS_STATES.has(state)) throw reportingError("report_cogs_state_invalid", line.id);
    if (line.cogsIncluded !== false) {
      cogsEligibleLineCount += 1;
      if (state === "COMPLETE") {
        requireSafeInteger(line.cogsRupiah, "saleLine.cogsRupiah", { nonNegative: true });
        knownPartialCogsRupiah = checkedAdd(knownPartialCogsRupiah, line.cogsRupiah, "cogs");
        cogsCompleteLineCount += 1;
      } else if (line.cogsRupiah !== null && line.cogsRupiah !== undefined) {
        requireSafeInteger(line.cogsRupiah, "saleLine.cogsRupiah", { nonNegative: true });
        knownPartialCogsRupiah = checkedAdd(knownPartialCogsRupiah, line.cogsRupiah, "knownPartialCogs");
      }
    }
    const group = lineGroups.get(line.lineKind);
    const existing = group.get(itemId) ?? { itemId, names: new Set(), quantityMicros: 0n, netMenuRupiah: 0, billIds: new Set() };
    existing.names.add(itemNameSnapshot);
    existing.quantityMicros += quantityMicros;
    existing.netMenuRupiah = checkedAdd(existing.netMenuRupiah, line.netMenuRupiah, "ranking.netMenuRupiah");
    existing.billIds.add(billId);
    group.set(itemId, existing);
    const billLines = linesByBill.get(billId) ?? new Map();
    if (!billLines.has(itemId)) billLines.set(itemId, itemNameSnapshot);
    linesByBill.set(billId, billLines);
  }

  const details = [...billById.values()].sort((left, right) => left.id.localeCompare(right.id)).map((bill) => {
    const billPayments = paymentsByBill.get(bill.id) ?? [];
    const billRefunds = refundsByBill.get(bill.id) ?? [];
    const appliedPaymentRupiah = addAmounts(billPayments, "appliedRupiah");
    const succeededRefundRupiah = addAmounts(billRefunds, "totalRupiah");
    const refundedNetMenuRupiah = addAmounts(billRefunds, "netMenuRupiah");
    return deepFreeze({
      billId: bill.id,
      billNumber: bill.billNumber,
      outletId: bill.outletId,
      orderedAt: requireIsoInstant(bill.orderedAt, "bill.orderedAt"),
      paidAt: requireIsoInstant(bill.paidAt, "bill.paidAt"),
      itemReferences: deepFreeze([...((linesByBill.get(bill.id) ?? new Map()).entries())]
        .map(([itemId, itemNameSnapshot]) => ({ itemId, itemNameSnapshot }))
        .sort((left, right) => left.itemId.localeCompare(right.itemId))),
      paymentVerifications: deepFreeze(billPayments.map((payment) => ({
        paymentAttemptId: payment.paymentAttemptId,
        methodNameSnapshot: payment.methodNameSnapshot,
        verificationLevel: payment.verificationLevel,
        evidenceSource: payment.evidenceSource,
        evidenceStatus: payment.evidenceStatus,
        evidenceFingerprint: payment.evidenceFingerprint ?? null,
        verifiedAt: payment.verifiedAt ?? null,
      })).sort((left, right) => left.paymentAttemptId.localeCompare(right.paymentAttemptId))),
      netMenuRupiah: bill.netMenuRupiah,
      succeededRefundRupiah,
      refundedNetMenuRupiah,
      netSalesAfterRefundRupiah: checkedAdd(bill.netMenuRupiah, -refundedNetMenuRupiah, "bill.netSalesAfterRefundRupiah"),
      appliedPaymentRupiah,
      billTotalRupiah: bill.totalRupiah,
      allocatedPax: bill.allocatedPax,
      policyVersion: requireText(bill.policyVersion ?? query.policyVersion, "bill.policyVersion"),
    });
  });

  const netMenuSalesRupiah = addAmounts(details, "netMenuRupiah");
  const succeededRefundRupiah = addAmounts(details, "succeededRefundRupiah");
  const refundedNetMenuRupiah = addAmounts(details, "refundedNetMenuRupiah");
  const netSalesAfterRefundRupiah = checkedAdd(netMenuSalesRupiah, -refundedNetMenuRupiah, "netSalesAfterRefundRupiah");
  const appliedPaymentRupiah = addAmounts(details, "appliedPaymentRupiah");
  const eligiblePax = details.reduce((total, row) => checkedAdd(total, row.allocatedPax, "eligiblePax"), 0);
  const cashFlowRupiah = addAmounts(cashMovements, "amountRupiah");
  const providerExpectedPayoutRupiah = addAmounts(settlements, "expectedPayoutRupiah");
  const providerActualPayoutRupiah = actualSettlementCount === 0
    ? null
    : settlements.reduce((total, row) => row.actualPayoutRupiah == null ? total : checkedAdd(total, row.actualPayoutRupiah, "actualPayout"), 0);

  const hasSucceededRefund = [...refundsByBill.values()].some((rows) => rows.length > 0);
  const refundCogsComplete = !hasSucceededRefund || source.refundCogsComplete === true;
  const cogsComplete = bills.length === 0 || (saleLines.length > 0 && cogsEligibleLineCount > 0 && cogsCompleteLineCount === cogsEligibleLineCount && refundCogsComplete);
  const cogsRupiah = cogsComplete ? knownPartialCogsRupiah : null;
  const grossMarginRupiah = cogsComplete ? checkedAdd(netSalesAfterRefundRupiah, -cogsRupiah, "grossMarginRupiah") : null;
  const incompleteReasons = normalizeReasons(source.incompleteReasons);
  if (bills.length > 0 && saleLines.length === 0) incompleteReasons.add("SALE_LINES_MISSING");
  if (!cogsComplete) incompleteReasons.add("COGS_INCOMPLETE");
  if (!refundCogsComplete) incompleteReasons.add("REFUND_COGS_INCOMPLETE");
  if (reconciliationRefunds.length) incompleteReasons.add("REFUND_RECONCILIATION_REQUIRED");
  if (details.some((row) => row.appliedPaymentRupiah !== row.billTotalRupiah)) incompleteReasons.add("PAID_BILL_PAYMENT_MISMATCH");
  if (source.dataComplete !== true) incompleteReasons.add("SOURCE_MARKED_INCOMPLETE");

  const denominator = deepFreeze({
    eligibleBillCount: details.length,
    eligiblePax,
    appliedPaymentRupiah,
    cashMovementCount: cashMovements.length,
    settlementCount: settlements.length,
    actualSettlementCount,
    cogsEligibleLineCount,
    cogsCompleteLineCount,
  });
  const summary = deepFreeze({
    netMenuSalesRupiah,
    succeededRefundRupiah,
    refundedNetMenuRupiah,
    netSalesAfterRefundRupiah,
    appliedPaymentRupiah,
    cashFlowRupiah,
    providerExpectedPayoutRupiah,
    providerActualPayoutRupiah,
    averageBillRupiah: roundRatio(netSalesAfterRefundRupiah, details.length),
    averagePaxRupiah: roundRatio(netSalesAfterRefundRupiah, eligiblePax),
    knownPartialCogsRupiah,
    cogsRupiah,
    grossMarginRupiah,
    cogsCompleteness: bills.length === 0 ? "NO_SALES" : cogsComplete ? "COMPLETE" : "INCOMPLETE",
    settlementIncludedInSales: false,
    paymentUsesAppliedNotTendered: true,
  });
  const rankings = deepFreeze(Object.fromEntries(REPORT_LINE_KINDS.map((kind) => [kind, rankEntries(lineGroups.get(kind), details.length)])));
  const reasons = [...incompleteReasons].sort();
  const envelope = deepFreeze({
    contract_version: REPORT_CONTRACT_VERSION,
    metric_id: query.metricId,
    organization_scope: query.organizationId,
    outlet_scope: query.outletIds,
    period_start_utc: query.periodStartUtc,
    period_end_utc: query.periodEndUtc,
    interval_boundary: query.intervalBoundary,
    timezone: query.timezone,
    business_date_cutoff_local: query.businessDateCutoffLocal,
    time_basis: query.timeBasis,
    included_statuses: query.includedStatuses,
    currency: query.currency,
    policy_version: query.policyVersion,
    snapshot_cutoff_utc: query.snapshotCutoffUtc,
    generated_at_utc: generatedAt,
    freshness_seconds: freshnessSeconds,
    data_complete: reasons.length === 0,
    incomplete_reasons: reasons,
    denominator,
  });
  const fingerprint = fingerprintReport({ envelope, summary, details, rankings });
  return deepFreeze({ version: 1, reportFingerprint: fingerprint, envelope, summary, details, rankings });
}

export function createReportViews(report, { csvBuilder } = {}) {
  if (!report?.reportFingerprint || !report?.envelope || !report?.summary) throw reportingError("report_snapshot_required");
  if (typeof csvBuilder !== "function") throw reportingError("report_csv_builder_required");
  return deepFreeze({
    dashboard: {
      reportFingerprint: report.reportFingerprint,
      envelope: report.envelope,
      summary: report.summary,
      rankings: report.rankings,
    },
    detail: {
      reportFingerprint: report.reportFingerprint,
      envelope: report.envelope,
      summary: report.summary,
      rows: report.details,
    },
    export: {
      reportFingerprint: report.reportFingerprint,
      envelope: report.envelope,
      summary: report.summary,
      csv: csvBuilder(report),
    },
  });
}

function assertScopedRow(row, query, allowedOutlets, grain) {
  if (row.organizationId !== query.organizationId || !allowedOutlets.has(row.outletId)) {
    throw reportingError("report_source_scope_mismatch", `${grain}:${row?.id ?? "unknown"}`);
  }
}

function requireKnownBill(row, billIds, grain) {
  const billId = requireText(row.billId, `${grain}.billId`);
  if (!billIds.has(billId)) throw reportingError("report_source_unknown_bill", `${grain}:${row.id}`);
  return billId;
}

function moneyFields(row, fields, signed = new Set()) {
  return Object.fromEntries(fields.map((field) => [field, requireSafeInteger(row[field], field, { nonNegative: !signed.has(field) })]));
}

function append(map, key, value) {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function parseQuantityMicros(value) {
  if (typeof value !== "string" || !/^\d+\.\d{6}$/.test(value)) throw reportingError("report_quantity_invalid", value);
  const [whole, fractional] = value.split(".");
  const result = BigInt(whole) * 1_000_000n + BigInt(fractional);
  if (result <= 0n) throw reportingError("report_quantity_invalid", value);
  return result;
}

function formatQuantityMicros(value) {
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function rankEntries(group, eligibleBillCount) {
  return [...group.values()].map((row) => {
    const names = [...row.names].sort();
    return deepFreeze({
      itemId: row.itemId,
      itemNameSnapshot: names[0],
      snapshotNames: names,
      hasMultipleSnapshotNames: names.length > 1,
      quantity: formatQuantityMicros(row.quantityMicros),
      netMenuRupiah: row.netMenuRupiah,
      eligibleBillCount: row.billIds.size,
      transactionShareBps: roundRatio(row.billIds.size * 10_000, eligibleBillCount),
      denominator: eligibleBillCount,
    });
  }).sort((left, right) => right.netMenuRupiah - left.netMenuRupiah || left.itemId.localeCompare(right.itemId));
}

function normalizeReasons(reasons) {
  if (reasons === undefined) return new Set();
  if (!Array.isArray(reasons)) throw reportingError("report_incomplete_reasons_invalid");
  return new Set(reasons.map((reason) => requireText(reason, "incompleteReason")));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprintReport(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
