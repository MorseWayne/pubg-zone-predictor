# PUBG Zone Predictor MVP 验收报告

日期：2026-06-06  
范围：P0-P11 本地单机 FastAPI + React + SQLite MVP 交付验收

## 验收结论

MVP 核心链路已完成：本地 Web 工具可以通过 FastAPI 读取配置、准备地图资源、采集/解析 PUBG telemetry 数据、生成热点、训练统计基线、预测下一圈/最终圈、生成宏观路线，并在前端工作台展示 overlay、warnings 和解释文本。

默认自动化验证不调用真实 PUBG API、GitHub 官方资源或外部 LLM；这些外部依赖通过 mock、配置边界、fallback 和 opt-in 手动流程覆盖。

## MVP 验收矩阵

| # | 验收标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | 用户启动本地 Web 工具 | PASS | `npm run dev:backend` 与 `npm run dev:frontend` 已在 README 记录；前端构建通过。 |
| 2 | 系统自动按需准备官方地图资源并缓存到本地 | PASS | `/api/assets/maps/{map_id}/ensure` 已实现 PNG 校验、缓存、fallback；前端地图工作台自动调用 ensure。 |
| 3 | 用户采集 tournament 数据并写入 SQLite | PASS | `/api/ingest/tournaments` 和 `/api/ingest/tournaments/{tournament_id}` 已实现；mock API 测试覆盖 upsert、跳过和局部失败。 |
| 4 | 系统解析圈阶段和玩家轨迹 | PASS | telemetry parser 写入 `circle_phases`、roster、position samples 和 life events；fixture 测试覆盖幂等解析。 |
| 5 | 用户手动触发训练并看到中心误差 | PASS | `/api/training/runs` 写入 model artifact 与 metrics；前端 P10 数据准备区展示 status、sample_count 和 metrics。 |
| 6 | 用户在地图上选择地图、当前 Zone、当前圈中心、战队当前区域和路线策略 | PASS | P9 工作台支持地图选择、Zone、点击设置圈心/战队位置、策略切换。 |
| 7 | 系统输出预测下一圈和预测最终圈 | PASS | `/api/predict` 返回 `next_circle` 与 `final_circle`；测试覆盖模型 artifact 与规则兜底。 |
| 8 | 系统绘制当前圈、预测圈、最终圈、热点和推荐路线 | PASS | 前端 overlay 绘制当前圈、下一圈、最终圈、hotspot top tiles、route polyline 和 marker。 |
| 9 | 系统输出规则解释或 LLM 解释 | PASS | prediction service 默认规则解释；可选 OpenAI-compatible LLM，失败时降级。 |
| 10 | LLM 或外部资源失败时核心预测和路线仍可用 | PASS | LLM failure 测试覆盖 `rule_fallback`；模型/热点缺失时预测使用 `rule_baseline` / 无热点路线降级。 |

## 失败与边界场景矩阵

| # | 边界场景 | 状态 | 证据 |
|---|---|---|---|
| 1 | 地图资源下载失败但已有有效本地缓存时使用缓存并提示 | PASS | AssetManager 优先返回有效缓存；fallback/warnings 测试覆盖缓存与 PNG 校验行为。 |
| 2 | 地图资源下载失败且无缓存时前端显示可重试错误，不崩溃 | PASS | `/api/assets` 返回 `ASSET_UNAVAILABLE`；P9 前端地图 blocker 显示错误与“重试加载地图”，并禁用点击/预测。 |
| 3 | 训练样本不足时显示原因；预测使用统计基线或提示模型未就绪 | PASS | training service 记录 failed run/warnings；prediction service 无模型时返回 `rule_baseline` 和 `model_not_ready`。 |
| 4 | 非法 Zone、未知地图或超界坐标返回统一错误结构 | PASS | `AppError` 统一错误结构；config、coordinate、prediction 测试覆盖 `UNSUPPORTED_MAP`、`INVALID_PHASE`、`COORDINATE_OUT_OF_RANGE`、`INVALID_ROUTE_STRATEGY`。 |
| 5 | LLM 未配置、鉴权失败、超时或限流时预测仍返回，解释来源为 `rule_fallback` | PASS | LLM 配置缺失和 fake failure 都走规则解释降级；测试覆盖 LLM failure warning。 |
| 6 | tournament 中部分 match 解析失败时任务保留可用部分并记录失败计数/重试入口 | PASS | ingest service mock 测试覆盖 partial failure、failed_count、warnings 和 retry job。 |

## 自动化验证命令

最终验收运行：

```bash
npm run db:migrate
.venv/bin/ruff check .
npm run test:backend
npm run build:frontend
```

结果：

- `npm run db:migrate`：通过，迁移命令可重复执行；当前数据库已有迁移时无新迁移输出也视为通过。
- `.venv/bin/ruff check .`：通过。
- `npm run test:backend`：通过，63 passed，1 个 Starlette/httpx deprecation warning。
- `npm run build:frontend`：通过。

## 外部调用范围说明

默认验证不直接访问外部服务：

- PUBG API：真实 tournament/match/telemetry 采集需要 `PUBG_API_KEY`，默认测试使用 mock client。
- GitHub 官方地图资源：`/api/assets` 支持真实按需下载，但默认自动化测试不依赖网络；资源失败由缓存/fallback/error UI 覆盖。
- OpenAI-compatible LLM：解释层可选；默认未配置时使用规则解释，失败时不影响预测结果。

## 已知 gaps / deferred

以下项目不阻塞 MVP，已保留为后续增强：

- 高分辨率地图资产自动选择。
- 道路、桥梁、水域、建筑级真实寻路。
- 多候选圈预测与概率热区。
- 自动训练、模型回滚和多用户协作。
- 队伍风格配置与完整战斗胜率预测。
- 完整采集控制台和浏览器 E2E 自动化。

## 后续建议

1. P11 后可推送 `main`，并用真实 `PUBG_API_KEY` 做一次 opt-in 手动采集验证。
2. 在真实数据充足后校准 Zone 半径示例值和热点阈值。
3. 若继续演进前端，优先拆分 `App.tsx` 为 API client、MapWorkspace、ControlPanel 和 ResultPanel。
