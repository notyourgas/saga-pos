import { createHash } from "node:crypto";

export const INVENTORY_REPORTING_JOB_COMMAND_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_REBUILD_COMMAND_V1";
export const INVENTORY_REPORTING_JOB_STATE_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_JOB_STATE_V1";
export const INVENTORY_REPORTING_JOB_EXPORT_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_JOB_EXPORT_V1";

const TERMINAL = new Set(["SUCCEEDED", "DEAD_LETTER", "INVALIDATED"]);
const REASONS = new Set(["SCHEDULED", "MANUAL_REBUILD", "BACKDATED_CHANGE", "RECOVERY_REPLAY"]);
const PERMANENT_CODES = new Set([
  "inventory_reporting_job_command_invalid",
  "inventory_reporting_job_query_invalid",
  "inventory_reporting_job_source_fingerprint_mismatch",
  "inventory_reporting_job_projection_invalid",
  "inventory_reporting_job_projection_result_invalid",
]);

export class InventoryReportingJobError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = "InventoryReportingJobError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function createInventoryReportingRebuildCommand(input = {}) {
  exactObject(input, [
    "commandId", "idempotencyKey", "invalidationId", "policy", "query", "reason",
    "requestedAt", "sourceFingerprint",
  ], "inventory_reporting_job_command_invalid");
  const query = normalizeQuery(input.query);
  const policy = normalizePolicy(input.policy);
  const command = {
    contract: INVENTORY_REPORTING_JOB_COMMAND_CONTRACT,
    version: 1,
    commandId: identifier(input.commandId, "inventory_reporting_job_command_invalid"),
    idempotencyKey: identifier(input.idempotencyKey, "inventory_reporting_job_command_invalid"),
    reason: enumeration(input.reason, REASONS, "inventory_reporting_job_command_invalid"),
    invalidationId: nullableIdentifier(input.invalidationId, "inventory_reporting_job_command_invalid"),
    requestedAt: instant(input.requestedAt, "inventory_reporting_job_command_invalid"),
    query,
    queryFingerprint: sha256(query),
    sourceFingerprint: digest(input.sourceFingerprint, "inventory_reporting_job_command_invalid"),
    policy,
  };
  if (command.reason === "BACKDATED_CHANGE" && !command.invalidationId) {
    throw failure("inventory_reporting_job_invalidation_required");
  }
  if (command.reason !== "BACKDATED_CHANGE" && command.invalidationId) {
    throw failure("inventory_reporting_job_invalidation_unexpected");
  }
  return deepFreeze({ ...command, commandFingerprint: sha256(command) });
}

