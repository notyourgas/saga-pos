import { createHash, randomUUID } from "node:crypto";

import { EsbMoneyLedgerError, createEsbMoneyLedger, moneyLedgerFingerprint } from "./ledger.mjs";

const PROVIDER_CAPABILITY = "PROVIDER_GENERIC";
const SYNTHETIC_DATA_MODE = "SYNTHETIC";

export function createEsbPaymentPlanRuntime({
  db,
  now = () => new Date().toISOString(),
  idFactory = randomUUID,
  faultInjector = () => {},
} = {}) {
  if (!db?.transaction || !db?.query) throw failure("database_adapter_required");

  return {
    async recordPaymentPlan(command) {
      const plan = validatePlan(command);
      const fingerprint = moneyLedgerFingerprint({ ...plan, operationKey: undefined });
      return db.transaction(async (tx) => {
        const claim = await claimPlan(tx, plan, fingerprint);
        if (claim.replay) return { replay: true, detail: await loadDetail(tx, plan) };

        await lockAndValidateBills(tx, plan);
        const ledger = createEsbMoneyLedger({ db: transactionView(tx), now, idFactory });
        for (const [index, attempt] of plan.attempts.entries()) {
          await ledger.recordPaymentAttempt({
            id: attempt.id,
            organizationId: plan.organizationId,
            outletId: plan.outletId,
            orderId: plan.orderId,
            operationKey: attempt.operationKey,
            methodType: attempt.methodType,
            methodNameSnapshot: attempt.methodNameSnapshot,
            verificationLevel: attempt.methodType === "cash" ? "CASH" : "MANUAL",
            provider: attempt.provider,
            providerReference: attempt.providerReference,
            tendered: attempt.tendered,
            applied: attempt.applied,
            change: attempt.change,
            createdAt: plan.createdAt,
            allocations: attempt.allocations,
          });
          await ledger.applyPaymentEvent({
            id: attempt.initialEventId,
            paymentAttemptId: attempt.id,
            organizationId: plan.organizationId,
            outletId: plan.outletId,
            operationKey: `${attempt.operationKey}:initial`,
            eventType: attempt.initialStatus === "SUCCEEDED" ? "CASH_ACCEPTED" : "PAYMENT_PLAN_PENDING",
            targetStatus: attempt.initialStatus,
            businessDate: attempt.initialStatus === "SUCCEEDED" ? plan.businessDate : undefined,
            cashSessionId: attempt.cashSessionId,
            occurredAt: plan.createdAt,
            payloadRedacted: { source: "SAGAPOS_ESB_PAYMENT_PLAN_V1", planOperationKey: plan.operationKey },
          });
          await faultInjector("after_payment_plan_attempt", { index, attemptId: attempt.id, tx });
        }
        return { replay: false, detail: await loadDetail(tx, plan) };
      });
    },

    async confirmProviderSuccess(command) {
      const scope = validateProviderSuccess(command);
      const ledger = createEsbMoneyLedger({ db, now, idFactory });
      const result = await ledger.applyPaymentEvent({
        id: scope.eventId,
        paymentAttemptId: scope.paymentAttemptId,
        organizationId: scope.organizationId,
        outletId: scope.outletId,
        operationKey: scope.operationKey,
        provider: scope.provider,
        externalEventId: scope.externalEventId,
        eventType: "PROVIDER_PAYMENT_SUCCEEDED",
        targetStatus: "SUCCEEDED",
        occurredAt: scope.occurredAt,
        payloadRedacted: { source: "SAGAPOS_ESB_PROVIDER_EVENT_V1", providerEventRecorded: true },
      });
      return { ...result, detail: await loadDetail(db, scope) };
    },

    async paymentDetail(scope) {
      return loadDetail(db, validateScope(scope));
    },
  };
}

