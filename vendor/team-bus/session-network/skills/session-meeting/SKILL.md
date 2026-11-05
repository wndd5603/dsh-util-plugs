---
name: session-meeting
description: >-
  跨会话会议固定流程：多个 DSH 会话对同一议题表态、表决、定稿、复盘时召回。
  触发词：开会、会议邀请、请表态、议程、表决、定稿、纪要、FINAL、ACK、缺席、复盘、
  要不要开会、会议规模、任务分诊、复杂度、quorum、多方会商、跨会话决策、dedupeKey、会议纪要模板。
  内容：**先做任务复杂度分诊（§0.5，T0–T3/是否开会/规模/阶段/quorum）**；
  发起/主持/记录/旁证四角色；R1 立场→R2 收敛→R3 定稿异步多轮；四段发言与不合格判据；
  meetingId/目录规范；pipe2 投递、dedupeKey 去重与证据链；deadline 与三态缺席；
  只读角色 scratch 兜底；FINAL 四表 + ACK.md + 侧车 sha256；可直接复制的模板与命令。
  不用于：单人派活、纯通知、单会话内部讨论。
---

## 0. 前置检查（可执行，先用工具再按流程）

1) **先调用 `network_info({section:'network'})`**；若返回 `network === null`（本工作区未接入交流网）⇒ 本 skill 全部流程跳过，按普通会话工作。
2) 若工具不存在/调用失败 ⇒ 视为 `network === null`，跳过联网流程（fail-open）。
3) 只有 `network !== null` 时，才继续本 skill 的后续章节。

# 会话间会议固定流程（session-meeting）

> 只有发起/主持方需要加载本 skill；参与方靠邀请消息自包含格式与通道。
> 会议不能代替门禁：结论必须跑命令证明，不能“大家觉得没问题”。

## 0 开工前确认（缺一即停）
1. 会议根：`<项目根>/docs/meetings/` 可写；不可写 ⇒ 只读角色走 `scratch/` 兜底（§9）。
2. 消息根：`<项目根>/team/pipe2/` 或 `$PIPE2_ROOT`；确认只有一个 root；`PEERS.json` 可读。
3. 能力探测：`meeting_*` 工具 ⇒ 首选；有 `pipe2_session_post`/`team_audit`/`team_sessions` ⇒ 次选；只有 CLI ⇒ `node team/pipe2_tool.js`；全无 ⇒ **停下来报告“无跨会话通道”**。
4. 解析参与方 session：PEERS `status=active` 且带 `session` 的条目 + `team_sessions` 复核在线；`session:null` 不等于可投递。
5. 查进行中会议：`network_info({ section: "meetings" })`（section 枚举固定 `'all'|'sessions'|'meetings'|'pitfalls'`，默认 `all`）；返回 `nextSkill` 非 null ⇒ 先 `skill({name: nextSkill})`。

## 0.5 任务分诊：复杂度 → 是否开会（T0–T3）

> 前置 §0 通过后，先做本分诊，再决定是否进入 §1 的会议流程。
> 本段只回答“要不要开、开多大、开到哪一阶段”；不重复 §4–§12 的
> R1 立场 / R2 收敛 / R3 定稿 / FINAL / ACK 模板。
> 判断核心：**是否需要多个有决策权的人共同承诺？** 如果只需要执行、通知或单向同步，就不开会。

### 0.5.1 输入与复杂度信号

先写清：任务目标、验收标准、deadline、当前 owner、已有关键结论/证据。
再按下面 6 个信号打分（每项 0/1/2，S=合计）：

| 信号 | 0 分 | 1 分 | 2 分 | 判定依据 |
|---|---|---|---|---|
| 跨域范围 | 单文件/单模块 | 同 owner 多模块 | 跨 owner / 跨会话 / 跨仓库 | 谁能独立完成 |
| 证据量/不确定性 | 已有可复现证据 | 需汇总多份证据或口径不一 | 关键证据冲突/缺失且代价高 | 能否直接判定 |
| 不可逆性 | 可回滚、局部 | 共享分支/配置、需协调 | 发布/迁移/删除/不可逆外部动作 | 失败能否撤回 |
| 冲突 | 无已知分歧 | 潜在分歧 | 明确对立/有 veto 方 | 是否必须裁决 |
| 时间窗 | 可异步、按天推进 | 24h 内要决定 | 小时级阻塞/事故窗口 | 何时必须定 |
| 参与方数量 | 1 个 owner | 2–3 个同团队角色 | 4+ 或跨会话 | 需要谁承诺 |

