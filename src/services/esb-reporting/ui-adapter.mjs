import { deepFreeze, reportingError } from "./contract.mjs";

const METRICS = deepFreeze({
  net_menu_sales: { label: "Penjualan menu bersih", summaryField: "netMenuSalesRupiah", rankingField: "netMenuRupiah" },
});

export function toReportShellModel(report, { metricId = "net_menu_sales", rankingKind = "MAIN" } = {}) {
  const metric = METRICS[metricId];
  if (!metric) throw reportingError("report_ui_metric_invalid", metricId);
  const ranking = report?.rankings?.[rankingKind];
  if (!Array.isArray(ranking)) throw reportingError("report_ui_ranking_kind_invalid", rankingKind);
  const e = report.envelope;
  const display = reportDisplayValues(report);
  const points = ranking.length
    ? ranking.map((row) => deepFreeze({ label: itemDisplay(row), value: row[metric.rankingField], formattedValue: formatIdr(row[metric.rankingField]) }))
    : [deepFreeze({ label: "Belum ada data", value: 0, formattedValue: "Rp0" })];
  return deepFreeze({
    id: `owner-${metricId}-${rankingKind.toLowerCase()}`,
    title: "Laporan Owner",
    description: `${metric.label}; angka berasal dari snapshot authoritative yang sama dengan detail dan CSV.`,
    metadata: {
      outlet: e.outlet_scope.join(", "),
      period: `${e.period_start_utc} — ${e.period_end_utc}`,
      timeBasis: e.time_basis,
      includedStatuses: e.included_statuses.join(", "),
      cutoff: e.snapshot_cutoff_utc,
      freshness: `${e.freshness_seconds} detik`,
      denominator: `${e.denominator.eligibleBillCount} bill / ${e.denominator.eligiblePax} pax`,
      currency: e.currency,
      policyVersion: e.policy_version,
      completeness: e.data_complete ? "Lengkap" : `Belum lengkap: ${e.incomplete_reasons.join(", ")}`,
    },
    metric: {
      value: metricId,
      defaultValue: "net_menu_sales",
      options: Object.entries(METRICS).map(([value, definition]) => ({ value, label: definition.label })),
    },
    chartLabel: `${metric.label} — ${rankingKind}`,
    points,
    columns: [
      { key: "itemNameSnapshot", label: "Item" },
      { key: "itemReference", label: "Kode/ID stabil" },
      { key: "quantity", label: "Jumlah" },
      { key: "formattedNetMenu", label: "Penjualan" },
      { key: "formattedShare", label: "Porsi transaksi" },
    ],
    rows: ranking.map((row) => ({
      itemNameSnapshot: row.itemNameSnapshot,
      itemReference: row.itemId,
      quantity: row.quantity,
      formattedNetMenu: formatIdr(row.netMenuRupiah),
      formattedShare: row.transactionShareBps === null ? "—" : `${formatBps(row.transactionShareBps)}%`,
    })),
    authoritativeValues: display,
    state: report.details.length === 0 ? { kind: "empty" } : undefined,
    reportFingerprint: report.reportFingerprint,
  });
}

function itemDisplay(row) {
  return `${row.itemNameSnapshot} [${row.itemId}]`;
}

export function reportDisplayValues(report) {
  const s = report?.summary;
  if (!s) throw reportingError("report_snapshot_required");
  return deepFreeze({
    netMenuSales: formatIdr(s.netMenuSalesRupiah),
    refunds: formatIdr(s.succeededRefundRupiah),
    netSalesAfterRefund: formatIdr(s.netSalesAfterRefundRupiah),
    appliedPayment: formatIdr(s.appliedPaymentRupiah),
    cashFlow: formatIdr(s.cashFlowRupiah),
    expectedSettlement: formatIdr(s.providerExpectedPayoutRupiah),
    actualSettlement: formatIdr(s.providerActualPayoutRupiah),
    averageBill: formatIdr(s.averageBillRupiah),
    averagePax: formatIdr(s.averagePaxRupiah),
    cogs: formatIdr(s.cogsRupiah),
    grossMargin: formatIdr(s.grossMarginRupiah),
  });
}

export function formatIdr(value) {
  if (value === null || value === undefined) return "—";
  return `Rp${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(value)}`;
}

function formatBps(value) {
  const whole = Math.trunc(value / 100);
  const fraction = String(Math.abs(value % 100)).padStart(2, "0");
  return `${whole},${fraction}`;
}
