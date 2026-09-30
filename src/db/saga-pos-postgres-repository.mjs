import { createHash, randomUUID } from "node:crypto";
import { promotionEffectiveState } from "../services/esb-catalog/promotions.mjs";
import { planCashierRefund } from "../services/cashier-refund.mjs";
import { transitionTicket } from "../pos-alpha/fulfillment-state.mjs";
import { durableFulfillmentProjection, durableFulfillmentSnapshot, durableFulfillmentStorageStatus } from "../pos-alpha/durable-fulfillment-state.mjs";
import { deterministicEsbUuid, esbPaymentPlanFingerprint, esbSplitBillPlanFingerprint, persistEsbAssistedCashPaid, persistEsbCheckoutDualWrite, persistEsbGatewayPaidDualWrite } from "../services/esb-runtime/checkout-adapter.mjs";
import { parseEsbRuntimeGuard } from "../services/esb-runtime/guard.mjs";
import { businessDateForInstant } from "../services/esb-reliability/business-date.mjs";
import { createOfflineOperation } from "../services/esb-reliability/offline.mjs";
import {
  remakeQueueAuditPayload,
  remakeQueueError,
  remakeQueueFactFromAudit,
  validateRemakeQueueFact,
} from "../services/remake-queue.mjs";
import { EsbReliabilityPostgresRepository, consumeAuthorization } from "./esb-reliability-postgres-repository.mjs";
import { InventoryValuationPostgresAdapter } from "../services/inventory-valuation-postgres.mjs";
import { deriveHppInventoryMovementFacts } from "../services/hpp-inventory-movement-ledger.mjs";
import { persistInventoryReportingProductionDocument, validateInventoryReportingProductionDocument } from "../services/inventory-reporting-historical-authority-postgres.mjs";

const PRODUCTION_EXECUTION_STATE_KEY = "_productionExecutionState";
const SALE_COST_QUALITY_SNAPSHOT_KEY = "_saleCostQuality";

export const SAGA_POS_DURABLE_PILOT_IDS = Object.freeze({
  authUserId: "10000000-0000-4000-8000-000000000001",
  ownerProfileId: "10000000-0000-4000-8000-000000000002",
  organizationId: "10000000-0000-4000-8000-000000000003",
  outletId: "10000000-0000-4000-8000-000000000004",
});

export function sagaPosPurchaseReceiptLocations(outletId) {
  if (typeof outletId !== "string" || !outletId.trim()) throw repositoryError("purchase_receipt_location_not_authorized", 403);
  return Object.freeze({
    usable: `${outletId}:USABLE`,
    quarantine: `${outletId}:QUARANTINE`,
    rejected: `${outletId}:REJECTED`,
    pendingInspection: `${outletId}:INSPECTION`,
  });
}

export class SagaPosPostgresRepository {
  constructor({ db, clock = () => new Date(), faultInjector = () => {}, esbRuntime } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("postgres_database_required");
    this.db = db;
    this.clock = clock;
    this.faultInjector = faultInjector;
    this.esbRuntime = parseEsbRuntimeGuard(esbRuntime);
    this.inventoryValuation = new InventoryValuationPostgresAdapter({ db, faultInjector });
  }

  esbRuntimeStatus() { return structuredClone(this.esbRuntime); }
  requiresEsbCatalogSnapshot() { return this.esbRuntime.writeVersion === "DUAL_WRITE_V1"; }

  async loadInventoryMovementLedger({ organizationId, outletId, ingredientId } = {}) {
    if (!organizationId || !outletId) throw repositoryError("inventory_movement_scope_required", 422);
    const values = [organizationId, outletId];
    const ingredientFilter = ingredientId == null ? "" : " and ingredient_id=$3";
    if (ingredientId != null) values.push(ingredientId);
    const result = await this.db.query(
      `select ledger_sequence,movement_id,movement_type,source_type,source_id,source_line_id,
              ingredient_id,location_id,quantity_delta_base::text,inventory_value_delta_rupiah,
              quantity_before_base::text,quantity_after_base::text,inventory_value_before_rupiah,
              inventory_value_after_rupiah,effective_at,created_at,actor_reference,reason,audit_reference,
              reference_type,reference_id,reference_code,reversal_of_movement_id,source_event_id,
              source_device_id,source_local_sequence,hpp_version,requires_rebuild,movement_fingerprint
         from sagaops.hpp_inventory_movement_facts
        where organization_id=$1 and outlet_id=$2${ingredientFilter}
        order by ledger_sequence`,
      values,
    );
    return result.rows.map(projectInventoryMovementFact);
  }

  async rebuildInventoryMovementProjection({ organizationId, outletId } = {}) {
    if (!organizationId || !outletId) throw repositoryError("inventory_movement_scope_required", 422);
    const usableLocationId = sagaPosPurchaseReceiptLocations(outletId).usable;
    const projection = await this.db.query(
      `select ingredient_id,location_id,quantity_base::text,inventory_value_rupiah,movement_count
         from sagaops.hpp_inventory_stock_projection
        where organization_id=$1 and outlet_id=$2
        order by ingredient_id,location_id`,
      [organizationId, outletId],
    );
    const state = await this.loadHppCatalogState({ organizationId, outletId });
    const expected = new Map((state?.snapshot?.inventoryBalances ?? []).map((item) => [item.ingredientId, item]));
    const usable = projection.rows.filter((row) => row.location_id === usableLocationId);
    const parity = usable.length === expected.size && usable.every((row) => {
      const item = expected.get(row.ingredient_id);
      return item && formatLedgerQuantity(row.quantity_base) === formatLedgerQuantity(item.quantityBase)
        && Number(row.inventory_value_rupiah) === item.inventoryValueRupiah;
    });
    return {
      authoritativeQuantitySource: "HPP_CATALOG_STATE",
      projectionSource: "HPP_INVENTORY_MOVEMENT_FACTS",
      repairable: true,
      parity,
      balances: projection.rows.map((row) => ({
        ingredientId: row.ingredient_id,
        locationId: row.location_id,
        quantityBase: formatLedgerQuantity(row.quantity_base),
        inventoryValueRupiah: Number(row.inventory_value_rupiah),
      })),
    };
  }

  async loadCatalogState({ organizationId, outletId }) {
    const result = await this.db.query("select revision, snapshot from sagaops.pos_catalog_state where organization_id=$1 and outlet_id=$2", [organizationId, outletId]);
    return result.rows[0] ?? null;
  }

  async loadHppCatalogState({ organizationId, outletId }) {
    const result = await this.db.query("select revision, snapshot from sagaops.pos_hpp_catalog_state where organization_id=$1 and outlet_id=$2", [organizationId, outletId]);
    return result.rows[0] ?? null;
  }

  async verifyPurchaseReceiptValuationLinks({ organizationId, outletId }) {
    const valuationScopeId = sagaPosPurchaseReceiptLocations(outletId).usable;
    const valuationPersistence = (await this.db.query(
      "select to_regclass('sagaops.inventory_valuation_aggregates') valuation_aggregate_table",
    )).rows[0];
    if (!valuationPersistence?.valuation_aggregate_table) return { verifiedReceiptCount: 0, persistenceAvailable: false };
    await this.inventoryValuation.load({ organizationId, outletId, valuationScopeId });
    const receiptRows = (await this.db.query(
      `select payload from public.sagaops_integration_outbox
        where organization_id=$1 and outlet_id=$2 and event_type='PURCHASE_RECEIPT_POSTED_V1'
        order by created_at,event_id`,
      [organizationId, outletId],
    )).rows;
    for (const row of receiptRows) {
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      if (payload?.acceptedBaseQuantity === 0 && payload?.postedInventoryValueRupiah === 0) continue;
      if (typeof payload?.valuationFactId !== "string" || !/^[0-9a-f]{64}$/i.test(payload?.valuationFactHash ?? "")) {
        throw repositoryError("purchase_receipt_valuation_link_tampered", 500);
      }
      const factRow = (await this.db.query(
        `select fact_hash,fact_document from sagaops.inventory_valuation_facts
          where organization_id=$1 and outlet_id=$2 and valuation_scope_id=$3 and fact_id=$4`,
        [organizationId, outletId, valuationScopeId, payload.valuationFactId],
      )).rows[0];
      const fact = factRow && (typeof factRow.fact_document === "string" ? JSON.parse(factRow.fact_document) : factRow.fact_document);
      const linkedQuantity = fact?.request?.lines?.reduce((sum, line) => sum + Number(line.quantityBase), 0);
      const linkedValue = fact?.request?.lines?.reduce((sum, line) => sum + line.provisionalItemCostRupiah, 0);
      if (!factRow || factRow.fact_hash !== payload.valuationFactHash || fact?.factHash !== payload.valuationFactHash
        || fact?.type !== "PROVISIONAL_RECEIPT" || fact?.request?.receiptId !== payload.aggregateId
        || Math.round(linkedQuantity * 1000) / 1000 !== payload.acceptedBaseQuantity || linkedValue !== payload.postedInventoryValueRupiah) {
        throw repositoryError("purchase_receipt_valuation_link_tampered", 500);
      }
    }
    return { verifiedReceiptCount: receiptRows.length, persistenceAvailable: true };
  }

  async saveHppCatalogState({ organizationId, outletId, expectedRevision, snapshot }) {
    return this.db.transaction(async (tx) => {
      return this.#persistHppCatalogState(tx, { organizationId, outletId, expectedRevision, snapshot });
    });
  }

