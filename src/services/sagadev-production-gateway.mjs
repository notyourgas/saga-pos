import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { createTrial99ProductionAuthorizer, evaluateProductionDirectCanaryConfig } from "../pos-alpha/production-direct-canary.mjs";
import { SagadevGatewayClient } from "./gateway-client.mjs";

const DEFAULT_BASE_URL = "https://platform.example.invalid";
const DEFAULT_HOST = "platform.example.invalid";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function loadSagadevProductionGateway({
  vaultPath,
  clock = () => new Date(),
  fetchImpl = globalThis.fetch,
  unprotectSecret = unprotectCurrentUserSecret,
} = {}) {
  if (!vaultPath) throw new Error("sagadev_gateway_vault_path_required");
  const record = validateRecord(JSON.parse(await readFile(vaultPath, "utf8")));
  const secret = await unprotectSecret(record.ciphertext);
  try {
    return createSagadevProductionGateway({ record, secret, clock, fetchImpl });
  } finally {
    if (Buffer.isBuffer(secret)) secret.fill(0);
  }
}

export async function loadSagadevSystemdProductionGateway({
  credentialDirectory,
  clock = () => new Date(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!credentialDirectory) throw new Error("sagadev_gateway_credentials_directory_required");
  let record;
  let secret;
  try {
    record = validateSystemdGatewayConfig(JSON.parse(await readFile(`${credentialDirectory}/sagadev-gateway-config`, "utf8")));
  } catch (error) {
    if (String(error?.message ?? "").startsWith("sagadev_gateway_")) throw error;
    throw new Error("sagadev_gateway_systemd_config_invalid");
  }
  try {
    secret = await readFile(`${credentialDirectory}/sagadev-gateway-outbound-secret`);
  } catch {
    throw new Error("sagadev_gateway_systemd_secret_required");
  }
  try {
    return createSagadevProductionGateway({ record, secret, clock, fetchImpl });
  } finally {
    secret.fill(0);
  }
}

export function createSagadevProductionGateway({ record: rawRecord, secret, clock = () => new Date(), fetchImpl = globalThis.fetch } = {}) {
  const record = validateGatewayConfig(rawRecord);
  const secretBytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret ?? ""), "utf8");
  if (secretBytes.length < 64 || secretBytes.length > 256) throw new Error("sagadev_gateway_secret_invalid");
  if (typeof fetchImpl !== "function") throw new Error("sagadev_gateway_fetch_required");

  const lazyGuard = () => createTrial99ProductionAuthorizer(record.canary, { clock });
  const signRequest = async ({ method, path, bodyHash, contractVersion }) => {
    const timestamp = clock().toISOString();
    const nonce = ulid(clock().getTime());
    const correlationId = ulid(clock().getTime());
    const canonical = [timestamp, nonce, record.keyId, method.toUpperCase(), path, bodyHash].join("\n");
    return {
      "X-Saga-Key-Id": record.keyId,
      "X-Saga-Timestamp": timestamp,
      "X-Saga-Nonce": nonce,
      "X-Saga-Signature": `v1=${createHmac("sha256", secretBytes).update(canonical).digest("hex")}`,
      "X-Saga-Contract-Version": contractVersion,
      "X-Correlation-Id": correlationId,
    };
  };
  const transport = async ({ method, path, headers, body }) => {
    const target = new URL(path, record.baseUrl);
    if (target.origin !== record.baseUrl || target.hostname !== DEFAULT_HOST || target.protocol !== "https:") {
      throw new Error("sagadev_gateway_transport_target_denied");
    }
    const response = await fetchImpl(target, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        ...(body == null ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("sagadev_gateway_response_not_json"); }
    if (!response.ok) {
      const code = String(payload?.error?.code ?? payload?.code ?? `HTTP_${response.status}`).replace(/[^A-Za-z0-9_.:-]/g, "_");
      const error = new Error(`sagadev_gateway_request_failed:${code}`);
      error.statusCode = response.status;
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    return payload;
  };

  const client = new SagadevGatewayClient({
    baseUrl: record.baseUrl,
    productCode: "sagaops",
    contractVersion: "1.0",
    credentialRef: record.credentialRef,
    transport,
    signRequest,
    verifyWebhook: () => false,
    clock,
    environment: "production",
    productionHostAllowlist: [DEFAULT_HOST],
    authorizeOperation: (context, usage) => lazyGuard().authorizeOperation(context, usage),
  });
  const readiness = async () => {
    const remote = await client.readiness();
    const local = evaluateProductionDirectCanaryConfig(record.canary, { clock });
    return {
      ...remote,
      localCanary: {
        ready: local.ready,
        result: local.result,
        windowOpen: local.windowOpen,
        missingFields: local.missingFields,
      },
    };
  };
  return {
    client,
    readiness,
    privatePromotionAuthorizer: {
      authorizePromotion: (input) => lazyGuard().authorizePromotion(input),
    },
    privateCanaryContext: structuredClone(record.privateCanaryContext),
    activation: Object.freeze({
      mode: "CONTROLLED_CANARY",
      deliveryMode: "signed_status_polling",
      providerBoundary: "SAGADEV_GATEWAY",
    }),
    publicConfig: {
      productCode: "sagaops",
      environment: "production",
      gatewayHost: DEFAULT_HOST,
      credentialRef: record.credentialRef,
      deviceRef: record.privateCanaryContext.deviceRef,
      valuesRedacted: true,
    },
  };
}

export function validateRecord(record = {}) {
  if (record.schemaVersion !== 1) throw new Error("sagadev_gateway_vault_schema_invalid");
  validateGatewayConfig(record);
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(record.ciphertext ?? "")) throw new Error("sagadev_gateway_ciphertext_invalid");
  if (record.protectionScope !== "CurrentUser") throw new Error("sagadev_gateway_protection_scope_invalid");
  return structuredClone(record);
}

