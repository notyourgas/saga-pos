export const INVENTORY_REPORTING_WORKER_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_WORKER_V1";

export function createInventoryReportingWorker({
  orchestrator,
  workerId = "inventory-reporting-worker",
  enabled = false,
  intervalMs = 5_000,
  batchSize = 2,
  clock = () => new Date().toISOString(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  onError = () => {},
} = {}) {
  if (!orchestrator || typeof orchestrator.runDue !== "function") throw failure("inventory_reporting_worker_orchestrator_invalid");
  const id = identifier(workerId);
  const interval = integer(intervalMs, 1_000, 15 * 60_000);
  const limit = integer(batchSize, 1, Math.min(16, integer(orchestrator.concurrencyLimit, 1, 16)));
  if (typeof enabled !== "boolean" || typeof clock !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function" || typeof onError !== "function") {
    throw failure("inventory_reporting_worker_config_invalid");
  }
  let timer = null;
  let started = false;
  let active = false;
  let activePromise = null;
  let stopped = false;
  let cycleCount = 0;
  let processedCount = 0;
  let skippedOverlapCount = 0;
  let failureCount = 0;
  let lastRunAt = null;
  let lastCompletedAt = null;
  let lastFailureCode = null;

  async function runOnce({ now = clock() } = {}) {
    if (!enabled || stopped) return Object.freeze({ status: "DISABLED", processedCount: 0 });
    if (activePromise) {
      skippedOverlapCount += 1;
      return Object.freeze({ status: "SKIPPED_OVERLAP", processedCount: 0 });
    }
    activePromise = executeCycle(instant(now));
    try { return await activePromise; }
    finally { activePromise = null; }
  }

  async function executeCycle(runAt) {
    active = true;
    lastRunAt = runAt;
    cycleCount += 1;
    try {
      const results = await orchestrator.runDue({ workerId: id, now: runAt, limit });
      if (!Array.isArray(results) || results.length > limit) throw failure("inventory_reporting_worker_result_invalid");
      processedCount += results.length;
      lastCompletedAt = instant(clock());
      lastFailureCode = null;
      return Object.freeze({ status: "COMPLETED", processedCount: results.length });
    } catch (error) {
      failureCount += 1;
      lastCompletedAt = instant(clock());
      lastFailureCode = safeCode(error);
      try { onError(error); } catch { /* Error reporting must not kill the scheduler. */ }
      throw error;
    } finally { active = false; }
  }

  function schedule() {
    if (!started || stopped || !enabled || timer !== null) return;
    timer = setTimer(async () => {
      timer = null;
      try { await runOnce(); } catch { /* Counted and reported by runOnce. */ }
      schedule();
    }, interval);
  }

  function start() {
    if (!enabled) return Object.freeze({ started: false, reason: "DISABLED_BY_CONFIG" });
    if (started && !stopped) return Object.freeze({ started: true, reason: "ALREADY_STARTED" });
    started = true;
    stopped = false;
    schedule();
    return Object.freeze({ started: true, reason: "STARTED" });
  }

  async function stop() {
    stopped = true;
    started = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (activePromise) {
      try { await activePromise; } catch { /* Failure is already counted and reported. */ }
    }
    return Object.freeze({ stopped: true });
  }

  function health() {
    return Object.freeze({
      contract: INVENTORY_REPORTING_WORKER_CONTRACT,
      ready: enabled && started && !stopped,
      enabled,
      started: started && !stopped,
      active,
      workerId: id,
      intervalMs: interval,
      batchSize: limit,
      cycleCount,
      processedCount,
      skippedOverlapCount,
      failureCount,
      lastRunAt,
      lastCompletedAt,
      lastFailureCode,
      deploymentStatus: "IMPLEMENTED_NOT_DEPLOYED",
    });
  }

  return Object.freeze({ start, stop, runOnce, health });
}

function identifier(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw failure("inventory_reporting_worker_config_invalid"); return value; }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("inventory_reporting_worker_config_invalid"); return value; }
function instant(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw failure("inventory_reporting_worker_clock_invalid"); return value; }
function safeCode(error) { return typeof error?.code === "string" && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : "inventory_reporting_worker_failure"; }
function failure(code) { const error = new Error(code); error.code = code; return error; }
