import { createHash, randomUUID } from "node:crypto";

import { receiptEvidenceObjectKey } from "./receipt-evidence-storage.mjs";

export const STAFF_RECEIVING_CAPABILITIES = Object.freeze([
  "inventory.receipt.capture",
  "inventory.receipt.submit",
  "inventory.receipt.post",
  "inventory.receipt.review",
  "inventory.receipt.cost.write",
  "inventory.receipt.evidence.read",
]);

const CAPABILITY_SET = new Set(STAFF_RECEIVING_CAPABILITIES);
const PHOTO_CATEGORIES = new Set(["DELIVERY_OVERVIEW", "ITEM_CONDITION", "LOT_EXPIRY_LABEL", "DOCUMENT", "DAMAGE", "OTHER"]);
const MUTABLE = new Set(["DRAFT", "NEEDS_CORRECTION"]);
const CONDITION_CODES = new Set(["GOOD", "DAMAGED", "SHORT", "REJECTED"]);
const MAX_CANONICAL_COST_RUPIAH = 1_000_000_000;

export class StaffInventoryReceivingError extends Error {
  constructor(code, { statusCode = 500, detail } = {}) {
    super(code);
    this.name = "StaffInventoryReceivingError";
    this.code = code;
    this.statusCode = statusCode;
    if (detail !== undefined) this.detail = detail;
  }
}

export class StaffInventoryReceivingService {
  constructor({
    db,
    storage,
    resolveBusinessDate,
    resolveLine,
    resolveProcurement,
    authorizeOwner,
    receiptPoster,
    clock = () => new Date(),
    idFactory = randomUUID,
    limits = {},
  } = {}) {
    if (!db?.query || !db?.transaction) throw failure("staff_receiving_database_required");
    if (!storage?.put || !storage?.open || !storage?.delete || !storage?.stat) throw failure("staff_receiving_storage_required");
    if (typeof resolveBusinessDate !== "function" || typeof resolveLine !== "function" || typeof authorizeOwner !== "function") {
      throw failure("staff_receiving_dependency_required");
    }
    if (receiptPoster !== undefined && typeof receiptPoster !== "function") throw failure("staff_receiving_poster_invalid");
    this.db = db;
    this.storage = storage;
    this.resolveBusinessDate = resolveBusinessDate;
    this.resolveLine = resolveLine;
    this.resolveProcurement = typeof resolveProcurement === "function" ? resolveProcurement : async (input) => {
      if (input.supplierId || input.purchaseOrderId || input.additionalFees.length) {
        throw failure("staff_receiving_procurement_integration_unavailable", { statusCode: 503 });
      }
      return { supplierId: null, purchaseOrderId: null, supplierName: input.supplierName, procurementSnapshot: {}, additionalFees: [] };
    };
    this.authorizeOwner = authorizeOwner;
    this.receiptPoster = receiptPoster;
    this.clock = clock;
    this.idFactory = idFactory;
    this.limits = Object.freeze({
      maxReceiptPhotos: bounded(limits.maxReceiptPhotos ?? 20, 1, 50, "staff_receiving_photo_limit_invalid"),
      maxLinePhotos: bounded(limits.maxLinePhotos ?? 5, 1, 20, "staff_receiving_photo_limit_invalid"),
      requiredReceiptPhotos: bounded(limits.requiredReceiptPhotos ?? 1, 0, 20, "staff_receiving_photo_limit_invalid"),
      requiredLinePhotos: bounded(limits.requiredLinePhotos ?? 1, 0, 5, "staff_receiving_photo_limit_invalid"),
      maxEvidenceBytes: bounded(limits.maxEvidenceBytes ?? storage.maxBytes ?? 10 * 1024 * 1024, 1024, 25 * 1024 * 1024, "staff_receiving_photo_limit_invalid"),
      maxPriceVarianceBps: bounded(limits.maxPriceVarianceBps ?? 1000, 0, 50_000, "staff_receiving_price_variance_limit_invalid"),
    });
  }

