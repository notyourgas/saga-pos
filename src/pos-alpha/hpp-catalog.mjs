import { createHash, randomUUID } from "node:crypto";

import { calculateRecipeCost } from "../services/recipe.mjs";
import { buildCogsReconciliation } from "../services/cogs-reconciliation.mjs";
import { defaultMaterialCategories, MATERIAL_CATEGORY_BASE_UNITS, MATERIAL_CATEGORY_STORAGE_TYPES } from "../services/material-catalog-defaults.mjs";

const BASE_UNITS = new Set(["gram", "ml", "pcs"]);
const LEGACY_HPP_STATE_VERSION = 21;
const MASTER_DATA_STATE_VERSION = 22;
const HPP_STATE_VERSION = 22;
const OFFLINE_CONSUMPTION_REASON = "OFFLINE_PHYSICAL_SALE";
const FULFILLMENT_RECIPE_ORDER_TYPES = new Set(["TAKEAWAY"]);
const FULFILLMENT_RECIPE_STATIONS = new Set(["bar", "food"]);
const PURCHASE_ORDER_STATUSES = new Set(["OPEN", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"]);
const PURCHASE_REJECTION_REASONS = new Set(["DAMAGED", "MISSING", "WRONG_ITEM", "EXPIRED"]);
const LOT_TRACKING_POLICIES = new Set(["NOT_REQUIRED", "REQUIRED"]);
const OVER_RECEIPT_CLASSIFICATIONS = new Set(["PAID", "BONUS", "ERROR"]);
const PURCHASE_FEE_TYPES = new Set(["SHIPPING", "HANDLING", "OTHER"]);
const PURCHASE_CREDIT_TYPES = new Set(["PRICE_CORRECTION", "SERVICE_CREDIT", "OTHER_NON_STOCK", "GOODS_RETURN"]);
const PURCHASE_PAYMENT_METHODS = new Set(["BANK_TRANSFER", "CASH", "E_WALLET", "OTHER"]);
const SUPPLIER_RETURN_DISPOSITIONS = new Set(["CREDIT_EXPECTED", "REPLACEMENT_EXPECTED"]);
const MANUAL_INVENTORY_MOVEMENT_TYPES = new Set(["CYCLE_COUNT", "SPOILAGE_WASTE", "PRODUCTION_WASTE", "DAMAGED", "INTERNAL_USE", "SAMPLES_PROMOTIONAL", "LOSS_THEFT"]);
const INVENTORY_MOVEMENT_TYPES = new Set([...MANUAL_INVENTORY_MOVEMENT_TYPES, "SALE_CONSUMPTION", "PRODUCTION_INPUT", "PRODUCTION_OUTPUT", "TRANSFER_OUT", "TRANSFER_IN", "REVERSAL"]);
const INGREDIENT_SOURCING_MODES = new Set(["PURCHASED", "MADE_IN_HOUSE"]);
const INGREDIENT_MATERIAL_TYPES = new Set(["RAW_MATERIAL", "PREP_ITEM", "PACKAGING", "CONSUMABLE", "RESALE_GOOD"]);
const PRODUCTION_BUNDLE_REVERSAL = Symbol("PRODUCTION_BUNDLE_REVERSAL");

export class HppCatalog {
  constructor({ productProvider = () => [], clock = () => new Date() } = {}) {
    this.productProvider = productProvider;
    this.clock = clock;
    this.version = 1;
    this.ingredients = new Map();
    this.ingredientConversions = [];
    this.ingredientSupplierPackages = [];
    this.ingredientReferencePriceVersions = [];
    this.materialCategories = defaultMaterialCategories();
    this.materialCategoryStateEnabled = false;
    this.masterDataStateEnabled = false;
    this.recipes = new Map();
    this.recipeDrafts = new Map();
    this.publishedRecipes = [];
    this.inventoryBalances = new Map();
    this.purchaseReceipts = [];
    this.purchaseReceiptInspectionDecisions = [];
    this.inventoryMovements = [];
    this.inventoryCounts = [];
    this.saleConsumptions = [];
    this.inventoryReservations = [];
    this.cogsAdjustments = [];
    this.inventoryPeriods = [];
    this.suppliers = [];
    this.purchaseOrders = [];
    this.purchaseInvoices = [];
    this.purchaseInvoiceCredits = [];
    this.purchaseInvoicePayments = [];
    this.supplierReturns = [];
    this.modifierRecipes = new Map();
    this.fulfillmentRecipes = new Map();
    this.optionalStateFieldPresence = {
      purchaseInvoicePayments: true,
      modifierRecipes: true,
      fulfillmentRecipes: true,
      recipeLifecycle: false,
    };
    this.gateEnabled = false;
    this.audit = [];
  }

  exportState() {
    return structuredClone({
      stateVersion: this.masterDataStateEnabled ? HPP_STATE_VERSION : LEGACY_HPP_STATE_VERSION,
      version: this.version,
      gateEnabled: this.gateEnabled,
      ingredients: [...this.ingredients.values()],
      ...(this.masterDataStateEnabled ? {
        ingredientConversions: this.ingredientConversions,
        ingredientSupplierPackages: this.ingredientSupplierPackages,
        ...(this.materialCategoryStateEnabled ? { materialCategories: this.materialCategories } : {}),
      } : {}),
      recipes: [...this.recipes.values()],
      ...(this.optionalStateFieldPresence.recipeLifecycle || this.recipeDrafts.size || this.publishedRecipes.length ? {
        recipeDrafts: [...this.recipeDrafts.values()],
        publishedRecipes: this.publishedRecipes,
      } : {}),
      inventoryBalances: [...this.inventoryBalances.values()],
      purchaseReceipts: this.purchaseReceipts,
      purchaseReceiptInspectionDecisions: this.purchaseReceiptInspectionDecisions,
      inventoryMovements: this.inventoryMovements,
      inventoryCounts: this.inventoryCounts,
      saleConsumptions: this.saleConsumptions,
      inventoryReservations: this.inventoryReservations,
      cogsAdjustments: this.cogsAdjustments,
      inventoryPeriods: this.inventoryPeriods,
      suppliers: this.suppliers,
      purchaseOrders: this.purchaseOrders,
      purchaseInvoices: this.purchaseInvoices,
      purchaseInvoiceCredits: this.purchaseInvoiceCredits,
      ...(this.optionalStateFieldPresence.purchaseInvoicePayments || this.purchaseInvoicePayments.length ? { purchaseInvoicePayments: this.purchaseInvoicePayments } : {}),
      supplierReturns: this.supplierReturns,
      ...(this.optionalStateFieldPresence.modifierRecipes || this.modifierRecipes.size ? { modifierRecipes: [...this.modifierRecipes.values()] } : {}),
      ...(this.optionalStateFieldPresence.fulfillmentRecipes || this.fulfillmentRecipes.size ? { fulfillmentRecipes: [...this.fulfillmentRecipes.values()] } : {}),
      audit: this.audit,
    });
  }

  restoreState(state) {
    if (!state || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, LEGACY_HPP_STATE_VERSION, HPP_STATE_VERSION].includes(state.stateVersion) || !Number.isSafeInteger(state.version) || state.version < 1 || typeof state.gateEnabled !== "boolean" || !Array.isArray(state.ingredients) || !Array.isArray(state.recipes) || !Array.isArray(state.audit)) throw domainError("hpp_state_invalid", 500);
    const ingredientsV21 = state.stateVersion < 21 ? state.ingredients.map(migrateIngredientV21) : state.ingredients;
    const storedIngredients = ingredientsV21;
    const ingredients = new Map();
    const ingredientCodes = new Set();
    for (const ingredient of storedIngredients) {
      validateIngredientRecord(ingredient);
      if (state.stateVersion >= MASTER_DATA_STATE_VERSION) validateIngredientMasterRecord(ingredient);
      if (ingredients.has(ingredient.id) || (state.stateVersion >= MASTER_DATA_STATE_VERSION && ingredientCodes.has(ingredient.code))) throw domainError("hpp_state_invalid", 500);
      ingredients.set(ingredient.id, structuredClone(ingredient));
      if (state.stateVersion >= MASTER_DATA_STATE_VERSION) ingredientCodes.add(ingredient.code);
    }
    const ingredientConversions = state.stateVersion < MASTER_DATA_STATE_VERSION ? [] : state.ingredientConversions;
    const ingredientSupplierPackages = state.stateVersion < MASTER_DATA_STATE_VERSION ? [] : state.ingredientSupplierPackages;
    const ingredientReferencePriceVersions = restoreIngredientReferencePriceVersions(state.audit);
    const materialCategories = state.stateVersion < MASTER_DATA_STATE_VERSION || !Object.hasOwn(state, "materialCategories")
      ? restoreMaterialCategoriesFromState(storedIngredients, state.audit)
      : state.materialCategories;
    if (!Array.isArray(ingredientConversions) || !Array.isArray(ingredientSupplierPackages) || !Array.isArray(ingredientReferencePriceVersions)) throw domainError("hpp_state_invalid", 500);
    validateIngredientConversions(ingredientConversions, ingredients, state.version);
    validateIngredientSupplierPackages(ingredientSupplierPackages, ingredients, state.version);
    validateIngredientReferencePriceVersions(ingredientReferencePriceVersions, ingredients, ingredientSupplierPackages, state.version);
    validateMaterialCategories(materialCategories, state.version);
    const materialCategoryIds = new Set(materialCategories.map((item) => item.id));
    for (const ingredient of ingredients.values()) {
      if (ingredient.categoryId != null && !materialCategoryIds.has(ingredient.categoryId)) throw domainError("hpp_state_invalid", 500);
      if (ingredient.categorySnapshot !== undefined && ingredient.categorySnapshot !== null) validateCategorySnapshot(ingredient.categorySnapshot, state.version);
    }
    const recipes = new Map();
    for (const recipe of state.recipes) {
      validateRecipeRecord(recipe, ingredients);
      if (recipes.has(recipe.productId)) throw domainError("hpp_state_invalid", 500);
      recipes.set(recipe.productId, structuredClone(recipe));
    }
    const recipeDraftRows = state.recipeDrafts ?? [];
    const publishedRecipeRows = state.publishedRecipes ?? [];
    if (!Array.isArray(recipeDraftRows) || !Array.isArray(publishedRecipeRows)) throw domainError("hpp_state_invalid", 500);
    const recipeDrafts = new Map();
    for (const draft of recipeDraftRows) {
      validateRecipeDraftRecord(draft, ingredients);
      if (recipeDrafts.has(draft.productId)) throw domainError("hpp_state_invalid", 500);
      recipeDrafts.set(draft.productId, structuredClone(draft));
    }
    const publishedRecipes = [];
    const publishedKeys = new Set();
    for (const published of publishedRecipeRows) {
      validatePublishedRecipeRecord(published, ingredients);
      const key = `${published.productId}:${published.version}`;
      if (publishedKeys.has(key)) throw domainError("hpp_state_invalid", 500);
      publishedKeys.add(key);
      publishedRecipes.push(structuredClone(published));
    }
    const inventoryBalances = new Map();
    const balanceRows = state.stateVersion === 1 ? [] : state.inventoryBalances;
    const storedPurchaseReceipts = state.stateVersion === 1 ? [] : state.purchaseReceipts;
    const purchaseReceiptsV10 = state.stateVersion < 10 ? storedPurchaseReceipts.map(migratePurchaseReceiptV10) : storedPurchaseReceipts;
    const purchaseReceiptsV20 = state.stateVersion < 20 ? purchaseReceiptsV10.map(migratePurchaseReceiptV20) : purchaseReceiptsV10;
    const purchaseReceipts = state.stateVersion < 21 ? purchaseReceiptsV20.map(migratePurchaseReceiptV21) : purchaseReceiptsV20;
    const purchaseReceiptInspectionDecisions = state.stateVersion < 21 ? [] : state.purchaseReceiptInspectionDecisions;
    const inventoryMovements = state.stateVersion < 3 ? [] : state.inventoryMovements;
    const inventoryCounts = state.stateVersion < 4 ? [] : state.inventoryCounts;
    const saleConsumptionsV17 = state.stateVersion < 5 ? [] : state.stateVersion < 17
      ? state.saleConsumptions.map(migrateSaleConsumptionV17)
      : state.saleConsumptions;
    const saleConsumptionsV18 = state.stateVersion < 18
      ? saleConsumptionsV17.map((consumption) => migrateSaleConsumptionV18(consumption, inventoryMovements))
      : saleConsumptionsV17;
    const saleConsumptions = state.stateVersion < 19
      ? saleConsumptionsV18.map(migrateSaleConsumptionV19)
      : saleConsumptionsV18;
    const inventoryReservations = state.stateVersion < 18 ? [] : state.inventoryReservations;
    const cogsAdjustments = state.stateVersion < 18 ? [] : state.cogsAdjustments;
    const inventoryPeriods = state.stateVersion < 6 ? [] : state.inventoryPeriods;
    const suppliers = state.stateVersion < 7 ? [] : state.suppliers;
    const storedPurchaseOrders = state.stateVersion < 7 ? [] : state.stateVersion < 9
      ? state.purchaseOrders.map((order) => ({ ...structuredClone(order), creationFingerprint: order.fingerprint, revision: 1, changes: [] }))
      : state.purchaseOrders;
    const purchaseOrdersV10 = state.stateVersion < 10 ? storedPurchaseOrders.map((order) => ({
      ...structuredClone(order),
      lines: order.lines.map((line) => ({ ...line, rejectedPurchaseQuantity: 0 })),
    })) : storedPurchaseOrders;
    const purchaseOrdersV20 = state.stateVersion < 20 ? purchaseOrdersV10.map(migratePurchaseOrderV20) : purchaseOrdersV10;
    const purchaseOrders = state.stateVersion < 21 ? purchaseOrdersV20.map(migratePurchaseOrderV21) : purchaseOrdersV20;
    const storedPurchaseInvoices = state.stateVersion < 11 ? [] : state.purchaseInvoices;
    const purchaseInvoicesV12 = state.stateVersion < 12 ? storedPurchaseInvoices.map(migratePurchaseInvoiceV12) : storedPurchaseInvoices;
    const purchaseInvoicesV13 = state.stateVersion < 13 ? purchaseInvoicesV12.map(migratePurchaseInvoiceV13) : purchaseInvoicesV12;
    const purchaseInvoices = state.stateVersion < 19 ? purchaseInvoicesV13.map(migratePurchaseInvoiceV19) : purchaseInvoicesV13;
    const storedPurchaseInvoiceCredits = state.stateVersion < 13 ? [] : state.purchaseInvoiceCredits;
    const purchaseInvoiceCreditsV15 = state.stateVersion < 15 ? storedPurchaseInvoiceCredits.map(migratePurchaseInvoiceCreditV15) : storedPurchaseInvoiceCredits;
    const purchaseInvoiceCredits = state.stateVersion < 16 ? purchaseInvoiceCreditsV15.map((credit) => ({ ...structuredClone(credit), reversalHistory: [] })) : purchaseInvoiceCreditsV15;
    const purchaseInvoicePayments = state.stateVersion < 19 || state.purchaseInvoicePayments === undefined ? [] : state.purchaseInvoicePayments;
    const storedSupplierReturns = state.stateVersion < 14 ? [] : state.supplierReturns;
    const supplierReturns = state.stateVersion < 15 ? storedSupplierReturns.map((item) => ({ ...structuredClone(item), creditMemoId: null })) : storedSupplierReturns;
    const modifierRecipeRows = state.stateVersion < 17 || state.modifierRecipes === undefined ? [] : state.modifierRecipes;
    const fulfillmentRecipeRows = state.stateVersion < 18 || state.fulfillmentRecipes === undefined ? [] : state.fulfillmentRecipes;
    if (!Array.isArray(balanceRows) || !Array.isArray(purchaseReceipts) || !Array.isArray(purchaseReceiptInspectionDecisions) || !Array.isArray(inventoryMovements) || !Array.isArray(inventoryCounts) || !Array.isArray(saleConsumptions) || !Array.isArray(inventoryReservations) || !Array.isArray(cogsAdjustments) || !Array.isArray(inventoryPeriods) || !Array.isArray(suppliers) || !Array.isArray(purchaseOrders) || !Array.isArray(purchaseInvoices) || !Array.isArray(purchaseInvoiceCredits) || !Array.isArray(purchaseInvoicePayments) || !Array.isArray(supplierReturns) || !Array.isArray(modifierRecipeRows) || !Array.isArray(fulfillmentRecipeRows)) throw domainError("hpp_state_invalid", 500);
    for (const balance of balanceRows) {
      validateInventoryBalance(balance, ingredients);
      if (inventoryBalances.has(balance.ingredientId)) throw domainError("hpp_state_invalid", 500);
      inventoryBalances.set(balance.ingredientId, structuredClone(balance));
    }
    const receiptKeys = new Set();
    const eventVersions = new Set();
    for (const receipt of purchaseReceipts) {
      validatePurchaseReceipt(receipt, ingredients);
      if (receiptKeys.has(receipt.idempotencyKey) || eventVersions.has(receipt.version) || receipt.version > state.version) throw domainError("hpp_state_invalid", 500);
      receiptKeys.add(receipt.idempotencyKey);
      eventVersions.add(receipt.version);
    }
    const inspectionKeys = new Set();
    for (const decision of purchaseReceiptInspectionDecisions) {
      validatePurchaseReceiptInspectionDecision(decision, purchaseReceipts, ingredients);
      if (inspectionKeys.has(decision.idempotencyKey) || eventVersions.has(decision.version) || decision.version > state.version) throw domainError("hpp_state_invalid", 500);
      inspectionKeys.add(decision.idempotencyKey);
      eventVersions.add(decision.version);
    }
    validatePurchaseInspectionTotals(purchaseReceiptInspectionDecisions, purchaseReceipts);
    const movementKeys = new Set();
    const movementIds = new Set();
    const reversedMovementIds = new Set();
    const productionOutputLots = new Set();
    for (const movement of inventoryMovements) {
      validateInventoryMovement(movement, ingredients);
      if (movementKeys.has(movement.idempotencyKey) || movementIds.has(movement.id) || eventVersions.has(movement.version) || movement.version > state.version) throw domainError("hpp_state_invalid", 500);
      if (movement.movementType === "REVERSAL") {
        const original = inventoryMovements.find((item) => item.id === movement.reversalOfMovementId && item.version < movement.version);
        if (!original || original.movementType === "REVERSAL" || original.ingredientId !== movement.ingredientId
          || reversedMovementIds.has(original.id) || movement.quantityDeltaBase !== -original.quantityDeltaBase
          || movement.inventoryValueDeltaRupiah !== -original.inventoryValueDeltaRupiah) throw domainError("hpp_state_invalid", 500);
        reversedMovementIds.add(original.id);
      }
      if (movement.outputLot) {
        const lotKey = `${movement.ingredientId}\u0000${movement.outputLot.lotId}`;
        if (productionOutputLots.has(lotKey)) throw domainError("hpp_state_invalid", 500);
        productionOutputLots.add(lotKey);
      }
      movementKeys.add(movement.idempotencyKey);
      movementIds.add(movement.id);
      eventVersions.add(movement.version);
    }
    for (const movement of inventoryMovements.filter((item) => item.movementType === "TRANSFER_OUT")) {
      const pairs = inventoryMovements.filter((item) => item.transferId === movement.transferId && item.movementType === "TRANSFER_IN");
      const pair = pairs[0];
      if (pairs.length !== 1 || pair.version <= movement.version || pair.ingredientId !== movement.ingredientId
        || pair.fingerprint !== movement.fingerprint || pair.sourceLocationId !== movement.sourceLocationId
        || pair.destinationLocationId !== movement.destinationLocationId || pair.quantityInputBase !== movement.quantityInputBase
        || pair.quantityDeltaBase !== -movement.quantityDeltaBase || pair.inventoryValueDeltaRupiah !== -movement.inventoryValueDeltaRupiah
        || pair.occurredAt !== movement.occurredAt) throw domainError("hpp_state_invalid", 500);
    }
    if (inventoryMovements.some((item) => item.movementType === "TRANSFER_IN"
      && !inventoryMovements.some((candidate) => candidate.transferId === item.transferId && candidate.movementType === "TRANSFER_OUT"))) throw domainError("hpp_state_invalid", 500);
    const countKeys = new Set();
    const countIds = new Set();
    for (const count of inventoryCounts) {
      validateInventoryCount(count, ingredients, purchaseReceipts, inventoryMovements);
      if (countKeys.has(count.idempotencyKey) || countIds.has(count.id) || eventVersions.has(count.version) || count.version > state.version) throw domainError("hpp_state_invalid", 500);
      countKeys.add(count.idempotencyKey);
      countIds.add(count.id);
      eventVersions.add(count.version);
    }
    const consumptionIds = new Set();
    const productionStartIds = new Set();
    const productionStartKeys = new Set();
    const remakeIds = new Set();
    const offlineEventIds = new Set();
    const offlineDeviceSequences = new Set();
    for (const consumption of saleConsumptions) {
      validateSaleConsumption(consumption, ingredients, inventoryMovements);
      const productionStartId = consumption.productionStartId;
      const offlineEventId = consumption.sourceEvent?.eventId ?? null;
      const offlineDeviceSequence = consumption.sourceEvent ? `${consumption.sourceEvent.deviceId}\u0000${consumption.sourceEvent.localSequence}` : null;
      if (consumptionIds.has(consumption.id) || eventVersions.has(consumption.version) || consumption.version > state.version
        || productionStartIds.has(productionStartId) || productionStartKeys.has(consumption.productionStartIdempotencyKey)
        || (consumption.remakeId !== null && remakeIds.has(consumption.remakeId))
        || (offlineEventId && offlineEventIds.has(offlineEventId)) || (offlineDeviceSequence && offlineDeviceSequences.has(offlineDeviceSequence))) throw domainError("hpp_state_invalid", 500);
      consumptionIds.add(consumption.id);
      productionStartIds.add(productionStartId);
      productionStartKeys.add(consumption.productionStartIdempotencyKey);
      if (consumption.remakeId !== null) remakeIds.add(consumption.remakeId);
      if (offlineEventId) offlineEventIds.add(offlineEventId);
      if (offlineDeviceSequence) offlineDeviceSequences.add(offlineDeviceSequence);
      eventVersions.add(consumption.version);
    }
    validateInventoryReservations(inventoryReservations, ingredients, inventoryBalances, saleConsumptions, state.version);
    validateCogsAdjustments(cogsAdjustments, saleConsumptions, purchaseReceipts);
    const periodKeys = new Set();
    const periodIds = new Set();
    for (const period of inventoryPeriods) {
      validateInventoryPeriod(period, inventoryCounts);
      if (periodKeys.has(period.idempotencyKey) || periodIds.has(period.id) || eventVersions.has(period.version) || period.version > state.version) throw domainError("hpp_state_invalid", 500);
      periodKeys.add(period.idempotencyKey);
      periodIds.add(period.id);
      eventVersions.add(period.version);
    }
    validateInventoryPeriodSequence(inventoryPeriods, inventoryCounts);
    const supplierIds = new Set();
    for (const supplier of suppliers) {
      validateSupplier(supplier);
      if (supplierIds.has(supplier.id) || eventVersions.has(supplier.version) || supplier.version > state.version) throw domainError("hpp_state_invalid", 500);
      supplierIds.add(supplier.id);
      eventVersions.add(supplier.version);
    }
    const purchaseOrderKeys = new Set();
    const purchaseOrderIds = new Set();
    for (const purchaseOrder of purchaseOrders) {
      validatePurchaseOrder(purchaseOrder, suppliers, ingredients);
      if (purchaseOrderKeys.has(purchaseOrder.idempotencyKey) || purchaseOrderIds.has(purchaseOrder.id) || eventVersions.has(purchaseOrder.version) || purchaseOrder.version > state.version) throw domainError("hpp_state_invalid", 500);
      purchaseOrderKeys.add(purchaseOrder.idempotencyKey);
      purchaseOrderIds.add(purchaseOrder.id);
      eventVersions.add(purchaseOrder.version);
      for (const change of purchaseOrder.changes) {
        if (purchaseOrderKeys.has(change.idempotencyKey) || eventVersions.has(change.version) || change.version > state.version) throw domainError("hpp_state_invalid", 500);
        purchaseOrderKeys.add(change.idempotencyKey);
        eventVersions.add(change.version);
      }
    }
    validatePurchaseOrderReceiptLinks(purchaseOrders, purchaseReceipts, purchaseReceiptInspectionDecisions);
    const invoiceKeys = new Set();
    const invoiceIds = new Set();
    const supplierInvoiceNumbers = new Set();
    const priorInvoices = [];
    for (const invoice of purchaseInvoices) {
      validatePurchaseInvoice(invoice, purchaseOrders, purchaseReceipts, priorInvoices, purchaseReceiptInspectionDecisions);
      const supplierNumber = `${invoice.supplierId}\u0000${invoice.invoiceNumber.toLocaleLowerCase("id")}`;
      if (invoiceKeys.has(invoice.idempotencyKey) || invoiceIds.has(invoice.id) || supplierInvoiceNumbers.has(supplierNumber) || eventVersions.has(invoice.version) || invoice.version > state.version) throw domainError("hpp_state_invalid", 500);
      invoiceKeys.add(invoice.idempotencyKey);
      invoiceIds.add(invoice.id);
      supplierInvoiceNumbers.add(supplierNumber);
      eventVersions.add(invoice.version);
      for (const transition of invoice.approvalHistory) {
        if (invoiceKeys.has(transition.idempotencyKey) || eventVersions.has(transition.version) || transition.version > state.version) throw domainError("hpp_state_invalid", 500);
        invoiceKeys.add(transition.idempotencyKey);
        eventVersions.add(transition.version);
      }
      priorInvoices.push(invoice);
    }
    const creditKeys = new Set();
    const creditIds = new Set();
    const supplierCreditNumbers = new Set();
    for (const credit of purchaseInvoiceCredits) {
      validatePurchaseInvoiceCredit(credit, purchaseInvoices);
      const supplierNumber = `${credit.supplierId}\u0000${credit.creditNoteNumber.toLocaleLowerCase("id")}`;
      if (creditKeys.has(credit.idempotencyKey) || creditIds.has(credit.id) || supplierCreditNumbers.has(supplierNumber) || invoiceKeys.has(credit.idempotencyKey) || eventVersions.has(credit.version) || credit.version > state.version) throw domainError("hpp_state_invalid", 500);
      creditKeys.add(credit.idempotencyKey); creditIds.add(credit.id); supplierCreditNumbers.add(supplierNumber); eventVersions.add(credit.version);
      if (credit.postTransition) {
        if (creditKeys.has(credit.postTransition.idempotencyKey) || invoiceKeys.has(credit.postTransition.idempotencyKey) || eventVersions.has(credit.postTransition.version) || credit.postTransition.version > state.version) throw domainError("hpp_state_invalid", 500);
        creditKeys.add(credit.postTransition.idempotencyKey); eventVersions.add(credit.postTransition.version);
      }
      for (const reversal of credit.reversalHistory) {
        if (creditKeys.has(reversal.requestIdempotencyKey) || invoiceKeys.has(reversal.requestIdempotencyKey) || eventVersions.has(reversal.requestVersion) || reversal.requestVersion > state.version) throw domainError("hpp_state_invalid", 500);
        creditKeys.add(reversal.requestIdempotencyKey); eventVersions.add(reversal.requestVersion);
        if (reversal.decision) {
          if (creditKeys.has(reversal.decision.idempotencyKey) || invoiceKeys.has(reversal.decision.idempotencyKey) || eventVersions.has(reversal.decision.version) || reversal.decision.version > state.version) throw domainError("hpp_state_invalid", 500);
          creditKeys.add(reversal.decision.idempotencyKey); eventVersions.add(reversal.decision.version);
        }
      }
    }
    const paymentKeys = new Set();
    const paymentIds = new Set();
    for (const payment of purchaseInvoicePayments) {
      validatePurchaseInvoicePayment(payment, purchaseInvoices);
      if (paymentKeys.has(payment.idempotencyKey) || paymentIds.has(payment.id) || invoiceKeys.has(payment.idempotencyKey) || creditKeys.has(payment.idempotencyKey) || eventVersions.has(payment.version) || payment.version > state.version) throw domainError("hpp_state_invalid", 500);
      paymentKeys.add(payment.idempotencyKey);
      paymentIds.add(payment.id);
      eventVersions.add(payment.version);
    }
    validatePurchaseInvoiceCreditBalances(purchaseInvoices, purchaseInvoiceCredits, purchaseInvoicePayments);
    validateSupplierReturns(supplierReturns, purchaseReceipts, suppliers, ingredients, eventVersions);
    validateSupplierReturnCreditLinks(supplierReturns, purchaseInvoiceCredits, purchaseInvoices);
    const modifierRecipes = new Map();
    for (const modifierRecipe of modifierRecipeRows) {
      validateModifierRecipeRecord(modifierRecipe, ingredients);
      const key = modifierRecipeKey(modifierRecipe.groupId, modifierRecipe.optionId);
      if (modifierRecipes.has(key)) throw domainError("hpp_state_invalid", 500);
      modifierRecipes.set(key, structuredClone(modifierRecipe));
    }
    const fulfillmentRecipes = new Map();
    for (const fulfillmentRecipe of fulfillmentRecipeRows) {
      validateFulfillmentRecipeRecord(fulfillmentRecipe, ingredients);
      const key = fulfillmentRecipeKey(fulfillmentRecipe.orderType, fulfillmentRecipe.station);
      if (fulfillmentRecipes.has(key)) throw domainError("hpp_state_invalid", 500);
      fulfillmentRecipes.set(key, structuredClone(fulfillmentRecipe));
    }
    for (const movement of inventoryMovements) {
      if (movement.countSessionId === undefined) continue;
      const count = inventoryCounts.find((item) => item.id === movement.countSessionId);
      if (!count?.lines.some((line) => line.movementId === movement.id)) throw domainError("hpp_state_invalid", 500);
    }
    for (const movement of inventoryMovements.filter((item) => item.movementType === "SALE_CONSUMPTION")) {
      const consumption = saleConsumptions.find((item) => item.id === movement.consumptionId);
      if (!consumption?.lines.some((line) => line.movementId === movement.id)) throw domainError("hpp_state_invalid", 500);
    }
    validateInventoryReconciliation(ingredients, inventoryBalances, purchaseReceipts, inventoryMovements, supplierReturns, purchaseReceiptInspectionDecisions);
    this.version = state.version;
    this.gateEnabled = state.gateEnabled;
    this.ingredients = ingredients;
    this.ingredientConversions = structuredClone(ingredientConversions);
    this.ingredientSupplierPackages = structuredClone(ingredientSupplierPackages);
    this.ingredientReferencePriceVersions = structuredClone(ingredientReferencePriceVersions);
    this.materialCategories = structuredClone(materialCategories);
    this.materialCategoryStateEnabled = Object.hasOwn(state, "materialCategories");
    this.masterDataStateEnabled = state.stateVersion >= MASTER_DATA_STATE_VERSION;
    this.recipes = recipes;
    this.recipeDrafts = recipeDrafts;
    this.publishedRecipes = publishedRecipes;
    this.inventoryBalances = inventoryBalances;
    this.purchaseReceipts = structuredClone(purchaseReceipts);
    this.purchaseReceiptInspectionDecisions = structuredClone(purchaseReceiptInspectionDecisions);
    this.inventoryMovements = structuredClone(inventoryMovements);
    this.inventoryCounts = structuredClone(inventoryCounts);
    this.saleConsumptions = structuredClone(saleConsumptions);
    this.inventoryReservations = structuredClone(inventoryReservations);
    this.cogsAdjustments = structuredClone(cogsAdjustments);
    this.inventoryPeriods = structuredClone(inventoryPeriods);
    this.suppliers = structuredClone(suppliers);
    this.purchaseOrders = structuredClone(purchaseOrders);
    this.purchaseInvoices = structuredClone(purchaseInvoices);
    this.purchaseInvoiceCredits = structuredClone(purchaseInvoiceCredits);
    this.purchaseInvoicePayments = structuredClone(purchaseInvoicePayments);
    this.supplierReturns = structuredClone(supplierReturns);
    this.modifierRecipes = modifierRecipes;
    this.fulfillmentRecipes = fulfillmentRecipes;
    this.optionalStateFieldPresence = {
      purchaseInvoicePayments: Object.hasOwn(state, "purchaseInvoicePayments"),
      modifierRecipes: Object.hasOwn(state, "modifierRecipes"),
      fulfillmentRecipes: Object.hasOwn(state, "fulfillmentRecipes"),
      recipeLifecycle: Object.hasOwn(state, "recipeDrafts") || Object.hasOwn(state, "publishedRecipes"),
    };
    this.audit = structuredClone(state.audit);
  }

  view() {
    const catalogProducts = this.#products();
    const costIngredients = this.#costIngredients();
    const products = catalogProducts.map((product) => this.#productCost(product));
    const activeProductIds = new Set(catalogProducts.filter((product) => product.status === "active").map((product) => product.id));
    const activeProducts = products.filter((product) => activeProductIds.has(product.id));
    const productById = new Map(catalogProducts.map((product) => [product.id, product]));
    const recipeDrafts = [...this.recipeDrafts.values()].map((draft) => {
      const product = productById.get(draft.productId);
      const simulation = calculateRecipeCost({ product, recipe: draft, recipeItems: draft.items, ingredients: costIngredients });
      return {
        ...draft,
        simulation: {
          complete: simulation.complete,
          hppRupiah: simulation.complete ? simulation.hppRupiah : null,
          grossProfitRupiah: simulation.complete ? simulation.grossProfitRupiah : null,
          marginPct: simulation.complete ? simulation.marginPct : null,
          missingIngredientIds: simulation.missingIngredientIds,
          missingCostIngredientIds: simulation.missingCostIngredientIds,
          lines: simulation.lines,
        },
      };
    });
    const verified = activeProducts.filter((product) => product.hppStatus === "VERIFIED").length;
    const beverages = activeProducts.filter((product) => product.station === "bar");
    const verifiedBeverages = beverages.filter((product) => product.hppStatus === "VERIFIED").length;
    const inventoryBalances = [...this.inventoryBalances.values()].map((balance) => {
      const reservedQuantityBase = this.#reservedQuantityBase(balance.ingredientId);
      return { ...balance, reservedQuantityBase, availableQuantityBase: roundedQuantity(balance.quantityBase - reservedQuantityBase) };
    }).sort((a, b) => (this.ingredients.get(a.ingredientId)?.name ?? "").localeCompare(this.ingredients.get(b.ingredientId)?.name ?? "", "id"));
    return structuredClone({
      version: this.version,
      gateEnabled: this.gateEnabled,
      coveragePct: activeProducts.length ? Math.round(verified / activeProducts.length * 100) : null,
      beverageCoveragePct: beverages.length ? Math.round(verifiedBeverages / beverages.length * 100) : null,
      verifiedProductCount: verified,
      activeProductCount: activeProducts.length,
      ingredients: costIngredients.sort((a, b) => a.name.localeCompare(b.name, "id")).map((item) => ({ ...item, sourcingMode: ingredientSourcingMode(item), materialType: ingredientMaterialType(item), costStatus: item.costPerUnitRupiah == null ? "UNPRICED" : "PRICED", costSource: this.inventoryBalances.has(item.id) ? "PURCHASE_MOVING_AVERAGE" : item.costPerUnitRupiah == null ? "UNPRICED" : item.referencePurchaseOptionId ? "REFERENCE_PURCHASE_OPTION" : "MANUAL" })),
      ingredientConversions: this.#currentIngredientConversions(),
      ingredientConversionHistory: this.ingredientConversions,
      ingredientSupplierPackages: this.#currentIngredientSupplierPackages(),
      ingredientSupplierPackageHistory: this.ingredientSupplierPackages,
      ingredientReferencePriceVersions: this.ingredientReferencePriceVersions.slice().sort((a, b) => b.sequence - a.sequence),
      ingredientProductionRecipes: restoreIngredientProductionRecipes(this.audit, this.ingredients).sort((a, b) => a.outputIngredientName.localeCompare(b.outputIngredientName, "id")),
      productionRecipes: restoreIngredientProductionRecipes(this.audit, this.ingredients).sort((a, b) => a.outputIngredientName.localeCompare(b.outputIngredientName, "id")),
      materialCategories: this.materialCategories.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "id")),
      inventoryBalances,
      inventoryAvailability: inventoryBalances.map(({ ingredientId, quantityBase, reservedQuantityBase, availableQuantityBase }) => ({ ingredientId, quantityBase, reservedQuantityBase, availableQuantityBase })),
      purchaseReceiptCount: this.purchaseReceipts.length,
      purchaseReceipts: this.purchaseReceipts.slice(-20).reverse(),
      purchaseReceiptInspectionDecisionCount: this.purchaseReceiptInspectionDecisions.length,
      purchaseReceiptInspectionDecisions: this.purchaseReceiptInspectionDecisions.slice(-20).reverse(),
      inventoryMovementCount: this.inventoryMovements.length,
      inventoryMovements: this.inventoryMovements.slice(-20).reverse(),
      inventoryCountCount: this.inventoryCounts.length,
      inventoryCounts: this.inventoryCounts.slice(-10).reverse(),
      saleConsumptionCount: this.saleConsumptions.length,
      saleConsumptions: this.saleConsumptions.slice(-20).reverse(),
      inventoryReservationCount: this.inventoryReservations.length,
      activeInventoryReservationCount: this.inventoryReservations.filter((reservation) => reservation.status === "ACTIVE").length,
      releasedInventoryReservationCount: this.inventoryReservations.filter((reservation) => reservation.status === "RELEASED").length,
      consumedInventoryReservationCount: this.inventoryReservations.filter((reservation) => reservation.status === "CONSUMED").length,
      inventoryReservations: this.inventoryReservations.slice(-20).reverse(),
      cogsAdjustmentCount: this.cogsAdjustments.length,
      cogsAdjustments: this.cogsAdjustments.slice(-20).reverse(),
      cogsReconciliation: buildCogsReconciliation({ saleConsumptions: this.saleConsumptions, cogsAdjustments: this.cogsAdjustments }),
      inventoryPeriodCount: this.inventoryPeriods.length,
      inventoryPeriods: this.inventoryPeriods.slice(-10).reverse(),
      supplierCount: this.suppliers.length,
      suppliers: this.suppliers.slice().sort((a, b) => a.name.localeCompare(b.name, "id")),
      purchaseOrderCount: this.purchaseOrders.length,
      purchaseOrders: this.purchaseOrders.slice(-20).reverse(),
      purchaseInvoiceCount: this.purchaseInvoices.length,
      purchaseInvoiceMatchedCount: this.purchaseInvoices.filter((invoice) => invoice.matchStatus === "MATCHED").length,
      purchaseInvoiceReadyCount: this.purchaseInvoices.filter((invoice) => invoice.paymentReadiness === "READY_FOR_APPROVAL").length,
      purchaseInvoiceApprovedCount: this.purchaseInvoices.filter((invoice) => invoice.paymentReadiness === "APPROVED_NOT_POSTED").length,
      purchaseInvoicePostedCount: this.purchaseInvoices.filter((invoice) => invoice.paymentReadiness === "POSTED_UNPAID").length,
      purchaseInvoicePaidCount: this.purchaseInvoices.filter((invoice) => ["PAID", "CLOSED_BY_CREDIT_AND_PAYMENT"].includes(invoice.payableEntry?.status)).length,
      openPayableRupiah: this.purchaseInvoices.filter((invoice) => invoice.paymentReadiness === "POSTED_UNPAID" && invoice.payableEntry?.outstandingRupiah > 0).reduce((sum, invoice) => sum + invoice.payableEntry.outstandingRupiah, 0),
      paidPayableRupiah: this.purchaseInvoicePayments.reduce((sum, payment) => sum + payment.amountRupiah, 0),
      purchaseInvoices: this.purchaseInvoices.slice(-20).reverse(),
      purchaseInvoiceCreditPendingCount: this.purchaseInvoiceCredits.filter((credit) => credit.status === "PENDING_OWNER_POST").length,
      purchaseInvoiceCreditPostedCount: this.purchaseInvoiceCredits.filter((credit) => credit.status === "POSTED").length,
      purchaseInvoiceCreditReversalPendingCount: this.purchaseInvoiceCredits.filter((credit) => credit.reversalHistory.some((item) => item.status === "PENDING_OWNER_DECISION")).length,
      purchaseInvoiceCreditReversedCount: this.purchaseInvoiceCredits.filter((credit) => credit.status === "REVERSED").length,
      postedCreditRupiah: this.purchaseInvoiceCredits.filter((credit) => credit.status === "POSTED").reduce((sum, credit) => sum + credit.amountRupiah, 0),
      purchaseInvoiceCredits: this.purchaseInvoiceCredits.slice(-20).reverse(),
      purchaseInvoicePaymentCount: this.purchaseInvoicePayments.length,
      purchaseInvoicePayments: this.purchaseInvoicePayments.slice(-20).reverse(),
      supplierReturnCount: this.supplierReturns.length,
      supplierReturnAwaitingCreditCount: this.supplierReturns.filter((item) => item.status === "SHIPPED_AWAITING_CREDIT").length,
      supplierReturnCreditPendingPostCount: this.supplierReturns.filter((item) => item.status === "CREDIT_RECEIVED_PENDING_POST").length,
      supplierReturnAwaitingReplacementCount: this.supplierReturns.filter((item) => item.status === "SHIPPED_AWAITING_REPLACEMENT").length,
      supplierReturnValueRupiah: this.supplierReturns.reduce((sum, item) => sum + item.totalReturnValueRupiah, 0),
      supplierReturnOpenValueRupiah: this.supplierReturns.filter((item) => !["REPLACED", "CREDIT_POSTED"].includes(item.status)).reduce((sum, item) => sum + item.totalReturnValueRupiah, 0),
      supplierReturns: this.supplierReturns.slice(-20).reverse(),
      modifierRecipes: [...this.modifierRecipes.values()].sort((a, b) => modifierRecipeKey(a.groupId, a.optionId).localeCompare(modifierRecipeKey(b.groupId, b.optionId))),
      fulfillmentRecipes: [...this.fulfillmentRecipes.values()].sort((a, b) => fulfillmentRecipeKey(a.orderType, a.station).localeCompare(fulfillmentRecipeKey(b.orderType, b.station))),
      recipeDrafts,
      publishedRecipes: this.publishedRecipes.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.version - a.version),
      products,
      audit: this.audit.slice(-30).reverse(),
    });
  }

  upsertIngredient({ ingredientId, name, baseUnit, costPerUnitRupiah, lotTrackingPolicy, minimumShelfLifeDays, sourcingMode, materialType, purchasable, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedName = cleanName(name);
    if (!BASE_UNITS.has(baseUnit)) throw domainError("ingredient_unit_invalid", 422);
    if (costPerUnitRupiah !== null && (!validUnitCost(costPerUnitRupiah) || costPerUnitRupiah > 10_000_000)) throw domainError("ingredient_cost_invalid", 422);
    const existing = ingredientId ? this.ingredients.get(ingredientId) : null;
    if (ingredientId && !existing) throw domainError("ingredient_not_found", 404);
    const normalizedSourcingMode = String(sourcingMode ?? ingredientSourcingMode(existing)).toUpperCase();
    const normalizedMaterialType = String(materialType ?? ingredientMaterialType(existing)).toUpperCase();
    if (!INGREDIENT_SOURCING_MODES.has(normalizedSourcingMode)) throw domainError("ingredient_sourcing_mode_invalid", 422);
    if (!INGREDIENT_MATERIAL_TYPES.has(normalizedMaterialType)) throw domainError("ingredient_material_type_invalid", 422);
    if (normalizedMaterialType === "PREP_ITEM" && normalizedSourcingMode !== "MADE_IN_HOUSE") throw domainError("prep_item_sourcing_mode_invalid", 422);
    const normalizedPurchasable = purchasable ?? existing?.purchasable ?? normalizedSourcingMode === "PURCHASED";
    if (typeof normalizedPurchasable !== "boolean" || (normalizedSourcingMode === "MADE_IN_HOUSE" && normalizedPurchasable)) throw domainError("ingredient_purchasable_invalid", 422);
    const normalizedLotTrackingPolicy = lotTrackingPolicy ?? existing?.lotTrackingPolicy ?? "NOT_REQUIRED";
    const normalizedMinimumShelfLifeDays = minimumShelfLifeDays ?? existing?.minimumShelfLifeDays ?? 0;
    if (!LOT_TRACKING_POLICIES.has(normalizedLotTrackingPolicy) || !Number.isSafeInteger(normalizedMinimumShelfLifeDays) || normalizedMinimumShelfLifeDays < 0 || normalizedMinimumShelfLifeDays > 3650) throw domainError("ingredient_lot_policy_invalid", 422);
    const managedBalance = existing ? this.inventoryBalances.get(existing.id) : null;
    if (existing && this.#ingredientHasProductionRecipeDependency(existing.id)
      && (existing.name !== normalizedName || existing.baseUnit !== baseUnit
        || ingredientSourcingMode(existing) !== normalizedSourcingMode
        || ingredientMaterialType(existing) !== normalizedMaterialType)) {
      throw domainError("ingredient_recipe_identity_locked", 409);
    }
    if (managedBalance && existing.baseUnit !== baseUnit) throw domainError("ingredient_unit_locked_after_receipt", 409);
    if (managedBalance && costPerUnitRupiah !== managedBalance.averageCostPerBaseUnitRupiah) throw domainError("ingredient_cost_purchase_managed", 409);
    if ([...this.ingredients.values()].some((item) => item.id !== ingredientId && item.name.toLocaleLowerCase("id") === normalizedName.toLocaleLowerCase("id"))) throw domainError("ingredient_name_conflict", 409);
    const before = this.exportState();
    if (sourcingMode !== undefined || materialType !== undefined || purchasable !== undefined) this.#enableMasterDataState();
    const now = this.clock().toISOString();
    const next = { id: existing?.id ?? randomUUID(), name: normalizedName, baseUnit, costPerUnitRupiah, lotTrackingPolicy: normalizedLotTrackingPolicy, minimumShelfLifeDays: normalizedMinimumShelfLifeDays, ...(this.masterDataStateEnabled ? { sourcingMode: normalizedSourcingMode, materialType: normalizedMaterialType } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (this.masterDataStateEnabled) Object.assign(next, migrateIngredientV22(next), {
      code: existing?.code ?? `LEGACY-${next.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24).toUpperCase()}`,
      category: existing?.category ?? "UMUM", purchasable: normalizedPurchasable,
      status: existing?.status ?? "ACTIVE", revision: existing?.revision ?? this.version,
    });
    this.ingredients.set(next.id, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    const event = this.#record("hpp.ingredient.upserted", actorId, reason, { ingredientId: next.id, previous: existing ?? null, next });
    if (this.masterDataStateEnabled) { next.revision = event.version; this.ingredients.set(next.id, next); }
    return { ...event, next: { ...next, costStatus: next.costPerUnitRupiah == null ? "UNPRICED" : "PRICED" } };
  }

  upsertIngredientMaster({ ingredientId, code, name, category, categoryId, baseUnit, purchasable, sourcingMode, materialType, costPerUnitRupiah = null, lotTrackingPolicy, minimumShelfLifeDays, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const existing = ingredientId ? this.ingredients.get(ingredientId) : null;
    if (ingredientId && !existing) throw domainError("ingredient_not_found", 404);
    const selectedCategory = categoryId == null ? null : this.#materialCategory(categoryId, { activeRequired: true });
    const normalizedCode = code == null || code === ""
      ? existing?.code ?? this.#nextIngredientCode(selectedCategory)
      : cleanIngredientCode(code);
    const normalizedName = cleanName(name);
    const normalizedCategory = selectedCategory?.name ?? cleanIngredientCategory(category ?? existing?.category);
    if (!BASE_UNITS.has(baseUnit)) throw domainError("ingredient_unit_invalid", 422);
    const normalizedSourcingMode = String(sourcingMode ?? ingredientSourcingMode(existing)).toUpperCase();
    const normalizedMaterialType = String(materialType ?? ingredientMaterialType(existing)).toUpperCase();
    if (!INGREDIENT_SOURCING_MODES.has(normalizedSourcingMode)) throw domainError("ingredient_sourcing_mode_invalid", 422);
    if (!INGREDIENT_MATERIAL_TYPES.has(normalizedMaterialType)) throw domainError("ingredient_material_type_invalid", 422);
    if (normalizedMaterialType === "PREP_ITEM" && normalizedSourcingMode !== "MADE_IN_HOUSE") throw domainError("prep_item_sourcing_mode_invalid", 422);
    const normalizedPurchasable = purchasable ?? existing?.purchasable ?? normalizedSourcingMode === "PURCHASED";
    if (typeof normalizedPurchasable !== "boolean" || (normalizedSourcingMode === "MADE_IN_HOUSE" && normalizedPurchasable)) throw domainError("ingredient_purchasable_invalid", 422);
    if (costPerUnitRupiah !== null && (!validUnitCost(costPerUnitRupiah) || costPerUnitRupiah > 10_000_000)) throw domainError("ingredient_cost_invalid", 422);
    const normalizedLotTrackingPolicy = lotTrackingPolicy ?? existing?.lotTrackingPolicy ?? "NOT_REQUIRED";
    const normalizedMinimumShelfLifeDays = minimumShelfLifeDays ?? existing?.minimumShelfLifeDays ?? 0;
    if (!LOT_TRACKING_POLICIES.has(normalizedLotTrackingPolicy) || !Number.isSafeInteger(normalizedMinimumShelfLifeDays) || normalizedMinimumShelfLifeDays < 0 || normalizedMinimumShelfLifeDays > 3650) throw domainError("ingredient_lot_policy_invalid", 422);
    if ([...this.ingredients.values()].some((item) => item.id !== ingredientId && item.code === normalizedCode)) throw domainError("ingredient_code_conflict", 409);
    if ([...this.ingredients.values()].some((item) => item.id !== ingredientId && item.name.toLocaleLowerCase("id") === normalizedName.toLocaleLowerCase("id"))) throw domainError("ingredient_name_conflict", 409);
    if (existing && this.#ingredientHasProductionRecipeDependency(existing.id)
      && (existing.name !== normalizedName || existing.baseUnit !== baseUnit
        || ingredientSourcingMode(existing) !== normalizedSourcingMode
        || ingredientMaterialType(existing) !== normalizedMaterialType)) {
      throw domainError("ingredient_recipe_identity_locked", 409);
    }
    if (existing && existing.baseUnit !== baseUnit && this.#ingredientHasOperationalDependency(existing.id)) throw domainError("ingredient_unit_locked_after_movement", 409);
    const managedBalance = existing ? this.inventoryBalances.get(existing.id) : null;
    if (managedBalance && costPerUnitRupiah !== managedBalance.averageCostPerBaseUnitRupiah) throw domainError("ingredient_cost_purchase_managed", 409);
    const before = this.exportState();
    this.#enableMasterDataState();
    const now = this.clock().toISOString();
    const next = {
      id: existing?.id ?? randomUUID(), code: normalizedCode, name: normalizedName, category: normalizedCategory,
      categoryId: selectedCategory?.id ?? existing?.categoryId ?? null,
      categorySnapshot: selectedCategory ? materialCategorySnapshot(selectedCategory) : existing?.categorySnapshot ?? null,
      referencePurchaseOptionId: existing?.referencePurchaseOptionId && costPerUnitRupiah === existing.costPerUnitRupiah ? existing.referencePurchaseOptionId : null,
      baseUnit, purchasable: normalizedPurchasable, sourcingMode: normalizedSourcingMode, materialType: normalizedMaterialType, status: existing?.status ?? "ACTIVE", costPerUnitRupiah,
      lotTrackingPolicy: normalizedLotTrackingPolicy, minimumShelfLifeDays: normalizedMinimumShelfLifeDays,
      createdAt: existing?.createdAt ?? now, updatedAt: now, revision: existing?.revision ?? this.version,
    };
    this.ingredients.set(next.id, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    const event = this.#record("ingredient.upserted", actorId, reason, { ingredientId: next.id, previous: existing ?? null, next });
    next.revision = event.version;
    this.ingredients.set(next.id, next);
    return { ...event, next: { ...next, costStatus: next.costPerUnitRupiah == null ? "UNPRICED" : "PRICED" } };
  }

  upsertIngredientProductionRecipe({ operationKey, outputIngredientId, outputQuantity, outputQuantityBase, outputUom, components, yieldToleranceBps = 0, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(operationKey);
    const output = this.ingredients.get(outputIngredientId);
    if (!output || output.status === "ARCHIVED") throw domainError("production_output_ingredient_not_found", 404);
    if (ingredientSourcingMode(output) !== "MADE_IN_HOUSE" || ingredientMaterialType(output) !== "PREP_ITEM") throw domainError("production_output_ingredient_invalid", 422);
    const normalizedOutput = this.normalizeIngredientQuantity({ ingredientId: output.id, quantity: outputQuantity ?? outputQuantityBase, uom: outputUom ?? output.baseUnit, occurredAt: this.clock().toISOString() });
    if (!Array.isArray(components) || components.length < 1 || components.length > 50) throw domainError("production_recipe_components_invalid", 422);
    const seen = new Set();
    const normalizedComponents = components.map((component) => {
      const ingredient = this.ingredients.get(component?.ingredientId);
      if (!ingredient || ingredient.status === "ARCHIVED") throw domainError("production_recipe_component_not_found", 404);
      if (ingredient.id === output.id) throw domainError("production_recipe_cycle_invalid", 422);
      if (seen.has(ingredient.id)) throw domainError("production_recipe_component_duplicate", 422);
      seen.add(ingredient.id);
      const normalized = this.normalizeIngredientQuantity({ ingredientId: ingredient.id, quantity: component.quantity ?? component.quantityBase, uom: component.uom ?? ingredient.baseUnit, occurredAt: this.clock().toISOString() });
      return { ingredientId: ingredient.id, ingredientName: ingredient.name, quantity: normalized.originalQuantity, quantityBase: normalized.normalizedQuantity, uom: normalized.originalUom, normalizedQuantity: normalized.normalizedQuantity, normalizedUom: normalized.normalizedUom, conversionSnapshot: normalized.conversionSnapshot };
    });
    const tolerance = Number(yieldToleranceBps);
    if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 2_500) throw domainError("production_yield_tolerance_invalid", 422);
    const existingEvents = this.audit.filter((event) => event.type === "ingredient.production_recipe.upserted" && event.productionRecipe);
    const replay = existingEvents.find((event) => event.productionRecipe.operationKey === key);
    const fingerprint = productionRecipeFingerprint({ outputIngredientId: output.id, outputQuantity: normalizedOutput.normalizedQuantity, outputUom: normalizedOutput.normalizedUom, components: normalizedComponents, yieldToleranceBps: tolerance });
    if (replay) {
      if (replay.productionRecipe.fingerprint !== fingerprint) throw domainError("production_recipe_idempotency_conflict", 409);
      return { recipe: structuredClone(replay.productionRecipe), idempotentReplay: true, version: this.version };
    }
    this.#assertMutation(expectedVersion, reason);
    const previous = restoreIngredientProductionRecipes(this.audit, this.ingredients).find((item) => item.outputIngredientId === output.id);
    const now = this.clock().toISOString();
    const productionRecipe = {
      id: previous?.id ?? `prep-recipe:${output.id}`, operationKey: key, fingerprint,
      version: (previous?.version ?? 0) + 1, outputIngredientId: output.id, outputIngredientName: output.name,
      outputQuantity: normalizedOutput.normalizedQuantity, outputQuantityBase: normalizedOutput.normalizedQuantity, outputUom: normalizedOutput.normalizedUom,
      components: normalizedComponents, yieldToleranceBps: tolerance,
      createdAt: previous?.createdAt ?? now, updatedAt: now, actorId: String(actorId ?? "owner"), reason: reason.trim(),
    };
    assertProductionRecipeGraphAcyclic(restoreIngredientProductionRecipes(this.audit, this.ingredients), productionRecipe);
    const event = this.#record("ingredient.production_recipe.upserted", actorId, reason, { productionRecipe });
    return { ...event, recipe: structuredClone(productionRecipe), idempotentReplay: false };
  }

  createMaterialCategory({ name, prefix, suggestedBaseUnit = "pcs", storageType = "AMBIENT", expiryTracking = false, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedName = cleanIngredientCategory(name);
    const normalizedPrefix = prefix == null || prefix === "" ? this.#suggestCategoryPrefix(normalizedName) : cleanCategoryPrefix(prefix);
    validateCategoryPreferences({ suggestedBaseUnit, storageType, expiryTracking });
    if (this.materialCategories.some((item) => item.name.toLocaleLowerCase("id") === normalizedName.toLocaleLowerCase("id"))) throw domainError("material_category_name_conflict", 409);
    if (this.materialCategories.some((item) => item.prefix === normalizedPrefix)) throw domainError("material_category_prefix_conflict", 409);
    this.#enableMasterDataState();
    this.materialCategoryStateEnabled = true;
    const now = this.clock().toISOString();
    const id = `custom-${randomUUID()}`;
    const next = { id, name: normalizedName, prefix: normalizedPrefix, suggestedBaseUnit, storageType, expiryTracking, status: "ACTIVE", isDefault: false, sortOrder: this.materialCategories.length + 1, createdAt: now, updatedAt: now, revision: this.version + 1 };
    const event = this.#record("material.category.created", actorId, reason, { categoryId: id, next });
    next.revision = event.version;
    this.materialCategories.push(next);
    return { ...event, next: structuredClone(next) };
  }

  updateMaterialCategory({ categoryId, name, suggestedBaseUnit, storageType, expiryTracking, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const existing = this.#materialCategory(categoryId);
    const normalizedName = name == null ? existing.name : cleanIngredientCategory(name);
    const preferences = {
      suggestedBaseUnit: suggestedBaseUnit ?? existing.suggestedBaseUnit,
      storageType: storageType ?? existing.storageType,
      expiryTracking: expiryTracking ?? existing.expiryTracking,
    };
    validateCategoryPreferences(preferences);
    if (this.materialCategories.some((item) => item.id !== existing.id && item.name.toLocaleLowerCase("id") === normalizedName.toLocaleLowerCase("id"))) throw domainError("material_category_name_conflict", 409);
    this.#enableMasterDataState();
    this.materialCategoryStateEnabled = true;
    const next = { ...existing, ...preferences, name: normalizedName, updatedAt: this.clock().toISOString(), revision: this.version + 1 };
    const event = this.#record("material.category.updated", actorId, reason, { categoryId: existing.id, previous: existing, next });
    next.revision = event.version;
    this.materialCategories[this.materialCategories.indexOf(existing)] = next;
    for (const [ingredientId, ingredient] of this.ingredients) {
      if (ingredient.categoryId !== existing.id) continue;
      this.ingredients.set(ingredientId, { ...ingredient, category: next.name, categorySnapshot: materialCategorySnapshot(next), updatedAt: event.occurredAt, revision: event.version });
    }
    return { ...event, next: structuredClone(next) };
  }

  archiveMaterialCategory({ categoryId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const existing = this.#materialCategory(categoryId);
    if (existing.status === "ARCHIVED") return { version: this.version, next: structuredClone(existing), idempotentReplay: true };
    if ([...this.ingredients.values()].some((item) => item.categoryId === existing.id && item.status !== "ARCHIVED")) throw domainError("material_category_in_use", 409);
    this.#enableMasterDataState();
    this.materialCategoryStateEnabled = true;
    const next = { ...existing, status: "ARCHIVED", updatedAt: this.clock().toISOString(), revision: this.version + 1 };
    const event = this.#record("material.category.archived", actorId, reason, { categoryId: existing.id, previousStatus: existing.status, next });
    next.revision = event.version;
    this.materialCategories[this.materialCategories.indexOf(existing)] = next;
    for (const [ingredientId, ingredient] of this.ingredients) {
      if (ingredient.categoryId !== existing.id) continue;
      this.ingredients.set(ingredientId, { ...ingredient, category: next.name, categorySnapshot: materialCategorySnapshot(next), updatedAt: event.occurredAt, revision: event.version });
    }
    return { ...event, next: structuredClone(next) };
  }

  searchMaterialCategories({ query = "", includeArchived = false } = {}) {
    const normalized = String(query ?? "").trim().toLocaleLowerCase("id");
    if (normalized.length > 60) throw domainError("material_category_search_invalid", 422);
    return this.materialCategories.filter((item) => (includeArchived || item.status === "ACTIVE") && (!normalized || `${item.name} ${item.prefix}`.toLocaleLowerCase("id").includes(normalized))).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "id")).map((item) => structuredClone(item));
  }

  archiveIngredient({ ingredientId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const existing = this.ingredients.get(ingredientId);
    if (!existing) throw domainError("ingredient_not_found", 404);
    if (existing.status === "ARCHIVED") return { version: this.version, next: structuredClone(existing), idempotentReplay: true };
    const dependencies = this.#ingredientDependencies(ingredientId);
    if (dependencies.length) {
      const error = domainError("ingredient_dependency_active", 409);
      error.details = { dependencies };
      throw error;
    }
    this.#enableMasterDataState();
    const current = this.ingredients.get(ingredientId);
    const now = this.clock().toISOString();
    const next = { ...current, status: "ARCHIVED", updatedAt: now };
    const event = this.#record("ingredient.archived", actorId, reason, { ingredientId, previousStatus: current.status, dependencies: [] });
    next.revision = event.version;
    this.ingredients.set(ingredientId, next);
    return { ...event, next: structuredClone(next) };
  }

  upsertIngredientConversion({ ingredientId, fromUom, toUom, factor, effectiveAt, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const from = cleanUom(fromUom);
    const to = cleanUom(toUom);
    if (from === to) throw domainError("ingredient_conversion_same_uom", 422);
    const normalizedFactor = exactConversionFactor(factor);
    const normalizedEffectiveAt = effectiveAt ?? this.clock().toISOString();
    if (!validIsoTimestamp(normalizedEffectiveAt)) throw domainError("ingredient_conversion_effective_at_invalid", 422);
    this.#enableMasterDataState();
    const prior = this.ingredientConversions.filter((item) => item.ingredientId === ingredientId && item.fromUom === from && item.toUom === to);
    const event = this.#record("ingredient.conversion.upserted", actorId, reason, { ingredientId, fromUom: from, toUom: to, factor: normalizedFactor, effectiveAt: normalizedEffectiveAt, sequence: prior.length + 1 });
    const conversion = { id: randomUUID(), ingredientId, fromUom: from, toUom: to, factor: normalizedFactor, effectiveAt: normalizedEffectiveAt, sequence: prior.length + 1, revision: event.version, createdAt: event.occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim() };
    this.ingredientConversions.push(conversion);
    return { ...event, conversion: structuredClone(conversion) };
  }

  normalizeIngredientQuantity({ ingredientId, quantity, uom, occurredAt } = {}) {
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const originalQuantity = exactConversionQuantity(quantity);
    const originalUom = cleanUom(uom);
    const at = occurredAt ?? this.clock().toISOString();
    if (!validIsoTimestamp(at)) throw domainError("ingredient_conversion_effective_at_invalid", 422);
    if (originalUom === ingredient.baseUnit) return { ingredientId, originalQuantity, originalUom, normalizedQuantity: originalQuantity, normalizedUom: ingredient.baseUnit, occurredAt: at, conversionSnapshot: [] };
    const path = findConversionPath(this.#effectiveConversions(ingredientId, at), originalUom, ingredient.baseUnit);
    if (!path) throw domainError("ingredient_conversion_path_missing", 409);
    const normalizedQuantity = roundedConversion(path.reduce((value, edge) => value * edge.factor, originalQuantity));
    return { ingredientId, originalQuantity, originalUom, normalizedQuantity, normalizedUom: ingredient.baseUnit, occurredAt: at, conversionSnapshot: path.map((edge) => ({ conversionId: edge.id, fromUom: edge.fromUom, toUom: edge.toUom, factor: edge.factor, revision: edge.revision, effectiveAt: edge.effectiveAt, source: edge.source })) };
  }

  upsertIngredientSupplierPackage({ packageId, ingredientId, supplierName, packageLabel, purchaseUom, quantityPerPackage, barcode = null, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    if (!this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    const normalizedSupplierName = cleanPurchaseText(supplierName, "ingredient_supplier_name_invalid");
    const normalizedPackageLabel = cleanPurchaseText(packageLabel, "ingredient_package_label_invalid");
    const normalizedPurchaseUom = cleanUom(purchaseUom);
    const normalizedQuantity = exactConversionQuantity(quantityPerPackage);
    const normalizedBarcode = barcode == null || barcode === "" ? null : cleanBarcode(barcode);
    const id = packageId ?? randomUUID();
    const prior = this.ingredientSupplierPackages.filter((item) => item.packageId === id);
    if (prior.length && prior.at(-1).ingredientId !== ingredientId) throw domainError("ingredient_package_identity_conflict", 409);
    this.#enableMasterDataState();
    const event = this.#record("ingredient.supplier_package.upserted", actorId, reason, { packageId: id, ingredientId, supplierName: normalizedSupplierName, packageLabel: normalizedPackageLabel, purchaseUom: normalizedPurchaseUom, quantityPerPackage: normalizedQuantity, sequence: prior.length + 1 });
    const supplierPackage = { id: randomUUID(), packageId: id, ingredientId, supplierName: normalizedSupplierName, packageLabel: normalizedPackageLabel, purchaseUom: normalizedPurchaseUom, quantityPerPackage: normalizedQuantity, barcode: normalizedBarcode, sequence: prior.length + 1, revision: event.version, createdAt: event.occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim() };
    this.ingredientSupplierPackages.push(supplierPackage);
    return { ...event, supplierPackage: structuredClone(supplierPackage) };
  }

  upsertIngredientPurchaseOption({ purchaseOptionId, ingredientId, label, purchaseUnit, innerUnit = null, innerUnitsPerPurchaseUnit = null, baseUnitsPerInnerUnit = null, baseUnitsPerPurchaseUnit = null, referencePriceRupiah = null, supplierName = null, preferred = false, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const normalizedLabel = cleanPurchaseText(label, "ingredient_package_label_invalid");
    const normalizedPurchaseUnit = cleanUom(purchaseUnit);
    const normalizedSupplierName = supplierName == null || supplierName === "" ? null : cleanPurchaseText(supplierName, "ingredient_supplier_name_invalid");
    if (typeof preferred !== "boolean") throw domainError("ingredient_purchase_option_preferred_invalid", 422);
    if (referencePriceRupiah !== null && (!Number.isSafeInteger(referencePriceRupiah) || referencePriceRupiah <= 0 || referencePriceRupiah > 1_000_000_000)) throw domainError("ingredient_reference_price_invalid", 422);
    let normalizedInnerUnit = null;
    let normalizedInnerCount = null;
    let normalizedBasePerInner = null;
    let normalizedBasePerPurchase;
    if (innerUnit == null || innerUnit === "") {
      normalizedBasePerPurchase = exactConversionQuantity(baseUnitsPerPurchaseUnit);
    } else {
      normalizedInnerUnit = cleanUom(innerUnit);
      if (normalizedInnerUnit === normalizedPurchaseUnit || normalizedInnerUnit === ingredient.baseUnit || normalizedPurchaseUnit === ingredient.baseUnit) throw domainError("ingredient_purchase_option_levels_invalid", 422);
      normalizedInnerCount = exactConversionQuantity(innerUnitsPerPurchaseUnit);
      normalizedBasePerInner = exactConversionQuantity(baseUnitsPerInnerUnit);
      normalizedBasePerPurchase = exactConversionQuantity(roundedConversion(normalizedInnerCount * normalizedBasePerInner));
      if (baseUnitsPerPurchaseUnit != null && exactConversionQuantity(baseUnitsPerPurchaseUnit) !== normalizedBasePerPurchase) throw domainError("ingredient_purchase_option_conversion_conflict", 422);
    }
    if (normalizedPurchaseUnit === ingredient.baseUnit && normalizedBasePerPurchase !== 1) throw domainError("ingredient_purchase_option_levels_invalid", 422);
    const id = purchaseOptionId ?? randomUUID();
    const prior = this.ingredientSupplierPackages.filter((item) => item.packageId === id);
    if (prior.length && prior.at(-1).ingredientId !== ingredientId) throw domainError("ingredient_package_identity_conflict", 409);
    this.#enableMasterDataState();
    const event = this.#record("ingredient.purchase_option.upserted", actorId, reason, { purchaseOptionId: id, ingredientId, sequence: prior.length + 1 });
    if (preferred) {
      for (const current of this.#currentIngredientSupplierPackages().filter((item) => item.purchaseOptionId && item.ingredientId === ingredientId && item.packageId !== id && item.preferred)) {
        this.ingredientSupplierPackages.push({
          ...current,
          id: randomUUID(),
          preferred: false,
          sequence: current.sequence + 1,
          revision: event.version,
          createdAt: event.occurredAt,
          actorId: String(actorId ?? "owner"),
          reason: reason.trim(),
        });
      }
    }
    const unitCostPerBaseUnitRupiah = referencePriceRupiah == null ? null : roundedUnitCost(referencePriceRupiah / normalizedBasePerPurchase);
    const option = {
      id: randomUUID(), packageId: id, purchaseOptionId: id, ingredientId,
      supplierName: normalizedSupplierName ?? "Belum ditentukan", packageLabel: normalizedLabel, label: normalizedLabel,
      purchaseUom: normalizedPurchaseUnit, purchaseUnit: normalizedPurchaseUnit, quantityPerPackage: normalizedBasePerPurchase,
      innerUnit: normalizedInnerUnit, innerUnitsPerPurchaseUnit: normalizedInnerCount, baseUnitsPerInnerUnit: normalizedBasePerInner,
      baseUnitsPerPurchaseUnit: normalizedBasePerPurchase, referencePriceRupiah,
      unitCostPerBaseUnitRupiah, costStatus: referencePriceRupiah == null ? "UNPRICED" : "PRICED",
      preferred, barcode: null, sequence: prior.length + 1, revision: event.version,
      createdAt: event.occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
    };
    this.ingredientSupplierPackages.push(option);
    if (preferred && !this.inventoryBalances.has(ingredientId)) {
      this.ingredients.set(ingredientId, {
        ...ingredient,
        costPerUnitRupiah: unitCostPerBaseUnitRupiah,
        referencePurchaseOptionId: referencePriceRupiah == null ? null : id,
        updatedAt: event.occurredAt,
        revision: event.version,
      });
    } else if (!preferred && !this.inventoryBalances.has(ingredientId) && ingredient.referencePurchaseOptionId === id) {
      this.ingredients.set(ingredientId, { ...ingredient, costPerUnitRupiah: null, referencePurchaseOptionId: null, updatedAt: event.occurredAt, revision: event.version });
    }
    return { ...event, purchaseOption: structuredClone(option), next: structuredClone(option) };
  }

  recordIngredientReferencePrice(input = {}) {
    return this.#appendIngredientReferencePrice("SET", input);
  }

  correctIngredientReferencePrice(input = {}) {
    return this.#appendIngredientReferencePrice("CORRECTION", input);
  }

  voidIngredientReferencePrice(input = {}) {
    return this.#appendIngredientReferencePrice("VOID", input);
  }

  ingredientReferencePriceHistory({ ingredientId, cursor = null, limit = 50 } = {}) {
    if (!this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    const pageSize = Number(limit);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw domainError("ingredient_price_history_limit_invalid", 422);
    const beforeSequence = cursor == null || cursor === "" ? Number.POSITIVE_INFINITY : Number(cursor);
    if (!(Number.isSafeInteger(beforeSequence) && beforeSequence > 0) && beforeSequence !== Number.POSITIVE_INFINITY) throw domainError("ingredient_price_history_cursor_invalid", 422);
    const all = this.ingredientReferencePriceVersions.filter((item) => item.ingredientId === ingredientId).sort((a, b) => b.sequence - a.sequence);
    const items = all.filter((item) => item.sequence < beforeSequence).slice(0, pageSize);
    const nextCursor = items.length === pageSize && all.some((item) => item.sequence < items.at(-1).sequence) ? String(items.at(-1).sequence) : null;
    return structuredClone({ items, page: { limit: pageSize, nextCursor, total: all.length }, completeHistory: nextCursor === null });
  }

  simulateIngredientReferencePriceImpact({ ingredientId, purchaseOptionId, referencePriceRupiah, effectiveAt = null } = {}) {
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const option = this.#currentIngredientSupplierPackages().find((item) => item.purchaseOptionId === purchaseOptionId && item.ingredientId === ingredientId);
    if (!option) throw domainError("ingredient_purchase_option_not_found", 404);
    if (!Number.isSafeInteger(referencePriceRupiah) || referencePriceRupiah <= 0 || referencePriceRupiah > 1_000_000_000) throw domainError("ingredient_reference_price_invalid", 422);
    const at = effectiveAt ?? this.clock().toISOString();
    if (!validIsoTimestamp(at)) throw domainError("ingredient_reference_price_effective_at_invalid", 422);
    const candidateUnitCost = roundedUnitCost(referencePriceRupiah / option.baseUnitsPerPurchaseUnit);
    const productionRecipes = restoreIngredientProductionRecipes(this.audit, this.ingredients);
    const currentProjection = projectProductionRecipeCosts(this.#costIngredients(at), productionRecipes);
    const scenarioProjection = projectProductionRecipeCosts(
      this.#costIngredients(at).map((item) => item.id === ingredientId ? { ...item, costPerUnitRupiah: candidateUnitCost } : item),
      productionRecipes,
    );
    const currentIngredients = currentProjection.ingredients;
    const scenarioIngredients = scenarioProjection.ingredients;
    const currentIngredient = currentIngredients.find((item) => item.id === ingredientId);
    const hasMovingAverage = this.inventoryBalances.has(ingredientId);
    const affectedIngredientIds = new Set([ingredientId]);
    for (const impact of scenarioProjection.prepImpacts) {
      const current = currentProjection.prepImpacts.find((item) => item.ingredientId === impact.ingredientId);
      if ((current?.projectedUnitCostRupiah ?? null) !== impact.projectedUnitCostRupiah) affectedIngredientIds.add(impact.ingredientId);
    }
    const menuImpacts = [];
    for (const product of this.#products()) {
      const draft = this.recipeDrafts.get(product.id);
      const recipe = draft ?? this.recipes.get(product.id);
      if (!recipe?.items?.some((line) => affectedIngredientIds.has(line.ingredientId))) continue;
      const current = calculateRecipeCost({ product, recipe, recipeItems: recipe.items, ingredients: currentIngredients });
      const reference = calculateRecipeCost({ product, recipe, recipeItems: recipe.items, ingredients: scenarioIngredients });
      menuImpacts.push({
        productId: product.id, menuName: product.name, menuStatus: product.status === "active" ? "ACTIVE" : "INACTIVE",
        recipeState: draft ? "DRAFT" : "PUBLISHED_CURRENT", sellingPriceRupiah: product.priceRupiah,
        status: current.complete && reference.complete ? "COMPLETE" : "PARTIAL",
        currentBook: recipeCostScenario(current),
        afterEffective: recipeCostScenario(current),
        referenceScenario: recipeCostScenario(reference),
        missingIngredientIds: [...new Set([...current.missingIngredientIds, ...reference.missingIngredientIds])],
        missingCostIngredientIds: [...new Set([...current.missingCostIngredientIds, ...reference.missingCostIngredientIds])],
      });
    }
    return structuredClone({
      ingredient: { id: ingredient.id, name: ingredient.name, baseUom: ingredient.baseUnit, bookCostSource: hasMovingAverage ? "PURCHASE_MOVING_AVERAGE" : currentIngredient?.referencePurchaseOptionId ? "REFERENCE_PURCHASE_OPTION" : currentIngredient?.costPerUnitRupiah == null ? "UNPRICED" : "MANUAL", currentBookUnitCostRupiah: currentIngredient?.costPerUnitRupiah ?? null },
      candidate: { purchaseOptionId, supplierName: option.supplierName === "Belum ditentukan" ? null : option.supplierName, referencePriceRupiah, unitCostPerBaseUnitRupiah: candidateUnitCost, effectiveAt: at, packageSnapshot: purchaseOptionPriceSnapshot(option) },
      summary: { affectedMenuCount: menuImpacts.length, affectedPrepCount: affectedIngredientIds.size - 1, activeMenuCount: menuImpacts.filter((item) => item.menuStatus === "ACTIVE").length, inactiveMenuCount: menuImpacts.filter((item) => item.menuStatus === "INACTIVE").length, partialMenuCount: menuImpacts.filter((item) => item.status === "PARTIAL").length, changesBookCost: false },
      prepImpacts: scenarioProjection.prepImpacts.filter((item) => affectedIngredientIds.has(item.ingredientId)).map((item) => {
        const current = currentProjection.prepImpacts.find((candidate) => candidate.ingredientId === item.ingredientId);
        const before = current?.projectedUnitCostRupiah ?? null;
        const after = item.projectedUnitCostRupiah;
        return { ...item, currentProjectedUnitCostRupiah: before, unitCostDeltaRupiah: before == null || after == null ? null : roundedUnitCost(after - before), unitCostDeltaPct: before > 0 && after != null ? Math.round(((after - before) / before) * 10000) / 100 : null };
      }),
      menuImpacts,
    });
  }

  createIngredientFromWizard(input = {}) {
    const { category: categoryInput = null, categoryId = null, ingredient: nestedIngredient = null, purchaseOption = null, expectedVersion, actorId, reason } = input;
    this.#assertMutation(expectedVersion, reason);
    const ingredient = nestedIngredient ?? {
      ingredientId: input.ingredientId,
      name: input.name,
      baseUnit: input.baseUnit,
      purchasable: input.purchasable ?? true,
      costPerUnitRupiah: input.costPerUnitRupiah ?? null,
      lotTrackingPolicy: input.lotTrackingPolicy,
      minimumShelfLifeDays: input.minimumShelfLifeDays,
    };
    if (!ingredient || typeof ingredient !== "object" || Array.isArray(ingredient)) throw domainError("inventory_action_payload_invalid", 422);
    const before = this.exportState();
    try {
      let category = null;
      if (categoryId) category = this.#materialCategory(categoryId, { activeRequired: true });
      else if (categoryInput?.categoryId) category = this.#materialCategory(categoryInput.categoryId, { activeRequired: true });
      else if (categoryInput) category = this.createMaterialCategory({ ...categoryInput, expectedVersion: this.version, actorId, reason }).next;
      else if (ingredient.categoryId) category = this.#materialCategory(ingredient.categoryId, { activeRequired: true });
      else throw domainError("material_category_required_for_auto_code", 422);
      const ingredientResult = this.upsertIngredientMaster({ ...ingredient, categoryId: category.id, expectedVersion: this.version, actorId, reason });
      const optionResult = purchaseOption
        ? this.upsertIngredientPurchaseOption({ ...purchaseOption, ingredientId: ingredientResult.next.id, expectedVersion: this.version, actorId, reason })
        : null;
      const currentIngredient = this.ingredients.get(ingredientResult.next.id);
      return {
        version: this.version,
        category: structuredClone(category),
        ingredient: structuredClone(currentIngredient),
        purchaseOption: optionResult?.purchaseOption ?? null,
        next: structuredClone(currentIngredient),
      };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  upsertSupplier({ supplierId, name, leadTimeDays, active = true, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedName = cleanPurchaseText(name, "supplier_name_invalid");
    if (!Number.isSafeInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 365) throw domainError("supplier_lead_time_invalid", 422);
    if (typeof active !== "boolean") throw domainError("supplier_status_invalid", 422);
    const existing = supplierId ? this.suppliers.find((item) => item.id === supplierId) : null;
    if (supplierId && !existing) throw domainError("supplier_not_found", 404);
    if (this.suppliers.some((item) => item.id !== supplierId && item.name.toLocaleLowerCase("id") === normalizedName.toLocaleLowerCase("id"))) throw domainError("supplier_name_conflict", 409);
    const now = this.clock().toISOString();
    const next = { id: existing?.id ?? randomUUID(), name: normalizedName, leadTimeDays, active, createdAt: existing?.createdAt ?? now, updatedAt: now };
    const event = this.#record("hpp.supplier.upserted", actorId, reason, { supplierId: next.id, previous: existing ?? null, next });
    next.version = event.version;
    if (existing) this.suppliers[this.suppliers.indexOf(existing)] = next;
    else this.suppliers.push(next);
    return { ...event, next: structuredClone(next) };
  }

  createPurchaseOrder({ idempotencyKey, supplierId, expectedDate, lines, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const fingerprint = purchaseOrderFingerprintFromCreateRequest(supplierId, expectedDate, lines);
    const replay = this.purchaseOrders.find((item) => item.idempotencyKey === key);
    if (replay) {
      if (replay.creationFingerprint !== fingerprint) throw domainError("purchase_order_idempotency_conflict", 409);
      return { purchaseOrder: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    if (this.purchaseOrders.some((item) => item.changes.some((change) => change.idempotencyKey === key))) throw domainError("purchase_order_idempotency_conflict", 409);
    const { supplier, normalizedLines, totalOrderedRupiah } = this.#purchaseOrderPlan({ supplierId, expectedDate, lines });
    this.#assertMutation(expectedVersion, reason);
    const now = this.clock().toISOString();
    const event = this.#record("hpp.purchase_order.created", actorId, reason, { supplierId: supplier.id, expectedDate, lineCount: normalizedLines.length });
    const purchaseOrder = {
      id: randomUUID(), idempotencyKey: key, creationFingerprint: fingerprint, fingerprint, status: "OPEN", supplierId: supplier.id, supplierNameSnapshot: supplier.name,
      expectedDate, lines: normalizedLines, lineCount: normalizedLines.length,
      totalOrderedRupiah,
      createdAt: now, updatedAt: now, actorId: String(actorId ?? "owner"), reason: reason.trim(), version: event.version, revision: 1, changes: [],
    };
    this.purchaseOrders.push(purchaseOrder);
    return { ...event, purchaseOrder: structuredClone(purchaseOrder), idempotentReplay: false };
  }

  amendPurchaseOrder({ idempotencyKey, purchaseOrderId, supplierId, expectedDate, lines, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const requestFingerprint = purchaseOrderAmendRequestFingerprint(purchaseOrderId, supplierId, expectedDate, lines);
    const replay = this.#purchaseOrderActionReplay(key, "AMENDED", requestFingerprint);
    if (replay) return replay;
    const order = this.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (!order) throw domainError("purchase_order_not_found", 404);
    if (order.status === "CANCELLED") throw domainError("purchase_order_cancelled", 409);
    if (order.status !== "OPEN" || order.lines.some((line) => line.deliveredPurchaseQuantity > 0)) throw domainError("purchase_order_edit_locked_after_receipt", 409);
    const { supplier, normalizedLines, totalOrderedRupiah } = this.#purchaseOrderPlan({ supplierId, expectedDate, lines });
    this.#assertMutation(expectedVersion, reason);
    const beforeFingerprint = order.fingerprint;
    const nextFingerprint = purchaseOrderFingerprint(supplier.id, expectedDate, normalizedLines);
    const occurredAt = this.clock().toISOString();
    const event = this.#record("hpp.purchase_order.amended", actorId, reason, { purchaseOrderId: order.id, beforeFingerprint, nextFingerprint });
    order.supplierId = supplier.id;
    order.supplierNameSnapshot = supplier.name;
    order.expectedDate = expectedDate;
    order.lines = normalizedLines;
    order.lineCount = normalizedLines.length;
    order.totalOrderedRupiah = totalOrderedRupiah;
    order.fingerprint = nextFingerprint;
    order.updatedAt = occurredAt;
    order.revision += 1;
    order.changes.push({ id: randomUUID(), idempotencyKey: key, action: "AMENDED", requestFingerprint, beforeFingerprint, nextFingerprint, occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(), version: event.version });
    return { ...event, purchaseOrder: structuredClone(order), idempotentReplay: false };
  }

  cancelPurchaseOrder({ idempotencyKey, purchaseOrderId, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const requestFingerprint = purchaseOrderCancelRequestFingerprint(purchaseOrderId, reason);
    const replay = this.#purchaseOrderActionReplay(key, "CANCELLED", requestFingerprint);
    if (replay) return replay;
    const order = this.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (!order) throw domainError("purchase_order_not_found", 404);
    if (order.status === "CANCELLED") throw domainError("purchase_order_cancelled", 409);
    if (order.status === "RECEIVED") throw domainError("purchase_order_cancel_completed", 409);
    this.#assertMutation(expectedVersion, reason);
    const occurredAt = this.clock().toISOString();
    const event = this.#record("hpp.purchase_order.cancelled", actorId, reason, { purchaseOrderId: order.id, receivedLineCount: order.lines.filter((line) => line.deliveredPurchaseQuantity > 0).length });
    order.status = "CANCELLED";
    order.cancelledAt = occurredAt;
    order.cancelledBy = String(actorId ?? "owner");
    order.cancelReason = reason.trim();
    order.updatedAt = occurredAt;
    order.revision += 1;
    order.changes.push({ id: randomUUID(), idempotencyKey: key, action: "CANCELLED", requestFingerprint, beforeFingerprint: order.fingerprint, nextFingerprint: order.fingerprint, occurredAt, actorId: order.cancelledBy, reason: order.cancelReason, version: event.version });
    return { ...event, purchaseOrder: structuredClone(order), idempotentReplay: false };
  }

  postPurchaseReceipt(input = {}) {
    const destinationLocationId = cleanPurchaseText(input.destinationLocationId, "purchase_destination_location_required");
    const request = { ...input, destinationLocationId, strictPhysicalDisposition: true, strictReceivingLocations: true };
    return input.purchaseOrderId === undefined ? this.receivePurchase(request) : this.receivePurchaseOrder(request);
  }

  receivePurchaseOrder({ idempotencyKey, purchaseOrderId, businessDate, destinationLocationId = "PRIMARY_USABLE_STOCK", quarantineLocationId, rejectionLocationId, pendingInspectionLocationId, lines, additionalFees = [], expectedVersion, actorId, reason, strictPhysicalDisposition = false, strictReceivingLocations = false } = {}) {
    const order = this.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (!order) throw domainError("purchase_order_not_found", 404);
    const existingReceipt = this.purchaseReceipts.find((item) => item.idempotencyKey === idempotencyKey);
    if (!existingReceipt && order.status === "RECEIVED" && !lines?.some((line) => ["PAID", "BONUS", "ERROR"].includes(line?.overReceiptClassification))) throw domainError("purchase_order_already_received", 409);
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("purchase_order_receipt_lines_invalid", 422);
    const seen = new Set();
    const expandedLines = lines.map((line) => {
      if (!line || typeof line.ingredientId !== "string") throw domainError("purchase_order_line_not_found", 404);
      if (seen.has(line.ingredientId)) throw domainError("purchase_order_receipt_ingredient_duplicate", 422);
      seen.add(line.ingredientId);
      const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
      if (!orderedLine) throw domainError("purchase_order_line_not_found", 404);
      const disposition = normalizeReceiptDisposition(line, strictPhysicalDisposition);
      const purchaseQuantity = disposition.acceptedPurchaseQuantity;
      const { deliveredPurchaseQuantity, rejectedPurchaseQuantity, quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity } = disposition;
      const rejectionReason = normalizePurchaseRejectionReason(rejectedPurchaseQuantity, line.rejectionReason);
      const replayLine = existingReceipt?.deliveredLines.find((item) => item.ingredientId === line.ingredientId);
      const remainingBefore = replayLine?.orderedRemainingBefore ?? roundedQuantity(Math.max(0, orderedLine.orderedPurchaseQuantity - orderedLine.deliveredPurchaseQuantity));
      const overPurchaseQuantity = roundedQuantity(Math.max(0, deliveredPurchaseQuantity - remainingBefore));
      if (overPurchaseQuantity > 0 && !["PAID", "BONUS", "ERROR"].includes(line.overReceiptClassification)) throw domainError("purchase_order_quantity_exceeds_remaining", 409);
      if (overPurchaseQuantity > purchaseQuantity) throw domainError("purchase_order_over_receipt_disposition_invalid", 422);
      const overReceiptClassification = normalizeOverReceiptClassification(overPurchaseQuantity, line.overReceiptClassification);
      const bonusPurchaseQuantity = overReceiptClassification === "BONUS" ? overPurchaseQuantity : 0;
      const paidPurchaseQuantity = roundedQuantity(purchaseQuantity - bonusPurchaseQuantity);
      const totalCostRupiah = Math.round(paidPurchaseQuantity * orderedLine.unitCostRupiah);
      if (!Number.isSafeInteger(totalCostRupiah) || totalCostRupiah < 0 || totalCostRupiah > 1_000_000_000) throw domainError("purchase_cost_invalid", 422);
      return {
        ingredientId: orderedLine.ingredientId,
        purchaseUnitLabel: orderedLine.purchaseUnitLabel,
        purchaseQuantity,
        deliveredPurchaseQuantity,
        rejectedPurchaseQuantity,
        quarantinedPurchaseQuantity,
        pendingInspectionPurchaseQuantity,
        rejectionReason,
        baseUnitsPerPurchaseUnit: orderedLine.baseUnitsPerPurchaseUnit,
        lots: line.lots,
        orderedRemainingBefore: remainingBefore,
        overPurchaseQuantity,
        underPurchaseQuantity: roundedQuantity(Math.max(0, remainingBefore - deliveredPurchaseQuantity)),
        overReceiptClassification,
        quantityStatus: overPurchaseQuantity > 0 ? `OVER_${overReceiptClassification}` : deliveredPurchaseQuantity < remainingBefore ? "UNDER" : "EXACT",
        paidPurchaseQuantity,
        bonusPurchaseQuantity,
        inspectionUnitCostRupiah: orderedLine.unitCostRupiah,
        totalCostRupiah,
      };
    });
    return this.receivePurchase({
      idempotencyKey, purchaseOrderId: order.id, businessDate, supplierName: order.supplierNameSnapshot,
      destinationLocationId, quarantineLocationId, rejectionLocationId, pendingInspectionLocationId,
      lines: expandedLines, additionalFees, expectedVersion, actorId, reason, strictPhysicalDisposition: false, strictReceivingLocations,
    });
  }

  receivePurchase({ idempotencyKey, purchaseOrderId, businessDate, supplierName, destinationLocationId = "PRIMARY_USABLE_STOCK", quarantineLocationId, rejectionLocationId, pendingInspectionLocationId, lines, additionalFees = [], expectedVersion, actorId, reason, strictPhysicalDisposition = false, strictReceivingLocations = false } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const replayReceipt = this.purchaseReceipts.find((item) => item.idempotencyKey === key);
    const receivedAt = replayReceipt?.receivedAt ?? this.clock().toISOString();
    const normalizedBusinessDate = businessDate == null ? (replayReceipt?.businessDate ?? receivedAt.slice(0, 10)) : businessDate;
    if (!validBusinessDate(normalizedBusinessDate)) throw domainError("purchase_business_date_invalid", 422);
    const normalizedDestinationLocationId = cleanPurchaseText(destinationLocationId, "purchase_destination_location_required");
    const linkedOrder = purchaseOrderId === undefined ? null : this.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (purchaseOrderId !== undefined && !linkedOrder) throw domainError("purchase_order_not_found", 404);
    const supplier = linkedOrder ? linkedOrder.supplierNameSnapshot : cleanPurchaseText(supplierName, "purchase_supplier_invalid");
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("purchase_lines_invalid", 422);
    const seen = new Set();
    const normalizedLines = lines.map((line) => {
      if (!line || typeof line.ingredientId !== "string" || !this.ingredients.has(line.ingredientId)) throw domainError("ingredient_not_found", 404);
      if (seen.has(line.ingredientId)) throw domainError("purchase_ingredient_duplicate", 422);
      seen.add(line.ingredientId);
      const purchaseUnitLabel = cleanPurchaseText(line.purchaseUnitLabel, "purchase_unit_label_invalid");
      const disposition = normalizeReceiptDisposition(line, strictPhysicalDisposition);
      const purchaseQuantity = disposition.acceptedPurchaseQuantity;
      const { deliveredPurchaseQuantity, rejectedPurchaseQuantity, quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity } = disposition;
      if (!linkedOrder && rejectedPurchaseQuantity > 0) throw domainError("purchase_rejection_requires_purchase_order", 422);
      const rejectionReason = normalizePurchaseRejectionReason(rejectedPurchaseQuantity, line.rejectionReason);
      const baseUnitsPerPurchaseUnit = exactPositiveQuantity(line.baseUnitsPerPurchaseUnit, "purchase_conversion_invalid");
      const baseQuantity = roundedQuantity(purchaseQuantity * baseUnitsPerPurchaseUnit);
      if (!Number.isFinite(baseQuantity) || baseQuantity < 0 || baseQuantity > 1_000_000_000) throw domainError("purchase_conversion_invalid", 422);
      if (!Number.isSafeInteger(line.totalCostRupiah) || line.totalCostRupiah < 0 || line.totalCostRupiah > 1_000_000_000 || (purchaseQuantity === 0 && line.totalCostRupiah !== 0)) throw domainError("purchase_cost_invalid", 422);
      const ingredient = this.ingredients.get(line.ingredientId);
      const lots = normalizePurchaseLots(line.lots, disposition, ingredient, normalizedBusinessDate);
      if (!linkedOrder && (line.paidPurchaseQuantity !== undefined || line.bonusPurchaseQuantity !== undefined || line.overReceiptClassification !== undefined)) throw domainError("purchase_over_receipt_requires_purchase_order", 422);
      const paidPurchaseQuantity = exactNonnegativeQuantity(linkedOrder ? line.paidPurchaseQuantity ?? purchaseQuantity : purchaseQuantity, "purchase_paid_quantity_invalid");
      const bonusPurchaseQuantity = exactNonnegativeQuantity(linkedOrder ? line.bonusPurchaseQuantity ?? 0 : 0, "purchase_bonus_quantity_invalid");
      if (roundedQuantity(paidPurchaseQuantity + bonusPurchaseQuantity) !== purchaseQuantity) throw domainError("purchase_paid_bonus_quantity_mismatch", 422);
      const quantityStatus = line.quantityStatus ?? (linkedOrder ? "EXACT" : "UNPLANNED");
      const inspectionUnitCostRupiah = line.inspectionUnitCostRupiah ?? (purchaseQuantity > 0 ? roundedUnitCost(line.totalCostRupiah / purchaseQuantity) : null);
      if ((quarantinedPurchaseQuantity > 0 || pendingInspectionPurchaseQuantity > 0) && (!validUnitCost(inspectionUnitCostRupiah) || inspectionUnitCostRupiah <= 0)) throw domainError("purchase_inspection_cost_required", 422);
      if (ingredientSourcingMode(ingredient) !== "PURCHASED" || ingredient.purchasable === false) throw domainError("purchase_ingredient_not_purchasable", 409);
      return {
        ingredientId: line.ingredientId,
        purchaseUnitLabel,
        deliveredPurchaseQuantity,
        purchaseQuantity,
        rejectedPurchaseQuantity,
        quarantinedPurchaseQuantity,
        pendingInspectionPurchaseQuantity,
        rejectionReason,
        baseUnitsPerPurchaseUnit,
        baseQuantity,
        lots,
        quantityStatus,
        orderedRemainingBefore: line.orderedRemainingBefore ?? null,
        overPurchaseQuantity: line.overPurchaseQuantity ?? 0,
        underPurchaseQuantity: line.underPurchaseQuantity ?? 0,
        overReceiptClassification: line.overReceiptClassification ?? null,
        paidPurchaseQuantity,
        bonusPurchaseQuantity,
        inspectionUnitCostRupiah,
        itemCostRupiah: line.totalCostRupiah,
        ...(line.purchaseOptionSnapshot ? { purchaseOptionSnapshot: normalizePurchaseOptionSnapshot(line.purchaseOptionSnapshot, line.ingredientId, baseUnitsPerPurchaseUnit) } : {}),
      };
    }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
    const normalizedFees = normalizePurchaseFees(additionalFees);
    if (linkedOrder) {
      for (const line of normalizedLines) {
        const orderedLine = linkedOrder.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine) throw domainError("purchase_order_line_not_found", 404);
        if (line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel || line.baseUnitsPerPurchaseUnit !== orderedLine.baseUnitsPerPurchaseUnit) throw domainError("purchase_order_line_mismatch", 409);
        if (line.itemCostRupiah !== Math.round(line.paidPurchaseQuantity * orderedLine.unitCostRupiah)) throw domainError("purchase_order_cost_mismatch", 409);
      }
    }
    const acceptedLines = allocatePurchaseFees(normalizedLines.filter((line) => line.purchaseQuantity > 0), normalizedFees);
    const rejectedLines = normalizedLines.filter((line) => line.rejectedPurchaseQuantity > 0).map((line) => ({
      ingredientId: line.ingredientId, purchaseUnitLabel: line.purchaseUnitLabel,
      rejectedPurchaseQuantity: line.rejectedPurchaseQuantity, rejectionReason: line.rejectionReason,
    }));
    const deliveredLines = normalizedLines.map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      deliveredPurchaseQuantity: line.deliveredPurchaseQuantity,
      quantityStatus: line.quantityStatus,
      orderedRemainingBefore: line.orderedRemainingBefore,
      overPurchaseQuantity: line.overPurchaseQuantity,
      underPurchaseQuantity: line.underPurchaseQuantity,
      overReceiptClassification: line.overReceiptClassification,
    }));
    const quarantinedLines = normalizedLines.filter((line) => line.quarantinedPurchaseQuantity > 0).map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      quarantinedPurchaseQuantity: line.quarantinedPurchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      inspectionUnitCostRupiah: line.inspectionUnitCostRupiah,
    }));
    const pendingInspectionLines = normalizedLines.filter((line) => line.pendingInspectionPurchaseQuantity > 0).map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      pendingInspectionPurchaseQuantity: line.pendingInspectionPurchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      inspectionUnitCostRupiah: line.inspectionUnitCostRupiah,
    }));
    const lots = normalizedLines.flatMap((line) => line.lots.map((lot) => ({ ingredientId: line.ingredientId, ...lot })));
    const normalizedQuarantineLocationId = normalizeReceivingFlowLocation(quarantineLocationId, quarantinedLines.length > 0, strictReceivingLocations, "QUARANTINE_HOLD", "purchase_quarantine_location_required");
    const normalizedRejectionLocationId = normalizeReceivingFlowLocation(rejectionLocationId, rejectedLines.length > 0, strictReceivingLocations, "REJECTED_RETURN", "purchase_rejection_location_required");
    const normalizedPendingInspectionLocationId = normalizeReceivingFlowLocation(pendingInspectionLocationId, pendingInspectionLines.length > 0, strictReceivingLocations, "PENDING_INSPECTION", "purchase_pending_inspection_location_required");
    const receiptSource = linkedOrder ? "PURCHASE_ORDER" : "AUTHORIZED_UNPLANNED";
    const receivingFields = {
      receiptSource,
      destinationLocationId: normalizedDestinationLocationId,
      quarantineLocationId: normalizedQuarantineLocationId,
      rejectionLocationId: normalizedRejectionLocationId,
      pendingInspectionLocationId: normalizedPendingInspectionLocationId,
      deliveredLines,
      quarantinedLines,
      pendingInspectionLines,
      lots,
    };
    const fingerprint = purchaseFingerprint(supplier, acceptedLines, rejectedLines, normalizedFees, linkedOrder?.id, receivingFields);
    const replay = replayReceipt;
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("purchase_idempotency_conflict", 409);
      const replayOrder = replay.purchaseOrderId ? this.purchaseOrders.find((item) => item.id === replay.purchaseOrderId) : null;
      return { receipt: structuredClone(replay), purchaseOrder: replayOrder ? structuredClone(replayOrder) : null, idempotentReplay: true, version: this.version };
    }
    if (linkedOrder?.status === "CANCELLED") throw domainError("purchase_order_cancelled", 409);
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    const receiptId = randomUUID();
    try {
      const pendingCogsAdjustments = deriveCogsAdjustmentsForReceipt({
        receiptId,
        receivedAt,
        acceptedLines,
        saleConsumptions: this.saleConsumptions,
        priorAdjustments: this.cogsAdjustments,
      });
      for (const line of acceptedLines) {
        const previous = this.inventoryBalances.get(line.ingredientId) ?? { ingredientId: line.ingredientId, quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 };
        const quantityBase = roundedQuantity(previous.quantityBase + line.baseQuantity);
        if (!validBalanceQuantity(quantityBase)) throw domainError("purchase_quantity_overflow", 422);
        const inventoryValueRupiah = previous.inventoryValueRupiah + line.totalCostRupiah;
        if (!Number.isSafeInteger(inventoryValueRupiah) || (quantityBase > 0 && inventoryValueRupiah <= 0)) throw domainError("purchase_bonus_cost_basis_required", 422);
        const averageCostPerBaseUnitRupiah = roundedUnitCost(inventoryValueRupiah / quantityBase);
        if (!validUnitCost(averageCostPerBaseUnitRupiah)) throw domainError("purchase_unit_cost_overflow", 422);
        this.inventoryBalances.set(line.ingredientId, { ingredientId: line.ingredientId, quantityBase, inventoryValueRupiah, averageCostPerBaseUnitRupiah });
        const ingredient = this.ingredients.get(line.ingredientId);
        this.ingredients.set(line.ingredientId, { ...ingredient, costPerUnitRupiah: averageCostPerBaseUnitRupiah, updatedAt: receivedAt });
      }
      this.#assertGateIntegrity();
      const receipt = {
        id: receiptId, idempotencyKey: key, fingerprint, supplierName: supplier, businessDate: normalizedBusinessDate,
        ...(linkedOrder ? { purchaseOrderId: linkedOrder.id, supplierId: linkedOrder.supplierId } : {}),
        receiptSource,
        destinationLocationId: normalizedDestinationLocationId,
        quarantineLocationId: normalizedQuarantineLocationId,
        rejectionLocationId: normalizedRejectionLocationId,
        pendingInspectionLocationId: normalizedPendingInspectionLocationId,
        receivedAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
        totalItemCostRupiah: acceptedLines.reduce((sum, line) => sum + line.itemCostRupiah, 0),
        totalAdditionalFeesRupiah: normalizedFees.reduce((sum, fee) => sum + fee.amountRupiah, 0),
        totalCostRupiah: acceptedLines.reduce((sum, line) => sum + line.totalCostRupiah, 0),
        additionalFees: normalizedFees, deliveredLines, rejectedLines, quarantinedLines, pendingInspectionLines, lots, lines: acceptedLines,
      };
      const event = this.#record("hpp.purchase.received", actorId, reason, {
        receiptId: receipt.id,
        purchaseOrderId: linkedOrder?.id ?? null,
        supplierName: supplier,
        totalCostRupiah: receipt.totalCostRupiah,
        lineCount: normalizedLines.length,
        rejectedLineCount: rejectedLines.length,
        additionalFeeCount: normalizedFees.length,
        cogsAdjustmentCount: pendingCogsAdjustments.length,
        cogsAdjustmentRupiah: pendingCogsAdjustments.reduce((sum, item) => safeRupiah(sum + item.adjustmentRupiah), 0),
      });
      receipt.version = event.version;
      pendingCogsAdjustments.forEach((adjustment) => this.cogsAdjustments.push({ ...adjustment, version: event.version }));
      if (linkedOrder) {
        for (const line of normalizedLines) {
          const orderedLine = linkedOrder.lines.find((item) => item.ingredientId === line.ingredientId);
          orderedLine.receivedPurchaseQuantity = roundedQuantity(orderedLine.receivedPurchaseQuantity + line.purchaseQuantity);
          orderedLine.rejectedPurchaseQuantity = roundedQuantity(orderedLine.rejectedPurchaseQuantity + line.rejectedPurchaseQuantity);
          orderedLine.quarantinedPurchaseQuantity = roundedQuantity(orderedLine.quarantinedPurchaseQuantity + line.quarantinedPurchaseQuantity);
          orderedLine.pendingInspectionPurchaseQuantity = roundedQuantity(orderedLine.pendingInspectionPurchaseQuantity + line.pendingInspectionPurchaseQuantity);
          orderedLine.deliveredPurchaseQuantity = roundedQuantity(orderedLine.deliveredPurchaseQuantity + line.deliveredPurchaseQuantity);
          orderedLine.paidOverPurchaseQuantity = roundedQuantity(orderedLine.paidOverPurchaseQuantity + (line.overReceiptClassification === "PAID" ? line.overPurchaseQuantity : 0));
          orderedLine.bonusPurchaseQuantity = roundedQuantity(orderedLine.bonusPurchaseQuantity + line.bonusPurchaseQuantity);
        }
        linkedOrder.status = purchaseOrderStatus(linkedOrder.lines);
        linkedOrder.updatedAt = receivedAt;
      }
      this.purchaseReceipts.push(receipt);
      return { ...event, receipt: structuredClone(receipt), purchaseOrder: linkedOrder ? structuredClone(linkedOrder) : null, idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  decidePurchaseReceiptInspection({ idempotencyKey, purchaseReceiptId, ingredientId, lotCode, sourceDisposition, decision, purchaseQuantity, destinationLocationId, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const receipt = this.purchaseReceipts.find((item) => item.id === purchaseReceiptId);
    if (!receipt) throw domainError("purchase_receipt_not_found", 404);
    if (!["QUARANTINED", "PENDING_INSPECTION"].includes(sourceDisposition) || !["ACCEPT", "REJECT"].includes(decision)) throw domainError("purchase_inspection_decision_invalid", 422);
    const quantity = exactPositiveQuantity(purchaseQuantity, "purchase_inspection_quantity_invalid");
    const location = cleanPurchaseText(destinationLocationId, "purchase_inspection_destination_required");
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient) throw domainError("ingredient_not_found", 404);
    const normalizedLotCode = lotCode == null ? null : cleanPurchaseText(lotCode, "purchase_lot_identity_invalid");
    if (ingredient.lotTrackingPolicy === "REQUIRED" && normalizedLotCode === null) throw domainError("purchase_lot_required", 422);
    const fingerprint = inspectionDecisionFingerprint({ purchaseReceiptId, ingredientId, lotCode: normalizedLotCode, sourceDisposition, decision, purchaseQuantity: quantity, destinationLocationId: location, reason });
    const replay = this.purchaseReceiptInspectionDecisions.find((item) => item.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("purchase_inspection_idempotency_conflict", 409);
      return { decision: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    const heldLine = (sourceDisposition === "QUARANTINED" ? receipt.quarantinedLines : receipt.pendingInspectionLines).find((line) => line.ingredientId === ingredientId);
    if (!heldLine || !validQuantity(heldLine.baseUnitsPerPurchaseUnit) || !validUnitCost(heldLine.inspectionUnitCostRupiah)) throw domainError("purchase_inspection_source_not_found", 404);
    const sourceField = sourceDisposition === "QUARANTINED" ? "quarantinedPurchaseQuantity" : "pendingInspectionPurchaseQuantity";
    if (normalizedLotCode !== null) {
      const sourceLot = receipt.lots.find((lot) => lot.ingredientId === ingredientId && lot.lotCode === normalizedLotCode && lot[sourceField] > 0);
      if (!sourceLot) throw domainError("purchase_inspection_lot_not_found", 404);
    }
    const sourceQuantity = inspectionSourceQuantity(receipt, ingredientId, normalizedLotCode, sourceDisposition);
    const decidedQuantity = this.purchaseReceiptInspectionDecisions.filter((item) => item.purchaseReceiptId === receipt.id && item.ingredientId === ingredientId && item.lotCode === normalizedLotCode && item.sourceDisposition === sourceDisposition).reduce((sum, item) => roundedQuantity(sum + item.purchaseQuantity), 0);
    if (roundedQuantity(decidedQuantity + quantity) > sourceQuantity) throw domainError("purchase_inspection_quantity_exceeds_remaining", 409);
    const occurredAt = this.clock().toISOString();
    if (decision === "ACCEPT") {
      const decisionDate = occurredAt.slice(0, 10);
      const sourceLots = receipt.lots.filter((lot) => lot.ingredientId === ingredientId
        && (normalizedLotCode === null || lot.lotCode === normalizedLotCode) && lot[sourceField] > 0);
      if (sourceLots.some((lot) => lot.expiryDate < decisionDate)) throw domainError("purchase_inspection_lot_expired", 409);
    }
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    try {
      const baseQuantity = roundedQuantity(quantity * heldLine.baseUnitsPerPurchaseUnit);
      const inventoryValueRupiah = Math.round(quantity * heldLine.inspectionUnitCostRupiah);
      if (decision === "ACCEPT") this.#applyAcceptedInspectionStock(ingredientId, baseQuantity, inventoryValueRupiah, occurredAt);
      const event = this.#record("hpp.purchase.receipt_inspection_decided", actorId, reason, { purchaseReceiptId: receipt.id, ingredientId, lotCode: normalizedLotCode, sourceDisposition, decision, purchaseQuantity: quantity, destinationLocationId: location });
      const fact = { id: randomUUID(), idempotencyKey: key, fingerprint, purchaseReceiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId ?? null, ingredientId, lotCode: normalizedLotCode, sourceDisposition, decision, purchaseQuantity: quantity, baseQuantity, inventoryValueRupiah: decision === "ACCEPT" ? inventoryValueRupiah : 0, destinationLocationId: location, occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(), version: event.version };
      this.purchaseReceiptInspectionDecisions.push(fact);
      if (receipt.purchaseOrderId) {
        const order = this.purchaseOrders.find((item) => item.id === receipt.purchaseOrderId);
        const orderLine = order.lines.find((item) => item.ingredientId === ingredientId);
        const sourceField = sourceDisposition === "QUARANTINED" ? "quarantinedPurchaseQuantity" : "pendingInspectionPurchaseQuantity";
        orderLine[sourceField] = roundedQuantity(orderLine[sourceField] - quantity);
        orderLine[decision === "ACCEPT" ? "receivedPurchaseQuantity" : "rejectedPurchaseQuantity"] = roundedQuantity(orderLine[decision === "ACCEPT" ? "receivedPurchaseQuantity" : "rejectedPurchaseQuantity"] + quantity);
        order.updatedAt = occurredAt;
      }
      return { ...event, decision: structuredClone(fact), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  #applyAcceptedInspectionStock(ingredientId, baseQuantity, inventoryValueRupiah, occurredAt) {
    const previous = this.inventoryBalances.get(ingredientId) ?? { ingredientId, quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 };
    const quantityBase = roundedQuantity(previous.quantityBase + baseQuantity);
    const value = previous.inventoryValueRupiah + inventoryValueRupiah;
    if (!validBalanceQuantity(quantityBase) || !Number.isSafeInteger(value) || value <= 0) throw domainError("purchase_value_overflow", 422);
    const average = roundedUnitCost(value / quantityBase);
    this.inventoryBalances.set(ingredientId, { ingredientId, quantityBase, inventoryValueRupiah: value, averageCostPerBaseUnitRupiah: average });
    this.ingredients.set(ingredientId, { ...this.ingredients.get(ingredientId), costPerUnitRupiah: average, updatedAt: occurredAt });
    this.#assertGateIntegrity();
  }

  matchPurchaseInvoice({ idempotencyKey, purchaseOrderId, invoiceNumber, invoiceDate, dueDate, lines, additionalFees = [], totalInvoiceRupiah, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const order = this.purchaseOrders.find((item) => item.id === purchaseOrderId);
    if (!order) throw domainError("purchase_order_not_found", 404);
    const normalizedNumber = cleanPurchaseText(invoiceNumber, "purchase_invoice_number_invalid");
    if (!validBusinessDate(invoiceDate) || !validBusinessDate(dueDate) || dueDate < invoiceDate) throw domainError("purchase_invoice_date_invalid", 422);
    const normalizedLines = normalizePurchaseInvoiceLines(lines, order);
    const normalizedFees = normalizePurchaseFees(additionalFees);
    const calculatedTotal = normalizedLines.reduce((sum, line) => sum + line.invoiceLineTotalRupiah, 0) + normalizedFees.reduce((sum, fee) => sum + fee.amountRupiah, 0);
    if (!Number.isSafeInteger(calculatedTotal) || !Number.isSafeInteger(totalInvoiceRupiah) || totalInvoiceRupiah <= 0 || totalInvoiceRupiah !== calculatedTotal) throw domainError("purchase_invoice_total_mismatch", 422);
    const fingerprint = purchaseInvoiceFingerprint(order.id, normalizedNumber, invoiceDate, dueDate, normalizedLines, normalizedFees, totalInvoiceRupiah);
    const replay = this.purchaseInvoices.find((invoice) => invoice.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("purchase_invoice_idempotency_conflict", 409);
      return { invoice: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    if (this.purchaseInvoices.some((invoice) => invoice.supplierId === order.supplierId && invoice.invoiceNumber.toLocaleLowerCase("id") === normalizedNumber.toLocaleLowerCase("id"))) throw domainError("purchase_invoice_number_conflict", 409);
    const orderReceipts = this.purchaseReceipts.filter((receipt) => receipt.purchaseOrderId === order.id);
    if (!orderReceipts.some((receipt) => receipt.lines.length > 0)) throw domainError("purchase_invoice_receipt_required", 409);
    const receiptVersionThrough = Math.max(...orderReceipts.map((receipt) => receipt.version));
    const previousMatched = this.purchaseInvoices.filter((invoice) => invoice.purchaseOrderId === order.id && invoice.matchStatus === "MATCHED");
    const match = calculatePurchaseInvoiceMatch(order, orderReceipts, previousMatched, normalizedLines, normalizedFees, this.purchaseReceiptInspectionDecisions);
    this.#assertMutation(expectedVersion, reason);
    const recordedAt = this.clock().toISOString();
    const invoice = {
      id: randomUUID(), idempotencyKey: key, fingerprint, purchaseOrderId: order.id, supplierId: order.supplierId, supplierNameSnapshot: order.supplierNameSnapshot,
      invoiceNumber: normalizedNumber, invoiceDate, dueDate, lines: match.lines, additionalFees: match.additionalFees,
      receiptVersionThrough,
      subtotalRupiah: normalizedLines.reduce((sum, line) => sum + line.invoiceLineTotalRupiah, 0),
      totalAdditionalFeesRupiah: normalizedFees.reduce((sum, fee) => sum + fee.amountRupiah, 0),
      totalInvoiceRupiah, expectedMatchedTotalRupiah: match.expectedMatchedTotalRupiah, totalVarianceRupiah: totalInvoiceRupiah - match.expectedMatchedTotalRupiah,
      matchStatus: match.matchStatus,
      paymentReadiness: purchaseInvoiceInitialReadiness({
        matchStatus: match.matchStatus,
        lines: match.lines,
        additionalFees: match.additionalFees,
        expectedMatchedTotalRupiah: match.expectedMatchedTotalRupiah,
        totalVarianceRupiah: totalInvoiceRupiah - match.expectedMatchedTotalRupiah,
      }),
      approvalHistory: [], payableEntry: null,
      recordedAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
    };
    const event = this.#record("hpp.purchase_invoice.matched", actorId, reason, { purchaseInvoiceId: invoice.id, purchaseOrderId: order.id, matchStatus: invoice.matchStatus, totalVarianceRupiah: invoice.totalVarianceRupiah });
    invoice.version = event.version;
    this.purchaseInvoices.push(invoice);
    return { ...event, invoice: structuredClone(invoice), idempotentReplay: false };
  }

  decidePurchaseInvoiceApproval({ idempotencyKey, purchaseInvoiceId, decision, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedDecision = String(decision ?? "").trim().toUpperCase();
    if (!["APPROVE", "REJECT"].includes(normalizedDecision)) throw domainError("purchase_invoice_approval_decision_invalid", 422);
    const action = normalizedDecision === "APPROVE" ? "APPROVED" : "REJECTED";
    const fingerprint = purchaseInvoiceActionFingerprint(purchaseInvoiceId, action, reason);
    const replay = this.#purchaseInvoiceActionReplay(key, action, fingerprint);
    if (replay) return replay;
    const invoice = this.purchaseInvoices.find((item) => item.id === purchaseInvoiceId);
    if (!invoice) throw domainError("purchase_invoice_not_found", 404);
    if (actorRole !== "finance") throw domainError("purchase_invoice_approval_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (normalizedActorId === invoice.actorId) throw domainError("purchase_invoice_self_approval_denied", 403);
    if (!["READY_FOR_APPROVAL", "VARIANCE_REVIEW_REQUIRED"].includes(invoice.paymentReadiness)) throw domainError("purchase_invoice_approval_state_invalid", 409);
    this.#assertMutation(expectedVersion, reason);
    const toStatus = action === "APPROVED" ? "APPROVED_NOT_POSTED" : "REJECTED";
    const event = this.#record(`hpp.purchase_invoice.${action.toLowerCase()}`, normalizedActorId, reason, { purchaseInvoiceId: invoice.id, fromStatus: invoice.paymentReadiness, toStatus });
    invoice.approvalHistory.push({ idempotencyKey: key, fingerprint, action, fromStatus: invoice.paymentReadiness, toStatus, actorId: normalizedActorId, actorRole, reason: reason.trim(), occurredAt: event.occurredAt, version: event.version });
    invoice.paymentReadiness = toStatus;
    return { ...event, invoice: structuredClone(invoice), idempotentReplay: false };
  }

  postPurchaseInvoice({ idempotencyKey, purchaseInvoiceId, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const fingerprint = purchaseInvoiceActionFingerprint(purchaseInvoiceId, "POSTED", reason);
    const replay = this.#purchaseInvoiceActionReplay(key, "POSTED", fingerprint);
    if (replay) return replay;
    const invoice = this.purchaseInvoices.find((item) => item.id === purchaseInvoiceId);
    if (!invoice) throw domainError("purchase_invoice_not_found", 404);
    if (actorRole !== "owner") throw domainError("purchase_invoice_post_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (invoice.paymentReadiness !== "APPROVED_NOT_POSTED") throw domainError("purchase_invoice_post_state_invalid", 409);
    const approval = invoice.approvalHistory.findLast((item) => item.action === "APPROVED");
    if (!approval || approval.actorId === normalizedActorId) throw domainError("purchase_invoice_poster_separation_required", 403);
    this.#assertMutation(expectedVersion, reason);
    assertPurchaseInvoicePostingCoverage(invoice, this.purchaseReceipts, this.purchaseReceiptInspectionDecisions, this.purchaseInvoices);
    const event = this.#record("hpp.purchase_invoice.posted", normalizedActorId, reason, { purchaseInvoiceId: invoice.id, fromStatus: invoice.paymentReadiness, toStatus: "POSTED_UNPAID", totalInvoiceRupiah: invoice.totalInvoiceRupiah });
    invoice.approvalHistory.push({ idempotencyKey: key, fingerprint, action: "POSTED", fromStatus: invoice.paymentReadiness, toStatus: "POSTED_UNPAID", actorId: normalizedActorId, actorRole, reason: reason.trim(), occurredAt: event.occurredAt, version: event.version });
    invoice.paymentReadiness = "POSTED_UNPAID";
    invoice.payableEntry = { status: "OPEN", amountRupiah: invoice.totalInvoiceRupiah, creditedRupiah: 0, paidRupiah: 0, outstandingRupiah: invoice.totalInvoiceRupiah, dueDate: invoice.dueDate, supplierId: invoice.supplierId, supplierNameSnapshot: invoice.supplierNameSnapshot, postedAt: event.occurredAt, postedByActorId: normalizedActorId };
    return { ...event, invoice: structuredClone(invoice), idempotentReplay: false };
  }

  recordPurchaseInvoicePayment({ idempotencyKey, purchaseInvoiceId, paidDate, amountRupiah, method, reference, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedMethod = String(method ?? "").trim().toUpperCase();
    const normalizedReference = cleanPurchaseText(reference, "purchase_invoice_payment_reference_invalid");
    if (!validBusinessDate(paidDate)) throw domainError("purchase_invoice_payment_date_invalid", 422);
    if (!PURCHASE_PAYMENT_METHODS.has(normalizedMethod)) throw domainError("purchase_invoice_payment_method_invalid", 422);
    const fingerprint = purchaseInvoicePaymentFingerprint(purchaseInvoiceId, paidDate, amountRupiah, normalizedMethod, normalizedReference, reason);
    const replay = this.purchaseInvoicePayments.find((payment) => payment.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("purchase_invoice_payment_idempotency_conflict", 409);
      const invoice = this.purchaseInvoices.find((item) => item.id === replay.purchaseInvoiceId);
      return { payment: structuredClone(replay), invoice: structuredClone(invoice), idempotentReplay: true, version: this.version };
    }
    const invoice = this.purchaseInvoices.find((item) => item.id === purchaseInvoiceId);
    if (!invoice) throw domainError("purchase_invoice_not_found", 404);
    if (actorRole !== "owner") throw domainError("purchase_invoice_payment_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (invoice.paymentReadiness !== "POSTED_UNPAID" || !invoice.payableEntry || invoice.payableEntry.outstandingRupiah <= 0) throw domainError("purchase_invoice_payment_state_invalid", 409);
    const blockedCredit = this.purchaseInvoiceCredits.find((credit) => credit.purchaseInvoiceId === invoice.id && (credit.status === "PENDING_OWNER_POST" || credit.reversalHistory.some((item) => item.status === "PENDING_OWNER_DECISION")));
    if (blockedCredit) throw domainError("purchase_invoice_payment_credit_pending", 409);
    if (paidDate < invoice.invoiceDate) throw domainError("purchase_invoice_payment_date_invalid", 422);
    if (!Number.isSafeInteger(amountRupiah) || amountRupiah <= 0 || amountRupiah > invoice.payableEntry.outstandingRupiah) throw domainError("purchase_invoice_payment_amount_invalid", 422);
    this.#assertMutation(expectedVersion, reason);
    const event = this.#record("hpp.purchase_invoice.payment_recorded", normalizedActorId, reason, { purchaseInvoiceId: invoice.id, supplierId: invoice.supplierId, amountRupiah, method: normalizedMethod });
    const payment = {
      id: randomUUID(), idempotencyKey: key, fingerprint, purchaseInvoiceId: invoice.id, supplierId: invoice.supplierId, supplierNameSnapshot: invoice.supplierNameSnapshot,
      paidDate, amountRupiah, method: normalizedMethod, reference: normalizedReference, status: "RECORDED",
      recordedAt: event.occurredAt, recordedByActorId: normalizedActorId, recordedByRole: actorRole, reason: reason.trim(), version: event.version,
    };
    this.purchaseInvoicePayments.push(payment);
    invoice.payableEntry.paidRupiah += amountRupiah;
    invoice.payableEntry.outstandingRupiah -= amountRupiah;
    invoice.payableEntry.status = payableStatus(invoice.payableEntry.creditedRupiah, invoice.payableEntry.paidRupiah, invoice.payableEntry.outstandingRupiah);
    return { ...event, payment: structuredClone(payment), invoice: structuredClone(invoice), idempotentReplay: false };
  }

  recordPurchaseInvoiceCredit({ idempotencyKey, purchaseInvoiceId, supplierReturnId, creditNoteNumber, creditDate, amountRupiah, creditType, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedNumber = cleanPurchaseText(creditNoteNumber, "purchase_invoice_credit_number_invalid");
    const normalizedType = String(creditType ?? "").trim().toUpperCase();
    if (!validBusinessDate(creditDate)) throw domainError("purchase_invoice_credit_date_invalid", 422);
    if (!PURCHASE_CREDIT_TYPES.has(normalizedType)) throw domainError("purchase_invoice_credit_type_invalid", 422);
    const normalizedSupplierReturnId = typeof supplierReturnId === "string" && supplierReturnId.trim() ? supplierReturnId.trim() : null;
    const fingerprint = purchaseInvoiceCreditFingerprint(purchaseInvoiceId, normalizedSupplierReturnId, normalizedNumber, creditDate, amountRupiah, normalizedType, reason);
    const replay = this.purchaseInvoiceCredits.find((credit) => credit.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("purchase_invoice_credit_idempotency_conflict", 409);
      return { creditMemo: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    const invoice = this.purchaseInvoices.find((item) => item.id === purchaseInvoiceId);
    if (!invoice) throw domainError("purchase_invoice_not_found", 404);
    if (actorRole !== "finance") throw domainError("purchase_invoice_credit_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (invoice.paymentReadiness !== "POSTED_UNPAID" || !invoice.payableEntry) throw domainError("purchase_invoice_credit_state_invalid", 409);
    const supplierReturn = normalizedSupplierReturnId ? this.supplierReturns.find((item) => item.id === normalizedSupplierReturnId) : null;
    if (normalizedType === "GOODS_RETURN") {
      if (!normalizedSupplierReturnId) throw domainError("supplier_return_credit_link_required", 422);
      if (!supplierReturn) throw domainError("supplier_return_not_found", 404);
      if (supplierReturn.creditMemoId || this.purchaseInvoiceCredits.some((credit) => credit.supplierReturnId === supplierReturn.id && credit.status !== "REVERSED")) throw domainError("supplier_return_credit_already_linked", 409);
      if (supplierReturn.disposition !== "CREDIT_EXPECTED" || supplierReturn.status !== "SHIPPED_AWAITING_CREDIT") throw domainError("supplier_return_credit_state_invalid", 409);
      const candidateInvoices = this.purchaseInvoices.filter((item) => item.purchaseOrderId === supplierReturn.purchaseOrderId && item.supplierId === supplierReturn.supplierId && item.paymentReadiness === "POSTED_UNPAID" && item.payableEntry);
      if (candidateInvoices.length !== 1 || candidateInvoices[0].id !== invoice.id) throw domainError("supplier_return_credit_lineage_mismatch", 409);
      if (amountRupiah !== supplierReturn.totalReturnValueRupiah) throw domainError("supplier_return_credit_amount_mismatch", 422);
    } else if (normalizedSupplierReturnId) throw domainError("supplier_return_credit_type_required", 422);
    if (creditDate < invoice.invoiceDate) throw domainError("purchase_invoice_credit_date_invalid", 422);
    if (this.purchaseInvoiceCredits.some((credit) => credit.supplierId === invoice.supplierId && credit.creditNoteNumber.toLocaleLowerCase("id") === normalizedNumber.toLocaleLowerCase("id"))) throw domainError("purchase_invoice_credit_number_conflict", 409);
    const reservedRupiah = this.purchaseInvoiceCredits.filter((credit) => credit.purchaseInvoiceId === invoice.id && credit.status === "PENDING_OWNER_POST").reduce((sum, credit) => sum + credit.amountRupiah, 0);
    const availableRupiah = invoice.payableEntry.outstandingRupiah - reservedRupiah;
    if (!Number.isSafeInteger(amountRupiah) || amountRupiah <= 0 || amountRupiah > availableRupiah) throw domainError("purchase_invoice_credit_amount_invalid", 422);
    this.#assertMutation(expectedVersion, reason);
    const event = this.#record("hpp.purchase_invoice.credit_proposed", normalizedActorId, reason, { purchaseInvoiceId: invoice.id, supplierReturnId: normalizedSupplierReturnId, creditNoteNumber: normalizedNumber, amountRupiah, creditType: normalizedType });
    const creditMemo = {
      id: randomUUID(), idempotencyKey: key, fingerprint, purchaseInvoiceId: invoice.id, supplierId: invoice.supplierId, supplierNameSnapshot: invoice.supplierNameSnapshot,
      supplierReturnId: normalizedSupplierReturnId, returnReferenceSnapshot: supplierReturn?.returnReference ?? null,
      creditNoteNumber: normalizedNumber, creditDate, amountRupiah, creditType: normalizedType, status: "PENDING_OWNER_POST",
      createdAt: event.occurredAt, createdByActorId: normalizedActorId, createdByRole: actorRole, reason: reason.trim(), version: event.version, postTransition: null, reversalHistory: [],
    };
    this.purchaseInvoiceCredits.push(creditMemo);
    if (supplierReturn) {
      supplierReturn.status = "CREDIT_RECEIVED_PENDING_POST";
      supplierReturn.creditMemoId = creditMemo.id;
    }
    return { ...event, creditMemo: structuredClone(creditMemo), idempotentReplay: false };
  }

  postPurchaseInvoiceCredit({ idempotencyKey, creditMemoId, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const fingerprint = purchaseInvoiceCreditPostFingerprint(creditMemoId, reason);
    const replay = this.purchaseInvoiceCredits.find((credit) => credit.postTransition?.idempotencyKey === key);
    if (replay) {
      if (replay.postTransition.fingerprint !== fingerprint) throw domainError("purchase_invoice_credit_idempotency_conflict", 409);
      const invoice = this.purchaseInvoices.find((item) => item.id === replay.purchaseInvoiceId);
      return { creditMemo: structuredClone(replay), invoice: structuredClone(invoice), idempotentReplay: true, version: this.version };
    }
    const creditMemo = this.purchaseInvoiceCredits.find((credit) => credit.id === creditMemoId);
    if (!creditMemo) throw domainError("purchase_invoice_credit_not_found", 404);
    if (actorRole !== "owner") throw domainError("purchase_invoice_credit_post_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (creditMemo.createdByActorId === normalizedActorId) throw domainError("purchase_invoice_credit_poster_separation_required", 403);
    if (creditMemo.status !== "PENDING_OWNER_POST") throw domainError("purchase_invoice_credit_post_state_invalid", 409);
    const invoice = this.purchaseInvoices.find((item) => item.id === creditMemo.purchaseInvoiceId);
    if (!invoice?.payableEntry || invoice.paymentReadiness !== "POSTED_UNPAID" || creditMemo.amountRupiah > invoice.payableEntry.outstandingRupiah) throw domainError("purchase_invoice_credit_state_invalid", 409);
    const linkedSupplierReturn = creditMemo.supplierReturnId ? this.supplierReturns.find((item) => item.id === creditMemo.supplierReturnId) : null;
    if (creditMemo.supplierReturnId && (!linkedSupplierReturn || linkedSupplierReturn.creditMemoId !== creditMemo.id || linkedSupplierReturn.status !== "CREDIT_RECEIVED_PENDING_POST")) throw domainError("supplier_return_credit_state_invalid", 409);
    this.#assertMutation(expectedVersion, reason);
    const event = this.#record("hpp.purchase_invoice.credit_posted", normalizedActorId, reason, { purchaseInvoiceId: invoice.id, creditMemoId: creditMemo.id, creditNoteNumber: creditMemo.creditNoteNumber, amountRupiah: creditMemo.amountRupiah });
    creditMemo.status = "POSTED";
    creditMemo.postTransition = { idempotencyKey: key, fingerprint, actorId: normalizedActorId, actorRole, reason: reason.trim(), occurredAt: event.occurredAt, version: event.version };
    invoice.payableEntry.creditedRupiah += creditMemo.amountRupiah;
    invoice.payableEntry.outstandingRupiah -= creditMemo.amountRupiah;
    invoice.payableEntry.status = payableStatus(invoice.payableEntry.creditedRupiah, invoice.payableEntry.paidRupiah, invoice.payableEntry.outstandingRupiah);
    if (linkedSupplierReturn) linkedSupplierReturn.status = "CREDIT_POSTED";
    return { ...event, creditMemo: structuredClone(creditMemo), invoice: structuredClone(invoice), idempotentReplay: false };
  }

  requestPurchaseInvoiceCreditReversal({ idempotencyKey, creditMemoId, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const fingerprint = purchaseInvoiceCreditReversalRequestFingerprint(creditMemoId, reason);
    const replay = this.purchaseInvoiceCredits.flatMap((credit) => credit.reversalHistory.map((reversal) => ({ credit, reversal }))).find(({ reversal }) => reversal.requestIdempotencyKey === key);
    if (replay) {
      if (replay.reversal.requestFingerprint !== fingerprint) throw domainError("purchase_invoice_credit_reversal_idempotency_conflict", 409);
      return { creditMemo: structuredClone(replay.credit), reversal: structuredClone(replay.reversal), idempotentReplay: true, version: this.version };
    }
    const creditMemo = this.purchaseInvoiceCredits.find((credit) => credit.id === creditMemoId);
    if (!creditMemo) throw domainError("purchase_invoice_credit_not_found", 404);
    if (actorRole !== "finance") throw domainError("purchase_invoice_credit_reversal_request_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    if (creditMemo.status !== "POSTED") throw domainError("purchase_invoice_credit_reversal_state_invalid", 409);
    if (creditMemo.reversalHistory.some((item) => item.status === "PENDING_OWNER_DECISION")) throw domainError("purchase_invoice_credit_reversal_pending", 409);
    if (creditMemo.reversalHistory.length >= 20) throw domainError("purchase_invoice_credit_reversal_history_limit", 409);
    this.#assertMutation(expectedVersion, reason);
    const event = this.#record("hpp.purchase_invoice.credit_reversal_requested", normalizedActorId, reason, { creditMemoId: creditMemo.id, purchaseInvoiceId: creditMemo.purchaseInvoiceId, amountRupiah: creditMemo.amountRupiah });
    const reversal = {
      id: randomUUID(), requestIdempotencyKey: key, requestFingerprint: fingerprint, requestedByActorId: normalizedActorId,
      requestedByRole: actorRole, requestReason: reason.trim(), requestedAt: event.occurredAt, requestVersion: event.version,
      status: "PENDING_OWNER_DECISION", decision: null,
    };
    creditMemo.reversalHistory.push(reversal);
    return { ...event, creditMemo: structuredClone(creditMemo), reversal: structuredClone(reversal), idempotentReplay: false };
  }

  decidePurchaseInvoiceCreditReversal({ idempotencyKey, creditMemoId, decision, expectedVersion, actorId, actorRole, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedDecision = String(decision ?? "").trim().toUpperCase();
    if (!["APPROVE", "REJECT"].includes(normalizedDecision)) throw domainError("purchase_invoice_credit_reversal_decision_invalid", 422);
    const fingerprint = purchaseInvoiceCreditReversalDecisionFingerprint(creditMemoId, normalizedDecision, reason);
    const replay = this.purchaseInvoiceCredits.flatMap((credit) => credit.reversalHistory.map((reversal) => ({ credit, reversal }))).find(({ reversal }) => reversal.decision?.idempotencyKey === key);
    if (replay) {
      if (replay.reversal.decision.fingerprint !== fingerprint) throw domainError("purchase_invoice_credit_reversal_idempotency_conflict", 409);
      const invoice = this.purchaseInvoices.find((item) => item.id === replay.credit.purchaseInvoiceId);
      return { creditMemo: structuredClone(replay.credit), reversal: structuredClone(replay.reversal), invoice: structuredClone(invoice), idempotentReplay: true, version: this.version };
    }
    const creditMemo = this.purchaseInvoiceCredits.find((credit) => credit.id === creditMemoId);
    if (!creditMemo) throw domainError("purchase_invoice_credit_not_found", 404);
    if (actorRole !== "owner") throw domainError("purchase_invoice_credit_reversal_decision_role_denied", 403);
    const normalizedActorId = cleanPurchaseText(actorId, "purchase_invoice_actor_invalid");
    const reversal = creditMemo.reversalHistory.findLast((item) => item.status === "PENDING_OWNER_DECISION");
    if (!reversal || creditMemo.status !== "POSTED") throw domainError("purchase_invoice_credit_reversal_state_invalid", 409);
    if (reversal.requestedByActorId === normalizedActorId) throw domainError("purchase_invoice_credit_reversal_separation_required", 403);
    const invoice = this.purchaseInvoices.find((item) => item.id === creditMemo.purchaseInvoiceId);
    if (!invoice?.payableEntry || invoice.paymentReadiness !== "POSTED_UNPAID") throw domainError("purchase_invoice_credit_state_invalid", 409);
    const linkedSupplierReturn = creditMemo.supplierReturnId ? this.supplierReturns.find((item) => item.id === creditMemo.supplierReturnId) : null;
    if (creditMemo.supplierReturnId && (!linkedSupplierReturn || linkedSupplierReturn.creditMemoId !== creditMemo.id || linkedSupplierReturn.status !== "CREDIT_POSTED")) throw domainError("supplier_return_credit_state_invalid", 409);
    this.#assertMutation(expectedVersion, reason);
    const event = this.#record("hpp.purchase_invoice.credit_reversal_decided", normalizedActorId, reason, { creditMemoId: creditMemo.id, purchaseInvoiceId: creditMemo.purchaseInvoiceId, decision: normalizedDecision, amountRupiah: creditMemo.amountRupiah });
    reversal.status = normalizedDecision === "APPROVE" ? "APPROVED" : "REJECTED";
    reversal.decision = { idempotencyKey: key, fingerprint, decision: normalizedDecision, actorId: normalizedActorId, actorRole, reason: reason.trim(), occurredAt: event.occurredAt, version: event.version };
    if (normalizedDecision === "APPROVE") {
      creditMemo.status = "REVERSED";
      invoice.payableEntry.creditedRupiah -= creditMemo.amountRupiah;
      invoice.payableEntry.outstandingRupiah += creditMemo.amountRupiah;
      invoice.payableEntry.status = payableStatus(invoice.payableEntry.creditedRupiah, invoice.payableEntry.paidRupiah, invoice.payableEntry.outstandingRupiah);
      if (linkedSupplierReturn) {
        linkedSupplierReturn.status = "SHIPPED_AWAITING_CREDIT";
        linkedSupplierReturn.creditMemoId = null;
      }
    }
    return { ...event, creditMemo: structuredClone(creditMemo), reversal: structuredClone(reversal), invoice: structuredClone(invoice), idempotentReplay: false };
  }

  createSupplierReturn({ idempotencyKey, purchaseReceiptId, returnReference, disposition, lines, expectedVersion, actorId, actorRole, reason } = {}) {
    if (actorRole !== "owner") throw domainError("supplier_return_role_denied", 403);
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedReference = cleanPurchaseText(returnReference, "supplier_return_reference_invalid");
    const normalizedDisposition = String(disposition ?? "").trim().toUpperCase();
    if (!SUPPLIER_RETURN_DISPOSITIONS.has(normalizedDisposition)) throw domainError("supplier_return_disposition_invalid", 422);
    const receipt = this.purchaseReceipts.find((item) => item.id === purchaseReceiptId);
    if (!receipt?.supplierId || !receipt.purchaseOrderId) throw domainError("supplier_return_receipt_invalid", 409);
    const normalizedLines = normalizeSupplierReturnLines(lines, receipt, this.supplierReturns);
    const fingerprint = supplierReturnFingerprint(receipt.id, normalizedReference, normalizedDisposition, normalizedLines, reason);
    const replay = this.supplierReturns.find((item) => item.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("supplier_return_idempotency_conflict", 409);
      return { supplierReturn: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    if (this.supplierReturns.some((item) => item.supplierId === receipt.supplierId && item.returnReference.toLocaleLowerCase("id") === normalizedReference.toLocaleLowerCase("id"))) throw domainError("supplier_return_reference_conflict", 409);
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    const shippedAt = this.clock().toISOString();
    try {
      for (const line of normalizedLines) {
        const previous = this.inventoryBalances.get(line.ingredientId);
        const next = applySupplierValueMovement(previous, line.baseQuantity, line.returnValueRupiah, "OUT");
        this.inventoryBalances.set(line.ingredientId, { ingredientId: line.ingredientId, ...next });
        const ingredient = this.ingredients.get(line.ingredientId);
        this.ingredients.set(line.ingredientId, { ...ingredient, costPerUnitRupiah: next.averageCostPerBaseUnitRupiah, updatedAt: shippedAt });
      }
      this.#assertGateIntegrity();
      const event = this.#record("hpp.supplier_return.shipped", actorId, reason, { purchaseReceiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId, supplierId: receipt.supplierId, returnReference: normalizedReference, disposition: normalizedDisposition, lineCount: normalizedLines.length });
      const supplierReturn = {
        id: randomUUID(), idempotencyKey: key, fingerprint, purchaseReceiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId,
        supplierId: receipt.supplierId, supplierNameSnapshot: receipt.supplierName, returnReference: normalizedReference,
        disposition: normalizedDisposition, status: normalizedDisposition === "REPLACEMENT_EXPECTED" ? "SHIPPED_AWAITING_REPLACEMENT" : "SHIPPED_AWAITING_CREDIT",
        lines: normalizedLines, totalReturnValueRupiah: normalizedLines.reduce((sum, line) => sum + line.returnValueRupiah, 0),
        shippedAt, actorId: String(actorId ?? "owner"), actorRole, reason: reason.trim(), version: event.version, replacementReceipt: null, creditMemoId: null,
      };
      this.supplierReturns.push(supplierReturn);
      return { ...event, supplierReturn: structuredClone(supplierReturn), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  receiveSupplierReplacement({ idempotencyKey, supplierReturnId, receiptReference, expectedVersion, actorId, actorRole, reason } = {}) {
    if (actorRole !== "owner") throw domainError("supplier_replacement_role_denied", 403);
    const key = cleanIdempotencyKey(idempotencyKey);
    const normalizedReference = cleanPurchaseText(receiptReference, "supplier_replacement_reference_invalid");
    const fingerprint = supplierReplacementFingerprint(supplierReturnId, normalizedReference, reason);
    const replay = this.supplierReturns.find((item) => item.replacementReceipt?.idempotencyKey === key);
    if (replay) {
      if (replay.replacementReceipt.fingerprint !== fingerprint) throw domainError("supplier_replacement_idempotency_conflict", 409);
      return { supplierReturn: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    const supplierReturn = this.supplierReturns.find((item) => item.id === supplierReturnId);
    if (!supplierReturn) throw domainError("supplier_return_not_found", 404);
    if (supplierReturn.disposition !== "REPLACEMENT_EXPECTED") throw domainError("supplier_replacement_disposition_invalid", 409);
    if (supplierReturn.status !== "SHIPPED_AWAITING_REPLACEMENT" || supplierReturn.replacementReceipt) throw domainError("supplier_replacement_state_invalid", 409);
    if (this.supplierReturns.some((item) => item.supplierId === supplierReturn.supplierId && item.replacementReceipt?.receiptReference.toLocaleLowerCase("id") === normalizedReference.toLocaleLowerCase("id"))) throw domainError("supplier_replacement_reference_conflict", 409);
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    const receivedAt = this.clock().toISOString();
    try {
      for (const line of supplierReturn.lines) {
        const previous = this.inventoryBalances.get(line.ingredientId) ?? { ingredientId: line.ingredientId, quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: line.unitCostSnapshotRupiah };
        const next = applySupplierValueMovement(previous, line.baseQuantity, line.returnValueRupiah, "IN");
        this.inventoryBalances.set(line.ingredientId, { ingredientId: line.ingredientId, ...next });
        const ingredient = this.ingredients.get(line.ingredientId);
        this.ingredients.set(line.ingredientId, { ...ingredient, costPerUnitRupiah: next.averageCostPerBaseUnitRupiah, updatedAt: receivedAt });
      }
      this.#assertGateIntegrity();
      const event = this.#record("hpp.supplier_replacement.received", actorId, reason, { supplierReturnId: supplierReturn.id, supplierId: supplierReturn.supplierId, receiptReference: normalizedReference, lineCount: supplierReturn.lines.length });
      supplierReturn.status = "REPLACED";
      supplierReturn.replacementReceipt = { idempotencyKey: key, fingerprint, receiptReference: normalizedReference, receivedAt, actorId: String(actorId ?? "owner"), actorRole, reason: reason.trim(), version: event.version };
      return { ...event, supplierReturn: structuredClone(supplierReturn), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  recordInventoryMovement({ idempotencyKey, movementType, ingredientId, quantityBase, locationId, sharedStorage = false, effectiveAt, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    if (!MANUAL_INVENTORY_MOVEMENT_TYPES.has(movementType)) throw domainError("inventory_movement_type_invalid", 422);
    if (typeof ingredientId !== "string" || !this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    const inputQuantity = exactMovementQuantity(quantityBase, movementType === "CYCLE_COUNT");
    const location = locationId == null ? null : cleanPurchaseText(locationId, "inventory_location_invalid");
    if (typeof sharedStorage !== "boolean" || (sharedStorage && (!location || !location.endsWith(":USABLE")))) throw domainError("inventory_storage_policy_invalid", 422);
    // The shared store is the only writable location. Keep its durable movement
    // fingerprint readable by the currently deployed rollback release.
    const fingerprint = inventoryMovementFingerprint(movementType, ingredientId, inputQuantity, sharedStorage ? null : location);
    const createdAt = this.clock().toISOString();
    const requestedEffectiveAt = effectiveAt == null ? null : normalizeMovementEffectiveAt(effectiveAt, createdAt);
    const occurredAt = requestedEffectiveAt ?? createdAt;
    const replay = this.inventoryMovements.find((movement) => movement.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint || (requestedEffectiveAt != null && replay.occurredAt !== requestedEffectiveAt)) throw domainError("inventory_movement_idempotency_conflict", 409);
      return { movement: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    this.#assertMutation(expectedVersion, reason);
    const previous = this.inventoryBalances.get(ingredientId);
    if (!previous) throw domainError("inventory_cost_required", 409);
    if (location && movementType !== "CYCLE_COUNT") {
      const available = sharedStorage ? previous.quantityBase
        : inventoryLocationPosition(this.inventoryBalances, this.purchaseReceipts, this.inventoryMovements, ingredientId, location).quantityBase;
      if (available < inputQuantity) throw domainError("inventory_location_quantity_insufficient", 409);
    }
    const before = this.exportState();
    try {
      const next = applyInventoryMovementToBalance(previous, movementType, inputQuantity);
      this.inventoryBalances.set(ingredientId, { ingredientId, ...next.balance });
      const ingredient = this.ingredients.get(ingredientId);
      this.ingredients.set(ingredientId, { ...ingredient, costPerUnitRupiah: next.balance.averageCostPerBaseUnitRupiah, updatedAt: occurredAt });
      this.#assertGateIntegrity();
      const movement = {
        id: randomUUID(), idempotencyKey: key, fingerprint, movementType, ingredientId,
        ...(location ? { locationId: location } : {}),
        ...(sharedStorage ? { storagePolicyVersion: 1 } : {}),
        quantityInputBase: inputQuantity, quantityBeforeBase: previous.quantityBase,
        quantityDeltaBase: next.quantityDeltaBase, quantityAfterBase: next.balance.quantityBase,
        inventoryValueBeforeRupiah: previous.inventoryValueRupiah,
        inventoryValueDeltaRupiah: next.inventoryValueDeltaRupiah,
        inventoryValueAfterRupiah: next.balance.inventoryValueRupiah,
        unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah,
        occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
      };
      const event = this.#record("hpp.inventory.movement.recorded", actorId, reason, { movementId: movement.id, movementType, ingredientId, quantityDeltaBase: movement.quantityDeltaBase, inventoryValueDeltaRupiah: movement.inventoryValueDeltaRupiah });
      movement.version = event.version;
      this.inventoryMovements.push(movement);
      return { ...event, movement: structuredClone(movement), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  transferInventory({ idempotencyKey, ingredientId, quantityBase, sourceLocationId, destinationLocationId, effectiveAt, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    if (typeof ingredientId !== "string" || !this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    const quantity = exactMovementQuantity(quantityBase, false);
    const source = cleanPurchaseText(sourceLocationId, "inventory_transfer_source_invalid");
    const destination = cleanPurchaseText(destinationLocationId, "inventory_transfer_destination_invalid");
    if (source === destination) throw domainError("inventory_transfer_location_same", 422);
    const fingerprint = inventoryTransferFingerprint(ingredientId, quantity, source, destination);
    const createdAt = this.clock().toISOString();
    const requestedEffectiveAt = effectiveAt == null ? null : normalizeMovementEffectiveAt(effectiveAt, createdAt);
    const replay = this.inventoryMovements.find((movement) => movement.movementType === "TRANSFER_OUT" && movement.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint || (requestedEffectiveAt != null && replay.occurredAt !== requestedEffectiveAt)) throw domainError("inventory_movement_idempotency_conflict", 409);
      const pair = this.inventoryMovements.find((movement) => movement.transferId === replay.transferId && movement.movementType === "TRANSFER_IN");
      if (!pair) throw domainError("hpp_state_invalid", 500);
      return { transfer: { id: replay.transferId, outMovement: structuredClone(replay), inMovement: structuredClone(pair) }, idempotentReplay: true, version: this.version };
    }
    if (this.inventoryMovements.some((movement) => movement.idempotencyKey === key)) throw domainError("inventory_movement_idempotency_conflict", 409);
    const destinationKey = `${key.slice(0, 100)}-destination`;
    if (this.inventoryMovements.some((movement) => movement.idempotencyKey === destinationKey)) throw domainError("inventory_movement_idempotency_conflict", 409);
    this.#assertMutation(expectedVersion, reason);
    const previous = this.inventoryBalances.get(ingredientId);
    if (!previous) throw domainError("inventory_cost_required", 409);
    const position = inventoryLocationPosition(this.inventoryBalances, this.purchaseReceipts, this.inventoryMovements, ingredientId, source);
    if (position.quantityBase < quantity) throw domainError("inventory_location_quantity_insufficient", 409);
    const occurredAt = requestedEffectiveAt ?? createdAt;
    const transferId = randomUUID();
    const transferValue = quantity === position.quantityBase ? position.inventoryValueRupiah : Math.round(position.inventoryValueRupiah * quantity / position.quantityBase);
    const before = this.exportState();
    try {
      const afterOut = applyStoredInventoryMovementDelta(previous, -quantity, -transferValue).balance;
      const outMovement = {
        id: randomUUID(), idempotencyKey: key, fingerprint, movementType: "TRANSFER_OUT", transferId, ingredientId,
        quantityInputBase: quantity, quantityBeforeBase: previous.quantityBase, quantityDeltaBase: -quantity, quantityAfterBase: afterOut.quantityBase,
        inventoryValueBeforeRupiah: previous.inventoryValueRupiah, inventoryValueDeltaRupiah: -transferValue, inventoryValueAfterRupiah: afterOut.inventoryValueRupiah,
        unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah, locationId: source, sourceLocationId: source, destinationLocationId: destination, locationAuthorityVersion: 1,
        occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
      };
      const outEvent = this.#record("hpp.inventory.transfer.out", actorId, reason, { transferId, ingredientId, sourceLocationId: source, destinationLocationId: destination, quantityBase: quantity, inventoryValueRupiah: transferValue });
      outMovement.version = outEvent.version;
      this.inventoryMovements.push(outMovement);
      this.inventoryBalances.set(ingredientId, { ingredientId, ...afterOut });
      const afterIn = applyStoredInventoryMovementDelta(afterOut, quantity, transferValue).balance;
      const inMovement = {
        id: randomUUID(), idempotencyKey: destinationKey, fingerprint, movementType: "TRANSFER_IN", transferId, ingredientId,
        quantityInputBase: quantity, quantityBeforeBase: afterOut.quantityBase, quantityDeltaBase: quantity, quantityAfterBase: afterIn.quantityBase,
        inventoryValueBeforeRupiah: afterOut.inventoryValueRupiah, inventoryValueDeltaRupiah: transferValue, inventoryValueAfterRupiah: afterIn.inventoryValueRupiah,
        unitCostSnapshotRupiah: afterOut.averageCostPerBaseUnitRupiah, locationId: destination, sourceLocationId: source, destinationLocationId: destination, locationAuthorityVersion: 1,
        occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
      };
      const inEvent = this.#record("hpp.inventory.transfer.in", actorId, reason, { transferId, ingredientId, sourceLocationId: source, destinationLocationId: destination, quantityBase: quantity, inventoryValueRupiah: transferValue });
      inMovement.version = inEvent.version;
      this.inventoryMovements.push(inMovement);
      this.inventoryBalances.set(ingredientId, { ingredientId, ...afterIn });
      this.#assertGateIntegrity();
      return { transfer: { id: transferId, outMovement: structuredClone(outMovement), inMovement: structuredClone(inMovement) }, idempotentReplay: false, version: this.version };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  postProductionExecution({ executionId, productionOrderId, sourceOperationKey, inputLocationId, outputLocationId, inputs, output, loss, completedAt, expectedVersion, actorId, reason } = {}) {
    const normalizedExecutionId = cleanPurchaseText(executionId, "production_execution_id_invalid");
    const normalizedOrderId = cleanPurchaseText(productionOrderId, "production_order_id_invalid");
    const normalizedOperationKey = cleanIdempotencyKey(sourceOperationKey);
    const normalizedInputLocationId = cleanPurchaseText(inputLocationId, "production_input_location_invalid");
    const normalizedOutputLocationId = cleanPurchaseText(outputLocationId, "production_output_location_invalid");
    const createdAt = this.clock().toISOString();
    const occurredAt = normalizeMovementEffectiveAt(completedAt, createdAt);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw domainError("production_inputs_invalid", 422);
    const seen = new Set();
    const normalizedInputs = inputs.map((line) => {
      const ingredientId = cleanPurchaseText(line?.itemId, "production_input_item_invalid");
      if (!this.ingredients.has(ingredientId) || seen.has(ingredientId)) throw domainError("production_input_item_invalid", 422);
      seen.add(ingredientId);
      const quantityBase = exactProductionQuantity(line.normalizedQuantity, "production_input_quantity_invalid");
      const inventoryValueRupiah = Number(line.inventoryValueRupiah);
      if (!validRupiah(inventoryValueRupiah)) throw domainError("production_input_value_invalid", 422);
      if (!Array.isArray(line.allocations) || !line.allocations.length) throw domainError("production_input_allocation_invalid", 422);
      return { ingredientId, quantityBase, inventoryValueRupiah, allocations: structuredClone(line.allocations) };
    }).sort((left, right) => left.ingredientId.localeCompare(right.ingredientId));
    const outputIngredientId = cleanPurchaseText(output?.itemId, "production_output_item_invalid");
    const outputIngredient = this.ingredients.get(outputIngredientId);
    if (!outputIngredient) throw domainError("production_output_item_invalid", 422);
    const outputQuantityBase = exactProductionQuantity(output?.usableQuantity, "production_output_quantity_invalid");
    const outputValueRupiah = Number(output?.totalValueRupiah);
    const outputLot = normalizeProductionOutputLot(output, outputIngredient, outputQuantityBase, occurredAt, createdAt);
    const productionLoss = normalizeProductionLossAuthority(loss);
    const inputValueRupiah = normalizedInputs.reduce((sum, line) => safeRupiah(sum + line.inventoryValueRupiah), 0);
    if (!validRupiah(outputValueRupiah) || inputValueRupiah !== safeRupiah(outputValueRupiah + productionLoss.abnormalValueRupiah)) throw domainError("production_value_unbalanced", 422);
    if (productionAbnormalLossValue(inputValueRupiah, outputQuantityBase, productionLoss.abnormalQuantityBase) !== productionLoss.abnormalValueRupiah) throw domainError("production_abnormal_loss_authority_mismatch", 409);
    const postingFingerprint = productionPostingFingerprint({
      executionId: normalizedExecutionId, productionOrderId: normalizedOrderId, sourceOperationKey: normalizedOperationKey,
      inputLocationId: normalizedInputLocationId, outputLocationId: normalizedOutputLocationId,
      inputs: normalizedInputs, output: { ingredientId: outputIngredientId, quantityBase: outputQuantityBase, inventoryValueRupiah: outputValueRupiah, ...(outputLot ? { outputLot } : {}) },
      loss: productionLoss, completedAt: occurredAt,
    });
    const replay = this.inventoryMovements.filter((movement) => movement.sourceType === "PRODUCTION_EXECUTION"
      && (movement.sourceId === normalizedExecutionId || movement.referenceCode === normalizedOperationKey));
    if (replay.length) {
      if (replay.length !== normalizedInputs.length + 1 || replay.some((movement) => movement.sourceId !== normalizedExecutionId || movement.referenceId !== normalizedOrderId || movement.postingFingerprint !== postingFingerprint)) throw domainError("production_posting_idempotency_conflict", 409);
      return { idempotentReplay: true, movements: structuredClone(replay), version: this.version };
    }
    this.#assertInventoryPeriodOpen(occurredAt);
    if (outputLot && this.inventoryMovements.some((movement) => movement.movementType === "PRODUCTION_OUTPUT" && movement.ingredientId === outputIngredientId && movement.outputLot?.lotId === outputLot.lotId)) throw domainError("production_output_lot_conflict", 409);
    const projectedQuantities = new Map([...this.inventoryBalances].map(([ingredientId, balance]) => [ingredientId, balance.quantityBase]));
    for (const line of normalizedInputs) {
      const before = projectedQuantities.get(line.ingredientId) ?? 0;
      const committedQuantity = productionBalanceAfter(line.quantityBase, this.#reservedQuantityBase(line.ingredientId));
      if (before < committedQuantity) throw domainError("production_reserved_stock_conflict", 409);
      projectedQuantities.set(line.ingredientId, productionBalanceAfter(before, -line.quantityBase));
    }
    projectedQuantities.set(outputIngredientId, productionBalanceAfter(projectedQuantities.get(outputIngredientId) ?? 0, outputQuantityBase));
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    try {
      const movements = [];
      for (const [index, line] of normalizedInputs.entries()) {
        movements.push(this.#appendProductionMovement({
          movementType: "PRODUCTION_INPUT", ingredientId: line.ingredientId, quantityBase: line.quantityBase,
          inventoryValueRupiah: line.inventoryValueRupiah, locationId: normalizedInputLocationId,
          executionId: normalizedExecutionId, productionOrderId: normalizedOrderId, sourceOperationKey: normalizedOperationKey,
          sourceLineId: `input:${index}:${line.ingredientId}`, postingFingerprint, allocations: line.allocations,
          productionLoss, occurredAt, actorId, reason,
        }));
      }
      movements.push(this.#appendProductionMovement({
        movementType: "PRODUCTION_OUTPUT", ingredientId: outputIngredientId, quantityBase: outputQuantityBase,
        inventoryValueRupiah: outputValueRupiah, locationId: normalizedOutputLocationId,
        executionId: normalizedExecutionId, productionOrderId: normalizedOrderId, sourceOperationKey: normalizedOperationKey,
        sourceLineId: `output:${outputIngredientId}`, postingFingerprint, allocations: [], outputLot, occurredAt, actorId, reason,
        productionLoss,
      }));
      this.#assertGateIntegrity();
      return { idempotentReplay: false, movements: structuredClone(movements), version: this.version };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  voidProductionExecution({ operationKey, idempotencyKey, executionId, effectiveAt, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(operationKey ?? idempotencyKey);
    const replayEffectiveAt = effectiveAt == null || !validIsoTimestamp(effectiveAt) ? effectiveAt : new Date(effectiveAt).toISOString();
    const replay = this.audit.find((event) => event.type === "hpp.production.voided" && event.operationKey === key);
    if (replay) {
      if (replay.executionId !== executionId || (replayEffectiveAt != null && replay.productionVoid?.effectiveAt !== replayEffectiveAt)) throw domainError("production_void_idempotency_conflict", 409);
      return { ...structuredClone(replay), productionVoid: structuredClone(replay.productionVoid), reversedMovements: this.inventoryMovements.filter((item) => replay.productionVoid?.movementIds?.includes(item.reversalOfMovementId)), idempotentReplay: true };
    }
    this.#assertMutation(expectedVersion, reason);
    const originals = this.inventoryMovements.filter((movement) => movement.sourceType === "PRODUCTION_EXECUTION" && movement.sourceId === executionId && ["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"].includes(movement.movementType));
    if (originals.length < 2 || originals.filter((item) => item.movementType === "PRODUCTION_OUTPUT").length !== 1 || originals.some((item) => this.inventoryMovements.some((candidate) => candidate.reversalOfMovementId === item.id))) throw domainError("production_execution_not_reversible", 409);
    const output = originals.find((item) => item.movementType === "PRODUCTION_OUTPUT");
    const downstream = this.inventoryMovements.some((movement) => movement.version > output.version && movement.ingredientId === output.ingredientId
      && movement.quantityDeltaBase < 0 && movement.reversalOfMovementId !== output.id);
    if (downstream) throw domainError("production_void_downstream_dependency", 409);
    if (this.#reservedQuantityBase(output.ingredientId) > 0) throw domainError("production_void_active_reservation", 409);
    const createdAt = this.clock().toISOString();
    const reversalAt = effectiveAt == null ? createdAt : normalizeMovementEffectiveAt(effectiveAt, createdAt);
    const latestOriginalAt = originals.reduce((latest, movement) => movement.occurredAt > latest ? movement.occurredAt : latest, originals[0].occurredAt);
    if (reversalAt < latestOriginalAt) throw domainError("inventory_reversal_precedes_original", 409);
    this.#assertInventoryPeriodOpen(reversalAt);
    const before = this.exportState();
    try {
      const productionVoid = {
        id: `production-void:${createHash("sha256").update(key).digest("hex")}`,
        operationKey: key, executionId, productionOrderId: output.referenceId,
        movementIds: originals.map((item) => item.id), effectiveAt: reversalAt,
      };
      const reversedMovements = [];
      const order = [output, ...originals.filter((item) => item.movementType === "PRODUCTION_INPUT")];
      for (const [index, movement] of order.entries()) {
        const reversal = this.reverseInventoryMovement({
          idempotencyKey: `prodvoid:${createHash("sha256").update(`${key}\u0000${movement.id}`).digest("hex")}`,
          movementId: movement.id, effectiveAt: reversalAt, expectedVersion: this.version, actorId, reason, [PRODUCTION_BUNDLE_REVERSAL]: true,
        });
        const storedReversal = this.inventoryMovements.find((item) => item.id === reversal.movement.id);
        if (storedReversal) storedReversal.productionVoidId = productionVoid.id;
        reversal.movement.productionVoidId = productionVoid.id;
        reversedMovements.push(reversal.movement);
        if (index === 0 && reversedMovements.length !== 1) throw domainError("production_void_atomicity_invalid", 500);
      }
      const event = this.#record("hpp.production.voided", actorId, reason, { operationKey: key, executionId, productionOrderId: output.referenceId, movementIds: productionVoid.movementIds, productionVoid });
      return { ...event, productionVoid: structuredClone(productionVoid), reversedMovements: structuredClone(reversedMovements), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  correctProductionExecution({ operationKey, executionId, replacement, effectiveAt, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(operationKey);
    const replay = this.audit.find((event) => event.type === "hpp.production.corrected" && event.operationKey === key);
    const replacementExecutionId = replacement?.executionId;
    if (replay) {
      if (replay.executionId !== executionId || replay.replacementExecutionId !== replacementExecutionId) throw domainError("production_correction_idempotency_conflict", 409);
      return { ...structuredClone(replay), idempotentReplay: true };
    }
    if (!replacement || typeof replacement !== "object" || replacement.executionId === executionId) throw domainError("production_correction_replacement_invalid", 422);
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    try {
      const voided = this.voidProductionExecution({ operationKey: `prodvoid:${createHash("sha256").update(key).digest("hex")}`, executionId, effectiveAt, expectedVersion: this.version, actorId, reason });
      const posted = this.postProductionExecution({ ...replacement, expectedVersion: this.version, actorId, reason });
      const event = this.#record("hpp.production.corrected", actorId, reason, { operationKey: key, executionId, replacementExecutionId: replacement.executionId, reversedMovementIds: voided.reversedMovements.map((item) => item.id), replacementMovementIds: posted.movements.map((item) => item.id) });
      return { ...event, voided, replacement: posted, idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  #appendProductionMovement({ movementType, ingredientId, quantityBase, inventoryValueRupiah, locationId, executionId, productionOrderId, sourceOperationKey, sourceLineId, postingFingerprint, allocations, outputLot = null, productionLoss, occurredAt, actorId, reason }) {
    const previous = this.inventoryBalances.get(ingredientId) ?? { ingredientId, quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 };
    if (movementType === "PRODUCTION_INPUT" && (previous.quantityBase < quantityBase || previous.inventoryValueRupiah < inventoryValueRupiah)) throw domainError("production_stock_shortage", 409);
    const direction = movementType === "PRODUCTION_INPUT" ? -1 : 1;
    const quantityAfterBase = productionBalanceAfter(previous.quantityBase, direction * quantityBase);
    const inventoryValueAfterRupiah = safeRupiah(previous.inventoryValueRupiah + direction * inventoryValueRupiah);
    if (!validProductionBalanceQuantity(quantityAfterBase) || inventoryValueAfterRupiah < 0 || (quantityAfterBase === 0 && inventoryValueAfterRupiah !== 0)) throw domainError("production_inventory_balance_invalid", 409);
    const averageCostPerBaseUnitRupiah = quantityAfterBase === 0 ? previous.averageCostPerBaseUnitRupiah : roundedUnitCost(inventoryValueAfterRupiah / quantityAfterBase);
    if (!validUnitCost(averageCostPerBaseUnitRupiah)) throw domainError("production_inventory_cost_invalid", 422);
    const movement = {
      id: randomUUID(), idempotencyKey: `production:${createHash("sha256").update(`${executionId}\u0000${sourceLineId}`).digest("hex")}`,
      movementType, ingredientId, quantityInputBase: quantityBase,
      quantityBeforeBase: previous.quantityBase, quantityDeltaBase: direction * quantityBase, quantityAfterBase,
      inventoryValueBeforeRupiah: previous.inventoryValueRupiah, inventoryValueDeltaRupiah: direction * inventoryValueRupiah,
      inventoryValueAfterRupiah, unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah,
      sourceType: "PRODUCTION_EXECUTION", sourceId: executionId, sourceLineId, locationId,
      referenceType: "production", referenceId: productionOrderId, referenceCode: sourceOperationKey,
      postingFingerprint, allocations, occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
      productionLoss: structuredClone(productionLoss),
      ...(outputLot ? { outputLot: structuredClone(outputLot) } : {}),
    };
    movement.fingerprint = productionMovementFingerprint(movement);
    const event = this.#record(`hpp.inventory.${movementType.toLowerCase()}`, actorId, reason, { executionId, productionOrderId, movementId: movement.id, ingredientId, quantityBase, inventoryValueRupiah });
    movement.version = event.version;
    this.inventoryMovements.push(movement);
    this.inventoryBalances.set(ingredientId, { ingredientId, quantityBase: quantityAfterBase, inventoryValueRupiah: inventoryValueAfterRupiah, averageCostPerBaseUnitRupiah });
    const ingredient = this.ingredients.get(ingredientId);
    this.ingredients.set(ingredientId, { ...ingredient, costPerUnitRupiah: averageCostPerBaseUnitRupiah, updatedAt: occurredAt });
    return movement;
  }

  reverseInventoryMovement({ idempotencyKey, movementId, effectiveAt, expectedVersion, actorId, reason, [PRODUCTION_BUNDLE_REVERSAL]: productionBundleReversal = false } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const original = this.inventoryMovements.find((movement) => movement.id === movementId);
    if (!original || ["REVERSAL", "TRANSFER_OUT", "TRANSFER_IN"].includes(original.movementType)) throw domainError("inventory_movement_reversal_source_invalid", 404);
    if (original.sourceType === "PRODUCTION_EXECUTION" && productionBundleReversal !== true) throw domainError("production_requires_aggregate_reversal", 409);
    if (original.quantityDeltaBase === 0 && original.inventoryValueDeltaRupiah === 0) throw domainError("inventory_movement_not_reversible", 409);
    const createdAt = this.clock().toISOString();
    const requestedEffectiveAt = effectiveAt == null ? null : normalizeMovementEffectiveAt(effectiveAt, createdAt);
    const replay = this.inventoryMovements.find((movement) => movement.idempotencyKey === key);
    if (replay) {
      const replayFingerprint = inventoryReversalFingerprint(original.id, original.ingredientId, requestedEffectiveAt ?? replay.occurredAt);
      if (replay.fingerprint !== replayFingerprint || (requestedEffectiveAt != null && replay.occurredAt !== requestedEffectiveAt)) throw domainError("inventory_movement_idempotency_conflict", 409);
      return { movement: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    const occurredAt = requestedEffectiveAt ?? createdAt;
    if (occurredAt < original.occurredAt) throw domainError("inventory_reversal_precedes_original", 409);
    this.#assertInventoryPeriodOpen(occurredAt);
    const fingerprint = inventoryReversalFingerprint(original.id, original.ingredientId, occurredAt);
    if (this.inventoryMovements.some((movement) => movement.reversalOfMovementId === original.id)) throw domainError("inventory_movement_already_reversed", 409);
    this.#assertMutation(expectedVersion, reason);
    const previous = this.inventoryBalances.get(original.ingredientId);
    if (!previous) throw domainError("inventory_cost_required", 409);
    const before = this.exportState();
    try {
      const quantityDeltaBase = -original.quantityDeltaBase;
      const inventoryValueDeltaRupiah = -original.inventoryValueDeltaRupiah;
      const quantityAfterBase = original.sourceType === "PRODUCTION_EXECUTION"
        ? productionBalanceAfter(previous.quantityBase, quantityDeltaBase)
        : roundedQuantity(previous.quantityBase + quantityDeltaBase);
      const inventoryValueAfterRupiah = previous.inventoryValueRupiah + inventoryValueDeltaRupiah;
      if (!(original.sourceType === "PRODUCTION_EXECUTION" ? validProductionBalanceQuantity(quantityAfterBase) : validBalanceQuantity(quantityAfterBase)) || !Number.isSafeInteger(inventoryValueAfterRupiah) || inventoryValueAfterRupiah < 0
        || (quantityAfterBase === 0) !== (inventoryValueAfterRupiah === 0)) throw domainError("inventory_movement_reversal_balance_invalid", 409);
      const averageCostPerBaseUnitRupiah = quantityAfterBase === 0
        ? previous.averageCostPerBaseUnitRupiah : roundedUnitCost(inventoryValueAfterRupiah / quantityAfterBase);
      if (!validUnitCost(averageCostPerBaseUnitRupiah)) throw domainError("inventory_movement_reversal_balance_invalid", 409);
      const movement = {
        id: randomUUID(), idempotencyKey: key, fingerprint, movementType: "REVERSAL",
        reversalOfMovementId: original.id, ingredientId: original.ingredientId,
        ...(original.locationId ? { locationId: original.locationId } : {}),
        quantityInputBase: Math.abs(quantityDeltaBase), quantityBeforeBase: previous.quantityBase,
        quantityDeltaBase, quantityAfterBase, inventoryValueBeforeRupiah: previous.inventoryValueRupiah,
        inventoryValueDeltaRupiah, inventoryValueAfterRupiah,
        unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah,
        referenceType: "inventory_movement", referenceId: original.id, referenceCode: original.idempotencyKey,
        occurredAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
      };
      this.inventoryBalances.set(original.ingredientId, { ingredientId: original.ingredientId, quantityBase: quantityAfterBase, inventoryValueRupiah: inventoryValueAfterRupiah, averageCostPerBaseUnitRupiah });
      const ingredient = this.ingredients.get(original.ingredientId);
      this.ingredients.set(original.ingredientId, { ...ingredient, costPerUnitRupiah: averageCostPerBaseUnitRupiah, updatedAt: createdAt });
      const event = this.#record("hpp.inventory.movement.reversed", actorId, reason, { movementId: movement.id, reversalOfMovementId: original.id, ingredientId: original.ingredientId, quantityDeltaBase, inventoryValueDeltaRupiah });
      movement.version = event.version;
      this.inventoryMovements.push(movement);
      this.#assertGateIntegrity();
      return { ...event, movement: structuredClone(movement), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  reserveOrderInventory({ orderId, orderNumber, items, reservedAt, actorId = "SYSTEM_CHECKOUT", allowShortage = false } = {}) {
    const normalizedOrderId = cleanReference(orderId, "inventory_reservation_order_id_invalid");
    const normalizedOrderNumber = cleanReference(orderNumber, "inventory_reservation_order_number_invalid");
    if (!validIsoTimestamp(reservedAt) || !validStoredText(actorId, 80) || typeof allowShortage !== "boolean"
      || !Array.isArray(items) || !items.length || items.length > 100) throw domainError("inventory_reservation_input_invalid", 422);
    const normalizedItems = items.map((item) => normalizeSaleItem(item));
    const fingerprint = inventoryReservationFingerprint(normalizedOrderId, normalizedOrderNumber, normalizedItems);
    const replay = this.inventoryReservations.find((item) => item.orderId === normalizedOrderId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("inventory_reservation_idempotency_conflict", 409);
      return { reservation: structuredClone(replay), idempotentReplay: true, version: this.version };
    }

    const requiredByIngredient = new Map();
    let unmappedItemCount = 0;
    for (const item of normalizedItems) {
      if (item.hppSnapshotStatus !== "VERIFIED" || !item.recipeLines.length) {
        unmappedItemCount += 1;
        continue;
      }
      for (const line of item.recipeLines) {
        const required = roundedQuantity((requiredByIngredient.get(line.ingredientId) ?? 0) + line.qty * item.qty);
        if (!validMovementQuantity(required, false)) throw domainError("inventory_reservation_input_invalid", 422);
        requiredByIngredient.set(line.ingredientId, required);
      }
    }
    if (requiredByIngredient.size === 0) {
      return {
        reservation: {
          id: null, orderId: normalizedOrderId, orderNumber: normalizedOrderNumber, fingerprint, status: "UNMAPPED",
          reservedAt, actorId, itemCount: normalizedItems.length, unmappedItemCount, lineCount: 0, lines: [], items: normalizedItems,
        },
        idempotentReplay: false,
        version: this.version,
      };
    }

    const lines = [...requiredByIngredient.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([ingredientId, quantityReservedBase]) => {
      const balance = this.inventoryBalances.get(ingredientId);
      if (!balance) throw domainError("inventory_balance_not_found", 409);
      const availableBeforeBase = roundedQuantity(balance.quantityBase - this.#reservedQuantityBase(ingredientId));
      if (!allowShortage && availableBeforeBase < quantityReservedBase) throw domainError("inventory_quantity_insufficient", 409);
      return { ingredientId, quantityReservedBase, availableBeforeBase, availableAfterBase: roundedQuantity(availableBeforeBase - quantityReservedBase) };
    });

    const before = this.exportState();
    try {
      const event = this.#record("hpp.inventory.reservation.created", actorId, "Reservasi stok saat checkout", {
        orderId: normalizedOrderId, lineCount: lines.length,
      });
      const reservation = {
        id: randomUUID(), orderId: normalizedOrderId, orderNumber: normalizedOrderNumber, fingerprint, status: "ACTIVE",
        reservedAt, actorId, itemCount: normalizedItems.length, unmappedItemCount, lineCount: lines.length,
        lines, items: normalizedItems, requiresReview: lines.some((line) => line.availableAfterBase < 0), version: event.version,
      };
      this.inventoryReservations.push(reservation);
      return { ...event, reservation: structuredClone(reservation), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  releaseOrderInventory({ orderId, releasedAt, reason, actorId = "SYSTEM_REFUND" } = {}) {
    const normalizedOrderId = cleanReference(orderId, "inventory_reservation_order_id_invalid");
    if (!validIsoTimestamp(releasedAt) || !validStoredText(actorId, 80) || !validStoredText(reason, 160)) throw domainError("inventory_reservation_release_invalid", 422);
    const reservation = this.inventoryReservations.find((item) => item.orderId === normalizedOrderId);
    if (!reservation) return { reservation: null, released: false, idempotentReplay: true, version: this.version };
    if (reservation.status === "CONSUMED") {
      return { reservation: structuredClone(reservation), released: false, inventoryAlreadyConsumed: true, idempotentReplay: true, version: this.version };
    }
    if (reservation.status === "RELEASED") {
      return { reservation: structuredClone(reservation), released: true, idempotentReplay: true, version: this.version };
    }
    const before = this.exportState();
    try {
      const event = this.#record("hpp.inventory.reservation.released", actorId, reason, { reservationId: reservation.id, orderId: normalizedOrderId });
      reservation.status = "RELEASED";
      reservation.releasedAt = releasedAt;
      reservation.releaseReason = reason;
      reservation.releasedBy = actorId;
      reservation.statusVersion = event.version;
      return { ...event, reservation: structuredClone(reservation), released: true, idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  consumePaidOrder({ orderId, orderNumber, items, paidAt, actorId = "SYSTEM_PAYMENT" } = {}) {
    return this.#consumeOrderInventory({
      orderId, orderNumber, items, paidAt, occurredAt: paidAt,
      trigger: "PAYMENT_PAID_LEGACY", actorId,
    });
  }

  consumePreparingOrder(input = {}) {
    const {
      orderId, orderNumber, items, paidAt, preparingAt, actorId = "SYSTEM_FULFILLMENT",
      productionStartId, idempotencyKey, consumptionReason, remakeId = null, reason, offlineEvent,
    } = input;
    if (offlineEvent !== undefined) assertOfflineConsumptionInputKeys(input);
    return this.#consumeOrderInventory({
      orderId, orderNumber, items, paidAt, occurredAt: preparingAt,
      trigger: "PREPARING", actorId, productionStartId, productionStartIdempotencyKey: idempotencyKey,
      consumptionReason, remakeId, productionStartReason: reason, offlineEvent,
    });
  }

  #consumeOrderInventory({
    orderId, orderNumber, items, paidAt, occurredAt, trigger, actorId, productionStartId,
    productionStartIdempotencyKey, consumptionReason, remakeId = null, productionStartReason, offlineEvent,
  } = {}) {
    const normalizedOrderId = cleanReference(orderId, "sale_order_id_invalid");
    const normalizedOrderNumber = cleanReference(orderNumber, "sale_order_number_invalid");
    if (!validIsoTimestamp(paidAt) || !validIsoTimestamp(occurredAt) || new Date(occurredAt) < new Date(paidAt)
      || !["PAYMENT_PAID_LEGACY", "PREPARING"].includes(trigger) || !validStoredText(actorId, 80)
      || !Array.isArray(items) || !items.length || items.length > 100) throw domainError("sale_consumption_input_invalid", 422);
    const normalizedItems = items.map((item) => normalizeSaleItem(item));
    const fingerprint = saleConsumptionFingerprint(normalizedOrderId, normalizedOrderNumber, paidAt, occurredAt, trigger, normalizedItems);
    const productionContext = normalizeProductionStartContext({
      productionStartId, idempotencyKey: productionStartIdempotencyKey, consumptionReason, remakeId,
      reason: productionStartReason, fingerprint, orderId: normalizedOrderId,
    });
    const sourceEvent = offlineEvent === undefined ? null : normalizeOfflineEvent(offlineEvent);
    if (sourceEvent) validateOfflineConsumptionCommand({ sourceEvent, productionContext, orderId: normalizedOrderId, paidAt, occurredAt, actorId, currentVersion: this.version });
    const sourceEventFingerprint = sourceEvent
      ? offlineEventFingerprint({ sourceEvent, orderId: normalizedOrderId, orderNumber: normalizedOrderNumber, fingerprint, productionStartFingerprint: productionContext.fingerprint })
      : null;
    const sourceReplay = sourceEvent ? this.saleConsumptions.find((item) => item.sourceEvent?.eventId === sourceEvent.eventId
      || item.sourceEvent?.deviceId === sourceEvent.deviceId && item.sourceEvent?.localSequence === sourceEvent.localSequence) : null;
    if (sourceReplay) {
      if (sourceReplay.sourceEventFingerprint !== sourceEventFingerprint) throw domainError("offline_event_idempotency_conflict", 409);
      return { consumption: structuredClone(sourceReplay), idempotentReplay: true, version: this.version };
    }
    const replay = this.saleConsumptions.find((item) => item.productionStartId === productionContext.id
      || item.productionStartIdempotencyKey === productionContext.idempotencyKey
      || (productionContext.remakeId !== null && item.remakeId === productionContext.remakeId));
    if (replay) {
      if (trigger === "PREPARING" && replay.trigger === "PAYMENT_PAID_LEGACY") {
        return { consumption: structuredClone(replay), idempotentReplay: true, legacyPriorConsumption: true, version: this.version };
      }
      if (replay.fingerprint !== fingerprint || replay.productionStartFingerprint !== productionContext.fingerprint
        || sourceEvent && replay.sourceEventFingerprint !== sourceEventFingerprint) {
        throw domainError(sourceEvent ? "offline_event_idempotency_conflict"
          : productionContext.reason === "ORIGINAL" ? "sale_consumption_idempotency_conflict" : "production_start_idempotency_conflict", 409);
      }
      return { consumption: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    const preparingReservation = trigger === "PREPARING" && productionContext.implicitOriginal
      ? this.inventoryReservations.find((item) => item.orderId === normalizedOrderId)
      : null;
    if (preparingReservation?.status === "RELEASED") throw domainError("inventory_reservation_released", 409);
    if (preparingReservation?.status === "CONSUMED") throw domainError("inventory_reservation_state_conflict", 409);
    if (preparingReservation?.status === "ACTIVE"
      && preparingReservation.fingerprint !== inventoryReservationFingerprint(normalizedOrderId, normalizedOrderNumber, normalizedItems)) {
      throw domainError("inventory_reservation_idempotency_conflict", 409);
    }

    const before = this.exportState();
    try {
      const requiredByIngredient = new Map();
      let unmappedItemCount = preparingReservation?.unmappedItemCount ?? 0;
      if (preparingReservation?.status === "ACTIVE") {
        for (const line of preparingReservation.lines) requiredByIngredient.set(line.ingredientId, line.quantityReservedBase);
      } else {
        for (const item of normalizedItems) {
          if (!item.recipeLines.length) {
            unmappedItemCount += 1;
            continue;
          }
          if (item.hppSnapshotStatus !== "VERIFIED") unmappedItemCount += 1;
          for (const line of item.recipeLines) {
            const required = roundedQuantity((requiredByIngredient.get(line.ingredientId) ?? 0) + line.qty * item.qty);
            if (!validMovementQuantity(required, false)) throw domainError("sale_consumption_input_invalid", 422);
            requiredByIngredient.set(line.ingredientId, required);
          }
        }
      }
      if (requiredByIngredient.size === 0 && !sourceEvent) {
        return {
          consumption: {
            id: null, orderId: normalizedOrderId, orderNumber: normalizedOrderNumber, fingerprint,
            status: "UNMAPPED", trigger, paidAt, occurredAt, actorId, itemCount: normalizedItems.length,
            unmappedItemCount, lineCount: 0, lines: [], items: normalizedItems, version: this.version,
            productionStartId: productionContext.id,
            productionStartIdempotencyKey: productionContext.idempotencyKey,
            consumptionReason: productionContext.reason,
            remakeId: productionContext.remakeId,
            productionStartReason: productionContext.startReason,
            productionStartFingerprint: productionContext.fingerprint,
            sourceEvent,
            requiresReview: false,
            ...(sourceEvent ? { sourceEventFingerprint } : {}),
          },
          idempotentReplay: false,
          version: this.version,
        };
      }

      const consumptionId = randomUUID();
      const lines = [];
      const movementReason = sourceEvent ? "Pemakaian stok dari penjualan fisik offline"
        : trigger === "PREPARING" ? "Pemakaian stok otomatis saat pesanan mulai disiapkan"
          : "Pemakaian stok otomatis dari kebijakan lama saat pembayaran";
      for (const [index, [ingredientId, quantityRequiredBase]] of [...requiredByIngredient.entries()].sort(([a], [b]) => a.localeCompare(b)).entries()) {
        const previous = this.inventoryBalances.get(ingredientId);
        if (!previous) {
          lines.push({
            ingredientId,
            quantityRequiredBase,
            quantityAppliedBase: 0,
            shortageBase: 0,
            status: "UNMANAGED",
            movementId: null,
            appliedInventoryCostRupiah: 0,
            provisionalShortageUnitCostRupiah: null,
            provisionalShortageCostRupiah: 0,
            postedCogsRupiah: 0,
          });
          continue;
        }
        const quantityAppliedBase = Math.min(previous.quantityBase, quantityRequiredBase);
        const shortageBase = roundedQuantity(quantityRequiredBase - quantityAppliedBase);
        const provisionalShortage = calculateProvisionalShortageCost(shortageBase, previous.averageCostPerBaseUnitRupiah);
        const next = applySaleConsumptionToBalance(previous, quantityRequiredBase);
        this.inventoryBalances.set(ingredientId, { ingredientId, ...next.balance });
        const ingredient = this.ingredients.get(ingredientId);
        this.ingredients.set(ingredientId, { ...ingredient, costPerUnitRupiah: next.balance.averageCostPerBaseUnitRupiah, updatedAt: occurredAt });
        const movement = {
          id: randomUUID(), idempotencyKey: `sale:${consumptionId}:${index}`, movementType: "SALE_CONSUMPTION",
          ingredientId, quantityInputBase: quantityRequiredBase, quantityAppliedBase, shortageBase,
          quantityBeforeBase: previous.quantityBase, quantityDeltaBase: next.quantityDeltaBase, quantityAfterBase: next.balance.quantityBase,
          inventoryValueBeforeRupiah: previous.inventoryValueRupiah, inventoryValueDeltaRupiah: next.inventoryValueDeltaRupiah,
          inventoryValueAfterRupiah: next.balance.inventoryValueRupiah, unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah,
          referenceType: "order", referenceId: normalizedOrderId, referenceCode: normalizedOrderNumber,
          consumptionId, occurredAt, actorId, reason: movementReason,
        };
        movement.fingerprint = saleMovementFingerprint(movement);
        const event = this.#record("hpp.inventory.sale_consumed", actorId, movement.reason, { movementId: movement.id, orderId: normalizedOrderId, ingredientId, quantityRequiredBase, quantityAppliedBase, shortageBase });
        movement.version = event.version;
        this.inventoryMovements.push(movement);
        const appliedInventoryCostRupiah = -next.inventoryValueDeltaRupiah;
        const provisionalShortageUnitCostRupiah = provisionalShortage.unitCostRupiah;
        const provisionalShortageCostRupiah = provisionalShortage.costRupiah;
        const postedCogsRupiah = safeRupiah(appliedInventoryCostRupiah + provisionalShortageCostRupiah);
        lines.push({
          ingredientId,
          quantityRequiredBase,
          quantityAppliedBase,
          shortageBase,
          status: shortageBase > 0 ? "SHORTAGE" : "APPLIED",
          movementId: movement.id,
          appliedInventoryCostRupiah,
          provisionalShortageUnitCostRupiah,
          provisionalShortageCostRupiah,
          postedCogsRupiah,
        });
      }
      const status = lines.some((line) => line.status === "SHORTAGE") ? "SHORTAGE"
        : (unmappedItemCount > 0 || lines.some((line) => line.status === "UNMANAGED")) ? "PARTIAL"
          : lines.length ? "APPLIED" : "UNMAPPED";
      const event = this.#record(preparingReservation?.status === "ACTIVE" ? "hpp.inventory.reservation.consumed" : "hpp.sale.consumption.completed", actorId, movementReason, {
        consumptionId, reservationId: preparingReservation?.id ?? null, orderId: normalizedOrderId, status, trigger,
        sourceEventId: sourceEvent?.eventId ?? null, sourceDeviceId: sourceEvent?.deviceId ?? null,
        productionStartId: productionContext.id, consumptionReason: productionContext.reason, remakeId: productionContext.remakeId,
      });
      const consumption = {
        id: consumptionId, orderId: normalizedOrderId, orderNumber: normalizedOrderNumber, fingerprint,
        status, trigger, paidAt, occurredAt, actorId, itemCount: normalizedItems.length, unmappedItemCount,
        lineCount: lines.length, lines, items: normalizedItems, version: event.version,
        productionStartId: productionContext.id,
        productionStartIdempotencyKey: productionContext.idempotencyKey,
        consumptionReason: productionContext.reason,
        remakeId: productionContext.remakeId,
        productionStartReason: productionContext.startReason,
        productionStartFingerprint: productionContext.fingerprint,
        sourceEvent,
        requiresReview: status === "SHORTAGE",
        ...(sourceEvent ? { sourceEventFingerprint } : {}),
      };
      this.saleConsumptions.push(consumption);
      if (preparingReservation?.status === "ACTIVE") {
        preparingReservation.status = "CONSUMED";
        preparingReservation.consumedAt = occurredAt;
        preparingReservation.consumptionId = consumptionId;
        preparingReservation.statusVersion = event.version;
      }
      return { ...event, consumption: structuredClone(consumption), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  completeInventoryCount({ idempotencyKey, lines, countKind = "CYCLE", businessDate = null, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const openingBaseline = countKind === "OPENING_BASELINE";
    if (!openingBaseline && countKind !== "CYCLE") throw domainError("inventory_count_kind_invalid", 422);
    if (openingBaseline && !validBusinessDate(businessDate)) throw domainError("inventory_count_business_date_invalid", 422);
    if (!Array.isArray(lines) || !lines.length || lines.length > 500) throw domainError("inventory_count_lines_invalid", 422);
    const seen = new Set();
    const normalizedLines = lines.map((line) => {
      if (!line || typeof line.ingredientId !== "string" || !this.ingredients.has(line.ingredientId)) throw domainError("ingredient_not_found", 404);
      if (seen.has(line.ingredientId)) throw domainError("inventory_count_ingredient_duplicate", 422);
      seen.add(line.ingredientId);
      const existingBalance = this.inventoryBalances.get(line.ingredientId);
      const ingredient = this.ingredients.get(line.ingredientId);
      if (!existingBalance && !openingBaseline) throw domainError("inventory_cost_required", 409);
      const openingUnitCostRupiah = existingBalance ? existingBalance.averageCostPerBaseUnitRupiah : Number(line.unitCostPerBaseUnitRupiah ?? ingredient.costPerUnitRupiah);
      if (openingBaseline && (!Number.isFinite(openingUnitCostRupiah) || openingUnitCostRupiah <= 0 || !validUnitCost(openingUnitCostRupiah))) throw domainError("inventory_opening_cost_required", 422);
      return { ingredientId: line.ingredientId, quantityBase: exactMovementQuantity(line.quantityBase, true), ...(openingBaseline ? { openingUnitCostRupiah } : {}) };
    }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
    const managedIngredientIds = openingBaseline
      ? [...this.ingredients.values()].filter((item) => item.status !== "ARCHIVED").map((item) => item.id).sort((a, b) => a.localeCompare(b))
      : [...this.inventoryBalances.keys()].sort((a, b) => a.localeCompare(b));
    if (normalizedLines.length !== managedIngredientIds.length || normalizedLines.some((line, index) => line.ingredientId !== managedIngredientIds[index])) throw domainError("inventory_count_incomplete", 422);
    const fingerprint = inventoryCountFingerprint(normalizedLines, openingBaseline ? { countKind, businessDate } : undefined);
    const replay = this.inventoryCounts.find((count) => count.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("inventory_count_idempotency_conflict", 409);
      return { count: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    this.#assertMutation(expectedVersion, reason);
    const before = this.exportState();
    const completedAt = this.clock().toISOString();
    const countId = randomUUID();
    try {
      const countLines = [];
      for (const [index, line] of normalizedLines.entries()) {
        const previous = this.inventoryBalances.get(line.ingredientId) ?? {
          ingredientId: line.ingredientId,
          quantityBase: 0,
          inventoryValueRupiah: 0,
          averageCostPerBaseUnitRupiah: line.openingUnitCostRupiah,
        };
        const next = applyInventoryMovementToBalance(previous, "CYCLE_COUNT", line.quantityBase);
        this.inventoryBalances.set(line.ingredientId, { ingredientId: line.ingredientId, ...next.balance });
        const ingredient = this.ingredients.get(line.ingredientId);
        this.ingredients.set(line.ingredientId, { ...ingredient, costPerUnitRupiah: next.balance.averageCostPerBaseUnitRupiah, updatedAt: completedAt });
        const movement = {
          id: randomUUID(), idempotencyKey: `countline-${countId}-${index}`, fingerprint: inventoryMovementFingerprint("CYCLE_COUNT", line.ingredientId, line.quantityBase),
          movementType: "CYCLE_COUNT", countSessionId: countId, ingredientId: line.ingredientId,
          quantityInputBase: line.quantityBase, quantityBeforeBase: previous.quantityBase,
          quantityDeltaBase: next.quantityDeltaBase, quantityAfterBase: next.balance.quantityBase,
          inventoryValueBeforeRupiah: previous.inventoryValueRupiah,
          inventoryValueDeltaRupiah: next.inventoryValueDeltaRupiah,
          inventoryValueAfterRupiah: next.balance.inventoryValueRupiah,
          unitCostSnapshotRupiah: previous.averageCostPerBaseUnitRupiah,
          occurredAt: completedAt, actorId: String(actorId ?? "owner"), reason: reason.trim(),
          ...(openingBaseline ? { openingBaseline: true } : {}),
        };
        const event = this.#record("hpp.inventory.count.line.recorded", actorId, reason, { countSessionId: countId, movementId: movement.id, ingredientId: line.ingredientId, quantityDeltaBase: movement.quantityDeltaBase, inventoryValueDeltaRupiah: movement.inventoryValueDeltaRupiah });
        movement.version = event.version;
        this.inventoryMovements.push(movement);
        countLines.push({ ingredientId: line.ingredientId, quantityBeforeBase: previous.quantityBase, quantityAfterBase: line.quantityBase, quantityDeltaBase: next.quantityDeltaBase, inventoryValueDeltaRupiah: next.inventoryValueDeltaRupiah, movementId: movement.id });
      }
      this.#assertGateIntegrity();
      const event = this.#record("hpp.inventory.count.completed", actorId, reason, { countSessionId: countId, lineCount: countLines.length, ...(openingBaseline ? { countKind, businessDate } : {}) });
      const count = { id: countId, idempotencyKey: key, fingerprint, status: "COMPLETED", completedAt, actorId: String(actorId ?? "owner"), reason: reason.trim(), lineCount: countLines.length, lines: countLines, version: event.version,
        ...(openingBaseline ? { countKind, businessDate, ingredientIdsAtCount: managedIngredientIds } : {}) };
      this.inventoryCounts.push(count);
      return { ...event, count: structuredClone(count), idempotentReplay: false };
    } catch (error) {
      this.restoreState(before);
      throw error;
    }
  }

  closeInventoryPeriod({ idempotencyKey, openingCountId, closingCountId, expectedVersion, actorId, reason } = {}) {
    const key = cleanIdempotencyKey(idempotencyKey);
    const openingId = cleanReference(openingCountId, "inventory_period_count_id_invalid");
    const closingId = cleanReference(closingCountId, "inventory_period_count_id_invalid");
    const fingerprint = inventoryPeriodFingerprint(openingId, closingId);
    const replay = this.inventoryPeriods.find((period) => period.idempotencyKey === key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("inventory_period_idempotency_conflict", 409);
      return { period: structuredClone(replay), idempotentReplay: true, version: this.version };
    }
    this.#assertMutation(expectedVersion, reason);
    const opening = this.inventoryCounts.find((count) => count.id === openingId);
    const closing = this.inventoryCounts.find((count) => count.id === closingId);
    if (!opening || !closing) throw domainError("inventory_period_count_not_found", 404);
    if (opening.version >= closing.version || new Date(opening.completedAt) >= new Date(closing.completedAt)) throw domainError("inventory_period_order_invalid", 422);
    const openingCoverage = opening.lines.map((line) => line.ingredientId).sort();
    const closingCoverage = closing.lines.map((line) => line.ingredientId).sort();
    if (openingCoverage.length !== closingCoverage.length || openingCoverage.some((id, index) => id !== closingCoverage[index])) throw domainError("inventory_period_coverage_mismatch", 409);
    const latest = this.inventoryPeriods.at(-1);
    if (latest && latest.closingCountId !== opening.id) throw domainError("inventory_period_sequence_conflict", 409);
    if (this.inventoryPeriods.some((period) => period.closingCountId === closing.id)) throw domainError("inventory_period_already_closed", 409);
    const closedAt = this.clock().toISOString();
    if (new Date(closedAt) < new Date(closing.completedAt)) throw domainError("inventory_period_clock_invalid", 409);
    const event = this.#record("hpp.inventory.period.closed", actorId, reason, { openingCountId: opening.id, closingCountId: closing.id });
    const period = {
      id: randomUUID(), idempotencyKey: key, fingerprint, status: "CLOSED",
      openingCountId: opening.id, closingCountId: closing.id,
      periodStartAt: opening.completedAt, periodEndAt: closing.completedAt,
      openingVersion: opening.version, closingVersion: closing.version,
      closedAt, actorId: String(actorId ?? "owner"), reason: reason.trim(), version: event.version,
    };
    this.inventoryPeriods.push(period);
    return { ...event, period: structuredClone(period), idempotentReplay: false };
  }

  upsertRecipeLine({ productId, ingredientId, qty, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const product = this.#product(productId);
    if (!this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000 || Math.round(qty * 1000) !== qty * 1000) throw domainError("recipe_quantity_invalid", 422);
    const before = this.exportState();
    const existing = this.recipes.get(product.id);
    const items = structuredClone(existing?.items ?? []);
    const index = items.findIndex((item) => item.ingredientId === ingredientId);
    if (index >= 0) items[index] = { ingredientId, qty };
    else items.push({ ingredientId, qty });
    const next = { id: existing?.id ?? randomUUID(), productId: product.id, version: existing ? existing.version + 1 : 1, items, updatedAt: this.clock().toISOString() };
    this.recipes.set(product.id, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.recipe.line.upserted", actorId, reason, { productId, ingredientId, qty, recipeVersion: next.version }), recipe: structuredClone(next) };
  }

  upsertRecipeDraftLine({ productId, ingredientId, quantity, uom, yieldPct = 100, lineType = "INGREDIENT", expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const product = this.#product(productId);
    const ingredient = this.ingredients.get(ingredientId);
    if (!ingredient || ingredient.status === "ARCHIVED") throw domainError("ingredient_not_found", 404);
    const normalizedYieldPct = exactRecipeYieldPct(yieldPct);
    const normalizedLineType = String(lineType ?? "").toUpperCase();
    if (!["INGREDIENT", "PACKAGING"].includes(normalizedLineType)) throw domainError("recipe_line_type_invalid", 422);
    const normalized = this.normalizeIngredientQuantity({ ingredientId, quantity, uom, occurredAt: this.clock().toISOString() });
    const qty = roundedRecipeQuantity(normalized.normalizedQuantity, normalizedYieldPct);
    const existing = this.recipeDrafts.get(product.id);
    const latestPublished = this.publishedRecipes.filter((item) => item.productId === product.id).sort((a, b) => b.version - a.version)[0];
    const inheritedItems = existing?.items ?? latestPublished?.items?.map(({ ingredientId: inheritedIngredientId, quantity: inheritedQuantity, uom: inheritedUom, yieldPct: inheritedYieldPct, lineType: inheritedLineType, qty: inheritedQty, conversionSnapshot }) => ({
      ingredientId: inheritedIngredientId,
      quantity: inheritedQuantity,
      uom: inheritedUom,
      yieldPct: inheritedYieldPct,
      lineType: inheritedLineType,
      qty: inheritedQty,
      conversionSnapshot: structuredClone(conversionSnapshot ?? []),
    })) ?? (this.recipes.get(product.id)?.items ?? []).map((item) => ({
      ingredientId: item.ingredientId,
      quantity: item.qty,
      uom: this.ingredients.get(item.ingredientId)?.baseUnit,
      yieldPct: 100,
      lineType: "INGREDIENT",
      qty: item.qty,
      conversionSnapshot: [],
    }));
    const items = structuredClone(inheritedItems);
    const index = items.findIndex((item) => item.ingredientId === ingredientId);
    const line = {
      ingredientId,
      quantity: normalized.originalQuantity,
      uom: normalized.originalUom,
      yieldPct: normalizedYieldPct,
      lineType: normalizedLineType,
      qty,
      conversionSnapshot: normalized.conversionSnapshot,
    };
    if (index >= 0) items[index] = line;
    else items.push(line);
    const now = this.clock().toISOString();
    const draft = { id: existing?.id ?? randomUUID(), productId: product.id, version: (existing?.version ?? 0) + 1, items, createdAt: existing?.createdAt ?? now, updatedAt: now, actorId: String(actorId ?? "owner") };
    this.recipeDrafts.set(product.id, draft);
    this.optionalStateFieldPresence.recipeLifecycle = true;
    return { ...this.#record("hpp.recipe_draft.line.upserted", actorId, reason, { productId, ingredientId, draftVersion: draft.version }), draft: structuredClone(draft) };
  }

  upsertRecipeDraftLines({ productId, components, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const product = this.#product(productId);
    if (!Array.isArray(components) || components.length < 1 || components.length > 50) throw domainError("recipe_draft_components_invalid", 422);
    const ingredientIds = components.map((component) => component?.ingredientId);
    if (ingredientIds.some((ingredientId) => typeof ingredientId !== "string" || !ingredientId)
      || new Set(ingredientIds).size !== ingredientIds.length) throw domainError("recipe_draft_components_duplicate", 422);
    const occurredAt = this.clock().toISOString();
    const normalizedLines = components.map((component) => {
      const ingredient = this.ingredients.get(component.ingredientId);
      if (!ingredient || ingredient.status === "ARCHIVED") throw domainError("ingredient_not_found", 404);
      const yieldPct = exactRecipeYieldPct(component.yieldPct ?? 100);
      const lineType = String(component.lineType ?? "").toUpperCase();
      if (!["INGREDIENT", "PACKAGING"].includes(lineType)) throw domainError("recipe_line_type_invalid", 422);
      const normalized = this.normalizeIngredientQuantity({ ingredientId: component.ingredientId, quantity: component.quantity, uom: component.uom, occurredAt });
      return {
        ingredientId: component.ingredientId,
        quantity: normalized.originalQuantity,
        uom: normalized.originalUom,
        yieldPct,
        lineType,
        qty: roundedRecipeQuantity(normalized.normalizedQuantity, yieldPct),
        conversionSnapshot: normalized.conversionSnapshot,
      };
    });
    const existing = this.recipeDrafts.get(product.id);
    const latestPublished = this.publishedRecipes.filter((item) => item.productId === product.id).sort((a, b) => b.version - a.version)[0];
    const inheritedItems = existing?.items ?? latestPublished?.items?.map(({ ingredientId, quantity, uom, yieldPct, lineType, qty, conversionSnapshot }) => ({
      ingredientId, quantity, uom, yieldPct, lineType, qty, conversionSnapshot: structuredClone(conversionSnapshot ?? []),
    })) ?? (this.recipes.get(product.id)?.items ?? []).map((item) => ({
      ingredientId: item.ingredientId,
      quantity: item.qty,
      uom: this.ingredients.get(item.ingredientId)?.baseUnit,
      yieldPct: 100,
      lineType: "INGREDIENT",
      qty: item.qty,
      conversionSnapshot: [],
    }));
    const items = structuredClone(inheritedItems);
    for (const line of normalizedLines) {
      const index = items.findIndex((item) => item.ingredientId === line.ingredientId);
      if (index >= 0) items[index] = line;
      else items.push(line);
    }
    const draft = {
      id: existing?.id ?? randomUUID(), productId: product.id, version: (existing?.version ?? 0) + 1,
      items, createdAt: existing?.createdAt ?? occurredAt, updatedAt: occurredAt, actorId: String(actorId ?? "owner"),
    };
    this.recipeDrafts.set(product.id, draft);
    this.optionalStateFieldPresence.recipeLifecycle = true;
    return {
      ...this.#record("hpp.recipe_draft.lines.upserted", actorId, reason, { productId, ingredientIds, componentCount: normalizedLines.length, draftVersion: draft.version }),
      draft: structuredClone(draft),
    };
  }

  removeRecipeDraftLine({ productId, ingredientId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    this.#product(productId);
    const existing = this.recipeDrafts.get(productId);
    if (!existing?.items.some((item) => item.ingredientId === ingredientId)) throw domainError("recipe_draft_line_not_found", 404);
    const draft = { ...structuredClone(existing), version: existing.version + 1, items: existing.items.filter((item) => item.ingredientId !== ingredientId), updatedAt: this.clock().toISOString(), actorId: String(actorId ?? "owner") };
    this.recipeDrafts.set(productId, draft);
    this.optionalStateFieldPresence.recipeLifecycle = true;
    return { ...this.#record("hpp.recipe_draft.line.removed", actorId, reason, { productId, ingredientId, draftVersion: draft.version }), draft: structuredClone(draft) };
  }

  reorderRecipeDraftLines({ productId, ingredientIds, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    this.#product(productId);
    const existing = this.recipeDrafts.get(productId);
    if (!existing?.items.length) throw domainError("recipe_draft_empty", 422);
    if (!Array.isArray(ingredientIds) || ingredientIds.length !== existing.items.length
      || ingredientIds.some((id) => typeof id !== "string" || !id)
      || new Set(ingredientIds).size !== ingredientIds.length) throw domainError("recipe_draft_order_invalid", 422);
    const existingIds = existing.items.map((item) => item.ingredientId).sort();
    const requestedIds = ingredientIds.slice().sort();
    if (existingIds.some((id, index) => id !== requestedIds[index])) throw domainError("recipe_draft_order_invalid", 422);
    const itemById = new Map(existing.items.map((item) => [item.ingredientId, item]));
    const draft = {
      ...structuredClone(existing),
      version: existing.version + 1,
      items: ingredientIds.map((id) => structuredClone(itemById.get(id))),
      updatedAt: this.clock().toISOString(),
      actorId: String(actorId ?? "owner"),
    };
    this.recipeDrafts.set(productId, draft);
    this.optionalStateFieldPresence.recipeLifecycle = true;
    return { ...this.#record("hpp.recipe_draft.line.reordered", actorId, reason, { productId, ingredientIds, draftVersion: draft.version }), draft: structuredClone(draft) };
  }

  publishRecipeDraft({ productId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const product = this.#product(productId);
    const draft = this.recipeDrafts.get(product.id);
    if (!draft?.items.length) throw domainError("recipe_draft_empty", 422);
    const calculation = calculateRecipeCost({ product, recipe: draft, recipeItems: draft.items, ingredients: this.#costIngredients() });
    if (!calculation.complete) {
      const error = domainError("recipe_draft_not_publishable", 409);
      error.details = { missingIngredientIds: calculation.missingIngredientIds, missingCostIngredientIds: calculation.missingCostIngredientIds };
      throw error;
    }
    const currentRecipe = this.recipes.get(product.id);
    const operationalRecipe = {
      id: currentRecipe?.id ?? randomUUID(),
      productId: product.id,
      version: (currentRecipe?.version ?? 0) + 1,
      items: draft.items.map(({ ingredientId, qty }) => ({ ingredientId, qty })),
      updatedAt: this.clock().toISOString(),
    };
    const publishedVersion = this.publishedRecipes.filter((item) => item.productId === product.id).reduce((highest, item) => Math.max(highest, item.version), 0) + 1;
    const publishedAt = this.clock().toISOString();
    const published = {
      id: randomUUID(), productId: product.id, version: publishedVersion,
      recipeId: operationalRecipe.id, recipeVersion: operationalRecipe.version, sourceDraftVersion: draft.version,
      sellingPriceRupiahSnapshot: product.priceRupiah, hppRupiahSnapshot: calculation.hppRupiah,
      grossProfitRupiahSnapshot: calculation.grossProfitRupiah, marginPctSnapshot: calculation.marginPct,
      items: draft.items.map((item) => {
        const costLine = calculation.lines.find((line) => line.ingredientId === item.ingredientId);
        return {
          ...structuredClone(item), ingredientNameSnapshot: costLine.name, baseUomSnapshot: costLine.unit,
          unitCostRupiahSnapshot: costLine.unitCostRupiah, costRupiahSnapshot: costLine.costRupiah,
        };
      }),
      publishedAt, publishedBy: String(actorId ?? "owner"), reason: reason.trim(),
    };
    this.recipes.set(product.id, operationalRecipe);
    this.recipeDrafts.delete(product.id);
    this.publishedRecipes.push(published);
    this.optionalStateFieldPresence.recipeLifecycle = true;
    return { ...this.#record("hpp.recipe_draft.published", actorId, reason, { productId, publishedVersion, recipeVersion: operationalRecipe.version, hppRupiah: calculation.hppRupiah }), published: structuredClone(published), recipe: structuredClone(operationalRecipe) };
  }

  removeRecipeLine({ productId, ingredientId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    this.#product(productId);
    const existing = this.recipes.get(productId);
    if (!existing?.items.some((item) => item.ingredientId === ingredientId)) throw domainError("recipe_line_not_found", 404);
    const before = this.exportState();
    const next = { ...structuredClone(existing), version: existing.version + 1, items: existing.items.filter((item) => item.ingredientId !== ingredientId), updatedAt: this.clock().toISOString() };
    this.recipes.set(productId, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.recipe.line.removed", actorId, reason, { productId, ingredientId, recipeVersion: next.version }), recipe: structuredClone(next) };
  }

  upsertModifierRecipeLine({ groupId, optionId, ingredientId, qty, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const key = modifierRecipeKey(cleanModifierId(groupId), cleanModifierId(optionId));
    if (!this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000 || Math.round(qty * 1000) !== qty * 1000) throw domainError("modifier_recipe_quantity_invalid", 422);
    const before = this.exportState();
    const existing = this.modifierRecipes.get(key);
    const items = structuredClone(existing?.items ?? []);
    const index = items.findIndex((item) => item.ingredientId === ingredientId);
    if (index >= 0) items[index] = { ingredientId, qty };
    else items.push({ ingredientId, qty });
    const [normalizedGroupId, normalizedOptionId] = key.split(":");
    const next = { groupId: normalizedGroupId, optionId: normalizedOptionId, version: existing ? existing.version + 1 : 1, items, updatedAt: this.clock().toISOString() };
    this.modifierRecipes.set(key, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.modifier_recipe.line.upserted", actorId, reason, { groupId: normalizedGroupId, optionId: normalizedOptionId, ingredientId, qty, recipeVersion: next.version }), modifierRecipe: structuredClone(next) };
  }

  removeModifierRecipeLine({ groupId, optionId, ingredientId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const key = modifierRecipeKey(cleanModifierId(groupId), cleanModifierId(optionId));
    const existing = this.modifierRecipes.get(key);
    if (!existing?.items.some((item) => item.ingredientId === ingredientId)) throw domainError("modifier_recipe_line_not_found", 404);
    const before = this.exportState();
    const next = { ...structuredClone(existing), version: existing.version + 1, items: existing.items.filter((item) => item.ingredientId !== ingredientId), updatedAt: this.clock().toISOString() };
    if (next.items.length) this.modifierRecipes.set(key, next);
    else this.modifierRecipes.delete(key);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.modifier_recipe.line.removed", actorId, reason, { groupId: existing.groupId, optionId: existing.optionId, ingredientId, recipeVersion: next.version }), modifierRecipe: next.items.length ? structuredClone(next) : null };
  }

  upsertFulfillmentRecipeLine({ orderType, station, ingredientId, qty, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedOrderType = cleanFulfillmentOrderType(orderType);
    const normalizedStation = cleanFulfillmentStation(station);
    const key = fulfillmentRecipeKey(normalizedOrderType, normalizedStation);
    if (!this.ingredients.has(ingredientId)) throw domainError("ingredient_not_found", 404);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000 || Math.round(qty * 1000) !== qty * 1000) throw domainError("fulfillment_recipe_quantity_invalid", 422);
    const before = this.exportState();
    const existing = this.fulfillmentRecipes.get(key);
    const items = structuredClone(existing?.items ?? []);
    const index = items.findIndex((item) => item.ingredientId === ingredientId);
    if (index >= 0) items[index] = { ingredientId, qty };
    else items.push({ ingredientId, qty });
    const next = { orderType: normalizedOrderType, station: normalizedStation, version: existing ? existing.version + 1 : 1, items, updatedAt: this.clock().toISOString() };
    this.fulfillmentRecipes.set(key, next);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.fulfillment_recipe.line.upserted", actorId, reason, { orderType: normalizedOrderType, station: normalizedStation, ingredientId, qty, recipeVersion: next.version }), fulfillmentRecipe: structuredClone(next) };
  }

  removeFulfillmentRecipeLine({ orderType, station, ingredientId, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    const key = fulfillmentRecipeKey(cleanFulfillmentOrderType(orderType), cleanFulfillmentStation(station));
    const existing = this.fulfillmentRecipes.get(key);
    if (!existing?.items.some((item) => item.ingredientId === ingredientId)) throw domainError("fulfillment_recipe_line_not_found", 404);
    const before = this.exportState();
    const next = { ...structuredClone(existing), version: existing.version + 1, items: existing.items.filter((item) => item.ingredientId !== ingredientId), updatedAt: this.clock().toISOString() };
    if (next.items.length) this.fulfillmentRecipes.set(key, next);
    else this.fulfillmentRecipes.delete(key);
    try { this.#assertGateIntegrity(); } catch (error) { this.restoreState(before); throw error; }
    return { ...this.#record("hpp.fulfillment_recipe.line.removed", actorId, reason, { orderType: existing.orderType, station: existing.station, ingredientId, recipeVersion: next.version }), fulfillmentRecipe: next.items.length ? structuredClone(next) : null };
  }

  setGate({ enabled, expectedVersion, actorId, reason } = {}) {
    this.#assertMutation(expectedVersion, reason);
    if (typeof enabled !== "boolean") throw domainError("hpp_gate_value_invalid", 422);
    if (enabled) this.#assertBeveragesComplete();
    const previous = { enabled: this.gateEnabled };
    this.gateEnabled = enabled;
    return { ...this.#record("hpp.recipe_gate.updated", actorId, reason, { previous, next: { enabled } }), previous, next: { enabled } };
  }

  snapshotOrderItem({ productId, qty = 1, selections = [], orderType = null } = {}) {
    if (!Number.isSafeInteger(qty) || qty <= 0) throw domainError("cart_quantity_invalid", 422);
    const product = this.#product(productId);
    const cost = this.#cost(product);
    const modifierCost = modifierCostCoverage(selections);
    const selectedModifierCosts = this.#selectedModifierCosts(modifierCost.pricedSelections);
    const fulfillmentCost = this.#fulfillmentCost(product, orderType);
    const unmappedSelections = selectedModifierCosts.filter((item) => item.status === "UNMAPPED").map((item) => item.selection);
    const modifierComplete = selectedModifierCosts.every((item) => item.cost.complete);
    const complete = cost.complete && modifierComplete && fulfillmentCost.cost.complete;
    if (this.gateEnabled && product.status === "active" && product.station === "bar" && !cost.complete) throw domainError("hpp_recipe_required", 409);
    if (this.gateEnabled && product.status === "active" && product.station === "bar" && !modifierComplete) throw domainError("hpp_modifier_recipe_required", 409);
    const status = complete ? "VERIFIED" : "INCOMPLETE";
    const recipeLines = mergeRecipeCostLines([
      ...(cost.lines ?? []),
      ...selectedModifierCosts.flatMap((item) => item.cost.lines ?? []),
      ...(fulfillmentCost.cost.lines ?? []),
    ]);
    const modifierRecipeStatus = modifierCost.unmappedSelections.length ? "UNMAPPED_PRICED_MODIFIER"
      : unmappedSelections.length ? "UNMAPPED_PRICED_MODIFIER"
      : selectedModifierCosts.some((item) => !item.cost.complete) ? "INCOMPLETE_PRICED_MODIFIER"
        : modifierCost.pricedSelections.length ? "VERIFIED" : "NOT_APPLICABLE";
    return {
      recipeCostSnapshotRupiah: cost.hppRupiah + selectedModifierCosts.reduce((sum, item) => sum + item.cost.hppRupiah, 0) + fulfillmentCost.cost.hppRupiah,
      hppSnapshotStatus: status,
      costCoverage: complete ? "COMPLETE" : recipeLines.length ? "PARTIAL" : "MISSING",
      reportableRecipeCostSnapshotRupiah: complete
        ? cost.hppRupiah + selectedModifierCosts.reduce((sum, item) => sum + item.cost.hppRupiah, 0) + fulfillmentCost.cost.hppRupiah
        : null,
      recipeSnapshot: {
        version: HPP_STATE_VERSION,
        status,
        recipeId: cost.recipeId,
        recipeVersion: cost.recipeVersion,
        missingIngredientIds: cost.missingIngredientIds ?? [],
        missingCostIngredientIds: cost.missingCostIngredientIds ?? [],
        modifierCostStatus: modifierRecipeStatus,
        unmappedModifierSelections: unmappedSelections,
        modifierRecipeVersions: selectedModifierCosts.filter((item) => item.recipe).map((item) => ({ groupId: item.selection.groupId, optionId: item.selection.optionId, recipeVersion: item.recipe.version })),
        fulfillmentCostStatus: fulfillmentCost.status,
        missingFulfillmentRecipe: fulfillmentCost.missingRecipe,
        fulfillmentRecipeVersion: fulfillmentCost.recipe?.version ?? null,
        lines: recipeLines,
      },
    };
  }

  #productCost(product) {
    const cost = this.#cost(product);
    const targetMarginPct = targetMargin(product);
    const divisor = 1 - targetMarginPct / 100;
    return {
      id: product.id, name: product.name, station: product.station, categoryId: product.categoryId,
      priceRupiah: product.priceRupiah, recipeVersion: cost.recipeVersion, recipeItems: structuredClone(this.recipes.get(product.id)?.items ?? []),
      costLines: structuredClone(cost.lines ?? []),
      hppStatus: cost.complete ? "VERIFIED" : "INCOMPLETE", hppRupiah: cost.hppRupiah,
      grossProfitRupiah: cost.complete ? cost.grossProfitRupiah : null, marginPct: cost.complete ? cost.marginPct : null,
      targetMarginPct, suggestedPriceRupiah: cost.complete ? Math.ceil((cost.hppRupiah / divisor) / 500) * 500 : null,
      missingIngredientCount: cost.missingIngredientIds?.length ?? 0,
      missingCostIngredientCount: cost.missingCostIngredientIds?.length ?? 0,
    };
  }

  #cost(product) {
    const recipe = this.recipes.get(product.id);
    return calculateRecipeCost({ product, recipe, recipeItems: recipe?.items ?? [], ingredients: this.#costIngredients() });
  }

  #selectedModifierCosts(selections) {
    return selections.map((selection) => {
      const key = modifierRecipeKey(selection.groupId, selection.optionId);
      const recipe = this.modifierRecipes.get(key);
      if (!recipe?.items.length) return { selection, recipe: null, status: "UNMAPPED", cost: { complete: false, hppRupiah: 0, lines: [] } };
      return {
        selection,
        recipe,
        status: "MAPPED",
        cost: calculateRecipeCost({
          product: { id: key, name: selection.optionLabel, priceRupiah: selection.priceDeltaRupiah },
          recipe,
          recipeItems: recipe.items,
          ingredients: this.#costIngredients(),
        }),
      };
    });
  }

  #fulfillmentCost(product, orderType) {
    if (orderType == null) return { status: "NOT_APPLICABLE", missingRecipe: null, recipe: null, cost: { complete: true, hppRupiah: 0, lines: [] } };
    const normalizedOrderType = cleanOptionalFulfillmentOrderType(orderType);
    if (!FULFILLMENT_RECIPE_ORDER_TYPES.has(normalizedOrderType)) return { status: "NOT_APPLICABLE", missingRecipe: null, recipe: null, cost: { complete: true, hppRupiah: 0, lines: [] } };
    const station = cleanFulfillmentStation(product.station);
    const recipe = this.fulfillmentRecipes.get(fulfillmentRecipeKey(normalizedOrderType, station));
    if (!recipe?.items.length) return { status: "UNMAPPED_TAKEAWAY_PACKAGING", missingRecipe: { orderType: normalizedOrderType, station }, recipe: null, cost: { complete: false, hppRupiah: 0, lines: [] } };
    const calculated = calculateRecipeCost({
      product: { id: `${normalizedOrderType}:${station}`, name: `${normalizedOrderType} ${station}`, priceRupiah: 0 },
      recipe,
      recipeItems: recipe.items,
      ingredients: this.#costIngredients(),
    });
    return { status: calculated.complete ? "VERIFIED" : "INCOMPLETE_TAKEAWAY_PACKAGING", missingRecipe: calculated.complete ? null : { orderType: normalizedOrderType, station }, recipe, cost: calculated };
  }

  #assertMutation(expectedVersion, reason) {
    if (!Number.isSafeInteger(expectedVersion)) throw domainError("hpp_version_required", 422);
    if (expectedVersion !== this.version) throw domainError("hpp_version_conflict", 409);
    if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 160) throw domainError("hpp_reason_required", 422);
  }

  #purchaseOrderPlan({ supplierId, expectedDate, lines }) {
    const supplier = this.suppliers.find((item) => item.id === supplierId);
    if (!supplier) throw domainError("supplier_not_found", 404);
    if (!supplier.active) throw domainError("supplier_inactive", 409);
    if (!validBusinessDate(expectedDate)) throw domainError("purchase_order_expected_date_invalid", 422);
    if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("purchase_order_lines_invalid", 422);
    const seen = new Set();
    const normalizedLines = lines.map((line) => {
      if (!line || typeof line.ingredientId !== "string" || !this.ingredients.has(line.ingredientId)) throw domainError("ingredient_not_found", 404);
      if (seen.has(line.ingredientId)) throw domainError("purchase_order_ingredient_duplicate", 422);
      seen.add(line.ingredientId);
      const purchaseUnitLabel = cleanPurchaseText(line.purchaseUnitLabel, "purchase_unit_label_invalid");
      const orderedPurchaseQuantity = exactPositiveQuantity(line.orderedPurchaseQuantity, "purchase_order_quantity_invalid");
      const baseUnitsPerPurchaseUnit = exactPositiveQuantity(line.baseUnitsPerPurchaseUnit, "purchase_conversion_invalid");
      if (!Number.isSafeInteger(line.unitCostRupiah) || line.unitCostRupiah <= 0 || line.unitCostRupiah > 1_000_000_000) throw domainError("purchase_order_unit_cost_invalid", 422);
      const lineTotalRupiah = Math.round(orderedPurchaseQuantity * line.unitCostRupiah);
      if (!Number.isSafeInteger(lineTotalRupiah) || lineTotalRupiah <= 0) throw domainError("purchase_order_total_invalid", 422);
      return {
        ingredientId: line.ingredientId,
        purchaseUnitLabel,
        orderedPurchaseQuantity,
        baseUnitsPerPurchaseUnit,
        unitCostRupiah: line.unitCostRupiah,
        lineTotalRupiah,
        deliveredPurchaseQuantity: 0,
        receivedPurchaseQuantity: 0,
        rejectedPurchaseQuantity: 0,
        quarantinedPurchaseQuantity: 0,
        pendingInspectionPurchaseQuantity: 0,
        paidOverPurchaseQuantity: 0,
        bonusPurchaseQuantity: 0,
      };
    }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
    const totalOrderedRupiah = normalizedLines.reduce((sum, line) => sum + line.lineTotalRupiah, 0);
    if (!Number.isSafeInteger(totalOrderedRupiah) || totalOrderedRupiah <= 0) throw domainError("purchase_order_total_invalid", 422);
    return { supplier, normalizedLines, totalOrderedRupiah };
  }

  #purchaseOrderActionReplay(key, action, requestFingerprint) {
    for (const order of this.purchaseOrders) {
      if (order.idempotencyKey === key) throw domainError("purchase_order_action_idempotency_conflict", 409);
      const change = order.changes.find((item) => item.idempotencyKey === key);
      if (!change) continue;
      if (change.action !== action || change.requestFingerprint !== requestFingerprint) throw domainError("purchase_order_action_idempotency_conflict", 409);
      return { purchaseOrder: structuredClone(order), idempotentReplay: true, version: this.version };
    }
    return null;
  }

  #purchaseInvoiceActionReplay(key, action, requestFingerprint) {
    for (const invoice of this.purchaseInvoices) {
      if (invoice.idempotencyKey === key) throw domainError("purchase_invoice_action_idempotency_conflict", 409);
      const transition = invoice.approvalHistory.find((item) => item.idempotencyKey === key);
      if (!transition) continue;
      if (transition.action !== action || transition.fingerprint !== requestFingerprint) throw domainError("purchase_invoice_action_idempotency_conflict", 409);
      return { invoice: structuredClone(invoice), idempotentReplay: true, version: this.version };
    }
    return null;
  }

  #reservedQuantityBase(ingredientId) {
    return roundedQuantity(this.inventoryReservations
      .filter((reservation) => reservation.status === "ACTIVE")
      .flatMap((reservation) => reservation.lines)
      .filter((line) => line.ingredientId === ingredientId)
      .reduce((sum, line) => sum + line.quantityReservedBase, 0));
  }

  #enableMasterDataState() {
    if (this.masterDataStateEnabled) return;
    this.ingredients = new Map([...this.ingredients.entries()].map(([id, ingredient]) => [id, migrateIngredientV22(ingredient)]));
    this.ingredientConversions = [];
    this.ingredientSupplierPackages = [];
    this.ingredientReferencePriceVersions = [];
    this.masterDataStateEnabled = true;
  }

  #materialCategory(categoryId, { activeRequired = false } = {}) {
    const id = String(categoryId ?? "").trim();
    const category = this.materialCategories.find((item) => item.id === id);
    if (!category) throw domainError("material_category_not_found", 404);
    if (activeRequired && category.status !== "ACTIVE") throw domainError("material_category_archived", 409);
    return category;
  }

  #nextIngredientCode(category) {
    if (!category) throw domainError("material_category_required_for_auto_code", 422);
    const expression = new RegExp(`^${escapeRegex(category.prefix)}-(\\d+)$`);
    let maximum = 0;
    for (const item of this.ingredients.values()) {
      const match = expression.exec(item.code ?? "");
      if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    if (maximum >= 999999) throw domainError("ingredient_code_sequence_exhausted", 409);
    return `${category.prefix}-${String(maximum + 1).padStart(3, "0")}`;
  }

  #suggestCategoryPrefix(name) {
    const words = name.toUpperCase().normalize("NFKD").replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const base = (words.length > 1 ? words.map((word) => word[0]).join("") : words[0] ?? "CAT").slice(0, 5).padEnd(2, "X");
    if (!this.materialCategories.some((item) => item.prefix === base)) return base;
    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${base.slice(0, Math.max(2, 5 - String(suffix).length))}${suffix}`;
      if (!this.materialCategories.some((item) => item.prefix === candidate)) return candidate;
    }
    throw domainError("material_category_prefix_exhausted", 409);
  }

  #currentIngredientConversions() {
    const latest = new Map();
    for (const item of this.ingredientConversions) latest.set(`${item.ingredientId}\u0000${item.fromUom}\u0000${item.toUom}`, item);
    return [...latest.values()].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId) || a.fromUom.localeCompare(b.fromUom) || a.toUom.localeCompare(b.toUom)).map((item) => structuredClone(item));
  }

  #currentIngredientSupplierPackages() {
    const latest = new Map();
    for (const item of this.ingredientSupplierPackages) latest.set(item.packageId, item);
    return [...latest.values()]
      .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId) || a.packageLabel.localeCompare(b.packageLabel, "id"))
      .map((item) => structuredClone(item));
  }

  #appendIngredientReferencePrice(entryType, input) {
    const operationKey = cleanReferencePriceOperationKey(input.operationKey);
    const targetId = input.supersedesPriceVersionId ?? input.priceVersionId ?? null;
    const target = targetId == null ? null : this.ingredientReferencePriceVersions.find((item) => item.id === targetId);
    if (targetId != null && !target) throw domainError("ingredient_reference_price_version_not_found", 404);
    const purchaseOptionId = input.purchaseOptionId ?? target?.purchaseOptionId;
    const option = this.#currentIngredientSupplierPackages().find((item) => item.purchaseOptionId === purchaseOptionId);
    if (!option) throw domainError("ingredient_purchase_option_not_found", 404);
    if (target && (target.purchaseOptionId !== option.purchaseOptionId || target.entryType === "VOID")) throw domainError("ingredient_reference_price_target_invalid", 409);
    const effectiveAt = normalizeReferenceEffectiveAt(input.effectiveAt ?? input.effectiveDate ?? this.clock().toISOString());
    const referencePriceRupiah = entryType === "VOID" ? null : input.referencePriceRupiah;
    if (entryType !== "VOID" && (!Number.isSafeInteger(referencePriceRupiah) || referencePriceRupiah <= 0 || referencePriceRupiah > 1_000_000_000)) throw domainError("ingredient_reference_price_invalid", 422);
    if (entryType === "CORRECTION" && !target) throw domainError("ingredient_reference_price_target_required", 422);
    if (entryType === "VOID" && !target) throw domainError("ingredient_reference_price_target_required", 422);
    const fingerprint = referencePriceFingerprint({ entryType, purchaseOptionId, referencePriceRupiah, effectiveAt, targetId });
    const replay = this.ingredientReferencePriceVersions.find((item) => item.operationKey === operationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw domainError("ingredient_reference_price_operation_conflict", 409);
      return { type: "ingredient.reference_price.replayed", version: this.version, priceVersion: structuredClone(replay), idempotentReplay: true };
    }
    if (target && this.ingredientReferencePriceVersions.some((item) => item.targetPriceVersionId === target.id)) throw domainError("ingredient_reference_price_target_already_superseded", 409);
    if (target && effectiveAt < target.effectiveAt) throw domainError("ingredient_reference_price_effective_at_invalid", 422);
    this.#assertMutation(input.expectedVersion, input.reason);
    const now = this.clock().toISOString();
    if (effectiveAt > new Date(new Date(now).getTime() + 366 * 24 * 60 * 60 * 1000).toISOString()) throw domainError("ingredient_reference_price_effective_at_invalid", 422);
    this.#enableMasterDataState();
    const sequence = this.ingredientReferencePriceVersions.length + 1;
    const priceVersion = {
      id: randomUUID(), operationKey, fingerprint, sequence, entryType,
      ingredientId: option.ingredientId, purchaseOptionId, purchaseOptionSequence: option.sequence,
      supplierName: option.supplierName === "Belum ditentukan" ? null : option.supplierName,
      packageSnapshot: purchaseOptionPriceSnapshot(option), referencePriceRupiah,
      unitCostPerBaseUnitRupiah: referencePriceRupiah == null ? null : roundedUnitCost(referencePriceRupiah / option.baseUnitsPerPurchaseUnit),
      effectiveAt, recordedAt: now, actorId: String(input.actorId ?? "owner"), reason: input.reason.trim(),
      targetPriceVersionId: targetId, revision: this.version + 1,
    };
    const event = this.#record(`ingredient.reference_price.${entryType.toLowerCase()}`, input.actorId, input.reason, { priceVersion });
    this.ingredientReferencePriceVersions.push(priceVersion);
    return { ...event, priceVersion: structuredClone(priceVersion), idempotentReplay: false };
  }

  #effectiveIngredientReferencePrice(ingredientId, asOf, purchaseOptionId = null) {
    const records = this.ingredientReferencePriceVersions.filter((item) => item.ingredientId === ingredientId && item.effectiveAt <= asOf && (purchaseOptionId === null || item.purchaseOptionId === purchaseOptionId));
    if (!records.length) return null;
    const removed = new Set(records.filter((item) => item.targetPriceVersionId).map((item) => item.targetPriceVersionId));
    return records.filter((item) => item.entryType !== "VOID" && !removed.has(item.id))
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.sequence - a.sequence)[0] ?? null;
  }

  #costIngredients() {
    return [...this.ingredients.values()].map((ingredient) => structuredClone(ingredient));
  }

  #effectiveConversions(ingredientId, occurredAt) {
    const latest = new Map();
    for (const item of this.ingredientConversions) {
      if (item.ingredientId !== ingredientId || item.effectiveAt > occurredAt) continue;
      const key = `${item.fromUom}\u0000${item.toUom}`;
      const current = latest.get(key);
      if (!current || item.effectiveAt > current.effectiveAt || (item.effectiveAt === current.effectiveAt && item.sequence > current.sequence)) latest.set(key, item);
    }
    const standard = standardConversionsFor(this.ingredients.get(ingredientId)?.baseUnit);
    for (const item of standard) if (!latest.has(`${item.fromUom}\u0000${item.toUom}`)) latest.set(`${item.fromUom}\u0000${item.toUom}`, item);
    return [...latest.values()];
  }

  #ingredientHasOperationalDependency(ingredientId) {
    return this.#ingredientDependencies(ingredientId).length > 0;
  }

  #ingredientHasProductionRecipeDependency(ingredientId) {
    return restoreIngredientProductionRecipes(this.audit, this.ingredients)
      .some((item) => item.outputIngredientId === ingredientId || item.components.some((line) => line.ingredientId === ingredientId));
  }

  #assertInventoryPeriodOpen(occurredAt) {
    if (this.inventoryPeriods.some((period) => period.status === "CLOSED" && occurredAt <= period.periodEndAt)) {
      throw domainError("inventory_period_closed", 409);
    }
  }

  #ingredientDependencies(ingredientId) {
    const dependencies = [];
    if (this.inventoryBalances.has(ingredientId)) dependencies.push("inventory_balance");
    if (this.purchaseReceipts.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId) || item.rejectedLines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("purchase_history");
    if (this.inventoryMovements.some((item) => item.ingredientId === ingredientId)) dependencies.push("movement_history");
    if (this.inventoryCounts.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("count_history");
    if ([...this.recipes.values()].some((item) => item.items?.some((line) => line.ingredientId === ingredientId))) dependencies.push("menu_recipe");
    if ([...this.recipeDrafts.values()].some((item) => item.items?.some((line) => line.ingredientId === ingredientId))) dependencies.push("menu_recipe_draft");
    if ([...this.modifierRecipes.values()].some((item) => item.items?.some((line) => line.ingredientId === ingredientId))) dependencies.push("modifier_recipe");
    if ([...this.fulfillmentRecipes.values()].some((item) => item.items?.some((line) => line.ingredientId === ingredientId))) dependencies.push("fulfillment_recipe");
    if (this.purchaseOrders.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("purchase_order_history");
    if (this.purchaseInvoices.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("invoice_history");
    if (this.supplierReturns.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("supplier_return_history");
    if (this.saleConsumptions.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("sale_consumption_history");
    if (this.inventoryReservations.some((item) => item.lines?.some((line) => line.ingredientId === ingredientId))) dependencies.push("reservation_history");
    if (restoreIngredientProductionRecipes(this.audit, this.ingredients).some((item) => item.outputIngredientId === ingredientId || item.components.some((line) => line.ingredientId === ingredientId))) dependencies.push("production_recipe");
    return dependencies;
  }

  #record(type, actorId, reason, payload) {
    const event = { type, actorId: String(actorId ?? "owner"), reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString(), ...structuredClone(payload) };
    this.audit.push(event);
    return structuredClone(event);
  }

  #assertGateIntegrity() { if (this.gateEnabled) this.#assertBeveragesComplete(); }
  #assertBeveragesComplete() {
    const incomplete = this.#products().filter((product) => product.status === "active" && product.station === "bar" && !this.#cost(product).complete);
    if (incomplete.length) throw domainError("hpp_gate_would_break", 409);
    const missingModifierRecipe = this.#products().filter((product) => product.status === "active" && product.station === "bar").flatMap(pricedModifierOptionsForProduct).filter((option) => {
      const recipe = this.modifierRecipes.get(modifierRecipeKey(option.groupId, option.optionId));
      return !recipe?.items.length || !calculateRecipeCost({ product: { id: option.optionId, name: option.optionLabel, priceRupiah: option.priceDeltaRupiah }, recipe, recipeItems: recipe.items, ingredients: this.#costIngredients() }).complete;
    });
    if (missingModifierRecipe.length) throw domainError("hpp_modifier_gate_would_break", 409);
  }
  #products() { const products = this.productProvider(); return Array.isArray(products) ? products : []; }
  #product(productId) { const product = this.#products().find((item) => item.id === productId); if (!product) throw domainError("product_not_found", 404); return product; }
}

function cleanName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f<>]/.test(value)) throw domainError("ingredient_name_invalid", 422);
  return value.trim();
}

function targetMargin(product) {
  if (product.categoryId === "bagel" || product.station === "food") return 45;
  if (product.categoryId === "tea") return 65;
  return 60;
}

function validateIngredientRecord(item) {
  if (!item || typeof item.id !== "string" || !item.id || cleanName(item.name) !== item.name || !BASE_UNITS.has(item.baseUnit) || (item.costPerUnitRupiah !== null && !validUnitCost(item.costPerUnitRupiah))
    || !LOT_TRACKING_POLICIES.has(item.lotTrackingPolicy) || !Number.isSafeInteger(item.minimumShelfLifeDays) || item.minimumShelfLifeDays < 0 || item.minimumShelfLifeDays > 3650) throw domainError("hpp_state_invalid", 500);
}

function validateIngredientMasterRecord(item) {
  if (cleanIngredientCode(item.code) !== item.code || cleanIngredientCategory(item.category) !== item.category
    || typeof item.purchasable !== "boolean" || !["ACTIVE", "ARCHIVED"].includes(item.status)
    || !Number.isSafeInteger(item.revision) || item.revision < 1 || !validIsoTimestamp(item.createdAt) || !validIsoTimestamp(item.updatedAt)) throw domainError("hpp_state_invalid", 500);
  const sourcingMode = ingredientSourcingMode(item);
  const materialType = ingredientMaterialType(item);
  if (!INGREDIENT_SOURCING_MODES.has(sourcingMode) || !INGREDIENT_MATERIAL_TYPES.has(materialType)
    || (materialType === "PREP_ITEM" && sourcingMode !== "MADE_IN_HOUSE")
    || (sourcingMode === "MADE_IN_HOUSE" && item.purchasable)) throw domainError("hpp_state_invalid", 500);
}

function ingredientSourcingMode(item) {
  return item?.sourcingMode ?? "PURCHASED";
}

function ingredientMaterialType(item) {
  return item?.materialType ?? "RAW_MATERIAL";
}

function migrateIngredientV21(ingredient) {
  return { ...structuredClone(ingredient), lotTrackingPolicy: "NOT_REQUIRED", minimumShelfLifeDays: 0 };
}

function migrateIngredientV22(ingredient) {
  return {
    ...structuredClone(ingredient),
    code: ingredient.code ?? `LEGACY-${String(ingredient.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 24).toUpperCase()}`,
    category: ingredient.category ?? "UMUM",
    purchasable: ingredient.purchasable ?? true,
    status: ingredient.status ?? "ACTIVE",
    revision: ingredient.revision ?? 1,
  };
}

function validateIngredientConversions(items, ingredients, stateVersion) {
  const ids = new Set();
  const sequences = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || !ingredients.has(item.ingredientId)
      || cleanUom(item.fromUom) !== item.fromUom || cleanUom(item.toUom) !== item.toUom || item.fromUom === item.toUom
      || exactConversionFactor(item.factor) !== item.factor || !validIsoTimestamp(item.effectiveAt) || !validIsoTimestamp(item.createdAt)
      || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || !Number.isSafeInteger(item.revision) || item.revision < 2 || item.revision > stateVersion
      || !validStoredText(item.actorId, 80) || !validStoredText(item.reason, 160)) throw domainError("hpp_state_invalid", 500);
    const sequenceKey = `${item.ingredientId}\u0000${item.fromUom}\u0000${item.toUom}\u0000${item.sequence}`;
    if (sequences.has(sequenceKey)) throw domainError("hpp_state_invalid", 500);
    ids.add(item.id); sequences.add(sequenceKey);
  }
}

function validateIngredientSupplierPackages(items, ingredients, stateVersion) {
  const ids = new Set();
  const sequences = new Set();
  const packageIngredients = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.packageId !== "string" || !item.packageId || ids.has(item.id) || !ingredients.has(item.ingredientId)
      || cleanPurchaseText(item.supplierName, "hpp_state_invalid") !== item.supplierName || cleanPurchaseText(item.packageLabel, "hpp_state_invalid") !== item.packageLabel
      || cleanUom(item.purchaseUom) !== item.purchaseUom || exactConversionQuantity(item.quantityPerPackage) !== item.quantityPerPackage
      || (item.barcode !== null && cleanBarcode(item.barcode) !== item.barcode) || !Number.isSafeInteger(item.sequence) || item.sequence < 1
      || !Number.isSafeInteger(item.revision) || item.revision < 2 || item.revision > stateVersion || !validIsoTimestamp(item.createdAt)
      || !validStoredText(item.actorId, 80) || !validStoredText(item.reason, 160)) throw domainError("hpp_state_invalid", 500);
    const sequenceKey = `${item.packageId}\u0000${item.sequence}`;
    if (sequences.has(sequenceKey) || (packageIngredients.has(item.packageId) && packageIngredients.get(item.packageId) !== item.ingredientId)) throw domainError("hpp_state_invalid", 500);
    ids.add(item.id); sequences.add(sequenceKey); packageIngredients.set(item.packageId, item.ingredientId);
    if (item.purchaseOptionId !== undefined) validateStoredPurchaseOption(item, ingredients.get(item.ingredientId));
  }
  const current = new Map();
  for (const item of items.filter((entry) => entry.purchaseOptionId !== undefined)) current.set(item.packageId, item);
  const preferredIngredients = new Set();
  for (const item of current.values()) {
    if (!item.preferred) continue;
    if (preferredIngredients.has(item.ingredientId)) throw domainError("hpp_state_invalid", 500);
    preferredIngredients.add(item.ingredientId);
  }
}

function validateIngredientReferencePriceVersions(items, ingredients, supplierPackages, stateVersion) {
  const ids = new Set();
  const operations = new Set();
  const sequences = new Set();
  const optionIds = new Set(supplierPackages.filter((item) => item.purchaseOptionId).map((item) => item.purchaseOptionId));
  for (const item of items) {
    const expectedFingerprint = item ? referencePriceFingerprint({ entryType: item.entryType, purchaseOptionId: item.purchaseOptionId, referencePriceRupiah: item.referencePriceRupiah, effectiveAt: item.effectiveAt, targetId: item.targetPriceVersionId }) : null;
    const snapshot = item?.packageSnapshot;
    if (!item || !validStoredText(item.id, 80) || ids.has(item.id) || !validStoredText(item.operationKey, 80) || operations.has(item.operationKey)
      || !/^[a-f0-9]{64}$/.test(item.fingerprint) || item.fingerprint !== expectedFingerprint || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || sequences.has(item.sequence)
      || !["SET", "CORRECTION", "VOID"].includes(item.entryType) || !ingredients.has(item.ingredientId) || !optionIds.has(item.purchaseOptionId)
      || !Number.isSafeInteger(item.purchaseOptionSequence) || item.purchaseOptionSequence < 1 || !validIsoTimestamp(item.effectiveAt) || !validIsoTimestamp(item.recordedAt)
      || !validStoredText(item.actorId, 80) || !validStoredText(item.reason, 160) || !Number.isSafeInteger(item.revision) || item.revision < 2 || item.revision > stateVersion
      || !snapshot || snapshot.purchaseOptionId !== item.purchaseOptionId || snapshot.purchaseOptionSequence !== item.purchaseOptionSequence
      || !validStoredText(snapshot.label, 80) || cleanUom(snapshot.purchaseUnit) !== snapshot.purchaseUnit
      || !Number.isFinite(snapshot.baseUnitsPerPurchaseUnit) || snapshot.baseUnitsPerPurchaseUnit <= 0 || snapshot.baseUnitsPerPurchaseUnit > 1_000_000_000
      || roundedConversion(snapshot.baseUnitsPerPurchaseUnit) !== snapshot.baseUnitsPerPurchaseUnit
      || !supplierPackages.some((option) => option.purchaseOptionId === item.purchaseOptionId && option.sequence === item.purchaseOptionSequence
        && option.label === snapshot.label && option.purchaseUnit === snapshot.purchaseUnit && option.innerUnit === snapshot.innerUnit
        && option.innerUnitsPerPurchaseUnit === snapshot.innerUnitsPerPurchaseUnit && option.baseUnitsPerInnerUnit === snapshot.baseUnitsPerInnerUnit
        && option.baseUnitsPerPurchaseUnit === snapshot.baseUnitsPerPurchaseUnit
        && (option.supplierName === "Belum ditentukan" ? null : option.supplierName) === item.supplierName)
      || (item.supplierName !== null && !validStoredText(item.supplierName, 80))) throw domainError("hpp_state_invalid", 500);
    if (item.entryType === "VOID") {
      if (item.referencePriceRupiah !== null || item.unitCostPerBaseUnitRupiah !== null || !validStoredText(item.targetPriceVersionId, 80)) throw domainError("hpp_state_invalid", 500);
    } else if (!Number.isSafeInteger(item.referencePriceRupiah) || item.referencePriceRupiah <= 0 || item.referencePriceRupiah > 1_000_000_000
      || !validUnitCost(item.unitCostPerBaseUnitRupiah) || item.unitCostPerBaseUnitRupiah <= 0
      || item.unitCostPerBaseUnitRupiah !== roundedUnitCost(item.referencePriceRupiah / snapshot.baseUnitsPerPurchaseUnit)
      || (item.entryType === "CORRECTION" && !validStoredText(item.targetPriceVersionId, 80))) throw domainError("hpp_state_invalid", 500);
    if (item.targetPriceVersionId !== null && !ids.has(item.targetPriceVersionId)) throw domainError("hpp_state_invalid", 500);
    ids.add(item.id); operations.add(item.operationKey); sequences.add(item.sequence);
  }
}

function restoreIngredientReferencePriceVersions(audit) {
  return audit.filter((event) => typeof event?.type === "string" && event.type.startsWith("ingredient.reference_price."))
    .map((event) => {
      const item = event.priceVersion;
      const expectedType = item?.entryType ? `ingredient.reference_price.${item.entryType.toLowerCase()}` : null;
      if (!item || event.type !== expectedType || event.version !== item.revision || event.actorId !== item.actorId || event.reason !== item.reason || !validIsoTimestamp(event.occurredAt)) throw domainError("hpp_state_invalid", 500);
      return structuredClone(item);
    });
}

function restoreIngredientProductionRecipes(audit, ingredients) {
  const current = new Map();
  const operations = new Map();
  for (const event of [...audit].sort((a, b) => (a.version ?? 0) - (b.version ?? 0))) {
    if (event?.type !== "ingredient.production_recipe.upserted") continue;
    const recipe = event.productionRecipe;
    if (!recipe || !validIsoTimestamp(event.occurredAt) || event.actorId !== recipe.actorId || event.reason !== recipe.reason
      || !validStoredText(recipe.id, 128) || !validStoredText(recipe.operationKey, 80) || !/^[a-f0-9]{64}$/.test(recipe.fingerprint)
      || !Number.isSafeInteger(recipe.version) || recipe.version < 1 || !validIsoTimestamp(recipe.createdAt) || !validIsoTimestamp(recipe.updatedAt)
      || !Number.isSafeInteger(recipe.yieldToleranceBps) || recipe.yieldToleranceBps < 0 || recipe.yieldToleranceBps > 2_500
      || !Array.isArray(recipe.components) || recipe.components.length < 1 || recipe.components.length > 50) throw domainError("hpp_state_invalid", 500);
    const output = ingredients.get(recipe.outputIngredientId);
    if (!output || recipe.outputIngredientName !== output.name || recipe.outputUom !== output.baseUnit
      || !Number.isFinite(recipe.outputQuantity) || recipe.outputQuantity <= 0 || roundedConversion(recipe.outputQuantity) !== recipe.outputQuantity
      || ingredientSourcingMode(output) !== "MADE_IN_HOUSE" || ingredientMaterialType(output) !== "PREP_ITEM") throw domainError("hpp_state_invalid", 500);
    const componentIds = new Set();
    for (const line of recipe.components) {
      const ingredient = ingredients.get(line?.ingredientId);
      if (!ingredient || line.ingredientId === output.id || componentIds.has(line.ingredientId)
        || line.ingredientName !== ingredient.name || line.normalizedUom !== ingredient.baseUnit
        || !Number.isFinite(line.normalizedQuantity) || line.normalizedQuantity <= 0 || roundedConversion(line.normalizedQuantity) !== line.normalizedQuantity
        || !Number.isFinite(line.quantity) || line.quantity <= 0 || !validStoredText(line.uom, 40)
        || !Array.isArray(line.conversionSnapshot)) throw domainError("hpp_state_invalid", 500);
      componentIds.add(line.ingredientId);
    }
    if (recipe.fingerprint !== productionRecipeFingerprint(recipe)) throw domainError("hpp_state_invalid", 500);
    const operation = operations.get(recipe.operationKey);
    if (operation && operation !== recipe.fingerprint) throw domainError("hpp_state_invalid", 500);
    operations.set(recipe.operationKey, recipe.fingerprint);
    const previous = current.get(recipe.outputIngredientId);
    if ((previous && recipe.version !== previous.version + 1) || (!previous && recipe.version !== 1)
      || recipe.id !== (previous?.id ?? `prep-recipe:${output.id}`)) throw domainError("hpp_state_invalid", 500);
    current.set(recipe.outputIngredientId, structuredClone(recipe));
  }
  const recipes = [...current.values()];
  assertProductionRecipeGraphAcyclic(recipes, null, "hpp_state_invalid", 500);
  return recipes;
}

function projectProductionRecipeCosts(sourceIngredients, recipes) {
  const ingredients = new Map(sourceIngredients.map((ingredient) => [ingredient.id, structuredClone(ingredient)]));
  const recipesByOutput = new Map(recipes.map((recipe) => [recipe.outputIngredientId, recipe]));
  const resolved = new Map();
  const resolving = new Set();
  const prepImpacts = [];
  const resolve = (ingredientId) => {
    if (resolved.has(ingredientId)) return resolved.get(ingredientId);
    const ingredient = ingredients.get(ingredientId);
    if (!ingredient) return null;
    const recipe = recipesByOutput.get(ingredientId);
    if (!recipe) {
      const cost = Number.isFinite(ingredient.costPerUnitRupiah) && ingredient.costPerUnitRupiah >= 0 ? ingredient.costPerUnitRupiah : null;
      resolved.set(ingredientId, cost);
      return cost;
    }
    if (resolving.has(ingredientId)) throw domainError("production_recipe_cycle_invalid", 422);
    resolving.add(ingredientId);
    let complete = true;
    let totalCostRupiah = 0;
    for (const component of recipe.components) {
      const unitCost = resolve(component.ingredientId);
      if (unitCost == null) {
        complete = false;
        continue;
      }
      const componentCost = Math.round(Number(component.normalizedQuantity) * unitCost);
      if (!Number.isSafeInteger(componentCost) || componentCost < 0) throw domainError("recipe_cost_overflow", 422);
      totalCostRupiah = safeRupiah(totalCostRupiah + componentCost);
    }
    resolving.delete(ingredientId);
    const outputQuantity = Number(recipe.outputQuantity);
    const projectedUnitCostRupiah = complete && Number.isFinite(outputQuantity) && outputQuantity > 0
      ? roundedUnitCost(totalCostRupiah / outputQuantity)
      : null;
    ingredients.set(ingredientId, { ...ingredient, costPerUnitRupiah: projectedUnitCostRupiah });
    resolved.set(ingredientId, projectedUnitCostRupiah);
    prepImpacts.push({
      ingredientId,
      ingredientName: ingredient.name,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      projectedUnitCostRupiah,
      complete,
      componentIngredientIds: recipe.components.map((component) => component.ingredientId),
    });
    return projectedUnitCostRupiah;
  };
  for (const recipe of recipes) resolve(recipe.outputIngredientId);
  return { ingredients: [...ingredients.values()], prepImpacts };
}

function productionRecipeFingerprint(value) {
  return createHash("sha256").update(JSON.stringify({
    outputIngredientId: value.outputIngredientId,
    outputQuantity: value.outputQuantity,
    outputUom: value.outputUom,
    components: value.components.map((line) => ({ ingredientId: line.ingredientId, quantity: line.quantity, uom: line.uom, normalizedQuantity: line.normalizedQuantity, normalizedUom: line.normalizedUom, conversionSnapshot: line.conversionSnapshot })),
    yieldToleranceBps: value.yieldToleranceBps,
  })).digest("hex");
}

function assertProductionRecipeGraphAcyclic(existingRecipes, candidate, errorCode = "production_recipe_cycle_invalid", statusCode = 422) {
  const recipes = new Map(existingRecipes.map((recipe) => [recipe.outputIngredientId, recipe]));
  if (candidate) recipes.set(candidate.outputIngredientId, candidate);
  const visiting = new Set();
  const visited = new Set();
  const visit = (ingredientId) => {
    if (visiting.has(ingredientId)) throw domainError(errorCode, statusCode);
    if (visited.has(ingredientId)) return;
    const recipe = recipes.get(ingredientId);
    if (!recipe) return;
    visiting.add(ingredientId);
    for (const component of recipe.components) if (recipes.has(component.ingredientId)) visit(component.ingredientId);
    visiting.delete(ingredientId);
    visited.add(ingredientId);
  };
  for (const ingredientId of recipes.keys()) visit(ingredientId);
}

function cleanReferencePriceOperationKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,80}$/.test(value)) throw domainError("ingredient_reference_price_operation_key_invalid", 422);
  return value;
}

function normalizeReferenceEffectiveAt(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = `${value}T00:00:00.000Z`;
  if (!validIsoTimestamp(value)) throw domainError("ingredient_reference_price_effective_at_invalid", 422);
  return value;
}

function referencePriceFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function purchaseOptionPriceSnapshot(option) {
  return {
    purchaseOptionId: option.purchaseOptionId, purchaseOptionSequence: option.sequence,
    label: option.label, purchaseUnit: option.purchaseUnit, innerUnit: option.innerUnit,
    innerUnitsPerPurchaseUnit: option.innerUnitsPerPurchaseUnit, baseUnitsPerInnerUnit: option.baseUnitsPerInnerUnit,
    baseUnitsPerPurchaseUnit: option.baseUnitsPerPurchaseUnit,
  };
}

function recipeCostScenario(cost) {
  return {
    complete: cost.complete, hppRupiah: cost.complete ? cost.hppRupiah : null, knownHppRupiah: cost.hppRupiah,
    grossProfitRupiah: cost.complete ? cost.grossProfitRupiah : null, marginPct: cost.complete ? cost.marginPct : null,
  };
}

function validateStoredPurchaseOption(item, ingredient) {
  if (item.purchaseOptionId !== item.packageId || item.label !== item.packageLabel || item.purchaseUnit !== item.purchaseUom
    || item.baseUnitsPerPurchaseUnit !== item.quantityPerPackage || typeof item.preferred !== "boolean"
    || !["PRICED", "UNPRICED"].includes(item.costStatus)
    || (item.referencePriceRupiah !== null && (!Number.isSafeInteger(item.referencePriceRupiah) || item.referencePriceRupiah <= 0 || item.referencePriceRupiah > 1_000_000_000))
    || (item.unitCostPerBaseUnitRupiah !== null && (!validUnitCost(item.unitCostPerBaseUnitRupiah) || item.unitCostPerBaseUnitRupiah <= 0))
    || (item.referencePriceRupiah === null) !== (item.unitCostPerBaseUnitRupiah === null)
    || item.costStatus !== (item.referencePriceRupiah === null ? "UNPRICED" : "PRICED")
    || (item.referencePriceRupiah !== null && item.unitCostPerBaseUnitRupiah !== roundedUnitCost(item.referencePriceRupiah / item.baseUnitsPerPurchaseUnit))) throw domainError("hpp_state_invalid", 500);
  if (item.innerUnit === null) {
    if (item.innerUnitsPerPurchaseUnit !== null || item.baseUnitsPerInnerUnit !== null) throw domainError("hpp_state_invalid", 500);
  } else if (cleanUom(item.innerUnit) !== item.innerUnit || item.innerUnit === item.purchaseUnit || item.innerUnit === ingredient.baseUnit
    || exactConversionQuantity(item.innerUnitsPerPurchaseUnit) !== item.innerUnitsPerPurchaseUnit
    || exactConversionQuantity(item.baseUnitsPerInnerUnit) !== item.baseUnitsPerInnerUnit
    || roundedConversion(item.innerUnitsPerPurchaseUnit * item.baseUnitsPerInnerUnit) !== item.baseUnitsPerPurchaseUnit) throw domainError("hpp_state_invalid", 500);
}

function normalizePurchaseOptionSnapshot(value, ingredientId, baseUnitsPerPurchaseUnit) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !validStoredText(value.purchaseOptionId, 80)
    || (value.ingredientId !== undefined && value.ingredientId !== ingredientId)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || cleanUom(value.purchaseUnit) !== value.purchaseUnit
    || value.baseUnitsPerPurchaseUnit !== baseUnitsPerPurchaseUnit
    || (value.referencePriceRupiah !== null && (!Number.isSafeInteger(value.referencePriceRupiah) || value.referencePriceRupiah <= 0))) throw domainError("ingredient_purchase_option_snapshot_invalid", 422);
  if (value.innerUnit === null) {
    if (value.innerUnitsPerPurchaseUnit !== null || value.baseUnitsPerInnerUnit !== null) throw domainError("ingredient_purchase_option_snapshot_invalid", 422);
  } else if (cleanUom(value.innerUnit) !== value.innerUnit || exactConversionQuantity(value.innerUnitsPerPurchaseUnit) !== value.innerUnitsPerPurchaseUnit
    || exactConversionQuantity(value.baseUnitsPerInnerUnit) !== value.baseUnitsPerInnerUnit
    || roundedConversion(value.innerUnitsPerPurchaseUnit * value.baseUnitsPerInnerUnit) !== baseUnitsPerPurchaseUnit) throw domainError("ingredient_purchase_option_snapshot_invalid", 422);
  return { ...structuredClone(value), ingredientId };
}

function validateRecipeRecord(recipe, ingredients) {
  if (!recipe || typeof recipe.id !== "string" || typeof recipe.productId !== "string" || !Number.isSafeInteger(recipe.version) || recipe.version < 1 || !Array.isArray(recipe.items)) throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  for (const item of recipe.items) {
    if (!item || !ingredients.has(item.ingredientId) || seen.has(item.ingredientId) || !Number.isFinite(item.qty) || item.qty <= 0) throw domainError("hpp_state_invalid", 500);
    seen.add(item.ingredientId);
  }
}

function validateRecipeDraftRecord(draft, ingredients) {
  if (!draft || typeof draft.id !== "string" || !draft.id || typeof draft.productId !== "string" || !draft.productId
    || !Number.isSafeInteger(draft.version) || draft.version < 1 || !Array.isArray(draft.items)
    || !validIsoTimestamp(draft.createdAt) || !validIsoTimestamp(draft.updatedAt) || typeof draft.actorId !== "string") throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  for (const item of draft.items) {
    if (!item || !ingredients.has(item.ingredientId) || seen.has(item.ingredientId)
      || !Number.isFinite(item.quantity) || item.quantity <= 0 || typeof item.uom !== "string" || !item.uom
      || !Number.isFinite(item.yieldPct) || item.yieldPct <= 0 || item.yieldPct > 100
      || !["INGREDIENT", "PACKAGING"].includes(item.lineType)
      || !Number.isFinite(item.qty) || item.qty <= 0 || Math.round(item.qty * 1000) !== item.qty * 1000
      || !Array.isArray(item.conversionSnapshot)) throw domainError("hpp_state_invalid", 500);
    seen.add(item.ingredientId);
  }
}

function validatePublishedRecipeRecord(published, ingredients) {
  if (!published || typeof published.id !== "string" || !published.id || typeof published.productId !== "string" || !published.productId
    || !Number.isSafeInteger(published.version) || published.version < 1 || typeof published.recipeId !== "string"
    || !Number.isSafeInteger(published.recipeVersion) || published.recipeVersion < 1
    || !Number.isSafeInteger(published.sourceDraftVersion) || published.sourceDraftVersion < 1
    || !Number.isSafeInteger(published.sellingPriceRupiahSnapshot) || published.sellingPriceRupiahSnapshot < 0
    || !Number.isSafeInteger(published.hppRupiahSnapshot) || published.hppRupiahSnapshot < 0
    || !Number.isSafeInteger(published.grossProfitRupiahSnapshot)
    || !Number.isFinite(published.marginPctSnapshot) || !Array.isArray(published.items) || !published.items.length
    || !validIsoTimestamp(published.publishedAt) || typeof published.publishedBy !== "string" || typeof published.reason !== "string" || !published.reason) throw domainError("hpp_state_invalid", 500);
  validateRecipeDraftRecord({ id: published.id, productId: published.productId, version: published.version, items: published.items, createdAt: published.publishedAt, updatedAt: published.publishedAt, actorId: published.publishedBy }, ingredients);
  for (const item of published.items) {
    if (typeof item.ingredientNameSnapshot !== "string" || !item.ingredientNameSnapshot || typeof item.baseUomSnapshot !== "string" || !item.baseUomSnapshot
      || !validUnitCost(item.unitCostRupiahSnapshot) || !Number.isSafeInteger(item.costRupiahSnapshot) || item.costRupiahSnapshot < 0) throw domainError("hpp_state_invalid", 500);
  }
}

function validateModifierRecipeRecord(recipe, ingredients) {
  if (!recipe || !validModifierId(recipe.groupId) || !validModifierId(recipe.optionId) || !Number.isSafeInteger(recipe.version) || recipe.version < 1 || !Array.isArray(recipe.items) || !validIsoTimestamp(recipe.updatedAt)) throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  for (const item of recipe.items) {
    if (!item || !ingredients.has(item.ingredientId) || seen.has(item.ingredientId) || !Number.isFinite(item.qty) || item.qty <= 0 || Math.round(item.qty * 1000) !== item.qty * 1000) throw domainError("hpp_state_invalid", 500);
    seen.add(item.ingredientId);
  }
}

function validateFulfillmentRecipeRecord(recipe, ingredients) {
  if (!recipe || !FULFILLMENT_RECIPE_ORDER_TYPES.has(recipe.orderType) || !FULFILLMENT_RECIPE_STATIONS.has(recipe.station) || !Number.isSafeInteger(recipe.version) || recipe.version < 1 || !Array.isArray(recipe.items) || !validIsoTimestamp(recipe.updatedAt)) throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  for (const item of recipe.items) {
    if (!item || !ingredients.has(item.ingredientId) || seen.has(item.ingredientId) || !Number.isFinite(item.qty) || item.qty <= 0 || Math.round(item.qty * 1000) !== item.qty * 1000) throw domainError("hpp_state_invalid", 500);
    seen.add(item.ingredientId);
  }
}

function validateInventoryBalance(balance, ingredients) {
  if (!balance || !ingredients.has(balance.ingredientId) || !validStoredBalanceQuantity(balance.quantityBase) || !Number.isSafeInteger(balance.inventoryValueRupiah) || balance.inventoryValueRupiah < 0 || !validUnitCost(balance.averageCostPerBaseUnitRupiah)) throw domainError("hpp_state_invalid", 500);
  if (balance.quantityBase === 0 ? balance.inventoryValueRupiah !== 0 : balance.inventoryValueRupiah <= 0 || balance.averageCostPerBaseUnitRupiah !== roundedUnitCost(balance.inventoryValueRupiah / balance.quantityBase)) throw domainError("hpp_state_invalid", 500);
}

function migratePurchaseReceiptV10(receipt) {
  const lines = receipt.lines.map((line) => ({ ...structuredClone(line), itemCostRupiah: line.totalCostRupiah, allocatedFeeRupiah: 0 }));
  const migrated = {
    ...structuredClone(receipt), lines, rejectedLines: [], additionalFees: [],
    totalItemCostRupiah: receipt.totalCostRupiah, totalAdditionalFeesRupiah: 0,
  };
  migrated.fingerprint = purchaseFingerprint(migrated.supplierName, migrated.lines, migrated.rejectedLines, migrated.additionalFees, migrated.purchaseOrderId);
  return migrated;
}

function migratePurchaseReceiptV20(receipt) {
  const migrated = structuredClone(receipt);
  const deliveredByIngredient = new Map();
  for (const line of migrated.lines) {
    deliveredByIngredient.set(line.ingredientId, {
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      deliveredPurchaseQuantity: line.purchaseQuantity,
    });
  }
  for (const line of migrated.rejectedLines) {
    const current = deliveredByIngredient.get(line.ingredientId) ?? {
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      deliveredPurchaseQuantity: 0,
    };
    current.deliveredPurchaseQuantity = roundedQuantity(current.deliveredPurchaseQuantity + line.rejectedPurchaseQuantity);
    deliveredByIngredient.set(line.ingredientId, current);
  }
  migrated.receiptSource = migrated.purchaseOrderId ? "PURCHASE_ORDER" : "AUTHORIZED_UNPLANNED";
  migrated.destinationLocationId = "LEGACY_UNSPECIFIED";
  migrated.quarantineLocationId = null;
  migrated.rejectionLocationId = migrated.rejectedLines.length ? "LEGACY_REJECTED_FLOW" : null;
  migrated.pendingInspectionLocationId = null;
  migrated.deliveredLines = [...deliveredByIngredient.values()].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  migrated.quarantinedLines = [];
  migrated.pendingInspectionLines = [];
  migrated.fingerprint = purchaseFingerprint(
    migrated.supplierName,
    migrated.lines,
    migrated.rejectedLines,
    migrated.additionalFees,
    migrated.purchaseOrderId,
    receivingFingerprintFields(migrated),
  );
  return migrated;
}

function migratePurchaseOrderV20(order) {
  return {
    ...structuredClone(order),
    lines: order.lines.map((line) => ({
      ...line,
      deliveredPurchaseQuantity: roundedQuantity(line.receivedPurchaseQuantity + line.rejectedPurchaseQuantity),
      quarantinedPurchaseQuantity: 0,
      pendingInspectionPurchaseQuantity: 0,
    })),
  };
}

function migratePurchaseReceiptV21(receipt) {
  const migrated = structuredClone(receipt);
  migrated.lots = [];
  migrated.lines = migrated.lines.map((line) => ({ ...line, paidPurchaseQuantity: line.purchaseQuantity, bonusPurchaseQuantity: 0 }));
  migrated.deliveredLines = migrated.deliveredLines.map((line) => ({ ...line, quantityStatus: migrated.purchaseOrderId ? "LEGACY" : "UNPLANNED", orderedRemainingBefore: null, overPurchaseQuantity: 0, underPurchaseQuantity: 0, overReceiptClassification: null }));
  migrated.quarantinedLines = migrated.quarantinedLines.map((line) => ({ ...line, baseUnitsPerPurchaseUnit: null, inspectionUnitCostRupiah: null }));
  migrated.pendingInspectionLines = migrated.pendingInspectionLines.map((line) => ({ ...line, baseUnitsPerPurchaseUnit: null, inspectionUnitCostRupiah: null }));
  migrated.fingerprint = purchaseFingerprint(migrated.supplierName, migrated.lines, migrated.rejectedLines, migrated.additionalFees, migrated.purchaseOrderId, receivingFingerprintFields(migrated));
  return migrated;
}

function migratePurchaseOrderV21(order) {
  return { ...structuredClone(order), lines: order.lines.map((line) => ({ ...line, paidOverPurchaseQuantity: 0, bonusPurchaseQuantity: 0 })) };
}

function migratePurchaseInvoiceV12(invoice) {
  return { ...structuredClone(invoice), approvalHistory: [], payableEntry: null };
}

function migratePurchaseInvoiceV13(invoice) {
  const migrated = structuredClone(invoice);
  if (migrated.payableEntry) migrated.payableEntry = { ...migrated.payableEntry, creditedRupiah: 0 };
  return migrated;
}

function migratePurchaseInvoiceV19(invoice) {
  const migrated = structuredClone(invoice);
  if (migrated.payableEntry) migrated.payableEntry = { ...migrated.payableEntry, paidRupiah: 0 };
  return migrated;
}

function migratePurchaseInvoiceCreditV15(credit) {
  const migrated = { ...structuredClone(credit), supplierReturnId: null, returnReferenceSnapshot: null };
  migrated.fingerprint = purchaseInvoiceCreditFingerprint(migrated.purchaseInvoiceId, null, migrated.creditNoteNumber, migrated.creditDate, migrated.amountRupiah, migrated.creditType, migrated.reason);
  return migrated;
}

function validatePurchaseReceipt(receipt, ingredients) {
  if (!receipt || typeof receipt.id !== "string" || !receipt.id || cleanIdempotencyKey(receipt.idempotencyKey) !== receipt.idempotencyKey || cleanPurchaseText(receipt.supplierName, "hpp_state_invalid") !== receipt.supplierName || !validStoredText(receipt.actorId, 80) || !validStoredText(receipt.reason, 160) || !validIsoTimestamp(receipt.receivedAt) || typeof receipt.fingerprint !== "string" || !receipt.fingerprint
    || !["PURCHASE_ORDER", "AUTHORIZED_UNPLANNED"].includes(receipt.receiptSource) || !validStoredText(receipt.destinationLocationId, 80)
    || !Array.isArray(receipt.lines) || receipt.lines.length > 100 || !Array.isArray(receipt.deliveredLines) || !receipt.deliveredLines.length || receipt.deliveredLines.length > 100
    || !Array.isArray(receipt.rejectedLines) || receipt.rejectedLines.length > 100 || !Array.isArray(receipt.quarantinedLines) || receipt.quarantinedLines.length > 100
    || !Array.isArray(receipt.pendingInspectionLines) || receipt.pendingInspectionLines.length > 100 || !Array.isArray(receipt.lots) || receipt.lots.length > 500 || !Array.isArray(receipt.additionalFees)
    || !Number.isSafeInteger(receipt.totalItemCostRupiah) || receipt.totalItemCostRupiah < 0 || !Number.isSafeInteger(receipt.totalAdditionalFeesRupiah) || receipt.totalAdditionalFeesRupiah < 0 || !Number.isSafeInteger(receipt.totalCostRupiah) || receipt.totalCostRupiah < 0 || !Number.isSafeInteger(receipt.version) || receipt.version < 2) throw domainError("hpp_state_invalid", 500);
  if (receipt.businessDate !== undefined && !validBusinessDate(receipt.businessDate)) throw domainError("hpp_state_invalid", 500);
  if ((receipt.purchaseOrderId !== undefined && !validStoredText(receipt.purchaseOrderId, 80)) || (receipt.supplierId !== undefined && !validStoredText(receipt.supplierId, 80)) || (receipt.purchaseOrderId === undefined) !== (receipt.supplierId === undefined)) throw domainError("hpp_state_invalid", 500);
  if ((receipt.receiptSource === "PURCHASE_ORDER") !== (receipt.purchaseOrderId !== undefined)) throw domainError("hpp_state_invalid", 500);
  if ((receipt.quarantinedLines.length > 0 ? !validStoredText(receipt.quarantineLocationId, 80) : receipt.quarantineLocationId !== null)
    || (receipt.rejectedLines.length > 0 ? !validStoredText(receipt.rejectionLocationId, 80) : receipt.rejectionLocationId !== null)
    || (receipt.pendingInspectionLines.length > 0 ? !validStoredText(receipt.pendingInspectionLocationId, 80) : receipt.pendingInspectionLocationId !== null)) throw domainError("hpp_state_invalid", 500);
  let itemTotal = 0;
  let acquisitionTotal = 0;
  const seen = new Set();
  for (const line of receipt.lines) {
    if (!line || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel || !validQuantity(line.purchaseQuantity) || !validQuantity(line.baseUnitsPerPurchaseUnit) || !validReceiptBaseQuantity(line.baseQuantity) || line.baseQuantity !== roundedQuantity(line.purchaseQuantity * line.baseUnitsPerPurchaseUnit)
      || !validBalanceQuantity(line.paidPurchaseQuantity) || !validBalanceQuantity(line.bonusPurchaseQuantity) || roundedQuantity(line.paidPurchaseQuantity + line.bonusPurchaseQuantity) !== line.purchaseQuantity
      || !Number.isSafeInteger(line.itemCostRupiah) || line.itemCostRupiah < 0 || (line.paidPurchaseQuantity > 0 && line.itemCostRupiah <= 0) || !Number.isSafeInteger(line.allocatedFeeRupiah) || line.allocatedFeeRupiah < 0 || !Number.isSafeInteger(line.totalCostRupiah) || line.totalCostRupiah !== line.itemCostRupiah + line.allocatedFeeRupiah) throw domainError("hpp_state_invalid", 500);
    if (line.purchaseOptionSnapshot !== undefined) {
      try { normalizePurchaseOptionSnapshot(line.purchaseOptionSnapshot, line.ingredientId, line.baseUnitsPerPurchaseUnit); } catch { throw domainError("hpp_state_invalid", 500); }
    }
    seen.add(line.ingredientId);
    itemTotal += line.itemCostRupiah;
    acquisitionTotal += line.totalCostRupiah;
  }
  const rejectedSeen = new Set();
  for (const line of receipt.rejectedLines) {
    if (!line || !ingredients.has(line.ingredientId) || rejectedSeen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel || !validQuantity(line.rejectedPurchaseQuantity) || !PURCHASE_REJECTION_REASONS.has(line.rejectionReason)) throw domainError("hpp_state_invalid", 500);
    rejectedSeen.add(line.ingredientId);
  }
  const quarantinedSeen = new Set();
  for (const line of receipt.quarantinedLines) {
    if (!line || !ingredients.has(line.ingredientId) || quarantinedSeen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel || !validQuantity(line.quarantinedPurchaseQuantity)
      || (line.baseUnitsPerPurchaseUnit !== null && !validQuantity(line.baseUnitsPerPurchaseUnit)) || (line.inspectionUnitCostRupiah !== null && (!validUnitCost(line.inspectionUnitCostRupiah) || line.inspectionUnitCostRupiah <= 0))) throw domainError("hpp_state_invalid", 500);
    quarantinedSeen.add(line.ingredientId);
  }
  const pendingSeen = new Set();
  for (const line of receipt.pendingInspectionLines) {
    if (!line || !ingredients.has(line.ingredientId) || pendingSeen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel || !validQuantity(line.pendingInspectionPurchaseQuantity)
      || (line.baseUnitsPerPurchaseUnit !== null && !validQuantity(line.baseUnitsPerPurchaseUnit)) || (line.inspectionUnitCostRupiah !== null && (!validUnitCost(line.inspectionUnitCostRupiah) || line.inspectionUnitCostRupiah <= 0))) throw domainError("hpp_state_invalid", 500);
    pendingSeen.add(line.ingredientId);
  }
  const deliveredSeen = new Set();
  for (const line of receipt.deliveredLines) {
    if (!line || !ingredients.has(line.ingredientId) || deliveredSeen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel || !validQuantity(line.deliveredPurchaseQuantity)
      || !["UNDER", "EXACT", "OVER_PAID", "OVER_BONUS", "UNPLANNED", "LEGACY"].includes(line.quantityStatus)
      || (line.orderedRemainingBefore !== null && !validBalanceQuantity(line.orderedRemainingBefore)) || !validBalanceQuantity(line.overPurchaseQuantity) || !validBalanceQuantity(line.underPurchaseQuantity)
      || (line.overReceiptClassification !== null && !["PAID", "BONUS"].includes(line.overReceiptClassification))) throw domainError("hpp_state_invalid", 500);
    const accepted = receipt.lines.find((item) => item.ingredientId === line.ingredientId)?.purchaseQuantity ?? 0;
    const rejected = receipt.rejectedLines.find((item) => item.ingredientId === line.ingredientId)?.rejectedPurchaseQuantity ?? 0;
    const quarantined = receipt.quarantinedLines.find((item) => item.ingredientId === line.ingredientId)?.quarantinedPurchaseQuantity ?? 0;
    const pending = receipt.pendingInspectionLines.find((item) => item.ingredientId === line.ingredientId)?.pendingInspectionPurchaseQuantity ?? 0;
    if (line.deliveredPurchaseQuantity !== roundedQuantity(accepted + rejected + quarantined + pending)) throw domainError("hpp_state_invalid", 500);
    deliveredSeen.add(line.ingredientId);
  }
  const dispositionIds = new Set([...seen, ...rejectedSeen, ...quarantinedSeen, ...pendingSeen]);
  if (dispositionIds.size !== deliveredSeen.size || [...dispositionIds].some((ingredientId) => !deliveredSeen.has(ingredientId))) throw domainError("hpp_state_invalid", 500);
  validateStoredPurchaseLots(receipt, ingredients);
  let feeTotal = 0;
  const feeTypes = new Set();
  for (const fee of receipt.additionalFees) {
    if (!fee || !PURCHASE_FEE_TYPES.has(fee.type) || feeTypes.has(fee.type) || !Number.isSafeInteger(fee.amountRupiah) || fee.amountRupiah <= 0 || fee.amountRupiah > 1_000_000_000) throw domainError("hpp_state_invalid", 500);
    feeTypes.add(fee.type);
    feeTotal += fee.amountRupiah;
  }
  if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(acquisitionTotal) || !Number.isSafeInteger(feeTotal) || itemTotal !== receipt.totalItemCostRupiah || feeTotal !== receipt.totalAdditionalFeesRupiah || acquisitionTotal !== receipt.totalCostRupiah || receipt.totalCostRupiah !== receipt.totalItemCostRupiah + receipt.totalAdditionalFeesRupiah || receipt.lines.reduce((sum, line) => sum + line.allocatedFeeRupiah, 0) !== feeTotal || (feeTotal > 0 && !receipt.lines.length)) throw domainError("hpp_state_invalid", 500);
  const expectedFingerprint = purchaseFingerprint(receipt.supplierName, receipt.lines, receipt.rejectedLines, receipt.additionalFees, receipt.purchaseOrderId, receivingFingerprintFields(receipt));
  if (receipt.fingerprint !== expectedFingerprint) throw domainError("hpp_state_invalid", 500);
}

function inspectionDecisionFingerprint(input) {
  return JSON.stringify({ purchaseReceiptId: input.purchaseReceiptId, ingredientId: input.ingredientId, lotCode: input.lotCode, sourceDisposition: input.sourceDisposition, decision: input.decision, purchaseQuantity: input.purchaseQuantity, destinationLocationId: input.destinationLocationId, reason: typeof input.reason === "string" ? input.reason.trim() : input.reason });
}

function inspectionSourceQuantity(receipt, ingredientId, lotCode, sourceDisposition) {
  const field = sourceDisposition === "QUARANTINED" ? "quarantinedPurchaseQuantity" : "pendingInspectionPurchaseQuantity";
  if (lotCode !== null) return receipt.lots.find((lot) => lot.ingredientId === ingredientId && lot.lotCode === lotCode)?.[field] ?? 0;
  const lines = sourceDisposition === "QUARANTINED" ? receipt.quarantinedLines : receipt.pendingInspectionLines;
  return lines.find((line) => line.ingredientId === ingredientId)?.[field] ?? 0;
}

function validatePurchaseReceiptInspectionDecision(item, receipts, ingredients) {
  const receipt = receipts.find((candidate) => candidate.id === item?.purchaseReceiptId);
  if (!item || !receipt || !ingredients.has(item.ingredientId) || !validStoredText(item.id, 80) || cleanIdempotencyKey(item.idempotencyKey) !== item.idempotencyKey
    || (item.purchaseOrderId !== (receipt.purchaseOrderId ?? null)) || !["QUARANTINED", "PENDING_INSPECTION"].includes(item.sourceDisposition) || !["ACCEPT", "REJECT"].includes(item.decision)
    || (item.lotCode !== null && !validStoredText(item.lotCode, 80)) || !validQuantity(item.purchaseQuantity) || !validReceiptBaseQuantity(item.baseQuantity)
    || !Number.isSafeInteger(item.inventoryValueRupiah) || item.inventoryValueRupiah < 0 || (item.decision === "REJECT" && item.inventoryValueRupiah !== 0)
    || !validStoredText(item.destinationLocationId, 80) || !validIsoTimestamp(item.occurredAt) || !validStoredText(item.actorId, 80) || !validStoredText(item.reason, 160)
    || !Number.isSafeInteger(item.version) || item.version <= receipt.version) throw domainError("hpp_state_invalid", 500);
  const heldLine = (item.sourceDisposition === "QUARANTINED" ? receipt.quarantinedLines : receipt.pendingInspectionLines).find((line) => line.ingredientId === item.ingredientId);
  if (!heldLine || !validQuantity(heldLine.baseUnitsPerPurchaseUnit) || item.baseQuantity !== roundedQuantity(item.purchaseQuantity * heldLine.baseUnitsPerPurchaseUnit)
    || (item.decision === "ACCEPT" && item.inventoryValueRupiah !== Math.round(item.purchaseQuantity * heldLine.inspectionUnitCostRupiah))
    || item.fingerprint !== inspectionDecisionFingerprint(item)) throw domainError("hpp_state_invalid", 500);
}

function validatePurchaseInspectionTotals(decisions, receipts) {
  const totals = new Map();
  for (const item of decisions) {
    const key = `${item.purchaseReceiptId}\u0000${item.ingredientId}\u0000${item.lotCode ?? ""}\u0000${item.sourceDisposition}`;
    totals.set(key, roundedQuantity((totals.get(key) ?? 0) + item.purchaseQuantity));
    const receipt = receipts.find((candidate) => candidate.id === item.purchaseReceiptId);
    if (totals.get(key) > inspectionSourceQuantity(receipt, item.ingredientId, item.lotCode, item.sourceDisposition)) throw domainError("hpp_state_invalid", 500);
  }
}

function validatePurchaseInvoice(invoice, purchaseOrders, purchaseReceipts, priorInvoices, inspectionDecisions = []) {
  if (!invoice || typeof invoice.id !== "string" || !invoice.id || cleanIdempotencyKey(invoice.idempotencyKey) !== invoice.idempotencyKey || typeof invoice.fingerprint !== "string" || !invoice.fingerprint
    || !validStoredText(invoice.purchaseOrderId, 80) || !validStoredText(invoice.supplierId, 80) || !validStoredText(invoice.supplierNameSnapshot, 80)
    || !validStoredText(invoice.invoiceNumber, 80) || !validBusinessDate(invoice.invoiceDate) || !validBusinessDate(invoice.dueDate) || invoice.dueDate < invoice.invoiceDate
    || !Number.isSafeInteger(invoice.receiptVersionThrough) || invoice.receiptVersionThrough < 2 || invoice.receiptVersionThrough >= invoice.version
    || !Array.isArray(invoice.lines) || !invoice.lines.length || invoice.lines.length > 100 || !Array.isArray(invoice.additionalFees) || invoice.additionalFees.length > 10
    || !Number.isSafeInteger(invoice.subtotalRupiah) || invoice.subtotalRupiah <= 0 || !Number.isSafeInteger(invoice.totalAdditionalFeesRupiah) || invoice.totalAdditionalFeesRupiah < 0
    || !Number.isSafeInteger(invoice.totalInvoiceRupiah) || invoice.totalInvoiceRupiah <= 0 || !Number.isSafeInteger(invoice.expectedMatchedTotalRupiah) || invoice.expectedMatchedTotalRupiah <= 0
    || !Number.isSafeInteger(invoice.totalVarianceRupiah) || !["MATCHED", "EXCEPTION"].includes(invoice.matchStatus)
    || !["READY_FOR_APPROVAL", "VARIANCE_REVIEW_REQUIRED", "BLOCKED", "APPROVED_NOT_POSTED", "REJECTED", "POSTED_UNPAID"].includes(invoice.paymentReadiness)
    || !Array.isArray(invoice.approvalHistory) || invoice.approvalHistory.length > 20 || !validIsoTimestamp(invoice.recordedAt)
    || !validStoredText(invoice.actorId, 80) || !validStoredText(invoice.reason, 160) || !Number.isSafeInteger(invoice.version) || invoice.version < 2) throw domainError("hpp_state_invalid", 500);
  const order = purchaseOrders.find((item) => item.id === invoice.purchaseOrderId);
  if (!order || invoice.supplierId !== order.supplierId || invoice.supplierNameSnapshot !== order.supplierNameSnapshot) throw domainError("hpp_state_invalid", 500);
  const requestLines = invoice.lines.map((line) => ({ ingredientId: line.ingredientId, invoiceQuantity: line.invoiceQuantity, unitPriceRupiah: line.unitPriceRupiah, invoiceLineTotalRupiah: line.invoiceLineTotalRupiah }));
  let normalizedLines;
  let normalizedFees;
  try {
    normalizedLines = normalizePurchaseInvoiceLines(requestLines, order);
    normalizedFees = normalizePurchaseFees(invoice.additionalFees.map((fee) => ({ type: fee.type, amountRupiah: fee.amountRupiah })));
  } catch {
    throw domainError("hpp_state_invalid", 500);
  }
  if (invoice.fingerprint !== purchaseInvoiceFingerprint(order.id, invoice.invoiceNumber, invoice.invoiceDate, invoice.dueDate, normalizedLines, normalizedFees, invoice.totalInvoiceRupiah)) throw domainError("hpp_state_invalid", 500);
  const invoiceReceipts = purchaseReceipts.filter((receipt) => receipt.purchaseOrderId === order.id && receipt.version <= invoice.receiptVersionThrough);
  if (!invoiceReceipts.length || Math.max(...invoiceReceipts.map((receipt) => receipt.version)) !== invoice.receiptVersionThrough) throw domainError("hpp_state_invalid", 500);
  const previousMatched = priorInvoices.filter((item) => item.purchaseOrderId === order.id && item.matchStatus === "MATCHED");
  const match = calculatePurchaseInvoiceMatch(order, invoiceReceipts, previousMatched, normalizedLines, normalizedFees, inspectionDecisions.filter((item) => item.version < invoice.version));
  if (purchaseInvoiceLineEvidenceFingerprint(invoice.lines) !== purchaseInvoiceLineEvidenceFingerprint(match.lines)
    || purchaseInvoiceFeeEvidenceFingerprint(invoice.additionalFees) !== purchaseInvoiceFeeEvidenceFingerprint(match.additionalFees)
    || invoice.subtotalRupiah !== normalizedLines.reduce((sum, line) => sum + line.invoiceLineTotalRupiah, 0)
    || invoice.totalAdditionalFeesRupiah !== normalizedFees.reduce((sum, fee) => sum + fee.amountRupiah, 0)
    || invoice.totalInvoiceRupiah !== invoice.subtotalRupiah + invoice.totalAdditionalFeesRupiah
    || invoice.expectedMatchedTotalRupiah !== match.expectedMatchedTotalRupiah || invoice.totalVarianceRupiah !== invoice.totalInvoiceRupiah - match.expectedMatchedTotalRupiah
    || invoice.matchStatus !== match.matchStatus) throw domainError("hpp_state_invalid", 500);
  validatePurchaseInvoiceWorkflow(invoice);
}

function validatePurchaseInvoiceWorkflow(invoice) {
  let status = purchaseInvoiceInitialReadiness(invoice);
  let approvedBy = null;
  let previousVersion = invoice.version;
  const keys = new Set();
  for (const transition of invoice.approvalHistory) {
    if (!transition || cleanIdempotencyKey(transition.idempotencyKey) !== transition.idempotencyKey || keys.has(transition.idempotencyKey)
      || !["APPROVED", "REJECTED", "POSTED"].includes(transition.action) || transition.fromStatus !== status
      || !validStoredText(transition.actorId, 80) || !["finance", "owner"].includes(transition.actorRole)
      || !validStoredText(transition.reason, 160) || !validIsoTimestamp(transition.occurredAt)
      || !Number.isSafeInteger(transition.version) || transition.version <= previousVersion
      || transition.fingerprint !== purchaseInvoiceActionFingerprint(invoice.id, transition.action, transition.reason)) throw domainError("hpp_state_invalid", 500);
    if (transition.action === "APPROVED" || transition.action === "REJECTED") {
      const expectedTo = transition.action === "APPROVED" ? "APPROVED_NOT_POSTED" : "REJECTED";
      if (!["READY_FOR_APPROVAL", "VARIANCE_REVIEW_REQUIRED"].includes(status) || transition.toStatus !== expectedTo || transition.actorRole !== "finance" || transition.actorId === invoice.actorId) throw domainError("hpp_state_invalid", 500);
      approvedBy = transition.action === "APPROVED" ? transition.actorId : null;
    } else if (status !== "APPROVED_NOT_POSTED" || transition.toStatus !== "POSTED_UNPAID" || transition.actorRole !== "owner" || !approvedBy || transition.actorId === approvedBy) throw domainError("hpp_state_invalid", 500);
    keys.add(transition.idempotencyKey);
    previousVersion = transition.version;
    status = transition.toStatus;
  }
  if (invoice.paymentReadiness !== status) throw domainError("hpp_state_invalid", 500);
  if (status === "POSTED_UNPAID") {
    const entry = invoice.payableEntry;
    const posted = invoice.approvalHistory.at(-1);
    if (!entry || !["OPEN", "PARTIALLY_CREDITED", "CLOSED_BY_CREDIT", "PARTIALLY_PAID", "PARTIALLY_PAID_AND_CREDITED", "PAID", "CLOSED_BY_CREDIT_AND_PAYMENT"].includes(entry.status) || entry.amountRupiah !== invoice.totalInvoiceRupiah
      || !Number.isSafeInteger(entry.creditedRupiah) || entry.creditedRupiah < 0 || !Number.isSafeInteger(entry.paidRupiah) || entry.paidRupiah < 0 || !Number.isSafeInteger(entry.outstandingRupiah) || entry.outstandingRupiah < 0
      || entry.creditedRupiah + entry.paidRupiah + entry.outstandingRupiah !== entry.amountRupiah
      || entry.dueDate !== invoice.dueDate || entry.supplierId !== invoice.supplierId || entry.supplierNameSnapshot !== invoice.supplierNameSnapshot
      || entry.postedAt !== posted.occurredAt || entry.postedByActorId !== posted.actorId) throw domainError("hpp_state_invalid", 500);
  } else if (invoice.payableEntry !== null) throw domainError("hpp_state_invalid", 500);
}

function validatePurchaseInvoiceCredit(credit, invoices) {
  if (!credit || typeof credit.id !== "string" || !credit.id || cleanIdempotencyKey(credit.idempotencyKey) !== credit.idempotencyKey
    || !validStoredText(credit.purchaseInvoiceId, 80) || !validStoredText(credit.supplierId, 80) || !validStoredText(credit.supplierNameSnapshot, 80)
    || !validStoredText(credit.creditNoteNumber, 80) || !validBusinessDate(credit.creditDate) || !Number.isSafeInteger(credit.amountRupiah) || credit.amountRupiah <= 0
    || !PURCHASE_CREDIT_TYPES.has(credit.creditType) || !["PENDING_OWNER_POST", "POSTED", "REVERSED"].includes(credit.status)
    || !validStoredText(credit.createdByActorId, 80) || credit.createdByRole !== "finance" || !validStoredText(credit.reason, 160)
    || !validIsoTimestamp(credit.createdAt) || !Number.isSafeInteger(credit.version) || credit.version < 2
    || (credit.supplierReturnId !== null && !validStoredText(credit.supplierReturnId, 80))
    || (credit.returnReferenceSnapshot !== null && !validStoredText(credit.returnReferenceSnapshot, 80))
    || !Array.isArray(credit.reversalHistory) || credit.reversalHistory.length > 20
    || credit.fingerprint !== purchaseInvoiceCreditFingerprint(credit.purchaseInvoiceId, credit.supplierReturnId, credit.creditNoteNumber, credit.creditDate, credit.amountRupiah, credit.creditType, credit.reason)) throw domainError("hpp_state_invalid", 500);
  const invoice = invoices.find((item) => item.id === credit.purchaseInvoiceId);
  if (!invoice?.payableEntry || invoice.paymentReadiness !== "POSTED_UNPAID" || credit.supplierId !== invoice.supplierId || credit.supplierNameSnapshot !== invoice.supplierNameSnapshot || credit.creditDate < invoice.invoiceDate || credit.version <= invoice.approvalHistory.at(-1).version) throw domainError("hpp_state_invalid", 500);
  if (["POSTED", "REVERSED"].includes(credit.status)) {
    const post = credit.postTransition;
    if (!post || cleanIdempotencyKey(post.idempotencyKey) !== post.idempotencyKey || post.fingerprint !== purchaseInvoiceCreditPostFingerprint(credit.id, post.reason)
      || !validStoredText(post.actorId, 80) || post.actorRole !== "owner" || post.actorId === credit.createdByActorId || !validStoredText(post.reason, 160)
      || !validIsoTimestamp(post.occurredAt) || !Number.isSafeInteger(post.version) || post.version <= credit.version) throw domainError("hpp_state_invalid", 500);
  } else if (credit.postTransition !== null) throw domainError("hpp_state_invalid", 500);
  validatePurchaseInvoiceCreditReversalHistory(credit);
}

function validatePurchaseInvoiceCreditReversalHistory(credit) {
  if (credit.status === "PENDING_OWNER_POST" && credit.reversalHistory.length) throw domainError("hpp_state_invalid", 500);
  const ids = new Set();
  const requestKeys = new Set();
  const decisionKeys = new Set();
  let previousVersion = credit.postTransition?.version ?? credit.version;
  let approvedCount = 0;
  let pendingCount = 0;
  for (const reversal of credit.reversalHistory) {
    if (!reversal || !validStoredText(reversal.id, 80) || ids.has(reversal.id)
      || cleanIdempotencyKey(reversal.requestIdempotencyKey) !== reversal.requestIdempotencyKey || requestKeys.has(reversal.requestIdempotencyKey)
      || reversal.requestFingerprint !== purchaseInvoiceCreditReversalRequestFingerprint(credit.id, reversal.requestReason)
      || !validStoredText(reversal.requestedByActorId, 80) || reversal.requestedByRole !== "finance" || !validStoredText(reversal.requestReason, 160)
      || !validIsoTimestamp(reversal.requestedAt) || !Number.isSafeInteger(reversal.requestVersion) || reversal.requestVersion <= previousVersion
      || !["PENDING_OWNER_DECISION", "APPROVED", "REJECTED"].includes(reversal.status)) throw domainError("hpp_state_invalid", 500);
    ids.add(reversal.id); requestKeys.add(reversal.requestIdempotencyKey); previousVersion = reversal.requestVersion;
    if (reversal.status === "PENDING_OWNER_DECISION") {
      if (reversal.decision !== null) throw domainError("hpp_state_invalid", 500);
      pendingCount += 1;
      continue;
    }
    const decision = reversal.decision;
    const expectedDecision = reversal.status === "APPROVED" ? "APPROVE" : "REJECT";
    if (!decision || cleanIdempotencyKey(decision.idempotencyKey) !== decision.idempotencyKey || decisionKeys.has(decision.idempotencyKey)
      || decision.fingerprint !== purchaseInvoiceCreditReversalDecisionFingerprint(credit.id, expectedDecision, decision.reason)
      || decision.decision !== expectedDecision || !validStoredText(decision.actorId, 80) || decision.actorRole !== "owner" || decision.actorId === reversal.requestedByActorId
      || !validStoredText(decision.reason, 160) || !validIsoTimestamp(decision.occurredAt) || decision.occurredAt < reversal.requestedAt
      || !Number.isSafeInteger(decision.version) || decision.version <= previousVersion) throw domainError("hpp_state_invalid", 500);
    decisionKeys.add(decision.idempotencyKey); previousVersion = decision.version;
    if (reversal.status === "APPROVED") approvedCount += 1;
  }
  if (pendingCount > 1 || approvedCount > 1 || (pendingCount && credit.reversalHistory.at(-1)?.status !== "PENDING_OWNER_DECISION")
    || (approvedCount && credit.reversalHistory.at(-1)?.status !== "APPROVED")
    || (credit.status === "REVERSED") !== (approvedCount === 1)) throw domainError("hpp_state_invalid", 500);
}

function validatePurchaseInvoicePayment(payment, invoices) {
  if (!payment || typeof payment.id !== "string" || !payment.id || cleanIdempotencyKey(payment.idempotencyKey) !== payment.idempotencyKey
    || !validStoredText(payment.purchaseInvoiceId, 80) || !validStoredText(payment.supplierId, 80) || !validStoredText(payment.supplierNameSnapshot, 80)
    || !validBusinessDate(payment.paidDate) || !Number.isSafeInteger(payment.amountRupiah) || payment.amountRupiah <= 0
    || !PURCHASE_PAYMENT_METHODS.has(payment.method) || !validStoredText(payment.reference, 80) || payment.status !== "RECORDED"
    || !validStoredText(payment.recordedByActorId, 80) || payment.recordedByRole !== "owner" || !validStoredText(payment.reason, 160)
    || !validIsoTimestamp(payment.recordedAt) || !Number.isSafeInteger(payment.version) || payment.version < 2
    || payment.fingerprint !== purchaseInvoicePaymentFingerprint(payment.purchaseInvoiceId, payment.paidDate, payment.amountRupiah, payment.method, payment.reference, payment.reason)) throw domainError("hpp_state_invalid", 500);
  const invoice = invoices.find((item) => item.id === payment.purchaseInvoiceId);
  if (!invoice?.payableEntry || invoice.paymentReadiness !== "POSTED_UNPAID" || payment.supplierId !== invoice.supplierId || payment.supplierNameSnapshot !== invoice.supplierNameSnapshot || payment.paidDate < invoice.invoiceDate || payment.version <= invoice.approvalHistory.at(-1).version) throw domainError("hpp_state_invalid", 500);
}

function validateSupplierReturnCreditLinks(returns, credits, invoices) {
  const linkedReturnIds = new Set();
  for (const credit of credits) {
    if (credit.creditType !== "GOODS_RETURN") {
      if (credit.supplierReturnId !== null || credit.returnReferenceSnapshot !== null) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    const supplierReturn = returns.find((item) => item.id === credit.supplierReturnId);
    const invoice = invoices.find((item) => item.id === credit.purchaseInvoiceId);
    if (!supplierReturn || !invoice
      || supplierReturn.disposition !== "CREDIT_EXPECTED" || supplierReturn.supplierId !== credit.supplierId
      || supplierReturn.purchaseOrderId !== invoice.purchaseOrderId || supplierReturn.returnReference !== credit.returnReferenceSnapshot
      || supplierReturn.totalReturnValueRupiah !== credit.amountRupiah) throw domainError("hpp_state_invalid", 500);
    if (credit.status === "REVERSED") continue;
    if (linkedReturnIds.has(supplierReturn.id) || supplierReturn.creditMemoId !== credit.id
      || supplierReturn.status !== (credit.status === "POSTED" ? "CREDIT_POSTED" : "CREDIT_RECEIVED_PENDING_POST")) throw domainError("hpp_state_invalid", 500);
    linkedReturnIds.add(supplierReturn.id);
  }
  for (const supplierReturn of returns) {
    if (supplierReturn.disposition === "REPLACEMENT_EXPECTED") {
      if (supplierReturn.creditMemoId !== null) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    if (supplierReturn.status === "SHIPPED_AWAITING_CREDIT") {
      if (supplierReturn.creditMemoId !== null) throw domainError("hpp_state_invalid", 500);
    } else if (!linkedReturnIds.has(supplierReturn.id)) throw domainError("hpp_state_invalid", 500);
  }
}

function validatePurchaseInvoiceCreditBalances(invoices, credits, payments = []) {
  for (const invoice of invoices) {
    const related = credits.filter((credit) => credit.purchaseInvoiceId === invoice.id);
    const relatedPayments = payments.filter((payment) => payment.purchaseInvoiceId === invoice.id);
    if (!invoice.payableEntry) {
      if (related.length || relatedPayments.length) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    const postedRupiah = related.filter((credit) => credit.status === "POSTED").reduce((sum, credit) => sum + credit.amountRupiah, 0);
    const pendingRupiah = related.filter((credit) => credit.status === "PENDING_OWNER_POST").reduce((sum, credit) => sum + credit.amountRupiah, 0);
    const paidRupiah = relatedPayments.reduce((sum, payment) => sum + payment.amountRupiah, 0);
    const expectedOutstanding = invoice.payableEntry.amountRupiah - postedRupiah - paidRupiah;
    const expectedStatus = payableStatus(postedRupiah, paidRupiah, expectedOutstanding);
    if (!Number.isSafeInteger(postedRupiah) || !Number.isSafeInteger(pendingRupiah) || !Number.isSafeInteger(paidRupiah) || postedRupiah + paidRupiah + pendingRupiah > invoice.payableEntry.amountRupiah
      || invoice.payableEntry.creditedRupiah !== postedRupiah || invoice.payableEntry.paidRupiah !== paidRupiah || invoice.payableEntry.outstandingRupiah !== expectedOutstanding || invoice.payableEntry.status !== expectedStatus) throw domainError("hpp_state_invalid", 500);
  }
}

function validateSupplierReturns(returns, receipts, suppliers, ingredients, eventVersions) {
  const ids = new Set();
  const keys = new Set();
  const supplierReferences = new Set();
  const replacementReferences = new Set();
  const cumulative = new Map();
  for (const item of returns.slice().sort((a, b) => a.version - b.version)) {
    if (!item || typeof item.id !== "string" || !item.id || cleanIdempotencyKey(item.idempotencyKey) !== item.idempotencyKey || ids.has(item.id) || keys.has(item.idempotencyKey)
      || !validStoredText(item.purchaseReceiptId, 80) || !validStoredText(item.purchaseOrderId, 80) || !validStoredText(item.supplierId, 80) || !validStoredText(item.supplierNameSnapshot, 80)
      || !validStoredText(item.returnReference, 80) || !SUPPLIER_RETURN_DISPOSITIONS.has(item.disposition) || !["SHIPPED_AWAITING_CREDIT", "CREDIT_RECEIVED_PENDING_POST", "CREDIT_POSTED", "SHIPPED_AWAITING_REPLACEMENT", "REPLACED"].includes(item.status)
      || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 100 || !Number.isSafeInteger(item.totalReturnValueRupiah) || item.totalReturnValueRupiah <= 0
      || !validIsoTimestamp(item.shippedAt) || !validStoredText(item.actorId, 80) || item.actorRole !== "owner" || !validStoredText(item.reason, 160)
      || !Number.isSafeInteger(item.version) || item.version < 2 || eventVersions.has(item.version)) throw domainError("hpp_state_invalid", 500);
    const receipt = receipts.find((candidate) => candidate.id === item.purchaseReceiptId);
    const supplier = suppliers.find((candidate) => candidate.id === item.supplierId);
    if (!receipt || receipt.purchaseOrderId !== item.purchaseOrderId || receipt.supplierId !== item.supplierId || receipt.supplierName !== item.supplierNameSnapshot || !supplier) throw domainError("hpp_state_invalid", 500);
    const seen = new Set();
    let total = 0;
    for (const line of item.lines) {
      const receiptLine = receipt.lines.find((candidate) => candidate.ingredientId === line.ingredientId);
      const cumulativeKey = `${receipt.id}\u0000${line.ingredientId}`;
      const previous = cumulative.get(cumulativeKey) ?? { purchaseQuantity: 0, baseQuantity: 0, valueRupiah: 0 };
      if (!receiptLine || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || line.purchaseUnitLabel !== receiptLine.purchaseUnitLabel
        || line.baseUnitsPerPurchaseUnit !== receiptLine.baseUnitsPerPurchaseUnit || !validMovementQuantity(line.returnPurchaseQuantity, false)
        || line.baseQuantity !== roundedQuantity(line.returnPurchaseQuantity * line.baseUnitsPerPurchaseUnit) || !Number.isSafeInteger(line.returnValueRupiah) || line.returnValueRupiah <= 0
        || !validUnitCost(line.unitCostSnapshotRupiah) || line.unitCostSnapshotRupiah !== roundedUnitCost(line.returnValueRupiah / line.baseQuantity)) throw domainError("hpp_state_invalid", 500);
      const next = { purchaseQuantity: roundedQuantity(previous.purchaseQuantity + line.returnPurchaseQuantity), baseQuantity: roundedQuantity(previous.baseQuantity + line.baseQuantity), valueRupiah: previous.valueRupiah + line.returnValueRupiah };
      if (next.purchaseQuantity > receiptLine.purchaseQuantity || next.baseQuantity > receiptLine.baseQuantity || next.valueRupiah > receiptLine.totalCostRupiah) throw domainError("hpp_state_invalid", 500);
      cumulative.set(cumulativeKey, next); seen.add(line.ingredientId); total += line.returnValueRupiah;
    }
    if (total !== item.totalReturnValueRupiah || item.fingerprint !== supplierReturnFingerprint(item.purchaseReceiptId, item.returnReference, item.disposition, item.lines, item.reason)) throw domainError("hpp_state_invalid", 500);
    const supplierReference = `${item.supplierId}\u0000${item.returnReference.toLocaleLowerCase("id")}`;
    if (supplierReferences.has(supplierReference)) throw domainError("hpp_state_invalid", 500);
    supplierReferences.add(supplierReference); ids.add(item.id); keys.add(item.idempotencyKey); eventVersions.add(item.version);
    if (item.disposition === "CREDIT_EXPECTED") {
      if (!["SHIPPED_AWAITING_CREDIT", "CREDIT_RECEIVED_PENDING_POST", "CREDIT_POSTED"].includes(item.status) || item.replacementReceipt !== null || (item.creditMemoId !== null && !validStoredText(item.creditMemoId, 80))) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    if (item.creditMemoId !== null) throw domainError("hpp_state_invalid", 500);
    if (item.status === "SHIPPED_AWAITING_REPLACEMENT") {
      if (item.replacementReceipt !== null) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    const replacement = item.replacementReceipt;
    if (!replacement || cleanIdempotencyKey(replacement.idempotencyKey) !== replacement.idempotencyKey || keys.has(replacement.idempotencyKey)
      || replacement.fingerprint !== supplierReplacementFingerprint(item.id, replacement.receiptReference, replacement.reason) || !validStoredText(replacement.receiptReference, 80)
      || !validIsoTimestamp(replacement.receivedAt) || replacement.receivedAt < item.shippedAt || !validStoredText(replacement.actorId, 80) || replacement.actorRole !== "owner"
      || !validStoredText(replacement.reason, 160) || !Number.isSafeInteger(replacement.version) || replacement.version <= item.version || eventVersions.has(replacement.version)) throw domainError("hpp_state_invalid", 500);
    const replacementReference = `${item.supplierId}\u0000${replacement.receiptReference.toLocaleLowerCase("id")}`;
    if (replacementReferences.has(replacementReference)) throw domainError("hpp_state_invalid", 500);
    replacementReferences.add(replacementReference); keys.add(replacement.idempotencyKey); eventVersions.add(replacement.version);
  }
}

function validateInventoryMovement(movement, ingredients) {
  if (!movement || typeof movement.id !== "string" || !movement.id || cleanIdempotencyKey(movement.idempotencyKey) !== movement.idempotencyKey || !INVENTORY_MOVEMENT_TYPES.has(movement.movementType) || !ingredients.has(movement.ingredientId) || !validStoredText(movement.actorId, 80) || !validStoredText(movement.reason, 160) || !validIsoTimestamp(movement.occurredAt) || typeof movement.fingerprint !== "string" || !movement.fingerprint || !Number.isSafeInteger(movement.version) || movement.version < 2) throw domainError("hpp_state_invalid", 500);
  const productionMovement = new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(movement.movementType);
  const transferMovement = new Set(["TRANSFER_OUT", "TRANSFER_IN"]).has(movement.movementType);
  const storedPrecisionMovement = productionMovement || transferMovement || movement.movementType === "REVERSAL";
  if (!validStoredBalanceQuantity(movement.quantityBeforeBase) || !validStoredBalanceQuantity(movement.quantityAfterBase)
    || !(storedPrecisionMovement ? validStoredSignedQuantity(movement.quantityDeltaBase) : validSignedQuantity(movement.quantityDeltaBase))
    || !(storedPrecisionMovement ? validStoredMovementQuantity(movement.quantityInputBase, false) : validMovementQuantity(movement.quantityInputBase, movement.movementType === "CYCLE_COUNT"))
    || !Number.isSafeInteger(movement.inventoryValueBeforeRupiah) || movement.inventoryValueBeforeRupiah < 0 || !Number.isSafeInteger(movement.inventoryValueAfterRupiah) || movement.inventoryValueAfterRupiah < 0 || !Number.isSafeInteger(movement.inventoryValueDeltaRupiah) || !validUnitCost(movement.unitCostSnapshotRupiah)) throw domainError("hpp_state_invalid", 500);
  const expectedFingerprint = movement.movementType === "SALE_CONSUMPTION"
    ? saleMovementFingerprint(movement)
    : productionMovement
      ? productionMovementFingerprint(movement)
    : transferMovement
      ? inventoryTransferFingerprint(movement.ingredientId, movement.quantityInputBase, movement.sourceLocationId, movement.destinationLocationId)
    : movement.movementType === "REVERSAL"
      ? inventoryReversalFingerprint(movement.reversalOfMovementId, movement.ingredientId, movement.occurredAt)
    : inventoryMovementFingerprint(movement.movementType, movement.ingredientId, movement.quantityInputBase,
      movement.storagePolicyVersion === 1 ? null : movement.locationId ?? null);
  if (movement.fingerprint !== expectedFingerprint) throw domainError("hpp_state_invalid", 500);
  if (movement.locationId !== undefined && !validStoredText(movement.locationId, 128)) throw domainError("hpp_state_invalid", 500);
  if (movement.storagePolicyVersion !== undefined && (movement.storagePolicyVersion !== 1 || !MANUAL_INVENTORY_MOVEMENT_TYPES.has(movement.movementType)
    || !movement.locationId?.endsWith(":USABLE"))) throw domainError("hpp_state_invalid", 500);
  if (movement.locationAuthorityVersion !== undefined && (movement.locationAuthorityVersion !== 1 || !transferMovement)) throw domainError("hpp_state_invalid", 500);
  if (movement.movementType === "SALE_CONSUMPTION") {
    if (!validBalanceQuantity(movement.quantityAppliedBase) || !validBalanceQuantity(movement.shortageBase)
      || roundedQuantity(movement.quantityAppliedBase + movement.shortageBase) !== movement.quantityInputBase
      || movement.quantityDeltaBase !== -movement.quantityAppliedBase || movement.quantityAfterBase !== roundedQuantity(movement.quantityBeforeBase - movement.quantityAppliedBase)
      || movement.referenceType !== "order" || !validStoredText(movement.referenceId, 80) || !validStoredText(movement.referenceCode, 80)
      || typeof movement.consumptionId !== "string" || !movement.consumptionId) throw domainError("hpp_state_invalid", 500);
  }
  if (new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(movement.movementType)) {
    if (movement.sourceType !== "PRODUCTION_EXECUTION" || !validStoredText(movement.sourceId, 128)
      || !validStoredText(movement.sourceLineId, 128) || !validStoredText(movement.locationId, 128)
      || movement.referenceType !== "production" || !validStoredText(movement.referenceId, 128)
      || !validStoredText(movement.referenceCode, 128) || !/^[0-9a-f]{64}$/.test(movement.postingFingerprint)
      || !Array.isArray(movement.allocations) || movement.allocations.length > 100
      || (movement.movementType === "PRODUCTION_INPUT" ? movement.quantityDeltaBase !== -movement.quantityInputBase : movement.quantityDeltaBase !== movement.quantityInputBase)) {
      throw domainError("hpp_state_invalid", 500);
    }
    if (movement.productionLoss !== undefined) normalizeProductionLossAuthority(movement.productionLoss);
    if (movement.outputLot !== undefined) {
      const lot = movement.outputLot;
      if (movement.movementType !== "PRODUCTION_OUTPUT" || !lot || !validStoredText(lot.lotId, 128)
        || !validIsoTimestamp(lot.expiryAt) || lot.qualityState !== "USABLE"
        || lot.quantityBase !== movement.quantityInputBase || lot.producedAt !== movement.occurredAt) throw domainError("hpp_state_invalid", 500);
    }
  }
  if (transferMovement && (!validStoredText(movement.transferId, 120) || !validStoredText(movement.locationId, 128)
    || !validStoredText(movement.sourceLocationId, 128) || !validStoredText(movement.destinationLocationId, 128)
    || movement.sourceLocationId === movement.destinationLocationId
    || movement.locationId !== (movement.movementType === "TRANSFER_OUT" ? movement.sourceLocationId : movement.destinationLocationId)
    || movement.quantityDeltaBase !== (movement.movementType === "TRANSFER_OUT" ? -movement.quantityInputBase : movement.quantityInputBase))) throw domainError("hpp_state_invalid", 500);
  if (movement.movementType === "REVERSAL" && (!validStoredText(movement.reversalOfMovementId, 120)
    || movement.referenceType !== "inventory_movement" || movement.referenceId !== movement.reversalOfMovementId
    || !validStoredText(movement.referenceCode, 120))) throw domainError("hpp_state_invalid", 500);
  if (movement.countSessionId !== undefined && (typeof movement.countSessionId !== "string" || !movement.countSessionId)) throw domainError("hpp_state_invalid", 500);
}

function validateSaleConsumption(consumption, ingredients, movements) {
  if (!consumption || typeof consumption.id !== "string" || !consumption.id || !validStoredText(consumption.orderId, 80)
    || !validStoredText(consumption.orderNumber, 80) || !validIsoTimestamp(consumption.paidAt) || !validIsoTimestamp(consumption.occurredAt)
    || new Date(consumption.occurredAt) < new Date(consumption.paidAt) || !["PAYMENT_PAID_LEGACY", "PREPARING"].includes(consumption.trigger)
    || !validStoredText(consumption.actorId, 80) || !["APPLIED", "PARTIAL", "SHORTAGE", "UNMAPPED"].includes(consumption.status)
    || !Number.isSafeInteger(consumption.itemCount) || consumption.itemCount < 1 || !Number.isSafeInteger(consumption.unmappedItemCount) || consumption.unmappedItemCount < 0
    || !Number.isSafeInteger(consumption.lineCount) || consumption.lineCount < 0 || !Array.isArray(consumption.lines) || consumption.lines.length !== consumption.lineCount || !Array.isArray(consumption.items)
    || !Number.isSafeInteger(consumption.version) || consumption.version < 2 || typeof consumption.fingerprint !== "string" || !consumption.fingerprint) throw domainError("hpp_state_invalid", 500);
  const movementById = new Map(movements.map((movement) => [movement.id, movement]));
  const normalizedItems = consumption.items.map((item) => normalizeSaleItem({ ...item, recipeSnapshot: { lines: item.recipeLines } }));
  const actualUnmappedItemCount = normalizedItems.filter((item) => item.hppSnapshotStatus !== "VERIFIED" || !item.recipeLines.length).length;
  if (consumption.unmappedItemCount !== actualUnmappedItemCount || consumption.unmappedItemCount > consumption.itemCount) throw domainError("hpp_state_invalid", 500);
  if (consumption.fingerprint !== saleConsumptionFingerprint(consumption.orderId, consumption.orderNumber, consumption.paidAt, consumption.occurredAt, consumption.trigger, normalizedItems)) throw domainError("hpp_state_invalid", 500);
  if (!validStoredText(consumption.productionStartId, 80) || !validProductionStartKey(consumption.productionStartIdempotencyKey)
    || !["ORIGINAL", "REMAKE", OFFLINE_CONSUMPTION_REASON].includes(consumption.consumptionReason)
    || (consumption.consumptionReason === "REMAKE"
      ? consumption.remakeId !== null && !validStoredText(consumption.remakeId, 80)
      : consumption.remakeId !== null)
    || !validStoredText(consumption.productionStartReason, 160)
    || consumption.productionStartFingerprint !== productionStartFingerprint({
      productionStartId: consumption.productionStartId,
      idempotencyKey: consumption.productionStartIdempotencyKey,
      consumptionReason: consumption.consumptionReason,
      remakeId: consumption.remakeId,
      reason: consumption.productionStartReason,
      fingerprint: consumption.fingerprint,
    })
    || typeof consumption.requiresReview !== "boolean") throw domainError("hpp_state_invalid", 500);
  if (consumption.sourceEvent !== null) {
    const sourceEvent = consumption.sourceEvent;
    if (!validOfflineEventRecord(sourceEvent) || consumption.consumptionReason !== OFFLINE_CONSUMPTION_REASON
      || consumption.productionStartId !== sourceEvent.eventId || consumption.actorId !== `OFFLINE_DEVICE:${sourceEvent.deviceId}`
      || consumption.paidAt !== sourceEvent.capturedAt || consumption.occurredAt !== sourceEvent.capturedAt
      || sourceEvent.baseHppVersion > consumption.version
      || consumption.sourceEventFingerprint !== offlineEventFingerprint({
        sourceEvent,
        orderId: consumption.orderId,
        orderNumber: consumption.orderNumber,
        fingerprint: consumption.fingerprint,
        productionStartFingerprint: consumption.productionStartFingerprint,
      })) throw domainError("hpp_state_invalid", 500);
  } else if (consumption.sourceEventFingerprint !== undefined) throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  for (const line of consumption.lines) {
    if (!line || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || !validQuantity(line.quantityRequiredBase)
      || !validBalanceQuantity(line.quantityAppliedBase) || !validBalanceQuantity(line.shortageBase)
      || roundedQuantity(line.quantityAppliedBase + line.shortageBase) !== line.quantityRequiredBase
      || !["APPLIED", "SHORTAGE", "UNMANAGED"].includes(line.status)
      || !validRupiah(line.appliedInventoryCostRupiah) || !validRupiah(line.provisionalShortageCostRupiah)
      || !validRupiah(line.postedCogsRupiah)
      || (line.provisionalShortageUnitCostRupiah !== null && !validUnitCost(line.provisionalShortageUnitCostRupiah))) throw domainError("hpp_state_invalid", 500);
    seen.add(line.ingredientId);
    if (line.status === "UNMANAGED") {
      if (line.movementId !== null || line.quantityAppliedBase !== 0 || line.shortageBase !== 0 || line.appliedInventoryCostRupiah !== 0
        || line.provisionalShortageUnitCostRupiah !== null || line.provisionalShortageCostRupiah !== 0 || line.postedCogsRupiah !== 0) throw domainError("hpp_state_invalid", 500);
      continue;
    }
    if ((line.status === "APPLIED" && (line.shortageBase !== 0 || line.quantityAppliedBase !== line.quantityRequiredBase))
      || (line.status === "SHORTAGE" && line.shortageBase <= 0)) throw domainError("hpp_state_invalid", 500);
    const movement = movementById.get(line.movementId);
    if (!movement || movement.movementType !== "SALE_CONSUMPTION" || movement.consumptionId !== consumption.id || movement.referenceId !== consumption.orderId
      || movement.referenceCode !== consumption.orderNumber || movement.ingredientId !== line.ingredientId || movement.quantityInputBase !== line.quantityRequiredBase
      || movement.quantityAppliedBase !== line.quantityAppliedBase || movement.shortageBase !== line.shortageBase || movement.occurredAt !== consumption.occurredAt
      || movement.version >= consumption.version) throw domainError("hpp_state_invalid", 500);
    const expectedAppliedCostRupiah = -movement.inventoryValueDeltaRupiah;
    const expectedProvisionalCostRupiah = roundedRupiah(line.shortageBase * movement.unitCostSnapshotRupiah);
    if (line.appliedInventoryCostRupiah !== expectedAppliedCostRupiah
      || line.provisionalShortageUnitCostRupiah !== movement.unitCostSnapshotRupiah
      || line.provisionalShortageCostRupiah !== expectedProvisionalCostRupiah
      || line.postedCogsRupiah !== safeRupiah(expectedAppliedCostRupiah + expectedProvisionalCostRupiah)) throw domainError("hpp_state_invalid", 500);
  }
  const expectedStatus = consumption.lines.some((line) => line.status === "SHORTAGE") ? "SHORTAGE"
    : (consumption.unmappedItemCount > 0 || consumption.lines.some((line) => line.status === "UNMANAGED")) ? "PARTIAL"
      : consumption.lines.length ? "APPLIED" : "UNMAPPED";
  if (consumption.status !== expectedStatus || consumption.requiresReview !== (expectedStatus === "SHORTAGE")) throw domainError("hpp_state_invalid", 500);
}

function validateInventoryReservations(reservations, ingredients, balances, consumptions, stateVersion) {
  const ids = new Set();
  const orderIds = new Set();
  for (const reservation of reservations) {
    if (!reservation || typeof reservation.id !== "string" || !reservation.id || ids.has(reservation.id)
      || !validStoredText(reservation.orderId, 80) || orderIds.has(reservation.orderId) || !validStoredText(reservation.orderNumber, 80)
      || !["ACTIVE", "CONSUMED", "RELEASED"].includes(reservation.status) || !validIsoTimestamp(reservation.reservedAt)
      || !validStoredText(reservation.actorId, 80) || !Number.isSafeInteger(reservation.itemCount) || reservation.itemCount < 1
      || !Number.isSafeInteger(reservation.unmappedItemCount) || reservation.unmappedItemCount < 0 || reservation.unmappedItemCount > reservation.itemCount
      || !Number.isSafeInteger(reservation.lineCount) || reservation.lineCount < 1 || !Array.isArray(reservation.lines) || reservation.lines.length !== reservation.lineCount
      || !Array.isArray(reservation.items) || !Number.isSafeInteger(reservation.version) || reservation.version < 2 || reservation.version > stateVersion
      || typeof reservation.fingerprint !== "string" || !reservation.fingerprint) throw domainError("hpp_state_invalid", 500);
    const normalizedItems = reservation.items.map((item) => normalizeSaleItem({ ...item, recipeSnapshot: { lines: item.recipeLines } }));
    if (reservation.itemCount !== normalizedItems.length
      || reservation.unmappedItemCount !== normalizedItems.filter((item) => item.hppSnapshotStatus !== "VERIFIED" || !item.recipeLines.length).length
      || reservation.fingerprint !== inventoryReservationFingerprint(reservation.orderId, reservation.orderNumber, normalizedItems)) throw domainError("hpp_state_invalid", 500);
    const expected = new Map();
    for (const item of normalizedItems.filter((item) => item.hppSnapshotStatus === "VERIFIED" && item.recipeLines.length)) {
      for (const line of item.recipeLines) expected.set(line.ingredientId, roundedQuantity((expected.get(line.ingredientId) ?? 0) + line.qty * item.qty));
    }
    const seen = new Set();
    for (const line of reservation.lines) {
      if (!line || !ingredients.has(line.ingredientId) || !balances.has(line.ingredientId) || seen.has(line.ingredientId)
        || !validMovementQuantity(line.quantityReservedBase, false) || !validSignedQuantity(line.availableBeforeBase)
        || !validSignedQuantity(line.availableAfterBase) || roundedQuantity(line.availableBeforeBase - line.quantityReservedBase) !== line.availableAfterBase
        || expected.get(line.ingredientId) !== line.quantityReservedBase) throw domainError("hpp_state_invalid", 500);
      seen.add(line.ingredientId);
    }
    if (seen.size !== expected.size
      || reservation.requiresReview !== reservation.lines.some((line) => line.availableAfterBase < 0)) throw domainError("hpp_state_invalid", 500);
    if (reservation.status === "ACTIVE") {
      if (reservation.releasedAt !== undefined || reservation.releaseReason !== undefined || reservation.releasedBy !== undefined
        || reservation.consumedAt !== undefined || reservation.consumptionId !== undefined || reservation.statusVersion !== undefined) throw domainError("hpp_state_invalid", 500);
    } else if (reservation.status === "CONSUMED") {
      const consumption = consumptions.find((item) => item.id === reservation.consumptionId && item.orderId === reservation.orderId);
      if (!validIsoTimestamp(reservation.consumedAt) || new Date(reservation.consumedAt) < new Date(reservation.reservedAt)
        || !Number.isSafeInteger(reservation.statusVersion) || reservation.statusVersion < reservation.version || reservation.statusVersion > stateVersion
        || !consumption || consumption.trigger !== "PREPARING" || consumption.consumptionReason !== "ORIGINAL"
        || consumption.occurredAt !== reservation.consumedAt || consumption.version !== reservation.statusVersion
        || reservation.releasedAt !== undefined || reservation.releaseReason !== undefined || reservation.releasedBy !== undefined) throw domainError("hpp_state_invalid", 500);
    } else if (!validIsoTimestamp(reservation.releasedAt) || new Date(reservation.releasedAt) < new Date(reservation.reservedAt)
      || !validStoredText(reservation.releaseReason, 160) || !validStoredText(reservation.releasedBy, 80)
      || !Number.isSafeInteger(reservation.statusVersion) || reservation.statusVersion < reservation.version || reservation.statusVersion > stateVersion
      || reservation.consumedAt !== undefined || reservation.consumptionId !== undefined) throw domainError("hpp_state_invalid", 500);
    ids.add(reservation.id);
    orderIds.add(reservation.orderId);
  }
}

function validateCogsAdjustments(adjustments, consumptions, receipts) {
  if (adjustments.length > 100_000) throw domainError("hpp_state_invalid", 500);
  const ids = new Set();
  const keys = new Set();
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const consumptionById = new Map(consumptions.map((consumption) => [consumption.id, consumption]));
  for (const adjustment of adjustments) {
    const receipt = receiptById.get(adjustment?.receiptId);
    const consumption = consumptionById.get(adjustment?.consumptionId);
    const consumptionLine = consumption?.lines.find((line) => line.ingredientId === adjustment?.ingredientId);
    const receiptLine = receipt?.lines.find((line) => line.ingredientId === adjustment?.ingredientId);
    if (!adjustment || !validStoredText(adjustment.id, 80) || ids.has(adjustment.id)
      || cleanIdempotencyKey(adjustment.idempotencyKey) !== adjustment.idempotencyKey || keys.has(adjustment.idempotencyKey)
      || adjustment.adjustmentType !== "SHORTAGE_COST_REVALUATION" || adjustment.sourceType !== "PURCHASE_RECEIPT"
      || !receipt || !consumption || !consumptionLine || !receiptLine || consumptionLine.status !== "SHORTAGE"
      || adjustment.orderId !== consumption.orderId || adjustment.orderNumber !== consumption.orderNumber
      || adjustment.movementId !== consumptionLine.movementId || adjustment.occurredAt !== receipt.receivedAt
      || adjustment.version !== receipt.version || !validMovementQuantity(adjustment.quantityResolvedBase, false)
      || !validUnitCost(adjustment.provisionalUnitCostRupiah) || !validUnitCost(adjustment.actualUnitCostRupiah)
      || !validRupiah(adjustment.provisionalCostRupiah) || !validRupiah(adjustment.actualCostRupiah)
      || !validSignedRupiah(adjustment.adjustmentRupiah) || !validBalanceQuantity(adjustment.remainingShortageBaseAfter)
      || adjustment.provisionalUnitCostRupiah !== consumptionLine.provisionalShortageUnitCostRupiah
      || adjustment.actualUnitCostRupiah !== roundedUnitCost(receiptLine.totalCostRupiah / receiptLine.baseQuantity)
      || adjustment.adjustmentRupiah !== adjustment.actualCostRupiah - adjustment.provisionalCostRupiah
      || adjustment.idempotencyKey !== cogsAdjustmentKey(receipt.id, consumption.id, adjustment.ingredientId)
      || adjustment.fingerprint !== cogsAdjustmentFingerprint(adjustment)) throw domainError("hpp_state_invalid", 500);
    ids.add(adjustment.id);
    keys.add(adjustment.idempotencyKey);
  }

  for (const receipt of receipts) {
    for (const line of receipt.lines) {
      const linked = adjustments.filter((item) => item.receiptId === receipt.id && item.ingredientId === line.ingredientId);
      let cumulativeQuantity = 0;
      let cumulativeCost = 0;
      for (const adjustment of linked) {
        cumulativeQuantity = roundedQuantity(cumulativeQuantity + adjustment.quantityResolvedBase);
        if (cumulativeQuantity > line.baseQuantity) throw domainError("hpp_state_invalid", 500);
        const targetCost = roundedRupiah(line.totalCostRupiah * cumulativeQuantity / line.baseQuantity);
        if (adjustment.actualCostRupiah !== targetCost - cumulativeCost) throw domainError("hpp_state_invalid", 500);
        cumulativeCost = targetCost;
      }
    }
  }

  for (const consumption of consumptions) {
    for (const line of consumption.lines.filter((item) => item.status === "SHORTAGE")) {
      const linked = adjustments
        .filter((item) => item.consumptionId === consumption.id && item.ingredientId === line.ingredientId)
        .sort((a, b) => a.version - b.version || a.receiptId.localeCompare(b.receiptId));
      let cumulativeQuantity = 0;
      let cumulativeCost = 0;
      for (const adjustment of linked) {
        cumulativeQuantity = roundedQuantity(cumulativeQuantity + adjustment.quantityResolvedBase);
        if (cumulativeQuantity > line.shortageBase) throw domainError("hpp_state_invalid", 500);
        const targetCost = roundedRupiah(line.provisionalShortageCostRupiah * cumulativeQuantity / line.shortageBase);
        if (adjustment.provisionalCostRupiah !== targetCost - cumulativeCost
          || adjustment.remainingShortageBaseAfter !== roundedQuantity(line.shortageBase - cumulativeQuantity)) throw domainError("hpp_state_invalid", 500);
        cumulativeCost = targetCost;
      }
    }
  }
}

function validateInventoryCount(count, ingredients, receipts, movements) {
  if (!count || typeof count.id !== "string" || !count.id || cleanIdempotencyKey(count.idempotencyKey) !== count.idempotencyKey || typeof count.fingerprint !== "string" || !count.fingerprint || count.status !== "COMPLETED" || !validIsoTimestamp(count.completedAt) || !validStoredText(count.actorId, 80) || !validStoredText(count.reason, 160) || !Number.isSafeInteger(count.version) || count.version < 2 || !Number.isSafeInteger(count.lineCount) || count.lineCount < 1 || !Array.isArray(count.lines) || count.lines.length !== count.lineCount) throw domainError("hpp_state_invalid", 500);
  const openingBaseline = count.countKind === "OPENING_BASELINE";
  if (count.countKind !== undefined && !openingBaseline) throw domainError("hpp_state_invalid", 500);
  if (openingBaseline && (!validBusinessDate(count.businessDate) || !Array.isArray(count.ingredientIdsAtCount))) throw domainError("hpp_state_invalid", 500);
  const movementById = new Map(movements.map((movement) => [movement.id, movement]));
  const seen = new Set();
  const fingerprintLines = [];
  const lineMovements = [];
  for (const line of count.lines) {
    if (!line || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || typeof line.movementId !== "string" || !line.movementId || !validBalanceQuantity(line.quantityBeforeBase) || !validBalanceQuantity(line.quantityAfterBase) || !validSignedQuantity(line.quantityDeltaBase) || !Number.isSafeInteger(line.inventoryValueDeltaRupiah)) throw domainError("hpp_state_invalid", 500);
    seen.add(line.ingredientId);
    const movement = movementById.get(line.movementId);
    if (!movement || movement.countSessionId !== count.id || movement.movementType !== "CYCLE_COUNT" || movement.ingredientId !== line.ingredientId || movement.occurredAt !== count.completedAt || movement.quantityBeforeBase !== line.quantityBeforeBase || movement.quantityAfterBase !== line.quantityAfterBase || movement.quantityDeltaBase !== line.quantityDeltaBase || movement.inventoryValueDeltaRupiah !== line.inventoryValueDeltaRupiah || movement.version >= count.version || (openingBaseline ? movement.openingBaseline !== true : movement.openingBaseline !== undefined)) throw domainError("hpp_state_invalid", 500);
    fingerprintLines.push({ ingredientId: line.ingredientId, quantityBase: line.quantityAfterBase, ...(openingBaseline ? { openingUnitCostRupiah: movement.unitCostSnapshotRupiah } : {}) });
    lineMovements.push(movement);
  }
  lineMovements.sort((a, b) => a.version - b.version);
  if (lineMovements.some((movement, index) => movement.version !== count.version - count.lineCount + index)) throw domainError("hpp_state_invalid", 500);
  const firstLineVersion = lineMovements[0].version;
  const managedAtStart = new Set();
  for (const receipt of receipts) if (receipt.version < firstLineVersion) for (const line of receipt.lines) managedAtStart.add(line.ingredientId);
  for (const movement of movements) if (movement.version < firstLineVersion) managedAtStart.add(movement.ingredientId);
  if (openingBaseline) {
    const atCount = [...count.ingredientIdsAtCount].sort();
    const seenSorted = [...seen].sort();
    if (atCount.length !== seenSorted.length || atCount.some((ingredientId, index) => ingredientId !== seenSorted[index]) || atCount.some((ingredientId) => !ingredients.has(ingredientId))) throw domainError("hpp_state_invalid", 500);
  } else if (managedAtStart.size !== seen.size || [...managedAtStart].some((ingredientId) => !seen.has(ingredientId))) throw domainError("hpp_state_invalid", 500);
  fingerprintLines.sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  if (count.fingerprint !== inventoryCountFingerprint(fingerprintLines, openingBaseline ? { countKind: count.countKind, businessDate: count.businessDate } : undefined)) throw domainError("hpp_state_invalid", 500);
}

function validateInventoryPeriod(period, counts) {
  if (!period || typeof period.id !== "string" || !period.id || cleanIdempotencyKey(period.idempotencyKey) !== period.idempotencyKey
    || period.status !== "CLOSED" || !validStoredText(period.openingCountId, 80) || !validStoredText(period.closingCountId, 80)
    || !validIsoTimestamp(period.periodStartAt) || !validIsoTimestamp(period.periodEndAt) || !validIsoTimestamp(period.closedAt)
    || !Number.isSafeInteger(period.openingVersion) || !Number.isSafeInteger(period.closingVersion) || !Number.isSafeInteger(period.version)
    || !validStoredText(period.actorId, 80) || !validStoredText(period.reason, 160) || typeof period.fingerprint !== "string") throw domainError("hpp_state_invalid", 500);
  const opening = counts.find((count) => count.id === period.openingCountId);
  const closing = counts.find((count) => count.id === period.closingCountId);
  if (!opening || !closing || opening.version !== period.openingVersion || closing.version !== period.closingVersion
    || opening.completedAt !== period.periodStartAt || closing.completedAt !== period.periodEndAt
    || opening.version >= closing.version || period.version <= closing.version || new Date(period.closedAt) < new Date(period.periodEndAt)
    || period.fingerprint !== inventoryPeriodFingerprint(opening.id, closing.id)) throw domainError("hpp_state_invalid", 500);
  const openingCoverage = opening.lines.map((line) => line.ingredientId).sort();
  const closingCoverage = closing.lines.map((line) => line.ingredientId).sort();
  if (openingCoverage.length !== closingCoverage.length || openingCoverage.some((id, index) => id !== closingCoverage[index])) throw domainError("hpp_state_invalid", 500);
}

function validateInventoryPeriodSequence(periods, counts) {
  const sorted = [...periods].sort((a, b) => a.version - b.version);
  const closingIds = new Set();
  for (const [index, period] of sorted.entries()) {
    if (closingIds.has(period.closingCountId)) throw domainError("hpp_state_invalid", 500);
    closingIds.add(period.closingCountId);
    if (index > 0 && sorted[index - 1].closingCountId !== period.openingCountId) throw domainError("hpp_state_invalid", 500);
  }
  if (sorted.some((period) => !counts.some((count) => count.id === period.openingCountId) || !counts.some((count) => count.id === period.closingCountId))) throw domainError("hpp_state_invalid", 500);
}

function validateSupplier(supplier) {
  if (!supplier || !validStoredText(supplier.id, 80) || cleanPurchaseText(supplier.name, "hpp_state_invalid") !== supplier.name
    || !Number.isSafeInteger(supplier.leadTimeDays) || supplier.leadTimeDays < 0 || supplier.leadTimeDays > 365
    || typeof supplier.active !== "boolean" || !validIsoTimestamp(supplier.createdAt) || !validIsoTimestamp(supplier.updatedAt)
    || !Number.isSafeInteger(supplier.version) || supplier.version < 2) throw domainError("hpp_state_invalid", 500);
}

function validatePurchaseOrder(order, suppliers, ingredients) {
  const supplier = suppliers.find((item) => item.id === order?.supplierId);
  if (!order || !validStoredText(order.id, 80) || cleanIdempotencyKey(order.idempotencyKey) !== order.idempotencyKey || !PURCHASE_ORDER_STATUSES.has(order.status)
    || !supplier || !validStoredText(order.supplierNameSnapshot, 80) || !validBusinessDate(order.expectedDate)
    || !Number.isSafeInteger(order.lineCount) || order.lineCount < 1 || !Array.isArray(order.lines) || order.lines.length !== order.lineCount
    || !Number.isSafeInteger(order.totalOrderedRupiah) || order.totalOrderedRupiah <= 0
    || !validIsoTimestamp(order.createdAt) || !validIsoTimestamp(order.updatedAt) || !validStoredText(order.actorId, 80) || !validStoredText(order.reason, 160)
    || !Number.isSafeInteger(order.version) || order.version < 2 || typeof order.creationFingerprint !== "string" || !order.creationFingerprint
    || typeof order.fingerprint !== "string" || !order.fingerprint || !Number.isSafeInteger(order.revision) || order.revision < 1
    || !Array.isArray(order.changes) || order.changes.length !== order.revision - 1) throw domainError("hpp_state_invalid", 500);
  const seen = new Set();
  let total = 0;
  for (const line of order.lines) {
    if (!line || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel
      || !validQuantity(line.orderedPurchaseQuantity) || !validQuantity(line.baseUnitsPerPurchaseUnit)
      || !Number.isSafeInteger(line.unitCostRupiah) || line.unitCostRupiah <= 0 || line.unitCostRupiah > 1_000_000_000
      || line.lineTotalRupiah !== Math.round(line.orderedPurchaseQuantity * line.unitCostRupiah)
      || !validBalanceQuantity(line.deliveredPurchaseQuantity) || !validBalanceQuantity(line.receivedPurchaseQuantity) || !validBalanceQuantity(line.rejectedPurchaseQuantity)
      || !validBalanceQuantity(line.quarantinedPurchaseQuantity) || !validBalanceQuantity(line.pendingInspectionPurchaseQuantity)
      || !validBalanceQuantity(line.paidOverPurchaseQuantity) || !validBalanceQuantity(line.bonusPurchaseQuantity)
      || line.deliveredPurchaseQuantity !== roundedQuantity(line.receivedPurchaseQuantity + line.rejectedPurchaseQuantity + line.quarantinedPurchaseQuantity + line.pendingInspectionPurchaseQuantity)
      || roundedQuantity(line.paidOverPurchaseQuantity + line.bonusPurchaseQuantity) !== roundedQuantity(Math.max(0, line.deliveredPurchaseQuantity - line.orderedPurchaseQuantity))) throw domainError("hpp_state_invalid", 500);
    seen.add(line.ingredientId);
    total += line.lineTotalRupiah;
  }
  if (total !== order.totalOrderedRupiah || order.fingerprint !== purchaseOrderFingerprint(order.supplierId, order.expectedDate, order.lines)
    || !validStoredPurchaseOrderFingerprint(order.creationFingerprint, suppliers, ingredients)) throw domainError("hpp_state_invalid", 500);
  const changeKeys = new Set();
  let previousFingerprint = order.creationFingerprint;
  let previousVersion = order.version;
  let previousTimestamp = order.createdAt;
  let cancelled = false;
  for (const change of order.changes) {
    if (!change || !validStoredText(change.id, 80) || cleanIdempotencyKey(change.idempotencyKey) !== change.idempotencyKey || changeKeys.has(change.idempotencyKey)
      || !["AMENDED", "CANCELLED"].includes(change.action) || !validStoredText(change.requestFingerprint, 100_000)
      || !validStoredText(change.beforeFingerprint, 100_000) || !validStoredText(change.nextFingerprint, 100_000)
      || !validIsoTimestamp(change.occurredAt) || !validStoredText(change.actorId, 80) || !validStoredText(change.reason, 160)
      || !Number.isSafeInteger(change.version) || change.version <= previousVersion || change.beforeFingerprint !== previousFingerprint
      || change.occurredAt < previousTimestamp || cancelled) throw domainError("hpp_state_invalid", 500);
    if (change.action === "CANCELLED") {
      if (change.nextFingerprint !== change.beforeFingerprint || change.requestFingerprint !== purchaseOrderCancelRequestFingerprint(order.id, change.reason)) throw domainError("hpp_state_invalid", 500);
      cancelled = true;
    } else if (purchaseOrderFingerprintFromAmendRequest(change.requestFingerprint, order.id, suppliers, ingredients) !== change.nextFingerprint) {
      throw domainError("hpp_state_invalid", 500);
    }
    previousFingerprint = change.nextFingerprint;
    previousVersion = change.version;
    previousTimestamp = change.occurredAt;
    changeKeys.add(change.idempotencyKey);
  }
  if (previousFingerprint !== order.fingerprint) throw domainError("hpp_state_invalid", 500);
  if (order.status === "CANCELLED") {
    const cancellation = order.changes.at(-1);
    if (!cancelled || cancellation.action !== "CANCELLED" || order.cancelledAt !== cancellation.occurredAt || order.cancelledBy !== cancellation.actorId || order.cancelReason !== cancellation.reason || order.lines.every((line) => line.deliveredPurchaseQuantity === line.orderedPurchaseQuantity)) throw domainError("hpp_state_invalid", 500);
  } else if (order.cancelledAt !== undefined || order.cancelledBy !== undefined || order.cancelReason !== undefined || cancelled) throw domainError("hpp_state_invalid", 500);
}

function validatePurchaseOrderReceiptLinks(orders, receipts, inspectionDecisions = []) {
  const linkedReceipts = receipts.filter((receipt) => receipt.purchaseOrderId !== undefined);
  for (const order of orders) {
    const deliveredByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const receivedByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const rejectedByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const quarantinedByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const pendingByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const paidOverByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const bonusByIngredient = new Map(order.lines.map((line) => [line.ingredientId, 0]));
    const orderReceipts = linkedReceipts.filter((receipt) => receipt.purchaseOrderId === order.id);
    for (const receipt of orderReceipts) {
      if (receipt.supplierId !== order.supplierId || receipt.supplierName !== order.supplierNameSnapshot) throw domainError("hpp_state_invalid", 500);
      for (const line of receipt.lines) {
        const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine || line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel || line.baseUnitsPerPurchaseUnit !== orderedLine.baseUnitsPerPurchaseUnit
          || line.itemCostRupiah !== Math.round(line.paidPurchaseQuantity * orderedLine.unitCostRupiah)) throw domainError("hpp_state_invalid", 500);
        receivedByIngredient.set(line.ingredientId, roundedQuantity(receivedByIngredient.get(line.ingredientId) + line.purchaseQuantity));
      }
      for (const line of receipt.rejectedLines) {
        const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine || line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel) throw domainError("hpp_state_invalid", 500);
        rejectedByIngredient.set(line.ingredientId, roundedQuantity(rejectedByIngredient.get(line.ingredientId) + line.rejectedPurchaseQuantity));
      }
      for (const line of receipt.quarantinedLines) {
        const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine || line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel) throw domainError("hpp_state_invalid", 500);
        quarantinedByIngredient.set(line.ingredientId, roundedQuantity(quarantinedByIngredient.get(line.ingredientId) + line.quarantinedPurchaseQuantity));
      }
      for (const line of receipt.pendingInspectionLines) {
        const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine || line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel) throw domainError("hpp_state_invalid", 500);
        pendingByIngredient.set(line.ingredientId, roundedQuantity(pendingByIngredient.get(line.ingredientId) + line.pendingInspectionPurchaseQuantity));
      }
      for (const line of receipt.deliveredLines) {
        const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
        if (!orderedLine || line.purchaseUnitLabel !== orderedLine.purchaseUnitLabel) throw domainError("hpp_state_invalid", 500);
        const remainingBefore = roundedQuantity(Math.max(0, orderedLine.orderedPurchaseQuantity - deliveredByIngredient.get(line.ingredientId)));
        const over = roundedQuantity(Math.max(0, line.deliveredPurchaseQuantity - remainingBefore));
        const under = roundedQuantity(Math.max(0, remainingBefore - line.deliveredPurchaseQuantity));
        const expectedStatus = over > 0 ? `OVER_${line.overReceiptClassification}` : under > 0 ? "UNDER" : "EXACT";
        if (line.quantityStatus !== "LEGACY" && (line.orderedRemainingBefore !== remainingBefore || line.overPurchaseQuantity !== over || line.underPurchaseQuantity !== under || line.quantityStatus !== expectedStatus)) throw domainError("hpp_state_invalid", 500);
        if (line.overReceiptClassification === "PAID") paidOverByIngredient.set(line.ingredientId, roundedQuantity(paidOverByIngredient.get(line.ingredientId) + over));
        if (line.overReceiptClassification === "BONUS") bonusByIngredient.set(line.ingredientId, roundedQuantity(bonusByIngredient.get(line.ingredientId) + over));
        deliveredByIngredient.set(line.ingredientId, roundedQuantity(deliveredByIngredient.get(line.ingredientId) + line.deliveredPurchaseQuantity));
      }
    }
    for (const decision of inspectionDecisions.filter((item) => item.purchaseOrderId === order.id)) {
      const target = decision.decision === "ACCEPT" ? receivedByIngredient : rejectedByIngredient;
      target.set(decision.ingredientId, roundedQuantity(target.get(decision.ingredientId) + decision.purchaseQuantity));
      const source = decision.sourceDisposition === "QUARANTINED" ? quarantinedByIngredient : pendingByIngredient;
      source.set(decision.ingredientId, roundedQuantity(source.get(decision.ingredientId) - decision.purchaseQuantity));
    }
    for (const line of order.lines) {
      if (deliveredByIngredient.get(line.ingredientId) !== line.deliveredPurchaseQuantity || receivedByIngredient.get(line.ingredientId) !== line.receivedPurchaseQuantity
        || rejectedByIngredient.get(line.ingredientId) !== line.rejectedPurchaseQuantity || quarantinedByIngredient.get(line.ingredientId) !== line.quarantinedPurchaseQuantity
        || pendingByIngredient.get(line.ingredientId) !== line.pendingInspectionPurchaseQuantity || paidOverByIngredient.get(line.ingredientId) !== line.paidOverPurchaseQuantity
        || bonusByIngredient.get(line.ingredientId) !== line.bonusPurchaseQuantity) throw domainError("hpp_state_invalid", 500);
    }
    if (order.status !== "CANCELLED" && order.status !== purchaseOrderStatus(order.lines)) throw domainError("hpp_state_invalid", 500);
    const latestReceipt = orderReceipts.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    const latestChange = order.changes.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    const latestInspection = inspectionDecisions.filter((item) => item.purchaseOrderId === order.id).slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    const latestTimestamp = [order.createdAt, latestReceipt?.receivedAt, latestInspection?.occurredAt, latestChange?.occurredAt].filter(Boolean).sort().at(-1);
    if (latestTimestamp !== order.updatedAt) throw domainError("hpp_state_invalid", 500);
  }
  if (linkedReceipts.some((receipt) => !orders.some((order) => order.id === receipt.purchaseOrderId))) throw domainError("hpp_state_invalid", 500);
}

function validateInventoryReconciliation(ingredients, inventoryBalances, receipts, movements, supplierReturns = [], inspectionDecisions = []) {
  const expected = new Map();
  const events = [
    ...receipts.map((receipt) => ({ type: "receipt", version: receipt.version, value: receipt })),
    ...inspectionDecisions.filter((item) => item.decision === "ACCEPT").map((item) => ({ type: "inspection_accept", version: item.version, value: item })),
    ...movements.map((movement) => ({ type: "movement", version: movement.version, value: movement })),
    ...supplierReturns.flatMap((item) => [{ type: "supplier_return", version: item.version, value: item }, ...(item.replacementReceipt ? [{ type: "supplier_replacement", version: item.replacementReceipt.version, value: item }] : [])]),
  ].sort((a, b) => a.version - b.version);
  for (const event of events) {
    if (event.type === "receipt") {
      for (const line of event.value.lines) {
        const previous = expected.get(line.ingredientId) ?? { quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 };
        const quantityBase = roundedQuantity(previous.quantityBase + line.baseQuantity);
        const inventoryValueRupiah = previous.inventoryValueRupiah + line.totalCostRupiah;
        expected.set(line.ingredientId, { quantityBase, inventoryValueRupiah, averageCostPerBaseUnitRupiah: roundedUnitCost(inventoryValueRupiah / quantityBase) });
      }
      continue;
    }
    if (event.type === "inspection_accept") {
      const previous = expected.get(event.value.ingredientId) ?? { quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 };
      const quantityBase = roundedQuantity(previous.quantityBase + event.value.baseQuantity);
      const inventoryValueRupiah = previous.inventoryValueRupiah + event.value.inventoryValueRupiah;
      expected.set(event.value.ingredientId, { quantityBase, inventoryValueRupiah, averageCostPerBaseUnitRupiah: roundedUnitCost(inventoryValueRupiah / quantityBase) });
      continue;
    }
    if (event.type === "supplier_return" || event.type === "supplier_replacement") {
      for (const line of event.value.lines) {
        const previous = expected.get(line.ingredientId);
        const next = applySupplierValueMovement(previous, line.baseQuantity, line.returnValueRupiah, event.type === "supplier_return" ? "OUT" : "IN");
        expected.set(line.ingredientId, next);
      }
      continue;
    }
    const movement = event.value;
    const previous = expected.get(movement.ingredientId) ?? (movement.openingBaseline === true
      ? { quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: movement.unitCostSnapshotRupiah }
      : movement.movementType === "PRODUCTION_OUTPUT"
        ? { quantityBase: 0, inventoryValueRupiah: 0, averageCostPerBaseUnitRupiah: 0 }
        : null);
    if (!previous || movement.quantityBeforeBase !== previous.quantityBase || movement.inventoryValueBeforeRupiah !== previous.inventoryValueRupiah || movement.unitCostSnapshotRupiah !== previous.averageCostPerBaseUnitRupiah) throw domainError("hpp_state_invalid", 500);
    const next = movement.movementType === "SALE_CONSUMPTION"
      ? applySaleConsumptionToBalance(previous, movement.quantityInputBase)
      : new Set(["REVERSAL", "PRODUCTION_INPUT", "PRODUCTION_OUTPUT", "TRANSFER_OUT", "TRANSFER_IN"]).has(movement.movementType)
        ? applyStoredInventoryMovementDelta(previous, movement.quantityDeltaBase, movement.inventoryValueDeltaRupiah)
      : applyInventoryMovementToBalance(previous, movement.movementType, movement.quantityInputBase);
    if (movement.quantityDeltaBase !== next.quantityDeltaBase || movement.quantityAfterBase !== next.balance.quantityBase || movement.inventoryValueDeltaRupiah !== next.inventoryValueDeltaRupiah || movement.inventoryValueAfterRupiah !== next.balance.inventoryValueRupiah) throw domainError("hpp_state_invalid", 500);
    expected.set(movement.ingredientId, next.balance);
  }
  if (expected.size !== inventoryBalances.size) throw domainError("hpp_state_invalid", 500);
  for (const [ingredientId, totals] of expected) {
    const balance = inventoryBalances.get(ingredientId);
    if (!balance || balance.quantityBase !== totals.quantityBase || balance.inventoryValueRupiah !== totals.inventoryValueRupiah || balance.averageCostPerBaseUnitRupiah !== totals.averageCostPerBaseUnitRupiah || ingredients.get(ingredientId)?.costPerUnitRupiah !== totals.averageCostPerBaseUnitRupiah) throw domainError("hpp_state_invalid", 500);
  }
}

function normalizePurchaseInvoiceLines(lines, order) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("purchase_invoice_lines_invalid", 422);
  const seen = new Set();
  return lines.map((line) => {
    if (!line || typeof line.ingredientId !== "string" || seen.has(line.ingredientId)) throw domainError("purchase_invoice_line_invalid", 422);
    const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
    if (!orderedLine) throw domainError("purchase_order_line_not_found", 404);
    seen.add(line.ingredientId);
    const invoiceQuantity = exactPositiveQuantity(line.invoiceQuantity, "purchase_invoice_quantity_invalid");
    if (!Number.isSafeInteger(line.unitPriceRupiah) || line.unitPriceRupiah <= 0 || line.unitPriceRupiah > 1_000_000_000) throw domainError("purchase_invoice_unit_price_invalid", 422);
    const invoiceLineTotalRupiah = Math.round(invoiceQuantity * line.unitPriceRupiah);
    if (!Number.isSafeInteger(invoiceLineTotalRupiah) || invoiceLineTotalRupiah <= 0 || (line.invoiceLineTotalRupiah !== undefined && line.invoiceLineTotalRupiah !== invoiceLineTotalRupiah)) throw domainError("purchase_invoice_line_total_invalid", 422);
    return { ingredientId: line.ingredientId, invoiceQuantity, unitPriceRupiah: line.unitPriceRupiah, invoiceLineTotalRupiah };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
}

function assertPurchaseInvoicePostingCoverage(invoice, receipts, inspectionDecisions, invoices) {
  // Durable posting revalues ONE entire original receipt, not a partial invoice
  // or later inspection acquisitions. Reject incompatible coverage before any
  // revision/audit/payable mutation; do not change matching or Finance approval.
  const orderReceipts = receipts.filter((receipt) => receipt.purchaseOrderId === invoice.purchaseOrderId);
  const originals = orderReceipts.filter((receipt) => receipt.lines.length > 0);
  const receipt = originals[0];
  const receiptIds = new Set(orderReceipts.map((item) => item.id));
  if (originals.length !== 1 || receipt.version > invoice.receiptVersionThrough
    || orderReceipts.some((item) => item.quarantinedLines.length > 0 || item.pendingInspectionLines.length > 0)
    || inspectionDecisions.some((item) => item.purchaseOrderId === invoice.purchaseOrderId || receiptIds.has(item.purchaseReceiptId))
    || invoices.some((item) => item.id !== invoice.id && item.purchaseOrderId === invoice.purchaseOrderId
      && item.payableEntry && item.receiptVersionThrough >= receipt.version)) {
    throw domainError("purchase_invoice_post_coverage_unsupported", 409);
  }
  const invoiceLines = new Map(invoice.lines.map((line) => [line.ingredientId, line]));
  if (invoiceLines.size !== invoice.lines.length || invoiceLines.size !== receipt.lines.length
    || receipt.lines.some((line) => !validQuantity(line.paidPurchaseQuantity)
      || invoiceLines.get(line.ingredientId)?.invoiceQuantity !== line.paidPurchaseQuantity
      || roundedQuantity(line.paidPurchaseQuantity + line.bonusPurchaseQuantity) !== line.purchaseQuantity
      || roundedQuantity(line.purchaseQuantity * line.baseUnitsPerPurchaseUnit) !== line.baseQuantity)) {
    throw domainError("purchase_invoice_post_coverage_unsupported", 409);
  }
}

function calculatePurchaseInvoiceMatch(order, receipts, previousMatched, lines, fees, inspectionDecisions = []) {
  const invoicedQuantity = new Map();
  const invoicedFees = new Map();
  const receivedQuantity = new Map();
  for (const invoice of previousMatched) {
    for (const line of invoice.lines) invoicedQuantity.set(line.ingredientId, roundedQuantity((invoicedQuantity.get(line.ingredientId) ?? 0) + line.invoiceQuantity));
    for (const fee of invoice.additionalFees) invoicedFees.set(fee.type, (invoicedFees.get(fee.type) ?? 0) + fee.amountRupiah);
  }
  const receivedFees = new Map();
  for (const receipt of receipts) {
    for (const line of receipt.lines) receivedQuantity.set(line.ingredientId, roundedQuantity((receivedQuantity.get(line.ingredientId) ?? 0) + line.paidPurchaseQuantity));
    for (const fee of receipt.additionalFees) receivedFees.set(fee.type, (receivedFees.get(fee.type) ?? 0) + fee.amountRupiah);
  }
  for (const decision of inspectionDecisions.filter((item) => item.purchaseOrderId === order.id && item.decision === "ACCEPT")) {
    receivedQuantity.set(decision.ingredientId, roundedQuantity((receivedQuantity.get(decision.ingredientId) ?? 0) + decision.purchaseQuantity));
  }
  const matchedLines = lines.map((line) => {
    const orderedLine = order.lines.find((item) => item.ingredientId === line.ingredientId);
    const availableReceivedQuantity = roundedQuantity(Math.max(0, (receivedQuantity.get(line.ingredientId) ?? 0) - (invoicedQuantity.get(line.ingredientId) ?? 0)));
    const expectedLineTotalRupiah = Math.round(line.invoiceQuantity * orderedLine.unitCostRupiah);
    return {
      ...line, expectedUnitPriceRupiah: orderedLine.unitCostRupiah, availableReceivedQuantity,
      quantityMatch: line.invoiceQuantity <= availableReceivedQuantity,
      priceMatch: line.unitPriceRupiah === orderedLine.unitCostRupiah,
      expectedLineTotalRupiah, varianceRupiah: line.invoiceLineTotalRupiah - expectedLineTotalRupiah,
    };
  });
  const matchedFees = fees.map((fee) => {
    const availableAmountRupiah = Math.max(0, (receivedFees.get(fee.type) ?? 0) - (invoicedFees.get(fee.type) ?? 0));
    return { ...fee, availableAmountRupiah, feeMatch: fee.amountRupiah <= availableAmountRupiah };
  });
  const matchStatus = matchedLines.every((line) => line.quantityMatch && line.priceMatch) && matchedFees.every((fee) => fee.feeMatch) ? "MATCHED" : "EXCEPTION";
  const expectedMatchedTotalRupiah = matchedLines.reduce((sum, line) => sum + line.expectedLineTotalRupiah, 0) + fees.reduce((sum, fee) => sum + fee.amountRupiah, 0);
  if (!Number.isSafeInteger(expectedMatchedTotalRupiah) || expectedMatchedTotalRupiah <= 0) throw domainError("purchase_invoice_total_invalid", 422);
  return { lines: matchedLines, additionalFees: matchedFees, matchStatus, expectedMatchedTotalRupiah };
}

function purchaseInvoiceInitialReadiness(invoice) {
  if (invoice.matchStatus === "MATCHED") return "READY_FOR_APPROVAL";
  const quantityAndFeeEvidenceMatch = invoice.lines.every((line) => line.quantityMatch)
    && invoice.additionalFees.every((fee) => fee.feeMatch);
  const withinReviewThreshold = Math.abs(invoice.totalVarianceRupiah) * 10 <= invoice.expectedMatchedTotalRupiah;
  return quantityAndFeeEvidenceMatch && withinReviewThreshold ? "VARIANCE_REVIEW_REQUIRED" : "BLOCKED";
}

function purchaseInvoiceFingerprint(purchaseOrderId, invoiceNumber, invoiceDate, dueDate, lines, fees, totalInvoiceRupiah) {
  return JSON.stringify({
    purchaseOrderId, invoiceNumber, invoiceDate, dueDate,
    lines: lines.map((line) => ({ ingredientId: line.ingredientId, invoiceQuantity: line.invoiceQuantity, unitPriceRupiah: line.unitPriceRupiah, invoiceLineTotalRupiah: line.invoiceLineTotalRupiah })),
    additionalFees: fees.map((fee) => ({ type: fee.type, amountRupiah: fee.amountRupiah })), totalInvoiceRupiah,
  });
}

function purchaseInvoiceActionFingerprint(purchaseInvoiceId, action, reason) {
  return JSON.stringify({ purchaseInvoiceId, action, reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoiceCreditFingerprint(purchaseInvoiceId, supplierReturnId, creditNoteNumber, creditDate, amountRupiah, creditType, reason) {
  return JSON.stringify({ purchaseInvoiceId, supplierReturnId, creditNoteNumber, creditDate, amountRupiah, creditType, reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoiceCreditPostFingerprint(creditMemoId, reason) {
  return JSON.stringify({ creditMemoId, action: "POSTED", reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoiceCreditReversalRequestFingerprint(creditMemoId, reason) {
  return JSON.stringify({ creditMemoId, action: "REVERSAL_REQUESTED", reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoiceCreditReversalDecisionFingerprint(creditMemoId, decision, reason) {
  return JSON.stringify({ creditMemoId, action: "REVERSAL_DECIDED", decision, reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoicePaymentFingerprint(purchaseInvoiceId, paidDate, amountRupiah, method, reference, reason) {
  return JSON.stringify({ purchaseInvoiceId, paidDate, amountRupiah, method, reference, reason: typeof reason === "string" ? reason.trim() : reason });
}

function payableStatus(creditedRupiah, paidRupiah, outstandingRupiah) {
  if (outstandingRupiah === 0) {
    if (creditedRupiah > 0 && paidRupiah > 0) return "CLOSED_BY_CREDIT_AND_PAYMENT";
    if (creditedRupiah > 0) return "CLOSED_BY_CREDIT";
    return "PAID";
  }
  if (creditedRupiah > 0 && paidRupiah > 0) return "PARTIALLY_PAID_AND_CREDITED";
  if (paidRupiah > 0) return "PARTIALLY_PAID";
  if (creditedRupiah > 0) return "PARTIALLY_CREDITED";
  return "OPEN";
}

function normalizeSupplierReturnLines(lines, receipt, priorReturns) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("supplier_return_lines_invalid", 422);
  const seen = new Set();
  return lines.map((line) => {
    if (!line || typeof line.ingredientId !== "string" || seen.has(line.ingredientId)) throw domainError("supplier_return_line_invalid", 422);
    const receiptLine = receipt.lines.find((item) => item.ingredientId === line.ingredientId);
    if (!receiptLine) throw domainError("supplier_return_line_invalid", 422);
    seen.add(line.ingredientId);
    const returnPurchaseQuantity = exactPositiveQuantity(line.returnPurchaseQuantity, "supplier_return_quantity_invalid");
    const returned = priorReturns.flatMap((item) => item.purchaseReceiptId === receipt.id ? item.lines : []).filter((item) => item.ingredientId === line.ingredientId);
    const returnedPurchaseQuantity = returned.reduce((sum, item) => roundedQuantity(sum + item.returnPurchaseQuantity), 0);
    const returnedValueRupiah = returned.reduce((sum, item) => sum + item.returnValueRupiah, 0);
    const availablePurchaseQuantity = roundedQuantity(receiptLine.purchaseQuantity - returnedPurchaseQuantity);
    if (returnPurchaseQuantity > availablePurchaseQuantity) throw domainError("supplier_return_quantity_invalid", 422);
    const baseQuantity = roundedQuantity(returnPurchaseQuantity * receiptLine.baseUnitsPerPurchaseUnit);
    if (!validMovementQuantity(baseQuantity, false)) throw domainError("supplier_return_quantity_invalid", 422);
    const returnValueRupiah = returnPurchaseQuantity === availablePurchaseQuantity
      ? receiptLine.totalCostRupiah - returnedValueRupiah
      : Math.round(receiptLine.totalCostRupiah * returnPurchaseQuantity / receiptLine.purchaseQuantity);
    if (!Number.isSafeInteger(returnValueRupiah) || returnValueRupiah <= 0) throw domainError("supplier_return_value_invalid", 422);
    return {
      ingredientId: line.ingredientId, purchaseUnitLabel: receiptLine.purchaseUnitLabel, returnPurchaseQuantity,
      baseUnitsPerPurchaseUnit: receiptLine.baseUnitsPerPurchaseUnit, baseQuantity, returnValueRupiah,
      unitCostSnapshotRupiah: roundedUnitCost(returnValueRupiah / baseQuantity),
    };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
}

function supplierReturnFingerprint(purchaseReceiptId, returnReference, disposition, lines, reason) {
  return JSON.stringify({
    purchaseReceiptId,
    returnReference,
    disposition,
    lines: lines.map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      returnPurchaseQuantity: line.returnPurchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      baseQuantity: line.baseQuantity,
      returnValueRupiah: line.returnValueRupiah,
      unitCostSnapshotRupiah: line.unitCostSnapshotRupiah,
    })),
    reason: typeof reason === "string" ? reason.trim() : reason,
  });
}

function supplierReplacementFingerprint(supplierReturnId, receiptReference, reason) {
  return JSON.stringify({ supplierReturnId, receiptReference, reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseInvoiceLineEvidenceFingerprint(lines) {
  return JSON.stringify(lines.map((line) => ({
    ingredientId: line.ingredientId, invoiceQuantity: line.invoiceQuantity, unitPriceRupiah: line.unitPriceRupiah,
    invoiceLineTotalRupiah: line.invoiceLineTotalRupiah, expectedUnitPriceRupiah: line.expectedUnitPriceRupiah,
    availableReceivedQuantity: line.availableReceivedQuantity, quantityMatch: line.quantityMatch, priceMatch: line.priceMatch,
    expectedLineTotalRupiah: line.expectedLineTotalRupiah, varianceRupiah: line.varianceRupiah,
  })));
}

function purchaseInvoiceFeeEvidenceFingerprint(fees) {
  return JSON.stringify(fees.map((fee) => ({ type: fee.type, amountRupiah: fee.amountRupiah, availableAmountRupiah: fee.availableAmountRupiah, feeMatch: fee.feeMatch })));
}

function purchaseFingerprint(supplierName, lines, rejectedLines = [], additionalFees = [], purchaseOrderId, receiving = {}) {
  return JSON.stringify({
    supplierName,
    lines: lines.map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      purchaseQuantity: line.purchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      baseQuantity: line.baseQuantity,
      itemCostRupiah: line.itemCostRupiah,
      allocatedFeeRupiah: line.allocatedFeeRupiah,
      totalCostRupiah: line.totalCostRupiah,
      paidPurchaseQuantity: line.paidPurchaseQuantity,
      bonusPurchaseQuantity: line.bonusPurchaseQuantity,
    })),
    rejectedLines: rejectedLines.map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      rejectedPurchaseQuantity: line.rejectedPurchaseQuantity,
      rejectionReason: line.rejectionReason,
    })),
    additionalFees: additionalFees.map((fee) => ({ type: fee.type, amountRupiah: fee.amountRupiah })),
    purchaseOrderId,
    receiptSource: receiving.receiptSource,
    destinationLocationId: receiving.destinationLocationId,
    quarantineLocationId: receiving.quarantineLocationId,
    rejectionLocationId: receiving.rejectionLocationId,
    pendingInspectionLocationId: receiving.pendingInspectionLocationId,
    deliveredLines: (receiving.deliveredLines ?? []).map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      deliveredPurchaseQuantity: line.deliveredPurchaseQuantity,
      quantityStatus: line.quantityStatus,
      orderedRemainingBefore: line.orderedRemainingBefore,
      overPurchaseQuantity: line.overPurchaseQuantity,
      underPurchaseQuantity: line.underPurchaseQuantity,
      overReceiptClassification: line.overReceiptClassification,
    })),
    quarantinedLines: (receiving.quarantinedLines ?? []).map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      quarantinedPurchaseQuantity: line.quarantinedPurchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      inspectionUnitCostRupiah: line.inspectionUnitCostRupiah,
    })),
    pendingInspectionLines: (receiving.pendingInspectionLines ?? []).map((line) => ({
      ingredientId: line.ingredientId,
      purchaseUnitLabel: line.purchaseUnitLabel,
      pendingInspectionPurchaseQuantity: line.pendingInspectionPurchaseQuantity,
      baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
      inspectionUnitCostRupiah: line.inspectionUnitCostRupiah,
    })),
    lots: (receiving.lots ?? []).map((lot) => ({
      ingredientId: lot.ingredientId,
      lotCode: lot.lotCode,
      expiryDate: lot.expiryDate,
      acceptedPurchaseQuantity: lot.acceptedPurchaseQuantity,
      rejectedPurchaseQuantity: lot.rejectedPurchaseQuantity,
      quarantinedPurchaseQuantity: lot.quarantinedPurchaseQuantity,
      pendingInspectionPurchaseQuantity: lot.pendingInspectionPurchaseQuantity,
      deliveredPurchaseQuantity: lot.deliveredPurchaseQuantity,
    })),
  });
}

function receivingFingerprintFields(receipt) {
  return {
    receiptSource: receipt.receiptSource,
    destinationLocationId: receipt.destinationLocationId,
    quarantineLocationId: receipt.quarantineLocationId,
    rejectionLocationId: receipt.rejectionLocationId,
    pendingInspectionLocationId: receipt.pendingInspectionLocationId,
    deliveredLines: receipt.deliveredLines,
    quarantinedLines: receipt.quarantinedLines,
    pendingInspectionLines: receipt.pendingInspectionLines,
    lots: receipt.lots,
  };
}

function purchaseOrderStatus(lines) {
  if (lines.every((line) => line.deliveredPurchaseQuantity >= line.orderedPurchaseQuantity)) return "RECEIVED";
  if (lines.some((line) => line.deliveredPurchaseQuantity > 0)) return "PARTIALLY_RECEIVED";
  return "OPEN";
}

function purchaseOrderFingerprint(supplierId, expectedDate, lines) {
  return JSON.stringify({ supplierId, expectedDate, lines: lines.map((line) => ({
    ingredientId: line.ingredientId, purchaseUnitLabel: line.purchaseUnitLabel,
    orderedPurchaseQuantity: line.orderedPurchaseQuantity, baseUnitsPerPurchaseUnit: line.baseUnitsPerPurchaseUnit,
    unitCostRupiah: line.unitCostRupiah,
  })) });
}

function purchaseOrderAmendRequestFingerprint(purchaseOrderId, supplierId, expectedDate, lines) {
  const normalizedLines = Array.isArray(lines) ? lines.map((line) => ({
    ingredientId: line?.ingredientId, purchaseUnitLabel: line?.purchaseUnitLabel,
    orderedPurchaseQuantity: line?.orderedPurchaseQuantity, baseUnitsPerPurchaseUnit: line?.baseUnitsPerPurchaseUnit,
    unitCostRupiah: line?.unitCostRupiah,
  })).sort((a, b) => String(a.ingredientId).localeCompare(String(b.ingredientId))) : lines;
  return JSON.stringify({ purchaseOrderId, supplierId, expectedDate, lines: normalizedLines });
}

function purchaseOrderFingerprintFromCreateRequest(supplierId, expectedDate, lines) {
  if (!validBusinessDate(expectedDate)) throw domainError("purchase_order_expected_date_invalid", 422);
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw domainError("purchase_order_lines_invalid", 422);
  const seen = new Set();
  const normalizedLines = lines.map((line) => {
    if (!line || typeof line.ingredientId !== "string") throw domainError("ingredient_not_found", 404);
    if (seen.has(line.ingredientId)) throw domainError("purchase_order_ingredient_duplicate", 422);
    seen.add(line.ingredientId);
    const purchaseUnitLabel = cleanPurchaseText(line.purchaseUnitLabel, "purchase_unit_label_invalid");
    const orderedPurchaseQuantity = exactPositiveQuantity(line.orderedPurchaseQuantity, "purchase_order_quantity_invalid");
    const baseUnitsPerPurchaseUnit = exactPositiveQuantity(line.baseUnitsPerPurchaseUnit, "purchase_conversion_invalid");
    if (!Number.isSafeInteger(line.unitCostRupiah) || line.unitCostRupiah <= 0 || line.unitCostRupiah > 1_000_000_000) throw domainError("purchase_order_unit_cost_invalid", 422);
    const lineTotalRupiah = Math.round(orderedPurchaseQuantity * line.unitCostRupiah);
    if (!Number.isSafeInteger(lineTotalRupiah) || lineTotalRupiah <= 0) throw domainError("purchase_order_total_invalid", 422);
    return { ingredientId: line.ingredientId, purchaseUnitLabel, orderedPurchaseQuantity, baseUnitsPerPurchaseUnit, unitCostRupiah: line.unitCostRupiah, lineTotalRupiah, receivedPurchaseQuantity: 0, rejectedPurchaseQuantity: 0 };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  const total = normalizedLines.reduce((sum, line) => sum + line.lineTotalRupiah, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw domainError("purchase_order_total_invalid", 422);
  return purchaseOrderFingerprint(supplierId, expectedDate, normalizedLines);
}

function validStoredPurchaseOrderFingerprint(fingerprint, suppliers, ingredients) {
  try {
    const request = JSON.parse(fingerprint);
    return suppliers.some((supplier) => supplier.id === request.supplierId)
      && Array.isArray(request.lines)
      && request.lines.every((line) => ingredients.has(line?.ingredientId))
      && purchaseOrderFingerprintFromCreateRequest(request.supplierId, request.expectedDate, request.lines) === fingerprint;
  } catch {
    return false;
  }
}

function purchaseOrderCancelRequestFingerprint(purchaseOrderId, reason) {
  return JSON.stringify({ purchaseOrderId, reason: typeof reason === "string" ? reason.trim() : reason });
}

function purchaseOrderFingerprintFromAmendRequest(requestFingerprint, purchaseOrderId, suppliers, ingredients) {
  try {
    const request = JSON.parse(requestFingerprint);
    if (request.purchaseOrderId !== purchaseOrderId || !suppliers.some((supplier) => supplier.id === request.supplierId)
      || !validBusinessDate(request.expectedDate) || !Array.isArray(request.lines) || !request.lines.length || request.lines.length > 100
      || requestFingerprint !== purchaseOrderAmendRequestFingerprint(request.purchaseOrderId, request.supplierId, request.expectedDate, request.lines)) return null;
    const seen = new Set();
    const lines = request.lines.map((line) => {
      if (!line || !ingredients.has(line.ingredientId) || seen.has(line.ingredientId) || cleanPurchaseText(line.purchaseUnitLabel, "hpp_state_invalid") !== line.purchaseUnitLabel
        || !validQuantity(line.orderedPurchaseQuantity) || !validQuantity(line.baseUnitsPerPurchaseUnit)
        || !Number.isSafeInteger(line.unitCostRupiah) || line.unitCostRupiah <= 0 || line.unitCostRupiah > 1_000_000_000) return null;
      seen.add(line.ingredientId);
      const lineTotalRupiah = Math.round(line.orderedPurchaseQuantity * line.unitCostRupiah);
      if (!Number.isSafeInteger(lineTotalRupiah) || lineTotalRupiah <= 0) return null;
      return { ...line, lineTotalRupiah, receivedPurchaseQuantity: 0, rejectedPurchaseQuantity: 0 };
    });
    if (lines.some((line) => line === null)) return null;
    return purchaseOrderFingerprint(request.supplierId, request.expectedDate, lines);
  } catch {
    return null;
  }
}

function inventoryMovementFingerprint(movementType, ingredientId, quantityInputBase, locationId = null) {
  return JSON.stringify({ movementType, ingredientId, quantityInputBase, ...(locationId ? { locationId } : {}) });
}

function inventoryReversalFingerprint(reversalOfMovementId, ingredientId, occurredAt) {
  return JSON.stringify({ movementType: "REVERSAL", reversalOfMovementId, ingredientId, occurredAt });
}

function inventoryTransferFingerprint(ingredientId, quantityBase, sourceLocationId, destinationLocationId) {
  return JSON.stringify({ movementType: "TRANSFER", ingredientId, quantityBase, sourceLocationId, destinationLocationId });
}

function inventoryLocationPosition(inventoryBalances, purchaseReceipts, inventoryMovements, ingredientId, locationId) {
  const aggregate = inventoryBalances.get(ingredientId);
  const primaryLocationId = `${locationId.slice(0, locationId.lastIndexOf(":"))}:USABLE`;
  const positions = new Map();
  const events = [
    ...purchaseReceipts.flatMap((receipt) => (receipt.lines ?? []).filter((line) => line.ingredientId === ingredientId).map((line) => ({ version: receipt.version, locationId: receipt.destinationLocationId ?? primaryLocationId, delta: Number(line.baseQuantity) }))),
    ...inventoryMovements.filter((movement) => movement.ingredientId === ingredientId).map((movement) => ({ version: movement.version, locationId: movement.locationId ?? null, delta: Number(movement.quantityDeltaBase) })),
  ].sort((left, right) => left.version - right.version);
  for (const event of events) {
    if (event.delta === 0) continue;
    let target = event.locationId;
    if (!target) {
      const candidates = [...positions].filter(([, quantity]) => event.delta > 0 || quantity >= -event.delta);
      if (candidates.length !== 1) throw domainError("inventory_location_unverified", 409);
      target = candidates[0][0];
    }
    const next = Number(((positions.get(target) ?? 0) + event.delta).toFixed(6));
    if (next < 0) throw domainError("inventory_location_quantity_insufficient", 409);
    positions.set(target, next);
  }
  const rebuilt = Number([...positions.values()].reduce((sum, quantity) => sum + quantity, 0).toFixed(6));
  if (aggregate && rebuilt !== aggregate.quantityBase) throw domainError("inventory_location_unverified", 409);
  const quantityBase = positions.get(locationId) ?? 0;
  const inventoryValueRupiah = aggregate?.quantityBase > 0
    ? quantityBase === aggregate.quantityBase ? aggregate.inventoryValueRupiah : Math.round(aggregate.inventoryValueRupiah * quantityBase / aggregate.quantityBase)
    : 0;
  return { quantityBase, inventoryValueRupiah };
}

function productionPostingFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function productionMovementFingerprint(movement) {
  const value = {
    movementType: movement.movementType,
    ingredientId: movement.ingredientId,
    quantityInputBase: movement.quantityInputBase,
    inventoryValueDeltaRupiah: movement.inventoryValueDeltaRupiah,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    sourceLineId: movement.sourceLineId,
    locationId: movement.locationId,
    referenceType: movement.referenceType,
    referenceId: movement.referenceId,
    referenceCode: movement.referenceCode,
    postingFingerprint: movement.postingFingerprint,
  };
  if (movement.productionLoss !== undefined) value.productionLoss = normalizeProductionLossAuthority(movement.productionLoss);
  if (movement.outputLot !== undefined) value.outputLot = {
    lotId: movement.outputLot.lotId,
    expiryAt: movement.outputLot.expiryAt,
    qualityState: movement.outputLot.qualityState,
    quantityBase: movement.outputLot.quantityBase,
    producedAt: movement.outputLot.producedAt,
  };
  return JSON.stringify(value);
}

function normalizeProductionOutputLot(output, ingredient, quantityBase, occurredAt, recordedAt) {
  const hasLotId = output?.lotId !== undefined && output?.lotId !== null && output?.lotId !== "";
  const hasExpiryAt = output?.expiryAt !== undefined && output?.expiryAt !== null && output?.expiryAt !== "";
  if (hasLotId !== hasExpiryAt) throw domainError("production_output_lot_invalid", 422);
  if (!hasLotId) {
    if (ingredient.lotTrackingPolicy === "REQUIRED") throw domainError("production_output_lot_required", 422);
    return null;
  }
  const lotId = cleanPurchaseText(output.lotId, "production_output_lot_invalid");
  if (!validIsoTimestamp(output.expiryAt)) throw domainError("production_output_expiry_invalid", 422);
  const expiryAt = new Date(output.expiryAt).toISOString();
  if (expiryAt <= occurredAt || expiryAt <= recordedAt) throw domainError("production_output_expired", 409);
  const minimumExpiryAt = new Date(new Date(occurredAt).getTime() + (ingredient.minimumShelfLifeDays ?? 0) * 86_400_000).toISOString();
  if (expiryAt < minimumExpiryAt) throw domainError("production_output_shelf_life_too_short", 409);
  return { lotId, expiryAt, qualityState: "USABLE", quantityBase, producedAt: occurredAt };
}

function normalizeProductionLossAuthority(value) {
  if (!value || Object.keys(value).sort().join("\u0000") !== ["abnormalQuantityBase", "abnormalValueRupiah", "normalQuantityBase", "policy", "valuationMethod"].sort().join("\u0000")
    || value.policy !== "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1"
    || value.valuationMethod !== "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1") throw domainError("production_loss_authority_invalid", 422);
  const normalQuantityBase = exactProductionNonnegativeQuantity(value.normalQuantityBase, "production_loss_quantity_invalid");
  const abnormalQuantityBase = exactProductionNonnegativeQuantity(value.abnormalQuantityBase, "production_loss_quantity_invalid");
  const abnormalValueRupiah = Number(value.abnormalValueRupiah);
  if (!Number.isSafeInteger(abnormalValueRupiah) || abnormalValueRupiah < 0
    || (abnormalQuantityBase === 0 && abnormalValueRupiah !== 0)) throw domainError("production_abnormal_loss_value_invalid", 422);
  return { policy: value.policy, valuationMethod: value.valuationMethod, normalQuantityBase, abnormalQuantityBase, abnormalValueRupiah };
}

function productionAbnormalLossValue(inputValueRupiah, outputQuantityBase, abnormalQuantityBase) {
  if (abnormalQuantityBase === 0) return 0;
  const outputUnits = BigInt(Math.round(outputQuantityBase * 1_000_000));
  const abnormalUnits = BigInt(Math.round(abnormalQuantityBase * 1_000_000));
  const denominator = outputUnits + abnormalUnits;
  const numerator = BigInt(inputValueRupiah) * abnormalUnits;
  const result = numerator / denominator + ((numerator % denominator) * 2n >= denominator ? 1n : 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw domainError("production_abnormal_loss_value_invalid", 422);
  return Number(result);
}

function saleMovementFingerprint(movement) {
  return JSON.stringify({
    movementType: movement.movementType, ingredientId: movement.ingredientId, quantityInputBase: movement.quantityInputBase,
    quantityAppliedBase: movement.quantityAppliedBase, shortageBase: movement.shortageBase,
    referenceType: movement.referenceType, referenceId: movement.referenceId, referenceCode: movement.referenceCode,
  });
}

function cogsAdjustmentFingerprint(adjustment) {
  return JSON.stringify({
    adjustmentType: adjustment.adjustmentType,
    sourceType: adjustment.sourceType,
    receiptId: adjustment.receiptId,
    consumptionId: adjustment.consumptionId,
    movementId: adjustment.movementId,
    orderId: adjustment.orderId,
    orderNumber: adjustment.orderNumber,
    ingredientId: adjustment.ingredientId,
    quantityResolvedBase: adjustment.quantityResolvedBase,
    provisionalUnitCostRupiah: adjustment.provisionalUnitCostRupiah,
    actualUnitCostRupiah: adjustment.actualUnitCostRupiah,
    provisionalCostRupiah: adjustment.provisionalCostRupiah,
    actualCostRupiah: adjustment.actualCostRupiah,
    adjustmentRupiah: adjustment.adjustmentRupiah,
    remainingShortageBaseAfter: adjustment.remainingShortageBaseAfter,
    occurredAt: adjustment.occurredAt,
  });
}

function assertOfflineConsumptionInputKeys(input) {
  const allowed = new Set(["orderId", "orderNumber", "items", "paidAt", "preparingAt", "actorId", "productionStartId", "idempotencyKey", "consumptionReason", "remakeId", "reason", "offlineEvent"]);
  if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).some((key) => !allowed.has(key))) {
    throw domainError("offline_event_input_invalid", 422);
  }
}

function normalizeProductionStartContext({ productionStartId, idempotencyKey, consumptionReason, remakeId, reason, fingerprint, orderId }) {
  if (productionStartId === undefined && consumptionReason === undefined) {
    const id = originalProductionStartId(orderId);
    const normalizedReason = "ORIGINAL";
    const normalizedKey = productionStartKey(id);
    const normalizedStartReason = defaultProductionStartReason(normalizedReason);
    return {
      id, idempotencyKey: normalizedKey, reason: normalizedReason, remakeId: null, startReason: normalizedStartReason,
      fingerprint: productionStartFingerprint({ productionStartId: id, idempotencyKey: normalizedKey, consumptionReason: normalizedReason, remakeId: null, reason: normalizedStartReason, fingerprint }),
      implicitOriginal: true,
    };
  }
  if (productionStartId === undefined || consumptionReason === undefined) throw domainError("production_start_input_invalid", 422);
  const id = cleanProductionStartId(productionStartId);
  if (!["ORIGINAL", "REMAKE", OFFLINE_CONSUMPTION_REASON].includes(consumptionReason)) throw domainError("production_start_input_invalid", 422);
  const normalizedRemakeId = consumptionReason === "REMAKE"
    ? remakeId == null ? null : cleanReference(remakeId, "remake_id_invalid")
    : null;
  if (consumptionReason !== "REMAKE" && remakeId !== null && remakeId !== undefined) throw domainError("production_start_input_invalid", 422);
  const normalizedKey = idempotencyKey === undefined ? productionStartKey(id) : cleanProductionStartKey(idempotencyKey);
  const normalizedStartReason = cleanProductionStartReason(reason ?? defaultProductionStartReason(consumptionReason));
  return {
    id, idempotencyKey: normalizedKey, reason: consumptionReason, remakeId: normalizedRemakeId, startReason: normalizedStartReason,
    fingerprint: productionStartFingerprint({ productionStartId: id, idempotencyKey: normalizedKey, consumptionReason, remakeId: normalizedRemakeId, reason: normalizedStartReason, fingerprint }),
    implicitOriginal: consumptionReason === "ORIGINAL",
  };
}

function normalizeOfflineEvent(value) {
  if (!validOfflineEventRecord(value)) throw domainError("offline_event_invalid", 422);
  return {
    eventId: value.eventId,
    deviceId: value.deviceId,
    localSequence: value.localSequence,
    capturedAt: value.capturedAt,
    baseHppVersion: value.baseHppVersion,
  };
}

function validOfflineEventRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const keys = Object.keys(value).sort();
  if (keys.join("\u0000") !== ["baseHppVersion", "capturedAt", "deviceId", "eventId", "localSequence"].join("\u0000")) return false;
  return validStoredText(value.eventId, 80) && validStoredText(value.deviceId, 80)
    && Number.isSafeInteger(value.localSequence) && value.localSequence >= 1 && value.localSequence <= 1_000_000_000
    && validIsoTimestamp(value.capturedAt) && Number.isSafeInteger(value.baseHppVersion) && value.baseHppVersion >= 1;
}

function validateOfflineConsumptionCommand({ sourceEvent, productionContext, orderId, paidAt, occurredAt, actorId, currentVersion }) {
  if (!productionContext.id || productionContext.id !== sourceEvent.eventId || productionContext.reason !== OFFLINE_CONSUMPTION_REASON
    || actorId !== `OFFLINE_DEVICE:${sourceEvent.deviceId}` || paidAt !== sourceEvent.capturedAt || occurredAt !== sourceEvent.capturedAt
    || sourceEvent.baseHppVersion > currentVersion || !validStoredText(orderId, 80)) throw domainError("offline_event_invalid", 422);
}

function productionStartFingerprint({ productionStartId, idempotencyKey, consumptionReason, remakeId, reason, fingerprint }) {
  return JSON.stringify({ productionStartId, idempotencyKey, consumptionReason, remakeId, reason, fingerprint });
}

function offlineEventFingerprint({ sourceEvent, orderId, orderNumber, fingerprint, productionStartFingerprint: startFingerprint }) {
  const canonicalSourceEvent = {
    eventId: sourceEvent.eventId,
    deviceId: sourceEvent.deviceId,
    localSequence: sourceEvent.localSequence,
    capturedAt: sourceEvent.capturedAt,
    baseHppVersion: sourceEvent.baseHppVersion,
  };
  return JSON.stringify({ sourceEvent: canonicalSourceEvent, orderId, orderNumber, fingerprint, productionStartFingerprint: startFingerprint });
}

function saleConsumptionFingerprint(orderId, orderNumber, paidAt, occurredAt, trigger, items) {
  return JSON.stringify({ orderId, orderNumber, paidAt, occurredAt, trigger, items });
}

function originalProductionStartId(orderId) {
  return `ORIGINAL:${createHash("sha256").update(orderId).digest("hex")}`;
}

function productionStartKey(productionStartId) {
  return `production:${createHash("sha256").update(productionStartId).digest("hex")}`;
}

function cleanProductionStartId(value) {
  if (!validStoredText(value, 80)) throw domainError("production_start_id_invalid", 422);
  return value;
}

function validProductionStartKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,80}$/.test(value);
}

function cleanProductionStartKey(value) {
  if (!validProductionStartKey(value)) throw domainError("production_start_idempotency_key_invalid", 422);
  return value;
}

function defaultProductionStartReason(consumptionReason) {
  if (consumptionReason === "REMAKE") return "Remake production start";
  if (consumptionReason === OFFLINE_CONSUMPTION_REASON) return "Offline physical sale production start";
  return "Original production start";
}

function cleanProductionStartReason(value) {
  if (!validStoredText(value, 160)) throw domainError("production_start_reason_invalid", 422);
  return value;
}

function inventoryReservationFingerprint(orderId, orderNumber, items) {
  return JSON.stringify({ orderId, orderNumber, items });
}

function migrateSaleConsumptionV17(consumption) {
  const migrated = {
    ...structuredClone(consumption),
    trigger: "PAYMENT_PAID_LEGACY",
  };
  migrated.items = migrated.items.map((item) => normalizeSaleItem({ ...item, recipeSnapshot: { lines: item.recipeLines } }));
  migrated.fingerprint = saleConsumptionFingerprint(
    migrated.orderId,
    migrated.orderNumber,
    migrated.paidAt,
    migrated.occurredAt,
    migrated.trigger,
    migrated.items,
  );
  return migrated;
}

function migrateSaleConsumptionV18(consumption, movements) {
  const migrated = structuredClone(consumption);
  migrated.lines = migrated.lines.map((line) => {
    const movement = line.movementId ? movements.find((item) => item.id === line.movementId) : null;
    if (!movement) {
      return {
        ...line,
        appliedInventoryCostRupiah: 0,
        provisionalShortageUnitCostRupiah: null,
        provisionalShortageCostRupiah: 0,
        postedCogsRupiah: 0,
      };
    }
    const appliedInventoryCostRupiah = -movement.inventoryValueDeltaRupiah;
    const provisionalShortageCostRupiah = roundedRupiah(line.shortageBase * movement.unitCostSnapshotRupiah);
    return {
      ...line,
      appliedInventoryCostRupiah,
      provisionalShortageUnitCostRupiah: movement.unitCostSnapshotRupiah,
      provisionalShortageCostRupiah,
      postedCogsRupiah: safeRupiah(appliedInventoryCostRupiah + provisionalShortageCostRupiah),
    };
  });
  return migrated;
}

function migrateSaleConsumptionV19(consumption) {
  const migrated = structuredClone(consumption);
  migrated.productionStartId = originalProductionStartId(migrated.orderId);
  migrated.productionStartIdempotencyKey = productionStartKey(migrated.productionStartId);
  migrated.consumptionReason = "ORIGINAL";
  migrated.remakeId = null;
  migrated.productionStartReason = defaultProductionStartReason("ORIGINAL");
  migrated.productionStartFingerprint = productionStartFingerprint({
    productionStartId: migrated.productionStartId,
    idempotencyKey: migrated.productionStartIdempotencyKey,
    consumptionReason: migrated.consumptionReason,
    remakeId: migrated.remakeId,
    reason: migrated.productionStartReason,
    fingerprint: migrated.fingerprint,
  });
  migrated.sourceEvent = null;
  migrated.requiresReview = migrated.status === "SHORTAGE";
  return migrated;
}

function deriveCogsAdjustmentsForReceipt({ receiptId, receivedAt, acceptedLines, saleConsumptions, priorAdjustments }) {
  const adjustments = [];
  for (const receiptLine of acceptedLines) {
    const actualUnitCostRupiah = roundedUnitCost(receiptLine.totalCostRupiah / receiptLine.baseQuantity);
    if (!validUnitCost(actualUnitCostRupiah)) throw domainError("purchase_unit_cost_overflow", 422);
    let receiptResolvedQuantity = 0;
    let receiptResolvedCost = 0;
    const shortages = saleConsumptions
      .flatMap((consumption) => consumption.lines
        .filter((line) => line.ingredientId === receiptLine.ingredientId && line.status === "SHORTAGE")
        .map((line) => ({ consumption, line })))
      .sort((a, b) => a.consumption.version - b.consumption.version || a.consumption.id.localeCompare(b.consumption.id));
    for (const { consumption, line } of shortages) {
      if (receiptResolvedQuantity >= receiptLine.baseQuantity) break;
      const prior = priorAdjustments.filter((item) => item.consumptionId === consumption.id && item.ingredientId === line.ingredientId);
      const previouslyResolvedQuantity = prior.reduce((sum, item) => roundedQuantity(sum + item.quantityResolvedBase), 0);
      const previouslyResolvedCost = prior.reduce((sum, item) => safeRupiah(sum + item.provisionalCostRupiah), 0);
      const unresolvedQuantity = roundedQuantity(line.shortageBase - previouslyResolvedQuantity);
      if (unresolvedQuantity <= 0) continue;
      const availableReceiptQuantity = roundedQuantity(receiptLine.baseQuantity - receiptResolvedQuantity);
      const quantityResolvedBase = Math.min(unresolvedQuantity, availableReceiptQuantity);
      const nextReceiptResolvedQuantity = roundedQuantity(receiptResolvedQuantity + quantityResolvedBase);
      const nextReceiptResolvedCost = roundedRupiah(receiptLine.totalCostRupiah * nextReceiptResolvedQuantity / receiptLine.baseQuantity);
      const actualCostRupiah = nextReceiptResolvedCost - receiptResolvedCost;
      const nextProvisionalResolvedQuantity = roundedQuantity(previouslyResolvedQuantity + quantityResolvedBase);
      const nextProvisionalResolvedCost = roundedRupiah(line.provisionalShortageCostRupiah * nextProvisionalResolvedQuantity / line.shortageBase);
      const provisionalCostRupiah = nextProvisionalResolvedCost - previouslyResolvedCost;
      const adjustment = {
        id: randomUUID(),
        idempotencyKey: cogsAdjustmentKey(receiptId, consumption.id, line.ingredientId),
        adjustmentType: "SHORTAGE_COST_REVALUATION",
        sourceType: "PURCHASE_RECEIPT",
        receiptId,
        consumptionId: consumption.id,
        movementId: line.movementId,
        orderId: consumption.orderId,
        orderNumber: consumption.orderNumber,
        ingredientId: line.ingredientId,
        quantityResolvedBase,
        provisionalUnitCostRupiah: line.provisionalShortageUnitCostRupiah,
        actualUnitCostRupiah,
        provisionalCostRupiah,
        actualCostRupiah,
        adjustmentRupiah: safeRupiah(actualCostRupiah - provisionalCostRupiah),
        remainingShortageBaseAfter: roundedQuantity(line.shortageBase - nextProvisionalResolvedQuantity),
        occurredAt: receivedAt,
      };
      adjustment.fingerprint = cogsAdjustmentFingerprint(adjustment);
      adjustments.push(adjustment);
      receiptResolvedQuantity = nextReceiptResolvedQuantity;
      receiptResolvedCost = nextReceiptResolvedCost;
    }
  }
  return adjustments;
}

function normalizeSaleItem(item) {
  const hppSnapshotStatus = item?.hppSnapshotStatus;
  const incompleteSnapshot = ["INCOMPLETE", "UNVERIFIED"].includes(hppSnapshotStatus);
  const recipeLinesSource = Array.isArray(item?.recipeSnapshot?.lines)
    ? item.recipeSnapshot.lines
    : incompleteSnapshot ? [] : null;
  const legacyUnmapped = !validStoredText(item?.productId, 80)
    && incompleteSnapshot && recipeLinesSource.length === 0
    && validStoredText(item?.id, 80);
  const productId = legacyUnmapped ? `LEGACY_UNMAPPED:${item.id}` : item?.productId;
  if (!item || !validStoredText(productId, 80) || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 100
    || !["VERIFIED", "INCOMPLETE", "UNVERIFIED"].includes(hppSnapshotStatus) || !recipeLinesSource) throw domainError("sale_consumption_input_invalid", 422);
  const recipeLines = recipeLinesSource.map((line) => {
    if (!line || !validStoredText(line.ingredientId, 80) || !validQuantity(line.qty)) throw domainError("sale_consumption_input_invalid", 422);
    return { ingredientId: line.ingredientId, qty: line.qty };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  return { productId, qty: item.qty, hppSnapshotStatus, recipeLines };
}

function modifierCostCoverage(selections) {
  if (selections == null) return { complete: true, status: "NOT_APPLICABLE", pricedSelections: [], unmappedSelections: [] };
  if (!Array.isArray(selections) || selections.length > 8) throw domainError("modifier_selection_invalid", 422);
  const priced = selections.filter((selection) => Number(selection?.priceDeltaRupiah ?? 0) > 0);
  const pricedSelections = priced.map((selection) => ({
    groupId: cleanSnapshotText(selection.groupId, "modifier_selection_invalid"),
    groupLabel: cleanSnapshotText(selection.groupLabel ?? selection.groupId, "modifier_selection_invalid"),
    optionId: cleanSnapshotText(selection.optionId, "modifier_selection_invalid"),
    optionLabel: cleanSnapshotText(selection.optionLabel ?? selection.optionId, "modifier_selection_invalid"),
    priceDeltaRupiah: selection.priceDeltaRupiah,
  }));
  if (pricedSelections.some((selection) => !Number.isSafeInteger(selection.priceDeltaRupiah) || selection.priceDeltaRupiah <= 0 || selection.priceDeltaRupiah > 1_000_000)) throw domainError("modifier_selection_invalid", 422);
  const unmappedSelections = pricedSelections.filter((selection) => false);
  return {
    complete: unmappedSelections.length === 0,
    status: unmappedSelections.length ? "UNMAPPED_PRICED_MODIFIER" : "NOT_APPLICABLE",
    pricedSelections,
    unmappedSelections,
  };
}

function mergeRecipeCostLines(lines) {
  const merged = new Map();
  for (const line of lines) {
    if (!line?.complete) {
      merged.set(`incomplete:${merged.size}`, line);
      continue;
    }
    const key = JSON.stringify([line.ingredientId, line.name, line.unit, line.unitCostRupiah]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...line });
      continue;
    }
    const qty = roundedQuantity(existing.qty + line.qty);
    const costRupiah = existing.costRupiah + line.costRupiah;
    if (!Number.isSafeInteger(costRupiah) || costRupiah < 0) throw domainError("modifier_recipe_cost_overflow", 422);
    merged.set(key, { ...existing, qty, costRupiah });
  }
  return [...merged.values()];
}

function pricedModifierOptionsForProduct(product) {
  return (product.modifierGroups ?? [])
    .flatMap((group) => (group.options ?? []).map((option) => ({
      groupId: group.id,
      groupLabel: group.label,
      optionId: option.id,
      optionLabel: option.label,
      priceDeltaRupiah: option.priceDeltaRupiah,
    })))
    .filter((option) => Number.isSafeInteger(option.priceDeltaRupiah) && option.priceDeltaRupiah > 0);
}

function modifierRecipeKey(groupId, optionId) {
  return `${cleanModifierId(groupId)}:${cleanModifierId(optionId)}`;
}

function fulfillmentRecipeKey(orderType, station) {
  return `${cleanFulfillmentOrderType(orderType)}:${cleanFulfillmentStation(station)}`;
}

function validModifierId(value) {
  return typeof value === "string" && /^[a-z0-9._-]{1,40}$/.test(value);
}

function cleanModifierId(value) {
  if (!validModifierId(value)) throw domainError("modifier_recipe_key_invalid", 422);
  return value;
}

function cleanFulfillmentOrderType(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!FULFILLMENT_RECIPE_ORDER_TYPES.has(normalized)) throw domainError("fulfillment_recipe_key_invalid", 422);
  return normalized;
}

function cleanOptionalFulfillmentOrderType(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized || !["DINE_IN", ...FULFILLMENT_RECIPE_ORDER_TYPES].includes(normalized)) throw domainError("order_type_invalid", 422);
  return normalized;
}

function cleanFulfillmentStation(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!FULFILLMENT_RECIPE_STATIONS.has(normalized)) throw domainError("fulfillment_recipe_key_invalid", 422);
  return normalized;
}

function cleanSnapshotText(value, code) {
  if (!validStoredText(String(value ?? "").trim(), 80)) throw domainError(code, 422);
  return String(value).trim();
}

function cleanReference(value, code) {
  if (!validStoredText(value, 80)) throw domainError(code, 422);
  return value;
}

function inventoryCountFingerprint(lines, metadata) {
  return JSON.stringify({ ...(metadata ? { countKind: metadata.countKind, businessDate: metadata.businessDate } : {}), lines: lines.map((line) => ({ ingredientId: line.ingredientId, quantityBase: line.quantityBase, ...(line.openingUnitCostRupiah === undefined ? {} : { openingUnitCostRupiah: line.openingUnitCostRupiah }) })) });
}

function inventoryPeriodFingerprint(openingCountId, closingCountId) {
  return JSON.stringify({ openingCountId, closingCountId });
}

function applyInventoryMovementToBalance(previous, movementType, quantityInputBase) {
  const quantityAfterBase = movementType === "CYCLE_COUNT" ? quantityInputBase : roundedQuantity(previous.quantityBase - quantityInputBase);
  if (quantityAfterBase < 0) throw domainError("inventory_quantity_insufficient", 409);
  const inventoryValueAfterRupiah = quantityAfterBase === 0 ? 0 : Math.round(quantityAfterBase * previous.averageCostPerBaseUnitRupiah);
  if (!Number.isSafeInteger(inventoryValueAfterRupiah)) throw domainError("inventory_value_overflow", 422);
  const averageCostPerBaseUnitRupiah = quantityAfterBase === 0 ? previous.averageCostPerBaseUnitRupiah : roundedUnitCost(inventoryValueAfterRupiah / quantityAfterBase);
  return {
    quantityDeltaBase: roundedQuantity(quantityAfterBase - previous.quantityBase),
    inventoryValueDeltaRupiah: inventoryValueAfterRupiah - previous.inventoryValueRupiah,
    balance: { quantityBase: quantityAfterBase, inventoryValueRupiah: inventoryValueAfterRupiah, averageCostPerBaseUnitRupiah },
  };
}

function applyStoredInventoryMovementDelta(previous, quantityDeltaBase, inventoryValueDeltaRupiah) {
  const productionPrecision = hasSubMillPrecision(previous.quantityBase) || hasSubMillPrecision(quantityDeltaBase);
  const quantityBase = productionPrecision
    ? productionBalanceAfter(previous.quantityBase, quantityDeltaBase)
    : roundedQuantity(previous.quantityBase + quantityDeltaBase);
  const inventoryValueRupiah = previous.inventoryValueRupiah + inventoryValueDeltaRupiah;
  if (!(productionPrecision ? validProductionBalanceQuantity(quantityBase) : validBalanceQuantity(quantityBase)) || !Number.isSafeInteger(inventoryValueRupiah) || inventoryValueRupiah < 0
    || (quantityBase === 0) !== (inventoryValueRupiah === 0)) throw domainError("inventory_movement_reversal_balance_invalid", 409);
  const averageCostPerBaseUnitRupiah = quantityBase === 0 ? previous.averageCostPerBaseUnitRupiah : roundedUnitCost(inventoryValueRupiah / quantityBase);
  return { quantityDeltaBase, inventoryValueDeltaRupiah, balance: { quantityBase, inventoryValueRupiah, averageCostPerBaseUnitRupiah } };
}

function normalizeMovementEffectiveAt(value, createdAt) {
  if (value == null) return createdAt;
  if (!validIsoTimestamp(value) || new Date(value) > new Date(createdAt)) throw domainError("inventory_movement_effective_at_invalid", 422);
  return new Date(value).toISOString();
}

function applySupplierValueMovement(previous, quantityBase, valueRupiah, direction) {
  if (!previous || !validMovementQuantity(quantityBase, false) || !Number.isSafeInteger(valueRupiah) || valueRupiah <= 0 || !["OUT", "IN"].includes(direction)) throw domainError("supplier_return_balance_invalid", 409);
  const quantityAfterBase = roundedQuantity(previous.quantityBase + (direction === "IN" ? quantityBase : -quantityBase));
  const inventoryValueRupiah = previous.inventoryValueRupiah + (direction === "IN" ? valueRupiah : -valueRupiah);
  if (!validBalanceQuantity(quantityAfterBase) || !Number.isSafeInteger(inventoryValueRupiah) || inventoryValueRupiah < 0 || (quantityAfterBase === 0) !== (inventoryValueRupiah === 0)) throw domainError(direction === "OUT" ? "supplier_return_stock_insufficient" : "supplier_replacement_value_invalid", 409);
  const averageCostPerBaseUnitRupiah = quantityAfterBase === 0 ? previous.averageCostPerBaseUnitRupiah : roundedUnitCost(inventoryValueRupiah / quantityAfterBase);
  if (!validUnitCost(averageCostPerBaseUnitRupiah)) throw domainError("supplier_return_balance_invalid", 409);
  return { quantityBase: quantityAfterBase, inventoryValueRupiah, averageCostPerBaseUnitRupiah };
}

function applySaleConsumptionToBalance(previous, quantityRequiredBase) {
  const quantityAppliedBase = Math.min(previous.quantityBase, quantityRequiredBase);
  const quantityAfterBase = roundedQuantity(previous.quantityBase - quantityAppliedBase);
  const inventoryValueAfterRupiah = quantityAfterBase === 0 ? 0 : Math.round(quantityAfterBase * previous.averageCostPerBaseUnitRupiah);
  if (!Number.isSafeInteger(inventoryValueAfterRupiah)) throw domainError("inventory_value_overflow", 422);
  return {
    quantityDeltaBase: -quantityAppliedBase,
    inventoryValueDeltaRupiah: inventoryValueAfterRupiah - previous.inventoryValueRupiah,
    balance: { quantityBase: quantityAfterBase, inventoryValueRupiah: inventoryValueAfterRupiah, averageCostPerBaseUnitRupiah: previous.averageCostPerBaseUnitRupiah },
  };
}

function calculateProvisionalShortageCost(shortageBase, unitCostRupiah) {
  if (!validBalanceQuantity(shortageBase) || !validUnitCost(unitCostRupiah)) throw domainError("provisional_shortage_cost_invalid", 422);
  const costRupiah = roundedRupiah(shortageBase * unitCostRupiah);
  if (shortageBase > 0 && (unitCostRupiah <= 0 || costRupiah <= 0)) throw domainError("provisional_shortage_cost_unavailable", 409);
  return { unitCostRupiah, costRupiah };
}

function validStoredText(value, maxLength) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f<>]/.test(value);
}

function validIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validBusinessDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function cleanIdempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,80}$/.test(value)) throw domainError("purchase_idempotency_key_invalid", 422);
  return value;
}

function cogsAdjustmentKey(receiptId, consumptionId, ingredientId) {
  return `cogs:${createHash("sha256").update(`${receiptId}\u0000${consumptionId}\u0000${ingredientId}`).digest("hex")}`;
}

function cleanPurchaseText(value, code) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f<>]/.test(value)) throw domainError(code, 422);
  return value.trim();
}

function cleanIngredientCode(value) {
  if (typeof value !== "string") throw domainError("ingredient_code_invalid", 422);
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(normalized)) throw domainError("ingredient_code_invalid", 422);
  return normalized;
}

function cleanIngredientCategory(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60 || /[\u0000-\u001f<>]/.test(value)) throw domainError("ingredient_category_invalid", 422);
  return value.trim();
}

function cleanCategoryPrefix(value) {
  if (typeof value !== "string") throw domainError("material_category_prefix_invalid", 422);
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(normalized)) throw domainError("material_category_prefix_invalid", 422);
  return normalized;
}

function validateCategoryPreferences({ suggestedBaseUnit, storageType, expiryTracking }) {
  if (!MATERIAL_CATEGORY_BASE_UNITS.includes(suggestedBaseUnit)) throw domainError("material_category_base_unit_invalid", 422);
  if (!MATERIAL_CATEGORY_STORAGE_TYPES.includes(storageType)) throw domainError("material_category_storage_invalid", 422);
  if (typeof expiryTracking !== "boolean") throw domainError("material_category_expiry_tracking_invalid", 422);
}

function validateMaterialCategories(categories, stateRevision) {
  if (!Array.isArray(categories) || !categories.length) throw domainError("hpp_state_invalid", 500);
  const ids = new Set();
  const names = new Set();
  const prefixes = new Set();
  for (const item of categories) {
    const name = cleanIngredientCategory(item?.name);
    const prefix = cleanCategoryPrefix(item?.prefix);
    validateCategoryPreferences(item);
    const normalizedName = name.toLocaleLowerCase("id");
    if (!validStoredText(item.id, 80) || ids.has(item.id) || names.has(normalizedName) || prefixes.has(prefix)
      || !["ACTIVE", "ARCHIVED"].includes(item.status) || typeof item.isDefault !== "boolean"
      || !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 1 || !validIsoTimestamp(item.createdAt) || !validIsoTimestamp(item.updatedAt)
      || !Number.isSafeInteger(item.revision) || item.revision < 0 || item.revision > stateRevision) throw domainError("hpp_state_invalid", 500);
    ids.add(item.id); names.add(normalizedName); prefixes.add(prefix);
  }
}

function restoreMaterialCategoriesFromState(ingredients, audit) {
  const categories = defaultMaterialCategories();
  const byId = new Map(categories.map((item) => [item.id, item]));
  for (const event of [...audit].sort((a, b) => (a.version ?? 0) - (b.version ?? 0))) {
    if (!["material.category.created", "material.category.updated", "material.category.archived"].includes(event?.type) || !event.next) continue;
    byId.set(event.next.id, structuredClone(event.next));
  }
  for (const ingredient of ingredients) {
    if (ingredient.categorySnapshot) {
      const current = byId.get(ingredient.categorySnapshot.id);
      if (!current || ingredient.categorySnapshot.revision >= current.revision) byId.set(ingredient.categorySnapshot.id, structuredClone(ingredient.categorySnapshot));
      continue;
    }
    const categoryId = typeof ingredient.categoryId === "string" && ingredient.categoryId.trim() ? ingredient.categoryId.trim() : null;
    const name = typeof ingredient.category === "string" && ingredient.category.trim() ? ingredient.category.trim() : null;
    if (!categoryId || !name || byId.has(categoryId)) continue;
    const prefixes = new Set([...byId.values()].map((item) => item.prefix));
    const codePrefix = typeof ingredient.code === "string" ? ingredient.code.split("-")[0] : "";
    let prefix = /^[A-Z0-9]{2,5}$/.test(codePrefix) && !prefixes.has(codePrefix) ? codePrefix : "CAT";
    let suffix = 2;
    while (prefixes.has(prefix)) { prefix = `CT${suffix}`; suffix += 1; }
    byId.set(categoryId, {
      id: categoryId, name, prefix, suggestedBaseUnit: BASE_UNITS.has(ingredient.baseUnit) ? ingredient.baseUnit : "pcs",
      storageType: "AMBIENT", expiryTracking: ingredient.lotTrackingPolicy === "REQUIRED", status: "ACTIVE", isDefault: false,
      sortOrder: byId.size + 1, createdAt: ingredient.createdAt, updatedAt: ingredient.updatedAt, revision: ingredient.revision ?? 1,
    });
  }
  return [...byId.values()];
}

function materialCategorySnapshot(category) {
  return structuredClone({
    id: category.id,
    name: category.name,
    prefix: category.prefix,
    suggestedBaseUnit: category.suggestedBaseUnit,
    storageType: category.storageType,
    expiryTracking: category.expiryTracking,
    status: category.status,
    isDefault: category.isDefault,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
    revision: category.revision,
  });
}

function validateCategorySnapshot(snapshot, stateRevision) {
  validateMaterialCategories([snapshot], stateRevision);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanUom(value) {
  if (typeof value !== "string") throw domainError("ingredient_uom_invalid", 422);
  const normalized = value.trim().toLocaleLowerCase("id");
  if (!/^[a-z][a-z0-9 _.-]{0,29}$/.test(normalized)) throw domainError("ingredient_uom_invalid", 422);
  return normalized;
}

function cleanBarcode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{4,80}$/.test(value.trim())) throw domainError("ingredient_package_barcode_invalid", 422);
  return value.trim();
}

function exactConversionFactor(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000 || roundedConversion(value) !== value) throw domainError("ingredient_conversion_factor_invalid", 422);
  return value;
}

function exactConversionQuantity(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000 || roundedConversion(value) !== value) throw domainError("ingredient_conversion_quantity_invalid", 422);
  return value;
}

function roundedConversion(value) { return Math.round(value * 1_000_000) / 1_000_000; }

function exactRecipeYieldPct(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 100
    || Number(normalized.toFixed(3)) !== normalized) throw domainError("recipe_yield_invalid", 422);
  return normalized;
}

function roundedRecipeQuantity(normalizedQuantity, yieldPct) {
  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0 || normalizedQuantity > 1_000_000
    || roundedConversion(normalizedQuantity) !== normalizedQuantity) throw domainError("recipe_quantity_invalid", 422);

  // Both operands already have bounded decimal precision. Convert them to integers so
  // yield division and half-up rounding to 0.001 base unit cannot drift in binary floats.
  const normalizedMicrounits = BigInt(Math.round(normalizedQuantity * 1_000_000));
  const yieldMilliPercent = BigInt(Math.round(yieldPct * 1_000));
  const milliunitNumerator = normalizedMicrounits * 100n;
  const maximumMilliunits = 1_000_000_000n;
  if (milliunitNumerator > maximumMilliunits * yieldMilliPercent) throw domainError("recipe_quantity_invalid", 422);

  const roundedMilliunits = (milliunitNumerator + (yieldMilliPercent / 2n)) / yieldMilliPercent;
  if (roundedMilliunits <= 0n || roundedMilliunits > maximumMilliunits) throw domainError("recipe_quantity_invalid", 422);
  return Number(roundedMilliunits) / 1_000;
}

function standardConversionsFor(baseUnit) {
  const rows = baseUnit === "gram" ? [["kg", "gram", 1000]] : baseUnit === "ml" ? [["liter", "ml", 1000]] : [];
  return rows.map(([fromUom, toUom, factor]) => ({ id: `standard:${fromUom}:${toUom}`, fromUom, toUom, factor, revision: 0, effectiveAt: "1970-01-01T00:00:00.000Z", source: "STANDARD" }));
}

function findConversionPath(conversions, fromUom, toUom) {
  const queue = [{ uom: fromUom, path: [] }];
  const visited = new Set([fromUom]);
  while (queue.length) {
    const current = queue.shift();
    for (const edge of conversions.filter((item) => item.fromUom === current.uom).sort((a, b) => a.toUom.localeCompare(b.toUom))) {
      const path = [...current.path, edge];
      if (edge.toUom === toUom) return path;
      if (!visited.has(edge.toUom) && path.length < 8) { visited.add(edge.toUom); queue.push({ uom: edge.toUom, path }); }
    }
  }
  return null;
}

function normalizeReceiptDisposition(line, strictPhysicalDisposition) {
  if (strictPhysicalDisposition && line.deliveredPurchaseQuantity === undefined) throw domainError("purchase_delivered_quantity_required", 422);
  if (strictPhysicalDisposition && line.acceptedPurchaseQuantity === undefined) throw domainError("purchase_accepted_quantity_required", 422);
  const acceptedPurchaseQuantity = exactNonnegativeQuantity(
    line.acceptedPurchaseQuantity ?? line.purchaseQuantity ?? 0,
    "purchase_quantity_invalid",
  );
  if (line.acceptedPurchaseQuantity !== undefined && line.purchaseQuantity !== undefined && line.acceptedPurchaseQuantity !== line.purchaseQuantity) {
    throw domainError("purchase_accepted_quantity_conflict", 422);
  }
  const rejectedPurchaseQuantity = exactNonnegativeQuantity(line.rejectedPurchaseQuantity ?? 0, "purchase_rejected_quantity_invalid");
  const quarantinedPurchaseQuantity = exactNonnegativeQuantity(line.quarantinedPurchaseQuantity ?? 0, "purchase_quarantined_quantity_invalid");
  const pendingInspectionPurchaseQuantity = exactNonnegativeQuantity(line.pendingInspectionPurchaseQuantity ?? 0, "purchase_pending_inspection_quantity_invalid");
  const classifiedQuantity = roundedQuantity(acceptedPurchaseQuantity + rejectedPurchaseQuantity + quarantinedPurchaseQuantity + pendingInspectionPurchaseQuantity);
  const deliveredPurchaseQuantity = exactNonnegativeQuantity(line.deliveredPurchaseQuantity ?? classifiedQuantity, "purchase_delivered_quantity_invalid");
  if (deliveredPurchaseQuantity <= 0) throw domainError("purchase_order_receipt_quantity_required", 422);
  if (deliveredPurchaseQuantity !== classifiedQuantity) throw domainError("purchase_delivery_disposition_mismatch", 422);
  return {
    deliveredPurchaseQuantity,
    acceptedPurchaseQuantity,
    rejectedPurchaseQuantity,
    quarantinedPurchaseQuantity,
    pendingInspectionPurchaseQuantity,
  };
}

function normalizeReceivingFlowLocation(value, hasQuantity, strictReceivingLocations, legacyDefault, requiredCode) {
  if (!hasQuantity) {
    if (value !== undefined && value !== null && value !== "") throw domainError("purchase_flow_location_without_quantity", 422);
    return null;
  }
  if (strictReceivingLocations && (value === undefined || value === null || value === "")) throw domainError(requiredCode, 422);
  return cleanPurchaseText(value ?? legacyDefault, requiredCode);
}

function normalizePurchaseRejectionReason(rejectedPurchaseQuantity, value) {
  if (rejectedPurchaseQuantity === 0) {
    if (value !== undefined && value !== null && value !== "") throw domainError("purchase_rejection_reason_without_quantity", 422);
    return null;
  }
  if (!PURCHASE_REJECTION_REASONS.has(value)) throw domainError("purchase_rejection_reason_required", 422);
  return value;
}

function normalizeOverReceiptClassification(overPurchaseQuantity, value) {
  if (overPurchaseQuantity === 0) {
    if (value !== undefined && value !== null && value !== "") throw domainError("purchase_over_receipt_classification_without_overage", 422);
    return null;
  }
  if (!OVER_RECEIPT_CLASSIFICATIONS.has(value)) throw domainError("purchase_over_receipt_classification_required", 422);
  if (value === "ERROR") throw domainError("purchase_order_over_receipt_error", 409);
  return value;
}

function normalizePurchaseLots(lots, disposition, ingredient, receiptDate) {
  if (lots === undefined || lots === null) {
    if (ingredient.lotTrackingPolicy === "REQUIRED") throw domainError("purchase_lot_required", 422);
    return [];
  }
  if (!Array.isArray(lots) || !lots.length || lots.length > 50) throw domainError("purchase_lots_invalid", 422);
  const seen = new Set();
  const totals = { deliveredPurchaseQuantity: 0, acceptedPurchaseQuantity: 0, rejectedPurchaseQuantity: 0, quarantinedPurchaseQuantity: 0, pendingInspectionPurchaseQuantity: 0 };
  const normalized = lots.map((lot) => {
    if (!lot || typeof lot.lotCode !== "string") throw domainError("purchase_lot_identity_invalid", 422);
    const lotCode = cleanPurchaseText(lot.lotCode, "purchase_lot_identity_invalid");
    if (seen.has(lotCode)) throw domainError("purchase_lot_duplicate", 422);
    seen.add(lotCode);
    if (!validBusinessDate(lot.expiryDate)) throw domainError("purchase_lot_expiry_invalid", 422);
    const earliest = new Date(`${receiptDate}T00:00:00Z`);
    earliest.setUTCDate(earliest.getUTCDate() + ingredient.minimumShelfLifeDays);
    if (lot.expiryDate < earliest.toISOString().slice(0, 10)) throw domainError("purchase_lot_shelf_life_invalid", 422);
    const normalizedLot = {
      lotCode, expiryDate: lot.expiryDate,
      acceptedPurchaseQuantity: exactNonnegativeQuantity(lot.acceptedPurchaseQuantity ?? 0, "purchase_lot_quantity_invalid"),
      rejectedPurchaseQuantity: exactNonnegativeQuantity(lot.rejectedPurchaseQuantity ?? 0, "purchase_lot_quantity_invalid"),
      quarantinedPurchaseQuantity: exactNonnegativeQuantity(lot.quarantinedPurchaseQuantity ?? 0, "purchase_lot_quantity_invalid"),
      pendingInspectionPurchaseQuantity: exactNonnegativeQuantity(lot.pendingInspectionPurchaseQuantity ?? 0, "purchase_lot_quantity_invalid"),
    };
    const classified = roundedQuantity(normalizedLot.acceptedPurchaseQuantity + normalizedLot.rejectedPurchaseQuantity + normalizedLot.quarantinedPurchaseQuantity + normalizedLot.pendingInspectionPurchaseQuantity);
    normalizedLot.deliveredPurchaseQuantity = exactPositiveQuantity(lot.deliveredPurchaseQuantity, "purchase_lot_quantity_invalid");
    if (normalizedLot.deliveredPurchaseQuantity !== classified) throw domainError("purchase_lot_disposition_mismatch", 422);
    for (const field of Object.keys(totals)) totals[field] = roundedQuantity(totals[field] + normalizedLot[field]);
    return normalizedLot;
  }).sort((a, b) => a.lotCode.localeCompare(b.lotCode));
  for (const [field, value] of Object.entries(totals)) if (value !== disposition[field]) throw domainError("purchase_lot_totals_mismatch", 422);
  return normalized;
}

function validateStoredPurchaseLots(receipt, ingredients) {
  const byIngredient = new Map();
  for (const lot of receipt.lots) {
    if (!lot || !ingredients.has(lot.ingredientId)) throw domainError("hpp_state_invalid", 500);
    const ingredientLots = byIngredient.get(lot.ingredientId) ?? [];
    ingredientLots.push(lot);
    byIngredient.set(lot.ingredientId, ingredientLots);
  }
  for (const delivered of receipt.deliveredLines) {
    const ingredient = ingredients.get(delivered.ingredientId);
    const lots = byIngredient.get(delivered.ingredientId) ?? [];
    if (ingredient.lotTrackingPolicy === "REQUIRED" && !lots.length) throw domainError("hpp_state_invalid", 500);
    if (!lots.length) continue;
    const disposition = {
      deliveredPurchaseQuantity: delivered.deliveredPurchaseQuantity,
      acceptedPurchaseQuantity: receipt.lines.find((line) => line.ingredientId === delivered.ingredientId)?.purchaseQuantity ?? 0,
      rejectedPurchaseQuantity: receipt.rejectedLines.find((line) => line.ingredientId === delivered.ingredientId)?.rejectedPurchaseQuantity ?? 0,
      quarantinedPurchaseQuantity: receipt.quarantinedLines.find((line) => line.ingredientId === delivered.ingredientId)?.quarantinedPurchaseQuantity ?? 0,
      pendingInspectionPurchaseQuantity: receipt.pendingInspectionLines.find((line) => line.ingredientId === delivered.ingredientId)?.pendingInspectionPurchaseQuantity ?? 0,
    };
    let normalized;
    try { normalized = normalizePurchaseLots(lots.map(({ ingredientId: _ingredientId, ...lot }) => lot), disposition, ingredient, receipt.receivedAt.slice(0, 10)); } catch { throw domainError("hpp_state_invalid", 500); }
    if (lots.some((lot, index) => JSON.stringify({ lotCode: lot.lotCode, expiryDate: lot.expiryDate, acceptedPurchaseQuantity: lot.acceptedPurchaseQuantity, rejectedPurchaseQuantity: lot.rejectedPurchaseQuantity, quarantinedPurchaseQuantity: lot.quarantinedPurchaseQuantity, pendingInspectionPurchaseQuantity: lot.pendingInspectionPurchaseQuantity, deliveredPurchaseQuantity: lot.deliveredPurchaseQuantity }) !== JSON.stringify(normalized[index]))) throw domainError("hpp_state_invalid", 500);
  }
}

function normalizePurchaseFees(fees) {
  if (!Array.isArray(fees) || fees.length > 10) throw domainError("purchase_fees_invalid", 422);
  const types = new Set();
  const normalized = fees.map((fee) => {
    if (!fee || !PURCHASE_FEE_TYPES.has(fee.type) || types.has(fee.type) || !Number.isSafeInteger(fee.amountRupiah) || fee.amountRupiah <= 0 || fee.amountRupiah > 1_000_000_000) throw domainError("purchase_fee_invalid", 422);
    types.add(fee.type);
    return { type: fee.type, amountRupiah: fee.amountRupiah };
  }).sort((a, b) => a.type.localeCompare(b.type));
  const total = normalized.reduce((sum, fee) => sum + fee.amountRupiah, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000) throw domainError("purchase_fee_total_invalid", 422);
  return normalized;
}

function allocatePurchaseFees(lines, fees) {
  const totalFee = fees.reduce((sum, fee) => sum + fee.amountRupiah, 0);
  if (totalFee > 0 && !lines.length) throw domainError("purchase_fee_without_accepted_stock", 422);
  const totalItems = lines.reduce((sum, line) => sum + line.itemCostRupiah, 0);
  if (!Number.isSafeInteger(totalItems) || totalItems < 0 || (totalFee > 0 && totalItems <= 0)) throw domainError("purchase_cost_invalid", 422);
  let allocated = 0;
  const lastBillableIndex = lines.findLastIndex((line) => line.itemCostRupiah > 0);
  return lines.map((line, index) => {
    const allocatedFeeRupiah = line.itemCostRupiah === 0 ? 0 : index === lastBillableIndex
      ? totalFee - allocated
      : Number(BigInt(totalFee) * BigInt(line.itemCostRupiah) / BigInt(totalItems));
    allocated += allocatedFeeRupiah;
    const totalCostRupiah = line.itemCostRupiah + allocatedFeeRupiah;
    if (!Number.isSafeInteger(totalCostRupiah)) throw domainError("purchase_value_overflow", 422);
    return { ...line, allocatedFeeRupiah, totalCostRupiah };
  });
}

function exactPositiveQuantity(value, code) {
  if (!validQuantity(value)) throw domainError(code, 422);
  return value;
}

function exactProductionQuantity(value, code) {
  const units = productionQuantityUnits(value);
  if (units !== null && units > 1_000_000_000_000n) throw domainError("production_quantity_overflow", 422);
  if (units === null || units <= 0n) throw domainError(code, 422);
  return Number(formatProductionQuantity(units));
}

function exactProductionNonnegativeQuantity(value, code) {
  const units = productionQuantityUnits(value);
  if (units !== null && units > 1_000_000_000_000n) throw domainError("production_quantity_overflow", 422);
  if (units === null) throw domainError(code, 422);
  return Number(formatProductionQuantity(units));
}

function exactNonnegativeQuantity(value, code) {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000 || roundedQuantity(value) !== value) throw domainError(code, 422);
  return value;
}

function validQuantity(value) {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 && roundedQuantity(value) === value;
}

function validBalanceQuantity(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000 && roundedQuantity(value) === value;
}

function validSignedQuantity(value) { return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000 && roundedQuantity(value) === value; }
function validMovementQuantity(value, allowZero) { return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && value <= 1_000_000_000_000 && roundedQuantity(value) === value; }
function exactMovementQuantity(value, allowZero) { if (!validMovementQuantity(value, allowZero)) throw domainError("inventory_quantity_invalid", 422); return value; }

function validProductionBalanceQuantity(value) {
  const units = productionQuantityUnits(value);
  return units !== null && units <= BigInt(Number.MAX_SAFE_INTEGER);
}

function validStoredBalanceQuantity(value) { return validBalanceQuantity(value) || validProductionBalanceQuantity(value); }
function validStoredSignedQuantity(value) { return validSignedQuantity(value) || validProductionSignedQuantity(value); }
function validStoredMovementQuantity(value, allowZero) {
  return validMovementQuantity(value, allowZero) || (validProductionBalanceQuantity(value) && (allowZero || Number(value) > 0));
}

function validProductionSignedQuantity(value) {
  const units = productionSignedQuantityUnits(value);
  return units !== null && units >= BigInt(Number.MIN_SAFE_INTEGER) && units <= BigInt(Number.MAX_SAFE_INTEGER);
}

function productionBalanceAfter(previous, delta) {
  const previousUnits = productionQuantityUnits(previous);
  const deltaUnits = productionSignedQuantityUnits(delta);
  if (previousUnits === null || deltaUnits === null) throw domainError("production_quantity_invalid", 422);
  const units = previousUnits + deltaUnits;
  if (units < 0n) throw domainError("production_stock_shortage", 409);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw domainError("production_quantity_overflow", 422);
  const result = Number(formatProductionQuantity(units));
  if (productionQuantityUnits(result) !== units) throw domainError("production_quantity_overflow", 422);
  return result;
}

function productionQuantityUnits(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function productionSignedQuantityUnits(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const units = productionQuantityUnits(negative ? text.slice(1) : text);
  return units === null ? null : negative ? -units : units;
}

function formatProductionQuantity(units) {
  const fraction = String(units % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function hasSubMillPrecision(value) {
  const units = productionSignedQuantityUnits(value);
  return units !== null && units % 1_000n !== 0n;
}

function validReceiptBaseQuantity(value) {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000_000 && roundedQuantity(value) === value;
}

function validUnitCost(value) {
  return Number.isFinite(value) && value >= 0 && value <= 10_000_000 && roundedUnitCost(value) === value;
}

function validRupiah(value) { return Number.isSafeInteger(value) && value >= 0; }
function validSignedRupiah(value) { return Number.isSafeInteger(value); }
function roundedRupiah(value) {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) throw domainError("inventory_value_overflow", 422);
  return rounded;
}
function safeRupiah(value) {
  if (!Number.isSafeInteger(value)) throw domainError("inventory_value_overflow", 422);
  return value;
}

function roundedQuantity(value) { return Math.round(value * 1000) / 1000; }
function roundedUnitCost(value) { return Math.round(value * 1_000_000) / 1_000_000; }

function domainError(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
