import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Loader2,
  MapPinned,
  RefreshCw,
  RotateCcw,
  Route,
  Shield,
  Skull,
  Swords,
  Target,
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
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Slider } from "./ui/slider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const MAP_VIEW_SIZE = 1000;
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
const PLAYBACK_FRAME_INTERVAL_MS = 50;
const PLAYER_LABEL_ZOOM_THRESHOLD = 1.7;

type LayerId = "route" | "combat" | "eliminations" | "zones" | "flightPath";
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
type PlayerMarkerLayoutInput = {
  playerId: string;
  teamId: string;
  label: string;
  anchorX: number;
  anchorY: number;
  priority: number;
};
type PlayerMarkerLayout = {
  markerWidth: number;
  offsetX: number;
  offsetY: number;
};
type MarkerCollisionBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function markerWidthForLabel(label: string) {
  return Math.max(48, Math.min(116, label.length * 6.6 + 12));
}

function markerBoxesOverlap(left: MarkerCollisionBox, right: MarkerCollisionBox) {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

function layoutPlayerMarkers(inputs: PlayerMarkerLayoutInput[]) {
  const layouts = new Map<string, PlayerMarkerLayout>();
  const placedBoxes: MarkerCollisionBox[] = [];
  const orderedInputs = [...inputs].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.teamId.localeCompare(right.teamId, undefined, { numeric: true }) ||
      left.playerId.localeCompare(right.playerId),
  );

  for (const input of orderedInputs) {
    const markerWidth = markerWidthForLabel(input.label);
    const horizontalStep = markerWidth + 8;
    const verticalStep = 22;
    const candidates = [{ x: 0, y: 0 }];
    for (let ring = 1; ring <= 3; ring += 1) {
      candidates.push(
        { x: 0, y: verticalStep * ring },
        { x: 0, y: -verticalStep * ring },
        { x: horizontalStep * ring, y: 0 },
        { x: -horizontalStep * ring, y: 0 },
        { x: horizontalStep * ring, y: verticalStep * ring },
        { x: -horizontalStep * ring, y: verticalStep * ring },
        { x: horizontalStep * ring, y: -verticalStep * ring },
        { x: -horizontalStep * ring, y: -verticalStep * ring },
      );
    }

    let selectedOffset = candidates[candidates.length - 1];
    let selectedBox: MarkerCollisionBox | null = null;
    for (const candidate of candidates) {
      const centerX = input.anchorX + candidate.x;
      const centerY = input.anchorY + candidate.y;
      const box = {
        left: centerX - markerWidth / 2 - 4,
        right: centerX + markerWidth / 2 + 4,
        top: centerY + 5,
        bottom: centerY + 25,
      };
      if (placedBoxes.every((placedBox) => !markerBoxesOverlap(box, placedBox))) {
        selectedOffset = candidate;
        selectedBox = box;
        break;
      }
    }

    if (!selectedBox) {
      const centerX = input.anchorX + selectedOffset.x;
      const centerY = input.anchorY + selectedOffset.y;
      selectedBox = {
        left: centerX - markerWidth / 2 - 4,
        right: centerX + markerWidth / 2 + 4,
        top: centerY + 5,
        bottom: centerY + 25,
      };
    }
    placedBoxes.push(selectedBox);
    layouts.set(input.playerId, {
      markerWidth,
      offsetX: selectedOffset.x,
      offsetY: selectedOffset.y,
    });
  }

  return layouts;
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

function positionHeadingDegrees(
  positions: MatchAnalysisPosition[],
  playbackTime: number,
) {
  if (positions.length < 2) return null;

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

  const currentIndex = Math.max(0, high);
  const vectors: Array<[MatchAnalysisPosition, MatchAnalysisPosition]> = [];
  if (currentIndex < positions.length - 1) {
    vectors.push([positions[currentIndex], positions[currentIndex + 1]]);
  }
  if (currentIndex > 0) {
    vectors.push([positions[currentIndex - 1], positions[currentIndex]]);
  }

  for (const [start, end] of vectors) {
    if (end.elapsed_time - start.elapsed_time > 20) continue;
    const dx = end.point.x - start.point.x;
    const dy = end.point.y - start.point.y;
    if (Math.hypot(dx, dy) < 25) continue;
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  return null;
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
  return positions.reduce<Record<string, MatchAnalysisPosition[]>>((groups, position) => {
    groups[position.player_id] = [...(groups[position.player_id] ?? []), position];
    return groups;
  }, {});
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

  let line = fitPrincipalLine(uniquePoints);
  if (!line) return null;

  const residuals = uniquePoints.map((point) => perpendicularDistance(point, line));
  const residualLimit = Math.max(
    worldSize * 0.015,
    Math.min(worldSize * 0.08, median(residuals) * 2.5),
  );
  const inliers = uniquePoints.filter((point) => perpendicularDistance(point, line) <= residualLimit);

  if (inliers.length >= FLIGHT_PATH_MIN_POINTS) {
    line = fitPrincipalLine(inliers) ?? line;
  }

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

function isSelectedEvent(event: MatchAnalysisLifeEvent, teamId: string) {
  return (
    Boolean(teamId) &&
    (event.actor_team_id === teamId || event.victim_team_id === teamId)
  );
}

function isEliminationEvent(event: MatchAnalysisLifeEvent) {
  return event.event_type === "LogPlayerKill" || event.event_type === "LogPlayerKillV2";
}

function isCombatEvent(event: MatchAnalysisLifeEvent) {
  return (
    isEliminationEvent(event) ||
    event.event_type === "LogPlayerMakeGroggy"
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

export function PlayerMatchAnalysis() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState(() => {
    if (typeof window !== "undefined") {
      return searchParams.get("matches") || "";
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
  const [isTeamSearchOpen, setIsTeamSearchOpen] = useState(false);

  const [playbackTime, setPlaybackTime] = useState(0);
  const playbackSecond = Math.floor(playbackTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(5);

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
        time - lastTimeRef.current < PLAYBACK_FRAME_INTERVAL_MS
      ) {
        animationFrameId = requestAnimationFrame(tick);
        return;
      }
      if (lastTimeRef.current !== 0) {
        const deltaSeconds = (time - lastTimeRef.current) / 1000;
        setPlaybackTime((prev) => {
          const next = prev + deltaSeconds * playbackSpeed;
          if (next >= maxPlaybackTime) {
            setIsPlaying(false);
            return maxPlaybackTime;
          }
          return next;
        });
      }
      lastTimeRef.current = time;
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
  const allPositionGroups = useMemo(() => {
    const groups = groupedPositions(analysis?.positions ?? []);
    for (const positions of Object.values(groups)) {
      positions.sort((left, right) => left.elapsed_time - right.elapsed_time);
    }
    return groups;
  }, [analysis]);

  const playerStats = useMemo(() => {
    const stats: Record<string, PlayerReplayStats> = {};
    for (const player of analysis?.players ?? []) {
      stats[player.player_id] = { kills: 0, knocks: 0, damage: 0, deadAt: null };
    }
    for (const event of analysis?.life_events ?? []) {
      if (event.elapsed_time > playbackSecond) break;
      if (event.actor_player_id && stats[event.actor_player_id]) {
        if (isEliminationEvent(event)) {
          stats[event.actor_player_id].kills += 1;
        } else if (event.event_type === "LogPlayerMakeGroggy") {
          stats[event.actor_player_id].knocks += 1;
        } else if (event.event_type === "LogPlayerTakeDamage" && event.damage) {
          stats[event.actor_player_id].damage += event.damage;
        }
      }
      if (
        isEliminationEvent(event) &&
        event.victim_player_id &&
        stats[event.victim_player_id]
      ) {
        stats[event.victim_player_id].deadAt = event.elapsed_time;
      }
    }
    return stats;
  }, [analysis, playbackSecond]);

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
        .map((positions) => {
          const position = interpolatePosition(positions, playbackTime);
          return position
            ? {
                ...position,
                heading: positionHeadingDegrees(positions, playbackTime),
              }
            : null;
        })
        .filter(
          (
            position,
          ): position is MatchAnalysisPosition & { heading: number | null } =>
            position !== null && !deadPlayers.has(position.player_id),
        ),
    [allPositionGroups, deadPlayers, playbackTime],
  );
  const playerMarkerLayouts = useMemo(
    () =>
      layoutPlayerMarkers(
        currentPlayerPositions.flatMap((position) => {
          const player = playersById.get(position.player_id);
          const label = player ? playerDisplayName(player) : position.player_id;
          const point = pointToView(position.point, worldSize);
          const isSelectedPlayer =
            position.player_id === selectedPlayerId ||
            (player !== undefined && playerDisplayName(player) === selectedPlayerId);
          const isSelectedTeam = position.team_id === selectedTeamId;
          if (
            !isSelectedPlayer &&
            !isSelectedTeam &&
            mapTransform.scale < PLAYER_LABEL_ZOOM_THRESHOLD
          ) {
            return [];
          }
          return [
            {
              playerId: position.player_id,
              teamId: position.team_id,
              label,
              anchorX: point.x * mapTransform.scale,
              anchorY: point.y * mapTransform.scale,
              priority: isSelectedPlayer ? 2 : isSelectedTeam ? 1 : 0,
            },
          ];
        }),
      ),
    [
      currentPlayerPositions,
      mapTransform.scale,
      playersById,
      selectedPlayerId,
      selectedTeamId,
      worldSize,
    ],
  );

  const selectedPositions = useMemo(() => {
    if (!analysis || !selectedTeamId) return [];
    return analysis.positions
      .filter((position) => position.team_id === selectedTeamId && position.elapsed_time <= playbackSecond)
      .sort((left, right) => left.elapsed_time - right.elapsed_time);
  }, [analysis, selectedTeamId, playbackSecond]);

  const teamRows = useMemo<TeamReplayRow[]>(() => {
    const rows = teams.map((team) => {
      const teamPlayerStats = team.players.map(
        (player) => playerStats[player.player_id] ?? { kills: 0, knocks: 0, damage: 0, deadAt: null },
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
  const aliveTeamCount = teamRows.filter((row) => row.aliveCount > 0).length;
  const alivePlayerCount = Math.max(0, (analysis?.players.length ?? 0) - deadPlayers.size);
  const recentKillFeed = useMemo(
    () =>
      (analysis?.life_events ?? [])
        .filter(
          (event) =>
            event.elapsed_time <= playbackSecond &&
            event.elapsed_time >= Math.max(0, playbackSecond - 18) &&
            (isEliminationEvent(event) || event.event_type === "LogPlayerMakeGroggy"),
        )
        .slice(-5)
        .reverse(),
    [analysis, playbackSecond],
  );

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

  const selectedEvents = useMemo(
    () =>
      analysis?.life_events.filter(
        (event) =>
          isSelectedEvent(event, selectedTeamId) &&
          event.elapsed_time <= playbackSecond,
      ) ?? [],
    [analysis, selectedTeamId, playbackSecond],
  );

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
  const { combatEvents, eliminationEvents } = useMemo(() => {
    const nextEliminationEvents = selectedEvents.filter(isEliminationEvent);
    const eliminationTimesByVictim = new Map<string, number[]>();
    for (const event of nextEliminationEvents) {
      if (!event.victim_player_id) continue;
      const times = eliminationTimesByVictim.get(event.victim_player_id) ?? [];
      times.push(event.elapsed_time);
      eliminationTimesByVictim.set(event.victim_player_id, times);
    }
    const nextCombatEvents = selectedEvents.filter(isCombatEvent).filter((event) => {
      if (isEliminationEvent(event)) return true;
      if (!event.victim_player_id) return true;
      return !(eliminationTimesByVictim.get(event.victim_player_id) ?? []).some(
        (elapsedTime) =>
          elapsedTime >= event.elapsed_time &&
          elapsedTime <= event.elapsed_time + 60,
      );
    });
    return {
      combatEvents: nextCombatEvents,
      eliminationEvents: nextEliminationEvents,
    };
  }, [selectedEvents]);

  const clusteredMapEvents = useMemo(() => {
    if (!analysis) return [];
    let activeEvents: MatchAnalysisLifeEvent[] = [];
    if (layers.includes("combat")) {
      activeEvents = activeEvents.concat(combatEvents.filter(e => e.point && !isEliminationEvent(e)));
    }
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
      clusters.forEach(cluster => {
        const d = Math.hypot(cluster.point.x - pt.x, cluster.point.y - pt.y);
        if (d < minDistance) {
          minDistance = d;
          nearestCluster = cluster;
        }
      });
      
      if (nearestCluster && minDistance < CLUSTER_DISTANCE) {
        nearestCluster.events.push(event);
      } else {
        clusters.push({ id: `cluster-${event.id}`, point: pt, events: [event] });
      }
    });
    return clusters;
  }, [analysis, layers, combatEvents, eliminationEvents, mapTransform.scale, worldSize]);
  const refreshMatches = async () => {
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
      setSelectedMatchId((current) => current || nextParsedMatches[0]?.match_id || nextSquadMatches[0]?.match_id || "");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refreshMatches();
  }, []);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setMapTransform({ x: 0, y: 0, scale: 1 });
    setIsMapDragging(false);
    setMapDragStart(null);
    setIsTeamSearchOpen(false);
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
    const scale = Math.max(1, Math.min(nextScale, 8));
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

  return (
    <div className="dark flex h-full w-full flex-col gap-3 overflow-hidden bg-background p-3 text-foreground">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded border border-border bg-muted p-2 text-primary">
            <MapPinned className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-bold text-foreground">2D 对局回放</h1>
              {analysis && (
                <>
                  <Badge variant="outline">{aliveTeamCount} 队存活</Badge>
                  <Badge variant="outline">{alivePlayerCount} 人存活</Badge>
                </>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">全员位置、安全区、交战事件与队伍实时状态</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <Select value={selectedMatchId} onValueChange={setSelectedMatchId}>
            <SelectTrigger className="w-full sm:w-[300px]">
              <SelectValue placeholder="选择对局" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {squadMatches.map((match) => (
                  <SelectItem key={match.match_id} value={match.match_id}>
                    {matchTitle(match)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Popover open={isTeamSearchOpen} onOpenChange={setIsTeamSearchOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={isTeamSearchOpen}
                aria-label="搜索并高亮队伍"
                className="w-full justify-between sm:w-[220px]"
                disabled={!analysis || teams.length === 0}
              >
                <span className="truncate">
                  {selectedTeam
                    ? `队伍 ${selectedTeam.teamId} · ${selectedTeam.players.length} 人`
                    : "搜索高亮队伍"}
                </span>
                <ChevronsUpDown data-icon="inline-end" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[320px] max-w-[calc(100vw-2rem)] p-0"
              align="end"
            >
              <Command>
                <CommandInput placeholder="搜索队伍 ID 或选手名" />
                <CommandList>
                  <CommandEmpty>没有匹配的队伍</CommandEmpty>
                  <CommandGroup>
                    {teams.map((team) => (
                      <CommandItem
                        key={team.teamId}
                        value={`队伍 ${team.teamId} ${team.players.map(playerDisplayName).join(" ")}`}
                        onSelect={() => {
                          setSelectedTeamId(team.teamId);
                          setIsTeamSearchOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            selectedTeamId === team.teamId
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                        <div className="min-w-0">
                          <div className="font-medium">
                            队伍 {team.teamId} · {team.players.length} 人
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {team.players.map(playerDisplayName).join(" / ")}
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Select
            value={selectedPlayer?.player_id ?? ""}
            onValueChange={(playerId) => {
              const player = analysis?.players.find((item) => item.player_id === playerId);
              if (!player) return;
              setSelectedTeamId(player.team_id);
              setSelectedPlayerId(player.player_id);
            }}
            disabled={!analysis || analysis.players.length === 0}
          >
            <SelectTrigger className="w-full sm:w-[220px]">
              <SelectValue
                placeholder={
                  isPinnedPlayerUnavailable
                    ? "关注选手不在本场"
                    : "固定关注选手"
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {(analysis?.players ?? []).map((player) => (
                  <SelectItem key={player.player_id} value={player.player_id}>
                    {playerDisplayName(player)} · 队伍 {player.team_id}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={refreshMatches} disabled={isLoading}>
            {isLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="shrink-0">
          <AlertTriangle />
          <AlertTitle>数据加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="flex min-h-0 flex-col overflow-hidden border-border bg-card shadow-sm">
        <CardHeader className="shrink-0 gap-3 border-b border-border px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="text-sm">回放控制</CardTitle>
              <CardDescription className="truncate">
                {activeMatch ? matchTitle(activeMatch) : "请选择已解析对局"}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {currentCircle && <Badge variant="secondary">阶段 {currentCircle.phase}</Badge>}
              <Badge variant="outline">{formatPlaybackTime(playbackTime)}</Badge>
            </div>
          </div>
          {analysis && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  if (!isPlaying && playbackTime >= maxPlaybackTime) {
                    setPlaybackTime(0);
                  }
                  setIsPlaying(!isPlaying);
                }}
                aria-label={isPlaying ? "暂停回放" : "播放回放"}
              >
                {isPlaying ? <Pause /> : <Play />}
              </Button>
              <div className="relative flex h-8 flex-1 items-center px-1">
                <Slider
                  value={[playbackTime]}
                  min={0}
                  max={maxPlaybackTime}
                  step={0.25}
                  onValueChange={(values) => {
                    setIsPlaying(false);
                    setPlaybackTime(values[0]);
                  }}
                  className="cursor-grab active:cursor-grabbing"
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
              <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatPlaybackTime(maxPlaybackTime)}
              </span>
              <Select value={playbackSpeed.toString()} onValueChange={(value) => setPlaybackSpeed(Number(value))}>
                <SelectTrigger className="w-[76px] shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="0.5">0.5x</SelectItem>
                    <SelectItem value="1">1x</SelectItem>
                    <SelectItem value="2">2x</SelectItem>
                    <SelectItem value="5">5x</SelectItem>
                    <SelectItem value="10">10x</SelectItem>
                    <SelectItem value="16">16x</SelectItem>
                    <SelectItem value="20">20x</SelectItem>
                    <SelectItem value="32">32x</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <TooltipProvider delayDuration={100}>
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
                className="absolute inset-0 origin-top-left"
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

                  {analysis &&
                    layers.includes("route") &&
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
                    ))}

                  {analysis &&
                    layers.includes("route") &&
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
                    })}

                  {currentPlayerPositions.map((position) => {
                    const point = pointToView(position.point, worldSize);
                    const invScale = 1 / mapTransform.scale;
                    const color = teamColor(position.team_id, teams);
                    const player = playersById.get(position.player_id);
                    const label = player ? playerDisplayName(player) : position.player_id;
                    const isSelectedTeam = position.team_id === selectedTeamId;
                    const isSelectedPlayer = position.player_id === selectedPlayer?.player_id;
                    const markerOpacity = isSelectedPlayer ? 0.96 : isSelectedTeam ? 0.84 : 0.72;
                    const showPlayerLabel =
                      isSelectedTeam ||
                      isSelectedPlayer ||
                      mapTransform.scale >= PLAYER_LABEL_ZOOM_THRESHOLD;
                    const markerLayout = playerMarkerLayouts.get(position.player_id);
                    const markerWidth = markerLayout?.markerWidth ?? markerWidthForLabel(label);
                    const markerOffsetX = markerLayout?.offsetX ?? 0;
                    const markerOffsetY = markerLayout?.offsetY ?? 0;
                    const isMarkerDisplaced =
                      Math.abs(markerOffsetX) > 0.5 || Math.abs(markerOffsetY) > 0.5;
                    const markerRotation =
                      position.movement_mode === "vehicle" || position.heading === null
                        ? 0
                        : position.heading + 90;
                    const stateLabel = movementStateLabel(position);
                    return (
                      <g
                        key={`player-${position.player_id}`}
                        transform={`translate(${point.x}, ${point.y}) scale(${invScale})`}
                        className="cursor-pointer"
                        pointerEvents="all"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          setSelectedTeamId(position.team_id);
                          setSelectedPlayerId(position.player_id);
                        }}
                      >
                        <title>
                          {position.team_id} · {label} · {stateLabel}
                        </title>
                        {showPlayerLabel && isMarkerDisplaced && (
                          <g pointerEvents="none">
                            <line
                              x1="0"
                              y1="0"
                              x2={markerOffsetX}
                              y2={markerOffsetY}
                              stroke={color}
                              strokeWidth="1"
                              strokeDasharray="2 3"
                              opacity={isSelectedTeam || isSelectedPlayer ? 0.7 : 0.4}
                            />
                            <circle
                              cx="0"
                              cy="0"
                              r="2.5"
                              fill={color}
                              stroke="#09090b"
                              strokeWidth="1"
                            />
                          </g>
                        )}
                        <g
                          transform={`translate(${markerOffsetX} ${markerOffsetY})`}
                          opacity={markerOpacity}
                        >
                        {position.movement_mode === "foot" && position.heading !== null && (
                          <g transform={`rotate(${markerRotation})`} pointerEvents="none">
                            <path
                              d="M 0 -13 L 4 -7 L -4 -7 Z"
                              fill="#ffffff"
                              stroke="#09090b"
                              strokeWidth="1.2"
                              strokeLinejoin="round"
                            />
                          </g>
                        )}
                        {showPlayerLabel && (
                          <g
                            transform={`translate(${-markerWidth / 2} 6)`}
                          >
                            <rect
                              x="0"
                              y="0"
                              width={markerWidth}
                              height="18"
                              rx="1"
                              fill={color}
                              stroke={isSelectedPlayer ? "#ffffff" : "rgba(9,9,11,0.9)"}
                              strokeWidth={isSelectedPlayer ? 1.5 : 1}
                            />
                            <text
                              x="6"
                              y="12.5"
                              fill="#ffffff"
                              stroke="rgba(0,0,0,0.35)"
                              strokeWidth="0.75"
                              paintOrder="stroke"
                              fontSize="10.5"
                              fontWeight={isSelectedPlayer ? 800 : 650}
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
                            r="9"
                            fill={color}
                            stroke={isSelectedPlayer ? "#ffffff" : "rgba(9,9,11,0.95)"}
                            strokeWidth={isSelectedPlayer ? 1.75 : 1.5}
                          />
                          {position.movement_mode === "vehicle" && (
                            <g pointerEvents="none" opacity="0.55">
                              <circle
                                cx="0"
                                cy="0"
                                r="6.3"
                                fill="none"
                                stroke="#ffffff"
                                strokeWidth="0.75"
                              />
                              <path
                                d="M -5.6 -1.8 H 5.6 M 0 1 V 6 M -4.8 -1.5 L -1.2 1.5 M 4.8 -1.5 L 1.2 1.5"
                                fill="none"
                                stroke="#ffffff"
                                strokeWidth="0.7"
                                strokeLinecap="round"
                              />
                            </g>
                          )}
                          <text
                            x="0"
                            y="3.25"
                            fill="#ffffff"
                            stroke="rgba(0,0,0,0.45)"
                            strokeWidth="1"
                            paintOrder="stroke"
                            fontSize={
                              position.team_id.length >= 3
                                ? 7
                                : position.team_id.length === 2
                                  ? 8
                                  : 10
                            }
                            fontWeight="900"
                            textAnchor="middle"
                          >
                            {position.team_id}
                          </text>
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
                      const isKill = isEliminationEvent(event);
                      const isKnockdown = event.event_type === "LogPlayerMakeGroggy";
                      const action = isKill ? "淘汰" : (isKnockdown ? "击倒" : "攻击");
                      const label = `${event.actor_player_name || "未知"} ${action}了 ${event.victim_player_name || "未知"}`;
                      
                      if (isKill) {
                        return (
                          <Tooltip key={cluster.id}>
                            <TooltipTrigger asChild>
                              <g transform={`translate(${cluster.point.x}, ${cluster.point.y}) scale(${invScale})`} className="cursor-pointer" pointerEvents="bounding-box">
                                <circle cx="0" cy="0" r="10" fill="rgba(244,63,94,0.3)" stroke={color} strokeWidth="1.5" />
                                <Skull x="-7" y="-7" width="14" height="14" color="#fff" style={{ filter: `drop-shadow(0px 0px 3px ${color})` }} />
                              </g>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="border-red-500/30 bg-black/90 text-red-50">
                              <p className="font-medium">{label}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      } else {
                        return (
                          <Tooltip key={cluster.id}>
                            <TooltipTrigger asChild>
                              <g transform={`translate(${cluster.point.x}, ${cluster.point.y}) scale(${invScale})`} className="cursor-pointer" pointerEvents="bounding-box">
                                <circle cx="0" cy="0" r="7" fill="rgba(250,204,21,0.2)" stroke={color} strokeWidth="1.5" strokeDasharray={isKnockdown ? "" : "2 2"} />
                                <Target x="-6" y="-6" width="12" height="12" color={color} strokeWidth={isKnockdown ? 2.5 : 2} />
                              </g>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="border-yellow-500/30 bg-black/90 text-yellow-50">
                              <p className="font-medium">{label}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      }
                    } else {
                      const killCount = cluster.events.filter(isEliminationEvent).length;
                      const hasKills = killCount > 0;
                      const baseColor = hasKills ? "rgba(244,63,94,1)" : "rgba(250,204,21,1)";
                      const bgColor = hasKills ? "rgba(244,63,94,0.4)" : "rgba(250,204,21,0.4)";
                      
                      return (
                        <Tooltip key={cluster.id}>
                          <TooltipTrigger asChild>
                            <g transform={`translate(${cluster.point.x}, ${cluster.point.y}) scale(${invScale})`} className="cursor-pointer" pointerEvents="bounding-box">
                              <circle cx="0" cy="0" r="12" fill={bgColor} stroke={baseColor} strokeWidth="1.5" />
                              <circle cx="0" cy="0" r="16" fill="none" stroke={baseColor} strokeWidth="1.5" strokeDasharray="3 3" className="animate-[spin_4s_linear_infinite]" opacity="0.8" />
                              <text x="0" y="3.5" fontSize="10" fontWeight="bold" fill="#fff" textAnchor="middle">{cluster.events.length}</text>
                            </g>
                          </TooltipTrigger>
                          <TooltipContent side="top" className={`bg-black/90 text-white ${hasKills ? 'border-red-500/30' : 'border-yellow-500/30'}`}>
                            <div className="flex flex-col gap-1">
                              {cluster.events.map((event, i) => {
                                const isKill = isEliminationEvent(event);
                                const isKnockdown = event.event_type === "LogPlayerMakeGroggy";
                                const action = isKill ? "淘汰" : (isKnockdown ? "击倒" : "攻击");
                                return (
                                  <p key={i} className="text-xs">
                                    <span className="opacity-80">{event.actor_player_name || "未知"}</span>
                                    <span className={isKill ? "text-red-400 mx-1" : "text-yellow-400 mx-1"}>{action}了</span>
                                    <span className="opacity-80">{event.victim_player_name || "未知"}</span>
                                  </p>
                                );
                              })}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                  })}
                </svg>
              </div>

              <div
                className="absolute z-10 flex items-center rounded border border-border bg-card/90 p-1 shadow-sm backdrop-blur-sm"
                style={{
                  left: layersPanelPos.x,
                  top: layersPanelPos.y,
                }}
              >
                <div
                  className="mr-1 flex cursor-grab items-center justify-center rounded px-0.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
                  onMouseDown={handleLayersMouseDown}
                  aria-label="拖动面板"
                >
                  <GripVertical className="size-4" />
                </div>
                <ToggleGroup
                  type="multiple"
                  value={layers}
                  onValueChange={(value) => setLayers(value as LayerId[])}
                  className="flex gap-1"
                >
                  <ToggleGroupItem value="route" aria-label="路线" className="h-8 px-2 text-xs">
                    <Route className="mr-1.5 size-3.5" />
                    路线
                  </ToggleGroupItem>
                  <ToggleGroupItem value="combat" aria-label="交战" className="h-8 px-2 text-xs">
                    <Swords className="mr-1.5 size-3.5" />
                    交战
                  </ToggleGroupItem>
                  <ToggleGroupItem value="eliminations" aria-label="淘汰" className="h-8 px-2 text-xs">
                    <Skull className="mr-1.5 size-3.5" />
                    淘汰
                  </ToggleGroupItem>
                  <ToggleGroupItem value="zones" aria-label="安全区" className="h-8 px-2 text-xs">
                    <Shield className="mr-1.5 size-3.5" />
                    安全区
                  </ToggleGroupItem>
                  <ToggleGroupItem value="flightPath" aria-label="航线" className="h-8 px-2 text-xs">
                    <Plane className="mr-1.5 size-3.5" />
                    航线
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <div className="absolute right-3 top-3 flex items-center gap-1 rounded border border-border bg-card/90 p-1 shadow-sm backdrop-blur-sm">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => zoomMap(mapTransform.scale * 1.25)}
                  aria-label="放大地图"
                >
                  <ZoomIn className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => zoomMap(mapTransform.scale / 1.25)}
                  aria-label="缩小地图"
                >
                  <ZoomOut className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setMapTransform({ x: 0, y: 0, scale: 1 })}
                  aria-label="重置地图视图"
                >
                  <RotateCcw className="size-4" />
                </Button>
              </div>

              <div className="absolute bottom-3 left-3 rounded border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                {Math.round(mapTransform.scale * 100)}%
              </div>

              {isLoadingAnalysis && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                  <div className="flex items-center gap-2 rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
                    <Loader2 className="size-4 animate-spin" />
                    正在加载分析
                  </div>
                </div>
              )}

              {!isLoadingAnalysis && analysis && analysis.positions.length === 0 && analysis.life_events.length === 0 && (
                <div className="absolute rounded border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
                  暂无可视化轨迹数据
                </div>
              )}

              {analysis && (
                <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded border border-border bg-card/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm">
                  <Radio className="size-3.5 text-primary" />
                  <span className="font-semibold tabular-nums">TEAMS {aliveTeamCount}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="font-semibold tabular-nums">ALIVE {alivePlayerCount}</span>
                </div>
              )}

              {recentKillFeed.length > 0 && (
                <div className="pointer-events-none absolute right-3 top-14 flex w-[min(420px,55%)] flex-col gap-1.5">
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
                        <Badge variant={isEliminationEvent(event) ? "destructive" : "secondary"}>
                          {isEliminationEvent(event) ? "淘汰" : "击倒"}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}

            </div>
          </TooltipProvider>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col overflow-hidden border-border bg-card shadow-sm">
        <CardHeader className="shrink-0 gap-1 border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">战队实时排行</CardTitle>
            <Badge variant="outline">{teams.length} 队</Badge>
          </div>
          <CardDescription>玩家 / 淘汰 / 击倒 / 伤害</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 p-0">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-2 p-2">
              {teamRows.map((row) => (
                <div
                  key={row.team.teamId}
                  className={cn(
                    "overflow-hidden rounded-md border border-border bg-muted/20",
                    row.team.teamId === selectedTeamId && "bg-accent/60 ring-1 ring-primary/30",
                  )}
                  style={{ borderLeftColor: row.color, borderLeftWidth: 4 }}
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-accent/50"
                    onClick={() => setSelectedTeamId(row.team.teamId)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-7 text-sm font-black tabular-nums" style={{ color: row.color }}>
                        {row.team.teamId}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold">
                          {row.aliveCount > 0 ? `${row.aliveCount} 人存活` : "全队淘汰"}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {row.displayRank ? `当前 #${row.displayRank}` : "仍在争夺排名"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      <span>{row.kills}</span>
                      <span className="w-10 text-right">{Math.round(row.damage)}</span>
                    </div>
                  </button>
                  <div className="border-t border-border/70 px-2 py-1">
                    {row.team.players.map((player) => {
                      const stats = playerStats[player.player_id] ?? {
                        kills: 0,
                        knocks: 0,
                        damage: 0,
                        deadAt: null,
                      };
                      const isSelected = player.player_id === selectedPlayer?.player_id;
                      return (
                        <button
                          key={player.player_id}
                          type="button"
                          className={cn(
                            "grid w-full grid-cols-[minmax(0,1fr)_30px_30px_48px] items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/50",
                            isSelected && "bg-accent text-accent-foreground",
                            stats.deadAt !== null && "text-muted-foreground",
                          )}
                          onClick={() => {
                            setSelectedTeamId(row.team.teamId);
                            setSelectedPlayerId(player.player_id);
                          }}
                        >
                          <span className={cn("truncate", stats.deadAt !== null && "line-through")}>
                            {playerDisplayName(player)}
                          </span>
                          <span className="text-right tabular-nums">{stats.kills}</span>
                          <span className="text-right tabular-nums">{stats.knocks}</span>
                          <span className="text-right tabular-nums">{Math.round(stats.damage)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
