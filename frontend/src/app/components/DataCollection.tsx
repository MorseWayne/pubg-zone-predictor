import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Clock3,
  Database,
  Filter,
  Loader2,
  ListChecks,
  Play,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, apiErrorMessage, IngestJob, IngestMatch, PlayerSearchResult } from "../api";
import { Alert, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Progress } from "./ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { cn } from "./ui/utils";

type TaskStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
type MatchSortKey = "match_id" | "map_name" | "created_at" | "telemetry_parse_status" | "sample_count";
type SortDirection = "asc" | "desc";
type MatchStatusFilter = "all" | "completed" | "failed" | "pending";

const DATA_COLLECTION_STORAGE_KEY = "pubg-zone-predictor:data-collection";
const REPLAY_PARSE_PROFILE = "full";
const REPLAY_POSITION_INTERVAL_SECONDS = 5;
const PUBG_MAP_DISPLAY_NAMES: Record<string, string> = {
  Baltic_Main: "Erangel",
  Erangel_Main: "Erangel",
  Chimera_Main: "Paramo",
  Desert_Main: "Miramar",
  Savage_Main: "Sanhok",
  DihorOtok_Main: "Vikendi",
  Summerland_Main: "Karakin",
  Tiger_Main: "Taego",
  Kiki_Main: "Deston",
  Neon_Main: "Rondo",
};

type PersistedCollectionState = {
  limit?: number;
  playerQuery?: string;
  selectedPlayerNames?: string[];
  currentJobId?: string | null;
};

function clampLimit(value: unknown) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return 20;
  return Math.max(1, Math.min(100, Math.round(numericValue)));
}

function readPersistedCollectionState(): PersistedCollectionState {
  if (typeof window === "undefined") return {};
  try {
    const rawValue = window.localStorage.getItem(DATA_COLLECTION_STORAGE_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue) as Record<string, unknown>;
    return {
      limit: clampLimit(parsedValue.limit),
      playerQuery: typeof parsedValue.playerQuery === "string" ? parsedValue.playerQuery : undefined,
      selectedPlayerNames: Array.isArray(parsedValue.selectedPlayerNames)
        ? parsedValue.selectedPlayerNames.filter((name): name is string => typeof name === "string").slice(0, 10)
        : undefined,
      currentJobId: typeof parsedValue.currentJobId === "string" ? parsedValue.currentJobId : null,
    };
  } catch {
    return {};
  }
}

function writePersistedCollectionState(state: Required<PersistedCollectionState>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DATA_COLLECTION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is a convenience; data collection should still work if storage is unavailable.
  }
}

function isTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function jobProgress(job: IngestJob) {
  if (job.total_count > 0) {
    return Math.min(
      100,
      Math.round(((job.success_count + job.skipped_count + job.failed_count) / job.total_count) * 100),
    );
  }
  return job.status === "completed" ? 100 : 0;
}

function matchSampleCount(match: IngestMatch) {
  return match.circle_phase_count + match.position_sample_count + match.life_event_count;
}

function mapDisplayName(mapName: string | null) {
  if (!mapName) return "未知地图";
  return PUBG_MAP_DISPLAY_NAMES[mapName] ?? mapName.replace(/_Main$/, "");
}

function jobTypeLabel(jobType: string) {
  if (jobType === "sample_matches") return "随机样本";
  if (jobType === "player_matches") return "指定玩家";
  if (jobType === "tournament_matches") return "赛事对局";
  if (jobType === "tournament_list") return "赛事列表";
  if (jobType === "telemetry_download") return "下载遥测";
  if (jobType === "telemetry_parse") return "解析遥测";
  return jobType;
}

function sortDirectionLabel(direction: SortDirection) {
  return direction === "asc" ? "升序" : "降序";
}

function statusLabel(status: string | null | undefined) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "running") return "进行中";
  if (status === "cancelled") return "已取消";
  if (status === "pending") return "待处理";
  return "未知";
}

