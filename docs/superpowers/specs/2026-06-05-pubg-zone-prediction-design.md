# PUBG 圈型预测与宏观转移路线工具设计

日期：2026-06-05  
状态：规格评审通过，等待用户审阅  
项目形态：全新本地单机 Web 项目

## 1. 背景与目标

本项目是一个全新的 PUBG 圈型预测与战队宏观转移路线工具。它参考当前 `pubg-circle-analyzer` 的数据获取思路，但不在旧项目中继续扩展，也不依赖旧项目 MySQL 表结构。

第一版目标是构建一个本地运行的 Web 可视化工具，用于赛前分析和复盘：用户在地图上选择当前局势，系统根据历史赛事数据预测下一个圈和最终决赛圈位置，并根据路线策略与历史玩家热点生成战队宏观转移路线。

核心目标：

1. 通过 PUBG API 采集 Esport / Tournament 比赛数据。
2. 解析 telemetry 中的圈阶段数据与玩家/队伍轨迹数据。
3. 将数据保存到本地 SQLite。
4. 手动触发模型训练，并用中心误差评估预测效果。
5. 在 Web 地图上输入当前 Zone、当前圈中心、战队当前区域和路线策略。
6. 输出预测下一圈、预测最终圈、推荐宏观路线、历史热点 overlay 和解释文本。

## 2. 已确认决策

| 主题 | 决策 |
|---|---|
| 产品形态 | Web 可视化工具 |
| 使用场景 | 赛前 / 复盘 |
| 项目关系 | 全新项目，参考当前项目的数据获取方式，不复用旧项目结构 |
| 部署方式 | 本地单机 |
| 技术栈 | FastAPI + React |
| 数据库 | 本地 SQLite |
| 数据采集 | 新项目直接从 PUBG API 采集 Esport / Tournament 数据 |
| 用户输入 | 地图、当前 Zone、当前圈中心、战队当前区域、路线策略 |
| 当前圈半径 | 用户不输入，系统根据当前 Zone 阶段配置推断 |
| 预测范围 | 支持任意当前 Zone 1-7，预测下一圈和最终决赛圈 |
| 预测输出 | 单一推荐结果 |
| 预测方法 | 统计基线 + 传统 ML 修正，可考虑 AI 解释，但不让 LLM 预测坐标 |
| 路线对象 | 战队宏观路线，不做单个玩家微操路线 |
| 路线策略 | 贴边进圈、抢中心、慢进圈、绕路避战 |
| 热点来源 | 基于真实玩家/队伍轨迹数据生成历史活动热点 |
| LLM 解释层 | OpenAI-compatible 接口，可选启用；失败时规则解释降级 |
| 地图资产 | 运行时从官方 `pubg/api-assets` 下载到本地缓存，不写死本地路径 |

## 3. 非目标

第一版不做：

- 实时比赛中自动决策。
- 单个玩家微操路线。
- 建筑、道路、桥梁、水域级真实寻路。
- 强化学习或深度学习路线策略。
- 用户账号、多用户权限。
- 云端部署和团队协作。
- 自动持续训练。
- 直接让 LLM 预测坐标。
- 完整战斗胜率预测。
- 赛事直播数据实时接入。

## 4. 总体架构

系统采用本地单机架构：

```text
React 前端
  ↓
FastAPI 后端
  ├─ PUBG API 采集器
  ├─ Telemetry Parser
  ├─ SQLite Repository
  ├─ Asset Manager
  ├─ 预测训练服务
  ├─ 热点统计服务
  ├─ 路线策略引擎
  └─ Explanation Service
       ├─ OpenAI-compatible Provider
       └─ Rule-based Fallback
```

架构原则：

- 坐标预测由统计/ML 模型负责，避免 LLM 幻觉影响结果。
- LLM 只生成自然语言复盘解释和路线理由。
- 所有核心数据默认保存在本地 SQLite。
- 地图、Zone 半径、策略权重、资产路径都做成配置。
- 前端只通过 FastAPI 读取地图资源和预测结果，不直接访问外部 GitHub 或 PUBG API。

## 5. 数据采集设计

### 5.1 数据来源

第一版优先支持 Esport / Tournament 数据。

采集流程：

