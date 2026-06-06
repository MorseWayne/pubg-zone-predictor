import { useEffect, useMemo, useState } from "react";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; service: string; version: string; environment: string }
  | { status: "error"; message: string };

type LoadState =
  | { status: "idle" | "loading" | "ready" }
  | { status: "error"; message: string };

type CoordinateConfig = {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
  y_axis?: "down" | "up";
};

type MapConfig = {
  map_id: string;
  display_name: string;
  world_size: number;
  coordinate: CoordinateConfig;
};

type PhaseConfig = {
  phase: number;
  radius: number;
  label: string;
  enabled: boolean;
  is_final_candidate: boolean;
};

type ZoneConfig = {
  map_id: string;
  final_phase: number;
  supported_prediction_phases: number[];
  phases: PhaseConfig[];
};

type Point = { x: number; y: number };

type PredictedCircle = {
  phase: number;
  center: Point;
  radius: number;
  source: string;
  sample_count: number | null;
};

type PredictionResult = {
  map_id: string;
  current_phase: number;
  next_circle: PredictedCircle;
  final_circle: PredictedCircle;
  route: {
    strategy: RouteStrategy;
    target: Point;
    waypoints: Point[];
    route_score: number;
    risk_summary: {
      hotspot_risk: "low" | "medium" | "high" | string;
      hotspot_score: number;
      distance: number;
    };
  };
  hotspot_summary: {
    phase: number;
    available: boolean;
    generated_at: string | null;
    grid_size: number;
    top_tiles: Array<{
      tile_x: number;
      tile_y: number;
      hotspot_score: number;
      density_score: number;
      kill_death_score: number;
      sample_count: number;
    }>;
    max_hotspot_score: number;
    warnings: string[];
  };
  explanation: { source: "llm" | "rule_fallback" | string; text: string };
  model_run_id: string | null;
  warnings: string[];
};

type HotspotGenerateResult = {
  map_id: string;
  phase: number;
  grid_size: number;
  generated_at: string | null;
  summary: {
    effective_match_count: number;
    effective_team_count: number;
    tile_count: number;
    max_sample_count: number;
  };
  tiles: Array<{
    tile_x: number;
    tile_y: number;
    density_score: number;
    kill_death_score: number;
    hotspot_score: number;
    sample_count: number;
  }>;
  warnings: string[];
};

type TrainingRunResult = {
  id: string;
  created_at: string;
  maps_included: string[];
  phases_included: number[];
  sample_count: number;
  algorithm: string;
  model_path: string | null;
  status: string;
  metrics: Array<{
    map_id: string;
    current_phase: number;
    target_type: string;
    sample_count: number;
    mean_center_error: number;
    median_center_error: number;
    p90_center_error: number | null;
  }>;
  warnings: string[];
};

type RouteStrategy = "edge" | "center" | "slow" | "avoid_hotspots";
type ClickMode = "current_circle_center" | "team_area";

const routeStrategies: Array<{ value: RouteStrategy; label: string; description: string }> = [
  { value: "edge", label: "贴边进圈", description: "目标点偏向预测安全区边缘。" },
  { value: "center", label: "抢中心", description: "目标点靠近预测下一圈中心。" },
  { value: "slow", label: "慢进圈", description: "先经过观察点，再进入预测安全区。" },
  { value: "avoid_hotspots", label: "绕路避战", description: "优先避开历史高活动区域。" },
];

const clickModes: Array<{ value: ClickMode; label: string }> = [
  { value: "current_circle_center", label: "设置当前圈中心" },
  { value: "team_area", label: "设置战队位置" },
];

