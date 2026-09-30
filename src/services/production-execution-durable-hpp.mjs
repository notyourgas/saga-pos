import { createHash } from "node:crypto";

import { sagaPosPurchaseReceiptLocations } from "../db/saga-pos-postgres-repository.mjs";
import { HppCatalog } from "../pos-alpha/hpp-catalog.mjs";

export const PRODUCTION_EXECUTION_DURABLE_HPP_CONTRACT = "SAGAPOS_PRODUCTION_EXECUTION_DURABLE_HPP_V1";

export function createDurableHppProductionExecutionOptions({ ids, runtime } = {}) {
  if (!scope(ids) || !runtime?.hppCatalog || !runtime?.repository?.saveHppCatalogState
    || !runtime?.repository?.saveProductionExecutionState || !runtime?.repository?.saveProductionExecutionCompletion
    || !runtime?.repository?.loadProductionExecutionCompletionRecovery
    || !Number.isSafeInteger(runtime.hppCatalogRevision)) {
    throw failure("production_durable_hpp_dependency_invalid", 500);
  }
  const locationId = sagaPosPurchaseReceiptLocations(ids.outletId).usable;
  const completion = durableCompletionCoordinator({ ids, runtime });
  const recipeSnapshotProvider = ({ tenantId, outletId, recipeId, recipeVersion }) => {
    if (tenantId !== ids.organizationId || outletId !== ids.outletId) return null;
    return authoritativeRecipeSnapshot(runtime.hppCatalog.exportState(), recipeId, recipeVersion);
  };
  return Object.freeze({
    tenantId: ids.organizationId,
    outletId: ids.outletId,
    clock: runtime.clock,
    recipeSnapshotProvider,
    inventoryPort: durableInventoryPort({ ids, runtime, locationId, completion }),
    initialState: runtime.productionExecutionState ?? null,
    statePort: Object.freeze({
      save: async (state) => {
        runtime.hppCatalogRevision = await runtime.repository.saveProductionExecutionState({
          ...ids,
          expectedRevision: runtime.hppCatalogRevision,
          state,
        });
        runtime.productionExecutionState = structuredClone(state);
      },
      beginCompletion: () => completion.begin(),
      commitCompletion: (input) => completion.commit(input),
      abortCompletion: () => completion.abort(),
      recoverCompletion: (input) => completion.recover(input),
      applyCompletionRecovery: (input) => completion.applyRecovery(input),
    }),
    executionIdFactory: ({ tenantId, outletId, productionOrderId, operationKey }) =>
      `production-exec:${digest({ tenantId, outletId, productionOrderId, operationKey }).slice(0, 48)}`,
    requireExplicitCompletionTime: true,
  });
}

