import { createHash } from "node:crypto";

const QUALITY_STATES = new Set(["USABLE", "QUARANTINED", "RECALLED", "EXPIRED", "DAMAGED"]);
const EXPIRY_SOURCES = new Set(["SUPPLIER", "PRODUCTION_POLICY", "MANUAL_VERIFIED", "SYNTHETIC_OPENING"]);
const LOSS_DISPOSITIONS = new Set(["TRANSFER_DAMAGE", "CARRIER_LOSS", "THEFT", "SPOILAGE", "OTHER_APPROVED"]);
const STATE_SCHEMA_VERSION = 1;
const QUANTITY_SCALE = 1_000_000;

export class InventoryTraceabilityTransferService {
  constructor({ tenantId, organizationId, clock = () => new Date() } = {}) {
    this.tenantId = id(tenantId, "trace_tenant_required");
    this.organizationId = id(organizationId, "trace_organization_required");
    this.clock = clock;
    this.revision = 0;
    this.lots = new Map();
    this.balances = new Map();
    this.requests = new Map();
    this.transfers = new Map();
    this.reservations = new Map();
    this.genealogy = [];
    this.recallCases = new Map();
    this.operations = new Map();
    this.audit = [];
  }

  registerLot(input) {
    return this.#operation("REGISTER_LOT", input.operationKey, input, () => {
      const lotId = id(input.lotId, "trace_lot_required");
      const locationId = id(input.locationId, "trace_location_required");
      const itemId = id(input.itemId, "trace_item_required");
      const qualityState = enumValue(input.qualityState ?? "USABLE", QUALITY_STATES, "trace_quality_invalid");
      const lot = {
        lotId, itemId,
        supplierLot: optionalText(input.supplierLot),
        internalLot: optionalText(input.internalLot),
        receivedAt: optionalInstant(input.receivedAt),
        producedAt: optionalInstant(input.producedAt),
        expiryAt: optionalInstant(input.expiryAt),
        expirySource: enumValue(input.expirySource, EXPIRY_SOURCES, "trace_expiry_source_invalid"),
        qualityState,
        sourceDocumentType: id(input.sourceDocumentType, "trace_source_document_type_required"),
        sourceDocumentId: id(input.sourceDocumentId, "trace_source_document_required"),
      };
      const existing = this.lots.get(lotId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(lot)) throw problem("trace_lot_identity_conflict", 409);
      this.lots.set(lotId, lot);
      this.#increase(locationId, lotId, positive(input.quantity, "trace_quantity_invalid"), nonNegative(input.totalValueRupiah, "trace_value_invalid"));
      this.#record("LOT_REGISTERED", lotId, input.reason, input.actorId, { locationId, qualityState });
      return { lot: structuredClone(lot), balance: this.#balance(locationId, lotId) };
    });
  }

  availableAt({ locationId, lotId }) {
    const balance = this.#balance(id(locationId, "trace_location_required"), id(lotId, "trace_lot_required"));
    const reserved = [...this.reservations.values()].filter((row) => row.locationId === locationId && row.lotId === lotId && row.status === "ACTIVE").reduce((sum, row) => addQuantity(sum, row.quantity), 0);
    return { ...balance, availableQuantity: subtractQuantity(balance.quantity, reserved) };
  }

  selectFefo({ itemId, locationId, quantity, occurredAt }) {
    const normalizedItemId = id(itemId, "trace_item_required");
    const normalizedLocationId = id(locationId, "trace_location_required");
    const required = positive(quantity, "trace_quantity_invalid");
    const at = instant(occurredAt);
    const candidates = [...this.balances.values()].filter((balance) => {
      const lot = this.lots.get(balance.lotId);
      return balance.locationId === normalizedLocationId && lot?.itemId === normalizedItemId && lot.qualityState === "USABLE" && (!lot.expiryAt || lot.expiryAt > at) && this.availableAt(balance).availableQuantity > 0;
    }).sort((left, right) => (this.lots.get(left.lotId).expiryAt ?? "9999").localeCompare(this.lots.get(right.lotId).expiryAt ?? "9999") || left.lotId.localeCompare(right.lotId));
    let remaining = required;
    const allocations = [];
    for (const balance of candidates) {
      if (!remaining) break;
      const available = this.availableAt(balance).availableQuantity;
      const allocated = Math.min(remaining, available);
      allocations.push({ lotId: balance.lotId, locationId: normalizedLocationId, quantity: allocated, expiryAt: this.lots.get(balance.lotId).expiryAt });
      remaining = subtractQuantity(remaining, allocated);
    }
    if (remaining) throw problem("trace_fefo_shortage", 409);
    return allocations;
  }

  requestTransfer(input) {
    return this.#operation("REQUEST_TRANSFER", input.operationKey, input, () => {
      const request = {
        id: id(input.requestId, "transfer_request_id_required"), status: "REQUESTED",
        sourceLocationId: id(input.sourceLocationId, "transfer_source_required"),
        destinationLocationId: id(input.destinationLocationId, "transfer_destination_required"),
        lines: normalizedLines(input.lines), createdAt: this.#now(),
      };
      if (request.sourceLocationId === request.destinationLocationId || this.requests.has(request.id)) throw problem("transfer_request_conflict", 409);
      this.requests.set(request.id, request);
      this.#record("TRANSFER_REQUESTED", request.id, input.reason, input.actorId, { lineCount: request.lines.length });
      return { request: structuredClone(request) };
    });
  }

  approveTransfer(input) {
    return this.#operation("APPROVE_TRANSFER", input.operationKey, input, () => {
      const request = this.#request(input.requestId, "REQUESTED");
      const transferId = id(input.transferId, "transfer_id_required");
      if (this.transfers.has(transferId)) throw problem("transfer_id_conflict", 409);
      const reservations = [];
      for (const line of request.lines) {
        const balance = this.availableAt({ locationId: request.sourceLocationId, lotId: line.lotId });
        if (balance.availableQuantity < line.quantity) throw problem("transfer_source_shortage", 409);
        const reservation = { id: hash({ transferId, lotId: line.lotId }), transferId, locationId: request.sourceLocationId, lotId: line.lotId, quantity: line.quantity, status: "ACTIVE" };
        reservations.push(reservation);
      }
      for (const reservation of reservations) this.reservations.set(reservation.id, reservation);
      request.status = "APPROVED";
      const transfer = { id: transferId, requestId: request.id, status: "APPROVED", routeMode: input.routeMode === "LOCAL_INSTANT" ? "LOCAL_INSTANT" : "DISPATCH_TRANSIT_RECEIVE", sourceLocationId: request.sourceLocationId, destinationLocationId: request.destinationLocationId, lines: structuredClone(request.lines), receivedLines: [], lossLines: [], createdAt: this.#now() };
      this.transfers.set(transferId, transfer);
      this.#record("TRANSFER_APPROVED", transferId, input.reason, input.actorId, { routeMode: transfer.routeMode });
      return { transfer: structuredClone(transfer), reservations: structuredClone(reservations) };
    });
  }

  executeLocal(input) {
    return this.#operation("EXECUTE_LOCAL_TRANSFER", input.operationKey, input, () => {
      const transfer = this.#transfer(input.transferId, "APPROVED");
      if (transfer.routeMode !== "LOCAL_INSTANT") throw problem("transfer_route_mode_invalid");
      this.#moveLines(transfer.sourceLocationId, transfer.destinationLocationId, transfer.lines);
      this.#releaseReservations(transfer.id, "CONSUMED");
      transfer.receivedLines = structuredClone(transfer.lines);
      transfer.status = "RECEIVED";
      this.#record("TRANSFER_LOCAL_COMPLETED", transfer.id, input.reason, input.actorId, { lines: transfer.lines });
      return { transfer: structuredClone(transfer) };
    });
  }

  dispatch(input) {
    return this.#operation("DISPATCH_TRANSFER", input.operationKey, input, () => {
      const transfer = this.#transfer(input.transferId, "APPROVED");
      if (transfer.routeMode !== "DISPATCH_TRANSIT_RECEIVE") throw problem("transfer_route_mode_invalid");
      const transitLocationId = `TRANSIT:${transfer.id}`;
      this.#moveLines(transfer.sourceLocationId, transitLocationId, transfer.lines);
      this.#releaseReservations(transfer.id, "CONSUMED");
      transfer.transitLocationId = transitLocationId;
      transfer.status = "IN_TRANSIT";
      this.#record("TRANSFER_DISPATCHED", transfer.id, input.reason, input.actorId, { transitLocationId });
      return { transfer: structuredClone(transfer), companyOwnedInTransit: true, destinationAvailable: false };
    });
  }

  receive(input) {
    return this.#operation("RECEIVE_TRANSFER", input.operationKey, input, () => {
      const transfer = this.#transferAny(input.transferId, ["IN_TRANSIT", "PARTIALLY_RECEIVED"]);
      const receivedLines = normalizedLines(input.lines);
      for (const line of receivedLines) {
        const expected = transfer.lines.find((row) => row.lotId === line.lotId);
        const already = transfer.receivedLines.filter((row) => row.lotId === line.lotId).reduce((sum, row) => addQuantity(sum, row.quantity), 0);
        const lost = transfer.lossLines.filter((row) => row.lotId === line.lotId).reduce((sum, row) => addQuantity(sum, row.quantity), 0);
        if (!expected || addQuantity(addQuantity(already, lost), line.quantity) > expected.quantity) throw problem("transfer_receipt_exceeds_dispatch", 409);
      }
      this.#moveLines(transfer.transitLocationId, transfer.destinationLocationId, receivedLines);
      transfer.receivedLines.push(...structuredClone(receivedLines));
      transfer.status = this.#unresolved(transfer) === 0 ? "RECEIVED" : "PARTIALLY_RECEIVED";
      this.#record("TRANSFER_RECEIVED", transfer.id, input.reason, input.actorId, { lines: receivedLines, unresolvedQuantity: this.#unresolved(transfer) });
      return { transfer: structuredClone(transfer), unresolvedTransitQuantity: this.#unresolved(transfer) };
    });
  }

  confirmTransitLoss(input) {
    return this.#operation("CONFIRM_TRANSIT_LOSS", input.operationKey, input, () => {
      const transfer = this.#transferAny(input.transferId, ["IN_TRANSIT", "PARTIALLY_RECEIVED"]);
      const lossLines = normalizedLines(input.lines);
      const disposition = enumValue(input.disposition, LOSS_DISPOSITIONS, "transfer_loss_disposition_invalid");
      for (const line of lossLines) {
        const balance = this.#balance(transfer.transitLocationId, line.lotId);
        if (balance.quantity < line.quantity) throw problem("transfer_loss_exceeds_transit", 409);
      }
      for (const line of lossLines) this.#decrease(transfer.transitLocationId, line.lotId, line.quantity);
      const confirmedAt = this.#now();
      const confirmedLossLines = lossLines.map((line) => ({
        ...line,
        disposition,
        confirmedAt,
        confirmedByActorId: id(input.actorId, "trace_actor_required"),
      }));
      transfer.lossLines.push(...structuredClone(confirmedLossLines));
      transfer.status = this.#unresolved(transfer) === 0 ? "CLOSED_WITH_LOSS" : "PARTIALLY_RECEIVED";
      this.#record("TRANSFER_LOSS_CONFIRMED", transfer.id, input.reason, input.actorId, { disposition, lines: confirmedLossLines });
      return { transfer: structuredClone(transfer), unresolvedTransitQuantity: this.#unresolved(transfer) };
    });
  }

  cancelTransfer(input) {
    return this.#operation("CANCEL_TRANSFER", input.operationKey, input, () => {
      const transfer = this.transfers.get(id(input.transferId, "transfer_id_required"));
      if (!transfer) throw problem("transfer_not_found", 404);
      if (["IN_TRANSIT", "PARTIALLY_RECEIVED"].includes(transfer.status)) throw problem("transfer_physical_return_required", 409);
      if (transfer.status !== "APPROVED") throw problem("transfer_not_cancellable", 409);
      this.#releaseReservations(transfer.id, "RELEASED");
      transfer.status = "CANCELLED";
      this.#record("TRANSFER_CANCELLED", transfer.id, input.reason, input.actorId, {});
      return { transfer: structuredClone(transfer) };
    });
  }

  recordGenealogy(input) {
    return this.#operation("RECORD_GENEALOGY", input.operationKey, input, () => {
      const outputLotId = id(input.outputLotId, "genealogy_output_lot_required");
      if (!this.lots.has(outputLotId)) throw problem("genealogy_output_lot_not_found", 404);
      const inputLotIds = [...new Set(array(input.inputLotIds, "genealogy_inputs_required").map((value) => id(value, "genealogy_input_lot_invalid")))];
      if (!inputLotIds.length || inputLotIds.some((lotId) => !this.lots.has(lotId) || lotId === outputLotId)) throw problem("genealogy_input_invalid");
      const processType = ["PRODUCTION", "BLEND", "REWORK"].includes(input.processType) ? input.processType : null;
      if (!processType) throw problem("genealogy_process_invalid");
      if (inputLotIds.some((inputLotId) => this.#genealogyPathExists(outputLotId, inputLotId))) throw problem("genealogy_cycle_detected", 409);
      const edges = inputLotIds.map((inputLotId) => ({ inputLotId, outputLotId, processType, sourceDocumentId: id(input.sourceDocumentId, "genealogy_source_required") }));
      if (edges.some((edge) => this.genealogy.some((existing) => existing.inputLotId === edge.inputLotId && existing.outputLotId === edge.outputLotId))) throw problem("genealogy_edge_conflict", 409);
      this.genealogy.push(...edges);
      this.#record("GENEALOGY_RECORDED", outputLotId, input.reason, input.actorId, { edges });
      return { edges: structuredClone(edges) };
    });
  }

  openRecall(input) {
    return this.#operation("OPEN_RECALL", input.operationKey, input, () => {
      const recallId = id(input.recallId, "recall_id_required");
      if (this.recallCases.has(recallId)) throw problem("recall_id_conflict", 409);
      const seedLotIds = [...new Set(array(input.seedLotIds, "recall_seed_required").map((value) => id(value, "recall_lot_invalid")))];
      if (!seedLotIds.length || seedLotIds.some((lotId) => !this.lots.has(lotId))) throw problem("recall_lot_not_found", 404);
      const depth = bounded(input.traceabilityDepth ?? 10, "recall_depth_invalid", 1, 100);
      const trace = this.#trace(seedLotIds, depth);
      for (const lotId of trace.lotIds) this.lots.get(lotId).qualityState = "RECALLED";
      const recall = { id: recallId, status: "OPEN", seedLotIds, affectedLotIds: [...trace.lotIds], traceabilityDepth: depth, traceabilityTruncated: trace.truncated, openedAt: this.#now() };
      this.recallCases.set(recallId, recall);
      this.#record("RECALL_OPENED", recallId, input.reason, input.actorId, { affectedLotIds: recall.affectedLotIds, depth });
      return { recall: structuredClone(recall) };
    });
  }

  view() {
    return structuredClone({ revision: this.revision, lots: [...this.lots.values()], balances: [...this.balances.values()], requests: [...this.requests.values()], transfers: [...this.transfers.values()], reservations: [...this.reservations.values()], genealogy: this.genealogy, recalls: [...this.recallCases.values()], audit: this.audit });
  }

  exportState() {
    const payload = {
      schemaVersion: STATE_SCHEMA_VERSION,
      tenantId: this.tenantId,
      organizationId: this.organizationId,
      ...this.#snapshot(),
    };
    return structuredClone({ ...payload, stateFingerprint: hash(payload) });
  }

  restoreState(input) {
    const before = this.#snapshot();
    try {
      if (!input || Array.isArray(input) || typeof input !== "object") throw problem("trace_state_invalid", 500);
      const state = structuredClone(input);
      const stateFingerprint = state.stateFingerprint;
      delete state.stateFingerprint;
      if (state.schemaVersion !== STATE_SCHEMA_VERSION || typeof stateFingerprint !== "string" || stateFingerprint !== hash(state)) throw problem("trace_state_invalid", 500);
      if (state.tenantId !== this.tenantId || state.organizationId !== this.organizationId) throw problem("trace_state_scope_mismatch", 409);
      const candidate = {
        revision: state.revision,
        lots: state.lots,
        balances: state.balances,
        requests: state.requests,
        transfers: state.transfers,
        reservations: state.reservations,
        genealogy: state.genealogy,
        recallCases: state.recallCases,
        operations: state.operations,
        audit: state.audit,
      };
      this.#assertState(candidate);
      this.#restore(candidate);
      return this.view();
    } catch (cause) {
      this.#restore(before);
      if (["trace_state_invalid", "trace_state_scope_mismatch"].includes(cause?.message)) throw cause;
      throw problem("trace_state_invalid", 500);
    }
  }

  #operation(action, operationKeyValue, input, work) {
    const operationKey = id(operationKeyValue, "trace_operation_key_required");
    if (!input || Array.isArray(input) || typeof input !== "object") throw problem("trace_input_invalid");
    if (input.tenantId !== undefined && input.tenantId !== this.tenantId
      || input.organizationId !== undefined && input.organizationId !== this.organizationId) throw problem("trace_scope_mismatch", 403);
    const actorId = id(input.actorId, "trace_actor_required");
    const reason = text(input.reason, "trace_reason_required");
    const fingerprintInput = structuredClone(input);
    delete fingerprintInput.operationKey;
    delete fingerprintInput.tenantId;
    delete fingerprintInput.organizationId;
    fingerprintInput.actorId = actorId;
    fingerprintInput.reason = reason;
    const fingerprint = hash({
      action,
      tenantId: this.tenantId,
      organizationId: this.organizationId,
      input: fingerprintInput,
    });
    const existing = this.operations.get(operationKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw problem("trace_operation_collision", 409);
      return { ...structuredClone(existing.result), idempotentReplay: true };
    }
    const snapshot = this.#snapshot();
    try {
      const result = work();
      const response = { ...result, idempotentReplay: false };
      this.operations.set(operationKey, { action, fingerprint, result: structuredClone(response) });
      return structuredClone(response);
    } catch (cause) {
      this.#restore(snapshot);
      throw cause;
    }
  }

  #snapshot() {
    return structuredClone({ revision: this.revision, lots: [...this.lots], balances: [...this.balances], requests: [...this.requests], transfers: [...this.transfers], reservations: [...this.reservations], genealogy: this.genealogy, recallCases: [...this.recallCases], operations: [...this.operations], audit: this.audit });
  }

  #restore(state) {
    this.revision = state.revision; this.lots = new Map(state.lots); this.balances = new Map(state.balances); this.requests = new Map(state.requests); this.transfers = new Map(state.transfers); this.reservations = new Map(state.reservations); this.genealogy = state.genealogy; this.recallCases = new Map(state.recallCases); this.operations = new Map(state.operations); this.audit = state.audit;
  }

  #assertState(state) {
    if (!Number.isSafeInteger(state.revision) || state.revision < 0
      || !Array.isArray(state.lots) || !Array.isArray(state.balances) || !Array.isArray(state.requests)
      || !Array.isArray(state.transfers) || !Array.isArray(state.reservations) || !Array.isArray(state.genealogy)
      || !Array.isArray(state.recallCases) || !Array.isArray(state.operations) || !Array.isArray(state.audit)) throw problem("trace_state_invalid", 500);
    for (const entries of [state.lots, state.balances, state.requests, state.transfers, state.reservations, state.recallCases, state.operations]) {
      if (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2) || new Set(entries.map(([key]) => key)).size !== entries.length) throw problem("trace_state_invalid", 500);
    }
    const lots = new Map(state.lots);
    for (const [lotId, lot] of lots) {
      if (lotId !== lot?.lotId || !id(lotId, "trace_state_invalid") || !QUALITY_STATES.has(lot.qualityState)
        || !id(lot.itemId, "trace_state_invalid") || !EXPIRY_SOURCES.has(lot.expirySource)
        || !id(lot.sourceDocumentType, "trace_state_invalid") || !id(lot.sourceDocumentId, "trace_state_invalid")) throw problem("trace_state_invalid", 500);
      for (const timestamp of [lot.receivedAt, lot.producedAt, lot.expiryAt]) if (timestamp !== null && instant(timestamp) !== timestamp) throw problem("trace_state_invalid", 500);
    }
    for (const [key, balance] of state.balances) {
      if (key !== `${balance?.locationId}:${balance?.lotId}` || !lots.has(balance.lotId)
        || !id(balance.locationId, "trace_state_invalid")
        || quantityValue(balance.quantity, "trace_state_invalid", true) !== balance.quantity
        || nonNegative(balance.totalValueRupiah, "trace_state_invalid") !== balance.totalValueRupiah) throw problem("trace_state_invalid", 500);
    }
    const requests = new Map(state.requests);
    const transfers = new Map(state.transfers);
    const reservations = new Map(state.reservations);
    for (const [requestId, request] of requests) {
      if (requestId !== request?.id || !["REQUESTED", "APPROVED"].includes(request.status)
        || request.sourceLocationId === request.destinationLocationId) throw problem("trace_state_invalid", 500);
      assertStateLines(request.lines, lots);
    }
    for (const [transferId, transfer] of transfers) {
      if (transferId !== transfer?.id || !requests.has(transfer.requestId)
        || !["APPROVED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED_WITH_LOSS", "CANCELLED"].includes(transfer.status)
        || !["LOCAL_INSTANT", "DISPATCH_TRANSIT_RECEIVE"].includes(transfer.routeMode)
        || transfer.sourceLocationId === transfer.destinationLocationId) throw problem("trace_state_invalid", 500);
      assertStateLines(transfer.lines, lots);
      assertStateLines(transfer.receivedLines, lots, true);
      assertStateLines(transfer.lossLines, lots, true, true);
      for (const expected of transfer.lines) {
        const received = transfer.receivedLines.filter((line) => line.lotId === expected.lotId).reduce((sum, line) => addQuantity(sum, line.quantity), 0);
        const lost = transfer.lossLines.filter((line) => line.lotId === expected.lotId).reduce((sum, line) => addQuantity(sum, line.quantity), 0);
        if (addQuantity(received, lost) > expected.quantity) throw problem("trace_state_invalid", 500);
      }
    }
    for (const [reservationId, reservation] of reservations) {
      if (reservationId !== reservation?.id || !transfers.has(reservation.transferId) || !lots.has(reservation.lotId)
        || !["ACTIVE", "CONSUMED", "RELEASED"].includes(reservation.status)
        || quantityValue(reservation.quantity, "trace_state_invalid", false) !== reservation.quantity) throw problem("trace_state_invalid", 500);
    }
    const genealogy = state.genealogy;
    if (genealogy.some((edge) => !lots.has(edge?.inputLotId) || !lots.has(edge?.outputLotId) || edge.inputLotId === edge.outputLotId)) throw problem("trace_state_invalid", 500);
    const adjacency = new Map();
    for (const edge of genealogy) adjacency.set(edge.inputLotId, [...(adjacency.get(edge.inputLotId) ?? []), edge.outputLotId]);
    if ([...lots.keys()].some((lotId) => directedCycleFrom(lotId, adjacency))) throw problem("trace_state_invalid", 500);
    for (const [recallId, recall] of state.recallCases) {
      if (recallId !== recall?.id || recall.status !== "OPEN" || !Array.isArray(recall.seedLotIds)
        || !Array.isArray(recall.affectedLotIds) || recall.seedLotIds.some((lotId) => !lots.has(lotId))
        || recall.affectedLotIds.some((lotId) => !lots.has(lotId) || lots.get(lotId).qualityState !== "RECALLED")
        || bounded(recall.traceabilityDepth, "trace_state_invalid", 1, 100) !== recall.traceabilityDepth
        || typeof recall.traceabilityTruncated !== "boolean") throw problem("trace_state_invalid", 500);
    }
    if (state.audit.length !== state.revision || state.audit.some((event, index) => event?.revision !== index + 1
      || event.tenantId !== this.tenantId || event.organizationId !== this.organizationId
      || event.hash !== hashWithoutKey(event, "hash"))) throw problem("trace_state_invalid", 500);
    if (state.operations.some(([operationKey, operation]) => !id(operationKey, "trace_state_invalid")
      || !operation || !id(operation.action, "trace_state_invalid") || !/^[a-f0-9]{64}$/.test(operation.fingerprint))) throw problem("trace_state_invalid", 500);
  }

  #increase(locationId, lotId, qty, value) {
    const key = `${locationId}:${lotId}`;
    const current = this.balances.get(key) ?? { locationId, lotId, quantity: 0, totalValueRupiah: 0 };
    current.quantity = addQuantity(current.quantity, qty); current.totalValueRupiah += value; this.balances.set(key, current);
  }

  #decrease(locationId, lotId, qty) {
    const key = `${locationId}:${lotId}`;
    const current = this.balances.get(key);
    if (!current || current.quantity < qty) throw problem("trace_balance_shortage", 409);
    const movedValue = current.quantity === qty ? current.totalValueRupiah : Math.round(current.totalValueRupiah * qty / current.quantity);
    current.quantity = subtractQuantity(current.quantity, qty); current.totalValueRupiah -= movedValue;
    return movedValue;
  }

  #moveLines(source, destination, lines) {
    const moves = lines.map((line) => ({ ...line, value: this.#decrease(source, line.lotId, line.quantity) }));
    for (const move of moves) this.#increase(destination, move.lotId, move.quantity, move.value);
  }

  #balance(locationId, lotId) {
    return structuredClone(this.balances.get(`${locationId}:${lotId}`) ?? { locationId, lotId, quantity: 0, totalValueRupiah: 0 });
  }

  #request(requestId, status) {
    const request = this.requests.get(id(requestId, "transfer_request_id_required"));
    if (!request) throw problem("transfer_request_not_found", 404);
    if (request.status !== status) throw problem("transfer_request_status_invalid", 409);
    return request;
  }

  #transfer(transferId, status) {
    return this.#transferAny(transferId, [status]);
  }

  #transferAny(transferId, statuses) {
    const transfer = this.transfers.get(id(transferId, "transfer_id_required"));
    if (!transfer) throw problem("transfer_not_found", 404);
    if (!statuses.includes(transfer.status)) throw problem("transfer_status_invalid", 409);
    return transfer;
  }

  #releaseReservations(transferId, status) {
    for (const reservation of this.reservations.values()) if (reservation.transferId === transferId && reservation.status === "ACTIVE") reservation.status = status;
  }

  #unresolved(transfer) {
    const expected = transfer.lines.reduce((sum, line) => addQuantity(sum, line.quantity), 0);
    const received = transfer.receivedLines.reduce((sum, line) => addQuantity(sum, line.quantity), 0);
    const lost = transfer.lossLines.reduce((sum, line) => addQuantity(sum, line.quantity), 0);
    return subtractQuantity(subtractQuantity(expected, received), lost);
  }

  #trace(seedLotIds, maximumDepth) {
    const seen = new Set(seedLotIds);
    let frontier = [...seedLotIds];
    for (let depth = 0; depth < maximumDepth && frontier.length; depth += 1) {
      const next = [];
      for (const edge of this.genealogy) {
        if (frontier.includes(edge.inputLotId) && !seen.has(edge.outputLotId)) { seen.add(edge.outputLotId); next.push(edge.outputLotId); }
        if (frontier.includes(edge.outputLotId) && !seen.has(edge.inputLotId)) { seen.add(edge.inputLotId); next.push(edge.inputLotId); }
      }
      frontier = next;
    }
    const truncated = frontier.some((lotId) => this.genealogy.some((edge) =>
      edge.inputLotId === lotId && !seen.has(edge.outputLotId) || edge.outputLotId === lotId && !seen.has(edge.inputLotId)));
    return { lotIds: seen, truncated };
  }

  #genealogyPathExists(fromLotId, toLotId) {
    const seen = new Set([fromLotId]);
    const frontier = [fromLotId];
    while (frontier.length) {
      const current = frontier.shift();
      if (current === toLotId) return true;
      for (const edge of this.genealogy) {
        if (edge.inputLotId !== current || seen.has(edge.outputLotId)) continue;
        seen.add(edge.outputLotId);
        frontier.push(edge.outputLotId);
      }
    }
    return false;
  }

  #record(action, entityId, reason, actorId, detail) {
    this.revision += 1;
    const payload = { revision: this.revision, tenantId: this.tenantId, organizationId: this.organizationId, action, entityId, actorId: id(actorId, "trace_actor_required"), reason: text(reason, "trace_reason_required"), detail: structuredClone(detail), occurredAt: this.#now() };
    this.audit.push({ ...payload, hash: hash(payload) });
  }

  #now() { return instant(this.clock()); }
}

