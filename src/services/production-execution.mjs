import { createHash, randomUUID } from "node:crypto";

const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);
const MAX_HPP_QUANTITY_SCALED = 1_000_000n * SCALE_FACTOR;
const MAX_HPP_UNIT_COST_SCALED = 10_000_000n * SCALE_FACTOR;
const MAX_OPERATIONAL_YIELD_TOLERANCE_BPS = 2500;
const MAX_COMPLETION_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const INPUT_MODES = new Set(["BACKFLUSH", "MEASURED"]);
const EXECUTION_MODES = new Set(["QUICK", "MULTI_STAGE", "WIP", "REWORK", "CO_PRODUCTS"]);
const ORDER_STATUSES = new Set(["PLANNED", "COMPLETED", "CANCELLED", "EXPIRED"]);
const LOSS_POLICY = "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1";
const LOSS_VALUATION_POLICY = "PROPORTIONAL_EQUIVALENT_OUTPUT_HALF_UP_RUPIAH_V1";

export class ProductionExecutionService {
  constructor({ tenantId, outletId, inventoryPort, recipeSnapshotProvider, completionHistoryPort = null, clock = () => new Date(), idFactory = randomUUID, executionIdFactory = null, requireExplicitCompletionTime = false, advancedModeEnabled = false } = {}) {
    this.tenantId = identifier(tenantId, "tenant_id_required");
    this.outletId = identifier(outletId, "outlet_id_required");
    if (!inventoryPort || typeof inventoryPort.transact !== "function") throw domainError("production_inventory_port_required");
    if (typeof recipeSnapshotProvider !== "function") throw domainError("production_recipe_snapshot_provider_required");
    if (completionHistoryPort !== null && typeof completionHistoryPort?.appendProductionCompletion !== "function") throw domainError("production_completion_history_port_invalid");
    this.inventoryPort = inventoryPort;
    this.recipeSnapshotProvider = recipeSnapshotProvider;
    this.completionHistoryPort = completionHistoryPort;
    this.clock = clock;
    this.idFactory = idFactory;
    if (executionIdFactory !== null && typeof executionIdFactory !== "function") throw domainError("production_execution_id_factory_invalid");
    this.executionIdFactory = executionIdFactory;
    this.requireExplicitCompletionTime = requireExplicitCompletionTime === true;
    this.advancedModeEnabled = advancedModeEnabled;
    this.revision = 0;
    this.orders = new Map();
    this.operations = new Map();
    this.audit = [];
    this.completionQueue = Promise.resolve();
  }

