import { api, ApiError, apiErrorMessage } from "./api";
import type {
  EncounterList,
  Mastery,
  OpponentHistory,
  OpponentMatch,
  OpponentRange,
  OpponentStats,
  TeamMatchEncounters,
} from "./api";

export type MatchResult = OpponentMatch & { encounters?: EncounterList; error?: string };
type ProfileCacheHits = { season: number; mastery: number };

export type OpponentReport = {
  cacheHits: ProfileCacheHits;
  history: OpponentHistory;
  matches: MatchResult[];
  stats: Record<string, OpponentStats | null>;
  mastery: Record<string, Mastery>;
  warnings: string[];
};

function profileGroup(season: string | null | undefined, mode: string, type: string) {
  return [season, mode, type].join("/");
}

export function statsGroup(match: MatchResult) {
  return profileGroup(match.encounters?.season, match.game_mode, match.match_type);
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

function quotaRequester(signal: AbortSignal, status: (message: string) => void) {
  return async function request<T>(message: string, fetch: () => Promise<T>): Promise<T> {
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
  };
}

export async function analyzeOpponents(
  name: string,
  range: OpponentRange,
  signal: AbortSignal,
  publish: (report: OpponentReport) => void,
  status: (message: string) => void,
) {
  const request = quotaRequester(signal, status);
  const history = await request(
    "match_date" in range ? `查找 ${range.match_date} 的对局…` : "查找选手和近期对局…",
    () => api.opponentHistory(name, range, signal),
  );
  const cacheHits = { season: 0, mastery: 0 };
  const matches: MatchResult[] = [];
  const stats: OpponentReport["stats"] = {};
  const mastery: OpponentReport["mastery"] = {};
  const warnings = new Set(history.warnings);
  function update() {
    signal.throwIfAborted();
    publish({
      history,
      cacheHits: { ...cacheHits },
      matches: [...matches],
      stats: { ...stats },
      mastery: { ...mastery },
      warnings: [...warnings],
    });
  }
  update();
  const lookups: ProfileLookup[] = [];
  for (const match of history.matches) {
    const result: MatchResult = { ...match };
    try {
      const encounters = await request(
        `读取交手记录 ${matches.length + 1} / ${history.matches.length}`,
        () => api.matchEncounters(match.match_id, history.player_id, signal),
      );
      result.encounters = encounters;
      const ids = encounters.opponents.filter((p) => p.kind === "human").map((p) => p.player_id);
      lookups.push({
        season: encounters.season,
        mode: match.game_mode,
        type: match.match_type,
        ids,
      });
    } catch (error) {
      signal.throwIfAborted();
      result.error = apiErrorMessage(error);
    }
    matches.push(result);
    update();
  }

  await loadProfiles(lookups, signal, request, stats, mastery, warnings, cacheHits, update);
}

type ProfileLookup = { season: string | null; mode: string; type: string; ids: string[] };

async function loadProfiles(
  lookups: ProfileLookup[],
  signal: AbortSignal,
  request: ReturnType<typeof quotaRequester>,
  stats: OpponentReport["stats"],
  mastery: OpponentReport["mastery"],
  warnings: Set<string>,
  cacheHits: ProfileCacheHits,
  update: () => void,
) {
  const people = new Set<string>();
  const groups = new Map<
    string,
    { season: string; mode: string; ranked: boolean; ids: Set<string> }
  >();
  for (const { season, mode, type, ids } of lookups) {
    ids.forEach((id) => people.add(id));
    if (
      !season ||
      !["official", "competitive"].includes(type) ||
      !/^(solo|duo|squad)(-fpp)?$/.test(mode)
    )
      continue;
    const key = profileGroup(season, mode, type);
    const group = groups.get(key) ?? {
      season,
      mode,
      ranked: type === "competitive",
      ids: new Set<string>(),
    };
    ids.forEach((id) => group.ids.add(id));
    groups.set(key, group);
  }
  function profileFailure(error: unknown, label: string) {
    signal.throwIfAborted();
    if (
      error instanceof ApiError &&
      (error.status === 429 ||
        error.code === "PUBG_API_KEY_MISSING" ||
        [401, 403].includes((error.details as { upstream_status?: number })?.upstream_status ?? 0))
    )
      throw error;
    warnings.add(label + "有请求失败，相关数据暂缺。");
  }
  // Populate every available profile before a single cold miss can trigger a quota wait.
  const masteryOnly = new Set(people);
  async function showCached(
    ids: string[],
    group?: { season: string; mode: string; ranked: boolean },
    key?: string,
  ) {
    for (let i = 0; i < ids.length; i += 100) {
      signal.throwIfAborted();
      const chunk = ids.slice(i, i + 100);
      const cached = await request("读取本地战绩与生存等级…", () =>
        api.cachedOpponentProfiles(chunk, group, signal),
      );
      Object.assign(mastery, cached.mastery);
      if (key) {
        for (const [id, value] of Object.entries(cached.stats)) stats[`${key}/${id}`] = value;
      }
      cacheHits.season = Object.keys(stats).length;
      cacheHits.mastery = Object.keys(mastery).length;
      update();
    }
  }
  for (const [key, group] of groups) {
    for (const id of group.ids) masteryOnly.delete(id);
    await showCached(
      [...group.ids],
      { season: group.season, mode: group.mode, ranked: group.ranked },
      key,
    );
  }
  await showCached([...masteryOnly]);

  for (const [key, group] of groups) {
    const ids = [...group.ids].filter((id) => !(`${key}/${id}` in stats));
    const batch = group.ranked ? 1 : 10;
    for (let i = 0; i < ids.length; i += batch) {
      try {
        const rows = await request("查询对手赛季战绩…", () =>
          api.opponentStats(
            group.season,
            group.mode,
            group.ranked,
            ids.slice(i, i + batch),
            signal,
          ),
        );
        for (const [id, row] of Object.entries(rows)) stats[`${key}/${id}`] = row;
      } catch (error) {
        profileFailure(error, "赛季战绩");
      }
      update();
    }
  }
  const missingLevels = [...people].filter((id) => !(id in mastery));
  let checked = 0;
  for (const id of missingLevels) {
    checked++;
    try {
      mastery[id] = await request(`补齐生存等级 ${checked} / ${missingLevels.length}`, () =>
        api.opponentMastery(id, signal),
      );
    } catch (error) {
      profileFailure(error, "生存等级");
    }
    update();
  }
}

export type TeamComparison = Pick<
  OpponentReport,
  "stats" | "mastery" | "warnings" | "cacheHits"
> & {
  samples: TeamMatchEncounters[];
};

export async function compareTeamOpponents(
  matchIds: string[],
  members: string[],
  signal: AbortSignal,
  publish: (report: TeamComparison) => void,
  status: (message: string) => void,
) {
  const request = quotaRequester(signal, status);
  const samples: TeamMatchEncounters[] = [];
  const cacheHits = { season: 0, mastery: 0 };
  const stats: TeamComparison["stats"] = {};
  const mastery: TeamComparison["mastery"] = {};
  const warnings = new Set<string>();
  const lookups: ProfileLookup[] = [];
  function update() {
    signal.throwIfAborted();
    publish({
      samples: [...samples],
      cacheHits: { ...cacheHits },
      stats: { ...stats },
      mastery: { ...mastery },
      warnings: [...warnings],
    });
  }
  update();
  for (const [i, matchId] of matchIds.entries()) {
    let sample: TeamMatchEncounters;
    try {
      sample = await request(`读取全队交手记录 ${i + 1} / ${matchIds.length}`, () =>
        api.teamMatchEncounters(matchId, members, signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      warnings.add(`对局 ${matchId}：${apiErrorMessage(error)}`);
      update();
      continue;
    }
    samples.push(sample);
    lookups.push({
      season: sample.season,
      mode: sample.game_mode,
      type: sample.match_type,
      ids: Object.values(sample.opponents).flat(),
    });
    update();
  }
  await loadProfiles(lookups, signal, request, stats, mastery, warnings, cacheHits, update);
}

export function memberOpponents(report: TeamComparison, member: string) {
  return report.samples.flatMap((sample) => {
    const group = profileGroup(sample.season, sample.game_mode, sample.match_type);
    return sample.opponents[member].map((id) => ({
      id,
      stats: report.stats[`${group}/${id}`],
      mastery: report.mastery[id],
    }));
  });
}

export function median(values: number[]) {
  if (!values.length) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return ((sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2).toFixed(2);
}

export const kdBands = [
  { label: "< 1", color: "bg-teal-300" },
  { label: "1 – < 2", color: "bg-sky-300" },
  { label: "2 – < 3", color: "bg-amber-300" },
  { label: "≥ 3", color: "bg-rose-300" },
];

export function kdBandIndex(value: number) {
  return value < 1 ? 0 : value < 2 ? 1 : value < 3 ? 2 : 3;
}

export function teamOpponentDistribution(report: TeamComparison) {
  const kd = kdBands.map((band) => ({ ...band, count: 0 }));
  const levels = new Map<string, { tier: number; start: number; count: number }>();
  let total = 0;
  for (const sample of report.samples) {
    const group = profileGroup(sample.season, sample.game_mode, sample.match_type);
    const opponents = new Set(Object.values(sample.opponents).flat());
    total += opponents.size;
    for (const id of opponents) {
      const value = report.stats[`${group}/${id}`]?.kd;
      if (value != null) kd[kdBandIndex(value)].count++;
      const mastery = report.mastery[id];
      if (mastery?.tier == null || mastery.level == null) continue;
      const start = Math.floor(mastery.level / 100) * 100;
      const key = `${mastery.tier}/${start}`;
      const band = levels.get(key) ?? { tier: mastery.tier, start, count: 0 };
      band.count++;
      levels.set(key, band);
    }
  }
  const levelBands = [...levels.values()]
    .sort((a, b) => a.tier - b.tier || a.start - b.start);
  return { kd, levels: levelBands, total };
}
