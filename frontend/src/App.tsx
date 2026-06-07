import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InteractiveMapCanvas } from "./components/InteractiveMapCanvas";

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

type IngestJobResult = {
  id: string;
  job_type: string;
  status: string;
  source_ref: string | null;
  total_count: number;
  success_count: number;
  skipped_count: number;
  failed_count: number;
  retry_count: number;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
};

type RouteStrategy = "edge" | "center" | "slow" | "avoid_hotspots";
type ClickMode = "current_circle_center" | "team_area";
type WorkspaceSurface = "predict" | "ingest" | "prep";
type ParseProfile = "zone_only" | "hotspot_light" | "full";

const workspaceSurfaces: Array<{ value: WorkspaceSurface; label: string; description: string; icon: string }> = [
  { value: "predict", label: "战术预测", description: "地图标点 / 路线", icon: "T" },
  { value: "ingest", label: "官方采集", description: "samples / telemetry", icon: "I" },
  { value: "prep", label: "数据准备", description: "热点 / 训练", icon: "D" },
];

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

const parseProfiles: Array<{ value: ParseProfile; label: string; description: string; intervalSeconds: number }> = [
  { value: "hotspot_light", label: "轻量热点", description: "保留圈数据和低频位置点，默认推荐。", intervalSeconds: 30 },
  { value: "zone_only", label: "圈预测优先", description: "只写圈阶段数据，数据库负担最低。", intervalSeconds: 30 },
  { value: "full", label: "完整分析", description: "保留完整 5 秒位置采样，适合小批量调试。", intervalSeconds: 5 },
];

