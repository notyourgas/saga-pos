import { createHash } from "node:crypto";

import { InventoryLocationLedger } from "./inventory-locations.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CUTOFF = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const MAX_OUTLETS = 50;
const MAX_LOCATION_FACTS_PER_OUTLET = 100000;
const MAX_HISTORICAL_AUTHORITY_FACTS = 100000;

export function createInventoryReportingCompanyAuthorityResolver({ db, organizationId, defaultOutletId, clock = () => new Date(), companyViewEnabled = true } = {}) {
  if (!db?.transaction) throw failure("inventory_reporting_company_database_required");
  const trustedOrganizationId = uuid(organizationId, "inventory_reporting_company_scope_invalid");
  const trustedDefaultOutletId = uuid(defaultOutletId, "inventory_reporting_company_scope_invalid");
  if (typeof clock !== "function") throw failure("inventory_reporting_company_clock_invalid");
  if (typeof companyViewEnabled !== "boolean") throw failure("inventory_reporting_company_config_invalid");
  const privatePolicies = new WeakMap();
  const locationAuthorityCache = new Map();

  async function resolveOwnerReportContext({ authUserId, requestedView = "OUTLET", reportDate = null } = {}) {
    const identity = uuid(authUserId, "inventory_reporting_company_auth_invalid");
    const scopeLevel = view(requestedView);
    if (scopeLevel === "COMPANY" && !companyViewEnabled) throw failure("inventory_reporting_view_forbidden", 403);
    const resolved = await db.transaction(async (tx) => {
      await tx.query("set transaction isolation level repeatable read, read only");
      const readiness = (await tx.query(
        `select current_setting('row_security') row_security,
                bool_and(c.relrowsecurity and c.relforcerowsecurity) forced_rls,
                count(*)::integer table_count
           from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='sagaops' and c.relkind='r'
            and c.relname=any($1::text[])`,
        [["organizations", "outlets", "user_profiles", "outlet_user_roles", "inventory_location_aggregates", "inventory_location_facts", "inventory_reporting_calendar_location_facts"]],
      )).rows[0];
      if (!readiness || readiness.row_security !== "on" || readiness.forced_rls !== true || Number(readiness.table_count) !== 7) throw failure("inventory_reporting_company_rls_not_ready", 503);
      const owner = (await tx.query(
        `select o.id organization_id,o.status,o.archived_at,
                (o.owner_auth_user_id=$2::uuid) exact_owner,
                (select count(*)::integer
                   from sagaops.outlet_user_roles r
                   join sagaops.user_profiles p on p.id=r.user_profile_id
                  where r.organization_id=o.id and r.outlet_id is null
                    and r.role='owner' and r.status='active'
                    and p.auth_user_id=$2::uuid and p.status='active') organization_owner_rows
           from sagaops.organizations o
          where o.id=$1::uuid`,
        [trustedOrganizationId, identity],
      )).rows[0];
      if (!owner || owner.organization_id !== trustedOrganizationId || owner.status !== "active" || owner.archived_at != null) throw failure("inventory_reporting_company_scope_denied", 403);
      const ownerRows = Number(owner.organization_owner_rows);
      if (!Number.isSafeInteger(ownerRows) || ownerRows !== 1) throw failure("inventory_reporting_company_scope_denied", 403);

      if (reportDate != null) return resolveHistoricalAuthority({ tx, reportDate, scopeLevel, organizationId: trustedOrganizationId, defaultOutletId: trustedDefaultOutletId });

      const outletRows = (await tx.query(
        `select id,name,timezone,business_date_cutoff_local::text business_date_cutoff_local
           from sagaops.outlets
          where organization_id=$1::uuid and status='active' and archived_at is null
          order by (id=$2::uuid) desc,id
          limit 51`,
        [trustedOrganizationId, trustedDefaultOutletId],
      )).rows;
      if (outletRows.length < 1 || (scopeLevel === "COMPANY" && outletRows.length > MAX_OUTLETS)) throw failure("inventory_reporting_company_outlet_count_invalid", 422);
      const defaultRow = outletRows.find((row) => String(row.id).toLowerCase() === trustedDefaultOutletId);
      if (!defaultRow) throw failure("inventory_reporting_company_default_outlet_unavailable", 422);
      const selectedRows = scopeLevel === "COMPANY" ? outletRows : [defaultRow];
      const selectedOutlets = selectedRows.map(outletRecord).sort((left, right) => left.outletId.localeCompare(right.outletId));
      assertSortedUnique(selectedOutlets.map((item) => item.outletId));
      const selectedOutletIds = Object.freeze(selectedOutlets.map((item) => item.outletId));
      let companyMetadataReady = outletRows.length <= MAX_OUTLETS;
      let companyOutlets = [];
      for (const row of outletRows) {
        try { companyOutlets.push(outletRecord(row)); }
        catch { companyMetadataReady = false; }
      }
      companyOutlets = companyOutlets.sort((left, right) => left.outletId.localeCompare(right.outletId));
      try { assertSortedUnique(companyOutlets.map((item) => item.outletId)); } catch { companyMetadataReady = false; }
      const allOutletIds = Object.freeze(companyOutlets.map((item) => item.outletId));
      const timezone = common(selectedRows.map((row) => timeZone(row.timezone)), "inventory_reporting_company_calendar_mismatch");
      const cutoff = common(selectedRows.map((row) => cutoffTime(row.business_date_cutoff_local)), "inventory_reporting_company_calendar_mismatch");
      const companyCalendarReady = companyMetadataReady && commonOrNull(outletRows.map((row) => safeTimeZone(row.timezone))) != null
        && commonOrNull(outletRows.map((row) => safeCutoff(row.business_date_cutoff_local))) != null;

      const aggregateRows = (await tx.query(
        `select a.outlet_id,a.revision,terminal.fact_hash terminal_fact_hash
           from sagaops.inventory_location_aggregates a
           left join lateral (
             select f.fact_hash from sagaops.inventory_location_facts f
              where f.organization_id=a.organization_id and f.outlet_id=a.outlet_id
              order by f.sequence desc limit 1
           ) terminal on true
          where a.organization_id=$1::uuid and a.outlet_id=any($2::uuid[]) order by a.outlet_id`,
        [trustedOrganizationId, allOutletIds],
      )).rows;
      const signaturesByOutlet = new Map();
      let companySignatureRowsValid = aggregateRows.length === allOutletIds.length;
      for (const row of aggregateRows) {
        const outletId = String(row.outlet_id).toLowerCase();
        try { signaturesByOutlet.set(outletId, locationSignature(row)); }
        catch (error) {
          if (selectedOutletIds.includes(outletId)) throw error;
          companySignatureRowsValid = false;
        }
      }
      const locationsByOutlet = new Map();
      const validationOutletIds = scopeLevel === "COMPANY" ? allOutletIds : selectedOutletIds;
      for (const outletId of validationOutletIds) {
        try {
          const signature = signaturesByOutlet.get(outletId);
          if (!signature) throw failure("inventory_reporting_company_location_state_invalid", 503);
          const cached = locationAuthorityCache.get(outletId);
          if (cached?.signature === signature) {
            locationsByOutlet.set(outletId, cached.locations);
            continue;
          }
          const rows = (await tx.query(
            `select sequence,fact_id,operation_key,request_fingerprint,fact_hash,fact_document,actor_reference,reason,occurred_at
               from sagaops.inventory_location_facts
              where organization_id=$1::uuid and outlet_id=$2::uuid order by sequence limit 100001`,
            [trustedOrganizationId, outletId],
          )).rows;
          if (rows.length > MAX_LOCATION_FACTS_PER_OUTLET) throw failure("inventory_reporting_company_location_state_capacity_exceeded", 503);
          const view = restoreLocationView({ organizationId: trustedOrganizationId, outletId, revision: Number(signature.split(":", 1)[0]), rows });
          const locations = Object.freeze(view.locations.filter((location) => location.status === "ACTIVE" && location.type === "INTERNAL"
            && location.custodyOrganizationId === trustedOrganizationId && location.economicOwnerOrganizationId === trustedOrganizationId
            && location.eligibility.receiptDispositions.includes("USABLE")).map((location) => location.id));
          locationAuthorityCache.set(outletId, Object.freeze({ signature, locations }));
          locationsByOutlet.set(outletId, locations);
        } catch (error) {
          locationAuthorityCache.delete(outletId);
          if (error?.code === "inventory_reporting_company_location_state_capacity_exceeded") throw error;
          throw failure("inventory_reporting_company_location_state_invalid", 503);
        }
      }
      if (selectedOutletIds.some((outletId) => (locationsByOutlet.get(outletId)?.length ?? 0) > 1)) throw failure("inventory_reporting_company_usable_location_ambiguous", 422);
      if (selectedOutletIds.some((outletId) => (locationsByOutlet.get(outletId)?.length ?? 0) !== 1)) {
        throw failure("inventory_reporting_company_usable_location_unavailable", 422);
      }
      const companyLocationReady = companyMetadataReady && companySignatureRowsValid && allOutletIds.length === outletRows.length
        && allOutletIds.every((outletId) => {
          const signature = signaturesByOutlet.get(outletId);
          const cached = locationAuthorityCache.get(outletId);
          return signature != null && cached?.signature === signature && cached.locations.length === 1;
        });
      const usableLocationIds = Object.fromEntries(selectedOutletIds.map((outletId) => [outletId, locationsByOutlet.get(outletId)[0]]));
      const authorityBindings = Object.fromEntries(selectedOutletIds.map((outletId) => {
        const signature = signaturesByOutlet.get(outletId);
        const revision = Number(signature.split(":", 1)[0]);
        return [outletId, Object.freeze({ revision, fingerprint: digest({ authority: "CURRENT_CALENDAR_LOCATION", outletId, timeZone: timezone, businessDateCutoffLocal: cutoff, usableLocationId: usableLocationIds[outletId], locationSignature: signature }), usableLocationId: usableLocationIds[outletId], timeZone: timezone, businessDateCutoffLocal: cutoff })];
      }));
      return { selectedOutlets: Object.freeze(selectedOutlets), selectedOutletIds, timezone, cutoff, usableLocationIds: Object.freeze(usableLocationIds), authorityBindings: Object.freeze(authorityBindings), authorityMode: "CURRENT", companyReady: companyCalendarReady && companyLocationReady };
    });

    if (scopeLevel === "COMPANY" && !resolved.companyReady) throw failure("inventory_reporting_company_scope_unavailable", 422);
    const selectedOutletIds = resolved.selectedOutletIds;
    const calendar = reportCalendar({ reportDate, timezone: resolved.timezone, cutoff: resolved.cutoff, clock });
    const context = deepFreeze({
      scopeLevel,
      organizationId: trustedOrganizationId,
      outletIds: selectedOutletIds,
      outlets: resolved.selectedOutlets,
      calendar,
      availableViews: companyViewEnabled && resolved.companyReady ? ["OUTLET", "COMPANY"] : ["OUTLET"],
    });
    privatePolicies.set(context, deepFreeze({
      organizationId: trustedOrganizationId,
      scopeLevel,
      outletIds: selectedOutletIds,
      usableLocationIds: Object.fromEntries(selectedOutletIds.map((outletId) => [outletId, resolved.usableLocationIds[outletId]])),
      authorityBindings: Object.fromEntries(selectedOutletIds.map((outletId) => [outletId, resolved.authorityBindings[outletId]])),
      authorityMode: resolved.authorityMode,
    }));
    return context;
  }

  function policyAuthorityFor(context) {
    const policy = privatePolicies.get(context);
    if (!policy) throw failure("inventory_reporting_company_context_untrusted", 403);
    return policy;
  }

  return Object.freeze({ resolveOwnerReportContext, policyAuthorityFor });
}

