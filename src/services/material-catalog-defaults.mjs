export const MATERIAL_CATEGORY_STORAGE_TYPES = Object.freeze(["AMBIENT", "CHILLED", "FROZEN"]);
export const MATERIAL_CATEGORY_BASE_UNITS = Object.freeze(["gram", "ml", "pcs"]);

const rows = [
  ["coffee", "Kopi", "KOP", "gram", "AMBIENT", true],
  ["dairy", "Susu & Dairy", "SUS", "ml", "CHILLED", true],
  ["plant-milk", "Susu Nabati", "NAB", "ml", "AMBIENT", true],
  ["tea", "Teh", "TEH", "gram", "AMBIENT", true],
  ["chocolate-cocoa", "Cokelat & Kakao", "CKL", "gram", "AMBIENT", true],
  ["matcha", "Matcha", "MTC", "gram", "AMBIENT", true],
  ["beverage-powder", "Bubuk Minuman", "BUB", "gram", "AMBIENT", true],
  ["syrup-flavour", "Sirup & Perisa", "SIR", "ml", "AMBIENT", true],
  ["sweetener", "Gula & Pemanis", "GUL", "gram", "AMBIENT", true],
  ["fresh-fruit", "Buah Segar", "BUA", "gram", "CHILLED", true],
  ["puree-concentrate", "Puree & Konsentrat", "PUR", "ml", "CHILLED", true],
  ["juice-base", "Jus & Minuman Dasar", "JUS", "ml", "AMBIENT", true],
  ["water", "Air", "AIR", "ml", "AMBIENT", true],
  ["ice", "Es", "ICE", "gram", "FROZEN", false],
  ["topping-garnish", "Topping & Garnish", "TOP", "gram", "CHILLED", true],
  ["sauce-spread", "Saus & Spread", "SAU", "gram", "CHILLED", true],
  ["bread-bakery", "Roti & Bakery", "ROT", "pcs", "AMBIENT", true],
  ["flour-baking", "Tepung & Baking", "TPG", "gram", "AMBIENT", true],
  ["egg", "Telur", "TLR", "pcs", "CHILLED", true],
  ["cheese", "Keju", "KEJ", "gram", "CHILLED", true],
  ["fat-oil", "Mentega & Lemak", "LMA", "gram", "CHILLED", true],
  ["protein", "Daging & Protein", "PRT", "gram", "FROZEN", true],
  ["vegetable-herb", "Sayur & Herbal", "SAY", "gram", "CHILLED", true],
  ["seasoning-condiment", "Bumbu & Kondimen", "BUM", "gram", "AMBIENT", true],
  ["frozen-food", "Frozen Food", "FRZ", "pcs", "FROZEN", true],
  ["semi-finished", "Bahan Setengah Jadi", "SET", "gram", "CHILLED", true],
  ["ready-to-sell", "Makanan Siap Jual", "SIJ", "pcs", "CHILLED", true],
  ["drink-packaging", "Kemasan Minuman", "KMM", "pcs", "AMBIENT", false],
  ["food-packaging", "Kemasan Makanan", "KMF", "pcs", "AMBIENT", false],
  ["cutlery-straw", "Sedotan & Alat Makan", "ALM", "pcs", "AMBIENT", false],
  ["tissue-napkin", "Tisu & Napkin", "TSU", "pcs", "AMBIENT", false],
  ["label-sticker", "Label & Stiker", "LBL", "pcs", "AMBIENT", false],
  ["cleaning", "Bahan Kebersihan", "BRS", "pcs", "AMBIENT", true],
  ["operations", "Perlengkapan Operasional", "OPS", "pcs", "AMBIENT", false],
  ["fuel-gas", "Gas & Bahan Bakar", "GAS", "pcs", "AMBIENT", false],
  ["merchandise", "Barang Dagangan", "DAG", "pcs", "AMBIENT", false],
  ["other", "Lainnya", "OTH", "pcs", "AMBIENT", false],
];

export const CAFE_MATERIAL_CATEGORIES = Object.freeze(rows.map(([id, name, prefix, suggestedBaseUnit, storageType, expiryTracking], index) => Object.freeze({
  id,
  name,
  prefix,
  suggestedBaseUnit,
  storageType,
  expiryTracking,
  status: "ACTIVE",
  isDefault: true,
  sortOrder: index + 1,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  revision: 0,
})));

export function defaultMaterialCategories() {
  return structuredClone(CAFE_MATERIAL_CATEGORIES);
}
