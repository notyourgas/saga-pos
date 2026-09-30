import { createHash, randomUUID } from "node:crypto";

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const RECIPE_TYPES = new Set(["MENU", "PREP_PRODUCTION", "ASSEMBLY"]);
const LINE_ROLES = new Set(["MATERIAL", "PACKAGING", "OUTPUT"]);

export class RecipeMaster {
  constructor({ tenantId, itemProvider, itemCostProvider, clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.tenantId = identifier(tenantId, "tenant_id_required");
    if (typeof itemProvider !== "function") throw domainError("item_provider_required");
    if (typeof itemCostProvider !== "function") throw domainError("item_cost_provider_required");
    this.itemProvider = itemProvider;
    this.itemCostProvider = itemCostProvider;
    this.clock = clock;
    this.idFactory = idFactory;
    this.revision = 0;
    this.recipes = new Map();
    this.executionSnapshots = new Map();
    this.audit = [];
  }

  createDraft(input) {
    this.#guardMutation(input);
    const recipeId = input.recipeId ? identifier(input.recipeId, "recipe_id_invalid") : this.idFactory();
    const versions = this.recipes.get(recipeId) ?? [];
    if (versions.some((version) => version.status === "DRAFT")) throw domainError("recipe_draft_exists");
    const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((item) => item.version)) + 1;
    const draft = validateRecipeDocument({
      recipeId,
      version: nextVersion,
      status: "DRAFT",
      recipeType: input.recipeType,
      output: input.output,
      applicability: input.applicability,
      lines: input.lines,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      createdAt: this.#now(),
      revision: this.revision + 1,
    }, this.itemProvider, { allowMissingNested: true });
    const audit = this.#prepareAudit("RECIPE_DRAFT_CREATED", `${recipeId}:${nextVersion}`, input, {
      recipeType: draft.recipeType,
      recipeFingerprint: sha256(draft),
    });
    this.recipes.set(recipeId, [...versions, draft]);
    this.#commitAudit(audit);
    return this.#result(draft);
  }

  replaceDraft(input) {
    this.#guardMutation(input);
    const recipeId = identifier(input.recipeId, "recipe_id_required");
    const versions = this.recipes.get(recipeId);
    if (!versions) throw domainError("recipe_not_found", 404);
    const index = versions.findIndex((version) => version.status === "DRAFT" && version.version === input.version);
    if (index < 0) throw domainError("recipe_published_immutable");
    const current = versions[index];
    const next = validateRecipeDocument({
      ...current,
      recipeType: input.recipeType ?? current.recipeType,
      output: input.output ?? current.output,
      applicability: input.applicability ?? current.applicability,
      lines: input.lines ?? current.lines,
      effectiveFrom: input.effectiveFrom ?? current.effectiveFrom,
      effectiveTo: input.effectiveTo ?? current.effectiveTo,
      updatedAt: this.#now(),
      revision: this.revision + 1,
    }, this.itemProvider, { allowMissingNested: true });
    const updated = [...versions];
    updated[index] = next;
    const audit = this.#prepareAudit("RECIPE_DRAFT_REPLACED", `${recipeId}:${next.version}`, input, {
      lineCount: next.lines.length,
      recipeFingerprint: sha256(next),
    });
    this.recipes.set(recipeId, updated);
    this.#commitAudit(audit);
    return this.#result(next);
  }

  simulateDraft({ recipeId, version, context = {}, priceRupiah = null }) {
    const recipe = this.#version(recipeId, version);
    if (recipe.status !== "DRAFT") throw domainError("recipe_simulation_draft_required");
    return this.#buildSnapshot(recipe, context, priceRupiah, { simulation: true });
  }

  publish(input) {
    this.#guardMutation(input);
    const recipe = this.#version(input.recipeId, input.version);
    if (recipe.status !== "DRAFT") throw domainError("recipe_published_immutable");
    this.#assertNoCircularDependency(recipe);
    const validated = validateRecipeDocument(recipe, this.itemProvider, {
      allowMissingNested: false,
      nestedResolver: (id, at, version) => version === null
        ? this.#publishedAt(id, at, recipe.applicability, false)
        : this.#publishedVersion(id, version, at, recipe.applicability, false),
    });
    this.#assertNoCircularDependency(validated);
    this.#assertNoEffectiveOverlap(validated);
    // Resolve once at publication so missing conversions, broken references and
    // invalid conditional lines fail before the version can become effective.
    this.#buildSnapshot(validated, publicationProbeContext(validated), null, { simulation: true });
    const published = { ...validated, status: "PUBLISHED", publishedAt: this.#now(), revision: this.revision + 1 };
    const versions = [...this.recipes.get(recipe.recipeId)];
    versions[versions.findIndex((item) => item.version === recipe.version)] = published;
    const audit = this.#prepareAudit("RECIPE_PUBLISHED", `${recipe.recipeId}:${recipe.version}`, input, {
      effectiveFrom: recipe.effectiveFrom,
      applicability: recipe.applicability,
      recipeFingerprint: sha256(published),
    });
    this.recipes.set(recipe.recipeId, versions);
    this.#commitAudit(audit);
    return this.#result(published);
  }

  resolveExecution({ recipeId, occurredAt = this.#now(), context = {}, priceRupiah = null, sourceId }) {
    const normalizedSourceId = identifier(sourceId, "recipe_source_id_required");
    const normalizedContext = normalizeContext(context);
    const normalizedOccurredAt = timestamp(occurredAt);
    const request = {
      recipeId: identifier(recipeId, "recipe_id_required"),
      occurredAt: normalizedOccurredAt,
      context: normalizedContext,
      priceRupiah: priceRupiah === null || priceRupiah === undefined ? null : formatScaled(parseNonNegativeDecimal(priceRupiah, "price_invalid")),
    };
    const requestFingerprint = sha256(request);
    const existing = this.executionSnapshots.get(normalizedSourceId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw domainError("recipe_source_collision", 409);
      return structuredClone(existing.snapshot);
    }
    const recipe = this.#publishedAt(recipeId, occurredAt, normalizedContext, true);
    const snapshot = this.#buildSnapshot(recipe, normalizedContext, priceRupiah, { simulation: false });
    const payload = {
      tenantId: this.tenantId,
      sourceId: normalizedSourceId,
      occurredAt: normalizedOccurredAt,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.version,
      context: normalizedContext,
      output: recipe.output,
      dependencyVersions: snapshot.dependencyVersions,
      resolvedLines: snapshot.resolvedLines,
      hppRupiah: snapshot.hppRupiah,
      complete: snapshot.complete,
      missingCostItemIds: snapshot.missingCostItemIds,
    };
    const resolved = { ...payload, fingerprint: sha256(payload) };
    this.executionSnapshots.set(normalizedSourceId, { request, requestFingerprint, snapshot: structuredClone(resolved) });
    return structuredClone(resolved);
  }

  view() {
    return structuredClone({
      tenantId: this.tenantId,
      revision: this.revision,
      recipes: [...this.recipes.values()].flat(),
      executions: [...this.executionSnapshots.values()],
      audit: this.audit,
    });
  }

  exportState() {
    const payload = { stateVersion: 1, ...this.view() };
    return { ...payload, stateHash: sha256(payload) };
  }

  restoreState(state) {
    if (!state || state.stateVersion !== 1 || state.tenantId !== this.tenantId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.recipes) || !Array.isArray(state.audit) || (state.executions !== undefined && !Array.isArray(state.executions))) throw domainError("recipe_state_invalid", 500);
    const { stateHash, ...payload } = state;
    if (typeof stateHash !== "string" || stateHash !== sha256(payload)) throw domainError("recipe_state_tampered", 500);
    const recipes = new Map();
    for (const stored of state.recipes) {
      if (!Number.isSafeInteger(stored.version) || stored.version < 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > state.revision || !new Set(["DRAFT", "PUBLISHED"]).has(stored.status)) throw domainError("recipe_state_invalid", 500);
      const validated = validateRecipeDocument(stored, this.itemProvider, { allowMissingNested: true });
      const versions = recipes.get(validated.recipeId) ?? [];
      if (versions.some((item) => item.version === validated.version) || (validated.status === "DRAFT" && versions.some((item) => item.status === "DRAFT"))) throw domainError("recipe_state_invalid", 500);
      recipes.set(validated.recipeId, [...versions, { ...validated, ...(stored.publishedAt ? { publishedAt: timestamp(stored.publishedAt) } : {}) }]);
    }
    validateAudit(state.audit, state.revision, this.tenantId);
    validateRecipeAuditLinks(recipes, state.audit);
    validatePublishedRanges(recipes);
    const probe = new RecipeMaster({ tenantId: this.tenantId, itemProvider: this.itemProvider, itemCostProvider: this.itemCostProvider, clock: this.clock, idFactory: this.idFactory });
    probe.revision = state.revision;
    probe.recipes = recipes;
    probe.executionSnapshots = validateExecutions(state.executions ?? [], this.tenantId, recipes);
    probe.audit = structuredClone(state.audit);
    for (const versions of recipes.values()) {
      for (const recipe of versions.filter((item) => item.status === "PUBLISHED")) {
        probe.#assertNoCircularDependency(recipe);
        validateRecipeDocument(recipe, this.itemProvider, {
          allowMissingNested: false,
          nestedResolver: (id, at, version) => version === null
            ? probe.#publishedAt(id, at, recipe.applicability, false)
            : probe.#publishedVersion(id, version, at, recipe.applicability, false),
        });
        probe.#buildSnapshot(recipe, publicationProbeContext(recipe), null, { simulation: true });
      }
    }
    this.revision = state.revision;
    this.recipes = recipes;
    this.executionSnapshots = probe.executionSnapshots;
    this.audit = structuredClone(state.audit);
    return this.view();
  }

  #buildSnapshot(recipe, context, priceRupiah, { simulation }) {
    const normalizedContext = normalizeContext(context);
    const accumulator = new Map();
    const dependencyVersions = [];
    this.#flattenRecipe(recipe, normalizedContext, SCALE_FACTOR, accumulator, dependencyVersions, new Set());
    const missingCostItemIds = [];
    let totalCost = 0n;
    const resolvedLines = [...accumulator.values()].sort((a, b) => `${a.itemId}\u0000${a.role}`.localeCompare(`${b.itemId}\u0000${b.role}`)).map((line) => {
      const cost = this.itemCostProvider(line.itemId);
      const costScaled = cost === null || cost === undefined ? null : parseNonNegativeDecimal(cost, "item_cost_invalid");
      if (costScaled === null) missingCostItemIds.push(line.itemId);
      const lineCostScaled = costScaled === null ? null : multiplyScaled(line.quantityScaled, costScaled);
      if (lineCostScaled !== null) totalCost += lineCostScaled;
      return {
        itemId: line.itemId,
        role: line.role,
        normalizedQuantity: formatScaled(line.quantityScaled),
        normalizedUom: line.normalizedUom,
        unitCostRupiah: costScaled === null ? null : formatScaled(costScaled),
        costRupiah: lineCostScaled === null ? null : formatScaled(lineCostScaled),
        sources: [...line.sources].sort(),
      };
    });
    const hppRupiah = roundRupiah(totalCost);
    const price = priceRupiah === null || priceRupiah === undefined ? null : parseNonNegativeDecimal(priceRupiah, "price_invalid");
    const marginRupiah = price === null || missingCostItemIds.length > 0 ? null : roundRupiah(price - totalCost);
    return {
      simulation,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.version,
      complete: missingCostItemIds.length === 0,
      hppRupiah: missingCostItemIds.length === 0 ? hppRupiah : null,
      priceRupiah: price === null ? null : roundRupiah(price),
      marginRupiah,
      missingCostItemIds,
      dependencyVersions,
      resolvedLines,
    };
  }

  #flattenRecipe(recipe, context, multiplierScaled, accumulator, dependencyVersions, visiting) {
    const key = `${recipe.recipeId}:${recipe.version}`;
    if (visiting.has(key)) throw domainError("recipe_dependency_cycle");
    visiting.add(key);
    dependencyVersions.push({ recipeId: recipe.recipeId, version: recipe.version });
    for (const [index, line] of recipe.lines.entries()) {
      if (!conditionsMatch(line.conditions, context)) continue;
      if (line.kind === "ITEM") {
        const quantityScaled = multiplyScaled(parsePositiveDecimal(line.normalizedQuantity, "recipe_quantity_invalid"), multiplierScaled);
        const aggregateKey = `${line.itemId}\u0000${line.role}`;
        const existing = accumulator.get(aggregateKey) ?? { itemId: line.itemId, role: line.role, normalizedUom: line.normalizedUom, quantityScaled: 0n, sources: new Set() };
        existing.quantityScaled += quantityScaled;
        existing.sources.add(`${key}:${index}`);
        accumulator.set(aggregateKey, existing);
      } else {
        const nested = line.recipeVersion
          ? this.#publishedVersion(line.recipeId, line.recipeVersion, recipe.effectiveFrom, context, true)
          : this.#publishedAt(line.recipeId, recipe.effectiveFrom, context, true);
        const requestedOutput = parsePositiveDecimal(line.outputQuantity, "recipe_nested_output_invalid");
        const nestedYield = parsePositiveDecimal(nested.output.quantity, "recipe_output_quantity_invalid");
        const batchesScaled = divideScaled(requestedOutput, nestedYield);
        this.#flattenRecipe(nested, context, multiplyScaled(multiplierScaled, batchesScaled), accumulator, dependencyVersions, visiting);
      }
    }
    visiting.delete(key);
  }

  #publishedAt(recipeId, at, context, exactContext) {
    const id = identifier(recipeId, "recipe_id_required");
    const instant = new Date(timestamp(at)).getTime();
    const normalizedContext = normalizeContext(context);
    const candidates = (this.recipes.get(id) ?? []).filter((recipe) => recipe.status === "PUBLISHED"
      && new Date(recipe.effectiveFrom).getTime() <= instant
      && (recipe.effectiveTo === null || instant < new Date(recipe.effectiveTo).getTime())
      && applicabilityMatches(recipe.applicability, normalizedContext));
    if (candidates.length === 0) {
      if (exactContext) throw domainError("recipe_effective_version_not_found", 404);
      return null;
    }
    candidates.sort((a, b) => specificity(b.applicability) - specificity(a.applicability) || b.version - a.version);
    if (candidates.length > 1 && specificity(candidates[0].applicability) === specificity(candidates[1].applicability)) throw domainError("recipe_effective_version_ambiguous", 500);
    return candidates[0];
  }

  #publishedVersion(recipeId, version, at, context, exactContext) {
    const id = identifier(recipeId, "recipe_id_required");
    const instant = new Date(timestamp(at)).getTime();
    const normalizedContext = normalizeContext(context);
    const found = (this.recipes.get(id) ?? []).find((recipe) => recipe.status === "PUBLISHED"
      && recipe.version === version
      && new Date(recipe.effectiveFrom).getTime() <= instant
      && (recipe.effectiveTo === null || instant < new Date(recipe.effectiveTo).getTime())
      && applicabilityMatches(recipe.applicability, normalizedContext));
    if (!found && exactContext) throw domainError("recipe_effective_version_not_found", 404);
    return found ?? null;
  }

  #assertNoCircularDependency(candidate) {
    const graph = new Map();
    for (const [recipeId, versions] of this.recipes) {
      const published = versions.filter((version) => version.status === "PUBLISHED");
      const draft = versions.filter((version) => version.status === "DRAFT");
      const selected = recipeId === candidate.recipeId ? candidate : [...published, ...draft].sort((a, b) => b.version - a.version)[0];
      if (selected) graph.set(recipeId, selected.lines.filter((line) => line.kind === "RECIPE").map((line) => line.recipeId));
    }
    const visiting = new Set();
    const visited = new Set();
    const walk = (id) => {
      if (visiting.has(id)) throw domainError("recipe_dependency_cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const child of graph.get(id) ?? []) walk(child);
      visiting.delete(id);
      visited.add(id);
    };
    walk(candidate.recipeId);
  }

  #assertNoEffectiveOverlap(candidate) {
    for (const existing of this.recipes.get(candidate.recipeId) ?? []) {
      if (existing.status !== "PUBLISHED" || !rangesOverlap(existing.effectiveFrom, existing.effectiveTo, candidate.effectiveFrom, candidate.effectiveTo)) continue;
      if (applicabilitySignature(existing.applicability) === applicabilitySignature(candidate.applicability)) throw domainError("recipe_effective_range_overlap");
      if (specificity(existing.applicability) === specificity(candidate.applicability)
        && applicabilityIntersects(existing.applicability, candidate.applicability)) throw domainError("recipe_effective_range_ambiguous");
    }
  }

  #version(recipeId, version) {
    const found = (this.recipes.get(identifier(recipeId, "recipe_id_required")) ?? []).find((item) => item.version === version);
    if (!found) throw domainError("recipe_version_not_found", 404);
    return found;
  }

  #guardMutation(input) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== this.revision) throw domainError("recipe_revision_conflict", 409);
    identifier(input.actorId, "actor_id_required");
    text(input.reason, "reason_required");
  }

  #prepareAudit(action, aggregateId, input, detail) {
    const nextRevision = this.revision + 1;
    const payload = {
      id: sha256({ tenantId: this.tenantId, revision: nextRevision, action, aggregateId }).slice(0, 32),
      tenantId: this.tenantId, revision: nextRevision, action, aggregateId,
      actorId: input.actorId, reason: input.reason.trim(), detail: structuredClone(detail), occurredAt: this.#now(),
    };
    return { ...payload, hash: sha256(payload) };
  }

  #commitAudit(event) {
    this.revision = event.revision;
    this.audit.push(event);
  }

  #result(recipe) {
    return { recipe: structuredClone(recipe), revision: this.revision };
  }

  #now() {
    return timestamp(this.clock());
  }
}

