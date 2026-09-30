export const SAGA_POS_MENU = Object.freeze([
  category("classic", "Classic", [
    product("americano", "Americano", 13_000),
    product("cafe-latte", "Cafe Latte", 15_000),
    product("cappucino", "Cappucino", 15_000),
    product("moccacino", "Moccacino", 18_000),
  ]),
  category("kupsus", "Kupsus", [
    product("es-kopi-saga", "Es Kopi Saga", 18_000),
    product("saga-premiyum", "Saga Premiyum", 20_000),
    product("magnosiyum", "Magnosiyum", 22_000),
  ]),
  category("nonkop", "Nonkop", [
    product("matcha", "Matcha", 16_000),
    product("chocolate", "Chocolate", 16_000),
    product("red-velvet", "Red Velvet", 16_000),
  ]),
  category("mocktail", "Mocktail", [
    product("brr-patabim", "Brr Patabim", 20_000),
    product("tralalelow", "Tralalelow", 16_000),
    product("si-biyu", "Si Biyu", 16_000),
    product("oyen-sunkist", "Oyen Sunkist", 18_000),
  ]),
  category("soda", "Soda", [
    product("mohito", "Mohito", 16_000),
    product("range-bliss", "Range Bliss", 16_000),
  ]),
  category("tea", "Tea", [
    product("lychee-ti", "Lychee Ti", 15_000),
    product("lemon-ti", "Lemon Ti", 15_000),
  ]),
  category("bagel", "Bagel", [
    product("creamcheese-bagel", "Creamcheese Bagel", 18_000, { customizationProfile: "none" }),
    product("strawberry-bagel", "Strawberry Bagel", 20_000, { customizationProfile: "none" }),
    product("ham-fresh-bagel", "Ham & Fresh Bagel", 25_000, { customizationProfile: "none" }),
    product("moka-bagel", "Moka Bagel", 20_000, { customizationProfile: "none" }),
  ]),
]);

export const SAGA_POS_PRODUCTS = Object.freeze(
  SAGA_POS_MENU.flatMap((item) => item.products),
);

function category(id, name, products) {
  return Object.freeze({ id, name, products: Object.freeze(products) });
}

function product(id, name, priceRupiah, { customizationProfile = "beverage" } = {}) {
  return Object.freeze({
    id,
    name,
    priceRupiah,
    status: "active",
    inventoryMode: "untracked",
    station: customizationProfile === "none" ? "food" : "bar",
    customizationProfile,
  });
}
