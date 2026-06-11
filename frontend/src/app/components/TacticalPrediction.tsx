import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Crosshair,
  MapPin,
  Play,
  Route as RouteIcon,
  Settings2,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { api, apiErrorMessage, MapConfig, PredictResponse, ZonePhaseConfig } from "../api";
import { MapView } from "./MapView";

type MapMode = "center" | "team";
type PredictionState = "idle" | "loading" | "success" | "error";
export type Point = { x: number; y: number };

const MAP_VIEW_SIZE = 1000;
const strategyOptions = [
  { id: "edge", label: "边缘进圈", apiValue: "edge" },
  { id: "center", label: "中心直扎", apiValue: "center" },
  { id: "slow", label: "慢打进圈", apiValue: "slow" },
  { id: "avoid", label: "避战绕行", apiValue: "avoid_hotspots" },
] as const;

function mapPointToWorld(point: Point, worldSize: number) {
  return {
    x: (point.x / MAP_VIEW_SIZE) * worldSize,
    y: (point.y / MAP_VIEW_SIZE) * worldSize,
  };
}

function meters(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}km`;
  return `${Math.round(value)}m`;
}

function percentScore(score: number) {
  return Math.round(score * 100);
}

export function TacticalPrediction() {
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [zoneConfig, setZoneConfig] = useState<ZonePhaseConfig | null>(null);
  const [selectedMap, setSelectedMap] = useState("miramar");
  const [zoneStage, setZoneStage] = useState(1);
  const [mapMode, setMapMode] = useState<MapMode>("center");
  const [zoneCenter, setZoneCenter] = useState<Point | null>(null);
  const [teamPos, setTeamPos] = useState<Point | null>(null);
  const [strategy, setStrategy] = useState("edge");
  const [smartExplain, setSmartExplain] = useState(true);
  const [predState, setPredState] = useState<PredictionState>("idle");
  const [prediction, setPrediction] = useState<PredictResponse | null>(null);
  const [mapImageUrl, setMapImageUrl] = useState(api.mapImageUrl("miramar"));
  const [error, setError] = useState<string | null>(null);

  const currentMap = useMemo(
    () => maps.find((map) => map.map_id === selectedMap) ?? null,
    [maps, selectedMap],
  );
  const worldSize = currentMap?.world_size ?? 816000;
  const supportedPhases = zoneConfig?.supported_prediction_phases ?? [1, 2, 3, 4, 5, 6, 7];
  const maxPhase = Math.max(...supportedPhases);
  const currentRadius = zoneConfig?.phases.find((phase) => phase.phase === zoneStage)?.radius ?? 400000;
  const strategyApiValue = strategyOptions.find((item) => item.id === strategy)?.apiValue ?? "edge";

  useEffect(() => {
    const loadMaps = async () => {
      try {
        const response = await api.listMaps();
        setMaps(response.maps);
        if (response.maps.some((map) => map.map_id === selectedMap)) return;
        if (response.maps[0]) setSelectedMap(response.maps[0].map_id);
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    };
    void loadMaps();
  }, []);

  useEffect(() => {
    const loadZoneConfig = async () => {
      try {
        const response = await api.getZonePhases(selectedMap);
        setZoneConfig(response);
        if (!response.supported_prediction_phases.includes(zoneStage)) {
          setZoneStage(response.supported_prediction_phases[0] ?? 1);
        }
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    };
    void loadZoneConfig();
  }, [selectedMap]);

  useEffect(() => {
    const ensureMapImage = async () => {
      setMapImageUrl(api.mapImageUrl(selectedMap));
      try {
        const asset = await api.ensureMapAsset(selectedMap);
        setMapImageUrl(asset.image_url);
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    };
    void ensureMapImage();
  }, [selectedMap]);

  const handleMapClick = (p: Point) => {
    setPrediction(null);
    setPredState("idle");
    if (mapMode === "center") setZoneCenter(p);
    else setTeamPos(p);
  };

  const handleGenerate = async () => {
    if (!zoneCenter || !teamPos) return;
    setError(null);
    setPredState("loading");
    try {
      const result = await api.predictZone({
        map_id: selectedMap,
        current_phase: zoneStage,
        current_circle_center: mapPointToWorld(zoneCenter, worldSize),
        team_area: mapPointToWorld(teamPos, worldSize),
        route_strategy: strategyApiValue,
        use_llm_explanation: smartExplain,
      });
      setPrediction(result);
      setPredState("success");
    } catch (err) {
      setPrediction(null);
      setPredState("error");
      setError(apiErrorMessage(err));
    }
  };

  const isReady = zoneCenter !== null && teamPos !== null;

  return (
    <div className="flex h-full w-full">
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/80 p-5 flex flex-col gap-6 overflow-y-auto shrink-0 z-10 backdrop-blur-md">
        <section className="space-y-3">
          <label className="text-xs font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
            <Settings2 className="w-4 h-4" /> 环境设置
          </label>
          <div className="grid grid-cols-2 gap-2">
            {maps.map((map) => (
              <button
                key={map.map_id}
                onClick={() => {
                  setSelectedMap(map.map_id);
                  setPrediction(null);
                  setPredState("idle");
                }}
                className={`py-2 px-3 rounded text-sm font-medium transition-all border ${selectedMap === map.map_id ? "bg-orange-500/20 border-orange-500 text-orange-400" : "bg-neutral-800/50 border-neutral-700 text-neutral-300 hover:border-neutral-500"}`}
              >
                {map.display_name}
              </button>
            ))}
          </div>

          <div className="pt-2">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-neutral-300">当前安全区</span>
              <span className="text-sm font-bold text-orange-400">阶段 {zoneStage}</span>
            </div>
            <input
              type="range"
              min={Math.min(...supportedPhases)}
              max={maxPhase}
              value={zoneStage}
              onChange={(e) => {
                setZoneStage(parseInt(e.target.value));
                setPrediction(null);
                setPredState("idle");
              }}
              className="w-full accent-orange-500"
            />
          </div>
        </section>

        <section className="space-y-3">
          <label className="text-xs font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
            <MapPin className="w-4 h-4" /> 定位
          </label>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setMapMode("center")}
              className={`flex items-center gap-3 p-3 rounded border text-left transition-all ${mapMode === "center" ? "bg-blue-500/10 border-blue-500 text-blue-400" : "bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:border-neutral-500"}`}
            >
              <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center shrink-0">
                <Crosshair className="w-4 h-4 text-blue-400" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">圈中心</div>
                <div className="text-xs opacity-70 truncate">{zoneCenter ? `${Math.round(zoneCenter.x)}, ${Math.round(zoneCenter.y)}` : "点击地图设置"}</div>
              </div>
              {zoneCenter && (
                <div onClick={(e) => { e.stopPropagation(); setZoneCenter(null); }} className="p-1 hover:bg-black/20 rounded">
                  <X className="w-4 h-4 opacity-50 hover:opacity-100" />
                </div>
              )}
            </button>

            <button
              onClick={() => setMapMode("team")}
              className={`flex items-center gap-3 p-3 rounded border text-left transition-all ${mapMode === "team" ? "bg-green-500/10 border-green-500 text-green-400" : "bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:border-neutral-500"}`}
            >
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                <MapPin className="w-4 h-4 text-green-400" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">队伍位置</div>
                <div className="text-xs opacity-70 truncate">{teamPos ? `${Math.round(teamPos.x)}, ${Math.round(teamPos.y)}` : "点击地图设置"}</div>
              </div>
              {teamPos && (
                <div onClick={(e) => { e.stopPropagation(); setTeamPos(null); }} className="p-1 hover:bg-black/20 rounded">
                  <X className="w-4 h-4 opacity-50 hover:opacity-100" />
                </div>
              )}
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <label className="text-xs font-bold text-neutral-400 uppercase tracking-wider flex items-center gap-2">
            <RouteIcon className="w-4 h-4" /> 策略
          </label>
          <div className="grid grid-cols-2 gap-2">
            {strategyOptions.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setStrategy(item.id);
                  setPrediction(null);
                  setPredState("idle");
                }}
                className={`py-2 px-3 rounded text-xs font-medium transition-all border ${strategy === item.id ? "bg-orange-500/20 border-orange-500 text-orange-400" : "bg-neutral-800/50 border-neutral-700 text-neutral-300 hover:border-neutral-500"}`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-3 mt-4 cursor-pointer group">
            <div className={`w-10 h-5 rounded-full transition-colors flex items-center px-1 ${smartExplain ? "bg-orange-500" : "bg-neutral-700"}`}>
              <div className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${smartExplain ? "translate-x-4.5" : "translate-x-0"}`} />
            </div>
            <input
              className="sr-only"
              type="checkbox"
              checked={smartExplain}
              onChange={(event) => setSmartExplain(event.target.checked)}
            />
            <span className="text-sm text-neutral-300 group-hover:text-white transition-colors">智能风险解析</span>
          </label>
        </section>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-lg text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="mt-auto pt-4 border-t border-neutral-800">
          <button
            disabled={!isReady || predState === "loading"}
            onClick={handleGenerate}
            className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-all ${!isReady ? "bg-neutral-800 text-neutral-500 cursor-not-allowed" : predState === "loading" ? "bg-orange-600/50 text-white cursor-wait" : "bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-900/50 hover:shadow-orange-500/20 hover:-translate-y-0.5"}`}
          >
            {predState === "loading" ? (
              <div className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            ) : (
              <><Play className="w-4 h-4 fill-current" /> 生成预测</>
            )}
          </button>
          {!isReady && <p className="text-xs text-center text-red-400 mt-2">请先设置圈中心和队伍位置</p>}
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden bg-neutral-900">
        <MapView
          selectedMap={selectedMap}
          mapMode={mapMode}
          zoneCenter={zoneCenter}
          teamPos={teamPos}
          onClick={handleMapClick}
          zoneStage={zoneStage}
          predState={predState}
          strategy={strategy}
          prediction={prediction}
          worldSize={worldSize}
          currentRadius={currentRadius}
          mapImageUrl={mapImageUrl}
        />

        <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-sm p-3 rounded border border-white/10 pointer-events-none">
          <div className="text-sm font-medium text-white mb-1">点击放置:</div>
          <div className="flex items-center gap-2 text-xs">
            <span className={mapMode === "center" ? "text-blue-400 font-bold" : "text-neutral-400"}>圈中心</span>
            <span className="text-neutral-600">/</span>
            <span className={mapMode === "team" ? "text-green-400 font-bold" : "text-neutral-400"}>队伍位置</span>
          </div>
        </div>
      </div>

      {predState === "success" && prediction && (
        <div className="w-80 border-l border-neutral-800 bg-neutral-900/90 p-5 flex flex-col gap-6 overflow-y-auto shrink-0 z-10 backdrop-blur-md shadow-[-10px_0_30px_rgba(0,0,0,0.5)] animate-in slide-in-from-right duration-300">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2 text-orange-400 mb-1">
              <Sparkles className="w-5 h-5" /> 战术评估
            </h2>
            <div className="text-xs text-neutral-400">模型来源: {prediction.next_circle.source}</div>
          </div>

          <div className="space-y-4">
            <div className="bg-neutral-800/50 p-4 rounded-lg border border-neutral-700/50">
              <div className="text-xs text-neutral-400 mb-1">下个安全区 (阶段 {prediction.next_circle.phase})</div>
              <div className="flex justify-between items-baseline">
                <div className="text-lg font-medium text-blue-300">
                  {Math.round(prediction.next_circle.center.x)}, {Math.round(prediction.next_circle.center.y)}
                </div>
                <div className="text-xs text-blue-400/70">半径: {meters(prediction.next_circle.radius)}</div>
              </div>
            </div>

            <div className="bg-neutral-800/50 p-4 rounded-lg border border-neutral-700/50">
              <div className="text-xs text-neutral-400 mb-1">预测决赛圈</div>
              <div className="flex justify-between items-baseline">
                <div className="text-lg font-medium text-purple-300">
                  {Math.round(prediction.final_circle.center.x)}, {Math.round(prediction.final_circle.center.y)}
                </div>
                <div className="text-xs text-purple-400/70">样本: {prediction.final_circle.sample_count ?? "规则"}</div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
                <RouteIcon className="w-4 h-4 text-orange-400" /> 路线分析
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-neutral-800 p-3 rounded flex flex-col">
                  <span className="text-xs text-neutral-500">路线评分</span>
                  <span className="text-xl font-bold text-green-400">{percentScore(prediction.route.route_score)}/100</span>
                </div>
                <div className="bg-neutral-800 p-3 rounded flex flex-col">
                  <span className="text-xs text-neutral-500">距离</span>
                  <span className="text-xl font-bold text-neutral-200">{meters(prediction.route.risk_summary.distance)}</span>
                </div>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <h3 className="text-sm font-medium text-neutral-300 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-red-400" /> 风险评估
              </h3>

              <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-lg text-sm text-red-200">
                <div className="font-medium text-red-400 mb-1 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> 热点风险：{prediction.route.risk_summary.hotspot_risk}
                </div>
                <p className="text-xs opacity-80 leading-relaxed">
                  热点分数 {prediction.route.risk_summary.hotspot_score.toFixed(2)}。
                  {prediction.hotspot_summary.available ? ` 基于 ${prediction.hotspot_summary.top_tiles.length} 个历史热点网格。` : " 当前阶段暂无热点数据。"}
                </p>
              </div>

              {smartExplain && (
                <div className="bg-neutral-800 p-3 rounded-lg text-sm text-neutral-300">
                  <p className="text-xs leading-relaxed">
                    <strong className="text-orange-400">策略分析:</strong> {prediction.explanation.text}
                  </p>
                </div>
              )}

              {prediction.warnings.length > 0 && (
                <div className="text-xs text-yellow-500 flex items-start gap-2">
                  <ChevronRight className="w-4 h-4 shrink-0" />
                  {prediction.warnings.join(" · ")}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
