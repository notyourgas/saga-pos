import { readFile } from "node:fs/promises";
import { HrposRepository } from "../db/hrpos-repository.mjs";
import { HrposBridge } from "./hrpos-bridge.mjs";
import { HrposClient } from "./hrpos-client.mjs";

const sha = /^[0-9a-f]{40}$/;
const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const roles = new Set(["hr", "owner", "cashier", "bar", "staff"]);
const enabledKeys = new Set(["enabled", "posSourceSha", "workforceSourceSha", "baseUrl", "clientId", "clientSecret", "organizationId", "posOrganizationId", "redirectUri", "grants", "timeoutMs", "revocationRetry"]);

function invalid() { throw new Error("private_hrpos_configuration_invalid"); }
function exactKeys(value, allowed) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.has(key)); }
function httpsUrl(value, path) {
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== path) invalid();
  return url.href;
}

export function parsePrivateHrposConfig(raw, { sourceSha, runtimeIds }) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 65536 || !sha.test(sourceSha ?? "")) invalid();
  let config;
  try { config = JSON.parse(raw.toString("utf8")); } catch { invalid(); }
  if (config?.enabled === false) {
    if (!exactKeys(config, new Set(["enabled"]))) invalid();
    return Object.freeze({ enabled: false });
  }
  if (config?.enabled !== true || !exactKeys(config, enabledKeys)) invalid();
  if (!sha.test(config.posSourceSha ?? "") || config.posSourceSha !== sourceSha || !sha.test(config.workforceSourceSha ?? "")) invalid();
  if (!/^[a-z0-9_-]{1,80}$/.test(config.clientId ?? "") || typeof config.clientSecret !== "string" || config.clientSecret.length < 32 || config.clientSecret.length > 256) invalid();
  if (!ulid.test(config.organizationId ?? "") || !uuid.test(config.posOrganizationId ?? "") || config.posOrganizationId !== runtimeIds?.organizationId) invalid();
  const baseUrl = httpsUrl(config.baseUrl, "/");
  const redirectUri = httpsUrl(config.redirectUri, "/hr/callback");
  if (!Array.isArray(config.grants) || !config.grants.length || config.grants.length > 100) invalid();
  const seen = new Set();
  const grants = config.grants.map((grant) => {
    if (!exactKeys(grant, new Set(["userAccountId", "membershipId", "role"])) || !ulid.test(grant.userAccountId ?? "") || !ulid.test(grant.membershipId ?? "") || !roles.has(grant.role)) invalid();
    const identity = `${grant.userAccountId}:${grant.membershipId}:${grant.role}`; if (seen.has(identity)) invalid(); seen.add(identity);
    return Object.freeze({ userAccountId: grant.userAccountId, membershipId: grant.membershipId, role: grant.role });
  });
  const timeoutMs = config.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 5000) invalid();
  const retry = config.revocationRetry ?? { intervalMs: 30000, limit: 20 };
  if (!exactKeys(retry, new Set(["intervalMs", "limit"])) || !Number.isInteger(retry.intervalMs) || retry.intervalMs < 10000 || retry.intervalMs > 300000 || !Number.isInteger(retry.limit) || retry.limit < 1 || retry.limit > 100) invalid();
  return Object.freeze({ enabled: true, posSourceSha: config.posSourceSha, workforceSourceSha: config.workforceSourceSha, client: Object.freeze({ enabled: true, baseUrl, clientId: config.clientId, secret: config.clientSecret, organizationId: config.organizationId, posOrganizationId: config.posOrganizationId, redirectUri, grants, timeoutMs }), retry: Object.freeze({ intervalMs: retry.intervalMs, limit: retry.limit }) });
}

export async function loadPrivateHrpos({ credentialDirectory, sourceSha, runtimeIds, db }) {
  if (typeof credentialDirectory !== "string" || !credentialDirectory) invalid();
  const config = parsePrivateHrposConfig(await readFile(`${credentialDirectory}/hrpos-config`), { sourceSha, runtimeIds });
  if (!config.enabled) return { hrpos: null, retry: null, sourcePair: null };
  const key = await readFile(`${credentialDirectory}/hrpos-bridge-key`);
  if (key.length !== 32) invalid();
  const client = new HrposClient(config.client);
  const hrpos = new HrposBridge({ client, repository: new HrposRepository({ db, ids: runtimeIds }), encryptionKey: key, syntheticLoopback: false });
  return { hrpos, retry: config.retry, sourcePair: Object.freeze({ posSourceSha: config.posSourceSha, workforceSourceSha: config.workforceSourceSha }) };
}
