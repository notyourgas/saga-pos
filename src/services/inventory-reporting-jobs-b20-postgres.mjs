import { createHmac, timingSafeEqual } from "node:crypto";

import {
  InventoryReportingJobError,
  inventoryReportingJobFingerprint,
  inventoryReportingJobQueryFingerprint,
  validateInventoryReportingJobState,
  validateInventoryReportingProjectionSnapshot,
} from "./inventory-reporting-jobs-b20.mjs";

export const INVENTORY_REPORTING_POSTGRES_PERSISTENCE_CONTRACT = "SAGAPOS_INVENTORY_REPORTING_POSTGRES_PERSISTENCE_V1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const STATUSES = ["PENDING", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "DEAD_LETTER", "INVALIDATED"];

export class InventoryReportingJobPostgresPersistence {
  constructor({ db, authority, integrityKey, clock = () => new Date().toISOString(), faultInjector = async () => {} } = {}) {
    if (!db?.query || !db?.transaction) throw failure("inventory_reporting_job_postgres_database_required");
    if (typeof integrityKey !== "string" || Buffer.byteLength(integrityKey.trim()) < 32) throw failure("inventory_reporting_job_integrity_key_invalid");
    if (typeof clock !== "function" || typeof faultInjector !== "function") throw failure("inventory_reporting_job_postgres_dependency_invalid");
    this.db = db;
    this.authority = normalizeAuthority(authority);
    this.integrityKey = integrityKey.trim();
    this.clock = clock;
    this.faultInjector = faultInjector;
    this.capabilities = Object.freeze({
      storageMode: "POSTGRESQL_TRANSACTIONAL",
      restartEvidence: "LOCAL_DISPOSABLE_DATABASE_ONLY",
      targetDurabilityStatus: "UNVERIFIED",
    });
  }

  async assertReady() {
    const tables = [
      "inventory_reporting_jobs",
      "inventory_reporting_job_events",
      "inventory_reporting_projections",
      "inventory_reporting_invalidations",
      "inventory_reporting_invalidation_jobs",
    ];
    const row = (await this.db.query(
      `select current_setting('row_security') row_security,
              bool_and(c.relrowsecurity and c.relforcerowsecurity) forced_rls,
              count(*)::integer table_count
         from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='sagaops' and c.relname=any($1::text[]) and c.relkind='r'
        group by current_setting('row_security')`,
      [tables],
    )).rows[0];
    if (!row || row.row_security !== "on" || row.forced_rls !== true || Number(row.table_count) !== tables.length) {
      throw failure("inventory_reporting_job_postgres_rls_not_ready");
    }
    const visible = (await this.db.query(
      `select count(*)::integer visible_count from sagaops.outlets
        where organization_id=$1 and id=any($2::uuid[])`,
      scopeParams(this.authority),
    )).rows[0];
    if (Number(visible?.visible_count) !== this.authority.outletIds.length) throw failure("inventory_reporting_job_postgres_scope_not_visible", 503);
    return Object.freeze({
      ready: true,
      contract: INVENTORY_REPORTING_POSTGRES_PERSISTENCE_CONTRACT,
      forcedRls: true,
      storageMode: this.capabilities.storageMode,
      targetDurabilityStatus: "UNVERIFIED",
    });
  }

  async createJob(rawJob) {
    const job = this.#scopedJob(rawJob);
    try {
      return await this.db.transaction(async (tx) => {
        await this.#insertJob(tx, job);
        await this.#insertEvent(tx, job);
        await this.faultInjector("before_inventory_reporting_job_create_commit", { transaction: tx, jobId: job.jobId });
        return clone(job);
      });
    } catch (error) {
      if (error?.code === "23505") throw failure("inventory_reporting_job_store_collision", 409);
      throw error;
    }
  }

  async findByCommandId(commandId) {
    const row = (await this.db.query(
      `select * from sagaops.inventory_reporting_jobs
        where organization_id=$1 and job_id=$2 and outlet_ids <@ $3::uuid[]`,
      [this.authority.organizationId, identifier(commandId), this.authority.outletIds],
    )).rows[0];
    return row ? this.#jobFromRow(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey) {
    const row = (await this.db.query(
      `select * from sagaops.inventory_reporting_jobs
        where organization_id=$1 and idempotency_key=$2 and outlet_ids <@ $3::uuid[]`,
      [this.authority.organizationId, identifier(idempotencyKey), this.authority.outletIds],
    )).rows[0];
    return row ? this.#jobFromRow(row) : null;
  }

