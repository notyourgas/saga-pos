import { StaffInventoryReceivingService } from "./staff-inventory-receiving.mjs";

export function createStaffInventoryReceivingComposition({ db, ids, runtime, storage, clock = () => new Date() } = {}) {
  if (!db?.query || !db?.transaction || !ids?.organizationId || !ids?.outletId || !runtime?.inventoryWorkspaceState || !runtime?.inventoryWorkspaceAction) {
    throw new Error("staff_receiving_composition_invalid");
  }

  const readWorkspace = async () => runtime.inventoryWorkspaceState("owner");
  const readHpp = async () => runtime.hppCatalog?.view?.() ?? {};
  const service = new StaffInventoryReceivingService({
    db,
    storage,
    clock,
    resolveBusinessDate: async (context) => {
      assertScope(context, ids);
      return (await readWorkspace()).businessDate;
    },
    resolveLine: async ({ organizationId, outletId, input, mayWriteCost }) => {
      assertScope({ organizationId, outletId }, ids);
      return resolveCatalogLine(await readWorkspace(), input, mayWriteCost);
    },
    resolveProcurement: async ({ organizationId, outletId, ...input }) => {
      assertScope({ organizationId, outletId }, ids);
      return resolveCatalogProcurement(await readHpp(), input);
    },
    authorizeOwner: async ({ organizationId, outletId }) => organizationId === ids.organizationId && outletId === ids.outletId,
    receiptPoster: async ({ command, actor }) => postCanonicalReceipt({ runtime, ids, command, actor, readWorkspace }),
  });

  return Object.freeze({
    service,
    catalog: async (context) => {
      assertScope(context, ids);
      const workspace = await readWorkspace();
      const capabilities = context.staffId ? await service.getStaffCapabilities(context) : { capabilities: [] };
      return buildCatalog(workspace, await readHpp(), capabilities.capabilities, clock(), service.limits);
    },
    health: () => storage.health(),
  });
}

function buildCatalog(workspace, hpp, capabilities, now, limits) {
  const options = workspace.ingredients?.purchaseOptions ?? [];
  const suppliers = new Set();
  for (const option of options) if (option.supplierName) suppliers.add(option.supplierName);
  const ingredients = (workspace.ingredients?.items ?? [])
    .filter((item) => item.status === "ACTIVE" && item.purchasable === true && item.sourcingMode !== "MADE_IN_HOUSE")
    .map((item) => {
      const itemOptions = options.filter((option) => option.ingredientId === item.id).map(optionView);
      if (!itemOptions.length) itemOptions.push({
        id: `base:${item.id}`,
        purchaseOptionId: null,
        label: item.baseUom,
        purchaseUnit: item.baseUom,
        baseUnitsPerPurchaseUnit: 1,
        referencePriceRupiah: item.currentAverageCostPerBaseUnitRupiah,
        supplierName: null,
        preferred: true,
      });
      return Object.freeze({
        id: item.id,
        code: item.sku,
        name: item.name,
        baseUnit: item.baseUom,
        active: true,
        purchasable: true,
        lotTrackingPolicy: item.lotTrackingPolicy,
        minimumShelfLifeDays: item.minimumShelfLifeDays,
        purchaseOptions: itemOptions,
      });
    });
  return Object.freeze({
    ingredients,
    suppliers: [...suppliers].sort((left, right) => left.localeCompare(right, "id")),
    supplierRecords: (hpp.suppliers ?? []).filter((supplier) => supplier.active !== false).map((supplier) => ({ id: supplier.id, name: supplier.name, active: supplier.active !== false })),
    purchaseOrders: (hpp.purchaseOrders ?? []).filter((order) => order.status === "OPEN").map((order) => ({
      id: order.id, supplierId: order.supplierId, supplierName: order.supplierNameSnapshot, expectedDate: order.expectedDate,
      status: order.status, revision: order.revision,
      lines: order.lines.map((line) => ({ ingredientId: line.ingredientId, purchaseUnitLabel: line.purchaseUnitLabel,
        baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit, orderedPurchaseQuantity: line.orderedPurchaseQuantity,
        deliveredPurchaseQuantity: line.deliveredPurchaseQuantity, unitCostRupiah: line.unitCostRupiah })),
    })),
    outlet: { id: workspace.warehouse?.locations?.[0]?.id?.replace(/:USABLE$/, "") ?? null, name: workspace.warehouse?.locations?.[0]?.name ?? "Outlet sesi" },
    capabilities,
    limits: {
      maxReceiptPhotos: limits.maxReceiptPhotos,
      maxLinePhotos: limits.maxLinePhotos,
      maxBytes: limits.maxEvidenceBytes,
      requireReceiptPhoto: limits.requiredReceiptPhotos > 0,
      requireLinePhoto: limits.requiredLinePhotos > 0,
    },
    serverTime: now.toISOString(),
    revision: workspace.revision,
  });
}

