const POLL_DELAYS_MS = Object.freeze([2500, 4000, 6000, 10_000, 15_000, 20_000]);

export function nextPaymentPollDelay(attempt = 0) {
  const index = Math.max(0, Number(attempt) || 0);
  return index < POLL_DELAYS_MS.length ? POLL_DELAYS_MS[index] : null;
}
