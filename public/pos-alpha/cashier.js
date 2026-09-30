import { cashierCheckoutLocked, cashierQrisPresentation } from "./cashier/payment-confidence.js";
import { nextPaymentPollDelay } from "./ui/payment-poll.js";
import { createCartDraft, restoreCartDraft } from './ui/cart-draft.js';

const loginView = document.querySelector("#operator-login");
const appView = document.querySelector("#cashier-app");
const loginForm = document.querySelector("#login-form");
const loginStatus = document.querySelector("#login-status");
const productsView = document.querySelector("#cashier-products");
const categoriesView = document.querySelector("#cashier-categories");
const cartView = document.querySelector("#cashier-cart");
const checkoutButton = document.querySelector("#cashier-checkout");
const checkoutFields = document.querySelector(".checkout-fields");
const receivedInput = document.querySelector("#received-rupiah");
const tenderPanel = document.querySelector("#cash-tender-panel");
const tenderOptionsView = document.querySelector("#cash-tender-options");
const tenderStatus = document.querySelector("#cash-tender-status");
const quoteStatus = document.querySelector("#quote-status");
const assistedCashQueue = document.querySelector("#pending-cash-assists");
const syncStatus = document.querySelector("#cashier-sync-status");
const syncButton = document.querySelector("#cashier-sync-button");
const toast = document.querySelector("#global-status");
const searchInput = document.querySelector("#cashier-search");
let state;
let csrfToken = "";
let selectedCategory = "classic";
let quote = null;
let quoteSequence = 0;
let quoteTimer;
let pendingCheckout = null;
let activeQris = null;
let qrisPollTimer;
let catalogEvents;
let catalogEventsTimer;
const cart = new Map();
let queueStale = false;
let itemEdit = null;
let workspaceKey = '';
let workspace = { version: 1, active: null, drafts: [], attempt: null };
let workspaceReady = false;
let storageFailed = false;
let recoveryBusy = false;
let lastResult = null;
let checkoutBusy = false;
let quoteFreshUntil = 0;
let benefits = { automaticPromotions:true };
const $ = selector => document.querySelector(selector);
function ownerDashboardHref(path = '/dashboard') {
  const target = new URL(path, location.href);
  if (document.body.dataset.production === 'true' && location.hostname === 'cashier.pos.example.invalid') target.hostname = 'dashboard.pos.example.invalid';
  return target.href;
}
$('.cashier-tools a[href="/dashboard"]').href = ownerDashboardHref();
const orderPage = $('#cashier-order-page');
const paymentPage = $('#cashier-payment-page');
const resultPage = $('#cashier-result-page');
const operationsDialog = $('#cashier-operations-dialog');
$('.cashier-tools nav').prepend(Object.assign(document.createElement('button'), {id:'cashier-expenses-open',className:'button button-secondary',textContent:'Pengeluaran kas'}),Object.assign(document.createElement('button'),{id:'cashier-receiving-open',className:'button button-secondary',textContent:'Terima barang'}));
$('#cashier-expenses-open').addEventListener('click', showExpenses);
$('#cashier-benefits-open').addEventListener('click', () => {
  if (paymentLocked()) return;
  const form=$('#cashier-benefits-form');form.reset();
  form.elements.promotionCode.value=benefits.promotionCode??'';form.elements.automatic.checked=benefits.automaticPromotions!==false;
  const manual=benefits.manualDiscount;
  form.elements.discountType.value=manual?.type??'';form.elements.discountValue.value=manual ? manual.type==='PERCENT'?manual.value/100:manual.value : '';
  form.elements.reason.value=manual?.reason??'';
  $('#cashier-manual-discount').disabled=false;
  $('#cashier-discount-request').hidden=state.actor.role==='owner';
  $('#cashier-discount-limit').textContent=state.actor.role==='owner' ? 'Owner dapat memberikan diskon dengan alasan.' : `Batas staf ${rupiah(state.manualDiscountStaffLimitRupiah)} per tagihan. Di atasnya memerlukan persetujuan Owner selama 15 menit.`;
  form.elements.productId.innerHTML='<option value="">Seluruh tagihan</option>'+[...new Map([...cart.values()].map(item=>[item.productId,item])).values()].map(item=>`<option value="${escapeHtml(item.productId)}">${escapeHtml(state.catalog.flatMap(c=>c.products).find(p=>p.id===item.productId)?.name??item.productId)}</option>`).join('');
  form.elements.productId.value=manual?.productId??'';updateDiscountInput(form);$('#cashier-benefits-status').textContent='';openDialog($('#cashier-benefits-dialog'));
});
function updateDiscountInput(form){const percent=form.elements.discountType.value==='PERCENT',value=form.elements.discountValue;value.step=percent?'0.01':'1';value.min=percent?'0.01':'1';if(percent)value.max='100';else value.removeAttribute('max');}
$('#cashier-benefits-form').elements.discountType.addEventListener('change',event=>updateDiscountInput(event.target.form));
function readBenefitForm(form) {
  const v=Object.fromEntries(new FormData(form));
  const manual=v.discountType ? {type:v.discountType,value:Math.round(Number(v.discountValue)*(v.discountType==='PERCENT'?100:1)),productId:v.productId||null,reason:v.reason} : null;
  const unchanged=JSON.stringify(manual)===JSON.stringify(benefits.manualDiscount);
  return {promotionCode:v.promotionCode.trim().toUpperCase()||undefined,automaticPromotions:form.elements.automatic.checked,manualDiscount:manual,...(manual && unchanged ? {discountOperationKey:benefits.discountOperationKey,discountAuthorizationId:benefits.discountAuthorizationId,discountRequestId:benefits.discountRequestId} : manual ? {discountOperationKey:`discount:${crypto.randomUUID()}`} : {})};
}
$('#cashier-discount-request').addEventListener('click',async event=>{
  if(paymentLocked())return;
  const button=event.target,previous=benefits;button.disabled=true;
  try {
    benefits=readBenefitForm($('#cashier-benefits-form'));
    const result=await request('/api/cashier/discount-approvals',{method:'POST',csrf:true,body:quotePayload()});
    benefits.discountRequestId=result.requestId;persistWorkspace();
    quote=null;quoteFreshUntil=0;renderQuote();
    $('#cashier-benefits-status').textContent='Permintaan tersimpan. Owner menyetujuinya di Menu & promo → Promo. Setelah disetujui, klik Terapkan & periksa. Perubahan pesanan membatalkan kecocokan persetujuan.';
  } catch(error){benefits=previous;$('#cashier-benefits-status').textContent=error.message;}
  finally{button.disabled=false;}
});
$('#cashier-benefits-form').addEventListener('submit', async event => {
  event.preventDefault();if(paymentLocked())return;
  const form=event.target,previous=benefits;
  benefits=readBenefitForm(form);
  const button=form.querySelector('[type=submit]');button.disabled=true;
  try {
    if(benefits.discountRequestId){const status=await request('/api/cashier/discount-approvals');const approved=status.requests.find(item=>item.requestId===benefits.discountRequestId);if(approved?.status==='AVAILABLE')benefits.discountAuthorizationId=approved.authorizationId;}
    const next=await request('/api/cashier/quote',{method:'POST',csrf:true,body:quotePayload()});quote=next;quoteFreshUntil=performance.now()+5*60_000;receivedInput.value='';++quoteSequence;clearTimeout(quoteTimer);renderQuote();persistWorkspace();$('#cashier-benefits-dialog').close();}
  catch(error){benefits=previous;$('#cashier-benefits-status').textContent=error.message;}
  finally{button.disabled=false;}
});
$('#cashier-benefits-remove').addEventListener('click',()=>{if(paymentLocked())return;benefits={automaticPromotions:false};$('#cashier-benefits-dialog').close();cartChanged();});
$('#cashier-receiving-open').addEventListener('click', showReceiving);
// Separate screens reuse the existing checkout controls and business handlers.
$('#cashier-cart-tools').prepend($('#order-type').closest('label'));
$('.cashier-scroll-region').append($('.cashier-member-fields'));
$('#cashier-payment-controls').append(checkoutFields, tenderPanel, checkoutButton);
resultPage.querySelector('footer').before($('#checkout-result'));
document.body.append($('#cashier-print-receipt'));
appView.addEventListener('click', event => { if (event.target.closest('[data-dialog-close]')) event.target.closest('dialog').close(); });
$('#cashier-pay').addEventListener('click', () => { renderQuote(); showScreen(paymentLocked() ? 'result' : 'payment'); });
$('#cashier-payment-back').addEventListener('click', () => showScreen('order'));
window.addEventListener('popstate', () => showScreen(location.hash.slice(1), true));
window.addEventListener('hashchange', () => {
  if (['payment','result','order',''].includes(location.hash.slice(1))) showScreen(location.hash.slice(1), true);
});
$('#order-type').addEventListener('change', () => { cartChanged(); });
$('#cashier-clear').addEventListener('click', async () => { if (!paymentLocked() && cart.size && await confirmAction('Kosongkan pesanan yang belum dibayar?')) { cart.clear(); cartChanged(); } });
$('#cashier-save-draft').addEventListener('click', saveDraft);
$('#cashier-drafts-open').addEventListener('click', showDrafts);
$('#cashier-history-open').addEventListener('click', showHistory);
$('#cashier-queue-open').addEventListener('click', () => { $('#cashier-list-title').textContent = 'Antrean pembayaran'; $('#cashier-list-content').replaceChildren(assistedCashQueue); openDialog($('#cashier-list-dialog')); });
$('#cashier-list-content').addEventListener('click', listAction);
$('#cashier-new-order').addEventListener('click', () => { if (paymentLocked()) return; activeQris = null; lastResult = null; workspace.resultOrderId = null; $('#checkout-result').hidden = true; render(); persistWorkspace(); showScreen('order', true); });
$('#cashier-print').addEventListener('click', () => printReceipt(lastResult));
$('#cashier-item-form').addEventListener('submit', saveItem);
$('#cashier-item-form').addEventListener('input', previewItem);
$('#cashier-item-form').addEventListener('click', event => {
  const button = event.target.closest('[data-item-qty]'); if (!button) return;
  const input = $('#cashier-item-form').elements.qty;
  input.value = Math.max(1, Math.min(20, (Number(input.value) || 1) + Number(button.dataset.itemQty))); previewItem();
});
$('#cashier-payment-methods').addEventListener('click', event => {
  const button = event.target.closest('[data-method]'); if (!button || button.disabled) return;
  $('#payment-method').value = button.dataset.method;
  $('#payment-method').dispatchEvent(new Event('change', {bubbles:true}));
});
$('#cashier-item-delete').addEventListener('click', async () => { if (itemEdit?.lineId && !paymentLocked() && await confirmAction('Hapus item ini dari pesanan?')) { cart.delete(itemEdit.lineId); $('#cashier-item-dialog').close(); cartChanged(); } });
$('#cashier-shift-body').addEventListener('click', shiftAction);
$('#shift-panel').addEventListener('click', event => { if (event.target.closest('[data-shift-dialog]')) { renderShiftDialog(); openDialog($('#cashier-shift-dialog')); } });
window.addEventListener('offline', () => { markQueueStale('Offline · pembayaran ditahan. Draft tetap di tablet.'); renderQuote(); });
window.addEventListener('online', () => refresh().catch(() => markQueueStale()));
window.addEventListener('beforeunload', event => { if (storageFailed && (cart.size || workspace.attempt)) { event.preventDefault(); event.returnValue = ''; } });

