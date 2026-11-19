import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Item } from "@astryxdesign/core/Item";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { mapDisplayName } from "../matchDisplay";
import { cn } from "../../lib/utils";
import { usePlayerWorkspace } from "../playerWorkspace";
import { useNavigate, useSearchParams } from "react-router";
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

type TaskStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
type MatchSortKey = "match_id" | "map_name" | "created_at" | "telemetry_parse_status" | "sample_count";
type SortDirection = "asc" | "desc";
type MatchStatusFilter = "all" | "completed" | "failed" | "pending";

const DATA_COLLECTION_STORAGE_KEY = "pubg-zone-predictor:data-collection";
const REPLAY_PARSE_PROFILE = "full";
const REPLAY_POSITION_INTERVAL_SECONDS = 5;


type PersistedCollectionState = {
  limit?: number;
  playerQuery?: string;
  selectedPlayerNames?: string[];
  ownerId?: string;
  currentJobId?: string | null;
  matchSearch?: string;
  matchMapFilter?: string;
  matchStatusFilter?: MatchStatusFilter;
  matchSortKey?: MatchSortKey;
  matchSortDirection?: SortDirection;
};

function isMatchStatusFilter(value: unknown): value is MatchStatusFilter {
  return value === "all" || value === "completed" || value === "failed" || value === "pending";
}

