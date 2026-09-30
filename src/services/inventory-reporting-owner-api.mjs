import { INVENTORY_REPORT_FAMILY_REGISTRY, INVENTORY_REPORTING_CONTRACT } from "./inventory-reporting-b20.mjs";

export const INVENTORY_REPORTING_OWNER_API_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_OWNER_API_V1";
export const INVENTORY_REPORTING_PRIVATE_AUTHORITY = Symbol("inventoryReportingPrivateAuthority");

const LEGACY_TIME_QUERY_KEYS = ["periodStartUtc", "periodEndUtc", "snapshotCutoffUtc"];
const CALENDAR_QUERY_KEYS = ["view", "periodStartDate", "periodEndDate", "snapshotCutoffDate"];
const SUMMARY_QUERY_KEYS = new Set([...LEGACY_TIME_QUERY_KEYS, ...CALENDAR_QUERY_KEYS]);
const SNAPSHOT_QUERY_KEYS = new Set([...SUMMARY_QUERY_KEYS, "expectedReportFingerprint"]);
const PAGE_QUERY_KEYS = new Set([...SNAPSHOT_QUERY_KEYS, "cursor", "limit"]);
const SOURCE_QUERY_KEYS = new Set([...SNAPSHOT_QUERY_KEYS, "type", "id", "lineId"]);
const FORBIDDEN_AUTHORITY_KEYS = new Set(["organizationId", "organizationIds", "outletId", "outletIds", "tenantId", "scopeLevel", "includedStatuses", "currency", "policyVersion", "timeZone", "businessDateCutoffLocal", "statusPolicy", "timePolicy"]);
const FAMILY_NAMES = new Set(Object.keys(INVENTORY_REPORT_FAMILY_REGISTRY.families));
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 5_000;
const MAX_REPORT_PERIOD_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_LAG_MS = 31 * 24 * 60 * 60 * 1_000;

