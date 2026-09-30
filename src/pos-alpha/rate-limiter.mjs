export class SlidingWindowRateLimiter {
  constructor({ clock = () => new Date(), limit, windowMs } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("rate_limiter_config_invalid");
    this.clock = clock;
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  consume(key) {
    const now = this.clock().getTime();
    const cutoff = now - this.windowMs;
    const active = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= this.limit) {
      const error = new Error("rate_limit_exceeded");
      error.code = "rate_limit_exceeded";
      error.statusCode = 429;
      error.retryAfterSeconds = Math.max(1, Math.ceil((active[0] + this.windowMs - now) / 1000));
      throw error;
    }
    active.push(now);
    this.hits.set(key, active);
    return { remaining: this.limit - active.length, resetAt: new Date(active[0] + this.windowMs).toISOString() };
  }
}
