import { createPosAlphaServer } from "../src/pos-alpha/server.mjs";

const operatorPreview = process.env.SAGA_POS_OPERATOR_PREVIEW_MODE === "vercel-auth";
const operatorPreviewProject = process.env.VERCEL_PROJECT_PRODUCTION_URL === "preview.example.invalid";
if (operatorPreview && (process.env.VERCEL !== "1" || !operatorPreviewProject)) throw new Error("operator_preview_requires_dedicated_vercel_project");
const runtimeKey = Symbol.for(operatorPreview ? "sagaops.vercel.operator-preview.runtime" : "sagaops.vercel.public-demo.runtime");

if (!globalThis[runtimeKey]) {
  const app = createPosAlphaServer({ publicDemo: !operatorPreview, operatorPreview });
  globalThis[runtimeKey] = {
    app,
    handleRequest: app.server.listeners("request")[0],
  };
}

export default async function handler(request, response) {
  const route = Array.isArray(request.query?.path) ? request.query.path.join("/") : String(request.query?.path || "");
  const surface = String(request.query?.surface || "");
  const staticPath = String(request.query?.static || "");
  if (operatorPreview && ["dashboard", "kds"].includes(surface)) {
    request.url = `/${surface}`;
  } else if (operatorPreview && /^(?:operator\.js|pos-alpha\.css|assets\/fonts\/[a-z0-9._-]+)$/.test(staticPath)) {
    request.url = `/${staticPath}`;
  } else if (route) {
    const incoming = new URL(request.url, "http://vercel.internal");
    incoming.searchParams.delete("path");
    const query = incoming.searchParams.toString();
    request.url = `/api/${route}${query ? `?${query}` : ""}`;
  }
  return globalThis[runtimeKey].handleRequest(request, response);
}
