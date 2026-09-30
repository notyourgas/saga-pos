import http from "node:http";
import { RETIRED_ROUTE_KEYS } from "../services/retired-route-telemetry.mjs";

export const SAGAOPS_API_VERSION = "1";
export const SAGAOPS_CONTRACT_ID = "sagaops-api-v1";

const requiredRepositoryMethods = [
  "findCheckoutSubmission",
  "withTransaction",
];

function response(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-saga-contract-version": SAGAOPS_API_VERSION,
      ...extraHeaders,
    },
    body,
  };
}

function apiError(status, code, message, correlationId) {
  return response(status, {
    error: { code, message, contract: SAGAOPS_CONTRACT_ID, correlationId },
  });
}

function validateRepository(repository) {
  for (const method of requiredRepositoryMethods) {
    if (typeof repository?.[method] !== "function") throw new Error(`repository_method_required:${method}`);
  }
}

export function createSagaOpsV1Handler({ repository, authenticate, createCorrelationId = () => crypto.randomUUID(), retiredRouteTelemetry = null }) {
  validateRepository(repository);
  if (typeof authenticate !== "function") throw new Error("authenticate_required");
  if (retiredRouteTelemetry && typeof retiredRouteTelemetry.observe !== "function") throw new Error("retired_route_telemetry_invalid");

  return async function handle(request) {
    const correlationId = request.correlationId ?? createCorrelationId();
    if (request.headers?.["x-saga-contract-version"] !== SAGAOPS_API_VERSION) {
      return apiError(426, "PLT_CONTRACT_VERSION_UNSUPPORTED", "Versi kontrak API tidak didukung.", correlationId);
    }
    if (request.method === "GET" && request.path === "/health") {
      return response(200, { status: "ok", contract: SAGAOPS_CONTRACT_ID });
    }
    if (request.method === "GET" && request.path === "/ready") {
      return response(200, { status: "ready", contract: SAGAOPS_CONTRACT_ID });
    }
    if (request.method !== "POST" || request.path !== "/api/v1/pos/checkouts") {
      return apiError(404, "NOT_FOUND", "Rute tidak ditemukan.", correlationId);
    }

    let actor;
    try { actor = await authenticate(request); }
    catch { return apiError(401, "AUTH_REQUIRED", "Autentikasi diperlukan.", correlationId); }
    if (!actor?.userProfileId || !actor?.role) return apiError(401, "AUTH_REQUIRED", "Autentikasi diperlukan.", correlationId);

    const evidence = retiredRouteTelemetry
      ? await retiredRouteTelemetry.observe(RETIRED_ROUTE_KEYS.CHECKOUT_V1, { headers: request.headers })
      : { correlationId };
    return apiError(410, "LEGACY_CHECKOUT_RETIRED", "Checkout API lama sudah dihentikan. Gunakan runtime SagaPOS yang menyimpan order dan pembayaran tanpa mengurangi stok sebelum PREPARING.", evidence.correlationId);
  };
}

async function readJsonBody(req, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createSagaOpsHttpServer({ handler, maximumBodyBytes = 256_000 }) {
  if (typeof handler !== "function") throw new Error("handler_required");
  return http.createServer(async (req, res) => {
    let result;
    const requestId = req.headers["x-request-id"] ?? crypto.randomUUID();
    try {
      const retiredCheckout = req.method === "POST" && new URL(req.url, "http://local.invalid").pathname === "/api/v1/pos/checkouts";
      const body = ["POST", "PUT", "PATCH"].includes(req.method) && !retiredCheckout ? await readJsonBody(req, maximumBodyBytes) : undefined;
      result = await handler({ method: req.method, path: new URL(req.url, "http://local.invalid").pathname, headers: req.headers, body, correlationId: requestId });
    } catch (error) {
      const isLarge = error.message === "payload_too_large";
      result = apiError(isLarge ? 413 : 400, isLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON", isLarge ? "Payload terlalu besar." : "JSON tidak valid.", requestId);
    }
    res.writeHead(result.status, result.headers);
    res.end(JSON.stringify(result.body));
  });
}
