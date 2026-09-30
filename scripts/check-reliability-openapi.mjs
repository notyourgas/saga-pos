// Check the HTTP reliability surface against its OpenAPI contract. This is
// intentionally independent of a manually maintained endpoint count.
export function checkReliabilityOpenapi(spec, serverSource) {
  if (spec.openapi !== "3.1.0") throw new Error("reliability_openapi_version_invalid");
  const routes = [...serverSource.matchAll(/req\.method === "(POST)" && url\.pathname === "([^"]+)"/g)]
    .map(([, method, path]) => ({ method: method.toLowerCase(), path }))
    .filter(({ path }) => /^\/api\/operator\/esb\/(?:shifts|inventory)\//.test(path) || path === "/api/cashier/shifts/close");
  for (const [, expression, flags] of serverSource.matchAll(/url\.pathname\.match\(\/((?:\\.|[^/])+)\/([a-z]*)\)/g)) {
    const matcher = new RegExp(expression, flags);
    if (!matcher.test("/api/operator/esb/inventory/00000000-0000-4000-8000-000000000001")) continue;
    const path = Object.keys(spec.paths).find((path) => matcher.test(path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001")));
    if (!path) throw new Error("reliability_openapi_inventory_read_missing");
    routes.push({ method: "get", path });
  }
  if (!routes.length) throw new Error("reliability_http_routes_missing");
  const routeKeys = new Set(routes.map(({ method, path }) => `${method} ${path}`));
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation["x-sagapos-reliability"] && !routeKeys.has(`${method} ${path}`)) throw new Error(`reliability_openapi_route_stale:${path}`);
    }
  }
  for (const { method, path } of routes) {
    const operation = spec.paths[path]?.[method];
    if (!operation?.["x-sagapos-reliability"]) throw new Error(`reliability_openapi_route_missing:${path}`);
    if (!operation.security?.length || operation.security.some((requirement) => !Object.hasOwn(requirement, "operatorCookie")
      || (method === "post" && !Object.hasOwn(requirement, "csrfHeader")))) throw new Error(`reliability_openapi_auth_missing:${path}`);
    const retired = operation["x-sagapos-retired"];
    if (retired) {
      if (operation.deprecated !== true || !/^[a-z][a-z0-9_]{1,79}$/.test(retired)) throw new Error(`reliability_openapi_retirement_invalid:${path}`);
      if (Object.keys(operation.responses ?? {}).some((code) => /^2\d\d$/.test(code))) throw new Error(`reliability_openapi_retired_success_forbidden:${path}`);
      if (!operation.responses?.["410"]?.content?.["application/json"]?.schema) throw new Error(`reliability_openapi_retired_response_missing:${path}`);
    } else {
      if (method === "post" && (!operation.requestBody?.required || !operation.requestBody.content?.["application/json"]?.schema)) throw new Error(`reliability_openapi_input_missing:${path}`);
      if (!Object.entries(operation.responses ?? {}).some(([code, value]) => /^2\d\d$/.test(code) && value.content?.["application/json"]?.schema)) throw new Error(`reliability_openapi_result_missing:${path}`);
      for (const status of ["401", "403", "404", "409", "422", "500", "503"]) {
        if (!operation.responses?.[status]?.content?.["application/json"]?.schema) throw new Error(`reliability_openapi_error_missing:${path}:${status}`);
      }
    }
    const capability = operation["x-sagapos-capability"];
    if (capability?.selfApprovalAllowed !== false || capability?.ownerOnlyApprovalCompletion !== false) throw new Error(`reliability_openapi_capability_invalid:${path}`);
  }
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      if (!value.$ref.startsWith("#/")) throw new Error("reliability_openapi_external_ref_forbidden");
      const resolved = value.$ref.slice(2).split("/").reduce((parent, key) => parent?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
      if (!resolved) throw new Error(`reliability_openapi_ref_missing:${value.$ref}`);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(spec);
  return { routes: routes.length };
}
