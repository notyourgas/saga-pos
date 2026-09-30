import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { SAGA_POS_MENU, SAGA_POS_PRODUCTS } from "./catalog.mjs";
import { applyPromotionVersions, calculateTaxService, createPromotionVersion, promotionEffectiveState, allocateLargestRemainder } from "../services/esb-catalog/index.mjs";

// JSON requests cannot supply this server-only authority.
export const CASHIER_DISCOUNT_AUTHORITY = Symbol("cashier-discount-authority");

export const APPROVED_PILOT_POLICY = Object.freeze({
  status: "OWNER_APPROVED_PILOT_POLICY_LOCAL_ONLY",
  currency: "IDR",
  gatewayProvider: "sagadev_gateway",
  gatewayProductCode: "sagaops",
  priceDisplay: "CUSTOMER_FINAL_PRICE",
  taxMode: "PBJT_CONFIGURABLE_DISABLED_PENDING_LOCAL_CONFIRMATION",
  roundingUnitRupiah: 100,
  taxPercent: 0,
  servicePercent: 0,
  orderTypes: ["DINE_IN", "TAKEAWAY"],
  operatingHours: { opensAt: "07:00", lastOrderAt: "21:30", closesAt: "22:00" },
  variants: [
    { id: "temperature", label: "Suhu", required: false, min: 0, max: 1, options: [
      { id: "hot", label: "Panas", priceDeltaRupiah: 0 },
      { id: "iced", label: "Es", priceDeltaRupiah: 0 },
    ] },
  ],
  modifiers: [
    { id: "sweetness", label: "Tingkat manis", required: false, min: 0, max: 1, options: [
      { id: "normal", label: "Normal", priceDeltaRupiah: 0 },
      { id: "less", label: "Sedikit gula", priceDeltaRupiah: 0 },
      { id: "none", label: "Tanpa gula", priceDeltaRupiah: 0 },
    ] },
    { id: "addons", label: "Tambahan", required: false, min: 0, max: 2, options: [
      { id: "extra-shot", label: "Extra Shot", priceDeltaRupiah: 5_000, productIds: ["americano", "cafe-latte", "cappucino", "moccacino", "es-kopi-saga", "saga-premiyum", "magnosiyum"] },
      { id: "oat-milk", label: "Oat Milk", priceDeltaRupiah: 7_000, productIds: ["cafe-latte", "cappucino", "moccacino", "matcha", "chocolate", "red-velvet"] },
    ] },
  ],
  memberFixture: {
    code: "SG-VOYAGER-001",
    codeMasked: "SG-VOYAGER-•••001",
    memberId: "member-local-voyager-001",
    displayName: "Demo Owner",
    tier: "VOYAGER",
    discountPercent: 10,
    discountCapRupiah: 15_000,
    recommendations: [
      { productId: "es-kopi-saga", reason: "Sering kamu pesan" },
      { productId: "americano", reason: "Pilihan favoritmu" },
      { productId: "creamcheese-bagel", reason: "Cocok jadi teman ngopi" },
    ],
  },
  rewardFixture: {
    id: "FREE-AMERICANO",
    name: "Gratis Americano",
    maximumDiscountRupiah: 13_000,
  },
  promotionFixture: {
    code: "SAGA10",
    name: "Promo lokal 10%",
    discountPercent: 10,
    discountCapRupiah: 10_000,
    stackableWithMember: false,
  },
});

// Compatibility alias for existing local runtime imports. The policy itself is
// owner-approved; external PBJT, gateway and hardware gates remain separate.
export const PROVISIONAL_PILOT_POLICY = APPROVED_PILOT_POLICY;

const DEFAULT_PRICING_SETTINGS = Object.freeze({
  taxEnabled: false,
  taxRateBps: 0,
  serviceEnabled: false,
  serviceRateBps: 0,
  serviceTaxable: false,
  taxDiscountTiming: "AFTER_DISCOUNT",
  roundingMode: "NONE",
  roundingStepRupiah: 1,
});

export class PilotCatalogPricing {
  constructor({ clock = () => new Date(), privatePromotionAuthorizer = null, authoredPromotionEngineEnabled = false } = {}) {
    this.clock = clock;
    this.privatePromotionAuthorizer = privatePromotionAuthorizer;
    this.authoredPromotionEngineEnabled = authoredPromotionEngineEnabled === true;
    this.quoteSigningKey = randomBytes(32);
    this.version = 1;
    this.availability = new Map(SAGA_POS_PRODUCTS.map((product) => [product.id, true]));
    this.availabilityRestoresAt = new Map();
    this.audit = [];
    this.productOverrides = new Map();
    this.productAudit = [];
    this.customCategories = new Map();
    this.customProducts = new Map();
    this.productMedia = new Map();
    this.publishHistory = [];
    this.pricingSettings = structuredClone(DEFAULT_PRICING_SETTINGS);
    this.pricingAudit = [];
    this.promotionRules = [];
    this.promotionAudit = [];
    this.manualDiscountStaffLimitRupiah = 0;
    this.variantGroups = structuredClone(PROVISIONAL_PILOT_POLICY.variants).map((group) => ({
      ...group,
      active: true,
      options: group.options.map((option) => ({ ...option, active: true })),
    }));
    this.variantAudit = [];
    this.modifierGroups = structuredClone(PROVISIONAL_PILOT_POLICY.modifiers).map((group) => ({
      ...group,
      active: true,
      options: group.options.map((option) => ({ ...option, active: true })),
    }));
    this.modifierAudit = [];
    this.orderingSettings = { paused: false, enforceHours: false, ...PROVISIONAL_PILOT_POLICY.operatingHours };
    this.orderingAudit = [];
    this.publishedSnapshot = null;
    this.workspaceBaseVersion = this.version;
    this.stagedAvailability = new Map();
    this.archiveMetadata = new Map();
    this.publications = [];
    this.workspaceActive = false;
  }

  exportState() {
    return structuredClone({ version: this.version, availability: [...this.availability], restoresAt: [...this.availabilityRestoresAt], audit: this.audit, productOverrides: [...this.productOverrides], productAudit: this.productAudit, customCategories: [...this.customCategories.values()], customProducts: [...this.customProducts.values()], productMedia: [...this.productMedia], publishHistory: this.publishHistory, pricingSettings: this.pricingSettings, pricingAudit: this.pricingAudit, promotionRules: this.promotionRules, promotionAudit: this.promotionAudit, manualDiscountStaffLimitRupiah: this.manualDiscountStaffLimitRupiah, variantGroups: this.variantGroups, variantAudit: this.variantAudit, modifierGroups: this.modifierGroups, modifierAudit: this.modifierAudit, orderingSettings: this.orderingSettings, orderingAudit: this.orderingAudit, publishedSnapshot: this.publishedSnapshot, workspaceBaseVersion: this.workspaceBaseVersion, stagedAvailability: [...this.stagedAvailability], archiveMetadata: [...this.archiveMetadata], publications: this.publications });
  }

  restoreState(state) {
    this.version = state.version;
    this.availability = new Map(state.availability);
    this.availabilityRestoresAt = new Map(state.restoresAt);
    this.audit = structuredClone(state.audit);
    this.productOverrides = new Map(state.productOverrides ?? []);
    this.productAudit = structuredClone(state.productAudit ?? []);
    this.customCategories = new Map((state.customCategories ?? []).map((item) => [item.id, structuredClone(item)]));
    this.customProducts = new Map((state.customProducts ?? []).map((item) => [item.id, structuredClone(item)]));
    this.productMedia = new Map(state.productMedia ?? []);
    this.publishHistory = structuredClone(state.publishHistory ?? []);
    this.pricingSettings = normalizePricingSettings(state.pricingSettings ?? DEFAULT_PRICING_SETTINGS);
    this.pricingAudit = structuredClone(state.pricingAudit ?? []);
    this.promotionRules = structuredClone(state.promotionRules ?? []);
    this.promotionAudit = structuredClone(state.promotionAudit ?? []);
    this.manualDiscountStaffLimitRupiah = state.manualDiscountStaffLimitRupiah ?? 0;
    this.variantGroups = structuredClone(state.variantGroups ?? PROVISIONAL_PILOT_POLICY.variants).map((group) => ({
      ...group,
      active: group.active !== false,
      options: group.options.map((option) => ({ ...option, active: option.active !== false })),
    }));
    this.variantAudit = structuredClone(state.variantAudit ?? []);
    this.modifierGroups = structuredClone(state.modifierGroups ?? PROVISIONAL_PILOT_POLICY.modifiers).map((group) => ({
      ...group,
      active: group.active !== false,
      options: group.options.map((option) => ({ ...option, active: option.active !== false })),
    }));
    this.modifierAudit = structuredClone(state.modifierAudit ?? []);
    this.orderingSettings = structuredClone(state.orderingSettings ?? { paused: false, enforceHours: false, ...PROVISIONAL_PILOT_POLICY.operatingHours });
    this.orderingAudit = structuredClone(state.orderingAudit ?? []);
    this.publishedSnapshot = structuredClone(state.publishedSnapshot ?? null);
    this.workspaceBaseVersion = Number.isInteger(state.workspaceBaseVersion) ? state.workspaceBaseVersion : this.version;
    this.stagedAvailability = new Map(state.stagedAvailability ?? []);
    this.archiveMetadata = new Map(state.archiveMetadata ?? []);
    this.publications = structuredClone(state.publications ?? []);
    this.workspaceActive = this.version > this.workspaceBaseVersion;
  }

