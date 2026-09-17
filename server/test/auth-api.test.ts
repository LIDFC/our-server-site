import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/index.ts";

const INVITE = "our-server-2026";

async function startApp(extraEnv: Record<string, string>): Promise<{ app: ReturnType<typeof createApp>; baseUrl: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "auth-test-"));
  await mkdir(path.join(dir, "gallery", "images"), { recursive: true });
  await writeFile(path.join(dir, "gallery", "gallery.json"), JSON.stringify({ items: [] }));
  const config = loadConfig({
    PUBLIC_DIR: path.join(dir, "public"),
    DATA_DIR: path.join(dir, "data"),
    GALLERY_DIR: path.join(dir, "gallery"),
    MC_SERVER_DIR: path.join(dir, "minecraft"),
    MC_PORT: "1",
    STATUS_TIMEOUT_MS: "500",
    // the tests make many requests from one address
    RATE_LIMIT_MAX_REQUESTS: "1000",
    AUTH_RATE_LIMIT_MAX_REQUESTS: "200",
    // no https in tests
    COOKIE_SECURE: "false",
    ...extraEnv,
  });
  const app = createApp({ ...config, port: 0 });
  await app.start();
  return { app, baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, dir };
}

function sessionOf(response: Response): string {
  const raw = response.headers.getSetCookie().find((cookie) => cookie.startsWith("os_session="));
  assert.ok(raw, "the answer carries a session cookie");
  return raw.split(";")[0]!;
}

