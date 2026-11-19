# PUBG Zone Predictor

本项目是一个本地单机 Web 工具，用于 PUBG 圈型预测、历史热点叠加和战队宏观转移路线分析。

## 技术栈

- 后端：FastAPI + SQLite
- 前端采用 React 19、Vite 和 TypeScript。侧栏和全部业务页面共用 Astryx 组件、Neutral 深色主题和简体中文控件。
- 配置：根目录 `config/`，运行时由后端统一读取
- 数据库：默认 `data/pubg_zone_predictor.sqlite3`，通过迁移脚本初始化
- 本地数据：默认写入 `data/`，不提交到 git

## 本地开发

如果本机已安装 `make`，可以使用根目录 Makefile 作为开发入口：

```bash
make setup
make migrate
make dev
```

`make dev` 会同时启动后端和前端；需要单独调试时可分别运行 `make backend` 或 `make frontend`。

### 1. 安装后端依赖

```bash
npm run setup:backend
```

### 2. 安装前端依赖

```bash
npm run setup:frontend
```

### 3. 初始化数据库

```bash
npm run db:migrate
```

默认数据库路径：`data/pubg_zone_predictor.sqlite3`。

### 4. 启动后端

```bash
npm run dev:backend
```

后端健康检查：<http://127.0.0.1:8000/api/health>

常用基础 API：

- `GET /api/config/maps`：读取已配置地图。
- `GET /api/config/zone-phases?map_id=miramar&game_mode=default`：读取 Zone 半径配置。
- `POST /api/config/maps/{map_id}/coordinates/convert`：在 world / normalized / pixel 坐标间转换。
- `GET /api/assets/maps/{map_id}`：查看地图资源缓存状态。
- `POST /api/assets/maps/{map_id}/ensure`：按需下载并校验地图资源。
- `GET /api/assets/maps/{map_id}/image`：返回本地缓存地图 PNG。
- `POST /api/ingest/samples/squad?platform=steam`：从普通 match samples 采集默认 squad 对局，自动下载 telemetry 并解析入库。
- `POST /api/ingest/matches/{match_id}/telemetry`：下载指定 match 的 telemetry 到本地缓存。
- `POST /api/ingest/matches/{match_id}/telemetry/parse`：解析本地 telemetry 缓存并写入圈阶段、roster、位置样本和 life events。
- `GET /api/ingest/jobs/{job_id}`：查看采集任务状态。
- `POST /api/ingest/jobs/{job_id}/retry`：按任务类型重试可重试采集任务。
- `POST /api/hotspots/generate?map_id=miramar&phase=1`：基于玩家位置样本生成热点网格。
- `GET /api/hotspots?map_id=miramar&phase=1`：读取最近一次生成的热点网格。
- `POST /api/training/runs?map_id=miramar`：基于圈阶段样本训练统计基线并写入评估指标。
- `GET /api/training/runs`：查看最近训练运行。
- `GET /api/training/runs/{run_id}`：查看单次训练运行及指标。
- `GET /api/training/runs/{run_id}/metrics`：查看单次训练运行的中心误差指标。
- `POST /api/predict`：根据地图、当前 Zone、圈心、战队位置和路线策略生成预测圈、路线、热点摘要和解释。

### 5. 启动前端

另开一个终端：

```bash
npm run dev:frontend
```

前端地址：<http://127.0.0.1:5173>


首次打开页面时，先用 Steam 游戏昵称或 PUBG 账号 ID（`account.…`）绑定玩家。绑定保存在当前浏览器。通过顶部“绑定其他玩家”添加账号，使用“当前玩家”切换。默认使用最近 20 局。绑定、切换或重新打开页面时，系统会按当前筛选范围同步，并复用已解析的回放。同步进度、部分失败和本地存档回退会显示在顶部。

在对局回放、个人历史或团队看板顶部选择“最近 20 局”或“指定日期”。日期按北京时间的开局时间计算，当天所有可查比赛都纳入范围。切换页面、玩家或刷新浏览器会保留筛选。官方近期数据与本地存档按对局 ID 合并；超出官方近 14 天范围的日期仅显示已存档的比赛。团队看板及队员对比在这个范围内进一步筛选同队场次。

对局回放默认关注当前玩家。个人历史使用同一批对局，团队看板只统计其中的双排和四排，勾选 1–3 位队友后，仅统计当前玩家与所有勾选成员在同一队的对局。点击“分析交手强度”，可并排查看本人 KD、场均伤害和击倒，以及各成员实际交手真人的赛季 KD 中位数、场均伤害中位数和最高生存等级。页面显示共同场次、遥测读取局数和每项战绩的覆盖人次。采集页默认填入当前玩家，也可以指定其他玩家；从采集记录打开回放不会改变绑定。

