import { AsyncLocalStorage } from "node:async_hooks";
import { createInventoryReportingOwnerApi, INVENTORY_REPORTING_PRIVATE_AUTHORITY } from "../services/inventory-reporting-owner-api.mjs";
import { createHash } from "node:crypto";
import {
  createInventoryReportingB20PostgresRuntimeAdapter,
  InventoryReportingB20PostgresProvider,
} from "../services/inventory-reporting-b20-postgres.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const POLICY_VERSION = /^[A-Za-z0-9._:-]{1,80}$/;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_HEALTH_COUNT = 1_000_000;
const MAX_HEALTH_SECONDS = 31 * 24 * 60 * 60;
const EMPTY_QUEUE = Object.freeze({ pending: 0, retryWait: 0, running: 0, deadLetter: 0, expiredLease: 0 });

export const INVENTORY_REPORTING_DURABLE_PIPELINE_HEALTH_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_DURABLE_PIPELINE_HEALTH_V1";

/**
 * Stable production composition boundary for optional B20 reporting.
 * Factories are injected so a future persisted projection/job implementation
 * can replace direct reads without changing the HTTP server or launcher.
 */
export function createProductionInventoryReportingRuntime({
  environment = {}, db, ids, authority = null, planningStateIntegrityKey, config,
  clock = () => new Date(), projectionRuntimeFactory = null, jobWorkerFactory = null, resolveOwnerReportContext = null, policyAuthorityForContext = null,
} = {}) {
  const mode = reportingMode(environment.SAGA_POS_INVENTORY_REPORTING_MODE);
  if (mode === "OFF") return offRuntime();

  const safeIds = reportingIds(ids);
  const safeAuthority = reportingAuthority(authority, safeIds, config);
  const safeConfig = reportingConfig(config, Boolean(authority));
  if (!db?.transaction) throw new Error("production_inventory_reporting_database_required");
  if (typeof planningStateIntegrityKey !== "string" || Buffer.byteLength(planningStateIntegrityKey, "utf8") < 32) throw new Error("production_inventory_reporting_integrity_key_required");
  if (projectionRuntimeFactory != null && typeof projectionRuntimeFactory !== "function") throw new Error("production_inventory_reporting_projection_factory_invalid");
  if (jobWorkerFactory != null && typeof jobWorkerFactory !== "function") throw new Error("production_inventory_reporting_worker_factory_invalid");
  if (projectionRuntimeFactory && !jobWorkerFactory) throw new Error("production_inventory_reporting_durable_worker_required");
  if (!projectionRuntimeFactory && jobWorkerFactory) throw new Error("production_inventory_reporting_durable_projection_required");
  if (resolveOwnerReportContext != null && typeof resolveOwnerReportContext !== "function") throw new Error("production_inventory_reporting_context_resolver_invalid");
  if (policyAuthorityForContext != null && (typeof policyAuthorityForContext !== "function" || typeof resolveOwnerReportContext !== "function")) throw new Error("production_inventory_reporting_context_policy_invalid");
  const requestAuthority = new AsyncLocalStorage();

  const policyProvider = async ({ query } = {}) => {
    const companyScope = query?.scopeLevel === "COMPANY" && JSON.stringify(query?.outletIds) === JSON.stringify(safeAuthority.outletIds);
    const outletScope = query?.scopeLevel === "OUTLET" && JSON.stringify(query?.outletIds) === JSON.stringify([safeIds.outletId]);
    if (!plain(query) || query.organizationId !== safeAuthority.organizationId || query.policyVersion !== safeConfig.policyVersion
      || (safeAuthority.scopeLevel === "COMPANY" ? !companyScope && !outletScope : !outletScope)) {
      const error = new Error("inventory_reporting_scope_override_denied"); error.code = error.message; error.statusCode = 403; throw error;
    }
    const requested = requestAuthority.getStore() ?? safeAuthority;
    if (!sameReportingScope(requested, safeAuthority) || query.outletIds.some((outletId) => !requested.usableLocationIds[outletId] || !requested.authorityBindings[outletId])) {
      const error = new Error("inventory_reporting_scope_override_denied"); error.code = error.message; error.statusCode = 403; throw error;
    }
    return Object.freeze({
      ...query,
      usableLocationIds: Object.freeze(Object.fromEntries(query.outletIds.map((outletId) => [outletId, requested.usableLocationIds[outletId]]))),
      calendarLocationAuthorityBindings: Object.freeze(Object.fromEntries(query.outletIds.map((outletId) => [outletId, Object.freeze({ revision: requested.authorityBindings[outletId].revision, fingerprint: requested.authorityBindings[outletId].fingerprint })]))),
    });
  };
  const provider = new InventoryReportingB20PostgresProvider({ db, policyProvider, planningStateIntegrityKey });
  const sourceAdapter = createInventoryReportingB20PostgresRuntimeAdapter({ provider });
  const projectionRuntime = projectionRuntimeFactory
    ? projectionRuntimeFactory(Object.freeze({ db, ids: safeIds, provider, sourceAdapter }))
    : sourceAdapter;
  assertProjectionRuntime(projectionRuntime);
  if (projectionRuntimeFactory && (typeof projectionRuntime.assertReady !== "function" || typeof projectionRuntime.shutdown !== "function")) throw new Error("production_inventory_reporting_projection_lifecycle_invalid");
  let state = "STARTING";
  let worker = null;
  let stopped = false;
  let dataQuality = null;
  const projectionMode = projectionRuntimeFactory ? "INJECTED" : "DIRECT_REPEATABLE_READ";
  const guardedProjectionRuntime = Object.freeze({
    async readProjection(input) {
      return requestAuthority.run(input?.[INVENTORY_REPORTING_PRIVATE_AUTHORITY] ?? safeAuthority, async () => {
        assertServing();
        const providerInput = { query: input?.query };
        try { return await projectionRuntime.readProjection(providerInput); }
        catch (error) {
          if (error?.code !== "inventory_reporting_projection_not_found" || typeof worker?.ensureProjection !== "function") throw error;
          try { await worker.ensureProjection(input?.query); }
          catch { throw unavailable(); }
          return projectionRuntime.readProjection(providerInput);
        }
      });
    },
    async resolveSourceReference(input) {
      return requestAuthority.run(input?.[INVENTORY_REPORTING_PRIVATE_AUTHORITY] ?? safeAuthority, async () => {
        assertServing();
        return projectionRuntime.resolveSourceReference({ query: input?.query, sourceRef: input?.sourceRef, expectedSourceFingerprint: input?.expectedSourceFingerprint });
      });
    },
  });
  const guardedContextResolver = resolveOwnerReportContext && policyAuthorityForContext
    ? async (input) => {
      const context = await resolveOwnerReportContext(input);
      let currentAuthority;
      try { currentAuthority = policyAuthorityForContext(context); }
      catch { throw unavailable(); }
      if (currentAuthority.authorityMode === "HISTORICAL_IMMUTABLE") {
        if (!sameReportingScope(currentAuthority, safeAuthority) || !validHistoricalAuthority(currentAuthority, context)) throw unavailable();
      } else if (!sameReportingAuthority(currentAuthority, safeAuthority)) throw unavailable();
      const branded = { ...context };
      Object.defineProperty(branded, INVENTORY_REPORTING_PRIVATE_AUTHORITY, { value: currentAuthority });
      return Object.freeze(branded);
    }
    : resolveOwnerReportContext;
  const api = createInventoryReportingOwnerApi({
    provider: guardedProjectionRuntime,
    policyVersion: safeConfig.policyVersion,
    resolveOwnerReportContext: guardedContextResolver,
    requireCalendarAuthority: Boolean(resolveOwnerReportContext && policyAuthorityForContext),
  });

  async function start() {
    if (stopped) throw new Error("production_inventory_reporting_stopped");
    if (state === "READY") return health();
    try {
      const readinessRequest = Object.freeze({
        requestId: "PRODUCTION_STARTUP",
        query: readinessQuery({ clock, authority: safeAuthority, config: safeConfig }),
      });
      if (jobWorkerFactory) {
        worker = jobWorkerFactory(Object.freeze({ db, ids: safeIds, provider, sourceAdapter, projectionRuntime }));
        if (!worker || typeof worker.prepare !== "function" || typeof worker.start !== "function" || typeof worker.stop !== "function" || typeof worker.health !== "function") throw new Error("production_inventory_reporting_worker_invalid");
        const prepared = await worker.prepare(readinessRequest);
        if (prepared?.ready !== true) throw new Error("production_inventory_reporting_bootstrap_not_ready");
      }
      const readiness = typeof projectionRuntime.assertReady === "function"
        ? await projectionRuntime.assertReady(readinessRequest)
        : await provider.assertReady(readinessRequest);
      if (readiness?.ready !== true) throw new Error("production_inventory_reporting_projection_not_ready");
      dataQuality = readiness.dataQuality === undefined ? null : reportingDataQuality(readiness.dataQuality);
      if (jobWorkerFactory) {
        await worker.start();
        if (!normalizeDurablePipelineHealth(worker.health()).ready) throw new Error("production_inventory_reporting_worker_not_ready");
      }
      state = "READY";
      return health();
    } catch {
      state = "UNAVAILABLE";
      if (worker?.stop) { try { await worker.stop(); } catch { /* Preserve startup failure. */ } }
      if (typeof projectionRuntime.shutdown === "function") { try { await projectionRuntime.shutdown(); } catch { /* Preserve startup failure. */ } }
      worker = null; stopped = true;
      throw new Error("production_inventory_reporting_not_ready");
    }
  }

  async function shutdown() {
    if (stopped) return;
    stopped = true; state = "STOPPING";
    const results = [];
    if (worker?.stop) {
      try { await worker.stop(); results.push({ status: "fulfilled" }); }
      catch (reason) { results.push({ status: "rejected", reason }); }
    }
    if (typeof projectionRuntime.shutdown === "function") {
      try { await projectionRuntime.shutdown(); results.push({ status: "fulfilled" }); }
      catch (reason) { results.push({ status: "rejected", reason }); }
    }
    worker = null; state = "STOPPED";
    if (results.some((result) => result.status === "rejected")) throw new Error("production_inventory_reporting_shutdown_failed");
  }

  function health() {
    const pipeline = safeDurablePipelineHealth(worker);
    const direct = projectionMode === "DIRECT_REPEATABLE_READ";
    const workerReady = pipeline?.worker.ready === true;
    return Object.freeze({
      mode: "POSTGRES",
      required: true,
      configured: true,
      ready: state === "READY" && (direct || pipeline?.ready === true),
      projection: projectionMode,
      worker: direct ? "OFF" : workerReady ? "READY" : "UNAVAILABLE",
      invalidation: direct ? null : Object.freeze({
        status: pipeline?.invalidation.ready ? "READY" : "UNAVAILABLE",
        backlogCount: pipeline?.invalidation.backlogCount ?? null,
        lagSeconds: pipeline?.invalidation.lagSeconds ?? null,
      }),
      freshness: direct ? Object.freeze({ status: "DIRECT", ageSeconds: null, maxAgeSeconds: null }) : Object.freeze({
        status: pipeline?.freshness.ready ? "FRESH" : pipeline ? "STALE" : "UNKNOWN",
        ageSeconds: pipeline?.freshness.ageSeconds ?? null,
        maxAgeSeconds: pipeline?.freshness.maxAgeSeconds ?? null,
      }),
      queue: direct ? null : pipeline?.queue ?? null,
      ...(dataQuality ? { dataQuality } : {}),
    });
  }

  function assertServing() {
    if (!health().ready) {
      throw unavailable();
    }
  }

  return Object.freeze({ mode: "POSTGRES", api, start, shutdown, health });
}

