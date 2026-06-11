import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Filter,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { api, apiErrorMessage, IngestJob, IngestMatch } from "../api";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Progress } from "./ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { cn } from "./ui/utils";

type TaskStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

const filterModes = [
  {
    id: "hotspot_light",
    label: "轻量级热力图",
    desc: "基础位置数据，处理速度快。",
    interval: 30,
  },
  {
    id: "zone_only",
    label: "缩圈预测优先",
    desc: "只保留圈阶段数据，适合快速补充预测样本。",
    interval: 60,
  },
  {
    id: "full",
    label: "全量分析",
    desc: "包含所有遥测数据，占用存储空间大。",
    interval: 5,
  },
] as const;

type FilterMode = (typeof filterModes)[number]["id"];

function isTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function statusLabel(status: string | null | undefined) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "running") return "进行中";
  if (status === "cancelled") return "已取消";
  if (status === "pending") return "待处理";
  return "未知";
}

function compactDate(value: string | null) {
  if (!value) return "未知时间";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function DataCollection() {
  const [limit, setLimit] = useState(20);
  const [filterMode, setFilterMode] = useState<FilterMode>("hotspot_light");
  const [currentJob, setCurrentJob] = useState<IngestJob | null>(null);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedMode = useMemo(
    () => filterModes.find((mode) => mode.id === filterMode) ?? filterModes[0],
    [filterMode],
  );

  const taskStatus: TaskStatus = (currentJob?.status as TaskStatus | undefined) ?? "idle";
  const progress =
    currentJob && currentJob.total_count > 0
      ? Math.min(100, Math.round(((currentJob.success_count + currentJob.skipped_count + currentJob.failed_count) / currentJob.total_count) * 100))
      : currentJob?.status === "completed"
        ? 100
        : 0;

  const refreshMatches = async () => {
    setLoadingMatches(true);
    try {
      const response = await api.listMatches(50);
      setMatches(response.matches);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingMatches(false);
    }
  };

  useEffect(() => {
    void refreshMatches();
  }, []);

  useEffect(() => {
    if (!currentJob || isTerminal(currentJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await api.getIngestJob(currentJob.id);
        setCurrentJob(job);
        if (isTerminal(job.status)) void refreshMatches();
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [currentJob?.id, currentJob?.status]);

  const handleStart = async () => {
    setError(null);
    try {
      const job = await api.startSquadSampleIngest({
        maxMatches: limit,
        parseProfile: selectedMode.id,
        positionIntervalSeconds: selectedMode.interval,
      });
      setCurrentJob(job);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleStop = async () => {
    if (!currentJob) return;
    setError(null);
    try {
      setCurrentJob(await api.cancelIngestJob(currentJob.id));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleRetry = async () => {
    if (!currentJob) return;
    setError(null);
    try {
      setCurrentJob(await api.retryIngestJob(currentJob.id));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteMatch = async (matchId: string) => {
    setError(null);
    try {
      await api.deleteMatch(matchId);
      await refreshMatches();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <div className="dark flex h-full w-full flex-col gap-6 overflow-y-auto bg-background p-6 text-foreground lg:flex-row">
      <div className="flex w-full shrink-0 flex-col gap-6 lg:w-96">
        <Card className="border-border bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="size-5 text-blue-400" /> 发起采集任务
            </CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sample-limit">采集数量限制（场次）</Label>
              <Input
                id="sample-limit"
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>过滤模式</Label>
              <ToggleGroup
                type="single"
                value={filterMode}
                onValueChange={(value) => {
                  if (value) setFilterMode(value as FilterMode);
                }}
                className="flex w-full flex-col items-stretch gap-3"
                variant="outline"
              >
                {filterModes.map((mode) => (
                  <ToggleGroupItem
                    key={mode.id}
                    value={mode.id}
                    className={cn(
                      "h-auto justify-start rounded-lg px-3 py-3 text-left",
                      "data-[state=on]:border-blue-500 data-[state=on]:bg-blue-500/10",
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span
                        className={cn(
                          "text-sm font-medium",
                          filterMode === mode.id ? "text-blue-400" : "text-foreground",
                        )}
                      >
                        {mode.label}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">{mode.desc}</span>
                    </span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <Button
              disabled={taskStatus === "running"}
              onClick={handleStart}
              className="h-11 w-full"
            >
              <Play className="fill-current" data-icon="inline-start" /> 开始采集
            </Button>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-lg">当前任务</CardTitle>
            <div className="flex items-center gap-2">
              {taskStatus === "failed" && (
                <Button onClick={handleRetry} variant="outline" size="sm">
                  <RotateCcw data-icon="inline-start" /> 重试
                </Button>
              )}
              {taskStatus === "running" && (
                <Button onClick={handleStop} variant="destructive" size="sm">
                  <Square className="fill-current" data-icon="inline-start" /> 终止
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent>
            {!currentJob ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                暂无活动中的采集任务。
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 text-muted-foreground">
                    任务ID: <span className="font-mono">{currentJob.id}</span>
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {statusLabel(currentJob.status)} · {progress}%
                  </Badge>
                </div>
                <Progress value={progress} />
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-green-500" /> {currentJob.success_count} / {currentJob.total_count || limit} 场次
                  </div>
                  <div className="flex items-center gap-1.5">
                    <AlertCircle className="size-4 text-yellow-500" /> {currentJob.skipped_count} 跳过 · {currentJob.failed_count} 失败
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-[300px] flex-1 flex-col border-border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border">
            <CardTitle className="text-lg">已采集对局列表</CardTitle>
            <Button onClick={refreshMatches} variant="ghost" size="icon" title="刷新">
              {loadingMatches ? <RotateCcw className="animate-spin" /> : <Filter />}
            </Button>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-5">对局ID</TableHead>
                  <TableHead className="px-5">地图 / 模式</TableHead>
                  <TableHead className="px-5">遥测数据</TableHead>
                  <TableHead className="px-5">样本数</TableHead>
                  <TableHead className="px-5 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map((match) => (
                  <TableRow key={match.match_id}>
                    <TableCell className="px-5 font-mono text-muted-foreground">{match.match_id}</TableCell>
                    <TableCell className="px-5">
                      <div className="font-medium">{match.map_name ?? "未知地图"}</div>
                      <div className="text-xs text-muted-foreground">{match.game_mode ?? "未知模式"} · {compactDate(match.created_at)}</div>
                    </TableCell>
                    <TableCell className="px-5">
                      <Badge
                        variant={match.telemetry_parse_status === "failed" ? "destructive" : "secondary"}
                        className={cn(
                          match.telemetry_parse_status === "completed" && "bg-green-500/10 text-green-400",
                          match.telemetry_parse_status !== "completed" &&
                            match.telemetry_parse_status !== "failed" &&
                            "bg-yellow-500/10 text-yellow-500",
                        )}
                      >
                        {statusLabel(match.telemetry_parse_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-5">{(match.circle_phase_count + match.position_sample_count + match.life_event_count).toLocaleString()}</TableCell>
                    <TableCell className="px-5 text-right">
                      <Button onClick={() => handleDeleteMatch(match.match_id)} variant="ghost" size="icon" title="删除">
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {matches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                      还没有已入库对局。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
