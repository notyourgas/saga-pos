import { createHash, randomUUID } from "node:crypto";

import { createCatalogQuote } from "./quote.mjs";
import { createPromotionVersion } from "./promotions.mjs";
import { createPriceBookVersion, createPricingPolicyVersion } from "./versions.mjs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;

export function createPostgresEsbCatalogRuntime({ db, clock = () => new Date() } = {}) {
  if (!db?.query || !db?.transaction) throw catalogRuntimeError("catalog_runtime_database_required", 500);

  return Object.freeze({
    adminState: (scope) => loadAdminState(db, scope, clock),
    createDraft: (command) => createDraft(db, command, clock),
    publish: (command) => publishDraft(db, command, clock),
    authorizeFreePrice: (command) => authorizeFreePrice(db, command, clock),
    quote: (command) => quoteFromPublishedVersion(db, command),
  });
}

async function loadAdminState(db, scope, clock) {
  assertScope(scope);
  await assertOwnerScope(db, scope);
  const result = await db.query(`select pb.id price_book_id,pb.code,pb.name,pbv.id version_id,pbv.version,pbv.status,
      pbv.valid_from,pbv.valid_to,ppv.id policy_id,ppv.policy_code,ppv.status policy_status,
      a.price_book_version_id assigned_version_id,a.revision assignment_revision,a.assigned_at,
      (select count(*)::integer from sagaops.price_book_entries e where e.organization_id=$1 and e.price_book_version_id=pbv.id) entry_count
    from sagaops.price_books pb
    join sagaops.price_book_versions pbv on pbv.organization_id=pb.organization_id and pbv.price_book_id=pb.id
    join sagaops.pricing_policy_versions ppv on ppv.organization_id=pbv.organization_id and ppv.id=pbv.pricing_policy_version_id
    left join sagaops.outlet_price_book_assignments a on a.organization_id=pb.organization_id and a.outlet_id=$2
    where pb.organization_id=$1
    order by pb.code,pbv.version desc`, [scope.organizationId, scope.outletId]);
  const versions = [];
  for (const row of result.rows) {
    const status = String(row.status).toUpperCase();
    versions.push({
      priceBookId: row.price_book_id,
      code: row.code,
      name: row.name,
      versionId: row.version_id,
      version: Number(row.version),
      status,
      validFrom: iso(row.valid_from),
      validTo: iso(row.valid_to),
      pricingPolicyVersionId: row.policy_id,
      policyCode: row.policy_code,
      policyStatus: String(row.policy_status).toUpperCase(),
      entryCount: Number(row.entry_count),
      assigned: row.assigned_version_id === row.version_id,
      assignmentRevision: row.assigned_version_id === row.version_id ? Number(row.assignment_revision) : null,
      assignedAt: row.assigned_version_id === row.version_id ? iso(row.assigned_at) : null,
      draftHash: status === "DRAFT" ? fingerprint(await loadDraftAggregate(db, scope.organizationId, row.version_id)) : null,
    });
  }
  return {
    mode: "ESB_CATALOG_VERSIONED_V1",
    runtimeGuard: "DEFAULT_OFF",
    generatedAt: clock().toISOString(),
    versions,
  };
}

