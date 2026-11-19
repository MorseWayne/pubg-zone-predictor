import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Brain,
  CheckCircle2,
  Cpu,
  Layers,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { api, apiErrorMessage, HotspotResult, IngestMatch, MapConfig, ModelRun } from "../api";

const DATA_PREPARATION_STORAGE_KEY = "pubg-zone-predictor:data-preparation";

type PersistedPreparationState = {
  selectedMap?: string;
  phase?: number;
};

function readPersistedPreparationState(): PersistedPreparationState {
  if (typeof window === "undefined") return {};
  try {
    const rawValue = window.localStorage.getItem(DATA_PREPARATION_STORAGE_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue) as Record<string, unknown>;
    return {
      selectedMap: typeof parsedValue.selectedMap === "string" ? parsedValue.selectedMap : undefined,
      phase:
        typeof parsedValue.phase === "number" &&
        Number.isInteger(parsedValue.phase) &&
        parsedValue.phase >= 1 &&
        parsedValue.phase <= 8
          ? parsedValue.phase
          : undefined,
    };
  } catch {
    return {};
  }
}

function writePersistedPreparationState(state: Required<PersistedPreparationState>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DATA_PREPARATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is optional; preparation still works when browser storage is unavailable.
  }
}

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
  const [initialPreparationState] = useState(readPersistedPreparationState);
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [selectedMap, setSelectedMap] = useState(initialPreparationState.selectedMap ?? "erangel");
  const [phase, setPhase] = useState(initialPreparationState.phase ?? 1);
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

  useEffect(() => {
    writePersistedPreparationState({ selectedMap, phase });
  }, [selectedMap, phase]);

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
    <div className="flex h-full w-full flex-col gap-6 overflow-y-auto bg-body p-6 text-primary">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
          <Activity className="size-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">预测基建</h1>
          <p className="text-sm text-secondary">管理数据就绪状态和模型状态，以确保准确的战术预测。</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center rounded-xl border border-border bg-card p-4 shadow-sm">
        <Selector
          label="选择地图"
          isLabelHidden
          placeholder="选择地图"
          value={selectedMap}
          onChange={setSelectedMap}
          containerClassName="w-[180px]"
          options={maps.map((map) => ({ value: map.map_id, label: map.display_name }))}
        />

        <Button
          onClick={refreshOverview}
          className="sm:ml-auto"
          label="刷新状态"
          variant="secondary"
          icon={<RefreshCw data-icon="inline-start" />}
        />
      </div>

      {error && (
        <Banner status="error" role="alert" title="错误" description={error} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
          <header className="gap-1.5 px-5 pt-5 flex flex-row items-start justify-between space-y-0 pb-2">
            <div className="flex items-center gap-3">
              <div className="rounded border border-blue-500/20 bg-blue-500/10 p-2 text-blue-400">
                <Layers className="size-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <h3 className="text-base font-bold text-primary">热力图数据</h3>
                <p className="text-sm text-secondary text-xs">空间密度映射</p>
              </div>
            </div>
            {hotspotReady ? (
              <Badge
                variant="neutral"
                className="bg-green-500/10 text-green-400 border-green-500/20"
                label={
                  <>
                    <CheckCircle2 /> 已生成
                  </>
                }
              />
            ) : (
              <Badge
                variant="neutral"
                className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                label={
                  <>
                    <ShieldAlert /> 未生成
                  </>
                }
              />
            )}
          </header>
          <div className="px-5 pb-5 mt-2 flex flex-1 flex-col gap-4 text-sm text-secondary">
            <p>
              基于已采集对局生成高危区域。当前可用样本约 {sampleCount.toLocaleString()} 条。
              {latestHotspot && ` 本次生成 ${latestHotspot.tiles.length} 个热点网格。`}
            </p>
            <div className="flex flex-col gap-2 rounded-lg border border-border/80 bg-body/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium text-primary">热力图阶段</p>
                <p className="text-xs text-secondary">只影响本卡片生成的历史热点数据。</p>
              </div>
              <Selector
                label="选择阶段"
                isLabelHidden
                placeholder="选择阶段"
                value={String(phase)}
                onChange={(val) => setPhase(Number(val))}
                containerClassName="w-full sm:w-[160px]"
                options={[1, 2, 3, 4, 5, 6, 7, 8].map((item) => ({
                  value: String(item),
                  label: `阶段 ${item}`,
                }))}
              />
            </div>
          </div>
          <footer className="flex items-center px-5 pb-5">
            <Button
              onClick={handleGenerate}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white"
              label={isGenerating ? "正在生成..." : "生成热力图"}
              variant="primary"
              isDisabled={isGenerating}
              isLoading={isGenerating}
            />
          </footer>
        </Card>

        <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
          <header className="gap-1.5 px-5 pt-5 flex flex-row items-start justify-between space-y-0 pb-2">
            <div className="flex items-center gap-3">
              <div className="rounded border border-purple-500/20 bg-purple-500/10 p-2 text-purple-400">
                <Brain className="size-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <h3 className="text-base font-bold text-primary">预测模型</h3>
                <p className="text-sm text-secondary text-xs">统计偏移基线模型</p>
              </div>
            </div>
            {modelReady ? (
              <Badge
                variant="neutral"
                className="bg-green-500/10 text-green-400 border-green-500/20"
                label={
                  <>
                    <CheckCircle2 /> 已激活
                  </>
                }
              />
            ) : (
              <Badge
                variant="neutral"
                className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                label={
                  <>
                    <ShieldAlert /> 需要训练
                  </>
                }
              />
            )}
          </header>
          <div className="px-5 pb-5 text-sm text-secondary mt-2 flex-1">
            {activeRun
              ? `最近模型 ${activeRun.id.slice(0, 14)} 使用 ${activeRun.sample_count.toLocaleString()} 条圈样本。`
              : "还没有完成的模型训练，预测会使用规则回退。"}
            {activeRun && (
              <div className="mt-2 text-xs text-secondary">
                算法: {activeRun.algorithm}
              </div>
            )}
            {meanValidationError !== null && (
              <div className="mt-2 text-xs text-secondary">
                验证误差: {Math.round(meanValidationError).toLocaleString()} m
              </div>
            )}
          </div>
          <footer className="flex items-center px-5 pb-5">
            <Button
              onClick={handleTrain}
              className="w-full bg-purple-600 hover:bg-purple-500 text-white"
              label={isTraining ? "正在训练..." : "训练模型"}
              variant="primary"
              isDisabled={isTraining}
              isLoading={isTraining}
            />
          </footer>
        </Card>
      </div>

      <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm mt-2">
        <header className="grid gap-1.5 px-5 pt-5">
          <h3 className="text-sm font-bold text-primary flex items-center gap-2">
            <Cpu className="size-4 text-secondary" /> 系统总览
          </h3>
        </header>
        <div className="px-5 pb-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card padding={0} className="flex flex-col gap-4 bg-muted/30 border-border p-4">
              <div className="text-xs text-secondary mb-1">总对局数</div>
              <div className="text-xl font-bold text-primary">{matches.length.toLocaleString()}</div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 bg-muted/30 border-border p-4">
              <div className="text-xs text-secondary mb-1">总样本数</div>
              <div className="text-xl font-bold text-primary">{sampleCount.toLocaleString()}</div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 bg-muted/30 border-border p-4">
              <div className="text-xs text-secondary mb-1">模型评分</div>
              <div className="text-xl font-bold text-green-400">{formatAccuracy(activeRun)}</div>
            </Card>
            <Card padding={0} className="flex flex-col gap-4 bg-muted/30 border-border p-4">
              <div className="text-xs text-secondary mb-1">规则回退</div>
              <div className="text-xl font-bold text-yellow-500">{modelReady ? "可用" : "启用"}</div>
            </Card>
          </div>

          {!modelReady && (
            <Banner
              className="mt-4 border-orange-500/20 bg-orange-500/10 text-orange-200"
              status="info"
              title="规则回退已激活"
              description="如果在模型更新之前请求预测，系统将暂时依赖后端规则基线，并在响应 warnings 中标记原因。"
            />
          )}
        </div>
      </Card>
    </div>
  );
}
