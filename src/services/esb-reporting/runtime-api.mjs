import { ownerReportCsv } from "./csv.mjs";
import { createEsbOwnerReportingService } from "./report-service.mjs";
import { formatIdr, toReportShellModel } from "./ui-adapter.mjs";

const ALLOWED_REPORT_QUERY = new Set(["fromDate", "toDate", "timeBasis", "rankingKind", "metricId"]);
const ALLOWED_SNAPSHOT_QUERY = new Set(["fingerprint"]);
const TIME_BASES = new Set(["ORDERED_AT", "PAID_AT", "BUSINESS_DATE"]);
const RANKING_KINDS = new Set(["MAIN", "MODIFIER", "BUNDLE_COMPONENT"]);
const METRICS = new Set(["net_menu_sales"]);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEFAULT_CUTOFF = "04:00:00";
const MAX_REPORT_DAYS = 366;

export function createEsbOwnerReportRuntimeApi({
  runtime,
  clock = () => new Date(),
  snapshotTtlMs = 5 * 60_000,
  maximumSnapshots = 40,
  businessDateCutoffLocal = DEFAULT_CUTOFF,
} = {}) {
  if (!runtime || typeof runtime !== "object") throw runtimeError("report_runtime_unavailable", 503);
  if (!Number.isInteger(snapshotTtlMs) || snapshotTtlMs < 1_000 || snapshotTtlMs > 30 * 60_000) throw new TypeError("report_snapshot_ttl_invalid");
  if (!Number.isInteger(maximumSnapshots) || maximumSnapshots < 1 || maximumSnapshots > 200) throw new TypeError("report_snapshot_limit_invalid");
  if (!/^\d{2}:\d{2}:\d{2}$/.test(businessDateCutoffLocal)) throw new TypeError("report_business_cutoff_invalid");

  const snapshots = new Map();

  return Object.freeze({
    async load({ actor, searchParams, sessionKey } = {}) {
      assertOwner(actor);
      const filters = parseReportFilters(searchParams);
      const context = await loadAuthorizedContext({ runtime, actor });
      const now = validClockInstant(clock);
      const requestedStart = zonedBoundary(filters.fromDate, businessDateCutoffLocal, context.timezone);
      const requestedEnd = zonedBoundary(addUtcDays(filters.toDate, 1), businessDateCutoffLocal, context.timezone);
      const periodEnd = new Date(Math.min(requestedEnd.getTime(), now.getTime()));
      if (requestedStart.getTime() >= periodEnd.getTime()) throw runtimeError("report_period_not_available", 422);
      if ((requestedEnd.getTime() - requestedStart.getTime()) / 86_400_000 > MAX_REPORT_DAYS + 2) throw runtimeError("report_period_too_large", 422);

      const query = {
        organizationId: context.organizationId,
        outletIds: [context.outletId],
        periodStartUtc: requestedStart.toISOString(),
        periodEndUtc: periodEnd.toISOString(),
        timezone: context.timezone,
        businessDateCutoffLocal,
        timeBasis: filters.timeBasis,
        includedStatuses: ["PAID"],
        currency: "IDR",
        policyVersion: "IMMUTABLE_BILL_SNAPSHOT_V1",
        snapshotCutoffUtc: now.toISOString(),
        metricId: "owner_operational_summary",
      };
      const reportSourcePort = createPostgresReportSourcePort({
        repository: runtime.repository,
        context,
        filters,
      });
      const reporting = createEsbOwnerReportingService({
        reportSourcePort,
        clock: () => now.toISOString(),
      });
      let report;
      try {
        report = await reporting.build(query);
      } catch (error) {
        if (error?.statusCode) throw error;
        throw runtimeError("report_authoritative_source_unavailable", 503, error);
      }
      const key = requireSessionKey(sessionKey);
      storeSnapshot(snapshots, `${key}:${report.reportFingerprint}`, {
        report,
        filters,
        outletName: context.outletName,
        expiresAt: now.getTime() + snapshotTtlMs,
      }, { now: now.getTime(), maximumSnapshots });
      return ownerReportPayload(report, filters, context.outletName);
    },

    csv({ actor, searchParams, sessionKey } = {}) {
      assertOwner(actor);
      const snapshot = requireSnapshot(snapshots, searchParams, sessionKey, validClockInstant(clock).getTime());
      return Object.freeze({
        csv: ownerReportCsv(snapshot.report),
        filename: reportFilename(snapshot.filters),
        reportFingerprint: snapshot.report.reportFingerprint,
      });
    },

    bill({ actor, searchParams, sessionKey, billId } = {}) {
      assertOwner(actor);
      if (!UUID.test(String(billId ?? ""))) throw runtimeError("report_bill_not_found", 404);
      const snapshot = requireSnapshot(snapshots, searchParams, sessionKey, validClockInstant(clock).getTime());
      const row = snapshot.report.details.find((candidate) => candidate.billId === billId);
      if (!row) throw runtimeError("report_bill_not_found", 404);
      return Object.freeze({
        reportFingerprint: snapshot.report.reportFingerprint,
        envelope: snapshot.report.envelope,
        bill: formatBillRow(row, snapshot.report.reportFingerprint),
      });
    },
  });
}

