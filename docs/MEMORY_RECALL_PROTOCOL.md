# 记忆召回协议（Memory Recall Protocol，MEM2）

本文件是「什么时候搜记忆、搜什么、什么时候写记忆」的固定流程，供所有 DSH 会话引用。
首轮指针只给一句入口（`memory_search`/`memory_list` → `memory_remember`），具体口径以本文为准。

- 工具：`memory_search` / `memory_list` / `memory_remember` / `memory_forget` / `memory_status`（由 `agent-memory` row 提供）。
- 存储：本机 SQLite（默认 `~/.dsh/memory/memory.sqlite`，可用 `DSH_MEMORY_DB` 覆盖），不写入 workspace/vendor。
- 分区（scope）：`project`（默认）/ `agent`（仅本 agent 的偏好）/ `global`（跨项目稳定规则）。

## 1. 何时搜索

满足任一条就在动手前召回，**先搜后做**：

| 触发 | 动作 |
| --- | --- |
| 新会话第一个实质任务 | `memory_search` 项目名/任务关键词 1–3 次，必要时 `memory_list` 兜底 |
| 上下文压缩、归档恢复、resume/fork 之后 | 先 `memory_search` 恢复项目上下文，再继续任务 |
| 接手新任务或切换子任务 | 搜该子域已有结论，避免重复劳动/重复踩坑 |
| 用户说“继续 / 上次 / 之前的约定 / 按我们定的来” | 搜决策与未完成项，并说明命中的 id/updated_at |
| 做发布、改配置、改协议等高风险动作前 | 搜已否决方案与硬门禁，避免回退到旧口径 |
| 准备 `memory_remember` 之前 | 先搜同 key/同主题，查重后再写 |

约束：单次召回控制在约 5 次搜索以内；没有命中就继续，不因“记忆为空”阻塞任务。

## 2. 搜什么

查询词用**具体名词组合**，不要用空泛词（“任务”“问题”）：

- 项目/工作区名 + 主题：`"<project> 发布策略"`、`"<project> 记忆召回"`。
- 组件/文件/工具名：`"workbench pointer"`、`"team-hooks2 归档提醒"`、`"memory_remember"`。
- 任务/决策标识：`"MEM2"`、`"POL1 release --confirm-release"`、`"<task-id>"`。
- 决策关键词：`"默认不 tag"`、`"不重启"`、`"key 约定"`。

调用建议：

```text
memory_search({ query: "<project> 当前任务", scope: "project" })
memory_search({ query: "release policy", scope: "project" })
memory_list({ scope: "project", limit: 20 })   # 最近条目兜底
```

- 默认 `scope: "project"`；跨项目稳定偏好/团队规则才用 `global`；只与当前 agent 有关的用 `agent`。
- `memory_search` 是 content/key/tags 的 LIKE 匹配，标签词也可直接当 query。
- 召回结果按 `updated_at` 新旧取舍；互相冲突时以较新条目为准，并在回复中注明冲突与依据。
- 引用记忆时带上 `id` 和 `updated_at`，不要只凭“我记得”。

## 3. 何时写

**写**（稳定、可复用、下次会用到）：

- 已验证的结论/根因/修复方式，以及验收命令与结果。
- 决策及其理由、被否决的方案（避免重复讨论）。
- 未完成项、下一步、负责人/交接信息。
- 环境事实：端口、profile 名、关键路径（用占位符）、版本。
- 团队约定、发布/安全门禁、重复踩的坑与 workaround。

**不写**：

- 过程性日志、大段工具输出、逐轮聊天原文。
- 临时猜测、未验证的判断。
- 密钥/token/密码、个人隐私、真实用户名与家庭路径、内网地址。
- 会话 UUID、一次性 URL 等易失效信息。

写法：`memory_remember({ scope, key, content, tags })`；内容建议 1–6 行，结构为「结论 + 证据/文件 + 日期」。
写完在回复中报告 `id` 与 `updated`（更新已有 key 时为 `true`）。

## 4. key 约定

- 格式：`<domain>/<topic>`，全小写短标识，例如：
  - `release/policy`、`release/versioning`
  - `workbench/pointer`、`workbench/status`
  - `memory/protocol`
  - `team/roles`
- 同一 `scope + key` 是 **upsert**：更新内容而不是新增重复行。
- key 一旦使用就保持稳定，不把版本号、日期塞进 key。
- 同一事实只存一份；需要跨项目共享时用 `global`，不要 project/global 各写一遍。

## 5. 避免重复与冲突

1. 写前先 `memory_search` 同 key/同主题；已有条目就更新。
2. 合并旧内容而不是堆叠；被取代的内容可删除或用一句话注明 supersedes。
3. 同类事实只保留一个 scope。
4. 过时/错误条目用 `memory_forget({ id })` 清理；删除前确认 id，误删后需重写。
5. 用 `memory_status` 查看库位置、条目数与 scope 分布，排查“为什么搜不到”。

## 6. 隐私与安全

- memory DB 在本机 `~/.dsh/` 下，默认不进入工作区；不要把整库复制进仓库或发布包。
- 内容中的路径用 `<workspace>`、`<checkout>`、`<home>` 等占位符；不写真实用户名。
- 不写凭据、私钥、会话 cookie、完整个人信息。
- 对外分享/导出前，按 [`README.md`](README.md) 的隐私门禁检查（`scripts/toolbox/check-privacy.mjs`，0 命中才可外发）。
- 其他会话写入的记忆可能过时：召回结果只作为线索，涉及当前状态时用工具复核（如 `workbench_status`）。

## 7. 与其它机制的分工

| 机制 | 职责 |
| --- | --- |
| workbench 首轮指针（≤3 行/≤400 字） | 提示“先召回、结论固化”的入口 |
| team-hooks2 归档提醒 | 压缩/归档时提示把本轮稳定结论写入 memory，并先 `memory_search` |
| `persistent-memory` skill | 同一协议的简版速查 |
| 本文件 | 完整流程与 key/隐私约定 |

## 8. 收尾自检（30 秒）

- [ ] 新会话/压缩后/新任务，动手前搜过项目记忆？
- [ ] 引用了 `id`/`updated_at`，冲突已说明？
- [ ] 稳定结论已 `memory_remember`，写前查过重？
- [ ] 没有密钥、隐私、真实路径、会话 UUID？
- [ ] 过时条目已清理或标注？

## 9. 示例

新会话开工：

```text
memory_search({ query: "<project> 当前任务", scope: "project" })
memory_search({ query: "<相关组件或主题>", scope: "project" })
# 读取结果 → 开工
```

任务收尾：

```text
memory_remember({
  scope: "project",
  key: "workbench/pointer",
  content: "首轮指针已含 memory_search/memory_list 召回与 memory_remember 固化（MEM2）；约束 ≤3 行/≤400 字。",
  tags: ["memory", "workbench", "pointer"],
})
```
