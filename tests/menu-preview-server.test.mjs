import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createPosAlphaServer } from "../src/pos-alpha/server.mjs";
import { PosVerticalSliceRuntime } from "../src/pos-alpha/vertical-slice-runtime.mjs";

async function fixture(t) {
  const clock = () => new Date("2026-09-22T06:00:00.000Z");
  const runtime = new PosVerticalSliceRuntime({ clock });
  const app = createPosAlphaServer({ runtime, clock });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  return { ...app, runtime, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("menu preview is a server-authoritative read-only catalog with no commerce capabilities", async (t) => {
  const app = await fixture(t);
  const page = await fetch(`${app.baseUrl}/menu`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /E-CATALOGUE/);

  for (const route of ["/menu/qr", "/menu/kiosk", "/menu/promo", "/menu/member"]) {
    const surface = await fetch(`${app.baseUrl}${route}`);
    assert.equal(surface.status, 200, `${route} is an explicit public menu entry point`);
  }

  const publicAssetModule = await fetch(`${app.baseUrl}/menu-product-assets.js`);
  assert.equal(publicAssetModule.status, 200, "anonymous catalogue loads its asset manifest outside the protected kiosk path");
  assert.match(publicAssetModule.headers.get("content-type"), /^text\/javascript/);

  const response = await fetch(`${app.baseUrl}/api/menu/catalog`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.surfaceMode, "CATALOG_PREVIEW");
  assert.equal(payload.readOnly, true);
  assert.deepEqual(payload.capabilities, { cart: false, quote: false, checkout: false, payment: false, tableIdentity: false, kdsDispatch: false });
  assert.equal(payload.productCount, 22);
  assert.equal(payload.catalog.flatMap((category) => category.products).length, 22);
  assert.equal(payload.member.mode, "HANDOFF_ONLY");
  assert.equal(payload.member.personalized, false);
  assert.equal(payload.presentation.priceFormat, "THOUSANDS_K_NO_CURRENCY_SYMBOL");
  assert.equal(payload.presentation.nutritionLabel, "Estimasi Resep");
  assert.equal(payload.store.browsingAvailable, true);
  assert.ok(Array.isArray(payload.promotions));
  assert.ok(Number.isInteger(payload.freshness.publishedRevision));
  assert.equal(payload.context.paymentMode, "OFF");
  assert.equal(Object.hasOwn(payload, "csrfToken"), false);
  assert.equal(Object.hasOwn(payload, "table"), false);

  const rejectedQuery = await fetch(`${app.baseUrl}/api/menu/catalog?outlet=other`);
  assert.equal(rejectedQuery.status, 422, "client cannot select an outlet or tenant");
  const rejectedWrite = await fetch(`${app.baseUrl}/api/menu/catalog`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(rejectedWrite.status, 404, "catalog surface exposes no write verb");
});

test("menu preview client contains no checkout, order, payment, or KDS mutation call", async () => {
  const source = await readFile(new URL("../public/pos-alpha/menu-preview.js", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/menu\/catalog"/);
  assert.match(source, /from "\/menu-product-assets\.js"/);
  assert.doesNotMatch(source, /from "\/kiosk\//);
  assert.doesNotMatch(source, /method:\s*["']POST["']/i);
  assert.doesNotMatch(source, /\/api\/(?:table|kiosk|cashier)\/(?:quote|checkouts|payments)/);
  assert.doesNotMatch(source, /\/api\/operator\/fulfillment/);
});


test("public customization labels and price deltas match the canonical catalog",async t=>{
 const app=await fixture(t);
 const source=app.runtime.catalogPricing.catalog('KIOSK').flatMap(c=>c.products);
 const payload=await(await fetch(`${app.baseUrl}/api/menu/catalog`)).json();
 let groups=0;
 for(const product of payload.catalog.flatMap(c=>c.products)){
  const original=source.find(p=>p.id===product.id);
  const expected=[...(original.variantGroups??[]),...(original.modifierGroups??[])];
  assert.equal(product.customizations.length,expected.length);
  product.customizations.forEach((group,index)=>{
   groups++;assert.ok(typeof group.name==='string'&&group.name.trim());
   assert.equal(group.name,expected[index].label??expected[index].name);
   group.options.forEach((option,i)=>{assert.ok(typeof option.name==='string'&&option.name.trim());assert.equal(option.priceDeltaRupiah,Number(expected[index].options[i].priceDeltaRupiah??expected[index].options[i].priceRupiah??0));});
  });
 }
 assert.ok(groups>0);
});

test("customization serialization respects canonical minimum and legacy fallbacks",async t=>{
 const app=await fixture(t);
 app.runtime.catalogPricing.catalog=()=>[{id:'fixture',name:'Fixture',products:[{id:'fixture-product',name:'Fixture',priceRupiah:10000,variantGroups:[
  {label:'Canonical',name:'Old',min:1,minSelections:0,options:[{label:'Canonical option',name:'Old option',priceDeltaRupiah:2000,priceRupiah:3000}]},
  {name:'Legacy',minSelections:1,options:[{name:'Legacy option',priceRupiah:1500}]},
  {label:'Optional',min:0,minSelections:1,options:[]},
  {label:'Explicit',min:0,required:true,options:[]}
 ]}]}];
 const payload=await(await fetch(`${app.baseUrl}/api/menu/catalog`)).json();
 assert.deepEqual(payload.catalog[0].products[0].customizations,[
  {name:'Canonical',required:true,options:[{name:'Canonical option',priceDeltaRupiah:2000}]},
  {name:'Legacy',required:true,options:[{name:'Legacy option',priceDeltaRupiah:1500}]},
  {name:'Optional',required:false,options:[]},
  {name:'Explicit',required:true,options:[]}
 ]);
});
