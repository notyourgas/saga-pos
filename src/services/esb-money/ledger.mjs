import { createHash, randomUUID } from "node:crypto";

const CONTRACT_VERSION = "SAGAPOS_ESB_TRANSACTION_REPORTING_V1";
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const PAYMENT_TRANSITIONS = new Set([
  "CREATED->PENDING", "CREATED->SUCCEEDED", "CREATED->FAILED", "CREATED->EXPIRED",
  "PENDING->PENDING", "PENDING->SUCCEEDED", "PENDING->FAILED", "PENDING->EXPIRED", "SUCCEEDED->REVERSED",
]);

export class EsbMoneyLedgerError extends Error {
  constructor(code, detail = undefined) {
    super(code);
    this.name = "EsbMoneyLedgerError";
    this.code = code;
    this.detail = detail;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function moneyLedgerFingerprint(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function amount(value, field, { nonNegative = false, nonZero = false } = {}) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT) throw new EsbMoneyLedgerError("amount_out_of_range", field);
  if (nonNegative && value < 0) throw new EsbMoneyLedgerError("amount_must_be_non_negative", field);
  if (nonZero && value === 0) throw new EsbMoneyLedgerError("amount_must_be_non_zero", field);
  return value;
}

function required(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new EsbMoneyLedgerError("required_field", field);
  return value;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + amount(row[field], field), 0);
}

function validateScope(command) {
  required(command.organizationId, "organizationId");
  required(command.outletId, "outletId");
  required(command.operationKey, "operationKey");
}

function redactedPayload(value) {
  const body = JSON.stringify(value ?? {});
  if (Buffer.byteLength(body, "utf8") > 8192) throw new EsbMoneyLedgerError("redacted_payload_too_large");
  if (/"(?:password|secret|access[_-]?token|refresh[_-]?token|authorization|cookie|card[_-]?(?:number|pan)|raw[_-]?(?:body|callback))"\s*:/i.test(body)) {
    throw new EsbMoneyLedgerError("sensitive_payload_key_rejected");
  }
  return body;
}

async function claimOperation(tx, { organizationId, outletId, operationKey, operationType, aggregateId, fingerprint }) {
  const inserted = await tx.query(
    `insert into sagaops.esb_money_operations
      (organization_id,outlet_id,operation_key,operation_type,aggregate_id,request_fingerprint)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (organization_id,operation_key) do nothing
     returning operation_type,aggregate_id,request_fingerprint`,
    [organizationId, outletId, operationKey, operationType, aggregateId, fingerprint],
  );
  if (inserted.rows[0]) return { replay: false };
  const existing = await tx.query(
    `select outlet_id,operation_type,aggregate_id,request_fingerprint
       from sagaops.esb_money_operations
      where organization_id=$1 and operation_key=$2`,
    [organizationId, operationKey],
  );
  const row = existing.rows[0];
  if (!row || row.outlet_id !== outletId || row.operation_type !== operationType || row.aggregate_id !== aggregateId || row.request_fingerprint !== fingerprint) {
    throw new EsbMoneyLedgerError("operation_key_reused_with_different_command", operationKey);
  }
  return { replay: true };
}

async function assertOrderScope(tx, { orderId, organizationId, outletId }) {
  const result = await tx.query(
    "select id from sagaops.orders where id=$1 and organization_id=$2 and outlet_id=$3",
    [orderId, organizationId, outletId],
  );
  if (!result.rows[0]) throw new EsbMoneyLedgerError("order_scope_mismatch", orderId);
}

async function loadBill(tx, billId) {
  const result = await tx.query(
    `select id,organization_id,outlet_id,order_id,bill_number,status,settlement_policy,
            menu_gross_rupiah,line_discount_rupiah,bill_discount_rupiah,net_menu_rupiah,
            tax_rupiah,service_rupiah,customer_fee_rupiah,rounding_adjustment_rupiah,total_rupiah
       from sagaops.esb_bills where id=$1`,
    [billId],
  );
  return result.rows[0];
}