```text
Tournament ID / 官方赛事列表
  → Tournament match 列表
  → Match info
  → Telemetry URL
  → 下载 telemetry
  → 解析圈阶段 + 玩家轨迹
  → 写入 SQLite
```

### 5.2 PUBG API 配置

后端通过本地配置或环境变量读取 PUBG API Key，例如：

```text
PUBG_API_KEY=...
```

API Key 不进入前端，不写入日志，不传给 LLM。

### 5.3 Telemetry 解析范围

第一版解析两类核心事件。

#### 圈阶段数据

主要解析 `LogGameStatePeriodic`。

保存字段包括：

- match_id
- map_name
- phase / isGame
- elapsed_time
- num_alive_teams
- num_alive_players
- poison_gas_warning_position_x
- poison_gas_warning_position_y
- poison_gas_warning_radius

每局每个阶段保留关键圈状态，用于构造训练样本。

#### 玩家/队伍轨迹数据

解析玩家位置事件，例如 `LogPlayerPosition`。具体事件名和字段以实际 telemetry 为准，parser 需要做版本容错。

保存字段包括：

- match_id
- player_id / player_name
- team_id，通过 roster/participant 解析补齐；若 telemetry 缺失队伍信息，使用 match 级 `unknown` 队伍降级
- elapsed_time
- phase
- x
- y
- z，可选
- alive 状态，可选

为了控制 SQLite 体积，位置轨迹需要按时间间隔降采样。第一版默认使用固定采样间隔，例如每 5 秒保留一次位置，并将采样时间落到 `elapsed_time_bucket`。同一 `match_id + player_id + elapsed_time_bucket` 只保存一条位置样本。

击杀、死亡、淘汰等事件可进入 `player_life_events`，作为热点加权信号；但第一版热点核心仍以位置密度为主。

#### 队伍关系解析与降级

由于路线对象是战队宏观路线，parser 必须尽量从 telemetry 或 match 参与者信息中构造 `match_teams` 与 `match_rosters`：

- 如果事件中能取得 team_id，则按真实 team_id 写入。
- 如果只有 player_id/player_name，则仍写入 `match_rosters`，team_id 使用该 match 的 `unknown` team。
- 热点统计优先按真实 team 聚合；缺失 team_id 时按 player 聚合后归入 unknown team。
- UI 的“战队当前区域”是用户手动选择的宏观位置，不要求绑定某支历史队伍；历史 team 关系只用于生成热点和解释风险。

## 6. SQLite 数据模型

核心表建议如下。

### 6.1 采集元数据

#### `tournaments`

保存赛事元数据。

关键字段：

- id
- type
- created_at
- source
- fetched_at

#### `matches`

保存比赛元数据。

关键字段：

- match_id
- tournament_id
- map_name
- shard_id
- game_mode
- match_type
- created_at
- duration
- telemetry_url
- ingest_status
- error_message

#### `telemetry_assets`

保存 telemetry 下载状态和可选本地缓存信息。

关键字段：

- match_id
- telemetry_url
- cache_path，可选
- content_hash，可选
- downloaded_at
- parse_status
- error_message

#### `ingest_jobs`

保存采集任务状态，供前端展示进度、失败原因和重试入口。

关键字段：

- id
- job_type：`tournament_list`、`tournament_matches`、`telemetry_download`、`telemetry_parse`
- status：`pending`、`running`、`completed`、`failed`、`cancelled`
- source_ref：tournament_id、match_id 或批次标识
- total_count
- success_count
- skipped_count
- failed_count
- retry_count
- started_at
- finished_at
- error_code
- error_message

### 6.2 训练样本数据

#### `match_teams`

保存单场比赛中的队伍/阵营关系，用于把玩家轨迹聚合成战队宏观热点。

关键字段：

- match_id
- team_id
- team_rank，可选
- is_unknown：当 telemetry 无法提供队伍关系时为 true

唯一键：`match_id + team_id`。

#### `match_rosters`

保存比赛内 team 与 player 的归属关系。

关键字段：

- match_id
- team_id
- player_id
- player_name

唯一键：`match_id + player_id`。如果无法解析真实 team_id，必须写入该 match 的 `unknown` team，确保后续热点聚合和路线解释有确定降级路径。