export function createInventoryReportingOwnerApi({ provider, resolveOwnerReportContext = provider?.resolveOwnerReportContext?.bind(provider), policyVersion = "REPORT-POLICY-V1", requireCalendarAuthority = false } = {}) {
  if (!provider || typeof provider.readProjection !== "function" || typeof provider.resolveSourceReference !== "function") {
    throw new Error("inventory_reporting_provider_invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(policyVersion)) throw new Error("inventory_reporting_policy_invalid");
  if (typeof requireCalendarAuthority !== "boolean") throw new Error("inventory_reporting_calendar_policy_invalid");

  async function load({ actor, authority, query }) {
    assertOwner(actor);
    const baseAuthority = normalizeAuthority(authority);
    const context = await resolveReportContext({ actor, baseAuthority, query, resolveOwnerReportContext, requireCalendarAuthority });
    const safeAuthority = context.authority;
    const filters = context.filters;
    const reportQuery = Object.freeze({
      organizationId: safeAuthority.organizationId,
      outletIds: safeAuthority.outletIds,
      scopeLevel: safeAuthority.scopeLevel,
      periodStartUtc: filters.periodStartUtc,
      periodEndUtc: filters.periodEndUtc,
      snapshotCutoffUtc: filters.snapshotCutoffUtc,
      includedStatuses: Object.freeze(["POSTED"]),
      currency: "IDR",
      policyVersion,
    });
    let projection;
    try {
      projection = await provider.readProjection(privateProviderInput({ query: reportQuery }, context));
    } catch (error) {
      if (error?.statusCode) throw error;
      throw failure("inventory_reporting_provider_failed", 503);
    }
    if (projection == null) throw failure("inventory_reporting_provider_unavailable", 503);
    validateProjection(projection, reportQuery);
    return { projection, reportQuery, context };
  }

  return Object.freeze({
    contract: INVENTORY_REPORTING_OWNER_API_CONTRACT,

    async readSummary(input = {}) {
      assertExactQuery(input.query, SUMMARY_QUERY_KEYS);
      const { projection, reportQuery, context } = await load(input);
      return Object.freeze({
        contract: INVENTORY_REPORTING_OWNER_API_CONTRACT,
        status: projection.status,
        reportFingerprint: projection.reportFingerprint,
        metricDictionaryVersion: projection.metricDictionaryVersion,
        reportFamilyRegistryVersion: projection.reportFamilyRegistryVersion,
        query: publicQuery(reportQuery),
        calendar: context.calendar,
        scope: publicScope(context),
        cards: summarize(projection, context.authority.scopeLevel),
        cardAvailability: cardAvailability(projection, context.authority.scopeLevel),
        families: [...FAMILY_NAMES],
      });
    },

    async readFamily(input = {}) {
      assertExactQuery(input.query, PAGE_QUERY_KEYS);
      const family = normalizeFamily(input.family);
      const { projection, reportQuery, context } = await load(input);
      assertExpectedReportFingerprint(input.query, projection.reportFingerprint);
      const rows = attributeRows(presentationRows(projection, family, context.authority.scopeLevel), context);
      const limit = pageLimit(input.query?.limit);
      const offset = decodeCursor(input.query?.cursor, projection.reportFingerprint, family);
      if (offset > rows.length) throw failure("inventory_reporting_cursor_invalid", 422);
      const page = rows.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return Object.freeze({
        contract: INVENTORY_REPORTING_OWNER_API_CONTRACT,
        family,
        status: projection.status,
        reportFingerprint: projection.reportFingerprint,
        query: publicQuery(reportQuery),
        calendar: context.calendar,
        scope: publicScope(context),
        rows: page,
        page: Object.freeze({
          limit,
          returned: page.length,
          total: rows.length,
          nextCursor: nextOffset < rows.length ? encodeCursor(projection.reportFingerprint, family, nextOffset) : null,
        }),
      });
    },

    async exportFamily(input = {}) {
      assertExactQuery(input.query, SNAPSHOT_QUERY_KEYS);
      const family = normalizeFamily(input.family);
      const { projection, context } = await load(input);
      assertExpectedReportFingerprint(input.query, projection.reportFingerprint);
      const rows = attributeRows(presentationRows(projection, family, context.authority.scopeLevel), context);
      if (rows.length > MAX_EXPORT_ROWS) throw failure("inventory_reporting_export_too_large", 413);
      return Object.freeze({
        filename: `sagapos-inventory-${family}.csv`,
        csv: toCsv(rows),
        rowCount: rows.length,
        reportFingerprint: projection.reportFingerprint,
      });
    },

    async resolveSource(input = {}) {
      assertExactQuery(input.query, SOURCE_QUERY_KEYS);
      const { projection, reportQuery, context } = await load(input);
      assertExpectedReportFingerprint(input.query, projection.reportFingerprint);
      const sourceRef = normalizeSourceRef(input.query);
      if (!projectionContainsSourceRef(projection, sourceRef)) throw failure("inventory_reporting_source_not_found", 404);
      let record;
      try {
        record = await provider.resolveSourceReference(privateProviderInput({ query: reportQuery, sourceRef, expectedSourceFingerprint: projection.sourceFingerprint }, context));
      } catch (error) {
        if (error?.statusCode) throw error;
        throw failure("inventory_reporting_provider_failed", 503);
      }
      if (record == null) throw failure("inventory_reporting_source_not_found", 404);
      if (!record || typeof record !== "object" || Array.isArray(record)) throw failure("inventory_reporting_source_invalid", 500);
      const safe = normalizeSourceRecord(record, sourceRef);
      return Object.freeze({ contract: INVENTORY_REPORTING_OWNER_API_CONTRACT, sourceRef, scope: sourceScope(projection, sourceRef, context), record: safe });
    },
  });
}

async function resolveReportContext({ actor, baseAuthority, query, resolveOwnerReportContext, requireCalendarAuthority }) {
  const hasCalendarIntent = CALENDAR_QUERY_KEYS.some((key) => query?.[key] != null && query[key] !== "");
  const hasLegacyTime = LEGACY_TIME_QUERY_KEYS.some((key) => query?.[key] != null && query[key] !== "");
  if (hasCalendarIntent && hasLegacyTime) throw failure("inventory_reporting_query_invalid", 422);
  if (!hasCalendarIntent) {
    if (hasLegacyTime && requireCalendarAuthority) throw failure("inventory_reporting_historical_calendar_required", 422);
    const filters = normalizeTimeQuery({ periodStartUtc: query?.periodStartUtc, periodEndUtc: query?.periodEndUtc, snapshotCutoffUtc: query?.snapshotCutoffUtc });
    return Object.freeze({ authority: baseAuthority, filters, calendar: null, availableViews: Object.freeze([baseAuthority.scopeLevel]), outlets: defaultOutlets(baseAuthority) });
  }
  if (typeof resolveOwnerReportContext !== "function") throw failure("inventory_reporting_calendar_unavailable", 503);
  const requestedView = normalizeView(query?.view ?? "OUTLET");
  const suppliedDates = [query?.periodStartDate, query?.periodEndDate, query?.snapshotCutoffDate];
  const suppliedCount = suppliedDates.filter((value) => value != null && value !== "").length;
  if (suppliedCount !== 0 && suppliedCount !== suppliedDates.length) throw failure("inventory_reporting_period_invalid", 422);
  const reportDate = suppliedCount === 0 ? null : Object.freeze({
    periodStartDate: localDate(query.periodStartDate),
    periodEndDate: localDate(query.periodEndDate),
    snapshotCutoffDate: localDate(query.snapshotCutoffDate),
  });
  let resolved;
  try {
    resolved = await resolveOwnerReportContext({
      authUserId: actor.employeeId ?? actor.userId ?? actor.actorUserId ?? null,
      requestedView,
      reportDate,
      authority: baseAuthority,
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw failure("inventory_reporting_context_provider_failed", 503);
  }
  return normalizeResolvedContext(resolved, { baseAuthority, requestedView, reportDate });
}

function normalizeResolvedContext(value, { baseAuthority, requestedView, reportDate }) {
  if (!record(value)) throw failure("inventory_reporting_context_invalid", 500);
  const authority = normalizeAuthority(record(value.authority) ? value.authority : value);
  if (authority.organizationId !== baseAuthority.organizationId || authority.scopeLevel !== requestedView) throw failure("inventory_reporting_context_scope_mismatch", 500);
  const availableViews = Array.isArray(value.availableViews) ? [...new Set(value.availableViews.map(normalizeView))] : [];
  if (!availableViews.includes(requestedView)) throw failure("inventory_reporting_view_forbidden", 403);
  const calendar = normalizeCalendar(value.calendar, reportDate);
  const filters = normalizeTimeQuery(calendar);
  const outlets = normalizeOutlets(value.outlets, authority);
  const context = { authority, filters, calendar, availableViews: Object.freeze(availableViews), outlets };
  if (value[INVENTORY_REPORTING_PRIVATE_AUTHORITY] != null) Object.defineProperty(context, INVENTORY_REPORTING_PRIVATE_AUTHORITY, { value: value[INVENTORY_REPORTING_PRIVATE_AUTHORITY] });
  return Object.freeze(context);
}

function privateProviderInput(input, context) {
  if (context[INVENTORY_REPORTING_PRIVATE_AUTHORITY] == null) return input;
  return Object.defineProperty(input, INVENTORY_REPORTING_PRIVATE_AUTHORITY, { value: context[INVENTORY_REPORTING_PRIVATE_AUTHORITY] });
}

function normalizeCalendar(value, requested) {
  if (!record(value)) throw failure("inventory_reporting_calendar_invalid", 500);
  const calendar = {
    timeZone: timeZone(value.timeZone),
    businessDateCutoffLocal: localTime(value.businessDateCutoffLocal),
    periodStartDate: localDate(value.periodStartDate),
    periodEndDate: localDate(value.periodEndDate),
    snapshotCutoffDate: localDate(value.snapshotCutoffDate),
    periodStartUtc: instant(value.periodStartUtc, "inventory_reporting_calendar_invalid"),
    periodEndUtc: instant(value.periodEndUtc, "inventory_reporting_calendar_invalid"),
    snapshotCutoffUtc: instant(value.snapshotCutoffUtc, "inventory_reporting_calendar_invalid"),
  };
  if (requested && ["periodStartDate", "periodEndDate", "snapshotCutoffDate"].some((key) => calendar[key] !== requested[key])) throw failure("inventory_reporting_calendar_scope_mismatch", 500);
  return Object.freeze(calendar);
}

function normalizeOutlets(value, authority) {
  if (!Array.isArray(value) || value.length !== authority.outletIds.length) throw failure("inventory_reporting_context_invalid", 500);
  const seen = new Set();
  const outlets = value.map((item) => {
    if (!record(item)) throw failure("inventory_reporting_context_invalid", 500);
    const outletId = identifier(item.outletId, "inventory_reporting_context_invalid");
    if (seen.has(outletId) || !authority.outletIds.includes(outletId)) throw failure("inventory_reporting_context_scope_mismatch", 500);
    seen.add(outletId);
    return Object.freeze({ outletId, label: safeLabel(item.label) });
  });
  if (seen.size !== authority.outletIds.length) throw failure("inventory_reporting_context_scope_mismatch", 500);
  return Object.freeze(outlets.sort((a, b) => a.outletId.localeCompare(b.outletId)));
}

function defaultOutlets(authority) {
  return Object.freeze(authority.outletIds.map((outletId, index) => Object.freeze({ outletId, label: authority.scopeLevel === "OUTLET" ? "Outlet aktif" : `Outlet ${index + 1}` })));
}

function normalizeAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("inventory_reporting_authority_invalid", 500);
  const organizationId = identifier(value.organizationId, "inventory_reporting_authority_invalid");
  const outletIds = Array.isArray(value.outletIds) ? value.outletIds.map((item) => identifier(item, "inventory_reporting_authority_invalid")) : [];
  if (!outletIds.length || outletIds.length > 100 || new Set(outletIds).size !== outletIds.length) throw failure("inventory_reporting_authority_invalid", 500);
  const scopeLevel = value.scopeLevel === "COMPANY" ? "COMPANY" : value.scopeLevel === "OUTLET" && outletIds.length === 1 ? "OUTLET" : null;
  if (!scopeLevel) throw failure("inventory_reporting_authority_invalid", 500);
  return Object.freeze({ organizationId, outletIds: Object.freeze([...outletIds].sort()), scopeLevel });
}

function normalizeTimeQuery(query = {}) {
  const periodStartUtc = instant(query.periodStartUtc, "inventory_reporting_period_invalid");
  const periodEndUtc = instant(query.periodEndUtc, "inventory_reporting_period_invalid");
  const snapshotCutoffUtc = instant(query.snapshotCutoffUtc ?? query.periodEndUtc, "inventory_reporting_cutoff_invalid");
  const startMs = Date.parse(periodStartUtc); const endMs = Date.parse(periodEndUtc); const cutoffMs = Date.parse(snapshotCutoffUtc);
  if (startMs >= endMs || cutoffMs < endMs || endMs - startMs > MAX_REPORT_PERIOD_MS || cutoffMs - endMs > MAX_SNAPSHOT_LAG_MS) throw failure("inventory_reporting_period_invalid", 422);
  return { periodStartUtc, periodEndUtc, snapshotCutoffUtc };
}

function validateProjection(value, query) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.contract !== INVENTORY_REPORTING_CONTRACT) throw failure("inventory_reporting_projection_invalid", 500);
  if (!["COMPLETE", "PARTIAL"].includes(value.status) || !/^[0-9a-f]{64}$/.test(value.reportFingerprint ?? "") || !/^[0-9a-f]{64}$/.test(value.sourceFingerprint ?? "")) throw failure("inventory_reporting_projection_invalid", 500);
  validateProjectionShape(value);
  const actual = value.query;
  if (!actual || actual.organizationId !== query.organizationId || actual.scopeLevel !== query.scopeLevel || JSON.stringify(actual.outletIds) !== JSON.stringify(query.outletIds)
    || actual.periodStartUtc !== query.periodStartUtc || actual.periodEndUtc !== query.periodEndUtc || actual.snapshotCutoffUtc !== query.snapshotCutoffUtc
    || actual.currency !== "IDR" || JSON.stringify(actual.includedStatuses) !== '["POSTED"]' || actual.policyVersion !== query.policyVersion) {
    throw failure("inventory_reporting_projection_scope_mismatch", 500);
  }
}

function summarize(projection, scopeLevel) {
  const stock = array(projection.reports.stockBalance);
  const profitability = array(projection.reports.profitability?.menu);
  const quality = array(projection.reports.dataQuality?.issues);
  return Object.freeze({
    stockLineCount: stock.length,
    closingInventoryValueRupiah: sumNullableMoney(stock.map((row) => row.closingValueRupiah)),
    currentRecipeHppRupiah: scopeLevel === "COMPANY" ? null : nullableMoney(projection.costLayers.currentRecipeHppRupiah?.valueRupiah),
    adjustedCogsRupiah: nullableMoney(projection.costLayers.adjustedCogsRupiah?.valueRupiah),
    profitabilityMarginRupiah: sumNullableMoney(profitability.map((row) => row.marginRupiah)),
    dataQualityIssueCount: quality.length,
  });
}

function cardAvailability(projection, scopeLevel) {
  const recipeKnown = Number.isSafeInteger(projection.costLayers.currentRecipeHppRupiah?.valueRupiah);
  return Object.freeze({ currentRecipeHppRupiah: Object.freeze({
    available: scopeLevel !== "COMPANY" && recipeKnown,
    reason: scopeLevel === "COMPANY" ? "NON_ADDITIVE_COMPANY" : recipeKnown ? null : "SOURCE_INCOMPLETE",
  }) });
}

function publicScope(context) {
  return Object.freeze({
    level: context.authority.scopeLevel,
    label: context.authority.scopeLevel === "COMPANY" ? "Total perusahaan" : context.outlets[0]?.label ?? "Outlet aktif",
    availableViews: context.availableViews,
    outletCount: context.outlets.length,
    outlets: context.outlets,
  });
}

function attributeRows(rows, context) {
  if (context.authority.scopeLevel === "OUTLET") return rows;
  return rows.map((row) => Object.freeze({ ...row, reportScope: rowScope(row, context) }));
}

function rowScope(row, context) {
  const outletId = typeof row?.outletId === "string" ? row.outletId : null;
  if (outletId) {
    const outlet = context.outlets.find((item) => item.outletId === outletId);
    if (!outlet) throw failure("inventory_reporting_projection_scope_mismatch", 500);
    return Object.freeze({ level: "OUTLET", outletId, label: outlet.label });
  }
  if (context.authority.scopeLevel === "OUTLET") return Object.freeze({ level: "OUTLET", outletId: context.outlets[0].outletId, label: context.outlets[0].label });
  return Object.freeze({ level: "COMPANY", outletId: null, label: "Total perusahaan" });
}

function sourceScope(projection, sourceRef, context) {
  const matching = [];
  for (const family of FAMILY_NAMES) for (const row of familyRows(projection, family)) if (containsSourceRef(row, sourceRef)) matching.push(rowScope(row, context));
  const outletIds = [...new Set(matching.map((item) => item.outletId).filter(Boolean))];
  if (outletIds.length === 1) return matching.find((item) => item.outletId === outletIds[0]);
  if (context.authority.scopeLevel === "OUTLET") return rowScope({}, context);
  return Object.freeze({ level: "COMPANY", outletId: null, label: "Total perusahaan" });
}

function containsSourceRef(value, sourceRef) {
  if (Array.isArray(value)) return value.some((item) => containsSourceRef(item, sourceRef));
  if (!record(value)) return false;
  if (value.type === sourceRef.type && value.id === sourceRef.id && (value.lineId ?? null) === sourceRef.lineId) return true;
  return Object.values(value).some((item) => containsSourceRef(item, sourceRef));
}

function familyRows(projection, family) {
  if (family === "costHppCogs") return Object.entries(projection.costLayers).map(([metric, value]) => ({ metric, ...value }));
  if (family === "ingredientTheoreticalActual") return array(projection.varianceWaterfalls);
  const value = projection.reports[family];
  if (Array.isArray(value)) return value;
  if (family === "profitability") return ["menu", "variant", "modifier", "channel", "excludedIncomplete"]
    .flatMap((section) => value[section].map((row) => ({ section, ...row })));
  if (family === "dataQuality") return array(value?.issues);
  if (family === "wasteShrinkage") return [
    ...array(value?.movements).map((row) => ({ section: "MOVEMENT", ...row })),
    ...array(value?.variance).map((row) => ({ section: "VARIANCE", ...row })),
  ];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([section, rows]) => Array.isArray(rows) ? rows.map((row) => ({ section, ...row })) : []);
}