export function createPostgresReportSourcePort({ repository, context, filters } = {}) {
  const db = repository?.db;
  if (!db?.query || !db?.transaction) throw runtimeError("report_authoritative_source_unavailable", 503);
  return Object.freeze({
    async loadAuthorizedReportSource(query) {
      assertReadGuard(repository);
      try {
        return await db.transaction(async (tx) => {
          await tx.query("set transaction isolation level repeatable read read only");
          const scope = await tx.query(`/* esb_owner_report:scope */
            select outlet.id, outlet.organization_id, outlet.timezone
              from sagaops.outlets outlet
              join sagaops.outlet_user_roles role
                on role.organization_id=outlet.organization_id
               and role.outlet_id=outlet.id
               and role.user_profile_id=$3
               and role.role='owner'
             where outlet.organization_id=$1 and outlet.id=$2`,
          [context.organizationId, context.outletId, context.ownerProfileId]);
          if (!scope.rows[0]) throw runtimeError("report_owner_scope_denied", 403);

          const billResult = await tx.query(billSql(filters.timeBasis), reportScopeParams({ context, query, filters }));
          const billRows = billResult.rows ?? [];
          if (billRows.some((row) => row.allocation_completeness !== "COMPLETE")) {
            throw runtimeError("report_authoritative_source_incomplete", 503);
          }
          if (billRows.some((row) => String(row.order_status).toLowerCase() === "partially_refunded")) {
            throw runtimeError("report_refund_allocation_unavailable", 503);
          }
          const billIds = billRows.map((row) => row.id);
          const orderIds = billRows.map((row) => row.order_id);
          let paymentRows = [];
          let saleLineRows = [];
          if (billIds.length > 0) {
            paymentRows = (await tx.query(`/* esb_owner_report:payments */
              select allocation.id, allocation.bill_id, attempt.id as payment_attempt_id, attempt.status,
                     attempt.method_name_snapshot, attempt.verification_level, attempt.provider,
                     allocation.applied_rupiah,
                     case when row_number() over (partition by attempt.id order by allocation.bill_id)=1 then attempt.change_rupiah else 0 end as allocated_change_rupiah,
                     attempt.organization_id, attempt.outlet_id,
                     verification_event.occurred_at as verification_occurred_at,
                     verification_event.event_fingerprint as verification_event_fingerprint
                from sagaops.esb_bill_payment_allocations allocation
                join sagaops.esb_payment_attempts attempt
                  on attempt.id=allocation.payment_attempt_id
                 and attempt.organization_id=allocation.organization_id
                 and attempt.outlet_id=allocation.outlet_id
                left join lateral (
                  select event.occurred_at,event.event_fingerprint
                    from sagaops.esb_payment_events event
                   where event.organization_id=attempt.organization_id
                     and event.outlet_id=attempt.outlet_id
                     and event.payment_attempt_id=attempt.id
                     and event.status_after='SUCCEEDED'
                     and (
                       (attempt.verification_level='PROVIDER_VERIFIED' and event.provider=attempt.provider and event.external_event_id is not null)
                       or (attempt.verification_level='CASH' and event.event_type='CASH_ACCEPTED')
                     )
                   order by event.occurred_at desc,event.id desc
                   limit 1
                ) verification_event on true
               where allocation.organization_id=$1 and allocation.outlet_id=$2
                 and allocation.bill_id=any($3::uuid[])
               order by attempt.id, allocation.bill_id`, [context.organizationId, context.outletId, billIds])).rows ?? [];
            saleLineRows = (await tx.query(`/* esb_owner_report:sale_lines */
              select line.id, line.bill_id, line.organization_id, line.outlet_id,
                     line.line_kind, coalesce(line.item_reference,line.stable_line_id) as item_id,
                     line.item_name_snapshot, line.quantity,
                     line.net_menu_rupiah, item.recipe_cost_snapshot_rupiah,
                     item.hpp_snapshot_status
                from sagaops.esb_bill_lines line
                left join sagaops.order_items item on item.id=line.order_item_id
               where line.organization_id=$1 and line.outlet_id=$2
                 and line.bill_id=any($3::uuid[])
               order by line.id`, [context.organizationId, context.outletId, billIds])).rows ?? [];
          }

          const cashResult = await tx.query(cashSql(filters.timeBasis), reportScopeParams({ context, query, filters }));
          const settlementResult = await tx.query(`/* esb_owner_report:settlements */
              select id, organization_id, outlet_id, status, applied_rupiah,
                     merchant_fee_rupiah, refund_rupiah, expected_payout_rupiah,
                     actual_payout_rupiah
                from sagaops.esb_provider_settlements
               where organization_id=$1 and outlet_id=$2
                 and period_end_utc>$3::timestamptz and period_start_utc<$4::timestamptz
                 and created_at<=$5::timestamptz
               order by id`, [context.organizationId, context.outletId, query.periodStartUtc, query.periodEndUtc, query.snapshotCutoffUtc]);
          const gatewayRefundResult = orderIds.length === 0
            ? { rows: [] }
            : await tx.query(`/* esb_owner_report:gateway_refunds */
                  select id, order_id, amount_rupiah, status
                    from sagaops.gateway_refund_requests
                   where organization_id=$1 and outlet_id=$2
                     and order_id=any($3::uuid[]) and requested_at<=$4::timestamptz
                   order by id`, [context.organizationId, context.outletId, orderIds, query.snapshotCutoffUtc]);

          return sourceProjection({
            query,
            billRows,
            paymentRows,
            saleLineRows,
            cashRows: cashResult.rows ?? [],
            settlementRows: settlementResult.rows ?? [],
            gatewayRefundRows: gatewayRefundResult.rows ?? [],
          });
        });
      } catch (error) {
        if (error?.statusCode) throw error;
        throw runtimeError("report_authoritative_source_unavailable", 503, error);
      }
    },
  });
}

