import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { buildInventoryReportingProjection } from "../services/inventory-reporting-b20.mjs";
import { createInventoryReportingInvalidationConsumer, INVENTORY_MOVEMENT_REBUILD_EVENT } from "../services/inventory-reporting-invalidation-b20.mjs";
import {
  createInventoryReportingRebuildOrchestrator,
  inventoryReportingJobQueryFingerprint,
} from "../services/inventory-reporting-jobs-b20.mjs";
import {
  createInventoryReportingPersistedProjectionRuntimeAdapter,
  InventoryReportingJobPostgresPersistence,
  inventoryReportingWorkerConfigFromEnv,
} from "../services/inventory-reporting-jobs-b20-postgres.mjs";
import { createInventoryReportingProductionWorker } from "../services/inventory-reporting-production-worker-b20.mjs";
import { createInventoryReportingWorker } from "../services/inventory-reporting-worker-b20.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Builds production-only factories for the stable reporting runtime boundary.
 * OFF returns before reading credentials or examining a database dependency.
 */
export async function createDurableProductionInventoryReportingComposition({
  mode,
  db,
  ids,
  authority: suppliedAuthority = null,
  credentialDirectory,
  planningStateIntegrityKey,
  environment = {},
  clock = () => new Date().toISOString(),
  readCredential = readFile,
} = {}) {
  const normalizedMode = reportingMode(mode);
  if (normalizedMode === "OFF") {
    return Object.freeze({ mode: "OFF", projectionRuntimeFactory: null, jobWorkerFactory: null });
  }
  if (!db?.query || !db?.transaction) throw failure("production_inventory_reporting_job_database_required");
  const authority = normalizeAuthority(suppliedAuthority ?? ids);
  if (typeof credentialDirectory !== "string" || credentialDirectory.length < 1 || typeof readCredential !== "function" || typeof clock !== "function") {
    throw failure("production_inventory_reporting_job_composition_invalid");
  }
  const integrityKey = await loadInventoryReportingJobIntegrityKey({ credentialDirectory, readCredential });
  if (integrityKey === planningStateIntegrityKey) throw failure("production_inventory_reporting_job_integrity_key_not_separate");
  const workerConfig = inventoryReportingWorkerConfigFromEnv(environment);
  const projectionMaxAgeSeconds = optionalInteger(environment.SAGAPOS_INVENTORY_REPORTING_PROJECTION_MAX_AGE_SECONDS, 300, 30, 24 * 60 * 60);
  const refreshBudgetMs = Math.floor(projectionMaxAgeSeconds * 500);
  if (workerConfig.intervalMs > refreshBudgetMs) {
    throw failure("production_inventory_reporting_worker_interval_exceeds_refresh_budget");
  }
  let persistence = null;

  function getPersistence() {
    persistence ??= new InventoryReportingJobPostgresPersistence({ db, authority, integrityKey, clock });
    return persistence;
  }

  function projectionRuntimeFactory({ sourceAdapter } = {}) {
    return createInventoryReportingPersistedProjectionRuntimeAdapter({ persistence: getPersistence(), sourceAdapter });
  }

  function jobWorkerFactory({ sourceAdapter } = {}) {
    if (!sourceAdapter?.prepareSource || !sourceAdapter?.loadSource) throw failure("production_inventory_reporting_job_source_adapter_required");
    const durablePersistence = getPersistence();
    const orchestrator = createInventoryReportingRebuildOrchestrator({
      persistence: durablePersistence,
      sourceProvider: sourceAdapter,
      projectionProvider: Object.freeze({ buildProjection: async ({ query, source }) => buildInventoryReportingProjection({ query, source }) }),
      concurrency: workerConfig.batchSize,
      clock,
    });
    const jobWorker = createInventoryReportingWorker({ orchestrator, ...workerConfig, clock });
    let expectedQueryFingerprint = null;
    let defaultQuery = null;
    let lastScheduledRefreshAt = null;
    const rebuildCommandFactory = createBackdatedRebuildCommandFactory({ db, persistence: durablePersistence, sourceAdapter, authority });
    const healthProbe = createInventoryReportingPipelineHealthProbe({
      db,
      persistence: durablePersistence,
      authority,
      clock,
      expectedQueryFingerprint: () => expectedQueryFingerprint,
    });
    const invalidationConsumer = createInventoryReportingInvalidationConsumer({
      db,
      orchestrator,
      authority,
      rebuildCommandFactory,
      enabled: workerConfig.enabled,
      batchSize: Math.min(workerConfig.batchSize, 100),
      clock,
    });
    const productionWorker = createInventoryReportingProductionWorker({
      jobWorker,
      invalidationConsumer,
      healthProbe,
      scheduledProjectionRefresh: async () => {
        if (!defaultQuery || !lastScheduledRefreshAt) throw failure("production_inventory_reporting_schedule_not_initialized");
        const now = instant(clock());
        if (Date.parse(now) - Date.parse(lastScheduledRefreshAt) < Math.floor(projectionMaxAgeSeconds * 500)) return;
        const periodMs = Date.parse(defaultQuery.periodEndUtc) - Date.parse(defaultQuery.periodStartUtc);
        if (!Number.isSafeInteger(periodMs) || periodMs < 1) throw failure("production_inventory_reporting_schedule_query_invalid");
        const rollingQuery = Object.freeze({
          ...defaultQuery,
          periodStartUtc: new Date(Date.parse(now) - periodMs).toISOString(),
          periodEndUtc: now,
          snapshotCutoffUtc: now,
        });
        const result = await bootstrapInventoryReportingProjection({
          request: { requestId: "SCHEDULED_REFRESH", query: rollingQuery }, orchestrator,
          persistence: durablePersistence, sourceAdapter, clock,
        });
        defaultQuery = rollingQuery;
        expectedQueryFingerprint = result.queryFingerprint;
        lastScheduledRefreshAt = now;
      },
      intervalMs: workerConfig.intervalMs,
      projectionMaxAgeSeconds,
      clock,
      onError: () => { console.error("production_inventory_reporting_worker_cycle_failed"); },
    });
    return Object.freeze({
      ...productionWorker,
      async prepare(request = {}) {
        const result = await bootstrapInventoryReportingProjection({
          request,
          orchestrator,
          persistence: durablePersistence,
          sourceAdapter,
          clock,
        });
        defaultQuery = Object.freeze(structuredClone(request.query));
        expectedQueryFingerprint = result.queryFingerprint;
        lastScheduledRefreshAt = instant(clock());
        return result;
      },
      async ensureProjection(query) {
        return bootstrapInventoryReportingProjection({
          request: { requestId: "OWNER_REPORT_READ", query }, orchestrator,
          persistence: durablePersistence, sourceAdapter, clock,
        });
      },
    });
  }

  return Object.freeze({ mode: "POSTGRES", projectionRuntimeFactory, jobWorkerFactory });
}