function optionView(option) {
  return Object.freeze({
    id: option.purchaseOptionId,
    purchaseOptionId: option.purchaseOptionId,
    label: option.label,
    purchaseUnit: option.purchaseUnit,
    innerUnit: option.innerUnit ?? null,
    innerUnitsPerPurchaseUnit: option.innerUnitsPerPurchaseUnit ?? null,
    baseUnitsPerInnerUnit: option.baseUnitsPerInnerUnit ?? null,
    baseUnitsPerPurchaseUnit: option.baseUnitsPerPurchaseUnit,
    referencePriceRupiah: option.referencePriceRupiah ?? null,
    supplierName: option.supplierName ?? null,
    preferred: option.preferred === true,
    sequence: option.sequence,
  });
}

function resolveCatalogLine(workspace, input, mayWriteCost) {
  const ingredient = (workspace.ingredients?.items ?? []).find((item) => item.id === input.ingredientId);
  if (!ingredient) throw domainError("staff_receiving_ingredient_not_found", 404);
  const active = ingredient.status === "ACTIVE";
  const purchasable = ingredient.purchasable === true && ingredient.sourcingMode !== "MADE_IN_HOUSE";
  const syntheticBaseOption = input.purchaseOptionId === `base:${ingredient.id}`;
  const option = input.purchaseOptionId && !syntheticBaseOption
    ? (workspace.ingredients?.purchaseOptions ?? []).find((item) => item.purchaseOptionId === input.purchaseOptionId && item.ingredientId === ingredient.id)
    : null;
  if (input.purchaseOptionId && !syntheticBaseOption && !option) throw domainError("staff_receiving_purchase_option_not_found", 404);
  const purchaseUnit = option?.purchaseUnit ?? input.purchaseUnit;
  const baseUnitsPerPurchaseUnit = option?.baseUnitsPerPurchaseUnit ?? (purchaseUnit === ingredient.baseUom ? 1 : null);
  if (!purchaseUnit || !Number.isFinite(Number(baseUnitsPerPurchaseUnit)) || Number(baseUnitsPerPurchaseUnit) <= 0) {
    throw domainError("staff_receiving_purchase_conversion_missing", 422);
  }
  const accepted = Number(input.acceptedQuantity);
  const normalizedBaseQuantity = roundQuantity(accepted * Number(baseUnitsPerPurchaseUnit));
  const confirmedCostRupiah = mayWriteCost && input.costRupiah != null ? Number(input.costRupiah) : null;
  const referencePrice = option?.referencePriceRupiah ?? (ingredient.currentAverageCostPerBaseUnitRupiah == null
    ? null
    : Number(ingredient.currentAverageCostPerBaseUnitRupiah) * Number(baseUnitsPerPurchaseUnit));
  const provisionalCostRupiah = confirmedCostRupiah == null && Number.isFinite(Number(referencePrice)) && Number(referencePrice) > 0
    ? Math.round(Number(referencePrice) * accepted)
    : null;
  const exceptionReasons = [];
  if (accepted <= 0) exceptionReasons.push("ACCEPTED_QUANTITY_REQUIRED");
  if (ingredient.lotTrackingPolicy === "REQUIRED" && !input.lotCode) exceptionReasons.push("LOT_REQUIRED");
  if (Number(ingredient.minimumShelfLifeDays) > 0 && !input.expiryDate) exceptionReasons.push("EXPIRY_REQUIRED");
  if (confirmedCostRupiah == null && provisionalCostRupiah == null) exceptionReasons.push("COST_REQUIRES_REVIEW");
  if (input.rejectedQuantity > 0) exceptionReasons.push("REJECTED_QUANTITY");
  if (input.damagedQuantity > 0) exceptionReasons.push("DAMAGED_QUANTITY");
  return {
    active,
    purchasable,
    ingredientSnapshot: {
      id: ingredient.id,
      code: ingredient.sku,
      name: ingredient.name,
      baseUnit: ingredient.baseUom,
      lotTrackingPolicy: ingredient.lotTrackingPolicy,
      minimumShelfLifeDays: ingredient.minimumShelfLifeDays,
      revision: ingredient.revision,
    },
    purchaseOptionSnapshot: option ? optionView(option) : {
      purchaseOptionId: null,
      label: purchaseUnit,
      purchaseUnit,
      baseUnitsPerPurchaseUnit: Number(baseUnitsPerPurchaseUnit),
      referencePriceRupiah: referencePrice ?? null,
      supplierName: null,
      preferred: true,
    },
    normalizedBaseQuantity,
    confirmedCostRupiah,
    provisionalCostRupiah,
    costSource: confirmedCostRupiah != null ? "STAFF_CONFIRMED" : provisionalCostRupiah != null ? "APPROVED_OPTION" : null,
    exceptionReasons,
  };
}

