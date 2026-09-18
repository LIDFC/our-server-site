import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { encodePng } from "../src/images/png.ts";
import { createApp } from "../src/index.ts";
import { normalizeUuid } from "../src/services/minecraft.ts";
import { checkSkinName, suggestSkinName } from "../src/services/skins.ts";

const INVITE = "our-server-2026";
const TOKEN = "integration-token-for-the-minecraft-server";
const LEV_UUID = "11111111-2222-3333-4444-555555555555";
const MASHA_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const STRANGER_UUID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

function skinPng(tint = 0): Buffer {
  const data = Buffer.alloc(64 * 64 * 4, 255);
  data[0] = tint;
  return encodePng({ width: 64, height: 64, data });
}

describe("skin names", () => {
  it("accepts a name a player can type", () => {
    assert.deepEqual(checkSkinName("LevPlays"), { ok: true, value: "levplays" });
    assert.deepEqual(checkSkinName("  lev_2  "), { ok: true, value: "lev_2" });
    for (const bad of ["ab", "a".repeat(17), "лев", "lev plays", "lev-plays", 42, null]) {
      assert.equal(checkSkinName(bad).ok, false);
    }
  });

  it("refuses names SkinsRestorer would read as a command", () => {
    for (const reserved of ["clear", "set", "reset", "update", "random", "menu"]) {
      const checked = checkSkinName(reserved);
      assert.equal(checked.ok, false);
      assert.equal(checked.ok === false && checked.error, "skin-name-reserved");
    }
  });

  it("suggests the nickname first and stays short", () => {
    assert.equal(suggestSkinName("LevPlays", () => false), "levplays");
    assert.equal(suggestSkinName("LevPlays", (name) => name === "levplays"), "levplays2");
    // a nickname that cannot be a skin name falls back to a short random one
    const random = suggestSkinName("!!", () => false);
    assert.match(random, /^[a-z0-9]{6}$/);
    const busy = suggestSkinName("LevPlays", (name) => name.startsWith("levplays"));
    assert.match(busy, /^[a-z0-9]{6}$/);
  });
});

