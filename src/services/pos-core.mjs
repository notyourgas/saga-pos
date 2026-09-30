import { assertPermission } from "./permissions.mjs";

export function buildCashTenderOptions(totalRupiah, denominations = [20000, 50000, 100000]) {
  const total = normalizeMoney(totalRupiah);
  const roundedToTen = Math.ceil(total / 10000) * 10000;
  const candidates = [total, roundedToTen, ...denominations]
    .filter((amount) => amount >= total)
    .filter((amount, index, list) => list.indexOf(amount) === index)
    .sort((a, b) => a - b);

  return candidates.map((amount) => ({
    label: amount === total ? "Uang pas" : formatRupiah(amount),
    amountRupiah: total,
    receivedRupiah: amount,
    changeRupiah: amount - total,
    isExact: amount === total,
  }));
}

export function normalizePaymentPlan({ totalRupiah, payments }) {
  const total = normalizeMoney(totalRupiah);
  if (total === 0 && (!Array.isArray(payments) || payments.length === 0)) {
    return {
      payments: [{ methodNameSnapshot: "No Payment Required", methodType: "none", amountRupiah: 0, receivedRupiah: 0, changeRupiah: 0, settlementStatus: "not_applicable" }],
      paidRupiah: 0,
      receivedRupiah: 0,
      changeRupiah: 0,
      cashExpectedRupiah: 0,
    };
  }
  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error("payment_required");
  }

  const normalized = payments.map((payment) => {
    const amountRupiah = normalizeMoney(payment.amountRupiah);
    const receivedRupiah = payment.methodType === "cash"
      ? normalizeMoney(payment.receivedRupiah ?? amountRupiah)
      : amountRupiah;

    if (amountRupiah <= 0 && payment.methodType !== "none") {
      throw new Error("payment_amount_required");
    }

    if (payment.methodType === "cash" && receivedRupiah < amountRupiah) {
      throw new Error("cash_received_under_amount");
    }

    return {
      ...payment,
      amountRupiah,
      receivedRupiah,
      changeRupiah: payment.methodType === "cash" ? receivedRupiah - amountRupiah : 0,
      settlementStatus: payment.methodType === "cash" ? "settled" : "unchecked",
    };
  });

  const paidRupiah = normalized.reduce((sum, payment) => sum + payment.amountRupiah, 0);
  if (paidRupiah < total) {
    throw new Error("payment_underpaid");
  }

  return {
    payments: normalized,
    paidRupiah,
    receivedRupiah: normalized.reduce((sum, payment) => sum + payment.receivedRupiah, 0),
    changeRupiah: normalized.reduce((sum, payment) => sum + payment.changeRupiah, 0),
    cashExpectedRupiah: normalized
      .filter((payment) => payment.methodType === "cash")
      .reduce((sum, payment) => sum + payment.amountRupiah, 0),
  };
}

export async function submitPosCheckout({ request, actor, repository }) {
  assertPermission(actor.role, "pos:checkout");

  if (!request.idempotencyKey) {
    throw new Error("idempotency_key_required");
  }

  const error = new Error("legacy_checkout_inventory_authority_retired");
  error.code = error.message;
  error.statusCode = 410;
  throw error;
}

function normalizeMoney(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("money_amount_invalid");
  }
  return Math.round(amount);
}

function formatRupiah(amount) {
  return `Rp${new Intl.NumberFormat("id-ID").format(amount)}`;
}
