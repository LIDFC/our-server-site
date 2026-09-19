import { randomUUID } from "node:crypto";

import { createCachedLoader, type CachedLoader } from "../cache.ts";
import type { Config } from "../config.ts";

/**
 * The site's side of the marketplace.
 *
 * <p>One rule shapes this file: the browser never talks to the plugin. The token stays here, the player's identity
 * comes from the site's own session and its own database, and the UUID is put into the request by this service. A
 * request body from a browser can therefore never decide whose listing gets cancelled — and the plugin checks the
 * ownership again anyway, so a mistake here still cannot move somebody else's items.
 */

export interface MarketItem {
  summary: string;
  amount: number;
}

export interface MarketListing {
  id: number;
  type: "GIVEAWAY" | "TRADE" | "WANTED" | "GIFT";
  state: string;
  ownerUuid: string;
  recipientUuid: string | null;
  summary: string;
  createdAt: string;
  offered: MarketItem[];
  wanted: MarketItem[];
}

export interface MarketTrade {
  id: number;
  listingId: number;
  ownerUuid: string;
  buyerUuid: string;
  state: "PENDING" | "ACCEPTED" | "CONFIRMED" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  confirmations: ("OWNER" | "BUYER")[];
  createdAt: string;
}

export interface MarketDelivery {
  id: number;
  summary: string;
  amount: number;
  reason: string;
  createdAt: string;
}

