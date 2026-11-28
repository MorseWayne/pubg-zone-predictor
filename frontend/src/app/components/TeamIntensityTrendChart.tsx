import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TeamDayTrendPoint } from "../api";
import {
  MAX_COMPARE_DAYS,
  formatDecimal,
  formatInt,
  formatMapsSummary,
  formatMultiDayLabel,
  formatPercent,
  formatShortDate,
} from "./teamIntensityFormat";

export type TrendMetricKey =
  | "kd_p50"
  | "opponent_damage_p50"
  | "team_damage_taken_per_match"
  | "bot_rate";

export type TrendViewMode = "overview" | TrendMetricKey;

type OverviewSeriesKey =
  | "kd_p50"
  | "opponent_damage_p50"
  | "team_damage_taken_per_match"
  | "human_rate";

type OverviewSeriesConfig = {
  key: OverviewSeriesKey;
  label: string;
  color: string;
  getValue: (row: TeamDayTrendPoint) => number | null;
  format: (value: number | null) => string;
};

const OVERVIEW_SERIES: OverviewSeriesConfig[] = [
  {
    key: "kd_p50",
    label: "对手赛季 KD",
    color: "#38bdf8",
    getValue: (row) => row.kd_p50,
    format: (v) => formatDecimal(v, 2),
  },
  {
    key: "opponent_damage_p50",
    label: "对手当场伤害",
    color: "#fbbf24",
    getValue: (row) => row.opponent_damage_p50,
    format: (v) => formatInt(v),
  },
  {
    key: "team_damage_taken_per_match",
    label: "你们场均承伤",
    color: "#fb7185",
    getValue: (row) => row.team_damage_taken_per_match,
    format: (v) => formatInt(v),
  },
  {
    key: "human_rate",
    label: "大厅真人占比",
    color: "#34d399",
    getValue: (row) =>
      row.bot_rate !== null && Number.isFinite(row.bot_rate)
        ? Math.max(0, Math.min(1, 1 - row.bot_rate))
        : null,
    format: (v) => formatPercent(v, 1),
  },
];

type SingleMetricConfig = {
  key: TrendMetricKey;
  label: string;
  color: string;
  format: (value: number | null) => string;
  formatAxis: (value: number) => string;
  isPercent?: boolean;
};

