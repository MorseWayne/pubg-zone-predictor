# Workflow Ledger

Claude Code 开发工作的轻量级可恢复台账。

## Active

## Backlog / Future

- [ ] 地图资源 UI 切换（High/No Text/Low）— 当前按用户要求默认 High 且严格失败；资源版本切换后续再做。
- [ ] 道路/桥梁/水域/建筑级真实寻路 — 超出第一版宏观路线范围。
- [ ] 多候选圈预测与概率热区 — MVP 只输出单一推荐结果。
- [ ] 自动训练、模型回滚和多用户协作 — MVP 明确本地单机、手动训练。
- [ ] 队伍风格配置与完整战斗胜率预测 — 不阻塞圈型预测和宏观路线首版验收。
- [ ] 完整采集控制台和浏览器 E2E 自动化 — P10/P11 未纳入 MVP 默认范围，后续按需增强。

## Completed

### WF-2026-07-06-002 — 团队看板 50/20 统计口径
Completed: 2026-07-06
Level: 2

Close summary:
- Outcome: 团队看板已拆分为“最近 50 场四排筛队友”和“所选队伍最近 20 场统计”；指定玩家采集默认提升到 50 场。
- Validation: Ruff 通过；相关后端测试 41 passed；前端 build 通过；GitNexus detect_changes 已执行，风险为 HIGH。
- Gaps: 未做真实 PUBG API 采集 smoke；未提交。

Archived execution:
- Intent: 团队看板从玩家最近 50 场中筛选四排队友，再用 20 场做统计。
- Plan:
  - [done] P1 — 后端 API 支持 teammate 候选范围 50 场、统计 20 场。
  - [done] P2 — 前端固定传入 50/20 口径并更新提示文案。
  - [done] P3 — 补充测试并验证构建。
- Key changes:
  - `TeamDashboardRequest`/前端请求新增 `teammate_candidate_limit`，默认 50；`match_limit` 保持 20。
  - 后端统计先在候选范围内过滤所选 teammate，再取最近统计场次，避免只看主玩家最新 20 场。
  - `DataCollection` 指定玩家采集默认 50 场，并提示团队看板建议采集 50 场。
- Validation:
  - `.venv/bin/ruff check backend/app/api/ingest.py backend/app/services/ingest.py backend/tests/test_ingest_api.py backend/tests/services/test_ingest_service.py` 通过。
  - `.venv/bin/pytest backend/tests/test_ingest_api.py backend/tests/services/test_ingest_service.py -q`：41 passed，1 个 Starlette/httpx deprecation warning。
  - `npm --prefix frontend run build` 通过。
  - `detect_changes(scope=all)` 已执行，显示 HIGH，影响集中在团队看板聚合/API/前端采集与导航相关执行流。
- Deferred / gaps:
  - 未用真实 PUBG API 新采集 50 场做端到端验证。
  - 未提交。

### WF-2026-07-06-001 — 团队数据看板
Completed: 2026-07-06
Level: 2

Close summary:
- Outcome: 已实现本地玩家列表、团队看板聚合 API，以及前端 `/team-dashboard` 团队数据看板入口；支持选择个人和最多 3 个最近四排队友，展示胜率/前三率、淘汰、击倒、伤害、均名次和最近同队对局。
- Validation: Ruff 通过；后端测试 `129 passed, 1 warning`；前端 build 通过；用临时 SQLite 数据库启动 FastAPI + Vite，API 与页面均能返回/展示团队看板数据。
- Gaps: 未提交；`gitnexus detect-changes --scope all` 风险为 HIGH，主要因本轮同时包含 GitNexus 索引说明文件计数更新和新增团队看板执行流，提交前建议再复核 diff。

Archived execution:
- Intent: 实现可选择个人最近四排队友并展示团队数据分析的看板。
- Plan:
  - [done] P1 — 梳理现有数据模型、API 和前端入口。
  - [done] P2 — 用现有 match/telemetry 数据实现最小后端团队分析 API。
  - [done] P3 — 在前端新增团队看板入口和图表/表格展示。
  - [done] P4 — 运行构建/测试并记录验证结果。
- Key changes:
  - 复用 `matches`、`match_rosters`、`match_teams`、`player_life_events.damage` 聚合最近 squad/squad-fpp 同队数据，不新增表。
  - 新增 `/api/ingest/players/local` 与 `/api/ingest/players/team-dashboard`，前端新增 `TeamDashboard` 页面和侧栏入口。
  - Dataviz 采用固定 4 色 categorical dark palette，并保留表格明细作为非颜色通道。