  async getStaffCapabilities(context = {}) {
    const identity = staffContext(context);
    return this.#withStaffDb(identity, async (tx) => {
      const capabilities = await this.#capabilitySet(identity, tx);
      return { staffId: identity.staffId, capabilities: [...capabilities].sort() };
    });
  }

  async setStaffCapabilities(context = {}, input = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.capability.manage");
    const staffId = uuid(input.staffId, "staff_receiving_staff_invalid");
    const capabilities = uniqueCapabilities(input.capabilities);
    const occurredAt = timestamp(this.clock(), "staff_receiving_clock_invalid");
    return this.db.transaction(async (tx) => {
      const staff = (await tx.query(
         `select id,organization_id,outlet_id,status from sagaops.staff_profiles
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [staffId, owner.organizationId, owner.outletId],
      )).rows[0];
      if (!staff || staff.status !== "active") throw failure("staff_receiving_staff_not_active", { statusCode: 404 });
      await tx.query("delete from sagaops.staff_inventory_capabilities where organization_id=$1 and outlet_id=$2 and staff_id=$3", [owner.organizationId, owner.outletId, staffId]);
      for (const capability of capabilities) {
        await tx.query(
          `insert into sagaops.staff_inventory_capabilities
            (organization_id,outlet_id,staff_id,capability,enabled,granted_by,granted_at)
           values ($1,$2,$3,$4,true,$5,$6)`,
          [owner.organizationId, owner.outletId, staffId, capability, owner.actorReference, occurredAt],
        );
      }
      await this.#event(tx, { ...owner, staffId }, null, "CAPABILITIES_REPLACED", { capabilities }, occurredAt);
      return { staffId, capabilities };
    });
  }

  async listStaffCapabilitiesForOwner(context = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.capability.manage");
    const rows = (await this.db.query(
      `select p.id staff_id,c.capability
         from sagaops.staff_profiles p
          left join sagaops.staff_inventory_capabilities c on c.organization_id=p.organization_id and c.outlet_id=p.outlet_id and c.staff_id=p.id and c.enabled=true
         where p.organization_id=$1 and p.outlet_id=$2 and p.status='active'
         order by p.id,c.capability`,
      [owner.organizationId, owner.outletId],
    )).rows;
    const assignments = [];
    for (const row of rows) {
      let assignment = assignments.at(-1);
      if (!assignment || assignment.staffId !== row.staff_id) {
        assignment = { staffId: row.staff_id, capabilities: [] };
        assignments.push(assignment);
      }
      if (CAPABILITY_SET.has(row.capability)) assignment.capabilities.push(row.capability);
    }
    return { capabilities: [...STAFF_RECEIVING_CAPABILITIES], assignments };
  }

  async listStaffCapabilities(context = {}) {
    return this.listStaffCapabilitiesForOwner(context);
  }

  async createDraft(context = {}, input = {}) {
    const identity = staffContext(context);
    await this.#requireStaffCapability(identity, "inventory.receipt.capture");
    const idempotencyKey = identifier(input.idempotencyKey, 120, "staff_receiving_idempotency_key_invalid");
    const supplierName = optionalText(input.supplierName, 160, "staff_receiving_supplier_invalid");
    const supplierId = optionalText(input.supplierId, 160, "staff_receiving_supplier_id_invalid");
    const purchaseOrderId = optionalText(input.purchaseOrderId, 160, "staff_receiving_purchase_order_invalid");
    const additionalFees = normalizeAdditionalFees(input.additionalFees ?? []);
    rejectUnsupportedCommercialFields(input);
    const documentNumber = optionalText(input.documentNumber, 120, "staff_receiving_document_number_invalid");
    const note = optionalText(input.note, 1000, "staff_receiving_note_invalid");
    if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) throw failure("staff_receiving_lines_invalid", { statusCode: 422 });
    const normalizedInputLines = input.lines.map(normalizeLineInput);
    assertValidIngredientLots(normalizedInputLines);
    const capabilities = await this.#capabilitySet(identity);
    if (input.lines.some((line) => line?.costRupiah !== undefined && line.costRupiah !== null) && !capabilities.has("inventory.receipt.cost.write")) {
      throw failure("staff_receiving_cost_write_denied", { statusCode: 403 });
    }
    const fingerprint = digest({ supplierId, purchaseOrderId, supplierName, documentNumber, note, additionalFees, lines: normalizedInputLines });
    const earlyReplay = await this.#withStaffDb(identity, async (tx) => (await tx.query(
      `select *
         from sagaops.inventory_receipt_drafts
        where organization_id=$1 and actor_staff_id=$2 and idempotency_key=$3`,
      [identity.organizationId, identity.staffId, idempotencyKey],
    )).rows[0]);
    if (earlyReplay) {
      if (earlyReplay.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
      return this.#withStaffDb(identity, async (tx) => ({ ...receiptSummary(earlyReplay), lines: await lineReferences(tx, earlyReplay.id), idempotentReplay: true }));
    }
    const businessDate = date(await this.resolveBusinessDate(identity), "staff_receiving_business_date_invalid");
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const normalizedLines = [];
    for (const inputLine of normalizedInputLines) {
      const normalized = await this.resolveLine({ ...identity, input: inputLine, mayWriteCost: capabilities.has("inventory.receipt.cost.write") });
      normalizedLines.push(withBusinessCostFacts(normalizeResolvedLine(normalized, inputLine), this.limits.maxPriceVarianceBps));
    }
    const procurement = normalizeResolvedProcurement(await this.resolveProcurement({
      ...identity, supplierId, purchaseOrderId, supplierName, businessDate, additionalFees, lines: normalizedLines,
    }));
    const effectiveSupplierName = procurement.supplierName ?? supplierName;
    const effectiveDeliveryIdentity = normalizedDeliveryIdentity(effectiveSupplierName, documentNumber);
    return this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      const replay = (await tx.query(
        `select *
           from sagaops.inventory_receipt_drafts
          where organization_id=$1 and actor_staff_id=$2 and idempotency_key=$3`,
        [identity.organizationId, identity.staffId, idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
        return { ...receiptSummary(replay), lines: await lineReferences(tx, replay.id), idempotentReplay: true };
      }
      const receiptId = this.idFactory();
      const lineReferencesCreated = [];
      const inserted = (await tx.query(
        `insert into sagaops.inventory_receipt_drafts
          (id,organization_id,outlet_id,actor_staff_id,supplier_id,purchase_order_id,supplier_name,document_number,supplier_normalized,document_normalized,procurement_snapshot,additional_fees,note,business_date,server_received_at,status,idempotency_key,command_fingerprint,revision,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,'DRAFT',$16,$17,1,$15,$15)
         on conflict (organization_id,actor_staff_id,idempotency_key) do nothing
         returning id`,
        [receiptId, identity.organizationId, identity.outletId, identity.staffId, procurement.supplierId, procurement.purchaseOrderId,
          effectiveSupplierName, documentNumber, effectiveDeliveryIdentity?.supplier ?? null, effectiveDeliveryIdentity?.document ?? null,
          JSON.stringify(procurement.procurementSnapshot), JSON.stringify(procurement.additionalFees), note, businessDate, now, idempotencyKey, fingerprint],
      )).rows[0];
      if (!inserted) {
        const concurrent = (await tx.query(
          `select *
             from sagaops.inventory_receipt_drafts
            where organization_id=$1 and actor_staff_id=$2 and idempotency_key=$3`,
          [identity.organizationId, identity.staffId, idempotencyKey],
        )).rows[0];
        if (!concurrent || concurrent.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
        return { ...receiptSummary(concurrent), lines: await lineReferences(tx, concurrent.id), idempotentReplay: true };
      }
      let duplicateOfReceiptId = null;
      if (effectiveDeliveryIdentity) {
        const claimed = (await tx.query(
          "select sagaops.claim_staff_receipt_delivery_identity($1,$2,$3,$4,$5,$6,$7) canonical_receipt_id",
          [receiptId, identity.staffId, identity.organizationId, identity.outletId, businessDate, effectiveDeliveryIdentity.supplier, effectiveDeliveryIdentity.document],
        )).rows[0]?.canonical_receipt_id;
        if (claimed && claimed !== receiptId) {
          duplicateOfReceiptId = claimed;
          await tx.query(
            `update sagaops.inventory_receipt_drafts
                set duplicate_of_receipt_id=$2,exception_reasons='["DUPLICATE_DELIVERY"]'::jsonb,updated_at=$3
              where id=$1`,
            [receiptId, claimed, now],
          );
        }
      }
      for (let index = 0; index < normalizedLines.length; index += 1) {
        const line = normalizedLines[index];
        const lineId = this.idFactory();
        await tx.query(
          `insert into sagaops.inventory_receipt_draft_lines
            (id,receipt_id,organization_id,outlet_id,ingredient_id,ingredient_snapshot,purchase_option_snapshot,
             delivered_quantity,accepted_quantity,rejected_quantity,damaged_quantity,normalized_base_quantity,
             lot_code,expiry_date,condition_code,cost_rupiah,cost_source,reference_cost_rupiah,price_variance_bps,
             accepted_cost_rupiah,rejected_cost_rupiah,damaged_cost_rupiah,pending_cost_rupiah,cost_allocation_status,
             exception_reasons,note,client_reference,sort_order,created_at,updated_at)
            values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27,$28,$29,$29)`,
           [lineId, receiptId, identity.organizationId, identity.outletId, line.ingredientId, JSON.stringify(line.ingredientSnapshot), JSON.stringify(line.purchaseOptionSnapshot),
             line.deliveredQuantity, line.acceptedQuantity, line.rejectedQuantity, line.damagedQuantity, line.normalizedBaseQuantity,
             line.lotCode, line.expiryDate, line.conditionCode, line.costRupiah, line.costSource, line.referenceCostRupiah, line.priceVarianceBps,
             line.acceptedCostRupiah, line.rejectedCostRupiah, line.damagedCostRupiah, line.pendingCostRupiah, line.costAllocationStatus,
             JSON.stringify(line.exceptionReasons), line.note, line.clientReference, index, now],
        );
        lineReferencesCreated.push({ lineId, ingredientId: line.ingredientId, clientReference: line.clientReference, sortOrder: index });
      }
      await this.#event(tx, identity, receiptId, "DRAFT_CREATED", { lineCount: normalizedLines.length }, now);
      if (duplicateOfReceiptId) await this.#event(tx, identity, receiptId, "DUPLICATE_DELIVERY_DETECTED", { duplicateOfReceiptId }, now);
      return { receiptId, status: "DRAFT", revision: 1, businessDate, duplicateOfReceiptId, createdAt: now, lines: lineReferencesCreated, idempotentReplay: false };
    });
  }

  async initializeEvidence(context = {}, receiptIdValue, input = {}) {
    const identity = staffContext(context);
    await this.#requireStaffCapability(identity, "inventory.receipt.capture");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const lineId = input.lineId === undefined || input.lineId === null ? null : uuid(input.lineId, "staff_receiving_line_invalid");
    const category = String(input.category ?? "");
    if (!PHOTO_CATEGORIES.has(category)) throw failure("staff_receiving_evidence_category_invalid", { statusCode: 422 });
    const checksum = sha256(input.checksum, "staff_receiving_evidence_checksum_invalid");
    const byteSize = bounded(input.byteSize, 1, this.limits.maxEvidenceBytes, "staff_receiving_evidence_size_invalid");
    const contentType = contentTypeValue(input.contentType);
    const width = bounded(input.width, 1, 20_000, "staff_receiving_evidence_dimension_invalid");
    const height = bounded(input.height, 1, 20_000, "staff_receiving_evidence_dimension_invalid");
    const capturedAt = input.capturedAt == null ? null : timestamp(input.capturedAt, "staff_receiving_evidence_timestamp_invalid");
    const caption = optionalText(input.caption, 300, "staff_receiving_evidence_caption_invalid");
    const sortOrder = bounded(input.sortOrder ?? 0, 0, 1000, "staff_receiving_evidence_sort_invalid");
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    return this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      const receipt = await this.#lockOwnMutableReceipt(tx, identity, receiptId);
      if (lineId) {
        const line = (await tx.query("select id from sagaops.inventory_receipt_draft_lines where id=$1 and receipt_id=$2", [lineId, receiptId])).rows[0];
        if (!line) throw failure("staff_receiving_line_not_found", { statusCode: 404 });
      }
      const counts = (await tx.query(
        `select count(*) filter (where status <> 'SUPERSEDED')::integer total,
                count(*) filter (where receipt_line_id=$2 and status <> 'SUPERSEDED')::integer line_total
           from sagaops.inventory_receipt_evidence where receipt_id=$1`,
        [receiptId, lineId],
      )).rows[0];
      if (Number(counts.total) >= this.limits.maxReceiptPhotos || (lineId && Number(counts.line_total) >= this.limits.maxLinePhotos)) {
        throw failure("staff_receiving_evidence_limit_reached", { statusCode: 422 });
      }
      const existing = (await tx.query(
        `select id,object_key,status,receipt_line_id,category,content_type,byte_size,width,height from sagaops.inventory_receipt_evidence
          where receipt_id=$1 and checksum_sha256=$2 and status <> 'SUPERSEDED'`,
        [receiptId, checksum],
      )).rows[0];
      if (existing) {
        if (existing.receipt_line_id !== lineId || existing.category !== category || existing.content_type !== contentType
          || Number(existing.byte_size) !== byteSize || Number(existing.width) !== width || Number(existing.height) !== height) {
          throw failure("staff_receiving_evidence_duplicate_scope", { statusCode: 409 });
        }
        return { evidenceId: existing.id, objectKey: existing.object_key, status: existing.status, idempotentReplay: true };
      }
      const evidenceId = this.idFactory();
      const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
      const objectKey = receiptEvidenceObjectKey({ ...identity, receiptId, evidenceId, extension });
      await tx.query(
        `insert into sagaops.inventory_receipt_evidence
          (id,receipt_id,receipt_line_id,organization_id,outlet_id,category,object_key,content_type,byte_size,checksum_sha256,width,height,captured_at,actor_staff_id,caption,sort_order,status,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PENDING',$17,$17)`,
        [evidenceId, receiptId, lineId, identity.organizationId, identity.outletId, category, objectKey, contentType, byteSize, checksum, width, height, capturedAt, identity.staffId, caption, sortOrder, now],
      );
      await this.#event(tx, identity, receiptId, "EVIDENCE_INITIALIZED", { evidenceId, lineId, category }, now);
      return { evidenceId, objectKey, status: "PENDING", byteSize, checksum, contentType, receiptRevision: Number(receipt.revision), idempotentReplay: false };
    });
  }

  async updateDraft(context = {}, receiptIdValue, input = {}) {
    const identity = staffContext(context);
    await this.#requireStaffCapability(identity, "inventory.receipt.capture");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const expectedRevision = bounded(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "staff_receiving_revision_invalid");
    const idempotencyKey = identifier(input.idempotencyKey, 120, "staff_receiving_idempotency_key_invalid");
    const capabilities = await this.#capabilitySet(identity);
    if (Array.isArray(input.lines) && input.lines.some((line) => line?.costRupiah !== undefined && line.costRupiah !== null) && !capabilities.has("inventory.receipt.cost.write")) {
      throw failure("staff_receiving_cost_write_denied", { statusCode: 403 });
    }
    let normalizedLineInputs = null;
    if (input.lines !== undefined) {
      if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) throw failure("staff_receiving_lines_invalid", { statusCode: 422 });
      normalizedLineInputs = input.lines.map((inputLine) => ({
        ...normalizeLineInput(inputLine),
        lineId: inputLine?.lineId == null ? null : uuid(inputLine.lineId, "staff_receiving_line_invalid"),
      }));
      assertValidIngredientLots(normalizedLineInputs);
    }
    rejectUnsupportedCommercialFields(input);
    const rawChanges = {
      supplierId: input.supplierId === undefined ? undefined : optionalText(input.supplierId, 160, "staff_receiving_supplier_id_invalid"),
      purchaseOrderId: input.purchaseOrderId === undefined ? undefined : optionalText(input.purchaseOrderId, 160, "staff_receiving_purchase_order_invalid"),
      supplierName: input.supplierName === undefined ? undefined : optionalText(input.supplierName, 160, "staff_receiving_supplier_invalid"),
      documentNumber: input.documentNumber === undefined ? undefined : optionalText(input.documentNumber, 120, "staff_receiving_document_number_invalid"),
      additionalFees: input.additionalFees === undefined ? undefined : normalizeAdditionalFees(input.additionalFees),
      note: input.note === undefined ? undefined : optionalText(input.note, 1000, "staff_receiving_note_invalid"),
      lines: normalizedLineInputs,
    };
    const fingerprint = digest({ expectedRevision, changes: rawChanges });
    const earlyReplay = await this.#withStaffDb(identity, async (tx) => (await tx.query(
      "select command_fingerprint,committed_revision from sagaops.inventory_receipt_operations where receipt_id=$1 and operation_key=$2",
      [receiptId, idempotencyKey],
    )).rows[0]);
    if (earlyReplay) {
      if (earlyReplay.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
      return this.#withStaffDb(identity, async (tx) => ({ receiptId, status: "DRAFT", revision: Number(earlyReplay.committed_revision), lines: await lineReferences(tx, receiptId), idempotentReplay: true }));
    }
    let normalizedLines = null;
    if (normalizedLineInputs) {
      normalizedLines = [];
      for (const inputLine of normalizedLineInputs) {
        const normalized = await this.resolveLine({ ...identity, input: inputLine, mayWriteCost: capabilities.has("inventory.receipt.cost.write") });
        normalizedLines.push({ ...withBusinessCostFacts(normalizeResolvedLine(normalized, inputLine), this.limits.maxPriceVarianceBps), lineId: inputLine.lineId });
      }
    }
    const procurementTouched = normalizedLines !== null || rawChanges.supplierId !== undefined || rawChanges.purchaseOrderId !== undefined
      || rawChanges.supplierName !== undefined || rawChanges.additionalFees !== undefined;
    let procurement = null;
    if (procurementTouched) {
      if (!normalizedLines) throw failure("staff_receiving_procurement_lines_required", { statusCode: 422 });
      const current = await this.#withStaffDb(identity, async (tx) => (await tx.query(
        `select supplier_id,purchase_order_id,supplier_name,business_date,additional_fees
           from sagaops.inventory_receipt_drafts
          where id=$1 and organization_id=$2 and outlet_id=$3 and actor_staff_id=$4`,
        [receiptId, identity.organizationId, identity.outletId, identity.staffId],
      )).rows[0]);
      if (!current) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      procurement = normalizeResolvedProcurement(await this.resolveProcurement({
        ...identity,
        supplierId: rawChanges.supplierId === undefined ? current.supplier_id : rawChanges.supplierId,
        purchaseOrderId: rawChanges.purchaseOrderId === undefined ? current.purchase_order_id : rawChanges.purchaseOrderId,
        supplierName: rawChanges.supplierName === undefined ? current.supplier_name : rawChanges.supplierName,
        businessDate: date(current.business_date),
        additionalFees: rawChanges.additionalFees === undefined ? jsonArray(current.additional_fees) : rawChanges.additionalFees,
        lines: normalizedLines,
      }));
    }
    const changes = {
      supplierName: procurement ? procurement.supplierName : rawChanges.supplierName,
      documentNumber: rawChanges.documentNumber,
      note: rawChanges.note,
      lines: normalizedLines?.map((line) => ({ ...fingerprintLine(line), lineId: line.lineId })),
      procurement,
    };
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    return this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      const receipt = await this.#lockOwnMutableReceipt(tx, identity, receiptId);
      const replay = (await tx.query(
        "select command_fingerprint,committed_revision from sagaops.inventory_receipt_operations where receipt_id=$1 and operation_key=$2",
        [receiptId, idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
        return { receiptId, status: "DRAFT", revision: Number(replay.committed_revision), lines: await lineReferences(tx, receiptId), idempotentReplay: true };
      }
      if (Number(receipt.revision) !== expectedRevision) throw failure("staff_receiving_revision_conflict", { statusCode: 409, detail: Number(receipt.revision) });
      if (normalizedLines) await this.#replaceLines(tx, identity, receiptId, normalizedLines, now);
      const revision = expectedRevision + 1;
      const updated = (await tx.query(
        `update sagaops.inventory_receipt_drafts set
           supplier_id=case when $3::boolean then $4 else supplier_id end,
           purchase_order_id=case when $3::boolean then $5 else purchase_order_id end,
           procurement_snapshot=case when $3::boolean then $6::jsonb else procurement_snapshot end,
           additional_fees=case when $3::boolean then $7::jsonb else additional_fees end,
           supplier_name=case when $8::boolean then $9 else supplier_name end,
           document_number=case when $10::boolean then $11 else document_number end,
           note=case when $12::boolean then $13 else note end,
           status='DRAFT',exception_reasons=case when duplicate_of_receipt_id is null then '[]'::jsonb else '["DUPLICATE_DELIVERY"]'::jsonb end,submit_idempotency_key=null,
           review_idempotency_key=null,review_note=null,reviewed_by=null,reviewed_at=null,submitted_at=null,
           revision=$14,updated_at=$15
         where id=$1 and revision=$2 returning *`,
        [receiptId, expectedRevision, procurement !== null, procurement?.supplierId ?? null, procurement?.purchaseOrderId ?? null,
          JSON.stringify(procurement?.procurementSnapshot ?? {}), JSON.stringify(procurement?.additionalFees ?? []),
          changes.supplierName !== undefined, changes.supplierName ?? null, changes.documentNumber !== undefined, changes.documentNumber ?? null,
          changes.note !== undefined, changes.note ?? null, revision, now],
      )).rows[0];
      if (!updated) throw failure("staff_receiving_revision_conflict", { statusCode: 409 });
      if (procurement !== null || rawChanges.supplierName !== undefined || rawChanges.documentNumber !== undefined) {
        const nextIdentity = normalizedDeliveryIdentity(updated.supplier_name, updated.document_number);
        let claimedReceiptId;
        try {
          claimedReceiptId = (await tx.query(
            "select sagaops.rebind_staff_receipt_delivery_identity($1,$2,$3,$4,$5,$6,$7) canonical_receipt_id",
            [receiptId, identity.staffId, identity.organizationId, identity.outletId, date(updated.business_date), nextIdentity?.supplier ?? null, nextIdentity?.document ?? null],
          )).rows[0]?.canonical_receipt_id;
        } catch (error) {
          if (String(error?.message ?? "").includes("staff_receipt_delivery_identity_has_duplicates")) {
            throw failure("staff_receiving_delivery_identity_change_blocked", { statusCode: 409 });
          }
          throw error;
        }
        const duplicateOfReceiptId = claimedReceiptId && claimedReceiptId !== receiptId ? claimedReceiptId : null;
        await tx.query(
          `update sagaops.inventory_receipt_drafts
              set supplier_normalized=$2,document_normalized=$3,duplicate_of_receipt_id=$4,
                  duplicate_override_reason=null,duplicate_override_by=null,duplicate_override_at=null,
                  exception_reasons=case when $4::uuid is null then '[]'::jsonb else '["DUPLICATE_DELIVERY"]'::jsonb end
            where id=$1`,
          [receiptId, nextIdentity?.supplier ?? null, nextIdentity?.document ?? null, duplicateOfReceiptId],
        );
        if (duplicateOfReceiptId) await this.#event(tx, identity, receiptId, "DUPLICATE_DELIVERY_DETECTED", { duplicateOfReceiptId, duringUpdate: true }, now);
      }
      await tx.query(
        `insert into sagaops.inventory_receipt_operations(receipt_id,operation_key,command_fingerprint,operation_type,committed_revision,created_at)
         values ($1,$2,$3,'UPDATE',$4,$5)`,
        [receiptId, idempotencyKey, fingerprint, revision, now],
      );
      await this.#event(tx, identity, receiptId, "DRAFT_UPDATED", { revision, linesReplaced: normalizedLines !== null }, now);
      return { ...receiptSummary(updated), lines: await lineReferences(tx, receiptId), idempotentReplay: false };
    });
  }

  async uploadEvidence(context = {}, receiptIdValue, evidenceIdValue, upload = {}) {
    const identity = staffContext(context);
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const evidenceId = uuid(evidenceIdValue, "staff_receiving_evidence_invalid");
    const row = await this.#withStaffDb(identity, async (tx) => {
      await this.#requireStaffCapability(identity, "inventory.receipt.capture", tx);
      return (await tx.query(
        `select e.*,r.status receipt_status
           from sagaops.inventory_receipt_evidence e join sagaops.inventory_receipt_drafts r on r.id=e.receipt_id
          where e.id=$1 and e.receipt_id=$2 and e.organization_id=$3 and e.outlet_id=$4 and r.actor_staff_id=$5`,
        [evidenceId, receiptId, identity.organizationId, identity.outletId, identity.staffId],
      )).rows[0];
    });
    if (!row) throw failure("staff_receiving_evidence_not_found", { statusCode: 404 });
    if (!MUTABLE.has(row.receipt_status)) throw failure("staff_receiving_receipt_immutable", { statusCode: 409 });
    if (row.status === "VERIFIED") {
      if (row.checksum_sha256 !== upload.checksum) throw failure("staff_receiving_evidence_already_verified", { statusCode: 409 });
      return evidenceSummary(row, true);
    }
    if (row.status !== "PENDING" && row.status !== "FAILED") throw failure("staff_receiving_evidence_state_invalid", { statusCode: 409 });
    if (String(upload.checksum) !== row.checksum_sha256 || Number(upload.contentLength) !== Number(row.byte_size) || upload.contentType !== row.content_type) {
      throw failure("staff_receiving_evidence_declaration_mismatch", { statusCode: 422 });
    }
    let stored;
    try {
      stored = await this.storage.put({ objectKey: row.object_key, body: upload.body, contentLength: Number(row.byte_size), contentType: row.content_type, expectedChecksum: row.checksum_sha256, width: Number(row.width), height: Number(row.height) });
    } catch (error) {
      const mappedError = mapStorageFailure(error);
      await this.#withStaffDb(identity, (tx) => tx.query(
        `update sagaops.inventory_receipt_evidence set status='FAILED',failure_code=$3,updated_at=$4
          where id=$1 and receipt_id=$2 and status <> 'VERIFIED'`,
        [evidenceId, receiptId, safeFailureCode(mappedError), timestamp(this.clock(), "staff_receiving_clock_invalid")],
      ));
      throw mappedError;
    }
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    try {
      return await this.db.transaction(async (tx) => {
        await this.#setStaffContext(tx, identity);
        await this.#lockOwnMutableReceipt(tx, identity, receiptId);
        const current = (await tx.query(
          "select * from sagaops.inventory_receipt_evidence where id=$1 and receipt_id=$2 for update",
          [evidenceId, receiptId],
        )).rows[0];
        if (current?.status === "VERIFIED") {
          if (current.checksum_sha256 !== stored.checksum || Number(current.byte_size) !== stored.byteSize || current.content_type !== stored.contentType) {
            throw failure("staff_receiving_evidence_already_verified", { statusCode: 409 });
          }
          return evidenceSummary(current, true);
        }
        const updated = (await tx.query(
          `update sagaops.inventory_receipt_evidence
              set status='VERIFIED',uploaded_at=$3,verified_at=$3,failure_code=null,updated_at=$3
            where id=$1 and receipt_id=$2 and checksum_sha256=$4 and byte_size=$5 and content_type=$6 and width=$7 and height=$8 and status in ('PENDING','FAILED')
          returning *`,
          [evidenceId, receiptId, now, stored.checksum, stored.byteSize, stored.contentType, stored.width, stored.height],
        )).rows[0];
        if (!updated) throw failure("staff_receiving_evidence_concurrent_change", { statusCode: 409 });
        await this.#event(tx, identity, receiptId, "EVIDENCE_VERIFIED", { evidenceId, checksum: stored.checksum, byteSize: stored.byteSize }, now);
        return evidenceSummary(updated, false);
      });
    } catch (error) {
      const verified = await this.#withStaffDb(identity, async (tx) => (await tx.query(
        "select status from sagaops.inventory_receipt_evidence where id=$1 and receipt_id=$2",
        [evidenceId, receiptId],
      )).rows[0]?.status === "VERIFIED").catch(() => null);
      if (verified === false && stored?.idempotentReplay !== true) await this.storage.delete({ objectKey: row.object_key }).catch(() => {});
      throw error;
    }
  }

  async deleteEvidence(context = {}, receiptIdValue, evidenceIdValue) {
    const identity = staffContext(context);
    await this.#requireStaffCapability(identity, "inventory.receipt.capture");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const evidenceId = uuid(evidenceIdValue, "staff_receiving_evidence_invalid");
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const result = await this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      await this.#requireStaffCapability(identity, "inventory.receipt.capture", tx);
      await this.#lockOwnMutableReceipt(tx, identity, receiptId);
      let row = (await tx.query(
        `update sagaops.inventory_receipt_evidence set status='SUPERSEDED',updated_at=$3
          where id=$1 and receipt_id=$2 and status <> 'SUPERSEDED' returning object_key,status`,
        [evidenceId, receiptId, now],
      )).rows[0];
      if (!row) {
        row = (await tx.query(
          "select object_key,status from sagaops.inventory_receipt_evidence where id=$1 and receipt_id=$2 and status='SUPERSEDED'",
          [evidenceId, receiptId],
        )).rows[0];
        return { deleted: false, objectKey: row?.object_key ?? null };
      }
      await this.#event(tx, identity, receiptId, "EVIDENCE_SUPERSEDED", { evidenceId }, now);
      return { deleted: true, objectKey: row.object_key };
    });
    if (result.objectKey) await this.storage.delete({ objectKey: result.objectKey });
    return { deleted: result.deleted };
  }

  async submit(context = {}, receiptIdValue, input = {}) {
    const identity = staffContext(context);
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const idempotencyKey = identifier(input.idempotencyKey, 120, "staff_receiving_submit_key_invalid");
    const expectedRevision = bounded(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "staff_receiving_revision_invalid");
    const fingerprint = digest({ expectedRevision });
    const currentBusinessDate = date(await this.resolveBusinessDate(identity), "staff_receiving_business_date_invalid");
    const staged = await this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      await this.#requireStaffCapability(identity, "inventory.receipt.submit", tx);
      const canPost = await this.#hasStaffCapability(identity, "inventory.receipt.post", tx);
      const receipt = await this.#lockOwnReceipt(tx, identity, receiptId);
      const operation = await this.#operationReplay(tx, receiptId, idempotencyKey, "SUBMIT", fingerprint);
      if (operation && ["POSTED", "PENDING_REVIEW", "REJECTED"].includes(receipt.status)) {
        return { done: true, result: { ...receiptSummary(receipt), exceptionReasons: jsonArray(receipt.exception_reasons), postedReceiptId: receipt.posted_receipt_id, idempotentReplay: true } };
      }
      if (!operation && ["POSTED", "PENDING_REVIEW", "REJECTED"].includes(receipt.status)) throw failure("staff_receiving_submit_state_invalid", { statusCode: 409 });
      if (receipt.status !== "POSTING" && (!MUTABLE.has(receipt.status) || Number(receipt.revision) !== expectedRevision)) throw failure("staff_receiving_revision_conflict", { statusCode: 409, detail: Number(receipt.revision) });
      const bundle = await this.#loadBundle(tx, receiptId);
      if (receipt.status === "POSTING") {
        const recoveryError = await this.#returnInvalidPostingToReview(tx, identity, receipt, bundle.lines);
        if (recoveryError) return { done: true, error: recoveryError };
        if (!operation) await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "SUBMIT", Number(receipt.revision), timestamp(this.clock(), "staff_receiving_clock_invalid"));
        const attempted = (await tx.query(
          "update sagaops.inventory_receipt_drafts set posting_last_attempt_at=$2,posting_attempt_count=posting_attempt_count+1,updated_at=$2 where id=$1 returning *",
          [receiptId, timestamp(this.clock(), "staff_receiving_clock_invalid")],
        )).rows[0];
        return { done: false, receipt: attempted, lines: bundle.lines, stagedRevision: Number(receipt.revision), idempotentReplay: true };
      }
      if (bundle.evidence.some((item) => item.status === "PENDING" || item.status === "FAILED")) throw failure("staff_receiving_evidence_incomplete", { statusCode: 409 });
      const exceptions = this.#exceptions(receipt, bundle, currentBusinessDate, canPost);
      const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
      if (exceptions.length > 0) {
        const pending = (await tx.query(
          `update sagaops.inventory_receipt_drafts
              set status='PENDING_REVIEW',submit_idempotency_key=$3,exception_reasons=$4::jsonb,
                  submitted_at=$5,revision=revision+1,updated_at=$5
            where id=$1 and revision=$2 returning *`,
          [receiptId, expectedRevision, idempotencyKey, JSON.stringify(exceptions), now],
        )).rows[0];
        if (!pending) throw failure("staff_receiving_revision_conflict", { statusCode: 409 });
        await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "SUBMIT", Number(pending.revision), now);
        await this.#event(tx, identity, receiptId, "REVIEW_REQUESTED", { exceptionReasons: exceptions }, now);
        return { done: true, result: { ...receiptSummary(pending), exceptionReasons: exceptions, postedReceiptId: null, idempotentReplay: false } };
      }
      ensurePostableCosts(bundle.lines);
      ensureCanonicalDispositionSupported(bundle.lines);
      ensureCanonicalPostingSupported(receipt, bundle.lines);
      const posting = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set status='POSTING',submit_idempotency_key=$3,exception_reasons='[]'::jsonb,
                submitted_at=$4,posting_started_at=$4,posting_last_attempt_at=$4,posting_attempt_count=posting_attempt_count+1,
                revision=revision+1,updated_at=$4
          where id=$1 and revision=$2 returning *`,
        [receiptId, expectedRevision, idempotencyKey, now],
      )).rows[0];
      if (!posting) throw failure("staff_receiving_revision_conflict", { statusCode: 409 });
      await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "SUBMIT", Number(posting.revision), now);
      await this.#event(tx, identity, receiptId, "POSTING_STAGED", { canonicalKey: canonicalPostingKey(receiptId) }, now);
      return { done: false, receipt: posting, lines: bundle.lines, stagedRevision: Number(posting.revision), idempotentReplay: false };
    });
    if (staged.error) throw staged.error;
    if (staged.done) return staged.result;
    return this.#invokeAndFinalizePost({ receiptId, receipt: staged.receipt, lines: staged.lines, actor: identity, identity, idempotentReplay: staged.idempotentReplay });
  }

  async review(context = {}, receiptIdValue, input = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const requestedDecision = String(input.decision ?? "");
    const decision = requestedDecision === "REQUEST_CORRECTION" ? "NEEDS_CORRECTION" : requestedDecision;
    if (!["APPROVE", "REJECT", "NEEDS_CORRECTION"].includes(decision)) throw failure("staff_receiving_review_decision_invalid", { statusCode: 422 });
    const noteInput = input.reason ?? input.note;
    const note = decision === "APPROVE" ? optionalText(noteInput, 1000, "staff_receiving_review_note_invalid") : requiredText(noteInput, 10, 1000, "staff_receiving_review_note_invalid");
    const duplicateOverrideReason = input.duplicateOverrideReason == null ? null : requiredText(input.duplicateOverrideReason, 10, 1000, "staff_receiving_duplicate_override_reason_invalid");
    const expectedRevision = bounded(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "staff_receiving_revision_invalid");
    const idempotencyKey = input.idempotencyKey == null
      ? `review:${receiptId}:${expectedRevision}:${decision}`
      : identifier(input.idempotencyKey, 120, "staff_receiving_review_key_invalid");
    const fingerprint = digest({ expectedRevision, decision, note, duplicateOverrideReason });
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const staged = await this.db.transaction(async (tx) => {
      const receipt = (await tx.query(
        `select * from sagaops.inventory_receipt_drafts where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [receiptId, owner.organizationId, owner.outletId],
      )).rows[0];
      if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      const operation = await this.#operationReplay(tx, receiptId, idempotencyKey, "REVIEW", fingerprint);
      if (operation && ["POSTED", "REJECTED", "NEEDS_CORRECTION"].includes(receipt.status)) {
        return { done: true, result: { ...receiptSummary(receipt), postedReceiptId: receipt.posted_receipt_id, idempotentReplay: true } };
      }
      if (!operation && ["POSTED", "REJECTED", "NEEDS_CORRECTION"].includes(receipt.status)) throw failure("staff_receiving_review_state_invalid", { statusCode: 409 });
      if (receipt.status === "POSTING" && decision === "APPROVE") {
        const bundle = await this.#loadBundle(tx, receiptId);
        const recoveryError = await this.#returnInvalidPostingToReview(tx, { ...owner, staffId: receipt.actor_staff_id }, receipt, bundle.lines);
        if (recoveryError) return { done: true, error: recoveryError };
        if (!operation) await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "REVIEW", Number(receipt.revision), now);
        const attempted = (await tx.query(
          "update sagaops.inventory_receipt_drafts set posting_last_attempt_at=$2,posting_attempt_count=posting_attempt_count+1,updated_at=$2 where id=$1 returning *",
          [receiptId, now],
        )).rows[0];
        return { done: false, receipt: attempted, lines: bundle.lines, actor: { ...owner, staffId: receipt.actor_staff_id }, idempotentReplay: true };
      }
      if (receipt.status !== "PENDING_REVIEW") throw failure("staff_receiving_review_state_invalid", { statusCode: 409 });
      if (Number(receipt.revision) !== expectedRevision) throw failure("staff_receiving_revision_conflict", { statusCode: 409, detail: Number(receipt.revision) });
      if (decision === "APPROVE") {
        if (!receipt.duplicate_of_receipt_id && duplicateOverrideReason) throw failure("staff_receiving_duplicate_override_not_applicable", { statusCode: 422 });
        if (receipt.duplicate_of_receipt_id && !receipt.duplicate_override_at) {
          if (!duplicateOverrideReason) throw failure("staff_receiving_duplicate_override_required", { statusCode: 409 });
          await tx.query(
            `update sagaops.inventory_receipt_drafts
                set duplicate_override_reason=$2,duplicate_override_by=$3,duplicate_override_at=$4,updated_at=$4
              where id=$1`,
            [receiptId, duplicateOverrideReason, owner.actorReference, now],
          );
          receipt.duplicate_override_reason = duplicateOverrideReason;
          receipt.duplicate_override_by = owner.actorReference;
          receipt.duplicate_override_at = now;
          await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, "DUPLICATE_DELIVERY_OVERRIDDEN", { duplicateOfReceiptId: receipt.duplicate_of_receipt_id, reason: duplicateOverrideReason }, now);
        }
        const bundle = await this.#loadBundle(tx, receiptId);
        if (bundle.evidence.some((item) => item.status !== "VERIFIED" && item.status !== "SUPERSEDED")) throw failure("staff_receiving_evidence_incomplete", { statusCode: 409 });
        ensurePostableCosts(bundle.lines);
        ensureCanonicalDispositionSupported(bundle.lines);
        ensureCanonicalPostingSupported(receipt, bundle.lines);
        const posting = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set status='POSTING',review_idempotency_key=$3,review_note=$4,reviewed_by=$5,reviewed_at=$6,
                posting_started_at=$6,posting_last_attempt_at=$6,posting_attempt_count=posting_attempt_count+1,
                revision=revision+1,updated_at=$6
            where id=$1 and organization_id=$2 and revision=$7 returning *`,
          [receiptId, owner.organizationId, idempotencyKey, note, owner.actorReference, now, expectedRevision],
        )).rows[0];
        if (!posting) throw failure("staff_receiving_revision_conflict", { statusCode: 409 });
        await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "REVIEW", Number(posting.revision), now);
        await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, "POSTING_STAGED", { canonicalKey: canonicalPostingKey(receiptId), reviewDecision: decision }, now);
        return { done: false, receipt: posting, lines: bundle.lines, actor: { ...owner, staffId: receipt.actor_staff_id }, idempotentReplay: false };
      }
      const updated = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set status=$3,review_idempotency_key=$4,review_note=$5,reviewed_by=$6,reviewed_at=$7,
                posted_receipt_id=$8,posted_at=case when $3='POSTED' then $7 else posted_at end,revision=revision+1,updated_at=$7
          where id=$1 and organization_id=$2 and revision=$9 returning *`,
        [receiptId, owner.organizationId, decision, idempotencyKey, note, owner.actorReference, now, null, expectedRevision],
      )).rows[0];
      if (!updated) throw failure("staff_receiving_revision_conflict", { statusCode: 409 });
      await this.#recordOperation(tx, receiptId, idempotencyKey, fingerprint, "REVIEW", Number(updated.revision), now);
      await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, `REVIEW_${decision}`, { note }, now);
      return { done: true, result: { ...receiptSummary(updated), postedReceiptId: null, idempotentReplay: false } };
    });
    if (staged.error) throw staged.error;
    if (staged.done) return staged.result;
    return this.#invokeAndFinalizePost({ receiptId, receipt: staged.receipt, lines: staged.lines, actor: staged.actor, owner, idempotentReplay: staged.idempotentReplay });
  }

  async listPostingRecovery(context = {}, { staleBefore, limit = 50 } = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const cutoff = timestamp(staleBefore, "staff_receiving_recovery_cutoff_invalid");
    const rowLimit = bounded(limit, 1, 200, "staff_receiving_list_limit_invalid");
    const rows = (await this.db.query(
      `select id,status,revision,business_date,created_at,posting_started_at,posting_last_attempt_at,
              posting_attempt_count,posting_claimed_at,posted_receipt_id
         from sagaops.inventory_receipt_drafts
        where organization_id=$1 and outlet_id=$2 and status='POSTING'
          and coalesce(posting_last_attempt_at,posting_started_at,updated_at) < $3
        order by coalesce(posting_last_attempt_at,posting_started_at,updated_at),id limit $4`,
      [owner.organizationId, owner.outletId, cutoff, rowLimit],
    )).rows;
    return rows.map(postingRecoveryView);
  }

  async claimPostingRecovery(context = {}, receiptIdValue, input = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const claimToken = identifier(input.claimToken, 160, "staff_receiving_recovery_claim_invalid");
    const claimHash = digest({ claimToken });
    const staleBefore = timestamp(input.staleBefore, "staff_receiving_recovery_cutoff_invalid");
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    if (new Date(staleBefore).getTime() > new Date(now).getTime()) throw failure("staff_receiving_recovery_cutoff_invalid", { statusCode: 422 });
    return this.db.transaction(async (tx) => {
      const receipt = (await tx.query(
        `select * from sagaops.inventory_receipt_drafts
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [receiptId, owner.organizationId, owner.outletId],
      )).rows[0];
      if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      if (receipt.status !== "POSTING") throw failure("staff_receiving_recovery_state_invalid", { statusCode: 409 });
      if (receipt.posting_claim_token_hash === claimHash) return { ...postingRecoveryView(receipt), idempotentReplay: true };
      if (receipt.posting_claimed_at && timestamp(receipt.posting_claimed_at) >= staleBefore) throw failure("staff_receiving_recovery_already_claimed", { statusCode: 409 });
      const claimed = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set posting_claim_token_hash=$2,posting_claimed_at=$3,updated_at=$3
          where id=$1 and status='POSTING' returning *`,
        [receiptId, claimHash, now],
      )).rows[0];
      await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, "POSTING_RECOVERY_CLAIMED", { attemptCount: Number(receipt.posting_attempt_count ?? 0) }, now);
      return { ...postingRecoveryView(claimed), idempotentReplay: false };
    });
  }

  async retryClaimedPosting(context = {}, receiptIdValue, input = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const claimToken = identifier(input.claimToken, 160, "staff_receiving_recovery_claim_invalid");
    const claimHash = digest({ claimToken });
    const staged = await this.db.transaction(async (tx) => {
      const receipt = (await tx.query(
        `select * from sagaops.inventory_receipt_drafts
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [receiptId, owner.organizationId, owner.outletId],
      )).rows[0];
      if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      if (receipt.status !== "POSTING" || receipt.posting_claim_token_hash !== claimHash) throw failure("staff_receiving_recovery_claim_invalid", { statusCode: 409 });
      const bundle = await this.#loadBundle(tx, receiptId);
      const recoveryError = await this.#returnInvalidPostingToReview(tx, { ...owner, staffId: receipt.actor_staff_id }, receipt, bundle.lines);
      if (recoveryError) return { error: recoveryError };
      const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
      const attempted = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set posting_last_attempt_at=$2,posting_attempt_count=posting_attempt_count+1,updated_at=$2
          where id=$1 returning *`,
        [receiptId, now],
      )).rows[0];
      await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, "POSTING_RECOVERY_ATTEMPTED", { attemptCount: Number(attempted.posting_attempt_count) }, now);
      return { receipt: attempted, lines: bundle.lines, actor: { ...owner, staffId: receipt.actor_staff_id } };
    });
    if (staged.error) throw staged.error;
    return this.#invokeAndFinalizePost({ receiptId, receipt: staged.receipt, lines: staged.lines, actor: staged.actor, owner, idempotentReplay: true });
  }

  async requestPostedCorrection(context = {}, receiptIdValue, input = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const requestKey = identifier(input.idempotencyKey, 120, "staff_receiving_correction_key_invalid");
    const reason = requiredText(input.reason, 10, 1000, "staff_receiving_correction_reason_invalid");
    const fingerprint = digest({ reason });
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    return this.db.transaction(async (tx) => {
      const receipt = (await tx.query(
        `select * from sagaops.inventory_receipt_drafts
          where id=$1 and organization_id=$2 and outlet_id=$3 for update`,
        [receiptId, owner.organizationId, owner.outletId],
      )).rows[0];
      if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      if (receipt.status !== "POSTED") throw failure("staff_receiving_correction_state_invalid", { statusCode: 409 });
      const existing = (await tx.query(
        "select * from sagaops.inventory_receipt_correction_requests where receipt_id=$1 and request_key=$2",
        [receiptId, requestKey],
      )).rows[0];
      if (existing) {
        if (existing.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
        return { correctionRequestId: existing.id, receiptId, status: existing.status, idempotentReplay: true };
      }
      const correctionRequestId = this.idFactory();
      await tx.query(
        `insert into sagaops.inventory_receipt_correction_requests
          (id,organization_id,outlet_id,receipt_id,request_key,command_fingerprint,reason,requested_by,status,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'BLOCKED_CANONICAL_UNSUPPORTED',$9)`,
        [correctionRequestId, owner.organizationId, owner.outletId, receiptId, requestKey, fingerprint, reason, owner.actorReference, now],
      );
      await this.#event(tx, { ...owner, staffId: receipt.actor_staff_id }, receiptId, "POSTED_CORRECTION_BLOCKED", { correctionRequestId, boundary: "CANONICAL_RECEIPT_REVERSAL_UNAVAILABLE" }, now);
      return { correctionRequestId, receiptId, status: "BLOCKED_CANONICAL_UNSUPPORTED", idempotentReplay: false };
    });
  }

  async #invokeAndFinalizePost({ receiptId, receipt, lines, actor, identity, owner, idempotentReplay }) {
    if (!this.receiptPoster) throw failure("staff_receiving_canonical_poster_unavailable", { statusCode: 503 });
    const command = postingCommand(receipt, lines, actor);
    let posted;
    try {
      posted = await this.receiptPoster({ command, actor });
    } catch (error) {
      if (deterministicCanonicalFailure(error)) {
        await this.#returnCanonicalFailureToReview({ receiptId, receipt, actor, identity, owner, error });
      }
      throw error;
    }
    const postedReceiptId = identifier(posted?.receiptId, 160, "staff_receiving_post_result_invalid");
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const finalize = async (tx) => {
      if (identity) await this.#setStaffContext(tx, identity);
      const params = identity
        ? [receiptId, identity.organizationId, identity.outletId, identity.staffId]
        : [receiptId, owner.organizationId, owner.outletId];
      const where = identity
        ? "id=$1 and organization_id=$2 and outlet_id=$3 and actor_staff_id=$4"
        : "id=$1 and organization_id=$2 and outlet_id=$3";
      const current = (await tx.query(`select * from sagaops.inventory_receipt_drafts where ${where} for update`, params)).rows[0];
      if (!current) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      if (current.status === "POSTED") {
        if (current.posted_receipt_id !== postedReceiptId) throw failure("staff_receiving_post_result_collision", { statusCode: 409 });
        return { ...receiptSummary(current), postedReceiptId, idempotentReplay: true };
      }
      if (current.status !== "POSTING") throw failure("staff_receiving_post_finalize_state_invalid", { statusCode: 409 });
      const updated = (await tx.query(
        `update sagaops.inventory_receipt_drafts
            set status='POSTED',posted_receipt_id=$2,posted_at=$3,posting_claim_token_hash=null,posting_claimed_at=null,revision=revision+1,updated_at=$3
          where id=$1 and status='POSTING' returning *`,
        [receiptId, postedReceiptId, now],
      )).rows[0];
      if (!updated) throw failure("staff_receiving_post_finalize_conflict", { statusCode: 409 });
      await this.#event(tx, { ...actor, staffId: receipt.actor_staff_id }, receiptId, "RECEIPT_POSTED", { postedReceiptId, canonicalKey: command.idempotencyKey }, now);
      return { ...receiptSummary(updated), exceptionReasons: jsonArray(updated.exception_reasons), postedReceiptId, idempotentReplay };
    };
    return this.db.transaction(finalize);
  }

  async #returnCanonicalFailureToReview({ receiptId, receipt, actor, identity, owner, error }) {
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const reason = canonicalFailureReason(error);
    await this.db.transaction(async (tx) => {
      if (identity) await this.#setStaffContext(tx, identity);
      const params = identity
        ? [receiptId, identity.organizationId, identity.outletId, identity.staffId]
        : [receiptId, owner.organizationId, owner.outletId];
      const where = identity
        ? "id=$1 and organization_id=$2 and outlet_id=$3 and actor_staff_id=$4"
        : "id=$1 and organization_id=$2 and outlet_id=$3";
      const current = (await tx.query(`select * from sagaops.inventory_receipt_drafts where ${where} for update`, params)).rows[0];
      if (!current || current.status !== "POSTING") return;
      const reasons = [...new Set([...jsonArray(current.exception_reasons), reason])].sort();
      await tx.query(
        `update sagaops.inventory_receipt_drafts
            set status='PENDING_REVIEW',exception_reasons=$2::jsonb,posting_claim_token_hash=null,posting_claimed_at=null,revision=revision+1,updated_at=$3
          where id=$1 and status='POSTING'`,
        [receiptId, JSON.stringify(reasons), now],
      );
      await this.#event(tx, { ...actor, staffId: receipt.actor_staff_id }, receiptId, "CANONICAL_POST_REJECTED", { reason, canonicalCode: String(error?.code ?? "unknown") }, now);
    });
  }

  async #returnInvalidPostingToReview(tx, context, receipt, lines) {
    const blocker = canonicalPostingBlocker(receipt, lines);
    if (!blocker) return null;
    const reasons = [...new Set([...jsonArray(receipt.exception_reasons), blocker.reason])].sort();
    const now = timestamp(this.clock(), "staff_receiving_clock_invalid");
    const updated = (await tx.query(
      `update sagaops.inventory_receipt_drafts
          set status='PENDING_REVIEW',exception_reasons=$2::jsonb,posting_claim_token_hash=null,posting_claimed_at=null,revision=revision+1,updated_at=$3
        where id=$1 and status='POSTING' returning id`,
      [receipt.id, JSON.stringify(reasons), now],
    )).rows[0];
    if (!updated) throw failure("staff_receiving_post_recovery_conflict", { statusCode: 409 });
    await this.#event(tx, context, receipt.id, "POSTING_RETURNED_TO_REVIEW", { exceptionReasons: reasons }, now);
    return failure(blocker.code, { statusCode: 409, detail: blocker.lineId });
  }

  async listMine(context = {}, { limit = 50, before } = {}) {
    const identity = staffContext(context);
    return this.#withStaffDb(identity, async (tx) => {
      await this.#requireStaffCapability(identity, "inventory.receipt.capture", tx);
      return this.#list(tx, identity, { staffId: identity.staffId, limit, before });
    });
  }

  async getReceipt(context = {}, receiptIdValue) {
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    if (!context.staffId) return this.getForOwner(context, receiptId);
    const identity = staffContext(context);
    return this.#withStaffDb(identity, async (tx) => {
      await this.#requireStaffCapability(identity, "inventory.receipt.capture", tx);
      const canReadEvidence = await this.#hasStaffCapability(identity, "inventory.receipt.evidence.read", tx);
      const receipt = (await tx.query(
        "select * from sagaops.inventory_receipt_drafts where id=$1 and organization_id=$2 and outlet_id=$3 and actor_staff_id=$4",
        [receiptId, identity.organizationId, identity.outletId, identity.staffId],
      )).rows[0];
      if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
      return this.#detail(tx, receipt, { staff: true, canReadEvidence });
    });
  }

  async listForOwner(context = {}, { limit = 100, before, status } = {}) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    const receipts = await this.#list(this.db, owner, { limit, before, status });
    const summary = receipts.reduce((value, receipt) => {
      value.total += 1;
      value.lineCount += receipt.lineCount;
      value.verifiedPhotoCount += receipt.verifiedPhotoCount;
      if (receipt.status === "PENDING_REVIEW") value.pendingReview += 1;
      if (receipt.status === "POSTING") value.posting += 1;
      if (receipt.status === "POSTED") value.posted += 1;
      if (receipt.status === "REJECTED") value.rejected += 1;
      return value;
    }, { total: 0, pendingReview: 0, posting: 0, posted: 0, rejected: 0, lineCount: 0, verifiedPhotoCount: 0 });
    return { summary, receipts };
  }

  async getForOwner(context = {}, receiptIdValue) {
    const owner = ownerContext(context);
    await this.#authorizeOwner(owner, "inventory.receipt.review");
    await this.#authorizeOwner(owner, "inventory.receipt.evidence.read");
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const receipt = (await this.db.query(
      "select * from sagaops.inventory_receipt_drafts where id=$1 and organization_id=$2 and outlet_id=$3",
      [receiptId, owner.organizationId, owner.outletId],
    )).rows[0];
    if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
    return this.#detail(this.db, receipt, { staff: false, canReadEvidence: true });
  }

  async #detail(db, receipt, { staff, canReadEvidence }) {
    const receiptId = receipt.id;
    const bundle = await this.#loadBundle(db, receiptId);
    const events = (await db.query(
      "select event_type,actor_reference,actor_staff_id,payload_redacted,occurred_at from sagaops.inventory_receipt_events where receipt_id=$1 order by occurred_at,id",
      [receiptId],
    )).rows;
    return {
      receipt: { ...receiptSummary(receipt), supplierId: receipt.supplier_id ?? null, purchaseOrderId: receipt.purchase_order_id ?? null, supplierName: receipt.supplier_name, procurement: jsonObject(receipt.procurement_snapshot), additionalFees: jsonArray(receipt.additional_fees), documentNumber: receipt.document_number, note: receipt.note, actorStaffId: receipt.actor_staff_id, exceptionReasons: jsonArray(receipt.exception_reasons), duplicateOfReceiptId: receipt.duplicate_of_receipt_id, duplicateOverrideReason: receipt.duplicate_override_reason, duplicateOverrideBy: receipt.duplicate_override_by, duplicateOverrideAt: receipt.duplicate_override_at == null ? null : timestamp(receipt.duplicate_override_at), reviewNote: receipt.review_note, postedReceiptId: receipt.posted_receipt_id, submittedAt: receipt.submitted_at == null ? null : timestamp(receipt.submitted_at), reviewedAt: receipt.reviewed_at == null ? null : timestamp(receipt.reviewed_at), postedAt: receipt.posted_at == null ? null : timestamp(receipt.posted_at), postingRecovery: receipt.status === "POSTING" ? postingRecoveryView(receipt) : null },
      lines: bundle.lines.map(lineView),
      evidence: bundle.evidence.map((item) => evidenceView(item, { staff, canReadEvidence })),
      events: events.map((event) => ({ eventType: event.event_type, actorReference: event.actor_reference, actorStaffId: event.actor_staff_id, payload: jsonObject(event.payload_redacted), occurredAt: timestamp(event.occurred_at) })),
      operatorCapabilities: ["inventory.receipt.review", "inventory.receipt.evidence.read"],
    };
  }

  async openEvidence(context = {}, receiptIdValue, evidenceIdValue) {
    const receiptId = uuid(receiptIdValue, "staff_receiving_receipt_invalid");
    const evidenceId = uuid(evidenceIdValue, "staff_receiving_evidence_invalid");
    let scope;
    let row;
    if (context.staffId) {
      scope = staffContext(context);
      row = await this.#withStaffDb(scope, async (tx) => {
        await this.#requireStaffCapability(scope, "inventory.receipt.evidence.read", tx);
        return this.#findEvidenceForOpen(tx, scope, receiptId, evidenceId);
      });
    } else {
      scope = ownerContext(context);
      await this.#authorizeOwner(scope, "inventory.receipt.evidence.read");
      row = await this.#findEvidenceForOpen(this.db, scope, receiptId, evidenceId);
    }
    if (!row || row.status !== "VERIFIED") throw failure("staff_receiving_evidence_not_found", { statusCode: 404 });
    const stream = await this.storage.open({ objectKey: row.object_key });
    return { stream, contentType: row.content_type, byteSize: Number(row.byte_size), checksum: row.checksum_sha256 };
  }

  async #findEvidenceForOpen(db, scope, receiptId, evidenceId) {
    const params = [evidenceId, receiptId, scope.organizationId, scope.outletId];
    let sql = `select e.object_key,e.content_type,e.byte_size,e.checksum_sha256,e.status,r.actor_staff_id
      from sagaops.inventory_receipt_evidence e join sagaops.inventory_receipt_drafts r on r.id=e.receipt_id
     where e.id=$1 and e.receipt_id=$2 and e.organization_id=$3 and e.outlet_id=$4`;
    if (scope.staffId) { sql += " and r.actor_staff_id=$5"; params.push(scope.staffId); }
    return (await db.query(sql, params)).rows[0];
  }

  async #list(db, scope, { staffId, limit, before, status } = {}) {
    const boundedLimit = bounded(limit, 1, 200, "staff_receiving_list_limit_invalid");
    const values = [scope.organizationId, scope.outletId];
    const clauses = ["r.organization_id=$1", "r.outlet_id=$2"];
    if (staffId) { values.push(staffId); clauses.push(`r.actor_staff_id=$${values.length}`); }
    if (status) { values.push(statusValue(status)); clauses.push(`r.status=$${values.length}`); }
    if (before) { values.push(timestamp(before, "staff_receiving_cursor_invalid")); clauses.push(`r.created_at < $${values.length}`); }
    values.push(boundedLimit);
    const rows = (await db.query(
      `select r.*,count(distinct l.id)::integer line_count,
              count(distinct e.id) filter (where e.status='VERIFIED')::integer verified_photo_count
         from sagaops.inventory_receipt_drafts r
         left join sagaops.inventory_receipt_draft_lines l on l.receipt_id=r.id
         left join sagaops.inventory_receipt_evidence e on e.receipt_id=r.id
        where ${clauses.join(" and ")}
        group by r.id order by r.created_at desc limit $${values.length}`,
      values,
    )).rows;
    return rows.map((row) => ({ ...receiptSummary(row), supplierId: row.supplier_id ?? null, purchaseOrderId: row.purchase_order_id ?? null, supplierName: row.supplier_name, documentNumber: row.document_number, actorStaffId: row.actor_staff_id, lineCount: Number(row.line_count), verifiedPhotoCount: Number(row.verified_photo_count), exceptionReasons: jsonArray(row.exception_reasons), postedReceiptId: row.posted_receipt_id, submittedAt: row.submitted_at == null ? null : timestamp(row.submitted_at) }));
  }

  async #replaceLines(tx, identity, receiptId, lines, now) {
    const existing = (await tx.query("select id from sagaops.inventory_receipt_draft_lines where receipt_id=$1", [receiptId])).rows.map((row) => row.id);
    const existingSet = new Set(existing);
    const incomingIds = new Set(lines.filter((line) => line.lineId).map((line) => line.lineId));
    if (incomingIds.size !== lines.filter((line) => line.lineId).length || [...incomingIds].some((id) => !existingSet.has(id))) {
      throw failure("staff_receiving_line_not_found", { statusCode: 404 });
    }
    const removed = existing.filter((id) => !incomingIds.has(id));
    if (removed.length) {
      const linked = Number((await tx.query(
        "select count(*)::integer count from sagaops.inventory_receipt_evidence where receipt_line_id=any($1::uuid[]) and status <> 'SUPERSEDED'",
        [removed],
      )).rows[0].count);
      if (linked > 0) throw failure("staff_receiving_line_has_evidence", { statusCode: 409 });
      await tx.query("delete from sagaops.inventory_receipt_draft_lines where receipt_id=$1 and id=any($2::uuid[])", [receiptId, removed]);
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.lineId) {
        await tx.query(
           `update sagaops.inventory_receipt_draft_lines set
              ingredient_id=$3,ingredient_snapshot=$4::jsonb,purchase_option_snapshot=$5::jsonb,
              delivered_quantity=$6,accepted_quantity=$7,rejected_quantity=$8,damaged_quantity=$9,normalized_base_quantity=$10,
              lot_code=$11,expiry_date=$12,condition_code=$13,cost_rupiah=$14,cost_source=$15,
              reference_cost_rupiah=$16,price_variance_bps=$17,accepted_cost_rupiah=$18,rejected_cost_rupiah=$19,
              damaged_cost_rupiah=$20,pending_cost_rupiah=$21,cost_allocation_status=$22,
              exception_reasons=$23::jsonb,note=$24,client_reference=$25,sort_order=$26,updated_at=$27
            where id=$1 and receipt_id=$2`,
          lineSqlParams(line.lineId, receiptId, line, index, now),
        );
      } else {
        const lineId = this.idFactory();
        await tx.query(
           `insert into sagaops.inventory_receipt_draft_lines
             (id,receipt_id,organization_id,outlet_id,ingredient_id,ingredient_snapshot,purchase_option_snapshot,delivered_quantity,accepted_quantity,rejected_quantity,damaged_quantity,normalized_base_quantity,lot_code,expiry_date,condition_code,cost_rupiah,cost_source,reference_cost_rupiah,price_variance_bps,accepted_cost_rupiah,rejected_cost_rupiah,damaged_cost_rupiah,pending_cost_rupiah,cost_allocation_status,exception_reasons,note,client_reference,sort_order,created_at,updated_at)
            values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26,$27,$28,$29,$29)`,
          [lineId, receiptId, identity.organizationId, identity.outletId, line.ingredientId, JSON.stringify(line.ingredientSnapshot), JSON.stringify(line.purchaseOptionSnapshot), line.deliveredQuantity, line.acceptedQuantity, line.rejectedQuantity, line.damagedQuantity, line.normalizedBaseQuantity, line.lotCode, line.expiryDate, line.conditionCode, line.costRupiah, line.costSource, line.referenceCostRupiah, line.priceVarianceBps, line.acceptedCostRupiah, line.rejectedCostRupiah, line.damagedCostRupiah, line.pendingCostRupiah, line.costAllocationStatus, JSON.stringify(line.exceptionReasons), line.note, line.clientReference, index, now],
        );
      }
    }
  }

  #exceptions(receipt, bundle, currentBusinessDate, canPost) {
    const reasons = new Set();
    for (const reason of jsonArray(receipt.exception_reasons)) {
      if (reason !== "DUPLICATE_DELIVERY" || !receipt.duplicate_override_at) reasons.add(reason);
    }
    if (receipt.duplicate_of_receipt_id && !receipt.duplicate_override_at) reasons.add("DUPLICATE_DELIVERY");
    if (date(receipt.business_date) !== currentBusinessDate) reasons.add("NOT_SAME_BUSINESS_DAY");
    if (!receipt.supplier_name) reasons.add("SUPPLIER_REQUIRED");
    if (!canPost) reasons.add("STAFF_POST_NOT_ALLOWED");
    for (const line of bundle.lines) {
      for (const reason of jsonArray(line.exception_reasons)) reasons.add(reason);
      if (Number(line.accepted_quantity) <= 0) reasons.add("ACCEPTED_QUANTITY_REQUIRED");
      if (Number(line.rejected_quantity) > 0) reasons.add("REJECTED_QUANTITY");
      if (Number(line.damaged_quantity) > 0) reasons.add("DAMAGED_QUANTITY");
      if (line.condition_code === "SHORT") reasons.add("QUANTITY_SHORT");
      if (line.cost_rupiah == null) reasons.add("COST_REQUIRES_REVIEW");
      const lineEvidence = bundle.evidence.filter((item) => item.receipt_line_id === line.id && item.status === "VERIFIED");
      if (lineEvidence.length < this.limits.requiredLinePhotos) reasons.add("LINE_EVIDENCE_REQUIRED");
      if ((line.lot_code || line.expiry_date) && !lineEvidence.some((item) => item.category === "LOT_EXPIRY_LABEL")) reasons.add("LOT_EXPIRY_EVIDENCE_REQUIRED");
    }
    const receiptEvidence = bundle.evidence.filter((item) => item.receipt_line_id == null && item.status === "VERIFIED");
    if (receiptEvidence.length < this.limits.requiredReceiptPhotos) reasons.add("RECEIPT_EVIDENCE_REQUIRED");
    const canonicalBlocker = canonicalPostingBlocker(receipt, bundle.lines);
    if (canonicalBlocker) reasons.add(canonicalBlocker.reason);
    return [...reasons].sort();
  }

  async #loadBundle(db, receiptId) {
    const [lines, evidence] = await Promise.all([
      db.query("select * from sagaops.inventory_receipt_draft_lines where receipt_id=$1 order by sort_order,id", [receiptId]),
      db.query("select * from sagaops.inventory_receipt_evidence where receipt_id=$1 and status <> 'SUPERSEDED' order by sort_order,id", [receiptId]),
    ]);
    if (!lines.rows.length) throw failure("staff_receiving_lines_missing", { statusCode: 409 });
    return { lines: lines.rows, evidence: evidence.rows };
  }

  async #lockOwnMutableReceipt(tx, identity, receiptId) {
    const receipt = await this.#lockOwnReceipt(tx, identity, receiptId);
    if (!MUTABLE.has(receipt.status)) throw failure("staff_receiving_receipt_immutable", { statusCode: 409 });
    return receipt;
  }

  async #lockOwnReceipt(tx, identity, receiptId) {
    const receipt = (await tx.query(
      `select * from sagaops.inventory_receipt_drafts
        where id=$1 and organization_id=$2 and outlet_id=$3 and actor_staff_id=$4 for update`,
      [receiptId, identity.organizationId, identity.outletId, identity.staffId],
    )).rows[0];
    if (!receipt) throw failure("staff_receiving_receipt_not_found", { statusCode: 404 });
    return receipt;
  }

  async #capabilitySet(identity, db) {
    if (!db) return this.#withStaffDb(identity, (tx) => this.#capabilitySet(identity, tx));
    const rows = (await db.query(
      `select capability from sagaops.staff_inventory_capabilities
        where organization_id=$1 and outlet_id=$2 and staff_id=$3 and enabled=true`,
      [identity.organizationId, identity.outletId, identity.staffId],
    )).rows;
    return new Set(rows.map((row) => row.capability).filter((value) => CAPABILITY_SET.has(value)));
  }

  async #operationReplay(db, receiptId, operationKey, operationType, fingerprint) {
    const row = (await db.query(
      `select command_fingerprint,operation_type,committed_revision
         from sagaops.inventory_receipt_operations where receipt_id=$1 and operation_key=$2`,
      [receiptId, operationKey],
    )).rows[0];
    if (!row) return null;
    if (row.operation_type !== operationType || row.command_fingerprint !== fingerprint) throw failure("staff_receiving_idempotency_collision", { statusCode: 409 });
    return row;
  }

  async #recordOperation(db, receiptId, operationKey, fingerprint, operationType, committedRevision, createdAt) {
    await db.query(
      `insert into sagaops.inventory_receipt_operations
        (receipt_id,operation_key,command_fingerprint,operation_type,committed_revision,created_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [receiptId, operationKey, fingerprint, operationType, committedRevision, createdAt],
    );
  }

  async #hasStaffCapability(identity, capability, db) {
    return (await this.#capabilitySet(identity, db)).has(capability);
  }

  async #requireStaffCapability(identity, capability, db) {
    if (!(await this.#hasStaffCapability(identity, capability, db))) throw failure("staff_receiving_capability_denied", { statusCode: 403, detail: capability });
  }

  async #setStaffContext(tx, identity) {
    await tx.query(
      "select set_config('app.current_user_id','',true),set_config('app.native_staff_id',$1,true)",
      [identity.staffId],
    );
  }

  async #withStaffDb(identity, callback) {
    return this.db.transaction(async (tx) => {
      await this.#setStaffContext(tx, identity);
      return callback(tx);
    });
  }

  async #authorizeOwner(owner, capability) {
    if (await this.authorizeOwner({ ...owner, capability }) !== true) throw failure("staff_receiving_owner_denied", { statusCode: 403 });
  }

  async #event(tx, context, receiptId, eventType, payload, occurredAt) {
    await tx.query(
      `insert into sagaops.inventory_receipt_events
        (id,organization_id,outlet_id,receipt_id,actor_reference,actor_staff_id,event_type,payload_redacted,occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [this.idFactory(), context.organizationId, context.outletId ?? null, receiptId, context.actorReference, context.staffId ?? null, eventType, JSON.stringify(payload), occurredAt],
    );
  }
}

function normalizeLineInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("staff_receiving_line_invalid", { statusCode: 422 });
  const deliveredQuantity = quantity(value.deliveredQuantity, "staff_receiving_quantity_invalid");
  const acceptedQuantity = quantity(value.acceptedQuantity ?? deliveredQuantity, "staff_receiving_quantity_invalid", true);
  const rejectedQuantity = quantity(value.rejectedQuantity ?? 0, "staff_receiving_quantity_invalid", true);
  const damagedQuantity = quantity(value.damagedQuantity ?? 0, "staff_receiving_quantity_invalid", true);
  const classifiedQuantity = roundQuantity(acceptedQuantity + rejectedQuantity + damagedQuantity);
  if (classifiedQuantity > deliveredQuantity) throw failure("staff_receiving_quantity_balance_invalid", { statusCode: 422 });
  const conditionCode = identifier(value.conditionCode ?? "GOOD", 32, "staff_receiving_condition_invalid");
  if (!CONDITION_CODES.has(conditionCode)
    || (conditionCode === "GOOD" && (rejectedQuantity > 0 || damagedQuantity > 0 || classifiedQuantity !== deliveredQuantity))
    || (conditionCode === "DAMAGED" && damagedQuantity <= 0)
    || (conditionCode === "REJECTED" && rejectedQuantity <= 0)
    || (conditionCode === "SHORT" && classifiedQuantity >= deliveredQuantity)) {
    throw failure("staff_receiving_condition_invalid", { statusCode: 422 });
  }
  return {
    ingredientId: identifier(value.ingredientId, 160, "staff_receiving_ingredient_invalid"),
    clientReference: optionalText(value.clientReference, 160, "staff_receiving_client_reference_invalid"),
    purchaseOptionId: optionalText(value.purchaseOptionId, 160, "staff_receiving_purchase_option_invalid"),
    purchaseUnit: identifier(value.purchaseUnit, 32, "staff_receiving_purchase_unit_invalid"),
    deliveredQuantity, acceptedQuantity, rejectedQuantity, damagedQuantity,
    lotCode: optionalText(value.lotCode, 120, "staff_receiving_lot_invalid"),
    expiryDate: value.expiryDate == null ? null : date(value.expiryDate, "staff_receiving_expiry_invalid"),
    conditionCode,
    costRupiah: value.costRupiah == null ? null : bounded(value.costRupiah, 1, MAX_CANONICAL_COST_RUPIAH, "staff_receiving_cost_invalid"),
    note: optionalText(value.note, 500, "staff_receiving_line_note_invalid"),
  };
}

