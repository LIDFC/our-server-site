import { hashPassword, spendVerifyTime, verifyPassword } from "../auth/password.ts";
import { createSession, deleteSession, deleteSessionsForUser, findSession } from "../auth/sessions.ts";
import { checkMinecraftUsername, checkPassword, checkUsername, matchesInviteCode } from "../auth/validate.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db.ts";

/** Everything the browser is ever told about an account. The password hash never leaves this module. */
export interface PublicUser {
  id: number;
  username: string;
  minecraftUsername: string;
  createdAt: string;
}

export interface Failure {
  ok: false;
  status: number;
  error: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | Failure;

export interface SignedIn {
  user: PublicUser;
  token: string;
}

export interface AccountService {
  registrationOpen(): boolean;
  /** Account linked to a Minecraft UUID, the identifier the Minecraft server is sure about. */
  findByMinecraftUuid(uuid: string): PublicUser | null;
  findByMinecraftUsername(name: string): PublicUser | null;
  /** Remembers the UUID of an account. Returns false when another account already holds it. */
  linkMinecraftUuid(userId: number, uuid: string): boolean;
  minecraftUuidOf(userId: number): string | null;
  register(body: Record<string, unknown>): Promise<Result<SignedIn>>;
  login(body: Record<string, unknown>): Promise<Result<SignedIn>>;
  logout(token: string): void;
  current(token: string): PublicUser | null;
  updateMinecraftUsername(userId: number, body: Record<string, unknown>): Result<PublicUser>;
  changePassword(userId: number, token: string, body: Record<string, unknown>): Promise<Result<null>>;
}

function fail(status: number, error: string, message: string): Failure {
  return { ok: false, status, error, message };
}

function toPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: Number(row["id"]),
    username: String(row["username"]),
    minecraftUsername: String(row["minecraft_username"]),
    createdAt: String(row["created_at"]),
  };
}

function takenBy(error: unknown): Failure | null {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("users.username_lower")) {
    return fail(409, "username-taken", "This username is already taken");
  }
  if (text.includes("users.minecraft_username_lower")) {
    return fail(409, "minecraft-username-taken", "This Minecraft name already belongs to another account");
  }
  return null;
}

