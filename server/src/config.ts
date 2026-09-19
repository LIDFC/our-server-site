import path from "node:path";

/** Root of the project, relative paths in the environment are resolved against it. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

export interface Config {
  host: string;
  port: number;
  trustProxy: boolean;
  serverName: string;
  publicDir: string;
  dataDir: string;
  galleryDir: string;
  minecraft: {
    host: string;
    port: number;
    publicAddress: string;
    serverDir: string;
    worldName: string;
    statusCacheSeconds: number;
    statusTimeoutMs: number;
    statsCacheSeconds: number;
    /** shared secret the Minecraft plugin sends, null while the integration is switched off */
    apiToken: string | null;
  };
  history: {
    intervalSeconds: number;
    retentionDays: number;
  };
  map: {
    /** public URL of squaremap, null while the map is not set up */
    url: string | null;
    world: string;
  };
  launcher: {
    repo: string;
    token: string | null;
    cacheSeconds: number;
  };
  rateLimit: {
    windowSeconds: number;
    maxRequests: number;
  };
  auth: {
    /** shared registration code, null while registration is closed */
    inviteCode: string | null;
    /** false only for local development over plain http */
    cookieSecure: boolean;
    sessionTtlDays: number;
    /** separate, much stricter limit for /api/auth/* */
    rateLimit: {
      windowSeconds: number;
      maxRequests: number;
    };
  };
  market: {
    /** base URL of the marketplace plugin API, null while the marketplace is switched off */
    url: string | null;
    /** shared secret the plugin expects, null while the marketplace is switched off */
    token: string | null;
    listingsCacheSeconds: number;
    timeoutMs: number;
    /** actions reach the game server, so they get a stricter limit than ordinary reads */
    rateLimit: {
      windowSeconds: number;
      maxRequests: number;
    };
  };
  skins: {
    uploadDir: string;
    maxUploadBytes: number;
    /** how long a player waits between two uploads */
    cooldownSeconds: number;
    /** uploads are heavier than a normal request, so they have their own limit per address */
    rateLimit: {
      windowSeconds: number;
      maxRequests: number;
    };
    /** public origin of the site, the stored skin URL is built from it */
    siteUrl: string;
  };
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Reads and validates the configuration. Every problem is reported at once so a broken .env is fixed in one go. */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const text = (name: string, fallback: string): string => {
    const value = env[name]?.trim();
    return value ? value : fallback;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };

  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (!raw) {
      return fallback;
    }
    if (["1", "true", "yes", "on"].includes(raw)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(raw)) {
      return false;
    }
    problems.push(`${name} must be true or false`);
    return fallback;
  };

  const directory = (name: string, fallback: string): string => path.resolve(PROJECT_ROOT, text(name, fallback));

  const hostname = (name: string, fallback: string): string => {
    const value = text(name, fallback);
    if (!HOSTNAME.test(value) && !IPV4.test(value)) {
      problems.push(`${name} must be a host name or an IPv4 address`);
    }
    return value;
  };

  const worldName = text("MC_WORLD", "world");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(worldName)) {
    problems.push("MC_WORLD must be a plain folder name, for example world");
  }

  let mapUrl: string | null = null;
  const rawMapUrl = text("MAP_URL", "");
  if (rawMapUrl) {
    try {
      const url = new URL(rawMapUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
      mapUrl = url.href.replace(/\/+$/, "");
    } catch {
      problems.push("MAP_URL must be an http(s) URL, for example https://map.vin-off.site");
    }
  }

  const mapWorld = text("MAP_WORLD", "minecraft_overworld");
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(mapWorld)) {
    problems.push("MAP_WORLD must be a squaremap world name, for example minecraft_overworld");
  }

  const repo = text("LAUNCHER_REPO", "LIDFC/MkeiitLauncher");
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    problems.push("LAUNCHER_REPO must look like owner/repository");
  }

  const serverName = text("SERVER_NAME", "Our Server");
  if (serverName.length > 60) {
    problems.push("SERVER_NAME must be at most 60 characters");
  }

  // the skin URL players give to SkinsRestorer is built from this address
  let siteUrl = "https://mc.vin-off.site";
  const rawSiteUrl = text("PUBLIC_SITE_URL", "");
  if (rawSiteUrl) {
    try {
      const url = new URL(rawSiteUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
      siteUrl = url.origin;
    } catch {
      problems.push("PUBLIC_SITE_URL must be an http(s) URL, for example https://mc.vin-off.site");
    }
  }

  // without a token the Minecraft integration stays closed, an empty one would accept anybody
  const minecraftApiToken = text("MINECRAFT_API_TOKEN", "");
  if (minecraftApiToken && minecraftApiToken.length < 24) {
    problems.push("MINECRAFT_API_TOKEN must be at least 24 characters, or empty to switch the Minecraft integration off");
  }

  // the marketplace needs both halves: an address without a token would talk to the plugin as a stranger, and a token
  // without an address has nowhere to go. Either both are set, or the section stays switched off.
  let marketUrl: string | null = null;
  const rawMarketUrl = text("MARKET_API_URL", "");
  if (rawMarketUrl) {
    try {
      const url = new URL(rawMarketUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("unsupported protocol");
      }
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
      if (!loopback && url.protocol !== "https:") {
        // the token travels in a header: off this machine it may not travel in the clear
        problems.push("MARKET_API_URL must use https unless it points at 127.0.0.1");
      }
      marketUrl = url.href.replace(/\/+$/, "");
    } catch {
      problems.push("MARKET_API_URL must be an http(s) URL, for example http://127.0.0.1:8788/api/v1/market");
    }
  }
  const marketToken = text("MARKET_API_TOKEN", "");
  if (marketToken && marketToken.length < 24) {
    problems.push("MARKET_API_TOKEN must be at least 24 characters, or empty to switch the marketplace off");
  }
  if (Boolean(marketUrl) !== Boolean(marketToken)) {
    problems.push("MARKET_API_URL and MARKET_API_TOKEN must be set together, or both left empty");
  }

  // an empty code closes registration instead of letting everyone in
  const inviteCode = text("REGISTER_INVITE_CODE", "");
  if (inviteCode && inviteCode.length < 6) {
    problems.push("REGISTER_INVITE_CODE must be at least 6 characters, or empty to close registration");
  }

  const config: Config = {
    host: text("HOST", "127.0.0.1"),
    port: integer("PORT", 3000, 1, 65535),
    trustProxy: flag("TRUST_PROXY", false),
    serverName,
    publicDir: directory("PUBLIC_DIR", "dist"),
    dataDir: directory("DATA_DIR", "data"),
    galleryDir: directory("GALLERY_DIR", "content/gallery"),
    minecraft: {
      host: hostname("MC_HOST", "127.0.0.1"),
      port: integer("MC_PORT", 25565, 1, 65535),
      publicAddress: hostname("MC_PUBLIC_ADDRESS", "mc.vin-off.site"),
      serverDir: directory("MC_SERVER_DIR", "../minecraft"),
      worldName,
      statusCacheSeconds: integer("STATUS_CACHE_SECONDS", 15, 5, 600),
      statusTimeoutMs: integer("STATUS_TIMEOUT_MS", 5000, 500, 30000),
      statsCacheSeconds: integer("STATS_CACHE_SECONDS", 300, 30, 86400),
      apiToken: minecraftApiToken || null,
    },
    history: {
      intervalSeconds: integer("HISTORY_INTERVAL_SECONDS", 300, 60, 3600),
      retentionDays: integer("HISTORY_RETENTION_DAYS", 7, 1, 90),
    },
    map: { url: mapUrl, world: mapWorld },
    launcher: {
      repo,
      token: text("GITHUB_TOKEN", "") || null,
      cacheSeconds: integer("LAUNCHER_CACHE_SECONDS", 600, 60, 86400),
    },
    rateLimit: {
      windowSeconds: integer("RATE_LIMIT_WINDOW_SECONDS", 60, 1, 3600),
      maxRequests: integer("RATE_LIMIT_MAX_REQUESTS", 120, 1, 100000),
    },
    auth: {
      inviteCode: inviteCode || null,
      cookieSecure: flag("COOKIE_SECURE", true),
      sessionTtlDays: integer("SESSION_TTL_DAYS", 30, 1, 365),
      rateLimit: {
        windowSeconds: integer("AUTH_RATE_LIMIT_WINDOW_SECONDS", 900, 10, 86400),
        maxRequests: integer("AUTH_RATE_LIMIT_MAX_REQUESTS", 10, 1, 1000),
      },
    },
    market: {
      url: marketUrl && marketToken ? marketUrl : null,
      token: marketUrl && marketToken ? marketToken : null,
      listingsCacheSeconds: integer("MARKET_CACHE_SECONDS", 10, 0, 600),
      timeoutMs: integer("MARKET_TIMEOUT_MS", 4000, 200, 30000),
      rateLimit: {
        windowSeconds: integer("MARKET_ACTION_LIMIT_WINDOW_SECONDS", 60, 10, 86400),
        maxRequests: integer("MARKET_ACTION_LIMIT_MAX_REQUESTS", 20, 1, 10000),
      },
    },
    skins: {
      uploadDir: directory("SKIN_UPLOAD_DIR", "uploads/skins"),
      maxUploadBytes: integer("SKIN_MAX_UPLOAD_BYTES", 8 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
      cooldownSeconds: integer("SKIN_UPLOAD_COOLDOWN_SECONDS", 20, 0, 3600),
      rateLimit: {
        windowSeconds: integer("SKIN_UPLOAD_LIMIT_WINDOW_SECONDS", 600, 10, 86400),
        maxRequests: integer("SKIN_UPLOAD_LIMIT_MAX_REQUESTS", 10, 1, 10000),
      },
      siteUrl,
    },
  };

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }
  return config;
}