async function resolveHistoricalAuthority({ tx, reportDate, scopeLevel, organizationId, defaultOutletId }) {
  exactKeys(reportDate, ["periodEndDate", "periodStartDate", "snapshotCutoffDate"], "inventory_reporting_company_report_date_invalid");
  const dates = Object.fromEntries(Object.entries(reportDate).map(([key, value]) => [key, date(value)]));
  validateDateRange(dates);
  const scanStart = new Date(Date.parse(`${dates.periodStartDate}T00:00:00Z`) - 2 * 86400000).toISOString();
  const scanEnd = new Date(Date.parse(`${dates.periodEndDate}T00:00:00Z`) + 2 * 86400000).toISOString();
  const rows = (await tx.query(
    `with prior as (
       select f.*,row_number() over(partition by f.outlet_id order by f.effective_at desc,f.sequence desc) authority_rank
         from sagaops.inventory_reporting_calendar_location_facts f
        where f.organization_id=$1::uuid and f.effective_at<$2::timestamptz
     ), authority_window as (
       select organization_id,outlet_id,sequence,effective_at,outlet_active,outlet_label,timezone,
              business_date_cutoff_local::text business_date_cutoff_local,usable_location_id,
              usable_location_count,location_revision,location_terminal_fact_hash,fact_hash,fact_document,recorded_at
         from prior where authority_rank=1
       union all
       select organization_id,outlet_id,sequence,effective_at,outlet_active,outlet_label,timezone,
              business_date_cutoff_local::text,usable_location_id,usable_location_count,location_revision,
              location_terminal_fact_hash,fact_hash,fact_document,recorded_at
         from sagaops.inventory_reporting_calendar_location_facts
        where organization_id=$1::uuid and effective_at>=$2::timestamptz and effective_at<$3::timestamptz
     )
     select * from authority_window order by outlet_id,effective_at,sequence limit 100001`,
    [organizationId, scanStart, scanEnd],
  )).rows;
  if (rows.length > MAX_HISTORICAL_AUTHORITY_FACTS) throw failure("inventory_reporting_historical_authority_capacity_exceeded", 503);
  const groups = new Map();
  for (const row of rows) {
    const fact = historicalAuthorityFact(row, organizationId);
    const values = groups.get(fact.outletId) ?? [];
    if (values.length && (fact.sequence !== values.at(-1).sequence + 1 || Date.parse(fact.effectiveAt) <= Date.parse(values.at(-1).effectiveAt))) {
      throw failure("inventory_reporting_historical_authority_invalid", 503);
    }
    values.push(fact); groups.set(fact.outletId, values);
  }
  const selected = [];
  for (const values of groups.values()) {
    const matches = values.filter((fact, index) => {
      const calendar = reportCalendar({ reportDate: dates, timezone: fact.timeZone, cutoff: fact.cutoff, clock: null });
      const start = Date.parse(calendar.periodStartUtc);
      const next = values[index + 1];
      return Date.parse(fact.effectiveAt) <= start && (!next || Date.parse(next.effectiveAt) > start);
    });
    if (matches.length > 1) throw failure("inventory_reporting_historical_authority_ambiguous", 503);
    if (matches.length === 1 && matches[0].outletActive) selected.push(matches[0]);
  }
  const requested = scopeLevel === "OUTLET" ? selected.filter((fact) => fact.outletId === defaultOutletId) : selected;
  if (scopeLevel === "OUTLET" && requested.length !== 1) throw failure("inventory_reporting_historical_authority_missing", 422);
  if (scopeLevel === "COMPANY" && (requested.length < 1 || requested.length > MAX_OUTLETS)) throw failure("inventory_reporting_company_outlet_count_invalid", 422);
  if (requested.some((fact) => fact.usableLocationCount > 1)) throw failure("inventory_reporting_company_usable_location_ambiguous", 422);
  if (requested.some((fact) => fact.usableLocationCount !== 1)) throw failure("inventory_reporting_company_usable_location_unavailable", 422);
  const timezone = common(requested.map((fact) => fact.timeZone), "inventory_reporting_company_calendar_mismatch");
  const cutoff = common(requested.map((fact) => fact.cutoff), "inventory_reporting_company_calendar_mismatch");
  const calendar = reportCalendar({ reportDate: dates, timezone, cutoff, clock: null });
  const relevantGroups = scopeLevel === "OUTLET" ? [groups.get(defaultOutletId) ?? []] : [...groups.values()];
  if (relevantGroups.some((facts) => facts.some((fact) => {
    const factCalendar = reportCalendar({ reportDate: dates, timezone: fact.timeZone, cutoff: fact.cutoff, clock: null });
    return fact.outletActive && Date.parse(fact.effectiveAt) > Date.parse(factCalendar.periodStartUtc) && Date.parse(fact.effectiveAt) < Date.parse(factCalendar.periodEndUtc);
  }))) throw failure("inventory_reporting_historical_authority_changed", 409);
  for (const fact of requested) {
    const values = groups.get(fact.outletId);
    const next = values[values.indexOf(fact) + 1];
    if (next && Date.parse(next.effectiveAt) < Date.parse(calendar.periodEndUtc)) throw failure("inventory_reporting_historical_authority_changed", 409);
  }
  const selectedOutletIds = Object.freeze(requested.map((fact) => fact.outletId).sort());
  const byId = new Map(requested.map((fact) => [fact.outletId, fact]));
  const companyCandidates = selected.filter((fact) => fact.usableLocationCount === 1);
  const companyReady = companyCandidates.length > 0 && companyCandidates.length <= MAX_OUTLETS
    && commonOrNull(companyCandidates.map((fact) => fact.timeZone)) != null && commonOrNull(companyCandidates.map((fact) => fact.cutoff)) != null;
  return {
    selectedOutlets: Object.freeze(selectedOutletIds.map((outletId) => Object.freeze({ outletId, label: byId.get(outletId).outletLabel }))),
    selectedOutletIds, timezone, cutoff,
    usableLocationIds: Object.freeze(Object.fromEntries(selectedOutletIds.map((outletId) => [outletId, byId.get(outletId).usableLocationId]))),
    authorityBindings: Object.freeze(Object.fromEntries(selectedOutletIds.map((outletId) => [outletId, Object.freeze({ revision: byId.get(outletId).sequence, fingerprint: byId.get(outletId).factHash, usableLocationId: byId.get(outletId).usableLocationId, timeZone: byId.get(outletId).timeZone, businessDateCutoffLocal: byId.get(outletId).cutoff })]))),
    authorityMode: "HISTORICAL_IMMUTABLE", companyReady,
  };
}

