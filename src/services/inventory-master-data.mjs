import { createHash, randomUUID } from "node:crypto";

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const MAX_INTEGER_DIGITS = 18;
const MAX_SCALED_MAGNITUDE = (10n ** BigInt(MAX_INTEGER_DIGITS + SCALE)) - 1n;
const ITEM_TYPES = new Set([
  "RAW_MATERIAL",
  "PREP_ITEM",
  "FINISHED_GOOD",
  "PACKAGING",
  "CONSUMABLE",
  "RESALE_GOOD",
]);
const ITEM_STATUSES = new Set(["ACTIVE", "INACTIVE", "DISCONTINUED", "MERGED"]);
const LOT_POLICIES = new Set(["NOT_REQUIRED", "OPTIONAL", "REQUIRED"]);
const OPERATIONAL_DIMENSION = "OPERATIONAL";
const STANDARD_CONVERSIONS = [
  ["kg", "gram", "1000"],
  ["gram", "kg", "0.001"],
  ["liter", "ml", "1000"],
  ["ml", "liter", "0.001"],
];

export class InventoryMasterData {
  constructor({ tenantId, clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.tenantId = requiredIdentifier(tenantId, "tenant_id_required");
    this.clock = clock;
    this.idFactory = idFactory;
    this.revision = 0;
    this.items = new Map();
    this.skuIndex = new Map();
    this.supplierProducts = new Map();
    this.supplierBarcodeIndex = new Map();
    this.conversions = new Map();
    this.reorderPolicies = new Map();
    this.merges = [];
    this.audit = [];
  }

  createItem(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const id = optionalIdentifier(input.itemId) ?? this.idFactory();
    if (this.items.has(id)) throw domainError("item_id_conflict");
    const sku = normalizeSku(input.sku);
    if (this.skuIndex.has(sku)) throw domainError("item_sku_conflict");
    const item = buildItem({ ...input, id, revision: this.revision + 1, createdAt: this.#now() });
    this.items.set(id, item);
    this.skuIndex.set(sku, id);
    this.#commitAudit("ITEM_CREATED", id, input.actorId, input.reason, { sku, itemType: item.itemType, itemHash: sha256(item) });
    return this.#result(item);
    });
  }

  updateItem(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const current = this.#activeItem(input.itemId);
    if (input.baseUom !== undefined) {
      const requestedBaseUom = validateUom(input.baseUom);
      if (requestedBaseUom.code !== current.baseUom.code || requestedBaseUom.dimension !== current.baseUom.dimension) throw domainError("item_base_uom_immutable", 409);
    }
    const sku = input.sku === undefined ? current.sku : normalizeSku(input.sku);
    const skuOwner = this.skuIndex.get(sku);
    if (skuOwner && skuOwner !== current.id) throw domainError("item_sku_conflict");
    const next = buildItem({
      ...current,
      ...input,
      id: current.id,
      sku,
      revision: this.revision + 1,
      createdAt: current.createdAt,
      updatedAt: this.#now(),
      mergedIntoItemId: null,
    });
    if (sku !== current.sku) {
      this.skuIndex.delete(current.sku);
      this.skuIndex.set(sku, current.id);
    }
    this.items.set(current.id, next);
    this.#commitAudit("ITEM_UPDATED", current.id, input.actorId, input.reason, { changes: changedItemFields(current, next), itemHash: sha256(next) });
    return this.#result(next);
    });
  }

  setItemStatus(input) {
    if (!ITEM_STATUSES.has(input.status) || input.status === "MERGED") throw domainError("item_status_invalid");
    return this.updateItem({ ...input, status: input.status });
  }

  setReorderPolicy(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const item = this.#activeItem(input.itemId);
    const locationId = requiredIdentifier(input.locationId, "location_id_required");
    const policy = validateReorderPolicy(input.policy);
    const key = `${item.id}\u0000${locationId}`;
    const record = {
      itemId: item.id,
      locationId,
      ...policy,
      revision: this.revision + 1,
      updatedAt: this.#now(),
    };
    this.reorderPolicies.set(key, record);
    this.#commitAudit("REORDER_POLICY_SET", item.id, input.actorId, input.reason, { locationId, mode: record.mode, recordHash: sha256(record) });
    return structuredClone(record);
    });
  }

  linkSupplierProduct(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const item = this.#activeItem(input.itemId);
    if (!item.flags.purchasable) throw domainError("item_not_purchasable");
    const supplierId = requiredIdentifier(input.supplierId, "supplier_id_required");
    const supplierSku = requiredText(input.supplierSku, "supplier_sku_required");
    const id = optionalIdentifier(input.supplierProductId) ?? this.idFactory();
    if (this.supplierProducts.has(id)) throw domainError("supplier_product_id_conflict");
    const barcodes = uniqueStrings(input.barcodes ?? [], "supplier_barcode_invalid");
    for (const barcode of barcodes) {
      const key = `${supplierId}\u0000${barcode}`;
      if (this.supplierBarcodeIndex.has(key)) throw domainError("supplier_barcode_conflict");
    }
    const packageHierarchy = validatePackageHierarchy(input.packageHierarchy, item.baseUom);
    const createdAt = this.#now();
    const record = {
      id,
      tenantId: this.tenantId,
      supplierId,
      itemId: item.id,
      supplierSku,
      barcodes,
      packageHierarchy,
      active: input.active !== false,
      version: 1,
      revision: this.revision + 1,
      createdAt,
      packageHistory: [{ version: 1, packageHierarchy: structuredClone(packageHierarchy), activeFrom: createdAt, revision: this.revision + 1 }],
    };
    this.supplierProducts.set(id, record);
    for (const barcode of barcodes) this.supplierBarcodeIndex.set(`${supplierId}\u0000${barcode}`, id);
    this.#commitAudit("SUPPLIER_PRODUCT_LINKED", item.id, input.actorId, input.reason, { supplierProductId: id, supplierId, recordHash: sha256(record) });
    return structuredClone(record);
    });
  }

  versionSupplierPackage(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const current = this.supplierProducts.get(requiredIdentifier(input.supplierProductId, "supplier_product_id_required"));
    if (!current) throw domainError("supplier_product_not_found", 404);
    const item = this.#activeItem(current.itemId);
    const packageHierarchy = validatePackageHierarchy(input.packageHierarchy, item.baseUom);
    const activeFrom = normalizeTimestamp(input.activeFrom ?? this.#now());
    const packageHistory = current.packageHistory ?? [{
      version: current.version,
      packageHierarchy: structuredClone(current.packageHierarchy),
      activeFrom: current.updatedAt ?? current.createdAt,
      revision: current.revision,
    }];
    const next = {
      ...current,
      packageHierarchy,
      active: input.active ?? current.active,
      version: current.version + 1,
      revision: this.revision + 1,
      updatedAt: this.#now(),
      packageHistory: [...packageHistory, {
        version: current.version + 1,
        packageHierarchy: structuredClone(packageHierarchy),
        activeFrom,
        revision: this.revision + 1,
      }],
    };
    this.supplierProducts.set(current.id, next);
    this.#commitAudit("SUPPLIER_PACKAGE_VERSIONED", item.id, input.actorId, input.reason, { supplierProductId: current.id, version: next.version, recordHash: sha256(next) });
    return structuredClone(next);
    });
  }

  defineItemConversion(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const item = this.#activeItem(input.itemId);
    const fromUom = validateUom(input.fromUom);
    const toUom = validateUom(input.toUom);
    if (fromUom.code === toUom.code) throw domainError("conversion_identity_invalid");
    const crossesDimension = fromUom.dimension !== toUom.dimension;
    const operational = fromUom.dimension === OPERATIONAL_DIMENSION || toUom.dimension === OPERATIONAL_DIMENSION;
    if ((crossesDimension || operational) && input.basis !== "ITEM_SPECIFIC") throw domainError("item_specific_conversion_required");
    if ((crossesDimension || operational) && !requiredText(input.ruleReference, "conversion_rule_reference_required")) throw domainError("conversion_rule_reference_required");
    const factorScaled = parsePositiveDecimal(input.factor, "conversion_factor_invalid");
    const key = conversionKey(item.id, fromUom.code, toUom.code);
    const prior = this.conversions.get(key) ?? [];
    const record = {
      itemId: item.id,
      fromUom,
      toUom,
      factor: formatScaled(factorScaled),
      factorScaled: factorScaled.toString(),
      basis: input.basis === "ITEM_SPECIFIC" ? "ITEM_SPECIFIC" : "SYSTEM_COMPATIBLE",
      ruleReference: input.ruleReference ?? null,
      version: prior.length + 1,
      activeFrom: normalizeTimestamp(input.activeFrom ?? this.#now()),
      revision: this.revision + 1,
    };
    this.conversions.set(key, [...prior, record]);
    this.#commitAudit("ITEM_CONVERSION_VERSIONED", item.id, input.actorId, input.reason, { fromUom: fromUom.code, toUom: toUom.code, version: record.version, recordHash: sha256(withoutInternalScale(record)) });
    return withoutInternalScale(record);
    });
  }

  normalizeQuantity({ itemId, quantity, uom, occurredAt = this.#now() }) {
    const originalItemId = requiredIdentifier(itemId, "item_id_required");
    const item = this.resolveItem(originalItemId).item;
    const conversionOwners = this.#resolutionIds(originalItemId);
    const originalUom = validateUom(uom);
    const quantityScaled = parseDecimal(quantity, "quantity_invalid");
    const path = this.#findConversionPath(item, originalUom, occurredAt, conversionOwners);
    let normalized = quantityScaled;
    for (const edge of path) normalized = multiplyScaled(normalized, BigInt(edge.factorScaled));
    return {
      itemId: item.id,
      originalItemId,
      originalQuantity: formatScaled(quantityScaled),
      originalUom: originalUom.code,
      normalizedQuantity: formatScaled(normalized),
      normalizedUom: item.baseUom.code,
      precisionScale: SCALE,
      conversionSnapshot: path.map(withoutInternalScale),
      occurredAt: normalizeTimestamp(occurredAt),
    };
  }

  mergeItems(input) {
    return this.#atomicMutation(() => {
    assertExpectedRevision(input.expectedRevision, this.revision);
    validateMutationMetadata(input);
    const source = this.#activeItem(input.sourceItemId);
    const target = this.#activeItem(input.targetItemId);
    if (source.id === target.id) throw domainError("item_merge_self_invalid");
    if (source.baseUom.code !== target.baseUom.code || source.baseUom.dimension !== target.baseUom.dimension) throw domainError("item_merge_base_uom_mismatch");
    if (source.itemType !== target.itemType) throw domainError("item_merge_type_mismatch");
    const rehomedSupplierProducts = [];
    for (const [supplierProductId, supplierProduct] of this.supplierProducts) {
      if (supplierProduct.itemId !== source.id) continue;
      const rehomed = { ...supplierProduct, itemId: target.id, revision: this.revision + 1 };
      this.supplierProducts.set(supplierProductId, rehomed);
      rehomedSupplierProducts.push({ id: supplierProductId, recordHash: sha256(rehomed) });
    }
    const rehomedReorderPolicies = [];
    const supersededReorderPolicies = [];
    for (const [key, policy] of [...this.reorderPolicies]) {
      if (policy.itemId !== source.id) continue;
      const targetKey = `${target.id}\u0000${policy.locationId}`;
      if (!this.reorderPolicies.has(targetKey)) {
        const rehomed = { ...policy, itemId: target.id, revision: this.revision + 1 };
        this.reorderPolicies.set(targetKey, rehomed);
        rehomedReorderPolicies.push({ itemId: target.id, locationId: policy.locationId, recordHash: sha256(rehomed) });
      } else {
        supersededReorderPolicies.push({ ...structuredClone(policy), recordHash: sha256(policy) });
      }
      this.reorderPolicies.delete(key);
    }
    const merged = {
      ...source,
      status: "MERGED",
      mergedIntoItemId: target.id,
      revision: this.revision + 1,
      updatedAt: this.#now(),
    };
    this.items.set(source.id, merged);
    const event = {
      sourceItemId: source.id,
      targetItemId: target.id,
      revision: this.revision + 1,
      occurredAt: this.#now(),
      actorId: requiredIdentifier(input.actorId, "actor_id_required"),
      reason: requiredText(input.reason, "reason_required"),
    };
    this.merges.push(event);
    this.#commitAudit("ITEM_MERGED", source.id, input.actorId, input.reason, {
      targetItemId: target.id,
      itemHash: sha256(merged),
      mergeHash: sha256(event),
      rehomedSupplierProducts,
      rehomedReorderPolicies,
      supersededReorderPolicies,
    });
    return { source: structuredClone(merged), target: structuredClone(target), merge: structuredClone(event) };
    });
  }

  resolveItem(itemId) {
    const originalItemId = requiredIdentifier(itemId, "item_id_required");
    const visited = new Set();
    let current = this.items.get(originalItemId);
    if (!current) throw domainError("item_not_found", 404);
    while (current.status === "MERGED") {
      if (visited.has(current.id)) throw domainError("item_merge_cycle_detected", 500);
      visited.add(current.id);
      current = this.items.get(current.mergedIntoItemId);
      if (!current) throw domainError("item_merge_target_missing", 500);
    }
    return { originalItemId, resolvedItemId: current.id, item: structuredClone(current) };
  }

  exportState() {
    const payload = {
      stateVersion: 1,
      tenantId: this.tenantId,
      revision: this.revision,
      items: [...this.items.values()],
      supplierProducts: [...this.supplierProducts.values()],
      conversions: [...this.conversions.values()].flat(),
      reorderPolicies: [...this.reorderPolicies.values()],
      merges: this.merges,
      audit: this.audit,
    };
    return structuredClone({ ...payload, stateHash: sha256(payload) });
  }

  restoreState(state) {
    if (!state || state.stateVersion !== 1 || state.tenantId !== this.tenantId || !Number.isSafeInteger(state.revision) || state.revision < 0) throw domainError("master_data_state_invalid", 500);
    const allowedStateKeys = ["audit", "conversions", "items", "merges", "reorderPolicies", "revision", "stateHash", "stateVersion", "supplierProducts", "tenantId"];
    if (JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(allowedStateKeys)) throw domainError("master_data_state_invalid", 500);
    const { stateHash, ...payload } = state;
    if (typeof stateHash !== "string" || stateHash !== sha256(payload)) throw domainError("master_data_state_tampered", 500);
    for (const key of ["items", "supplierProducts", "conversions", "reorderPolicies", "merges", "audit"]) {
      if (!Array.isArray(payload[key])) throw domainError("master_data_state_invalid", 500);
    }
    const items = new Map();
    const skuIndex = new Map();
    for (const stored of state.items) {
      const item = validateStoredItem(stored, state.revision);
      if (items.has(item.id) || skuIndex.has(item.sku)) throw domainError("master_data_state_invalid", 500);
      items.set(item.id, structuredClone(item));
      skuIndex.set(item.sku, item.id);
    }
    for (const item of items.values()) {
      if (item.status === "MERGED" && (!item.mergedIntoItemId || !items.has(item.mergedIntoItemId))) throw domainError("master_data_state_invalid", 500);
    }
    const supplierProducts = new Map();
    const supplierBarcodeIndex = new Map();
    for (const stored of state.supplierProducts) {
      const supplierProduct = validateStoredSupplierProduct(stored, items, state.revision, this.tenantId);
      if (supplierProducts.has(supplierProduct.id)) throw domainError("master_data_state_invalid", 500);
      for (const barcode of supplierProduct.barcodes) {
        const key = `${supplierProduct.supplierId}\u0000${barcode}`;
        if (supplierBarcodeIndex.has(key)) throw domainError("master_data_state_invalid", 500);
        supplierBarcodeIndex.set(key, supplierProduct.id);
      }
      supplierProducts.set(supplierProduct.id, structuredClone(supplierProduct));
    }
    const conversions = new Map();
    for (const stored of state.conversions) {
      const conversion = validateStoredConversion(stored, items, state.revision);
      const key = conversionKey(conversion.itemId, conversion.fromUom.code, conversion.toUom.code);
      const versions = conversions.get(key) ?? [];
      if (versions.some((item) => item.version === conversion.version)) throw domainError("master_data_state_invalid", 500);
      conversions.set(key, [...versions, structuredClone(conversion)]);
    }
    for (const versions of conversions.values()) {
      const ordered = versions.slice().sort((left, right) => left.version - right.version);
      if (ordered.some((entry, index) => entry.version !== index + 1)) throw domainError("master_data_state_invalid", 500);
    }
    const reorderPolicies = new Map();
    for (const stored of state.reorderPolicies) {
      if (!items.has(stored.itemId) || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > state.revision) throw domainError("master_data_state_invalid", 500);
      const record = { itemId: stored.itemId, locationId: requiredIdentifier(stored.locationId, "master_data_state_invalid"), ...validateReorderPolicy(stored), revision: stored.revision, updatedAt: normalizeTimestamp(stored.updatedAt) };
      const key = `${record.itemId}\u0000${record.locationId}`;
      if (reorderPolicies.has(key)) throw domainError("master_data_state_invalid", 500);
      reorderPolicies.set(key, record);
    }
    validateStoredAudit(state.audit, state.revision, this.tenantId);
    validateResolvedItems(items);
    validateStoredMerges(state.merges, items, state.revision);
    validateCanonicalState({ items, supplierProducts, conversions, reorderPolicies, merges: state.merges, audit: state.audit });
    this.revision = state.revision;
    this.items = items;
    this.skuIndex = skuIndex;
    this.supplierProducts = supplierProducts;
    this.supplierBarcodeIndex = supplierBarcodeIndex;
    this.conversions = conversions;
    this.reorderPolicies = reorderPolicies;
    this.merges = structuredClone(state.merges);
    this.audit = structuredClone(state.audit);
    return this.view();
  }

  view() {
    return structuredClone({
      tenantId: this.tenantId,
      revision: this.revision,
      items: [...this.items.values()],
      supplierProducts: [...this.supplierProducts.values()],
      conversions: [...this.conversions.values()].flat().map(withoutInternalScale),
      reorderPolicies: [...this.reorderPolicies.values()],
      merges: this.merges,
      audit: this.audit,
    });
  }

  #findConversionPath(item, originalUom, occurredAt, conversionOwners = [item.id]) {
    if (originalUom.code === item.baseUom.code) {
      if (originalUom.dimension !== item.baseUom.dimension) throw domainError("uom_dimension_mismatch");
      return [];
    }
    const at = new Date(normalizeTimestamp(occurredAt)).getTime();
    const edges = [];
    for (const [from, to, factor] of STANDARD_CONVERSIONS) {
      edges.push({
        itemId: null,
        fromUom: { code: from, dimension: standardDimension(from) },
        toUom: { code: to, dimension: standardDimension(to) },
        factor,
        factorScaled: parsePositiveDecimal(factor, "conversion_factor_invalid").toString(),
        basis: "SYSTEM_COMPATIBLE",
        ruleReference: "SAGAPOS_STANDARD_UOM_V1",
        version: 1,
        activeFrom: "1970-01-01T00:00:00.000Z",
        revision: 0,
      });
    }
    const packageEdgeFactors = new Map();
    for (const supplierProduct of this.supplierProducts.values()) {
      if (!supplierProduct.active || supplierProduct.itemId !== item.id) continue;
      const history = supplierProduct.packageHistory ?? [{
        version: supplierProduct.version,
        packageHierarchy: supplierProduct.packageHierarchy,
        activeFrom: supplierProduct.updatedAt ?? supplierProduct.createdAt,
        revision: supplierProduct.revision,
      }];
      const selected = history
        .filter((entry) => new Date(entry.activeFrom).getTime() <= at)
        .sort((left, right) => new Date(right.activeFrom).getTime() - new Date(left.activeFrom).getTime() || right.version - left.version)[0];
      if (!selected) continue;
      for (const level of selected.packageHierarchy) {
        const key = `${level.uom.code}\u0000${level.uom.dimension}\u0000${level.containsUom.code}\u0000${level.containsUom.dimension}`;
        const factorScaled = parsePositiveDecimal(level.unitsPerPackage, "package_units_invalid").toString();
        const prior = packageEdgeFactors.get(key);
        if (prior && prior !== factorScaled) throw domainError("uom_conversion_ambiguous", 409);
        packageEdgeFactors.set(key, factorScaled);
        edges.push({
          itemId: item.id,
          fromUom: level.uom,
          toUom: level.containsUom,
          factor: level.unitsPerPackage,
          factorScaled,
          basis: "SUPPLIER_PACKAGE",
          ruleReference: supplierProduct.id,
          version: selected.version,
          activeFrom: selected.activeFrom,
          revision: selected.revision,
        });
      }
    }
    for (const ownerId of conversionOwners) {
      for (const versions of this.conversions.values()) {
        const eligible = versions
          .filter((edge) => edge.itemId === ownerId && new Date(edge.activeFrom).getTime() <= at)
          .sort((left, right) => new Date(right.activeFrom).getTime() - new Date(left.activeFrom).getTime() || right.version - left.version)[0];
        if (eligible) edges.push(eligible);
      }
    }
    const queue = [{ code: originalUom.code, dimension: originalUom.dimension, path: [] }];
    const visited = new Set();
    while (queue.length > 0) {
      const node = queue.shift();
      const nodeKey = `${node.code}\u0000${node.dimension}`;
      if (visited.has(nodeKey)) continue;
      visited.add(nodeKey);
      for (const edge of edges.filter((candidate) => candidate.fromUom.code === node.code && candidate.fromUom.dimension === node.dimension)) {
        const path = [...node.path, edge];
        if (edge.toUom.code === item.baseUom.code && edge.toUom.dimension === item.baseUom.dimension) return path;
        queue.push({ code: edge.toUom.code, dimension: edge.toUom.dimension, path });
      }
    }
    throw domainError("uom_conversion_missing");
  }

  #atomicMutation(operation) {
    const before = {
      revision: this.revision,
      items: structuredClone([...this.items]),
      skuIndex: structuredClone([...this.skuIndex]),
      supplierProducts: structuredClone([...this.supplierProducts]),
      supplierBarcodeIndex: structuredClone([...this.supplierBarcodeIndex]),
      conversions: structuredClone([...this.conversions]),
      reorderPolicies: structuredClone([...this.reorderPolicies]),
      merges: structuredClone(this.merges),
      audit: structuredClone(this.audit),
    };
    try {
      return operation();
    } catch (error) {
      this.revision = before.revision;
      this.items = new Map(before.items);
      this.skuIndex = new Map(before.skuIndex);
      this.supplierProducts = new Map(before.supplierProducts);
      this.supplierBarcodeIndex = new Map(before.supplierBarcodeIndex);
      this.conversions = new Map(before.conversions);
      this.reorderPolicies = new Map(before.reorderPolicies);
      this.merges = before.merges;
      this.audit = before.audit;
      throw error;
    }
  }

  #activeItem(itemId) {
    const item = this.items.get(requiredIdentifier(itemId, "item_id_required"));
    if (!item) throw domainError("item_not_found", 404);
    if (item.status === "MERGED") throw domainError("item_merged_read_only");
    return item;
  }

  #resolvedActiveItem(itemId) {
    return this.resolveItem(itemId).item;
  }

  #resolutionIds(itemId) {
    const ids = [];
    const visited = new Set();
    let current = this.items.get(itemId);
    if (!current) throw domainError("item_not_found", 404);
    while (current) {
      if (visited.has(current.id)) throw domainError("item_merge_cycle_detected", 500);
      visited.add(current.id);
      ids.push(current.id);
      if (current.status !== "MERGED") return ids;
      current = this.items.get(current.mergedIntoItemId);
      if (!current) throw domainError("item_merge_target_missing", 500);
    }
    throw domainError("item_merge_target_missing", 500);
  }

  #commitAudit(action, aggregateId, actorId, reason, detail) {
    this.revision += 1;
    const event = {
      id: this.idFactory(),
      tenantId: this.tenantId,
      revision: this.revision,
      action,
      aggregateId,
      actorId: requiredIdentifier(actorId, "actor_id_required"),
      reason: requiredText(reason, "reason_required"),
      detail: structuredClone(detail),
      occurredAt: this.#now(),
    };
    event.hash = sha256(event);
    this.audit.push(event);
  }

  #result(item) {
    return { item: structuredClone(item), revision: this.revision };
  }

  #now() {
    return normalizeTimestamp(this.clock());
  }
}

