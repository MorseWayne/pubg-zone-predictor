import { Banner } from "@astryxdesign/core/Banner";
import { usePlayerWorkspace } from "../playerWorkspace";
import { formatMatchDate, statsWindow, HISTORY_LIMIT } from "../matchRange";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TeamOpponentComparison } from "./TeamOpponentComparison";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, Shield, Skull, Swords, Trophy, Users } from "lucide-react";
import { api, apiErrorMessage, LocalPlayer, TeamDashboard as TeamDashboardData, TeamDashboardPlayer } from "../api";

const SERIES = ["#3987e5", "#199e70", "#c98500", "#008300"];
const MAX_TEAMMATES = 3;



type StatCardProps = {
  icon: typeof Trophy;
  label: string;
  value: string;
  sublabel?: string;
};

function playerLabel(player: Pick<LocalPlayer, "player_id" | "player_name">) {
  return player.player_name || player.player_id.replace(/^account\./, "");
}



function pct(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function teamTotals(players: TeamDashboardPlayer[]) {
  return players.reduce(
    (total, player) => ({
      matches: Math.max(total.matches, player.match_count),
      wins: Math.max(total.wins, player.wins),
      top3: Math.max(total.top3, player.top3),
      kills: total.kills + player.kills,
      knocks: total.knocks + player.knocks,
      deaths: total.deaths + player.deaths,
      damage: total.damage + player.damage,
    }),
    { matches: 0, wins: 0, top3: 0, kills: 0, knocks: 0, deaths: 0, damage: 0 },
  );
}

function StatCard({ icon: Icon, label, value, sublabel }: StatCardProps) {
  return (
    <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
      <div className="px-5 pb-5 flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-secondary">
          <Icon className="size-4" />
          {label}
        </div>
        <div className="text-2xl font-bold tracking-tight text-primary">{value}</div>
        {sublabel && <div className="text-xs text-secondary">{sublabel}</div>}
      </div>
    </Card>
  );
}

function TeamBarChart({ players }: { players: TeamDashboardPlayer[] }) {
  const maxDamage = Math.max(1, ...players.map((player) => player.damage));
  const maxKills = Math.max(1, ...players.map((player) => player.kills));
  return (
    <div className="space-y-4" role="img" aria-label="队友伤害和击杀对比图">
      {players.map((player, index) => {
        const color = SERIES[index] ?? SERIES[SERIES.length - 1];
        const damageWidth = `${Math.max(player.damage > 0 ? 3 : 0, (player.damage / maxDamage) * 100)}%`;
        const killsWidth = `${Math.max(player.kills > 0 ? 3 : 0, (player.kills / maxKills) * 100)}%`;
        return (
          <div
            key={player.player_id}
            className="space-y-1.5"
            title={`${playerLabel(player)}：${Math.round(player.damage)} 伤害，${player.kills} 淘汰，${player.knocks} 击倒`}
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="truncate font-medium text-primary">{playerLabel(player)}</span>
              </div>
              <span className="shrink-0 text-secondary">
                {Math.round(player.damage)} 伤害 · {player.kills} 淘汰
              </span>
            </div>
            <div className="space-y-1" aria-hidden="true">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: damageWidth, backgroundColor: color }} />
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                <div className="h-full rounded-full opacity-70" style={{ width: killsWidth, backgroundColor: color }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} height={112} />
      ))}
    </div>
  );
}

