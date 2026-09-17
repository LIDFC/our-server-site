import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hashPassword, spendVerifyTime, verifyPassword } from "../src/auth/password.ts";
import { createSession, deleteExpiredSessions, deleteSession, deleteSessionsForUser, findSession } from "../src/auth/sessions.ts";
import { checkMinecraftUsername, checkPassword, checkUsername, matchesInviteCode } from "../src/auth/validate.ts";
import { migrate, openDatabase, schemaVersion, type Database } from "../src/db.ts";
import { parseCookies, serializeCookie } from "../src/http.ts";

function databaseWithUser(): { db: Database; userId: number } {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  const inserted = db
    .prepare(
      "INSERT INTO users (username, username_lower, password_hash, minecraft_username, minecraft_username_lower, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("Lev", "lev", "scrypt$1$1$1$x$y", "Lev", "lev", now, now);
  return { db, userId: Number(inserted.lastInsertRowid) };
}

describe("password hashing", () => {
  it("accepts the right password and rejects everything else", async () => {
    const hash = await hashPassword("correct horse battery");
    assert.match(hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword(hash, "correct horse battery"), true);
    assert.equal(await verifyPassword(hash, "correct horse batter"), false);
    assert.equal(await verifyPassword(hash, ""), false);
  });

  it("salts every hash, so equal passwords look different", async () => {
    assert.notEqual(await hashPassword("same password"), await hashPassword("same password"));
  });

  it("rejects a stored value it cannot read instead of throwing", async () => {
    for (const stored of ["", "plaintext", "scrypt$8$8$1$c2FsdA==$aGFzaA==", "bcrypt$1$2$3$4$5", "scrypt$32768$8$1$$"]) {
      assert.equal(await verifyPassword(stored, "whatever"), false);
    }
  });

  it("spends time on accounts that do not exist", async () => {
    await spendVerifyTime("some password");
  });
});

describe("account validation", () => {
  it("checks the username", () => {
    assert.deepEqual(checkUsername("Lev_2026"), { ok: true, value: "Lev_2026" });
    assert.deepEqual(checkUsername("  Lev  "), { ok: true, value: "Lev" });
    for (const bad of ["ab", "a".repeat(21), "лев", "lev lev", "lev-lev", 42, null]) {
      assert.equal(checkUsername(bad).ok, false);
    }
    const reserved = checkUsername("Admin");
    assert.equal(reserved.ok, false);
    assert.equal(reserved.ok === false && reserved.error, "username-reserved");
  });

  it("checks the Minecraft name", () => {
    assert.equal(checkMinecraftUsername("Notch_1").ok, true);
    for (const bad of ["ab", "a".repeat(17), "Ник", "two words"]) {
      assert.equal(checkMinecraftUsername(bad).ok, false);
    }
  });

  it("checks the password", () => {
    assert.equal(checkPassword("longenough").ok, true);
    assert.equal(checkPassword("short").ok, false);
    assert.equal(checkPassword("a".repeat(129)).ok, false);
    const obvious = checkPassword("Levlevlev", "levLEVlev");
    assert.equal(obvious.ok, false);
    assert.equal(obvious.ok === false && obvious.error, "password-too-obvious");
  });

  it("compares the invite code without leaking it", () => {
    assert.equal(matchesInviteCode("our-server-2026", "our-server-2026"), true);
    assert.equal(matchesInviteCode("our-server-2026", " our-server-2026 "), true);
    assert.equal(matchesInviteCode("our-server-2026", "our-server-202"), false);
    assert.equal(matchesInviteCode("our-server-2026", ""), false);
    assert.equal(matchesInviteCode("our-server-2026", null), false);
    // no code configured means no code matches
    assert.equal(matchesInviteCode("", ""), false);
  });
});

describe("cookies", () => {
  it("reads the session cookie out of a header", () => {
    assert.deepEqual(parseCookies("os_session=abc; theme=dark"), { os_session: "abc", theme: "dark" });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies("broken"), {});
    // the first value wins, a second cookie with the same name cannot override it
    assert.deepEqual(parseCookies("os_session=first; os_session=second"), { os_session: "first" });
  });

  it("writes a cookie the browser keeps to itself", () => {
    const cookie = serializeCookie("os_session", "token-value", { maxAgeSeconds: 60, secure: true });
    assert.match(cookie, /^os_session=token-value; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60; Secure$/);
    assert.ok(!serializeCookie("os_session", "", { maxAgeSeconds: 0 }).includes("Secure"));
  });
});

