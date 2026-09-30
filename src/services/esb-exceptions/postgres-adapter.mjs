import { createHash, randomUUID } from "node:crypto";

import { EXCEPTION_KINDS, STOCK_DISPOSITIONS, exceptionError } from "./contract.mjs";
import { assertExceptionPermission } from "./permissions.mjs";

const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const REFUND_KINDS = new Set([EXCEPTION_KINDS.CASH_REFUND, EXCEPTION_KINDS.PROVIDER_REFUND]);

export function exceptionRuntimeFingerprint(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function createEsbExceptionPostgresAdapter({ db, now = () => new Date().toISOString(), idFactory = randomUUID, faultInjector = async () => {} } = {}) {
  if (!db?.query || !db?.transaction) throw exceptionError("exception_postgres_database_required");

  return Object.freeze({
    async registerReasonMaster(master) {
      validateReasonMaster(master);
      return db.transaction(async (tx) => {
        const inserted = await tx.query(
          `insert into sagaops.esb_exception_reason_versions
            (id,version,organization_id,outlet_id,code,label,permitted_kinds,active,requires_note,effective_from,effective_until)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (organization_id,id,version) do nothing returning id`,
          [master.id, master.version, master.organizationId, master.outletId, master.code, master.label,
            master.permittedKinds, master.active, master.requiresNote, master.effectiveFrom, master.effectiveUntil],
        );
        if (!inserted.rows[0]) {
          const existing = await tx.query(
            `select outlet_id,code,label,permitted_kinds,active,requires_note,effective_from,effective_until
               from sagaops.esb_exception_reason_versions where organization_id=$1 and id=$2 and version=$3`,
            [master.organizationId, master.id, master.version],
          );
          const row = existing.rows[0];
          if (!row || exceptionRuntimeFingerprint(reasonRow(row)) !== exceptionRuntimeFingerprint(reasonShape(master))) {
            throw conflict("reason_version_reused_with_different_definition");
          }
        }
        return { replay: !inserted.rows[0], id: master.id, version: master.version };
      });
    },

    async registerPeriod({ organizationId, outletId, businessDate, state, closeId = null, expectedRevision = 0 }) {
      required(organizationId, "organization_id_required");
      required(outletId, "outlet_id_required");
      requiredDate(businessDate, "business_date_invalid");
      if (!["OPEN", "CLOSED", "LOCKED"].includes(state)) throw exceptionError("period_state_invalid");
      if (state !== "OPEN") required(closeId, "period_close_id_required");
      return db.transaction(async (tx) => {
        const inserted = await tx.query(
          `insert into sagaops.esb_exception_periods
            (organization_id,outlet_id,business_date,state,close_id,revision,updated_at)
           select $1,$2,$3,$4,$5,1,$6
            where $7::integer=0
              and exists(select 1 from sagaops.outlets where organization_id=$1 and id=$2)
           on conflict (organization_id,outlet_id,business_date) do nothing returning revision`,
          [organizationId, outletId, businessDate, state, closeId, now(), expectedRevision],
        );
        if (inserted.rows[0]) return { revision: 1 };
        const updated = await tx.query(
          `update sagaops.esb_exception_periods
              set state=$4,close_id=$5,revision=revision+1,updated_at=$6
            where organization_id=$1 and outlet_id=$2 and business_date=$3 and revision=$7
            returning revision`,
          [organizationId, outletId, businessDate, state, closeId, now(), expectedRevision],
        );
        if (!updated.rows[0]) throw conflict("exception_period_version_conflict");
        return { revision: Number(updated.rows[0].revision) };
      });
    },

    async persistAuthorization({ approval, authorization }) {
      validateApprovalAuthorization(approval, authorization);
      return db.transaction(async (tx) => {
        const approvalInsert = await tx.query(
          `insert into sagaops.esb_exception_approvals
            (id,organization_id,outlet_id,action_type,entity_type,entity_id,requested_by_user_id,
             approved_by_user_id,approved_by_role,status,approved_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'APPROVED',$10)
           on conflict (organization_id,id) do nothing returning id`,
          [approval.id, approval.organizationId, approval.outletId, approval.actionType, approval.entityType,
            approval.entityId, approval.requestedByUserId, approval.approvedByUserId, approval.approvedByRole,
            approval.approvedAt],
        );
        if (!approvalInsert.rows[0]) await assertStoredApproval(tx, approval);
        const authorizationInsert = await tx.query(
          `insert into sagaops.esb_action_authorizations
            (id,organization_id,outlet_id,approval_id,action_type,resource_type,resource_id,executor_user_id,
             executor_role,binding_hash,status,issued_at,expires_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AVAILABLE',$11,$12)
           on conflict (organization_id,id) do nothing returning id`,
          [authorization.id, authorization.organizationId, authorization.outletId, authorization.approvalId,
            authorization.kind, authorization.resourceType, authorization.resourceId, authorization.executorUserId,
            authorization.executorRole, authorization.bindingHash, authorization.issuedAt, authorization.expiresAt],
        );
        if (!authorizationInsert.rows[0]) await assertStoredAuthorization(tx, authorization);
        return { replay: !authorizationInsert.rows[0], authorizationId: authorization.id };
      });
    },

    async execute({ decision, actor, businessDate, expectedResourceVersion = 0, refund = null, reclassification = null, cash = null, applyBusinessEffect = null }) {
      validateDecision(decision, actor, businessDate, expectedResourceVersion);
      if (applyBusinessEffect != null && typeof applyBusinessEffect !== "function") throw exceptionError("exception_business_effect_adapter_invalid");
      const requestFingerprint = exceptionRuntimeFingerprint({ decision, businessDate, expectedResourceVersion, refund, reclassification, cash });
      const eventId = idFactory();
      return db.transaction(async (tx) => {
        const claim = await claimOperation(tx, decision.event, requestFingerprint);
        if (claim.replay) return { replay: true, eventId: claim.eventId, resourceVersion: claim.resourceVersion };

        await assertDurableReason(tx, decision.event);
        await assertDurablePeriod(tx, { event: decision.event, businessDate, periodDecision: decision.periodDecision });
        if (decision.authorizationDecision) await consumeAuthorizationCas(tx, decision, now());

        const resourceVersion = await advanceResourceVersion(tx, decision.event, expectedResourceVersion);
        await tx.query(
          `insert into sagaops.esb_exception_events
            (id,organization_id,outlet_id,exception_kind,resource_type,resource_id,resource_version,operation_key,
             actor_user_id,actor_role_snapshot,reason_id,reason_version,authorization_id,before_snapshot,
             after_snapshot,effect_snapshot,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17)`,
          [eventId, decision.event.organizationId, decision.event.outletId, kindFromEvent(decision.event),
            decision.event.resourceType, decision.event.resourceId, resourceVersion, decision.event.operationKey,
            decision.event.actorUserId, decision.event.actorRoleSnapshot, decision.event.reason.reasonId,
            decision.event.reason.reasonVersion, decision.authorizationDecision?.authorization.id ?? null,
            safeJson(decision.event.before), safeJson(decision.event.after), safeJson(decision.event.effect),
            decision.event.occurredAt],
        );

        const kind = kindFromEvent(decision.event);
        if (kind === EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION || kind === EXCEPTION_KINDS.VOID_POST_PRODUCTION) {
          await persistStockDisposition(tx, { eventId, event: decision.event, idFactory });
        }
        if (REFUND_KINDS.has(kind)) {
          await persistRefund(tx, { eventId, event: decision.event, kind, refund, cash, idFactory });
        }
        if (kind === EXCEPTION_KINDS.PAYMENT_RECLASSIFICATION) {
          await persistReclassification(tx, { eventId, event: decision.event, reclassification, idFactory });
        }
        if (applyBusinessEffect) {
          await applyBusinessEffect(tx, {
            eventId,
            kind,
            event: decision.event,
            resourceVersion,
          });
        }

        await tx.query(
          `insert into sagaops.esb_exception_audit_events
            (id,organization_id,outlet_id,exception_event_id,actor_user_id,actor_role_snapshot,action,
             entity_type,entity_id,old_values,new_values,metadata,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
          [idFactory(), decision.audit.organizationId, decision.audit.outletId, eventId,
            decision.audit.actorUserId, decision.audit.roleSnapshot, decision.audit.action,
            decision.audit.entityType, decision.audit.entityId, safeJson(decision.audit.oldValues),
            safeJson(decision.audit.newValues), safeJson(decision.audit.metadata), decision.audit.createdAt],
        );
        await faultInjector("before_exception_commit", { tx, eventId, kind });
        await tx.query(
          `update sagaops.esb_exception_operations set result_event_id=$3
            where organization_id=$1 and operation_key=$2`,
          [decision.event.organizationId, decision.event.operationKey, eventId],
        );
        return { replay: false, eventId, resourceVersion };
      });
    },
  });
}

async function claimOperation(tx, event, fingerprint) {
  const kind = kindFromEvent(event);
  const inserted = await tx.query(
    `insert into sagaops.esb_exception_operations
      (organization_id,outlet_id,operation_key,exception_kind,resource_type,resource_id,request_fingerprint)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (organization_id,operation_key) do nothing returning operation_key`,
    [event.organizationId, event.outletId, event.operationKey, kind, event.resourceType, event.resourceId, fingerprint],
  );
  if (inserted.rows[0]) return { replay: false };
  const result = await tx.query(
    `select operation.outlet_id,operation.exception_kind,operation.resource_type,operation.resource_id,
            operation.request_fingerprint,operation.result_event_id,event.resource_version
       from sagaops.esb_exception_operations operation
       left join sagaops.esb_exception_events event on event.id=operation.result_event_id
      where operation.organization_id=$1 and operation.operation_key=$2`,
    [event.organizationId, event.operationKey],
  );
  const row = result.rows[0];
  if (!row || row.outlet_id !== event.outletId || row.exception_kind !== kind || row.resource_type !== event.resourceType
    || row.resource_id !== event.resourceId || row.request_fingerprint !== fingerprint || !row.result_event_id) {
    throw conflict("exception_operation_key_reused_with_different_command");
  }
  return { replay: true, eventId: row.result_event_id, resourceVersion: Number(row.resource_version) };
}

async function assertDurableReason(tx, event) {
  const reason = event.reason;
  const result = await tx.query(
    `select outlet_id,code,label,permitted_kinds,active,requires_note,effective_from,effective_until
       from sagaops.esb_exception_reason_versions
      where organization_id=$1 and id=$2 and version=$3`,
    [event.organizationId, reason.reasonId, reason.reasonVersion],
  );
  const row = result.rows[0];
  const occurredAt = new Date(event.occurredAt).getTime();
  if (!row || !row.active || (row.outlet_id !== null && row.outlet_id !== event.outletId)
    || !row.permitted_kinds.includes(kindFromEvent(event)) || row.code !== reason.code || row.label !== reason.label
    || occurredAt < new Date(row.effective_from).getTime()
    || (row.effective_until && occurredAt >= new Date(row.effective_until).getTime())
    || (row.requires_note && !reason.note)) throw exceptionError("exception_reason_durable_check_failed");
}

async function assertDurablePeriod(tx, { event, businessDate, periodDecision }) {
  const result = await tx.query(
    `select state,close_id from sagaops.esb_exception_periods
      where organization_id=$1 and outlet_id=$2 and business_date=$3 for update`,
    [event.organizationId, event.outletId, businessDate],
  );
  const row = result.rows[0];
  if (!row || row.state !== periodDecision.state) throw exceptionError("exception_period_durable_check_failed");
  if (row.state === "OPEN" && periodDecision.override !== false) throw exceptionError("exception_period_override_invalid");
  if (row.state !== "OPEN" && (!periodDecision.override || row.close_id !== periodDecision.closeId)) {
    throw exceptionError("exception_period_override_invalid");
  }
}

async function consumeAuthorizationCas(tx, decision, consumedAt) {
  const auth = decision.authorizationDecision.authorization;
  const event = decision.event;
  const result = await tx.query(
    `update sagaops.esb_action_authorizations authz
        set status='CONSUMED',consumed_at=$8,consumed_operation_key=$7
       from sagaops.esb_exception_approvals approval
      where authz.organization_id=$1 and authz.outlet_id=$2 and authz.id=$3
        and authz.status='AVAILABLE' and authz.binding_hash=$4
        and authz.action_type=$5 and authz.resource_type=$6
        and authz.resource_id=$9 and authz.executor_user_id=$10
        and authz.approval_id=approval.id and approval.organization_id=authz.organization_id
        and approval.outlet_id=authz.outlet_id
        and approval.status='APPROVED' and approval.action_type=authz.action_type
        and approval.entity_type=authz.resource_type and approval.entity_id=authz.resource_id
        and approval.requested_by_user_id<>approval.approved_by_user_id
        and approval.approved_by_user_id<>authz.executor_user_id
        and authz.expires_at>$8::timestamptz
      returning authz.id`,
    [event.organizationId, event.outletId, auth.id, auth.bindingHash, kindFromEvent(event), event.resourceType,
      event.operationKey, consumedAt, event.resourceId, event.actorUserId],
  );
  if (!result.rows[0]) throw conflict("action_authorization_compare_and_set_failed");
}

async function advanceResourceVersion(tx, event, expectedVersion) {
  await tx.query(
    `insert into sagaops.esb_exception_resource_versions
      (organization_id,outlet_id,resource_type,resource_id,current_version)
     values ($1,$2,$3,$4,0) on conflict (organization_id,resource_type,resource_id) do nothing`,
    [event.organizationId, event.outletId, event.resourceType, event.resourceId],
  );
  const updated = await tx.query(
    `update sagaops.esb_exception_resource_versions
        set current_version=current_version+1,updated_at=$6
      where organization_id=$1 and outlet_id=$2 and resource_type=$3 and resource_id=$4 and current_version=$5
      returning current_version`,
    [event.organizationId, event.outletId, event.resourceType, event.resourceId, expectedVersion, event.occurredAt],
  );
  if (!updated.rows[0]) throw conflict("exception_resource_version_conflict");
  return Number(updated.rows[0].current_version);
}

async function persistStockDisposition(tx, { eventId, event, idFactory }) {
  const kind = kindFromEvent(event);
  const disposition = kind === EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION ? "NO_STOCK_CHANGE" : event.effect.stockDisposition;
  if (!STOCK_DISPOSITIONS.includes(disposition)) throw exceptionError("void_stock_disposition_required");
  await tx.query(
    `insert into sagaops.esb_exception_stock_dispositions
      (id,organization_id,outlet_id,exception_event_id,disposition,reservation_disposition,automatic_stock_return)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [idFactory(), event.organizationId, event.outletId, eventId, disposition,
      event.effect.reservationDisposition ?? null, event.effect.automaticStockReturn === true],
  );
}

async function persistRefund(tx, { eventId, event, kind, refund, cash, idFactory }) {
  if (!refund || !Array.isArray(refund.lines) || refund.lines.length === 0) throw exceptionError("refund_runtime_lines_required");
  required(refund.id, "refund_id_required");
  required(refund.paymentAttemptId, "refund_payment_attempt_id_required");
  required(refund.billId, "refund_bill_id_required");
  const paymentResult = await tx.query(
    `select id,status,verification_level,applied_rupiah from sagaops.esb_payment_attempts
      where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
    [refund.paymentAttemptId, event.organizationId, event.outletId],
  );
  const payment = paymentResult.rows[0];
  if (!payment || payment.status !== "SUCCEEDED") throw exceptionError("refund_source_payment_not_succeeded");
  if (kind === EXCEPTION_KINDS.CASH_REFUND && payment.verification_level !== "CASH") {
    throw exceptionError("cash_refund_requires_cash_payment");
  }

  let requested = 0;
  const normalized = [];
  const lockedAllocations = new Map();
  for (const input of refund.lines) {
    required(input.billLineId, "refund_bill_line_id_required");
    required(input.paymentAllocationId, "refund_payment_allocation_id_required");
    const components = refundComponents(input);
    requested = checkedAdd(requested, components.total);
    if (!lockedAllocations.has(input.paymentAllocationId)) {
      const allocationResult = await tx.query(
        `select id,bill_id,payment_attempt_id,applied_rupiah from sagaops.esb_bill_payment_allocations
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [input.paymentAllocationId, event.organizationId, event.outletId],
      );
      const allocation = allocationResult.rows[0];
      if (!allocation || allocation.bill_id !== refund.billId || allocation.payment_attempt_id !== refund.paymentAttemptId) {
        throw exceptionError("refund_original_payment_allocation_scope_mismatch");
      }
      lockedAllocations.set(input.paymentAllocationId, allocation);
    }
    const lineResult = await tx.query(
      `select id,bill_id,net_menu_rupiah,tax_rupiah,service_rupiah,customer_fee_rupiah,
              rounding_adjustment_rupiah,total_rupiah,policy_snapshot
         from sagaops.esb_bill_lines
        where id=$1 and organization_id=$2 and outlet_id=$3 and bill_id=$4 for update`,
      [input.billLineId, event.organizationId, event.outletId, refund.billId],
    );
    const original = lineResult.rows[0];
    if (!original) throw exceptionError("refund_original_bill_line_scope_mismatch");
    const historyResult = await tx.query(
      `select coalesce(sum(net_rupiah),0)::bigint net,coalesce(sum(tax_rupiah),0)::bigint tax,
              coalesce(sum(service_rupiah),0)::bigint service,coalesce(sum(customer_fee_rupiah),0)::bigint customer_fee,
              coalesce(sum(rounding_rupiah),0)::bigint rounding,coalesce(sum(total_rupiah),0)::bigint total
         from sagaops.esb_refund_lines where bill_line_id=$1`,
      [input.billLineId],
    );
    assertOriginalComponentBounds(original, historyResult.rows[0], components);
    normalized.push({ input, components, original });
  }
  const allocationIds = [...lockedAllocations.keys()];
  for (const allocationId of allocationIds) {
    const history = await tx.query(
      "select coalesce(sum(total_rupiah),0)::bigint total from sagaops.esb_refund_lines where payment_allocation_id=$1",
      [allocationId],
    );
    const current = normalized.filter((line) => line.input.paymentAllocationId === allocationId)
      .reduce((sum, line) => checkedAdd(sum, line.components.total), 0);
    if (Number(history.rows[0].total) + current > Number(lockedAllocations.get(allocationId).applied_rupiah)) {
      throw exceptionError("refund_exceeds_original_payment_allocation");
    }
  }
  if (requested !== event.effect.refundPlan?.requestedAmountRupiah) throw exceptionError("refund_plan_runtime_amount_mismatch");

  const status = kind === EXCEPTION_KINDS.PROVIDER_REFUND ? "RECONCILIATION_PENDING" : "REQUESTED";
  await tx.query(
    `insert into sagaops.esb_refund_requests
      (id,organization_id,outlet_id,exception_event_id,payment_attempt_id,bill_id,refund_kind,status,requested_rupiah,funds_returned)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
    [refund.id, event.organizationId, event.outletId, eventId, refund.paymentAttemptId, refund.billId, kind, status, requested],
  );
  for (const { input, components, original } of normalized) {
    await tx.query(
      `insert into sagaops.esb_refund_lines
        (id,organization_id,outlet_id,refund_request_id,bill_line_id,payment_allocation_id,net_rupiah,
         tax_rupiah,service_rupiah,customer_fee_rupiah,rounding_rupiah,total_rupiah,original_allocation_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [input.id ?? idFactory(), event.organizationId, event.outletId, refund.id, input.billLineId,
        input.paymentAllocationId, components.net, components.tax, components.service, components.customerFee,
        components.rounding, components.total, safeJson({ source: "ORIGINAL_BILL_LINE_ALLOCATION", usesCurrentCatalog: false,
          billLineId: original.id, paymentAllocationId: input.paymentAllocationId, policySnapshot: original.policy_snapshot })],
    );
  }
  if (kind === EXCEPTION_KINDS.PROVIDER_REFUND) {
    await tx.query(
      `insert into sagaops.esb_provider_refund_work_items
        (id,organization_id,outlet_id,refund_request_id,status,provider_call_enabled)
       values ($1,$2,$3,$4,'RECONCILIATION_PENDING',false)`,
      [refund.workItemId ?? idFactory(), event.organizationId, event.outletId, refund.id],
    );
  } else {
    required(cash?.businessDate, "cash_refund_business_date_required");
    await tx.query(
      `insert into sagaops.esb_cash_movements
        (id,organization_id,outlet_id,cash_session_id,payment_attempt_id,movement_type,amount_rupiah,business_date,occurred_at,note)
       values ($1,$2,$3,$4,$5,'REFUND',$6,$7,$8,'Gate 3 original-allocation cash refund')`,
      [cash.id ?? idFactory(), event.organizationId, event.outletId, cash.cashSessionId ?? null,
        refund.paymentAttemptId, -requested, cash.businessDate, event.occurredAt],
    );
  }
}

async function persistReclassification(tx, { eventId, event, reclassification, idFactory }) {
  if (!reclassification) throw exceptionError("payment_reclassification_runtime_required");
  const payment = await tx.query(
    `select id,status,method_type,applied_rupiah from sagaops.esb_payment_attempts
      where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
    [reclassification.paymentAttemptId, event.organizationId, event.outletId],
  );
  const row = payment.rows[0];
  if (!row || row.status !== "SUCCEEDED") throw exceptionError("payment_reclassification_source_invalid");
  const amount = Number(row.applied_rupiah);
  const fromMethodId = required(reclassification.fromMethodId, "payment_reclassification_source_method_required");
  const toMethodId = required(reclassification.toMethodId, "payment_reclassification_target_method_required");
  if (fromMethodId !== row.method_type || fromMethodId === toMethodId || reclassification.amountRupiah !== amount) {
    throw exceptionError("payment_reclassification_runtime_mismatch");
  }
  const entries = event.effect.ledgerEntries;
  if (!Array.isArray(entries) || entries.length !== 2
    || entries.reduce((sum, entry) => checkedAdd(sum, entry.signedAmountRupiah), 0) !== 0
    || entries[0].signedAmountRupiah !== -amount || entries[1].signedAmountRupiah !== amount) {
    throw exceptionError("payment_reclassification_net_zero_required");
  }
  const id = reclassification.id ?? idFactory();
  await tx.query(
    `insert into sagaops.esb_payment_reclassifications
      (id,organization_id,outlet_id,exception_event_id,payment_attempt_id,from_method_id,to_method_id,amount_rupiah)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, event.organizationId, event.outletId, eventId, reclassification.paymentAttemptId, fromMethodId, toMethodId, amount],
  );
  await tx.query(
    `insert into sagaops.esb_payment_reclassification_entries
      (id,organization_id,outlet_id,reclassification_id,entry_kind,method_id,signed_amount_rupiah)
     values ($1,$2,$3,$4,'REVERSAL',$5,$6),($7,$2,$3,$4,'APPLY',$8,$9)`,
    [idFactory(), event.organizationId, event.outletId, id, fromMethodId, -amount, idFactory(), toMethodId, amount],
  );
}

function assertOriginalComponentBounds(original, history, requested) {
  const checks = [
    ["net", "net_menu_rupiah"], ["tax", "tax_rupiah"], ["service", "service_rupiah"],
    ["customerFee", "customer_fee_rupiah"], ["total", "total_rupiah"],
  ];
  for (const [requestedKey, originalKey] of checks) {
    const historyKey = requestedKey === "customerFee" ? "customer_fee" : requestedKey;
    if (Number(history[historyKey]) + requested[requestedKey] > Number(original[originalKey])) {
      throw exceptionError("refund_exceeds_original_bill_line_component", { component: requestedKey });
    }
  }
  const originalRounding = Number(original.rounding_adjustment_rupiah);
  const usedRounding = Number(history.rounding);
  if (originalRounding === 0 && requested.rounding !== 0) throw exceptionError("refund_rounding_source_mismatch");
  if (originalRounding !== 0 && Math.sign(requested.rounding || originalRounding) !== Math.sign(originalRounding)) {
    throw exceptionError("refund_rounding_source_mismatch");
  }
  if (Math.abs(usedRounding + requested.rounding) > Math.abs(originalRounding)) {
    throw exceptionError("refund_exceeds_original_bill_line_component", { component: "rounding" });
  }
}

function refundComponents(input) {
  const result = {
    net: amount(input.netRupiah ?? 0, "refund_net_invalid", true),
    tax: amount(input.taxRupiah ?? 0, "refund_tax_invalid", true),
    service: amount(input.serviceRupiah ?? 0, "refund_service_invalid", true),
    customerFee: amount(input.customerFeeRupiah ?? 0, "refund_customer_fee_invalid", true),
    rounding: amount(input.roundingRupiah ?? 0, "refund_rounding_invalid", false),
  };
  result.total = checkedAdd(checkedAdd(checkedAdd(result.net, result.tax), checkedAdd(result.service, result.customerFee)), result.rounding);
  if (result.total <= 0 || input.totalRupiah !== result.total) throw exceptionError("refund_line_total_invalid");
  return result;
}

function validateReasonMaster(master) {
  if (!master || !Number.isSafeInteger(master.version) || master.version <= 0 || !Array.isArray(master.permittedKinds)) {
    throw exceptionError("reason_master_invalid");
  }
  for (const key of ["id", "organizationId", "code", "label", "effectiveFrom"]) required(master[key], `reason_master_${key}_required`);
}

function validateApprovalAuthorization(approval, authorization) {
  if (!approval || !authorization) throw exceptionError("approval_authorization_required");
  if (approval.status !== "APPROVED" || authorization.status !== "AVAILABLE" || !["owner", "manager"].includes(approval.approvedByRole)) {
    throw exceptionError("approval_authorization_state_invalid");
  }
  if (approval.organizationId !== authorization.organizationId || approval.outletId !== authorization.outletId
    || approval.id !== authorization.approvalId || approval.actionType !== authorization.kind
    || approval.entityType !== authorization.resourceType || approval.entityId !== authorization.resourceId
    || approval.requestedByUserId !== authorization.requestedByUserId || approval.approvedByUserId !== authorization.approvedByUserId
    || approval.approvedByUserId === authorization.executorUserId) throw exceptionError("approval_authorization_binding_mismatch");
}

function validateDecision(decision, actor, businessDate, expectedResourceVersion) {
  if (!decision?.event || !decision?.audit || !decision?.periodDecision) throw exceptionError("exception_decision_required");
  requiredDate(businessDate, "business_date_invalid");
  if (!Number.isSafeInteger(expectedResourceVersion) || expectedResourceVersion < 0) throw exceptionError("exception_expected_version_invalid");
  if (decision.event.organizationId !== decision.audit.organizationId || decision.event.outletId !== decision.audit.outletId) {
    throw exceptionError("exception_audit_scope_mismatch");
  }
  const permission = assertExceptionPermission({
    actor,
    organizationId: decision.event.organizationId,
    outletId: decision.event.outletId,
    kind: kindFromEvent(decision.event),
    capability: "EXECUTE",
  });
  if (permission.actorId !== decision.event.actorUserId || permission.role !== decision.event.actorRoleSnapshot
    || decision.audit.actorUserId !== permission.actorId || decision.audit.roleSnapshot !== permission.role) {
    throw exceptionError("exception_execution_actor_snapshot_mismatch");
  }
}

async function assertStoredApproval(tx, approval) {
  const result = await tx.query(
    `select outlet_id,action_type,entity_type,entity_id,requested_by_user_id,approved_by_user_id,approved_by_role,status,approved_at
      from sagaops.esb_exception_approvals where organization_id=$1 and id=$2`, [approval.organizationId, approval.id]);
  const row = result.rows[0];
  const stored = row && {
    organizationId: approval.organizationId, outletId: row.outlet_id, actionType: row.action_type,
    entityType: row.entity_type, entityId: row.entity_id, requestedByUserId: row.requested_by_user_id,
    approvedByUserId: row.approved_by_user_id, approvedByRole: row.approved_by_role,
    status: row.status, approvedAt: iso(row.approved_at), id: approval.id,
  };
  if (!stored || exceptionRuntimeFingerprint(stored) !== exceptionRuntimeFingerprint({ ...approval, approvedAt: iso(approval.approvedAt) })) {
    throw conflict("approval_id_reused_with_different_definition");
  }
}

async function assertStoredAuthorization(tx, authorization) {
  const result = await tx.query(
    `select outlet_id,approval_id,action_type,resource_type,resource_id,executor_user_id,executor_role,binding_hash,
            status,issued_at,expires_at,consumed_at,consumed_operation_key
       from sagaops.esb_action_authorizations where organization_id=$1 and id=$2`,
    [authorization.organizationId, authorization.id],
  );
  const row = result.rows[0];
  if (!row || row.outlet_id !== authorization.outletId || row.approval_id !== authorization.approvalId
    || row.action_type !== authorization.kind || row.resource_type !== authorization.resourceType
    || row.resource_id !== authorization.resourceId || row.executor_user_id !== authorization.executorUserId
    || row.executor_role !== authorization.executorRole || row.binding_hash !== authorization.bindingHash
    || !["AVAILABLE", "CONSUMED"].includes(row.status) || iso(row.issued_at) !== iso(authorization.issuedAt)
    || iso(row.expires_at) !== iso(authorization.expiresAt)) throw conflict("authorization_id_reused_with_different_definition");
}

function reasonShape(master) {
  return { outletId: master.outletId, code: master.code, label: master.label, permittedKinds: [...master.permittedKinds].sort(),
    active: master.active, requiresNote: master.requiresNote, effectiveFrom: iso(master.effectiveFrom), effectiveUntil: iso(master.effectiveUntil) };
}
function reasonRow(row) {
  return { outletId: row.outlet_id, code: row.code, label: row.label, permittedKinds: [...row.permitted_kinds].sort(),
    active: row.active, requiresNote: row.requires_note, effectiveFrom: iso(row.effective_from), effectiveUntil: iso(row.effective_until) };
}
function kindFromEvent(event) { return String(event.eventType).replace(/^EXCEPTION_/, ""); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function required(value, code) { if (typeof value !== "string" || !value.trim()) throw exceptionError(code); return value.trim(); }
function requiredDate(value, code) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw exceptionError(code); }
function amount(value, code, nonNegative) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT || (nonNegative && value < 0)) throw exceptionError(code);
  return value;
}
function checkedAdd(left, right) { const result = left + right; if (!Number.isSafeInteger(result)) throw exceptionError("exception_amount_overflow"); return result; }
function safeJson(value) {
  const body = JSON.stringify(value ?? {});
  if (Buffer.byteLength(body, "utf8") > 16384) throw exceptionError("exception_snapshot_too_large");
  if (/"(?:password|secret|access[_-]?token|refresh[_-]?token|authorization|cookie|card[_-]?(?:number|pan)|raw[_-]?(?:body|callback))"\s*:/i.test(body)) {
    throw exceptionError("exception_sensitive_snapshot_key_rejected");
  }
  return body;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function conflict(code) { const error = exceptionError(code); error.statusCode = 409; return error; }
