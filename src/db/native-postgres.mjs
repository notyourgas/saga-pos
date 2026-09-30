// Adapter for the repository contract. Every transaction holds one client.
export function nativePostgres(pool) {
  return {
    query: (sql, params = []) => pool.query(sql, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({ query: (sql, params = []) => client.query(sql, params), exec: (sql) => client.query(sql) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve original error. */ }
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

// The current domain runtime contains mutable projections. Serialize calls
// until database-owned multi-writer state replaces these projections.
export function serializeRuntime(runtime) {
  let tail = Promise.resolve();
  return new Proxy(runtime, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== "function") return value;
    return (...args) => {
      const result = tail.then(() => value.apply(target, args));
      tail = result.catch(() => {});
      return result;
    };
  } });
}