export function createInventoryReportingRebuildOrchestrator({
  persistence,
  sourceProvider,
  projectionProvider,
  concurrency = 2,
  leaseMs = 60_000,
  clock = () => new Date().toISOString(),
} = {}) {
  requirePort(persistence, ["createJob", "findByCommandId", "findByIdempotencyKey", "claimDue", "saveJob", "saveProjection", "invalidateAffected", "metrics"]);
  requirePort(sourceProvider, ["loadSource"]);
  requirePort(projectionProvider, ["buildProjection"]);
  const maxConcurrency = boundedInteger(concurrency, 1, 16, "inventory_reporting_job_concurrency_invalid");
  const claimLeaseMs = boundedInteger(leaseMs, 1_000, 15 * 60_000, "inventory_reporting_job_lease_invalid");
  if (typeof clock !== "function") throw failure("inventory_reporting_job_clock_invalid");

  async function enqueue(input) {
    const command = createInventoryReportingRebuildCommand(input);
    const byKey = await persistence.findByIdempotencyKey(command.idempotencyKey);
    if (byKey) {
      if (byKey.command.commandFingerprint !== command.commandFingerprint) throw failure("inventory_reporting_job_idempotency_collision");
      return clone(byKey);
    }
    const byId = await persistence.findByCommandId(command.commandId);
    if (byId) {
      if (byId.command.commandFingerprint !== command.commandFingerprint) throw failure("inventory_reporting_job_command_collision");
      return clone(byId);
    }
    const job = initialJob(command);
    try {
      return clone(await persistence.createJob(job));
    } catch (error) {
      const concurrent = await persistence.findByIdempotencyKey(command.idempotencyKey);
      if (concurrent?.command?.commandFingerprint === command.commandFingerprint) return clone(concurrent);
      throw error;
    }
  }

  async function runDue({ workerId, now = clock(), limit = maxConcurrency } = {}) {
    const normalizedWorker = identifier(workerId, "inventory_reporting_job_worker_invalid");
    const normalizedNow = instant(now, "inventory_reporting_job_time_invalid");
    const requestedLimit = boundedInteger(limit, 1, maxConcurrency, "inventory_reporting_job_limit_invalid");
    const claimed = await persistence.claimDue({
      workerId: normalizedWorker,
      now: normalizedNow,
      limit: requestedLimit,
      leaseMs: claimLeaseMs,
    });
    if (!Array.isArray(claimed) || claimed.length > requestedLimit) throw failure("inventory_reporting_job_claim_contract_invalid");
    return Promise.all(claimed.map((job) => executeClaimed(job, normalizedWorker)));
  }

  async function runCommand({ workerId, commandId, now = clock() } = {}) {
    const normalizedWorker = identifier(workerId, "inventory_reporting_job_worker_invalid");
    const normalizedCommand = identifier(commandId, "inventory_reporting_job_command_invalid");
    const normalizedNow = instant(now, "inventory_reporting_job_time_invalid");
    const claimed = await persistence.claimDue({ workerId: normalizedWorker, now: normalizedNow, limit: 1, leaseMs: claimLeaseMs, commandId: normalizedCommand });
    if (!Array.isArray(claimed) || claimed.length > 1 || claimed.some((job) => job?.jobId !== normalizedCommand)) throw failure("inventory_reporting_job_claim_contract_invalid");
    return Promise.all(claimed.map((job) => executeClaimed(job, normalizedWorker)));
  }

  async function executeClaimed(rawJob, workerId) {
    const job = normalizeJob(rawJob);
    if (job.status !== "RUNNING" || job.lease?.workerId !== workerId) throw failure("inventory_reporting_job_claim_contract_invalid");
    try {
      const source = await sourceProvider.loadSource({
        commandId: job.command.commandId,
        query: clone(job.command.query),
        queryFingerprint: job.command.queryFingerprint,
        expectedSourceFingerprint: job.command.sourceFingerprint,
      });
      if (!source || digest(source.sourceFingerprint, "inventory_reporting_job_source_invalid") !== job.command.sourceFingerprint) {
        throw failure("inventory_reporting_job_source_fingerprint_mismatch");
      }
      const projection = await projectionProvider.buildProjection({ query: clone(job.command.query), source });
      if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw failure("inventory_reporting_job_projection_invalid");
      const projectionFingerprint = digest(projection.reportFingerprint, "inventory_reporting_job_projection_invalid");
      const result = await persistence.saveProjection({
        jobId: job.jobId,
        commandFingerprint: job.command.commandFingerprint,
        queryFingerprint: job.command.queryFingerprint,
        sourceFingerprint: job.command.sourceFingerprint,
        projectionFingerprint,
        projection: clone(projection),
        expectedJobRevision: job.revision,
        leaseWorkerId: workerId,
      });
      if (result?.projectionFingerprint !== projectionFingerprint) throw failure("inventory_reporting_job_projection_result_invalid");
      const completedAt = instant(clock(), "inventory_reporting_job_time_invalid");
      const succeeded = {
        ...job,
        status: "SUCCEEDED",
        projectionFingerprint,
        resultRef: normalizeResultRef(result),
        completedAt,
        nextAttemptAt: null,
        lease: null,
        lastFailure: null,
        revision: job.revision + 1,
        history: [...job.history, historyEvent("SUCCEEDED", completedAt, job.attemptCount)],
      };
      return clone(await persistence.saveJob(succeeded, { expectedRevision: job.revision, leaseWorkerId: workerId }));
    } catch (error) {
      if (error?.code === "inventory_reporting_job_revision_conflict") {
        const current = await persistence.findByCommandId(job.jobId);
        if (!current) throw error;
        return clone(current);
      }
      const failedAt = instant(clock(), "inventory_reporting_job_time_invalid");
      const failureInfo = safeFailure(error);
      const exhausted = job.attemptCount >= job.command.policy.maxAttempts;
      const deadLetter = exhausted || failureInfo.retryable === false;
      const nextAttemptAt = deadLetter ? null : addMs(failedAt, backoffMs(job.command.policy, job.attemptCount));
      const failed = {
        ...job,
        status: deadLetter ? "DEAD_LETTER" : "RETRY_WAIT",
        completedAt: deadLetter ? failedAt : null,
        nextAttemptAt,
        lease: null,
        lastFailure: failureInfo,
        revision: job.revision + 1,
        history: [...job.history, historyEvent(deadLetter ? "DEAD_LETTER" : "RETRY_WAIT", failedAt, job.attemptCount, failureInfo.code)],
      };
      return clone(await persistence.saveJob(failed, { expectedRevision: job.revision, leaseWorkerId: workerId }));
    }
  }

  async function handleBackdatedInvalidation({ eventId, organizationId, outletId, changedAt, detectedAt = clock(), rebuildCommands } = {}) {
    const normalized = {
      eventId: identifier(eventId, "inventory_reporting_job_invalidation_invalid"),
      organizationId: identifier(organizationId, "inventory_reporting_job_invalidation_invalid"),
      outletId: identifier(outletId, "inventory_reporting_job_invalidation_invalid"),
      changedAt: instant(changedAt, "inventory_reporting_job_invalidation_invalid"),
      detectedAt: instant(detectedAt, "inventory_reporting_job_invalidation_invalid"),
    };
    if (!Array.isArray(rebuildCommands) || rebuildCommands.length > 100) {
      throw failure("inventory_reporting_job_invalidation_invalid");
    }
    const prepared = rebuildCommands.map((item) => {
      const candidate = { ...item, reason: "BACKDATED_CHANGE", invalidationId: normalized.eventId };
      const command = createInventoryReportingRebuildCommand(candidate);
      if (command.query.organizationId !== normalized.organizationId || !command.query.outletIds.includes(normalized.outletId)) {
        throw failure("inventory_reporting_job_invalidation_scope_mismatch");
      }
      if (Date.parse(normalized.changedAt) >= Date.parse(command.query.periodEndUtc)) {
        throw failure("inventory_reporting_job_invalidation_period_mismatch");
      }
      return candidate;
    });
    const invalidated = await persistence.invalidateAffected(normalized);
    const queued = [];
    for (const item of prepared) queued.push(await enqueue(item));
    return deepFreeze({
      eventId: normalized.eventId,
      invalidatedCount: boundedInteger(invalidated?.invalidatedCount ?? 0, 0, Number.MAX_SAFE_INTEGER, "inventory_reporting_job_invalidation_result_invalid"),
      queuedCount: queued.length,
      queued,
    });
  }

  async function metrics() {
    const raw = await persistence.metrics();
    return deepFreeze({
      contract: "SAGAPOS_INVENTORY_REPORTING_JOB_METRICS_V1",
      generatedAt: instant(clock(), "inventory_reporting_job_time_invalid"),
      counts: normalizeCounts(raw?.counts),
      attemptCount: boundedInteger(raw?.attemptCount ?? 0, 0, Number.MAX_SAFE_INTEGER, "inventory_reporting_job_metrics_invalid"),
      concurrencyLimit: maxConcurrency,
      storageMode: safeCapability(persistence.capabilities?.storageMode),
      targetDurabilityStatus: "UNVERIFIED",
    });
  }

  async function health() {
    const current = await metrics();
    return deepFreeze({
      contract: "SAGAPOS_INVENTORY_REPORTING_JOB_HEALTH_V1",
      status: current.counts.DEAD_LETTER > 0 ? "DEGRADED" : "HEALTHY",
      generatedAt: current.generatedAt,
      queue: {
        pending: current.counts.PENDING,
        retryWait: current.counts.RETRY_WAIT,
        running: current.counts.RUNNING,
        deadLetter: current.counts.DEAD_LETTER,
      },
      sourceRuntimeStatus: "UNVERIFIED",
      targetDurabilityStatus: "UNVERIFIED",
      deploymentStatus: "IMPLEMENTED_NOT_DEPLOYED",
    });
  }

  return deepFreeze({ enqueue, runDue, runCommand, handleBackdatedInvalidation, metrics, health, concurrencyLimit: maxConcurrency });
}

