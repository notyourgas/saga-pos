import { createHash, randomUUID } from "node:crypto";

const CONTRACT = "SAGAPOS_INVENTORY_VALUATION_V1";
const STATE_VERSION = 1;
const DECIMAL_SCALE = 6;
const QUANTITY_FACTOR = 1_000_000n;
const ZERO_HASH = "0".repeat(64);
const ALLOCATION_METHODS = new Set(["VALUE", "QUANTITY", "WEIGHT", "VOLUME", "EQUAL", "MANUAL"]);
const PRODUCTION_LOSS_POLICY = "NORMAL_LOSS_ABSORBED_ABNORMAL_LOSS_EXPLICIT_V1";
const MAX_FACTS = 100_000;

export class InventoryValuationError extends Error {
  constructor(code, detail = undefined) {
    super(code);
    this.name = "InventoryValuationError";
    this.code = code;
    this.detail = detail;
  }
}

export class InventoryValuationLedger {
  #idFactory;
  #facts = [];
  #operations = new Map();
  #receipts = new Map();
  #revaluations = new Map();
  #revaluationIds = new Set();
  #invoiceIds = new Set();
  #consumptionIds = new Set();
  #consumptions = new Map();
  #productionIds = new Set();
  #executionIds = new Set();
  #productions = new Map();
  #balances = new Map();

  constructor({ idFactory = randomUUID } = {}) {
    if (typeof idFactory !== "function") throw failure("valuation_id_factory_invalid");
    this.#idFactory = idFactory;
  }

  recordProvisionalReceipt(command = {}) {
    const normalized = normalizeReceiptCommand(command);
    return this.#execute("PROVISIONAL_RECEIPT", normalized);
  }

