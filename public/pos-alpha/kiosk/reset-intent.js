const KEY = "saga_pos_completed_reset_v1";
export function createResetIntentStore(storage = () => globalThis.sessionStorage, history = () => globalThis.history) {
  function historyState(intent, remove = false) {
    try {
      const target = history();
      const current = target.state;
      if (current !== null && (typeof current !== "object" || Array.isArray(current))) return;
      const next = { ...current };
      if (remove) delete next[KEY];
      else next[KEY] = intent;
      target.replaceState(next, ""); // Do not change URL or append a navigation entry.
    } catch { /* Either persistence mechanism may be disabled independently. */ }
  }
  return {
    save(sessionId, orderId) {
      const intent = { sessionId, orderId };
      try { storage().setItem(KEY, JSON.stringify(intent)); } catch { /* Try history state. */ }
      historyState(intent);
    },
    matches(snapshot) {
      const intents = [];
      try { intents.push(JSON.parse(storage().getItem(KEY))); } catch { /* Try history state. */ }
      try { intents.push(history().state?.[KEY]); } catch { /* Live-page guard remains active. */ }
      return intents.some(intent => Boolean(intent?.sessionId && intent?.orderId
          && intent.sessionId === snapshot.session?.id
          && intent.orderId === snapshot.activeOrder?.id
          && ["PAID", "COMPLETED"].includes(snapshot.activeOrder?.status)
          && snapshot.payment?.status === "PAID"));
    },
    clear() {
      try { storage().removeItem(KEY); } catch { /* A stale intent cannot match a different session/order. */ }
      historyState(null, true);
    },
  };
}