function normalizedLines(value) {
  const lines = array(value, "transfer_lines_required").map((line) => ({ lotId: id(line.lotId, "transfer_lot_required"), quantity: positive(line.quantity, "transfer_quantity_invalid") }));
  if (!lines.length || new Set(lines.map((line) => line.lotId)).size !== lines.length) throw problem("transfer_lines_invalid");
  return lines;
}

function assertStateLines(lines, lots, allowEmpty = false, lossLines = false) {
  if (!Array.isArray(lines) || !allowEmpty && lines.length === 0) throw problem("trace_state_invalid", 500);
  for (const line of lines) {
    if (!lots.has(line?.lotId) || quantityValue(line.quantity, "trace_state_invalid", false) !== line.quantity) throw problem("trace_state_invalid", 500);
    if (lossLines && (!LOSS_DISPOSITIONS.has(line.disposition) || instant(line.confirmedAt) !== line.confirmedAt
      || !id(line.confirmedByActorId, "trace_state_invalid"))) throw problem("trace_state_invalid", 500);
  }
}

function id(value, code) { const result = String(value ?? "").trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw problem(code); return result; }
function text(value, code) { const result = String(value ?? "").trim(); if (!result || result.length > 240) throw problem(code); return result; }
function optionalText(value) { if (value == null) return null; return text(value, "trace_text_invalid"); }
function array(value, code) { if (!Array.isArray(value)) throw problem(code); return value; }
function nonNegative(value, code) { if (!Number.isSafeInteger(value) || value < 0) throw problem(code); return value; }
function positive(value, code) { return quantityValue(value, code, false); }
function quantityValue(value, code, allowZero) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw problem(code);
  const scaled = value * QUANTITY_SCALE;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7 || (allowZero ? rounded < 0 : rounded <= 0)) throw problem(code);
  return rounded / QUANTITY_SCALE;
}
function addQuantity(left, right) { return Math.round((left + right) * QUANTITY_SCALE) / QUANTITY_SCALE; }
function subtractQuantity(left, right) { return Math.round((left - right) * QUANTITY_SCALE) / QUANTITY_SCALE; }
function bounded(value, code, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw problem(code); return value; }
function enumValue(value, choices, code) { if (!choices.has(value)) throw problem(code); return value; }
function instant(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw problem("trace_timestamp_invalid"); return date.toISOString(); }
function optionalInstant(value) { return value == null ? null : instant(value); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hashWithoutKey(value, key) { const clone = { ...value }; delete clone[key]; return hash(clone); }
function directedCycleFrom(start, adjacency) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    if ((adjacency.get(node) ?? []).some(visit)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return visit(start);
}
function problem(message, status = 422) { const result = new Error(message); result.status = status; return result; }
