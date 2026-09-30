import { catalogPricingError, deepFreeze, requiredText } from "./errors.mjs";
import { assertRupiah, MAX_RUPIAH } from "./money.mjs";

export function validateModifierSelections({ groups = [], selections = [] } = {}) {
  if (!Array.isArray(groups) || !Array.isArray(selections)) throw catalogPricingError("modifier_contract_invalid");
  const groupById = new Map();
  const optionByKey = new Map();
  for (const group of groups) {
    const id = requiredText(group?.id, "modifier_group_id_required");
    if (groupById.has(id)) throw catalogPricingError("modifier_group_duplicate");
    const minimum = Number(group.minimumSelections ?? 0);
    const maximum = Number(group.maximumSelections ?? 1);
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 0 || maximum < minimum || maximum > 100) {
      throw catalogPricingError("modifier_group_limit_invalid");
    }
    const normalized = { id, version: Number(group.version ?? 1), minimum, maximum, allowRepeat: group.allowRepeat === true };
    if (!Number.isInteger(normalized.version) || normalized.version < 1) throw catalogPricingError("modifier_group_version_invalid");
    groupById.set(id, normalized);
    if (!Array.isArray(group.options) || group.options.length === 0) throw catalogPricingError("modifier_options_required");
    for (const option of group.options) {
      const optionId = requiredText(option?.id, "modifier_option_id_required");
      const key = `${id}:${optionId}`;
      if (optionByKey.has(key)) throw catalogPricingError("modifier_option_duplicate");
      const optionVersion = Number(option.version ?? normalized.version);
      if (!Number.isInteger(optionVersion) || optionVersion < 1) throw catalogPricingError("modifier_option_version_invalid");
      optionByKey.set(key, {
        id: optionId,
        groupId: id,
        version: optionVersion,
        name: requiredText(option.name ?? optionId, "modifier_option_name_required", { max: 80 }),
        priceDeltaRupiah: assertRupiah(option.priceDeltaRupiah ?? 0, "modifier_price_invalid"),
        active: option.active !== false,
      });
    }
  }

  const counts = new Map(groups.map((group) => [String(group.id), 0]));
  const seen = new Set();
  let priceDeltaRupiah = 0;
  const snapshots = selections.map((selection) => {
    const groupId = String(selection?.groupId ?? "").trim();
    const optionId = String(selection?.optionId ?? "").trim();
    const group = groupById.get(groupId);
    const option = optionByKey.get(`${groupId}:${optionId}`);
    const quantity = Number(selection?.quantity ?? 1);
    if (!group || !option || !option.active || !Number.isInteger(quantity) || quantity < 1 || quantity > 100 || (!group.allowRepeat && quantity > 1)) {
      throw catalogPricingError("modifier_selection_invalid");
    }
    const key = `${groupId}:${optionId}`;
    if (!group.allowRepeat && seen.has(key)) throw catalogPricingError("modifier_selection_duplicate");
    seen.add(key);
    counts.set(groupId, (counts.get(groupId) ?? 0) + quantity);
    const delta = option.priceDeltaRupiah * quantity;
    if (!Number.isSafeInteger(delta) || priceDeltaRupiah > MAX_RUPIAH - delta) throw catalogPricingError("modifier_price_overflow");
    priceDeltaRupiah += delta;
    return deepFreeze({
      groupId,
      groupVersion: group.version,
      optionId,
      optionVersion: option.version,
      optionNameSnapshot: option.name,
      quantity,
      unitPriceDeltaRupiah: option.priceDeltaRupiah,
      priceDeltaRupiah: delta,
    });
  });
  for (const group of groupById.values()) {
    const count = counts.get(group.id) ?? 0;
    if (count < group.minimum) throw catalogPricingError("modifier_minimum_not_met", 422, { groupId: group.id, minimum: group.minimum });
    if (count > group.maximum) throw catalogPricingError("modifier_maximum_exceeded", 422, { groupId: group.id, maximum: group.maximum });
  }
  return deepFreeze({ selections: snapshots, priceDeltaRupiah });
}
