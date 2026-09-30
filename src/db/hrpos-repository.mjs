export class HrposRepository {
  constructor({ db, ids, clock = () => new Date() }) { this.db = db; this.ids = ids; this.clock = clock; }
  async saveFlow({ flowHash, stateHash, ciphertext, expiresAt }) {
    await this.db.transaction(async (tx) => {
      await tx.query("delete from sagaops.hrpos_flows where organization_id=$1 and outlet_id=$2 and expires_at <= $3", [this.ids.organizationId, this.ids.outletId, this.clock().toISOString()]);
      await tx.query("insert into sagaops.hrpos_flows(flow_hash,organization_id,outlet_id,state_hash,ciphertext,expires_at) values($1,$2,$3,$4,$5,$6)", [flowHash, this.ids.organizationId, this.ids.outletId, stateHash, ciphertext, expiresAt]);
    });
  }
  async consumeFlow(flowHash, stateHash) {
    const result = await this.db.query("delete from sagaops.hrpos_flows where flow_hash=$1 and state_hash=$2 and organization_id=$3 and outlet_id=$4 and expires_at>$5 returning ciphertext", [flowHash, stateHash, this.ids.organizationId, this.ids.outletId, this.clock().toISOString()]);
    return result.rows[0]?.ciphertext ?? null;
  }
  async saveSession(session, ciphertext, previousHash = null) {
    await this.db.transaction(async (tx) => {
      if (previousHash) {
        const previous = await tx.query("select session_hash from sagaops.hrpos_bridges where session_hash=$1 and organization_id=$2 and outlet_id=$3 and revoked_at is null and expires_at>$4 for update", [previousHash, this.ids.organizationId, this.ids.outletId, this.clock().toISOString()]);
        if (!previous.rows[0]) throw new Error("hrpos_session_invalid");
      }
      await tx.query("insert into sagaops.pos_http_sessions(token_hash,organization_id,outlet_id,kind,subject,csrf_token,created_at,expires_at) values($1,$2,$3,'operator',$4::jsonb,$5,$6,$7)", [session.tokenHash, this.ids.organizationId, this.ids.outletId, JSON.stringify(session.subject), session.csrfToken, session.createdAt, session.expiresAt]);
      await tx.query("insert into sagaops.hrpos_bridges(session_hash,organization_id,outlet_id,ciphertext,expires_at) values($1,$2,$3,$4,$5)", [session.tokenHash, this.ids.organizationId, this.ids.outletId, ciphertext, session.expiresAt]);
      if (previousHash) {
        await tx.query("delete from sagaops.hrpos_bridges where session_hash=$1 and organization_id=$2 and outlet_id=$3", [previousHash, this.ids.organizationId, this.ids.outletId]);
        await tx.query("delete from sagaops.pos_http_sessions where token_hash=$1 and organization_id=$2 and outlet_id=$3 and kind='operator'", [previousHash, this.ids.organizationId, this.ids.outletId]);
      }
    });
  }
  async getBridge(sessionHash) {
    const result = await this.db.query("select ciphertext,expires_at from sagaops.hrpos_bridges where session_hash=$1 and organization_id=$2 and outlet_id=$3 and revoked_at is null and expires_at>$4", [sessionHash, this.ids.organizationId, this.ids.outletId, this.clock().toISOString()]);
    return result.rows[0] ?? null;
  }
  async revokeLocal(sessionHash) {
    await this.db.transaction(async (tx) => {
      await tx.query("update sagaops.hrpos_bridges set revoked_at=$4,remote_revocation_pending=true where session_hash=$1 and organization_id=$2 and outlet_id=$3", [sessionHash, this.ids.organizationId, this.ids.outletId, this.clock().toISOString()]);
      await tx.query("delete from sagaops.pos_http_sessions where token_hash=$1 and organization_id=$2 and outlet_id=$3 and kind='operator'", [sessionHash, this.ids.organizationId, this.ids.outletId]);
    });
  }
  async confirmRevoked(sessionHash) {
    await this.db.query("delete from sagaops.hrpos_bridges where session_hash=$1 and organization_id=$2 and outlet_id=$3 and revoked_at is not null", [sessionHash, this.ids.organizationId, this.ids.outletId]);
  }
  async pendingRevocations(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("hrpos_limit_invalid");
    const result = await this.db.query("select session_hash,ciphertext,expires_at from sagaops.hrpos_bridges where organization_id=$1 and outlet_id=$2 and revoked_at is not null and remote_revocation_pending=true order by revoked_at limit $3", [this.ids.organizationId, this.ids.outletId, limit]);
    return result.rows;
  }
}