function buildItem(input) {
  const itemType = String(input.itemType ?? "").toUpperCase();
  if (!ITEM_TYPES.has(itemType)) throw domainError("item_type_invalid");
  const status = String(input.status ?? "ACTIVE").toUpperCase();
  if (!ITEM_STATUSES.has(status) || status === "MERGED") throw domainError("item_status_invalid");
  const lotTrackingPolicy = String(input.lotTrackingPolicy ?? "NOT_REQUIRED").toUpperCase();
  if (!LOT_POLICIES.has(lotTrackingPolicy)) throw domainError("lot_tracking_policy_invalid");
  const baseUom = validateUom(input.baseUom);
  if (baseUom.dimension === OPERATIONAL_DIMENSION) throw domainError("operational_base_uom_invalid");
  const flags = {
    purchasable: Boolean(input.flags?.purchasable),
    sellable: Boolean(input.flags?.sellable),
    producible: Boolean(input.flags?.producible),
    perishable: Boolean(input.flags?.perishable),
  };
  if (lotTrackingPolicy === "REQUIRED" && !flags.perishable && input.expiryRequired) throw domainError("expiry_requires_perishable_item");
  return {
    id: requiredIdentifier(input.id, "item_id_required"),
    sku: normalizeSku(input.sku),
    displayName: requiredText(input.displayName, "item_display_name_required"),
    itemType,
    status,
    baseUom,
    flags,
    lotTrackingPolicy,
    expiryRequired: Boolean(input.expiryRequired),
    allergens: uniqueStrings(input.allergens ?? [], "allergen_invalid"),
    dietaryTags: uniqueStrings(input.dietaryTags ?? [], "dietary_tag_invalid"),
    mergedIntoItemId: null,
    revision: input.revision,
    createdAt: normalizeTimestamp(input.createdAt),
    updatedAt: normalizeTimestamp(input.updatedAt ?? input.createdAt),
  };
}