在侧栏选择“交手对手”，可分析当前玩家最近 15 或 20 局，也可在顶部选择“指定日期”，选好日期后点击“分析”。按日期分析会统计北京时间当天开局的所有可查对局，强度分布和交手明细都只包含这些对局的对手。双方造成过伤害、击倒或淘汰即计入交手，同一局按账号去重。战绩按比赛所属赛季和模式查询。普通局以击杀数除以败场估算 KD，排位局使用实际死亡数。默认按账号汇总对手名单，按 KD、交手局数或时间排序，也可以按昵称、账号和淘汰方向筛选。切换到“按对局”，可按开局时间、地图选择单场，单独查看本局的对手强度分布和完整交手明细。切换到“交手记录”会按时间平铺所有交手，保留每局对应的赛季战绩和完整动作。顶部展示真人交手样本的 KD 分布和数据覆盖情况。

官方近期列表覆盖最近 14 天，本地存档可补充更早的比赛。在线查询需配置后端 `PUBG_API_KEY`。页面先显示逐局交手记录，再补齐战绩和生存等级，并在限流时显示等待时间。

### PUBG 本地缓存

PUBG 查询缓存保存在后端主数据库旁，默认文件为 `data/pubg_zone_predictor.pubg-cache.sqlite3`。绑定、切换玩家、单人分析和团队对比都复用这些数据，重启服务后仍可命中。

| 数据 | 复用时间和范围 |
| --- | --- |
| 玩家近期对局列表 | 10 分钟，按平台和账号复用，昵称和账号 ID 查询互通。顶部“重新同步”会主动向官方核对当前账号的列表。 |
| 赛季战绩 | 6 小时，按赛季、账号和普通/排位分别保存。普通局按模式只批量补查缺少的账号，排位响应复用其中的各模式数据。 |
| 生存等级 | 24 小时，按账号跨对局复用。明确缺失的资料短暂缓存 5 分钟。 |
| 对局元数据、交手明细 | 缓存 14 天。交手明细按对局、参与账号和遥测文件版本保存；原始遥测继续使用本地文件存档。 |

分析先展示命中的战绩和等级，再联网补齐缺项。已按当前版本完整解析的回放会直接计入同步结果。官方返回配额用尽或 429 后，服务按该 Key 的恢复时间暂停新的受限请求；期间仍能读取有效缓存。首次分析大量陌生对手时，补齐资料可能需要多个配额窗口。

## 本地纵切联调流程

P10 后，前端工作台只通过 FastAPI 完成核心本地纵切：

1. 初始化数据库：`npm run db:migrate`。
2. 启动后端：`npm run dev:backend`。
3. 启动前端：`npm run dev:frontend`。
4. 打开前端后选择地图；工作台会调用 `POST /api/assets/maps/{map_id}/ensure` 准备底图。
5. 如果数据库中已有解析后的 `player_position_samples`，点击“生成当前 Zone 热点”。
6. 如果数据库中已有 `circle_phases` 训练样本，点击“训练当前地图模型”。
7. 在底图上设置当前圈中心和战队位置，选择路线策略，然后点击“生成预测”。
8. 若热点或模型样本不足，前端会展示 warnings；预测仍可通过规则基线和无热点路线降级返回。

在“数据采集”中指定 Steam 玩家后，可批量采集最近对局，包含普通局和排位。采集会保存对局元数据、缓存 telemetry 并解析回放。

## 验证命令

```bash
npm run db:migrate
npm run test:backend
npm --prefix frontend run typecheck
npm run build:frontend
```

## 环境变量

复制 `.env.example` 为 `.env` 后按需填写：

```bash
cp .env.example .env
```

重要约束：

- `PUBG_API_KEY` 只由后端读取，不进入前端；真实采集普通 samples 时必须配置。
- `PUBG_API_BASE_URL` 默认是 `https://api.pubg.com`。
- `PUBG_TELEMETRY_CACHE_DIR` 默认是 `data/telemetry`，用于保存下载后的 telemetry JSON。
- `APP_MODEL_DIR` 默认是 `data/models`，用于保存本地训练产物 JSON。
- `PUBG_ASSETS_CACHE_DIR` 默认是 `data/assets/pubg-api-assets`，用于缓存官方地图资源。
- `PUBG_ASSETS_BASE_URL` 默认指向官方 `pubg/api-assets` raw 资源；遇到 Git LFS 指针时后端会自动切到 media 资源下载实际 PNG。
- `PUBG_ASSETS_TIMEOUT_SECONDS` 默认 `120`，high-res 地图文件较大，网络较慢时可调高。
- `LLM_API_KEY` 只用于可选解释层，失败时必须降级为规则解释。
- CI 默认不调用 PUBG API、GitHub 官方资源或外部 LLM。