async function createDraft(db, command, clock) {
  const scope = assertOwnerCommand(command);
  const code = requiredCode(command.code);
  const name = requiredText(command.name, "catalog_price_book_name_invalid", 120);
  const reason = requiredText(command.reason, "catalog_reason_required", 240);
  const operationKey = requiredText(command.operationKey, "catalog_operation_key_required", 128);
  const entries = normalizeDraftEntries(command.entries);
  const validFrom = validInstant(command.validFrom ?? clock().toISOString(), "catalog_valid_from_invalid");
  const validTo = command.validTo == null || command.validTo === "" ? null : validInstant(command.validTo, "catalog_valid_to_invalid");
  if (validTo && Date.parse(validTo) <= Date.parse(validFrom)) throw catalogRuntimeError("catalog_interval_invalid", 422);

  return db.transaction(async (tx) => {
    await assertOwnerScope(tx, scope);
    const replay = await auditReplay(tx, scope.organizationId, operationKey, "esb.catalog.draft.created");
    if (replay) return { ...replay, idempotentReplay: true };
    let book = (await tx.query("select id,code,name from sagaops.price_books where organization_id=$1 and code=$2 for update", [scope.organizationId, code])).rows[0];
    if (!book) {
      book = (await tx.query(`insert into sagaops.price_books(id,organization_id,code,name,status)
        values ($1,$2,$3,$4,'active') returning id,code,name`, [randomUUID(), scope.organizationId, code, name])).rows[0];
    }
    const draft = (await tx.query(`select id from sagaops.price_book_versions
      where organization_id=$1 and price_book_id=$2 and status='draft' limit 1 for update`, [scope.organizationId, book.id])).rows[0];
    if (draft) throw catalogRuntimeError("catalog_draft_already_exists", 409);
    const latest = (await tx.query("select coalesce(max(version),0)::integer version from sagaops.price_book_versions where organization_id=$1 and price_book_id=$2", [scope.organizationId, book.id])).rows[0];
    const version = Number(latest.version) + 1;
    const policyId = randomUUID();
    const versionId = randomUUID();
    const policy = normalizePolicy({ ...command.policy, id: policyId, code: `${code}_POLICY`, version, validFrom, validTo });
    await tx.query(`insert into sagaops.pricing_policy_versions
      (id,organization_id,policy_code,version,status,currency,timezone,tax_rate_bps,service_rate_bps,
       price_includes_tax,price_includes_service,service_taxable,tax_discount_timing,rounding_mode,
       rounding_step_rupiah,valid_from,valid_to,policy_snapshot,created_by_user_id)
      values ($1,$2,$3,$4,'draft','IDR',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)`,
    [policyId, scope.organizationId, policy.code, version, policy.timezone, policy.taxRateBps,
      policy.serviceRateBps, policy.priceIncludesTax, policy.priceIncludesService, policy.serviceTaxable,
      policy.taxDiscountTiming.toLowerCase(), policy.rounding.mode.toLowerCase(), policy.rounding.stepRupiah,
      policy.startsAt, policy.endsAt, JSON.stringify(policy), scope.actorUserId]);
    await tx.query(`insert into sagaops.price_book_versions
      (id,organization_id,price_book_id,pricing_policy_version_id,version,status,currency,valid_from,valid_to,created_by_user_id)
      values ($1,$2,$3,$4,$5,'draft','IDR',$6,$7,$8)`,
    [versionId, scope.organizationId, book.id, policyId, version, validFrom, validTo, scope.actorUserId]);
    for (const entry of entries) {
      const product = await resolveProduct(tx, scope.organizationId, entry);
      await tx.query(`insert into sagaops.price_book_entries
        (id,organization_id,price_book_version_id,product_id,product_reference,product_name_snapshot,price_rupiah,
         free_price_enabled,minimum_free_price_rupiah,maximum_free_price_rupiah,pos_enabled,online_enabled)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)`,
      [randomUUID(), scope.organizationId, versionId, product.id, entry.productReference, entry.productName, entry.priceRupiah,
        entry.freePriceEnabled, entry.minimumFreePriceRupiah, entry.maximumFreePriceRupiah, entry.posEnabled]);
    }
    const aggregate = await loadDraftAggregate(tx, scope.organizationId, versionId);
    const draftHash = fingerprint(aggregate);
    await appendAudit(tx, scope, versionId, "esb.catalog.draft.created", operationKey, { code, version, draftHash, entryCount: entries.length, reason });
    return { versionId, priceBookId: book.id, version, status: "DRAFT", draftHash, entryCount: entries.length, idempotentReplay: false };
  });
}

