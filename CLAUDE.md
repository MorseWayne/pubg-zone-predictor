## Workflow Ledger

使用 `workflow-ledger` 跟踪可恢复的开发工作。

- Workflow Ledger 只有在项目初始化后才生效。如果缺少 `.claude/WORKFLOW.md`，不要把普通开发任务套用到此工作流；先运行 `npx workflow-ledger init`。
- 执行前先分级：Level 0 问答/只读/发布 tag，Level 1 轻量编辑，Level 2 标准代码工作，Level 3 复杂工作。
- Level 2/3 任务，以及用户希望跨会话跟踪的任务，都维护在 `.claude/WORKFLOW.md` 中。
- 被跟踪的工作只记录恢复状态：`Intent`、可变的 `Current todo`、`Prerequisites`、可选的 `Blocked by`，以及一个具体的 `Resume next`。
- 关闭工作前，把任务移到 `Completed`，写简短 `Close summary`：outcome、validation、gaps；验证失败时任务保持 In Progress 或 Blocked。
- 记录依赖和发现的未来任务；先完成阻塞当前工作的前置条件，把非阻塞发现延后到 Backlog/Future。
- 当前会话执行用 TodoWrite；里程碑历史和恢复点用 `.claude/WORKFLOW.md`。
- 不要创建附件或额外 spec 文件，除非 Level 3 工作确实需要，或用户明确要求。

不要找理由跳过 ledger：

- “这个很小”仍然需要分级；Level 2/3 工作必须跟踪。
- “我之后再更新”不安全；在重要待办/范围变化、阻塞、验证结果和交接点更新。
- TodoWrite 是会话本地状态；`.claude/WORKFLOW.md` 是持久恢复状态。
- 保持核心字段稳定，让 `workflow-ledger doctor` 能检查 ledger。