function presentationRows(projection, family, scopeLevel) {
  const rows = familyRows(projection, family);
  if (scopeLevel !== "COMPANY" || family !== "costHppCogs") return rows;
  return rows.map((row) => row.metric === "currentRecipeHppRupiah"
    ? { ...row, valueRupiah: null, knownValueRupiah: null, complete: false, availabilityReason: "NON_ADDITIVE_COMPANY" }
    : row);
}

function normalizeSourceRecord(record, requestedRef) {
  const allowed = new Set(["type", "id", "lineId", "label", "status", "occurredAt", "documentNumber", "detail"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw failure("inventory_reporting_source_invalid", 500);
  const reference = { type: identifier(record.type, "inventory_reporting_source_invalid"), id: identifier(record.id, "inventory_reporting_source_invalid"), lineId: record.lineId == null ? null : identifier(record.lineId, "inventory_reporting_source_invalid") };
  if (JSON.stringify(reference) !== JSON.stringify(requestedRef)) throw failure("inventory_reporting_source_scope_mismatch", 500);
  const output = { ...reference, label: boundedText(record.label, 160), status: boundedText(record.status, 40), occurredAt: record.occurredAt == null ? null : instant(record.occurredAt, "inventory_reporting_source_invalid"), documentNumber: record.documentNumber == null ? null : boundedText(record.documentNumber, 80), detail: record.detail == null ? null : boundedText(record.detail, 500) };
  return Object.freeze(output);
}

function normalizeSourceRef(query) {
  return Object.freeze({
    type: identifier(query?.type, "inventory_reporting_source_reference_invalid"),
    id: identifier(query?.id, "inventory_reporting_source_reference_invalid"),
    lineId: query?.lineId == null || query.lineId === "" ? null : identifier(query.lineId, "inventory_reporting_source_reference_invalid"),
  });
}

function projectionContainsSourceRef(projection, sourceRef) {
  const target = JSON.stringify(sourceRef);
  return Object.values(projection.drilldowns).some((refs) => Array.isArray(refs) && refs.some((ref) => JSON.stringify(ref) === target));
}

function assertExactQuery(value = {}, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("inventory_reporting_query_invalid", 422);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) throw failure("inventory_reporting_client_scope_forbidden", 422);
    if (!allowed.has(key)) throw failure("inventory_reporting_query_invalid", 422);
    if (Array.isArray(value[key])) throw failure("inventory_reporting_query_invalid", 422);
  }
}