- Validation:
  - `.venv/bin/ruff check backend/app/api/ingest.py backend/app/services/ingest.py backend/tests/test_ingest_api.py backend/tests/services/test_ingest_service.py` 通过。
  - `.venv/bin/pytest backend/tests -q`：129 passed，1 个 Starlette/httpx deprecation warning。
  - `npm --prefix frontend run build` 通过。
  - 运行 FastAPI + Vite 后请求本地玩家列表、团队看板 API、缺失玩家 404；Chrome headless 打开 `/team-dashboard` 并截图确认页面展示。
- Deferred / gaps:
  - 未做真实 PUBG 外部采集 smoke；本轮使用本地 SQLite 样本验证 UI/API。
  - 未提交；如需提交，应确认是否保留 GitNexus 自动更新的 `AGENTS.md` / `CLAUDE.md` 计数变化。

### WF-2026-06-08-003 — 落地 Open Design 全新前端视觉
Completed: 2026-06-08
Level: 2

Close summary:
- Outcome: 已将 `radical-ops-redesign.html` 的 warm paper + frosted ops 方向落地到 React/shadcn 前端：预测页改为左 rail、顶部 command strip、中部地图沙盘 + 决策卡、底部采集/准备控制台。
- Validation: `npm --prefix /home/wayne/source/open/pubg-zone-predictor/frontend run build` 通过。
- Gaps: 未启动浏览器做真实视觉/交互验收；本轮未提交；本会话中曾误触多次 Open Design active context 查询，后续应避免重复调用。

Archived execution:
- Intent: 将 Open Design `radical-ops-redesign.html` 的全新视觉方向落地到 React/shadcn 前端，保留现有功能行为。
- Plan:
  - [done] P1 — 重构预测页为左 rail、顶部 command strip、中部地图沙盘 + 决策卡、底部采集/准备控制台。
  - [done] P2 — 运行前端构建验证并记录结果。
- Key changes:
  - `App` 主预测 surface 改为单屏作战台结构；采集和准备聚焦页继续保留在 rail tab。
  - `styles.css` 新增 Radical Ops 覆盖样式：浅色背景、frosted panels、orange/blue accents、地图沙盘 overlay 和底部控制台布局。
- Validation:
  - 前端生产构建通过。
- Deferred / gaps:
  - 浏览器人工确认视觉比例、地图遮罩可读性、底部表格密度和响应式表现。

### WF-2026-06-08-002 — Open Design 全新前端视觉方案
Completed: 2026-06-08
Level: 2

Close summary:
- Outcome: 已在 Open Design 项目 `PUBG Zone Predictor Redesign` 中创建并写入新设计稿 `radical-ops-redesign.html`，采用浅色 glassmorphism + digital sand table 风格，打破原暗色军绿工作台风格。
- Validation: 已通过 Open Design `get_artifact` 读取确认 artifact 存在且未截断。
- Gaps: 仅完成设计稿，尚未落地到 React/shadcn 代码；未做浏览器交互验收。

Archived execution:
- Intent: 使用 Open Design 重新设计前端 UI，允许打破现有样式风格，先产出可视化设计稿。
- Plan:
  - [done] P1 — 在 Open Design 中创建新版本 HTML 设计稿。
  - [done] P2 — 总结设计方向、交互结构和后续落地建议。
- Key changes:
  - 新设计强调单屏作战台：左侧窄 rail、顶部 command strip、中部大地图沙盘 + 右侧决策卡组、底部数据采集/准备控制台。
  - 视觉从暗色战术 HUD 转为 warm paper + frosted panel + orange/blue action accents。
- Validation:
  - Open Design artifact `radical-ops-redesign.html` 创建后成功读取，`truncated: false`。
- Deferred / gaps:
  - 后续若认可方向，再将设计落地到 `frontend/src/App.tsx` 与 `frontend/src/styles.css`。

### WF-2026-06-08-001 — shadcn 前端 UI 重构
Completed: 2026-06-08
Level: 2

Close summary:
- Outcome: 已初始化 shadcn/base-nova 与 Tailwind v4，新增所需 UI 组件源码，并将主工作区、预测面板、采集管理、match 表格、数据准备、状态/结果展示改为 shadcn 组件组合。
- Validation: `npm --prefix /home/wayne/source/open/pubg-zone-predictor/frontend run build` 通过两次；GitNexus impact 对主要 UI 组件为 LOW；`detect_changes(scope=all)` 已执行且因工作树包含既有后端删除 API/文档改动显示 CRITICAL。
- Gaps: 未启动浏览器做真实视觉/交互验收；用户中断后未运行 reviewer 子代理；未提交。

