import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const migrationsRoot = new URL("../../migrations/postgres/", import.meta.url);
const manifestUrl = new URL("saga-pos-runtime-manifest.txt", migrationsRoot);
const migrationNamePattern = /^20\d{6}[a-z0-9_]*\.sql$/;

export async function loadRuntimeMigrationManifest() {
  const names = (await readFile(manifestUrl, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!names.length || new Set(names).size !== names.length || names.some((name) => !migrationNamePattern.test(name))) {
    throw new Error("runtime_migration_manifest_invalid");
  }
  const entries = [];
  for (const name of names) {
    const url = new URL(name, migrationsRoot);
    const body = await readFile(url);
    entries.push({ name, url, checksum: createHash("sha256").update(body).digest("hex") });
  }
  const fingerprint = createHash("sha256")
    .update(entries.map(({ name, checksum }) => `${name}:${checksum}\n`).join(""))
    .digest("hex");
  return { entries, fingerprint };
}

export async function loadPinnedRuntimeMigrationManifest({ entryCount, fingerprint } = {}) {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > 64 || !/^[0-9a-f]{64}$/.test(fingerprint ?? "")) {
    throw new Error("runtime_migration_pinned_manifest_invalid");
  }
  const current = await loadRuntimeMigrationManifest();
  if (current.entries.length < entryCount) throw new Error("runtime_migration_pinned_manifest_incomplete");
  const entries = current.entries.slice(0, entryCount);
  const actual = createHash("sha256").update(entries.map(({ name, checksum }) => `${name}:${checksum}\n`).join("")).digest("hex");
  if (actual !== fingerprint) throw new Error("runtime_migration_pinned_manifest_drift");
  return { entries, fingerprint: actual, pinnedPrefix: true, currentEntryCount: current.entries.length };
}

export async function verifyRuntimeMigrationLedger(db, expected) {
  expected ??= await loadRuntimeMigrationManifest();
  const result = await db.query("select name,checksum from public.sagaops_private_schema_migrations order by applied_at,name");
  const actual = new Map(result.rows.map((row) => [String(row.name), String(row.checksum)]));
  if (actual.size !== expected.entries.length) throw new Error("runtime_migration_ledger_incomplete");
  for (const entry of expected.entries) {
    if (actual.get(entry.name) !== entry.checksum) throw new Error("runtime_migration_ledger_drift");
  }
  return { count: expected.entries.length, fingerprint: expected.fingerprint };
}

export async function loadForwardSchemaCompatibilityManifest({
  credentialDirectory,
  sourceSha,
  candidateSourceSha,
  migrationFingerprint,
  baseManifest,
} = {}) {
  if (typeof credentialDirectory !== "string" || !credentialDirectory
    || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")
    || !/^[0-9a-f]{40}$/.test(candidateSourceSha ?? "")
    || !/^[0-9a-f]{64}$/.test(migrationFingerprint ?? "")) {
    throw new Error("runtime_migration_compatibility_source_invalid");
  }
  const base = baseManifest ?? await loadRuntimeMigrationManifest();
  validateManifest(base, "runtime_migration_compatibility_base_invalid");
  let raw;
  try { raw = await readFile(join(credentialDirectory, "rollback-migration-manifest")); }
  catch { throw new Error("runtime_migration_compatibility_credential_unavailable"); }
  if (raw.length === 0 || raw.length > 32_768) throw new Error("runtime_migration_compatibility_credential_invalid");
  let value;
  try { value = JSON.parse(raw.toString("utf8")); } catch { throw new Error("runtime_migration_compatibility_credential_invalid"); }
  const allowed = ["baseManifestFingerprint", "candidateSourceSha", "compatibilitySourceSha", "contract", "entries", "migrationFingerprint"];
  if (!value || Array.isArray(value) || typeof value !== "object"
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(allowed)
    || value.contract !== "SAGAPOS_FORWARD_SCHEMA_COMPATIBILITY_V1"
    || value.compatibilitySourceSha !== sourceSha
    || value.candidateSourceSha !== candidateSourceSha
    || value.baseManifestFingerprint !== base.fingerprint
    || value.migrationFingerprint !== migrationFingerprint
    || !Array.isArray(value.entries) || value.entries.length <= base.entries.length || value.entries.length > 64) {
    throw new Error("runtime_migration_compatibility_credential_invalid");
  }
  const entries = value.entries.map((entry) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object"
      || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["checksum", "name"])
      || !migrationNamePattern.test(entry.name ?? "") || !/^[0-9a-f]{64}$/.test(entry.checksum ?? "")) {
      throw new Error("runtime_migration_compatibility_credential_invalid");
    }
    return { name: entry.name, checksum: entry.checksum };
  });
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) throw new Error("runtime_migration_compatibility_credential_invalid");
  for (let index = 0; index < base.entries.length; index += 1) {
    if (entries[index].name !== base.entries[index].name || entries[index].checksum !== base.entries[index].checksum) {
      throw new Error("runtime_migration_compatibility_base_drift");
    }
  }
  const fingerprint = createHash("sha256")
    .update(entries.map(({ name, checksum }) => `${name}:${checksum}\n`).join(""))
    .digest("hex");
  if (fingerprint !== value.migrationFingerprint) throw new Error("runtime_migration_compatibility_fingerprint_drift");
  return { entries, fingerprint, compatibility: true, candidateSourceSha };
}

function validateManifest(value, code) {
  if (!value || !Array.isArray(value.entries) || !/^[0-9a-f]{64}$/.test(value.fingerprint ?? "")) throw new Error(code);
  const entries = value.entries.map(({ name, checksum } = {}) => ({ name, checksum }));
  if (!entries.length || entries.length > 64
    || entries.some(({ name, checksum }) => !migrationNamePattern.test(name ?? "") || !/^[0-9a-f]{64}$/.test(checksum ?? ""))
    || new Set(entries.map(({ name }) => name)).size !== entries.length) throw new Error(code);
  const fingerprint = createHash("sha256")
    .update(entries.map(({ name, checksum }) => `${name}:${checksum}\n`).join(""))
    .digest("hex");
  if (fingerprint !== value.fingerprint) throw new Error(code);
}
