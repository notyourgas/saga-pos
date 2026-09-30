import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sagaOpsGoal1Migrations } from "../src/db/local-postgres-runtime.mjs";
import { checkReliabilityOpenapi } from "./check-reliability-openapi.mjs";
import { checkRetiredClientRoutes } from "./check-retired-client-routes.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = await collect(appRoot);
const modules = files.filter((file) => file.endsWith(".mjs"));
for (const file of modules) {
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`syntax_invalid:${path.relative(appRoot, file)}:${check.stderr}`);
}

const openapi = JSON.parse(await readFile(path.join(appRoot, "openapi", "sagaops-api-v1.openapi.json"), "utf8"));
if (openapi.openapi !== "3.1.0" || !openapi.paths?.["/api/v1/pos/checkouts"]?.post) throw new Error("sagaops_openapi_contract_invalid");
const localPosOpenapi = JSON.parse(await readFile(path.join(appRoot, "openapi", "saga-pos-local-lab.openapi.json"), "utf8"));
if (localPosOpenapi.openapi !== "3.1.0" || !localPosOpenapi.paths?.["/api/cashier/checkouts"]?.post || !localPosOpenapi.paths?.["/api/admin/state"]?.get) throw new Error("saga_pos_local_openapi_contract_invalid");
const reliabilityOpenapi = checkReliabilityOpenapi(localPosOpenapi, await readFile(path.join(appRoot, "src/pos-alpha/server.mjs"), "utf8"));
const retiredClientRoutes = await checkRetiredClientRoutes({ appRoot, files });
for (const migration of sagaOpsGoal1Migrations.map((url) => url.pathname.split("/").at(-1))) {
  const sql = await readFile(path.join(appRoot, "migrations", "postgres", migration), "utf8");
  if (!/row level security/i.test(sql) && migration !== "20260622_sagaops_core_v1.sql") throw new Error(`sagaops_rls_marker_missing:${migration}`);
}
process.stdout.write(JSON.stringify({ result: "PASS", modules: modules.length, openapi: openapi.openapi, reliabilityRoutes: reliabilityOpenapi.routes, retiredClientRoutes, migrations: sagaOpsGoal1Migrations.length, scope: "SAGAOPS_LOCAL_STATIC" }) + "\n");

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(target));
    else output.push(target);
  }
  return output;
}
