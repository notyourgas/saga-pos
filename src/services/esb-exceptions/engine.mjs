import {
  EXCEPTION_KINDS,
  EXCEPTION_PERSISTENCE_PORT_V1,
  PERIOD_STATES,
  STOCK_DISPOSITIONS,
  deepFreeze,
  exceptionError,
  getExceptionDefinition,
  immutableSnapshot,
  requireIsoDate,
  requireSafeRupiah,
  requireText,
} from "./contract.mjs";
import { consumeActionAuthorization } from "./authorization.mjs";
import { assertExceptionPermission } from "./permissions.mjs";
import { selectReasonSnapshot } from "./reason-master.mjs";

export function prepareExceptionCommand(input) {
  const organizationId = requireText(input.organizationId, "organization_id_required", 100);
  const outletId = requireText(input.outletId, "outlet_id_required", 100);
  const resourceType = requireText(input.resourceType, "exception_resource_type_required", 80);
  const resourceId = requireText(input.resourceId, "exception_resource_id_required", 100);
  const operationKey = requireText(input.operationKey, "operation_key_required", 160);
  const occurredAt = requireIsoDate(input.occurredAt, "exception_occurred_at_invalid").toISOString();
  const definition = getExceptionDefinition(input.kind);

  const permission = assertExceptionPermission({
    actor: input.actor,
    organizationId,
    outletId,
    kind: input.kind,
    capability: "EXECUTE",
  });
  const reason = selectReasonSnapshot({
    master: input.reasonMaster,
    kind: input.kind,
    organizationId,
    outletId,
    occurredAt,
    note: input.reasonNote,
  });

  const before = immutableSnapshot(input.before);
  const authorizationDecision = definition.actionAuthorizationRequired
    ? consumeActionAuthorization({
      authorization: input.authorization,
      actor: input.actor,
      request: { organizationId, outletId, kind: input.kind, resourceType, resourceId, operationKey },
      now: occurredAt,
    })
    : null;

  const periodDecision = evaluatePeriodClose({
    kind: input.kind,
    period: input.period,
    actor: input.actor,
    authorizationDecision,
  });
  const effect = buildEffect({ ...input, before });
  const after = immutableSnapshot(effect.after);

  const event = deepFreeze({
    eventType: `EXCEPTION_${input.kind}`,
    organizationId,
    outletId,
    resourceType,
    resourceId,
    operationKey,
    actorUserId: permission.actorId,
    actorRoleSnapshot: permission.role,
    reason,
    before,
    after,
    effect: immutableSnapshot(effect.details),
    occurredAt,
  });
  const audit = deepFreeze({
    organizationId,
    outletId,
    actorUserId: permission.actorId,
    roleSnapshot: permission.role,
    action: `exception.${input.kind.toLowerCase()}`,
    entityType: resourceType,
    entityId: resourceId,
    oldValues: before,
    newValues: after,
    metadata: {
      operationKey,
      reason,
      authorizationId: authorizationDecision?.authorization.id ?? null,
      periodOverride: periodDecision.override,
      effect: event.effect,
    },
    createdAt: occurredAt,
  });

  return deepFreeze({
    event,
    audit,
    authorizationDecision,
    periodDecision,
    persistence: EXCEPTION_PERSISTENCE_PORT_V1,
  });
}

export function preparePaymentReclassification(input) {
  if (input.kind !== EXCEPTION_KINDS.PAYMENT_RECLASSIFICATION) throw exceptionError("payment_reclassification_kind_required");
  const amount = requireSafeRupiah(input.before?.appliedAmountRupiah, "payment_reclassification_amount_invalid");
  if (amount === 0 || input.before?.paymentStatus !== "SUCCEEDED") throw exceptionError("payment_reclassification_source_invalid");
  const fromMethod = requireText(input.before?.methodId, "payment_reclassification_source_method_required", 100);
  const toMethod = requireText(input.targetMethodId, "payment_reclassification_target_method_required", 100);
  if (fromMethod === toMethod) throw exceptionError("payment_reclassification_same_method");

  return prepareExceptionCommand({
    ...input,
    proposedAfter: {
      ...input.before,
      methodId: toMethod,
      reclassifiedFromMethodId: fromMethod,
    },
    effectOverride: {
      kind: "PAYMENT_RECLASSIFICATION",
      salesRevenueDeltaRupiah: 0,
      cashMovementNetDeltaRupiah: 0,
      ledgerEntries: [
        { kind: "PAYMENT_CLASSIFICATION_REVERSAL", methodId: fromMethod, signedAmountRupiah: -amount },
        { kind: "PAYMENT_CLASSIFICATION_APPLY", methodId: toMethod, signedAmountRupiah: amount },
      ],
      originalPaymentPreserved: true,
    },
  });
}

