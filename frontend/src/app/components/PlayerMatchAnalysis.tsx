import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Slider } from "@astryxdesign/core/Slider";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Item } from "@astryxdesign/core/Item";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import {
  Eye,
  EyeOff,
  Loader2,
  MapPinned,
  RefreshCw,
  RotateCcw,
  Route,
  Shield,
  Skull,
  Swords,
  ZoomIn,
  ZoomOut,
  GripVertical,
  Play,
  Pause,
  Plane,
  Radio,
} from "lucide-react";
import {
  api,
  apiErrorMessage,
  ApiPoint,
  IngestMatch,
  MapConfig,
  MatchAnalysis,
  MatchAnalysisLifeEvent,
  MatchAnalysisPosition,
  MatchAnalysisPlayer,
} from "../api";
import { cn } from "../../lib/utils";

const MAP_VIEW_SIZE = 1000;
const MAX_MAP_SCALE = 64;
const PLAYBACK_SPEEDS = [0.5, 1, 2, 5, 10, 16, 20, 32] as const;
const MAP_NAME_ALIASES: Record<string, string> = {
  Baltic_Main: "erangel",
  Erangel_Main: "erangel",
  Chimera_Main: "paramo",
  Desert_Main: "miramar",
  DihorOtok_Main: "vikendi",
  Kiki_Main: "deston",
  Neon_Main: "rondo",
  Savage_Main: "sanhok",
  Summerland_Main: "karakin",
  Tiger_Main: "taego",
};
const PLAYER_COLORS = [
  "#f97316",
  "#38bdf8",
  "#a78bfa",
  "#22c55e",
  "#f43f5e",
  "#eab308",
  "#14b8a6",
  "#fb7185",
];
const TEAM_COLORS = [
  "#fbbf24",
  "#38bdf8",
  "#2dd4bf",
  "#a78bfa",
  "#fb7185",
  "#84cc16",
  "#f97316",
  "#60a5fa",
  "#e879f9",
  "#4ade80",
  "#facc15",
  "#22d3ee",
  "#c084fc",
  "#f87171",
  "#a3e635",
  "#fb923c",
  "#818cf8",
  "#34d399",
  "#eab308",
  "#06b6d4",
  "#d946ef",
  "#ef4444",
  "#65a30d",
  "#ea580c",
  "#2563eb",
  "#0d9488",
  "#9333ea",
  "#e11d48",
  "#4d7c0f",
  "#c2410c",
  "#1d4ed8",
  "#0f766e",
];
const AIRBORNE_Z_MIN = 10000;
const AIRBORNE_DESCENT_Z_DELTA = 1000;
const FLIGHT_PATH_EARLY_WINDOW_SECONDS = 180;
const FLIGHT_PATH_MIN_POINTS = 6;
const PLAYER_LABEL_ZOOM_THRESHOLD = 1.7;
const PLAYER_MARKER_LABEL_HEIGHT = 21;
const PLAYER_MARKER_LABEL_Y = 7;
const PLAYER_MARKER_RADIUS = 9.5;
const FIRE_TRACER_MIN_REPLAY_DURATION_SECONDS = 2.5;
const FIRE_TRACER_SCREEN_DURATION_SECONDS = 1.2;
const PLAYBACK_RENDER_INTERVAL_MS = 1000 / 20;

type LayerId = "route" | "combat" | "eliminations" | "zones" | "flightPath";
const layerControls = [
  { id: "route", label: "路线", icon: Route },
  { id: "combat", label: "交战", icon: Swords },
  { id: "eliminations", label: "淘汰", icon: Skull },
  { id: "zones", label: "安全区", icon: Shield },
  { id: "flightPath", label: "航线", icon: Plane },
] as const;

type TeamSummary = {
  teamId: string;
  teamRank: number | null;
  players: MatchAnalysisPlayer[];
};
type MapTransform = {
  x: number;
  y: number;
  scale: number;
};
type MapDragStart = {
  mouseX: number;
  mouseY: number;
  startX: number;
  startY: number;
};
type MapFocusNotice = {
  tone: "info" | "warning";
  title: string;
  description: string;
};
type PlayerGroundSegment = {
  id: string;
  playerId: string;
  positions: MatchAnalysisPosition[];
};
type PlayerRouteSegment = PlayerGroundSegment & {
  path: string;
};
type FlightLine = {
  center: ApiPoint;
  direction: ApiPoint;
};
type PlayerReplayStats = {
  kills: number;
  knocks: number;
  damage: number;
  deadAt: number | null;
  knockedDown: boolean;
};
type ReplayCounterPoint = {
  elapsedTime: number;
  value: number;
};
type ReplayBooleanPoint = {
  elapsedTime: number;
  value: boolean;
};
type PlayerReplayTimeline = {
  kills: ReplayCounterPoint[];
  knocks: ReplayCounterPoint[];
  damage: ReplayCounterPoint[];
  knockedDown: ReplayBooleanPoint[];
  eliminatedAt: number | null;
};
type TeamReplayRow = {
  team: TeamSummary;
  color: string;
  aliveCount: number;
  kills: number;
  damage: number;
  eliminatedAt: number | null;
  displayRank: number | null;
};

function markerWidthForLabel(label: string) {
  return Math.max(52, Math.min(132, label.length * 7.1 + 14));
}

function matchTitle(match: IngestMatch) {
  const mapName = match.map_name?.replace(/_Main$/, "") ?? "未知地图";
  const createdAt = match.created_at ? new Date(match.created_at).toLocaleString("zh-CN", { hour12: false }) : "未知时间";
  return `${mapName} · ${createdAt}`;
}

function formatDuration(seconds: number | null | undefined) {
  if (!seconds) return "未知";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function playerDisplayName(player: MatchAnalysisPlayer) {
  return player.player_name ?? player.player_id.replace(/^account\./, "");
}

function mapForMatch(match: IngestMatch | null, maps: MapConfig[]) {
  if (!match?.map_name) return maps[0] ?? null;
  const alias = MAP_NAME_ALIASES[match.map_name];
  return maps.find((map) => map.map_id === alias) ?? maps.find((map) => map.display_name === match.map_name) ?? maps[0] ?? null;
}

function playerColor(playerId: string | null | undefined, team: TeamSummary | undefined) {
  if (!playerId || !team) return "#94a3b8";
  const index = Math.max(0, team.players.findIndex((player) => player.player_id === playerId));
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

function teamColor(teamId: string, teams: TeamSummary[]) {
  const index = Math.max(0, teams.findIndex((team) => team.teamId === teamId));
  return TEAM_COLORS[index % TEAM_COLORS.length];
}

function markerTextColor(color: string) {
  const value = color.replace("#", "");
  if (value.length !== 6) return "#ffffff";
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
  return luminance >= 150 ? "#111827" : "#ffffff";
}

function movementStateLabel(position: MatchAnalysisPosition) {
  if (position.movement_mode === "foot") return "步行";
  if (position.movement_mode !== "vehicle") return "移动状态未知";

  const vehicle =
    position.vehicle_id?.replace(/_C$/, "").replace(/_/g, " ") ??
    position.vehicle_type ??
    "载具";
  const seat =
    position.vehicle_seat_index === 0
      ? "驾驶"
      : position.vehicle_seat_index !== null
        ? `乘员座位 ${position.vehicle_seat_index}`
        : "乘车";
  return `${seat} · ${vehicle}`;
}

function interpolatePosition(
  positions: MatchAnalysisPosition[],
  playbackTime: number,
): MatchAnalysisPosition | null {
  if (positions.length === 0 || playbackTime < positions[0].elapsed_time) return null;

  let low = 0;
  let high = positions.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (positions[middle].elapsed_time <= playbackTime) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previous = positions[Math.max(0, high)];
  const next = positions[high + 1];
  if (!next || next.elapsed_time - previous.elapsed_time > 15) {
    return previous;
  }

  const span = next.elapsed_time - previous.elapsed_time;
  const ratio = span <= 0 ? 0 : (playbackTime - previous.elapsed_time) / span;
  return {
    ...previous,
    elapsed_time: playbackTime,
    point: {
      x: previous.point.x + (next.point.x - previous.point.x) * ratio,
      y: previous.point.y + (next.point.y - previous.point.y) * ratio,
    },
    z:
      previous.z !== null && next.z !== null
        ? previous.z + (next.z - previous.z) * ratio
        : previous.z,
    health:
      previous.health !== null && next.health !== null
        ? previous.health + (next.health - previous.health) * ratio
        : previous.health,
  };
}

function replayEventLabel(event: MatchAnalysisLifeEvent) {
  const actor = event.actor_player_name ?? "环境";
  const victim = event.victim_player_name ?? "未知玩家";
  const details = replayDamageDetails(event);
  let label = `${actor} 对 ${victim} 造成伤害`;
  if (isEliminationEvent(event)) label = `${actor} 淘汰 ${victim}`;
  if (event.event_type === "LogPlayerMakeGroggy") label = `${actor} 击倒 ${victim}`;
  if (event.event_type === "LogPlayerRevive") label = `${actor} 救起 ${victim}`;
  return details ? `${label} · ${details}` : label;
}

function replayDamageDetails(event: MatchAnalysisLifeEvent) {
  const causer = event.damage_causer_name
    ?.replace(/^Weap/, "")
    .replace(/_C$/, "")
    .replace("AK47", "AKM");
  const reason = {
    HeadShot: "爆头",
    TorsoShot: "身体",
    PelvisShot: "腰部",
    ArmShot: "手臂",
    LegShot: "腿部",
  }[event.damage_reason ?? ""];
  return [causer, reason].filter(Boolean).join(" / ");
}

function pointToView(point: { x: number; y: number }, worldSize: number) {
  return {
    x: (point.x / worldSize) * MAP_VIEW_SIZE,
    y: (point.y / worldSize) * MAP_VIEW_SIZE,
  };
}

function radiusToView(radius: number, worldSize: number) {
  return (radius / worldSize) * MAP_VIEW_SIZE;
}

function routePath(positions: MatchAnalysisPosition[], worldSize: number) {
  if (positions.length < 2) return null;
  return positions
    .map((position, index) => {
      const point = pointToView(position.point, worldSize);
      return `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`;
    })
    .join(" ");
}

function groupedPositions(positions: MatchAnalysisPosition[]) {
  const groups: Record<string, MatchAnalysisPosition[]> = {};
  for (const position of positions) {
    (groups[position.player_id] ??= []).push(position);
  }
  return groups;
}

function upperBoundByElapsedTime<T extends { elapsed_time: number }>(
  entries: T[],
  playbackTime: number,
) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].elapsed_time <= playbackTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function replayTimelineValueAt<T>(
  entries: Array<{ elapsedTime: number; value: T }>,
  playbackTime: number,
  fallback: T,
) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].elapsedTime <= playbackTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low === 0 ? fallback : entries[low - 1].value;
}

function squaredDistance(left: ApiPoint, right: ApiPoint) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fitPrincipalLine(points: ApiPoint[]): FlightLine | null {
  if (points.length < 2) return null;

  const center = points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
    { x: 0, y: 0 },
  );
  center.x /= points.length;
  center.y /= points.length;

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }

  if (xx === 0 && yy === 0) return null;

  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  return {
    center,
    direction: { x: Math.cos(angle), y: Math.sin(angle) },
  };
}

