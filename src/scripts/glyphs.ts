/**
 * Item glyphs.
 *
 * <p>Drawn on a 16×16 grid with whole-number coordinates, because that is the grid every Minecraft item texture lives
 * on. It keeps the shapes blunt and object-like instead of turning into a generic line-icon set, and it is the reason
 * these read as things rather than as symbols.
 *
 * <p>There are about two thousand items in the game and there will never be two thousand drawings here. Each glyph
 * stands for a family — gem, ingot, pickaxe, block, loaf — which is what a person scanning a list actually needs.
 * The exact item is written next to it in words.
 */

type Shape = { d: string; fill?: string }[];

/** Two tones per glyph: the body, and a lighter facet so a flat shape still reads as an object. */
const LIT = "var(--glyph-lit)";

const SHAPES: Record<string, Shape> = {
  gem: [{ d: "M8 2 14 7 8 14 2 7Z" }, { d: "M8 2 11 7 8 14 5 7Z", fill: LIT }],
  ingot: [{ d: "M3 6h10l2 5H1Z" }, { d: "M4 7h8l1 2H3Z", fill: LIT }],
  nugget: [{ d: "M5 5h6v6H5Z" }, { d: "M6 6h2v2H6Z", fill: LIT }],
  dust: [{ d: "M3 4h2v2H3ZM7 2h2v2H7ZM11 5h2v2h-2ZM5 9h2v2H5ZM9 10h2v2H9ZM3 12h2v2H3ZM12 11h2v2h-2Z" }],
  pickaxe: [{ d: "M1 6c4-4 10-4 14 0l-2 2c-3-2-7-2-10 0Z" }, { d: "M7 7h3v8H7Z", fill: LIT }],
  axe: [{ d: "M4 1h4l4 4-4 4H4Z" }, { d: "M6 8h3v7H6Z", fill: LIT }],
  shovel: [{ d: "M4 1h6v5l-3 4-3-4Z" }, { d: "M6 9h3v6H6Z", fill: LIT }],
  hoe: [{ d: "M2 2h9v3H6v3H2Z" }, { d: "M9 5h3v10H9Z", fill: LIT }],
  sword: [{ d: "M10 1h4v4L8 11 6 9Z" }, { d: "M2 11h5v2H2Z", fill: LIT }, { d: "M4 9h3v6H4Z" }],
  helmet: [{ d: "M3 6a5 5 0 0 1 10 0v4h-3V8H6v2H3Z" }, { d: "M5 4h6v2H5Z", fill: LIT }],
  chestplate: [{ d: "M3 3h10v3h-2v8H5V6H3Z" }, { d: "M6 6h4v3H6Z", fill: LIT }],
  leggings: [{ d: "M3 2h10v5h-3v7H6V7H3Z" }, { d: "M5 3h6v2H5Z", fill: LIT }],
  boots: [{ d: "M3 3h4v7h5v4H3Z" }, { d: "M4 4h2v5H4Z", fill: LIT }],
  bow: [{ d: "M4 1a12 12 0 0 1 0 14H2a14 14 0 0 0 0-14Z" }, { d: "M3 2 3 14", fill: "none" }],
  arrow: [{ d: "M14 1 9 2 8 6l2 2 4-1Z" }, { d: "M8 7 1 14l1 1 7-7Z", fill: LIT }],
  block: [{ d: "M8 1 15 5v6l-7 4-7-4V5Z" }, { d: "M8 1 15 5 8 9 1 5Z", fill: LIT }],
  loaf: [{ d: "M2 7a6 4 0 0 1 12 0v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" }, { d: "M5 6h6v2H5Z", fill: LIT }],
  apple: [{ d: "M8 4a4 5 0 1 0 0 10 4 5 0 1 0 0-10Z" }, { d: "M8 4V1h2", fill: "none" }],
  book: [{ d: "M3 2h10v12H3Z" }, { d: "M5 4h6v2H5ZM5 7h6v1H5Z", fill: LIT }],
  potion: [{ d: "M6 1h4v3l3 4v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8l3-4Z" }, { d: "M4 9h8v3H4Z", fill: LIT }],
  bucket: [{ d: "M2 4h12l-2 10H4Z" }, { d: "M5 6h6v3H5Z", fill: LIT }],
  elytra: [{ d: "M7 3C4 1 1 4 1 8s2 6 6 6ZM9 3c3-2 6 1 6 5s-2 6-6 6Z" }, { d: "M7 3h2v11H7Z", fill: LIT }],
  totem: [{ d: "M6 1h4v4h3v3h-3v7H6V8H3V5h3Z" }, { d: "M7 2h2v3H7Z", fill: LIT }],
  rod: [{ d: "M11 1h3v3L4 14 1 15l1-3Z" }, { d: "M11 1 14 4", fill: "none" }],
  thing: [{ d: "M3 3h10v10H3Z" }, { d: "M5 5h4v4H5Z", fill: LIT }],
};