- `S <= 2` ⇒ **T0**；`S = 3–4` ⇒ **T1**；`S = 5–6` ⇒ **T2**；`S >= 7` ⇒ **T3**。
- **硬覆盖**（高于总分）：
  - 跨会话参与（参与方数量 2 分）或跨 owner 的不可逆决策 ⇒ 至少 **T2**；
  - 不可逆=2 且冲突>=1 ⇒ 至少 **T2**，涉及多会话/发布 → **T3**；
  - 用户明确要求“开会/纪要/表决” ⇒ 至少 **T2**，除非用户同意只做同步；
  - 议题还不能写成可判定问题 ⇒ 先不开会，补证据/收敛（见 §0.5.4）。
- T0/T1/T2/T3 是**决策成本**分级，不是任务重要性分级。

### 0.5.2 决策树（按顺序，先命中先停）

```text
§0 preflight
  ├─ network === null / 无通道 → 不进入会议流程，普通会话工作（§0）
  └─ network 可用
       ├─ T0 单 agent 可完成，验收可本地/可逆
       │    → 不开会；执行 + 验证 + 一条结果/状态消息（send_message 或会话回复）
       ├─ T1 同团队可拆分派活，一个 owner 能定验收
       │    → 不开会；任务板/消息写清目标、接口、验收、deadline；
       │      只有出现共享接口冲突/需要共同承诺时升级 T2
       ├─ T2 团队内需要多方评审/选择/承诺
       │    → 开会：2–3 个决策参与者；R1 立场 → R2 方案 → R3 定稿+ACK
       ├─ T3 跨会话/跨 owner、不可逆、高冲突或明确纪要要求
       │    → 开会：2–N 个决策参与者；完整 R1/R2/R3 + FINAL + ACK + 侧车 hash
       └─ 不能写成 1–3 个可判定问题
            → 不开会；先派证据任务/跑门禁，收敛后再回到本决策树
```

补充规则：
- **单人可完成**且无外部承诺 ⇒ 不因为“团队在”而开会；开会不能替代执行。
- **纯信息同步/纯通知** ⇒ 用 `[通知]` 前缀消息或状态页；需要留证时用一条带链接的异步消息，不占用会议轮次。
- **已有明确 owner 且决定可逆** ⇒ 先执行，事后再同步；不要用会议把决定权转移给无决策权的人。
- **用户点名开会** ⇒ 按最小充分规模开；T0 任务可先说明“无需会议，直接执行”，用户坚持才开。
- 不确定是否升级时，先选低一级并写明“升级条件”；不得默认开最大会。

### 0.5.3 规模、角色、quorum

| 级别 | 决策参与者 | 最小 quorum | 适用 |
|---|---|---|---|
| T2 | 2–3 人：convener + 1–2 个领域/证据/执行 owner | convener + ≥1 participant | 团队内方案评审/决策 |
| T3 | 2–N 人：convener + 各决策域 owner + 必要 veto/verify | convener + ≥2 participant，且所有 veto owner 在场/书面授权 | 跨会话/不可逆/冲突裁决 |

- **邀请谁**：按“谁能做这个决定 / 谁持有反证 / 谁执行 / 谁有 veto”选，不按职级、资历或“相关就拉”。
- **角色**（沿用 §2）：
  - convener：决定 owner，负责范围/议程/deadline；
  - participant：有决策权或证据责任的 owner；
  - scribe：默认 convener，负责写盘与 hash；
  - verify（可选，只读）：只复核证据/纪要不改实现；
  - observer：可旁听但**不计入 quorum**，不得用旁听人数充数。
- **quorum 不满足**：不启动 R1，不写 FINAL；先异步补人或降级为 T1，并在消息里写明缺谁。
- **ACK 仍按 §8/§11**：未 ACK 只算提案；缺席、不可达、未回复都**不折算同意**。
- T3 的 veto owner 未参与时，最多 `OPEN`/`ESCALATED`，不得写 `AGREED`。

**阶段选择**（与 §4 的 R1/R2/R3 对齐）：

