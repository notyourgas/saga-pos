import { assertHalfOpenInterval, catalogPricingError, deepFreeze, requiredText } from "./errors.mjs";
import { allocateLargestRemainder, assertRateBps, assertRupiah, RATE_DENOMINATOR } from "./money.mjs";

const TYPES = new Set(["PERCENT", "FIXED", "FIXED_PRICE", "BUNDLE", "BUY_X_GET_Y", "FREE_ITEM"]);
const STATUSES = new Set(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]);
const STACK_POLICIES = new Set(["EXCLUSIVE", "COMPATIBLE"]);
const DAY_BY_NAME = new Map([["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7]]);

function stringList(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw catalogPricingError(code);
  const normalized = value.map((entry) => requiredText(entry, code, { max: 80 }));
  if (new Set(normalized).size !== normalized.length) throw catalogPricingError(code);
  return normalized.sort();
}

function upperStringList(value, code) {
  const normalized = stringList(value, code).map((item) => item.toUpperCase());
  if (new Set(normalized).size !== normalized.length) throw catalogPricingError(code);
  return normalized.sort();
}

function localTime(value, code) {
  const normalized = String(value ?? "");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(normalized)) throw catalogPricingError(code);
  return normalized.length === 5 ? `${normalized}:00` : normalized;
}

function timezone(value) {
  const normalized = requiredText(value ?? "Asia/Jakarta", "promotion_timezone_invalid", { max: 80 });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw catalogPricingError("promotion_timezone_invalid");
  }
  return normalized;
}

function normalizeSchedule(schedule) {
  if (schedule == null) return null;
  const weekdays = schedule.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
  if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw catalogPricingError("promotion_weekdays_invalid");
  }
  const startLocal = schedule.allDay === true ? "00:00:00" : localTime(schedule.startLocal, "promotion_start_local_invalid");
  const endLocal = schedule.allDay === true ? "00:00:00" : localTime(schedule.endLocal, "promotion_end_local_invalid");
  if (schedule.allDay !== true && startLocal === endLocal) throw catalogPricingError("promotion_schedule_ambiguous");
  return deepFreeze({
    timezone: timezone(schedule.timezone),
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    allDay: schedule.allDay === true,
    startLocal,
    endLocal,
  });
}

export function createPromotionVersion(input = {}) {
  const type = String(input.type ?? "").toUpperCase();
  const status = String(input.status ?? "DRAFT").toUpperCase();
  const stackPolicy = String(input.stackPolicy ?? "EXCLUSIVE").toUpperCase();
  const activationMode = String(input.activationMode ?? "CODE").toUpperCase();
  if (!["CODE", "AUTOMATIC", "VOUCHER"].includes(activationMode)) throw catalogPricingError("promotion_activation_mode_invalid");
  if (!TYPES.has(type)) throw catalogPricingError("promotion_type_invalid");
  if (!STATUSES.has(status)) throw catalogPricingError("promotion_status_invalid");
  if (!STACK_POLICIES.has(stackPolicy)) throw catalogPricingError("promotion_stack_policy_invalid");
  const interval = assertHalfOpenInterval(input.startsAt, input.endsAt, "promotion_interval_invalid");
  const value = type === "PERCENT"
    ? assertRateBps(input.value, "promotion_rate_invalid")
    : assertRupiah(input.value, "promotion_value_invalid");
  const version = Number(input.version);
  const priority = Number(input.priority ?? 100);
  if (!Number.isInteger(version) || version < 1) throw catalogPricingError("promotion_version_invalid");
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) throw catalogPricingError("promotion_priority_invalid");
  const buyQuantity = input.buyQuantity == null ? null : Number(input.buyQuantity);
  const getQuantity = input.getQuantity == null ? null : Number(input.getQuantity);
  const rewardQuantity = input.rewardQuantity == null ? 1 : Number(input.rewardQuantity);
  if (type === "BUY_X_GET_Y" && (!Number.isInteger(buyQuantity) || buyQuantity < 1 || buyQuantity > 100
    || !Number.isInteger(getQuantity) || getQuantity < 1 || getQuantity > 100)) throw catalogPricingError("promotion_quantity_rule_invalid");
  if (type === "FREE_ITEM" && (!Number.isInteger(rewardQuantity) || rewardQuantity < 1 || rewardQuantity > 100)) throw catalogPricingError("promotion_reward_quantity_invalid");
  if (type === "FREE_ITEM" && input.rewardProductId == null) throw catalogPricingError("promotion_reward_product_invalid");
  return deepFreeze({
    kind: "PROMOTION_VERSION",
    id: requiredText(input.id, "promotion_id_required"),
    code: requiredText(input.code, "promotion_code_required", { max: 64 }).toUpperCase(),
    name: requiredText(input.name ?? input.code, "promotion_name_required", { max: 120 }),
    version,
    status,
    activationMode,
    type,
    value,
    priority,
    stackPolicy,
    stackGroup: input.stackGroup == null ? null : requiredText(input.stackGroup, "promotion_stack_group_invalid", { max: 64 }),
    minimumSpendRupiah: assertRupiah(input.minimumSpendRupiah ?? 0, "promotion_minimum_invalid"),
    capRupiah: input.capRupiah == null ? null : assertRupiah(input.capRupiah, "promotion_cap_invalid"),
    outletIds: stringList(input.outletIds, "promotion_outlet_scope_invalid"),
    paymentMethods: upperStringList(input.paymentMethods, "promotion_payment_scope_invalid"),
    salesModes: upperStringList(input.salesModes, "promotion_sales_mode_scope_invalid"),
    eligibleProductIds: stringList(input.eligibleProductIds, "promotion_product_scope_invalid"),
    excludedProductIds: stringList(input.excludedProductIds, "promotion_product_scope_invalid"),
    eligibleCategoryIds: stringList(input.eligibleCategoryIds, "promotion_category_scope_invalid"),
    excludedCategoryIds: stringList(input.excludedCategoryIds, "promotion_category_scope_invalid"),
    buyQuantity,
    getQuantity,
    rewardProductId: input.rewardProductId == null ? null : requiredText(input.rewardProductId, "promotion_reward_product_invalid", { max: 80 }),
    rewardQuantity,
    quotaLimit: activationMode === "VOUCHER" ? 1 : input.quotaLimit == null ? null : positiveInteger(input.quotaLimit, "promotion_quota_invalid"),
    campaignId: input.campaignId == null ? null : requiredText(input.campaignId, "promotion_campaign_invalid", {max:80}),
    perMemberLimit: input.perMemberLimit == null ? null : positiveInteger(input.perMemberLimit, "promotion_member_limit_invalid"),
    perOrderLimit: input.perOrderLimit == null ? null : positiveInteger(input.perOrderLimit, "promotion_per_order_limit_invalid"),
    schedule: normalizeSchedule(input.schedule),
    ...interval,
  });
}

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 1_000_000_000) throw catalogPricingError(code);
  return normalized;
}