function perpendicularDistance(point: ApiPoint, line: FlightLine) {
  const dx = point.x - line.center.x;
  const dy = point.y - line.center.y;
  return Math.abs(dx * -line.direction.y + dy * line.direction.x);
}

function projectedSpan(points: ApiPoint[], line: FlightLine) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const projection =
      (point.x - line.center.x) * line.direction.x +
      (point.y - line.center.y) * line.direction.y;
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }

  return { min, max };
}

function buildFlightPathFromPoints(points: ApiPoint[], worldSize: number) {
  const uniquePoints = points.filter(
    (point, index) => points.findIndex((candidate) => squaredDistance(candidate, point) < 1) === index,
  );
  if (uniquePoints.length < 2) return null;

  const initialLine = fitPrincipalLine(uniquePoints);
  if (!initialLine) return null;

  const residuals = uniquePoints.map((point) => perpendicularDistance(point, initialLine));
  const residualLimit = Math.max(
    worldSize * 0.015,
    Math.min(worldSize * 0.08, median(residuals) * 2.5),
  );
  const inliers = uniquePoints.filter((point) => perpendicularDistance(point, initialLine) <= residualLimit);

  const line = inliers.length >= FLIGHT_PATH_MIN_POINTS
    ? fitPrincipalLine(inliers) ?? initialLine
    : initialLine;

  const pathPoints = inliers.length >= 2 ? inliers : uniquePoints;
  const span = projectedSpan(pathPoints, line);
  if (!Number.isFinite(span.min) || !Number.isFinite(span.max) || span.max - span.min <= 0) return null;

  const extension = worldSize * 2;
  const startProjection = span.min - extension;
  const endProjection = span.max + extension;

  return {
    start: pointToView(
      {
        x: line.center.x + line.direction.x * startProjection,
        y: line.center.y + line.direction.y * startProjection,
      },
      worldSize,
    ),
    end: pointToView(
      {
        x: line.center.x + line.direction.x * endProjection,
        y: line.center.y + line.direction.y * endProjection,
      },
      worldSize,
    ),
  };
}

function inferFlightPath(positions: MatchAnalysisPosition[], worldSize: number) {
  if (positions.length < 2) return null;

  const airborne = positions
    .filter((position) => position.z !== null && position.z >= AIRBORNE_Z_MIN)
    .sort((left, right) => left.elapsed_time - right.elapsed_time);
  const earliestAirborneTime = airborne[0]?.elapsed_time;

  if (earliestAirborneTime !== undefined) {
    const earlyAirborne = airborne.filter(
      (position) => position.elapsed_time <= earliestAirborneTime + FLIGHT_PATH_EARLY_WINDOW_SECONDS,
    );
    const preCircleAirborne = airborne.filter((position) => position.phase === null);
    const candidateSets = [earlyAirborne, preCircleAirborne, airborne].filter(
      (candidates) => candidates.length >= 2,
    );

    for (const candidates of candidateSets) {
      const fittedPath = buildFlightPathFromPoints(candidates.map((position) => position.point), worldSize);
      if (fittedPath) return fittedPath;
    }
  }

  const firstPositions = new Map<string, ApiPoint>();
  for (const position of positions) {
    if (!firstPositions.has(position.player_id)) {
      firstPositions.set(position.player_id, position.point);
    }
  }

  return buildFlightPathFromPoints(Array.from(firstPositions.values()), worldSize);
}

function isOutsideMap(position: MatchAnalysisPosition, worldSize: number) {
  const { x, y } = position.point;
  return x < 0 || y < 0 || x > worldSize || y > worldSize;
}

function isStillDescendingFromAir(position: MatchAnalysisPosition, nextPosition: MatchAnalysisPosition | undefined) {
  return (
    position.z !== null &&
    nextPosition !== undefined &&
    nextPosition.z !== null &&
    position.z - nextPosition.z > AIRBORNE_DESCENT_Z_DELTA
  );
}

