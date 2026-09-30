import { applyInventoryMovement } from "./inventory.mjs";

export function createPurchasePlanFromWarnings({ warnings, supplierId, poNumber }) {
  const items = warnings
    .filter((warning) => Number(warning.restockQty ?? 0) > 0)
    .map((warning) => ({
      ingredientId: warning.ingredientId,
      orderedQty: Number(warning.restockQty),
      receivedQty: 0,
      unit: warning.unit,
      unitCostRupiah: Number(warning.unitCostRupiah ?? 0),
      estimatedTotalRupiah: Math.round(Number(warning.restockQty) * Number(warning.unitCostRupiah ?? 0)),
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    poNumber,
    supplierId,
    status: "draft",
    totalEstimatedRupiah: items.reduce((sum, item) => sum + item.estimatedTotalRupiah, 0),
    items,
  };
}

export function receivePurchaseOrder({ purchaseOrder, receiveItems, balances }) {
  if (!["ordered", "partially_received"].includes(purchaseOrder.status)) {
    throw new Error("purchase_order_not_receivable");
  }

  const balancesByIngredientId = new Map(balances.map((balance) => [balance.ingredientId, { ...balance }]));
  const receiveByIngredientId = new Map(receiveItems.map((item) => [item.ingredientId, item]));
  const movements = [];

  const items = purchaseOrder.items.map((item) => {
    const receiveItem = receiveByIngredientId.get(item.ingredientId);
    const receiveQty = Number(receiveItem?.receivedQty ?? 0);
    const remainingQty = Number(item.orderedQty) - Number(item.receivedQty ?? 0);

    if (receiveQty > remainingQty) {
      throw new Error("purchase_receive_qty_exceeds_remaining");
    }

    if (receiveQty <= 0) {
      return item;
    }

    const balance = balancesByIngredientId.get(item.ingredientId) ?? {
      ingredientId: item.ingredientId,
      qtyOnHand: 0,
      unitCostRupiah: item.unitCostRupiah,
    };
    const nextBalance = applyInventoryMovement(balance, {
      ingredientId: item.ingredientId,
      movementType: "purchase_received",
      qtyDelta: receiveQty,
      unit: item.unit,
      unitCostRupiah: item.unitCostRupiah,
      referenceType: "purchase_order",
      referenceCode: purchaseOrder.poNumber,
    });

    balancesByIngredientId.set(item.ingredientId, nextBalance);
    movements.push(nextBalance.movement);

    return {
      ...item,
      receivedQty: Number(item.receivedQty ?? 0) + receiveQty,
    };
  });

  const allReceived = items.every((item) => Number(item.receivedQty ?? 0) >= Number(item.orderedQty));
  const anyReceived = items.some((item) => Number(item.receivedQty ?? 0) > 0);

  return {
    purchaseOrder: {
      ...purchaseOrder,
      status: allReceived ? "received" : anyReceived ? "partially_received" : purchaseOrder.status,
      items,
    },
    movements,
    balances: Array.from(balancesByIngredientId.values()),
  };
}
