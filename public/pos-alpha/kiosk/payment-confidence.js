import { nextPaymentPollDelay } from "../ui/payment-poll.js";
export { nextPaymentPollDelay };

export function paymentCheckPresentation({ attempt = 0, loading = false, lastCheckedAt = "" } = {}) {
  const automaticCheckPaused = nextPaymentPollDelay(attempt) === null;
  if (loading) {
    return {
      title: "Memeriksa pembayaranmu",
      detail: "Tunggu sebentar. Jangan scan atau membayar ulang.",
      automaticCheckPaused,
      lastCheckedLabel: formatCheckedAt(lastCheckedAt),
    };
  }
  if (automaticCheckPaused) {
    return {
      title: "Masih menunggu konfirmasi",
      detail: "Pemeriksaan otomatis dijeda. Jika saldo sudah terpotong, cek status sekali lagi.",
      automaticCheckPaused: true,
      lastCheckedLabel: formatCheckedAt(lastCheckedAt),
    };
  }
  return {
    title: attempt ? "Belum ada konfirmasi baru" : "Menunggu konfirmasi pembayaran",
    detail: attempt ? "Kami akan memeriksa kembali secara otomatis." : "Layar akan diperbarui otomatis setelah pembayaran terkonfirmasi.",
    automaticCheckPaused: false,
    lastCheckedLabel: formatCheckedAt(lastCheckedAt),
  };
}

export function paymentRecoveryPresentation(status = "UNKNOWN") {
  const normalized = String(status || "UNKNOWN").toUpperCase();
  const presentations = {
    EXPIRED: {
      eyebrow: "STATUS · QR KEDALUWARSA",
      title: "Waktu QRIS habis",
      description: "QR ini sudah tidak dapat dipakai. Pesanan belum kami proses.",
      safety: "Jika saldo sudah terpotong, jangan membuat pembayaran baru. Cek status atau temui barista di kasir.",
      retryLabel: "Cek Status Sekali Lagi",
    },
    FAILED: {
      eyebrow: "STATUS · BELUM BERHASIL",
      title: "Pembayaran belum berhasil",
      description: "Kami belum menerima pembayaran untuk pesanan ini.",
      safety: "Jangan scan atau membayar ulang sebelum statusnya dipastikan.",
      retryLabel: "Cek Status Lagi",
    },
    CANCELLED: {
      eyebrow: "STATUS · DIBATALKAN",
      title: "Pembayaran dibatalkan",
      description: "Pesanan belum diproses dan belum masuk antrean bar.",
      safety: "Jika saldo berkurang, temui barista di kasir sebelum mencoba pembayaran baru.",
      retryLabel: "Cek Status Sekali Lagi",
    },
    UNKNOWN: {
      eyebrow: "STATUS · PERLU DIPASTIKAN",
      title: "Pembayaran belum selesai",
      description: "Status pembayaranmu belum dapat dipastikan. Pesanan belum kami proses.",
      safety: "Jika saldo sudah terpotong, jangan membayar ulang. Cek status agar tidak terjadi pembayaran ganda.",
      retryLabel: "Cek Status Lagi",
    },
  };
  return presentations[normalized] || presentations.UNKNOWN;
}

function formatCheckedAt(value) {
  if (!value) return "";
  const checkedAt = new Date(value);
  if (Number.isNaN(checkedAt.getTime())) return "";
  return `Terakhir dicek ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(checkedAt)}`;
}