export function createDurableSyntheticProviderCoordinator({ db, adapter, now = () => new Date().toISOString() } = {}) {
  if (!db?.transaction || !db?.query) throw failure("database_adapter_required");
  const descriptor = adapter?.descriptor?.();
  if (!adapter?.execute || descriptor?.capability !== PROVIDER_CAPABILITY || descriptor?.dataMode !== SYNTHETIC_DATA_MODE
    || descriptor?.externalSideEffectsAllowed !== false || descriptor?.businessClaimAllowed !== false) {
    throw failure("synthetic_provider_adapter_required");
  }
  const paymentRuntime = createEsbPaymentPlanRuntime({ db, now });

  return {
    async execute(command) {
      const input = validateDispatch(command);
      const fingerprint = moneyLedgerFingerprint({
        paymentAttemptId: input.paymentAttemptId,
        provider: input.provider,
        payload: input.payload,
      });
      const claim = await claimDispatch(db, input, fingerprint);
      if (claim.replay) return recoverOrThrow(await recoverDispatch(db, input, fingerprint));

      try {
        const result = await adapter.execute({
          scope: { organizationId: input.organizationId, outletId: input.outletId },
          operationKey: input.operationKey,
          idempotencyKey: `${input.organizationId}:${input.outletId}:${input.operationKey}`,
          payload: input.payload,
          dataMode: SYNTHETIC_DATA_MODE,
        });
        if (result?.accepted !== true || !safeText(result.externalEventId, 200)) throw failure("synthetic_provider_result_invalid");
        const confirmed = await paymentRuntime.confirmProviderSuccess({
          ...input,
          eventId: deterministicUuid(`provider-success:${input.organizationId}:${input.operationKey}`),
          operationKey: `${input.operationKey}:provider-success`,
          externalEventId: result.externalEventId,
          occurredAt: result.occurredAt ?? now(),
        });
        return { status: "SUCCEEDED", replay: false, dataMode: SYNTHETIC_DATA_MODE, detail: confirmed.detail };
      } catch (error) {
        if (error?.sideEffectUnknown !== true) throw error;
        await recordUncertainEvent(db, input, now());
        throw failure("provider_operation_reconciliation_required", 409);
      }
    },

    async recover(command) {
      const input = validateDispatch(command);
      const fingerprint = moneyLedgerFingerprint({
        paymentAttemptId: input.paymentAttemptId,
        provider: input.provider,
        payload: input.payload,
      });
      return recoverDispatch(db, input, fingerprint);
    },
  };
}

async function claimPlan(tx, command, fingerprint) {
  const inserted = await tx.query(
    `insert into sagaops.esb_money_operations
      (organization_id,outlet_id,operation_key,operation_type,aggregate_id,request_fingerprint)
     values ($1,$2,$3,'RECORD_PAYMENT_PLAN',$4,$5)
     on conflict (organization_id,operation_key) do nothing returning operation_key`,
    [command.organizationId, command.outletId, command.operationKey, command.orderId, fingerprint],
  );
  if (inserted.rows[0]) return { replay: false };
  const existing = await tx.query(
    `select outlet_id,operation_type,aggregate_id,request_fingerprint from sagaops.esb_money_operations
      where organization_id=$1 and operation_key=$2`,
    [command.organizationId, command.operationKey],
  );
  const row = existing.rows[0];
  if (!row || row.outlet_id !== command.outletId || row.operation_type !== "RECORD_PAYMENT_PLAN"
    || row.aggregate_id !== command.orderId || row.request_fingerprint !== fingerprint) {
    throw failure("payment_plan_operation_key_conflict", 409);
  }
  return { replay: true };
}

async function lockAndValidateBills(tx, plan) {
  const billIds = [...new Set(plan.attempts.flatMap((attempt) => attempt.allocations.map((row) => row.billId)))].sort();
  const bills = await tx.query(
    `select id,total_rupiah,status from sagaops.esb_bills
      where organization_id=$1 and outlet_id=$2 and order_id=$3 and id=any($4::uuid[])
      order by id for update`,
    [plan.organizationId, plan.outletId, plan.orderId, billIds],
  );
  if (bills.rows.length !== billIds.length) throw failure("payment_plan_bill_scope_mismatch");
  const reserved = await tx.query(
    `select allocation.bill_id,coalesce(sum(allocation.applied_rupiah),0)::bigint as applied
       from sagaops.esb_bill_payment_allocations allocation
       join sagaops.esb_payment_attempts attempt on attempt.id=allocation.payment_attempt_id
      where allocation.bill_id=any($1::uuid[]) and attempt.status in ('CREATED','PENDING','SUCCEEDED')
      group by allocation.bill_id`,
    [billIds],
  );
  const alreadyReserved = new Map(reserved.rows.map((row) => [row.bill_id, Number(row.applied)]));
  const planned = new Map();
  for (const attempt of plan.attempts) {
    for (const allocation of attempt.allocations) planned.set(allocation.billId, (planned.get(allocation.billId) ?? 0) + allocation.applied);
  }
  for (const bill of bills.rows) {
    if (bill.status === "VOIDED") throw failure("payment_plan_bill_not_payable");
    const outstanding = Number(bill.total_rupiah) - (alreadyReserved.get(bill.id) ?? 0);
    if (planned.get(bill.id) !== outstanding) throw failure("payment_plan_balance_mismatch", 422, { billId: bill.id, outstanding });
  }
}

