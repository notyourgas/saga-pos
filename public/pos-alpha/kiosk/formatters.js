export function rupiah(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

export function maskReference(value) {
  const text = String(value ?? "");
  return text ? `•••• ${text.slice(-4).toUpperCase()}` : "••••";
}

export function formatCountdown(expiresAt, now = Date.now()) {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function safePngDataUrl(value) {
  const source = String(value ?? "");
  return /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(source) ? source : "";
}
