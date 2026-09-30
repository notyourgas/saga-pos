export const PHASE8B_PAYMENT_GATEWAY_VERSION = "PHASE8B_SAGADEV_GATEWAY_V1";

export function buildPhase8BPaymentGatewayReadiness({
  paymentMode = "OFF",
  gatewayMode = "PAYMENT_OFF",
  gatewayReadiness = null,
  activation = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const live = plain(gatewayReadiness) ? gatewayReadiness : {};
  const limits = plain(live.limits) ? live.limits : {};
  const checks = [
    check("runtime-mode", "Runtime memakai SagaDev Gateway", upper(paymentMode) === "GATEWAY" && upper(gatewayMode) === "SAGADEV_GATEWAY_PRODUCTION", "Aktivasi production harus memasangkan payment=gateway dan gateway=production."),
    check("product-binding", "Produk terikat ke sagaops kontrak v1.0", live.productCode === "sagaops" && live.contractVersion === "1.0" && live.productRegistered === true, "Gateway harus mengenali product code sagaops."),
    check("gateway-ready", "Gateway mengizinkan transaksi", live.ready === true && live.transactionsEnabled === true && live.environment === "production" && live.environmentConfirmed === true, "Readiness, transactionsEnabled, dan environment wajib lulus eksplisit."),
    check("provider-boundary", "Provider disembunyikan dari SagaPOS", live.providerVisibleToProduct === false && live.providerBoundaryConfirmed === true && live.deliveryMode === "signed_status_polling", "SagaPOS hanya boleh polling status bertanda tangan melalui SagaDev Gateway."),
    check("central-callback", "Callback provider selesai di gateway pusat", live.callbackReady === true, "Callback provider tidak boleh diarahkan ke SagaPOS."),
    check("kill-switch", "Kill switch siap dan tidak aktif", live.killSwitchReady === true && live.killSwitchEngaged === false, "Aktivasi ditolak bila kill switch belum siap atau sedang aktif."),
    check("canary-window", "Jendela uji privat sedang terbuka", live.windowOpen === true, "Jendela canary harus aktif saat pembayaran uji dijalankan."),
    check("canary-limits", "Batas canary maksimal 5 transaksi dan Rp1.100", safeInt(limits.maxTransactions) <= 5 && safeInt(limits.maxSingleAmountRupiah) <= 220 && safeInt(limits.maxTotalAmountRupiah) <= 1100, "Limit gateway tidak boleh melebihi kebijakan private canary."),
    check("activation-passport", "Runtime memakai passport controlled canary", activation?.mode === "CONTROLLED_CANARY" && activation?.deliveryMode === "signed_status_polling", "Runtime production wajib membawa marker aktivasi terkontrol."),
    check("local-canary", "Kebijakan canary lokal masih berlaku", live.localCanary?.ready === true && live.localCanary?.windowOpen === true, "Window dan kelengkapan kebijakan lokal diperiksa ulang setiap readiness."),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  return Object.freeze({
    version: PHASE8B_PAYMENT_GATEWAY_VERSION,
    phase: "PHASE_8B_SAGADEV_GATEWAY",
    provider: "SAGADEV_GATEWAY",
    state: score === 100 ? "READY" : readyChecks ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    paymentMutationAllowed: false,
    businessFactsAffected: false,
    generatedAt,
    note: score === 100
      ? "Kontrak SagaDev Gateway siap untuk satu canary privat; aktivasi dan transaksi tetap memerlukan perintah terpisah."
      : "Pembayaran tetap fail-closed. Tidak ada transaksi live sampai seluruh gate dan otorisasi aktivasi lulus.",
    checks: Object.freeze(checks),
  });
}

function check(id, label, complete, detail) { return Object.freeze({ id, label, complete: complete === true, detail }); }
function upper(value) { return String(value ?? "").trim().toUpperCase(); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeInt(value) { return Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER; }