function validateRecipeDocument(document, itemProvider, { allowMissingNested = false, nestedResolver } = {}) {
  const recipeType = String(document.recipeType ?? "").toUpperCase();
  if (!RECIPE_TYPES.has(recipeType)) throw domainError("recipe_type_invalid");
  const outputItem = itemProvider(identifier(document.output?.itemId, "recipe_output_item_required"));
  if (!outputItem || outputItem.status !== "ACTIVE") throw domainError("recipe_output_item_invalid");
  if (!outputItem.flags?.producible && recipeType !== "MENU") throw domainError("recipe_output_not_producible");
  const outputUom = text(document.output?.normalizedUom, "recipe_output_uom_required").toLowerCase();
  if (outputUom !== outputItem.baseUom?.code) throw domainError("recipe_output_uom_mismatch");
  const output = { itemId: outputItem.id, quantity: formatScaled(parsePositiveDecimal(document.output.quantity, "recipe_output_quantity_invalid")), normalizedUom: outputUom };
  const effectiveFrom = timestamp(document.effectiveFrom);
  const effectiveTo = document.effectiveTo === null || document.effectiveTo === undefined ? null : timestamp(document.effectiveTo);
  if (effectiveTo !== null && new Date(effectiveTo) <= new Date(effectiveFrom)) throw domainError("recipe_effective_range_invalid");
  if (!Array.isArray(document.lines) || document.lines.length === 0) throw domainError("recipe_lines_required");
  const lines = document.lines.map((line) => {
    const kind = String(line.kind ?? "ITEM").toUpperCase();
    const conditions = normalizeConditions(line.conditions);
    if (kind === "ITEM") {
      const item = itemProvider(identifier(line.itemId, "recipe_line_item_required"));
      if (!item || item.status !== "ACTIVE" || item.status === "MERGED") throw domainError("recipe_line_item_invalid");
      const normalizedUom = text(line.normalizedUom, "recipe_line_uom_required").toLowerCase();
      if (normalizedUom !== item.baseUom?.code) throw domainError("recipe_line_uom_mismatch");
      const role = String(line.role ?? "MATERIAL").toUpperCase();
      if (!LINE_ROLES.has(role)) throw domainError("recipe_line_role_invalid");
      return { kind, itemId: item.id, role, normalizedQuantity: formatScaled(parsePositiveDecimal(line.normalizedQuantity, "recipe_quantity_invalid")), normalizedUom, conditions };
    }
    if (kind !== "RECIPE") throw domainError("recipe_line_kind_invalid");
    const recipeId = identifier(line.recipeId, "recipe_nested_id_required");
    const requestedVersion = line.recipeVersion === undefined || line.recipeVersion === null
      ? null
      : positiveSafeInteger(line.recipeVersion, "recipe_nested_version_invalid");
    const nested = allowMissingNested ? null : nestedResolver?.(recipeId, effectiveFrom, requestedVersion);
    if (!allowMissingNested && !nested) throw domainError("recipe_nested_dependency_missing");
    return {
      kind,
      recipeId,
      ...(nested ? { recipeVersion: nested.version } : requestedVersion === null ? {} : { recipeVersion: requestedVersion }),
      outputQuantity: formatScaled(parsePositiveDecimal(line.outputQuantity, "recipe_nested_output_invalid")),
      conditions,
    };
  });
  return {
    recipeId: identifier(document.recipeId, "recipe_id_required"), version: document.version, status: document.status,
    recipeType, output, applicability: normalizeApplicability(document.applicability), lines, effectiveFrom, effectiveTo,
    createdAt: timestamp(document.createdAt), ...(document.updatedAt ? { updatedAt: timestamp(document.updatedAt) } : {}), revision: document.revision,
  };
}