function assertExpectedReportFingerprint(query, actual) {
  const expected = digest(query?.expectedReportFingerprint, "inventory_reporting_report_fingerprint_invalid");
  if (expected !== actual) throw failure("inventory_reporting_projection_changed", 409);
}

function validateProjectionShape(value) {
  if (!record(value.reports) || !record(value.costLayers) || !Array.isArray(value.varianceWaterfalls) || !record(value.drilldowns)) throw failure("inventory_reporting_projection_invalid", 500);
  for (const family of ["stockBalance", "stockCard", "stockValuation", "supplierScorecard", "forecastReplenishment"]) requireArray(value.reports[family]);
  const waste = value.reports.wasteShrinkage; const profitability = value.reports.profitability; const production = value.reports.production; const quality = value.reports.dataQuality;
  if (!record(waste) || !record(profitability) || !record(production) || !record(quality)) throw failure("inventory_reporting_projection_invalid", 500);
  for (const key of ["movements", "variance"]) requireArray(waste[key]);
  for (const key of ["menu", "variant", "modifier", "channel", "excludedIncomplete"]) requireArray(profitability[key]);
  requireArray(production.transformations); requireArray(quality.issues);
  for (const key of ["currentRecipeHppRupiah", "transactionHppRupiah", "theoreticalSalesCogsRupiah", "postedCogsRupiah", "adjustedCogsRupiah"]) if (!record(value.costLayers[key])) throw failure("inventory_reporting_projection_invalid", 500);
  for (const refs of Object.values(value.drilldowns)) requireArray(refs);
}

