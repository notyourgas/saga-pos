import { createHash, createHmac, randomBytes } from "node:crypto";
import { ownRequestOperations, ownRequestInput, ownRequestData } from "./hrpos-staff-requests.mjs";

const operations = new Set(["people.list", "people.get", "people.create", "people.update", "people.credentials", "people.resetAccess", "people.lifecycle", "workspaces.list", "settings.get", "locations.create", "locations.update", "locations.resolveMaps", "shiftTemplates.list", "shiftTemplates.create", "shiftTemplates.status", "schedules.list", "schedules.options", "schedules.create", "schedules.publish", "swaps.pending", "swaps.review", "staff.home", "requests.list", "requests.review", "requests.create", "attendance.exceptions", "corrections.list", "reports.workHours", "payroll.periods"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class HrposClient {
  #config;
  constructor({ enabled = false, baseUrl, clientId, secret, organizationId, posOrganizationId, redirectUri, grants = [], syntheticLoopback = false, fetchImpl = fetch, clock = () => new Date(), timeoutMs = 5000 } = {}) {
    this.enabled = enabled === true;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    if (!this.enabled) return;
    const base = trustedUrl(baseUrl, syntheticLoopback);
    const redirect = trustedUrl(redirectUri, syntheticLoopback);
    if (base.pathname !== "/" || !/^[a-z0-9_-]{1,80}$/.test(clientId ?? "") || typeof secret !== "string" || secret.length < 32 || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(organizationId ?? "") || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(posOrganizationId ?? "") || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || !Array.isArray(grants)) throw failure("hrpos_configuration_invalid", 503);
    if (grants.some((grant) => !grant?.userAccountId || !grant?.membershipId || !["hr", "owner", "cashier", "bar", "staff"].includes(grant.role))) throw failure("hrpos_grant_configuration_invalid", 503);
    this.#config = { origin: base.origin, clientId, secret, organizationId, posOrganizationId, redirectUri: redirect.href, grants: structuredClone(grants) };
  }

  consentUrl({ state, codeChallenge, role = "hr" }) {
    this.#enabled();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state ?? "") || !tokenPattern.test(codeChallenge ?? "") || !["hr", "staff"].includes(role)) throw failure("hrpos_flow_invalid", 422);
    const url = new URL("/integrations/pos/authorize", this.#config.origin);
    url.search = new URLSearchParams({ clientId: this.#config.clientId, redirectUri: this.#config.redirectUri, state, codeChallenge, role }).toString();
    return url.href;
  }

  scope() {
    this.#enabled();
    const { clientId, organizationId, posOrganizationId, redirectUri } = this.#config;
    return { clientId, organizationId, posOrganizationId, redirectUri };
  }

  async exchange({ code, codeVerifier }) {
    this.#enabled();
    if (!tokenPattern.test(code ?? "") || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier ?? "")) throw failure("hrpos_flow_invalid", 422);
    const data = await this.#request("token", { code, codeVerifier, redirectUri: this.#config.redirectUri });
    const identity = this.#identity(data);
    if (!tokenPattern.test(data.accessToken ?? "") || data.tokenType !== "Bearer" || !Number.isInteger(data.expiresIn) || data.expiresIn <= 0 || data.expiresIn > 1800) throw failure("hrpos_response_invalid", 502);
    // Server-only return value. Never forward this object to browser JSON.
    return { accessToken: data.accessToken, expiresIn: data.expiresIn, identity };
  }

  async delegateOwner(posOwnerAuthUserId) {
    this.#enabled();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(posOwnerAuthUserId ?? "")) throw failure("hrpos_owner_delegation_denied", 403);
    const data = await this.#request("owner-token", { posOwnerAuthUserId });
    const identity = this.#identity(data);
    if (!tokenPattern.test(data.accessToken ?? "") || data.tokenType !== "Bearer" || !Number.isInteger(data.expiresIn) || data.expiresIn <= 0 || data.expiresIn > 1800) throw failure("hrpos_response_invalid", 502);
    return { accessToken: data.accessToken, expiresIn: data.expiresIn, identity };
  }

  async introspect(accessToken) {
    this.#enabled();
    checkToken(accessToken);
    const data = await this.#request("introspect", { accessToken });
    if (data?.active !== true) throw failure("hrpos_session_invalid", 401);
    return this.#identity(data);
  }

  async command(accessToken, operation, input = {}) {
    this.#enabled();
    const ownRequest = ownRequestOperations.has(operation);
    if ((!operations.has(operation) && !ownRequest) || !input || typeof input !== "object" || Array.isArray(input)) throw failure("hrpos_operation_invalid", 422);
    if (ownRequest) input = ownRequestInput(operation, input);
    const identity = await this.introspect(accessToken);
    const ownHome = operation === "staff.home" && identity.roles.includes("staff") && identity.employeeId && identity.permissions.includes("schedule.own.read");
    const ownStaffWrite = ["swaps.cancel", "swaps.decline"].includes(operation)
      ? [
        ...(operation === "swaps.cancel" ? ["swaps.own.cancel"] : ["swaps.own.decline"]),
        "swap.own.write",
        "shift_swap.own.write",
        "schedule.own.write",
      ].some((permission) => identity.permissions.includes(permission))
      : identity.permissions.includes("request.own.write");
    if (ownRequest ? !(identity.roles.includes("staff") && identity.employeeId && ownStaffWrite) : !identity.roles.includes("hr") && !ownHome) throw failure("hrpos_role_denied", 403);
    if (operation === "staff.home" && Object.keys(input).length) throw failure("hrpos_operation_invalid", 422);
    const data = await this.#request("command", { accessToken, operation, input });
    return ownRequest ? ownRequestData(operation, data, input) : data;
  }

  async revoke(accessToken) {
    this.#enabled();
    checkToken(accessToken);
    const data = await this.#request("revoke", { accessToken });
    if (data?.revoked !== true) throw failure("hrpos_response_invalid", 502);
    return { revoked: true };
  }

  #identity(data) {
    const subject = data?.subject;
    if (data?.issuer !== "sagawork" || data.audience !== this.#config.clientId || typeof subject?.userAccountId !== "string" || !subject.userAccountId || typeof subject.membershipId !== "string" || !subject.membershipId || (subject.employeeId != null && (typeof subject.employeeId !== "string" || !subject.employeeId)) || subject.organizationId !== this.#config.organizationId || subject.posOrganizationId !== this.#config.posOrganizationId || !Array.isArray(subject.permissions) || subject.permissions.some((permission) => typeof permission !== "string")) throw failure("hrpos_identity_denied", 403);
    const roles = [...new Set(this.#config.grants.filter((grant) => grant.userAccountId === subject.userAccountId && grant.membershipId === subject.membershipId).map((grant) => grant.role))];
    if (!roles.length || (roles.some((role) => ["cashier", "bar", "staff"].includes(role)) && !subject.employeeId)) throw failure("hrpos_role_denied", 403);
    return { userAccountId: subject.userAccountId, membershipId: subject.membershipId, employeeId: subject.employeeId ?? null, organizationId: subject.organizationId, posOrganizationId: subject.posOrganizationId, roles, permissions: structuredClone(subject.permissions), scopes: structuredClone(subject.scopes ?? []) };
  }

  #enabled() { if (!this.enabled) throw failure("hrpos_disabled", 503); }

  async #request(endpoint, payload) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 65536) throw failure("hrpos_request_too_large", 413);
    const pathname = `/api/integrations/pos/v1/${endpoint}`;
    const timestamp = String(Math.floor(this.clock().getTime() / 1000));
    const nonce = randomBytes(24).toString("base64url");
    const signature = createHmac("sha256", this.#config.secret).update(["v1", this.#config.clientId, timestamp, nonce, "POST", pathname, hash(body)].join("\n")).digest("hex");
    const controller = new AbortController();
    let timer;
    let reader;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure("hrpos_timeout", 503)); }, this.timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetch(`${this.#config.origin}${pathname}`, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", "X-HRPOS-Client": this.#config.clientId, "X-HRPOS-Timestamp": timestamp, "X-HRPOS-Nonce": nonce, "X-HRPOS-Signature": signature }, body });
        if (!response.ok) {
          if (response.body) void response.body.cancel().catch(() => {});
          if (endpoint === "command" && ownRequestOperations.has(payload.operation) && [400, 404].includes(response.status)) throw failure(response.status === 400 ? "hrpos_request_invalid" : "hrpos_request_not_found", response.status);
          throw failure([401, 403].includes(response.status) ? "hrpos_session_denied" : "hrpos_upstream_rejected", [401, 403, 409, 413, 503].includes(response.status) ? response.status : 502);
        }
        if (!response.body) throw failure("hrpos_response_invalid", 502);
        reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) { controller.abort(); void reader.cancel(); throw failure("hrpos_response_too_large", 502); }
          chunks.push(Buffer.from(value));
        }
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!envelope || !Object.hasOwn(envelope, "data")) throw failure("hrpos_response_invalid", 502);
        return envelope.data;
      })()]);
    } catch (error) {
      if (error?.hrposSafe === true) throw error;
      throw failure("hrpos_transport_failed", 503);
    } finally { clearTimeout(timer); if (reader) void reader.cancel().catch(() => {}); }
  }
}

function trustedUrl(value, synthetic) {
  let url;
  try { url = new URL(value); } catch { throw failure("hrpos_configuration_invalid", 503); }
  const loopback = synthetic && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw failure("hrpos_configuration_invalid", 503);
  return url;
}
function checkToken(token) { if (!tokenPattern.test(token ?? "")) throw failure("hrpos_session_invalid", 401); }
function failure(code, statusCode) { return Object.assign(new Error(code), { code, statusCode, hrposSafe: true }); }
