// This is an evidence gate, not a command that closes a shift or posts a ledger.
// Missing operational facts remain missing; an empty day is never a passed UAT.
export function buildFinanceDailyClosingGate({ financial, cashControl, paymentSettlement, inventoryVariance }) {
  const checks = [
    {
      id: "paid_orders",
      label: "Transaksi terbayar",
      passed: Number.isSafeInteger(financial?.orderCount) && financial.orderCount > 0,
      action: "Jalankan satu transaksi nyata yang diizinkan sebelum menyebut hari ini teruji.",
    },
    {
      id: "order_payment",
      label: "Order dan pembayaran",
      passed: financial?.state === "MATCHED" && financial?.issueCount === 0,
      action: "Periksa total dan alokasi pembayaran untuk setiap order.",
    },
    {
      id: "cash_count",
      label: "Kas fisik dan shift",
      passed: cashControl?.status === "CLOSED_MATCHED",
      action: "Buka shift, hitung kas fisik, selesaikan selisih, lalu tutup shift.",
    },
    {
      id: "settlement",
      label: "Review pembayaran non-tunai di POS",
      passed: paymentSettlement?.status === "READY_FOR_CLOSING"
        && Number.isSafeInteger(paymentSettlement?.totalPaymentCount)
        && paymentSettlement.totalPaymentCount > 0,
      action: "Review tiap pembayaran non-tunai di POS; status ini belum membuktikan dana masuk bank.",
    },
    {
      id: "bank_payout",
      label: "Payout provider ke bank",
      passed: financial?.settlement === "RECONCILED_TO_PROVIDER_AND_BANK",
      action: "Cocokkan statement provider, fee, dan dana masuk bank; integrasi rekonsiliasi ini belum tersedia.",
    },
    {
      id: "refund",
      label: "Refund",
      passed: financial?.excludedRefundedOrderCount === 0
        && (financial?.refundActivity?.eventCount === 0 || (financial?.refundLedger === 'ORIGINAL_SALE_AND_REFUND_EVENT_DATE_V1'
          && financial.refundActivity.pendingManualCount === 0
          && financial.refundActivity.completedLocalCount === financial.refundActivity.eventCount
          && Number.isSafeInteger(financial.refundActivity.completedLocalRupiah)))
        && financial?.refundActivity?.invalidEventCount === 0,
      action: "Cocokkan rincian refund tunai dengan kas fisik. Selesaikan refund QRIS pending dan catatan lama yang belum memiliki nilai terverifikasi.",
    },
    {
      id: "recipe_cost",
      label: "HPP transaksi",
      passed: financial?.cost?.status === "VERIFIED" && financial?.cost?.coveragePct === 100,
      action: "Publikasikan resep/HPP seluruh menu yang terjual dan periksa snapshot biayanya.",
    },
    {
      id: "actual_cost",
      label: "HPP aktual dan stok",
      passed: financial?.cost?.cogsStatus === "RECONCILED"
        && Number.isSafeInteger(financial?.cost?.actualHppRupiah)
        && inventoryVariance?.status === "VERIFIED",
      action: "Lengkapi stock count pembuka/penutup serta penyelesaian COGS dan selisih stok.",
    },
  ];
  const passedCount = checks.filter((check) => check.passed).length;
  return {
    version: 1,
    status: passedCount === checks.length ? "EVIDENCE_COMPLETE" : "INCOMPLETE",
    passedCount,
    totalCount: checks.length,
    // Expense, payroll, provider fee and bank payout are separate P&L gates.
    profitReady: false,
    checks,
  };
}
