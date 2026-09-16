import { getJson, whileVisible, type ServerStatus } from "./api";
import { formatNumber, formatTimeWithSeconds, plural } from "./format";

const REFRESH_MS = 20_000;

function field(panel: HTMLElement, name: string): HTMLElement | null {
  return panel.querySelector<HTMLElement>(`[data-status-${name}]`);
}

function setText(panel: HTMLElement, name: string, text: string): void {
  const element = field(panel, name);
  if (element) {
    element.textContent = text;
  }
}

function render(panel: HTMLElement, status: ServerStatus): void {
  panel.dataset.state = status.online ? "online" : "offline";
  setText(panel, "checked", formatTimeWithSeconds(status.checkedAt));

  const list = field(panel, "players");
  const more = field(panel, "more");
  list?.replaceChildren();
  if (more) {
    more.hidden = true;
  }

  if (!status.online) {
    setText(panel, "label", "Сервер выключен");
    setText(panel, "count", "Сейчас не отвечает");
    setText(panel, "version", "—");
    setText(panel, "response", "—");
    panel.style.setProperty("--glow", "0");
    return;
  }

  setText(panel, "label", "В сети");
  setText(panel, "version", status.version ?? "—");
  setText(panel, "response", status.responseMs === null ? "—" : `${formatNumber(status.responseMs)} мс`);

  const players = status.players;
  if (!players) {
    setText(panel, "count", "Сервер скрывает онлайн");
    panel.style.setProperty("--glow", "0.35");
    return;
  }

  setText(panel, "count", `${formatNumber(players.online)} из ${formatNumber(players.max)} ${plural(players.max, ["игрока", "игроков", "игроков"])}`);
  // the lantern burns brighter the more people play, a little light stays on while the server is empty
  const share = players.max > 0 ? players.online / players.max : 0;
  panel.style.setProperty("--glow", String(Math.min(1, 0.3 + share * 0.7).toFixed(2)));

  if (players.online === 0) {
    const empty = document.createElement("li");
    empty.className = "player-list__empty";
    empty.textContent = "Пока никого нет — зайдите первым";
    list?.append(empty);
    return;
  }
  for (const name of status.playerNames) {
    const item = document.createElement("li");
    item.className = "player-chip";
    item.textContent = name;
    list?.append(item);
  }
  const hidden = players.online - status.playerNames.length;
  if (more && hidden > 0) {
    more.hidden = false;
    more.textContent =
      status.playerNames.length > 0
        ? `и ещё ${formatNumber(hidden)} — сервер показывает не весь список`
        : `${formatNumber(hidden)} ${plural(hidden, ["игрок скрыл", "игрока скрыли", "игроков скрыли"])} свой ник`;
  }
}

export function initStatusPanels(): void {
  const panels = [...document.querySelectorAll<HTMLElement>("[data-status-panel]")];
  if (panels.length === 0) {
    return;
  }
  whileVisible(async () => {
    try {
      const status = await getJson<ServerStatus>("/api/server/status");
      panels.forEach((panel) => render(panel, status));
    } catch {
      // the website API failed, which says nothing about the Minecraft server
      for (const panel of panels) {
        if (panel.dataset.state === "loading") {
          panel.dataset.state = "error";
          setText(panel, "label", "Статус недоступен");
          setText(panel, "count", "Не удалось узнать, работает ли сервер");
        }
      }
    }
  }, REFRESH_MS);
}