function historicalAuthorityFact(row, organizationId) {
  let document;
  try { document = typeof row.fact_document === "string" ? JSON.parse(row.fact_document) : structuredClone(row.fact_document); } catch { throw failure("inventory_reporting_historical_authority_invalid", 503); }
  const outletId = uuid(row.outlet_id, "inventory_reporting_historical_authority_invalid");
  const sequence = Number(row.sequence); const effectiveAt = iso(row.effective_at); const factHash = String(row.fact_hash ?? "").toLowerCase();
  const locationRevision = Number(row.location_revision); const usableLocationCount = Number(row.usable_location_count);
  if (row.organization_id !== organizationId || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(locationRevision) || locationRevision < 0
    || !Number.isSafeInteger(usableLocationCount) || usableLocationCount < 0 || usableLocationCount > 100001 || !/^[0-9a-f]{64}$/.test(factHash)) throw failure("inventory_reporting_historical_authority_invalid", 503);
  if (typeof document.hashPayload !== "string" || createHash("sha256").update(document.hashPayload).digest("hex") !== factHash || document.factHash !== factHash || document.organizationId !== organizationId || document.outletId !== outletId
    || document.sequence !== sequence || iso(document.effectiveAt) !== effectiveAt || document.outletActive !== row.outlet_active
    || document.outletLabel !== row.outlet_label || document.timeZone !== row.timezone
    || document.businessDateCutoffLocal !== String(row.business_date_cutoff_local).slice(0,8)
    || document.usableLocationId !== (row.usable_location_id ?? null) || document.usableLocationCount !== usableLocationCount
    || document.locationRevision !== locationRevision || document.locationTerminalFactHash !== (row.location_terminal_fact_hash ?? null)) throw failure("inventory_reporting_historical_authority_invalid", 503);
  if ((usableLocationCount === 1) !== (row.usable_location_id != null)) throw failure("inventory_reporting_historical_authority_invalid", 503);
  return Object.freeze({ outletId, sequence, effectiveAt, outletActive: Boolean(row.outlet_active), outletLabel: label(row.outlet_label), timeZone: timeZone(row.timezone), cutoff: cutoffTime(row.business_date_cutoff_local), usableLocationId: row.usable_location_id == null ? null : uuid(row.usable_location_id, "inventory_reporting_historical_authority_invalid"), usableLocationCount, factHash });
}