#### `circle_phases`

保存每局每个 Zone 阶段的圈状态。

唯一键：`match_id + phase`。parser 需要在同一 phase 出现多条 `LogGameStatePeriodic` 时选择确定性样本：优先保存该 phase 首次出现的有效圈状态；若首次样本缺字段，则使用该 phase 后续第一条完整样本。该规则保证重复解析幂等。

关键字段：

- match_id
- phase
- elapsed_time
- center_x
- center_y
- radius
- num_alive_teams
- num_alive_players

#### `player_position_samples`

保存玩家位置采样点。

唯一键：`match_id + player_id + elapsed_time_bucket`。`elapsed_time_bucket = floor(elapsed_time / sample_interval_seconds) * sample_interval_seconds`，默认采样间隔为 5 秒。

关键字段：

- match_id
- player_id
- team_id
- phase
- elapsed_time
- elapsed_time_bucket
- x
- y
- z
- alive

#### `player_life_events`

保存死亡、击杀、淘汰等事件。

关键字段：

- match_id
- elapsed_time
- phase
- event_type
- actor_player_id
- victim_player_id
- x
- y

### 6.3 派生数据

#### `hotspot_tiles`

保存玩家活动热点网格。

关键字段：

- map_id
- phase
- tile_x
- tile_y
- density_score
- kill_death_score
- sample_count
- generated_from_model_run_id 或 generated_at

#### `model_runs`

保存模型训练版本。

关键字段：

- id
- created_at
- maps_included
- phases_included
- sample_count
- algorithm
- model_path，可选
- status

#### `model_metrics`

保存模型中心误差评估结果。

关键字段：

- model_run_id
- map_id
- current_phase
- target_type：`next` 或 `final`
- sample_count
- mean_center_error
- median_center_error
- p90_center_error，可选

#### 数据库约束原则

第一版实现计划必须给出完整 DDL。最低约束要求：

| 表 | 主键 | 唯一键 / 索引 |
|---|---|---|
| `tournaments` | `id` | `type + created_at` 可建查询索引 |
| `matches` | `match_id` | `tournament_id + created_at`、`map_name + created_at` 查询索引 |
| `telemetry_assets` | `match_id` | `telemetry_url` 可选唯一索引 |
| `ingest_jobs` | `id` | `status + started_at` 查询索引 |
| `match_teams` | `id` 或复合主键 | `match_id + team_id` 唯一 |
| `match_rosters` | `id` 或复合主键 | `match_id + player_id` 唯一 |
| `circle_phases` | `id` 或复合主键 | `match_id + phase` 唯一 |
| `player_position_samples` | `id` | `match_id + player_id + elapsed_time_bucket` 唯一 |
| `player_life_events` | `id` | `match_id + elapsed_time + event_type + actor_player_id + victim_player_id` 去重索引 |
| `hotspot_tiles` | `id` | `map_id + phase + grid_size + tile_x + tile_y + generated_at/model_run_id` 查询索引 |
| `model_runs` | `id` | `created_at + status` 查询索引 |
| `model_metrics` | `id` | `model_run_id + map_id + current_phase + target_type` 唯一 |

其他约束：

- 所有表必须有主键。
- `matches.tournament_id` 外键指向 `tournaments.id`，允许为空以支持手动 match 导入的后续扩展。
- `telemetry_assets.match_id`、`circle_phases.match_id`、`player_position_samples.match_id`、`player_life_events.match_id` 外键指向 `matches.match_id`。
- `match_teams.match_id` 和 `match_rosters.match_id` 外键指向 `matches.match_id`。
- 派生表必须记录生成时间或来源模型/任务 ID。
- 重复采集时使用唯一键做 `insert or ignore` / upsert，不能产生重复训练样本。

## 7. 地图资产管理设计

### 7.1 官方资产来源

地图资源来自官方仓库：

```text
https://github.com/pubg/api-assets.git
```

第一版不要求用户提前 clone，也不写死任何本地路径。

### 7.2 本地缓存目录

默认缓存目录：

```text
./data/assets/pubg-api-assets/
```

可通过环境变量覆盖：

```text
PUBG_ASSETS_CACHE_DIR=/custom/path
```