function localClock(occurredAt, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(occurredAt)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { weekday: DAY_BY_NAME.get(parts.weekday), time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function scheduleMatches(schedule, occurredAt) {
  if (!schedule) return true;
  const local = localClock(occurredAt, schedule.timezone);
  if (schedule.allDay) return schedule.weekdays.includes(local.weekday);
  if (schedule.startLocal < schedule.endLocal) {
    return schedule.weekdays.includes(local.weekday) && local.time >= schedule.startLocal && local.time < schedule.endLocal;
  }
  if (local.time >= schedule.startLocal) return schedule.weekdays.includes(local.weekday);
  if (local.time < schedule.endLocal) return schedule.weekdays.includes(local.weekday === 1 ? 7 : local.weekday - 1);
  return false;
}

export function promotionEffectiveState(promotion, occurredAt) {
  const instant = Date.parse(occurredAt);
  if (!Number.isFinite(instant)) throw catalogPricingError("promotion_quote_time_invalid");
  if (promotion.status !== "ACTIVE") return promotion.status;
  if (instant < Date.parse(promotion.startsAt)) return "SCHEDULED";
  if (promotion.endsAt && instant >= Date.parse(promotion.endsAt)) return "EXPIRED";
  if (!scheduleMatches(promotion.schedule, instant)) return "OUTSIDE_SCHEDULE";
  return "EFFECTIVE";
}

function inScope(promotion, context) {
  if (promotion.outletIds.length && !promotion.outletIds.includes(String(context.outletId ?? ""))) return false;
  if (promotion.paymentMethods.length && !promotion.paymentMethods.includes(String(context.paymentMethod ?? "").toUpperCase())) return false;
  if (promotion.salesModes.length && !promotion.salesModes.includes(String(context.salesMode ?? "").toUpperCase())) return false;
  return true;
}

function lineEligible(promotion, line) {
  if (promotion.excludedProductIds.includes(line.productId) || promotion.excludedCategoryIds.includes(line.categoryId)) return false;
  if (promotion.type === "FREE_ITEM" && promotion.rewardProductId && line.productId !== promotion.rewardProductId) return false;
  const productEligible = !promotion.eligibleProductIds.length || promotion.eligibleProductIds.includes(line.productId);
  const categoryEligible = !promotion.eligibleCategoryIds.length || promotion.eligibleCategoryIds.includes(line.categoryId);
  return productEligible && categoryEligible;
}

function promotionDiscount(promotion, eligibleBaseRupiah, eligible) {
  if (promotion.type === "PERCENT") {
    return Number(BigInt(eligibleBaseRupiah) * BigInt(promotion.value) / BigInt(RATE_DENOMINATOR));
  }
  if (promotion.type === "FIXED") return promotion.value;
  if (promotion.type === "FIXED_PRICE" || promotion.type === "BUNDLE") return Math.max(0, eligibleBaseRupiah - promotion.value);
  if (promotion.type === "BUY_X_GET_Y") {
    return eligible.reduce((sum, line) => {
      const quantity = Number(line.quantity ?? 1);
      const unitPriceRupiah = Number(line.unitPriceRupiah ?? Math.floor(line.eligibleBaseRupiah / quantity));
      const setSize = promotion.buyQuantity + promotion.getQuantity;
      const freeQuantity = Math.floor(quantity / setSize) * promotion.getQuantity;
      return sum + Math.min(line.eligibleBaseRupiah, freeQuantity * unitPriceRupiah);
    }, 0);
  }
  if (promotion.type === "FREE_ITEM") {
    return eligible.reduce((sum, line) => {
      const quantity = Number(line.quantity ?? 1);
      const unitPriceRupiah = Number(line.unitPriceRupiah ?? Math.floor(line.eligibleBaseRupiah / quantity));
      return sum + Math.min(line.eligibleBaseRupiah, Math.min(quantity, promotion.rewardQuantity) * unitPriceRupiah);
    }, 0);
  }
  throw catalogPricingError("promotion_type_invalid");
}

export function applyPromotionVersions({ promotions = [], lines = [], occurredAt, context = {} } = {}) {
  if (!Array.isArray(promotions) || !Array.isArray(lines) || lines.length === 0) throw catalogPricingError("promotion_quote_input_invalid");
  const remaining = new Map();
  for (const line of lines) {
    const id = requiredText(line?.id, "promotion_line_id_required");
    if (remaining.has(id)) throw catalogPricingError("promotion_line_duplicate");
    remaining.set(id, assertRupiah(line.eligibleBaseRupiah, "promotion_line_base_invalid"));
  }
  const ordered = [...promotions].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const applied = [];
  const skipped = [];
  const usedGroups = new Set();
  let exclusiveApplied = false;
  for (const promotion of ordered) {
    const effectiveState = promotionEffectiveState(promotion, occurredAt);
    if (effectiveState !== "EFFECTIVE") {
      skipped.push({ promotionId: promotion.id, reason: effectiveState });
      continue;
    }
    if (!inScope(promotion, context)) {
      skipped.push({ promotionId: promotion.id, reason: "OUTSIDE_SCOPE" });
      continue;
    }
    if (exclusiveApplied || (promotion.stackPolicy === "EXCLUSIVE" && applied.length > 0) || (promotion.stackGroup && usedGroups.has(promotion.stackGroup))) {
      skipped.push({ promotionId: promotion.id, reason: "STACKING_DENIED" });
      continue;
    }
    const eligible = lines.filter((line) => lineEligible(promotion, line) && (remaining.get(line.id) ?? 0) > 0);
    const eligibleBaseRupiah = assertRupiah(eligible.reduce((sum, line) => sum + remaining.get(line.id), 0), "promotion_eligible_base_overflow");
    if (eligibleBaseRupiah < promotion.minimumSpendRupiah || eligibleBaseRupiah === 0) {
      skipped.push({ promotionId: promotion.id, reason: "NOT_ELIGIBLE" });
      continue;
    }
    let discountRupiah = Math.min(eligibleBaseRupiah, promotionDiscount(promotion, eligibleBaseRupiah, eligible));
    if (promotion.capRupiah != null) discountRupiah = Math.min(discountRupiah, promotion.capRupiah);
    if (discountRupiah <= 0) {
      skipped.push({ promotionId: promotion.id, reason: "ZERO_DISCOUNT" });
      continue;
    }
    const allocations = allocateLargestRemainder(discountRupiah, eligible.map((line) => ({ id: line.id, weight: remaining.get(line.id) })));
    for (const allocation of allocations) remaining.set(allocation.id, remaining.get(allocation.id) - allocation.amountRupiah);
    applied.push(deepFreeze({
      promotionId: promotion.id,
      promotionCode: promotion.code,
      promotionVersion: promotion.version,
      type: promotion.type,
      stackPolicy: promotion.stackPolicy,
      stackGroup: promotion.stackGroup,
      eligibleBaseRupiah,
      discountRupiah,
      allocations,
    }));
    if (promotion.stackGroup) usedGroups.add(promotion.stackGroup);
    if (promotion.stackPolicy === "EXCLUSIVE") exclusiveApplied = true;
  }
  const lineDiscounts = lines.map((line) => deepFreeze({ id: line.id, amountRupiah: line.eligibleBaseRupiah - remaining.get(line.id) }));
  return deepFreeze({
    applied,
    skipped,
    lineDiscounts,
    totalDiscountRupiah: lineDiscounts.reduce((sum, line) => sum + line.amountRupiah, 0),
  });
}
