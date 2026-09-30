const DANGEROUS_FORMULA_PREFIX = /^[\s\u0000-\u001f]*[=+\-@]/;

export function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && DANGEROUS_FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function rowsToCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function ownerReportCsv(report) {
  const e = report.envelope;
  const t = report.summary;
  const rows = [
    ["SagaPOS Owner Report", report.reportFingerprint],
    ["Contract", e.contract_version],
    ["Metric", e.metric_id],
    ["Organization", e.organization_scope],
    ["Outlets", e.outlet_scope.join(" | ")],
    ["Period start UTC", e.period_start_utc],
    ["Period end UTC", e.period_end_utc],
    ["Interval", e.interval_boundary],
    ["Timezone", e.timezone],
    ["Business date cutoff", e.business_date_cutoff_local],
    ["Time basis", e.time_basis],
    ["Included statuses", e.included_statuses.join(" | ")],
    ["Snapshot cutoff UTC", e.snapshot_cutoff_utc],
    ["Generated at UTC", e.generated_at_utc],
    ["Freshness seconds", e.freshness_seconds],
    ["Currency", e.currency],
    ["Policy version", e.policy_version],
    ["Data complete", e.data_complete],
    ["Incomplete reasons", e.incomplete_reasons.join(" | ")],
    [],
    ["Metric ID", "Value", "Denominator", "Unit"],
    ["net_menu_sales", t.netMenuSalesRupiah, e.denominator.eligibleBillCount, "IDR"],
    ["succeeded_refunds", t.succeededRefundRupiah, e.denominator.eligibleBillCount, "IDR"],
    ["net_sales_after_refund", t.netSalesAfterRefundRupiah, e.denominator.eligibleBillCount, "IDR"],
    ["applied_payment", t.appliedPaymentRupiah, e.denominator.appliedPaymentRupiah, "IDR"],
    ["cash_flow", t.cashFlowRupiah, e.denominator.cashMovementCount, "IDR"],
    ["provider_settlement_expected", t.providerExpectedPayoutRupiah, e.denominator.settlementCount, "IDR"],
    ["provider_settlement_actual", t.providerActualPayoutRupiah, e.denominator.actualSettlementCount, "IDR"],
    ["average_bill", t.averageBillRupiah, e.denominator.eligibleBillCount, "IDR_PER_BILL"],
    ["average_pax", t.averagePaxRupiah, e.denominator.eligiblePax, "IDR_PER_PAX"],
    ["cogs", t.cogsRupiah, e.denominator.cogsEligibleLineCount, "IDR"],
    ["gross_margin", t.grossMarginRupiah, e.denominator.cogsEligibleLineCount, "IDR"],
    [],
    ["Bill ID", "Bill number", "Outlet", "Ordered at", "Paid at", "Stable item references", "Payment verification", "Net menu", "Refund", "Net after refund", "Applied payment", "Total bill", "Pax", "Policy"],
    ...report.details.map((row) => [
      row.billId,
      row.billNumber,
      row.outletId,
      row.orderedAt,
      row.paidAt,
      row.itemReferences.map((item) => `${item.itemNameSnapshot} [${item.itemId}]`).join(" | "),
      row.paymentVerifications.map((payment) => `${payment.paymentAttemptId}:${payment.verificationLevel}:${payment.evidenceSource}:${payment.evidenceStatus}:${payment.evidenceFingerprint ?? ""}:${payment.verifiedAt ?? ""}`).join(" | "),
      row.netMenuRupiah,
      row.succeededRefundRupiah,
      row.netSalesAfterRefundRupiah,
      row.appliedPaymentRupiah,
      row.billTotalRupiah,
      row.allocatedPax,
      row.policyVersion,
    ]),
    [],
    ["Ranking grain", "Stable item ID", "Snapshot name", "Quantity", "Net menu", "Bill count", "Transaction share bps"],
    ...Object.entries(report.rankings).flatMap(([kind, entries]) => entries.map((row) => [
      kind,
      row.itemId,
      row.itemNameSnapshot,
      row.quantity,
      row.netMenuRupiah,
      row.eligibleBillCount,
      row.transactionShareBps,
    ])),
  ];
  return rowsToCsv(rows);
}