  plan(input) {
    this.#guardMetadata(input);
    const operationKey = identifier(input.operationKey, "production_operation_key_required");
    const fingerprint = sha256(normalizePlanFingerprint(input));
    const replay = this.#replay(operationKey, fingerprint);
    if (replay) return replay;
    this.#guardRevision(input);
    const executionMode = String(input.executionMode ?? "QUICK").toUpperCase();
    if (!EXECUTION_MODES.has(executionMode)) throw domainError("production_execution_mode_invalid");
    if (executionMode !== "QUICK" && !this.advancedModeEnabled) throw domainError("production_advanced_mode_not_enabled");
    const inputMode = String(input.inputMode ?? "BACKFLUSH").toUpperCase();
    if (!INPUT_MODES.has(inputMode)) throw domainError("production_input_mode_invalid");
    const recipeSnapshot = validateRecipeSnapshot(input.recipeSnapshot);
    const authoritativeSnapshot = this.recipeSnapshotProvider({
      tenantId: this.tenantId,
      outletId: this.outletId,
      recipeId: recipeSnapshot.recipeId,
      recipeVersion: recipeSnapshot.recipeVersion,
    });
    const authoritativeRecipe = authoritativeSnapshot ? validateRecipeSnapshot(authoritativeSnapshot) : null;
    if (!authoritativeRecipe || authoritativeRecipe.fingerprint !== recipeSnapshot.fingerprint) throw domainError("production_recipe_snapshot_authority_mismatch");
    const plannedOutput = validateOutput(input.plannedOutput, recipeSnapshot.output);
    const order = {
      id: input.productionOrderId ? identifier(input.productionOrderId, "production_order_id_invalid") : this.idFactory(),
      tenantId: this.tenantId,
      outletId: this.outletId,
      status: "PLANNED",
      executionMode,
      inputMode,
      recipeSnapshot,
      plannedOutput,
      yieldToleranceBps: nonNegativeInteger(
        authoritativeRecipe.yieldToleranceBps ?? input.yieldToleranceBps ?? 0,
        "production_yield_tolerance_invalid",
        MAX_OPERATIONAL_YIELD_TOLERANCE_BPS,
      ),
      createdAt: this.#now(),
      createdBy: identifier(input.actorId, "actor_id_required"),
      revision: this.revision + 1,
    };
    if ([...this.orders.values()].some((existing) => existing.id === order.id)) throw domainError("production_order_id_conflict");
    const result = { idempotentReplay: false, productionOrder: order };
    const resultHash = sha256(result);
    this.orders.set(order.id, order);
    this.#commit("PRODUCTION_PLANNED", order.id, input, {
      operationKey,
      recipeId: recipeSnapshot.recipeId,
      recipeVersion: recipeSnapshot.recipeVersion,
      orderFingerprint: sha256(order),
      operationResultHash: resultHash,
    }, order.createdAt);
    this.operations.set(operationKey, { fingerprint, resultHash, result: structuredClone(result) });
    return structuredClone(result);
  }

  async complete(input) {
    this.#guardMetadata(input);
    const operationKey = identifier(input.operationKey, "production_operation_key_required");
    const fingerprint = sha256(normalizeCompletionFingerprint(input));
    const replay = this.#replay(operationKey, fingerprint);
    if (replay) {
      await this.#appendCompletionHistory(replay, operationKey);
      return replay;
    }
    let releaseCompletion;
    const precedingCompletion = this.completionQueue;
    this.completionQueue = new Promise((resolve) => { releaseCompletion = resolve; });
    await precedingCompletion;
    try {
      const lockedReplay = this.#replay(operationKey, fingerprint);
      if (lockedReplay) {
        await this.#appendCompletionHistory(lockedReplay, operationKey);
        return lockedReplay;
      }
      this.#guardRevision(input);
    const order = this.orders.get(identifier(input.productionOrderId, "production_order_id_required"));
    if (!order) throw domainError("production_order_not_found", 404);
    if (order.status !== "PLANNED") throw domainError("production_order_not_completable");
    if (this.requireExplicitCompletionTime && input.completedAt == null) throw domainError("production_completed_at_required");
    const completedAt = timestamp(input.completedAt ?? this.#now());
    validateCompletionTime(completedAt, order.createdAt, this.#now());
    const actualOutput = validateActualOutput(input.actualOutput, order.plannedOutput, completedAt);
    validateOutputShelfLife(actualOutput, completedAt, order.recipeSnapshot.minimumShelfLifeDays ?? 0);
    this.#guardUniqueOutputLot(actualOutput);
    const expectedInputs = scaleRecipeRequirements(order.recipeSnapshot.resolvedLines, order.plannedOutput.quantity, order.recipeSnapshot.output.quantity);
    const actualInputs = order.inputMode === "BACKFLUSH"
      ? expectedInputs
      : validateMeasuredInputs(input.actualInputs, expectedInputs);
    if (order.inputMode === "MEASURED" && !Array.isArray(input.actualInputs)) throw domainError("production_measured_inputs_required");
    validateActualOutputCeiling(order.plannedOutput.quantity, actualOutput.usableQuantity, order.yieldToleranceBps);
    if (order.inputMode === "MEASURED") validateMeasuredInputVariance({
      actualInputs,
      expectedInputs,
      plannedOutput: order.plannedOutput.quantity,
      actualOutput: actualOutput.usableQuantity,
      toleranceBps: order.yieldToleranceBps,
    });
    const yieldResult = calculateYield(order.plannedOutput.quantity, actualOutput.usableQuantity, order.yieldToleranceBps);
    const executionId = this.executionIdFactory
      ? identifier(this.executionIdFactory({ tenantId: this.tenantId, outletId: this.outletId, productionOrderId: order.id, operationKey }), "production_execution_id_invalid")
      : this.idFactory();
    const transactionResult = await this.inventoryPort.transact(async (transaction) => {
      const allocations = [];
      let consumedValueScaled = 0n;
      for (const line of actualInputs) {
        const allocated = await transaction.allocateFefo({
          tenantId: this.tenantId,
          outletId: this.outletId,
          executionId,
          productionOrderId: order.id,
          sourceOperationKey: operationKey,
          locationId: identifier(input.inputLocationId, "production_input_location_required"),
          itemId: line.itemId,
          normalizedQuantity: line.normalizedQuantity,
          occurredAt: completedAt,
          eligibleStates: ["USABLE"],
        });
        validateFefoAllocation(allocated, line, completedAt);
        allocations.push(...allocated.map((lot) => ({ ...lot, itemId: line.itemId })));
        consumedValueScaled += allocated.reduce((sum, lot) => sum + parseNonNegative(lot.consumedValueRupiah, "production_consumed_value_invalid"), 0n);
      }
      validateOutputExpiryAgainstInputs(actualOutput.expiryAt, allocations);
      const usableOutputScaled = parsePositive(actualOutput.usableQuantity, "production_output_quantity_invalid");
      const lossValuation = valueProductionLoss({ consumedValueScaled, usableOutputScaled, yieldResult });
      const unitCostScaled = divideScaledRounded(lossValuation.outputValueScaled, usableOutputScaled);
      if (unitCostScaled > MAX_HPP_UNIT_COST_SCALED) throw domainError("production_inventory_cost_invalid", 422);
      const genealogy = allocations.map((allocation) => ({
        inputItemId: allocation.itemId,
        inputLotId: identifier(allocation.lotId, "production_input_lot_required"),
        normalizedQuantity: formatScaled(parsePositive(allocation.normalizedQuantity, "production_input_quantity_invalid")),
        outputLotId: actualOutput.lotId,
      }));
      const posting = {
        executionId,
        productionOrderId: order.id,
        sourceOperationKey: operationKey,
        inputLocationId: identifier(input.inputLocationId, "production_input_location_required"),
        outputLocationId: identifier(input.outputLocationId, "production_output_location_required"),
        inputAllocations: allocations,
        output: {
          itemId: actualOutput.itemId,
          lotId: actualOutput.lotId,
          expiryAt: actualOutput.expiryAt,
          usableQuantity: actualOutput.usableQuantity,
          unitCostRupiah: formatScaled(unitCostScaled),
          totalValueRupiah: formatScaled(lossValuation.outputValueScaled),
        },
        normalLossQuantity: yieldResult.normalLossQuantity,
        abnormalWasteQuantity: yieldResult.abnormalWasteQuantity,
        abnormalLossValueRupiah: lossValuation.abnormalLossValueRupiah,
        lossPolicy: LOSS_POLICY,
        lossValuationPolicy: LOSS_VALUATION_POLICY,
        completedAt,
        actorId: identifier(input.actorId, "actor_id_required"),
        reason: text(input.reason, "reason_required"),
      };
      await transaction.postProduction(posting);
      return { allocations, consumedValueScaled, unitCostScaled, lossValuation, genealogy, posting };
    });
    const execution = {
      id: executionId,
      productionOrderId: order.id,
      tenantId: this.tenantId,
      outletId: this.outletId,
      recipeId: order.recipeSnapshot.recipeId,
      recipeVersion: order.recipeSnapshot.recipeVersion,
      recipeFingerprint: order.recipeSnapshot.fingerprint,
      executionMode: order.executionMode,
      inputMode: order.inputMode,
      expectedInputs,
      actualInputs,
      plannedOutput: order.plannedOutput,
      actualOutput,
      yield: yieldResult,
      inputLotAllocations: transactionResult.allocations,
      genealogy: transactionResult.genealogy,
      actualConsumedValueRupiah: formatScaled(transactionResult.consumedValueScaled),
      actualOutputInventoryValueRupiah: formatScaled(transactionResult.lossValuation.outputValueScaled),
      abnormalLossValueRupiah: transactionResult.lossValuation.abnormalLossValueRupiah,
      lossPolicy: LOSS_POLICY,
      lossValuationPolicy: LOSS_VALUATION_POLICY,
      actualUnitCostRupiah: formatScaled(transactionResult.unitCostScaled),
      inputLocationId: identifier(input.inputLocationId, "production_input_location_required"),
      outputLocationId: identifier(input.outputLocationId, "production_output_location_required"),
      completedAt,
      actorId: identifier(input.actorId, "actor_id_required"),
      revision: this.revision + 1,
    };
    const executionPayload = structuredClone(execution);
    execution.hash = sha256(executionPayload);
    const completedOrder = { ...order, status: "COMPLETED", executionId: execution.id, completedAt, revision: this.revision + 1 };
    const result = { idempotentReplay: false, productionOrder: completedOrder, execution };
    const resultHash = sha256(result);
    this.orders.set(order.id, completedOrder);
    this.#commit("PRODUCTION_COMPLETED", order.id, input, {
      operationKey,
      executionId: execution.id,
      executionHash: execution.hash,
      abnormalLossValueRupiah: execution.abnormalLossValueRupiah,
      lossPolicy: execution.lossPolicy,
      lossValuationPolicy: execution.lossValuationPolicy,
      orderFingerprint: sha256(completedOrder),
      operationResultHash: resultHash,
    }, completedAt);
    const operation = { fingerprint, resultHash, result: structuredClone(result) };
    this.operations.set(operationKey, operation);
    operation.completionSourceState = completionSourceSnapshot(this.exportState());
    await this.#appendCompletionHistory(result, operationKey);
    return structuredClone(result);
    } finally {
      releaseCompletion();
    }
  }

  cancel(input) {
    return this.#closePlannedOrder(input, "CANCELLED", "cancelledAt", "PRODUCTION_CANCELLED", normalizeCancellationFingerprint);
  }

  expire(input) {
    return this.#closePlannedOrder(input, "EXPIRED", "expiredAt", "PRODUCTION_EXPIRED", normalizeExpiryFingerprint);
  }

  view() {
    return structuredClone({ tenantId: this.tenantId, outletId: this.outletId, revision: this.revision, orders: [...this.orders.values()], audit: this.audit });
  }

  exportState() {
    const payload = {
      stateVersion: 1,
      tenantId: this.tenantId,
      outletId: this.outletId,
      revision: this.revision,
      orders: [...this.orders.values()],
      operations: [...this.operations.entries()].map(([operationKey, record]) => ({ operationKey, ...record })),
      audit: this.audit,
    };
    return structuredClone({ ...payload, stateHash: sha256(payload) });
  }

  restoreState(state) {
    if (!state || state.stateVersion !== 1 || state.tenantId !== this.tenantId || state.outletId !== this.outletId || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.orders) || !Array.isArray(state.operations) || !Array.isArray(state.audit)) throw domainError("production_state_invalid", 500);
    const { stateHash, ...payload } = state;
    if (typeof stateHash !== "string" || stateHash !== sha256(payload)) throw domainError("production_state_tampered", 500);
    validateAudit(state.audit, state.revision, this.tenantId, this.outletId);
    const orders = new Map();
    for (const stored of state.orders) {
      const order = validateStoredOrder(stored, state.revision, this.tenantId, this.outletId);
      if (orders.has(order.id)) throw domainError("production_state_invalid", 500);
      orders.set(order.id, order);
    }
    const operations = new Map();
    for (const stored of state.operations) {
      const operationKey = identifier(stored.operationKey, "production_state_invalid");
      if (operations.has(operationKey) || !/^[0-9a-f]{64}$/.test(stored.fingerprint)) throw domainError("production_state_invalid", 500);
      if (typeof stored.resultHash !== "string" || stored.resultHash !== sha256(stored.result)) throw domainError("production_state_tampered", 500);
      validateStoredOperationResult(stored, orders, state.audit, this.tenantId, this.outletId);
      if (stored.completionSourceState !== undefined) validateCompletionSourceState(stored.completionSourceState, stored, this.tenantId, this.outletId);
      operations.set(operationKey, {
        fingerprint: stored.fingerprint,
        resultHash: stored.resultHash,
        result: structuredClone(stored.result),
        ...(stored.completionSourceState === undefined ? {} : { completionSourceState: structuredClone(stored.completionSourceState) }),
      });
    }
    validateOrderAuditLinks(orders, state.audit);
    this.revision = state.revision;
    this.orders = orders;
    this.operations = operations;
    this.audit = structuredClone(state.audit);
    return this.view();
  }

  #replay(operationKey, fingerprint) {
    const existing = this.operations.get(operationKey);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw domainError("production_operation_collision", 409);
    return { ...structuredClone(existing.result), idempotentReplay: true };
  }

  async #appendCompletionHistory(result, operationKey) {
    if (!this.completionHistoryPort || !result?.execution) return;
    const operation = this.operations.get(operationKey);
    const state = operation?.completionSourceState
      ?? (this.revision === result.execution.revision ? completionSourceSnapshot(this.exportState()) : null);
    if (!state) throw domainError("production_completion_history_snapshot_unavailable", 409);
    await this.completionHistoryPort.appendProductionCompletion({
      organizationId: this.tenantId,
      outletId: this.outletId,
      productionOrderId: result.execution.productionOrderId,
      state: structuredClone(state),
    });
  }

  #guardMetadata(input) {
    identifier(input.actorId, "actor_id_required");
    text(input.reason, "reason_required");
  }

  #guardRevision(input) {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== this.revision) throw domainError("production_revision_conflict", 409);
  }

  #closePlannedOrder(input, status, timestampField, auditAction, fingerprintNormalizer) {
    this.#guardMetadata(input);
    const operationKey = identifier(input.operationKey, "production_operation_key_required");
    const fingerprint = sha256(fingerprintNormalizer(input));
    const replay = this.#replay(operationKey, fingerprint);
    if (replay) return replay;
    this.#guardRevision(input);
    const order = this.orders.get(identifier(input.productionOrderId, "production_order_id_required"));
    if (!order) throw domainError("production_order_not_found", 404);
    if (order.status !== "PLANNED") throw domainError("production_order_not_closable", 409);
    const occurredAt = timestamp(input[timestampField] ?? this.#now());
    validateLifecycleTime(occurredAt, order.createdAt, this.#now());
    const closed = {
      ...order,
      status,
      [timestampField]: occurredAt,
      closedBy: identifier(input.actorId, "actor_id_required"),
      closeReason: text(input.reason, "reason_required"),
      revision: this.revision + 1,
    };
    const result = { idempotentReplay: false, productionOrder: closed };
    const resultHash = sha256(result);
    this.orders.set(order.id, closed);
    this.#commit(auditAction, order.id, input, {
      operationKey,
      orderFingerprint: sha256(closed),
      operationResultHash: resultHash,
    }, occurredAt);
    this.operations.set(operationKey, { fingerprint, resultHash, result: structuredClone(result) });
    return structuredClone(result);
  }

  #guardUniqueOutputLot(output) {
    for (const operation of this.operations.values()) {
      const prior = operation.result?.execution?.actualOutput;
      if (prior?.itemId === output.itemId && prior?.lotId === output.lotId) throw domainError("production_output_lot_conflict", 409);
    }
  }

  #commit(action, aggregateId, input, detail, occurredAt) {
    this.revision += 1;
    const payload = {
      id: sha256({ tenantId: this.tenantId, outletId: this.outletId, revision: this.revision, action, aggregateId }).slice(0, 32),
      tenantId: this.tenantId, outletId: this.outletId, revision: this.revision, action, aggregateId,
      actorId: input.actorId, reason: input.reason.trim(), detail: structuredClone(detail), occurredAt: timestamp(occurredAt),
    };
    this.audit.push({ ...payload, hash: sha256(payload) });
  }

  #now() {
    return timestamp(this.clock());
  }
}

