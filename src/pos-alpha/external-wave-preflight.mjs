const RULES = Object.freeze({
  W26: {
    gate: "G26_SAGADEV_PRODUCTION_DIRECT_CANARY_ACCEPTED", dependsOn: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    fields: [
      "route", "gatewayUrl", "callbackUrl", "credentialRef", "signerRef", "verifierRef",
      "productRegistered", "transactionsEnabled", "productionHostAllowlisted", "killSwitchReady",
      "promotionCode", "discountPercent", "privateOnly", "maxTransactions",
      "settlementFixtureRef", "financeOwnerRef", "ownerAuthorizationRef",
    ],
  },
  W27: {
    gate: "G27_CUSTOMER_PLATFORM_ACCEPTED", dependsOn: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    fields: ["sandboxUrl", "credentialRef", "memberContractVersion", "rewardContractVersion", "piiReviewAccepted"],
  },
  W28: {
    gate: "G28_HARDWARE_NETWORK_ACCEPTED", dependsOn: ["G25_DURABLE_RUNTIME_ACCEPTED"],
    fields: ["hardwareAvailable", "kioskAssetRef", "kdsAssetRef", "printerAssetRef", "nfcAssetRef", "networkPlanRef", "accessibilityReviewerRef"],
  },
  W29: {
    gate: "G29_INSTALLED_RUNTIME_ACCEPTED", dependsOn: ["G25_DURABLE_RUNTIME_ACCEPTED", "G28_HARDWARE_NETWORK_ACCEPTED"],
    fields: ["targetOs", "signingIdentityRef", "artifactOutputRef", "updateChannel", "lastKnownGoodRef", "benchmarkAccepted"],
  },
  W30: {
    gate: "G30_STAGING_ACCEPTED", dependsOn: ["G25_DURABLE_RUNTIME_ACCEPTED", "G26_SAGADEV_PRODUCTION_DIRECT_CANARY_ACCEPTED", "G27_CUSTOMER_PLATFORM_ACCEPTED", "G29_INSTALLED_RUNTIME_ACCEPTED"],
    fields: ["stagingAuthorized", "stagingUrl", "sshProfileRef", "databaseRef", "queueRef", "backupRef", "monitoringRef"],
  },
  W31: {
    gate: "G31_STAFF_UAT_ACCEPTED", dependsOn: ["G28_HARDWARE_NETWORK_ACCEPTED", "G29_INSTALLED_RUNTIME_ACCEPTED", "G30_STAGING_ACCEPTED"],
    fields: ["rolesApproved", "staffRosterRef", "trainingScheduleRef", "deviceCustodyRef", "reviewerRef"],
  },
  W32: {
    gate: "G32_PILOT_ACCEPTED", dependsOn: ["G26_SAGADEV_PRODUCTION_DIRECT_CANARY_ACCEPTED", "G27_CUSTOMER_PLATFORM_ACCEPTED", "G28_HARDWARE_NETWORK_ACCEPTED", "G30_STAGING_ACCEPTED", "G31_STAFF_UAT_ACCEPTED"],
    fields: ["ownerAuthorizationRef", "windowStart", "windowEnd", "targetOrders", "supportRotaRef", "baselineRef", "stopConditionsAccepted"],
  },
  W33: {
    gate: "G33_PRODUCTION_ACTIVATED", dependsOn: ["G32_PILOT_ACCEPTED"],
    fields: ["sourcePushedMerged", "pilotAccepted", "productionConfigRef", "releaseApprovalRef", "activationApprovalRef", "rollbackRef", "monitoringRef"],
  },
  W34: {
    gate: "G34_BUSINESS_READY", dependsOn: ["G33_PRODUCTION_ACTIVATED"],
    fields: ["financeAcceptanceRef", "operationsAcceptanceRef", "independentAuditRef", "ownerAcceptanceRef", "businessReadyDecision"],
  },
});