function validatePackageHierarchy(value, baseUom) {
  if (!Array.isArray(value) || value.length === 0) throw domainError("package_hierarchy_required");
  const seen = new Set();
  const result = value.map((level, index) => {
    const uom = validateUom(level.uom);
    if (seen.has(uom.code)) throw domainError("package_hierarchy_duplicate_uom");
    seen.add(uom.code);
    const containsUom = index === value.length - 1 ? baseUom : validateUom(level.containsUom);
    const unitsPerPackage = parsePositiveDecimal(level.unitsPerPackage, "package_units_invalid");
    return {
      uom,
      containsUom,
      unitsPerPackage: formatScaled(unitsPerPackage),
      unitsPerPackageScaled: unitsPerPackage.toString(),
    };
  });
  for (let i = 0; i < result.length - 1; i += 1) {
    if (result[i].containsUom.code !== result[i + 1].uom.code || result[i].containsUom.dimension !== result[i + 1].uom.dimension) throw domainError("package_hierarchy_broken");
  }
  return result.map(({ unitsPerPackageScaled: _internal, ...level }) => level);
}

function validateStoredItem(stored, maximumRevision) {
  if (!stored || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > maximumRevision) throw domainError("master_data_state_invalid", 500);
  if (stored.status === "MERGED") {
    const base = buildItem({ ...stored, status: "INACTIVE", revision: stored.revision });
    return { ...base, status: "MERGED", mergedIntoItemId: requiredIdentifier(stored.mergedIntoItemId, "master_data_state_invalid") };
  }
  return buildItem(stored);
}