function ownerReportPayload(report, filters, outletName) {
  const model = toReportShellModel(report, { metricId: filters.metricId, rankingKind: filters.rankingKind });
  const detailRows = report.details.map((row) => formatBillRow(row, report.reportFingerprint));
  return Object.freeze({
    model,
    detail: Object.freeze({
      reportFingerprint: report.reportFingerprint,
      caption: `Rincian bill · ${outletName} · ${filters.fromDate} sampai ${filters.toDate}`,
      columns: Object.freeze([
        { key: "billNumber", label: "Bill" },
        { key: "orderedAt", label: "Waktu pesanan" },
        { key: "paidAt", label: "Waktu pembayaran" },
        { key: "items", label: "Item · kode stabil" },
        { key: "paymentVerification", label: "Verifikasi pembayaran" },
        { key: "netMenu", label: "Penjualan menu" },
        { key: "refund", label: "Refund" },
        { key: "netAfterRefund", label: "Setelah refund" },
        { key: "appliedPayment", label: "Pembayaran diterapkan" },
        { key: "pax", label: "Pax" },
      ]),
      rows: Object.freeze(detailRows),
    }),
    export: Object.freeze({
      reportFingerprint: report.reportFingerprint,
      href: `/api/operator/reports/esb-owner.csv?fingerprint=${report.reportFingerprint}`,
      filename: reportFilename(filters),
    }),
  });
}

