import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildLeaderboard, loadStats, parseMinecraftDate } from "../src/services/stats.ts";

const ALICE = "11111111-1111-3111-8111-111111111111";
const BOB = "22222222-2222-3222-8222-222222222222";
const UNKNOWN = "33333333-3333-3333-8333-333333333333";

describe("statistics", () => {
  let serverDir: string;

  before(async () => {
    serverDir = await mkdtemp(path.join(os.tmpdir(), "stats-test-"));
    const world = path.join(serverDir, "world");
    await mkdir(path.join(world, "stats"), { recursive: true });
    await mkdir(path.join(world, "advancements"), { recursive: true });

    await writeFile(
      path.join(serverDir, "usercache.json"),
      JSON.stringify([
        { name: "Alice", uuid: ALICE, expiresOn: "2026-10-16 10:00:00 +0000" },
        { name: "Bob", uuid: BOB, expiresOn: "2026-10-16 10:00:00 +0000" },
      ]),
    );
    await writeFile(
      path.join(world, "stats", `${ALICE}.json`),
      JSON.stringify({
        stats: {
          "minecraft:custom": {
            "minecraft:play_time": 72000 * 3,
            "minecraft:walk_one_cm": 150000,
            "minecraft:sprint_one_cm": 50000,
            "minecraft:fly_one_cm": 999999,
            "minecraft:deaths": 2,
            "minecraft:mob_kills": 30,
          },
          "minecraft:mined": { "minecraft:diamond_ore": 4, "minecraft:deepslate_diamond_ore": 3, "minecraft:stone": 100 },
          "minecraft:killed_by": { "minecraft:creeper": 2, "minecraft:zombie": 1 },
        },
        DataVersion: 4671,
      }),
    );
    await writeFile(
      path.join(world, "stats", `${BOB}.json`),
      JSON.stringify({ stats: { "minecraft:custom": { "minecraft:play_time": 72000, "minecraft:deaths": 5 } } }),
    );
    await writeFile(path.join(world, "stats", `${UNKNOWN}.json`), JSON.stringify({ stats: {} }));
    await writeFile(path.join(world, "stats", "not-a-player.json"), JSON.stringify({ stats: { "minecraft:custom": { "minecraft:deaths": 99 } } }));
    await writeFile(path.join(world, "stats", `${"44444444-4444-3444-8444-444444444444"}.json`), "{ broken json");

    await writeFile(
      path.join(world, "advancements", `${ALICE}.json`),
      JSON.stringify({
        "minecraft:story/mine_diamond": { criteria: { diamond: "2026-09-16 12:00:00 +0000" }, done: true },
        "minecraft:story/enter_the_nether": { criteria: { entered_nether: "2026-09-17 09:30:00 +0300" }, done: true },
        "minecraft:recipes/misc/torch": { criteria: { has_coal: "2026-09-16 10:00:00 +0000" }, done: true },
        "minecraft:adventure/adventuring_time": { criteria: { plains: "2026-09-16 10:00:00 +0000" }, done: false },
      }),
    );
    await writeFile(
      path.join(world, "advancements", `${BOB}.json`),
      JSON.stringify({ "minecraft:story/mine_diamond": { criteria: { diamond: "2026-09-16 11:00:00 +0000" }, done: true } }),
    );
  });

  after(async () => {
    await rm(serverDir, { recursive: true, force: true });
  });

  it("aggregates the statistics of every player", async () => {
    const snapshot = await loadStats(serverDir, "world");
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.players.length, 3);

    const alice = snapshot.players.find((player) => player.name === "Alice")!;
    assert.equal(alice.playTimeHours, 3);
    // walking and sprinting count, creative flight does not
    assert.equal(alice.distanceKm, 2);
    assert.equal(alice.diamonds, 7);
    assert.equal(alice.blocksMined, 107);
    assert.equal(alice.deaths, 2);
    assert.equal(alice.mobKills, 30);
    // recipes and unfinished advancements are not counted
    assert.equal(alice.advancements, 2);
    assert.deepEqual(alice.nemesis, { name: "Крипер", deaths: 2 });

    assert.ok(snapshot.players.some((player) => player.name === "Игрок 3333"));
    assert.equal(snapshot.totals.deaths, 7);
    assert.equal(snapshot.totals.playTimeHours, 4);
  });

  it("names who reached a milestone first", async () => {
    const snapshot = await loadStats(serverDir, "world");
    const diamonds = snapshot.milestones.find((milestone) => milestone.id === "minecraft:story/mine_diamond")!;
    assert.deepEqual(diamonds.first, { name: "Bob", at: "2026-09-16T11:00:00.000Z" });
    assert.equal(diamonds.reachedBy, 2);

    const nether = snapshot.milestones.find((milestone) => milestone.id === "minecraft:story/enter_the_nether")!;
    assert.deepEqual(nether.first, { name: "Alice", at: "2026-09-17T06:30:00.000Z" });

    const dragon = snapshot.milestones.find((milestone) => milestone.id === "minecraft:end/kill_dragon")!;
    assert.equal(dragon.first, null);
  });

  it("builds leaderboards without empty entries", async () => {
    const snapshot = await loadStats(serverDir, "world");
    const leaderboard = buildLeaderboard(snapshot.players);
    const deaths = leaderboard.find((category) => category.id === "deaths")!;
    assert.deepEqual(deaths.entries, [
      { name: "Bob", value: 5 },
      { name: "Alice", value: 2 },
    ]);
    const diamonds = leaderboard.find((category) => category.id === "diamonds")!;
    assert.deepEqual(diamonds.entries, [{ name: "Alice", value: 7 }]);
  });

  it("reports missing world data as unavailable", async () => {
    const snapshot = await loadStats(serverDir, "no_such_world");
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.players.length, 0);
  });

  it("parses Minecraft dates", () => {
    assert.equal(parseMinecraftDate("2026-09-16 10:52:22 +0000")?.toISOString(), "2026-09-16T10:52:22.000Z");
    assert.equal(parseMinecraftDate("yesterday"), null);
  });
});