export function authoritativeRecipeSnapshot(snapshot, recipeId, recipeVersion) {
  if (!snapshot || !Array.isArray(snapshot.recipes) || !Array.isArray(snapshot.ingredients) || !Array.isArray(snapshot.audit)) return null;
  const productionRecipe = snapshot.audit
    .filter((event) => event?.type === "ingredient.production_recipe.upserted" && event.productionRecipe?.id === recipeId && event.productionRecipe?.version === recipeVersion)
    .sort((left, right) => (right.version ?? 0) - (left.version ?? 0))[0]?.productionRecipe;
  if (productionRecipe) {
    const ingredients = new Map(snapshot.ingredients.map((item) => [item.id, item]));
    const output = ingredients.get(productionRecipe.outputIngredientId);
    if (!output || output.status === "ARCHIVED"
      || (output.sourcingMode ?? "PURCHASED") !== "MADE_IN_HOUSE" || (output.materialType ?? "RAW_MATERIAL") !== "PREP_ITEM"
      || productionRecipe.outputUom !== output.baseUnit) return null;
    const resolvedLines = productionRecipe.components.map((line) => {
      const ingredient = ingredients.get(line.ingredientId);
      if (!ingredient || ingredient.status === "ARCHIVED" || ingredient.lotTrackingPolicy !== "NOT_REQUIRED" || line.normalizedUom !== ingredient.baseUnit) return null;
      return { itemId: ingredient.id, normalizedQuantity: String(line.normalizedQuantity), normalizedUom: ingredient.baseUnit };
    });
    if (resolvedLines.some((line) => line === null)) return null;
    const payload = {
      recipeId: productionRecipe.id,
      recipeVersion: productionRecipe.version,
      output: { itemId: output.id, quantity: String(productionRecipe.outputQuantity), normalizedUom: output.baseUnit },
      resolvedLines,
      yieldToleranceBps: productionRecipe.yieldToleranceBps,
      minimumShelfLifeDays: output.minimumShelfLifeDays ?? 0,
    };
    return Object.freeze({ ...payload, fingerprint: digest(payload) });
  }
  const recipe = snapshot.recipes.find((item) => item.id === recipeId && item.version === recipeVersion);
  if (!recipe) return null;
  const ingredients = new Map(snapshot.ingredients.map((item) => [item.id, item]));
  const output = ingredients.get(recipe.productId);
  if (!output) return null;
  const resolvedLines = recipe.items.map((line) => {
    const ingredient = ingredients.get(line.ingredientId);
    if (!ingredient || ingredient.lotTrackingPolicy !== "NOT_REQUIRED") return null;
    return { itemId: ingredient.id, normalizedQuantity: quantity(line.qty), normalizedUom: ingredient.baseUnit };
  });
  if (resolvedLines.some((line) => line === null)) return null;
  const payload = {
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    output: { itemId: output.id, quantity: "1", normalizedUom: output.baseUnit },
    resolvedLines,
    minimumShelfLifeDays: output.minimumShelfLifeDays ?? 0,
  };
  return Object.freeze({ ...payload, fingerprint: digest(payload) });
}