function formatBillRow(row, fingerprint) {
  return Object.freeze({
    billId: row.billId,
    billNumber: row.billNumber,
    outletId: row.outletId,
    orderedAt: row.orderedAt,
    paidAt: row.paidAt,
    items: row.itemReferences.map((item) => `${item.itemNameSnapshot} [${item.itemId}]`).join(" | "),
    paymentVerification: row.paymentVerifications.map(formatPaymentVerification).join(" | "),
    netMenu: formatIdr(row.netMenuRupiah),
    refund: formatIdr(row.succeededRefundRupiah),
    netAfterRefund: formatIdr(row.netSalesAfterRefundRupiah),
    appliedPayment: formatIdr(row.appliedPaymentRupiah),
    billTotal: formatIdr(row.billTotalRupiah),
    pax: String(row.allocatedPax),
    policyVersion: row.policyVersion,
    detailHref: `/api/operator/reports/esb-owner/bills/${row.billId}?fingerprint=${fingerprint}`,
  });
}

function formatPaymentVerification(payment) {
  const evidence = payment.evidenceFingerprint ? ` · bukti ${payment.evidenceFingerprint.slice(0, 12)}` : "";
  const verifiedAt = payment.verifiedAt ? ` · ${payment.verifiedAt}` : "";
  return `${payment.methodNameSnapshot} [${payment.verificationLevel}/${payment.evidenceSource}/${payment.evidenceStatus}]${evidence}${verifiedAt}`;
}

