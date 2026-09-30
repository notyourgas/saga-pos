import { createHash, randomUUID } from "node:crypto";

import {
  buildPrintJobs,
  buildShiftCashLedger,
  createOfflineOperation,
  evaluateOfflineConflict,
  prepareReprint,
  recordPrintAttempt,
  reserveLastStock,
} from "../services/esb-reliability/index.mjs";

const HARDWARE_ACTIVATION = "OFF_REQUIRES_PHYSICAL_UAT";
const INVENTORY_AUTH_ACTIONS = Object.freeze({
  PURCHASE: "inventory:purchase",
  ADJUSTMENT: "inventory:adjustment",
  WASTE: "inventory:waste",
  REVERSAL: "inventory:reversal",
});

export function createEsbReliabilityCommandFingerprint(value) {
  return hash(value);
}

export function inventoryLedgerAuthorizationResource(input) {
  return hash({
    ingredientId: input.ingredientId,
    movementKind: String(input.movementKind ?? "").toUpperCase(),
    quantityBase: input.quantityBase ?? null,
    quantityDeltaBase: input.quantityDeltaBase ?? null,
    sourceReference: input.sourceReference,
    reversalOfEntryId: input.reversalOfEntryId ?? null,
  });
}

export function inventoryLedgerCommandFingerprint(input) {
  return hash({
    organizationId: input.organizationId,
    outletId: input.outletId,
    ingredientId: input.ingredientId,
    operationKey: input.operationKey,
    sourceReference: input.sourceReference,
    actorReference: input.actorReference,
    movementKind: String(input.movementKind ?? "").toUpperCase(),
    authorizationId: input.authorizationId,
    quantityBase: input.quantityBase ?? null,
    quantityDeltaBase: input.quantityDeltaBase ?? null,
    reversalOfEntryId: input.reversalOfEntryId ?? null,
  });
}

export function shiftCloseAuthorizationResource(input) {
  return hash({
    shiftId: input.shiftId,
    declaredCashRupiah: input.declaredCashRupiah,
    cashToLeaveRupiah: input.cashToLeaveRupiah,
    expectedCashRupiah: input.expectedCashRupiah,
    varianceRupiah: input.varianceRupiah,
    ledgerFingerprint: input.ledgerFingerprint,
    reason: input.reason,
  });
}

export function shiftCloseCommandFingerprint(input) {
  return hash({
    organizationId: input.organizationId,
    outletId: input.outletId,
    shiftId: input.shiftId,
    operationKey: input.operationKey,
    authorizationId: input.authorizationId,
    actorReference: input.actorReference,
    reason: input.reason,
    declaredCashRupiah: input.declaredCashRupiah,
    cashToLeaveRupiah: input.cashToLeaveRupiah,
  });
}

export class EsbReliabilityPostgresRepository {
  constructor({ db, clock = () => new Date(), faultInjector = () => {} } = {}) {
    if (!db?.query || !db?.transaction) throw new Error("postgres_database_required");
    this.db = db;
    this.clock = clock;
    this.faultInjector = faultInjector;
  }

  async issueAuthorization(input) {
    if (input.approvalStatus !== "APPROVED"
      || !input.requestedByReference
      || !input.approvedByReference
      || input.requestedByReference === input.approvedByReference
      || input.approvedByReference === input.actorReference) {
      throw new Error("reliability_authorization_approval_evidence_required");
    }
    const bindingHash = reliabilityBindingHash(input);
    await this.db.query(
      `insert into sagaops.esb_reliability_authorizations
        (id,organization_id,outlet_id,action,resource_type,resource_id,actor_reference,requested_by_reference,approved_by_reference,binding_hash,status,issued_at,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AVAILABLE',$11,$12)`,
      [input.id, input.organizationId, input.outletId, input.action, input.resourceType, input.resourceId, input.actorReference, input.requestedByReference, input.approvedByReference, bindingHash, input.issuedAt, input.expiresAt],
    );
    return { ...structuredClone(input), bindingHash, status: "AVAILABLE" };
  }

