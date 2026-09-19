import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { decodePng, encodePng } from "../src/images/png.ts";
import { createApp } from "../src/index.ts";

const INVITE = "our-server-2026";
const MARKET_TOKEN = "market-token-for-the-site-at-least-24";
const LEV_UUID = "11111111-2222-3333-4444-555555555555";
const MASHA_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

interface Call {
  method: string;
  path: string;
  authorization: string;
  idempotencyKey: string | null;
  body: Record<string, unknown> | null;
}

/**
 * A stand in for the marketplace plugin. It records what the site sent, which is the whole point of these tests: the
 * site must put the account's own UUID into the request and must never pass one through from the browser.
 */
function fakePlugin(): { server: Server; calls: Call[]; fail: (code: string | null) => void; beOld: (old: boolean) => void; start(): Promise<string> } {
  const calls: Call[] = [];
  let failWith: string | null = null;
  // an older plugin has no endpoint for a single trade
  let old = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const url = req.url ?? "/";
      const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
      calls.push({ method: req.method ?? "GET", path: url, authorization: req.headers.authorization ?? "", idempotencyKey, body });

      const send = (status: number, payload: unknown): void => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };

      if (req.headers.authorization !== `Bearer ${MARKET_TOKEN}`) {
        send(401, { error: { code: "UNAUTHORIZED", message: "no" } });
        return;
      }
      if (req.method === "POST" && !idempotencyKey) {
        send(400, { error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "no key" } });
        return;
      }
      if (failWith) {
        send(409, { error: { code: failWith, message: "refused" } });
        return;
      }
      if (old && req.method === "GET" && /^\/trades\/\d+$/.test(url)) {
        // an older plugin has no endpoint for a single trade: it falls through to its "unknown endpoint"
        send(404, { error: { code: "NOT_FOUND", message: "Unknown endpoint" } });
        return;
      }

      const listing = {
        id: 12,
        type: "TRADE",
        state: "ACTIVE",
        ownerUuid: LEV_UUID,
        recipientUuid: null,
        summary: "offers 16x diamond for 32x gold ingot",
        createdAt: "2026-09-19T10:00:00Z",
        offered: [{ summary: "16x diamond", amount: 16 }],
        wanted: [{ summary: "32x gold ingot", amount: 32 }],
      };
      if (url.startsWith("/listings?")) {
        send(200, { listings: [listing] });
      } else if (/^\/listings\/\d+$/.test(url)) {
        send(200, listing);
      } else if (url.includes("/listings") && url.includes("/players/")) {
        send(200, { listings: [listing] });
      } else if (url.includes("/trades") && url.includes("/players/")) {
        send(200, { trades: [{ id: 4, listingId: 12, ownerUuid: LEV_UUID, buyerUuid: MASHA_UUID, state: "PENDING", confirmations: [], createdAt: "x" }] });
      } else if (url.includes("/deliveries")) {
        // the plugin calls this field "item", not "summary"
        send(200, { deliveries: [{ id: 7, item: "16x diamond", amount: 16, reason: "TRADE", createdAt: "x" }] });
      } else if (req.method === "GET" && /^\/trades\/\d+$/.test(url)) {
        send(200, {
          id: 4,
          listingId: 12,
          ownerUuid: LEV_UUID,
          buyerUuid: MASHA_UUID,
          state: "PENDING",
          confirmations: [],
          createdAt: "x",
          ownerItems: [{ summary: "16x diamond", amount: 16 }],
          buyerItems: [{ summary: "32x gold ingot", amount: 32 }],
        });
      } else if (url.endsWith("/cancel")) {
        send(200, { ok: true, listingId: 12 });
      } else if (url.includes("/trades/")) {
        send(200, { ok: true, tradeId: 4, completed: url.endsWith("/confirm") });
      } else if (url === "/health") {
        send(200, { ok: true, schema: 1 });
      } else {
        send(404, { error: { code: "LISTING_NOT_FOUND", message: "no" } });
      }
    });
  });

  return {
    server,
    calls,
    fail: (code) => {
      failWith = code;
    },
    beOld: (value) => {
      old = value;
    },
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
  };
}