function validateBill(command) {
  validateScope(command);
  required(command.id, "id");
  required(command.orderId, "orderId");
  required(command.billNumber, "billNumber");
  if (!Array.isArray(command.lines) || command.lines.length === 0) throw new EsbMoneyLedgerError("bill_lines_required");
  const fields = ["menuGross", "lineDiscount", "billDiscount", "netMenu", "tax", "service", "customerFee", "roundingAdjustment", "total"];
  for (const field of fields) amount(command[field], field, { nonNegative: !["roundingAdjustment"].includes(field) });
  if (command.netMenu !== command.menuGross - command.lineDiscount - command.billDiscount) throw new EsbMoneyLedgerError("bill_net_invariant_failed");
  if (command.total !== command.netMenu + command.tax + command.service + command.customerFee + command.roundingAdjustment) throw new EsbMoneyLedgerError("bill_total_invariant_failed");
  if (command.settlementPolicy === "COMPLIMENTARY" && command.total !== 0) throw new EsbMoneyLedgerError("complimentary_bill_must_be_zero");
  for (const line of command.lines) {
    required(line.id, "line.id");
    required(line.stableLineId, "line.stableLineId");
    required(line.itemNameSnapshot, "line.itemNameSnapshot");
    if (!/^-?\d+\.\d{6}$/.test(line.quantity) || Number(line.quantity) <= 0) throw new EsbMoneyLedgerError("quantity_scale_invalid", line.stableLineId);
    for (const field of fields) amount(line[field], `line.${field}`, { nonNegative: !["roundingAdjustment"].includes(field) });
    if (line.netMenu !== line.menuGross - line.lineDiscount - line.billDiscount) throw new EsbMoneyLedgerError("bill_line_net_invariant_failed", line.stableLineId);
    if (line.total !== line.netMenu + line.tax + line.service + line.customerFee + line.roundingAdjustment) throw new EsbMoneyLedgerError("bill_line_total_invariant_failed", line.stableLineId);
  }
  for (const field of fields) {
    if (sum(command.lines, field) !== command[field]) throw new EsbMoneyLedgerError("bill_line_allocation_mismatch", field);
  }
}

