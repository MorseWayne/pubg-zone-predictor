export type OpponentMatch = {
  match_id: string;
  created_at: string | null;
  map_name: string;
  game_mode: string;
  match_type: string;
};

export type OpponentRange = { limit: number } | { match_date: string };
export type OpponentHistory = {
  player_id: string;
  player_name: string;
  matches: OpponentMatch[];
  warnings: string[];
};
export type BoundPlayer = Pick<OpponentHistory, "player_id" | "player_name">;
export type PlayerBindings = { active: string; players: BoundPlayer[] };

export type Encounter = {
  player_id: string;
  name: string;
  kind: "human" | "bot" | "unknown";
  actions: string[];
};

export type EncounterList = { season: string | null; opponents: Encounter[] };
export type TeamMatchEncounters = {
  season: string | null;
  game_mode: string;
  match_type: string;
  opponents: Record<string, string[]>;
};
export type OpponentStats = { rounds: number; kd: number | null; adr: number | null; rank: string | null };
export type Mastery = { tier: number | null; level: number | null };

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
  telemetry_parse_profile: string | null;
  telemetry_position_interval_seconds: number | null;
  telemetry_parsed_at: string | null;
  replay_ready: boolean;
  circle_phase_count: number;
  position_sample_count: number;
  life_event_count: number;
};

export type MatchAnalysisPlayer = {
  player_id: string;
  player_name: string | null;
  team_id: string;
  team_rank: number | null;
  is_unknown_team: boolean;
};

export type MatchAnalysisCircle = {
  phase: number;
  elapsed_time: number;
  center: ApiPoint;
  radius: number;
  num_alive_teams: number | null;
  num_alive_players: number | null;
};

export type MatchAnalysisPosition = {
  player_id: string;
  team_id: string;
  phase: number | null;
  elapsed_time: number;
  point: ApiPoint;
  z: number | null;
  alive: boolean | null;
  health: number | null;
  movement_mode: "foot" | "vehicle" | null;
  vehicle_type: string | null;
  vehicle_id: string | null;
  vehicle_seat_index: number | null;
};

export type MatchAnalysisLifeEvent = {
  id: number;
  elapsed_time: number;
  phase: number | null;
  event_type: string;
  actor_player_id: string | null;
  actor_player_name: string | null;
  actor_team_id: string | null;
  victim_player_id: string | null;
  victim_player_name: string | null;
  victim_team_id: string | null;
  point: ApiPoint | null;
  damage: number | null;
  damage_causer_name: string | null;
  damage_reason: string | null;
};

export type MatchAnalysis = {
  match: IngestMatch;
  players: MatchAnalysisPlayer[];
  circles: MatchAnalysisCircle[];
  positions: MatchAnalysisPosition[];
  life_events: MatchAnalysisLifeEvent[];
};

export type DeleteMatchResult = {
  match_id: string;
  deleted: boolean;
  telemetry_cache_deleted: boolean;
  circle_phase_count: number;
  position_sample_count: number;
  life_event_count: number;
};

export type DeleteJobResult = {
  job_id: string;
  deleted: boolean;
};

export type PlayerSearchResult = {
  player_id: string;
  player_name: string;
  platform: string;
  recent_match_count: number;
};

export type LocalPlayer = {
  player_id: string;
  player_name: string | null;
  match_count: number;
  latest_match_at: string | null;
};

export type TeamDashboardPlayer = {
  player_id: string;
  player_name: string | null;
  match_count: number;
  wins: number;
  top3: number;
  avg_rank: number | null;
  kills: number;
  knocks: number;
  deaths: number;
  damage: number;
};

export type TeamDashboardMatch = {
  match_id: string;
  map_name: string;
  game_mode: string | null;
  created_at: string | null;
  duration: number | null;
  team_id: string;
  team_rank: number | null;
  players: TeamDashboardPlayer[];
  kills: number;
  damage: number;
};

export type TeamDashboard = {
  primary_player: LocalPlayer;
  teammates: TeamDashboardPlayer[];
  selected_players: TeamDashboardPlayer[];
  matches: TeamDashboardMatch[];
};

export type TeamDayBinding = {
  player_id: string;
  player_name: string;
  is_active: boolean;
};

export type TeamDaysViewRequest = {
  player_ids?: string[] | null;
  include_random_teammates?: boolean;
  require_all?: boolean;
  dates?: string[] | null;
  date_a?: string | null;
  date_b?: string | null;
  trend_limit?: number;
};