export class InMemoryInventoryReportingJobPersistence {
  constructor(restored = null) {
    this.jobs = new Map();
    this.idempotency = new Map();
    this.projections = new Map();
    this.invalidations = new Map();
    this.capabilities = deepFreeze({
      storageMode: "IN_MEMORY_DISPOSABLE",
      restartEvidence: "HASHED_SERIALIZED_STATE_ONLY",
      targetDurabilityStatus: "UNVERIFIED",
    });
    if (restored) this.#load(restored);
  }

  async createJob(rawJob) {
    const job = normalizeJob(rawJob);
    if (this.jobs.has(job.jobId) || this.idempotency.has(job.command.idempotencyKey)) throw failure("inventory_reporting_job_store_collision");
    this.jobs.set(job.jobId, clone(job));
    this.idempotency.set(job.command.idempotencyKey, job.jobId);
    return clone(job);
  }

  async findByCommandId(commandId) { return cloneOrNull(this.jobs.get(String(commandId))); }
  async findByIdempotencyKey(key) { return cloneOrNull(this.jobs.get(this.idempotency.get(String(key)))); }

  async claimDue({ workerId, now, limit, leaseMs, commandId = null }) {
    identifier(workerId, "inventory_reporting_job_claim_contract_invalid");
    instant(now, "inventory_reporting_job_claim_contract_invalid");
    boundedInteger(limit, 1, 16, "inventory_reporting_job_claim_contract_invalid");
    boundedInteger(leaseMs, 1_000, 15 * 60_000, "inventory_reporting_job_claim_contract_invalid");
    const selectedCommand = commandId === null ? null : identifier(commandId, "inventory_reporting_job_claim_contract_invalid");
    const nowMs = Date.parse(now);
    for (const current of this.jobs.values()) {
      if ((selectedCommand && current.jobId !== selectedCommand) || current.status !== "RUNNING" || Date.parse(current.lease.expiresAt) > nowMs || current.attemptCount < current.command.policy.maxAttempts) continue;
      const exhausted = {
        ...current,
        status: "DEAD_LETTER",
        completedAt: now,
        lease: null,
        lastFailure: { code: "inventory_reporting_job_worker_lease_expired", retryable: false },
        revision: current.revision + 1,
        history: [...current.history, historyEvent("DEAD_LETTER", now, current.attemptCount, "inventory_reporting_job_worker_lease_expired")],
      };
      this.jobs.set(exhausted.jobId, clone(exhausted));
    }
    const candidates = [...this.jobs.values()]
      .filter((job) => {
        if (selectedCommand && job.jobId !== selectedCommand) return false;
        if (!["PENDING", "RETRY_WAIT", "RUNNING"].includes(job.status)) return false;
        if (job.status === "RUNNING") return Date.parse(job.lease.expiresAt) <= nowMs;
        return Date.parse(job.nextAttemptAt) <= nowMs;
      })
      .sort((a, b) => dueAt(a).localeCompare(dueAt(b)) || a.jobId.localeCompare(b.jobId))
      .slice(0, limit);
    const claimed = [];
    for (const current of candidates) {
      const attemptCount = current.attemptCount + 1;
      const next = {
        ...current,
        status: "RUNNING",
        attemptCount,
        completedAt: null,
        nextAttemptAt: null,
        lease: { workerId, claimedAt: now, expiresAt: addMs(now, leaseMs) },
        lastFailure: null,
        revision: current.revision + 1,
        history: [...current.history, historyEvent("RUNNING", now, attemptCount)],
      };
      this.jobs.set(next.jobId, clone(next));
      claimed.push(clone(next));
    }
    return claimed;
  }

