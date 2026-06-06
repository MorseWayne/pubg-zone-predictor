# Workflow Ledger

Claude Code 开发工作的轻量级可恢复台账。

## Active

## Backlog / Future

- [ ] 高分辨率地图资产自动选择 — MVP 优先 No Text Low Res，High Res 仅作为后续增强。
- [ ] 道路/桥梁/水域/建筑级真实寻路 — 超出第一版宏观路线范围。
- [ ] 多候选圈预测与概率热区 — MVP 只输出单一推荐结果。
- [ ] 自动训练、模型回滚和多用户协作 — MVP 明确本地单机、手动训练。
- [ ] 队伍风格配置与完整战斗胜率预测 — 不阻塞圈型预测和宏观路线首版验收。
- [ ] 完整采集控制台和浏览器 E2E 自动化 — P10/P11 未纳入 MVP 默认范围，后续按需增强。

## Completed

### WF-2026-06-05-001 — PUBG 圈型预测工具 MVP 实施计划
Completed: 2026-06-06
Level: 3

Close summary:
- Outcome: 已交付本地单机 FastAPI + React + SQLite 的 PUBG 圈型预测 MVP，覆盖配置/资产、采集、解析、热点、训练评估、预测路线解释、React 地图工作台、前端数据准备纵切和 MVP 验收报告。
- Validation: `npm run db:migrate`、`.venv/bin/ruff check .`、`npm run test:backend`（63 passed，1 个 Starlette/httpx deprecation warning）和 `npm run build:frontend` 均通过。
- Gaps: 真实 PUBG/GitHub/LLM 外部调用为 opt-in；高分辨率地图、真实寻路、多候选圈、自动训练/回滚、完整采集控制台和 E2E 自动化已延后。

Archived execution:
- Intent: 基于 `docs/superpowers/specs/2026-06-05-pubg-zone-prediction-design.md` 实施本地单机 PUBG 圈型预测与宏观路线 MVP。
- Plan:
  - [done] P0 — 初始化 Git 与 GitHub 仓库。
  - [done] P1 — 搭建可运行项目骨架与配置边界。
  - [done] P2 — 建立 SQLite 数据层。
  - [done] P3 — 实现配置与地图资产服务。
  - [done] P4 — 实现 PUBG 数据采集任务。
  - [done] P5 — 实现 telemetry parser。
  - [done] P6 — 实现热点统计。
  - [done] P7 — 实现训练与评估。
  - [done] P8 — 实现预测、路线与解释服务。
  - [done] P9 — 实现 React 地图工作台。
  - [done] P10 — 补齐端到端 API 与前端联调。
  - [done] P11 — 完成测试与 MVP 验收。
- Key changes:
  - 在 P1 前新增 Git/GitHub 初始化；远端 feature 分支已合并回 main 并清理。
  - 外部 PUBG/GitHub/LLM 调用默认 mock 或 opt-in；预测在模型缺失时返回规则兜底而不是中断。
  - P9 地图底图失败时禁用地图点击和预测；P10 前端可触发热点生成与模型训练但不提供完整采集 UI。
  - P11 新增 `docs/acceptance.md`，对 MVP 验收标准和失败边界场景逐项记录结果。
- Validation:
  - 各阶段持续通过 Ruff、后端测试、数据库迁移和前端构建；最终验收通过 `npm run db:migrate`、`.venv/bin/ruff check .`、`npm run test:backend`、`npm run build:frontend`。
- Deferred / gaps:
  - 高分辨率地图、真实道路/桥梁/水域寻路、多候选概率热区、自动训练/模型回滚、完整采集控制台、浏览器 E2E 自动化和真实外部服务集成验证。