  async claimDue({ workerId, now, limit, leaseMs, commandId = null } = {}) {
    const claimedBy = identifier(workerId);
    const claimedAt = instant(now);
    const batchSize = integer(limit, 1, 16);
    const leaseDuration = integer(leaseMs, 1_000, 15 * 60_000);
    const selectedCommand = commandId === null ? null : identifier(commandId);
    const expiresAt = addMs(claimedAt, leaseDuration);
    return this.db.transaction(async (tx) => {
      const exhaustedRows = (await tx.query(
        `select * from sagaops.inventory_reporting_jobs
          where organization_id=$1 and outlet_ids <@ $2::uuid[]
            and status='RUNNING' and lease_expires_at <= $3 and attempt_count >= max_attempts
            and ($4::text is null or job_id=$4)
          order by lease_expires_at,job_id for update skip locked`,
        [...scopeParams(this.authority), claimedAt, selectedCommand],
      )).rows;
      for (const row of exhaustedRows) {
        const current = this.#jobFromRow(row);
        const dead = {
          ...current,
          status: "DEAD_LETTER",
          completedAt: claimedAt,
          nextAttemptAt: null,
          lease: null,
          lastFailure: { code: "inventory_reporting_job_worker_lease_expired", retryable: false },
          revision: current.revision + 1,
          history: [...current.history, event("DEAD_LETTER", claimedAt, current.attemptCount, "inventory_reporting_job_worker_lease_expired")],
        };
        await this.#updateJob(tx, dead, current.revision);
      }

      const dueRows = (await tx.query(
        `select * from sagaops.inventory_reporting_jobs
          where organization_id=$1 and outlet_ids <@ $2::uuid[] and (
            (status in ('PENDING','RETRY_WAIT') and next_attempt_at <= $3)
            or (status='RUNNING' and lease_expires_at <= $3 and attempt_count < max_attempts)
          )
            and ($4::text is null or job_id=$4)
          order by case when status='RUNNING' then lease_expires_at else next_attempt_at end,job_id
          for update skip locked limit $5`,
        [...scopeParams(this.authority), claimedAt, selectedCommand, batchSize],
      )).rows;
      const jobs = [];
      for (const row of dueRows) {
        const current = this.#jobFromRow(row);
        const attemptCount = current.attemptCount + 1;
        const next = {
          ...current,
          status: "RUNNING",
          attemptCount,
          completedAt: null,
          nextAttemptAt: null,
          lease: { workerId: claimedBy, claimedAt, expiresAt },
          lastFailure: null,
          revision: current.revision + 1,
          history: [...current.history, event("RUNNING", claimedAt, attemptCount)],
        };
        jobs.push(await this.#updateJob(tx, next, current.revision));
      }
      await this.faultInjector("before_inventory_reporting_claim_commit", { transaction: tx, claimedCount: jobs.length });
      return jobs;
    });
  }

  async saveJob(rawJob, { expectedRevision, leaseWorkerId } = {}) {
    const job = this.#scopedJob(rawJob);
    const expected = integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER);
    const leaseOwner = identifier(leaseWorkerId);
    const persistedAt = instant(this.clock());
    if (job.revision !== expected + 1) throw failure("inventory_reporting_job_revision_conflict", 409);
    return this.db.transaction(async (tx) => {
      const row = (await tx.query(
        `select * from sagaops.inventory_reporting_jobs
          where organization_id=$1 and job_id=$2 and outlet_ids <@ $3::uuid[] for update`,
        [this.authority.organizationId, job.jobId, this.authority.outletIds],
      )).rows[0];
      if (!row) throw failure("inventory_reporting_job_revision_conflict", 409);
      const current = this.#jobFromRow(row);
      if (current.revision !== expected) throw failure("inventory_reporting_job_revision_conflict", 409);
      if (current.status !== "RUNNING" || current.lease?.workerId !== leaseOwner) throw failure("inventory_reporting_job_revision_conflict", 409);
      if (Date.parse(current.lease.expiresAt) <= Date.parse(persistedAt)) throw failure("inventory_reporting_job_lease_expired", 409);
      if (current.command.commandFingerprint !== job.command.commandFingerprint) throw failure("inventory_reporting_job_command_mutation", 409);
      if (!allowedTransition(current.status, job.status)) throw failure("inventory_reporting_job_transition_invalid", 409);
      const saved = await this.#updateJob(tx, job, expected);
      await this.faultInjector("before_inventory_reporting_job_save_commit", { transaction: tx, jobId: job.jobId, revision: job.revision });
      return saved;
    });
  }