export function createEsbMoneyLedger({ db, idFactory = randomUUID, now = () => new Date().toISOString() }) {
  if (!db?.transaction || !db?.query) throw new EsbMoneyLedgerError("database_adapter_required");

  return {
    async recordBill(command) {
      validateBill(command);
      const normalized = { ...command, operationKey: undefined };
      const fingerprint = moneyLedgerFingerprint(normalized);
      return db.transaction(async (tx) => {
        await assertOrderScope(tx, command);
        const claim = await claimOperation(tx, {
          ...command,
          operationType: "RECORD_BILL",
          aggregateId: command.id,
          fingerprint,
        });
        if (claim.replay) return { replay: true, bill: await loadBill(tx, command.id) };
        await tx.query(
          `insert into sagaops.esb_bills
            (id,organization_id,outlet_id,order_id,bill_number,status,settlement_policy,allocated_pax,
             menu_gross_rupiah,line_discount_rupiah,bill_discount_rupiah,net_menu_rupiah,tax_rupiah,
             service_rupiah,customer_fee_rupiah,rounding_adjustment_rupiah,total_rupiah,
             contract_version,pricing_policy_snapshot,allocation_completeness,source_kind,source_key,opened_at)
           values ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [command.id, command.organizationId, command.outletId, command.orderId, command.billNumber,
            command.settlementPolicy ?? "STANDARD", command.allocatedPax ?? 0, command.menuGross, command.lineDiscount,
            command.billDiscount, command.netMenu, command.tax, command.service, command.customerFee,
            command.roundingAdjustment, command.total, CONTRACT_VERSION, JSON.stringify(command.pricingPolicySnapshot ?? {}),
            command.allocationCompleteness ?? "COMPLETE", command.sourceKind ?? "NATIVE", command.sourceKey ?? null,
            command.openedAt ?? now()],
        );
        for (const line of command.lines) {
          await tx.query(
            `insert into sagaops.esb_bill_lines
              (id,organization_id,outlet_id,bill_id,order_item_id,stable_line_id,line_kind,item_reference,
               item_name_snapshot,quantity,unit_price_rupiah,menu_gross_rupiah,line_discount_rupiah,
               bill_discount_rupiah,net_menu_rupiah,tax_rupiah,service_rupiah,customer_fee_rupiah,
               rounding_adjustment_rupiah,total_rupiah,policy_snapshot,allocation_completeness)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [line.id, command.organizationId, command.outletId, command.id, line.orderItemId ?? null,
              line.stableLineId, line.lineKind ?? "MAIN", line.itemReference ?? null, line.itemNameSnapshot,
              line.quantity, line.unitPrice, line.menuGross, line.lineDiscount, line.billDiscount, line.netMenu,
              line.tax, line.service, line.customerFee, line.roundingAdjustment, line.total,
              JSON.stringify(line.policySnapshot ?? {}), line.allocationCompleteness ?? "COMPLETE"],
          );
        }
        for (const adjustment of command.adjustments ?? []) {
          amount(adjustment.amount, "adjustment.amount");
          await tx.query(
            `insert into sagaops.esb_bill_adjustments
              (id,organization_id,outlet_id,bill_id,bill_line_id,adjustment_kind,amount_rupiah,policy_reference,allocation_basis_rupiah)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [adjustment.id ?? idFactory(), command.organizationId, command.outletId, command.id,
              adjustment.billLineId ?? null, adjustment.kind, adjustment.amount, adjustment.policyReference ?? null,
              adjustment.allocationBasis ?? null],
          );
        }
        return { replay: false, bill: await loadBill(tx, command.id) };
      });
    },

    async recordPaymentAttempt(command) {
      validateScope(command);
      required(command.id, "id");
      required(command.orderId, "orderId");
      required(command.methodType, "methodType");
      required(command.methodNameSnapshot, "methodNameSnapshot");
      const verificationLevel = command.verificationLevel ?? "MANUAL";
      if (!new Set(["CASH", "MANUAL", "LEGACY_UNVERIFIED"]).has(verificationLevel)) {
        throw new EsbMoneyLedgerError("provider_verification_requires_external_event");
      }
      if (!Array.isArray(command.allocations) || command.allocations.length === 0) throw new EsbMoneyLedgerError("payment_allocations_required");
      amount(command.tendered, "tendered", { nonNegative: true });
      amount(command.applied, "applied", { nonNegative: true });
      amount(command.change, "change", { nonNegative: true });
      if (command.tendered !== command.applied + command.change) throw new EsbMoneyLedgerError("payment_tender_invariant_failed");
      if (sum(command.allocations, "applied") !== command.applied) throw new EsbMoneyLedgerError("payment_allocation_mismatch");
      const fingerprint = moneyLedgerFingerprint({ ...command, operationKey: undefined });
      return db.transaction(async (tx) => {
        await assertOrderScope(tx, command);
        for (const allocation of command.allocations) {
          const bill = await loadBill(tx, allocation.billId);
          if (!bill || bill.organization_id !== command.organizationId || bill.outlet_id !== command.outletId || bill.order_id !== command.orderId) {
            throw new EsbMoneyLedgerError("bill_scope_mismatch", allocation.billId);
          }
          if (["PAID", "VOIDED"].includes(bill.status)) throw new EsbMoneyLedgerError("bill_not_payable", allocation.billId);
        }
        const claim = await claimOperation(tx, { ...command, operationType: "RECORD_PAYMENT_ATTEMPT", aggregateId: command.id, fingerprint });
        if (claim.replay) return { replay: true, paymentAttemptId: command.id };
        await tx.query(
          `insert into sagaops.esb_payment_attempts
            (id,organization_id,outlet_id,order_id,status,method_type,method_name_snapshot,verification_level,
             provider,provider_reference,tendered_rupiah,applied_rupiah,change_rupiah,created_at,updated_at)
           values ($1,$2,$3,$4,'CREATED',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [command.id, command.organizationId, command.outletId, command.orderId, command.methodType,
            command.methodNameSnapshot, verificationLevel, command.provider ?? null,
            command.providerReference ?? null, command.tendered, command.applied, command.change, command.createdAt ?? now()],
        );
        for (const allocation of command.allocations) {
          await tx.query(
            `insert into sagaops.esb_bill_payment_allocations
              (id,organization_id,outlet_id,bill_id,payment_attempt_id,applied_rupiah)
             values ($1,$2,$3,$4,$5,$6)`,
            [allocation.id ?? idFactory(), command.organizationId, command.outletId, allocation.billId, command.id, allocation.applied],
          );
        }
        return { replay: false, paymentAttemptId: command.id };
      });
    },

    async applyPaymentEvent(command) {
      validateScope(command);
      required(command.id, "id");
      required(command.paymentAttemptId, "paymentAttemptId");
      required(command.targetStatus, "targetStatus");
      const eventInput = {
        paymentAttemptId: command.paymentAttemptId,
        provider: command.provider ?? null,
        externalEventId: command.externalEventId ?? null,
        eventType: command.eventType,
        targetStatus: command.targetStatus,
        payloadRedacted: command.payloadRedacted ?? {},
      };
      redactedPayload(eventInput.payloadRedacted);
      const fingerprint = moneyLedgerFingerprint(eventInput);
      return db.transaction(async (tx) => {
        const attemptResult = await tx.query(
          `select * from sagaops.esb_payment_attempts
            where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
          [command.paymentAttemptId, command.organizationId, command.outletId],
        );
        const attempt = attemptResult.rows[0];
        if (!attempt) throw new EsbMoneyLedgerError("payment_attempt_scope_mismatch", command.paymentAttemptId);
        if (command.externalEventId) {
          required(command.provider, "provider");
          const duplicate = await tx.query(
            `select id,payment_attempt_id,event_fingerprint,status_after
               from sagaops.esb_payment_events
              where organization_id=$1 and provider=$2 and external_event_id=$3`,
            [command.organizationId, command.provider, command.externalEventId],
          );
          if (duplicate.rows[0]) {
            const row = duplicate.rows[0];
            if (row.payment_attempt_id !== command.paymentAttemptId || row.event_fingerprint !== fingerprint) {
              throw new EsbMoneyLedgerError("provider_event_reused_with_different_payload", command.externalEventId);
            }
            return { replay: true, status: row.status_after };
          }
        }
        const claim = await claimOperation(tx, { ...command, operationType: "APPLY_PAYMENT_EVENT", aggregateId: command.id, fingerprint });
        if (claim.replay) return { replay: true, status: attempt.status };
        if (!PAYMENT_TRANSITIONS.has(`${attempt.status}->${command.targetStatus}`)) {
          throw new EsbMoneyLedgerError("payment_transition_invalid", `${attempt.status}->${command.targetStatus}`);
        }
        if (command.targetStatus === "REVERSED") throw new EsbMoneyLedgerError("payment_reversal_requires_gate_3");
        const occurredAt = command.occurredAt ?? now();
        if (command.targetStatus === "SUCCEEDED") {
          await tx.query(
            `select b.id
               from sagaops.esb_bills b
               join sagaops.esb_bill_payment_allocations a on a.bill_id=b.id
              where a.payment_attempt_id=$1
              order by b.id
              for update of b`,
            [command.paymentAttemptId],
          );
        }
        await tx.query(
          `insert into sagaops.esb_payment_events
            (id,organization_id,outlet_id,payment_attempt_id,provider,external_event_id,event_type,
             status_before,status_after,event_fingerprint,event_payload_redacted,occurred_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [command.id, command.organizationId, command.outletId, command.paymentAttemptId, command.provider ?? null,
            command.externalEventId ?? null, command.eventType ?? "STATUS_CHANGED", attempt.status, command.targetStatus,
            fingerprint, redactedPayload(command.payloadRedacted), occurredAt],
        );
        const providerVerified = command.targetStatus === "SUCCEEDED" && command.provider != null && command.externalEventId != null;
        await tx.query(
          `update sagaops.esb_payment_attempts
              set status=$2,updated_at=$3::timestamptz,
                  succeeded_at=case when $2='SUCCEEDED' then $3::timestamptz else succeeded_at end,
                  verification_level=case when $4 then 'PROVIDER_VERIFIED' else verification_level end
            where id=$1`,
          [command.paymentAttemptId, command.targetStatus, occurredAt, providerVerified],
        );
        if (command.targetStatus === "SUCCEEDED") {
          const allocations = await tx.query(
            `select bill_id,applied_rupiah from sagaops.esb_bill_payment_allocations where payment_attempt_id=$1`,
            [command.paymentAttemptId],
          );
          const applied = allocations.rows.reduce((total, row) => total + Number(row.applied_rupiah), 0);
          if (applied !== Number(attempt.applied_rupiah)) throw new EsbMoneyLedgerError("persisted_payment_allocation_mismatch");
          for (const allocation of allocations.rows) {
            const paid = await tx.query(
              `select coalesce(sum(a.applied_rupiah),0)::bigint as applied
                 from sagaops.esb_bill_payment_allocations a
                 join sagaops.esb_payment_attempts p on p.id=a.payment_attempt_id
                where a.bill_id=$1 and p.status='SUCCEEDED'`,
              [allocation.bill_id],
            );
            const bill = await loadBill(tx, allocation.bill_id);
            const paidAmount = Number(paid.rows[0].applied);
            if (paidAmount > Number(bill.total_rupiah)) throw new EsbMoneyLedgerError("bill_overpayment_detected", allocation.bill_id);
            const billStatus = paidAmount === Number(bill.total_rupiah) ? "PAID" : "PARTIALLY_PAID";
            await tx.query(
              `update sagaops.esb_bills
                  set status=$2,
                      paid_at=case when $2='PAID' then $3::timestamptz else null end,
                      updated_at=$3::timestamptz
                where id=$1`,
              [allocation.bill_id, billStatus, occurredAt],
            );
          }
          if (attempt.verification_level === "CASH") {
            required(command.businessDate, "businessDate");
            await tx.query(
              `insert into sagaops.esb_cash_movements
                (id,organization_id,outlet_id,cash_session_id,payment_attempt_id,movement_type,amount_rupiah,business_date,occurred_at)
               values ($1,$2,$3,$4,$5,'PAYMENT_APPLIED',$6,$7,$8)`,
              [command.cashMovementId ?? idFactory(), command.organizationId, command.outletId,
                command.cashSessionId ?? null, command.paymentAttemptId, attempt.applied_rupiah,
                command.businessDate, occurredAt],
            );
          }
        }
        return { replay: false, status: command.targetStatus };
      });
    },

    async recordProviderSettlement(command) {
      validateScope(command);
      required(command.id, "id");
      required(command.provider, "provider");
      if (!Array.isArray(command.lines) || command.lines.length === 0) throw new EsbMoneyLedgerError("settlement_lines_required");
      for (const field of ["applied", "merchantFee", "refund", "expectedPayout"]) amount(command[field], field, { nonNegative: field !== "expectedPayout" });
      if (command.expectedPayout !== command.applied - command.merchantFee - command.refund) throw new EsbMoneyLedgerError("settlement_total_invariant_failed");
      for (const line of command.lines) {
        for (const field of ["applied", "merchantFee", "refund", "expectedPayout"]) amount(line[field], `line.${field}`, { nonNegative: field !== "expectedPayout" });
        if (line.expectedPayout !== line.applied - line.merchantFee - line.refund) throw new EsbMoneyLedgerError("settlement_line_invariant_failed");
      }
      for (const field of ["applied", "merchantFee", "refund", "expectedPayout"]) {
        if (sum(command.lines, field) !== command[field]) throw new EsbMoneyLedgerError("settlement_line_sum_mismatch", field);
      }
      const fingerprint = moneyLedgerFingerprint({ ...command, operationKey: undefined });
      return db.transaction(async (tx) => {
        const claim = await claimOperation(tx, { ...command, operationType: "RECORD_PROVIDER_SETTLEMENT", aggregateId: command.id, fingerprint });
        if (claim.replay) return { replay: true, settlementId: command.id };
        for (const line of command.lines) {
          const payment = await tx.query(
            `select status,verification_level,provider,applied_rupiah from sagaops.esb_payment_attempts
              where id=$1 and organization_id=$2 and outlet_id=$3`,
            [line.paymentAttemptId, command.organizationId, command.outletId],
          );
          if (!payment.rows[0] || payment.rows[0].status !== "SUCCEEDED" || payment.rows[0].provider !== command.provider || Number(payment.rows[0].applied_rupiah) !== line.applied) {
            throw new EsbMoneyLedgerError("settlement_payment_not_reconcilable", line.paymentAttemptId);
          }
        }
        await tx.query(
          `insert into sagaops.esb_provider_settlements
            (id,organization_id,outlet_id,provider,provider_settlement_reference,status,applied_rupiah,
             merchant_fee_rupiah,refund_rupiah,expected_payout_rupiah,actual_payout_rupiah,
             period_start_utc,period_end_utc,available_at,paid_out_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [command.id, command.organizationId, command.outletId, command.provider,
            command.providerSettlementReference ?? null, command.status ?? "EXPECTED", command.applied,
            command.merchantFee, command.refund, command.expectedPayout, command.actualPayout ?? null,
            command.periodStartUtc, command.periodEndUtc, command.availableAt ?? null, command.paidOutAt ?? null],
        );
        for (const line of command.lines) {
          await tx.query(
            `insert into sagaops.esb_settlement_lines
              (id,organization_id,outlet_id,settlement_id,payment_attempt_id,applied_rupiah,
               merchant_fee_rupiah,refund_rupiah,expected_payout_rupiah)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [line.id ?? idFactory(), command.organizationId, command.outletId, command.id,
              line.paymentAttemptId, line.applied, line.merchantFee, line.refund, line.expectedPayout],
          );
        }
        return { replay: false, settlementId: command.id };
      });
    },

    async moneySnapshot({ organizationId, outletId, orderId }) {
      const bills = await db.query(
        `select coalesce(sum(total_rupiah),0)::bigint as billed,
                coalesce(sum(case when status='PAID' then total_rupiah else 0 end),0)::bigint as paid_bill_sales
           from sagaops.esb_bills where organization_id=$1 and outlet_id=$2 and order_id=$3`,
        [organizationId, outletId, orderId],
      );
      const payments = await db.query(
        `select coalesce(sum(applied_rupiah) filter (where status='SUCCEEDED'),0)::bigint as applied,
                coalesce(sum(tendered_rupiah) filter (where status='SUCCEEDED'),0)::bigint as tendered,
                coalesce(sum(change_rupiah) filter (where status='SUCCEEDED'),0)::bigint as change
           from sagaops.esb_payment_attempts where organization_id=$1 and outlet_id=$2 and order_id=$3`,
        [organizationId, outletId, orderId],
      );
      const settlements = await db.query(
        `select coalesce(sum(sl.expected_payout_rupiah),0)::bigint as expected_payout
           from sagaops.esb_settlement_lines sl
           join sagaops.esb_payment_attempts p on p.id=sl.payment_attempt_id
          where p.organization_id=$1 and p.outlet_id=$2 and p.order_id=$3`,
        [organizationId, outletId, orderId],
      );
      return {
        billed: Number(bills.rows[0].billed),
        paidBillSales: Number(bills.rows[0].paid_bill_sales),
        applied: Number(payments.rows[0].applied),
        tendered: Number(payments.rows[0].tendered),
        change: Number(payments.rows[0].change),
        providerExpectedPayout: Number(settlements.rows[0].expected_payout),
        settlementIncludedInSales: false,
      };
    },
  };
}
