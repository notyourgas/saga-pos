import { createHash } from "node:crypto";

const CONTRACT = "SAGAPOS_HPP_V21_LEDGER_V28_ROLLBACK_READ_ONLY_V1";
const BASE_RUNTIME_SOURCE_SHA = "e1602833f3778aca906f13895d51a88050318252";
const FORWARD_WRITER_SOURCE_SHA = "3c3d835cc0e0bb3d98ecde30f400dfe61c00cd18";
const CANDIDATE_SOURCE_SHA = "683be05aa75d33df57edb133d0b7c4ae2b725e68";
const FORWARD_HPP_STATE_VERSION = 21;
const FORWARD_MIGRATION_COUNT = 28;
const FORWARD_MIGRATION_FINGERPRINT = "f87546126a2948d47d56ce9093a99e4f170c92521a1ea8508c16ad774f6e6052";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_STATE_NODES = 250_000;
const MAX_STATE_DEPTH = 64;
const STATE_KEYS = [
  "audit",
  "cogsAdjustments",
  "gateEnabled",
  "ingredients",
  "inventoryBalances",
  "inventoryCounts",
  "inventoryMovements",
  "inventoryPeriods",
  "inventoryReservations",
  "purchaseInvoiceCredits",
  "purchaseInvoices",
  "purchaseOrders",
  "purchaseReceiptInspectionDecisions",
  "purchaseReceipts",
  "recipes",
  "saleConsumptions",
  "stateVersion",
  "supplierReturns",
  "suppliers",
  "version",
];
const ARRAY_KEYS = STATE_KEYS.filter((key) => !["gateEnabled", "stateVersion", "version"].includes(key));
const CREDENTIAL_KEYS = [
  "baseRuntimeSourceSha",
  "candidateSourceSha",
  "contract",
  "forwardHppStateSha256",
  "forwardHppStateVersion",
  "forwardMigrationCount",
  "forwardMigrationFingerprint",
  "forwardWriterSourceSha",
];
const MARKER_KEYS = [
  "BASE_RUNTIME_SOURCE_SHA",
  "CANDIDATE_SOURCE_SHA",
  "CONTRACT",
  "FORWARD_HPP_STATE_VERSION",
  "FORWARD_MIGRATION_COUNT",
  "FORWARD_MIGRATION_FINGERPRINT",
  "FORWARD_WRITER_SOURCE_SHA",
];

export const HPP_V21_COMPATIBILITY = Object.freeze({
  contract: CONTRACT,
  baseRuntimeSourceSha: BASE_RUNTIME_SOURCE_SHA,
  candidateSourceSha: CANDIDATE_SOURCE_SHA,
  forwardWriterSourceSha: FORWARD_WRITER_SOURCE_SHA,
  forwardHppStateVersion: FORWARD_HPP_STATE_VERSION,
  forwardMigrationCount: FORWARD_MIGRATION_COUNT,
  forwardMigrationFingerprint: FORWARD_MIGRATION_FINGERPRINT,
});

export class HppV21RollbackReader {
  #state;

  constructor({ state, credential } = {}) {
    validateCredential(credential);
    validateOpaqueStateShape(state);
    if (canonicalStateSha256(state) !== credential.forwardHppStateSha256) invalid("hpp_v21_rollback_state_invalid");
    this.#state = structuredClone(state);
    Object.freeze(this);
  }

