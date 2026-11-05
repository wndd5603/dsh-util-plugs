---
name: network-intro
description: >-
  本机 DSH 会话交流网入门：查“我是谁、有哪些会话、怎么联系、状态如何、有哪些已知坑”，
  并严格区分身份四字段 sessionId / roleName / displayName / alias。
  触发词：交流网、会话网络、有哪些会话、我是谁、我的别名、displayName、alias、roleName、
  怎么联系、可达性、routable、team_sessions、team_audit、network_info、pitfalls、已知坑。
  内容：四字段语义与不可混用规则、三条查询通道与字段白名单、可达性判定、会议入口、
  常见坑与失败兜底。不用于：会议流程（session-meeting）、派活判定（delegation-priority）、
  工作区 AGENTS（workspace-agents）。
---

## 0. 前置检查（可执行，先用工具再按流程）

1) **先调用 `network_info({section:'network'})`**；若返回 `network === null`（本工作区未接入交流网）⇒ 本 skill 全部流程跳过，按普通会话工作。
2) 若工具不存在/调用失败 ⇒ 视为 `network === null`，跳过联网流程（fail-open）。
3) 只有 `network !== null` 时，才继续本 skill 的后续章节。

# 交流网入门（network-intro）

> 只做“查与解释”，不改注册表、不写路由。显示名/别名是元数据，**强制策略只认 roleName**。

## 0 何时用 / 不用
- ✅ 需要知道网络里有哪些会话、自己的身份怎么表示、怎么联系某个会话、网络当前有哪些坑。
- ✗ 要改别名/注册（用 `alias_register` 工具，P1）；要开会（`session-meeting`）；要派活（`delegation-priority`）。

## 1 身份四字段（R2 共识 D31，混用=安全事故）
| 字段 | 语义 | 是否可变 | 规则 |
|---|---|---|---|
| `sessionId` | 路由主键（`session-<uuid>`） | 否 | 投递/审计用它；`pipe2_session_post` 可直达 |
| `roleName` | **策略键**（team-hooks2 `denyRoles` 按成员名匹配） | **永不自动改** | 自动别名/改名不得触碰；缺失写 `(unset)`，宁可“不匹配”不“误匹配” |
| `displayName` | 展示/归因标签（审计 `from` 用它） | 可改（记历史） | 全局唯一；格式 `<域>-<角色>` 或任务给定名 |
| `alias` | pipe2 路由键 | 可派生/可改 | ≤16、小写 kebab；改名不动 `roleName`；旧名保留 ≥72h |

生成顺序（仅在注册/派生时用）：用户显式 > AGENTS 声明 > preset 角色名（过通用身份词过滤）> cwd 去 `_ws` > 短码。

## 2 三条查询通道（工具优先，逐级降级）
```bash
# 1) 工具（首选）
network_info({ section: "sessions" })     # section ∈ 'all'|'sessions'|'meetings'|'pitfalls'（默认 all）
pitfalls({ query: "pwsh" })               # → {count, items:[{line,source}], sourceFile}；≤10 条/每条 1 行

# 2) 现有团队工具
team_sessions()                           # live 会话 only（不等于全量注册表）
team_audit()                              # 路由/未读/送达/ACK（fail-open）

# 3) 只读文件兜底（无工具时）
node team/pipe2_tool.js peers list        # 人或脚本可读
node team/pipe2_tool.js stat              # 未 ACK / 最后一条
```
- `network_info` 字段：`schemaVersion / generatedAt / network{id,profile,total,active,stale} / sessions[] / meetings[] / pitfalls{count,file,hint}`。
- 每个 session：`sessionId / shortId / displayName / aliases[] / roleName / roleKind / presetCategory / availability / team / contact{routable,via} / lastSeenBucket`。
- **nextSkill 消费**：`network_info` / `pitfalls` / `workspace_agents_init` 返回值可能带 `nextSkill`（5 个 skill 名之一或 null）+ `nextReason`；非 null ⇒ 先 `skill({name: nextSkill})` 再继续，null/缺省 ⇒ 按需自选（索引见 `team-bootstrap`）。

## 3 输出与隐私（披露边界）
- 只输出上述白名单字段；**禁止** cwd 明文、会话标题原文、task subject、diagnostics、model/provider 细节、对话正文、PII。
- 序列化后二次扫描路径/密钥模式，命中替换 `[redacted]` 并记 audit；拿不准就不输出。
- `team_sessions` 只含 live；`PEERS.json` 不一定带 `session`（当前 18 条仅约 6 条带）；**不要把“在 PEERS”当“在线可达”**。

## 4 可达性（routable）与投递
- `routable` 需三层同时成立：PEERS 有 alias + `inbox/<alias>/` 存在 + bridge 有 route；缺一层则不可达。
- 最稳投递：按 `sessionId` 直投 `pipe2_session_post({ session, subject, body })`（body ≤4000；只投递、无 ACK）。
- 文件通道：`node team/pipe2_tool.js post <from> <to> "<subject>" <body-file>`（返回 id/seq，读后自动 ACK）。
- **delivered ≠ ACK**：投递成功只证明送达；ACK 必须有对方回复/ACK 文件/立场文件。
- 多 root 时禁止跨 root `--all`；收件人以 `PEERS` 的 active/member 为准。

## 5 会议入口（只给入口，细则见 session-meeting）
- 先 `network_info({section:"meetings"})` 看是否有进行中会议；要发起 ⇒ `meeting_open`（工具就绪后）或 `skill({name:"session-meeting"})`。
- 邀请 subject 必含「会议邀请 / 请表态 / 四段格式」之一，否则对方 `read` 时不会被提示表态。

## 6 常见坑（本机实测，先假设成立再验证）
| 坑 | 正确做法 |
|---|---|
| 把 `team_sessions` 当全量注册表 | 它只有 live；注册表看 PEERS/`network_info` |
| 把 alias 当策略键 | 策略只认 `roleName`；被 deny 时看 deny reason 的 role |
| 假设有 heartbeat/最后在线 | 当前无心跳，只有 `lastSeenBucket` 近似 |
| alias 长度口径混乱 | 以工具/注册表校验为准，u≤16 小写 kebab，冲突加 `-2` |
| 同名 `list_agents`（shipped vs team 版） | 优先团队版；字段不同，不要混用 |

## 7 失败兜底
| 失败 | 处理 |
|---|---|
| `network_info` 超时/抛错 | 降级 `team_sessions` → `team_audit` → PEERS → 写 `(unset)` |
| 隐私扫描命中 | 输出 `[redacted]` + 说明“已脱敏”，不重试泄露 |
| 无 pipe2/无工具 | 只报告“无跨会话通道”，不要假装已通知 |
| 写操作被 deny | 只读查询无需写；确需落盘走 `scratch/` |

## 8 收工检查
- [ ] 报告里身份四字段齐全，未混用 alias/roleName
- [ ] 可达性结论有证据（`routable` 或 `team_audit` 字段），无“我觉得在线”
- [ ] 未输出 cwd/正文/PII