loginForm.addEventListener("submit", login);
if (!document.body.dataset.production) document.querySelector('#cashier-login-fields').disabled = false;
searchInput.addEventListener('input', renderCatalog);
document.querySelector('#cashier-search-clear').addEventListener('click', () => { searchInput.value = ''; renderCatalog(); searchInput.focus(); });
document.querySelector("#logout-button").addEventListener("click", logout);
document.querySelector("#payment-method").addEventListener("change", () => { receivedInput.value = ""; scheduleQuote(); persistWorkspace(); });
appView.addEventListener("input", (event) => {
  if (event.target === receivedInput) { renderTenderState(); persistWorkspace(); }
  else if (['member-code','reward-id'].includes(event.target.id)) { scheduleQuote(); persistWorkspace(); }
});
appView.addEventListener("change", (event) => {
  if (['member-code','reward-id'].includes(event.target.id)) { scheduleQuote(); persistWorkspace(); }
});
document.querySelector("#shift-panel").addEventListener("click", shiftAction);
categoriesView.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (button) { selectedCategory = button.dataset.category; renderCatalog(); }
});
categoriesView.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...categoriesView.querySelectorAll('[data-category]')], index = tabs.indexOf(event.target);
  if (index < 0 || !tabs.length) return; event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (index+(event.key === 'ArrowRight' ? 1 : -1)+tabs.length)%tabs.length;
  selectedCategory = tabs[next].dataset.category; renderCatalog(); categoriesView.querySelector('[aria-selected=true]').focus();
});
productsView.addEventListener("click", (event) => {
  const button = event.target.closest("[data-product]");
  if (!button || button.disabled) return;
  openItem(button.dataset.product);
});
cartView.addEventListener("click", (event) => {
  const edit = event.target.closest('[data-cart-edit]');
  if (edit) { const line = cart.get(edit.dataset.cartEdit); if (line) openItem(line.productId, line.id); return; }
  const button = event.target.closest("[data-cart-action]");
  if (!button || paymentLocked()) return;
  const delta = button.dataset.cartAction === "add" ? 1 : -1;
  const line = cart.get(button.dataset.line);
  if (!line) return;
  const next = line.qty + delta;
  if (next < 1) { confirmAction('Hapus item ini?').then(ok => { if (ok && !paymentLocked()) { cart.delete(line.id); cartChanged(); } }); return; }
  if (next > 20) return;
  line.qty = next;
  cartChanged();
});
tenderOptionsView.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tender]");
  if (!button) return;
  receivedInput.value = button.dataset.tender;
  renderTenderState();
  persistWorkspace();
});
checkoutButton.addEventListener("click", checkout);
document.querySelector("#checkout-result").addEventListener("click", settleQris);
assistedCashQueue.addEventListener("click", handleAssistedCashQueue);
syncButton.addEventListener("click", refreshQueue);
$('#cashier-queue-refresh').addEventListener("click", refreshQueue);
async function refreshQueue() {
  syncButton.disabled = true;
  $('#cashier-queue-refresh').disabled = true;
  markQueueStale("Memeriksa antrean…");
  try { await refresh(); }
  catch { /* refresh keeps the last snapshot visible and confirmation disabled */ }
  finally { syncButton.disabled = false; $('#cashier-queue-refresh').disabled = false; }
}

try { await refresh(); showApp(); } catch (error) { showLogin(error); }

async function login(event) {
  event.preventDefault(); loginStatus.textContent = "";
  try {
    const result = await request("/api/operator/login", { method: "POST", body: Object.fromEntries(new FormData(loginForm).entries()) });
    if (!isCashierActor(result.actor)) throw new Error("Gunakan identitas Cashier Mode.");
    await refresh(); showApp();
  } catch (error) { loginStatus.textContent = error.message; }
}

async function logout() {
  if (paymentLocked()) { announce('Pastikan status pembayaran sebelum keluar.', true); showScreen('result'); return; }
  await request("/api/operator/logout", { method: "POST", csrf: true });
  clearTimeout(qrisPollTimer);
  activeQris = null;
  const result = document.querySelector("#checkout-result");
  result.hidden = true;
  result.innerHTML = "";
  lastResult = null; pendingCheckout = null; quote = null; benefits={automaticPromotions:true};
  workspace = { version: 1, active: null, drafts: [], attempt: null };
  showScreen('order', true);
  state = null;
  workspaceReady = false; workspaceKey = ''; cart.clear();
  csrfToken = "";
  clearTimeout(catalogEventsTimer);
  catalogEvents?.close(); catalogEvents = null;
  showLogin();
}
function isCashierActor(actor) { return actor.role === 'cashier' || actor.role === 'owner'; }
async function refresh() {
  let nextState;
  try {
    nextState = await request("/api/operator/state?surface=cashier");
    if (!isCashierActor(nextState.actor)) throw new Error("Cashier role diperlukan.");
  } catch (error) {
    if (state && !appView.hidden) markQueueStale();
    throw error;
  }
  const catalogChanged = state && JSON.stringify(state.catalog) !== JSON.stringify(nextState.catalog);
  state = nextState;
  csrfToken = state.csrfToken;
  if (!workspaceReady) await restoreWorkspace();
  const delivery = document.querySelector('#delivery-persistence');
  if (delivery && state.context?.production) delivery.textContent = state.context.paymentMode === 'GATEWAY' ? 'Data tersimpan · mode gateway' : state.context.paymentMode === 'OFF' ? 'Data tersimpan · pembayaran nonaktif' : 'Data tersimpan · mode pembayaran belum terverifikasi';
  if (state.context?.production) {
    const qrisOption = document.querySelector('#payment-method option[value="QRIS"]');
    qrisOption.textContent = state.context.paymentMode === 'GATEWAY' ? 'QRIS' : 'QRIS belum tersedia';
    qrisOption.disabled = state.context.paymentMode !== 'GATEWAY';
  }
  const rewardSelect=$('#reward-id'),rewardUnavailable=state.context?.production || state.rewardRedemptionMode === 'NOT_CONNECTED';
  rewardSelect.disabled=Boolean(rewardUnavailable);
  for(const option of rewardSelect.options) if(option.value){option.hidden=Boolean(rewardUnavailable);option.disabled=Boolean(rewardUnavailable);}
  rewardSelect.options[0].textContent=rewardUnavailable?'Penukaran reward belum terhubung':'Tanpa Reward';
  if(rewardUnavailable && rewardSelect.value){rewardSelect.value='';quote=null;persistWorkspace();}
  queueStale = false;
  $('#payment-method option[value="QRIS_STATIC_MANUAL"]').disabled = !state.manualQrisAvailable || Boolean(state.permissions && !state.permissions.includes('qris.view'));
  if ($('#payment-method').selectedOptions[0]?.disabled && !paymentLocked()) { $('#payment-method').value = 'CASH'; receivedInput.value = ''; quote = null; }
  render();
  if (catalogChanged && cart.size) { receivedInput.value = ''; announce('Menu atau harga diperbarui. Periksa ulang ringkasan dan nominal pembayaran.',true); }
  if (cart.size && !paymentLocked() && (catalogChanged || !quote || performance.now() > quoteFreshUntil)) scheduleQuote();
  syncStatus.textContent = `Online · ${new Date().toLocaleTimeString("id-ID", { hour: '2-digit', minute: '2-digit' })}`;
}
function markQueueStale(message = "Koneksi gagal. Konfirmasi ditahan.") {
  queueStale = true;
  syncStatus.textContent = message;
  for (const button of assistedCashQueue.querySelectorAll("[data-assist-confirm], [data-static-confirm], [data-manual-confirm]")) button.disabled = true;
}
function showApp() { loginView.hidden = true; appView.hidden = false; document.querySelector("#actor-badge").textContent = `${state.actor.displayName} · ${state.actor.mode}`; showScreen(location.hash.slice(1), true); clearTimeout(catalogEventsTimer); catalogEventsTimer = window.setTimeout(connectCatalogEvents, 1500); }
function showLogin(error) {
  appView.hidden = true; loginView.hidden = false;
  const production = document.body.dataset.production === 'true';
  loginForm.hidden = production;
  const ownerLoginLink = document.querySelector('#owner-login-link');
  ownerLoginLink.hidden = !production;
  if (production) ownerLoginLink.href = ownerDashboardHref('/dashboard?next=%2Fcashier');
  if (production) request('/api/team/config').then(() => { $('#team-login-link').hidden = false; }).catch(() => {});
  document.querySelector('#cashier-bootstrap-status').textContent = error && error.status !== 401
    ? 'Kasir belum dapat memuat data. Coba muat ulang; tidak ada pembayaran yang diproses.'
    : production ? 'Gunakan login Owner yang sama dengan dashboard. Sesi aktif langsung membuka kasir.' : 'Masuk dengan akun kasir untuk melanjutkan.';
}
function connectCatalogEvents() {
  if (state?.permissions) { catalogEventsTimer=window.setTimeout(async()=>{try{await refresh();}catch{markQueueStale();}connectCatalogEvents();},15000);return; }
  if (catalogEvents || typeof EventSource === "undefined") return; catalogEvents = new EventSource("/api/catalog/events"); catalogEvents.addEventListener("catalog-revision", async () => { try { await refresh(); } catch { /* explicit queue refresh remains available */ } }); catalogEvents.onerror = () => { catalogEvents?.close(); catalogEvents = null; catalogEventsTimer = window.setTimeout(connectCatalogEvents, 5000); }; }
function render() {
  renderShift(); renderAssistedCashQueue(); renderCatalog(); renderCart(); renderQrisResult();
  if (state?.permissions) {
    const grants = state.permissions;
    document.querySelector('#shift-panel').hidden = !grants.includes('cash.view');
    document.querySelectorAll('#shift-panel button').forEach(el => { el.hidden = !grants.includes('cash.write'); });
    assistedCashQueue.hidden = !grants.includes('cash.view') && !grants.includes('qris.view');
    document.querySelectorAll('[data-assist-confirm]').forEach(el => { el.hidden = !grants.includes('cash.write'); });
    checkoutFields.hidden = !grants.includes('orders.write');
    checkoutButton.hidden = !grants.includes('orders.write') || !grants.includes('cash.write');
    document.querySelectorAll('[data-manual-confirm]').forEach(el => { el.hidden = !grants.includes('qris.approve'); });
    document.querySelector('#payment-method option[value="QRIS"]').disabled = true;
  }
  $('#cashier-expenses-open').hidden = Boolean(state.permissions && !state.permissions.includes('cash.view'));
  $('#cashier-receiving-open').hidden = state.actor.role !== 'owner' && !state.permissions?.includes('purchasing.view');
  renderPaymentMethods();
  renderTenderState();
}

function renderPaymentMethods() {
  const select = $('#payment-method');
  $('#cashier-payment-methods').innerHTML = [...select.options].map(option => `<button type="button" data-method="${escapeHtml(option.value)}" aria-pressed="${option.selected}" ${option.disabled ? 'disabled' : ''}>${escapeHtml(option.textContent)}${option.disabled ? '<small> · belum tersedia</small>' : ''}</button>`).join('');
}

function renderShift() {
  const panel = document.querySelector("#shift-panel");
  panel.innerHTML = state.shift?.status === 'open'
    ? `<span><strong>${escapeHtml(state.shift.shiftName)}</strong> · modal ${rupiah(state.shift.openingCashRupiah)}</span><button class="button button-secondary" data-shift-dialog>Hitung dan tutup shift</button>`
    : `<span>Shift belum dibuka · pembayaran terkunci</span><button class="button button-primary" data-shift-dialog>Buka shift</button>`;
  $('#cashier-queue-open').textContent = `Antrean pembayaran (${(state.pendingCashAssists?.length ?? 0) + (state.pendingManualQris?.length ?? 0)})`;
}

