import { usePlayerWorkspace } from "../playerWorkspace";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { useEffect, useRef, useState } from "react";
import { apiErrorMessage, type TeamDashboardPlayer } from "../api";
import {
  compareTeamOpponents,
  median,
  memberOpponents,
  type TeamComparison,
} from "../opponentAnalysis";

import { TeamOpponentCharts } from "./TeamOpponentCharts";

function comparisonColumn(player: TeamDashboardPlayer, report: TeamComparison | null) {
  const contacts = report ? memberOpponents(report, player.player_id) : [];
  const kds = contacts.flatMap((c) => (c.stats?.kd != null ? [c.stats.kd] : []));
  const adrs = contacts.flatMap((c) => (c.stats?.adr != null ? [c.stats.adr] : []));
  const levels = contacts.flatMap(({ mastery }) =>
    mastery?.tier != null && mastery.level != null
      ? [{ tier: mastery.tier, level: mastery.level }]
      : [],
  );
  const highest = levels.sort((a, b) => b.tier - a.tier || b.level - a.level)[0];
  const total = contacts.length;
  const read = !!report?.samples.length;
  const covered = (value: string, count: number) =>
    read && total > 0 ? `${value}（${count}/${total}）` : "—";
  return [
    player.deaths > 0 ? (player.kills / player.deaths).toFixed(2) : "—",
    player.match_count > 0 ? (player.damage / player.match_count).toFixed(1) : "—",
    player.match_count > 0 ? (player.knocks / player.match_count).toFixed(2) : "—",
    player.kills,
    read ? total : "—",
    covered(median(kds), kds.length),
    covered(median(adrs), adrs.length),
    covered(highest ? `${highest.tier} 阶 / Lv.${highest.level}` : "—", levels.length),
  ];
}

const metrics = [
  "本人 KD",
  "本人场均伤害",
  "本人场均击倒",
  "本人总淘汰",
  "交手真人人次",
  "对手赛季 KD 中位数",
  "对手赛季场均伤害中位数",
  "对手最高生存等级",
];

export function TeamOpponentComparison({
  members,
  matchIds,
}: {
  members: TeamDashboardPlayer[];
  matchIds: string[];
}) {
  const { rangeLabel, player } = usePlayerWorkspace();
  const [report, setReport] = useState<TeamComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  async function compare() {
    if (active.current || matchIds.length === 0) return;
    const run = new AbortController();
    active.current = run;
    setError("");
    setBusy(true);
    try {
      await compareTeamOpponents(
        matchIds,
        members.length ? members.map((p) => p.player_id) : [player.player_id],
        run.signal,
        setReport,
        setStatus,
      );
      setStatus("分析完成");
    } catch (err) {
      if (active.current !== run) return;
      if (run.signal.aborted) setStatus("已停止，保留已查到的数据");
      else {
        setError(apiErrorMessage(err));
        setStatus("");
      }
    } finally {
      if (active.current === run) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  const columns = members.map((p) => comparisonColumn(p, report));
  return (
    <Card padding={4} className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">全队交战对手分布</h3>
        {matchIds.length > 0 &&
          (busy ? (
            <Button label="停止分析" size="sm" onClick={() => active.current?.abort()} />
          ) : (
            <Button
              label={report ? "重新分析" : "分析交手强度"}
              variant="primary"
              size="sm"
              onClick={compare}
            />
          ))}
      </div>
      {matchIds.length === 0 ? (
        <p className="mt-3 text-sm text-secondary">
          {members.length ? `${rangeLabel}中没有所选成员全员同队出场的比赛。减少勾选人数可以扩大样本。` : `${rangeLabel}中没有可分析的组队比赛。`}
        </p>
      ) : (
        <>
          <p className="my-3 text-sm text-secondary">
            {members.length ? `所选 ${members.length} 人共同出场` : "当前玩家组队出场"} {matchIds.length} 局
            {report && ` · 已读交手遥测 ${report.samples.length}/${matchIds.length} 局`}
          </p>
          <p className="mb-3 text-xs text-secondary">汇总每局全队实际交手的真人。同一对手每局计一次，多名队员交手也只计一次。</p>
          {report && <TeamOpponentCharts report={report} />}
          {members.length > 0 && <>
            <Table density="compact" aria-label="队员横向对比">
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell scope="col">指标</TableHeaderCell>
                  {members.map((p) => (
                    <TableHeaderCell scope="col" key={p.player_id}>
                      {p.player_name || p.player_id}
                    </TableHeaderCell>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.map((label, index) => (
                  <TableRow key={label}>
                    <TableHeaderCell scope="row">{label}</TableHeaderCell>
                    {columns.map((column, i) => (
                      <TableCell key={members[i].player_id}>{column[index]}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-secondary">
              本人 KD 为共同对局的总淘汰 ÷ 总死亡。对手仅统计本人实际交手的真人，每人每局计一次。
              括号为有该项数据的人次 / 已识别的交手人次。普通局对手 KD 用击杀 ÷ 败场估算，排位用击杀 ÷
              死亡。
            </p>
          </>}
        </>
      )}
      {report && (report.cacheHits.season > 0 || report.cacheHits.mastery > 0) && (
        <p className="text-xs text-secondary">
          本地复用：赛季战绩 {report.cacheHits.season} 项 · 生存等级 {report.cacheHits.mastery} 项
        </p>
      )}
      {status && (
        <p className="mt-2 text-sm" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}
      {report?.warnings.map((w) => (
        <p className="mt-2 text-sm text-warning" key={w}>
          {w}
        </p>
      ))}
    </Card>
  );
}