function sourceProjection({ query, billRows, paymentRows, saleLineRows, cashRows, settlementRows, gatewayRefundRows }) {
  const billByOrder = new Map(billRows.map((row) => [row.order_id, row]));
  const refunds = [];
  let refundCogsComplete = true;
  for (const bill of billRows) {
    if (String(bill.order_status).toLowerCase() !== "refunded") continue;
    refundCogsComplete = false;
    refunds.push({
      id: `legacy-full-refund:${bill.order_id}`,
      billId: bill.id,
      organizationId: bill.organization_id,
      outletId: bill.outlet_id,
      status: "SUCCEEDED",
      totalRupiah: integer(bill.total_rupiah, "refund.total"),
      netMenuRupiah: integer(bill.net_menu_rupiah, "refund.netMenu"),
    });
  }
  for (const refund of gatewayRefundRows) {
    const bill = billByOrder.get(refund.order_id);
    if (!bill || String(refund.status).toLowerCase() === "rejected") continue;
    if (String(refund.status).toLowerCase() === "reconciled" && String(bill.order_status).toLowerCase() === "refunded") continue;
    refunds.push({
      id: refund.id,
      billId: bill.id,
      organizationId: bill.organization_id,
      outletId: bill.outlet_id,
      status: String(refund.status).toLowerCase() === "reconciled" ? "SUCCEEDED" : "RECONCILIATION_REQUIRED",
      totalRupiah: integer(refund.amount_rupiah, "gatewayRefund.amount"),
      netMenuRupiah: String(refund.status).toLowerCase() === "reconciled" ? integer(bill.net_menu_rupiah, "gatewayRefund.netMenu") : 0,
    });
    refundCogsComplete = false;
  }

  const bills = billRows.map((row) => ({
    id: row.id,
    billNumber: row.bill_number,
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    status: row.status,
    menuGrossRupiah: integer(row.menu_gross_rupiah, "bill.menuGross"),
    lineDiscountRupiah: integer(row.line_discount_rupiah, "bill.lineDiscount"),
    billDiscountRupiah: integer(row.bill_discount_rupiah, "bill.billDiscount"),
    netMenuRupiah: integer(row.net_menu_rupiah, "bill.netMenu"),
    taxRupiah: integer(row.tax_rupiah, "bill.tax"),
    serviceRupiah: integer(row.service_rupiah, "bill.service"),
    customerFeeRupiah: integer(row.customer_fee_rupiah, "bill.customerFee"),
    roundingAdjustmentRupiah: integer(row.rounding_adjustment_rupiah, "bill.rounding"),
    totalRupiah: integer(row.total_rupiah, "bill.total"),
    allocatedPax: integer(row.allocated_pax, "bill.pax"),
    policyVersion: row.policy_version || row.contract_version,
    orderedAt: instant(row.ordered_at, "bill.orderedAt"),
    paidAt: instant(row.paid_at, "bill.paidAt"),
  }));
  const payments = paymentRows.map((row) => {
    const applied = integer(row.applied_rupiah, "payment.applied");
    const change = integer(row.allocated_change_rupiah, "payment.change");
    return {
      id: row.id,
      billId: row.bill_id,
      organizationId: row.organization_id,
      outletId: row.outlet_id,
      status: row.status,
      paymentAttemptId: row.payment_attempt_id,
      methodNameSnapshot: row.method_name_snapshot,
      verificationLevel: row.verification_level,
      evidenceSource: verificationEvidenceSource(row.verification_level),
      evidenceStatus: ["CASH", "PROVIDER_VERIFIED"].includes(row.verification_level) ? "VERIFIED" : row.verification_level === "LEGACY_UNVERIFIED" ? "UNVERIFIED" : "MANUAL",
      evidenceFingerprint: row.verification_event_fingerprint ?? null,
      verifiedAt: row.verification_occurred_at == null ? null : instant(row.verification_occurred_at, "payment.verifiedAt"),
      appliedRupiah: applied,
      changeRupiah: change,
      tenderedRupiah: safeAdd(applied, change, "payment.tendered"),
    };
  });
  for (const payment of payments) {
    if (["CASH", "PROVIDER_VERIFIED"].includes(payment.verificationLevel) && (!payment.evidenceFingerprint || !payment.verifiedAt)) {
      throw runtimeError("report_payment_verification_evidence_unavailable", 503);
    }
  }
  const saleLines = saleLineRows.map((row) => {
    const main = row.line_kind === "MAIN";
    const hppState = String(row.hpp_snapshot_status ?? "unverified").toLowerCase();
    const cogsComplete = main && hppState === "verified" && row.recipe_cost_snapshot_rupiah != null;
    return {
      id: row.id,
      billId: row.bill_id,
      organizationId: row.organization_id,
      outletId: row.outlet_id,
      lineKind: row.line_kind,
      itemId: row.item_id,
      itemNameSnapshot: row.item_name_snapshot,
      quantity: quantity(row.quantity),
      netMenuRupiah: integer(row.net_menu_rupiah, "saleLine.netMenu"),
      cogsIncluded: main,
      cogsCompleteness: main ? (cogsComplete ? "COMPLETE" : "INCOMPLETE") : "UNKNOWN",
      cogsRupiah: cogsComplete
        ? multiplyRupiahByQuantity(row.recipe_cost_snapshot_rupiah, row.quantity, "saleLine.cogs")
        : null,
    };
  });
  return {
    appliedFilter: {
      organizationId: query.organizationId,
      outletIds: query.outletIds,
      periodStartUtc: query.periodStartUtc,
      periodEndUtc: query.periodEndUtc,
      intervalBoundary: query.intervalBoundary,
      timeBasis: query.timeBasis,
      includedStatuses: query.includedStatuses,
      currency: query.currency,
      policyVersion: query.policyVersion,
      snapshotCutoffUtc: query.snapshotCutoffUtc,
    },
    dataComplete: true,
    incompleteReasons: [],
    refundCogsComplete,
    bills,
    payments,
    refunds,
    cashMovements: cashRows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      outletId: row.outlet_id,
      amountRupiah: integer(row.amount_rupiah, "cash.amount"),
    })),
    settlements: settlementRows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      outletId: row.outlet_id,
      status: row.status,
      appliedRupiah: integer(row.applied_rupiah, "settlement.applied"),
      merchantFeeRupiah: integer(row.merchant_fee_rupiah, "settlement.fee"),
      refundRupiah: integer(row.refund_rupiah, "settlement.refund"),
      expectedPayoutRupiah: integer(row.expected_payout_rupiah, "settlement.expected"),
      actualPayoutRupiah: row.actual_payout_rupiah == null ? null : integer(row.actual_payout_rupiah, "settlement.actual"),
    })),
    saleLines,
  };
}