  async requestAuthorization(input) {
    const organizationId = requiredText(input.organizationId, "organization_id_required");
    const outletId = requiredText(input.outletId, "outlet_id_required");
    const action = requiredText(input.action, "reliability_action_required");
    const resourceType = requiredText(input.resourceType, "reliability_resource_type_required");
    const resourceId = requiredText(input.resourceId, "reliability_resource_id_required");
    const operationKey = requiredText(input.operationKey, "reliability_operation_key_required", 160);
    const actorReference = requiredText(input.actorReference, "actor_reference_required", 160);
    const commandSnapshot = structuredClone(input.commandSnapshot);
    if (!commandSnapshot || typeof commandSnapshot !== "object" || Array.isArray(commandSnapshot)) throw new Error("reliability_command_snapshot_required");
    const requestFingerprint = hash(commandSnapshot);
    const requestId = input.id ?? randomUUID();
    const requestedAt = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `insert into sagaops.esb_reliability_approval_requests
          (id,organization_id,outlet_id,action,resource_type,resource_id,operation_key,actor_reference,
           request_fingerprint,command_snapshot,status,requested_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'PENDING',$11)
         on conflict (organization_id,operation_key) do nothing returning id`,
        [requestId, organizationId, outletId, action, resourceType, resourceId, operationKey,
          actorReference, requestFingerprint, JSON.stringify(commandSnapshot), requestedAt],
      );
      if (inserted.rows.length === 0) {
        const existing = (await tx.query(
          `select id,outlet_id,action,resource_type,resource_id,actor_reference,request_fingerprint,status,authorization_id
             from sagaops.esb_reliability_approval_requests
            where organization_id=$1 and operation_key=$2`,
          [organizationId, operationKey],
        )).rows[0];
        if (!existing
          || existing.outlet_id !== outletId
          || existing.action !== action
          || existing.resource_type !== resourceType
          || existing.resource_id !== resourceId
          || existing.actor_reference !== actorReference
          || existing.request_fingerprint !== requestFingerprint) throw new Error("reliability_approval_request_collision");
        return { requestId: existing.id, operationKey, status: existing.status, authorizationId: existing.authorization_id, replayed: true };
      }
      await appendAudit(tx, {
        organizationId, outletId, actorReference, eventType: "reliability.approval.requested",
        aggregateType: "approval_request", aggregateId: requestId, correlationId: operationKey,
        payload: { action, resourceType, resourceId }, occurredAt: requestedAt,
      });
      return { requestId, operationKey, status: "PENDING", authorizationId: null, replayed: false };
    });
  }

  async approveAuthorizationRequest(input) {
    const organizationId = requiredText(input.organizationId, "organization_id_required");
    const outletId = requiredText(input.outletId, "outlet_id_required");
    const requestId = requiredText(input.requestId, "approval_request_id_required");
    const approvedByReference = requiredText(input.approvedByReference, "approval_checker_required", 160);
    const approvedAt = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const request = (await tx.query(
        `select * from sagaops.esb_reliability_approval_requests
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [requestId, organizationId, outletId],
      )).rows[0];
      if (!request) throw new Error("approval_request_not_found");
      if (request.status === "APPROVED") return {
        requestId, authorizationId: request.authorization_id, operationKey: request.operation_key,
        command: request.command_snapshot, status: "APPROVED", replayed: true,
      };
      if (request.actor_reference === approvedByReference) throw new Error("maker_checker_distinct_principals_required");
      const authorizationId = randomUUID();
      const expiresAt = new Date(new Date(approvedAt).getTime() + 15 * 60_000).toISOString();
      const authorization = {
        organizationId, outletId, action: request.action, resourceType: request.resource_type,
        resourceId: request.resource_id, actorReference: request.actor_reference, operationKey: request.operation_key,
      };
      await tx.query(
        `insert into sagaops.esb_reliability_authorizations
          (id,organization_id,outlet_id,action,resource_type,resource_id,actor_reference,
           requested_by_reference,approved_by_reference,binding_hash,status,issued_at,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AVAILABLE',$11,$12)`,
        [authorizationId, organizationId, outletId, request.action, request.resource_type, request.resource_id,
          request.actor_reference, request.actor_reference, approvedByReference, reliabilityBindingHash(authorization), approvedAt, expiresAt],
      );
      await tx.query(
        `update sagaops.esb_reliability_approval_requests
            set status='APPROVED',authorization_id=$1,approved_by_reference=$2,approved_at=$3
          where id=$4`,
        [authorizationId, approvedByReference, approvedAt, requestId],
      );
      await appendAudit(tx, {
        organizationId, outletId, actorReference: approvedByReference, eventType: "reliability.approval.approved",
        aggregateType: "approval_request", aggregateId: requestId, correlationId: request.operation_key,
        payload: { authorizationId, action: request.action, executorReference: request.actor_reference }, occurredAt: approvedAt,
      });
      return {
        requestId, authorizationId, operationKey: request.operation_key, command: request.command_snapshot,
        executorReference: request.actor_reference, status: "APPROVED", expiresAt, replayed: false,
      };
    });
  }

  async reserveRecipeConsumption(input) {
    const snapshot = validateConsumptionSnapshot(input.consumptionSnapshot, input.operationKey);
    const requirements = snapshot.movements.map((movement) => ({
      ingredientId: movement.ingredientId,
      quantityBase: movement.quantityBase,
    }));
    const requestFingerprint = requireFingerprint(input.requestFingerprint);
    const occurredAt = iso(input.occurredAt ?? this.clock().toISOString());
    const repository = this;
    const adapter = {
      async withTransaction(work) {
        return repository.db.transaction(async (tx) => {
          const context = { tx, reservationId: randomUUID(), recipeSnapshotId: randomUUID(), overrideConsumed: false };
          return work({
            requiresDurableAuthorization: true,
            findOperation: async ({ organizationId, operationKey }) => {
              const result = await tx.query(
                "select outlet_id,request_fingerprint,result_snapshot from sagaops.esb_reliability_operations where organization_id=$1 and operation_key=$2",
                [organizationId, operationKey],
              );
              if (!result.rows[0]) return null;
              if (result.rows[0].outlet_id !== input.outletId || result.rows[0].request_fingerprint !== requestFingerprint) {
                throw new Error("reliability_operation_collision");
              }
              return result.rows[0].result_snapshot;
            },
            lockBalancesForUpdate: async ({ organizationId, outletId, ingredientIds }) => {
              const result = await tx.query(
                `select organization_id,outlet_id,ingredient_id,quantity_base,inventory_mode,version
                   from sagaops.esb_inventory_balances
                  where organization_id=$1 and outlet_id=$2 and ingredient_id = any($3::uuid[])
                  order by ingredient_id for update`,
                [organizationId, outletId, ingredientIds],
              );
              return result.rows.map(mapInventoryBalance);
            },
            consumeNegativeOverride: async ({ approval, organizationId, outletId, operationKey }) => {
              if (context.overrideConsumed) return true;
              const bindingHash = reliabilityBindingHash({
                organizationId,
                outletId,
                action: "inventory:negative_stock",
                resourceType: "inventory_reservation",
                resourceId: operationKey,
                actorReference: approval.actorReference,
                operationKey,
              });
              const consumed = await tx.query(
                `update sagaops.esb_reliability_authorizations
                    set status='CONSUMED',consumed_at=$1,consumed_operation_key=$2
                  where organization_id=$3 and outlet_id=$4 and id=$5
                    and action='inventory:negative_stock' and resource_type='inventory_reservation'
                    and resource_id=$2 and actor_reference=$6 and binding_hash=$7
                    and status='AVAILABLE' and expires_at>$1
                  returning id`,
                [occurredAt, operationKey, organizationId, outletId, approval.id, approval.actorReference, bindingHash],
              );
              context.overrideConsumed = consumed.rows.length === 1;
              return context.overrideConsumed;
            },
            appendReservation: async (reservation) => {
              const resultSnapshot = JSON.stringify(reservation);
              await tx.query(
                `insert into sagaops.esb_reliability_operations
                  (organization_id,outlet_id,operation_key,operation_kind,request_fingerprint,result_snapshot,created_at)
                 values ($1,$2,$3,'INVENTORY_RESERVATION',$4,$5::jsonb,$6)`,
                [input.organizationId, input.outletId, input.operationKey, requestFingerprint, resultSnapshot, occurredAt],
              );
              await tx.query(
                `insert into sagaops.esb_inventory_reservations
                  (id,organization_id,outlet_id,operation_key,status,override_authorization_id,result_snapshot,created_at)
                 values ($1,$2,$3,$4,'RESERVED',$5,$6::jsonb,$7)`,
                [context.reservationId, input.organizationId, input.outletId, input.operationKey, context.overrideConsumed ? input.overrideApproval.id : null, resultSnapshot, occurredAt],
              );
              const snapshotHash = hash(snapshot);
              await tx.query(
                `insert into sagaops.esb_recipe_consumption_snapshots
                  (id,organization_id,outlet_id,reservation_id,operation_key,order_line_reference,snapshot_hash,snapshot,created_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
                [context.recipeSnapshotId, input.organizationId, input.outletId, context.reservationId, input.operationKey, snapshot.orderLineId, snapshotHash, JSON.stringify(snapshot), occurredAt],
              );
              for (const update of reservation.updates) {
                if (update.inventoryMode === "UNLIMITED") continue;
                await tx.query(
                  `insert into sagaops.esb_inventory_movement_facts
                    (organization_id,outlet_id,reservation_id,recipe_snapshot_id,ingredient_id,operation_key,quantity_delta_base,before_quantity_base,after_quantity_base,inventory_mode,created_at)
                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'TRACKED',$10)`,
                  [input.organizationId, input.outletId, context.reservationId, context.recipeSnapshotId, update.ingredientId, `${input.operationKey}:${update.ingredientId}`, `-${update.quantityBase}`, update.beforeQuantityBase, update.afterQuantityBase, occurredAt],
                );
              }
              repository.faultInjector("after_inventory_facts");
            },
            updateBalance: async (update) => {
              const changed = await tx.query(
                `update sagaops.esb_inventory_balances
                    set quantity_base=$1,version=version+1,updated_at=$2
                  where organization_id=$3 and outlet_id=$4 and ingredient_id=$5 and version=$6
                  returning version`,
                [update.afterQuantityBase, occurredAt, input.organizationId, input.outletId, update.ingredientId, update.expectedVersion],
              );
              return changed.rows.length === 1;
            },
            appendOutbox: async ({ eventType, payload }) => {
              await appendOutbox(tx, {
                organizationId: input.organizationId,
                outletId: input.outletId,
                eventType: `${eventType}_V1`,
                payload: { operationKey: input.operationKey, reservationId: context.reservationId, result: payload },
                occurredAt,
              });
              await appendAudit(tx, {
                organizationId: input.organizationId,
                outletId: input.outletId,
                actorReference: input.actorReference,
                eventType: "inventory.reserved",
                aggregateType: "inventory_reservation",
                aggregateId: context.reservationId,
                correlationId: input.operationKey,
                payload: { ingredientCount: reservationIngredientCount(payload), negativeOverrideUsed: context.overrideConsumed },
                occurredAt,
              });
              repository.faultInjector("after_inventory_outbox");
            },
          });
        });
      },
    };
    return reserveLastStock({ ...input, adapter, requirements });
  }

  async persistInventoryLedgerMovement(input) {
    const organizationId = requiredText(input.organizationId, "organization_id_required");
    const outletId = requiredText(input.outletId, "outlet_id_required");
    const ingredientId = requiredText(input.ingredientId, "ingredient_id_required");
    const operationKey = requiredText(input.operationKey, "inventory_operation_key_required", 160);
    const sourceReference = requiredText(input.sourceReference, "inventory_source_reference_required", 200);
    const actorReference = requiredText(input.actorReference, "actor_reference_required", 160);
    const serverNow = iso(this.clock().toISOString());
    if (input.occurredAt != null) {
      const requestedOccurredAt = iso(input.occurredAt);
      if (Math.abs(new Date(requestedOccurredAt).getTime() - new Date(serverNow).getTime()) > 300_000) throw new Error("inventory_occurred_at_out_of_bounds");
    }
    const occurredAt = serverNow;
    const movementKind = String(input.movementKind ?? "").toUpperCase();
    const action = INVENTORY_AUTH_ACTIONS[movementKind];
    if (!action) throw new Error("inventory_movement_kind_invalid");
    const authorizationId = requiredText(input.authorizationId, "inventory_authorization_required", 160);
    const requestFingerprint = requireBoundFingerprint(input.requestFingerprint, inventoryLedgerCommandFingerprint({
      organizationId, outletId, ingredientId, operationKey, sourceReference, actorReference,
      movementKind, authorizationId, quantityBase: input.quantityBase,
      quantityDeltaBase: input.quantityDeltaBase, reversalOfEntryId: input.reversalOfEntryId,
    }));

    return this.db.transaction(async (tx) => {
      const replay = await findOperation(tx, organizationId, outletId, operationKey, requestFingerprint);
      if (replay) return { ...replay, replayed: true };

      const balance = (await tx.query(
        `select inventory_mode,quantity_base::text,version from sagaops.esb_inventory_balances
          where organization_id=$1 and outlet_id=$2 and ingredient_id=$3 for update`,
        [organizationId, outletId, ingredientId],
      )).rows[0];
      if (!balance) throw new Error("inventory_balance_not_found");
      const duplicateSource = (await tx.query(
        `select id from sagaops.esb_inventory_ledger_entries
          where organization_id=$1 and outlet_id=$2 and ingredient_id=$3
            and movement_kind=$4 and source_reference=$5`,
        [organizationId, outletId, ingredientId, movementKind, sourceReference],
      )).rows[0];
      if (duplicateSource) throw new Error("inventory_source_already_recorded");

      let reversalOfEntryId = null;
      let signedUnits;
      if (movementKind === "REVERSAL") {
        reversalOfEntryId = requiredText(input.reversalOfEntryId, "inventory_reversal_source_required", 100);
        const original = (await tx.query(
          `select id,ingredient_id,quantity_delta_base::text,movement_kind
             from sagaops.esb_inventory_ledger_entries
            where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
          [reversalOfEntryId, organizationId, outletId],
        )).rows[0];
        if (!original || original.ingredient_id !== ingredientId || original.movement_kind === "REVERSAL") throw new Error("inventory_reversal_source_invalid");
        const alreadyReversed = (await tx.query(
          "select id from sagaops.esb_inventory_ledger_entries where organization_id=$1 and reversal_of_entry_id=$2",
          [organizationId, reversalOfEntryId],
        )).rows[0];
        if (alreadyReversed) throw new Error("inventory_reversal_already_recorded");
        signedUnits = -parseSignedQuantityUnits(original.quantity_delta_base);
      } else if (movementKind === "ADJUSTMENT") {
        signedUnits = parseSignedQuantityUnits(input.quantityDeltaBase);
      } else {
        const absolute = parsePositiveQuantityUnits(input.quantityBase);
        signedUnits = movementKind === "WASTE" ? -absolute : absolute;
      }
      if (signedUnits === 0n) throw new Error("inventory_movement_quantity_invalid");

      await consumeAuthorization(tx, {
        id: authorizationId, organizationId, outletId, action,
        resourceType: "inventory_ledger", resourceId: inventoryLedgerAuthorizationResource({
          ingredientId, movementKind, quantityBase: input.quantityBase,
          quantityDeltaBase: input.quantityDeltaBase, sourceReference, reversalOfEntryId,
        }),
        actorReference, operationKey, occurredAt: serverNow,
      });

      const inventoryMode = balance.inventory_mode;
      if (!new Set(["TRACKED", "UNLIMITED"]).has(inventoryMode)) throw new Error("inventory_mode_invalid");
      const beforeUnits = inventoryMode === "TRACKED" ? parseSignedQuantityUnits(balance.quantity_base) : null;
      const afterUnits = inventoryMode === "TRACKED" ? beforeUnits + signedUnits : null;
      if (afterUnits != null && afterUnits < 0n) throw new Error("inventory_quantity_insufficient");
      const entryId = randomUUID();
      const result = {
        entryId, operationKey, movementKind, ingredientId, inventoryMode,
        quantityDeltaBase: formatSignedQuantityUnits(signedUnits),
        beforeQuantityBase: beforeUnits == null ? null : formatSignedQuantityUnits(beforeUnits),
        afterQuantityBase: afterUnits == null ? null : formatSignedQuantityUnits(afterUnits),
        reversalOfEntryId,
      };
      await insertOperation(tx, organizationId, outletId, operationKey, `INVENTORY_${movementKind}`, requestFingerprint, result, occurredAt);
      await tx.query(
        `insert into sagaops.esb_inventory_ledger_entries
          (id,organization_id,outlet_id,ingredient_id,operation_key,movement_kind,quantity_delta_base,
           before_quantity_base,after_quantity_base,inventory_mode,source_reference,reversal_of_entry_id,
           authorization_id,actor_reference,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [entryId, organizationId, outletId, ingredientId, operationKey, movementKind,
          result.quantityDeltaBase, result.beforeQuantityBase, result.afterQuantityBase, inventoryMode,
          sourceReference, reversalOfEntryId, authorizationId, actorReference, occurredAt],
      );
      if (inventoryMode === "TRACKED") {
        const updated = await tx.query(
          `update sagaops.esb_inventory_balances set quantity_base=$1,version=version+1,updated_at=$2
            where organization_id=$3 and outlet_id=$4 and ingredient_id=$5 and version=$6 returning version`,
          [result.afterQuantityBase, occurredAt, organizationId, outletId, ingredientId, balance.version],
        );
        if (updated.rows.length !== 1) throw new Error("inventory_concurrent_update_detected");
      }
      await appendAudit(tx, {
        organizationId, outletId, actorReference, eventType: `inventory.${movementKind.toLowerCase()}`,
        aggregateType: "inventory_ledger", aggregateId: entryId, correlationId: operationKey,
        payload: { movementKind, ingredientId, sourceReference, reversalOfEntryId }, occurredAt,
      });
      await appendOutbox(tx, {
        organizationId, outletId, eventType: "INVENTORY_LEDGER_MOVEMENT_V1",
        payload: { entryId, operationKey, movementKind, ingredientId }, occurredAt,
      });
      await this.faultInjector("after_inventory_ledger_outbox");
      return { ...result, replayed: false };
    });
  }

  async reconstructInventoryLedger({ organizationId, outletId, ingredientId }) {
    for (const [value, code] of [[organizationId, "organization_id_required"], [outletId, "outlet_id_required"], [ingredientId, "ingredient_id_required"]]) requiredText(value, code);
    return this.db.transaction(async (tx) => {
      const balance = (await tx.query(
        `select inventory_mode,quantity_base::text from sagaops.esb_inventory_balances
          where organization_id=$1 and outlet_id=$2 and ingredient_id=$3 for share`,
        [organizationId, outletId, ingredientId],
      )).rows[0];
      if (!balance) throw new Error("inventory_balance_not_found");
      const rows = (await tx.query(
        `select id,ledger_sequence,operation_key,movement_kind,quantity_delta_base::text,before_quantity_base::text,
                after_quantity_base::text,reversal_of_entry_id,source_reference,occurred_at
           from sagaops.esb_inventory_ledger_entries
          where organization_id=$1 and outlet_id=$2 and ingredient_id=$3
          order by ledger_sequence`,
        [organizationId, outletId, ingredientId],
      )).rows;
      let previousAfter = null;
      for (const row of rows) {
        if (balance.inventory_mode === "UNLIMITED") {
          if (row.before_quantity_base != null || row.after_quantity_base != null) throw new Error("inventory_ledger_chain_invalid");
          continue;
        }
        const before = formatSignedQuantityUnits(parseSignedQuantityUnits(row.before_quantity_base));
        const delta = parseSignedQuantityUnits(row.quantity_delta_base);
        const after = formatSignedQuantityUnits(parseSignedQuantityUnits(row.after_quantity_base));
        if ((previousAfter != null && before !== previousAfter)
          || after !== formatSignedQuantityUnits(parseSignedQuantityUnits(before) + delta)) throw new Error("inventory_ledger_chain_invalid");
        previousAfter = after;
      }
      const current = formatSignedQuantityUnits(parseSignedQuantityUnits(balance.quantity_base));
      if (balance.inventory_mode === "TRACKED" && rows.length > 0 && previousAfter !== current) throw new Error("inventory_ledger_balance_drift");
      return {
        organizationId, outletId, ingredientId, inventoryMode: balance.inventory_mode,
        quantityBase: current, entryCount: rows.length, ledgerFingerprint: hash(rows), entries: rows,
      };
    });
  }

  async previewShiftClose(input) {
    const organizationId = requiredText(input.organizationId, "organization_id_required");
    const outletId = requiredText(input.outletId, "outlet_id_required");
    const shiftId = requiredText(input.shiftId, "shift_id_required");
    const reason = requiredText(input.reason, "shift_close_reason_required", 240);
    const declaredCashRupiah = nonNegativeSafeMoney(input.declaredCashRupiah, "shift_declared_cash_invalid");
    const cashToLeaveRupiah = nonNegativeSafeMoney(input.cashToLeaveRupiah ?? 0, "shift_cash_to_leave_invalid");
    if (cashToLeaveRupiah > declaredCashRupiah) throw new Error("shift_cash_to_leave_exceeds_declared");
    const previewedAt = this.clock().toISOString();
    return this.db.transaction(async (tx) => {
      const shift = (await tx.query(
        `select id,status,opening_cash_rupiah,business_date,opened_at from sagaops.cash_sessions
          where organization_id=$1 and outlet_id=$2 and id=$3 for share`,
        [organizationId, outletId, shiftId],
      )).rows[0];
      if (!shift) throw new Error("shift_not_found");
      if (shift.status !== "open") throw new Error("shift_state_conflict");
      const movements = await loadShiftCashMovements(tx, { organizationId, outletId, shiftId });
      assertShiftMovementWindow(movements, shift.opened_at, previewedAt);
      const ledger = buildShiftCashLedger({
        openingCashRupiah: Number(shift.opening_cash_rupiah), declaredCashRupiah,
        movements: movements.map(({ occurredAt: _occurredAt, ...movement }) => movement),
      });
      const ledgerFingerprint = hash(movements);
      const preview = {
        shiftId, declaredCashRupiah, cashToLeaveRupiah,
        expectedCashRupiah: ledger.expectedCashRupiah, varianceRupiah: ledger.varianceRupiah,
        ledgerFingerprint, movementCount: movements.length, reason, previewedAt,
      };
      return { ...preview, authorizationResource: shiftCloseAuthorizationResource(preview) };
    });
  }

  async closeShiftFromLedger(input) {
    const organizationId = requiredText(input.organizationId, "organization_id_required");
    const outletId = requiredText(input.outletId, "outlet_id_required");
    const shiftId = requiredText(input.shiftId, "shift_id_required");
    const operationKey = requiredText(input.operationKey, "shift_operation_key_required", 160);
    const authorizationId = input.authorizationId == null ? null : requiredText(input.authorizationId, "shift_authorization_required", 160);
    const actorReference = requiredText(input.actorReference, "actor_reference_required", 160);
    const reason = requiredText(input.reason, "shift_close_reason_required", 240);
    const declaredCashRupiah = nonNegativeSafeMoney(input.declaredCashRupiah, "shift_declared_cash_invalid");
    const cashToLeaveRupiah = nonNegativeSafeMoney(input.cashToLeaveRupiah ?? 0, "shift_cash_to_leave_invalid");
    if (cashToLeaveRupiah > declaredCashRupiah) throw new Error("shift_cash_to_leave_exceeds_declared");
    const closedAt = this.clock().toISOString();
    const requestFingerprint = requireBoundFingerprint(input.requestFingerprint, shiftCloseCommandFingerprint({
      organizationId, outletId, shiftId, operationKey, authorizationId, actorReference,
      reason, declaredCashRupiah, cashToLeaveRupiah,
    }));

    return this.db.transaction(async (tx) => {
      const replay = await findOperation(tx, organizationId, outletId, operationKey, requestFingerprint);
      if (replay) return { ...replay, replayed: true };
      const shift = (await tx.query(
        `select id,status,opening_cash_rupiah,business_date,opened_at from sagaops.cash_sessions
          where organization_id=$1 and outlet_id=$2 and id=$3 for update`,
        [organizationId, outletId, shiftId],
      )).rows[0];
      if (!shift) throw new Error("shift_not_found");
      if (shift.status !== "open") throw new Error("shift_state_conflict");
      const movements = await loadShiftCashMovements(tx, { organizationId, outletId, shiftId });
      const openedAt = new Date(shift.opened_at).toISOString();
      assertShiftMovementWindow(movements, openedAt, closedAt);
      const ledger = buildShiftCashLedger({
        openingCashRupiah: Number(shift.opening_cash_rupiah), declaredCashRupiah,
        movements: movements.map(({ occurredAt: _occurredAt, ...movement }) => movement),
      });
      if (ledger.expectedCashRupiah < 0) throw new Error("shift_expected_cash_negative");
      const ledgerFingerprint = hash(movements);
      if (authorizationId != null || ledger.varianceRupiah !== 0) {
        if (!authorizationId) throw new Error("shift_variance_authorization_required");
        await consumeAuthorization(tx, {
          id: authorizationId, organizationId, outletId, action: "shift:close",
          resourceType: "shift", resourceId: shiftCloseAuthorizationResource({
            shiftId, declaredCashRupiah, cashToLeaveRupiah,
            expectedCashRupiah: ledger.expectedCashRupiah, varianceRupiah: ledger.varianceRupiah,
            ledgerFingerprint, reason,
          }),
          actorReference, operationKey, occurredAt: closedAt,
        });
      }
      const closureId = randomUUID();
      const closeRevision = Number((await tx.query(
        `select coalesce(max(close_revision),0)::integer + 1 close_revision
           from sagaops.esb_shift_closures
          where organization_id=$1 and outlet_id=$2 and cash_session_id=$3`,
        [organizationId, outletId, shiftId],
      )).rows[0].close_revision);
      const result = {
        closureId, shiftId, operationKey, status: "CLOSED",
        openingCashRupiah: ledger.openingCashRupiah, expectedCashRupiah: ledger.expectedCashRupiah,
        declaredCashRupiah, varianceRupiah: ledger.varianceRupiah,
        cashToLeaveRupiah, depositCashRupiah: declaredCashRupiah - cashToLeaveRupiah,
        movementCount: movements.length, ledgerFingerprint, closeRevision, closedAt,
      };
      await insertOperation(tx, organizationId, outletId, operationKey, "SHIFT_CLOSE", requestFingerprint, result, closedAt);
      await tx.query(
        `insert into sagaops.esb_shift_closures
          (id,organization_id,outlet_id,cash_session_id,operation_key,request_fingerprint,authorization_id,
           actor_reference,opening_cash_rupiah,expected_cash_rupiah,declared_cash_rupiah,variance_rupiah,
           cash_to_leave_rupiah,deposit_cash_rupiah,close_revision,
           movement_count,ledger_fingerprint,close_snapshot,closed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
        [closureId, organizationId, outletId, shiftId, operationKey, requestFingerprint, authorizationId,
          actorReference, ledger.openingCashRupiah, ledger.expectedCashRupiah, declaredCashRupiah,
          ledger.varianceRupiah, cashToLeaveRupiah, declaredCashRupiah - cashToLeaveRupiah,
          closeRevision, movements.length, ledgerFingerprint,
          JSON.stringify({ ...result, businessDate: String(shift.business_date), formula: ledger.formula, movements }), closedAt],
      );
      await tx.query(
        `update sagaops.cash_sessions
            set status='closed',expected_cash_rupiah=$1,actual_cash_rupiah=$2,variance_rupiah=$3,
                cash_to_leave_rupiah=$4,deposit_cash_rupiah=$5,closing_note=$6,closed_at=$7,updated_at=$7
          where organization_id=$8 and outlet_id=$9 and id=$10`,
        [ledger.expectedCashRupiah, declaredCashRupiah, ledger.varianceRupiah,
          cashToLeaveRupiah, declaredCashRupiah - cashToLeaveRupiah, reason, closedAt,
          organizationId, outletId, shiftId],
      );
      await appendAudit(tx, {
        organizationId, outletId, actorReference, eventType: "shift.closed_from_esb_ledger",
        aggregateType: "cash_session", aggregateId: shiftId, correlationId: operationKey,
        payload: { closureId, expectedCashRupiah: ledger.expectedCashRupiah, varianceRupiah: ledger.varianceRupiah, movementCount: movements.length },
        occurredAt: closedAt,
      });
      await appendOutbox(tx, {
        organizationId, outletId, eventType: "SHIFT_CLOSED_FROM_ESB_LEDGER_V1",
        payload: { closureId, shiftId, operationKey, ledgerFingerprint }, occurredAt: closedAt,
      });
      await this.faultInjector("after_shift_close_outbox");
      return { ...result, replayed: false };
    });
  }

  async persistCashDrop({ prepared, requestFingerprint }) {
    const movement = prepared?.movement;
    if (!movement) throw new Error("cash_drop_command_required");
    return this.db.transaction(async (tx) => {
      const replay = await findOperation(tx, movement.organizationId, movement.outletId, movement.operationKey, requestFingerprint);
      if (replay) return { ...replay, replayed: true };
      await lockCashSession(tx, movement.organizationId, movement.outletId, movement.shiftId, "open");
      const eventId = randomUUID();
      const result = { eventId, operationKey: movement.operationKey, status: "RECORDED" };
      await insertOperation(tx, movement.organizationId, movement.outletId, movement.operationKey, "CASH_DROP", requestFingerprint, result, movement.occurredAt);
      await tx.query(
        `insert into sagaops.esb_shift_events
          (id,organization_id,outlet_id,cash_session_id,operation_key,event_type,actor_reference,reason,event_snapshot,occurred_at)
         values ($1,$2,$3,$4,$5,'CASH_DROP',$6,$7,$8::jsonb,$9)`,
        [eventId, movement.organizationId, movement.outletId, movement.shiftId, movement.operationKey, movement.actorId, movement.reason, JSON.stringify(prepared), movement.occurredAt],
      );
      await tx.query(
        `insert into sagaops.esb_shift_cash_movements
          (organization_id,outlet_id,cash_session_id,shift_event_id,operation_key,movement_kind,signed_amount_rupiah,source_reference,occurred_at)
         values ($1,$2,$3,$4,$5,'CASH_DROP',$6,$7,$8)`,
        [movement.organizationId, movement.outletId, movement.shiftId, eventId, movement.operationKey, movement.signedAmountRupiah, eventId, movement.occurredAt],
      );
      await appendReliabilityAuditAndOutbox(tx, { ...movement, actorReference: movement.actorId, eventId, eventType: "SHIFT_CASH_DROP_V1", payload: result });
      await this.faultInjector("after_cash_drop_outbox");
      return { ...result, replayed: false };
    });
  }

  async persistShiftReopen({ prepared, requestFingerprint }) {
    const event = prepared?.event;
    if (!event) throw new Error("shift_reopen_command_required");
    return this.db.transaction(async (tx) => {
      const replay = await findOperation(tx, event.organizationId, event.outletId, event.operationKey, requestFingerprint);
      if (replay) return { ...replay, replayed: true };
      await lockCashSession(tx, event.organizationId, event.outletId, event.shiftId, "closed", "approved");
      await consumeAuthorization(tx, {
        id: event.authorizationId,
        organizationId: event.organizationId,
        outletId: event.outletId,
        action: "shift:reopen",
        resourceType: "shift",
        resourceId: event.shiftId,
        actorReference: event.actorId,
        operationKey: event.operationKey,
        occurredAt: event.occurredAt,
      });
      const eventId = randomUUID();
      const result = { eventId, operationKey: event.operationKey, status: "OPEN" };
      await insertOperation(tx, event.organizationId, event.outletId, event.operationKey, "SHIFT_REOPEN", requestFingerprint, result, event.occurredAt);
      await tx.query(
        `insert into sagaops.esb_shift_events
          (id,organization_id,outlet_id,cash_session_id,operation_key,event_type,actor_reference,authorization_id,reason,event_snapshot,occurred_at)
         values ($1,$2,$3,$4,$5,'SHIFT_REOPENED',$6,$7,$8,$9::jsonb,$10)`,
        [eventId, event.organizationId, event.outletId, event.shiftId, event.operationKey, event.actorId, event.authorizationId, event.reason, JSON.stringify(prepared), event.occurredAt],
      );
      await tx.query("update sagaops.cash_sessions set status='open',closed_at=null,updated_at=$1 where id=$2", [event.occurredAt, event.shiftId]);
      await appendReliabilityAuditAndOutbox(tx, { ...event, actorReference: event.actorId, eventId, eventType: "SHIFT_REOPENED_V1", payload: result });
      await this.faultInjector("after_shift_reopen_outbox");
      return { ...result, replayed: false };
    });
  }

  async enqueuePrintJobs(input) {
    const jobs = input.jobs ?? buildPrintJobs(input);
    if (!Array.isArray(jobs) || jobs.length === 0) throw new Error("print_jobs_required");
    const fingerprint = requireFingerprint(input.requestFingerprint);
    return this.db.transaction(async (tx) => {
      const replay = await findOperation(tx, input.organizationId, input.outletId, input.operationKey, fingerprint);
      if (replay) return { ...replay, replayed: true };
      const persisted = [];
      for (const job of jobs) {
        if (job.hardwareActivation !== HARDWARE_ACTIVATION) throw new Error("print_hardware_activation_denied");
        const id = randomUUID();
        await tx.query(
          `insert into sagaops.esb_print_jobs
            (id,organization_id,outlet_id,bill_id,logical_job_id,source_logical_job_id,destination,copy_number,copy_kind,status,hardware_activation,station_snapshot,template_snapshot,sale_snapshot,content_snapshot,reprint_authorization)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED',$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)`,
          [id, job.organizationId, job.outletId, job.billId, job.logicalJobId, job.sourceLogicalJobId ?? null, job.destination, job.copyNumber, job.copyKind, HARDWARE_ACTIVATION, JSON.stringify(job.stationSnapshot), JSON.stringify(job.templateSnapshot), JSON.stringify(job.saleSnapshot), JSON.stringify(job.contentSnapshot), job.reprintAuthorization ? JSON.stringify(job.reprintAuthorization) : null],
        );
        persisted.push({ id, logicalJobId: job.logicalJobId, status: "QUEUED", hardwareActivation: HARDWARE_ACTIVATION });
      }
      const result = { jobs: persisted };
      await insertOperation(tx, input.organizationId, input.outletId, input.operationKey, "PRINT_ENQUEUE", fingerprint, result, this.clock().toISOString());
      await appendOutbox(tx, { organizationId: input.organizationId, outletId: input.outletId, eventType: "PRINT_JOBS_QUEUED_V1", payload: { operationKey: input.operationKey, jobs: persisted }, occurredAt: this.clock().toISOString() });
      await this.faultInjector("after_print_enqueue_outbox");
      return { ...result, replayed: false };
    });
  }

  async recordPrintAttempt({ organizationId, outletId, logicalJobId, attempt }) {
    if (attempt?.outcome === "PRINTED") throw new Error("print_hardware_activation_denied");
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select * from sagaops.esb_print_jobs where organization_id=$1 and outlet_id=$2 and logical_job_id=$3 for update",
        [organizationId, outletId, logicalJobId],
      )).rows[0];
      if (!row) throw new Error("print_job_not_found");
      const existing = (await tx.query("select outcome,adapter,attempted_at from sagaops.esb_print_attempts where organization_id=$1 and attempt_id=$2", [organizationId, attempt.attemptId])).rows[0];
      if (existing) {
        if (existing.outcome !== attempt.outcome || existing.adapter !== attempt.adapter || new Date(existing.attempted_at).toISOString() !== iso(attempt.attemptedAt)) throw new Error("print_attempt_collision");
        return { logicalJobId, status: row.status, replayed: true };
      }
      const domainJob = mapPrintJob(row, await loadPrintAttempts(tx, row.id));
      const next = recordPrintAttempt(domainJob, attempt);
      await tx.query(
        `insert into sagaops.esb_print_attempts
          (organization_id,outlet_id,print_job_id,attempt_id,outcome,adapter,attempted_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [organizationId, outletId, row.id, attempt.attemptId, attempt.outcome, attempt.adapter, attempt.attemptedAt],
      );
      await tx.query("update sagaops.esb_print_jobs set status=$1,attempt_count=attempt_count+1,updated_at=$2 where id=$3", [next.status, attempt.attemptedAt, row.id]);
      await this.faultInjector("after_print_attempt");
      return { logicalJobId, status: next.status, replayed: false, copyKind: row.copy_kind };
    });
  }

  async enqueueReprint({ organizationId, outletId, sourceLogicalJobId, operationKey, requestFingerprint, actorId, reason, copyNumber, requestedAt }) {
    const source = await this.loadPrintJob({ organizationId, outletId, logicalJobId: sourceLogicalJobId });
    const job = prepareReprint(source, { actorId, reason, copyNumber, requestedAt, logicalJobId: `${operationKey}:${source.destination}` });
    return this.enqueuePrintJobs({ organizationId, outletId, operationKey, requestFingerprint, jobs: [job] });
  }

  async loadPrintJob({ organizationId, outletId, logicalJobId }) {
    const row = (await this.db.query("select * from sagaops.esb_print_jobs where organization_id=$1 and outlet_id=$2 and logical_job_id=$3", [organizationId, outletId, logicalJobId])).rows[0];
    if (!row) throw new Error("print_job_not_found");
    return mapPrintJob(row, await loadPrintAttempts(this.db, row.id));
  }

  async persistOfflineOperation({ operation: supplied, currentVersions }) {
    const operation = supplied?.operationId ? supplied : createOfflineOperation(supplied);
    const conflict = evaluateOfflineConflict(operation, currentVersions);
    return this.db.transaction(async (tx) => {
      const existing = (await tx.query(
        "select id,operation_fingerprint,status from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3",
        [operation.organizationId, operation.outletId, operation.operationId],
      )).rows[0];
      if (existing) {
        if (existing.operation_fingerprint !== operation.fingerprint) throw new Error("offline_operation_collision");
        return { id: existing.id, operationId: operation.operationId, status: existing.status, replayed: true };
      }
      const id = randomUUID();
      const status = conflict.decision === "APPLY" ? "PENDING_REPLAY" : "REVIEW_REQUIRED";
      await tx.query(
        `insert into sagaops.esb_offline_operations
          (id,organization_id,outlet_id,operation_id,device_id,local_operation_id,operation_kind,operation_fingerprint,base_versions,payload_snapshot,status,occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
        [id, operation.organizationId, operation.outletId, operation.operationId, operation.deviceId, operation.localOperationId, operation.kind, operation.fingerprint, JSON.stringify(operation.baseVersions), JSON.stringify(operation.payload), status, operation.occurredAt],
      );
      if (status === "REVIEW_REQUIRED") {
        await tx.query(
          `insert into sagaops.esb_offline_conflicts
            (organization_id,outlet_id,offline_operation_id,decision,conflict_snapshot)
           values ($1,$2,$3,'REVIEW_REQUIRED',$4::jsonb)`,
          [operation.organizationId, operation.outletId, id, JSON.stringify(conflict)],
        );
      } else {
        await appendOutbox(tx, { organizationId: operation.organizationId, outletId: operation.outletId, eventType: "OFFLINE_OPERATION_READY_V1", payload: { offlineOperationId: id, operationId: operation.operationId }, occurredAt: operation.occurredAt });
      }
      await appendAudit(tx, { organizationId: operation.organizationId, outletId: operation.outletId, actorReference: operation.deviceId, eventType: "offline.operation.persisted", aggregateType: "offline_operation", aggregateId: id, correlationId: operation.operationId, payload: { status, conflictCount: conflict.conflicts.length }, occurredAt: operation.occurredAt });
      await this.faultInjector("after_offline_outbox");
      return { id, operationId: operation.operationId, status, replayed: false };
    });
  }

  async resolveOfflineConflict({ organizationId, outletId, operationId, decision, actorReference, decidedAt }) {
    if (!new Set(["ACCEPT_SERVER_REQUOTE", "REJECT_OFFLINE_OPERATION"]).has(decision)) throw new Error("offline_conflict_decision_invalid");
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select * from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3 for update",
        [organizationId, outletId, operationId],
      )).rows[0];
      if (!row) throw new Error("offline_operation_not_found");
      if (row.status !== "REVIEW_REQUIRED") throw new Error("offline_operation_review_not_required");
      const status = decision === "ACCEPT_SERVER_REQUOTE" ? "PENDING_REPLAY" : "REJECTED";
      await tx.query(
        `insert into sagaops.esb_offline_conflicts
          (organization_id,outlet_id,offline_operation_id,decision,conflict_snapshot,decided_by_reference,decided_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [organizationId, outletId, row.id, decision, JSON.stringify({ priorStatus: row.status }), actorReference, decidedAt],
      );
      await tx.query("update sagaops.esb_offline_operations set status=$1,updated_at=$2 where id=$3", [status, decidedAt, row.id]);
      if (status === "PENDING_REPLAY") await appendOutbox(tx, { organizationId, outletId, eventType: "OFFLINE_OPERATION_READY_V1", payload: { offlineOperationId: row.id, operationId }, occurredAt: decidedAt });
      return { operationId, status };
    });
  }

  async applyOfflineOperation({ organizationId, outletId, operationId, actorReference, appliedAt, applyBusinessFact }) {
    if (typeof applyBusinessFact !== "function") throw new Error("offline_business_fact_adapter_required");
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        "select * from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and operation_id=$3 for update",
        [organizationId, outletId, operationId],
      )).rows[0];
      if (!row) throw new Error("offline_operation_not_found");
      if (row.status === "APPLIED") return { operationId, status: "APPLIED", replayed: true };
      if (row.status !== "PENDING_REPLAY") throw new Error("offline_operation_not_ready");
      const businessResult = await applyBusinessFact(tx, {
        operationId,
        kind: row.operation_kind,
        payload: structuredClone(row.payload_snapshot),
        baseVersions: structuredClone(row.base_versions),
      });
      await this.faultInjector("after_offline_business_fact");
      await tx.query("update sagaops.esb_offline_operations set status='APPLIED',applied_at=$1,updated_at=$1 where id=$2", [appliedAt, row.id]);
      await appendAudit(tx, { organizationId, outletId, actorReference, eventType: "offline.operation.applied", aggregateType: "offline_operation", aggregateId: row.id, correlationId: operationId, payload: { businessResult: businessResult ?? null }, occurredAt: appliedAt });
      await appendOutbox(tx, { organizationId, outletId, eventType: "OFFLINE_OPERATION_APPLIED_V1", payload: { offlineOperationId: row.id, operationId }, occurredAt: appliedAt });
      return { operationId, status: "APPLIED", replayed: false, businessResult: businessResult ?? null };
    });
  }

  async recoverState({ organizationId, outletId }) {
    const result = await this.db.query(
      `select
        (select count(*)::integer from sagaops.esb_inventory_reservations where organization_id=$1 and outlet_id=$2) reservations,
        (select count(*)::integer from sagaops.esb_print_jobs where organization_id=$1 and outlet_id=$2 and status in ('QUEUED','FAILED','UNKNOWN')) print_pending,
        (select count(*)::integer from sagaops.esb_offline_operations where organization_id=$1 and outlet_id=$2 and status in ('PENDING_REPLAY','REVIEW_REQUIRED')) offline_pending,
        (select count(*)::integer from public.sagaops_integration_outbox where organization_id=$1 and outlet_id=$2 and status='pending') outbox_pending`,
      [organizationId, outletId],
    );
    return result.rows[0];
  }
}

function requireFingerprint(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("reliability_request_fingerprint_invalid");
  return value;
}

function requireBoundFingerprint(value, expected) {
  const supplied = requireFingerprint(value);
  if (supplied !== expected) throw new Error("reliability_request_fingerprint_mismatch");
  return supplied;
}

function requiredText(value, code, maximum = 200) {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}

function nonNegativeSafeMoney(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function parsePositiveQuantityUnits(value) {
  const parsed = parseSignedQuantityUnits(value);
  if (parsed <= 0n) throw new Error("inventory_movement_quantity_invalid");
  return parsed;
}

function parseSignedQuantityUnits(value) {
  const text = String(value ?? "");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) throw new Error("inventory_movement_quantity_invalid");
  const negative = text.startsWith("-");
  const absolute = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = absolute.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return negative ? -units : units;
}

function formatSignedQuantityUnits(units) {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, "0")}`;
}

