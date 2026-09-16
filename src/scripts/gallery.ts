import { getConfig, getJson, type GalleryItem, type SiteConfig } from "./api";
import { formatNumber } from "./format";

function card(item: GalleryItem, mapReady: boolean): HTMLElement {
  const article = document.createElement("article");
  article.className = "place";

  const image = document.createElement("img");
  image.className = "place__image";
  image.src = item.imageUrl;
  image.alt = item.description || item.title;
  image.loading = "lazy";
  image.decoding = "async";
  image.width = 800;
  image.height = 500;

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

  const coords = document.createElement("dl");
  coords.className = "place__coords";
  for (const axis of ["x", "y", "z"] as const) {
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = axis.toUpperCase();
    const value = document.createElement("dd");
    value.textContent = formatNumber(item.coords[axis]).replace(/\s/g, "");
    pair.append(term, value);
    coords.append(pair);
  }
  body.append(coords);

  if (mapReady) {
    const link = document.createElement("a");
    link.className = "button button--secondary button--small";
    link.href = `/map?x=${item.coords.x}&z=${item.coords.z}`;
    link.textContent = "Показать на карте";
    body.append(link);
  }

  article.append(image, body);
  return article;
}

export async function initGallery(): Promise<void> {
  const grid = document.querySelector<HTMLElement>("[data-gallery]");
  if (!grid) {
    return;
  }
  const empty = document.querySelector<HTMLElement>("[data-gallery-empty]");
  try {
    const [{ items }, config] = await Promise.all([
      getJson<{ items: GalleryItem[] }>("/api/gallery"),
      getConfig().catch((): SiteConfig | null => null),
    ]);
    grid.replaceChildren(...items.map((item) => card(item, Boolean(config?.map.url))));
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