  async saveJob(rawJob, { expectedRevision } = {}) {
    const job = normalizeJob(rawJob);
    const current = this.jobs.get(job.jobId);
    if (!current || current.revision !== expectedRevision || job.revision !== expectedRevision + 1) throw failure("inventory_reporting_job_revision_conflict");
    if (current.command.commandFingerprint !== job.command.commandFingerprint) throw failure("inventory_reporting_job_command_mutation");
    this.jobs.set(job.jobId, clone(job));
    return clone(job);
  }

  async saveProjection(input = {}) {
    exactObject(input, ["commandFingerprint", "expectedJobRevision", "jobId", "leaseWorkerId", "projection", "projectionFingerprint", "queryFingerprint", "sourceFingerprint"], "inventory_reporting_job_projection_invalid");
    const expectedJobRevision = boundedInteger(input.expectedJobRevision, 1, Number.MAX_SAFE_INTEGER, "inventory_reporting_job_projection_invalid");
    const leaseWorkerId = identifier(input.leaseWorkerId, "inventory_reporting_job_projection_invalid");
    const record = {
      commandFingerprint: digest(input.commandFingerprint, "inventory_reporting_job_projection_invalid"),
      jobId: identifier(input.jobId, "inventory_reporting_job_projection_invalid"),
      queryFingerprint: digest(input.queryFingerprint, "inventory_reporting_job_projection_invalid"),
      sourceFingerprint: digest(input.sourceFingerprint, "inventory_reporting_job_projection_invalid"),
      projectionFingerprint: digest(input.projectionFingerprint, "inventory_reporting_job_projection_invalid"),
      projection: clone(input.projection),
    };
    const job = this.jobs.get(record.jobId);
    if (!job || job.revision !== expectedJobRevision || job.status !== "RUNNING" || job.lease?.workerId !== leaseWorkerId) throw failure("inventory_reporting_job_revision_conflict");
    if (record.projection.reportFingerprint !== record.projectionFingerprint) throw failure("inventory_reporting_job_projection_invalid");
    const existing = this.projections.get(record.jobId);
    if (existing && canonical(existing) !== canonical(record)) throw failure("inventory_reporting_job_projection_collision");
    this.projections.set(record.jobId, record);
    return deepFreeze({ resultRef: `inventory-reporting-projection:${record.jobId}`, projectionFingerprint: record.projectionFingerprint });
  }