  async saveProjection(input = {}) {
    exactKeys(input, ["commandFingerprint", "expectedJobRevision", "jobId", "leaseWorkerId", "projection", "projectionFingerprint", "queryFingerprint", "sourceFingerprint"]);
    const jobId = identifier(input.jobId);
    const expectedRevision = integer(input.expectedJobRevision, 1, Number.MAX_SAFE_INTEGER);
    const leaseWorkerId = identifier(input.leaseWorkerId);
    const commandFingerprint = digest(input.commandFingerprint);
    const queryFingerprint = digest(input.queryFingerprint);
    const sourceFingerprint = digest(input.sourceFingerprint);
    const projectionFingerprint = digest(input.projectionFingerprint);
    const projection = validateInventoryReportingProjectionSnapshot(input.projection, projectionFingerprint);
    const sourceReferences = collectSourceReferences(projection);
    const persistedAt = instant(this.clock());

    return this.db.transaction(async (tx) => {
      const jobRow = (await tx.query(
        `select * from sagaops.inventory_reporting_jobs
          where organization_id=$1 and job_id=$2 and outlet_ids <@ $3::uuid[] for update`,
        [this.authority.organizationId, jobId, this.authority.outletIds],
      )).rows[0];
      if (!jobRow) throw failure("inventory_reporting_job_revision_conflict", 409);
      const job = this.#jobFromRow(jobRow);
      if (job.revision !== expectedRevision || job.status !== "RUNNING" || job.lease?.workerId !== leaseWorkerId) {
        throw failure("inventory_reporting_job_revision_conflict", 409);
      }
      if (Date.parse(job.lease.expiresAt) <= Date.parse(persistedAt)) throw failure("inventory_reporting_job_lease_expired", 409);
      if (job.command.commandFingerprint !== commandFingerprint || job.command.queryFingerprint !== queryFingerprint || job.command.sourceFingerprint !== sourceFingerprint) {
        throw failure("inventory_reporting_job_projection_collision", 409);
      }
      const record = {
        organizationId: this.authority.organizationId,
        jobId,
        outletIds: job.command.query.outletIds,
        jobRevision: expectedRevision,
        commandFingerprint,
        queryFingerprint,
        sourceFingerprint,
        projectionFingerprint,
        projection,
        sourceReferences,
        persistedAt,
      };
      const existing = (await tx.query(
        `select * from sagaops.inventory_reporting_projections
          where organization_id=$1 and job_id=$2`,
        [this.authority.organizationId, jobId],
      )).rows[0];
      if (existing) {
        const stored = this.#projectionFromRow(existing);
        if (!sameProjection(stored, record)) throw failure("inventory_reporting_job_projection_collision", 409);
      } else {
        await tx.query(
          `insert into sagaops.inventory_reporting_projections
            (organization_id,job_id,outlet_ids,job_revision,command_fingerprint,query_fingerprint,source_fingerprint,projection_fingerprint,projection_document,projection_mac,source_references,persisted_at)
           values ($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12)`,
          [record.organizationId,record.jobId,record.outletIds,record.jobRevision,record.commandFingerprint,record.queryFingerprint,record.sourceFingerprint,record.projectionFingerprint,JSON.stringify(record.projection),this.#mac(projectionMacPayload(record)),JSON.stringify(record.sourceReferences),record.persistedAt],
        );
      }
      await this.faultInjector("before_inventory_reporting_projection_commit", { transaction: tx, jobId, expectedRevision });
      return Object.freeze({ resultRef: `inventory-reporting-projection:${jobId}`, projectionFingerprint });
    });
  }

  async invalidateAffected(input = {}) {
    exactKeys(input, ["changedAt", "detectedAt", "eventId", "organizationId", "outletId"]);
    const eventRecord = {
      eventId: identifier(input.eventId),
      organizationId: uuid(input.organizationId),
      outletId: uuid(input.outletId),
      changedAt: instant(input.changedAt),
      detectedAt: instant(input.detectedAt),
    };
    this.#assertScope(eventRecord.organizationId, [eventRecord.outletId]);
    const eventFingerprint = inventoryReportingJobFingerprint(eventRecord);
    return this.db.transaction(async (tx) => {
      const inserted = (await tx.query(
        `insert into sagaops.inventory_reporting_invalidations
          (organization_id,event_id,outlet_id,outlet_ids,event_fingerprint,changed_at,detected_at,event_document,event_mac)
         values ($1,$2,$3,array[$3]::uuid[],$4,$5,$6,$7::jsonb,$8)
         on conflict (organization_id,event_id) do nothing returning event_id`,
        [eventRecord.organizationId,eventRecord.eventId,eventRecord.outletId,eventFingerprint,eventRecord.changedAt,eventRecord.detectedAt,JSON.stringify(eventRecord),this.#mac(eventRecord)],
      )).rows[0];
      if (!inserted) {
        const existing = (await tx.query(
          `select * from sagaops.inventory_reporting_invalidations where organization_id=$1 and event_id=$2`,
          [eventRecord.organizationId,eventRecord.eventId],
        )).rows[0];
        this.#verifyInvalidation(existing, eventRecord, eventFingerprint);
        const count = (await tx.query(
          `select count(*)::integer count from sagaops.inventory_reporting_invalidation_jobs
            where organization_id=$1 and event_id=$2`,
          [eventRecord.organizationId,eventRecord.eventId],
        )).rows[0];
        return { invalidatedCount: Number(count?.count ?? 0) };
      }

      const rows = (await tx.query(
        `select * from sagaops.inventory_reporting_jobs
          where organization_id=$1 and outlet_ids @> array[$2]::uuid[]
            and status='SUCCEEDED' and period_end_utc > $3
          order by job_id for update`,
        [eventRecord.organizationId,eventRecord.outletId,eventRecord.changedAt],
      )).rows;
      for (const row of rows) {
        const current = this.#jobFromRow(row);
        const invalidated = {
          ...current,
          status: "INVALIDATED",
          completedAt: eventRecord.detectedAt,
          revision: current.revision + 1,
          history: [...current.history, event("INVALIDATED", eventRecord.detectedAt, current.attemptCount, "BACKDATED_CHANGE")],
        };
        await this.#updateJob(tx, invalidated, current.revision);
        await tx.query(
          `insert into sagaops.inventory_reporting_invalidation_jobs
            (organization_id,event_id,job_id,outlet_ids,invalidated_revision,invalidated_at)
           values ($1,$2,$3,$4::uuid[],$5,$6)`,
          [eventRecord.organizationId,eventRecord.eventId,current.jobId,current.command.query.outletIds,invalidated.revision,eventRecord.detectedAt],
        );
      }
      await this.faultInjector("before_inventory_reporting_invalidation_commit", { transaction: tx, eventId: eventRecord.eventId, invalidatedCount: rows.length });
      return { invalidatedCount: rows.length };
    });
  }

  async metrics({ now = this.clock(), expectedQueryFingerprint = null } = {}) {
    const observedAt = instant(now);
    const expectedQuery = expectedQueryFingerprint === null ? null : digest(expectedQueryFingerprint);
    const aggregate = await this.db.query(
      `select status,count(*)::integer count,coalesce(sum(attempt_count),0)::integer attempt_count
         from sagaops.inventory_reporting_jobs
        where organization_id=$1 and outlet_ids <@ $2::uuid[] group by status`,
      scopeParams(this.authority),
    );
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    let attemptCount = 0;
    for (const row of aggregate.rows) {
      if (!STATUSES.includes(row.status)) throw failure("inventory_reporting_job_persisted_state_invalid");
      counts[row.status] = Number(row.count);
      attemptCount += Number(row.attempt_count);
    }
    const operational = (await this.db.query(
      `select
         count(*) filter (where status='RUNNING' and lease_expires_at <= $3)::integer expired_lease_count,
         min(case when status in ('PENDING','RETRY_WAIT') then next_attempt_at when status='RUNNING' then lease_expires_at end) oldest_due_at,
         (select count(*)::integer from sagaops.inventory_reporting_projections p
            join sagaops.inventory_reporting_jobs pj on pj.organization_id=p.organization_id and pj.job_id=p.job_id
           where p.organization_id=$1 and p.outlet_ids <@ $2::uuid[] and pj.status='SUCCEEDED'
             and ($4::text is null or p.query_fingerprint=$4)) projection_count,
         (select max(p.persisted_at) from sagaops.inventory_reporting_projections p
            join sagaops.inventory_reporting_jobs pj on pj.organization_id=p.organization_id and pj.job_id=p.job_id
           where p.organization_id=$1 and p.outlet_ids <@ $2::uuid[] and pj.status='SUCCEEDED'
             and ($4::text is null or p.query_fingerprint=$4)) latest_projection_at,
         (select count(*)::integer from sagaops.inventory_reporting_invalidations i where i.organization_id=$1 and i.outlet_ids <@ $2::uuid[]) invalidation_count
       from sagaops.inventory_reporting_jobs j
      where j.organization_id=$1 and j.outlet_ids <@ $2::uuid[]`,
      [...scopeParams(this.authority), observedAt, expectedQuery],
    )).rows[0];
    return Object.freeze({
      counts: Object.freeze(counts),
      attemptCount,
      expiredLeaseCount: Number(operational?.expired_lease_count ?? 0),
      oldestDueAt: operational?.oldest_due_at ? instant(operational.oldest_due_at) : null,
      projectionCount: Number(operational?.projection_count ?? 0),
      latestProjectionAt: operational?.latest_projection_at ? instant(operational.latest_projection_at) : null,
      invalidationCount: Number(operational?.invalidation_count ?? 0),
      storageMode: this.capabilities.storageMode,
      targetDurabilityStatus: "UNVERIFIED",
    });
  }

  async health(options = {}) {
    const metrics = await this.metrics(options);
    return Object.freeze({
      contract: "SAGAPOS_INVENTORY_REPORTING_POSTGRES_HEALTH_V1",
      status: metrics.counts.DEAD_LETTER > 0 || metrics.expiredLeaseCount > 0 ? "DEGRADED" : "HEALTHY",
      queue: Object.freeze({ pending: metrics.counts.PENDING, retryWait: metrics.counts.RETRY_WAIT, running: metrics.counts.RUNNING, deadLetter: metrics.counts.DEAD_LETTER, expiredLease: metrics.expiredLeaseCount }),
      storageMode: this.capabilities.storageMode,
      sourceRuntimeStatus: "UNVERIFIED",
      targetDurabilityStatus: "UNVERIFIED",
      deploymentStatus: "IMPLEMENTED_NOT_DEPLOYED",
    });
  }

  async getProjection(jobId, { includeInvalidated = false } = {}) {
    const row = (await this.db.query(
      `select p.* from sagaops.inventory_reporting_projections p
        join sagaops.inventory_reporting_jobs j on j.organization_id=p.organization_id and j.job_id=p.job_id
       where p.organization_id=$1 and p.job_id=$2 and p.outlet_ids <@ $3::uuid[]
         and (j.status='SUCCEEDED' or ($4::boolean and j.status='INVALIDATED'))`,
      [this.authority.organizationId,identifier(jobId),this.authority.outletIds,Boolean(includeInvalidated)],
    )).rows[0];
    return row ? clone(this.#projectionFromRow(row).projection) : null;
  }

  async readLatestProjection({ queryFingerprint } = {}) {
    const row = (await this.db.query(
      `select p.* from sagaops.inventory_reporting_projections p
        join sagaops.inventory_reporting_jobs j on j.organization_id=p.organization_id and j.job_id=p.job_id
       where p.organization_id=$1 and p.query_fingerprint=$2 and p.outlet_ids <@ $3::uuid[] and j.status='SUCCEEDED'
       order by p.persisted_at desc,p.job_id desc limit 1`,
      [this.authority.organizationId,digest(queryFingerprint),this.authority.outletIds],
    )).rows[0];
    return row ? clone(this.#projectionFromRow(row).projection) : null;
  }

  async #insertJob(tx, job) {
    const row = jobRow(job, this.#mac(job));
    await tx.query(
      `insert into sagaops.inventory_reporting_jobs
        (organization_id,job_id,idempotency_key,command_fingerprint,query_fingerprint,source_fingerprint,outlet_ids,period_start_utc,period_end_utc,snapshot_cutoff_utc,max_attempts,status,attempt_count,next_attempt_at,completed_at,lease_worker_id,lease_claimed_at,lease_expires_at,lease_fence,projection_fingerprint,result_ref,revision,state_document,state_mac,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26)`,
      row,
    );
  }

  async #updateJob(tx, rawJob, expectedRevision) {
    const job = this.#scopedJob(rawJob);
    const stateMac = this.#mac(job);
    const params = [
      this.authority.organizationId,job.jobId,job.status,job.attemptCount,job.nextAttemptAt,job.completedAt,
      job.lease?.workerId ?? null,job.lease?.claimedAt ?? null,job.lease?.expiresAt ?? null,
      job.status === "RUNNING" ? job.revision : null,job.projectionFingerprint,job.resultRef,job.revision,
      JSON.stringify(job),stateMac,job.history.at(-1).at,expectedRevision,
    ];
    const updated = (await tx.query(
      `update sagaops.inventory_reporting_jobs set
         status=$3,attempt_count=$4,next_attempt_at=$5,completed_at=$6,
         lease_worker_id=$7,lease_claimed_at=$8,lease_expires_at=$9,lease_fence=$10,
         projection_fingerprint=$11,result_ref=$12,revision=$13,state_document=$14::jsonb,state_mac=$15,updated_at=$16
       where organization_id=$1 and job_id=$2 and revision=$17
       returning revision`,
      params,
    )).rows[0];
    if (Number(updated?.revision) !== job.revision) throw failure("inventory_reporting_job_revision_conflict", 409);
    await this.#insertEvent(tx, job);
    return clone(job);
  }

  async #insertEvent(tx, job) {
    const last = job.history.at(-1);
    const document = { organizationId: job.command.query.organizationId, jobId: job.jobId, revision: job.revision, ...last };
    await tx.query(
      `insert into sagaops.inventory_reporting_job_events
        (organization_id,job_id,revision,outlet_ids,status,attempt_count,failure_code,occurred_at,event_document,event_mac)
       values ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9::jsonb,$10)`,
      [this.authority.organizationId,job.jobId,job.revision,job.command.query.outletIds,last.status,last.attemptCount,last.failureCode,last.at,JSON.stringify(document),this.#mac(document)],
    );
  }

  #scopedJob(rawJob) {
    const job = validateInventoryReportingJobState(rawJob);
    this.#assertScope(job.command.query.organizationId, job.command.query.outletIds);
    return job;
  }

  #assertScope(organizationId, outletIds) {
    if (uuid(organizationId) !== this.authority.organizationId) throw failure("inventory_reporting_job_scope_mismatch", 403);
    const allowed = new Set(this.authority.outletIds);
    if (!Array.isArray(outletIds) || outletIds.some((outletId) => !allowed.has(uuid(outletId)))) throw failure("inventory_reporting_job_scope_mismatch", 403);
  }

  #jobFromRow(row) {
    const job = jsonObject(row.state_document, "inventory_reporting_job_persisted_state_invalid");
    this.#verifyMac(job, row.state_mac, "inventory_reporting_job_persisted_state_tampered");
    const normalized = this.#scopedJob(job);
    const query = normalized.command.query;
    if (row.organization_id !== query.organizationId || row.job_id !== normalized.jobId || row.idempotency_key !== normalized.command.idempotencyKey ||
        row.command_fingerprint !== normalized.command.commandFingerprint || row.query_fingerprint !== normalized.command.queryFingerprint || row.source_fingerprint !== normalized.command.sourceFingerprint ||
        canonical(row.outlet_ids) !== canonical(query.outletIds) || instant(row.period_start_utc) !== query.periodStartUtc || instant(row.period_end_utc) !== query.periodEndUtc ||
        instant(row.snapshot_cutoff_utc) !== query.snapshotCutoffUtc || Number(row.max_attempts) !== normalized.command.policy.maxAttempts || row.status !== normalized.status ||
        Number(row.attempt_count) !== normalized.attemptCount || Number(row.revision) !== normalized.revision || nullableIso(row.next_attempt_at) !== normalized.nextAttemptAt ||
        nullableIso(row.completed_at) !== normalized.completedAt || nullable(row.lease_worker_id) !== nullable(normalized.lease?.workerId) || nullableIso(row.lease_claimed_at) !== nullable(normalized.lease?.claimedAt) ||
        nullableIso(row.lease_expires_at) !== nullable(normalized.lease?.expiresAt) || nullableNumber(row.lease_fence) !== (normalized.status === "RUNNING" ? normalized.revision : null) ||
        nullable(row.projection_fingerprint) !== normalized.projectionFingerprint || nullable(row.result_ref) !== normalized.resultRef) {
      throw failure("inventory_reporting_job_persisted_state_invalid");
    }
    return normalized;
  }

