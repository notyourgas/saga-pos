import { nextPaymentPollDelay } from "../ui/payment-poll.js";

const UNCERTAIN_STATUSES = new Set(["PENDING", "UNKNOWN"]);

export function cashierCheckoutLocked(activeQris) {
  return Boolean(activeQris && UNCERTAIN_STATUSES.has(normalizeStatus(activeQris.payment?.status)));
}

export function cashierQrisPresentation({ payment, loading = false, attempt = 0, lastCheckedAt = "", errorMessage = "" } = {}) {
  const status = normalizeStatus(payment?.status);
  const automaticPaused = nextPaymentPollDelay(attempt) === null;
  const base = {
    status,
    tone: "pending",
    eyebrow: "QRIS · MENUNGGU",
    title: attempt ? "Belum ada konfirmasi baru" : "Menunggu konfirmasi customer",
    detail: automaticPaused
      ? "Pemeriksaan otomatis dijeda. Periksa manual sebelum membuat pesanan pengganti."
      : "Pesanan belum masuk antrean bar sampai server menyatakan paid.",
    safety: "Jangan buat QRIS atau order pengganti untuk customer ini sebelum statusnya dipastikan.",
    actionLabel: payment?.simulator === false ? "Periksa Status Server" : "Simulasikan QRIS Paid",
    automaticPaused,
    lastCheckedLabel: formatCheckedAt(lastCheckedAt),
  };

  if (loading) return { ...base, tone: "checking", title: "Memeriksa status ke server", detail: "Tunggu hasil server. Tombol dikunci untuk mencegah pemeriksaan ganda." };
  if (errorMessage) return { ...base, tone: "warning", eyebrow: "QRIS · PERLU DICEK", title: "Status belum dapat diperbarui", detail: errorMessage };
  if (status === "PAID") return { ...base, tone: "paid", eyebrow: "QRIS · TERKONFIRMASI", title: "Pembayaran terkonfirmasi", detail: "Order sudah diteruskan ke antrean bar tepat satu kali.", safety: "Tidak perlu membuat pembayaran atau order baru.", actionLabel: "" };
  if (status === "EXPIRED") return { ...base, tone: "warning", eyebrow: "QRIS · KEDALUWARSA", title: "QRIS sudah kedaluwarsa", detail: "Pesanan belum masuk antrean bar. Pastikan saldo customer sebelum membuat pembayaran baru.", actionLabel: "Periksa Status Lagi" };
  if (status === "FAILED") return { ...base, tone: "warning", eyebrow: "QRIS · BELUM BERHASIL", title: "Pembayaran belum berhasil", detail: "Server belum menerima pembayaran. Konfirmasi saldo customer sebelum mencoba metode lain.", actionLabel: "Periksa Status Lagi" };
  if (status === "CANCELLED") return { ...base, tone: "warning", eyebrow: "QRIS · DIBATALKAN", title: "Pembayaran dibatalkan", detail: "Order belum diproses. Pastikan saldo customer sebelum membuat pembayaran baru.", actionLabel: "Periksa Status Lagi" };
  return base;
}

function normalizeStatus(value) {
  return String(value || "UNKNOWN").toUpperCase();
}

function formatCheckedAt(value) {
  if (!value) return "";
  const checkedAt = new Date(value);
  if (Number.isNaN(checkedAt.getTime())) return "";
  return `Terakhir dicek ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(checkedAt)} waktu perangkat`;
}
