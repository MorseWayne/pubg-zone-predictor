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

function latestCompletedRun(runs: ModelRun[]) {
  return runs.find((run) => run.status === "completed") ?? null;
}

function formatAccuracy(run: ModelRun | null) {
  if (!run || run.metrics.length === 0) return "暂无";
  const meanError = run.metrics.reduce((sum, metric) => sum + metric.mean_center_error, 0) / run.metrics.length;
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
    <div className="flex flex-col h-full w-full bg-neutral-950 p-6 gap-6 overflow-y-auto">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
          <Activity className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">预测基建</h1>
          <p className="text-sm text-neutral-400">管理数据就绪状态和模型状态，以确保准确的战术预测。</p>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
        <select
          value={selectedMap}
          onChange={(event) => setSelectedMap(event.target.value)}
          className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
        >
          {maps.map((map) => (
            <option key={map.map_id} value={map.map_id}>{map.display_name}</option>
          ))}
        </select>
        <select
          value={phase}
          onChange={(event) => setPhase(Number(event.target.value))}
          className="bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((item) => (
            <option key={item} value={item}>阶段 {item}</option>
          ))}
        </select>
        <button onClick={refreshOverview} className="sm:ml-auto px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm flex items-center justify-center gap-2">
          <RefreshCw className="w-4 h-4" /> 刷新状态
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-lg text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col gap-4">
          <div className="flex justify-between items-start">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded border border-blue-500/20 text-blue-400">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-neutral-200">热力图数据</h3>
                <p className="text-xs text-neutral-500">空间密度映射</p>
              </div>
            </div>
            {hotspotReady ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded">
                <CheckCircle2 className="w-3.5 h-3.5" /> 已生成
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                <ShieldAlert className="w-3.5 h-3.5" /> 未生成
              </span>
            )}
          </div>

          <div className="text-sm text-neutral-400 mt-2 flex-1">
            基于已采集对局生成高危区域。当前可用样本约 {sampleCount.toLocaleString()} 条。
            {latestHotspot && ` 本次生成 ${latestHotspot.tiles.length} 个热点网格。`}
          </div>

          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className={`w-full py-2.5 rounded-lg text-sm font-bold flex justify-center items-center gap-2 transition-all ${isGenerating ? "bg-neutral-800 text-neutral-400" : "bg-blue-600 hover:bg-blue-500 text-white"}`}
          >
            {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : "生成热力图"}
          </button>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col gap-4">
          <div className="flex justify-between items-start">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/10 rounded border border-purple-500/20 text-purple-400">
                <Brain className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-neutral-200">预测模型</h3>
                <p className="text-xs text-neutral-500">统计偏移基线模型</p>
              </div>
            </div>
            {modelReady ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded">
                <CheckCircle2 className="w-3.5 h-3.5" /> 已激活
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                <ShieldAlert className="w-3.5 h-3.5" /> 需要训练
              </span>
            )}
          </div>

          <div className="text-sm text-neutral-400 mt-2 flex-1">
            {activeRun
              ? `最近模型 ${activeRun.id.slice(0, 14)} 使用 ${activeRun.sample_count.toLocaleString()} 条圈样本。`
              : "还没有完成的模型训练，预测会使用规则回退。"}
          </div>

          <button
            onClick={handleTrain}
            disabled={isTraining}
            className={`w-full py-2.5 rounded-lg text-sm font-bold flex justify-center items-center gap-2 transition-all ${isTraining ? "bg-neutral-800 text-neutral-400" : "bg-purple-600 hover:bg-purple-500 text-white"}`}
          >
            {isTraining ? <RefreshCw className="w-4 h-4 animate-spin" /> : "训练模型"}
          </button>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mt-2">
        <h3 className="text-sm font-bold text-neutral-200 mb-4 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-neutral-400" /> 系统总览
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">总对局数</div>
            <div className="text-xl font-bold text-white">{matches.length.toLocaleString()}</div>
          </div>
          <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">总样本数</div>
            <div className="text-xl font-bold text-white">{sampleCount.toLocaleString()}</div>
          </div>
          <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">模型评分</div>
            <div className="text-xl font-bold text-green-400">{formatAccuracy(activeRun)}</div>
          </div>
          <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
            <div className="text-xs text-neutral-500 mb-1">规则回退</div>
            <div className="text-xl font-bold text-yellow-500">{modelReady ? "可用" : "启用"}</div>
          </div>
        </div>

        {!modelReady && (
          <div className="mt-4 bg-orange-500/10 border border-orange-500/20 p-4 rounded-lg text-sm text-orange-200 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-orange-400 shrink-0" />
            <div>
              <strong className="block text-orange-400 mb-1">规则回退已激活</strong>
              如果在模型更新之前请求预测，系统将暂时依赖后端规则基线，并在响应 warnings 中标记原因。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
