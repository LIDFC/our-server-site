// Demo data for local development only: writes to .dev/, which git ignores and the production server never reads.
// Usage: node scripts/dev-fixtures.mjs, then start the site with MC_SERVER_DIR=.dev/minecraft (see README).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..", ".dev");
rmSync(root, { recursive: true, force: true });
const world = path.join(root, "minecraft", "world");
mkdirSync(path.join(world, "stats"), { recursive: true });
mkdirSync(path.join(world, "advancements"), { recursive: true });
mkdirSync(path.join(root, "data"), { recursive: true });
mkdirSync(path.join(root, "gallery", "images"), { recursive: true });

let seed = 42;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const int = (min, max) => Math.floor(min + random() * (max - min + 1));
const stamp = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");

const names = ["DemoAlex", "DemoSteve", "DemoMira", "DemoKostya", "DemoLiza", "DemoTim"];
const cache = [];
names.forEach((name, index) => {
  const uuid = `0000000${index}-0000-3000-8000-00000000000${index}`;
  cache.push({ name, uuid, expiresOn: stamp(-30) });
  const hours = int(2, 60);
  writeFileSync(
    path.join(world, "stats", `${uuid}.json`),
    JSON.stringify({
      stats: {
        "minecraft:custom": {
          "minecraft:play_time": hours * 72000,
          "minecraft:walk_one_cm": int(100000, 4000000),
          "minecraft:sprint_one_cm": int(50000, 3000000),
          "minecraft:boat_one_cm": int(0, 800000),
          "minecraft:deaths": int(0, 40),
          "minecraft:mob_kills": int(5, 900),
          "minecraft:jump": int(100, 20000),
          "minecraft:fish_caught": int(0, 60),
        },
        "minecraft:mined": {
          "minecraft:stone": int(100, 20000),
          "minecraft:deepslate": int(0, 9000),
          "minecraft:diamond_ore": int(0, 12),
          "minecraft:deepslate_diamond_ore": int(0, 40),
        },
        "minecraft:killed_by": { "minecraft:creeper": int(0, 9), "minecraft:skeleton": int(0, 7), "minecraft:zombie": int(0, 6) },
      },
      DataVersion: 4671,
    }),
  );
  const advancements = {};
  const pool = [
    "minecraft:story/root",
    "minecraft:story/mine_stone",
    "minecraft:story/mine_diamond",
    "minecraft:story/enter_the_nether",
    "minecraft:nether/find_fortress",
    "minecraft:story/follow_ender_eye",
    "minecraft:story/enter_the_end",
    "minecraft:end/kill_dragon",
    "minecraft:husbandry/root",
    "minecraft:adventure/root",
  ];
  pool.slice(0, int(2, index === 0 ? 8 : 6)).forEach((id, step) => {
    advancements[id] = { criteria: { done: stamp(20 - step * 2 - index * 0.3) }, done: true };
  });
  writeFileSync(path.join(world, "advancements", `${uuid}.json`), JSON.stringify(advancements));
});
writeFileSync(path.join(root, "minecraft", "usercache.json"), JSON.stringify(cache));

// a week of history every 5 minutes, busy in the evenings, one outage
const points = [];
const now = Math.floor(Date.now() / 1000 / 300) * 300;
for (let t = now - 7 * 86400; t <= now; t += 300) {
  const hour = new Date(t * 1000).getHours();
  const evening = hour >= 17 && hour <= 23 ? 1 : hour >= 12 ? 0.35 : 0.05;
  const outage = t > now - 30 * 3600 && t < now - 28 * 3600;
  points.push([t, outage ? -1 : Math.max(0, Math.round(evening * int(0, 7) + random() * 0.8 - 0.3))]);
}
writeFileSync(path.join(root, "data", "online-history.json"), JSON.stringify({ version: 1, points }));

// gallery pictures: small PNG gradients written without dependencies
function png(width, height, colorAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x / width, y / height);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const places = [
  { id: "demo-lake-house", title: "Дом на берегу (демо)", author: "DemoMira", colors: [[40, 70, 90], [196, 150, 90]], coords: { x: 123, y: 70, z: -456 } },
  { id: "demo-mountain-base", title: "База в горе (демо)", author: "DemoAlex", colors: [[50, 50, 60], [120, 140, 110]], coords: { x: -870, y: 96, z: 312 } },
  { id: "demo-nether-hub", title: "Хаб в Незере (демо)", author: "DemoKostya", colors: [[70, 20, 20], [200, 110, 60]], coords: { x: 40, y: 64, z: 40 } },
];
for (const place of places) {
  const [from, to] = place.colors;
  writeFileSync(
    path.join(root, "gallery", "images", `${place.id}.png`),
    png(480, 300, (u, v) => from.map((channel, i) => Math.round(channel + (to[i] - channel) * (0.6 * u + 0.4 * (1 - v))))),
  );
}
writeFileSync(
  path.join(root, "gallery", "gallery.json"),
  JSON.stringify({
    items: places.map(({ colors, ...place }) => ({
      ...place,
      description: "Демонстрационная запись для локальной разработки.",
      image: `${place.id}.png`,
      addedAt: "2026-09-16",
    })),
  }),
);

console.log(`Demo data written to ${root}`);