function normalizeApplicability(value = {}) {
  return {
    outletId: value.outletId ? identifier(value.outletId, "recipe_outlet_id_invalid") : null,
    variantId: value.variantId ? identifier(value.variantId, "recipe_variant_id_invalid") : null,
    fulfillmentModes: unique(value.fulfillmentModes ?? []).map((item) => item.toUpperCase()).sort(),
    requiredModifierIds: unique(value.requiredModifierIds ?? []).sort(),
  };
}

function normalizeConditions(value = {}) {
  return {
    variantId: value.variantId ? identifier(value.variantId, "recipe_variant_id_invalid") : null,
    fulfillmentModes: unique(value.fulfillmentModes ?? []).map((item) => item.toUpperCase()).sort(),
    modifierId: value.modifierId ? identifier(value.modifierId, "recipe_modifier_id_invalid") : null,
  };
}

function normalizeContext(value = {}) {
  return {
    outletId: value.outletId ? identifier(value.outletId, "recipe_outlet_id_invalid") : null,
    variantId: value.variantId ? identifier(value.variantId, "recipe_variant_id_invalid") : null,
    fulfillmentMode: value.fulfillmentMode ? text(value.fulfillmentMode, "recipe_fulfillment_invalid").toUpperCase() : null,
    modifierIds: unique(value.modifierIds ?? []).sort(),
  };
}

