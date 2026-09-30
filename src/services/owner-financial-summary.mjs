import { buildCogsReconciliation } from "./cogs-reconciliation.mjs";

const paidStatuses = new Set(["PAID", "COMPLETED"]);
const moneyFields = ["subtotalRupiah", "discountRupiah", "taxRupiah", "serviceRupiah", "roundingRupiah", "totalRupiah"];
const validMoney = (value, signed = false) => Number.isSafeInteger(value) && (signed || value >= 0);
const add = (a, b) => { const value = a + b; if (!Number.isSafeInteger(value)) throw new Error("report_amount_overflow"); return value; };

export function refundedSaleHasLedger(order, refunds) {
  const completed=refunds.filter(refund=>refund.orderId === order.id && refund.status === 'REFUNDED_LOCAL');
  return completed.length > 0 && completed.every(refund=>validMoney(refund.amountRupiah) && Array.isArray(refund.items))
    && completed.reduce((sum,refund)=>add(sum,refund.amountRupiah),0) === order.totalRupiah;
}

// Input is the repository-owned outlet projection, never browser-supplied rows.
// Current POS cost snapshots are placeholders: do not infer zero cost or profit.
export function buildOwnerFinancialSummary({ orders = [], payments = [], orderItems = [], refunds = [], hppState = null, businessDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? "") || !Number.isFinite(Date.parse(businessDate)) || new Date(businessDate).toISOString().slice(0, 10) !== businessDate) throw new Error("report_date_invalid");
  const dated = orders.filter((order) => String(order.businessDate).slice(0, 10) === businessDate);
  const selected = dated.filter((order) => paidStatuses.has(order.status) || (order.status === 'REFUNDED' && refundedSaleHasLedger(order,refunds)));
  const ids = new Set(selected.map((order) => order.id));
  if (ids.size !== selected.length) throw new Error("report_duplicate_order");
  const byOrder = new Map();
  const paymentIds = new Set();
  for (const payment of payments) {
    if (!['PAID','REFUNDED'].includes(payment.status) || !ids.has(payment.orderId)) continue;
    if (paymentIds.has(payment.id)) throw new Error("report_duplicate_payment");
    paymentIds.add(payment.id);
    const group = byOrder.get(payment.orderId) ?? [];
    group.push(payment); byOrder.set(payment.orderId, group);
  }
  const itemsByOrder = new Map();
  const itemIds = new Set();
  for (const item of orderItems) {
    if (!ids.has(item.orderId)) throw new Error("cost_snapshot_invalid");
    if (!item.id || itemIds.has(item.id)) throw new Error("duplicate_order_item");
    itemIds.add(item.id);
    const validStatus = ["VERIFIED", "INCOMPLETE", "UNVERIFIED", "NOT_APPLICABLE"].includes(item.hppSnapshotStatus);
    if (!validStatus || !Number.isSafeInteger(item.qty) || item.qty <= 0 || !validMoney(item.recipeCostSnapshotRupiah)) throw new Error("cost_snapshot_invalid");
    const group = itemsByOrder.get(item.orderId) ?? [];
    group.push(item); itemsByOrder.set(item.orderId, group);
  }
  const rows = selected.map((order) => {
    const related = byOrder.get(order.id) ?? [];
    const valid = moneyFields.every((field) => validMoney(order[field], field === "roundingRupiah")) && order.discountRupiah <= order.subtotalRupiah && related.every((payment) => validMoney(payment.amountRupiah));
    if (!valid) return { orderNumber: order.orderNumber, channel: order.channel, state: "INVALID_AMOUNT", totalRupiah: null, collectedRupiah: null, differenceRupiah: null };
    const menuSalesRupiah = order.subtotalRupiah - order.discountRupiah;
    const calculatedTotalRupiah = [menuSalesRupiah, order.taxRupiah, order.serviceRupiah, order.roundingRupiah].reduce(add, 0);
    const collectedRupiah = related.reduce((sum, payment) => add(sum, payment.amountRupiah), 0);
    const differenceRupiah = add(collectedRupiah, -order.totalRupiah);
    const costItems = itemsByOrder.get(order.id) ?? [];
    const hppState = !costItems.length ? "UNVERIFIED" : costItems.every((item) => ["VERIFIED", "NOT_APPLICABLE"].includes(item.hppSnapshotStatus)) ? "VERIFIED" : costItems.some((item) => item.hppSnapshotStatus === "INCOMPLETE") ? "INCOMPLETE" : "UNVERIFIED";
    const theoreticalHppRupiah = hppState === "VERIFIED" ? costItems.reduce((sum, item) => add(sum, item.recipeCostSnapshotRupiah * item.qty), 0) : null;
    return {
      orderNumber: order.orderNumber, channel: order.channel,
      ...Object.fromEntries(moneyFields.map((field) => [field, order[field]])),
      menuSalesRupiah, calculatedTotalRupiah, collectedRupiah, differenceRupiah,
      state: calculatedTotalRupiah !== order.totalRupiah ? "ORDER_TOTAL_MISMATCH" : differenceRupiah !== 0 ? "PAYMENT_MISMATCH" : "MATCHED",
      hppState, theoreticalHppRupiah,
    };
  });
  const complete = rows.every((row) => row.state !== "INVALID_AMOUNT");
  const totals = Object.fromEntries([...moneyFields, "menuSalesRupiah", "collectedRupiah", "differenceRupiah"].map((field) => [field, complete ? rows.reduce((sum, row) => add(sum, row[field]), 0) : null]));
  const verifiedRows = rows.filter((row) => row.hppState === "VERIFIED" && row.menuSalesRupiah != null);
  const verifiedSalesRupiah = verifiedRows.reduce((sum, row) => add(sum, row.menuSalesRupiah), 0);
  const verifiedTheoreticalHppRupiah = verifiedRows.reduce((sum, row) => add(sum, row.theoreticalHppRupiah), 0);
  const allCostVerified = rows.length > 0 && verifiedRows.length === rows.length;
  const costStatus = !rows.length ? "NO_SALES" : allCostVerified ? "VERIFIED" : verifiedRows.length ? "PARTIAL" : "INCOMPLETE";
  const incompleteProducts = [...new Set(orderItems.filter((item) => ids.has(item.orderId) && !["VERIFIED", "NOT_APPLICABLE"].includes(item.hppSnapshotStatus)).map((item) => item.productNameSnapshot || "Produk tanpa nama"))].sort();
  const cogs = hppState ? buildCogsReconciliation({
    saleConsumptions: hppState.saleConsumptions ?? [],
    cogsAdjustments: hppState.cogsAdjustments ?? [],
    orderIds: [...ids],
  }) : null;
  const postedCogsRupiah = cogs?.missingConsumptionOrderCount === 0 ? cogs.postedCogsRupiah : null;
  const adjustedCogsRupiah = cogs?.missingConsumptionOrderCount === 0 ? cogs.adjustedCogsRupiah : null;
  // Original sales stay on the order date; cash returned belongs to the refund
  // date. A provider request is never treated as funds returned.
  const refundActivity = { eventCount: 0, pendingManualCount: 0, completedLocalCount: 0, invalidEventCount: 0,completedLocalRupiah:0,pendingManualRupiah:0 };
  const refundRows=[],seenRefunds=new Set();let returnedMenuRupiah=0;
  const jakartaDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
  for (const refund of refunds) {
    const occurredAt = new Date(refund.createdAt ?? "");
    if (Number.isNaN(occurredAt.getTime())) { refundActivity.invalidEventCount += 1; continue; }
    const date = jakartaDate.format(occurredAt);
    if (date !== businessDate) continue;
    if (seenRefunds.has(refund.id)) throw new Error('report_duplicate_refund');
    seenRefunds.add(refund.id);
    refundActivity.eventCount += 1;
    if (refund.status === "PENDING_MANUAL_FINANCE_RECONCILIATION") {
      refundActivity.pendingManualCount += 1;
      if(validMoney(refund.amountRupiah))refundActivity.pendingManualRupiah=add(refundActivity.pendingManualRupiah,refund.amountRupiah);
    }
    else if (refund.status === "REFUNDED_LOCAL") {
      refundActivity.completedLocalCount += 1;
      if(validMoney(refund.amountRupiah))refundActivity.completedLocalRupiah=add(refundActivity.completedLocalRupiah,refund.amountRupiah);
      else refundActivity.invalidEventCount += 1;
      const componentsValid=moneyFields.every(field=>validMoney(refund[field],field === 'roundingRupiah')) && refund.discountRupiah <= refund.subtotalRupiah && refund.subtotalRupiah-refund.discountRupiah+refund.taxRupiah+refund.serviceRupiah+refund.roundingRupiah === refund.amountRupiah;
      returnedMenuRupiah=returnedMenuRupiah == null || !componentsValid ? null : add(returnedMenuRupiah,refund.subtotalRupiah-refund.discountRupiah);
    }
    else refundActivity.invalidEventCount += 1;
    const original=orders.find(order=>order.id === refund.orderId);
    refundRows.push({refundId:refund.id,orderNumber:original?.orderNumber??null,originalBusinessDate:original?.businessDate??null,createdAt:refund.createdAt,amountRupiah:validMoney(refund.amountRupiah)?refund.amountRupiah:null,status:refund.status,reason:refund.reason??null});
  }
  return {
    version: 2, businessDate, basis: "ORIGINAL_SALE_DATE_REFUND_EVENT_DATE", orderCount: rows.length,
    ...totals,
    state: refundActivity.invalidEventCount || rows.some((row)=>row.state !== 'MATCHED') ? 'NEEDS_REVIEW' : !rows.length ? 'EMPTY' : 'MATCHED',
    issueCount: rows.filter((row) => row.state !== "MATCHED").length,
    excludedRefundedOrderCount: dated.filter((order) => order.status === "REFUNDED" && !ids.has(order.id)).length,
    excludedPendingOrderCount: dated.filter((order) => order.status === "PAYMENT_PENDING").length,
    refundActivity,
    refundRows,
    netCollectedAfterRefundRupiah:complete && !refundActivity.invalidEventCount ? add(totals.collectedRupiah,-refundActivity.completedLocalRupiah) : null,
    netMenuSalesAfterRefundRupiah:complete && !refundActivity.invalidEventCount && returnedMenuRupiah != null ? add(totals.menuSalesRupiah,-returnedMenuRupiah) : null,
    rows,
    cost: {
      status: costStatus,
      coveragePct: rows.length ? Math.round((verifiedRows.length / rows.length) * 100) : null,
      verifiedOrderCount: verifiedRows.length,
      excludedOrderCount: rows.length - verifiedRows.length,
      verifiedSalesRupiah,
      verifiedTheoreticalHppRupiah,
      incompleteProducts,
      theoreticalHppRupiah: allCostVerified ? verifiedTheoreticalHppRupiah : null,
      postedCogsRupiah,
      cogsAdjustmentRupiah: postedCogsRupiah == null ? null : cogs.cogsAdjustmentRupiah,
      adjustedCogsRupiah,
      transactionToPostedVarianceRupiah: allCostVerified && postedCogsRupiah != null ? add(postedCogsRupiah, -verifiedTheoreticalHppRupiah) : null,
      transactionToAdjustedVarianceRupiah: allCostVerified && adjustedCogsRupiah != null ? add(adjustedCogsRupiah, -verifiedTheoreticalHppRupiah) : null,
      unresolvedShortageQuantityBase: cogs?.unresolvedShortageQuantityBase ?? null,
      unresolvedProvisionalCogsRupiah: cogs?.unresolvedProvisionalCogsRupiah ?? null,
      missingProvisionalCostLineCount: cogs?.missingProvisionalCostLineCount ?? null,
      missingProvisionalCostQuantityBase: cogs?.missingProvisionalCostQuantityBase ?? null,
      cogsStatus: cogs?.status ?? "NOT_AVAILABLE",
      actualHppRupiah: cogs?.status === "RECONCILED" ? adjustedCogsRupiah : null,
      grossProfitRupiah: allCostVerified ? add(verifiedSalesRupiah, -verifiedTheoreticalHppRupiah) : null,
      grossProfitAfterRefundRupiah: allCostVerified && complete && !refundActivity.invalidEventCount && returnedMenuRupiah != null ? add(add(verifiedSalesRupiah,-returnedMenuRupiah),-verifiedTheoreticalHppRupiah) : null,
      adjustedGrossProfitRupiah: allCostVerified && cogs?.status === "RECONCILED" ? add(verifiedSalesRupiah, -adjustedCogsRupiah) : null,
      netProfitRupiah: null,
    },
    settlement: "NOT_RECONCILED_TO_PROVIDER_OR_BANK",
    refundLedger: "ORIGINAL_SALE_AND_REFUND_EVENT_DATE_V1",
  };
}