function reportCalendar({ reportDate, timezone, cutoff, clock }) {
  let dates;
  if (reportDate == null) {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure("inventory_reporting_company_clock_invalid");
    const localToday = localDate(now, timezone);
    const start = now.getTime() < Date.parse(zonedBoundary(localToday, cutoff, timezone)) ? addDate(localToday, -1) : localToday;
    const end = addDate(start, 1);
    dates = { periodStartDate: start, periodEndDate: end, snapshotCutoffDate: end };
  } else {
    exactKeys(reportDate, ["periodEndDate", "periodStartDate", "snapshotCutoffDate"], "inventory_reporting_company_report_date_invalid");
    dates = Object.fromEntries(Object.entries(reportDate).map(([key, value]) => [key, date(value)]));
  }
  validateDateRange(dates);
  return deepFreeze({
    timeZone: timezone,
    businessDateCutoffLocal: cutoff,
    ...dates,
    periodStartUtc: zonedBoundary(dates.periodStartDate, cutoff, timezone),
    periodEndUtc: zonedBoundary(dates.periodEndDate, cutoff, timezone),
    snapshotCutoffUtc: zonedBoundary(dates.snapshotCutoffDate, cutoff, timezone),
  });
}

function validateDateRange(dates) {
  const startMs = Date.parse(`${dates.periodStartDate}T00:00:00Z`);
  const endMs = Date.parse(`${dates.periodEndDate}T00:00:00Z`);
  const snapshotMs = Date.parse(`${dates.snapshotCutoffDate}T00:00:00Z`);
  if (!(startMs < endMs) || endMs - startMs > 366 * 86400000 || snapshotMs < endMs || snapshotMs - endMs > 31 * 86400000) throw failure("inventory_reporting_company_report_date_invalid", 422);
}