function validateRecipeSnapshot(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.recipeVersion) || snapshot.recipeVersion < 1 || !Array.isArray(snapshot.resolvedLines)) throw domainError("production_recipe_snapshot_invalid");
  const recipeId = identifier(snapshot.recipeId, "production_recipe_id_required");
  const payload = { ...snapshot };
  const fingerprint = payload.fingerprint;
  delete payload.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint !== sha256(payload)) throw domainError("production_recipe_snapshot_invalid");
  const output = {
    itemId: identifier(snapshot.output?.itemId, "production_output_item_required"),
    quantity: formatScaled(parsePositive(snapshot.output?.quantity, "production_output_quantity_invalid")),
    normalizedUom: text(snapshot.output?.normalizedUom, "production_output_uom_required").toLowerCase(),
  };
  const resolvedLines = snapshot.resolvedLines.map((line) => ({
    itemId: identifier(line.itemId, "production_input_item_required"),
    normalizedQuantity: formatScaled(parsePositive(line.normalizedQuantity, "production_input_quantity_invalid")),
    normalizedUom: text(line.normalizedUom, "production_input_uom_required").toLowerCase(),
  }));
  if (new Set(resolvedLines.map((line) => line.itemId)).size !== resolvedLines.length) throw domainError("production_recipe_snapshot_invalid");
  const policy = {};
  if (snapshot.yieldToleranceBps !== undefined) {
    policy.yieldToleranceBps = nonNegativeInteger(snapshot.yieldToleranceBps, "production_recipe_snapshot_invalid", MAX_OPERATIONAL_YIELD_TOLERANCE_BPS);
  }
  if (snapshot.minimumShelfLifeDays !== undefined) {
    policy.minimumShelfLifeDays = nonNegativeInteger(snapshot.minimumShelfLifeDays, "production_recipe_snapshot_invalid", 3650);
  }
  return { recipeId, recipeVersion: snapshot.recipeVersion, output, resolvedLines, ...policy, fingerprint };
}