  async invalidateAffected(input) {
    const existing = this.invalidations.get(input.eventId);
    const eventFingerprint = sha256(input);
    if (existing) {
      if (existing.eventFingerprint !== eventFingerprint) throw failure("inventory_reporting_job_invalidation_collision");
      return { invalidatedCount: existing.invalidatedJobIds.length };
    }
    const ids = [];
    for (const current of this.jobs.values()) {
      const query = current.command.query;
      if (current.status !== "SUCCEEDED") continue;
      if (query.organizationId !== input.organizationId || !query.outletIds.includes(input.outletId)) continue;
      if (Date.parse(input.changedAt) >= Date.parse(query.periodEndUtc)) continue;
      const next = {
        ...current,
        status: "INVALIDATED",
        completedAt: input.detectedAt,
        revision: current.revision + 1,
        history: [...current.history, historyEvent("INVALIDATED", input.detectedAt, current.attemptCount, "BACKDATED_CHANGE")],
      };
      this.jobs.set(next.jobId, clone(next));
      ids.push(next.jobId);
    }
    this.invalidations.set(input.eventId, { eventFingerprint, invalidatedJobIds: ids.sort() });
    return { invalidatedCount: ids.length };
  }

  async metrics() {
    const counts = emptyCounts();
    let attemptCount = 0;
    for (const job of this.jobs.values()) { counts[job.status] += 1; attemptCount += job.attemptCount; }
    return { counts, attemptCount };
  }

  getJob(jobId) { return cloneOrNull(this.jobs.get(jobId)); }
  getProjection(jobId) { return cloneOrNull(this.projections.get(jobId)); }

  exportState({ exportedAt } = {}) {
    const metadata = {
      contract: INVENTORY_REPORTING_JOB_EXPORT_CONTRACT,
      version: 1,
      exportedAt: instant(exportedAt, "inventory_reporting_job_export_invalid"),
      storageMode: this.capabilities.storageMode,
      targetDurabilityStatus: "UNVERIFIED",
    };
    const state = {
      jobs: [...this.jobs.values()].sort(compare("jobId")),
      projections: [...this.projections.values()].sort(compare("jobId")),
      invalidations: [...this.invalidations.entries()].map(([eventId, value]) => ({ eventId, ...value })).sort(compare("eventId")),
    };
    return deepFreeze({ ...metadata, state, stateFingerprint: sha256({ metadata, state }) });
  }

  #load(state) {
    for (const job of state.jobs) {
      const normalized = normalizeJob(job);
      if (this.jobs.has(normalized.jobId) || this.idempotency.has(normalized.command.idempotencyKey)) throw failure("inventory_reporting_job_restore_duplicate");
      this.jobs.set(normalized.jobId, clone(normalized));
      this.idempotency.set(normalized.command.idempotencyKey, normalized.jobId);
    }
    for (const item of state.projections) {
      if (!this.jobs.has(item.jobId) || this.projections.has(item.jobId)) throw failure("inventory_reporting_job_restore_invalid");
      exactObject(item, ["commandFingerprint", "jobId", "projection", "projectionFingerprint", "queryFingerprint", "sourceFingerprint"], "inventory_reporting_job_restore_invalid");
      for (const key of ["commandFingerprint", "projectionFingerprint", "queryFingerprint", "sourceFingerprint"]) digest(item[key], "inventory_reporting_job_restore_invalid");
      if (!item.projection || item.projection.reportFingerprint !== item.projectionFingerprint) throw failure("inventory_reporting_job_restore_invalid");
      const job = this.jobs.get(item.jobId);
      if (item.commandFingerprint !== job.command.commandFingerprint || item.queryFingerprint !== job.command.queryFingerprint || item.sourceFingerprint !== job.command.sourceFingerprint || item.projectionFingerprint !== job.projectionFingerprint) {
        throw failure("inventory_reporting_job_restore_invalid");
      }
      this.projections.set(item.jobId, clone(item));
    }
    for (const item of state.invalidations) {
      if (this.invalidations.has(item.eventId)) throw failure("inventory_reporting_job_restore_duplicate");
      exactObject(item, ["eventFingerprint", "eventId", "invalidatedJobIds"], "inventory_reporting_job_restore_invalid");
      identifier(item.eventId, "inventory_reporting_job_restore_invalid");
      if (!Array.isArray(item.invalidatedJobIds) || new Set(item.invalidatedJobIds).size !== item.invalidatedJobIds.length || item.invalidatedJobIds.some((id) => this.jobs.get(id)?.status !== "INVALIDATED")) throw failure("inventory_reporting_job_restore_invalid");
      this.invalidations.set(item.eventId, { eventFingerprint: digest(item.eventFingerprint, "inventory_reporting_job_restore_invalid"), invalidatedJobIds: [...item.invalidatedJobIds] });
    }
  }
}

