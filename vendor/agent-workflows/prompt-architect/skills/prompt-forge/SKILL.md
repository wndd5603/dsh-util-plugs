---
name: prompt-forge
description: >
  Prompt Architect（镜语·迭代器）的流程技能：以 S0–S7 阶段推进「优化写视频提示词的智能体人格提示词」，
  先用 prompt_forge_status/next 披露当前阶段与下一步，再按阶段产出演练/扫描/疏漏/补丁/新版提示词文件并用
  prompt_forge_advance 记录；S6 必须由空上下文子智能体（subagent，禁用 subagent_fork）按 packet 独立验证，
  用 prompt_forge_verify_record 记录九维 verdicts。触发场景：(1) 收到待优化的人格提示词与指令样本；
  (2) 需要在长流程中避免跳步/忘记门禁；(3) 需要可追溯的疏漏—补丁—验证闭环。
---

# Prompt Architect（镜语·迭代器）· Skill

> 插件 `dsh-prompt-architect` v1.0.0｜人格提示词元优化器：**优化「写视频提示词的智能体人格提示词」**，不直接写视频提示词。
> 本 skill 是流程说明书；真正的进度与门禁由工具持有。会话里先 `prompt_forge_status`，再 `prompt_forge_next`，不要靠记忆。

## 0. 铁律

1. **演练先于评价**：不拿指令样本真跑一遍，不得出疏漏清单。
2. **疏漏必须可追溯**：每条疏漏 = 缺失规则 → 哪个演练输出问题 → 不补会怎样。
3. **补丁必须规则化**：带编号、触发条件、强制动作；禁止「要更完整」这类空话。
4. **只增不删**：原有效规则保留；冲突显式写优先级，不默默覆盖。
5. **验证优先空上下文子智能体**：S6 必须用 `subagent`（新会话）按 packet 验证；**禁止 `subagent_fork`**。
6. **不越权改创作意图**：只优化结构与完备性，风格/题材约束原样保留。
7. **状态外置**：每阶段结束调用 `prompt_forge_advance` 记录产物；缺产物会被门禁拒绝，不要绕过。
8. **S6 是人工/独立验证门禁**：必须由空上下文 `subagent` 按 packet 验证并写入 `prompt_forge_verify_record`；
   模型不能自证通过。`verifyFallbackReason` 只是显式降级，必须由人工确认并在 ledger 留痕；S6 缺记录时
   不得进入 S7。

## 1. 工具矩阵

| 工具 | 用途 | 关键输入 |
|---|---|---|
| `prompt_forge_status` | 读当前阶段/产物/验证摘要 | `projectDir?` |
| `prompt_forge_next` | **根据进度披露下一步流程**（步骤/产物/验收/坑/advance 调用） | `projectDir?` |
| `prompt_forge_advance` | 记录本阶段产物并推进；校验文件存在+哈希；S6 需验证记录 | `artifacts`, `verifyFallbackReason?` |
| `prompt_forge_verify_dispatch` | 生成只读验证任务包（九维+JSON verdict 格式），返回投递指令 | `focus?` |
| `prompt_forge_verify_record` | 记录子智能体 verdicts；要求覆盖九维；写 results.json | `runId`, `verdicts` |
| `prompt_forge_reset_subagent` | 归档某次 run 的本地产物并标记关闭（上下文卫生） | `runId`, `reason?` |

`projectDir` 缺省 = 当前会话 cwd（或插件配置的 `defaultWorkDir`）。所有产物必须是 project 内文件。

## 2. 阶段与产物（状态机）

| 阶段 | 名称 | 必产产物（artifacts key） |
|---|---|---|
| S0 | 解析输入 | `targetPrompt`、`samples`（`goal` 可选） |
| S1 | 实战演练 | `drill` |
| S2 | 九维扫描 | `scan` |
| S3 | 疏漏清单 | `issues` |
| S4 | 补丁设计 | `patches` |
| S5 | 装配新版 | `assembled` |
| S6 | 自检闭环 | `selfCheck` + **空上下文验证记录** |
| S7 | 交付 | `deliverable` → 状态 `done` |

推荐文件命名（project 内相对路径）：`notes/target.md`、`notes/samples.md`、`notes/goal.md`、`notes/drill.md`、`notes/scan.md`、`notes/issues.md`、`notes/patches.md`、`notes/assembled.md`、`notes/selfCheck.md`、`notes/deliverable.md`。

## 3. 进度驱动的循环（核心用法）

```
prompt_forge_status   → 我在哪一阶段、已有哪些产物
prompt_forge_next     → 这一阶段的具体步骤/产物/验收/坑
（做这一步：读文件、写产物）
prompt_forge_advance  → 记录产物；缺什么会被拒绝并列出
```