function unavailable() { const error = new Error("inventory_reporting_provider_unavailable"); error.code = error.message; error.statusCode = 503; return error; }

function offRuntime() {
  const health = () => Object.freeze({ mode: "OFF", required: false, configured: false, ready: false, projection: "OFF", worker: "OFF", invalidation: null, freshness: null, queue: null });
  return Object.freeze({ mode: "OFF", api: null, start: async () => health(), shutdown: async () => {}, health });
}

function safeDurablePipelineHealth(worker) {
  if (!worker) return null;
  try { return normalizeDurablePipelineHealth(worker.health()); } catch { return null; }
}

function normalizeDurablePipelineHealth(value) {
  exactKeys(value, ["contract", "freshness", "invalidation", "queue", "ready", "worker"]);
  if (value.contract !== INVENTORY_REPORTING_DURABLE_PIPELINE_HEALTH_CONTRACT || typeof value.ready !== "boolean") throw new Error("production_inventory_reporting_pipeline_health_invalid");
  exactKeys(value.worker, ["ready"]);
  exactKeys(value.invalidation, ["backlogCount", "lagSeconds", "ready"]);
  exactKeys(value.freshness, ["ageSeconds", "maxAgeSeconds", "ready"]);
  exactKeys(value.queue, ["deadLetter", "expiredLease", "pending", "retryWait", "running"]);
  if (typeof value.worker.ready !== "boolean" || typeof value.invalidation.ready !== "boolean" || typeof value.freshness.ready !== "boolean") throw new Error("production_inventory_reporting_pipeline_health_invalid");
  const invalidation = Object.freeze({
    ready: value.invalidation.ready,
    backlogCount: boundedHealthInteger(value.invalidation.backlogCount, MAX_HEALTH_COUNT),
    lagSeconds: boundedHealthInteger(value.invalidation.lagSeconds, MAX_HEALTH_SECONDS),
  });
  const freshness = Object.freeze({
    ready: value.freshness.ready,
    ageSeconds: boundedHealthInteger(value.freshness.ageSeconds, MAX_HEALTH_SECONDS),
    maxAgeSeconds: boundedHealthInteger(value.freshness.maxAgeSeconds, MAX_HEALTH_SECONDS, 1),
  });
  if (freshness.ready !== (freshness.ageSeconds <= freshness.maxAgeSeconds)) throw new Error("production_inventory_reporting_pipeline_health_invalid");
  const queue = Object.freeze(Object.fromEntries(Object.keys(EMPTY_QUEUE).map((key) => [key, boundedHealthInteger(value.queue[key], MAX_HEALTH_COUNT)])));
  const worker = Object.freeze({ ready: value.worker.ready });
  const ready = worker.ready && invalidation.ready && freshness.ready && freshness.ageSeconds <= freshness.maxAgeSeconds && queue.deadLetter === 0 && queue.expiredLease === 0;
  if (value.ready !== ready) throw new Error("production_inventory_reporting_pipeline_health_invalid");
  return Object.freeze({ ready, worker, invalidation, freshness, queue });
}

