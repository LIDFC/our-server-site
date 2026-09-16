import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createHistoryStore } from "../src/services/history.ts";

describe("online history", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "history-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores samples, drops old ones and survives a restart", async () => {
    const file = path.join(dir, "history.json");
    const now = Math.floor(Date.now() / 1000);
    const store = createHistoryStore(file, 1, 300);
    await store.load();

    await store.append(now - 2 * 86400, 9);
    await store.append(now - 7200, 2);
    await store.append(now - 3600, -1);
    await store.append(now - 300, 4);

    const saved = JSON.parse(await readFile(file, "utf8")) as { points: number[][] };
    assert.equal(saved.points.length, 3, "samples older than the retention are removed");

    const restarted = createHistoryStore(file, 1, 300);
    await restarted.load();
    const day = restarted.query(24, now);
    assert.deepEqual(day.points, [
      [now - 7200, 2],
      [now - 3600, -1],
      [now - 300, 4],
    ]);
    assert.deepEqual(day.peak, { players: 4, at: now - 300 });
    assert.deepEqual(restarted.query(1, now).points, [
      [now - 3600, -1],
      [now - 300, 4],
    ]);
  });

  it("ignores a corrupted file", async () => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ not json");
    const store = createHistoryStore(file, 7, 300);
    await store.load();
    assert.deepEqual(store.query(24).points, []);
    assert.equal(store.query(24).peak, null);
  });
});
