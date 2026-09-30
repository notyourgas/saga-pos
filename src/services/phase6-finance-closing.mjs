import { createHash } from "node:crypto";

import { classifyCashVariance } from "./closing.mjs";

export const PHASE6_FINANCE_CLOSING_VERSION = 1;

const scenarioCatalog = Object.freeze({
  CLEAN_CLOSE: Object.freeze({ label: "Closing bersih", issue: null }),
  CASH_VARIANCE: Object.freeze({ label: "Selisih kas memerlukan review", issue: "cash" }),
  PROVIDER_UNSETTLED: Object.freeze({ label: "Settlement provider belum cocok", issue: "settlement" }),
  INCOMPLETE_COSTING: Object.freeze({ label: "HPP atau stok belum lengkap", issue: "costing" }),
  MULTI_EXCEPTION: Object.freeze({ label: "Beberapa exception sekaligus", issue: "multiple" }),
});

export function createPhase6FinanceClosing({ liveClosingUat = false, clock = () => new Date() } = {}) {
  return Object.freeze({
    scenarios: () => Object.entries(scenarioCatalog).map(([id, value]) => ({ id, label: value.label })),
    readiness: ({ dashboard = {}, generatedAt = clock().toISOString() } = {}) => buildPhase6FinanceClosingReadiness({ dashboard, liveClosingUat, generatedAt }),
    simulate(input = {}) {
      const scenario = normalizeScenario(input.scenario);
      const expectedCashRupiah = normalizeMoney(input.expectedCashRupiah, 1_500_000);
      const declaredCashRupiah = normalizeMoney(input.declaredCashRupiah, expectedCashRupiah);
      const idempotencyKey = normalizeKey(input.idempotencyKey);
      const varianceRupiah = declaredCashRupiah - expectedCashRupiah;
      const variance = classifyCashVariance(varianceRupiah);
      const operationId = digest(`${PHASE6_FINANCE_CLOSING_VERSION}:${scenario}:${expectedCashRupiah}:${declaredCashRupiah}:${idempotencyKey}`).slice(0, 24);
      const checks = buildSimulationChecks({ scenario, variance });
      const actionQueue = checks.filter((item) => !item.complete).map((item) => ({
        code: item.id,
        label: item.action,
        owner: item.owner,
        blocking: true,
      }));
      const blocked = actionQueue.length > 0;
      const replayFingerprint = digest(JSON.stringify({ scenario, operationId, expectedCashRupiah, declaredCashRupiah, checks, actionQueue }));
      return {
        version: PHASE6_FINANCE_CLOSING_VERSION,
        mode: "OWNER_SAFE_CLOSING_SIMULATION",
        scenario,
        scenarioLabel: scenarioCatalog[scenario].label,
        operationId,
        idempotencyKeyHash: digest(idempotencyKey),
        replayFingerprint,
        decision: blocked ? "BLOCKED" : "READY_TO_SUBMIT_SIMULATION",
        expectedCashRupiah,
        declaredCashRupiah,
        varianceRupiah,
        varianceStatus: variance.status,
        checks,
        actionQueue,
        providerCalled: false,
        ledgerWritten: false,
        cashChanged: false,
        closureLocked: false,
        businessFactsAffected: false,
        customerDataUsed: false,
        generatedAt: clock().toISOString(),
        note: "Simulasi tidak mengubah kas, ledger, settlement, closing, stok, HPP, atau data pelanggan.",
      };
    },
  });
}

