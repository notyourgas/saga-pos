import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OperatorUatRuntime } from "./operator-runtime.mjs";

const publicRoot = fileURLToPath(new URL("../../public/uat/", import.meta.url));
const mime = new Map([[".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"]]);

export function createOperatorUatServer({ sharedPassword = randomBytes(9).toString("base64url"), ownerPin = randomPin(), clock = () => new Date(), scope = "LOCAL_INTERNAL_ALPHA" } = {}) {
  const runtime = new OperatorUatRuntime({ sharedPassword, ownerPin, clock });
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { alive: true, ready: true, scope, production: false, publicExposure: false, providers: { gateway: "SIMULATOR", email: "NOT_USED" }, hardware: { nfc: "NOT_RUN", printer: "NOT_RUN" } });
      if (req.method === "POST" && url.pathname === "/api/login") {
        assertSameOrigin(req);
        const body = await readJson(req);
        const actor = runtime.authenticate(body);
        const token = randomBytes(32).toString("base64url");
        const session = { id: randomUUID(), tokenHash: digest(token), csrfToken: randomBytes(24).toString("base64url"), actor, createdAt: clock().toISOString(), expiresAt: new Date(clock().getTime() + 4 * 60 * 60_000).toISOString() };
        sessions.set(session.tokenHash, session);
        res.setHeader("set-cookie", `sagaops_uat=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`);
        return json(res, 200, { authenticated: true, actor: session.actor, scope });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        const session = requireSession(req, sessions, clock);
        return json(res, 200, { ...runtime.snapshot(session.actor), csrfToken: session.csrfToken });
      }
      if (req.method === "POST" && url.pathname === "/api/actions") {
        assertSameOrigin(req);
        const session = requireSession(req, sessions, clock);
        assertCsrf(req, session);
        const body = await readJson(req);
        const result = await runtime.action(session.actor, body.action, body.payload);
        return json(res, 200, { ok: true, result });
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        assertSameOrigin(req);
        const session = requireSession(req, sessions, clock);
        assertCsrf(req, session);
        sessions.delete(session.tokenHash);
        res.setHeader("set-cookie", "sagaops_uat=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return json(res, 200, { authenticated: false });
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, req, res);
      return json(res, 404, { error: { code: "not_found" } });
    } catch (error) {
      const status = Number(error.statusCode ?? 500);
      return json(res, status, { error: { code: error.code ?? error.message ?? "internal_error", message: safeMessage(error.code ?? error.message) } });
    }
  });
  return { server, runtime, sharedPassword, ownerPin };
}

async function serveStatic(urlPath, req, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const relative = path.posix.normalize(requested).replace(/^\/+/, "");
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(path.resolve(publicRoot) + path.sep)) return json(res, 404, { error: { code: "not_found" } });
  let fileStat;
  try { fileStat = await stat(target); } catch { return json(res, 404, { error: { code: "not_found" } }); }
  if (!fileStat.isFile()) return json(res, 404, { error: { code: "not_found" } });
  res.writeHead(200, { "content-type": mime.get(path.extname(target)) ?? "application/octet-stream", "content-length": fileStat.size, "cache-control": "no-store" });
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
}

function requireSession(req, sessions, clock) {
  const token = parseCookies(req.headers.cookie).sagaops_uat;
  if (!token) throw apiError("authentication_required", 401);
  const tokenHash = digest(token);
  const session = sessions.get(tokenHash);
  if (!session || new Date(session.expiresAt) <= clock()) {
    sessions.delete(tokenHash);
    throw apiError("session_expired", 401);
  }
  return session;
}

function assertCsrf(req, session) {
  const supplied = String(req.headers["x-csrf-token"] ?? "");
  const expected = session.csrfToken;
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw apiError("csrf_invalid", 403);
}

function assertSameOrigin(req) {
  const expected = `http://${req.headers.host}`;
  if (req.headers.origin !== expected) throw apiError("origin_invalid", 403);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16_384) throw apiError("request_too_large", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw apiError("json_invalid", 400); }
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }));
}

function setSecurityHeaders(res) {
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()");
  res.setHeader("cache-control", "no-store");
}

function json(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function randomPin() { return String(1000 + (randomBytes(2).readUInt16BE(0) % 9000)); }

function apiError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function safeMessage(code) {
  const messages = {
    identity_invalid: "Organisasi, Employee ID, atau password tidak valid.",
    authentication_required: "Sesi UAT diperlukan.",
    session_expired: "Sesi berakhir. Silakan masuk kembali.",
    csrf_invalid: "Permintaan ditolak karena token keamanan tidak valid.",
    origin_invalid: "Permintaan lintas-origin ditolak.",
    shift_owned_by_other_staff: "Shift aktif dimiliki staff lain.",
    cash_session_open_required: "Buka shift sebelum melanjutkan.",
    approval_pin_invalid: "PIN approval tidak valid.",
    cash_variance_note_required: "Alasan selisih kas wajib diisi.",
  };
  return messages[code] ?? "Tindakan belum dapat diselesaikan. Periksa urutan UAT dan coba lagi.";
}
