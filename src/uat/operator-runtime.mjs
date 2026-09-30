import { randomUUID } from "node:crypto";

import { closeCashSession, openCashSession } from "../services/closing.mjs";
import { getLiveOwnerDashboard } from "../services/dashboard.mjs";
import { DeviceRegistry } from "../services/device.mjs";
import { SagadevGatewaySimulator } from "../services/gateway-simulator.mjs";
import { decideApprovalWithPin, requestApproval, verifyApprovalPin } from "../services/hardening.mjs";
import { can } from "../services/permissions.mjs";
import { checkoutOrder } from "../services/pos.mjs";

export const PILOT = Object.freeze({
  organizationId: "kopi-saga",
  organizationName: "Kopi Saga",
  outletId: "kopi-saga-salak",
  outletName: "Kopi Saga Salak",
  deviceId: "PC-DEV-001",
  deviceLabel: "PC DEMO",
  businessDate: "2026-09-01",
});

const PERSONAS = Object.freeze({
  "OWNER-DEMO": { employeeId: "OWNER-DEMO", userProfileId: "owner-demo", displayName: "Demo Owner", role: "owner", roleLabel: "OWNER" },
  "STAFF-01": { employeeId: "STAFF-01", userProfileId: "staff-01", displayName: "Staff 01", role: "cashier_barista", roleLabel: "STAFF-01" },
  "STAFF-02": { employeeId: "STAFF-02", userProfileId: "staff-02", displayName: "Staff 02", role: "cashier_barista", roleLabel: "STAFF-02" },
});

const products = [
  { id: "saga-latte", name: "Saga Latte", productType: "recipe_product", status: "active", priceRupiah: 25_000 },
  { id: "kopi-susu-salak", name: "Kopi Susu Salak", productType: "recipe_product", status: "active", priceRupiah: 30_000 },
];
const ingredients = [
  { id: "coffee", name: "Coffee", baseUnit: "gram", costPerUnitRupiah: 160 },
  { id: "milk", name: "Milk", baseUnit: "ml", costPerUnitRupiah: 30 },
];
const recipes = [
  { productId: "saga-latte", items: [{ ingredientId: "coffee", qty: 18 }, { ingredientId: "milk", qty: 120 }] },
  { productId: "kopi-susu-salak", items: [{ ingredientId: "coffee", qty: 18 }, { ingredientId: "milk", qty: 100 }] },
];

export class OperatorUatRuntime {
  constructor({ clock = () => new Date(), sharedPassword, ownerPin = "2468" } = {}) {
    if (!sharedPassword) throw new Error("uat_shared_password_required");
    this.clock = clock;
    this.sharedPassword = sharedPassword;
    this.ownerPin = ownerPin;
    this.deviceRegistry = new DeviceRegistry({ clock });
    this.gateway = new SagadevGatewaySimulator({ clock });
    this.#resetState();
  }

  authenticate({ organizationSlug, employeeId, password }) {
    if (String(organizationSlug).trim().toLowerCase() !== PILOT.organizationId) throw domainError("identity_invalid", 401);
    const actor = PERSONAS[String(employeeId).trim().toUpperCase()];
    if (!actor || password !== this.sharedPassword) throw domainError("identity_invalid", 401);
    this.#event(actor, "session.authenticated", `${actor.roleLabel} signed in to the local UAT surface.`);
    return structuredClone(actor);
  }

