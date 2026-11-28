# 战队强度 API（v1）

基址 `/api/opponents/team-days`。`POST /view` 接受 `ViewRequest`，返回 `View`；`POST /ensure` 接受 `EnsureRequest`，返回 `FillJob`；`GET /fills/{job_id}`、`POST /fills/{job_id}/cancel` 均无请求体，返回 `FillJob`。任务 ID 不存在返回 404，参数错误返回 422。接口不使用前端提供的对手列表。

```ts
type DayString = string; // YYYY-MM-DD，北京时间
type Metric = number | null; // 无有效样本是 null；0 是已知的真实零值
type Counts = Record<string, number>;
type Mode = 'duo' | 'duo-fpp' | 'squad' | 'squad-fpp';
interface Player { player_id: string; player_name: string }
interface Binding extends Player { is_active: boolean }
interface Selection {
  player_ids?: string[] | null; // 若提供：1~4 个不重复 account.*；否则按绑定选择
  require_all?: boolean; // 默认 false：至少 2 名所选成员同队；true：须全员同队。单人均只需本人
  include_random_teammates?: boolean; // 默认 false；只扩展交手对手识别范围
}
interface ViewRequest extends Selection {
  dates?: DayString[] | null; // 1~7 个不重复日期；保留传入顺序，优先于 A/B
  date_a?: DayString | null; date_b?: DayString | null;
  trend_limit?: number; // 1~366，默认 30 个有共同局的日期
}
interface EnsureRequest extends Selection { dates: DayString[]; manual_continue?: boolean } // 1~7 项，按日期去重处理（兼容规则见下）
interface Summary {
  date: DayString; match_count: number; first_match_at: string; last_match_at: string;
  contacts_count: number; unique_opponents: number; enemy_teams: number;
  maps: Counts; modes: Counts; normal_matches: number; ranked_matches: number;
  wins: number; top3: number;
}
interface Profiles {
  total_contacts: number; known_kd: number; known_adr: number;
  kd_p25: Metric; kd_p50: Metric; kd_p75: Metric;
  kd_ge_2_count: number; kd_ge_2_rate: Metric; kd_ge_3_count: number; kd_ge_3_rate: Metric;
  kd_bands: { label: '<1'|'1–2'|'2–3'|'≥3'; count: number }[];
  adr_p50: Metric; adr_p75: Metric; observed_min_at: Metric; observed_max_at: Metric;
  missing_fillable_count: number; unfillable_count: number;
}
interface Pressure {
  opponent_damage_p50: Metric; opponent_damage_p75: Metric; opponent_avg_kills: Metric;
  high_firepower_teams: number; high_firepower_team_total: number; high_firepower_team_rate: Metric;
  team_kills_vs_humans: number; team_deaths_to_humans: number;
  team_damage_taken_per_match: Metric; team_damage_dealt_per_match: Metric;
}
interface Lobby {
  total_players: number; human_count: number; bot_count: number; unknown_count: number;
  bot_rate: Metric; lobby_damage_p50: Metric; lobby_damage_p75: Metric;
}
interface Member extends Player {
  match_count: number; kills: number; knocks: number; deaths: number; damage: Metric;
  avg_rank: Metric; wins: number; top3: number;
}
interface Match {
  match_id: string; created_at: string; map_name: string; game_mode: Mode;
  match_type: string | null; team_rank: Metric; kills: number; damage: Metric; players: Player[];
}
interface Opponent extends Player {
  encounters: number; kd: Metric; adr: Metric; match_damage_avg: Metric; match_kills_total: number;
  observed_at: Metric; profile_status: 'known'|'partial'|'missing'|'unfillable';
}
interface Day {
  summary: Summary; profiles: Profiles; pressure: Pressure; lobby: Lobby;
  data_quality: { damage_ready_matches: number; missing_damage_matches: number;
    missing_season_matches: number; season_backfill_pending: boolean };
  team_performance: {members: Member[]; matches: Match[]}; opponents_detail: Opponent[];
  from_disk_cache: boolean;
}
interface Trend {
  date: DayString; match_count: number; contacts_count: number; unique_opponents: number;
  kd_p50: Metric; kd_known: number; kd_total: number; adr_p50: Metric; opponent_damage_p50: Metric;
  team_damage_taken_per_match: Metric; bot_rate: Metric; maps: Counts; from_disk_cache: boolean;
}
interface FillJob {
  job_id: string | null;
  state: 'queued'|'running'|'paused'|'completed'|'budget_exhausted'|'cancelled'|'no_api_key'
       | 'auth_error'|'failed'|'busy'|'disabled';
  revision: number; requests_used: number; request_budget: number;
  promoted: number; remaining: number; retry_after: number;
}
interface View {
  timezone: 'Asia/Shanghai'; bindings: Binding[]; selected_player_ids: string[]; selection_warning: string|null;
  require_all: boolean; min_members: number; // 请求的全员开关、实际同队人数门槛（未选人时为 0）
  available_dates: DayString[]; selected_dates: DayString[]; days: Day[];
  date_a: DayString|null; date_b: DayString|null; day_a: Day|null; day_b: Day|null;
  trend: Trend[]; warnings: {code:'SAME_DAY'|'SMALL_SAMPLE'|'NO_MAP_OVERLAP'|'MODE_MIX_DIFFERS'
    |'LOW_COVERAGE'|'MISSING_SEASON'; message:string}[];
  fill_hint: { api_key_configured: boolean; missing_fillable_total: number;
    missing_fillable_a: number; missing_fillable_b: number;
    cache_promotable: number; estimated_requests: number; active_job: FillJob|null };
  cache_stats: {hit_days: number; computed_days: number};
}
```

