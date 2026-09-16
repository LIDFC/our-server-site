import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** [unix seconds, players online], -1 players means the server was unavailable */
export type HistoryPoint = [number, number];

export interface HistoryQuery {
  hours: number;
  intervalSeconds: number;
  points: HistoryPoint[];
  peak: { players: number; at: number } | null;
}

export interface HistoryStore {
  load(): Promise<void>;
  append(timestamp: number, players: number): Promise<void>;
  query(hours: number, now?: number): HistoryQuery;
}

/**
 * Online history in a single small JSON file. A week of samples every 5 minutes is about 2,000 points (~30 KB), so a
 * database would only add weight.
 */
export function createHistoryStore(filePath: string, retentionDays: number, intervalSeconds: number): HistoryStore {
  let points: HistoryPoint[] = [];
  let writing: Promise<void> = Promise.resolve();

  const prune = (now: number): void => {
    const oldest = now - retentionDays * 86400;
    points = points.filter(([timestamp]) => timestamp >= oldest);
  };

  const save = async (): Promise<void> => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, points }));
    await rename(temporary, filePath);
  };

  return {
    async load() {
      try {
        const data = JSON.parse(await readFile(filePath, "utf8")) as { version?: unknown; points?: unknown };
        if (data.version === 1 && Array.isArray(data.points)) {
          points = data.points.filter(
            (point): point is HistoryPoint =>
              Array.isArray(point) && point.length === 2 && Number.isInteger(point[0]) && Number.isInteger(point[1]) && point[1] >= -1,
          );
          points.sort((a, b) => a[0] - b[0]);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[history] Starting with an empty history, the file could not be read: ${error}`);
        }
      }
      prune(Math.floor(Date.now() / 1000));
    },

    async append(timestamp, players) {
      points.push([timestamp, players]);
      prune(timestamp);
      // writes never overlap, a failed write is logged and retried with the next sample
      writing = writing.then(save).catch((error) => console.warn(`[history] Could not save the history: ${error}`));
      await writing;
    },

    query(hours, now = Math.floor(Date.now() / 1000)) {
      const since = now - hours * 3600;
      const selected = points.filter(([timestamp]) => timestamp >= since && timestamp <= now);
      let peak: HistoryQuery["peak"] = null;
      for (const [timestamp, players] of selected) {
        if (players > 0 && (!peak || players > peak.players)) {
          peak = { players, at: timestamp };
        }
      }
      return { hours, intervalSeconds, points: selected, peak };
    },
  };
}

/** Samples the number of players at a fixed interval. Returns a function that stops sampling. */
export function startHistorySampler(store: HistoryStore, samplePlayers: () => Promise<number>, intervalSeconds: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    try {
      await store.append(Math.floor(Date.now() / 1000), await samplePlayers());
    } catch (error) {
      console.warn(`[history] Sampling failed: ${error}`);
    }
    if (!stopped) {
      // align samples to the interval, so restarts keep a regular grid
      const intervalMs = intervalSeconds * 1000;
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    }
  };
  void tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
