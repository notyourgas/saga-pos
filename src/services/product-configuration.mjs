import { createHash } from "node:crypto";

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const EFFECT_TYPES = new Set(["ADD", "REMOVE", "REPLACE", "SET", "MULTIPLIER"]);

export class ProductConfigurationResolver {
  constructor({ tenantId, products = [], fulfillments = [] } = {}) {
    this.tenantId = identifier(tenantId, "tenant_id_required");
    this.products = new Map();
    this.fulfillments = new Map();
    this.externalProductMappings = new Map();
    for (const fulfillment of fulfillments) this.#registerFulfillment(fulfillment);
    for (const product of products) this.#registerProduct(product);
  }

  normalizeSelection(input) {
    if (input.externalChannel !== undefined && input.externalChannel !== null) throw domainError("external_channel_context_untrusted");
    return this.#normalizeSelection(input, new Set(), null);
  }

  #normalizeSelection(input, ancestors, trustedExternalChannel) {
    const product = this.#product(input.productId);
    if (ancestors.has(product.id)) throw domainError("bundle_configuration_cycle");
    const lineage = new Set(ancestors);
    lineage.add(product.id);
    const fulfillment = this.fulfillments.get(identifier(input.fulfillmentId, "fulfillment_id_required"));
    if (!fulfillment || !fulfillment.active) throw domainError("fulfillment_unavailable");
    if (!product.fulfillmentIds.includes(fulfillment.id)) throw domainError("product_fulfillment_invalid");
    const variant = product.variants.get(identifier(input.variantId, "variant_id_required"));
    if (!variant || !variant.active || variant.soldOut) throw domainError("variant_unavailable");
    const requestedByGroup = new Map();
    for (const selection of input.modifierSelections ?? []) {
      const groupId = identifier(selection.groupId, "modifier_group_id_required");
      if (requestedByGroup.has(groupId)) throw domainError("modifier_group_duplicate");
      requestedByGroup.set(groupId, uniqueIdentifiers(selection.modifierIds ?? [], "modifier_id_invalid"));
    }
    const groups = [];
    for (const group of product.modifierGroups.values()) {
      const requested = requestedByGroup.get(group.id);
      let selected = requested ?? group.defaultModifierIds;
      if (requested === undefined && group.required && selected.length === 0) throw domainError("modifier_group_required");
      if (selected.length < group.minimum || selected.length > group.maximum) throw domainError("modifier_group_cardinality_invalid");
      selected = [...selected].sort();
      const modifiers = selected.map((modifierId) => {
        const modifier = group.modifiers.get(modifierId);
        if (!modifier) throw domainError("modifier_not_found");
        if (!modifier.active || modifier.soldOut) throw domainError("modifier_unavailable");
        if (modifier.allowedVariantIds.length > 0 && !modifier.allowedVariantIds.includes(variant.id)) throw domainError("modifier_variant_dependency_invalid");
        if (modifier.allowedFulfillmentIds.length > 0 && !modifier.allowedFulfillmentIds.includes(fulfillment.id)) throw domainError("modifier_fulfillment_dependency_invalid");
        return modifier;
      });
      groups.push({ groupId: group.id, modifierIds: modifiers.map((modifier) => modifier.id) });
      requestedByGroup.delete(group.id);
    }
    if (requestedByGroup.size > 0) throw domainError("modifier_group_not_found");
    const bundleItems = this.#normalizeBundleSelections(product, input.bundleSelections ?? [], fulfillment.id, lineage);
    const selection = {
      productId: product.id,
      variantId: variant.id,
      fulfillmentId: fulfillment.id,
      modifierGroups: groups.sort((a, b) => a.groupId.localeCompare(b.groupId)),
      bundleItems,
      externalChannel: trustedExternalChannel,
    };
    const snapshot = {
      schemaVersion: 1,
      tenantId: this.tenantId,
      selection,
      ruleVersions: {
        product: product.version,
        variant: variant.version,
        modifierGroups: groups.map(({ groupId, modifierIds }) => ({ groupId, groupVersion: product.modifierGroups.get(groupId).version, modifiers: modifierIds.map((id) => ({ id, version: product.modifierGroups.get(groupId).modifiers.get(id).version })) })),
        fulfillment: fulfillment.version,
      },
    };
    return { ...snapshot, fingerprint: sha256(snapshot) };
  }

  #normalizeBundleSelections(product, inputs, fulfillmentId, lineage) {
    if (!Array.isArray(inputs)) throw domainError("bundle_selection_invalid");
    const bySlot = new Map();
    for (const input of inputs) {
      const slotId = identifier(input.slotId, "bundle_slot_id_required");
      if (bySlot.has(slotId)) throw domainError("bundle_slot_duplicate");
      bySlot.set(slotId, input);
    }
    const result = [];
    for (const rule of product.bundleRules) {
      const selected = bySlot.get(rule.slotId);
      if (!selected && rule.required) throw domainError("bundle_slot_required");
      if (!selected) continue;
      const childProductId = identifier(selected.productId, "bundle_product_id_required");
      if (!rule.allowedProductIds.includes(childProductId)) throw domainError("bundle_product_invalid");
      const child = this.products.get(childProductId);
      if (!child || !child.fulfillmentIds.includes(fulfillmentId)) throw domainError("bundle_product_unavailable");
      const childConfiguration = this.#normalizeSelection({
        productId: childProductId,
        variantId: selected.variantId,
        fulfillmentId,
        modifierSelections: selected.modifierSelections ?? [],
        bundleSelections: selected.bundleSelections ?? [],
      }, lineage, null);
      result.push({ slotId: rule.slotId, productId: childProductId, configuration: childConfiguration });
      bySlot.delete(rule.slotId);
    }
    if (bySlot.size > 0) throw domainError("bundle_slot_not_found");
    return result.sort((a, b) => a.slotId.localeCompare(b.slotId));
  }

  resolveInventoryEffects({ normalizedSelection, baseRequirements }) {
    if (!normalizedSelection || normalizedSelection.schemaVersion !== 1 || normalizedSelection.tenantId !== this.tenantId) throw domainError("configuration_scope_mismatch");
    if (normalizedSelection.fingerprint !== sha256({ schemaVersion: normalizedSelection.schemaVersion, tenantId: normalizedSelection.tenantId, selection: normalizedSelection.selection, ruleVersions: normalizedSelection.ruleVersions })) throw domainError("configuration_snapshot_invalid");
    const product = this.#product(normalizedSelection.selection.productId);
    assertSnapshotRules(normalizedSelection, product, this.fulfillments, this.products, this.tenantId);
    const requirements = new Map();
    for (const line of baseRequirements ?? []) {
      const itemId = identifier(line.itemId, "requirement_item_id_invalid");
      if (requirements.has(itemId)) throw domainError("requirement_item_duplicate");
      requirements.set(itemId, parseNonNegative(line.normalizedQuantity, "requirement_quantity_invalid"));
    }
    const effects = [];
    effects.push(...product.variants.get(normalizedSelection.selection.variantId).inventoryEffects);
    for (const selection of normalizedSelection.selection.modifierGroups) {
      const group = product.modifierGroups.get(selection.groupId);
      for (const modifierId of selection.modifierIds) effects.push(...group.modifiers.get(modifierId).inventoryEffects);
    }
    effects.push(...this.fulfillments.get(normalizedSelection.selection.fulfillmentId).inventoryEffects);
    for (const effect of effects) applyEffect(requirements, effect);
    const resolvedRequirements = [...requirements.entries()].filter(([, quantity]) => quantity > 0n).sort(([left], [right]) => left.localeCompare(right)).map(([itemId, quantity]) => ({ itemId, normalizedQuantity: formatScaled(quantity) }));
    const result = {
      configurationFingerprint: normalizedSelection.fingerprint,
      productId: product.id,
      resolvedRequirements,
      appliedEffects: effects.map((effect) => structuredClone(effect)),
    };
    return { ...result, fingerprint: sha256(result) };
  }

  normalizeExternalSelection({ channel, externalProductId, externalVariantId, externalModifierIds = [], fulfillmentId }) {
    const channelKey = text(channel, "external_channel_invalid").toUpperCase();
    const mappingKey = `${channelKey}\u0000${text(externalProductId, "external_product_id_invalid")}`;
    const indexed = this.externalProductMappings.get(mappingKey);
    if (!indexed) throw domainError("external_product_mapping_not_found");
    const product = this.products.get(indexed.productId);
    const mapping = indexed.mapping;
    const variantId = mapping.variantMappings[externalVariantId];
    if (!variantId) throw domainError("external_variant_mapping_not_found");
    const modifierSelectionsByGroup = new Map();
    for (const externalId of externalModifierIds) {
      const target = mapping.modifierMappings[externalId];
      if (!target) throw domainError("external_modifier_mapping_not_found");
      const values = modifierSelectionsByGroup.get(target.groupId) ?? [];
      values.push(target.modifierId);
      modifierSelectionsByGroup.set(target.groupId, values);
    }
    return this.#normalizeSelection({
      productId: product.id,
      variantId,
      fulfillmentId,
      modifierSelections: [...modifierSelectionsByGroup].map(([groupId, modifierIds]) => ({ groupId, modifierIds })),
    }, new Set(), channelKey);
  }

  #registerProduct(input) {
    const id = identifier(input.id, "product_id_required");
    if (this.products.has(id)) throw domainError("product_id_conflict");
    rejectPricingFields(input);
    const variants = new Map();
    for (const variantInput of input.variants ?? []) {
      rejectPricingFields(variantInput);
      const variant = {
        id: identifier(variantInput.id, "variant_id_required"),
        version: positiveInteger(variantInput.version, "variant_version_invalid"),
        active: variantInput.active !== false,
        soldOut: Boolean(variantInput.soldOut),
        inventoryEffects: validateEffects(variantInput.inventoryEffects ?? []),
      };
      if (variants.has(variant.id)) throw domainError("variant_id_conflict");
      variants.set(variant.id, variant);
    }
    if (variants.size === 0) throw domainError("product_variant_required");
    const modifierGroups = new Map();
    for (const groupInput of input.modifierGroups ?? []) {
      rejectPricingFields(groupInput);
      const modifiers = new Map();
      for (const modifierInput of groupInput.modifiers ?? []) {
        rejectPricingFields(modifierInput);
        const modifier = {
          id: identifier(modifierInput.id, "modifier_id_required"),
          version: positiveInteger(modifierInput.version, "modifier_version_invalid"),
          active: modifierInput.active !== false,
          soldOut: Boolean(modifierInput.soldOut),
          allowedVariantIds: uniqueIdentifiers(modifierInput.allowedVariantIds ?? [], "variant_id_invalid"),
          allowedFulfillmentIds: uniqueIdentifiers(modifierInput.allowedFulfillmentIds ?? [], "fulfillment_id_invalid"),
          inventoryEffects: validateEffects(modifierInput.inventoryEffects ?? []),
        };
        if (modifiers.has(modifier.id)) throw domainError("modifier_id_conflict");
        modifiers.set(modifier.id, modifier);
      }
      const minimum = nonNegativeInteger(groupInput.minimum ?? 0, "modifier_group_minimum_invalid");
      const maximum = nonNegativeInteger(groupInput.maximum ?? modifiers.size, "modifier_group_maximum_invalid");
      if (minimum > maximum || maximum > modifiers.size) throw domainError("modifier_group_cardinality_invalid");
      const group = {
        id: identifier(groupInput.id, "modifier_group_id_required"),
        version: positiveInteger(groupInput.version, "modifier_group_version_invalid"),
        required: Boolean(groupInput.required),
        minimum,
        maximum,
        defaultModifierIds: uniqueIdentifiers(groupInput.defaultModifierIds ?? [], "modifier_id_invalid"),
        modifiers,
      };
      if (group.required && group.minimum < 1) throw domainError("modifier_group_required_minimum_invalid");
      if (group.defaultModifierIds.some((modifierId) => !modifiers.has(modifierId))) throw domainError("modifier_default_not_found");
      if (modifierGroups.has(group.id)) throw domainError("modifier_group_id_conflict");
      modifierGroups.set(group.id, group);
    }
    const product = {
      id,
      version: positiveInteger(input.version, "product_version_invalid"),
      variants,
      modifierGroups,
      fulfillmentIds: uniqueIdentifiers(input.fulfillmentIds ?? [], "fulfillment_id_invalid"),
      bundleRules: validateBundleRules(input.bundleRules ?? []),
      externalMappings: validateExternalMappings(input.externalMappings ?? []),
    };
    if (product.fulfillmentIds.length === 0 || product.fulfillmentIds.some((fulfillmentId) => !this.fulfillments.has(fulfillmentId))) throw domainError("product_fulfillment_invalid");
    validateExternalTargets(product);
    for (const mapping of product.externalMappings) {
      const key = `${mapping.channel}\u0000${mapping.externalProductId}`;
      if (this.externalProductMappings.has(key)) throw domainError("external_product_mapping_conflict");
      this.externalProductMappings.set(key, { productId: product.id, mapping });
    }
    this.products.set(id, product);
  }

  #registerFulfillment(input) {
    rejectPricingFields(input);
    const id = identifier(input.id, "fulfillment_id_required");
    if (this.fulfillments.has(id)) throw domainError("fulfillment_id_conflict");
    this.fulfillments.set(id, {
      id,
      version: positiveInteger(input.version, "fulfillment_version_invalid"),
      active: input.active !== false,
      inventoryEffects: validateEffects(input.inventoryEffects ?? []),
    });
  }

  #product(id) {
    const product = this.products.get(identifier(id, "product_id_required"));
    if (!product) throw domainError("product_not_found", 404);
    return product;
  }
}