  #projectionFromRow(row) {
    const record = {
      organizationId: row.organization_id,
      jobId: row.job_id,
      outletIds: row.outlet_ids,
      jobRevision: Number(row.job_revision),
      commandFingerprint: row.command_fingerprint,
      queryFingerprint: row.query_fingerprint,
      sourceFingerprint: row.source_fingerprint,
      projectionFingerprint: row.projection_fingerprint,
      projection: jsonObject(row.projection_document, "inventory_reporting_job_projection_invalid"),
      sourceReferences: jsonArray(row.source_references, "inventory_reporting_job_projection_invalid"),
      persistedAt: instant(row.persisted_at),
    };
    this.#assertScope(record.organizationId, record.outletIds);
    this.#verifyMac(projectionMacPayload(record), row.projection_mac, "inventory_reporting_job_projection_tampered");
    validateInventoryReportingProjectionSnapshot(record.projection, record.projectionFingerprint);
    if (canonical(collectSourceReferences(record.projection)) !== canonical(record.sourceReferences)) throw failure("inventory_reporting_job_projection_tampered");
    return record;
  }

  #verifyInvalidation(row, expected, fingerprint) {
    if (!row) throw failure("inventory_reporting_job_invalidation_collision", 409);
    const document = jsonObject(row.event_document, "inventory_reporting_job_invalidation_tampered");
    this.#verifyMac(document, row.event_mac, "inventory_reporting_job_invalidation_tampered");
    if (row.organization_id !== expected.organizationId || row.event_id !== expected.eventId || row.outlet_id !== expected.outletId ||
        instant(row.changed_at) !== expected.changedAt || instant(row.detected_at) !== expected.detectedAt ||
        row.event_fingerprint !== fingerprint || canonical(document) !== canonical(expected)) throw failure("inventory_reporting_job_invalidation_collision", 409);
  }

  #mac(value) { return createHmac("sha256", this.integrityKey).update(canonical(value)).digest("hex"); }
  #verifyMac(value, actual, code) {
    const expected = this.#mac(value);
    if (typeof actual !== "string" || !DIGEST.test(actual) || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) throw failure(code);
  }
}