const SINGLE_METRICS: Record<TrendMetricKey, SingleMetricConfig> = {
  kd_p50: {
    key: "kd_p50",
    label: "对手赛季 KD",
    color: "#38bdf8",
    format: (v) => formatDecimal(v, 2),
    formatAxis: (v) => v.toFixed(1),
  },
  opponent_damage_p50: {
    key: "opponent_damage_p50",
    label: "对手当场伤害",
    color: "#fbbf24",
    format: (v) => formatInt(v),
    formatAxis: (v) => String(Math.round(v)),
  },
  team_damage_taken_per_match: {
    key: "team_damage_taken_per_match",
    label: "你们场均承伤",
    color: "#fb7185",
    format: (v) => formatInt(v),
    formatAxis: (v) => String(Math.round(v)),
  },
  bot_rate: {
    key: "bot_rate",
    label: "大厅人机占比",
    color: "#34d399",
    format: (v) => formatPercent(v, 1),
    formatAxis: (v) => (v > 0 && v < 0.05 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`),
    isPercent: true,
  },
};

const MODE_OPTIONS: Array<{ key: TrendViewMode; label: string }> = [
  { key: "overview", label: "整体趋势" },
  { key: "kd_p50", label: "对手赛季 KD" },
  { key: "opponent_damage_p50", label: "对手当场伤害" },
  { key: "team_damage_taken_per_match", label: "你们场均承伤" },
  { key: "bot_rate", label: "大厅人机占比" },
];

type TeamIntensityTrendChartProps = {
  mode: TrendViewMode;
  onModeChange: (mode: TrendViewMode) => void;
  trend: TeamDayTrendPoint[];
  selectedDates: string[];
  dayColors: Record<string, string>;
  onToggleDate: (date: string) => void;
};

const CHART_HEIGHT = 272;
const PAD_TOP = 18;
const PAD_RIGHT = 24;
const PAD_BOTTOM = 42;
const PAD_LEFT = 48;

export function TeamIntensityTrendChart({
  mode,
  onModeChange,
  trend,
  selectedDates,
  dayColors,
  onToggleDate,
}: TeamIntensityTrendChartProps) {
  const [visibleSeries, setVisibleSeries] = useState<Record<OverviewSeriesKey, boolean>>({
    kd_p50: true,
    opponent_damage_p50: true,
    team_damage_taken_per_match: true,
    human_rate: true,
  });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(820);
  const gradientId = useId().replace(/:/g, "");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const next = Math.max(320, Math.floor(el.getBoundingClientRect().width));
      setContainerWidth((prev) => (Math.abs(prev - next) >= 2 ? next : prev));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selectedSet = useMemo(() => new Set(selectedDates), [selectedDates]);
  const allTrendDates = useMemo(() => trend.map((row) => row.date), [trend]);

  const plotWidth = Math.max(120, containerWidth - PAD_LEFT - PAD_RIGHT);
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const toX = useMemo(() => {
    return (index: number) => {
      if (trend.length <= 1) return PAD_LEFT + plotWidth / 2;
      return PAD_LEFT + (index / (trend.length - 1)) * plotWidth;
    };
  }, [trend.length, plotWidth]);

  // X-axis label thinning with priority for selected dates & endpoints.
  const xLabelSet = useMemo(() => {
    const maxLabels = Math.max(2, Math.floor(plotWidth / 72));
    const step = trend.length <= maxLabels ? 1 : Math.ceil((trend.length - 1) / (maxLabels - 1));
    const candidates = new Set<number>();
    trend.forEach((row, idx) => {
      if (idx === 0 || idx === trend.length - 1 || idx % step === 0 || selectedSet.has(row.date)) {
        candidates.add(idx);
      }
    });

    const sorted = [...candidates].sort((a, b) => a - b);
    const kept: number[] = [];
    for (const idx of sorted) {
      const prev = kept[kept.length - 1];
      if (prev === undefined) {
        kept.push(idx);
        continue;
      }
      const dist = toX(idx) - toX(prev);
      if (dist >= 44) {
        kept.push(idx);
      } else if (selectedSet.has(trend[idx].date) && !selectedSet.has(trend[prev].date)) {
        kept[kept.length - 1] = idx;
      }
    }
    return new Set(kept);
  }, [trend, plotWidth, selectedSet, toX]);

  // Overview multi-series normalized calculation (12%–88% vertical band, constant -> 50%).
  const overviewData = useMemo(() => {
    const baselineY = PAD_TOP + plotHeight;
    const toNormY = (ratio: number) => PAD_TOP + plotHeight * (1 - ratio);

    const seriesList = OVERVIEW_SERIES.map((cfg) => {
      const rawValues = trend.map((row) => {
        const v = cfg.getValue(row);
        return v !== null && Number.isFinite(v) ? v : null;
      });
      const valid = rawValues.filter((v): v is number => v !== null);
      const min = valid.length > 0 ? Math.min(...valid) : 0;
      const max = valid.length > 0 ? Math.max(...valid) : 0;
      const span = max - min;

      const points = trend.map((row, index) => {
        const val = rawValues[index];
        const isMissing = val === null;
        let normRatio = 0.5;
        if (!isMissing) {
          normRatio = span < 1e-9 ? 0.5 : 0.12 + ((val - min) / span) * 0.76;
        }
        return {
          index,
          row,
          value: val,
          x: toX(index),
          y: isMissing ? baselineY - 7 : toNormY(normRatio),
          isMissing,
        };
      });

      const segments: Array<typeof points> = [];
      let current: typeof points = [];
      for (const pt of points) {
        if (!pt.isMissing) {
          current.push(pt);
        } else if (current.length > 0) {
          segments.push(current);
          current = [];
        }
      }
      if (current.length > 0) segments.push(current);

      return {
        cfg,
        points,
        segments,
        hasMissing: points.some((p) => p.isMissing),
      };
    });

    const ticks = [
      { label: "偏低", y: toNormY(0.12) },
      { label: "中位", y: toNormY(0.5) },
      { label: "偏高", y: toNormY(0.88) },
    ];

    const anyVisible = OVERVIEW_SERIES.some((s) => visibleSeries[s.key]);
    const hasMissing = seriesList.some((s) => visibleSeries[s.cfg.key] && s.hasMissing);

    return { seriesList, ticks, baselineY, anyVisible, hasMissing };
  }, [trend, plotHeight, toX, visibleSeries]);

  // Single-metric real-value calculation.
  const singleData = useMemo(() => {
    if (mode === "overview") return null;
    const metric = SINGLE_METRICS[mode];
    const values = trend.map((row) => row[metric.key]);
    const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));

    let yMin = 0;
    let yMax = 1;
    if (valid.length > 0) {
      const rawMin = Math.min(...valid);
      const rawMax = Math.max(...valid);
      if (metric.isPercent) {
        yMin = 0;
        yMax = rawMax <= 0 ? 0.5 : Math.min(1, Math.max(0.1, rawMax * 1.18));
      } else {
        yMin = 0;
        if (rawMax <= 0) {
          yMax = metric.key === "kd_p50" ? 2 : 200;
        } else {
          yMax = rawMax * 1.18;
        }
        if (rawMin < 0) yMin = rawMin * 1.15;
      }
    } else if (metric.key === "kd_p50") {
      yMax = 3;
    } else if (!metric.isPercent) {
      yMax = 400;
    }

    const span = yMax - yMin || 1;
    const toY = (value: number) => {
      const ratio = (value - yMin) / span;
      const clamped = Math.max(0, Math.min(1, ratio));
      return PAD_TOP + plotHeight - clamped * plotHeight;
    };

    const points = trend.map((row, index) => {
      const value = row[metric.key];
      const hasValue = value !== null && Number.isFinite(value);
      return {
        index,
        row,
        value: hasValue ? value : null,
        x: toX(index),
        y: hasValue ? toY(value) : PAD_TOP + plotHeight - 7,
        isMissing: !hasValue,
      };
    });

    const segments: Array<typeof points> = [];
    let current: typeof points = [];
    for (const pt of points) {
      if (!pt.isMissing) {
        current.push(pt);
      } else if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);

    const ticks = [0, 1, 2, 3].map((step) => {
      const val = yMin + (span * step) / 3;
      return { value: val, y: toY(val) };
    });

    return {
      metric,
      points,
      segments,
      ticks,
      hasAnyValid: valid.length > 0,
      hasMissing: points.some((p) => p.isMissing),
    };
  }, [mode, trend, plotHeight, toX]);

  const toggleOverviewSeries = (key: OverviewSeriesKey) => {
    setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const activeRow =
    activeIndex !== null && activeIndex >= 0 && activeIndex < trend.length
      ? trend[activeIndex]
      : null;
  const activeX = activeIndex !== null ? toX(activeIndex) : 0;

  const tooltipWidth = mode === "overview" ? 276 : 236;
  const tooltipLeft = activeRow
    ? Math.max(
        10,
        Math.min(
          containerWidth - tooltipWidth - 8,
          activeX > containerWidth * 0.56 ? activeX - tooltipWidth - 14 : activeX + 16,
        ),
      )
    : 0;
  const tooltipTop = 10;

  const hasMissingIndicator =
    mode === "overview" ? overviewData.hasMissing : Boolean(singleData?.hasMissing);

  const getClickHint = (date: string) => {
    const isSelected = selectedSet.has(date);
    if (isSelected) {
      return selectedDates.length > 1 ? "点击移出下方对比" : "当前仅剩 1 天（至少保留 1 天）";
    }
    if (selectedDates.length >= MAX_COMPARE_DAYS) {
      return `已选满 ${MAX_COMPARE_DAYS} 天，取消某天后可加入`;
    }
    return "点击加入下方对比";
  };

  const hitWidth =
    trend.length <= 1 ? Math.min(84, plotWidth) : Math.max(18, Math.min(52, plotWidth / trend.length));

  return (
    <div className="space-y-3">
      {/* Top mode switcher row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="team-pill-group" role="group" aria-label="趋势图维度切换">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className="team-pill-btn"
              aria-pressed={mode === opt.key}
              onClick={() => onModeChange(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-secondary">
          <span>共 {trend.length} 个开黑日</span>
          <span>· 点击节点切换下方对比</span>
          {hasMissingIndicator && (
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full border border-dashed border-sky-400"
                aria-hidden="true"
              />
              空心圆待补齐
            </span>
          )}
        </div>
      </div>

      {/* Interactive series legend (overview mode) */}
      {mode === "overview" && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="开关走势折线">
            {OVERVIEW_SERIES.map((series) => {
              const active = visibleSeries[series.key];
              return (
                <button
                  key={series.key}
                  type="button"
                  className="team-series-toggle"
                  aria-pressed={active}
                  onClick={() => toggleOverviewSeries(series.key)}
                >
                  <span
                    className="inline-block h-[2.5px] w-3.5 rounded-full"
                    style={{ backgroundColor: series.color }}
                    aria-hidden="true"
                  />
                  <span>{series.label}</span>
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-secondary">
            各维度按自身区间对齐，悬停看真实数值
          </span>
        </div>
      )}

      {/* Chart viewport */}
      {trend.length === 0 ? (
        <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-border text-xs text-secondary">
          暂无按日汇总的历史趋势数据
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative w-full select-none"
          onMouseLeave={() => setActiveIndex(null)}
        >
          <svg
            width={containerWidth}
            height={CHART_HEIGHT}
            viewBox={`0 0 ${containerWidth} ${CHART_HEIGHT}`}
            className="block w-full overflow-visible"
            role="img"
            aria-label={
              mode === "overview"
                ? "多日整体强度趋势总览图，点击任意日期节点可加入或移出多日对比"
                : `多日${SINGLE_METRICS[mode].label}趋势图，点击任意日期节点可加入或移出多日对比`
            }
          >
            {singleData && (
              <defs>
                <linearGradient id={`area-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={singleData.metric.color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={singleData.metric.color} stopOpacity="0.01" />
                </linearGradient>
              </defs>
            )}

            {/* Horizontal grid lines & Y axis labels */}
            {mode === "overview" ? (
              <>
                <line
                  x1={PAD_LEFT}
                  y1={overviewData.baselineY}
                  x2={PAD_LEFT + plotWidth}
                  y2={overviewData.baselineY}
                  stroke="rgba(255,255,255,0.1)"
                />
                {overviewData.ticks.map((tick) => (
                  <g key={tick.label}>
                    <line
                      x1={PAD_LEFT}
                      y1={tick.y}
                      x2={PAD_LEFT + plotWidth}
                      y2={tick.y}
                      stroke="rgba(255,255,255,0.08)"
                      strokeDasharray="3 4"
                    />
                    <text
                      x={PAD_LEFT - 10}
                      y={tick.y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fill="rgba(166,179,187,0.8)"
                    >
                      {tick.label}
                    </text>
                  </g>
                ))}
              </>
            ) : (
              singleData?.ticks.map((tick, idx) => (
                <g key={idx}>
                  <line
                    x1={PAD_LEFT}
                    y1={tick.y}
                    x2={PAD_LEFT + plotWidth}
                    y2={tick.y}
                    stroke="rgba(255,255,255,0.08)"
                    strokeDasharray={idx === 0 ? undefined : "3 4"}
                  />
                  <text
                    x={PAD_LEFT - 10}
                    y={tick.y + 4}
                    textAnchor="end"
                    fontSize="11"
                    fill="rgba(166,179,187,0.82)"
                  >
                    {singleData.hasAnyValid ? singleData.metric.formatAxis(tick.value) : "—"}
                  </text>
                </g>
              ))
            )}

            {/* Vertical guide lines for selected dates */}
            {trend.map((row, idx) => {
              const color = dayColors[row.date];
              const isHovered = activeIndex === idx;
              if (!color && !isHovered) return null;
              const x = toX(idx);
              return (
                <line
                  key={`guide-${row.date}`}
                  x1={x}
                  y1={PAD_TOP}
                  x2={x}
                  y2={PAD_TOP + plotHeight}
                  stroke={color ?? "rgba(255,255,255,0.22)"}
                  strokeOpacity={color ? (isHovered ? 0.65 : 0.34) : 0.28}
                  strokeWidth={isHovered ? 1.5 : 1.15}
                  strokeDasharray="3 3"
                  pointerEvents="none"
                />
              );
            })}

            {/* OVERVIEW MODE: 4 normalized series lines & dots */}
            {mode === "overview" &&
              overviewData.seriesList.map((series) => {
                if (!visibleSeries[series.cfg.key]) return null;
                return (
                  <g key={series.cfg.key} pointerEvents="none">
                    {series.segments.map((seg, sIdx) => {
                      if (seg.length < 2) return null;
                      const d = seg
                        .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                        .join(" ");
                      return (
                        <path
                          key={sIdx}
                          d={d}
                          fill="none"
                          stroke={series.cfg.color}
                          strokeWidth="2.1"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeOpacity="0.92"
                        />
                      );
                    })}

                    {series.points.map((pt) => {
                      const isHovered = activeIndex === pt.index;
                      const isSelected = selectedSet.has(pt.row.date);
                      if (pt.isMissing) {
                        return (
                          <circle
                            key={`${series.cfg.key}-miss-${pt.row.date}`}
                            cx={pt.x}
                            cy={pt.y}
                            r={isHovered ? 4.8 : 3.8}
                            fill="var(--color-background-card, #181c22)"
                            stroke={series.cfg.color}
                            strokeWidth="1.6"
                            strokeDasharray="2 1.5"
                            strokeOpacity={isHovered ? 0.95 : 0.72}
                          />
                        );
                      }
                      return (
                        <circle
                          key={`${series.cfg.key}-pt-${pt.row.date}`}
                          cx={pt.x}
                          cy={pt.y}
                          r={isHovered ? 5 : isSelected ? 3.8 : 2.9}
                          fill={series.cfg.color}
                          stroke="var(--color-background-card, #181c22)"
                          strokeWidth={isHovered ? 2 : 1.5}
                        />
                      );
                    })}
                  </g>
                );
              })}

            {/* SINGLE METRIC MODE: area + line + colored selected nodes */}
            {mode !== "overview" && singleData && (
              <g pointerEvents="none">
                {singleData.segments.map((seg, sIdx) => {
                  if (seg.length < 2) return null;
                  const linePath = seg
                    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
                    .join(" ");
                  const baselineY = PAD_TOP + plotHeight;
                  const areaPath = `${linePath} L ${seg[seg.length - 1].x.toFixed(
                    1,
                  )} ${baselineY.toFixed(1)} L ${seg[0].x.toFixed(1)} ${baselineY.toFixed(1)} Z`;
                  return (
                    <g key={sIdx}>
                      <path d={areaPath} fill={`url(#area-${gradientId})`} />
                      <path
                        d={linePath}
                        fill="none"
                        stroke={singleData.metric.color}
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  );
                })}

                {singleData.points.map((pt) => {
                  const isHovered = activeIndex === pt.index;
                  const dayColor = dayColors[pt.row.date];
                  const accent = dayColor ?? singleData.metric.color;
                  return (
                    <g key={`single-pt-${pt.row.date}`}>
                      {(dayColor || isHovered) && (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={dayColor ? 9 : 7.5}
                          fill={accent}
                          fillOpacity="0.22"
                        />
                      )}
                      {pt.isMissing ? (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={dayColor ? 5.2 : 4.2}
                          fill="var(--color-background-card, #181c22)"
                          stroke={dayColor ?? "rgba(166,179,187,0.75)"}
                          strokeWidth="1.9"
                          strokeDasharray="2 1.5"
                        />
                      ) : (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={dayColor ? 5.2 : isHovered ? 4.8 : 3.5}
                          fill={accent}
                          stroke="var(--color-background-card, #181c22)"
                          strokeWidth="2"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            )}

            {/* Interactive date columns + X-axis date labels + selected day color dots */}
            {trend.map((row, idx) => {
              const x = toX(idx);
              const dayColor = dayColors[row.date];
              const isSelected = Boolean(dayColor);
              const showLabel = xLabelSet.has(idx);

              return (
                <g
                  key={`col-${row.date}`}
                  className="team-trend-node"
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`${row.date}，${row.match_count} 局，${getClickHint(row.date)}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onFocus={() => setActiveIndex(idx)}
                  onBlur={() => setActiveIndex((prev) => (prev === idx ? null : prev))}
                  onClick={() => onToggleDate(row.date)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onToggleDate(row.date);
                    }
                  }}
                >
                  <rect
                    x={x - hitWidth / 2}
                    y={PAD_TOP}
                    width={hitWidth}
                    height={plotHeight + PAD_BOTTOM - 4}
                    fill="transparent"
                  />

                  <rect
                    className="team-trend-focus-ring"
                    x={x - 16}
                    y={PAD_TOP}
                    width={32}
                    height={plotHeight}
                    rx={6}
                    fill="none"
                    stroke="#7dd3fc"
                    strokeWidth="1.5"
                    opacity="0"
                  />

                  {showLabel && (
                    <text
                      x={x}
                      y={CHART_HEIGHT - 20}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight={isSelected ? "600" : "400"}
                      fill={isSelected ? "#f1f5f9" : "rgba(166,179,187,0.8)"}
                    >
                      {formatShortDate(row.date)}
                    </text>
                  )}

                  {isSelected && (
                    <circle
                      cx={x}
                      cy={CHART_HEIGHT - 9}
                      r={3.4}
                      fill={dayColor}
                      stroke="var(--color-background-card, #181c22)"
                      strokeWidth="1"
                    />
                  )}
                </g>
              );
            })}
          </svg>

          {mode === "overview" && !overviewData.anyVisible && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-secondary">
              点击上方图例开启至少一条走势线
            </div>
          )}

          {/* Hover / focus tooltip */}
          {activeRow && (
            <div
              className="team-trend-tooltip"
              style={{ left: `${tooltipLeft}px`, top: `${tooltipTop}px` }}
            >
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-primary">
                <span className="inline-flex items-center gap-1.5">
                  {dayColors[activeRow.date] && (
                    <span
                      className="team-day-dot"
                      style={{ backgroundColor: dayColors[activeRow.date] }}
                      aria-hidden="true"
                    />
                  )}
                  <span>{formatMultiDayLabel(activeRow.date, allTrendDates)}</span>
                  <span className="font-normal text-secondary">({activeRow.match_count}局)</span>
                </span>
                {dayColors[activeRow.date] && (
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${dayColors[activeRow.date]}26`,
                      color: dayColors[activeRow.date],
                    }}
                  >
                    已选对比
                  </span>
                )}
              </div>

              {mode === "overview" ? (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-secondary">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: "#38bdf8" }}
                      />
                      对手赛季 KD
                    </span>
                    <span className="font-semibold text-primary">
                      {activeRow.kd_p50 !== null ? formatDecimal(activeRow.kd_p50, 2) : "待补齐"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-secondary">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: "#fbbf24" }}
                      />
                      对手当场伤害
                    </span>
                    <span className="font-semibold text-primary">
                      {formatInt(activeRow.opponent_damage_p50)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-secondary">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: "#fb7185" }}
                      />
                      你们场均承伤
                    </span>
                    <span className="font-semibold text-primary">
                      {formatInt(activeRow.team_damage_taken_per_match)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1.5 text-secondary">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: "#34d399" }}
                      />
                      大厅人机占比
                    </span>
                    <span className="font-semibold text-primary">
                      {formatPercent(activeRow.bot_rate, 1)}
                      {activeRow.bot_rate !== null && (
                        <span className="ml-1 font-normal text-secondary">
                          (真人 {formatPercent(Math.max(0, 1 - activeRow.bot_rate), 1)})
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              ) : (
                singleData && (
                  <div className="mt-1.5 space-y-0.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[11px] text-secondary">{singleData.metric.label}</span>
                      <span className="text-sm font-bold text-primary">
                        {activeRow[singleData.metric.key] !== null
                          ? singleData.metric.format(activeRow[singleData.metric.key])
                          : "待补齐"}
                      </span>
                    </div>
                    {singleData.metric.key === "kd_p50" && (
                      <div className="text-[11px] text-secondary">
                        已知战绩 {activeRow.kd_known} / {activeRow.kd_total} 人次
                      </div>
                    )}
                  </div>
                )
              )}

              <div className="mt-2 space-y-0.5 border-t border-white/10 pt-1.5 text-[11px] text-secondary">
                <div>
                  交手 {activeRow.contacts_count} 人次（{activeRow.unique_opponents} 人）
                </div>
                <div className="truncate">地图：{formatMapsSummary(activeRow.maps, 2)}</div>
                <div className="pt-0.5 text-[10px] text-sky-300/90">
                  {getClickHint(activeRow.date)}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
