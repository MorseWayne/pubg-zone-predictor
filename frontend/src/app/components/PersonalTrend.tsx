import { Banner } from "@astryxdesign/core/Banner";
import { usePlayerWorkspace } from "../playerWorkspace";
import { formatMatchDate, statsWindow } from "../matchRange";
import { Card } from "@astryxdesign/core/Card";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, TrendingUp, Trophy } from "lucide-react";
import { api, apiErrorMessage, PersonalTrend as PersonalTrendData, PersonalTrendWindow } from "../api";





function formatDelta(value: number | null, digits = 0) {
  if (value === null) return "-";
  const rounded = digits > 0 ? value.toFixed(digits) : String(Math.round(value));
  return value > 0 ? `+${rounded}` : rounded;
}

function pct(value: number, total: number) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function trendMeta(trend: PersonalTrendData["trend"]) {
  if (trend === "improving") return { label: "正在进步", icon: ArrowUp, className: "text-emerald-400" };
  if (trend === "declining") return { label: "状态下滑", icon: ArrowDown, className: "text-red-400" };
  if (trend === "stable") return { label: "基本稳定", icon: ArrowRight, className: "text-sky-400" };
  return { label: "样本不足", icon: AlertTriangle, className: "text-amber-400" };
}

function WindowCard({ window }: { window: PersonalTrendWindow }) {
  return (
    <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
      <header className="grid gap-1.5 px-4 pt-4">
        <h3 className="font-semibold text-sm">{window.label}</h3>
      </header>
      <div className="pb-5 grid grid-cols-2 gap-3 px-4 text-sm">
        <div>
          <div className="text-xs text-secondary">场次</div>
          <div className="font-semibold text-primary">{window.match_count}</div>
        </div>
        <div>
          <div className="text-xs text-secondary">前 3 率</div>
          <div className="font-semibold text-primary">{pct(window.top3, window.match_count)}%</div>
        </div>
        <div>
          <div className="text-xs text-secondary">均伤</div>
          <div className="font-semibold text-primary">{Math.round(window.avg_damage)}</div>
        </div>
        <div>
          <div className="text-xs text-secondary">场均淘汰</div>
          <div className="font-semibold text-primary">{window.avg_kills.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-xs text-secondary">均名次</div>
          <div className="font-semibold text-primary">{window.avg_rank?.toFixed(1) ?? "-"}</div>
        </div>
        <div>
          <div className="text-xs text-secondary">评分</div>
          <div className="font-semibold text-primary">{Math.round(window.score)}</div>
        </div>
      </div>
    </Card>
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

export function PersonalTrend() {
  const { player, statMatchIds, syncing, matchDate, rangeLabel } = usePlayerWorkspace();
  const selectedPlayerId = player.player_id;
  const [trend, setTrend] = useState<PersonalTrendData | null>(null);
  const [isLoadingTrend, setIsLoadingTrend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = useMemo(() => trendMeta(trend?.trend ?? "insufficient_data"), [trend]);

  useEffect(() => {
    if (!statMatchIds.length) {
      setError(null);
      setIsLoadingTrend(false);
      setTrend(null);
      return;
    }
    let cancelled = false;
    const loadTrend = async () => {
      setIsLoadingTrend(true);
      setError(null);
      try {
        const payload = await api.getPersonalTrend({ player_id: selectedPlayerId, ...statsWindow(matchDate, statMatchIds) });
        if (!cancelled) setTrend(payload);
      } catch (err) {
        if (!cancelled) {
          setTrend(null);
          setError(apiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setIsLoadingTrend(false);
      }
    };
    void loadTrend();
    return () => {
      cancelled = true;
    };
  }, [selectedPlayerId, statMatchIds, matchDate]);

  const TrendIcon = meta.icon;

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto bg-body p-4 text-primary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded border border-border bg-muted p-2 text-primary">
            <TrendingUp className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-primary">个人历史分析</h1>
            <p className="truncate text-xs text-secondary">{player.player_name} · 对比{rangeLabel}中的早期和近期样本</p>
          </div>
        </div>

      </div>

      {error && (
        <Banner status="error" role="alert" title="个人历史加载失败" description={error} />
      )}

      {!statMatchIds.length && <Banner status="info"
        title={syncing ? "正在准备当前玩家的对局" : matchDate ? `${matchDate} 没有可分析的对局` : "该玩家暂无可分析的近期对局"} />}

      {isLoadingTrend ? (
        <LoadingCards />
      ) : trend ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
              <div className="px-5 pb-5 flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2 text-xs font-medium text-secondary">
                  <TrendIcon className={`size-4 ${meta.className}`} /> 变化判断
                </div>
                <div className={`text-2xl font-bold tracking-tight ${meta.className}`}>{meta.label}</div>
                <div className="text-xs text-secondary">样本：{trend.matches.length} 场</div>
              </div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
              <div className="px-5 pb-5 flex flex-col gap-2 p-4">
                <div className="text-xs font-medium text-secondary">评分变化</div>
                <div className="text-2xl font-bold text-primary">{formatDelta(trend.score_delta)}</div>
                <div className="text-xs text-secondary">综合伤害、淘汰、死亡和名次</div>
              </div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
              <div className="px-5 pb-5 flex flex-col gap-2 p-4">
                <div className="text-xs font-medium text-secondary">均伤变化</div>
                <div className="text-2xl font-bold text-primary">{formatDelta(trend.damage_delta)}</div>
                <div className="text-xs text-secondary">最近样本 - 早期样本</div>
              </div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
              <div className="px-5 pb-5 flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2 text-xs font-medium text-secondary">
                  <Trophy className="size-4" /> 均名次变化
                </div>
                <div className="text-2xl font-bold text-primary">{formatDelta(trend.rank_delta, 1)}</div>
                <div className="text-xs text-secondary">负数代表名次变好</div>
              </div>
            </Card>
          </div>

          {trend.trend === "insufficient_data" && (
            <Banner status="info" title="样本不足" description="至少需要 4 场本地历史对局，才能把早期和最近样本分开比较。" />
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <WindowCard window={trend.early} />
            <WindowCard window={trend.recent} />
          </div>

          <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
            <header className="grid gap-1.5 px-4 pt-4">
              <h3 className="font-semibold text-sm">个人对局</h3>
            </header>
            <div className="pb-5 px-4">
              <Table>
                <TableHeader>
                <TableRow isHeaderRow>
                    <TableHeaderCell>时间</TableHeaderCell>
                    <TableHeaderCell>地图</TableHeaderCell>
                    <TableHeaderCell className="text-right">排名</TableHeaderCell>
                    <TableHeaderCell className="text-right">淘汰</TableHeaderCell>
                    <TableHeaderCell className="text-right">击倒</TableHeaderCell>
                    <TableHeaderCell className="text-right">伤害</TableHeaderCell>
                    <TableHeaderCell className="text-right">评分</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trend.matches.map((match) => (
                    <TableRow key={match.match_id}>
                      <TableCell>{formatMatchDate(match.created_at, !!matchDate)}</TableCell>
                      <TableCell>{match.map_name.replace(/_Main$/, "")}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.team_rank ?? "-"}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.kills}</TableCell>
                      <TableCell className="text-right tabular-nums">{match.knocks}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(match.damage)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Math.round(match.score)}</TableCell>
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