function validateEffects(values) {
  if (!Array.isArray(values)) throw domainError("inventory_effects_invalid");
  return values.map((input) => {
    rejectPricingFields(input);
    const type = String(input.type ?? "").toUpperCase();
    if (!EFFECT_TYPES.has(type)) throw domainError("inventory_effect_type_invalid");
    const effect = { type, itemId: identifier(input.itemId, "inventory_effect_item_required") };
    if (type === "REPLACE") {
      effect.replacementItemId = identifier(input.replacementItemId, "inventory_effect_replacement_required");
      effect.normalizedQuantity = formatScaled(parseNonNegative(input.normalizedQuantity, "inventory_effect_quantity_invalid"));
    } else if (type === "MULTIPLIER") {
      effect.factor = formatScaled(parseNonNegative(input.factor, "inventory_effect_factor_invalid"));
    } else {
      effect.normalizedQuantity = formatScaled(parseNonNegative(input.normalizedQuantity, "inventory_effect_quantity_invalid"));
    }
    return effect;
  });
}

function applyEffect(requirements, effect) {
  const current = requirements.get(effect.itemId) ?? 0n;
  if (effect.type === "ADD") setRequirement(requirements, effect.itemId, current + parseNonNegative(effect.normalizedQuantity));
  if (effect.type === "REMOVE") {
    const next = current - parseNonNegative(effect.normalizedQuantity);
    if (next < 0n) throw domainError("inventory_effect_negative_requirement");
    setRequirement(requirements, effect.itemId, next);
  }
  if (effect.type === "SET") setRequirement(requirements, effect.itemId, parseNonNegative(effect.normalizedQuantity));
  if (effect.type === "MULTIPLIER") setRequirement(requirements, effect.itemId, multiplyScaled(current, parseNonNegative(effect.factor)));
  if (effect.type === "REPLACE") {
    const quantity = parseNonNegative(effect.normalizedQuantity);
    if (current < quantity) throw domainError("inventory_effect_negative_requirement");
    setRequirement(requirements, effect.itemId, current - quantity);
    setRequirement(requirements, effect.replacementItemId, (requirements.get(effect.replacementItemId) ?? 0n) + quantity);
  }
}