describe("marketplace section", () => {
  let dir: string;
  let baseUrl: string;
  let app: ReturnType<typeof createApp>;
  const plugin = fakePlugin();
  let lev = "";
  let stranger = "";

  const post = (endpoint: string, body: unknown, cookie?: string): Promise<Response> =>
    fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  const get = (endpoint: string, cookie?: string): Promise<Response> =>
    fetch(`${baseUrl}${endpoint}`, { headers: cookie ? { Cookie: cookie } : {} });

  const signUp = async (username: string, nick: string): Promise<string> => {
    const response = await post("/api/auth/register", {
      username,
      password: "lantern-and-deepslate",
      passwordConfirm: "lantern-and-deepslate",
      minecraftUsername: nick,
      inviteCode: INVITE,
    });
    assert.equal(response.status, 201);
    return (response.headers.getSetCookie().find((cookie) => cookie.startsWith("os_session=")) ?? "").split(";")[0]!;
  };

  before(async () => {
    const marketUrl = await plugin.start();
    dir = await mkdtemp(path.join(os.tmpdir(), "market-"));
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    await mkdir(path.join(dir, "minecraft"), { recursive: true });
    // only LevPlays has ever logged in to the Minecraft server
    await writeFile(
      path.join(dir, "minecraft", "usercache.json"),
      JSON.stringify([{ name: "LevPlays", uuid: LEV_UUID, expiresOn: "2027-01-01 00:00:00 +0000" }]),
    );

    const config = loadConfig({
      PUBLIC_DIR: path.join(dir, "public"),
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      SKIN_UPLOAD_DIR: path.join(dir, "uploads", "skins"),
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      RATE_LIMIT_MAX_REQUESTS: "1000",
      AUTH_RATE_LIMIT_MAX_REQUESTS: "200",
      REGISTER_INVITE_CODE: INVITE,
      COOKIE_SECURE: "false",
      MARKET_API_URL: marketUrl,
      MARKET_API_TOKEN: MARKET_TOKEN,
      MARKET_CACHE_SECONDS: "0",
      MARKET_ACTION_LIMIT_MAX_REQUESTS: "100",
    });
    app = createApp({ ...config, port: 0 });
    await app.start();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    lev = await signUp("Lev", "LevPlays");
    stranger = await signUp("Masha", "MashaBuilds");
  });

  after(async () => {
    await app.stop();
    await new Promise<void>((resolve) => plugin.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("shows the board to anybody, signed in or not", async () => {
    const response = await get("/api/market/listings?limit=5");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { listings: { id: number; summary: string }[] };
    assert.equal(body.listings[0]?.id, 12);
    assert.match(body.listings[0]?.summary ?? "", /diamond/);
  });

  it("refuses a page that is not a page", async () => {
    assert.equal((await get("/api/market/listings?limit=0")).status, 400);
    assert.equal((await get("/api/market/listings?limit=nine")).status, 400);
    assert.equal((await get("/api/market/listings?type=EVERYTHING")).status, 400);
  });

  it("keeps the token to itself", async () => {
    const response = await get("/api/market/listings?limit=5");
    const text = await response.text();
    assert.ok(!text.includes(MARKET_TOKEN), "the token must never reach the browser");
    const config = await (await get("/api/config")).text();
    assert.ok(!config.includes(MARKET_TOKEN));
    assert.match(config, /"market":\{"enabled":true\}/);
  });

  it("asks nobody who is not signed in", async () => {
    assert.equal((await get("/api/market/mine")).status, 401);
    assert.equal((await post("/api/market/listings/cancel", { listingId: 12 })).status, 401);
  });

  it("gathers a player's listings, trades and parcels in one answer", async () => {
    const response = await get("/api/market/mine", lev);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { linked: boolean; minecraftUuid: string; listings: unknown[]; trades: unknown[]; deliveries: unknown[] };
    assert.equal(body.linked, true);
    assert.equal(body.minecraftUuid, LEV_UUID);
    assert.equal(body.listings.length, 1);
    assert.equal(body.trades.length, 1);
    assert.equal(body.deliveries.length, 1);
  });

  it("says plainly when an account has never been seen in the game", async () => {
    const body = (await (await get("/api/market/mine", stranger)).json()) as { linked: boolean; listings: unknown[] };
    assert.equal(body.linked, false);
    assert.deepEqual(body.listings, []);
  });

  it("sends the account's own UUID, never one from the browser", async () => {
    plugin.calls.length = 0;
    const response = await post("/api/market/listings/cancel", { listingId: 12, minecraftUuid: MASHA_UUID }, lev);
    assert.equal(response.status, 200);
    const call = plugin.calls.find((entry) => entry.method === "POST");
    assert.equal(call?.path, "/listings/12/cancel");
    assert.equal(call?.body?.["minecraftUuid"], LEV_UUID, "the UUID in the body was ignored");
    assert.ok(call?.idempotencyKey, "every action carries an idempotency key");
  });

  it("refuses an action from an account the Minecraft server has never seen", async () => {
    const response = await post("/api/market/listings/cancel", { listingId: 12 }, stranger);
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, "minecraft-not-linked");
  });

  it("checks the ids and the action name before calling anything", async () => {
    plugin.calls.length = 0;
    for (const body of [{ listingId: 0 }, { listingId: -1 }, { listingId: "12" }, {}]) {
      assert.equal((await post("/api/market/listings/cancel", body, lev)).status, 400);
    }
    assert.equal((await post("/api/market/trades/action", { tradeId: 4, action: "steal" }, lev)).status, 400);
    assert.equal(plugin.calls.length, 0, "nothing reached the marketplace");
  });

  it("carries the three trade answers through", async () => {
    for (const action of ["accept", "decline", "confirm"]) {
      plugin.calls.length = 0;
      const response = await post("/api/market/trades/action", { tradeId: 4, action }, lev);
      assert.equal(response.status, 200);
      assert.equal(plugin.calls.find((entry) => entry.method === "POST")?.path, `/trades/4/${action}`);
    }
  });

  it("reads a parcel out of the field the plugin actually sends", async () => {
    const body = (await (await get("/api/market/mine", lev)).json()) as { deliveries: { summary: string; amount: number }[] };
    assert.equal(body.deliveries[0]?.summary, "16x diamond");
    assert.equal(body.deliveries[0]?.amount, 16);
  });

  it("serves a player's face once they have a skin here", async () => {
    // a 64x64 skin with one known pixel where a face always starts
    const pixels = Buffer.alloc(64 * 64 * 4);
    const at = (8 * 64 + 8) * 4;
    pixels[at] = 200;
    pixels[at + 1] = 90;
    pixels[at + 2] = 40;
    pixels[at + 3] = 255;
    const upload = await fetch(`${baseUrl}/api/skins`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Cookie: lev },
      body: new Uint8Array(encodePng({ width: 64, height: 64, data: pixels })),
    });
    assert.equal(upload.status, 201);

    const board = (await (await get("/api/market/listings")).json()) as { players: Record<string, { headUrl: string | null }> };
    const headUrl = board.players[LEV_UUID]?.headUrl;
    assert.equal(headUrl, `/api/market/head/${LEV_UUID}.png`);

    const face = await get(headUrl!);
    assert.equal(face.status, 200, "the face must actually be served, not fall through to the API 404");
    assert.equal(face.headers.get("content-type"), "image/png");
    const rendered = decodePng(Buffer.from(await face.arrayBuffer()));
    assert.equal(rendered.width, 64);
    assert.deepEqual([rendered.data[0], rendered.data[1], rendered.data[2]], [200, 90, 40]);

    assert.equal((await get("/api/market/head/not-a-uuid.png")).status, 404);
    assert.equal((await get(`/api/market/head/${MASHA_UUID}.png`)).status, 404, "no skin, no face");
  });

  it("puts a name to every UUID it shows", async () => {
    const board = (await (await get("/api/market/listings")).json()) as { players: Record<string, { name: string | null; headUrl: string | null }> };
    assert.equal(board.players[LEV_UUID]?.name, "LevPlays", "the name comes from the server's own usercache.json");

    const mine = (await (await get("/api/market/mine", lev)).json()) as { players: Record<string, { name: string | null }> };
    assert.equal(mine.players[LEV_UUID]?.name, "LevPlays", "both sides of a trade are named");
    assert.ok(MASHA_UUID in mine.players);
  });

  it("shows both halves of a trade to the people in it, and to nobody else", async () => {
    const answer = await get("/api/market/trade?id=4", lev);
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as { trade: { ownerItems: { summary: string }[]; buyerItems: { summary: string }[] }; you: string };
    assert.equal(body.you, LEV_UUID);
    assert.equal(body.trade.ownerItems[0]?.summary, "16x diamond");
    assert.equal(body.trade.buyerItems[0]?.summary, "32x gold ingot");

    assert.equal((await get("/api/market/trade?id=4")).status, 401, "not signed in");
    assert.equal((await get("/api/market/trade?id=abc", lev)).status, 400);
  });

  it("still shows a trade when the plugin is too old to report both halves", async () => {
    plugin.beOld(true);
    const response = await get("/api/market/trade?id=4", lev);
    assert.equal(response.status, 200, "details must open for every trade, old plugin or not");
    const body = (await response.json()) as { partial: boolean; trade: { state: string; ownerItems: { summary: string }[]; buyerItems: unknown[] } };
    assert.equal(body.partial, true);
    assert.equal(body.trade.state, "PENDING", "the state still comes through");
    assert.equal(body.trade.ownerItems[0]?.summary, "16x diamond", "the listing supplies the owner's half");
    assert.deepEqual(body.trade.buyerItems, [], "and the buyer's half is honestly empty");

    // and a trade this player has nothing to do with is still not readable
    assert.equal((await get("/api/market/trade?id=999", lev)).status, 404);
    plugin.beOld(false);
  });

  it("archives a trade for one player without touching the marketplace", async () => {
    plugin.calls.length = 0;
    assert.equal((await post("/api/market/trades/archive", { tradeId: 4 }, lev)).status, 200);
    assert.equal(plugin.calls.length, 0, "archiving never reaches the game server");

    let mine = (await (await get("/api/market/mine", lev)).json()) as { trades: { id: number; archived: boolean }[] };
    assert.equal(mine.trades.find((trade) => trade.id === 4)?.archived, true);

    assert.equal((await post("/api/market/trades/archive", { tradeId: 4, restore: true }, lev)).status, 200);
    mine = (await (await get("/api/market/mine", lev)).json()) as { trades: { id: number; archived: boolean }[] };
    assert.equal(mine.trades.find((trade) => trade.id === 4)?.archived, false);

    assert.equal((await post("/api/market/trades/archive", { tradeId: 0 }, lev)).status, 400);
    assert.equal((await post("/api/market/trades/archive", { tradeId: 4 })).status, 401);
  });

  it("turns a refusal from the plugin into the site's own error code", async () => {
    plugin.fail("NOT_OWNER");
    const response = await post("/api/market/listings/cancel", { listingId: 12 }, lev);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "not-owner");

    plugin.fail("LISTING_ALREADY_TAKEN");
    assert.equal((await post("/api/market/listings/cancel", { listingId: 12 }, lev)).status, 409);
    plugin.fail(null);
  });
});