function durableInventoryPort({ ids, runtime, locationId, completion }) {
  return Object.freeze({
    transact: async (work) => {
      const working = new HppCatalog({ clock: runtime.clock, productProvider: runtime.hppCatalog.productProvider });
      working.restoreState(runtime.hppCatalog.exportState());
      const balances = new Map(working.exportState().inventoryBalances.map((item) => [item.ingredientId, { ...item }]));
      const reservations = reservedQuantities(working.exportState().inventoryReservations ?? []);
      let posting = null;
      const transaction = Object.freeze({
        allocateFefo: async (input) => {
          if (input.tenantId !== ids.organizationId || input.outletId !== ids.outletId || input.locationId !== locationId
            || !Array.isArray(input.eligibleStates) || input.eligibleStates.length !== 1 || input.eligibleStates[0] !== "USABLE") {
            throw failure("production_inventory_scope_invalid", 403);
          }
          const ingredient = working.exportState().ingredients.find((item) => item.id === input.itemId);
          const persistedInput = working.exportState().inventoryMovements.find((movement) => movement.movementType === "PRODUCTION_INPUT"
            && movement.sourceId === input.executionId && movement.referenceId === input.productionOrderId
            && movement.referenceCode === input.sourceOperationKey && movement.ingredientId === input.itemId);
          if (persistedInput) return structuredClone(persistedInput.allocations);
          const balance = balances.get(input.itemId);
          const requested = decimal(input.normalizedQuantity);
          if (!ingredient || ingredient.lotTrackingPolicy !== "NOT_REQUIRED") throw failure("production_lot_authority_unavailable", 409);
          const reserved = reservations.get(input.itemId) ?? 0;
          const available = balance ? subtractQuantityAllowZero(balance.quantityBase, reserved) : 0;
          if (!balance || requested <= 0 || requested > available) throw failure("production_stock_reserved", 409);
          if (!Number.isSafeInteger(balance.inventoryValueRupiah) || balance.inventoryValueRupiah <= 0 || balance.averageCostPerBaseUnitRupiah <= 0) throw failure("production_cost_authority_unavailable", 409);
          const consumedValue = allocateRupiahByQuantityHalfUp({
            inventoryValueRupiah: balance.inventoryValueRupiah,
            requestedQuantityBase: requested,
            balanceQuantityBase: balance.quantityBase,
          });
          if (!Number.isSafeInteger(consumedValue) || consumedValue <= 0) throw failure("production_cost_authority_unavailable", 409);
          balance.quantityBase = subtractQuantity(balance.quantityBase, requested);
          balance.inventoryValueRupiah -= consumedValue;
          return [{
            lotId: `UNTRACKED:${input.itemId}`,
            expiryAt: "9999-12-31T23:59:59.999Z",
            qualityState: "USABLE",
            normalizedQuantity: quantity(requested),
            consumedValueRupiah: String(consumedValue),
          }];
        },
        postProduction: async (value) => {
          if (posting !== null) throw failure("production_posting_duplicate", 409);
          if (value.inputLocationId !== locationId || value.outputLocationId !== locationId) throw failure("production_inventory_scope_invalid", 403);
          posting = structuredClone(value);
        },
      });
      const result = await work(transaction);
      if (!posting) throw failure("production_posting_missing", 500);
      const inputs = new Map();
      for (const line of posting.inputAllocations) {
        const current = inputs.get(line.itemId) ?? { itemId: line.itemId, normalizedQuantity: 0, inventoryValueRupiah: 0, allocations: [] };
        current.normalizedQuantity = addQuantity(current.normalizedQuantity, line.normalizedQuantity);
        current.inventoryValueRupiah += money(line.consumedValueRupiah);
        current.allocations.push(structuredClone(line));
        inputs.set(line.itemId, current);
      }
      working.postProductionExecution({
        executionId: posting.executionId,
        productionOrderId: posting.productionOrderId,
        sourceOperationKey: posting.sourceOperationKey,
        inputLocationId: posting.inputLocationId,
        outputLocationId: posting.outputLocationId,
        inputs: [...inputs.values()].map((line) => ({ ...line, normalizedQuantity: quantity(line.normalizedQuantity) })),
        output: {
          itemId: posting.output.itemId,
          lotId: posting.output.lotId,
          expiryAt: posting.output.expiryAt,
          usableQuantity: posting.output.usableQuantity,
          totalValueRupiah: money(posting.output.totalValueRupiah),
        },
        loss: {
          policy: posting.lossPolicy,
          valuationMethod: posting.lossValuationPolicy,
          normalQuantityBase: quantityOrZero(posting.normalLossQuantity),
          abnormalQuantityBase: quantityOrZero(posting.abnormalWasteQuantity),
          abnormalValueRupiah: money(posting.abnormalLossValueRupiah),
        },
        completedAt: posting.completedAt,
        expectedVersion: working.version,
        actorId: posting.actorId,
        reason: posting.reason,
      });
      completion.stage(working.exportState());
      return result;
    },
  });
}

function reservedQuantities(reservations) {
  const totals = new Map();
  for (const reservation of reservations) {
    if (reservation?.status !== "ACTIVE" || !Array.isArray(reservation.lines)) continue;
    for (const line of reservation.lines) {
      if (!identifier(line?.ingredientId)) throw failure("production_reservation_authority_invalid", 500);
      const current = totals.get(line.ingredientId) ?? 0;
      totals.set(line.ingredientId, addQuantity(current, line.quantityReservedBase));
    }
  }
  return totals;
}

