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

- `PUBG_API_KEY` 只由后端读取，不进入前端。
- `LLM_API_KEY` 只用于可选解释层，失败时必须降级为规则解释。
- CI 默认不调用 PUBG API、GitHub 官方资源或外部 LLM。