async function loadDetail(db, scope) {
  const validated = validateScope(scope);
  const attempts = await db.query(
    `select id,status,method_type,method_name_snapshot,verification_level,provider,provider_reference,
            tendered_rupiah,applied_rupiah,change_rupiah,created_at,updated_at,succeeded_at
       from sagaops.esb_payment_attempts
      where organization_id=$1 and outlet_id=$2 and order_id=$3
      order by created_at, case when method_type='cash' then 0 else 1 end, id`,
    [validated.organizationId, validated.outletId, validated.orderId],
  );
  const rows = [];
  for (const attempt of attempts.rows) {
    const [allocations, events] = await Promise.all([
      db.query(
        `select bill_id,applied_rupiah from sagaops.esb_bill_payment_allocations
          where organization_id=$1 and outlet_id=$2 and payment_attempt_id=$3 order by bill_id`,
        [validated.organizationId, validated.outletId, attempt.id],
      ),
      db.query(
        `select event_type,status_before,status_after,provider,external_event_id,occurred_at
           from sagaops.esb_payment_events
          where organization_id=$1 and outlet_id=$2 and payment_attempt_id=$3 order by received_at,id`,
        [validated.organizationId, validated.outletId, attempt.id],
      ),
    ]);
    const providerEvidence = events.rows.find((event) => event.provider && event.external_event_id && event.status_after === "SUCCEEDED");
    if (attempt.verification_level === "PROVIDER_VERIFIED" && !providerEvidence) throw failure("provider_verification_evidence_missing", 500);
    rows.push({
      id: attempt.id,
      status: attempt.status,
      methodType: attempt.method_type,
      methodName: attempt.method_name_snapshot,
      tenderedRupiah: Number(attempt.tendered_rupiah),
      appliedRupiah: Number(attempt.applied_rupiah),
      changeRupiah: Number(attempt.change_rupiah),
      verification: {
        level: attempt.verification_level,
        source: attempt.verification_level === "CASH" ? "CASH_ACCEPTED_EVENT"
          : attempt.verification_level === "PROVIDER_VERIFIED" ? "EXTERNAL_PROVIDER_EVENT"
            : attempt.verification_level === "LEGACY_UNVERIFIED" ? "LEGACY_IMPORT" : "MANUAL_OR_PENDING",
        provider: attempt.provider,
        externalEventId: providerEvidence?.external_event_id ?? null,
        verifiedAt: isoValue(providerEvidence?.occurred_at ?? (attempt.verification_level === "CASH" ? attempt.succeeded_at : null)),
      },
      allocations: allocations.rows.map((row) => ({ billId: row.bill_id, appliedRupiah: Number(row.applied_rupiah) })),
      events: events.rows.map((event) => ({
        type: event.event_type,
        statusBefore: event.status_before,
        statusAfter: event.status_after,
        occurredAt: isoValue(event.occurred_at),
      })),
    });
  }
  const totals = rows.reduce((result, row) => {
    result.plannedAppliedRupiah += row.appliedRupiah;
    result.tenderedRupiah += row.status === "SUCCEEDED" ? row.tenderedRupiah : 0;
    result.successfulAppliedRupiah += row.status === "SUCCEEDED" ? row.appliedRupiah : 0;
    result.pendingAppliedRupiah += row.status === "PENDING" ? row.appliedRupiah : 0;
    result.changeRupiah += row.status === "SUCCEEDED" ? row.changeRupiah : 0;
    return result;
  }, { plannedAppliedRupiah: 0, successfulAppliedRupiah: 0, pendingAppliedRupiah: 0, tenderedRupiah: 0, changeRupiah: 0 });
  return { contractVersion: "SAGAPOS_ESB_PAYMENT_DETAIL_V1", ...validated, attempts: rows, totals };
}