const TRUE_FIELDS = new Set([
  "productRegistered", "transactionsEnabled", "piiReviewAccepted", "hardwareAvailable", "benchmarkAccepted",
  "stagingAuthorized", "rolesApproved", "stopConditionsAccepted", "sourcePushedMerged", "pilotAccepted", "businessReadyDecision",
  "productionHostAllowlisted", "killSwitchReady", "privateOnly",
]);
const URL_FIELDS = new Set(["sandboxUrl", "stagingUrl"]);
const VAULT_FIELDS = new Set(["credentialRef", "signerRef", "verifierRef", "signingIdentityRef", "databaseRef", "queueRef"]);
const REFERENCE_FIELDS = new Set([
  "settlementFixtureRef", "financeOwnerRef", "kioskAssetRef", "kdsAssetRef", "printerAssetRef", "nfcAssetRef",
  "networkPlanRef", "accessibilityReviewerRef", "artifactOutputRef", "lastKnownGoodRef", "backupRef", "monitoringRef",
  "staffRosterRef", "trainingScheduleRef", "deviceCustodyRef", "reviewerRef", "ownerAuthorizationRef", "supportRotaRef",
  "baselineRef", "productionConfigRef", "releaseApprovalRef", "activationApprovalRef", "rollbackRef", "financeAcceptanceRef",
  "operationsAcceptanceRef", "independentAuditRef", "ownerAcceptanceRef",
]);
const FORBIDDEN_KEYS = /(^|_)(password|secret|token|api[_-]?key|private[_-]?key|hmac[_-]?key)($|_)/i;

export function evaluateExternalWaveInputs(config, { acceptedGates = ["G25_DURABLE_RUNTIME_ACCEPTED"] } = {}) {
  assertNoRawSecretFields(config);
  const accepted = new Set(acceptedGates);
  const waves = [];
  for (const [waveId, rule] of Object.entries(RULES)) {
    const value = config?.[waveId] ?? {};
    const missing = rule.fields.filter((field) => !isAcceptedField(field, value[field]));
    const dependencyMissing = rule.dependsOn.filter((gate) => !accepted.has(gate));
    const inputComplete = missing.length === 0;
    const dependencyReady = dependencyMissing.length === 0;
    waves.push({
      waveId, gate: rule.gate,
      status: inputComplete && dependencyReady ? "READY_FOR_AUTHORIZED_EXECUTION_NOT_ACCEPTED" : "BLOCKED_EXTERNAL_INPUT",
      missingFields: missing,
      dependencyMissing,
      inputComplete,
      dependencyReady,
      gateAccepted: false,
    });
  }
  return {
    result: waves.every((wave) => wave.status === "READY_FOR_AUTHORIZED_EXECUTION_NOT_ACCEPTED") ? "INPUTS_COMPLETE_NOT_EVIDENCE" : "PASS_FAIL_CLOSED",
    currentReadiness: 84,
    readinessUnlocked: 0,
    acceptedExternalGates: [],
    readyWaves: waves.filter((wave) => wave.inputComplete && wave.dependencyReady).length,
    blockedWaves: waves.filter((wave) => wave.status === "BLOCKED_EXTERNAL_INPUT").length,
    productionMutationAllowed: false,
    waves,
  };
}

function isAcceptedField(field, value) {
  if (TRUE_FIELDS.has(field)) return value === true;
  if (field === "route") return value === "production_direct_controlled_canary";
  if (field === "promotionCode") return value === "TRIAL99";
  if (field === "discountPercent") return value === 99;
  if (field === "maxTransactions") return value === 5;
  if (["gatewayUrl", "callbackUrl"].includes(field)) return isProductionHttpsUrl(value);
  if (field === "targetOrders") return Number.isInteger(value) && value >= 200;
  if (URL_FIELDS.has(field)) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !/(^|[.-])(prod|production)([.-]|$)/i.test(url.hostname);
    } catch { return false; }
  }
  if (field === "sshProfileRef") return /^ssh-profile:\/\/[a-z0-9/_-]+$/i.test(value ?? "");
  if (VAULT_FIELDS.has(field)) return /^vault:\/\/[a-z0-9/_-]+$/i.test(value ?? "");
  if (REFERENCE_FIELDS.has(field)) return /^(restricted|private-ref):\/\/[a-z0-9/_-]+$/i.test(value ?? "");
  if (["windowStart", "windowEnd"].includes(field)) return !Number.isNaN(Date.parse(value));
  return typeof value === "string" && value.trim().length > 0;
}

function isProductionHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      && !/(^|[.-])(example|invalid|test)([.-]|$)/i.test(url.hostname);
  } catch { return false; }
}

function assertNoRawSecretFields(value, path = "root") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`raw_secret_field_denied:${path}.${key}`);
    assertNoRawSecretFields(child, `${path}.${key}`);
  }
}