describe("Minecraft skin synchronisation", () => {
  let dir: string;
  let baseUrl: string;
  let uploadDir: string;
  let app: ReturnType<typeof createApp>;
  let lev = "";
  let masha = "";

  const post = (endpoint: string, body: unknown, cookie?: string): Promise<Response> =>
    fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });

  const sync = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }): Promise<Response> =>
    fetch(`${baseUrl}/api/internal/minecraft/skin-cleared`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const upload = (cookie: string, tint = 0): Promise<Response> =>
    fetch(`${baseUrl}/api/skins`, { method: "POST", headers: { "Content-Type": "image/png", Cookie: cookie }, body: new Uint8Array(skinPng(tint)) });

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

  const currentSkin = async (cookie: string): Promise<{ url: string; skinName: string } | null> => {
    const body = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: cookie } })).json()) as {
      skin: { url: string; skinName: string } | null;
    };
    return body.skin;
  };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "skin-sync-"));
    uploadDir = path.join(dir, "uploads", "skins");
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    await mkdir(path.join(dir, "minecraft"), { recursive: true });
    // the server's own record of who plays under which UUID
    await writeFile(
      path.join(dir, "minecraft", "usercache.json"),
      JSON.stringify([
        { name: "LevPlays", uuid: LEV_UUID, expiresOn: "2027-01-01 00:00:00 +0000" },
        { name: "MashaBuilds", uuid: MASHA_UUID, expiresOn: "2027-01-01 00:00:00 +0000" },
        { name: "Nobody", uuid: STRANGER_UUID, expiresOn: "2027-01-01 00:00:00 +0000" },
      ]),
    );

    const config = loadConfig({
      PUBLIC_DIR: path.join(dir, "public"),
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      SKIN_UPLOAD_DIR: uploadDir,
      SKIN_UPLOAD_COOLDOWN_SECONDS: "0",
      SKIN_UPLOAD_LIMIT_MAX_REQUESTS: "500",
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      RATE_LIMIT_MAX_REQUESTS: "1000",
      AUTH_RATE_LIMIT_MAX_REQUESTS: "200",
      REGISTER_INVITE_CODE: INVITE,
      MINECRAFT_API_TOKEN: TOKEN,
      COOKIE_SECURE: "false",
    });
    app = createApp({ ...config, port: 0 });
    await app.start();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    lev = await signUp("Lev", "LevPlays");
    masha = await signUp("Masha", "MashaBuilds");
    assert.equal((await upload(lev, 1)).status, 201);
    assert.equal((await upload(masha, 2)).status, 201);
  });

  after(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("names a skin after the player and lets them choose another name", async () => {
    assert.equal((await currentSkin(lev))?.skinName, "levplays");

    const renamed = await post("/api/skins/name", { skinName: "Lev" }, lev);
    assert.equal(renamed.status, 200);
    const skin = ((await renamed.json()) as { skin: { skinName: string; command: string; url: string } }).skin;
    assert.equal(skin.skinName, "lev");
    assert.equal(skin.command, `/sr createcustom lev "${skin.url}"`);

    // the name stays with the account when a new file is uploaded
    assert.equal((await upload(lev, 3)).status, 201);
    assert.equal((await currentSkin(lev))?.skinName, "lev");
  });

  it("refuses a name that is taken, reserved or malformed", async () => {
    const taken = await post("/api/skins/name", { skinName: "lev" }, masha);
    assert.equal(taken.status, 409);
    assert.equal(((await taken.json()) as { error: string }).error, "skin-name-taken");

    const reserved = await post("/api/skins/name", { skinName: "clear" }, masha);
    assert.equal(reserved.status, 400);
    assert.equal(((await reserved.json()) as { error: string }).error, "skin-name-reserved");

    assert.equal((await post("/api/skins/name", { skinName: "a" }, masha)).status, 400);
    assert.equal((await post("/api/skins/name", { skinName: "имя" }, masha)).status, 400);
    assert.equal((await post("/api/skins/name", { skinName: "mash" })).status, 401, "a name change needs a session");
    assert.equal((await currentSkin(masha))?.skinName, "mashabuilds");
  });

  it("needs a valid token", async () => {
    const attempts: Record<string, string>[] = [{}, { Authorization: "Bearer wrong-token" }, { Authorization: TOKEN }, { Authorization: `Bearer ${TOKEN}x` }];
    for (const headers of attempts) {
      const response = await sync({ minecraftUuid: LEV_UUID }, headers);
      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(((await response.json()) as { error: string }).error, "unauthorized");
    }
    assert.ok(await currentSkin(lev), "a rejected request changes nothing");
  });

  it("is not reachable from a browser", async () => {
    // a page on the site itself: the token check is not even reached, the endpoint refuses anything with an Origin
    const sameSite = await sync({ minecraftUuid: LEV_UUID }, { Authorization: `Bearer ${TOKEN}`, Origin: baseUrl });
    assert.equal(sameSite.status, 403);
    assert.equal(((await sameSite.json()) as { error: string }).error, "browser-not-allowed");

    // a page on another site is stopped one step earlier, by the shared cross site check
    const otherSite = await sync({ minecraftUuid: LEV_UUID }, { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" });
    assert.equal(otherSite.status, 403);
    assert.equal(((await otherSite.json()) as { error: string }).error, "bad-origin");

    assert.ok(await currentSkin(lev));
  });

  it("checks what it is given", async () => {
    for (const body of [{}, { minecraftUuid: "not-a-uuid" }, { minecraftUuid: 42 }]) {
      const response = await sync(body);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: string }).error, "invalid-uuid");
    }
    const mismatch = await sync({ minecraftUuid: LEV_UUID, minecraftUsername: "MashaBuilds" });
    assert.equal(mismatch.status, 409);
    assert.equal(((await mismatch.json()) as { error: string }).error, "uuid-name-mismatch");
    assert.ok(await currentSkin(lev), "a mismatch deletes nothing");
  });

  it("says nothing happened for a UUID with no account", async () => {
    const response = await sync({ minecraftUuid: STRANGER_UUID, minecraftUsername: "Nobody" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, deleted: false, reason: "account_not_found" });
    assert.equal((await readdir(uploadDir)).length, 2, "both skins are still there");
  });

  it("removes the skin and the file of the player who cleared it", async () => {
    const before = await currentSkin(lev);
    assert.ok(before);
    const fileName = path.basename(new URL(before.url).pathname);
    assert.ok((await readdir(uploadDir)).includes(fileName));

    const response = await sync({ minecraftUuid: LEV_UUID, minecraftUsername: "LevPlays" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, deleted: true });

    assert.equal(await currentSkin(lev), null, "the site shows no skin any more");
    assert.ok(!(await readdir(uploadDir)).includes(fileName), "the file is gone");
    assert.equal((await fetch(`${baseUrl}/skins/${fileName}`)).status, 404, "the old URL stops working");

    // Masha kept hers
    const hers = await currentSkin(masha);
    assert.ok(hers);
    assert.equal((await fetch(`${baseUrl}${new URL(hers.url).pathname}`)).status, 200);
  });

  it("repeats without complaining", async () => {
    const again = await sync({ minecraftUuid: LEV_UUID, minecraftUsername: "LevPlays" });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { success: true, deleted: false, reason: "skin_not_found" });
    assert.ok(await currentSkin(masha), "and still touches nobody else");
  });

  it("finds the account by UUID once it has been linked", async () => {
    // upload again and rename the player in Minecraft: the UUID is what the site now goes by
    assert.equal((await upload(lev, 4)).status, 201);
    assert.equal((await post("/api/auth/profile", { minecraftUsername: "LevRenamed" }, lev)).status, 200);

    const response = await sync({ minecraftUuid: LEV_UUID });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, deleted: true });
    assert.equal(await currentSkin(lev), null);
  });

  it("keeps the integration closed without a token in the configuration", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "skin-sync-off-"));
    await mkdir(path.join(other, "gallery", "images"), { recursive: true });
    await writeFile(path.join(other, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    const config = loadConfig({
      PUBLIC_DIR: path.join(other, "public"),
      DATA_DIR: path.join(other, "data"),
      GALLERY_DIR: path.join(other, "gallery"),
      MC_SERVER_DIR: path.join(other, "minecraft"),
      SKIN_UPLOAD_DIR: path.join(other, "uploads", "skins"),
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      COOKIE_SECURE: "false",
    });
    const closed = createApp({ ...config, port: 0 });
    await closed.start();
    const closedUrl = `http://127.0.0.1:${(closed.server.address() as AddressInfo).port}`;
    const response = await fetch(`${closedUrl}/api/internal/minecraft/skin-cleared`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ minecraftUuid: LEV_UUID }),
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, "integration-disabled");
    await closed.stop();
    await rm(other, { recursive: true, force: true });
  });
});

describe("Minecraft UUIDs", () => {
  it("reads both shapes and refuses the rest", () => {
    assert.equal(normalizeUuid("11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
    assert.equal(normalizeUuid("11111111222233334444555555555555"), "11111111-2222-3333-4444-555555555555");
    assert.equal(normalizeUuid("11111111-2222-3333-4444-555555555555".toUpperCase()), "11111111-2222-3333-4444-555555555555");
    for (const bad of ["", "not-a-uuid", "1111", 42, null, "../../etc/passwd"]) {
      assert.equal(normalizeUuid(bad), null);
    }
  });
});