export function resolveCatalogProcurement(hpp, input) {
  const suppliers = hpp.suppliers ?? [];
  const orders = hpp.purchaseOrders ?? [];
  const requestedSupplier = input.supplierId ? suppliers.find((supplier) => supplier.id === input.supplierId) : null;
  if (input.supplierId && !requestedSupplier) throw domainError("staff_receiving_supplier_not_found", 404);
  if (requestedSupplier?.active === false) throw domainError("staff_receiving_supplier_inactive", 409);
  const order = input.purchaseOrderId ? orders.find((candidate) => candidate.id === input.purchaseOrderId) : null;
  if (input.purchaseOrderId && !order) throw domainError("staff_receiving_purchase_order_not_found", 404);
  if (order && order.status !== "OPEN") throw domainError(order.status === "CANCELLED" ? "staff_receiving_purchase_order_cancelled" : "staff_receiving_purchase_order_closed", 409);
  if (order && requestedSupplier && requestedSupplier.id !== order.supplierId) throw domainError("staff_receiving_purchase_order_supplier_mismatch", 409);
  const supplier = order ? suppliers.find((candidate) => candidate.id === order.supplierId) : requestedSupplier;
  if (order && !supplier) throw domainError("staff_receiving_purchase_order_supplier_missing", 409);
  const canonicalSupplierName = order?.supplierNameSnapshot ?? supplier?.name ?? input.supplierName ?? null;
  if (input.supplierName && canonicalSupplierName && normalizedName(input.supplierName) !== normalizedName(canonicalSupplierName)) {
    throw domainError("staff_receiving_supplier_name_mismatch", 409);
  }
  const grouped = new Map();
  for (const line of input.lines) {
    const group = grouped.get(line.ingredientId) ?? [];
    group.push(line);
    grouped.set(line.ingredientId, group);
    const packageSupplierName = line.purchaseOptionSnapshot?.supplierName;
    if (packageSupplierName && canonicalSupplierName && normalizedName(packageSupplierName) !== normalizedName(canonicalSupplierName)) {
      throw domainError("staff_receiving_package_supplier_mismatch", 409);
    }
  }
  if (order) {
    for (const [ingredientId, lines] of grouped) {
      const ordered = order.lines.find((line) => line.ingredientId === ingredientId);
      if (!ordered) throw domainError("staff_receiving_purchase_order_line_not_found", 404);
      const option = lines[0].purchaseOptionSnapshot ?? {};
      if ((option.label ?? option.purchaseUnit) !== ordered.purchaseUnitLabel
        || Number(option.baseUnitsPerPurchaseUnit) !== Number(ordered.baseUnitsPerPurchaseUnit)) {
        throw domainError("staff_receiving_purchase_order_package_mismatch", 409);
      }
      const accepted = roundQuantity(lines.reduce((sum, line) => sum + Number(line.acceptedQuantity), 0));
      const actualCost = lines.reduce((sum, line) => sum + Number(line.costRupiah ?? 0), 0);
      const expectedCost = Math.round(accepted * Number(ordered.unitCostRupiah));
      if (!Number.isSafeInteger(actualCost) || actualCost !== expectedCost) throw domainError("staff_receiving_purchase_order_cost_mismatch", 409);
    }
  }
  return {
    supplierId: order?.supplierId ?? supplier?.id ?? null,
    purchaseOrderId: order?.id ?? null,
    supplierName: canonicalSupplierName,
    additionalFees: input.additionalFees,
    procurementSnapshot: {
      source: order ? "PURCHASE_ORDER" : supplier ? "SUPPLIER_MASTER" : "UNPLANNED",
      supplier: supplier ? { id: supplier.id, name: canonicalSupplierName } : null,
      purchaseOrder: order ? { id: order.id, revision: order.revision, expectedDate: order.expectedDate, status: order.status } : null,
      validatedAtBusinessDate: input.businessDate,
    },
  };
}

async function postCanonicalReceipt({ runtime, ids, command, actor, readWorkspace }) {
  const payload = buildCanonicalReceiptPayload(command, ids);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const workspace = await readWorkspace();
    try {
      const result = await runtime.inventoryWorkspaceAction("owner", actor.staffId ?? actor.actorReference, {
        action: "warehouse.receipt.post",
        expectedRevision: workspace.revision,
        reason: `Barang datang dicatat karyawan (${command.sourceReceiptId})`,
        payload,
      });
      return { receiptId: result.operation?.receipt?.id, workspaceRevision: result.workspace?.revision };
    } catch (error) {
      if (attempt === 0 && error?.code === "hpp_version_conflict") continue;
      throw error;
    }
  }
  throw domainError("staff_receiving_post_conflict", 409);
}