function normalizeResolvedLine(value, inputLine) {
  if (!value || typeof value !== "object" || value.active !== true || value.purchasable !== true) throw failure("staff_receiving_ingredient_not_purchasable", { statusCode: 422 });
  const input = normalizeLineInput(inputLine);
  const cost = value.confirmedCostRupiah ?? value.provisionalCostRupiah ?? input.costRupiah;
  return {
    ...input,
    ingredientSnapshot: object(value.ingredientSnapshot, "staff_receiving_ingredient_snapshot_invalid"),
    purchaseOptionSnapshot: object(value.purchaseOptionSnapshot, "staff_receiving_purchase_snapshot_invalid"),
    normalizedBaseQuantity: quantity(value.normalizedBaseQuantity, "staff_receiving_normalized_quantity_invalid", true),
    costRupiah: cost == null ? null : bounded(cost, 1, MAX_CANONICAL_COST_RUPIAH, "staff_receiving_cost_invalid"),
    costSource: cost == null ? null : identifier(value.costSource ?? (input.costRupiah != null ? "STAFF_CONFIRMED" : "APPROVED_OPTION"), 40, "staff_receiving_cost_source_invalid"),
    exceptionReasons: uniqueReasons(value.exceptionReasons ?? []),
  };
}

function withBusinessCostFacts(line, maxPriceVarianceBps) {
  const option = line.purchaseOptionSnapshot;
  const referenceUnitCost = Number(option.referencePriceRupiah);
  const referenceCostRupiah = Number.isFinite(referenceUnitCost) && referenceUnitCost > 0
    ? Math.round(referenceUnitCost * line.acceptedQuantity)
    : null;
  const priceVarianceBps = referenceCostRupiah && line.costRupiah != null
    ? Math.round(((line.costRupiah - referenceCostRupiah) / referenceCostRupiah) * 10_000)
    : null;
  const exceptions = new Set(line.exceptionReasons);
  if (priceVarianceBps != null && Math.abs(priceVarianceBps) > maxPriceVarianceBps) exceptions.add("PRICE_VARIANCE_REVIEW");
  const pendingQuantity = roundQuantity(line.deliveredQuantity - line.acceptedQuantity - line.rejectedQuantity - line.damagedQuantity);
  const fullyAccepted = line.rejectedQuantity === 0 && line.damagedQuantity === 0 && pendingQuantity === 0;
  if (!fullyAccepted) exceptions.add("COST_ALLOCATION_REQUIRED");
  const staffConfirmed = String(line.costSource ?? "").startsWith("STAFF_CONFIRMED");
  return {
    ...line,
    costSource: line.costRupiah == null ? null
      : staffConfirmed ? (referenceCostRupiah == null ? "STAFF_CONFIRMED" : "STAFF_CONFIRMED_REFERENCE_CHECKED")
        : referenceCostRupiah == null ? "REFERENCE_UNAVAILABLE" : "REFERENCE_OPTION",
    referenceCostRupiah,
    priceVarianceBps,
    acceptedCostRupiah: fullyAccepted ? line.costRupiah : null,
    rejectedCostRupiah: fullyAccepted ? 0 : null,
    damagedCostRupiah: fullyAccepted ? 0 : null,
    pendingCostRupiah: fullyAccepted ? 0 : null,
    costAllocationStatus: fullyAccepted ? "FULLY_ACCEPTED" : "REQUIRES_OWNER_ALLOCATION",
    exceptionReasons: [...exceptions].sort(),
  };
}