/** Colour per material family. These values live only inside a glyph — never on a button, a border or a status. */
const COLOURS: Record<string, string> = {
  diamond: "#6ec8c0",
  emerald: "#5aa878",
  gold: "#cf9f4e",
  golden: "#cf9f4e",
  iron: "#b8bcc2",
  chainmail: "#9aa0a8",
  copper: "#b57246",
  netherite: "#7a6c66",
  lapis: "#456fae",
  amethyst: "#9a7ac4",
  quartz: "#cfc7bb",
  redstone: "#b5514a",
  coal: "#4a4a4e",
  leather: "#9c7048",
  wooden: "#96703f",
  stone: "#83888f",
  glow: "#c8a45e",
  ender: "#4b8b84",
  blaze: "#c98a3c",
  nether: "#8c5058",
  prismarine: "#6aa89c",
  bread: "#b98a4c",
  apple: "#b34f47",
  paper: "#c5c0b4",
};

const DEFAULT_COLOUR = "#8b9098";

/** Longest first: `concrete_powder` must not be read as `concrete`, and `_ingot` beats `_block`. */
const BY_SUFFIX: [string, string][] = [
  ["_pickaxe", "pickaxe"],
  ["_shovel", "shovel"],
  ["_sword", "sword"],
  ["_axe", "axe"],
  ["_hoe", "hoe"],
  ["_helmet", "helmet"],
  ["_chestplate", "chestplate"],
  ["_leggings", "leggings"],
  ["_boots", "boots"],
  ["_ingot", "ingot"],
  ["_nugget", "nugget"],
  ["_shard", "gem"],
  ["_dust", "dust"],
  ["_powder", "dust"],
  ["_rod", "rod"],
  ["_book", "book"],
  ["_bucket", "bucket"],
  ["_potion", "potion"],
  ["_block", "block"],
  ["_planks", "block"],
  ["_log", "block"],
  ["_wool", "block"],
  ["_ore", "block"],
  ["_stairs", "block"],
  ["_slab", "block"],
  ["_concrete", "block"],
  ["_terracotta", "block"],
];

const BY_ID: Record<string, string> = {
  diamond: "gem",
  emerald: "gem",
  lapis_lazuli: "gem",
  amethyst_shard: "gem",
  quartz: "gem",
  coal: "nugget",
  charcoal: "nugget",
  redstone: "dust",
  gunpowder: "dust",
  sugar: "dust",
  glowstone_dust: "dust",
  bone_meal: "dust",
  bow: "bow",
  crossbow: "bow",
  arrow: "arrow",
  trident: "rod",
  stick: "rod",
  blaze_rod: "rod",
  torch: "rod",
  soul_torch: "rod",
  redstone_torch: "rod",
  lantern: "thing",
  feather: "rod",
  bone: "rod",
  elytra: "elytra",
  totem_of_undying: "totem",
  shield: "chestplate",
  turtle_helmet: "helmet",
  book: "book",
  writable_book: "book",
  written_book: "book",
  enchanted_book: "book",
  paper: "book",
  map: "book",
  filled_map: "book",
  bread: "loaf",
  cake: "loaf",
  cookie: "loaf",
  apple: "apple",
  golden_apple: "apple",
  enchanted_golden_apple: "apple",
  melon_slice: "apple",
  potion: "potion",
  splash_potion: "potion",
  lingering_potion: "potion",
  glass_bottle: "potion",
  honey_bottle: "potion",
  experience_bottle: "potion",
  bucket: "bucket",
  water_bucket: "bucket",
  lava_bucket: "bucket",
  milk_bucket: "bucket",
  ender_pearl: "nugget",
  ender_eye: "nugget",
  slime_ball: "nugget",
  nether_star: "gem",
  heart_of_the_sea: "gem",
  shulker_shell: "thing",
  nautilus_shell: "thing",
  netherite_scrap: "nugget",
  ancient_debris: "block",
  stone: "block",
  cobblestone: "block",
  dirt: "block",
  sand: "block",
  gravel: "block",
  obsidian: "block",
  glass: "block",
  bedrock: "block",
  tnt: "block",
  chest: "block",
  ender_chest: "block",
  crafting_table: "block",
  furnace: "block",
  hay_block: "block",
};

function shapeFor(id: string): Shape {
  const exact = BY_ID[id];
  if (exact && SHAPES[exact]) {
    return SHAPES[exact]!;
  }
  for (const [suffix, name] of BY_SUFFIX) {
    if (id.endsWith(suffix) && SHAPES[name]) {
      return SHAPES[name]!;
    }
  }
  return SHAPES["thing"]!;
}

function colourFor(id: string): string {
  for (const [word, colour] of Object.entries(COLOURS)) {
    if (id === word || id.startsWith(`${word}_`) || id.endsWith(`_${word}`) || id.includes(`_${word}_`)) {
      return colour;
    }
  }
  return DEFAULT_COLOUR;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** One item glyph, ready to put in the page. Decorative: the item's name is always written beside it. */
export function glyph(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "glyph");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.style.setProperty("--glyph-ink", colourFor(id));
  for (const part of shapeFor(id)) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", part.d);
    if (part.fill === "none") {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
    } else if (part.fill) {
      path.setAttribute("fill", part.fill);
    }
    svg.append(path);
  }
  return svg;
}