export type TeamDaysEnsureRequest = {
  player_ids?: string[] | null;
  include_random_teammates?: boolean;
  require_all?: boolean;
  dates: string[];
  manual_continue?: boolean;
};

export type TeamDaySummary = {
  date: string;
  match_count: number;
  first_match_at: string | null;
  last_match_at: string | null;
  contacts_count: number;
  unique_opponents: number;
  enemy_teams: number;
  maps: Record<string, number>;
  modes: Record<string, number>;
  normal_matches: number;
  ranked_matches: number;
  wins: number;
  top3: number;
};

export type TeamDayDataQuality = {
  damage_ready_matches: number;
  missing_damage_matches: number;
  missing_season_matches: number;
  season_backfill_pending: boolean;
};

export type TeamDayKdBand = {
  label: "<1" | "1–2" | "2–3" | "≥3";
  count: number;
};

export type TeamDayProfiles = {
  total_contacts: number;
  known_kd: number;
  known_adr: number;
  kd_p25: number | null;
  kd_p50: number | null;
  kd_p75: number | null;
  kd_ge_2_count: number;
  kd_ge_2_rate: number | null;
  kd_ge_3_count: number;
  kd_ge_3_rate: number | null;
  kd_bands: TeamDayKdBand[];
  adr_p50: number | null;
  adr_p75: number | null;
  observed_min_at: number | null;
  observed_max_at: number | null;
  missing_fillable_count: number;
  unfillable_count: number;
};

export type TeamDayPressure = {
  opponent_damage_p50: number | null;
  opponent_damage_p75: number | null;
  opponent_avg_kills: number | null;
  high_firepower_teams: number;
  high_firepower_team_total: number;
  high_firepower_team_rate: number | null;
  team_kills_vs_humans: number;
  team_deaths_to_humans: number;
  team_damage_taken_per_match: number | null;
  team_damage_dealt_per_match: number | null;
};

export type TeamDayLobby = {
  total_players: number;
  human_count: number;
  bot_count: number;
  unknown_count: number;
  bot_rate: number | null;
  lobby_damage_p50: number | null;
  lobby_damage_p75: number | null;
};

export type TeamDayPerformanceMatchPlayer = {
  player_id: string;
  player_name: string;
};

export type TeamDayPerformanceMatch = {
  match_id: string;
  created_at: string | null;
  map_name: string;
  game_mode: "duo" | "duo-fpp" | "squad" | "squad-fpp";
  match_type: string | null;
  team_rank: number | null;
  kills: number;
  damage: number | null;
  players: TeamDayPerformanceMatchPlayer[];
};

export type TeamDayPerformanceMember = {
  player_id: string;
  player_name: string;
  match_count: number;
  kills: number;
  knocks: number;
  deaths: number;
  wins: number;
  top3: number;
  damage: number | null;
  avg_rank: number | null;
};

export type TeamDayOpponentDetail = {
  player_id: string;
  player_name: string;
  encounters: number;
  kd: number | null;
  adr: number | null;
  match_damage_avg: number | null;
  match_kills_total: number;
  observed_at: number | null;
  profile_status: "known" | "partial" | "missing" | "unfillable";
};

export type TeamDayPayload = {
  summary: TeamDaySummary;
  data_quality: TeamDayDataQuality;
  profiles: TeamDayProfiles;
  pressure: TeamDayPressure;
  lobby: TeamDayLobby;
  team_performance: {
    matches: TeamDayPerformanceMatch[];
    members: TeamDayPerformanceMember[];
  };
  opponents_detail: TeamDayOpponentDetail[];
  from_disk_cache: boolean;
};

export type TeamDayTrendPoint = {
  date: string;
  match_count: number;
  contacts_count: number;
  unique_opponents: number;
  maps: Record<string, number>;
  kd_p50: number | null;
  kd_known: number;
  kd_total: number;
  adr_p50: number | null;
  opponent_damage_p50: number | null;
  team_damage_taken_per_match: number | null;
  bot_rate: number | null;
  from_disk_cache: boolean;
};

export type TeamDayWarning = {
  code:
    | "SAME_DAY"
    | "SMALL_SAMPLE"
    | "NO_MAP_OVERLAP"
    | "MODE_MIX_DIFFERS"
    | "LOW_COVERAGE"
    | "MISSING_SEASON";
  message: string;
};

