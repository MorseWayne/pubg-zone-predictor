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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pubg-zone-predictor** (2215 symbols, 4721 relationships, 134 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pubg-zone-predictor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pubg-zone-predictor/clusters` | All functional areas |
| `gitnexus://repo/pubg-zone-predictor/processes` | All execution flows |
| `gitnexus://repo/pubg-zone-predictor/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
