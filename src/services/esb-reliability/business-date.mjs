import { reliabilityError, requireText } from "./contract.mjs";

export function businessDateForInstant({ occurredAt, timezone, cutoffLocal = "04:00:00" }) {
  const instant = new Date(requireText(occurredAt, "business_date_instant_required", 64));
  if (Number.isNaN(instant.getTime())) throw reliabilityError("business_date_instant_invalid");
  const zone = requireText(timezone, "business_date_timezone_required", 80);
  const cutoffSeconds = parseCutoff(cutoffLocal);
  let parts;
  try {
    parts = localParts(instant, zone);
  } catch {
    throw reliabilityError("business_date_timezone_invalid");
  }
  const localSeconds = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const localDateUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const businessDateUtc = localSeconds < cutoffSeconds ? localDateUtc - 86_400_000 : localDateUtc;
  return new Date(businessDateUtc).toISOString().slice(0, 10);
}

export function isInsideHalfOpenPeriod(instant, start, end) {
  const value = Date.parse(instant);
  const lower = Date.parse(start);
  const upper = Date.parse(end);
  if ([value, lower, upper].some(Number.isNaN) || lower >= upper) throw reliabilityError("report_period_invalid");
  return value >= lower && value < upper;
}

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function parseCutoff(value) {
  const text = requireText(value, "business_date_cutoff_required", 8);
  const match = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(text);
  if (!match) throw reliabilityError("business_date_cutoff_invalid");
  const [, hour, minute, second] = match.map(Number);
  if (hour > 23 || minute > 59 || second > 59) throw reliabilityError("business_date_cutoff_invalid");
  return hour * 3600 + minute * 60 + second;
}
