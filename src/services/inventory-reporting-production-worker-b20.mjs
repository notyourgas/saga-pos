export const INVENTORY_REPORTING_PRODUCTION_WORKER_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_DURABLE_PIPELINE_HEALTH_V1";

/**
 * Runs the durable rebuild scheduler and the canonical backdated-change
 * consumer under one lifecycle. The rebuild worker owns its timer; this
 * wrapper owns only invalidation polling and drains both components on stop.
 */
export function createInventoryReportingProductionWorker({
  jobWorker,
  invalidationConsumer,
  healthProbe,
  scheduledProjectionRefresh = async () => {},
  intervalMs = 5_000,
  projectionMaxAgeSeconds = 300,
  clock = () => new Date().toISOString(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  onError = () => {},
} = {}) {
  if (!jobWorker?.start || !jobWorker?.stop || !jobWorker?.health || !invalidationConsumer?.pollOnce || !invalidationConsumer?.health || typeof healthProbe !== "function" || typeof scheduledProjectionRefresh !== "function") {
    throw failure("inventory_reporting_production_worker_dependency_invalid");
  }
  const interval = integer(intervalMs, 1_000, 15 * 60_000);
  const maxAgeSeconds = integer(projectionMaxAgeSeconds, 30, 24 * 60 * 60);
  if (typeof clock !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function" || typeof onError !== "function") {
    throw failure("inventory_reporting_production_worker_config_invalid");
  }

  let timer = null;
  let activePoll = null;
  let started = false;
  let stopped = false;
  let invalidationReady = false;
  let pollCount = 0;
  let failureCount = 0;
  let lastFailureCode = null;
  let observedHealth = null;

  async function refreshHealth() {
    const sampled = normalizeHealthSample(await healthProbe());
    projectionAgeSeconds(sampled.projectionPersistedAt, instant(clock()));
    observedHealth = sampled;
    return health();
  }

  async function pollInvalidations() {
    if (!started || stopped) return Object.freeze({ status: "STOPPED", processedCount: 0 });
    if (activePoll) return activePoll;
    const cycle = Promise.resolve().then(async () => {
      const result = await invalidationConsumer.pollOnce();
      await scheduledProjectionRefresh();
      pollCount += 1;
      invalidationReady = true;
      lastFailureCode = null;
      await refreshHealth();
      return result;
    });
    activePoll = cycle;
    try {
      return await cycle;
    } catch (error) {
      failureCount += 1;
      invalidationReady = false;
      lastFailureCode = safeCode(error);
      try { onError(error); } catch { /* Error reporting must not kill the scheduler. */ }
      throw error;
    } finally {
      if (activePoll === cycle) activePoll = null;
    }
  }

  function schedule() {
    if (!started || stopped || timer !== null) return;
    timer = setTimer(async () => {
      timer = null;
      try { await pollInvalidations(); } catch { /* Reflected by health. */ }
      schedule();
    }, interval);
    timer?.unref?.();
  }

  async function start() {
    if (started && !stopped) return health();
    stopped = false;
    const jobStart = await jobWorker.start();
    if (jobStart?.started !== true || jobWorker.health()?.ready !== true) {
      stopped = true;
      await jobWorker.stop();
      throw failure("inventory_reporting_production_worker_job_not_ready");
    }
    started = true;
    try {
      await pollInvalidations();
      if (invalidationConsumer.health()?.ready !== true) throw failure("inventory_reporting_production_worker_invalidation_not_ready");
      schedule();
      return health();
    } catch (error) {
      started = false;
      stopped = true;
      await jobWorker.stop();
      throw error;
    }
  }

  async function stop() {
    if (stopped && !started) return Object.freeze({ stopped: true, idempotent: true });
    stopped = true;
    started = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (activePoll) {
      try { await activePoll; } catch { /* Failure is reflected by health. */ }
    }
    await jobWorker.stop();
    invalidationReady = false;
    return Object.freeze({ stopped: true, idempotent: false });
  }

  function health() {
    if (!observedHealth) throw failure("inventory_reporting_production_worker_health_unavailable");
    const job = safeHealth(jobWorker);
    const invalidation = safeHealth(invalidationConsumer);
    const ageSeconds = projectionAgeSeconds(observedHealth.projectionPersistedAt, instant(clock()));
    const freshnessReady = ageSeconds <= maxAgeSeconds;
    const workerReady = started && !stopped && job.ready === true;
    const sourceReady = invalidation.ready === true && invalidationReady;
    const queue = observedHealth.queue;
    const ready = workerReady && sourceReady && freshnessReady && queue.deadLetter === 0 && queue.expiredLease === 0;
    return Object.freeze({
      contract: INVENTORY_REPORTING_PRODUCTION_WORKER_CONTRACT,
      ready,
      worker: Object.freeze({ ready: workerReady }),
      invalidation: Object.freeze({ ready: sourceReady, backlogCount: observedHealth.invalidation.backlogCount, lagSeconds: observedHealth.invalidation.lagSeconds }),
      freshness: Object.freeze({ ready: freshnessReady, ageSeconds, maxAgeSeconds }),
      queue,
    });
  }

  return Object.freeze({ start, stop, health, pollInvalidations });
}

function safeHealth(component) {
  try { return component.health() ?? {}; } catch { return {}; }
}
function normalizeHealthSample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["invalidation", "projectionPersistedAt", "queue"])) throw failure("inventory_reporting_production_worker_health_invalid");
  const queueKeys = ["deadLetter", "expiredLease", "pending", "retryWait", "running"];
  if (!value.queue || JSON.stringify(Object.keys(value.queue).sort()) !== JSON.stringify(queueKeys)) throw failure("inventory_reporting_production_worker_health_invalid");
  const queue = Object.freeze(Object.fromEntries(queueKeys.map((key) => [key, integer(value.queue[key], 0, 1_000_000)])));
  if (!value.invalidation || JSON.stringify(Object.keys(value.invalidation).sort()) !== JSON.stringify(["backlogCount", "lagSeconds"])) throw failure("inventory_reporting_production_worker_health_invalid");
  const invalidation = Object.freeze({ backlogCount: integer(value.invalidation.backlogCount, 0, 1_000_000), lagSeconds: integer(value.invalidation.lagSeconds, 0, 31 * 24 * 60 * 60) });
  return Object.freeze({ queue, invalidation, projectionPersistedAt: instant(value.projectionPersistedAt) });
}
function projectionAgeSeconds(persistedAt, observedAt) {
  const milliseconds = Date.parse(observedAt) - Date.parse(persistedAt);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw failure("inventory_reporting_production_worker_projection_time_invalid");
  return Math.floor(milliseconds / 1_000);
}
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("inventory_reporting_production_worker_config_invalid"); return value; }
function instant(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure("inventory_reporting_production_worker_clock_invalid"); return value; }
function safeCode(error) { return typeof error?.code === "string" && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : "inventory_reporting_invalidation_failure"; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
