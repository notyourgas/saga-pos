import { createApiClient } from "./kiosk/api-client.js";
import { createCheckoutKeyStore } from "./kiosk/checkout-key.js";
import { createCheckoutAttemptStore } from "./kiosk/checkout-attempt.js";
import { createResetIntentStore } from "./kiosk/reset-intent.js";
import { assertPaymentResponse } from "./kiosk/payment-response.js";
import { CART_DRAFT_KEY, createCartDraft, restoreCartDraft } from "./kiosk/cart-draft.js";
import { createFlowMachine, SCREENS, screenForPayment } from "./kiosk/flow-machine.js";
import { rupiah } from "./kiosk/formatters.js";
import { nextPaymentPollDelay, paymentCheckPresentation } from "./kiosk/payment-confidence.js";
import { renderScreen } from "./kiosk/screen-templates.js";

const app = document.querySelector("#kiosk-app");
const toast = document.querySelector("#global-status");
const banner = document.querySelector("#environment-banner");
const networkBanner = document.querySelector("#network-banner");
const idleDialog = document.querySelector("#idle-dialog");
const helpDialog = document.querySelector("#help-dialog");
const helpKicker = document.querySelector("#help-kicker");
const helpTitle = document.querySelector("#help-title");
const helpMessage = document.querySelector("#help-message");
const helpPaymentNote = document.querySelector("#help-payment-note");
const helpCloseAction = document.querySelector("#help-close-action");
const helpCancelAction = document.querySelector("#help-cancel-action");
const helpKeepAction = document.querySelector("#help-keep-action");
const helpConfirmCancelAction = document.querySelector("#help-confirm-cancel-action");
const kioskApiBase = document.body.dataset.kioskApiBase || "/api/kiosk";
const publicMenuDemo = kioskApiBase === "/api/menu-kiosk";
const kioskApi = (path) => `${kioskApiBase}${path}`;
const flow = createFlowMachine();
const checkoutKeys = createCheckoutKeyStore();
const checkoutAttempts = createCheckoutAttemptStore();
const resetIntents = createResetIntentStore();
const SUCCESS_DEFAULT_SECONDS = 30;
const SUCCESS_EXTENSION_SECONDS = 20;
const SUCCESS_MAX_EXTENSIONS = 10;

const state = {
  snapshot: null,
  csrfToken: "",
  catalog: [],
  selectedCategory: "classic",
  orderType: "",
  cart: new Map(),
  modifierDraft: null,
  memberCode: "",
  member: null,
  recommendations: [],
  memberRecoveryNotice: "",
  memberReturnScreen: SCREENS.ORDER_TYPE,
  memberError: "",
  memberLoading: false,
  memberLoadingMethod: "",
  quote: null,
  quoteLoading: false,
  quoteError: "",
  checkoutError: "",
  checkoutLoading: false,
  checkoutAttempt: null,
  paymentMethod: "QRIS",
  cashReceivedRupiah: 0,
  order: null,
  payment: null,
  recoveryMessage: "",
  reconcileLoading: false,
  paymentCheckAttempt: 0,
  paymentCheckLoading: false,
  paymentLastCheckedAt: "",
  paymentExpiryCheckRequested: false,
  outageMessage: "",
  resetPending: false,
  resetLoading: false,
  networkOnline: navigator.onLine !== false,
  removedLine: null,
  cartRecoveryNotice: "",
  storageWarning: false,
  capabilities: { memberInput: false, orderTypes: ["DINE_IN", "TAKEAWAY"], paymentMethods: ["QRIS"], serviceAvailable: true },
};

const request = createApiClient(() => state.csrfToken);
let idleTimer;
let idleCountdownTimer;
let paymentPollTimer;
let paymentCountdownTimer;
let paymentExpiryTimer;
let successTimer;
let successCountdownTimer;
let successDeadlineMs = 0;
let successExtensionCount = 0;
let toastTimer;
let undoTimer;
let quoteRequestRevision = 0;
let helpInvoker = null;
let catalogEvents;

app.addEventListener("click", onClick);
app.addEventListener("input", onInput);
app.addEventListener("keydown", onKeyDown);
app.addEventListener("error", onImageLoadError, true);
idleDialog.addEventListener("click", onClick);
idleDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  continueSession(); // Escape dismisses the warning and cancels its reset countdown.
});
helpDialog.addEventListener("click", onClick);
helpDialog.addEventListener("close", handleHelpDialogClosed);
for (const eventName of ["pointerdown", "keydown"]) window.addEventListener(eventName, scheduleIdle, { passive: true });
window.addEventListener("online", handleNetworkChange);
window.addEventListener("offline", handleNetworkChange);
window.addEventListener("resize", syncKioskViewportHeight, { passive: true });

await initialize();
// Let the initial, finite bootstrap settle before opening the long-lived stream.
// This also keeps navigation and automated readiness probes deterministic.
window.setTimeout(connectCatalogEvents, 1500);

function connectCatalogEvents() {
  if (catalogEvents || typeof EventSource === "undefined") return;
  catalogEvents = new EventSource("/api/catalog/events");
  catalogEvents.addEventListener("catalog-revision", async () => {
    if (state.checkoutLoading || state.payment || state.order) return;
    try {
      const snapshot = await request(kioskApi("/bootstrap"), { method: "POST" });
      hydrateSnapshot(snapshot);
      render();
      if (state.cart.size) await refreshQuote({ renderLoading: false, recoverAvailability: true });
    } catch { /* Existing retry and manual recovery paths remain authoritative. */ }
  });
  catalogEvents.onerror = () => { catalogEvents?.close(); catalogEvents = null; window.setTimeout(connectCatalogEvents, 5000); };
}

function onImageLoadError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.matches("[data-kiosk-image]")) return;
  const frame = image.closest(".hero-drink, .product-visual, .mini-product-visual, .category-photo");
  if (!frame || frame.classList.contains("is-image-unavailable")) return;
  frame.classList.remove("has-image");
  frame.classList.add("is-image-unavailable");
  image.remove();
}

