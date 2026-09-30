import { SAGA_POS_PRODUCTS } from "./catalog.mjs";
import { PilotCatalogPricing } from "./pilot-policy.mjs";

export const CATALOG_PREVIEW_PRODUCT_COUNT = 22;

export function prepareCatalogPreview({
  snapshot,
  actorId = "OWNER-CATALOG-PREVIEW",
  reason = "Owner approved catalog preview while payment remains off",
  clock = () => new Date(),
} = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("catalog_snapshot_required");
  if (SAGA_POS_PRODUCTS.length !== CATALOG_PREVIEW_PRODUCT_COUNT) throw new Error("catalog_preview_product_contract_changed");

  const catalog = new PilotCatalogPricing({ clock });
  catalog.restoreState(structuredClone(snapshot));
  const versionBefore = catalog.version;

  for (const canonical of SAGA_POS_PRODUCTS) {
    let product = adminProduct(catalog, canonical.id);
    if (!product) throw new Error(`catalog_preview_product_missing:${canonical.id}`);
    if (product.status !== "active") {
      catalog.publishProduct({ productId: canonical.id, expectedVersion: catalog.version, actorId, reason });
      product = adminProduct(catalog, canonical.id);
    }
    if (!product.available) {
      catalog.setAvailability({
        productId: canonical.id,
        available: true,
        expectedVersion: catalog.version,
        actorId,
        reason,
        resetMode: "manual",
      });
    }
  }

  const settings = catalog.exportState().orderingSettings;
  if (settings.paused !== true) {
    catalog.updateOrdering({ ...settings, paused: true, expectedVersion: catalog.version, actorId, reason });
  }

  const kioskProducts = catalog.catalog("KIOSK").flatMap((category) => category.products);
  const canonicalIds = new Set(SAGA_POS_PRODUCTS.map((product) => product.id));
  const canonicalProducts = kioskProducts.filter((product) => canonicalIds.has(product.id));
  if (canonicalProducts.length !== CATALOG_PREVIEW_PRODUCT_COUNT || canonicalProducts.some((product) => !product.available)) {
    throw new Error("catalog_preview_verification_failed");
  }
  const nextSnapshot = catalog.exportState();
  if (nextSnapshot.orderingSettings.paused !== true) throw new Error("catalog_preview_ordering_must_remain_paused");

  return {
    changed: catalog.version !== versionBefore,
    versionBefore,
    versionAfter: catalog.version,
    productCount: canonicalProducts.length,
    orderingPaused: true,
    snapshot: nextSnapshot,
  };
}

function adminProduct(catalog, productId) {
  return catalog.catalog("ADMIN").flatMap((category) => category.products).find((product) => product.id === productId);
}
