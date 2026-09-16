import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/index.ts";

describe("HTTP API", () => {
  let dir: string;
  let baseUrl: string;
  let app: ReturnType<typeof createApp>;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "app-test-"));
    const publicDir = path.join(dir, "public");
    await mkdir(path.join(publicDir, "launcher"), { recursive: true });
    await writeFile(path.join(publicDir, "index.html"), "<h1>home</h1>");
    await writeFile(path.join(publicDir, "launcher", "index.html"), "<h1>launcher</h1>");
    await writeFile(path.join(publicDir, "404.html"), "<h1>not found</h1>");
    await writeFile(path.join(dir, "secret.txt"), "secret");
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));

    const config = loadConfig({
      PUBLIC_DIR: publicDir,
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      // nothing listens on this port, the site must report the server as unavailable
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "1000",
      MAP_URL: "https://map.vin-off.site",
      RATE_LIMIT_MAX_REQUESTS: "40",
    });
    app = createApp({ ...config, port: 0 });
    await app.start();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an unavailable Minecraft server honestly", async () => {
    const response = await fetch(`${baseUrl}/api/server/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.online, false);
    assert.equal(body.players, null);
    assert.deepEqual(body.playerNames, []);

    const players = (await (await fetch(`${baseUrl}/api/server/players`)).json()) as Record<string, unknown>;
    assert.equal(players.count, null);
  });

  it("serves statistics as unavailable without world data", async () => {
    const stats = (await (await fetch(`${baseUrl}/api/server/stats`)).json()) as { available: boolean };
    assert.equal(stats.available, false);
    const leaderboard = (await (await fetch(`${baseUrl}/api/server/leaderboard`)).json()) as { categories: unknown[] };
    assert.ok(leaderboard.categories.length > 0);
  });

  it("validates the history range", async () => {
    assert.equal((await fetch(`${baseUrl}/api/server/online-history?hours=24`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/server/online-history?hours=0`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/server/online-history?hours=abc`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/server/online-history?hours=10000`)).status, 400);
  });

  it("exposes public configuration without server paths", async () => {
    const text = await (await fetch(`${baseUrl}/api/config`)).text();
    assert.ok(!text.includes(dir.replaceAll("\\", "\\\\")), "absolute paths are never sent to the browser");
    const config = JSON.parse(text) as { map: { url: string } };
    assert.equal(config.map.url, "https://map.vin-off.site");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/gallery`)).json(), { items: [] });
  });

  it("serves pages with security headers and rejects everything else", async () => {
    const page = await fetch(`${baseUrl}/launcher`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>launcher</h1>");
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-src https:\/\/map\.vin-off\.site/);
    assert.match(csp, /script-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    assert.equal((await fetch(`${baseUrl}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/health`, { method: "POST" })).status, 405);
    const missing = await fetch(`${baseUrl}/no-such-page`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "<h1>not found</h1>");
    assert.equal((await fetch(`${baseUrl}/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/media/gallery/..%2f..%2fsecret.txt`)).status, 404);
  });

  it("rate limits the API", async () => {
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const response = await fetch(`${baseUrl}/api/health`);
      await response.arrayBuffer();
      limited = response.status === 429;
    }
    assert.ok(limited);
  });
});