| 需要 | 最小阶段 | 产出 |
|---|---|---|
| 信息同步/事实对齐 | 不开会；一条结构化消息或 R1 事实清单 | 事实/证据表 |
| 方案评审/比较选项 | R2（必要时先 R1） | `R2_OPTIONS.md` + 各方案赞成/反对 |
| 决策/定稿 | R2 → R3 → FINAL + ACK | `FINAL.md` + `ACK.md` |
| 冲突裁决 | R2；未收敛标 `ESCALATED` | 分歧表 + 待作者选项 |
| 复盘 | FINAL 后的小型复盘；不产生新决定则不新建 FINAL | 行动项/改进项 |

### 0.5.4 开会前信息整理（缺一即停）

开会前必须准备并写入 AGENDA（模板见 §6）：

1. **1–3 个可判定问题**：每题写“问题 / 选项或需回答 / 判定标准 / 证据或反证方法”；不能判定就不开。
2. **材料与证据**：给相对路径 + `file:line`/命令输出摘要；不把大文件粘进邀请；标明哪些是基线事实、哪些待验证。
3. **deadline**：ISO-8601 UTC 存储 + 本地时区显示；写明 R1/R2/R3 各自 deadline。
4. **通道与回投**：逐条确认可用（§7）；写清回投格式、字数、dedupeKey。
5. **参与方/quorum/角色**：按 §0.5.3 选人；写明谁不参与也不影响 quorum，谁缺席会阻塞。
6. **既有决议**：相关旧 FINAL/OPEN 项、反例、不可越过的门禁；避免重复会议或覆盖未关闭结论。

任一项填不出 ⇒ 回到 T0/T1 或先补证据；**不要先发会议邀请再补议程**。

### 0.5.5 示例

**示例 1（T0，不开会）**：单 agent 修一个局部函数并跑对应测试。
信号：跨域 0、证据 0、不可逆 0、冲突 0、时间窗 0、参与方 0，S=0。
决定：不邀请任何人；直接修改 + 运行测试 + 用一条消息回报文件/命令/结果。若用户点名“开个会”，先说明无需会议，用户坚持才走最小 T2。

**示例 2（T1→T2 边界，团队协作）**：A 改接口，B 改调用方，需要确认兼容契约。
信号：跨域 1、证据 1、不可逆 1、冲突 0/1、时间窗 1、参与方 1，S≈5 → 若一个 owner 能定契约则 **T1 不开会**：任务板写清接口、兼容窗口、验收；若双方对语义有明确分歧则升 **T2**：convener + A/B 两方，R1 各自立场，R2 两个选项，R3 定稿；quorum=convener+1，缺 B 则 OPEN。

**示例 3（T3，跨会话/不可逆）**：两个会话对“发布 vs 回滚”意见相左，涉及不可逆线上变更。
信号：跨域 2、证据 2、不可逆 2、冲突 2、时间窗 1、参与方 2，S=11 → **T3**。
邀请：convener + 发布 owner + 验证 owner + 受影响会话 owner（veto 方必须到）；R1 各自立场与证据、R2 发布/回滚/灰度三选项、R3 FINAL 四表；quorum=convener+≥2 且 veto 方在场；未 ACK 或 veto 方缺席 ⇒ `OPEN/ESCALATED`，不能写“大家同意发布”。

### 0.5.6 分诊反模式

- 把**派活/通知/日报**叫“开会”；会议没有需要共同承诺的决策。
- 没有 1–3 个可判定问题就发邀请；会上才现想议题。
- 为“对齐一下”开大会；能异步一条消息解决的事占用多人时间。
- 邀请所有相关人/旁听者凑 quorum；真正有决策权的人没到。
- 证据不足、门禁未跑就开会；把“大家觉得”当证据。
- 不可逆事项用“没人反对”代替 ACK；缺席/未回复当同意。
- T3 议题压成 T1 私聊，绕过记录、FINAL 和 ACK。
- 会议规模/阶段超出决策需要（T2 开成 T3，或 T0 拉全团队）。
- 重复开已关闭议题；不引用旧 FINAL，覆盖未关闭的 OPEN 项。