Archived execution:
- Intent: 使用 shadcn/ui 重构当前 React 前端界面，保留现有预测、采集管理和数据准备行为。
- Plan:
  - [done] P1 — 初始化 shadcn/Tailwind 配置并添加必要 UI 组件。
  - [done] P2 — 用 shadcn 组件重构 App 主界面、采集管理、数据准备与结果展示。
  - [done] P3 — 运行前端构建与必要检查，记录验证结果。
- Key changes:
  - 新增 `frontend/components.json`、`src/lib/utils.ts`、shadcn UI 组件源码，并补齐 `@/*` alias、Tailwind Vite 插件和相关 npm 依赖。
  - `App` 主导航改用 shadcn `Tabs`；地图/Zone/路线/采集 profile 改用 shadcn `Select`；按钮、卡片、状态、提示、进度、表格、空/加载态改用 shadcn 组件组合。
  - CSS 收敛旧按钮选择器，避免覆盖 shadcn `Button` variants，并兼容 base-ui `data-active` tab 状态。
- Validation:
  - `npm --prefix /home/wayne/source/open/pubg-zone-predictor/frontend run build` 通过（两次）。
  - GitNexus impact：`App` LOW；`IngestConsolePanel` LOW；`PredictionPanel` LOW；`DataPrepPanel` LOW。
  - `gitnexus_detect_changes(scope=all)` 已执行，显示 CRITICAL；主要因当前工作树还包含既有后端采集/删除 API、AGENTS/CLAUDE 等改动，不仅是本轮 shadcn UI。
- Deferred / gaps:
  - 浏览器真实视觉/交互验收。
  - 如需提交，应先确认是否把既有后端采集删除改动与本轮 shadcn 前端改动拆分提交。

### WF-2026-06-07-002 — 数据采集与管理界面实现
Completed: 2026-06-07
Level: 2

Close summary:
- Outcome: 已将采集管理 UI 简化为实用操作台，并新增真实后端浏览/删除能力：`GET /api/ingest/matches` 浏览已采集 match，`DELETE /api/ingest/matches/{match_id}` 删除 match 及级联解析数据，并尝试删除本地 telemetry cache 文件。
- Validation: 前端构建通过；`backend/tests/test_ingest_api.py` 与 `backend/tests/services/test_ingest_service.py` 通过；后端改动文件 Ruff 通过；GitNexus detect_changes 已执行，风险为 CRITICAL（真实删除 API + 既有 AGENTS/CLAUDE 修改也在 scope=all 中）。
- Gaps: 未启动浏览器做真实视觉验收；未用真实 DB 执行人工删除 smoke；当前删除是硬删除，不提供回收站恢复。

Archived execution:
- Intent: 将 Open Design 的数据采集与管理控制台实现到现有前端，并按用户反馈改为简化 UI，支持浏览和直接删除。
- Plan:
  - [done] P1 — 落地采集管理工作区 UI。
  - [done] P2 — 新增真实 match 浏览与删除 API，并接入前端。
  - [done] P3 — 运行前后端验证并更新 ledger。
- Key changes:
  - `官方采集` 更名为 `数据采集与管理`，保留 sample squad 采集、重试、取消现有 API 能力。
  - 前端去除复杂规划/删除预览 UI，改为采集表单、任务操作和真实 match 列表。
  - 后端新增 `IngestMatchAsset`、`DeleteMatchResult`、`IngestService.list_matches()`、`IngestService.delete_match()`。
  - API 新增 `GET /api/ingest/matches` 与 `DELETE /api/ingest/matches/{match_id}`；删除依赖 SQLite 外键级联清理关联表，并尝试删除本地 telemetry cache 文件。
  - 修复 `run_sample_matches_job` 中 Ruff B012 提示，避免 `finally` 内 return/break。
- Validation:
  - `npm run build --prefix /home/wayne/source/open/pubg-zone-predictor/frontend` 通过。
  - `.venv/bin/pytest backend/tests/test_ingest_api.py backend/tests/services/test_ingest_service.py -q`：19 passed，1 个 Starlette/httpx deprecation warning。
  - `.venv/bin/ruff check backend/app/api/ingest.py backend/app/services/ingest.py backend/tests/test_ingest_api.py` 通过。
  - GitNexus impact：`App` LOW；`IngestConsolePanel` LOW；`IngestService` LOW；`get_job` LOW。`detect_changes(scope=all)` 已执行。