  exportState() {
    return structuredClone(this.#state);
  }

  readSummary() {
    const state = this.#state;
    return Object.freeze({
      stateVersion: state.stateVersion,
      aggregateVersion: state.version,
      gateEnabled: state.gateEnabled,
      ingredientCount: state.ingredients.length,
      inventoryBalanceCount: state.inventoryBalances.length,
      purchaseReceiptCount: state.purchaseReceipts.length,
      inventoryMovementCount: state.inventoryMovements.length,
      inventoryCountCount: state.inventoryCounts.length,
      saleConsumptionCount: state.saleConsumptions.length,
      inventoryReservationCount: state.inventoryReservations.length,
      cogsAdjustmentCount: state.cogsAdjustments.length,
    });
  }

  assertBusinessMutationAllowed() {
    invalid("hpp_forward_state_read_only", 503);
  }
}

export function parseHppV21RollbackMarker(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) invalid("hpp_v21_rollback_marker_invalid");
  const rows = raw.trimEnd().split(/\r?\n/);
  if (rows.length !== MARKER_KEYS.length) invalid("hpp_v21_rollback_marker_invalid");
  const entries = [];
  for (const row of rows) {
    const separator = row.indexOf("=");
    if (separator <= 0 || separator !== row.lastIndexOf("=")) invalid("hpp_v21_rollback_marker_invalid");
    const key = row.slice(0, separator);
    const value = row.slice(separator + 1);
    if (!/^[A-Z0-9_]+$/.test(key) || value.length === 0) invalid("hpp_v21_rollback_marker_invalid");
    entries.push([key, value]);
  }
  if (new Set(entries.map(([key]) => key)).size !== entries.length) invalid("hpp_v21_rollback_marker_invalid");
  const marker = Object.fromEntries(entries);
  if (!sameKeys(marker, MARKER_KEYS)
    || marker.CONTRACT !== CONTRACT
    || marker.BASE_RUNTIME_SOURCE_SHA !== BASE_RUNTIME_SOURCE_SHA
    || marker.CANDIDATE_SOURCE_SHA !== CANDIDATE_SOURCE_SHA
    || marker.FORWARD_WRITER_SOURCE_SHA !== FORWARD_WRITER_SOURCE_SHA
    || marker.FORWARD_HPP_STATE_VERSION !== String(FORWARD_HPP_STATE_VERSION)
    || marker.FORWARD_MIGRATION_COUNT !== String(FORWARD_MIGRATION_COUNT)
    || marker.FORWARD_MIGRATION_FINGERPRINT !== FORWARD_MIGRATION_FINGERPRINT) {
    invalid("hpp_v21_rollback_marker_invalid");
  }
  return HPP_V21_COMPATIBILITY;
}

export function canonicalStateSha256(state) {
  validateOpaqueStateShape(state);
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

function validateCredential(value) {
  if (!value || Array.isArray(value) || typeof value !== "object" || !sameKeys(value, CREDENTIAL_KEYS)
    || value.contract !== CONTRACT
    || value.baseRuntimeSourceSha !== BASE_RUNTIME_SOURCE_SHA
    || value.candidateSourceSha !== CANDIDATE_SOURCE_SHA
    || value.forwardWriterSourceSha !== FORWARD_WRITER_SOURCE_SHA
    || value.forwardHppStateVersion !== FORWARD_HPP_STATE_VERSION
    || value.forwardMigrationCount !== FORWARD_MIGRATION_COUNT
    || value.forwardMigrationFingerprint !== FORWARD_MIGRATION_FINGERPRINT
    || !/^[0-9a-f]{64}$/.test(value.forwardHppStateSha256 ?? "")) {
    invalid("hpp_v21_rollback_credential_invalid");
  }
}

function validateOpaqueStateShape(state) {
  if (!state || Array.isArray(state) || typeof state !== "object" || !sameKeys(state, STATE_KEYS)
    || state.stateVersion !== FORWARD_HPP_STATE_VERSION || !Number.isSafeInteger(state.version) || state.version < 1
    || typeof state.gateEnabled !== "boolean" || ARRAY_KEYS.some((key) => !Array.isArray(state[key]))) {
    invalid("hpp_v21_rollback_state_invalid");
  }
  let serialized;
  try { serialized = JSON.stringify(state); } catch { invalid("hpp_v21_rollback_state_invalid"); }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) invalid("hpp_v21_rollback_state_invalid");
}

function canonicalJson(value) {
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_STATE_NODES || depth > MAX_STATE_DEPTH) invalid("hpp_v21_rollback_state_invalid");
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number" && Number.isFinite(current)) return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map((item) => visit(item, depth + 1)).join(",")}]`;
    if (!current || typeof current !== "object" || Object.getPrototypeOf(current) !== Object.prototype) invalid("hpp_v21_rollback_state_invalid");
    const keys = Object.keys(current).sort();
    if (keys.some((key) => current[key] === undefined)) invalid("hpp_v21_rollback_state_invalid");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${visit(current[key], depth + 1)}`).join(",")}}`;
  };
  return visit(value, 0);
}

function sameKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function invalid(code, statusCode = 500) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
