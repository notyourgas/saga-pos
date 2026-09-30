import { catalogPricingError, deepFreeze, requiredText } from "./errors.mjs";
import { assertRupiah } from "./money.mjs";

export const FREE_PRICE_PERMISSION = "POS_CATALOG_FREE_PRICE_APPLY";

export function applyFreePriceOverride({ priceEntry, requestedPriceRupiah, actorUserId, operationKey, authorization, occurredAt } = {}) {
  if (!priceEntry?.freePriceEnabled) throw catalogPricingError("free_price_not_enabled", 403);
  const requested = assertRupiah(requestedPriceRupiah, "free_price_value_invalid", {
    minimum: priceEntry.minimumFreePriceRupiah,
    maximum: priceEntry.maximumFreePriceRupiah,
  });
  const actor = requiredText(actorUserId, "free_price_actor_required");
  const operation = requiredText(operationKey, "free_price_operation_key_required", { max: 128 });
  const now = Date.parse(occurredAt);
  if (!Number.isFinite(now)) throw catalogPricingError("free_price_time_invalid");
  if (!authorization || authorization.status !== "APPROVED" || authorization.permission !== FREE_PRICE_PERMISSION) {
    throw catalogPricingError("free_price_authorization_required", 403);
  }
  if (authorization.action !== "PRICE_OVERRIDE" || authorization.resourceType !== "PRICE_BOOK_ENTRY" || authorization.resourceId !== priceEntry.id) {
    throw catalogPricingError("free_price_authorization_scope_mismatch", 403);
  }
  if (authorization.actorUserId !== actor || authorization.originalPriceRupiah !== priceEntry.priceRupiah || authorization.requestedPriceRupiah !== requested) {
    throw catalogPricingError("free_price_authorization_value_mismatch", 403);
  }
  if (authorization.oneTime !== true || authorization.usedAt != null) throw catalogPricingError("free_price_authorization_already_used", 409);
  const approvedAt = Date.parse(authorization.approvedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(approvedAt) || approvedAt > now) throw catalogPricingError("free_price_authorization_time_invalid", 403);
  if (!Number.isFinite(expiresAt) || expiresAt <= approvedAt || now >= expiresAt) {
    throw catalogPricingError("free_price_authorization_expired", 403);
  }
  const authorizationId = requiredText(authorization.id, "free_price_authorization_id_required");
  const approvedByUserId = requiredText(authorization.approvedByUserId, "free_price_approver_required");
  const reason = requiredText(authorization.reason, "free_price_reason_required", { max: 240 });
  return deepFreeze({
    priceRupiah: requested,
    audit: {
      action: "PRICE_OVERRIDE",
      permission: FREE_PRICE_PERMISSION,
      authorizationId,
      operationKey: operation,
      actorUserId: actor,
      approvedByUserId,
      resourceType: "PRICE_BOOK_ENTRY",
      resourceId: priceEntry.id,
      originalPriceRupiah: priceEntry.priceRupiah,
      requestedPriceRupiah: requested,
      reason,
      approvedAt: new Date(approvedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      occurredAt: new Date(now).toISOString(),
      requiresDurableSingleUseConstraint: true,
    },
  });
}