function validateStoredSupplierProduct(stored, items, maximumRevision, tenantId) {
  if (!stored || stored.tenantId !== tenantId || !items.has(stored.itemId) || !Number.isSafeInteger(stored.version) || stored.version < 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > maximumRevision) throw domainError("master_data_state_invalid", 500);
  const item = items.get(stored.itemId);
  if (item.status === "MERGED") throw domainError("master_data_state_invalid", 500);
  const packageHierarchy = validatePackageHierarchy(stored.packageHierarchy, item.baseUom);
  let packageHistory;
  if (stored.packageHistory !== undefined) {
    if (!Array.isArray(stored.packageHistory) || stored.packageHistory.length === 0) throw domainError("master_data_state_invalid", 500);
    packageHistory = stored.packageHistory.map((entry) => {
      if (!entry || !Number.isSafeInteger(entry.version) || entry.version < 1 || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.revision > maximumRevision) throw domainError("master_data_state_invalid", 500);
      return {
        version: entry.version,
        packageHierarchy: validatePackageHierarchy(entry.packageHierarchy, item.baseUom),
        activeFrom: normalizeTimestamp(entry.activeFrom),
        revision: entry.revision,
      };
    });
    if (packageHistory.length !== stored.version || packageHistory.some((entry, index) => entry.version !== index + 1)) throw domainError("master_data_state_invalid", 500);
    const latest = packageHistory.at(-1);
    if (latest.version !== stored.version || JSON.stringify(latest.packageHierarchy) !== JSON.stringify(packageHierarchy)) throw domainError("master_data_state_invalid", 500);
  }
  return {
    id: requiredIdentifier(stored.id, "master_data_state_invalid"),
    tenantId: requiredIdentifier(stored.tenantId, "master_data_state_invalid"),
    supplierId: requiredIdentifier(stored.supplierId, "master_data_state_invalid"),
    itemId: item.id,
    supplierSku: requiredText(stored.supplierSku, "master_data_state_invalid"),
    barcodes: uniqueStrings(stored.barcodes, "master_data_state_invalid"),
    packageHierarchy,
    active: Boolean(stored.active),
    version: stored.version,
    revision: stored.revision,
    createdAt: normalizeTimestamp(stored.createdAt),
    ...(packageHistory ? { packageHistory } : {}),
    ...(stored.updatedAt ? { updatedAt: normalizeTimestamp(stored.updatedAt) } : {}),
  };
}

