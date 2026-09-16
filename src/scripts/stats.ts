import { getJson, type Leaderboard, type StatsSnapshot } from "./api";
import { formatDate, formatDecimal, formatNumber, formatRelative } from "./format";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function formatValue(value: number, unit: string): string {
  return `${Number.isInteger(value) ? formatNumber(value) : formatDecimal(value)} ${unit}`;
}

function renderBoards(container: HTMLElement, leaderboard: Leaderboard, options: { categories?: string[]; size: number }): void {
  const categories = leaderboard.categories.filter((category) => !options.categories || options.categories.includes(category.id));
  container.replaceChildren(
    ...categories.map((category) => {
      const board = element("article", "board");
      board.append(element("h3", "board__title", category.title));
      if (category.entries.length === 0) {
        board.append(element("p", "board__empty", "Пока никого — место свободно"));
        return board;
      }
      const list = element("ol", "board__list");
      for (const entry of category.entries.slice(0, options.size)) {
        const item = element("li", "board__entry");
        item.append(element("span", "board__name", entry.name), element("span", "board__value", formatValue(entry.value, category.unit)));
        list.append(item);
      }
      board.append(list);
      return board;
    }),
  );
}

function renderUnavailable(container: HTMLElement): void {
  container.replaceChildren(
    element("p", "notice", "Статистика пока недоступна: сайт ещё не видит файлы мира Minecraft. Как только сервер сохранит данные игроков, здесь появятся рекорды."),
  );
}

export async function initLeaderboardPreview(): Promise<void> {
  const container = document.querySelector<HTMLElement>("[data-leaderboard-preview]");
  if (!container) {
    return;
  }
  try {
    const leaderboard = await getJson<Leaderboard>("/api/server/leaderboard");
    if (!leaderboard.available) {
      renderUnavailable(container);
      return;
    }
    renderBoards(container, leaderboard, { categories: ["playTime", "distance", "diamonds"], size: 3 });
  } catch {
    container.replaceChildren(element("p", "notice", "Не удалось загрузить доску почёта."));
  }
}

const TOTALS: { key: keyof StatsSnapshot["totals"]; label: string; unit: string }[] = [
  { key: "playTimeHours", label: "Наиграно всеми вместе", unit: "ч" },
  { key: "distanceKm", label: "Пройдено", unit: "км" },
  { key: "diamonds", label: "Добыто алмазов", unit: "" },
  { key: "deaths", label: "Смертей на сервере", unit: "" },
];

const COLUMNS: { label: string; value: (player: StatsSnapshot["players"][number]) => string }[] = [
  { label: "Наиграно, ч", value: (p) => formatDecimal(p.playTimeHours) },
  { label: "Пройдено, км", value: (p) => formatDecimal(p.distanceKm) },
  { label: "Алмазы", value: (p) => formatNumber(p.diamonds) },
  { label: "Блоков добыто", value: (p) => formatNumber(p.blocksMined) },
  { label: "Мобов убито", value: (p) => formatNumber(p.mobKills) },
  { label: "Смерти", value: (p) => formatNumber(p.deaths) },
  { label: "Достижения", value: (p) => formatNumber(p.advancements) },
  { label: "Главный враг", value: (p) => (p.nemesis ? `${p.nemesis.name} (${formatNumber(p.nemesis.deaths)})` : "—") },
  { label: "Заходил", value: (p) => (p.lastPlayedAt ? formatRelative(p.lastPlayedAt) : "—") },
];

export async function initStatsPage(): Promise<void> {
  const page = document.querySelector<HTMLElement>("[data-stats-page]");
  if (!page) {
    return;
  }
  const totals = page.querySelector<HTMLElement>("[data-stats-totals]")!;
  const boards = page.querySelector<HTMLElement>("[data-stats-boards]")!;
  const milestones = page.querySelector<HTMLElement>("[data-stats-milestones]")!;
  const table = page.querySelector<HTMLElement>("[data-stats-table]")!;
  const updated = page.querySelector<HTMLElement>("[data-stats-updated]");

  let snapshot: StatsSnapshot;
  let leaderboard: Leaderboard;
  try {
    [snapshot, leaderboard] = await Promise.all([getJson<StatsSnapshot>("/api/server/stats"), getJson<Leaderboard>("/api/server/leaderboard")]);
  } catch {
    renderUnavailable(boards);
    return;
  }

  if (!snapshot.available) {
    renderUnavailable(boards);
    for (const section of page.querySelectorAll<HTMLElement>("[data-stats-optional]")) {
      section.hidden = true;
    }
    return;
  }

  if (updated) {
    updated.textContent = `Обновлено ${formatRelative(snapshot.updatedAt)}. Minecraft сохраняет статистику, когда игрок выходит с сервера и при автосохранении мира.`;
  }

  totals.replaceChildren(
    ...TOTALS.map((total) => {
      const tile = element("div", "stat-tile");
      tile.append(
        element("dt", "stat-tile__label", total.label),
        element("dd", "stat-tile__value", formatValue(snapshot.totals[total.key], total.unit).trim()),
      );
      return tile;
    }),
  );

  renderBoards(boards, leaderboard, { size: 5 });

  milestones.replaceChildren(
    ...snapshot.milestones.map((milestone) => {
      const item = element("li", `milestone${milestone.first ? " is-reached" : ""}`);
      const text = element("div", "milestone__text");
      text.append(element("span", "milestone__title", milestone.title));
      if (milestone.first) {
        text.append(element("span", "milestone__who", `${milestone.first.name}, ${formatDate(milestone.first.at)}`));
      } else {
        text.append(element("span", "milestone__who", "Пока никто"));
      }
      item.append(text);
      if (milestone.reachedBy > 1) {
        item.append(element("span", "milestone__count", `и ещё ${formatNumber(milestone.reachedBy - 1)}`));
      }
      return item;
    }),
  );

  const head = element("thead", "");
  const headRow = element("tr", "");
  headRow.append(element("th", "", "Игрок"), ...COLUMNS.map((column) => element("th", "", column.label)));
  head.append(headRow);
  const body = element("tbody", "");
  for (const player of snapshot.players) {
    const row = element("tr", "");
    row.append(element("td", "", player.name), ...COLUMNS.map((column) => element("td", "", column.value(player))));
    body.append(row);
  }
  table.replaceChildren(head, body);
}
