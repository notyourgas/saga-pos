export function createApiClient(getCsrfToken) {
  return async function request(url, { method = "GET", body, csrf = false } = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(csrf ? { "x-csrf-token": getCsrfToken() } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (response.ok) throw invalidResponse();
        data = {};
      }
      if (!response.ok) {
        const requestId = data?.error?.requestId || response.headers?.get?.("x-request-id") || null;
        const message = data?.error?.message || "Permintaan belum dapat diselesaikan.";
        const error = new Error(requestId ? `${message} Referensi: ${requestId}.` : message);
        error.status = response.status;
        error.code = data?.error?.code || "request_failed";
        error.requestId = requestId;
        throw error;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidResponse();
      return data;
    } catch (error) {
      if (typeof error?.code === "string") throw error;
      const requestError = new Error(error?.name === "AbortError"
        ? "Layanan terlalu lama merespons. Coba lagi."
        : "Layanan belum dapat dihubungi. Periksa koneksi lalu coba lagi.");
      requestError.code = error?.name === "AbortError" ? "request_timeout" : "network_unavailable";
      throw requestError;
    } finally {
      window.clearTimeout(timeout);
    }
  };
}

function invalidResponse() {
  const error = new Error("Respons layanan belum lengkap. Periksa kembali tanpa membayar ulang.");
  error.code = "response_invalid";
  return error;
}