async function publishDraft(db, command, clock) {
  const scope = assertOwnerCommand(command);
  const versionId = requiredUuid(command.versionId, "catalog_version_id_invalid");
  const expectedDraftHash = requiredHash(command.expectedDraftHash);
  const operationKey = requiredText(command.operationKey, "catalog_operation_key_required", 128);
  const reason = requiredText(command.reason, "catalog_reason_required", 240);
  const occurredAt = clock().toISOString();
  return db.transaction(async (tx) => {
    await assertOwnerScope(tx, scope);
    const replay = await auditReplay(tx, scope.organizationId, operationKey, "esb.catalog.version.published");
    if (replay) return { ...replay, idempotentReplay: true };
    const version = (await tx.query(`select pbv.*,pb.code,ppv.status policy_status
      from sagaops.price_book_versions pbv
      join sagaops.price_books pb on pb.organization_id=pbv.organization_id and pb.id=pbv.price_book_id
      join sagaops.pricing_policy_versions ppv on ppv.organization_id=pbv.organization_id and ppv.id=pbv.pricing_policy_version_id
      where pbv.organization_id=$1 and pbv.id=$2 for update`, [scope.organizationId, versionId])).rows[0];
    if (!version) throw catalogRuntimeError("catalog_version_not_found", 404);
    if (version.status !== "draft" || version.policy_status !== "draft") throw catalogRuntimeError("catalog_version_immutable", 409);
    const aggregate = await loadDraftAggregate(tx, scope.organizationId, versionId);
    if (aggregate.entries.length === 0) throw catalogRuntimeError("catalog_price_book_empty", 422);
    if (fingerprint(aggregate) !== expectedDraftHash) throw catalogRuntimeError("catalog_version_conflict", 409);
    await tx.query("update sagaops.pricing_policy_versions set status='published',published_at=$3 where organization_id=$1 and id=$2 and status='draft'", [scope.organizationId, version.pricing_policy_version_id, occurredAt]);
    const updated = await tx.query("update sagaops.price_book_versions set status='published',published_at=$3 where organization_id=$1 and id=$2 and status='draft' returning id", [scope.organizationId, versionId, occurredAt]);
    if (!updated.rows[0]) throw catalogRuntimeError("catalog_version_conflict", 409);
    const current = (await tx.query("select price_book_version_id,revision from sagaops.outlet_price_book_assignments where organization_id=$1 and outlet_id=$2 for update", [scope.organizationId, scope.outletId])).rows[0];
    const revision = Number(current?.revision ?? 0) + 1;
    await tx.query(`insert into sagaops.outlet_price_book_assignments
      (organization_id,outlet_id,price_book_id,price_book_version_id,revision,assigned_by_user_id,assigned_at)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (outlet_id) do update set price_book_id=excluded.price_book_id,
        price_book_version_id=excluded.price_book_version_id,revision=excluded.revision,
        assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at`,
    [scope.organizationId, scope.outletId, version.price_book_id, versionId, revision, scope.actorUserId, occurredAt]);
    await tx.query(`insert into sagaops.outlet_price_book_assignment_events
      (id,organization_id,outlet_id,price_book_id,price_book_version_id,previous_price_book_version_id,
       revision,operation_key,actor_user_id,reason,occurred_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), scope.organizationId, scope.outletId, version.price_book_id, versionId,
      current?.price_book_version_id ?? null, revision, operationKey, scope.actorUserId, reason, occurredAt]);
    const result = { versionId, priceBookId: version.price_book_id, version: Number(version.version), status: "PUBLISHED", assignmentRevision: revision };
    await appendAudit(tx, scope, versionId, "esb.catalog.version.published", operationKey, { ...result, reason });
    return { ...result, idempotentReplay: false };
  });
}

async function authorizeFreePrice(db, command, clock) {
  const scope = assertOwnerCommand(command);
  const productReference = requiredText(command.productReference, "catalog_product_reference_invalid", 120);
  const requested = rupiah(command.requestedPriceRupiah, "free_price_value_invalid");
  const operationKey = requiredText(command.operationKey, "catalog_operation_key_required", 128);
  const reason = requiredText(command.reason, "catalog_reason_required", 240);
  const ttlSeconds = Number(command.ttlSeconds ?? 300);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) throw catalogRuntimeError("free_price_expiry_invalid", 422);
  const approvedAt = clock().toISOString();
  const expiresAt = new Date(Date.parse(approvedAt) + ttlSeconds * 1000).toISOString();
  return db.transaction(async (tx) => {
    await assertOwnerScope(tx, scope);
    const entry = (await tx.query(`select e.id,e.price_rupiah,e.minimum_free_price_rupiah,e.maximum_free_price_rupiah,e.free_price_enabled
      from sagaops.outlet_price_book_assignments a
      join sagaops.price_book_versions v on v.organization_id=a.organization_id and v.id=a.price_book_version_id
      join sagaops.price_book_entries e on e.organization_id=v.organization_id and e.price_book_version_id=v.id
      where a.organization_id=$1 and a.outlet_id=$2 and e.product_reference=$3
        and v.status='published' and v.valid_from <= $4 and (v.valid_to is null or $4 < v.valid_to)
      for update`, [scope.organizationId, scope.outletId, productReference, approvedAt])).rows;
    if (entry.length !== 1) throw catalogRuntimeError(entry.length ? "catalog_assignment_ambiguous" : "catalog_assignment_not_available", 409);
    const selected = entry[0];
    if (!selected.free_price_enabled) throw catalogRuntimeError("free_price_not_enabled", 403);
    if (requested < numeric(selected.minimum_free_price_rupiah) || requested > numeric(selected.maximum_free_price_rupiah)) throw catalogRuntimeError("free_price_value_invalid", 422);
    const id = randomUUID();
    await tx.query(`insert into sagaops.catalog_free_price_authorizations
      (id,organization_id,outlet_id,price_book_entry_id,operation_key,actor_user_id,approved_by_user_id,
       original_price_rupiah,requested_price_rupiah,reason,approved_at,expires_at)
      values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)`,
    [id, scope.organizationId, scope.outletId, selected.id, operationKey, scope.actorUserId,
      numeric(selected.price_rupiah), requested, reason, approvedAt, expiresAt]);
    await appendAudit(tx, scope, id, "esb.catalog.free_price.authorized", operationKey, { productReference, requestedPriceRupiah: requested, expiresAt, reason });
    return { authorizationId: id, productReference, requestedPriceRupiah: requested, expiresAt, oneTime: true };
  });
}

async function quoteFromPublishedVersion(db, command) {
  const scope = assertScope(command);
  const occurredAt = validInstant(command.occurredAt, "catalog_quote_time_invalid");
  if (!Array.isArray(command.items) || command.items.length === 0) throw catalogRuntimeError("catalog_quote_items_required", 422);
  const assignment = await db.query(`select a.price_book_id,a.price_book_version_id,a.revision,pb.code,
      v.version,v.status,v.currency,v.valid_from,v.valid_to,v.pricing_policy_version_id,
      p.policy_code,p.version policy_version,p.status policy_status,p.currency policy_currency,p.timezone,
      p.tax_rate_bps,p.service_rate_bps,p.price_includes_tax,p.price_includes_service,p.service_taxable,
      p.tax_discount_timing,p.rounding_mode,p.rounding_step_rupiah,p.valid_from policy_valid_from,p.valid_to policy_valid_to
    from sagaops.outlet_price_book_assignments a
    join sagaops.price_books pb on pb.organization_id=a.organization_id and pb.id=a.price_book_id
    join sagaops.price_book_versions v on v.organization_id=a.organization_id and v.id=a.price_book_version_id and v.price_book_id=a.price_book_id
    join sagaops.pricing_policy_versions p on p.organization_id=v.organization_id and p.id=v.pricing_policy_version_id
    where a.organization_id=$1 and a.outlet_id=$2`, [scope.organizationId, scope.outletId]);
  if (assignment.rows.length !== 1) throw catalogRuntimeError(assignment.rows.length ? "catalog_assignment_ambiguous" : "catalog_assignment_not_available", 503);
  const selected = assignment.rows[0];
  if (selected.status !== "published" || selected.policy_status !== "published") throw catalogRuntimeError("catalog_assignment_not_published", 503);
  const entryRows = await db.query(`select e.id,e.product_id,e.product_reference,e.variant_id,e.price_rupiah,e.free_price_enabled,
      e.minimum_free_price_rupiah,e.maximum_free_price_rupiah,e.pos_enabled,e.online_enabled,
      coalesce(e.product_name_snapshot,p.name) product_name,p.category_id
    from sagaops.price_book_entries e
    join sagaops.products p on p.organization_id=e.organization_id and p.id=e.product_id
    where e.organization_id=$1 and e.price_book_version_id=$2 order by e.id`, [scope.organizationId, selected.price_book_version_id]);
  if (!entryRows.rows.length || entryRows.rows.some((row) => !row.product_reference)) throw catalogRuntimeError("catalog_entries_incomplete", 503);
  const priceBookVersion = createPriceBookVersion({
    id: selected.price_book_version_id,
    priceBookId: selected.price_book_id,
    code: selected.code,
    version: Number(selected.version),
    status: "PUBLISHED",
    currency: selected.currency,
    pricingPolicyVersionId: selected.pricing_policy_version_id,
    validFrom: iso(selected.valid_from),
    validTo: iso(selected.valid_to),
    entries: entryRows.rows.map((row) => ({ id: row.id, productId: row.product_reference, variantId: row.variant_id,
      priceRupiah: numeric(row.price_rupiah), freePriceEnabled: row.free_price_enabled,
      minimumFreePriceRupiah: numeric(row.minimum_free_price_rupiah), maximumFreePriceRupiah: numeric(row.maximum_free_price_rupiah),
      posEnabled: row.pos_enabled, onlineEnabled: row.online_enabled })),
  });
  const pricingPolicyVersion = createPricingPolicyVersion({
    id: selected.pricing_policy_version_id, code: selected.policy_code, version: Number(selected.policy_version),
    status: "PUBLISHED", currency: selected.policy_currency, timezone: selected.timezone,
    taxRateBps: Number(selected.tax_rate_bps), serviceRateBps: Number(selected.service_rate_bps),
    priceIncludesTax: selected.price_includes_tax, priceIncludesService: selected.price_includes_service,
    serviceTaxable: selected.service_taxable, taxDiscountTiming: String(selected.tax_discount_timing).toUpperCase(),
    roundingMode: String(selected.rounding_mode).toUpperCase(), roundingStepRupiah: numeric(selected.rounding_step_rupiah),
    validFrom: iso(selected.policy_valid_from), validTo: iso(selected.policy_valid_to),
  });
  const rowByReference = new Map(entryRows.rows.map((row) => [row.product_reference, row]));
  const overrides = new Map((command.request?.esbFreePriceOverrides ?? []).map((item) => [String(item.productReference), item]));
  const items = [];
  for (const item of command.items) {
    const productReference = requiredText(item.productReference, "catalog_product_reference_invalid", 120);
    const row = rowByReference.get(productReference);
    if (!row) throw catalogRuntimeError("price_book_entry_not_found", 404);
    const modifier = await loadPersistedModifierContract(db, scope, row.product_id, item.modifiers ?? []);
    const override = overrides.get(productReference);
    let freePriceAuthorization;
    if (override) freePriceAuthorization = await loadFreePriceAuthorization(db, scope, row, override, occurredAt);
    items.push({
      lineId: item.id,
      productId: productReference,
      categoryId: row.category_id,
      variantId: row.variant_id,
      productName: row.product_name,
      quantity: Number(item.qty),
      modifierGroups: modifier.groups,
      modifierSelections: modifier.selections,
      ...(override ? { requestedFreePriceRupiah: Number(override.requestedPriceRupiah), freePriceOperationKey: override.operationKey, freePriceAuthorization } : {}),
    });
  }
  const promotions = await loadPromotions(db, scope.organizationId);
  return createCatalogQuote({
    priceBookVersion, pricingPolicyVersion, items, promotions, occurredAt,
    context: { outletId: scope.outletId, channel: command.order?.channel ?? "POS", salesMode: command.order?.orderType,
      paymentMethod: command.request?.paymentMethod, actorUserId: scope.actorUserId },
  });
}

async function loadFreePriceAuthorization(db, scope, entry, override, occurredAt) {
  const id = requiredUuid(override.authorizationId, "free_price_authorization_id_required");
  const operationKey = requiredText(override.operationKey, "free_price_operation_key_required", 128);
  const requested = rupiah(override.requestedPriceRupiah, "free_price_value_invalid");
  const result = await db.query(`select * from sagaops.catalog_free_price_authorizations
    where organization_id=$1 and outlet_id=$2 and id=$3 and price_book_entry_id=$4`,
  [scope.organizationId, scope.outletId, id, entry.id]);
  if (result.rows.length !== 1) throw catalogRuntimeError("free_price_authorization_required", 403);
  const row = result.rows[0];
  if (row.consumed_at || row.operation_key !== operationKey || numeric(row.requested_price_rupiah) !== requested || row.actor_user_id !== scope.actorUserId || Date.parse(occurredAt) >= Date.parse(row.expires_at)) {
    throw catalogRuntimeError("free_price_authorization_scope_mismatch", 403);
  }
  return {
    id: row.id, status: "APPROVED", permission: "POS_CATALOG_FREE_PRICE_APPLY", action: "PRICE_OVERRIDE",
    resourceType: "PRICE_BOOK_ENTRY", resourceId: row.price_book_entry_id, actorUserId: row.actor_user_id,
    approvedByUserId: row.approved_by_user_id, originalPriceRupiah: numeric(row.original_price_rupiah),
    requestedPriceRupiah: numeric(row.requested_price_rupiah), reason: row.reason, approvedAt: iso(row.approved_at),
    expiresAt: iso(row.expires_at), oneTime: true, usedAt: null,
  };
}

async function loadPromotions(db, organizationId) {
  const result = await db.query(`select v.*,r.code from sagaops.promotion_versions v
    join sagaops.promotion_rules r on r.organization_id=v.organization_id and r.id=v.promotion_rule_id
    where v.organization_id=$1 and v.status='published' order by v.priority,v.id`, [organizationId]);
  return result.rows.map((row) => createPromotionVersion({
    ...(row.rule_snapshot ?? {}), id: row.id, code: row.code, version: Number(row.version),
    status: row.record_active ? "ACTIVE" : "PAUSED", type: String(row.promotion_type).toUpperCase(),
    value: numeric(row.promotion_value), priority: Number(row.priority), stackPolicy: String(row.stack_policy).toUpperCase(),
    stackGroup: row.stack_group, minimumSpendRupiah: numeric(row.minimum_spend_rupiah),
    capRupiah: row.cap_rupiah == null ? null : numeric(row.cap_rupiah), startsAt: iso(row.valid_from), endsAt: iso(row.valid_to),
    schedule: row.schedule_snapshot,
  }));
}

async function loadPersistedModifierContract(db, scope, productId, values) {
  if (!Array.isArray(values)) throw catalogRuntimeError("modifier_contract_invalid", 422);
  const result = await db.query(`select g.id group_id,g.minimum_selections,g.maximum_selections,g.updated_at group_updated_at,
      o.id option_id,o.name option_name,o.price_delta_rupiah,o.updated_at option_updated_at
    from sagaops.product_modifier_groups link
    join sagaops.modifier_groups g on g.id=link.modifier_group_id and g.organization_id=$1 and g.status='active'
    left join sagaops.modifier_options o on o.modifier_group_id=g.id and o.organization_id=g.organization_id and o.status='active'
    where link.product_id=$2
    order by link.sort_order,g.id,o.id`, [scope.organizationId, productId]);
  const byGroup = new Map();
  for (const row of result.rows) {
    let group = byGroup.get(row.group_id);
    if (!group) {
      group = {
        id: row.group_id,
        version: timestampVersion(row.group_updated_at),
        minimumSelections: Number(row.minimum_selections),
        maximumSelections: Number(row.maximum_selections),
        allowRepeat: false,
        options: [],
      };
      byGroup.set(row.group_id, group);
    }
    if (row.option_id) group.options.push({
      id: row.option_id,
      version: timestampVersion(row.option_updated_at),
      name: row.option_name,
      priceDeltaRupiah: numeric(row.price_delta_rupiah),
    });
  }
  return {
    groups: [...byGroup.values()],
    selections: values.map((value) => ({
      groupId: requiredUuid(value.groupId, "modifier_group_id_required"),
      optionId: requiredUuid(value.optionId, "modifier_option_id_required"),
      quantity: value.quantity == null ? 1 : Number(value.quantity),
    })),
  };
}

function timestampVersion(value) {
  const version = Math.floor(new Date(value).getTime() / 1_000);
  if (!Number.isInteger(version) || version < 1) throw catalogRuntimeError("modifier_policy_version_invalid", 503);
  return version;
}

async function loadDraftAggregate(tx, organizationId, versionId) {
  const version = (await tx.query(`select pbv.id,pbv.price_book_id,pbv.version,pbv.valid_from,pbv.valid_to,pb.code,pb.name,
      ppv.id policy_id,ppv.policy_snapshot
    from sagaops.price_book_versions pbv
    join sagaops.price_books pb on pb.organization_id=pbv.organization_id and pb.id=pbv.price_book_id
    join sagaops.pricing_policy_versions ppv on ppv.organization_id=pbv.organization_id and ppv.id=pbv.pricing_policy_version_id
    where pbv.organization_id=$1 and pbv.id=$2`, [organizationId, versionId])).rows[0];
  if (!version) throw catalogRuntimeError("catalog_version_not_found", 404);
  const entries = (await tx.query(`select product_reference,product_name_snapshot,price_rupiah,free_price_enabled,minimum_free_price_rupiah,
      maximum_free_price_rupiah,pos_enabled from sagaops.price_book_entries
    where organization_id=$1 and price_book_version_id=$2 order by product_reference,id`, [organizationId, versionId])).rows;
  return {
    versionId: version.id, priceBookId: version.price_book_id, code: version.code, name: version.name,
    version: Number(version.version), validFrom: iso(version.valid_from), validTo: iso(version.valid_to), policy: version.policy_snapshot,
    entries: entries.map((entry) => ({ productReference: entry.product_reference, productName: entry.product_name_snapshot,
      priceRupiah: numeric(entry.price_rupiah),
      freePriceEnabled: entry.free_price_enabled, minimumFreePriceRupiah: numeric(entry.minimum_free_price_rupiah),
      maximumFreePriceRupiah: numeric(entry.maximum_free_price_rupiah), posEnabled: entry.pos_enabled })),
  };
}

async function resolveProduct(tx, organizationId, entry) {
  const sku = `ESBREF:${entry.productReference}`;
  const existing = await tx.query("select id,name,sku from sagaops.products where organization_id=$1 and sku=$2", [organizationId, sku]);
  if (existing.rows[0]) {
    const product = existing.rows[0];
    return product;
  }
  const bridgeName = `ESBREF ${fingerprint(entry.productReference).slice(0, 16)}`;
  return (await tx.query(`insert into sagaops.products(id,organization_id,name,sku,status,price_rupiah)
    values ($1,$2,$3,$4,'active',$5) returning id,name,sku`, [randomUUID(), organizationId, bridgeName, sku, entry.priceRupiah])).rows[0];
}

async function assertOwnerScope(tx, scope) {
  const result = await tx.query(`select 1 ok from sagaops.outlet_user_roles
    where organization_id=$1 and outlet_id=$2 and user_profile_id=$3 and role='owner'`,
  [scope.organizationId, scope.outletId, scope.actorUserId]);
  if (result.rows.length !== 1) throw catalogRuntimeError("owner_required", 403);
}

async function appendAudit(tx, scope, aggregateId, eventType, operationKey, payload) {
  await tx.query(`insert into sagaops.pos_audit_events
    (organization_id,outlet_id,actor_reference,event_type,aggregate_type,aggregate_id,payload_redacted)
    values ($1,$2,$3,$4,'esb_catalog',$5,$6::jsonb)`,
  [scope.organizationId, scope.outletId, scope.actorReference ?? scope.actorUserId, eventType, aggregateId, JSON.stringify({ ...payload, operationKey })]);
}

async function auditReplay(tx, organizationId, operationKey, eventType) {
  const result = await tx.query(`select aggregate_id,payload_redacted from sagaops.pos_audit_events
    where organization_id=$1 and event_type=$2 and payload_redacted->>'operationKey'=$3 limit 1`, [organizationId, eventType, operationKey]);
  if (!result.rows[0]) return null;
  return { ...(result.rows[0].payload_redacted ?? {}), versionId: result.rows[0].aggregate_id };
}

function normalizePolicy(input) {
  return createPricingPolicyVersion({
    ...input, status: "DRAFT", currency: "IDR", timezone: input.timezone ?? "Asia/Jakarta",
    taxRateBps: Number(input.taxRateBps ?? 0), serviceRateBps: Number(input.serviceRateBps ?? 0),
    roundingStepRupiah: Number(input.roundingStepRupiah ?? 1),
  });
}

function normalizeDraftEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) throw catalogRuntimeError("catalog_entries_invalid", 422);
  const references = new Set();
  return entries.map((entry) => {
    const productReference = requiredText(entry.productReference, "catalog_product_reference_invalid", 120);
    if (references.has(productReference)) throw catalogRuntimeError("catalog_product_reference_duplicate", 422);
    references.add(productReference);
    const priceRupiah = rupiah(entry.priceRupiah, "price_book_entry_price_invalid");
    const freePriceEnabled = entry.freePriceEnabled === true;
    const minimumFreePriceRupiah = rupiah(entry.minimumFreePriceRupiah ?? priceRupiah, "free_price_minimum_invalid");
    const maximumFreePriceRupiah = rupiah(entry.maximumFreePriceRupiah ?? priceRupiah, "free_price_maximum_invalid");
    if (minimumFreePriceRupiah > maximumFreePriceRupiah || (!freePriceEnabled && (minimumFreePriceRupiah !== priceRupiah || maximumFreePriceRupiah !== priceRupiah))) throw catalogRuntimeError("free_price_bounds_invalid", 422);
    return { productReference, productName: requiredText(entry.productName, "catalog_product_name_invalid", 120), priceRupiah,
      freePriceEnabled, minimumFreePriceRupiah, maximumFreePriceRupiah, posEnabled: entry.posEnabled !== false };
  });
}

function assertOwnerCommand(command) {
  const scope = assertScope(command);
  if (command.role !== "owner") throw catalogRuntimeError("owner_required", 403);
  return scope;
}

function assertScope(value) {
  if (!value || typeof value !== "object") throw catalogRuntimeError("catalog_scope_required", 403);
  return {
    organizationId: requiredUuid(value.organizationId, "catalog_scope_invalid"),
    outletId: requiredUuid(value.outletId, "catalog_scope_invalid"),
    actorUserId: requiredUuid(value.actorUserId, "catalog_actor_invalid"),
    actorReference: value.actorReference == null ? null : requiredText(value.actorReference, "catalog_actor_invalid", 120),
  };
}

function requiredUuid(value, code) { const text = String(value ?? "").trim(); if (!UUID.test(text)) throw catalogRuntimeError(code, 422); return text; }
function requiredCode(value) { const code = String(value ?? "").trim().toUpperCase(); if (!CODE.test(code)) throw catalogRuntimeError("catalog_price_book_code_invalid", 422); return code; }
function requiredHash(value) { const hash = String(value ?? "").trim(); if (!/^[0-9a-f]{64}$/.test(hash)) throw catalogRuntimeError("catalog_draft_hash_invalid", 422); return hash; }
function requiredText(value, code, max) { const text = String(value ?? "").trim(); if (!text || text.length > max || /[<>\u0000-\u001f]/.test(text)) throw catalogRuntimeError(code, 422); return text; }
function rupiah(value, code) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw catalogRuntimeError(code, 422); return number; }
function numeric(value) { const number = Number(value); if (!Number.isSafeInteger(number)) throw catalogRuntimeError("catalog_numeric_unsafe", 503); return number; }
function validInstant(value, code) { const time = Date.parse(value); if (!Number.isFinite(time)) throw catalogRuntimeError(code, 422); return new Date(time).toISOString(); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function fingerprint(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value); }

function catalogRuntimeError(code, statusCode = 409) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