export type TeamDayFillState =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "no_api_key"
  | "disabled"
  | "auth_error"
  | "busy"
  | "budget_exhausted"
  | "cancelled"
  | "failed";

export type TeamDayFillJob = {
  job_id: string | null;
  state: TeamDayFillState;
  promoted: number;
  remaining: number;
  requests_used: number;
  request_budget: number;
  revision: number;
  retry_after: number;
};

export type TeamDayFillHint = {
  api_key_configured: boolean;
  missing_fillable_a: number;
  missing_fillable_b: number;
  missing_fillable_total: number;
  cache_promotable: number;
  estimated_requests: number;
  active_job: TeamDayFillJob | null;
};

export type TeamDaysViewResponse = {
  timezone: string;
  bindings: TeamDayBinding[];
  selected_player_ids: string[];
  require_all: boolean;
  min_members: number;
  selection_warning: string | null;
  available_dates: string[];
  selected_dates: string[];
  days: TeamDayPayload[];
  date_a: string | null;
  date_b: string | null;
  day_a: TeamDayPayload | null;
  day_b: TeamDayPayload | null;
  trend: TeamDayTrendPoint[];
  warnings: TeamDayWarning[];
  fill_hint: TeamDayFillHint;
  cache_stats: {
    hit_days: number;
    computed_days: number;
  };
};

export type PersonalTrendMatch = {
  match_id: string;
  map_name: string;
  game_mode: string | null;
  created_at: string | null;
  team_rank: number | null;
  kills: number;
  knocks: number;
  deaths: number;
  damage: number;
  score: number;
};

export type PersonalTrendWindow = {
  label: string;
  match_count: number;
  wins: number;
  top3: number;
  avg_rank: number | null;
  kills: number;
  knocks: number;
  deaths: number;
  damage: number;
  avg_kills: number;
  avg_damage: number;
  score: number;
};