function exactKeys(value, keys) {
  if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error("production_inventory_reporting_pipeline_health_invalid");
}

function boundedHealthInteger(value, max, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("production_inventory_reporting_pipeline_health_invalid");
  return value;
}

function reportingMode(value) {
  const mode = String(value ?? "off").trim().toUpperCase();
  if (!new Set(["OFF", "POSTGRES"]).has(mode)) throw new Error("production_inventory_reporting_mode_invalid");
  return mode;
}

function reportingIds(value) {
  if (!plain(value) || !UUID.test(value.organizationId ?? "") || !UUID.test(value.outletId ?? "")) throw new Error("production_inventory_reporting_ids_invalid");
  return Object.freeze({ organizationId: value.organizationId, outletId: value.outletId });
}

function reportingConfig(value, trustedAuthority) {
  const allowed = trustedAuthority ? ["policyVersion", "scopeLevel"] : ["policyVersion", "usableLocationId"];
  if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...allowed].sort())) throw new Error("production_inventory_reporting_config_required");
  if (!POLICY_VERSION.test(value.policyVersion ?? "") || (!trustedAuthority && !UUID.test(value.usableLocationId ?? ""))
    || (trustedAuthority && value.scopeLevel !== "COMPANY")) throw new Error("production_inventory_reporting_config_invalid");
  return Object.freeze({ policyVersion: value.policyVersion, ...(trustedAuthority ? { scopeLevel: "COMPANY" } : { usableLocationId: value.usableLocationId }) });
}

