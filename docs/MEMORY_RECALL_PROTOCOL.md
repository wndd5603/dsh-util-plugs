# 记忆召回协议（Memory Recall Protocol，MEM2）

本文件是「什么时候搜记忆、搜什么、什么时候写记忆」的固定流程，供所有 DSH 会话引用。
首轮指针只给一句入口（`memory_search`/`memory_list` → `memory_remember`），具体口径以本文为准。

- 工具：`memory_search` / `memory_list` / `memory_remember` / `memory_forget` / `memory_status` / `memory_quality`（由 `agent-memory` row 提供）。
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

写法：`memory_remember({ scope, key, content, tags })`；**新写入必须使用下面模板**，旧格式不拒绝但会返回质量告警。

```text
[project=<project-id> | workspace=<path/name> | domain=<domain> | updated=YYYY-MM-DD]
What: 结论/事实（一句话）
Why: 为什么要记住（决策依据/影响）
Where/Evidence: 证据（file:line、命令、URL；二选一或并列）
Status/Decision: 当前状态或已定决策（二选一或并列）
Next: 下一步/负责人/复核方式
```

- `What`/`Why`/`Next` 必填；`Where` 或 `Evidence` 至少一个；`Status` 或 `Decision` 至少一个。
- 内容长度 80–8000 字符；路径用 `<workspace>`/`<checkout>`/`<home>` 占位符。
- `tags` 建议至少 `project`、`domain`、`kind`；缺失只告警。
- `key` 使用 `<project>/<domain>/<topic>`（2–5 段，优先 3 段）；`scope=project` 必须有 key，且第一段必须存在并按项目标识命名。
- 写完在回复中报告 `id`、`updated`（更新已有 key 时为 `true`）与 `quality.ok`。

### quality 契约（M1）

- `memory_remember` 返回值增加 `quality: { ok, issues, warnings, score }`；**只告警、不拒绝写入**，旧格式仍会成功落库。
- `score` 0–100（每条 issue 扣 20、warning 扣 5，保底 0）；`ok = issues.length === 0`。
- issues（必须修）：key 缺失/段数不在 2–5/字符不合规、缺 `project=/workspace=/domain=/updated=` 头、缺必填字段、长度越界、疑似 `sk-`/`ghp_`/`BEGIN PRIVATE KEY`。
- warnings（建议修）：key 非 3 段、tags 缺 `project/domain/kind`、个人路径（如 `C:\Users\...`、`/home/...`）、`updated` 非 `YYYY-MM-DD`、自由格式旧内容（`LEGACY_FORMAT`）。
- `memory_quality({ scope?, limit? })` **只读**巡检：返回 `summary { total, compliant, warnings, errors }` 与 `rows [{ id, key, score, issues, warnings }]`；`summary` 按行互斥计数（compliant=无 issue 且无 warning，warnings=仅 warning，errors=至少 1 条 issue），`total` 覆盖筛选后全部行，`rows` 受 `limit`（默认 50，最大 200）限制。

## 4. key 约定

- 格式：`<project>/<domain>/<topic>`，2–5 段（优先 3 段），全小写短标识，例如：
  - `dsh-util-plugs/release/policy`、`dsh-util-plugs/release/versioning`
  - `dsh-util-plugs/workbench/pointer`、`dsh-util-plugs/workbench/status`
  - `dsh-util-plugs/memory/protocol`
  - `dsh-util-plugs/team/roles`
- 2 段 key（如 `release/policy`）可用但会收到 `KEY_PREFER_THREE_SEGMENTS` 告警；新写入按 3 段。
- 同一 `scope + key` 是 **upsert**：更新内容而不是新增重复行。
- key 一旦使用就保持稳定，不把版本号、日期塞进 key。
- 同一事实只存一份；需要跨项目共享时用 `global`，不要 project/global 各写一遍。

## 5. 避免重复与冲突

1. 写前先 `memory_search` 同 key/同主题；已有条目就更新。
2. 合并旧内容而不是堆叠；被取代的内容可删除或用一句话注明 supersedes。
3. 同类事实只保留一个 scope。
4. 过时/错误条目用 `memory_forget({ id })` 清理；删除前确认 id，误删后需重写。
5. 用 `memory_status` 查看库位置、条目数与 scope 分布，排查“为什么搜不到”。
6. 收尾或周期巡检用 `memory_quality`；存量不合规只标注/逐条更新，不批量重写。

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
- [ ] 新写入 `quality.ok=true`，或已知 issues/warnings 且准备后续修复？
- [ ] 收尾用 `memory_quality` 看过本项目条目？
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
  key: "dsh-util-plugs/memory/protocol",
  content: `[project=dsh-util-plugs | workspace=<workspace> | domain=memory | updated=2026-11-17]
What: 首轮指针含 memory_search/memory_list 召回与 memory_remember 固化（MEM2）。
Why: 让新会话先召回、收尾固化，减少重复劳动。
Where/Evidence: docs/toolbox/MEMORY_RECALL_PROTOCOL.md
Status/Decision: 已生效；M1 同时提供 quality 告警与只读巡检。
Next: 新写入使用本模板，收尾跑 memory_quality。`,
  tags: ["project", "domain", "kind"],
})
```

`memory_quality` 巡检：

```text
memory_quality({ scope: "project", limit: 50 })
# summary：total=…，compliant=…，warnings=…，errors=…
# rows：逐条 id/key/score/issues/warnings；只读，不改库
```
