import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { deleteExpiredSessions } from "./auth/sessions.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import {
  clientAddress,
  parseCookies,
  readBinaryBody,
  readJsonBody,
  sameOrigin,
  securityHeaders,
  sendError,
  sendJson,
  serializeCookie,
  serveFile,
  staticCandidates,
} from "./http.ts";
import { createRateLimiter } from "./rateLimit.ts";
import { createAccountService } from "./services/accounts.ts";
import { createFileGalleryStore } from "./services/gallery.ts";
import { createHistoryStore, startHistorySampler } from "./services/history.ts";
import { createLauncherService } from "./services/launcher.ts";
import { createMinecraftDirectory } from "./services/minecraft.ts";
import { createSkinService } from "./services/skins.ts";
import { createSkinSync } from "./services/skinSync.ts";
import { buildLeaderboard, createStatsService } from "./services/stats.ts";
import { createStatusService } from "./services/status.ts";

type Handler = (url: URL) => Promise<{ status?: number; body: unknown; cacheSeconds?: number }>;
type PostHandler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<void>;

const SESSION_COOKIE = "os_session";
/** registration, sign in and password changes get the strict limit; reading the current account does not */
const GUARDED_AUTH_PATHS = new Set(["/api/auth/register", "/api/auth/login", "/api/auth/password"]);
const SESSION_SWEEP_MS = 3_600_000;
const SKIN_UPLOAD_PATH = "/api/skins";
const SKIN_PUBLIC_PREFIX = "/skins/";

