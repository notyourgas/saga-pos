import { readFile } from "node:fs/promises";

const fields = new Set(["version", "sourceSha", "offsiteCopyVerified", "offsiteRestoreVerified", "loadTestPassed", "sopDrillPassed", "businessPilotAccepted", "verifiedAt"]);
const checks = ["offsiteCopyVerified", "offsiteRestoreVerified", "loadTestPassed", "sopDrillPassed", "businessPilotAccepted"];

export async function loadPhase7Evidence(expectedSourceSha, filePath = process.env.SAGA_POS_PHASE7_EVIDENCE_PATH ?? ".local/phase7-evidence.json") {
  let value;
  try { value = JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { sourceSha: expectedSourceSha };
    throw Error("phase7_evidence_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.keys(value).every((key) => fields.has(key))
    || value.version !== "SAGAPOS_PHASE7_EVIDENCE_V1"
    || !/^[0-9a-f]{40}$/.test(value.sourceSha)
    || !checks.every((key) => typeof value[key] === "boolean")
    || typeof value.verifiedAt !== "string" || Number.isNaN(Date.parse(value.verifiedAt))) {
    throw Error("phase7_evidence_invalid");
  }
  // Evidence is release-bound. A new code-only release may boot with the old
  // release's file present, but none of its readiness claims carry forward.
  if (value.sourceSha !== expectedSourceSha) return { sourceSha: expectedSourceSha };
  return value;
}
