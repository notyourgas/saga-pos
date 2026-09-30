// Provider-owned read contract. No employee/context selector crosses this boundary.
export const ownRequestOperations = new Set(["staff.requests.list", "staff.requests.get", "swaps.cancel", "swaps.decline"]);
const states = new Set(["submitted", "needs_information", "supervisor_approved", "approved", "rejected", "withdrawn", "cancel_requested", "cancelled", "appealed"]);
const categories = new Set(["annual_leave", "sick", "personal_permission", "unpaid_leave", "overtime", "special_leave"]);
const ulid = (value) => typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
const cursor = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const text = (value) => typeof value === "string";
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nullable = (check) => (value) => value === null || check(value);
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const timezone = (value) => { try { return text(value) && value.length > 0 && Boolean(new Intl.DateTimeFormat("id-ID", { timeZone: value })); } catch { return false; } };
const reason = (value) => typeof value === "string" && value.trim().length >= 10 && value.trim().length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
const fail = (input) => { throw Object.assign(new Error(input ? "hrpos_operation_invalid" : "hrpos_response_invalid"), { code: input ? "hrpos_operation_invalid" : "hrpos_response_invalid", statusCode: input ? 422 : 502, hrposSafe: true }); };
function object(value, fields, input = false, optional = false) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !Object.hasOwn(fields, key))) fail(input);
  for (const [key, check] of Object.entries(fields)) if ((!optional || Object.hasOwn(value, key)) && !check(value[key])) fail(input);
  return value;
}
const itemFields = {
  id: ulid, locationName: text, policyName: text, category: (v) => categories.has(v),
  startsAt: timestamp, endsAt: timestamp, requestedMinutes: integer, approvedMinutes: nullable(integer),
  state: (v) => states.has(v), currentApprovalStep: integer, version: integer, createdAt: timestamp, timezone,
};
export function ownRequestInput(operation, input) {
  if (operation === "staff.requests.list") {
    object(input, { limit: (v) => Number.isInteger(v) && v >= 1 && v <= 50, cursor, state: (v) => states.has(v) }, true, true);
    return { limit: 20, ...input };
  }
  if (operation === "staff.requests.get") return { ...object(input, { workforceRequestId: ulid }, true) };
  if (operation === "swaps.cancel" || operation === "swaps.decline") {
    const idField = operation === "swaps.cancel" ? "swapRequestId" : "offerId";
    const checked = object(input, { [idField]: ulid, payload: (v) => Boolean(v) }, true);
    const payload = object(checked.payload, { reason }, true);
    return { [idField]: checked[idField], payload: { reason: payload.reason.trim() } };
  }
  fail(true);
}
export function ownRequestData(operation, data, input) {
  if (operation === "staff.requests.list") {
    object(data, { items: (v) => Array.isArray(v) && v.length <= input.limit, nextCursor: nullable(cursor) });
    for (const item of data.items) {
      object(item, itemFields);
      if (input.state && item.state !== input.state) fail(false);
    }
    if (new Set(data.items.map((item) => item.id)).size !== data.items.length) fail(false);
  } else if (operation === "staff.requests.get") {
    object(data, { request: (v) => Boolean(v), history: (v) => Array.isArray(v) && v.length <= 100, historyTruncated: (v) => typeof v === "boolean", approvalSteps: Array.isArray });
    object(data.request, { ...itemFields, employeeName: text, reason: text });
    if (data.request.id !== input.workforceRequestId) fail(false);
    for (const event of data.history) object(event, { fromState: nullable(text), toState: text, reason: nullable(text), occurredAt: timestamp });
    for (const step of data.approvalSteps) object(step, { stepOrder: integer, state: (v) => ["pending", "approved", "rejected", "skipped"].includes(v), reason: nullable(text), decidedAt: nullable(timestamp) });
  } else if (operation === "swaps.cancel") {
    object(data, { swapRequest: (v) => Boolean(v), audit: (v) => Boolean(v) });
    object(data.swapRequest, { id: ulid, state: (v) => v === "cancelled", version: integer, cancelledAt: timestamp });
    object(data.audit, { operation: (v) => v === "swaps.cancel", occurredAt: timestamp });
    if (data.swapRequest.id !== input.swapRequestId) fail(false);
  } else if (operation === "swaps.decline") {
    object(data, { swapOffer: (v) => Boolean(v), audit: (v) => Boolean(v) });
    object(data.swapOffer, { id: ulid, state: (v) => v === "declined", version: integer, declinedAt: timestamp });
    object(data.audit, { operation: (v) => v === "swaps.decline", occurredAt: timestamp });
    if (data.swapOffer.id !== input.offerId) fail(false);
  } else fail(true);
  return structuredClone(data);
}