export async function bootstrapInventoryReportingProjection({ request, orchestrator, persistence, sourceAdapter, clock = () => new Date().toISOString() } = {}) {
  const { requestId, query } = request ?? {};
  if (!new Set(["PRODUCTION_STARTUP", "SCHEDULED_REFRESH", "OWNER_REPORT_READ"]).has(requestId) || !query || typeof query !== "object" || Array.isArray(query)
    || !orchestrator?.enqueue || !orchestrator?.runCommand || !persistence?.readLatestProjection || !sourceAdapter?.prepareSource || typeof clock !== "function") {
    throw failure("production_inventory_reporting_bootstrap_request_invalid");
  }
  const queryFingerprint = inventoryReportingJobQueryFingerprint(query);
  const prefix = requestId === "PRODUCTION_STARTUP" ? "bootstrap" : requestId === "SCHEDULED_REFRESH" ? "scheduled" : "on-demand";
  const commandId = `b20-${prefix}:${queryFingerprint}`;
  const prepared = await sourceAdapter.prepareSource({ commandId, query, queryFingerprint });
  await orchestrator.enqueue({
    commandId,
    idempotencyKey: commandId,
    invalidationId: null,
    policy: Object.freeze({ maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 60_000 }),
    query,
    reason: requestId === "OWNER_REPORT_READ" ? "MANUAL_REBUILD" : "SCHEDULED",
    requestedAt: instant(clock()),
    sourceFingerprint: prepared.sourceFingerprint,
  });
  await orchestrator.runCommand({ workerId: "inventory-reporting-bootstrap", commandId, now: instant(clock()) });
  const projection = await persistence.readLatestProjection({ queryFingerprint });
  if (!projection) throw failure("production_inventory_reporting_bootstrap_not_persisted");
  return Object.freeze({ ready: true, queryFingerprint });
}

