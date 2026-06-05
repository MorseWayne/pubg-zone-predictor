# PUBG Zone Predictor

本项目是一个本地单机 Web 工具，用于 PUBG 圈型预测、历史热点叠加和战队宏观转移路线分析。

## 技术栈

- 后端：FastAPI + SQLite
- 前端：React + Vite + TypeScript
- 配置：根目录 `config/`，运行时由后端统一读取
- 数据库：默认 `data/pubg_zone_predictor.sqlite3`，通过迁移脚本初始化
- 本地数据：默认写入 `data/`，不提交到 git

## 本地开发

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
- `GET /api/config/zone-phases?map_id=erangel&game_mode=default`：读取 Zone 半径配置。
- `POST /api/config/maps/{map_id}/coordinates/convert`：在 world / normalized / pixel 坐标间转换。
- `GET /api/assets/maps/{map_id}`：查看地图资源缓存状态。
- `POST /api/assets/maps/{map_id}/ensure`：按需下载并校验地图资源。
- `GET /api/assets/maps/{map_id}/image`：返回本地缓存地图 PNG。
- `POST /api/ingest/tournaments`：采集 tournament 列表元数据。
- `POST /api/ingest/tournaments/{tournament_id}`：采集 tournament 下的 match 与 telemetry URL 元数据。
- `POST /api/ingest/matches/{match_id}/telemetry`：下载指定 match 的 telemetry 到本地缓存。
- `POST /api/ingest/matches/{match_id}/telemetry/parse`：解析本地 telemetry 缓存并写入圈阶段、roster、位置样本和 life events。
- `GET /api/ingest/jobs/{job_id}`：查看采集任务状态。
- `POST /api/ingest/jobs/{job_id}/retry`：按任务类型重试可重试采集任务。
- `POST /api/hotspots/generate?map_id=erangel&phase=1`：基于玩家位置样本生成热点网格。
- `GET /api/hotspots?map_id=erangel&phase=1`：读取最近一次生成的热点网格。

### 5. 启动前端

另开一个终端：

```bash
npm run dev:frontend
```

前端地址：<http://127.0.0.1:5173>

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

- `PUBG_API_KEY` 只由后端读取，不进入前端；真实采集 tournament 列表和 tournament 详情时必须配置。
- `PUBG_API_BASE_URL` 默认是 `https://api.pubg.com`。
- `PUBG_TELEMETRY_CACHE_DIR` 默认是 `data/telemetry`，用于保存下载后的 telemetry JSON。
- `PUBG_ASSETS_CACHE_DIR` 默认是 `data/assets/pubg-api-assets`，用于缓存官方地图资源。
- `PUBG_ASSETS_BASE_URL` 默认指向官方 `pubg/api-assets` raw 资源。
- `LLM_API_KEY` 只用于可选解释层，失败时必须降级为规则解释。
- CI 默认不调用 PUBG API、GitHub 官方资源或外部 LLM。
