import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadRuntimeMigrationManifest } from "./runtime-migration-manifest.mjs";

export const sagaOpsGoal1Migrations = (await loadRuntimeMigrationManifest()).entries.map(({ url }) => url);

function adaptForLocalHarness(migration, sql) {
  if (!migration.pathname.endsWith("20260622_sagaops_core_v1.sql")) return sql;
  return sql.replace(
    /^create extension if not exists pgcrypto;\s*$/mi,
    "-- Local PGlite harness: pgcrypto is not bundled; gen_random_uuid() is PostgreSQL core."
  );
}

export class SagaOpsLocalPostgresRuntime {
  constructor({ dataDir } = {}) {
    this.db = new PGlite(dataDir);
  }

  async start(migrations = sagaOpsGoal1Migrations) {
    await this.db.waitReady;
    await this.db.exec([
      "create schema if not exists auth;",
      "create table if not exists auth.users(id uuid primary key);",
      "do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;",
      "do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;",
      "do $$ begin create role \"sagaops-production\" nologin; exception when duplicate_object then null; end $$;",
      "create or replace function auth.uid()",
      "returns uuid language sql stable",
      "as $$ select nullif(current_setting('app.current_user_id', true), '')::uuid $$;"
    ].join("\n"));
    await this.db.exec([
      "create table if not exists public.sagaops_local_schema_migrations(",
      "name text primary key, applied_at timestamptz not null default now()",
      ");",
    ].join("\n"));
    const applied = [];
    const appliedNow = [];
    const alreadyApplied = [];
    for (const migration of migrations) {
      const name = migration.pathname.split("/").at(-1);
      const existing = await this.db.query("select name from public.sagaops_local_schema_migrations where name=$1", [name]);
      if (existing.rows[0]) {
        applied.push(name);
        alreadyApplied.push(name);
        continue;
      }
      const original = await readFile(migration, "utf8");
      await this.db.transaction(async (tx) => {
        await tx.exec(adaptForLocalHarness(migration, original));
        await tx.query("insert into public.sagaops_local_schema_migrations(name) values ($1)", [name]);
      });
      applied.push(name);
      appliedNow.push(name);
    }
    return {
      ready: true,
      migrations: applied,
      appliedNow,
      alreadyApplied,
      adaptations: ["pgcrypto_extension_declaration_skipped_locally_gen_random_uuid_core_used"],
      limitations: ["single_connection", "not_external_postgres", "not_staging_capacity_attestation"],
    };
  }

  query(sql, params = []) { return this.db.query(sql, params); }
  close() { return this.db.close(); }
}