## 1 何时用 / 不用（§0.5 是完整分诊；本节做最终快速确认）
- ✅ 多会话对同一议题表态/表决/定稿；跨域决策；冲突裁决；复盘；用户点名“开会/纪要”。
- ✗ 单人派活（直接 `send_message`）；纯通知（`[通知]` 前缀投递）；议题还不可判定（先收敛成 1–3 个可判定问题）；需要先跑门禁的问题（先跑）。
- 进入会议前，先按 §0.5 给出 T0–T3 与理由；T0/T1 不应进入本流程。

## 2 角色
| 角色 | 谁 | 必须做 | 禁止 |
|---|---|---|---|
| 发起/主持 convener | 你 | 定 meetingId/议程/deadline/通道；汇总；收敛；宣布状态 | 替人表态；把未回复写成同意 |
| 参与方 participant | 被召集会 | 一轮一次四段；对定稿 ACK 或提异议 | 沉默；超字数；只表态无依据 |
| 记录 scribe | 默认=发起人 | 写 AGENDA/R*/FINAL/ACK/messages.jsonl；算 hash | 美化发言；删反对意见 |
| 旁证 verify（可选） | 只读方 | 复核纪要与 hash/ACK | 改实现；越权写公共文件 |

## 3 meetingId 与目录（单一权威）
- `meetingId` 正则：`^[A-Za-z0-9._-]{6,40}$`，建议 `<PFX>-<YYYYMMDD>[-R<N>]`（如 `SN-20261104-R2`）。
- 目录名 = `meetingId`；一个会议一个目录；旧目录不改名（标 `legacy-name`）。
- 文件：`AGENDA.md`、`R1_POSITIONS.md`、`R2_OPTIONS.md`、`R2_POSITIONS.md`、`FINAL.md`、**`FINAL.sha256`（侧车）**、`ACK.md`、`messages.jsonl`、`scratch/`。
- **FINAL.md 是唯一权威**；`MINUTES.md` 若项目要求，只放 ≤5 行指针，不双写全文。

## 4 轮次与决议状态
| 轮 | 输入 | 产出 | 退出判据 |
|---|---|---|---|
| R1 立场 | 议题+材料 | `R1_POSITIONS.md` | 每人一条四段，或已记录缺席/不可达 |
| R2 收敛 | R1 立场 | `R2_OPTIONS.md`（2–3 个可选项） | 每人对每选项：赞成/反对/条件赞成+理由 |
| R3 定稿 | R2 结果 | `FINAL.md` + `FINAL.sha256` + `ACK.md` | 全员 ACK，或缺席/不可达已记录且条目降级 `OPEN` |

决议状态只能四选一：`AGREED`（全员 ACK/明确赞成）、`CONDITIONAL`（条件必须转成行动项）、`OPEN`（写卡点/谁查/何时回）、`ESCALATED`（待作者，列选项与各方立场）。
禁止把“没达成一致”写成“一致通过”；未 ACK 条目只算提案。

## 5 发言格式（强制四段）
```
【结论】一句话立场（能判真假）
【依据】文件:行号 / 命令+输出摘要 / 实测数字
【分歧】与已有结论的冲突（无则“无”）
【建议】谁 / 做什么 / 何时 / 怎么验
```
不合格（发起方应退回，唯一允许退回的情形）：缺段；只有结论无依据；正文汉字超预算（默认 ≤400，不含 `文件:行号`/代码块/表格）；依据是未核实的转述。

## 6 议程模板（AGENDA.md，可直接复制）
```markdown
# <meetingId> · R1 议程：<议题一句话>

- meetingId：`<meetingId>`｜类型：方案评审/决策/冲突裁决/同步/复盘
- 发起·主持：<alias>（<session短码>）｜记录：<alias>｜旁证（只读）：<alias|无>
- pipeRoot：`<绝对或相对路径>`
- 参与方：| alias | displayName | session | 职责域 | 本轮产出 |
- 轮次与 deadline（存储 ISO-8601 UTC，显示本地时区）：
  | R1 | 立场（四段） | 2026-11-04T07:00:00Z（15:00+08:00） |
  | R2 | 方案表决 | … |
  | R3 | 定稿逐条 ACK | … |
- 回投通道（逐条标可用/不可用；未写=未授权）：
  1. pipe2 post → inbox/<发起人> ✅
  2. pipe2_session_post（按 session id，仅投递无 ACK）✅
  3. 书面立场落 `<会议目录>/scratch/R1_<alias>.md`（仅本轮、该路径）✅
- 材料：<相对路径列表>（参与者自行读，消息不附全文）
- 字数预算：正文汉字 ≤400；决议规则：quorum=发起人+≥1 参与方；未 ACK 只算提案
- 议题（每个必须可判定）：
  ## A. <议题一>｜问题 / 需回答 / 判定标准
- 回复要求：固定四段，回投上述通道，正文写 meetingId / round / dedupeKey / re:<原 subject>
```

