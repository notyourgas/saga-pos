import { catalogPricingError } from "./errors.mjs";

export const MAX_RUPIAH = Number.MAX_SAFE_INTEGER;
export const RATE_DENOMINATOR = 10_000;

export function assertRupiah(value, code = "rupiah_integer_required", { minimum = 0, maximum = MAX_RUPIAH } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw catalogPricingError(code);
  }
  return value;
}

export function assertRateBps(value, code = "rate_bps_invalid") {
  if (!Number.isInteger(value) || value < 0 || value > RATE_DENOMINATOR) {
    throw catalogPricingError(code);
  }
  return value;
}

function safeNumber(value, code = "money_overflow") {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw catalogPricingError(code);
  return number;
}

function roundRatio(numerator, denominator) {
  if (denominator <= 0n || numerator < 0n) throw catalogPricingError("money_ratio_invalid");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function multiplyRate(amountRupiah, rateBps) {
  assertRupiah(amountRupiah);
  assertRateBps(rateBps);
  return safeNumber(roundRatio(BigInt(amountRupiah) * BigInt(rateBps), BigInt(RATE_DENOMINATOR)));
}

export function allocateLargestRemainder(totalRupiah, weightedLines) {
  assertRupiah(totalRupiah, "allocation_total_invalid");
  if (!Array.isArray(weightedLines) || weightedLines.length === 0) {
    if (totalRupiah === 0) return Object.freeze([]);
    throw catalogPricingError("allocation_lines_required");
  }
  const seen = new Set();
  const normalized = weightedLines.map((line) => {
    const id = String(line?.id ?? "").trim();
    if (!id || seen.has(id)) throw catalogPricingError("allocation_line_id_invalid");
    seen.add(id);
    let weight;
    try {
      if (typeof line.weight === "number" && (!Number.isSafeInteger(line.weight) || line.weight < 0)) throw new TypeError();
      weight = typeof line.weight === "bigint" ? line.weight : BigInt(line.weight);
    } catch {
      throw catalogPricingError("allocation_weight_invalid");
    }
    if (weight < 0n) throw catalogPricingError("allocation_weight_invalid");
    return { id, weight };
  });
  const totalWeight = normalized.reduce((sum, line) => sum + line.weight, 0n);
  if (totalWeight === 0n) {
    if (totalRupiah === 0) return Object.freeze(normalized.map(({ id }) => Object.freeze({ id, amountRupiah: 0 })));
    throw catalogPricingError("allocation_positive_weight_required");
  }
  const total = BigInt(totalRupiah);
  const result = normalized.map((line) => {
    const numerator = total * line.weight;
    return { id: line.id, amountRupiah: safeNumber(numerator / totalWeight), remainder: numerator % totalWeight };
  });
  let remaining = totalRupiah - result.reduce((sum, line) => sum + line.amountRupiah, 0);
  const order = [...result].sort((left, right) => {
    if (left.remainder === right.remainder) return left.id.localeCompare(right.id);
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0; index < remaining; index += 1) order[index].amountRupiah += 1;
  const amountById = new Map(result.map((line) => [line.id, line.amountRupiah]));
  return Object.freeze(normalized.map(({ id }) => Object.freeze({ id, amountRupiah: amountById.get(id) })));
}

export function roundRupiah(amountRupiah, { mode = "NONE", stepRupiah = 1 } = {}) {
  assertRupiah(amountRupiah, "rounding_amount_invalid");
  assertRupiah(stepRupiah, "rounding_step_invalid", { minimum: 1, maximum: 100_000 });
  if (mode === "NONE" || stepRupiah === 1) return amountRupiah;
  const amount = BigInt(amountRupiah);
  const step = BigInt(stepRupiah);
  if (mode === "DOWN") return safeNumber((amount / step) * step);
  if (mode === "UP") return safeNumber(((amount + step - 1n) / step) * step);
  if (mode === "NEAREST_HALF_UP") return safeNumber(((amount * 2n + step) / (step * 2n)) * step);
  throw catalogPricingError("rounding_mode_invalid");
}

function includedWeights(policy) {
  const denominator = BigInt(RATE_DENOMINATOR);
  const tax = BigInt(policy.taxRateBps);
  const service = BigInt(policy.serviceRateBps);
  const weights = [{ id: "base", weight: denominator * denominator }];
  if (policy.priceIncludesService) weights.push({ id: "service", weight: service * denominator });
  if (policy.priceIncludesTax) {
    const taxableService = policy.priceIncludesService && policy.serviceTaxable ? service : 0n;
    weights.push({ id: "tax", weight: tax * (denominator + taxableService) });
  }
  if (!policy.priceIncludesService && !policy.priceIncludesTax) return [{ id: "base", weight: 1n }];
  return weights;
}

export function decomposeCatalogPrice(listedPriceRupiah, policy) {
  assertRupiah(listedPriceRupiah, "listed_price_invalid");
  const included = allocateLargestRemainder(listedPriceRupiah, includedWeights(policy));
  const byId = new Map(included.map((line) => [line.id, line.amountRupiah]));
  const menuBaseRupiah = byId.get("base") ?? listedPriceRupiah;
  let serviceRupiah = byId.get("service") ?? multiplyRate(menuBaseRupiah, policy.serviceRateBps);
  let taxRupiah = byId.get("tax") ?? multiplyRate(menuBaseRupiah + (policy.serviceTaxable ? serviceRupiah : 0), policy.taxRateBps);
  if (policy.priceIncludesTax && !policy.priceIncludesService && policy.serviceTaxable) {
    taxRupiah += multiplyRate(serviceRupiah, policy.taxRateBps);
  }
  const totalRupiah = assertRupiah(menuBaseRupiah + serviceRupiah + taxRupiah, "pricing_total_overflow");
  return Object.freeze({
    listedPriceRupiah,
    menuBaseRupiah,
    serviceRupiah,
    taxRupiah,
    includedTotalRupiah: included.reduce((sum, part) => sum + part.amountRupiah, 0),
    totalRupiah,
  });
}

export function calculateTaxService({ listedPriceRupiah, discountRupiah = 0, policy }) {
  const original = decomposeCatalogPrice(listedPriceRupiah, policy);
  assertRupiah(discountRupiah, "discount_invalid", { maximum: original.menuBaseRupiah });
  if (discountRupiah === 0) {
    const roundedTotalRupiah = roundRupiah(original.totalRupiah, policy.rounding);
    return Object.freeze({
      menuGrossRupiah: original.menuBaseRupiah,
      discountRupiah: 0,
      netMenuRupiah: original.menuBaseRupiah,
      serviceRupiah: original.serviceRupiah,
      taxRupiah: original.taxRupiah,
      unroundedTotalRupiah: original.totalRupiah,
      roundingAdjustmentRupiah: roundedTotalRupiah - original.totalRupiah,
      totalRupiah: roundedTotalRupiah,
    });
  }
  const netMenuRupiah = original.menuBaseRupiah - discountRupiah;
  const serviceRupiah = multiplyRate(netMenuRupiah, policy.serviceRateBps);
  const taxMenuBasis = policy.taxDiscountTiming === "BEFORE_DISCOUNT" ? original.menuBaseRupiah : netMenuRupiah;
  const taxBasisRupiah = assertRupiah(taxMenuBasis + (policy.serviceTaxable ? serviceRupiah : 0), "pricing_tax_basis_overflow");
  const taxRupiah = multiplyRate(taxBasisRupiah, policy.taxRateBps);
  const unroundedTotalRupiah = assertRupiah(netMenuRupiah + serviceRupiah + taxRupiah, "pricing_total_overflow");
  const totalRupiah = roundRupiah(unroundedTotalRupiah, policy.rounding);
  return Object.freeze({
    menuGrossRupiah: original.menuBaseRupiah,
    discountRupiah,
    netMenuRupiah,
    serviceRupiah,
    taxRupiah,
    unroundedTotalRupiah,
    roundingAdjustmentRupiah: totalRupiah - unroundedTotalRupiah,
    totalRupiah,
  });
}