export function buildCanonicalReceiptPayload(command, ids) {
  const groups = new Map();
  for (const line of command.lines) {
    const option = line.purchaseOptionSnapshot ?? {};
    const deliveredPurchaseQuantity = Number(line.deliveredQuantity);
    const acceptedPurchaseQuantity = Number(line.acceptedQuantity);
    const rejectedPurchaseQuantity = Number(line.rejectedQuantity);
    const quarantinedPurchaseQuantity = Number(line.damagedQuantity);
    const pendingInspectionPurchaseQuantity = roundQuantity(deliveredPurchaseQuantity - acceptedPurchaseQuantity - rejectedPurchaseQuantity - quarantinedPurchaseQuantity);
    if (![deliveredPurchaseQuantity, acceptedPurchaseQuantity, rejectedPurchaseQuantity, quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity].every(Number.isFinite)
      || pendingInspectionPurchaseQuantity < 0) throw domainError("staff_receiving_quantity_balance_invalid", 422);
    if (!Number.isSafeInteger(line.costRupiah) || line.costRupiah <= 0) throw domainError("staff_receiving_cost_unresolved", 409);
    const packageKey = JSON.stringify([option.purchaseOptionId ?? null, option.purchaseUnit ?? null, option.label ?? null, Number(option.baseUnitsPerPurchaseUnit ?? 0)]);
    let group = groups.get(line.ingredientId);
    if (!group) {
      group = { ingredientId: line.ingredientId, option, packageKey, deliveredPurchaseQuantity: 0, acceptedPurchaseQuantity: 0,
        rejectedPurchaseQuantity: 0, quarantinedPurchaseQuantity: 0, pendingInspectionPurchaseQuantity: 0, totalCostRupiah: 0, lots: [], notes: [] };
      groups.set(line.ingredientId, group);
    } else if (group.packageKey !== packageKey) {
      throw domainError("staff_receiving_multi_lot_package_mismatch", 422);
    }
    for (const field of ["deliveredPurchaseQuantity", "acceptedPurchaseQuantity", "rejectedPurchaseQuantity", "quarantinedPurchaseQuantity", "pendingInspectionPurchaseQuantity"]) {
      group[field] = roundQuantity(group[field] + { deliveredPurchaseQuantity, acceptedPurchaseQuantity, rejectedPurchaseQuantity, quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity }[field]);
    }
    group.totalCostRupiah += line.costRupiah;
    if (!Number.isSafeInteger(group.totalCostRupiah) || group.totalCostRupiah > 1_000_000_000) throw domainError("staff_receiving_cost_invalid", 422);
    if (line.note) group.notes.push(line.note);
    if (line.lotCode || line.expiryDate) {
      if (!line.lotCode || !line.expiryDate) throw domainError("staff_receiving_multi_lot_identity_required", 422);
      if (group.lots.some((lot) => lot.lotCode === line.lotCode)) throw domainError("staff_receiving_lot_duplicate", 422);
      group.lots.push({ lotCode: line.lotCode, expiryDate: line.expiryDate, deliveredPurchaseQuantity, acceptedPurchaseQuantity,
        rejectedPurchaseQuantity, quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity });
    }
  }
  const lines = [...groups.values()].map((group) => {
    const mapped = {
      ingredientId: group.ingredientId,
      purchaseQuantity: group.acceptedPurchaseQuantity,
      acceptedPurchaseQuantity: group.acceptedPurchaseQuantity,
      deliveredPurchaseQuantity: group.deliveredPurchaseQuantity,
      rejectedPurchaseQuantity: group.rejectedPurchaseQuantity,
      quarantinedPurchaseQuantity: group.quarantinedPurchaseQuantity,
      pendingInspectionPurchaseQuantity: group.pendingInspectionPurchaseQuantity,
      ...(group.rejectedPurchaseQuantity > 0 ? { rejectionReason: "DAMAGED" } : {}),
      totalCostRupiah: group.totalCostRupiah,
      ...(group.option.purchaseOptionId
        ? { purchaseOptionId: group.option.purchaseOptionId }
        : { purchaseUom: group.option.purchaseUnit, packageLabel: group.option.label ?? group.option.purchaseUnit }),
    };
    if (group.lots.length) mapped.lots = group.lots;
    return mapped;
  });
  return {
    idempotencyKey: command.idempotencyKey,
    businessDate: command.businessDate,
    supplierName: command.supplierName,
    ...(command.purchaseOrderId ? { purchaseOrderId: command.purchaseOrderId } : {}),
    additionalFees: command.additionalFees ?? [],
    destinationLocationId: `${ids.outletId}:USABLE`,
    lines,
  };
}

function assertScope(context, ids) {
  if (context?.organizationId !== ids.organizationId || context?.outletId !== ids.outletId) throw domainError("staff_receiving_scope_denied", 403);
}

function normalizedName(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("id-ID").replace(/\s+/g, " ");
}

function roundQuantity(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function domainError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
