export type ApiPoint = { x: number; y: number };

export type MapConfig = {
  map_id: string;
  display_name: string;
  world_size: number;
  assets: Record<string, string>;
};

export type MapAsset = {
  map_id: string;
  asset_key: string;
  relative_path: string;
  cached: boolean;
  downloaded: boolean;
  image_url: string;
  warnings: string[];
};

export type ZonePhase = {
  phase: number;
  radius: number;
  label: string;
  enabled: boolean;
  is_final_candidate?: boolean;
};

export type ZonePhaseConfig = {
  map_id: string;
  game_mode: string;
  final_phase: number;
  supported_prediction_phases: number[];
  phases: ZonePhase[];
};

export type IngestJob = {
  id: string;
  job_type: string;
  status: string;
  source_ref: string | null;
  total_count: number;
  success_count: number;
  skipped_count: number;
  failed_count: number;
  retry_count: number;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
};

export type IngestMatch = {
  match_id: string;
  map_name: string | null;
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

export type DeleteMatchResult = {
  match_id: string;
  deleted: boolean;
  telemetry_cache_deleted: boolean;
  circle_phase_count: number;
  position_sample_count: number;
  life_event_count: number;
};

export type PlayerSearchResult = {
  player_id: string;
  player_name: string;
  platform: string;
  recent_match_count: number;
};

export type HotspotResult = {
  map_id: string;
  phase: number;
  grid_size: number;
  generated_at: string;
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

export type ModelRun = {
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

export type PredictResponse = {
  map_id: string;
  current_phase: number;
  next_circle: {
    phase: number;
    center: ApiPoint;
    radius: number;
    source: string;
    sample_count: number | null;
  };
  final_circle: {
    phase: number;
    center: ApiPoint;
    radius: number;
    source: string;
    sample_count: number | null;
  };
  route: {
    strategy: string;
    target: ApiPoint;
    waypoints: ApiPoint[];
    route_score: number;
    risk_summary: {
      hotspot_risk: string;
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
  explanation: {
    source: string;
    text: string;
  };
  model_run_id: string | null;
  warnings: string[];
};

type QueryValue = string | number | boolean | null | undefined;

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toQuery(params: Record<string, QueryValue>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) query.set(key, String(value));
  });
  const value = query.toString();
  return value ? `?${value}` : "";
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      error?.message ?? response.statusText,
      response.status,
      error?.code,
      error?.details,
    );
  }
  return body as T;
}

export function apiErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) return error.message;
  return "请求失败，请检查后端服务。";
}

export const api = {
  listMaps: async () => apiRequest<{ maps: MapConfig[] }>("/api/config/maps"),
  getZonePhases: async (mapId: string) =>
    apiRequest<ZonePhaseConfig>(`/api/config/zone-phases${toQuery({ map_id: mapId })}`),
  mapImageUrl: (mapId: string, assetKey = "high") =>
    `/api/assets/maps/${mapId}/image${toQuery({ asset_key: assetKey })}`,
  ensureMapAsset: async (mapId: string, assetKey = "high") =>
    apiRequest<MapAsset>(
      `/api/assets/maps/${mapId}/ensure${toQuery({ asset_key: assetKey })}`,
      { method: "POST" },
    ),
  startSquadSampleIngest: async (params: {
    maxMatches: number;
    parseProfile: "full" | "hotspot_light" | "zone_only";
    positionIntervalSeconds: number;
  }) =>
    apiRequest<IngestJob>(
      `/api/ingest/samples/squad${toQuery({
        max_matches: params.maxMatches,
        parse_profile: params.parseProfile,
        position_interval_seconds: params.positionIntervalSeconds,
      })}`,
      { method: "POST" },
    ),
  startPlayerIngest: async (params: {
    platform: string;
    playerNames: string[];
    gameMode: string;
    maxMatchesPerPlayer: number;
    parseProfile: "full" | "hotspot_light" | "zone_only";
    positionIntervalSeconds: number;
  }) =>
    apiRequest<IngestJob>("/api/ingest/players", {
      method: "POST",
      body: JSON.stringify({
        platform: params.platform,
        player_names: params.playerNames,
        game_mode: params.gameMode,
        max_matches_per_player: params.maxMatchesPerPlayer,
        parse_profile: params.parseProfile,
        position_interval_seconds: params.positionIntervalSeconds,
      }),
    }),
  searchPlayers: async (params: { platform: string; query: string }) =>
    apiRequest<{ players: PlayerSearchResult[] }>(
      `/api/ingest/players/search${toQuery({
        platform: params.platform,
        query: params.query,
      })}`,
    ),
  listMatches: async (limit = 50) =>
    apiRequest<{ matches: IngestMatch[] }>(`/api/ingest/matches${toQuery({ limit })}`),
  listIngestJobs: async (limit = 20) =>
    apiRequest<{ jobs: IngestJob[] }>(`/api/ingest/jobs${toQuery({ limit })}`),
  getIngestJob: async (jobId: string) => apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}`),
  cancelIngestJob: async (jobId: string) =>
    apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}/cancel`, { method: "POST" }),
  retryIngestJob: async (jobId: string) =>
    apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}/retry`, { method: "POST" }),
  deleteMatch: async (matchId: string) =>
    apiRequest<DeleteMatchResult>(`/api/ingest/matches/${matchId}`, { method: "DELETE" }),
  deleteMatches: async (matchIds: string[]) =>
    apiRequest<{ deleted_count: number; matches: DeleteMatchResult[] }>("/api/ingest/matches", {
      method: "DELETE",
      body: JSON.stringify({ match_ids: matchIds }),
    }),
  generateHotspots: async (mapId: string, phase: number) =>
    apiRequest<HotspotResult>(
      `/api/hotspots/generate${toQuery({ map_id: mapId, phase })}`,
      { method: "POST" },
    ),
  trainModel: async (mapId?: string) =>
    apiRequest<ModelRun>(`/api/training/runs${toQuery({ map_id: mapId })}`, { method: "POST" }),
  listTrainingRuns: async (limit = 20) =>
    apiRequest<{ runs: ModelRun[] }>(`/api/training/runs${toQuery({ limit })}`),
  predictZone: async (payload: {
    map_id: string;
    current_phase: number;
    current_circle_center: ApiPoint;
    team_area: ApiPoint;
    route_strategy: string;
    use_llm_explanation: boolean;
  }) => apiRequest<PredictResponse>("/api/predict", { method: "POST", body: JSON.stringify(payload) }),
};
