# Workflow Ledger

Claude Code 开发工作的轻量级可恢复台账。

## Active

<!-- workflow-ledger:task
id: WF-2026-06-05-001
level: 3
status: In Progress
current_phase: P3 — 实现配置与地图资产服务
updated: 2026-06-05
-->

### WF-2026-06-05-001 — PUBG 圈型预测工具 MVP 实施计划
Status: In Progress
Level: 3
Started: 2026-06-05
Last updated: 2026-06-05
Current phase: P3 — 实现配置与地图资产服务

Intent:
- 基于 `docs/superpowers/specs/2026-06-05-pubg-zone-prediction-design.md` 实施本地单机 FastAPI + React + SQLite 的 PUBG 圈型预测与宏观路线 MVP。

Plan:
- [done] P0 — 初始化 Git 与 GitHub 仓库：创建本地 git 仓库、确认默认分支、配置远程 GitHub 仓库，并提交当前规划文档。
- [done] P1 — 搭建可运行项目骨架与配置边界：创建 FastAPI 后端、React 前端、共享配置目录、开发启动脚本和基础健康检查。
- [done] P2 — 建立 SQLite 数据层：实现完整 DDL、迁移入口、repository 基础、唯一键/upsert/外键和测试数据库夹具。
- [doing] P3 — 实现配置与地图资产服务：提供地图配置、Zone phase 配置、坐标转换、官方地图资源按需缓存、PNG/LFS pointer 校验和 fallback。
- [todo] P4 — 实现 PUBG 数据采集任务：封装 API key 配置、tournament/match/telemetry 拉取、ingest_jobs 状态、重试、跳过和局部失败记录。
- [todo] P5 — 实现 telemetry parser：解析圈阶段、队伍/roster、玩家位置降采样、life events，并保证重复解析幂等。
- [todo] P6 — 实现热点统计：基于 player_position_samples 聚合 hotspot_tiles，按 match/team 归一化，处理样本不足和 64x64 默认网格。
- [todo] P7 — 实现训练与评估：构造 circle_phases 训练样本，训练统计基线与传统 ML 修正，写入 model_runs/model_metrics，支持样本不足降级。
- [todo] P8 — 实现预测、路线与解释服务：输出下一圈、最终圈、宏观路线、热点摘要、规则解释和可选 OpenAI-compatible LLM 解释降级。
- [todo] P9 — 实现 React 地图工作台：地图选择、当前 Zone、当前圈中心、战队位置、策略切换、overlay、错误展示和预测结果面板。
- [todo] P10 — 补齐端到端 API 与前端联调：串通采集/训练/预测/资源加载的本地纵切流程，确保前端只访问 FastAPI。
- [todo] P11 — 完成测试与 MVP 验收：单元/API/mock 外部服务/fixture/manual 验证，覆盖规格中的失败与边界场景。

Current todo:
- [ ] P3 — 实现配置与地图资产服务。

Changes:
- 根据已评审设计文档创建 Level 3 可恢复实施计划，按纵切交付顺序拆为 P1-P11。
- 用户要求在 P1 前增加 Git/GitHub 初始化步骤，新增 P0 并设为当前执行项。
- P1 已完成：建立 FastAPI/React 骨架、共享配置样例、启动脚本和基础验证命令；前端安装脚本显式清理用户级 npm allow-scripts 环境以适配 npm 11。
- P2 已完成：建立 SQLite 初始 schema、迁移 CLI、连接工厂、基础 repository、测试夹具和数据层验证。

Prerequisites:
- `PUBG_API_KEY` 只在真实采集验证时需要；P1-P5 可先用 mock/fixture 开发。
- GitHub/PUBG API/LLM 外部网络调用默认不进 CI，需要 mock 或 opt-in 集成测试。
- Zone 半径示例值允许用于 MVP 初始配置，正式准确性需要后续用规则或 telemetry 校准。
- LLM 配置是可选能力；未配置或失败必须走规则解释降级。

Resume next:
- 执行 P3：实现地图/Zone 配置读取服务、坐标转换工具和地图资产按需缓存/校验 API。

## Backlog / Future

- [ ] 高分辨率地图资产自动选择 — MVP 优先 No Text Low Res，High Res 仅作为后续增强。
- [ ] 道路/桥梁/水域/建筑级真实寻路 — 超出第一版宏观路线范围。
- [ ] 多候选圈预测与概率热区 — MVP 只输出单一推荐结果。
- [ ] 自动训练、模型回滚和多用户协作 — MVP 明确本地单机、手动训练。
- [ ] 队伍风格配置与完整战斗胜率预测 — 不阻塞圈型预测和宏观路线首版验收。

## Completed
