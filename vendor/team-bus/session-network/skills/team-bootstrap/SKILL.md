---
name: team-bootstrap
description: >-
  团队初始化索引：队长或队长型会话开工时先读我，再按 nextSkill 加载具体子技能。
  触发词：团队初始化、新会话开工、开工第一件事、我是谁、交流网、派活、派单、优先指派、
  开会、会议邀请、上下文归档、成员管理、工作区用途、AGENTS.md、已知坑、
  能力索引、哪些工具可调用、UI-only、人工确认、operator-only。
  内容：启动三件套（身份/坑/团队骨架）、**能力索引单一入口（四类能力 + 人工确认 + 3 个易误解项，
  指向 CAPABILITY_AUDIT）**、nextSkill 契约、权威边界、失败兜底。
  不用于：具体流程细节（在子技能）、项目政策原文（在 team/TEAM.md）、强制策略（在 hook）。
---

## 0. 前置检查（可执行，先用工具再按流程）

1) **先调用 `network_info({section:'network'})`**；若返回 `network === null`（本工作区未接入交流网）⇒ 本 skill 全部流程跳过，按普通会话工作。
2) 若工具不存在/调用失败 ⇒ 视为 `network === null`，跳过联网流程（fail-open）。
3) 只有 `network !== null` 时，才继续本 skill 的后续章节。

# 团队初始化索引（team-bootstrap）

> 你是团队队长时只做五件事：制定规划、更新工作表、核对纠错、决策仲裁、记录归档；
> 具体实施派队员并独立复验。本文件只回答“下一步加载谁”，不复制子技能正文，不重复项目政策。

## 0 何时用 / 不用
- ✅ 会话或新项目第一次做团队动作；收到 `nextSkill: "team-bootstrap"` 或“先读 init skill”提示。
- ✗ 单会话简单改动、纯问答、只需一次只读查询（直接调工具）。

## 1 启动三件套（≤60 秒；每项失败都直接跳过，不阻塞主任务）
1. `network_info()` → 身份四字段与网络概况；字段缺失写 `(unset)`，不猜。
2. `pitfalls()` → `{count, items:[{line,source}], sourceFile}`（≤10 条/每条 1 行）；返回 `nextSkill` 非 null 先加载；无此工具则继续。
3. 有团队工具时：`team_init`（幂等，看 `created/skipped`）→ `team_members_check`（`problems` 非空逐条修）。
4. 读 `team/members/<你的 roleName 或 alias>/AGENTS.md`（存在才读）。项目无 `team/` ⇒ 跳过团队初始化，不生成任何文件。

## 2 能力索引（单一入口：四类 + 3 个易误解项）

> 本 skill 是团队能力的**单一入口**；逐项机读清单见
> `CAPABILITY_AUDIT.md`（59 项能力的公开清单；机读清单保留在源码仓库）。
> 先判断“四类 + 人工确认属性”，再选 `nextSkill`；**文档存在 ≠ 模型可调用**。

### 2.1 四类能力

| 类别 | 含义 | 代表能力 | 模型怎么用 |
|---|---|---|---|
| **可调用** | 当前工具集/会话里有工具或 skill | `context_guard_status`、`team_hooks_status`、`message_send/queue/read/ack/routes/status`、`network_info`、`pitfalls`、`auto_backup_status`、`restart_dsh`（仅 step1 预检）、`restart_status`、`workbench_status`；skills：`team-bootstrap`、`network-intro`、`session-meeting`、`delegation-priority`、`workspace-agents`、`context-usage`、`prompt-forge` | 直接调用工具/用 `skill` 加载；先看 `nextSkill` 契约（§3） |
| **条件可调用** | 依赖预设、配置开关、会话工具集或人工前置 | `team_init`/`team_members_check`（captain 预设；写盘前先 preview）、`prompt_forge_*`（prompt-architect 预设）、`alias_register`/`workspace_agents_init`（人工/确认后）、`message_route_register`（operator 配置 `allowRouteRegister`）、`context_usage`（宿主工具集包含时）、`restart_dsh` step2（人工 token+PID+锁） | 先满足条件再调用；不满足就说明缺什么，不硬试 |
| **UI-only** | 只有浏览器/插件管理器界面，模型无 DOM | `dsh-plugin-console` 左栏/卡片/搜索/配置表单/深链安装器；host-relaunch Web 确认面板；原生设置表单；预设选择器中的 `preset-context-pro`/`preset-captain`/`preset-prompt-architect`（preset rows，不是工具） | **不要找同名工具**；告诉用户去界面操作/切换预设 |
| **自动 hook** | 策略/注入在宿主事件上自动运行，模型不能主动触发 | `[ctx %]` 每轮注入、`[context-meter]` 阈值提醒、archive 归档提醒、roleWritePolicy、delegation advisor、writeGate（默认 off）、problemLoop（默认 off）、auto-backup 写前备份、restart kill 围栏 | 只能观察状态/按提示行动；开关需人工改配置 |