- 每次 `advance` 都会追加 `.prompt-forge/ledger.jsonl`（只追加，可用于复盘）。
- 状态文件：`<project>/.prompt-forge/state.json`；`done` 后如需新一轮，换新 project 目录。
- 没有 subagent 工具的宿主：S6 可在 advance 时传 `verifyFallbackReason` 显式降级（会入 ledger，但不推荐）。

## 4. S6 空上下文子智能体验证协议

1. 写 `notes/selfCheck.md`（七项自检表）。
2. 调 `prompt_forge_verify_dispatch` → 得到 `packet` 文本与 `runId`。
3. 用 **`subagent` 工具**（新会话、空上下文）把 packet 原文作为 prompt 投递；**不要用 `subagent_fork`**（会继承本会话结论）。
4. 子智能体返回 JSON `verdicts`（九维、pass/warn/fail、file:line 证据）→ `prompt_forge_verify_record({ projectDir, runId, verdicts })`。
5. 有必修 `❌` → 回 S4 补丁 → 重跑 S5/S6；全部通过后 `prompt_forge_advance` 进入 S7。
6. 需要清理该 run 的本地产物：`prompt_forge_reset_subagent({ runId })`（归档到 `.prompt-forge/subagent-runs-archive/`，不删会话记录）。

> 为什么强调空上下文：同一会话里自检会带着自己的推理与结论，等于「自己判自己」；空上下文子智能体只看文件，才能暴露提示词的规则缺口。

## 5. 九维扫描（每维≥3 问）

| 维度 id | 维度 | 扫描问题（摘要） |
|---|---|---|
| coverage | 覆盖性 | 该管却没管的场景？样本里规则没覆盖到的情况？ |
| decision | 裁决性 | 该写/不该写/降级写没判定？条件触发是否双向？ |
| conflict | 冲突性 | 两条规则打架？谁优先？ |
| traceability | 可追溯性 | 每个省略/例外能否追溯到规则编号？ |
| consistency | 一致性 | 跨镜头/跨段落/跨主体的连续性有无校验？ |
| timing | 时序性 | 有无统一时间轴？事件/反应/切换点对齐？ |
| format | 格式性 | 必填/选填/N/A/长度预算/降级变体？ |
| executability | 可执行性 | 规则能否直接写进输出？有无空话？规则数失控？ |
| failure | 失败预判 | 最可能坏在哪？有无生成后校验？ |

常见疏漏类型库（对照）：条件缺失、双向缺失、冲突未处理、跨对象无校验、时序缺失、归属缺失、歧义未消解、格式未定义、可追溯性缺失、失败预判缺失、计数口径不清、降级路径缺失、空话规则、规则膨胀、越权改写。

## 6. 输出格式（严格五段）

**A 演练结果**（逐样本：摘要→完整结果→自由发挥点）｜**B 疏漏清单**（编号|维度|缺失规则|演练证据|后果|必修/建议/可选|补丁方向）｜**C 新版人格提示词全文**（版本号+变更摘要+全文+结尾摘要）｜**D 变更说明**（条目|类型|说明|对应疏漏）｜**E 遗留风险与建议**。

七项自检：疏漏覆盖 / 规则调用 / 冲突检查 / 格式可执行 / 规模可控 / 意图保持 / 版本可追溯。

## 7. English quick reference

- Tools: `prompt_forge_status` → where am I; `prompt_forge_next` → the exact next-step contract; `prompt_forge_advance` → record artifacts and move on (phase-gated, hash-checked); `prompt_forge_verify_dispatch` / `verify_record` / `reset_subagent` → empty-context verification loop.
- Workflow: S0 parse inputs → S1 live drill → S2 nine-dimension scan → S3 defect list → S4 rule patches → S5 assemble new prompt → S6 verification (fresh `subagent`, never `subagent_fork`) → S7 five-section deliverable.
- Rule: never critique without a real drill; every defect cites drill evidence; every patch has id + trigger + mandatory action; never rewrite the user's creative intent.

## 8. 失败处理

- `advance` 报缺产物：按 `prompt_forge_next` 的 `produce` 清单补文件后重试；不要伪造路径。
- `verify_record` 报缺维度：补齐九维 verdict；不要删维度凑数。
- 子智能体返回 ❌：回 S4，把对应疏漏补丁写进 `patches`，再装配并重验。
- 验证记录丢失/需重跑：重新 `verify_dispatch` 得新 runId；旧 run 可 `reset_subagent` 归档。
