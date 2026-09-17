import { createHash, randomBytes } from "node:crypto";

import type { Database } from "../db.ts";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
/** the expiry is only pushed forward once a day, so a busy tab does not write on every request */
const RENEW_AFTER_SECONDS = 86_400;

export interface SessionOwner {
  userId: number;
  expiresAt: number;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function seconds(now: number): number {
  return Math.floor(now / 1000);
}

/** Creates a session and returns the token for the cookie. Only the hash of the token is stored. */
export function createSession(db: Database, userId: number, ttlDays: number, now = Date.now()): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const issued = seconds(now);
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    issued,
    issued,
    issued + ttlDays * 86_400,
  );
  return token;
}

/** Looks a session up and slides its expiry. Returns null for an unknown, malformed or expired token. */
export function findSession(db: Database, token: string, ttlDays: number, now = Date.now()): SessionOwner | null {
  if (!TOKEN_PATTERN.test(token)) {
    return null;
  }
  const hash = hashToken(token);
  const row = db.prepare("SELECT user_id, last_seen_at, expires_at FROM sessions WHERE token_hash = ?").get(hash);
  if (!row) {
    return null;
  }
  const current = seconds(now);
  const expiresAt = Number(row["expires_at"]);
  if (expiresAt <= current) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return null;
  }
  if (current - Number(row["last_seen_at"]) > RENEW_AFTER_SECONDS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(current, current + ttlDays * 86_400, hash);
  }
  return { userId: Number(row["user_id"]), expiresAt };
}

export function deleteSession(db: Database, token: string): void {
  if (TOKEN_PATTERN.test(token)) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
}

/** Closes every session of a user, optionally keeping the one that asked for it (a password change). */
export function deleteSessionsForUser(db: Database, userId: number, exceptToken?: string): void {
  if (exceptToken && TOKEN_PATTERN.test(exceptToken)) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, hashToken(exceptToken));
    return;
  }
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteExpiredSessions(db: Database, now = Date.now()): number {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(seconds(now)).changes);
}