function validateStoredOrder(stored, maximumRevision, tenantId, outletId) {
  if (!stored || stored.tenantId !== tenantId || stored.outletId !== outletId || !ORDER_STATUSES.has(stored.status)
    || !EXECUTION_MODES.has(stored.executionMode) || !INPUT_MODES.has(stored.inputMode)
    || !Number.isSafeInteger(stored.revision) || stored.revision < 1 || stored.revision > maximumRevision) throw domainError("production_state_invalid", 500);
  const recipeSnapshot = validateRecipeSnapshot(stored.recipeSnapshot);
  const plannedOutput = validateOutput(stored.plannedOutput, recipeSnapshot.output);
  const order = {
    id: identifier(stored.id, "production_state_invalid"), tenantId, outletId, status: stored.status,
    executionMode: stored.executionMode, inputMode: stored.inputMode, recipeSnapshot, plannedOutput,
    yieldToleranceBps: nonNegativeInteger(stored.yieldToleranceBps, "production_state_invalid", 10000),
    createdAt: timestamp(stored.createdAt), createdBy: identifier(stored.createdBy, "production_state_invalid"), revision: stored.revision,
  };
  if (stored.status === "COMPLETED") {
    order.executionId = identifier(stored.executionId, "production_state_invalid");
    order.completedAt = timestamp(stored.completedAt);
  } else if (stored.status === "CANCELLED" || stored.status === "EXPIRED") {
    const field = stored.status === "CANCELLED" ? "cancelledAt" : "expiredAt";
    order[field] = timestamp(stored[field]);
    order.closedBy = identifier(stored.closedBy, "production_state_invalid");
    order.closeReason = text(stored.closeReason, "production_state_invalid");
  }
  return order;
}