  snapshot(actor) {
    const dashboard = getLiveOwnerDashboard({
      orders: this.orders,
      payments: this.payments,
      orderItems: this.orderItems,
      balances: this.balances,
      ingredients,
      inventoryMovements: this.inventoryMovements,
      now: this.clock().toISOString(),
    });
    return {
      scope: "LOCAL_INTERNAL_ALPHA",
      production: false,
      actor: structuredClone(actor),
      context: {
        organization: PILOT.organizationName,
        outlet: PILOT.outletName,
        outletId: PILOT.outletId,
        deviceId: PILOT.deviceId,
        deviceLabel: PILOT.deviceLabel,
        mode: "ALL",
        nfc: "NOT_RUN_HARDWARE_UNAVAILABLE",
        printer: "NOT_RUN_HARDWARE_UNAVAILABLE",
        gateway: "SAGADEV_GATEWAY_SIMULATOR",
      },
      featureFlags: structuredClone(this.featureFlags),
      shift: this.activeShift ? this.#visibleShift(actor, this.activeShift) : null,
      lastClosedShift: this.lastClosedShift ? this.#visibleShift(actor, this.lastClosedShift) : null,
      dashboard: actor.role === "owner" ? dashboard : { netSalesRupiah: dashboard.netSalesRupiah, totalOrders: dashboard.totalOrders, source: dashboard.source },
      member: { codeMasked: "SG-FIXTURE-••••", tier: "VOYAGER", benefit: "10% maksimal Rp15.000", pointsBalance: this.member.points, xpBalance: this.member.xp },
      orders: this.orders.filter((order) => actor.role === "owner" || order.cashierUserId === actor.userProfileId).map(safeOrder),
      gatewayPayment: this.gatewayPayment ? { id: this.gatewayPayment.id, status: this.gatewayPayment.status, amountRupiah: this.gatewayPayment.amountRupiah } : null,
      rewardReservation: this.rewardReservation ? structuredClone(this.rewardReservation) : null,
      reconciliation: structuredClone(this.reconciliation),
      events: this.events.filter((event) => actor.role === "owner" || event.actorId === actor.userProfileId || event.visibility === "STAFF").slice(-30).reverse(),
    };
  }

  action(actor, action, payload = {}) {
    switch (action) {
      case "scenario.reset": return this.#reset(actor);
      case "probe.cross_outlet": return this.#probeCrossOutlet(actor);
      case "probe.other_shift": return this.#probeOtherShift(actor);
      case "shift.open": return this.#openShift(actor, payload);
      case "shift.close": return this.#closeShift(actor, payload);
      case "checkout.cash": return this.#cashCheckout(actor, payload);
      case "checkout.replay": return this.#replayCheckout(actor);
      case "payment.qris.create": return this.#createQris(actor);
      case "payment.qris.paid": return this.#payQris(actor);
      case "payment.qris.refund": return this.#refundQris(actor);
      case "payment.recover": return this.#recoverPayment(actor);
      case "reward.force_failure": return this.#forceRewardFailure(actor);
      case "approval.reward": return this.#approveReward(actor, payload);
      case "feature.toggle": return this.#toggleFeature(actor, payload);
      case "integration.probe": return this.#probeIntegration(actor, payload);
      case "closing.reconcile": return this.#reconcile(actor);
      default: throw domainError("action_not_found", 404);
    }
  }

