import { TABLE_ROOM_CONTRACT_V1, boundaryError, deepFreeze, requiredCode, requiredId, requiredText } from "./contract.mjs";

const DAYS = Object.freeze(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
const STATION_KINDS = new Set(["KITCHEN", "BAR", "CHECKER", "STICKER", "RECEIPT"]);

export function createOutletDirectory(input = {}) {
  const tenant = normalizeTenant(input.tenant);
  const organizations = normalizeUnique(input.organizations, normalizeOrganization, "organization", (row) => row.id);
  const brands = normalizeUnique(input.brands, normalizeBrand, "brand", (row) => `${row.organizationId}:${row.code}`);
  const outlets = normalizeUnique(input.outlets, normalizeOutlet, "outlet", (row) => `${row.organizationId}:${row.code}`);
  const organizationIds = new Set(organizations.map((row) => row.id));
  const brandsById = new Map(brands.map((row) => [row.id, row]));

  for (const organization of organizations) if (organization.tenantId !== tenant.id) throw boundaryError("organization_tenant_scope_invalid", 403);
  for (const brand of brands) {
    if (brand.tenantId !== tenant.id || !organizationIds.has(brand.organizationId)) throw boundaryError("brand_scope_invalid", 403);
  }
  for (const outlet of outlets) {
    const brand = brandsById.get(outlet.brandId);
    if (outlet.tenantId !== tenant.id || !organizationIds.has(outlet.organizationId) || !brand || brand.organizationId !== outlet.organizationId) {
      throw boundaryError("outlet_scope_invalid", 403);
    }
  }

  const snapshot = deepFreeze({
    version: 1,
    tenant,
    organizations,
    brands,
    outlets,
    tableRoom: TABLE_ROOM_CONTRACT_V1,
  });
  const outletById = new Map(outlets.map((row) => [row.id, row]));
  return Object.freeze({
    snapshot: () => snapshot,
    outlet: (outletId) => outletById.get(outletId) ?? null,
    assertOutletScope: (principal, resource) => assertOutletScope({ principal, resource, outletById }),
  });
}

export function assertOutletScope({ principal, resource, outletById } = {}) {
  if (!principal || !resource) throw boundaryError("outlet_scope_required", 403);
  const tenantId = requiredId(principal.tenantId, "principal_tenant_required");
  const organizationId = requiredId(resource.organizationId, "resource_organization_required");
  const outletId = requiredId(resource.outletId, "resource_outlet_required");
  if (tenantId !== requiredId(resource.tenantId, "resource_tenant_required")) throw boundaryError("tenant_scope_denied", 403);
  if (!Array.isArray(principal.organizationIds) || !principal.organizationIds.includes(organizationId)) throw boundaryError("organization_scope_denied", 403);
  if (!Array.isArray(principal.outletIds) || !(principal.outletIds.includes("*") || principal.outletIds.includes(outletId))) throw boundaryError("outlet_scope_denied", 403);
  const outlet = outletById?.get(outletId);
  if (!outlet || outlet.tenantId !== tenantId || outlet.organizationId !== organizationId) throw boundaryError("outlet_scope_denied", 403);
  return deepFreeze({ tenantId, organizationId, outletId, authorized: true });
}

function normalizeTenant(row = {}) {
  return deepFreeze({ id: requiredId(row.id, "tenant_id_required"), name: requiredText(row.name, "tenant_name_required") });
}

function normalizeOrganization(row = {}) {
  return deepFreeze({
    id: requiredId(row.id, "organization_id_required"),
    tenantId: requiredId(row.tenantId, "organization_tenant_required"),
    name: requiredText(row.name, "organization_name_required"),
  });
}

function normalizeBrand(row = {}) {
  return deepFreeze({
    id: requiredId(row.id, "brand_id_required"),
    tenantId: requiredId(row.tenantId, "brand_tenant_required"),
    organizationId: requiredId(row.organizationId, "brand_organization_required"),
    code: requiredCode(row.code, "brand_code_required"),
    name: requiredText(row.name, "brand_name_required"),
  });
}

function normalizeOutlet(row = {}) {
  return deepFreeze({
    id: requiredId(row.id, "outlet_id_required"),
    tenantId: requiredId(row.tenantId, "outlet_tenant_required"),
    organizationId: requiredId(row.organizationId, "outlet_organization_required"),
    brandId: requiredId(row.brandId, "outlet_brand_required"),
    code: requiredCode(row.code, "outlet_code_required"),
    name: requiredText(row.name, "outlet_name_required"),
    timezone: normalizeTimezone(row.timezone),
    hours: normalizeHours(row.hours),
    salesModes: normalizeSalesModes(row.salesModes),
    receipt: normalizeReceipt(row.receipt),
    stations: normalizeStations(row.stations),
  });
}

function normalizeTimezone(value) {
  const timezone = requiredText(value, "outlet_timezone_required", 80);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0)); } catch { throw boundaryError("outlet_timezone_invalid"); }
  return timezone;
}

