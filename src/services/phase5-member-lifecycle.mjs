import { createHash } from "node:crypto";

export const PHASE5_MEMBER_LIFECYCLE_VERSION = 1;

const scenarios = Object.freeze({
  HAPPY_PATH: Object.freeze({ label: "Earn, redeem, lalu reversal berhasil", reconcile: false }),
  AMBIGUOUS_REDEEM: Object.freeze({ label: "Redeem tidak terkonfirmasi", reconcile: true }),
  REVERSAL_PENDING: Object.freeze({ label: "Reversal menunggu Customer Platform", reconcile: true }),
});

export function createPhase5MemberLifecycle({ providerConfigured = false, providerMutationUat = false, clock = () => new Date() } = {}) {
  return Object.freeze({
    scenarios: () => Object.entries(scenarios).map(([id, value]) => ({ id, label: value.label })),
    readiness: ({ generatedAt = clock().toISOString() } = {}) => buildPhase5MemberReadiness({ providerConfigured, providerMutationUat, generatedAt }),
    simulate(input = {}) {
      const scenario = normalizeScenario(input.scenario);
      const eligibleSpendRupiah = normalizeMoney(input.eligibleSpendRupiah, 50_000);
      const rewardCostPoints = normalizeInteger(input.rewardCostPoints, 100, 1, 1_000_000);
      const idempotencyKey = normalizeKey(input.idempotencyKey);
      const operationId = digest(`${PHASE5_MEMBER_LIFECYCLE_VERSION}:${scenario}:${eligibleSpendRupiah}:${rewardCostPoints}:${idempotencyKey}`).slice(0, 24);
      const earnedPoints = Math.floor(eligibleSpendRupiah / 1_000);
      const steps = buildSteps({ scenario, operationId, earnedPoints, rewardCostPoints });
      const reconciliation = buildReconciliation({ scenario, operationId });
      return {
        version: PHASE5_MEMBER_LIFECYCLE_VERSION,
        mode: "OWNER_SAFE_SIMULATION",
        scenario,
        scenarioLabel: scenarios[scenario].label,
        operationId,
        idempotencyKeyHash: digest(idempotencyKey),
        replayFingerprint: digest(JSON.stringify({ scenario, operationId, eligibleSpendRupiah, rewardCostPoints, steps, reconciliation })),
        eligibleSpendRupiah,
        earnedPoints,
        rewardCostPoints,
        projectedBalanceAfterEarn: earnedPoints,
        projectedBalanceAfterRedeem: Math.max(0, earnedPoints - rewardCostPoints),
        projectedBalanceAfterReversal: earnedPoints,
        steps,
        reconciliation,
        providerConfigured,
        providerCalled: false,
        businessFactsAffected: false,
        customerDataUsed: false,
        generatedAt: clock().toISOString(),
        note: "Simulasi ini tidak memanggil Customer Platform dan tidak mengubah poin, reward, order, atau data pelanggan.",
      };
    },
  });
}

