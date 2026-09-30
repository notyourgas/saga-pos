import { randomUUID } from "node:crypto";

export const RETIRED_ROUTE_KEYS = Object.freeze({
  CHECKOUT_V1: "CHECKOUT_V1",
  ESB_INVENTORY_REQUESTS: "ESB_INVENTORY_REQUESTS",
  ESB_INVENTORY_APPROVALS: "ESB_INVENTORY_APPROVALS",
  ESB_INVENTORY_MOVEMENTS: "ESB_INVENTORY_MOVEMENTS",
  ESB_INVENTORY_LEDGER: "ESB_INVENTORY_LEDGER",
});

const ROUTES = Object.freeze({
  [RETIRED_ROUTE_KEYS.CHECKOUT_V1]: Object.freeze({ method: "POST", route: "/api/v1/pos/checkouts" }),
  [RETIRED_ROUTE_KEYS.ESB_INVENTORY_REQUESTS]: Object.freeze({ method: "POST", route: "/api/operator/esb/inventory/requests" }),
  [RETIRED_ROUTE_KEYS.ESB_INVENTORY_APPROVALS]: Object.freeze({ method: "POST", route: "/api/operator/esb/inventory/approvals" }),
  [RETIRED_ROUTE_KEYS.ESB_INVENTORY_MOVEMENTS]: Object.freeze({ method: "POST", route: "/api/operator/esb/inventory/movements" }),
  [RETIRED_ROUTE_KEYS.ESB_INVENTORY_LEDGER]: Object.freeze({ method: "GET", route: "/api/operator/esb/inventory/{ingredientId}" }),
});

const CALLER_CLASSES = Object.freeze(["BROWSER", "CLI", "SERVICE", "UNKNOWN"]);
const MAX_READ_LIMIT = 100;
const DEFAULT_READ_LIMIT = 25;
const EVENT_TYPE = "retired_route.observed";
const AGGREGATE_TYPE = "retired_route_evidence";
const LOCAL_SCOPE = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  outletId: "00000000-0000-4000-8000-000000000002",
});

export class InMemoryRetiredRouteTelemetryStore {
  constructor({ state = null, maximumEvents = 1_000 } = {}) {
    if (!Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 10_000) throw new Error("retired_route_store_capacity_invalid");
    this.maximumEvents = maximumEvents;
    this.events = new Map();
    for (const event of state?.events ?? []) this.#restore(event);
  }

  async append(event) {
    const fact = validateEvent(event);
    const existing = this.events.get(fact.eventId);
    if (existing) {
      if (canonical(existing) !== canonical(fact)) throw new Error("retired_route_event_collision");
      return { event: structuredClone(existing), idempotentReplay: true };
    }
    if (this.events.size >= this.maximumEvents) throw new Error("retired_route_store_capacity_exceeded");
    this.events.set(fact.eventId, fact);
    return { event: structuredClone(fact), idempotentReplay: false };
  }

  async list(scope, { before = null, limit }) {
    assertScope(scope);
    const sorted = [...this.events.values()]
      .filter((event) => sameScope(event, scope) && (!before || compareKey(event, before) < 0))
      .sort((left, right) => compareKey(right, left));
    return { events: structuredClone(sorted.slice(0, limit + 1)) };
  }

  async summary(scope) {
    assertScope(scope);
    return summarize([...this.events.values()].filter((event) => sameScope(event, scope)));
  }

  exportState() { return structuredClone({ events: [...this.events.values()] }); }
  healthSignal() { return Object.freeze({ provider: "BOUNDED_MEMORY", restartSafe: false }); }

  #restore(event) {
    const fact = validateEvent(event);
    if (this.events.has(fact.eventId)) throw new Error("retired_route_event_collision");
    if (this.events.size >= this.maximumEvents) throw new Error("retired_route_store_capacity_exceeded");
    this.events.set(fact.eventId, fact);
  }
}

export class PostgresRetiredRouteTelemetryStore {
  constructor({ db } = {}) {
    if (!db?.query) throw new Error("retired_route_postgres_required");
    this.db = db;
  }

  async append(event) {
    const fact = validateEvent(event);
    const payload = telemetryPayload(fact);
    const inserted = await this.db.query([
      "insert into sagaops.pos_audit_events",
      "(id,organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,correlation_id,payload_redacted,occurred_at)",
      "values ($1,$2,$3,'SYSTEM_RETIRED_ROUTE_TELEMETRY',$4,$5,null,$6,$7::jsonb,$8)",
      "on conflict (id) do nothing returning id",
    ].join(" "), [fact.eventId, fact.organizationId, fact.outletId, EVENT_TYPE, AGGREGATE_TYPE, fact.correlationId, JSON.stringify(payload), fact.observedAt]);
    if (inserted.rows[0]) return { event: structuredClone(fact), idempotentReplay: false };
    const existing = await this.#find(fact.eventId, { organizationId: fact.organizationId, outletId: fact.outletId });
    if (!existing || canonical(existing) !== canonical(fact)) throw new Error("retired_route_event_collision");
    return { event: existing, idempotentReplay: true };
  }