function isMatchSortKey(value: unknown): value is MatchSortKey {
  return (
    value === "match_id" ||
    value === "map_name" ||
    value === "created_at" ||
    value === "telemetry_parse_status" ||
    value === "sample_count"
  );
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

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
      ownerId: typeof parsedValue.ownerId === "string" ? parsedValue.ownerId : undefined,
      limit: clampLimit(parsedValue.limit),
      playerQuery: typeof parsedValue.playerQuery === "string" ? parsedValue.playerQuery : undefined,
      selectedPlayerNames: Array.isArray(parsedValue.selectedPlayerNames)
        ? parsedValue.selectedPlayerNames.filter((name): name is string => typeof name === "string").slice(0, 10)
        : undefined,
      currentJobId: typeof parsedValue.currentJobId === "string" ? parsedValue.currentJobId : null,
      matchSearch: typeof parsedValue.matchSearch === "string" ? parsedValue.matchSearch : undefined,
      matchMapFilter: typeof parsedValue.matchMapFilter === "string" ? parsedValue.matchMapFilter : undefined,
      matchStatusFilter: isMatchStatusFilter(parsedValue.matchStatusFilter)
        ? parsedValue.matchStatusFilter
        : undefined,
      matchSortKey: isMatchSortKey(parsedValue.matchSortKey) ? parsedValue.matchSortKey : undefined,
      matchSortDirection: isSortDirection(parsedValue.matchSortDirection)
        ? parsedValue.matchSortDirection
        : undefined,
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

const ArchivedReplay = lazy(async () => ({
  default: (await import("./PlayerMatchAnalysis")).PlayerMatchAnalysis,
}));

export function DataCollection() {
  const [params, setParams] = useSearchParams();
  const archiveId = params.get("replay");
  if (archiveId) return <>
    <div className="flex items-center gap-3 p-2 text-sm">
      <Button label="返回数据采集" onClick={() => setParams({})} size="sm" />
      采集记录回放
    </div>
    <Suspense fallback={<p role="status">正在打开回放…</p>}>
      <ArchivedReplay key={archiveId} archiveId={archiveId} />
    </Suspense>
  </>;
  return <CollectionForm />;
}

function CollectionForm() {
  const { player } = usePlayerWorkspace();
  const navigate = useNavigate();
  const [confirmClear, setConfirmClear] = useState(false);
  const [initialCollectionState] = useState(readPersistedCollectionState);
  const [limit, setLimit] = useState(initialCollectionState.limit ?? 20);
  const [playerQuery, setPlayerQuery] = useState(initialCollectionState.playerQuery ?? "");
  const [selectedPlayerNames, setSelectedPlayerNames] = useState<string[]>(
    initialCollectionState.ownerId && initialCollectionState.ownerId !== player.player_id
      ? [player.player_name] : initialCollectionState.selectedPlayerNames ?? [player.player_name],
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
  const [matchSearch, setMatchSearch] = useState(initialCollectionState.matchSearch ?? "");
  const [matchMapFilter, setMatchMapFilter] = useState(initialCollectionState.matchMapFilter ?? "all");
  const [matchStatusFilter, setMatchStatusFilter] = useState<MatchStatusFilter>(
    initialCollectionState.matchStatusFilter ?? "all",
  );
  const [matchSortKey, setMatchSortKey] = useState<MatchSortKey>(
    initialCollectionState.matchSortKey ?? "created_at",
  );
  const [matchSortDirection, setMatchSortDirection] = useState<SortDirection>(
    initialCollectionState.matchSortDirection ?? "desc",
  );
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
      setMatchMapFilter((current) => {
        if (current === "all" || response.matches.some((match) => match.map_name === current)) return current;
        return "all";
      });
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
      ownerId: player.player_id,
      limit,
      playerQuery,
      selectedPlayerNames,
      currentJobId: currentJob?.id ?? savedJobId,
      matchSearch,
      matchMapFilter,
      matchStatusFilter,
      matchSortKey,
      matchSortDirection,
    });
  }, [
    limit,
    playerQuery,
    selectedPlayerNames,
    currentJob?.id,
    savedJobId,
    matchSearch,
    matchMapFilter,
    matchStatusFilter,
    matchSortKey,
    matchSortDirection,
  ]);

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
        gameMode: "all",
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
    setConfirmClear(false);
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
    <div className="flex h-full w-full flex-col gap-6 overflow-y-auto bg-body p-6 text-primary lg:flex-row">
      <div className="flex w-full shrink-0 flex-col gap-6 lg:w-96">
        <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
          <header className="grid gap-1.5 px-5 pt-5">
            <h3 className="font-semibold flex items-center gap-2 text-lg">
              <Database className="size-5 text-blue-400" /> 发起采集任务
            </h3>
          </header>

          <div className="px-5 pb-5 flex flex-col gap-5">
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs leading-5 text-blue-100">
              统一采集完整回放数据：玩家轨迹、载具状态、伤害/击倒/淘汰事件、航线与安全区。
            </div>

            <div className="flex flex-col gap-2">

                <div className="flex items-end gap-2">
                  <div className="relative min-w-0 flex-1">

                    <TextInput
                      label="搜索添加玩家"
                      startIcon={Search}
                      id="player-search"
                      value={playerQuery}
                      onChange={setPlayerQuery}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSearchPlayers();
                        }
                      }}
                      placeholder="输入玩家名"
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={() => void handleSearchPlayers()}
                    className="shrink-0"
                    label="搜索"
                    variant="secondary"
                    isDisabled={!canSearchPlayer || isSearchingPlayer}
                    isLoading={isSearchingPlayer}
                  />
                </div>
                {playerCandidates.length > 0 && (
                  <div className="rounded border border-border bg-muted/20 p-2">
                    <div className="mb-2 text-xs text-secondary">匹配结果</div>
                    <div className="flex flex-col gap-2">
                      {playerCandidates.map((player) => (
                        <Item
                          key={player.player_id}
                          density="compact"
                          label={player.player_name}
                          description={`${player.platform} · 近期 ${player.recent_match_count} 场`}
                          endContent="选择"
                          onClick={() => handleSelectPlayer(player)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex min-h-9 flex-wrap gap-2">
                  {selectedPlayerNames.map((name) => (
                    <Badge
                      key={name}
                      variant="neutral"
                      className="gap-1 rounded px-2 py-1"
                      label={
                        <>
                          <span className="max-w-40 truncate">{name}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            isIconOnly
                            icon={<X />}
                            label={`移除 ${name}`}
                            onClick={() => handleRemovePlayer(name)}
                          />
                        </>
                      }
                    />
                  ))}
                </div>
                {playerSearchMessage && <div className="text-xs text-yellow-500">{playerSearchMessage}</div>}
                <div className="text-xs text-secondary">已选择 {selectedPlayerNames.length} / 10，Steam，各玩家按最近对局采集，包含排位。</div>
            </div>

            <div className="flex flex-col gap-2">

              <NumberInput
                label="每个玩家最多采集（场次）"
                isIntegerOnly
                id="sample-limit"
                min={1}
                max={100}
                value={limit}
                onChange={(count) => setLimit(Math.max(1, Math.min(100, count)))}
              />
              <div className="text-xs text-secondary">
                固定使用完整回放规格，每 5 秒保留位置采样；重复对局会自动跳过。
              </div>
            </div>

            <Button
              onClick={handleStart}
              className="h-11 w-full"
              label="开始采集"
              variant="primary"
              isDisabled={isRestoringJob || taskStatus === "running" || selectedPlayerNames.length === 0}
              icon={<Play className="fill-current" data-icon="inline-start" />}
            />

            {error && (
              <Banner status="error" role="alert" title={error} />
            )}
          </div>
        </Card>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
          <header className="px-5 pt-5 flex flex-row items-center justify-between gap-3">
            <h3 className="font-semibold text-lg">当前任务</h3>
            <div className="flex items-center gap-2">
              {taskStatus === "failed" && (
                <Button
                  onClick={handleRetry}
                  label="重试"
                  variant="secondary"
                  size="sm"
                  icon={<RotateCcw data-icon="inline-start" />}
                />
              )}
              {taskStatus === "running" && (
                <Button
                  onClick={handleStop}
                  label="终止"
                  variant="destructive"
                  size="sm"
                  icon={<Square className="fill-current" data-icon="inline-start" />}
                />
              )}
            </div>
          </header>

          <div className="px-5 pb-5">
            {isRestoringJob && !currentJob ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-secondary">
                <Loader2 className="size-4 animate-spin" />
                正在恢复上次采集任务...
              </div>
            ) : !currentJob ? (
              <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-secondary">
                暂无活动中的采集任务。
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 text-secondary">
                    任务ID: <span className="font-mono">{currentJob.id}</span>
                  </span>
                  <Badge
                    variant="neutral"
                    className="shrink-0"
                    label={
                      <>
                        {statusLabel(currentJob.status)} · {progress}%
                      </>
                    }
                  />
                </div>
                <ProgressBar value={progress} label="进度" isLabelHidden hasValueLabel={false} />
                <div className="flex flex-wrap gap-4 text-xs text-secondary">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="size-4 text-green-500" /> {currentJob.success_count} / {currentJob.total_count || limit} 场次
                  </div>
                  <div className="flex items-center gap-1.5">
                    <AlertCircle className="size-4 text-yellow-500" /> {currentJob.skipped_count} 跳过 · {currentJob.failed_count} 失败
                  </div>
                </div>
                {currentJob.status === "failed" && currentJob.error_message && (
                  <Banner
                    status="error"
                    role="alert"
                    title={
                      <>
                        {currentJob.error_message}
                        {currentJob.error_code ? ` (${currentJob.error_code})` : ""}
                      </>
                    }
                  />
                )}
                {currentJob.warnings.length > 0 && (
                  <Banner status="info" title={currentJob.warnings.slice(0, 3).join("；")} />
                )}
              </div>
            )}
          </div>
        </Card>

        <Card padding={0} className="flex flex-col gap-4 border-border bg-card shadow-sm">
          <header className="px-5 pt-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold flex items-center gap-2 text-lg">
                <Clock3 className="size-5 text-blue-400" /> 历史采集任务
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void handleRetrySelectedJobs()}
                  label={`重试失败 ${selectedFailedJobIds.length || ""}`}
                  variant="secondary"
                  size="sm"
                  isDisabled={selectedFailedJobIds.length === 0}
                  icon={<RotateCcw data-icon="inline-start" />}
                />
                <Button
                  onClick={() => void handleStopSelectedJobs()}
                  label={`终止运行中  ${selectedRunningJobIds.length || ""}`}
                  variant="secondary"
                  size="sm"
                  isDisabled={selectedRunningJobIds.length === 0}
                  icon={<Square className="fill-current" data-icon="inline-start" />}
                />
                <Button
                  onClick={() => void handleDeleteSelectedJobs()}
                  label={`清理选中 ${selectedTerminalJobIds.length || ""}`}
                  variant="destructive"
                  size="sm"
                  isDisabled={selectedTerminalJobIds.length === 0}
                  icon={<Trash2 data-icon="inline-start" />}
                />
                <Button
                  onClick={() => void refreshJobs()}
                  label="刷新任务"
                  variant="ghost"
                  size="sm"
                  tooltip="刷新任务"
                  icon={<RotateCcw className={cn(loadingJobs && "animate-spin")} />}
                  isIconOnly
                />
              </div>
            </div>
            {jobs.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-secondary">
                <CheckboxInput
                  label="选择全部历史任务"
                  isLabelHidden
                  value={
                    allVisibleJobsSelected ? true : selectedVisibleJobCount > 0 ? "indeterminate" : false
                  }
                  onChange={(checked) => handleToggleVisibleJobs(checked === true)}
                />
                <span>已选择 {selectedJobCount} 个任务</span>
              </div>
            )}
          </header>
          <div className="px-5 pb-5 flex flex-col gap-3">
            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-secondary">
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
                      <CheckboxInput
                        label={`选择任务 ${job.id}`}
                        isLabelHidden
                        value={selectedJobIds.has(job.id)}
                        onChange={(checked) => handleToggleJob(job.id, checked === true)}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{jobTypeLabel(job.job_type)}</span>
                              <Badge
                                variant="neutral"
                                className="shrink-0"
                                label={
                                  <>
                                    {statusLabel(job.status)} · {itemProgress}%
                                  </>
                                }
                              />
                            </div>
                            <div className="mt-1 truncate font-mono text-xs text-secondary">{job.id}</div>
                            <div className="mt-1 truncate text-xs text-secondary">
                              {job.source_ref ?? "无来源信息"} · {compactDate(job.started_at)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button onClick={() => handleSelectJob(job)} label="查看" variant="secondary" size="sm" />
                            {job.status === "failed" && (
                              <Button
                                onClick={() => void handleRetryJob(job.id)}
                                label="重试"
                                variant="secondary"
                                size="sm"
                                icon={<RotateCcw data-icon="inline-start" />}
                              />
                            )}
                            {job.status === "running" ? (
                              <Button
                                onClick={() => void handleStopJob(job.id)}
                                label="终止"
                                variant="destructive"
                                size="sm"
                                icon={<Square className="fill-current" data-icon="inline-start" />}
                              />
                            ) : (
                              <Button
                                onClick={() => void handleDeleteJob(job.id)}
                                label="清理任务"
                                variant="ghost"
                                size="sm"
                                tooltip="清理任务"
                                icon={<Trash2 />}
                                isIconOnly
                              />
                            )}
                          </div>
                        </div>
                        <ProgressBar value={itemProgress} className="mt-3" label="进度" isLabelHidden hasValueLabel={false} />
                        <div className="mt-3 flex flex-wrap gap-4 text-xs text-secondary">
                          <span>{job.success_count} 成功 / {job.total_count || "?"} 总数</span>
                          <span>{job.skipped_count} 跳过</span>
                          <span>{job.failed_count} 失败</span>
                          <span>重试 {job.retry_count}</span>
                          {job.finished_at && <span>结束 {compactDate(job.finished_at)}</span>}
                        </div>
                        {job.status === "failed" && job.error_message && (
                          <div className="mt-2 text-xs text-error">{job.error_message}</div>
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
          </div>
        </Card>

        <Card padding={0} className="flex flex-col gap-4 min-h-[300px] flex-1 border-border bg-card shadow-sm">
          <header className="px-5 pt-5 flex flex-col gap-4 border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold text-lg">已采集对局列表</h3>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={handleToggleAllMatches}
                  label={allMatchesSelected ? "取消全选" : `全部选中 ${matches.length}`}
                  variant="secondary"
                  size="sm"
                  isDisabled={matches.length === 0}
                  icon={<ListChecks data-icon="inline-start" />}
                />
                <Button
                  onClick={() => void handleDeleteSelectedMatches()}
                  label={`删除选中 ${selectedMatchCount || ""}`}
                  variant="destructive"
                  size="sm"
                  isDisabled={selectedMatchCount === 0}
                  icon={<Trash2 data-icon="inline-start" />}
                />
                <>
                  <Button
                    label="清空全部"
                    variant="destructive"
                    size="sm"
                    icon={<Trash2 />}
                    isDisabled={matches.length === 0}
                    onClick={() => setConfirmClear(true)}
                  />
                  <AlertDialog
                    isOpen={confirmClear}
                    onOpenChange={setConfirmClear}
                    title="确认清空全部已采集对局？"
                    description={`将删除当前加载的 ${matches.length} 场对局及其位置、事件和本地 telemetry 缓存。此操作无法撤销。`}
                    cancelLabel="取消"
                    actionLabel="确认清空"
                    actionVariant="destructive"
                    onAction={handleDeleteAllMatches}
                  />
                </>
                <Button
                  onClick={() => void refreshMatches()}
                  label="刷新"
                  variant="ghost"
                  size="sm"
                  tooltip="刷新"
                  icon={loadingMatches ? <RotateCcw className="animate-spin" /> : <Filter />}
                  isIconOnly
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_180px_160px]">
              <div className="relative min-w-0">

                <TextInput
                  label="搜索对局"
                  isLabelHidden
                  startIcon={Search}
                  value={matchSearch}
                  onChange={setMatchSearch}
                  placeholder="搜索对局、地图、模式"
                />
              </div>
              <Selector
                label="地图筛选"
                isLabelHidden
                placeholder="地图筛选"
                value={matchMapFilter}
                onChange={setMatchMapFilter}
                options={[
                  { value: "all", label: "全部地图" },
                  ...matchMapOptions.map((map) => ({ value: map, label: mapDisplayName(map) })),
                ]}
              />
              <Selector
                label="状态筛选"
                isLabelHidden
                placeholder="状态筛选"
                value={matchStatusFilter}
                onChange={(value) => setMatchStatusFilter(value as MatchStatusFilter)}
                options={[
                  { value: "all", label: "全部状态" },
                  { value: "completed", label: "已完成" },
                  { value: "pending", label: "处理中" },
                  { value: "failed", label: "失败" },
                ]}
              />
            </div>
          </header>
          <div className="px-5 pb-5 flex-1 p-0">
            <Table>
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell className="w-12 px-5">
                    <CheckboxInput
                      label="选择当前筛选结果"
                      isLabelHidden
                      value={
                        allVisibleSelected ? true : selectedVisibleCount > 0 ? "indeterminate" : false
                      }
                      onChange={(checked) => handleToggleVisibleMatches(checked === true)}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5">
                    <Button
                      type="button"
                      onClick={() => handleSortMatches("match_id")}
                      className="-ml-3 h-8 gap-1 px-2"
                      label="对局ID"
                      variant="ghost"
                      size="sm"
                      tooltip={`按对局ID${sortDirectionLabel(matchSortDirection)}`}
                      endContent={sortIcon("match_id")}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5">
                    <Button
                      type="button"
                      onClick={() => handleSortMatches("map_name")}
                      className="-ml-3 h-8 gap-1 px-2"
                      label="地图 / 模式"
                      variant="ghost"
                      size="sm"
                      tooltip={`按地图/模式${sortDirectionLabel(matchSortDirection)}`}
                      endContent={sortIcon("map_name")}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5">
                    <Button
                      type="button"
                      onClick={() => handleSortMatches("created_at")}
                      className="-ml-3 h-8 gap-1 px-2"
                      label="时间"
                      variant="ghost"
                      size="sm"
                      tooltip={`按时间${sortDirectionLabel(matchSortDirection)}`}
                      endContent={sortIcon("created_at")}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5">
                    <Button
                      type="button"
                      onClick={() => handleSortMatches("telemetry_parse_status")}
                      className="-ml-3 h-8 gap-1 px-2"
                      label="遥测数据"
                      variant="ghost"
                      size="sm"
                      tooltip={`按遥测状态${sortDirectionLabel(matchSortDirection)}`}
                      endContent={sortIcon("telemetry_parse_status")}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5">
                    <Button
                      type="button"
                      onClick={() => handleSortMatches("sample_count")}
                      className="-ml-3 h-8 gap-1 px-2"
                      label="样本数"
                      variant="ghost"
                      size="sm"
                      tooltip={`按样本数${sortDirectionLabel(matchSortDirection)}`}
                      endContent={sortIcon("sample_count")}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className="px-5 text-right">操作</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMatches.map((match) => (
                  <TableRow key={match.match_id}>
                    <TableCell className="px-5">
                      <CheckboxInput
                        label={`选择 ${match.match_id}`}
                        isLabelHidden
                        value={selectedMatchIds.has(match.match_id)}
                        onChange={(checked) => handleToggleMatch(match.match_id, checked === true)}
                      />
                    </TableCell>
                    <TableCell className="px-5 font-mono text-secondary">{match.match_id}</TableCell>
                    <TableCell className="px-5">
                      <div className="font-medium">{mapDisplayName(match.map_name)}</div>
                      <div className="text-xs text-secondary">
                        {match.map_name && mapDisplayName(match.map_name) !== match.map_name
                          ? `${match.map_name} · `
                          : ""}
                        {match.game_mode ?? "未知模式"}
                      </div>
                    </TableCell>
                    <TableCell className="px-5 text-sm text-secondary">{compactDate(match.created_at)}</TableCell>
                    <TableCell className="px-5">
                      <Badge
                        variant={match.telemetry_parse_status === "failed" ? "error" : "neutral"}
                        className={cn(
                          match.telemetry_parse_status === "completed" &&
                            "bg-green-500/10 text-green-400",
                          match.telemetry_parse_status !== "completed" &&
                            match.telemetry_parse_status !== "failed" &&
                            "bg-yellow-500/10 text-yellow-500",
                        )}
                        label={statusLabel(match.telemetry_parse_status)}
                      />
                    </TableCell>
                    <TableCell className="px-5">{matchSampleCount(match).toLocaleString()}</TableCell>
                    <TableCell className="px-5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          onClick={() =>
                            navigate(`/collection?replay=${encodeURIComponent(match.match_id)}`)
                          }
                          label="回放"
                          variant="ghost"
                          size="sm"
                          icon={<Play data-icon="inline-start" />}
                        />
                        <Button
                          onClick={() => handleDeleteMatch(match.match_id)}
                          label="删除"
                          variant="ghost"
                          size="sm"
                          tooltip="删除"
                          icon={<Trash2 />}
                          isIconOnly
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredMatches.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="px-5 py-10 text-center text-secondary">
                      {matches.length === 0 ? "还没有已入库对局。" : "没有匹配当前筛选条件的对局。"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
