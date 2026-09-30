import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 2048;
const MAX_TTL_SECONDS = 31 * 24 * 60 * 60;

export function createTableOrderAccess({
  rootKey,
  organizationId,
  outletId,
  tables,
  clock = () => new Date(),
  keyId = "table-order-v1",
} = {}) {
  const secret = Buffer.isBuffer(rootKey) ? Buffer.from(rootKey) : Buffer.from(String(rootKey ?? ""), "utf8");
  if (secret.length < 32) throw accessError("table_order_signing_key_invalid", 500);
  if (!validId(organizationId) || !validId(outletId) || !validId(keyId)) throw accessError("table_order_scope_invalid", 500);
  const tableMap = normalizeTables(tables);
  const signingKey = createHmac("sha256", secret).update("sagapos:table-order:access:v1").digest();

  function issue(tableId, { ttlSeconds = 8 * 60 * 60 } = {}) {
    const table = requireTable(tableId);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) throw accessError("table_order_ttl_invalid", 422);
    const issuedAt = Math.floor(clock().getTime() / 1000);
    const payload = Object.freeze({
      v: TOKEN_VERSION,
      kid: keyId,
      org: organizationId,
      outlet: outletId,
      table: table.id,
      tv: table.tokenVersion,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
      jti: randomUUID(),
    });
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return { token: `${encoded}.${sign(encoded)}`, expiresAt: new Date(payload.exp * 1000).toISOString(), table: publicTable(table) };
  }

  function verify(token) {
    const raw = String(token ?? "");
    if (!raw || raw.length > MAX_TOKEN_LENGTH) throw accessError("table_order_token_invalid", 401);
    const parts = raw.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw accessError("table_order_token_invalid", 401);
    const expected = Buffer.from(sign(parts[0]), "utf8");
    const supplied = Buffer.from(parts[1], "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw accessError("table_order_token_invalid", 401);
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
    catch { throw accessError("table_order_token_invalid", 401); }
    assertPayload(payload);
    const table = requireTable(payload.table);
    if (payload.tv !== table.tokenVersion) throw accessError("table_order_token_revoked", 401);
    const now = Math.floor(clock().getTime() / 1000);
    if (payload.iat > now + 60 || payload.exp <= now) throw accessError("table_order_token_expired", 401);
    return Object.freeze({
      organizationId,
      outletId,
      tableId: table.id,
      tableLabel: table.label,
      tokenVersion: table.tokenVersion,
      tokenId: payload.jti,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });
  }

  function assertSession(subject) {
    if (!subject || subject.role !== "table" || subject.organizationId !== organizationId || subject.outletId !== outletId) {
      throw accessError("table_order_session_scope_denied", 403);
    }
    const table = requireTable(subject.tableId);
    if (subject.tableTokenVersion !== table.tokenVersion) throw accessError("table_order_token_revoked", 401);
    const expiresAt = Date.parse(subject.tableTokenExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= clock().getTime()) throw accessError("table_order_token_expired", 401);
    return Object.freeze({ ...publicTable(table), organizationId, outletId });
  }

  function listTables() {
    return [...tableMap.values()].map(publicTable);
  }

  function requireTable(tableId) {
    const table = tableMap.get(String(tableId ?? ""));
    if (!table || table.active !== true) throw accessError("table_order_table_unavailable", 404);
    return table;
  }

  function sign(encoded) {
    return createHmac("sha256", signingKey).update(encoded).digest("base64url");
  }

  function assertPayload(payload) {
    const keys = Object.keys(payload ?? {}).sort().join(",");
    if (keys !== "exp,iat,jti,kid,org,outlet,table,tv,v" || payload.v !== TOKEN_VERSION || payload.kid !== keyId
      || payload.org !== organizationId || payload.outlet !== outletId || !validId(payload.table)
      || !validId(payload.jti) || !Number.isSafeInteger(payload.tv) || payload.tv < 1
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat
      || payload.exp - payload.iat > MAX_TTL_SECONDS) throw accessError("table_order_token_invalid", 401);
  }

  return Object.freeze({ issue, verify, assertSession, listTables, organizationId, outletId, keyId });
}

function normalizeTables(tables) {
  if (!Array.isArray(tables) || tables.length < 1 || tables.length > 200) throw accessError("table_order_tables_invalid", 500);
  const map = new Map();
  for (const input of tables) {
    const table = Object.freeze({
      id: String(input?.id ?? "").trim().toUpperCase(),
      label: String(input?.label ?? "").trim(),
      active: input?.active !== false,
      tokenVersion: Number(input?.tokenVersion ?? 1),
    });
    if (!validId(table.id) || table.label.length < 1 || table.label.length > 80 || !Number.isSafeInteger(table.tokenVersion) || table.tokenVersion < 1 || map.has(table.id)) {
      throw accessError("table_order_tables_invalid", 500);
    }
    map.set(table.id, table);
  }
  return map;
}

function publicTable(table) {
  return Object.freeze({ id: table.id, label: table.label, active: table.active, tokenVersion: table.tokenVersion });
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value);
}

function accessError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
