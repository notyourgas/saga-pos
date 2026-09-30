import {
  RELIABILITY_PERSISTENCE_PORT_V1,
  deepFreeze,
  formatQuantity,
  immutableSnapshot,
  multiplyQuantity,
  parseQuantity,
  reliabilityError,
  requireText,
  sumQuantities,
} from "./contract.mjs";

export function createUnitConversionSnapshot(input) {
  const snapshot = {
    conversionId: requireText(input.conversionId, "unit_conversion_id_required", 100),
    version: requirePositiveInteger(input.version, "unit_conversion_version_invalid"),
    inputUnit: requireText(input.inputUnit, "unit_conversion_input_unit_required", 40),
    baseUnit: requireText(input.baseUnit, "unit_conversion_base_unit_required", 40),
    baseQuantityPerInputUnit: formatQuantity(parsePositiveQuantity(input.baseQuantityPerInputUnit, "unit_conversion_factor_invalid")),
    rounding: "HALF_UP_SCALE_6",
    effectiveAt: requireIso(input.effectiveAt, "unit_conversion_effective_at_invalid"),
  };
  return deepFreeze(snapshot);
}

export function convertToBaseQuantity(quantity, conversionSnapshot) {
  const snapshot = createUnitConversionSnapshot(conversionSnapshot);
  return multiplyQuantity(formatQuantity(parseQuantity(quantity)), snapshot.baseQuantityPerInputUnit);
}

export function buildRecipeConsumption(input) {
  const operationKey = requireText(input.operationKey, "inventory_operation_key_required", 160);
  const orderLineId = requireText(input.orderLineId, "inventory_order_line_id_required", 100);
  const contributions = [];
  const seenSources = new Set();

  addRecipeSource({
    kind: "PARENT",
    sourceId: orderLineId,
    multiplier: input.quantity,
    recipeSnapshot: input.recipeSnapshot,
  });
  for (const component of input.bundleComponents ?? []) {
    addRecipeSource({
      kind: "BUNDLE_COMPONENT",
      sourceId: requireText(component.componentLineId, "bundle_component_line_id_required", 100),
      multiplier: multiplyQuantity(input.quantity, component.quantity),
      recipeSnapshot: component.recipeSnapshot,
    });
  }
  for (const modifier of input.modifiers ?? []) {
    addRecipeSource({
      kind: "MODIFIER",
      sourceId: requireText(modifier.selectionId, "modifier_selection_id_required", 100),
      multiplier: multiplyQuantity(input.quantity, modifier.quantity),
      recipeSnapshot: modifier.recipeSnapshot,
    });
  }

  const grouped = new Map();
  for (const contribution of contributions) {
    const current = grouped.get(contribution.ingredientId) ?? [];
    current.push(contribution);
    grouped.set(contribution.ingredientId, current);
  }
  const movements = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([ingredientId, sources]) => deepFreeze({
    ingredientId,
    operationKey: `${operationKey}:${ingredientId}`,
    signedQuantityBase: `-${sumQuantities(sources.map((source) => source.quantityBase))}`,
    quantityBase: sumQuantities(sources.map((source) => source.quantityBase)),
    sourceCount: sources.length,
    sources,
  }));

  return deepFreeze({
    contractVersion: 1,
    operationKey,
    orderLineId,
    movements,
    recipeSnapshots: contributions.map((item) => item.recipeSnapshot),
  });

  function addRecipeSource({ kind, sourceId, multiplier, recipeSnapshot }) {
    const sourceKey = `${kind}:${sourceId}`;
    if (seenSources.has(sourceKey)) throw reliabilityError("inventory_consumption_source_duplicate", { sourceKey });
    seenSources.add(sourceKey);
    const snapshot = normalizeRecipeSnapshot(recipeSnapshot);
    const multiplierQuantity = formatQuantity(parsePositiveQuantity(multiplier, "inventory_consumption_multiplier_invalid"));
    for (const line of snapshot.lines) {
      const quantityBase = multiplyQuantity(multiplierQuantity, line.quantityBasePerUnit);
      contributions.push(deepFreeze({
        sourceKey,
        sourceKind: kind,
        ingredientId: line.ingredientId,
        quantityBase,
        recipeSnapshot: snapshot,
      }));
    }
  }
}

export function classifyStockAvailability(input) {
  if (input.inventoryMode === "UNLIMITED") return deepFreeze({ state: "UNLIMITED", quantityDisplay: "—", soldOut: false });
  if (input.inventoryMode !== "TRACKED") throw reliabilityError("inventory_mode_invalid");
  const quantity = parseQuantity(input.quantityBase, "inventory_quantity_invalid");
  return deepFreeze({ state: quantity === 0n ? "SOLD_OUT" : "AVAILABLE", quantityDisplay: formatQuantity(quantity), soldOut: quantity === 0n });
}