**横切属性：人工确认 / operator-only**（不属于第五类，是上述能力的权限属性）：

| 能力 | 人工/operator 要求 |
|---|---|
| `message_purge` | 必须由操作员/用户给出 `confirm:"PURGE"`；破坏性，模型不得自行永久删除 |
| `message_route_register` | 默认 `allowRouteRegister:false`；需 operator 配置启用后才存在 |
| `alias_register` | 改别名→会话路由；建议人工/会议确认后使用，支持 dryRun |
| `team_init` | 写 team/ 模板前先 `preview:true`，由用户/队长确认落盘 |
| `workspace_agents_init` | 首次写工作区前询问用途；不覆盖已有 AGENTS.md；无 host-cwd 回退 |
| `restart_dsh` step2 | 真实重启需 token+PID 后缀+人工/author 授权；当前 `allowRealRestart=false` 时直接拒绝 |
| `prompt-forge` S6 | 必须由空上下文子智能体独立验证并记录；模型不能替代该门禁 |

完整边界见 `OPERATOR_ONLY_BOUNDARIES.md`。

### 2.2 三个最容易误判的项（先记住）

1. **plugin-console 是 UI-only**：它没有“控制台工具”；模型不能打开面板、点按钮、改插件状态，只能建议用户去界面或使用原生插件管理器。
2. **真实重启是人工闸门**：`restart_dsh` 第一步只做只读预检；第二步需要 token + PID 后缀，且当前配置 `allowRealRestart=false`，真实 confirm 会被拒绝。不要承诺“我可以直接重启”。
3. **writeGate / problemLoop 默认 off**：`team_hooks_status` 能看到它们的状态，但模型不能开启/触发；开启/灰度是人工配置 + 授权流程（problemLoop 仅 B/C canary）。

### 2.3 nextSkill 路由（按情境选一个加载，不要一次全开）

| 情境 | nextSkill | 产出 / 验收 |
|---|---|---|
| 不知道“我是谁 / 有哪些会话 / 怎么联系 / 哪些已知坑” | `network-intro` | 身份四字段 + 可达性 + 隐私边界 |
| 要开会、发会议邀请、表决、定稿、写纪要 | `session-meeting` | AGENDA / FINAL 四表 / ACK / 侧车 sha256 |
| 收到任务，先判断自己干还是派、怎么拆 | `delegation-priority` | 六栏任务包 + shadow 判定记录 |
| 工作区没有 AGENTS.md，且马上要首次写项目文件 | `workspace-agents` | 一次询问 → 最小 AGENTS.md（不覆盖已有） |
| 需要上下文占用/压缩纪律 | `context-usage` | 何时测占用、何时建议 /compact |
| 提示词迭代（prompt-forge） | `prompt-forge` | S0–S7 阶段与 S6 独立验证门禁 |

### 2.4 预设 × 能力矩阵（切换前先看）

能力工具已从预设 entry 移到 profile 级全局 row：**空白/标准/任意预设都能调用**；
预设只负责 persona/instructions 与标准工具集。不要为了拿工具而切换预设。

