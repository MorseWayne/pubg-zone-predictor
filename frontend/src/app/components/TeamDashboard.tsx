import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Loader2, RefreshCw, Shield, Skull, Swords, Trophy, Users } from "lucide-react";
import { api, apiErrorMessage, LocalPlayer, TeamDashboard as TeamDashboardData, TeamDashboardPlayer } from "../api";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const SERIES = ["#3987e5", "#199e70", "#c98500", "#008300"];
const MAX_TEAMMATES = 3;
const TEAMMATE_CANDIDATE_LIMIT = 50;
const MATCH_LIMIT = 20;

type StatCardProps = {
  icon: typeof Trophy;
  label: string;
  value: string;
  sublabel?: string;
};

function playerLabel(player: Pick<LocalPlayer, "player_id" | "player_name">) {
  return player.player_name || player.player_id.replace(/^account\./, "");
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("zh-CN") : "未知";
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
    <Card className="border-border bg-card shadow-sm">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </div>
        <div className="text-2xl font-bold tracking-tight text-foreground">{value}</div>
        {sublabel && <div className="text-xs text-muted-foreground">{sublabel}</div>}
      </CardContent>
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
        const damageWidth = `${Math.max(3, (player.damage / maxDamage) * 100)}%`;
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
                <span className="truncate font-medium text-foreground">{playerLabel(player)}</span>
              </div>
              <span className="shrink-0 text-muted-foreground">
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
        <Skeleton key={index} className="h-28" />
      ))}
    </div>
  );
}