- Deferred / gaps:
  - 浏览器人工视觉/交互验收与真实采集/删除 smoke。
  - 若需要误删恢复，后续应改为软删除/回收站模型。

### WF-2026-06-07-001 — 多工作区前端重设计
Completed: 2026-06-07
Level: 2

Close summary:
- Outcome: 已用 Open Design 在 `pubg-zone-predictor-redesign/multi-surface-redesign.html` 重新规划多工作区界面，并在 React 中将功能拆为 `战术预测`、`官方采集`、`数据准备` 三个顶部切换的独立工作区。
- Validation: `npm run build:frontend` 通过；采集请求仍复用后端 `/api/ingest/*`，不暴露 `PUBG_API_KEY`。
- Gaps: 未启动浏览器做真实视觉/交互验收；未真实调用 PUBG 官方 API 做端到端采集 smoke。

Archived execution:
- Intent: 用户反馈不建议所有功能都在一个界面后，使用 Open Design 重新设计并实现分工作区前端。
- Plan:
  - [done] P1 — 用 Open Design 创建 `multi-surface-redesign.html`，规划工作区切换。
  - [done] P2 — React 顶部新增 `战术预测`、`官方采集`、`数据准备` 工作区切换。
  - [done] P3 — 将采集控制台和热点/训练从预测面板移出，分别放入独立 ops 面板。
  - [done] P4 — 运行前端构建验证。
- Key changes:
  - `战术预测` 工作区只保留地图、路线策略、坐标、LLM 解释和预测结果。
  - `官方采集` 工作区独立承载 tournament list、tournament match、telemetry download/parse 和 job retry。
  - `数据准备` 工作区独立承载热点生成和模型训练。
  - 采集请求保留 AbortController/request id；输入字段保留 label/id。
- Validation:
  - `npm run build:frontend` 通过。
- Deferred / gaps:
  - 浏览器人工确认顶部切换、ops 面板滚动和三工作区信息密度。
  - 使用真实 tournament/match id 做官方 API 端到端采集 smoke。

### WF-2026-06-06-004 — Open Design 前端 Redesign
Completed: 2026-06-06
Level: 3

Close summary:
- Outcome: 已用 Open Design 创建 `pubg-zone-predictor-redesign/index.html` 原型，并将前端落地为紧凑 command bar、地图主区域、右侧预测控制列。
- Validation: `npm run build:frontend` 两次通过；React review 的可确认问题已处理。
- Gaps: 未启动浏览器做真实视觉/交互验收；Canvas 任意坐标标点仍主要依赖鼠标/触控输入。

Archived execution:
- Intent: 使用 Open Design 重新设计 PUBG 圈型预测前端，并落地到现有 React 工作台。
- Plan:
  - [done] P1 — 建立 Open Design 视觉基准。
  - [done] P2 — 将 redesign 落地到 React 布局与样式。
  - [done] P3 — 运行前端构建并做针对性复查。
- Key changes:
  - 不再使用已删除的 ui-ux-pro-max；仅基于现有前端与 Open Design 产出 redesign。
  - Open Design 项目 `pubg-zone-predictor-redesign` 已创建，入口为 `index.html`。
  - React 前端改为紧凑 command bar、地图主区域、右侧预测控制列；补充热点/训练/资源重试旧异步回包上下文保护与 Canvas 辅助说明。
- Validation:
  - `npm run build:frontend` 通过。
  - React review 已执行；切地图/切 Zone 清理状态经核对为已有逻辑，旧异步回包保护和 Canvas 辅助说明已补齐。
- Deferred / gaps:
  - 浏览器真实视觉/交互验收未执行。
  - 键盘可操作缩放按钮已保留；任意地图坐标标点仍主要依赖鼠标/触控。

### WF-2026-06-06-003 — 顶部战术导航与 Tab 操作面板
Completed: 2026-06-06
Level: 2

Close summary:
- Outcome: 已将常用地图操作迁移到水平顶部战术导航栏，并通过同页 Tab 将地图工作台与操作面板拆分；地图 Tab 不再被控制面板遮挡。
- Validation: `npm run build:frontend` 通过。
- Gaps: 未启动浏览器做实际视觉/交互验收。

Archived execution:
- Intent: 将常用地图操作移到水平顶部导航栏，地图与操作面板通过同页 Tab 切换，避免控制面板遮挡地图。
- Plan:
  - [done] P1 — 实现顶部战术导航、地图 Tab 和操作面板 Tab。
  - [done] P2 — 更新样式并运行前端构建验证。