export function createApp(config: Config) {
  const status = createStatusService(config);
  const stats = createStatsService(config);
  const launcher = createLauncherService(config);
  const gallery = createFileGalleryStore(config.galleryDir);
  const history = createHistoryStore(path.join(config.dataDir, "online-history.json"), config.history.retentionDays, config.history.intervalSeconds);
  const db = openDatabase(path.join(config.dataDir, "site.db"));
  const accounts = createAccountService(db, config);
  const skins = createSkinService(db, config);
  const minecraftDirectory = createMinecraftDirectory(config);
  const skinSync = createSkinSync(accounts, skins, minecraftDirectory);
  const limiter = createRateLimiter(config.rateLimit);
  const authLimiter = createRateLimiter(config.auth.rateLimit);
  const uploadLimiter = createRateLimiter(config.skins.rateLimit);
  const headers = securityHeaders(config.map.url);

  const sessionCookie = (token: string): string =>
    serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: config.auth.sessionTtlDays * 86_400, secure: config.auth.cookieSecure });
  const clearedCookie = (): string => serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: config.auth.cookieSecure });
  const sessionToken = (req: IncomingMessage): string => parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "";

  const routes: Record<string, Handler> = {
    "/api/health": async () => ({ body: { ok: true } }),

    "/api/config": async () => ({
      // short, so a newly configured map shows up quickly
      cacheSeconds: 60,
      body: {
        serverName: config.serverName,
        address: config.minecraft.publicAddress,
        map: { url: config.map.url, world: config.map.world },
        launcherRepo: config.launcher.repo,
      },
    }),

    "/api/server/status": async () => ({ body: await status.get(), cacheSeconds: 10 }),

    "/api/server/players": async () => {
      const current = await status.get();
      return {
        cacheSeconds: 10,
        body: {
          online: current.online,
          count: current.players?.online ?? null,
          max: current.players?.max ?? null,
          names: current.playerNames,
          complete: current.playerListComplete,
          checkedAt: current.checkedAt,
        },
      };
    },

    "/api/server/stats": async () => ({ body: await stats.snapshot(), cacheSeconds: 60 }),

    "/api/server/leaderboard": async () => {
      const snapshot = await stats.snapshot();
      return {
        cacheSeconds: 60,
        body: {
          available: snapshot.available,
          updatedAt: snapshot.updatedAt,
          categories: buildLeaderboard(snapshot.players),
          milestones: snapshot.milestones,
        },
      };
    },

    "/api/server/online-history": async (url) => {
      const raw = url.searchParams.get("hours") ?? "24";
      const hours = Number(raw);
      if (!/^\d{1,3}$/.test(raw) || hours < 1 || hours > config.history.retentionDays * 24) {
        return { status: 400, body: { error: "invalid-hours", message: `hours must be an integer from 1 to ${config.history.retentionDays * 24}` } };
      }
      return { body: history.query(hours), cacheSeconds: 60 };
    },

    "/api/gallery": async () => ({ body: { items: await gallery.list() }, cacheSeconds: 60 }),

    "/api/launcher/release": async () => ({ body: await launcher.latest(), cacheSeconds: 300 }),
  };

  /**
   * Account endpoints. The signed in user always comes from the session cookie, never from the request: there is no
   * account id to change anywhere in this surface, so nobody can reach somebody else's account.
   */
  const postRoutes: Record<string, PostHandler> = {
    "/api/auth/register": async (_req, res, body) => {
      const result = await accounts.register(body);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      res.setHeader("Set-Cookie", sessionCookie(result.value.token));
      sendJson(res, 201, { user: result.value.user });
    },

    "/api/auth/login": async (_req, res, body) => {
      const result = await accounts.login(body);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      res.setHeader("Set-Cookie", sessionCookie(result.value.token));
      sendJson(res, 200, { user: result.value.user });
    },

    "/api/auth/logout": async (req, res) => {
      accounts.logout(sessionToken(req));
      res.statusCode = 204;
      res.setHeader("Set-Cookie", clearedCookie());
      res.setHeader("Cache-Control", "no-store");
      res.end();
    },

    "/api/auth/profile": async (req, res, body) => {
      const token = sessionToken(req);
      const user = accounts.current(token);
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      const result = accounts.updateMinecraftUsername(user.id, body);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      sendJson(res, 200, { user: result.value });
    },

    "/api/skins/name": async (req, res, body) => {
      const user = accounts.current(sessionToken(req));
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      const result = skins.rename(user.id, body["skinName"]);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      sendJson(res, 200, { skin: result.value });
    },

    /**
     * Server to server: the Minecraft plugin reports that a player ran /skin clear. Authenticated with a shared token,
     * never reachable from a browser, and safe to repeat.
     */
    "/api/internal/minecraft/skin-cleared": async (req, res, body) => {
      if (!config.minecraft.apiToken) {
        sendError(res, 503, "integration-disabled", "The Minecraft integration is not configured");
        return;
      }
      if (req.headers.origin) {
        // browsers always send Origin on a POST, so this endpoint is for the game server only
        sendError(res, 403, "browser-not-allowed", "This endpoint is not for browsers");
        return;
      }
      const header = req.headers.authorization ?? "";
      const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const expected = config.minecraft.apiToken;
      const sameLength = provided.length === expected.length;
      // compare a padded copy so the check takes the same time whatever the token looks like
      const size = Math.max(provided.length, expected.length, 64);
      const left = Buffer.alloc(size);
      const right = Buffer.alloc(size);
      left.write(provided);
      right.write(expected);
      if (!timingSafeEqual(left, right) || !sameLength) {
        console.warn(`[minecraft] Rejected a skin sync request with a wrong token from ${clientAddress(req, config.trustProxy)}`);
        sendError(res, 401, "unauthorized", "A valid integration token is required");
        return;
      }
      const answer = await skinSync.clear(body);
      sendJson(res, answer.status, answer.body);
    },

    "/api/skins/delete": async (req, res) => {
      const user = accounts.current(sessionToken(req));
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      const result = await skins.remove(user.id);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store");
      res.end();
    },

    "/api/auth/password": async (req, res, body) => {
      const token = sessionToken(req);
      const user = accounts.current(token);
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      const result = await accounts.changePassword(user.id, token, body);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      res.statusCode = 204;
      res.setHeader("Cache-Control", "no-store");
      res.end();
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const post = postRoutes[url.pathname];
    const upload = url.pathname === SKIN_UPLOAD_PATH;

    if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && (post || upload))) {
      res.setHeader("Allow", post || upload ? "POST" : "GET, HEAD");
      sendError(res, 405, "method-not-allowed", post || upload ? "Only POST is supported" : "Only GET and HEAD are supported");
      return;
    }

    const address = clientAddress(req, config.trustProxy);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
      const limit = limiter.check(address);
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        sendError(res, 429, "rate-limited", "Too many requests, try again later");
        return;
      }
    }

    if (post) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendError(res, 405, "method-not-allowed", "Only POST is supported");
        return;
      }
      if (!sameOrigin(req)) {
        sendError(res, 403, "bad-origin", "The request came from another site");
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendError(res, body.status, body.error, body.message);
        return;
      }
      if (GUARDED_AUTH_PATHS.has(url.pathname)) {
        // brute force protection: per address, and per login so one account cannot be hammered from many addresses
        const username = typeof body.value["username"] === "string" ? body.value["username"].trim().toLowerCase() : "";
        const attempts = [authLimiter.check(`ip:${address}`), ...(username ? [authLimiter.check(`user:${username}`)] : [])];
        const blocked = attempts.find((attempt) => !attempt.allowed);
        if (blocked) {
          res.setHeader("Retry-After", String(blocked.retryAfterSeconds));
          sendError(res, 429, "rate-limited", "Too many attempts, try again later");
          return;
        }
      }
      await post(req, res, body.value);
      return;
    }

    if (upload) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendError(res, 405, "method-not-allowed", "Only POST is supported");
        return;
      }
      if (!sameOrigin(req)) {
        sendError(res, 403, "bad-origin", "The request came from another site");
        return;
      }
      // the account comes from the session, never from the request: an upload can only ever replace its own skin
      const user = accounts.current(sessionToken(req));
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      const attempt = uploadLimiter.check(`ip:${address}`);
      if (!attempt.allowed) {
        res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
        sendError(res, 429, "rate-limited", "Too many uploads, try again later");
        return;
      }
      const body = await readBinaryBody(req, config.skins.maxUploadBytes);
      if (!body.ok) {
        sendError(res, body.status, body.error, body.message);
        return;
      }
      const declaredType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() || null;
      const fileNameHeader = req.headers["x-skin-filename"];
      const fileName = typeof fileNameHeader === "string" ? decodeURIComponent(fileNameHeader).slice(0, 200) : null;
      const result = await skins.save(user.id, body.value, declaredType, fileName);
      if (!result.ok) {
        sendError(res, result.status, result.error, result.message);
        return;
      }
      sendJson(res, 201, { skin: result.value });
      return;
    }

    if (url.pathname === "/api/auth/me") {
      const user = accounts.current(sessionToken(req));
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      sendJson(res, 200, { user });
      return;
    }

    if (url.pathname === "/api/skins/me") {
      const user = accounts.current(sessionToken(req));
      if (!user) {
        sendError(res, 401, "unauthenticated", "Sign in first");
        return;
      }
      sendJson(res, 200, {
        skin: skins.forUser(user.id),
        minecraftUsername: user.minecraftUsername,
        limits: { maxBytes: config.skins.maxUploadBytes, sizes: ["64x64", "64x32"], types: ["image/png", "image/jpeg"] },
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const route = routes[url.pathname];
      if (!route) {
        sendError(res, 404, "not-found", "Unknown API endpoint");
        return;
      }
      const result = await route(url);
      sendJson(res, result.status ?? 200, result.body, result.cacheSeconds);
      return;
    }

    if (url.pathname.startsWith(SKIN_PUBLIC_PREFIX)) {
      // only exact generated file names resolve, so there is no directory listing and no way out of the folder
      const filePath = skins.filePath(url.pathname.slice(SKIN_PUBLIC_PREFIX.length));
      // the name is random and the content never changes, so the URL can be cached forever
      if (!filePath || !(await serveFile(req, res, filePath, 200, "public, max-age=31536000, immutable"))) {
        sendError(res, 404, "not-found", "Skin not found");
      }
      return;
    }

    if (url.pathname.startsWith("/media/gallery/")) {
      const filePath = gallery.imagePath(url.pathname.slice("/media/gallery/".length));
      if (!filePath || !(await serveFile(req, res, filePath, 200, "public, max-age=86400"))) {
        sendError(res, 404, "not-found", "Image not found");
      }
      return;
    }

    for (const candidate of staticCandidates(config.publicDir, url.pathname)) {
      if (await serveFile(req, res, candidate)) {
        return;
      }
    }
    if (!(await serveFile(req, res, path.join(config.publicDir, "404.html"), 404))) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not found. Build the site with npm run build.");
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`[http] ${req.method} ${req.url} failed:`, error);
      if (!res.headersSent) {
        sendError(res, 500, "internal-error", "Something went wrong on the server");
      } else {
        res.destroy();
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  let stopSampler: (() => void) | null = null;
  let sessionSweep: NodeJS.Timeout | null = null;

  return {
    server,
    async start(): Promise<void> {
      await history.load();
      deleteExpiredSessions(db);
      sessionSweep = setInterval(() => deleteExpiredSessions(db), SESSION_SWEEP_MS);
      sessionSweep.unref();
      stopSampler = startHistorySampler(
        history,
        async () => {
          const current = await status.refresh();
          return current.online ? (current.players?.online ?? 0) : -1;
        },
        config.history.intervalSeconds,
      );
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
    },
    async stop(): Promise<void> {
      stopSampler?.();
      if (sessionSweep) {
        clearInterval(sessionSweep);
      }
      limiter.stop();
      authLimiter.stop();
      uploadLimiter.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }

  const app = createApp(config);
  await app.start();
  console.info(`[http] Listening on http://${config.host}:${config.port}`);
  if (!config.map.url) {
    console.info("[map] MAP_URL is not set, the site shows the map as not set up yet");
  }
  if (!config.auth.inviteCode) {
    console.info("[auth] REGISTER_INVITE_CODE is not set, registration is closed");
  }
  if (!config.auth.cookieSecure) {
    console.warn("[auth] COOKIE_SECURE is false, the session cookie also travels over plain http");
  }

  const shutdown = (signal: string): void => {
    console.info(`[http] ${signal} received, shutting down`);
    app.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
    // do not hang on keep-alive connections
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  await main();
}