function renderShiftDialog() {
  $('#cashier-shift-body').innerHTML = state.shift?.status === 'open'
    ? `<form id="cash-close-form"><p>Hitung uang fisik sebelum menutup shift. Selisih tetap diperiksa sesuai izin.</p><label>Uang fisik yang dihitung (Rp)<input name="actualCashRupiah" type="number" min="0" step="1" required></label><label>Kas ditinggalkan (Rp)<input name="cashToLeaveRupiah" type="number" min="0" step="1" value="${state.shift.openingCashRupiah}" required></label><label>Catatan selisih<textarea name="note" maxlength="160"></textarea></label><p id="cash-close-status" role="alert"></p><button type="button" class="button button-primary" data-shift="close">Tutup shift</button></form>`
    : `<form id="cash-open-form">${state.shift?.status === 'closed' ? `<p>Kas ditinggalkan shift sebelumnya: <strong>${rupiah(state.shift.cashToLeaveRupiah)}</strong>. Hitung kembali sebelum serah terima.</p>` : '<p>Hitung uang modal yang benar-benar ada di laci.</p>'}<label>Nama shift<input name="shiftName" maxlength="60" value="Shift kasir" required></label><label>Modal awal kas (Rp)<input name="openingCashRupiah" type="number" min="0" step="1" required placeholder="Isi uang yang benar-benar tersedia"></label><label>Catatan serah terima / selisih<textarea name="note" maxlength="240"></textarea></label><p id="cash-close-status" role="alert"></p><button type="button" class="button button-primary" data-shift="open">Buka shift kas</button></form>`;
  if (state.shift?.status === 'open') {
    const c=state.cashControl;
    $('#cash-close-form').insertAdjacentHTML('afterbegin',`<dl class="cashier-cash-facts">${[['Modal',state.shift.openingCashRupiah],['Penjualan tunai',c?.shiftCashSalesRupiah],['Refund tunai',-(c?.shiftCashRefundsRupiah ?? 0)],['Pengeluaran laci',-(c?.shiftExpenseRupiah ?? 0)],['Kas seharusnya',c?.expectedCashRupiah],['Pengeluaran di luar laci',c?.nonCashExpenseRupiah]].map(([label,value])=>`<div><dt>${label}</dt><dd>${rupiah(value)}</dd></div>`).join('')}</dl><p>${state.pendingManualQris?.length ?? 0} QRIS manual belum diperiksa. QRIS tidak menambah uang laci.</p><p id="cash-close-preview" role="status"></p>`);
    if (state.pendingManualQris?.length || state.pendingCashAssists?.length) {
      const action = Object.assign(document.createElement('button'), {type:'button',className:'button button-secondary',textContent:'Periksa antrean sebelum closing'});
      action.addEventListener('click', () => { $('#cashier-shift-dialog').close(); $('#cashier-queue-open').click(); });
      $('#cash-close-preview').before(action);
    }
    $('#cash-close-form').addEventListener('input',event=>{const f=event.currentTarget;$('#cash-close-preview').textContent=f.elements.actualCashRupiah.value === '' ? 'Isi hitungan fisik.' : `Selisih: ${rupiah(Number(f.elements.actualCashRupiah.value)-(c?.expectedCashRupiah ?? 0))} · setoran: ${rupiah(Math.max(0,Number(f.elements.actualCashRupiah.value)-Number(f.elements.cashToLeaveRupiah.value)))}`;});
  }
  if (state.permissions && !state.permissions.includes('cash.write')) $('#cashier-shift-body').querySelector('[data-shift]').disabled = true;
}

function showExpenses() {
  $('#cashier-operations-title').textContent='Pengeluaran shift'; $('#cashier-operations-status').textContent='';
  const pending=workspace.expenseAttempt;
  const allowed=state.shift?.status === 'open' && (!state.permissions || state.permissions.includes('cash.write'));
  const approval=state.actor.role === 'owner' || (state.permissions?.includes('finance.approve') && state.permissions.includes('cash.write'));
  $('#cashier-operations-body').innerHTML=`<p>Uang laci mengurangi kas. Transfer Owner dan kas kecil terpisah tidak mengurangi laci. Penerimaan barang bukan otomatis pembayaran supplier.</p><form id="cashier-expense-form"><fieldset ${!allowed || pending ? 'disabled' : ''}><label>Nominal pengeluaran (Rp)<input name="amountRupiah" type="number" min="1" max="1000000000" step="1" required></label><label>Sumber uang<select name="source"><option value="cash_drawer">Laci kasir</option><option value="owner_transfer">Transfer Owner</option><option value="external_petty_cash">Kas kecil terpisah</option><option value="other">Dana luar laci lainnya</option></select></label><label>Kategori<input name="category" maxlength="80" required placeholder="Contoh: transport, kebersihan"></label><label>Keperluan<textarea name="reason" maxlength="240" required></textarea></label><label>Nomor nota / referensi bukti<input name="evidenceReference" maxlength="200" required></label></fieldset><button type="submit" class="button button-primary" ${!allowed ? 'disabled' : ''}>${pending ? 'Periksa / ulangi catatan yang sama' : 'Catat pengeluaran'}</button></form>${!allowed ? '<p>Buka shift dengan izin kas untuk mencatat pengeluaran.</p>' : ''}<h3>Riwayat shift ini</h3>${(state.expenses ?? []).map(e=>`<article class="cashier-list-row"><strong>${escapeHtml(e.category)} · ${rupiah(e.amountRupiah)}</strong><span>${escapeHtml(e.reason)} · ${escapeHtml(e.evidenceReference)} · ${e.source === 'cash_drawer' ? 'Laci' : 'Di luar laci'} · ${e.status === 'voided' ? 'Dibatalkan' : 'Tercatat'}</span>${allowed && approval && e.status === 'recorded' ? `<form data-expense-void="${escapeHtml(e.id)}"><label>Alasan koreksi<input name="reason" maxlength="240" required></label><button type="submit" class="button button-secondary">Batalkan catatan keliru</button></form>` : ''}</article>`).join('') || '<p>Belum ada pengeluaran pada shift ini.</p>'}`;
  const form=$('#cashier-expense-form');
  if(pending) for(const [key,value] of Object.entries(pending)) if(form.elements.namedItem(key)) form.elements.namedItem(key).value=value;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!form.reportValidity())return;const button=form.querySelector('button');button.disabled=true;
    try {
      const body=workspace.expenseAttempt ?? {...Object.fromEntries(new FormData(form)),cashSessionId:state.shift.id,idempotencyKey:crypto.randomUUID()};body.amountRupiah=Number(body.amountRupiah);
      workspace.expenseAttempt=body;if(!persistWorkspace())throw new Error('Penyimpanan tablet tidak tersedia; catatan belum dikirim.');
      await request('/api/cashier/expenses',{method:'POST',csrf:true,body});workspace.expenseAttempt=null;persistWorkspace();form.reset();await refresh();showExpenses();$('#cashier-operations-status').textContent='Pengeluaran tersimpan. Kas dan riwayat sudah diperbarui.';
    } catch(error) {$('#cashier-operations-status').textContent=`${error.message} Jangan membuat catatan baru jika status belum pasti; ulangi catatan yang sama.`;if(error.status>=400 && error.status<500){workspace.expenseAttempt=null;persistWorkspace();form.querySelector('fieldset').disabled=false;}}
    finally {button.disabled=false;}
  });
  for(const correction of $('#cashier-operations-body').querySelectorAll('[data-expense-void]')) correction.addEventListener('submit',async event=>{
    event.preventDefault();if(!correction.reportValidity())return;const button=correction.querySelector('button');button.disabled=true;
    try {await request('/api/cashier/expenses/void',{method:'POST',csrf:true,body:{expenseId:correction.dataset.expenseVoid,reason:correction.elements.reason.value}});await refresh();showExpenses();$('#cashier-operations-status').textContent='Catatan dibatalkan tanpa menghapus jejak. Masukkan catatan pengganti bila perlu.';}
    catch(error){$('#cashier-operations-status').textContent=error.message;button.disabled=false;}
  });
  openDialog(operationsDialog);
}