function validateStoredConversion(stored, items, maximumRevision) {
  if (!stored || !items.has(stored.itemId) || !Number.isSafeInteger(stored.version) || stored.version < 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > maximumRevision) throw domainError("master_data_state_invalid", 500);
  const factorScaled = parsePositiveDecimal(stored.factor, "master_data_state_invalid");
  const fromUom = validateUom(stored.fromUom);
  const toUom = validateUom(stored.toUom);
  const crossesDimension = fromUom.dimension !== toUom.dimension;
  const operational = fromUom.dimension === OPERATIONAL_DIMENSION || toUom.dimension === OPERATIONAL_DIMENSION;
  if ((crossesDimension || operational) && stored.basis !== "ITEM_SPECIFIC") throw domainError("master_data_state_invalid", 500);
  if ((crossesDimension || operational) && !requiredText(stored.ruleReference, "master_data_state_invalid")) throw domainError("master_data_state_invalid", 500);
  return {
    itemId: stored.itemId,
    fromUom,
    toUom,
    factor: formatScaled(factorScaled),
    factorScaled: factorScaled.toString(),
    basis: stored.basis,
    ruleReference: stored.ruleReference ?? null,
    version: stored.version,
    activeFrom: normalizeTimestamp(stored.activeFrom),
    revision: stored.revision,
  };
}