export function buildPhase5MemberReadiness({ providerConfigured = false, providerMutationUat = false, generatedAt = new Date().toISOString() } = {}) {
  const checks = [
    check("provider", "Provider Saga Member terpasang di SagaPOS", providerConfigured, providerConfigured ? "Mode PROVIDER terkonfigurasi" : "Provider belum aktif"),
    check("authority", "Batas otoritas sistem jelas", true, "Customer Platform memiliki loyalty; SagaPOS hanya mengirim fakta commerce"),
    check("earn", "Earn dapat disimulasikan tanpa menulis poin", true, "Nilai eligible spend menghasilkan proyeksi earn"),
    check("redeem", "Redeem memakai alur reserve lalu commit", true, "Reservasi dan commit tampil sebagai langkah terpisah"),
    check("reversal", "Refund/reversal memiliki alur kompensasi", true, "Reversal mengembalikan proyeksi saldo"),
    check("replay", "Replay idempotensi dapat dibuktikan", true, "Input dan key yang sama menghasilkan fingerprint yang sama"),
    check("reconciliation", "Status ambigu memiliki owner dan tindakan", true, "Kasus ambigu diarahkan ke lookup Customer Platform, bukan retry buta"),
    check("provider-uat", "Mutasi provider pernah diuji terkontrol", providerMutationUat, providerMutationUat ? "Earn, redeem, dan reversal terkonfirmasi di provider" : "Menunggu payment/provider UAT dengan akun uji terkontrol"),
  ];
  const readyChecks = checks.filter((item) => item.complete).length;
  const totalChecks = checks.length;
  const score = Math.round(readyChecks / totalChecks * 100);
  return {
    version: PHASE5_MEMBER_LIFECYCLE_VERSION,
    phase: "PHASE_5_MEMBER_EARN_REDEEM_REVERSAL",
    state: score === 100 ? "READY" : readyChecks > 0 ? "PARTIAL" : "MISSING",
    score,
    readyChecks,
    totalChecks,
    blockingCount: totalChecks - readyChecks,
    activationSafe: score === 100,
    simulationSafe: true,
    providerMutationUat,
    generatedAt,
    note: "Simulator Owner membuktikan urutan earn, redeem, reversal, replay, dan rekonsiliasi tanpa mengubah fakta bisnis. Aktivasi loyalty nyata tetap menunggu UAT provider terkontrol.",
    checks,
  };
}

function buildSteps({ scenario, operationId, earnedPoints, rewardCostPoints }) {
  const prefix = `phase5:${operationId}`;
  const redeemStatus = scenario === "AMBIGUOUS_REDEEM" ? "RECONCILIATION_REQUIRED" : "COMMITTED_SIMULATION";
  const reversalStatus = scenario === "REVERSAL_PENDING" ? "RECONCILIATION_REQUIRED" : "REVERSED_SIMULATION";
  return [
    { id: "commerce", label: "Order paid membentuk eligible spend", status: "QUALIFIED_SIMULATION", idempotencyKey: `${prefix}:earn`, points: earnedPoints },
    { id: "earn", label: "Customer Platform menerima earn", status: "PROJECTED_ONLY", idempotencyKey: `${prefix}:earn`, points: earnedPoints },
    { id: "reserve", label: "Reward ditahan sebelum checkout", status: "RESERVED_SIMULATION", idempotencyKey: `${prefix}:redeem`, points: rewardCostPoints },
    { id: "redeem", label: "Reward dikomit setelah pembayaran", status: redeemStatus, idempotencyKey: `${prefix}:redeem`, points: rewardCostPoints },
    { id: "reversal", label: "Refund memicu kompensasi reward", status: reversalStatus, idempotencyKey: `${prefix}:reversal`, points: rewardCostPoints },
  ];
}

function buildReconciliation({ scenario, operationId }) {
  if (!scenarios[scenario].reconcile) return { required: false, state: "CONVERGED", owner: "AUTOMATION", action: "NONE" };
  const target = scenario === "AMBIGUOUS_REDEEM" ? "REDEEM_COMMIT" : "REWARD_REVERSAL";
  return {
    required: true,
    state: "RECONCILIATION_REQUIRED",
    owner: "CUSTOMER_PLATFORM_OPERATIONS",
    target,
    correlationId: `phase5-${operationId}`,
    action: "LOOKUP_BY_IDEMPOTENCY_KEY_BEFORE_RETRY",
  };
}

function normalizeScenario(value) {
  const normalized = String(value ?? "HAPPY_PATH").trim().toUpperCase();
  if (!Object.hasOwn(scenarios, normalized)) throw inputError("phase5_scenario_invalid");
  return normalized;
}

function normalizeMoney(value, fallback) { return normalizeInteger(value, fallback, 1_000, 100_000_000); }
function normalizeInteger(value, fallback, minimum, maximum) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw inputError("phase5_value_invalid");
  return parsed;
}
function normalizeKey(value) {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(key)) throw inputError("phase5_idempotency_key_invalid");
  return key;
}
function inputError(code) { const error = new Error(code); error.code = code; error.statusCode = 422; return error; }
function digest(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function check(id, label, complete, detail) { return { id, label, complete: complete === true, detail: String(detail ?? "") }; }
