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
  market: { enabled: boolean };
}

export interface MarketItem {
  summary: string;
  amount: number;
}

export interface MarketListing {
  id: number;
  type: "GIVEAWAY" | "TRADE" | "WANTED" | "GIFT";
  state: string;
  ownerUuid: string;
  recipientUuid: string | null;
  summary: string;
  createdAt: string;
  offered: MarketItem[];
  wanted: MarketItem[];
}

export interface MarketTrade {
  id: number;
  listingId: number;
  ownerUuid: string;
  buyerUuid: string;
  state: "PENDING" | "ACCEPTED" | "CONFIRMED" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED";
  confirmations: ("OWNER" | "BUYER")[];
  createdAt: string;
}

export interface MarketDelivery {
  id: number;
  summary: string;
  amount: number;
  reason: string;
  createdAt: string;
}

/** What the signed in player has on the marketplace. `linked: false` means the server has never seen this nickname. */
export interface MarketMine {
  linked: boolean;
  minecraftUuid: string;
  minecraftUsername: string;
  listings: MarketListing[];
  trades: MarketTrade[];
  deliveries: MarketDelivery[];
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

export interface AuthUser {
  id: number;
  username: string;
  minecraftUsername: string;
  createdAt: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** error code of the API, or "network" when the request never arrived */
  error: string | null;
}

/** Sends a JSON body and never throws: forms show the error code instead. */
export async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: null, error: "network" };
  }
  if (response.status === 204) {
    return { ok: true, status: 204, data: null, error: null };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) {
    return { ok: true, status: response.status, data: payload as T, error: null };
  }
  const error = (payload as { error?: unknown } | null)?.error;
  return { ok: false, status: response.status, data: null, error: typeof error === "string" ? error : "unknown" };
}

export interface PublicSkin {
  url: string;
  width: number;
  height: number;
  fileSize: number;
  sourceType: string;
  /** true when a JPG upload was turned into a PNG texture */
  converted: boolean;
  originalFileName: string | null;
  updatedAt: string;
  skinName: string;
  /** ready made SkinsRestorer command */
  command: string;
}

export interface SkinState {
  skin: PublicSkin | null;
  minecraftUsername: string;
  limits: { maxBytes: number; sizes: string[]; types: string[] };
}

/** Uploads the file as the request body: no form encoding, the server only ever sees the bytes and the type. */
export async function postFile<T>(path: string, file: File): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        Accept: "application/json",
        // the name is only shown back to the player, the server never builds a path from it
        "X-Skin-Filename": encodeURIComponent(file.name),
      },
      credentials: "same-origin",
      body: file,
    });
  } catch {
    return { ok: false, status: 0, data: null, error: "network" };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) {
    return { ok: true, status: response.status, data: payload as T, error: null };
  }
  const error = (payload as { error?: unknown } | null)?.error;
  return { ok: false, status: response.status, data: null, error: typeof error === "string" ? error : "unknown" };
}

/** The signed in account, or null when nobody is signed in. Throws only when the API itself is unreachable. */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch("/api/auth/me", { headers: { Accept: "application/json" }, credentials: "same-origin" });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`/api/auth/me answered ${response.status}`);
  }
  return ((await response.json()) as { user: AuthUser }).user;
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