function validateStoredAudit(audit, revision, tenantId) {
  if (audit.length !== revision) throw domainError("master_data_state_invalid", 500);
  const ids = new Set();
  const actions = new Set(["ITEM_CREATED", "ITEM_UPDATED", "REORDER_POLICY_SET", "SUPPLIER_PRODUCT_LINKED", "SUPPLIER_PACKAGE_VERSIONED", "ITEM_CONVERSION_VERSIONED", "ITEM_MERGED"]);
  for (let index = 0; index < audit.length; index += 1) {
    const event = audit[index];
    if (!event || event.tenantId !== tenantId || event.revision !== index + 1
      || !requiredIdentifier(event.id, "master_data_state_invalid")
      || !requiredText(event.action, "master_data_state_invalid")
      || !requiredIdentifier(event.aggregateId, "master_data_state_invalid")
      || !requiredIdentifier(event.actorId, "master_data_state_invalid")
      || !requiredText(event.reason, "master_data_state_invalid")
      || !event.detail || Array.isArray(event.detail) || typeof event.detail !== "object") throw domainError("master_data_state_invalid", 500);
    if (!actions.has(event.action) || ids.has(event.id)) throw domainError("master_data_state_invalid", 500);
    ids.add(event.id);
    normalizeTimestamp(event.occurredAt);
    const { hash, ...payload } = event;
    if (typeof hash !== "string" || hash !== sha256(payload)) throw domainError("master_data_state_tampered", 500);
  }
}

