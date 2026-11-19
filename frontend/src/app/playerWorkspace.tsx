import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { DateInput } from "@astryxdesign/core/DateInput";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import {
  HISTORY_LIMIT,
  readMatchRange,
  saveMatchRange,
  todayInBeijing,
  type MatchRange,
} from "./matchRange";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import { api, apiErrorMessage, type IngestMatch, type OpponentHistory } from "./api";

export type BoundPlayer = Pick<OpponentHistory, "player_id" | "player_name">;
type Bindings = { active: string; players: BoundPlayer[] };
type Workspace = {
  player: BoundPlayer;
  matches: IngestMatch[];
  statMatchIds: string[];
  matchDate?: string;
  rangeLabel: string;
  syncing: boolean;
};
const STORAGE = "pzp_steam_player_bindings";
export const usePlayerWorkspace = () => useOutletContext<Workspace>();

function readBindings(): Bindings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
    const players: BoundPlayer[] = stored.players.filter(
      (p: BoundPlayer) =>
        typeof p?.player_name === "string" && /^account\.[\w-]+$/.test(p.player_id),
    );
    if (players.some((p) => p.player_id === stored.active))
      return { active: stored.active, players };
  } catch {
    /* First visit or unavailable browser storage. */
  }
  return { active: "", players: [] };
}

function PlayerSession({
  player,
  initialHistory,
  matchDate,
}: {
  player: BoundPlayer;
  initialHistory?: OpponentHistory;
  matchDate?: string;
}) {
  const initial = useRef(initialHistory);
  const rangeLabel = matchDate ?? "最近 20 局";
  const [attempt, setAttempt] = useState(0);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [statMatchIds, setStatMatchIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(true);
  const [progress, setProgress] = useState("正在读取最近对局…");
  const [warning, setWarning] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function sync() {
      setSyncing(true);
      setWarning("");
      setProgress(`正在查找${rangeLabel}的对局…`);
      let local: IngestMatch[] = [];
      try {
        try {
          local = (await api.playerMatches(player.player_id, signal, matchDate)).matches;
          signal.throwIfAborted();
          setMatches(local);
          setStatMatchIds(local.map((m) => m.match_id));
        } catch {
          signal.throwIfAborted();
        }
        const history =
          initial.current ?? (await api.playerHistory(player.player_id, signal, matchDate, attempt > 0));
        signal.throwIfAborted();
        initial.current = undefined;
        if (history.player_id !== player.player_id) throw new Error("返回的账号与绑定玩家不一致");
        const window = matchDate ? history.matches : history.matches.slice(0, HISTORY_LIMIT);
        const ready = new Map(local.map((m) => [m.match_id, m]));
        const available = () =>
          window.flatMap((m) => {
            const match = ready.get(m.match_id);
            return match ? [match] : [];
          });
        setMatches(available());
        setStatMatchIds(available().map((m) => m.match_id));
        setWarning(history.warnings.join(" "));
        const failures: string[] = [];
        const pending = window.filter(match => !ready.get(match.match_id)?.replay_ready);
        const reused = window.length - pending.length;
        for (const [i, match] of pending.entries()) {
          setProgress(`正在同步第 ${reused + i + 1} / ${window.length} 局…`);
          try {
            const prepared = await api.prepareMatch(match.match_id, player.player_id, signal);
            signal.throwIfAborted();
            ready.set(match.match_id, prepared);
          } catch (err) {
            signal.throwIfAborted();
            failures.push(apiErrorMessage(err));
          }
          setMatches(available());
        }
        const count = window.length - failures.length;
        setProgress(`已同步 ${count} / ${window.length} 局` + (reused ? ` · 本地复用 ${reused} 局` : ""));
        if (failures.length)
          setWarning(
            [...history.warnings, `${failures.length} 局同步失败：${failures[0]}`].join(" "),
          );
        setStatMatchIds(available().map((m) => m.match_id));
      } catch (err) {
        if (!signal.aborted) {
          setWarning(apiErrorMessage(err));
          setProgress(`未完成同步，显示 ${local.length} 局本地记录`);
        }
      } finally {
        if (!signal.aborted) setSyncing(false);
      }
    }
    void sync();
    return () => controller.abort();
  }, [player.player_id, matchDate, rangeLabel, attempt]);

  const refresh = () => setAttempt((n) => n + 1);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-1.5 text-xs text-secondary">
        <span role="status">{progress}</span>
        {warning && (
          <span role="alert" className="text-warning">
            {warning}
          </span>
        )}
        {!syncing && <Button label="重新同步" size="sm" variant="ghost" onClick={refresh} />}
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet
          context={
            { player, matches, statMatchIds, syncing, matchDate, rangeLabel } satisfies Workspace
          }
        />
      </div>
    </>
  );
}

