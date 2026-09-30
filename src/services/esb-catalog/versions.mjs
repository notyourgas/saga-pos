import { assertHalfOpenInterval, catalogPricingError, deepFreeze, requiredText } from "./errors.mjs";
import { assertRateBps, assertRupiah } from "./money.mjs";

const VERSION_STATUSES = new Set(["DRAFT", "PUBLISHED", "RETIRED"]);

function positiveVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw catalogPricingError("catalog_version_invalid");
  return value;
}

function assertTimezone(value) {
  const timezone = requiredText(value, "pricing_timezone_invalid", { max: 80 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw catalogPricingError("pricing_timezone_invalid");
  }
  return timezone;
}

function assertStatus(value) {
  const status = String(value ?? "DRAFT").toUpperCase();
  if (!VERSION_STATUSES.has(status)) throw catalogPricingError("catalog_version_status_invalid");
  return status;
}

function idrCurrency(value, code) {
  const currency = requiredText(value ?? "IDR", code, { max: 3 }).toUpperCase();
  if (currency !== "IDR") throw catalogPricingError(code);
  return currency;
}

export function createPricingPolicyVersion(input = {}) {
  const interval = assertHalfOpenInterval(input.validFrom, input.validTo, "pricing_policy_interval_invalid");
  const roundingMode = String(input.roundingMode ?? "NONE").toUpperCase();
  if (!new Set(["NONE", "UP", "DOWN", "NEAREST_HALF_UP"]).has(roundingMode)) {
    throw catalogPricingError("rounding_mode_invalid");
  }
  const taxDiscountTiming = String(input.taxDiscountTiming ?? "AFTER_DISCOUNT").toUpperCase();
  if (!new Set(["BEFORE_DISCOUNT", "AFTER_DISCOUNT"]).has(taxDiscountTiming)) {
    throw catalogPricingError("tax_discount_timing_invalid");
  }
  return deepFreeze({
    kind: "PRICING_POLICY_VERSION",
    id: requiredText(input.id, "pricing_policy_id_required"),
    code: requiredText(input.code, "pricing_policy_code_required", { max: 64 }).toUpperCase(),
    version: positiveVersion(input.version),
    status: assertStatus(input.status),
    currency: idrCurrency(input.currency, "pricing_currency_invalid"),
    timezone: assertTimezone(input.timezone ?? "Asia/Jakarta"),
    taxRateBps: assertRateBps(input.taxRateBps ?? 0, "tax_rate_invalid"),
    serviceRateBps: assertRateBps(input.serviceRateBps ?? 0, "service_rate_invalid"),
    priceIncludesTax: input.priceIncludesTax === true,
    priceIncludesService: input.priceIncludesService === true,
    serviceTaxable: input.serviceTaxable === true,
    taxDiscountTiming,
    rounding: deepFreeze({
      mode: roundingMode,
      stepRupiah: assertRupiah(input.roundingStepRupiah ?? 1, "rounding_step_invalid", { minimum: 1, maximum: 100_000 }),
    }),
    ...interval,
  });
}

function normalizePriceEntry(entry) {
  const priceRupiah = assertRupiah(entry?.priceRupiah, "price_book_entry_price_invalid");
  const freePriceEnabled = entry?.freePriceEnabled === true;
  const minimumRupiah = assertRupiah(entry?.minimumFreePriceRupiah ?? priceRupiah, "free_price_minimum_invalid");
  const maximumRupiah = assertRupiah(entry?.maximumFreePriceRupiah ?? priceRupiah, "free_price_maximum_invalid", { minimum: minimumRupiah });
  if (!freePriceEnabled && (minimumRupiah !== priceRupiah || maximumRupiah !== priceRupiah)) {
    throw catalogPricingError("free_price_bounds_without_enablement");
  }
  return deepFreeze({
    id: requiredText(entry?.id, "price_book_entry_id_required"),
    productId: requiredText(entry?.productId, "price_book_product_id_required"),
    variantId: entry?.variantId == null ? null : requiredText(entry.variantId, "price_book_variant_id_invalid"),
    priceRupiah,
    freePriceEnabled,
    minimumFreePriceRupiah: minimumRupiah,
    maximumFreePriceRupiah: maximumRupiah,
    posEnabled: entry?.posEnabled !== false,
    onlineEnabled: entry?.onlineEnabled === true,
  });
}

export function createPriceBookVersion(input = {}) {
  const interval = assertHalfOpenInterval(input.validFrom, input.validTo, "price_book_interval_invalid");
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw catalogPricingError("price_book_entries_required");
  const entries = input.entries.map(normalizePriceEntry);
  const keys = entries.map((entry) => `${entry.productId}:${entry.variantId ?? ""}`);
  if (new Set(keys).size !== keys.length || new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw catalogPricingError("price_book_entry_duplicate");
  }
  return deepFreeze({
    kind: "PRICE_BOOK_VERSION",
    id: requiredText(input.id, "price_book_version_id_required"),
    priceBookId: requiredText(input.priceBookId, "price_book_id_required"),
    code: requiredText(input.code, "price_book_code_required", { max: 64 }).toUpperCase(),
    version: positiveVersion(input.version),
    status: assertStatus(input.status),
    currency: idrCurrency(input.currency, "price_book_currency_invalid"),
    pricingPolicyVersionId: requiredText(input.pricingPolicyVersionId, "pricing_policy_version_id_required"),
    entries,
    ...interval,
  });
}

export function assertEffectiveVersion(version, occurredAt, code = "catalog_version_not_effective") {
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time)) throw catalogPricingError("catalog_quote_time_invalid");
  if (version.status !== "PUBLISHED" || time < Date.parse(version.startsAt) || (version.endsAt && time >= Date.parse(version.endsAt))) {
    throw catalogPricingError(code, 409);
  }
  return version;
}

export function resolvePriceEntry(priceBookVersion, { productId, variantId = null, channel = "POS" }) {
  const entry = priceBookVersion.entries.find((candidate) => candidate.productId === productId && candidate.variantId === variantId);
  if (!entry) throw catalogPricingError("price_book_entry_not_found", 404);
  if ((channel === "POS" && !entry.posEnabled) || (channel === "ONLINE" && !entry.onlineEnabled)) {
    throw catalogPricingError("price_book_entry_channel_disabled", 409);
  }
  return entry;
}