function fingerprintLine(line) {
  const { ingredientSnapshot, purchaseOptionSnapshot, exceptionReasons, ...rest } = line;
  return { ...rest, ingredientSnapshot, purchaseOptionSnapshot, exceptionReasons };
}

function postingCommand(receipt, lines, actor) {
  ensurePostableCosts(lines);
  ensureCanonicalPostingSupported(receipt, lines);
  return Object.freeze({
    action: "warehouse.receipt.post",
    idempotencyKey: canonicalPostingKey(receipt.id),
    sourceReceiptId: receipt.id,
    organizationId: receipt.organization_id,
    outletId: receipt.outlet_id,
    actorStaffId: receipt.actor_staff_id,
    actorReference: actor.actorReference,
    businessDate: date(receipt.business_date),
    supplierId: receipt.supplier_id ?? null,
    purchaseOrderId: receipt.purchase_order_id ?? null,
    supplierName: receipt.supplier_name,
    additionalFees: jsonArray(receipt.additional_fees),
    documentNumber: receipt.document_number,
    note: receipt.note,
    lines: lines.map((line) => ({
      sourceLineId: line.id,
      ingredientId: line.ingredient_id,
      purchaseOptionSnapshot: jsonObject(line.purchase_option_snapshot),
      deliveredQuantity: Number(line.delivered_quantity),
      acceptedQuantity: Number(line.accepted_quantity),
      rejectedQuantity: Number(line.rejected_quantity),
      damagedQuantity: Number(line.damaged_quantity),
      normalizedBaseQuantity: Number(line.normalized_base_quantity),
      lotCode: line.lot_code,
      expiryDate: line.expiry_date == null ? null : date(line.expiry_date),
      conditionCode: line.condition_code,
      costRupiah: line.cost_rupiah == null ? null : Number(line.cost_rupiah),
      costSource: line.cost_source,
    })),
  });
}