describe("sessions", () => {
  it("finds a session by its token and forgets unknown ones", () => {
    const { db, userId } = databaseWithUser();
    const token = createSession(db, userId, 30);
    assert.deepEqual(findSession(db, token, 30)?.userId, userId);
    assert.equal(findSession(db, "not-a-token", 30), null);
    assert.equal(findSession(db, "a".repeat(43), 30), null);
    db.close();
  });

  it("stores only the hash of the token", () => {
    const { db, userId } = databaseWithUser();
    const token = createSession(db, userId, 30);
    const stored = db.prepare("SELECT token_hash FROM sessions").get()?.["token_hash"];
    assert.ok(stored instanceof Uint8Array);
    assert.equal(stored.length, 32);
    assert.ok(!Buffer.from(stored).toString("base64url").includes(token));
    db.close();
  });

  it("drops a session once it expired", () => {
    const { db, userId } = databaseWithUser();
    const token = createSession(db, userId, 30);
    db.prepare("UPDATE sessions SET expires_at = ?").run(Math.floor(Date.now() / 1000) - 1);
    assert.equal(findSession(db, token, 30), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.["count"], 0);
    db.close();
  });

  it("slides the expiry of a session that keeps being used", () => {
    const { db, userId } = databaseWithUser();
    const token = createSession(db, userId, 30);
    // pretend the session was opened three days ago and not touched since
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 86_400;
    db.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ?").run(threeDaysAgo, threeDaysAgo, threeDaysAgo + 30 * 86_400);
    const before = Number(db.prepare("SELECT expires_at FROM sessions").get()?.["expires_at"]);
    findSession(db, token, 30);
    assert.ok(Number(db.prepare("SELECT expires_at FROM sessions").get()?.["expires_at"]) > before);
    db.close();
  });

  it("closes sessions one by one, per user and by expiry", () => {
    const { db, userId } = databaseWithUser();
    const kept = createSession(db, userId, 30);
    const other = createSession(db, userId, 30);
    deleteSession(db, other);
    assert.equal(findSession(db, other, 30), null);
    assert.ok(findSession(db, kept, 30));

    const second = createSession(db, userId, 30);
    deleteSessionsForUser(db, userId, kept);
    assert.equal(findSession(db, second, 30), null);
    assert.ok(findSession(db, kept, 30), "the session that asked for it stays");

    db.prepare("UPDATE sessions SET expires_at = ?").run(Math.floor(Date.now() / 1000) - 1);
    assert.equal(deleteExpiredSessions(db), 1);
    db.close();
  });

  it("removes the sessions of a deleted account", () => {
    const { db, userId } = databaseWithUser();
    createSession(db, userId, 30);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.["count"], 0);
    db.close();
  });
});

describe("schema", () => {
  it("migrates once and stays there", () => {
    const db = openDatabase(":memory:");
    const version = schemaVersion(db);
    assert.ok(version >= 1);
    assert.equal(migrate(db), version);
    db.close();
  });

  it("keeps usernames and Minecraft names unique whatever the case", () => {
    const { db } = databaseWithUser();
    const insert = (username: string, nick: string): void => {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO users (username, username_lower, password_hash, minecraft_username, minecraft_username_lower, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(username, username.toLowerCase(), "x", nick, nick.toLowerCase(), now, now);
    };
    assert.throws(() => insert("LEV", "Other"), /UNIQUE/);
    assert.throws(() => insert("Other", "LEV"), /UNIQUE/);
    insert("Other", "Other");
    db.close();
  });
});
