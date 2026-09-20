import { ITEM_ICONS } from "../generated/item-icons";
import { NAME_EXACT, NAME_PREFIXES, NAME_SUFFIXES } from "../generated/item-names";

/**
 * Every item the server knows, searchable the way the game searches it.
 *
 * <p>The rules here are a port of the plugin's `Catalogue`, down to the order the suffix list is walked in, and the
 * dictionary itself is generated from that same file. That is deliberate: a player who found «алмазная кирка» in the
 * game has to find it here too, and two dictionaries that are nearly the same are worse than one, because the
 * difference only shows up for the person who cannot find their own item.
 *
 * <p>Nothing here decides anything. A search picks which pictures to show; what is actually asked for is the item id
 * underneath, and the plugin checks that against the server's own list before it writes a listing.
 */

/** A found item: what to ask for, and what to call it on screen. */
export interface CatalogueEntry {
  id: string;
  label: string;
  russian: string | null;
}

/** Lowercases, drops the namespace, and treats underscores, hyphens and ё as nothing special. */
export function normalise(text: string): string {
  let value = text.trim().toLowerCase();
  if (value.startsWith("minecraft:")) {
    value = value.slice("minecraft:".length);
  }
  return value.replace(/[_-]/g, " ").replace(/ё/g, "е").trim();
}

/** A Russian word for an item id, or null when nobody is likely to look for it in Russian. */
export function russianName(id: string): string | null {
  const exact = NAME_EXACT.get(id);
  if (exact !== undefined) {
    return exact;
  }
  let head = id;
  let extra = "";
  if (head.startsWith("stripped_")) {
    head = head.slice("stripped_".length);
    extra = " очищенное";
  }
  for (const [ending, word] of NAME_SUFFIXES) {
    if (!head.endsWith(ending)) {
      continue;
    }
    const prefix = NAME_PREFIXES.get(head.slice(0, head.length - ending.length));
    // an unknown first half still leaves a usable word: searching «руда» should find every ore
    return prefix === undefined ? word + extra : `${word} ${prefix}${extra}`;
  }
  return null;
}

/**
 * What to show a player for an item.
 *
 * <p>Deliberately not the Russian word. The dictionary above is written for searching, not for reading: an entry is
 * every word somebody might type, so gold ingots are "золотой слиток золото" and acacia is "акациевый акация".
 * Those find things beautifully and read like machine output, so the name on screen stays the one Minecraft itself
 * uses, and Russian does the work it is good at — finding.
 */
export function label(id: string): string {
  const text = id.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ALL: CatalogueEntry[] = [...ITEM_ICONS]
  .map((id) => ({ id, label: label(id), russian: russianName(id) }))
  .sort((left, right) => left.id.localeCompare(right.id));

/** Everything, in id order. Used to fill the picker before anybody has typed. */
export function everything(): readonly CatalogueEntry[] {
  return ALL;
}

/**
 * Items matching what was typed, best first.
 *
 * <p>Ordering is the whole value of this function: a search for «кирка» that answers with a stone pickaxe on the
 * fourteenth row is a search nobody uses twice. Anything the query starts a word of comes first, in the order the
 * catalogue itself is in, and only then the rest.
 */
export function search(query: string, limit: number): CatalogueEntry[] {
  const needle = normalise(query);
  if (needle === "") {
    return ALL.slice(0, limit);
  }
  const starts: CatalogueEntry[] = [];
  const contains: CatalogueEntry[] = [];
  for (const entry of ALL) {
    const id = normalise(entry.id);
    const russian = entry.russian === null ? null : normalise(entry.russian);
    if (id.startsWith(needle) || (russian !== null && russian.startsWith(needle))) {
      starts.push(entry);
    } else if (id.includes(needle) || (russian !== null && russian.includes(needle))) {
      contains.push(entry);
    }
    if (starts.length >= limit) {
      break;
    }
  }
  return [...starts, ...contains].slice(0, limit);
}
