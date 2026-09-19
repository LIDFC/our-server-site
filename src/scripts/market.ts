import {
  getConfig,
  getCurrentUser,
  getJson,
  postJson,
  whileVisible,
  type MarketDelivery,
  type MarketListing,
  type MarketMine,
  type MarketTrade,
} from "./api";
import { messageFor } from "./forms";

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

function element<T extends HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function show(node: Element | null, visible: boolean): void {
  if (node instanceof HTMLElement) {
    node.hidden = !visible;
  }
}

function line(parent: HTMLElement, label: string, items: { summary: string }[], fallback: string): void {
  const row = document.createElement("p");
  row.className = "lot__line";
  const title = document.createElement("span");
  title.className = "lot__label";
  title.textContent = label;
  const value = document.createElement("span");
  value.textContent = items.length > 0 ? items.map((item) => item.summary).join(", ") : fallback;
  row.append(title, value);
  parent.append(row);
}

function card(title: string, badge: string | null): { article: HTMLElement; body: HTMLElement } {
  const article = document.createElement("article");
  article.className = "lot";

  const head = document.createElement("div");
  head.className = "lot__head";
  const heading = document.createElement("h3");
  heading.className = "lot__title";
  heading.textContent = title;
  head.append(heading);
  if (badge) {
    const chip = document.createElement("span");
    chip.className = "lot__badge";
    chip.textContent = badge;
    head.append(chip);
  }

  const body = document.createElement("div");
  body.className = "lot__body";
  article.append(head, body);
  return { article, body };
}

function listingCard(listing: MarketListing): HTMLElement {
  const { article, body } = card(`Лот #${listing.id}`, TYPE_NAMES[listing.type] ?? listing.type);
  line(body, "Отдают:", listing.offered, "ничего");
  if (listing.type !== "GIVEAWAY" && listing.type !== "GIFT") {
    line(body, "Хотят:", listing.wanted, "что угодно");
  }
  return article;
}