function requireArray(value) { if (!Array.isArray(value)) throw failure("inventory_reporting_projection_invalid", 500); }
function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function publicQuery(query) {
  return Object.freeze({ periodStartUtc: query.periodStartUtc, periodEndUtc: query.periodEndUtc, snapshotCutoffUtc: query.snapshotCutoffUtc, scopeLevel: query.scopeLevel, currency: query.currency, includedStatuses: query.includedStatuses });
}

function normalizeView(value) {
  if (value !== "OUTLET" && value !== "COMPANY") throw failure("inventory_reporting_view_invalid", 422);
  return value;
}

function localDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure("inventory_reporting_period_invalid", 422);
  const [year, month, day] = value.split("-").map(Number);
  const verified = new Date(Date.UTC(year, month - 1, day));
  if (verified.getUTCFullYear() !== year || verified.getUTCMonth() !== month - 1 || verified.getUTCDate() !== day) throw failure("inventory_reporting_period_invalid", 422);
  return value;
}

function localTime(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) throw failure("inventory_reporting_calendar_invalid", 500);
  return value.length === 5 ? `${value}:00` : value;
}

function timeZone(value) {
  if (typeof value !== "string" || value.length > 80) throw failure("inventory_reporting_calendar_invalid", 500);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); } catch { throw failure("inventory_reporting_calendar_invalid", 500); }
  return value;
}