## 7 投递、幂等与证据（协议 v0.2）
- 幂等键：`dedupeKey = <meetingId>|<round>|<from>|<to>|sha256(<body>)`；发送前查 `messages.jsonl`，已存在 ⇒ 跳过。
- 消息必须带 `msgId`（`<meetingId>-<round>-<from>-<NN>`）；正文首行：`meetingId=…; round=…; msgId=…; dedupeKey=…`。
- 通道阶梯（按可用性）：① pipe2 文件通道（有 route）→ ② `pipe2_session_post`（按 session id，body ≤4000）→ ③ AGENDA 授权的 `scratch/` 书面立场 → ④ 人工转达（不得据此判“已表态”）。①+② 都失败 ⇒ 标“不可达”，**不计缺席**。
- subject 约定：R1 含「会议邀请」；催办含「请表态」；R2/R3 加「请按四段格式」→ 否则对方 `read` 不会被提示表态。
- 每条消息登记 `messages.jsonl`（追加，一行一 JSON）：
```json
{"meetingId":"SN-20261104-R2","round":"R1","msgId":"SN-20261104-R2-R1-toolbox-env-01",
 "dedupeKey":"SN-20261104-R2|R1|toolbox-env|game-captain|sha256:<hex>",
 "from":"toolbox-env","to":"game-captain","at":"2026-11-04T05:00:00.000Z",
 "type":"invite|position|supplement|final","file":"R1_game-captain.md",
 "sha256":"<hex>","bytes":20841,"lastWrite":"2026-11-04T13:06:00+08:00",
 "deliveredAt":"…","ack":"…|null"}
```
- 证据：post 的 `id/seq`；`ack/<to>/<id>.ack`；`team_audit` 的 `alive/unread/lastDeliveredAt/lastAckAt`；`session-delivery.jsonl` 的 `bodySha256`。
- **delivered ≠ ACK**：投递成功仅证明送达；ACK 必须有对方回复/立场文件/ACK.md。

## 8 deadline 与缺席（三态 + 证据）
- deadline 一律 ISO-8601 UTC 存储 + 本地时间显示；禁止无时区短格式。
- 判缺席前取证（全附）：`lastDeliveredAt`、`now`、`lastAckAt/unread`、`alive`、`deadline(时区)`、提醒次数+msgId。
- 三态：`alive=false` ⇒ **不可达（不计缺席）**；`unread=0 且未回` ⇒ **已读未回**（单独记录）；`alive && unread>0 && 超 deadline` ⇒ **缺席**。
- 超时前先发 1 次带 deadline 的提醒（每人每轮 ≤2 次）；缺席不阻塞定稿，但相关条目降级 `OPEN`，异议权保留到实施前；缺席 ≠ 默认同意。

## 9 只读角色写盘（scratch 兜底，零策略改动）
- 只读角色（`cr-*`/`verify`）写会议目录会被 roleWritePolicy deny；**允许写任意 `scratch/`**。
- 书面立场落 `<会议目录>/scratch/<alias>_<round>_<msgId>.md`，并通知发起人；由 scribe 誊清进正式文件（原话保留、标来源 msgId）。
- 仍被 deny ⇒ 改交发起人代录，并附本文件路径与 sha256；**禁止**尝试绕过策略。