export function inventoryReportingWorkerConfigFromEnv(env = process.env) {
  const enabled = env.SAGAPOS_INVENTORY_REPORTING_WORKER_ENABLED === "true";
  return Object.freeze({
    enabled,
    workerId: identifier(env.SAGAPOS_INVENTORY_REPORTING_WORKER_ID ?? "inventory-reporting-worker"),
    intervalMs: optionalInteger(env.SAGAPOS_INVENTORY_REPORTING_WORKER_INTERVAL_MS, 5_000, 1_000, 15 * 60_000),
    batchSize: optionalInteger(env.SAGAPOS_INVENTORY_REPORTING_WORKER_BATCH_SIZE, 2, 1, 16),
  });
}

export function createInventoryReportingPersistedProjectionRuntimeAdapter({ persistence, sourceAdapter } = {}) {
  if (!persistence?.readLatestProjection || !persistence?.assertReady || !sourceAdapter?.resolveSourceReference || !sourceAdapter?.assertReady) {
    throw failure("inventory_reporting_persisted_runtime_dependency_invalid");
  }
  let stopped = false;
  return Object.freeze({
    async assertReady(input = {}) {
      if (stopped) throw failure("inventory_reporting_persisted_runtime_stopped", 503);
      const [projectionStore, source] = await Promise.all([persistence.assertReady(), sourceAdapter.assertReady(input)]);
      if (projectionStore?.ready !== true || source?.ready !== true) throw failure("inventory_reporting_persisted_runtime_not_ready", 503);
      return Object.freeze({
        ready: true,
        projectionStorageMode: projectionStore.storageMode,
        targetDurabilityStatus: "UNVERIFIED",
        sourceAuthorityReady: true,
      });
    },
    async readProjection(input = {}) {
      if (stopped) throw failure("inventory_reporting_persisted_runtime_stopped", 503);
      exactKeys(input, ["query"]);
      const queryFingerprint = inventoryReportingJobQueryFingerprint(input.query);
      const projection = await persistence.readLatestProjection({ queryFingerprint });
      if (!projection) throw failure("inventory_reporting_projection_not_found", 404);
      return validateInventoryReportingProjectionSnapshot(projection);
    },
    async resolveSourceReference(input = {}) {
      if (stopped) throw failure("inventory_reporting_persisted_runtime_stopped", 503);
      exactKeys(input, ["expectedSourceFingerprint", "query", "sourceRef"]);
      const queryFingerprint = inventoryReportingJobQueryFingerprint(input.query);
      const projection = await persistence.readLatestProjection({ queryFingerprint });
      if (!projection) throw failure("inventory_reporting_projection_not_found", 404);
      validateInventoryReportingProjectionSnapshot(projection);
      const expectedSourceFingerprint = digest(input.expectedSourceFingerprint);
      if (projection.sourceFingerprint !== expectedSourceFingerprint) throw failure("inventory_reporting_source_changed", 409);
      const sourceRef = normalizeSourceReference(input.sourceRef);
      if (!collectSourceReferences(projection).some((entry) => canonical(entry) === canonical(sourceRef))) {
        throw failure("inventory_reporting_source_reference_not_found", 404);
      }
      return sourceAdapter.resolveSourceReference({ query: clone(input.query), sourceRef, expectedSourceFingerprint });
    },
    async shutdown() {
      if (stopped) return Object.freeze({ stopped: true, idempotent: true });
      stopped = true;
      if (typeof sourceAdapter.shutdown === "function") await sourceAdapter.shutdown();
      if (typeof persistence.shutdown === "function") await persistence.shutdown();
      return Object.freeze({ stopped: true, idempotent: false });
    },
  });
}

