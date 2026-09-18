import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCachedLoader } from "../cache.ts";
import type { Config } from "../config.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;
const CACHE_SECONDS = 60;

/** Lowercase dashed form, or null when this is not a UUID at all. */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  const dashed = trimmed.length === 32 ? `${trimmed.slice(0, 8)}-${trimmed.slice(8, 12)}-${trimmed.slice(12, 16)}-${trimmed.slice(16, 20)}-${trimmed.slice(20)}` : trimmed;
  return UUID.test(dashed) ? dashed : null;
}

export function isPlayerName(value: unknown): value is string {
  return typeof value === "string" && PLAYER_NAME.test(value);
}

export interface MinecraftDirectory {
  /** The name the server last saw for this UUID, or null when the server does not know it. */
  nameFor(uuid: string): Promise<string | null>;
  uuidFor(name: string): Promise<string | null>;
}

/**
 * Reads usercache.json of the Minecraft server: it is the server's own record of which UUID belongs to which name, so
 * it is what the site checks a Minecraft request against before it links anything to an account.
 */
export function createMinecraftDirectory(config: Config): MinecraftDirectory {
  const filePath = path.join(config.minecraft.serverDir, "usercache.json");

  const loader = createCachedLoader(async () => {
    const names = new Map<string, string>();
    const uuids = new Map<string, string>();
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[minecraft] usercache.json could not be read: ${error}`);
      }
      return { names, uuids };
    }
    if (!Array.isArray(raw)) {
      return { names, uuids };
    }
    for (const entry of raw) {
      const { uuid, name } = (entry ?? {}) as { uuid?: unknown; name?: unknown };
      const id = normalizeUuid(uuid);
      if (id && isPlayerName(name)) {
        names.set(id, name);
        uuids.set(name.toLowerCase(), id);
      }
    }
    return { names, uuids };
  }, CACHE_SECONDS * 1000);

  return {
    async nameFor(uuid) {
      const id = normalizeUuid(uuid);
      return id ? ((await loader.get()).value.names.get(id) ?? null) : null;
    },
    async uuidFor(name) {
      return isPlayerName(name) ? ((await loader.get()).value.uuids.get(name.toLowerCase()) ?? null) : null;
    },
  };
}
