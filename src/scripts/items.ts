/**
 * Reading an item out of the marketplace's own wording.
 *
 * <p>The plugin describes a stack as `16x diamond pickaxe`, and a renamed one as `Сокрушитель (diamond pickaxe)` —
 * the material always last, in brackets. That is the whole contract this file depends on, and it is documented on the
 * plugin's side too (`PaperItemCodec.summary`). Everything here is for display: no decision anywhere is made from a
 * parsed id.
 */

export interface ParsedItem {
  /** material id as Minecraft spells it, e.g. `diamond_pickaxe` */
  id: string;
  count: number;
  /** what to show a player: their own name for the item when it has one */
  label: string;
  /** true when the owner renamed the item */
  renamed: boolean;
}

const COUNT = /^(\d+)x\s+(.+)$/;
const RENAMED = /^(.*)\s\(([^()]+)\)$/;

function pretty(words: string): string {
  const text = words.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function parseItem(summary: string): ParsedItem {
  const counted = COUNT.exec(summary.trim());
  const count = counted ? Number(counted[1] ?? "1") : 1;
  const rest = (counted ? (counted[2] ?? "") : summary).trim();

  const renamed = RENAMED.exec(rest);
  const material = (renamed ? (renamed[2] ?? "") : rest).trim();
  return {
    id: material.toLowerCase().replace(/\s+/g, "_"),
    count: Number.isFinite(count) ? count : 1,
    label: renamed ? (renamed[1] ?? "").trim() : pretty(material),
    renamed: Boolean(renamed),
  };
}
