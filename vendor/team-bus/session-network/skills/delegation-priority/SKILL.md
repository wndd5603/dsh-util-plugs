---
name: delegation-priority
description: >-
  优先指派判定与任务包规范：收到任务后先判断“自己干还是派子智能体”，按产物规模阈值决策，
  用六栏任务包派活，并记录 shadow 审计。
  触发词：派活、派单、优先指派、委派、任务拆分、自己干还是派、子智能体、teammate、subagent、
  spawn、产物规模、任务包、shadow、过度指派、失败回退。
  内容：60 秒判定流程（不可外包清单 → 产物规模阈值【或】关系 → 灰区三问 → self 白名单）、
  任务包六栏模板、并行与回退条件、防过度指派上限、shadow/audit 字段。
  不用于：具体实现、验收门禁（verify 侧）、会议流程（session-meeting）。
---

## 0. 前置检查（可执行，先用工具再按流程）

1) **先调用 `network_info({section:'network'})`**；若返回 `network === null`（本工作区未接入交流网）⇒ 本 skill 全部流程跳过，按普通会话工作。
2) 若工具不存在/调用失败 ⇒ 视为 `network === null`，跳过联网流程（fail-open）。
3) 只有 `network !== null` 时，才继续本 skill 的后续章节。

# 优先指派（delegation-priority）

> 目标：把“高工作量”派出去，把“低工作量/决策”留给自己；**不按工具调用次数判断**。
> 只做 shadow 记录（不硬拦）；阈值与回退规则由配置/审计数据校准。

## 0 何时用 / 不用
- ✅ 收到一个可执行任务、准备开工前；或准备 `spawn_teammate`/`send_message` 派活前。
- ✗ 纯问答、单条命令查询、已在执行中的小步骤（不要每个动作重判）。

## 1 判定流程（≤60 秒，按顺序）
1. **命中“不可外包清单”（§2）⇒ `self`**，写 `reasonCode`（decision/coordination/security），结束。
2. **估产物规模**（开工前可估，不估步数）：预计产物行数 / 字节数 / 需读输入文件数。
   - **≥150 行 OR ≥8 KB OR 需读 ≥3 个输入文件 ⇒ `delegate`**（或关系，满足一条即派）。
   - **<50 行且单文件 ⇒ `self`**（`reasonCode=low-work`），结束。
3. **灰区**（50–150 行、1–2 文件）⇒ 三问，任一为“是”则 `delegate`：
   - Q1 需要独立上下文？（研究/大段写作/跨多文件分析）
   - Q2 可并行？（≥2 个互不依赖、无顺序约束的子任务）
   - Q3 可独立验收？（有明确产物路径 + 可写 ≥1 条验收检查）
4. **兜底**：仍判不清 ⇒ `self` + `reasonCode=unclear`，并在回执里说明“下次可预拆分”。
5. 无论哪种决定，**写一行 shadow 审计**（§7）；`delegate` 则按 §3 发六栏任务包。

## 2 不可外包清单（队长/主控必做，不派）
- 目标/范围定义、方案取舍与决策、验收标准定义、汇总定稿、对外汇报/向作者说明。
- 跨路冲突裁决、安全/隐私敏感决策、成员增删与身份（alias/roleName）变更。
- 协调类：排期、等待、催办、结果整合。
- **紧急修复 + 无合适角色**：可 `self`，但必须当场记录原因、事后补派复验（`reasonCode=no-role`）。

## 3 任务包六栏（缺一栏 = 信息不足，队员有权退回）
```markdown
【背景】一句话目标 + 为什么现在做 + 上游产物路径（如有）
【输入】绝对路径 + 必读顺序 + 版本指纹（sha256 前 12 / bytes / lastWrite）
        + 冲突取值规则：若文件与任务包版本不一致，以【文件内容】为准并回报差异
【验收】3–6 条可勾选，含 1 条“不许做什么”的负向检查；每条给命令/判据
【边界】可写文件（独占范围）；禁改文件/目录；能否新建目录；是否只读
【回传】硬上限 ≤N 行；必含【结论】【数据】【冲突】【未解】四段；结论带 file:line
【自检栏】请报告任务包/规则本身的缺陷（缺字段、矛盾、不可执行处）
```
- 写范围必须**互斥**：同一文件同一时刻只一个写者；并行前在任务卡写明 scope。
- 版本指纹**由任务包自带**，不要让队员去猜；过期值必须显式标注。
- 派出去前先 `list_agents` 核对目标存在；`send_message` 到 inactive 成员会启动它一轮。

## 4 并行与依赖
- 可并行条件：只读任务，或写范围互斥（不同目录/文件）；否则串行并说明依赖。
- 单轮并行 ≤2–3 个子任务；更多则分批，避免协调开销与上下文碎片。
- 任务卡写 `taskId` + `blockedBy`；完成后立即回收结果并独立复验关键数字。

## 5 防过度指派（上限）
- 单轮启动 ≤2–3 个 teammate；每个必须有“产物 + 验收”，禁止 dummy task 凑数。
- 优先复用已有成员，不为一次性任务新建角色；连续 2 次失败/超时 ⇒ 队长接手并记录原因。
- 委派成本 > 自做成本（预计净亏）⇒ `self` + `reasonCode=coordination`，并写清理由。

## 6 回退条件（命中即接手）
- 子任务连续 2 次失败/超时；产出 < 预估 50% 且无法补齐；写范围发生冲突；发现安全/隐私风险。
- 回退动作：收回 scope → 记录 `rollbackReason` → 由队长接手或改派 → 在审计行标 `fallback=true`。

## 7 shadow / audit（只记录，不阻断）
每任务决策一行 JSONL（追加到项目审计文件或由工具写入）：
```json
{"at":"ISO8601","actor":"<alias>","taskId":"<id>","decision":"delegate|self",
 "riskLevel":"high|mid|low","suggestedHit":true,"actualDelegate":true,
 "sizeEstimate":{"lines":0,"kb":0,"inputFiles":0},
 "reasonCode":"low-work|serial-dependency|unique-context|security|deadline|no-role|coordination|unclear|decision",
 "delegateTo":"<alias|null>","runId":"<id|null>","evidencePath":"<相对路径>","fallback":false}
```
- 校准口径：漏报率 = 高工作量却 `self` 且无有效 reason 的占比（目标 ≤20%）；误报率 = 低工作量却 `delegate` 的占比（目标 ≤15%）；超阈值 ⇒ 回退人工复核/调整阈值。
- 不做每动作硬门禁；审计字段不含对话正文/PII。

## 8 收工检查
- [ ] 每个 `delegate` 都有六栏任务包 + 互斥写范围 + 验收命令
- [ ] 每个 `self` 有 reasonCode；高工作量 self 有明确理由
- [ ] 委派结果已回收并独立复验关键数字，未默认“绿了”
- [ ] shadow 行已写；未完成项/风险有记录