function jobRow(job, stateMac) {
  const q = job.command.query;
  return [q.organizationId,job.jobId,job.command.idempotencyKey,job.command.commandFingerprint,job.command.queryFingerprint,job.command.sourceFingerprint,q.outletIds,q.periodStartUtc,q.periodEndUtc,q.snapshotCutoffUtc,job.command.policy.maxAttempts,job.status,job.attemptCount,job.nextAttemptAt,job.completedAt,job.lease?.workerId ?? null,job.lease?.claimedAt ?? null,job.lease?.expiresAt ?? null,job.status === "RUNNING" ? job.revision : null,job.projectionFingerprint,job.resultRef,job.revision,JSON.stringify(job),stateMac,job.command.requestedAt,job.history.at(-1).at];
}
function projectionMacPayload(record) { return { organizationId: record.organizationId, jobId: record.jobId, outletIds: record.outletIds, jobRevision: record.jobRevision, commandFingerprint: record.commandFingerprint, queryFingerprint: record.queryFingerprint, sourceFingerprint: record.sourceFingerprint, projectionFingerprint: record.projectionFingerprint, projection: record.projection, sourceReferences: record.sourceReferences, persistedAt: record.persistedAt }; }
function sameProjection(stored, candidate) { return stored.organizationId === candidate.organizationId && stored.jobId === candidate.jobId && stored.commandFingerprint === candidate.commandFingerprint && stored.queryFingerprint === candidate.queryFingerprint && stored.sourceFingerprint === candidate.sourceFingerprint && stored.projectionFingerprint === candidate.projectionFingerprint && canonical(stored.projection) === canonical(candidate.projection) && canonical(stored.sourceReferences) === canonical(candidate.sourceReferences); }
function collectSourceReferences(value) {
  const refs = new Map();
  visit(value);
  return [...refs.values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  function visit(candidate) {
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return; }
    if (!candidate || typeof candidate !== "object") return;
    if (typeof candidate.type === "string" && typeof candidate.id === "string" && Object.hasOwn(candidate, "lineId")) {
      try {
        const ref = { type: identifier(candidate.type), id: identifier(candidate.id), lineId: candidate.lineId === null ? null : identifier(candidate.lineId) };
        refs.set(canonical(ref), ref);
      } catch { /* Non-reference report rows are ignored. */ }
    }
    for (const item of Object.values(candidate)) visit(item);
  }
}
function normalizeSourceReference(value) {
  exactKeys(value, ["id", "lineId", "type"]);
  return { type: identifier(value.type), id: identifier(value.id), lineId: value.lineId === null ? null : identifier(value.lineId) };
}
function normalizeAuthority(input = {}) {
  exactKeys(input, ["organizationId", "outletIds"]);
  if (!Array.isArray(input.outletIds) || input.outletIds.length < 1 || input.outletIds.length > 1_000) throw failure("inventory_reporting_job_scope_invalid");
  const organizationId = uuid(input.organizationId);
  const outletIds = [...new Set(input.outletIds.map(uuid))].sort();
  if (outletIds.length !== input.outletIds.length) throw failure("inventory_reporting_job_scope_invalid");
  return Object.freeze({ organizationId, outletIds: Object.freeze(outletIds) });
}
function allowedTransition(from, to) { return (from === "RUNNING" && ["SUCCEEDED", "RETRY_WAIT", "DEAD_LETTER"].includes(to)) || (from === "SUCCEEDED" && to === "INVALIDATED"); }
function event(status, at, attemptCount, failureCode = null) { return { status, at, attemptCount, failureCode }; }
function scopeParams(authority) { return [authority.organizationId, authority.outletIds]; }
function optionalInteger(value, fallback, min, max) { if (value === undefined || value === "") return fallback; const parsed = Number(value); return integer(parsed, min, max); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("inventory_reporting_job_postgres_input_invalid", 422); return value; }
function identifier(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw failure("inventory_reporting_job_postgres_input_invalid", 422); return value; }
function uuid(value) { if (typeof value !== "string" || !UUID.test(value)) throw failure("inventory_reporting_job_scope_invalid", 422); return value.toLowerCase(); }
function digest(value) { if (typeof value !== "string" || !DIGEST.test(value)) throw failure("inventory_reporting_job_postgres_input_invalid", 422); return value; }
function instant(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw failure("inventory_reporting_job_postgres_input_invalid", 422); return date.toISOString(); }
function nullableIso(value) { return value === null || value === undefined ? null : instant(value); }
function nullable(value) { return value === null || value === undefined ? null : value; }
function nullableNumber(value) { return value === null || value === undefined ? null : Number(value); }
function addMs(value, milliseconds) { return new Date(Date.parse(value) + milliseconds).toISOString(); }
function exactKeys(value, keys) { if (!value || typeof value !== "object" || Array.isArray(value) || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw failure("inventory_reporting_job_postgres_input_invalid", 422); }
function jsonObject(value, code) { const parsed = typeof value === "string" ? JSON.parse(value) : clone(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure(code); return parsed; }
function jsonArray(value, code) { const parsed = typeof value === "string" ? JSON.parse(value) : clone(value); if (!Array.isArray(parsed)) throw failure(code); return parsed; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function clone(value) { return structuredClone(value); }
function failure(code, statusCode = 500) { const error = new InventoryReportingJobError(code); error.statusCode = statusCode; return error; }
