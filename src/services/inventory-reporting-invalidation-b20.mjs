export const INVENTORY_REPORTING_INVALIDATION_CONSUMER_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_INVALIDATION_CONSUMER_V1";
export const INVENTORY_MOVEMENT_REBUILD_EVENT = "INVENTORY_MOVEMENT_REBUILD_REQUIRED_V1";

export function createInventoryReportingInvalidationConsumer({
  db,
  orchestrator,
  authority,
  rebuildCommandFactory,
  enabled = false,
  batchSize = 10,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!db?.query || !orchestrator?.handleBackdatedInvalidation || typeof rebuildCommandFactory !== "function") throw failure("inventory_reporting_invalidation_dependency_invalid");
  const scope = normalizeAuthority(authority);
  const limit = integer(batchSize, 1, 100);
  if (typeof enabled !== "boolean" || typeof clock !== "function") throw failure("inventory_reporting_invalidation_config_invalid");
  let active = false;
  let processedCount = 0;
  let failureCount = 0;
  let lastProcessedAt = null;
  let lastFailureCode = null;

  async function pollOnce() {
    if (!enabled) return Object.freeze({ status: "DISABLED", processedCount: 0 });
    if (active) return Object.freeze({ status: "SKIPPED_OVERLAP", processedCount: 0 });
    active = true;
    try {
      const rows = (await db.query(
        `select o.event_id,o.organization_id,o.outlet_id,o.payload,o.created_at
           from public.sagaops_integration_outbox o
          where o.organization_id=$1 and o.outlet_id=any($2::uuid[])
            and o.event_type=$3
            and o.status in ('pending','published')
            and not exists (
              select 1 from sagaops.inventory_reporting_invalidations i
               where i.organization_id=o.organization_id and i.event_id=o.event_id::text
            )
          order by o.created_at,o.event_id limit $4`,
        [scope.organizationId,scope.outletIds,INVENTORY_MOVEMENT_REBUILD_EVENT,limit],
      )).rows;
      const results = [];
      for (const row of rows) {
        const sourceEvent = normalizeMovementEvent(row, scope);
        const rebuildCommands = await rebuildCommandFactory(Object.freeze(clone(sourceEvent)));
        if (!Array.isArray(rebuildCommands) || rebuildCommands.length > 100) throw failure("inventory_reporting_invalidation_rebuild_commands_invalid");
        results.push(await orchestrator.handleBackdatedInvalidation({
          eventId: sourceEvent.eventId,
          organizationId: sourceEvent.organizationId,
          outletId: sourceEvent.outletId,
          changedAt: sourceEvent.effectiveAt,
          detectedAt: sourceEvent.detectedAt,
          rebuildCommands,
        }));
      }
      processedCount += results.length;
      lastProcessedAt = instant(clock());
      lastFailureCode = null;
      return Object.freeze({ status: "COMPLETED", processedCount: results.length, invalidatedCount: results.reduce((sum, item) => sum + item.invalidatedCount, 0), queuedCount: results.reduce((sum, item) => sum + item.queuedCount, 0) });
    } catch (error) {
      failureCount += 1;
      lastFailureCode = safeCode(error);
      throw error;
    } finally { active = false; }
  }

  function health() {
    return Object.freeze({
      contract: INVENTORY_REPORTING_INVALIDATION_CONSUMER_CONTRACT,
      ready: enabled,
      enabled,
      active,
      batchSize: limit,
      processedCount,
      failureCount,
      lastProcessedAt,
      lastFailureCode,
      sourceEventType: INVENTORY_MOVEMENT_REBUILD_EVENT,
      targetDurabilityStatus: "UNVERIFIED",
      deploymentStatus: "IMPLEMENTED_NOT_DEPLOYED",
    });
  }

  return Object.freeze({ pollOnce, health });
}

function normalizeMovementEvent(row, authority) {
  if (!row || uuid(row.organization_id) !== authority.organizationId || !authority.outletIds.includes(uuid(row.outlet_id))) throw failure("inventory_reporting_invalidation_scope_mismatch", 403);
  const payload = jsonObject(row.payload);
  const expectedKeys = ["aggregateId", "correlationId", "effectiveAt", "ingredientId", "locationId", "movementFingerprint", "movementId", "schemaVersion"];
  if (canonical(Object.keys(payload).sort()) !== canonical(expectedKeys.sort()) || payload.schemaVersion !== 1 || digest(payload.movementFingerprint) !== payload.movementFingerprint) {
    throw failure("inventory_reporting_invalidation_source_event_invalid");
  }
  const movementId = identifier(payload.movementId);
  if (identifier(payload.aggregateId) !== movementId) throw failure("inventory_reporting_invalidation_source_event_invalid");
  return {
    eventId: identifier(String(row.event_id)),
    organizationId: authority.organizationId,
    outletId: uuid(row.outlet_id),
    movementId,
    movementFingerprint: payload.movementFingerprint,
    effectiveAt: instant(payload.effectiveAt),
    detectedAt: instant(row.created_at),
  };
}

function normalizeAuthority(input = {}) { if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.outletIds) || input.outletIds.length < 1 || input.outletIds.length > 1_000) throw failure("inventory_reporting_invalidation_scope_invalid"); const organizationId = uuid(input.organizationId); const outletIds = [...new Set(input.outletIds.map(uuid))].sort(); if (outletIds.length !== input.outletIds.length) throw failure("inventory_reporting_invalidation_scope_invalid"); return Object.freeze({ organizationId, outletIds: Object.freeze(outletIds) }); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("inventory_reporting_invalidation_config_invalid"); return value; }
function uuid(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure("inventory_reporting_invalidation_source_event_invalid"); return value.toLowerCase(); }
function identifier(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw failure("inventory_reporting_invalidation_source_event_invalid"); return value; }
function digest(value) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw failure("inventory_reporting_invalidation_source_event_invalid"); return value; }
function instant(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw failure("inventory_reporting_invalidation_source_event_invalid"); return date.toISOString(); }
function jsonObject(value) { const parsed = typeof value === "string" ? JSON.parse(value) : clone(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure("inventory_reporting_invalidation_source_event_invalid"); return parsed; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function clone(value) { return structuredClone(value); }
function safeCode(error) { return typeof error?.code === "string" && /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : "inventory_reporting_invalidation_failure"; }
function failure(code, statusCode = 500) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