function validateStoredOperationResult(stored, orders, audit, tenantId, outletId) {
  const allowedOperationKeys = new Set(["operationKey", "fingerprint", "resultHash", "result", "completionSourceState"]);
  if (Object.keys(stored).some((key) => !allowedOperationKeys.has(key))) throw domainError("production_state_tampered", 500);
  const result = stored.result;
  if (!result || result.idempotentReplay !== false || !result.productionOrder) throw domainError("production_state_invalid", 500);
  const allowedKeys = result.execution ? ["idempotentReplay", "productionOrder", "execution"] : ["idempotentReplay", "productionOrder"];
  if (Object.keys(result).sort().join("\u0000") !== allowedKeys.sort().join("\u0000")) throw domainError("production_state_tampered", 500);
  const current = orders.get(result.productionOrder.id);
  if (!current || result.productionOrder.tenantId !== tenantId || result.productionOrder.outletId !== outletId) throw domainError("production_state_invalid", 500);
  const matchingAudit = audit.filter((event) => event.detail?.operationKey === stored.operationKey);
  if (matchingAudit.length !== 1 || matchingAudit[0].detail.operationResultHash !== stored.resultHash) throw domainError("production_state_tampered", 500);
  if (result.execution) {
    const execution = result.execution;
    if (execution.tenantId !== tenantId || execution.outletId !== outletId || execution.productionOrderId !== current.id || execution.id !== current.executionId || typeof execution.hash !== "string") throw domainError("production_state_invalid", 500);
    const { hash, ...payload } = execution;
    if (hash !== sha256(payload)) throw domainError("production_state_tampered", 500);
  }
}