export function ownerFinancialCsv(report) {
  const escapeCell = (value) => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [
    ["Saga POS - rekonsiliasi order dan payment"], ["Tanggal bisnis WIB", report.businessDate],
    ["Cakupan", "refund ledger: penjualan asli di tanggal transaksi; dana refund tunai di tanggal pengembalian. QRIS pending dan settlement bank terpisah."],
    ["Status", report.state], ["Order perlu diperiksa", report.issueCount],
    ["Subtotal menu", report.subtotalRupiah], ["Diskon", report.discountRupiah], ["Penjualan menu", report.menuSalesRupiah],
    ["Pajak", report.taxRupiah], ["Biaya layanan", report.serviceRupiah], ["Pembulatan", report.roundingRupiah],
    ["Total tagihan", report.totalRupiah], ["Pembayaran tercatat", report.collectedRupiah], ["Selisih pembayaran", report.differenceRupiah],
    ["Penjualan menu setelah refund tanggal ini", report.netMenuSalesAfterRefundRupiah],
    ["Laba kotor teoretis setelah refund tanggal ini", report.cost.grossProfitAfterRefundRupiah],
    ["Status HPP teoretis", report.cost.status], ["Coverage HPP", report.cost.coveragePct == null ? "N/A" : `${report.cost.coveragePct}%`],
    ["Order HPP terverifikasi", report.cost.verifiedOrderCount], ["Order dikecualikan dari HPP", report.cost.excludedOrderCount],
    ["Penjualan menu subset terverifikasi", report.cost.verifiedSalesRupiah], ["HPP teoretis subset terverifikasi", report.cost.verifiedTheoreticalHppRupiah],
    ["HPP teoretis seluruh penjualan", report.cost.theoreticalHppRupiah], ["Laba kotor seluruh penjualan", report.cost.grossProfitRupiah],
    ["Status ledger COGS", report.cost.cogsStatus], ["COGS posted", report.cost.postedCogsRupiah],
    ["Adjustment COGS", report.cost.cogsAdjustmentRupiah], ["COGS adjusted", report.cost.adjustedCogsRupiah],
    ["Variance transaction ke posted", report.cost.transactionToPostedVarianceRupiah], ["Variance transaction ke adjusted", report.cost.transactionToAdjustedVarianceRupiah],
    ["Shortage belum resolved", report.cost.unresolvedShortageQuantityBase], ["Nilai provisional belum resolved", report.cost.unresolvedProvisionalCogsRupiah],
    ["Baris provisional tanpa biaya", report.cost.missingProvisionalCostLineCount], ["Kuantitas provisional tanpa biaya", report.cost.missingProvisionalCostQuantityBase],
    ["HPP aktual/laba bersih", "Belum tersedia; memerlukan stock count, pembelian, waste, fee, dan biaya operasional"],
    ["Order refunded dikecualikan", report.excludedRefundedOrderCount], ["Order pending dikecualikan", report.excludedPendingOrderCount], [],
    ["Aktivitas refund tanggal ini", report.refundActivity?.eventCount ?? 0], ["Refund menunggu rekonsiliasi manual", report.refundActivity?.pendingManualCount ?? 0],
    ["Refund lokal tercatat", report.refundActivity?.completedLocalCount ?? 0], ["Event refund tidak valid", report.refundActivity?.invalidEventCount ?? 0], [],
    ["Dana tunai dikembalikan tanggal ini",report.refundActivity?.completedLocalRupiah??0], ["Refund manual belum terkonfirmasi",report.refundActivity?.pendingManualRupiah??0], ["Penerimaan tercatat dikurangi refund tanggal ini",report.netCollectedAfterRefundRupiah], [],
    ["Order", "Channel", "Tagihan Rupiah", "Pembayaran Rupiah", "Selisih Rupiah", "Status", "Status HPP", "HPP teoretis Rupiah"],
    ...report.rows.map((row) => [row.orderNumber, row.channel, row.totalRupiah, row.collectedRupiah, row.differenceRupiah, row.state, row.hppState, row.theoreticalHppRupiah]),
    [],['Refund','Pesanan','Tanggal penjualan asli','Waktu refund','Rupiah','Status','Alasan'],
    ...(report.refundRows??[]).map(row=>[row.refundId,row.orderNumber,row.originalBusinessDate,row.createdAt,row.amountRupiah,row.status,row.reason]),
  ];
  return "\uFEFF" + rows.map((row) => row.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}
