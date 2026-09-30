export const REPORT_CONTRACT_VERSION = "SAGAPOS_ESB_TRANSACTION_REPORTING_V1";
export const REPORT_INTERVAL_BOUNDARY = "START_INCLUSIVE_END_EXCLUSIVE";
export const REPORT_CURRENCY = "IDR";

export const REPORT_TIME_BASES = Object.freeze([
  "ORDERED_AT",
  "PAID_AT",
  "REFUNDED_AT",
  "SETTLED_AT",
  "BUSINESS_DATE",
]);

export const REPORT_LINE_KINDS = Object.freeze(["MAIN", "MODIFIER", "BUNDLE_COMPONENT"]);

export const REPORT_SOURCE_PORT_V1 = deepFreeze({
  version: 1,
  method: "loadAuthorizedReportSource",
  responsibility: [
    "authorize_organization_and_outlet_scope_server_side",
    "apply_exact_half_open_period_and_time_basis",
    "apply_snapshot_cutoff_and_paid_bill_inclusion",
    "preaggregate_each_money_grain_before_cross_grain_join",
    "return_snapshot_labels_without_live_catalog_repricing",
  ],
  integrationStatus: "ADAPTER_REQUIRED_BEFORE_RUNTIME_USE",
});

export const REPORT_CATALOG_PORT_V1 = deepFreeze({
  version: 1,
  optionalMethod: "resolveStableItemLabels",
  authority: "SNAPSHOT_LABELS_REMAIN_AUTHORITATIVE_FOR_HISTORY",
  integrationStatus: "PARTIAL_PRODUCT_INTEGRATION_CATALOG_NOT_MERGED",
});

export class EsbReportingError extends Error {
  constructor(code, detail = undefined) {
    super(code);
    this.name = "EsbReportingError";
    this.code = code;
    this.detail = detail;
  }
}

export function reportingError(code, detail) {
  return new EsbReportingError(code, detail);
}

export function requireText(value, field, maximum = 200) {
  if (typeof value !== "string" || value.trim().length === 0) throw reportingError("report_required_field", field);
  const normalized = value.trim();
  if (normalized.length > maximum) throw reportingError("report_field_too_long", field);
  return normalized;
}

export function requireIsoInstant(value, field) {
  const normalized = requireText(value, field, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) throw reportingError("report_instant_invalid", field);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) throw reportingError("report_instant_invalid", field);
  return normalized;
}

export function requireSafeInteger(value, field, { nonNegative = false } = {}) {
  if (!Number.isSafeInteger(value)) throw reportingError("report_amount_invalid", field);
  if (nonNegative && value < 0) throw reportingError("report_amount_negative", field);
  return value;
}

export function checkedAdd(left, right, field = "sum") {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw reportingError("report_amount_overflow", field);
  return result;
}

export function addAmounts(rows, field) {
  return rows.reduce((total, row) => checkedAdd(total, requireSafeInteger(row[field], field), field), 0);
}

export function roundRatio(numerator, denominator) {
  requireSafeInteger(numerator, "ratio.numerator");
  requireSafeInteger(denominator, "ratio.denominator", { nonNegative: true });
  if (denominator === 0) return null;
  const negative = numerator < 0;
  const absolute = BigInt(Math.abs(numerator));
  const divisor = BigInt(denominator);
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  const signed = Number(negative ? -quotient : quotient);
  if (!Number.isSafeInteger(signed)) throw reportingError("report_ratio_overflow");
  return signed;
}

export function normalizeReportQuery(input = {}) {
  const organizationId = requireText(input.organizationId, "organizationId");
  if (!Array.isArray(input.outletIds) || input.outletIds.length === 0) throw reportingError("report_outlet_scope_required");
  const outletIds = [...new Set(input.outletIds.map((value) => requireText(value, "outletId")))].sort();
  if (outletIds.length !== input.outletIds.length) throw reportingError("report_outlet_scope_duplicate");
  const periodStartUtc = requireIsoInstant(input.periodStartUtc, "periodStartUtc");
  const periodEndUtc = requireIsoInstant(input.periodEndUtc, "periodEndUtc");
  if (Date.parse(periodStartUtc) >= Date.parse(periodEndUtc)) throw reportingError("report_period_invalid");
  const snapshotCutoffUtc = requireIsoInstant(input.snapshotCutoffUtc, "snapshotCutoffUtc");
  if (Date.parse(snapshotCutoffUtc) < Date.parse(periodEndUtc)) throw reportingError("report_snapshot_cutoff_before_period_end");
  const timezone = requireText(input.timezone, "timezone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw reportingError("report_timezone_invalid", timezone);
  }
  const businessDateCutoffLocal = requireText(input.businessDateCutoffLocal, "businessDateCutoffLocal", 8);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(businessDateCutoffLocal)) throw reportingError("report_business_cutoff_invalid");
  const timeBasis = requireText(input.timeBasis, "timeBasis");
  if (!REPORT_TIME_BASES.includes(timeBasis)) throw reportingError("report_time_basis_invalid", timeBasis);
  const includedStatuses = Array.isArray(input.includedStatuses) ? [...new Set(input.includedStatuses)].sort() : [];
  if (includedStatuses.length !== 1 || includedStatuses[0] !== "PAID") throw reportingError("report_inclusion_policy_invalid");
  const currency = input.currency ?? REPORT_CURRENCY;
  if (currency !== REPORT_CURRENCY) throw reportingError("report_currency_invalid", currency);
  const policyVersion = requireText(input.policyVersion, "policyVersion");
  return deepFreeze({
    contractVersion: REPORT_CONTRACT_VERSION,
    metricId: requireText(input.metricId ?? "owner_operational_summary", "metricId"),
    organizationId,
    outletIds,
    periodStartUtc,
    periodEndUtc,
    intervalBoundary: REPORT_INTERVAL_BOUNDARY,
    timezone,
    businessDateCutoffLocal,
    timeBasis,
    includedStatuses,
    currency,
    policyVersion,
    snapshotCutoffUtc,
  });
}

export function assertAppliedFilter(query, appliedFilter = {}) {
  const expected = {
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
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = Array.isArray(value) ? [...(appliedFilter[field] ?? [])].sort() : appliedFilter[field];
    if (JSON.stringify(actual) !== JSON.stringify(value)) throw reportingError("report_source_filter_mismatch", field);
  }
}

export function assertUniqueRows(rows, grain) {
  if (!Array.isArray(rows)) throw reportingError("report_source_grain_invalid", grain);
  const ids = new Set();
  for (const row of rows) {
    const id = requireText(row?.id, `${grain}.id`);
    if (ids.has(id)) throw reportingError("report_source_duplicate_row", `${grain}:${id}`);
    ids.add(id);
  }
  return ids;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
