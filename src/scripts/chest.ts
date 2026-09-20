import { getJson, postJson, type MarketChest, type MarketChestSlot } from "./api";
import { label as itemLabel, search } from "./catalogue";
import { messageFor } from "./forms";
import { icon } from "./icons";
import { parseItem } from "./items";

/**
 * The bound chest, on the website.
 *
 * <p>This is the only place on the site where a player can put something up for trade, and it works while they are
 * offline — which is the whole point of binding a chest in the first place. Everything shown here is a picture of a
 * real box in the world: the items are not held by the marketplace and are not held by the site, they are lying in a
 * chest, and the fingerprint that came with them is what makes it safe to act on a picture that may already be out
 * of date.
 *
 * <p>Nothing here refreshes on a timer. A list that redraws itself every twenty seconds would throw away a selection
 * the player is halfway through making; instead the chest is read when the section opens and after every action, and
 * if the world moved underneath it the marketplace refuses and says so, which is the honest answer.
 */

const MAX_STACKS = 27;
const RESULTS = 12;

type ListingType = "GIVEAWAY" | "TRADE" | "WANTED" | "GIFT";

const TYPE_LABELS: { value: ListingType; text: string; hint: string }[] = [
  { value: "GIVEAWAY", text: "Раздача", hint: "Отдаю просто так — кто первый, тот и забрал." },
  { value: "TRADE", text: "Обмен", hint: "Отдаю это и хочу кое-что взамен." },
  { value: "WANTED", text: "Заявка", hint: "Ищу вещь, а это предлагаю за неё." },
  { value: "GIFT", text: "Подарок", hint: "Лично для одного игрока, другим не видно." },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** Russian counts its nouns: 1 слот, 2 слота, 54 слота, 27 слотов. */
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) {
    return many;
  }
  const last = count % 10;
  if (last === 1) {
    return one;
  }
  return last >= 2 && last <= 4 ? few : many;
}

function show(node: Element | null, visible: boolean): void {
  if (node instanceof HTMLElement) {
    node.hidden = !visible;
  }
}

export interface ChestSection {
  /** Reads the chest again. Called when the section first appears and after anything has been put up. */
  refresh(): Promise<void>;
}

