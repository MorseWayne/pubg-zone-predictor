import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Search } from "lucide-react";
import { apiErrorMessage } from "../api";
import {
  analyzeOpponents,
  statsGroup,
  type MatchResult,
  type OpponentReport,
} from "../opponentAnalysis";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Card } from "@astryxdesign/core/Card";

const actionNames: Record<string, string> = {
  out_damage: "我造成伤害",
  in_damage: "对方造成伤害",
  out_knock: "我击倒对方",
  in_knock: "对方击倒我",
  out_kill: "我淘汰对方",
  in_kill: "对方淘汰我",
};

function median(values: number[]) {
  if (!values.length) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return ((sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2).toFixed(2);
}

function MatchDetails({ match, report }: { match: MatchResult; report: OpponentReport }) {
  const list = match.encounters?.opponents ?? [];
  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer">
        {match.created_at ? new Date(match.created_at).toLocaleString("zh-CN") : "日期未知"}
        {" · "}
        {match.map_name} · {match.game_mode} ·{" "}
        {match.match_type === "competitive"
          ? "排位"
          : match.match_type === "official"
            ? "普通"
            : match.match_type}
        <span className="ml-3 text-sm text-secondary">
          {match.error ? "遥测缺失" : `${list.length} 名交手对手`}
        </span>
      </summary>
      {match.error ? (
        <p className="mt-3 text-sm">{match.error}</p>
      ) : (
        <div className="mt-3">
          <p className="mb-2 text-xs text-secondary">
            {match.encounters?.season ?? "赛季未知"} · 等级为查询时的生存阶级 / 等级
          </p>
          {list.length === 0 ? (
            <p className="text-sm">未记录到与敌方之间的有效伤害、击倒或淘汰。</p>
          ) : (
            <Table density="compact" aria-label="本局交手对手战绩">
              <TableHeader>
                <TableRow isHeaderRow>
                  {["对手", "交手记录", "赛季 KD", "场均伤害", "场次", "段位", "生存等级"].map(
                    (label) => (
                      <TableHeaderCell key={label} scope="col">
                        {label}
                      </TableHeaderCell>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((person) => {
                  const stats = report.stats[`${statsGroup(match)}/${person.player_id}`];
                  const mastery = report.mastery[person.player_id];
                  return (
                    <TableRow key={person.player_id}>
                      <TableCell>
                        {person.name}
                        {person.kind === "bot"
                          ? "（机器人）"
                          : person.kind === "unknown"
                            ? "（身份未知）"
                            : ""}
                      </TableCell>
                      <TableCell>{person.actions.map((a) => actionNames[a]).join("、")}</TableCell>
                      <TableCell>{stats?.kd?.toFixed(2) ?? "—"}</TableCell>
                      <TableCell>{stats?.adr ?? "—"}</TableCell>
                      <TableCell>{stats?.rounds ?? "—"}</TableCell>
                      <TableCell>{stats?.rank ?? "—"}</TableCell>
                      <TableCell>
                        {mastery?.level != null
                          ? `${mastery.tier ?? "?"} 阶 / Lv.${mastery.level}`
                          : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </details>
  );
}

function Results({ report }: { report: OpponentReport }) {
  const encounters = report.matches.flatMap((match) =>
    (match.encounters?.opponents ?? []).map((person) => ({
      person,
      stats: report.stats[`${statsGroup(match)}/${person.player_id}`],
    })),
  );
  const human = encounters.filter((e) => e.person.kind === "human");
  const humanCount = new Set(human.map((e) => e.person.player_id)).size;
  const covered = new Set(human.filter((e) => e.stats).map((e) => e.person.player_id)).size;
  return (
    <section className="flex flex-col gap-4" aria-label="分析结果">
      <h2 className="text-xl font-semibold">{report.history.player_name}</h2>
      <p className="text-sm">
        已读 {report.matches.filter((m) => m.encounters).length} / {report.history.matches.length}{" "}
        局{" · "}交手真人 {humanCount} 人 · 已查到战绩 {covered} 人 · 机器人{" "}
        {encounters.filter((e) => e.person.kind === "bot").length} 人次
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {(
          [
            ["全部交手", ""],
            ["我淘汰的对手", "out_kill"],
            ["淘汰我的对手", "in_kill"],
          ] as const
        ).map(([label, action]) => {
          const group = human.filter((e) => !action || e.person.actions.includes(action));
          const kds = group.flatMap((e) => (e.stats?.kd != null ? [e.stats.kd] : []));
          return (
            <Card key={label} padding={4}>
              <p className="text-sm text-secondary">{label} · KD 中位数</p>
              <p className="my-2 text-3xl font-semibold tabular-nums">{median(kds)}</p>
              <p className="text-xs text-secondary">
                有 KD {kds.length} / {group.length} 人次
              </p>
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-secondary">
        同一对手每局计一次。战绩取比赛所属赛季和模式的累计值。普通局 KD 用击杀数 ÷
        败场估算，排位用击杀数 ÷ 死亡数。分母为零或资料缺失时显示 —。
      </p>
      {report.warnings.map((w) => (
        <p key={w} className="text-sm text-amber-400">
          {w}
        </p>
      ))}
      {report.history.matches.length === 0 && <p>此次查询没有可分析的对局。</p>}
      {report.matches.map((match) => (
        <MatchDetails key={match.match_id} match={match} report={report} />
      ))}
    </section>
  );
}

export function OpponentAnalysis() {
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("20");
  const [report, setReport] = useState<OpponentReport | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const validName = /^[^,\s]{1,64}$/.test(name);
  const run = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      run.current?.abort();
    },
    [],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validName || busy) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    setReport(null);
    setError("");
    try {
      await analyzeOpponents(name.trim(), Number(limit), controller.signal, setReport, setStatus);
      setStatus("分析完成");
    } catch (e) {
      if (controller.signal.aborted) setStatus("已停止查询");
      else {
        setError(apiErrorMessage(e));
        setStatus("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-body text-primary">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <header>
          <h1 className="text-2xl font-bold">交手对手强度</h1>
          <p className="mt-2 text-sm text-secondary">
            按选手本人造成或受到的伤害、击倒和淘汰，查看近期实际交手对手的战绩。
          </p>
        </header>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <TextInput
            label="Steam 选手昵称"
            containerClassName="min-w-48 flex-1"
            placeholder="输入完整游戏昵称"
            value={name}
            onChange={(value) => setName(value.slice(0, 64))}
            status={
              name && !validName ? { type: "error", message: "昵称不能包含空白或逗号" } : undefined
            }
            isRequired
            isDisabled={busy}
          />
          <SegmentedControl
            label="最近对局数"
            value={limit}
            onChange={setLimit}
            isDisabled={busy}
            size="lg"
          >
            <SegmentedControlItem value="15" label="近 15 局" />
            <SegmentedControlItem value="20" label="近 20 局" />
          </SegmentedControl>
          <Button
            type="submit"
            label="分析"
            icon={<Search size={16} />}
            variant="primary"
            size="lg"
            isDisabled={busy || !validName}
          />
          {busy && (
            <Button
              type="button"
              label="停止"
              variant="secondary"
              size="lg"
              onClick={() => run.current?.abort()}
            />
          )}
        </form>
        {status && (
          <p role="status" className="text-sm text-secondary">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-amber-400">
            {error}
          </p>
        )}
        {report && <Results report={report} />}
      </div>
    </div>
  );
}