function applicabilityMatches(applicability, context) {
  return (!applicability.outletId || applicability.outletId === context.outletId)
    && (!applicability.variantId || applicability.variantId === context.variantId)
    && (applicability.fulfillmentModes.length === 0 || applicability.fulfillmentModes.includes(context.fulfillmentMode))
    && applicability.requiredModifierIds.every((id) => context.modifierIds.includes(id));
}

function applicabilityIntersects(left, right) {
  const scalarIntersects = (a, b) => !a || !b || a === b;
  const listIntersects = (a, b) => a.length === 0 || b.length === 0 || a.some((value) => b.includes(value));
  return scalarIntersects(left.outletId, right.outletId)
    && scalarIntersects(left.variantId, right.variantId)
    && listIntersects(left.fulfillmentModes, right.fulfillmentModes);
}

function conditionsMatch(conditions, context) {
  return (!conditions.variantId || conditions.variantId === context.variantId)
    && (conditions.fulfillmentModes.length === 0 || conditions.fulfillmentModes.includes(context.fulfillmentMode))
    && (!conditions.modifierId || context.modifierIds.includes(conditions.modifierId));
}

function publicationProbeContext(recipe) {
  return {
    outletId: recipe.applicability.outletId,
    variantId: recipe.applicability.variantId,
    fulfillmentMode: recipe.applicability.fulfillmentModes[0] ?? null,
    modifierIds: recipe.applicability.requiredModifierIds,
  };
}