function completionSourceSnapshot(state) {
  const { stateHash: _ignored, ...payload } = structuredClone(state);
  payload.operations = payload.operations.map(({ completionSourceState: _nested, ...operation }) => operation);
  return { ...payload, stateHash: sha256(payload) };
}

function validateCompletionSourceState(source, stored, tenantId, outletId) {
  if (!stored.result?.execution || !source || source.tenantId !== tenantId || source.outletId !== outletId
    || source.revision !== stored.result.execution.revision || source.operations?.some((operation) => operation.completionSourceState !== undefined)) {
    throw domainError("production_completion_history_snapshot_invalid", 500);
  }
  const verifier = new ProductionExecutionService({
    tenantId,
    outletId,
    inventoryPort: { async transact() { throw domainError("production_inventory_write_denied", 500); } },
    recipeSnapshotProvider: () => null,
  });
  verifier.restoreState(structuredClone(source));
  const sourceOperation = source.operations.find((operation) => operation.operationKey === stored.operationKey);
  if (!sourceOperation || sourceOperation.resultHash !== stored.resultHash || sha256(sourceOperation.result) !== stored.resultHash) {
    throw domainError("production_completion_history_snapshot_invalid", 500);
  }
}

function validateOrderAuditLinks(orders, audit) {
  const auditByRevision = new Map(audit.map((event) => [event.revision, event]));
  for (const order of orders.values()) {
    const event = auditByRevision.get(order.revision);
    if (!event || event.aggregateId !== order.id || event.detail?.orderFingerprint !== sha256(order)) throw domainError("production_state_tampered", 500);
  }
}

function validateAudit(audit, revision, tenantId, outletId) {
  if (audit.length !== revision) throw domainError("production_state_invalid", 500);
  for (let index = 0; index < audit.length; index += 1) {
    const event = audit[index];
    if (event.tenantId !== tenantId || event.outletId !== outletId || event.revision !== index + 1) throw domainError("production_state_invalid", 500);
    const { hash, ...payload } = event;
    if (typeof hash !== "string" || hash !== sha256(payload)) throw domainError("production_state_tampered", 500);
  }
}

function validateOutput(output, recipeOutput) {
  if (!output || output.itemId !== recipeOutput.itemId || String(output.normalizedUom ?? "").toLowerCase() !== recipeOutput.normalizedUom) throw domainError("production_output_recipe_mismatch");
  return { itemId: recipeOutput.itemId, quantity: formatScaled(parsePositive(output.quantity, "production_output_quantity_invalid")), normalizedUom: recipeOutput.normalizedUom };
}

function validateActualOutput(output, planned, completedAt) {
  if (!output || output.itemId !== planned.itemId || String(output.normalizedUom ?? "").toLowerCase() !== planned.normalizedUom) throw domainError("production_output_plan_mismatch");
  const lotId = identifier(output.lotId, "production_output_lot_required");
  const expiryAt = timestamp(output.expiryAt);
  if (new Date(expiryAt) <= new Date(completedAt)) throw domainError("production_output_expiry_invalid");
  return { itemId: planned.itemId, usableQuantity: formatScaled(parsePositive(output.usableQuantity, "production_output_quantity_invalid")), normalizedUom: planned.normalizedUom, lotId, expiryAt };
}

function validateCompletionTime(completedAt, createdAt, now) {
  const completed = new Date(completedAt).getTime();
  const created = new Date(createdAt).getTime();
  const current = new Date(now).getTime();
  if (completed < created) throw domainError("production_completed_before_plan", 409);
  if (completed > current + MAX_COMPLETION_FUTURE_SKEW_MS) throw domainError("production_completed_at_future", 409);
}

function validateLifecycleTime(occurredAt, createdAt, now) {
  const occurred = new Date(occurredAt).getTime();
  if (occurred < new Date(createdAt).getTime()) throw domainError("production_lifecycle_time_invalid", 409);
  if (occurred > new Date(now).getTime() + MAX_COMPLETION_FUTURE_SKEW_MS) throw domainError("production_lifecycle_time_invalid", 409);
}