function staffContext(value) {
  return {
    organizationId: uuid(value.organizationId, "staff_receiving_scope_invalid"),
    outletId: uuid(value.outletId, "staff_receiving_scope_invalid"),
    staffId: uuid(value.staffId, "staff_receiving_staff_invalid"),
    actorReference: identifier(value.actorReference, 160, "staff_receiving_actor_invalid"),
  };
}

function ownerContext(value) {
  return {
    organizationId: uuid(value.organizationId, "staff_receiving_scope_invalid"),
    outletId: uuid(value.outletId, "staff_receiving_scope_invalid"),
    actorReference: identifier(value.actorReference, 160, "staff_receiving_actor_invalid"),
  };
}

function receiptSummary(row) {
  return { receiptId: row.id, status: row.status, revision: Number(row.revision), businessDate: date(row.business_date), duplicateOfReceiptId: row.duplicate_of_receipt_id ?? null, createdAt: timestamp(row.created_at) };
}

function postingRecoveryView(row) {
  return {
    ...receiptSummary(row),
    postingStartedAt: row.posting_started_at == null ? null : timestamp(row.posting_started_at),
    postingLastAttemptAt: row.posting_last_attempt_at == null ? null : timestamp(row.posting_last_attempt_at),
    postingAttemptCount: Number(row.posting_attempt_count ?? 0),
    postingClaimedAt: row.posting_claimed_at == null ? null : timestamp(row.posting_claimed_at),
    claimed: row.posting_claim_token_hash != null,
  };
}

