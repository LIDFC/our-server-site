import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createCachedLoader } from "../cache.ts";
import type { Config } from "../config.ts";
import { isValidPlayerName } from "../minecraft/protocol.ts";

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PLAYERS = 1000;
const TICKS_PER_HOUR = 20 * 60 * 60;
const CM_PER_KM = 100_000;

// ways of getting around that count as travelled distance (flying in creative mode and falling do not)
const TRAVEL_STATS = [
  "walk_one_cm",
  "sprint_one_cm",
  "crouch_one_cm",
  "swim_one_cm",
  "walk_on_water_one_cm",
  "walk_under_water_one_cm",
  "climb_one_cm",
  "boat_one_cm",
  "minecart_one_cm",
  "horse_one_cm",
  "pig_one_cm",
  "strider_one_cm",
  "aviate_one_cm",
  "happy_ghast_one_cm",
];

const ADVANCEMENT_TABS = /^minecraft:(story|nether|end|adventure|husbandry)\//;

const MOB_NAMES: Record<string, string> = {
  "minecraft:zombie": "Зомби",
  "minecraft:zombie_villager": "Зомби-житель",
  "minecraft:husk": "Кадавр",
  "minecraft:drowned": "Утопленник",
  "minecraft:skeleton": "Скелет",
  "minecraft:stray": "Зимогор",
  "minecraft:bogged": "Болотник",
  "minecraft:creeper": "Крипер",
  "minecraft:spider": "Паук",
  "minecraft:cave_spider": "Пещерный паук",
  "minecraft:enderman": "Эндермен",
  "minecraft:witch": "Ведьма",
  "minecraft:slime": "Слизень",
  "minecraft:phantom": "Фантом",
  "minecraft:pillager": "Разбойник",
  "minecraft:vindicator": "Поборник",
  "minecraft:evoker": "Заклинатель",
  "minecraft:ravager": "Разоритель",
  "minecraft:blaze": "Ифрит",
  "minecraft:ghast": "Гаст",
  "minecraft:magma_cube": "Магмовый куб",
  "minecraft:wither_skeleton": "Скелет-иссушитель",
  "minecraft:piglin": "Пиглин",
  "minecraft:piglin_brute": "Жестокий пиглин",
  "minecraft:zombified_piglin": "Зомбифицированный пиглин",
  "minecraft:hoglin": "Хоглин",
  "minecraft:zoglin": "Зоглин",
  "minecraft:guardian": "Страж",
  "minecraft:elder_guardian": "Древний страж",
  "minecraft:silverfish": "Чешуйница",
  "minecraft:warden": "Хранитель",
  "minecraft:breeze": "Вихрь",
  "minecraft:creaking": "Скрипун",
  "minecraft:ender_dragon": "Эндер-дракон",
  "minecraft:wither": "Иссушитель",
  "minecraft:wolf": "Волк",
  "minecraft:bee": "Пчела",
  "minecraft:iron_golem": "Железный голем",
  "minecraft:polar_bear": "Белый медведь",
  "minecraft:goat": "Коза",
  "minecraft:player": "Другой игрок",
};

/** Moments worth celebrating; the site names the player who got there first. */
export const MILESTONES = [
  { id: "minecraft:story/mine_diamond", title: "Первые алмазы" },
  { id: "minecraft:story/enter_the_nether", title: "Первый поход в Незер" },
  { id: "minecraft:nether/find_fortress", title: "Найдена адская крепость" },
  { id: "minecraft:story/follow_ender_eye", title: "Найдена крепость Края" },
  { id: "minecraft:story/enter_the_end", title: "Первый шаг в Край" },
  { id: "minecraft:end/kill_dragon", title: "Дракон побеждён" },
  { id: "minecraft:end/elytra", title: "Первые элитры" },
  { id: "minecraft:nether/summon_wither", title: "Призван иссушитель" },
] as const;

export interface PlayerStats {
  name: string;
  playTimeHours: number;
  distanceKm: number;
  diamonds: number;
  blocksMined: number;
  mobKills: number;
  deaths: number;
  jumps: number;
  fishCaught: number;
  advancements: number;
  /** the mob that killed the player most often */
  nemesis: { name: string; deaths: number } | null;
  lastPlayedAt: string | null;
}

export interface Milestone {
  id: string;
  title: string;
  first: { name: string; at: string } | null;
  reachedBy: number;
}