function mapMoneyCashMovement(row) {
  const amount = Number(row.amount_rupiah);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("cash_movement_amount_invalid");
  const type = row.movement_type;
  if (type === "OPENING" || type === "CLOSING") return [];
  const byType = {
    PAYMENT_APPLIED: "CASH_SALE",
    REFUND: "CASH_REFUND",
    DROP: "CASH_DROP",
    EXPENSE: "CASH_OUT",
  };
  const kind = byType[type] ?? (type === "ADJUSTMENT" ? (amount > 0 ? "CASH_IN" : "CASH_OUT") : null);
  if (!kind) throw new Error("cash_movement_kind_invalid");
  const expectedSign = new Set(["CASH_SALE", "CASH_IN"]).has(kind) ? 1 : -1;
  if (Math.sign(amount) !== expectedSign) throw new Error("cash_movement_direction_invalid");
  return [{
    operationKey: `money:${row.id}`, kind, amountRupiah: Math.abs(amount),
    sourceId: String(row.source_reference), sourceLedger: "MONEY", occurredAt: new Date(row.occurred_at).toISOString(),
  }];
}

function mapReliabilityCashMovement(row) {
  const amount = Number(row.signed_amount_rupiah);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("cash_movement_amount_invalid");
  const kind = row.movement_kind;
  const expectedSign = new Set(["CASH_SALE", "CASH_IN"]).has(kind) ? 1 : -1;
  if (!new Set(["CASH_SALE", "CASH_REFUND", "CASH_IN", "CASH_OUT", "CASH_DROP"]).has(kind) || Math.sign(amount) !== expectedSign) {
    throw new Error("cash_movement_direction_invalid");
  }
  return {
    operationKey: `shift:${row.operation_key}`, kind, amountRupiah: Math.abs(amount),
    sourceId: String(row.source_reference), sourceLedger: "SHIFT", occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

async function loadShiftCashMovements(tx, { organizationId, outletId, shiftId }) {
  const moneyRows = (await tx.query(
    `select id::text,movement_type,amount_rupiah,coalesce(payment_attempt_id::text,id::text) source_reference,occurred_at
       from sagaops.esb_cash_movements
      where organization_id=$1 and outlet_id=$2 and cash_session_id=$3
      order by occurred_at,id`,
    [organizationId, outletId, shiftId],
  )).rows;
  const reliabilityRows = (await tx.query(
    `select id::text,movement_kind,signed_amount_rupiah,source_reference,operation_key,occurred_at
       from sagaops.esb_shift_cash_movements
      where organization_id=$1 and outlet_id=$2 and cash_session_id=$3
      order by occurred_at,id`,
    [organizationId, outletId, shiftId],
  )).rows;
  return mergeCashLedgerSources([
    ...moneyRows.flatMap(mapMoneyCashMovement),
    ...reliabilityRows.map(mapReliabilityCashMovement),
  ]).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.operationKey.localeCompare(right.operationKey));
}

function assertShiftMovementWindow(movements, openedAt, closedAt) {
  const lower = new Date(openedAt).toISOString();
  const upper = new Date(closedAt).toISOString();
  if (movements.some((movement) => movement.occurredAt < lower || movement.occurredAt > upper)) throw new Error("shift_cash_movement_outside_close_window");
}

function mergeCashLedgerSources(input) {
  const money = input.filter((movement) => movement.sourceLedger === "MONEY");
  const shift = input.filter((movement) => movement.sourceLedger === "SHIFT");
  const merged = [...money];
  for (const movement of shift) {
    const sameSemanticSource = money.filter((candidate) => candidate.sourceId === movement.sourceId && candidate.kind === movement.kind);
    if (sameSemanticSource.length === 0) {
      merged.push(movement);
      continue;
    }
    const exact = sameSemanticSource.filter((candidate) => candidate.amountRupiah === movement.amountRupiah);
    if (exact.length !== 1) throw new Error("cash_movement_cross_ledger_conflict");
  }
  return merged.map(({ sourceLedger: _sourceLedger, ...movement }) => movement);
}

function validateConsumptionSnapshot(value, operationKey) {
  const snapshot = structuredClone(value);
  if (!snapshot || snapshot.operationKey !== operationKey || typeof snapshot.orderLineId !== "string" || !Array.isArray(snapshot.movements) || snapshot.movements.length === 0) {
    throw new Error("inventory_recipe_consumption_snapshot_required");
  }
  const ingredients = new Set();
  for (const movement of snapshot.movements) {
    if (typeof movement.ingredientId !== "string"
      || ingredients.has(movement.ingredientId)
      || movement.operationKey !== `${operationKey}:${movement.ingredientId}`
      || !/^(?:0|[1-9]\d*)\.\d{6}$/u.test(movement.quantityBase)
      || !/^-?(?:0|[1-9]\d*)\.\d{6}$/u.test(movement.signedQuantityBase)
      || movement.signedQuantityBase !== `-${movement.quantityBase}`) {
      throw new Error("inventory_recipe_consumption_snapshot_invalid");
    }
    ingredients.add(movement.ingredientId);
  }
  return snapshot;
}

function reliabilityBindingHash(input) {
  return hash({
    organizationId: input.organizationId,
    outletId: input.outletId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorReference: input.actorReference,
    operationKey: input.operationKey ?? input.resourceId,
  });
}

function hash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function iso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("occurred_at_invalid");
  return parsed.toISOString();
}

