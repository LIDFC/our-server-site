import {
  getConfig,
  getCurrentUser,
  getJson,
  postJson,
  whileVisible,
  type MarketBoard,
  type MarketDelivery,
  type MarketItem,
  type MarketListing,
  type MarketMine,
  type MarketPeople,
  type MarketTrade,
  type MarketTradeAnswer,
} from "./api";
import { setupChest } from "./chest";
import { messageFor } from "./forms";
import { icon } from "./icons";
import { parseItem } from "./items";

const REFRESH_MS = 20_000;

const TYPE_NAMES: Record<MarketListing["type"], string> = {
  GIVEAWAY: "Раздача",
  TRADE: "Обмен",
  WANTED: "Заявка",
  GIFT: "Подарок",
};

const TRADE_STATES: Record<MarketTrade["state"], string> = {
  PENDING: "ждёт ответа",
  ACCEPTED: "ждёт подтверждений",
  CONFIRMED: "завершается",
  COMPLETED: "завершена",
  REJECTED: "отклонена",
  CANCELLED: "отменена",
  EXPIRED: "истекла",
};

const FINISHED: MarketTrade["state"][] = ["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"];

const LISTING_STATES: Record<string, string> = {
  DRAFT: "черновик",
  ACTIVE: "на рынке",
  PENDING_TRADE: "идёт сделка",
  COMPLETED: "завершён",
  CANCELLED: "снят",
  EXPIRED: "истёк",
};

/** What the sheet is showing. A trade is fetched by id; a lot is already in hand, so only its id is kept. */
type SheetTarget = { kind: "trade"; id: number } | { kind: "listing"; id: number };

function finished(trade: MarketTrade): boolean {
  return FINISHED.includes(trade.state);
}

function show(node: Element | null, visible: boolean): void {
  if (node instanceof HTMLElement) {
    node.hidden = !visible;
  }
}

/** A player's face, or their initial when they have not uploaded a skin here. */
function face(people: MarketPeople, uuid: string): HTMLElement {
  const person = people[uuid];
  const name = person?.name ?? "неизвестный игрок";
  if (person?.headUrl) {
    const image = document.createElement("img");
    image.className = "face";
    image.src = person.headUrl;
    image.alt = "";
    image.width = 64;
    image.height = 64;
    image.loading = "lazy";
    image.decoding = "async";
    return image;
  }
  const blank = document.createElement("span");
  blank.className = "face face--blank";
  blank.setAttribute("aria-hidden", "true");
  blank.textContent = name.charAt(0).toUpperCase();
  return blank;
}

function who(people: MarketPeople, uuid: string): HTMLElement {
  const row = document.createElement("p");
  row.className = "lot__who";
  const name = document.createElement("span");
  name.className = "lot__name";
  name.textContent = people[uuid]?.name ?? "неизвестный игрок";
  row.append(face(people, uuid), name);
  return row;
}

/** One stack: the glyph, how many, and what it is. */
function stack(item: MarketItem): HTMLElement {
  const parsed = parseItem(item.summary);
  const row = document.createElement("li");
  row.className = "stack";

  const count = document.createElement("span");
  count.className = "stack__count";
  count.textContent = String(parsed.count);

  const label = document.createElement("span");
  label.className = "stack__label";
  label.textContent = parsed.label;
  if (parsed.renamed) {
    label.classList.add("stack__label--renamed");
    label.title = parsed.id.replace(/_/g, " ");
  }

  row.append(icon(parsed.id, parsed.label), count, label);
  return row;
}

function stacks(items: MarketItem[], fallback: string): HTMLElement {
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "side__empty";
    empty.textContent = fallback;
    return empty;
  }
  const list = document.createElement("ul");
  list.className = "side__items";
  list.append(...items.map(stack));
  return list;
}

/**
 * The two halves of an exchange, facing each other. This is the shape of the whole idea, so it is the one place on
 * the page allowed to be loud; everything around it stays quiet.
 */
