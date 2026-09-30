// Synthetic acceptance tooling, never an operational database selector.
export function resolveJointProfile(config, runId) {
  const fail = () => { throw new Error("joint_configuration_invalid"); };
  if (!config || ![1, 2].includes(config.version)) fail();
  const m2 = config.version === 2;
  const port = m2 ? 4814 : 4813;
  const workforcePort = m2 ? 3379 : 3377;
  if (config.posOrigin !== `http://127.0.0.1:${port}` || config.workforceOrigin !== `http://127.0.0.1:${workforcePort}` || config.redirectUri !== `${config.posOrigin}/hr/callback`) fail();
  // New M2 runs must be explicit: never silently fall back to the historical DB.
  if (m2 ? typeof runId !== "string" || !/^[a-f0-9]{12}$/.test(runId) : runId !== undefined) fail();
  return Object.freeze({ port, workforcePort, database: m2 ? `sagaops_hrpos_test_${runId}` : "sagaops_hrpos_joint_20260906", runId: m2 ? runId : null });
}

export async function bindJointDatabase(db, profile, handoffDigest) {
  const fail = () => { throw new Error("joint_database_scope_invalid"); };
  if (!profile.runId || !/^[a-f0-9]{12}$/.test(profile.runId) || profile.database !== `sagaops_hrpos_test_${profile.runId}` || !/^[a-f0-9]{64}$/.test(handoffDigest)) fail();
  await db.transaction(async (tx) => {
    if ((await tx.query("select current_database() as name")).rows[0]?.name !== profile.database) fail();
    // Serialize first boot/restart before deciding whether a database is fresh.
    await tx.query("select pg_advisory_xact_lock(4814, 3379)");
    const marker = (await tx.query("select to_regclass('public.hrpos_joint_identity') as marker")).rows[0]?.marker;
    if (marker) {
      const rows = (await tx.query("select run_id, handoff_digest from public.hrpos_joint_identity")).rows;
      if (rows.length !== 1 || rows[0].run_id !== profile.runId || rows[0].handoff_digest !== handoffDigest) fail();
      return;
    }
    // A pristine template0 DB has only public/system namespaces. Reject old
    // tables, functions, extensions or schemas before any application migration.
    const occupied = (await tx.query(`select
      exists(select 1 from pg_namespace where nspname <> 'public' and nspname <> 'information_schema' and nspname !~ '^pg_')
      or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')
      or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
      or exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public')
      or exists(select 1 from pg_extension where extname <> 'plpgsql') as occupied`)).rows[0]?.occupied;
    if (occupied !== false) fail();
    await tx.query("create table public.hrpos_joint_identity (singleton boolean primary key default true check(singleton), run_id text not null, handoff_digest text not null)");
    await tx.query("insert into public.hrpos_joint_identity(run_id,handoff_digest) values($1,$2)", [profile.runId, handoffDigest]);
  });
}