export function PlayerWorkspace() {
  const [bindings, setBindings] = useState(readBindings);
  const [range, setRange] = useState(readMatchRange);
  const matchDate = range.mode === "day" ? range.day : undefined;
  function changeRange(next: MatchRange) {
    setInitialHistory(undefined);
    setRange(next);
    try {
      saveMatchRange(next);
    } catch {
      setError("浏览器无法保存筛选，本次会话仍可使用。");
    }
  }
  const current = bindings.players.find((p) => p.player_id === bindings.active);
  const [adding, setAdding] = useState(!current);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [initialHistory, setInitialHistory] = useState<OpponentHistory>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  function select(player: BoundPlayer, history?: OpponentHistory) {
    const next = {
      active: player.player_id,
      players: [...bindings.players.filter((p) => p.player_id !== player.player_id), player],
    };
    setBindings(next);
    setInitialHistory(matchDate ? undefined : history);
    setQuery("");
    setAdding(false);
    setError("");
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next));
    } catch {
      setError("浏览器无法保存绑定，本次会话仍可使用。");
    }
    if (current && current.player_id !== player.player_id) navigate(pathname, { replace: true });
  }
  async function bind(e: FormEvent) {
    e.preventDefault();
    if (busy || !query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const history = await api.playerHistory(query.trim());
      select({ player_id: history.player_id, player_name: history.player_name }, history);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header
        className={
          current
            ? "flex shrink-0 flex-col gap-2 border-b border-border bg-card px-4 py-3"
            : "m-auto flex w-[min(32rem,95%)] flex-col gap-4 rounded-lg border border-border bg-card p-6"
        }
      >
        {!current && (
          <div>
            <h1 className="text-xl font-semibold">绑定游戏账号</h1>
            <p className="mt-2 text-sm text-secondary">
              自动同步最近 20 局，用于对局回放、个人历史和团队看板。绑定保存在此浏览器。
            </p>
          </div>
        )}
        {current && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold">当前玩家</span>
            <Selector
              label="切换当前玩家"
              isLabelHidden
              value={current.player_id}
              isDisabled={busy}
              options={bindings.players.map((p) => ({ value: p.player_id, label: p.player_name }))}
              onChange={(id) => {
                const p = bindings.players.find((p) => p.player_id === id);
                if (p) select(p);
              }}
            />
            <Button
              label="绑定其他玩家"
              size="sm"
              variant="secondary"
              onClick={() => setAdding(true)}
              isDisabled={adding}
            />
            {["/analysis", "/personal-trend", "/team-dashboard", "/opponents"].includes(pathname) && (
              <>
                <SegmentedControl
                  label="全局对局范围"
                  value={range.mode}
                  isDisabled={busy}
                  onChange={(mode) =>
                    changeRange({ mode: mode === "day" ? "day" : "recent", day: range.day })
                  }
                >
                  <SegmentedControlItem value="recent" label={pathname === "/opponents" ? "最近对局" : "最近 20 局"} />
                  <SegmentedControlItem value="day" label="指定日期" />
                </SegmentedControl>
                {range.mode === "day" && (
                  <DateInput
                    label="开局日期（北京时间）"
                    value={range.day}
                    max={todayInBeijing()}
                    isDisabled={busy}
                    onChange={(day) => {
                      if (day && day !== range.day) changeRange({ mode: "day", day });
                    }}
                  />
                )}
              </>
            )}
          </div>
        )}
        {adding && (
          <form onSubmit={bind} className="flex flex-wrap items-end gap-3">
            <TextInput
              label={
                current ? "新玩家的 Steam 游戏昵称或账号 ID" : "绑定你的 Steam 游戏昵称或账号 ID"
              }
              value={query}
              onChange={setQuery}
              containerClassName="min-w-56"
              isDisabled={busy}
            />
            <Button
              label={busy ? "正在查找…" : "绑定玩家"}
              type="submit"
              isDisabled={busy || !query.trim()}
            />
            {current && (
              <Button
                label="取消"
                variant="ghost"
                isDisabled={busy}
                onClick={() => {
                  setAdding(false);
                  setError("");
                }}
              />
            )}
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
      </header>
      {current && (
        <PlayerSession
          key={`${current.player_id}/${matchDate ?? "recent"}`}
          player={current}
          initialHistory={initialHistory}
          matchDate={matchDate}
        />
      )}
    </>
  );
}
