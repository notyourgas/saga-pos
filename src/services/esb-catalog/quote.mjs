import { createHash } from "node:crypto";

import { catalogPricingError, deepFreeze, requiredText } from "./errors.mjs";
import { applyFreePriceOverride } from "./free-price.mjs";
import { validateModifierSelections } from "./modifiers.mjs";
import { assertRupiah, calculateTaxService, decomposeCatalogPrice, MAX_RUPIAH, roundRupiah } from "./money.mjs";
import { applyPromotionVersions } from "./promotions.mjs";
import { assertEffectiveVersion, resolvePriceEntry } from "./versions.mjs";

function safeProduct(left, right, code) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RUPIAH) throw catalogPricingError(code);
  return value;
}

export function createCatalogQuote({
  priceBookVersion,
  pricingPolicyVersion,
  items,
  promotions = [],
  occurredAt,
  context = {},
} = {}) {
  assertEffectiveVersion(priceBookVersion, occurredAt, "price_book_not_effective");
  assertEffectiveVersion(pricingPolicyVersion, occurredAt, "pricing_policy_not_effective");
  if (priceBookVersion.pricingPolicyVersionId !== pricingPolicyVersion.id || priceBookVersion.currency !== pricingPolicyVersion.currency) {
    throw catalogPricingError("price_book_policy_mismatch", 409);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw catalogPricingError("catalog_quote_items_required");
  const lineIds = new Set();
  const prepared = items.map((item) => {
    const lineId = requiredText(item?.lineId, "catalog_quote_line_id_required");
    if (lineIds.has(lineId)) throw catalogPricingError("catalog_quote_line_duplicate");
    lineIds.add(lineId);
    const productId = requiredText(item.productId, "catalog_quote_product_id_required");
    const variantId = item.variantId == null ? null : requiredText(item.variantId, "catalog_quote_variant_id_invalid");
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw catalogPricingError("catalog_quote_quantity_invalid");
    const priceEntry = resolvePriceEntry(priceBookVersion, { productId, variantId, channel: context.channel ?? "POS" });
    const modifier = validateModifierSelections({ groups: item.modifierGroups ?? [], selections: item.modifierSelections ?? [] });
    let unitPriceRupiah = priceEntry.priceRupiah;
    let freePriceAudit = null;
    if (item.requestedFreePriceRupiah != null) {
      const override = applyFreePriceOverride({
        priceEntry,
        requestedPriceRupiah: item.requestedFreePriceRupiah,
        actorUserId: context.actorUserId,
        operationKey: item.freePriceOperationKey,
        authorization: item.freePriceAuthorization,
        occurredAt,
      });
      unitPriceRupiah = override.priceRupiah;
      freePriceAudit = override.audit;
    }
    assertRupiah(unitPriceRupiah + modifier.priceDeltaRupiah, "catalog_quote_unit_price_invalid");
    const listedLinePriceRupiah = safeProduct(unitPriceRupiah + modifier.priceDeltaRupiah, quantity, "catalog_quote_line_total_invalid");
    const decomposed = decomposeCatalogPrice(listedLinePriceRupiah, pricingPolicyVersion);
    return {
      lineId,
      productId,
      categoryId: item.categoryId == null ? null : String(item.categoryId),
      variantId,
      quantity,
      productNameSnapshot: requiredText(item.productName, "catalog_quote_product_name_required", { max: 120 }),
      priceEntry,
      unitPriceRupiah,
      modifier,
      freePriceAudit,
      listedLinePriceRupiah,
      eligibleBaseRupiah: decomposed.menuBaseRupiah,
    };
  });

  const promotionLines = prepared.map((line) => ({
    id: line.lineId,
    productId: line.productId,
    categoryId: line.categoryId,
    eligibleBaseRupiah: line.eligibleBaseRupiah,
    quantity: line.quantity,
    unitPriceRupiah: Math.floor(line.eligibleBaseRupiah / line.quantity),
  }));
  const promotionResult = applyPromotionVersions({ promotions, lines: promotionLines, occurredAt, context });
  const discountByLine = new Map(promotionResult.lineDiscounts.map((line) => [line.id, line.amountRupiah]));
  const linePolicy = { ...pricingPolicyVersion, rounding: { mode: "NONE", stepRupiah: 1 } };
  const lines = prepared.map((line) => {
    const amounts = calculateTaxService({
      listedPriceRupiah: line.listedLinePriceRupiah,
      discountRupiah: discountByLine.get(line.lineId) ?? 0,
      policy: linePolicy,
    });
    const promotionAllocations = promotionResult.applied.flatMap((promotion) => promotion.allocations
      .filter((allocation) => allocation.id === line.lineId)
      .map((allocation) => ({ promotionId: promotion.promotionId, promotionVersion: promotion.promotionVersion, amountRupiah: allocation.amountRupiah })));
    return deepFreeze({
      lineId: line.lineId,
      productId: line.productId,
      categoryId: line.categoryId,
      variantId: line.variantId,
      productNameSnapshot: line.productNameSnapshot,
      quantity: line.quantity,
      priceBookEntrySnapshot: { ...line.priceEntry },
      baseUnitPriceRupiah: line.unitPriceRupiah,
      modifierSelectionsSnapshot: line.modifier.selections,
      modifierUnitDeltaRupiah: line.modifier.priceDeltaRupiah,
      promotionAllocations,
      freePriceAudit: line.freePriceAudit,
      amounts,
    });
  });

  const sum = (field) => lines.reduce((total, line) => total + line.amounts[field], 0);
  const unroundedTotalRupiah = sum("unroundedTotalRupiah");
  const totalRupiah = roundRupiah(unroundedTotalRupiah, pricingPolicyVersion.rounding);
  const snapshot = {
    kind: "SAGAPOS_ESB_CATALOG_PRICING_SNAPSHOT_V1",
    contractVersion: 1,
    quotedAt: new Date(Date.parse(occurredAt)).toISOString(),
    currency: priceBookVersion.currency,
    priceBook: { id: priceBookVersion.priceBookId, versionId: priceBookVersion.id, version: priceBookVersion.version, code: priceBookVersion.code },
    pricingPolicy: {
      id: pricingPolicyVersion.id,
      code: pricingPolicyVersion.code,
      version: pricingPolicyVersion.version,
      timezone: pricingPolicyVersion.timezone,
      taxRateBps: pricingPolicyVersion.taxRateBps,
      serviceRateBps: pricingPolicyVersion.serviceRateBps,
      priceIncludesTax: pricingPolicyVersion.priceIncludesTax,
      priceIncludesService: pricingPolicyVersion.priceIncludesService,
      serviceTaxable: pricingPolicyVersion.serviceTaxable,
      taxDiscountTiming: pricingPolicyVersion.taxDiscountTiming,
      rounding: pricingPolicyVersion.rounding,
    },
    context: {
      outletId: context.outletId ?? null,
      channel: String(context.channel ?? "POS").toUpperCase(),
      salesMode: context.salesMode == null ? null : String(context.salesMode).toUpperCase(),
      paymentMethod: context.paymentMethod == null ? null : String(context.paymentMethod).toUpperCase(),
    },
    lines,
    promotions: promotionResult,
    amounts: {
      menuGrossRupiah: sum("menuGrossRupiah"),
      discountRupiah: sum("discountRupiah"),
      netMenuRupiah: sum("netMenuRupiah"),
      serviceRupiah: sum("serviceRupiah"),
      taxRupiah: sum("taxRupiah"),
      unroundedTotalRupiah,
      roundingAdjustmentRupiah: totalRupiah - unroundedTotalRupiah,
      totalRupiah,
    },
  };
  const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return deepFreeze({ ...snapshot, snapshotHash });
}
