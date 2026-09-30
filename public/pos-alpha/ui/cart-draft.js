export const CART_DRAFT_KEY = "saga_pos_cart_draft_v1";
export const CART_DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

export function createCartDraft({ sessionId, orderType, selectedCategory, cart, now = Date.now() } = {}) {
  const lines = [...(cart?.values?.() || [])].map((line) => ({
    id: safeLineId(line.id),
    productId: String(line.productId || "").slice(0, 80),
    qty: clampQuantity(line.qty),
    selections: (line.selections || []).map((selection) => ({
      groupId: String(selection.groupId || "").slice(0, 80),
      optionId: String(selection.optionId || "").slice(0, 80),
    })),
    note: String(line.note || "").slice(0, 120),
  })).filter((line) => line.productId && line.qty > 0);

  return {
    version: 1,
    sessionId: String(sessionId || ""),
    savedAt: Number(now),
    orderType: ["DINE_IN", "TAKEAWAY"].includes(orderType) ? orderType : "",
    selectedCategory: String(selectedCategory || "").slice(0, 80),
    lines,
  };
}

export function restoreCartDraft(raw, { sessionId, catalog, now = Date.now(), maxAgeMs = CART_DRAFT_MAX_AGE_MS } = {}) {
  let draft;
  try {
    draft = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return emptyRecovery("invalid");
  }
  if (!draft || draft.version !== 1) return emptyRecovery("invalid");
  if (!sessionId || draft.sessionId !== sessionId) return emptyRecovery("session_mismatch");
  if (!Number.isFinite(draft.savedAt) || now - draft.savedAt < 0 || now - draft.savedAt > maxAgeMs) return emptyRecovery("expired");

  const categories = Array.isArray(catalog) ? catalog : [];
  const products = new Map(categories.flatMap((category) => category.products || []).map((product) => [product.id, product]));
  const lines = [];
  let droppedCount = 0;

  for (const [index, candidate] of (Array.isArray(draft.lines) ? draft.lines : []).entries()) {
    const product = products.get(candidate?.productId);
    if (!product || product.available === false || product.status !== "active") {
      droppedCount += 1;
      continue;
    }
    const selections = canonicalSelections(candidate.selections, product);
    if (!Array.isArray(candidate.selections) || selections.length !== candidate.selections.length) {
      droppedCount += 1;
      continue; // Never silently turn a saved choice into a different configuration.
    }
    lines.push({
      id: uniqueLineId(candidate.id, index, lines),
      productId: product.id,
      qty: clampQuantity(candidate.qty),
      selections,
      note: String(candidate.note || "").slice(0, 120),
    });
  }

  const availableCategories = new Set(categories.map((category) => category.id));
  return {
    status: lines.length ? "restored" : "empty",
    orderType: ["DINE_IN", "TAKEAWAY"].includes(draft.orderType) ? draft.orderType : "",
    selectedCategory: availableCategories.has(draft.selectedCategory) ? draft.selectedCategory : categories[0]?.id || "",
    lines,
    droppedCount,
  };
}

function canonicalSelections(candidates, product) {
  const groups = new Map([...(product.variantGroups || []), ...(product.modifierGroups || [])].map((group) => [group.id, group]));
  const selectedByGroup = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const group = groups.get(candidate?.groupId);
    const option = group?.options?.find((item) => item.id === candidate?.optionId);
    if (!group || !option || option.available === false) continue;
    const selected = selectedByGroup.get(group.id) || [];
    if (selected.some((item) => item.optionId === option.id) || selected.length >= Number(group.max || 1)) continue;
    selected.push({ groupId: group.id, groupLabel: group.label, optionId: option.id, optionLabel: option.label, priceDeltaRupiah: Number(option.priceDeltaRupiah || 0) });
    selectedByGroup.set(group.id, selected);
  }
  return [...selectedByGroup.values()].flat();
}

function uniqueLineId(value, index, lines) {
  const candidate = safeLineId(value) || `restored-${index + 1}`;
  return lines.some((line) => line.id === candidate) ? `${candidate}-${index + 1}` : candidate;
}

function safeLineId(value) {
  const candidate = String(value || "");
  return /^[A-Za-z0-9:_-]{1,80}$/.test(candidate) ? candidate : "";
}

function clampQuantity(value) {
  const quantity = Math.trunc(Number(value));
  return Number.isFinite(quantity) ? Math.min(20, Math.max(1, quantity)) : 1;
}

function emptyRecovery(status) {
  return { status, orderType: "", selectedCategory: "", lines: [], droppedCount: 0 };
}