function isTerminalIngestStatus(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function ingestProcessedCount(job: IngestJobResult) {
  return job.success_count + job.skipped_count + job.failed_count;
}

export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [mapsState, setMapsState] = useState<LoadState>({ status: "loading" });
  const [selectedMapId, setSelectedMapId] = useState("miramar");
  const [zoneConfig, setZoneConfig] = useState<ZoneConfig | null>(null);
  const [zoneState, setZoneState] = useState<LoadState>({ status: "idle" });
  const [assetState, setAssetState] = useState<LoadState>({ status: "idle" });
  const [assetImageUrl, setAssetImageUrl] = useState<string | null>(null);
  const [activeSurface, setActiveSurface] = useState<WorkspaceSurface>("predict");
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
  const [retryJobIdInput, setRetryJobIdInput] = useState("");
  const [sampleMaxMatchesInput, setSampleMaxMatchesInput] = useState("20");
  const [sampleParseProfile, setSampleParseProfile] = useState<ParseProfile>("hotspot_light");
  const [ingestState, setIngestState] = useState<LoadState>({ status: "idle" });
  const [latestIngestJob, setLatestIngestJob] = useState<IngestJobResult | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const predictAbortControllerRef = useRef<AbortController | null>(null);
  const ingestAbortControllerRef = useRef<AbortController | null>(null);
  const ingestRequestIdRef = useRef(0);
  const predictRequestIdRef = useRef(0);
  const workspaceContextRef = useRef({ mapId: selectedMapId, phase: currentPhase });

  useEffect(() => {
    workspaceContextRef.current = { mapId: selectedMapId, phase: currentPhase };
  }, [currentPhase, selectedMapId]);

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
  const activeSurfaceInfo = workspaceSurfaces.find((surface) => surface.value === activeSurface) ?? workspaceSurfaces[0];
  const resetPredictionState = useCallback((abortInFlight = true) => {
    if (abortInFlight) {
      predictAbortControllerRef.current?.abort();
    }
    predictRequestIdRef.current += 1;
    setPrediction(null);
    setPredictError(null);
    setPredictState({ status: "idle" });
  }, []);

  useEffect(() => {
    return () => {
      ingestAbortControllerRef.current?.abort();
      ingestRequestIdRef.current += 1;
    };
  }, []);

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
          setSelectedMapId(body.maps.find((map) => map.map_id === "miramar")?.map_id ?? body.maps[0].map_id);
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
    setCurrentCircleCenter(null);
    setTeamArea(null);
    setClickMode("current_circle_center");
    resetPredictionState();
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
  }, [resetPredictionState, selectedMapId]);

  function retryAssetLoad() {
    const requestMapId = selectedMapId;
    setAssetState({ status: "loading" });
    setAssetImageUrl(null);
    ensureMapAsset(requestMapId)
      .then((imageUrl) => {
        if (workspaceContextRef.current.mapId !== requestMapId) {
          return;
        }
        setAssetImageUrl(`${imageUrl}&cache_bust=${Date.now()}`);
        setAssetState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (workspaceContextRef.current.mapId !== requestMapId) {
          return;
        }
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
    const requestMapId = selectedMapId;
    const requestPhase = currentPhase;
    setHotspotRunState({ status: "loading" });

    fetchJson<HotspotGenerateResult>(
      `/api/hotspots/generate?map_id=${encodeURIComponent(requestMapId)}&phase=${requestPhase}`,
      { method: "POST" },
    )
      .then((body) => {
        if (
          workspaceContextRef.current.mapId !== requestMapId ||
          workspaceContextRef.current.phase !== requestPhase
        ) {
          return;
        }
        setHotspotResult(body);
        setHotspotRunState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (
          workspaceContextRef.current.mapId !== requestMapId ||
          workspaceContextRef.current.phase !== requestPhase
        ) {
          return;
        }
        setHotspotRunState({
          status: "error",
          message: error instanceof Error ? error.message : "热点生成失败",
        });
      });
  }

  function trainCurrentMap() {
    const requestMapId = selectedMapId;
    setTrainingRunState({ status: "loading" });

    fetchJson<TrainingRunResult>(
      `/api/training/runs?map_id=${encodeURIComponent(requestMapId)}`,
      { method: "POST" },
    )
      .then((body) => {
        if (workspaceContextRef.current.mapId !== requestMapId) {
          return;
        }
        setTrainingResult(body);
        if (body.status === "failed") {
          setTrainingRunState({ status: "error", message: "训练样本不足或训练失败" });
        } else {
          setTrainingRunState({ status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (workspaceContextRef.current.mapId !== requestMapId) {
          return;
        }
        setTrainingRunState({
          status: "error",
          message: error instanceof Error ? error.message : "模型训练失败",
        });
      });
  }

  function runIngestAction(action: (signal: AbortSignal) => Promise<IngestJobResult>) {
    ingestAbortControllerRef.current?.abort();
    const requestId = ingestRequestIdRef.current + 1;
    ingestRequestIdRef.current = requestId;
    const abortController = new AbortController();
    ingestAbortControllerRef.current = abortController;
    setIngestState({ status: "loading" });
    setIngestError(null);

    action(abortController.signal)
      .then((job) => {
        if (ingestRequestIdRef.current !== requestId || abortController.signal.aborted) {
          return;
        }
        setLatestIngestJob(job);
        if (isTerminalIngestStatus(job.status)) {
          setIngestState(job.status === "failed" ? { status: "error", message: job.error_message ?? "采集任务失败" } : { status: "ready" });
          ingestAbortControllerRef.current = null;
          return;
        }
        pollIngestJob(job.id, requestId, abortController);
      })
      .catch((error: unknown) => {
        if (ingestRequestIdRef.current !== requestId || abortController.signal.aborted) {
          return;
        }
        setIngestState({ status: "error", message: error instanceof Error ? error.message : "采集请求失败" });
        setIngestError(error instanceof Error ? error.message : "采集请求失败");
        ingestAbortControllerRef.current = null;
      });
  }

  function pollIngestJob(jobId: string, requestId: number, abortController: AbortController) {
    window.setTimeout(() => {
      if (ingestRequestIdRef.current !== requestId || abortController.signal.aborted) {
        return;
      }
      fetchJson<IngestJobResult>(`/api/ingest/jobs/${encodeURIComponent(jobId)}`, {
        signal: abortController.signal,
      })
        .then((job) => {
          if (ingestRequestIdRef.current !== requestId || abortController.signal.aborted) {
            return;
          }
          setLatestIngestJob(job);
          if (isTerminalIngestStatus(job.status)) {
            setIngestState(job.status === "failed" ? { status: "error", message: job.error_message ?? "采集任务失败" } : { status: "ready" });
            ingestAbortControllerRef.current = null;
            return;
          }
          setIngestState({ status: "loading" });
          pollIngestJob(jobId, requestId, abortController);
        })
        .catch((error: unknown) => {
          if (ingestRequestIdRef.current !== requestId || abortController.signal.aborted) {
            return;
          }
          setIngestState({ status: "error", message: error instanceof Error ? error.message : "采集进度查询失败" });
          setIngestError(error instanceof Error ? error.message : "采集进度查询失败");
          ingestAbortControllerRef.current = null;
        });
    }, 1000);
  }

  function ingestSquadSamples() {
    const maxMatches = Number.parseInt(sampleMaxMatchesInput, 10);
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 100) {
      setIngestError("采集数量上限需要在 1 到 100 之间");
      setIngestState({ status: "error", message: "采集数量上限需要在 1 到 100 之间" });
      return;
    }
    const profile = parseProfiles.find((item) => item.value === sampleParseProfile) ?? parseProfiles[0];
    const query = new URLSearchParams({
      max_matches: String(maxMatches),
      parse_profile: profile.value,
      position_interval_seconds: String(profile.intervalSeconds),
    });
    runIngestAction((signal) =>
      fetchJson<IngestJobResult>(
        `/api/ingest/samples/squad?${query.toString()}`,
        { method: "POST", signal },
      ),
    );
  }

  function retryIngestJob() {
    const jobId = retryJobIdInput.trim() || latestIngestJob?.id;
    if (!jobId) {
      setIngestError("请先填写 job id，或先运行一个采集任务");
      return;
    }
    runIngestAction((signal) => fetchJson<IngestJobResult>(`/api/ingest/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", signal }));
  }

  function cancelIngestJob() {
    const jobId = latestIngestJob?.id;
    if (!jobId || latestIngestJob.status !== "running") {
      setIngestError("当前没有正在运行的采集任务");
      return;
    }
    ingestAbortControllerRef.current?.abort();
    ingestRequestIdRef.current += 1;
    setIngestState({ status: "loading" });
    setIngestError(null);
    fetchJson<IngestJobResult>(`/api/ingest/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    })
      .then((job) => {
        setLatestIngestJob(job);
        setIngestState({ status: "ready" });
        ingestAbortControllerRef.current = null;
      })
      .catch((error: unknown) => {
        setIngestState({ status: "error", message: error instanceof Error ? error.message : "终止任务失败" });
        setIngestError(error instanceof Error ? error.message : "终止任务失败");
      });
  }

  const handleSetCurrentCircleCenter = useCallback((point: Point) => {
    setCurrentCircleCenter(point);
    setClickMode("team_area");
    resetPredictionState();
  }, [resetPredictionState]);

  const handleSetTeamArea = useCallback((point: Point) => {
    setTeamArea(point);
    resetPredictionState();
  }, [resetPredictionState]);

  const clearCurrentCircleCenter = useCallback(() => {
    setCurrentCircleCenter(null);
    setClickMode("current_circle_center");
    resetPredictionState();
  }, [resetPredictionState]);

  const clearTeamArea = useCallback(() => {
    setTeamArea(null);
    setClickMode("team_area");
    resetPredictionState();
  }, [resetPredictionState]);

  const handleMapImageError = useCallback((message: string) => {
    setAssetState({ status: "error", message });
    setAssetImageUrl(null);
  }, []);

  function handleMapSelection(mapId: string) {
    setSelectedMapId(mapId);
  }

  function handlePhaseSelection(phase: number) {
    setCurrentPhase(phase);
    setHotspotResult(null);
    setHotspotRunState({ status: "idle" });
    resetPredictionState();
  }

  function submitPrediction() {
    if (!canPredict || !currentCircleCenter || !teamArea) {
      return;
    }
    predictAbortControllerRef.current?.abort();
    const requestId = predictRequestIdRef.current + 1;
    predictRequestIdRef.current = requestId;
    const abortController = new AbortController();
    predictAbortControllerRef.current = abortController;
    setPredictState({ status: "loading" });
    setPredictError(null);

    fetchJson<PredictionResult>("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
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
        if (predictRequestIdRef.current !== requestId || abortController.signal.aborted) {
          return;
        }
        setPrediction(body);
        setPredictState({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (predictRequestIdRef.current !== requestId || abortController.signal.aborted) {
          return;
        }
        setPredictState({ status: "error", message: "预测失败" });
        setPredictError(error instanceof Error ? error.message : "预测失败");
      })
      .finally(() => {
        if (predictRequestIdRef.current === requestId) {
          predictAbortControllerRef.current = null;
        }
      });
  }

  return (
    <main className="app-shell rail-shell">
      <aside className="app-rail" aria-label="主导航">
        <div className="rail-brand" aria-hidden="true">Z</div>
        <nav className="rail-nav" aria-label="主工作区">
          {workspaceSurfaces.map((surface) => (
            <button
              key={surface.value}
              type="button"
              className={`rail-tab ${activeSurface === surface.value ? "active" : ""}`}
              aria-current={activeSurface === surface.value ? "page" : undefined}
              onClick={() => setActiveSurface(surface.value)}
            >
              <span className="rail-tab-icon" aria-hidden="true">{surface.icon}</span>
              <span>{surface.label.replace("战术", "")}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">LOCAL</div>
      </aside>

      <section className="main-surface">
        <header className="topbar">
          <div className="surface-title">
            <strong>{activeSurfaceInfo.label}</strong>
            <span>{activeSurfaceInfo.description}</span>
          </div>

          {activeSurface === "predict" ? (
            <div className="context-controls">
              <label className="nav-field">
                <span>地图</span>
                <select value={selectedMapId} onChange={(event) => handleMapSelection(event.target.value)}>
                  {maps.map((map) => (
                    <option key={map.map_id} value={map.map_id}>
                      {map.display_name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="nav-field compact">
                <span>Zone</span>
                <select value={currentPhase} onChange={(event) => handlePhaseSelection(Number(event.target.value))} disabled={!zoneConfig}>
                  {(zoneConfig?.supported_prediction_phases ?? [1]).map((phase) => (
                    <option key={phase} value={phase}>
                      {phase}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mode-switch" role="group" aria-label="地图点击模式">
                {clickModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={clickMode === mode.value ? "active" : ""}
                    disabled={!mapReady}
                    onClick={() => setClickMode(mode.value)}
                  >
                    {mode.label.replace("设置当前", "")}
                  </button>
                ))}
              </div>

              <div className="nav-coordinate">
                <span>圈心</span>
                <strong>{currentCircleCenter ? "已设置" : "未设置"}</strong>
                {currentCircleCenter ? (
                  <button type="button" onClick={clearCurrentCircleCenter}>
                    清除
                  </button>
                ) : null}
              </div>

              <div className="nav-coordinate">
                <span>队伍</span>
                <strong>{teamArea ? "已设置" : "未设置"}</strong>
                {teamArea ? (
                  <button type="button" onClick={clearTeamArea}>
                    清除
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeSurface === "ingest" ? (
            <div className="context-controls">
              <StatusLine label="采集任务" state={ingestState} />
              <div className="nav-coordinate">
                <span>最近任务</span>
                <strong>{latestIngestJob ? latestIngestJob.job_type : "无"}</strong>
              </div>
              <div className="nav-coordinate">
                <span>结果</span>
                <strong>{latestIngestJob ? latestIngestJob.status : "待运行"}</strong>
              </div>
            </div>
          ) : null}

          {activeSurface === "prep" ? (
            <div className="context-controls">
              <ReadinessBadge label="热点" value={hotspotReadiness} />
              <ReadinessBadge label="模型" value={modelReadiness} />
              <div className="nav-coordinate">
                <span>地图</span>
                <strong>{selectedMap?.display_name ?? "未加载"}</strong>
              </div>
            </div>
          ) : null}

          <HealthBadge health={health} />
        </header>

      {activeSurface === "predict" ? (
        <section className="workspace-shell">
          <div className="map-card">
            <div className="map-toolbar">
              <div>
                <strong>{selectedMap?.display_name ?? "地图加载中"}</strong>
                <span>{mapReady ? "底图已就绪 · 拖拽平移 · 滚轮缩放 · 单击标点" : "底图未就绪，地图交互已禁用"}</span>
              </div>
            </div>

            <div className={`map-frame ${mapReady ? "ready" : "disabled"}`}>
              {selectedMap ? (
                <InteractiveMapCanvas
                  map={selectedMap}
                  imageUrl={assetImageUrl}
                  enabled={mapReady}
                  currentPhaseRadius={currentPhaseConfig?.radius ?? 0}
                  currentCircleCenter={currentCircleCenter}
                  teamArea={teamArea}
                  prediction={prediction}
                  clickMode={clickMode}
                  onSetCurrentCircleCenter={handleSetCurrentCircleCenter}
                  onSetTeamArea={handleSetTeamArea}
                  onImageError={handleMapImageError}
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
            <div className="section-heading">
              <h2>战术预测</h2>
              <p>这里只处理地图标点、路线策略、预测和解释；官方采集与训练已移到独立工作区。</p>
            </div>
            <div className="status-grid">
              <StatusLine label="地图配置" state={mapsState} />
              <StatusLine label="Zone 配置" state={zoneState} />
              <StatusLine label="地图资源" state={assetState} />
            </div>

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
              <CoordinateReadout label="当前圈中心" point={currentCircleCenter} onClear={clearCurrentCircleCenter} />
              <CoordinateReadout label="战队位置" point={teamArea} onClear={clearTeamArea} />
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
      ) : null}

      {activeSurface === "ingest" ? (
        <section className="ops-surface">
          <div className="ops-panel">
            <IngestConsolePanel
              retryJobId={retryJobIdInput}
              ingestState={ingestState}
              latestJob={latestIngestJob}
              ingestError={ingestError}
              sampleMaxMatches={sampleMaxMatchesInput}
              sampleParseProfile={sampleParseProfile}
              onRetryJobIdChange={setRetryJobIdInput}
              onSampleMaxMatchesChange={setSampleMaxMatchesInput}
              onSampleParseProfileChange={setSampleParseProfile}
              onIngestSquadSamples={ingestSquadSamples}
              onRetryJob={retryIngestJob}
              onCancelJob={cancelIngestJob}
            />
          </div>
        </section>
      ) : null}

      {activeSurface === "prep" ? (
        <section className="ops-surface">
          <div className="ops-panel">
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
          </div>
        </section>
      ) : null}
      </section>
    </main>
  );
}

function IngestConsolePanel({
  retryJobId,
  ingestState,
  latestJob,
  ingestError,
  sampleMaxMatches,
  sampleParseProfile,
  onRetryJobIdChange,
  onSampleMaxMatchesChange,
  onSampleParseProfileChange,
  onIngestSquadSamples,
  onRetryJob,
  onCancelJob,
}: {
  retryJobId: string;
  ingestState: LoadState;
  latestJob: IngestJobResult | null;
  ingestError: string | null;
  sampleMaxMatches: string;
  sampleParseProfile: ParseProfile;
  onRetryJobIdChange: (value: string) => void;
  onSampleMaxMatchesChange: (value: string) => void;
  onSampleParseProfileChange: (value: ParseProfile) => void;
  onIngestSquadSamples: () => void;
  onRetryJob: () => void;
  onCancelJob: () => void;
}) {
  const busy = ingestState.status === "loading";
  const canCancel = latestJob?.status === "running";
  const ingestErrorMessage = ingestError ?? (ingestState.status === "error" ? ingestState.message : null);
  const selectedProfile = parseProfiles.find((profile) => profile.value === sampleParseProfile) ?? parseProfiles[0];

  return (
    <section className="ingest-console-panel">
      <div className="section-heading ingest-heading">
        <div>
          <h3>普通 squad 数据采集</h3>
          <p>从 PUBG samples 抓普通四排 match，并自动完成 telemetry 下载与解析入库。</p>
        </div>
        <span>Key 后端持有</span>
      </div>

      <div className="ingest-flow">
        <article className="ingest-step">
          <div className="ingest-step-title">
            <span>1</span>
            <strong>采集并解析普通 squad 样本</strong>
          </div>
          <small>自动过滤非 squad、自定义和赛事对局，写入 match、缓存 telemetry，并解析为圈阶段、位置样本和事件。</small>
          <label className="ingest-input-label" htmlFor="sample-parse-profile">
            数据过滤模式
            <select
              id="sample-parse-profile"
              value={sampleParseProfile}
              disabled={busy}
              onChange={(event) => onSampleParseProfileChange(event.target.value as ParseProfile)}
            >
              {parseProfiles.map((profile) => (
                <option key={profile.value} value={profile.value}>
                  {profile.label}
                </option>
              ))}
            </select>
            <small>{selectedProfile.description}</small>
          </label>
          <label className="ingest-input-label" htmlFor="sample-max-matches">
            数量上限
            <input
              id="sample-max-matches"
              type="number"
              min="1"
              max="100"
              value={sampleMaxMatches}
              disabled={busy}
              onChange={(event) => onSampleMaxMatchesChange(event.target.value)}
            />
            <small>最多处理 100 场；默认 20 场，方便先小批量验证。</small>
          </label>
          <button type="button" disabled={busy} onClick={onIngestSquadSamples}>
            {busy ? "采集中…" : "一键采集普通 squad 数据"}
          </button>
        </article>
      </div>

      <div className="ingest-retry-row">
        <label className="ingest-input-label" htmlFor="ingest-retry-job-id">
          Job ID
        </label>
        <input
          id="ingest-retry-job-id"
          type="text"
          value={retryJobId}
          placeholder={latestJob ? `默认重试 ${latestJob.id}` : "可选：job id"}
          disabled={busy}
          onChange={(event) => onRetryJobIdChange(event.target.value)}
        />
        <button type="button" className="secondary-action" disabled={busy || (!retryJobId.trim() && !latestJob)} onClick={onRetryJob}>
          重试任务
        </button>
        <button type="button" className="danger-action" disabled={!canCancel} onClick={onCancelJob}>
          终止任务
        </button>
      </div>

      {ingestErrorMessage ? (
        <div className="error-panel compact">{ingestErrorMessage}</div>
      ) : null}
      {latestJob ? <IngestJobSummary job={latestJob} /> : <p className="hint">最近任务会显示在这里；失败任务可通过 job id 重试。</p>}
    </section>
  );
}

function IngestJobSummary({ job }: { job: IngestJobResult }) {
  return (
    <div className={`ingest-job-summary ${job.status}`}>
      <div className="ingest-job-header">
        <strong>{job.job_type}</strong>
        <span>{job.status}</span>
      </div>
      <IngestProgressBar job={job} />
      <div className="result-grid compact-grid">
        <MetricCard title="成功" value={String(job.success_count)} detail={`total ${job.total_count}`} />
        <MetricCard title="跳过" value={String(job.skipped_count)} detail={`failed ${job.failed_count}`} />
      </div>
      <p className="model-id">
        {job.id} {job.source_ref ? `· ${job.source_ref}` : ""}
      </p>
      {job.error_message ? <div className="error-panel compact">{job.error_message}</div> : null}
      <WarningChips warnings={job.warnings} />
    </div>
  );
}

function IngestProgressBar({ job }: { job: IngestJobResult }) {
  const processedCount = ingestProcessedCount(job);
  const progressPercent = job.total_count > 0
    ? Math.min(100, Math.round((processedCount / job.total_count) * 100))
    : job.status === "running"
      ? 8
      : 0;
  const progressText = job.total_count > 0
    ? `${processedCount} / ${job.total_count}`
    : job.status === "running"
      ? "确认样本中"
      : "未开始";

  return (
    <div className="ingest-progress-block">
      <div className="ingest-progress-meta">
        <span>采集进度</span>
        <strong>{progressText}</strong>
      </div>
      <div className="ingest-progress-track" aria-label="采集进度">
        <span style={{ width: `${progressPercent}%` }} />
      </div>
    </div>
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

function CoordinateReadout({ label, point, onClear }: { label: string; point: Point | null; onClear: () => void }) {
  return (
    <div className="coordinate-readout">
      <div>
        <span>{label}</span>
        <strong>{point ? `${formatNumber(point.x)}, ${formatNumber(point.y)}` : "未设置"}</strong>
      </div>
      {point ? (
        <button type="button" className="clear-coordinate" onClick={onClear}>
          清除
        </button>
      ) : null}
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
