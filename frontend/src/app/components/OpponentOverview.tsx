import { useMemo, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowDownLeft, ArrowUpRight, Crosshair, Search } from "lucide-react";
import { median, type MatchResult, type OpponentReport } from "../opponentAnalysis";
import {
  filterContacts,
  opponentGroups,
  reportContacts,
  type Contact,
  type DirectorySort,
  type OutcomeFilter,
} from "../opponentDirectory";
import { mapDisplayName } from "../matchDisplay";
import { MATCH_TIME_ZONE } from "../matchRange";
import type { Mastery } from "../api";
import "./opponentOverview.css";

type View = "people" | "match" | "log";

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: MATCH_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function matchTime(match: MatchResult) {
  const time = match.created_at ? Date.parse(match.created_at) : NaN;
  return Number.isFinite(time) ? timeFormat.format(time) : "日期未知";
}

function contextLabel(match: MatchResult) {
  const modes: Record<string, string> = { solo: "单排", duo: "双排", squad: "四排" };
  const mode = match.game_mode ?? "";
  const base = mode.replace(/-fpp$/, "");
  const queue =
    match.match_type === "competitive"
      ? "排位"
      : match.match_type === "official"
        ? "普通"
        : match.match_type;
  const season = match.encounters?.season;
  const seasonNumber = season?.match(/pc-2018-(\d+)$/)?.[1];
  return [
    queue,
    [modes[base] ?? base, mode.endsWith("-fpp") ? "FPP" : ""].filter(Boolean).join(" "),
    seasonNumber ? `S${seasonNumber}` : (season ?? "赛季未知"),
  ]
    .filter(Boolean)
    .join(" · ");
}

const kdBands = [
  { label: "< 1", color: "bg-teal-300" },
  { label: "1 – < 2", color: "bg-sky-300" },
  { label: "2 – < 3", color: "bg-amber-300" },
  { label: "≥ 3", color: "bg-rose-300" },
];

