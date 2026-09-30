import { createHash } from "node:crypto";
import { durableFulfillmentProjection } from "./durable-fulfillment-state.mjs";
import QRCode from "qrcode";

import { SAGA_POS_DURABLE_PILOT_IDS, sagaPosPurchaseReceiptLocations } from "../db/saga-pos-postgres-repository.mjs";
import {
  shiftCloseCommandFingerprint,
} from "../db/esb-reliability-postgres-repository.mjs";
import { PosVerticalSliceRuntime, SAGA_POS_ALPHA_CONTEXT } from "./vertical-slice-runtime.mjs";
import { createEsbOperationsRuntime } from "../services/esb-runtime/operations-runtime.mjs";
import { createOfflineOperation } from "../services/esb-reliability/offline.mjs";
import { restoreRemakeQueueFacts } from "../services/remake-queue.mjs";
import { createDurableHppProductionExecutionOptions } from "../services/production-execution-durable-hpp.mjs";

export class DurablePosVerticalSliceRuntime extends PosVerticalSliceRuntime {
  constructor({
    repository,
    clock = () => new Date(),
    ids = SAGA_POS_DURABLE_PILOT_IDS,
    privatePromotionAuthorizer = null,
    privateCanaryContext = null,
    canaryUsageProvider = null,
    gatewayClient = null,
    gatewayActivation = null,
    esbCatalogQuoteProvider = null,
    esbCatalogRuntime = null,
    inventoryPlanningRuntime = null,
    memberProvider = null,
    kioskGatewayQrisEnabled = true,
    kioskAssistedCashEnabled = false,
    kioskStaticQrisDemoEnabled = false,
    kioskManualQrisEnabled = false,
    kioskStaticDemoStore = null,
    manualQrisAssetStore = null,
    tableDemoStore = null,
    initializeContext = "seed",
  } = {}) {
    if (!repository) throw new Error("durable_repository_required");
    if (!["seed", "verify"].includes(initializeContext)) throw new Error("durable_initialize_context_invalid");
    if (esbCatalogQuoteProvider != null && typeof esbCatalogQuoteProvider !== "function") throw new Error("esb_catalog_quote_provider_invalid");
    if (esbCatalogRuntime != null && (!esbCatalogRuntime.adminState || !esbCatalogRuntime.createDraft || !esbCatalogRuntime.publish || !esbCatalogRuntime.authorizeFreePrice || !esbCatalogRuntime.quote)) throw new Error("esb_catalog_runtime_invalid");
    if (inventoryPlanningRuntime != null && ["availability", "atp", "replenishment", "upsertPolicy", "recommend"].some((method) => typeof inventoryPlanningRuntime[method] !== "function")) throw new Error("inventory_planning_runtime_invalid");
    if (tableDemoStore != null && ["load", "persist", "health"].some((method) => typeof tableDemoStore[method] !== "function")) throw new Error("table_demo_store_invalid");
    if (kioskStaticDemoStore != null && ["load", "persist", "loadAsset", "replaceAsset", "health"].some((method) => typeof kioskStaticDemoStore[method] !== "function")) throw new Error("kiosk_static_demo_store_invalid");
    if (manualQrisAssetStore != null && ["load", "replace"].some((method) => typeof manualQrisAssetStore[method] !== "function")) throw new Error("manual_qris_asset_store_invalid");
    super({
      clock,
      persistenceStatus: "LOCAL_DURABLE_POSTGRES_RUNTIME_ACTIVE_EXTERNAL_ATTESTATION_PENDING",
      privatePromotionAuthorizer,
      privateCanaryContext,
      canaryUsageProvider: canaryUsageProvider ?? (() => ({})),
      memberProvider,
      kioskGatewayQrisEnabled,
      kioskAssistedCashEnabled,
      kioskStaticQrisDemoEnabled: kioskStaticQrisDemoEnabled && kioskStaticDemoStore !== null,
      kioskManualQrisEnabled: false,
    });
    this.repository = repository;
    const valuationScope = Object.freeze({
      organizationId: ids.organizationId,
      outletId: ids.outletId,
      valuationScopeId: sagaPosPurchaseReceiptLocations(ids.outletId).usable,
    });
    this.inventoryValuation = Object.freeze({
      load: () => repository.inventoryValuation.load(valuationScope),
    });
    this.catalogRevision = 0;
    this.hppCatalogRevision = 0;
    this.ids = ids;
    this.receivingOutletId = ids.outletId;
    this.gatewayClient = gatewayClient;
    this.gatewayActivation = gatewayActivation == null ? null : Object.freeze(structuredClone(gatewayActivation));
    this.esbCatalogRuntime = esbCatalogRuntime;
    this.inventoryPlanningRuntime = inventoryPlanningRuntime;
    this.tableDemoStore = tableDemoStore;
    this.kioskStaticDemoStore = kioskStaticDemoStore;
    this.manualQrisAssetStore = manualQrisAssetStore;
    this.kioskManualQrisActivationArmed = kioskManualQrisEnabled === true && manualQrisAssetStore !== null;
    this.kioskStaticDemoInFlight = new Map();
    this.kioskStaticDemoConfirmInFlight = new Map();
    this.tableDemoPersistenceReady = tableDemoStore !== null;
    this.productionExecutionState = null;
    this.productionExecutionFactory = createDurableHppProductionExecutionOptions;
    this.esbCatalogQuoteProvider = esbCatalogQuoteProvider ?? esbCatalogRuntime?.quote ?? null;
    this.esbOperationsRuntime = repository.esbRuntimeStatus?.().writeVersion === "DUAL_WRITE_V1"
      && repository.esbRuntimeStatus?.().readVersion === "SHADOW_V1"
      ? createEsbOperationsRuntime({ db: repository.db, ids, clock })
      : null;
    this.initializeContext = initializeContext;
    if (!canaryUsageProvider) this.canaryUsageProvider = () => this.#canaryUsage();
  }

  async initialize() {
    if (this.initializeContext === "seed") await this.repository.seedPilotContext(this.ids);
    else await this.repository.verifyPilotContext(this.ids);
    const state = await this.repository.loadRuntimeState(this.ids);
    this.#hydrate(state);
    const tableDemoAggregates = this.tableDemoStore ? await this.tableDemoStore.load(this.ids) : [];
    for (const aggregate of tableDemoAggregates) this.restoreTableDemoState(aggregate);
    const kioskStaticDemoAggregates = this.kioskStaticDemoStore ? await this.kioskStaticDemoStore.load(this.ids) : [];
    for (const aggregate of kioskStaticDemoAggregates) this.restoreKioskStaticDemoState(aggregate);
    this.kioskManualQrisEnabled = this.kioskManualQrisActivationArmed && Boolean(await this.manualQrisAsset());
    const catalogState = await this.repository.loadCatalogState(this.ids);
    if (catalogState) {
      this.catalogPricing.restoreState(catalogState.snapshot);
      this.catalogRevision = catalogState.revision;
    }
    const hppCatalogState = await this.repository.loadHppCatalogState(this.ids);
    if (hppCatalogState) {
      const productionState = hppCatalogState.snapshot?._productionExecutionState ?? null;
      this.productionExecutionState = productionState === null ? null : JSON.parse(productionState);
      this.hppCatalog.restoreState(hppCatalogState.snapshot);
      this.hppCatalogRevision = hppCatalogState.revision;
    }
    await this.repository.verifyPurchaseReceiptValuationLinks(this.ids);
    this.#reconcileRemakeStatuses();
    this.#restoreGatewayClientState();
    return {
      ready: true,
      scope: "LOCAL_DURABLE_POSTGRES_RUNTIME",
      ordersRecovered: this.orders.length,
      paymentsRecovered: this.payments.length,
      fulfillmentsRecovered: this.fulfillments.size,
      tableDemoOrdersRecovered: tableDemoAggregates.length,
      kioskStaticDemoOrdersRecovered: kioskStaticDemoAggregates.length,
      tableDemoPersistenceReady: this.tableDemoPersistenceReady,
      productionChanged: false,
    };
  }

  async enqueueOfflineInventorySale(deviceContext, input = {}) {
    const normalized = normalizeOfflineInventorySyncInput(deviceContext, input, this.ids, this.hppCatalog.view().version);
    const authorizedDevice = await this.repository.authorizeOfflineInventoryDevice({
      ...this.ids,
      deviceCode: normalized.deviceId,
    });
    const operation = createOfflineOperation({
      organizationId: this.ids.organizationId,
      outletId: this.ids.outletId,
      deviceId: authorizedDevice.deviceCode,
      localOperationId: String(normalized.localSequence),
      kind: "HPP_OFFLINE_PHYSICAL_SALE_V1",
      baseVersions: {
        catalogVersion: normalized.baseHppVersion,
        pricingPolicyVersion: normalized.baseHppVersion,
        recipeVersion: normalized.baseHppVersion,
      },
      payload: normalized.payload,
      occurredAt: normalized.capturedAt,
    });
    return this.repository.enqueueOfflineInventoryOperation({ operation });
  }

  async syncOfflineInventorySale(deviceContext, input = {}) {
    const requested = normalizeOfflineInventorySyncInput(deviceContext, input, this.ids, this.hppCatalog.view().version);
    const queued = await this.enqueueOfflineInventorySale(deviceContext, input);
    if (queued.operatorReviewRequired) return queued;
    const stored = await this.repository.loadOfflineInventoryOperation({ ...this.ids, operationId: queued.operationId });
    if (!stored) throw runtimeError("offline_inventory_persisted_operation_invalid", 500);
    let normalized;
    try {
      normalized = normalizeOfflineInventorySyncInput({
        ...this.ids,
        deviceId: stored.deviceId,
      }, stored.payload, this.ids, this.hppCatalog.view().version);
    } catch (error) {
      if (error?.code === "offline_device_scope_denied" || error?.code === "offline_device_not_authorized") throw error;
      throw runtimeError("offline_inventory_persisted_operation_invalid", 500);
    }
    const storedVersions = stored.baseVersions ?? {};
    if (stored.kind !== "HPP_OFFLINE_PHYSICAL_SALE_V1" || stored.localOperationId !== String(normalized.localSequence)
      || stored.occurredAt !== normalized.capturedAt || storedVersions.catalogVersion !== normalized.baseHppVersion
      || storedVersions.pricingPolicyVersion !== normalized.baseHppVersion || storedVersions.recipeVersion !== normalized.baseHppVersion
      || requested.deviceId !== normalized.deviceId) {
      throw runtimeError("offline_inventory_persisted_operation_invalid", 500);
    }
    if (queued.status === "APPLIED") {
      let consumption = this.hppCatalog.exportState().saleConsumptions.find((item) => item.sourceEvent?.eventId === normalized.eventId);
      if (!consumption) {
        const latest = await this.repository.loadHppCatalogState(this.ids);
        if (latest) {
          this.hppCatalog.restoreState(latest.snapshot);
          this.hppCatalogRevision = latest.revision;
          consumption = this.hppCatalog.exportState().saleConsumptions.find((item) => item.sourceEvent?.eventId === normalized.eventId);
        }
      }
      if (!consumption) throw runtimeError("offline_inventory_applied_fact_missing", 500);
      return { ...queued, consumption, idempotentReplay: true };
    }

    const state = this.#capture();
    try {
      const result = this.hppCatalog.consumePreparingOrder({
        orderId: normalized.orderId,
        orderNumber: normalized.orderNumber,
        paidAt: normalized.capturedAt,
        preparingAt: normalized.capturedAt,
        productionStartId: normalized.eventId,
        consumptionReason: "OFFLINE_PHYSICAL_SALE",
        actorId: `OFFLINE_DEVICE:${normalized.deviceId}`,
        items: normalized.items,
        offlineEvent: {
          eventId: normalized.eventId,
          deviceId: normalized.deviceId,
          localSequence: normalized.localSequence,
          capturedAt: normalized.capturedAt,
          baseHppVersion: normalized.baseHppVersion,
        },
      });
      const persisted = await this.repository.applyOfflineInventoryOperation({
        ...this.ids,
        operationId: queued.operationId,
        actorReference: normalized.deviceId,
        appliedAt: this.clock().toISOString(),
        hppCatalogMutation: this.#hppMutationSince(state),
        businessResult: {
          consumptionId: result.consumption.id,
          status: result.consumption.status,
          requiresReview: result.consumption.requiresReview,
        },
      });
      if (persisted.idempotentReplay) {
        const latest = await this.repository.loadHppCatalogState(this.ids);
        if (latest) {
          this.hppCatalog.restoreState(latest.snapshot);
          this.hppCatalogRevision = latest.revision;
        }
      } else if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      const consumption = this.hppCatalog.exportState().saleConsumptions.find((item) => item.sourceEvent?.eventId === normalized.eventId);
      return { ...persisted, consumption, idempotentReplay: persisted.idempotentReplay || result.idempotentReplay };
    } catch (error) {
      this.#restore(state);
      if (error?.code === "offline_event_idempotency_conflict") {
        return this.repository.markOfflineInventoryOperationReview({
          ...this.ids,
          operationId: queued.operationId,
          conflictFingerprint: fingerprint(normalized.payload),
        });
      }
      if (error?.code === "hpp_persistence_version_conflict" || error?.message === "hpp_persistence_version_conflict") {
        const latest = await this.repository.loadHppCatalogState(this.ids);
        if (latest) {
          this.hppCatalog.restoreState(latest.snapshot);
          this.hppCatalogRevision = latest.revision;
        }
      }
      throw error;
    }
  }

