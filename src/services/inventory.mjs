const negativeMovementTypes = new Set(["sale_consumption", "waste", "internal_usage", "adjustment_negative"]);

export function applyInventoryMovement(balance, movement, options = {}) {
  const currentQty = Number(balance?.qtyOnHand ?? 0);
  const qtyDelta = Number(movement.qtyDelta ?? 0);

  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
    throw new Error("inventory_movement_qty_delta_required");
  }

  const nextQty = currentQty + qtyDelta;
  if (nextQty < 0 && options.allowNegativeStock !== true) {
    throw new Error("inventory_negative_stock_blocked");
  }

  const unitCostRupiah = Number(movement.unitCostRupiah ?? balance?.unitCostRupiah ?? 0);
  const valueDeltaRupiah = Math.round(qtyDelta * unitCostRupiah);

  return {
    ...balance,
    ingredientId: movement.ingredientId ?? balance?.ingredientId,
    qtyOnHand: roundQty(nextQty),
    stockValueRupiah: Math.max(0, Math.round(nextQty * unitCostRupiah)),
    movement: {
      ...movement,
      valueDeltaRupiah,
      balanceAfterQty: roundQty(nextQty),
      requiresApproval: isSensitiveMovement(movement),
    },
  };
}

export function getStockWarnings(balances, ingredients) {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  return balances
    .map((balance) => {
      const ingredient = ingredientById.get(balance.ingredientId);
      if (!ingredient) return null;

      const qtyOnHand = Number(balance.qtyOnHand ?? 0);
      const critical = Number(ingredient.criticalThresholdQty ?? 0);
      const low = Number(ingredient.lowThresholdQty ?? 0);

      if (critical > 0 && qtyOnHand <= critical) {
        return buildWarning("critical", balance, ingredient);
      }

      if (low > 0 && qtyOnHand <= low) {
        return buildWarning("low", balance, ingredient);
      }

      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const severity = { critical: 0, low: 1 };
      return severity[a.status] - severity[b.status] || a.name.localeCompare(b.name);
    });
}

function buildWarning(status, balance, ingredient) {
  return {
    status,
    ingredientId: ingredient.id,
    name: ingredient.name,
    unit: ingredient.baseUnit,
    qtyOnHand: Number(balance.qtyOnHand ?? 0),
    lowThresholdQty: Number(ingredient.lowThresholdQty ?? 0),
    criticalThresholdQty: Number(ingredient.criticalThresholdQty ?? 0),
    parLevelQty: Number(ingredient.parLevelQty ?? 0),
    restockQty: Math.max(0, roundQty(Number(ingredient.parLevelQty ?? 0) - Number(balance.qtyOnHand ?? 0))),
    unitCostRupiah: Number(ingredient.costPerUnitRupiah ?? 0),
  };
}

function isSensitiveMovement(movement) {
  return negativeMovementTypes.has(movement.movementType) || Math.abs(Number(movement.qtyDelta ?? 0)) > 1000;
}

function roundQty(value) {
  return Math.round(value * 1000) / 1000;
}