async function loadAuthorizedContext({ runtime, actor }) {
  assertReadGuard(runtime.repository);
  const ids = runtime.ids;
  if (!ids?.organizationId || !ids?.outletId || !ids?.ownerProfileId) throw runtimeError("report_server_scope_unavailable", 503);
  const db = runtime.repository?.db;
  if (!db?.query || !db?.transaction) throw runtimeError("report_authoritative_source_unavailable", 503);
  let result;
  try {
    result = await db.query(`/* esb_owner_report:context */
      select outlet.id, outlet.organization_id, outlet.name, outlet.timezone
        from sagaops.outlets outlet
        join sagaops.outlet_user_roles role
          on role.organization_id=outlet.organization_id
         and role.outlet_id=outlet.id
         and role.user_profile_id=$3
         and role.role='owner'
       where outlet.organization_id=$1 and outlet.id=$2`,
    [ids.organizationId, ids.outletId, ids.ownerProfileId]);
  } catch (error) {
    throw runtimeError("report_authoritative_source_unavailable", 503, error);
  }
  const row = result.rows?.[0];
  if (!row) throw runtimeError("report_owner_scope_denied", 403);
  if (actor.role !== "owner") throw runtimeError("report_owner_scope_denied", 403);
  const timezone = validTimezone(row.timezone);
  return Object.freeze({
    organizationId: ids.organizationId,
    outletId: ids.outletId,
    ownerProfileId: ids.ownerProfileId,
    outletName: String(row.name ?? "Outlet Owner").slice(0, 120),
    timezone,
  });
}

function parseReportFilters(searchParams) {
  assertAllowedParams(searchParams, ALLOWED_REPORT_QUERY);
  const fromDate = dateParam(searchParams, "fromDate");
  const toDate = dateParam(searchParams, "toDate");
  if (fromDate > toDate) throw runtimeError("report_period_invalid", 422);
  const timeBasis = singleParam(searchParams, "timeBasis", "PAID_AT");
  if (!TIME_BASES.has(timeBasis)) throw runtimeError("report_time_basis_invalid", 422);
  const rankingKind = singleParam(searchParams, "rankingKind", "MAIN");
  if (!RANKING_KINDS.has(rankingKind)) throw runtimeError("report_ranking_kind_invalid", 422);
  const metricId = singleParam(searchParams, "metricId", "net_menu_sales");
  if (!METRICS.has(metricId)) throw runtimeError("report_metric_invalid", 422);
  return Object.freeze({ fromDate, toDate, timeBasis, rankingKind, metricId });
}