export function restoreInMemoryInventoryReportingJobPersistence(snapshot = {}) {
  exactObject(snapshot, ["contract", "exportedAt", "state", "stateFingerprint", "storageMode", "targetDurabilityStatus", "version"], "inventory_reporting_job_export_invalid");
  if (snapshot.contract !== INVENTORY_REPORTING_JOB_EXPORT_CONTRACT || snapshot.version !== 1 || snapshot.storageMode !== "IN_MEMORY_DISPOSABLE" || snapshot.targetDurabilityStatus !== "UNVERIFIED") {
    throw failure("inventory_reporting_job_export_invalid");
  }
  instant(snapshot.exportedAt, "inventory_reporting_job_export_invalid");
  exactObject(snapshot.state, ["invalidations", "jobs", "projections"], "inventory_reporting_job_export_invalid");
  for (const key of ["jobs", "projections", "invalidations"]) if (!Array.isArray(snapshot.state[key])) throw failure("inventory_reporting_job_export_invalid");
  const metadata = {
    contract: snapshot.contract, version: snapshot.version, exportedAt: snapshot.exportedAt,
    storageMode: snapshot.storageMode, targetDurabilityStatus: snapshot.targetDurabilityStatus,
  };
  if (digest(snapshot.stateFingerprint, "inventory_reporting_job_export_invalid") !== sha256({ metadata, state: snapshot.state })) {
    throw failure("inventory_reporting_job_export_tampered");
  }
  return new InMemoryInventoryReportingJobPersistence(clone(snapshot.state));
}

function initialJob(command) {
  return deepFreeze({
    contract: INVENTORY_REPORTING_JOB_STATE_CONTRACT,
    version: 1,
    jobId: command.commandId,
    command,
    status: "PENDING",
    attemptCount: 0,
    nextAttemptAt: command.requestedAt,
    completedAt: null,
    projectionFingerprint: null,
    resultRef: null,
    lease: null,
    lastFailure: null,
    revision: 1,
    history: [historyEvent("PENDING", command.requestedAt, 0)],
  });
}

function normalizeJob(input) {
  if (!input || input.contract !== INVENTORY_REPORTING_JOB_STATE_CONTRACT || input.version !== 1) throw failure("inventory_reporting_job_state_invalid");
  exactObject(input, ["attemptCount", "command", "completedAt", "contract", "history", "jobId", "lastFailure", "lease", "nextAttemptAt", "projectionFingerprint", "resultRef", "revision", "status", "version"], "inventory_reporting_job_state_invalid");
  exactObject(input.command, ["commandFingerprint", "commandId", "contract", "idempotencyKey", "invalidationId", "policy", "query", "queryFingerprint", "reason", "requestedAt", "sourceFingerprint", "version"], "inventory_reporting_job_command_mutation");
  const command = createInventoryReportingRebuildCommand(stripCommand(input.command));
  if (command.commandFingerprint !== input.command.commandFingerprint || input.jobId !== command.commandId) throw failure("inventory_reporting_job_command_mutation");
  const status = enumeration(input.status, new Set(["PENDING", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "DEAD_LETTER", "INVALIDATED"]), "inventory_reporting_job_state_invalid");
  const attemptCount = boundedInteger(input.attemptCount, 0, command.policy.maxAttempts, "inventory_reporting_job_state_invalid");
  const revision = boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, "inventory_reporting_job_state_invalid");
  if (!Array.isArray(input.history) || input.history.length < 1 || input.history.length > 64) throw failure("inventory_reporting_job_state_invalid");
  for (const event of input.history) normalizeHistoryEvent(event);
  if (input.history.at(-1).status !== status) throw failure("inventory_reporting_job_state_invalid");
  if (status === "RUNNING") normalizeLease(input.lease);
  if (status !== "RUNNING" && input.lease !== null) throw failure("inventory_reporting_job_state_invalid");
  if (["PENDING", "RETRY_WAIT"].includes(status) && !input.nextAttemptAt) throw failure("inventory_reporting_job_state_invalid");
  if (input.nextAttemptAt !== null) instant(input.nextAttemptAt, "inventory_reporting_job_state_invalid");
  if (TERMINAL.has(status) && !input.completedAt) throw failure("inventory_reporting_job_state_invalid");
  if (input.completedAt !== null) instant(input.completedAt, "inventory_reporting_job_state_invalid");
  if (input.projectionFingerprint !== null) digest(input.projectionFingerprint, "inventory_reporting_job_state_invalid");
  if (input.resultRef !== null) identifier(input.resultRef, "inventory_reporting_job_state_invalid");
  if (input.lastFailure !== null) normalizeFailure(input.lastFailure);
  if (status === "PENDING" && (attemptCount !== 0 || input.lastFailure !== null || input.completedAt !== null)) throw failure("inventory_reporting_job_state_invalid");
  if (status === "RUNNING" && (attemptCount < 1 || input.lastFailure !== null || input.completedAt !== null)) throw failure("inventory_reporting_job_state_invalid");
  if (status === "RETRY_WAIT" && (attemptCount < 1 || input.lastFailure === null || input.completedAt !== null)) throw failure("inventory_reporting_job_state_invalid");
  if (status === "SUCCEEDED" && (!input.projectionFingerprint || !input.resultRef || input.lastFailure !== null)) throw failure("inventory_reporting_job_state_invalid");
  if (status === "DEAD_LETTER" && input.lastFailure === null) throw failure("inventory_reporting_job_state_invalid");
  if (["PENDING", "RUNNING", "RETRY_WAIT", "DEAD_LETTER"].includes(status) && (input.projectionFingerprint !== null || input.resultRef !== null)) throw failure("inventory_reporting_job_state_invalid");
  if (status === "INVALIDATED" && (!input.projectionFingerprint || !input.resultRef)) throw failure("inventory_reporting_job_state_invalid");
  return deepFreeze(clone(input));
}

