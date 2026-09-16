import { getJson, type OnlineHistory } from "./api";
import { formatDay, formatNumber, formatTime, playersText } from "./format";

const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 240;
const MARGIN = { top: 16, right: 12, bottom: 30, left: 32 };

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function niceMax(value: number): number {
  const steps = [4, 6, 8, 10, 12, 16, 20, 30, 40, 50, 60, 80, 100];
  return steps.find((step) => step >= value) ?? Math.ceil(value / 50) * 50;
}

function describePoint(players: number): string {
  return players < 0 ? "Сервер недоступен" : players === 0 ? "Никого" : playersText(players);
}

/** Longer ranges show the highest number of players per hour, a week of 5-minute samples would be unreadable. */
function hourlyPeaks(points: [number, number][]): [number, number][] {
  const hours = new Map<number, number>();
  for (const [timestamp, players] of points) {
    const hour = Math.floor(timestamp / 3600) * 3600;
    hours.set(hour, Math.max(hours.get(hour) ?? -1, players));
  }
  return [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, players]) => [hour + 1800, players]);
}

function render(root: HTMLElement, history: OnlineHistory): void {
  const plot = root.querySelector<HTMLElement>("[data-chart-plot]")!;
  const tooltip = root.querySelector<HTMLElement>("[data-chart-tooltip]")!;
  const summary = root.querySelector<HTMLElement>("[data-chart-summary]");
  const table = root.querySelector<HTMLTableSectionElement>("[data-chart-table]");

  const now = Math.floor(Date.now() / 1000);
  const start = now - history.hours * 3600;
  const hourly = history.hours > 24;
  const points = hourly ? hourlyPeaks(history.points) : history.points;
  const intervalSeconds = hourly ? 3600 : history.intervalSeconds;
  const width = Math.max(280, plot.clientWidth);
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const maxPlayers = niceMax(Math.max(0, ...points.map(([, players]) => players)));

  const x = (timestamp: number): number => MARGIN.left + ((timestamp - start) / (now - start)) * innerWidth;
  const y = (players: number): number => MARGIN.top + innerHeight - (players / maxPlayers) * innerHeight;

  const chart = svg("svg", {
    width,
    height: HEIGHT,
    viewBox: `0 0 ${width} ${HEIGHT}`,
    class: "chart",
    role: "img",
    tabindex: 0,
    "aria-label": `Число игроков за последние ${history.hours} ч. Стрелками можно перемещаться по точкам.`,
  });

  // grid and value axis
  for (const value of [0, maxPlayers / 2, maxPlayers]) {
    chart.append(svg("line", { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(value), y2: y(value), class: "chart__grid" }));
    const label = svg("text", { x: MARGIN.left - 8, y: y(value) + 4, class: "chart__axis", "text-anchor": "end" });
    label.textContent = formatNumber(value);
    chart.append(label);
  }

  // time axis: every 6 hours for a day, every day for a week
  const tickStep = history.hours <= 24 ? 6 * 3600 : 86400;
  const offset = new Date().getTimezoneOffset() * 60;
  for (let tick = Math.ceil((start - offset) / tickStep) * tickStep + offset; tick <= now; tick += tickStep) {
    const tickX = x(tick);
    if (tickX < MARGIN.left + 16 || tickX > width - MARGIN.right - 16) {
      continue;
    }
    const label = svg("text", { x: tickX, y: HEIGHT - 8, class: "chart__axis", "text-anchor": "middle" });
    label.textContent = history.hours <= 24 ? formatTime(tick * 1000) : formatDay(tick * 1000);
    chart.append(label);
  }

  // continuous stretches: a break when the server was down or no sample was taken
  const maxGap = intervalSeconds * 2.5;
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let previous: number | null = null;
  for (const point of points) {
    const [timestamp, players] = point;
    if (players < 0 || (previous !== null && timestamp - previous > maxGap)) {
      if (current.length > 0) {
        segments.push(current);
      }
      current = [];
    }
    if (players >= 0) {
      current.push(point);
    }
    previous = timestamp;
  }
  if (current.length > 0) {
    segments.push(current);
  }

  for (const segment of segments) {
    const line = segment.map(([timestamp, players], index) => `${index === 0 ? "M" : "L"}${x(timestamp).toFixed(1)},${y(players).toFixed(1)}`).join("");
    const first = segment[0]!;
    const last = segment[segment.length - 1]!;
    if (segment.length > 1) {
      chart.append(svg("path", { d: `${line}L${x(last[0]).toFixed(1)},${y(0)}L${x(first[0]).toFixed(1)},${y(0)}Z`, class: "chart__area" }));
      chart.append(svg("path", { d: line, class: "chart__line" }));
    } else {
      chart.append(svg("circle", { cx: x(first[0]), cy: y(first[1]), r: 3, class: "chart__single" }));
    }
  }

  // stretches without the server, marked on the time axis
  for (const [timestamp, players] of points) {
    if (players < 0) {
      const barWidth = Math.max(2, (intervalSeconds / (now - start)) * innerWidth);
      chart.append(svg("rect", { x: x(timestamp) - barWidth / 2, y: y(0) + 2, width: barWidth, height: 3, class: "chart__offline" }));
    }
  }

  const crosshair = svg("line", { y1: MARGIN.top, y2: y(0), class: "chart__crosshair", visibility: "hidden" });
  const marker = svg("circle", { r: 4.5, class: "chart__marker", visibility: "hidden" });
  chart.append(crosshair, marker);

  let active = -1;
  const show = (index: number): void => {
    const point = points[index];
    if (!point) {
      return;
    }
    active = index;
    const [timestamp, players] = point;
    const pointX = x(timestamp);
    crosshair.setAttribute("x1", String(pointX));
    crosshair.setAttribute("x2", String(pointX));
    crosshair.setAttribute("visibility", "visible");
    marker.setAttribute("cx", String(pointX));
    marker.setAttribute("cy", String(y(Math.max(0, players))));
    marker.setAttribute("visibility", players < 0 ? "hidden" : "visible");

    const value = document.createElement("strong");
    value.textContent = hourly && players > 0 ? `до ${playersText(players)}` : describePoint(players);
    const time = document.createElement("span");
    time.textContent = hourly
      ? `${formatDay(timestamp * 1000)}, ${formatTime((timestamp - 1800) * 1000)}–${formatTime((timestamp + 1800) * 1000)}`
      : formatTime(timestamp * 1000);
    tooltip.replaceChildren(value, time);
    tooltip.hidden = false;
    const left = Math.min(Math.max(pointX, 70), width - 70);
    tooltip.style.left = `${left}px`;
  };
  const hide = (): void => {
    active = -1;
    crosshair.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
  };
  const nearest = (pointerX: number): number => {
    let best = -1;
    let bestDistance = Infinity;
    points.forEach(([timestamp], index) => {
      const distance = Math.abs(x(timestamp) - pointerX);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  };

  chart.addEventListener("pointermove", (event) => {
    const bounds = chart.getBoundingClientRect();
    show(nearest(((event.clientX - bounds.left) / bounds.width) * width));
  });
  chart.addEventListener("pointerleave", hide);
  chart.addEventListener("blur", hide);
  chart.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const start = active < 0 ? points.length - 1 : active + (event.key === "ArrowRight" ? 1 : -1);
    show(Math.min(points.length - 1, Math.max(0, start)));
  });

  plot.replaceChildren(chart);
  if (points.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "История пока пустая: сайт записывает онлайн каждые несколько минут, первые точки появятся совсем скоро.";
    plot.append(empty);
  }

  if (summary) {
    const onlineSamples = points.filter(([, players]) => players >= 0);
    if (points.length === 0) {
      summary.textContent = "Данных за этот период ещё нет.";
    } else if (onlineSamples.length === 0) {
      summary.textContent = "Всё это время сервер был недоступен.";
    } else if (history.peak) {
      const when = history.hours <= 24 ? formatTime(history.peak.at * 1000) : `${formatDay(history.peak.at * 1000)} в ${formatTime(history.peak.at * 1000)}`;
      summary.textContent = `Больше всего — ${playersText(history.peak.players)}, ${when}.`;
    } else {
      summary.textContent = "За это время на сервер никто не заходил.";
    }
  }

  if (table) {
    // the table view lists the highest number of players per hour
    const rows = hourlyPeaks(history.points).reverse().map(([center, players]) => {
      const hour = center - 1800;
      const row = document.createElement("tr");
      const time = document.createElement("td");
      time.textContent = `${formatDay(hour * 1000)}, ${formatTime(hour * 1000)}`;
      const value = document.createElement("td");
      value.textContent = players < 0 ? "недоступен" : formatNumber(players);
      row.append(time, value);
      return row;
    });
    table.replaceChildren(...rows);
  }
}