export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [mapsState, setMapsState] = useState<LoadState>({ status: "loading" });
  const [selectedMapId, setSelectedMapId] = useState("erangel");
  const [zoneConfig, setZoneConfig] = useState<ZoneConfig | null>(null);
  const [zoneState, setZoneState] = useState<LoadState>({ status: "idle" });
  const [assetState, setAssetState] = useState<LoadState>({ status: "idle" });
  const [assetImageUrl, setAssetImageUrl] = useState<string | null>(null);
  const [currentPhase, setCurrentPhase] = useState(1);
  const [clickMode, setClickMode] = useState<ClickMode>("current_circle_center");
  const [currentCircleCenter, setCurrentCircleCenter] = useState<Point | null>(null);
  const [teamArea, setTeamArea] = useState<Point | null>(null);
  const [routeStrategy, setRouteStrategy] = useState<RouteStrategy>("edge");
  const [useLlmExplanation, setUseLlmExplanation] = useState(false);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [predictState, setPredictState] = useState<LoadState>({ status: "idle" });
  const [predictError, setPredictError] = useState<string | null>(null);
  const [hotspotRunState, setHotspotRunState] = useState<LoadState>({ status: "idle" });
  const [hotspotResult, setHotspotResult] = useState<HotspotGenerateResult | null>(null);
  const [trainingRunState, setTrainingRunState] = useState<LoadState>({ status: "idle" });
  const [trainingResult, setTrainingResult] = useState<TrainingRunResult | null>(null);

  const selectedMap = useMemo(
    () => maps.find((map) => map.map_id === selectedMapId) ?? null,
    [maps, selectedMapId],
  );
  const currentPhaseConfig = zoneConfig?.phases.find((phase) => phase.phase === currentPhase);
  const mapReady = assetState.status === "ready" && Boolean(assetImageUrl) && Boolean(selectedMap);
  const canPredict = Boolean(mapReady && currentCircleCenter && teamArea && zoneConfig);
  const hotspotReadiness = hotspotResult
    ? hotspotResult.warnings.length > 0
      ? "generated_with_warnings"
      : "ready"
    : hotspotRunState.status === "error"
      ? "error"
      : "missing";
  const modelReadiness = trainingResult
    ? trainingResult.status === "completed"
      ? "completed"
      : trainingResult.status
    : trainingRunState.status === "error"
      ? "error"
      : "not_trained";

  useEffect(() => {
    let cancelled = false;

    fetchJson<{ service: string; version: string; environment: string }>("/api/health")
      .then((body) => {
        if (!cancelled) {
          setHealth({ status: "ok", ...body });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealth({
            status: "error",
            message: error instanceof Error ? error.message : "无法连接后端",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMapsState({ status: "loading" });

    fetchJson<{ maps: MapConfig[] }>("/api/config/maps")
      .then((body) => {
        if (cancelled) {
          return;
        }
        setMaps(body.maps);
        if (body.maps.length > 0 && !body.maps.some((map) => map.map_id === selectedMapId)) {
          setSelectedMapId(body.maps[0].map_id);
        }
        setMapsState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMapsState({
            status: "error",
            message: error instanceof Error ? error.message : "地图配置加载失败",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMapId]);

  useEffect(() => {
    if (!selectedMapId) {
      return;
    }
    let cancelled = false;
    setZoneState({ status: "loading" });
    setAssetState({ status: "loading" });
    setAssetImageUrl(null);
    setPrediction(null);
    setPredictError(null);
    setHotspotRunState({ status: "idle" });
    setHotspotResult(null);
    setTrainingRunState({ status: "idle" });
    setTrainingResult(null);

    fetchJson<ZoneConfig>(`/api/config/zone-phases?map_id=${encodeURIComponent(selectedMapId)}`)
      .then((body) => {
        if (cancelled) {
          return;
        }
        setZoneConfig(body);
        setCurrentPhase(body.supported_prediction_phases[0] ?? 1);
        setZoneState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setZoneState({
            status: "error",
            message: error instanceof Error ? error.message : "Zone 配置加载失败",
          });
        }
      });

    ensureMapAsset(selectedMapId)
      .then((imageUrl) => {
        if (!cancelled) {
          setAssetImageUrl(`${imageUrl}&cache_bust=${Date.now()}`);
          setAssetState({ status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssetState({
            status: "error",
            message: error instanceof Error ? error.message : "地图资源准备失败",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMapId]);

  function retryAssetLoad() {
    setAssetState({ status: "loading" });
    setAssetImageUrl(null);
    ensureMapAsset(selectedMapId)
      .then((imageUrl) => {
        setAssetImageUrl(`${imageUrl}&cache_bust=${Date.now()}`);
        setAssetState({ status: "ready" });
      })
      .catch((error: unknown) => {
        setAssetState({
          status: "error",
          message: error instanceof Error ? error.message : "地图资源准备失败",
        });
      });
  }

  function generateHotspots() {
    if (!zoneConfig) {
      return;
    }
    setHotspotRunState({ status: "loading" });

    fetchJson<HotspotGenerateResult>(
      `/api/hotspots/generate?map_id=${encodeURIComponent(selectedMapId)}&phase=${currentPhase}`,
      { method: "POST" },
    )
      .then((body) => {
        setHotspotResult(body);
        setHotspotRunState({ status: "ready" });
      })
      .catch((error: unknown) => {
        setHotspotRunState({
          status: "error",
          message: error instanceof Error ? error.message : "热点生成失败",
        });
      });
  }

  function trainCurrentMap() {
    setTrainingRunState({ status: "loading" });

    fetchJson<TrainingRunResult>(
      `/api/training/runs?map_id=${encodeURIComponent(selectedMapId)}`,
      { method: "POST" },
    )
      .then((body) => {
        setTrainingResult(body);
        if (body.status === "failed") {
          setTrainingRunState({ status: "error", message: "训练样本不足或训练失败" });
        } else {
          setTrainingRunState({ status: "ready" });
        }
      })
      .catch((error: unknown) => {
        setTrainingRunState({
          status: "error",
          message: error instanceof Error ? error.message : "模型训练失败",
        });
      });
  }

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!mapReady || !selectedMap) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const normalized = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
    const worldPoint = normalizedToWorld(normalized, selectedMap.coordinate);
    if (clickMode === "current_circle_center") {
      setCurrentCircleCenter(worldPoint);
      setClickMode("team_area");
    } else {
      setTeamArea(worldPoint);
    }
  }

  function submitPrediction() {
    if (!canPredict || !currentCircleCenter || !teamArea) {
      return;
    }
    setPredictState({ status: "loading" });
    setPredictError(null);

    fetchJson<PredictionResult>("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        map_id: selectedMapId,
        current_phase: currentPhase,
        current_circle_center: currentCircleCenter,
        team_area: teamArea,
        route_strategy: routeStrategy,
        use_llm_explanation: useLlmExplanation,
      }),
    })
      .then((body) => {
        setPrediction(body);
        setPredictState({ status: "ready" });
      })
      .catch((error: unknown) => {
        setPredictState({ status: "error", message: "预测失败" });
        setPredictError(error instanceof Error ? error.message : "预测失败");
      });
  }

  return (
    <main className="app-shell">
      <section className="hero-panel compact">
        <div>
          <p className="eyebrow">Local analysis workspace</p>
          <h1>PUBG 圈型预测工作台</h1>
          <p className="lede">选择地图和当前局势，在底图上标注圈中心与战队位置，生成圈型预测、宏观路线和解释。</p>
        </div>
        <HealthBadge health={health} />
      </section>

      <section className="workspace-grid">
        <div className="map-card">
          <div className="map-toolbar">
            <div>
              <strong>{selectedMap?.display_name ?? "地图加载中"}</strong>
              <span>{mapReady ? "底图已就绪" : "底图未就绪，地图交互已禁用"}</span>
            </div>
            <div className="mode-switch" role="group" aria-label="地图点击模式">
              {clickModes.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={clickMode === mode.value ? "active" : ""}
                  disabled={!mapReady}
                  onClick={() => setClickMode(mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className={`map-frame ${mapReady ? "ready" : "disabled"}`} onClick={handleMapClick}>
            {assetImageUrl ? <img src={assetImageUrl} alt={`${selectedMap?.display_name ?? "PUBG"} 地图`} /> : null}
            {selectedMap ? (
              <MapOverlay
                map={selectedMap}
                currentPhaseRadius={currentPhaseConfig?.radius ?? 0}
                currentCircleCenter={currentCircleCenter}
                teamArea={teamArea}
                prediction={prediction}
              />
            ) : null}
            {!mapReady ? (
              <div className="map-blocker">
                <strong>{assetState.status === "error" ? "地图资源不可用" : "准备地图资源中…"}</strong>
                <span>
                  {assetState.status === "error"
                    ? assetState.message
                    : "底图加载完成后才能点击地图和生成预测。"}
                </span>
                {assetState.status === "error" ? (
                  <button type="button" onClick={retryAssetLoad}>
                    重试加载地图
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="control-panel prediction-panel">
          <h2>控制面板</h2>
          <StatusLine label="地图配置" state={mapsState} />
          <StatusLine label="Zone 配置" state={zoneState} />
          <StatusLine label="地图资源" state={assetState} />

          <DataPrepPanel
            hotspotReadiness={hotspotReadiness}
            modelReadiness={modelReadiness}
            hotspotRunState={hotspotRunState}
            hotspotResult={hotspotResult}
            trainingRunState={trainingRunState}
            trainingResult={trainingResult}
            canGenerateHotspots={Boolean(zoneConfig)}
            canTrain={Boolean(selectedMap)}
            onGenerateHotspots={generateHotspots}
            onTrain={trainCurrentMap}
          />

          <label>
            地图
            <select value={selectedMapId} onChange={(event) => setSelectedMapId(event.target.value)}>
              {maps.map((map) => (
                <option key={map.map_id} value={map.map_id}>
                  {map.display_name}
                </option>
              ))}
            </select>
          </label>

          <label>
            当前 Zone
            <select
              value={currentPhase}
              onChange={(event) => {
                setCurrentPhase(Number(event.target.value));
                setHotspotResult(null);
                setHotspotRunState({ status: "idle" });
              }}
              disabled={!zoneConfig}
            >
              {(zoneConfig?.supported_prediction_phases ?? [1]).map((phase) => (
                <option key={phase} value={phase}>
                  Zone {phase}
                </option>
              ))}
            </select>
          </label>

          <label>
            路线策略
            <select
              value={routeStrategy}
              onChange={(event) => setRouteStrategy(event.target.value as RouteStrategy)}
            >
              {routeStrategies.map((strategy) => (
                <option key={strategy.value} value={strategy.value}>
                  {strategy.label}
                </option>
              ))}
            </select>
            <small>{routeStrategies.find((strategy) => strategy.value === routeStrategy)?.description}</small>
          </label>

          <div className="coordinate-summary">
            <CoordinateReadout label="当前圈中心" point={currentCircleCenter} />
            <CoordinateReadout label="战队位置" point={teamArea} />
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={useLlmExplanation}
              onChange={(event) => setUseLlmExplanation(event.target.checked)}
            />
            尝试使用 LLM 解释
          </label>

          <button type="button" disabled={!canPredict || predictState.status === "loading"} onClick={submitPrediction}>
            {predictState.status === "loading" ? "生成中…" : "生成预测"}
          </button>

          {!canPredict ? <p className="hint">需先加载底图，并设置当前圈中心与战队位置。</p> : null}
          {canPredict && (hotspotReadiness !== "ready" || modelReadiness !== "completed") ? (
            <p className="hint">
              热点或模型尚未完全 ready，预测仍会运行，并在结果中标记无热点或规则兜底降级。
            </p>
          ) : null}
          {predictError ? <div className="error-panel">{predictError}</div> : null}

          <PredictionPanel prediction={prediction} />
        </aside>
      </section>
    </main>
  );
}

function DataPrepPanel({
  hotspotReadiness,
  modelReadiness,
  hotspotRunState,
  hotspotResult,
  trainingRunState,
  trainingResult,
  canGenerateHotspots,
  canTrain,
  onGenerateHotspots,
  onTrain,
}: {
  hotspotReadiness: string;
  modelReadiness: string;
  hotspotRunState: LoadState;
  hotspotResult: HotspotGenerateResult | null;
  trainingRunState: LoadState;
  trainingResult: TrainingRunResult | null;
  canGenerateHotspots: boolean;
  canTrain: boolean;
  onGenerateHotspots: () => void;
  onTrain: () => void;
}) {
  return (
    <section className="data-prep-panel">
      <div className="section-heading">
        <h3>数据准备</h3>
        <p>通过 FastAPI 生成热点和训练模型；缺数据时预测会自动降级。</p>
      </div>
      <div className="readiness-grid">
        <ReadinessBadge label="热点" value={hotspotReadiness} />
        <ReadinessBadge label="模型" value={modelReadiness} />
      </div>
      <div className="prep-actions">
        <button
          type="button"
          disabled={!canGenerateHotspots || hotspotRunState.status === "loading"}
          onClick={onGenerateHotspots}
        >
          {hotspotRunState.status === "loading" ? "生成热点中…" : "生成当前 Zone 热点"}
        </button>
        <button
          type="button"
          disabled={!canTrain || trainingRunState.status === "loading"}
          onClick={onTrain}
        >
          {trainingRunState.status === "loading" ? "训练中…" : "训练当前地图模型"}
        </button>
      </div>
      {hotspotRunState.status === "error" ? (
        <div className="error-panel compact">{hotspotRunState.message}</div>
      ) : null}
      {trainingRunState.status === "error" && !trainingResult ? (
        <div className="error-panel compact">{trainingRunState.message}</div>
      ) : null}
      {hotspotResult ? <HotspotPrepSummary result={hotspotResult} /> : null}
      {trainingResult ? <TrainingPrepSummary result={trainingResult} /> : null}
    </section>
  );
}

function ReadinessBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className={`readiness-badge ${value}`}>
      <span>{label}</span>
      <strong>{readinessLabel(value)}</strong>
    </div>
  );
}

function HotspotPrepSummary({ result }: { result: HotspotGenerateResult }) {
  return (
    <div className="prep-summary">
      <strong>热点生成结果</strong>
      <span>tiles：{result.summary.tile_count}</span>
      <span>matches：{result.summary.effective_match_count}</span>
      <span>teams：{result.summary.effective_team_count}</span>
      <WarningChips warnings={result.warnings} />
    </div>
  );
}

function TrainingPrepSummary({ result }: { result: TrainingRunResult }) {
  const firstMetric = result.metrics[0];
  return (
    <div className={`prep-summary ${result.status === "failed" ? "failed" : ""}`}>
      <strong>训练结果：{result.status}</strong>
      <span>samples：{result.sample_count}</span>
      <span>artifact：{result.model_path ? "已生成" : "无"}</span>
      {firstMetric ? (
        <span>
          {firstMetric.target_type} mean error：{formatNumber(firstMetric.mean_center_error)}
        </span>
      ) : null}
      <WarningChips warnings={result.warnings} />
    </div>
  );
}

function WarningChips({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className="warning-list compact">
      {warnings.map((warning) => (
        <span key={warning}>{warning}</span>
      ))}
    </div>
  );
}

function MapOverlay({
  map,
  currentPhaseRadius,
  currentCircleCenter,
  teamArea,
  prediction,
}: {
  map: MapConfig;
  currentPhaseRadius: number;
  currentCircleCenter: Point | null;
  teamArea: Point | null;
  prediction: PredictionResult | null;
}) {
  const routePoints = prediction?.route.waypoints.map((point) => worldToPercent(point, map.coordinate)) ?? [];

  return (
    <div className="map-overlay" aria-hidden="true">
      {prediction?.hotspot_summary.top_tiles.map((tile) => {
        const size = 100 / prediction.hotspot_summary.grid_size;
        return (
          <div
            key={`${tile.tile_x}-${tile.tile_y}`}
            className="hotspot-tile"
            style={{
              left: `${tile.tile_x * size}%`,
              top: `${tile.tile_y * size}%`,
              width: `${size}%`,
              height: `${size}%`,
              opacity: 0.18 + tile.hotspot_score * 0.42,
            }}
          />
        );
      })}

      {currentCircleCenter ? (
        <CircleOverlay
          className="current-circle"
          label="当前圈"
          center={currentCircleCenter}
          radius={currentPhaseRadius}
          map={map}
        />
      ) : null}
      {prediction ? (
        <>
          <CircleOverlay className="next-circle" label="下一圈" center={prediction.next_circle.center} radius={prediction.next_circle.radius} map={map} />
          <CircleOverlay className="final-circle" label="最终圈" center={prediction.final_circle.center} radius={prediction.final_circle.radius} map={map} />
          <svg className="route-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline points={routePoints.map((point) => `${point.x},${point.y}`).join(" ")} />
          </svg>
        </>
      ) : null}
      {currentCircleCenter ? <Marker className="current-marker" label="圈心" point={currentCircleCenter} map={map} /> : null}
      {teamArea ? <Marker className="team-marker" label="队伍" point={teamArea} map={map} /> : null}
    </div>
  );
}

function CircleOverlay({
  className,
  label,
  center,
  radius,
  map,
}: {
  className: string;
  label: string;
  center: Point;
  radius: number;
  map: MapConfig;
}) {
  const percent = worldToPercent(center, map.coordinate);
  const radiusPercent = (radius / (map.coordinate.max_x - map.coordinate.min_x)) * 100;
  return (
    <div
      className={`circle-overlay ${className}`}
      style={{
        left: `${percent.x - radiusPercent}%`,
        top: `${percent.y - radiusPercent}%`,
        width: `${radiusPercent * 2}%`,
        height: `${radiusPercent * 2}%`,
      }}
    >
      <span>{label}</span>
    </div>
  );
}

function Marker({ className, label, point, map }: { className: string; label: string; point: Point; map: MapConfig }) {
  const percent = worldToPercent(point, map.coordinate);
  return (
    <div className={`marker ${className}`} style={{ left: `${percent.x}%`, top: `${percent.y}%` }}>
      {label}
    </div>
  );
}

function PredictionPanel({ prediction }: { prediction: PredictionResult | null }) {
  if (!prediction) {
    return (
      <section className="result-panel empty">
        <h3>预测结果</h3>
        <p>生成预测后，这里会显示下一圈、最终圈、路线评分、风险和解释。</p>
      </section>
    );
  }

  return (
    <section className="result-panel">
      <h3>预测结果</h3>
      <div className="result-grid">
        <MetricCard title={`下一圈 Zone ${prediction.next_circle.phase}`} value={prediction.next_circle.source} detail={`半径 ${formatNumber(prediction.next_circle.radius)}`} />
        <MetricCard title={`最终圈 Zone ${prediction.final_circle.phase}`} value={prediction.final_circle.source} detail={`半径 ${formatNumber(prediction.final_circle.radius)}`} />
        <MetricCard title="路线评分" value={prediction.route.route_score.toFixed(2)} detail={`距离 ${formatNumber(prediction.route.risk_summary.distance)}`} />
        <MetricCard title="热点风险" value={prediction.route.risk_summary.hotspot_risk} detail={`score ${prediction.route.risk_summary.hotspot_score.toFixed(2)}`} />
      </div>
      {prediction.model_run_id ? <p className="model-id">模型：{prediction.model_run_id}</p> : <p className="model-id warning">模型：规则兜底</p>}
      {prediction.warnings.length > 0 ? (
        <div className="warning-list">
          <strong>Warnings</strong>
          {prediction.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
      <article className="explanation-card">
        <strong>解释来源：{prediction.explanation.source}</strong>
        <p>{prediction.explanation.text}</p>
      </article>
    </section>
  );
}

function MetricCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="metric-card">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function CoordinateReadout({ label, point }: { label: string; point: Point | null }) {
  return (
    <div className="coordinate-readout">
      <span>{label}</span>
      <strong>{point ? `${formatNumber(point.x)}, ${formatNumber(point.y)}` : "未设置"}</strong>
    </div>
  );
}

function StatusLine({ label, state }: { label: string; state: LoadState }) {
  const text = state.status === "error" ? state.message : state.status;
  return (
    <div className={`status-line ${state.status}`}>
      <span>{label}</span>
      <strong>{text}</strong>
    </div>
  );
}

function HealthBadge({ health }: { health: HealthState }) {
  if (health.status === "loading") {
    return <div className="health-badge pending">检查后端中…</div>;
  }

  if (health.status === "error") {
    return <div className="health-badge error">后端未连接：{health.message}</div>;
  }

  return (
    <div className="health-badge ok">
      <span>后端在线</span>
      <strong>{health.service}</strong>
      <small>
        v{health.version} · {health.environment}
      </small>
    </div>
  );
}

async function ensureMapAsset(mapId: string): Promise<string> {
  const asset = await fetchJson<{ image_url: string }>(`/api/assets/maps/${encodeURIComponent(mapId)}/ensure`, {
    method: "POST",
  });
  return asset.image_url;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(readErrorMessage(body, `请求失败：${response.status}`));
  }
  return body as T;
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }
  return fallback;
}

function normalizedToWorld(point: Point, coordinate: CoordinateConfig): Point {
  const normalizedY = coordinate.y_axis === "up" ? 1 - point.y : point.y;
  return {
    x: coordinate.min_x + point.x * (coordinate.max_x - coordinate.min_x),
    y: coordinate.min_y + normalizedY * (coordinate.max_y - coordinate.min_y),
  };
}

function worldToPercent(point: Point, coordinate: CoordinateConfig): Point {
  const normalizedX = (point.x - coordinate.min_x) / (coordinate.max_x - coordinate.min_x);
  const rawY = (point.y - coordinate.min_y) / (coordinate.max_y - coordinate.min_y);
  const normalizedY = coordinate.y_axis === "up" ? 1 - rawY : rawY;
  return { x: clamp(normalizedX) * 100, y: clamp(normalizedY) * 100 };
}

function clamp(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function readinessLabel(value: string): string {
  const labels: Record<string, string> = {
    ready: "ready",
    generated_with_warnings: "ready + warnings",
    missing: "missing",
    completed: "completed",
    failed: "failed",
    error: "error",
    not_trained: "not trained",
  };
  return labels[value] ?? value;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}