export function validateInventoryReportingJobState(input) {
  return normalizeJob(input);
}

export function inventoryReportingJobFingerprint(value) {
  return sha256(value);
}

export function inventoryReportingJobQueryFingerprint(value) {
  return sha256(normalizeQuery(value));
}

export function validateInventoryReportingProjectionSnapshot(input, expectedFingerprint = undefined) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("inventory_reporting_job_projection_invalid");
  const projection = clone(input);
  const reportFingerprint = digest(projection.reportFingerprint, "inventory_reporting_job_projection_invalid");
  delete projection.reportFingerprint;
  if (sha256(projection) !== reportFingerprint) throw failure("inventory_reporting_job_projection_tampered");
  if (expectedFingerprint !== undefined && digest(expectedFingerprint, "inventory_reporting_job_projection_invalid") !== reportFingerprint) {
    throw failure("inventory_reporting_job_projection_fingerprint_mismatch");
  }
  return deepFreeze(clone(input));
}

function stripCommand(command) {
  if (!command || typeof command !== "object") throw failure("inventory_reporting_job_command_invalid");
  return {
    commandId: command.commandId, idempotencyKey: command.idempotencyKey, invalidationId: command.invalidationId,
    policy: command.policy, query: command.query, reason: command.reason, requestedAt: command.requestedAt,
    sourceFingerprint: command.sourceFingerprint,
  };
}

function normalizeQuery(input) {
  exactObject(input, ["currency", "includedStatuses", "organizationId", "outletIds", "periodEndUtc", "periodStartUtc", "policyVersion", "scopeLevel", "snapshotCutoffUtc"], "inventory_reporting_job_query_invalid");
  const organizationId = identifier(input.organizationId, "inventory_reporting_job_query_invalid");
  if (!Array.isArray(input.outletIds) || input.outletIds.length < 1 || input.outletIds.length > 1_000) throw failure("inventory_reporting_job_query_invalid");
  const outletIds = [...new Set(input.outletIds.map((value) => identifier(value, "inventory_reporting_job_query_invalid")))].sort();
  if (outletIds.length !== input.outletIds.length) throw failure("inventory_reporting_job_query_invalid");
  const scopeLevel = enumeration(input.scopeLevel, new Set(["OUTLET", "COMPANY"]), "inventory_reporting_job_query_invalid");
  if (scopeLevel === "OUTLET" && outletIds.length !== 1) throw failure("inventory_reporting_job_query_invalid");
  const periodStartUtc = instant(input.periodStartUtc, "inventory_reporting_job_query_invalid");
  const periodEndUtc = instant(input.periodEndUtc, "inventory_reporting_job_query_invalid");
  const snapshotCutoffUtc = instant(input.snapshotCutoffUtc, "inventory_reporting_job_query_invalid");
  if (Date.parse(periodStartUtc) >= Date.parse(periodEndUtc) || Date.parse(snapshotCutoffUtc) < Date.parse(periodEndUtc)) throw failure("inventory_reporting_job_query_invalid");
  if (input.currency !== "IDR" || canonical(input.includedStatuses) !== canonical(["POSTED"])) throw failure("inventory_reporting_job_query_invalid");
  return deepFreeze({ organizationId, outletIds, scopeLevel, periodStartUtc, periodEndUtc, snapshotCutoffUtc, includedStatuses: ["POSTED"], currency: "IDR", policyVersion: identifier(input.policyVersion, "inventory_reporting_job_query_invalid") });
}

