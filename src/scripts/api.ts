export interface ServerStatus {
  online: boolean;
  address: string;
  version: string | null;
  motd: string | null;
  players: { online: number; max: number } | null;
  playerNames: string[];
  playerListComplete: boolean;
  responseMs: number | null;
  checkedAt: string;
}

export interface SiteConfig {
  serverName: string;
  address: string;
  map: { url: string | null; world: string };
  launcherRepo: string;
}

export type DownloadId =
  | "windows-x64-setup"
  | "windows-x64-portable"
  | "windows-x64-zip"
  | "windows-arm64-setup"
  | "windows-arm64-portable"
  | "windows-arm64-zip"
  | "windows-mingw-setup"
  | "windows-mingw-portable"
  | "windows-mingw-zip"
  | "macos-dmg"
  | "macos-zip"
  | "source";

export interface ReleaseFile {
  fileName: string;
  url: string;
  sizeBytes: number;
}

export interface LauncherRelease {
  available: boolean;
  repoUrl: string;
  releasesUrl: string;
  tag: string | null;
  name: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  downloads: (ReleaseFile & { id: DownloadId })[];
  otherFiles: ReleaseFile[];
}

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
  totals: { players: number; playTimeHours: number; distanceKm: number; diamonds: number; blocksMined: number; mobKills: number; deaths: number };
  milestones: Milestone[];
}

export interface Leaderboard {
  available: boolean;
  updatedAt: string;
  categories: { id: string; title: string; unit: string; entries: { name: string; value: number }[] }[];
  milestones: Milestone[];
}

export interface OnlineHistory {
  hours: number;
  intervalSeconds: number;
  /** [unix seconds, players], -1 players while the server was unavailable */
  points: [number, number][];
  peak: { players: number; at: number } | null;
}

export interface GalleryItem {
  id: string;
  title: string;
  author: string;
  description: string;
  imageUrl: string;
  coords: { x: number; y: number; z: number };
  addedAt: string | null;
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

let configRequest: Promise<SiteConfig> | null = null;

export function getConfig(): Promise<SiteConfig> {
  configRequest ??= getJson<SiteConfig>("/api/config").catch((error: unknown) => {
    configRequest = null;
    throw error;
  });
  return configRequest;
}

/** Link to squaremap, centered on a position when coordinates are given. Null while the map is not set up. */
export function mapUrl(config: SiteConfig, position?: { x: number; z: number; zoom?: number }, embed = false): string | null {
  if (!config.map.url) {
    return null;
  }
  const url = new URL(config.map.url.endsWith("/") ? config.map.url : `${config.map.url}/`);
  if (position) {
    url.searchParams.set("world", config.map.world);
    url.searchParams.set("zoom", String(position.zoom ?? 3));
    url.searchParams.set("x", String(position.x));
    url.searchParams.set("z", String(position.z));
  }
  if (embed) {
    url.searchParams.set("show_sidebar", "false");
    url.searchParams.set("show_link_button", "false");
  }
  return url.href;
}

/** Runs a task now and then periodically, but only while the page is visible. */
export function whileVisible(task: () => void | Promise<void>, intervalMs: number): void {
  let lastRun = 0;
  const run = (): void => {
    lastRun = Date.now();
    void task();
  };
  run();
  setInterval(() => {
    if (document.visibilityState === "visible") {
      run();
    }
  }, intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastRun > intervalMs) {
      run();
    }
  });
}