export function describeCogsCompleteness(input) {
  if (!Number.isSafeInteger(input.eligibleLineCount) || input.eligibleLineCount < 0) throw reliabilityError("cogs_eligible_line_count_invalid");
  if (!Number.isSafeInteger(input.coveredLineCount) || input.coveredLineCount < 0 || input.coveredLineCount > input.eligibleLineCount) throw reliabilityError("cogs_covered_line_count_invalid");
  const knownPartialCogsRupiah = input.knownPartialCogsRupiah == null ? 0 : input.knownPartialCogsRupiah;
  if (!Number.isSafeInteger(knownPartialCogsRupiah) || knownPartialCogsRupiah < 0) throw reliabilityError("cogs_amount_invalid");
  const complete = input.eligibleLineCount > 0 && input.coveredLineCount === input.eligibleLineCount;
  const status = input.coveredLineCount === 0 ? "UNKNOWN" : complete ? "COMPLETE" : "INCOMPLETE";
  return deepFreeze({
    status,
    coveredLineCount: input.coveredLineCount,
    eligibleLineCount: input.eligibleLineCount,
    knownPartialCogsRupiah,
    cogsRupiah: complete ? knownPartialCogsRupiah : null,
    finalProfitAllowed: complete,
    incompleteReason: complete ? null : requireText(input.incompleteReason ?? "RECIPE_SNAPSHOT_MISSING", "cogs_incomplete_reason_required", 100),
  });
}

export async function reserveLastStock(input) {
  const adapter = requireReservationAdapter(input.adapter);
  const organizationId = requireText(input.organizationId, "organization_id_required", 100);
  const outletId = requireText(input.outletId, "outlet_id_required", 100);
  const operationKey = requireText(input.operationKey, "inventory_operation_key_required", 160);
  const requirements = normalizeRequirements(input.requirements);

  return adapter.withTransaction(async (tx) => {
    const replay = await tx.findOperation({ organizationId, operationKey });
    if (replay) return deepFreeze({ ...structuredClone(replay), replayed: true });

    const locked = await tx.lockBalancesForUpdate({
      organizationId,
      outletId,
      ingredientIds: requirements.map((item) => item.ingredientId),
    });
    if (!Array.isArray(locked)) throw reliabilityError("inventory_locked_balances_invalid");
    const balanceByIngredient = new Map();
    for (const row of locked) {
      const ingredientId = requireText(row?.ingredientId, "inventory_locked_balance_ingredient_invalid", 100);
      if (balanceByIngredient.has(ingredientId) || !requirements.some((item) => item.ingredientId === ingredientId)) {
        throw reliabilityError("inventory_locked_balances_invalid", { ingredientId });
      }
      if ((row.organizationId && row.organizationId !== organizationId) || (row.outletId && row.outletId !== outletId)) {
        throw reliabilityError("inventory_locked_balance_scope_mismatch", { ingredientId });
      }
      balanceByIngredient.set(ingredientId, row);
    }
    const updates = [];
    for (const requirement of requirements) {
      const balance = balanceByIngredient.get(requirement.ingredientId);
      if (!balance) throw reliabilityError("inventory_balance_not_found", { ingredientId: requirement.ingredientId });
      if (balance.inventoryMode === "UNLIMITED") {
        updates.push({ ...requirement, inventoryMode: "UNLIMITED", beforeQuantityBase: null, afterQuantityBase: null, expectedVersion: balance.version });
        continue;
      }
      if (balance.inventoryMode !== "TRACKED") throw reliabilityError("inventory_mode_invalid", { ingredientId: requirement.ingredientId });
      const before = parseQuantity(balance.quantityBase, "inventory_balance_quantity_invalid");
      const requested = parseQuantity(requirement.quantityBase);
      const after = before - requested;
      if (after < 0n) {
        if (!approvedNegativeOverride(input.overrideApproval, { organizationId, outletId, operationKey })) {
          throw reliabilityError("inventory_last_stock_unavailable", { ingredientId: requirement.ingredientId });
        }
        if (typeof tx.consumeNegativeOverride === "function") {
          const consumed = await tx.consumeNegativeOverride({
            approval: input.overrideApproval,
            organizationId,
            outletId,
            operationKey,
          });
          if (consumed !== true) throw reliabilityError("inventory_negative_override_consume_failed");
        } else if (tx.requiresDurableAuthorization === true) {
          throw reliabilityError("inventory_negative_override_durable_authorization_required");
        }
      }
      updates.push({
        ...requirement,
        inventoryMode: "TRACKED",
        beforeQuantityBase: formatSignedQuantity(before),
        afterQuantityBase: formatSignedQuantity(after),
        expectedVersion: requireNonNegativeInteger(balance.version, "inventory_balance_version_invalid"),
      });
    }

    const reservation = deepFreeze({ organizationId, outletId, operationKey, updates, status: "RESERVED" });
    await tx.appendReservation(reservation);
    for (const update of updates.filter((item) => item.inventoryMode === "TRACKED")) {
      const changed = await tx.updateBalance({ organizationId, outletId, ...update });
      if (changed !== true) throw reliabilityError("inventory_concurrent_update_detected", { ingredientId: update.ingredientId });
    }
    await tx.appendOutbox({ organizationId, outletId, operationKey, eventType: "INVENTORY_RESERVED", payload: reservation });
    return deepFreeze({ ...structuredClone(reservation), replayed: false });
  });
}