export function validateSystemdGatewayConfig(record = {}) {
  if (record.schemaVersion !== 2 || record.secretSource !== "systemd-credential") throw new Error("sagadev_gateway_systemd_schema_invalid");
  const allowed = new Set(["schemaVersion", "secretSource", "keyId", "baseUrl", "credentialRef", "privateCanaryContext", "canary", "deliveryMode"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("sagadev_gateway_systemd_config_invalid");
  assertNoSecretFields(record);
  validateGatewayConfig(record);
  if (record.deliveryMode !== "signed_status_polling") throw new Error("sagadev_gateway_delivery_mode_invalid");
  return structuredClone(record);
}

function validateGatewayConfig(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("sagadev_gateway_config_invalid");
  if (![1, 2].includes(record.schemaVersion)) throw new Error("sagadev_gateway_config_schema_invalid");
  if (!/^key_sagaops_[a-z0-9_-]{12,80}$/.test(record.keyId ?? "")) throw new Error("sagadev_gateway_key_id_invalid");
  if (record.baseUrl !== DEFAULT_BASE_URL) throw new Error("sagadev_gateway_base_url_denied");
  if (!/^vault:\/\/[a-z0-9/_-]+$/i.test(record.credentialRef ?? "")) throw new Error("sagadev_gateway_credential_ref_invalid");
  if (record.privateCanaryContext?.privateCanary !== true || !/^private-ref:\/\/device\/[a-z0-9/_-]+$/i.test(record.privateCanaryContext?.deviceRef ?? "")) {
    throw new Error("sagadev_gateway_device_context_invalid");
  }
  return structuredClone(record);
}

function assertNoSecretFields(value, path = "root") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "secretSource" && /(password|secret|token|api[_-]?key|private[_-]?key|ciphertext)/i.test(key)) throw new Error(`sagadev_gateway_raw_secret_field_denied:${path}.${key}`);
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

export function unprotectCurrentUserSecret(ciphertext) {
  if (process.platform !== "win32") throw new Error("sagadev_gateway_dpapi_windows_required");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$cipher=[Console]::In.ReadToEnd().Trim()",
    "$bytes=[Convert]::FromBase64String($cipher)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "$stdout=[Console]::OpenStandardOutput()",
    "$stdout.Write($plain,0,$plain.Length)",
    "$stdout.Flush()",
    "[Array]::Clear($plain,0,$plain.Length)",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: Buffer.from(ciphertext, "utf8"),
    windowsHide: true,
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.length) throw new Error("sagadev_gateway_dpapi_unprotect_failed");
  return Buffer.from(result.stdout);
}

function ulid(timestamp) {
  let time = BigInt(timestamp);
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD[Number(time & 31n)] + head;
    time >>= 5n;
  }
  const entropy = randomBytes(10);
  let bits = 0n;
  for (const byte of entropy) bits = (bits << 8n) | BigInt(byte);
  let tail = "";
  for (let index = 0; index < 16; index += 1) {
    tail = CROCKFORD[Number(bits & 31n)] + tail;
    bits >>= 5n;
  }
  return head + tail;
}

export function requestFingerprint({ method, path, rawBody = "" } = {}) {
  return createHash("sha256").update([method, path, rawBody].join("\n")).digest("hex");
}
