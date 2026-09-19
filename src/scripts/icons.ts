import { ITEM_ICONS } from "../generated/item-icons";

/**
 * Item icons: Minecraft's own textures, 16×16, served from /items/<id>.png.
 *
 * <p>They are drawn by the people who drew the game, so a player recognises a stack at a glance instead of decoding a
 * symbol. Scaling is left to the browser with `image-rendering: pixelated`, the same treatment as the player's face:
 * smoothing a 16 pixel texture destroys the thing that makes it recognisable.
 *
 * <p>The generated set says which ids actually have a texture. Checking it beforehand means an unknown item shows a
 * quiet placeholder instead of a broken image and a request that answers 404.
 */

/** One item icon, ready to put in the page. Decorative: the item's name is always written beside it. */
export function icon(id: string, label: string): HTMLElement {
  if (!ITEM_ICONS.has(id)) {
    const blank = document.createElement("span");
    blank.className = "icon icon--unknown";
    blank.setAttribute("aria-hidden", "true");
    blank.title = id.replace(/_/g, " ");
    return blank;
  }
  const image = document.createElement("img");
  image.className = "icon";
  image.src = `/items/${id}.png`;
  image.alt = "";
  image.title = label;
  image.width = 16;
  image.height = 16;
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}