function durableCompletionCoordinator({ ids, runtime }) {
  let active = false;
  let stagedHppSnapshot = null;
  return Object.freeze({
    begin() {
      if (active) throw failure("production_completion_overlap", 409);
      active = true;
      stagedHppSnapshot = null;
    },
    stage(snapshot) {
      if (!active || stagedHppSnapshot !== null) throw failure("production_completion_stage_invalid", 500);
      stagedHppSnapshot = structuredClone(snapshot);
    },
    async commit({ state, result, fact } = {}) {
      if (!active || stagedHppSnapshot === null || result?.idempotentReplay !== false) throw failure("production_completion_stage_invalid", 500);
      const snapshot = structuredClone(stagedHppSnapshot);
      const revision = await runtime.repository.saveProductionExecutionCompletion({
        ...ids,
        expectedRevision: runtime.hppCatalogRevision,
        snapshot,
        state,
        fact,
      });
      runtime.hppCatalog.restoreState(snapshot);
      runtime.hppCatalogRevision = revision;
      runtime.productionExecutionState = structuredClone(state);
      active = false;
      stagedHppSnapshot = null;
    },
    abort() {
      active = false;
      stagedHppSnapshot = null;
    },
    async recover({ input } = {}) {
      const recovered = await runtime.repository.loadProductionExecutionCompletionRecovery({
        ...ids,
        operationKey: input?.operationKey,
        productionOrderId: input?.productionOrderId,
      });
      const verification = new HppCatalog({ clock: runtime.clock, productProvider: runtime.hppCatalog.productProvider });
      verification.restoreState(recovered.snapshot);
      return recovered;
    },
    applyRecovery(recovered) {
      if (!recovered || !Number.isSafeInteger(recovered.revision) || !recovered.snapshot || !recovered.state) {
        throw failure("production_completion_recovery_invalid", 500);
      }
      runtime.hppCatalog.restoreState(recovered.snapshot);
      runtime.hppCatalogRevision = recovered.revision;
      runtime.productionExecutionState = structuredClone(recovered.state);
    },
  });
}

function scope(value) {
  return value && identifier(value.organizationId) && identifier(value.outletId);
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function decimal(value) {
  const micros = parseQuantityMicros(value, 1_000_000_000_000n);
  if (micros <= 0n) throw failure("production_quantity_invalid");
  return Number(micros) / 1_000_000;
}

function quantity(value) {
  const micros = parseQuantityMicros(value, 1_000_000_000_000n);
  if (micros <= 0n) throw failure("production_quantity_invalid");
  return formatQuantityMicros(micros);
}

function quantityOrZero(value) {
  const micros = parseQuantityMicros(value, 1_000_000_000_000n);
  return micros === 0n ? "0" : formatQuantityMicros(micros);
}

export function allocateRupiahByQuantityHalfUp({ inventoryValueRupiah, requestedQuantityBase, balanceQuantityBase } = {}) {
  if (!Number.isSafeInteger(inventoryValueRupiah) || inventoryValueRupiah <= 0) throw failure("production_cost_authority_unavailable", 409);
  const requestedMicros = quantityMicros(requestedQuantityBase);
  const balanceMicros = quantityMicros(balanceQuantityBase);
  if (requestedMicros > balanceMicros) throw failure("production_stock_shortage", 409);
  const value = BigInt(inventoryValueRupiah);
  const numerator = value * requestedMicros;
  const quotient = numerator / balanceMicros;
  const remainder = numerator % balanceMicros;
  const allocated = quotient + (remainder * 2n >= balanceMicros ? 1n : 0n);
  if (allocated <= 0n || allocated > BigInt(Number.MAX_SAFE_INTEGER)) throw failure("production_cost_authority_unavailable", 409);
  return Number(allocated);
}

function quantityMicros(value) {
  return parseQuantityMicros(value, BigInt(Number.MAX_SAFE_INTEGER));
}

function parseQuantityMicros(value, maximum) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw failure("production_quantity_invalid");
  const [whole, fraction = ""] = text.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros < 0n || micros > maximum) throw failure("production_quantity_invalid");
  return micros;
}

function formatQuantityMicros(micros) {
  const fraction = String(micros % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `${micros / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function addQuantity(left, right) {
  const micros = quantityMicros(left) + quantityMicros(right);
  if (micros > 1_000_000_000_000n) throw failure("production_quantity_invalid");
  return Number(formatQuantityMicros(micros));
}

function subtractQuantity(left, right) {
  const micros = quantityMicros(left) - quantityMicros(right);
  if (micros < 0n) throw failure("production_stock_shortage", 409);
  const result = Number(formatQuantityMicros(micros));
  if (quantityMicros(result) !== micros) throw failure("production_quantity_invalid");
  return result;
}

function subtractQuantityAllowZero(left, right) {
  const micros = quantityMicros(left) - quantityMicros(right);
  if (micros <= 0n) return 0;
  return Number(formatQuantityMicros(micros));
}

function money(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw failure("production_value_invalid");
  return number;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function failure(code, statusCode = 422) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