async function initialize() {
  if (state.resetPending) return startFreshSession(true);
  clearRuntimeTimers();
  try {
    const snapshot = await request(kioskApi("/bootstrap"), { method: "POST" });
    hydrateSnapshot(snapshot);
    if (resetIntents.matches(snapshot)) {
      assertPaymentResponse({ order: snapshot.activeOrder, payment: snapshot.payment });
      state.order = snapshot.activeOrder;
      state.resetPending = true;
      return startFreshSession(true);
    }
    if (state.capabilities.serviceAvailable === false || !state.catalog.length) {
      state.outageMessage = "Menu atau pembayaran belum siap digunakan.";
      flow.restore(SCREENS.OUT_OF_SERVICE);
    } else if (snapshot.activeOrder) {
      assertPaymentResponse({ order: snapshot.activeOrder, payment: snapshot.payment });
      checkoutAttempts.clear();
      clearCartDraft();
      state.order = snapshot.activeOrder;
      state.payment = snapshot.payment;
      flow.restore(screenForPayment(snapshot.payment, snapshot.activeOrder));
    } else {
      const attempt = checkoutAttempts.read(snapshot.session?.id);
      if (attempt) {
        state.checkoutAttempt = attempt;
        state.orderType = attempt.orderType;
        state.cart = new Map(attempt.cart.map((line, index) => {
          const id = `attempt-restored-${index + 1}`;
          return [id, { ...structuredClone(line), id }];
        }));
        state.quote = { ...attempt.expectedQuote, quoteFingerprint: attempt.expectedQuote.fingerprint };
        state.checkoutError = "Pesanan yang belum terkonfirmasi dipulihkan. Periksa statusnya tanpa mengubah pesanan atau membayar ulang.";
        flow.restore(SCREENS.CART);
        return render();
      }
      const recovery = restoreCartDraft(readCartDraft(), {
        sessionId: snapshot.session?.id,
        catalog: state.catalog,
      });
      if (recovery.status === "restored" || recovery.droppedCount > 0) {
        state.orderType = recovery.orderType;
        state.selectedCategory = recovery.selectedCategory;
        state.cart = new Map(recovery.lines.map((line) => [line.id, line]));
        state.cartRecoveryNotice = recovery.droppedCount
          ? `${recovery.droppedCount} menu tidak dipulihkan karena menu atau pilihannya sudah berubah. Tambahkan kembali dan pilih ulang agar pesananmu sesuai.`
          : "Pesananmu dipulihkan setelah halaman dimuat ulang. Total sudah diperiksa kembali oleh server.";
        flow.restore(SCREENS.CART);
      } else if (snapshot.memberContext?.member && snapshot.memberContext?.orderType) {
        clearCartDraft();
        state.orderType = snapshot.memberContext.orderType;
        state.selectedCategory = state.recommendations.length ? "for-you" : (state.catalog[0]?.id || "classic");
        state.memberRecoveryNotice = "Pilihan member dipulihkan dengan aman";
        flow.restore(SCREENS.MEMBER_WELCOME);
      } else {
        clearCartDraft();
        flow.restore(SCREENS.WELCOME);
      }
    }
    render();
    if (flow.current === SCREENS.CART && state.cartRecoveryNotice) await refreshQuote({ renderLoading: false }).catch(() => {});
  } catch (error) {
    state.outageMessage = customerSafeOutageMessage(error);
    flow.restore(SCREENS.OUT_OF_SERVICE);
    render();
  }
}

function hydrateSnapshot(snapshot) {
  state.snapshot = snapshot;
  state.csrfToken = snapshot.csrfToken;
  state.catalog = snapshot.catalog || [];
  state.member = snapshot.memberContext?.member || null;
  state.recommendations = snapshot.memberContext?.recommendations || [];
  state.selectedCategory = state.catalog.some((item) => item.id === state.selectedCategory) ? state.selectedCategory : state.catalog[0]?.id;
  state.capabilities = snapshot.capabilities || {
    memberInput: Boolean(snapshot.context?.memberCode),
    orderTypes: ["DINE_IN", "TAKEAWAY"],
    paymentMethods: ["QRIS"],
    serviceAvailable: Boolean(state.catalog.length),
  };
  if (!state.capabilities.paymentMethods?.includes(state.paymentMethod)) {
    state.paymentMethod = state.capabilities.paymentMethods?.[0] || "QRIS";
    state.cashReceivedRupiah = 0;
  }
  const prototypeMode = snapshot.context?.paymentMode === "OFF";
  banner.hidden = !publicMenuDemo && Boolean(snapshot.context?.production) && !prototypeMode;
  banner.classList.toggle("is-prototype", prototypeMode || publicMenuDemo);
  if (!banner.hidden) {
    banner.textContent = publicMenuDemo
      ? "PUBLIC DEMO · QRIS & tunai simulator · tidak membuat transaksi nyata"
      : prototypeMode
      ? "PREVIEW OPERASIONAL · pembayaran belum aktif; tidak masuk penjualan, stok, HPP, atau settlement"
      : snapshot.context?.publicExposure
      ? "PUBLIC DEMO · QRIS simulator · tidak membuat transaksi nyata"
      : "LOCAL VALIDATION · QRIS simulator · tidak membuat transaksi nyata";
  }
}

function model() {
  return {
    ...state,
    screen: flow.current,
    productById,
    productCategory,
  };
}

function render() {
  const wasCheckoutRecovery = Boolean(app.querySelector(".checkout-recovery-screen"));
  const previousScreen = app.dataset.screen || "";
  const focusTarget = previousScreen === flow.current ? captureFocusTarget() : null;
  const browseScrollPosition = previousScreen === SCREENS.BROWSE ? captureBrowseScrollPosition() : null;
  const modifierScrollPosition = previousScreen === SCREENS.MODIFIER && flow.current === SCREENS.MODIFIER
    ? app.querySelector(".modifier-content")?.scrollTop : null;
  if (previousScreen && previousScreen !== flow.current) hideToast();
  app.innerHTML = renderScreen(flow.current, model());
  if (previousScreen && previousScreen !== flow.current) app.firstElementChild?.classList.add("is-entering");
  app.dataset.screen = flow.current;
  document.documentElement.dataset.kioskScreen = flow.current;
  document.documentElement.dataset.checkoutRecovery = String(Boolean(state.checkoutAttempt));
  if (previousScreen !== flow.current || (!wasCheckoutRecovery && state.checkoutAttempt)) focusScreenHeading();
  else restoreFocusTarget(focusTarget);
  if (flow.current === SCREENS.BROWSE) restoreBrowseScrollPosition(browseScrollPosition);
  if (Number.isFinite(modifierScrollPosition)) {
    const options = app.querySelector(".modifier-content");
    if (options) options.scrollTop = modifierScrollPosition;
  }
  updateNetworkBanner();
  configureScreenTimers();
  scheduleIdle();
}

function captureBrowseScrollPosition() {
  const rail = app.querySelector(".category-rail");
  const grid = app.querySelector(".product-grid");
  return {
    category: rail?.querySelector('[aria-current="true"]')?.dataset.value || "",
    categoryRail: rail?.scrollTop ?? 0,
    categoryRailInline: rail?.scrollLeft ?? 0,
    productGrid: grid?.scrollTop ?? 0,
  };
}

function restoreBrowseScrollPosition(previousPosition) {
  const rail = app.querySelector(".category-rail");
  const grid = app.querySelector(".product-grid");
  if (!rail || !grid) return;
  const sameCategory = previousPosition?.category === state.selectedCategory;
  if (sameCategory && Number.isFinite(previousPosition?.categoryRail)) rail.scrollTop = previousPosition.categoryRail;
  if (sameCategory && Number.isFinite(previousPosition?.categoryRailInline)) rail.scrollLeft = previousPosition.categoryRailInline;
  if (previousPosition?.category === state.selectedCategory && Number.isFinite(previousPosition.productGrid)) {
    grid.scrollTop = previousPosition.productGrid;
  } else {
    grid.scrollTop = 0;
  }
  const active = [...rail.querySelectorAll('[data-action="select-category"]')]
    .find((element) => element.dataset.value === state.selectedCategory);
  if (!active || sameCategory) return;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  active.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
}

function syncKioskViewportHeight() {
  const chromeHeight = [banner, networkBanner]
    .filter((element) => element && !element.hidden)
    .reduce((height, element) => height + element.getBoundingClientRect().height, 0);
  app.style.setProperty("--kiosk-viewport-height", `${Math.max(0, window.innerHeight - chromeHeight)}px`);
}