function exchange(left: { title: string; items: MarketItem[]; fallback: string }, right: { title: string; items: MarketItem[]; fallback: string } | null): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = right ? "exchange" : "exchange exchange--one";

  const side = (part: { title: string; items: MarketItem[]; fallback: string }): HTMLElement => {
    const column = document.createElement("div");
    column.className = "side";
    const title = document.createElement("p");
    title.className = "side__title";
    title.textContent = part.title;
    column.append(title, stacks(part.items, part.fallback));
    return column;
  };

  wrap.append(side(left));
  if (right) {
    const mark = document.createElement("span");
    mark.className = "exchange__mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "⇄";
    wrap.append(mark, side(right));
  }
  return wrap;
}

/**
 * Clears a finished trade out of the list.
 *
 * <p>It hides rather than deletes, and it cannot be otherwise: the marketplace's ledger is append only, which is what
 * proves nothing was duplicated. The trade stays under "Архив", where it can be brought back.
 */
function remove(tradeId: number, after: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "lot__remove";
  node.textContent = "×";
  node.title = "Убрать из списка";
  node.setAttribute("aria-label", `Убрать сделку #${tradeId} из списка`);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    node.disabled = true;
    void send("/api/market/trades/archive", { tradeId }).then(after);
  });
  return node;
}

function badge(text: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "lot__badge";
  chip.textContent = text;
  return chip;
}

function button(label: string, kind: "primary" | "secondary", run: () => Promise<string | null>, after: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `button button--${kind} button--small`;
  node.textContent = label;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    node.disabled = true;
    void run()
      .then((error) => {
        if (error) {
          const message = document.createElement("p");
          message.className = "lot__error";
          message.textContent = error;
          node.parentElement?.append(message);
        }
        after();
      })
      .finally(() => {
        node.disabled = false;
      });
  });
  return node;
}

async function send(path: string, body: unknown): Promise<string | null> {
  const result = await postJson<Record<string, unknown>>(path, body);
  return result.ok ? null : messageFor(result.error);
}