function specificity(applicability) {
  return Number(Boolean(applicability.outletId)) * 1000 + Number(Boolean(applicability.variantId)) * 100 + applicability.fulfillmentModes.length * 10 + applicability.requiredModifierIds.length;
}

function applicabilitySignature(value) {
  return JSON.stringify(value);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const a0 = new Date(aStart).getTime();
  const a1 = aEnd === null ? Number.POSITIVE_INFINITY : new Date(aEnd).getTime();
  const b0 = new Date(bStart).getTime();
  const b1 = bEnd === null ? Number.POSITIVE_INFINITY : new Date(bEnd).getTime();
  return a0 < b1 && b0 < a1;
}

function parseDecimal(value, code) {
  const source = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(source)) throw domainError(code);
  const negative = source.startsWith("-");
  const unsigned = negative ? source.slice(1) : source;
  const [whole, fraction = ""] = unsigned.split(".");
  const scaled = BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
  return negative ? -scaled : scaled;
}

function parsePositiveDecimal(value, code) {
  const parsed = parseDecimal(value, code);
  if (parsed <= 0n) throw domainError(code);
  return parsed;
}

function parseNonNegativeDecimal(value, code) {
  const parsed = parseDecimal(value, code);
  if (parsed < 0n) throw domainError(code);
  return parsed;
}

