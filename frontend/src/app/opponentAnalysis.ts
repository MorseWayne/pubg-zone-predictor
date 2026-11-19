import { api, ApiError, apiErrorMessage } from "./api";
import type { EncounterList, Mastery, OpponentHistory, OpponentMatch, OpponentStats } from "./api";

export type MatchResult = OpponentMatch & { encounters?: EncounterList; error?: string };
export type OpponentReport = {
  history: OpponentHistory;
  matches: MatchResult[];
  stats: Record<string, OpponentStats | null>;
  mastery: Record<string, Mastery>;
  warnings: string[];
};

export function statsGroup(match: MatchResult) {
  return [match.encounters?.season, match.game_mode, match.match_type].join("/");
}

function waitForQuota(seconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, seconds * 1000);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export async function analyzeOpponents(
  name: string, limit: number, signal: AbortSignal,
  publish: (report: OpponentReport) => void, status: (message: string) => void,
) {
  async function request<T>(message: string, fetch: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      status(message);
      try {
        return await fetch();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 2) throw error;
        const details = error.details as { retry_after?: number } | undefined;
        const seconds = details?.retry_after ?? 60;
        status(`官方接口限流，${seconds} 秒后自动继续 · ${message}`);
        await waitForQuota(seconds, signal);
      }
    }
  }

  const history = await request("查找选手和近期对局…", () => api.opponentHistory(name, limit, signal));
  const matches: MatchResult[] = [];
  const stats: OpponentReport["stats"] = {};
  const mastery: OpponentReport["mastery"] = {};
  const warnings = new Set(history.warnings);
  function update() {
    signal.throwIfAborted();
    publish({ history, matches: [...matches], stats: { ...stats }, mastery: { ...mastery }, warnings: [...warnings] });
  }
  update();
  const people = new Set<string>();
  const groups = new Map<string, { season: string; mode: string; ranked: boolean; ids: Set<string> }>();
  for (const match of history.matches) {
    const result: MatchResult = { ...match };
    try {
      const encounters = await request(`读取交手记录 ${matches.length + 1} / ${history.matches.length}`,
        () => api.matchEncounters(match.match_id, history.player_id, signal));
      result.encounters = encounters;
      const ids = encounters.opponents.filter(p => p.kind === "human").map(p => p.player_id);
      ids.forEach(id => people.add(id));
      if (encounters.season && ["official", "competitive"].includes(match.match_type) &&
          /^(solo|duo|squad)(-fpp)?$/.test(match.game_mode)) {
        const key = statsGroup(result);
        const group = groups.get(key) ?? { season: encounters.season, mode: match.game_mode,
          ranked: match.match_type === "competitive", ids: new Set<string>() };
        ids.forEach(id => group.ids.add(id));
        groups.set(key, group);
      }
    } catch (error) {
      signal.throwIfAborted();
      result.error = apiErrorMessage(error);
    }
    matches.push(result);
    update();
  }

  function profileFailure(error: unknown, label: string) {
    signal.throwIfAborted();
    if (error instanceof ApiError && (error.status === 429 || error.code === "PUBG_API_KEY_MISSING" ||
      [401, 403].includes((error.details as { upstream_status?: number })?.upstream_status ?? 0))) throw error;
    warnings.add(label + "有请求失败，相关数据暂缺。");
  }
  for (const [key, group] of groups) {
    const ids = [...group.ids];
    const batch = group.ranked ? 1 : 10;
    for (let i = 0; i < ids.length; i += batch) {
      try {
        const rows = await request("查询对手赛季战绩…", () =>
          api.opponentStats(group.season, group.mode, group.ranked, ids.slice(i, i + batch), signal));
        for (const [id, row] of Object.entries(rows)) stats[`${key}/${id}`] = row;
      } catch (error) {
        profileFailure(error, "赛季战绩");
      }
      update();
    }
  }
  let checked = 0;
  for (const id of people) {
    checked++;
    try {
      mastery[id] = await request(`查询生存等级 ${checked} / ${people.size}`, () => api.opponentMastery(id, signal));
    } catch (error) {
      profileFailure(error, "生存等级");
    }
    update();
  }
}
