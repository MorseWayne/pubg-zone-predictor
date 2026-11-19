import type { ISODateString } from "@astryxdesign/core/Calendar";

export const HISTORY_LIMIT = 20;
export const MATCH_TIME_ZONE = "Asia/Shanghai";
const STORAGE_KEY = "pzp_match_range";
export type MatchRange = { mode: "recent" | "day"; day: ISODateString };

export function todayInBeijing(): ISODateString {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: MATCH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()) as ISODateString;
}

export function readMatchRange(): MatchRange {
  const today = todayInBeijing();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (
      saved &&
      (saved.mode === "day" || saved.mode === "recent") &&
      typeof saved.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(saved.day) &&
      saved.day <= today &&
      new Date(saved.day).toISOString().slice(0, 10) === saved.day
    )
      return saved;
  } catch {
    /* A missing or invalid preference uses the default window. */
  }
  return { mode: "recent", day: today };
}

export function saveMatchRange(range: MatchRange) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(range));
}

export function statsWindow(matchDate: string | undefined, ids: string[]) {
  return matchDate ? { match_date: matchDate } : { match_ids: ids, match_limit: HISTORY_LIMIT };
}

const matchDayFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: MATCH_TIME_ZONE });
const matchTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MATCH_TIME_ZONE, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function formatMatchDate(value: string | null, showTime: boolean) {
  if (!value) return "未知";
  const timestamp = new Date(value);
  return (showTime ? matchTimeFormat : matchDayFormat).format(timestamp);
}
