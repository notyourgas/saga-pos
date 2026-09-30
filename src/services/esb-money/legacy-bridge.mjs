import { createHash } from "node:crypto";
import { EsbMoneyLedgerError } from "./ledger.mjs";

function deterministicUuid(scope) {
  const bytes = Buffer.from(createHash("sha256").update(`sagapos-esb-ledger-v1:${scope}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function legacyAmount(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new EsbMoneyLedgerError("legacy_amount_unmappable", field);
  return number;
}

export function planLegacyOrderBridge({ order, payments = [] }) {
  for (const field of ["id", "organizationId", "outletId", "orderNumber"]) {
    if (!order?.[field]) throw new EsbMoneyLedgerError("legacy_order_field_missing", field);
  }
  const subtotal = legacyAmount(order.subtotalRupiah, "subtotalRupiah");
  const discount = legacyAmount(order.discountRupiah, "discountRupiah");
  const tax = legacyAmount(order.taxRupiah, "taxRupiah");
  const service = legacyAmount(order.serviceRupiah, "serviceRupiah");
  const total = legacyAmount(order.totalRupiah, "totalRupiah");
  const netMenu = subtotal - discount;
  const derivedRounding = total - netMenu - tax - service;
  const billId = deterministicUuid(`legacy-bill:${order.organizationId}:${order.id}`);
  const billLineId = deterministicUuid(`legacy-bill-line:${order.organizationId}:${order.id}`);
  const reconciliationReasons = ["LEGACY_LINE_ALLOCATION_UNVERIFIED"];
  if (order.roundingRupiah == null || legacyAmount(order.roundingRupiah, "roundingRupiah") !== derivedRounding) {
    reconciliationReasons.push("LEGACY_ROUNDING_DERIVED_TO_PRESERVE_TOTAL");
  }
  const bill = {
    id: billId,
    organizationId: order.organizationId,
    outletId: order.outletId,
    orderId: order.id,
    operationKey: `legacy-bill-v1:${order.id}`,
    billNumber: `${order.orderNumber}-LEGACY`,
    settlementPolicy: "LEGACY_UNVERIFIED",
    allocatedPax: Number.isInteger(order.pax) && order.pax >= 0 ? order.pax : 0,
    menuGross: subtotal,
    lineDiscount: 0,
    billDiscount: discount,
    netMenu,
    tax,
    service,
    customerFee: 0,
    roundingAdjustment: derivedRounding,
    total,
    pricingPolicySnapshot: {
      source: "LEGACY_ORDER_STORED_VALUES",
      businessDate: order.businessDate ?? null,
      reasons: reconciliationReasons,
    },
    allocationCompleteness: "UNVERIFIED",
    sourceKind: "LEGACY_BILL",
    sourceKey: order.id,
    openedAt: order.createdAt,
    lines: [{
      id: billLineId,
      stableLineId: `legacy-order:${order.id}`,
      itemNameSnapshot: "Legacy order aggregate",
      quantity: "1.000000",
      unitPrice: subtotal,
      menuGross: subtotal,
      lineDiscount: 0,
      billDiscount: discount,
      netMenu,
      tax,
      service,
      customerFee: 0,
      roundingAdjustment: derivedRounding,
      total,
      policySnapshot: { source: "LEGACY_ORDER_AGGREGATE", reasons: reconciliationReasons },
      allocationCompleteness: "UNVERIFIED",
    }],
  };

  const paymentCommands = [];
  const paymentEvents = [];
  const reconciliation = [];
  let mappedApplied = 0;
  for (const legacy of payments) {
    const applied = legacyAmount(legacy.amountRupiah, "payment.amountRupiah");
    const change = legacyAmount(legacy.changeRupiah, "payment.changeRupiah");
    const received = legacyAmount(legacy.receivedRupiah ?? applied + change, "payment.receivedRupiah");
    if (legacy.status !== "paid" || applied <= 0 || change < 0 || received !== applied + change || mappedApplied + applied > total) {
      reconciliation.push({
        paymentId: legacy.id,
        reason: legacy.status !== "paid" ? "LEGACY_PAYMENT_NOT_PROVEN_SUCCEEDED" : "LEGACY_PAYMENT_AMOUNT_AMBIGUOUS",
      });
      continue;
    }
    const paymentAttemptId = deterministicUuid(`legacy-payment:${order.organizationId}:${legacy.id}`);
    const isCash = legacy.methodType === "cash";
    paymentCommands.push({
      id: paymentAttemptId,
      organizationId: order.organizationId,
      outletId: order.outletId,
      orderId: order.id,
      operationKey: `legacy-payment-v1:${legacy.id}`,
      methodType: legacy.methodType ?? "other",
      methodNameSnapshot: legacy.methodNameSnapshot ?? "Legacy payment",
      verificationLevel: isCash ? "CASH" : "LEGACY_UNVERIFIED",
      provider: null,
      providerReference: null,
      tendered: received,
      applied,
      change,
      allocations: [{
        id: deterministicUuid(`legacy-payment-allocation:${order.organizationId}:${legacy.id}`),
        billId,
        applied,
      }],
    });
    paymentEvents.push({
      id: deterministicUuid(`legacy-payment-event:${order.organizationId}:${legacy.id}`),
      paymentAttemptId,
      organizationId: order.organizationId,
      outletId: order.outletId,
      operationKey: `legacy-payment-event-v1:${legacy.id}`,
      eventType: "LEGACY_PAID_SNAPSHOT",
      targetStatus: "SUCCEEDED",
      businessDate: order.businessDate,
      occurredAt: legacy.paidAt ?? order.paidAt ?? order.updatedAt,
      payloadRedacted: { source: "LEGACY_PAYMENT_STORED_VALUES", verification: isCash ? "CASH" : "LEGACY_UNVERIFIED" },
    });
    mappedApplied += applied;
  }
  if (order.status === "paid" && mappedApplied !== total) reconciliation.push({ paymentId: null, reason: "LEGACY_PAID_ORDER_PAYMENT_PARITY_FAILED" });
  return {
    version: "LEGACY_ORDER_BRIDGE_V1",
    bill,
    paymentCommands,
    paymentEvents,
    reconciliation,
    parity: { legacyTotal: total, mappedApplied, complete: order.status === "paid" ? mappedApplied === total : false },
  };
}
