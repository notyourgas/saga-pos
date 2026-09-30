export function createOperatorApiClient({
  getCsrfToken,
  onAuthenticationRequired = () => {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  if (typeof getCsrfToken !== "function" || typeof fetchImpl !== "function") throw new TypeError("operator_api_client_invalid");

  return async function request(url, { method = "GET", body, csrf = false } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    const maxAttempts = normalizedMethod === "GET" ? 2 : 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await requestOnce(url, {
          method: normalizedMethod,
          body,
          csrf,
          getCsrfToken,
          onAuthenticationRequired,
          fetchImpl,
          timeoutMs,
          setTimer,
          clearTimer,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !["network_unavailable", "request_timeout"].includes(error?.code)) throw error;
      }
    }
    throw lastError;
  };
}

async function requestOnce(url, { method, body, csrf, getCsrfToken, onAuthenticationRequired, fetchImpl, timeoutMs, setTimer, clearTimer }) {
  const controller = new AbortController();
  const timeout = setTimer(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(csrf ? { "x-csrf-token": getCsrfToken() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await readJson(response);
    if (!response.ok) {
      const requestId = data?.error?.requestId || response.headers?.get?.("x-request-id") || null;
      const message = data?.error?.message || "Permintaan belum dapat diselesaikan.";
      const error = new Error(requestId ? `${message} Referensi: ${requestId}.` : message);
      error.status = response.status;
      error.code = data?.error?.code || "request_failed";
      error.requestId = requestId;
      if (response.status === 401 && !String(url).endsWith("/api/operator/login")) onAuthenticationRequired(error);
      throw error;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw requestFailure("Respons SagaPOS tidak lengkap. Muat ulang halaman lalu coba lagi.", "response_invalid");
    return data;
  } catch (error) {
    if (typeof error?.code === "string") throw error;
    const writeWarning = method === "GET" ? "" : " Data tidak dikirim ulang otomatis untuk mencegah pencatatan ganda.";
    if (error?.name === "AbortError") throw requestFailure(`SagaPOS terlalu lama merespons.${writeWarning}`, "request_timeout");
    throw requestFailure(`Koneksi ke SagaPOS terputus sebelum server menjawab.${writeWarning}`, "network_unavailable");
  } finally {
    clearTimer(timeout);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw requestFailure("Respons SagaPOS tidak dapat dibaca. Muat ulang halaman lalu coba lagi.", "response_invalid");
  }
}

function requestFailure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