export function TeamDashboard() {
  const [players, setPlayers] = useState<LocalPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState(() => localStorage.getItem("pzp_team_player") || "");
  const [selectedTeammates, setSelectedTeammates] = useState<string[]>(() => {
    const saved = localStorage.getItem("pzp_team_teammates");
    if (!saved) return [];
    try {
      return JSON.parse(saved);
    } catch {
      return [];
    }
  });
  const [dashboard, setDashboard] = useState<TeamDashboardData | null>(null);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState(true);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => dashboard?.selected_players.map((player) => player.player_id) ?? [],
    [dashboard],
  );
  const totals = useMemo(() => teamTotals(dashboard?.selected_players ?? []), [dashboard]);
  const hasPlayers = players.length > 0;

  const refreshPlayers = async () => {
    setError(null);
    setIsLoadingPlayers(true);
    try {
      const payload = await api.listLocalPlayers(100);
      setPlayers(payload.players);
      setSelectedPlayerId((current) => current || payload.players[0]?.player_id || "");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setIsLoadingPlayers(false);
    }
  };

  useEffect(() => {
    void refreshPlayers();
  }, []);

  useEffect(() => {
    localStorage.setItem("pzp_team_player", selectedPlayerId);
    localStorage.setItem("pzp_team_teammates", JSON.stringify(selectedTeammates));
  }, [selectedPlayerId, selectedTeammates]);

  useEffect(() => {
    if (!selectedPlayerId) {
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
          match_limit: MATCH_LIMIT,
          teammate_candidate_limit: TEAMMATE_CANDIDATE_LIMIT,
        });
        if (cancelled) return;
        setDashboard(payload);
        setSelectedTeammates((current) => {
          if (current.length > 0) return current.filter((id) => payload.teammates.some((player) => player.player_id === id));
          return payload.teammates.slice(0, MAX_TEAMMATES).map((player) => player.player_id);
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
  }, [selectedPlayerId, selectedTeammates.join("|")]);

  const toggleTeammate = (playerId: string) => {
    setSelectedTeammates((current) => {
      if (current.includes(playerId)) return current.filter((id) => id !== playerId);
      if (current.length >= MAX_TEAMMATES) return current;
      return [...current, playerId];
    });
  };

  return (
    <div className="dark flex h-full w-full flex-col gap-4 overflow-auto bg-background p-4 text-foreground">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded border border-border bg-muted p-2 text-primary">
            <Users className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-foreground">团队数据看板</h1>
            <p className="truncate text-xs text-muted-foreground">从个人最近 50 场四排筛队友，选择 20 场统计协同表现</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedPlayerId}
            onValueChange={(value) => {
              setSelectedPlayerId(value);
              setSelectedTeammates([]);
            }}
            disabled={isLoadingPlayers || !hasPlayers}
          >
            <SelectTrigger className="w-[280px]">
              <SelectValue placeholder="选择个人" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {players.map((player) => (
                  <SelectItem key={player.player_id} value={player.player_id}>
                    {playerLabel(player)} · {player.match_count} 场
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={refreshPlayers} disabled={isLoadingPlayers}>
            {isLoadingPlayers ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>团队数据加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!isLoadingPlayers && !hasPlayers && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>还没有本地玩家数据</AlertTitle>
          <AlertDescription>先在“数据采集”里按玩家采集 squad/squad-fpp 对局，再回到这里看团队分析。</AlertDescription>
        </Alert>
      )}

      {isLoadingDashboard ? (
        <LoadingCards />
      ) : dashboard ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <StatCard icon={Shield} label="统计场次" value={`${totals.matches}`} sublabel="最近 20 场同队样本" />
            <StatCard icon={Trophy} label="吃鸡 / 前三" value={`${pct(totals.wins, totals.matches)}% / ${pct(totals.top3, totals.matches)}%`} sublabel={`${totals.wins} 胜 · ${totals.top3} 次前三`} />
            <StatCard icon={Skull} label="团队淘汰" value={`${totals.kills}`} sublabel={`KD ${totals.deaths > 0 ? (totals.kills / totals.deaths).toFixed(1) : totals.kills.toFixed(1)}`} />
            <StatCard icon={Swords} label="团队伤害" value={`${Math.round(totals.damage)}`} sublabel={`场均 ${totals.matches > 0 ? Math.round(totals.damage / totals.matches) : 0}`} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_1fr]">
            <Card className="border-border bg-card shadow-sm">
              <CardHeader className="px-4 pt-4">
                <CardTitle className="text-sm">最近 50 场四排队友</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 px-4">
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="text-xs text-muted-foreground">个人</div>
                  <div className="mt-1 font-semibold text-foreground">{playerLabel(dashboard.primary_player)}</div>
                </div>
                {dashboard.teammates.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">最近对局里还没识别到同队队友。</div>
                ) : (
                  dashboard.teammates.map((player) => {
                    const checked = selectedIds.includes(player.player_id);
                    const disabled = !checked && selectedTeammates.length >= MAX_TEAMMATES;
                    return (
                      <label key={player.player_id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm hover:bg-muted/40">
                        <Checkbox checked={checked} disabled={disabled} onCheckedChange={() => toggleTeammate(player.player_id)} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">{playerLabel(player)}</div>
                          <div className="text-xs text-muted-foreground">{player.match_count} 场同队 · {player.kills} 淘汰 · {Math.round(player.damage)} 伤害</div>
                        </div>
                        {checked && <Badge variant="outline">已选</Badge>}
                      </label>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <div className="grid min-w-0 grid-cols-1 gap-4 2xl:grid-cols-2">
              <Card className="border-border bg-card shadow-sm">
                <CardHeader className="px-4 pt-4">
                  <CardTitle className="flex items-center gap-2 text-sm"><BarChart3 className="size-4" /> 输出对比</CardTitle>
                </CardHeader>
                <CardContent className="px-4">
                  <TeamBarChart players={dashboard.selected_players} />
                </CardContent>
              </Card>

              <Card className="border-border bg-card shadow-sm">
                <CardHeader className="px-4 pt-4">
                  <CardTitle className="text-sm">成员明细</CardTitle>
                </CardHeader>
                <CardContent className="px-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>玩家</TableHead>
                        <TableHead className="text-right">场次</TableHead>
                        <TableHead className="text-right">均伤</TableHead>
                        <TableHead className="text-right">淘汰</TableHead>
                        <TableHead className="text-right">击倒</TableHead>
                        <TableHead className="text-right">均名次</TableHead>
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
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-border bg-card shadow-sm">
            <CardHeader className="px-4 pt-4">
              <CardTitle className="text-sm">最近同队对局</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>地图</TableHead>
                    <TableHead>成员</TableHead>
                    <TableHead className="text-right">排名</TableHead>
                    <TableHead className="text-right">淘汰</TableHead>
                    <TableHead className="text-right">伤害</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.matches.map((match) => (
                    <TableRow key={match.match_id}>
                      <TableCell>{formatDate(match.created_at)}</TableCell>
                      <TableCell>{match.map_name.replace(/_Main$/, "")}</TableCell>
                      <TableCell className="max-w-[420px] truncate">{match.players.map(playerLabel).join(" / ")}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.team_rank ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.kills}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(match.damage)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
