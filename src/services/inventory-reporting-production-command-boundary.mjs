import { createInventoryReportingAwareProductionExecution } from "./inventory-reporting-historical-authority-postgres.mjs";
import { authoritativeRecipeSnapshot } from "./production-execution-durable-hpp.mjs";

export const INVENTORY_REPORTING_PRODUCTION_COMMAND_BOUNDARY_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_PRODUCTION_COMMAND_BOUNDARY_V1";

const ACTIONS = Object.freeze({
  "hpp.production.plan": "plan",
  "hpp.production.complete": "complete",
  "hpp.production.cancel": "cancel",
  "hpp.production.expire": "expire",
});
const UNSAFE_LEGACY_ADJUSTMENTS = new Set(["hpp.production.void", "hpp.production.correct"]);

export function installInventoryReportingProductionCommandBoundary({ mode, db, ids, runtime, productionFactory } = {}) {
  const normalizedMode = String(mode ?? "off").trim().toLowerCase();
  if (!new Set(["off", "postgres"]).has(normalizedMode)) throw failure("inventory_reporting_production_command_mode_invalid");
  if (!runtime || typeof runtime.adminAction !== "function") throw failure("inventory_reporting_production_command_runtime_invalid");
  if (normalizedMode === "off" && (!db?.transaction || !scope(ids) || typeof productionFactory !== "function")) return Object.freeze({ contract: INVENTORY_REPORTING_PRODUCTION_COMMAND_BOUNDARY_CONTRACT, enabled: false });
  if (!db?.transaction || !scope(ids) || typeof productionFactory !== "function") throw failure("inventory_reporting_production_command_source_required");

  const production = productionFactory({ ids: Object.freeze({ ...ids }), runtime });
  const composition = createInventoryReportingAwareProductionExecution({
    db,
    authorize: async (request) => request?.action === "inventory_reporting.production.persist"
      && request.organizationId === ids.organizationId
      && request.outletId === ids.outletId,
    production,
  });
  const priorAdminAction = runtime.adminAction.bind(runtime);
  const priorAdminState = typeof runtime.adminState === "function" ? runtime.adminState.bind(runtime) : null;
  const priorInventoryWorkspaceState = typeof runtime.inventoryWorkspaceState === "function" ? runtime.inventoryWorkspaceState.bind(runtime) : null;
  runtime.adminAction = async function inventoryReportingAwareAdminAction(role, actorId, action, payload = {}) {
    const method = ACTIONS[action];
    if (UNSAFE_LEGACY_ADJUSTMENTS.has(action)) {
      if (role !== "owner") throw failure("owner_required", 403);
      throw failure("production_adjustment_atomic_boundary_unavailable", 409);
    }
    if (!method) return priorAdminAction(role, actorId, action, payload);
    if (role !== "owner") throw failure("owner_required", 403);
    if (!plain(payload)) throw failure("inventory_reporting_production_command_invalid");
    const command = method === "plan" ? normalizePlanCommand(payload, runtime) : payload;
    return composition.service[method]({ ...command, actorId });
  };
  if (priorAdminState) runtime.adminState = function productionAwareAdminState(role) {
    return attachProductionState(priorAdminState(role), composition.service);
  };
  if (priorInventoryWorkspaceState) runtime.inventoryWorkspaceState = function productionAwareInventoryWorkspaceState(role) {
    return attachProductionState(priorInventoryWorkspaceState(role), composition.service);
  };
  return Object.freeze({
    contract: INVENTORY_REPORTING_PRODUCTION_COMMAND_BOUNDARY_CONTRACT,
    enabled: true,
    reportingMode: normalizedMode,
    service: composition.service,
    historicalAuthority: composition.historicalAuthority,
  });
}

function attachProductionState(value, service) {
  const view = service.view();
  const state = service.exportState();
  const productionExecutions = state.operations.map((item) => item.result?.execution).filter(Boolean);
  const production = { revision: view.revision, orders: view.orders, executions: productionExecutions };
  if (value?.hpp && typeof value.hpp === "object") return { ...value, production, hpp: { ...value.hpp, productionOrders: view.orders, productionExecutions } };
  return { ...value, production, productionOrders: view.orders, productionExecutions };
}

function normalizePlanCommand(payload, runtime) {
  if (!runtime?.hppCatalog?.view || !runtime?.hppCatalog?.exportState) return payload;
  const suppliedRecipeId = String(payload.recipeSnapshot?.recipeId ?? "").trim();
  const suppliedRecipeVersion = Number(payload.recipeSnapshot?.recipeVersion);
  const outputIngredientId = String(payload.outputIngredientId ?? payload.recipeSnapshot?.output?.itemId ?? "").trim();
  if (suppliedRecipeId) {
    const authoritative = authoritativeRecipeSnapshot(runtime.hppCatalog.exportState(), suppliedRecipeId, suppliedRecipeVersion);
    if (!authoritative) throw failure("production_recipe_not_found", 404);
    return {
      ...payload,
      recipeSnapshot: authoritative,
      plannedOutput: payload.plannedOutput ?? { ...authoritative.output },
      yieldToleranceBps: authoritative.yieldToleranceBps ?? payload.yieldToleranceBps ?? 0,
    };
  }
  const recipes = runtime.hppCatalog.view().ingredientProductionRecipes ?? [];
  const recipe = recipes.find((item) => item.outputIngredientId === outputIngredientId);
  if (!recipe) throw failure("production_recipe_not_found", 404);
  const recipeSnapshot = authoritativeRecipeSnapshot(runtime.hppCatalog.exportState(), recipe.id, recipe.version);
  if (!recipeSnapshot) throw failure("production_recipe_snapshot_authority_mismatch", 409);
  return {
    ...payload,
    recipeSnapshot,
    plannedOutput: payload.plannedOutput ?? { itemId: outputIngredientId, quantity: String(recipe.outputQuantity), normalizedUom: recipe.outputUom },
    yieldToleranceBps: recipe.yieldToleranceBps,
  };
}

function scope(value) {
  return plain(value) && identifier(value.organizationId) && identifier(value.outletId);
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