function configureScreenTimers() {
  clearTimeout(paymentPollTimer);
  clearInterval(paymentCountdownTimer);
  clearTimeout(paymentExpiryTimer);
  clearTimeout(successTimer);
  clearInterval(successCountdownTimer);
  if (flow.current === SCREENS.PAYMENT_PENDING) {
    updatePaymentCountdown();
    if (state.payment?.expiresAt) {
      paymentExpiryTimer = window.setTimeout(updatePaymentCountdown, Math.max(0, new Date(state.payment.expiresAt).getTime() - Date.now()));
    }
    paymentCountdownTimer = window.setInterval(updatePaymentCountdown, 1000);
    const delay = nextPaymentPollDelay(state.paymentCheckAttempt);
    if ((state.payment?.simulator === false || state.payment?.staticQrisDemo === true) && state.networkOnline && delay !== null && !state.paymentCheckLoading) {
      paymentPollTimer = window.setTimeout(() => refreshPaymentStatus({ manual: false }), delay);
    }
  }
  if (flow.current === SCREENS.SUCCESS) {
    if (!successDeadlineMs) {
      successDeadlineMs = Date.now() + SUCCESS_DEFAULT_SECONDS * 1000;
      successExtensionCount = 0;
    }
    scheduleSuccessReset();
  } else {
    successDeadlineMs = 0;
    successExtensionCount = 0;
  }
}

async function onClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if ((state.checkoutAttempt || state.checkoutLoading) && !["checkout", "help", "close-help", "keep-session"].includes(action)) return;
  try {
    if (action === "start-order") return go(SCREENS.ORDER_TYPE);
    if (action === "back-welcome") return go(SCREENS.WELCOME);
    if (action === "select-order-type") { state.orderType = button.dataset.value; persistCartDraft(); return render(); }
    if (action === "continue-menu") {
      state.memberReturnScreen = SCREENS.ORDER_TYPE;
      return state.capabilities.memberInput ? go(SCREENS.MEMBER) : go(SCREENS.BROWSE);
    }
    if (action === "back-order-type") return go(SCREENS.ORDER_TYPE);
    if (action === "back-member") return go(SCREENS.MEMBER);
    if (action === "back-member-welcome") return go(state.member ? SCREENS.MEMBER_WELCOME : SCREENS.MEMBER);
    if (action === "continue-recommendations") return go(SCREENS.BROWSE);
    if (action === "select-category") { state.selectedCategory = button.dataset.value; persistCartDraft(); return render(); }
    if (action === "open-product") return openProduct(button.dataset.product);
    if (action === "close-modifier") return go(state.modifierDraft?.returnScreen || SCREENS.BROWSE);
    if (action === "toggle-modifier") return toggleModifier(button.dataset);
    if (action === "modifier-qty") return changeModifierQuantity(Number(button.dataset.delta));
    if (action === "save-modifier") return saveModifier();
    if (action === "open-cart") return await openCart();
    if (action === "retry-quote") {
      if (flow.current !== SCREENS.CART || state.quoteLoading || state.checkoutLoading || !state.networkOnline || !state.cart.size) return;
      try {
        await refreshQuote();
      } catch (error) {
        if (flow.current === SCREENS.CART && !state.quoteLoading) document.querySelector('[data-action="retry-quote"]')?.focus({ preventScroll: true });
        throw error;
      }
      if (flow.current === SCREENS.CART && !state.quoteLoading && !state.quoteError && state.cart.size) {
        document.querySelector('[data-action="continue-payment"]')?.focus({ preventScroll: true });
      }
      return;
    }
    if (action === "back-menu") return go(SCREENS.BROWSE);
    if (action === "cart-order-type") return changeCartOrderType(button.dataset.value);
    if (action === "cart-qty") return changeCartQuantity(button.dataset.line, Number(button.dataset.delta));
    if (action === "remove-line") return removeCartLine(button.dataset.line);
    if (action === "undo-remove") return undoRemove();
    if (action === "dismiss-cart-recovery") { state.cartRecoveryNotice = ""; return render(); }
    if (action === "edit-line") return editLine(button.dataset.line);
    if (action === "continue-payment") return state.member ? go(SCREENS.PAYMENT_METHOD) : continueToPayment();
    if (action === "change-member") { state.memberReturnScreen = SCREENS.CART; return go(SCREENS.MEMBER); }
    if (action === "back-cart") return go(SCREENS.CART);
    if (action === "select-payment-method") {
      const method = String(button.dataset.value || "QRIS").toUpperCase();
      if (method === "CASH_ASSISTED" && !state.capabilities?.assistedCash?.available) return announce("Pembayaran tunai belum dapat dipilih karena shift kasir belum aktif.", true);
      if (method === "QRIS_STATIC_DEMO" && !state.capabilities?.staticQrisDemo?.enabled) return announce("QRIS statis demo belum tersedia.", true);
      if (method === "QRIS_STATIC_MANUAL" && !state.capabilities?.manualQris?.enabled) return announce("QRIS merchant belum tersedia.", true);
      state.paymentMethod = method;
      state.cashReceivedRupiah = 0;
      return render();
    }
    if (action === "select-cash-tender") {
      state.cashReceivedRupiah = Number(button.dataset.value || 0);
      render();
      return document.querySelector('[data-action="checkout"]')?.focus({ preventScroll: true });
    }
    if (action === "skip-member") return await skipMember();
    if (action === "simulate-nfc") return await simulateNfc();
    if (action === "submit-member") return await submitMember();
    if (action === "checkout") return await checkout();
    if (action === "simulate-paid") return await simulatePaid(button);
    if (action === "check-payment") return await refreshPaymentStatus({ manual: true });
    if (action === "reconcile-payment") return await reconcilePayment();
    if (action === "extend-success") return extendSuccessTime();
    if (action === "finish-order") return await startFreshSession(true);
    if (action === "retry-boot") return await initialize();
    if (action === "continue-session") return continueSession();
    if (action === "reset-session") return await startFreshSession(true);
    if (action === "help") return openHelpDialog();
    if (action === "close-help") return closeHelpDialog();
    if (action === "request-session-cancel") return showSessionCancelConfirmation();
    if (action === "keep-session") return closeHelpDialog();
    if (action === "confirm-session-cancel") {
      button.disabled = true;
      button.textContent = "Membatalkan…";
      return await startFreshSession(true);
    }
  } catch (error) {
    if (!error?.handled) announce(error.message, true);
  }
}

function scheduleSuccessReset() {
  clearTimeout(successTimer);
  clearInterval(successCountdownTimer);
  updateSuccessCountdown();
  const delay = Math.max(0, successDeadlineMs - Date.now());
  successCountdownTimer = window.setInterval(updateSuccessCountdown, 250);
  successTimer = window.setTimeout(() => startFreshSession(true), delay);
}

function updateSuccessCountdown() {
  if (flow.current !== SCREENS.SUCCESS || !successDeadlineMs) return;
  const remaining = Math.max(0, Math.ceil((successDeadlineMs - Date.now()) / 1000));
  const element = document.querySelector("#success-countdown");
  if (element) element.textContent = String(remaining);
}