function mapInventoryBalance(row) {
  return {
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    ingredientId: row.ingredient_id,
    quantityBase: String(row.quantity_base),
    inventoryMode: row.inventory_mode,
    version: Number(row.version),
  };
}

async function findOperation(tx, organizationId, outletId, operationKey, requestFingerprint) {
  const fingerprint = requireFingerprint(requestFingerprint);
  const row = (await tx.query("select outlet_id,request_fingerprint,result_snapshot from sagaops.esb_reliability_operations where organization_id=$1 and operation_key=$2", [organizationId, operationKey])).rows[0];
  if (!row) return null;
  if (row.outlet_id !== outletId || row.request_fingerprint !== fingerprint) throw new Error("reliability_operation_collision");
  return row.result_snapshot;
}

async function insertOperation(tx, organizationId, outletId, operationKey, kind, fingerprint, result, occurredAt) {
  await tx.query(
    `insert into sagaops.esb_reliability_operations
      (organization_id,outlet_id,operation_key,operation_kind,request_fingerprint,result_snapshot,created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [organizationId, outletId, operationKey, kind, requireFingerprint(fingerprint), JSON.stringify(result), occurredAt],
  );
}

async function lockCashSession(tx, organizationId, outletId, shiftId, ...statuses) {
  const row = (await tx.query("select status from sagaops.cash_sessions where organization_id=$1 and outlet_id=$2 and id=$3 for update", [organizationId, outletId, shiftId])).rows[0];
  if (!row) throw new Error("shift_not_found");
  if (!statuses.includes(row.status)) throw new Error("shift_state_conflict");
}

export async function consumeAuthorization(tx, input) {
  const bindingHash = reliabilityBindingHash(input);
  const result = await tx.query(
    `update sagaops.esb_reliability_authorizations
        set status='CONSUMED',consumed_at=$1,consumed_operation_key=$2
      where organization_id=$3 and outlet_id=$4 and id=$5 and action=$6
        and resource_type=$7 and resource_id=$8 and actor_reference=$9
        and binding_hash=$10 and status='AVAILABLE' and expires_at>$1
      returning id`,
    [input.occurredAt, input.operationKey, input.organizationId, input.outletId, input.id, input.action, input.resourceType, input.resourceId, input.actorReference, bindingHash],
  );
  if (result.rows.length !== 1) throw new Error("reliability_authorization_consume_failed");
}

async function appendReliabilityAuditAndOutbox(tx, input) {
  await appendAudit(tx, {
    organizationId: input.organizationId,
    outletId: input.outletId,
    actorReference: input.actorReference,
    eventType: input.eventType.toLowerCase(),
    aggregateType: "cash_session",
    aggregateId: input.shiftId,
    correlationId: input.operationKey,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
  await appendOutbox(tx, { organizationId: input.organizationId, outletId: input.outletId, eventType: input.eventType, payload: input.payload, occurredAt: input.occurredAt });
}

async function appendAudit(tx, input) {
  await tx.query(
    `insert into sagaops.pos_audit_events
      (organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,correlation_id,payload_redacted,occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [input.organizationId, input.outletId, input.actorReference ?? null, input.eventType, input.aggregateType, input.aggregateId, input.correlationId, JSON.stringify(input.payload), input.occurredAt],
  );
}

async function appendOutbox(tx, input) {
  const eventId = randomUUID();
  await tx.query(
    `insert into public.sagaops_integration_outbox
      (id,organization_id,outlet_id,event_id,event_type,payload,status,available_at,created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$7)`,
    [randomUUID(), input.organizationId, input.outletId, eventId, input.eventType, JSON.stringify(input.payload), input.occurredAt],
  );
  return eventId;
}

function reservationIngredientCount(payload) {
  return Array.isArray(payload?.updates) ? payload.updates.length : 0;
}

async function loadPrintAttempts(db, printJobId) {
  const rows = (await db.query("select attempt_id,outcome,adapter,attempted_at from sagaops.esb_print_attempts where print_job_id=$1 order by attempted_at,id", [printJobId])).rows;
  return rows.map((row) => ({ attemptId: row.attempt_id, outcome: row.outcome, adapter: row.adapter, attemptedAt: new Date(row.attempted_at).toISOString() }));
}

function mapPrintJob(row, attempts) {
  return {
    logicalJobId: row.logical_job_id,
    organizationId: row.organization_id,
    outletId: row.outlet_id,
    billId: row.bill_id,
    sourceLogicalJobId: row.source_logical_job_id,
    destination: row.destination,
    copyNumber: row.copy_number,
    copyKind: row.copy_kind,
    status: row.status,
    hardwareActivation: row.hardware_activation,
    stationSnapshot: row.station_snapshot,
    templateSnapshot: row.template_snapshot,
    saleSnapshot: row.sale_snapshot,
    contentSnapshot: row.content_snapshot,
    reprintAuthorization: row.reprint_authorization,
    attempts,
    salesMutationAllowed: false,
  };
}