  async startKioskSession() {
    const state = this.#capture();
    const session = super.startKioskSession();
    try {
      await this.repository.saveKioskSession({ ...session, ...this.ids });
      return session;
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  quote(sessionId, cart, options = {}) {
    return super.quote(sessionId, cart, this.#productionCanaryRequest(options));
  }

  async beginKioskCheckout(sessionId, input = {}) {
    if (String(input.paymentMethod ?? "").toUpperCase() === "QRIS_STATIC_MANUAL") {
      if (!this.kioskManualQrisEnabled || !(await this.manualQrisAsset())) throw runtimeError("manual_qris_asset_required", 409);
    }
    if (String(input.paymentMethod ?? "").toUpperCase() === "QRIS_STATIC_DEMO") {
      if (!this.kioskStaticDemoStore) throw runtimeError("kiosk_static_demo_persistence_required", 503);
      if (this.kioskMemberContexts.get(sessionId)?.memberId) throw runtimeError("kiosk_static_demo_member_unavailable", 409);
      const pending = this.kioskStaticDemoInFlight.get(sessionId);
      if (pending) {
        await pending;
        return this.beginKioskCheckout(sessionId, input);
      }
      const operation = this.#persistKioskStaticDemoCheckout(sessionId, input);
      this.kioskStaticDemoInFlight.set(sessionId, operation);
      try { return await operation; }
      finally { if (this.kioskStaticDemoInFlight.get(sessionId) === operation) this.kioskStaticDemoInFlight.delete(sessionId); }
    }
    const state = this.#capture();
    try {
      const request = this.#productionCanaryRequest(input);
      const response = super.beginKioskCheckout(sessionId, request);
      if (request.testMode === true) return response;
      if (String(request.paymentMethod ?? "").toUpperCase() !== "QRIS_STATIC_MANUAL") await this.#attachLivePayment(response, request);
      const persisted = await this.repository.createCheckout({ ...await this.#checkoutInput(response.order.id, request), hppCatalogMutation: this.#hppMutationSince(state) });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      this.#applyPersistedReference(response.order.id, persisted, response);
      response.memberSynchronization = await this.synchronizeMemberCommerce(response.order.id);
      return response;
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async #persistKioskStaticDemoCheckout(sessionId, input) {
      const state = this.#capture();
      try {
        const response = super.beginKioskCheckout(sessionId, input);
        if (response.idempotentReplay) return response;
        const payment = this.payments.find((item) => item.id === response.payment.id);
        payment.qrImageUrl = "/api/kiosk/static-qris-demo/image";
        const snapshot = this.kioskStaticDemoState(response.order.id, this.ids);
        const persisted = await this.kioskStaticDemoStore.persist({
          ...this.ids, orderId: response.order.id, kioskSessionId: sessionId,
          idempotencyKey: response.order.idempotencyKey, expectedRevision: snapshot.revision,
          state: snapshot, eventKey: `checkout:${sessionId}:${response.order.idempotencyKey}`,
          eventType: "KIOSK_STATIC_DEMO_CHECKOUT_CREATED_V1",
        });
        this.restoreKioskStaticDemoState(persisted);
        return { ...super.refreshKioskPayment(sessionId, { paymentId: response.payment.id }), idempotentReplay: false };
      } catch (error) { this.#restore(state); throw error; }
  }

  async confirmKioskStaticQrisDemo(actor, input = {}) {
    if (!this.kioskStaticDemoStore) throw runtimeError("kiosk_static_demo_persistence_required", 503);
    const key = String(input.paymentId ?? "");
    const pending = this.kioskStaticDemoConfirmInFlight.get(key);
    if (pending) {
      await pending;
      return this.confirmKioskStaticQrisDemo(actor, input);
    }
    const operation = this.#persistKioskStaticDemoConfirmation(actor, input);
    this.kioskStaticDemoConfirmInFlight.set(key, operation);
    try { return await operation; }
    finally { if (this.kioskStaticDemoConfirmInFlight.get(key) === operation) this.kioskStaticDemoConfirmInFlight.delete(key); }
  }

  async confirmKioskManualQris(actor, input = {}) {
    if (!this.kioskManualQrisEnabled || !(await this.manualQrisAsset())) throw runtimeError("manual_qris_asset_required", 409);
    const state = this.#capture();
    try {
      const response = super.confirmKioskManualQris(actor, input);
      const persisted = await this.repository.confirmManualQrisPaid({
        ...this.ids, paymentId: input.paymentId, actorReference: actor.employeeId,
        merchantReference: input.merchantReference, observedAmountRupiah: input.observedAmountRupiah,
        paidAt: response.payment.paidAt ?? this.clock().toISOString(),
        hppCatalogMutation: this.#hppMutationSince(state),
      });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      return { ...response, idempotentReplay: persisted.idempotentReplay };
    } catch (error) { this.#restore(state); throw error; }
  }

  async #persistKioskStaticDemoConfirmation(actor, input) {
    const state = this.#capture();
    try {
      const result = super.confirmKioskStaticQrisDemo(actor, input);
      if (result.idempotentReplay) return result;
      const snapshot = this.kioskStaticDemoState(result.order.id, this.ids);
      const persisted = await this.kioskStaticDemoStore.persist({
        ...this.ids, orderId: result.order.id, kioskSessionId: result.order.kioskSessionId,
        idempotencyKey: result.order.idempotencyKey, expectedRevision: snapshot.revision,
        state: snapshot, eventKey: `confirm:${input.paymentId}`,
        eventType: "KIOSK_STATIC_DEMO_STAFF_CONFIRMED_V1",
        actorReference: `CASHIER:${actor.employeeId}`,
      });
      this.restoreKioskStaticDemoState(persisted);
      return { ...super.refreshKioskPayment(result.order.kioskSessionId, { paymentId: input.paymentId }), idempotentReplay: persisted.idempotentReplay };
    } catch (error) { this.#restore(state); throw error; }
  }

  async kioskStaticDemoAsset() {
    if (!this.kioskStaticDemoStore) throw runtimeError("kiosk_static_demo_persistence_required", 503);
    return this.kioskStaticDemoStore.loadAsset(this.ids);
  }

  async manualQrisAsset() {
    if (!this.manualQrisAssetStore) throw runtimeError("manual_qris_asset_unavailable", 503);
    return this.manualQrisAssetStore.load(this.ids);
  }

  async replaceManualQrisAsset(actor, { imageDataUrl, expectedRevision } = {}) {
    if (actor?.role !== "owner") throw runtimeError("owner_role_denied", 403);
    if (!this.manualQrisAssetStore) throw runtimeError("manual_qris_asset_unavailable", 503);
    if (typeof imageDataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl) || imageDataUrl.length > 360_000) throw runtimeError("manual_qris_png_invalid", 422);
    const result = await this.manualQrisAssetStore.replace({
      ...this.ids, pngBytes: Buffer.from(imageDataUrl.split(",")[1], "base64"),
      expectedRevision, actorReference: `OWNER:${actor.employeeId}`,
    });
    this.kioskManualQrisEnabled = this.kioskManualQrisActivationArmed;
    return { ...result, checkoutEnabled: this.kioskManualQrisEnabled };
  }

  async replaceKioskStaticDemoAsset(actor, { imageDataUrl, expectedRevision } = {}) {
    if (actor?.role !== "owner") throw runtimeError("owner_role_denied", 403);
    if (!this.kioskStaticDemoStore) throw runtimeError("kiosk_static_demo_persistence_required", 503);
    if (typeof imageDataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl) || imageDataUrl.length > 360_000) throw runtimeError("kiosk_static_demo_png_invalid", 422);
    const bytes = Buffer.from(imageDataUrl.split(",")[1], "base64");
    return this.kioskStaticDemoStore.replaceAsset({ ...this.ids, pngBytes: bytes, expectedRevision, actorReference: `OWNER:${actor.employeeId}` });
  }

  async beginTableDemoCheckout(sessionId, input = {}, table = {}) {
    if (!this.tableDemoStore) throw runtimeError("table_order_persistence_required", 503);
    const state = this.#capture();
    try {
      const response = await super.beginTableDemoCheckout(sessionId, input, table);
      if (response.idempotentReplay) return response;
      const snapshot = this.tableDemoState(response.order.id, this.ids);
      const persisted = await this.tableDemoStore.persist({
        ...this.ids,
        orderId: response.order.id,
        kioskSessionId: sessionId,
        idempotencyKey: response.order.idempotencyKey,
        expectedRevision: snapshot.revision,
        state: snapshot,
        eventKey: `checkout:${sessionId}:${response.order.idempotencyKey}`,
        eventType: "TABLE_DEMO_CHECKOUT_CREATED_V1",
      });
      this.restoreTableDemoState(persisted);
      return { ...this.#tableDemoResponse(sessionId), idempotentReplay: response.idempotentReplay || persisted.idempotentReplay };
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async transitionTableDemoPayment(sessionId, input = {}) {
    if (!this.tableDemoStore) throw runtimeError("table_order_persistence_required", 503);
    const state = this.#capture();
    try {
      const response = super.transitionTableDemoPayment(sessionId, input);
      if (response.idempotentReplay) return response;
      const snapshot = this.tableDemoState(response.order.id, this.ids);
      const target = String(input.target ?? "").trim().toUpperCase() === "SUCCESS" ? "PAID" : String(input.target ?? "").trim().toUpperCase();
      const persisted = await this.tableDemoStore.persist({
        ...this.ids,
        orderId: response.order.id,
        kioskSessionId: sessionId,
        idempotencyKey: response.order.idempotencyKey,
        expectedRevision: snapshot.revision,
        state: snapshot,
        eventKey: `callback:${String(input.callbackId ?? "").trim()}`,
        eventType: `TABLE_DEMO_PAYMENT_${target}_V1`,
      });
      this.restoreTableDemoState(persisted);
      return { ...this.#tableDemoResponse(sessionId), idempotentReplay: response.idempotentReplay || persisted.idempotentReplay };
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async retryTableDemoPayment(sessionId, input = {}) {
    if (!this.tableDemoStore) throw runtimeError("table_order_persistence_required", 503);
    const state = this.#capture();
    try {
      const response = super.retryTableDemoPayment(sessionId, input);
      if (response.idempotentReplay) return response;
      const snapshot = this.tableDemoState(response.order.id, this.ids);
      const persisted = await this.tableDemoStore.persist({
        ...this.ids,
        orderId: response.order.id,
        kioskSessionId: sessionId,
        idempotencyKey: response.order.idempotencyKey,
        expectedRevision: snapshot.revision,
        state: snapshot,
        eventKey: `retry:${response.order.id}:${String(input.idempotencyKey ?? "").trim()}`,
        eventType: "TABLE_DEMO_PAYMENT_RETRIED_V1",
      });
      this.restoreTableDemoState(persisted);
      return { ...this.#tableDemoResponse(sessionId), idempotentReplay: response.idempotentReplay || persisted.idempotentReplay };
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async simulateQrisPaid(sessionId, input = {}) {
    if (this.gatewayClient) throw runtimeError("payment_simulator_disabled_in_production", 403);
    const state = this.#capture();
    try {
      const response = super.simulateQrisPaid(sessionId, input);
      const persisted = await this.repository.markGatewayPaid({
        ...this.ids,
        paymentId: input.paymentId,
        providerEventKey: String(input.callbackId || `local-paid:${input.paymentId}`),
        eventFingerprint: fingerprint({ paymentId: input.paymentId, status: "PAID", amountRupiah: response.payment.amountRupiah }),
        paidAt: response.payment.paidAt ?? this.clock().toISOString(),
        hppCatalogMutation: this.#hppMutationSince(state),
      });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      return response;
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async confirmKioskAssistedCash(actor, input = {}) {
    const state = this.#capture();
    try {
      const response = super.confirmKioskAssistedCash(actor, input);
      if (response.idempotentReplay) return response;
      const persisted = await this.repository.confirmAssistedCash({
        ...this.ids,
        paymentId: input.paymentId,
        cashSessionId: this.cashShift.id,
        actorReference: actor.employeeId,
        receivedRupiah: response.payment.receivedRupiah,
        changeRupiah: response.payment.changeRupiah,
        paidAt: response.payment.paidAt ?? this.clock().toISOString(),
        hppCatalogMutation: this.#hppMutationSince(state),
      });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      return response;
    } catch (error) {
      this.#restore(state);
      if (error.message === "assisted_cash_confirmation_conflict") throw runtimeError("assisted_cash_confirmation_conflict", 409);
      throw error;
    }
  }

  async openCashShift(actor, input = {}) {
    const state = this.#capture();
    try {
      const response = super.openCashShift(actor, input);
      await this.repository.saveCashSession({ session: response.shift, ...this.ids, actorReference: actor.employeeId });
      return response;
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async closeCashShift(actor, input = {}) {
    const state = this.#capture();
    try {
      requireReliabilityBody(input);
      const pendingCashAssists = this.payments.filter((payment) => payment.methodType === "cash" && payment.assistedCash === true && payment.status === "PENDING");
      if (pendingCashAssists.length) return { status: "open", blocked: true, blockReason: "pending_cash_assists_required", pendingCashAssists: pendingCashAssists.length };
      if (this.repository.requiresEsbCatalogSnapshot?.() && typeof this.repository.closeShiftFromLedger === "function") {
        if (actor?.role !== "owner") throw runtimeError("shift_close_owner_authorization_required", 403);
        if (!Number.isSafeInteger(input.actualCashRupiah) || input.actualCashRupiah < 0) throw runtimeError("cash_count_required", 422);
        const cashToLeaveRupiah = input.cashToLeaveRupiah ?? 300_000;
        if (!Number.isSafeInteger(cashToLeaveRupiah) || cashToLeaveRupiah < 0 || cashToLeaveRupiah > input.actualCashRupiah) throw runtimeError("cash_to_leave_invalid", 422);
        const operationKey = String(input.operationKey ?? "").trim();
        const authorizationId = input.authorizationId == null ? null : String(input.authorizationId).trim();
        if (!operationKey) throw runtimeError("shift_close_operation_key_required", 422);
        const command = {
          ...this.ids, shiftId: this.cashShift?.id, operationKey, authorizationId,
          actorReference: actor.employeeId, reason: String(input.note ?? "Owner verified cash close").trim(),
          declaredCashRupiah: input.actualCashRupiah, cashToLeaveRupiah,
        };
        const result = await this.repository.closeShiftFromLedger({
          ...command,
          requestFingerprint: shiftCloseCommandFingerprint(command),
        });
        this.cashShift = {
          ...this.cashShift, status: "closed", expectedCashRupiah: result.expectedCashRupiah,
          actualCashRupiah: result.declaredCashRupiah, cashToLeaveRupiah: result.cashToLeaveRupiah,
          depositCashRupiah: result.depositCashRupiah, varianceRupiah: result.varianceRupiah, closedAt: result.closedAt,
        };
        return structuredClone({ ...result, blocked: false });
      }
      const response = super.closeCashShift(actor, input);
      if (!response.blocked) await this.repository.saveCashSession({ session: this.cashShift, ...this.ids, actorReference: actor.employeeId });
      return response;
    } catch (error) {
      this.#restore(state);
      throw reliabilityRuntimeError(error);
    }
  }

  async previewEsbShiftClose(actor, input = {}) {
    requireReliabilityManager(actor);
    requireReliabilityBody(input);
    if (!this.cashShift || this.cashShift.status !== "open") throw runtimeError("cash_session_open_required", 409);
    try {
      return await this.repository.previewShiftClose({
        ...this.ids, shiftId: this.cashShift.id,
        reason: String(input.reason ?? input.note ?? "").trim(),
        declaredCashRupiah: input.declaredCashRupiah,
        cashToLeaveRupiah: input.cashToLeaveRupiah ?? 0,
      });
    } catch (error) { throw reliabilityRuntimeError(error); }
  }

  async requestEsbShiftClose(actor, input = {}) {
    if (actor?.role !== "owner" || !actor.employeeId) throw runtimeError("shift_close_owner_authorization_required", 403);
    requireReliabilityBody(input);
    rejectClientIdentityFields(input);
    const operationKey = requiredRuntimeText(input.operationKey, "shift_close_operation_key_required");
    try {
      const preview = await this.previewEsbShiftClose(actor, input);
      return await this.repository.requestReliabilityAuthorization({
        ...this.ids, action: "shift:close", resourceType: "shift", resourceId: preview.authorizationResource,
        actorReference: actor.employeeId, operationKey,
        commandSnapshot: {
          shiftId: preview.shiftId, operationKey, reason: preview.reason,
          declaredCashRupiah: preview.declaredCashRupiah, cashToLeaveRupiah: preview.cashToLeaveRupiah,
          expectedCashRupiah: preview.expectedCashRupiah, varianceRupiah: preview.varianceRupiah,
          ledgerFingerprint: preview.ledgerFingerprint,
        },
      });
    } catch (error) { throw reliabilityRuntimeError(error); }
  }

  async requestEsbInventoryMovement() {
    throw runtimeError("esb_inventory_authority_retired", 410);
  }

  async approveEsbReliabilityRequest(actor, input = {}) {
    requireReliabilityManager(actor);
    requireReliabilityBody(input);
    rejectClientIdentityFields(input);
    if (actor.role !== 'owner' && (await this.repository.cashierDiscountApprovals({...this.ids,requestId:input.requestId})).length) throw runtimeError('owner_required',403);
    try {
      return await this.repository.approveReliabilityAuthorization({
        ...this.ids,
        requestId: requiredRuntimeText(input.requestId, "approval_request_id_required"),
        approvedByReference: actor.employeeId,
      });
    } catch (error) { throw reliabilityRuntimeError(error); }
  }

  async executeEsbInventoryMovement() {
    throw runtimeError("esb_inventory_authority_retired", 410);
  }

  async readEsbInventoryLedger() {
    throw runtimeError("esb_inventory_authority_retired", 410);
  }

  async cashierRecovery(actor, key) {
    // Read persisted facts without replacing mutable state of an in-flight checkout.
    super.cashierRecovery(actor, key); // Validate identity/key before any repository read.
    const reader = new DurablePosVerticalSliceRuntime({ repository: this.repository, ids: this.ids, clock: this.clock });
    reader.#hydrate(await this.repository.loadRuntimeState(this.ids));
    // ponytail: reuse the outlet snapshot reader; add a scoped lookup if pilot recovery traffic grows.
    return PosVerticalSliceRuntime.prototype.cashierRecovery.call(reader, actor, key);
  }

  async cashierCheckout(actor, input = {}) {
    // ponytail: serialize this runtime's cashier writes; DB remains cross-process authority.
    const previous = this.cashierWriteTail ?? Promise.resolve();
    const run = previous.catch(()=>{}).then(()=>this.persistCashierCheckout(actor,input));
    this.cashierWriteTail = run.catch(()=>{});
    return run;
  }

  async persistCashierCheckout(actor, input = {}) {
    const replayKey=`cashier:${actor.employeeId}:${String(input.idempotencyKey??'').trim()}`;
    if(!this.checkoutByKey.has(replayKey))input=await this.prepareCashierInput(actor,input);
    if (input.paymentMethod === 'QRIS_STATIC_MANUAL' && !(await this.manualQrisAsset())) throw runtimeError('manual_qris_asset_required',409);
    const state = this.#capture();
    let committed = false;
    try {
      const request = input.paymentMethod === "CASH" ? input : this.#productionCanaryRequest(input);
      const response = super.cashierCheckout(actor, request);
      await this.#attachLivePayment(response, request);
      const persisted = await this.repository.createCheckout({ ...await this.#checkoutInput(response.order.id, request, actor.employeeId), hppCatalogMutation: this.#hppMutationSince(state) });
      committed = true;
      if (response.payment.methodType === "cash" && persisted.idempotentReplay && persisted.orderId !== response.order.id) {
        this.#restore(state);
        await this.initialize();
        const replayKey = `cashier:${actor.employeeId}:${String(request.idempotencyKey ?? "").trim()}`;
        if (this.checkoutByKey.get(replayKey) !== persisted.orderId) throw runtimeError("cashier_checkout_replay_scope_conflict", 409);
        const replay = super.cashierCheckout(actor, request);
        if (!replay.idempotentReplay || replay.order.id !== persisted.orderId) throw runtimeError("cashier_checkout_replay_scope_conflict", 409);
        replay.memberSynchronization = await this.synchronizeMemberCommerce(replay.order.id);
        return replay;
      }
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      this.#applyPersistedReference(response.order.id, persisted, response);
      response.memberSynchronization = await this.synchronizeMemberCommerce(response.order.id);
      return response;
    } catch (error) {
      if (!committed) this.#restore(state);
      if (error.message === "cashier_cash_confirmation_conflict") throw runtimeError("cashier_cash_confirmation_conflict", 409);
      throw error;
    }
  }

  async discountApprovalState(actor) {
    super.discountApprovalState(actor);
    if (typeof this.repository.cashierDiscountApprovals !== 'function') {
      return {available:false,staffLimitRupiah:null,requests:[]};
    }
    const catalog = await this.repository.loadCatalogState(this.ids);
    const rows = await this.repository.cashierDiscountApprovals({...this.ids, actorReference:actor.role === 'owner' ? null : actor.employeeId});
    return {staffLimitRupiah:catalog?.snapshot.manualDiscountStaffLimitRupiah ?? 0,requests:rows.map(row=>({...row.command_snapshot,requestId:row.id,authorizationId:row.authorization_id,status:row.authorization_status ?? row.status,approvedBy:row.approved_by_reference,expiresAt:row.expires_at ? new Date(row.expires_at).toISOString() : null}))};
  }

  async requestDiscountApproval(actor, input = {}) {
    const prepared = await this.prepareCashierInput(actor,input);
    const command = this.discountApprovalCommand(actor,prepared);
    return this.repository.requestReliabilityAuthorization({...this.ids, action:'cashier:discount',resourceType:'cashier_cart',resourceId:command.resourceId,actorReference:actor.employeeId,operationKey:command.operationKey,commandSnapshot:command});
  }

  async approveDiscount(actor, {requestId} = {}) {
    if (actor?.role !== 'owner' || !actor.employeeId) throw runtimeError('owner_required',403);
    const state = await this.discountApprovalState(actor);
    if (state.available === false) throw runtimeError('cashier_discount_approval_unavailable',503);
    if (!state.requests.some(item=>item.requestId === requestId)) throw runtimeError('approval_request_not_found',404);
    return this.repository.approveReliabilityAuthorization({...this.ids,requestId,approvedByReference:actor.employeeId});
  }

  async prepareCashierInput(actor,input) {
    if (input.manualDiscount && actor?.role === 'cashier') {
      if (typeof this.repository.cashierDiscountApprovals !== 'function') throw runtimeError('cashier_discount_approval_unavailable',503);
      const catalog = await this.repository.loadCatalogState(this.ids);
      if (catalog && catalog.revision !== this.catalogRevision) {this.catalogPricing.restoreState(catalog.snapshot);this.catalogRevision=catalog.revision;}
      const state = await this.discountApprovalState(actor);
      this.catalogPricing.manualDiscountStaffLimitRupiah = state.staffLimitRupiah;
      for (const item of state.requests) if (item.authorizationId) this.discountApprovals.set(item.authorizationId,item);
    }
    return super.prepareCashierInput(actor,input);
  }

  async settleOperatorQris(actor, input = {}) {
    if (this.gatewayClient) throw runtimeError("payment_simulator_disabled_in_production", 403);
    const state = this.#capture();
    try {
      const response = super.settleOperatorQris(actor, input);
      const persisted = await this.repository.markGatewayPaid({
        ...this.ids,
        paymentId: input.paymentId,
        providerEventKey: String(input.callbackId || `operator-paid:${input.paymentId}`),
        eventFingerprint: fingerprint({ paymentId: input.paymentId, status: "PAID", amountRupiah: response.payment.amountRupiah }),
        paidAt: response.payment.paidAt ?? this.clock().toISOString(),
        hppCatalogMutation: this.#hppMutationSince(state),
      });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      response.memberSynchronization = await this.synchronizeMemberCommerce(response.order.id);
      return response;
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async recordCashierExpense(actor, input = {}) {
    if (this.repository.requiresEsbCatalogSnapshot?.()) throw runtimeError('expense_esb_posting_unavailable',409);
    const state = this.#capture();
    try {
      const result = super.recordCashierExpense(actor,input);
      const saved = await this.repository.saveCashierExpense({ ...this.ids, expense: result.expense, actorReference: actor.employeeId });
      return { ...result, idempotentReplay: result.idempotentReplay || saved.idempotentReplay };
    } catch(error) { this.#restore(state); throw error; }
  }

  async voidCashierExpense(actor, input = {}) {
    if (this.repository.requiresEsbCatalogSnapshot?.()) throw runtimeError('expense_esb_posting_unavailable',409);
    const state=this.#capture();
    try {
      const result=super.voidCashierExpense(actor,input);
      const saved=await this.repository.voidCashierExpense({...this.ids,expense:result.expense,actorReference:actor.employeeId});
      return {...result,idempotentReplay:result.idempotentReplay || saved.idempotentReplay};
    } catch(error) {this.#restore(state);throw error;}
  }

  async advanceFulfillment(role, input = {}) {
    const order = this.orders.find((item) => item.id === input.orderId);
    if (order?.testMode === true && order.channel === "KIOSK" && order.demoPayment === true) {
      if (!this.kioskStaticDemoStore) throw runtimeError("kiosk_static_demo_persistence_required", 503);
      const state = this.#capture();
      try {
        const local = super.advanceFulfillment(role, input);
        if (local.idempotentReplay) return local;
        const snapshot = this.kioskStaticDemoState(order.id, this.ids);
        const action = local.action ?? local.status;
        const eventType = ({ ACKNOWLEDGED: "ACKNOWLEDGED", PREPARING: "PREPARING", IN_PROGRESS: "PREPARING", READY: "READY", SERVED: "SERVED", COMPLETED: "SERVED", CANCELLED: "CANCELLED", REMAKE: "REMAKE" })[action];
        if (!eventType) throw runtimeError("kiosk_static_demo_fulfillment_invalid", 409);
        const persisted = await this.kioskStaticDemoStore.persist({
          ...this.ids, orderId: order.id, kioskSessionId: order.kioskSessionId,
          idempotencyKey: order.idempotencyKey, expectedRevision: snapshot.revision,
          state: snapshot, eventKey: `kds:${order.id}:${action}:${String(input.station ?? "all").trim().toLowerCase()}:${local.remakeCount ?? 0}`,
          eventType: `KIOSK_STATIC_DEMO_KDS_${eventType}_V1`, actorReference: `KDS:${role}`,
        });
        this.restoreKioskStaticDemoState(persisted);
        return { ...local, idempotentReplay: persisted.idempotentReplay };
      } catch (error) { this.#restore(state); throw error; }
    }
    if (order?.testMode === true && order.channel !== "TABLE") return super.advanceFulfillment(role, input);
    if (order?.testMode === true && order.channel === "TABLE") {
      if (!this.tableDemoStore) throw runtimeError("table_order_persistence_required", 503);
      const state = this.#capture();
      try {
        const local = super.advanceFulfillment(role, input);
        if (local.idempotentReplay) return local;
        const snapshot = this.tableDemoState(order.id, this.ids);
        const eventType = ({
          ACKNOWLEDGED: "TABLE_DEMO_KDS_ACKNOWLEDGED_V1",
          PREPARING: "TABLE_DEMO_KDS_PREPARING_V1",
          IN_PROGRESS: "TABLE_DEMO_KDS_PREPARING_V1",
          READY: "TABLE_DEMO_KDS_READY_V1",
          SERVED: "TABLE_DEMO_KDS_SERVED_V1",
          COMPLETED: "TABLE_DEMO_KDS_SERVED_V1",
          CANCELLED: "TABLE_DEMO_KDS_CANCELLED_V1",
          REMAKE: "TABLE_DEMO_KDS_REMAKE_V1",
        })[local.action ?? local.status];
        if (!eventType) throw runtimeError("table_demo_fulfillment_transition_invalid", 409);
        const persisted = await this.tableDemoStore.persist({
          ...this.ids,
          orderId: order.id,
          kioskSessionId: order.kioskSessionId,
          idempotencyKey: order.idempotencyKey,
          expectedRevision: snapshot.revision,
          state: snapshot,
          eventKey: `kds:${order.id}:${local.action ?? local.status}:${String(input.station ?? "all").trim().toLowerCase()}:${local.remakeCount ?? 0}`,
          eventType,
          actorReference: `KDS:${role}`,
        });
        this.restoreTableDemoState(persisted);
        return { ...this.#tableDemoResponse(order.kioskSessionId).fulfillment, idempotentReplay: persisted.idempotentReplay };
      } catch (error) {
        this.#restore(state);
        throw error;
      }
    }
    const state = this.#capture();
    try {
      const local = super.advanceFulfillment(role, input);
      const hppCatalogMutation = this.#hppMutationSince(state);
      const previousFulfillment = new Map(state.fulfillments).get(input.orderId);
      const existingConsumption = this.hppCatalog.exportState().saleConsumptions.find((consumption) => consumption.orderId === input.orderId);
      const inventoryConsumptionDecision = !previousFulfillment?.prepStartedAt && local.status === "IN_PROGRESS"
        ? { orderId: input.orderId, outcome: hppCatalogMutation ? "PERSISTED" : existingConsumption?.trigger === "PAYMENT_PAID_LEGACY" ? "LEGACY_PRIOR_CONSUMPTION" : "UNMAPPED_NO_MUTATION" }
        : null;
      const persisted = await this.repository.transitionFulfillment({
        ...this.ids,
        orderId: input.orderId,
        status: input.target,
        station: input.station,
        reason: input.reason,
        actorReference: role,
        transitionedAt: local.updatedAt,
        inventoryConsumptionDecision,
        hppCatalogMutation,
      });
      if (persisted.idempotentReplay && !local.idempotentReplay) {
        this.#restore(state);
        const latestHpp = await this.repository.loadHppCatalogState(this.ids);
        if (latestHpp) {
          this.hppCatalog.restoreState(latestHpp.snapshot);
          this.hppCatalogRevision = latestHpp.revision;
        }
      }
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      const response = {
        ...local, ...durableFulfillmentProjection(persisted), stationProgress: persisted.payload_snapshot?.stationProgress,
        updatedAt: iso(persisted.updated_at), prepStartedAt: iso(persisted.prep_started_at),
        readyAt: iso(persisted.ready_at), completedAt: iso(persisted.completed_at), idempotentReplay: persisted.idempotentReplay,
      };
      this.fulfillments.set(input.orderId, response);
      return structuredClone(response);
    } catch (error) {
      this.#restore(state);
      throw error;
    }
  }

  async refreshKioskPayment(sessionId, { paymentId } = {}) {
    const session = this.kioskSessions.get(sessionId);
    const payment = this.payments.find((item) => item.id === paymentId);
    const order = payment ? this.orders.find((item) => item.id === payment.orderId) : null;
    if (!session || !payment || !order || order.kioskSessionId !== sessionId) throw runtimeError("payment_scope_denied", 403);
    if (payment.staticQrisDemo === true || payment.staticQrisManual === true || (payment.methodType === "cash" && payment.assistedCash === true)) return super.refreshKioskPayment(sessionId, { paymentId });
    const state = this.#capture();
    try { return await this.#refreshGatewayPayment(payment, state); }
    catch (error) { this.#restore(state); throw error; }
  }

  async refreshOperatorPayment(actor, { paymentId } = {}) {
    if (!actor || !["cashier", "owner"].includes(actor.role)) throw runtimeError("cashier_role_denied", 403);
    const payment = this.payments.find((item) => item.id === paymentId);
    if (!payment) throw runtimeError("payment_not_found", 404);
    if (payment.staticQrisDemo === true || payment.staticQrisManual === true) {
      const order = this.orders.find((item) => item.id === payment.orderId);
      if (!order) throw runtimeError("payment_not_found", 404);
      return super.refreshKioskPayment(order.kioskSessionId, { paymentId });
    }
    const state = this.#capture();
    try { return await this.#refreshGatewayPayment(payment, state); }
    catch (error) { this.#restore(state); throw error; }
  }

  ownerOrderDetail(role, id) {
    const detail=super.ownerOrderDetail(role,id);
    if (this.repository.requiresEsbCatalogSnapshot?.()) detail.cashRefundAvailable=false;
    return detail;
  }

  previewOwnerRefund(role, payload = {}) {
    const preview=super.previewOwnerRefund(role,payload);
    if (payload.items !== undefined && this.repository.requiresEsbCatalogSnapshot?.()) throw runtimeError('partial_refund_esb_ledger_unavailable',409);
    return preview;
  }

  async adminAction(role, actorId, action, payload = {}) {
    if (action !== 'order.refund') return this.persistAdminAction(role,actorId,action,payload);
    const previous=this.cashierWriteTail ?? Promise.resolve();
    const run=previous.catch(()=>{}).then(()=>this.persistAdminAction(role,actorId,action,payload));
    this.cashierWriteTail=run.catch(()=>{});
    return run;
  }

  async persistAdminAction(role, actorId, action, payload = {}) {
    if (["hpp.purchase_order.receive", "hpp.purchase.receive"].includes(action) && role === "owner") {
      return this.adminAction(role, actorId, "hpp.purchase_receipt.post", normalizeLegacyReceiptPayload(payload, this.ids.outletId));
    }
    if (action.startsWith("esb.catalog.")) {
      if (role !== "owner") throw runtimeError("owner_required", 403);
      if (!this.esbCatalogRuntime) throw runtimeError("catalog_runtime_unavailable", 503);
      const command = {
        ...payload,
        ...this.ids,
        role,
        actorUserId: this.ids.ownerProfileId,
        actorReference: actorId,
      };
      if (action === "esb.catalog.draft.create") return this.esbCatalogRuntime.createDraft(command);
      if (action === "esb.catalog.version.publish") return this.esbCatalogRuntime.publish(command);
      if (action === "esb.catalog.free_price.authorize") return this.esbCatalogRuntime.authorizeFreePrice(command);
      throw runtimeError("admin_action_not_found", 404);
    }
    if (action === "hpp.purchase_receipt.post" && role === "owner") {
      await this.repository.authorizePurchaseReceiptLocations({ ...this.ids, ...payload });
    }
    if (action === "hpp.purchase_receipt.inspection.decide" && role === "owner") {
      await this.repository.authorizePurchaseInspectionLocation({ ...this.ids, ...payload });
    }
    const state = this.#capture();
    const catalogBefore = this.catalogPricing.exportState();
    const hppBefore = this.hppCatalog.exportState();
    try {
      let response = super.adminAction(role, actorId, action, payload);
      if (action === "payment.settlement.review") {
        const persisted = await this.repository.recordPaymentSettlementReview({ ...this.ids, actorReference: actorId, ...payload });
        response = { ...response, idempotentReplay: response.idempotentReplay || persisted.idempotentReplay };
      }
      if (action === "order.remake") {
        const persisted = await this.repository.persistRemakeQueue({
          ...this.ids,
          remake: immutableRemakeQueueFact(response),
        });
        if (persisted.idempotentReplay) this.#restore(state);
        this.#upsertRemake(this.#projectRemakeStatus(persisted.remake));
        if (!this.events.some((event) => event.type === "order.remake.queued" && event.payload?.remakeId === persisted.remake.id)) {
          this.events.push({
            id: `durable-remake-${persisted.remake.id}`,
            type: "order.remake.queued",
            payload: {
              actorId: persisted.remake.actorId,
              orderId: persisted.remake.orderId,
              remakeId: persisted.remake.id,
              idempotencyKey: persisted.remake.queueIdempotencyKey,
            },
            occurredAt: persisted.remake.createdAt,
          });
        }
        response = { ...structuredClone(this.remakes.find((item) => item.id === persisted.remake.id)), idempotentReplay: persisted.idempotentReplay };
      }
      if (action.startsWith("catalog.workspace.") || ["catalog.discount_limit.update", "catalog.availability", "catalog.availability.draft", "catalog.category.create", "catalog.category.update", "catalog.product.create", "catalog.product.update", "catalog.product.archive", "catalog.product.restore", "catalog.publication.rollback", "catalog.product.media.update", "catalog.product.media.remove", "catalog.product.publish", "catalog.pricing.update", "catalog.promotion.upsert", "catalog.promotion.status", "catalog.variant.group.upsert", "catalog.variant.option.upsert", "catalog.modifier.group.upsert", "catalog.modifier.option.upsert", "catalog.ordering.update"].includes(action)) {
        this.catalogRevision = await this.repository.saveCatalogState({ ...this.ids, expectedRevision: this.catalogRevision, snapshot: this.catalogPricing.exportState() });
      }
      const purchaseReceiptAction = ["hpp.purchase_receipt.post", "hpp.purchase_order.receive", "hpp.purchase.receive"].includes(action);
      const purchaseInspectionAction = action === "hpp.purchase_receipt.inspection.decide";
      const purchaseInvoicePostAction = action === "hpp.purchase_invoice.post";
      if ((action.startsWith("hpp.") || action === "order.remake.start") && response.idempotentReplay !== true && !(action === "order.remake.start" && response.idempotentReplay) && !(purchaseReceiptAction && response.idempotentReplay) && !(purchaseInspectionAction && response.idempotentReplay) && !(purchaseInvoicePostAction && response.idempotentReplay)) {
        if (purchaseReceiptAction) {
          const persisted = await this.repository.persistPurchaseReceipt({
            ...this.ids,
            actorReference: actorId,
            expectedRevision: this.hppCatalogRevision,
            snapshot: this.hppCatalog.exportState(),
            receiptId: response.receipt.id,
          });
          this.hppCatalogRevision = persisted.hppCatalogRevision;
        } else if (purchaseInspectionAction) {
          const persisted = await this.repository.persistPurchaseInspectionDecision({
            ...this.ids,
            actorReference: actorId,
            expectedRevision: this.hppCatalogRevision,
            snapshot: this.hppCatalog.exportState(),
            decisionId: response.decision.id,
          });
          this.hppCatalogRevision = persisted.hppCatalogRevision;
        } else if (purchaseInvoicePostAction) {
          const persisted = await this.repository.persistPurchaseInvoicePost({
            ...this.ids,
            actorReference: actorId,
            expectedRevision: this.hppCatalogRevision,
            snapshot: this.hppCatalog.exportState(),
            purchaseInvoiceId: response.invoice.id,
          });
          this.hppCatalogRevision = persisted.hppCatalogRevision;
        } else {
          this.hppCatalogRevision = await this.repository.saveHppCatalogState({ ...this.ids, expectedRevision: this.hppCatalogRevision, snapshot: this.hppCatalog.exportState() });
        }
      }
      if (action === "order.refund") {
        const persisted = await this.repository.persistRefund({
          ...this.ids,
          orderId: payload.orderId,
          cashSessionId: this.cashShift?.status === "open" ? this.cashShift.id : null,
          actorReference: actorId,
          reason: payload.reason,
          items:payload.items,
          idempotencyKey:payload.idempotencyKey,
          refundId:response.id,
          expectedRefundCount:state.refunds.filter(refund=>refund.orderId === payload.orderId).length,
          refundedAt: response.createdAt,
          hppCatalogMutation: this.#hppMutationSince(state),
        });
        if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
        if (persisted.idempotentReplay) this.#restore(state);
        if (persisted.refund) {
          response={...persisted.refund,idempotentReplay:persisted.idempotentReplay === true};
          this.refunds=this.refunds.filter(refund=>refund.orderId !== response.orderId || refund.operationKey !== response.operationKey);
          this.refunds.push(structuredClone(response));
          const order=this.orders.find(order=>order.id === response.orderId),payment=this.payments.find(payment=>payment.orderId === response.orderId);
          if (response.status === 'REFUNDED_LOCAL' && response.full) {order.status='REFUNDED';if(payment)payment.status='REFUNDED';}
          if (payment?.methodType === 'cash' && !this.cashMovements.some(movement=>movement.id === response.id)) this.cashMovements.push({id:response.id,type:'REFUND',orderId:response.orderId,cashSessionId:response.cashSessionId,amountRupiah:-response.amountRupiah,actorId:response.actorId,occurredAt:response.createdAt});
        }
      }
      return response;
    } catch (error) {
      this.#restore(state);
      this.catalogPricing.restoreState(catalogBefore);
      this.hppCatalog.restoreState(hppBefore);
      if (error.code === "catalog_version_conflict") {
        const latest = await this.repository.loadCatalogState(this.ids);
        if (latest) {
          this.catalogPricing.restoreState(latest.snapshot);
          this.catalogRevision = latest.revision;
        }
      }
      if (error.code === "hpp_persistence_version_conflict") {
        const latest = await this.repository.loadHppCatalogState(this.ids);
        if (latest) { this.hppCatalog.restoreState(latest.snapshot); this.hppCatalogRevision = latest.revision; }
      }
      throw error;
    }
  }

  async esbCatalogAdminState(role) {
    if (role !== "owner") throw runtimeError("owner_required", 403);
    if (!this.esbCatalogRuntime) return { mode: "UNAVAILABLE", runtimeGuard: "DEFAULT_OFF", versions: [] };
    const state = await this.esbCatalogRuntime.adminState({
      ...this.ids,
      actorUserId: this.ids.ownerProfileId,
      actorReference: this.ids.ownerProfileId,
    });
    return { ...state, runtimeGuard: this.repository.esbRuntimeStatus?.().writeVersion ?? "OFF" };
  }

  async readInventoryAvailability(actor, input = {}) {
    if (!this.inventoryPlanningRuntime) throw runtimeError("inventory_planning_runtime_unavailable", 503);
    return this.inventoryPlanningRuntime.availability(actor, input);
  }

  async readInventoryAtp(actor, input = {}) {
    if (!this.inventoryPlanningRuntime) throw runtimeError("inventory_planning_runtime_unavailable", 503);
    return this.inventoryPlanningRuntime.atp(actor, input);
  }

  async readReplenishment(actor, input = {}) {
    if (!this.inventoryPlanningRuntime) throw runtimeError("inventory_planning_runtime_unavailable", 503);
    return this.inventoryPlanningRuntime.replenishment(actor, input);
  }

  async recommendReplenishment(actor, input = {}) {
    if (!this.inventoryPlanningRuntime) throw runtimeError("inventory_planning_runtime_unavailable", 503);
    return this.inventoryPlanningRuntime.recommend(actor, input);
  }

  async upsertReplenishmentPolicy(actor, input = {}) {
    if (!this.inventoryPlanningRuntime) throw runtimeError("inventory_planning_runtime_unavailable", 503);
    return this.inventoryPlanningRuntime.upsertPolicy(actor, input);
  }

  async executeEsbException(actor, payload) {
    if (!this.esbOperationsRuntime) throw runtimeError("esb_runtime_operations_unavailable", 503);
    return this.esbOperationsRuntime.executeException({ actor, body: payload });
  }

  async apAction(role, actorId, action, payload = {}) {
    const state = this.#capture();
    const hppBefore = this.hppCatalog.exportState();
    try {
      const response = super.apAction(role, actorId, action, payload);
      this.hppCatalogRevision = await this.repository.saveHppCatalogState({ ...this.ids, expectedRevision: this.hppCatalogRevision, snapshot: this.hppCatalog.exportState() });
      return response;
    } catch (error) {
      this.#restore(state);
      this.hppCatalog.restoreState(hppBefore);
      if (error.code === "hpp_persistence_version_conflict") {
        const latest = await this.repository.loadHppCatalogState(this.ids);
        if (latest) { this.hppCatalog.restoreState(latest.snapshot); this.hppCatalogRevision = latest.revision; }
      }
      throw error;
    }
  }

  async #checkoutInput(orderId, request, cashierReference = null) {
    const order = this.orders.find((item) => item.id === orderId);
    const payment = this.payments.find((item) => item.orderId === orderId);
    const items = this.orderItems.filter((item) => item.orderId === orderId);
    const checkout = {
      ...this.ids,
      orderId: order.id,
      businessDate: order.businessDate,
      channel: order.channel,
      idempotencyKey: order.idempotencyKey,
      requestFingerprint: fingerprint({
        channel: order.channel, cart: request.cart, member: Boolean(request.memberCode), rewardId: request.rewardId ?? null,
        promotionCode: request.promotionCode ?? null, ...(Object.hasOwn(request,'automaticPromotions') || Object.hasOwn(request,'manualDiscount')?{automaticPromotions:request.automaticPromotions !== false,manualDiscount:request.manualDiscount ?? null}:{}), paymentMethod: request.paymentMethod ?? "QRIS", orderType: request.orderType ?? "DINE_IN",
        paxCount: request.paxCount ?? 1,
        esbSplitBillPlan: request.esbSplitBillPlan ?? null,
        esbPaymentPlan: request.esbPaymentPlan ?? null,
      }),
      orderType: order.orderType,
      subtotalRupiah: order.subtotalRupiah,
      discountRupiah: order.discountRupiah,
      taxRupiah: order.taxRupiah,
      serviceRupiah: order.serviceRupiah,
      roundingRupiah: order.roundingRupiah,
      totalRupiah: order.totalRupiah,
      totalHppRupiah: order.totalHppRupiah,
      hppSnapshotStatus: order.hppSnapshotStatus,
      kioskSessionId: order.kioskSessionId ?? null,
      cashSessionId: order.cashSessionId ?? null,
      cashierUserId: null,
      cashierReference: order.cashierUserId ?? cashierReference,
      actorReference: cashierReference,
      catalogVersion: Number.isInteger(order.catalogVersion) ? order.catalogVersion : null,
      memberId: null,
      memberReference: order.memberId ?? null,
      policyStatus: order.policyStatus,
      checkoutFingerprint: order.checkoutFingerprint ?? null,
      rewardCommit: this.rewardReservations.get(order.id) ?? null,
      benefitSnapshot: order.benefitSnapshot ?? null,
      pricingPolicySnapshot: order.pricingPolicySnapshot ?? null,
      paxCount: request.paxCount ?? 1,
      items: items.map((item) => ({
        id: item.id,
        productReference: item.productId,
        station: item.stationSnapshot ?? "bar",
        productName: item.productNameSnapshot,
        qty: item.qty,
        unitPriceRupiah: item.unitPriceRupiah,
        lineTotalRupiah: item.lineTotalRupiah,
        recipeCostRupiah: item.recipeCostSnapshotRupiah ?? 0,
        hppSnapshotStatus: item.hppSnapshotStatus,
        costCoverage: item.costCoverage,
        reportableRecipeCostSnapshotRupiah: item.reportableRecipeCostSnapshotRupiah,
        recipeVersionSnapshot: item.recipeSnapshot?.recipeVersion ?? null,
        recipeSnapshot: item.recipeSnapshot ?? {},
        note: item.note ?? null,
        modifiers: item.selections ?? [],
      })),
      payment: {
        id: payment.id,
        methodName: payment.methodNameSnapshot,
        methodType: payment.methodType,
        status: payment.status,
        amountRupiah: payment.amountRupiah,
        receivedRupiah: payment.receivedRupiah ?? payment.amountRupiah,
        changeRupiah: payment.changeRupiah ?? 0,
        paidAt: payment.paidAt ?? order.paidAt ?? null,
        idempotencyKey: `payment:${order.channel.toLowerCase()}:${order.idempotencyKey}`,
        provider: payment.methodType === "qris_dynamic" ? "sagadev_gateway" : null,
        providerReference: payment.providerReference ?? null,
        expiresAt: payment.expiresAt ?? null,
        settlementStatus: payment.settlementStatus,
        gatewayMode: payment.gatewayMode ?? "local_durable_runtime",
        assistedCash: payment.assistedCash === true,
      },
      createdAt: order.createdAt,
    };
    if (!this.repository.requiresEsbCatalogSnapshot?.()) return checkout;
    if (!this.esbCatalogQuoteProvider) throw runtimeError("esb_catalog_quote_provider_required", 503);
    const snapshot = await this.esbCatalogQuoteProvider({
      organizationId: this.ids.organizationId,
      outletId: this.ids.outletId,
      actorUserId: this.ids.ownerProfileId,
      occurredAt: order.createdAt,
      order: structuredClone(order),
      items: structuredClone(checkout.items),
      request: structuredClone(request),
    });
    return {
      ...checkout,
      esbCatalogPricingSnapshot: snapshot,
      ...(request.esbSplitBillPlan == null ? {} : { esbSplitBillPlan: mapRuntimeSplitBillPlan(request.esbSplitBillPlan, checkout.items) }),
      ...(request.esbPaymentPlan == null ? {} : { esbPaymentPlan: structuredClone(request.esbPaymentPlan) }),
    };
  }

  #applyPersistedReference(originalOrderId, persisted, response) {
    const order = this.orders.find((item) => item.id === originalOrderId);
    if (!order) return;
    order.orderNumber = persisted.orderNumber;
    if (persisted.businessDate) order.businessDate = persisted.businessDate;
    if (response?.order) response.order.orderNumber = persisted.orderNumber;
    if (response?.order && persisted.businessDate) response.order.businessDate = persisted.businessDate;
    if (response?.receipt) response.receipt.orderNumber = persisted.orderNumber;
    const fulfillment = this.fulfillments.get(originalOrderId);
    if (fulfillment) fulfillment.orderNumber = persisted.orderNumber;
  }

  #tableDemoResponse(sessionId) {
    const state = this.kioskState(sessionId);
    return {
      order: state.activeOrder,
      payment: state.payment,
      fulfillment: state.fulfillment,
      receipt: state.activeOrder && ["PAID", "COMPLETED"].includes(state.activeOrder.status)
        ? { orderNumber: state.activeOrder.orderNumber, totalRupiah: state.activeOrder.totalRupiah, method: state.payment?.methodNameSnapshot ?? "NONE", digital: true }
        : null,
    };
  }

  #hydrate(state) {
    this.orders = state.orders.map((row) => {
      const fulfillment = state.fulfillments.find((item) => item.order_id === row.id);
      const payments=state.payments.filter(payment=>payment.order_id===row.id);
      const terminalUnpaid=payments.length>0 && payments.every(payment=>['failed','expired','cancelled'].includes(String(payment.status).toLowerCase()));
      return {
        id: row.id, orderNumber: row.order_number, organizationId: row.organization_id, outletId: row.outlet_id,
        channel: row.channel.toUpperCase(), orderType: row.order_type.toUpperCase(), memberId: row.member_reference ?? row.member_id,
        cashierUserId: row.cashier_reference ?? row.cashier_user_id,
        cashSessionId: row.cash_session_id ?? null,
        status: row.status === "refunded" ? "REFUNDED" : fulfillment?.status === "completed" ? "COMPLETED" : row.status === "paid" ? "PAID" : terminalUnpaid ? "EXPIRED" : "PAYMENT_PENDING",
        subtotalRupiah: row.subtotal_rupiah, discountRupiah: row.discount_rupiah, taxRupiah: row.tax_rupiah,
        serviceRupiah: row.service_rupiah, roundingRupiah: row.rounding_rupiah, totalRupiah: row.total_rupiah,
        totalHppRupiah: row.total_hpp_rupiah, hppSnapshotStatus: String(row.hpp_snapshot_status ?? "unverified").toUpperCase(), businessDate: iso(row.business_date)?.slice(0, 10), createdAt: iso(row.created_at), paidAt: iso(row.paid_at),
        idempotencyKey: row.idempotency_key, kioskSessionId: row.kiosk_session_id, policyStatus: row.policy_status,
        catalogVersion: row.catalog_version,
        checkoutFingerprint: state.audits.find(a => a.aggregate_id === row.id && a.event_type === 'pos.checkout.created')?.payload_redacted?.checkoutFingerprint ?? null,
        benefitSnapshot: state.audits.find(a => a.aggregate_id === row.id && a.event_type === 'pos.checkout.created')?.payload_redacted?.benefitSnapshot ?? null,
        pricingPolicySnapshot: state.audits.find(a => a.aggregate_id === row.id && a.event_type === 'pos.checkout.created')?.payload_redacted?.pricingPolicySnapshot ?? null,
        promotionCode: state.audits.find(a => a.aggregate_id === row.id && a.event_type === 'pos.checkout.created')?.payload_redacted?.benefitSnapshot?.promotion?.code ?? null,
      };
    });
    this.orderItems = state.items.map((row) => {
      const persistedCost = hydrateSaleCostQuality(row.recipe_snapshot_json);
      return {
        id: row.id, orderId: row.order_id, productId: row.product_reference_snapshot ?? row.product_id, productNameSnapshot: row.product_name_snapshot,
        qty: Number(row.qty), unitPriceRupiah: row.unit_price_rupiah, lineTotalRupiah: row.line_total_rupiah,
        recipeCostSnapshotRupiah: row.recipe_cost_snapshot_rupiah, hppSnapshotStatus: String(row.hpp_snapshot_status ?? "unverified").toUpperCase(),
        costCoverage: persistedCost.costCoverage,
        reportableRecipeCostSnapshotRupiah: persistedCost.reportableRecipeCostSnapshotRupiah,
        recipeSnapshot: persistedCost.recipeSnapshot, note: row.note, selections: row.modifier_snapshot ?? [], stationSnapshot: row.station_snapshot ?? "bar",
      };
    });
    for (const order of this.orders) order.costCoverage = hydratedOrderCostCoverage(this.orderItems.filter((item) => item.orderId === order.id));
    this.payments = state.payments.map((row) => ({
      id: row.id, orderId: row.order_id, methodNameSnapshot: row.method_name_snapshot, methodType: row.method_type,
      status: row.status.toUpperCase(), amountRupiah: row.amount_rupiah, receivedRupiah: row.received_rupiah,
      changeRupiah: row.change_rupiah, paidAt: iso(row.paid_at), settlementStatus: row.settlement_status,
      providerFeeRupiah: row.payment_fee_rupiah ?? row.intent_provider_fee_rupiah ?? null,
      netSettlementRupiah: row.net_settlement_rupiah ?? null,
      provider: row.provider, providerReference: row.provider_reference, idempotencyKey: row.idempotency_key,
      referenceNumber: row.reference_number ?? null,
      gatewayMode: row.provider === "sagadev_gateway" ? "production" : null,
      assistedCash: row.method_type === "cash" && String(row.method_name_snapshot).toLowerCase().includes("dibantu staf"),
      staticQrisManual: row.method_type === "qris_manual" && row.method_name_snapshot === "QRIS Statis Merchant",
      qrImageUrl: row.method_type === "qris_manual" && row.method_name_snapshot === "QRIS Statis Merchant" ? "/api/cashier/manual-qris/image" : null,
      simulator: row.method_type === "qris_manual" && row.method_name_snapshot === "QRIS Statis Merchant" ? false : undefined,
    }));
    const settlementReviews = new Map((state.audits ?? [])
      .filter((row) => row.event_type === "payment.settlement.reviewed" && row.aggregate_type === "payment")
      .map((row) => [row.aggregate_id, {
        ...structuredClone(row.payload_redacted ?? {}),
        reviewedAt: iso(row.occurred_at),
        reviewedBy: row.actor_reference,
      }]));
    for (const payment of this.payments) {
      const review = settlementReviews.get(payment.id);
      if (review) payment.settlementReview = review;
    }
    this.fulfillments = new Map(state.fulfillments.map((row) => {
      const payload = row.payload_snapshot ?? {};
      return [row.order_id, {
        id: row.id, orderId: row.order_id, orderNumber: payload.orderNumber,
        stationProgress: payload.stationProgress,
        ...durableFulfillmentProjection(row), channel: this.orders.find((order) => order.id === row.order_id)?.channel ?? "KIOSK",
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), prepStartedAt: iso(row.prep_started_at),
        readyAt: iso(row.ready_at), completedAt: iso(row.completed_at),
        orderType: this.orders.find((order) => order.id === row.order_id)?.orderType,
        paidAt: this.orders.find((order) => order.id === row.order_id)?.paidAt,
        items: this.orderItems.filter((item) => item.orderId === row.order_id).map((item) => ({
          productId: item.productId, name: item.productNameSnapshot, qty: item.qty,
          selections: item.selections, note: item.note ?? "", station: item.stationSnapshot,
        })), printJob: null,
      }];
    }));
    this.kioskSessions = new Map(state.kioskSessions.map((row) => [row.id, {
      id: row.id, status: row.status.toUpperCase(), activeOrderId: row.active_order_id, createdAt: iso(row.created_at),
    }]));
    const latestShift = state.cashSessions.at(-1);
    this.cashShift = latestShift ? {
      id: latestShift.id, organizationId: latestShift.organization_id, outletId: latestShift.outlet_id,
      businessDate: iso(latestShift.business_date)?.slice(0,10), shiftName: latestShift.shift_name, status: latestShift.status,
      openingCashRupiah: latestShift.opening_cash_rupiah, expectedCashRupiah: latestShift.expected_cash_rupiah,
      actualCashRupiah: latestShift.actual_cash_rupiah, cashToLeaveRupiah: latestShift.cash_to_leave_rupiah,
      depositCashRupiah: latestShift.deposit_cash_rupiah, varianceRupiah: latestShift.variance_rupiah,
      openedAt: iso(latestShift.opened_at), closedAt: iso(latestShift.closed_at), openedByUserId: latestShift.opened_by_reference ?? "DURABLE_RESTORED",
    } : null;
    this.checkoutByKey = new Map(this.orders.map((order) => [order.channel === "KIOSK" ? `${order.kioskSessionId}:${order.idempotencyKey}` : `cashier:${order.cashierUserId ?? "CASHIER-01"}:${order.idempotencyKey}`, order.id]));
    const opening = state.audits.find(r => r.aggregate_id === this.cashShift?.id && r.event_type === 'cash.shift.open');
    if (opening && this.cashShift) Object.assign(this.cashShift, Object.fromEntries(['expectedOpeningCashRupiah','openingVarianceRupiah','previousCashSessionId','handoverStatus','openingNote'].filter(k=>opening.payload_redacted?.[k]!==undefined).map(k=>[k,opening.payload_redacted[k]])));
    this.sequence = Math.max(0, ...this.orders.map((order) => Number(order.orderNumber.split("-").at(-1)) || 0));
    this.events = state.audits.map((row, index) => ({ id: `durable-audit-${index + 1}`, type: row.event_type, payload: row.payload_redacted, occurredAt: iso(row.occurred_at) }));
    this.refunds = state.audits
      .filter((row) => ["order.refund.requested", "order.refunded"].includes(row.event_type))
      .map((row, index) => ({
        ...structuredClone(row.payload_redacted),
        id: row.payload_redacted?.id ?? `durable-refund-event-${index + 1}`,
        orderId: row.aggregate_id,
        actorId:row.actor_reference,
        status: row.event_type === "order.refund.requested" ? "PENDING_MANUAL_FINANCE_RECONCILIATION" : "REFUNDED_LOCAL",
        createdAt: iso(row.occurred_at),
      }));
    const expenseFacts = new Map(state.audits.filter(r => r.event_type === 'cash.expense.recorded').map(r => [r.aggregate_id,r.payload_redacted]));
    this.expenses = (state.expenses ?? []).map(r => {const metadata=expenseFacts.get(r.id) ?? {};const source=metadata.source ?? r.source ?? 'cash_drawer';return {...metadata,id:r.id,cashSessionId:r.cash_session_id,amountRupiah:r.amount_rupiah,category:r.category,reason:r.reason,source,status:r.status ?? 'recorded',affectsCashDrawer:source === 'cash_drawer',createdAt:iso(r.created_at)};});
    for (const expense of this.expenses) { const fact=state.audits.find(a => a.aggregate_id === expense.id && a.event_type === 'cash.expense.voided'); if(fact) {expense.status='voided';expense.voidReason=fact.payload_redacted.reason;expense.voidedAt=iso(fact.occurred_at);} }
    this.cashMovements = this.payments.filter(p => p.methodType === 'cash' && ['PAID','REFUNDED'].includes(p.status)).map(p => ({ id:p.id,type:'SALE',orderId:p.orderId,amountRupiah:p.amountRupiah,occurredAt:p.paidAt ?? this.orders.find(o => o.id===p.orderId)?.createdAt }));
    for (const row of state.audits.filter(r => r.event_type === 'order.refunded' && ['cash',undefined].includes(r.payload_redacted?.mode))) {
      if (this.payments.find(p => p.orderId===row.aggregate_id)?.methodType !== 'cash') continue;
      this.cashMovements.push({ id:row.payload_redacted?.id ?? `refund:${row.aggregate_id}`,type:'REFUND',orderId:row.aggregate_id,cashSessionId:row.payload_redacted?.cashSessionId ?? this.orders.find(o=>o.id===row.aggregate_id)?.cashSessionId,amountRupiah:-Number(row.payload_redacted?.amountRupiah ?? this.orders.find(o=>o.id===row.aggregate_id)?.totalRupiah),occurredAt:iso(row.occurred_at),actorId:row.actor_reference });
    }
    this.rewardReservations = new Map(state.audits
      .filter((row) => row.event_type === "pos.checkout.created" && row.payload_redacted?.rewardCommit?.rewardId)
      .map((row) => [row.aggregate_id, {
        ...structuredClone(row.payload_redacted.rewardCommit),
        orderId: row.aggregate_id,
        committedAt: iso(row.payload_redacted.rewardCommit.committedAt ?? row.occurred_at),
      }]));
    this.remakes = restoreRemakeQueueFacts(state.audits);
  }

  #reconcileRemakeStatuses() {
    this.remakes = this.remakes.map((remake) => this.#projectRemakeStatus(remake));
  }

  #projectRemakeStatus(remake) {
    const consumption = this.hppCatalog.exportState().saleConsumptions.find((item) => item.remakeId === remake.id);
    if (!consumption) return structuredClone(remake);
    return {
      ...structuredClone(remake),
      status: "IN_PROGRESS",
      productionStartId: consumption.productionStartId,
      productionStartIdempotencyKey: consumption.productionStartIdempotencyKey,
      startedAt: consumption.occurredAt,
      startedBy: consumption.actorId,
      startReason: consumption.productionStartReason,
      consumptionId: consumption.id,
    };
  }

  #upsertRemake(remake) {
    const index = this.remakes.findIndex((item) => item.id === remake.id);
    if (index === -1) this.remakes.push(remake);
    else this.remakes[index] = remake;
  }

  #capture() {
    return structuredClone({
      kioskSessions: [...this.kioskSessions], orders: this.orders, orderItems: this.orderItems, payments: this.payments,
      fulfillments: [...this.fulfillments], checkoutByKey: [...this.checkoutByKey], events: this.events, sequence: this.sequence,
      cashShift: this.cashShift, cashMovements: this.cashMovements, expenses: this.expenses, refunds: this.refunds, remakes: this.remakes,
      rewardReservations: [...this.rewardReservations],
      discountApprovals: [...this.discountApprovals],
      gatewayState: this.gateway.snapshot(),
      hppCatalogState: this.hppCatalog.exportState(), hppCatalogRevision: this.hppCatalogRevision,
    });
  }

  #restore(state) {
    this.kioskSessions = new Map(state.kioskSessions); this.orders = state.orders; this.orderItems = state.orderItems;
    this.payments = state.payments; this.fulfillments = new Map(state.fulfillments); this.checkoutByKey = new Map(state.checkoutByKey);
    this.events = state.events; this.sequence = state.sequence; this.cashShift = state.cashShift; this.cashMovements = state.cashMovements;
    this.refunds = state.refunds; this.remakes = state.remakes; this.rewardReservations = new Map(state.rewardReservations);
    this.expenses = state.expenses;
    this.discountApprovals = new Map(state.discountApprovals);
    this.gateway.replace(state.gatewayState);
    this.hppCatalog.restoreState(state.hppCatalogState); this.hppCatalogRevision = state.hppCatalogRevision;
  }

  #productionCanaryRequest(input) {
    if (!this.gatewayClient || ["QRIS_STATIC_DEMO", "QRIS_STATIC_MANUAL", "CASH_ASSISTED"].includes(String(input.paymentMethod ?? "").toUpperCase())) return input;
    return { ...input, promotionCode: "TRIAL99" };
  }

  async #attachLivePayment(response, request) {
    if (!this.gatewayClient || !response?.payment || response.payment.methodType !== "qris_dynamic") return;
    const order = this.orders.find((item) => item.id === response.order.id);
    const payment = this.payments.find((item) => item.orderId === response.order.id);
    if (!order || !payment) throw runtimeError("payment_scope_denied", 500);
    if (payment.providerReference) return;
    const readiness = await this.gatewayClient.readiness();
    if (!readiness.ready || !readiness.transactionsEnabled || readiness.environment !== "production") {
      throw runtimeError("sagadev_gateway_not_ready", 503);
    }
    const cart = Array.isArray(request.cart) ? request.cart : [];
    const live = await this.gatewayClient.createPayment({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountRupiah: order.totalRupiah,
      idempotencyKey: `payment:${order.channel.toLowerCase()}:${order.idempotencyKey}`,
      description: `Saga POS ${order.orderNumber}`,
      expiresAt: payment.expiresAt,
      activationContext: {
        promotionCode: "TRIAL99",
        ...this.privateCanaryContext,
        cartLines: cart.length,
        cartQuantity: cart.reduce((sum, item) => sum + Number(item.qty ?? 0), 0),
      },
      usage: this.canaryUsageProvider(),
    });
    payment.gatewayPaymentId = live.id;
    payment.methodNameSnapshot = "SagaDev Gateway QRIS";
    payment.provider = live.provider;
    payment.providerReference = live.providerReference;
    payment.status = live.status === "CREATED" ? "PENDING" : live.status;
    payment.qrPayload = live.qrPayload;
    payment.qrImageDataUrl = await createQrImage(live.qrPayload);
    payment.checkoutUrl = live.checkoutUrl;
    payment.expiresAt = live.expiresAt;
    payment.gatewayMode = "production";
    response.payment = this.#publicPayment(payment);
  }

  async #refreshGatewayPayment(payment, state) {
    if (!this.gatewayClient) throw runtimeError("sagadev_gateway_not_configured", 503);
    const recovered = await this.gatewayClient.recoverUncertain(payment.gatewayPaymentId ?? payment.id);
    payment.qrPayload = recovered.payment.qrPayload ?? payment.qrPayload;
    payment.checkoutUrl = recovered.payment.checkoutUrl ?? payment.checkoutUrl;
    payment.expiresAt = recovered.payment.expiresAt ?? payment.expiresAt;
    if (payment.qrPayload && !payment.qrImageDataUrl) payment.qrImageDataUrl = await createQrImage(payment.qrPayload);
    if (recovered.payment.status === "PAID") {
      const paidAt = this.clock().toISOString();
      const providerEventKey = `poll:${payment.providerReference}:paid`;
      const response = super.confirmVerifiedQrisPaid({ paymentId: payment.id, paidAt, providerEventKey });
      const persisted = await this.repository.markGatewayPaid({
        ...this.ids,
        paymentId: payment.id,
        providerEventKey,
        eventFingerprint: fingerprint({ providerReference: payment.providerReference, status: "PAID", amountRupiah: payment.amountRupiah }),
        paidAt,
        hppCatalogMutation: this.#hppMutationSince(state),
      });
      if (persisted.hppCatalogRevision != null) this.hppCatalogRevision = persisted.hppCatalogRevision;
      return { ...response, gatewayResolution: { resolved: true, attempts: recovered.attempts } };
    }
    if (["FAILED", "EXPIRED", "CANCELLED"].includes(recovered.payment.status)) {
      await this.repository.markGatewayTerminal({...this.ids,paymentId:payment.id,status:recovered.payment.status,providerEventKey:`poll:${payment.providerReference}:${recovered.payment.status.toLowerCase()}`,eventFingerprint:fingerprint({providerReference:payment.providerReference,status:recovered.payment.status,amountRupiah:payment.amountRupiah})});
      payment.status=recovered.payment.status;
      const order=this.orders.find(item=>item.id===payment.orderId);
      if(order && !['PAID','COMPLETED','REFUNDED'].includes(order.status))order.status=recovered.payment.status;
    }
    return {
      order: structuredClone(this.orders.find((item) => item.id === payment.orderId)),
      payment: this.#publicPayment(payment),
      fulfillment: this.fulfillments.get(payment.orderId) ?? null,
      idempotentReplay: false,
      gatewayResolution: { resolved: false, attempts: recovered.attempts },
    };
  }

  #hppMutationSince(state) {
    const snapshot = this.hppCatalog.exportState();
    if (snapshot.version === state.hppCatalogState.version) return null;
    return { expectedRevision: state.hppCatalogRevision, snapshot };
  }

  #restoreGatewayClientState() {
    if (!this.gatewayClient) return;
    for (const payment of this.payments.filter((item) => item.methodType === "qris_dynamic" && item.providerReference)) {
      const order = this.orders.find((item) => item.id === payment.orderId);
      if (!order) continue;
      this.gatewayClient.restorePayment({
        id: payment.id,
        providerReference: payment.providerReference,
        orderId: order.id,
        merchantOrderId: order.orderNumber,
        amountRupiah: payment.amountRupiah,
        status: payment.status,
        idempotencyKey: payment.idempotencyKey,
        expiresAt: payment.expiresAt,
        gatewayMode: "production",
      });
    }
  }

  #canaryUsage() {
    const relevant = this.payments.filter((payment) => payment.methodType === "qris_dynamic" && payment.provider === "sagadev_gateway");
    return {
      createdPayments: relevant.length,
      successfulPayments: relevant.filter((payment) => payment.status === "PAID").length,
      authorizedRupiah: relevant.reduce((sum, payment) => sum + payment.amountRupiah, 0),
    };
  }

  #publicPayment(payment) {
    return {
      id: payment.id, orderId: payment.orderId, methodNameSnapshot: payment.methodNameSnapshot,
      methodType: payment.methodType, amountRupiah: payment.amountRupiah, status: payment.status,
      settlementStatus: payment.settlementStatus, expiresAt: payment.expiresAt ?? null,
      receivedRupiah: payment.receivedRupiah ?? payment.amountRupiah, changeRupiah: payment.changeRupiah ?? 0,
      qrPayload: payment.qrPayload ?? null, qrImageDataUrl: payment.qrImageDataUrl ?? null,
      checkoutUrl: payment.checkoutUrl ?? null,
      gatewayMode: payment.gatewayMode ?? null, simulator: false,
    };
  }
}

export const SAGA_POS_DURABLE_CONTEXT = Object.freeze({
  ...SAGA_POS_ALPHA_CONTEXT,
  scope: "LOCAL_DURABLE_POSTGRES_RUNTIME",
  production: false,
});

function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function normalizeOfflineInventorySyncInput(deviceContext, input, ids, currentHppVersion) {
  const inputKeys = ["baseHppVersion", "capturedAt", "eventId", "items", "localSequence", "orderId", "orderNumber"];
  if (!deviceContext || Array.isArray(deviceContext) || typeof deviceContext !== "object"
    || deviceContext.organizationId !== ids.organizationId || deviceContext.outletId !== ids.outletId
    || typeof deviceContext.deviceId !== "string" || !deviceContext.deviceId.trim() || deviceContext.deviceId.length > 80) {
    throw runtimeError("offline_device_scope_denied", 403);
  }
  if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).sort().join("\u0000") !== inputKeys.join("\u0000")) {
    throw runtimeError("offline_sync_input_invalid", 422);
  }
  const eventId = String(input.eventId ?? "").trim();
  const orderId = String(input.orderId ?? "").trim();
  const orderNumber = String(input.orderNumber ?? "").trim();
  const captured = new Date(input.capturedAt);
  if (!eventId || eventId.length > 80 || !orderId || orderId.length > 80 || !orderNumber || orderNumber.length > 80
    || !Number.isSafeInteger(input.localSequence) || input.localSequence < 1 || input.localSequence > 1_000_000_000
    || Number.isNaN(captured.getTime()) || captured.toISOString() !== input.capturedAt
    || !Number.isSafeInteger(input.baseHppVersion) || input.baseHppVersion < 1 || input.baseHppVersion > currentHppVersion
    || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw runtimeError("offline_sync_input_invalid", 422);
  const normalized = {
    eventId,
    localSequence: input.localSequence,
    orderId,
    orderNumber,
    capturedAt: input.capturedAt,
    baseHppVersion: input.baseHppVersion,
    items: structuredClone(input.items),
  };
  return { ...normalized, deviceId: deviceContext.deviceId.trim(), payload: normalized };
}

function immutableRemakeQueueFact(value) {
  return {
    id: value.id,
    orderId: value.orderId,
    reason: value.reason,
    actorId: value.actorId,
    status: "QUEUED_LOCAL",
    createsPayment: false,
    createsLoyalty: false,
    queueIdempotencyKey: value.queueIdempotencyKey,
    queueFingerprint: value.queueFingerprint,
    createdAt: value.createdAt,
  };
}

function mapRuntimeSplitBillPlan(plan, items) {
  if (!plan || !Number.isSafeInteger(plan.paxCount) || plan.paxCount < 1 || !Array.isArray(plan.bills)) throw runtimeError("split_bill_plan_invalid", 422);
  return {
    paxCount: plan.paxCount,
    bills: plan.bills.map((bill) => {
      if (!Array.isArray(bill?.lines)) throw runtimeError("split_bill_plan_invalid", 422);
      return {
        key: bill.key,
        allocatedPax: bill.allocatedPax,
        lines: bill.lines.map((line) => {
          if (!Number.isSafeInteger(line?.itemIndex) || line.itemIndex < 0 || line.itemIndex >= items.length) throw runtimeError("split_bill_item_index_invalid", 422);
          return { lineId: items[line.itemIndex].id, quantity: line.quantity, ...(line.moneyWeight == null ? {} : { moneyWeight: line.moneyWeight }) };
        }),
      };
    }),
  };
}
function normalizeLegacyReceiptPayload(payload, outletId) {
  const locations = sagaPosPurchaseReceiptLocations(outletId);
  const lines = Array.isArray(payload?.lines) ? payload.lines.map((line) => {
    const acceptedPurchaseQuantity = line?.acceptedPurchaseQuantity ?? line?.purchaseQuantity ?? 0;
    const rejectedPurchaseQuantity = line?.rejectedPurchaseQuantity ?? 0;
    const quarantinedPurchaseQuantity = line?.quarantinedPurchaseQuantity ?? 0;
    const pendingInspectionPurchaseQuantity = line?.pendingInspectionPurchaseQuantity ?? 0;
    return {
      ...line,
      deliveredPurchaseQuantity: line?.deliveredPurchaseQuantity
        ?? acceptedPurchaseQuantity + rejectedPurchaseQuantity + quarantinedPurchaseQuantity + pendingInspectionPurchaseQuantity,
      acceptedPurchaseQuantity,
      rejectedPurchaseQuantity,
      quarantinedPurchaseQuantity,
      pendingInspectionPurchaseQuantity,
    };
  }) : payload?.lines;
  const has = (field) => Array.isArray(lines) && lines.some((line) => Number(line?.[field] ?? 0) > 0);
  return {
    ...payload,
    destinationLocationId: locations.usable,
    quarantineLocationId: has("quarantinedPurchaseQuantity") ? locations.quarantine : undefined,
    rejectionLocationId: has("rejectedPurchaseQuantity") ? locations.rejected : undefined,
    pendingInspectionLocationId: has("pendingInspectionPurchaseQuantity") ? locations.pendingInspection : undefined,
    lines,
  };
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function hydrateSaleCostQuality(value) {
  const recipeSnapshot = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  const quality = recipeSnapshot._saleCostQuality;
  delete recipeSnapshot._saleCostQuality;
  const costCoverage = ["COMPLETE", "PARTIAL", "MISSING"].includes(quality?.costCoverage) ? quality.costCoverage : "MISSING";
  const reportableRecipeCostSnapshotRupiah = costCoverage === "COMPLETE"
    && Number.isSafeInteger(quality?.reportableRecipeCostSnapshotRupiah)
    && quality.reportableRecipeCostSnapshotRupiah >= 0
    ? quality.reportableRecipeCostSnapshotRupiah
    : null;
  return {
    recipeSnapshot,
    costCoverage: costCoverage === "COMPLETE" && reportableRecipeCostSnapshotRupiah === null ? "MISSING" : costCoverage,
    reportableRecipeCostSnapshotRupiah,
  };
}
function hydratedOrderCostCoverage(items) {
  if (items.length > 0 && items.every((item) => item.costCoverage === "COMPLETE")) return "COMPLETE";
  return items.some((item) => item.costCoverage === "COMPLETE" || item.costCoverage === "PARTIAL") ? "PARTIAL" : "MISSING";
}
function runtimeError(code, statusCode) { const error = new Error(code); error.code = code; error.statusCode = statusCode; return error; }
function requireReliabilityManager(actor) {
  if (!actor || !["owner", "manager"].includes(actor.role) || !actor.employeeId) throw runtimeError("reliability_manager_required", 403);
}
function rejectClientIdentityFields(input) {
  if (["organizationId", "outletId", "actorUserId", "actorReference", "executorReference", "requestedByReference", "approvedByReference"].some((key) => Object.hasOwn(input, key))) {
    throw runtimeError("client_identity_fields_forbidden", 422);
  }
}
function requiredRuntimeText(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw runtimeError(code, 422);
  return normalized;
}
function reliabilityRuntimeError(error) {
  const code = error?.code ?? error?.message;
  const statusCode = RELIABILITY_HTTP_ERRORS.get(code);
  if (statusCode) return runtimeError(code, statusCode);
  // PostgreSQL input representation/range errors may come from caller IDs or
  // quantities. Never return the SQL message, query, constraint or parameters.
  if (["22P02", "22003"].includes(code)) return runtimeError("reliability_input_invalid", 422);
  return runtimeError("esb_reliability_operation_failed", 500);
}
function requireReliabilityBody(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw runtimeError("reliability_input_invalid", 422);
}
const RELIABILITY_HTTP_ERRORS = new Map([
  ...["reliability_manager_required", "shift_close_owner_authorization_required", "cashier_role_denied", "shift_owned_by_other_staff"].map((code) => [code, 403]),
  ...["shift_not_found", "inventory_balance_not_found", "approval_request_not_found"].map((code) => [code, 404]),
  ...[
    "maker_checker_distinct_principals_required", "cash_session_open_required", "shift_state_conflict",
    "reliability_operation_collision", "reliability_approval_request_collision", "reliability_authorization_consume_failed",
    "inventory_source_already_recorded", "inventory_reversal_already_recorded", "inventory_quantity_insufficient",
    "inventory_concurrent_update_detected", "shift_cash_movement_outside_close_window", "cash_movement_cross_ledger_conflict",
  ].map((code) => [code, 409]),
  ...[
    "cash_count_required", "cash_to_leave_invalid", "shift_close_operation_key_required", "shift_operation_key_required",
    "shift_close_reason_required", "shift_declared_cash_invalid", "shift_cash_to_leave_invalid",
    "shift_cash_to_leave_exceeds_declared", "shift_authorization_required", "shift_variance_authorization_required",
    "approval_request_id_required", "client_identity_fields_forbidden", "ingredient_id_required",
    "inventory_operation_key_required", "inventory_source_reference_required", "inventory_movement_kind_invalid",
    "inventory_movement_quantity_invalid", "inventory_authorization_required", "inventory_reversal_source_required",
    "inventory_reversal_source_invalid", "inventory_occurred_at_out_of_bounds", "occurred_at_invalid",
    "reliability_operation_key_required", "reliability_input_invalid",
  ].map((code) => [code, 422]),
]);
async function createQrImage(payload) {
  const value = String(payload ?? "");
  if (!value || value.length > 4096) throw runtimeError("gateway_qr_payload_invalid", 502);
  return QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 320, color: { dark: "#241a14", light: "#ffffff" } });
}