export function TeamDashboard() {
  const { player, statMatchIds, syncing, matchDate, rangeLabel } = usePlayerWorkspace();
  const selectedPlayerId = player.player_id;
  const [selectedTeammates, setSelectedTeammates] = useState<string[]>([]);
  const [teammateQuery, setTeammateQuery] = useState("");
  const [dashboard, setDashboard] = useState<TeamDashboardData | null>(null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => teamTotals(dashboard?.selected_players ?? []), [dashboard]);

  useEffect(() => {
    if (!statMatchIds.length) {
      setError(null);
      setIsLoadingDashboard(false);
      setDashboard(null);
      return;
    }
    let cancelled = false;
    const loadDashboard = async () => {
      setIsLoadingDashboard(true);
      setError(null);
      try {
        const payload = await api.getTeamDashboard({
          player_id: selectedPlayerId,
          teammate_ids: selectedTeammates,
          ...statsWindow(matchDate, statMatchIds),
          teammate_candidate_limit: matchDate ? undefined : HISTORY_LIMIT,
        });
        if (cancelled) return;
        setDashboard(payload);
        setSelectedTeammates(current => {
          const available = current.filter(id => payload.teammates.some(p => p.player_id === id));
          return available.length === current.length ? current : available;
        });

      } catch (err) {
        if (!cancelled) {
          setDashboard(null);
          setError(apiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setIsLoadingDashboard(false);
      }
    };
    void loadDashboard();
    return () => {
      cancelled = true;
    };
  }, [selectedPlayerId, selectedTeammates.join("|"), statMatchIds, matchDate]);

  const toggleTeammate = (playerId: string) => {
    setSelectedTeammates((current) => {
      if (current.includes(playerId)) return current.filter((id) => id !== playerId);
      if (current.length >= MAX_TEAMMATES) return current;
      return [...current, playerId];
    });
  };

  const teammates = (dashboard?.teammates ?? []).filter(p => p.player_id.startsWith("account."));
  const query = teammateQuery.trim().toLowerCase();
  const visibleTeammates = teammates.filter(p => selectedTeammates.includes(p.player_id) ||
    playerLabel(p).toLowerCase().includes(query) || p.player_id.toLowerCase().includes(query));
  const comparing = selectedTeammates.length > 0;

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto bg-body p-4 text-primary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded border border-border bg-muted p-2 text-primary">
            <Users className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-primary">团队数据看板</h1>
            <p className="truncate text-xs text-secondary">{player.player_name} · {rangeLabel}中的组队表现，勾选队友可横向对比全员同队场次</p>
          </div>
        </div>

      </div>

      {error && (
        <Banner status="error" role="alert" title="团队数据加载失败" description={error} />
      )}

      {!statMatchIds.length && <Banner status="info"
        title={syncing ? "正在准备当前玩家的对局" : matchDate ? `${matchDate} 没有可分析的对局` : "该玩家暂无可分析的近期对局"} />}

      {isLoadingDashboard ? (
        <LoadingCards />
      ) : dashboard ? (
        <>
          {dashboard.matches.length > 0 && <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <StatCard icon={Shield} label="统计场次" value={`${totals.matches}`} sublabel={`${rangeLabel}中的组队样本`} />
            <StatCard icon={Trophy} label="吃鸡 / 前三" value={`${pct(totals.wins, totals.matches)}% / ${pct(totals.top3, totals.matches)}%`} sublabel={`${totals.wins} 胜 · ${totals.top3} 次前三`} />
            <StatCard icon={Skull} label="团队淘汰" value={`${totals.kills}`} sublabel={`KD ${totals.deaths > 0 ? (totals.kills / totals.deaths).toFixed(1) : "—"}`} />
            <StatCard icon={Swords} label="团队伤害" value={`${Math.round(totals.damage)}`} sublabel={`场均 ${totals.matches > 0 ? Math.round(totals.damage / totals.matches) : 0}`} />
          </div>}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
            <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
              <header className="grid gap-1.5 px-4 pt-4">
                <h3 className="font-semibold text-sm">选择对比队员</h3>
              </header>
              <div className="pb-5 space-y-2 px-4">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="text-xs text-secondary">个人</div>
                  <div className="mt-1 font-semibold text-primary">{playerLabel(dashboard.primary_player)}</div>
                </div>
                <p className="text-xs text-secondary">从{rangeLabel}的队友中勾选 1–3 人，与当前玩家比较。</p>
                {teammates.length > 0 && <TextInput label="查找队友" isLabelHidden
                  placeholder="搜索队友昵称或账号 ID" value={teammateQuery} onChange={setTeammateQuery} />}
                {query && teammates.length > 0 && !visibleTeammates.length && <p className="text-sm text-secondary">没有匹配的队友。</p>}
                {teammates.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm text-secondary">这个范围内还没识别到同队队友。</div>
                ) : (
                  <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">{visibleTeammates.map((player) => {
                    const checked = selectedTeammates.includes(player.player_id);
                    const disabled = !checked && selectedTeammates.length >= MAX_TEAMMATES;
                    return (
                      <CheckboxInput
                        key={player.player_id}
                        label={playerLabel(player)}
                        description={`${player.match_count} 场同队 · ${player.kills} 淘汰 · ${Math.round(player.damage)} 伤害`}
                        value={checked}
                        isDisabled={disabled}
                        onChange={() => toggleTeammate(player.player_id)}
                      />
                    );
                  })}</div>
                )}
              </div>
            </Card>

            <div className="grid min-w-0 content-start gap-4">
              {dashboard.matches.length > 0 && <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
                <header className="grid gap-1.5 px-4 pt-4">
                  <h3 className="font-semibold flex items-center gap-2 text-sm"><BarChart3 className="size-4" /> 输出对比</h3>
                </header>
                <div className="pb-5 px-4">
                  <TeamBarChart players={dashboard.selected_players} />
                </div>
              </Card>}

                <TeamOpponentComparison
                  key={JSON.stringify([selectedPlayerId, selectedTeammates, dashboard.matches.map(m => m.match_id)])}
                  members={comparing ? dashboard.selected_players : []}
                  matchIds={dashboard.matches.map(m => m.match_id)}
                />
              {!comparing && (
              <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
                <header className="grid gap-1.5 px-4 pt-4">
                  <h3 className="font-semibold text-sm">成员明细</h3>
                </header>
                <div className="pb-5 px-4">
                  <Table>
                    <TableHeader>
                <TableRow isHeaderRow>
                        <TableHeaderCell>玩家</TableHeaderCell>
                        <TableHeaderCell className="text-right">场次</TableHeaderCell>
                        <TableHeaderCell className="text-right">均伤</TableHeaderCell>
                        <TableHeaderCell className="text-right">淘汰</TableHeaderCell>
                        <TableHeaderCell className="text-right">击倒</TableHeaderCell>
                        <TableHeaderCell className="text-right">均名次</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboard.selected_players.map((player, index) => (
                        <TableRow key={player.player_id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="size-2.5 rounded-full" style={{ backgroundColor: SERIES[index] ?? SERIES[0] }} />
                              {playerLabel(player)}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{player.match_count}</TableCell>
                          <TableCell className="text-right tabular-nums">{player.match_count > 0 ? Math.round(player.damage / player.match_count) : 0}</TableCell>
                          <TableCell className="text-right tabular-nums">{player.kills}</TableCell>
                          <TableCell className="text-right tabular-nums">{player.knocks}</TableCell>
                          <TableCell className="text-right tabular-nums">{player.avg_rank?.toFixed(1) ?? "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
              )}
            </div>
          </div>

          <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
            <header className="grid gap-1.5 px-4 pt-4">
              <h3 className="font-semibold text-sm">同队对局</h3>
            </header>
            <div className="pb-5 px-4">
              <Table>
                <TableHeader>
                <TableRow isHeaderRow>
                    <TableHeaderCell>时间</TableHeaderCell>
                    <TableHeaderCell>地图</TableHeaderCell>
                    <TableHeaderCell>成员</TableHeaderCell>
                    <TableHeaderCell className="text-right">排名</TableHeaderCell>
                    <TableHeaderCell className="text-right">淘汰</TableHeaderCell>
                    <TableHeaderCell className="text-right">伤害</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.matches.map((match) => (
                    <TableRow key={match.match_id}>
                      <TableCell>{formatMatchDate(match.created_at, !!matchDate)}</TableCell>
                      <TableCell>{match.map_name.replace(/_Main$/, "")}</TableCell>
                      <TableCell className="max-w-[420px] truncate">{match.players.map(playerLabel).join(" / ")}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.team_rank ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.kills}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(match.damage)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