export interface StatsSnapshot {
  available: boolean;
  updatedAt: string;
  players: PlayerStats[];
  totals: {
    players: number;
    playTimeHours: number;
    distanceKm: number;
    diamonds: number;
    blocksMined: number;
    mobKills: number;
    deaths: number;
  };
  milestones: Milestone[];
}

export interface LeaderboardCategory {
  id: string;
  title: string;
  unit: string;
  entries: { name: string; value: number }[];
}

type StatsFile = { stats?: Record<string, Record<string, unknown>> };
type AdvancementsFile = Record<string, { done?: unknown; criteria?: Record<string, unknown> } | unknown>;

async function readJson(filePath: string): Promise<unknown> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return null;
    }
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function numberStat(stats: StatsFile, category: string, key: string): number {
  const value = stats.stats?.[category]?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sumCategory(stats: StatsFile, category: string): number {
  const values = stats.stats?.[category];
  if (!values || typeof values !== "object") {
    return 0;
  }
  return Object.values(values).reduce<number>((sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0), 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** "2026-09-16 10:52:22 +0000" as written by Minecraft */
export function parseMinecraftDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mobName(id: string): string {
  return MOB_NAMES[id] ?? id.replace(/^minecraft:/, "").replaceAll("_", " ");
}

async function loadUserNames(serverDir: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const cache = await readJson(path.join(serverDir, "usercache.json"));
  if (Array.isArray(cache)) {
    for (const entry of cache) {
      const { uuid, name } = (entry ?? {}) as { uuid?: unknown; name?: unknown };
      if (typeof uuid === "string" && isValidPlayerName(name)) {
        names.set(uuid.toLowerCase(), name);
      }
    }
  }
  return names;
}

/** Completion times of the advancements a player has finished, keyed by advancement id. */
function completedAdvancements(file: unknown): Map<string, Date | null> {
  const done = new Map<string, Date | null>();
  if (typeof file !== "object" || file === null) {
    return done;
  }
  for (const [id, value] of Object.entries(file as AdvancementsFile)) {
    if (!ADVANCEMENT_TABS.test(id) || typeof value !== "object" || value === null) {
      continue;
    }
    const advancement = value as { done?: unknown; criteria?: Record<string, unknown> };
    if (advancement.done !== true) {
      continue;
    }
    // an advancement is completed when its last criterion is
    let completedAt: Date | null = null;
    for (const criterion of Object.values(advancement.criteria ?? {})) {
      const date = parseMinecraftDate(criterion);
      if (date && (!completedAt || date > completedAt)) {
        completedAt = date;
      }
    }
    done.set(id, completedAt);
  }
  return done;
}

export async function loadStats(serverDir: string, worldName: string): Promise<StatsSnapshot> {
  const worldDir = path.join(serverDir, worldName);
  const statsDir = path.join(worldDir, "stats");
  const empty: StatsSnapshot = {
    available: false,
    updatedAt: new Date().toISOString(),
    players: [],
    totals: { players: 0, playTimeHours: 0, distanceKm: 0, diamonds: 0, blocksMined: 0, mobKills: 0, deaths: 0 },
    milestones: MILESTONES.map((milestone) => ({ ...milestone, first: null, reachedBy: 0 })),
  };

  let files: string[];
  try {
    files = (await readdir(statsDir)).filter((file) => UUID_FILE.test(file)).slice(0, MAX_PLAYERS);
  } catch (error) {
    console.warn(`[stats] Cannot read ${statsDir}: ${(error as NodeJS.ErrnoException).code ?? error}`);
    return empty;
  }

  const names = await loadUserNames(serverDir);
  const players: PlayerStats[] = [];
  const firsts = new Map<string, { name: string; at: Date }>();
  const reachedBy = new Map<string, number>();

  for (const file of files) {
    const uuid = UUID_FILE.exec(file)![1]!.toLowerCase();
    const stats = (await readJson(path.join(statsDir, file))) as StatsFile | null;
    if (!stats || typeof stats !== "object") {
      continue;
    }
    const name = names.get(uuid) ?? `Игрок ${uuid.slice(0, 4)}`;
    const advancements = completedAdvancements(await readJson(path.join(worldDir, "advancements", file)));

    let nemesis: PlayerStats["nemesis"] = null;
    for (const [mob, count] of Object.entries(stats.stats?.["minecraft:killed_by"] ?? {})) {
      if (typeof count === "number" && count > 0 && (!nemesis || count > nemesis.deaths)) {
        nemesis = { name: mobName(mob), deaths: count };
      }
    }

    let lastPlayedAt: string | null = null;
    try {
      lastPlayedAt = (await stat(path.join(statsDir, file))).mtime.toISOString();
    } catch {
      // the file vanished between listing and reading
    }

    players.push({
      name,
      playTimeHours: round(numberStat(stats, "minecraft:custom", "minecraft:play_time") / TICKS_PER_HOUR, 1),
      distanceKm: round(TRAVEL_STATS.reduce((sum, key) => sum + numberStat(stats, "minecraft:custom", `minecraft:${key}`), 0) / CM_PER_KM, 1),
      diamonds:
        numberStat(stats, "minecraft:mined", "minecraft:diamond_ore") + numberStat(stats, "minecraft:mined", "minecraft:deepslate_diamond_ore"),
      blocksMined: sumCategory(stats, "minecraft:mined"),
      mobKills: numberStat(stats, "minecraft:custom", "minecraft:mob_kills"),
      deaths: numberStat(stats, "minecraft:custom", "minecraft:deaths"),
      jumps: numberStat(stats, "minecraft:custom", "minecraft:jump"),
      fishCaught: numberStat(stats, "minecraft:custom", "minecraft:fish_caught"),
      advancements: advancements.size,
      nemesis,
      lastPlayedAt,
    });

    for (const milestone of MILESTONES) {
      if (!advancements.has(milestone.id)) {
        continue;
      }
      reachedBy.set(milestone.id, (reachedBy.get(milestone.id) ?? 0) + 1);
      const at = advancements.get(milestone.id);
      const current = firsts.get(milestone.id);
      if (at && (!current || at < current.at)) {
        firsts.set(milestone.id, { name, at });
      }
    }
  }

  players.sort((a, b) => b.playTimeHours - a.playTimeHours || a.name.localeCompare(b.name));
  const total = (pick: (player: PlayerStats) => number): number => players.reduce((sum, player) => sum + pick(player), 0);

  return {
    available: true,
    updatedAt: new Date().toISOString(),
    players,
    totals: {
      players: players.length,
      playTimeHours: round(total((p) => p.playTimeHours), 1),
      distanceKm: round(total((p) => p.distanceKm), 1),
      diamonds: total((p) => p.diamonds),
      blocksMined: total((p) => p.blocksMined),
      mobKills: total((p) => p.mobKills),
      deaths: total((p) => p.deaths),
    },
    milestones: MILESTONES.map((milestone) => {
      const first = firsts.get(milestone.id);
      return {
        id: milestone.id,
        title: milestone.title,
        first: first ? { name: first.name, at: first.at.toISOString() } : null,
        reachedBy: reachedBy.get(milestone.id) ?? 0,
      };
    }),
  };
}

const LEADERBOARD: { id: string; title: string; unit: string; value: (player: PlayerStats) => number }[] = [
  { id: "playTime", title: "Больше всех наиграл", unit: "ч", value: (p) => p.playTimeHours },
  { id: "distance", title: "Дальше всех прошёл", unit: "км", value: (p) => p.distanceKm },
  { id: "diamonds", title: "Больше всех алмазов", unit: "шт.", value: (p) => p.diamonds },
  { id: "blocksMined", title: "Больше всех накопал", unit: "блоков", value: (p) => p.blocksMined },
  { id: "mobKills", title: "Гроза мобов", unit: "мобов", value: (p) => p.mobKills },
  { id: "advancements", title: "Больше всех достижений", unit: "шт.", value: (p) => p.advancements },
  { id: "deaths", title: "Чаще всех погибал", unit: "раз", value: (p) => p.deaths },
];

export function buildLeaderboard(players: PlayerStats[], size = 5): LeaderboardCategory[] {
  return LEADERBOARD.map((category) => ({
    id: category.id,
    title: category.title,
    unit: category.unit,
    entries: players
      .map((player) => ({ name: player.name, value: category.value(player) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
      .slice(0, size),
  }));
}

export interface StatsService {
  snapshot(): Promise<StatsSnapshot>;
}

export function createStatsService(config: Config): StatsService {
  const loader = createCachedLoader(
    () => loadStats(config.minecraft.serverDir, config.minecraft.worldName),
    config.minecraft.statsCacheSeconds * 1000,
  );
  return { snapshot: async () => (await loader.get()).value };
}
