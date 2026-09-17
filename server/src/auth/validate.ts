import { timingSafeEqual } from "node:crypto";

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
/** Minecraft Java Edition names: 3 to 16 characters, letters, digits and underscore */
export const MINECRAFT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Logins that would be confusing or look official. */
const RESERVED = new Set(["admin", "administrator", "root", "server", "console", "system", "moderator", "support", "ourserver"]);

export interface Invalid {
  ok: false;
  error: string;
  message: string;
}

export type Checked<T> = { ok: true; value: T } | Invalid;

function invalid(error: string, message: string): Invalid {
  return { ok: false, error, message };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function checkUsername(value: unknown): Checked<string> {
  const username = asString(value).trim();
  if (!USERNAME_PATTERN.test(username)) {
    return invalid("invalid-username", "Username must be 3 to 20 characters: letters, digits or underscore");
  }
  if (RESERVED.has(username.toLowerCase())) {
    return invalid("username-reserved", "This username is not available");
  }
  return { ok: true, value: username };
}

export function checkMinecraftUsername(value: unknown): Checked<string> {
  const name = asString(value).trim();
  if (!MINECRAFT_NAME_PATTERN.test(name)) {
    return invalid("invalid-minecraft-username", "Minecraft name must be 3 to 16 characters: letters, digits or underscore");
  }
  return { ok: true, value: name };
}

export function checkPassword(value: unknown, username?: string): Checked<string> {
  const password = asString(value);
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return invalid("invalid-password", `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`);
  }
  if (username && password.toLowerCase() === username.toLowerCase()) {
    return invalid("password-too-obvious", "Password must be different from the username");
  }
  return { ok: true, value: password };
}

/** Compares without leaking the code length or an early mismatch through timing. */
export function matchesInviteCode(expected: string, provided: unknown): boolean {
  const given = Buffer.from(asString(provided).trim(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (wanted.length === 0) {
    return false;
  }
  // pad both sides to a fixed length so the comparison itself takes the same time
  const size = Math.max(given.length, wanted.length, 32);
  const left = Buffer.alloc(size);
  const right = Buffer.alloc(size);
  given.copy(left);
  wanted.copy(right);
  return timingSafeEqual(left, right) && given.length === wanted.length;
}