function requireSnapshot(snapshots, searchParams, sessionKey, now) {
  assertAllowedParams(searchParams, ALLOWED_SNAPSHOT_QUERY);
  const fingerprint = singleParam(searchParams, "fingerprint");
  if (!FINGERPRINT.test(fingerprint)) throw runtimeError("report_snapshot_unavailable", 409);
  const key = `${requireSessionKey(sessionKey)}:${fingerprint}`;
  const snapshot = snapshots.get(key);
  if (!snapshot || snapshot.expiresAt <= now) {
    snapshots.delete(key);
    throw runtimeError("report_snapshot_unavailable", 409);
  }
  return snapshot;
}

function assertAllowedParams(searchParams, allowed) {
  if (!(searchParams instanceof URLSearchParams)) throw runtimeError("report_query_invalid", 422);
  for (const key of new Set(searchParams.keys())) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw runtimeError("report_query_invalid", 422);
  }
}

function singleParam(searchParams, key, fallback) {
  const value = searchParams.get(key);
  if (value == null || value === "") {
    if (fallback !== undefined) return fallback;
    throw runtimeError("report_query_invalid", 422);
  }
  if (value.length > 100) throw runtimeError("report_query_invalid", 422);
  return value;
}

function dateParam(searchParams, key) {
  const value = singleParam(searchParams, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw runtimeError("report_period_invalid", 422);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw runtimeError("report_period_invalid", 422);
  return value;
}

function assertReadGuard(repository) {
  let guard;
  try { guard = repository?.esbRuntimeStatus?.(); } catch { /* fail closed below */ }
  if (guard?.readVersion !== "SHADOW_V1") throw runtimeError("report_esb_read_not_enabled", 503);
}

function assertOwner(actor) {
  if (!actor || actor.role !== "owner") throw runtimeError("report_owner_scope_denied", 403);
}

function validClockInstant(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw runtimeError("report_clock_invalid", 503);
  return date;
}

function validTimezone(value) {
  const timezone = String(value ?? "");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0)); }
  catch { throw runtimeError("report_outlet_timezone_invalid", 503); }
  return timezone;
}

function zonedBoundary(date, cutoff, timezone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = cutoff.split(":").map(Number);
  const desiredUtcShape = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desiredUtcShape;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate += desiredUtcShape - represented;
  }
  const verified = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  if (verified.year !== year || verified.month !== month || verified.day !== day || verified.hour !== hour || verified.minute !== minute || verified.second !== second) {
    throw runtimeError("report_period_timezone_transition_invalid", 422);
  }
  return new Date(candidate);
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function billSql(timeBasis) {
  const filter = timeBasis === "BUSINESS_DATE"
    ? "orders.business_date between $3::date and $4::date and bill.paid_at<=$5::timestamptz"
    : timeBasis === "ORDERED_AT"
      ? "orders.created_at>=$3::timestamptz and orders.created_at<$4::timestamptz and orders.created_at<=$5::timestamptz and bill.paid_at<=$5::timestamptz"
      : "bill.paid_at>=$3::timestamptz and bill.paid_at<$4::timestamptz and bill.paid_at<=$5::timestamptz";
  return `/* esb_owner_report:bills */
    select bill.*, orders.status as order_status, orders.created_at as ordered_at,
           coalesce(bill.pricing_policy_snapshot->'pricingPolicy'->>'id',bill.contract_version) as policy_version
      from sagaops.esb_bills bill
      join sagaops.orders orders
        on orders.id=bill.order_id
       and orders.organization_id=bill.organization_id
       and orders.outlet_id=bill.outlet_id
     where bill.organization_id=$1 and bill.outlet_id=$2 and bill.status='PAID'
       and ${filter}
     order by bill.id`;
}

