import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { ImageError, readSkin } from "../images/skin.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db.ts";
import type { Failure, Result } from "./accounts.ts";

/** Stored file names are generated here and nowhere else, so nothing user controlled can reach a path. */
const STORED_NAME = /^[0-9a-f]{32}\.png$/;
const ORIGINAL_NAME_LIMIT = 120;

/** The name a player types after /skin, so it is short, lowercase and free of characters that need quoting. */
export const SKIN_NAME_PATTERN = /^[a-z0-9_]{3,16}$/;
/** SkinsRestorer subcommands: a skin called "clear" could never be applied. */
const RESERVED_NAMES = new Set([
  "set",
  "clear",
  "reset",
  "update",
  "random",
  "undo",
  "search",
  "menu",
  "help",
  "url",
  "info",
  "apply",
  "gui",
  "list",
  "skin",
  "skins",
  "sr",
  "favourite",
  "favorite",
]);
/** letters that cannot be confused with each other when read from the site and typed in the game */
const NAME_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Everything the browser is told about a stored skin. No file system paths, no database ids. */
export interface PublicSkin {
  url: string;
  width: number;
  height: number;
  fileSize: number;
  /** what the player uploaded, so the page can say a JPG was converted */
  sourceType: string;
  converted: boolean;
  originalFileName: string | null;
  updatedAt: string;
  /** skin name for SkinsRestorer, derived from the stored file name */
  skinName: string;
  command: string;
}

export interface SkinService {
  forUser(userId: number): PublicSkin | null;
  save(userId: number, buffer: Buffer, declaredType: string | null, fileName: string | null): Promise<Result<PublicSkin>>;
  rename(userId: number, skinName: unknown): Result<PublicSkin>;
  remove(userId: number): Promise<Result<null>>;
  /** Removes the skin of an account if it has one. Repeating it is not an error, which is what the game needs. */
  clear(userId: number): Promise<{ deleted: boolean }>;
  /** Absolute path of a stored skin, or null when the name is not one this service generated. */
  filePath(storedFileName: string): string | null;
}

function fail(status: number, error: string, message: string): Failure {
  return { ok: false, status, error, message };
}

/** Checks a name a player picked for their skin. */
export function checkSkinName(value: unknown): { ok: true; value: string } | { ok: false; error: string; message: string } {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SKIN_NAME_PATTERN.test(name)) {
    return { ok: false, error: "invalid-skin-name", message: "A skin name is 3 to 16 characters: latin letters, digits or _" };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: "skin-name-reserved", message: "SkinsRestorer uses this word as a command, pick another name" };
  }
  return { ok: true, value: name };
}

/**
 * Picks a name the player will remember: their Minecraft nickname when it is still free, then the nickname with a
 * couple of digits, and only as a last resort six random characters.
 */
export function suggestSkinName(nickname: string, taken: (name: string) => boolean): string {
  const base = nickname.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16);
  const candidates: string[] = [];
  if (base.length >= 3 && !RESERVED_NAMES.has(base)) {
    candidates.push(base);
    const short = base.slice(0, 14);
    for (let i = 2; i <= 9; i++) {
      candidates.push(`${short}${i}`);
    }
  }
  for (const candidate of candidates) {
    if (!taken(candidate)) {
      return candidate;
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const random = [...randomBytes(6)].map((byte) => NAME_ALPHABET[byte % NAME_ALPHABET.length]).join("");
    if (!taken(random)) {
      return random;
    }
  }
  // practically unreachable: six characters of this alphabet are almost a billion names
  return [...randomBytes(10)].map((byte) => NAME_ALPHABET[byte % NAME_ALPHABET.length]).join("");
}

function toPublicSkin(row: Record<string, unknown>): PublicSkin {
  const url = String(row["public_url"]);
  const skinName = String(row["skin_name"]);
  return {
    url,
    width: Number(row["width"]),
    height: Number(row["height"]),
    fileSize: Number(row["file_size"]),
    sourceType: String(row["source_mime_type"]),
    converted: String(row["source_mime_type"]) !== String(row["mime_type"]),
    originalFileName: row["original_filename"] === null ? null : String(row["original_filename"]),
    updatedAt: String(row["updated_at"]),
    skinName,
    command: `/sr createcustom ${skinName} "${url}"`,
  };
}

/** Keeps a display name for the upload without letting it touch the file system. */
function safeOriginalName(fileName: string | null): string | null {
  if (!fileName) {
    return null;
  }
  const base = path.posix.basename(path.win32.basename(fileName)).trim();
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "").slice(0, ORIGINAL_NAME_LIMIT);
  return cleaned.length > 0 ? cleaned : null;
}

