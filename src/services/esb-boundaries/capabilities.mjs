import { CAPABILITY_STATUS, DATA_MODES, EXTERNAL_CAPABILITIES, assertDataMode, boundaryError, deepFreeze, requiredText } from "./contract.mjs";

const CAPABILITY_SET = new Set(EXTERNAL_CAPABILITIES);

export function createDisabledCapabilityCatalog({ dataMode = DATA_MODES.REAL } = {}) {
  assertDataMode(dataMode);
  return deepFreeze(EXTERNAL_CAPABILITIES.map((capability) => ({
    capability,
    status: CAPABILITY_STATUS.DISABLED,
    enabled: false,
    dataMode,
    label: dataMode === DATA_MODES.REAL ? "REAL DATA - INACTIVE" : "SYNTHETIC DATA - INACTIVE",
    externalSideEffectsAllowed: false,
    businessClaimAllowed: false,
  })));
}

export class DisabledCapabilityAdapter {
  constructor({ capability, dataMode = DATA_MODES.REAL } = {}) {
    this.capability = validCapability(capability);
    this.dataMode = assertDataMode(dataMode);
    this.enabled = false;
    this.status = CAPABILITY_STATUS.DISABLED;
  }

  descriptor() {
    return deepFreeze({
      capability: this.capability,
      status: this.status,
      enabled: false,
      dataMode: this.dataMode,
      label: this.dataMode === DATA_MODES.REAL ? "REAL DATA - INACTIVE" : "SYNTHETIC DATA - INACTIVE",
      externalSideEffectsAllowed: false,
      businessClaimAllowed: false,
    });
  }

  async execute() { throw boundaryError("external_capability_disabled", 503, { capability: this.capability }); }
}

export function createSyntheticCapabilityAdapter({ capability, handler } = {}) {
  capability = validCapability(capability);
  if (typeof handler !== "function") throw boundaryError("synthetic_capability_handler_required");
  return Object.freeze({
    capability,
    dataMode: DATA_MODES.SYNTHETIC,
    enabled: true,
    status: CAPABILITY_STATUS.SYNTHETIC_READY,
    descriptor: () => deepFreeze({
      capability,
      status: CAPABILITY_STATUS.SYNTHETIC_READY,
      enabled: true,
      dataMode: DATA_MODES.SYNTHETIC,
      label: "SYNTHETIC DATA - LOCAL TEST ONLY",
      externalSideEffectsAllowed: false,
      businessClaimAllowed: false,
    }),
    execute: (context) => handler(deepFreeze(structuredClone(context))),
  });
}

function validCapability(value) {
  const capability = requiredText(value, "external_capability_required", 64).toUpperCase();
  if (!CAPABILITY_SET.has(capability)) throw boundaryError("external_capability_invalid");
  return capability;
}