### 7.3 下载策略

采用按需下载：

1. 用户选择某张地图。
2. 后端检查本地缓存是否已有有效地图图片。
3. 如果缺失，从官方 GitHub 下载对应资源。
4. 校验 PNG 是否有效。
5. 校验通过后保存到缓存目录。
6. 前端通过 FastAPI 提供的本地资源 URL 加载图片。

默认优先使用：

```text
Assets/Maps/<Map>_Main_No_Text_Low_Res.png
```

原因：

- 文件小，适合本地 MVP。
- No Text 版本更适合作战术 overlay。
- 不依赖 Git LFS。

High Res 可作为后续增强。High Res 文件在官方仓库中可能由 Git LFS 管理，因此下载后必须校验是否为真实 PNG，而不是 LFS pointer。

### 7.4 资源校验

Asset Manager 需要校验：

- PNG 文件头。
- 文件大小不能异常过小，例如 133/134 bytes 的 LFS pointer。
- 图片可被后端图像库或前端正常读取。

校验失败时：

1. 删除坏缓存。
2. 重试下载。
3. 如果 High Res 失败，自动降级到 Low Res。
4. 如果 Low Res 也失败，API 返回明确错误，前端提示用户重试。

### 7.5 地图配置

地图配置不保存绝对路径，只保存官方仓库相对路径。

示例：

```yaml
maps:
  erangel:
    display_name: Erangel
    telemetry_names:
      - Baltic_Main
      - Erangel_Main
    world_size: 816000
    coordinate:
      min_x: 0
      min_y: 0
      max_x: 816000
      max_y: 816000
      y_axis: down
    assets:
      no_text_low: Assets/Maps/Erangel_Main_No_Text_Low_Res.png
      low: Assets/Maps/Erangel_Main_Low_Res.png
      no_text_high: Assets/Maps/Erangel_Main_No_Text_High_Res.png
      high: Assets/Maps/Erangel_Main_High_Res.png
```

### 7.6 坐标转换

坐标统一从 PUBG 世界坐标转换为地图归一化坐标，再转换为前端像素坐标。第一版坐标约定如下：

- PUBG telemetry 坐标按地图配置中的 `min_x/min_y/max_x/max_y` 归一化。
- 默认官方地图采用左上角为 `(0, 0)`，x 向右，y 向下。
- 如果后续发现某张地图存在不同原点或轴向，需要在地图配置中覆盖，而不是写死在转换函数里。
- 用户点击地图时，需要支持反向转换：像素坐标 → 归一化坐标 → PUBG 世界坐标。
- 所有坐标转换都必须做边界夹持，超出地图范围的输入返回 400 校验错误或被显式 clamp，不能静默生成错误 overlay。

正向转换：

```text
normalized_x = (pubg_x - min_x) / (max_x - min_x)
normalized_y = (pubg_y - min_y) / (max_y - min_y)
normalized_x = clamp(normalized_x, 0, 1)
normalized_y = clamp(normalized_y, 0, 1)
pixel_x = normalized_x * rendered_image_width
pixel_y = normalized_y * rendered_image_height
```

反向转换：

```text
normalized_x = pixel_x / rendered_image_width
normalized_y = pixel_y / rendered_image_height
pubg_x = min_x + normalized_x * (max_x - min_x)
pubg_y = min_y + normalized_y * (max_y - min_y)
```

新项目不应绑定固定 `WINDOW_SIZE`。图片原始尺寸和前端渲染尺寸都可能变化。

## 8. Zone 阶段配置设计

Zone 阶段配置是当前圈半径推断、预测半径返回、路线评分和前端 overlay 的统一来源。第一版可以使用版本化 YAML 配置，也可以在应用启动时同步到 SQLite；但运行时只能通过一个配置服务读取，不能在前端、训练代码和路线引擎中各自写死。

### 8.1 配置字段

每条配置至少包含：

- map_id
- game_mode，例如 `squad-fpp`，第一版默认可使用 `default`
- phase：1-8
- radius：PUBG 世界单位
- label，例如 `Zone 3`
- is_final_candidate：是否可作为最终圈候选
- enabled
- config_version

地图级配置还需要包含：

