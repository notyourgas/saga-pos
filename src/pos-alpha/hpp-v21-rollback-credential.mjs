import { createHash } from "node:crypto";

import { HppCatalog } from "./hpp-catalog.mjs";
import { HPP_V21_COMPATIBILITY, canonicalStateSha256 } from "./hpp-v21-rollback-reader.mjs";

export function buildHppV21RollbackCredential({ state, migrationManifest } = {}) {
  validateWriterManifest(migrationManifest);
  try {
    const validator = new HppCatalog({ productProvider: () => [] });
    validator.restoreState(structuredClone(state));
    if (canonicalStateSha256(validator.exportState()) !== canonicalStateSha256(state)) invalid("hpp_v21_rollback_state_invalid");
  } catch (error) {
    if (error?.code === "hpp_v21_rollback_state_invalid") throw error;
    invalid("hpp_v21_rollback_state_invalid");
  }
  return Object.freeze({
    contract: HPP_V21_COMPATIBILITY.contract,
    baseRuntimeSourceSha: HPP_V21_COMPATIBILITY.baseRuntimeSourceSha,
    candidateSourceSha: HPP_V21_COMPATIBILITY.candidateSourceSha,
    forwardWriterSourceSha: HPP_V21_COMPATIBILITY.forwardWriterSourceSha,
    forwardHppStateVersion: HPP_V21_COMPATIBILITY.forwardHppStateVersion,
    forwardHppStateSha256: canonicalStateSha256(state),
    forwardMigrationCount: HPP_V21_COMPATIBILITY.forwardMigrationCount,
    forwardMigrationFingerprint: HPP_V21_COMPATIBILITY.forwardMigrationFingerprint,
  });
}

function validateWriterManifest(value) {
  if (!value || !Array.isArray(value.entries) || value.entries.length !== HPP_V21_COMPATIBILITY.forwardMigrationCount
    || value.fingerprint !== HPP_V21_COMPATIBILITY.forwardMigrationFingerprint) invalid("hpp_v21_rollback_manifest_invalid");
  const entries = value.entries.map(({ name, checksum } = {}) => ({ name, checksum }));
  if (entries.some(({ name, checksum }) => !/^20\d{6}[a-z0-9_]*\.sql$/.test(name ?? "") || !/^[0-9a-f]{64}$/.test(checksum ?? ""))
    || migrationFingerprint(entries) !== value.fingerprint) invalid("hpp_v21_rollback_manifest_invalid");
}

function migrationFingerprint(entries) {
  return createHash("sha256").update(entries.map(({ name, checksum }) => `${name}:${checksum}\n`).join("")).digest("hex");
}

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 500;
  throw error;
}