function evaluatePeriodClose({ kind, period, actor, authorizationDecision }) {
  if (!period || !PERIOD_STATES.includes(period.state)) throw exceptionError("period_state_unverified");
  if (period.state === "UNVERIFIED") throw exceptionError("period_state_unverified");
  if (period.state === "OPEN") return deepFreeze({ state: "OPEN", override: false });

  const definition = getExceptionDefinition(kind);
  if (!definition.supportsHistoricalOverride) throw exceptionError("historical_exception_not_supported", { kind });
  if (actor.role !== "owner") throw exceptionError("historical_exception_owner_required");
  if (!authorizationDecision || authorizationDecision.authorization.status !== "CONSUMED") {
    throw exceptionError("historical_exception_authorization_required");
  }
  const closeId = requireText(period.closeId, "period_close_id_required", 100);
  return deepFreeze({ state: period.state, closeId, override: true, reportingAdjustmentRequired: true });
}

function buildEffect(input) {
  if (input.effectOverride) return { after: input.proposedAfter, details: input.effectOverride };

  switch (input.kind) {
    case EXCEPTION_KINDS.CANCEL_PRE_PRODUCTION:
      if (!["DRAFT", "PLACED"].includes(input.before.orderState) || input.before.productionStarted === true) {
        throw exceptionError("cancel_pre_production_state_invalid");
      }
      return {
        after: { ...input.before, orderState: "CANCELLED", ...(input.before.billState ? { billState: "VOIDED" } : {}) },
        details: { reservationDisposition: "RELEASE_RESERVED", financialEffect: "NONE", stockMovementRequired: false },
      };
    case EXCEPTION_KINDS.VOID_POST_PRODUCTION: {
      if (!input.before.productionStarted || !["PLACED", "IN_PRODUCTION", "FULFILLED"].includes(input.before.orderState)) {
        throw exceptionError("void_post_production_state_invalid");
      }
      if (!["OPEN", "PARTIALLY_PAID"].includes(input.before.billState)) {
        throw exceptionError("void_bill_state_invalid_use_refund_or_reversal");
      }
      if (!STOCK_DISPOSITIONS.includes(input.stockDisposition)) throw exceptionError("void_stock_disposition_required");
      return {
        after: { ...input.before, orderState: "CANCELLED", billState: "VOIDED" },
        details: {
          stockDisposition: input.stockDisposition,
          automaticStockReturn: false,
          ...(input.stockDisposition === "RETURN_TO_STOCK" ? { stockReturnAuthority: "HPP_SEPARATE_MOVEMENT_REQUIRED" } : {}),
          automaticRefund: false,
        },
      };
    }
    case EXCEPTION_KINDS.CASH_REFUND:
    case EXCEPTION_KINDS.PROVIDER_REFUND:
      if (input.before.billState !== "PAID" || input.before.paymentStatus !== "SUCCEEDED") {
        throw exceptionError("refund_source_payment_not_succeeded");
      }
      return {
        after: { ...input.before, refundWorkState: "REQUESTED", fundsReturned: false },
        details: {
          refundPlan: immutableSnapshot(input.refundPlan),
          external: input.kind === EXCEPTION_KINDS.PROVIDER_REFUND,
          moneyLedgerIntegration: "MONEY_LEDGER_V1_ORIGINAL_ALLOCATION_REQUIRED",
        },
      };
    case EXCEPTION_KINDS.PAYMENT_CORRECTION:
    case EXCEPTION_KINDS.PAYMENT_REVERSAL:
      if (input.before.paymentStatus !== "SUCCEEDED") throw exceptionError("payment_exception_source_not_succeeded");
      return {
        after: input.proposedAfter,
        details: {
          originalPaymentPreserved: true,
          replacementCreatesSalesRevenue: false,
          moneyLedgerIntegration: "MONEY_LEDGER_V1_ORIGINAL_ALLOCATION_REQUIRED",
        },
      };
    default:
      throw exceptionError("exception_effect_not_implemented", { kind: input.kind });
  }
}