function validateStoredMerges(merges, items, maximumRevision) {
  const sources = new Set();
  for (const merge of merges) {
    if (!items.has(merge.sourceItemId) || !items.has(merge.targetItemId) || merge.sourceItemId === merge.targetItemId || sources.has(merge.sourceItemId) || !Number.isSafeInteger(merge.revision) || merge.revision < 1 || merge.revision > maximumRevision
      || !requiredIdentifier(merge.actorId, "master_data_state_invalid") || !requiredText(merge.reason, "master_data_state_invalid")) throw domainError("master_data_state_invalid", 500);
    normalizeTimestamp(merge.occurredAt);
    const source = items.get(merge.sourceItemId);
    if (source.status !== "MERGED" || source.mergedIntoItemId !== merge.targetItemId || source.revision !== merge.revision) throw domainError("master_data_state_invalid", 500);
    sources.add(merge.sourceItemId);
  }
  if ([...items.values()].filter((item) => item.status === "MERGED").some((item) => !sources.has(item.id))) throw domainError("master_data_state_invalid", 500);
}

function validateResolvedItems(items) {
  for (const initial of items.values()) {
    const visited = new Set();
    let current = initial;
    while (current.status === "MERGED") {
      if (visited.has(current.id)) throw domainError("item_merge_cycle_detected", 500);
      visited.add(current.id);
      current = items.get(current.mergedIntoItemId);
      if (!current) throw domainError("item_merge_target_missing", 500);
    }
  }
}