function validateOutputShelfLife(output, completedAt, minimumShelfLifeDays) {
  const minimumExpiry = new Date(completedAt).getTime() + minimumShelfLifeDays * 24 * 60 * 60 * 1000;
  if (new Date(output.expiryAt).getTime() < minimumExpiry) throw domainError("production_output_shelf_life_too_short", 409);
}

function validateOutputExpiryAgainstInputs(outputExpiryAt, allocations) {
  const tracked = allocations.filter((allocation) => !String(allocation.lotId).startsWith("UNTRACKED:") && new Date(allocation.expiryAt).getUTCFullYear() < 9999);
  if (!tracked.length) return;
  const earliestInputExpiry = Math.min(...tracked.map((allocation) => new Date(allocation.expiryAt).getTime()));
  if (new Date(outputExpiryAt).getTime() > earliestInputExpiry) throw domainError("production_output_expiry_exceeds_input", 409);
}

function scaleRecipeRequirements(lines, plannedOutput, recipeYield) {
  const batches = divideScaled(parsePositive(plannedOutput, "production_output_quantity_invalid"), parsePositive(recipeYield, "production_recipe_yield_invalid"));
  return lines.map((line) => ({ ...line, normalizedQuantity: formatScaled(multiplyScaled(parsePositive(line.normalizedQuantity, "production_input_quantity_invalid"), batches)) }));
}

function validateMeasuredInputs(inputs, expected) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw domainError("production_measured_inputs_required");
  const expectedById = new Map(expected.map((line) => [line.itemId, line]));
  const result = inputs.map((line) => {
    const itemId = identifier(line.itemId, "production_input_item_required");
    const expectedLine = expectedById.get(itemId);
    if (!expectedLine || String(line.normalizedUom ?? "").toLowerCase() !== expectedLine.normalizedUom) throw domainError("production_measured_input_mismatch");
    expectedById.delete(itemId);
    return { itemId, normalizedQuantity: formatScaled(parsePositive(line.normalizedQuantity, "production_input_quantity_invalid")), normalizedUom: expectedLine.normalizedUom };
  });
  if (expectedById.size > 0 || new Set(result.map((line) => line.itemId)).size !== result.length) throw domainError("production_measured_input_mismatch");
  return result;
}

function validateActualOutputCeiling(plannedOutput, actualOutput, toleranceBps) {
  const planned = parsePositive(plannedOutput, "production_output_quantity_invalid");
  const actual = parsePositive(actualOutput, "production_output_quantity_invalid");
  const maximum = planned + planned * BigInt(toleranceBps) / 10000n;
  if (actual > maximum) throw domainError("production_output_above_tolerance", 409);
}

function validateMeasuredInputVariance({ actualInputs, expectedInputs, plannedOutput, actualOutput, toleranceBps }) {
  const planned = parsePositive(plannedOutput, "production_output_quantity_invalid");
  const actualOutputScaled = parsePositive(actualOutput, "production_output_quantity_invalid");
  const actualByItem = new Map(actualInputs.map((line) => [line.itemId, parsePositive(line.normalizedQuantity, "production_input_quantity_invalid")]));
  for (const expected of expectedInputs) {
    const expectedScaled = parsePositive(expected.normalizedQuantity, "production_input_quantity_invalid");
    const actualScaled = actualByItem.get(expected.itemId);
    const minimumNumerator = expectedScaled * actualOutputScaled * BigInt(10000 - toleranceBps);
    const minimumDenominator = planned * 10000n;
    const minimum = (minimumNumerator + minimumDenominator - 1n) / minimumDenominator;
    if (actualScaled < minimum) throw domainError("production_measured_input_below_tolerance", 409);
  }
}

function calculateYield(plannedOutput, actualUsableOutput, toleranceBps) {
  const planned = parsePositive(plannedOutput, "production_output_quantity_invalid");
  const actual = parsePositive(actualUsableOutput, "production_output_quantity_invalid");
  const shortfall = planned > actual ? planned - actual : 0n;
  const tolerance = planned * BigInt(toleranceBps) / 10000n;
  const normalLoss = shortfall < tolerance ? shortfall : tolerance;
  const abnormal = shortfall - normalLoss;
  return {
    plannedQuantity: formatScaled(planned),
    usableQuantity: formatScaled(actual),
    yieldPct: ratioPercent(actual, planned),
    normalLossQuantity: formatScaled(normalLoss),
    abnormalWasteQuantity: formatScaled(abnormal),
    abovePlanQuantity: formatScaled(actual > planned ? actual - planned : 0n),
    withinTolerance: abnormal === 0n,
  };
}

