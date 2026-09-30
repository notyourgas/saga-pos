import { createHash, randomUUID } from "node:crypto";

export class SagaMemberClient {
  constructor({ baseUrl, machineToken, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error("member_endpoint_invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("member_endpoint_invalid");
    if (typeof machineToken !== "string" || !machineToken.trim()) throw new Error("member_credential_required");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("member_timeout_invalid");
    this.baseUrl = url.href.replace(/\/$/, ""); this.machineToken = machineToken; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  resolve(memberCode) { return this.#request("/v1/members/resolve", { method: "POST", body: { memberCode } }); }
  summary(memberId) { return this.#request(`/v1/members/${safeReference(memberId)}/summary`, { method: "GET" }); }
  quote(memberId, eligibleSpend, {rewardId,organizationId,contextId} = {}) {
    safeReference(memberId);
    if(!Number.isSafeInteger(eligibleSpend) || eligibleSpend<0)throw new Error('member_amount_invalid');
    const body={memberId,eligibleSpend};
    for(const [field,value] of Object.entries({rewardId,organizationId,contextId}))if(value != null)body[field]=safeReference(value);
    return this.#request('/v1/benefits/quote',{method:'POST',body});
  }
  qualify(input, idempotencyKey) { return this.#request("/v1/commerce/qualifications", { method: "POST", body: input, idempotencyKey }); }
  reserveReward(rewardId, input, idempotencyKey) { return this.#request(`/v1/rewards/${safeReference(rewardId)}/reservations`, { method: "POST", body: input, idempotencyKey }); }
  commitReward(reservationId) { return this.#request(`/v1/reward-reservations/${safeReference(reservationId)}/commit`, { method: "POST", body: {} }); }
  releaseReward(reservationId, reason) { return this.#request(`/v1/reward-reservations/${safeReference(reservationId)}/release`, { method: "POST", body: { reason } }); }
  async #request(path, { method, body, idempotencyKey }) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("member_request_timeout")); }, this.timeoutMs); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetch(`${this.baseUrl}${path}`, { method, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${this.machineToken}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error(`member_api_${response.status}`);
        const data = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("member_response_invalid");
        return data;
      })()]);
    } catch (error) {
      if (/^member_(request_timeout|response_invalid|api_\d{3})$/.test(error?.message)) throw error;
      throw new Error("member_request_failed");
    } finally { clearTimeout(timer); }
  }
}

function safeReference(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("member_reference_invalid");
  return value;
}

export async function submitMemberAwareCheckout({ request, actor, repository, memberClient, submitCheckout }) {
  let member = null;
  let quote = { voyagerDiscount: 0 };
  if (request.memberCode) { member = await memberClient.resolve(request.memberCode); quote = await memberClient.quote(member.id, request.eligibleSpendRupiah ?? request.cartSubtotalRupiah ?? 0); }
  let rewardReservation = null;
  if (request.rewardId) {
    if (!member) throw new Error("member_required_for_reward");
    rewardReservation = await memberClient.reserveReward(request.rewardId, { memberId: member.id }, `reward:${request.idempotencyKey}`);
  }
  let persistedCheckout = null;
  let rewardSynchronization = null;
  try {
    const discountRupiah = Number(request.discountRupiah ?? 0) + Number(quote.voyagerDiscount ?? 0);
    const checkout = await submitCheckout({ request: { ...request, discountRupiah }, actor, repository });
    persistedCheckout = checkout;
    if (rewardReservation) {
      if (String(checkout.order.status).toUpperCase() === "PAID") {
        try {
          await memberClient.commitReward(rewardReservation.id);
          rewardSynchronization = { status: "COMMITTED" };
        } catch {
          rewardSynchronization = { status: "RECONCILIATION_REQUIRED", code: "reward_commit_unconfirmed" };
        }
      } else rewardSynchronization = { status: "AWAITING_PAYMENT" };
    }
    const eligibleSpend = Math.max(0, checkout.order.totalRupiah);
    return { ...checkout, memberAttribution: member ? { memberId: member.id, memberCodeMasked: member.memberCodeMasked } : null, benefitQuote: quote, rewardReservation, rewardSynchronization, commerceQualification: member && String(checkout.order.status).toUpperCase() === "PAID" ? { memberId: member.id, eligibleSpend, sourceType: "COFFEE_ORDER", sourceId: checkout.order.id, idempotencyKey: `coffee:${checkout.order.id}` } : null };
  } catch (error) {
    if (rewardReservation && !persistedCheckout) {
      try { await memberClient.releaseReward(rewardReservation.id, "CHECKOUT_FAILED"); }
      catch { error.rewardReleaseUnconfirmed = true; }
    }
    throw error;
  }
}

export function buildCommerceQualifiedEvent({ order, memberId, organizationId, outletId }) {
  return { event_id: randomUUID(), event_type: "coffee.order.commerce_qualified.v1", schema_version: 1, occurred_at: new Date().toISOString(), producer: "sagaops", organization_id: organizationId, business_id: "kopi-saga", outlet_id: outletId, tenant_id: null, correlation_id: order.id, causation_id: null, subject: { type: "member", id: memberId }, payload: { order_id: order.id, eligible_spend: order.totalRupiah }, metadata: { classification: "internal", traceparent: null } };
}

export function hashMemberCode(code) { return createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex"); }
