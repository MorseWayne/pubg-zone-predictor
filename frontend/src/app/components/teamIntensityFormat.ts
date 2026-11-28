import { mapDisplayName } from "../matchDisplay";
import { MATCH_TIME_ZONE } from "../matchRange";

export const MAX_COMPARE_DAYS = 7;

export const DAY_PALETTE = [
  "#3987e5",
  "#199e70",
  "#e68a00",
  "#9b6dff",
  "#e0569c",
  "#00a8b5",
  "#d9534f",
] as const;

export const MEMBER_SERIES = ["#3987e5", "#199e70", "#e68a00", "#9b6dff"];

export function buildDayColorMap(dates: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  dates.forEach((date, index) => {
    map[date] = DAY_PALETTE[index % DAY_PALETTE.length];
  });
  return map;
}

export function averageNullable(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let count = 0;
  for (const val of values) {
    if (val !== null && val !== undefined && Number.isFinite(val)) {
      sum += val;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return String(Math.round(value));
}

export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}

export type DeltaInfo = {
  text: string;
  direction: "up" | "down" | "flat";
  raw: number;
};

export function computeDelta(
  current: number | null | undefined,
  baseline: number | null | undefined,
  options?: { digits?: number; isPercent?: boolean; unit?: string },
): DeltaInfo | null {
  if (
    current === null ||
    current === undefined ||
    baseline === null ||
    baseline === undefined ||
    Number.isNaN(current) ||
    Number.isNaN(baseline)
  ) {
    return null;
  }
  const diff = current - baseline;
  const digits = options?.digits ?? 2;
  const threshold = options?.isPercent ? 0.0005 : Math.pow(10, -(digits + 1)) * 5;
  if (Math.abs(diff) < threshold) {
    return { text: "持平", direction: "flat", raw: 0 };
  }
  const sign = diff > 0 ? "+" : "";
  const formatted = options?.isPercent
    ? `${sign}${(diff * 100).toFixed(digits)}%`
    : `${sign}${digits === 0 ? Math.round(diff) : diff.toFixed(digits)}${options?.unit ?? ""}`;
  return {
    text: formatted,
    direction: diff > 0 ? "up" : "down",
    raw: diff,
  };
}

const beijingDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MATCH_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const beijingMonthDayFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MATCH_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
});

const beijingHourMinuteFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MATCH_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function toDateFromEpoch(ts: number | null | undefined): Date | null {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return null;
  // Backend stores Unix seconds (float); guard against accidental ms values.
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatObservedDate(ts: number | null | undefined): string {
  const date = toDateFromEpoch(ts);
  if (!date) return "—";
  return beijingDateFormatter.format(date).replace(/\//g, "-");
}

export function formatObservedRange(
  minAt: number | null | undefined,
  maxAt: number | null | undefined,
): string | null {
  const minDate = toDateFromEpoch(minAt);
  const maxDate = toDateFromEpoch(maxAt);
  if (!minDate && !maxDate) return null;
  const start = minDate ?? maxDate!;
  const end = maxDate ?? minDate!;
  const startDay = beijingDateFormatter.format(start).replace(/\//g, "-");
  const endDay = beijingDateFormatter.format(end).replace(/\//g, "-");
  if (startDay === endDay) return startDay;
  const endShort = beijingMonthDayFormatter.format(end).replace(/\//g, "-");
  return `${startDay} 至 ${endShort}`;
}

export function formatBeijingClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return beijingHourMinuteFormatter.format(d);
}

export function formatTimeWindow(
  firstIso: string | null | undefined,
  lastIso: string | null | undefined,
): string {
  const start = formatBeijingClock(firstIso);
  const end = formatBeijingClock(lastIso);
  if (start === "—" && end === "—") return "—";
  if (start === end) return start;
  return `${start} – ${end}`;
}

export function formatShortDate(ymd: string): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  return `${parts[1]}-${parts[2]}`;
}

export function formatMultiDayLabel(ymd: string, contextDates: string[]): string {
  const parts = ymd.split("-");
  if (parts.length !== 3) return ymd;
  const years = new Set<string>();
  years.add(parts[0]);
  for (const d of contextDates) {
    const y = d.split("-")[0];
    if (y) years.add(y);
  }
  return years.size > 1 ? ymd : `${parts[1]}-${parts[2]}`;
}

const MODE_LABELS: Record<string, string> = {
  "squad-fpp": "四排 FPP",
  squad: "四排 TPP",
  "duo-fpp": "双排 FPP",
  duo: "双排 TPP",
  "solo-fpp": "单排 FPP",
  solo: "单排 TPP",
};

export function formatModeLabel(mode: string | null | undefined): string {
  if (!mode) return "未知模式";
  return MODE_LABELS[mode] ?? mode;
}

export function formatMapsSummary(maps: Record<string, number>, maxItems = 3): string {
  const entries = Object.entries(maps).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return "—";
  const shown = entries
    .slice(0, maxItems)
    .map(([name, count]) => `${mapDisplayName(name)}×${count}`);
  const rest = entries.length - maxItems;
  return rest > 0 ? `${shown.join("、")} 等 ${entries.length} 图` : shown.join("、");
}

export function formatPlayerName(player: { player_id: string; player_name?: string | null }): string {
  return player.player_name || player.player_id.replace(/^account\./, "");
}
