const WRITE_VERSIONS = new Set(["OFF", "DUAL_WRITE_V1"]);
const READ_VERSIONS = new Set(["LEGACY_V1", "SHADOW_V1"]);

export const ESB_RUNTIME_DEFAULT = Object.freeze({
  writeVersion: "OFF",
  readVersion: "LEGACY_V1",
  providerPaymentsEnabled: false,
});

export function parseEsbRuntimeGuard(value = ESB_RUNTIME_DEFAULT) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("esb_runtime_guard_invalid");
  const allowed = new Set(["writeVersion", "readVersion", "providerPaymentsEnabled"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error("esb_runtime_guard_invalid");
  const writeVersion = value.writeVersion ?? ESB_RUNTIME_DEFAULT.writeVersion;
  const readVersion = value.readVersion ?? ESB_RUNTIME_DEFAULT.readVersion;
  if (!WRITE_VERSIONS.has(writeVersion) || !READ_VERSIONS.has(readVersion)) throw new Error("esb_runtime_guard_invalid");
  // This wave never activates a real provider. A future release needs a separate
  // reviewed adapter and authorization instead of changing this guard at runtime.
  if (value.providerPaymentsEnabled === true) throw new Error("esb_provider_payment_activation_denied");
  return Object.freeze({ writeVersion, readVersion, providerPaymentsEnabled: false });
}