export function createSkinService(db: Database, config: Config): SkinService {
  const uploadDir = config.skins.uploadDir;
  const cooldownMs = config.skins.cooldownSeconds * 1000;

  const rowFor = (userId: number): Record<string, unknown> | undefined =>
    db
      .prepare(
        "SELECT stored_filename, public_url, mime_type, source_mime_type, file_size, width, height, original_filename, skin_name," +
          " created_at, updated_at FROM skins WHERE user_id = ?",
      )
      .get(userId);

  const nameTaken = (name: string): boolean => db.prepare("SELECT 1 FROM skins WHERE skin_name_lower = ?").get(name) !== undefined;

  /** The name a player already uses stays with the account, so /skin <name> keeps working after a new upload. */
  const nameForUser = (userId: number): string => {
    const existing = db.prepare("SELECT skin_name FROM skins WHERE user_id = ?").get(userId)?.["skin_name"];
    if (typeof existing === "string" && existing.length > 0) {
      return existing;
    }
    const nickname = db.prepare("SELECT minecraft_username FROM users WHERE id = ?").get(userId)?.["minecraft_username"];
    return suggestSkinName(typeof nickname === "string" ? nickname : "", nameTaken);
  };

  /** Removes a file only when no account references it any more. */
  const dropFile = async (storedFileName: string | null): Promise<void> => {
    if (!storedFileName || !STORED_NAME.test(storedFileName)) {
      return;
    }
    const stillUsed = db.prepare("SELECT 1 FROM skins WHERE stored_filename = ?").get(storedFileName);
    if (stillUsed) {
      return;
    }
    try {
      await unlink(path.join(uploadDir, storedFileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[skins] Could not remove ${storedFileName}: ${error}`);
      }
    }
  };

  return {
    forUser(userId) {
      const row = rowFor(userId);
      return row ? toPublicSkin(row) : null;
    },

    async save(userId, buffer, declaredType, fileName) {
      if (buffer.length > config.skins.maxUploadBytes) {
        return fail(413, "file-too-large", `A skin file must be at most ${Math.round(config.skins.maxUploadBytes / 1024 / 1024)} MB`);
      }
      const previous = rowFor(userId);
      if (previous && cooldownMs > 0) {
        const since = Date.now() - Date.parse(String(previous["updated_at"]));
        if (since >= 0 && since < cooldownMs) {
          return fail(429, "upload-cooldown", `Wait ${Math.ceil((cooldownMs - since) / 1000)} seconds before uploading again`);
        }
      }

      let skin;
      try {
        skin = readSkin(buffer, declaredType, fileName);
      } catch (error) {
        if (error instanceof ImageError) {
          return fail(400, error.code, error.message);
        }
        throw error;
      }

      const storedFileName = `${randomBytes(16).toString("hex")}.png`;
      const target = path.join(uploadDir, storedFileName);
      await mkdir(uploadDir, { recursive: true });
      // written under a temporary name and moved into place, so a half written file is never served
      const temporary = `${target}.part`;
      await writeFile(temporary, skin.png, { mode: 0o644 });
      try {
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }

      const now = new Date().toISOString();
      const url = `${config.skins.siteUrl}/skins/${storedFileName}`;
      const skinName = nameForUser(userId);
      try {
        db.prepare(
          "INSERT INTO skins (user_id, original_filename, stored_filename, public_url, mime_type, source_mime_type, file_size, width, height," +
            " skin_name, skin_name_lower, created_at, updated_at) VALUES (?, ?, ?, ?, 'image/png', ?, ?, ?, ?, ?, ?, ?, ?)" +
            " ON CONFLICT(user_id) DO UPDATE SET original_filename = excluded.original_filename, stored_filename = excluded.stored_filename," +
            " public_url = excluded.public_url, mime_type = excluded.mime_type, source_mime_type = excluded.source_mime_type," +
            " file_size = excluded.file_size, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at",
        ).run(
          userId,
          safeOriginalName(fileName),
          storedFileName,
          url,
          skin.sourceType,
          skin.png.length,
          skin.width,
          skin.height,
          skinName,
          skinName,
          now,
          now,
        );
      } catch (error) {
        // the database still points at the old skin, so remove the file that was just written and keep it working
        await unlink(target).catch(() => {});
        console.error(`[skins] Could not store the skin of account ${userId}: ${error}`);
        return fail(500, "save-failed", "The skin could not be saved, the previous one is still in place");
      }

      // only now, with the new skin recorded, the old file is no longer needed
      await dropFile(previous ? String(previous["stored_filename"]) : null);

      const row = rowFor(userId);
      return row ? { ok: true, value: toPublicSkin(row) } : fail(500, "save-failed", "The skin could not be saved");
    },

    rename(userId, skinName) {
      const checked = checkSkinName(skinName);
      if (!checked.ok) {
        return fail(400, checked.error, checked.message);
      }
      const row = rowFor(userId);
      if (!row) {
        return fail(404, "no-skin", "Upload a skin first");
      }
      if (String(row["skin_name"]) !== checked.value) {
        try {
          // the unique index is what really decides, two players cannot end up with the same /skin name
          db.prepare("UPDATE skins SET skin_name = ?, skin_name_lower = ?, updated_at = ? WHERE user_id = ?").run(
            checked.value,
            checked.value,
            new Date().toISOString(),
            userId,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("skin_name_lower")) {
            return fail(409, "skin-name-taken", "This name is already used by another player");
          }
          throw error;
        }
      }
      const updated = rowFor(userId);
      return updated ? { ok: true, value: toPublicSkin(updated) } : fail(404, "no-skin", "Upload a skin first");
    },

    async clear(userId) {
      const row = rowFor(userId);
      if (!row) {
        return { deleted: false };
      }
      // ownership is the WHERE clause: only the row of this account can go
      db.prepare("DELETE FROM skins WHERE user_id = ?").run(userId);
      // the file name comes from the record that was just read, never from a request
      await dropFile(String(row["stored_filename"]));
      return { deleted: true };
    },

    async remove(userId) {
      const row = rowFor(userId);
      if (!row) {
        return fail(404, "no-skin", "There is no skin to remove");
      }
      // ownership is the WHERE clause: a session can only ever delete its own row
      db.prepare("DELETE FROM skins WHERE user_id = ?").run(userId);
      await dropFile(String(row["stored_filename"]));
      return { ok: true, value: null };
    },

    filePath(storedFileName) {
      return STORED_NAME.test(storedFileName) ? path.join(uploadDir, storedFileName) : null;
    },
  };
}