function safeLabel(value) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 120 || /[<>\u0000-\u001f\u007f]/.test(result)) throw failure("inventory_reporting_context_invalid", 500);
  return result;
}

function normalizeFamily(value) {
  if (!FAMILY_NAMES.has(value)) throw failure("inventory_reporting_family_invalid", 404);
  return value;
}

function pageLimit(value) {
  if (value == null || value === "") return DEFAULT_PAGE_SIZE;
  if (!/^[1-9][0-9]{0,2}$/.test(String(value))) throw failure("inventory_reporting_limit_invalid", 422);
  const parsed = Number(value);
  if (parsed > MAX_PAGE_SIZE) throw failure("inventory_reporting_limit_invalid", 422);
  return parsed;
}

function encodeCursor(fingerprint, family, offset) {
  return Buffer.from(JSON.stringify({ v: 1, fingerprint, family, offset }), "utf8").toString("base64url");
}

function decodeCursor(value, fingerprint, family) {
  if (value == null || value === "") return 0;
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw failure("inventory_reporting_cursor_invalid", 422);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.v !== 1 || parsed.fingerprint !== fingerprint || parsed.family !== family || !Number.isSafeInteger(parsed.offset) || parsed.offset < 1) throw new Error("invalid");
    return parsed.offset;
  } catch { throw failure("inventory_reporting_cursor_invalid", 422); }
}

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(flatten(row))))].sort();
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    const flat = flatten(row);
    lines.push(columns.map((column) => csvCell(flat[column])).join(","));
  }
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

function flatten(value, prefix = "", output = {}) {
  for (const [key, item] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) flatten(item, path, output);
    else output[path] = Array.isArray(item) ? JSON.stringify(item) : item;
  }
  return output;
}

function csvCell(value) {
  if (value == null) return "";
  let text = String(value).replace(/[\r\n]+/g, " ");
  if (/^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function nullableMoney(value) { return Number.isSafeInteger(value) ? value : null; }
function sumNullableMoney(values) {
  if (!values.length) return null;
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  const sum = values.reduce((total, value) => total + BigInt(value), 0n);
  return sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(sum);
}
function array(value) { return Array.isArray(value) ? value : []; }
function identifier(value, code) { const result = String(value ?? "").trim(); if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result)) throw failure(code, 422); return result; }
function digest(value, code) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure(code, 422); return value; }
function boundedText(value, max) { const result = String(value ?? "").trim(); if (!result || result.length > max || /[<>\u0000]/.test(result)) throw failure("inventory_reporting_source_invalid", 500); return result; }
function instant(value, code) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw failure(code, 422); return new Date(value).toISOString(); }
function assertOwner(actor) { if (!actor || actor.role !== "owner") throw failure("owner_required", 403); }
function failure(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