function extendSuccessTime() {
  if (flow.current !== SCREENS.SUCCESS || successExtensionCount >= SUCCESS_MAX_EXTENSIONS) return;
  const currentRemainingSeconds = Math.ceil(Math.max(0, successDeadlineMs - Date.now()) / 1000);
  const nextRemainingSeconds = Math.min(
    SUCCESS_DEFAULT_SECONDS + SUCCESS_MAX_EXTENSIONS * SUCCESS_EXTENSION_SECONDS,
    currentRemainingSeconds + SUCCESS_EXTENSION_SECONDS,
  );
  successDeadlineMs = Date.now() + nextRemainingSeconds * 1000;
  successExtensionCount += 1;
  scheduleSuccessReset();
  const button = document.querySelector('[data-action="extend-success"]');
  if (button && successExtensionCount >= SUCCESS_MAX_EXTENSIONS) {
    button.disabled = true;
    const label = button.querySelector("span");
    if (label) label.textContent = "Waktu maksimal ditambahkan";
  }
  announce(`Waktu melihat detail ditambah ${SUCCESS_EXTENSION_SECONDS} detik.`);
}

function onInput(event) {
  if (event.target.id === "modifier-note" && state.modifierDraft) state.modifierDraft.note = event.target.value.slice(0, 120);
  if (event.target.id === "member-code") {
    state.memberCode = event.target.value.slice(0, 80);
    state.memberError = "";
    const submit = document.querySelector('[data-action="submit-member"]');
    if (submit) submit.disabled = !state.memberCode.trim() || state.memberLoading || !state.networkOnline;
  }
  if (event.target.id === "cash-received") {
    state.cashReceivedRupiah = Number(String(event.target.value || "").replace(/\D/g, "")) || 0;
    updateCashTenderPreview();
  }
}

