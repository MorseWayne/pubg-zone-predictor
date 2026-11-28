import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  PauseCircle,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import {
  api,
  apiErrorMessage,
  type TeamDayFillJob,
  type TeamDayPayload,
  type TeamDaysViewRequest,
  type TeamDaysViewResponse,
} from "../api";
import { HISTORY_LIMIT } from "../matchRange";
import { useWorkspaceBindings } from "../playerWorkspace";
import { TeamDayDetailTabs } from "./TeamDayDetailTabs";
import {
  TeamIntensityTrendChart,
  type TrendMetricKey,
  type TrendViewMode,
} from "./TeamIntensityTrendChart";
import {
  DAY_PALETTE,
  MAX_COMPARE_DAYS,
  averageNullable,
  buildDayColorMap,
  computeDelta,
  formatDecimal,
  formatInt,
  formatMultiDayLabel,
  formatPercent,
  formatPlayerName,
} from "./teamIntensityFormat";
import "./teamIntensity.css";

const MAX_SQUAD = 4;
const DEFAULT_COMPARE_COUNT = 4;
const VISIBLE_DATE_CHIPS_COLLAPSED = 12;

const LIVE_FILL_STATES = new Set<TeamDayFillJob["state"]>(["queued", "running", "paused"]);
const HALT_AUTO_ENSURE_STATES = new Set<TeamDayFillJob["state"]>([
  "budget_exhausted",
  "cancelled",
  "auth_error",
  "failed",
  "busy",
  "disabled",
  "no_api_key",
]);
const MAX_BACKFILL_POLLS = 4;

type SyncNotice = {
  tone: "info" | "warning";
  text: string;
};

type SyncProgress = {
  phase: "checking" | "syncing";
  done: number;
  total: number;
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function buildScopeKey(players: string[], dates: string[], requireAll: boolean) {
  return `${[...players].sort().join(",")}|${[...new Set(dates)].sort().join(",")}|${requireAll ? "all" : "any2"}`;
}

function sameDateSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((d) => setB.has(d));
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3.5">
      <Skeleton height={44} />
      <Card padding={0} className="space-y-4 border-border bg-card p-4">
        <Skeleton height={272} />
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton height={74} />
          <Skeleton height={74} />
          <Skeleton height={74} />
          <Skeleton height={74} />
        </div>
      </Card>
      <Skeleton height={300} />
    </div>
  );
}

function DeltaPill({
  current,
  baseline,
  digits = 2,
  isPercent = false,
  tooltip,
}: {
  current: number | null | undefined;
  baseline: number | null | undefined;
  digits?: number;
  isPercent?: boolean;
  tooltip: string;
}) {
  const delta = computeDelta(current, baseline, { digits, isPercent });
  if (!delta) return null;
  const cls =
    delta.direction === "up"
      ? "team-delta-badge team-delta-badge--up"
      : delta.direction === "down"
        ? "team-delta-badge team-delta-badge--down"
        : "team-delta-badge team-delta-badge--flat";
  return (
    <span className={cls} title={tooltip}>
      {delta.text}
    </span>
  );
}