function normalizeHours(rows) {
  if (!Array.isArray(rows) || rows.length !== DAYS.length) throw boundaryError("outlet_hours_week_required");
  const byDay = new Map();
  for (const row of rows) {
    const day = requiredCode(row?.day, "outlet_hours_day_required");
    if (!DAYS.includes(day) || byDay.has(day)) throw boundaryError("outlet_hours_day_invalid");
    const closed = optionalBoolean(row.closed, false, "outlet_hours_closed_invalid");
    const open24Hours = optionalBoolean(row.open24Hours, false, "outlet_hours_open_24_invalid");
    if (closed && open24Hours) throw boundaryError("outlet_hours_mode_invalid");
    let opensAt = null;
    let closesAt = null;
    if (!closed && !open24Hours) {
      opensAt = clockTime(row.opensAt, "outlet_open_time_invalid");
      closesAt = clockTime(row.closesAt, "outlet_close_time_invalid");
      if (opensAt === closesAt) throw boundaryError("outlet_hours_interval_invalid");
    }
    byDay.set(day, deepFreeze({ day, closed, open24Hours, opensAt, closesAt }));
  }
  return deepFreeze(DAYS.map((day) => byDay.get(day)));
}

function normalizeSalesModes(rows = []) {
  return normalizeUnique(rows, (row) => deepFreeze({
    code: requiredCode(row.code, "sales_mode_code_required"),
    name: requiredText(row.name, "sales_mode_name_required"),
    enabled: optionalBoolean(row.enabled, false, "sales_mode_enabled_invalid"),
    priceBookVersion: requiredId(row.priceBookVersion, "sales_mode_price_book_required"),
  }), "sales_mode", (row) => row.code);
}

function normalizeReceipt(row = {}) {
  return deepFreeze({
    templateVersion: requiredId(row.templateVersion, "receipt_template_version_required"),
    header: optionalText(row.header, "receipt_header_invalid", 240),
    footer: optionalText(row.footer, "receipt_footer_invalid", 240),
    showCashier: optionalBoolean(row.showCashier, true, "receipt_show_cashier_invalid"),
    showBusinessDate: optionalBoolean(row.showBusinessDate, true, "receipt_show_business_date_invalid"),
    showTaxServicePolicy: optionalBoolean(row.showTaxServicePolicy, true, "receipt_show_policy_invalid"),
  });
}

function normalizeStations(rows = []) {
  return normalizeUnique(rows, (row) => {
    const kind = requiredCode(row.kind, "station_kind_required");
    if (!STATION_KINDS.has(kind)) throw boundaryError("station_kind_invalid");
    return deepFreeze({ code: requiredCode(row.code, "station_code_required"), name: requiredText(row.name, "station_name_required"), kind, enabled: optionalBoolean(row.enabled, false, "station_enabled_invalid") });
  }, "station", (row) => row.code);
}

function normalizeUnique(rows, normalize, label, key) {
  if (!Array.isArray(rows)) throw boundaryError(`${label}_list_invalid`);
  const normalized = rows.map(normalize);
  const seen = new Set();
  for (const row of normalized) {
    const value = key(row);
    if (seen.has(value)) throw boundaryError(`${label}_duplicate`);
    seen.add(value);
  }
  return deepFreeze(normalized);
}

function clockTime(value, code) {
  const normalized = String(value ?? "");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(normalized)) throw boundaryError(code);
  return normalized;
}

function optionalBoolean(value, fallback, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw boundaryError(code);
  return value;
}

function optionalText(value, code, maximum) {
  if (value == null) return "";
  if (typeof value !== "string") throw boundaryError(code);
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u001f]/u.test(normalized)) throw boundaryError(code);
  return normalized;
}
