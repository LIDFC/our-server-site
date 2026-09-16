import { createCachedLoader } from "../cache.ts";
import type { Config } from "../config.ts";
import { pingServer } from "../minecraft/ping.ts";

export interface ServerStatus {
  online: boolean;
  address: string;
  version: string | null;
  motd: string | null;
  /** null while offline or when the server hides its player count */
  players: { online: number; max: number } | null;
  playerNames: string[];
  /** false when the server lists only a part of the players (Server List Ping sends at most 12 names) */
  playerListComplete: boolean;
  /** time the server needed to answer the website, which runs on the same machine */
  responseMs: number | null;
  checkedAt: string;
}

export interface StatusService {
  get(): Promise<ServerStatus>;
  /** a fresh check that ignores the cache, used by the online history */
  refresh(): Promise<ServerStatus>;
}

export function createStatusService(config: Config): StatusService {
  const { host, port, publicAddress, statusTimeoutMs, statusCacheSeconds } = config.minecraft;
  let lastOnline: boolean | null = null;

  const loader = createCachedLoader(async (): Promise<ServerStatus> => {
    const result = await pingServer(host, port, statusTimeoutMs);
    const checkedAt = new Date().toISOString();

    if (lastOnline !== result.online) {
      console.info(result.online ? "[status] Minecraft server is online" : `[status] Minecraft server is unavailable (${result.error})`);
      lastOnline = result.online;
    }

    if (!result.online) {
      return {
        online: false,
        address: publicAddress,
        version: null,
        motd: null,
        players: null,
        playerNames: [],
        playerListComplete: false,
        responseMs: null,
        checkedAt,
      };
    }
    const players = result.players;
    return {
      online: true,
      address: publicAddress,
      version: result.version,
      motd: result.motd || null,
      players: players ? { online: players.online, max: players.max } : null,
      playerNames: players?.sample ?? [],
      playerListComplete: players ? players.sample.length >= players.online : false,
      responseMs: result.latencyMs,
      checkedAt,
    };
  }, statusCacheSeconds * 1000);

  return {
    get: async () => (await loader.get()).value,
    refresh: async () => (await loader.refresh()).value,
  };
}