  async saveProductionExecutionState({ organizationId, outletId, expectedRevision, state }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !state || typeof state !== "object" || Array.isArray(state)
      || state.tenantId !== organizationId || state.outletId !== outletId || typeof state.stateHash !== "string") {
      throw repositoryError("production_execution_state_invalid", 422);
    }
    return this.db.transaction(async (tx) => {
      const locked = (await tx.query(
        "select revision,snapshot from sagaops.pos_hpp_catalog_state where organization_id=$1 and outlet_id=$2 for update",
        [organizationId, outletId],
      )).rows[0];
      if (!locked || locked.revision !== expectedRevision) throw repositoryError("hpp_persistence_version_conflict", 409);
      const snapshot = typeof locked.snapshot === "string" ? JSON.parse(locked.snapshot) : locked.snapshot;
      const encodedState = JSON.stringify(state);
      if (snapshot?.[PRODUCTION_EXECUTION_STATE_KEY] === encodedState) return locked.revision;
      const nextSnapshot = { ...snapshot, [PRODUCTION_EXECUTION_STATE_KEY]: encodedState };
      const updated = (await tx.query(
        "update sagaops.pos_hpp_catalog_state set revision=revision+1,snapshot=$4::jsonb,updated_at=now() where organization_id=$1 and outlet_id=$2 and revision=$3 returning revision",
        [organizationId, outletId, expectedRevision, JSON.stringify(nextSnapshot)],
      )).rows[0];
      if (!updated) throw repositoryError("hpp_persistence_version_conflict", 409);
      return updated.revision;
    });
  }

  async saveProductionExecutionCompletion({ organizationId, outletId, expectedRevision, snapshot, state, fact }) {
    assertProductionCompletionPersistence({ organizationId, outletId, expectedRevision, snapshot, state, fact });
    const document = validateInventoryReportingProductionDocument(fact);
    const valuationInput = productionValuationInput({ organizationId, outletId, state, document });
    let transactionBodyCompleted = false;
    let revision;
    try {
      revision = await this.db.transaction(async (tx) => {
        await this.faultInjector("before_production_completion_persist", { tx });
        const hppCatalogRevision = await this.#persistHppCatalogState(tx, {
          organizationId,
          outletId,
          expectedRevision,
          snapshot,
          productionExecutionState: state,
        });
        await this.faultInjector("after_production_hpp_persist", { tx });
        const loadedValuation = await this.inventoryValuation.loadInTransaction(tx, valuationInput);
        const valuation = await this.inventoryValuation.appendInTransaction(tx, {
          ...valuationInput,
          expectedRevision: loadedValuation.revision,
          commandType: "PRODUCTION_TRANSFORMATION",
        });
        assertProductionValuationParity({ valuation, document });
        await this.faultInjector("after_production_valuation_persist", { tx });
        await persistInventoryReportingProductionDocument(tx, document);
        await this.faultInjector("after_production_reporting_fact_persist", { tx });
        await this.faultInjector("before_production_completion_commit", { tx });
        transactionBodyCompleted = true;
        return hppCatalogRevision;
      });
    } catch (error) {
      throw productionCommitError(error, transactionBodyCompleted ? "UNKNOWN" : "ROLLED_BACK");
    }
    try { await this.faultInjector("after_production_completion_commit_ack", {}); }
    catch (error) { throw productionCommitError(error, "UNKNOWN"); }
    return revision;
  }

  async loadProductionExecutionCompletionRecovery({ organizationId, outletId, operationKey, productionOrderId }) {
    if (typeof organizationId !== "string" || typeof outletId !== "string" || typeof operationKey !== "string" || typeof productionOrderId !== "string") {
      throw repositoryError("production_execution_completion_recovery_invalid", 422);
    }
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select revision,snapshot from sagaops.pos_hpp_catalog_state where organization_id=$1 and outlet_id=$2 for share",
        [organizationId, outletId],
      )).rows[0];
      if (!row) throw repositoryError("production_execution_completion_recovery_unavailable", 409);
      const snapshot = typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot;
      const encodedState = snapshot?.[PRODUCTION_EXECUTION_STATE_KEY];
      if (typeof encodedState !== "string") throw repositoryError("production_execution_completion_recovery_unavailable", 409);
      let state;
      try { state = JSON.parse(encodedState); } catch { throw repositoryError("production_execution_state_tampered", 500); }
      assertProductionExecutionStateEnvelope({ organizationId, outletId, state });
      const operation = state.operations.find((item) => item?.operationKey === operationKey
        && item?.result?.execution?.productionOrderId === productionOrderId);
      if (!operation) return Object.freeze({ revision: row.revision, snapshot, state, fact: null, proofError: "production_execution_completion_operation_mismatch" });
      const factRow = (await tx.query(
        `select fact_document from sagaops.inventory_reporting_production_facts
          where organization_id=$1 and outlet_id=$2 and production_id=$3`,
        [organizationId, outletId, productionOrderId],
      )).rows[0];
      if (!factRow) return Object.freeze({ revision: row.revision, snapshot, state, fact: null, proofError: "production_execution_completion_fact_missing" });
      const fact = typeof factRow.fact_document === "string" ? JSON.parse(factRow.fact_document) : factRow.fact_document;
      try {
        assertProductionCompletionPersistence({ organizationId, outletId, expectedRevision: row.revision, snapshot, state, fact });
        await assertPersistedProductionMovements(tx, { organizationId, outletId, snapshot, executionId: operation.result.execution.id });
        const document = validateInventoryReportingProductionDocument(fact);
        await assertPersistedProductionValuation(tx, {
          inventoryValuation: this.inventoryValuation,
          input: productionValuationInput({ organizationId, outletId, state, document }),
          document,
        });
      } catch (error) {
        return Object.freeze({ revision: row.revision, snapshot, state, fact: null, proofError: error.code ?? error.message ?? "production_execution_completion_proof_invalid" });
      }
      return Object.freeze({ revision: row.revision, snapshot, state, fact: validateInventoryReportingProductionDocument(fact), proofError: null });
    });
  }

  async authorizePurchaseReceiptLocations({ organizationId, outletId, destinationLocationId, quarantineLocationId, rejectionLocationId, pendingInspectionLocationId, lines }) {
    const outlet = (await this.db.query("select id from sagaops.outlets where id=$1 and organization_id=$2", [outletId, organizationId])).rows[0];
    if (!outlet) throw repositoryError("purchase_receipt_location_not_authorized", 403);
    const expected = sagaPosPurchaseReceiptLocations(outletId);
    const hasQuarantine = Array.isArray(lines) && lines.some((line) => Number(line?.quarantinedPurchaseQuantity ?? 0) > 0);
    const hasRejected = Array.isArray(lines) && lines.some((line) => Number(line?.rejectedPurchaseQuantity ?? 0) > 0);
    const hasPending = Array.isArray(lines) && lines.some((line) => Number(line?.pendingInspectionPurchaseQuantity ?? 0) > 0);
    if (destinationLocationId == null || destinationLocationId === "") throw repositoryError("purchase_destination_location_required", 422);
    if (hasQuarantine && (quarantineLocationId == null || quarantineLocationId === "")) throw repositoryError("purchase_quarantine_location_required", 422);
    if (hasRejected && (rejectionLocationId == null || rejectionLocationId === "")) throw repositoryError("purchase_rejection_location_required", 422);
    if (hasPending && (pendingInspectionLocationId == null || pendingInspectionLocationId === "")) throw repositoryError("purchase_pending_inspection_location_required", 422);
    if (destinationLocationId !== expected.usable
      || (hasQuarantine ? quarantineLocationId !== expected.quarantine : quarantineLocationId != null)
      || (hasRejected ? rejectionLocationId !== expected.rejected : rejectionLocationId != null)
      || (hasPending ? pendingInspectionLocationId !== expected.pendingInspection : pendingInspectionLocationId != null)) {
      throw repositoryError("purchase_receipt_location_not_authorized", 403);
    }
    return structuredClone(expected);
  }

  async persistPurchaseReceipt({ organizationId, outletId, actorReference, expectedRevision, snapshot, receiptId }) {
    const receipt = snapshot?.purchaseReceipts?.find((item) => item.id === receiptId);
    if (!receipt || typeof receipt.fingerprint !== "string" || !receipt.fingerprint || typeof receipt.idempotencyKey !== "string"
      || typeof receipt.destinationLocationId !== "string" || !receipt.destinationLocationId || !Array.isArray(receipt.deliveredLines)
      || !Array.isArray(receipt.lines) || !Array.isArray(receipt.rejectedLines) || !Array.isArray(receipt.quarantinedLines)
      || !Array.isArray(receipt.pendingInspectionLines) || !Number.isSafeInteger(receipt.totalCostRupiah)) {
      throw repositoryError("purchase_receipt_snapshot_invalid", 500);
    }
    const eventPayload = {
      receiptFingerprint: receipt.fingerprint,
      receiptSource: receipt.receiptSource,
      purchaseOrderId: receipt.purchaseOrderId ?? null,
      destinationLocationId: receipt.destinationLocationId,
      quarantineLocationId: receipt.quarantineLocationId,
      rejectionLocationId: receipt.rejectionLocationId,
      pendingInspectionLocationId: receipt.pendingInspectionLocationId,
      deliveredPurchaseQuantity: receipt.deliveredLines.reduce((sum, line) => sum + line.deliveredPurchaseQuantity, 0),
      acceptedBaseQuantity: receipt.lines.reduce((sum, line) => sum + line.baseQuantity, 0),
      rejectedPurchaseQuantity: receipt.rejectedLines.reduce((sum, line) => sum + line.rejectedPurchaseQuantity, 0),
      quarantinedPurchaseQuantity: receipt.quarantinedLines.reduce((sum, line) => sum + line.quarantinedPurchaseQuantity, 0),
      pendingInspectionPurchaseQuantity: receipt.pendingInspectionLines.reduce((sum, line) => sum + line.pendingInspectionPurchaseQuantity, 0),
      postedInventoryValueRupiah: receipt.totalCostRupiah,
    };
    return this.db.transaction(async (tx) => {
      const hppCatalogRevision = await this.#persistHppCatalogState(tx, { organizationId, outletId, expectedRevision, snapshot });
      let valuation = null;
      if (receipt.lines.length > 0) {
        const valuationScopeId = sagaPosPurchaseReceiptLocations(outletId).usable;
        const loaded = await this.inventoryValuation.loadInTransaction(tx, { organizationId, outletId, valuationScopeId });
        valuation = await this.inventoryValuation.appendInTransaction(tx, {
          organizationId,
          outletId,
          valuationScopeId,
          expectedRevision: loaded.revision,
          commandType: "PROVISIONAL_RECEIPT",
          actorReference,
          reason: receipt.reason,
          command: {
            organizationId,
            outletId,
            valuationScopeId,
            operationKey: boundedOperationKey("receipt", receipt.idempotencyKey),
            occurredAt: receipt.receivedAt,
            effectiveAt: receipt.receivedAt,
            receiptId: receipt.id,
            lines: receipt.lines.map((line) => ({
              lineId: valuationReceiptLineId(receipt.id, line.ingredientId),
              ingredientId: line.ingredientId,
              quantityBase: valuationQuantity(line.baseQuantity),
              provisionalItemCostRupiah: line.totalCostRupiah,
            })),
          },
        });
        eventPayload.valuationFactId = valuation.fact.factId;
        eventPayload.valuationFactHash = valuation.fact.factHash;
      } else {
        eventPayload.valuationFactId = null;
        eventPayload.valuationFactHash = null;
      }
      const eventInput = {
        organizationId,
        outletId,
        actorReference,
        aggregateType: "purchase_receipt",
        correlationId: receipt.idempotencyKey,
      };
      await this.#appendAudit(tx, eventInput, receipt.id, "hpp.purchase.receipt_posted", eventPayload);
      await this.#appendOutbox(tx, eventInput, receipt.id, "PURCHASE_RECEIPT_POSTED_V1", eventPayload);
      await this.faultInjector("before_purchase_receipt_commit", { tx });
      return { receiptId: receipt.id, hppCatalogRevision, valuationFactId: valuation?.fact.factId ?? null, idempotentReplay: false };
    });
  }

  async persistPurchaseInvoicePost({ organizationId, outletId, actorReference, expectedRevision, snapshot, purchaseInvoiceId }) {
    const invoice = snapshot?.purchaseInvoices?.find((item) => item.id === purchaseInvoiceId);
    if (!invoice || invoice.paymentReadiness !== "POSTED_UNPAID" || !invoice.payableEntry
      || !Array.isArray(invoice.lines) || !Array.isArray(invoice.additionalFees) || !Array.isArray(invoice.approvalHistory)) {
      throw repositoryError("purchase_invoice_snapshot_invalid", 500);
    }
    const receipts = snapshot.purchaseReceipts.filter(
      (receipt) => receipt.purchaseOrderId === invoice.purchaseOrderId && receipt.version <= invoice.receiptVersionThrough && receipt.lines.length > 0,
    );
    if (receipts.length !== 1) throw repositoryError("purchase_invoice_valuation_receipt_ambiguous", 409);
    const receipt = receipts[0];
    const financeApproval = invoice.approvalHistory.findLast((item) => item.action === "APPROVED");
    const ownerPost = invoice.approvalHistory.findLast((item) => item.action === "POSTED");
    if (!financeApproval || !ownerPost || ownerPost.actorId !== actorReference) throw repositoryError("purchase_invoice_valuation_approval_invalid", 500);
    const invoiceLines = receipt.lines.map((receiptLine) => {
      const invoiceLine = invoice.lines.find((line) => line.ingredientId === receiptLine.ingredientId);
      if (!invoiceLine) throw repositoryError("purchase_invoice_valuation_line_missing", 409);
      return {
        lineId: valuationReceiptLineId(receipt.id, receiptLine.ingredientId),
        invoicedItemCostRupiah: invoiceLine.invoiceLineTotalRupiah,
      };
    });
    const valuationScopeId = sagaPosPurchaseReceiptLocations(outletId).usable;
    return this.db.transaction(async (tx) => {
      const hppCatalogRevision = await this.#persistHppCatalogState(tx, { organizationId, outletId, expectedRevision, snapshot });
      const loaded = await this.inventoryValuation.loadInTransaction(tx, { organizationId, outletId, valuationScopeId });
      const valuation = await this.inventoryValuation.appendInTransaction(tx, {
        organizationId,
        outletId,
        valuationScopeId,
        expectedRevision: loaded.revision,
        commandType: "RECEIPT_REVALUATION",
        actorReference,
        reason: ownerPost.reason,
        command: {
          organizationId,
          outletId,
          valuationScopeId,
          operationKey: boundedOperationKey("revaluation", ownerPost.idempotencyKey),
          occurredAt: ownerPost.occurredAt,
          effectiveAt: ownerPost.occurredAt,
          revaluationId: boundedOperationKey("revaluation", `${invoice.id}:${receipt.id}`),
          receiptId: receipt.id,
          invoiceId: invoice.id,
          invoiceLines,
          landedCost: { allocationMethod: "VALUE", totalRupiah: invoice.totalAdditionalFeesRupiah },
          approval: {
            reviewedBy: financeApproval.actorId,
            approvedBy: ownerPost.actorId,
            reason: ownerPost.reason,
          },
        },
      });
      return { hppCatalogRevision, valuationFactId: valuation.fact.factId, idempotentReplay: valuation.idempotentReplay };
    });
  }

  async authorizePurchaseInspectionLocation({ organizationId, outletId, decision, destinationLocationId }) {
    const outlet = (await this.db.query("select id from sagaops.outlets where id=$1 and organization_id=$2", [outletId, organizationId])).rows[0];
    if (!outlet) throw repositoryError("purchase_receipt_location_not_authorized", 403);
    const expected = sagaPosPurchaseReceiptLocations(outletId);
    const required = decision === "ACCEPT" ? expected.usable : decision === "REJECT" ? expected.rejected : null;
    if (!required || destinationLocationId !== required) throw repositoryError("purchase_inspection_location_not_authorized", 403);
    return required;
  }

  async persistPurchaseInspectionDecision({ organizationId, outletId, actorReference, expectedRevision, snapshot, decisionId }) {
    const decision = snapshot?.purchaseReceiptInspectionDecisions?.find((item) => item.id === decisionId);
    if (!decision || typeof decision.fingerprint !== "string" || !decision.fingerprint || typeof decision.idempotencyKey !== "string"
      || !["ACCEPT", "REJECT"].includes(decision.decision) || !["QUARANTINED", "PENDING_INSPECTION"].includes(decision.sourceDisposition)
      || typeof decision.destinationLocationId !== "string" || !Number.isSafeInteger(decision.inventoryValueRupiah)) {
      throw repositoryError("purchase_inspection_snapshot_invalid", 500);
    }
    const eventPayload = {
      decisionFingerprint: decision.fingerprint,
      purchaseReceiptId: decision.purchaseReceiptId,
      purchaseOrderId: decision.purchaseOrderId,
      ingredientId: decision.ingredientId,
      lotCode: decision.lotCode,
      sourceDisposition: decision.sourceDisposition,
      decision: decision.decision,
      purchaseQuantity: decision.purchaseQuantity,
      baseQuantity: decision.baseQuantity,
      postedInventoryValueRupiah: decision.inventoryValueRupiah,
      destinationLocationId: decision.destinationLocationId,
    };
    return this.db.transaction(async (tx) => {
      const hppCatalogRevision = await this.#persistHppCatalogState(tx, { organizationId, outletId, expectedRevision, snapshot });
      const eventInput = { organizationId, outletId, actorReference, aggregateType: "purchase_receipt_inspection", correlationId: decision.idempotencyKey };
      await this.#appendAudit(tx, eventInput, decision.id, "hpp.purchase.receipt_inspection_decided", eventPayload);
      await this.#appendOutbox(tx, eventInput, decision.id, "PURCHASE_RECEIPT_INSPECTION_DECIDED_V1", eventPayload);
      await this.faultInjector("before_purchase_inspection_commit", { tx });
      return { decisionId: decision.id, hppCatalogRevision, idempotentReplay: false };
    });
  }

  async authorizeOfflineInventoryDevice({ organizationId, outletId, deviceCode }) {
    return this.#requireOfflineInventoryDevice(this.db, { organizationId, outletId, deviceCode });
  }

  async enqueueOfflineInventoryOperation({ operation }) {
    if (!operation || operation.kind !== "HPP_OFFLINE_PHYSICAL_SALE_V1" || !operation.operationId || !operation.fingerprint) throw new Error("offline_inventory_operation_invalid");
    return this.db.transaction(async (tx) => {
      await this.#requireOfflineInventoryDevice(tx, {
        organizationId: operation.organizationId,
        outletId: operation.outletId,
        deviceCode: operation.deviceId,
      });
      const existing = (await tx.query(
        `select id,operation_id,operation_fingerprint,status from sagaops.esb_offline_operations
          where organization_id=$1 and outlet_id=$2
            and (operation_id=$3 or (device_id=$4 and local_operation_id=$5))
          order by created_at limit 1 for update`,
        [operation.organizationId, operation.outletId, operation.operationId, operation.deviceId, operation.localOperationId],
      )).rows[0];
      if (existing) {
        if (existing.operation_fingerprint === operation.fingerprint) {
          return { operationId: existing.operation_id, status: existing.status, idempotentReplay: true, operatorReviewRequired: existing.status === "REVIEW_REQUIRED" };
        }
        const collisionFingerprint = createHash("sha256").update(`${existing.operation_fingerprint}:${operation.fingerprint}`).digest("hex");
        const priorReview = (await tx.query(
          `select id from sagaops.esb_offline_conflicts
            where organization_id=$1 and outlet_id=$2 and offline_operation_id=$3
              and decision='REVIEW_REQUIRED' and conflict_snapshot->>'collisionFingerprint'=$4
            order by created_at limit 1`,
          [operation.organizationId, operation.outletId, existing.id, collisionFingerprint],
        )).rows[0];
        let reviewId = priorReview?.id;
        if (!reviewId) {
          reviewId = randomUUID();
          await tx.query(
            `insert into sagaops.esb_offline_conflicts
              (id,organization_id,outlet_id,offline_operation_id,decision,conflict_snapshot)
             values ($1,$2,$3,$4,'REVIEW_REQUIRED',$5::jsonb)`,
            [reviewId, operation.organizationId, operation.outletId, existing.id, JSON.stringify({
              conflictType: "OFFLINE_EVENT_COLLISION",
              collisionFingerprint,
              originalFingerprint: existing.operation_fingerprint,
              attemptedFingerprint: operation.fingerprint,
            })],
          );
        }
        return {
          operationId: existing.operation_id,
          reviewId,
          status: "COLLISION_REVIEW_REQUIRED",
          operatorReviewRequired: true,
          idempotentReplay: Boolean(priorReview),
        };
      }
      const id = randomUUID();
      await tx.query(
        `insert into sagaops.esb_offline_operations
          (id,organization_id,outlet_id,operation_id,device_id,local_operation_id,operation_kind,operation_fingerprint,base_versions,payload_snapshot,status,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'PENDING_REPLAY',$11)`,
        [id, operation.organizationId, operation.outletId, operation.operationId, operation.deviceId, operation.localOperationId,
          operation.kind, operation.fingerprint, JSON.stringify(operation.baseVersions), JSON.stringify(operation.payload), operation.occurredAt],
      );
      await this.#appendAudit(tx, { ...operation, actorReference: operation.deviceId, aggregateType: "offline_inventory", correlationId: operation.operationId }, id, "offline.inventory.queued", { status: "PENDING_REPLAY" });
      await this.#appendOutbox(tx, { ...operation, correlationId: operation.operationId }, id, "OFFLINE_INVENTORY_QUEUED_V1");
      await this.faultInjector("before_offline_inventory_enqueue_commit", { tx });
      return { operationId: operation.operationId, status: "PENDING_REPLAY", idempotentReplay: false, operatorReviewRequired: false };
    });
  }

  async loadOfflineInventoryOperation({ organizationId, outletId, operationId }) {
    const row = (await this.db.query(
      `select operation_id,device_id,local_operation_id,operation_kind,operation_fingerprint,base_versions,payload_snapshot,status,occurred_at,applied_at
         from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3`,
      [organizationId, outletId, operationId],
    )).rows[0];
    if (!row) return null;
    const persisted = {
      operationId: row.operation_id,
      deviceId: row.device_id,
      localOperationId: row.local_operation_id,
      kind: row.operation_kind,
      fingerprint: row.operation_fingerprint,
      baseVersions: structuredClone(row.base_versions),
      payload: structuredClone(row.payload_snapshot),
      status: row.status,
      occurredAt: new Date(row.occurred_at).toISOString(),
      appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    };
    let canonical;
    try {
      canonical = createOfflineOperation({
        organizationId,
        outletId,
        deviceId: persisted.deviceId,
        localOperationId: persisted.localOperationId,
        kind: persisted.kind,
        baseVersions: persisted.baseVersions,
        payload: persisted.payload,
        occurredAt: persisted.occurredAt,
      });
    } catch {
      throw repositoryError("offline_inventory_persisted_operation_invalid", 500);
    }
    if (canonical.kind !== "HPP_OFFLINE_PHYSICAL_SALE_V1" || canonical.operationId !== persisted.operationId
      || canonical.fingerprint !== persisted.fingerprint) throw repositoryError("offline_inventory_persisted_operation_invalid", 500);
    await this.#requireOfflineInventoryDevice(this.db, { organizationId, outletId, deviceCode: row.device_id });
    return persisted;
  }

  async applyOfflineInventoryOperation({ organizationId, outletId, operationId, actorReference, appliedAt, hppCatalogMutation, businessResult }) {
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select id,status,device_id from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3 for update",
        [organizationId, outletId, operationId],
      )).rows[0];
      if (!row) throw new Error("offline_inventory_operation_not_found");
      const device = await this.#requireOfflineInventoryDevice(tx, { organizationId, outletId, deviceCode: row.device_id });
      if (actorReference !== device.deviceCode) throw repositoryError("offline_device_not_authorized", 403);
      if (row.status === "APPLIED") return { operationId, status: "APPLIED", idempotentReplay: true, hppCatalogRevision: null };
      if (row.status !== "PENDING_REPLAY" || !hppCatalogMutation) throw new Error("offline_inventory_operation_not_ready");
      const hppCatalogRevision = await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId });
      await tx.query("update sagaops.esb_offline_operations set status='APPLIED',applied_at=$1,updated_at=$1 where id=$2", [appliedAt, row.id]);
      await this.#appendAudit(tx, { organizationId, outletId, actorReference, aggregateType: "offline_inventory", correlationId: operationId }, row.id, "offline.inventory.applied", businessResult);
      await this.#appendOutbox(tx, { organizationId, outletId, correlationId: operationId }, row.id, "OFFLINE_INVENTORY_APPLIED_V1");
      await this.faultInjector("before_offline_inventory_apply_commit", { tx });
      return { operationId, status: "APPLIED", idempotentReplay: false, hppCatalogRevision };
    });
  }

  async markOfflineInventoryOperationReview({ organizationId, outletId, operationId, conflictFingerprint, conflictType = "OFFLINE_EVENT_COLLISION" }) {
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select id,status from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3 for update",
        [organizationId, outletId, operationId],
      )).rows[0];
      if (!row) throw new Error("offline_inventory_operation_not_found");
      const prior = (await tx.query(
        `select id from sagaops.esb_offline_conflicts where organization_id=$1 and outlet_id=$2 and offline_operation_id=$3
          and decision='REVIEW_REQUIRED' and conflict_snapshot->>'collisionFingerprint'=$4 order by created_at limit 1`,
        [organizationId, outletId, row.id, conflictFingerprint],
      )).rows[0];
      const reviewId = prior?.id ?? randomUUID();
      if (!prior) await tx.query(
        `insert into sagaops.esb_offline_conflicts(id,organization_id,outlet_id,offline_operation_id,decision,conflict_snapshot)
         values ($1,$2,$3,$4,'REVIEW_REQUIRED',$5::jsonb)`,
        [reviewId, organizationId, outletId, row.id, JSON.stringify({ conflictType, collisionFingerprint: conflictFingerprint })],
      );
      if (row.status === "PENDING_REPLAY") await tx.query("update sagaops.esb_offline_operations set status='REVIEW_REQUIRED',updated_at=now() where id=$1", [row.id]);
      return { operationId, reviewId, status: "COLLISION_REVIEW_REQUIRED", operatorReviewRequired: true, idempotentReplay: Boolean(prior) };
    });
  }

  async #requireOfflineInventoryDevice(queryable, { organizationId, outletId, deviceCode }) {
    if (typeof deviceCode !== "string" || !deviceCode.trim()) throw repositoryError("offline_device_not_authorized", 403);
    const row = (await queryable.query(
      `select id,device_code,status,operational_status,capability_manifest from sagaops.pos_devices
        where organization_id=$1 and outlet_id=$2 and device_code=$3`,
      [organizationId, outletId, deviceCode.trim()],
    )).rows[0];
    if (!row || row.status !== "active" || row.operational_status !== "active" || row.capability_manifest?.offlineInventorySync !== true) {
      throw repositoryError("offline_device_not_authorized", 403);
    }
    return { id: row.id, deviceCode: row.device_code };
  }

  async saveHttpSession({ organizationId, outletId, kind, session }) {
    const result = await this.db.query(`insert into sagaops.pos_http_sessions(token_hash,organization_id,outlet_id,kind,subject,csrf_token,created_at,expires_at)
      select $1,$2,$3,$4,$5::jsonb,$6,$7,$8
      where exists(select 1 from sagaops.outlets where id=$3 and organization_id=$2) returning token_hash`,
    [session.tokenHash, organizationId, outletId, kind, JSON.stringify(session.subject), session.csrfToken, session.createdAt, session.expiresAt]);
    if (!result.rows[0]) throw new Error("session_scope_denied");
  }

  async loadHttpSession({ organizationId, outletId, kind, tokenHash }) {
    const result = await this.db.query(`select token_hash,subject,csrf_token,created_at,expires_at from sagaops.pos_http_sessions
      where organization_id=$1 and outlet_id=$2 and kind=$3 and token_hash=$4 and expires_at>$5`,
    [organizationId, outletId, kind, tokenHash, this.clock().toISOString()]);
    const row = result.rows[0];
    return row ? { tokenHash: row.token_hash, subject: row.subject, csrfToken: row.csrf_token, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() } : null;
  }

  async revokeHttpSession({ organizationId, outletId, kind, tokenHash }) {
    await this.db.query("delete from sagaops.pos_http_sessions where organization_id=$1 and outlet_id=$2 and kind=$3 and token_hash=$4", [organizationId, outletId, kind, tokenHash]);
  }

  async saveCatalogState({ organizationId, outletId, expectedRevision, snapshot }) {
    return this.db.transaction(async (tx) => {
      const result = await tx.query(`insert into sagaops.pos_catalog_state(organization_id,outlet_id,revision,snapshot)
        select $1,$2,1,$4::jsonb where $3::integer=0
          and exists(select 1 from sagaops.outlets where id=$2 and organization_id=$1)
        on conflict(outlet_id) do nothing returning revision`, [organizationId, outletId, expectedRevision, JSON.stringify(snapshot)]);
      let row = result.rows[0];
      if (!row && expectedRevision > 0) {
        const updated = await tx.query(`update sagaops.pos_catalog_state set revision=revision+1,snapshot=$4::jsonb,updated_at=now()
          where organization_id=$1 and outlet_id=$2 and revision=$3 returning revision`, [organizationId, outletId, expectedRevision, JSON.stringify(snapshot)]);
        row = updated.rows[0];
      }
      if (!row) {
        const error = new Error("catalog_version_conflict");
        error.code = "catalog_version_conflict";
        error.statusCode = 409;
        throw error;
      }
      await this.faultInjector("before_catalog_commit", { tx });
      return row.revision;
    });
  }

  async seedPilotContext(ids = SAGA_POS_DURABLE_PILOT_IDS) {
    await this.db.transaction(async (tx) => {
      await tx.query("insert into auth.users(id) values ($1) on conflict (id) do nothing", [ids.authUserId]);
      await tx.query([
        "insert into sagaops.organizations(id,name,owner_auth_user_id)",
        "values ($1,'Kopi Saga',$2)",
        "on conflict (id) do update set name=excluded.name, owner_auth_user_id=excluded.owner_auth_user_id",
      ].join(" "), [ids.organizationId, ids.authUserId]);
      await tx.query([
        "insert into sagaops.outlets(id,organization_id,name,code,timezone,tax_rate_bps,service_rate_bps,price_tax_inclusive)",
        "values ($1,$2,'Kopi Saga Salak','SALAK','Asia/Jakarta',0,0,true)",
        "on conflict (id) do update set name=excluded.name, timezone=excluded.timezone",
      ].join(" "), [ids.outletId, ids.organizationId]);
      await tx.query([
        "insert into sagaops.user_profiles(id,auth_user_id,full_name)",
        "values ($1,$2,'Demo Owner')",
        "on conflict (id) do update set full_name=excluded.full_name",
      ].join(" "), [ids.ownerProfileId, ids.authUserId]);
      await tx.query([
        "insert into sagaops.outlet_user_roles(organization_id,outlet_id,user_profile_id,role)",
        "values ($1,$2,$3,'owner') on conflict (organization_id,outlet_id,user_profile_id,role) do nothing",
      ].join(" "), [ids.organizationId, ids.outletId, ids.ownerProfileId]);
      const organizationOwners = (await tx.query([
        "select user_profile_id from sagaops.outlet_user_roles",
        "where organization_id=$1 and outlet_id is null and role='owner' and status='active'",
        "order by id",
      ].join(" "), [ids.organizationId])).rows;
      if (organizationOwners.length > 1 || (organizationOwners.length === 1 && organizationOwners[0].user_profile_id !== ids.ownerProfileId)) {
        throw repositoryError("pilot_context_organization_owner_ambiguous", 409);
      }
      if (organizationOwners.length === 0) {
        await tx.query([
          "insert into sagaops.outlet_user_roles(organization_id,outlet_id,user_profile_id,role,status)",
          "select $1,null,$2,'owner','active'",
          "where not exists (select 1 from sagaops.outlet_user_roles where organization_id=$1 and outlet_id is null and role='owner' and status='active')",
        ].join(" "), [ids.organizationId, ids.ownerProfileId]);
      }
      const ownerCount = (await tx.query([
        "select count(*)::integer count,count(*) filter(where user_profile_id=$2)::integer expected_count from sagaops.outlet_user_roles",
        "where organization_id=$1 and outlet_id is null and role='owner' and status='active'",
      ].join(" "), [ids.organizationId, ids.ownerProfileId])).rows[0];
      if (Number(ownerCount?.count) !== 1 || Number(ownerCount?.expected_count) !== 1) throw repositoryError("pilot_context_organization_owner_ambiguous", 409);
    });
    return structuredClone(ids);
  }

  async verifyPilotContext(ids = SAGA_POS_DURABLE_PILOT_IDS) {
    const result = await this.db.query([
      "select o.id as organization_id, ot.id as outlet_id, up.id as owner_profile_id, our.role,",
      "(select count(*)::integer from sagaops.outlet_user_roles organization_owner where organization_owner.organization_id=o.id and organization_owner.outlet_id is null and organization_owner.role='owner' and organization_owner.status='active') as organization_owner_count,",
      "(select count(*)::integer from sagaops.outlet_user_roles expected_owner where expected_owner.organization_id=o.id and expected_owner.outlet_id is null and expected_owner.user_profile_id=up.id and expected_owner.role='owner' and expected_owner.status='active') as expected_organization_owner_count",
      "from sagaops.organizations o",
      "join sagaops.outlets ot on ot.organization_id=o.id and ot.id=$2 and ot.status='active' and ot.archived_at is null",
      "join sagaops.user_profiles up on up.auth_user_id=$4 and up.id=$3 and up.status='active'",
      "join sagaops.outlet_user_roles our on our.organization_id=o.id and our.outlet_id=ot.id and our.user_profile_id=up.id and our.role='owner' and our.status='active'",
      "where o.id=$1 and o.owner_auth_user_id=$4 and o.status='active' and o.archived_at is null",
    ].join(" "), [ids.organizationId, ids.outletId, ids.ownerProfileId, ids.authUserId]);
    if (!result.rows[0] || Number(result.rows[0].organization_owner_count) !== 1 || Number(result.rows[0].expected_organization_owner_count) !== 1) {
      const error = new Error("pilot_context_not_provisioned");
      error.code = "pilot_context_not_provisioned";
      error.statusCode = 503;
      throw error;
    }
    return structuredClone(ids);
  }

  async saveKioskSession({ id, organizationId, outletId, status = "ACTIVE", activeOrderId = null, createdAt } = {}) {
    await this.db.query([
      "insert into sagaops.kiosk_sessions(id,organization_id,outlet_id,status,active_order_id,created_at,updated_at)",
      "values ($1,$2,$3,$4,$5,$6,$7)",
      "on conflict (id) do update set status=excluded.status, active_order_id=excluded.active_order_id, updated_at=excluded.updated_at",
    ].join(" "), [id, organizationId, outletId, status.toLowerCase(), activeOrderId, createdAt ?? this.clock().toISOString(), this.clock().toISOString()]);
  }

  async saveCashSession({ session, organizationId, outletId, actorReference } = {}) {
    if (!session?.id) throw new Error("cash_session_required");
    const status = String(session.status ?? "open").toLowerCase();
    const normalizedStatus = ["open", "closing", "closed", "approved"].includes(status) ? status : "open";
    await this.db.transaction(async (tx) => {
      await tx.query([
        "insert into sagaops.cash_sessions(id,organization_id,outlet_id,business_date,shift_name,status,opening_cash_rupiah,expected_cash_rupiah,actual_cash_rupiah,cash_to_leave_rupiah,deposit_cash_rupiah,variance_rupiah,opened_at,closed_at,created_at,updated_at)",
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$15)",
        "on conflict (id) do update set status=excluded.status,expected_cash_rupiah=excluded.expected_cash_rupiah,actual_cash_rupiah=excluded.actual_cash_rupiah,cash_to_leave_rupiah=excluded.cash_to_leave_rupiah,deposit_cash_rupiah=excluded.deposit_cash_rupiah,variance_rupiah=excluded.variance_rupiah,closed_at=excluded.closed_at,updated_at=excluded.updated_at",
      ].join(" "), [
        session.id, organizationId, outletId, session.businessDate, session.shiftName ?? "Shift",
        normalizedStatus, session.openingCashRupiah ?? 0, session.expectedCashRupiah ?? 0,
        session.actualCashRupiah ?? null, session.cashToLeaveRupiah ?? 0, session.depositCashRupiah ?? null,
        session.varianceRupiah ?? null, session.openedAt ?? this.clock().toISOString(), session.closedAt ?? null,
        this.clock().toISOString(),
      ]);
      await tx.query("update sagaops.cash_sessions set opened_by_reference=coalesce(opened_by_reference,$1) where id=$2", [session.openedByUserId ?? actorReference, session.id]);
      await this.#appendAudit(tx, { organizationId, outletId, actorReference, aggregateType: "cash_session" }, session.id, `cash.shift.${normalizedStatus}`, { status: normalizedStatus, varianceRupiah: session.varianceRupiah ?? null, expectedOpeningCashRupiah:session.expectedOpeningCashRupiah, openingVarianceRupiah:session.openingVarianceRupiah, previousCashSessionId:session.previousCashSessionId, handoverStatus:session.handoverStatus, openingNote:session.openingNote });
    });
  }

  async closeShiftFromLedger(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).closeShiftFromLedger(input);
  }

  async previewShiftClose(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).previewShiftClose(input);
  }

  async issueReliabilityAuthorization(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).issueAuthorization(input);
  }

  async requestReliabilityAuthorization(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).requestAuthorization(input);
  }

  async approveReliabilityAuthorization(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).approveAuthorizationRequest(input);
  }

  async cashierDiscountApprovals({organizationId, outletId, actorReference = null, requestId = null}) {
    return (await this.db.query(`select r.*, a.status authorization_status, a.expires_at
      from sagaops.esb_reliability_approval_requests r left join sagaops.esb_reliability_authorizations a
      on a.id=r.authorization_id and a.organization_id=r.organization_id and a.outlet_id=r.outlet_id
      where r.organization_id=$1 and r.outlet_id=$2 and r.action='cashier:discount'
      and ($3::text is null or r.actor_reference=$3) and ($4::uuid is null or r.id=$4)
      order by r.requested_at desc limit 100`, [organizationId,outletId,actorReference,requestId])).rows;
  }

  async persistInventoryLedgerMovement(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).persistInventoryLedgerMovement(input);
  }

  async reconstructInventoryLedger(input) {
    return new EsbReliabilityPostgresRepository({ db: this.db, clock: this.clock, faultInjector: this.faultInjector }).reconstructInventoryLedger(input);
  }

  async persistRefund({ organizationId, outletId, orderId, cashSessionId, actorUserId = SAGA_POS_DURABLE_PILOT_IDS.ownerProfileId, actorReference, reason, items, idempotencyKey, expectedRefundCount, refundId = randomUUID(), refundedAt = null, hppCatalogMutation = null } = {}) {
    if (!String(reason ?? "").trim()) throw new Error("refund_reason_required");
    if (items !== undefined && this.requiresEsbCatalogSnapshot()) throw repositoryError('partial_refund_esb_ledger_unavailable',409);
    const transitionAt = refundedAt ?? this.clock().toISOString();
    if (!Number.isFinite(Date.parse(transitionAt)) || new Date(transitionAt).toISOString() !== transitionAt) throw new Error("refund_timestamp_invalid");
    return this.db.transaction(async (tx) => {
      const result = await tx.query([
        "select o.*,p.id as payment_id,p.method_type,p.status as payment_status,pi.id as payment_intent_id",
        "from sagaops.orders o join sagaops.payments p on p.order_id=o.id left join sagaops.payment_intents pi on pi.order_id=o.id",
        "where o.id=$1 and o.organization_id=$2 and o.outlet_id=$3 and p.status in ('paid','refunded') order by p.created_at desc limit 1 for update of o,p",
      ].join(" "), [orderId, organizationId, outletId]);
      const current = result.rows[0];
      if (!current) throw new Error("order_not_found");
      const audits=(await tx.query("select payload_redacted,event_type,actor_reference,occurred_at from sagaops.pos_audit_events where organization_id=$1 and outlet_id=$2 and aggregate_id=$3 and event_type in ('pos.checkout.created','order.refunded','order.refund.requested') order by occurred_at,id",[organizationId,outletId,orderId])).rows;
      const history=audits.filter(row=>row.event_type !== 'pos.checkout.created').map(row=>({...row.payload_redacted,orderId,status:row.event_type === 'order.refunded'?'REFUNDED_LOCAL':'PENDING_MANUAL_FINANCE_RECONCILIATION'}));
      // Legacy full refunds have no operation fingerprint. Preserve their replay,
      // but never let an item request reuse that ambiguous history.
      const legacy=history.find(row=>!row.operationKey);
      if (legacy) {
        if (items !== undefined || idempotencyKey || (legacy.reason && legacy.reason !== reason.trim())) throw repositoryError('refund_retry_conflict',409);
        return {status:legacy.status,mutatesGatewayPayment:false,idempotentReplay:true};
      }
      const storedItems=(await tx.query('select id,order_id,qty,line_total_rupiah from sagaops.order_items where order_id=$1 order by created_at,id',[orderId])).rows;
      const order={id:orderId,status:String(current.status).toUpperCase(),benefitSnapshot:audits.find(row=>row.event_type === 'pos.checkout.created')?.payload_redacted?.benefitSnapshot};
      for (const field of ['subtotal','discount','tax','service','rounding','total']) order[`${field}Rupiah`]=Number(current[`${field}_rupiah`]);
      const plan=planCashierRefund({order,orderItems:storedItems.map(row=>({id:row.id,orderId:row.order_id,qty:Number(row.qty),lineTotalRupiah:Number(row.line_total_rupiah)})),refunds:history,items,reason,idempotencyKey});
      if (plan.idempotentReplay) return {status:plan.status,refund:plan,mutatesGatewayPayment:false,idempotentReplay:true};
      if (expectedRefundCount != null && expectedRefundCount !== history.length) throw repositoryError('refund_state_changed',409);
      if (items !== undefined && current.method_type !== 'cash') throw repositoryError('partial_refund_payment_not_available',409);
      if (items !== undefined) {
        const tenders=(await tx.query("select amount_rupiah from sagaops.payments where order_id=$1 and status in ('paid','refunded')",[orderId])).rows;
        if (tenders.length !== 1 || Number(tenders[0].amount_rupiah) !== order.totalRupiah) throw repositoryError('partial_refund_split_payment_unavailable',409);
      }
      const refund={...plan,id:refundId,orderId,actorId:actorReference,createdAt:transitionAt,cashSessionId,mode:current.method_type,status:['qris_dynamic','qris_manual'].includes(current.method_type)?'PENDING_MANUAL_FINANCE_RECONCILIATION':'REFUNDED_LOCAL',mutatesGatewayPayment:false};
      if (current.method_type === 'qris_manual') {
        const prior=(await tx.query("select id from sagaops.pos_audit_events where organization_id=$1 and outlet_id=$2 and aggregate_id=$3 and event_type='order.refund.requested' limit 1",[organizationId,outletId,orderId])).rows[0];
        if (prior) return {status:'PENDING_MANUAL_FINANCE_RECONCILIATION',idempotentReplay:true,mutatesGatewayPayment:false};
        await tx.query("update sagaops.fulfillment_tickets set status='cancelled',updated_at=$1 where order_id=$2 and status in ('new','in_progress')",[transitionAt,orderId]);
        const hppCatalogRevision=hppCatalogMutation ? await this.#persistHppCatalogState(tx,{...hppCatalogMutation,organizationId,outletId}) : null;
        await this.#appendAudit(tx,{organizationId,outletId,actorReference,occurredAt:transitionAt},orderId,'order.refund.requested',refund);
        await this.faultInjector('before_refund_commit',{tx,orderId,refund});
        return {status:refund.status,refund,mutatesGatewayPayment:false,hppCatalogRevision};
      }
      if (current.method_type === "qris_dynamic") {
        if (!current.payment_intent_id) throw new Error("gateway_payment_intent_not_found");
        await tx.query([
          "insert into sagaops.gateway_refund_requests(organization_id,outlet_id,order_id,payment_intent_id,amount_rupiah,reason,requested_by_user_id)",
          "values ($1,$2,$3,$4,$5,$6,$7)",
          "on conflict (payment_intent_id) do nothing",
        ].join(" "), [organizationId, outletId, orderId, current.payment_intent_id, current.total_rupiah, String(reason).trim(), actorUserId]);
        await tx.query("update sagaops.fulfillment_tickets set status='cancelled',updated_at=$1 where order_id=$2 and status in ('new','in_progress')", [transitionAt, orderId]);
        const hppCatalogRevision = hppCatalogMutation
          ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId })
          : null;
        await this.#appendAudit(tx, { organizationId, outletId, actorReference,occurredAt:transitionAt }, orderId, "order.refund.requested", refund);
        await this.faultInjector('before_refund_commit',{tx,orderId,refund});
        return { status:refund.status,refund, mutatesGatewayPayment: false, hppCatalogRevision };
      }
      let cashRefund = null;
      if (current.method_type === 'cash') {
        const shift=(await tx.query("select status from sagaops.cash_sessions where id=$1 and organization_id=$2 and outlet_id=$3 for update",[cashSessionId,organizationId,outletId])).rows[0];
        if (shift?.status !== 'open') throw repositoryError('cash_refund_open_session_required',409);
      }
      if (current.method_type === "cash" && this.requiresEsbCatalogSnapshot()) {
        if (!cashSessionId) throw new Error("cash_refund_open_session_required");
        const activeShift = (await tx.query(
          `select id,business_date,status from sagaops.cash_sessions
            where organization_id=$1 and outlet_id=$2 and id=$3 for update`,
          [organizationId, outletId, cashSessionId],
        )).rows[0];
        if (!activeShift || activeShift.status !== "open") throw new Error("cash_refund_open_session_required");
        const paymentAttempt = (await tx.query(
          `select id from sagaops.esb_payment_attempts
            where id=$1 and organization_id=$2 and outlet_id=$3`,
          [current.payment_id, organizationId, outletId],
        )).rows[0];
        cashRefund = {
          cashSessionId: activeShift.id,
          businessDate: activeShift.business_date,
          paymentAttemptId: paymentAttempt?.id ?? null,
          occurredAt: transitionAt,
        };
      }
      if (plan.full) {
        await tx.query("update sagaops.orders set status='refunded',updated_at=$1 where id=$2", [transitionAt, orderId]);
        await tx.query("update sagaops.payments set status='refunded',updated_at=$1 where id=$2", [transitionAt, current.payment_id]);
        await tx.query("update sagaops.fulfillment_tickets set status='cancelled',updated_at=$1 where order_id=$2 and status in ('new','in_progress')", [transitionAt, orderId]);
      }
      if (cashRefund && refund.amountRupiah > 0) {
        await tx.query(
          `insert into sagaops.esb_cash_movements
            (id,organization_id,outlet_id,cash_session_id,payment_attempt_id,movement_type,amount_rupiah,business_date,occurred_at,note)
           values ($1,$2,$3,$4,$5,'REFUND',$6,$7,$8,$9)`,
          [deterministicEsbUuid(`cash-refund:${organizationId}:${orderId}:${plan.operationKey}`), organizationId, outletId,
            cashRefund.cashSessionId, cashRefund.paymentAttemptId, -refund.amountRupiah, cashRefund.businessDate,
            cashRefund.occurredAt, cashRefund.paymentAttemptId
              ? `SagaPOS durable cash refund for ESB payment ${current.payment_id}`
              : `SagaPOS durable cash refund for legacy payment ${current.payment_id}`],
        );
      }
      const hppCatalogRevision = hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId })
        : null;
      await this.#appendOutbox(tx, { organizationId, outletId }, orderId, "pos.order.refunded", {refundId:refund.id,amountRupiah:refund.amountRupiah,full:refund.full});
      await this.#appendAudit(tx, { organizationId, outletId, actorReference,occurredAt:transitionAt }, orderId, "order.refunded", refund);
      await this.faultInjector('before_refund_commit',{tx,orderId,refund});
      return { status:refund.status,refund,mutatesGatewayPayment: false, hppCatalogRevision };
    });
  }

  async persistRemakeQueue({ organizationId, outletId, remake } = {}) {
    if (!organizationId || !outletId) throw remakeQueueError("remake_queue_scope_required", 422);
    const fact = validateRemakeQueueFact(remake);
    const auditId = deterministicEsbUuid(`pos-remake-queue:${organizationId}:${outletId}:${fact.queueIdempotencyKey}`);
    return this.db.transaction(async (tx) => {
      const current = (await tx.query(
        "select id,status from sagaops.orders where id=$1 and organization_id=$2 and outlet_id=$3 for update",
        [fact.orderId, organizationId, outletId],
      )).rows[0];
      if (!current) throw remakeQueueError("order_not_found", 404);

      const existing = (await tx.query(
        "select event_type,aggregate_type,aggregate_id,actor_reference,correlation_id,payload_redacted,occurred_at from sagaops.pos_audit_events where id=$1 and organization_id=$2 and outlet_id=$3",
        [auditId, organizationId, outletId],
      )).rows[0];
      if (existing) return replayRemakeQueue(existing, fact);
      if (!["paid", "completed"].includes(current.status)) throw remakeQueueError("order_not_remakeable", 409);

      const payload = remakeQueueAuditPayload(fact);
      const inserted = await tx.query([
        "insert into sagaops.pos_audit_events(id,organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,correlation_id,payload_redacted,occurred_at)",
        "values ($1,$2,$3,$4,'order.remake.queued','remake',$5,$6,$7::jsonb,$8)",
        "on conflict (id) do nothing",
        "returning event_type,aggregate_type,aggregate_id,actor_reference,correlation_id,payload_redacted,occurred_at",
      ].join(" "), [auditId, organizationId, outletId, fact.actorId, fact.id, fact.queueIdempotencyKey, JSON.stringify(payload), fact.createdAt]);
      if (!inserted.rows[0]) {
        const raced = (await tx.query(
          "select event_type,aggregate_type,aggregate_id,actor_reference,correlation_id,payload_redacted,occurred_at from sagaops.pos_audit_events where id=$1 and organization_id=$2 and outlet_id=$3",
          [auditId, organizationId, outletId],
        )).rows[0];
        if (!raced) throw remakeQueueError("remake_queue_persistence_conflict", 409);
        return replayRemakeQueue(raced, fact);
      }
      await this.faultInjector("before_remake_queue_commit", { tx, orderId: fact.orderId, remakeId: fact.id });
      return { remake: remakeQueueFactFromAudit(inserted.rows[0]), idempotentReplay: false };
    });
  }

  async createCheckout(input = {}) {
    if (input.organizationId && input.outletId && input.createdAt) {
      input = { ...input, businessDate: await this.#authoritativeBusinessDate(input) };
    }
    validateCheckout(input);
    if (this.requiresEsbCatalogSnapshot() && !input.esbCatalogPricingSnapshot) throw new Error("esb_catalog_pricing_snapshot_required");
    if (input.esbSplitBillPlan != null && !this.requiresEsbCatalogSnapshot()) throw new Error("esb_split_bill_requires_dual_write");
    const paxCount = input.paxCount == null ? 1 : input.paxCount;
    if (!Number.isSafeInteger(paxCount) || paxCount < 1 || paxCount > 1000) throw new Error("checkout_pax_count_invalid");
    if (input.esbSplitBillPlan != null && input.esbSplitBillPlan.paxCount !== paxCount) throw new Error("esb_split_bill_pax_mismatch");
    const splitPlanFingerprint = esbSplitBillPlanFingerprint(input.esbSplitBillPlan);
    const paymentPlanFingerprint = esbPaymentPlanFingerprint(input.esbPaymentPlan);
    const checkoutRequestFingerprint = splitPlanFingerprint || paymentPlanFingerprint
      ? createHash("sha256").update(`${input.requestFingerprint}:${splitPlanFingerprint ?? "none"}:${paymentPlanFingerprint ?? "none"}`).digest("hex")
      : input.requestFingerprint;
    return this.db.transaction(async (tx) => {
      const promotion = input.benefitSnapshot?.promotion;
      if (promotion?.quotaLimit != null) {
        if (!Number.isSafeInteger(promotion.quotaLimit) || promotion.quotaLimit<1 || typeof promotion.code!=="string") throw new Error("promotion_quota_invalid");
        await tx.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [input.organizationId+":"+input.outletId,promotion.code]);
      }
      if(promotion?.perMemberLimit != null) {
        if(!input.memberReference || !Number.isSafeInteger(promotion.perMemberLimit) || promotion.perMemberLimit<1)throw Object.assign(new Error('promotion_verified_member_required'),{status:409});
        await tx.query('select pg_advisory_xact_lock(hashtext($1),hashtext($2))',[input.organizationId+':'+input.outletId,`member:${promotion.campaignId ?? promotion.id}:${input.memberReference}`]);
      }
      const replay = await tx.query(this.requiresEsbCatalogSnapshot() ? [
        "select o.id,o.order_number,o.request_fingerprint,",
        "(select b.pricing_policy_snapshot->'splitBill'->>'planFingerprint' from sagaops.esb_bills b where b.order_id=o.id order by b.bill_number limit 1) split_plan_fingerprint",
        "from sagaops.orders o",
        "where organization_id=$1 and outlet_id=$2 and channel=$3 and idempotency_key=$4",
      ].join(" ") : [
        "select o.id,o.order_number,o.request_fingerprint,null::text split_plan_fingerprint from sagaops.orders o",
        "where organization_id=$1 and outlet_id=$2 and channel=$3 and idempotency_key=$4",
      ].join(" "), [input.organizationId, input.outletId, input.channel.toLowerCase(), input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_fingerprint !== checkoutRequestFingerprint || (replay.rows[0].split_plan_fingerprint ?? null) !== splitPlanFingerprint) throw new Error("idempotency_payload_conflict");
        if (input.channel === "CASHIER" && input.payment.methodType === "cash") {
          const stored = (await tx.query("select method_type,amount_rupiah,received_rupiah,change_rupiah from sagaops.payments where order_id=$1", [replay.rows[0].id])).rows[0];
          if (!stored || stored.method_type !== "cash"
            || Number(stored.amount_rupiah) !== input.payment.amountRupiah
            || Number(stored.received_rupiah) !== input.payment.receivedRupiah
            || Number(stored.change_rupiah) !== input.payment.changeRupiah) {
            throw new Error("cashier_cash_confirmation_conflict");
          }
        }
        return this.#aggregateReference(tx, replay.rows[0].id, true);
      }

      if (promotion?.id) {
        const catalog=(await tx.query("select snapshot from sagaops.pos_catalog_state where organization_id=$1 and outlet_id=$2 for share",[input.organizationId,input.outletId])).rows[0]?.snapshot;
        const rules=catalog?.publishedSnapshot?.promotionRules??catalog?.promotionRules??[];
        const rule=rules.find(rule=>rule.id===promotion.id);
        if(!rule || promotionEffectiveState(rule,this.clock().toISOString())!=="EFFECTIVE" || rule.version!==promotion.version || rule.code!==promotion.code || (rule.quotaLimit??null)!==promotion.quotaLimit || (rule.campaignId??null)!==(promotion.campaignId??null) || (rule.perMemberLimit??null)!==(promotion.perMemberLimit??null)) {const error=new Error("cashier_quote_changed");error.code=error.message;error.status=409;throw error;}
      }
      const manual = input.benefitSnapshot?.manual;
      if (manual?.staffLimitRupiah != null) {
        const catalog = (await tx.query('select snapshot from sagaops.pos_catalog_state where organization_id=$1 and outlet_id=$2 for share', [input.organizationId,input.outletId])).rows[0]?.snapshot;
        const limit = catalog?.manualDiscountStaffLimitRupiah ?? 0;
        if (manual.actorId !== input.actorReference) throw new Error('manual_discount_actor_conflict');
        if (input.catalogVersion !== (catalog?.publishedSnapshot?.version ?? catalog?.version)) throw Object.assign(new Error('cashier_quote_changed'),{status:409});
        if (manual.authorizationId) {
          await consumeAuthorization(tx, {...input, id:manual.authorizationId, action:'cashier:discount', resourceType:'cashier_cart', resourceId:manual.resourceId, actorReference:input.actorReference, operationKey:manual.operationKey, occurredAt:this.clock().toISOString()});
        } else if (input.discountRupiah > limit) throw Object.assign(new Error('manual_discount_approval_required'),{status:409});
      }
      if (promotion?.quotaLimit != null) {
        // Quota admission and checkout audit commit share this same transaction.
        const usage = await tx.query(`select count(*)::integer as used from sagaops.pos_audit_events a
          join sagaops.orders o on o.id=a.aggregate_id and o.organization_id=a.organization_id and o.outlet_id=a.outlet_id
          where a.organization_id=$1 and a.outlet_id=$2 and a.event_type='pos.checkout.created'
          and a.payload_redacted->'benefitSnapshot'->'promotion'->>'code'=$3
          and (o.status in ('paid','refunded') or not exists (select 1 from sagaops.payments p where p.order_id=o.id) or exists (select 1 from sagaops.payments p where p.order_id=o.id and p.status not in ('failed','expired','cancelled')))`,
          [input.organizationId,input.outletId,promotion.code]);
        if (Number(usage.rows[0]?.used ?? 0)>=promotion.quotaLimit) {
          const error = new Error("promotion_quota_exhausted"); error.status=409; error.code=error.message; throw error;
        }
      }
      if(promotion?.perMemberLimit != null) {
        const usage=await tx.query(`select count(*)::int used from sagaops.pos_audit_events a join sagaops.orders o
          on o.id=a.aggregate_id and o.organization_id=a.organization_id and o.outlet_id=a.outlet_id
          where a.organization_id=$1 and a.outlet_id=$2 and a.event_type='pos.checkout.created'
          and coalesce(a.payload_redacted->'benefitSnapshot'->'promotion'->>'campaignId',a.payload_redacted->'benefitSnapshot'->'promotion'->>'id')=$3
          and o.member_reference=$4 and (o.status in ('paid','refunded') or not exists(select 1 from sagaops.payments p where p.order_id=o.id)
          or exists(select 1 from sagaops.payments p where p.order_id=o.id and p.status not in ('failed','expired','cancelled')))`,[input.organizationId,input.outletId,promotion.campaignId??promotion.id,input.memberReference]);
        if(Number(usage.rows[0].used)>=promotion.perMemberLimit)throw Object.assign(new Error('promotion_member_limit_reached'),{status:409});
      }
      const counter = await tx.query([
        "insert into sagaops.pos_order_counters(organization_id,outlet_id,business_date,next_value)",
        "values ($1,$2,$3,1)",
        "on conflict (outlet_id,business_date) do update set next_value=sagaops.pos_order_counters.next_value+1,updated_at=now()",
        "returning next_value",
      ].join(" "), [input.organizationId, input.outletId, input.businessDate]);
      const orderNumber = `KS-${String(counter.rows[0].next_value).padStart(3, "0")}`;
      const orderId = input.orderId ?? randomUUID();
      const paymentId = input.payment.id ?? randomUUID();
      const paid = input.payment.status.toLowerCase() === "paid";
      const persistedItems = input.items.map((item) => ({
        ...item,
        id: item.id ?? randomUUID(),
        recipeSnapshot: persistSaleCostQuality(item),
      }));

      const orderValues = [
        orderId, input.organizationId, input.outletId, input.cashSessionId ?? null, orderNumber,
        input.orderType.toLowerCase(), paid ? "paid" : "draft", input.subtotalRupiah, input.discountRupiah,
        input.taxRupiah, input.serviceRupiah, input.roundingRupiah, input.totalRupiah, input.totalHppRupiah ?? 0,
        String(input.hppSnapshotStatus ?? "UNVERIFIED").toLowerCase(),
        paid ? input.payment.paidAt ?? this.clock().toISOString() : null, input.businessDate, input.cashierUserId ?? null,
        input.channel.toLowerCase(), input.idempotencyKey, checkoutRequestFingerprint, input.kioskSessionId ?? null,
        input.catalogVersion ?? null, input.memberId ?? null, input.policyStatus ?? null,
      ];
      if (this.requiresEsbCatalogSnapshot()) {
        await tx.query([
          "insert into sagaops.orders(",
          "id,organization_id,outlet_id,cash_session_id,order_number,order_type,status,subtotal_rupiah,discount_rupiah,tax_rupiah,service_rupiah,rounding_rupiah,total_rupiah,total_hpp_rupiah,hpp_snapshot_status,paid_at,business_date,cashier_user_id,channel,idempotency_key,request_fingerprint,kiosk_session_id,catalog_version,member_id,policy_status,pax_count,created_at,updated_at)",
          "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$27)",
        ].join(" "), [...orderValues, paxCount, input.createdAt ?? this.clock().toISOString()]);
      } else {
        await tx.query([
          "insert into sagaops.orders(",
          "id,organization_id,outlet_id,cash_session_id,order_number,order_type,status,subtotal_rupiah,discount_rupiah,tax_rupiah,service_rupiah,rounding_rupiah,total_rupiah,total_hpp_rupiah,hpp_snapshot_status,paid_at,business_date,cashier_user_id,channel,idempotency_key,request_fingerprint,kiosk_session_id,catalog_version,member_id,policy_status,created_at,updated_at)",
          "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26)",
        ].join(" "), [...orderValues, input.createdAt ?? this.clock().toISOString()]);
      }
      await this.faultInjector("after_order_insert", { tx, orderId });
      await tx.query("update sagaops.orders set member_reference=$1,cashier_reference=$2 where id=$3", [input.memberReference ?? null, input.cashierReference ?? input.actorReference ?? null, orderId]);

      for (const item of persistedItems) {
        await tx.query([
          "insert into sagaops.order_items(id,order_id,product_name_snapshot,qty,unit_price_rupiah,line_total_rupiah,recipe_cost_snapshot_rupiah,hpp_snapshot_status,recipe_version_snapshot,recipe_snapshot_json,note,modifier_snapshot,product_reference_snapshot,station_snapshot)",
          "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14)",
        ].join(" "), [
          item.id ?? randomUUID(), orderId, item.productName, item.qty, item.unitPriceRupiah,
          item.lineTotalRupiah, item.recipeCostRupiah ?? 0, String(item.hppSnapshotStatus ?? "UNVERIFIED").toLowerCase(),
          item.recipeVersionSnapshot ?? item.recipeSnapshot?.recipeVersion ?? null, JSON.stringify(item.recipeSnapshot ?? {}),
          item.note ?? null, JSON.stringify(item.modifiers ?? []), item.productReference ?? null, item.station ?? "bar",
        ]);
      }

      const methodType = input.payment.methodType.toLowerCase();
      await tx.query([
        "insert into sagaops.payments(id,order_id,method_name_snapshot,method_type,status,amount_rupiah,received_rupiah,change_rupiah,reference_number,paid_at,idempotency_key,provider,provider_reference,settlement_status,created_at,updated_at)",
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)",
      ].join(" "), [
        paymentId, orderId, input.payment.methodName, methodType, input.payment.status.toLowerCase(),
        input.payment.amountRupiah, input.payment.receivedRupiah ?? input.payment.amountRupiah,
        input.payment.changeRupiah ?? 0, input.payment.referenceNumber ?? null,
        paid ? input.payment.paidAt ?? this.clock().toISOString() : null, input.payment.idempotencyKey,
        input.payment.provider ?? null, input.payment.providerReference ?? null,
        input.payment.settlementStatus ?? (methodType === "cash" ? "settled" : methodType === "none" ? "not_applicable" : "unchecked"),
        input.createdAt ?? this.clock().toISOString(),
      ]);

      if (methodType === "qris_dynamic") {
        await tx.query([
          "insert into sagaops.payment_intents(id,organization_id,outlet_id,order_id,provider,provider_product_code,provider_reference,amount_rupiah,status,idempotency_key,expires_at,paid_at,gateway_mode,settlement_status,created_at,updated_at)",
          "values ($1,$2,$3,$4,'sagadev_gateway','sagaops',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)",
        ].join(" "), [
          input.payment.intentId ?? randomUUID(), input.organizationId, input.outletId, orderId,
          input.payment.providerReference ?? null, input.payment.amountRupiah, input.payment.status.toLowerCase(),
          input.payment.idempotencyKey, input.payment.expiresAt ?? null, paid ? input.payment.paidAt ?? this.clock().toISOString() : null,
          input.payment.gatewayMode ?? "local_durable_contract", input.payment.settlementStatus ?? "unchecked",
          input.createdAt ?? this.clock().toISOString(),
        ]);
      }

      const esbProjection = this.requiresEsbCatalogSnapshot()
        ? await persistEsbCheckoutDualWrite({
            tx,
            input,
            orderId,
            orderNumber,
            paymentId,
            persistedItems,
            now: input.createdAt ?? this.clock().toISOString(),
          })
        : null;
      if (esbProjection) await this.faultInjector("after_esb_checkout_dual_write", { tx, orderId, paymentId, esbProjection });

      if (paid) await this.#ensureFulfillment(tx, { ...input, orderId, orderNumber });
      const hppCatalogRevision = input.hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...input.hppCatalogMutation, organizationId: input.organizationId, outletId: input.outletId })
        : null;
      await this.#appendOutbox(tx, input, orderId, paid ? "pos.order.paid" : "pos.order.payment_pending");
      await this.#appendAudit(tx, input, orderId, "pos.checkout.created", {
        orderNumber, channel: input.channel, paymentStatus: input.payment.status,
        checkoutFingerprint: input.checkoutFingerprint ?? null,
        rewardCommit: input.rewardCommit ?? null,
        benefitSnapshot: input.benefitSnapshot ?? null,
        pricingPolicySnapshot: input.pricingPolicySnapshot ?? null,
      });
      if (input.kioskSessionId) {
        await tx.query("update sagaops.kiosk_sessions set active_order_id=$1,updated_at=$2 where id=$3", [orderId, this.clock().toISOString(), input.kioskSessionId]);
      }
      await this.faultInjector("before_checkout_commit", { tx, orderId, paymentId });
      return { idempotentReplay: false, orderId, orderNumber, paymentId, businessDate: input.businessDate, hppCatalogRevision, esbProjection };
    });
  }

  async markGatewayPaid({ organizationId, outletId, paymentId, providerEventKey, eventFingerprint, paidAt = this.clock().toISOString(), hppCatalogMutation = null } = {}) {
    for (const [key, value] of Object.entries({ organizationId, outletId, paymentId, providerEventKey, eventFingerprint })) if (!value) throw new Error(`${key}_required`);
    return this.db.transaction(async (tx) => {
      const replay = await tx.query([
        "select event_fingerprint from sagaops.pos_provider_events",
        "where organization_id=$1 and provider='sagadev_gateway' and provider_event_key=$2",
      ].join(" "), [organizationId, providerEventKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].event_fingerprint !== eventFingerprint) throw new Error("provider_event_mutation_denied");
        const reference = await this.#paymentReference(tx, paymentId);
        return { ...reference, idempotentReplay: true };
      }

      const current = await this.#paymentReference(tx, paymentId);
      if (current.organization_id !== organizationId || current.outlet_id !== outletId) throw new Error("payment_scope_denied");
      if (!['pending','paid'].includes(current.payment_status)) throw new Error("payment_not_pending");
      await tx.query([
        "insert into sagaops.pos_provider_events(organization_id,outlet_id,provider,provider_event_key,payment_id,event_type,event_fingerprint,received_at)",
        "values ($1,$2,'sagadev_gateway',$3,$4,'payment.paid',$5,$6)",
      ].join(" "), [organizationId, outletId, providerEventKey, paymentId, eventFingerprint, paidAt]);
      if (current.payment_status === "paid") return { ...current, idempotentReplay: true };

      await tx.query("update sagaops.payments set status='paid',paid_at=$1,updated_at=$1 where id=$2", [paidAt, paymentId]);
      await tx.query("update sagaops.orders set status='paid',paid_at=$1,updated_at=$1 where id=$2", [paidAt, current.order_id]);
      await tx.query("update sagaops.payment_intents set status='paid',paid_at=$1,updated_at=$1 where order_id=$2", [paidAt, current.order_id]);
      if (this.requiresEsbCatalogSnapshot()) {
        await persistEsbGatewayPaidDualWrite({ tx, organizationId, outletId, paymentId, providerEventKey, paidAt });
        await this.faultInjector("after_esb_gateway_paid_dual_write", { tx, orderId: current.order_id, paymentId });
      }
      await this.#ensureFulfillment(tx, {
        organizationId, outletId, orderId: current.order_id, orderNumber: current.order_number,
        items: current.items ?? [], createdAt: paidAt,
      });
      const hppCatalogRevision = hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId })
        : null;
      await this.#appendOutbox(tx, { organizationId, outletId, correlationId: providerEventKey }, current.order_id, "pos.payment.paid");
      await this.#appendAudit(tx, { organizationId, outletId, actorReference: "sagadev_gateway", correlationId: providerEventKey }, current.order_id, "payment.gateway.paid", { providerEventFingerprint: eventFingerprint });
      return { ...await this.#paymentReference(tx, paymentId), idempotentReplay: false, hppCatalogRevision };
    });
  }

  async markGatewayTerminal({organizationId,outletId,paymentId,status,providerEventKey,eventFingerprint}) {
    if(!['FAILED','EXPIRED','CANCELLED'].includes(status) || !providerEventKey || !eventFingerprint)throw new Error('payment_terminal_invalid');
    return this.db.transaction(async tx=>{
      const current=await this.#paymentReference(tx,paymentId);
      if(current.organization_id!==organizationId || current.outlet_id!==outletId)throw new Error('payment_scope_denied');
      const replay=(await tx.query("select payment_id,event_fingerprint,event_type from sagaops.pos_provider_events where organization_id=$1 and provider='sagadev_gateway' and provider_event_key=$2",[organizationId,providerEventKey])).rows[0];
      if(replay){
        if(replay.payment_id!==paymentId || replay.event_fingerprint!==eventFingerprint || replay.event_type!==`payment.${status.toLowerCase()}`)throw new Error('provider_event_mutation_denied');
        return {...current,idempotentReplay:true};
      }
      if(current.payment_status===status.toLowerCase())return {...current,idempotentReplay:true};
      if(current.payment_status!=='pending')throw new Error('payment_not_pending');
      const occurredAt=this.clock().toISOString();
      await tx.query("insert into sagaops.pos_provider_events(organization_id,outlet_id,provider,provider_event_key,payment_id,event_type,event_fingerprint,received_at) values($1,$2,'sagadev_gateway',$3,$4,$5,$6,$7)",[organizationId,outletId,providerEventKey,paymentId,`payment.${status.toLowerCase()}`,eventFingerprint,occurredAt]);
      await tx.query('update sagaops.payments set status=$1,updated_at=$2 where id=$3',[status.toLowerCase(),occurredAt,paymentId]);
      await tx.query('update sagaops.payment_intents set status=$1,updated_at=$2 where order_id=$3',[status.toLowerCase(),occurredAt,current.order_id]);
      if(this.requiresEsbCatalogSnapshot()) {
        await persistEsbGatewayPaidDualWrite({tx,organizationId,outletId,paymentId,providerEventKey,paidAt:occurredAt,status});
        await this.faultInjector('after_esb_gateway_terminal_dual_write',{tx,paymentId});
      }
      await this.#appendAudit(tx,{organizationId,outletId,actorReference:'VERIFIED_PROVIDER',aggregateType:'payment'},paymentId,'payment.terminal.confirmed',{status,providerEventKey});
      return {...current,payment_status:status.toLowerCase(),idempotentReplay:false};
    });
  }

  async confirmAssistedCash({ organizationId, outletId, paymentId, cashSessionId, actorReference, receivedRupiah, changeRupiah, paidAt = this.clock().toISOString(), hppCatalogMutation = null } = {}) {
    for (const [key, value] of Object.entries({ organizationId, outletId, paymentId, cashSessionId, actorReference })) if (!value) throw new Error(`${key}_required`);
    if (!Number.isSafeInteger(receivedRupiah) || receivedRupiah < 0 || !Number.isSafeInteger(changeRupiah) || changeRupiah < 0) throw new Error("cash_tender_invalid");
    return this.db.transaction(async (tx) => {
      const current = (await tx.query([
        "select p.id payment_id,p.status payment_status,p.method_type,p.amount_rupiah,p.received_rupiah,p.change_rupiah,",
        "o.id order_id,o.order_number,o.organization_id,o.outlet_id,o.channel,o.cash_session_id",
        "from sagaops.payments p join sagaops.orders o on o.id=p.order_id where p.id=$1 for update",
      ].join(" "), [paymentId])).rows[0];
      if (!current) throw new Error("assisted_cash_payment_not_found");
      if (current.organization_id !== organizationId || current.outlet_id !== outletId || String(current.channel).toLowerCase() !== "kiosk" || String(current.method_type).toLowerCase() !== "cash") throw new Error("payment_scope_denied");
      if (current.cash_session_id !== cashSessionId) throw new Error("cash_session_scope_denied");
      if (receivedRupiah < Number(current.amount_rupiah) || changeRupiah !== receivedRupiah - Number(current.amount_rupiah)) throw new Error("cash_tender_invalid");
      if (String(current.payment_status).toLowerCase() === "paid") {
        if (Number(current.received_rupiah) !== receivedRupiah || Number(current.change_rupiah) !== changeRupiah) throw new Error("assisted_cash_confirmation_conflict");
        return { ...current, idempotentReplay: true };
      }
      if (String(current.payment_status).toLowerCase() !== "pending") throw new Error("payment_not_pending");
      const shift = (await tx.query(
        "select id from sagaops.cash_sessions where id=$1 and organization_id=$2 and outlet_id=$3 and status='open' for update",
        [cashSessionId, organizationId, outletId],
      )).rows[0];
      if (!shift) throw new Error("cash_session_open_required");
      await tx.query("update sagaops.payments set status='paid',received_rupiah=$1,change_rupiah=$2,settlement_status='settled',paid_at=$3,updated_at=$3 where id=$4", [receivedRupiah, changeRupiah, paidAt, paymentId]);
      await tx.query("update sagaops.orders set status='paid',paid_at=$1,cash_session_id=$2,cashier_reference=$3,updated_at=$1 where id=$4", [paidAt, cashSessionId, actorReference, current.order_id]);
      if (this.requiresEsbCatalogSnapshot()) {
        await persistEsbAssistedCashPaid({ tx, organizationId, outletId, paymentId, cashSessionId, receivedRupiah, changeRupiah, paidAt });
      }
      await this.#ensureFulfillment(tx, { organizationId, outletId, orderId: current.order_id, orderNumber: current.order_number, createdAt: paidAt });
      const hppCatalogRevision = hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId })
        : null;
      await this.#appendOutbox(tx, { organizationId, outletId, correlationId: paymentId }, current.order_id, "pos.payment.cash_assisted.paid");
      await this.#appendAudit(tx, { organizationId, outletId, actorReference, correlationId: paymentId }, current.order_id, "payment.cash_assisted.paid", { paymentId, receivedRupiah, changeRupiah, staffConfirmed: true });
      return { ...await this.#paymentReference(tx, paymentId), idempotentReplay: false, hppCatalogRevision };
    });
  }

  async confirmManualQrisPaid({ organizationId, outletId, paymentId, actorReference, merchantReference,
    observedAmountRupiah, paidAt = this.clock().toISOString(), hppCatalogMutation = null } = {}) {
    for (const [key, value] of Object.entries({ organizationId, outletId, paymentId, actorReference, merchantReference })) if (!value) throw new Error(`${key}_required`);
    const reference = String(merchantReference).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._/-]{5,79}$/.test(reference)) throw new Error("merchant_qris_reference_invalid");
    if (!Number.isSafeInteger(observedAmountRupiah) || observedAmountRupiah <= 0) throw new Error("merchant_qris_amount_invalid");
    const eventKey = createHash("sha256").update(`${organizationId}:${reference}`).digest("hex");
    const fingerprint = createHash("sha256").update(`${paymentId}:${observedAmountRupiah}:${eventKey}`).digest("hex");
    return this.db.transaction(async (tx) => {
      const current = (await tx.query(`select p.status payment_status,p.method_type,p.amount_rupiah,
        o.id order_id,o.order_number,o.organization_id,o.outlet_id,o.channel
        from sagaops.payments p join sagaops.orders o on o.id=p.order_id where p.id=$1 for update`, [paymentId])).rows[0];
      if (!current) throw new Error("manual_qris_payment_not_found");
      if (current.organization_id !== organizationId || current.outlet_id !== outletId
        || !["kiosk", "table", "cashier"].includes(String(current.channel).toLowerCase())
        || String(current.method_type).toLowerCase() !== "qris_manual") throw new Error("payment_scope_denied");
      const replay = (await tx.query(`select payment_id,event_fingerprint from sagaops.pos_provider_events
        where organization_id=$1 and provider='merchant_qris_manual' and provider_event_key=$2`, [organizationId, eventKey])).rows[0];
      if (replay) {
        if (String(replay.payment_id) !== paymentId || replay.event_fingerprint !== fingerprint) throw new Error("merchant_qris_reference_reused");
        return { ...await this.#paymentReference(tx, paymentId), idempotentReplay: true };
      }
      if (Number(current.amount_rupiah) !== observedAmountRupiah) throw new Error("merchant_qris_amount_mismatch");
      if (String(current.payment_status).toLowerCase() !== "pending") throw new Error("payment_not_pending");
      await tx.query(`insert into sagaops.pos_provider_events
        (organization_id,outlet_id,provider,provider_event_key,payment_id,event_type,event_fingerprint,received_at)
        values ($1,$2,'merchant_qris_manual',$3,$4,'cashier.confirmed',$5,$6)`,
      [organizationId, outletId, eventKey, paymentId, fingerprint, paidAt]);
      await tx.query(`update sagaops.payments set status='paid',paid_at=$1,reference_number=$2,
        settlement_status='unchecked',updated_at=$1 where id=$3`, [paidAt, reference, paymentId]);
      await tx.query(`update sagaops.orders set status='paid',paid_at=$1,cashier_reference=case when channel='cashier' then cashier_reference else $2 end,updated_at=$1 where id=$3`,
        [paidAt, actorReference, current.order_id]);
      await this.#ensureFulfillment(tx, { organizationId, outletId, orderId: current.order_id,
        orderNumber: current.order_number, createdAt: paidAt });
      const hppCatalogRevision = hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId, outletId }) : null;
      await this.#appendOutbox(tx, { organizationId, outletId, correlationId: eventKey }, current.order_id,
        "pos.payment.qris_manual.staff_confirmed");
      await this.#appendAudit(tx, { organizationId, outletId, actorReference, correlationId: eventKey },
        current.order_id, "payment.qris_manual.staff_confirmed", { paymentId, observedAmountRupiah,
          merchantReferenceHash: eventKey, settlementStatus: "unchecked" });
      return { ...await this.#paymentReference(tx, paymentId), idempotentReplay: false, hppCatalogRevision };
    });
  }

  async recordPaymentSettlementReview({
    organizationId,
    outletId,
    paymentId,
    actorReference,
    decision,
    expectedStatus,
    providerFeeRupiah,
    netSettlementRupiah,
    evidenceReference,
    reason,
  } = {}) {
    for (const [key, value] of Object.entries({ organizationId, outletId, paymentId, actorReference })) if (!value) throw new Error(`${key}_required`);
    const normalizedDecision = String(decision ?? "").trim().toUpperCase();
    const normalizedExpected = String(expectedStatus ?? "").trim().toLowerCase();
    const evidence = String(evidenceReference ?? "").trim();
    const normalizedReason = String(reason ?? "").trim();
    const fee = Number(providerFeeRupiah);
    const net = Number(netSettlementRupiah);
    if (!["SETTLED", "ISSUE"].includes(normalizedDecision)) throw new Error("settlement_decision_invalid");
    if (!normalizedExpected) throw new Error("settlement_expected_status_required");
    if (evidence.length < 4 || evidence.length > 120) throw new Error("settlement_evidence_reference_invalid");
    if (normalizedReason.length < 8 || normalizedReason.length > 300) throw new Error("settlement_reason_invalid");
    if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(net) || net < 0) throw new Error("settlement_amount_invalid");
    const evidenceHash = createHash("sha256").update(evidence).digest("hex");
    const targetStatus = normalizedDecision === "SETTLED" ? "settled" : "issue";
    const intentStatus = normalizedDecision === "SETTLED" ? "reconciled" : "mismatch";
    return this.db.transaction(async (tx) => {
      const current = (await tx.query([
        "select p.id payment_id,p.order_id,p.status payment_status,p.method_type,p.amount_rupiah,p.settlement_status,",
        "o.organization_id,o.outlet_id,pi.id payment_intent_id,pi.provider_fee_rupiah intent_fee_rupiah,pi.net_settlement_rupiah,",
        "pi.settlement_status intent_settlement_status",
        "from sagaops.payments p join sagaops.orders o on o.id=p.order_id",
        "join sagaops.payment_intents pi on pi.order_id=o.id",
        "where p.id=$1 for update",
      ].join(" "), [paymentId])).rows[0];
      if (!current) throw new Error("payment_not_found");
      if (current.organization_id !== organizationId || current.outlet_id !== outletId) throw new Error("payment_scope_denied");
      if (String(current.payment_status).toLowerCase() !== "paid") throw new Error("payment_not_paid");
      if (["cash", "none"].includes(String(current.method_type).toLowerCase())) throw new Error("payment_settlement_not_applicable");
      if (!current.payment_intent_id) throw new Error("gateway_payment_intent_not_found");
      const amount = Number(current.amount_rupiah);
      if (fee + net > amount) throw new Error("settlement_amount_invalid");
      const varianceRupiah = amount - fee - net;
      if (targetStatus === "settled" && varianceRupiah !== 0) throw new Error("settlement_balance_mismatch");
      const priorAudit = (await tx.query([
        "select payload_redacted from sagaops.pos_audit_events",
        "where organization_id=$1 and outlet_id=$2 and aggregate_type='payment' and aggregate_id=$3 and event_type='payment.settlement.reviewed'",
        "order by occurred_at desc limit 1",
      ].join(" "), [organizationId, outletId, paymentId])).rows[0]?.payload_redacted;
      const sameReview = String(current.settlement_status).toLowerCase() === targetStatus
        && Number(current.intent_fee_rupiah ?? 0) === fee
        && Number(current.net_settlement_rupiah ?? 0) === net
        && priorAudit?.evidenceHash === evidenceHash
        && priorAudit?.reason === normalizedReason;
      if (sameReview) return { paymentId, settlementStatus: targetStatus, providerFeeRupiah: fee, netSettlementRupiah: net, varianceRupiah, evidenceHash, idempotentReplay: true };
      if (String(current.settlement_status).toLowerCase() !== normalizedExpected) throw new Error("settlement_status_conflict");
      const reviewedAt = this.clock().toISOString();
      await tx.query("update sagaops.payments set settlement_status=$1,updated_at=$2 where id=$3", [targetStatus, reviewedAt, paymentId]);
      await tx.query("update sagaops.payment_intents set settlement_status=$1,provider_fee_rupiah=$2,net_settlement_rupiah=$3,updated_at=$4 where id=$5", [intentStatus, fee, net, reviewedAt, current.payment_intent_id]);
      await this.#appendAudit(tx, {
        organizationId,
        outletId,
        actorReference,
        aggregateType: "payment",
        correlationId: evidenceHash,
      }, paymentId, "payment.settlement.reviewed", {
        decision: normalizedDecision,
        providerFeeRupiah: fee,
        netSettlementRupiah: net,
        varianceRupiah,
        evidenceHash,
        reason: normalizedReason,
      });
      return { paymentId, settlementStatus: targetStatus, providerFeeRupiah: fee, netSettlementRupiah: net, varianceRupiah, evidenceHash, reviewedAt, reviewedBy: actorReference, idempotentReplay: false };
    });
  }

  async #authoritativeBusinessDate(input) {
    const result = await this.db.query(
      `select timezone,coalesce(to_jsonb(outlets)->>'business_date_cutoff_local','04:00:00') cutoff
         from sagaops.outlets where organization_id=$1 and id=$2`,
      [input.organizationId, input.outletId],
    );
    const outlet = result.rows[0];
    if (!outlet) throw new Error("checkout_outlet_scope_denied");
    return businessDateForInstant({ occurredAt: input.createdAt, timezone: outlet.timezone, cutoffLocal: outlet.cutoff });
  }

  async transitionFulfillment({ orderId, status, station, reason, organizationId, outletId, actorReference = "bar", transitionedAt = null, inventoryConsumptionDecision = null, hppCatalogMutation = null } = {}) {
    if (!organizationId || !outletId) throw new Error("fulfillment_scope_required");
    return this.db.transaction(async (tx) => {
      const result = await tx.query("select * from sagaops.fulfillment_tickets where order_id=$1 and station='bar' for update", [orderId]);
      const current = result.rows[0];
      if (!current) throw new Error("fulfillment_not_found");
      if ((organizationId && current.organization_id !== organizationId) || (outletId && current.outlet_id !== outletId)) throw new Error("fulfillment_scope_denied");
      const payload = current.payload_snapshot ?? {};
      const rows = await tx.query("select station_snapshot,hpp_snapshot_status from sagaops.order_items where order_id=$1", [orderId]);
      const transitionTimestamp = transitionedAt ?? this.clock().toISOString();
      if (!Number.isFinite(Date.parse(transitionTimestamp)) || new Date(transitionTimestamp).toISOString() !== transitionTimestamp) throw new Error("fulfillment_transition_timestamp_invalid");
      const projection = durableFulfillmentProjection(current);
      const next = transitionTicket({ ...projection, items: rows.rows.map((row) => ({ station: row.station_snapshot })), stationProgress: payload.stationProgress,
        prepStartedAt: current.prep_started_at, readyAt: current.ready_at, completedAt: current.completed_at,
      }, { target: status, station, reason }, transitionTimestamp);
      if (next.idempotentReplay) return { ...current, idempotentReplay: true, hppCatalogRevision: null };
      const target = durableFulfillmentStorageStatus(next);
      let inventoryConsumptionOutcome = null;
      if (current.status === "new" && target === "in_progress") {
        const preparingConsumption = hppCatalogMutation?.snapshot?.saleConsumptions?.find(
          (consumption) => consumption.orderId === orderId && consumption.trigger === "PREPARING",
        );
        const explicitlyUnmapped = inventoryConsumptionDecision?.orderId === orderId
          && inventoryConsumptionDecision.outcome === "UNMAPPED_NO_MUTATION"
          && rows.rows.every((row) => row.hpp_snapshot_status !== "verified");
        let legacyPriorConsumption = false;
        if (inventoryConsumptionDecision?.orderId === orderId && inventoryConsumptionDecision.outcome === "LEGACY_PRIOR_CONSUMPTION") {
          const persistedHpp = await tx.query(
            "select snapshot from sagaops.pos_hpp_catalog_state where organization_id=$1 and outlet_id=$2 for update",
            [current.organization_id, current.outlet_id],
          );
          const persistedSnapshot = persistedHpp.rows[0]?.snapshot;
          legacyPriorConsumption = persistedSnapshot?.saleConsumptions?.some(
            (consumption) => consumption.orderId === orderId
              && (consumption.trigger === "PAYMENT_PAID_LEGACY" || persistedSnapshot.stateVersion < 17 && consumption.trigger == null),
          ) === true;
        }
        if (!preparingConsumption && !explicitlyUnmapped && !legacyPriorConsumption) throw new Error("hpp_catalog_mutation_required");
        inventoryConsumptionOutcome = preparingConsumption ? "PREPARING_PERSISTED" : legacyPriorConsumption ? "LEGACY_PRIOR_CONSUMPTION" : "UNMAPPED_NO_MUTATION";
      }
      const timestampColumn = current.status !== target ? (target === "in_progress" ? "prep_started_at" : target === "ready" ? "ready_at" : target === "completed" ? "completed_at" : null) : null;
      // REMAKE starts a new preparation cycle; retain the previous timestamps
      // in the audit history, not in the current-cycle columns rehydrated by KDS.
      const timestampSql = next.action === "REMAKE"
        ? ",prep_started_at=null,ready_at=null,completed_at=null"
        : timestampColumn ? `,${timestampColumn}=$2` : "";
      const updated = await tx.query(`update sagaops.fulfillment_tickets set status=$1,updated_at=$2${timestampSql},payload_snapshot=$4::jsonb where id=$3 returning *`, [target, transitionTimestamp, current.id, JSON.stringify(durableFulfillmentSnapshot(payload, next, transitionTimestamp))]);
      const hppCatalogRevision = hppCatalogMutation
        ? await this.#persistHppCatalogState(tx, { ...hppCatalogMutation, organizationId: current.organization_id, outletId: current.outlet_id })
        : null;
      if (current.status === "new" && target === "in_progress" && hppCatalogMutation) {
        const preparingConsumption = hppCatalogMutation.snapshot.saleConsumptions.find(
          (consumption) => consumption.orderId === orderId && consumption.trigger === "PREPARING",
        );
        if (preparingConsumption && preparingConsumption.lines.some((line) => line.status !== "UNMANAGED")) {
          const managedLines = preparingConsumption.lines.filter((line) => line.status !== "UNMANAGED");
          if (managedLines.some((line) => line.status === "SHORTAGE")) {
            inventoryConsumptionOutcome = "PREPARING_PERSISTED_VALUATION_DEFERRED_SHORTAGE";
          } else {
            const valuationScopeId = sagaPosPurchaseReceiptLocations(current.outlet_id).usable;
            const loaded = await this.inventoryValuation.loadInTransaction(tx, {
              organizationId: current.organization_id,
              outletId: current.outlet_id,
              valuationScopeId,
            });
            const valuation = await this.inventoryValuation.appendInTransaction(tx, {
              organizationId: current.organization_id,
              outletId: current.outlet_id,
              valuationScopeId,
              expectedRevision: loaded.revision,
              commandType: "INVENTORY_CONSUMPTION",
              actorReference,
              reason: "Pemakaian persediaan saat pesanan mulai disiapkan",
              command: {
                organizationId: current.organization_id,
                outletId: current.outlet_id,
                valuationScopeId,
                operationKey: boundedOperationKey("consumption", preparingConsumption.id),
                occurredAt: preparingConsumption.occurredAt,
                effectiveAt: preparingConsumption.occurredAt,
                consumptionId: preparingConsumption.id,
                lines: managedLines.map((line) => ({
                  ingredientId: line.ingredientId,
                  quantityBase: valuationQuantity(line.quantityRequiredBase),
                })),
              },
            });
            const hppPostedCogsRupiah = managedLines.reduce((sum, line) => sum + line.postedCogsRupiah, 0);
            if (valuation.consumption.id !== preparingConsumption.id || valuation.consumption.postedCogsRupiah !== hppPostedCogsRupiah) {
              throw repositoryError("inventory_valuation_cogs_parity_mismatch", 500);
            }
          }
        }
      }
      const transition = { from: projection.status, to: next.status, action: next.action, operationalStatus: next.operationalStatus, station: station ?? null, inventoryConsumptionOutcome };
      const scope = { organizationId: current.organization_id, outletId: current.outlet_id, actorReference };
      await this.#appendAudit(tx, scope, orderId, "fulfillment.transitioned", transition);
      await this.#appendOutbox(tx, scope, orderId, "pos.fulfillment.transitioned", transition);
      await this.faultInjector("before_fulfillment_commit", { tx, orderId });
      return { ...updated.rows[0], idempotentReplay: false, hppCatalogRevision };
    });
  }

  async loadRuntimeState({ organizationId, outletId } = {}) {
    const [orders, items, payments, fulfillments, sessions, cashSessions, outbox, audits] = await Promise.all([
      this.db.query("select * from sagaops.orders where organization_id=$1 and outlet_id=$2 order by created_at,id", [organizationId, outletId]),
      this.db.query("select oi.* from sagaops.order_items oi join sagaops.orders o on o.id=oi.order_id where o.organization_id=$1 and o.outlet_id=$2 order by oi.created_at,oi.id", [organizationId, outletId]),
      this.db.query("select p.*,pi.provider_fee_rupiah as intent_provider_fee_rupiah,pi.net_settlement_rupiah from sagaops.payments p join sagaops.orders o on o.id=p.order_id left join sagaops.payment_intents pi on pi.order_id=o.id where o.organization_id=$1 and o.outlet_id=$2 order by p.created_at,p.id", [organizationId, outletId]),
      this.db.query("select * from sagaops.fulfillment_tickets where organization_id=$1 and outlet_id=$2 order by created_at,id", [organizationId, outletId]),
      this.db.query("select * from sagaops.kiosk_sessions where organization_id=$1 and outlet_id=$2 order by created_at,id", [organizationId, outletId]),
      this.db.query("select * from sagaops.cash_sessions where organization_id=$1 and outlet_id=$2 order by opened_at,id", [organizationId, outletId]),
      this.db.query("select event_id,event_type,status,attempts,created_at from public.sagaops_integration_outbox where organization_id=$1 and outlet_id=$2 order by created_at,id", [organizationId, outletId]),
      this.db.query("select event_type,aggregate_type,aggregate_id,actor_reference,correlation_id,payload_redacted,occurred_at from sagaops.pos_audit_events where organization_id=$1 and outlet_id=$2 order by occurred_at,id", [organizationId, outletId]),
    ]);
    const expenses = await this.db.query('select * from sagaops.expenses where organization_id=$1 and outlet_id=$2 order by created_at,id', [organizationId, outletId]);
    return { orders: orders.rows, items: items.rows, payments: payments.rows, fulfillments: fulfillments.rows, kioskSessions: sessions.rows, cashSessions: cashSessions.rows, expenses: expenses.rows, outbox: outbox.rows, audits: audits.rows };
  }

  async saveCashierExpense({ expense, organizationId, outletId, actorReference }) {
    return this.db.transaction(async tx => {
      const shift = (await tx.query('select status from sagaops.cash_sessions where id=$1 and organization_id=$2 and outlet_id=$3 for update', [expense.cashSessionId, organizationId, outletId])).rows[0];
      if (!shift) throw repositoryError('cash_session_open_required',409);
      const previous = (await tx.query('select * from sagaops.expenses where id=$1', [expense.id])).rows[0];
      if (previous) {
        if (previous.organization_id !== organizationId || previous.outlet_id !== outletId || previous.cash_session_id !== expense.cashSessionId || previous.amount_rupiah !== expense.amountRupiah || previous.category !== expense.category || previous.reason !== expense.reason) throw repositoryError('expense_retry_conflict',409);
        const metadata = (await tx.query("select payload_redacted from sagaops.pos_audit_events where aggregate_id=$1 and event_type='cash.expense.recorded' order by occurred_at desc limit 1",[expense.id])).rows[0]?.payload_redacted;
        if (metadata?.source !== expense.source || metadata?.evidenceReference !== expense.evidenceReference || metadata?.createdByUserId !== actorReference) throw repositoryError('expense_retry_conflict',409);
        return { idempotentReplay: true };
      }
      if (shift?.status !== 'open') throw repositoryError('cash_session_open_required',409);
      // Source, evidence and correction live in the existing append-only audit;
      // the canonical 34-migration production schema has no closing-v1 columns.
      await tx.query('insert into sagaops.expenses (id,organization_id,outlet_id,cash_session_id,category,amount_rupiah,reason,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing', [expense.id,organizationId,outletId,expense.cashSessionId,expense.category,expense.amountRupiah,expense.reason,expense.createdAt]);
      await this.#appendAudit(tx,{organizationId,outletId,actorReference,aggregateType:'expense'},expense.id,'cash.expense.recorded',expense);
      return { idempotentReplay: false };
    });
  }

  async voidCashierExpense({ expense, organizationId, outletId, actorReference }) {
    return this.db.transaction(async tx => {
      const shift = (await tx.query('select status from sagaops.cash_sessions where id=$1 and organization_id=$2 and outlet_id=$3 for update',[expense.cashSessionId,organizationId,outletId])).rows[0];
      if (shift?.status !== 'open') throw repositoryError('cash_session_open_required',409);
      const current = (await tx.query('select id from sagaops.expenses where id=$1 and organization_id=$2 and outlet_id=$3 and cash_session_id=$4 for update',[expense.id,organizationId,outletId,expense.cashSessionId])).rows[0];
      if (!current) throw repositoryError('expense_not_found',404);
      const prior=(await tx.query("select payload_redacted from sagaops.pos_audit_events where aggregate_id=$1 and event_type='cash.expense.voided' order by occurred_at desc limit 1",[expense.id])).rows[0]?.payload_redacted;
      if (prior) {
        if (prior?.reason !== expense.voidReason) throw repositoryError('expense_retry_conflict',409);
        return {idempotentReplay:true};
      }
      await this.#appendAudit(tx,{organizationId,outletId,actorReference,aggregateType:'expense'},expense.id,'cash.expense.voided',{reason:expense.voidReason});
      return {idempotentReplay:false};
    });
  }

  async durableEvidence({ organizationId, outletId } = {}) {
    const state = await this.loadRuntimeState({ organizationId, outletId });
    const canonical = JSON.stringify(state);
    return {
      counts: Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.length])),
      sha256: createHash("sha256").update(canonical).digest("hex"),
      limitations: ["local_pglite_single_connection", "not_external_postgres", "not_staging_or_production_evidence"],
    };
  }

  async compareEsbCheckoutParity({ organizationId, outletId, orderId } = {}) {
    if (this.esbRuntime.readVersion !== "SHADOW_V1") throw new Error("esb_shadow_read_disabled");
    for (const [field, value] of Object.entries({ organizationId, outletId, orderId })) if (!value) throw new Error(`${field}_required`);
    const legacy = await this.db.query(
      `select o.total_rupiah,
              coalesce(sum(p.amount_rupiah) filter (where p.status='paid'),0)::bigint as applied
         from sagaops.orders o left join sagaops.payments p on p.order_id=o.id
        where o.id=$1 and o.organization_id=$2 and o.outlet_id=$3
        group by o.id,o.total_rupiah`,
      [orderId, organizationId, outletId],
    );
    if (!legacy.rows[0]) throw new Error("order_not_found");
    const ledger = await this.db.query(
      `select
         coalesce((select sum(total_rupiah) from sagaops.esb_bills
                    where order_id=$1 and organization_id=$2 and outlet_id=$3),0)::bigint as billed,
         coalesce((select sum(applied_rupiah) from sagaops.esb_payment_attempts
                    where order_id=$1 and organization_id=$2 and outlet_id=$3 and status='SUCCEEDED'),0)::bigint as applied`,
      [orderId, organizationId, outletId],
    );
    const result = {
      orderId,
      legacy: { billedRupiah: Number(legacy.rows[0].total_rupiah), appliedRupiah: Number(legacy.rows[0].applied) },
      ledger: { billedRupiah: Number(ledger.rows[0].billed), appliedRupiah: Number(ledger.rows[0].applied) },
    };
    return { ...result, parity: result.legacy.billedRupiah === result.ledger.billedRupiah && result.legacy.appliedRupiah === result.ledger.appliedRupiah, authoritativeRead: "LEGACY_V1", productionBackfillPerformed: false };
  }

  async #aggregateReference(tx, orderId, idempotentReplay) {
    const result = await tx.query([
      "select o.id as order_id,o.order_number,p.id as payment_id,p.status as payment_status",
      "from sagaops.orders o join sagaops.payments p on p.order_id=o.id where o.id=$1",
    ].join(" "), [orderId]);
    if (!result.rows[0]) throw new Error("checkout_aggregate_not_found");
    return { orderId: result.rows[0].order_id, orderNumber: result.rows[0].order_number, paymentId: result.rows[0].payment_id, paymentStatus: result.rows[0].payment_status, idempotentReplay };
  }

  async #persistHppCatalogState(tx, { organizationId, outletId, expectedRevision, snapshot, productionExecutionState = undefined }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !snapshot) throw new Error("hpp_catalog_mutation_invalid");
    const persistedSnapshot = structuredClone(snapshot);
    delete persistedSnapshot[PRODUCTION_EXECUTION_STATE_KEY];
    if (productionExecutionState !== undefined) {
      persistedSnapshot[PRODUCTION_EXECUTION_STATE_KEY] = JSON.stringify(productionExecutionState);
    } else if (expectedRevision > 0) {
      const current = (await tx.query(
        "select snapshot from sagaops.pos_hpp_catalog_state where organization_id=$1 and outlet_id=$2 and revision=$3",
        [organizationId, outletId, expectedRevision],
      )).rows[0]?.snapshot;
      const parsed = typeof current === "string" ? JSON.parse(current) : current;
      if (parsed?.[PRODUCTION_EXECUTION_STATE_KEY] !== undefined) persistedSnapshot[PRODUCTION_EXECUTION_STATE_KEY] = parsed[PRODUCTION_EXECUTION_STATE_KEY];
    }
    const result = await tx.query(`insert into sagaops.pos_hpp_catalog_state(organization_id,outlet_id,revision,snapshot)
      select $1,$2,1,$4::jsonb where $3::integer=0 and exists(select 1 from sagaops.outlets where id=$2 and organization_id=$1)
      on conflict(outlet_id) do nothing returning revision`, [organizationId, outletId, expectedRevision, JSON.stringify(persistedSnapshot)]);
    let row = result.rows[0];
    if (!row && expectedRevision > 0) {
      const updated = await tx.query("update sagaops.pos_hpp_catalog_state set revision=revision+1,snapshot=$4::jsonb,updated_at=now() where organization_id=$1 and outlet_id=$2 and revision=$3 returning revision", [organizationId, outletId, expectedRevision, JSON.stringify(persistedSnapshot)]);
      row = updated.rows[0];
    }
    if (!row) { const error = new Error("hpp_persistence_version_conflict"); error.code = "hpp_persistence_version_conflict"; error.statusCode = 409; throw error; }
    await this.#syncHppInventoryMovementLedger(tx, { organizationId, outletId, snapshot: persistedSnapshot });
    await this.faultInjector("after_hpp_inventory_movement_ledger_sync", { tx });
    await this.faultInjector("before_hpp_catalog_commit", { tx });
    return row.revision;
  }

  async #syncHppInventoryMovementLedger(tx, { organizationId, outletId, snapshot }) {
    const facts = deriveHppInventoryMovementFacts({
      snapshot,
      organizationId,
      outletId,
      usableLocationId: sagaPosPurchaseReceiptLocations(outletId).usable,
    });
    const createdAt = this.clock().toISOString();
    for (const fact of facts) {
      const existing = (await tx.query(
        `select movement_id,source_type,source_id,source_line_id,movement_fingerprint
           from sagaops.hpp_inventory_movement_facts
          where organization_id=$1 and outlet_id=$2
            and (movement_id=$3 or (source_type=$4 and source_id=$5 and source_line_id=$6))
          for share`,
        [organizationId, outletId, fact.movementId, fact.sourceType, fact.sourceId, fact.sourceLineId],
      )).rows[0];
      if (existing) {
        if (existing.movement_id !== fact.movementId || existing.source_type !== fact.sourceType
          || existing.source_id !== fact.sourceId || existing.source_line_id !== fact.sourceLineId
          || existing.movement_fingerprint !== fact.fingerprint) {
          throw repositoryError("hpp_inventory_movement_source_collision", 409);
        }
        continue;
      }
      if (fact.movementType === "REVERSAL") {
        const original = (await tx.query(
          `select quantity_delta_base::text,inventory_value_delta_rupiah,ingredient_id,location_id
             from sagaops.hpp_inventory_movement_facts
            where organization_id=$1 and outlet_id=$2 and movement_id=$3 for share`,
          [organizationId, outletId, fact.reversalOfMovementId],
        )).rows[0];
        if (!original || original.ingredient_id !== fact.ingredientId || original.location_id !== fact.locationId
          || formatLedgerQuantity(-Number(original.quantity_delta_base)) !== fact.quantityDeltaBase
          || -Number(original.inventory_value_delta_rupiah) !== fact.inventoryValueDeltaRupiah) {
          throw repositoryError("hpp_inventory_movement_reversal_invalid", 409);
        }
      }
      const latest = (await tx.query(
        `select max(effective_at) latest_effective_at
           from sagaops.hpp_inventory_movement_facts
          where organization_id=$1 and outlet_id=$2 and location_id=$3 and ingredient_id=$4`,
        [organizationId, outletId, fact.locationId, fact.ingredientId],
      )).rows[0]?.latest_effective_at;
      const requiresRebuild = latest != null && new Date(fact.effectiveAt) < new Date(latest);
      await tx.query(
        `insert into sagaops.hpp_inventory_movement_facts
          (movement_id,organization_id,outlet_id,movement_type,source_type,source_id,source_line_id,
           ingredient_id,location_id,quantity_delta_base,inventory_value_delta_rupiah,
           quantity_before_base,quantity_after_base,inventory_value_before_rupiah,inventory_value_after_rupiah,
           effective_at,created_at,actor_reference,reason,audit_reference,reference_type,reference_id,
           reference_code,reversal_of_movement_id,source_event_id,source_device_id,source_local_sequence,
           hpp_version,requires_rebuild,movement_fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
        [fact.movementId, organizationId, outletId, fact.movementType, fact.sourceType, fact.sourceId, fact.sourceLineId,
          fact.ingredientId, fact.locationId, fact.quantityDeltaBase, fact.inventoryValueDeltaRupiah,
          fact.quantityBeforeBase, fact.quantityAfterBase, fact.inventoryValueBeforeRupiah, fact.inventoryValueAfterRupiah,
          fact.effectiveAt, createdAt, fact.actorReference, fact.reason, fact.auditReference, fact.referenceType,
          fact.referenceId, fact.referenceCode, fact.reversalOfMovementId, fact.sourceEventId, fact.sourceDeviceId,
          fact.sourceLocalSequence, fact.hppVersion, requiresRebuild, fact.fingerprint],
      );
      if (requiresRebuild) {
        await this.#appendOutbox(tx, { organizationId, outletId }, fact.movementId, "INVENTORY_MOVEMENT_REBUILD_REQUIRED_V1", {
          movementId: fact.movementId,
          ingredientId: fact.ingredientId,
          locationId: fact.locationId,
          effectiveAt: fact.effectiveAt,
          movementFingerprint: fact.fingerprint,
        });
      }
    }
  }

  async #paymentReference(tx, paymentId) {
    const result = await tx.query([
      "select p.id as payment_id,p.status as payment_status,p.order_id,o.organization_id,o.outlet_id,o.order_number",
      "from sagaops.payments p join sagaops.orders o on o.id=p.order_id where p.id=$1 for update of p",
    ].join(" "), [paymentId]);
    if (!result.rows[0]) throw new Error("payment_not_found");
    return result.rows[0];
  }

  async #ensureFulfillment(tx, input) {
    // Always derive the production ticket from committed order snapshots, including QRIS callbacks.
    const rows = await tx.query("select * from sagaops.order_items where order_id=$1 order by created_at,id", [input.orderId]);
    const items = rows.rows.map((item) => ({
      productId: item.product_reference_snapshot ?? item.product_id,
      name: item.product_name_snapshot, qty: Number(item.qty),
      selections: item.modifier_snapshot ?? [], note: item.note ?? "", station: item.station_snapshot,
    }));
    if (!items.length) throw new Error("fulfillment_items_required");
    await tx.query([
      "insert into sagaops.fulfillment_tickets(id,organization_id,outlet_id,order_id,station,status,payload_snapshot,created_at,updated_at)",
      "values ($1,$2,$3,$4,'bar','new',$5::jsonb,$6,$6)",
      "on conflict (order_id,station) do nothing",
    ].join(" "), [randomUUID(), input.organizationId, input.outletId, input.orderId, JSON.stringify({ orderNumber: input.orderNumber, items }), input.createdAt ?? this.clock().toISOString()]);
  }

  async #appendOutbox(tx, input, aggregateId, eventType, payload = {}) {
    const eventId = randomUUID();
    await tx.query([
      "insert into public.sagaops_integration_outbox(id,organization_id,outlet_id,event_id,event_type,payload,status,created_at)",
      "values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7)",
    ].join(" "), [eventId, input.organizationId, input.outletId, eventId, eventType, JSON.stringify({ schemaVersion: 1, aggregateId, correlationId: input.correlationId ?? null, ...payload }), this.clock().toISOString()]);
  }

  async #appendAudit(tx, input, aggregateId, eventType, payload) {
    await tx.query([
      "insert into sagaops.pos_audit_events(organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,correlation_id,payload_redacted,occurred_at)",
      "values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
    ].join(" "), [input.organizationId, input.outletId, input.actorReference ?? null, eventType, input.aggregateType ?? "order", aggregateId, input.correlationId ?? null, JSON.stringify(payload), input.occurredAt ?? this.clock().toISOString()]);
  }
}

function assertProductionCompletionPersistence({ organizationId, outletId, expectedRevision, snapshot, state, fact }) {
  if (typeof organizationId !== "string" || typeof outletId !== "string" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw repositoryError("production_execution_completion_invalid", 422);
  }
  assertProductionExecutionStateEnvelope({ organizationId, outletId, state });
  const document = validateInventoryReportingProductionDocument(fact);
  if (document.organizationId !== organizationId || document.outletId !== outletId) throw repositoryError("production_execution_completion_scope_invalid", 403);
  const matches = state.operations.filter((operation) => operation?.result?.execution?.productionOrderId === document.productionId);
  const operation = matches.length === 1 ? matches[0] : null;
  const source = operation?.completionSourceState;
  if (!source || source.stateHash !== document.sourceStateHash || source.revision !== document.sourceStateRevision
    || operation.result.execution.id !== document.executionId || operation.result.execution.hash !== document.sourceExecutionHash) {
    throw repositoryError("production_execution_completion_authority_mismatch", 409);
  }
  assertProductionSnapshotMatchesDocument({ snapshot, operation, document });
}

function assertProductionExecutionStateEnvelope({ organizationId, outletId, state }) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.tenantId !== organizationId || state.outletId !== outletId
    || !Array.isArray(state.operations) || typeof state.stateHash !== "string") {
    throw repositoryError("production_execution_completion_invalid", 422);
  }
  const { stateHash, ...statePayload } = state;
  if (stateHash !== createHash("sha256").update(JSON.stringify(statePayload)).digest("hex")) {
    throw repositoryError("production_execution_state_tampered", 422);
  }
}

function assertProductionSnapshotMatchesDocument({ snapshot, operation, document }) {
  const movements = Array.isArray(snapshot.inventoryMovements) ? snapshot.inventoryMovements.filter((movement) =>
    movement?.sourceType === "PRODUCTION_EXECUTION" && movement.sourceId === document.executionId
      && movement.referenceId === document.productionId && movement.referenceCode === operation.operationKey) : [];
  const inputs = movements.filter((movement) => movement.movementType === "PRODUCTION_INPUT");
  const outputs = movements.filter((movement) => movement.movementType === "PRODUCTION_OUTPUT");
  const inputMatches = document.inputs.every((line) => inputs.some((movement) => movement.ingredientId === line.itemId
    && movement.locationId === line.locationId && formatLedgerQuantity(movement.quantityInputBase) === line.quantityBase
    && movement.inventoryValueDeltaRupiah === -line.inventoryValueRupiah));
  const output = outputs[0];
  if (movements.length !== document.inputs.length + 1 || inputs.length !== document.inputs.length || outputs.length !== 1 || !inputMatches
    || output.ingredientId !== document.actualOutput.itemId || output.locationId !== document.actualOutput.locationId
    || formatLedgerQuantity(output.quantityInputBase) !== document.actualOutput.quantityBase
    || output.inventoryValueDeltaRupiah !== document.actualOutput.inventoryValueRupiah
    || new Date(output.occurredAt).toISOString() !== document.completedAt) {
    throw repositoryError("production_execution_completion_inventory_mismatch", 409);
  }
}

async function assertPersistedProductionMovements(tx, { organizationId, outletId, snapshot, executionId }) {
  const expected = deriveHppInventoryMovementFacts({
    snapshot,
    organizationId,
    outletId,
    usableLocationId: sagaPosPurchaseReceiptLocations(outletId).usable,
  }).filter((fact) => fact.sourceType === "PRODUCTION_EXECUTION" && fact.sourceId === executionId);
  const persisted = (await tx.query(
    `select movement_id,source_line_id,movement_fingerprint from sagaops.hpp_inventory_movement_facts
      where organization_id=$1 and outlet_id=$2 and source_type='PRODUCTION_EXECUTION' and source_id=$3`,
    [organizationId, outletId, executionId],
  )).rows;
  const byId = new Map(persisted.map((row) => [row.movement_id, row]));
  if (expected.length < 2 || persisted.length !== expected.length || expected.some((fact) => {
    const row = byId.get(fact.movementId);
    return !row || row.source_line_id !== fact.sourceLineId || row.movement_fingerprint !== fact.fingerprint;
  })) throw repositoryError("production_execution_completion_ledger_mismatch", 409);
}

function productionValuationInput({ organizationId, outletId, state, document }) {
  const operations = state.operations.filter((item) => item?.result?.execution?.productionOrderId === document.productionId);
  const execution = operations.length === 1 ? operations[0].result.execution : null;
  const audit = execution && state.audit.find((item) => item.action === "PRODUCTION_COMPLETED"
    && item.aggregateId === document.productionId && item.revision === execution.revision);
  if (!execution || !audit || execution.id !== document.executionId) throw repositoryError("production_execution_completion_authority_mismatch", 409);
  const normalQuantityBase = valuationNonnegativeQuantity(execution.yield?.normalLossQuantity);
  const abnormalQuantityBase = valuationNonnegativeQuantity(execution.yield?.abnormalWasteQuantity);
  const legacyLoss = document.schemaVersion === 1;
  const loss = document.loss ?? {
    policy: "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1",
    valuationMethod: "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1",
    normalQuantityBase,
    abnormalQuantityBase,
    abnormalValueRupiah: 0,
  };
  if (loss.policy !== "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1"
    || loss.valuationMethod !== "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1"
    || loss.normalQuantityBase !== normalQuantityBase || loss.abnormalQuantityBase !== abnormalQuantityBase
    || (legacyLoss ? abnormalQuantityBase !== "0.000000"
      : execution.lossValuationPolicy !== loss.valuationMethod
        || execution.lossPolicy !== loss.policy
        || execution.abnormalLossValueRupiah !== loss.abnormalValueRupiah
        || valuationRupiah(execution.actualOutputInventoryValueRupiah) !== document.actualOutput.inventoryValueRupiah)) {
    throw repositoryError("production_abnormal_loss_authority_mismatch", 409);
  }
  const valuationScopeId = sagaPosPurchaseReceiptLocations(outletId).usable;
  return {
    organizationId,
    outletId,
    valuationScopeId,
    actorReference: audit.actorId,
    reason: audit.reason,
    command: {
      organizationId,
      outletId,
      valuationScopeId,
      operationKey: boundedOperationKey("production", document.executionId),
      occurredAt: document.completedAt,
      effectiveAt: document.completedAt,
      productionId: document.productionId,
      executionId: document.executionId,
      plannedOutputQuantityBase: document.plannedOutput.quantityBase,
      inputs: document.inputs.map((line) => ({ ingredientId: line.itemId, quantityBase: line.quantityBase, postedInventoryValueRupiah: line.inventoryValueRupiah })),
      output: { ingredientId: document.actualOutput.itemId, quantityBase: document.actualOutput.quantityBase, postedInventoryValueRupiah: document.actualOutput.inventoryValueRupiah },
      loss: {
        policy: loss.policy,
        normalQuantityBase,
        abnormalQuantityBase,
        abnormalValueRupiah: loss.abnormalValueRupiah,
      },
    },
  };
}

function assertProductionValuationParity({ valuation, document }) {
  const production = valuation?.production;
  const inputs = production?.inputs ?? [];
  const matches = document.inputs.length === inputs.length && document.inputs.every((line) => inputs.some((candidate) =>
    candidate.ingredientId === line.itemId && candidate.quantityBase === line.quantityBase
      && candidate.postedInventoryValueRupiah === line.inventoryValueRupiah));
  if (!production || production.productionId !== document.productionId || production.executionId !== document.executionId
    || production.output.ingredientId !== document.actualOutput.itemId
    || production.output.quantityBase !== document.actualOutput.quantityBase
    || production.output.postedInventoryValueRupiah !== document.actualOutput.inventoryValueRupiah
    || production.loss.normalQuantityBase !== (document.loss?.normalQuantityBase ?? production.loss.normalQuantityBase)
    || production.loss.abnormalQuantityBase !== (document.loss?.abnormalQuantityBase ?? "0.000000")
    || production.loss.abnormalValueRupiah !== (document.loss?.abnormalValueRupiah ?? 0) || !matches) {
    throw repositoryError("inventory_valuation_production_parity_mismatch", 500);
  }
}

async function assertPersistedProductionValuation(tx, { inventoryValuation, input, document }) {
  const loaded = await inventoryValuation.loadInTransaction(tx, input);
  const production = loaded.ledger.viewScope({
    organizationId: input.organizationId,
    outletId: input.outletId,
    valuationScopeId: input.valuationScopeId,
  }).productions.find((item) => item.productionId === document.productionId);
  assertProductionValuationParity({ valuation: { production }, document });
  const operation = (await tx.query(
    `select outlet_id,valuation_scope_id,committed_revision from sagaops.inventory_valuation_operations
      where organization_id=$1 and operation_key=$2`,
    [input.organizationId, input.command.operationKey],
  )).rows[0];
  if (!operation || operation.outlet_id !== input.outletId || operation.valuation_scope_id !== input.valuationScopeId
    || Number(operation.committed_revision) !== production.sequence) {
    throw repositoryError("production_execution_completion_valuation_mismatch", 409);
  }
}

function validateCheckout(input) {
  for (const field of ["organizationId", "outletId", "businessDate", "channel", "idempotencyKey", "requestFingerprint", "orderType"]) if (!input[field]) throw new Error(`${field}_required`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("checkout_items_required");
  if (!input.payment?.methodType || !input.payment?.status || !input.payment?.idempotencyKey) throw new Error("checkout_payment_required");
  for (const field of ["subtotalRupiah", "discountRupiah", "taxRupiah", "serviceRupiah", "roundingRupiah", "totalRupiah"]) if (!Number.isInteger(input[field])) throw new Error(`${field}_integer_required`);
}

function persistSaleCostQuality(item) {
  const recipeSnapshot = item?.recipeSnapshot && typeof item.recipeSnapshot === "object" && !Array.isArray(item.recipeSnapshot)
    ? structuredClone(item.recipeSnapshot)
    : {};
  const hasCoverage = Object.hasOwn(item ?? {}, "costCoverage");
  const hasReportableCost = Object.hasOwn(item ?? {}, "reportableRecipeCostSnapshotRupiah");
  if (!hasCoverage && !hasReportableCost) return recipeSnapshot;

  const costCoverage = String(item.costCoverage ?? "").toUpperCase();
  if (!["COMPLETE", "PARTIAL", "MISSING"].includes(costCoverage)) throw new Error("checkout_cost_coverage_invalid");
  const reportableRecipeCostSnapshotRupiah = item.reportableRecipeCostSnapshotRupiah ?? null;
  if (costCoverage === "COMPLETE") {
    if (!Number.isSafeInteger(reportableRecipeCostSnapshotRupiah) || reportableRecipeCostSnapshotRupiah < 0) {
      throw new Error("checkout_reportable_recipe_cost_invalid");
    }
  } else if (reportableRecipeCostSnapshotRupiah !== null) {
    throw new Error("checkout_incomplete_recipe_cost_must_not_be_reportable");
  }
  recipeSnapshot[SALE_COST_QUALITY_SNAPSHOT_KEY] = {
    version: 1,
    costCoverage,
    reportableRecipeCostSnapshotRupiah,
  };
  return recipeSnapshot;
}

function projectInventoryMovementFact(row) {
  return {
    ledgerSequence: Number(row.ledger_sequence),
    movementId: row.movement_id,
    movementType: row.movement_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceLineId: row.source_line_id,
    ingredientId: row.ingredient_id,
    locationId: row.location_id,
    quantityDeltaBase: formatLedgerQuantity(row.quantity_delta_base),
    inventoryValueDeltaRupiah: Number(row.inventory_value_delta_rupiah),
    quantityBeforeBase: formatLedgerQuantity(row.quantity_before_base),
    quantityAfterBase: formatLedgerQuantity(row.quantity_after_base),
    inventoryValueBeforeRupiah: Number(row.inventory_value_before_rupiah),
    inventoryValueAfterRupiah: Number(row.inventory_value_after_rupiah),
    effectiveAt: new Date(row.effective_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    actorReference: row.actor_reference,
    reason: row.reason,
    auditReference: row.audit_reference,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    referenceCode: row.reference_code,
    reversalOfMovementId: row.reversal_of_movement_id,
    sourceEventId: row.source_event_id,
    sourceDeviceId: row.source_device_id,
    sourceLocalSequence: row.source_local_sequence == null ? null : Number(row.source_local_sequence),
    hppVersion: Number(row.hpp_version),
    requiresRebuild: row.requires_rebuild,
    fingerprint: row.movement_fingerprint,
  };
}

function formatLedgerQuantity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw repositoryError("hpp_inventory_movement_quantity_invalid", 500);
  return number.toFixed(6);
}

function replayRemakeQueue(row, requested) {
  const stored = remakeQueueFactFromAudit(row);
  if (stored.queueFingerprint !== requested.queueFingerprint) throw remakeQueueError("remake_queue_idempotency_conflict", 409);
  return { remake: stored, idempotentReplay: true };
}

function repositoryError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function productionCommitError(cause, outcome) {
  const message = cause instanceof Error ? cause.message : String(cause ?? "production_completion_commit_failed");
  const error = new Error(message, cause instanceof Error ? { cause } : undefined);
  error.name = cause?.name ?? "Error";
  error.code = cause?.code;
  error.status = cause?.status;
  error.statusCode = cause?.statusCode;
  error.productionCommitOutcome = outcome;
  return error;
}

function valuationReceiptLineId(receiptId, ingredientId) {
  return `receipt-line:${createHash("sha256").update(`${receiptId}\u0000${ingredientId}`).digest("hex")}`;
}

function boundedOperationKey(prefix, value) {
  return `${prefix}:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function valuationQuantity(value) {
  if (!Number.isFinite(value) || value <= 0) throw repositoryError("inventory_valuation_quantity_invalid", 500);
  return value.toFixed(6);
}

function valuationNonnegativeQuantity(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw repositoryError("inventory_valuation_quantity_invalid", 500);
  const [whole, fraction = ""] = text.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > 1_000_000_000_000n) throw repositoryError("inventory_valuation_quantity_invalid", 500);
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}

function valuationRupiah(value) {
  const text = String(value ?? "");
  if (!/^\d+(?:\.0{1,6})?$/.test(text)) throw repositoryError("inventory_valuation_money_invalid", 500);
  const number = Number(text.split(".")[0]);
  if (!Number.isSafeInteger(number) || number < 0) throw repositoryError("inventory_valuation_money_invalid", 500);
  return number;
}
