import { teamError } from '../services/team-access-catalog.mjs';

export function createTeamAccessPostgresStore({ db, organizationId }) {
  return {
    kind:'POSTGRES',
    async read() {
      const row = (await db.query('select state from sagaops.team_access_state where organization_id=$1', [organizationId])).rows[0];
      if (!row) throw teamError('team_not_initialized', 503);
      return structuredClone(row.state);
    },
    async initialize(state) {
      await db.transaction(async tx=>{
        const inserted=await tx.query('insert into sagaops.team_access_state(organization_id,state) values($1,$2::jsonb) on conflict(organization_id) do nothing returning organization_id', [organizationId, JSON.stringify(state)]);
        if(inserted.rows.length)await tx.query('insert into sagaops.team_access_audit(organization_id,revision,event) values($1,$2,$3::jsonb)',[organizationId,state.revision,JSON.stringify({operation:'owner.bootstrap',actorId:state.accounts?.[0]?.id})]);
      });
      return this.read();
    },
    async mutate(expectedRevision, work) {
      return db.transaction(async tx => {
        const row = (await tx.query('select state from sagaops.team_access_state where organization_id=$1 for update', [organizationId])).rows[0];
        if (!row) throw teamError('team_not_initialized', 503);
        const state = structuredClone(row.state);
        if (state.revision !== expectedRevision) throw teamError('team_revision_conflict', 409);
        const { result, event } = await work(state);
        state.revision++;
        await tx.query('update sagaops.team_access_state set state=$2::jsonb where organization_id=$1', [organizationId, JSON.stringify(state)]);
        await tx.query('insert into sagaops.team_access_audit(organization_id,revision,event) values($1,$2,$3::jsonb)', [organizationId, state.revision, JSON.stringify(event)]);
        return { ...result, revision: state.revision };
      });
    },
    async audit() {
      return (await db.query('select revision,event,created_at from sagaops.team_access_audit where organization_id=$1 order by revision desc limit 100', [organizationId])).rows;
    },
    async guard(work) {
      return db.transaction(async tx => {
        const row = (await tx.query('select state from sagaops.team_access_state where organization_id=$1 for share', [organizationId])).rows[0];
        if (!row) throw teamError('team_not_initialized', 503);
        return work(structuredClone(row.state));
      });
    },
  };
}

// Explicit synthetic adapter for bounded local tests; never selected by production.
export function createTeamAccessMemoryStore() {
  let value; const events = []; let tail = Promise.resolve();
  return {
    kind:'MEMORY_SYNTHETIC',
    async read() { if (!value) throw teamError('team_not_initialized', 503); return structuredClone(value); },
    async initialize(state) { if(!value){value=structuredClone(state);events.push({revision:state.revision,event:{operation:'owner.bootstrap',actorId:state.accounts?.[0]?.id}});} return this.read(); },
    mutate(revision, work) {
      const result = tail.then(async () => {
        const draft = await this.read();
        if (draft.revision !== revision) throw teamError('team_revision_conflict', 409);
        const { result, event } = await work(draft); draft.revision++; value = draft;
        events.unshift({ revision: draft.revision, event }); return { ...result, revision: draft.revision };
      }); tail = result.catch(() => {}); return result;
    },
    async audit() { return structuredClone(events.slice(0, 100)); },
    guard(work) { const result = tail.then(async () => work(await this.read())); tail = result.catch(() => {}); return result; },
  };
}