| 能力 | 提供方（全局 row） | 空白/标准 | captain | prompt-architect | context-pro |
|---|---|---|---|---|---|
| `team_init` / `team_members_check` | `team-tools`（captain-preset/plugin） | ✅ | ✅（队长 persona 额外指导团队流程） | ✅ | ✅ |
| `prompt_forge_*` ×6 + `prompt-forge` skill | `prompt-forge-tools`（prompt-architect） | ✅ | ✅ | ✅（镜语 persona 额外指导 S0–S7） | ✅ |
| `context_usage` / `context_guard_status` / `team_hooks_status` | context-sentinel 全局 rows | ✅ | ✅ | ✅ | ✅（仅 persona 强调上下文纪律） |
| `message_*` / `network_info` / `pitfalls` / `alias_register` / `workspace_agents_init` | team-bus/message-bus 全局 rows | ✅ | ✅ | ✅ | ✅ |
| `auto_backup_status` / `restart_*` | auto-backup / host-relaunch 全局 rows | ✅ | ✅ | ✅ | ✅ |
| plugin-console / restart 面板 | UI-only（浏览器/人工） | ❌ 模型不可调用 | ❌ | ❌ | ❌ |

**切换提示**：
- 需要 Team Coordinator 的团队纪律/汇报口吻 ⇒ 选 `captain`；只是要 `team_init` 工具 ⇒ 不必切。
- 需要 Prompt Architect 的镜语/九维流程指导 ⇒ 选 `prompt-architect`；只是要 `prompt_forge_*` 工具 ⇒ 不必切。
- 需要上下文纪律强化文本 ⇒ 选 `context-pro`；工具本身全局可用。
- 任何无法全局化的能力（UI-only/人工确认）见 §2.1 与 `OPERATOR_ONLY_BOUNDARIES.md`。

详细实证见 `CAPABILITY_AUDIT.md`。

## 3 nextSkill 契约（工具与 skill 的接口）
- 可能返回 `nextSkill`/`nextReason` 的工具：`network_info`、`pitfalls`、`workspace_agents_init`（INTERFACES §5.1）；`nextSkill` ∈ 5 个 skill 名之一或 null。
- `nextSkill` 非 null ⇒ **先** `skill({name: nextSkill})` 再继续；null/缺省 ⇒ 按本索引表选。
- 工具提示与索引表冲突 ⇒ 以工具 `nextSkill` 为准；该 skill 不存在 ⇒ 回索引表；仍不存在 ⇒ 记一行 audit 后继续（fail-open）。
- 返回 `unknown or no longer available` 时不要重试同名；直接按索引表执行并在结果里注明“skill 不可用：<名>”。
- skill 名必须与目录名一致，只用 kebab-case（如 `session-meeting`）。

## 4 权威边界（冲突裁决；不在此重写规则）
- 路由：`PEERS.json` / pipe2（只读，不写）；元数据：`network_info` 背后的注册表；项目政策：`team/TEAM.md`；操作程序：本 skill 家族；强制策略：hook（roleWritePolicy 等）。
- skill 与 `team/TEAM.md` 冲突 ⇒ 以 TEAM.md 为准，并报告“skill 需更新”；与 hook deny 冲突 ⇒ 按 deny 提示改路径（scratch/ 或交有权限成员），**不绕过**。
- 项目政策条款引用：`TEAM.md §四.6` 停止必回报；`§十五` 队长五做三不做；`§十三` 目录与报备；`§十四` 称呼/禁词；`§八之三` 归档状态机。

## 5 失败兜底（任何一步失败都不阻断主任务）
| 失败 | 处理 |
|---|---|
| skill/工具缺失 | 跳过该能力，继续主任务；结果中注“能力不可用：<名>” |
| `network_info` 抛错/超时 | 只读兜底：`team_sessions` / `team_audit` / `PEERS.json`；仍失败写 `(unset)` |
| 写入被 deny | 改 `<项目>/scratch/` 或交有写权限成员 |
| headless / 无交互通道 | 不发起 AGENTS 询问、不等待用户（见 `workspace-agents`） |

## 6 收工检查
- [ ] 团队动作产出都有路径；委派有回报；关键结论自己独立复跑过
- [ ] 未完成项写清；本次决议/快照/纪要已落盘
- [ ] 没有把“已派 / 已读 / 做完了”写成未实际发生的事
