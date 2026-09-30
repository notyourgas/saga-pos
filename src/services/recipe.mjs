export function calculateRecipeCost({ product, recipe, recipeItems, ingredients = [] }) {
  if (!recipeItems?.length) {
    return {
      productId: product?.id,
      complete: false,
      hppRupiah: 0,
      grossProfitRupiah: Number(product?.priceRupiah ?? 0),
      marginPct: product?.priceRupiah ? 100 : 0,
      missingIngredientIds: [],
      missingCostIngredientIds: [],
      lines: [],
    };
  }

  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const missingIngredientIds = [];
  const missingCostIngredientIds = [];
  const seenIngredientIds = new Set();
  const lines = recipeItems.map((item) => {
    if (seenIngredientIds.has(item.ingredientId)) throw new Error("duplicate_recipe_ingredient");
    seenIngredientIds.add(item.ingredientId);
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("recipe_quantity_invalid");
    const ingredient = ingredientById.get(item.ingredientId);
    if (!ingredient) {
      missingIngredientIds.push(item.ingredientId);
      return {
        ingredientId: item.ingredientId,
        qty,
        costRupiah: 0,
        complete: false,
      };
    }

    const unitCostRupiah = ingredient.costPerUnitRupiah;
    const costComplete = Number.isFinite(unitCostRupiah) && unitCostRupiah >= 0;
    if (!costComplete) missingCostIngredientIds.push(item.ingredientId);
    return {
      ingredientId: item.ingredientId,
      name: ingredient.name,
      qty,
      unit: ingredient.baseUnit,
      unitCostRupiah: costComplete ? unitCostRupiah : null,
      costRupiah: costComplete ? Math.round(qty * unitCostRupiah) : 0,
      complete: costComplete,
    };
  });

  const hppRupiah = lines.reduce((sum, line) => sum + line.costRupiah, 0);
  const priceRupiah = Number(product?.priceRupiah ?? 0);
  const grossProfitRupiah = priceRupiah - hppRupiah;

  return {
    productId: product?.id,
    recipeId: recipe?.id ?? null,
    recipeVersion: Number.isSafeInteger(recipe?.version) && recipe.version > 0 ? recipe.version : 1,
    complete: missingIngredientIds.length === 0 && missingCostIngredientIds.length === 0,
    hppRupiah,
    grossProfitRupiah,
    marginPct: priceRupiah > 0 ? roundPercent((grossProfitRupiah / priceRupiah) * 100) : 0,
    missingIngredientIds,
    missingCostIngredientIds,
    lines,
  };
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}