function multiplyScaled(a, b) {
  const product = a * b;
  if (product % SCALE_FACTOR !== 0n) throw domainError("recipe_precision_exceeded");
  return product / SCALE_FACTOR;
}

function divideScaled(a, b) {
  const numerator = a * SCALE_FACTOR;
  if (numerator % b !== 0n) throw domainError("recipe_precision_exceeded");
  return numerator / b;
}

function roundRupiah(scaled) {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const rounded = (absolute + SCALE_FACTOR / 2n) / SCALE_FACTOR;
  const signed = negative ? -rounded : rounded;
  const asNumber = Number(signed);
  if (!Number.isSafeInteger(asNumber)) throw domainError("recipe_money_overflow");
  return asNumber;
}

function formatScaled(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function unique(values) {
  if (!Array.isArray(values)) throw domainError("recipe_list_invalid");
  const normalized = values.map((value) => text(value, "recipe_list_value_invalid"));
  if (new Set(normalized).size !== normalized.length) throw domainError("recipe_list_duplicate");
  return normalized;
}

function validateAudit(audit, revision, tenantId) {
  if (audit.length !== revision) throw domainError("recipe_state_invalid", 500);
  for (let index = 0; index < audit.length; index += 1) {
    const event = audit[index];
    if (event.tenantId !== tenantId || event.revision !== index + 1) throw domainError("recipe_state_invalid", 500);
    const { hash, ...payload } = event;
    if (typeof hash !== "string" || hash !== sha256(payload)) throw domainError("recipe_state_tampered", 500);
  }
}

function validateRecipeAuditLinks(recipes, audit) {
  const eventByRevision = new Map(audit.map((event) => [event.revision, event]));
  for (const versions of recipes.values()) {
    for (const recipe of versions) {
      const event = eventByRevision.get(recipe.revision);
      if (!event
        || event.aggregateId !== `${recipe.recipeId}:${recipe.version}`
        || !event.detail
        || event.detail.recipeFingerprint !== sha256(recipe)) throw domainError("recipe_state_tampered", 500);
    }
  }
}

function validateExecutions(executions, tenantId, recipes) {
  const restored = new Map();
  for (const entry of executions) {
    if (!entry || !entry.request || typeof entry.request !== "object" || typeof entry.requestFingerprint !== "string" || !entry.snapshot || typeof entry.snapshot !== "object") throw domainError("recipe_state_invalid", 500);
    const snapshot = structuredClone(entry.snapshot);
    const sourceId = identifier(snapshot.sourceId, "recipe_state_invalid");
    if (restored.has(sourceId) || snapshot.tenantId !== tenantId || !Array.isArray(snapshot.dependencyVersions) || !Array.isArray(snapshot.resolvedLines)) throw domainError("recipe_state_invalid", 500);
    if (entry.requestFingerprint !== sha256(entry.request)) throw domainError("recipe_state_tampered", 500);
    const { fingerprint, ...payload } = snapshot;
    if (typeof fingerprint !== "string" || fingerprint !== sha256(payload)) throw domainError("recipe_state_tampered", 500);
    const request = {
      recipeId: identifier(entry.request.recipeId, "recipe_state_invalid"),
      occurredAt: timestamp(entry.request.occurredAt),
      context: normalizeContext(entry.request.context),
      priceRupiah: entry.request.priceRupiah === null ? null : formatScaled(parseNonNegativeDecimal(entry.request.priceRupiah, "recipe_state_invalid")),
    };
    if (sha256(request) !== entry.requestFingerprint
      || request.recipeId !== snapshot.recipeId
      || request.occurredAt !== snapshot.occurredAt
      || applicabilitySignature(request.context) !== applicabilitySignature(snapshot.context)) throw domainError("recipe_state_tampered", 500);
    if (!(recipes.get(request.recipeId) ?? []).some((recipe) => recipe.version === snapshot.recipeVersion)) throw domainError("recipe_state_invalid", 500);
    for (const dependency of snapshot.dependencyVersions) {
      if (!(recipes.get(identifier(dependency.recipeId, "recipe_state_invalid")) ?? []).some((recipe) => recipe.version === dependency.version)) throw domainError("recipe_state_invalid", 500);
    }
    restored.set(sourceId, { request, requestFingerprint: entry.requestFingerprint, snapshot });
  }
  return restored;
}

function validatePublishedRanges(recipes) {
  for (const versions of recipes.values()) {
    const published = versions.filter((item) => item.status === "PUBLISHED");
    for (let left = 0; left < published.length; left += 1) {
      for (let right = left + 1; right < published.length; right += 1) {
        if (!rangesOverlap(published[left].effectiveFrom, published[left].effectiveTo, published[right].effectiveFrom, published[right].effectiveTo)) continue;
        if (applicabilitySignature(published[left].applicability) === applicabilitySignature(published[right].applicability)
          || (specificity(published[left].applicability) === specificity(published[right].applicability)
            && applicabilityIntersects(published[left].applicability, published[right].applicability))) throw domainError("recipe_state_invalid", 500);
      }
    }
  }
}

function identifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw domainError(code);
  return normalized;
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw domainError(code);
  return value;
}

function text(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) throw domainError(code);
  return normalized;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw domainError("recipe_timestamp_invalid");
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
