export const DUMMY_CATALOG_CONTENT_VERSION = "KOPI_SAGA_DUMMY_V1";
export const DUMMY_CATALOG_CONTENT_UPDATED_AT = "2026-09-23T00:00:00.000Z";
export const DUMMY_CATALOG_CONTENT_DISCLAIMER = "Konten, alergen, dan nutrisi ini adalah data preview untuk uji UI. Wajib diganti atau disetujui dari resep operasional sebelum menjadi informasi pelanggan final.";

const ROWS = [
  ["americano","Kopi hitam yang bersih, ringan, dan lugas.","Bold|Clean|Roasted","Belum diverifikasi","cafe-latte|es-kopi-saga",10,0,.5,0,120,250],
  ["cafe-latte","Espresso lembut dengan susu yang creamy.","Creamy|Balanced|Milky","Susu (perkiraan)","cappucino|matcha",150,10,7,7,100,300],
  ["cappucino","Kopi susu bertekstur lembut dengan foam ringan.","Foamy|Creamy|Roasted","Susu (perkiraan)","cafe-latte|moccacino",130,9,7,5,100,300],
  ["moccacino","Kopi cokelat yang creamy dan nyaman diminum.","Chocolate|Creamy|Rich","Susu (perkiraan)","chocolate|cafe-latte",230,22,7,9,95,300],
  ["es-kopi-saga","Es kopi susu dengan sentuhan manis gula aren.","Palm Sugar|Creamy|Signature","Susu (perkiraan)","saga-premiyum|cafe-latte",220,24,6,8,100,300],
  ["saga-premiyum","Kopi susu kaya rasa dengan sentuhan karamel.","Caramel|Rich|Creamy","Susu (perkiraan)","es-kopi-saga|moccacino",260,28,6,11,110,300],
  ["magnosiyum","Kopi creamy dengan nuansa berry yang lembut.","Berry|Creamy|Fruity","Susu (perkiraan)","saga-premiyum|red-velvet",250,26,5,10,90,300],
  ["matcha","Matcha creamy dengan rasa earthy yang lembut.","Earthy|Creamy|Smooth","Susu (perkiraan)","chocolate|red-velvet",180,18,6,7,35,300],
  ["chocolate","Cokelat dingin yang pekat dan creamy.","Cocoa|Rich|Creamy","Susu (perkiraan)","moccacino|red-velvet",240,25,7,10,5,300],
  ["red-velvet","Minuman creamy dengan nuansa kakao yang ringan.","Sweet|Creamy|Cocoa","Susu (perkiraan)","chocolate|matcha",230,24,6,9,0,300],
  ["brr-patabim","Mocktail berry-lime yang segar dan berkilau.","Berry|Citrus|Sparkling","Belum diverifikasi","range-bliss|tralalelow",120,26,0,0,0,350],
  ["tralalelow","Mocktail tropis dengan rasa buah yang ceria.","Tropical|Guava|Sparkling","Belum diverifikasi","oyen-sunkist|brr-patabim",130,29,0,0,0,350],
  ["si-biyu","Mocktail citrus biru yang ringan dan menyegarkan.","Citrus|Light|Sparkling","Belum diverifikasi","mohito|range-bliss",115,25,0,0,0,350],
  ["oyen-sunkist","Soda jeruk dengan rasa citrus yang cerah.","Orange|Citrus|Sparkling","Belum diverifikasi","range-bliss|lemon-ti",140,32,0,0,0,350],
  ["mohito","Soda lime dan mint yang ringan tanpa alkohol.","Lime|Mint|Sparkling","Belum diverifikasi","si-biyu|lemon-ti",100,22,0,0,0,350],
  ["range-bliss","Soda grapefruit-orange dengan rasa asam-manis.","Grapefruit|Orange|Sparkling","Belum diverifikasi","oyen-sunkist|brr-patabim",125,28,0,0,0,350],
  ["lychee-ti","Teh leci yang harum, ringan, dan menyegarkan.","Lychee|Floral|Refreshing","Belum diverifikasi","lemon-ti|tralalelow",120,26,0,0,25,350],
  ["lemon-ti","Teh lemon dengan rasa citrus yang segar.","Lemon|Citrus|Refreshing","Belum diverifikasi","lychee-ti|mohito",90,20,0,0,25,350],
  ["creamcheese-bagel","Bagel lembut dengan isian cream cheese gurih.","Savory|Creamy|Toasted","Gluten (perkiraan)|Susu (perkiraan)","ham-fresh-bagel|moka-bagel",360,7,11,16,null,null],
  ["strawberry-bagel","Bagel manis dengan rasa stroberi yang fruity.","Strawberry|Sweet|Toasted","Gluten (perkiraan)|Susu (perkiraan)","moka-bagel|creamcheese-bagel",340,18,9,11,null,null],
  ["ham-fresh-bagel","Bagel gurih dengan ham dan isian segar.","Savory|Fresh|Toasted","Gluten (perkiraan)|Susu (perkiraan)","creamcheese-bagel|moka-bagel",430,6,20,19,null,null],
  ["moka-bagel","Bagel manis dengan nuansa moka yang lembut.","Mocha|Sweet|Toasted","Gluten (perkiraan)|Susu (perkiraan)","strawberry-bagel|creamcheese-bagel",390,20,10,15,20,null],
];