- 选日：优先使用 `dates`；否则若指定 A/B，沿用旧逻辑（缺 A 用最近日，缺 B 用最近的非 A 日）；三者均未指定时选最近最多四个有共同局的日期。`selected_dates` 记录所选日期，`days` 按同一顺序给出完整单日数据，跳过无共同局的日期。例如 `dates: ["2026-08-03", "2026-08-02", "2026-08-01"]` 中第二日无局时，`days` 仅含 3 日和 1 日，`date_b` 仍为 2 日且 `day_b` 为 `null`。A/B 兼容字段通常对应前两项；旧请求只指定 B 且无可用默认日时，A 仍为 `null`。
- 告警：至少两份单日数据才比较地图交集（`NO_MAP_OVERLAP`）及排位/模式占比（`MODE_MIX_DIFFERS`）。任一天场次不足、KD 覆盖偏低或缺赛季，均返回相应提示；`SAME_DAY` 仅用于显式指定相同 A/B 的旧请求。
- 时间：`*_at` 中的**快照观察时间**为 Unix 秒，不代表比赛时间；`created_at`、`first_match_at`、`last_match_at` 为比赛原始时间字符串。`available_dates` 倒序，`trend` 正序且独立于选中日期；`cache_stats` 按 `days` 与 `trend` 涉及的**不同日期**计数。
- 选局：`view` 和 `ensure` 使用同一人数门槛。例如选了三人，默认纳入其中任意两人或三人同队的局；`require_all: true` 只纳入三人齐的局。若一局中两队均达标，只取所选成员最多的队，同数取 `team_id` 升序第一队。出战场次、逐局名单和成员表现只统计实际在该队出场的所选成员。
- 样本：每局每个交手真人最多一次；同一人在两局交手则权重为二。KD 门槛占比基于已知 KD，线性插值计算分位数；所有率为 0~1。`opponents_detail` 的 KD/ADR 是该日该对手有效交手样本的平均值。`missing_fillable_count` 是有赛季键、缺冻结档案的**人次**，而缓存晋升、`promoted`、`remaining` 按去重快照键计。负缓存不冻结、未过期不请求。
- 火力统计使用交手真人整局对异队（包括 Bot）的输出；成员正面承压只含所选成员对异队真人。高火力分母为有可用伤害数据的交手敌队人队次（局 × 敌队）。缺伤害的局不当作零伤害；大厅总人口按 roster，Bot 占比基于总人口，包含未知类型。
- 补齐范围：`fill_hint.missing_fillable_total` 是 `days` 各项缺档**人次**之和；A/B 计数仍单独返回。`cache_promotable`、`estimated_requests`、`active_job` 按全部选中日期计算；仅出现在趋势中的日期不计入。全部选中日的缺赛季局均提交给本地赛季回填优先处理。
- 推荐先 `view`；若 `selected_dates` 非空，将其作为 `dates` 调用一次 `ensure`。`ensure` 接受 1~7 项，合并重复日期；为保持旧校验行为，只传同一天时超过两项仍返回 422。批次保留同资源合并请求的能力，按批内最新比赛日期降序补齐，使最近日期优先使用每任务的 25 次请求预算。如有晋升立即重新读取 view。存在 job_id 可轮询，`revision` 改变就重读 view；`paused.retry_after` 是剩余秒，可取消。`busy` 表示其它视图占用单工作槽；`budget_exhausted` 仅用户显式继续时设置 `manual_continue:true`。`completed`（包括无缺档/无需上游）不保证每个账号在 PUBG 有战绩；`remaining` 包含缺失但命中短期负缓存的键。无 Key 且仍缺档返回 `no_api_key`。任务状态是本进程内最近 64 个任务，快照和日汇总才持久化。
- 本地赛季回填异步进行，不下载遥测。`season_backfill_pending` 表示还有未检查的缺赛季局，不表示远程补齐在进行。永久快照是首次有效观测；不会对过去日期伪造历史赛季战绩，也不自动查询等级。
