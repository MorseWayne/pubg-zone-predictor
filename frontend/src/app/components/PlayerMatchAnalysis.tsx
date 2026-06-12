import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Crosshair,
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
} from "lucide-react";
import {
  api,
  apiErrorMessage,
  IngestMatch,
  MapConfig,
  MatchAnalysis,
  MatchAnalysisLifeEvent,
  MatchAnalysisPosition,
  MatchAnalysisPlayer,
} from "../api";
import { pubgUnitsToKilometers } from "../pubgUnits";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Separator } from "./ui/separator";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const MAP_VIEW_SIZE = 1000;
const MAP_NAME_ALIASES: Record<string, string> = {
  Baltic_Main: "erangel",
  Erangel_Main: "erangel",
  Desert_Main: "miramar",
  Summerland_Main: "karakin",
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

type LayerId = "route" | "combat" | "eliminations" | "zones";
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

function traveledDistance(positions: MatchAnalysisPosition[]) {
  return positions.slice(1).reduce((total, position, index) => {
    const previous = positions[index];
    const dx = position.point.x - previous.point.x;
    const dy = position.point.y - previous.point.y;
    return total + Math.hypot(dx, dy);
  }, 0);
}

function groupedPositions(positions: MatchAnalysisPosition[]) {
  return positions.reduce<Record<string, MatchAnalysisPosition[]>>((groups, position) => {
    groups[position.player_id] = [...(groups[position.player_id] ?? []), position];
    return groups;
  }, {});
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

function teamRankLabel(team: TeamSummary) {
  return team.teamRank === null ? "未知" : `${team.teamRank}`;
}

function teamMemberNames(team: TeamSummary) {
  return team.players.map(playerDisplayName).join(" / ");
}

function teamOptionText(team: TeamSummary) {
  return teamMemberNames(team);
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
    event.event_type === "LogPlayerMakeGroggy" ||
    event.event_type === "LogPlayerTakeDamage"
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

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Route;
  label: string;
  value: string;
}) {
  return (
    <Card className="min-w-[132px] flex-1 border-border bg-card shadow-sm">
      <CardContent className="flex items-center gap-2 p-3">
        <div className="rounded border border-border bg-muted p-1.5 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="truncate text-base font-semibold text-foreground">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PlayerMatchAnalysis() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<MapConfig[]>([]);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [analysis, setAnalysis] = useState<MatchAnalysis | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [layers, setLayers] = useState<LayerId[]>(["route", "combat", "eliminations", "zones"]);
  const [mapTransform, setMapTransform] = useState<MapTransform>({ x: 0, y: 0, scale: 1 });
  const [isMapDragging, setIsMapDragging] = useState(false);
  const [mapDragStart, setMapDragStart] = useState<MapDragStart | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [layersPanelPos, setLayersPanelPos] = useState({ x: 12, y: 12 });
  const [isLayersDragging, setIsLayersDragging] = useState(false);
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
  const teams = useMemo(() => teamSummaries(analysis?.players ?? []), [analysis]);
  const selectedTeam = teams.find((team) => team.teamId === selectedTeamId);
  const selectedPositions = useMemo(() => {
    if (!analysis || !selectedTeamId) return [];
    return analysis.positions
      .filter((position) => position.team_id === selectedTeamId)
      .sort((left, right) => left.elapsed_time - right.elapsed_time);
  }, [analysis, selectedTeamId]);
  const selectedEvents = useMemo(
    () => (analysis?.life_events.filter((event) => isSelectedEvent(event, selectedTeamId)) ?? []),
    [analysis, selectedTeamId],
  );
  const positionGroups = groupedPositions(selectedPositions);
  const routeSegments = Object.entries(positionGroups)
    .map(([playerId, positions]) => ({
      playerId,
      path: routePath(positions, worldSize),
    }))
    .filter((segment): segment is { playerId: string; path: string } => Boolean(segment.path));
  const totalDistanceKm =
    pubgUnitsToKilometers(
      Object.values(positionGroups).reduce((total, positions) => total + traveledDistance(positions), 0),
    );
  const combatEvents = selectedEvents.filter(isCombatEvent);
  const eliminationEvents = selectedEvents.filter(isEliminationEvent);
  const killCount = eliminationEvents.filter(
    (event) => event.actor_team_id === selectedTeamId,
  ).length;
  const deathCount = eliminationEvents.filter(
    (event) => event.victim_team_id === selectedTeamId,
  ).length;

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

  useEffect(() => {
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
        setSelectedTeamId((current) => {
          const nextTeams = teamSummaries(payload.players);
          if (nextTeams.some((team) => team.teamId === current)) {
            return current;
          }
          return nextTeams[0]?.teamId ?? "";
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
    <div className="dark flex h-full w-full flex-col gap-3 overflow-hidden bg-background p-4 text-foreground">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded border border-border bg-muted p-2 text-primary">
            <MapPinned className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-foreground">四排战队对局分析</h1>
            <p className="truncate text-xs text-muted-foreground">全员路线、交战地点、淘汰链路和圈型阶段</p>
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

      <div className="flex shrink-0 flex-col gap-3 lg:flex-row">
        <Card className="flex-1 border-border bg-card shadow-sm">
          <CardContent className="flex h-full flex-col justify-center gap-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={selectedTeamId} onValueChange={setSelectedTeamId} disabled={!analysis || teams.length === 0}>
                <SelectTrigger className="w-full sm:w-[300px]">
                  <SelectValue placeholder="选择战队" />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-3rem)] md:w-[420px]">
                  <SelectGroup>
                    {teams.map((team) => (
                      <SelectItem key={team.teamId} value={team.teamId} textValue={teamOptionText(team)}>
                        {teamOptionText(team)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {selectedTeam && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">队伍 {selectedTeam.teamId}</Badge>
                <Badge variant="outline">排名 {teamRankLabel(selectedTeam)}</Badge>
                <Badge variant="outline">{selectedTeam.players.length} 人</Badge>
                {selectedTeam.players.map((player) => (
                  <Badge key={player.player_id} variant="secondary" className="max-w-[150px]">
                    <span
                      className="mr-1.5 size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: playerColor(player.player_id, selectedTeam) }}
                    />
                    <span className="truncate">{playerDisplayName(player)}</span>
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-1 flex-wrap gap-3">
          <StatCard icon={Route} label="转移距离" value={`${totalDistanceKm.toFixed(1)} km`} />
          <StatCard icon={Crosshair} label="交战事件" value={`${combatEvents.length}`} />
          <StatCard icon={Skull} label="淘汰" value={`${killCount}`} />
          <StatCard icon={Target} label="阵亡" value={`${deathCount}`} />
        </div>
      </div>

      <Card className="min-h-0 flex-1 overflow-hidden border-border bg-card shadow-sm">
        <CardContent className="h-full p-0">
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
                {activeMap && (
                  <img
                    src={api.mapImageUrl(activeMap.map_id, "high")}
                    alt={`${activeMap.display_name} map`}
                    className="absolute inset-0 size-full object-contain opacity-80"
                  />
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

                  {analysis && layers.includes("zones") && (
                    <g>
                      {analysis.circles.map((circle) => {
                        const center = pointToView(circle.center, worldSize);
                        const radius = radiusToView(circle.radius, worldSize);
                        return (
                          <g key={circle.phase}>
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
                              P{circle.phase}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  )}

                  {analysis &&
                    layers.includes("route") &&
                    routeSegments.map((segment) => (
                      <path
                        key={segment.playerId}
                        d={segment.path}
                        fill="none"
                        stroke={playerColor(segment.playerId, selectedTeam)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="3.5"
                        opacity="0.9"
                        filter="url(#analysis-glow)"
                      />
                    ))}

                  {analysis &&
                    layers.includes("route") &&
                    selectedPositions.map((position) => {
                      const point = pointToView(position.point, worldSize);
                      const color = playerColor(position.player_id, selectedTeam);
                      const playerPositions = positionGroups[position.player_id] ?? [];
                      const playerIndex = playerPositions.indexOf(position);
                      const isEndpoint = playerIndex === 0 || playerIndex === playerPositions.length - 1;
                      return (
                        <circle
                          key={`${position.player_id}-${position.elapsed_time}-${position.point.x}-${position.point.y}`}
                          cx={point.x}
                          cy={point.y}
                          r={isEndpoint ? 5 : 2.5}
                          fill={color}
                          opacity={isEndpoint ? 0.95 : 0.55}
                        />
                      );
                    })}

                  {analysis &&
                    layers.includes("combat") &&
                    selectedEvents
                      .filter((event) => event.point && !event.event_type.includes("Kill"))
                      .map((event) => {
                        const point = pointToView(event.point as { x: number; y: number }, worldSize);
                        const color = playerColor(eventTeamPlayerId(event, selectedTeamId), selectedTeam);
                        return (
                          <g key={event.id}>
                            <circle cx={point.x} cy={point.y} r="8" fill="rgba(250,204,21,0.18)" stroke={color} strokeWidth="2" />
                            <circle cx={point.x} cy={point.y} r="2.5" fill={color} />
                          </g>
                        );
                      })}

                  {analysis &&
                    layers.includes("eliminations") &&
                    eliminationEvents
                      .filter((event) => event.point)
                      .map((event) => {
                        const point = pointToView(event.point as { x: number; y: number }, worldSize);
                        const color = playerColor(eventTeamPlayerId(event, selectedTeamId), selectedTeam);
                        return (
                          <g key={event.id}>
                            <circle cx={point.x} cy={point.y} r="11" fill="rgba(244,63,94,0.2)" stroke={color} strokeWidth="2.5" />
                            <path d={`M ${point.x - 5} ${point.y - 5} L ${point.x + 5} ${point.y + 5} M ${point.x + 5} ${point.y - 5} L ${point.x - 5} ${point.y + 5}`} stroke={color} strokeLinecap="round" strokeWidth="2" />
                          </g>
                        );
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
                  <ToggleGroupItem value="zones" aria-label="圈型" className="h-8 px-2 text-xs">
                    <Shield className="mr-1.5 size-3.5" />
                    圈型
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
            </div>
          </CardContent>
        </Card>
    </div>
  );
}