async function lineReferences(db, receiptId) {
  const rows = (await db.query(
    "select id,ingredient_id,client_reference,sort_order from sagaops.inventory_receipt_draft_lines where receipt_id=$1 order by sort_order,id",
    [receiptId],
  )).rows;
  return rows.map((row) => ({ lineId: row.id, ingredientId: row.ingredient_id, clientReference: row.client_reference, sortOrder: Number(row.sort_order) }));
}

function lineSqlParams(lineId, receiptId, line, sortOrder, now) {
  return [lineId, receiptId, line.ingredientId, JSON.stringify(line.ingredientSnapshot), JSON.stringify(line.purchaseOptionSnapshot),
    line.deliveredQuantity, line.acceptedQuantity, line.rejectedQuantity, line.damagedQuantity, line.normalizedBaseQuantity,
    line.lotCode, line.expiryDate, line.conditionCode, line.costRupiah, line.costSource, line.referenceCostRupiah, line.priceVarianceBps,
    line.acceptedCostRupiah, line.rejectedCostRupiah, line.damagedCostRupiah, line.pendingCostRupiah, line.costAllocationStatus,
    JSON.stringify(line.exceptionReasons), line.note, line.clientReference, sortOrder, now];
}

function lineView(row) {
  return {
    lineId: row.id,
    ingredientId: row.ingredient_id,
    clientReference: row.client_reference,
    ingredient: jsonObject(row.ingredient_snapshot),
    purchaseOption: jsonObject(row.purchase_option_snapshot),
    deliveredQuantity: Number(row.delivered_quantity),
    acceptedQuantity: Number(row.accepted_quantity),
    rejectedQuantity: Number(row.rejected_quantity),
    damagedQuantity: Number(row.damaged_quantity),
    normalizedBaseQuantity: Number(row.normalized_base_quantity),
    lotCode: row.lot_code,
    expiryDate: row.expiry_date == null ? null : date(row.expiry_date),
    conditionCode: row.condition_code,
    costRupiah: row.cost_rupiah == null ? null : Number(row.cost_rupiah),
    costSource: row.cost_source,
    referenceCostRupiah: row.reference_cost_rupiah == null ? null : Number(row.reference_cost_rupiah),
    priceVarianceBps: row.price_variance_bps == null ? null : Number(row.price_variance_bps),
    costAllocation: {
      status: row.cost_allocation_status,
      acceptedCostRupiah: row.accepted_cost_rupiah == null ? null : Number(row.accepted_cost_rupiah),
      rejectedCostRupiah: row.rejected_cost_rupiah == null ? null : Number(row.rejected_cost_rupiah),
      damagedCostRupiah: row.damaged_cost_rupiah == null ? null : Number(row.damaged_cost_rupiah),
      pendingCostRupiah: row.pending_cost_rupiah == null ? null : Number(row.pending_cost_rupiah),
      allocatedFeeRupiah: Number(row.allocated_fee_rupiah ?? 0),
    },
    exceptionReasons: jsonArray(row.exception_reasons),
    note: row.note,
    sortOrder: Number(row.sort_order),
  };
}

function evidenceView(row, { staff, canReadEvidence }) {
  const base = staff ? "/api/staff/native/inventory-receipts" : "/api/operator/inventory-receipts";
  return {
    evidenceId: row.id,
    receiptId: row.receipt_id,
    lineId: row.receipt_line_id,
    category: row.category,
    status: row.status,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    checksum: row.checksum_sha256,
    width: Number(row.width),
    height: Number(row.height),
    capturedAt: row.captured_at == null ? null : timestamp(row.captured_at),
    uploadedAt: row.uploaded_at == null ? null : timestamp(row.uploaded_at),
    caption: row.caption,
    sortOrder: Number(row.sort_order),
    contentUrl: canReadEvidence ? `${base}/${encodeURIComponent(row.receipt_id)}/photos/${encodeURIComponent(row.id)}/content` : null,
  };
}

function evidenceSummary(row, idempotentReplay) {
  return { evidenceId: row.id, receiptId: row.receipt_id, status: row.status, objectKey: row.object_key, checksum: row.checksum_sha256, byteSize: Number(row.byte_size), contentType: row.content_type, idempotentReplay };
}

function uniqueCapabilities(values) {
  if (!Array.isArray(values)) throw failure("staff_receiving_capabilities_invalid", { statusCode: 422 });
  const result = [...new Set(values.map(String))].sort();
  if (result.some((value) => !CAPABILITY_SET.has(value))) throw failure("staff_receiving_capabilities_invalid", { statusCode: 422 });
  return result;
}

function uniqueReasons(values) {
  if (!Array.isArray(values)) throw failure("staff_receiving_exception_reasons_invalid", { statusCode: 422 });
  return [...new Set(values.map((value) => identifier(value, 80, "staff_receiving_exception_reason_invalid")))].sort();
}