async function claimDispatch(db, input, fingerprint) {
  return db.transaction(async (tx) => {
    const attempt = await tx.query(
      `select status,provider from sagaops.esb_payment_attempts
        where id=$1 and organization_id=$2 and outlet_id=$3 and order_id=$4 for update`,
      [input.paymentAttemptId, input.organizationId, input.outletId, input.orderId],
    );
    if (!attempt.rows[0] || attempt.rows[0].provider !== input.provider) {
      throw failure("provider_payment_attempt_not_dispatchable");
    }
    const inserted = await tx.query(
      `insert into sagaops.esb_money_operations
        (organization_id,outlet_id,operation_key,operation_type,aggregate_id,request_fingerprint)
       values ($1,$2,$3,'DISPATCH_SYNTHETIC_PROVIDER',$4,$5)
       on conflict (organization_id,operation_key) do nothing returning operation_key`,
      [input.organizationId, input.outletId, input.operationKey, input.paymentAttemptId, fingerprint],
    );
    if (inserted.rows[0]) {
      if (attempt.rows[0].status !== "PENDING") throw failure("provider_payment_attempt_not_dispatchable");
      return { replay: false };
    }
    const existing = await tx.query(
      `select outlet_id,operation_type,aggregate_id,request_fingerprint from sagaops.esb_money_operations
        where organization_id=$1 and operation_key=$2`,
      [input.organizationId, input.operationKey],
    );
    const row = existing.rows[0];
    if (!row || row.outlet_id !== input.outletId || row.operation_type !== "DISPATCH_SYNTHETIC_PROVIDER"
      || row.aggregate_id !== input.paymentAttemptId || row.request_fingerprint !== fingerprint) {
      throw failure("provider_operation_key_conflict", 409);
    }
    return { replay: true };
  });
}

async function recoverDispatch(db, input, fingerprint) {
  const operation = await db.query(
    `select outlet_id,operation_type,aggregate_id,request_fingerprint from sagaops.esb_money_operations
      where organization_id=$1 and operation_key=$2`,
    [input.organizationId, input.operationKey],
  );
  if (!operation.rows[0]) return { status: "NOT_STARTED", replay: false, dataMode: SYNTHETIC_DATA_MODE };
  const row = operation.rows[0];
  if (row.outlet_id !== input.outletId || row.operation_type !== "DISPATCH_SYNTHETIC_PROVIDER"
    || row.aggregate_id !== input.paymentAttemptId || row.request_fingerprint !== fingerprint) {
    throw failure("provider_operation_key_conflict", 409);
  }
  const state = await db.query(
    `select status,verification_level from sagaops.esb_payment_attempts
      where id=$1 and organization_id=$2 and outlet_id=$3 and order_id=$4`,
    [input.paymentAttemptId, input.organizationId, input.outletId, input.orderId],
  );
  if (state.rows[0]?.status === "SUCCEEDED" && state.rows[0]?.verification_level === "PROVIDER_VERIFIED") {
    return { status: "SUCCEEDED", replay: true, dataMode: SYNTHETIC_DATA_MODE };
  }
  return {
    status: "RECONCILIATION_REQUIRED",
    replay: true,
    dataMode: SYNTHETIC_DATA_MODE,
    reason: "DISPATCH_CLAIM_EXISTS_WITHOUT_VERIFIED_TERMINAL_EVENT",
  };
}

function recoverOrThrow(result) {
  if (result.status === "RECONCILIATION_REQUIRED") throw failure("provider_operation_reconciliation_required", 409);
  return result;
}

async function recordUncertainEvent(db, input, occurredAt) {
  const ledger = createEsbMoneyLedger({ db, now: () => occurredAt });
  return ledger.applyPaymentEvent({
    id: deterministicUuid(`provider-uncertain:${input.organizationId}:${input.operationKey}`),
    paymentAttemptId: input.paymentAttemptId,
    organizationId: input.organizationId,
    outletId: input.outletId,
    operationKey: `${input.operationKey}:uncertain`,
    eventType: "PROVIDER_ACCEPTANCE_UNCERTAIN",
    targetStatus: "PENDING",
    occurredAt,
    payloadRedacted: { source: "SAGAPOS_ESB_PROVIDER_COORDINATOR_V1", action: "RECONCILE_DO_NOT_RETRY" },
  });
}