  async list(scope, { before = null, limit }) {
    assertScope(scope);
    const values = [scope.organizationId, scope.outletId];
    let cursorSql = "";
    if (before) {
      values.push(before.observedAt, before.eventId);
      cursorSql = "and (occurred_at,id) < ($3::timestamptz,$4::uuid)";
    }
    values.push(limit + 1);
    const result = await this.db.query([
      "select id,organization_id,outlet_id,correlation_id,payload_redacted,occurred_at",
      "from sagaops.pos_audit_events",
      "where organization_id=$1 and outlet_id=$2 and event_type='retired_route.observed'",
      "and aggregate_type='retired_route_evidence'", cursorSql,
      `order by occurred_at desc,id desc limit $${values.length}`,
    ].filter(Boolean).join(" "), values);
    return { events: result.rows.map(eventFromRow) };
  }

  async summary(scope) {
    assertScope(scope);
    const result = await this.db.query([
      "select payload_redacted->>'routeKey' route_key,payload_redacted->>'callerClass' caller_class,",
      "count(*)::integer event_count,min(occurred_at) first_observed_at,max(occurred_at) last_observed_at",
      "from sagaops.pos_audit_events",
      "where organization_id=$1 and outlet_id=$2 and event_type='retired_route.observed'",
      "and aggregate_type='retired_route_evidence'",
      "and payload_redacted->>'routeKey'=any($3::text[]) and payload_redacted->>'callerClass'=any($4::text[])",
      "group by route_key,caller_class",
    ].join(" "), [scope.organizationId, scope.outletId, Object.keys(ROUTES), CALLER_CLASSES]);
    if (result.rows.length > Object.keys(ROUTES).length * CALLER_CLASSES.length) throw new Error("retired_route_summary_invalid");
    const byRoute = Object.fromEntries(Object.keys(ROUTES).map((key) => [key, 0]));
    const byCallerClass = Object.fromEntries(CALLER_CLASSES.map((key) => [key, 0]));
    let total = 0;
    let firstObservedAt = null;
    let lastObservedAt = null;
    for (const row of result.rows) {
      if (!Object.hasOwn(byRoute, row.route_key) || !Object.hasOwn(byCallerClass, row.caller_class)) throw new Error("retired_route_summary_invalid");
      const count = Number(row.event_count);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("retired_route_summary_invalid");
      total += count;
      if (!Number.isSafeInteger(total)) throw new Error("retired_route_summary_invalid");
      byRoute[row.route_key] += count;
      byCallerClass[row.caller_class] += count;
      const first = new Date(row.first_observed_at).toISOString();
      const last = new Date(row.last_observed_at).toISOString();
      if (!firstObservedAt || first < firstObservedAt) firstObservedAt = first;
      if (!lastObservedAt || last > lastObservedAt) lastObservedAt = last;
    }
    return { total, byRoute, byCallerClass, firstObservedAt, lastObservedAt };
  }

  healthSignal() { return Object.freeze({ provider: "POSTGRES_APPEND_ONLY", restartSafe: true }); }

  async #find(eventId, scope) {
    const result = await this.db.query([
      "select id,organization_id,outlet_id,correlation_id,payload_redacted,occurred_at",
      "from sagaops.pos_audit_events where id=$1 and organization_id=$2 and outlet_id=$3",
      "and event_type='retired_route.observed' and aggregate_type='retired_route_evidence'",
    ].join(" "), [eventId, scope.organizationId, scope.outletId]);
    return result.rows[0] ? eventFromRow(result.rows[0]) : null;
  }
}

export function createRetiredRouteTelemetry({ organizationId, outletId, store, clock = () => new Date(), idFactory = randomUUID } = {}) {
  const scope = assertScope({ organizationId, outletId });
  if (!store?.append || !store?.list || !store?.summary || !store?.healthSignal) throw new Error("retired_route_store_required");
  let lastWriteStatus = "NOT_OBSERVED";

  return Object.freeze({
    async observe(routeKey, requestMetadata = {}) {
      const descriptor = ROUTES[routeKey];
      if (!descriptor) throw new Error("retired_route_key_invalid");
      const eventId = assertUuid(idFactory(), "retired_route_event_id_invalid");
      const fact = validateEvent({
        eventId,
        correlationId: eventId,
        ...scope,
        routeKey,
        ...descriptor,
        observedAt: clock().toISOString(),
        statusCode: 410,
        callerClass: classifyCaller(requestMetadata.headers?.["user-agent"]),
      });
      try {
        await store.append(fact);
        lastWriteStatus = "READY";
      } catch {
        lastWriteStatus = "DEGRADED";
      }
      return publicEvent(fact);
    },

    async readEvidence(query = {}) {
      const parsed = parseReadQuery(query);
      const before = decodeCursor(parsed.cursor);
      const result = await store.list(scope, { before, limit: parsed.limit });
      const page = result.events.slice(0, parsed.limit);
      const hasMore = result.events.length > parsed.limit;
      return {
        data: page.map(publicEvent),
        page: { limit: parsed.limit, nextCursor: hasMore ? encodeCursor(page.at(-1)) : null },
        summary: await store.summary(scope),
        externalTrafficStatus: "UNVERIFIED",
      };
    },

    healthSignal() {
      return Object.freeze({
        status: lastWriteStatus,
        ...store.healthSignal(),
        privacy: "BOUNDED_METADATA_ONLY",
        externalTrafficStatus: "UNVERIFIED",
      });
    },
  });
}