- final_phase：默认 8
- supported_prediction_phases：默认 `[1, 2, 3, 4, 5, 6, 7]`
- effective_from，可选

示例：

```yaml
zone_phase_config:
  version: "mvp-1"
  defaults:
    final_phase: 8
    supported_prediction_phases: [1, 2, 3, 4, 5, 6, 7]
  maps:
    erangel:
      game_modes:
        default:
          phases:
            1: { radius: 400000, label: "Zone 1", enabled: true }
            2: { radius: 230000, label: "Zone 2", enabled: true }
            3: { radius: 120000, label: "Zone 3", enabled: true }
            4: { radius: 67000, label: "Zone 4", enabled: true }
            5: { radius: 40000, label: "Zone 5", enabled: true }
            6: { radius: 23000, label: "Zone 6", enabled: true }
            7: { radius: 12000, label: "Zone 7", enabled: true }
            8: { radius: 7700, label: "Final", enabled: true, is_final_candidate: true }
```

以上半径值是 MVP 初始配置示例，最终实现前需要用 PUBG 规则或历史 telemetry 校准。若 telemetry 中提供的 `poisonGasWarningRadius` 与配置不同，训练样本保留真实 telemetry 半径；用户输入和预测输出默认使用配置半径。

### 8.2 API 返回 schema

`GET /api/config/zone-phases?map_id=erangel&game_mode=default` 返回：

```json
{
  "map_id": "erangel",
  "game_mode": "default",
  "config_version": "mvp-1",
  "final_phase": 8,
  "supported_prediction_phases": [1, 2, 3, 4, 5, 6, 7],
  "phases": [
    {"phase": 1, "radius": 400000, "label": "Zone 1", "enabled": true},
    {"phase": 8, "radius": 7700, "label": "Final", "enabled": true, "is_final_candidate": true}
  ]
}
```

校验规则：

- `current_phase` 必须在 `supported_prediction_phases` 中。
- `next_phase = current_phase + 1`，但不得超过 `final_phase`。
- `final_circle.phase = final_phase`。
- 若 map/game_mode 未配置，API 返回 400，并提示前端该地图/模式暂不支持预测。

## 9. 预测模型设计

### 9.1 输入与输出

输入：

- map_id
- current_phase：Zone 1-7
- current_circle_center_x
- current_circle_center_y
- team_area_x
- team_area_y
- route_strategy

输出：

- next_circle：center_x, center_y, radius, phase
- final_circle：center_x, center_y, radius, phase
- route：polyline points
- hotspot summary
- explanation

### 9.2 半径推断

用户不输入半径。当前圈、下一圈、最终圈半径均由 `zone_phase_config` 推断。

默认最终圈可以配置为 Zone 8。后续如不同模式有不同终局定义，应由配置覆盖。

### 9.3 模型方法

第一版采用：

```text
统计基线 + 传统 ML 修正
```

统计基线：

- 按地图和当前 Zone 查询历史样本。
- 根据当前圈中心寻找相似历史局面。
- 计算下一圈和最终圈的平均偏移或加权偏移。

传统 ML 修正：

- 可从 KNN、RandomForest、Gradient Boosting 等可解释模型开始。
- 特征包括地图、当前 Zone、当前中心归一化坐标、当前中心到地图边界/中心的关系等。
- 目标是下一圈中心和最终圈中心。

如果样本不足或模型不可用，必须降级到统计基线。

### 9.4 训练方式

训练由用户手动触发。

流程：

```text
用户点击重新训练
  → 后端读取 circle_phases
  → 构造训练样本
  → 切分训练/验证集
  → 训练统计基线和 ML 模型
  → 写入 model_runs
  → 写入 model_metrics
```

### 9.5 评估指标

第一版使用中心误差：

- 下一圈预测中心误差。
- 最终圈预测中心误差。

按地图、当前 Zone、目标类型统计：

- sample_count
- mean_center_error
- median_center_error
- p90_center_error，可选

## 10. 热点统计设计

热点基于真实玩家/队伍轨迹，不使用圈密度代理。

流程：

```text
player_position_samples
  → 按地图 + Zone + 时间窗口过滤
  → 聚合到 tile 网格
  → 按 match/team 归一化
  → 生成 hotspot_tiles
```