function cashSql(timeBasis) {
  const filter = timeBasis === "BUSINESS_DATE"
    ? "movement.business_date between $3::date and $4::date and movement.occurred_at<=$5::timestamptz"
    : timeBasis === "ORDERED_AT"
      ? `movement.occurred_at<=$5::timestamptz and exists (
          select 1 from sagaops.esb_payment_attempts attempt
          join sagaops.orders orders
            on orders.id=attempt.order_id
           and orders.organization_id=attempt.organization_id
           and orders.outlet_id=attempt.outlet_id
         where attempt.id=movement.payment_attempt_id
           and attempt.organization_id=movement.organization_id and attempt.outlet_id=movement.outlet_id
           and orders.created_at>=$3::timestamptz and orders.created_at<$4::timestamptz and orders.created_at<=$5::timestamptz)`
      : "movement.occurred_at>=$3::timestamptz and movement.occurred_at<$4::timestamptz and movement.occurred_at<=$5::timestamptz";
  return `/* esb_owner_report:cash */
    select movement.id,movement.organization_id,movement.outlet_id,movement.amount_rupiah
      from sagaops.esb_cash_movements movement
     where movement.organization_id=$1 and movement.outlet_id=$2 and ${filter}
     order by movement.id`;
}

function reportScopeParams({ context, query, filters }) {
  return filters.timeBasis === "BUSINESS_DATE"
    ? [context.organizationId, context.outletId, filters.fromDate, filters.toDate, query.snapshotCutoffUtc]
    : [context.organizationId, context.outletId, query.periodStartUtc, query.periodEndUtc, query.snapshotCutoffUtc];
}

function integer(value, field) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw runtimeError("report_authoritative_value_invalid", 503, new Error(field));
  return number;
}

function instant(value, field) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) throw runtimeError("report_authoritative_value_invalid", 503, new Error(field));
  return result.toISOString();
}

function verificationEvidenceSource(level) {
  if (level === "CASH") return "CASH_ACCEPTED_EVENT";
  if (level === "PROVIDER_VERIFIED") return "EXTERNAL_PROVIDER_EVENT";
  if (level === "LEGACY_UNVERIFIED") return "LEGACY_IMPORT";
  if (level === "MANUAL") return "MANUAL_OR_PENDING";
  throw runtimeError("report_payment_verification_level_invalid", 503);
}

function quantity(value) {
  const normalized = typeof value === "string" && /^\d+\.\d{6}$/.test(value)
    ? value
    : Number(value).toFixed(6);
  if (!/^\d+\.\d{6}$/.test(normalized) || BigInt(normalized.replace(".", "")) <= 0n) {
    throw runtimeError("report_authoritative_value_invalid", 503);
  }
  return normalized;
}

function multiplyRupiahByQuantity(unitCostValue, quantityValue, field) {
  const unitCost = integer(unitCostValue, `${field}.unitCost`);
  if (unitCost < 0) throw runtimeError("report_authoritative_value_invalid", 503, new Error(field));
  const quantityMicros = BigInt(quantity(quantityValue).replace(".", ""));
  const rounded = (BigInt(unitCost) * quantityMicros + 500_000n) / 1_000_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw runtimeError("report_authoritative_value_invalid", 503, new Error(field));
  return Number(rounded);
}

function safeAdd(left, right, field) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw runtimeError("report_authoritative_value_invalid", 503, new Error(field));
  return value;
}

function requireSessionKey(value) {
  const key = String(value ?? "");
  if (!/^[0-9a-f]{64}$/.test(key)) throw runtimeError("report_session_invalid", 401);
  return key;
}

function storeSnapshot(snapshots, key, value, { now, maximumSnapshots }) {
  for (const [candidate, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(candidate);
  snapshots.set(key, value);
  while (snapshots.size > maximumSnapshots) snapshots.delete(snapshots.keys().next().value);
}

function reportFilename(filters) {
  return `sagapos-owner-${filters.fromDate}-${filters.toDate}.csv`;
}

function runtimeError(code, statusCode, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
