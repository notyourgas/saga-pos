import { deepFreeze, exceptionError, requireIsoDate, requireSafeRupiah, requireText } from "./contract.mjs";

export const REFUND_ALLOCATION_PORT_V1 = deepFreeze({
  version: 1,
  source: "ORIGINAL_BILL_LINE_ALLOCATION",
  currentCatalogRepricingAllowed: false,
  requiredResultFields: ["source", "usesCurrentCatalog", "requestedAmountRupiah", "components"],
  integrationStatus: "POSTGRES_ADAPTER_AVAILABLE_ROUTE_NOT_WIRED",
});

export function planRefundFromOriginalAllocation(input) {
  if (typeof input.allocationAdapter?.allocateOriginal !== "function") {
    throw exceptionError("refund_allocation_adapter_required");
  }
  const originalAllocationId = requireText(input.originalAllocation?.id, "original_allocation_id_required", 100);
  const originalRefundable = requireSafeRupiah(input.originalAllocation.refundableAmountRupiah, "original_refundable_amount_invalid");
  const alreadyRefunded = requireSafeRupiah(input.alreadyRefundedRupiah ?? 0, "already_refunded_amount_invalid");
  const requested = requireSafeRupiah(input.requestedAmountRupiah, "refund_requested_amount_invalid");
  const remaining = originalRefundable - alreadyRefunded;
  if (remaining < 0) throw exceptionError("refund_history_exceeds_original_allocation");
  if (requested === 0 || requested > remaining) throw exceptionError("refund_amount_exceeds_remaining", { remaining });

  const allocation = input.allocationAdapter.allocateOriginal({
    originalAllocation: structuredClone(input.originalAllocation),
    alreadyRefundedRupiah: alreadyRefunded,
    requestedAmountRupiah: requested,
  });
  if (allocation?.source !== "ORIGINAL_BILL_LINE_ALLOCATION" || allocation?.usesCurrentCatalog !== false) {
    throw exceptionError("refund_allocation_source_invalid");
  }
  if (!Array.isArray(allocation.components) || allocation.components.length === 0) {
    throw exceptionError("refund_allocation_components_required");
  }
  const sum = allocation.components.reduce((total, component) => {
    return total + requireSafeRupiah(component.amountRupiah, "refund_allocation_component_invalid");
  }, 0);
  if (sum !== requested || allocation.requestedAmountRupiah !== requested) {
    throw exceptionError("refund_allocation_not_balanced", { requested, allocated: sum });
  }

  return deepFreeze({
    originalAllocationId,
    requestedAmountRupiah: requested,
    remainingBeforeRupiah: remaining,
    remainingAfterRupiah: remaining - requested,
    allocation: structuredClone(allocation),
    integrationStatus: REFUND_ALLOCATION_PORT_V1.integrationStatus,
  });
}

export function transitionProviderRefund({ refund, outcome, occurredAt, providerReference }) {
  if (!refund || !["REQUESTED", "PENDING", "FAILED"].includes(refund.status)) {
    throw exceptionError("provider_refund_state_invalid");
  }
  const next = String(outcome ?? "").toUpperCase();
  if (!["SUCCEEDED", "PENDING", "FAILED"].includes(next)) throw exceptionError("provider_refund_outcome_invalid");
  const allowed = {
    REQUESTED: new Set(["SUCCEEDED", "PENDING", "FAILED"]),
    PENDING: new Set(["SUCCEEDED", "FAILED"]),
    FAILED: new Set(["PENDING", "FAILED"]),
  };
  if (!allowed[refund.status].has(next)) throw exceptionError("provider_refund_transition_invalid");

  const status = next === "FAILED" ? "RECONCILIATION_REQUIRED" : next;
  return deepFreeze({
    ...structuredClone(refund),
    status,
    fundsReturned: next === "SUCCEEDED",
    reconciliationRequired: next === "FAILED",
    retryAllowed: next === "PENDING" || next === "FAILED",
    providerReference: providerReference ?? refund.providerReference ?? null,
    lastProviderOutcome: next,
    updatedAt: requireIsoDate(occurredAt, "provider_refund_occurred_at_invalid").toISOString(),
  });
}