function CompactOverviewStrip({
  days,
  dayColors,
  trendMode,
  onSelectMetric,
}: {
  days: TeamDayPayload[];
  dayColors: Record<string, string>;
  trendMode: TrendViewMode;
  onSelectMetric: (metric: TrendMetricKey) => void;
}) {
  const latestDay = days[0];
  if (!latestDay) return null;

  const allDates = days.map((d) => d.summary.date);
  const latestLabel = formatMultiDayLabel(latestDay.summary.date, allDates);
  const latestColor = dayColors[latestDay.summary.date] ?? DAY_PALETTE[0];
  const multiCount = days.length;

  const avgKd = multiCount >= 2 ? averageNullable(days.map((d) => d.profiles.kd_p50)) : null;
  const avgOppDmg =
    multiCount >= 2 ? averageNullable(days.map((d) => d.pressure.opponent_damage_p50)) : null;
  const avgTaken =
    multiCount >= 2 ? averageNullable(days.map((d) => d.pressure.team_damage_taken_per_match)) : null;
  const avgBotRate = multiCount >= 2 ? averageNullable(days.map((d) => d.lobby.bot_rate)) : null;

  const cards: Array<{
    key: TrendMetricKey;
    label: string;
    accent: string;
    value: string;
    avgText: string | null;
    rawCurrent: number | null;
    rawAvg: number | null;
    digits: number;
    isPercent?: boolean;
    foot: string;
  }> = [
    {
      key: "kd_p50",
      label: "对手赛季 KD",
      accent: "#38bdf8",
      value: formatDecimal(latestDay.profiles.kd_p50, 2),
      avgText: avgKd !== null ? formatDecimal(avgKd, 2) : null,
      rawCurrent: latestDay.profiles.kd_p50,
      rawAvg: avgKd,
      digits: 2,
      foot: `已知 ${latestDay.profiles.known_kd}/${latestDay.profiles.total_contacts} 人次`,
    },
    {
      key: "opponent_damage_p50",
      label: "对手当场伤害",
      accent: "#fbbf24",
      value: formatInt(latestDay.pressure.opponent_damage_p50),
      avgText: avgOppDmg !== null ? formatInt(avgOppDmg) : null,
      rawCurrent: latestDay.pressure.opponent_damage_p50,
      rawAvg: avgOppDmg,
      digits: 0,
      foot: `前 25% 线 ${formatInt(latestDay.pressure.opponent_damage_p75)}`,
    },
    {
      key: "team_damage_taken_per_match",
      label: "你们场均承伤",
      accent: "#fb7185",
      value: formatInt(latestDay.pressure.team_damage_taken_per_match),
      avgText: avgTaken !== null ? formatInt(avgTaken) : null,
      rawCurrent: latestDay.pressure.team_damage_taken_per_match,
      rawAvg: avgTaken,
      digits: 0,
      foot: `场均输出 ${formatInt(latestDay.pressure.team_damage_dealt_per_match)}`,
    },
    {
      key: "bot_rate",
      label: "大厅人机占比",
      accent: "#34d399",
      value: formatPercent(latestDay.lobby.bot_rate, 1),
      avgText: avgBotRate !== null ? formatPercent(avgBotRate, 1) : null,
      rawCurrent: latestDay.lobby.bot_rate,
      rawAvg: avgBotRate,
      digits: 1,
      isPercent: true,
      foot: `人机 ${latestDay.lobby.bot_count}/${latestDay.lobby.total_players} 人次`,
    },
  ];

  return (
    <div className="border-t border-white/[0.08] pt-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-secondary">
        <div className="inline-flex items-center gap-1.5">
          <span
            className="team-day-dot"
            style={{ backgroundColor: latestColor }}
            aria-hidden="true"
          />
          <span className="font-semibold text-primary/90">{latestLabel}</span>
          <span>最新开黑日核心概览</span>
          {multiCount >= 2 && <span>· 对比已选 {multiCount} 日均值</span>}
        </div>
        <span>点击卡片可单独放大对应维度趋势</span>
      </div>

      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
        role="group"
        aria-label="最新已选日期核心指标概览"
      >
        {cards.map((card) => {
          const active = trendMode === card.key;
          const style = { "--kpi-accent": card.accent } as CSSProperties;
          return (
            <button
              key={card.key}
              type="button"
              aria-pressed={active}
              style={style}
              className={`team-kpi-card ${active ? "team-kpi-card--active" : ""}`}
              onClick={() => onSelectMetric(card.key)}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary">
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: card.accent }}
                    aria-hidden="true"
                  />
                  {card.label}
                </span>
                {multiCount >= 2 && (
                  <DeltaPill
                    current={card.rawCurrent}
                    baseline={card.rawAvg}
                    digits={card.digits}
                    isPercent={card.isPercent}
                    tooltip={`${latestLabel} 相对已选 ${multiCount} 日均值的差值`}
                  />
                )}
              </div>

              <div className="flex items-baseline gap-2">
                <span className="text-xl leading-tight font-bold tracking-tight text-primary">
                  {card.value}
                </span>
                {card.avgText !== null && (
                  <span className="text-[11px] text-secondary">均值 {card.avgText}</span>
                )}
              </div>

              <div className="flex w-full items-center justify-between gap-2 text-[11px] text-secondary">
                <span className="truncate">{card.foot}</span>
                {active && (
                  <span className="shrink-0 text-[10px] font-medium" style={{ color: card.accent }}>
                    单维视图
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TeamDashboard() {
  const outlet = useWorkspaceBindings();
  const headerBindings = outlet?.bindings;

  // Null means "let backend auto-select default squad / latest up to 4 dates".
  const [customPlayerIds, setCustomPlayerIds] = useState<string[] | null>(null);
  const [requireAll, setRequireAll] = useState(false);
  const [customDates, setCustomDates] = useState<string[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [trendMode, setTrendMode] = useState<TrendViewMode>("overview");
  const [squadPopoverOpen, setSquadPopoverOpen] = useState(false);
  const [squadHint, setSquadHint] = useState<string | null>(null);
  const [dateHint, setDateHint] = useState<string | null>(null);
  const [showAllDates, setShowAllDates] = useState(false);

  const [view, setView] = useState<TeamDaysViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fillJob, setFillJob] = useState<TeamDayFillJob | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [fillActionBusy, setFillActionBusy] = useState(false);

  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const viewAbortRef = useRef<AbortController | null>(null);
  const ensureAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const activeJobStateRef = useRef<TeamDayFillJob["state"] | null>(null);
  const autoEnsureMetaRef = useRef<{
    scope: string;
    missing: number;
    promotable: number;
  } | null>(null);
  const lastRevisionRef = useRef<number>(-1);
  const backfillPollScopeRef = useRef<string>("");
  const backfillPollCountRef = useRef<number>(0);

  const bindingsVersion = useMemo(
    () =>
      headerBindings
        ? `${headerBindings.active}:${headerBindings.players.map((p) => p.player_id).join(",")}`
        : "",
    [headerBindings],
  );

  // Close squad popover on outside click or Escape.
  useEffect(() => {
    if (!squadPopoverOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSquadPopoverOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSquadPopoverOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [squadPopoverOpen]);

  // Auto-dismiss transient hints / sync info notices.
  useEffect(() => {
    if (!syncNotice || syncNotice.tone !== "info") return;
    const timer = window.setTimeout(() => setSyncNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [syncNotice]);

  useEffect(() => {
    if (!dateHint) return;
    const timer = window.setTimeout(() => setDateHint(null), 2600);
    return () => window.clearTimeout(timer);
  }, [dateHint]);

  // Cancel any active background fill job cleanly.
  const cancelActiveFill = useCallback(() => {
    ensureAbortRef.current?.abort();
    ensureAbortRef.current = null;
    const jobId = activeJobIdRef.current;
    const state = activeJobStateRef.current;
    if (jobId && state && LIVE_FILL_STATES.has(state)) {
      activeJobIdRef.current = null;
      activeJobStateRef.current = null;
      void api.teamDaysFillCancel(jobId).catch(() => {
        /* Best-effort cancellation on scope change or unmount. */
      });
    }
  }, []);

  // Build request payload respecting backend extra="forbid" & non-empty player_ids rule.
  const buildViewRequest = useCallback((): TeamDaysViewRequest => {
    const req: TeamDaysViewRequest = { require_all: requireAll };
    if (customPlayerIds && customPlayerIds.length > 0) {
      req.player_ids = customPlayerIds;
    }
    if (customDates && customDates.length > 0) {
      req.dates = customDates.slice(0, MAX_COMPARE_DAYS);
    }
    return req;
  }, [customPlayerIds, requireAll, customDates]);

  const fetchView = useCallback(
    async (silent: boolean) => {
      viewAbortRef.current?.abort();
      const controller = new AbortController();
      viewAbortRef.current = controller;

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setError(null);
      }

      try {
        const data = await api.teamDaysView(buildViewRequest(), controller.signal);
        if (controller.signal.aborted) return;
        setView(data);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (!silent) {
          setError(apiErrorMessage(err));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [buildViewRequest],
  );

  // Primary view fetch whenever squad, mode, selected dates, or bindings change.
  const playerIdsKey = customPlayerIds ? customPlayerIds.join(",") : "auto";
  const datesKey = customDates ? customDates.join(",") : "auto";
  useEffect(() => {
    cancelActiveFill();
    setFillJob(null);
    setCountdown(0);
    autoEnsureMetaRef.current = null;
    lastRevisionRef.current = -1;
    void fetchView(view !== null);
    return () => {
      viewAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerIdsKey, requireAll, datesKey, bindingsVersion, reloadTick]);

  // Ensure unmount cleans up running jobs & in-flight fetches/syncs.
  useEffect(() => {
    return () => {
      viewAbortRef.current?.abort();
      syncAbortRef.current?.abort();
      cancelActiveFill();
    };
  }, [cancelActiveFill]);

  // Keep refs in sync with latest fill job state.
  useEffect(() => {
    activeJobIdRef.current = fillJob?.job_id ?? null;
    activeJobStateRef.current = fillJob?.state ?? null;
  }, [fillJob]);

  // Resolve multi-day payloads (with graceful fallback if legacy response shape appears).
  const resolvedDays = useMemo<TeamDayPayload[]>(() => {
    if (!view) return [];
    if (Array.isArray(view.days) && view.days.length > 0) {
      return view.days;
    }
    const fallback: TeamDayPayload[] = [];
    if (view.day_a) fallback.push(view.day_a);
    if (view.day_b && view.day_b.summary.date !== view.day_a?.summary.date) {
      fallback.push(view.day_b);
    }
    return fallback;
  }, [view]);

  const activeSelectedDates = useMemo<string[]>(() => {
    if (!view) return [];
    const avail = new Set(view.available_dates);
    const source =
      Array.isArray(view.selected_dates) && view.selected_dates.length > 0
        ? view.selected_dates
        : resolvedDays.map((d) => d.summary.date);
    return [...new Set(source.filter((d) => avail.has(d)))].slice(0, MAX_COMPARE_DAYS);
  }, [view, resolvedDays]);

  const dayColors = useMemo(() => buildDayColorMap(activeSelectedDates), [activeSelectedDates]);

  const startEnsure = useCallback(
    async (manualContinue: boolean) => {
      if (!view || !view.selected_player_ids.length || activeSelectedDates.length === 0) return;
      ensureAbortRef.current?.abort();
      const controller = new AbortController();
      ensureAbortRef.current = controller;
      if (manualContinue) setFillActionBusy(true);

      try {
        const job = await api.teamDaysEnsure(
          {
            player_ids: view.selected_player_ids,
            require_all: requireAll,
            dates: activeSelectedDates.slice(0, MAX_COMPARE_DAYS),
            manual_continue: manualContinue,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;

        setFillJob(job);
        lastRevisionRef.current = job.revision;
        setCountdown(job.state === "paused" ? job.retry_after : 0);

        if (job.promoted > 0 && !LIVE_FILL_STATES.has(job.state)) {
          void fetchView(true);
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (manualContinue) {
          setError(apiErrorMessage(err));
        }
      } finally {
        if (manualContinue) setFillActionBusy(false);
      }
    },
    [view, requireAll, activeSelectedDates, fetchView],
  );

  // Auto-trigger silent background fill for all selected dates (up to 7) or attach to server active_job.
  useEffect(() => {
    if (!view || loading) return;
    if (!view.selected_player_ids.length || activeSelectedDates.length === 0) return;

    const hint = view.fill_hint;
    const serverActiveJob = hint.active_job;
    if (serverActiveJob && LIVE_FILL_STATES.has(serverActiveJob.state)) {
      setFillJob((prev) =>
        prev &&
        prev.job_id === serverActiveJob.job_id &&
        prev.revision === serverActiveJob.revision
          ? prev
          : serverActiveJob,
      );
      if (lastRevisionRef.current < 0) {
        lastRevisionRef.current = serverActiveJob.revision;
      }
      if (serverActiveJob.state === "paused") {
        setCountdown(serverActiveJob.retry_after);
      }
      return;
    }

    const totalMissing =
      typeof hint.missing_fillable_total === "number"
        ? hint.missing_fillable_total
        : hint.missing_fillable_a + hint.missing_fillable_b;
    const shouldAutoEnsure =
      hint.cache_promotable > 0 || (hint.api_key_configured && totalMissing > 0);
    if (!shouldAutoEnsure) return;

    if (fillJob && LIVE_FILL_STATES.has(fillJob.state)) return;

    const scope = buildScopeKey(view.selected_player_ids, activeSelectedDates, requireAll);
    const prevMeta = autoEnsureMetaRef.current;
    const expandedAfterSeasonBackfill =
      prevMeta !== null &&
      prevMeta.scope === scope &&
      (totalMissing > prevMeta.missing || hint.cache_promotable > prevMeta.promotable);

    if (fillJob && HALT_AUTO_ENSURE_STATES.has(fillJob.state) && !expandedAfterSeasonBackfill) {
      return;
    }
    if (prevMeta && prevMeta.scope === scope && !expandedAfterSeasonBackfill) {
      return;
    }

    const timer = window.setTimeout(() => {
      autoEnsureMetaRef.current = {
        scope,
        missing: totalMissing,
        promotable: hint.cache_promotable,
      };
      void startEnsure(false);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [view, loading, activeSelectedDates, requireAll, fillJob, startEnsure]);

  // Poll fill job status every 1.5s while queued | running | paused, refreshing smoothly on progress.
  useEffect(() => {
    if (!fillJob?.job_id || !LIVE_FILL_STATES.has(fillJob.state)) return;

    const jobId = fillJob.job_id;
    let disposed = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const next = await api.teamDaysFillStatus(jobId, controller.signal);
        if (disposed || controller.signal.aborted) return;

        const prevRev = lastRevisionRef.current;
        const enteredTerminal = !LIVE_FILL_STATES.has(next.state);
        setFillJob(next);
        setCountdown(next.state === "paused" ? next.retry_after : 0);

        if (next.revision > prevRev || enteredTerminal) {
          lastRevisionRef.current = next.revision;
          void fetchView(true);
        }
      } catch (err) {
        if (disposed || controller.signal.aborted || isAbortError(err)) return;
        setFillJob((prev) => (prev?.job_id === jobId ? { ...prev, state: "failed" } : prev));
      }
    };

    const interval = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [fillJob?.job_id, fillJob?.state, fetchView]);

  // Local 1-second countdown ticker during 429 rate-limit pause.
  useEffect(() => {
    if (fillJob?.state !== "paused" || countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [fillJob?.state, countdown]);

  // Short background polling (max 4 times, every 2s) when any selected day is backfilling season_id.
  useEffect(() => {
    if (!view || loading) return;
    const pending = resolvedDays.some((d) => d.data_quality.season_backfill_pending);
    const scope = buildScopeKey(view.selected_player_ids, activeSelectedDates, requireAll);

    if (backfillPollScopeRef.current !== scope) {
      backfillPollScopeRef.current = scope;
      backfillPollCountRef.current = 0;
    }
    if (!pending || backfillPollCountRef.current >= MAX_BACKFILL_POLLS) return;

    const timer = window.setTimeout(() => {
      backfillPollCountRef.current += 1;
      void fetchView(true);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [view, loading, resolvedDays, activeSelectedDates, requireAll, fetchView]);

  const handleStopFill = async () => {
    if (!fillJob?.job_id) return;
    setFillActionBusy(true);
    try {
      const updated = await api.teamDaysFillCancel(fillJob.job_id);
      setFillJob(updated);
      setCountdown(0);
    } catch {
      /* Ignore if already finished. */
    } finally {
      setFillActionBusy(false);
    }
  };

  const bindingList = useMemo(() => {
    if (view?.bindings?.length) return view.bindings;
    return (headerBindings?.players ?? []).map((p) => ({
      player_id: p.player_id,
      player_name: p.player_name,
      is_active: p.player_id === headerBindings?.active,
    }));
  }, [view?.bindings, headerBindings]);

  const activeSquadIds = useMemo(
    () => customPlayerIds ?? view?.selected_player_ids ?? [],
    [customPlayerIds, view?.selected_player_ids],
  );

  const toggleMember = (playerId: string) => {
    setSquadHint(null);
    const current = [...activeSquadIds];
    const exists = current.includes(playerId);
    if (exists) {
      if (current.length <= 1) {
        setSquadHint("至少保留 1 名队员");
        return;
      }
      setCustomPlayerIds(current.filter((id) => id !== playerId));
      setCustomDates(null);
      return;
    }
    if (current.length >= MAX_SQUAD) {
      setSquadHint("最多选择 4 名成员");
      return;
    }
    setCustomPlayerIds([...current, playerId]);
    setCustomDates(null);
  };

  const handleChangeRequireAll = (next: boolean) => {
    if (next === requireAll) return;
    setRequireAll(next);
    setCustomDates(null);
  };

  const availableDates = useMemo(() => view?.available_dates ?? [], [view?.available_dates]);

  // Toggle any date in or out of multi-day comparison (min 1, max 7, ordered newest-first).
  const handleToggleDate = useCallback(
    (date: string) => {
      setDateHint(null);
      const current = [...activeSelectedDates];
      const exists = current.includes(date);
      if (exists) {
        if (current.length <= 1) {
          setDateHint("至少保留 1 天");
          return;
        }
        setCustomDates(current.filter((d) => d !== date));
        return;
      }
      if (current.length >= MAX_COMPARE_DAYS) {
        setDateHint(`最多同时对比 ${MAX_COMPARE_DAYS} 天`);
        return;
      }
      const nextSet = new Set([...current, date]);
      const ordered = availableDates.filter((d) => nextSet.has(d));
      setCustomDates(ordered.length > 0 ? ordered : [...nextSet]);
    },
    [activeSelectedDates, availableDates],
  );

  const handleApplyPreset = (dates: string[]) => {
    setDateHint(null);
    const sliced = dates.slice(0, MAX_COMPARE_DAYS);
    if (sliced.length === 0) return;
    setCustomDates(sliced);
  };

  const handleSelectMetricCard = (metric: TrendMetricKey) => {
    setTrendMode((prev) => (prev === metric ? "overview" : metric));
  };

  // Sync latest matches for currently selected bound members.
  const handleSyncLatest = async () => {
    if (syncProgress) return;
    const targetIds =
      activeSquadIds.length > 0
        ? activeSquadIds
        : bindingList.slice(0, MAX_SQUAD).map((b) => b.player_id);
    if (targetIds.length === 0) {
      setSyncNotice({ tone: "warning", text: "请先在顶部绑定游戏账号后再同步。" });
      return;
    }

    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;
    const { signal } = controller;

    setSyncNotice(null);
    setSyncProgress({ phase: "checking", done: 0, total: 0 });

    try {
      const readyMatchIds = new Set<string>();
      const candidateOwner = new Map<string, string>();
      const historyFailures: string[] = [];

      for (const pid of targetIds) {
        try {
          const local = await api.playerMatches(pid, signal);
          signal.throwIfAborted();
          for (const m of local.matches) {
            if (m.replay_ready) readyMatchIds.add(m.match_id);
          }
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
        }

        try {
          const history = await api.playerHistory(pid, signal, undefined, true);
          signal.throwIfAborted();
          const recent = history.matches.slice(0, HISTORY_LIMIT);
          for (const m of recent) {
            if (!candidateOwner.has(m.match_id)) {
              candidateOwner.set(m.match_id, pid);
            }
          }
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
          historyFailures.push(apiErrorMessage(err));
        }
      }

      const pending: Array<[string, string]> = [];
      for (const [matchId, ownerPid] of candidateOwner.entries()) {
        if (!readyMatchIds.has(matchId)) {
          pending.push([matchId, ownerPid]);
        }
      }

      if (pending.length === 0) {
        if (historyFailures.length > 0) {
          setSyncNotice({ tone: "warning", text: `检查新对局部分失败：${historyFailures[0]}` });
        } else {
          setSyncNotice({ tone: "info", text: "已是最新对局" });
          if (!view || view.available_dates.length === 0) {
            setReloadTick((n) => n + 1);
          }
        }
        return;
      }

      let syncedCount = 0;
      let failedCount = 0;
      setSyncProgress({ phase: "syncing", done: 0, total: pending.length });

      for (let i = 0; i < pending.length; i += 1) {
        const [matchId, ownerPid] = pending[i];
        try {
          await api.prepareMatch(matchId, ownerPid, signal);
          signal.throwIfAborted();
          syncedCount += 1;
        } catch (err) {
          if (signal.aborted || isAbortError(err)) throw err;
          failedCount += 1;
        }
        setSyncProgress({ phase: "syncing", done: i + 1, total: pending.length });
      }

      if (syncedCount > 0) {
        setCustomDates(null);
        setReloadTick((n) => n + 1);
        setSyncNotice({
          tone: failedCount > 0 ? "warning" : "info",
          text:
            failedCount > 0
              ? `已同步 ${syncedCount} 局新对局（${failedCount} 局失败）`
              : `已同步 ${syncedCount} 局新对局，已切回最近开黑日`,
        });
      } else {
        setSyncNotice({
          tone: "warning",
          text: `发现 ${pending.length} 局新对局，但同步失败，请稍后重试`,
        });
      }
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        setSyncNotice({ tone: "info", text: "已取消同步" });
      } else {
        setSyncNotice({ tone: "warning", text: `同步失败：${apiErrorMessage(err)}` });
      }
    } finally {
      if (syncAbortRef.current === controller) {
        syncAbortRef.current = null;
        setSyncProgress(null);
      }
    }
  };

  const handleCancelSync = () => {
    syncAbortRef.current?.abort();
  };

  const matchCountByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of view?.trend ?? []) {
      map.set(row.date, row.match_count);
    }
    return map;
  }, [view?.trend]);

  const activeSquadNames = useMemo(() => {
    const nameById = new Map(bindingList.map((b) => [b.player_id, formatPlayerName(b)]));
    return activeSquadIds.map((id) => nameById.get(id) ?? id.replace(/^account\./, ""));
  }, [activeSquadIds, bindingList]);

  const squadSummaryLabel = useMemo(() => {
    if (activeSquadIds.length === 0) return "未选队员";
    if (activeSquadIds.length === 1) {
      return `${activeSquadNames[0] ?? "1 人"} · 单人`;
    }
    const modeLabel = requireAll ? "仅全员到齐" : "≥2 人开黑";
    return `${activeSquadIds.length} 人战队 · ${modeLabel}`;
  }, [activeSquadIds.length, activeSquadNames, requireAll]);

  // Quick range presets tailored to available_dates count (max 7).
  const datePresets = useMemo(() => {
    const total = availableDates.length;
    if (total <= 1) return [];
    if (total <= DEFAULT_COMPARE_COUNT) {
      return [{ id: "all", label: `全部 (${total}天)`, dates: availableDates }];
    }
    if (total < MAX_COMPARE_DAYS) {
      return [
        {
          id: "recent4",
          label: "最近 4 天",
          dates: availableDates.slice(0, DEFAULT_COMPARE_COUNT),
        },
        { id: "all", label: `全部 (${total}天)`, dates: availableDates },
      ];
    }
    return [
      {
        id: "recent4",
        label: "最近 4 天",
        dates: availableDates.slice(0, DEFAULT_COMPARE_COUNT),
      },
      {
        id: "recent7",
        label: total === MAX_COMPARE_DAYS ? "全部 (7天)" : "最近 7 天",
        dates: availableDates.slice(0, MAX_COMPARE_DAYS),
      },
    ];
  }, [availableDates]);

  const visibleDateChips = useMemo(() => {
    if (showAllDates || availableDates.length <= VISIBLE_DATE_CHIPS_COLLAPSED) {
      return availableDates;
    }
    const base = availableDates.slice(0, VISIBLE_DATE_CHIPS_COLLAPSED);
    const baseSet = new Set(base);
    // Always keep any currently selected older dates visible.
    const extraSelected = activeSelectedDates.filter((d) => !baseSet.has(d));
    return [...base, ...extraSelected];
  }, [availableDates, activeSelectedDates, showAllDates]);

  const hiddenDateCount = Math.max(0, availableDates.length - visibleDateChips.length);

  // Quiet toolbar capsule: hidden when completed / no_api_key / disabled / cancelled.
  const fillCapsule = useMemo(() => {
    if (!fillJob) return null;
    const { state, remaining, requests_used, request_budget } = fillJob;
    if (
      state === "completed" ||
      state === "no_api_key" ||
      state === "disabled" ||
      state === "cancelled"
    ) {
      return null;
    }
    if (state === "queued" || state === "running") {
      return {
        kind: "running" as const,
        label: `补齐战绩 ${requests_used}/${request_budget}`,
        title: `正在后台静默补齐所选多日的对手赛季 KD（剩余约 ${remaining} 项）`,
      };
    }
    if (state === "paused") {
      return {
        kind: "paused" as const,
        label: `限流暂停 ${countdown > 0 ? `${countdown}s` : "…"}`,
        title: `PUBG 接口限流，倒计时结束后自动继续补齐（剩余约 ${remaining} 项）`,
      };
    }
    if (state === "budget_exhausted") {
      return {
        kind: "resumable" as const,
        label: `待补 ${remaining} 项`,
        title: `本轮自动补齐已达请求上限，点击继续补齐剩余约 ${remaining} 项`,
      };
    }
    if (state === "busy") {
      return {
        kind: "resumable" as const,
        label: "补齐排队中",
        title: "当前已有另一个补齐任务在运行，稍后可点击继续补齐",
      };
    }
    if (state === "failed") {
      return {
        kind: "resumable" as const,
        label: "补齐异常",
        title: "后台补齐对手战绩时遇到异常，点击重试",
      };
    }
    if (state === "auth_error") {
      return {
        kind: "error" as const,
        label: "API 鉴权失败",
        title: "PUBG API Key 鉴权失败，已暂停补齐赛季战绩（不影响当场伤害与大厅数据）",
      };
    }
    return null;
  }, [fillJob, countdown]);

  return (
    <div className="team-intensity-page flex h-full w-full flex-col gap-3.5 overflow-auto bg-body p-4 text-primary">
      {/* Zone 0: Clean 2-row compact top toolbar */}
      <div className="space-y-2">
        {/* Row 1: Title + Squad popover chip | Quiet fill capsule + Sync latest matches */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-base font-semibold tracking-tight text-primary">团队对局强度</h1>

            {bindingList.length > 0 && (
              <div ref={popoverRef} className="relative">
                <button
                  type="button"
                  className="team-filter-trigger"
                  aria-expanded={squadPopoverOpen}
                  aria-haspopup="dialog"
                  title={
                    activeSquadNames.length ? `当前成员：${activeSquadNames.join("、")}` : undefined
                  }
                  onClick={() => {
                    setSquadHint(null);
                    setSquadPopoverOpen((open) => !open);
                  }}
                >
                  <Users className="size-3.5 text-sky-400" />
                  <span>{squadSummaryLabel}</span>
                  <ChevronDown
                    className={`size-3.5 text-secondary transition-transform ${
                      squadPopoverOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {squadPopoverOpen && (
                  <div
                    role="dialog"
                    aria-label="统计阵容与开黑口径"
                    className="team-filter-popover space-y-3.5"
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-primary">同队口径</span>
                        {activeSquadIds.length <= 1 && (
                          <span className="text-[11px] text-secondary">仅选 1 人时按单人统计</span>
                        )}
                      </div>
                      <div className="team-pill-group w-full" role="group" aria-label="同队开黑口径">
                        <button
                          type="button"
                          className="team-pill-btn flex-1 justify-center"
                          aria-pressed={!requireAll}
                          disabled={activeSquadIds.length <= 1}
                          onClick={() => handleChangeRequireAll(false)}
                        >
                          至少 2 人开黑
                        </button>
                        <button
                          type="button"
                          className="team-pill-btn flex-1 justify-center"
                          aria-pressed={requireAll}
                          disabled={activeSquadIds.length <= 1}
                          onClick={() => handleChangeRequireAll(true)}
                        >
                          仅全员到齐
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5 border-t border-white/[0.08] pt-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-primary">统计成员（1–4 人）</span>
                        <span className="text-[11px] text-secondary">
                          已选 {activeSquadIds.length}/{Math.min(MAX_SQUAD, bindingList.length)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {bindingList.map((member) => {
                          const selected = activeSquadIds.includes(member.player_id);
                          const disabled = !selected && activeSquadIds.length >= MAX_SQUAD;
                          return (
                            <button
                              key={member.player_id}
                              type="button"
                              className="team-squad-chip"
                              aria-pressed={selected}
                              disabled={disabled}
                              onClick={() => toggleMember(member.player_id)}
                            >
                              {selected && <Check className="size-3 text-sky-400" />}
                              <span>{formatPlayerName(member)}</span>
                            </button>
                          );
                        })}
                      </div>
                      {squadHint && <div className="text-[11px] text-amber-300">{squadHint}</div>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {refreshing && !syncProgress && (
              <Loader2
                className="size-3.5 animate-spin text-secondary"
                aria-label="正在刷新团队数据"
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {fillCapsule && (
              <div className="team-fill-capsule" role="status" title={fillCapsule.title}>
                {fillCapsule.kind === "running" && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-400" />
                )}
                {fillCapsule.kind === "paused" && (
                  <PauseCircle className="size-3.5 shrink-0 text-amber-400" />
                )}
                {(fillCapsule.kind === "resumable" || fillCapsule.kind === "error") && (
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
                )}
                <span className="text-primary/90">{fillCapsule.label}</span>
                {(fillCapsule.kind === "running" || fillCapsule.kind === "paused") && (
                  <button
                    type="button"
                    className="team-fill-capsule-action"
                    disabled={fillActionBusy}
                    onClick={() => void handleStopFill()}
                  >
                    停止
                  </button>
                )}
                {fillCapsule.kind === "resumable" && (
                  <button
                    type="button"
                    className="team-fill-capsule-action"
                    disabled={fillActionBusy}
                    onClick={() => void startEnsure(true)}
                  >
                    继续
                  </button>
                )}
              </div>
            )}

            {syncNotice && !syncProgress && (
              <span
                role="status"
                className={`text-xs ${
                  syncNotice.tone === "warning" ? "text-amber-300" : "text-emerald-300"
                }`}
              >
                {syncNotice.text}
              </span>
            )}

            {syncProgress ? (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 bg-sky-500/12 px-2.5 py-1 text-xs text-sky-200">
                <Loader2 className="size-3.5 animate-spin text-sky-400" />
                <span>
                  {syncProgress.phase === "checking"
                    ? "检查新对局…"
                    : `同步中 ${syncProgress.done}/${syncProgress.total}…`}
                </span>
                <button
                  type="button"
                  aria-label="取消同步"
                  title="取消同步"
                  onClick={handleCancelSync}
                  className="ml-0.5 rounded p-0.5 text-sky-200/80 hover:bg-white/10 hover:text-primary"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <Button
                label="同步最新对局"
                size="sm"
                variant="secondary"
                icon={<RefreshCw data-icon="inline-start" />}
                isDisabled={bindingList.length === 0}
                onClick={() => void handleSyncLatest()}
              />
            )}
          </div>
        </div>

        {/* Row 2: Compact free multi-day selector bar */}
        {availableDates.length > 0 && (
          <div className="team-date-bar" role="region" aria-label="多日自由对比日期选择">
            {datePresets.length > 0 && (
              <div className="team-pill-group shrink-0" role="group" aria-label="快捷日期范围">
                {datePresets.map((preset) => {
                  const isActive = sameDateSet(activeSelectedDates, preset.dates);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className="team-pill-btn !min-h-6 !px-2.5 !text-[11px]"
                      aria-pressed={isActive}
                      onClick={() => handleApplyPreset(preset.dates)}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {visibleDateChips.map((date) => {
                const color = dayColors[date];
                const isSelected = Boolean(color);
                const count = matchCountByDate.get(date);
                const label = formatMultiDayLabel(date, availableDates);
                const style = isSelected
                  ? {
                      borderColor: `${color}80`,
                      backgroundColor: `${color}1f`,
                    }
                  : undefined;

                return (
                  <button
                    key={date}
                    type="button"
                    className="team-date-chip"
                    style={style}
                    aria-pressed={isSelected}
                    title={
                      isSelected
                        ? `${date}${count !== undefined ? `（${count} 局）` : ""}，点击取消对比`
                        : `${date}${count !== undefined ? `（${count} 局）` : ""}，点击加入对比`
                    }
                    onClick={() => handleToggleDate(date)}
                  >
                    {isSelected && (
                      <span
                        className="team-day-dot"
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                    )}
                    <span>{label}</span>
                    {count !== undefined && (
                      <span className="text-[11px] font-normal text-secondary">({count}局)</span>
                    )}
                  </button>
                );
              })}

              {hiddenDateCount > 0 && (
                <button
                  type="button"
                  className="team-date-chip"
                  onClick={() => setShowAllDates(true)}
                >
                  展开更多 (+{hiddenDateCount})
                </button>
              )}

              {showAllDates && availableDates.length > VISIBLE_DATE_CHIPS_COLLAPSED && (
                <button
                  type="button"
                  className="team-date-chip"
                  onClick={() => setShowAllDates(false)}
                >
                  收起
                </button>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-secondary">
              {dateHint ? (
                <span className="text-amber-300" role="status">
                  {dateHint}
                </span>
              ) : (
                <span>
                  已选 {activeSelectedDates.length}/{Math.min(MAX_COMPARE_DAYS, availableDates.length)}{" "}
                  天
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Slim single-line warnings strip */}
      {view && (view.selection_warning || view.warnings.length > 0) && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-200/90"
          role="note"
        >
          <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
          {view.selection_warning && <span>{view.selection_warning}</span>}
          {view.warnings.map((w) => (
            <span key={w.code}>• {w.message}</span>
          ))}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <Banner
          status="error"
          role="alert"
          title="团队强度数据加载失败"
          description={error}
          endContent={
            <Button
              label="重试"
              size="sm"
              variant="secondary"
              onClick={() => setReloadTick((n) => n + 1)}
            />
          }
        />
      )}

      {/* Main content */}
      {loading && !view ? (
        <LoadingSkeleton />
      ) : view && view.available_dates.length === 0 ? (
        <Banner
          status="info"
          title="当前口径暂无本地同队记录"
          description={
            requireAll && activeSquadIds.length > 1
              ? "可切回「至少 2 人开黑」口径，或点击右上角「同步最新对局」拉取刚打完的新局。"
              : "点击右上角「同步最新对局」拉取成员近期对局，同步后这里会自动按天汇总。"
          }
          endContent={
            requireAll && activeSquadIds.length > 1 ? (
              <Button
                label="切回 ≥2 人开黑"
                size="sm"
                variant="secondary"
                onClick={() => handleChangeRequireAll(false)}
              />
            ) : undefined
          }
        />
      ) : view && resolvedDays.length > 0 ? (
        <>
          {/* Zone 1 (First-Screen Hero): Multi-Day Overall Trend Chart + Compact Overview Strip */}
          <Card padding={0} className="space-y-3.5 border-border bg-card p-4 shadow-sm">
            <TeamIntensityTrendChart
              mode={trendMode}
              onModeChange={setTrendMode}
              trend={view.trend}
              selectedDates={activeSelectedDates}
              dayColors={dayColors}
              onToggleDate={handleToggleDate}
            />

            <CompactOverviewStrip
              days={resolvedDays}
              dayColors={dayColors}
              trendMode={trendMode}
              onSelectMetric={handleSelectMetricCard}
            />
          </Card>

          {/* Zone 2: Multi-Day Side-by-Side 3-Tab Detail Card */}
          <TeamDayDetailTabs days={resolvedDays} dayColors={dayColors} />
        </>
      ) : view ? (
        <Banner
          status="info"
          title="所选日期没有符合当前口径的对局"
          description="可以点击按钮切回最近开黑日。"
          endContent={
            <Button
              label="切回最近开黑日"
              size="sm"
              variant="secondary"
              onClick={() => setCustomDates(null)}
            />
          }
        />
      ) : null}
    </div>
  );
}