function valueProductionLoss({ consumedValueScaled, usableOutputScaled, yieldResult }) {
  if (consumedValueScaled <= 0n || consumedValueScaled % SCALE_FACTOR !== 0n) throw domainError("production_cost_precision_unavailable", 409);
  const abnormalUnits = parseNonNegative(yieldResult.abnormalWasteQuantity, "production_abnormal_loss_quantity_invalid");
  const equivalentOutputUnits = usableOutputScaled + abnormalUnits;
  const inputValueRupiah = consumedValueScaled / SCALE_FACTOR;
  if (inputValueRupiah > BigInt(Number.MAX_SAFE_INTEGER)) throw domainError("production_value_overflow", 422);
  const abnormalValueRupiah = divideIntegerHalfUp(inputValueRupiah * abnormalUnits, equivalentOutputUnits);
  const outputValueRupiah = inputValueRupiah - abnormalValueRupiah;
  if (outputValueRupiah <= 0n || abnormalValueRupiah > BigInt(Number.MAX_SAFE_INTEGER)) throw domainError("production_abnormal_loss_value_invalid", 409);
  return {
    abnormalLossValueRupiah: Number(abnormalValueRupiah),
    outputValueScaled: outputValueRupiah * SCALE_FACTOR,
  };
}

function divideIntegerHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw domainError("production_abnormal_loss_value_invalid", 409);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function validateFefoAllocation(allocated, line, occurredAt) {
  if (!Array.isArray(allocated) || allocated.length === 0) throw domainError("production_fefo_allocation_missing");
  let total = 0n;
  let priorExpiry = null;
  const lotIds = new Set();
  const occurred = new Date(timestamp(occurredAt)).getTime();
  for (const lot of allocated) {
    const quantity = parsePositive(lot.normalizedQuantity, "production_input_quantity_invalid");
    const expiry = new Date(timestamp(lot.expiryAt)).getTime();
    const lotId = identifier(lot.lotId, "production_input_lot_required");
    if (lotIds.has(lotId)) throw domainError("production_fefo_allocation_duplicate");
    lotIds.add(lotId);
    if (expiry <= occurred) throw domainError("production_fefo_allocation_expired");
    if (lot.qualityState !== "USABLE" || (priorExpiry !== null && expiry < priorExpiry)) throw domainError("production_fefo_allocation_invalid");
    priorExpiry = expiry;
    total += quantity;
  }
  if (formatScaled(total) !== line.normalizedQuantity) throw domainError("production_fefo_quantity_mismatch");
}

function normalizePlanFingerprint(input) {
  return {
    productionOrderId: input.productionOrderId ?? null,
    executionMode: String(input.executionMode ?? "QUICK").toUpperCase(),
    inputMode: String(input.inputMode ?? "BACKFLUSH").toUpperCase(),
    recipeSnapshot: input.recipeSnapshot,
    plannedOutput: input.plannedOutput,
    yieldToleranceBps: input.yieldToleranceBps ?? 0,
  };
}

function normalizeCompletionFingerprint(input) {
  return {
    productionOrderId: input.productionOrderId,
    inputLocationId: input.inputLocationId,
    outputLocationId: input.outputLocationId,
    actualInputs: input.actualInputs ?? null,
    actualOutput: input.actualOutput,
    completedAt: input.completedAt ?? null,
  };
}

function normalizeCancellationFingerprint(input) {
  return { productionOrderId: input.productionOrderId, cancelledAt: input.cancelledAt ?? null };
}

function normalizeExpiryFingerprint(input) {
  return { productionOrderId: input.productionOrderId, expiredAt: input.expiredAt ?? null };
}

function parseDecimal(value, code) {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(source) || source.length > 48) throw domainError(code);
  const [whole, fraction = ""] = source.split(".");
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, "0"));
}

function parseNonNegative(value, code) {
  return parseDecimal(value, code);
}

function parsePositive(value, code) {
  const parsed = parseDecimal(value, code);
  if (parsed > MAX_HPP_QUANTITY_SCALED) throw domainError("production_quantity_overflow");
  if (parsed <= 0n) throw domainError(code);
  return parsed;
}

function multiplyScaled(left, right) {
  const product = left * right;
  if (product % SCALE_FACTOR !== 0n) throw domainError("production_precision_exceeded");
  return product / SCALE_FACTOR;
}

function divideScaled(numerator, denominator) {
  const scaled = numerator * SCALE_FACTOR;
  if (scaled % denominator !== 0n) throw domainError("production_precision_exceeded");
  return scaled / denominator;
}

function divideScaledRounded(numerator, denominator) {
  const scaled = numerator * SCALE_FACTOR;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function ratioPercent(numerator, denominator) {
  const basisPoints = numerator * 10000n / denominator;
  if (basisPoints > BigInt(Number.MAX_SAFE_INTEGER)) throw domainError("production_quantity_overflow");
  return Number(basisPoints) / 100;
}

function formatScaled(value) {
  const whole = value / SCALE_FACTOR;
  const fraction = (value % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function identifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) throw domainError(code);
  return normalized;
}

function text(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) throw domainError(code);
  return normalized;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw domainError("production_timestamp_invalid");
  return date.toISOString();
}

function nonNegativeInteger(value, code, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw domainError(code);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function domainError(message, status = 422) {
  const error = new Error(message);
  error.status = status;
  return error;
}
