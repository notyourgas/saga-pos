export function catalogPricingError(code, statusCode = 422, details = undefined) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function requiredText(value, code, { max = 160 } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw catalogPricingError(code);
  }
  return normalized;
}

export function isoInstant(value, code) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw catalogPricingError(code);
  return new Date(milliseconds).toISOString();
}

export function assertHalfOpenInterval(start, end, code) {
  const normalizedStart = isoInstant(start, code);
  const normalizedEnd = end == null ? null : isoInstant(end, code);
  if (normalizedEnd && Date.parse(normalizedEnd) <= Date.parse(normalizedStart)) {
    throw catalogPricingError(code);
  }
  return { startsAt: normalizedStart, endsAt: normalizedEnd };
}