第一版建议网格粒度：

- 默认 `64x64`。
- 后续可配置为 `128x128`。

归一化与评分规则：

- 默认时间窗口为当前 Zone 的全阶段窗口：从该 phase 首次出现到下一 phase 首次出现；若缺少下一 phase，则使用该 match 结束前该 phase 内全部采样。
- 支持可选滚动窗口，例如当前预测时刻前后 `N` 秒；MVP UI 先不暴露该选项。
- 每个 match 的贡献先按队伍归一化：同一 `match_id + team_id` 在同一 tile 内最多贡献 1 个单位密度，避免长时间停留或高频采样放大。
- `density_score = normalized_team_visits / max_tile_visits`，范围 0-1。
- `kill_death_score` 可按击杀/死亡事件数量归一化到 0-1，MVP 路线评分中权重低于位置密度。
- 默认综合热点分数：`hotspot_score = 0.8 * density_score + 0.2 * kill_death_score`。
- 样本不足时，例如有效 match 数少于 10 或有效队伍数少于 30，API 返回空热点或低置信度热点，并在 `warnings` 中提示。
- 可对 tile 分数做轻量平滑，例如邻域 3x3 均值，避免单个 tile 尖峰导致路线过度绕行。

归一化原则：

- 避免单场比赛采样频率过高导致热点偏移。
- 避免单支队伍长时间停留导致密度异常放大。
- 击杀/死亡事件只作为额外权重，不作为唯一依据。

热点用途：

- 地图 overlay 显示高活动区域。
- 绕路避战策略中，对经过高热度 tile 的路线增加惩罚。
- LLM 或规则解释中说明路线为何绕开某些区域。

## 11. 路线策略设计

第一版路线是战队宏观路线，不做真实道路级寻路。

路线输入：

- 战队当前区域。
- 当前圈。
- 预测下一圈。
- 预测最终圈。
- 历史热点网格。
- 策略类型。

路线输出：

- polyline 点列。
- 目标点。
- 中间停留点，可选。
- route_score。
- risk_summary。

### 11.1 贴边进圈

目标点偏向预测安全区边缘，降低多方向暴露。

评分偏好：

- 距离适中。
- 靠近预测圈边缘。
- 热点惩罚中等。

### 11.2 抢中心

目标点靠近预测圈中心，争取后续圈位优势。

评分偏好：

- 接近预测下一圈中心。
- 更低最终圈距离。
- 可接受更高热点风险。

### 11.3 慢进圈

先向短暂停留点移动，再进入预测安全区。

评分偏好：

- 先选择当前圈内或边缘观察点。
- 路线分成两段。
- 适合复盘“等信息再动”的运营思路。

### 11.4 绕路避战

根据历史热点选择低热度走廊。

评分偏好：

- 对高热点 tile 强惩罚。
- 允许路线更长。
- 目标仍需能进入预测安全区。

## 12. Web 界面设计

第一版采用地图优先布局。

左侧大地图：

- 官方地图底图。
- 当前圈 overlay。
- 预测下一圈 overlay。
- 预测最终圈 overlay。
- 历史热点 heatmap overlay。
- 推荐路线 polyline overlay。

右侧控制面板：

- 地图选择。
- 当前 Zone 选择：1-7。
- 当前圈中心：通过地图点击设置。
- 战队当前区域：通过地图点击设置。
- 路线策略切换。
- 预测结果摘要。
- 解释文本。

地图交互：

- 用户点击当前圈中心。
- 用户点击战队当前区域。
- 用户选择当前 Zone。
- 系统自动推断当前圈半径。
- 用户点击预测按钮后刷新 overlay。

## 13. FastAPI API 设计

### 13.1 `/api/config`

用途：地图配置、Zone 半径、策略权重、LLM 配置状态。

示例端点：

- `GET /api/config/maps`
- `GET /api/config/zone-phases`
- `GET /api/config/llm-status`

### 13.2 `/api/assets`

用途：地图资源下载、缓存和服务。

示例端点：

- `GET /api/assets/maps/{map_id}`：返回地图资源元数据和图片 URL。
- `POST /api/assets/maps/{map_id}/ensure`：确保地图资源已下载并校验。
- `GET /api/assets/maps/{map_id}/image`：返回本地缓存图片。