/** A button that runs one marketplace action and then redraws. Disabled while the request is in flight. */
function actionButton(label: string, kind: "primary" | "secondary", run: () => Promise<string | null>, onDone: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button button--${kind} button--small`;
  button.textContent = label;
  button.addEventListener("click", () => {
    button.disabled = true;
    void run()
      .then((error) => {
        if (error) {
          const message = document.createElement("p");
          message.className = "lot__error";
          message.textContent = error;
          button.parentElement?.append(message);
        }
        onDone();
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return button;
}

async function send(path: string, body: unknown): Promise<string | null> {
  const result = await postJson<Record<string, unknown>>(path, body);
  return result.ok ? null : messageFor(result.error);
}

export function initMarketPage(): void {
  const page = element<HTMLElement>(document, "[data-market]");
  if (!page) {
    return;
  }

  const list = element<HTMLElement>(page, "[data-market-list]");
  const empty = element<HTMLElement>(page, "[data-market-empty]");
  const offline = element<HTMLElement>(page, "[data-market-offline]");
  const mineBlock = element<HTMLElement>(page, "[data-market-mine]");
  const signIn = element<HTMLElement>(page, "[data-market-signin]");
  const unlinked = element<HTMLElement>(page, "[data-market-unlinked]");
  let filter = "";

  const drawBoard = async (): Promise<void> => {
    if (!list) {
      return;
    }
    try {
      const query = filter ? `?type=${filter}&limit=50` : "?limit=50";
      const { listings } = await getJson<{ listings: MarketListing[] }>(`/api/market/listings${query}`);
      list.replaceChildren(...listings.map(listingCard));
      list.setAttribute("aria-busy", "false");
      show(empty, listings.length === 0);
      show(offline, false);
    } catch {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      show(empty, false);
      show(offline, true);
    }
  };

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
      const nick = element<HTMLElement>(page, "[data-market-nick]");
      if (nick) {
        nick.textContent = mine.minecraftUsername;
      }
      return;
    }
    show(unlinked, false);
    show(mineBlock, true);

    const redraw = (): void => {
      void drawMine();
      void drawBoard();
    };

    const listings = element<HTMLElement>(page, "[data-market-my-listings]");
    if (listings) {
      listings.replaceChildren(
        ...mine.listings.map((listing) => {
          const node = listingCard(listing);
          const controls = document.createElement("div");
          controls.className = "lot__actions";
          controls.append(
            actionButton("Снять лот", "secondary", () => send("/api/market/listings/cancel", { listingId: listing.id }), redraw),
          );
          node.append(controls);
          return node;
        }),
      );
      show(element(page, "[data-market-no-listings]"), mine.listings.length === 0);
    }

    const trades = element<HTMLElement>(page, "[data-market-my-trades]");
    if (trades) {
      trades.replaceChildren(...mine.trades.map((trade) => tradeCard(trade, mine.minecraftUuid, redraw)));
      show(element(page, "[data-market-no-trades]"), mine.trades.length === 0);
    }

    const deliveries = element<HTMLElement>(page, "[data-market-my-deliveries]");
    if (deliveries) {
      deliveries.replaceChildren(...mine.deliveries.map(deliveryCard));
      show(element(page, "[data-market-no-deliveries]"), mine.deliveries.length === 0);
      show(element(page, "[data-market-deliveries-note]"), mine.deliveries.length > 0);
    }
  };

  for (const button of page.querySelectorAll<HTMLButtonElement>("[data-market-filter]")) {
    button.addEventListener("click", () => {
      filter = button.dataset["marketFilter"] ?? "";
      for (const other of page.querySelectorAll<HTMLButtonElement>("[data-market-filter]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      list?.setAttribute("aria-busy", "true");
      void drawBoard();
    });
  }

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
      });
    })
    .catch(() => show(offline, true));
}

function tradeCard(trade: MarketTrade, me: string, redraw: () => void): HTMLElement {
  const owner = trade.ownerUuid === me;
  const { article, body } = card(`Сделка #${trade.id} по лоту #${trade.listingId}`, TRADE_STATES[trade.state] ?? trade.state);

  const who = document.createElement("p");
  who.className = "lot__line";
  who.textContent = owner ? "Вам предложили обмен" : "Вы предложили обмен";
  body.append(who);

  const hint = document.createElement("p");
  hint.className = "lot__line lot__hint";
  hint.textContent = "Что именно на обеих сторонах — видно в игре, в окне «Мои сделки».";
  body.append(hint);

  const controls = document.createElement("div");
  controls.className = "lot__actions";
  const answer = (what: "accept" | "decline" | "confirm"): Promise<string | null> =>
    send("/api/market/trades/action", { tradeId: trade.id, action: what });

  if (trade.state === "PENDING" && owner) {
    controls.append(
      actionButton("Принять", "primary", () => answer("accept"), redraw),
      actionButton("Отклонить", "secondary", () => answer("decline"), redraw),
    );
  } else if (trade.state === "ACCEPTED" || trade.state === "CONFIRMED") {
    const mine = owner ? "OWNER" : "BUYER";
    if (trade.confirmations.includes(mine)) {
      const waiting = document.createElement("p");
      waiting.className = "lot__line lot__hint";
      waiting.textContent = "Вы подтвердили, ждём вторую сторону.";
      body.append(waiting);
    } else {
      controls.append(actionButton("Подтвердить обмен", "primary", () => answer("confirm"), redraw));
    }
    controls.append(actionButton("Отменить", "secondary", () => answer("decline"), redraw));
  } else if (trade.state === "PENDING") {
    const waiting = document.createElement("p");
    waiting.className = "lot__line lot__hint";
    waiting.textContent = "Ждём ответа владельца лота.";
    body.append(waiting);
    controls.append(actionButton("Отозвать предложение", "secondary", () => answer("decline"), redraw));
  }

  if (controls.childElementCount > 0) {
    article.append(controls);
  }
  return article;
}

function deliveryCard(delivery: MarketDelivery): HTMLElement {
  const { article, body } = card(delivery.summary, "ждёт в игре");
  const why = document.createElement("p");
  why.className = "lot__line lot__hint";
  why.textContent = `Причина: ${delivery.reason}`;
  body.append(why);
  return article;
}