export function buildPhase6FinanceClosingReadiness({ dashboard = {}, liveClosingUat = false, generatedAt = new Date().toISOString() } = {}) {
  const checks = [
    check("financial-source", "Sumber laporan bersifat server-authoritative", true, "Ringkasan keuangan dibentuk server, bukan hitungan browser"),
    check("order-payment", "Order dan payment direkonsiliasi", true, "Issue order-payment tampil per transaksi dan tidak saling menutupi"),
    check("cash-variance", "Selisih cash drawer diklasifikasikan", true, "Ambang catatan, review manager, dan approval memakai engine closing yang sama"),
    check("settlement", "Settlement non-tunai dipisahkan", true, "Paid tidak otomatis dianggap settled atau uang masuk bank"),
    check("hpp", "HPP yang belum lengkap gagal tertutup", true, "Laba final tidak diklaim ketika coverage HPP belum lengkap"),
    check("inventory", "Varians stok gagal tertutup", true, "Perbandingan actual vs theoretical menunggu count dan evidence"),
    check("ap", "Aging AP dan exception terlihat", true, "Invoice supplier, credit, retur, dan outstanding memiliki jalur review"),
    check("exports", "Ekspor laporan deterministik tersedia", true, "Financial, cash, settlement, AP, dan inventory dapat diekspor dari server"),
    check("exception-contract", "Exception memiliki alasan dan pemilik", true, "Setiap blocker menghasilkan tindakan Owner atau Finance yang dapat dibaca"),
    check("block-default", "Closing diblokir secara default", true, "Exception blocking tidak dapat dikunci tanpa penyelesaian atau approval"),
    check("safe-rehearsal", "Owner dapat rehearsal tanpa mutasi", true, "Simulator tidak memanggil provider atau menulis ledger"),
    check("live-uat", "Closing shift nyata sudah diuji terkontrol", liveClosingUat, liveClosingUat ? "Closing, settlement, dan penerimaan Finance terkonfirmasi" : "Menunggu satu pilot closing shift nyata dan penerimaan Finance"),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  const snapshot = summarizeDashboard(dashboard);
  return {
    version: PHASE6_FINANCE_CLOSING_VERSION,
    phase: "PHASE_6_REPORTING_FINANCE_CLOSING_EXCEPTION",
    state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    simulationSafe: true,
    liveClosingUat,
    snapshot,
    generatedAt,
    note: "Kontrol laporan, kas, settlement, HPP, stok, AP, dan exception sudah terhubung. Business-ready tetap menunggu satu closing shift nyata yang diterima Owner/Finance.",
    checks,
  };
}

function buildSimulationChecks({ scenario, variance }) {
  const cashBlocked = ["CASH_VARIANCE", "MULTI_EXCEPTION"].includes(scenario) || variance.noteRequired;
  const settlementBlocked = ["PROVIDER_UNSETTLED", "MULTI_EXCEPTION"].includes(scenario);
  const costingBlocked = ["INCOMPLETE_COSTING", "MULTI_EXCEPTION"].includes(scenario);
  return [
    simulationCheck("cash-variance", "Cash drawer cocok", !cashBlocked, cashBlocked ? "Hitung ulang kas, tulis alasan, lalu minta approval bila ambang terlampaui." : "Tidak ada selisih kas blocking.", "OWNER"),
    simulationCheck("provider-settlement", "Settlement provider cocok", !settlementBlocked, settlementBlocked ? "Cocokkan statement provider berdasarkan payment reference sebelum closing." : "Tidak ada settlement non-tunai yang tertahan.", "FINANCE"),
    simulationCheck("hpp-inventory", "HPP dan stok lengkap", !costingBlocked, costingBlocked ? "Lengkapi resep/HPP, receipt, waste, dan stock count pembuka-penutup." : "Coverage costing dan evidence stok siap direview.", "OWNER"),
    simulationCheck("order-payment", "Order dan payment seimbang", true, "Tidak ada mismatch simulasi pada order-payment.", "SYSTEM"),
    simulationCheck("safe-boundary", "Tidak ada fakta bisnis berubah", true, "Provider, ledger, cash, closing, dan customer tidak disentuh.", "SYSTEM"),
  ];
}

function summarizeDashboard(dashboard) {
  const financial = dashboard?.financialSummary ?? {};
  const cash = dashboard?.cashControl ?? {};
  const settlement = dashboard?.paymentSettlement ?? {};
  const inventory = dashboard?.inventoryVariance ?? {};
  return {
    businessDate: dashboard?.businessDate ?? null,
    financialIssueCount: Number(financial.issueCount ?? 0),
    cashStatus: cash.status ?? "UNAVAILABLE",
    settlementStatus: settlement.status ?? "UNAVAILABLE",
    settlementUncheckedCount: Number(settlement.uncheckedCount ?? 0),
    hppStatus: financial.cost?.status ?? dashboard?.costStatus ?? "UNAVAILABLE",
    inventoryVarianceStatus: inventory.status ?? "UNAVAILABLE",
  };
}

function normalizeScenario(value) {
  const normalized = String(value ?? "CLEAN_CLOSE").trim().toUpperCase();
  if (!Object.hasOwn(scenarioCatalog, normalized)) throw inputError("phase6_scenario_invalid");
  return normalized;
}
function normalizeMoney(value, fallback) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) throw inputError("phase6_money_invalid");
  return parsed;
}
function normalizeKey(value) {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(key)) throw inputError("phase6_idempotency_key_invalid");
  return key;
}
function inputError(code) { const error = new Error(code); error.code = code; error.statusCode = 422; return error; }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function check(id, label, complete, detail) { return { id, label, complete: complete === true, detail: String(detail ?? "") }; }
function simulationCheck(id, label, complete, action, owner) { return { id, label, complete: complete === true, action, owner }; }
