# PUBG Zone Predictor

本项目是一个本地单机 Web 工具，用于 PUBG 圈型预测、历史热点叠加和战队宏观转移路线分析。

## 技术栈

- 后端：FastAPI + SQLite
- 前端：React + Vite + TypeScript
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

普通 squad 样本采集通过前端“官方采集”工作区一键执行；采集会自动完成 match 元数据落库、telemetry 缓存和解析。

## 验证命令

```bash
npm run db:migrate
npm run test:backend
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