export function createInventoryReportingPipelineHealthProbe({ db, persistence, authority, clock = () => new Date().toISOString(), expectedQueryFingerprint = null } = {}) {
  if (!db?.query || !persistence?.metrics || typeof clock !== "function") throw failure("production_inventory_reporting_health_probe_dependency_invalid");
  const scope = normalizeAuthority(authority);
  return async function samplePipelineHealth() {
    const observedAt = instant(clock());
    const expected = typeof expectedQueryFingerprint === "function" ? expectedQueryFingerprint() : expectedQueryFingerprint;
    const [metrics, backlogResult] = await Promise.all([
      persistence.metrics({ now: observedAt, ...(expected ? { expectedQueryFingerprint: expected } : {}) }),
      db.query(
        `select count(*)::integer backlog_count,min(o.created_at) oldest_created_at
           from public.sagaops_integration_outbox o
          where o.organization_id=$1 and o.outlet_id=any($2::uuid[])
            and o.event_type=$3 and o.status in ('pending','published')
            and not exists (
              select 1 from sagaops.inventory_reporting_invalidations i
               where i.organization_id=o.organization_id and i.event_id=o.event_id::text
            )`,
        [scope.organizationId,scope.outletIds,INVENTORY_MOVEMENT_REBUILD_EVENT],
      ),
    ]);
    const projectionCount = Number(metrics?.projectionCount);
    if (!Number.isSafeInteger(projectionCount) || projectionCount < 1 || projectionCount > 1_000_000 || !metrics.latestProjectionAt) throw failure("production_inventory_reporting_projection_not_persisted");
    if (metrics.oldestDueAt && Date.parse(instant(metrics.oldestDueAt)) <= Date.parse(observedAt)) throw failure("production_inventory_reporting_queue_overdue");
    const row = backlogResult.rows?.[0];
    if (!row) throw failure("production_inventory_reporting_invalidation_metrics_invalid");
    const backlogCount = Number(row.backlog_count);
    if (!Number.isSafeInteger(backlogCount) || backlogCount < 0 || backlogCount > 1_000_000) throw failure("production_inventory_reporting_invalidation_metrics_invalid");
    const oldestCreatedAt = row?.oldest_created_at ? instant(row.oldest_created_at) : null;
    if ((backlogCount === 0) !== (oldestCreatedAt === null)) throw failure("production_inventory_reporting_invalidation_metrics_invalid");
    const lagSeconds = oldestCreatedAt ? elapsedSeconds(oldestCreatedAt, observedAt) : 0;
    return Object.freeze({
      queue: Object.freeze({
        pending: Number(metrics.counts?.PENDING),
        retryWait: Number(metrics.counts?.RETRY_WAIT),
        running: Number(metrics.counts?.RUNNING),
        deadLetter: Number(metrics.counts?.DEAD_LETTER),
        expiredLease: Number(metrics.expiredLeaseCount),
      }),
      invalidation: Object.freeze({ backlogCount, lagSeconds }),
      projectionPersistedAt: instant(metrics.latestProjectionAt),
    });
  };
}

