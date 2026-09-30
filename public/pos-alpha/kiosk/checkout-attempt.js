const KEY = "saga_pos_checkout_attempt_v1";

// Retain the submitted request, not a newly priced draft. Bootstrap remains
// authoritative for session identity and any already-created order.
export function createCheckoutAttemptStore(storage = () => globalThis.sessionStorage, history = () => globalThis.history) {
  function updateHistory(saved, remove = false) {
    try {
      const target = history();
      const current = target.state;
      if (current !== null && Object.prototype.toString.call(current) !== "[object Object]") return;
      const next = { ...current };
      if (remove) delete next[KEY];
      else next[KEY] = saved;
      target.replaceState(next, ""); // Same entry and URL; no new navigation history.
    } catch { /* History and storage may be denied independently. */ }
  }
  return {
    save(sessionId, attempt) {
      const saved = { sessionId, attempt };
      try { storage().setItem(KEY, JSON.stringify(saved)); }
      catch { /* Same-entry history provides an independent best-effort copy. */ }
      updateHistory(saved);
    },
    read(sessionId) {
      const candidates = [];
      try { candidates.push(JSON.parse(storage().getItem(KEY))); } catch { /* Try history. */ }
      try { candidates.push(history().state?.[KEY]); } catch { /* Live-page guard remains available. */ }
      for (const saved of candidates) {
        if (!sessionId || saved?.sessionId !== sessionId) continue;
        const attempt = saved.attempt;
        if (!attempt || typeof attempt.idempotencyKey !== "string" || !attempt.idempotencyKey
          || !["DINE_IN", "TAKEAWAY"].includes(attempt.orderType)
          || !Array.isArray(attempt.cart) || !attempt.cart.length
          || !attempt.cart.every(line => line && typeof line.productId === "string" && Number.isInteger(line.qty) && line.qty > 0
            && (line.selections === undefined || (Array.isArray(line.selections) && line.selections.every(selection => selection && typeof selection === "object"))))
          || !attempt.expectedQuote || !Number.isSafeInteger(attempt.expectedQuote.totalRupiah)) continue;
        return attempt;
      }
      return null;
    },
    clear() {
      try { storage().removeItem(KEY); } catch { /* Best effort, session bound. */ }
      updateHistory(null, true);
    },
  };
}
