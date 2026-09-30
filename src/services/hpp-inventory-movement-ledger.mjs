import { createHash } from "node:crypto";

const SCALE = 1_000_000;

export function deriveHppInventoryMovementFacts({ snapshot, organizationId, outletId, usableLocationId }) {
  if (!snapshot || !Array.isArray(snapshot.inventoryBalances) || !Array.isArray(snapshot.inventoryMovements)) {
    throw ledgerError("hpp_inventory_movement_snapshot_invalid", 500);
  }
  const facts = [];
  const balances = new Map();
  const receiptsById = new Map((snapshot.purchaseReceipts ?? []).map((item) => [item.id, item]));
  const consumptionsById = new Map((snapshot.saleConsumptions ?? []).map((item) => [item.id, item]));
  const events = [
    ...(snapshot.purchaseReceipts ?? []).map((value) => ({ kind: "receipt", version: value.version, value })),
    ...(snapshot.purchaseReceiptInspectionDecisions ?? []).filter((value) => value.decision === "ACCEPT").map((value) => ({ kind: "inspection", version: value.version, value })),
    ...(snapshot.inventoryMovements ?? []).map((value) => ({ kind: "movement", version: value.version, value })),
    ...(snapshot.supplierReturns ?? []).flatMap((value) => [
      { kind: "supplier_return", version: value.version, value },
      ...(value.replacementReceipt ? [{ kind: "supplier_replacement", version: value.replacementReceipt.version, value }] : []),
    ]),
  ].sort((a, b) => a.version - b.version || a.kind.localeCompare(b.kind));

  for (const event of events) {
    if (event.kind === "receipt") {
      for (const [index, line] of event.value.lines.entries()) {
        append({
          movementId: deterministicMovementId("PURCHASE_RECEIPT", event.value.id, line.ingredientId, index),
          movementType: "PURCHASE_RECEIPT", sourceType: "PURCHASE_RECEIPT", sourceId: event.value.id,
          sourceLineId: line.ingredientId, ingredientId: line.ingredientId,
          locationId: event.value.destinationLocationId ?? usableLocationId,
          quantityDeltaBase: line.baseQuantity, inventoryValueDeltaRupiah: line.totalCostRupiah,
          effectiveAt: event.value.receivedAt, actorReference: event.value.actorId, reason: event.value.reason,
          referenceType: "purchase_receipt", referenceId: event.value.id, referenceCode: event.value.idempotencyKey,
          version: event.value.version,
        });
      }
      continue;
    }
    if (event.kind === "inspection") {
      const item = event.value;
      append({
        movementId: deterministicMovementId("PURCHASE_INSPECTION", item.id, item.ingredientId),
        movementType: "PURCHASE_INSPECTION_ACCEPT", sourceType: "PURCHASE_INSPECTION", sourceId: item.id,
        sourceLineId: item.ingredientId, ingredientId: item.ingredientId, locationId: item.destinationLocationId,
        quantityDeltaBase: item.baseQuantity, inventoryValueDeltaRupiah: item.inventoryValueRupiah,
        effectiveAt: item.occurredAt, actorReference: item.actorId, reason: item.reason,
        referenceType: "purchase_receipt", referenceId: item.purchaseReceiptId, referenceCode: item.lotCode,
        version: item.version,
      });
      continue;
    }
    if (event.kind === "supplier_return" || event.kind === "supplier_replacement") {
      const item = event.value;
      const direction = event.kind === "supplier_return" ? -1 : 1;
      const source = event.kind === "supplier_return" ? item : item.replacementReceipt;
      for (const [index, line] of item.lines.entries()) {
        const receipt = receiptsById.get(item.purchaseReceiptId);
        append({
          movementId: deterministicMovementId(event.kind.toUpperCase(), item.id, line.ingredientId, index),
          movementType: event.kind === "supplier_return" ? "SUPPLIER_RETURN" : "SUPPLIER_REPLACEMENT",
          sourceType: event.kind === "supplier_return" ? "SUPPLIER_RETURN" : "SUPPLIER_REPLACEMENT",
          sourceId: event.kind === "supplier_return" ? item.id : source.idempotencyKey,
          sourceLineId: line.ingredientId, ingredientId: line.ingredientId,
          locationId: receipt?.destinationLocationId ?? usableLocationId,
          quantityDeltaBase: direction * line.baseQuantity,
          inventoryValueDeltaRupiah: direction * line.returnValueRupiah,
          effectiveAt: event.kind === "supplier_return" ? item.shippedAt : source.receivedAt,
          actorReference: event.kind === "supplier_return" ? item.actorId : source.actorId,
          reason: event.kind === "supplier_return" ? item.reason : source.reason,
          referenceType: "purchase_receipt", referenceId: item.purchaseReceiptId,
          referenceCode: event.kind === "supplier_return" ? item.returnReference : source.receiptReference,
          reversalOfMovementId: direction < 0 ? deterministicMovementId("PURCHASE_RECEIPT", item.purchaseReceiptId, line.ingredientId, receipt?.lines.findIndex((entry) => entry.ingredientId === line.ingredientId) ?? 0) : null,
          version: event.kind === "supplier_return" ? item.version : source.version,
        });
      }
      continue;
    }

    const movement = event.value;
    const consumption = movement.consumptionId ? consumptionsById.get(movement.consumptionId) : null;
    const offline = consumption?.sourceEvent ?? null;
    const production = new Set(["PRODUCTION_INPUT", "PRODUCTION_OUTPUT"]).has(movement.movementType);
    const sourceType = offline ? "OFFLINE_EVENT"
      : movement.movementType === "SALE_CONSUMPTION" ? "SALE_CONSUMPTION"
        : production ? movement.sourceType
        : movement.countSessionId ? "INVENTORY_COUNT" : movement.movementType === "REVERSAL" ? "MOVEMENT_REVERSAL" : "HPP_MOVEMENT";
    const sourceId = production ? movement.sourceId : offline?.eventId ?? movement.consumptionId ?? movement.countSessionId ?? movement.idempotencyKey;
    append({
      movementId: movement.id, movementType: movement.movementType, sourceType, sourceId,
      sourceLineId: production ? movement.sourceLineId : movement.ingredientId,
      ingredientId: movement.ingredientId,
      locationId: production || movement.locationAuthorityVersion === 1 || (!new Set(["TRANSFER_OUT", "TRANSFER_IN"]).has(movement.movementType) && movement.locationId)
        ? movement.locationId : usableLocationId,
      quantityDeltaBase: movement.quantityDeltaBase, inventoryValueDeltaRupiah: movement.inventoryValueDeltaRupiah,
      effectiveAt: movement.occurredAt, actorReference: movement.actorId, reason: movement.reason,
      referenceType: movement.referenceType ?? (movement.countSessionId ? "inventory_count" : "hpp_movement"),
      referenceId: movement.referenceId ?? movement.countSessionId ?? movement.id,
      referenceCode: movement.referenceCode ?? movement.idempotencyKey,
      reversalOfMovementId: movement.reversalOfMovementId ?? null,
      sourceEventId: offline?.eventId ?? null, sourceDeviceId: offline?.deviceId ?? null,
      sourceLocalSequence: offline?.localSequence ?? null, version: movement.version,
      assertedBefore: movement.quantityBeforeBase, assertedAfter: movement.quantityAfterBase,
      assertedValueBefore: movement.inventoryValueBeforeRupiah, assertedValueAfter: movement.inventoryValueAfterRupiah,
    });
  }

  const expected = new Map(snapshot.inventoryBalances.map((item) => [item.ingredientId, item]));
  for (const [ingredientId, actual] of balances) {
    const target = expected.get(ingredientId);
    if (!target || units(target.quantityBase) !== actual.quantityUnits || target.inventoryValueRupiah !== actual.inventoryValueRupiah) {
      throw ledgerError("hpp_inventory_movement_projection_mismatch", 500);
    }
  }
  if (expected.size !== balances.size) throw ledgerError("hpp_inventory_movement_projection_mismatch", 500);
  return facts;

  function append(input) {
    const before = balances.get(input.ingredientId) ?? { quantityUnits: 0n, inventoryValueRupiah: 0 };
    const quantityDeltaUnits = units(input.quantityDeltaBase);
    const after = {
      quantityUnits: before.quantityUnits + quantityDeltaUnits,
      inventoryValueRupiah: before.inventoryValueRupiah + input.inventoryValueDeltaRupiah,
    };
    if (after.quantityUnits < 0n || !Number.isSafeInteger(after.inventoryValueRupiah) || after.inventoryValueRupiah < 0) {
      throw ledgerError("hpp_inventory_movement_projection_invalid", 500);
    }
    if (input.assertedBefore != null && units(input.assertedBefore) !== before.quantityUnits) throw ledgerError("hpp_inventory_movement_envelope_invalid", 500);
    if (input.assertedAfter != null && units(input.assertedAfter) !== after.quantityUnits) throw ledgerError("hpp_inventory_movement_envelope_invalid", 500);
    if (input.assertedValueBefore != null && input.assertedValueBefore !== before.inventoryValueRupiah) throw ledgerError("hpp_inventory_movement_envelope_invalid", 500);
    if (input.assertedValueAfter != null && input.assertedValueAfter !== after.inventoryValueRupiah) throw ledgerError("hpp_inventory_movement_envelope_invalid", 500);
    const document = {
      movementId: input.movementId, organizationId, outletId, movementType: input.movementType,
      sourceType: input.sourceType, sourceId: input.sourceId, sourceLineId: input.sourceLineId,
      ingredientId: input.ingredientId, locationId: input.locationId,
      quantityDeltaBase: formatUnits(quantityDeltaUnits), inventoryValueDeltaRupiah: input.inventoryValueDeltaRupiah,
      quantityBeforeBase: formatUnits(before.quantityUnits), quantityAfterBase: formatUnits(after.quantityUnits),
      inventoryValueBeforeRupiah: before.inventoryValueRupiah, inventoryValueAfterRupiah: after.inventoryValueRupiah,
      effectiveAt: input.effectiveAt, actorReference: input.actorReference, reason: input.reason,
      auditReference: `hpp-audit:${input.version}`, referenceType: input.referenceType,
      referenceId: input.referenceId, referenceCode: input.referenceCode ?? null,
      reversalOfMovementId: input.reversalOfMovementId ?? null, sourceEventId: input.sourceEventId ?? null,
      sourceDeviceId: input.sourceDeviceId ?? null, sourceLocalSequence: input.sourceLocalSequence ?? null,
      hppVersion: input.version,
    };
    document.fingerprint = sha256(document);
    facts.push(document);
    balances.set(input.ingredientId, after);
  }
}

function deterministicMovementId(...parts) {
  return `hpp:${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function units(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw ledgerError("hpp_inventory_movement_quantity_invalid", 500);
  return BigInt(Math.round(number * SCALE));
}

function formatUnits(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / BigInt(SCALE)}.${(absolute % BigInt(SCALE)).toString().padStart(6, "0")}`;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ledgerError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