export function reconstructInventoryBalance({ openingQuantityBase, movements }) {
  let total = parseQuantity(openingQuantityBase, "inventory_opening_quantity_invalid");
  const seen = new Map();
  for (const movement of movements ?? []) {
    const operationKey = requireText(movement.operationKey, "inventory_movement_operation_key_required", 160);
    const delta = parseSignedQuantity(movement.signedQuantityBase);
    if (seen.has(operationKey)) {
      if (seen.get(operationKey) !== delta) throw reliabilityError("inventory_movement_operation_collision", { operationKey });
      continue;
    }
    seen.set(operationKey, delta);
    total += delta;
  }
  return deepFreeze({ quantityBase: formatSignedQuantity(total), uniqueMovementCount: seen.size });
}

export const INVENTORY_RELIABILITY_HANDOFF = deepFreeze({
  persistence: RELIABILITY_PERSISTENCE_PORT_V1,
  stockConsumptionMoment: "LEAD_MUST_BIND_TO_ACCEPTED_RUNTIME_EVENT",
  databaseConcurrency: "POSTGRES_ADAPTER_AND_TARGET_ENGINE_TEST_REQUIRED",
});

function normalizeRecipeSnapshot(snapshot) {
  const immutable = immutableSnapshot(snapshot, "recipe_snapshot_invalid");
  const recipeId = requireText(immutable.recipeId, "recipe_snapshot_id_required", 100);
  const version = requirePositiveInteger(immutable.version, "recipe_snapshot_version_invalid");
  if (!Array.isArray(immutable.lines) || immutable.lines.length === 0) throw reliabilityError("recipe_snapshot_lines_required");
  const seen = new Set();
  const lines = immutable.lines.map((line) => {
    const ingredientId = requireText(line.ingredientId, "recipe_ingredient_id_required", 100);
    if (seen.has(ingredientId)) throw reliabilityError("recipe_ingredient_duplicate", { recipeId, ingredientId });
    seen.add(ingredientId);
    const unitConversionSnapshot = line.unitConversionSnapshot ? createUnitConversionSnapshot(line.unitConversionSnapshot) : null;
    const convertedQuantity = unitConversionSnapshot
      ? convertToBaseQuantity(line.quantityPerUnit, unitConversionSnapshot)
      : formatQuantity(parsePositiveQuantity(line.quantityBasePerUnit, "recipe_quantity_invalid"));
    if (line.quantityBasePerUnit !== undefined && formatQuantity(parsePositiveQuantity(line.quantityBasePerUnit, "recipe_quantity_invalid")) !== convertedQuantity) {
      throw reliabilityError("recipe_conversion_snapshot_mismatch", { recipeId, ingredientId });
    }
    return deepFreeze({
      ingredientId,
      quantityBasePerUnit: convertedQuantity,
      unitConversionSnapshot,
    });
  });
  return deepFreeze({ recipeId, version, lines });
}

function normalizeRequirements(requirements) {
  if (!Array.isArray(requirements) || requirements.length === 0) throw reliabilityError("inventory_requirements_required");
  const grouped = new Map();
  for (const item of requirements) {
    const ingredientId = requireText(item.ingredientId, "inventory_requirement_ingredient_required", 100);
    const quantityBase = formatQuantity(parsePositiveQuantity(item.quantityBase, "inventory_requirement_quantity_invalid"));
    const current = grouped.get(ingredientId) ?? [];
    current.push(quantityBase);
    grouped.set(ingredientId, current);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([ingredientId, quantities]) => ({ ingredientId, quantityBase: sumQuantities(quantities) }));
}

function requireReservationAdapter(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") throw reliabilityError("inventory_reservation_adapter_required");
  return adapter;
}

function approvedNegativeOverride(approval, scope) {
  return approval?.status === "APPROVED"
    && approval.action === "inventory:negative_stock"
    && approval.organizationId === scope.organizationId
    && approval.outletId === scope.outletId
    && approval.operationKey === scope.operationKey;
}

function parsePositiveQuantity(value, code) {
  const quantity = parseQuantity(value, code);
  if (quantity <= 0n) throw reliabilityError(code);
  return quantity;
}

function parseSignedQuantity(value) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) throw reliabilityError("inventory_signed_quantity_invalid");
  const negative = value.startsWith("-");
  const absolute = parseQuantity(negative ? value.slice(1) : value);
  return negative ? -absolute : absolute;
}

function formatSignedQuantity(value) {
  return value < 0n ? `-${formatQuantity(-value)}` : formatQuantity(value);
}

function requirePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) throw reliabilityError(code);
  return value;
}

function requireNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw reliabilityError(code);
  return value;
}

function requireIso(value, code) {
  const text = requireText(value, code, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw reliabilityError(code);
  return parsed.toISOString();
}
