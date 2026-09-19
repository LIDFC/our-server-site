import { readFile } from "node:fs/promises";

import { decodePng, encodePng } from "../images/png.ts";
import { renderHead } from "../images/head.ts";
import type { AccountService } from "./accounts.ts";
import type { MinecraftDirectory } from "./minecraft.ts";
import type { SkinService } from "./skins.ts";

/**
 * Who is behind a UUID on the marketplace: the nickname the Minecraft server last saw, and their face if they have
 * uploaded a skin here.
 *
 * <p>The marketplace only ever talks in UUIDs, which is right — a nickname on an offline server is not an identity.
 * The site already knows both halves of the mapping, so it fills them in for display and nothing more: no decision
 * anywhere depends on the name.
 */

/** Heads are eight pixels across; eight times that is crisp on a normal screen and still a tiny file. */
const HEAD_SCALE = 8;
const MAX_CACHED_HEADS = 200;

export interface MarketPerson {
  uuid: string;
  name: string | null;
  /** URL of the rendered face, or null when this player has no skin on the site */
  headUrl: string | null;
}

export interface MarketPeople {
  /** Names and faces for a batch of UUIDs, for one answer of the marketplace API. */
  describe(uuids: string[]): Promise<Record<string, MarketPerson>>;
  /** The rendered face as a PNG, or null when there is nothing to render. */
  head(uuid: string): Promise<Buffer | null>;
}

export function createMarketPeople(
  accounts: AccountService,
  skins: SkinService,
  directory: MinecraftDirectory,
): MarketPeople {
  // keyed by the stored skin file, so a player who uploads a new skin gets a new key and the old entry simply ages out
  const heads = new Map<string, Buffer>();

  const skinFileOf = (uuid: string): string | null => {
    const user = accounts.findByMinecraftUuid(uuid);
    if (!user) {
      return null;
    }
    const skin = skins.forUser(user.id);
    if (!skin) {
      return null;
    }
    const name = skin.url.split("/").pop() ?? "";
    return skins.filePath(name);
  };

  return {
    async describe(uuids) {
      const people: Record<string, MarketPerson> = {};
      for (const uuid of new Set(uuids)) {
        if (people[uuid]) {
          continue;
        }
        const account = accounts.findByMinecraftUuid(uuid);
        // the server's own record first; an account's nickname is the fallback, and it agrees with it by construction
        const name = (await directory.nameFor(uuid)) ?? account?.minecraftUsername ?? null;
        people[uuid] = { uuid, name, headUrl: skinFileOf(uuid) ? `/api/market/head/${uuid}.png` : null };
      }
      return people;
    },

    async head(uuid) {
      const file = skinFileOf(uuid);
      if (!file) {
        return null;
      }
      const cached = heads.get(file);
      if (cached) {
        return cached;
      }
      let png: Buffer;
      try {
        png = encodePng(renderHead(decodePng(await readFile(file)), HEAD_SCALE));
      } catch (error) {
        console.warn(`[market] Could not render a head from a stored skin: ${(error as Error).message}`);
        return null;
      }
      if (heads.size >= MAX_CACHED_HEADS) {
        const oldest = heads.keys().next().value;
        if (oldest !== undefined) {
          heads.delete(oldest);
        }
      }
      heads.set(file, png);
      return png;
    },
  };
}