export function createRuntimeRetiredRouteTelemetry({ runtime, clock = () => new Date() } = {}) {
  const store = runtime?.repository?.db?.query
    ? new PostgresRetiredRouteTelemetryStore({ db: runtime.repository.db })
    : new InMemoryRetiredRouteTelemetryStore();
  return createRetiredRouteTelemetry({ ...(runtime?.ids ?? LOCAL_SCOPE), store, clock });
}

function parseReadQuery(query) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("retired_route_query_invalid");
  const allowed = new Set(["limit", "cursor"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new Error("retired_route_scope_override_denied");
  const limit = query.limit == null || query.limit === "" ? DEFAULT_READ_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) throw new Error("retired_route_query_invalid");
  return { limit, cursor: query.cursor || null };
}

function encodeCursor(event) {
  return Buffer.from(JSON.stringify({ v: 1, at: event.observedAt, id: event.eventId }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 256) throw new Error("retired_route_cursor_invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.v !== 1 || Object.keys(parsed).sort().join(",") !== "at,id,v") throw new Error();
    return { observedAt: assertIso(parsed.at), eventId: assertUuid(parsed.id, "retired_route_cursor_invalid") };
  } catch { throw new Error("retired_route_cursor_invalid"); }
}

function classifyCaller(rawUserAgent) {
  const value = String(rawUserAgent ?? "").slice(0, 512).toLowerCase();
  if (/mozilla\//.test(value)) return "BROWSER";
  if (/curl\b|wget\b|httpie\b/.test(value)) return "CLI";
  if (/undici\b|node\b|axios\b|postmanruntime\b|sagapos\b/.test(value)) return "SERVICE";
  return "UNKNOWN";
}

function validateEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("retired_route_event_invalid");
  const descriptor = ROUTES[value.routeKey];
  if (!descriptor || value.route !== descriptor.route || value.method !== descriptor.method || value.statusCode !== 410 || !CALLER_CLASSES.includes(value.callerClass)) throw new Error("retired_route_event_invalid");
  return Object.freeze({
    eventId: assertUuid(value.eventId, "retired_route_event_invalid"),
    correlationId: assertUuid(value.correlationId, "retired_route_event_invalid"),
    organizationId: assertUuid(value.organizationId, "retired_route_event_invalid"),
    outletId: assertUuid(value.outletId, "retired_route_event_invalid"),
    routeKey: value.routeKey,
    route: descriptor.route,
    method: descriptor.method,
    observedAt: assertIso(value.observedAt),
    statusCode: 410,
    callerClass: value.callerClass,
  });
}

function publicEvent(event) {
  return Object.freeze({
    eventId: event.eventId,
    correlationId: event.correlationId,
    routeKey: event.routeKey,
    route: event.route,
    method: event.method,
    observedAt: event.observedAt,
    statusCode: event.statusCode,
    callerClass: event.callerClass,
  });
}

function telemetryPayload(event) {
  return { routeKey: event.routeKey, route: event.route, method: event.method, statusCode: event.statusCode, callerClass: event.callerClass };
}

function eventFromRow(row) {
  return validateEvent({
    eventId: row.id,
    correlationId: row.correlation_id,
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    observedAt: new Date(row.occurred_at).toISOString(),
    ...row.payload_redacted,
  });
}

function summarize(events) {
  const byRoute = Object.fromEntries(Object.keys(ROUTES).map((key) => [key, 0]));
  const byCallerClass = Object.fromEntries(CALLER_CLASSES.map((key) => [key, 0]));
  let firstObservedAt = null;
  let lastObservedAt = null;
  for (const event of events) {
    if (Object.hasOwn(byRoute, event.routeKey)) byRoute[event.routeKey] += 1;
    if (Object.hasOwn(byCallerClass, event.callerClass)) byCallerClass[event.callerClass] += 1;
    const at = assertIso(event.observedAt);
    if (!firstObservedAt || at < firstObservedAt) firstObservedAt = at;
    if (!lastObservedAt || at > lastObservedAt) lastObservedAt = at;
  }
  return { total: events.length, byRoute, byCallerClass, firstObservedAt, lastObservedAt };
}

function compareKey(left, right) {
  return left.observedAt.localeCompare(right.observedAt) || left.eventId.localeCompare(right.eventId);
}

function sameScope(event, scope) { return event.organizationId === scope.organizationId && event.outletId === scope.outletId; }
function canonical(value) { return JSON.stringify(value); }

function assertScope(value) {
  return Object.freeze({
    organizationId: assertUuid(value?.organizationId, "retired_route_scope_invalid"),
    outletId: assertUuid(value?.outletId, "retired_route_scope_invalid"),
  });
}

function assertUuid(value, code) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""))) throw new Error(code);
  return String(value).toLowerCase();
}

function assertIso(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error("retired_route_timestamp_invalid");
  return value;
}