### 13.3 `/api/ingest`

用途：采集 tournament、match、telemetry。

示例端点：

- `POST /api/ingest/tournaments`
- `POST /api/ingest/tournaments/{tournament_id}`
- `GET /api/ingest/jobs/{job_id}`
- `POST /api/ingest/jobs/{job_id}/retry`

`GET /api/ingest/jobs/{job_id}` 返回 schema：

```json
{
  "id": "job_...",
  "job_type": "tournament_matches",
  "status": "running",
  "source_ref": "tournament-id",
  "total_count": 100,
  "success_count": 72,
  "skipped_count": 10,
  "failed_count": 2,
  "retry_count": 0,
  "started_at": "2026-06-05T12:00:00Z",
  "finished_at": null,
  "error_code": null,
  "error_message": null,
  "warnings": []
}
```

状态生命周期：

```text
pending → running → completed
                  ↘ failed
                  ↘ cancelled
```

局部失败不一定让 job 失败：如果部分 match 采集失败但任务可继续，job 可以是 `completed`，并在 `failed_count` 与 `warnings` 中呈现可重试项。

### 13.4 `/api/training`

用途：手动触发训练、查看模型版本与指标。

示例端点：

- `POST /api/training/runs`
- `GET /api/training/runs`
- `GET /api/training/runs/{run_id}`
- `GET /api/training/metrics`

### 13.5 `/api/predict`

用途：执行圈型预测、路线生成和解释生成。

输入字段：

- map_id
- current_phase
- current_circle_center
- team_area
- route_strategy
- use_llm_explanation，可选

输出字段：

- next_circle
- final_circle
- route
- hotspot_summary
- explanation
- model_run_id
- warnings

### 13.6 `/api/hotspots`

用途：获取地图和 Zone 对应历史热点。

示例端点：

- `GET /api/hotspots?map_id=erangel&phase=3`

### 13.7 API 错误与校验约定

所有 API 返回应使用统一错误结构：

```json
{
  "error": {
    "code": "INVALID_PHASE",
    "message": "current_phase must be one of [1,2,3,4,5,6,7]",
    "details": {}
  }
}
```

最低校验要求：

- `map_id` 不存在或未配置时返回 400 `UNSUPPORTED_MAP`。
- `current_phase` 不在 Zone 配置允许范围时返回 400 `INVALID_PHASE`。
- 地图点击坐标超出范围时返回 400 `COORDINATE_OUT_OF_RANGE`；如果采用 clamp，响应必须在 `warnings` 中说明。
- 无可用训练样本时，`/api/predict` 返回统计兜底结果或 409 `MODEL_NOT_READY`，并给出前端可展示提示。
- 地图资源不可下载且无本地缓存时，`/api/assets` 返回 503 `ASSET_UNAVAILABLE`。
- LLM 失败不导致 `/api/predict` 失败；响应中的 `explanation.source` 应为 `rule_fallback`，并在 `warnings` 中说明。

## 14. LLM 解释层设计

LLM 解释层采用 OpenAI-compatible 接口。

### 14.1 配置项

配置项：