async function showReceiving() {
  $('#cashier-operations-title').textContent='Terima barang';$('#cashier-operations-body').textContent='Memuat bahan dan riwayat penerimaan…';$('#cashier-operations-status').textContent='';openDialog(operationsDialog);
  try {
    const team=Boolean(state.permissions);const snapshot=await request(team ? '/api/team/workspace/purchasing' : '/api/operator/inventory-workspace');
    const data=team ? snapshot.data : snapshot, allowed=!team || state.permissions.includes('purchasing.write');
    if(!team) {const owner=await request('/api/admin/state');data.purchasing={suppliers:owner.hpp?.suppliers ?? [],purchaseOrders:owner.hpp?.purchaseOrders ?? []};}
    const rows=data.ingredients?.items ?? [], receipts=team ? data.purchasing?.receipts : data.warehouse?.recentReceipts;
    $('#cashier-operations-body').innerHTML=`<p>Catat jumlah yang benar-benar diterima. Stok diperbarui setelah penyimpanan berhasil, tidak ada uang atau invoice supplier yang dibayar otomatis.</p><form id="cashier-receiving-form"><label>Supplier<input name="supplierName" maxlength="160" required></label><label>Referensi dokumen / catatan<input name="note" maxlength="240" required></label><label>Purchase order · opsional<select name="purchaseOrderId"><option value="">Tanpa PO</option>${(data.purchasing?.purchaseOrders ?? []).filter(p=>p.status !== 'cancelled').map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.orderNumber ?? p.id)}</option>`).join('')}</select></label><div id="cashier-receiving-lines"></div><button type="button" id="cashier-receiving-add" class="button button-secondary">Tambah bahan</button><button type="submit" class="button button-primary" ${!allowed || !rows.length ? 'disabled' : ''}>Simpan penerimaan & stok</button></form>${!rows.length ? '<p>Belum ada bahan. Owner perlu menambahkan database bahan terlebih dahulu.</p>' : ''}${!allowed ? '<p>Izin penerimaan belum diberikan; riwayat tetap dapat dilihat.</p>' : ''}<h3>Riwayat penerimaan</h3>${(receipts ?? []).slice(0,20).map(r=>`<article class="cashier-list-row"><strong>${escapeHtml(r.supplierName ?? 'Supplier')} · ${escapeHtml(r.businessDate ?? '')}</strong><span>${r.lines?.length ?? 0} bahan · ${rupiah(r.totalCostRupiah ?? r.totalRupiah)}</span></article>`).join('') || '<p>Belum ada penerimaan barang.</p>'}`;
    const form=$('#cashier-receiving-form'), pending=workspace.receivingAttempt;
    function addLine(saved={}) {
      const line=document.createElement('fieldset');line.className='cashier-receiving-line';
      line.innerHTML=`<label>Bahan<select name="ingredientId" required><option value="">Pilih bahan</option>${rows.map(i=>`<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('')}</select></label><label>Satuan pembelian<select name="purchaseUom" required></select></label><label>Jumlah datang<input name="purchaseQuantity" type="number" min="0.000001" step="any" required></label><label>Jumlah diterima baik<input name="acceptedPurchaseQuantity" type="number" min="0" step="any" required></label><label>Total harga barang datang (Rp)<input name="totalCostRupiah" type="number" min="0" max="1000000000" step="1" required></label><label>Lot / batch · opsional<input name="lotCode" maxlength="120"></label><label>Kedaluwarsa · opsional<input name="expiryDate" type="date"></label><button type="button" class="button button-ghost">Hapus bahan</button>`;
      const ingredient=line.querySelector('[name=ingredientId]'), units=line.querySelector('[name=purchaseUom]');
      ingredient.setAttribute('aria-label','Bahan');units.setAttribute('aria-label','Satuan pembelian');
      line.querySelector('button').insertAdjacentHTML('beforebegin','<label>Alasan barang ditolak · bila ada<input name="rejectionReason" maxlength="240"></label>');
      function setUnits(){const selected=rows.find(i=>i.id===ingredient.value);const base=selected?.baseUom ?? selected?.baseUnit;const unitSet=new Set([base,...(data.ingredients.conversions ?? []).filter(c=>c.ingredientId===ingredient.value).map(c=>c.fromUom ?? c.uom)]);units.innerHTML=[...unitSet].filter(Boolean).map(u=>`<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join('')+(data.ingredients.purchaseOptions ?? []).filter(p=>p.ingredientId===ingredient.value && p.active !== false).map(p=>`<option value="option:${escapeHtml(p.purchaseOptionId ?? p.packageId)}">${escapeHtml(p.label ?? p.packageLabel)}</option>`).join('');}
      ingredient.addEventListener('change',setUnits);line.querySelector('button').addEventListener('click',()=>line.remove());$('#cashier-receiving-lines').append(line);
      ingredient.value=saved.ingredientId ?? '';setUnits();for(const [key,value] of Object.entries(saved)) {const field=line.querySelector(`[name="${key}"]`);if(field)field.value=value;}if(saved.purchaseOptionId)units.value=`option:${saved.purchaseOptionId}`;
    }
    $('#cashier-receiving-add').addEventListener('click',()=>addLine());
    for(const line of pending?.payload.lines ?? [{}])addLine(line);
    if(pending){form.elements.supplierName.value=pending.payload.supplierName;form.elements.note.value=pending.reason;form.elements.purchaseOrderId.value=pending.payload.purchaseOrderId ?? '';for(const field of form.querySelectorAll('input,select,[type=button]'))field.disabled=true;form.querySelector('[type=submit]').textContent='Periksa / ulangi penerimaan yang sama';}
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(!form.reportValidity())return;const button=form.querySelector('[type=submit]');button.disabled=true;
      try {
        const lines=[...form.querySelectorAll('.cashier-receiving-line')].map(line=>{const v=Object.fromEntries([...line.querySelectorAll('input,select')].map(i=>[i.name,i.value]));const purchaseQuantity=Number(v.purchaseQuantity),acceptedPurchaseQuantity=Number(v.acceptedPurchaseQuantity);if(acceptedPurchaseQuantity>purchaseQuantity)throw new Error('Jumlah diterima baik tidak boleh lebih besar daripada jumlah datang.');if(acceptedPurchaseQuantity<purchaseQuantity && !v.rejectionReason.trim())throw new Error('Isi alasan untuk barang yang tidak diterima.');return {ingredientId:v.ingredientId,...(v.purchaseUom.startsWith('option:') ? {purchaseOptionId:v.purchaseUom.slice(7)} : {purchaseUom:v.purchaseUom}),purchaseQuantity,deliveredPurchaseQuantity:purchaseQuantity,acceptedPurchaseQuantity,rejectedPurchaseQuantity:purchaseQuantity-acceptedPurchaseQuantity,rejectionReason:v.rejectionReason,totalCostRupiah:Number(v.totalCostRupiah),...(v.lotCode || v.expiryDate ? {lots:[{lotCode:v.lotCode || 'tanpa-kode',expiryDate:v.expiryDate || null,deliveredPurchaseQuantity:purchaseQuantity,acceptedPurchaseQuantity,rejectedPurchaseQuantity:purchaseQuantity-acceptedPurchaseQuantity}]} : {})};});
        const body=workspace.receivingAttempt ?? {action:'warehouse.receipt.post',expectedRevision:data.revision,reason:form.elements.note.value,payload:{idempotencyKey:crypto.randomUUID(),supplierName:form.elements.supplierName.value,purchaseOrderId:form.elements.purchaseOrderId.value || undefined,lines}};
        workspace.receivingAttempt=body;if(!persistWorkspace())throw new Error('Penyimpanan tablet tidak tersedia; penerimaan belum dikirim.');
        await request(team ? '/api/team/workspace/purchasing' : '/api/operator/inventory-actions',{method:'POST',csrf:true,body});workspace.receivingAttempt=null;persistWorkspace();form.reset();await showReceiving();$('#cashier-operations-status').textContent='Penerimaan tersimpan; stok masuk satu kali. Pembayaran supplier tetap terpisah.';
      }catch(error){$('#cashier-operations-status').textContent=`${error.message} Periksa riwayat sebelum membuat penerimaan lain.`;}
      finally{button.disabled=false;}
    });
  }catch(error){$('#cashier-operations-body').textContent=error.message;}
}

async function shiftAction(event) {
  const button = event.target.closest("[data-shift]"); if (!button) return; button.disabled = true;
  try {
    if (paymentLocked()) throw new Error('Selesaikan pemeriksaan pembayaran sebelum mengubah shift.');
    const endpoint = button.dataset.shift === "open" ? "/api/cashier/shifts/open" : "/api/cashier/shifts/close";
    const openForm = $('#cash-open-form');
    if (button.dataset.shift === 'open' && !openForm.reportValidity()) { button.disabled = false; return; }
    let body = button.dataset.shift === 'open' ? { openingCashRupiah: Number(openForm.elements.openingCashRupiah.value), shiftName: openForm.elements.shiftName.value, note:openForm.elements.note.value } : {};
    if (button.dataset.shift === "close") {
      const form = document.querySelector("#cash-close-form");
      if (!form.reportValidity()) { button.disabled = false; return; }
      const input = Object.fromEntries(new FormData(form));
      body = {
        actualCashRupiah: Number(input.actualCashRupiah),
        cashToLeaveRupiah: Number(input.cashToLeaveRupiah),
        note: input.note,
        operationKey: `cashier-close:${state.shift.id}`,
      };
    }
    const result = await request(endpoint, { method: "POST", csrf: true, body });
    if (result.blocked) {
      document.querySelector("#cash-close-status").textContent = result.blockReason === "cash_variance_owner_required" ? "Selisih memerlukan pemeriksaan dan penutupan oleh owner. Shift belum ditutup." : result.blockReason === "pending_cash_assists_required" ? `${result.pendingCashAssists} pembayaran tunai kiosk masih menunggu. Selesaikan sebelum menutup shift.` : result.blockReason === 'pending_manual_qris_required' ? `${result.pendingManualQris} QRIS manual belum diperiksa. Periksa antrean pembayaran sebelum menutup shift.` : "Jelaskan selisih uang pada catatan. Shift belum ditutup.";
      button.disabled = false;
      return;
    }
    $('#cashier-shift-dialog').close(); await refresh(); announce(button.dataset.shift === "open" ? "Shift dibuka." : "Shift ditutup.");
  } catch (error) { $('#cash-close-status').textContent = error.message; button.disabled = false; }
}

function renderAssistedCashQueue() {
  const rows = state.pendingCashAssists || [];
  const staticRows = state.pendingStaticQrisDemos || [];
  const manualRows = state.pendingManualQris || [];
  assistedCashQueue.hidden = !rows.length && !staticRows.length && !manualRows.length;
  if (!rows.length && !staticRows.length && !manualRows.length) { assistedCashQueue.innerHTML = ""; return; }
  assistedCashQueue.innerHTML = `<header><div><p class="eyebrow">Kiosk · perlu tindakan</p><h2 id="pending-cash-assists-title">${rows.length} pembayaran tunai menunggu</h2></div><span class="count-pill">Konfirmasi staf wajib</span></header><div class="assisted-cash-grid">${rows.map(({ order, payment, tenderOptions }) => `<article class="assisted-cash-ticket" data-payment-id="${escapeHtml(payment.id)}"><div class="assisted-cash-ticket-heading"><div><small>${escapeHtml(order.orderNumber)}</small><strong>${rupiah(order.totalRupiah)}</strong></div><span>Menunggu uang</span></div><ul>${order.items.map((item) => `<li><span>${Number(item.qty)}× ${escapeHtml(item.productNameSnapshot || item.name || "Menu")}</span></li>`).join("")}</ul><div class="assisted-cash-declared"><span>Pelanggan menyiapkan</span><strong>${rupiah(payment.receivedRupiah)}</strong><small>Perkiraan kembali ${rupiah(payment.changeRupiah)}</small></div><div class="assisted-cash-tenders">${tenderOptions.map((option) => `<button type="button" data-assist-tender="${option.receivedRupiah}">${escapeHtml(option.label)}</button>`).join("")}</div><label>Uang aktual diterima (Rp)<input data-assist-received inputmode="numeric" value="${payment.receivedRupiah}" aria-describedby="assist-status-${escapeHtml(payment.id)}"></label><p id="assist-status-${escapeHtml(payment.id)}" data-assist-status>Hitung uang fisik sebelum konfirmasi.</p><button type="button" class="button button-primary" data-assist-confirm>Terima uang & kirim ke bar</button></article>`).join("")}</div>`;
  assistedCashQueue.querySelector(".assisted-cash-grid").insertAdjacentHTML("beforeend", staticRows.map(({ order, payment }) => `<article class="assisted-cash-ticket" data-payment-id="${escapeHtml(payment.id)}"><div class="assisted-cash-ticket-heading"><div><small>${escapeHtml(order.orderNumber)} · QRIS STATIS DEMO</small><strong>${rupiah(order.totalRupiah)}</strong></div><span>Simulasi</span></div><ul>${order.items.map((item) => `<li><span>${Number(item.qty)}× ${escapeHtml(item.productNameSnapshot || item.name || "Menu")}</span></li>`).join("")}</ul><p data-assist-status>QR dummy bukan bukti pembayaran. Konfirmasi ini hanya untuk order uji dan tidak mencatat penerimaan uang.</p><button type="button" class="button button-primary" data-static-confirm>Konfirmasi simulasi & kirim ke KDS</button></article>`).join(""));
  assistedCashQueue.querySelector(".assisted-cash-grid").insertAdjacentHTML("beforeend", manualRows.map(({ order, payment }) => `<article class="assisted-cash-ticket" data-payment-id="${escapeHtml(payment.id)}"><div class="assisted-cash-ticket-heading"><div><small>${escapeHtml(order.orderNumber)} · QRIS MERCHANT</small><strong>${rupiah(payment.amountRupiah)}</strong></div><span>Belum lunas</span></div><ul>${order.items.map((item) => `<li><span>${Number(item.qty)}× ${escapeHtml(item.productNameSnapshot || item.name || "Menu")}</span></li>`).join("")}</ul><p>Periksa transaksi di aplikasi merchant milik outlet ini. Cocokkan nominal dan referensi; jangan gunakan tangkapan layar pelanggan sebagai bukti.</p><label>Nominal diterima di merchant (Rp)<input data-manual-amount inputmode="numeric" autocomplete="off" aria-label="Nominal merchant untuk ${escapeHtml(order.orderNumber)}"></label><label>Referensi transaksi merchant<input data-manual-reference maxlength="80" autocomplete="off" aria-label="Referensi merchant untuk ${escapeHtml(order.orderNumber)}"></label><p data-assist-status role="status">Belum ada konfirmasi. Pesanan tidak masuk KDS.</p><button type="button" class="button button-primary" data-manual-confirm>Sudah masuk merchant · kirim ke KDS</button></article>`).join(""));
  assistedCashQueue.querySelector("#pending-cash-assists-title").textContent = `${rows.length + staticRows.length + manualRows.length} pembayaran menunggu kasir`;
  if (queueStale) for (const button of assistedCashQueue.querySelectorAll("[data-assist-confirm], [data-static-confirm], [data-manual-confirm]")) button.disabled = true;
}

async function handleAssistedCashQueue(event) {
  const ticket = event.target.closest("[data-payment-id]");
  if (!ticket) return;
  if (queueStale) return;
  const input = ticket.querySelector("[data-assist-received]");
  const status = ticket.querySelector("[data-assist-status]");
  const staticConfirm = event.target.closest("[data-static-confirm]");
  const manualConfirm = event.target.closest("[data-manual-confirm]");
  if (manualConfirm) {
    const row = (state.pendingManualQris || []).find((item) => item.payment.id === ticket.dataset.paymentId);
    if (!row) return;
    const observedAmountRupiah = Number(String(ticket.querySelector("[data-manual-amount]")?.value || "").replace(/\D/g, ""));
    const merchantReference = String(ticket.querySelector("[data-manual-reference]")?.value || "").trim();
    if (observedAmountRupiah !== row.payment.amountRupiah || !/^[A-Za-z0-9][A-Za-z0-9._/-]{5,79}$/.test(merchantReference)) {
      status.textContent = `Cocokkan nominal ${rupiah(row.payment.amountRupiah)} dan isi referensi transaksi merchant (6–80 karakter).`;
      status.dataset.danger = "true";
      return;
    }
    manualConfirm.disabled = true;
    status.textContent = "Mencatat konfirmasi kasir dan mengirim order ke KDS…";
    try {
      const result = await request("/api/cashier/manual-qris/confirm", { method: "POST", csrf: true,
        body: { paymentId: row.payment.id, observedAmountRupiah, merchantReference } });
      if (activeQris?.payment.id === result.payment.id) {
        activeQris = null; pendingCheckout = null; workspace.attempt = null; persistWorkspace(); lastResult = result;
        $('#checkout-result').innerHTML = receiptHtml(result); renderQuote();
      }
      announce(`${result.order.orderNumber} dikonfirmasi kasir dan masuk KDS. Rekonsiliasi settlement masih diperlukan.`);
      await refresh();
    } catch (error) { manualConfirm.disabled = false; status.textContent = error.message; status.dataset.danger = "true"; }
    return;
  }
  if (staticConfirm) {
    const row = (state.pendingStaticQrisDemos || []).find((item) => item.payment.id === ticket.dataset.paymentId);
    if (!row) return;
    staticConfirm.disabled = true;
    status.textContent = "Sedang mencatat persetujuan simulasi…";
    try {
      const result = await request("/api/cashier/static-qris-demo/confirm", { method: "POST", csrf: true, body: { paymentId: row.payment.id } });
      announce(`${result.order.orderNumber} adalah order uji; sekarang masuk KDS tanpa transaksi uang.`);
      await refresh();
    } catch (error) { staticConfirm.disabled = false; status.textContent = error.message; status.dataset.danger = "true"; }
    return;
  }
  const tender = event.target.closest("[data-assist-tender]");
  if (tender) {
    input.value = tender.dataset.assistTender;
    status.textContent = "Nominal dipilih. Hitung uang fisik lalu konfirmasi.";
    input.focus({ preventScroll: true });
    return;
  }
  const confirm = event.target.closest("[data-assist-confirm]");
  if (!confirm) return;
  const receivedRupiah = Number(String(input.value || "").replace(/\D/g, ""));
  const row = (state.pendingCashAssists || []).find((item) => item.payment.id === ticket.dataset.paymentId);
  if (!row || !Number.isSafeInteger(receivedRupiah) || receivedRupiah < row.payment.amountRupiah) {
    status.textContent = `Nominal kurang. Minimal ${rupiah(row?.payment.amountRupiah || 0)}.`;
    status.dataset.danger = "true";
    return;
  }
  confirm.disabled = true;
  input.disabled = true;
  status.dataset.danger = "false";
  status.textContent = `Kembalian ${rupiah(receivedRupiah - row.payment.amountRupiah)} · sedang mencatat pembayaran…`;
  try {
    const result = await request("/api/cashier/assisted-cash/confirm", { method: "POST", csrf: true, body: { paymentId: row.payment.id, receivedRupiah } });
    announce(`${result.order.orderNumber} lunas. Kembalian ${rupiah(result.payment.changeRupiah)} dan pesanan masuk bar.`);
    await refresh();
  } catch (error) {
    confirm.disabled = false;
    input.disabled = false;
    status.dataset.danger = "true";
    status.textContent = error.message;
  }
}

function renderCatalog() {
  const checkoutLocked = paymentLocked();
  if (!state.catalog.some(category => category.id === selectedCategory)) selectedCategory = state.catalog[0]?.id;
  categoriesView.innerHTML = state.catalog.map((category) => `<button type="button" role="tab" data-category="${escapeHtml(category.id)}" aria-selected="${category.id === selectedCategory}" tabindex="${category.id === selectedCategory ? 0 : -1}">${escapeHtml(category.name)}</button>`).join("");
  const category = state.catalog.find((item) => item.id === selectedCategory) ?? state.catalog[0];
  const query = searchInput.value.trim().toLocaleLowerCase('id-ID');
  const products = query ? state.catalog.flatMap(category => category.products).filter(product => product.name.toLocaleLowerCase('id-ID').includes(query)) : category?.products ?? [];
  document.querySelector('#cashier-menu-count').textContent = `${products.length} menu${query ? ' ditemukan' : ''}`;
  productsView.innerHTML = products.map((product, index) => {
    const disabled = !product.available || checkoutLocked;
    const label = checkoutLocked ? `${product.name}, selesaikan status QRIS aktif terlebih dahulu` : product.available ? `Tambah ${product.name}, ${rupiah(product.priceRupiah)}` : `${product.name}, habis`;
    const image = /^(data:image\/(?:png|jpeg|webp);base64,|\/(?!\/))/.test(product.imageUrl || '') ? `<img class="cashier-menu-image" src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy">` : '<span class="cashier-menu-image" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1M3 8h15v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8ZM6 1v3M10 1v3M14 1v3"/></svg></span>';
    return `<button class="product-card" data-product="${escapeHtml(product.id)}" ${disabled ? "disabled" : ""} aria-label="${escapeHtml(label)}">${image}<span class="product-index">${checkoutLocked ? "Periksa pembayaran" : product.available ? ((product.variantGroups?.length || product.modifierGroups?.length) ? 'Pilih varian / tambahan' : 'Tambah cepat') : "Habis"}</span><span class="product-name">${escapeHtml(product.name)}</span><span class="product-price">${rupiah(product.priceRupiah)}</span><span class="add-mark" aria-hidden="true">+</span></button>`;
  }).join("") || '<p class="notice">Tidak ada menu yang cocok. Coba kata lain atau hapus pencarian.</p>';
}

function cartChanged() {
  if (paymentLocked()) return;
  if(benefits.discountRequestId || benefits.discountAuthorizationId){delete benefits.discountRequestId;delete benefits.discountAuthorizationId;benefits.discountOperationKey=`discount:${crypto.randomUUID()}`;announce('Pesanan berubah; persetujuan diskon perlu diminta ulang.',true);}
  receivedInput.value = "";
  scheduleQuote();
  renderCart();
  persistWorkspace();
}

function renderCart() {
  const products = new Map(state.catalog.flatMap((category) => category.products).map((product) => [product.id, product]));
  const rows = [...cart.values()].map(line => ({ product: products.get(line.productId), ...line })).filter(row => row.product);
  const disabled = paymentLocked() ? 'disabled' : '';
  cartView.innerHTML = rows.length ? rows.map(line => `<div class="cart-row"><button class="cashier-line-edit" data-cart-edit="${escapeHtml(line.id)}" ${disabled}><strong>${escapeHtml(line.product.name)}</strong><small>${escapeHtml(line.selections.map(s => s.optionLabel).join(' · '))}</small><small>${escapeHtml(line.note)}</small><span>${rupiah((line.product.priceRupiah + line.selections.reduce((sum,s) => sum + Number(s.priceDeltaRupiah || 0),0)) * line.qty)} · estimasi</span></button><div class="quantity-control" aria-label="Jumlah ${escapeHtml(line.product.name)}"><button data-cart-action="remove" data-line="${escapeHtml(line.id)}" ${disabled} aria-label="Kurangi ${escapeHtml(line.product.name)}">−</button><span>${line.qty}</span><button data-cart-action="add" data-line="${escapeHtml(line.id)}" ${disabled} aria-label="Tambah ${escapeHtml(line.product.name)}">+</button></div></div>`).join('') : '<div class="empty-cart"><strong>Pesanan masih kosong</strong><p>Cari dan pilih menu di sebelah kiri untuk mulai.</p></div>';
  const count = rows.reduce((sum, row) => sum + row.qty, 0);
  document.querySelector("#cashier-count").textContent = `${count} item`;
  $('#cashier-cart-jump').textContent = `Pesanan · ${count} item`;
  renderQuote();
  for (const id of ['#cashier-save-draft','#cashier-clear','#order-type']) $(id).disabled = paymentLocked();
}

function quotePayload() {
  return {
    ...benefits,
    cart: [...cart.values()].map(({ productId, qty, selections, note }) => ({ productId, qty, selections: selections.map(({groupId,optionId}) => ({groupId,optionId})), note })),
    orderType: document.querySelector("#order-type").value,
    memberCode: document.querySelector("#member-code").value.trim() || undefined,
    rewardId: document.querySelector("#reward-id").value || undefined,
    paymentMethod: document.querySelector("#payment-method").value,
  };
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  ++quoteSequence; // Invalidate an in-flight quote immediately, not only when the next request starts.
  quote = null;
  if (paymentLocked()) {
    quoteStatus.textContent = "Selesaikan status QRIS aktif sebelum membuat pesanan berikutnya.";
    checkoutButton.disabled = true;
    checkoutButton.textContent = "QRIS aktif · periksa status";
    renderQuote();
    return;
  }
  const hasItems = cart.size > 0;
  quoteStatus.textContent = hasItems ? "Menghitung harga final dari server…" : "Tambahkan item untuk meminta harga final dari server.";
  checkoutButton.disabled = true;
  renderQuote();
  if (!hasItems) return;
  quoteTimer = setTimeout(refreshQuote, 180);
}

async function refreshQuote() {
  const sequence = ++quoteSequence;
  try {
    const nextQuote = await request("/api/cashier/quote", { method: "POST", csrf: true, body: quotePayload() });
    if (sequence !== quoteSequence) return;
    quote = nextQuote;
    quoteFreshUntil = performance.now() + 5 * 60_000;
    persistWorkspace();
    renderQuote();
  } catch (error) {
    if (sequence !== quoteSequence) return;
    quote = null;
    quoteStatus.textContent = `Harga belum dapat dikonfirmasi: ${error.message}`;
    quoteStatus.dataset.danger = "true";
    checkoutButton.disabled = true;
    $('#cashier-pay').disabled = true;
    $('#cashier-payment-authority').textContent = quoteStatus.textContent;
  }
}

function renderQuote() {
  const benefit=quote?.benefitSnapshot;
  $('#cashier-benefit-summary').textContent=benefit?.discountRupiah ? `${benefit.name} · hemat ${rupiah(benefit.discountRupiah)}` : benefits.promotionCode ? `Kode ${benefits.promotionCode} · menunggu perhitungan` : benefits.automaticPromotions ? 'Promo otomatis diperiksa saat menu dipilih.' : 'Tanpa promo otomatis.';
  $('#cashier-benefits-open').disabled=paymentLocked()||!cart.size;
  const totalView = document.querySelector("#cashier-total");
  const saving = document.querySelector("#cashier-saving");
  const paymentMethod = document.querySelector("#payment-method").value;
  document.querySelector("#received-field").hidden = paymentMethod !== "CASH";
  tenderPanel.hidden = paymentMethod !== "CASH" || !quote;
  totalView.textContent = quote ? rupiah(quote.totalRupiah) : cart.size ? 'Menghitung…' : 'Rp0';
  $('#cashier-payment-total').textContent = totalView.textContent;
  $('#cashier-payment-items').innerHTML = quote ? quote.items.map(item => `<div class="cashier-review-row"><strong>${Number(item.qty)} × ${escapeHtml(item.productNameSnapshot)}</strong><strong>${rupiah(item.lineTotalRupiah)}</strong><small>${escapeHtml(item.selections.map(s => s.optionLabel).join(' · '))}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></div>`).join('') : '<p>Menunggu harga final dari server.</p>';
  $('#cashier-payment-authority').textContent = quote ? `Harga final server · ${$('#order-type').selectedOptions[0].textContent}` : 'Pembayaran ditahan sampai harga terverifikasi.';
  renderPaymentMethods();
  $('#cashier-payment-breakdown').innerHTML = quote ? [['Subtotal',quote.subtotalRupiah],['Diskon'+(benefit?.name?' · '+benefit.name:''),-quote.discountRupiah],['Pajak',quote.taxRupiah],['Biaya layanan',quote.serviceRupiah],['Pembulatan',quote.roundingRupiah]].filter(([,value]) => value).map(([label,value]) => `<p><span>${escapeHtml(label)}</span><strong>${rupiah(value)}</strong></p>`).join('') : '';
  $('#cashier-cart-breakdown').innerHTML = $('#cashier-payment-breakdown').innerHTML;
  saving.hidden = !quote?.discountRupiah;
  if (quote?.discountRupiah) saving.querySelector("strong").textContent = rupiah(quote.discountRupiah);
  quoteStatus.dataset.danger = "false";
  if (quote) quoteStatus.textContent = `Terverifikasi server · berlaku sampai ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date(quote.expiresAt))}`;
  tenderOptionsView.innerHTML = paymentMethod === "CASH" && quote ? quote.tenderOptions.map((option) => `<button type="button" data-tender="${option.receivedRupiah}" class="${option.isExact ? "is-exact" : ""}"><strong>${escapeHtml(option.label)}</strong><span>${option.changeRupiah ? `Kembali ${rupiah(option.changeRupiah)}` : "Tanpa kembalian"}</span></button>`).join("") : "";
  renderTenderState();
}

function renderTenderState() {
  const paymentMethod = document.querySelector("#payment-method").value;
  const permitted = !state?.permissions || ['orders.write','cash.write'].every(p => state.permissions.includes(p));
  const blocked = !permitted || $('#payment-method').selectedOptions[0]?.disabled || !navigator.onLine || queueStale || state.shift?.status !== 'open' || storageFailed || paymentLocked();
  const stale = quote && performance.now() > quoteFreshUntil;
  $('#cashier-pay').textContent = paymentLocked() ? 'Periksa pembayaran' : quote ? `Bayar · ${rupiah(quote.totalRupiah)}` : 'Bayar';
  $('#cashier-pay').disabled = paymentLocked() ? false : blocked || !quote || stale;
  $('#cashier-new-order').disabled = paymentLocked();
  $('#cashier-print').disabled = !lastResult || lastResult.payment?.status !== 'PAID';
  if (!quote || blocked || stale) { checkoutButton.disabled = true; if (stale) quoteStatus.textContent = 'Harga perlu diperbarui. Tekan Perbarui antrean.'; return; }
  if (paymentMethod !== "CASH") {
    tenderStatus.textContent = "";
    checkoutButton.disabled = state.shift?.status !== "open";
    checkoutButton.textContent = `Buat QRIS · ${rupiah(quote.totalRupiah)}`;
    return;
  }
  const received = Number(receivedInput.value);
  if (!Number.isSafeInteger(received) || received < 0) { tenderStatus.textContent = 'Masukkan Rupiah bulat yang valid.'; checkoutButton.disabled = true; return; }
  const difference = received - quote.totalRupiah;
  tenderStatus.dataset.state = difference >= 0 ? "ready" : received > 0 ? "short" : "idle";
  tenderStatus.textContent = received === 0
    ? "Masukkan nominal atau pilih shortcut."
    : difference >= 0
      ? `Kembalian ${rupiah(difference)} · periksa sebelum konfirmasi.`
      : `Kurang ${rupiah(Math.abs(difference))}.`;
  checkoutButton.disabled = state.shift?.status !== "open" || received < quote.totalRupiah;
  checkoutButton.textContent = difference >= 0 ? `Terima tunai · kembali ${rupiah(difference)}` : `Konfirmasi pembayaran · ${rupiah(quote.totalRupiah)}`;
}

async function checkout() {
  if (!quote || paymentLocked() || queueStale || !navigator.onLine || storageFailed || performance.now() > quoteFreshUntil || state.shift?.status !== 'open') return;
  checkoutButton.disabled = true;
  const payload = quotePayload();
  payload.expectedTotalRupiah = quote.totalRupiah;
  payload.expectedBenefitFingerprint=quote.benefitFingerprint;
  if (payload.paymentMethod === "CASH") payload.receivedRupiah = Number(receivedInput.value);
  const fingerprint = JSON.stringify(payload);
  pendingCheckout = { key: crypto.randomUUID(), fingerprint, payload, uncertain: true };
  workspace.attempt = pendingCheckout;
  if (!persistWorkspace()) { pendingCheckout = null; workspace.attempt = null; return renderTenderState(); }
  await sendCheckout();
}

async function sendCheckout() {
  if (checkoutBusy || !pendingCheckout || !navigator.onLine) return;
  checkoutBusy = true;
  $('#checkout-result').hidden = false;
  $('#checkout-result').textContent = 'Pembayaran sedang diproses. Jangan membuat transaksi pengganti.';
  showScreen('result', true);
  render();
  let rejected = false;
  try {
    const result = await request('/api/cashier/checkouts', { method: 'POST', csrf: true, body: { ...pendingCheckout.payload, idempotencyKey: pendingCheckout.key } });
    finishCheckout(result);
    await refresh();
  } catch (error) {
    if (error.status >= 400 && error.status < 500) {
      try {
        const recovery = await request(`/api/cashier/recovery?key=${encodeURIComponent(pendingCheckout.key)}`);
        if (recovery.found) finishCheckout(recovery);
        else { pendingCheckout = null; workspace.attempt = null; persistWorkspace(); rejected = true; announce(`${error.message} Pesanan tetap tersimpan.`,true); }
      } catch { showUnknown(); }
    } else showUnknown();
  } finally { checkoutBusy = false; if (rejected) { scheduleQuote(); render(); showScreen('payment', true); } renderQuote(); }
}

async function settleQris(event) {
  if (event.target.closest('[data-manual-queue]')) { $('#cashier-queue-open').click(); return; }
  if (event.target.closest('[data-recover]')) return recoverAttempt();
  if (event.target.closest('[data-retry]')) return sendCheckout();
  const button = event.target.closest("[data-qris-check]"); if (!button || !activeQris || activeQris.loading) return;
  await checkQrisStatus();
}

async function checkQrisStatus() {
  if (!activeQris || activeQris.loading) return;
  clearTimeout(qrisPollTimer);
  activeQris.loading = true;
  activeQris.errorMessage = "";
  renderQrisResult();
  try {
    const live = activeQris.payment.simulator === false;
    const body = { paymentId: activeQris.payment.id, ...(live ? {} : { callbackId: `cashier-browser:${activeQris.payment.id}` }) };
    const result = activeQris.payment.staticQrisManual && pendingCheckout
      ? await request(`/api/cashier/recovery?key=${encodeURIComponent(pendingCheckout.key)}`)
      : await request(live ? "/api/cashier/payments/status" : "/api/cashier/payments/simulate-paid", { method: "POST", csrf: true, body });
    if (!result.payment) throw new Error('Transaksi belum ditemukan. Periksa antrean pembayaran.');
    activeQris = { ...activeQris, order: result.order, payment: result.payment, attempt: activeQris.attempt + 1, loading: false, lastCheckedAt: new Date().toISOString(), errorMessage: "" };
    renderCatalog();
    renderQrisResult();
    scheduleQrisPoll();
    lastResult = result;
    if (!cashierCheckoutLocked(activeQris)) { workspace.attempt = null; pendingCheckout = null; persistWorkspace(); }
    if (result.payment.status === "PAID") await refresh();
    renderQuote();
  } catch (error) {
    activeQris.loading = false;
    activeQris.errorMessage = error.message;
    renderQrisResult();
    announce(error.message, true);
  }
}

function scheduleQrisPoll() {
  clearTimeout(qrisPollTimer);
  if (!activeQris || activeQris.payment.staticQrisManual || activeQris.payment.simulator !== false || activeQris.payment.status !== "PENDING") return;
  const delay = nextPaymentPollDelay(activeQris.attempt);
  if (delay !== null) qrisPollTimer = setTimeout(checkQrisStatus, delay);
}

function renderQrisResult() {
  if (!activeQris) return;
  const box = document.querySelector("#checkout-result");
  if (activeQris.payment.staticQrisManual && activeQris.payment.status === 'PENDING') {
    box.hidden=false; box.className='result-card cashier-qris-result';
    box.innerHTML=`<strong>${escapeHtml(activeQris.order.orderNumber)} · QRIS manual belum lunas</strong><span>${rupiah(activeQris.payment.amountRupiah)}</span><p>Pelanggan scan QRIS outlet. Kasir harus memeriksa nominal dan referensi di aplikasi merchant, bukan tangkapan layar pelanggan.</p><img class="cashier-qr" src="/api/cashier/manual-qris/image" alt="QRIS merchant outlet"><button type="button" class="button button-primary" data-manual-queue>Periksa pembayaran merchant</button><button type="button" class="button button-secondary" data-qris-check>Perbarui status tersimpan</button>`;
    return;
  }
  const view = cashierQrisPresentation(activeQris);
  box.hidden = false;
  box.className = `result-card cashier-qris-result tone-${view.tone}`;
  box.setAttribute("aria-busy", String(Boolean(activeQris.loading)));
  box.innerHTML = `<div class="cashier-qris-heading"><div><small>${escapeHtml(view.eyebrow)}</small><strong>${escapeHtml(view.title)}</strong></div><span>${rupiah(activeQris.order.totalRupiah)}</span></div><div class="cashier-qris-fact"><span>Order</span><strong>${escapeHtml(activeQris.order.orderNumber)}</strong></div><p>${escapeHtml(view.detail)}</p><p class="cashier-qris-safety">${escapeHtml(view.safety)}</p>${view.lastCheckedLabel ? `<small>${escapeHtml(view.lastCheckedLabel)}</small>` : ""}${view.actionLabel ? `<button class="button button-secondary" type="button" data-qris-check ${activeQris.loading ? "disabled" : ""}>${escapeHtml(view.actionLabel)}</button>` : ""}`;
  if (activeQris.payment.qrImageDataUrl?.startsWith('data:image/png;base64,')) box.insertAdjacentHTML('beforeend', `<img class="cashier-qr" src="${escapeHtml(activeQris.payment.qrImageDataUrl)}" alt="QRIS pembayaran pesanan ${escapeHtml(activeQris.order.orderNumber)}">`);
  if (activeQris.payment.status === 'PAID') box.insertAdjacentHTML('beforeend', receiptHtml(activeQris));
}

function paymentLocked() { return checkoutBusy || Boolean(pendingCheckout?.uncertain) || cashierCheckoutLocked(activeQris); }
function showScreen(screen, replace = false) {
  if (paymentLocked()) screen = 'result';
  else if (screen === 'payment' && !cart.size) screen = 'order';
  else if (screen === 'result' && !lastResult) screen = 'order';
  if (!['payment','result'].includes(screen)) screen = 'order';
  const hash = screen === 'order' ? '' : `#${screen}`;
  const changed = orderPage.hidden !== (screen !== 'order') || paymentPage.hidden !== (screen !== 'payment') || resultPage.hidden !== (screen !== 'result');
  if (location.hash !== hash) history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + hash);
  orderPage.hidden = screen !== 'order'; paymentPage.hidden = screen !== 'payment'; resultPage.hidden = screen !== 'result';
  (screen === 'payment' ? paymentPage.querySelector('[aria-label="Review pesanan"]') : $('.cart-summary')).append(quoteStatus);
  $('.cashier-tools').open = false;
  if (changed) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    window.scrollTo(0,0);
    (screen === 'order' ? searchInput : $(`#cashier-${screen}-title`)).focus({preventScroll:true});
  }
}
function openDialog(dialog) { $('#cashier-queue-refresh').hidden = dialog.id !== 'cashier-list-dialog' || $('#cashier-list-title').textContent !== 'Antrean pembayaran'; if (!dialog.open) dialog.showModal(); $('.cashier-tools').open = false; }
function confirmAction(message) {
  const dialog = $('#cashier-confirm-dialog'); $('#cashier-confirm-message').textContent = message; dialog.returnValue = '';
  openDialog(dialog); return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}