export interface Failure {
  ok: false;
  status: number;
  error: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

export type TradeAction = "accept" | "decline" | "confirm";

export interface MarketService {
  /** false while MARKET_API_URL and MARKET_API_TOKEN are not set: the section then says so instead of failing. */
  readonly enabled: boolean;
  listings(type: string | null, limit: number, offset: number): Promise<Result<MarketListing[]>>;
  listingsOf(uuid: string): Promise<Result<MarketListing[]>>;
  tradesOf(uuid: string): Promise<Result<MarketTrade[]>>;
  deliveriesOf(uuid: string): Promise<Result<MarketDelivery[]>>;
  cancelListing(uuid: string, listingId: number): Promise<Result<Record<string, unknown>>>;
  trade(uuid: string, tradeId: number, action: TradeAction): Promise<Result<Record<string, unknown>>>;
  health(): Promise<Result<Record<string, unknown>>>;
}

/**
 * The plugin's error codes, translated into the site's own vocabulary. The HTTP status comes from the code rather than
 * from the plugin's response, so one table decides both and they cannot drift apart.
 */
const ERRORS: Record<string, { status: number; error: string }> = {
  UNAUTHORIZED: { status: 502, error: "market-unauthorized" },
  RATE_LIMITED: { status: 429, error: "rate-limited" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 500, error: "market-failed" },
  INVALID_REQUEST: { status: 400, error: "invalid-request" },
  LISTING_NOT_FOUND: { status: 404, error: "listing-not-found" },
  TRADE_NOT_FOUND: { status: 404, error: "trade-not-found" },
  NOT_OWNER: { status: 403, error: "not-owner" },
  NOT_PARTICIPANT: { status: 403, error: "not-participant" },
  NOT_RECIPIENT: { status: 403, error: "not-recipient" },
  LISTING_ALREADY_TAKEN: { status: 409, error: "listing-already-taken" },
  LISTING_NOT_ACTIVE: { status: 409, error: "listing-not-active" },
  TRADE_NOT_ACCEPTED: { status: 409, error: "trade-not-accepted" },
  INTERNAL_ERROR: { status: 502, error: "market-failed" },
};

const UNAVAILABLE: Failure = {
  ok: false,
  status: 503,
  error: "market-unavailable",
  message: "The marketplace is not answering",
};

const DISABLED: Failure = {
  ok: false,
  status: 503,
  error: "market-disabled",
  message: "The marketplace integration is not configured",
};

/** How many different listing queries are worth caching before the oldest is dropped. */
const MAX_CACHED_QUERIES = 32;

export function createMarketService(config: Config): MarketService {
  const base = config.market.url;
  const token = config.market.token;
  const enabled = base !== null && token !== null;
  const listingCaches = new Map<string, CachedLoader<Result<MarketListing[]>>>();

  const call = async (
    path: string,
    init: { method: "GET" } | { method: "POST"; body: Record<string, unknown>; idempotencyKey: string },
  ): Promise<Result<Record<string, unknown>>> => {
    if (!enabled) {
      return DISABLED;
    }
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init.method === "POST"
            ? { "Content-Type": "application/json", "Idempotency-Key": init.idempotencyKey }
            : {}),
        },
        ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(config.market.timeoutMs),
      });
    } catch (error) {
      // the address and the token are never logged: this line ends up in an ordinary server log
      console.warn(`[market] ${init.method} ${path} did not answer: ${(error as Error).name}`);
      return UNAVAILABLE;
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok) {
      return { ok: true, value: (payload ?? {}) as Record<string, unknown> };
    }

    const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
    const known = typeof code === "string" ? ERRORS[code] : undefined;
    if (!known) {
      console.warn(`[market] ${init.method} ${path} answered ${response.status}`);
      return UNAVAILABLE;
    }
    if (known.error === "market-unauthorized") {
      console.error("[market] The marketplace refused the site's token; check MARKET_API_TOKEN");
    }
    return { ok: false, status: known.status, error: known.error, message: `The marketplace refused: ${code}` };
  };

  /** Pulls a named array out of an answer. A missing or malformed field is an empty list, never a crash. */
  const listOf = <T>(result: Result<Record<string, unknown>>, field: string): Result<T[]> => {
    if (!result.ok) {
      return result;
    }
    const value = result.value[field];
    return { ok: true, value: Array.isArray(value) ? (value as T[]) : [] };
  };

  const cachedListings = (key: string, load: () => Promise<Result<MarketListing[]>>): CachedLoader<Result<MarketListing[]>> => {
    let loader = listingCaches.get(key);
    if (!loader) {
      if (listingCaches.size >= MAX_CACHED_QUERIES) {
        const oldest = listingCaches.keys().next().value;
        if (oldest !== undefined) {
          listingCaches.delete(oldest);
        }
      }
      loader = createCachedLoader(load, config.market.listingsCacheSeconds * 1000);
      listingCaches.set(key, loader);
    }
    return loader;
  };

  return {
    enabled,

    async listings(type, limit, offset) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (type) {
        query.set("type", type);
      }
      const path = `/listings?${query.toString()}`;
      if (config.market.listingsCacheSeconds <= 0) {
        return listOf<MarketListing>(await call(path, { method: "GET" }), "listings");
      }
      // the public board is the same for everybody, so one answer serves every visitor for a few seconds
      const loader = cachedListings(path, async () => listOf<MarketListing>(await call(path, { method: "GET" }), "listings"));
      const cached = await loader.get();
      return cached.value;
    },

    // a player's own view is never cached: they have just acted on it and expect to see the result
    async listingsOf(uuid) {
      return listOf<MarketListing>(await call(`/players/${encodeURIComponent(uuid)}/listings`, { method: "GET" }), "listings");
    },

    async tradesOf(uuid) {
      return listOf<MarketTrade>(await call(`/players/${encodeURIComponent(uuid)}/trades`, { method: "GET" }), "trades");
    },

    async deliveriesOf(uuid) {
      return listOf<MarketDelivery>(await call(`/players/${encodeURIComponent(uuid)}/deliveries`, { method: "GET" }), "deliveries");
    },

    async cancelListing(uuid, listingId) {
      return call(`/listings/${listingId}/cancel`, {
        method: "POST",
        body: { minecraftUuid: uuid },
        idempotencyKey: `site-cancel-${listingId}-${randomUUID()}`,
      });
    },

    async trade(uuid, tradeId, action) {
      return call(`/trades/${tradeId}/${action}`, {
        method: "POST",
        body: { minecraftUuid: uuid },
        idempotencyKey: `site-${action}-${tradeId}-${randomUUID()}`,
      });
    },

    async health() {
      return call("/health", { method: "GET" });
    },
  };
}
