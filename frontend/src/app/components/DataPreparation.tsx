import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Brain,
  CheckCircle2,
  Cpu,
  Layers,
  RefreshCw,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { api, apiErrorMessage, HotspotResult, IngestMatch, MapConfig, ModelRun } from "../api";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";

function latestCompletedRun(runs: ModelRun[]) {
  return runs.find((run) => run.status === "completed") ?? null;
}

function formatAccuracy(run: ModelRun | null) {
  if (!run || run.metrics.length === 0) return "暂无";
  const validationMetrics = run.metrics.filter((metric) => metric.split === "validation");
  const scoringMetrics = validationMetrics.length > 0 ? validationMetrics : run.metrics;
  const meanError =
    scoringMetrics.reduce((sum, metric) => sum + metric.mean_center_error, 0) /
    scoringMetrics.length;
  const score = Math.max(0, Math.min(100, 100 - meanError / 8000));
  return `${score.toFixed(1)}%`;
}

export function DataPreparation() {
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [selectedMap, setSelectedMap] = useState("erangel");
  const [phase, setPhase] = useState(1);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [runs, setRuns] = useState<ModelRun[]>([]);
  const [latestHotspot, setLatestHotspot] = useState<HotspotResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRun = useMemo(() => latestCompletedRun(runs), [runs]);
  const hotspotReady = latestHotspot !== null;
  const modelReady = activeRun !== null;
  const validationMetrics = activeRun?.metrics.filter((metric) => metric.split === "validation") ?? [];
  const meanValidationError =
    validationMetrics.length > 0
      ? validationMetrics.reduce((sum, metric) => sum + metric.mean_center_error, 0) /
        validationMetrics.length
      : null;
  const sampleCount = matches.reduce(
    (sum, match) => sum + match.circle_phase_count + match.position_sample_count + match.life_event_count,
    0,
  );

  const refreshOverview = async () => {
    try {
      const [mapsResponse, matchesResponse, runsResponse] = await Promise.all([
        api.listMaps(),
        api.listMatches(100),
        api.listTrainingRuns(20),
      ]);
      setMaps(mapsResponse.maps);
      setMatches(matchesResponse.matches);
      setRuns(runsResponse.runs);
      if (!mapsResponse.maps.some((map) => map.map_id === selectedMap) && mapsResponse.maps[0]) {
        setSelectedMap(mapsResponse.maps[0].map_id);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  useEffect(() => {
    void refreshOverview();
  }, []);

  const handleGenerate = async () => {
    setError(null);
    setIsGenerating(true);
    try {
      setLatestHotspot(await api.generateHotspots(selectedMap, phase));
      await refreshOverview();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTrain = async () => {
    setError(null);
    setIsTraining(true);
    try {
      const run = await api.trainModel(selectedMap);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setIsTraining(false);
    }
  };

  return (
    <div className="dark flex h-full w-full flex-col gap-6 overflow-y-auto bg-background p-6 text-foreground">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
          <Activity className="size-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">预测基建</h1>
          <p className="text-sm text-muted-foreground">管理数据就绪状态和模型状态，以确保准确的战术预测。</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center rounded-xl border border-border bg-card p-4 shadow-sm">
        <Select value={selectedMap} onValueChange={setSelectedMap}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="选择地图" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {maps.map((map) => (
                <SelectItem key={map.map_id} value={map.map_id}>
                  {map.display_name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Button variant="outline" onClick={refreshOverview} className="sm:ml-auto">
          <RefreshCw data-icon="inline-start" />
          刷新状态
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>错误</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="flex flex-col border-border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <div className="flex items-center gap-3">
              <div className="rounded border border-blue-500/20 bg-blue-500/10 p-2 text-blue-400">
                <Layers className="size-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <CardTitle className="text-base font-bold text-foreground">热力图数据</CardTitle>
                <CardDescription className="text-xs text-muted-foreground">空间密度映射</CardDescription>
              </div>
            </div>
            {hotspotReady ? (
              <Badge variant="secondary" className="bg-green-500/10 text-green-400 border-green-500/20">
                <CheckCircle2 /> 已生成
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                <ShieldAlert /> 未生成
              </Badge>
            )}
          </CardHeader>
          <CardContent className="mt-2 flex flex-1 flex-col gap-4 text-sm text-muted-foreground">
            <p>
              基于已采集对局生成高危区域。当前可用样本约 {sampleCount.toLocaleString()} 条。
              {latestHotspot && ` 本次生成 ${latestHotspot.tiles.length} 个热点网格。`}
            </p>
            <div className="flex flex-col gap-2 rounded-lg border border-border/80 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium text-foreground">热力图阶段</p>
                <p className="text-xs text-muted-foreground">只影响本卡片生成的历史热点数据。</p>
              </div>
              <Select value={String(phase)} onValueChange={(val) => setPhase(Number(val))}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue placeholder="选择阶段" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((item) => (
                      <SelectItem key={item} value={String(item)}>
                        阶段 {item}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white"
            >
              {isGenerating ? (
                <>
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                  正在生成...
                </>
              ) : (
                "生成热力图"
              )}
            </Button>
          </CardFooter>
        </Card>

        <Card className="flex flex-col border-border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <div className="flex items-center gap-3">
              <div className="rounded border border-purple-500/20 bg-purple-500/10 p-2 text-purple-400">
                <Brain className="size-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <CardTitle className="text-base font-bold text-foreground">预测模型</CardTitle>
                <CardDescription className="text-xs text-muted-foreground">统计偏移基线模型</CardDescription>
              </div>
            </div>
            {modelReady ? (
              <Badge variant="secondary" className="bg-green-500/10 text-green-400 border-green-500/20">
                <CheckCircle2 /> 已激活
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                <ShieldAlert /> 需要训练
              </Badge>
            )}
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground mt-2 flex-1">
            {activeRun
              ? `最近模型 ${activeRun.id.slice(0, 14)} 使用 ${activeRun.sample_count.toLocaleString()} 条圈样本。`
              : "还没有完成的模型训练，预测会使用规则回退。"}
            {activeRun && (
              <div className="mt-2 text-xs text-muted-foreground">
                算法: {activeRun.algorithm}
              </div>
            )}
            {meanValidationError !== null && (
              <div className="mt-2 text-xs text-muted-foreground">
                验证误差: {Math.round(meanValidationError).toLocaleString()} m
              </div>
            )}
          </CardContent>
          <CardFooter>
            <Button
              onClick={handleTrain}
              disabled={isTraining}
              className="w-full bg-purple-600 hover:bg-purple-500 text-white"
            >
              {isTraining ? (
                <>
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                  正在训练...
                </>
              ) : (
                "训练模型"
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>

      <Card className="border-border bg-card shadow-sm mt-2">
        <CardHeader>
          <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
            <Cpu className="size-4 text-muted-foreground" /> 系统总览
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-muted/30 border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">总对局数</div>
              <div className="text-xl font-bold text-foreground">{matches.length.toLocaleString()}</div>
            </Card>
            <Card className="bg-muted/30 border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">总样本数</div>
              <div className="text-xl font-bold text-foreground">{sampleCount.toLocaleString()}</div>
            </Card>
            <Card className="bg-muted/30 border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">模型评分</div>
              <div className="text-xl font-bold text-green-400">{formatAccuracy(activeRun)}</div>
            </Card>
            <Card className="bg-muted/30 border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">规则回退</div>
              <div className="text-xl font-bold text-yellow-500">{modelReady ? "可用" : "启用"}</div>
            </Card>
          </div>

          {!modelReady && (
            <Alert className="mt-4 border-orange-500/20 bg-orange-500/10 text-orange-200">
              <ShieldAlert className="text-orange-400" />
              <AlertTitle className="text-orange-400">规则回退已激活</AlertTitle>
              <AlertDescription>
                如果在模型更新之前请求预测，系统将暂时依赖后端规则基线，并在响应 warnings 中标记原因。
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