## 10 FINAL.md 四表模板（R2 D33；可直接复制）
```markdown
# <meetingId> · FINAL（定稿纪要）

- 版本：v1｜定稿：<ISO UTC / 本地>｜类型：<会议类型>
- meetingId：`<meetingId>`｜supersedes：`<旧版本文件或 null>`｜supersededBy：`<null>`
- 主持/记录/旁证：<alias>/<alias>/<alias|无>｜参与方：<N>｜缺席：<alias 列表|无>

## 表 1 · 决策表
| # | 决策（一句话、可执行） | 状态 | ACK（谁/何时） | 依据 file:line | 推翻条件（若 X 不成立则撤回） | 反证方法（可执行） |
|---|---|---|---|---|---|---|
| D-1 | <…> | AGREED | A(12:20)、B(12:22) | AGENDA.md:36 | 若 <观测 X> 为假 | <命令/测试> |
| D-2 | <…> | OPEN | —（缺席） | … | … | … |

## 表 2 · 证据表
| # | 断言 | 证据（file:line / 命令输出） | 采集人 | 时间 | 可复现 |
|---|---|---|---|---|---|

## 表 3 · 分歧表（原样保留，含反对者与理由）
| # | 分歧点 | 各方立场 | 状态 | 处理/再议 |
|---|---|---|---|---|

## 表 4 · 行动表
| # | 动作 | 负责人 | 截止（含时区） | 验收（可执行） | 依赖 |
|---|---|---|---|---|---|

## 修订记录（只追加）
| 版本 | 时间 | 变更摘要 | FINAL.sha256 | 变更人 |
|---|---|---|---|---|
```
- 每条 `AGREED/CONDITIONAL` 必须同时有：在场 ACK + 依据 + 推翻条件 + 反证方法；缺一则不得标 `AGREED`。
- 缺席方在表 1 标 `OPEN` 或 `CONDITIONAL`，并注明“实施前再确认一次；未确认标注该方未参与”。

## 11 ACK.md 模板
```markdown
# <meetingId> · ACK 清单

| 参与方 | 立场 msgId | 文件 | sha256 前 12 | ACK 时间（含时区） | 方式 | 条件/异议 |
|---|---|---|---|---|---|---|
| <alias> | <msgId> | R1_<alias>.md | <hex12> | 2026-11-04T13:06+08:00 | 回复/立场文件/ACK | 无 |
```
- ACK 必须能回答：谁、何时、对哪条 msgId、用什么方式、附了什么条件。
- 缺席/不可达：在 ACK.md 单列状态与四项证据，不折算成 ACK。

## 12 侧车 hash（生成 + 任何一方复核）
```bash
# 生成 FINAL.sha256（写完 FINAL.md 后执行一次；正文不自包含 hash 行）
node -e 'const fs=require("fs"),c=require("crypto"),p=require("path");const f=process.argv[1];const h=c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");fs.writeFileSync(f.replace(/\.md$/,".sha256"),h+"  "+p.basename(f)+"\n");console.log("sha256:"+h)' docs/meetings/<meetingId>/FINAL.md

# 复核（不一致 exit 1；任何参与者都能跑）
node -e 'const fs=require("fs"),c=require("crypto");const f=process.argv[1];const want=fs.readFileSync(f.replace(/\.md$/,".sha256"),"utf8").split(/\s+/)[0];const got=c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");console.log(got===want?"HASH-OK "+got:"HASH-MISMATCH got="+got+" want="+want);process.exit(got===want?0:1)' docs/meetings/<meetingId>/FINAL.md
```
- 生成口径：UTF-8、NFC、LF、逐行去行尾空白；hash 覆盖 FINAL.md 精确字节（侧车不参与）。
- 改 1 字节必须 hash 变；定稿后只追加修订（版本+1 + 变更说明 + 重算侧车），不改历史结论。
- 参与方回帖可附自算 hash；不一致视为版本分叉 ⇒ 定稿作废、重发并记录。

## 13 收工检查清单
- [ ] 每个议题可判定，deadline 带时区，回投通道授权明确
- [ ] 每条消息有 msgId + dedupeKey + bodySha256 + deliveredAt，无重复投递
- [ ] 每人状态 ∈ {已回, 已读未回, 缺席, 不可达} 且有四项证据
- [ ] FINAL 四表齐全；每条结论有状态 + 依据 + 推翻条件 + 反证方法
- [ ] `FINAL.sha256` 已生成且复核 HASH-OK；`ACK.md` 的 N/M 与 messages.jsonl 对得上
- [ ] 缺席者已通知；`INDEX.md` 已更新

## 14 反模式
- 把派活叫“开会”；开完没结论；只写结论不写分歧；用“未回复”推断“反对”。
- 邀请不写格式/通道，指望对方自己查；同内容重复投递；跨 root `--all`。
- 定稿后偷改 FINAL 不升版本；纪要写绝对路径/密钥；把 delivered 当 ACK。