export const DUMMY_CATALOG_CONTENT = Object.freeze(ROWS.map(([productId, shortDescription, tags, allergens, alternatives, caloriesKcal, sugarG, proteinG, fatG, caffeineMg, servingMl]) => Object.freeze({
  productId,
  contentStatus: "DUMMY_PREVIEW_ONLY",
  disclaimer: DUMMY_CATALOG_CONTENT_DISCLAIMER,
  catalogDetails: Object.freeze({
    shortDescription,
    description: `${shortDescription} Deskripsi ini masih berupa copy dummy untuk memvalidasi alur dan tampilan katalog.`,
    profileTags: Object.freeze(tags.split("|")),
    allergens: Object.freeze(allergens.split("|")),
    badges: Object.freeze(["Preview"]),
    alternativeProductIds: Object.freeze(alternatives.split("|")),
    nutritionEstimate: Object.freeze({ caloriesKcal, sugarG, proteinG, fatG, ...(caffeineMg == null ? {} : { caffeineMg }), ...(servingMl == null ? {} : { servingMl }), sourceUpdatedAt: DUMMY_CATALOG_CONTENT_UPDATED_AT }),
  }),
})));

export const DUMMY_CATALOG_CONTENT_BY_PRODUCT = new Map(DUMMY_CATALOG_CONTENT.map((item) => [item.productId, item]));

export function stageDummyCatalogContent(catalog, { actorId = "SYSTEM-DUMMY-PREVIEW", reason = "Isi data dummy katalog untuk preview UI" } = {}) {
  if (!catalog?.catalog || !catalog?.updateProduct || !catalog?.beginWorkspace) throw new Error("catalog_dummy_target_invalid");
  catalog.beginWorkspace();
  const products = new Map(catalog.catalog("ADMIN").flatMap((category) => category.products).map((product) => [product.id, product]));
  const changedProductIds = [];
  for (const record of DUMMY_CATALOG_CONTENT) {
    const product = products.get(record.productId);
    if (!product) throw new Error(`catalog_dummy_product_missing:${record.productId}`);
    const result = catalog.updateProduct({ productId: product.id, name: product.name, priceRupiah: product.priceRupiah, categoryId: product.categoryId, station: product.station, status: product.status, sortRank: product.sortRank ?? 0, catalogDetails: structuredClone(record.catalogDetails), expectedVersion: catalog.version, actorId, reason });
    if (!result.unchanged) changedProductIds.push(product.id);
  }
  return { contentVersion: DUMMY_CATALOG_CONTENT_VERSION, dummy: true, productCount: DUMMY_CATALOG_CONTENT.length, changedProductIds, version: catalog.version, disclaimer: DUMMY_CATALOG_CONTENT_DISCLAIMER };
}
