import { getConfig, mapUrl } from "./api";

const COORDINATE = /^-?\d{1,8}$/;

function positionFromPage(): { x: number; z: number } | undefined {
  const params = new URLSearchParams(location.search);
  const x = params.get("x");
  const z = params.get("z");
  if (x && z && COORDINATE.test(x) && COORDINATE.test(z)) {
    return { x: Number(x), z: Number(z) };
  }
  return undefined;
}

type MapState = "loading" | "ready" | "missing" | "error";

/** Shows the children of a state container that belong to the state: data-map-show="ready missing". */
function setState(containers: NodeListOf<HTMLElement>, state: MapState): void {
  for (const container of containers) {
    container.dataset.mapState = state;
    for (const child of container.querySelectorAll<HTMLElement>("[data-map-show]")) {
      child.hidden = !(child.dataset.mapShow ?? "").split(" ").includes(state);
    }
  }
}

export async function initMap(): Promise<void> {
  const frames = document.querySelectorAll<HTMLElement>("[data-map-frame]");
  const states = document.querySelectorAll<HTMLElement>("[data-map-state]");
  const openLinks = document.querySelectorAll<HTMLAnchorElement>("[data-map-open]");
  if (frames.length === 0 && states.length === 0 && openLinks.length === 0) {
    return;
  }

  let config;
  try {
    config = await getConfig();
  } catch {
    setState(states, "error");
    return;
  }

  const position = positionFromPage();
  const fullUrl = mapUrl(config, position);
  if (!fullUrl) {
    setState(states, "missing");
    return;
  }

  setState(states, "ready");
  openLinks.forEach((link) => {
    link.href = fullUrl;
    link.removeAttribute("aria-disabled");
  });

  for (const container of frames) {
    const preview = container.dataset.mapFrame === "preview";
    const frame = document.createElement("iframe");
    frame.src = mapUrl(config, position, preview) ?? fullUrl;
    frame.title = preview ? "Превью карты мира" : "Карта мира";
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    if (preview) {
      // the preview is a picture, the full map opens on its own page
      frame.tabIndex = -1;
      frame.setAttribute("aria-hidden", "true");
    }
    container.replaceChildren(frame);
  }

  const coordinates = document.querySelector<HTMLElement>("[data-map-position]");
  if (coordinates && position) {
    coordinates.hidden = false;
    coordinates.textContent = `Показана точка X ${position.x}, Z ${position.z}.`;
  }
}