export function createAccountService(db: Database, config: Config): AccountService {
  const ttlDays = config.auth.sessionTtlDays;
  const inviteCode = config.auth.inviteCode;

  const findById = (userId: number): Record<string, unknown> | undefined =>
    db.prepare("SELECT id, username, minecraft_username, created_at FROM users WHERE id = ?").get(userId);

  return {
    registrationOpen: () => inviteCode !== null,

    findByMinecraftUuid(uuid) {
      const row = db.prepare("SELECT id, username, minecraft_username, created_at FROM users WHERE minecraft_uuid = ?").get(uuid);
      return row ? toPublicUser(row) : null;
    },

    findByMinecraftUsername(name) {
      const row = db.prepare("SELECT id, username, minecraft_username, created_at FROM users WHERE minecraft_username_lower = ?").get(name.toLowerCase());
      return row ? toPublicUser(row) : null;
    },

    linkMinecraftUuid(userId, uuid) {
      try {
        db.prepare("UPDATE users SET minecraft_uuid = ?, updated_at = ? WHERE id = ?").run(uuid, new Date().toISOString(), userId);
        return true;
      } catch (error) {
        // the unique index says the UUID belongs to another account, which is a conflict to report, not to overwrite
        console.warn(`[accounts] Could not link a Minecraft UUID to account ${userId}: ${error}`);
        return false;
      }
    },

    minecraftUuidOf(userId) {
      const row = db.prepare("SELECT minecraft_uuid FROM users WHERE id = ?").get(userId);
      const uuid = row?.["minecraft_uuid"];
      return typeof uuid === "string" ? uuid : null;
    },

    async register(body) {
      if (inviteCode === null) {
        return fail(403, "registration-closed", "Registration is closed");
      }
      const username = checkUsername(body["username"]);
      if (!username.ok) {
        return fail(400, username.error, username.message);
      }
      const password = checkPassword(body["password"], username.value);
      if (!password.ok) {
        return fail(400, password.error, password.message);
      }
      if (typeof body["passwordConfirm"] === "string" && body["passwordConfirm"] !== password.value) {
        return fail(400, "password-mismatch", "The two passwords do not match");
      }
      const minecraftUsername = checkMinecraftUsername(body["minecraftUsername"]);
      if (!minecraftUsername.ok) {
        return fail(400, minecraftUsername.error, minecraftUsername.message);
      }
      // checked last: a wrong code must not tell which names are still free
      if (!matchesInviteCode(inviteCode, body["inviteCode"])) {
        return fail(403, "invalid-invite", "The invite code is not correct");
      }

      const now = new Date().toISOString();
      const hash = await hashPassword(password.value);
      let id: number;
      try {
        const inserted = db
          .prepare(
            "INSERT INTO users (username, username_lower, password_hash, minecraft_username, minecraft_username_lower, created_at, updated_at)" +
              " VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(username.value, username.value.toLowerCase(), hash, minecraftUsername.value, minecraftUsername.value.toLowerCase(), now, now);
        id = Number(inserted.lastInsertRowid);
      } catch (error) {
        // the unique indexes have the last word, two people registering at once cannot both win
        const taken = takenBy(error);
        if (taken) {
          return taken;
        }
        throw error;
      }
      return {
        ok: true,
        value: {
          user: { id, username: username.value, minecraftUsername: minecraftUsername.value, createdAt: now },
          token: createSession(db, id, ttlDays),
        },
      };
    },

    async login(body) {
      const username = typeof body["username"] === "string" ? body["username"].trim() : "";
      const password = typeof body["password"] === "string" ? body["password"] : "";
      // one message for every failure: a wrong name and a wrong password must look the same
      const wrong = fail(401, "invalid-credentials", "Wrong username or password");
      const row = db
        .prepare("SELECT id, username, password_hash, minecraft_username, created_at FROM users WHERE username_lower = ?")
        .get(username.toLowerCase());
      if (!row) {
        // spend the same time as a real check, otherwise the answer alone lists the accounts
        await spendVerifyTime(password);
        return wrong;
      }
      if (!(await verifyPassword(String(row["password_hash"]), password))) {
        return wrong;
      }
      return { ok: true, value: { user: toPublicUser(row), token: createSession(db, Number(row["id"]), ttlDays) } };
    },

    logout(token) {
      deleteSession(db, token);
    },

    current(token) {
      const session = findSession(db, token, ttlDays);
      if (!session) {
        return null;
      }
      const row = findById(session.userId);
      return row ? toPublicUser(row) : null;
    },

    updateMinecraftUsername(userId, body) {
      const minecraftUsername = checkMinecraftUsername(body["minecraftUsername"]);
      if (!minecraftUsername.ok) {
        return fail(400, minecraftUsername.error, minecraftUsername.message);
      }
      try {
        // the account id stays the same, so whatever the account owns (skins later on) follows the rename
        db.prepare("UPDATE users SET minecraft_username = ?, minecraft_username_lower = ?, updated_at = ? WHERE id = ?").run(
          minecraftUsername.value,
          minecraftUsername.value.toLowerCase(),
          new Date().toISOString(),
          userId,
        );
      } catch (error) {
        const taken = takenBy(error);
        if (taken) {
          return taken;
        }
        throw error;
      }
      const row = findById(userId);
      return row ? { ok: true, value: toPublicUser(row) } : fail(401, "unauthenticated", "Sign in first");
    },

    async changePassword(userId, token, body) {
      const row = db.prepare("SELECT username, password_hash FROM users WHERE id = ?").get(userId);
      if (!row) {
        return fail(401, "unauthenticated", "Sign in first");
      }
      const next = checkPassword(body["newPassword"], String(row["username"]));
      if (!next.ok) {
        return fail(400, next.error, next.message);
      }
      const currentPassword = typeof body["currentPassword"] === "string" ? body["currentPassword"] : "";
      if (!(await verifyPassword(String(row["password_hash"]), currentPassword))) {
        return fail(401, "invalid-credentials", "Wrong username or password");
      }
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
        await hashPassword(next.value),
        new Date().toISOString(),
        userId,
      );
      // whoever else was signed in with the old password is signed out
      deleteSessionsForUser(db, userId, token);
      return { ok: true, value: null };
    },
  };
}
