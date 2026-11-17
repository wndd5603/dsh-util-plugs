# P2 自主召回 backlog 关闭清单（2026-11-17）

> 来源：R4 §2.2。本清单的目标不是“全部写代码”，而是每项都有明确处置，避免残留为模糊待办。
> 处置：COVERED（已被 P1/P0 覆盖）、ACCEPTED（有意保持人工/低频）、EXTERNAL（不在本 repo 可控范围）、DEFERRED（有明确下一触发条件）。

| ID | 项 | 处置 | 说明/证据 |
|---|---|---|---|
| S1 | Skill/政策 drift lint | **COVERED** | P1-2 `tools/check-policy-contract.mjs` 13 checks；`tools/test-policy-contract.mjs` 16 assertions |
| B6 | auto-backup verify/reconcile | **DEFERRED** | 只验证不增长；retention 已在写时；需先定义 `.backup_index.jsonl` 校验契约，避免与 restore 冲突。触发：下一次备份策略变更 |
| B7 | CodeQL alerts | **EXTERNAL** | GitHub code scanning/API token 与 CI 调度；当前 open alerts=0；不混入宿主 timer |
| B8 | jobs stale | **EXTERNAL** | jobs registry 在 DSH core，不在 dsh-util-plugs；重启即清，不能自动 kill |
| B9 | plugin health | **ACCEPTED** | `workbench_status` 只读可用；P1 已加 policy lint；不做周期 hash 提醒 |
| M1b | memory_search rank/recency | **COVERED** | P1-1 新增 `memory_digest`（total/scopes/latestKeys/issue/stale），LIKE 检索暂可接受 |
| C2b | 归档索引（docs/archive 等） | **DEFERRED** | 先完成角色隔离/索引契约；当前 `ARCHIVE_*` 已统一，索引会扩大扫描面。触发：归档目录 >200 文件 |
| A1b | AGENTS mtime/hash 重读 | **ACCEPTED** | 根 `AGENTS.md` 已建，由 agent-instructions 加载；policy lint 校验内容，不做 mtime 重读 |
| C1b | context 78/68 与 hooks 50/15 文案 | **ACCEPTED** | 文案/UX，不是召回缺口；`*_status` 已并列输出 |
| P2-12a | bulletin legacy OR scope | **ACCEPTED** | 新过滤 AND；legacy session/alias/workspace OR 保持不变，避免破坏既有调用 |
| P2-12b | 公告栏 dueAt schema | **DEFERRED** | 需 schema 迁移；P1-4 已用 `updated_at` SLA，不伪造 due |
| P2-12c | 消息 TTL sweep | **DEFERRED** | 改变投递语义；P0-1 只读 pending 提醒，不自动删 |
| P2-12d | meeting action dueAt | **DEFERRED** | 需会议 schema/action 契约；P0-2 已召回 pending actions |

## 结论
- 无未分类 P2 项；无开放代码修改任务。
- 所有 DEFERRED 都有触发条件；所有 EXTERNAL 不在本 repo。
- 保持人工红线：验收、删除、发布、对外发言、越界写。