function onKeyDown(event) {
  const current = event.target.closest('[role="radio"][data-action="select-order-type"]');
  if (!current || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
  event.preventDefault();
  const options = [...app.querySelectorAll('[role="radio"][data-action="select-order-type"]')];
  const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
  const next = options[(options.indexOf(current) + direction + options.length) % options.length];
  state.orderType = next.dataset.value;
  render();
}

function go(screen) {
  flow.go(screen);
  render();
}

function productById(productId) {
  return state.catalog.flatMap((category) => category.products).find((product) => product.id === productId);
}

function productCategory(productId) {
  return state.catalog.find((category) => category.products.some((product) => product.id === productId))?.id || "classic";
}

function openProduct(productId) {
  const product = productById(productId);
  if (!product || product.available === false) return announce("Menu ini sedang tidak tersedia.", true);
  state.modifierDraft = {
    product,
    qty: 1,
    selections: [],
    note: "",
    editingLineId: null,
    returnScreen: flow.current === SCREENS.MEMBER_WELCOME ? SCREENS.MEMBER_WELCOME : SCREENS.BROWSE,
    saveReturnScreen: SCREENS.BROWSE,
  };
  go(SCREENS.MODIFIER);
}

function toggleModifier(data) {
  if (!state.modifierDraft) return;
  const exact = state.modifierDraft.selections.find((item) => item.groupId === data.group && item.optionId === data.option);
  if (exact) {
    state.modifierDraft.selections = state.modifierDraft.selections.filter((item) => !(item.groupId === data.group && item.optionId === data.option));
  } else {
    const max = Math.max(1, Number(data.max || 1));
    const inGroup = state.modifierDraft.selections.filter((item) => item.groupId === data.group);
    if (max === 1) state.modifierDraft.selections = state.modifierDraft.selections.filter((item) => item.groupId !== data.group);
    if (max > 1 && inGroup.length >= max) return announce(`Pilih maksimal ${max} tambahan.`, true);
    state.modifierDraft.selections.push({
      groupId: data.group,
      groupLabel: data.groupLabel,
      optionId: data.option,
      optionLabel: data.optionLabel,
      priceDeltaRupiah: Number(data.price || 0),
    });
  }
  render();
}

function changeCartOrderType(orderType) {
  if (!state.capabilities.orderTypes?.includes(orderType)) return announce("Tipe pesanan tidak tersedia.", true);
  state.orderType = orderType;
  state.quote = null;
  state.checkoutError = "";
  persistCartDraft();
  render();
  refreshQuote().catch(() => {});
}

function changeModifierQuantity(delta) {
  if (!state.modifierDraft) return;
  state.modifierDraft.qty = Math.min(20, Math.max(1, state.modifierDraft.qty + delta));
  render();
}

function saveModifier() {
  const draft = state.modifierDraft;
  if (!draft) return;
  // Only coalesce new, exactly configured additions. Editing remains line-local.
  const note = String(draft.note || "").trim();
  const selectionKey = (selections) => JSON.stringify(selections.map(({ groupId, optionId }) => [groupId, optionId]));
  const matchingLine = !draft.editingLineId && [...state.cart.values()].find((line) =>
    line.productId === draft.product.id && line.note === note
    && selectionKey(line.selections) === selectionKey(draft.selections)
    && line.qty + draft.qty <= 20);
  const lineId = draft.editingLineId || matchingLine?.id || crypto.randomUUID();
  state.cart.set(lineId, {
    id: lineId,
    productId: draft.product.id,
    qty: draft.qty + (matchingLine?.qty || 0),
    selections: structuredClone(draft.selections),
    note,
  });
  state.modifierDraft = null;
  state.quote = null;
  persistCartDraft();
  go(draft.saveReturnScreen || draft.returnScreen || SCREENS.BROWSE);
  announce(matchingLine ? `${draft.product.name} digabung menjadi ${state.cart.get(lineId).qty}.`
    : `${draft.product.name} ${draft.editingLineId ? "diperbarui" : "ditambahkan"}.`);
}

async function openCart() {
  go(SCREENS.CART);
  await refreshQuote();
}

function changeCartQuantity(lineId, delta) {
  const line = state.cart.get(lineId);
  if (!line) return;
  const qty = line.qty + delta;
  if (qty <= 0) {
    clearTimeout(undoTimer);
    state.cart.delete(lineId);
    state.removedLine = { line: structuredClone(line), productName: productById(line.productId)?.name || line.productId };
    undoTimer = window.setTimeout(() => {
      state.removedLine = null;
      if (flow.current === SCREENS.CART) render();
    }, 7000);
  } else {
    state.cart.set(lineId, { ...line, qty: Math.min(20, qty) });
  }
  state.quote = null;
  state.checkoutError = "";
  persistCartDraft();
  render();
  if (qty <= 0) document.querySelector('[data-action="undo-remove"]')?.focus({ preventScroll: true });
  refreshQuote().catch(() => {});
}

function removeCartLine(lineId) {
  const line = state.cart.get(lineId);
  if (!line) return;
  clearTimeout(undoTimer);
  state.cart.delete(lineId);
  state.removedLine = { line: structuredClone(line), productName: productById(line.productId)?.name || line.productId };
  undoTimer = window.setTimeout(() => {
    state.removedLine = null;
    if (flow.current === SCREENS.CART) render();
  }, 7000);
  state.quote = null;
  state.checkoutError = "";
  persistCartDraft();
  render();
  document.querySelector('[data-action="undo-remove"]')?.focus({ preventScroll: true });
  refreshQuote().catch(() => {});
}

function undoRemove() {
  if (!state.removedLine) return;
  clearTimeout(undoTimer);
  const restored = state.removedLine.line;
  state.cart.set(restored.id, restored);
  state.removedLine = null;
  state.quote = null;
  persistCartDraft();
  render();
  refreshQuote().catch(() => {});
}

function editLine(lineId) {
  const line = state.cart.get(lineId);
  const product = line ? productById(line.productId) : null;
  if (!line || !product) return;
  state.modifierDraft = { product, qty: line.qty, selections: structuredClone(line.selections), note: line.note, editingLineId: lineId, returnScreen: SCREENS.CART };
  go(SCREENS.MODIFIER);
}

async function refreshQuote({ renderLoading = true, recoverAvailability = true } = {}) {
  const requestRevision = ++quoteRequestRevision;
  if (!state.cart.size) {
    state.quote = null;
    state.quoteLoading = false;
    state.quoteError = "Tambahkan minimal satu menu.";
    render();
    return null;
  }
  state.quoteLoading = true;
  state.quoteError = "";
  if (renderLoading) render();
  try {
    const quote = await request(kioskApi("/quote"), {
      method: "POST",
      csrf: true,
      body: { cart: cartPayload(), orderType: state.orderType || "DINE_IN", paymentMethod: state.paymentMethod },
    });
    if (requestRevision === quoteRequestRevision) state.quote = quote;
    return quote;
  } catch (error) {
    if (requestRevision === quoteRequestRevision && recoverAvailability && error.code === "active_product_required") {
      let recovered = false;
      try {
        recovered = await reconcileUnavailableCartItems();
      } catch (recoveryError) {
        if (recoveryError.status >= 500) recoveryError.message = "Ketersediaan menu belum dapat diperiksa. Coba hitung ulang sebentar lagi.";
        if (requestRevision === quoteRequestRevision) state.quoteError = recoveryError.message;
        throw recoveryError;
      }
      if (recovered) {
        if (state.cart.size) await refreshQuote({ renderLoading: false, recoverAvailability: false });
        const handled = new Error("Keranjang sudah disesuaikan dengan menu yang tersedia.");
        handled.code = "availability_reconciled";
        handled.handled = true;
        throw handled;
      }
    }
    if (error.status >= 500) error.message = "Total belum dapat dikonfirmasi. Coba hitung ulang sebentar lagi.";
    if (requestRevision === quoteRequestRevision) state.quoteError = error.message;
    throw error;
  } finally {
    if (requestRevision === quoteRequestRevision) {
      state.quoteLoading = false;
      render();
    }
  }
}

async function skipMember() {
  if (state.member) {
    state.memberLoading = true;
    state.memberError = "";
    render();
    try {
      await request(kioskApi("/member/clear"), { method: "POST", csrf: true });
    } catch (error) {
      state.memberLoading = false;
      state.memberError = error.message;
      return render();
    }
  }
  state.memberLoading = false;
  state.memberLoadingMethod = "";
  state.memberCode = "";
  state.member = null;
  state.recommendations = [];
  state.memberRecoveryNotice = "";
  state.memberError = "";
  state.selectedCategory = state.catalog[0]?.id || "classic";
  if (state.memberReturnScreen === SCREENS.CART) {
    state.memberReturnScreen = SCREENS.ORDER_TYPE;
    state.quote = null;
    go(SCREENS.CART);
    return refreshQuote().catch(() => {});
  }
  state.memberReturnScreen = SCREENS.ORDER_TYPE;
  go(SCREENS.BROWSE);
}

async function submitMember() {
  const input = document.querySelector("#member-code");
  state.memberCode = String(input?.value || "").trim();
  if (!state.memberCode) return skipMember();
  state.memberLoading = true;
  state.memberLoadingMethod = "code";
  state.memberError = "";
  render();
  try {
    const result = await request(kioskApi("/member/resolve"), {
      method: "POST",
      csrf: true,
      body: { memberCode: state.memberCode, orderType: state.orderType },
    });
    await acceptResolvedMember(result);
  } catch (error) {
    state.memberLoading = false;
    state.memberLoadingMethod = "";
    if (error?.handled) return render();
    state.memberError = error.message;
    state.quoteError = "";
    render();
  }
}

async function simulateNfc() {
  if (!state.capabilities.nfcSimulatorAvailable || state.memberLoading) return;
  if (!state.networkOnline) return announce("Tap NFC memerlukan koneksi untuk verifikasi server. Kamu tetap dapat melanjutkan sebagai guest.", true);
  state.memberLoading = true;
  state.memberLoadingMethod = "nfc";
  state.memberError = "";
  render();
  try {
    const result = await request(kioskApi("/member/simulate-nfc"), {
      method: "POST",
      csrf: true,
      body: { orderType: state.orderType },
    });
    await acceptResolvedMember(result);
  } catch (error) {
    state.memberLoading = false;
    state.memberLoadingMethod = "";
    state.memberError = error.message;
    render();
  }
}

async function acceptResolvedMember(result) {
  state.memberLoading = false;
  state.memberLoadingMethod = "";
  state.member = result.member;
  state.recommendations = result.recommendations || [];
  state.memberRecoveryNotice = "";
  state.memberCode = "";
  state.selectedCategory = state.recommendations.length ? "for-you" : (state.catalog[0]?.id || "classic");
  if (state.memberReturnScreen === SCREENS.CART) {
    state.memberReturnScreen = SCREENS.ORDER_TYPE;
    state.quote = null;
    go(SCREENS.CART);
    await refreshQuote({ renderLoading: false });
    return announce(`Member ${state.member.codeMasked} terhubung. Total sudah dihitung ulang.`);
  }
  state.memberReturnScreen = SCREENS.ORDER_TYPE;
  go(SCREENS.MEMBER_WELCOME);
  announce(`Selamat datang, ${state.member.displayName}. Rekomendasi untukmu sudah siap.`);
}

async function checkout() {
  if (state.checkoutLoading) return;
  if (!state.networkOnline) return announce("Koneksi internet terputus. Sambungkan kembali sebelum membayar.", true);
  state.checkoutLoading = true;
  state.checkoutError = "";
  render();
  try {
    if (!state.checkoutAttempt) {
      const quote = await refreshQuote({ renderLoading: false });
      if (!quote) throw new Error("Harga pesanan belum tersedia.");
      const idempotencyKey = checkoutKeys.get();
      state.checkoutAttempt = {
        cart: cartPayload(),
        idempotencyKey,
        orderType: state.orderType || "DINE_IN",
        paymentMethod: state.paymentMethod,
        ...(state.paymentMethod === "CASH_ASSISTED" ? { receivedRupiah: state.cashReceivedRupiah } : {}),
        testMode: state.snapshot?.context?.paymentMode === "OFF",
        expectedQuote: {
          fingerprint: quote.quoteFingerprint,
          catalogVersion: quote.catalogVersion,
          totalRupiah: quote.totalRupiah,
          expiresAt: quote.expiresAt,
        },
      };
      checkoutAttempts.save(state.snapshot?.session?.id, state.checkoutAttempt);
    }
    render();
    const result = await request(kioskApi("/checkouts"), {
      method: "POST",
      csrf: true,
      body: state.checkoutAttempt,
    });
    assertPaymentResponse(result);
    checkoutAttempts.clear();
    state.checkoutAttempt = null;
    state.order = result.order;
    state.payment = result.payment;
    clearCartDraft();
    resetPaymentCheckState();
    state.checkoutLoading = false;
    flow.restore(screenForPayment(result.payment, result.order));
    render();
  } catch (error) {
    if (state.checkoutAttempt && (!error.status || error.status >= 500 || error.code === "active_order_exists")) {
      try {
        const snapshot = await request(kioskApi("/state"));
        if (snapshot.activeOrder) {
          assertPaymentResponse({ order: snapshot.activeOrder, payment: snapshot.payment });
          state.order = snapshot.activeOrder;
          state.payment = snapshot.payment;
          checkoutAttempts.clear();
          state.checkoutAttempt = null;
          state.checkoutLoading = false;
          clearCartDraft();
          resetPaymentCheckState();
          flow.restore(screenForPayment(snapshot.payment, snapshot.activeOrder));
          return render();
        }
      } catch { /* Preserve the exact attempt until it can be reconciled. */ }
      state.checkoutLoading = false;
      state.checkoutError = "Koneksi terputus saat menyiapkan pesanan. Periksa kembali tanpa mengubah pesanan atau membayar ulang.";
      return render();
    }
    state.checkoutLoading = false;
    checkoutAttempts.clear();
    state.checkoutAttempt = null;
    if (error?.handled) return render();
    if (["checkout_quote_changed", "checkout_quote_expired"].includes(error?.code)) {
      return recoverChangedCheckoutQuote(state.quote, error);
    }
    state.checkoutError = error.message;
    render();
  }
}

async function recoverChangedCheckoutQuote(previousQuote, checkoutError) {
  checkoutKeys.clear();
  state.checkoutError = "";
  state.quoteError = "";
  state.quote = null;
  try {
    const snapshot = await request(kioskApi("/state"));
    if (snapshot.activeOrder) throw new Error("Pesanan aktif ditemukan. Muat ulang untuk melanjutkan dengan aman.");
    hydrateSnapshot(snapshot);
    flow.restore(SCREENS.CART);
    const currentQuote = await refreshQuote({ renderLoading: false });
    const changedTotal = Number(previousQuote?.totalRupiah) !== Number(currentQuote?.totalRupiah);
    state.cartRecoveryNotice = changedTotal
      ? `Total berubah dari ${rupiah(previousQuote?.totalRupiah)} menjadi ${rupiah(currentQuote?.totalRupiah)}. Periksa kembali sebelum membayar.`
      : checkoutError.code === "checkout_quote_expired"
        ? "Konfirmasi total sudah diperbarui karena waktunya habis. Periksa kembali sebelum membayar."
        : "Menu atau benefit berubah. Total sudah diperiksa kembali. Periksa sebelum membayar.";
    persistCartDraft();
    render();
    announce(state.cartRecoveryNotice);
  } catch (recoveryError) {
    flow.restore(SCREENS.CART);
    state.checkoutError = recoveryError.message || "Total belum dapat diperbarui. Coba lagi sebelum membayar.";
    render();
  }
}

async function reconcileUnavailableCartItems() {
  const previousNames = new Map(state.catalog.flatMap((category) => category.products).map((product) => [product.id, product.name]));
  const snapshot = await request(kioskApi("/state"));
  if (snapshot.activeOrder) return false;
  hydrateSnapshot(snapshot);
  const removedNames = [];
  for (const [lineId, line] of state.cart) {
    const product = productById(line.productId);
    if (product && product.available !== false && product.status !== "sold_out") continue;
    removedNames.push(previousNames.get(line.productId) || line.productId);
    state.cart.delete(lineId);
  }
  if (!removedNames.length) return false;
  state.quote = null;
  state.quoteError = "";
  state.checkoutError = "";
  const itemLabel = removedNames.length === 1 ? removedNames[0] : `${removedNames.length} menu`;
  state.cartRecoveryNotice = state.cart.size
    ? `${itemLabel} baru saja habis dan dilepas dari pesananmu. Item lain tetap tersimpan.`
    : `${itemLabel} baru saja habis dan dilepas dari pesananmu. Pilih menu pengganti untuk melanjutkan.`;
  persistCartDraft();
  flow.restore(state.cart.size ? SCREENS.CART : SCREENS.BROWSE);
  return true;
}

async function simulatePaid(button) {
  button.disabled = true;
  try {
    const result = await request(kioskApi("/payments/simulate-paid"), {
      method: "POST",
      csrf: true,
      body: { paymentId: state.payment.id, callbackId: `browser:${state.payment.id}` },
    });
    applyPaymentResult(result);
  } catch (error) {
    button.disabled = false;
    announce(error.message, true);
  }
}

async function refreshPaymentStatus({ manual = false } = {}) {
  if (flow.current !== SCREENS.PAYMENT_PENDING || (state.payment?.simulator !== false && state.payment?.staticQrisDemo !== true)) return;
  if (state.paymentCheckLoading) return;
  if (!state.networkOnline) {
    updatePaymentPendingUi();
    return;
  }
  clearTimeout(paymentPollTimer);
  state.paymentCheckLoading = true;
  if (manual) updatePaymentPendingUi();
  try {
    const result = await request(kioskApi("/payments/status"), { method: "POST", csrf: true, body: { paymentId: state.payment.id } });
    state.paymentCheckAttempt += 1;
    state.paymentLastCheckedAt = new Date().toISOString();
    state.paymentCheckLoading = false;
    applyPaymentResult(result);
  } catch (error) {
    state.paymentCheckLoading = false;
    if (navigator.onLine === false) {
      state.networkOnline = false;
      updateNetworkBanner();
      updatePaymentPendingUi();
      return;
    }
    showRecovery(error);
  }
}

async function reconcilePayment() {
  state.reconcileLoading = true;
  render();
  try {
    const result = await request(kioskApi("/payments/status"), { method: "POST", csrf: true, body: { paymentId: state.payment.id } });
    state.reconcileLoading = false;
    state.paymentCheckAttempt += 1;
    state.paymentLastCheckedAt = new Date().toISOString();
    applyPaymentResult(result);
  } catch (error) {
    state.reconcileLoading = false;
    state.recoveryMessage = recoveryMessage(error.code);
    render();
  }
}

function applyPaymentResult(result) {
  assertPaymentResponse(result, { orderId: state.order?.id, paymentId: state.payment?.id });
  const previousScreen = flow.current;
  state.order = result.order;
  state.payment = result.payment;
  const next = screenForPayment(result.payment, result.order);
  flow.restore(next);
  if (previousScreen === SCREENS.PAYMENT_PENDING && next === SCREENS.PAYMENT_PENDING) {
    updatePaymentPendingUi();
    configureScreenTimers();
    return;
  }
  if (next === SCREENS.SUCCESS) {
    checkoutKeys.clear();
    state.cart.clear();
    resetPaymentCheckState();
  }
  render();
}

function showRecovery(error) {
  state.recoveryMessage = recoveryMessage(error.code);
  if (state.payment && /expired/.test(error.code || "")) state.payment.status = "EXPIRED";
  if (state.payment && /failed/.test(error.code || "")) state.payment.status = "FAILED";
  if (state.payment && /cancelled/.test(error.code || "")) state.payment.status = "CANCELLED";
  flow.go(SCREENS.PAYMENT_RECOVERY);
  render();
}

function recoveryMessage(code) {
  if (/expired/.test(code || "")) return "QRIS sudah kedaluwarsa. Pesanan belum kami proses.";
  if (/failed/.test(code || "")) return "Pembayaran belum berhasil dikonfirmasi. Pesanan belum kami proses.";
  if (/cancelled/.test(code || "")) return "Pembayaran dibatalkan. Pesanan belum kami proses.";
  return "Status pembayaranmu belum dapat dipastikan. Pesanan belum kami proses.";
}

async function startFreshSession(showWelcome = true) {
  if (state.checkoutAttempt || state.checkoutLoading || state.resetLoading) return;
  state.resetPending = state.resetPending || Boolean(state.order);
  if (state.resetPending) resetIntents.save(state.snapshot?.session?.id, state.order?.id);
  state.resetLoading = true;
  clearRuntimeTimers();
  state.outageMessage = "Menyiapkan sesi baru. Detail pesanan sebelumnya disembunyikan.";
  flow.restore(SCREENS.OUT_OF_SERVICE);
  render();
  try {
    const snapshot = await request(kioskApi("/bootstrap"), { method: "POST", body: { forceFresh: true } });
    hydrateSnapshot(snapshot);
    state.orderType = "";
    state.cart.clear();
    state.modifierDraft = null;
    state.memberCode = "";
    state.member = null;
    state.recommendations = [];
    state.memberRecoveryNotice = "";
    state.memberReturnScreen = SCREENS.ORDER_TYPE;
    state.quote = null;
    state.quoteError = "";
    state.checkoutError = "";
    state.order = null;
    state.payment = null;
    state.paymentMethod = "QRIS";
    state.cashReceivedRupiah = 0;
    state.removedLine = null;
    state.cartRecoveryNotice = "";
    resetPaymentCheckState();
    checkoutKeys.clear();
    state.storageWarning = false;
    clearCartDraft();
    state.resetPending = false;
    checkoutAttempts.clear();
    state.resetLoading = false;
    resetIntents.clear();
    if (idleDialog.open) idleDialog.close();
    if (helpDialog.open) helpDialog.close();
    flow.restore(showWelcome ? SCREENS.WELCOME : SCREENS.ORDER_TYPE);
    render();
  } catch (error) {
    if (idleDialog.open) idleDialog.close();
    if (helpDialog.open) helpDialog.close();
    state.resetLoading = false;
    state.outageMessage = state.resetPending
      ? "Sesi belum dapat ditutup. Coba lagi atau minta bantuan kasir."
      : customerSafeOutageMessage(error);
    flow.restore(SCREENS.OUT_OF_SERVICE);
    render();
  }
}

function cartPayload() {
  return [...state.cart.values()].map(({ productId, qty, selections, note }) => ({ productId, qty, selections, note: note || undefined }));
}

function persistCartDraft() {
  if (!state.snapshot?.session?.id || !state.cart.size) {
    if (!state.cart.size) clearCartDraft();
    return;
  }
  const draft = createCartDraft({
    sessionId: state.snapshot.session.id,
    orderType: state.orderType,
    selectedCategory: state.selectedCategory,
    cart: state.cart,
  });
  try {
    sessionStorage.setItem(CART_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Cart remains usable when browser storage is unavailable; server quote is still authoritative.
    state.storageWarning = true;
  }
}

function clearCartDraft() {
  try {
    sessionStorage.removeItem(CART_DRAFT_KEY);
  } catch {
    // Storage denial must never block reset or payment recovery.
  }
}

function readCartDraft() {
  try {
    return sessionStorage.getItem(CART_DRAFT_KEY);
  } catch {
    state.storageWarning = true;
    return null;
  }
}

function scheduleIdle() {
  if (idleDialog.open) return;
  clearTimeout(idleTimer);
  clearInterval(idleCountdownTimer);
  if ([SCREENS.PAYMENT_PENDING, SCREENS.PAYMENT_RECOVERY, SCREENS.SUCCESS, SCREENS.OUT_OF_SERVICE].includes(flow.current)) return;
  idleTimer = window.setTimeout(openIdleDialog, 180_000);
}

function openIdleDialog() {
  if (state.checkoutAttempt || state.checkoutLoading) return;
  if (idleDialog.open || flow.current === SCREENS.PAYMENT_PENDING) return;
  if (helpDialog.open) {
    helpInvoker = null; // The privacy warning, not the old help trigger, owns focus.
    helpDialog.close();
  }
  const deadlineMs = Date.now() + 30_000;
  document.querySelector("#idle-countdown").textContent = "30";
  idleDialog.showModal();
  idleCountdownTimer = window.setInterval(() => {
    const remaining = Math.max(0, Math.min(30, Math.ceil((deadlineMs - Date.now()) / 1000)));
    document.querySelector("#idle-countdown").textContent = String(remaining);
    if (remaining <= 0) startFreshSession(true);
  }, 1000);
}

function continueSession() {
  clearInterval(idleCountdownTimer);
  idleDialog.close();
  scheduleIdle();
}

function continueToPayment() {
  if (usesSingleQris()) return checkout();
  return go(SCREENS.PAYMENT_METHOD);
}

function usesSingleQris() {
  const methods = state.capabilities?.paymentMethods || [];
  return methods.length === 1 && methods[0] === "QRIS";
}

function openHelpDialog() {
  clearTimeout(idleTimer);
  helpInvoker = document.activeElement;
  resetHelpDialog();
  const paymentScreen = [SCREENS.PAYMENT_PENDING, SCREENS.PAYMENT_RECOVERY].includes(flow.current);
  helpMessage.textContent = state.checkoutAttempt
    ? "Tunjukkan layar ini kepada kasir untuk memeriksa status pesanan. Jangan membayar ulang."
    : paymentScreen
    ? "Temui barista di kasir dan tunjukkan layar ini. Status pesanan tetap tersimpan."
    : "Temui barista di kasir jika kamu kesulitan memilih menu atau melanjutkan pesanan.";
  helpPaymentNote.hidden = !paymentScreen && !state.checkoutAttempt;
  helpCancelAction.hidden = !canCancelCurrentSession();
  helpDialog.showModal();
  helpCloseAction.focus({ preventScroll: true });
  scheduleIdle(); // Help must not disable the pre-payment privacy deadline.
}

function closeHelpDialog() {
  helpDialog.close();
}

function showSessionCancelConfirmation() {
  if (!canCancelCurrentSession()) return;
  helpKicker.textContent = "SESI · BATALKAN";
  helpTitle.textContent = "Batalkan pesanan ini?";
  helpMessage.textContent = "Semua pilihan menu dan akun Member pada sesi ini akan dihapus. Belum ada pembayaran yang dibuat.";
  helpPaymentNote.hidden = true;
  helpCloseAction.hidden = true;
  helpCancelAction.hidden = true;
  helpKeepAction.hidden = false;
  helpConfirmCancelAction.hidden = false;
  helpKeepAction.focus({ preventScroll: true });
}

function canCancelCurrentSession() {
  return !state.order && !state.checkoutAttempt && !state.checkoutLoading && [
    SCREENS.ORDER_TYPE,
    SCREENS.MEMBER,
    SCREENS.MEMBER_WELCOME,
    SCREENS.BROWSE,
    SCREENS.MODIFIER,
    SCREENS.CART,
    SCREENS.PAYMENT_METHOD,
  ].includes(flow.current);
}

function resetHelpDialog() {
  helpKicker.textContent = "BANTUAN";
  helpTitle.textContent = "Butuh bantuan?";
  helpCloseAction.hidden = false;
  helpCancelAction.hidden = true;
  helpKeepAction.hidden = true;
  helpConfirmCancelAction.hidden = true;
  helpConfirmCancelAction.disabled = false;
  helpConfirmCancelAction.textContent = "Ya, batalkan dan mulai ulang";
}

function handleHelpDialogClosed() {
  resetHelpDialog();
  if (helpInvoker?.isConnected) helpInvoker.focus({ preventScroll: true });
  helpInvoker = null;
  scheduleIdle();
}

function handleNetworkChange() {
  state.networkOnline = navigator.onLine !== false;
  updateNetworkBanner();
  clearTimeout(paymentPollTimer);
  if (flow.current === SCREENS.PAYMENT_PENDING) {
    updatePaymentPendingUi();
    if (state.networkOnline) refreshPaymentStatus({ manual: false });
    return;
  }
  render();
}

function updateNetworkBanner() {
  networkBanner.hidden = state.networkOnline;
  networkBanner.textContent = state.networkOnline
    ? ""
    : flow.current === SCREENS.PAYMENT_PENDING
      ? "Koneksi terputus · jangan bayar ulang · status akan diperiksa saat tersambung"
      : "Koneksi terputus · sambungkan kembali untuk melanjutkan pembayaran";
  syncKioskViewportHeight();
}

function updatePaymentPendingUi() {
  if (flow.current !== SCREENS.PAYMENT_PENDING) return;
  const status = document.querySelector("#payment-status");
  const title = document.querySelector("#payment-status-title");
  const detail = document.querySelector("#payment-status-detail");
  const lastChecked = document.querySelector("#payment-last-checked");
  const checkButton = document.querySelector("#check-payment");
  if (!status || !title || !detail || !lastChecked) return;
  const check = paymentCheckPresentation({
    attempt: state.paymentCheckAttempt,
    loading: state.paymentCheckLoading,
    lastCheckedAt: state.paymentLastCheckedAt,
  });
  const assistedCash = state.payment?.assistedCash === true;
  const staticQrisDemo = state.payment?.staticQrisDemo === true;
  const staticQrisManual = state.payment?.staticQrisManual === true;
  title.textContent = assistedCash || staticQrisDemo || staticQrisManual ? (state.networkOnline ? "Menunggu konfirmasi kasir" : "Koneksi terputus") : state.networkOnline ? check.title : "Koneksi terputus";
  detail.textContent = state.networkOnline
    ? staticQrisDemo ? "DEMO saja. Minta kasir membuka antrean QRIS Statis DEMO; belum masuk KDS." : staticQrisManual ? "Kasir perlu memeriksa pembayaran di aplikasi merchant sebelum pesanan masuk KDS." : assistedCash ? "Serahkan uang ke staf. Pesanan belum masuk antrean bar sebelum uang diterima." : check.detail
    : staticQrisDemo ? "QR dummy bukan pembayaran. Minta kasir memeriksa status simulasi saat tersambung." : staticQrisManual ? "Jangan bayar ulang. Minta kasir memeriksa transaksi merchant setelah koneksi pulih." : assistedCash ? "Nominal tetap tersimpan. Jangan serahkan uang dua kali; minta staf memeriksa layar kasir." : "Jangan scan atau bayar ulang. Status pembayaran akan diperiksa setelah tersambung.";
  lastChecked.textContent = check.lastCheckedLabel || "";
  lastChecked.hidden = !check.lastCheckedLabel;
  status.setAttribute("aria-busy", String(Boolean(state.paymentCheckLoading)));
  if (checkButton) {
    checkButton.disabled = state.paymentCheckLoading || !state.networkOnline;
    const label = checkButton.querySelector("span");
    if (label) label.textContent = check.automaticCheckPaused ? "Cek Status Lagi" : "Cek Status Sekarang";
  }
}

function updateCashTenderPreview() {
  if (flow.current !== SCREENS.PAYMENT_METHOD || state.paymentMethod !== "CASH_ASSISTED") return;
  const total = Number(state.quote?.totalRupiah || 0);
  const received = Number(state.cashReceivedRupiah || 0);
  const difference = received - total;
  const status = document.querySelector("#cash-assist-status");
  const button = document.querySelector('[data-action="checkout"]');
  if (status) {
    status.dataset.state = difference >= 0 ? "ready" : received > 0 ? "short" : "idle";
    status.textContent = received === 0 ? "Pilih nominal atau masukkan uang yang disiapkan."
      : difference >= 0 ? `Perkiraan kembalian ${rupiah(difference)}. Staf akan menghitung ulang.`
        : `Nominal masih kurang ${rupiah(Math.abs(difference))}.`;
  }
  if (button) {
    button.disabled = !state.networkOnline || state.checkoutLoading || received < total;
    const label = button.querySelector("span");
    if (label) label.textContent = state.checkoutLoading ? "Memanggil staf…" : difference >= 0 ? `Bayar tunai · kembali ${rupiah(difference)}` : `Pilih nominal minimal ${rupiah(total)}`;
  }
}

function updatePaymentCountdown() {
  const element = document.querySelector("#payment-countdown");
  const label = document.querySelector("#payment-validity-label");
  if (!element || !state.payment?.expiresAt) return;
  const remaining = Math.max(0, new Date(state.payment.expiresAt).getTime() - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  element.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const timeElapsed = remaining <= 0;
  const qrVisual = document.querySelector("#qr-visual");
  const expiryOverlay = document.querySelector("#qr-expiry-overlay");
  qrVisual?.classList.toggle("is-time-elapsed", timeElapsed);
  if (expiryOverlay) expiryOverlay.hidden = !timeElapsed;
  if (label && timeElapsed) label.lastChild.textContent = " Waktu habis";
  if (timeElapsed && state.payment.simulator === false && !state.paymentExpiryCheckRequested) {
    state.paymentExpiryCheckRequested = true;
    void refreshPaymentStatus({ manual: true });
  }
  // Client clocks may drift. Only the server/provider is allowed to classify a payment as expired.
}

function resetPaymentCheckState() {
  state.paymentCheckAttempt = 0;
  state.paymentCheckLoading = false;
  state.paymentLastCheckedAt = "";
  state.paymentExpiryCheckRequested = false;
}

function clearRuntimeTimers() {
  clearTimeout(idleTimer);
  clearInterval(idleCountdownTimer);
  clearTimeout(paymentPollTimer);
  clearInterval(paymentCountdownTimer);
  clearTimeout(paymentExpiryTimer);
  clearTimeout(successTimer);
  clearInterval(successCountdownTimer);
  clearTimeout(undoTimer);
}

function captureFocusTarget() {
  const element = document.activeElement;
  if (!element || !app.contains(element)) return null;
  return {
    id: element.id || "",
    tagName: element.tagName,
    dataset: { ...element.dataset },
  };
}

function restoreFocusTarget(target) {
  if (!target) return;
  let candidate = target.id ? document.getElementById(target.id) : null;
  if (!candidate && target.dataset?.action) {
    candidate = [...app.querySelectorAll(`[data-action="${target.dataset.action}"]`)].find((element) =>
      Object.entries(target.dataset).every(([key, value]) => element.dataset[key] === value));
  }
  candidate?.focus({ preventScroll: true });
}

function focusScreenHeading() {
  const heading = app.querySelector("h1");
  if (!heading) return app.focus({ preventScroll: true });
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

function customerSafeOutageMessage(error) {
  if (navigator.onLine === false) return "Koneksi internet terputus. Sambungkan kembali lalu coba lagi.";
  if (error?.status === 401) return "Sesi kiosk perlu dimulai ulang.";
  return "Layanan belum dapat dihubungi. Coba lagi atau pesan langsung di kasir.";
}

function announce(message, danger = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.danger = danger ? "true" : "false";
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
}