function StrengthSummary({ contacts }: { contacts: Contact[] }) {
  const human = contacts.filter((c) => c.person.kind === "human");
  const kds = (items: Contact[]) => items.flatMap((c) => (c.stats?.kd != null ? [c.stats.kd] : []));
  const values = kds(human);
  const counts = [0, 0, 0, 0];
  for (const value of values) counts[value < 1 ? 0 : value < 2 ? 1 : value < 3 ? 2 : 3]++;

  return (
    <div className="opp-strength">
      <section className="opp-median">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Crosshair size={16} aria-hidden />
          真人对手 KD 中位数
        </h2>
        <div className="mt-2 font-mono text-5xl font-semibold tracking-tight tabular-nums">
          {median(values)}
        </div>
        <p className="mt-2 text-xs text-secondary">
          有 KD 的交手样本：{values.length} / {human.length} 人次
        </p>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3">
          {(
            [
              ["我淘汰的对手", "out_kill", ArrowUpRight, "text-teal-300"],
              ["淘汰我的对手", "in_kill", ArrowDownLeft, "text-rose-300"],
            ] as const
          ).map(([label, action, Icon, color]) => {
            const group = human.filter((c) => c.person.actions.includes(action));
            const kd = kds(group);
            return (
              <div key={action}>
                <div className="flex items-center gap-1 text-xs text-secondary">
                  <Icon size={14} className={color} aria-hidden />
                  {label}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-2">
                  <strong className="font-mono text-lg">{median(kd)}</strong>
                  <span className="text-xs text-secondary">
                    {kd.length}/{group.length} 人次
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section aria-label="真人对手 KD 分布" className="opp-distribution">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">对手 KD 分布</h2>
          <span className="text-xs text-secondary">按已知 KD 的交手人次</span>
        </div>
        {kdBands.map((band, i) => (
          <div
            key={band.label}
            className="grid grid-cols-[4.5rem_1fr_4rem] items-center gap-3 py-1.5 text-xs"
          >
            <span className="font-mono tabular-nums">{band.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
              <div
                className={`h-full rounded-full ${band.color}`}
                style={{ width: `${values.length ? (counts[i] * 100) / values.length : 0}%` }}
              />
            </div>
            <span className="text-right tabular-nums text-secondary">{counts[i]} 人次</span>
          </div>
        ))}
      </section>
    </div>
  );
}

const actionLabels = [
  ["out_kill", "我淘汰对方"],
  ["in_kill", "对方淘汰我"],
  ["out_knock", "我击倒对方"],
  ["in_knock", "对方击倒我"],
  ["out_damage", "我造成伤害"],
  ["in_damage", "对方造成伤害"],
] as const;

function Outcomes({ contacts, detailed }: { contacts: Contact[]; detailed: boolean }) {
  const counts = new Map<string, number>();
  for (const { person } of contacts) {
    for (const action of person.actions) {
      // In the directory show the furthest outcome per direction in each match.
      // The match and chronological views retain every action recorded for the encounter.
      const direction = action.startsWith("out_") ? "out_" : "in_";
      if (!detailed && !action.endsWith("_kill") && person.actions.includes(direction + "kill"))
        continue;
      if (!detailed && action.endsWith("_damage") && person.actions.includes(direction + "knock"))
        continue;
      counts.set(action, (counts.get(action) ?? 0) + 1);
    }
  }
  return (
    <div className="opp-outcomes flex flex-wrap items-center gap-1.5">
      {actionLabels.map(([action, label]) => {
        const count = counts.get(action);
        if (!count) return null;
        const tone =
          action === "out_kill"
            ? "bg-teal-400/10 text-teal-300"
            : action === "in_kill"
              ? "bg-rose-400/10 text-rose-300"
              : "bg-muted text-secondary";
        return (
          <span key={action} className={`rounded px-2 py-1 text-xs ${tone}`}>
            {label}
            {count > 1 && ` · ${count} 局`}
          </span>
        );
      })}
    </div>
  );
}

function OpponentRow({
  contacts,
  view,
  mastery,
}: {
  contacts: Contact[];
  view: View;
  mastery?: Mastery;
}) {
  const { person, match, stats } = contacts[0];
  return (
    <li className="opp-row border-t border-border">
      <div className="opp-identity min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <strong className="break-all text-sm font-semibold" title={person.player_id}>
            {person.name}
          </strong>
          {person.kind !== "human" && (
            <span className="text-xs text-secondary">
              {person.kind === "bot" ? "机器人" : "身份未知"}
            </span>
          )}
          {view === "people" && contacts.length > 1 && (
            <span className="text-xs text-sky-300">相遇 {contacts.length} 局</span>
          )}
        </div>
        {view !== "match" && (
          <>
            <div className="mt-1 break-words text-xs text-secondary">
              {matchTime(match)} · {mapDisplayName(match.map_name)}
            </div>
            <div className="text-xs text-secondary">{contextLabel(match)}</div>
          </>
        )}
      </div>
      <Outcomes contacts={contacts} detailed={view !== "people"} />
      <div className="opp-stat">
        <span className="opp-mobile-label">赛季 KD</span>
        <strong className="font-mono text-base tabular-nums">{stats?.kd?.toFixed(2) ?? "—"}</strong>
      </div>
      <div className="opp-stat">
        <span className="opp-mobile-label">场均伤害</span>
        <span className="tabular-nums">{stats?.adr ?? "—"}</span>
        <small>{stats ? `${stats.rounds} 场` : "场次 —"}</small>
      </div>
      <div className="opp-stat">
        <span className="opp-mobile-label">生存等级</span>
        <span>{mastery?.level != null ? `${mastery.tier ?? "?"} 阶 / Lv.${mastery.level}` : "—"}</span>
        {stats?.rank && <small>{stats.rank}</small>}
      </div>
    </li>
  );
}

const sortOptions = [
  { value: "kd", label: "KD 从高到低" },
  { value: "matches", label: "交手局数最多" },
  { value: "recent", label: "最近交手优先" },
];
const resultOptions = [
  { value: "all", label: "全部结果" },
  { value: "out_kill", label: "我淘汰对方" },
  { value: "in_kill", label: "对方淘汰我" },
  { value: "no_kill", label: "仅伤害或击倒" },
];

function matchReadState(result: MatchResult | undefined, busy: boolean) {
  if (result?.error) return "遥测缺失";
  if (result?.encounters) return `${result.encounters.opponents.length} 名对手`;
  return busy ? "等待读取" : "未读取";
}

const viewLabels = {
  people: {
    title: "对手名单",
    list: "合并对手名单",
    detail: "按账号合并，战绩取筛选内最近一局的赛季与模式",
  },
  match: { title: "本局交手对手", list: "本局对手名单", detail: "按本局对应的赛季 KD 倒序" },
  log: { title: "交手记录", list: "全部交手记录", detail: "每行对应一局中的一名对手" },
};

export function OpponentOverview({ report, busy }: { report: OpponentReport; busy: boolean }) {
  const [view, setView] = useState<View>("people");
  const [chosenMatchId, setChosenMatchId] = useState("");
  const [sort, setSort] = useState<DirectorySort>("kd");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [query, setQuery] = useState("");
  const timeline = view === "log";
  const contacts = useMemo(() => reportContacts(report), [report.matches, report.stats]);
  const byMatch = view === "match";
  const results = new Map(report.matches.map((m) => [m.match_id, m]));
  const selected =
    report.history.matches.find((m) => m.match_id === chosenMatchId) ?? report.history.matches[0];
  const selectedResult = selected && results.get(selected.match_id);
  const scoped = useMemo(
    () => (byMatch ? contacts.filter((c) => c.match.match_id === selected?.match_id) : contacts),
    [byMatch, contacts, selected?.match_id],
  );
  const filtered = useMemo(() => filterContacts(scoped, query, outcome), [scoped, query, outcome]);
  const rows = useMemo(
    () => (timeline ? filtered.map((c) => [c]) : opponentGroups(filtered, byMatch ? "kd" : sort)),
    [filtered, sort, timeline, byMatch],
  );
  const read = report.matches.filter((m) => m.encounters).length;
  const humans = scoped.filter((c) => c.person.kind === "human");
  const humanCount = new Set(humans.map((c) => c.person.player_id)).size;
  const covered = new Set(humans.filter((c) => c.stats).map((c) => c.person.player_id)).size;
  const missing = report.matches.filter(
    (m) => m.error || (m.encounters && !m.encounters.opponents.length),
  );
  function emptyMessage() {
    if (!report.history.matches.length) return "此次查询没有可分析的对局。";
    if (byMatch) {
      if (selectedResult?.error) return `本局遥测缺失：${selectedResult.error}`;
      if (!selectedResult?.encounters) return busy ? "等待读取本局遥测…" : "本次分析未读取这局遥测。";
      if (!scoped.length) return "本局未记录到交手。";
    }
    if (scoped.length) return "没有符合筛选条件的对手。";
    if (busy && read < report.history.matches.length) return "正在读取对局交手记录…";
    return "已读取的对局中暂无交手记录。";
  }

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="分析结果">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl label="交手展示方式" value={view} onChange={(value) => setView(value as View)}>
          <SegmentedControlItem value="people" label="对手名单" />
          <SegmentedControlItem value="match" label="按对局" />
          <SegmentedControlItem value="log" label="交手记录" />
        </SegmentedControl>
        {byMatch && selected && (
          <Selector
            label="选择交手对局"
            isLabelHidden
            containerClassName="w-full sm:w-96"
            value={selected.match_id}
            onChange={setChosenMatchId}
            options={report.history.matches.map((match) => ({
              value: match.match_id,
              label: `${matchTime(match)} · ${mapDisplayName(match.map_name)} · ${matchReadState(results.get(match.match_id), busy)}`,
            }))}
          />
        )}
      </div>
      {(!byMatch || selected) && (
        <Card padding={0} className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-5 py-3">
            <div>
              <h2 className="text-xl font-semibold">
                {byMatch && selected ? mapDisplayName(selected.map_name) : report.history.player_name}
              </h2>
              {byMatch && selected && (
                <p className="text-xs text-secondary">
                  {matchTime(selected)} · {contextLabel(selectedResult ?? selected)}
                </p>
              )}
            </div>
            <p className="text-xs text-secondary">
              {byMatch ? "本局" : `已读 ${read}/${report.history.matches.length} 局`}
              {(!byMatch || selectedResult?.encounters) && (
                <>
                  {" · "}真人 {humanCount} 人 · 有战绩 {covered} 人 · 机器人{" "}
                  {scoped.filter((c) => c.person.kind === "bot").length} 人次
                </>
              )}
            </p>
          </div>
          {(!byMatch || selectedResult?.encounters) && <StrengthSummary contacts={scoped} />}
        </Card>
      )}
      {report && (report.cacheHits.season > 0 || report.cacheHits.mastery > 0) && (
        <p className="text-xs text-secondary">
          本地复用：赛季战绩 {report.cacheHits.season} 项 · 生存等级 {report.cacheHits.mastery} 项
        </p>
      )}
      {report.warnings.map((message) => (
        <p key={message} className="text-sm text-warning">
          {message}
        </p>
      ))}
      <Card padding={0} className="opp-directory min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <h3 className="font-semibold">{viewLabels[view].title}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <TextInput
              label="搜索对手"
              isLabelHidden
              startIcon={Search}
              hasClear
              placeholder="搜索昵称或账号 ID"
              value={query}
              onChange={setQuery}
            />
            <Selector
              label="交手结果筛选"
              isLabelHidden
              options={resultOptions}
              value={outcome}
              onChange={(v) => setOutcome(v as OutcomeFilter)}
            />
            {view === "people" && (
              <Selector
                label="对手排序"
                isLabelHidden
                options={sortOptions}
                value={sort}
                onChange={(v) => setSort(v as DirectorySort)}
              />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-1 px-4 pb-3 text-xs text-secondary">
          <span>
            {byMatch
              ? selectedResult?.encounters
                ? `显示 ${rows.length} / ${scoped.length} 名对手`
                : ""
              : timeline
                ? `${rows.length} 条交手记录 · 按开局时间倒序`
                : `${rows.length} 名对手 · ${filtered.length} 人次交手`}
          </span>
          <span>{viewLabels[view].detail}</span>
        </div>
        <div className="opp-columns bg-muted/50 text-xs text-secondary" aria-hidden>
          <span>{byMatch ? "对手" : "对手 / 对局"}</span>
          <span>交手结果</span>
          <span>赛季 KD</span>
          <span>均伤 / 场次</span>
          <span>生存等级 / 段位</span>
        </div>
        {rows.length ? (
          <ul className="m-0 list-none p-0" aria-label={viewLabels[view].list}>
            {rows.map((group) => (
              <OpponentRow
                key={
                  timeline
                    ? `${group[0].match.match_id}/${group[0].person.player_id}`
                    : group[0].person.player_id
                }
                contacts={group}
                view={view}
                mastery={report.mastery[group[0].person.player_id]}
              />
            ))}
          </ul>
        ) : (
          <p className="border-t border-border px-4 py-8 text-center text-sm text-secondary">
            {emptyMessage()}
          </p>
        )}
      </Card>
      {!byMatch && missing.length > 0 && (
        <details className="text-sm text-secondary">
          <summary className="cursor-pointer">无交手或遥测缺失的对局（{missing.length}）</summary>
          <ul className="mt-2 space-y-1">
            {missing.map((m) => (
              <li key={m.match_id}>
                {matchTime(m)} · {mapDisplayName(m.map_name)} · {m.error ?? "未记录到交手"}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs leading-relaxed text-secondary">
        强度分布按真人交手人次计算，同一人每局计一次。开局时间为北京时间。普通局 KD 用击杀数 ÷
        败场估算，排位用击杀数 ÷ 死亡数。生存等级取查询时的值，缺失数据以 — 表示。
      </p>
    </section>
  );
}