function setRequirement(requirements, itemId, value) {
  if (formatScaled(value).length > 48) throw domainError("inventory_effect_overflow");
  requirements.set(itemId, value);
}

function validateBundleRules(values) {
  if (!Array.isArray(values)) throw domainError("bundle_rules_invalid");
  const seen = new Set();
  return values.map((input) => {
    const slotId = identifier(input.slotId, "bundle_slot_id_required");
    if (seen.has(slotId)) throw domainError("bundle_slot_duplicate");
    seen.add(slotId);
    return { slotId, required: Boolean(input.required), allowedProductIds: uniqueIdentifiers(input.allowedProductIds ?? [], "bundle_product_id_invalid") };
  });
}

function validateExternalMappings(values) {
  if (!Array.isArray(values)) throw domainError("external_mappings_invalid");
  const seen = new Set();
  return values.map((input) => {
    const channel = text(input.channel, "external_channel_invalid").toUpperCase();
    const externalProductId = text(input.externalProductId, "external_product_id_invalid");
    const key = `${channel}\u0000${externalProductId}`;
    if (seen.has(key)) throw domainError("external_product_mapping_conflict");
    seen.add(key);
    return { channel, externalProductId, variantMappings: structuredClone(input.variantMappings ?? {}), modifierMappings: structuredClone(input.modifierMappings ?? {}) };
  });
}