function reportingDataQuality(value) {
  if (!plain(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["legacyPaidOrderGapBacklog", "truncated"])) throw new Error("production_inventory_reporting_data_quality_invalid");
  if (!Number.isSafeInteger(value.legacyPaidOrderGapBacklog) || value.legacyPaidOrderGapBacklog < 0 || value.legacyPaidOrderGapBacklog > 1_000 || typeof value.truncated !== "boolean") throw new Error("production_inventory_reporting_data_quality_invalid");
  return Object.freeze({ legacyPaidOrderGapBacklog: value.legacyPaidOrderGapBacklog, truncated: value.truncated });
}

function reportingAuthority(value, ids, config) {
  if (value == null) {
    const binding = Object.freeze({ revision: 1, fingerprint: hash({ authority: "CONFIGURED_CURRENT_CALENDAR_LOCATION", organizationId: ids.organizationId, outletId: ids.outletId, usableLocationId: config?.usableLocationId, policyVersion: config?.policyVersion }) });
    return Object.freeze({ organizationId: ids.organizationId, scopeLevel: "OUTLET", outletIds: Object.freeze([ids.outletId]), usableLocationIds: Object.freeze({ [ids.outletId]: config?.usableLocationId }), authorityBindings: Object.freeze({ [ids.outletId]: binding }), authorityMode: "CURRENT" });
  }
  if (!plain(value) || value.organizationId !== ids.organizationId || value.scopeLevel !== "COMPANY" || !Array.isArray(value.outletIds)
    || value.outletIds.length < 1 || value.outletIds.length > 50 || !plain(value.usableLocationIds)) throw new Error("production_inventory_reporting_authority_invalid");
  const outletIds = value.outletIds.map((item) => String(item).toLowerCase());
  if (JSON.stringify(outletIds) !== JSON.stringify([...new Set(outletIds)].sort()) || outletIds.some((item) => !UUID.test(item))) throw new Error("production_inventory_reporting_authority_invalid");
  if (JSON.stringify(Object.keys(value.usableLocationIds).sort()) !== JSON.stringify(outletIds)
    || outletIds.some((item) => !UUID.test(value.usableLocationIds[item] ?? ""))) throw new Error("production_inventory_reporting_authority_invalid");
  const suppliedBindings = value.authorityBindings ?? Object.fromEntries(outletIds.map((outletId) => [outletId, { revision: 1, fingerprint: hash({ authority: "LEGACY_CONFIGURED_COMPANY", organizationId: ids.organizationId, outletId, usableLocationId: value.usableLocationIds[outletId], policyVersion: config?.policyVersion }) }]));
  if (!plain(suppliedBindings) || JSON.stringify(Object.keys(suppliedBindings).sort()) !== JSON.stringify(outletIds)) throw new Error("production_inventory_reporting_authority_invalid");
  const authorityBindings = Object.fromEntries(outletIds.map((outletId) => {
    const binding = suppliedBindings[outletId];
    if (!plain(binding) || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || !/^[0-9a-f]{64}$/.test(binding.fingerprint ?? "")) throw new Error("production_inventory_reporting_authority_invalid");
    return [outletId, Object.freeze({ revision: binding.revision, fingerprint: binding.fingerprint })];
  }));
  return Object.freeze({ organizationId: ids.organizationId, scopeLevel: "COMPANY", outletIds: Object.freeze(outletIds), usableLocationIds: Object.freeze({ ...value.usableLocationIds }), authorityBindings: Object.freeze(authorityBindings), authorityMode: "CURRENT" });
}

