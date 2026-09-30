import { createHash } from "node:crypto";

import { createEsbMoneyLedger } from "../esb-money/ledger.mjs";

const SNAPSHOT_KIND = "SAGAPOS_ESB_CATALOG_PRICING_SNAPSHOT_V1";
const CONTRACT_VERSION = "SAGAPOS_ESB_TRANSACTION_REPORTING_V1";

export function deterministicEsbUuid(scope) {
  const bytes = Buffer.from(createHash("sha256").update(`sagapos-esb-runtime-v1:${scope}`).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function persistEsbCheckoutDualWrite({ tx, input, orderId, orderNumber, paymentId, persistedItems, now }) {
  const snapshot = validateSnapshot(input.esbCatalogPricingSnapshot, input, persistedItems);
  await persistCatalogSnapshot(tx, { input, orderId, snapshot, now });

  const ledger = createEsbMoneyLedger({
    db: transactionView(tx),
    idFactory: () => deterministicEsbUuid(`generated:${orderId}:${paymentId}`),
    now: () => now,
  });
  const bills = buildBillCommands({ input, orderId, orderNumber, persistedItems, snapshot });
  for (const bill of bills) await ledger.recordBill(bill);
  const billIds = bills.map((bill) => bill.id);
  const billId = billIds[0];

  if (input.totalRupiah === 0 && input.payment.methodType.toLowerCase() === "none") {
    await tx.query("update sagaops.esb_bills set status='PAID',paid_at=$2,updated_at=$2 where id=any($1::uuid[])", [billIds, now]);
    await persistDurablePrintQueue(tx, { input, orderId, orderNumber, paymentId, persistedItems, billId, now });
    return { billId, billIds, paymentAttemptId: null, catalogSnapshotHash: snapshot.snapshotHash };
  }
  if (input.payment.assistedCash === true && input.payment.status.toLowerCase() === "pending") {
    return { billId, billIds, paymentAttemptId: null, paymentAttemptIds: [], catalogSnapshotHash: snapshot.snapshotHash };
  }

  const attempts = buildPaymentCommands({ input, orderId, paymentId, bills });
  for (const attempt of attempts) {
    await ledger.recordPaymentAttempt(attempt);
    const paid = attempt.status === "SUCCEEDED";
    await ledger.applyPaymentEvent({
      id: deterministicEsbUuid(`payment-event:checkout:${attempt.id}:${paid ? "SUCCEEDED" : "PENDING"}`),
      paymentAttemptId: attempt.id,
      organizationId: input.organizationId,
      outletId: input.outletId,
      operationKey: `esb:checkout-payment:${attempt.id}:${paid ? "succeeded" : "pending"}`,
      eventType: paid ? (attempt.verificationLevel === "CASH" ? "CASH_ACCEPTED" : "CHECKOUT_CONFIRMED") : "PAYMENT_PENDING",
      targetStatus: paid ? "SUCCEEDED" : "PENDING",
      businessDate: input.businessDate,
      cashSessionId: input.cashSessionId ?? null,
      cashMovementId: deterministicEsbUuid(`cash-movement:checkout:${attempt.id}`),
      occurredAt: input.payment.paidAt ?? input.createdAt ?? now,
      payloadRedacted: { source: "SAGA_POS_DURABLE_CHECKOUT", writeVersion: "DUAL_WRITE_V1" },
    });
  }
  if (attempts.every((attempt) => attempt.status === "SUCCEEDED")) await persistDurablePrintQueue(tx, { input, orderId, orderNumber, paymentId: attempts[0].id, persistedItems, billId, now });
  return { billId, billIds, paymentAttemptId: attempts[0].id, paymentAttemptIds: attempts.map((attempt) => attempt.id), catalogSnapshotHash: snapshot.snapshotHash };
}

export function esbSplitBillPlanFingerprint(plan) {
  if (plan == null) return null;
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

export function esbPaymentPlanFingerprint(plan) {
  if (plan == null) return null;
  return createHash("sha256").update(stableJson(plan)).digest("hex");
}

function quantity(value) {
  const text = typeof value === "number" ? value.toFixed(6) : String(value ?? "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) throw new Error("esb_inventory_quantity_invalid");
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}

function quantityUnits(value) {
  const [whole, fraction] = quantity(value).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction);
}

async function persistDurablePrintQueue(tx, { input, orderId, orderNumber, paymentId, persistedItems, billId, now }) {
  const grouped = new Map();
  for (const item of persistedItems) {
    const destination = String(item.station ?? "bar").toLowerCase() === "food" ? "KITCHEN" : "BAR";
    const lines = grouped.get(destination) ?? [];
    lines.push({
      lineId: item.id,
      productReference: item.productReference ?? null,
      productName: item.productName,
      quantity: item.qty,
      note: item.note ?? null,
      modifiers: item.modifiers ?? [],
    });
    grouped.set(destination, lines);
  }
  for (const [destination, lines] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const stationId = destination === "KITCHEN" ? "food" : "bar";
    await tx.query(
      `insert into sagaops.esb_print_jobs
        (id,organization_id,outlet_id,bill_id,logical_job_id,destination,copy_number,copy_kind,status,
         hardware_activation,station_snapshot,template_snapshot,sale_snapshot,content_snapshot,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,0,'ORIGINAL','QUEUED','OFF_REQUIRES_PHYSICAL_UAT',$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$11)`,
      [deterministicEsbUuid(`print:${input.organizationId}:${orderId}:${destination}`), input.organizationId, input.outletId,
        billId, `checkout:${orderId}:${destination}`, destination,
        JSON.stringify({ stationId, version: 1, source: "SERVER_CHECKOUT" }),
        JSON.stringify({ templateId: "sagapos-order-ticket-v1", version: 1, source: "SERVER_CHECKOUT" }),
        JSON.stringify({ orderId, orderNumber, billId, paymentId, paymentStatus: "SUCCEEDED", paidAt: input.payment.paidAt ?? now }),
        JSON.stringify({ lines }), now],
    );
  }
}

export async function persistEsbGatewayPaidDualWrite({ tx, organizationId, outletId, paymentId, providerEventKey, paidAt, status = "SUCCEEDED" }) {
  if(!['SUCCEEDED','FAILED','EXPIRED','CANCELLED'].includes(status))throw new Error('payment_terminal_invalid');
  const ledger = createEsbMoneyLedger({ db: transactionView(tx), now: () => paidAt });
  const result = await ledger.applyPaymentEvent({
    id: deterministicEsbUuid(`payment-event:gateway:${organizationId}:${providerEventKey}`),
    paymentAttemptId: paymentId,
    organizationId,
    outletId,
    operationKey: `esb:gateway-event:${deterministicEsbUuid(`${organizationId}:${providerEventKey}`)}`,
    provider: "sagadev_gateway",
    externalEventId: providerEventKey,
    eventType: `PROVIDER_PAYMENT_${status}`,
    // The ledger records cancellation as FAILED/non-revenue; the event retains CANCELLED.
    targetStatus: status==='CANCELLED'?'FAILED':status,
    occurredAt: paidAt,
    payloadRedacted: { source: "SAGADEV_GATEWAY_STATUS", providerEventRecorded: true },
  });
  return result;
}

export async function persistEsbAssistedCashPaid({ tx, organizationId, outletId, paymentId, cashSessionId, receivedRupiah, changeRupiah, paidAt }) {
  const ledger = createEsbMoneyLedger({ db: transactionView(tx), now: () => paidAt });
  const payment = (await tx.query("select order_id,amount_rupiah,method_name_snapshot from sagaops.payments where id=$1", [paymentId])).rows[0];
  const bills = (await tx.query("select id,total_rupiah from sagaops.esb_bills where order_id=$1 order by bill_number", [payment.order_id])).rows;
  await ledger.recordPaymentAttempt({
    id: paymentId,
    organizationId,
    outletId,
    orderId: payment.order_id,
    operationKey: `esb:assisted-cash-attempt:${paymentId}`,
    methodType: "cash",
    methodNameSnapshot: payment.method_name_snapshot,
    verificationLevel: "CASH",
    tendered: receivedRupiah,
    applied: Number(payment.amount_rupiah),
    change: changeRupiah,
    createdAt: paidAt,
    allocations: bills.map((bill) => ({
      id: deterministicEsbUuid(`payment-allocation:${organizationId}:${paymentId}:${bill.id}`),
      billId: bill.id,
      applied: Number(bill.total_rupiah),
    })),
  });
  const cashBusinessDateValue = (await tx.query("select business_date from sagaops.cash_sessions where id=$1", [cashSessionId])).rows[0]?.business_date;
  const cashBusinessDate = cashBusinessDateValue instanceof Date ? cashBusinessDateValue.toISOString().slice(0, 10) : String(cashBusinessDateValue ?? "");
  const result = await ledger.applyPaymentEvent({
    id: deterministicEsbUuid(`payment-event:assisted-cash:${organizationId}:${paymentId}`),
    paymentAttemptId: paymentId,
    organizationId,
    outletId,
    operationKey: `esb:assisted-cash:${paymentId}`,
    eventType: "CASH_ACCEPTED",
    targetStatus: "SUCCEEDED",
    businessDate: cashBusinessDate,
    cashSessionId,
    cashMovementId: deterministicEsbUuid(`cash-movement:assisted-cash:${paymentId}`),
    occurredAt: paidAt,
    payloadRedacted: { source: "SAGA_POS_CASHIER_ASSISTED_KIOSK", staffConfirmed: true },
  });
  const order = (await tx.query("select id,order_number from sagaops.orders where id=$1", [payment.order_id])).rows[0];
  const bill = bills[0];
  const itemRows = (await tx.query("select id,product_reference_snapshot,product_name_snapshot,qty,note,modifier_snapshot,station_snapshot from sagaops.order_items where order_id=$1 order by created_at,id", [order.id])).rows;
  await persistDurablePrintQueue(tx, {
    input: { organizationId, outletId, payment: { paidAt }, createdAt: paidAt },
    orderId: order.id,
    orderNumber: order.order_number,
    paymentId,
    billId: bill.id,
    now: paidAt,
    persistedItems: itemRows.map((item) => ({
      id: item.id,
      productReference: item.product_reference_snapshot,
      productName: item.product_name_snapshot,
      qty: Number(item.qty),
      note: item.note,
      modifiers: item.modifier_snapshot ?? [],
      station: item.station_snapshot,
    })),
  });
  return result;
}

function transactionView(tx) {
  if (!tx?.query) throw new Error("esb_runtime_transaction_required");
  return { query: (sql, params = []) => tx.query(sql, params), transaction: (work) => work(tx) };
}

function validateSnapshot(snapshot, input, persistedItems) {
  if (!snapshot || snapshot.kind !== SNAPSHOT_KIND || snapshot.contractVersion !== 1) throw new Error("esb_catalog_pricing_snapshot_required");
  if (!/^[0-9a-f]{64}$/.test(snapshot.snapshotHash ?? "")) throw new Error("esb_catalog_pricing_snapshot_hash_invalid");
  const { snapshotHash, ...body } = snapshot;
  const actual = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  if (actual !== snapshotHash) throw new Error("esb_catalog_pricing_snapshot_hash_mismatch");
  if (!snapshot.priceBook?.versionId || !snapshot.pricingPolicy?.id || !Array.isArray(snapshot.lines) || snapshot.lines.length !== persistedItems.length) {
    throw new Error("esb_catalog_pricing_snapshot_scope_invalid");
  }
  for (const [index, line] of snapshot.lines.entries()) {
    const item = persistedItems[index];
    if (line.lineId !== item.id || (item.productReference && line.productId !== item.productReference)) {
      throw new Error("esb_catalog_pricing_snapshot_line_mismatch");
    }
  }
  const expected = {
    menuGrossRupiah: input.subtotalRupiah,
    discountRupiah: input.discountRupiah,
    taxRupiah: input.taxRupiah,
    serviceRupiah: input.serviceRupiah,
    roundingAdjustmentRupiah: input.roundingRupiah,
    totalRupiah: input.totalRupiah,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (snapshot.amounts?.[field] !== value) throw new Error(`esb_catalog_pricing_snapshot_${field}_mismatch`);
  }
  if (snapshot.currency !== "IDR" || snapshot.context?.outletId !== input.outletId) throw new Error("esb_catalog_pricing_snapshot_scope_invalid");
  return snapshot;
}

async function persistCatalogSnapshot(tx, { input, orderId, snapshot, now }) {
  await tx.query(
    `insert into sagaops.catalog_pricing_snapshots
      (id,organization_id,outlet_id,operation_key,price_book_version_id,pricing_policy_version_id,
       contract_version,currency,total_rupiah,snapshot_hash,snapshot,quoted_at,created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
    [deterministicEsbUuid(`catalog-snapshot:${input.organizationId}:${orderId}`), input.organizationId, input.outletId,
      `esb:catalog-snapshot:${orderId}`, snapshot.priceBook.versionId, snapshot.pricingPolicy.id,
      snapshot.contractVersion, snapshot.currency, snapshot.amounts.totalRupiah, snapshot.snapshotHash,
      JSON.stringify(snapshot), snapshot.quotedAt, now],
  );
  for (const line of snapshot.lines) {
    const audit = line.freePriceAudit;
    if (!audit) continue;
    await tx.query(
      `insert into sagaops.free_price_authorization_uses
        (id,organization_id,outlet_id,authorization_id,operation_key,permission,action,resource_type,
         price_book_entry_id,actor_user_id,approved_by_user_id,original_price_rupiah,requested_price_rupiah,
         reason,authorized_at,expires_at,occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [deterministicEsbUuid(`free-price:${input.organizationId}:${audit.authorizationId}`), input.organizationId,
        input.outletId, audit.authorizationId, audit.operationKey, audit.permission, audit.action,
        audit.resourceType, audit.resourceId, audit.actorUserId, audit.approvedByUserId,
        audit.originalPriceRupiah, audit.requestedPriceRupiah, audit.reason, audit.approvedAt,
        audit.expiresAt, audit.occurredAt],
    );
  }
}

function buildBillCommands({ input, orderId, orderNumber, persistedItems, snapshot }) {
  if (input.esbSplitBillPlan == null) {
    const billId = deterministicEsbUuid(`bill:${input.organizationId}:${orderId}`);
    return [buildWholeOrderBill({ input, orderId, orderNumber, persistedItems, snapshot, billId })];
  }
  return buildSplitBills({ input, orderId, orderNumber, persistedItems, snapshot });
}

function buildWholeOrderBill({ input, orderId, orderNumber, persistedItems, snapshot, billId }) {
  const rounding = snapshot.amounts.roundingAdjustmentRupiah;
  const lines = snapshot.lines.map((line, index) => {
    const lineRounding = index === 0 ? rounding : 0;
    const item = persistedItems[index];
    return {
      id: deterministicEsbUuid(`bill-line:${input.organizationId}:${orderId}:${line.lineId}`),
      orderItemId: item.id,
      stableLineId: line.lineId,
      lineKind: "MAIN",
      itemReference: line.productId,
      itemNameSnapshot: line.productNameSnapshot,
      quantity: quantity(line.quantity),
      unitPrice: line.baseUnitPriceRupiah + line.modifierUnitDeltaRupiah,
      menuGross: line.amounts.menuGrossRupiah,
      lineDiscount: line.amounts.discountRupiah,
      billDiscount: 0,
      netMenu: line.amounts.netMenuRupiah,
      tax: line.amounts.taxRupiah,
      service: line.amounts.serviceRupiah,
      customerFee: 0,
      roundingAdjustment: lineRounding,
      total: line.amounts.totalRupiah + lineRounding,
      policySnapshot: {
        contractVersion: CONTRACT_VERSION,
        catalogSnapshotHash: snapshot.snapshotHash,
        priceBookEntry: line.priceBookEntrySnapshot,
        modifierSelections: line.modifierSelectionsSnapshot,
        promotions: line.promotionAllocations,
      },
      allocationCompleteness: "COMPLETE",
    };
  });
  return {
    id: billId,
    organizationId: input.organizationId,
    outletId: input.outletId,
    orderId,
    operationKey: `esb:bill:${orderId}`,
    billNumber: `${orderNumber}-B1`,
    settlementPolicy: input.totalRupiah === 0 ? "COMPLIMENTARY" : "STANDARD",
    allocatedPax: input.paxCount,
    menuGross: snapshot.amounts.menuGrossRupiah,
    lineDiscount: snapshot.amounts.discountRupiah,
    billDiscount: 0,
    netMenu: snapshot.amounts.netMenuRupiah,
    tax: snapshot.amounts.taxRupiah,
    service: snapshot.amounts.serviceRupiah,
    customerFee: 0,
    roundingAdjustment: rounding,
    total: snapshot.amounts.totalRupiah,
    pricingPolicySnapshot: snapshot,
    allocationCompleteness: "COMPLETE",
    sourceKind: "NATIVE",
    openedAt: input.createdAt,
    lines,
  };
}

function buildSplitBills({ input, orderId, orderNumber, persistedItems, snapshot }) {
  const plan = input.esbSplitBillPlan;
  if (!plan || !Array.isArray(plan.bills) || plan.bills.length < 2 || plan.bills.length > 20) throw new Error("esb_split_bill_plan_invalid");
  if (!Number.isSafeInteger(plan.paxCount) || plan.paxCount < 1) throw new Error("esb_split_bill_pax_invalid");
  const itemByLineId = new Map(snapshot.lines.map((line, index) => [line.lineId, { line, item: persistedItems[index], index }]));
  const allocationsByLine = new Map();
  const seenBillKeys = new Set();
  let allocatedPax = 0;
  const normalized = plan.bills.map((bill, billIndex) => {
    const key = String(bill.key ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/u.test(key) || seenBillKeys.has(key)) throw new Error("esb_split_bill_key_invalid");
    seenBillKeys.add(key);
    if (!Number.isSafeInteger(bill.allocatedPax) || bill.allocatedPax < 0) throw new Error("esb_split_bill_pax_invalid");
    allocatedPax += bill.allocatedPax;
    if (!Array.isArray(bill.lines) || bill.lines.length === 0) throw new Error("esb_split_bill_lines_required");
    const seenLines = new Set();
    const lines = bill.lines.map((allocation) => {
      const lineId = String(allocation.lineId ?? "");
      if (seenLines.has(lineId) || !itemByLineId.has(lineId)) throw new Error("esb_split_bill_line_invalid");
      seenLines.add(lineId);
      const allocatedQuantity = quantity(allocation.quantity);
      if (quantityUnits(allocatedQuantity) <= 0n) throw new Error("esb_split_bill_quantity_invalid");
      const moneyWeight = allocation.moneyWeight == null ? allocatedQuantity : quantity(allocation.moneyWeight);
      if (quantityUnits(moneyWeight) <= 0n) throw new Error("esb_split_bill_money_weight_invalid");
      const list = allocationsByLine.get(lineId) ?? [];
      list.push({ billIndex, quantity: allocatedQuantity, moneyWeight });
      allocationsByLine.set(lineId, list);
      return { lineId, quantity: allocatedQuantity, moneyWeight };
    });
    return { key, allocatedPax: bill.allocatedPax, lines };
  });
  if (allocatedPax !== plan.paxCount) throw new Error("esb_split_bill_pax_mismatch");
  for (const [lineId, { line }] of itemByLineId) {
    const allocations = allocationsByLine.get(lineId) ?? [];
    const allocated = allocations.reduce((sum, row) => sum + quantityUnits(row.quantity), 0n);
    if (allocated !== quantityUnits(line.quantity)) throw new Error("esb_split_bill_quantity_mismatch");
  }
  if (allocationsByLine.size !== itemByLineId.size) throw new Error("esb_split_bill_line_missing");

  const lineAmounts = new Map();
  for (const [lineId, { line }] of itemByLineId) {
    const allocations = allocationsByLine.get(lineId);
    const weights = allocations.map((row) => quantityUnits(row.moneyWeight));
    const amounts = {};
    const source = {
      menuGross: line.amounts.menuGrossRupiah,
      lineDiscount: line.amounts.discountRupiah,
      billDiscount: 0,
      tax: line.amounts.taxRupiah,
      service: line.amounts.serviceRupiah,
      customerFee: 0,
      roundingAdjustment: itemByLineId.get(lineId).index === 0 ? snapshot.amounts.roundingAdjustmentRupiah : 0,
    };
    for (const [field, total] of Object.entries(source)) amounts[field] = allocateInteger(total, weights);
    amounts.netMenu = amounts.menuGross.map((gross, index) => gross - amounts.lineDiscount[index] - amounts.billDiscount[index]);
    amounts.total = amounts.netMenu.map((net, index) => net + amounts.tax[index] + amounts.service[index] + amounts.customerFee[index] + amounts.roundingAdjustment[index]);
    lineAmounts.set(lineId, { allocations, amounts });
  }

  return normalized.map((bill, billIndex) => {
    const billId = deterministicEsbUuid(`bill:${input.organizationId}:${orderId}:split:${bill.key}`);
    const lines = bill.lines.map(({ lineId, quantity: allocatedQuantity }) => {
      const { line, item } = itemByLineId.get(lineId);
      const split = lineAmounts.get(lineId);
      const position = split.allocations.findIndex((allocation) => allocation.billIndex === billIndex);
      const values = Object.fromEntries(Object.entries(split.amounts).map(([field, allocated]) => [field, allocated[position]]));
      return {
        id: deterministicEsbUuid(`bill-line:${input.organizationId}:${orderId}:${bill.key}:${lineId}`),
        orderItemId: item.id,
        stableLineId: `${lineId}:${bill.key}`,
        lineKind: "MAIN",
        itemReference: line.productId,
        itemNameSnapshot: line.productNameSnapshot,
        quantity: allocatedQuantity,
        unitPrice: line.baseUnitPriceRupiah + line.modifierUnitDeltaRupiah,
        ...values,
        policySnapshot: {
          contractVersion: CONTRACT_VERSION,
          catalogSnapshotHash: snapshot.snapshotHash,
          priceBookEntry: line.priceBookEntrySnapshot,
          modifierSelections: line.modifierSelectionsSnapshot,
          promotions: line.promotionAllocations,
          splitAllocation: { billKey: bill.key, sourceLineId: lineId, allocatedQuantity },
        },
        allocationCompleteness: "COMPLETE",
      };
    });
    const sumField = (field) => lines.reduce((total, line) => total + line[field], 0);
    const command = {
      id: billId,
      organizationId: input.organizationId,
      outletId: input.outletId,
      orderId,
      operationKey: `esb:bill:${orderId}:split:${bill.key}`,
      billNumber: `${orderNumber}-B${billIndex + 1}`,
      settlementPolicy: input.totalRupiah === 0 ? "COMPLIMENTARY" : "STANDARD",
      allocatedPax: bill.allocatedPax,
      menuGross: sumField("menuGross"),
      lineDiscount: sumField("lineDiscount"),
      billDiscount: sumField("billDiscount"),
      netMenu: sumField("netMenu"),
      tax: sumField("tax"),
      service: sumField("service"),
      customerFee: sumField("customerFee"),
      roundingAdjustment: sumField("roundingAdjustment"),
      total: sumField("total"),
      pricingPolicySnapshot: { ...snapshot, splitBill: { planFingerprint: esbSplitBillPlanFingerprint(plan), billKey: bill.key, billIndex, paxCount: plan.paxCount, allocatedPax: bill.allocatedPax } },
      allocationCompleteness: "COMPLETE",
      sourceKind: "NATIVE",
      openedAt: input.createdAt,
      lines,
    };
    if (input.totalRupiah > 0 && command.total <= 0) throw new Error("esb_split_bill_zero_total_unsupported");
    return command;
  });
}

function allocateInteger(total, weights) {
  if (!Number.isSafeInteger(total) || !weights.length || weights.some((weight) => weight <= 0n)) throw new Error("esb_split_bill_allocation_invalid");
  const sign = total < 0 ? -1 : 1;
  const absolute = BigInt(Math.abs(total));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  const rows = weights.map((weight, index) => {
    const numerator = absolute * weight;
    return { index, amount: numerator / denominator, remainder: numerator % denominator };
  });
  let residual = absolute - rows.reduce((sum, row) => sum + row.amount, 0n);
  for (const row of [...rows].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1)) {
    if (residual === 0n) break;
    row.amount += 1n;
    residual -= 1n;
  }
  return rows.sort((left, right) => left.index - right.index).map((row) => Number(row.amount) * sign);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function buildPaymentCommands({ input, orderId, paymentId, bills }) {
  if (input.esbPaymentPlan == null) return [{ ...buildPaymentCommand({ input, orderId, paymentId, bills }), status: input.payment.status.toLowerCase() === "paid" ? "SUCCEEDED" : "PENDING" }];
  if (input.payment.status.toLowerCase() !== "paid") throw new Error("esb_payment_plan_legacy_status_mismatch");
  if (!Array.isArray(input.esbPaymentPlan.attempts) || input.esbPaymentPlan.attempts.length < 1 || input.esbPaymentPlan.attempts.length > 20) throw new Error("esb_payment_plan_invalid");
  const billByKey = new Map();
  if (input.esbSplitBillPlan == null) billByKey.set("WHOLE", bills[0]);
  else input.esbSplitBillPlan.bills.forEach((plannedBill, index) => billByKey.set(plannedBill.key, bills[index]));
  const keys = new Set();
  const appliedByBill = new Map();
  const attempts = input.esbPaymentPlan.attempts.map((planned, index) => {
    const key = String(planned?.key ?? "").trim();
    if (!key || keys.has(key)) throw new Error("esb_payment_plan_key_invalid");
    keys.add(key);
    const method = String(planned.methodType ?? "").toLowerCase();
    if (!new Set(["cash", "manual_cashless"]).has(method)) throw new Error("esb_payment_plan_method_invalid");
    const status = String(planned.status ?? "").toUpperCase();
    if (status !== "SUCCEEDED") throw new Error("esb_payment_plan_requires_succeeded_attempts");
    if (!Number.isSafeInteger(planned.tendered) || !Number.isSafeInteger(planned.applied) || !Number.isSafeInteger(planned.change)
      || planned.applied < 0 || planned.change < 0 || planned.tendered !== planned.applied + planned.change) throw new Error("esb_payment_plan_tender_invalid");
    if (!Array.isArray(planned.allocations) || planned.allocations.length === 0) throw new Error("esb_payment_plan_allocations_required");
    let allocationTotal = 0;
    const attemptId = deterministicEsbUuid(`payment-attempt:${input.organizationId}:${orderId}:${key}`);
    const allocations = planned.allocations.map((allocation, allocationIndex) => {
      const bill = billByKey.get(allocation.billKey);
      if (!bill || !Number.isSafeInteger(allocation.applied) || allocation.applied <= 0) throw new Error("esb_payment_plan_allocation_invalid");
      allocationTotal += allocation.applied;
      appliedByBill.set(bill.id, (appliedByBill.get(bill.id) ?? 0) + allocation.applied);
      return { id: deterministicEsbUuid(`payment-allocation:${input.organizationId}:${attemptId}:${bill.id}:${allocationIndex}`), billId: bill.id, applied: allocation.applied };
    });
    if (allocationTotal !== planned.applied) throw new Error("esb_payment_plan_allocation_mismatch");
    return {
      id: attemptId, organizationId: input.organizationId, outletId: input.outletId, orderId,
      operationKey: `esb:payment-attempt:${attemptId}`, methodType: method,
      methodNameSnapshot: String(planned.methodName ?? (method === "cash" ? "Cash" : "Manual cashless")),
      verificationLevel: method === "cash" ? "CASH" : "MANUAL", provider: null, providerReference: null,
      tendered: planned.tendered, applied: planned.applied, change: planned.change,
      createdAt: input.createdAt, allocations, status,
    };
  });
  if (attempts.reduce((total, attempt) => total + attempt.applied, 0) !== input.totalRupiah) throw new Error("esb_payment_plan_total_mismatch");
  for (const bill of bills) if ((appliedByBill.get(bill.id) ?? 0) !== bill.total) throw new Error("esb_payment_plan_bill_mismatch");
  return attempts;
}

function buildPaymentCommand({ input, orderId, paymentId, bills }) {
  const method = input.payment.methodType.toLowerCase();
  const status = input.payment.status.toLowerCase();
  if (!new Set(["paid", "pending"]).has(status)) throw new Error("esb_checkout_payment_status_unsupported");
  const applied = input.payment.amountRupiah;
  const change = input.payment.changeRupiah ?? 0;
  const tendered = input.payment.receivedRupiah ?? applied + change;
  return {
    id: paymentId,
    organizationId: input.organizationId,
    outletId: input.outletId,
    orderId,
    operationKey: `esb:payment-attempt:${paymentId}`,
    methodType: method,
    methodNameSnapshot: input.payment.methodName,
    // Provider metadata supplied by checkout is not proof that the provider
    // accepted the payment. Only persistEsbGatewayPaidDualWrite may promote a
    // non-cash attempt after recording an idempotent external provider event.
    verificationLevel: method === "cash" ? "CASH" : "MANUAL",
    provider: input.payment.provider ?? null,
    providerReference: input.payment.providerReference ?? null,
    tendered,
    applied,
    change,
    createdAt: input.createdAt,
    allocations: bills.map((bill) => ({
      id: deterministicEsbUuid(`payment-allocation:${input.organizationId}:${paymentId}:${bill.id}`),
      billId: bill.id,
      applied: bill.total,
    })),
  };
}
