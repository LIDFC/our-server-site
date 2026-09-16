import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { ConfigError, loadConfig, type Config } from "./config.ts";
import { clientAddress, securityHeaders, sendError, sendJson, serveFile, staticCandidates } from "./http.ts";
import { createRateLimiter } from "./rateLimit.ts";
import { createFileGalleryStore } from "./services/gallery.ts";
import { createHistoryStore, startHistorySampler } from "./services/history.ts";
import { createLauncherService } from "./services/launcher.ts";
import { buildLeaderboard, createStatsService } from "./services/stats.ts";
import { createStatusService } from "./services/status.ts";

type Handler = (url: URL) => Promise<{ status?: number; body: unknown; cacheSeconds?: number }>;

export function createApp(config: Config) {
  const status = createStatusService(config);
  const stats = createStatsService(config);
  const launcher = createLauncherService(config);
  const gallery = createFileGalleryStore(config.galleryDir);
  const history = createHistoryStore(path.join(config.dataDir, "online-history.json"), config.history.retentionDays, config.history.intervalSeconds);
  const limiter = createRateLimiter(config.rateLimit);
  const headers = securityHeaders(config.map.url);

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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendError(res, 405, "method-not-allowed", "Only GET and HEAD are supported");
      return;
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
      const limit = limiter.check(clientAddress(req, config.trustProxy));
      if (!limit.allowed) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        sendError(res, 429, "rate-limited", "Too many requests, try again later");
        return;
      }
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

  return {
    server,
    async start(): Promise<void> {
      await history.load();
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
      limiter.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