function validateCanonicalState({ items, supplierProducts, conversions, reorderPolicies, merges, audit }) {
  const itemActions = new Set(["ITEM_CREATED", "ITEM_UPDATED", "ITEM_MERGED"]);
  for (const item of items.values()) {
    const latest = audit.filter((event) => event.aggregateId === item.id && itemActions.has(event.action)).at(-1);
    if (!latest || latest.detail.itemHash !== sha256(item)) throw domainError("master_data_state_tampered", 500);
  }
  for (const supplierProduct of supplierProducts.values()) {
    const hashes = audit.flatMap((event) => {
      if (["SUPPLIER_PRODUCT_LINKED", "SUPPLIER_PACKAGE_VERSIONED"].includes(event.action) && event.detail.supplierProductId === supplierProduct.id) return [event.detail.recordHash];
      if (event.action === "ITEM_MERGED" && Array.isArray(event.detail.rehomedSupplierProducts)) return event.detail.rehomedSupplierProducts.filter((entry) => entry.id === supplierProduct.id).map((entry) => entry.recordHash);
      return [];
    }).filter(Boolean);
    if (hashes.at(-1) !== sha256(supplierProduct)) throw domainError("master_data_state_tampered", 500);
  }
  for (const versions of conversions.values()) {
    for (const conversion of versions) {
      const event = audit.find((candidate) => candidate.action === "ITEM_CONVERSION_VERSIONED"
        && candidate.aggregateId === conversion.itemId
        && candidate.detail.fromUom === conversion.fromUom.code
        && candidate.detail.toUom === conversion.toUom.code
        && candidate.detail.version === conversion.version);
      if (!event || event.detail.recordHash !== sha256(withoutInternalScale(conversion))) throw domainError("master_data_state_tampered", 500);
    }
  }
  for (const policy of reorderPolicies.values()) {
    const hashes = audit.flatMap((event) => {
      if (event.action === "REORDER_POLICY_SET" && event.aggregateId === policy.itemId && event.detail.locationId === policy.locationId) return [event.detail.recordHash];
      if (event.action === "ITEM_MERGED" && Array.isArray(event.detail.rehomedReorderPolicies)) return event.detail.rehomedReorderPolicies.filter((entry) => entry.itemId === policy.itemId && entry.locationId === policy.locationId).map((entry) => entry.recordHash);
      return [];
    }).filter(Boolean);
    if (hashes.at(-1) !== sha256(policy)) throw domainError("master_data_state_tampered", 500);
  }
  for (const merge of merges) {
    const event = audit.find((candidate) => candidate.action === "ITEM_MERGED" && candidate.aggregateId === merge.sourceItemId && candidate.detail.targetItemId === merge.targetItemId);
    if (!event || event.detail.mergeHash !== sha256(merge)) throw domainError("master_data_state_tampered", 500);
  }
}

function validateReorderPolicy(value) {
  if (!value || typeof value !== "object") throw domainError("reorder_policy_required");
  const mode = String(value.mode ?? "").toUpperCase();
  if (!new Set(["MIN_MAX", "REORDER_POINT", "PAR", "FORECAST_DRIVEN"]).has(mode)) throw domainError("reorder_policy_mode_invalid");
  const result = { mode };
  for (const key of ["minimum", "maximum", "reorderPoint", "parLevel", "staticFallback"]) {
    if (value[key] !== undefined && value[key] !== null) result[key] = formatScaled(parseDecimal(value[key], "reorder_policy_quantity_invalid"));
  }
  if (mode === "MIN_MAX" && (result.minimum === undefined || result.maximum === undefined || parseDecimal(result.maximum) < parseDecimal(result.minimum))) throw domainError("reorder_policy_min_max_invalid");
  if (mode === "FORECAST_DRIVEN" && result.staticFallback === undefined) throw domainError("reorder_policy_static_fallback_required");
  return result;
}

function validateUom(value) {
  if (!value || typeof value !== "object") throw domainError("uom_required");
  return {
    code: requiredText(value.code, "uom_code_required").toLowerCase(),
    dimension: requiredText(value.dimension, "uom_dimension_required").toUpperCase(),
  };
}

function standardDimension(code) {
  return new Set(["kg", "gram"]).has(code) ? "MASS" : "VOLUME";
}

function parseDecimal(value, code = "decimal_invalid") {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!new RegExp(`^-?\\d{1,${MAX_INTEGER_DIGITS}}(?:\\.\\d{1,${SCALE}})?$`).test(text)) throw domainError(code);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const scaled = BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
  const result = negative ? -scaled : scaled;
  if (absoluteScaled(result) > MAX_SCALED_MAGNITUDE) throw domainError(code);
  return result;
}

function parsePositiveDecimal(value, code) {
  const parsed = parseDecimal(value, code);
  if (parsed <= 0n) throw domainError(code);
  return parsed;
}

function multiplyScaled(left, right) {
  const product = left * right;
  const quotient = product / SCALE_FACTOR;
  const remainder = product % SCALE_FACTOR;
  if (remainder !== 0n) throw domainError("quantity_precision_exceeded");
  if (absoluteScaled(quotient) > MAX_SCALED_MAGNITUDE) throw domainError("quantity_overflow");
  return quotient;
}

function absoluteScaled(value) {
  return value < 0n ? -value : value;
}

function formatScaled(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function withoutInternalScale(record) {
  const { factorScaled: _internal, ...publicRecord } = record;
  return structuredClone(publicRecord);
}

function conversionKey(itemId, from, to) {
  return `${itemId}\u0000${from}\u0000${to}`;
}

function normalizeSku(value) {
  return requiredText(value, "item_sku_required").toUpperCase();
}

function requiredIdentifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw domainError(code);
  return normalized;
}

function optionalIdentifier(value) {
  return value === undefined || value === null ? null : requiredIdentifier(value, "identifier_invalid");
}

function requiredText(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) throw domainError(code);
  return normalized;
}

function uniqueStrings(values, code) {
  if (!Array.isArray(values)) throw domainError(code);
  const result = values.map((value) => requiredText(value, code));
  if (new Set(result.map((value) => value.toLocaleLowerCase("id"))).size !== result.length) throw domainError(code);
  return result;
}

function assertExpectedRevision(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected !== actual) throw domainError("master_data_revision_conflict", 409);
}

function validateMutationMetadata(input) {
  requiredIdentifier(input.actorId, "actor_id_required");
  requiredText(input.reason, "reason_required");
}

function changedItemFields(before, after) {
  return Object.fromEntries(Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((key) => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw domainError("timestamp_invalid");
  return date.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function domainError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}