export type PersonalTrend = {
  primary_player: LocalPlayer;
  trend: "improving" | "declining" | "stable" | "insufficient_data";
  score_delta: number | null;
  damage_delta: number | null;
  kills_delta: number | null;
  rank_delta: number | null;
  early: PersonalTrendWindow;
  recent: PersonalTrendWindow;
  matches: PersonalTrendMatch[];
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
    split: "train" | "validation";
    map_id: string;
    current_phase: number;
    target_type: "next" | "final";
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
  playerBindings: (signal: AbortSignal) =>
    apiRequest<PlayerBindings>("/api/player-bindings", { signal, cache: "no-store" }),
  importPlayerBindings: (bindings: PlayerBindings, signal: AbortSignal) =>
    apiRequest<PlayerBindings>("/api/player-bindings/import", {
      method: "POST", body: JSON.stringify(bindings), signal,
    }),
  selectPlayer: (player: BoundPlayer) =>
    apiRequest<PlayerBindings>("/api/player-bindings/active", {
      method: "PUT", body: JSON.stringify(player),
    }),
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
  listLocalPlayers: async (limit = 50) =>
    apiRequest<{ players: LocalPlayer[] }>(`/api/ingest/players/local${toQuery({ limit })}`),
  playerHistory: (query: string, signal?: AbortSignal, matchDate?: string, refresh = false) =>
    apiRequest<OpponentHistory>(`/api/ingest/players/recent${toQuery({ query, match_date: matchDate, refresh: refresh || undefined })}`, { signal }),
  playerMatches: (playerId: string, signal: AbortSignal, matchDate?: string) =>
    apiRequest<{ matches: IngestMatch[] }>(
      `/api/ingest/matches${toQuery({ player_id: playerId, limit: matchDate ? undefined : 20, match_date: matchDate })}`, { signal }),
  prepareMatch: (matchId: string, playerId: string, signal: AbortSignal) =>
    apiRequest<IngestMatch>(
      `/api/ingest/matches/${encodeURIComponent(matchId)}/prepare${toQuery({ player_id: playerId })}`,
      { method: "POST", signal }),
  getTeamDashboard: async (payload: {
    player_id: string;
    teammate_ids: string[];
    match_limit?: number;
    teammate_candidate_limit?: number;
    match_date?: string;
    match_ids?: string[];
  }) =>
    apiRequest<TeamDashboard>("/api/ingest/players/team-dashboard", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  opponentHistory: (name: string, range: OpponentRange, signal: AbortSignal) =>
    apiRequest<OpponentHistory>(`/api/opponents/recent${toQuery({ name, ...range })}`, { signal }),
  matchEncounters: (match: string, player: string, signal: AbortSignal) =>
    apiRequest<EncounterList>(
      `/api/opponents/matches/${encodeURIComponent(match)}${toQuery({ player_id: player })}`, { signal },
    ),
  teamMatchEncounters: (matchId: string, playerIds: string[], signal: AbortSignal) =>
    apiRequest<TeamMatchEncounters>(`/api/opponents/matches/${encodeURIComponent(matchId)}/team`, {
      method: "POST", signal, body: JSON.stringify({ player_ids: playerIds, full_team: true }),
    }),
  cachedOpponentProfiles: (ids: string[], group: { season: string; mode: string; ranked: boolean } | undefined, signal: AbortSignal) =>
    apiRequest<{ stats: Record<string, OpponentStats | null>; mastery: Record<string, Mastery> }>(
      "/api/opponents/profiles/cached", {
        method: "POST", signal, body: JSON.stringify({ player_ids: ids, ...group }),
      }),
  opponentStats: (season: string, mode: string, ranked: boolean, ids: string[], signal: AbortSignal) =>
    apiRequest<Record<string, OpponentStats | null>>("/api/opponents/stats", {
      method: "POST", signal, body: JSON.stringify({ season, mode, ranked, player_ids: ids }),
    }),
  opponentMastery: (id: string, signal: AbortSignal) =>
    apiRequest<Mastery>(`/api/opponents/mastery/${encodeURIComponent(id)}`, { signal }),
  teamDaysView: (body: TeamDaysViewRequest, signal?: AbortSignal) =>
    apiRequest<TeamDaysViewResponse>("/api/opponents/team-days/view", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  teamDaysEnsure: (body: TeamDaysEnsureRequest, signal?: AbortSignal) =>
    apiRequest<TeamDayFillJob>("/api/opponents/team-days/ensure", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  teamDaysFillStatus: (jobId: string, signal?: AbortSignal) =>
    apiRequest<TeamDayFillJob>(`/api/opponents/team-days/fills/${encodeURIComponent(jobId)}`, {
      signal,
      cache: "no-store",
    }),
  teamDaysFillCancel: (jobId: string) =>
    apiRequest<TeamDayFillJob>(
      `/api/opponents/team-days/fills/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    ),
  getPersonalTrend: async (payload: { player_id: string; match_limit?: number; match_date?: string; match_ids?: string[] }) =>
    apiRequest<PersonalTrend>("/api/ingest/players/personal-trend", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  listMatches: async (limit = 50) =>
    apiRequest<{ matches: IngestMatch[] }>(`/api/ingest/matches${toQuery({ limit })}`),
  getMatchAnalysis: async (matchId: string) =>
    apiRequest<MatchAnalysis>(`/api/ingest/matches/${encodeURIComponent(matchId)}/analysis`),
  listIngestJobs: async (limit = 20) =>
    apiRequest<{ jobs: IngestJob[] }>(`/api/ingest/jobs${toQuery({ limit })}`),
  getIngestJob: async (jobId: string) => apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}`),
  cancelIngestJob: async (jobId: string) =>
    apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}/cancel`, { method: "POST" }),
  cancelIngestJobs: async (jobIds: string[]) =>
    apiRequest<{ jobs: IngestJob[] }>("/api/ingest/jobs/cancel", {
      method: "POST",
      body: JSON.stringify({ job_ids: jobIds }),
    }),
  retryIngestJob: async (jobId: string) =>
    apiRequest<IngestJob>(`/api/ingest/jobs/${jobId}/retry`, { method: "POST" }),
  retryIngestJobs: async (jobIds: string[]) =>
    apiRequest<{ jobs: IngestJob[] }>("/api/ingest/jobs/retry", {
      method: "POST",
      body: JSON.stringify({ job_ids: jobIds }),
    }),
  deleteIngestJob: async (jobId: string) =>
    apiRequest<DeleteJobResult>(`/api/ingest/jobs/${jobId}`, { method: "DELETE" }),
  deleteIngestJobs: async (jobIds: string[]) =>
    apiRequest<{ deleted_count: number; jobs: DeleteJobResult[] }>("/api/ingest/jobs", {
      method: "DELETE",
      body: JSON.stringify({ job_ids: jobIds }),
    }),
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