function openItem(productId, lineId = null) {
  if (paymentLocked()) return;
  const product = state.catalog.flatMap(c => c.products).find(p => p.id === productId);
  if (!product?.available) return announce('Menu sedang tidak tersedia.',true);
  const line = cart.get(lineId);
  const groups = [...(product.variantGroups || []), ...(product.modifierGroups || [])];
  if (!lineId && !groups.length) {
    const matching = [...cart.values()].find(item => item.productId === productId && !item.note && !item.selections.length && item.qty < 20);
    const id = matching?.id || crypto.randomUUID(); cart.set(id, { id, productId, qty: (matching?.qty || 0)+1, selections: [], note: '' }); cartChanged(); return;
  }
  itemEdit = { product, lineId };
  $('#cashier-item-title').textContent = product.name;
  $('#cashier-item-options').innerHTML = groups.map((group,index) => {
    const min = Math.max(group.required ? 1 : 0, Number(group.min || 0)), max = Number(group.max || 1);
    return `<fieldset data-choice-group="${index}" tabindex="-1" aria-describedby="cashier-group-error-${index}"><legend>${escapeHtml(group.label)} · ${min ? `wajib ${min}–${max}` : `opsional, maksimal ${max}`}</legend>${group.options.map((option,optionIndex) => `<label class="cashier-choice"><input type="${max === 1 ? 'radio' : 'checkbox'}" name="choice-${index}" value="${index}:${optionIndex}" ${line?.selections.some(s => s.groupId === group.id && s.optionId === option.id) ? 'checked' : ''} ${option.available === false ? 'disabled' : ''}>${escapeHtml(option.label)}${option.priceDeltaRupiah ? ` (${rupiah(option.priceDeltaRupiah)})` : ''}${option.available === false ? ' · habis' : ''}</label>`).join('')}${!min && max === 1 ? `<label class="cashier-choice"><input type="radio" name="choice-${index}" value="none" ${!line?.selections.some(s => s.groupId === group.id) ? 'checked' : ''}>Tanpa tambahan</label>` : ''}<p id="cashier-group-error-${index}" class="cashier-group-error"></p></fieldset>`;
  }).join('');
  $('#cashier-item-options').insertAdjacentHTML('afterbegin', `<p>Harga dasar <strong>${rupiah(product.priceRupiah)}</strong> · ${lineId ? 'Ubah pesanan yang belum dibayar' : 'Pilih sesuai pesanan pelanggan'}</p>`);
  const form = $('#cashier-item-form'); form.elements.qty.value = line?.qty || 1; form.elements.note.value = line?.note || ''; $('#cashier-item-status').textContent = ''; $('#cashier-item-delete').hidden = !lineId;
  previewItem(); openDialog($('#cashier-item-dialog'));
}
function previewItem() {
  if (!itemEdit) return;
  const groups = [...(itemEdit.product.variantGroups || []), ...(itemEdit.product.modifierGroups || [])];
  const form = $('#cashier-item-form'); let delta = 0;
  for (const [index, group] of groups.entries()) {
    const fieldset = form.querySelector(`[data-choice-group="${index}"]`);
    const selected = [...fieldset.querySelectorAll('input:checked')].filter(input => input.value !== 'none');
    fieldset.removeAttribute('aria-invalid'); fieldset.querySelector('.cashier-group-error').textContent = '';
    const max = Number(group.max || 1);
    for (const input of fieldset.querySelectorAll('input[type=checkbox]')) {
      const option = group.options[Number(input.value.split(':')[1])];
      input.disabled = option.available === false || (!input.checked && selected.length >= max);
    }
    for (const input of selected) delta += Number(group.options[Number(input.value.split(':')[1])]?.priceDeltaRupiah || 0);
  }
  $('#cashier-item-status').textContent = '';
  $('#cashier-item-preview').textContent = `${rupiah((itemEdit.product.priceRupiah+delta)*(Number(form.elements.qty.value)||1))} · estimasi`;
}
function saveItem(event) {
  event.preventDefault(); if (!itemEdit || paymentLocked()) return;
  const form = event.currentTarget; if (!form.reportValidity()) return;
  const groups = [...(itemEdit.product.variantGroups || []), ...(itemEdit.product.modifierGroups || [])];
  const selections = [];
  for (const [index,group] of groups.entries()) {
    const fieldset = form.querySelector(`[data-choice-group="${index}"]`);
    const checked = [...fieldset.querySelectorAll('input:checked')].filter(input => input.value !== 'none');
    if (checked.length < Math.max(group.required ? 1 : 0, Number(group.min || 0)) || checked.length > Number(group.max || 1)) {
      const message = `Pilih ${Math.max(group.required ? 1 : 0, Number(group.min || 0))}–${group.max || 1} pilihan untuk ${group.label}.`;
      $('#cashier-item-status').textContent = message; fieldset.querySelector('.cashier-group-error').textContent = message; fieldset.setAttribute('aria-invalid','true'); fieldset.focus(); return;
    }
    for (const input of checked) { const option = group.options[Number(input.value.split(':')[1])]; if (option.available === false) return; selections.push({groupId:group.id,groupLabel:group.label,optionId:option.id,optionLabel:option.label,priceDeltaRupiah:Number(option.priceDeltaRupiah || 0)}); }
  }
  const qty = Number(form.elements.qty.value), note = form.elements.note.value.trim();
  const signature = choices => JSON.stringify(choices.map(s => [s.groupId,s.optionId]).sort());
  const matching = !itemEdit.lineId && [...cart.values()].find(line => line.productId === itemEdit.product.id && line.note === note && signature(line.selections) === signature(selections) && line.qty + qty <= 20);
  const id = itemEdit.lineId || matching?.id || crypto.randomUUID();
  cart.set(id,{id,productId:itemEdit.product.id,qty:qty+(matching?.qty || 0),selections,note});
  $('#cashier-item-dialog').close(); itemEdit = null; cartChanged();
}
function draftSnapshot() { return createCartDraft({sessionId:workspaceKey,orderType:$('#order-type').value,selectedCategory,cart}); }
function persistWorkspace() {
  if (!workspaceKey || storageFailed) return false;
  workspace.active = cart.size ? draftSnapshot() : null;
  workspace.checkoutFields = {paymentMethod:$('#payment-method').value, memberCode:$('#member-code').value, rewardId:$('#reward-id').value, received:receivedInput.value};
  workspace.benefits=structuredClone(benefits);
  try { localStorage.setItem(workspaceKey,JSON.stringify(workspace)); storageFailed = false; $('#cashier-draft-status').textContent = 'Draft otomatis · hanya tablet dan akun ini'; return true; }
  catch { storageFailed = true; $('#cashier-draft-status').textContent = 'Penyimpanan tablet gagal. Jangan tutup halaman; pembayaran ditahan.'; return false; }
}
function restoreDraft(draft) {
  const restored = restoreCartDraft(draft,{sessionId:workspaceKey,catalog:state.catalog,maxAgeMs:24*60*60_000});
  cart.clear(); for (const line of restored.lines) cart.set(line.id,line);
  $('#order-type').value = restored.orderType || 'TAKEAWAY'; selectedCategory = restored.selectedCategory;
  if (restored.droppedCount) announce(`${restored.droppedCount} item berubah atau tidak tersedia. Periksa pesanan sebelum membayar.`,true);
  return restored;
}
async function restoreWorkspace() {
  workspaceKey = `saga_cashier_v1:${state.actor.organizationId || state.context.organizationId}:${state.actor.outletId || state.context.outletId}:${state.actor.employeeId}`;
  workspaceReady = true;
  try { const raw = localStorage.getItem(workspaceKey); const data = raw && JSON.parse(raw); workspace = data?.version === 1 && Array.isArray(data.drafts) ? data : {version:1,active:null,drafts:[],attempt:null}; }
  catch { storageFailed = true; announce('Draft tablet tidak dapat dibaca. Pembayaran ditahan; periksa penyimpanan perangkat.',true); return; }
  // ponytail: draft per tablet, 20 pesanan/24 jam; gunakan server draft bila perlu lintas perangkat.
  workspace.drafts = workspace.drafts.filter(d => d?.draft?.savedAt > Date.now()-24*60*60_000).slice(0,20);
  if (workspace.active) restoreDraft(workspace.active);
  if (workspace.active && workspace.checkoutFields) {
    benefits=workspace.benefits??{automaticPromotions:true};
    const saved = workspace.checkoutFields;
    if ([...$('#payment-method').options].some(option => option.value === saved.paymentMethod)) $('#payment-method').value = saved.paymentMethod;
    $('#member-code').value = saved.memberCode || ''; $('#reward-id').value = saved.rewardId || ''; receivedInput.value = saved.received || '';
  }
  if (workspace.attempt) { pendingCheckout = workspace.attempt; pendingCheckout.uncertain = true; await recoverAttempt(); }
  else {
    const pending = (state.recentOrders || []).filter(o => o.cashierUserId === state.actor.employeeId && ['PENDING','UNKNOWN'].includes(o.payment?.status));
    if (pending.length) { activeQris = {order:pending[0],payment:pending[0].payment,attempt:0}; lastResult = {order:pending[0],payment:pending[0].payment}; renderQrisResult(); showScreen('result', true); }
    else if (location.hash === '#result' && workspace.resultOrderId) {
      const order = (state.recentOrders || []).find(order => order.id === workspace.resultOrderId);
      if (order?.payment) {
        lastResult = {order,payment:order.payment};
        $('#checkout-result').hidden = false;
        $('#checkout-result').innerHTML = receiptHtml(lastResult);
      }
    }
  }
  persistWorkspace();
}
async function saveDraft() {
  if (!cart.size || paymentLocked()) return;
  if (workspace.drafts.length >= 20) return announce('Maksimal 20 draft. Hapus atau lanjutkan draft lama.',true);
  const products = state.catalog.flatMap(category => category.products);
  workspace.drafts.unshift({id:crypto.randomUUID(),draft:draftSnapshot(),label:[...cart.values()].map(line => `${line.qty}× ${products.find(p => p.id === line.productId)?.name || 'Menu'}`).join(', ')});
  if (!persistWorkspace()) { workspace.drafts.shift(); return; }
  cart.clear(); $('#member-code').value = ''; $('#reward-id').value = ''; cartChanged(); announce('Draft disimpan di tablet ini, belum menjadi penjualan.');
}
function showDrafts() {
  $('#cashier-list-title').textContent = 'Draft tablet';
  $('#cashier-list-content').innerHTML = `<p>Belum dibayar · tersimpan 24 jam, hanya untuk akun dan outlet ini pada tablet yang sama.</p>${workspace.drafts.map(row => `<article class="cashier-list-row"><strong>${row.draft.lines.reduce((sum,l)=>sum+l.qty,0)} item · ${new Date(row.draft.savedAt).toLocaleTimeString('id-ID')}</strong><span>${escapeHtml(row.label || 'Draft pesanan')}</span><button class="button button-primary" data-draft-load="${escapeHtml(row.id)}">Lanjutkan</button><button class="button button-ghost" data-draft-delete="${escapeHtml(row.id)}">Hapus draft</button></article>`).join('') || '<p>Belum ada draft. Susun pesanan lalu tekan Simpan draft.</p>'}`;
  openDialog($('#cashier-list-dialog'));
}
function showHistory() {
  $('#cashier-list-title').textContent = 'Riwayat & nota';
  $('#cashier-list-content').innerHTML = `<div class="cashier-history-filters"><label>Cari nomor pesanan<input id="cashier-history-search" type="search" placeholder="Nomor pesanan"></label><label>Status pembayaran<select id="cashier-history-status" aria-label="Status pembayaran"><option value="">Semua status</option>${['PAID','PENDING','UNKNOWN','EXPIRED','FAILED','REFUNDED'].map(status => `<option value="${status}">${paymentStatusLabel(status)}</option>`).join('')}</select></label><label>Metode pembayaran riwayat<select id="cashier-history-method" aria-label="Metode pembayaran riwayat"><option value="">Semua metode</option>${[...new Set((state.recentOrders || []).map(order => order.payment?.methodType).filter(Boolean))].map(method => `<option value="${escapeHtml(method)}">${escapeHtml(method === 'cash' ? 'Tunai' : method === 'qris_manual' ? 'QRIS manual' : method === 'qris_dynamic' ? 'QRIS' : method)}</option>`).join('')}</select></label><label>Tanggal transaksi<input id="cashier-history-date" type="date"></label></div><p>Filter untuk 20 transaksi terbaru, bukan seluruh arsip. Pembayaran tertunda bukan penjualan lunas.</p>${(state.recentOrders || []).map(order => `<article class="cashier-list-row" data-history-row data-number="${escapeHtml(order.orderNumber)}" data-status="${escapeHtml(order.payment?.status)}" data-method="${escapeHtml(order.payment?.methodType)}" data-date="${escapeHtml(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(order.createdAt)))}"><strong>${escapeHtml(order.orderNumber)} · ${rupiah(order.totalRupiah)}</strong><span>${paymentStatusLabel(order.payment?.status)} · ${escapeHtml(order.payment?.methodNameSnapshot || '')} · ${new Date(order.createdAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}</span><button class="button button-secondary" data-history-detail="${escapeHtml(order.id)}">Lihat detail</button>${['PAID','REFUNDED'].includes(order.payment?.status) ? `<button class="button button-secondary" data-history-print="${escapeHtml(order.id)}">Cetak ulang</button>` : ''}</article>`).join('') || '<p>Belum ada transaksi. Pesanan baru akan terlihat setelah dicatat server.</p>'}<p id="cashier-history-empty" hidden>Tidak ada transaksi yang cocok dengan filter.</p>`;
  $('#cashier-list-content').querySelector('.cashier-history-filters').addEventListener('input', () => {
    let visible = 0;
    for (const row of document.querySelectorAll('[data-history-row]')) {
      row.hidden = !row.dataset.number.toLowerCase().includes($('#cashier-history-search').value.toLowerCase()) || ['status','method','date'].some(key => $('#cashier-history-'+key).value && row.dataset[key] !== $('#cashier-history-'+key).value);
      if (!row.hidden) visible++;
    }
    $('#cashier-history-empty').hidden = visible > 0;
  });
  openDialog($('#cashier-list-dialog'));
}
async function listAction(event) {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-history-back')) { showHistory(); return; }
  if (button.dataset.draftLoad) {
    if (paymentLocked()) return announce('Selesaikan pembayaran aktif dulu.',true);
    if (cart.size && !await confirmAction('Ganti pesanan aktif dengan draft ini?')) return;
    const row = workspace.drafts.find(d => d.id === button.dataset.draftLoad); if (!row) return;
    restoreDraft(row.draft); workspace.drafts = workspace.drafts.filter(d => d.id !== row.id); $('#cashier-list-dialog').close(); cartChanged();
  } else if (button.dataset.draftDelete) {
    if (!await confirmAction('Hapus draft yang belum dibayar ini?')) return;
    workspace.drafts = workspace.drafts.filter(d => d.id !== button.dataset.draftDelete); persistWorkspace(); showDrafts();
  } else {
    const order = (state.recentOrders || []).find(o => o.id === (button.dataset.historyPrint || button.dataset.historyDetail)); if (!order) return;
    const result = {order,payment:order.payment};
    if (button.dataset.historyPrint) printReceipt(result, true);
    else {
      $('#cashier-list-content').innerHTML = '<button type="button" class="button button-secondary" data-history-back>Kembali ke riwayat</button>' + receiptHtml(result) + `<p>Koreksi setelah pembayaran tidak menghapus transaksi. Void/refund ditangani dari kontrol Owner dengan izin dan rekonsiliasi.</p>${state.actor.role === 'owner' ? `<a class="button button-secondary" href="${ownerDashboardHref('/dashboard#orders')}">Buka kontrol pesanan Owner</a>` : ''}`;
    }
  }
}
function finishCheckout(result) {
  lastResult = result;
  workspace.resultOrderId = result.order.id;
  if (pendingCheckout) pendingCheckout.uncertain = false;
  if (['PENDING','UNKNOWN'].includes(result.payment.status)) {
    activeQris = {order:result.order,payment:result.payment,attempt:0}; renderQrisResult(); scheduleQrisPoll();
  } else {
    activeQris = null; pendingCheckout = null; workspace.attempt = null;
    $('#checkout-result').hidden = false; $('#checkout-result').className = 'result-card'; $('#checkout-result').innerHTML = `<p>${result.payment.status === 'PAID' ? 'Pembayaran terkonfirmasi dan diteruskan ke bar.' : 'Belum lunas; periksa status sebelum mencoba lagi.'}</p>` + receiptHtml(result);
  }
  cart.clear(); quote = null; benefits={automaticPromotions:true}; receivedInput.value = ''; $('#member-code').value = ''; $('#reward-id').value = ''; persistWorkspace();
  showScreen('result', true); renderTenderState();
}
function showUnknown(found = null) {
  activeQris = null;
  $('#checkout-result').hidden = false;
  $('#checkout-result').innerHTML = `<strong>Status transaksi perlu diperiksa</strong><p>Jangan membuat pesanan pengganti. Periksa server; ulangi hanya pesanan yang sama dengan identitas transaksi yang sama.</p><button class="button button-secondary" data-recover ${recoveryBusy ? 'disabled' : ''}>Periksa transaksi</button>${found === false ? '<p>Server belum menemukan transaksi ini. Anda boleh mencoba kembali pesanan yang sama.</p><button class="button button-primary" data-retry>Coba lagi pesanan yang sama</button>' : ''}`;
  showScreen('result', true); render();
}
async function recoverAttempt() {
  if (!pendingCheckout || recoveryBusy) return;
  recoveryBusy = true;
  try { const result = await request(`/api/cashier/recovery?key=${encodeURIComponent(pendingCheckout.key)}`); if (result.found) finishCheckout(result); else showUnknown(false); }
  catch { showUnknown(); }
  finally { recoveryBusy = false; const button = $('#checkout-result [data-recover]'); if (button) button.disabled = false; }
}
function receiptHtml({order,payment}) {
  const amounts = [['Subtotal',order.subtotalRupiah],['Diskon',-order.discountRupiah],['Pajak',order.taxRupiah],['Layanan',order.serviceRupiah],['Pembulatan',order.roundingRupiah],['Total',order.totalRupiah]];
  if (payment?.methodType === 'cash') amounts.push(['Uang diterima',payment.receivedRupiah],['Kembalian',payment.changeRupiah]);
  if (order.benefitSnapshot?.discountRupiah) amounts[1][0]='Diskon · '+(order.benefitSnapshot.name??'Benefit diterapkan');
  const refunds=order.refundHistory ?? [],returned=refunds.filter(row=>row.status === 'REFUNDED_LOCAL');
  const refundTotal=returned.every(row=>Number.isSafeInteger(row.amountRupiah) && row.amountRupiah >= 0) ? returned.reduce((sum,row)=>sum+row.amountRupiah,0) : null;
  if (returned.length && Number.isSafeInteger(refundTotal) && refundTotal <= order.totalRupiah) amounts.push(['Dana telah dikembalikan',refundTotal],['Pembayaran tersisa setelah refund',order.totalRupiah-refundTotal]);
  const refundHistory=refunds.length ? `<section aria-label="Riwayat refund nota"><h3>Riwayat refund</h3><p>Total di atas adalah transaksi asli. Permintaan refund belum berarti dana telah dikembalikan.</p>${refunds.map(row=>`<p>${escapeHtml(row.status === 'REFUNDED_LOCAL' ? 'Dana dikembalikan' : row.status === 'PENDING_MANUAL_FINANCE_RECONCILIATION' ? 'Permintaan refund belum terkonfirmasi' : 'Refund perlu diperiksa')} · ${Number.isFinite(Date.parse(row.createdAt)) ? new Date(row.createdAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})+' WIB' : 'Tanggal perlu diperiksa'}<strong>${row.amountRupiah == null ? 'Nominal perlu diperiksa' : rupiah(row.amountRupiah)}</strong></p>`).join('')}</section>` : '';
  return `<section class="cashier-receipt" aria-label="Rincian nota"><h2>SagaPOS · ${escapeHtml(order.orderNumber)}</h2><span>${escapeHtml(order.orderType === 'DINE_IN' ? 'Makan di tempat' : order.orderType === 'TAKEAWAY' ? 'Bawa pulang' : order.orderType)} · ${new Date(order.createdAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB</span><p>Pembayaran <strong>${paymentStatusLabel(payment?.status)}</strong></p><p>Status pesanan <strong>${escapeHtml(({PAID:'Diterima',PREPARING:'Disiapkan',READY:'Siap diambil',COMPLETED:'Selesai',CANCELLED:'Dibatalkan',AWAITING_PAYMENT:'Menunggu pembayaran'})[order.status] || order.status)}</strong></p><ul>${(order.items || []).map(item => `<li class="cashier-review-row"><span>${Number(item.qty)} × ${escapeHtml(item.productNameSnapshot || item.name)}</span><strong>${rupiah(item.lineTotalRupiah ?? item.unitPriceRupiah*item.qty)}</strong><small>${escapeHtml((item.selections || []).map(s=>s.optionLabel).join(' · '))}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></li>`).join('')}</ul>${amounts.filter(([,v])=>v!=null && Number.isFinite(v)).map(([label,value])=>`<p class="${label === 'Total' ? 'cashier-receipt-total' : ''}">${escapeHtml(label)}<strong>${rupiah(value)}</strong></p>`).join('')}<span>${escapeHtml(payment?.methodNameSnapshot || '')}</span>${refundHistory}</section>`;
}
function paymentStatusLabel(status) { return ({PAID:'Lunas',PENDING:'Menunggu pembayaran',UNKNOWN:'Perlu diperiksa',EXPIRED:'Kedaluwarsa',FAILED:'Gagal',REFUNDED:'Dikembalikan',CANCELLED:'Dibatalkan'})[status] || 'Belum terkonfirmasi'; }
async function printReceipt(result, copy = false) {
  try {
    const latest=await request('/api/operator/state?surface=cashier'),order=latest.recentOrders?.find(order=>order.id === result?.order?.id);
    if (!order || !['PAID','REFUNDED'].includes(order.payment?.status)) return announce('Nota belum dapat diverifikasi. Perbarui riwayat; jangan ulangi pembayaran.',true);
    const receipt=$('#cashier-print-receipt');receipt.innerHTML=(copy?'<strong>Salinan nota</strong>':'')+receiptHtml({order,payment:order.payment});window.print();
  } catch { announce('Nota tetap tersimpan. Koneksi/verifikasi gagal; coba cetak ulang dari riwayat, jangan ulangi pembayaran.',true); }
}

async function request(url, { method = "GET", body, csrf = false } = {}) {
  const response = await fetch(url, { method, cache: method === "GET" ? "no-store" : "default", credentials: "same-origin", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(csrf ? { "x-csrf-token": csrfToken } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || "Permintaan gagal."); error.status = response.status; throw error; }
  return data;
}
function announce(message, danger = false) { toast.textContent = message; toast.dataset.danger = danger ? "true" : "false"; toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 3500); }
function rupiah(value) { return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value || 0)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
