import { applyInventoryMovement } from "./inventory.mjs";
import { calculateRecipeCost } from "./recipe.mjs";

export function checkoutOrder(input) {
  if (!input.cashSession || input.cashSession.status !== "open") {
    throw new Error("cash_session_open_required");
  }

  if (!input.cart?.length) {
    throw new Error("cart_required");
  }

  const productById = new Map(input.products.map((product) => [product.id, product]));
  const recipeByProductId = new Map(input.recipes.map((recipe) => [recipe.productId, recipe]));
  const balancesByIngredientId = new Map(input.balances.map((balance) => [balance.ingredientId, { ...balance }]));

  const orderItems = [];
  const inventoryMovements = [];
  let subtotalRupiah = 0;
  let totalHppRupiah = 0;

  for (const cartItem of input.cart) {
    const product = productById.get(cartItem.productId);
    if (!product || product.status !== "active") {
      throw new Error("active_product_required");
    }

    const qty = Number(cartItem.qty ?? 1);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("cart_quantity_invalid");
    const recipe = recipeByProductId.get(product.id);
    const recipeCost = recipe
      ? calculateRecipeCost({ product, recipe, recipeItems: recipe.items, ingredients: input.ingredients })
      : { hppRupiah: 0, complete: product.productType !== "recipe_product", recipeId: null, recipeVersion: null, lines: [], missingIngredientIds: [], missingCostIngredientIds: [] };
    if (!recipeCost.complete && product.productType === "recipe_product" && product.allowIncompleteHpp !== true) {
      throw new Error("complete_recipe_required");
    }
    const hppSnapshotStatus = recipeCost.complete ? "VERIFIED" : "INCOMPLETE";

    const lineTotalRupiah = qty * Number(product.priceRupiah ?? 0);
    const lineHppRupiah = qty * recipeCost.hppRupiah;

    orderItems.push({
      productId: product.id,
      productNameSnapshot: product.name,
      qty,
      unitPriceRupiah: Number(product.priceRupiah ?? 0),
      lineTotalRupiah,
      recipeCostSnapshotRupiah: recipeCost.hppRupiah,
      hppSnapshotStatus,
      recipeSnapshot: {
        version: 1,
        status: hppSnapshotStatus,
        recipeId: recipeCost.recipeId,
        recipeVersion: recipeCost.recipeVersion,
        missingIngredientIds: recipeCost.missingIngredientIds ?? [],
        missingCostIngredientIds: recipeCost.missingCostIngredientIds ?? [],
        lines: recipeCost.lines ?? [],
      },
    });

    subtotalRupiah += lineTotalRupiah;
    totalHppRupiah += lineHppRupiah;

    for (const recipeItem of recipe?.items ?? []) {
      const ingredient = input.ingredients.find((item) => item.id === recipeItem.ingredientId);
      const balance = balancesByIngredientId.get(recipeItem.ingredientId) ?? {
        ingredientId: recipeItem.ingredientId,
        qtyOnHand: 0,
        unitCostRupiah: ingredient?.costPerUnitRupiah ?? 0,
      };

      const nextBalance = applyInventoryMovement(
        balance,
        {
          ingredientId: recipeItem.ingredientId,
          movementType: "sale_consumption",
          qtyDelta: -1 * Number(recipeItem.qty) * qty,
          unit: ingredient?.baseUnit,
          unitCostRupiah: ingredient?.costPerUnitRupiah ?? 0,
          referenceType: "order",
          referenceCode: input.orderNumber,
        },
        { allowNegativeStock: input.allowNegativeStock === true },
      );

      balancesByIngredientId.set(recipeItem.ingredientId, nextBalance);
      inventoryMovements.push(nextBalance.movement);
    }
  }

  const totalRupiah = subtotalRupiah - Number(input.discountRupiah ?? 0);
  const paidRupiah = input.payments.reduce((sum, payment) => sum + Number(payment.amountRupiah ?? 0), 0);
  if (paidRupiah < totalRupiah) {
    throw new Error("payment_underpaid");
  }

  const payments = input.payments.map((payment) => ({
    ...payment,
    receivedRupiah: Number(payment.receivedRupiah ?? payment.amountRupiah),
    changeRupiah: Math.max(0, Number(payment.receivedRupiah ?? payment.amountRupiah) - Number(payment.amountRupiah)),
  }));

  return {
    order: {
      orderNumber: input.orderNumber,
      status: input.offline === true ? "pending_sync" : "paid",
      subtotalRupiah,
      discountRupiah: Number(input.discountRupiah ?? 0),
      totalRupiah,
      totalHppRupiah,
      hppSnapshotStatus: orderItems.every((item) => item.hppSnapshotStatus === "VERIFIED") ? "VERIFIED" : "INCOMPLETE",
      cashSessionId: input.cashSession.id,
      businessDate: input.businessDate,
    },
    orderItems,
    payments,
    inventoryMovements,
    balances: Array.from(balancesByIngredientId.values()),
    receipt: {
      orderNumber: input.orderNumber,
      totalRupiah,
      paidRupiah: payments.reduce((sum, payment) => sum + payment.receivedRupiah, 0),
      changeRupiah: payments.reduce((sum, payment) => sum + payment.changeRupiah, 0),
    },
    syncEvent: input.offline === true ? { status: "queued", reason: "offline_checkout" } : null,
  };
}