function groundedPositionSegments(positions: MatchAnalysisPosition[], worldSize: number) {
  const phaseStartIndex = positions.findIndex((position) => position.phase !== null);
  const candidates = phaseStartIndex >= 0 ? positions.slice(phaseStartIndex) : positions;

  const segments: MatchAnalysisPosition[][] = [];
  let currentSegment: MatchAnalysisPosition[] = [];
  let skippedAirborne = false;

  for (let index = 0; index < candidates.length; index += 1) {
    const position = candidates[index];
    const nextPosition = candidates[index + 1];
    const isClearlyAirborne =
      (position.z !== null && position.z >= AIRBORNE_Z_MIN) ||
      (position.z !== null && isOutsideMap(position, worldSize));
    const isAirborneDescent =
      skippedAirborne && isStillDescendingFromAir(position, nextPosition);

    if (isClearlyAirborne || isAirborneDescent) {
      skippedAirborne = true;
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      continue;
    }

    skippedAirborne = false;
    currentSegment.push(position);
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

function isSquadMatch(match: IngestMatch) {
  return match.game_mode === "squad" || match.game_mode === "squad-fpp";
}

function teamSummaries(players: MatchAnalysisPlayer[]) {
  const grouped = players.reduce<Record<string, MatchAnalysisPlayer[]>>((groups, player) => {
    groups[player.team_id] = [...(groups[player.team_id] ?? []), player];
    return groups;
  }, {});
  return Object.entries(grouped)
    .map(([teamId, teamPlayers]) => ({
      teamId,
      teamRank: teamPlayers.find((player) => player.team_rank !== null)?.team_rank ?? null,
      players: teamPlayers,
    }))
    .sort((left, right) => {
      const leftRank = left.teamRank ?? 999;
      const rightRank = right.teamRank ?? 999;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.teamId.localeCompare(right.teamId);
    });
}

function isEliminationEvent(event: MatchAnalysisLifeEvent) {
  return event.event_type === "LogPlayerKill" || event.event_type === "LogPlayerKillV2";
}

function isFireTracerEvent(event: MatchAnalysisLifeEvent) {
  return (
    event.event_type === "LogPlayerAttack" &&
    event.actor_player_id !== null &&
    event.victim_player_id !== null &&
    event.actor_player_id !== event.victim_player_id
  );
}

function eventTeamPlayerId(event: MatchAnalysisLifeEvent, teamId: string) {
  if (event.actor_team_id === teamId) return event.actor_player_id;
  if (event.victim_team_id === teamId) return event.victim_player_id;
  return null;
}

function clampMapTransform(transform: MapTransform, width: number, height: number): MapTransform {
  if (transform.scale <= 1 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  return {
    x: Math.max(width * (1 - transform.scale), Math.min(transform.x, 0)),
    y: Math.max(height * (1 - transform.scale), Math.min(transform.y, 0)),
    scale: transform.scale,
  };
}

function formatPlaybackTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const TeamReplayList = memo(function TeamReplayList({
  teamRows,
  playerStats,
  selectedTeamId,
  selectedPlayerId,
  onSelectTeam,
  onSelectPlayer,
}: {
  teamRows: TeamReplayRow[];
  playerStats: Record<string, PlayerReplayStats>;
  selectedTeamId: string;
  selectedPlayerId: string | null;
  onSelectTeam: (teamId: string) => void;
  onSelectPlayer: (player: MatchAnalysisPlayer) => void;
}) {
  return (
    <ScrollableArea label="队伍和选手" height="100%">
      <div className="flex flex-col gap-2 p-2">
        {teamRows.map((row) => (
          <div
            key={row.team.teamId}
            className={cn(
              "overflow-hidden rounded-md border border-border bg-muted/20 [content-visibility:auto] [contain-intrinsic-size:auto_148px]",
              row.team.teamId === selectedTeamId && "bg-muted ring-1 ring-primary/30",
            )}
            style={{ borderLeftColor: row.color, borderLeftWidth: 4 }}
            data-team-row={row.team.teamId}
          >
            <Item
              density="compact"
              isSelected={row.team.teamId === selectedTeamId}
              onClick={() => onSelectTeam(row.team.teamId)}
              startContent={<strong style={{ color: row.color }}>{row.team.teamId}</strong>}
              label={row.aliveCount > 0 ? `${row.aliveCount} 人存活` : "全队淘汰"}
              description={row.displayRank ? `当前 #${row.displayRank}` : "仍在争夺排名"}
              endContent={
                <span className="flex gap-3 text-xs tabular-nums">
                  <span>{row.kills}</span>
                  <span>{Math.round(row.damage)}</span>
                </span>
              }
            />
            <div className="border-t border-border/70 px-2 py-1">
              {row.team.players.map((player) => {
                const stats = playerStats[player.player_id] ?? {
                  kills: 0,
                  knocks: 0,
                  damage: 0,
                  deadAt: null,
                  knockedDown: false,
                };
                const isSelected = player.player_id === selectedPlayerId;
                return (
                  <Item
                    key={player.player_id}
                    density="compact"
                    isSelected={isSelected}
                    onClick={() => onSelectPlayer(player)}
                    label={
                      <span className={cn("text-xs", stats.deadAt !== null && "line-through")}>
                        {playerDisplayName(player)}
                      </span>
                    }
                    startContent={
                      stats.deadAt !== null && (
                        <Skull
                          className="size-3 text-red-400"
                          aria-label={`已于 ${formatPlaybackTime(stats.deadAt)} 被淘汰`}
                        />
                      )
                    }
                    endContent={
                      <span className="grid grid-cols-[30px_30px_48px] text-right text-xs tabular-nums">
                        <span>{stats.kills}</span>
                        <span>{stats.knocks}</span>
                        <span>{Math.round(stats.damage)}</span>
                      </span>
                    }
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollableArea>
  );
});

const ReplayAnalysisToolbar = memo(function ReplayAnalysisToolbar({
  analysis,
  aliveTeamCount,
  alivePlayerCount,
  squadMatches,
  selectedMatchId,
  teams,
  selectedTeamId,
  selectedPlayer,
  playerStats,
  isPinnedPlayerUnavailable,
  isLoading,
  onSelectMatch,
  onSelectTeam,
  onSelectPlayer,
  onRefresh,
}: {
  analysis: MatchAnalysis | null;
  aliveTeamCount: number;
  alivePlayerCount: number;
  squadMatches: IngestMatch[];
  selectedMatchId: string;
  teams: TeamSummary[];
  selectedTeamId: string;
  selectedPlayer: MatchAnalysisPlayer | null;
  playerStats: Record<string, PlayerReplayStats>;
  isPinnedPlayerUnavailable: boolean;
  isLoading: boolean;
  onSelectMatch: (matchId: string) => void;
  onSelectTeam: (teamId: string) => void;
  onSelectPlayer: (player: MatchAnalysisPlayer) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1">
      <div className="flex min-w-0 items-center gap-3">
        <div className="rounded border border-border bg-muted p-2 text-primary">
          <MapPinned className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-bold text-primary">2D 对局回放</h1>
            {analysis && (
              <>
                <Badge variant="neutral" label={<>{aliveTeamCount} 队存活</>} />
                <Badge variant="neutral" label={<>{alivePlayerCount} 人存活</>} />
              </>
            )}
          </div>
          <p className="truncate text-xs text-secondary">全员位置、安全区、交战事件与队伍实时状态</p>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        <Selector
          label="选择对局"
          isLabelHidden
          placeholder="选择对局"
          value={selectedMatchId}
          onChange={onSelectMatch}
          containerClassName="w-full sm:w-[300px]"
          options={squadMatches.map((match) => ({ value: match.match_id, label: matchTitle(match) }))}
        />
        <Selector
          key={selectedMatchId}
          label="搜索并高亮队伍"
          isLabelHidden
          hasSearch
          placeholder="搜索高亮队伍"
          searchPlaceholder="搜索队伍 ID 或选手名"
          emptySearchText="没有匹配的队伍"
          containerClassName="w-full sm:w-[220px]"
          value={selectedTeamId}
          onChange={onSelectTeam}
          isDisabled={!analysis || teams.length === 0}
          options={teams.map((team) => ({
            value: team.teamId,
            label: `队伍 ${team.teamId} · ${team.players.length} 人 · ${team.players.map(playerDisplayName).join(" / ")}`,
          }))}
          renderValue={(option) => option.label?.split(" · ").slice(0, 2).join(" · ")}
        />
        <Selector
          label="固定关注选手"
          isLabelHidden
          placeholder={isPinnedPlayerUnavailable ? "关注选手不在本场" : "固定关注选手"}
          value={selectedPlayer?.player_id ?? ""}
          onChange={(playerId) => {
            const player = analysis?.players.find((item) => item.player_id === playerId);
            if (player) onSelectPlayer(player);
          }}
          isDisabled={!analysis || analysis.players.length === 0}
          containerClassName="w-full sm:w-[220px]"
          options={(analysis?.players ?? []).map((player) => ({
            value: player.player_id,
            label: `${playerDisplayName(player)} · 队伍 ${player.team_id}${(playerStats[player.player_id]?.deadAt ?? null) !== null ? " · 已淘汰" : ""}`,
          }))}
        />
        <Button
          onClick={onRefresh}
          label="刷新"
          variant="secondary"
          isDisabled={isLoading}
          icon={
            isLoading ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )
          }
        />
      </div>
    </div>
  );
});

export function PlayerMatchAnalysis() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState(() => {
    if (typeof window !== "undefined") {
      return searchParams.get("matches") || localStorage.getItem("pzp_analysis_selectedMatchId") || "";
    }
    return "";
  });
  
  const [analysis, setAnalysis] = useState<MatchAnalysis | null>(null);
  
  const [selectedTeamId, setSelectedTeamId] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("pzp_analysis_selectedTeamId") || "";
    }
    return "";
  });
  const [selectedPlayerId, setSelectedPlayerId] = useState(() => {
    if (typeof window !== "undefined") {
      return searchParams.get("player") || localStorage.getItem("pzp_analysis_selectedPlayerId") || "";
    }
    return "";
  });

  const [layers, setLayers] = useState<LayerId[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("pzp_analysis_layers");
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch (e) {
          // ignore parse error
        }
      }
    }
    return ["route", "combat", "eliminations", "zones", "flightPath"];
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_selectedMatchId", selectedMatchId);
    }
    if (!selectedMatchId) return;
    setSearchParams((current) => {
      if (current.get("matches") === selectedMatchId) return current;
      const next = new URLSearchParams(current);
      next.set("matches", selectedMatchId);
      return next;
    }, { replace: true });
  }, [selectedMatchId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_selectedTeamId", selectedTeamId);
    }
  }, [selectedTeamId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_selectedPlayerId", selectedPlayerId);
    }
  }, [selectedPlayerId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_layers", JSON.stringify(layers));
    }
  }, [layers]);
  const [mapTransform, setMapTransform] = useState<MapTransform>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("pzp_analysis_mapTransform");
      if (saved) {
        try { return JSON.parse(saved); } catch (e) {}
      }
    }
    return { x: 0, y: 0, scale: 1 };
  });
  const [isMapDragging, setIsMapDragging] = useState(false);
  const [mapDragStart, setMapDragStart] = useState<MapDragStart | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [decodedHighResUrl, setDecodedHighResUrl] = useState<string | null>(null);
  const [isMapAutoFocusing, setIsMapAutoFocusing] = useState(false);
  const [mapFocusNotice, setMapFocusNotice] = useState<MapFocusNotice | null>(null);
  const mapFocusAnimationTimerRef = useRef<number | null>(null);
  const mapFocusNoticeTimerRef = useRef<number | null>(null);

  const [playbackTime, setPlaybackTime] = useState(0);
  const playbackSecond = Math.floor(playbackTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(() => {
    if (typeof window === "undefined") return 5;
    const savedSpeed = Number(localStorage.getItem("pzp_analysis_playbackSpeed"));
    return PLAYBACK_SPEEDS.some((speed) => speed === savedSpeed) ? savedSpeed : 5;
  });
  const [showKillFeed, setShowKillFeed] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("pzp_analysis_showKillFeed") !== "false";
  });

  const [layersPanelPos, setLayersPanelPos] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("pzp_analysis_layersPanelPos");
      if (saved) {
        try { return JSON.parse(saved); } catch (e) {}
      }
    }
    return { x: 12, y: 12 };
  });
  const [isLayersDragging, setIsLayersDragging] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_mapTransform", JSON.stringify(mapTransform));
    }
  }, [mapTransform]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_layersPanelPos", JSON.stringify(layersPanelPos));
    }
  }, [layersPanelPos]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("pzp_analysis_playbackSpeed", String(playbackSpeed));
    }
  }, [playbackSpeed]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        "pzp_analysis_showKillFeed",
        String(showKillFeed),
      );
    }
  }, [showKillFeed]);

  useEffect(
    () => () => {
      if (mapFocusAnimationTimerRef.current !== null) {
        window.clearTimeout(mapFocusAnimationTimerRef.current);
      }
      if (mapFocusNoticeTimerRef.current !== null) {
        window.clearTimeout(mapFocusNoticeTimerRef.current);
      }
    },
    [],
  );
  const layersDragStart = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number } | null>(null);

  const handleLayersMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setIsLayersDragging(true);
    layersDragStart.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      startX: layersPanelPos.x,
      startY: layersPanelPos.y,
    };
  };

  useEffect(() => {
    if (!isLayersDragging) return;
    const handleMouseMove = (event: MouseEvent) => {
      if (!layersDragStart.current) return;
      setLayersPanelPos({
        x: layersDragStart.current.startX + event.clientX - layersDragStart.current.mouseX,
        y: layersDragStart.current.startY + event.clientY - layersDragStart.current.mouseY,
      });
    };
    const handleMouseUp = () => {
      setIsLayersDragging(false);
      layersDragStart.current = null;
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isLayersDragging]);

  const squadMatches = useMemo(() => matches.filter(isSquadMatch), [matches]);
  const parsedMatches = useMemo(
    () =>
      squadMatches.filter(
        (match) =>
          match.telemetry_parse_status === "completed" &&
          (match.position_sample_count > 0 || match.life_event_count > 0 || match.circle_phase_count > 0),
      ),
    [squadMatches],
  );
  const activeMatch =
    analysis?.match ?? parsedMatches.find((match) => match.match_id === selectedMatchId) ?? squadMatches[0] ?? null;
  const activeMap = mapForMatch(activeMatch, maps);
  const worldSize = activeMap?.world_size ?? 816000;

  useEffect(() => {
    if (!activeMap) {
      setIsMapReady(false);
      setDecodedHighResUrl(null);
      return;
    }
    setIsMapReady(false);
    setDecodedHighResUrl(null);
    let isMounted = true;
    
    const loadAssets = async () => {
      try {
        await Promise.all([
          api.ensureMapAsset(activeMap.map_id, "low"),
          api.ensureMapAsset(activeMap.map_id, "high")
        ]);
        if (!isMounted) return;
        setIsMapReady(true);
        
        const url = api.mapImageUrl(activeMap.map_id, "high");
        const img = new Image();
        img.src = url;
        img.decode().then(() => {
          if (isMounted) setDecodedHighResUrl(url);
        }).catch(() => {
          if (isMounted) setDecodedHighResUrl(url); // fallback
        });
      } catch (err) {
        console.error("Failed to ensure map assets", err);
      }
    };
    
    loadAssets();
    
    return () => { isMounted = false; };
  }, [activeMap]);

  const maxPlaybackTime = useMemo(() => {
    if (!analysis) return 0;
    const maxCircle = analysis.circles.length > 0 ? Math.max(...analysis.circles.map(c => c.elapsed_time)) : 0;
    const maxEvent = analysis.life_events.length > 0 ? Math.max(...analysis.life_events.map(e => e.elapsed_time)) : 0;
    const maxPos = analysis.positions.length > 0 ? Math.max(...analysis.positions.map(p => p.elapsed_time)) : 0;
    return Math.max(maxCircle, maxEvent, maxPos);
  }, [analysis]);

  useEffect(() => {
    setPlaybackTime(0);
    setIsPlaying(false);
  }, [maxPlaybackTime]);

  const lastTimeRef = useRef<number>(0);
  useEffect(() => {
    if (!isPlaying) return;
    let animationFrameId: number;

    const tick = (time: number) => {
      if (
        lastTimeRef.current !== 0 &&
        time - lastTimeRef.current >= PLAYBACK_RENDER_INTERVAL_MS
      ) {
        const deltaSeconds = (time - lastTimeRef.current) / 1000;
        lastTimeRef.current = time;
        setPlaybackTime((prev) => {
          const next = prev + deltaSeconds * playbackSpeed;
          if (next >= maxPlaybackTime) {
            setIsPlaying(false);
            return maxPlaybackTime;
          }
          return next;
        });
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    lastTimeRef.current = performance.now();
    animationFrameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameId);
      lastTimeRef.current = 0;
    };
  }, [isPlaying, playbackSpeed, maxPlaybackTime]);

  const teams = useMemo(() => teamSummaries(analysis?.players ?? []), [analysis]);
  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);
  const playersById = useMemo(
    () =>
      new Map(
        (analysis?.players ?? []).map((player) => [player.player_id, player]),
      ),
    [analysis],
  );
  const { allPositionGroups, positionsByTeam } = useMemo(() => {
    const playerGroups = groupedPositions(analysis?.positions ?? []);
    const teamGroups: Record<string, MatchAnalysisPosition[]> = {};
    for (const position of analysis?.positions ?? []) {
      (teamGroups[position.team_id] ??= []).push(position);
    }
    for (const positions of Object.values(playerGroups)) {
      positions.sort((left, right) => left.elapsed_time - right.elapsed_time);
    }
    for (const positions of Object.values(teamGroups)) {
      positions.sort((left, right) => left.elapsed_time - right.elapsed_time);
    }
    return {
      allPositionGroups: playerGroups,
      positionsByTeam: teamGroups,
    };
  }, [analysis]);

  const playerReplayTimelines = useMemo(() => {
    const timelines: Record<string, PlayerReplayTimeline> = {};
    for (const player of analysis?.players ?? []) {
      timelines[player.player_id] = {
        kills: [],
        knocks: [],
        damage: [],
        knockedDown: [],
        eliminatedAt: null,
      };
    }
    for (const event of analysis?.life_events ?? []) {
      const actorTimeline = event.actor_player_id
        ? timelines[event.actor_player_id]
        : undefined;
      if (actorTimeline) {
        if (isEliminationEvent(event)) {
          actorTimeline.kills.push({
            elapsedTime: event.elapsed_time,
            value: (actorTimeline.kills.at(-1)?.value ?? 0) + 1,
          });
        } else if (event.event_type === "LogPlayerMakeGroggy") {
          actorTimeline.knocks.push({
            elapsedTime: event.elapsed_time,
            value: (actorTimeline.knocks.at(-1)?.value ?? 0) + 1,
          });
        } else if (event.event_type === "LogPlayerTakeDamage" && event.damage) {
          actorTimeline.damage.push({
            elapsedTime: event.elapsed_time,
            value: (actorTimeline.damage.at(-1)?.value ?? 0) + event.damage,
          });
        }
      }

      const victimTimeline = event.victim_player_id
        ? timelines[event.victim_player_id]
        : undefined;
      if (!victimTimeline) continue;
      if (event.event_type === "LogPlayerMakeGroggy") {
        victimTimeline.knockedDown.push({
          elapsedTime: event.elapsed_time,
          value: true,
        });
      } else if (event.event_type === "LogPlayerRevive") {
        victimTimeline.knockedDown.push({
          elapsedTime: event.elapsed_time,
          value: false,
        });
      } else if (isEliminationEvent(event)) {
        victimTimeline.eliminatedAt ??= event.elapsed_time;
        victimTimeline.knockedDown.push({
          elapsedTime: event.elapsed_time,
          value: false,
        });
      }
    }
    return timelines;
  }, [analysis]);

  const replayFeedEvents = useMemo(
    () =>
      (analysis?.life_events ?? []).filter(
        (event) =>
          isEliminationEvent(event) ||
          event.event_type === "LogPlayerMakeGroggy",
      ),
    [analysis],
  );
  const replayStatEvents = useMemo(
    () =>
      (analysis?.life_events ?? []).filter(
        (event) =>
          isEliminationEvent(event) ||
          event.event_type === "LogPlayerMakeGroggy" ||
          event.event_type === "LogPlayerRevive" ||
          event.event_type === "LogPlayerTakeDamage",
      ),
    [analysis],
  );
  const replayStatsEventIndex = upperBoundByElapsedTime(
    replayStatEvents,
    playbackTime,
  );
  const replayStateTime =
    replayStatsEventIndex > 0
      ? replayStatEvents[replayStatsEventIndex - 1].elapsed_time
      : 0;
  const combatEventsByTeam = useMemo(() => {
    const groups: Record<string, MatchAnalysisLifeEvent[]> = {};
    for (const event of replayFeedEvents) {
      const teamIds = new Set(
        [event.actor_team_id, event.victim_team_id].filter(
          (teamId): teamId is string => Boolean(teamId),
        ),
      );
      for (const teamId of teamIds) {
        (groups[teamId] ??= []).push(event);
      }
    }
    return groups;
  }, [replayFeedEvents]);

  const playerStats = useMemo(() => {
    const stats: Record<string, PlayerReplayStats> = {};
    for (const player of analysis?.players ?? []) {
      const timeline = playerReplayTimelines[player.player_id];
      const deadAt =
        timeline.eliminatedAt !== null &&
        timeline.eliminatedAt <= replayStateTime
          ? timeline.eliminatedAt
          : null;
      stats[player.player_id] = {
        kills: replayTimelineValueAt(timeline.kills, replayStateTime, 0),
        knocks: replayTimelineValueAt(timeline.knocks, replayStateTime, 0),
        damage: replayTimelineValueAt(timeline.damage, replayStateTime, 0),
        deadAt,
        knockedDown:
          deadAt === null &&
          replayTimelineValueAt(
            timeline.knockedDown,
            replayStateTime,
            false,
          ),
      };
    }
    return stats;
  }, [
    analysis,
    playerReplayTimelines,
    replayStateTime,
    replayStatsEventIndex,
  ]);

  const deadPlayers = useMemo(
    () =>
      new Set(
        Object.entries(playerStats)
          .filter(([, stats]) => stats.deadAt !== null)
          .map(([playerId]) => playerId),
      ),
    [playerStats],
  );

  const currentPlayerPositions = useMemo(
    () =>
      Object.values(allPositionGroups)
        .map((positions) => interpolatePosition(positions, playbackTime))
        .filter(
          (position): position is MatchAnalysisPosition =>
            position !== null && !deadPlayers.has(position.player_id),
        ),
    [allPositionGroups, deadPlayers, playbackTime],
  );
  const fireTracerEvents = useMemo(
    () => (analysis?.life_events ?? []).filter(isFireTracerEvent),
    [analysis],
  );
  const fireTracerDurationSeconds = Math.max(
    FIRE_TRACER_MIN_REPLAY_DURATION_SECONDS,
    playbackSpeed * FIRE_TRACER_SCREEN_DURATION_SECONDS,
  );
  const activeFireTracers = useMemo(() => {
    let low = 0;
    let high = fireTracerEvents.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (fireTracerEvents[middle].elapsed_time <= playbackTime) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const visibleAfter = playbackTime - fireTracerDurationSeconds;
    const seenPairs = new Set<string>();
    const tracers: Array<{
      id: string;
      attackerPlayerId: string;
      victimPlayerId: string;
      start: ApiPoint;
      end: ApiPoint;
      opacity: number;
    }> = [];
    for (let index = low - 1; index >= 0; index -= 1) {
      const event = fireTracerEvents[index];
      if (event.elapsed_time < visibleAfter) break;
      const attackerPlayerId = event.actor_player_id;
      const victimPlayerId = event.victim_player_id;
      if (!attackerPlayerId || !victimPlayerId) continue;
      const pairKey = `${attackerPlayerId}:${victimPlayerId}`;
      if (seenPairs.has(pairKey)) continue;
      const attackerPosition = interpolatePosition(
        allPositionGroups[attackerPlayerId] ?? [],
        event.elapsed_time,
      );
      const victimPosition = interpolatePosition(
        allPositionGroups[victimPlayerId] ?? [],
        event.elapsed_time,
      );
      if (!attackerPosition || !victimPosition) continue;
      seenPairs.add(pairKey);
      tracers.push({
        id: `${event.id}-${pairKey}`,
        attackerPlayerId,
        victimPlayerId,
        start: pointToView(attackerPosition.point, worldSize),
        end: pointToView(victimPosition.point, worldSize),
        opacity:
          0.3 +
          Math.max(
            0,
            1 - (playbackTime - event.elapsed_time) / fireTracerDurationSeconds,
          ) *
            0.7,
      });
      if (tracers.length >= 16) break;
    }
    return tracers;
  }, [
    allPositionGroups,
    fireTracerDurationSeconds,
    fireTracerEvents,
    playbackTime,
    worldSize,
  ]);
  const firingPlayerIds = useMemo(
    () => new Set(activeFireTracers.map((tracer) => tracer.attackerPlayerId)),
    [activeFireTracers],
  );

  const selectedPositions = useMemo(() => {
    if (!selectedTeamId) return [];
    const teamPositions = positionsByTeam[selectedTeamId] ?? [];
    return teamPositions.slice(
      0,
      upperBoundByElapsedTime(teamPositions, playbackSecond),
    );
  }, [playbackSecond, positionsByTeam, selectedTeamId]);

  const teamRows = useMemo<TeamReplayRow[]>(() => {
    const rows = teams.map((team) => {
      const teamPlayerStats = team.players.map(
        (player) =>
          playerStats[player.player_id] ?? {
            kills: 0,
            knocks: 0,
            damage: 0,
            deadAt: null,
            knockedDown: false,
          },
      );
      const aliveCount = teamPlayerStats.filter((stats) => stats.deadAt === null).length;
      return {
        team,
        color: teamColor(team.teamId, teams),
        aliveCount,
        kills: teamPlayerStats.reduce((total, stats) => total + stats.kills, 0),
        damage: teamPlayerStats.reduce((total, stats) => total + stats.damage, 0),
        eliminatedAt:
          aliveCount === 0
            ? Math.max(...teamPlayerStats.map((stats) => stats.deadAt ?? 0))
            : null,
        displayRank: team.teamRank,
      };
    });
    const aliveTeamCount = rows.filter((row) => row.aliveCount > 0).length;
    const eliminated = rows
      .filter((row) => row.eliminatedAt !== null)
      .sort((left, right) => (right.eliminatedAt ?? 0) - (left.eliminatedAt ?? 0));
    const derivedRanks = new Map(
      eliminated.map((row, index) => [row.team.teamId, aliveTeamCount + index + 1]),
    );
    return rows
      .map((row) => ({
        ...row,
        displayRank: row.displayRank ?? derivedRanks.get(row.team.teamId) ?? null,
      }))
      .sort((left, right) => {
        if (left.aliveCount > 0 && right.aliveCount === 0) return -1;
        if (left.aliveCount === 0 && right.aliveCount > 0) return 1;
        if (left.displayRank !== null && right.displayRank !== null) {
          return left.displayRank - right.displayRank;
        }
        return left.team.teamId.localeCompare(right.team.teamId, undefined, { numeric: true });
      });
  }, [playerStats, teams]);

  const selectedPlayer =
    (analysis?.players ?? []).find((player) => player.player_id === selectedPlayerId) ??
    (analysis?.players ?? []).find((player) => player.player_name === selectedPlayerId) ??
    null;
  const isPinnedPlayerUnavailable = Boolean(
    analysis && selectedPlayerId && !selectedPlayer,
  );
  const selectedPlayerEliminatedAt = selectedPlayer
    ? playerStats[selectedPlayer.player_id]?.deadAt ?? null
    : null;
  const selectedEliminatedPosition =
    selectedPlayer && selectedPlayerEliminatedAt !== null
      ? interpolatePosition(
          allPositionGroups[selectedPlayer.player_id] ?? [],
          selectedPlayerEliminatedAt,
        )
      : null;
  const aliveTeamCount = teamRows.filter((row) => row.aliveCount > 0).length;
  const alivePlayerCount = Math.max(0, (analysis?.players.length ?? 0) - deadPlayers.size);
  const recentKillFeed = useMemo(() => {
    const endIndex = upperBoundByElapsedTime(replayFeedEvents, playbackSecond);
    const visibleAfter = Math.max(0, playbackSecond - 18);
    const events: MatchAnalysisLifeEvent[] = [];
    for (
      let index = endIndex - 1;
      index >= 0 && events.length < 5;
      index -= 1
    ) {
      const event = replayFeedEvents[index];
      if (event.elapsed_time < visibleAfter) break;
      events.push(event);
    }
    return events;
  }, [playbackSecond, replayFeedEvents]);

  const currentCircle = useMemo(() => {
    if (!analysis) return null;
    let latest = null;
    for (const c of analysis.circles) {
      if (c.elapsed_time <= playbackSecond) {
        if (!latest || c.elapsed_time > latest.elapsed_time) {
          latest = c;
        }
      }
    }
    return latest;
  }, [analysis, playbackSecond]);

  const selectedEvents = useMemo(() => {
    const teamEvents = combatEventsByTeam[selectedTeamId] ?? [];
    return teamEvents.slice(
      0,
      upperBoundByElapsedTime(teamEvents, playbackSecond),
    );
  }, [combatEventsByTeam, playbackSecond, selectedTeamId]);

  const flightPath = useMemo(() => {
    return analysis ? inferFlightPath(analysis.positions, worldSize) : null;
  }, [analysis, worldSize]);
  const { routeSegments, routePositions, routeEndpoints } = useMemo(() => {
    const positionGroups = groupedPositions(selectedPositions);
    const nextGroundSegments = Object.entries(positionGroups).flatMap<PlayerGroundSegment>(
      ([playerId, positions]) =>
        groundedPositionSegments(positions, worldSize).map((segmentPositions, index) => ({
          id: `${playerId}-${index}-${segmentPositions[0].elapsed_time}`,
          playerId,
          positions: segmentPositions,
        })),
    );
    const nextRouteSegments = nextGroundSegments
      .map((segment) => ({
        ...segment,
        path: routePath(segment.positions, worldSize),
      }))
      .filter((segment): segment is PlayerRouteSegment => Boolean(segment.path));
    const nextRoutePositions = nextGroundSegments
      .flatMap((segment) => segment.positions)
      .sort((left, right) => left.elapsed_time - right.elapsed_time);
    const nextRouteEndpoints = new Set(
      nextGroundSegments.flatMap((segment) => [
        segment.positions[0],
        segment.positions[segment.positions.length - 1],
      ]),
    );
    return {
      routeSegments: nextRouteSegments,
      routePositions: nextRoutePositions,
      routeEndpoints: nextRouteEndpoints,
    };
  }, [selectedPositions, worldSize]);
  const routePathElements = useMemo(
    () =>
      routeSegments.map((segment) => (
        <path
          key={segment.id}
          d={segment.path}
          fill="none"
          stroke={playerColor(segment.playerId, selectedTeam)}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          strokeDasharray="6 6"
          opacity="0.9"
          filter="url(#analysis-glow)"
          className="animate-dash-flow"
        />
      )),
    [routeSegments, selectedTeam],
  );
  const routePositionElements = useMemo(
    () =>
      routePositions.map((position) => {
        const point = pointToView(position.point, worldSize);
        const color = playerColor(position.player_id, selectedTeam);
        const isEndpoint = routeEndpoints.has(position);
        return (
          <circle
            key={`${position.player_id}-${position.elapsed_time}-${position.point.x}-${position.point.y}`}
            cx={point.x}
            cy={point.y}
            r={isEndpoint ? 2.5 : 1}
            fill={color}
            opacity={isEndpoint ? 0.9 : 0.3}
          />
        );
      }),
    [routeEndpoints, routePositions, selectedTeam, worldSize],
  );
  const eliminationEvents = useMemo(
    () => selectedEvents.filter(isEliminationEvent),
    [selectedEvents],
  );

  const clusteredMapEvents = useMemo(() => {
    if (!analysis) return [];
    let activeEvents: MatchAnalysisLifeEvent[] = [];
    if (layers.includes("eliminations")) {
      activeEvents = activeEvents.concat(eliminationEvents.filter(e => e.point));
    }
    
    // Cluster distance scales inversely with map zoom (keep screen-space distance constant)
    const CLUSTER_DISTANCE = 25 / mapTransform.scale;
    const clusters: { id: string; point: {x: number, y: number}; events: MatchAnalysisLifeEvent[] }[] = [];
    
    activeEvents.forEach(event => {
      const pt = pointToView(event.point as { x: number; y: number }, worldSize);
      let nearestCluster = null;
      let minDistance = Infinity;
      for (const cluster of clusters) {
        const d = Math.hypot(cluster.point.x - pt.x, cluster.point.y - pt.y);
        if (d < minDistance) {
          minDistance = d;
          nearestCluster = cluster;
        }
      }
      
      if (nearestCluster && minDistance < CLUSTER_DISTANCE) {
        nearestCluster.events.push(event);
      } else {
        clusters.push({ id: `cluster-${event.id}`, point: pt, events: [event] });
      }
    });
    return clusters;
  }, [analysis, layers, eliminationEvents, mapTransform.scale, worldSize]);
  const refreshMatches = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const [mapsResponse, matchesResponse] = await Promise.all([api.listMaps(), api.listMatches(200)]);
      const nextMatches = matchesResponse.matches;
      const nextSquadMatches = nextMatches.filter(isSquadMatch);
      const nextParsedMatches = nextSquadMatches.filter(
        (match) =>
          match.telemetry_parse_status === "completed" &&
          (match.position_sample_count > 0 || match.life_event_count > 0 || match.circle_phase_count > 0),
      );
      setMaps(mapsResponse.maps);
      setMatches(nextMatches);
      setSelectedMatchId((current) => {
        if (nextSquadMatches.some((match) => match.match_id === current)) return current;
        return nextParsedMatches[0]?.match_id || nextSquadMatches[0]?.match_id || "";
      });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMatches();
  }, [refreshMatches]);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setMapTransform({ x: 0, y: 0, scale: 1 });
    setIsMapDragging(false);
    setMapDragStart(null);
  }, [selectedMatchId]);

  useEffect(() => {
    if (!selectedMatchId) return;
    let cancelled = false;
    const loadAnalysis = async () => {
      setIsLoadingAnalysis(true);
      setError(null);
      try {
        const payload = await api.getMatchAnalysis(selectedMatchId);
        if (cancelled) return;
        setAnalysis(payload);
        const requestedPlayer = searchParams.get("player") || selectedPlayerId;
        const requestedPlayerRecord = payload.players.find(
          (player) =>
            player.player_id === requestedPlayer ||
            player.player_name === requestedPlayer,
        );
        setSelectedTeamId((current) => {
          const nextTeams = teamSummaries(payload.players);
          if (requestedPlayerRecord) {
            return requestedPlayerRecord.team_id;
          }
          if (nextTeams.some((team) => team.teamId === current)) {
            return current;
          }
          return nextTeams[0]?.teamId ?? "";
        });
        setSelectedPlayerId((current) => {
          if (requestedPlayerRecord) return requestedPlayerRecord.player_id;
          if (current) return current;
          return payload.players[0]?.player_id ?? "";
        });
      } catch (err) {
        if (!cancelled) {
          setAnalysis(null);
          setError(apiErrorMessage(err));
        }
      } finally {
        if (!cancelled) setIsLoadingAnalysis(false);
      }
    };
    void loadAnalysis();
    return () => {
      cancelled = true;
    };
  }, [selectedMatchId]);

  useEffect(() => {
    if (!selectedPlayer) return;
    setSearchParams((current) => {
      const playerParam = playerDisplayName(selectedPlayer);
      if (
        current.get("matches") === selectedMatchId &&
        current.get("player") === playerParam
      ) {
        return current;
      }
      const next = new URLSearchParams(current);
      next.set("matches", selectedMatchId);
      next.set("player", playerParam);
      return next;
    }, { replace: true });
  }, [selectedMatchId, selectedPlayer, setSearchParams]);

  const zoomMap = (nextScale: number, originX?: number, originY?: number) => {
    const container = mapContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const scale = Math.max(1, Math.min(nextScale, MAX_MAP_SCALE));
    const mouseX = originX ?? rect.width / 2;
    const mouseY = originY ?? rect.height / 2;
    setMapTransform((current) => {
      if (scale === 1) return { x: 0, y: 0, scale: 1 };
      const scaleRatio = scale / current.scale;
      return clampMapTransform(
        {
          x: mouseX - (mouseX - current.x) * scaleRatio,
          y: mouseY - (mouseY - current.y) * scaleRatio,
          scale,
        },
        rect.width,
        rect.height,
      );
    });
  };

  const handleMapWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleStep = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomMap(
      mapTransform.scale * scaleStep,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const handleMapMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mapTransform.scale <= 1) return;
    setIsMapDragging(true);
    setMapDragStart({
      mouseX: event.clientX,
      mouseY: event.clientY,
      startX: mapTransform.x,
      startY: mapTransform.y,
    });
  };

  const handleMapMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isMapDragging || !mapDragStart || !mapContainerRef.current) return;
    const rect = mapContainerRef.current.getBoundingClientRect();
    setMapTransform((current) =>
      clampMapTransform(
        {
          x: mapDragStart.startX + event.clientX - mapDragStart.mouseX,
          y: mapDragStart.startY + event.clientY - mapDragStart.mouseY,
          scale: current.scale,
        },
        rect.width,
        rect.height,
      ),
    );
  };

  const stopMapDragging = () => {
    setIsMapDragging(false);
    setMapDragStart(null);
  };

  const showMapFocusNotice = useCallback((notice: MapFocusNotice, duration = 3600) => {
    setMapFocusNotice(notice);
    if (mapFocusNoticeTimerRef.current !== null) {
      window.clearTimeout(mapFocusNoticeTimerRef.current);
    }
    mapFocusNoticeTimerRef.current = window.setTimeout(() => {
      setMapFocusNotice(null);
      mapFocusNoticeTimerRef.current = null;
    }, duration);
  }, []);

  const focusMapPoints = useCallback((points: ApiPoint[], mode: "player" | "team") => {
    const container = mapContainerRef.current;
    if (!container || points.length === 0) return;

    const rect = container.getBoundingClientRect();
    const mapSize = Math.min(rect.width, rect.height);
    const mapOffsetX = (rect.width - mapSize) / 2;
    const mapOffsetY = (rect.height - mapSize) / 2;
    const screenPoints = points.map((point) => ({
      x: mapOffsetX + (point.x / MAP_VIEW_SIZE) * mapSize,
      y: mapOffsetY + (point.y / MAP_VIEW_SIZE) * mapSize,
    }));
    const minX = Math.min(...screenPoints.map((point) => point.x));
    const maxX = Math.max(...screenPoints.map((point) => point.x));
    const minY = Math.min(...screenPoints.map((point) => point.y));
    const maxY = Math.max(...screenPoints.map((point) => point.y));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const padding = Math.min(140, Math.max(64, Math.min(rect.width, rect.height) * 0.14));

    setIsMapAutoFocusing(true);
    if (mapFocusAnimationTimerRef.current !== null) {
      window.clearTimeout(mapFocusAnimationTimerRef.current);
    }
    mapFocusAnimationTimerRef.current = window.setTimeout(() => {
      setIsMapAutoFocusing(false);
      mapFocusAnimationTimerRef.current = null;
    }, 360);

    setMapTransform((current) => {
      const spanX = Math.max(maxX - minX, mapSize * 0.025);
      const spanY = Math.max(maxY - minY, mapSize * 0.025);
      const fitScale = Math.min(
        (rect.width - padding * 2) / spanX,
        (rect.height - padding * 2) / spanY,
      );
      const scale =
        mode === "player"
          ? Math.min(MAX_MAP_SCALE, Math.max(8, current.scale))
          : Math.max(1, Math.min(12, fitScale));
      return clampMapTransform(
        {
          x: rect.width / 2 - centerX * scale,
          y: rect.height / 2 - centerY * scale,
          scale,
        },
        rect.width,
        rect.height,
      );
    });
  }, []);

  const mapInteractionStateRef = useRef({
    playerStats,
    allPositionGroups,
    playbackTime,
    worldSize,
    teams,
    currentPlayerPositions,
  });
  mapInteractionStateRef.current = {
    playerStats,
    allPositionGroups,
    playbackTime,
    worldSize,
    teams,
    currentPlayerPositions,
  };

  const selectAndFocusPlayer = useCallback((player: MatchAnalysisPlayer) => {
    setSelectedTeamId(player.team_id);
    setSelectedPlayerId(player.player_id);

    const {
      playerStats: latestPlayerStats,
      allPositionGroups: latestPositionGroups,
      playbackTime: latestPlaybackTime,
      worldSize: latestWorldSize,
    } = mapInteractionStateRef.current;
    const stats = latestPlayerStats[player.player_id];
    const eliminatedAt = stats?.deadAt ?? null;
    const position = interpolatePosition(
      latestPositionGroups[player.player_id] ?? [],
      eliminatedAt ?? latestPlaybackTime,
    );
    const label = playerDisplayName(player);

    if (!position) {
      showMapFocusNotice({
        tone: "warning",
        title: `${label} 暂无位置`,
        description: "当前回放时间之前没有可用的位置记录。",
      });
      return;
    }

    focusMapPoints([pointToView(position.point, latestWorldSize)], "player");
    if (eliminatedAt !== null) {
      showMapFocusNotice(
        {
          tone: "warning",
          title: `${label} 已被淘汰`,
          description: `淘汰于 ${formatPlaybackTime(eliminatedAt)}，已定位到淘汰前最后位置。`,
        },
        5200,
      );
      return;
    }

    showMapFocusNotice({
      tone: "info",
      title: `已定位 ${label}`,
      description: `队伍 ${player.team_id} · ${formatPlaybackTime(latestPlaybackTime)} 的当前位置`,
    });
  }, [focusMapPoints, showMapFocusNotice]);

  const selectAndFocusTeam = useCallback((teamId: string) => {
    setSelectedTeamId(teamId);
    const {
      teams: latestTeams,
      currentPlayerPositions: latestCurrentPositions,
      playerStats: latestPlayerStats,
      allPositionGroups: latestPositionGroups,
      playbackTime: latestPlaybackTime,
      worldSize: latestWorldSize,
    } = mapInteractionStateRef.current;
    const team = latestTeams.find((item) => item.teamId === teamId);
    if (!team) return;

    const alivePositions = latestCurrentPositions.filter(
      (position) => position.team_id === teamId,
    );
    const eliminatedPlayers = team.players.filter(
      (player) => (latestPlayerStats[player.player_id]?.deadAt ?? null) !== null,
    );

    if (alivePositions.length > 0) {
      focusMapPoints(
        alivePositions.map((position) => pointToView(position.point, latestWorldSize)),
        "team",
      );
      showMapFocusNotice({
        tone: eliminatedPlayers.length > 0 ? "warning" : "info",
        title: `已定位队伍 ${teamId}`,
        description:
          eliminatedPlayers.length > 0
            ? `${alivePositions.length} 人存活，${eliminatedPlayers.length} 人已被淘汰。`
            : `${alivePositions.length} 名队员均在视野内。`,
      });
      return;
    }

    if (eliminatedPlayers.length < team.players.length) {
      showMapFocusNotice({
        tone: "warning",
        title: `队伍 ${teamId} 暂无位置`,
        description: "当前回放时间之前还没有可用的队员位置记录。",
      });
      return;
    }

    const lastPositions = team.players
      .map((player) => {
        const eliminatedAt = latestPlayerStats[player.player_id]?.deadAt;
        return interpolatePosition(
          latestPositionGroups[player.player_id] ?? [],
          eliminatedAt ?? latestPlaybackTime,
        );
      })
      .filter(
        (position): position is MatchAnalysisPosition => position !== null,
      );
    if (lastPositions.length > 0) {
      focusMapPoints(
        lastPositions.map((position) => pointToView(position.point, latestWorldSize)),
        "team",
      );
    }
    const eliminatedAt = Math.max(
      0,
      ...eliminatedPlayers.map(
        (player) => latestPlayerStats[player.player_id]?.deadAt ?? 0,
      ),
    );
    showMapFocusNotice(
      {
        tone: "warning",
        title: `队伍 ${teamId} 已全员淘汰`,
        description:
          lastPositions.length > 0
            ? `最后一名队员于 ${formatPlaybackTime(eliminatedAt)} 被淘汰，已定位到队伍最后活动区域。`
            : `最后一名队员于 ${formatPlaybackTime(eliminatedAt)} 被淘汰，暂无可用位置记录。`,
      },
      5200,
    );
  }, [focusMapPoints, showMapFocusNotice]);

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden bg-body p-3 text-primary">
      <ReplayAnalysisToolbar
        analysis={analysis}
        aliveTeamCount={aliveTeamCount}
        alivePlayerCount={alivePlayerCount}
        squadMatches={squadMatches}
        selectedMatchId={selectedMatchId}
        teams={teams}
        selectedTeamId={selectedTeamId}
        selectedPlayer={selectedPlayer}
        playerStats={playerStats}
        isPinnedPlayerUnavailable={isPinnedPlayerUnavailable}
        isLoading={isLoading}
        onSelectMatch={setSelectedMatchId}
        onSelectTeam={selectAndFocusTeam}
        onSelectPlayer={selectAndFocusPlayer}
        onRefresh={refreshMatches}
      />

      {error && (
        <Banner className="shrink-0" status="error" role="alert" title="数据加载失败" description={error} />
      )}

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card padding={0} className="flex flex-col gap-4 min-h-0 overflow-hidden border-border bg-card shadow-sm">
        <header className="grid pt-5 shrink-0 gap-3 border-b border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="font-semibold text-sm">回放控制</h3>
              <p className="text-sm text-secondary truncate">
                {activeMatch ? matchTitle(activeMatch) : "请选择已解析对局"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {currentCircle && <Badge variant="neutral" label={<>阶段 {currentCircle.phase}</>} />}
              <Badge variant="neutral" label={formatPlaybackTime(playbackTime)} />
            </div>
          </div>
          {analysis && (
            <div className="flex items-center gap-3">
              <Button
                className="shrink-0"
                onClick={() => {
                  if (!isPlaying && playbackTime >= maxPlaybackTime) {
                    setPlaybackTime(0);
                  }
                  setIsPlaying(!isPlaying);
                }}
                label={isPlaying ? "暂停回放" : "播放回放"}
                variant="secondary"
                size="sm"
                icon={isPlaying ? <Pause /> : <Play />}
                isIconOnly
              />
              <div className="relative flex h-8 flex-1 items-center px-1">
                <Slider
                  label="回放进度"
                  isLabelHidden
                  width="100%"
                  min={0}
                  max={maxPlaybackTime}
                  step={0.25}
                  value={playbackTime}
                  onChange={(value: number) => {
                    setIsPlaying(false);
                    setPlaybackTime(value);
                  }}
                />
                <div className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2">
                  {analysis.circles.map((circle) => {
                    const percent = (circle.elapsed_time / maxPlaybackTime) * 100;
                    if (percent > 100 || Number.isNaN(percent)) return null;
                    return (
                      <span
                        key={`timeline-phase-${circle.phase}`}
                        className="absolute h-3 w-0.5 -translate-x-1/2 bg-primary/70"
                        style={{ left: `${percent}%` }}
                        title={`阶段 ${circle.phase}`}
                      />
                    );
                  })}
                </div>
              </div>
              <span className="w-12 shrink-0 text-xs tabular-nums text-secondary">
                {formatPlaybackTime(maxPlaybackTime)}
              </span>
              <Selector
                label="播放倍速"
                isLabelHidden
                placeholder="播放倍速"
                value={playbackSpeed.toString()}
                onChange={(value) => setPlaybackSpeed(Number(value))}
                containerClassName="w-[76px] shrink-0"
                options={PLAYBACK_SPEEDS.map((speed) => ({ value: String(speed), label: `${speed}x` }))}
              />
            </div>
          )}
        </header>
        <div className="px-5 pb-5 min-h-0 flex-1 p-0">

            <div
              ref={mapContainerRef}
              className="relative flex h-full min-h-0 cursor-grab items-center justify-center overflow-hidden bg-muted active:cursor-grabbing"
              onWheel={handleMapWheel}
              onMouseDown={handleMapMouseDown}
              onMouseMove={handleMapMouseMove}
              onMouseUp={stopMapDragging}
              onMouseLeave={stopMapDragging}
            >
              <div
                className={cn(
                  "absolute inset-0 origin-top-left",
                  isMapAutoFocusing && "transition-transform duration-300 ease-out",
                )}
                style={{
                  transform: `translate(${mapTransform.x}px, ${mapTransform.y}px) scale(${mapTransform.scale})`,
                }}
              >
                {activeMap && isMapReady && (
                  <>
                    <img
                      src={api.mapImageUrl(activeMap.map_id, "low")}
                      alt={`${activeMap.display_name} map low res`}
                      className="absolute inset-0 h-full w-full object-contain mix-blend-normal opacity-80"
                    />
                    {decodedHighResUrl && (
                      <img
                        src={decodedHighResUrl}
                        alt={`${activeMap.display_name} map high res`}
                        className="absolute inset-0 h-full w-full object-contain mix-blend-normal opacity-80 animate-in fade-in duration-1000"
                      />
                    )}
                  </>
                )}
                <svg
                  viewBox={`0 0 ${MAP_VIEW_SIZE} ${MAP_VIEW_SIZE}`}
                  className="absolute inset-0 size-full"
                  preserveAspectRatio="xMidYMid meet"
                >
                  <defs>
                    <pattern id="analysis-grid" width="100" height="100" patternUnits="userSpaceOnUse">
                      <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                    </pattern>
                    <filter id="analysis-glow" x="-50%" y="-50%" width="200%" height="200%">
                      <feGaussianBlur stdDeviation="4" result="coloredBlur" />
                      <feMerge>
                        <feMergeNode in="coloredBlur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="player-marker-shadow" x="-30%" y="-40%" width="160%" height="190%">
                      <feDropShadow
                        dx="0"
                        dy="1.5"
                        stdDeviation="1.4"
                        floodColor="#020504"
                        floodOpacity="0.72"
                      />
                    </filter>
                    <marker
                      id="fire-tracer-arrow"
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="5.5"
                      markerHeight="5.5"
                      markerUnits="strokeWidth"
                      orient="auto"
                    >
                      <path
                        d="M 0.5 0.8 L 7.5 4 L 0.5 7.2 Z"
                        fill="#ffffff"
                        stroke="rgba(2, 6, 23, 0.9)"
                        strokeWidth="0.8"
                        strokeLinejoin="round"
                      />
                    </marker>
                  </defs>
                  <rect width={MAP_VIEW_SIZE} height={MAP_VIEW_SIZE} fill="url(#analysis-grid)" />

                  {flightPath && layers.includes("flightPath") && (
                    <line
                      x1={flightPath.start.x}
                      y1={flightPath.start.y}
                      x2={flightPath.end.x}
                      y2={flightPath.end.y}
                      stroke="rgba(255, 255, 255, 0.4)"
                      strokeWidth="2.5"
                      strokeDasharray="10 10"
                    />
                  )}

                  {currentCircle && layers.includes("zones") && (
                    <g>
                      {(() => {
                        const center = pointToView(currentCircle.center, worldSize);
                        const radius = radiusToView(currentCircle.radius, worldSize);
                        return (
                          <g key={currentCircle.phase}>
                            <circle
                              cx={center.x}
                              cy={center.y}
                              r={radius}
                              fill="rgba(59,130,246,0.07)"
                              stroke="rgba(147,197,253,0.72)"
                              strokeDasharray="8 8"
                              strokeWidth="2"
                            />
                            <text x={center.x + 8} y={center.y - 8} fill="#bfdbfe" fontSize="12">
                              P{currentCircle.phase}
                            </text>
                          </g>
                        );
                      })()}
                    </g>
                  )}

                  {analysis && layers.includes("route") && routePathElements}

                  {analysis && layers.includes("route") && routePositionElements}

                  {currentPlayerPositions.map((position) => {
                    const point = pointToView(position.point, worldSize);
                    const invScale = 1 / mapTransform.scale;
                    const color = teamColor(position.team_id, teams);
                    const player = playersById.get(position.player_id);
                    const label = player ? playerDisplayName(player) : position.player_id;
                    const isSelectedTeam = position.team_id === selectedTeamId;
                    const isSelectedPlayer = position.player_id === selectedPlayer?.player_id;
                    const isKnockedDown =
                      playerStats[position.player_id]?.knockedDown ?? false;
                    const isFiring =
                      layers.includes("combat") &&
                      !isKnockedDown &&
                      firingPlayerIds.has(position.player_id);
                    const markerOpacity = isKnockedDown
                      ? 0.96
                      : isSelectedPlayer
                        ? 1
                        : isSelectedTeam
                          ? 0.96
                          : 0.88;
                    const showPlayerLabel =
                      isSelectedTeam ||
                      isSelectedPlayer ||
                      mapTransform.scale >= PLAYER_LABEL_ZOOM_THRESHOLD;
                    const showMarkerDetails = showPlayerLabel;
                    const markerWidth = showPlayerLabel
                      ? markerWidthForLabel(label)
                      : 0;
                    const isVehicle = position.movement_mode === "vehicle";
                    const stateLabel = showMarkerDetails
                      ? movementStateLabel(position)
                      : "";
                    return (
                      <g
                        key={`player-${position.player_id}`}
                        transform={`translate(${point.x}, ${point.y}) scale(${invScale})`}
                        className="cursor-pointer"
                        pointerEvents="all"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          if (player) selectAndFocusPlayer(player);
                        }}
                      >
                        {showMarkerDetails && (
                          <title>
                            {position.team_id} · {label} · {stateLabel}
                            {isKnockedDown ? " · 已被击倒" : ""}
                            {isFiring ? " · 正在开火" : ""}
                          </title>
                        )}
                        <g
                          opacity={markerOpacity}
                          filter={
                            showMarkerDetails
                              ? "url(#player-marker-shadow)"
                              : undefined
                          }
                        >
                          {showPlayerLabel && (
                            <g
                              transform={`translate(${-markerWidth / 2} ${PLAYER_MARKER_LABEL_Y})`}
                            >
                              <rect
                                x="0"
                                y="0"
                                width={markerWidth}
                                height={PLAYER_MARKER_LABEL_HEIGHT}
                                rx="1.5"
                                fill={color}
                                stroke={
                                  isSelectedPlayer
                                    ? "#f8faf0"
                                    : "rgba(230,235,216,0.72)"
                                }
                                strokeWidth={isSelectedPlayer ? 1.4 : 0.85}
                              />
                              <rect
                                x="0"
                                y="0"
                                width={markerWidth}
                                height={PLAYER_MARKER_LABEL_HEIGHT}
                                rx="1.5"
                                fill="#143331"
                                opacity="0.48"
                              />
                              <text
                                x="7"
                                y="14.6"
                                fill="#f0f1dd"
                                fontFamily="Arial, Helvetica, sans-serif"
                                fontSize="12"
                                fontWeight={isSelectedPlayer ? 700 : 600}
                                textAnchor="start"
                              >
                                {label}
                              </text>
                            </g>
                          )}
                          <g
                            transform={`scale(${isSelectedPlayer ? 1.08 : isSelectedTeam ? 1.03 : 0.94})`}
                          >
                            <circle
                              cx="0"
                              cy="0"
                              r={PLAYER_MARKER_RADIUS}
                              fill={color}
                              stroke={
                                isSelectedPlayer
                                  ? "#ffffff"
                                  : "rgba(235,238,220,0.9)"
                              }
                              strokeWidth={isSelectedPlayer ? 1.6 : 1.15}
                            />
                            <circle
                              cx="0"
                              cy="0"
                              r={PLAYER_MARKER_RADIUS - 0.7}
                              fill="#143331"
                              opacity="0.32"
                            />
                            {isKnockedDown ? (
                              <g
                                fill="none"
                                stroke="#f7f1df"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pointerEvents="none"
                                transform="rotate(-12)"
                              >
                                <circle cx="-2.8" cy="-3.8" r="1.55" fill="#f7f1df" stroke="none" />
                                <path d="M -1.7 -2.4 L 0.4 0.2 L 4.4 -1" strokeWidth="2" />
                                <path d="M 0.4 0.2 L -2 2.6 L -5.1 2.5" strokeWidth="2" />
                                <path d="M -1.3 1.8 L 2.1 4.7" strokeWidth="2" />
                              </g>
                            ) : isVehicle ? (
                              <g
                                fill="none"
                                stroke="#f0f1dd"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pointerEvents="none"
                              >
                                <circle cx="0" cy="0" r="5.6" strokeWidth="1.25" />
                                <circle cx="0" cy="0.8" r="1.35" strokeWidth="1.1" />
                                <path d="M 0 -0.55 V -5.45" strokeWidth="1.1" />
                                <path d="M -1.1 1.55 L -4.65 3.65 M 1.1 1.55 L 4.65 3.65" strokeWidth="1.1" />
                              </g>
                            ) : (
                              <text
                                x="0"
                                y="3.5"
                                fill="#f0f1dd"
                                fontFamily="Arial, Helvetica, sans-serif"
                                fontSize={
                                  position.team_id.length >= 3
                                    ? 7.5
                                    : position.team_id.length === 2
                                      ? 9
                                      : 10.5
                                }
                                fontWeight="700"
                                textAnchor="middle"
                              >
                                {position.team_id}
                              </text>
                            )}
                          </g>
                        </g>
                      </g>
                    );
                  })}

                  {clusteredMapEvents.map(cluster => {
                    const invScale = 1 / mapTransform.scale;
                    if (cluster.events.length === 1) {
                      const event = cluster.events[0];
                      const color = playerColor(eventTeamPlayerId(event, selectedTeamId), selectedTeam);
                      const label = `${event.actor_player_name || "未知"} 淘汰了 ${event.victim_player_name || "未知"}`;
                      return (
                        <g key={cluster.id} transform={`translate(${cluster.point.x}, ${cluster.point.y}) scale(${invScale})`} className="cursor-pointer" pointerEvents="bounding-box">
                              <circle cx="0" cy="0" r="10" fill="rgba(244,63,94,0.3)" stroke={color} strokeWidth="1.5" />
                              <Skull x="-7" y="-7" width="14" height="14" color="#fff" style={{ filter: `drop-shadow(0px 0px 3px ${color})` }} />
                              <foreignObject x="-14" y="-14" width="28" height="28">
                                <Tooltip placement="above" delay={100} content={<p className="font-medium">{label}</p>}>
                                  <div tabIndex={0} aria-label={label} className="size-full" />
                                </Tooltip>
                              </foreignObject>
                            </g>
                      );
                    } else {
                      return (
                        <g key={cluster.id} transform={`translate(${cluster.point.x}, ${cluster.point.y}) scale(${invScale})`} className="cursor-pointer" pointerEvents="bounding-box">
                              <circle cx="0" cy="0" r="12" fill="rgba(244,63,94,0.4)" stroke="rgba(244,63,94,1)" strokeWidth="1.5" />
                              <circle cx="0" cy="0" r="16" fill="none" stroke="rgba(244,63,94,1)" strokeWidth="1.5" strokeDasharray="3 3" className="animate-[spin_4s_linear_infinite]" opacity="0.8" />
                              <text x="0" y="3.5" fontSize="10" fontWeight="bold" fill="#fff" textAnchor="middle">{cluster.events.length}</text>
                              <foreignObject x="-14" y="-14" width="28" height="28">
                                <Tooltip placement="above" delay={100} content={<div className="flex flex-col gap-1">
                              {cluster.events.map((event) => (
                                <p key={event.id} className="text-xs">
                                  <span className="opacity-80">{event.actor_player_name || "未知"}</span>
                                  <span className="mx-1 text-red-400">淘汰了</span>
                                  <span className="opacity-80">{event.victim_player_name || "未知"}</span>
                                </p>
                              ))}
                            </div>}>
                                  <div tabIndex={0} aria-label={`${cluster.events.length} 条淘汰记录`} className="size-full" />
                                </Tooltip>
                              </foreignObject>
                            </g>
                      );
                    }
                  })}

                  {selectedPlayer && selectedEliminatedPosition && (() => {
                    const point = pointToView(selectedEliminatedPosition.point, worldSize);
                    const invScale = 1 / mapTransform.scale;
                    const label = `${playerDisplayName(selectedPlayer)} · 已淘汰`;
                    const markerWidth = markerWidthForLabel(label);
                    return (
                      <g
                        data-selected-eliminated-player={selectedPlayer.player_id}
                        transform={`translate(${point.x}, ${point.y}) scale(${invScale})`}
                        pointerEvents="none"
                        filter="url(#player-marker-shadow)"
                      >
                        <circle
                          cx="0"
                          cy="0"
                          r="16"
                          fill="rgba(127, 29, 29, 0.22)"
                          stroke="#f87171"
                          strokeWidth="1.5"
                          strokeDasharray="3 3"
                        >
                          <animate
                            attributeName="r"
                            values="14;19;14"
                            dur="1.4s"
                            repeatCount="indefinite"
                          />
                          <animate
                            attributeName="opacity"
                            values="1;0.45;1"
                            dur="1.4s"
                            repeatCount="indefinite"
                          />
                        </circle>
                        <circle
                          cx="0"
                          cy="0"
                          r={PLAYER_MARKER_RADIUS + 1}
                          fill="#7f1d1d"
                          stroke="#fee2e2"
                          strokeWidth="1.5"
                        />
                        <path
                          d="M -4 -4 L 4 4 M 4 -4 L -4 4"
                          fill="none"
                          stroke="#fff1f2"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                        />
                        <g transform={`translate(${-markerWidth / 2} ${PLAYER_MARKER_LABEL_Y + 5})`}>
                          <rect
                            x="0"
                            y="0"
                            width={markerWidth}
                            height={PLAYER_MARKER_LABEL_HEIGHT}
                            rx="2"
                            fill="#7f1d1d"
                            stroke="#fecaca"
                            strokeWidth="1"
                          />
                          <text
                            x={markerWidth / 2}
                            y="14.6"
                            fill="#fff1f2"
                            fontFamily="Arial, Helvetica, sans-serif"
                            fontSize="12"
                            fontWeight="700"
                            textAnchor="middle"
                          >
                            {label}
                          </text>
                        </g>
                      </g>
                    );
                  })()}

                  {layers.includes("combat") &&
                    activeFireTracers.map((tracer) => {
                      const invScale = 1 / mapTransform.scale;
                      const deltaX = tracer.end.x - tracer.start.x;
                      const deltaY = tracer.end.y - tracer.start.y;
                      const distance = Math.hypot(deltaX, deltaY);
                      const directionX = distance > 0 ? deltaX / distance : 1;
                      const directionY = distance > 0 ? deltaY / distance : 0;
                      const isCloseRange = distance * mapTransform.scale < 28;
                      const bend = isCloseRange ? 48 * invScale : 0;
                      const controlX =
                        (tracer.start.x + tracer.end.x) / 2 - directionY * bend;
                      const controlY =
                        (tracer.start.y + tracer.end.y) / 2 + directionX * bend;
                      const tracerPath = isCloseRange
                        ? `M ${tracer.start.x} ${tracer.start.y} Q ${controlX} ${controlY} ${tracer.end.x} ${tracer.end.y}`
                        : `M ${tracer.start.x} ${tracer.start.y} L ${tracer.end.x} ${tracer.end.y}`;
                      return (
                        <g
                          key={tracer.id}
                          data-fire-tracer={`${tracer.attackerPlayerId}:${tracer.victimPlayerId}`}
                          opacity={tracer.opacity}
                          pointerEvents="none"
                        >
                          <path
                            d={tracerPath}
                            fill="none"
                            stroke="rgba(2, 6, 23, 0.78)"
                            strokeWidth={4.8 * invScale}
                            strokeLinecap="round"
                            strokeDasharray={`${9 * invScale} ${6 * invScale}`}
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              values={`${15 * invScale};0`}
                              dur="0.55s"
                              repeatCount="indefinite"
                            />
                          </path>
                          <path
                            data-fire-tracer-path="true"
                            d={tracerPath}
                            fill="none"
                            stroke="#ffffff"
                            strokeWidth={2 * invScale}
                            strokeLinecap="round"
                            strokeDasharray={`${9 * invScale} ${6 * invScale}`}
                            markerEnd="url(#fire-tracer-arrow)"
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              values={`${15 * invScale};0`}
                              dur="0.55s"
                              repeatCount="indefinite"
                            />
                          </path>
                          <circle
                            cx={tracer.start.x}
                            cy={tracer.start.y}
                            r={5.5 * invScale}
                            fill="rgba(2, 6, 23, 0.82)"
                            stroke="#ffffff"
                            strokeWidth={1.4 * invScale}
                          >
                            <animate
                              attributeName="r"
                              values={`${4.5 * invScale};${7 * invScale};${4.5 * invScale}`}
                              dur="0.7s"
                              repeatCount="indefinite"
                            />
                            <animate
                              attributeName="stroke-opacity"
                              values="1;0.35;1"
                              dur="0.7s"
                              repeatCount="indefinite"
                            />
                          </circle>
                          <path
                            d={`M ${-3.5 * invScale} ${-2.6 * invScale} L ${4 * invScale} 0 L ${-3.5 * invScale} ${2.6 * invScale} Z`}
                            fill="#ffffff"
                            stroke="rgba(2, 6, 23, 0.9)"
                            strokeWidth={1 * invScale}
                          >
                            <animateMotion
                              path={tracerPath}
                              rotate="auto"
                              dur="0.7s"
                              repeatCount="indefinite"
                            />
                            <animate
                              attributeName="opacity"
                              values="0.15;1;0.15"
                              dur="0.7s"
                              repeatCount="indefinite"
                            />
                          </path>
                        </g>
                      );
                  })}
                </svg>
              </div>
              {mapFocusNotice && (
                <div
                  className={cn(
                    "pointer-events-none absolute left-1/2 top-3 z-30 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border px-3 py-2 shadow-xl backdrop-blur-sm",
                    mapFocusNotice.tone === "warning"
                      ? "border-red-400/60 bg-red-950/90 text-red-50"
                      : "border-cyan-300/50 bg-slate-950/90 text-slate-50",
                  )}
                  role="status"
                  aria-live="polite"
                  data-map-focus-notice={mapFocusNotice.tone}
                >
                  {mapFocusNotice.tone === "warning" ? (
                    <Skull className="mt-0.5 size-4 shrink-0 text-red-300" />
                  ) : (
                    <MapPinned className="mt-0.5 size-4 shrink-0 text-cyan-300" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">
                      {mapFocusNotice.title}
                    </div>
                    <div className="truncate text-[11px] opacity-80">
                      {mapFocusNotice.description}
                    </div>
                  </div>
                </div>
              )}

              <div
                className="absolute z-10 flex items-center rounded border border-border bg-card/90 p-1 shadow-sm backdrop-blur-sm"
                style={{
                  left: layersPanelPos.x,
                  top: layersPanelPos.y,
                }}
              >
                <div
                  className="mr-1 flex cursor-grab items-center justify-center rounded px-0.5 py-1.5 text-secondary transition-colors hover:bg-muted hover:text-primary active:cursor-grabbing"
                  onMouseDown={handleLayersMouseDown}
                  aria-label="拖动面板"
                >
                  <GripVertical className="size-4" />
                </div>
                <div role="group" aria-label="地图图层" className="flex gap-1">
                  {layerControls.map(({ id, label, icon: Icon }) => (
                    <ToggleButton
                      key={id}
                      label={label}
                      icon={<Icon />}
                      size="sm"
                      isPressed={layers.includes(id)}
                      onPressedChange={(pressed) =>
                        setLayers((current) =>
                          pressed ? [...current, id] : current.filter((layer) => layer !== id),
                        )
                      }
                    />
                  ))}
                </div>
                <Button type="button" className="ml-1 h-8 px-2 text-xs" aria-pressed={showKillFeed} onMouseDown={(event) => event.stopPropagation()} onClick={() => setShowKillFeed((current) => !current)} label={showKillFeed ? "隐藏淘汰信息" : "显示淘汰信息"} variant={showKillFeed ? "secondary" : "ghost"} icon={showKillFeed ? (
                    <Eye className="mr-1.5 size-3.5" />
                  ) : (
                    <EyeOff className="mr-1.5 size-3.5" />
                  )}>战报</Button>
              </div>

              <div className="absolute right-3 top-3 flex items-center gap-1 rounded border border-border bg-card/90 p-1 shadow-sm backdrop-blur-sm">
                <Button
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => zoomMap(mapTransform.scale * 1.25)}
                  label="放大地图"
                  variant="ghost"
                  size="sm"
                  icon={<ZoomIn className="size-4" />}
                  isIconOnly
                />
                <Button
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => zoomMap(mapTransform.scale / 1.25)}
                  label="缩小地图"
                  variant="ghost"
                  size="sm"
                  icon={<ZoomOut className="size-4" />}
                  isIconOnly
                />
                <Button
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setMapTransform({ x: 0, y: 0, scale: 1 })}
                  label="重置地图视图"
                  variant="ghost"
                  size="sm"
                  icon={<RotateCcw className="size-4" />}
                  isIconOnly
                />
              </div>

              <div className="absolute bottom-3 left-3 rounded border border-border bg-card/90 px-2 py-1 text-xs text-secondary shadow-sm backdrop-blur-sm">
                {Math.round(mapTransform.scale * 100)}%
              </div>

              {isLoadingAnalysis && (
                <div className="absolute inset-0 flex items-center justify-center bg-body/70 backdrop-blur-sm">
                  <div className="flex items-center gap-2 rounded border border-border bg-card px-4 py-3 text-sm text-secondary shadow-sm">
                    <Loader2 className="size-4 animate-spin" />
                    正在加载分析
                  </div>
                </div>
              )}

              {!isLoadingAnalysis && analysis && analysis.positions.length === 0 && analysis.life_events.length === 0 && (
                <div className="absolute rounded border border-border bg-card px-4 py-3 text-sm text-secondary shadow-sm">
                  暂无可视化轨迹数据
                </div>
              )}

              {analysis && (
                <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded border border-border bg-card/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm">
                  <Radio className="size-3.5 text-primary" />
                  <span className="font-semibold tabular-nums">TEAMS {aliveTeamCount}</span>
                  <span className="text-secondary">/</span>
                  <span className="font-semibold tabular-nums">ALIVE {alivePlayerCount}</span>
                </div>
              )}

              {showKillFeed && recentKillFeed.length > 0 && (
                <div
                  className="pointer-events-auto absolute right-3 top-14 flex w-[min(420px,55%)] flex-col gap-1.5"
                  data-kill-feed-panel
                >
                  <div className="flex items-center justify-between rounded border border-border bg-card/95 px-2.5 py-1 text-xs shadow-sm backdrop-blur-sm">
                    <span className="flex items-center gap-1.5 font-semibold">
                      <Skull className="size-3.5 text-red-400" />
                      淘汰信息
                    </span>
                    <Button
                      type="button"
                      className="size-6"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => setShowKillFeed(false)}
                      label="收起淘汰信息"
                      variant="ghost"
                      size="sm"
                      tooltip="收起淘汰信息"
                      icon={<EyeOff className="size-3.5" />}
                      isIconOnly
                    />
                  </div>
                  {recentKillFeed.map((event) => {
                    const eventColor = teamColor(
                      event.actor_team_id ?? event.victim_team_id ?? "unknown",
                      teams,
                    );
                    return (
                      <div
                        key={`feed-${event.id}`}
                        className="flex items-center justify-between gap-3 rounded border border-border bg-card/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm"
                        style={{ borderLeftColor: eventColor, borderLeftWidth: 3 }}
                      >
                        <span className="truncate font-medium">{replayEventLabel(event)}</span>
                        <Badge
                          variant={isEliminationEvent(event) ? "error" : "neutral"}
                          label={isEliminationEvent(event) ? "淘汰" : "击倒"}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

            </div>

        </div>
      </Card>

      <Card padding={0} className="flex flex-col gap-4 min-h-0 overflow-hidden border-border bg-card shadow-sm">
        <header className="grid pt-5 shrink-0 gap-1 border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-sm">战队实时排行</h3>
            <Badge variant="neutral" label={<>{teams.length} 队</>} />
          </div>
          <p className="text-sm text-secondary">玩家 / 淘汰 / 击倒 / 伤害</p>
        </header>
        <div className="px-5 pb-5 min-h-0 flex-1 p-0">
          <TeamReplayList
            teamRows={teamRows}
            playerStats={playerStats}
            selectedTeamId={selectedTeamId}
            selectedPlayerId={selectedPlayer?.player_id ?? null}
            onSelectTeam={selectAndFocusTeam}
            onSelectPlayer={selectAndFocusPlayer}
          />
        </div>
      </Card>
      </div>
    </div>
  );
}