- Key changes:
  - 顶部导航包含地图/Zone 选择、地图工作台/操作面板 Tab、设置圈心/设置队伍、圈心/队伍状态与清除。
  - 地图 Tab 只展示固定大 Canvas；操作面板 Tab 展示状态、数据准备、路线策略、LLM、生成预测和预测结果。
- Validation:
  - `npm run build:frontend` 通过。
- Deferred / gaps:
  - 浏览器人工确认地图固定高度、Tab 切换体验和顶部导航拥挤程度。

### WF-2026-06-06-002 — 地图半沉浸式 UI 与坐标清除
Completed: 2026-06-06
Level: 2

Close summary:
- Outcome: 已将地图工作区改为半沉浸式布局，控制面板变为右侧浮层；当前圈中心和战队位置坐标卡片支持分别清除；清除/切换地图/切换 Zone 会清空旧预测并保护在途预测请求不回写过期结果。
- Validation: `npm run build:frontend` 通过。
- Gaps: 未启动浏览器做人工视觉/交互验收。

Archived execution:
- Intent: 放大地图可视区域，将控制面板改为右侧浮层，并允许分别清除当前圈中心和战队位置。
- Plan:
  - [done] P1 — 实现半沉浸式地图布局。
  - [done] P2 — 实现坐标卡片清除行为。
  - [done] P3 — 保护预测请求一致性。
  - [done] P4 — 运行前端构建验证并记录结果。
- Key changes:
  - 依据 `docs/superpowers/specs/2026-06-06-map-immersive-panel-design.md` 执行；用户确认采用半沉浸式右侧浮层和坐标卡片“清除”按钮。
  - `workspace-grid` 改为地图主体工作区，`.control-panel` 改为右侧半透明浮层并支持滚动。
  - 新增坐标清除 handler 与预测请求 abort/token 保护。
- Validation:
  - `npm run build:frontend` 通过。
- Deferred / gaps:
  - 浏览器人工确认地图可视区域、浮层遮挡程度、清除按钮和拖拽/缩放联动留待本地验收。

### WF-2026-06-06-001 — UI 地图 Canvas 优化
Completed: 2026-06-06
Level: 3

Close summary:
- Outcome: 已将地图工作台升级为 Miramar 默认、High Res 带文字资源严格加载、Canvas 绘制底图/热点/圈/路线/标记，并支持单击标点、拖拽平移、滚轮缩放、缩放按钮和重置视图。
- Validation: 配置/资产关键测试 19 passed；`npm run test:backend` 69 passed（1 个 Starlette/httpx deprecation warning）；`.venv/bin/ruff check .` 通过；`npm run build:frontend` 通过。
- Gaps: 未启动浏览器进行真实 high-res 下载和人工交互验收；真实 Miramar telemetry 样本 smoke 未执行。

Archived execution:
- Intent: 将地图工作台升级为 Miramar 默认、高分辨率地图严格加载、Canvas 渲染，并支持拖动/缩放/单击标点。
- Plan:
  - [done] P1 — 写入并审查设计文档，用户已同意继续。
  - [done] P2 — 更新地图配置与高分辨率资产策略。
  - [done] P3 — 实现 Canvas 地图渲染、坐标转换和交互控件。
  - [done] P4 — 接入现有预测、热点、圈和路线数据流。
  - [done] P5 — 执行后端、前端构建和自动化验证；人工交互验收未执行。
- Key changes:
  - 新增 `docs/superpowers/specs/2026-06-06-ui-map-canvas-optimization-design.md` 并按 spec review 修正实现约束。
  - 新增 Miramar `Desert_Main` map/zone 配置；默认资产契约改为 `high`；`high`/`no_text_high` 不再回退 low-res。
  - 前端新增 Canvas transform 工具和 `InteractiveMapCanvas`，`App` 默认选择 Miramar 并通过 Canvas 回传 world 坐标。
- Validation:
  - `.venv/bin/pytest backend/tests/services/test_config_service.py backend/tests/test_config_api.py backend/tests/services/test_assets.py backend/tests/test_assets_api.py`（19 passed，1 warning）。
  - `npm run test:backend`（69 passed，1 warning）、`.venv/bin/ruff check .`、`npm run build:frontend` 通过。
- Deferred / gaps:
  - 浏览器人工交互验收、真实 high-res 下载和真实 Miramar telemetry smoke 留待用户本地运行确认。


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