export function setupChest(page: HTMLElement, onListed: () => void): ChestSection {
  const find = (selector: string): HTMLElement | null => page.querySelector<HTMLElement>(selector);

  const section = find("[data-chest]");
  const grid = find("[data-chest-grid]");
  const chosen = find("[data-chest-chosen]");
  const wishBox = find("[data-chest-wishes]");
  const wishList = find("[data-chest-wish-list]");
  const wishResults = find("[data-chest-wish-results]");
  const wishSearch = page.querySelector<HTMLInputElement>("[data-chest-wish-search]");
  const noteInput = page.querySelector<HTMLInputElement>("[data-chest-note]");
  const recipientBox = find("[data-chest-recipient-box]");
  const recipientInput = page.querySelector<HTMLInputElement>("[data-chest-recipient]");
  const submit = page.querySelector<HTMLButtonElement>("[data-chest-submit]");
  const release = page.querySelector<HTMLButtonElement>("[data-chest-release]");
  const status = find("[data-chest-status]");
  const where = find("[data-chest-where]");

  let chest: MarketChest | null = null;
  let type: ListingType = "GIVEAWAY";
  /** slot number to how many of that stack goes into the listing */
  const picked = new Map<number, number>();
  /** item id to how many are wanted in return */
  const wishes = new Map<string, number>();
  let busy = false;

  const say = (text: string, kind: "error" | "success" | "quiet"): void => {
    if (status) {
      status.textContent = text;
      status.dataset["kind"] = kind;
      status.hidden = text === "";
    }
  };

  const slotOf = (slot: number): MarketChestSlot | undefined => chest?.slots.find((entry) => entry.slot === slot);

  function drawGrid(): void {
    if (!grid || !chest) {
      return;
    }
    const cells: HTMLElement[] = [];
    for (let slot = 0; slot < chest.size; slot++) {
      const filled = slotOf(slot);
      const cell = element("button", "chest__slot");
      cell.type = "button";
      if (!filled) {
        cell.classList.add("chest__slot--empty");
        cell.disabled = true;
        cell.setAttribute("aria-hidden", "true");
        cell.tabIndex = -1;
        cells.push(cell);
        continue;
      }
      const item = parseItem(filled.summary);
      const name = item.label;
      cell.append(icon(item.id, name), element("span", "chest__count", String(filled.amount)));
      cell.title = `${name} · ${filled.amount} шт.`;
      cell.setAttribute("aria-label", `${name}, ${filled.amount} штук`);
      cell.setAttribute("aria-pressed", String(picked.has(slot)));
      if (picked.has(slot)) {
        cell.classList.add("chest__slot--picked");
      }
      cell.addEventListener("click", () => toggle(slot));
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
  }

  function toggle(slot: number): void {
    const filled = slotOf(slot);
    if (!filled) {
      return;
    }
    if (picked.has(slot)) {
      picked.delete(slot);
    } else {
      if (picked.size >= MAX_STACKS) {
        say(`В одном лоте не больше ${MAX_STACKS} стопок`, "error");
        return;
      }
      picked.set(slot, filled.amount);
      say("", "quiet");
    }
    drawGrid();
    drawChosen();
    updateSubmit();
  }

  /** The chosen stacks, each with how many of it to put up. A player rarely wants the whole stack. */
  function drawChosen(): void {
    if (!chosen) {
      return;
    }
    if (picked.size === 0) {
      chosen.replaceChildren(element("p", "chest__hint", "Выберите в сундуке то, что выкладываете."));
      return;
    }
    const rows = [...picked.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([slot, amount]) => {
        const filled = slotOf(slot);
        const item = parseItem(filled?.summary ?? "");
        const shown = item.label;
        const row = element("li", "chest-pick");
        const name = element("span", "chest-pick__name", shown);

        const count = document.createElement("input");
        count.type = "number";
        count.className = "chest-pick__amount";
        count.min = "1";
        count.max = String(filled?.amount ?? amount);
        count.value = String(amount);
        count.setAttribute("aria-label", `Сколько ${shown} выложить`);
        count.addEventListener("change", () => {
          const most = filled?.amount ?? amount;
          const wanted = Math.min(Math.max(1, Math.round(Number(count.value) || 1)), most);
          count.value = String(wanted);
          picked.set(slot, wanted);
        });

        const drop = element("button", "chest-pick__drop", "×");
        drop.type = "button";
        drop.setAttribute("aria-label", `Убрать ${shown} из лота`);
        drop.addEventListener("click", () => toggle(slot));

        row.append(icon(item.id, shown), name, count, element("span", "chest-pick__of", `из ${filled?.amount ?? amount}`), drop);
        return row;
      });
    const list = element("ul", "chest-picks");
    list.append(...rows);
    chosen.replaceChildren(list);
  }

  // what is wanted in return ---------------------------------------------------------------------------------------

  function drawWishes(): void {
    if (!wishList) {
      return;
    }
    if (wishes.size === 0) {
      wishList.replaceChildren(element("p", "chest__hint", "Пока ничего не выбрано — найдите вещь в поиске."));
      return;
    }
    const rows = [...wishes.entries()].map(([id, amount]) => {
      const row = element("li", "chest-pick");
      const count = document.createElement("input");
      count.type = "number";
      count.className = "chest-pick__amount";
      count.min = "1";
      count.max = "64";
      count.value = String(amount);
      count.setAttribute("aria-label", "Сколько нужно");
      count.addEventListener("change", () => {
        const wanted = Math.min(Math.max(1, Math.round(Number(count.value) || 1)), 64);
        count.value = String(wanted);
        wishes.set(id, wanted);
      });
      const drop = element("button", "chest-pick__drop", "×");
      drop.type = "button";
      drop.setAttribute("aria-label", "Убрать из списка");
      drop.addEventListener("click", () => {
        wishes.delete(id);
        drawWishes();
      });
      const name = itemLabel(id);
      row.append(icon(id, name), element("span", "chest-pick__name", name), count, drop);
      return row;
    });
    const list = element("ul", "chest-picks");
    list.append(...rows);
    wishList.replaceChildren(list);
  }

  function drawResults(query: string): void {
    if (!wishResults) {
      return;
    }
    const found = search(query, RESULTS);
    if (found.length === 0) {
      wishResults.replaceChildren(element("p", "chest__hint", "Ничего не нашлось. Попробуйте другое слово."));
      return;
    }
    const buttons = found.map((entry) => {
      const pick = element("button", "chest-find");
      pick.type = "button";
      pick.append(icon(entry.id, entry.label), element("span", "chest-find__name", entry.label));
      pick.addEventListener("click", () => {
        if (!wishes.has(entry.id) && wishes.size >= MAX_STACKS) {
          say(`Не больше ${MAX_STACKS} разных вещей в списке`, "error");
          return;
        }
        wishes.set(entry.id, wishes.get(entry.id) ?? 1);
        drawWishes();
      });
      return pick;
    });
    wishResults.replaceChildren(...buttons);
  }

  // the form -------------------------------------------------------------------------------------------------------

  function updateSubmit(): void {
    if (submit) {
      submit.disabled = busy || picked.size === 0;
    }
    show(wishBox, type === "TRADE" || type === "WANTED");
    show(recipientBox, type === "GIFT");
  }

  async function putUp(): Promise<void> {
    if (!chest || picked.size === 0 || busy) {
      return;
    }
    busy = true;
    updateSubmit();
    say("Выкладываем…", "quiet");

    const take = [...picked.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([slot, amount]) => ({ slot, sha256: slotOf(slot)?.sha256 ?? "", amount }));
    const wanted = type === "TRADE" || type === "WANTED"
      ? [...wishes.entries()].map(([material, amount]) => ({ material, amount }))
      : [];

    const answer = await postJson<{ listingId: number }>("/api/market/chest/listing", {
      type,
      chestDigest: chest.digest,
      note: noteInput?.value ?? null,
      recipientName: type === "GIFT" ? (recipientInput?.value ?? null) : null,
      take,
      wanted,
    });

    busy = false;
    if (answer.ok) {
      picked.clear();
      wishes.clear();
      if (noteInput) {
        noteInput.value = "";
      }
      say(`Лот #${answer.data?.listingId ?? ""} на рынке.`, "success");
      await refresh();
      onListed();
      return;
    }
    // the chest moved under us: the picture is stale, so replace it rather than let them try the same thing again
    if (answer.error === "chest-changed" || answer.error === "chest-missing") {
      picked.clear();
      await refresh();
    }
    say(messageFor(answer.error), "error");
    updateSubmit();
  }

  async function letGo(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    const answer = await postJson<Record<string, unknown>>("/api/market/chest/release", {});
    busy = false;
    if (!answer.ok) {
      say(messageFor(answer.error), "error");
      return;
    }
    picked.clear();
    say("Сундук отвязан.", "success");
    await refresh();
  }

  async function refresh(): Promise<void> {
    let answer: MarketChest & { linked: boolean };
    try {
      answer = await getJson<MarketChest & { linked: boolean }>("/api/market/chest");
    } catch {
      show(section, false);
      return;
    }
    show(section, answer.linked);
    if (!answer.linked) {
      return;
    }
    chest = answer.bound ? answer : null;
    show(find("[data-chest-none]"), !answer.bound);
    show(find("[data-chest-body]"), answer.bound);
    show(release, answer.bound);
    if (!answer.bound) {
      return;
    }
    // a stale pick would quietly ask for a slot that now holds something else; the plugin would refuse it anyway
    for (const slot of [...picked.keys()]) {
      const still = slotOf(slot);
      if (!still) {
        picked.delete(slot);
      } else {
        picked.set(slot, Math.min(picked.get(slot) ?? still.amount, still.amount));
      }
    }
    if (where) {
      const box = answer.kind === "DOUBLE" ? "большой сундук" : "сундук";
      where.textContent = `Ваш ${box} на ${answer.size} ${plural(answer.size, "слот", "слота", "слотов")}, координаты ${answer.x}, ${answer.y}, ${answer.z}.`;
    }
    drawGrid();
    drawChosen();
    drawWishes();
    updateSubmit();
  }

  // wiring ---------------------------------------------------------------------------------------------------------

  for (const option of TYPE_LABELS) {
    const node = page.querySelector<HTMLInputElement>(`[data-chest-type="${option.value}"]`);
    node?.addEventListener("change", () => {
      if (node.checked) {
        type = option.value;
        const hint = find("[data-chest-type-hint]");
        if (hint) {
          hint.textContent = option.hint;
        }
        updateSubmit();
      }
    });
  }

  wishSearch?.addEventListener("input", () => drawResults(wishSearch.value));
  submit?.addEventListener("click", () => void putUp());
  release?.addEventListener("click", () => void letGo());
  drawResults("");

  return { refresh };
}