describe("marketplace section, not configured", () => {
  let dir: string;
  let baseUrl: string;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "market-off-"));
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    const config = loadConfig({
      PUBLIC_DIR: path.join(dir, "public"),
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      SKIN_UPLOAD_DIR: path.join(dir, "uploads", "skins"),
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      COOKIE_SECURE: "false",
    });
    app = createApp({ ...config, port: 0 });
    await app.start();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("says the section is switched off instead of failing", async () => {
    const response = await fetch(`${baseUrl}/api/market/listings`);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, "market-disabled");
    const config = await (await fetch(`${baseUrl}/api/config`)).text();
    assert.match(config, /"market":\{"enabled":false\}/);
  });
});

describe("marketplace configuration", () => {
  it("needs both halves or neither", () => {
    assert.throws(() => loadConfig({ MARKET_API_URL: "http://127.0.0.1:8788/api/v1/market" }), /set together/);
    assert.throws(() => loadConfig({ MARKET_API_TOKEN: MARKET_TOKEN }), /set together/);
    assert.throws(
      () => loadConfig({ MARKET_API_URL: "http://127.0.0.1:8788/api/v1/market", MARKET_API_TOKEN: "short" }),
      /at least 24 characters/,
    );
  });

  it("refuses to send the token off this machine in the clear", () => {
    assert.throws(() => loadConfig({ MARKET_API_URL: "http://example.com/api", MARKET_API_TOKEN: MARKET_TOKEN }), /https/);
    const fine = loadConfig({ MARKET_API_URL: "https://example.com/api", MARKET_API_TOKEN: MARKET_TOKEN });
    assert.equal(fine.market.url, "https://example.com/api");
  });
});