  recordConsumption(command = {}) {
    const normalized = normalizeConsumptionCommand(command);
    const postedLines = quoteConsumption(this.#facts, normalized.scope, normalized.effectiveAt, normalized.request.lines);
    return this.#execute("INVENTORY_CONSUMPTION", {
      ...normalized,
      request: { ...normalized.request, lines: postedLines },
    });
  }

  recordProductionTransformation(command = {}) {
    const normalized = normalizeProductionCommand(command);
    const quotedLines = quoteProductionInputs(this.#facts, normalized.scope, normalized.effectiveAt, normalized.request.inputs);
    const postedLines = normalized.request.inputs.every((line) => Object.hasOwn(line, "postedInventoryValueRupiah"))
      ? normalized.request.inputs
      : quotedLines;
    const postedInputValueRupiah = sumMoney(postedLines.map((line) => line.postedInventoryValueRupiah));
    const abnormalValueRupiah = productionAbnormalLossValue(postedInputValueRupiah, normalized.request.output.quantityBase, normalized.request.loss.abnormalQuantityBase);
    if (normalized.request.loss.abnormalValueRupiah !== undefined && normalized.request.loss.abnormalValueRupiah !== abnormalValueRupiah) throw failure("valuation_production_abnormal_loss_authority_mismatch");
    const postedOutputValueRupiah = subtractMoney(postedInputValueRupiah, abnormalValueRupiah);
    if (normalized.request.output.postedInventoryValueRupiah !== undefined && normalized.request.output.postedInventoryValueRupiah !== postedOutputValueRupiah) throw failure("valuation_production_value_unbalanced");
    if (postedOutputValueRupiah <= 0) throw failure("valuation_production_output_cost_required");
    return this.#execute("PRODUCTION_TRANSFORMATION", {
      ...normalized,
      request: {
        ...normalized.request,
        inputs: postedLines,
        output: { ...normalized.request.output, postedInventoryValueRupiah: postedOutputValueRupiah },
        loss: { ...normalized.request.loss, abnormalValueRupiah },
      },
    });
  }

  assessReceiptRevaluation(command = {}) {
    const normalized = normalizeRevaluationCommand(command);
    return structuredClone(this.#planRevaluation(normalized));
  }

  recordReceiptRevaluation(command = {}) {
    const normalized = normalizeRevaluationCommand(command);
    return this.#execute("RECEIPT_REVALUATION", normalized);
  }

  viewScope(scope = {}) {
    const normalized = normalizeScope(scope);
    const key = scopeKey(normalized);
    return structuredClone({
      contract: CONTRACT,
      scope: normalized,
      balances: [...this.#balances.entries()]
        .filter(([balanceKey]) => balanceKey.startsWith(`${key}\u0000`))
        .map(([, balance]) => balanceView(balance))
        .sort((left, right) => left.ingredientId.localeCompare(right.ingredientId)),
      receipts: [...this.#receipts.values()]
        .filter((receipt) => scopeKey(receipt.scope) === key)
        .sort((left, right) => left.sequence - right.sequence),
      revaluations: [...this.#revaluations.values()]
        .filter((revaluation) => scopeKey(revaluation.scope) === key)
        .sort((left, right) => left.sequence - right.sequence),
      consumptions: [...this.#consumptions.values()]
        .filter((consumption) => scopeKey(consumption.scope) === key)
        .sort((left, right) => left.sequence - right.sequence),
      productions: [...this.#productions.values()]
        .filter((production) => scopeKey(production.scope) === key)
        .sort((left, right) => left.sequence - right.sequence),
    });
  }

  exportState() {
    return structuredClone({ contract: CONTRACT, stateVersion: STATE_VERSION, facts: this.#facts });
  }

  restoreState(state) {
    try {
      assertExactKeys(state, ["contract", "facts", "stateVersion"], ["contract", "facts", "stateVersion"], "valuation_state_invalid");
      if (state.contract !== CONTRACT || state.stateVersion !== STATE_VERSION || !Array.isArray(state.facts) || state.facts.length > MAX_FACTS) throw failure("valuation_state_invalid");
      const candidate = new InventoryValuationLedger({ idFactory: this.#idFactory });
      for (const fact of state.facts) candidate.#appendPersistedFact(fact);
      this.#adopt(candidate);
    } catch (error) {
      if (error instanceof InventoryValuationError && error.code === "valuation_state_tampered") throw error;
      throw failure("valuation_state_tampered", error instanceof InventoryValuationError ? error.code : undefined);
    }
  }

  #execute(type, normalized) {
    const operationIdentity = operationKey(normalized.scope, normalized.operationKey);
    if (type === "RECEIPT_REVALUATION") this.#planRevaluation(normalized, true);
    const requestFingerprint = inventoryValuationFingerprint({ type, scope: normalized.scope, occurredAt: normalized.occurredAt, effectiveAt: normalized.effectiveAt, request: normalized.request });
    const existing = this.#operations.get(operationIdentity);
    if (existing) {
      if (existing.type !== type || existing.requestFingerprint !== requestFingerprint) throw failure("valuation_operation_conflict", normalized.operationKey);
      return this.#response(existing, true);
    }

    const candidate = new InventoryValuationLedger({ idFactory: this.#idFactory });
    candidate.restoreState(this.exportState());
    const factId = cleanId(candidate.#idFactory(), "valuation_fact_id_invalid");
    const previousFactHash = candidate.#facts.at(-1)?.factHash ?? ZERO_HASH;
    const factWithoutHash = {
      sequence: candidate.#facts.length + 1,
      factId,
      type,
      scope: normalized.scope,
      operationKey: normalized.operationKey,
      occurredAt: normalized.occurredAt,
      effectiveAt: normalized.effectiveAt,
      request: normalized.request,
      requestFingerprint,
      previousFactHash,
    };
    const fact = { ...factWithoutHash, factHash: inventoryValuationFingerprint(factWithoutHash) };
    candidate.#appendPersistedFact(fact);
    this.#adopt(candidate);
    return this.#response(this.#facts.at(-1), false);
  }

  #appendPersistedFact(input) {
    assertExactKeys(input,
      ["effectiveAt", "factHash", "factId", "occurredAt", "operationKey", "previousFactHash", "request", "requestFingerprint", "scope", "sequence", "type"],
      ["effectiveAt", "factHash", "factId", "occurredAt", "operationKey", "previousFactHash", "request", "requestFingerprint", "scope", "sequence", "type"],
      "valuation_state_tampered");
    if (!Number.isSafeInteger(input.sequence) || input.sequence !== this.#facts.length + 1) throw failure("valuation_state_tampered");
    const factId = cleanId(input.factId, "valuation_state_tampered");
    if (this.#facts.some((fact) => fact.factId === factId)) throw failure("valuation_state_tampered");
    const scope = normalizeScope(input.scope);
    const operationKeyValue = cleanId(input.operationKey, "valuation_operation_key_invalid");
    const occurredAt = timestamp(input.occurredAt);
    const effectiveAt = timestamp(input.effectiveAt);
    const type = input.type;
    const request = type === "PROVISIONAL_RECEIPT" ? normalizeReceiptRequest(input.request)
      : type === "RECEIPT_REVALUATION" ? normalizeRevaluationRequest(input.request)
        : type === "INVENTORY_CONSUMPTION" ? normalizeConsumptionRequest(input.request, true)
          : type === "PRODUCTION_TRANSFORMATION" ? normalizeProductionRequest(input.request, true)
          : null;
    if (!request || canonical(input.request) !== canonical(request)) throw failure("valuation_state_tampered");
    const requestFingerprint = inventoryValuationFingerprint({ type, scope, occurredAt, effectiveAt, request });
    const previousFactHash = this.#facts.at(-1)?.factHash ?? ZERO_HASH;
    if (input.requestFingerprint !== requestFingerprint || input.previousFactHash !== previousFactHash) throw failure("valuation_state_tampered");
    const normalizedFactWithoutHash = {
      sequence: input.sequence,
      factId,
      type,
      scope,
      operationKey: operationKeyValue,
      occurredAt,
      effectiveAt,
      request,
      requestFingerprint,
      previousFactHash,
    };
    const factHash = inventoryValuationFingerprint(normalizedFactWithoutHash);
    if (input.factHash !== factHash) throw failure("valuation_state_tampered");
    const operationIdentity = operationKey(scope, operationKeyValue);
    if (this.#operations.has(operationIdentity)) throw failure("valuation_state_tampered");

    const fact = deepFreeze({ ...normalizedFactWithoutHash, factHash });
    this.#registerFact(fact);
    this.#facts.push(fact);
    this.#operations.set(operationIdentity, fact);
    this.#rebuild();
  }

  #registerFact(fact) {
    if (fact.type === "PROVISIONAL_RECEIPT") {
      const identity = receiptKey(fact.scope, fact.request.receiptId);
      if (this.#receipts.has(identity)) throw failure("valuation_receipt_conflict", fact.request.receiptId);
      return;
    }
    if (fact.type === "INVENTORY_CONSUMPTION") {
      const identity = receiptKey(fact.scope, fact.request.consumptionId);
      if (this.#consumptionIds.has(identity)) throw failure("valuation_consumption_conflict", fact.request.consumptionId);
      this.#consumptionIds.add(identity);
      return;
    }
    if (fact.type === "PRODUCTION_TRANSFORMATION") {
      const productionIdentity = receiptKey(fact.scope, fact.request.productionId);
      const executionIdentity = receiptKey(fact.scope, fact.request.executionId);
      if (this.#productionIds.has(productionIdentity) || this.#executionIds.has(executionIdentity)) {
        throw failure("valuation_production_conflict", fact.request.productionId);
      }
      this.#productionIds.add(productionIdentity);
      this.#executionIds.add(executionIdentity);
      return;
    }
    const receiptIdentity = receiptKey(fact.scope, fact.request.receiptId);
    if (!this.#receipts.has(receiptIdentity)) throw failure("valuation_receipt_not_found", fact.request.receiptId);
    if (this.#revaluations.has(receiptIdentity)) throw failure("valuation_receipt_already_revalued", fact.request.receiptId);
    const revaluationIdentity = receiptKey(fact.scope, fact.request.revaluationId);
    const invoiceIdentity = receiptKey(fact.scope, fact.request.invoiceId);
    if (this.#revaluationIds.has(revaluationIdentity)) throw failure("valuation_revaluation_conflict", fact.request.revaluationId);
    if (this.#invoiceIds.has(invoiceIdentity)) throw failure("valuation_invoice_conflict", fact.request.invoiceId);
    this.#revaluationIds.add(revaluationIdentity);
    this.#invoiceIds.add(invoiceIdentity);
  }

  #planRevaluation(normalized, enforceApproval = false) {
    const receipt = this.#receipts.get(receiptKey(normalized.scope, normalized.request.receiptId));
    if (!receipt) throw failure("valuation_receipt_not_found", normalized.request.receiptId);
    const draft = buildRevaluationRecord({
      request: normalized.request,
      scope: normalized.scope,
      sequence: this.#facts.length + 1,
      factId: "PENDING",
      occurredAt: normalized.occurredAt,
      effectiveAt: normalized.effectiveAt,
    }, receipt);
    const reviewRequired = BigInt(absMoney(draft.totalValueDeltaRupiah)) * 10_000n >= BigInt(draft.totalProvisionalValueRupiah) * 1_000n;
    if (enforceApproval && reviewRequired && !normalized.request.approval) throw failure("valuation_variance_review_required");
    return {
      status: reviewRequired && !normalized.request.approval ? "VARIANCE_REVIEW_REQUIRED" : "READY_TO_POST",
      reviewRequired,
      quantityDeltaBase: "0.000000",
      totalProvisionalValueRupiah: draft.totalProvisionalValueRupiah,
      totalFinalValueRupiah: draft.totalFinalValueRupiah,
      totalValueDeltaRupiah: draft.totalValueDeltaRupiah,
      lines: draft.lines,
    };
  }

  #rebuild() {
    const current = deriveTimeline(this.#facts);
    this.#balances = current.balances;
    this.#receipts = current.receipts;
    this.#consumptions = current.consumptions;
    this.#productions = current.productions;
    this.#revaluations = new Map();
    for (const fact of this.#facts.filter((item) => item.type === "RECEIPT_REVALUATION")) {
      const receiptIdentity = receiptKey(fact.scope, fact.request.receiptId);
      const receipt = current.receipts.get(receiptIdentity);
      const revaluation = buildRevaluationRecord(fact, receipt);
      const without = deriveTimeline(this.#facts, fact.factId);
      const currentCogs = scopeCogs(current.consumptions, fact.scope);
      const priorCogs = scopeCogs(without.consumptions, fact.scope);
      const cogsAdjustmentRupiah = subtractMoney(currentCogs, priorCogs);
      const abnormalLossAdjustmentRupiah = subtractMoney(scopeAbnormalLoss(current.productions, fact.scope), scopeAbnormalLoss(without.productions, fact.scope));
      const inventoryValueDeltaRupiah = subtractMoney(subtractMoney(revaluation.totalValueDeltaRupiah, cogsAdjustmentRupiah), abnormalLossAdjustmentRupiah);
      const actualInventoryDelta = subtractMoney(scopeInventoryValue(current.balances, fact.scope), scopeInventoryValue(without.balances, fact.scope));
      if (inventoryValueDeltaRupiah !== actualInventoryDelta) throw failure("valuation_revaluation_unbalanced");
      this.#revaluations.set(receiptIdentity, deepFreeze({
        ...revaluation,
        inventoryValueDeltaRupiah,
        cogsAdjustmentRupiah,
        abnormalLossAdjustmentRupiah,
      }));
    }
  }

  #response(fact, idempotentReplay) {
    const common = { idempotentReplay, fact: structuredClone(fact), balances: this.viewScope(fact.scope).balances };
    if (fact.type === "PROVISIONAL_RECEIPT") return { ...common, receipt: structuredClone(this.#receipts.get(receiptKey(fact.scope, fact.request.receiptId))), postingEffect: postingEffect(this.#facts, fact) };
    if (fact.type === "INVENTORY_CONSUMPTION") return { ...common, consumption: structuredClone(this.#consumptions.get(receiptKey(fact.scope, fact.request.consumptionId))) };
    if (fact.type === "PRODUCTION_TRANSFORMATION") return { ...common, production: structuredClone(this.#productions.get(receiptKey(fact.scope, fact.request.productionId))) };
    const identity = receiptKey(fact.scope, fact.request.receiptId);
    return {
      ...common,
      receipt: structuredClone(this.#receipts.get(identity)),
      revaluation: structuredClone(this.#revaluations.get(identity)),
    };
  }

  #adopt(candidate) {
    this.#facts = candidate.#facts;
    this.#operations = candidate.#operations;
    this.#receipts = candidate.#receipts;
    this.#revaluations = candidate.#revaluations;
    this.#revaluationIds = candidate.#revaluationIds;
    this.#invoiceIds = candidate.#invoiceIds;
    this.#consumptionIds = candidate.#consumptionIds;
    this.#consumptions = candidate.#consumptions;
    this.#productionIds = candidate.#productionIds;
    this.#executionIds = candidate.#executionIds;
    this.#productions = candidate.#productions;
    this.#balances = candidate.#balances;
  }
}

function deriveTimeline(facts, excludedFactId = undefined) {
  const included = facts.filter((fact) => fact.factId !== excludedFactId);
  const revaluationByReceipt = new Map(included
    .filter((fact) => fact.type === "RECEIPT_REVALUATION")
    .map((fact) => [receiptKey(fact.scope, fact.request.receiptId), fact]));
  const balances = new Map();
  const receipts = new Map();
  const consumptions = new Map();
  const productions = new Map();
  const timeline = included
    .filter((fact) => new Set(["PROVISIONAL_RECEIPT", "INVENTORY_CONSUMPTION", "PRODUCTION_TRANSFORMATION"]).has(fact.type))
    .sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt) || left.sequence - right.sequence);

  for (const fact of timeline) {
    if (fact.type === "PROVISIONAL_RECEIPT") {
      const identity = receiptKey(fact.scope, fact.request.receiptId);
      const provisionalReceipt = {
        id: fact.request.receiptId,
        receiptId: fact.request.receiptId,
        scope: fact.scope,
        sequence: fact.sequence,
        occurredAt: fact.occurredAt,
        effectiveAt: fact.effectiveAt,
        valuationStatus: "PROVISIONAL_RECORDED",
        valuationFactId: fact.factId,
        lines: fact.request.lines,
        totalProvisionalValueRupiah: sumMoney(fact.request.lines.map((line) => line.provisionalItemCostRupiah)),
      };
      const revaluationFact = revaluationByReceipt.get(identity);
      const revaluation = revaluationFact ? buildRevaluationRecord(revaluationFact, provisionalReceipt) : undefined;
      const finalByLine = new Map(revaluation?.lines.map((line) => [line.lineId, line.finalValueRupiah]) ?? []);
      for (const line of provisionalReceipt.lines) {
        const key = balanceKey(fact.scope, line.ingredientId);
        const prior = balances.get(key) ?? emptyBalance(fact.scope, line.ingredientId);
        if (line.provisionalItemCostRupiah === 0 && prior.inventoryValueRupiah === 0) throw failure("valuation_provisional_cost_required");
        balances.set(key, {
          ...prior,
          quantityUnits: prior.quantityUnits + decimalUnits(line.quantityBase),
          inventoryValueRupiah: addMoney(prior.inventoryValueRupiah, finalByLine.get(line.lineId) ?? line.provisionalItemCostRupiah),
        });
      }
      receipts.set(identity, deepFreeze({
        ...provisionalReceipt,
      }));
      continue;
    }

    if (fact.type === "PRODUCTION_TRANSFORMATION") {
      const lines = fact.request.inputs.map((line) => {
        const key = balanceKey(fact.scope, line.ingredientId);
        const prior = balances.get(key);
        const quantityUnits = decimalUnits(line.quantityBase);
        if (!prior || prior.quantityUnits < quantityUnits) throw failure("valuation_stock_insufficient", line.ingredientId);
        const adjustedInventoryValueRupiah = costForQuantity(prior.inventoryValueRupiah, prior.quantityUnits, quantityUnits);
        balances.set(key, {
          ...prior,
          quantityUnits: prior.quantityUnits - quantityUnits,
          inventoryValueRupiah: subtractMoney(prior.inventoryValueRupiah, adjustedInventoryValueRupiah),
        });
        return {
          ingredientId: line.ingredientId,
          quantityBase: line.quantityBase,
          postedInventoryValueRupiah: line.postedInventoryValueRupiah,
          adjustedInventoryValueRupiah,
          valueAdjustmentRupiah: subtractMoney(adjustedInventoryValueRupiah, line.postedInventoryValueRupiah),
        };
      });
      const adjustedInputValueRupiah = sumMoney(lines.map((line) => line.adjustedInventoryValueRupiah));
      const adjustedAbnormalValueRupiah = productionAbnormalLossValue(adjustedInputValueRupiah, fact.request.output.quantityBase, fact.request.loss.abnormalQuantityBase);
      const adjustedOutputValueRupiah = subtractMoney(adjustedInputValueRupiah, adjustedAbnormalValueRupiah);
      if (adjustedOutputValueRupiah <= 0) throw failure("valuation_production_output_cost_required");
      const outputKey = balanceKey(fact.scope, fact.request.output.ingredientId);
      const outputPrior = balances.get(outputKey) ?? emptyBalance(fact.scope, fact.request.output.ingredientId);
      balances.set(outputKey, {
        ...outputPrior,
        quantityUnits: outputPrior.quantityUnits + decimalUnits(fact.request.output.quantityBase),
        inventoryValueRupiah: addMoney(outputPrior.inventoryValueRupiah, adjustedOutputValueRupiah),
      });
      const postedInputValueRupiah = sumMoney(lines.map((line) => line.postedInventoryValueRupiah));
      productions.set(receiptKey(fact.scope, fact.request.productionId), deepFreeze({
        id: fact.request.productionId,
        productionId: fact.request.productionId,
        executionId: fact.request.executionId,
        scope: fact.scope,
        sequence: fact.sequence,
        occurredAt: fact.occurredAt,
        effectiveAt: fact.effectiveAt,
        valuationFactId: fact.factId,
        plannedOutputQuantityBase: fact.request.plannedOutputQuantityBase,
        inputs: lines,
        output: {
          ingredientId: fact.request.output.ingredientId,
          quantityBase: fact.request.output.quantityBase,
          postedInventoryValueRupiah: fact.request.output.postedInventoryValueRupiah,
          adjustedInventoryValueRupiah: adjustedOutputValueRupiah,
          valueAdjustmentRupiah: subtractMoney(adjustedOutputValueRupiah, fact.request.output.postedInventoryValueRupiah),
        },
        loss: {
          ...fact.request.loss,
          adjustedAbnormalValueRupiah,
          valueAdjustmentRupiah: subtractMoney(adjustedAbnormalValueRupiah, fact.request.loss.abnormalValueRupiah),
        },
        postedInputValueRupiah,
        adjustedInputValueRupiah,
        inputValueAdjustmentRupiah: subtractMoney(adjustedInputValueRupiah, postedInputValueRupiah),
      }));
      continue;
    }

    const lines = fact.request.lines.map((line) => {
      const key = balanceKey(fact.scope, line.ingredientId);
      const prior = balances.get(key);
      const quantityUnits = decimalUnits(line.quantityBase);
      if (!prior || prior.quantityUnits < quantityUnits) throw failure("valuation_stock_insufficient", line.ingredientId);
      const adjustedCogsRupiah = costForQuantity(prior.inventoryValueRupiah, prior.quantityUnits, quantityUnits);
      const inventoryValueRupiah = subtractMoney(prior.inventoryValueRupiah, adjustedCogsRupiah);
      balances.set(key, {
        ...prior,
        quantityUnits: prior.quantityUnits - quantityUnits,
        inventoryValueRupiah,
      });
      return {
        ingredientId: line.ingredientId,
        quantityBase: line.quantityBase,
        postedCogsRupiah: line.postedCogsRupiah,
        adjustedCogsRupiah,
        cogsAdjustmentRupiah: subtractMoney(adjustedCogsRupiah, line.postedCogsRupiah),
      };
    });
    consumptions.set(receiptKey(fact.scope, fact.request.consumptionId), deepFreeze({
      id: fact.request.consumptionId,
      consumptionId: fact.request.consumptionId,
      scope: fact.scope,
      sequence: fact.sequence,
      occurredAt: fact.occurredAt,
      effectiveAt: fact.effectiveAt,
      valuationFactId: fact.factId,
      quantityDeltaBase: formatDecimal(-lines.reduce((sum, line) => sum + decimalUnits(line.quantityBase), 0n)),
      postedCogsRupiah: sumMoney(lines.map((line) => line.postedCogsRupiah)),
      adjustedCogsRupiah: sumMoney(lines.map((line) => line.adjustedCogsRupiah)),
      cogsAdjustmentRupiah: sumSignedMoney(lines.map((line) => line.cogsAdjustmentRupiah)),
      lines,
    }));
  }
  return { balances, receipts, consumptions, productions };
}

function quoteConsumption(facts, scope, effectiveAt, lines) {
  const priorFacts = facts.filter((fact) => fact.type === "RECEIPT_REVALUATION"
    || fact.effectiveAt < effectiveAt
    || fact.effectiveAt === effectiveAt);
  const current = deriveTimeline(priorFacts);
  return lines.map((line) => {
    const balance = current.balances.get(balanceKey(scope, line.ingredientId));
    const quantityUnits = decimalUnits(line.quantityBase);
    if (!balance || balance.quantityUnits < quantityUnits) throw failure("valuation_stock_insufficient", line.ingredientId);
    return {
      ...line,
      postedCogsRupiah: costForQuantity(balance.inventoryValueRupiah, balance.quantityUnits, quantityUnits),
    };
  });
}

function quoteProductionInputs(facts, scope, effectiveAt, lines) {
  const priorFacts = facts.filter((fact) => fact.type === "RECEIPT_REVALUATION"
    || fact.effectiveAt < effectiveAt
    || fact.effectiveAt === effectiveAt);
  const current = deriveTimeline(priorFacts);
  return lines.map((line) => {
    const balance = current.balances.get(balanceKey(scope, line.ingredientId));
    const quantityUnits = decimalUnits(line.quantityBase);
    if (!balance || balance.quantityUnits < quantityUnits) throw failure("valuation_stock_insufficient", line.ingredientId);
    return {
      ...line,
      postedInventoryValueRupiah: costForQuantity(balance.inventoryValueRupiah, balance.quantityUnits, quantityUnits),
    };
  });
}

function buildRevaluationRecord(fact, receipt) {
  if (!receipt) throw failure("valuation_receipt_not_found", fact.request.receiptId);
  const invoiceByLine = new Map(fact.request.invoiceLines.map((line) => [line.lineId, line]));
  if (invoiceByLine.size !== receipt.lines.length || receipt.lines.some((line) => !invoiceByLine.has(line.lineId))) throw failure("valuation_invoice_line_coverage_invalid");
  const allocationInput = receipt.lines.map((line) => ({
    lineId: line.lineId,
    quantityBase: line.quantityBase,
    invoicedItemCostRupiah: invoiceByLine.get(line.lineId).invoicedItemCostRupiah,
    ...(line.weightBase ? { weightBase: line.weightBase } : {}),
    ...(line.volumeBase ? { volumeBase: line.volumeBase } : {}),
  }));
  const allocations = allocateLandedCost({ ...fact.request.landedCost, lines: allocationInput });
  const allocationByLine = new Map(allocations.map((line) => [line.lineId, line]));
  const lines = receipt.lines.map((line) => {
    const invoicedItemCostRupiah = invoiceByLine.get(line.lineId).invoicedItemCostRupiah;
    const allocation = allocationByLine.get(line.lineId);
    const finalValueRupiah = addMoney(invoicedItemCostRupiah, allocation.amountRupiah);
    return {
      lineId: line.lineId,
      ingredientId: line.ingredientId,
      quantityBase: line.quantityBase,
      provisionalValueRupiah: line.provisionalItemCostRupiah,
      invoicedItemCostRupiah,
      landedCostAllocatedRupiah: allocation.amountRupiah,
      residualAwardedRupiah: allocation.residualAwardedRupiah,
      finalValueRupiah,
      valueDeltaRupiah: subtractMoney(finalValueRupiah, line.provisionalItemCostRupiah),
    };
  });
  const result = {
    id: fact.request.revaluationId,
    receiptId: receipt.id,
    invoiceId: fact.request.invoiceId,
    scope: fact.scope,
    sequence: fact.sequence,
    occurredAt: fact.occurredAt,
    effectiveAt: fact.effectiveAt,
    valuationFactId: fact.factId,
    allocationMethod: fact.request.landedCost.allocationMethod,
    quantityDeltaBase: "0.000000",
    totalProvisionalValueRupiah: sumMoney(lines.map((line) => line.provisionalValueRupiah)),
    totalInvoiceItemCostRupiah: sumMoney(lines.map((line) => line.invoicedItemCostRupiah)),
    totalLandedCostRupiah: sumMoney(lines.map((line) => line.landedCostAllocatedRupiah)),
    totalFinalValueRupiah: sumMoney(lines.map((line) => line.finalValueRupiah)),
    totalValueDeltaRupiah: sumSignedMoney(lines.map((line) => line.valueDeltaRupiah)),
    lines,
    ...(fact.request.approval === undefined ? {} : { approval: fact.request.approval }),
  };
  if (result.totalLandedCostRupiah !== fact.request.landedCost.totalRupiah
    || result.totalFinalValueRupiah !== addMoney(result.totalInvoiceItemCostRupiah, result.totalLandedCostRupiah)
    || result.totalValueDeltaRupiah !== subtractMoney(result.totalFinalValueRupiah, result.totalProvisionalValueRupiah)) throw failure("valuation_revaluation_unbalanced");
  return result;
}

function postingEffect(facts, fact) {
  const current = deriveTimeline(facts);
  const before = deriveTimeline(facts, fact.factId);
  return {
    quantityDeltaBase: formatDecimal(scopeQuantity(current.balances, fact.scope) - scopeQuantity(before.balances, fact.scope)),
    inventoryValueDeltaRupiah: subtractMoney(scopeInventoryValue(current.balances, fact.scope), scopeInventoryValue(before.balances, fact.scope)),
    cogsAdjustmentRupiah: subtractMoney(scopeCogs(current.consumptions, fact.scope), scopeCogs(before.consumptions, fact.scope)),
  };
}

function scopeInventoryValue(balances, scope) {
  const prefix = `${scopeKey(scope)}\u0000`;
  return sumMoney([...balances.entries()].filter(([key]) => key.startsWith(prefix)).map(([, balance]) => balance.inventoryValueRupiah));
}

function scopeQuantity(balances, scope) {
  const prefix = `${scopeKey(scope)}\u0000`;
  return [...balances.entries()].filter(([key]) => key.startsWith(prefix)).reduce((sum, [, balance]) => sum + balance.quantityUnits, 0n);
}

function scopeCogs(consumptions, scope) {
  const key = scopeKey(scope);
  return sumMoney([...consumptions.values()].filter((item) => scopeKey(item.scope) === key).map((item) => item.adjustedCogsRupiah));
}

function scopeAbnormalLoss(productions, scope) {
  const key = scopeKey(scope);
  return sumMoney([...productions.values()].filter((item) => scopeKey(item.scope) === key).map((item) => item.loss.adjustedAbnormalValueRupiah));
}

function emptyBalance(scope, ingredientId) {
  return { scope, ingredientId, quantityUnits: 0n, inventoryValueRupiah: 0 };
}

function costForQuantity(inventoryValueRupiah, availableQuantityUnits, quantityUnits) {
  if (quantityUnits === availableQuantityUnits) return inventoryValueRupiah;
  return safeBigInt(divideHalfUp(BigInt(inventoryValueRupiah) * quantityUnits, availableQuantityUnits), "valuation_money_overflow");
}

export function allocateLandedCost({ totalRupiah, allocationMethod, lines, manualAllocations } = {}) {
  const total = money(totalRupiah, "valuation_landed_cost_invalid");
  if (!ALLOCATION_METHODS.has(allocationMethod)) throw failure("valuation_allocation_method_invalid");
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100) throw failure("valuation_allocation_lines_invalid");
  const seen = new Set();
  const normalized = lines.map((line) => {
    assertExactKeys(line,
      ["invoicedItemCostRupiah", "lineId", "quantityBase", "volumeBase", "weightBase"],
      ["invoicedItemCostRupiah", "lineId", "quantityBase"],
      "valuation_allocation_line_invalid");
    const lineId = cleanId(line.lineId, "valuation_allocation_line_invalid");
    if (seen.has(lineId)) throw failure("valuation_allocation_line_invalid");
    seen.add(lineId);
    return {
      lineId,
      quantityBase: positiveDecimal(line.quantityBase),
      invoicedItemCostRupiah: money(line.invoicedItemCostRupiah, "valuation_invoice_cost_invalid"),
      ...(line.weightBase === undefined ? {} : { weightBase: positiveDecimal(line.weightBase) }),
      ...(line.volumeBase === undefined ? {} : { volumeBase: positiveDecimal(line.volumeBase) }),
    };
  });
  if (allocationMethod === "MANUAL") return manualAllocation(total, normalized, manualAllocations);
  if (manualAllocations !== undefined) throw failure("valuation_manual_allocation_unexpected");
  const weighted = normalized.map((line) => ({ lineId: line.lineId, weight: allocationWeight(line, allocationMethod) }));
  const totalWeight = weighted.reduce((sum, line) => sum + line.weight, 0n);
  if (totalWeight === 0n && total > 0) throw failure("valuation_allocation_basis_required");
  if (total === 0) return normalized.map((line) => ({ lineId: line.lineId, amountRupiah: 0, residualAwardedRupiah: 0 }));
  const totalBig = BigInt(total);
  const rows = weighted.map((line) => {
    const numerator = totalBig * line.weight;
    return { lineId: line.lineId, amount: numerator / totalWeight, remainder: numerator % totalWeight, residualAwardedRupiah: 0 };
  });
  let residual = totalBig - rows.reduce((sum, row) => sum + row.amount, 0n);
  for (const row of [...rows].sort((left, right) => left.remainder === right.remainder ? left.lineId.localeCompare(right.lineId) : left.remainder > right.remainder ? -1 : 1)) {
    if (residual === 0n) break;
    row.amount += 1n;
    row.residualAwardedRupiah = 1;
    residual -= 1n;
  }
  if (residual !== 0n) throw failure("valuation_allocation_unbalanced");
  const byLine = new Map(rows.map((row) => [row.lineId, row]));
  return normalized.map((line) => ({
    lineId: line.lineId,
    amountRupiah: safeBigInt(byLine.get(line.lineId).amount, "valuation_money_overflow"),
    residualAwardedRupiah: byLine.get(line.lineId).residualAwardedRupiah,
  }));
}

export function inventoryValuationFingerprint(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function normalizeReceiptCommand(command) {
  assertExactKeys(command,
    ["effectiveAt", "lines", "occurredAt", "operationKey", "organizationId", "outletId", "receiptId", "valuationScopeId"],
    ["lines", "occurredAt", "operationKey", "organizationId", "outletId", "receiptId", "valuationScopeId"],
    "valuation_receipt_input_invalid");
  return {
    scope: normalizeScope(command, true),
    operationKey: cleanId(command.operationKey, "valuation_operation_key_invalid"),
    occurredAt: timestamp(command.occurredAt),
    effectiveAt: timestamp(command.effectiveAt ?? command.occurredAt),
    request: normalizeReceiptRequest({ receiptId: command.receiptId, lines: command.lines }),
  };
}

function normalizeConsumptionCommand(command) {
  assertExactKeys(command,
    ["consumptionId", "effectiveAt", "lines", "occurredAt", "operationKey", "organizationId", "outletId", "valuationScopeId"],
    ["consumptionId", "lines", "occurredAt", "operationKey", "organizationId", "outletId", "valuationScopeId"],
    "valuation_consumption_input_invalid");
  return {
    scope: normalizeScope(command, true),
    operationKey: cleanId(command.operationKey, "valuation_operation_key_invalid"),
    occurredAt: timestamp(command.occurredAt),
    effectiveAt: timestamp(command.effectiveAt ?? command.occurredAt),
    request: normalizeConsumptionRequest({ consumptionId: command.consumptionId, lines: command.lines }, false),
  };
}

function normalizeConsumptionRequest(request, persisted) {
  assertExactKeys(request, ["consumptionId", "lines"], ["consumptionId", "lines"], "valuation_consumption_input_invalid");
  if (!Array.isArray(request.lines) || request.lines.length === 0 || request.lines.length > 100) throw failure("valuation_consumption_lines_invalid");
  const ingredients = new Set();
  const lines = request.lines.map((line) => {
    assertExactKeys(line,
      ["adjustedCogsRupiah", "ingredientId", "postedCogsRupiah", "quantityBase"],
      persisted ? ["ingredientId", "postedCogsRupiah", "quantityBase"] : ["ingredientId", "quantityBase"],
      "valuation_consumption_line_invalid");
    const ingredientId = cleanId(line.ingredientId, "valuation_ingredient_id_invalid");
    if (ingredients.has(ingredientId)) throw failure("valuation_consumption_line_invalid");
    ingredients.add(ingredientId);
    const normalized = { ingredientId, quantityBase: positiveDecimal(line.quantityBase) };
    if (persisted) normalized.postedCogsRupiah = money(line.postedCogsRupiah, "valuation_posted_cogs_invalid");
    return normalized;
  }).sort((left, right) => left.ingredientId.localeCompare(right.ingredientId));
  return { consumptionId: cleanId(request.consumptionId, "valuation_consumption_id_invalid"), lines };
}

function normalizeProductionCommand(command) {
  assertExactKeys(command,
    ["effectiveAt", "executionId", "inputs", "loss", "occurredAt", "operationKey", "organizationId", "outletId", "output", "plannedOutputQuantityBase", "productionId", "valuationScopeId"],
    ["executionId", "inputs", "loss", "occurredAt", "operationKey", "organizationId", "outletId", "output", "plannedOutputQuantityBase", "productionId", "valuationScopeId"],
    "valuation_production_input_invalid");
  return {
    scope: normalizeScope(command, true),
    operationKey: cleanId(command.operationKey, "valuation_operation_key_invalid"),
    occurredAt: timestamp(command.occurredAt),
    effectiveAt: timestamp(command.effectiveAt ?? command.occurredAt),
    request: normalizeProductionRequest({
      productionId: command.productionId,
      executionId: command.executionId,
      plannedOutputQuantityBase: command.plannedOutputQuantityBase,
      inputs: command.inputs,
      output: command.output,
      loss: command.loss,
    }, false),
  };
}

function normalizeProductionRequest(request, persisted) {
  assertExactKeys(request,
    ["executionId", "inputs", "loss", "output", "plannedOutputQuantityBase", "productionId"],
    ["executionId", "inputs", "loss", "output", "plannedOutputQuantityBase", "productionId"],
    "valuation_production_input_invalid");
  if (!Array.isArray(request.inputs) || request.inputs.length === 0 || request.inputs.length > 100) throw failure("valuation_production_inputs_invalid");
  const inputPostedCount = request.inputs.filter((line) => line && Object.hasOwn(line, "postedInventoryValueRupiah")).length;
  const outputPosted = request.output && Object.hasOwn(request.output, "postedInventoryValueRupiah");
  const suppliedPosted = inputPostedCount === request.inputs.length && outputPosted;
  if (!persisted && (inputPostedCount !== 0 || outputPosted) && !suppliedPosted) throw failure("valuation_production_posted_value_coverage_invalid");
  const includePosted = persisted || suppliedPosted;
  const ingredients = new Set();
  const inputs = request.inputs.map((line) => {
    assertExactKeys(line,
      ["ingredientId", "postedInventoryValueRupiah", "quantityBase"],
      includePosted ? ["ingredientId", "postedInventoryValueRupiah", "quantityBase"] : ["ingredientId", "quantityBase"],
      "valuation_production_input_line_invalid");
    const ingredientId = cleanId(line.ingredientId, "valuation_ingredient_id_invalid");
    if (ingredients.has(ingredientId)) throw failure("valuation_production_input_line_invalid");
    ingredients.add(ingredientId);
    const normalized = { ingredientId, quantityBase: positiveDecimal(line.quantityBase) };
    if (includePosted) {
      normalized.postedInventoryValueRupiah = money(line.postedInventoryValueRupiah, "valuation_production_input_cost_required");
      if (normalized.postedInventoryValueRupiah === 0) throw failure("valuation_production_input_cost_required");
    }
    return normalized;
  }).sort((left, right) => left.ingredientId.localeCompare(right.ingredientId));
  assertExactKeys(request.output,
    ["ingredientId", "postedInventoryValueRupiah", "quantityBase"],
    includePosted ? ["ingredientId", "postedInventoryValueRupiah", "quantityBase"] : ["ingredientId", "quantityBase"],
    "valuation_production_output_invalid");
  const output = {
    ingredientId: cleanId(request.output.ingredientId, "valuation_ingredient_id_invalid"),
    quantityBase: positiveDecimal(request.output.quantityBase),
  };
  if (includePosted) {
    output.postedInventoryValueRupiah = money(request.output.postedInventoryValueRupiah, "valuation_production_output_cost_required");
    if (output.postedInventoryValueRupiah === 0) throw failure("valuation_production_output_cost_required");
  }
  const loss = normalizeProductionLoss(request.loss, persisted);
  const plannedOutputQuantityBase = positiveDecimal(request.plannedOutputQuantityBase);
  const plannedUnits = decimalUnits(plannedOutputQuantityBase);
  const actualUnits = decimalUnits(output.quantityBase);
  const shortfallUnits = plannedUnits > actualUnits ? plannedUnits - actualUnits : 0n;
  if (decimalUnits(loss.normalQuantityBase) + decimalUnits(loss.abnormalQuantityBase) !== shortfallUnits) throw failure("valuation_production_loss_quantity_unbalanced");
  if (includePosted) {
    const postedInputValueRupiah = sumMoney(inputs.map((line) => line.postedInventoryValueRupiah));
    const authorityValueRupiah = productionAbnormalLossValue(postedInputValueRupiah, output.quantityBase, loss.abnormalQuantityBase);
    if (loss.abnormalValueRupiah !== authorityValueRupiah) throw failure("valuation_production_abnormal_loss_authority_mismatch");
    if (postedInputValueRupiah !== addMoney(output.postedInventoryValueRupiah, authorityValueRupiah)) throw failure("valuation_production_value_unbalanced");
  }
  return {
    productionId: cleanId(request.productionId, "valuation_production_id_invalid"),
    executionId: cleanId(request.executionId, "valuation_production_execution_id_invalid"),
    plannedOutputQuantityBase,
    inputs,
    output,
    loss,
  };
}

function normalizeProductionLoss(value, persisted = false) {
  assertExactKeys(value, ["abnormalQuantityBase", "abnormalValueRupiah", "normalQuantityBase", "policy"], persisted ? ["abnormalQuantityBase", "abnormalValueRupiah", "normalQuantityBase", "policy"] : ["abnormalQuantityBase", "normalQuantityBase", "policy"], "valuation_production_loss_invalid");
  if (value.policy !== PRODUCTION_LOSS_POLICY) throw failure("valuation_production_loss_policy_invalid");
  const normalQuantityBase = nonnegativeDecimal(value.normalQuantityBase);
  const abnormalQuantityBase = nonnegativeDecimal(value.abnormalQuantityBase);
  const abnormalValueRupiah = value.abnormalValueRupiah === undefined ? undefined : money(value.abnormalValueRupiah, "valuation_production_abnormal_loss_value_invalid");
  if (abnormalValueRupiah !== undefined && decimalUnits(abnormalQuantityBase) === 0n && abnormalValueRupiah !== 0) throw failure("valuation_production_abnormal_loss_value_required");
  return { policy: PRODUCTION_LOSS_POLICY, normalQuantityBase, abnormalQuantityBase, ...(abnormalValueRupiah === undefined ? {} : { abnormalValueRupiah }) };
}

function productionAbnormalLossValue(inputValueRupiah, outputQuantityBase, abnormalQuantityBase) {
  const abnormalUnits = decimalUnits(abnormalQuantityBase);
  if (abnormalUnits === 0n) return 0;
  const equivalentOutputUnits = decimalUnits(outputQuantityBase) + abnormalUnits;
  return safeBigInt(divideHalfUp(BigInt(money(inputValueRupiah, "valuation_money_invalid")) * abnormalUnits, equivalentOutputUnits), "valuation_money_overflow");
}

function normalizeReceiptRequest(request) {
  assertExactKeys(request, ["lines", "receiptId"], ["lines", "receiptId"], "valuation_receipt_input_invalid");
  if (!Array.isArray(request.lines) || request.lines.length === 0 || request.lines.length > 100) throw failure("valuation_receipt_lines_invalid");
  const lineIds = new Set();
  const lines = request.lines.map((line) => {
    assertExactKeys(line,
      ["ingredientId", "lineId", "provisionalItemCostRupiah", "quantityBase", "volumeBase", "weightBase"],
      ["ingredientId", "lineId", "provisionalItemCostRupiah", "quantityBase"],
      "valuation_receipt_line_invalid");
    const lineId = cleanId(line.lineId, "valuation_receipt_line_invalid");
    if (lineIds.has(lineId)) throw failure("valuation_receipt_line_invalid");
    lineIds.add(lineId);
    const provisionalItemCostRupiah = money(line.provisionalItemCostRupiah, "valuation_provisional_cost_required");
    return {
      lineId,
      ingredientId: cleanId(line.ingredientId, "valuation_ingredient_id_invalid"),
      quantityBase: positiveDecimal(line.quantityBase),
      provisionalItemCostRupiah,
      ...(line.weightBase === undefined ? {} : { weightBase: positiveDecimal(line.weightBase) }),
      ...(line.volumeBase === undefined ? {} : { volumeBase: positiveDecimal(line.volumeBase) }),
    };
  }).sort((left, right) => left.lineId.localeCompare(right.lineId));
  sumMoney(lines.map((line) => line.provisionalItemCostRupiah));
  return { receiptId: cleanId(request.receiptId, "valuation_receipt_id_invalid"), lines };
}

function normalizeRevaluationCommand(command) {
  assertExactKeys(command,
    ["approval", "effectiveAt", "invoiceId", "invoiceLines", "landedCost", "occurredAt", "operationKey", "organizationId", "outletId", "receiptId", "revaluationId", "valuationScopeId"],
    ["invoiceId", "invoiceLines", "landedCost", "occurredAt", "operationKey", "organizationId", "outletId", "receiptId", "revaluationId", "valuationScopeId"],
    "valuation_revaluation_input_invalid");
  return {
    scope: normalizeScope(command, true),
    operationKey: cleanId(command.operationKey, "valuation_operation_key_invalid"),
    occurredAt: timestamp(command.occurredAt),
    effectiveAt: timestamp(command.effectiveAt ?? command.occurredAt),
    request: normalizeRevaluationRequest({
      revaluationId: command.revaluationId,
      receiptId: command.receiptId,
      invoiceId: command.invoiceId,
      invoiceLines: command.invoiceLines,
      landedCost: command.landedCost,
      ...(command.approval === undefined ? {} : { approval: command.approval }),
    }),
  };
}

function normalizeRevaluationRequest(request) {
  assertExactKeys(request,
    ["approval", "invoiceId", "invoiceLines", "landedCost", "receiptId", "revaluationId"],
    ["invoiceId", "invoiceLines", "landedCost", "receiptId", "revaluationId"],
    "valuation_revaluation_input_invalid");
  if (!Array.isArray(request.invoiceLines) || request.invoiceLines.length === 0 || request.invoiceLines.length > 100) throw failure("valuation_invoice_lines_invalid");
  const lineIds = new Set();
  const invoiceLines = request.invoiceLines.map((line) => {
    assertExactKeys(line, ["invoicedItemCostRupiah", "lineId"], ["invoicedItemCostRupiah", "lineId"], "valuation_invoice_line_invalid");
    const lineId = cleanId(line.lineId, "valuation_invoice_line_invalid");
    if (lineIds.has(lineId)) throw failure("valuation_invoice_line_invalid");
    lineIds.add(lineId);
    return { lineId, invoicedItemCostRupiah: money(line.invoicedItemCostRupiah, "valuation_invoice_cost_invalid") };
  }).sort((left, right) => left.lineId.localeCompare(right.lineId));
  sumMoney(invoiceLines.map((line) => line.invoicedItemCostRupiah));
  const landedCost = normalizeLandedCost(request.landedCost);
  const approval = request.approval === undefined ? undefined : normalizeApproval(request.approval);
  return {
    revaluationId: cleanId(request.revaluationId, "valuation_revaluation_id_invalid"),
    receiptId: cleanId(request.receiptId, "valuation_receipt_id_invalid"),
    invoiceId: cleanId(request.invoiceId, "valuation_invoice_id_invalid"),
    invoiceLines,
    landedCost,
    ...(approval === undefined ? {} : { approval }),
  };
}

function normalizeApproval(value) {
  assertExactKeys(value, ["approvedBy", "reason", "reviewedBy"], ["approvedBy", "reason", "reviewedBy"], "valuation_approval_invalid");
  const reviewedBy = cleanId(value.reviewedBy, "valuation_approval_invalid");
  const approvedBy = cleanId(value.approvedBy, "valuation_approval_invalid");
  if (reviewedBy === approvedBy) throw failure("valuation_approval_separation_required");
  return { reviewedBy, approvedBy, reason: cleanId(value.reason, "valuation_approval_invalid") };
}

function normalizeLandedCost(value) {
  assertExactKeys(value, ["allocationMethod", "manualAllocations", "totalRupiah"], ["allocationMethod", "totalRupiah"], "valuation_landed_cost_invalid");
  if (!ALLOCATION_METHODS.has(value.allocationMethod)) throw failure("valuation_allocation_method_invalid");
  const landedCost = { allocationMethod: value.allocationMethod, totalRupiah: money(value.totalRupiah, "valuation_landed_cost_invalid") };
  if (value.allocationMethod === "MANUAL") {
    if (!Array.isArray(value.manualAllocations)) throw failure("valuation_manual_allocation_invalid");
    landedCost.manualAllocations = value.manualAllocations.map((line) => {
      assertExactKeys(line, ["amountRupiah", "lineId"], ["amountRupiah", "lineId"], "valuation_manual_allocation_invalid");
      return { lineId: cleanId(line.lineId, "valuation_manual_allocation_invalid"), amountRupiah: money(line.amountRupiah, "valuation_manual_allocation_invalid") };
    }).sort((left, right) => left.lineId.localeCompare(right.lineId));
  } else if (value.manualAllocations !== undefined) throw failure("valuation_manual_allocation_unexpected");
  return landedCost;
}

function manualAllocation(total, lines, allocations) {
  if (!Array.isArray(allocations) || allocations.length !== lines.length) throw failure("valuation_manual_allocation_mismatch");
  const seen = new Set();
  const byLine = new Map();
  for (const allocation of allocations) {
    assertExactKeys(allocation, ["amountRupiah", "lineId"], ["amountRupiah", "lineId"], "valuation_manual_allocation_invalid");
    const lineId = cleanId(allocation.lineId, "valuation_manual_allocation_invalid");
    if (seen.has(lineId)) throw failure("valuation_manual_allocation_mismatch");
    seen.add(lineId);
    byLine.set(lineId, money(allocation.amountRupiah, "valuation_manual_allocation_invalid"));
  }
  if (lines.some((line) => !byLine.has(line.lineId)) || sumMoney([...byLine.values()]) !== total) throw failure("valuation_manual_allocation_mismatch");
  return lines.map((line) => ({ lineId: line.lineId, amountRupiah: byLine.get(line.lineId), residualAwardedRupiah: 0 }));
}

function allocationWeight(line, method) {
  if (method === "VALUE") return BigInt(line.invoicedItemCostRupiah);
  if (method === "QUANTITY") return decimalUnits(line.quantityBase);
  if (method === "WEIGHT") {
    if (!line.weightBase) throw failure("valuation_weight_basis_required", line.lineId);
    return decimalUnits(line.weightBase);
  }
  if (method === "VOLUME") {
    if (!line.volumeBase) throw failure("valuation_volume_basis_required", line.lineId);
    return decimalUnits(line.volumeBase);
  }
  return 1n;
}

function normalizeScope(value, allowCarrier = false) {
  assertExactKeys(value,
    ["organizationId", "outletId", "valuationScopeId"],
    ["organizationId", "outletId", "valuationScopeId"],
    "valuation_scope_invalid",
    allowCarrier);
  return {
    organizationId: cleanId(value.organizationId, "valuation_scope_invalid"),
    outletId: cleanId(value.outletId, "valuation_scope_invalid"),
    valuationScopeId: cleanId(value.valuationScopeId, "valuation_scope_invalid"),
  };
}

function balanceView(balance) {
  return {
    ingredientId: balance.ingredientId,
    quantityBase: formatDecimal(balance.quantityUnits),
    inventoryValueRupiah: balance.inventoryValueRupiah,
    averageCostPerBaseUnitRupiah: averageCost(balance.inventoryValueRupiah, balance.quantityUnits),
  };
}

function averageCost(valueRupiah, quantityUnits) {
  if (quantityUnits <= 0n) return "0.000000";
  const scaled = divideHalfUp(BigInt(valueRupiah) * QUANTITY_FACTOR * QUANTITY_FACTOR, quantityUnits);
  return formatDecimal(scaled);
}

function positiveDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,11})\.\d{6}$/.test(value)) throw failure("valuation_quantity_invalid");
  const units = decimalUnits(value);
  if (units <= 0n) throw failure("valuation_quantity_invalid");
  return value;
}

function nonnegativeDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,11})\.\d{6}$/.test(value)) throw failure("valuation_quantity_invalid");
  decimalUnits(value);
  return value;
}

function decimalUnits(value) {
  const [whole, fractional] = value.split(".");
  return BigInt(whole) * QUANTITY_FACTOR + BigInt(fractional);
}

function formatDecimal(units) {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / QUANTITY_FACTOR}.${String(absolute % QUANTITY_FACTOR).padStart(DECIMAL_SCALE, "0")}`;
}

function divideHalfUp(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) throw failure("valuation_ratio_invalid");
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function money(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure(code);
  return value;
}

function addMoney(left, right) {
  return safeBigInt(BigInt(left) + BigInt(right), "valuation_money_overflow");
}

function subtractMoney(left, right) {
  return safeBigInt(BigInt(left) - BigInt(right), "valuation_money_overflow");
}

function addSignedMoney(left, right) {
  return safeBigInt(BigInt(left) + BigInt(right), "valuation_money_overflow");
}

function sumMoney(values) {
  return safeBigInt(values.reduce((sum, value) => sum + BigInt(money(value, "valuation_money_invalid")), 0n), "valuation_money_overflow");
}

function sumSignedMoney(values) {
  return safeBigInt(values.reduce((sum, value) => sum + BigInt(value), 0n), "valuation_money_overflow");
}

function absMoney(value) {
  return value < 0 ? safeBigInt(-BigInt(value), "valuation_money_overflow") : value;
}

function safeBigInt(value, code) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw failure(code);
  return Number(value);
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) throw failure("valuation_timestamp_invalid");
  return value;
}

function cleanId(value, code) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw failure(code);
  return value;
}

function scopeKey(scope) {
  return `${scope.organizationId}\u0000${scope.outletId}\u0000${scope.valuationScopeId}`;
}

function receiptKey(scope, id) {
  return `${scopeKey(scope)}\u0000${id}`;
}

function balanceKey(scope, ingredientId) {
  return `${scopeKey(scope)}\u0000${ingredientId}`;
}

function operationKey(scope, id) {
  return `${scope.organizationId}\u0000${id}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function assertExactKeys(value, allowed, required, code, allowScopeCarrier = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(code);
  const keys = Object.keys(value);
  const accepted = allowScopeCarrier
    ? keys.filter((key) => ["organizationId", "outletId", "valuationScopeId"].includes(key))
    : keys;
  if ((!allowScopeCarrier && accepted.some((key) => !allowed.includes(key))) || required.some((key) => !accepted.includes(key))) throw failure(code);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function failure(code, detail = undefined) {
  return new InventoryValuationError(code, detail);
}
