export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
  size(): number;
  stop(): void;
}

/** Fixed-window limiter kept in memory. Plenty for a site used by a group of friends, and it costs almost nothing. */
export function createRateLimiter(options: { windowSeconds: number; maxRequests: number; maxClients?: number }): RateLimiter {
  const windowMs = options.windowSeconds * 1000;
  const maxClients = options.maxClients ?? 10_000;
  const clients = new Map<string, { count: number; resetAt: number }>();

  const removeExpired = (now: number): void => {
    for (const [key, entry] of clients) {
      if (entry.resetAt <= now) {
        clients.delete(key);
      }
    }
  };

  const cleanup = setInterval(() => removeExpired(Date.now()), Math.max(windowMs, 10_000));
  cleanup.unref();

  return {
    check(key: string, now = Date.now()): RateLimitResult {
      let entry = clients.get(key);
      if (!entry || entry.resetAt <= now) {
        if (!entry && clients.size >= maxClients) {
          removeExpired(now);
          if (clients.size >= maxClients) {
            // drop the oldest client instead of growing without limit
            const oldest = clients.keys().next().value;
            if (oldest !== undefined) {
              clients.delete(oldest);
            }
          }
        }
        entry = { count: 0, resetAt: now + windowMs };
        clients.set(key, entry);
      }
      entry.count++;
      const allowed = entry.count <= options.maxRequests;
      return {
        allowed,
        remaining: Math.max(0, options.maxRequests - entry.count),
        retryAfterSeconds: allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000),
      };
    },
    size: () => clients.size,
    stop: () => clearInterval(cleanup),
  };
}