describe("account API", () => {
  let baseUrl: string;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let levCookie = "";
  let mashaCookie = "";

  const post = (endpoint: string, body: unknown, cookie?: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });

  const register = (username: string, password: string, minecraftUsername: string, inviteCode = INVITE): Promise<Response> =>
    post("/api/auth/register", { username, password, passwordConfirm: password, minecraftUsername, inviteCode });

  before(async () => {
    ({ app, baseUrl, dir } = await startApp({ REGISTER_INVITE_CODE: INVITE }));
  });

  after(async () => {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("registers an account and signs it in", async () => {
    const response = await register("Lev", "lantern-and-deepslate", "LevPlays");
    assert.equal(response.status, 201);
    const cookie = sessionOf(response);
    levCookie = cookie;
    assert.match(cookie, /^os_session=[A-Za-z0-9_-]{32,}$/);
    const raw = response.headers.getSetCookie()[0]!;
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Lax/);
    assert.match(raw, /Path=\//);
    assert.ok(!raw.includes("Secure"), "COOKIE_SECURE=false in tests, production sets it");
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = (await response.json()) as { user: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.user).sort(), ["createdAt", "id", "minecraftUsername", "username"]);
    assert.equal(body.user.username, "Lev");
    assert.equal(body.user.minecraftUsername, "LevPlays");
  });

  it("refuses a second account with the same username or Minecraft name", async () => {
    const sameName = await register("lev", "another-long-password", "SomebodyElse");
    assert.equal(sameName.status, 409);
    assert.equal(((await sameName.json()) as { error: string }).error, "username-taken");

    const sameNick = await register("Somebody", "another-long-password", "levplays");
    assert.equal(sameNick.status, 409);
    assert.equal(((await sameNick.json()) as { error: string }).error, "minecraft-username-taken");
  });

  it("refuses broken registration data", async () => {
    const short = await register("Shorty", "abc", "Shorty");
    assert.equal(short.status, 400);
    assert.equal(((await short.json()) as { error: string }).error, "invalid-password");

    const mismatch = await post("/api/auth/register", {
      username: "Mismatch",
      password: "long-enough-password",
      passwordConfirm: "long-enough-passwore",
      minecraftUsername: "Mismatch",
      inviteCode: INVITE,
    });
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as { error: string }).error, "password-mismatch");

    assert.equal((await register("Bad Name", "long-enough-password", "BadName")).status, 400);
    assert.equal((await register("GoodName", "long-enough-password", "no")).status, 400);

    const wrongInvite = await register("Stranger", "long-enough-password", "Stranger", "no-idea");
    assert.equal(wrongInvite.status, 403);
    assert.equal(((await wrongInvite.json()) as { error: string }).error, "invalid-invite");
  });

  it("only takes JSON from this site", async () => {
    const form = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=Lev&password=lantern-and-deepslate",
    });
    assert.equal(form.status, 415);

    const foreign = await post("/api/auth/login", { username: "Lev", password: "lantern-and-deepslate" }, undefined, {
      Origin: "https://evil.example",
    });
    assert.equal(foreign.status, 403);
    assert.equal(((await foreign.json()) as { error: string }).error, "bad-origin");

    const broken = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(broken.status, 400);

    // reading the account is a GET, the other auth endpoints are POST only
    assert.equal((await fetch(`${baseUrl}/api/auth/login`)).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 405);
  });

  it("signs in and answers the same way to a wrong name and a wrong password", async () => {
    const good = await post("/api/auth/login", { username: "lev", password: "lantern-and-deepslate" });
    assert.equal(good.status, 200);
    levCookie = sessionOf(good);

    const wrongPassword = await post("/api/auth/login", { username: "Lev", password: "lantern-and-deepslat" });
    const unknownAccount = await post("/api/auth/login", { username: "NobodyHere", password: "lantern-and-deepslate" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    assert.deepEqual(await wrongPassword.json(), await unknownAccount.json());
  });

  it("knows who is signed in and keeps the session across requests", async () => {
    assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
    const anonymous = (await (await fetch(`${baseUrl}/api/auth/me`)).json()) as { error: string };
    assert.equal(anonymous.error, "unauthenticated");

    for (let attempt = 0; attempt < 3; attempt++) {
      const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: levCookie } });
      assert.equal(me.status, 200);
      assert.equal(((await me.json()) as { user: { username: string } }).user.username, "Lev");
    }

    const garbage = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: "os_session=made-up-token" } });
    assert.equal(garbage.status, 401);
  });

  it("changes the Minecraft name, keeping the account id", async () => {
    const me = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: levCookie } })).json()) as { user: { id: number } };
    const renamed = await post("/api/auth/profile", { minecraftUsername: "LevTheBuilder" }, levCookie);
    assert.equal(renamed.status, 200);
    const user = ((await renamed.json()) as { user: { id: number; minecraftUsername: string } }).user;
    assert.equal(user.minecraftUsername, "LevTheBuilder");
    assert.equal(user.id, me.user.id, "the id owns the skins, so it must survive a rename");

    assert.equal((await post("/api/auth/profile", { minecraftUsername: "!!" }, levCookie)).status, 400);
    assert.equal((await post("/api/auth/profile", { minecraftUsername: "LevTheBuilder" }, levCookie)).status, 200);
  });

  it("refuses profile changes without a session", async () => {
    assert.equal((await post("/api/auth/profile", { minecraftUsername: "Hijack" })).status, 401);
    assert.equal((await post("/api/auth/password", { currentPassword: "x", newPassword: "long-enough-password" })).status, 401);
    const stolen = await post("/api/auth/profile", { minecraftUsername: "Hijack" }, "os_session=made-up-token");
    assert.equal(stolen.status, 401);
  });

  it("never lets one account reach another one", async () => {
    const masha = await register("Masha", "hopper-and-redstone", "MashaBuilds");
    assert.equal(masha.status, 201);
    mashaCookie = sessionOf(masha);
    const mashaId = ((await masha.json()) as { user: { id: number } }).user.id;

    // the account always comes from the cookie, extra fields in the body are ignored
    const attempt = await post("/api/auth/profile", { id: mashaId, userId: mashaId, username: "Masha", minecraftUsername: "LevRenamed" }, levCookie);
    assert.equal(attempt.status, 200);
    assert.equal(((await attempt.json()) as { user: { id: number; username: string } }).user.username, "Lev");

    const mashaNow = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: mashaCookie } })).json()) as {
      user: { minecraftUsername: string };
    };
    assert.equal(mashaNow.user.minecraftUsername, "MashaBuilds", "Masha is untouched");

    // Masha cannot take a name that belongs to Lev
    const taken = await post("/api/auth/profile", { minecraftUsername: "LevRenamed" }, mashaCookie);
    assert.equal(taken.status, 409);
  });

  it("signs out and forgets the cookie", async () => {
    const signedOut = await post("/api/auth/logout", {}, mashaCookie);
    assert.equal(signedOut.status, 204);
    assert.match(signedOut.headers.getSetCookie()[0] ?? "", /os_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: mashaCookie } })).status, 401);
    // signing out twice is not an error
    assert.equal((await post("/api/auth/logout", {}, mashaCookie)).status, 204);
  });

  it("changes the password and closes the other sessions", async () => {
    const first = sessionOf(await post("/api/auth/login", { username: "Lev", password: "lantern-and-deepslate" }));
    const second = sessionOf(await post("/api/auth/login", { username: "Lev", password: "lantern-and-deepslate" }));

    assert.equal((await post("/api/auth/password", { currentPassword: "wrong-password", newPassword: "torch-and-gravel" }, second)).status, 401);
    assert.equal((await post("/api/auth/password", { currentPassword: "lantern-and-deepslate", newPassword: "short" }, second)).status, 400);

    const changed = await post("/api/auth/password", { currentPassword: "lantern-and-deepslate", newPassword: "torch-and-gravel" }, second);
    assert.equal(changed.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: second } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: first } })).status, 401, "the old session is closed");
    assert.equal((await post("/api/auth/login", { username: "Lev", password: "lantern-and-deepslate" })).status, 401);
    const withNew = await post("/api/auth/login", { username: "Lev", password: "torch-and-gravel" });
    assert.equal(withNew.status, 200);
    levCookie = sessionOf(withNew);
  });

  it("never sends a password, a hash or a session token in a body", async () => {
    const endpoints = [
      await post("/api/auth/login", { username: "Lev", password: "torch-and-gravel" }),
      await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: levCookie } }),
      await post("/api/auth/profile", { minecraftUsername: "LevRenamed" }, levCookie),
      await post("/api/auth/login", { username: "Lev", password: "nope" }),
    ];
    const sessionValue = levCookie.slice("os_session=".length);
    for (const response of endpoints) {
      const text = await response.text();
      // the password itself, the stored hash and the session token stay on the server
      for (const secret of ["torch-and-gravel", "scrypt$", "password_hash", "passwordHash", sessionValue]) {
        assert.ok(!text.includes(secret), `a secret leaked into ${text}`);
      }
    }
  });

  it("keeps the accounts in the data folder, not in the site output", async () => {
    const files = await (await import("node:fs/promises")).readdir(path.join(dir, "data"));
    assert.ok(files.includes("site.db"));
  });
});

describe("account API limits", () => {
  it("stops a burst of sign in attempts", async () => {
    const { app, dir } = await startApp({ REGISTER_INVITE_CODE: INVITE, AUTH_RATE_LIMIT_MAX_REQUESTS: "5", AUTH_RATE_LIMIT_WINDOW_SECONDS: "900" });
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let limited = false;
    for (let attempt = 0; attempt < 12 && !limited; attempt++) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Lev", password: `guess-number-${attempt}` }),
      });
      await response.arrayBuffer();
      limited = response.status === 429;
      if (limited) {
        assert.ok(Number(response.headers.get("retry-after")) > 0);
      }
    }
    assert.ok(limited, "a wall of guesses is stopped");
    // reading the current account still works, it is not part of the strict limit
    assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps registration closed without an invite code", async () => {
    const { app, dir } = await startApp({});
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Lev", password: "lantern-and-deepslate", passwordConfirm: "lantern-and-deepslate", minecraftUsername: "LevPlays" }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "registration-closed");
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