export function createBackdatedRebuildCommandFactory({ db, persistence, sourceAdapter, authority } = {}) {
  if (!db?.query || !persistence?.findByCommandId || !sourceAdapter?.prepareSource) throw failure("production_inventory_reporting_rebuild_factory_dependency_invalid");
  const scope = normalizeAuthority(authority);
  return async function rebuildCommandsForEvent(event = {}) {
    if (event.organizationId !== scope.organizationId || !scope.outletIds.includes(event.outletId) || !UUID.test(event.outletId ?? "")) {
      throw failure("production_inventory_reporting_rebuild_scope_mismatch");
    }
    const rows = (await db.query(
      `select min(job_id) job_id from sagaops.inventory_reporting_jobs
        where organization_id=$1 and $2::uuid=any(outlet_ids)
          and status='SUCCEEDED' and period_end_utc > $3
        group by query_fingerprint order by query_fingerprint limit 101`,
      [scope.organizationId,event.outletId,event.effectiveAt],
    )).rows;
    if (rows.length > 100) throw failure("production_inventory_reporting_rebuild_limit_exceeded");
    const commands = [];
    const seenQueries = new Set();
    for (const row of rows) {
      const job = await persistence.findByCommandId(row.job_id);
      if (!job || job.status !== "SUCCEEDED" || seenQueries.has(job.command.queryFingerprint)) continue;
      seenQueries.add(job.command.queryFingerprint);
      const prepared = await sourceAdapter.prepareSource({
        commandId: rebuildIdentifier(event.eventId, job.command.queryFingerprint),
        query: structuredClone(job.command.query),
        queryFingerprint: job.command.queryFingerprint,
      });
      commands.push(Object.freeze({
        commandId: rebuildIdentifier(event.eventId, job.command.queryFingerprint),
        idempotencyKey: rebuildIdempotencyKey(event.eventId, job.command.queryFingerprint),
        invalidationId: null,
        policy: structuredClone(job.command.policy),
        query: structuredClone(job.command.query),
        reason: "MANUAL_REBUILD",
        requestedAt: event.detectedAt,
        sourceFingerprint: prepared.sourceFingerprint,
      }));
    }
    return Object.freeze(commands);
  };
}

export async function loadInventoryReportingJobIntegrityKey({ credentialDirectory, readCredential = readFile } = {}) {
  let value;
  try { value = await readCredential(`${credentialDirectory}/inventory-reporting-job-integrity-key`, "utf8"); }
  catch { throw failure("production_inventory_reporting_job_integrity_key_required"); }
  if (typeof value !== "string" || value !== value.trim() || Buffer.byteLength(value, "utf8") < 32 || Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure("production_inventory_reporting_job_integrity_key_invalid");
  }
  return value;
}

function normalizeAuthority(ids) {
  const outletIds = Array.isArray(ids?.outletIds) ? ids.outletIds : [ids?.outletId];
  if (!ids || !UUID.test(ids.organizationId ?? "") || outletIds.length < 1 || outletIds.length > 50 || outletIds.some((item) => !UUID.test(item ?? ""))) throw failure("production_inventory_reporting_job_authority_invalid");
  const normalized = outletIds.map((item) => item.toLowerCase());
  if (JSON.stringify(normalized) !== JSON.stringify([...new Set(normalized)].sort())) throw failure("production_inventory_reporting_job_authority_invalid");
  return Object.freeze({ organizationId: ids.organizationId.toLowerCase(), outletIds: Object.freeze(normalized) });
}
function reportingMode(value) { const mode = String(value ?? "off").trim().toUpperCase(); if (!new Set(["OFF", "POSTGRES"]).has(mode)) throw failure("production_inventory_reporting_mode_invalid"); return mode; }
function optionalInteger(value, fallback, min, max) { if (value === undefined || value === "") return fallback; const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw failure("production_inventory_reporting_health_config_invalid"); return parsed; }
function instant(value) { const parsed = value instanceof Date ? value : new Date(value); if (Number.isNaN(parsed.getTime())) throw failure("production_inventory_reporting_health_time_invalid"); return parsed.toISOString(); }
function elapsedSeconds(from, to) { const milliseconds = Date.parse(to) - Date.parse(from); if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw failure("production_inventory_reporting_health_time_invalid"); return Math.floor(milliseconds / 1_000); }
function rebuildDigest(eventId, queryFingerprint) { return createHash("sha256").update(`${eventId}:${queryFingerprint}`).digest("hex"); }
function rebuildIdentifier(eventId, queryFingerprint) { return `b20:${rebuildDigest(eventId, queryFingerprint)}`; }
function rebuildIdempotencyKey(eventId, queryFingerprint) { return `b20r:${rebuildDigest(eventId, queryFingerprint)}`; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
