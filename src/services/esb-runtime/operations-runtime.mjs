import { randomUUID } from "node:crypto";

import { HppCatalog } from "../../pos-alpha/hpp-catalog.mjs";
import {
  EXCEPTION_KINDS,
  assertExceptionPermission,
  createEsbExceptionPostgresAdapter,
  prepareExceptionCommand,
} from "../esb-exceptions/index.mjs";

const ALLOWED_KEYS = new Set([
  "kind",
  "orderId",
  "operationKey",
  "reasonId",
  "reasonVersion",
  "reasonNote",
  "expectedResourceVersion",
  "authorizationId",
  "stockDisposition",
]);

const SUPPORTED_KINDS = new Set([
  EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION,
  EXCEPTION_KINDS.VOID_POST_PRODUCTION,
]);

export function createEsbOperationsRuntime({ db, ids, clock = () => new Date(), exceptionAdapter = null } = {}) {
  if (!db?.query || !db?.transaction) throw new Error("esb_operations_database_required");
  if (!ids?.organizationId || !ids?.outletId || !ids?.ownerProfileId) throw new Error("esb_operations_scope_required");
  const adapter = exceptionAdapter ?? createEsbExceptionPostgresAdapter({ db, now: () => clock().toISOString() });

  return Object.freeze({
    async executeException({ actor: sessionActor, body }) {
      const command = validateBody(body);
      const actor = runtimeActor(sessionActor, ids);
      try {
        assertExceptionPermission({
          actor,
          organizationId: ids.organizationId,
          outletId: ids.outletId,
          kind: command.kind,
          capability: "EXECUTE",
        });
        const replay = await findExistingOperation(db, ids, command);
        if (replay) {
          return { ...replay, replay: true, providerCallEnabled: false, hardwareActivation: "OFF_REQUIRES_PHYSICAL_UAT" };
        }
        const resource = await loadOrderResource(db, ids, command.orderId);
        const reasonMaster = await loadReason(db, ids, command);
        const period = await loadPeriod(db, ids, resource.businessDate);
        const authorization = command.authorizationId
          ? await loadAuthorization(db, ids, command.authorizationId)
          : null;
        const before = beforeSnapshot(resource);
        const decision = prepareExceptionCommand({
          organizationId: ids.organizationId,
          outletId: ids.outletId,
          resourceType: "bill",
          resourceId: resource.billId,
          operationKey: command.operationKey,
          occurredAt: clock().toISOString(),
          kind: command.kind,
          actor,
          reasonMaster,
          reasonNote: command.reasonNote,
          before,
          period,
          authorization,
          stockDisposition: command.stockDisposition,
        });
        const result = await adapter.execute({
          decision,
          actor,
          businessDate: resource.businessDate,
          expectedResourceVersion: command.expectedResourceVersion,
          applyBusinessEffect: (tx, event) => applyOrderEffect(tx, { ids, resource, ...event }),
        });
        return {
          ...result,
          kind: command.kind,
          orderId: resource.orderId,
          businessDate: resource.businessDate,
          providerCallEnabled: false,
          hardwareActivation: "OFF_REQUIRES_PHYSICAL_UAT",
        };
      } catch (error) {
        if (error?.audit) await recordDenial(db, { ids, actor, command, error, occurredAt: clock().toISOString() });
        throw normalizeError(error);
      }
    },
  });
}

