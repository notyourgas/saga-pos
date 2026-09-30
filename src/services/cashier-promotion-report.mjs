export function buildCashierPromotionReport(orders, { from = "", to = "",refunds=[] } = {}) {
  const invalid=()=>Object.assign(new Error("promotion_report_date_invalid"),{code:"promotion_report_date_invalid",status:422});
  for (const value of [from,to]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value)) throw invalid();
  if (from && to && from>to) throw invalid();
  const groups = new Map();
  for (const order of orders) {
    if (order.testMode || (from && order.businessDate<from) || (to && order.businessDate>to)) continue;
    const fact = order.benefitSnapshot;
    if (!fact || fact.source === "NONE") continue;
    const key = fact.promotion?.id ?? fact.source;
    let group = groups.get(key);
    if (!group) { group = { id:key,name:fact.name,source:fact.source,orderCount:0,paidCount:0,pendingCount:0,refundedCount:0,discountRupiah:0,refundedDiscountRupiah:0,netSalesRupiah:0 }; groups.set(key,group); }
    group.orderCount++;
    if (["PAID","COMPLETED","REFUNDED"].includes(order.status)) {
      group.paidCount++; group.discountRupiah+=fact.discountRupiah;
      if (order.status === "REFUNDED") { group.refundedCount++; group.refundedDiscountRupiah+=fact.discountRupiah;group.menuNetSalesRupiah??=0; }
      else {
        const completed=refunds.filter(refund=>refund.orderId === order.id && refund.status === 'REFUNDED_LOCAL');
        if(completed.some(refund=>!Number.isSafeInteger(refund.amountRupiah) || refund.amountRupiah<0 || !Number.isSafeInteger(refund.subtotalRupiah) || !Number.isSafeInteger(refund.discountRupiah)))throw new Error('promotion_report_refund_invalid');
        const returned=completed.reduce((sum,refund)=>sum+refund.amountRupiah,0),returnedDiscount=completed.reduce((sum,refund)=>sum+refund.discountRupiah,0),returnedMenu=completed.reduce((sum,refund)=>sum+refund.subtotalRupiah-refund.discountRupiah,0);
        if(!Number.isSafeInteger(returned) || returned>order.totalRupiah || returnedMenu>order.subtotalRupiah-order.discountRupiah || returnedDiscount>order.discountRupiah)throw new Error('promotion_report_refund_invalid');
        if(completed.length){group.refundedCount++;group.refundedDiscountRupiah+=returnedDiscount;}
        group.netSalesRupiah+=order.totalRupiah-returned;
        group.menuNetSalesRupiah=(group.menuNetSalesRupiah??0)+order.subtotalRupiah-order.discountRupiah-returnedMenu;
      }
      if(order.hppSnapshotStatus!=="VERIFIED" || !Number.isSafeInteger(order.totalHppRupiah) || order.totalHppRupiah<0)group.hppIncomplete=true;
      else group.verifiedHppRupiah=(group.verifiedHppRupiah??0)+order.totalHppRupiah;
    } else if (!["CANCELLED","FAILED","EXPIRED"].includes(order.status)) group.pendingCount++;
  }
  return { basis:"Kelompok transaksi menurut tanggal penjualan asli, setelah refund tercatat hingga saat ini. HPP/laba kotor memakai snapshot teoretis asli, bukan laba bersih atau bukti bahan kembali. Arus dana refund per hari ada di Keuangan. Refund tidak mengaktifkan ulang voucher.",from,to,groups:[...groups.values()].map(group=>({...group,grossProfitRupiah:group.hppIncomplete || group.menuNetSalesRupiah == null?null:(group.menuNetSalesRupiah??0)-(group.verifiedHppRupiah??0)})),
    manualDiscounts:orders.filter(order=>!order.testMode && order.benefitSnapshot?.source === "MANUAL" && (!from || order.businessDate>=from) && (!to || order.businessDate<=to)).map(order=>({orderNumber:order.orderNumber,businessDate:order.businessDate,status:order.status,amountRupiah:order.benefitSnapshot.discountRupiah,...order.benefitSnapshot.manual})),
    legacyDiscountOrderCount:orders.filter(order=>!order.testMode && order.discountRupiah>0 && !order.benefitSnapshot && (!from || order.businessDate>=from) && (!to || order.businessDate<=to)).length };
}
