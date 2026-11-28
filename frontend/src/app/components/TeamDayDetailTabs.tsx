import { useMemo, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { BarChart3, Search, Swords, Users, X } from "lucide-react";
import type {
  TeamDayOpponentDetail,
  TeamDayPayload,
  TeamDayPerformanceMember,
} from "../api";
import { mapDisplayName } from "../matchDisplay";
import {
  DAY_PALETTE,
  MEMBER_SERIES,
  formatBeijingClock,
  formatDecimal,
  formatInt,
  formatMapsSummary,
  formatModeLabel,
  formatMultiDayLabel,
  formatObservedDate,
  formatObservedRange,
  formatPercent,
  formatPlayerName,
  formatTimeWindow,
} from "./teamIntensityFormat";

type DetailTabKey = "distribution" | "opponents" | "team";
type OpponentSortKey = "kd" | "encounters" | "match_damage_avg";

type TeamDayDetailTabsProps = {
  days: TeamDayPayload[];
  dayColors: Record<string, string>;
};

const STATUS_META: Record<
  TeamDayOpponentDetail["profile_status"],
  { label: string; className: string }
> = {
  known: { label: "已知", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  partial: { label: "部分已知", className: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  missing: { label: "待补齐", className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  unfillable: { label: "缺赛季", className: "bg-white/10 text-secondary border-white/15" },
};

const KD_BAND_LABELS = ["<1", "1–2", "2–3", "≥3"] as const;

function colorForDay(date: string, dayColors: Record<string, string>, index: number): string {
  return dayColors[date] ?? DAY_PALETTE[index % DAY_PALETTE.length];
}

function formatHighSkill(day: TeamDayPayload): string {
  const { kd_ge_2_rate, kd_ge_2_count, kd_ge_3_rate, kd_ge_3_count } = day.profiles;
  if (kd_ge_2_rate === null && kd_ge_3_rate === null) return "—";
  return `${formatPercent(kd_ge_2_rate, 0)} (${kd_ge_2_count}) / ${formatPercent(kd_ge_3_rate, 0)} (${kd_ge_3_count})`;
}

function formatHighFirepower(day: TeamDayPayload): string {
  const { high_firepower_teams, high_firepower_team_total, high_firepower_team_rate } = day.pressure;
  if (high_firepower_team_rate === null) return "—";
  return `${formatPercent(high_firepower_team_rate, 0)} (${high_firepower_teams}/${high_firepower_team_total} 队)`;
}

function formatKillDeathRatio(day: TeamDayPayload): string {
  const { team_kills_vs_humans: k, team_deaths_to_humans: d } = day.pressure;
  const ratio = d > 0 ? ` (${(k / d).toFixed(2)})` : "";
  return `${k} ∶ ${d}${ratio}`;
}

function formatObservedCompact(day: TeamDayPayload, label: string): string {
  const { known_kd, total_contacts, observed_min_at, observed_max_at, unfillable_count } =
    day.profiles;
  const obs = formatObservedRange(observed_min_at, observed_max_at);
  const parts = [`${label} ${known_kd}/${total_contacts}`];
  if (obs) parts.push(obs);
  if (unfillable_count > 0) parts.push(`${unfillable_count} 缺赛季`);
  return parts.join(" · ");
}

function MultiDayKdHistogram({
  days,
  dayColors,
  allDates,
}: {
  days: TeamDayPayload[];
  dayColors: Record<string, string>;
  allDates: string[];
}) {
  const [asPercent, setAsPercent] = useState(true);
  const dense = days.length >= 4;

  const dayBandMaps = useMemo(
    () =>
      days.map((day) => ({
        date: day.summary.date,
        label: formatMultiDayLabel(day.summary.date, allDates),
        known: day.profiles.known_kd,
        counts: new Map(day.profiles.kd_bands.map((b) => [b.label, b.count])),
      })),
    [days, allDates],
  );

  const bands = useMemo(() => {
    return KD_BAND_LABELS.map((bandLabel) => {
      const bars = dayBandMaps.map((d, idx) => {
        const count = d.counts.get(bandLabel) ?? 0;
        const val = asPercent ? (d.known > 0 ? (count / d.known) * 100 : 0) : count;
        return {
          date: d.date,
          dayLabel: d.label,
          color: colorForDay(d.date, dayColors, idx),
          count,
          known: d.known,
          val,
        };
      });
      return { bandLabel, bars };
    });
  }, [dayBandMaps, dayColors, asPercent]);

  const maxVal = Math.max(1, ...bands.flatMap((b) => b.bars.map((bar) => bar.val)));
  const hasAny = days.some((d) => d.profiles.known_kd > 0);

  const formatBarValue = (count: number, known: number) => {
    if (known <= 0) return "—";
    return asPercent ? `${Math.round((count / known) * 100)}%` : String(count);
  };

  return (
    <div className="flex h-full flex-col justify-between rounded-lg border border-white/[0.08] bg-white/[0.02] p-3.5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs font-semibold text-primary">对手赛季 KD 四档分布</span>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-secondary">
              {days.map((day, idx) => {
                const color = colorForDay(day.summary.date, dayColors, idx);
                return (
                  <span
                    key={day.summary.date}
                    className="inline-flex items-center gap-1.5 font-medium text-primary/90"
                  >
                    <span
                      className="team-day-dot"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    {formatMultiDayLabel(day.summary.date, allDates)}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="team-pill-group" role="group" aria-label="KD 分布显示单位">
            <button
              type="button"
              className="team-pill-btn !min-h-6 !px-2 !text-[11px]"
              aria-pressed={asPercent}
              onClick={() => setAsPercent(true)}
            >
              占比
            </button>
            <button
              type="button"
              className="team-pill-btn !min-h-6 !px-2 !text-[11px]"
              aria-pressed={!asPercent}
              onClick={() => setAsPercent(false)}
            >
              人次
            </button>
          </div>
        </div>

        {!hasAny ? (
          <div className="py-10 text-center text-xs text-secondary">
            所选日期暂无已知赛季 KD 的交手样本
          </div>
        ) : (
          <div className="team-multi-hist" role="img" aria-label="多日对手赛季 KD 四档分布柱状图">
            {bands.map((band) => (
              <div key={band.bandLabel} className="team-multi-hist-col">
                <div
                  className={`team-multi-hist-track ${dense ? "team-multi-hist-track--dense" : ""}`}
                >
                  {band.bars.map((bar) => {
                    const heightPct = bar.known > 0 ? (bar.val / maxVal) * 100 : 0;
                    const pctText =
                      bar.known > 0 ? `${((bar.count / bar.known) * 100).toFixed(1)}%` : "暂无";
                    return (
                      <div
                        key={bar.date}
                        className={`team-multi-hist-bar ${
                          days.length === 1 ? "team-multi-hist-bar--single" : ""
                        }`}
                        style={{
                          height: `${bar.count > 0 ? Math.max(5, heightPct) : 0}%`,
                          background: `linear-gradient(180deg, ${bar.color}ee 0%, ${bar.color}bb 100%)`,
                        }}
                        title={`${bar.date} · KD ${band.bandLabel}：${bar.count} 人次 (${pctText})`}
                      >
                        {(bar.count > 0 || days.length <= 3) && (
                          <strong>{formatBarValue(bar.count, bar.known)}</strong>
                        )}
                      </div>
                    );
                  })}
                </div>
                <span className="team-multi-hist-label">KD {band.bandLabel}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Compact single-row coverage & query dates summary */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.06] pt-2.5 text-[11px] leading-relaxed text-secondary">
        <span className="text-secondary/80">已知覆盖：</span>
        {days.map((day, idx) => {
          const color = colorForDay(day.summary.date, dayColors, idx);
          const label = formatMultiDayLabel(day.summary.date, allDates);
          return (
            <span key={day.summary.date} className="inline-flex items-center gap-1.5">
              <span
                className="team-day-dot"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span>{formatObservedCompact(day, label)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function MultiDaySwitcher({
  days,
  dayColors,
  allDates,
  selectedDate,
  onSelectDate,
  badgeForDay,
}: {
  days: TeamDayPayload[];
  dayColors: Record<string, string>;
  allDates: string[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  badgeForDay: (day: TeamDayPayload) => number;
}) {
  if (days.length === 1) {
    const only = days[0];
    const color = colorForDay(only.summary.date, dayColors, 0);
    return (
      <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
        <span className="team-day-dot" style={{ backgroundColor: color }} aria-hidden="true" />
        <span>{only.summary.date}</span>
        <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-normal text-secondary">
          {badgeForDay(only)}
        </span>
      </div>
    );
  }

  return (
    <div className="team-pill-group" role="group" aria-label="选择查看日期">
      {days.map((day, idx) => {
        const color = colorForDay(day.summary.date, dayColors, idx);
        const active = day.summary.date === selectedDate;
        return (
          <button
            key={day.summary.date}
            type="button"
            className="team-pill-btn"
            aria-pressed={active}
            onClick={() => onSelectDate(day.summary.date)}
          >
            <span className="team-day-dot" style={{ backgroundColor: color }} aria-hidden="true" />
            <span>{formatMultiDayLabel(day.summary.date, allDates)}</span>
            <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-normal text-secondary">
              {badgeForDay(day)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MemberOutputBars({ members }: { members: TeamDayPerformanceMember[] }) {
  const maxDamage = Math.max(1, ...members.map((m) => m.damage ?? 0));
  const maxKills = Math.max(1, ...members.map((m) => m.kills));

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" role="img" aria-label="本队成员输出对比">
      {members.map((member, index) => {
        const color = MEMBER_SERIES[index % MEMBER_SERIES.length];
        const dmg = member.damage;
        const damageWidth =
          dmg !== null && dmg > 0 ? `${Math.max(3, (dmg / maxDamage) * 100)}%` : "0%";
        const killsWidth =
          member.kills > 0 ? `${Math.max(3, (member.kills / maxKills) * 100)}%` : "0%";
        const avgDmg =
          dmg !== null && member.match_count > 0 ? Math.round(dmg / member.match_count) : null;

        return (
          <div
            key={member.player_id}
            className="space-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="truncate font-semibold text-primary">
                  {formatPlayerName(member)}
                </span>
                <span className="text-[11px] text-secondary">
                  {member.match_count} 局 · 均 #{formatDecimal(member.avg_rank, 1)}
                </span>
              </div>
              <span className="shrink-0 text-[11px] text-secondary">
                总伤 {formatInt(dmg)}
                {avgDmg !== null ? ` (均 ${avgDmg})` : ""} · {member.kills} 杀 · {member.knocks} 倒
              </span>
            </div>
            <div className="space-y-1" aria-hidden="true">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: damageWidth, backgroundColor: color }}
                />
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full opacity-70 transition-all"
                  style={{ width: killsWidth, backgroundColor: color }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TeamDayDetailTabs({ days, dayColors }: TeamDayDetailTabsProps) {
  const [activeTab, setActiveTab] = useState<DetailTabKey>("distribution");
  const [selectedDetailDate, setSelectedDetailDate] = useState<string>(
    () => days[0]?.summary.date ?? "",
  );
  const [sortBy, setSortBy] = useState<OpponentSortKey>("kd");
  const [searchQuery, setSearchQuery] = useState("");

  const allDates = useMemo(() => days.map((d) => d.summary.date), [days]);

  const activeDay = useMemo(() => {
    const matched = days.find((d) => d.summary.date === selectedDetailDate);
    return matched ?? days[0] ?? null;
  }, [days, selectedDetailDate]);

  const filteredOpponents = useMemo(() => {
    if (!activeDay) return [];
    const q = searchQuery.trim().toLowerCase();
    const list = q
      ? activeDay.opponents_detail.filter(
          (opp) =>
            opp.player_name.toLowerCase().includes(q) || opp.player_id.toLowerCase().includes(q),
        )
      : [...activeDay.opponents_detail];

    list.sort((a, b) => {
      if (sortBy === "kd") {
        const av = a.kd ?? -1;
        const bv = b.kd ?? -1;
        if (bv !== av) return bv - av;
        if (b.encounters !== a.encounters) return b.encounters - a.encounters;
        return (b.match_damage_avg ?? -1) - (a.match_damage_avg ?? -1);
      }
      if (sortBy === "match_damage_avg") {
        const av = a.match_damage_avg ?? -1;
        const bv = b.match_damage_avg ?? -1;
        if (bv !== av) return bv - av;
        return b.encounters - a.encounters;
      }
      if (b.encounters !== a.encounters) return b.encounters - a.encounters;
      return (b.kd ?? -1) - (a.kd ?? -1);
    });

    return list;
  }, [activeDay, searchQuery, sortBy]);

  const compareRows = useMemo(
    () => [
      {
        label: "对手赛季 KD（中位数）",
        render: (day: TeamDayPayload) => formatDecimal(day.profiles.kd_p50, 2),
      },
      {
        label: "高手占比（KD ≥2 / ≥3）",
        render: (day: TeamDayPayload) => formatHighSkill(day),
      },
      {
        label: "对手赛季均伤（中位数 / P75）",
        render: (day: TeamDayPayload) =>
          `${formatInt(day.profiles.adr_p50)} / ${formatInt(day.profiles.adr_p75)}`,
      },
      {
        label: "对手当场伤害（中位数 / P75）",
        render: (day: TeamDayPayload) =>
          `${formatInt(day.pressure.opponent_damage_p50)} / ${formatInt(
            day.pressure.opponent_damage_p75,
          )}`,
      },
      {
        label: "高火力敌队占比",
        render: (day: TeamDayPayload) => formatHighFirepower(day),
      },
      {
        label: "你们场均承伤",
        render: (day: TeamDayPayload) => formatInt(day.pressure.team_damage_taken_per_match),
      },
      {
        label: "正面淘汰 ∶ 被淘汰",
        render: (day: TeamDayPayload) => formatKillDeathRatio(day),
      },
      {
        label: "大厅人机占比",
        render: (day: TeamDayPayload) => formatPercent(day.lobby.bot_rate, 1),
      },
      {
        label: "全厅伤害中位数 / P75",
        render: (day: TeamDayPayload) =>
          `${formatInt(day.lobby.lobby_damage_p50)} / ${formatInt(day.lobby.lobby_damage_p75)}`,
      },
      {
        label: "主要地图",
        render: (day: TeamDayPayload) => formatMapsSummary(day.summary.maps, 2),
      },
      {
        label: "开局时段（北京时间）",
        render: (day: TeamDayPayload) =>
          formatTimeWindow(day.summary.first_match_at, day.summary.last_match_at),
      },
    ],
    [],
  );

  if (!activeDay) return null;

  const sideBySide = days.length <= 2;

  return (
    <Card padding={0} className="border-border bg-card shadow-sm">
      {/* Clean 3-Tab header */}
      <div className="team-tab-bar" role="tablist" aria-label="团队对局详细拆解">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "distribution"}
          className="team-tab-btn"
          onClick={() => setActiveTab("distribution")}
        >
          <BarChart3 className="size-3.5 text-sky-400" />
          实力分布与多日对照
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "opponents"}
          className="team-tab-btn"
          onClick={() => setActiveTab("opponents")}
        >
          <Swords className="size-3.5 text-amber-400" />
          交手对手
          <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] font-normal text-secondary">
            {activeDay.opponents_detail.length}
          </span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "team"}
          className="team-tab-btn"
          onClick={() => setActiveTab("team")}
        >
          <Users className="size-3.5 text-emerald-400" />
          本队表现与对局
          <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] font-normal text-secondary">
            {activeDay.team_performance.matches.length}
          </span>
        </button>
      </div>

      {/* Tab content */}
      <div className="p-4">
        {activeTab === "distribution" && (
          <div className={sideBySide ? "grid grid-cols-1 gap-4 lg:grid-cols-12" : "space-y-4"}>
            <div className={sideBySide ? "lg:col-span-5" : ""}>
              <MultiDayKdHistogram days={days} dayColors={dayColors} allDates={allDates} />
            </div>

            <div
              className={`overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.02] p-3 ${
                sideBySide ? "lg:col-span-7" : ""
              }`}
            >
              <table className="w-full min-w-[460px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-secondary">
                    <th className="team-compare-sticky pb-2 pr-4 text-left font-medium">
                      对比维度
                    </th>
                    {days.map((day, idx) => {
                      const color = colorForDay(day.summary.date, dayColors, idx);
                      return (
                        <th
                          key={day.summary.date}
                          className="pb-2 pl-4 text-right font-semibold whitespace-nowrap text-primary"
                        >
                          <span className="inline-flex items-center justify-end gap-1.5">
                            <span
                              className="team-day-dot"
                              style={{ backgroundColor: color }}
                              aria-hidden="true"
                            />
                            <span>{formatMultiDayLabel(day.summary.date, allDates)}</span>
                            <span className="font-normal text-secondary">
                              ({day.summary.match_count}局)
                            </span>
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {compareRows.map((row) => (
                    <tr
                      key={row.label}
                      className="border-b border-white/[0.06] last:border-b-0"
                    >
                      <td className="team-compare-sticky py-2 pr-4 whitespace-nowrap text-secondary">
                        {row.label}
                      </td>
                      {days.map((day) => (
                        <td
                          key={day.summary.date}
                          className="py-2 pl-4 text-right font-medium whitespace-nowrap text-primary"
                        >
                          {row.render(day)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "opponents" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <MultiDaySwitcher
                  days={days}
                  dayColors={dayColors}
                  allDates={allDates}
                  selectedDate={activeDay.summary.date}
                  onSelectDate={setSelectedDetailDate}
                  badgeForDay={(d) => d.opponents_detail.length}
                />
                <span className="text-xs text-secondary">
                  直接交手 {activeDay.opponents_detail.length} 名真人（
                  {activeDay.summary.contacts_count} 人次）
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-secondary" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索对手昵称…"
                    aria-label="搜索对手昵称"
                    className="team-search-input"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      aria-label="清除搜索"
                      onClick={() => setSearchQuery("")}
                      className="absolute top-1/2 right-2 -translate-y-1/2 text-secondary hover:text-primary"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>

                <div className="team-pill-group" role="group" aria-label="对手排序方式">
                  <button
                    type="button"
                    className="team-pill-btn !min-h-6 !px-2 !text-[11px]"
                    aria-pressed={sortBy === "kd"}
                    onClick={() => setSortBy("kd")}
                  >
                    赛季 KD
                  </button>
                  <button
                    type="button"
                    className="team-pill-btn !min-h-6 !px-2 !text-[11px]"
                    aria-pressed={sortBy === "encounters"}
                    onClick={() => setSortBy("encounters")}
                  >
                    交手次数
                  </button>
                  <button
                    type="button"
                    className="team-pill-btn !min-h-6 !px-2 !text-[11px]"
                    aria-pressed={sortBy === "match_damage_avg"}
                    onClick={() => setSortBy("match_damage_avg")}
                  >
                    当场均伤
                  </button>
                </div>
              </div>
            </div>

            {activeDay.opponents_detail.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-secondary">
                这一天没有记录到与敌方真人的直接交手。
              </div>
            ) : filteredOpponents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-secondary">
                没有匹配“{searchQuery.trim()}”的交手对手。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table density="compact">
                  <TableHeader>
                    <TableRow isHeaderRow>
                      <TableHeaderCell>玩家</TableHeaderCell>
                      <TableHeaderCell className="text-right">交手次数</TableHeaderCell>
                      <TableHeaderCell className="text-right">赛季 KD</TableHeaderCell>
                      <TableHeaderCell className="text-right">赛季均伤</TableHeaderCell>
                      <TableHeaderCell className="text-right">当场均伤</TableHeaderCell>
                      <TableHeaderCell className="text-right">当场淘汰</TableHeaderCell>
                      <TableHeaderCell>战绩状态</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOpponents.map((opp) => {
                      const status = STATUS_META[opp.profile_status];
                      const observed = formatObservedDate(opp.observed_at);
                      return (
                        <TableRow key={opp.player_id}>
                          <TableCell className="font-medium text-primary">
                            {formatPlayerName(opp)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {opp.encounters}
                          </TableCell>
                          <TableCell className="text-right font-semibold tabular-nums">
                            {formatDecimal(opp.kd, 2)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatInt(opp.adr)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatInt(opp.match_damage_avg)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {opp.match_kills_total}
                          </TableCell>
                          <TableCell>
                            <span
                              className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-medium ${status.className}`}
                              title={observed !== "—" ? `战绩查询日期：${observed}` : undefined}
                            >
                              {status.label}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {activeTab === "team" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MultiDaySwitcher
                days={days}
                dayColors={dayColors}
                allDates={allDates}
                selectedDate={activeDay.summary.date}
                onSelectDate={setSelectedDetailDate}
                badgeForDay={(d) => d.team_performance.matches.length}
              />
              <span className="text-xs text-secondary">
                {activeDay.summary.match_count} 局 · {activeDay.summary.wins} 鸡 ·{" "}
                {activeDay.summary.top3} 次前三
              </span>
            </div>

            {activeDay.team_performance.members.length > 0 && (
              <MemberOutputBars members={activeDay.team_performance.members} />
            )}

            <div className="overflow-x-auto">
              <Table density="compact">
                <TableHeader>
                  <TableRow isHeaderRow>
                    <TableHeaderCell>时间</TableHeaderCell>
                    <TableHeaderCell>地图</TableHeaderCell>
                    <TableHeaderCell>实际出战成员</TableHeaderCell>
                    <TableHeaderCell className="text-right">排名</TableHeaderCell>
                    <TableHeaderCell className="text-right">淘汰</TableHeaderCell>
                    <TableHeaderCell className="text-right">伤害</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeDay.team_performance.matches.map((match) => (
                    <TableRow key={match.match_id}>
                      <TableCell className="tabular-nums">
                        {formatBeijingClock(match.created_at)}
                      </TableCell>
                      <TableCell>
                        <span>{mapDisplayName(match.map_name)}</span>
                        <span className="ml-1.5 text-[11px] text-secondary">
                          {formatModeLabel(match.game_mode)}
                          {match.match_type === "competitive" || match.match_type === "ranked"
                            ? "·排位"
                            : ""}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[340px] truncate">
                        {match.players.map(formatPlayerName).join(" / ")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {match.team_rank !== null ? `#${match.team_rank}` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{match.kills}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatInt(match.damage)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