function validateExternalTargets(product) {
  for (const mapping of product.externalMappings) {
    for (const variantId of Object.values(mapping.variantMappings)) if (!product.variants.has(variantId)) throw domainError("external_variant_mapping_invalid");
    for (const target of Object.values(mapping.modifierMappings)) {
      const group = product.modifierGroups.get(target?.groupId);
      if (!group?.modifiers.has(target?.modifierId)) throw domainError("external_modifier_mapping_invalid");
    }
  }
}

function assertSnapshotRules(snapshot, product, fulfillments, products, tenantId, ancestors = new Set()) {
  if (snapshot.tenantId !== tenantId) throw domainError("configuration_scope_mismatch");
  if (snapshot.ruleVersions.product !== product.version) throw domainError("configuration_snapshot_stale");
  const variant = product.variants.get(snapshot.selection.variantId);
  if (!variant || !variant.active || variant.soldOut || snapshot.ruleVersions.variant !== variant.version) throw domainError("configuration_snapshot_stale");
  const fulfillment = fulfillments.get(snapshot.selection.fulfillmentId);
  if (!fulfillment || !fulfillment.active || !product.fulfillmentIds.includes(fulfillment.id) || snapshot.ruleVersions.fulfillment !== fulfillment.version) throw domainError("configuration_snapshot_stale");
  if (!Array.isArray(snapshot.selection.modifierGroups) || !Array.isArray(snapshot.ruleVersions.modifierGroups)
    || snapshot.selection.modifierGroups.length !== product.modifierGroups.size
    || snapshot.ruleVersions.modifierGroups.length !== product.modifierGroups.size) throw domainError("configuration_snapshot_invalid");
  const selectedGroups = new Map(snapshot.selection.modifierGroups.map((selection) => [selection.groupId, selection]));
  const versionGroups = new Map(snapshot.ruleVersions.modifierGroups.map((group) => [group.groupId, group]));
  if (selectedGroups.size !== product.modifierGroups.size || versionGroups.size !== product.modifierGroups.size) throw domainError("configuration_snapshot_invalid");
  for (const group of product.modifierGroups.values()) {
    const selection = selectedGroups.get(group.id);
    const groupSnapshot = versionGroups.get(group.id);
    if (!selection || !groupSnapshot || group.version !== groupSnapshot.groupVersion || !Array.isArray(selection.modifierIds) || !Array.isArray(groupSnapshot.modifiers)) throw domainError("configuration_snapshot_stale");
    if (selection.modifierIds.length < group.minimum || selection.modifierIds.length > group.maximum || (group.required && selection.modifierIds.length === 0)) throw domainError("modifier_group_cardinality_invalid");
    const selectedIds = uniqueIdentifiers(selection.modifierIds, "configuration_snapshot_invalid").sort();
    const versionIds = groupSnapshot.modifiers.map((modifier) => identifier(modifier.id, "configuration_snapshot_invalid")).sort();
    if (JSON.stringify(selectedIds) !== JSON.stringify(versionIds)) throw domainError("configuration_snapshot_invalid");
    for (const modifierSnapshot of groupSnapshot.modifiers) {
      const modifier = group.modifiers.get(modifierSnapshot.id);
      if (!modifier || !modifier.active || modifier.soldOut) throw domainError("modifier_unavailable");
      if (modifier.version !== modifierSnapshot.version) throw domainError("configuration_snapshot_stale");
      if (modifier.allowedVariantIds.length > 0 && !modifier.allowedVariantIds.includes(variant.id)) throw domainError("modifier_variant_dependency_invalid");
      if (modifier.allowedFulfillmentIds.length > 0 && !modifier.allowedFulfillmentIds.includes(fulfillment.id)) throw domainError("modifier_fulfillment_dependency_invalid");
    }
  }
  if (snapshot.selection.externalChannel !== null) {
    const channel = text(snapshot.selection.externalChannel, "configuration_snapshot_invalid").toUpperCase();
    if (!product.externalMappings.some((mapping) => mapping.channel === channel)) throw domainError("configuration_snapshot_invalid");
  }
  if (!Array.isArray(snapshot.selection.bundleItems)) throw domainError("configuration_snapshot_invalid");
  const lineage = new Set(ancestors);
  if (lineage.has(product.id)) throw domainError("bundle_configuration_cycle");
  lineage.add(product.id);
  const bundleItems = new Map(snapshot.selection.bundleItems.map((item) => [item.slotId, item]));
  if (bundleItems.size !== snapshot.selection.bundleItems.length) throw domainError("bundle_slot_duplicate");
  for (const rule of product.bundleRules) {
    const item = bundleItems.get(rule.slotId);
    if (!item && rule.required) throw domainError("bundle_slot_required");
    if (!item) continue;
    if (!rule.allowedProductIds.includes(item.productId)) throw domainError("bundle_product_invalid");
    const child = products.get(item.productId);
    if (!child || !item.configuration || item.configuration.fingerprint !== sha256({ schemaVersion: item.configuration.schemaVersion, tenantId: item.configuration.tenantId, selection: item.configuration.selection, ruleVersions: item.configuration.ruleVersions })) throw domainError("configuration_snapshot_invalid");
    assertSnapshotRules(item.configuration, child, fulfillments, products, tenantId, lineage);
    bundleItems.delete(rule.slotId);
  }
  if (bundleItems.size > 0) throw domainError("bundle_slot_not_found");
}

function rejectPricingFields(value) {
  const forbidden = ["price", "priceRupiah", "priceDelta", "priceDeltaRupiah", "freeAllowance", "promotion", "promotionId"];
  if (forbidden.some((field) => Object.hasOwn(value ?? {}, field))) throw domainError("pricing_field_not_allowed_in_inventory_rules");
}

function parseNonNegative(value, code = "decimal_invalid") {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(source) || source.length > 48) throw domainError(code);
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
}

function multiplyScaled(left, right) {
  const product = left * right;
  if (product % SCALE_FACTOR !== 0n) throw domainError("inventory_effect_precision_exceeded");
  return product / SCALE_FACTOR;
}

function formatScaled(value) {
  const whole = value / SCALE_FACTOR;
  const fraction = (value % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function uniqueIdentifiers(values, code) {
  if (!Array.isArray(values)) throw domainError(code);
  const result = values.map((value) => identifier(value, code));
  if (new Set(result).size !== result.length) throw domainError(code);
  return result;
}

function identifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw domainError(code);
  return normalized;
}

function text(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) throw domainError(code);
  return normalized;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw domainError(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw domainError(code);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function domainError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}
