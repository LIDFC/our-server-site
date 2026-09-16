const numberFormat = new Intl.NumberFormat("ru-RU");
const decimalFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const timeWithSecondsFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const relativeFormat = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" });

/** Russian plural: forms for 1, 2–4 and 5 (игрок, игрока, игроков). */
export function plural(count: number, forms: [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) {
    return forms[2];
  }
  if (last === 1) {
    return forms[0];
  }
  if (last >= 2 && last <= 4) {
    return forms[1];
  }
  return forms[2];
}

export const formatNumber = (value: number): string => numberFormat.format(value);
export const formatDecimal = (value: number): string => decimalFormat.format(value);
export const formatDate = (value: string | number | Date): string => dateFormat.format(new Date(value));
export const formatTime = (value: string | number | Date): string => timeFormat.format(new Date(value));
export const formatTimeWithSeconds = (value: string | number | Date): string => timeWithSecondsFormat.format(new Date(value));
export const formatDay = (value: string | number | Date): string => dayFormat.format(new Date(value));

export function formatRelative(value: string | number | Date, now = Date.now()): string {
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relativeFormat.format(Math.round(seconds / size), unit);
    }
  }
  return "только что";
}

export function formatSize(bytes: number): string {
  return `${decimalFormat.format(bytes / 1024 / 1024)} МБ`;
}

export function playersText(count: number): string {
  return `${formatNumber(count)} ${plural(count, ["игрок", "игрока", "игроков"])}`;
}