function statusValue(value) {
  const status = String(value ?? "");
  if (!["DRAFT", "PENDING_REVIEW", "POSTING", "NEEDS_CORRECTION", "REJECTED", "POSTED"].includes(status)) throw failure("staff_receiving_status_invalid", { statusCode: 422 });
  return status;
}

function canonicalPostingKey(receiptId) {
  return `staff-receipt:${receiptId}:post`;
}

function ensurePostableCosts(lines) {
  for (const line of lines) {
    if (line.cost_rupiah == null || !Number.isSafeInteger(Number(line.cost_rupiah)) || Number(line.cost_rupiah) <= 0) {
      throw failure("staff_receiving_cost_unresolved", { statusCode: 409, detail: line.id });
    }
  }
}

function ensureCanonicalDispositionSupported(lines) {
  const blocker = canonicalDispositionBlocker(lines);
  if (blocker) throw failure(blocker.code, { statusCode: 409, detail: blocker.lineId });
}

function ensureCanonicalPostingSupported(receipt, lines) {
  const blocker = canonicalPostingBlocker(receipt, lines);
  if (blocker) throw failure(blocker.code, { statusCode: 409, detail: blocker.lineId ?? blocker.detail });
}

function canonicalDispositionBlocker(lines) {
  const missingAccepted = lines.find((line) => Number(line.accepted_quantity) <= 0);
  if (missingAccepted) return { code: "staff_receiving_accepted_quantity_required", reason: "ACCEPTED_QUANTITY_REQUIRED", lineId: missingAccepted.id };
  const rejected = lines.find((line) => Number(line.rejected_quantity) > 0);
  if (rejected) return { code: "staff_receiving_rejected_requires_correction", reason: "REJECTED_QUANTITY", lineId: rejected.id };
  return null;
}

function canonicalPostingBlocker(receipt, lines) {
  const disposition = canonicalDispositionBlocker(lines);
  if (disposition) return disposition;
  const unresolvedCost = lines.find((line) => line.cost_rupiah == null || !Number.isSafeInteger(Number(line.cost_rupiah)) || Number(line.cost_rupiah) <= 0 || Number(line.cost_rupiah) > MAX_CANONICAL_COST_RUPIAH);
  if (unresolvedCost) return { code: "staff_receiving_cost_unresolved", reason: "COST_REQUIRES_REVIEW", lineId: unresolvedCost.id };
  const ingredientGroups = new Map();
  for (const line of lines) {
    const group = ingredientGroups.get(line.ingredient_id) ?? [];
    group.push(line);
    ingredientGroups.set(line.ingredient_id, group);
    const condition = String(line.condition_code ?? "");
    const accepted = Number(line.accepted_quantity);
    const rejected = Number(line.rejected_quantity);
    const damaged = Number(line.damaged_quantity);
    const delivered = Number(line.delivered_quantity);
    const classified = roundQuantity(accepted + rejected + damaged);
    if ((damaged > 0 || classified < delivered) && line.cost_allocation_status !== "FULLY_ACCEPTED") {
      return { code: "staff_receiving_cost_allocation_unsupported", reason: "COST_ALLOCATION_REQUIRED", lineId: line.id };
    }
    if (!CONDITION_CODES.has(condition)
      || (condition === "GOOD" && (rejected > 0 || damaged > 0 || classified !== delivered))
      || (condition === "DAMAGED" && damaged <= 0)
      || (condition === "REJECTED" && rejected <= 0)
      || (condition === "SHORT" && classified >= delivered)) {
      return { code: "staff_receiving_condition_invalid", reason: "CONDITION_INVALID", lineId: line.id };
    }
    const ingredient = jsonObject(line.ingredient_snapshot);
    const minimumShelfLifeDays = Number(ingredient.minimumShelfLifeDays ?? 0);
    if (ingredient.lotTrackingPolicy === "REQUIRED" && !line.lot_code) return { code: "staff_receiving_lot_required", reason: "LOT_REQUIRED", lineId: line.id };
    if (minimumShelfLifeDays > 0) {
      if (!line.expiry_date) return { code: "staff_receiving_expiry_required", reason: "EXPIRY_REQUIRED", lineId: line.id };
      const minimumExpiry = addBusinessDays(date(receipt.business_date), minimumShelfLifeDays);
      if (date(line.expiry_date) < minimumExpiry) return { code: "staff_receiving_shelf_life_too_short", reason: "SHELF_LIFE_TOO_SHORT", lineId: line.id };
    }
  }
  for (const group of ingredientGroups.values()) {
    if (group.length === 1) continue;
    const lotCodes = new Set();
    const firstOption = jsonObject(group[0].purchase_option_snapshot);
    const packageKey = `${firstOption.purchaseOptionId ?? ""}\u0000${firstOption.purchaseUnit ?? ""}\u0000${firstOption.baseUnitsPerPurchaseUnit ?? ""}`;
    for (const line of group) {
      const option = jsonObject(line.purchase_option_snapshot);
      const lotKey = String(line.lot_code ?? "").normalize("NFKC").trim().toLocaleUpperCase("id-ID");
      if (!lotKey || !line.expiry_date) return { code: "staff_receiving_multi_lot_identity_required", reason: "MULTI_LOT_IDENTITY_REQUIRED", lineId: line.id };
      if (lotCodes.has(lotKey)) return { code: "staff_receiving_lot_duplicate", reason: "LOT_DUPLICATE", lineId: line.id };
      lotCodes.add(lotKey);
      if (`${option.purchaseOptionId ?? ""}\u0000${option.purchaseUnit ?? ""}\u0000${option.baseUnitsPerPurchaseUnit ?? ""}` !== packageKey) {
        return { code: "staff_receiving_multi_lot_package_mismatch", reason: "MULTI_LOT_PACKAGE_MISMATCH", lineId: line.id };
      }
    }
  }
  return null;
}

function addBusinessDays(value, days) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function deterministicCanonicalFailure(error) {
  const statusCode = Number(error?.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500) return false;
  return !new Set(["hpp_version_conflict", "staff_receiving_post_conflict"]).has(String(error?.code ?? ""));
}

function canonicalFailureReason(error) {
  const suffix = String(error?.code ?? "unknown").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 60);
  return `CANONICAL_${suffix}`;
}

function contentTypeValue(value) {
  const contentType = String(value ?? "").toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw failure("staff_receiving_evidence_content_type_invalid", { statusCode: 415 });
  return contentType;
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(code, { statusCode: 422 });
  return structuredClone(value);
}

function jsonObject(value) {
  if (typeof value === "string") return JSON.parse(value);
  return structuredClone(value ?? {});
}

function jsonArray(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? structuredClone(parsed) : [];
}

function quantity(value, code, allowZero = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || (!allowZero && number <= 0) || (allowZero && number < 0) || number > 1_000_000_000 || roundQuantity(number) !== number) throw failure(code, { statusCode: 422 });
  return number;
}

function roundQuantity(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function assertValidIngredientLots(lines) {
  const groups = new Map();
  for (const line of lines) {
    const group = groups.get(line.ingredientId) ?? [];
    group.push(line);
    groups.set(line.ingredientId, group);
  }
  for (const [ingredientId, group] of groups) {
    if (group.length === 1) continue;
    const lotCodes = new Set();
    const optionKey = `${group[0].purchaseOptionId ?? ""}\u0000${group[0].purchaseUnit}`;
    for (const line of group) {
      if (!line.lotCode || !line.expiryDate) throw failure("staff_receiving_multi_lot_identity_required", { statusCode: 422, detail: ingredientId });
      const lotKey = line.lotCode.normalize("NFKC").trim().toLocaleUpperCase("id-ID");
      if (lotCodes.has(lotKey)) throw failure("staff_receiving_lot_duplicate", { statusCode: 422, detail: ingredientId });
      lotCodes.add(lotKey);
      if (`${line.purchaseOptionId ?? ""}\u0000${line.purchaseUnit}` !== optionKey) {
        throw failure("staff_receiving_multi_lot_package_mismatch", { statusCode: 422, detail: ingredientId });
      }
    }
  }
}

function normalizeAdditionalFees(values) {
  if (!Array.isArray(values) || values.length > 10) throw failure("staff_receiving_additional_fees_invalid", { statusCode: 422 });
  const allowed = new Set(["SHIPPING", "HANDLING", "OTHER"]);
  const seen = new Set();
  const normalized = values.map((value) => {
    if (!value || typeof value !== "object" || !allowed.has(value.type) || seen.has(value.type)) {
      throw failure("staff_receiving_additional_fee_invalid", { statusCode: 422 });
    }
    seen.add(value.type);
    return { type: value.type, amountRupiah: bounded(value.amountRupiah, 1, MAX_CANONICAL_COST_RUPIAH, "staff_receiving_additional_fee_invalid") };
  }).sort((left, right) => left.type.localeCompare(right.type));
  const total = normalized.reduce((sum, value) => sum + value.amountRupiah, 0);
  if (!Number.isSafeInteger(total) || total > MAX_CANONICAL_COST_RUPIAH) throw failure("staff_receiving_additional_fee_total_invalid", { statusCode: 422 });
  return normalized;
}

function rejectUnsupportedCommercialFields(input) {
  for (const field of ["taxRupiah", "discountRupiah"]) {
    if (input[field] !== undefined && input[field] !== null && Number(input[field]) !== 0) {
      throw failure(`staff_receiving_${field === "taxRupiah" ? "tax" : "discount"}_unsupported`, { statusCode: 422 });
    }
  }
}

function normalizeResolvedProcurement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("staff_receiving_procurement_invalid", { statusCode: 503 });
  return {
    supplierId: optionalText(value.supplierId, 160, "staff_receiving_supplier_id_invalid"),
    purchaseOrderId: optionalText(value.purchaseOrderId, 160, "staff_receiving_purchase_order_invalid"),
    supplierName: optionalText(value.supplierName, 160, "staff_receiving_supplier_invalid"),
    procurementSnapshot: object(value.procurementSnapshot ?? {}, "staff_receiving_procurement_snapshot_invalid"),
    additionalFees: normalizeAdditionalFees(value.additionalFees ?? []),
  };
}

function normalizedDeliveryIdentity(supplierName, documentNumber) {
  if (!supplierName || !documentNumber) return null;
  const supplier = supplierName.normalize("NFKC").trim().toLocaleLowerCase("id-ID").replace(/\s+/g, " ");
  const document = documentNumber.normalize("NFKC").trim().toLocaleUpperCase("id-ID").replace(/[^A-Z0-9]+/g, "");
  return supplier && document ? { supplier, document } : null;
}

function bounded(value, min, max, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw failure(code, { statusCode: 422 });
  return number;
}

function optionalText(value, max, code) {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, 1, max, code);
}

function requiredText(value, min, max, code) {
  if (typeof value !== "string" || value !== value.trim() || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw failure(code, { statusCode: 422 });
  return value;
}

function identifier(value, max, code) {
  return requiredText(value, 1, max, code);
}

function sha256(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure(code, { statusCode: 422 });
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw failure(code, { statusCode: 422 });
  return value.toLowerCase();
}

function date(value, code = "staff_receiving_date_invalid") {
  if (value instanceof Date) value = value.toISOString().slice(0, 10);
  if (typeof value !== "string") value = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw failure(code, { statusCode: 422 });
  return value;
}

function timestamp(value, code = "staff_receiving_timestamp_invalid") {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw failure(code, { statusCode: 422 });
  return parsed.toISOString();
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeFailureCode(error) {
  return /^[a-z0-9_]{1,100}$/.test(error?.code ?? "") ? error.code : "receipt_evidence_upload_failed";
}

function mapStorageFailure(error) {
  const mappings = {
    receipt_evidence_too_large: "staff_receiving_evidence_too_large",
    receipt_evidence_checksum_mismatch: "staff_receiving_evidence_checksum_mismatch",
    receipt_evidence_content_type_unsupported: "staff_receiving_evidence_content_type_invalid",
    receipt_evidence_binary_unsupported: "staff_receiving_evidence_content_type_invalid",
    receipt_evidence_mime_mismatch: "staff_receiving_evidence_content_type_invalid",
    receipt_evidence_dimension_mismatch: "staff_receiving_evidence_dimension_mismatch",
    receipt_evidence_content_length_mismatch: "staff_receiving_evidence_size_mismatch",
    receipt_evidence_binary_required: "staff_receiving_evidence_binary_invalid",
  };
  const code = mappings[error?.code];
  if (!code) return error;
  return failure(code, { statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 422 });
}

function failure(code, options = {}) {
  return new StaffInventoryReceivingError(code, options);
}