function compactDate(value: string | null) {
  if (!value) return "未知时间";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function matchSortValue(match: IngestMatch, sortKey: MatchSortKey): string | number {
  if (sortKey === "sample_count") return matchSampleCount(match);
  if (sortKey === "created_at") return match.created_at ? Date.parse(match.created_at) : 0;
  if (sortKey === "map_name") return `${mapDisplayName(match.map_name)} ${match.map_name ?? ""} ${match.game_mode ?? ""}`.toLowerCase();
  if (sortKey === "telemetry_parse_status") return (match.telemetry_parse_status ?? "").toLowerCase();
  return match.match_id.toLowerCase();
}

export function DataCollection() {
  const navigate = useNavigate();
  const [initialCollectionState] = useState(readPersistedCollectionState);
  const [limit, setLimit] = useState(initialCollectionState.limit ?? 20);
  const [playerQuery, setPlayerQuery] = useState(initialCollectionState.playerQuery ?? "");
  const [selectedPlayerNames, setSelectedPlayerNames] = useState<string[]>(
    initialCollectionState.selectedPlayerNames ?? [],
  );
  const [playerCandidates, setPlayerCandidates] = useState<PlayerSearchResult[]>([]);
  const [isSearchingPlayer, setIsSearchingPlayer] = useState(false);
  const [playerSearchMessage, setPlayerSearchMessage] = useState<string | null>(null);
  const [savedJobId, setSavedJobId] = useState<string | null>(initialCollectionState.currentJobId ?? null);
  const [isRestoringJob, setIsRestoringJob] = useState(Boolean(initialCollectionState.currentJobId));
  const [currentJob, setCurrentJob] = useState<IngestJob | null>(null);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(() => new Set());
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [matchSearch, setMatchSearch] = useState("");
  const [matchMapFilter, setMatchMapFilter] = useState("all");
  const [matchStatusFilter, setMatchStatusFilter] = useState<MatchStatusFilter>("all");
  const [matchSortKey, setMatchSortKey] = useState<MatchSortKey>("created_at");
  const [matchSortDirection, setMatchSortDirection] = useState<SortDirection>("desc");
  const [selectedMatchIds, setSelectedMatchIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const trimmedPlayerQuery = playerQuery.trim();
  const canSearchPlayer = trimmedPlayerQuery.length > 0 && selectedPlayerNames.length < 10;

  const taskStatus: TaskStatus = (currentJob?.status as TaskStatus | undefined) ?? "idle";
  const progress = currentJob ? jobProgress(currentJob) : 0;
  const matchMapOptions = useMemo(
    () =>
      Array.from(new Set(matches.map((match) => match.map_name).filter((mapName): mapName is string => Boolean(mapName)))).sort(),
    [matches],
  );
  const filteredMatches = useMemo(() => {
    const query = matchSearch.trim().toLowerCase();
    return [...matches]
      .filter((match) => {
        const telemetryStatus = match.telemetry_parse_status ?? "pending";
        const searchableText = [
          match.match_id,
          mapDisplayName(match.map_name),
          match.map_name,
          match.game_mode,
          match.match_type,
          match.shard_id,
          telemetryStatus,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const matchesSearch = !query || searchableText.includes(query);
        const matchesMap = matchMapFilter === "all" || match.map_name === matchMapFilter;
        const matchesStatus =
          matchStatusFilter === "all" ||
          telemetryStatus === matchStatusFilter ||
          (matchStatusFilter === "pending" && telemetryStatus !== "completed" && telemetryStatus !== "failed");
        return matchesSearch && matchesMap && matchesStatus;
      })
      .sort((left, right) => {
        const leftValue = matchSortValue(left, matchSortKey);
        const rightValue = matchSortValue(right, matchSortKey);
        const result =
          typeof leftValue === "number" && typeof rightValue === "number"
            ? leftValue - rightValue
            : String(leftValue).localeCompare(String(rightValue), "zh-CN");
        return matchSortDirection === "asc" ? result : -result;
      });
  }, [matches, matchSearch, matchMapFilter, matchStatusFilter, matchSortKey, matchSortDirection]);
  const visibleMatchIds = useMemo(() => filteredMatches.map((match) => match.match_id), [filteredMatches]);
  const selectedVisibleCount = visibleMatchIds.filter((matchId) => selectedMatchIds.has(matchId)).length;
  const allVisibleSelected = visibleMatchIds.length > 0 && selectedVisibleCount === visibleMatchIds.length;
  const allMatchesSelected =
    matches.length > 0 && matches.every((match) => selectedMatchIds.has(match.match_id));
  const selectedMatchCount = selectedMatchIds.size;
  const visibleJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const selectedVisibleJobCount = visibleJobIds.filter((jobId) => selectedJobIds.has(jobId)).length;
  const allVisibleJobsSelected = visibleJobIds.length > 0 && selectedVisibleJobCount === visibleJobIds.length;
  const selectedJobs = useMemo(
    () => jobs.filter((job) => selectedJobIds.has(job.id)),
    [jobs, selectedJobIds],
  );
  const selectedJobCount = selectedJobIds.size;
  const selectedFailedJobIds = selectedJobs
    .filter((job) => job.status === "failed")
    .map((job) => job.id);
  const selectedRunningJobIds = selectedJobs
    .filter((job) => job.status === "running")
    .map((job) => job.id);
  const selectedTerminalJobIds = selectedJobs
    .filter((job) => isTerminal(job.status))
    .map((job) => job.id);

  const refreshMatches = async () => {
    setLoadingMatches(true);
    try {
      const response = await api.listMatches(200);
      setMatches(response.matches);
      setSelectedMatchIds((current) => {
        const knownIds = new Set(response.matches.map((match) => match.match_id));
        return new Set(Array.from(current).filter((matchId) => knownIds.has(matchId)));
      });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingMatches(false);
    }
  };

  const refreshJobs = async () => {
    setLoadingJobs(true);
    try {
      const response = await api.listIngestJobs(20);
      setJobs(response.jobs);
      setSelectedJobIds((current) => {
        const knownIds = new Set(response.jobs.map((job) => job.id));
        return new Set(Array.from(current).filter((jobId) => knownIds.has(jobId)));
      });
      if (currentJob) {
        const updatedCurrentJob = response.jobs.find((job) => job.id === currentJob.id);
        if (updatedCurrentJob) setCurrentJob(updatedCurrentJob);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    void refreshMatches();
    void refreshJobs();
  }, []);

  useEffect(() => {
    writePersistedCollectionState({
      limit,
      playerQuery,
      selectedPlayerNames,
      currentJobId: currentJob?.id ?? savedJobId,
    });
  }, [limit, playerQuery, selectedPlayerNames, currentJob?.id, savedJobId]);

  useEffect(() => {
    if (!initialCollectionState.currentJobId) return;
    let cancelled = false;
    const restoreJob = async () => {
      setIsRestoringJob(true);
      try {
        const job = await api.getIngestJob(initialCollectionState.currentJobId as string);
        if (cancelled) return;
        setCurrentJob(job);
        setSavedJobId(job.id);
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        if (isTerminal(job.status)) {
          void refreshMatches();
          void refreshJobs();
        }
      } catch (err) {
        if (cancelled) return;
        setSavedJobId(null);
        setError(`无法恢复上次采集任务：${apiErrorMessage(err)}`);
      } finally {
        if (!cancelled) setIsRestoringJob(false);
      }
    };
    void restoreJob();
    return () => {
      cancelled = true;
    };
  }, [initialCollectionState.currentJobId]);

  useEffect(() => {
    if (!currentJob || isTerminal(currentJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await api.getIngestJob(currentJob.id);
        setCurrentJob(job);
        setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
        if (isTerminal(job.status)) {
          void refreshMatches();
          void refreshJobs();
        }
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [currentJob?.id, currentJob?.status]);

  useEffect(() => {
    if (!jobs.some((job) => !isTerminal(job.status))) return;
    const timer = window.setInterval(() => {
      void refreshJobs();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [jobs]);

  const handleSearchPlayers = async () => {
    if (!canSearchPlayer) return;
    setError(null);
    setPlayerSearchMessage(null);
    setIsSearchingPlayer(true);
    try {
      const response = await api.searchPlayers({ platform: "steam", query: trimmedPlayerQuery });
      setPlayerCandidates(response.players);
      if (response.players.length === 0) {
        setPlayerSearchMessage("没有匹配到玩家，请检查名称是否完整。");
      }
    } catch (err) {
      setPlayerCandidates([]);
      setPlayerSearchMessage(apiErrorMessage(err));
    } finally {
      setIsSearchingPlayer(false);
    }
  };

  const handleSelectPlayer = (player: PlayerSearchResult) => {
    if (selectedPlayerNames.some((name) => name.toLowerCase() === player.player_name.toLowerCase())) return;
    if (selectedPlayerNames.length >= 10) return;
    setSelectedPlayerNames((current) => [...current, player.player_name]);
    setPlayerCandidates((current) => current.filter((item) => item.player_id !== player.player_id));
    setPlayerQuery("");
    setPlayerSearchMessage(null);
  };

  const handleRemovePlayer = (name: string) => {
    setSelectedPlayerNames((current) => current.filter((item) => item !== name));
  };

  const handleStart = async () => {
    setError(null);
    if (selectedPlayerNames.length === 0) {
      setError("请至少输入一个玩家名。");
      return;
    }
    try {
      const job = await api.startPlayerIngest({
        platform: "steam",
        playerNames: selectedPlayerNames,
        gameMode: "squad",
        maxMatchesPerPlayer: limit,
        parseProfile: REPLAY_PARSE_PROFILE,
        positionIntervalSeconds: REPLAY_POSITION_INTERVAL_SECONDS,
      });
      setCurrentJob(job);
      setSavedJobId(job.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleStopJob = async (jobId: string) => {
    setError(null);
    try {
      const job = await api.cancelIngestJob(jobId);
      setCurrentJob(job);
      setSavedJobId(job.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleStop = async () => {
    if (!currentJob) return;
    await handleStopJob(currentJob.id);
  };

  const handleRetryJob = async (jobId: string) => {
    setError(null);
    try {
      const job = await api.retryIngestJob(jobId);
      setCurrentJob(job);
      setSavedJobId(job.id);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleRetry = async () => {
    if (!currentJob) return;
    await handleRetryJob(currentJob.id);
  };

  const handleSelectJob = (job: IngestJob) => {
    setCurrentJob(job);
    setSavedJobId(job.id);
  };

  const handleDeleteJob = async (jobId: string) => {
    setError(null);
    try {
      await api.deleteIngestJob(jobId);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      setJobs((current) => current.filter((job) => job.id !== jobId));
      if (currentJob?.id === jobId) {
        setCurrentJob(null);
        setSavedJobId(null);
      }
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleRetrySelectedJobs = async () => {
    if (selectedFailedJobIds.length === 0) return;
    setError(null);
    try {
      const response = await api.retryIngestJobs(selectedFailedJobIds);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        selectedFailedJobIds.forEach((jobId) => next.delete(jobId));
        return next;
      });
      setJobs((current) => [
        ...response.jobs,
        ...current.filter((item) => !response.jobs.some((job) => job.id === item.id)),
      ]);
      const latestJob = response.jobs[0];
      if (latestJob) {
        setCurrentJob(latestJob);
        setSavedJobId(latestJob.id);
      }
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleStopSelectedJobs = async () => {
    if (selectedRunningJobIds.length === 0) return;
    setError(null);
    try {
      const response = await api.cancelIngestJobs(selectedRunningJobIds);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        selectedRunningJobIds.forEach((jobId) => next.delete(jobId));
        return next;
      });
      setJobs((current) => [
        ...response.jobs,
        ...current.filter((item) => !response.jobs.some((job) => job.id === item.id)),
      ]);
      if (currentJob && selectedRunningJobIds.includes(currentJob.id)) {
        const updatedJob = response.jobs.find((job) => job.id === currentJob.id);
        if (updatedJob) setCurrentJob(updatedJob);
      }
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteSelectedJobs = async () => {
    if (selectedTerminalJobIds.length === 0) return;
    setError(null);
    try {
      await api.deleteIngestJobs(selectedTerminalJobIds);
      setSelectedJobIds((current) => {
        const next = new Set(current);
        selectedTerminalJobIds.forEach((jobId) => next.delete(jobId));
        return next;
      });
      setJobs((current) => current.filter((job) => !selectedTerminalJobIds.includes(job.id)));
      if (currentJob && selectedTerminalJobIds.includes(currentJob.id)) {
        setCurrentJob(null);
        setSavedJobId(null);
      }
      void refreshJobs();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleToggleJob = (jobId: string, checked: boolean) => {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (checked) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  };

  const handleToggleVisibleJobs = (checked: boolean) => {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      visibleJobIds.forEach((jobId) => {
        if (checked) next.add(jobId);
        else next.delete(jobId);
      });
      return next;
    });
  };

  const handleDeleteMatch = async (matchId: string) => {
    setError(null);
    try {
      await api.deleteMatch(matchId);
      setSelectedMatchIds((current) => {
        const next = new Set(current);
        next.delete(matchId);
        return next;
      });
      await refreshMatches();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteSelectedMatches = async () => {
    const matchIds = Array.from(selectedMatchIds);
    if (matchIds.length === 0) return;
    setError(null);
    try {
      await api.deleteMatches(matchIds);
      setSelectedMatchIds(new Set());
      await refreshMatches();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteAllMatches = async () => {
    const matchIds = matches.map((match) => match.match_id);
    if (matchIds.length === 0) return;
    setError(null);
    try {
      await api.deleteMatches(matchIds);
      setSelectedMatchIds(new Set());
      await refreshMatches();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleToggleAllMatches = () => {
    setSelectedMatchIds(
      allMatchesSelected
        ? new Set()
        : new Set(matches.map((match) => match.match_id)),
    );
  };

  const handleToggleMatch = (matchId: string, checked: boolean) => {
    setSelectedMatchIds((current) => {
      const next = new Set(current);
      if (checked) next.add(matchId);
      else next.delete(matchId);
      return next;
    });
  };

  const handleToggleVisibleMatches = (checked: boolean) => {
    setSelectedMatchIds((current) => {
      const next = new Set(current);
      visibleMatchIds.forEach((matchId) => {
        if (checked) next.add(matchId);
        else next.delete(matchId);
      });
      return next;
    });
  };

  const handleSortMatches = (sortKey: MatchSortKey) => {
    if (matchSortKey === sortKey) {
      setMatchSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setMatchSortKey(sortKey);
    setMatchSortDirection(sortKey === "created_at" || sortKey === "sample_count" ? "desc" : "asc");
  };

  const sortIcon = (sortKey: MatchSortKey) => {
    if (matchSortKey !== sortKey) return <ArrowUpDown className="size-3.5" />;
    return matchSortDirection === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />;
  };

  return (
    <div className="dark flex h-full w-full flex-col gap-6 overflow-y-auto bg-background p-6 text-foreground lg:flex-row">
      <div className="flex w-full shrink-0 flex-col gap-6 lg:w-96">
        <Card className="border-border bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="size-5 text-blue-400" /> 发起采集任务
            </CardTitle>
          </CardHeader>

          <CardContent className="flex flex-col gap-5">
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs leading-5 text-blue-100">
              统一采集完整回放数据：玩家轨迹、载具状态、伤害/击倒/淘汰事件、航线与安全区。
            </div>

            <div className="flex flex-col gap-2">
                <Label htmlFor="player-search">搜索添加玩家</Label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="player-search"
                      value={playerQuery}
                      onChange={(event) => setPlayerQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSearchPlayers();
                        }
                      }}
                      placeholder="输入玩家名"
                      className="pl-9"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSearchPlayers()}
                    disabled={!canSearchPlayer || isSearchingPlayer}
                    className="shrink-0"
                  >
                    {isSearchingPlayer ? <Loader2 className="size-4 animate-spin" /> : "搜索"}
                  </Button>
                </div>
                {playerCandidates.length > 0 && (
                  <div className="rounded border border-border bg-muted/20 p-2">
                    <div className="mb-2 text-xs text-muted-foreground">匹配结果</div>
                    <div className="flex flex-col gap-2">
                      {playerCandidates.map((player) => (
                        <button
                          key={player.player_id}
                          type="button"
                          onClick={() => handleSelectPlayer(player)}
                          className="flex items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2 text-left text-sm hover:border-blue-500 hover:bg-blue-500/10"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{player.player_name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {player.platform} · 近期 {player.recent_match_count} 场
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-blue-400">选择</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex min-h-9 flex-wrap gap-2">
                  {selectedPlayerNames.map((name) => (
                    <Badge key={name} variant="secondary" className="gap-1 rounded px-2 py-1">
                      <span className="max-w-40 truncate">{name}</span>
                      <button
                        type="button"
                        onClick={() => handleRemovePlayer(name)}
                        className="rounded text-muted-foreground hover:text-foreground"
                        aria-label={`移除 ${name}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
                {playerSearchMessage && <div className="text-xs text-yellow-500">{playerSearchMessage}</div>}
                <div className="text-xs text-muted-foreground">已选择 {selectedPlayerNames.length} / 10，平台 steam，模式 squad。</div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="sample-limit">每个玩家最多采集（场次）</Label>
              <Input
                id="sample-limit"
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              />
              <div className="text-xs text-muted-foreground">
                固定使用完整回放规格，每 5 秒保留位置采样；重复对局会自动跳过。
              </div>
            </div>

            <Button
              disabled={isRestoringJob || taskStatus === "running" || selectedPlayerNames.length === 0}
              onClick={handleStart}
              className="h-11 w-full"
            >
              <Play className="fill-current" data-icon="inline-start" /> 开始采集
            </Button>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-lg">当前任务</CardTitle>
            <div className="flex items-center gap-2">
              {taskStatus === "failed" && (
                <Button onClick={handleRetry} variant="outline" size="sm">
                  <RotateCcw data-icon="inline-start" /> 重试
                </Button>
              )}
              {taskStatus === "running" && (
                <Button onClick={handleStop} variant="destructive" size="sm">
                  <Square className="fill-current" data-icon="inline-start" /> 终止
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent>
            {isRestoringJob && !currentJob ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在恢复上次采集任务...
              </div>
            ) : !currentJob ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                暂无活动中的采集任务。
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 text-muted-foreground">
                    任务ID: <span className="font-mono">{currentJob.id}</span>
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {statusLabel(currentJob.status)} · {progress}%
                  </Badge>
                </div>
                <Progress value={progress} />
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-green-500" /> {currentJob.success_count} / {currentJob.total_count || limit} 场次
                  </div>
                  <div className="flex items-center gap-1.5">
                    <AlertCircle className="size-4 text-yellow-500" /> {currentJob.skipped_count} 跳过 · {currentJob.failed_count} 失败
                  </div>
                </div>
                {currentJob.status === "failed" && currentJob.error_message && (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertDescription>
                      {currentJob.error_message}
                      {currentJob.error_code ? ` (${currentJob.error_code})` : ""}
                    </AlertDescription>
                  </Alert>
                )}
                {currentJob.warnings.length > 0 && (
                  <Alert>
                    <AlertCircle />
                    <AlertDescription>{currentJob.warnings.slice(0, 3).join("；")}</AlertDescription>
                  </Alert>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card shadow-sm">
          <CardHeader className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock3 className="size-5 text-blue-400" /> 历史采集任务
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void handleRetrySelectedJobs()}
                  variant="outline"
                  size="sm"
                  disabled={selectedFailedJobIds.length === 0}
                >
                  <RotateCcw data-icon="inline-start" /> 重试失败 {selectedFailedJobIds.length || ""}
                </Button>
                <Button
                  onClick={() => void handleStopSelectedJobs()}
                  variant="outline"
                  size="sm"
                  disabled={selectedRunningJobIds.length === 0}
                >
                  <Square className="fill-current" data-icon="inline-start" /> 终止运行中{" "}
                  {selectedRunningJobIds.length || ""}
                </Button>
                <Button
                  onClick={() => void handleDeleteSelectedJobs()}
                  variant="destructive"
                  size="sm"
                  disabled={selectedTerminalJobIds.length === 0}
                >
                  <Trash2 data-icon="inline-start" /> 清理选中 {selectedTerminalJobIds.length || ""}
                </Button>
                <Button onClick={() => void refreshJobs()} variant="ghost" size="icon" title="刷新任务">
                  <RotateCcw className={cn(loadingJobs && "animate-spin")} />
                </Button>
              </div>
            </div>
            {jobs.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={allVisibleJobsSelected ? true : selectedVisibleJobCount > 0 ? "indeterminate" : false}
                  onCheckedChange={(checked) => handleToggleVisibleJobs(checked === true)}
                  aria-label="选择全部历史任务"
                />
                <span>已选择 {selectedJobCount} 个任务</span>
              </div>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
                暂无历史采集任务。
              </div>
            ) : (
              jobs.map((job) => {
                const itemProgress = jobProgress(job);
                return (
                  <div
                    key={job.id}
                    className={cn(
                      "flex flex-col gap-3 rounded border border-border bg-muted/10 p-3",
                      currentJob?.id === job.id && "border-blue-500 bg-blue-500/10",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selectedJobIds.has(job.id)}
                        onCheckedChange={(checked) => handleToggleJob(job.id, checked === true)}
                        aria-label={`选择任务 ${job.id}`}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{jobTypeLabel(job.job_type)}</span>
                              <Badge variant="secondary" className="shrink-0">
                                {statusLabel(job.status)} · {itemProgress}%
                              </Badge>
                            </div>
                            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{job.id}</div>
                            <div className="mt-1 truncate text-xs text-muted-foreground">
                              {job.source_ref ?? "无来源信息"} · {compactDate(job.started_at)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button onClick={() => handleSelectJob(job)} variant="outline" size="sm">
                              查看
                            </Button>
                            {job.status === "failed" && (
                              <Button onClick={() => void handleRetryJob(job.id)} variant="outline" size="sm">
                                <RotateCcw data-icon="inline-start" /> 重试
                              </Button>
                            )}
                            {job.status === "running" ? (
                              <Button onClick={() => void handleStopJob(job.id)} variant="destructive" size="sm">
                                <Square className="fill-current" data-icon="inline-start" /> 终止
                              </Button>
                            ) : (
                              <Button
                                onClick={() => void handleDeleteJob(job.id)}
                                variant="ghost"
                                size="icon"
                                title="清理任务"
                              >
                                <Trash2 />
                              </Button>
                            )}
                          </div>
                        </div>
                        <Progress value={itemProgress} className="mt-3" />
                        <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <span>{job.success_count} 成功 / {job.total_count || "?"} 总数</span>
                          <span>{job.skipped_count} 跳过</span>
                          <span>{job.failed_count} 失败</span>
                          <span>重试 {job.retry_count}</span>
                          {job.finished_at && <span>结束 {compactDate(job.finished_at)}</span>}
                        </div>
                        {job.status === "failed" && job.error_message && (
                          <div className="mt-2 text-xs text-destructive">{job.error_message}</div>
                        )}
                        {job.warnings.length > 0 && (
                          <div className="mt-2 text-xs text-yellow-500">{job.warnings.slice(0, 2).join("；")}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="flex min-h-[300px] flex-1 flex-col border-border bg-card shadow-sm">
          <CardHeader className="flex flex-col gap-4 border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-lg">已采集对局列表</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={handleToggleAllMatches}
                  variant="outline"
                  size="sm"
                  disabled={matches.length === 0}
                >
                  <ListChecks data-icon="inline-start" />
                  {allMatchesSelected ? "取消全选" : `全部选中 ${matches.length}`}
                </Button>
                <Button
                  onClick={() => void handleDeleteSelectedMatches()}
                  variant="destructive"
                  size="sm"
                  disabled={selectedMatchCount === 0}
                >
                  <Trash2 data-icon="inline-start" /> 删除选中 {selectedMatchCount || ""}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={matches.length === 0}
                    >
                      <Trash2 data-icon="inline-start" />
                      清空全部
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>确认清空全部已采集对局？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将删除当前加载的 {matches.length} 场对局及其位置、事件和本地 telemetry
                        缓存。此操作无法撤销。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction asChild>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => void handleDeleteAllMatches()}
                        >
                          确认清空
                        </Button>
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button onClick={() => void refreshMatches()} variant="ghost" size="icon" title="刷新">
                  {loadingMatches ? <RotateCcw className="animate-spin" /> : <Filter />}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_180px_160px]">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={matchSearch}
                  onChange={(event) => setMatchSearch(event.target.value)}
                  placeholder="搜索对局、地图、模式"
                  className="pl-9"
                />
              </div>
              <Select value={matchMapFilter} onValueChange={setMatchMapFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="地图筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部地图</SelectItem>
                  {matchMapOptions.map((mapName) => (
                    <SelectItem key={mapName} value={mapName}>
                      {mapDisplayName(mapName)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={matchStatusFilter}
                onValueChange={(value) => setMatchStatusFilter(value as MatchStatusFilter)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="状态筛选" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="completed">已完成</SelectItem>
                  <SelectItem value="pending">处理中</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 px-5">
                    <Checkbox
                      checked={allVisibleSelected ? true : selectedVisibleCount > 0 ? "indeterminate" : false}
                      onCheckedChange={(checked) => handleToggleVisibleMatches(checked === true)}
                      aria-label="选择当前筛选结果"
                    />
                  </TableHead>
                  <TableHead className="px-5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSortMatches("match_id")}
                      className="-ml-3 h-8 gap-1 px-2"
                      title={`按对局ID${sortDirectionLabel(matchSortDirection)}`}
                    >
                      对局ID {sortIcon("match_id")}
                    </Button>
                  </TableHead>
                  <TableHead className="px-5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSortMatches("map_name")}
                      className="-ml-3 h-8 gap-1 px-2"
                      title={`按地图/模式${sortDirectionLabel(matchSortDirection)}`}
                    >
                      地图 / 模式 {sortIcon("map_name")}
                    </Button>
                  </TableHead>
                  <TableHead className="px-5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSortMatches("created_at")}
                      className="-ml-3 h-8 gap-1 px-2"
                      title={`按时间${sortDirectionLabel(matchSortDirection)}`}
                    >
                      时间 {sortIcon("created_at")}
                    </Button>
                  </TableHead>
                  <TableHead className="px-5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSortMatches("telemetry_parse_status")}
                      className="-ml-3 h-8 gap-1 px-2"
                      title={`按遥测状态${sortDirectionLabel(matchSortDirection)}`}
                    >
                      遥测数据 {sortIcon("telemetry_parse_status")}
                    </Button>
                  </TableHead>
                  <TableHead className="px-5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSortMatches("sample_count")}
                      className="-ml-3 h-8 gap-1 px-2"
                      title={`按样本数${sortDirectionLabel(matchSortDirection)}`}
                    >
                      样本数 {sortIcon("sample_count")}
                    </Button>
                  </TableHead>
                  <TableHead className="px-5 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMatches.map((match) => (
                  <TableRow key={match.match_id}>
                    <TableCell className="px-5">
                      <Checkbox
                        checked={selectedMatchIds.has(match.match_id)}
                        onCheckedChange={(checked) => handleToggleMatch(match.match_id, checked === true)}
                        aria-label={`选择 ${match.match_id}`}
                      />
                    </TableCell>
                    <TableCell className="px-5 font-mono text-muted-foreground">{match.match_id}</TableCell>
                    <TableCell className="px-5">
                      <div className="font-medium">{mapDisplayName(match.map_name)}</div>
                      <div className="text-xs text-muted-foreground">
                        {match.map_name && mapDisplayName(match.map_name) !== match.map_name
                          ? `${match.map_name} · `
                          : ""}
                        {match.game_mode ?? "未知模式"}
                      </div>
                    </TableCell>
                    <TableCell className="px-5 text-sm text-muted-foreground">{compactDate(match.created_at)}</TableCell>
                    <TableCell className="px-5">
                      <Badge
                        variant={match.telemetry_parse_status === "failed" ? "destructive" : "secondary"}
                        className={cn(
                          match.telemetry_parse_status === "completed" && "bg-green-500/10 text-green-400",
                          match.telemetry_parse_status !== "completed" &&
                            match.telemetry_parse_status !== "failed" &&
                            "bg-yellow-500/10 text-yellow-500",
                        )}
                      >
                        {statusLabel(match.telemetry_parse_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-5">{matchSampleCount(match).toLocaleString()}</TableCell>
                    <TableCell className="px-5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/analysis?matches=${encodeURIComponent(match.match_id)}`)
                          }
                        >
                          <Play data-icon="inline-start" />
                          回放
                        </Button>
                        <Button
                          onClick={() => handleDeleteMatch(match.match_id)}
                          variant="ghost"
                          size="icon"
                          title="删除"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredMatches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="px-5 py-10 text-center text-muted-foreground">
                      {matches.length === 0 ? "还没有已入库对局。" : "没有匹配当前筛选条件的对局。"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
