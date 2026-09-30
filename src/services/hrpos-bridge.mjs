import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const roles = new Set(["hr", "owner", "cashier", "bar", "staff"]);

export class HrposBridge {
  #key;
  constructor({ client, repository, encryptionKey, clock = () => new Date(), syntheticLoopback = false }) {
    if (!client?.enabled || !Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || !repository) throw error("hrpos_configuration_invalid", 503);
    this.client = client; this.repository = repository; this.clock = clock; this.syntheticLoopback = syntheticLoopback;
    this.scope = client.scope();
    if (this.scope.posOrganizationId !== repository.ids.organizationId || new URL(this.scope.redirectUri).pathname !== "/hr/callback") throw error("hrpos_configuration_invalid", 503);
    this.#key = Buffer.from(encryptionKey);
    this.cookieName = syntheticLoopback ? "hrpos_flow_local" : "__Host-hrpos_flow";
    this.enabled = true;
  }
  async begin(role = "hr") {
    if (!roles.has(role)) throw error("hrpos_role_denied", 403);
    const flowSecret = randomBytes(32).toString("base64url");
    const flowHash = hash(flowSecret);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    await this.repository.saveFlow({ flowHash, stateHash: hash(state), ciphertext: this.#encrypt({ verifier, role }, `flow:${flowHash}`), expiresAt: new Date(this.clock().getTime() + 300000).toISOString() });
    return { flowSecret, redirectUrl: this.client.consentUrl({ state, codeChallenge, role: role === "staff" ? "staff" : "hr" }) };
  }
  async complete({ flowSecret, state, code, makeSession }) {
    if (![flowSecret, state, code].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value))) throw error("hrpos_flow_invalid", 401);
    const flowHash = hash(flowSecret);
    const ciphertext = await this.repository.consumeFlow(flowHash, hash(state));
    if (!ciphertext) throw error("hrpos_flow_invalid", 401);
    const flow = this.#decrypt(ciphertext, `flow:${flowHash}`);
    const exchange = await this.client.exchange({ code, codeVerifier: flow.verifier });
    try {
      const session = makeSession(this.#actor(exchange.identity, flow.role));
      session.expiresAt = new Date(this.clock().getTime() + exchange.expiresIn * 1000).toISOString();
      await this.repository.saveSession(session, this.#encrypt({ accessToken: exchange.accessToken }, `session:${session.tokenHash}`));
      return session;
    } catch (failure) {
      try { await this.client.revoke(exchange.accessToken); } catch { /* Orphan grant expires remotely; no POS session issued. */ }
      throw failure;
    }
  }
  async delegateOwner({ posOwnerAuthUserId, makeSession }) {
    let exchange;
    try {
      exchange = await this.client.delegateOwner(posOwnerAuthUserId);
      const session = makeSession(this.#actor(exchange.identity, "hr"));
      session.expiresAt = new Date(this.clock().getTime() + exchange.expiresIn * 1000).toISOString();
      await this.repository.saveSession(session, this.#encrypt({ accessToken: exchange.accessToken }, `session:${session.tokenHash}`));
      return session;
    } catch (failure) {
      if (exchange?.accessToken) {
        try { await this.client.revoke(exchange.accessToken); } catch { /* Delegated grant expires remotely. */ }
      }
      throw failure;
    }
  }
  async identity(sessionHash, role) {
    const { accessToken } = await this.#token(sessionHash);
    return this.#actor(await this.client.introspect(accessToken), role);
  }
  async command(sessionHash, operation, input) {
    const { accessToken } = await this.#token(sessionHash);
    return this.client.command(accessToken, operation, input);
  }
  async switchRole(sessionHash, role, makeSession) {
    const { accessToken, expiresAt } = await this.#token(sessionHash);
    const actor = this.#actor(await this.client.introspect(accessToken), role);
    const session = makeSession(actor);
    session.expiresAt = new Date(expiresAt).toISOString();
    await this.repository.saveSession(session, this.#encrypt({ accessToken }, `session:${session.tokenHash}`), sessionHash);
    return session;
  }
  async logout(sessionHash) {
    const bridge = await this.repository.getBridge(sessionHash);
    await this.repository.revokeLocal(sessionHash);
    if (!bridge) return { remoteRevoked: false };
    try {
      const { accessToken } = this.#decrypt(bridge.ciphertext, `session:${sessionHash}`);
      await this.client.revoke(accessToken);
      await this.repository.confirmRevoked(sessionHash);
      return { remoteRevoked: true };
    } catch { return { remoteRevoked: false }; }
  }
  async retryRevocations(limit = 20) {
    const rows = await this.repository.pendingRevocations(limit);
    let cleared = 0;
    for (const row of rows) {
      try {
        if (new Date(row.expires_at) > this.clock()) {
          const { accessToken } = this.#decrypt(row.ciphertext, `session:${row.session_hash}`);
          await this.client.revoke(accessToken);
        }
        await this.repository.confirmRevoked(row.session_hash);
        cleared++;
      } catch { /* Keep encrypted pending revocation for the next bounded run. */ }
    }
    return { examined: rows.length, cleared, pending: rows.length - cleared };
  }
  async #token(sessionHash) {
    const bridge = await this.repository.getBridge(sessionHash);
    if (!bridge) throw error("hrpos_session_invalid", 401);
    return { ...this.#decrypt(bridge.ciphertext, `session:${sessionHash}`), expiresAt: bridge.expires_at };
  }
  #actor(identity, role) {
    if (!roles.has(role) || !identity.roles.includes(role)) throw error("hrpos_role_denied", 403);
    if (role === "staff" && !identity.employeeId) throw error("hrpos_staff_binding_required", 403);
    const canWriteSwap = (specific) => [specific, "swap.own.write", "shift_swap.own.write", "schedule.own.write"].some((permission) => identity.permissions?.includes(permission));
    return { authProvider: "hrpos", role, roles: identity.roles, mode: { hr: "HR", owner: "DASHBOARD", cashier: "CASHIER", bar: "KDS", staff: "STAFF" }[role], displayName: "Akun kerja", employeeId: identity.employeeId, userAccountId: identity.userAccountId, membershipId: identity.membershipId,
      ...(role === "staff" ? { staffCapabilities: { scheduleRead: identity.permissions?.includes("schedule.own.read") === true, requestRead: identity.permissions?.includes("request.own.write") === true, swapCancel: canWriteSwap("swaps.own.cancel"), swapDecline: canWriteSwap("swaps.own.decline") } } : {}) };
  }
  #aad(context) { return Buffer.from(`${this.scope.clientId}:${this.scope.organizationId}:${this.scope.posOrganizationId}:${this.repository.ids.outletId}:${context}`); }
  #encrypt(value, context) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(this.#aad(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }
  #decrypt(value, context) {
    try {
      const [version, iv, tag, body, extra] = value.split(".");
      if (version !== "v1" || extra) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
      decipher.setAAD(this.#aad(context)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
    } catch { throw error("hrpos_storage_unavailable", 503); }
  }
}
function error(code, statusCode) { return Object.assign(new Error(code), { code, statusCode }); }