export function initMarketPage(): void {
  const page = document.querySelector<HTMLElement>("[data-market]");
  if (!page) {
    return;
  }

  const find = <T extends HTMLElement>(selector: string): T | null => page.querySelector<T>(selector);
  const list = find("[data-market-list]");
  const empty = find("[data-market-empty]");
  const offline = find("[data-market-offline]");
  const mineBlock = find("[data-market-mine]");
  const signIn = find("[data-market-signin]");
  const unlinked = find("[data-market-unlinked]");
  const sheet = find<HTMLDialogElement>("[data-market-sheet]");
  const sheetBody = find("[data-market-sheet-body]");
  const archiveToggle = find<HTMLButtonElement>("[data-market-archive-toggle]");

  let filter = "";
  let showArchived = false;
  /** what the sheet is showing, so a refresh redraws it instead of leaving stale numbers on screen */
  let openTarget: SheetTarget | null = null;
  /** the Minecraft UUID of whoever is signed in, so a lot can be recognised as their own */
  let myUuid: string | null = null;
  /**
   * Every lot the page has seen, by id. A lot needs no endpoint of its own: the board and "Мои лоты" already answer
   * with the whole thing, so the sheet reads from here and stays in step with the twenty second refresh.
   */
  const knownListings = new Map<number, { listing: MarketListing; players: MarketPeople }>();

  const remember = (listings: MarketListing[], players: MarketPeople): void => {
    for (const listing of listings) {
      knownListings.set(listing.id, { listing, players });
    }
  };

  const drawBoard = async (): Promise<void> => {
    if (!list) {
      return;
    }
    try {
      const query = filter ? `?type=${filter}&limit=50` : "?limit=50";
      const board = await getJson<MarketBoard>(`/api/market/listings${query}`);
      remember(board.listings, board.players);
      list.replaceChildren(...board.listings.map((listing) => listingTile(listing, board.players)));
      list.setAttribute("aria-busy", "false");
      show(empty, board.listings.length === 0);
      show(offline, false);
    } catch {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      show(empty, false);
      show(offline, true);
    }
  };

  function listingTile(listing: MarketListing, players: MarketPeople): HTMLElement {
    const article = document.createElement("article");
    article.className = "lot lot--open";

    const head = document.createElement("header");
    head.className = "lot__head";
    head.append(who(players, listing.ownerUuid), badge(TYPE_NAMES[listing.type] ?? listing.type));
    article.append(head);

    const wantsSide = listing.type === "GIVEAWAY" || listing.type === "GIFT"
      ? null
      : { title: "хочет взамен", items: listing.wanted, fallback: "что предложите" };
    article.append(exchange({ title: "отдаёт", items: listing.offered, fallback: "ничего" }, wantsSide));

    // the whole tile opens the lot; a real button under the content keeps it reachable from the keyboard
    const open = document.createElement("button");
    open.type = "button";
    open.className = "lot__open";
    open.textContent = `Лот #${listing.id}: подробности`;
    open.addEventListener("click", () => openSheet({ kind: "listing", id: listing.id }));
    article.append(open);
    return article;
  }

  const drawMine = async (): Promise<void> => {
    let mine: MarketMine;
    try {
      mine = await getJson<MarketMine>("/api/market/mine");
    } catch {
      show(mineBlock, false);
      return;
    }
    show(signIn, false);
    if (!mine.linked) {
      show(unlinked, true);
      show(mineBlock, false);
      const nick = find("[data-market-nick]");
      if (nick) {
        nick.textContent = mine.minecraftUsername;
      }
      return;
    }
    show(unlinked, false);
    show(mineBlock, true);
    myUuid = mine.minecraftUuid;
    remember(mine.listings, mine.players);

    const redraw = (): void => {
      void drawMine();
      void drawBoard();
    };

    const myListings = find("[data-market-my-listings]");
    if (myListings) {
      myListings.replaceChildren(
        ...mine.listings.map((listing) => {
          const tile = listingTile(listing, mine.players);
          const actions = document.createElement("footer");
          actions.className = "lot__actions";
          actions.append(button("Снять лот", "secondary", () => send("/api/market/listings/cancel", { listingId: listing.id }), redraw));
          tile.append(actions);
          return tile;
        }),
      );
      show(find("[data-market-no-listings]"), mine.listings.length === 0);
    }

    const inArchive = mine.trades.filter((trade) => trade.archived);
    const visible = mine.trades.filter((trade) => trade.archived === showArchived);
    const myTrades = find("[data-market-my-trades]");
    if (myTrades) {
      myTrades.replaceChildren(...visible.map((trade) => tradeTile(trade, mine, redraw)));
      show(find("[data-market-no-trades]"), visible.length === 0);
    }
    if (archiveToggle) {
      archiveToggle.hidden = inArchive.length === 0 && !showArchived;
      archiveToggle.textContent = showArchived ? "Вернуться к активным" : `Архив (${inArchive.length})`;
      archiveToggle.setAttribute("aria-pressed", String(showArchived));
    }

    const myDeliveries = find("[data-market-my-deliveries]");
    if (myDeliveries) {
      myDeliveries.replaceChildren(...mine.deliveries.map(deliveryTile));
      show(find("[data-market-no-deliveries]"), mine.deliveries.length === 0);
      show(find("[data-market-deliveries-note]"), mine.deliveries.length > 0);
    }

    if (openTarget !== null) {
      void fillSheet(openTarget, redraw);
    }
  };

  function tradeTile(trade: MarketTrade & { archived: boolean }, mine: MarketMine, redraw: () => void): HTMLElement {
    const owner = trade.ownerUuid === mine.minecraftUuid;
    const other = owner ? trade.buyerUuid : trade.ownerUuid;

    const article = document.createElement("article");
    article.className = "lot lot--open";
    if (finished(trade)) {
      article.classList.add("lot--done");
    }

    const head = document.createElement("header");
    head.className = "lot__head";
    head.append(who(mine.players, other), badge(TRADE_STATES[trade.state] ?? trade.state));
    article.append(head);

    const what = document.createElement("p");
    what.className = "lot__line";
    what.textContent = `${owner ? "Вам предложили обмен" : "Вы предложили обмен"} по лоту #${trade.listingId}`;
    article.append(what);

    // the whole tile opens the trade; a real button underneath everything keeps it reachable from the keyboard
    const open = document.createElement("button");
    open.type = "button";
    open.className = "lot__open";
    open.textContent = `Сделка #${trade.id}: подробности`;
    open.addEventListener("click", () => openSheet({ kind: "trade", id: trade.id }, redraw));
    article.append(open);

    const actions = document.createElement("footer");
    actions.className = "lot__actions";
    if (finished(trade) && trade.archived) {
      actions.append(
        button("Вернуть в список", "secondary", () => send("/api/market/trades/archive", { tradeId: trade.id, restore: true }), redraw),
      );
    } else if (finished(trade)) {
      // a finished trade is cleared away with the cross in its corner, so the tile stays quiet
      head.append(remove(trade.id, redraw));
    } else {
      actions.append(...answers(trade, owner, redraw));
    }
    if (actions.childElementCount > 0) {
      article.append(actions);
    }
    return article;
  }

  /** The answers this player can give to this trade right now. The same set is used on the tile and in the sheet. */
  function answers(trade: MarketTrade, owner: boolean, redraw: () => void): HTMLButtonElement[] {
    const answer = (what: "accept" | "decline" | "confirm"): Promise<string | null> =>
      send("/api/market/trades/action", { tradeId: trade.id, action: what });

    if (trade.state === "PENDING") {
      return owner
        ? [button("Принять", "primary", () => answer("accept"), redraw), button("Отклонить", "secondary", () => answer("decline"), redraw)]
        : [button("Отозвать предложение", "secondary", () => answer("decline"), redraw)];
    }
    if (trade.state === "ACCEPTED" || trade.state === "CONFIRMED") {
      const mine = owner ? "OWNER" : "BUYER";
      const waiting = trade.confirmations.includes(mine);
      return waiting
        ? [button("Отменить", "secondary", () => answer("decline"), redraw)]
        : [button("Подтвердить обмен", "primary", () => answer("confirm"), redraw), button("Отменить", "secondary", () => answer("decline"), redraw)];
    }
    return [];
  }

  function deliveryTile(delivery: MarketDelivery): HTMLElement {
    const article = document.createElement("article");
    article.className = "lot lot--parcel";
    const head = document.createElement("header");
    head.className = "lot__head";
    head.append(badge("ждёт в игре"));
    article.append(head, stacks([{ summary: delivery.summary, amount: delivery.amount }], "—"));
    return article;
  }

  // the sheet -----------------------------------------------------------------------------------------------------

  function openSheet(target: SheetTarget, redraw?: () => void): void {
    if (!sheet) {
      return;
    }
    openTarget = target;
    void fillSheet(target, redraw ?? (() => undefined));
    if (!sheet.open) {
      sheet.showModal();
    }
  }

  async function fillSheet(target: SheetTarget, redraw: () => void): Promise<void> {
    if (target.kind === "listing") {
      fillListingSheet(target.id, redraw);
      return;
    }
    await fillTradeSheet(target.id, redraw);
  }

  /**
   * A lot, from what the page already has. The board and "Мои лоты" answer with the whole lot, so there is nothing to
   * fetch — and the twenty second refresh keeps an open sheet honest instead of leaving yesterday's numbers on it.
   */
  function fillListingSheet(listingId: number, redraw: () => void): void {
    if (!sheetBody) {
      return;
    }
    const known = knownListings.get(listingId);
    if (!known) {
      sheetBody.replaceChildren(note("Лот уже закрыт или снят с рынка."));
      return;
    }
    const { listing, players } = known;
    const mine = myUuid !== null && listing.ownerUuid === myUuid;

    const title = document.createElement("h2");
    title.className = "sheet__title";
    title.textContent = `Лот #${listing.id} · ${TYPE_NAMES[listing.type] ?? listing.type}`;

    const line = document.createElement("p");
    line.className = "sheet__line";
    const when = listing.createdAt ? new Date(listing.createdAt) : null;
    const date = when && !Number.isNaN(when.getTime()) ? ` · выложен ${when.toLocaleDateString("ru-RU")}` : "";
    line.textContent = `${LISTING_STATES[listing.state] ?? listing.state}${date}`;

    const wantsSide = listing.type === "GIVEAWAY" || listing.type === "GIFT"
      ? null
      : { title: "хочет взамен", items: listing.wanted, fallback: "что предложите" };
    const parties = exchange({ title: "отдаёт", items: listing.offered, fallback: "ничего" }, wantsSide);

    const actions = document.createElement("div");
    actions.className = "sheet__actions";
    if (mine) {
      actions.append(
        button("Снять лот", "secondary", () => send("/api/market/listings/cancel", { listingId: listing.id }), () => {
          sheet?.close();
          redraw();
        }),
      );
    } else {
      // the marketplace API can cancel and answer trades, nothing else: taking a lot needs the item in your hand
      const how = listing.type === "GIVEAWAY" || listing.type === "GIFT" ? `/market take ${listing.id}` : `/market offer ${listing.id}`;
      actions.append(note(`Забрать и предложить обмен можно только в игре: ${how}`));
    }

    sheetBody.replaceChildren(title, who(players, listing.ownerUuid), line, parties, actions);
  }

  async function fillTradeSheet(tradeId: number, redraw: () => void): Promise<void> {
    if (!sheet || !sheetBody) {
      return;
    }
    let answer: MarketTradeAnswer;
    try {
      answer = await getJson<MarketTradeAnswer>(`/api/market/trade?id=${tradeId}`);
    } catch {
      sheetBody.replaceChildren(note("Эта сделка сейчас не читается. Обновите страницу или загляните в игру."));
      return;
    }
    const trade = answer.trade;
    const owner = trade.ownerUuid === answer.you;
    const other = owner ? trade.buyerUuid : trade.ownerUuid;

    const title = document.createElement("h2");
    title.className = "sheet__title";
    title.textContent = `Сделка #${trade.id}`;

    const line = document.createElement("p");
    line.className = "sheet__line";
    line.textContent = `По лоту #${trade.listingId} · ${TRADE_STATES[trade.state] ?? trade.state}`;

    const parties = exchange(
      { title: owner ? "вы отдаёте" : "вы получаете", items: trade.ownerItems, fallback: "ничего" },
      { title: owner ? "вы получаете" : "вы отдаёте", items: trade.buyerItems, fallback: answer.partial ? "видно в игре" : "ничего" },
    );

    const actions = document.createElement("div");
    actions.className = "sheet__actions";
    const afterAction = (): void => {
      redraw();
      void fillTradeSheet(tradeId, redraw);
    };
    if (finished(trade)) {
      actions.append(note("Сделка закрыта. Её можно убрать из списка кнопкой «В архив»."));
    } else {
      actions.append(...answers(trade, owner, afterAction));
    }

    const pieces: HTMLElement[] = [title, who(answer.players, other), line, parties];
    if (answer.partial) {
      // the buyer's half needs the newer plugin; saying so beats showing an empty column with no explanation
      pieces.push(note("Что предложил покупатель, видно в игре: на сервере стоит плагин прошлой версии."));
    }
    pieces.push(actions);
    sheetBody.replaceChildren(...pieces);
  }

  function note(text: string): HTMLElement {
    const paragraph = document.createElement("p");
    paragraph.className = "sheet__note";
    paragraph.textContent = text;
    return paragraph;
  }

  sheet?.addEventListener("close", () => {
    openTarget = null;
  });
  // clicking the backdrop closes it, the way a sheet is expected to behave
  sheet?.addEventListener("click", (event) => {
    if (event.target === sheet) {
      sheet.close();
    }
  });
  find("[data-market-sheet-close]")?.addEventListener("click", () => sheet?.close());

  for (const node of page.querySelectorAll<HTMLButtonElement>("[data-market-filter]")) {
    node.addEventListener("click", () => {
      filter = node.dataset["marketFilter"] ?? "";
      for (const other of page.querySelectorAll<HTMLButtonElement>("[data-market-filter]")) {
        other.setAttribute("aria-pressed", String(other === node));
      }
      list?.setAttribute("aria-busy", "true");
      void drawBoard();
    });
  }

  archiveToggle?.addEventListener("click", () => {
    showArchived = !showArchived;
    void drawMine();
  });

  void getConfig()
    .then((config) => {
      if (!config.market.enabled) {
        show(offline, true);
        list?.setAttribute("aria-busy", "false");
        return;
      }
      whileVisible(drawBoard, REFRESH_MS);
      void getCurrentUser().then((user) => {
        if (!user) {
          show(signIn, true);
          return;
        }
        whileVisible(drawMine, REFRESH_MS);
        // the chest is read once and after every action rather than on the clock: a redraw in the middle of choosing
        // stacks would throw the choice away
        const chest = setupChest(page, () => {
          void drawMine();
          void drawBoard();
        });
        void chest.refresh();
      });
    })
    .catch(() => show(offline, true));
}
