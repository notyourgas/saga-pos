export const CHECKOUT_KEY_STORAGE = "saga_pos_checkout_key";

// Storage is best-effort; one live-page attempt must retain its key even when
// browser privacy/quota settings reject reads, writes or removal.
export function createCheckoutKeyStore({ storage = () => globalThis.sessionStorage, createKey = () => globalThis.crypto.randomUUID() } = {}) {
  let initialized = false;
  let key = null;
  return {
    get() {
      if (key) return key;
      if (!initialized) {
        initialized = true;
        try { key = storage()?.getItem(CHECKOUT_KEY_STORAGE) || null; } catch { /* use memory */ }
      }
      if (!key) key = createKey();
      try { storage()?.setItem(CHECKOUT_KEY_STORAGE, key); } catch { /* same key survives in memory */ }
      return key;
    },
    clear() {
      initialized = true; // Never re-import a stale value when removeItem fails.
      key = null;
      try { storage()?.removeItem(CHECKOUT_KEY_STORAGE); } catch { /* reset must remain usable */ }
    },
  };
}