export function initOnlineCharts(): void {
  for (const root of document.querySelectorAll<HTMLElement>("[data-online-chart]")) {
    let history: OnlineHistory | null = null;
    let request = 0;

    const load = async (hours: number): Promise<void> => {
      const id = ++request;
      root.classList.add("is-loading");
      try {
        const data = await getJson<OnlineHistory>(`/api/server/online-history?hours=${hours}`);
        if (id === request) {
          history = data;
          render(root, data);
        }
      } catch {
        const summary = root.querySelector<HTMLElement>("[data-chart-summary]");
        if (summary && !history) {
          summary.textContent = "Не удалось загрузить историю онлайна. Попробуйте обновить страницу позже.";
        }
      } finally {
        if (id === request) {
          root.classList.remove("is-loading");
        }
      }
    };

    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-chart-range]")) {
      button.addEventListener("click", () => {
        for (const other of root.querySelectorAll<HTMLButtonElement>("[data-chart-range]")) {
          other.setAttribute("aria-pressed", String(other === button));
        }
        void load(Number(button.dataset.chartRange));
      });
    }

    new ResizeObserver(() => {
      if (history) {
        render(root, history);
      }
    }).observe(root.querySelector<HTMLElement>("[data-chart-plot]")!);

    void load(Number(root.dataset.hours ?? 24));
    window.setInterval(() => {
      if (document.visibilityState === "visible" && history) {
        void load(history.hours);
      }
    }, 5 * 60_000);
  }
}