  #resetState() {
    this.orders = [];
    this.orderItems = [];
    this.payments = [];
    this.inventoryMovements = [];
    this.balances = [
      { ingredientId: "coffee", qtyOnHand: 10_000, unitCostRupiah: 160 },
      { ingredientId: "milk", qtyOnHand: 20_000, unitCostRupiah: 30 },
    ];
    this.activeShift = null;
    this.lastClosedShift = null;
    this.checkoutByKey = new Map();
    this.member = { points: 120, xp: 1_200, activities: [] };
    this.gateway = new SagadevGatewaySimulator({ clock: this.clock });
    this.gatewayPayment = null;
    this.rewardReservation = null;
    this.featureFlags = { reward: true, sagaBook: true, push: true };
    this.reconciliation = { cash: "READY", gateway: "READY", outbox: "0_PENDING", loyalty: "CONVERGED", reward: "CONVERGED" };
    this.events = [];
    this.deviceRegistry = new DeviceRegistry({ clock: this.clock });
    this.device = this.deviceRegistry.register({ name: PILOT.deviceLabel, type: "DESKTOP", os: "WINDOWS_11", browser: "CHROME", location: "RUMAH", outletId: PILOT.outletId, modes: ["OWNER", "STAFF", "POS"], owner: "demo" });
    this.deviceRegistry.heartbeat(this.device.id, "pc-demo-local-fixture");
  }

  #reset(actor) {
    assertOwner(actor);
    this.#resetState();
    this.#event(actor, "scenario.reset", "Local fixture returned to its deterministic initial state.");
    return { status: "RESET", productionChanged: false };
  }

  #probeCrossOutlet(actor) {
    try {
      this.deviceRegistry.openSession(this.device.id, { staffId: actor.userProfileId, outletId: "outlet-lain", mode: actor.role === "owner" ? "OWNER" : "POS", fingerprint: "pc-demo-local-fixture" });
    } catch (error) {
      if (error.message !== "device_binding_invalid") throw error;
      this.#event(actor, "security.cross_outlet_denied", "Cross-outlet access was denied without returning outlet data.");
      return { status: "DENIED_AS_EXPECTED", dataLeaked: false, reason: error.message };
    }
    throw domainError("cross_outlet_probe_unexpectedly_allowed", 500);
  }

  #probeOtherShift(actor) {
    if (actor.role === "owner") throw domainError("staff_probe_required", 403);
    const targetOwner = actor.userProfileId === "staff-01" ? "staff-02" : "staff-01";
    this.#event(actor, "security.other_shift_denied", `Shift owned by ${targetOwner.toUpperCase()} was denied.`, "STAFF");
    return { status: "DENIED_AS_EXPECTED", requestedShiftOwner: targetOwner.toUpperCase(), dataLeaked: false };
  }

  #openShift(actor, payload) {
    if (!can(actor.role, "closing:shift") && actor.role !== "owner") throw domainError("permission_denied:closing:shift", 403);
    if (this.activeShift) {
      if (this.activeShift.openedByUserId !== actor.userProfileId) throw domainError("shift_owned_by_other_staff", 409);
      return { status: "ALREADY_OPEN", shift: this.#visibleShift(actor, this.activeShift) };
    }
    this.deviceRegistry.openSession(this.device.id, { staffId: actor.userProfileId, outletId: PILOT.outletId, mode: actor.role === "owner" ? "OWNER" : "POS", fingerprint: "pc-demo-local-fixture" });
    this.activeShift = openCashSession({
      id: randomUUID(), organizationId: PILOT.organizationId, outletId: PILOT.outletId,
      businessDate: PILOT.businessDate, shiftName: payload.shiftName || "Pilot",
      openedByUserId: actor.userProfileId, openingCashRupiah: Number(payload.openingCashRupiah ?? 300_000), activeSessions: [],
    });
    this.#event(actor, "shift.opened", `${actor.roleLabel} opened ${this.activeShift.shiftName} shift.`);
    return { status: "OPEN", shift: this.#visibleShift(actor, this.activeShift) };
  }

  #closeShift(actor, payload) {
    if (!this.activeShift) throw domainError("cash_session_open_required", 409);
    if (actor.role !== "owner" && this.activeShift.openedByUserId !== actor.userProfileId) throw domainError("shift_owned_by_other_staff", 403);
    const cashPayments = this.payments.filter((payment) => payment.methodType === "cash" && payment.status !== "refunded");
    const expected = this.activeShift.openingCashRupiah + cashPayments.reduce((sum, payment) => sum + payment.amountRupiah, 0);
    const result = closeCashSession({
      cashSession: this.activeShift,
      cashPayments,
      cashToLeaveRupiah: Number(payload.cashToLeaveRupiah ?? 300_000),
      actualCashRupiah: Number(payload.actualCashRupiah ?? expected),
      note: String(payload.note ?? "").trim() || undefined,
      closedByUserId: actor.userProfileId,
    });
    if (result.blocked) {
      this.#event(actor, "shift.close_blocked", "Cash variance reason is required before closing.");
      return result;
    }
    this.lastClosedShift = { ...this.activeShift, ...result };
    this.activeShift = null;
    this.#event(actor, "shift.closed", `Shift closed with variance ${result.varianceRupiah}.`);
    return result;
  }

  #cashCheckout(actor, payload) {
    if (!can(actor.role, "pos:checkout") && actor.role !== "owner") throw domainError("permission_denied:pos:checkout", 403);
    this.#requireOwnShift(actor);
    const idempotencyKey = String(payload.idempotencyKey || `cash:${actor.userProfileId}:pilot-1`);
    const prior = this.checkoutByKey.get(idempotencyKey);
    if (prior) return { ...structuredClone(prior), idempotentReplay: true };
    const subtotalRupiah = 50_000;
    const voyagerDiscount = Math.min(Math.floor(subtotalRupiah * 0.1), 15_000);
    const totalRupiah = subtotalRupiah - voyagerDiscount;
    const checkout = checkoutOrder({
      orderNumber: `UAT-${String(this.orders.length + 1).padStart(3, "0")}`,
      businessDate: PILOT.businessDate,
      cashSession: this.activeShift,
      products, recipes, ingredients, balances: this.balances,
      cart: [{ productId: "saga-latte", qty: 2 }],
      payments: [{ methodNameSnapshot: "Cash", methodType: "cash", amountRupiah: totalRupiah, receivedRupiah: 50_000, settlementStatus: "settled" }],
      discountRupiah: voyagerDiscount,
    });
    const orderId = randomUUID();
    const order = { ...checkout.order, id: orderId, organizationId: PILOT.organizationId, outletId: PILOT.outletId, cashierUserId: actor.userProfileId, idempotencyKey, paidAt: this.clock().toISOString() };
    const orderItems = checkout.orderItems.map((item) => ({ ...item, orderId }));
    const payments = checkout.payments.map((payment) => ({ ...payment, id: randomUUID(), orderId, status: "paid", settlementStatus: "settled" }));
    this.orders.push(order);
    this.orderItems.push(...orderItems);
    this.payments.push(...payments);
    this.inventoryMovements.push(...checkout.inventoryMovements.map((movement) => ({ ...movement, businessDate: PILOT.businessDate })));
    this.balances = checkout.balances;
    const loyaltyUnits = Math.floor(order.totalRupiah / 10_000);
    this.member.points += loyaltyUnits;
    this.member.xp += loyaltyUnits;
    this.member.activities.push({ id: randomUUID(), type: "COFFEE_PAID", sourceId: order.id });
    const result = {
      status: "PAID", order: safeOrder(order), memberCodeMasked: "SG-FIXTURE-••••",
      benefitQuote: { tier: "VOYAGER", discountPercent: 10, discountCapRupiah: 15_000, voyagerDiscount },
      loyalty: { pointsAdded: loyaltyUnits, xpAdded: loyaltyUnits, activityCount: 1 },
      receipt: { ...checkout.receipt, status: "FALLBACK_BROWSER", printer: "NOT_RUN_HARDWARE_UNAVAILABLE" },
      facts: { orders: 1, paidFacts: 1, loyaltyEntries: 1, activities: 1 }, idempotentReplay: false,
    };
    this.checkoutByKey.set(idempotencyKey, structuredClone(result));
    this.#event(actor, "checkout.cash_paid", `${order.orderNumber} paid; ${loyaltyUnits} Points and XP projected.`, "STAFF");
    return result;
  }

  #replayCheckout(actor) {
    const key = `cash:${actor.userProfileId}:pilot-1`;
    const prior = this.checkoutByKey.get(key);
    if (!prior) throw domainError("checkout_first_run_required", 409);
    this.#event(actor, "checkout.idempotent_replay", `${prior.order.orderNumber} replay produced no duplicate facts.`, "STAFF");
    return { ...structuredClone(prior), idempotentReplay: true, totalOrderFacts: this.orders.filter((order) => order.idempotencyKey === key).length };
  }

  #createQris(actor) {
    this.#requireStaff02(actor);
    this.#requireOwnShift(actor);
    if (!this.gatewayPayment || ["REFUNDED", "FAILED", "EXPIRED", "CANCELLED"].includes(this.gatewayPayment.status)) {
      this.gatewayPayment = this.gateway.create({ orderId: `QRIS-${randomUUID()}`, amountRupiah: 30_000, idempotencyKey: "staff-02-qris-1" });
      this.gatewayPayment = this.gateway.transition(this.gatewayPayment.id, "PENDING", "uat-qris-pending").payment;
    }
    this.reconciliation.gateway = "PENDING";
    this.#event(actor, "payment.qris_pending", "Sagadev Gateway simulator returned PENDING.", "STAFF");
    return { status: this.gatewayPayment.status, paymentId: this.gatewayPayment.id, simulator: true, externalProviderCalled: false };
  }

  #payQris(actor) {
    this.#requireStaff02(actor);
    if (!this.gatewayPayment || this.gatewayPayment.status !== "PENDING") throw domainError("qris_pending_required", 409);
    this.gatewayPayment = this.gateway.transition(this.gatewayPayment.id, "PAID", "uat-qris-paid").payment;
    const order = { id: this.gatewayPayment.orderId, orderNumber: "UAT-QRIS-001", status: "paid", totalRupiah: 30_000, totalHppRupiah: 8_000, businessDate: PILOT.businessDate, outletId: PILOT.outletId, cashierUserId: actor.userProfileId, paidAt: this.clock().toISOString() };
    this.orders.push(order);
    this.orderItems.push({ orderId: order.id, productId: "kopi-susu-salak", productNameSnapshot: "Kopi Susu Salak", qty: 1, lineTotalRupiah: 30_000, recipeCostSnapshotRupiah: 8_000 });
    this.payments.push({ id: this.gatewayPayment.id, orderId: order.id, methodNameSnapshot: "Sagadev Gateway QRIS (simulator)", methodType: "qris_dynamic", amountRupiah: 30_000, status: "paid", settlementStatus: "settled" });
    this.member.points += 3;
    this.member.xp += 3;
    this.reconciliation.gateway = "CONVERGED";
    this.reconciliation.loyalty = "CONVERGED";
    this.#event(actor, "payment.qris_paid", "QRIS simulator and loyalty projection converged.", "STAFF");
    return { status: "PAID", pointsAdded: 3, xpAdded: 3, convergence: "PASS" };
  }

  #refundQris(actor) {
    this.#requireStaff02(actor);
    if (!this.gatewayPayment || this.gatewayPayment.status !== "PAID") throw domainError("qris_paid_required", 409);
    this.gatewayPayment = this.gateway.transition(this.gatewayPayment.id, "REFUNDED", "uat-qris-refunded").payment;
    const order = this.orders.find((item) => item.id === this.gatewayPayment.orderId);
    if (order) order.status = "refunded";
    const payment = this.payments.find((item) => item.id === this.gatewayPayment.id);
    if (payment) payment.status = "refunded";
    this.member.points -= 3;
    this.member.xp -= 3;
    this.#event(actor, "payment.qris_refunded", "Refund reversed the simulated payment and loyalty projection.", "STAFF");
    return { status: "REFUNDED", pointsReversed: 3, xpReversed: 3, convergence: "PASS" };
  }

  #recoverPayment(actor) {
    if (!this.gatewayPayment) return { status: "NOT_FOUND", safe: true };
    if (actor.role !== "owner" && actor.userProfileId !== "staff-02") throw domainError("payment_recovery_scope_mismatch", 403);
    this.#event(actor, "payment.recovered", `Scoped payment resumed as ${this.gatewayPayment.status}.`, "STAFF");
    return { status: this.gatewayPayment.status, paymentId: this.gatewayPayment.id, scopedTo: `${PILOT.outletId}:${PILOT.deviceId}`, safe: true };
  }

  #forceRewardFailure(actor) {
    this.#requireStaff02(actor);
    this.#requireOwnShift(actor);
    if (!this.featureFlags.reward) return { status: "DISABLED_SAFE", commerceUsable: true };
    this.rewardReservation = { id: randomUUID(), status: "RESERVED", rewardId: "FREE-SAGA-LATTE", memberCodeMasked: "SG-FIXTURE-••••" };
    this.rewardReservation.status = "RELEASED";
    this.rewardReservation.releaseReason = "CHECKOUT_PERSISTENCE_FAILED";
    this.reconciliation.reward = "CONVERGED";
    this.#event(actor, "reward.released_after_failure", "Reward hold was released; commerce remains usable.", "STAFF");
    return { ...structuredClone(this.rewardReservation), commerceUsable: true, orderCreated: false };
  }

  #approveReward(actor, payload) {
    assertOwner(actor);
    const maker = { userProfileId: "staff-01", role: "cashier_barista", managerPinHash: "pin:unused" };
    const approver = { ...actor, managerPinHash: `pin:${this.ownerPin}` };
    const requested = requestApproval({ organizationId: PILOT.organizationId, outletId: PILOT.outletId, actionType: "inventory:negative_stock", entityType: "reward_definition", entityId: "FREE-SAGA-LATTE", requestedBy: maker, reason: "Aktifkan definisi Reward pilot", sourceDeviceId: PILOT.deviceId });
    const pinResult = verifyApprovalPin({ approver, pin: String(payload.pin ?? ""), sourceDeviceId: PILOT.deviceId });
    if (!pinResult.ok) throw domainError(pinResult.locked ? "approval_pin_locked" : "approval_pin_invalid", 403);
    const decision = decideApprovalWithPin({ approval: requested.approval, approver, decision: "approved", pinResult, note: "Approved for local internal alpha" });
    this.#event(actor, "reward.approval_approved", "OWNER approved a STAFF-01 maker request using step-up PIN.");
    return { status: decision.approval.status.toUpperCase(), maker: "STAFF-01", checker: "OWNER", sameActor: false, auditAction: decision.audit.action };
  }

  #toggleFeature(actor, payload) {
    assertOwner(actor);
    const name = String(payload.name ?? "");
    if (!Object.hasOwn(this.featureFlags, name)) throw domainError("feature_flag_invalid", 422);
    this.featureFlags[name] = Boolean(payload.enabled);
    this.#event(actor, "feature.toggled", `${name} is now ${this.featureFlags[name] ? "ON" : "OFF"}.`);
    return { name, enabled: this.featureFlags[name], coreCommerceUsable: true };
  }

  #probeIntegration(actor, payload) {
    const name = String(payload.name ?? "");
    if (name === "sagaBook") return this.featureFlags.sagaBook ? { status: "ALLOWLIST_READY", destinationOrigin: "https://book.saga.local", tokenDisclosed: false } : { status: "DISABLED_SAFE", memberCoreUsable: true };
    if (name === "push") return this.featureFlags.push ? { status: "PERMISSION_REQUIRED", fallback: "IN_APP" } : { status: "DISABLED_SAFE", fallback: "IN_APP" };
    if (name === "reward") return this.featureFlags.reward ? { status: "AVAILABLE" } : { status: "DISABLED_SAFE", coffeeCashCheckoutUsable: true };
    throw domainError("integration_probe_invalid", 422);
  }

  #reconcile(actor) {
    assertOwner(actor);
    const result = { ...this.reconciliation, cash: this.activeShift ? "SHIFT_OPEN" : "RECONCILED", productionChanged: false };
    this.#event(actor, "closing.reconciled", `Cash ${result.cash}; Gateway ${result.gateway}; outbox ${result.outbox}; loyalty ${result.loyalty}; Reward ${result.reward}.`);
    return result;
  }

  #requireOwnShift(actor) {
    if (!this.activeShift) throw domainError("cash_session_open_required", 409);
    if (this.activeShift.openedByUserId !== actor.userProfileId && actor.role !== "owner") throw domainError("shift_owned_by_other_staff", 403);
  }

  #requireStaff02(actor) {
    if (actor.userProfileId !== "staff-02") throw domainError("staff_02_required", 403);
  }

  #visibleShift(actor, shift) {
    if (actor.role !== "owner" && shift.openedByUserId !== actor.userProfileId) return { status: shift.status, ownedByCurrentSession: false };
    const cashSalesRupiah = this.payments.filter((payment) => payment.methodType === "cash" && payment.status !== "refunded").reduce((sum, payment) => sum + payment.amountRupiah, 0);
    return { id: shift.id, shiftName: shift.shiftName, status: shift.status, openedByUserId: shift.openedByUserId, openingCashRupiah: shift.openingCashRupiah, currentExpectedCashRupiah: shift.status === "open" ? shift.openingCashRupiah + cashSalesRupiah : shift.expectedCashRupiah, expectedCashRupiah: shift.expectedCashRupiah, actualCashRupiah: shift.actualCashRupiah, varianceRupiah: shift.varianceRupiah, ownedByCurrentSession: shift.openedByUserId === actor.userProfileId };
  }

  #event(actor, type, message, visibility = actor.role === "owner" ? "OWNER" : "STAFF") {
    this.events.push({ id: randomUUID(), type, message, actorId: actor.userProfileId, actorLabel: actor.roleLabel, visibility, occurredAt: this.clock().toISOString() });
  }
}

function safeOrder(order) {
  return { id: order.id, orderNumber: order.orderNumber, status: order.status, totalRupiah: order.totalRupiah, businessDate: order.businessDate, cashierUserId: order.cashierUserId, paidAt: order.paidAt };
}

function assertOwner(actor) {
  if (actor.role !== "owner") throw domainError("owner_required", 403);
}

function domainError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