function sameReportingAuthority(current, expected) {
  if (!sameReportingScope(current, expected) || !plain(current.usableLocationIds) || !plain(current.authorityBindings)) return false;
  const companyMatch = current.scopeLevel === "COMPANY" && expected.scopeLevel === "COMPANY"
    && JSON.stringify(current.outletIds) === JSON.stringify(expected.outletIds);
  const outletMatch = current.scopeLevel === "OUTLET" && current.outletIds.length === 1
    && (expected.scopeLevel === "COMPANY" || expected.scopeLevel === "OUTLET") && expected.outletIds.includes(current.outletIds[0]);
  if (!companyMatch && !outletMatch) return false;
  if (JSON.stringify(Object.keys(current.usableLocationIds).sort()) !== JSON.stringify([...current.outletIds].sort())) return false;
  return current.outletIds.every((outletId) => current.usableLocationIds[outletId] === expected.usableLocationIds[outletId]
    && current.authorityBindings[outletId]?.revision === expected.authorityBindings[outletId]?.revision
    && current.authorityBindings[outletId]?.fingerprint === expected.authorityBindings[outletId]?.fingerprint);
}

function sameReportingScope(current, expected) {
  if (!plain(current) || current.organizationId !== expected.organizationId || !Array.isArray(current.outletIds)) return false;
  const companyMatch = current.scopeLevel === "COMPANY" && expected.scopeLevel === "COMPANY" && JSON.stringify(current.outletIds) === JSON.stringify(expected.outletIds);
  const outletMatch = current.scopeLevel === "OUTLET" && current.outletIds.length === 1 && expected.outletIds.includes(current.outletIds[0]);
  return companyMatch || outletMatch;
}

