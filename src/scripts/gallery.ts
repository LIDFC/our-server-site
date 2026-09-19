import { getConfig, getJson, type GalleryItem, type SiteConfig } from "./api";
import { formatDate, formatNumber } from "./format";

function coordinate(value: number): string {
  return formatNumber(value).replace(/\s/g, "");
}

function coords(item: GalleryItem): HTMLElement {
  const list = document.createElement("dl");
  list.className = "place__coords";
  for (const axis of ["x", "y", "z"] as const) {
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = axis.toUpperCase();
    const value = document.createElement("dd");
    value.textContent = coordinate(item.coords[axis]);
    pair.append(term, value);
    list.append(pair);
  }
  return list;
}

function photo(item: GalleryItem, className: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.src = item.imageUrl;
  image.alt = item.description || item.title;
  image.loading = "lazy";
  image.decoding = "async";
  image.width = 800;
  image.height = 500;
  return image;
}

function mapButton(item: GalleryItem): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "button button--secondary button--small";
  link.href = `/map?x=${item.coords.x}&z=${item.coords.z}`;
  link.textContent = "Показать на карте";
  return link;
}

function card(item: GalleryItem, mapReady: boolean, open: (item: GalleryItem) => void): HTMLElement {
  const article = document.createElement("article");
  article.className = "place place--open";

  const body = document.createElement("div");
  body.className = "place__body";

  const title = document.createElement("h3");
  title.className = "place__title";
  title.textContent = item.title;

  const author = document.createElement("p");
  author.className = "place__author";
  author.textContent = `Автор: ${item.author}`;

  body.append(title, author);
  if (item.description) {
    const description = document.createElement("p");
    description.className = "place__description";
    description.textContent = item.description;
    body.append(description);
  }
  body.append(coords(item));
  if (mapReady) {
    body.append(mapButton(item));
  }

  article.append(photo(item, "place__image"), body);

  // the whole card opens the place; a real button under the content keeps it reachable from the keyboard
  const opener = document.createElement("button");
  opener.type = "button";
  opener.className = "place__open";
  opener.textContent = `${item.title}: подробнее и фото во весь экран`;
  opener.addEventListener("click", () => open(item));
  article.append(opener);
  return article;
}

/**
 * Fills the screen with the photo.
 *
 * <p>Real fullscreen when the browser allows it. It does not always: an embedded view refuses with a permissions
 * error, and then a button that silently does nothing is worse than no button. So a refusal falls back to stretching
 * the sheet itself over the viewport, which is CSS and cannot be refused.
 */
function enlarge(sheet: HTMLDialogElement | null, frame: HTMLElement, label: HTMLButtonElement): void {
  const expanded = (on: boolean): void => {
    sheet?.classList.toggle("sheet--full", on);
    label.textContent = on ? "Свернуть" : "Во весь экран";
  };

  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  if (sheet?.classList.contains("sheet--full")) {
    expanded(false);
    return;
  }
  const request = frame.requestFullscreen?.();
  if (!request) {
    expanded(true);
    return;
  }
  void request.then(() => expanded(false)).catch(() => expanded(true));
}

/** The sheet: the photo large, everything the entry knows, and a way to fill the screen with it. */
function details(item: GalleryItem, mapReady: boolean, sheet: HTMLDialogElement | null): HTMLElement[] {
  const title = document.createElement("h2");
  title.className = "sheet__title";
  title.textContent = item.title;

  const frame = document.createElement("div");
  frame.className = "shot";
  const image = photo(item, "shot__image");
  image.loading = "eager";
  frame.append(image);

  const author = document.createElement("p");
  author.className = "sheet__line";
  const added = item.addedAt ? ` · ${formatDate(item.addedAt)}` : "";
  author.textContent = `Автор: ${item.author}${added}`;

  const pieces: HTMLElement[] = [title, frame, author];
  if (item.description) {
    const description = document.createElement("p");
    description.textContent = item.description;
    pieces.push(description);
  }
  pieces.push(coords(item));

  const actions = document.createElement("div");
  actions.className = "sheet__actions";

  const full = document.createElement("button");
  full.type = "button";
  full.className = "button button--primary button--small";
  full.textContent = "Во весь экран";
  full.addEventListener("click", () => enlarge(sheet, frame, full));
  actions.append(full);
  if (mapReady) {
    actions.append(mapButton(item));
  }
  pieces.push(actions);
  return pieces;
}

export async function initGallery(): Promise<void> {
  const grid = document.querySelector<HTMLElement>("[data-gallery]");
  if (!grid) {
    return;
  }
  const empty = document.querySelector<HTMLElement>("[data-gallery-empty]");
  const sheet = document.querySelector<HTMLDialogElement>("[data-gallery-sheet]");
  const sheetBody = document.querySelector<HTMLElement>("[data-gallery-sheet-body]");
  let mapReady = false;

  const open = (item: GalleryItem): void => {
    if (!sheet || !sheetBody) {
      return;
    }
    sheet.classList.remove("sheet--full");
    sheetBody.replaceChildren(...details(item, mapReady, sheet));
    if (!sheet.open) {
      sheet.showModal();
    }
  };

  // closing while the photo fills the screen would leave the browser in fullscreen with nothing in it
  sheet?.addEventListener("close", () => {
    sheet.classList.remove("sheet--full");
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  });
  sheet?.addEventListener("click", (event) => {
    if (event.target === sheet) {
      sheet.close();
    }
  });
  document.querySelector("[data-gallery-sheet-close]")?.addEventListener("click", () => sheet?.close());

  try {
    const [{ items }, config] = await Promise.all([
      getJson<{ items: GalleryItem[] }>("/api/gallery"),
      getConfig().catch((): SiteConfig | null => null),
    ]);
    mapReady = Boolean(config?.map.url);
    grid.replaceChildren(...items.map((item) => card(item, mapReady, open)));
    grid.setAttribute("aria-busy", "false");
    if (empty) {
      empty.hidden = items.length > 0;
    }
  } catch {
    grid.setAttribute("aria-busy", "false");
    grid.replaceChildren();
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Не удалось загрузить галерею. Попробуйте обновить страницу.";
    }
  }
}
