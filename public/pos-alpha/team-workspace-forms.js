const text = (name,label,type='text') => ({name,label,type});
const choice = (name,label,options) => ({name,label,options});
export function workspaceForms(feature,data) {
  const materials=(data.ingredients?.items??[]).map(i=>[i.id,i.name]);
  const staff=(data.staff??[]).map(i=>[i.id,i.name]);
  const menu=(data.hpp?.menus??[]).map(i=>[i.productId,i.name??i.productName]);
  return ({
    inventory:[
      {action:'ingredient.upsert',permission:'inventory.write',label:'Tambah bahan',fields:[text('code','Kode bahan'),text('name','Nama bahan'),text('category','Kategori'),text('baseUnit','Satuan dasar')],payload:v=>({...v,purchasable:true})},
      {action:'warehouse.movement.record',permission:'inventory.write',label:'Catat bahan terbuang',fields:[choice('ingredientId','Bahan',materials),choice('movementType','Jenis',[['SPOILAGE_WASTE','Rusak / kedaluwarsa'],['PRODUCTION_WASTE','Terbuang saat produksi'],['INTERNAL_USE','Pemakaian internal']]),text('quantityBase','Jumlah dalam satuan dasar','number')],payload:v=>({...v,idempotencyKey:crypto.randomUUID()})},
    ],
    purchasing:[
      {action:'hpp.supplier.upsert',permission:'purchasing.write',label:'Tambah supplier',fields:[text('name','Nama supplier'),text('leadTimeDays','Waktu pengiriman (hari)','number')],payload:v=>({...v})},
      {action:'warehouse.receipt.post',permission:'purchasing.write',label:'Terima barang',fields:[text('supplierName','Nama supplier'),choice('ingredientId','Bahan',materials),text('packageLabel','Nama kemasan'),text('purchaseUom','Satuan beli'),text('purchaseQuantity','Jumlah diterima','number'),text('totalCostRupiah','Total biaya (Rp)','number')],payload:v=>({idempotencyKey:crypto.randomUUID(),supplierName:v.supplierName,lines:[{ingredientId:v.ingredientId,packageLabel:v.packageLabel,purchaseUom:v.purchaseUom,purchaseQuantity:v.purchaseQuantity,totalCostRupiah:v.totalCostRupiah}]})},
    ],
    hpp:[
      {action:'hpp.draft-line.upsert',permission:'hpp.write',label:'Tambah / ubah bahan resep',fields:[choice('productId','Menu',menu),choice('ingredientId','Bahan',materials),text('quantity','Jumlah','number'),text('uom','Satuan'),text('yieldPct','Hasil bersih (%)','number')],payload:v=>({...v})},
      {action:'hpp.draft.publish',permission:'hpp.approve',label:'Setujui resep',fields:[choice('productId','Menu',menu)],payload:v=>({...v})},
    ],
    catalog:[
      {action:'catalog.product.create',permission:'catalog.write',label:'Tambah menu',fields:[text('name','Nama menu'),text('priceRupiah','Harga (Rp)','number'),choice('categoryId','Kategori',(data.catalog??[]).map(c=>[c.id,c.name]))],payload:v=>({...v})},
    ],
    hr:[
      {action:'schedule.create',permission:'hr.write',label:'Jadwalkan staf',fields:[choice('staffId','Staf',staff),text('name','Nama shift'),text('startAt','Mulai','datetime-local'),text('endAt','Selesai','datetime-local')],payload:v=>({...v})},
      {action:'request.review',permission:'hr.approve',label:'Review permohonan',fields:[choice('requestId','Permohonan',(data.requests??[]).filter(r=>['submitted','peer_accepted'].includes(r.state)&&(r.category!=='shift_swap'||r.state==='peer_accepted')).map(r=>[r.id,`${r.category} · ${r.reason??''}`])),choice('decision','Keputusan',[['approved','Setujui'],['rejected','Tolak']]),text('note','Catatan keputusan')],payload:v=>({...v})},
    ],
    payroll:[
      {action:'rate.save',permission:'payroll.write',label:'Atur tarif staf',fields:[choice('staffId','Staf',(data.staff??[]).map(r=>[r.id,r.name])),choice('rateType','Dasar tarif',[['per_hour','Per jam'],['per_shift','Per shift']]),text('amountRupiah','Tarif (Rp)','number')],payload:v=>({...v,expectedUpdatedAt:data.staff.find(s=>s.id===v.staffId)?.payRateUpdatedAt})},
    ],
    finance:[
      {action:'payment.settlement.review',permission:'finance.approve',label:'Rekonsiliasi pembayaran',fields:[text('paymentId','Nomor pembayaran'),choice('decision','Keputusan',[['SETTLED','Sudah masuk'],['ISSUE','Perlu diperiksa']]),text('expectedStatus','Status saat ini'),text('providerFeeRupiah','Biaya provider (Rp)','number'),text('netSettlementRupiah','Uang masuk bersih (Rp)','number'),text('evidenceReference','Referensi bukti')],payload:v=>({...v})},
      {action:'invoice.approve',permission:'finance.approve',label:'Review invoice supplier',fields:[choice('purchaseInvoiceId','Invoice',(data.accountsPayable?.invoices??[]).map(i=>[i.id,i.invoiceNumber??i.id])),choice('decision','Keputusan',[['APPROVED','Setujui'],['REJECTED','Tolak']])],payload:v=>({...v})},
    ],
  })[feature]??[];
}