- `LLM_ENABLED`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TIMEOUT_SECONDS`

API Key 只能在后端读取，不进入前端，不写入 prompt，不写入日志。

### 14.2 输入边界

发送给 LLM 的内容只包含：

- 当前局势摘要。
- 预测下一圈摘要。
- 预测最终圈摘要。
- 路线策略摘要。
- 热点风险摘要。
- 模型评估摘要，例如当前地图/Zone 的中心误差。

LLM 不接收 API Key、数据库路径、系统内部错误堆栈或用户敏感配置。

### 14.3 输出边界

LLM 输出只作为解释文本：

- 预测原因。
- 路线推荐理由。
- 风险提示。
- 复盘建议。

LLM 不直接决定坐标、路线点、数据库写入或采集训练行为。

### 14.4 降级策略

以下情况自动降级为规则解释：

- 未配置 LLM。
- API Key 缺失。
- 请求超时。
- 鉴权失败。
- 限流。
- 响应为空。
- 响应格式异常。

规则解释模板至少覆盖：

- 圈收缩方向。
- 当前区域到预测圈距离。
- 路线策略名称。
- 是否避开高热点区域。
- 模型中心误差提示。

## 15. 错误处理

| 场景 | 处理方式 |
|---|---|
| PUBG API 限流 / 失败 | 请求重试、指数退避、任务状态记录；失败 match 可重新采集 |
| 无效 tournament / match | 标记为 skipped，不中断整个采集任务 |
| telemetry 缺失或格式异常 | 记录错误原因，跳过该 match，保留任务日志 |
| 玩家轨迹事件过多 | 按时间间隔降采样，避免 SQLite 膨胀 |
| SQLite 写入重复 | 使用唯一键和 upsert/ignore，保证重复采集安全 |
| 训练样本不足 | 不生成 ML 模型，降级为统计基线，并在 UI 提示样本不足 |
| 模型预测失败 | 返回统计基线或最近可用模型版本 |
| LLM 调用失败 | 超时、鉴权失败、限流、格式异常都降级为规则解释 |
| 地图资源下载失败 | 使用本地缓存；无缓存时提示用户重试 |
| High Res 地图不可用 | 自动降级到 No Text Low Res |
| 缓存地图文件损坏 | 校验 PNG header 和文件大小，失败则重新下载 |

## 16. 测试策略

| 测试类型 | 覆盖内容 |
|---|---|
| 单元测试 | 坐标转换、Zone 半径推断、telemetry parser、热点网格聚合、路线评分、规则解释 |
| 数据测试 | 使用小型 telemetry fixture 验证圈阶段和玩家轨迹解析结果 |
| API 测试 | `/api/predict`、`/api/training`、`/api/hotspots`、`/api/config`、`/api/assets` |
| 采集测试 | mock PUBG API，验证任务重试、跳过、去重、状态更新 |
| 资产测试 | mock GitHub 下载，验证缓存、PNG 校验、High Res fallback |
| 模型评估测试 | 用固定样本验证中心误差计算稳定 |
| 前端测试 | 地图点击输入、策略切换、overlay 渲染、错误状态展示 |
| 手动验证 | 一张地图完成采集 → 训练 → 预测 → 路线 → 解释流程 |

CI 默认不直接调用 PUBG API、GitHub 官方资源或外部 LLM。这些作为手动或 opt-in 集成测试。

## 17. MVP 验收标准

第一版完成后，应能做到：

1. 用户启动本地 Web 工具。
2. 系统自动按需准备官方地图资源，并缓存到本地。
3. 用户采集 tournament 数据并写入 SQLite。
4. 系统解析圈阶段和玩家轨迹。
5. 用户手动触发训练并看到中心误差。
6. 用户在地图上选择地图、当前 Zone、当前圈中心、战队当前区域和路线策略。
7. 系统输出预测下一圈和预测最终圈。
8. 系统绘制当前圈、预测圈、最终圈、热点和推荐路线。
9. 系统输出规则解释或 LLM 解释。
10. LLM 或外部资源失败时，核心预测和路线功能仍可用。

失败与边界场景也必须可验收：

1. 当地图资源下载失败但已有有效本地缓存时，系统使用缓存并提示资源刷新失败。
2. 当地图资源下载失败且无缓存时，前端显示可重试错误，不崩溃。
3. 当训练样本不足时，训练页显示样本不足原因；预测页使用统计基线或明确提示模型未就绪。
4. 当用户输入非法 Zone、未知地图或超界坐标时，API 返回统一错误结构，前端展示可理解提示。
5. 当 LLM 未配置、鉴权失败、超时或限流时，预测结果仍返回，解释来源标记为 `rule_fallback`。
6. 当 tournament 中部分 match 解析失败时，采集任务仍能完成可用部分，并在 job 详情中列出失败计数和重试入口。

## 18. 后续扩展方向

MVP 之后可以考虑：

- 更高分辨率地图资产自动选择。
- 地形、道路、桥梁、水域级真实寻路。
- 更完整的玩家/队伍行为建模。
- 自动训练和模型版本回滚。
- 多候选圈预测与概率热区。
- 队伍风格配置。
- 私有部署和多用户复盘协作。
- 本地大模型解释层。
- 与训练赛复盘数据或手工标注路线结合。
