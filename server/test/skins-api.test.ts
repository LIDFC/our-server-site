import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { encodePng } from "../src/images/png.ts";
import { createApp } from "../src/index.ts";

const INVITE = "our-server-2026";

function skinPng(width = 64, height = 64, tint = 0): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i + tint) % 256;
    data[i * 4 + 1] = tint;
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = i < 8 ? 0 : 255;
  }
  return encodePng({ width, height, data });
}

describe("skin API", () => {
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

  const upload = (file: Buffer, type: string, name: string, cookie?: string): Promise<Response> =>
    fetch(`${baseUrl}/api/skins`, {
      method: "POST",
      headers: {
        "Content-Type": type,
        "X-Skin-Filename": encodeURIComponent(name),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new Uint8Array(file),
    });

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
    dir = await mkdtemp(path.join(os.tmpdir(), "skins-test-"));
    uploadDir = path.join(dir, "uploads", "skins");
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    const config = loadConfig({
      PUBLIC_DIR: path.join(dir, "public"),
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      SKIN_UPLOAD_DIR: uploadDir,
      SKIN_UPLOAD_COOLDOWN_SECONDS: "0",
      // the tests upload many times from one address
      SKIN_UPLOAD_LIMIT_MAX_REQUESTS: "500",
      PUBLIC_SITE_URL: "https://mc.vin-off.site",
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      RATE_LIMIT_MAX_REQUESTS: "1000",
      AUTH_RATE_LIMIT_MAX_REQUESTS: "200",
      REGISTER_INVITE_CODE: INVITE,
      COOKIE_SECURE: "false",
    });
    app = createApp({ ...config, port: 0 });
    await app.start();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    lev = await signUp("Lev", "LevPlays");
    masha = await signUp("Masha", "MashaBuilds");
  });

  after(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the whole skin area behind the sign in", async () => {
    assert.equal((await fetch(`${baseUrl}/api/skins/me`)).status, 401);
    assert.equal((await upload(skinPng(), "image/png", "steve.png")).status, 401);
    assert.equal((await post("/api/skins/delete", {})).status, 401);
    const anonymous = await upload(skinPng(), "image/png", "steve.png", "os_session=made-up-token");
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await readdir(uploadDir).catch(() => []), [], "nothing is written for a stranger");
  });

  it("tells a signed in player what the rules are", async () => {
    const response = await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { skin: unknown; minecraftUsername: string; limits: { maxBytes: number; sizes: string[] } };
    assert.equal(body.skin, null);
    assert.equal(body.minecraftUsername, "LevPlays");
    assert.equal(body.limits.maxBytes, 8 * 1024 * 1024);
    assert.deepEqual(body.limits.sizes, ["64x64", "64x32"]);
  });

  it("stores a PNG under a random name and serves it back", async () => {
    const response = await upload(skinPng(), "image/png", "steve.png", lev);
    assert.equal(response.status, 201);
    const skin = ((await response.json()) as { skin: Record<string, unknown> }).skin;
    assert.equal(skin.width, 64);
    assert.equal(skin.height, 64);
    assert.equal(skin.converted, false);
    assert.equal(skin.originalFileName, "steve.png");
    assert.match(String(skin.url), /^https:\/\/mc\.vin-off\.site\/skins\/[0-9a-f]{32}\.png$/);
    // the default name is the player's nickname, so /skin levplays is easy to remember
    assert.equal(skin.skinName, "levplays");
    assert.equal(skin.command, `/sr createcustom ${String(skin.skinName)} "${String(skin.url)}"`);

    const stored = new URL(String(skin.url)).pathname;
    const served = await fetch(`${baseUrl}${stored}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    assert.ok(bytes.equals(await readFile(path.join(uploadDir, path.basename(stored)))));

    const files = await readdir(uploadDir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[0-9a-f]{32}\.png$/, "the name never comes from the upload");
    assert.ok(!files[0]!.includes("steve"));
  });

  it("converts a JPG upload into a PNG texture", async () => {
    const jpeg = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/" +
        "2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABAAEADASIAAhEBAxEB/8QA" +
        "HwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
        "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG" +
        "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC" +
        "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE" +
        "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD88rTSunFb" +
        "NppXT5a2bTSunFbNppXT5a/oOtjPM8rLcw21Me00rp8tbNppPT5a2bTSuny1s2mk9Plrwq2M8z9Vy3MNtTHtNK6fLWzaaV04rZtNK6cVs2mldOK8KtjPM/Vs" +
        "tzDbUx7TSunFbNppXTitm00rpxWzaaV0+WvCrYzzP1XLcw21Pn+00rp8tbNppXT5a2bTSuny1s2mldPlr3q2M8z/AC3y3H7amPaaT0+Wtm00rp8tbNppPT5a" +
        "2bTSunFeFWxnmfquW4/bUx7TSunFbNppXTitm00rpxW1aaV04rw62M8z9Wy3H7amNaaV04ratNK6fLWxaaV0+Wtq00rp8teFWxnmfquW4/bU+frTSuny1tWm" +
        "k9PlrYtNK6fLW1aaT0+WverYzzP8uMtx+2pjWmldPlratNK6cVsWmldOK2rTSuny14VbGeZ+q5bj9tTGtNK6cVtWmldOK2LTSunFbVppXT5a8KtjPM/Vstx+" +
        "2pjWmldPlratNK6fLWxaaV0+Wtq00rp8teFWxnmfquW4/bU+frTSeny1tWmldPlrYtNJ6fLW1aaV04r3q2M8z/LfLcftqY1ppXTitq00rpxWxaaV0+Wtq00r" +
        "pxXhVsZ5n6tluP21Ma00rpxW1aaV0+Wti00rp8tbVppXT5a8KtjPM/Vctx+2pjWmldPlratNK6fLWxaaV0+Wtq00rp8teHWxnmfquW4/bU//2Q==",
      "base64",
    );
    const response = await upload(jpeg, "image/jpeg", "selfie.jpg", masha);
    assert.equal(response.status, 201);
    const skin = ((await response.json()) as { skin: Record<string, unknown> }).skin;
    assert.equal(skin.converted, true);
    assert.equal(skin.sourceType, "image/jpeg");
    assert.match(String(skin.url), /\.png$/);

    const served = await fetch(`${baseUrl}${new URL(String(skin.url)).pathname}`);
    assert.equal(served.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "a real PNG, not a renamed JPG");
  });

  it("refuses everything that is not a Minecraft skin", async () => {
    const cases: [Buffer, string, string, number, string][] = [
      [Buffer.from("GIF89a" + "x".repeat(64)), "image/gif", "a.gif", 400, "format-gif"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml", "a.svg", 400, "format-svg"],
      [Buffer.from("PK" + "x".repeat(64), "latin1"), "application/zip", "a.zip", 400, "format-archive"],
      [Buffer.from("MZ" + "x".repeat(64), "latin1"), "application/octet-stream", "a.exe", 400, "format-executable"],
      [Buffer.alloc(64, 9), "image/png", "fake.png", 400, "format-unknown"],
      [skinPng(32, 32), "image/png", "small.png", 400, "bad-size"],
      [skinPng().subarray(0, 60), "image/png", "cut.png", 400, "broken-png"],
      [skinPng(), "image/png", "wrong-name.jpg", 400, "extension-mismatch"],
    ];
    for (const [file, type, name, status, code] of cases) {
      const response = await upload(file, type, name, lev);
      assert.equal(response.status, status, `${name} should be refused`);
      assert.equal(((await response.json()) as { error: string }).error, code, name);
    }
    // the skin that was already there is untouched
    const current = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { width: number } };
    assert.equal(current.skin.width, 64);
  });

  it("stops an upload that is over the limit", async () => {
    const huge = Buffer.alloc(9 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge);
    const response = await upload(huge, "image/png", "huge.png", lev);
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: string }).error, "file-too-large");
  });

  it("replaces the old skin and removes only the old file", async () => {
    const before = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { url: string } };
    const oldName = path.basename(new URL(before.skin.url).pathname);

    const response = await upload(skinPng(64, 32, 90), "image/png", "new.png", lev);
    assert.equal(response.status, 201);
    const skin = ((await response.json()) as { skin: { url: string; height: number } }).skin;
    assert.equal(skin.height, 32);
    assert.notEqual(skin.url, before.skin.url, "a new file means a new stable URL");

    const files = await readdir(uploadDir);
    assert.ok(!files.includes(oldName), "the previous file is gone");
    assert.ok(files.includes(path.basename(new URL(skin.url).pathname)));
    assert.equal(files.length, 2, "Lev has one skin and Masha has one");
    assert.equal((await fetch(`${baseUrl}/skins/${oldName}`)).status, 404);
  });

  it("keeps the old skin when a new upload is refused", async () => {
    const before = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { url: string } };
    assert.equal((await upload(Buffer.from("GIF89a" + "x".repeat(64)), "image/gif", "a.gif", lev)).status, 400);
    const after = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { url: string } };
    assert.equal(after.skin.url, before.skin.url);
    assert.equal((await fetch(`${baseUrl}${new URL(after.skin.url).pathname}`)).status, 200, "the working skin still answers");
  });

  it("never lets one account touch another one's skin", async () => {
    const mine = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { url: string } };
    const theirs = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: masha } })).json()) as { skin: { url: string } };
    assert.notEqual(mine.skin.url, theirs.skin.url);

    // there is no skin id or account id in the API, so the only thing to try is a forged request
    for (const forged of [
      { endpoint: "/api/skins/delete", body: { userId: 1, id: 1, url: theirs.skin.url } },
      { endpoint: "/api/skins/delete", body: { minecraftUsername: "MashaBuilds" } },
    ]) {
      const response = await post(forged.endpoint, forged.body, lev);
      assert.ok(response.status === 204 || response.status === 404);
      const stillThere = await fetch(`${baseUrl}${new URL(theirs.skin.url).pathname}`);
      assert.equal(stillThere.status, 200, "Masha's file is untouched");
      const mashaNow = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: masha } })).json()) as { skin: { url: string } };
      assert.equal(mashaNow.skin.url, theirs.skin.url, "Masha still owns her skin");
      // put Lev's own skin back for the next round
      await upload(skinPng(64, 64, 5), "image/png", "again.png", lev);
    }
  });

  it("serves only generated skin names", async () => {
    for (const suspicious of [
      "/skins/",
      "/skins/../../etc/passwd",
      "/skins/..%2f..%2fdata%2fsite.db",
      "/skins/%2e%2e/%2e%2e/data/site.db",
      "/skins/site.db",
      "/skins/0123456789abcdef0123456789abcdef.png.txt",
      "/skins/ABCDEF0123456789ABCDEF0123456789.png",
    ]) {
      const response = await fetch(`${baseUrl}${suspicious}`);
      assert.equal(response.status, 404, suspicious);
    }
  });

  it("removes a skin only for its owner", async () => {
    const mine = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: { url: string } };
    const fileName = path.basename(new URL(mine.skin.url).pathname);

    const removed = await post("/api/skins/delete", {}, lev);
    assert.equal(removed.status, 204);
    const after = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: lev } })).json()) as { skin: unknown };
    assert.equal(after.skin, null);
    assert.ok(!(await readdir(uploadDir)).includes(fileName), "the file is gone with the record");
    assert.equal((await fetch(`${baseUrl}/skins/${fileName}`)).status, 404);

    // a second delete is not an error for the player, it just says there is nothing there
    assert.equal((await post("/api/skins/delete", {}, lev)).status, 404);

    const mashaStill = (await (await fetch(`${baseUrl}/api/skins/me`, { headers: { Cookie: masha } })).json()) as { skin: { url: string } };
    assert.equal((await fetch(`${baseUrl}${new URL(mashaStill.skin.url).pathname}`)).status, 200);
  });

  it("only accepts uploads from this site", async () => {
    const foreign = await fetch(`${baseUrl}/api/skins`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Cookie: lev, Origin: "https://evil.example" },
      body: new Uint8Array(skinPng()),
    });
    assert.equal(foreign.status, 403);
    assert.equal(((await foreign.json()) as { error: string }).error, "bad-origin");
    assert.equal((await fetch(`${baseUrl}/api/skins`, { headers: { Cookie: lev } })).status, 405);
  });
});

describe("skin upload limits", () => {
  it("waits between two uploads of the same account", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "skins-cooldown-"));
    await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
    await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
    const config = loadConfig({
      PUBLIC_DIR: path.join(dir, "public"),
      DATA_DIR: path.join(dir, "data"),
      GALLERY_DIR: path.join(dir, "gallery"),
      MC_SERVER_DIR: path.join(dir, "minecraft"),
      SKIN_UPLOAD_DIR: path.join(dir, "uploads", "skins"),
      SKIN_UPLOAD_COOLDOWN_SECONDS: "60",
      MC_PORT: "1",
      STATUS_TIMEOUT_MS: "500",
      REGISTER_INVITE_CODE: INVITE,
      COOKIE_SECURE: "false",
    });
    const app = createApp({ ...config, port: 0 });
    await app.start();
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Lev",
        password: "lantern-and-deepslate",
        passwordConfirm: "lantern-and-deepslate",
        minecraftUsername: "LevPlays",
        inviteCode: INVITE,
      }),
    });
    const cookie = (registration.headers.getSetCookie().find((item) => item.startsWith("os_session=")) ?? "").split(";")[0]!;
    const send = (): Promise<Response> =>
      fetch(`${baseUrl}/api/skins`, { method: "POST", headers: { "Content-Type": "image/png", Cookie: cookie }, body: new Uint8Array(skinPng()) });

    assert.equal((await send()).status, 201);
    const again = await send();
    assert.equal(again.status, 429);
    assert.equal(((await again.json()) as { error: string }).error, "upload-cooldown");

    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