function validatePlan(command) {
  const scope = validateScope(command);
  const operationKey = requireText(command.operationKey, "payment_plan_operation_key_required", 160);
  const businessDate = requireText(command.businessDate, "payment_plan_business_date_required", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) throw failure("payment_plan_business_date_invalid");
  if (!Array.isArray(command.attempts) || command.attempts.length < 2) throw failure("split_payment_plan_requires_multiple_attempts");
  const ids = new Set();
  const operationKeys = new Set();
  const attempts = command.attempts.map((attempt) => {
    const id = requireText(attempt.id, "payment_attempt_id_required", 100);
    const attemptOperationKey = requireText(attempt.operationKey, "payment_attempt_operation_key_required", 160);
    if (ids.has(id) || operationKeys.has(attemptOperationKey)) throw failure("payment_plan_duplicate_attempt");
    ids.add(id); operationKeys.add(attemptOperationKey);
    const methodType = requireText(attempt.methodType, "payment_method_type_required", 64).toLowerCase();
    const initialStatus = requireText(attempt.initialStatus, "payment_initial_status_required", 32).toUpperCase();
    if (methodType === "cash" ? initialStatus !== "SUCCEEDED" : initialStatus !== "PENDING") {
      throw failure("payment_plan_status_not_allowed");
    }
    const allocations = validateAllocations(attempt.allocations);
    const applied = integer(attempt.applied, "payment_applied_invalid");
    const change = integer(attempt.change ?? 0, "payment_change_invalid");
    const tendered = integer(attempt.tendered, "payment_tendered_invalid");
    if (allocations.reduce((sum, row) => sum + row.applied, 0) !== applied || tendered !== applied + change) {
      throw failure("payment_plan_attempt_balance_mismatch");
    }
    return {
      id,
      operationKey: attemptOperationKey,
      initialEventId: requireText(attempt.initialEventId ?? deterministicUuid(`initial:${scope.organizationId}:${id}`), "payment_initial_event_id_required", 100),
      methodType,
      methodNameSnapshot: requireText(attempt.methodNameSnapshot, "payment_method_name_required", 160),
      initialStatus,
      provider: attempt.provider == null ? null : requireText(attempt.provider, "payment_provider_invalid", 100),
      providerReference: attempt.providerReference == null ? null : requireText(attempt.providerReference, "payment_provider_reference_invalid", 200),
      tendered, applied, change,
      cashSessionId: attempt.cashSessionId ?? null,
      allocations,
    };
  });
  if (!attempts.some((attempt) => attempt.methodType === "cash") || !attempts.some((attempt) => attempt.methodType !== "cash")) {
    throw failure("split_payment_plan_cash_and_cashless_required");
  }
  return { ...scope, operationKey, businessDate, attempts, createdAt: requireIso(command.createdAt, "payment_plan_created_at_required") };
}

function validateAllocations(value) {
  if (!Array.isArray(value) || value.length === 0) throw failure("payment_allocations_required");
  return value.map((row) => ({
    id: requireText(row.id, "payment_allocation_id_required", 100),
    billId: requireText(row.billId, "payment_bill_id_required", 100),
    applied: positiveInteger(row.applied, "payment_allocation_invalid"),
  }));
}

function validateProviderSuccess(command) {
  return {
    ...validateScope(command),
    paymentAttemptId: requireText(command.paymentAttemptId, "payment_attempt_id_required", 100),
    eventId: requireText(command.eventId, "provider_event_id_required", 100),
    operationKey: requireText(command.operationKey, "provider_operation_key_required", 160),
    provider: requireText(command.provider, "payment_provider_required", 100),
    externalEventId: requireText(command.externalEventId, "provider_external_event_id_required", 200),
    occurredAt: requireIso(command.occurredAt ?? new Date().toISOString(), "provider_occurred_at_invalid"),
  };
}

function validateDispatch(command) {
  return {
    ...validateScope(command),
    paymentAttemptId: requireText(command.paymentAttemptId, "payment_attempt_id_required", 100),
    operationKey: requireText(command.operationKey, "provider_operation_key_required", 160),
    provider: requireText(command.provider, "payment_provider_required", 100),
    payload: jsonPayload(command.payload ?? {}),
  };
}

function validateScope(command) {
  return {
    organizationId: requireText(command?.organizationId, "organization_id_required", 100),
    outletId: requireText(command?.outletId, "outlet_id_required", 100),
    orderId: requireText(command?.orderId, "order_id_required", 100),
  };
}

function jsonPayload(value) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure("provider_payload_invalid"); }
  if (encoded == null || Buffer.byteLength(encoded, "utf8") > 8192 || /"[^"\r\n]*(?:password|secret|token|authorization|cookie|card)[^"\r\n]*"\s*:/iu.test(encoded)) {
    throw failure("provider_payload_invalid");
  }
  return JSON.parse(encoded);
}

function transactionView(tx) {
  return { query: (sql, params = []) => tx.query(sql, params), transaction: (work) => work(tx) };
}

function isoValue(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function requireIso(value, code) {
  const normalized = requireText(value, code, 40);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== normalized) throw failure(code);
  return normalized;
}

function deterministicUuid(scope) {
  const bytes = Buffer.from(createHash("sha256").update(`sagapos-esb-payment-runtime-v1:${scope}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireText(value, code, maximum) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/u.test(normalized)) throw failure(code);
  return normalized;
}

function safeText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum && !/[\u0000-\u001f]/u.test(value);
}

function integer(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(code);
  return value;
}

function failure(code, statusCode = 422, details = undefined) {
  const error = new EsbMoneyLedgerError(code, details);
  error.statusCode = statusCode;
  return error;
}