function zonedBoundary(dateValue, cutoff, timezone) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute, second] = cutoff.split(":").map(Number);
  const expected = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = expected;
  for (let index = 0; index < 4; index += 1) candidate += expected - zonedParts(candidate, timezone);
  if (zonedParts(candidate, timezone) !== expected) throw failure("inventory_reporting_company_calendar_invalid", 422);
  return new Date(candidate).toISOString();
}

function zonedParts(milliseconds, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(milliseconds));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
}

function localDate(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const item = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${item.year}-${item.month}-${item.day}`;
}
function restoreLocationView({ organizationId, outletId, revision, rows }) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision !== rows.length) throw failure("inventory_reporting_company_location_state_invalid", 503);
  const ledger = new InventoryLocationLedger({ organizationId, outletId });
  const state = ledger.exportState();
  state.facts = rows.map((row, index) => {
    let fact;
    try { fact = typeof row.fact_document === "string" ? JSON.parse(row.fact_document) : structuredClone(row.fact_document); } catch { throw failure("inventory_reporting_company_location_state_invalid", 503); }
    if (Number(row.sequence) !== index + 1 || fact.sequence !== Number(row.sequence) || fact.factId !== row.fact_id
      || fact.operationKey !== row.operation_key || fact.requestFingerprint !== row.request_fingerprint || fact.factHash !== row.fact_hash
      || fact.actorId !== row.actor_reference || fact.reason !== row.reason || fact.occurredAt !== iso(row.occurred_at)) throw failure("inventory_reporting_company_location_state_invalid", 503);
    return fact;
  });
  try { ledger.restoreState(state); } catch { throw failure("inventory_reporting_company_location_state_invalid", 503); }
  return ledger.view();
}
function locationSignature(row) {
  const revision = Number(row?.revision);
  const terminalFactHash = String(row?.terminal_fact_hash ?? "").toLowerCase();
  if (!Number.isSafeInteger(revision) || revision < 1 || !/^[0-9a-f]{64}$/.test(terminalFactHash)) throw failure("inventory_reporting_company_location_state_invalid", 503);
  return `${revision}:${terminalFactHash}`;
}
function addDate(value, days) { return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10); }
function iso(value) { const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString(); if (!Number.isFinite(Date.parse(result))) throw failure("inventory_reporting_company_location_state_invalid", 503); return result; }
function date(value) { if (typeof value !== "string" || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw failure("inventory_reporting_company_report_date_invalid", 422); return value; }
function timeZone(value) { if (typeof value !== "string" || value.length < 1 || value.length > 80) throw failure("inventory_reporting_company_calendar_invalid", 422); try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { throw failure("inventory_reporting_company_calendar_invalid", 422); } return value; }
function cutoffTime(value) { const normalized = String(value ?? "").slice(0, 8); if (!CUTOFF.test(normalized)) throw failure("inventory_reporting_company_calendar_invalid", 422); return normalized; }
function common(values, code) { if (!values.length || values.some((value) => value !== values[0])) throw failure(code, 422); return values[0]; }
function commonOrNull(values) { return values.length > 0 && values.every((value) => value != null && value === values[0]) ? values[0] : null; }
function safeTimeZone(value) { try { return timeZone(value); } catch { return null; } }
function safeCutoff(value) { try { return cutoffTime(value); } catch { return null; } }
function outletRecord(row) { return Object.freeze({ outletId: uuid(row.id, "inventory_reporting_company_outlet_invalid"), label: label(row.name) }); }
function label(value) { if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 120 || /[<>\u0000-\u001f\u007f]/.test(value)) throw failure("inventory_reporting_company_outlet_label_invalid", 422); return value; }
function view(value) { const normalized = String(value ?? "").toUpperCase(); if (normalized !== "OUTLET" && normalized !== "COMPANY") throw failure("inventory_reporting_company_view_invalid", 422); return normalized; }
function uuid(value, code) { if (typeof value !== "string" || !UUID.test(value)) throw failure(code); return value.toLowerCase(); }
function assertSortedUnique(values) { const sorted = [...new Set(values)].sort(); if (JSON.stringify(values) !== JSON.stringify(sorted)) throw failure("inventory_reporting_company_outlets_invalid", 503); }
function exactKeys(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw failure(code, 422); }
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
function failure(code, statusCode = 500) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
