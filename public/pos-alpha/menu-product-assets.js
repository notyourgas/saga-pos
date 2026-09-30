const REVIEWED_CANDIDATE_ASSETS = Object.freeze({
  americano: "/assets/menu/v1/americano-v1.svg",
  "cafe-latte": "/assets/menu/v1/cafe-latte-v1.svg",
  cappucino: "/assets/menu/v1/cappucino-v2.svg",
  moccacino: "/assets/menu/v1/moccacino-v2.svg",
  matcha: "/assets/menu/v1/matcha-v1.svg",
  chocolate: "/assets/menu/v1/chocolate-v1.svg",
  "red-velvet": "/assets/menu/v1/red-velvet-v1.svg",
  "lychee-ti": "/assets/menu/v1/lychee-ti-v1.svg",
  "lemon-ti": "/assets/menu/v1/lemon-ti-v1.svg",
});

const ILLUSTRATIVE_DUMMY_ASSETS = Object.freeze({
  "es-kopi-saga": "/assets/menu/v2/es-kopi-saga-dummy-v1.svg",
  "saga-premiyum": "/assets/menu/v2/saga-premiyum-dummy-v1.svg",
  magnosiyum: "/assets/menu/v2/magnosiyum-dummy-v1.svg",
  "brr-patabim": "/assets/menu/v2/brr-patabim-dummy-v1.svg",
  tralalelow: "/assets/menu/v2/tralalelow-dummy-v1.svg",
  "si-biyu": "/assets/menu/v2/si-biyu-dummy-v1.svg",
  "oyen-sunkist": "/assets/menu/v2/oyen-sunkist-dummy-v1.svg",
  mohito: "/assets/menu/v2/mohito-dummy-v1.svg",
  "range-bliss": "/assets/menu/v2/range-bliss-dummy-v1.svg",
  "creamcheese-bagel": "/assets/menu/v3/creamcheese-bagel-dummy-v1.svg",
  "strawberry-bagel": "/assets/menu/v3/strawberry-bagel-dummy-v1.svg",
  "ham-fresh-bagel": "/assets/menu/v3/ham-fresh-bagel-dummy-v1.svg",
  "moka-bagel": "/assets/menu/v3/moka-bagel-dummy-v1.svg",
});

const MENU_ASSETS = Object.freeze({ ...REVIEWED_CANDIDATE_ASSETS, ...ILLUSTRATIVE_DUMMY_ASSETS });

export const PRODUCT_ASSET_REVIEW_STATUS = Object.freeze({
  candidateProductIds: Object.freeze(Object.keys(REVIEWED_CANDIDATE_ASSETS)),
  illustrativeDummyProductIds: Object.freeze(Object.keys(ILLUSTRATIVE_DUMMY_ASSETS)),
  fallbackProductIds: Object.freeze([]),
});

export function productAssetPath(productId) {
  return MENU_ASSETS[String(productId || "")] || "";
}
