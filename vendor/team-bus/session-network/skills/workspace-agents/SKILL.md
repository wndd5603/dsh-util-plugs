---
name: workspace-agents
description: >-
  工作区 AGENTS.md 首次询问与创建流程：项目根没有 AGENTS.md 且即将首次写项目文件时，
  只问一次用途并生成最小 AGENTS.md（绝不覆盖已有文件）。
  触发词：AGENTS.md、工作区用途、工作区说明、首次写文件、首次写入、询问用途、跳过并记住、
  skip、headless、无交互、嵌套 AGENTS、工作区初始化、workspace_agents_init。
  内容：触发/不触发判定、一次性询问流程与 30s 超时、三版话术、默认建议生成、skip 记忆、
  headless 放行、嵌套 AGENTS 规则、创建/不覆盖/失败兜底。不用于：项目政策迁移、团队初始化。
---

## 0. 前置检查（可执行，先用工具再按流程）

1) **先调用 `network_info({section:'network'})`**；若返回 `network === null`（本工作区未接入交流网）⇒ 本 skill 全部流程跳过，按普通会话工作。
2) 若工具不存在/调用失败 ⇒ 视为 `network === null`，跳过联网流程（fail-open）。
3) 只有 `network !== null` 时，才继续本 skill 的后续章节。

# 工作区 AGENTS.md 询问（workspace-agents）

> 原则：**每项目根最多问一次**；问不到就放行（fail-open）；**已有 AGENTS.md 一律不动**。

## 0 何时用 / 不用
- ✅ 你即将对某项目根的**项目文件**做第一次 `write`/`edit`，且该根没有 `AGENTS.md`（也没有本根的询问记录）。
- ✅ 收到工具/hook 提示 `nextSkill: "workspace-agents"` 或 `agents-ask` 标记。
- ✗ 已有 `AGENTS.md`/`CLAUDE.md`；只读写 `scratch/`、`file_backups/`、`.dsh/`；写项目根之外路径。

## 1 触发判定（按序，命中即停）
1. 项目根 = 从 cwd 向上第一个含 `.git` 的目录（无 `.git` 则 cwd）。
2. 目标路径在项目根内，且**不在**自留地：`team/`、`scratch/`、`file_backups/`、`team/members/<成员>/`。
3. `AGENTS.md` 不存在（`CLAUDE.md` 存在视为已登记，不追问）。
4. `agv_asks` 无本根记录（`skipped=false` 的跳过记录同样视为已问过）。
5. 同一项目根并发会话：先查 `agv_asks` 的 `asked_at`；已有记录 ⇒ 不重复问。

## 2 一次性询问流程（30s 超时，X4）
1. 若可交互（Web/有 answerer）：调用 `ask_user_question`，**一次只问一个问题**（见 §3），等待 ≤30s。
2. 回答“采纳/自定义”⇒ 走 §5 创建；回答“跳过并记住”⇒ 写 `skipped=true` 记忆，**不创建**。
3. 超时/无 answerer/headless ⇒ 走 §5 创建，标 `auto=true, unasked=true`，并 audit。
4. hook 内**绝不 await 用户答案**；hook 只做观察/提示，提问由模型在工具返回后发起。
5. 创建失败（权限 deny/路径不可写）⇒ 不重试绕过；记 audit 后继续主任务。

## 3 话术（三版，直接复制）
- **提问（唯一一次）**
  `本工作区（<项目根名>）的用途是？建议：「<默认建议>」` 选项：① `采纳建议并写入 AGENTS.md` ② `改一句（我输入）` ③ `跳过并记住，不再问`
- **hook/工具结果内提示（不阻塞）**
  `【session-network】本工作区未登记用途。若用户在场，问一次并写入项目根 AGENTS.md；用户不在或拒绝则继续，勿阻断。`
- **headless/超时一行提示**
  `【session-network】未登记工作区用途（无交互/超时），已自动创建并标记 unasked；不影响本次写入。`

## 4 默认建议（确定性，不猜业务细节）
1. `README.md` 存在 ⇒ 取首个 `# ` 标题，去 Markdown，截 40 字符；
2. 否则项目根目录名转可读短语（`dsh-session-network` → `dsh session network`）；
3. 都没有 ⇒ `（未识别，请一句话说明）`。
- 禁止从文件内容推断客户/业务细节（隐私）。

## 5 创建规则（workspace_agents_init / 手工等价）
- 优先调 `workspace_agents_init({ purpose?, skip? })`（P1 工具）；工具缺失时手工写。
- **写前先查存在性**：`AGENTS.md` 已存在 ⇒ 只返回 `skipped` + 提示，**不覆盖、不追加**（R3 D36 硬限制）。
- 最小模板（只写“用途 + 身份 + 时间 + 指针”，不复制项目政策）：
```markdown
# <项目名> — 工作区说明

- 用途：<一句话>
- 网络身份：displayName=<displayName>；alias=<alias>；roleName=<roleName 或 (unset)>
- 创建：<ISO8601>（由 session-network 记录，可修改）
- 项目政策：如有 `team/TEAM.md`，以它为准；本文件不重复其条款。
```
- 记录到 `agv_asks(workspace_hash, answer, skipped, auto, at)`；后续会话读记录不再问。

## 6 skip 记忆与全局关闭
- “跳过并记住” ⇒ `skipped=true` 永久生效（本项目根）；不提供“稍后再问”。
- 全局关闭：`config set agentsAsk off`（运行时开关，无需重启）；关闭后不询问、不创建、可 audit。
- 项目改名/移动 ⇒ 新 root 视为新工作区，可再问一次（可接受）。
- 删除 `AGENTS.md` 不重置已问记录（避免反复骚扰）；需要重问用工具/初始化显式重置。

## 7 嵌套 AGENTS 规则
- 宿主 loader 会沿目录链加载子目录 `AGENTS.md` 并自动注入；**本 skill 只判定项目根一次**。
- 写入的子目录已存在 `AGENTS.md` ⇒ 视为该子目录已登记，**不触发根询问**；否则按项目根判定。
- 子目录没有登记、但项目根已登记 ⇒ 不新建子目录 AGENTS.md（除非用户明确要求）。
- 不要在子目录重复问同一问题；不要在 AGENTS.md 里复制 `TEAM.md` 政策（单一权威）。

## 8 失败与权限
| 失败 | 处理 |
|---|---|
| 写 `AGENTS.md` 被 deny（只读角色） | 交有写权限成员/发起人；本会话继续主任务，不绕过 |
| 无 ask 通道（headless/NO_PROVIDER） | 直接创建 + `auto/unasked` 标记 + audit；不挂起 |
| 用户拒绝/跳过 | 不创建；记录 skip；继续 |
| 工具 `workspace_agents_init` 缺失 | 手工按 §5 模板写（存在则跳过）；仍失败只提示 |

## 9 反模式 / 收工检查
- ✗ 首回合就问（还不知道要写什么）；✗ 每次提醒；✗ 覆盖已有 AGENTS.md；✗ 把政策全文写进 AGENTS.md。
- ✗ 为了“问一句”阻塞写入超过 30s；✗ 把“跳过”写成“未问过”。
- [ ] 本次只问了一次；结果有记录（`answer/skipped/auto`）
- [ ] 创建时未覆盖已有文件；内容只含用途/身份/时间/指针
- [ ] 无交互场景未阻塞主任务