  updateOrdering({ paused, enforceHours, opensAt, lastOrderAt, closesAt, expectedVersion, actorId, reason }) {
    if (typeof paused !== "boolean" || typeof enforceHours !== "boolean") throw domainError("ordering_settings_invalid", 422);
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (![opensAt, lastOrderAt, closesAt].every((value) => typeof value === "string" && timePattern.test(value)) || !(opensAt < lastOrderAt && lastOrderAt <= closesAt)) throw domainError("ordering_hours_invalid", 422);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 160) throw domainError("catalog_reason_required", 422);
    if (!Number.isInteger(expectedVersion)) throw domainError("catalog_version_required", 422);
    this.#restoreExpiredAvailability();
    if (expectedVersion !== this.version) throw domainError("catalog_version_conflict", 409);
    const previous = structuredClone(this.orderingSettings);
    const next = { paused, enforceHours, opensAt, lastOrderAt, closesAt };
    if (JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    this.orderingSettings = next;
    const event = { type: "catalog.ordering.updated", previous, next, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.orderingAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  modifierConfiguration({ auditLimit = 20 } = {}) {
    return structuredClone({
      groups: this.modifierGroups,
      audit: this.modifierAudit.slice(-Math.max(1, Math.min(100, Number(auditLimit) || 20))).reverse(),
    });
  }

  pricingConfiguration({ auditLimit = 20 } = {}) {
    return structuredClone({
      settings: this.pricingSettings,
      audit: this.pricingAudit.slice(-Math.max(1, Math.min(100, Number(auditLimit) || 20))).reverse(),
    });
  }

  promotionConfiguration({ auditLimit = 20 } = {}) {
    const occurredAt = this.clock().toISOString();
    return structuredClone({
      rules: this.promotionRules.map((rule) => ({ ...rule, effectiveState: promotionEffectiveState(rule, occurredAt) })),
      audit: this.promotionAudit.slice(-Math.max(1, Math.min(100, Number(auditLimit) || 20))).reverse(),
      serverTime: occurredAt,
      timezone: "Asia/Jakarta",
      manualDiscountStaffLimitRupiah: this.manualDiscountStaffLimitRupiah,
      supportedTypes: ["PERCENT", "FIXED", "FIXED_PRICE", "BUNDLE", "BUY_X_GET_Y", "FREE_ITEM"],
    });
  }

  publicPresentationConfiguration() {
    const occurredAt = this.clock().toISOString();
    const source = this.publishedSnapshot;
    const promotionRules = source?.promotionRules ?? this.promotionRules;
    return structuredClone({
      promotionRules: promotionRules.map((rule) => ({ ...rule, effectiveState: promotionEffectiveState(rule, occurredAt) })),
      orderingSettings: source?.orderingSettings ?? this.orderingSettings,
      publishedRevision: source?.revision ?? this.publications.at(-1)?.revision ?? 0,
      checkedAt: occurredAt,
    });
  }

  upsertPromotion({ promotionId, code, name, type, value, activationMode = "CODE", priority = 100, stackPolicy = "EXCLUSIVE", stackGroup = null, minimumSpendRupiah = 0, capRupiah = null, eligibleProductIds = [], excludedProductIds = [], eligibleCategoryIds = [], excludedCategoryIds = [], paymentMethods = [], salesModes = [], startsAt, endsAt = null, schedule = null, buyQuantity = null, getQuantity = null, rewardProductId = null, rewardQuantity = 1, quotaLimit = null, perOrderLimit = null, campaignId = null, perMemberLimit, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedCode = cleanCatalogText(code, "promotion_code_invalid", 64).toUpperCase();
    const existingIndex = promotionId ? this.promotionRules.findIndex((rule) => rule.id === promotionId) : -1;
    if (promotionId && existingIndex < 0) throw domainError("promotion_not_found", 404);
    if (this.promotionRules.some((rule, index) => index !== existingIndex && rule.code === normalizedCode)) throw domainError("promotion_code_duplicate", 409);
    const previous = existingIndex < 0 ? null : structuredClone(this.promotionRules[existingIndex]);
    const id = previous?.id ?? uniqueSlug(normalizedCode, new Set(this.promotionRules.map((rule) => rule.id)));
    const next = createPromotionVersion({
      id,
      code: normalizedCode,
      activationMode,
      name,
      version: (previous?.version ?? 0) + 1,
      status: "DRAFT",
      type,
      value,
      priority,
      stackPolicy,
      stackGroup,
      minimumSpendRupiah,
      capRupiah,
      outletIds: [],
      paymentMethods,
      salesModes,
      eligibleProductIds,
      excludedProductIds,
      eligibleCategoryIds,
      excludedCategoryIds,
      schedule,
      startsAt,
      endsAt,
      buyQuantity,
      getQuantity,
      rewardProductId,
      rewardQuantity,
      quotaLimit,
      perOrderLimit,
      campaignId: previous?.campaignId ?? campaignId,
      perMemberLimit: perMemberLimit === undefined ? previous?.perMemberLimit ?? null : perMemberLimit,
    });
    if (existingIndex < 0) this.promotionRules.push(next);
    else this.promotionRules[existingIndex] = next;
    return this.#recordPromotionEvent("catalog.promotion.draft.saved", { promotionId: id, previous, next, actorId, reason });
  }

  setPromotionStatus({ promotionId, status, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const index = this.promotionRules.findIndex((rule) => rule.id === promotionId);
    if (index < 0) throw domainError("promotion_not_found", 404);
    const normalizedStatus = String(status ?? "").toUpperCase();
    if (!new Set(["ACTIVE", "PAUSED", "ARCHIVED"]).has(normalizedStatus)) throw domainError("promotion_status_invalid", 422);
    const previous = structuredClone(this.promotionRules[index]);
    const next = createPromotionVersion({ ...previous, version: previous.version + 1, status: normalizedStatus });
    this.promotionRules[index] = next;
    return this.#recordPromotionEvent("catalog.promotion.status.changed", { promotionId, previous, next, actorId, reason });
  }

  issueVoucherBatch({count, prefix, promotion, expectedVersion, actorId, reason}) {
    this.#assertMutation(expectedVersion,reason);
    if(!Number.isSafeInteger(count) || count<1 || count>100 || !/^[A-Za-z0-9_-]{1,20}$/.test(prefix ?? '') || !promotion || typeof promotion !== 'object')throw domainError('voucher_batch_invalid',422);
    const before=this.exportState(),campaignId=randomUUID(),codes=[];
    try {
      for(let index=0;index<count;index++) {
        const code=`${prefix.toUpperCase()}-${randomBytes(16).toString('hex').toUpperCase()}`;
        const next=this.upsertPromotion({...promotion,promotionId:undefined,code,activationMode:'VOUCHER',campaignId,expectedVersion:this.version,actorId,reason});
        codes.push({code,promotionId:next.promotionId});
      }
      return {campaignId,codes,count,version:this.version,status:'DRAFT'};
    } catch(error){this.restoreState(before);throw error;}
  }

  setVoucherBatchStatus({campaignId,status,expectedVersion,actorId,reason}) {
    this.#assertMutation(expectedVersion,reason);
    const rules=this.promotionRules.filter(rule=>rule.campaignId===campaignId && rule.activationMode==='VOUCHER');
    if(!campaignId || !rules.length)throw domainError('promotion_not_found',404);
    const before=this.exportState();
    try {for(const rule of rules)this.setPromotionStatus({promotionId:rule.id,status,expectedVersion:this.version,actorId,reason});return {campaignId,count:rules.length,version:this.version,status};}
    catch(error){this.restoreState(before);throw error;}
  }

  #recordPromotionEvent(type, { actorId, reason, ...payload }) {
    const event = { type, ...payload, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.promotionAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  updatePricingPolicy({ taxEnabled, taxRateBps, serviceEnabled, serviceRateBps, serviceTaxable, taxDiscountTiming, roundingMode, roundingStepRupiah, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const next = normalizePricingSettings({ taxEnabled, taxRateBps, serviceEnabled, serviceRateBps, serviceTaxable, taxDiscountTiming, roundingMode, roundingStepRupiah });
    const previous = structuredClone(this.pricingSettings);
    if (JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    this.pricingSettings = next;
    const event = {
      type: "catalog.pricing.updated",
      previous,
      next: structuredClone(next),
      actorId,
      reason: reason.trim(),
      version: ++this.version,
      occurredAt: this.clock().toISOString(),
    };
    this.pricingAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  variantConfiguration({ auditLimit = 20 } = {}) {
    return structuredClone({
      groups: this.variantGroups,
      audit: this.variantAudit.slice(-Math.max(1, Math.min(100, Number(auditLimit) || 20))).reverse(),
    });
  }

  upsertVariantGroup({ groupId, label, required = false, min = 0, max = 1, active = true, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const cleanLabel = cleanCatalogText(label, "variant_group_label_invalid", 60);
    const existingIndex = groupId == null || groupId === "" ? -1 : this.variantGroups.findIndex((group) => group.id === groupId);
    if (groupId && existingIndex < 0) throw domainError("variant_group_not_found", 404);
    const usedGroupIds = new Set([...this.variantGroups, ...this.modifierGroups].map((group) => group.id));
    const id = existingIndex >= 0 ? this.variantGroups[existingIndex].id : uniqueSlug(cleanLabel, usedGroupIds);
    if (typeof required !== "boolean" || typeof active !== "boolean" || !Number.isInteger(min) || !Number.isInteger(max)
      || min < 0 || max < 1 || max > 8 || min > max || (required && min < 1)) throw domainError("variant_group_limits_invalid", 422);
    if (this.variantGroups.some((group, index) => index !== existingIndex && group.label.toLowerCase() === cleanLabel.toLowerCase())) throw domainError("variant_group_duplicate", 409);
    const previous = existingIndex >= 0 ? structuredClone(this.variantGroups[existingIndex]) : null;
    const next = { id, label: cleanLabel, required, min, max, active, options: previous?.options ?? [] };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    if (existingIndex >= 0) this.variantGroups[existingIndex] = next;
    else this.variantGroups.push(next);
    return this.#recordVariantEvent("catalog.variant.group.upserted", { groupId: id, previous, next, actorId, reason });
  }

  upsertVariantOption({ groupId, optionId, label, priceDeltaRupiah, active = true, productIds, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const groupIndex = this.variantGroups.findIndex((group) => group.id === groupId);
    if (groupIndex < 0) throw domainError("variant_group_not_found", 404);
    const group = this.variantGroups[groupIndex];
    const cleanLabel = cleanCatalogText(label, "variant_option_label_invalid", 60);
    const existingIndex = optionId == null || optionId === "" ? -1 : group.options.findIndex((option) => option.id === optionId);
    if (optionId && existingIndex < 0) throw domainError("variant_option_not_found", 404);
    if (!Number.isSafeInteger(priceDeltaRupiah) || priceDeltaRupiah < 0 || priceDeltaRupiah > 10_000_000 || typeof active !== "boolean") throw domainError("variant_option_price_invalid", 422);
    const normalizedProducts = productIds == null ? (existingIndex >= 0 ? group.options[existingIndex].productIds : undefined) : normalizeChoiceProducts(productIds, this.#allProducts(), "variant_product_scope_invalid");
    if (group.options.some((option, index) => index !== existingIndex && option.label.toLowerCase() === cleanLabel.toLowerCase())) throw domainError("variant_option_duplicate", 409);
    const id = existingIndex >= 0 ? group.options[existingIndex].id : uniqueSlug(cleanLabel, new Set(group.options.map((option) => option.id)));
    const previous = existingIndex >= 0 ? structuredClone(group.options[existingIndex]) : null;
    const next = { id, label: cleanLabel, priceDeltaRupiah, active, ...(normalizedProducts?.length ? { productIds: normalizedProducts } : {}) };
    const options = structuredClone(group.options);
    if (existingIndex >= 0) options[existingIndex] = next;
    else options.push(next);
    if (group.active && group.required && options.filter((option) => option.active !== false).length < group.min) throw domainError("variant_required_options_invalid", 409);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    this.variantGroups[groupIndex] = { ...group, options };
    return this.#recordVariantEvent("catalog.variant.option.upserted", { groupId, optionId: id, previous, next, actorId, reason });
  }

  #recordVariantEvent(type, { actorId, reason, ...payload }) {
    const event = { type, ...payload, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.variantAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  #variantGroupsForProduct(productId, customizationProfile, groups = this.variantGroups) {
    if (productConfiguration(productId, customizationProfile) === "none") return [];
    return groups
      .filter((group) => group.active !== false)
      .map((group) => ({
        ...group,
        options: group.options
          .filter((option) => option.active !== false && (!option.productIds || option.productIds.includes(productId)))
          .map(({ productIds: _productIds, active: _active, ...option }) => option),
      }))
      .filter((group) => group.options.length);
  }

  upsertModifierGroup({ groupId, label, required = false, min = 0, max = 1, active = true, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const cleanLabel = cleanCatalogText(label, "modifier_group_label_invalid", 60);
    const existingIndex = groupId == null || groupId === "" ? -1 : this.modifierGroups.findIndex((group) => group.id === groupId);
    if (groupId && existingIndex < 0) throw domainError("modifier_group_not_found", 404);
    const usedGroupIds = new Set([...this.variantGroups, ...this.modifierGroups].map((group) => group.id));
    const id = existingIndex >= 0 ? this.modifierGroups[existingIndex].id : uniqueSlug(cleanLabel, usedGroupIds);
    if (typeof required !== "boolean" || typeof active !== "boolean" || !Number.isInteger(min) || !Number.isInteger(max)
      || min < 0 || max < 1 || max > 8 || min > max || (required && min < 1)) throw domainError("modifier_group_limits_invalid", 422);
    if (this.modifierGroups.some((group, index) => index !== existingIndex && group.label.toLowerCase() === cleanLabel.toLowerCase())) throw domainError("modifier_group_duplicate", 409);
    const previous = existingIndex >= 0 ? structuredClone(this.modifierGroups[existingIndex]) : null;
    const next = { id, label: cleanLabel, required, min, max, active, options: previous?.options ?? [] };
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    if (existingIndex >= 0) this.modifierGroups[existingIndex] = next;
    else this.modifierGroups.push(next);
    return this.#recordModifierEvent("catalog.modifier.group.upserted", { groupId: id, previous, next, actorId, reason });
  }

  upsertModifierOption({ groupId, optionId, label, priceDeltaRupiah, active = true, productIds, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const groupIndex = this.modifierGroups.findIndex((group) => group.id === groupId);
    if (groupIndex < 0) throw domainError("modifier_group_not_found", 404);
    const group = this.modifierGroups[groupIndex];
    const cleanLabel = cleanCatalogText(label, "modifier_option_label_invalid", 60);
    const existingIndex = optionId == null || optionId === "" ? -1 : group.options.findIndex((option) => option.id === optionId);
    if (optionId && existingIndex < 0) throw domainError("modifier_option_not_found", 404);
    if (!Number.isSafeInteger(priceDeltaRupiah) || priceDeltaRupiah < 0 || priceDeltaRupiah > 10_000_000 || typeof active !== "boolean") throw domainError("modifier_option_price_invalid", 422);
    const normalizedProducts = productIds == null ? (existingIndex >= 0 ? group.options[existingIndex].productIds : undefined) : normalizeChoiceProducts(productIds, this.#allProducts());
    if (group.options.some((option, index) => index !== existingIndex && option.label.toLowerCase() === cleanLabel.toLowerCase())) throw domainError("modifier_option_duplicate", 409);
    const id = existingIndex >= 0 ? group.options[existingIndex].id : uniqueSlug(cleanLabel, new Set(group.options.map((option) => option.id)));
    const previous = existingIndex >= 0 ? structuredClone(group.options[existingIndex]) : null;
    const next = { id, label: cleanLabel, priceDeltaRupiah, active, ...(normalizedProducts?.length ? { productIds: normalizedProducts } : {}) };
    const options = structuredClone(group.options);
    if (existingIndex >= 0) options[existingIndex] = next;
    else options.push(next);
    if (group.active && group.required && options.filter((option) => option.active !== false).length < group.min) throw domainError("modifier_required_options_invalid", 409);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    this.modifierGroups[groupIndex] = { ...group, options };
    return this.#recordModifierEvent("catalog.modifier.option.upserted", { groupId, optionId: id, previous, next, actorId, reason });
  }

  #recordModifierEvent(type, { actorId, reason, ...payload }) {
    const event = { type, ...payload, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.modifierAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  #modifierGroupsForProduct(productId, customizationProfile, groups = this.modifierGroups) {
    if (productConfiguration(productId, customizationProfile) === "none") return [];
    return groups
      .filter((group) => group.active !== false)
      .map((group) => ({
        ...group,
        options: group.options
          .filter((option) => option.active !== false && (!option.productIds || option.productIds.includes(productId)))
          .map(({ productIds: _productIds, active: _active, ...option }) => option),
      }))
      .filter((group) => group.options.length);
  }

  updateProduct({ productId, name, priceRupiah, categoryId: selectedCategory, station, status, sortRank, catalogDetails, expectedVersion, actorId, reason }) {
    const product = this.#allProducts().find((item) => item.id === productId);
    if (!product) throw domainError("product_not_found", 404);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f<>]/.test(name)) throw domainError("product_name_invalid", 422);
    if (!Number.isSafeInteger(priceRupiah) || priceRupiah < 100 || priceRupiah > 10_000_000) throw domainError("product_price_invalid", 422);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 160) throw domainError("catalog_reason_required", 422);
    this.#restoreExpiredAvailability();
    if (!Number.isInteger(expectedVersion)) throw domainError("catalog_version_required", 422);
    if (expectedVersion !== this.version) throw domainError("catalog_version_conflict", 409);
    const previous = { name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId ?? categoryId(productId), station: product.station, status: product.status, sortRank: product.sortRank ?? 0, ...this.productOverrides.get(productId) };
    const next = { name: name.trim(), priceRupiah, categoryId: selectedCategory ?? previous.categoryId, station: station ?? previous.station, status: status ?? previous.status, sortRank: sortRank ?? previous.sortRank };
    const normalizedCatalogDetails = catalogDetails === undefined ? previous.catalogDetails : normalizeCatalogDetails(catalogDetails, new Set(this.#allProducts().map((item) => item.id)), productId);
    if (normalizedCatalogDetails) next.catalogDetails = normalizedCatalogDetails;
    if (!this.#allCategories().some((category) => category.id === next.categoryId)) throw domainError("catalog_category_invalid", 422);
    if (!["bar", "food"].includes(next.station)) throw domainError("catalog_station_invalid", 422);
    if (!["draft", "active", "archived"].includes(next.status)) throw domainError("catalog_status_invalid", 422);
    if (!Number.isInteger(next.sortRank) || next.sortRank < 0 || next.sortRank > 999) throw domainError("catalog_sort_invalid", 422);
    if (JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    if (this.customProducts.has(productId)) this.customProducts.set(productId, { ...product, ...next });
    else this.productOverrides.set(productId, next);
    const event = { type: "catalog.product.updated", productId, previous, next, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  reorderProducts({ categoryId: selectedCategory, orderedProductIds, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    this.beginWorkspace();
    const products = this.#allProducts().filter((product) => product.categoryId === selectedCategory);
    if (!products.length) throw domainError("catalog_category_not_found", 404);
    const orderedIds = Array.isArray(orderedProductIds) ? orderedProductIds : [];
    const expectedIds = new Set(products.map((product) => product.id));
    if (orderedIds.length !== expectedIds.size || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !expectedIds.has(id))) throw domainError("catalog_product_order_invalid", 422);
    const previous = products.map((product) => ({ productId: product.id, sortRank: product.sortRank ?? 0 }));
    const next = orderedIds.map((productId, index) => ({ productId, sortRank: index * 10 }));
    if (JSON.stringify(previous) === JSON.stringify(next)) return { unchanged: true, version: this.version };
    for (const item of next) {
      const product = products.find((candidate) => candidate.id === item.productId);
      if (this.customProducts.has(item.productId)) this.customProducts.set(item.productId, { ...product, sortRank: item.sortRank });
      else this.productOverrides.set(item.productId, { ...this.productOverrides.get(item.productId), name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId, station: product.station, status: product.status, sortRank: item.sortRank });
    }
    const event = { type: "catalog.product.order.updated", categoryId: selectedCategory, previous, next, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    return structuredClone(event);
  }

  createCategory({ name, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedName = cleanCatalogText(name, "catalog_category_name_invalid", 60);
    if (this.#allCategories().some((item) => item.name.toLowerCase() === normalizedName.toLowerCase())) throw domainError("catalog_category_duplicate", 409);
    const id = uniqueSlug(normalizedName, new Set(this.#allCategories().map((item) => item.id)));
    const category = { id, name: normalizedName, sortRank: this.#allCategories().length * 10, archived: false, custom: true, createdAt: this.clock().toISOString() };
    this.customCategories.set(id, category);
    const event = { type: "catalog.category.created", categoryId: id, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return { category: structuredClone(category), version: this.version };
  }

  updateCategory({ categoryId: selectedCategory, name, sortRank = 0, archived = false, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const current = this.#allCategories().find((item) => item.id === selectedCategory);
    if (!current) throw domainError("catalog_category_not_found", 404);
    const normalizedName = cleanCatalogText(name, "catalog_category_name_invalid", 60);
    if (this.#allCategories().some((item) => item.id !== selectedCategory && item.name.toLowerCase() === normalizedName.toLowerCase())) throw domainError("catalog_category_duplicate", 409);
    if (!Number.isInteger(sortRank) || sortRank < 0 || sortRank > 999 || typeof archived !== "boolean") throw domainError("catalog_category_state_invalid", 422);
    if (archived && this.#allProducts().some((product) => product.categoryId === selectedCategory && product.status !== "archived")) throw domainError("catalog_category_in_use", 409);
    const previous = structuredClone(current);
    const next = { ...current, name: normalizedName, sortRank, archived };
    this.customCategories.set(selectedCategory, next);
    const event = { type: archived ? "catalog.category.archived" : "catalog.category.updated", categoryId: selectedCategory, previous, next: structuredClone(next), actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return structuredClone(event);
  }

  createProduct({ name, priceRupiah, categoryId: selectedCategory, station = "bar", customizationProfile = "beverage", catalogDetails, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const normalizedName = cleanCatalogText(name, "product_name_invalid", 80);
    if (!Number.isSafeInteger(priceRupiah) || priceRupiah < 100 || priceRupiah > 10_000_000) throw domainError("product_price_invalid", 422);
    if (!this.#allCategories().some((item) => item.id === selectedCategory)) throw domainError("catalog_category_invalid", 422);
    if (!["bar", "food"].includes(station)) throw domainError("catalog_station_invalid", 422);
    if (!["beverage", "none"].includes(customizationProfile)) throw domainError("catalog_customization_invalid", 422);
    const id = uniqueSlug(normalizedName, new Set(this.#allProducts().map((item) => item.id)));
    const normalizedCatalogDetails = normalizeCatalogDetails(catalogDetails, new Set(this.#allProducts().map((item) => item.id)), id);
    const product = { id, name: normalizedName, priceRupiah, categoryId: selectedCategory, station, customizationProfile, inventoryMode: "untracked", status: "draft", sortRank: this.customProducts.size + 100, custom: true, createdAt: this.clock().toISOString(), ...(normalizedCatalogDetails ? { catalogDetails: normalizedCatalogDetails } : {}) };
    this.customProducts.set(id, product);
    this.availability.set(id, true);
    const event = { type: "catalog.product.created", productId: id, next: structuredClone(product), actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return { product: structuredClone(product), version: this.version };
  }

  archiveProduct({ productId, expectedVersion, actorId, reason }) {
    this.beginWorkspace();
    const product = this.#allProducts().find((item) => item.id === productId);
    if (!product) throw domainError("product_not_found", 404);
    if (product.status === "archived") throw domainError("product_already_archived", 409);
    const result = this.updateProduct({ productId, name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId, station: product.station, status: "archived", sortRank: product.sortRank ?? 0, expectedVersion, actorId, reason });
    const metadata = { archivedAt: this.clock().toISOString(), archivedBy: actorId, archiveReason: reason.trim() };
    this.archiveMetadata.set(productId, metadata);
    this.productAudit.at(-1).type = "catalog.product.archived";
    return { ...result, type: "catalog.product.archived", archive: structuredClone(metadata) };
  }

  restoreProduct({ productId, expectedVersion, actorId, reason }) {
    this.beginWorkspace();
    const product = this.#allProducts().find((item) => item.id === productId);
    if (!product) throw domainError("product_not_found", 404);
    if (product.status !== "archived") throw domainError("product_not_archived", 409);
    const result = this.updateProduct({ productId, name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId, station: product.station, status: "active", sortRank: product.sortRank ?? 0, expectedVersion, actorId, reason });
    this.archiveMetadata.delete(productId);
    this.productAudit.at(-1).type = "catalog.product.restored";
    return { ...result, type: "catalog.product.restored", restored: true };
  }

  updateProductMedia({ productId, imageDataUrl, altText = "", expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    if (!this.#allProducts().some((item) => item.id === productId)) throw domainError("product_not_found", 404);
    const inspected = inspectCatalogMediaDataUrl(imageDataUrl);
    const media = { imageDataUrl, altText: cleanOptionalCatalogText(altText, 120), ...inspected, updatedAt: this.clock().toISOString(), updatedBy: actorId };
    this.productMedia.set(productId, media);
    const event = { type: "catalog.product.media.updated", productId, actorId, reason: reason.trim(), version: ++this.version, occurredAt: media.updatedAt };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return { productId, media: structuredClone(media), version: this.version };
  }

  removeProductMedia({ productId, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    if (!this.#allProducts().some((item) => item.id === productId)) throw domainError("product_not_found", 404);
    const removed = this.productMedia.delete(productId);
    if (!removed) return { unchanged: true, productId, version: this.version };
    const event = { type: "catalog.product.media.removed", productId, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.#syncLegacyPublishedSnapshot();
    return { productId, removed: true, version: this.version };
  }

  publishProduct({ productId, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const product = this.#allProducts().find((item) => item.id === productId);
    if (!product) throw domainError("product_not_found", 404);
    if (product.status === "active") return { unchanged: true, version: this.version };
    const next = { ...product, status: "active" };
    if (this.customProducts.has(productId)) this.customProducts.set(productId, next);
    else this.productOverrides.set(productId, { name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId ?? categoryId(productId), station: product.station, status: "active", sortRank: product.sortRank ?? 0 });
    this.availability.set(productId, true);
    const event = { type: "catalog.product.published", productId, actorId, reason: reason.trim(), version: ++this.version, occurredAt: this.clock().toISOString() };
    this.productAudit.push(event);
    this.publishHistory.push({ version: this.version, productId, actorId, reason: reason.trim(), publishedAt: event.occurredAt });
    this.publishedSnapshot = this.#compilePublishedSnapshot();
    this.workspaceBaseVersion = this.version;
    this.workspaceActive = false;
    return { product: structuredClone(next), published: true, version: this.version };
  }

  stageAvailability({ productId, available, expectedVersion, actorId, reason }) {
    if (typeof available !== "boolean") throw domainError("availability_value_invalid", 422);
    this.#assertMutation(expectedVersion, reason);
    this.beginWorkspace();
    if (!this.availability.has(productId)) throw domainError("product_not_found", 404);
    const previousAvailable = this.stagedAvailability.has(productId) ? this.stagedAvailability.get(productId).available : this.availability.get(productId) !== false;
    if (previousAvailable === available) return { unchanged: true, version: this.version };
    const staged = { productId, previousAvailable, available, actorId, reason: reason.trim(), stagedAt: this.clock().toISOString() };
    this.stagedAvailability.set(productId, staged);
    const event = { type: "catalog.availability.draft.saved", ...staged, version: ++this.version, occurredAt: staged.stagedAt };
    this.productAudit.push(event);
    return structuredClone(event);
  }

  bulkWorkspaceAction({ productIds, operation, available = null, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    this.beginWorkspace();
    const ids = [...new Set(Array.isArray(productIds) ? productIds : [])];
    if (!ids.length || ids.length > 200) throw domainError("catalog_bulk_selection_invalid", 422);
    const missing = ids.filter((id) => !this.#allProducts().some((product) => product.id === id));
    if (missing.length) throw domainError("product_not_found", 404);
    const results = [];
    let currentVersion = this.version;
    for (const productId of ids) {
      if (operation === "availability") {
        const result = this.stageAvailability({ productId, available, expectedVersion: currentVersion, actorId, reason });
        currentVersion = result.version;
        results.push({ productId, status: result.unchanged ? "UNCHANGED" : "STAGED" });
      } else if (operation === "archive") {
        const result = this.archiveProduct({ productId, expectedVersion: currentVersion, actorId, reason });
        currentVersion = result.version;
        results.push({ productId, status: "STAGED" });
      } else if (operation === "restore") {
        const result = this.restoreProduct({ productId, expectedVersion: currentVersion, actorId, reason });
        currentVersion = result.version;
        results.push({ productId, status: "STAGED" });
      } else throw domainError("catalog_bulk_operation_invalid", 422);
    }
    return { operation, results, version: this.version };
  }

  workspaceState() {
    const audits = [...this.productAudit, ...this.pricingAudit, ...this.promotionAudit, ...this.variantAudit, ...this.modifierAudit, ...this.orderingAudit]
      .filter((entry) => Number(entry.version) > this.workspaceBaseVersion)
      .sort((a, b) => a.version - b.version);
    const changes = audits.map((entry) => ({ id: `${entry.type}:${entry.version}`, type: entry.type, entityId: entry.productId ?? entry.categoryId ?? entry.promotionId ?? entry.groupId ?? "catalog", reason: entry.reason, actorId: entry.actorId, version: entry.version, occurredAt: entry.occurredAt, summary: workspaceChangeSummary(entry) }));
    return structuredClone({
      baseVersion: this.workspaceBaseVersion,
      currentVersion: this.version,
      draftCount: changes.length,
      changes,
      stagedAvailability: [...this.stagedAvailability.values()],
      publications: this.publications.slice(-20).reverse().map(({ snapshot, ...publication }) => ({ ...publication, snapshotAvailable: Boolean(snapshot) })),
      publishedRevision: this.publications.at(-1)?.revision ?? 0,
      publishedAt: this.publications.at(-1)?.publishedAt ?? null,
    });
  }

  beginWorkspace() {
    this.#ensurePublishedSnapshot();
    this.workspaceActive = true;
    return { baseVersion: this.workspaceBaseVersion, version: this.version };
  }

  publishWorkspace({ expectedVersion, actorId, reason, note = "" }) {
    this.#assertMutation(expectedVersion, reason);
    const workspace = this.workspaceState();
    if (!workspace.draftCount) throw domainError("catalog_workspace_empty", 409);
    for (const [productId, staged] of this.stagedAvailability) this.availability.set(productId, staged.available);
    for (const [productId, product] of this.customProducts) if (product.status === "draft") this.customProducts.set(productId, { ...product, status: "active" });
    for (const [productId, override] of this.productOverrides) if (override.status === "draft") this.productOverrides.set(productId, { ...override, status: "active" });
    const publishedAt = this.clock().toISOString();
    const revision = (this.publications.at(-1)?.revision ?? 0) + 1;
    const publicationVersion = ++this.version;
    const snapshot = this.#compilePublishedSnapshot(publicationVersion, revision);
    const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const publication = { id: `catalog-publication-${revision}`, revision, baseVersion: workspace.baseVersion, version: publicationVersion, snapshotHash, changeCount: workspace.draftCount, actorId, reason: reason.trim(), note: cleanOptionalCatalogText(note, 240), publishedAt, snapshot };
    this.publications.push(publication);
    if (this.publications.length > 50) this.publications.splice(0, this.publications.length - 50);
    this.publishHistory.push(publication);
    this.publishedSnapshot = snapshot;
    this.stagedAvailability.clear();
    this.productAudit.push({ type: "catalog.workspace.published", publicationId: publication.id, actorId, reason: reason.trim(), version: publicationVersion, occurredAt: publishedAt });
    this.workspaceBaseVersion = publicationVersion;
    this.workspaceActive = false;
    return structuredClone({ publication, version: this.version, published: true });
  }

  rollbackPublication({ publicationId, expectedVersion, actorId, reason }) {
    this.#assertMutation(expectedVersion, reason);
    const target = this.publications.find((item) => item.id === publicationId);
    if (!target?.snapshot) throw domainError("catalog_publication_snapshot_unavailable", 409);
    const publicationVersion = ++this.version;
    const revision = (this.publications.at(-1)?.revision ?? 0) + 1;
    const snapshot = structuredClone(target.snapshot);
    snapshot.version = publicationVersion;
    snapshot.revision = revision;
    const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const publication = { id: `catalog-publication-${revision}`, revision, baseVersion: this.workspaceBaseVersion, version: publicationVersion, snapshotHash, changeCount: 1, actorId, reason: reason.trim(), note: `Rollback ke ${publicationId}`, rollbackOf: publicationId, publishedAt: this.clock().toISOString(), snapshot };
    this.#restoreFromPublishedSnapshot(snapshot);
    this.publications.push(publication);
    if (this.publications.length > 50) this.publications.splice(0, this.publications.length - 50);
    this.publishHistory.push(publication);
    this.publishedSnapshot = snapshot;
    this.workspaceBaseVersion = publicationVersion;
    this.workspaceActive = false;
    return structuredClone({ publication, version: this.version, rolledBack: true });
  }

  catalog(channel = "KIOSK") {
    this.#restoreExpiredAvailability();
    if (channel !== "ADMIN" && this.publishedSnapshot) return this.#catalogFromSnapshot(this.publishedSnapshot, channel);
    const effectiveProducts = this.#allProducts();
    return this.#allCategories().map((category) => ({
      ...structuredClone(category),
      products: effectiveProducts.filter((product) => product.categoryId === category.id && (channel === "ADMIN" || product.status === "active")).sort((a, b) => a.sortRank - b.sortRank).map((product) => ({
        ...structuredClone(product),
        ...this.productOverrides.get(product.id),
        imageUrl: this.productMedia.get(product.id)?.imageDataUrl ?? null,
        imageAlt: this.productMedia.get(product.id)?.altText ?? product.name,
        available: product.status !== "archived" && (channel === "ADMIN" && this.stagedAvailability.has(product.id) ? this.stagedAvailability.get(product.id).available : this.availability.get(product.id) !== false),
        availabilityDraft: channel === "ADMIN" ? structuredClone(this.stagedAvailability.get(product.id) ?? null) : null,
        archive: channel === "ADMIN" ? structuredClone(this.archiveMetadata.get(product.id) ?? null) : null,
        availabilityRestoresAt: this.availabilityRestoresAt.get(product.id) ?? null,
        channel,
        variantGroups: structuredClone(this.#variantGroupsForProduct(product.id, product.customizationProfile)),
        modifierGroups: structuredClone(this.#modifierGroupsForProduct(product.id, product.customizationProfile)),
      })),
    }));
  }

  #allCategories() {
    const baseIds = new Set(SAGA_POS_MENU.map((item) => item.id));
    return [
      ...SAGA_POS_MENU.map(({ products: _products, ...item }) => ({ ...item, ...this.customCategories.get(item.id) })),
      ...[...this.customCategories.values()].filter((item) => !baseIds.has(item.id)),
    ].map((item, index) => ({ ...item, sortRank: item.sortRank ?? index * 10, archived: item.archived === true })).sort((left, right) => left.sortRank - right.sortRank || left.name.localeCompare(right.name));
  }

  #allProducts() {
    return [
      ...SAGA_POS_PRODUCTS.map((product) => ({ ...product, categoryId: categoryId(product.id), sortRank: 0, ...this.productOverrides.get(product.id) })),
      ...this.customProducts.values(),
    ];
  }

  #ensurePublishedSnapshot() {
    if (!this.publishedSnapshot) this.publishedSnapshot = this.#compilePublishedSnapshot(this.version, this.publications.at(-1)?.revision ?? 0);
  }

  #syncLegacyPublishedSnapshot() {
    if (!this.publishedSnapshot || this.workspaceActive) return;
    this.publishedSnapshot = this.#compilePublishedSnapshot(this.version, this.publishedSnapshot.revision ?? 0);
    this.workspaceBaseVersion = this.version;
  }

  #compilePublishedSnapshot(version = this.version, revision = this.publications.at(-1)?.revision ?? 0) {
    return structuredClone({
      schemaVersion: 2,
      version,
      revision,
      categories: this.#allCategories(),
      products: this.#allProducts(),
      media: [...this.productMedia],
      availability: [...this.availability],
      restoresAt: [...this.availabilityRestoresAt],
      variantGroups: this.variantGroups,
      modifierGroups: this.modifierGroups,
      promotionRules: this.promotionRules,
      pricingSettings: this.pricingSettings,
      orderingSettings: this.orderingSettings,
      archiveMetadata: [...this.archiveMetadata],
      generatedAt: this.clock().toISOString(),
    });
  }

  #restoreFromPublishedSnapshot(snapshot) {
    const baseCategoryIds = new Set(SAGA_POS_MENU.map((category) => category.id));
    const baseProductIds = new Set(SAGA_POS_PRODUCTS.map((product) => product.id));
    this.customCategories = new Map(snapshot.categories.filter((category) => !baseCategoryIds.has(category.id) || category.name !== SAGA_POS_MENU.find((item) => item.id === category.id)?.name || category.sortRank != null || category.archived === true).map((category) => [category.id, structuredClone(category)]));
    this.customProducts = new Map(snapshot.products.filter((product) => !baseProductIds.has(product.id)).map((product) => [product.id, structuredClone(product)]));
    this.productOverrides = new Map(snapshot.products.filter((product) => baseProductIds.has(product.id)).map((product) => [product.id, { name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId, station: product.station, status: product.status, sortRank: product.sortRank ?? 0, ...(product.catalogDetails ? { catalogDetails: structuredClone(product.catalogDetails) } : {}) }]));
    this.productMedia = new Map(structuredClone(snapshot.media ?? []));
    this.availability = new Map(structuredClone(snapshot.availability ?? []));
    this.availabilityRestoresAt = new Map(structuredClone(snapshot.restoresAt ?? []));
    this.variantGroups = structuredClone(snapshot.variantGroups ?? []);
    this.modifierGroups = structuredClone(snapshot.modifierGroups ?? []);
    this.promotionRules = structuredClone(snapshot.promotionRules ?? []);
    this.pricingSettings = structuredClone(snapshot.pricingSettings ?? DEFAULT_PRICING_SETTINGS);
    this.orderingSettings = structuredClone(snapshot.orderingSettings ?? this.orderingSettings);
    this.archiveMetadata = new Map(structuredClone(snapshot.archiveMetadata ?? []));
    this.stagedAvailability.clear();
  }

  #catalogFromSnapshot(snapshot, channel) {
    const availability = new Map(snapshot.availability);
    const restoresAt = new Map(snapshot.restoresAt);
    const media = new Map(snapshot.media);
    return snapshot.categories.filter((category) => category.archived !== true).map((category) => ({
      ...structuredClone(category),
      products: snapshot.products
        .filter((product) => product.categoryId === category.id && product.status === "active")
        .sort((a, b) => (a.sortRank ?? 0) - (b.sortRank ?? 0))
        .map((product) => ({
          ...structuredClone(product),
          imageUrl: media.get(product.id)?.imageDataUrl ?? null,
          imageAlt: media.get(product.id)?.altText ?? product.name,
          available: availability.get(product.id) !== false,
          availabilityRestoresAt: restoresAt.get(product.id) ?? null,
          channel,
          variantGroups: structuredClone(this.#variantGroupsForProduct(product.id, product.customizationProfile, snapshot.variantGroups)),
          modifierGroups: structuredClone(this.#modifierGroupsForProduct(product.id, product.customizationProfile, snapshot.modifierGroups)),
        })),
    }));
  }

  #assertMutation(expectedVersion, reason) {
    if (!Number.isInteger(expectedVersion)) throw domainError("catalog_version_required", 422);
    if (expectedVersion !== this.version) throw domainError("catalog_version_conflict", 409);
    if (typeof reason !== "string" || !reason.trim() || reason.length > 160) throw domainError("catalog_reason_required", 422);
  }

  etag(channel = "KIOSK") {
    this.#restoreExpiredAvailability();
    const version = channel === "ADMIN" || !this.publishedSnapshot ? this.version : this.publishedSnapshot.version;
    return `W/\"pos-catalog-${channel.toLowerCase()}-${version}\"`;
  }

  resolveMember(code) {
    const member = resolveMember(code);
    if (!member) throw domainError("member_code_required", 422);
    return safeMember(member);
  }

  setAvailability({ productId, available, actorId, reason, expectedVersion, resetMode = "end_of_day" }) {
    if (typeof available !== "boolean") throw domainError("availability_value_invalid", 422);
    this.#restoreExpiredAvailability();
    if (!this.availability.has(productId)) throw domainError("product_not_found", 404);
    if (!String(reason ?? "").trim()) throw domainError("availability_reason_required", 422);
    if (!Number.isInteger(expectedVersion)) throw domainError("catalog_version_required", 422);
    if (expectedVersion !== this.version) throw domainError("catalog_version_conflict", 409);
    if (!available && !AVAILABILITY_RESET_MODES.has(resetMode)) throw domainError("availability_reset_mode_invalid", 422);
    const previousAvailable = this.availability.get(productId) !== false;
    const occurredAt = this.clock();
    const restoresAt = available ? null : availabilityRestoreAt(resetMode, occurredAt, this.orderingSettings.closesAt);
    this.availability.set(productId, Boolean(available));
    if (restoresAt) this.availabilityRestoresAt.set(productId, restoresAt);
    else this.availabilityRestoresAt.delete(productId);
    this.version += 1;
    const event = {
      type: available ? "catalog.product.restored" : "catalog.product.sold_out",
      productId,
      previousAvailable,
      available: Boolean(available),
      actorId,
      reason: String(reason).trim(),
      resetMode: available ? null : resetMode,
      restoresAt,
      restoredAutomatically: false,
      version: this.version,
      occurredAt: occurredAt.toISOString(),
    };
    this.audit.push(event);
    if (this.publishedSnapshot) {
      this.publishedSnapshot.availability = [...this.availability];
      this.publishedSnapshot.restoresAt = [...this.availabilityRestoresAt];
      this.publishedSnapshot.version = this.version;
      if (!this.workspaceActive) this.workspaceBaseVersion = this.version;
    }
    return structuredClone(event);
  }

  availabilityHistory({ limit = 20 } = {}) {
    this.#restoreExpiredAvailability();
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const productNames = new Map(this.#allProducts().map((product) => [product.id, product.name]));
    return structuredClone(this.audit.slice(-safeLimit).reverse().map((event) => ({
      ...event,
      productName: productNames.get(event.productId) || event.productId,
    })));
  }

  quote({ cart, memberCode, verifiedMemberId, verifiedMemberSnapshot = null, rewardId, promotionCode, automaticPromotions = false, manualDiscount = null, discountActor = null, [CASHIER_DISCOUNT_AUTHORITY]: discountAuthority = null, orderType = "TAKEAWAY", paymentMethod = "QRIS", privateCanaryContext = null, canaryUsage = {}, promotionUsage = {} } = {}) {
    this.#restoreExpiredAvailability();
    const published = this.publishedSnapshot;
    const orderingSettings = published?.orderingSettings ?? this.orderingSettings;
    const publishedAvailability = published ? new Map(published.availability) : this.availability;
    const publishedProducts = published?.products ?? this.#allProducts();
    const variantGroups = published?.variantGroups ?? this.variantGroups;
    const modifierGroups = published?.modifierGroups ?? this.modifierGroups;
    const pricingSettings = published?.pricingSettings ?? this.pricingSettings;
    if (orderingSettings.paused) throw domainError("ordering_paused", 409);
    const localTime = new Date(this.clock().getTime() + JAKARTA_OFFSET_MS).toISOString().slice(11, 16);
    if (orderingSettings.enforceHours && (localTime < orderingSettings.opensAt || localTime >= orderingSettings.lastOrderAt)) throw domainError("ordering_outside_hours", 409);
    if (!PROVISIONAL_PILOT_POLICY.orderTypes.includes(orderType)) throw domainError("order_type_invalid", 422);
    const items = normalizeCart(cart);
    const productById = new Map(publishedProducts.map((item) => [item.id, item]));
    const snapshots = items.map((item) => {
      const product = productById.get(item.productId);
      if (!product || product.status !== "active" || publishedAvailability.get(product.id) === false) {
        throw domainError("active_product_required", 422);
      }
      const selections = normalizeSelections(item.selections, product.id, product.customizationProfile, this.#variantGroupsForProduct(product.id, product.customizationProfile, variantGroups), this.#modifierGroupsForProduct(product.id, product.customizationProfile, modifierGroups));
      const modifierDeltaRupiah = selections.reduce((sum, selection) => sum + selection.priceDeltaRupiah, 0);
      const unitPriceRupiah = product.priceRupiah + modifierDeltaRupiah;
      return {
        productId: product.id,
        productNameSnapshot: product.name,
        categoryIdSnapshot: product.categoryId ?? categoryId(product.id),
        qty: item.qty,
        unitPriceRupiah,
        basePriceRupiah: product.priceRupiah,
        modifierDeltaRupiah,
        selections,
        note: item.note,
        lineTotalRupiah: unitPriceRupiah * item.qty,
        stationSnapshot: product.station,
      };
    });
    const subtotalRupiah = snapshots.reduce((sum, item) => sum + item.lineTotalRupiah, 0);
    let member = verifiedMemberSnapshot ? normalizeVerifiedMemberSnapshot(verifiedMemberSnapshot, verifiedMemberId) : verifiedMemberId ? resolveMemberById(verifiedMemberId) : resolveMember(memberCode);
    let reward = resolveReward(rewardId, snapshots);
    const promotionContext = {
      privatePromotionAuthorizer: this.privatePromotionAuthorizer,
      privateCanaryContext,
      canaryUsage,
      cartLines: snapshots.length,
      cartQuantity: snapshots.reduce((sum, item) => sum + item.qty, 0),
      authoredPromotions: this.authoredPromotionEngineEnabled ? (published?.promotionRules ?? this.promotionRules) : [],
      occurredAt: this.clock().toISOString(),
      snapshots,
      orderType,
      paymentMethod,
      promotionUsage,
      memberId: member?.memberId ?? verifiedMemberId ?? null,
      allowFixturePromotions: this.allowFixturePromotions !== false,
    };
    // No code never meant an automatic promo in older channels. Opt in explicitly.
    let promotion = resolvePromotion(promotionCode, subtotalRupiah, promotionContext);
    // Member identity qualifies the voucher; its tier discount is not also applied.
    if (promotion.applied && promotion.perMemberLimit != null) member = null;
    assertExclusiveBenefit({ member, reward, promotion });
    if (!promotionCode && automaticPromotions && !manualDiscount) {
      const existingBenefit = Math.max(member ? Math.min(Math.floor(subtotalRupiah*member.discountPercent/100),member.discountCapRupiah) : 0,reward.discountRupiah);
      const candidates = promotionContext.authoredPromotions.filter(rule => rule.activationMode === "AUTOMATIC")
        .sort((a,b) => a.priority-b.priority || a.id.localeCompare(b.id));
      for (const candidate of candidates) {
        try {
          const next = resolvePromotion(candidate.code, subtotalRupiah, promotionContext);
          if (next.discountRupiah > promotion.discountRupiah && next.discountRupiah>existingBenefit) promotion = next;
        } catch (error) {
          if (!String(error.message).startsWith("promotion_") || String(error.message).includes("usage_invalid")) throw error;
        }
      }
      if(promotion.applied){member=null;reward={applied:false,discountRupiah:0};}
    }
    assertExclusiveBenefit({ member, reward, promotion });
    const memberDiscountRupiah = member
      ? Math.min(Math.floor(subtotalRupiah * member.discountPercent / 100), member.discountCapRupiah)
      : 0;
    const manual = manualDiscount ? calculateManualDiscount(manualDiscount, snapshots, discountActor, discountAuthority) : null;
    if (manual && (member || reward.applied || promotion.applied)) throw domainError("benefit_stacking_denied", 409);
    const discountRupiah = Math.min(subtotalRupiah, memberDiscountRupiah + reward.discountRupiah + promotion.discountRupiah + (manual?.discountRupiah ?? 0));
    const discountAllocations = manual?.allocations ?? promotion.allocations ?? allocateLargestRemainder(discountRupiah, snapshots.map((item,index)=>({id:`line-${index+1}`,weight:item.lineTotalRupiah})));
    const pricingPolicySnapshot = {
      version: published?.version ?? this.version,
      currency: PROVISIONAL_PILOT_POLICY.currency,
      timezone: "Asia/Jakarta",
      taxRateBps: pricingSettings.taxEnabled ? pricingSettings.taxRateBps : 0,
      serviceRateBps: pricingSettings.serviceEnabled ? pricingSettings.serviceRateBps : 0,
      priceIncludesTax: false,
      priceIncludesService: false,
      serviceTaxable: pricingSettings.serviceTaxable,
      taxDiscountTiming: pricingSettings.taxDiscountTiming,
      rounding: { mode: pricingSettings.roundingMode, stepRupiah: pricingSettings.roundingStepRupiah },
    };
    const amounts = calculateTaxService({ listedPriceRupiah: subtotalRupiah, discountRupiah, policy: pricingPolicySnapshot });
    const quote = {
      currency: PROVISIONAL_PILOT_POLICY.currency,
      orderType,
      items: snapshots,
      subtotalRupiah,
      memberDiscountRupiah,
      rewardDiscountRupiah: reward.discountRupiah,
      promotionDiscountRupiah: promotion.discountRupiah,
      discountRupiah,
      benefitSnapshot: {
        version: 1,
        source: manual ? "MANUAL" : promotion.applied ? "PROMOTION" : member ? "MEMBER" : reward.applied ? "REWARD" : "NONE",
        name: manual ? (discountActor.role === "owner" ? "Diskon Owner" : "Diskon staf") : promotion.name ?? (member ? "Benefit member" : reward.name ?? null),
        discountRupiah,
        allocations: discountAllocations,
        promotion: promotion.applied ? { id: promotion.id ?? null, code: promotion.code, name: promotion.name, version: promotion.version ?? null, activationMode: promotion.activationMode ?? "CODE", quotaLimit: promotion.quotaLimit ?? null, campaignId:promotion.campaignId??null, perMemberLimit:promotion.perMemberLimit??null } : null,
        manual: manual ? { type: manual.type, value: manual.value, productId: manual.productId, reason: manual.reason, actorId: discountActor.employeeId } : null,
      },
      taxRupiah: amounts.taxRupiah,
      serviceRupiah: amounts.serviceRupiah,
      roundingRupiah: amounts.roundingAdjustmentRupiah,
      totalRupiah: amounts.totalRupiah,
      pricingPolicySnapshot,
      member: member ? publicMember(member) : null,
      reward: reward.applied ? { id: reward.id, name: reward.name, status: "RESERVED_LOCAL" } : null,
      promotion: promotion.applied ? {
        id: promotion.id ?? null,
        version: promotion.version ?? null,
        type: promotion.type ?? null,
        code: promotion.code,
        name: promotion.name,
        privateOnly: promotion.privateOnly === true,
        authorizationPassportId: promotion.authorizationPassportId ?? null,
      } : null,
      policyStatus: PROVISIONAL_PILOT_POLICY.status,
      quoteAuthority: "SAGAOPS_LOCAL_SERVER",
      catalogVersion: published?.version ?? this.version,
      expiresAt: new Date(this.clock().getTime() + 5 * 60_000).toISOString(),
    };
    return { ...quote, benefitFingerprint:createHash('sha256').update(JSON.stringify({benefit:quote.benefitSnapshot,policy:quote.pricingPolicySnapshot})).digest('hex'),quoteFingerprint: quoteFingerprint(quote, this.quoteSigningKey, member?.memberId ?? null) };
  }

  #restoreExpiredAvailability() {
    const now = this.clock();
    for (const [productId, restoresAt] of this.availabilityRestoresAt) {
      if (Date.parse(restoresAt) > now.getTime() || this.availability.get(productId) !== false) continue;
      this.availability.set(productId, true);
      this.availabilityRestoresAt.delete(productId);
      this.version += 1;
      this.audit.push({
        type: "catalog.product.restored",
        productId,
        previousAvailable: false,
        available: true,
        actorId: "SYSTEM",
        reason: "Jadwal sold out selesai",
        resetMode: null,
        restoresAt: null,
        restoredAutomatically: true,
        version: this.version,
        occurredAt: now.toISOString(),
      });
      if (this.publishedSnapshot) {
        this.publishedSnapshot.availability = [...this.availability];
        this.publishedSnapshot.restoresAt = [...this.availabilityRestoresAt];
        this.publishedSnapshot.version = this.version;
        if (!this.workspaceActive) this.workspaceBaseVersion = this.version;
      }
    }
  }
}

function workspaceChangeSummary(entry) {
  const labels = {
    "catalog.category.created": "Kategori baru",
    "catalog.category.updated": "Kategori diperbarui",
    "catalog.category.archived": "Kategori diarsipkan",
    "catalog.product.created": "Produk baru",
    "catalog.product.updated": entry.next?.status === "archived" ? "Produk diarsipkan" : "Produk diperbarui",
    "catalog.product.order.updated": "Urutan produk diperbarui",
    "catalog.product.archived": "Produk diarsipkan",
    "catalog.product.restored": "Produk dipulihkan",
    "catalog.product.media.updated": "Foto produk diperbarui",
    "catalog.product.media.removed": "Foto produk dihapus",
    "catalog.product.published": "Produk diterbitkan",
    "catalog.availability.draft.saved": entry.available ? "Produk ditandai tersedia" : "Produk ditandai habis",
    "catalog.promotion.draft.saved": "Promo disimpan",
    "catalog.promotion.status.changed": "Status promo diubah",
    "catalog.variant.group.upserted": "Grup variant diperbarui",
    "catalog.variant.option.upserted": "Opsi variant diperbarui",
    "catalog.modifier.group.upserted": "Grup modifier diperbarui",
    "catalog.modifier.option.upserted": "Opsi modifier diperbarui",
    "catalog.ordering.updated": "Pengaturan Kiosk diperbarui",
    "catalog.pricing.updated": "Aturan harga diperbarui",
  };
  return labels[entry.type] ?? entry.type;
}

function quoteFingerprint(quote, signingKey, memberId) {
  const payload = {
    catalogVersion: quote.catalogVersion,
    currency: quote.currency,
    orderType: quote.orderType,
    items: quote.items.map((item) => ({
      productId: item.productId,
      qty: item.qty,
      unitPriceRupiah: item.unitPriceRupiah,
      selections: item.selections.map((selection) => ({
        groupId: selection.groupId,
        optionId: selection.optionId,
        priceDeltaRupiah: selection.priceDeltaRupiah,
      })),
      note: item.note,
    })),
    subtotalRupiah: quote.subtotalRupiah,
    discountRupiah: quote.discountRupiah,
    taxRupiah: quote.taxRupiah,
    serviceRupiah: quote.serviceRupiah,
    roundingRupiah: quote.roundingRupiah,
    pricingPolicySnapshot: quote.pricingPolicySnapshot,
    totalRupiah: quote.totalRupiah,
    memberId,
    rewardId: quote.reward?.id ?? null,
    promotionCode: quote.promotion?.code ?? null,
  };
  return createHmac("sha256", signingKey).update(JSON.stringify(payload)).digest("hex");
}

function cleanCatalogText(value, code, maximum) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f<>]/.test(normalized)) throw domainError(code, 422);
  return normalized;
}

function cleanOptionalCatalogText(value, maximum) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length > maximum || /[\u0000-\u001f<>]/.test(normalized)) throw domainError("catalog_media_alt_invalid", 422);
  return normalized;
}

function normalizeCatalogDetails(input, productIds, currentProductId) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw domainError("catalog_details_invalid", 422);
  const allowed = new Set(["shortDescription", "description", "profileTags", "allergens", "badges", "alternativeProductIds", "nutritionEstimate"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw domainError("catalog_details_invalid", 422);
  const shortDescription = cleanOptionalEditorialText(input.shortDescription, 160);
  const description = cleanOptionalEditorialText(input.description, 600);
  const profileTags = normalizeEditorialList(input.profileTags, 6, 40, "catalog_profile_tags_invalid");
  const allergens = normalizeEditorialList(input.allergens, 12, 60, "catalog_allergens_invalid");
  const badges = normalizeEditorialList(input.badges, 2, 40, "catalog_badges_invalid");
  const alternativeProductIds = [...new Set(Array.isArray(input.alternativeProductIds) ? input.alternativeProductIds : [])];
  if (alternativeProductIds.length > 6 || alternativeProductIds.some((id) => typeof id !== "string" || id === currentProductId || !productIds.has(id))) throw domainError("catalog_alternatives_invalid", 422);
  const nutritionEstimate = normalizeNutritionEstimate(input.nutritionEstimate);
  if (!shortDescription && !description && !profileTags.length && !allergens.length && !badges.length && !alternativeProductIds.length && !nutritionEstimate) return null;
  return { shortDescription, description, profileTags, allergens, badges, alternativeProductIds, nutritionEstimate };
}

function cleanOptionalEditorialText(value, maximum) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length > maximum || /[\u0000-\u001f<>]/.test(normalized)) throw domainError("catalog_editorial_text_invalid", 422);
  return normalized;
}

function normalizeEditorialList(value, maximumItems, maximumLength, code) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw domainError(code, 422);
  const normalized = value.map((item) => cleanOptionalEditorialText(item, maximumLength)).filter(Boolean);
  if (new Set(normalized.map((item) => item.toLocaleLowerCase("id-ID"))).size !== normalized.length) throw domainError(code, 422);
  return normalized;
}

function normalizeNutritionEstimate(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw domainError("catalog_nutrition_invalid", 422);
  const numericKeys = ["caloriesKcal", "sugarG", "proteinG", "fatG", "caffeineMg", "servingMl"];
  if (Object.keys(value).some((key) => !numericKeys.includes(key) && key !== "sourceUpdatedAt")) throw domainError("catalog_nutrition_invalid", 422);
  const normalized = {};
  for (const key of numericKeys) {
    if (value[key] == null || value[key] === "") continue;
    const amount = Number(value[key]);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000) throw domainError("catalog_nutrition_invalid", 422);
    normalized[key] = amount;
  }
  if (!Object.keys(normalized).length) return null;
  const sourceUpdatedAt = String(value.sourceUpdatedAt ?? "");
  if (!sourceUpdatedAt || !Number.isFinite(Date.parse(sourceUpdatedAt))) throw domainError("catalog_nutrition_source_required", 422);
  return { ...normalized, sourceUpdatedAt: new Date(sourceUpdatedAt).toISOString() };
}

function uniqueSlug(value, used) {
  const base = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `menu-${randomUUID().slice(0, 8)}`;
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 43)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 39)}-${randomUUID().slice(0, 8)}`;
}

const AVAILABILITY_RESET_MODES = new Set(["30_minutes", "60_minutes", "end_of_day", "manual"]);
const JAKARTA_OFFSET_MS = 7 * 60 * 60_000;

function availabilityRestoreAt(resetMode, now, closingTime = "22:00") {
  if (resetMode === "manual") return null;
  if (resetMode === "30_minutes") return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (resetMode === "60_minutes") return new Date(now.getTime() + 60 * 60_000).toISOString();
  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const [hours, minutes] = closingTime.split(":").map(Number);
  let closesAt = Date.UTC(jakartaNow.getUTCFullYear(), jakartaNow.getUTCMonth(), jakartaNow.getUTCDate(), hours - 7, minutes, 0);
  if (closesAt <= now.getTime()) closesAt += 24 * 60 * 60_000;
  return new Date(closesAt).toISOString();
}

function normalizeCart(cart) {
  if (!Array.isArray(cart) || cart.length === 0) throw domainError("cart_required", 422);
  if (cart.length > 40) throw domainError("cart_item_limit_exceeded", 422);
  return cart.map((item) => {
    const productId = String(item?.productId ?? "").trim();
    const qty = Number(item?.qty ?? 0);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 20) throw domainError("cart_item_invalid", 422);
    const note = String(item?.note ?? "").trim().slice(0, 160);
    return { productId, qty, note, selections: item?.selections };
  });
}

function modifierGroupsForProduct(productId, customizationProfile) {
  if (productConfiguration(productId, customizationProfile) === "none") return [];
  return PROVISIONAL_PILOT_POLICY.modifiers
    .map((group) => ({
      ...group,
      options: group.options
        .filter((option) => !option.productIds || option.productIds.includes(productId))
        .map(({ productIds: _productIds, ...option }) => option),
    }))
    .filter((group) => group.options.length);
}

function variantGroupsForProduct(productId, customizationProfile) {
  return productConfiguration(productId, customizationProfile) === "none" ? [] : PROVISIONAL_PILOT_POLICY.variants;
}

function productConfiguration(productId, customizationProfile) {
  return customizationProfile || SAGA_POS_PRODUCTS.find((product) => product.id === productId)?.customizationProfile || "beverage";
}

function normalizeSelections(selections, productId, customizationProfile, configuredVariantGroups = variantGroupsForProduct(productId, customizationProfile), configuredModifierGroups = modifierGroupsForProduct(productId, customizationProfile)) {
  if (selections == null) selections = [];
  if (!Array.isArray(selections) || selections.length > 8) throw domainError("modifier_selection_invalid", 422);
  const groups = [...configuredVariantGroups, ...configuredModifierGroups];
  const limits = new Map(groups.map((group) => [group.id, Number(group.max || 1)]));
  const allowed = new Map(groups.flatMap((group) => group.options.map((option) => [`${group.id}:${option.id}`, { ...option, groupId: group.id, groupLabel: group.label }])));
  const seenOptions = new Set();
  const groupCounts = new Map();
  const normalized = selections.map((selection) => {
    const key = `${selection?.groupId}:${selection?.optionId}`;
    const option = allowed.get(key);
    const nextCount = (groupCounts.get(option?.groupId) || 0) + 1;
    if (!option || seenOptions.has(key) || nextCount > (limits.get(option.groupId) || 1)) throw domainError("modifier_selection_invalid", 422);
    seenOptions.add(key);
    groupCounts.set(option.groupId, nextCount);
    return {
      groupId: option.groupId,
      groupLabel: option.groupLabel,
      optionId: option.id,
      optionLabel: option.label,
      priceDeltaRupiah: option.priceDeltaRupiah,
    };
  });
  for (const group of groups) {
    const count = groupCounts.get(group.id) || 0;
    if (count < Number(group.min || 0) || (group.required && count === 0)) throw domainError("modifier_selection_required", 422);
  }
  return normalized;
}

function normalizeChoiceProducts(productIds, products, errorCode = "modifier_product_scope_invalid") {
  if (!Array.isArray(productIds) || productIds.length > 200) throw domainError(errorCode, 422);
  const available = new Set(products.map((product) => product.id));
  const normalized = [...new Set(productIds.map((productId) => String(productId ?? "").trim()).filter(Boolean))];
  if (normalized.some((productId) => !available.has(productId))) throw domainError(errorCode, 422);
  return normalized.sort();
}

function resolveMember(code) {
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) return null;
  if (normalized !== PROVISIONAL_PILOT_POLICY.memberFixture.code) throw domainError("member_code_invalid", 422);
  return PROVISIONAL_PILOT_POLICY.memberFixture;
}

function resolveMemberById(memberId) {
  const normalized = String(memberId ?? "").trim();
  if (!normalized) return null;
  if (normalized !== PROVISIONAL_PILOT_POLICY.memberFixture.memberId) throw domainError("verified_member_invalid", 422);
  return PROVISIONAL_PILOT_POLICY.memberFixture;
}

function normalizeVerifiedMemberSnapshot(value, verifiedMemberId) {
  const memberId = String(value?.memberId ?? "").trim();
  const displayName = String(value?.displayName ?? "").trim();
  const codeMasked = String(value?.codeMasked ?? "").trim();
  const tier = String(value?.tier ?? "").trim().toUpperCase();
  const discountPercent = Number(value?.discountPercent ?? 0);
  const discountCapRupiah = Number(value?.discountCapRupiah ?? 0);
  if (!memberId || memberId !== String(verifiedMemberId ?? "").trim() || !displayName || displayName.length > 120 || !codeMasked || codeMasked.length > 64
    || !new Set(["EXPLORER", "VOYAGER", "PIONEER", "LEGEND"]).has(tier)
    || !Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100
    || !Number.isSafeInteger(discountCapRupiah) || discountCapRupiah < 0) throw domainError("verified_member_invalid", 422);
  return { memberId, displayName, codeMasked, tier, discountPercent, discountCapRupiah };
}

function resolveReward(id, items) {
  if (!id) return { applied: false, discountRupiah: 0 };
  const fixture = PROVISIONAL_PILOT_POLICY.rewardFixture;
  if (id !== fixture.id) throw domainError("reward_invalid", 422);
  const americano = items.find((item) => item.productId === "americano");
  if (!americano) throw domainError("reward_item_required", 422);
  return { ...fixture, applied: true, discountRupiah: Math.min(americano.unitPriceRupiah, fixture.maximumDiscountRupiah) };
}

function resolvePromotion(code, subtotalRupiah, { privatePromotionAuthorizer, privateCanaryContext, canaryUsage, cartLines, cartQuantity, authoredPromotions = [], occurredAt, snapshots = [], orderType, paymentMethod, promotionUsage = {}, memberId = null, allowFixturePromotions = true } = {}) {
  if (!code) return { applied: false, discountRupiah: 0 };
  const normalizedCode = String(code).trim().toUpperCase();
  if (normalizedCode === "TRIAL99") {
    if (!privatePromotionAuthorizer?.authorizePromotion) throw domainError("private_promotion_authorization_required", 403);
    try {
      return privatePromotionAuthorizer.authorizePromotion({
        promotionCode: "TRIAL99",
        subtotalRupiah,
        cartLines,
        cartQuantity,
        usage: canaryUsage,
        ...(privateCanaryContext ?? {}),
      });
    } catch {
      throw domainError("private_promotion_authorization_denied", 403);
    }
  }
  const authored = authoredPromotions.find((item) => item.code === normalizedCode && item.status !== "ARCHIVED");
  if (authored) {
    const used = Number(promotionUsage[authored.id] ?? promotionUsage[authored.code] ?? 0);
    if (!Number.isSafeInteger(used) || used < 0) throw domainError("promotion_usage_invalid", 500);
    if (authored.quotaLimit != null && used >= authored.quotaLimit) throw domainError("promotion_quota_exhausted", 409);
    if (authored.perMemberLimit != null) {
      if (!memberId) throw domainError('promotion_verified_member_required',409);
      const memberUsed=promotionUsage[`member:${authored.campaignId ?? authored.id}:${memberId}`]??0;
      if(!Number.isSafeInteger(memberUsed) || memberUsed<0)throw domainError('promotion_usage_invalid',500);
      if(memberUsed>=authored.perMemberLimit)throw domainError('promotion_member_limit_reached',409);
    }
    const result = applyPromotionVersions({
      promotions: [authored],
      occurredAt,
      context: { outletId: "outlet-kopi-saga-salak", paymentMethod, salesMode: orderType },
      lines: snapshots.map((item, index) => ({
        id: `line-${index + 1}`,
        productId: item.productId,
        categoryId: item.categoryIdSnapshot,
        eligibleBaseRupiah: item.lineTotalRupiah,
        quantity: item.qty,
        unitPriceRupiah: item.unitPriceRupiah,
      })),
    });
    const applied = result.applied[0];
    if (!applied) throw domainError(`promotion_${String(result.skipped[0]?.reason ?? "invalid").toLowerCase()}`, 422);
    return {
      applied: true,
      id: authored.id,
      version: authored.version,
      type: authored.type,
      code: authored.code,
      name: authored.name,
      discountRupiah: applied.discountRupiah,
      allocations: result.lineDiscounts,
      activationMode: authored.activationMode ?? "CODE",
      quotaLimit: authored.quotaLimit,
      campaignId: authored.campaignId ?? null,
      perMemberLimit: authored.perMemberLimit ?? null,
      privateOnly: false,
    };
  }
  const fixture = PROVISIONAL_PILOT_POLICY.promotionFixture;
  if (!allowFixturePromotions || normalizedCode !== fixture.code) throw domainError("promotion_invalid", 422);
  return {
    ...fixture,
    applied: true,
    discountRupiah: Math.min(Math.floor(subtotalRupiah * fixture.discountPercent / 100), fixture.discountCapRupiah),
  };
}

function assertExclusiveBenefit({ member, reward, promotion }) {
  const selected = [Boolean(member), reward.applied, promotion.applied].filter(Boolean).length;
  if (selected > 1) throw domainError("benefit_stacking_denied", 409);
}

function calculateManualDiscount(input, items, actor, authority) {
  if (actor?.role !== "owner" && authority !== true) throw domainError("manual_discount_owner_required", 403);
  if (!input || typeof input !== "object" || !["PERCENT", "FIXED"].includes(input.type)) throw domainError("manual_discount_invalid", 422);
  const value = input.value;
  if (!Number.isSafeInteger(value) || value <= 0 || (input.type === "PERCENT" && value > 10000)) throw domainError("manual_discount_invalid", 422);
  const reason = String(input.reason ?? "").trim();
  if (!reason || reason.length > 160) throw domainError("manual_discount_reason_required", 422);
  const productId = input.productId || null;
  if (productId !== null && (typeof productId !== "string" || !items.some(item=>item.productId===productId))) throw domainError("manual_discount_product_invalid", 422);
  const weights = items.map((item,index)=>({id:`line-${index+1}`,weight:!productId || item.productId===productId ? item.lineTotalRupiah : 0}));
  const base = weights.reduce((sum,item)=>sum+item.weight,0);
  const discountRupiah = input.type === "PERCENT" ? Number(BigInt(base)*BigInt(value)/10000n) : value;
  if (discountRupiah > base || discountRupiah < 1) throw domainError("manual_discount_exceeds_base", 422);
  return { type:input.type, value, reason, productId, discountRupiah, allocations:allocateLargestRemainder(discountRupiah,weights) };
}

const PRICING_ROUNDING_MODES = new Set(["NONE", "UP", "DOWN", "NEAREST_HALF_UP"]);
const PRICING_TAX_TIMINGS = new Set(["BEFORE_DISCOUNT", "AFTER_DISCOUNT"]);
const PRICING_ROUNDING_STEPS = new Set([1, 10, 50, 100, 500, 1000]);

function normalizePricingSettings(input = {}) {
  const taxEnabled = input.taxEnabled === true;
  const serviceEnabled = input.serviceEnabled === true;
  const taxRateBps = Number(input.taxRateBps ?? 0);
  const serviceRateBps = Number(input.serviceRateBps ?? 0);
  const serviceTaxable = input.serviceTaxable === true;
  const taxDiscountTiming = String(input.taxDiscountTiming ?? "AFTER_DISCOUNT").toUpperCase();
  const roundingMode = String(input.roundingMode ?? "NONE").toUpperCase();
  const roundingStepRupiah = Number(input.roundingStepRupiah ?? 1);
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) throw domainError("pricing_tax_rate_invalid", 422);
  if (!Number.isInteger(serviceRateBps) || serviceRateBps < 0 || serviceRateBps > 10_000) throw domainError("pricing_service_rate_invalid", 422);
  if (!PRICING_TAX_TIMINGS.has(taxDiscountTiming)) throw domainError("pricing_tax_timing_invalid", 422);
  if (!PRICING_ROUNDING_MODES.has(roundingMode)) throw domainError("pricing_rounding_mode_invalid", 422);
  if (!PRICING_ROUNDING_STEPS.has(roundingStepRupiah) || (roundingMode === "NONE" && roundingStepRupiah !== 1)) throw domainError("pricing_rounding_step_invalid", 422);
  return {
    taxEnabled,
    taxRateBps: taxEnabled ? taxRateBps : 0,
    serviceEnabled,
    serviceRateBps: serviceEnabled ? serviceRateBps : 0,
    serviceTaxable: serviceEnabled && taxEnabled ? serviceTaxable : false,
    taxDiscountTiming,
    roundingMode,
    roundingStepRupiah,
  };
}

function safeMember(member) {
  return { memberId: member.memberId, displayName: member.displayName, codeMasked: member.codeMasked, tier: member.tier };
}

function publicMember(member) {
  return { displayName: member.displayName, codeMasked: member.codeMasked, tier: member.tier };
}

function categoryId(productId) {
  return SAGA_POS_MENU.find((category) => category.products.some((product) => product.id === productId))?.id ?? null;
}

export function hashFixtureCode(value) {
  return createHash("sha256").update(String(value ?? "").trim().toUpperCase()).digest("hex");
}

function inspectCatalogMediaDataUrl(value) {
  if (typeof value !== "string" || value.length > 850_000) throw domainError("catalog_media_invalid", 422);
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw domainError("catalog_media_invalid", 422);
  const binary = Buffer.from(match[2], "base64");
  if (binary.length < 24 || binary.length > 600_000) throw domainError("catalog_media_invalid", 422);
  const expected = match[2].replace(/=+$/, "");
  if (binary.toString("base64").replace(/=+$/, "") !== expected) throw domainError("catalog_media_invalid", 422);
  const contentType = `image/${match[1]}`;
  const dimensions = imageDimensions(binary, contentType);
  if (!dimensions || dimensions.width < 32 || dimensions.height < 32 || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 16_000_000) throw domainError("catalog_media_invalid", 422);
  if (containsCatalogImageMetadata(binary, contentType)) throw domainError("catalog_media_metadata_not_allowed", 422);
  return { contentType, byteSize: binary.length, width: dimensions.width, height: dimensions.height };
}

function imageDimensions(binary, contentType) {
  if (contentType === "image/png") {
    if (binary.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || binary.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    return { width: binary.readUInt32BE(16), height: binary.readUInt32BE(20) };
  }
  if (contentType === "image/jpeg") {
    if (binary[0] !== 0xff || binary[1] !== 0xd8 || binary.at(-2) !== 0xff || binary.at(-1) !== 0xd9) return null;
    for (let offset = 2; offset + 9 < binary.length;) {
      if (binary[offset] !== 0xff) return null;
      const marker = binary[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = binary.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > binary.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: binary.readUInt16BE(offset + 5), width: binary.readUInt16BE(offset + 7) };
      offset += length + 2;
    }
    return null;
  }
  if (binary.subarray(0, 4).toString("ascii") !== "RIFF" || binary.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = binary.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && binary.length >= 30) return { width: 1 + binary.readUIntLE(24, 3), height: 1 + binary.readUIntLE(27, 3) };
  if (chunk === "VP8L" && binary.length >= 25 && binary[20] === 0x2f) {
    const bits = binary.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && binary.length >= 30 && binary.subarray(23, 26).toString("hex") === "9d012a") return { width: binary.readUInt16LE(26) & 0x3fff, height: binary.readUInt16LE(28) & 0x3fff };
  return null;
}

function containsCatalogImageMetadata(binary, contentType) {
  if (contentType === "image/jpeg") {
    for (let offset = 2; offset + 4 < binary.length && binary[offset] === 0xff;) {
      const marker = binary[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = binary.readUInt16BE(offset + 2);
      if (marker === 0xe1) return true;
      if (length < 2) break;
      offset += length + 2;
    }
    return false;
  }
  const ascii = binary.toString("latin1");
  return contentType === "image/png" ? /(?:tEXt|zTXt|iTXt)/.test(ascii) : /(?:EXIF|XMP )/.test(ascii);
}

function domainError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