function normalizePolicy(input = {}) {
  exactObject(input, ["baseBackoffMs", "maxAttempts", "maxBackoffMs"], "inventory_reporting_job_policy_invalid");
  const maxAttempts = boundedInteger(input.maxAttempts, 1, 10, "inventory_reporting_job_policy_invalid");
  const baseBackoffMs = boundedInteger(input.baseBackoffMs, 1_000, 60 * 60_000, "inventory_reporting_job_policy_invalid");
  const maxBackoffMs = boundedInteger(input.maxBackoffMs, baseBackoffMs, 24 * 60 * 60_000, "inventory_reporting_job_policy_invalid");
  return deepFreeze({ maxAttempts, baseBackoffMs, maxBackoffMs });
}

function historyEvent(status, at, attemptCount, failureCode = null) { return deepFreeze({ status, at, attemptCount, failureCode }); }
function normalizeHistoryEvent(value) {
  exactObject(value, ["at", "attemptCount", "failureCode", "status"], "inventory_reporting_job_state_invalid");
  enumeration(value.status, new Set(["PENDING", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "DEAD_LETTER", "INVALIDATED"]), "inventory_reporting_job_state_invalid");
  instant(value.at, "inventory_reporting_job_state_invalid");
  boundedInteger(value.attemptCount, 0, 10, "inventory_reporting_job_state_invalid");
  if (value.failureCode !== null && !/^[A-Za-z0-9_]{1,120}$/.test(value.failureCode)) throw failure("inventory_reporting_job_state_invalid");
}
function normalizeLease(value) {
  exactObject(value, ["claimedAt", "expiresAt", "workerId"], "inventory_reporting_job_state_invalid");
  identifier(value.workerId, "inventory_reporting_job_state_invalid");
  const claimedAt = instant(value.claimedAt, "inventory_reporting_job_state_invalid");
  const expiresAt = instant(value.expiresAt, "inventory_reporting_job_state_invalid");
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) throw failure("inventory_reporting_job_state_invalid");
}
function normalizeFailure(value) {
  exactObject(value, ["code", "retryable"], "inventory_reporting_job_state_invalid");
  if (!/^[a-z0-9_]{1,120}$/.test(value.code) || typeof value.retryable !== "boolean") throw failure("inventory_reporting_job_state_invalid");
}
function backoffMs(policy, attemptCount) { return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * (2 ** Math.max(0, attemptCount - 1))); }
function safeFailure(error) {
  const rawCode = typeof error?.code === "string" && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : "inventory_reporting_job_provider_failure";
  return deepFreeze({ code: rawCode, retryable: error?.retryable === false || PERMANENT_CODES.has(rawCode) ? false : true });
}
function normalizeResultRef(value) {
  exactObject(value, ["projectionFingerprint", "resultRef"], "inventory_reporting_job_projection_result_invalid");
  digest(value.projectionFingerprint, "inventory_reporting_job_projection_result_invalid");
  return identifier(value.resultRef, "inventory_reporting_job_projection_result_invalid");
}
function normalizeCounts(input = {}) {
  const result = emptyCounts();
  for (const key of Object.keys(result)) result[key] = boundedInteger(input?.[key] ?? 0, 0, Number.MAX_SAFE_INTEGER, "inventory_reporting_job_metrics_invalid");
  return result;
}
function emptyCounts() { return { PENDING: 0, RUNNING: 0, RETRY_WAIT: 0, SUCCEEDED: 0, DEAD_LETTER: 0, INVALIDATED: 0 }; }
function safeCapability(value) { return typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : "UNKNOWN"; }
function requirePort(port, methods) { if (!port || methods.some((name) => typeof port[name] !== "function")) throw failure("inventory_reporting_job_port_invalid"); }
function exactObject(value, keys, code) { if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure(code); }
function identifier(value, code) { const result = String(value ?? ""); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw failure(code); return result; }
function nullableIdentifier(value, code) { return value === null ? null : identifier(value, code); }
function enumeration(value, allowed, code) { if (!allowed.has(value)) throw failure(code); return value; }
function instant(value, code) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure(code); return value; }
function digest(value, code) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw failure(code); return value; }
function boundedInteger(value, min, max, code) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure(code); return value; }
function addMs(iso, milliseconds) { return new Date(Date.parse(iso) + milliseconds).toISOString(); }
function compare(key) { return (a, b) => String(a[key]).localeCompare(String(b[key])); }
function dueAt(job) { return job.status === "RUNNING" ? job.lease.expiresAt : job.nextAttemptAt; }
function clone(value) { return structuredClone(value); }
function cloneOrNull(value) { return value === undefined ? null : clone(value); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function sha256(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); } return value; }
function failure(code, detail) { return new InventoryReportingJobError(code, detail); }