async function findExistingOperation(db, ids, command) {
  const result = await db.query(
    `select operation.outlet_id,operation.exception_kind,operation.resource_id,bill.order_id,event.id event_id,event.resource_version,
            event.reason_id,event.reason_version,event.authorization_id,event.effect_snapshot,audit.metadata audit_metadata
       from sagaops.esb_exception_operations operation
       left join sagaops.esb_exception_events event on event.id=operation.result_event_id
       left join sagaops.esb_exception_audit_events audit on audit.exception_event_id=event.id
       left join sagaops.esb_bills bill
         on bill.id::text=operation.resource_id and bill.organization_id=operation.organization_id and bill.outlet_id=operation.outlet_id
      where operation.organization_id=$1 and operation.operation_key=$2`,
    [ids.organizationId, command.operationKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const effect = row.effect_snapshot ?? {};
  const same = row.outlet_id === ids.outletId
    && row.exception_kind === command.kind
    && row.order_id === command.orderId
    && row.reason_id === command.reasonId
    && Number(row.reason_version) === command.reasonVersion
    && Number(row.resource_version) === command.expectedResourceVersion + 1
    && (row.audit_metadata?.reason?.note ?? undefined) === command.reasonNote
    && (row.authorization_id ?? null) === command.authorizationId
    && (command.kind !== EXCEPTION_KINDS.VOID_POST_PRODUCTION || effect.stockDisposition === command.stockDisposition)
    && row.event_id;
  if (!same) throw failure("exception_operation_key_reused_with_different_command", 409);
  return { eventId: row.event_id, resourceVersion: Number(row.resource_version), kind: command.kind, orderId: command.orderId };
}

function validateBody(body) {
  if (!plain(body) || !Object.keys(body).every((key) => ALLOWED_KEYS.has(key))) throw failure("esb_exception_request_invalid", 422);
  const kind = text(body.kind, "esb_exception_kind_required", 64);
  if (!SUPPORTED_KINDS.has(kind)) throw failure("esb_exception_kind_not_available", 422);
  const orderId = uuid(body.orderId, "esb_exception_order_id_invalid");
  const operationKey = text(body.operationKey, "esb_exception_operation_key_required", 160);
  const reasonId = uuid(body.reasonId, "esb_exception_reason_id_invalid");
  const reasonVersion = Number(body.reasonVersion);
  const expectedResourceVersion = Number(body.expectedResourceVersion ?? 0);
  if (!Number.isSafeInteger(reasonVersion) || reasonVersion < 1) throw failure("esb_exception_reason_version_invalid", 422);
  if (!Number.isSafeInteger(expectedResourceVersion) || expectedResourceVersion < 0) throw failure("esb_exception_expected_version_invalid", 422);
  const authorizationId = body.authorizationId == null ? null : text(body.authorizationId, "esb_exception_authorization_id_invalid", 100);
  const stockDisposition = body.stockDisposition == null ? undefined : text(body.stockDisposition, "esb_exception_stock_disposition_invalid", 40);
  const reasonNote = body.reasonNote == null ? undefined : text(body.reasonNote, "esb_exception_reason_note_invalid", 240);
  return Object.freeze({ kind, orderId, operationKey, reasonId, reasonVersion, reasonNote, expectedResourceVersion, authorizationId, stockDisposition });
}

function runtimeActor(subject, ids) {
  const rawRole = String(subject?.role ?? "").toLowerCase();
  const role = rawRole === "cashier" ? "cashier_barista" : rawRole;
  const userProfileId = rawRole === "owner"
    ? ids.ownerProfileId
    : text(subject?.employeeId ?? subject?.userAccountId, "esb_exception_actor_invalid", 100);
  return Object.freeze({
    userProfileId,
    role,
    organizationId: ids.organizationId,
    outletIds: [ids.outletId],
  });
}

async function loadOrderResource(db, ids, orderId) {
  const result = await db.query(
    `select orders.id order_id,orders.status order_status,orders.business_date,orders.created_at,
            bill.id bill_id,bill.status bill_status,
            payment.status payment_status,
            fulfillment.status fulfillment_status
       from sagaops.orders orders
       left join sagaops.esb_bills bill
         on bill.order_id=orders.id and bill.organization_id=orders.organization_id and bill.outlet_id=orders.outlet_id
       left join sagaops.esb_payment_attempts payment
         on payment.order_id=orders.id and payment.organization_id=orders.organization_id and payment.outlet_id=orders.outlet_id
       left join sagaops.fulfillment_tickets fulfillment
         on fulfillment.order_id=orders.id and fulfillment.organization_id=orders.organization_id and fulfillment.outlet_id=orders.outlet_id
      where orders.organization_id=$1 and orders.outlet_id=$2 and orders.id=$3
      order by bill.opened_at desc nulls last,payment.created_at desc nulls last`,
    [ids.organizationId, ids.outletId, orderId],
  );
  const row = result.rows[0];
  if (!row || !row.bill_id) throw failure("esb_exception_order_not_found", 404);
  const billIds = [...new Set(result.rows.map((item) => item.bill_id).filter(Boolean))];
  const billStatuses = [...new Set(result.rows.map((item) => String(item.bill_status).toUpperCase()))];
  if (billStatuses.length !== 1) throw failure("esb_exception_split_bill_state_conflict", 409);
  return {
    orderId: row.order_id,
    orderStatus: String(row.order_status).toUpperCase(),
    businessDate: isoDate(row.business_date),
    billId: row.bill_id,
    billIds,
    billStatus: billStatuses[0],
    paymentStatus: row.payment_status ? String(row.payment_status).toUpperCase() : null,
    fulfillmentStatus: row.fulfillment_status ? String(row.fulfillment_status).toUpperCase() : null,
  };
}

async function loadReason(db, ids, command) {
  const result = await db.query(
    `select id,version,organization_id,outlet_id,code,label,permitted_kinds,active,requires_note,effective_from,effective_until
       from sagaops.esb_exception_reason_versions
      where organization_id=$1 and id=$2 and version=$3 and (outlet_id is null or outlet_id=$4)`,
    [ids.organizationId, command.reasonId, command.reasonVersion, ids.outletId],
  );
  const row = result.rows[0];
  if (!row) throw failure("esb_exception_reason_not_found", 422);
  return {
    id: row.id,
    version: Number(row.version),
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    code: row.code,
    label: row.label,
    permittedKinds: row.permitted_kinds,
    active: row.active,
    requiresNote: row.requires_note,
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveUntil: row.effective_until ? new Date(row.effective_until).toISOString() : null,
  };
}

async function loadPeriod(db, ids, businessDate) {
  const result = await db.query(
    `select state,close_id from sagaops.esb_exception_periods
      where organization_id=$1 and outlet_id=$2 and business_date=$3`,
    [ids.organizationId, ids.outletId, businessDate],
  );
  const row = result.rows[0];
  if (!row) throw failure("esb_exception_period_not_registered", 409);
  return { state: row.state, closeId: row.close_id };
}

async function loadAuthorization(db, ids, authorizationId) {
  const result = await db.query(
    `select id,approval_id,action_type,resource_type,resource_id,executor_user_id,executor_role,binding_hash,
            status,issued_at,expires_at,consumed_at,consumed_operation_key
       from sagaops.esb_action_authorizations
      where organization_id=$1 and outlet_id=$2 and id=$3`,
    [ids.organizationId, ids.outletId, authorizationId],
  );
  const row = result.rows[0];
  if (!row) throw failure("esb_exception_authorization_not_found", 422);
  return {
    id: row.id,
    approvalId: row.approval_id,
    organizationId: ids.organizationId,
    outletId: ids.outletId,
    kind: row.action_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    executorUserId: row.executor_user_id,
    executorRole: row.executor_role,
    bindingHash: row.binding_hash,
    status: row.status,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
    consumedOperationKey: row.consumed_operation_key,
  };
}

function beforeSnapshot(resource) {
  const productionStarted = ["IN_PROGRESS", "READY", "COMPLETED"].includes(resource.fulfillmentStatus);
  let orderState = resource.orderStatus === "DRAFT" ? "PLACED" : resource.orderStatus;
  if (productionStarted) orderState = resource.fulfillmentStatus === "COMPLETED" ? "FULFILLED" : "IN_PRODUCTION";
  return {
    orderState,
    productionStarted,
    billState: resource.billStatus,
    paymentStatus: resource.paymentStatus,
  };
}

async function applyOrderEffect(tx, { ids, resource, eventId, kind, event }) {
  const occurredAt = event.occurredAt;
  if (kind === EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION) {
    await assertNoActiveCanonicalReservation(tx, { ids, orderId: resource.orderId });
  }
  const order = await tx.query(
    `update sagaops.orders set status='voided',updated_at=$4
      where organization_id=$1 and outlet_id=$2 and id=$3 and status in ('draft','paid') returning id`,
    [ids.organizationId, ids.outletId, resource.orderId, occurredAt],
  );
  if (order.rows.length !== 1) throw failure("esb_exception_order_state_conflict", 409);
  if (resource.billIds.length > 1) {
    await tx.query(
      `insert into sagaops.esb_exception_events
        (id,organization_id,outlet_id,exception_kind,resource_type,resource_id,resource_version,operation_key,
         actor_user_id,actor_role_snapshot,reason_id,reason_version,authorization_id,before_snapshot,
         after_snapshot,effect_snapshot,occurred_at)
       select gen_random_uuid(),event.organization_id,event.outlet_id,event.exception_kind,event.resource_type,
              sibling.id::text,event.resource_version,event.operation_key||':bill:'||sibling.id::text,
              event.actor_user_id,event.actor_role_snapshot,event.reason_id,event.reason_version,event.authorization_id,
              event.before_snapshot,event.after_snapshot,event.effect_snapshot,event.occurred_at
         from sagaops.esb_exception_events event
         cross join unnest($2::uuid[]) sibling(id)
        where event.id=$1 and sibling.id::text<>event.resource_id`,
      [eventId, resource.billIds],
    );
  }
  const bill = await tx.query(
    `update sagaops.esb_bills set status='VOIDED',voided_at=$4,updated_at=$4
      where organization_id=$1 and outlet_id=$2 and order_id=$3 and status in ('OPEN','PARTIALLY_PAID') returning id`,
    [ids.organizationId, ids.outletId, resource.orderId, occurredAt],
  );
  if (bill.rows.length !== resource.billIds.length) throw failure("esb_exception_bill_state_conflict", 409);
  await tx.query(
    `update sagaops.fulfillment_tickets set status='cancelled',updated_at=$4
      where organization_id=$1 and outlet_id=$2 and order_id=$3 and status in ('new','in_progress')`,
    [ids.organizationId, ids.outletId, resource.orderId, occurredAt],
  );
  await tx.query(
    `insert into public.sagaops_integration_outbox
      (id,organization_id,outlet_id,event_id,event_type,payload,status,available_at,created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$7)`,
    [randomUUID(), ids.organizationId, ids.outletId, randomUUID(),
      kind === EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION ? "POS_ORDER_CANCELLED_V1" : "POS_ORDER_VOIDED_V1",
      JSON.stringify({ orderId: resource.orderId, exceptionEventId: eventId, providerCallEnabled: false }), occurredAt],
  );
}

async function assertNoActiveCanonicalReservation(tx, { ids, orderId }) {
  const result = await tx.query(
    `select snapshot from sagaops.pos_hpp_catalog_state
      where organization_id=$1 and outlet_id=$2 for update`,
    [ids.organizationId, ids.outletId],
  );
  if (!result.rows[0]) return;
  const snapshot = result.rows[0].snapshot;
  let reservations;
  try {
    if (!plain(snapshot) || !Number.isSafeInteger(snapshot.stateVersion)) throw new Error("hpp_state_invalid");
    const verifier = new HppCatalog();
    verifier.restoreState(snapshot);
    reservations = verifier.exportState().inventoryReservations;
  } catch {
    throw failure("esb_exception_canonical_inventory_unavailable", 409);
  }
  if (reservations.some((reservation) => reservation?.orderId === orderId && reservation.status === "ACTIVE")) {
    throw failure("esb_exception_canonical_inventory_action_required", 409);
  }
}

async function recordDenial(db, { ids, actor, command, error, occurredAt }) {
  await db.query(
    `insert into sagaops.pos_audit_events
      (organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,correlation_id,payload_redacted,occurred_at)
     values ($1,$2,$3,'exception.permission.denied','exception_permission',null,$4,$5::jsonb,$6)`,
    [ids.organizationId, ids.outletId, actor.userProfileId, command.operationKey,
      JSON.stringify({ denialCode: error.code ?? error.message, role: actor.role, kind: command.kind }), occurredAt],
  );
}

function normalizeError(error) {
  if (error?.statusCode) return error;
  const code = String(error?.code ?? error?.message ?? "esb_exception_failed");
  const denial = code.includes("denied") || code.includes("permission") || code.includes("owner_required");
  const conflict = code.includes("conflict") || code.includes("already_used") || code.includes("compare_and_set");
  error.code = code;
  error.statusCode = denial ? 403 : conflict ? 409 : 422;
  return error;
}

function isoDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw failure("esb_exception_business_date_invalid", 500);
  return parsed.toISOString().slice(0, 10);
}

function text(value, code, maximum) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw failure(code, 422);
  return value.trim();
}

function uuid(value, code) {
  const normalized = text(value, code, 36);
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(normalized)) throw failure(code, 422);
  return normalized;
}

function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function failure(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
