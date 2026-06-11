import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

type IngestMatchAsset = {
  match_id: string;
  map_name: string;
  shard_id: string | null;
  game_mode: string | null;
  match_type: string | null;
  created_at: string | null;
  duration: number | null;
  ingest_status: string;
  telemetry_url: string | null;
  telemetry_cache_path: string | null;
  telemetry_parse_status: string | null;
  telemetry_downloaded_at: string | null;
  circle_phase_count: number;
  position_sample_count: number;
  life_event_count: number;
};

type DeleteMatchResult = {
  match_id: string;
  deleted: boolean;
  telemetry_cache_deleted: boolean;
  circle_phase_count: number;
  position_sample_count: number;
  life_event_count: number;
};

type RouteStrategy = "edge" | "center" | "slow" | "avoid_hotspots";
type ClickMode = "current_circle_center" | "team_area";
type WorkspaceSurface = "predict" | "ingest" | "prep";
type ParseProfile = "zone_only" | "hotspot_light" | "full";

const workspaceSurfaces: Array<{ value: WorkspaceSurface; label: string; description: string; icon: string }> = [
  { value: "predict", label: "战术预测", description: "地图标点 / 路线", icon: "T" },
  { value: "ingest", label: "数据采集与管理", description: "采集 / 概览 / 删除", icon: "I" },
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
  const [ingestMatches, setIngestMatches] = useState<IngestMatchAsset[]>([]);
  const [matchesState, setMatchesState] = useState<LoadState>({ status: "idle" });
  const [deleteMatchState, setDeleteMatchState] = useState<LoadState>({ status: "idle" });
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
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

  useEffect(() => {
    if (activeSurface === "ingest") {
      loadIngestMatches();
    }
  }, [activeSurface]);

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

  function loadIngestMatches() {
    setMatchesState({ status: "loading" });
    fetchJson<{ matches: IngestMatchAsset[] }>("/api/ingest/matches?limit=100")
      .then((body) => {
        setIngestMatches(body.matches);
        setMatchesState({ status: "ready" });
      })
      .catch((error: unknown) => {
        setMatchesState({ status: "error", message: error instanceof Error ? error.message : "数据列表加载失败" });
      });
  }

  function deleteIngestMatch(matchId: string) {
    const confirmed = window.confirm(`确定删除 ${matchId} 及其关联 telemetry/cache/解析数据吗？此操作不可恢复。`);
    if (!confirmed) {
      return;
    }
    setDeleteMatchState({ status: "loading" });
    setDeleteMessage(null);
    fetchJson<DeleteMatchResult>(`/api/ingest/matches/${encodeURIComponent(matchId)}`, { method: "DELETE" })
      .then((result) => {
        setDeleteMessage(
          `已删除 ${result.match_id}：圈阶段 ${result.circle_phase_count}，位置样本 ${result.position_sample_count}，生命事件 ${result.life_event_count}`,
        );
        setDeleteMatchState({ status: "ready" });
        loadIngestMatches();
      })
      .catch((error: unknown) => {
        setDeleteMatchState({ status: "error", message: error instanceof Error ? error.message : "删除失败" });
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
    <Tabs
      value={activeSurface}
      onValueChange={(value) => setActiveSurface(value as WorkspaceSurface)}
      orientation="vertical"
      className="app-shell rail-shell ops-redesign-shell"
    >
      <aside className="app-rail" aria-label="主导航">
        <div className="rail-brand" aria-hidden="true">Z</div>
        <TabsList className="rail-nav" aria-label="主工作区">
          {workspaceSurfaces.map((surface) => (
            <TabsTrigger key={surface.value} value={surface.value} className="rail-tab">
              <span className="rail-tab-icon" aria-hidden="true">{surface.icon}</span>
              <span>{surface.label.replace("战术", "")}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="rail-foot">LOCAL OPS</div>
      </aside>

      <main className="main-surface ops-workspace">
        <header className="topbar ops-topbar">
          <div className="surface-title ops-title-block">
            <span className="ops-eyebrow">PUBG ZONE INTELLIGENCE</span>
            <h1>{activeSurface === "predict" ? "下一圈决策中枢" : activeSurfaceInfo.label}</h1>
            <span>{activeSurface === "predict" ? "把地图、采集、训练变成一个单屏作战台，而不是表单集合。" : activeSurfaceInfo.description}</span>
          </div>

          <div className="command-strip">
            <Field className="nav-field ops-command-pill">
              <FieldLabel htmlFor="map-select">地图</FieldLabel>
              <Select value={selectedMapId} onValueChange={(value) => handleMapSelection(String(value))}>
                <SelectTrigger id="map-select" size="sm" className="app-select-trigger">
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
            </Field>

            <Field className="nav-field compact ops-command-pill" data-disabled={!zoneConfig}>
              <FieldLabel htmlFor="phase-select">Zone</FieldLabel>
              <Select
                value={String(currentPhase)}
                disabled={!zoneConfig}
                onValueChange={(value) => handlePhaseSelection(Number(value))}
              >
                <SelectTrigger id="phase-select" size="sm" className="app-select-trigger compact">
                  <SelectValue placeholder="Zone" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(zoneConfig?.supported_prediction_phases ?? [1]).map((phase) => (
                      <SelectItem key={phase} value={String(phase)}>
                        {phase}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            <div className="mode-switch ops-mode-switch" role="group" aria-label="地图点击模式">
              {clickModes.map((mode) => (
                <Button
                  key={mode.value}
                  type="button"
                  variant={clickMode === mode.value ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={clickMode === mode.value}
                  disabled={!mapReady}
                  onClick={() => setClickMode(mode.value)}
                >
                  {mode.label.replace("设置当前", "")}
                </Button>
              ))}
            </div>

            <div className="nav-field ops-command-pill">
              <span>路线</span>
              <strong>{routeStrategies.find((strategy) => strategy.value === routeStrategy)?.label ?? "未选择"}</strong>
            </div>
          </div>

          <div className="status-stack">
            <HealthBadge health={health} />
            <ReadinessBadge label="模型" value={modelReadiness} />
          </div>
        </header>

        <TabsContent value="predict" className="ops-dashboard">
          <section className="ops-main-grid">
            <Card className="map-card ops-map-deck">
              <div className="map-toolbar ops-map-top">
                <div className="floating-card map-title-card">
                  <strong>{selectedMap?.display_name ?? "地图加载中"}</strong>
                  <span>{mapReady ? "Digital Sand Table · 拖拽平移 · 滚轮缩放 · 单击标点" : "底图未就绪，地图交互已禁用"}</span>
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
                    {assetState.status !== "error" ? <Skeleton className="map-loading-skeleton" /> : null}
                    <span>
                      {assetState.status === "error"
                        ? assetState.message
                        : "底图加载完成后才能点击地图和生成预测。"}
                    </span>
                    {assetState.status === "error" ? (
                      <Button type="button" variant="outline" onClick={retryAssetLoad}>
                        重试加载地图
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="ops-map-bottom">
                <CoordinateReadout label="当前圈心" point={currentCircleCenter} onClear={clearCurrentCircleCenter} />
                <CoordinateReadout label="战队位置" point={teamArea} onClear={clearTeamArea} />
                <MetricCard title="路线评分" value={prediction ? prediction.route.route_score.toFixed(2) : "—"} detail="route score" />
                <MetricCard title="热点风险" value={prediction ? prediction.route.risk_summary.hotspot_risk : "—"} detail={prediction ? `score ${prediction.route.risk_summary.hotspot_score.toFixed(2)}` : "等待预测"} />
              </div>
            </Card>

            <aside className="decision-panel">
              <Card className="control-panel prediction-panel decision-card">
                <CardHeader>
                  <CardTitle>快速决策</CardTitle>
                  <CardDescription>选择路线策略、确认输入，然后生成下一圈推荐。</CardDescription>
                  <CardAction><Badge variant={canPredict ? "default" : "secondary"}>{canPredict ? "ready" : "setup"}</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <div className="status-grid compact-grid">
                    <StatusLine label="地图" state={mapsState} />
                    <StatusLine label="Zone" state={zoneState} />
                  </div>

                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="route-strategy-select">路线策略</FieldLabel>
                      <Select value={routeStrategy} onValueChange={(value) => setRouteStrategy(value as RouteStrategy)}>
                        <SelectTrigger id="route-strategy-select" className="app-select-trigger full">
                          <SelectValue placeholder="选择路线策略" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {routeStrategies.map((strategy) => (
                              <SelectItem key={strategy.value} value={strategy.value}>
                                {strategy.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>{routeStrategies.find((strategy) => strategy.value === routeStrategy)?.description}</FieldDescription>
                    </Field>
                  </FieldGroup>

                  <Field orientation="horizontal" className="checkbox-row">
                    <Switch checked={useLlmExplanation} onCheckedChange={setUseLlmExplanation} />
                    <FieldContent>
                      <FieldLabel>尝试使用 LLM 解释</FieldLabel>
                    </FieldContent>
                  </Field>

                  <Button type="button" className="panel-primary-action" disabled={!canPredict || predictState.status === "loading"} onClick={submitPrediction}>
                    {predictState.status === "loading" ? "生成中…" : "生成下一圈预测"}
                  </Button>

                  {!canPredict ? <p className="hint">需先加载底图，并设置当前圈中心与战队位置。</p> : null}
                  {canPredict && (hotspotReadiness !== "ready" || modelReadiness !== "completed") ? (
                    <Alert className="app-alert">
                      <AlertTitle>将使用降级能力</AlertTitle>
                      <AlertDescription>热点或模型尚未完全 ready，预测仍会运行，并在结果中标记无热点或规则兜底降级。</AlertDescription>
                    </Alert>
                  ) : null}
                  {predictError ? <ErrorAlert message={predictError} /> : null}
                </CardContent>
              </Card>

              <PredictionPanel prediction={prediction} />
            </aside>
          </section>

          <section className="bottom-console">
            <Card className="bottom-console-card data-card">
              <CardHeader>
                <CardTitle>采集管理</CardTitle>
                <CardDescription>保留真实浏览与直接删除能力，压缩为底部控制台。</CardDescription>
              </CardHeader>
              <CardContent>
                <IngestMatchTable
                  matches={ingestMatches.slice(0, 5)}
                  matchesState={matchesState}
                  deleting={deleteMatchState.status === "loading"}
                  onRefresh={loadIngestMatches}
                  onDeleteMatch={deleteIngestMatch}
                />
              </CardContent>
            </Card>

            <div className="bottom-console-card">
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
        </TabsContent>

        <TabsContent value="ingest" className="ops-surface focused-surface">
          <div className="ops-panel">
            <IngestConsolePanel
              retryJobId={retryJobIdInput}
              ingestState={ingestState}
              latestJob={latestIngestJob}
              ingestError={ingestError}
              sampleMaxMatches={sampleMaxMatchesInput}
              sampleParseProfile={sampleParseProfile}
              matches={ingestMatches}
              matchesState={matchesState}
              deleteMatchState={deleteMatchState}
              deleteMessage={deleteMessage}
              onRetryJobIdChange={setRetryJobIdInput}
              onSampleMaxMatchesChange={setSampleMaxMatchesInput}
              onSampleParseProfileChange={setSampleParseProfile}
              onIngestSquadSamples={ingestSquadSamples}
              onRetryJob={retryIngestJob}
              onCancelJob={cancelIngestJob}
              onRefreshMatches={loadIngestMatches}
              onDeleteMatch={deleteIngestMatch}
            />
          </div>
        </TabsContent>

        <TabsContent value="prep" className="ops-surface focused-surface">
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
        </TabsContent>
      </main>
    </Tabs>
  );
}

function ErrorAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="app-alert compact">
      <AlertTitle>操作失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function IngestConsolePanel({
  retryJobId,
  ingestState,
  latestJob,
  ingestError,
  sampleMaxMatches,
  sampleParseProfile,
  matches,
  matchesState,
  deleteMatchState,
  deleteMessage,
  onRetryJobIdChange,
  onSampleMaxMatchesChange,
  onSampleParseProfileChange,
  onIngestSquadSamples,
  onRetryJob,
  onCancelJob,
  onRefreshMatches,
  onDeleteMatch,
}: {
  retryJobId: string;
  ingestState: LoadState;
  latestJob: IngestJobResult | null;
  ingestError: string | null;
  sampleMaxMatches: string;
  sampleParseProfile: ParseProfile;
  matches: IngestMatchAsset[];
  matchesState: LoadState;
  deleteMatchState: LoadState;
  deleteMessage: string | null;
  onRetryJobIdChange: (value: string) => void;
  onSampleMaxMatchesChange: (value: string) => void;
  onSampleParseProfileChange: (value: ParseProfile) => void;
  onIngestSquadSamples: () => void;
  onRetryJob: () => void;
  onCancelJob: () => void;
  onRefreshMatches: () => void;
  onDeleteMatch: (matchId: string) => void;
}) {
  const busy = ingestState.status === "loading";
  const canCancel = latestJob?.status === "running";
  const ingestErrorMessage = ingestError ?? (ingestState.status === "error" ? ingestState.message : null);
  const selectedProfile = parseProfiles.find((profile) => profile.value === sampleParseProfile) ?? parseProfiles[0];

  return (
    <section className="ingest-console-panel simple-ingest-console">
      <div className="simple-ingest-header">
        <div className="section-heading">
          <h2>数据采集与管理</h2>
          <p>浏览已采集 match，执行 sample squad 采集、任务重试/终止，以及直接删除 match 及其关联解析数据。</p>
        </div>
        <Button type="button" variant="outline" onClick={onRefreshMatches} disabled={matchesState.status === "loading"}>
          {matchesState.status === "loading" ? "刷新中…" : "刷新列表"}
        </Button>
      </div>

      <div className="simple-ingest-grid">
        <Card className="management-card">
          <CardHeader>
            <CardTitle>采集普通 squad 数据</CardTitle>
            <CardDescription>后端持有 PUBG API Key；这里仅提交采集参数。</CardDescription>
            <CardAction>
              <Badge variant={busy ? "secondary" : "default"}>{busy ? "running" : "ready"}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup className="collector-grid">
              <Field>
                <FieldLabel htmlFor="sample-parse-profile">数据过滤模式</FieldLabel>
                <Select
                  value={sampleParseProfile}
                  disabled={busy}
                  onValueChange={(value) => onSampleParseProfileChange(value as ParseProfile)}
                >
                  <SelectTrigger id="sample-parse-profile" className="app-select-trigger full">
                    <SelectValue placeholder="选择过滤模式" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {parseProfiles.map((profile) => (
                        <SelectItem key={profile.value} value={profile.value}>{profile.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{selectedProfile.description}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sample-max-matches">数量上限</FieldLabel>
                <Input
                  id="sample-max-matches"
                  type="number"
                  min="1"
                  max="100"
                  value={sampleMaxMatches}
                  disabled={busy}
                  onChange={(event) => onSampleMaxMatchesChange(event.target.value)}
                />
                <FieldDescription>最多处理 100 场。</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="button" className="panel-primary-action" disabled={busy} onClick={onIngestSquadSamples}>
              {busy ? "采集中…" : "开始采集"}
            </Button>
          </CardContent>
        </Card>

        <Card className="management-card">
          <CardHeader>
            <CardTitle>任务操作</CardTitle>
            <CardDescription>查看最近任务，并可按 job id 重试或终止运行中的任务。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="ingest-retry-job-id">Job ID</FieldLabel>
                <Input
                  id="ingest-retry-job-id"
                  type="text"
                  value={retryJobId}
                  placeholder={latestJob ? `默认重试 ${latestJob.id}` : "可选：job id"}
                  disabled={busy}
                  onChange={(event) => onRetryJobIdChange(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <div className="ingest-action-row">
              <Button type="button" variant="outline" disabled={busy || (!retryJobId.trim() && !latestJob)} onClick={onRetryJob}>重试任务</Button>
              <Button type="button" variant="destructive" disabled={!canCancel} onClick={onCancelJob}>终止任务</Button>
            </div>
            {ingestErrorMessage ? <ErrorAlert message={ingestErrorMessage} /> : null}
            {latestJob ? <IngestJobSummary job={latestJob} /> : <p className="hint">暂无最近任务。</p>}
          </CardContent>
        </Card>
      </div>

      {deleteMessage ? (
        <Alert className="app-alert compact">
          <AlertTitle>删除完成</AlertTitle>
          <AlertDescription>{deleteMessage}</AlertDescription>
        </Alert>
      ) : null}
      {deleteMatchState.status === "error" ? <ErrorAlert message={deleteMatchState.message} /> : null}
      <IngestMatchTable
        matches={matches}
        matchesState={matchesState}
        deleting={deleteMatchState.status === "loading"}
        onRefresh={onRefreshMatches}
        onDeleteMatch={onDeleteMatch}
      />
    </section>
  );
}

function IngestMatchTable({
  matches,
  matchesState,
  deleting,
  onRefresh,
  onDeleteMatch,
}: {
  matches: IngestMatchAsset[];
  matchesState: LoadState;
  deleting: boolean;
  onRefresh: () => void;
  onDeleteMatch: (matchId: string) => void;
}) {
  return (
    <Card className="asset-table-shell" aria-label="已采集数据列表">
      <CardHeader>
        <CardTitle>已采集 match</CardTitle>
        <CardDescription>删除会移除 match 以及关联 telemetry asset、圈阶段、位置样本和生命事件；如存在本地 telemetry cache 文件也会尝试删除。</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" onClick={onRefresh} disabled={matchesState.status === "loading"}>
            {matchesState.status === "loading" ? "加载中…" : "刷新"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {matchesState.status === "error" ? <ErrorAlert message={matchesState.message} /> : null}
        {matches.length === 0 && matchesState.status === "loading" ? <Skeleton className="table-skeleton" /> : null}
        {matches.length === 0 && matchesState.status !== "loading" ? <p className="hint table-hint">暂无采集数据。</p> : null}
        {matches.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>match id</TableHead>
                <TableHead>map</TableHead>
                <TableHead>mode</TableHead>
                <TableHead>created</TableHead>
                <TableHead>telemetry</TableHead>
                <TableHead>phases</TableHead>
                <TableHead>positions</TableHead>
                <TableHead>events</TableHead>
                <TableHead>actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matches.map((match) => (
                <TableRow key={match.match_id}>
                  <TableCell className="mono-cell">{match.match_id}</TableCell>
                  <TableCell>{match.map_name}</TableCell>
                  <TableCell>{match.game_mode ?? "—"}</TableCell>
                  <TableCell>{match.created_at ?? "—"}</TableCell>
                  <TableCell><TonePill tone={match.telemetry_parse_status === "completed" ? "green" : "yellow"}>{match.telemetry_parse_status ?? "missing"}</TonePill></TableCell>
                  <TableCell>{match.circle_phase_count}</TableCell>
                  <TableCell>{match.position_sample_count}</TableCell>
                  <TableCell>{match.life_event_count}</TableCell>
                  <TableCell>
                    <Button type="button" variant="destructive" size="sm" disabled={deleting} onClick={() => onDeleteMatch(match.match_id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TonePill({ tone, children }: { tone: string; children: string }) {
  const variant = tone === "green" ? "default" : tone === "red" ? "destructive" : "secondary";
  return <Badge variant={variant}>{children}</Badge>;
}

function IngestJobSummary({ job }: { job: IngestJobResult }) {
  return (
    <Card className={`ingest-job-summary ${job.status}`} size="sm">
      <CardHeader>
        <CardTitle>{job.job_type}</CardTitle>
        <CardAction><TonePill tone={job.status === "failed" ? "red" : "green"}>{job.status}</TonePill></CardAction>
      </CardHeader>
      <CardContent>
        <IngestProgressBar job={job} />
        <div className="result-grid compact-grid">
          <MetricCard title="成功" value={String(job.success_count)} detail={`total ${job.total_count}`} />
          <MetricCard title="跳过" value={String(job.skipped_count)} detail={`failed ${job.failed_count}`} />
        </div>
        <p className="model-id">
          {job.id} {job.source_ref ? `· ${job.source_ref}` : ""}
        </p>
        {job.error_message ? <ErrorAlert message={job.error_message} /> : null}
        <WarningChips warnings={job.warnings} />
      </CardContent>
    </Card>
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
      <Progress value={progressPercent} aria-label="采集进度" />
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
    <Card className="data-prep-panel">
      <CardHeader>
        <CardTitle>数据准备</CardTitle>
        <CardDescription>通过 FastAPI 生成热点和训练模型；缺数据时预测会自动降级。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="readiness-grid">
          <ReadinessBadge label="热点" value={hotspotReadiness} />
          <ReadinessBadge label="模型" value={modelReadiness} />
        </div>
        <div className="prep-actions">
          <Button
            type="button"
            disabled={!canGenerateHotspots || hotspotRunState.status === "loading"}
            onClick={onGenerateHotspots}
          >
            {hotspotRunState.status === "loading" ? "生成热点中…" : "生成当前 Zone 热点"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!canTrain || trainingRunState.status === "loading"}
            onClick={onTrain}
          >
            {trainingRunState.status === "loading" ? "训练中…" : "训练当前地图模型"}
          </Button>
        </div>
        {hotspotRunState.status === "error" ? <ErrorAlert message={hotspotRunState.message} /> : null}
        {trainingRunState.status === "error" && !trainingResult ? <ErrorAlert message={trainingRunState.message} /> : null}
        {hotspotResult ? <HotspotPrepSummary result={hotspotResult} /> : null}
        {trainingResult ? <TrainingPrepSummary result={trainingResult} /> : null}
      </CardContent>
    </Card>
  );
}

function ReadinessBadge({ label, value }: { label: string; value: string }) {
  return (
    <Card className={`readiness-badge ${value}`} size="sm">
      <CardContent>
        <span>{label}</span>
        <strong>{readinessLabel(value)}</strong>
      </CardContent>
    </Card>
  );
}

function HotspotPrepSummary({ result }: { result: HotspotGenerateResult }) {
  return (
    <Card className="prep-summary" size="sm">
      <CardHeader>
        <CardTitle>热点生成结果</CardTitle>
      </CardHeader>
      <CardContent>
        <span>tiles：{result.summary.tile_count}</span>
        <span>matches：{result.summary.effective_match_count}</span>
        <span>teams：{result.summary.effective_team_count}</span>
        <WarningChips warnings={result.warnings} />
      </CardContent>
    </Card>
  );
}

function TrainingPrepSummary({ result }: { result: TrainingRunResult }) {
  const firstMetric = result.metrics[0];
  return (
    <Card className={`prep-summary ${result.status === "failed" ? "failed" : ""}`} size="sm">
      <CardHeader>
        <CardTitle>训练结果：{result.status}</CardTitle>
      </CardHeader>
      <CardContent>
        <span>samples：{result.sample_count}</span>
        <span>artifact：{result.model_path ? "已生成" : "无"}</span>
        {firstMetric ? (
          <span>
            {firstMetric.target_type} mean error：{formatNumber(firstMetric.mean_center_error)}
          </span>
        ) : null}
        <WarningChips warnings={result.warnings} />
      </CardContent>
    </Card>
  );
}

function WarningChips({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className="warning-list compact">
      <Badge variant="secondary">Warnings</Badge>
      {warnings.map((warning) => (
        <Badge key={warning} variant="secondary">{warning}</Badge>
      ))}
    </div>
  );
}

function PredictionPanel({ prediction }: { prediction: PredictionResult | null }) {
  if (!prediction) {
    return (
      <Card className="result-panel empty" size="sm">
        <CardHeader>
          <CardTitle>预测结果</CardTitle>
          <CardDescription>生成预测后，这里会显示下一圈、最终圈、路线评分、风险和解释。</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="result-panel" size="sm">
      <CardHeader>
        <CardTitle>预测结果</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="result-grid">
          <MetricCard title={`下一圈 Zone ${prediction.next_circle.phase}`} value={prediction.next_circle.source} detail={`半径 ${formatNumber(prediction.next_circle.radius)}`} />
          <MetricCard title={`最终圈 Zone ${prediction.final_circle.phase}`} value={prediction.final_circle.source} detail={`半径 ${formatNumber(prediction.final_circle.radius)}`} />
          <MetricCard title="路线评分" value={prediction.route.route_score.toFixed(2)} detail={`距离 ${formatNumber(prediction.route.risk_summary.distance)}`} />
          <MetricCard title="热点风险" value={prediction.route.risk_summary.hotspot_risk} detail={`score ${prediction.route.risk_summary.hotspot_score.toFixed(2)}`} />
        </div>
        {prediction.model_run_id ? <p className="model-id">模型：{prediction.model_run_id}</p> : <p className="model-id warning">模型：规则兜底</p>}
        <WarningChips warnings={prediction.warnings} />
        <Alert className="explanation-card">
          <AlertTitle>解释来源：{prediction.explanation.source}</AlertTitle>
          <AlertDescription>{prediction.explanation.text}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function MetricCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <Card className="metric-card" size="sm">
      <CardContent>
        <span>{title}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </CardContent>
    </Card>
  );
}

function CoordinateReadout({ label, point, onClear }: { label: string; point: Point | null; onClear: () => void }) {
  return (
    <Card className="coordinate-readout" size="sm">
      <CardContent>
        <div>
          <span>{label}</span>
          <strong>{point ? `${formatNumber(point.x)}, ${formatNumber(point.y)}` : "未设置"}</strong>
        </div>
        {point ? (
          <Button type="button" variant="destructive" size="xs" onClick={onClear}>
            清除
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatusLine({ label, state }: { label: string; state: LoadState }) {
  const text = state.status === "error" ? state.message : state.status;
  return (
    <Card className={`status-line ${state.status}`} size="sm">
      <CardContent>
        <span>{label}</span>
        <strong>{text}</strong>
      </CardContent>
    </Card>
  );
}

function HealthBadge({ health }: { health: HealthState }) {
  if (health.status === "loading") {
    return <Badge className="health-badge pending" variant="secondary">检查后端中…</Badge>;
  }

  if (health.status === "error") {
    return <Badge className="health-badge error" variant="destructive">后端未连接：{health.message}</Badge>;
  }

  return (
    <Card className="health-badge ok" size="sm">
      <CardContent>
        <span>后端在线</span>
        <strong>{health.service}</strong>
        <small>
          v{health.version} · {health.environment}
        </small>
      </CardContent>
    </Card>
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