function validHistoricalAuthority(authority, context) {
  if (!plain(authority.usableLocationIds) || !plain(authority.authorityBindings) || !plain(context?.calendar)) return false;
  if (JSON.stringify(Object.keys(authority.usableLocationIds).sort()) !== JSON.stringify([...authority.outletIds].sort())
    || JSON.stringify(Object.keys(authority.authorityBindings).sort()) !== JSON.stringify([...authority.outletIds].sort())) return false;
  return authority.outletIds.every((outletId) => {
    const binding = authority.authorityBindings[outletId];
    return plain(binding) && binding.usableLocationId === authority.usableLocationIds[outletId]
      && binding.timeZone === context.calendar.timeZone && binding.businessDateCutoffLocal === context.calendar.businessDateCutoffLocal
      && Number.isSafeInteger(binding.revision) && binding.revision > 0 && /^[0-9a-f]{64}$/.test(binding.fingerprint ?? "");
  });
}

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function readinessQuery({ clock, authority, config }) {
  const end = clock();
  if (!(end instanceof Date) || !Number.isFinite(end.getTime())) throw new Error("production_inventory_reporting_clock_invalid");
  return Object.freeze({
    organizationId: authority.organizationId,
    outletIds: authority.outletIds,
    scopeLevel: authority.scopeLevel,
    periodStartUtc: new Date(end.getTime() - DAY_MS).toISOString(),
    periodEndUtc: end.toISOString(),
    snapshotCutoffUtc: end.toISOString(),
    includedStatuses: Object.freeze(["POSTED"]),
    currency: "IDR",
    policyVersion: config.policyVersion,
  });
}

function assertProjectionRuntime(value) {
  if (!value || ["readProjection", "resolveSourceReference"].some((method) => typeof value[method] !== "function")) throw new Error("production_inventory_reporting_projection_runtime_invalid");
}

function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
