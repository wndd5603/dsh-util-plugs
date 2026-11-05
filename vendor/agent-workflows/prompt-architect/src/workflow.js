/**
 * Prompt Architect workflow spec (S0–S7) shared by tools, CLI, and tests.
 *
 * Each phase declares: bilingual title/purpose, the artifacts it must produce,
 * the input checklist, concrete steps, acceptance criteria, common pitfalls, and
 * the exact tool call that records completion. Nothing here touches the host;
 * the data is intentionally declarative so the skill and preset stay in sync.
 */

/** Artifact keys are stable identifiers persisted in state.json. */
export const ARTIFACTS = {
  targetPrompt: { zh: '待优化的人格提示词（文件）', en: 'Target persona prompt (file)' },
  samples: { zh: '指令样本（文件）', en: 'Instruction samples (file)' },
  goal: { zh: '优化目标（文件，可选）', en: 'Optimization goal (file, optional)' },
  drill: { zh: '演练结果（文件）', en: 'Drill results (file)' },
  scan: { zh: '九维扫描表（文件）', en: 'Nine-dimension scan table (file)' },
  issues: { zh: '疏漏清单（文件）', en: 'Defect list (file)' },
  patches: { zh: '补丁设计（文件）', en: 'Patch design (file)' },
  assembled: { zh: '新版人格提示词全文（文件）', en: 'Assembled persona prompt (file)' },
  selfCheck: { zh: '自检表（文件）', en: 'Self-check table (file)' },
  deliverable: { zh: '五段交付物（文件）', en: 'Five-section deliverable (file)' },
}

/**
 * Phase order. `produce` lists artifacts written during the phase; `advance`
 * records them and moves to the next phase. S6 additionally requires a
 * verification record produced by an empty-context subagent (or a recorded
 * fallback reason).
 */
export const PHASES = [
  {
    id: 'S0',
    zh: '解析输入',
    en: 'Parse inputs',
    purpose: {
      zh: '读待优化提示词与指令样本，识别结构、编号体系、样本差异点；把目标写成约束。',
      en: 'Read the target prompt and samples; map structure, numbering, sample differences; record the goal as a constraint.',
    },
    produce: ['targetPrompt', 'samples', 'goal'],
    required: ['targetPrompt', 'samples'],
    steps: {
      zh: [
        '用 fs 工具读入目标提示词与指令样本，逐段标注结构（角色/任务/原则/流程/规则组/维度/格式/禁令）。',
        '识别编号体系（如 A–AD），记录已用编号；识别样本类型、覆盖场景、边界情况、样本差异点。',
        '把目标提示词全文与样本分别落盘（例如 notes/target.md、notes/samples.md），优化目标写 notes/goal.md（可选）。',
        '调用 prompt_forge_advance，把三个文件作为 artifacts 记录，进入 S1。',
      ],
      en: [
        'Read the target prompt and samples with fs tools; annotate the structure section by section.',
        'Identify the numbering system and used ids; classify sample types, coverage, edge cases, differences.',
        'Persist the prompt and samples as files (notes/target.md, notes/samples.md, optional notes/goal.md).',
        'Call prompt_forge_advance with those artifacts to move to S1.',
      ],
    },
    acceptance: {
      zh: ['两个必填文件存在且可读', '能说出编号体系与样本差异点', '优化目标已记录或明确默认「更全+更稳」'],
      en: ['Both required files exist and are readable', 'Numbering system and sample differences are named', 'Goal recorded or defaulted to completeness+stability'],
    },
    pitfalls: {
      zh: ['不要读两句就开始下结论', '不要漏掉样本中的边界场景'],
      en: ['Do not judge after a quick read', 'Do not miss edge cases in the samples'],
    },
  },
  {
    id: 'S1',
    zh: '实战演练',
    en: 'Live drill',
    purpose: {
      zh: '用指令样本逐条按目标提示词真实产出结果，并标出「原提示词未规定、我在自由发挥」的点。',
      en: 'Run the target prompt on every sample for real, marking every place where you had to improvise because the prompt was silent.',
    },
    produce: ['drill'],
    required: ['drill'],
    steps: {
      zh: [
        '对每个样本完整扮演目标提示词角色，按其输出格式产出结果，不替它补规则。',
        '凡规则未覆盖处，按自由发挥写，并在结果后标注「自由发挥点清单」。',
        '把演练结果写成 notes/drill.md，逐样本含：样本摘要→完整结果→自由发挥点清单。',
        '调用 prompt_forge_advance 记录 drill，进入 S2。',
      ],
      en: [
        'Play the target persona for each sample and produce its full output format; never add rules it lacks.',
        'Where the prompt is silent, improvise and list each improvisation explicitly.',
        'Write notes/drill.md with sample summary, full output, and improvisation list per sample.',
        'Call prompt_forge_advance with drill to move to S2.',
      ],
    },
    acceptance: {
      zh: ['每个样本都有完整结果', '自由发挥点可追溯到具体输出片段', '没有替目标提示词补规则'],
      en: ['Every sample has a complete result', 'Each improvisation cites a concrete output fragment', 'No rules were added on its behalf'],
    },
    pitfalls: {
      zh: ['演练写得像点评（必须先有输出）', '把「自由发挥」当成允许编造规则'],
      en: ['Writing critique instead of output', 'Using improvisation as an excuse to invent rules'],
    },
  },
  {
    id: 'S2',
    zh: '九维扫描',
    en: 'Nine-dimension scan',
    purpose: {
      zh: '按九维扫描法逐维扫描（覆盖/裁决/冲突/可追溯/一致/时序/格式/可执行/失败预判），每维至少三个问题。',
      en: 'Scan all nine dimensions, at least three questions each.',
    },
    produce: ['scan'],
    required: ['scan'],
    steps: {
      zh: [
        '对九个维度逐维按「扫描问题」列出发现，每维至少 3 条问题与对应证据（引用演练输出片段）。',
        '用疏漏类型库（15 类）做交叉核对，命中即记为疑似疏漏。',
        '写出 notes/scan.md（九维表格：维度|问题|证据|疑似类型）。',
        '调用 prompt_forge_advance 记录 scan，进入 S3。',
      ],
      en: [
        'For each of the nine dimensions list findings with evidence from the drill output.',
        'Cross-check against the 15-type defect library.',
        'Write notes/scan.md as a table.',
        'Call prompt_forge_advance with scan to move to S3.',
      ],
    },
    acceptance: {
      zh: ['九维齐全', '每维≥3 条并带证据', '类型库交叉核对有痕迹'],
      en: ['All nine dimensions present', 'At least 3 findings per dimension with evidence', 'Defect-library cross-check recorded'],
    },
    pitfalls: {
      zh: ['只写维度名不写问题', '用「不够完整」之类无证据判断'],
      en: ['Listing dimension names without findings', 'Evidence-free judgments'],
    },
  },
  {
    id: 'S3',
    zh: '疏漏清单',
    en: 'Defect list',
    purpose: {
      zh: '把扫描结果收敛为可排序清单：编号|维度|缺失规则|演练证据|后果|必修/建议/可选|补丁方向。',
      en: 'Turn findings into a ranked list with evidence, consequence, severity, and patch direction.',
    },
    produce: ['issues'],
    required: ['issues'],
    steps: {
      zh: [
        '逐条写疏漏，编号可用 D1、D2…；每条必须有演练证据片段。',
        '标注「必修/建议修/可选」，按影响排序；无证据的条目不进清单。',
        '写出 notes/issues.md。',
        '调用 prompt_forge_advance 记录 issues，进入 S4。',
      ],
      en: [
        'Write each defect with id D1, D2…; every entry cites drill evidence.',
        'Mark must/should/optional and rank by impact; drop evidence-free items.',
        'Write notes/issues.md.',
        'Call prompt_forge_advance with issues to move to S4.',
      ],
    },
    acceptance: {
      zh: ['每条疏漏有编号、证据、后果', '严重级别齐全', '必修项可映射到补丁方向'],
      en: ['Each defect has id, evidence, consequence', 'Severity assigned', 'Must-fix items map to a patch direction'],
    },
    pitfalls: {
      zh: ['把「我建议」当疏漏', '清单与扫描表脱节'],
      en: ['Treating preference as a defect', 'List not traceable to the scan table'],
    },
  },
  {
    id: 'S4',
    zh: '补丁设计',
    en: 'Patch design',
    purpose: {
      zh: '为必修疏漏写规则化补丁：编号|触发条件|强制动作|与其他规则关系，并同步流程/维度/格式/禁令四处。',
      en: 'Design executable patches (id, trigger, mandatory action, relations) and sync them into all four call sites.',
    },
    produce: ['patches'],
    required: ['patches'],
    steps: {
      zh: [
        '每条必修疏漏至少一条新规则，沿用原编号体系（AE、AF 或 A15 子编号）。',
        '每条规则必须写「模型读到它，下一步会做什么具体动作」；禁止空话。',
        '写明每条新规则在「流程步骤/维度清单/输出格式/禁止行为」中至少两处的落点。',
        '写 notes/patches.md，调用 prompt_forge_advance 记录 patches，进入 S5。',
      ],
      en: [
        'At least one new rule per must-fix defect, reusing the target numbering scheme.',
        'Each rule must state the concrete next action; no empty advice.',
        'Name at least two call sites where each new rule is invoked.',
        'Write notes/patches.md and advance to S5.',
      ],
    },
    acceptance: {
      zh: ['每条必修有规则', '每条规则有触发条件与强制动作', '调用点≥2 处', '编号不冲突'],
      en: ['Every must-fix has rules', 'Every rule has trigger + mandatory action', 'At least two call sites', 'No id collisions'],
    },
    pitfalls: {
      zh: ['空话补丁', '只加规则不改流程', '重排原编号'],
      en: ['Empty patch prose', 'Rules added without wiring', 'Renumbering original rules'],
    },
  },
  {
    id: 'S5',
    zh: '装配新版',
    en: 'Assemble new version',
    purpose: {
      zh: '按原结构装配完整新版全文（不跳段不缩写），写版本号与变更摘要，并检查规则总量。',
      en: 'Assemble the full new prompt in the original structure, with version and change summary, and check rule budget.',
    },
    produce: ['assembled'],
    required: ['assembled'],
    steps: {
      zh: [
        '按原提示词结构逐段装配，全文一次性给全；新增规则插入对应位置。',
        '开头写版本号与「本版变更摘要」（新增/修改/弃用编号）。',
        '检查规则总数；若超过原版 50%，做一次合并精简并在摘要说明。',
        '写 notes/assembled.md（新版全文），调用 prompt_forge_advance 记录 assembled，进入 S6。',
      ],
      en: [
        'Assemble every section in the original structure; include the full text once.',
        'Add version and change summary (added/modified/deprecated ids).',
        'Check rule budget; if over +50%, merge/dedupe and explain in the summary.',
        'Write notes/assembled.md and advance to S6.',
      ],
    },
    acceptance: {
      zh: ['结构不缺失', '全文无「其余同上」', '版本与变更摘要齐全', '规模检查有结论'],
      en: ['No missing section', 'No "rest unchanged"', 'Version and change summary present', 'Budget check concluded'],
    },
    pitfalls: {
      zh: ['摘要写补丁表却不落正文', '把新规则只放附录'],
      en: ['Summary lists patches not inserted in body', 'New rules isolated in an appendix'],
    },
  },
  {
    id: 'S6',
    zh: '自检闭环（空上下文子智能体验证）',
    en: 'Verification loop (empty-context subagent)',
    purpose: {
      zh: '用同一组样本复跑新版并逐项自检；验证必须优先由「空上下文子智能体」独立完成，而不是自己在会话里打勾。',
      en: 'Re-run the same samples and verify; verification must be delegated to a fresh empty-context subagent whenever available.',
    },
    produce: ['selfCheck'],
    required: ['selfCheck'],
    needsVerification: true,
    steps: {
      zh: [
        '写 notes/selfCheck.md：七项自检表（疏漏覆盖/规则调用/冲突检查/格式可执行/规模可控/意图保持/版本可追溯）。',
        '调用 prompt_forge_verify_dispatch 生成只读验证任务包（packet）。',
        '用 `subagent` 工具（空上下文，新会话）投递 packet；禁止用 subagent_fork（会继承上下文）。',
        '把子智能体返回的 verdicts 用 prompt_forge_verify_record 记录；若有 ❌ 必修项，回到 S4 补丁后重跑。',
        '全部通过后调用 prompt_forge_advance 记录 selfCheck，进入 S7。若宿主没有 subagent 工具，可在 advance 时用 verifyFallbackReason 记录降级原因（会入 ledger）。',
      ],
      en: [
        'Write notes/selfCheck.md with the seven-item table.',
        'Call prompt_forge_verify_dispatch to build the read-only verification packet.',
        'Dispatch it with the `subagent` tool (fresh context); never `subagent_fork`.',
        'Record returned verdicts via prompt_forge_verify_record; fix must-fix ❌ items and re-run.',
        'Then advance to S7. If no subagent tool exists, pass verifyFallbackReason when advancing and mark the fallback.',
      ],
    },
    acceptance: {
      zh: ['自检表七项齐全', '验证由空上下文子智能体完成（有 runId 与 verdicts）', '无必修 ❌ 未闭环', '降级必须显式记录'],
      en: ['Seven-item table complete', 'Verification done by empty-context subagent (runId + verdicts)', 'No open must-fix ❌', 'Fallback explicitly recorded'],
    },
    pitfalls: {
      zh: ['自己在原会话里打勾冒充独立验证', '用 subagent_fork 继承了自己的结论', '忽略子智能体的 ❌'],
      en: ['Self-checking in the same context and calling it verification', 'Using subagent_fork', 'Ignoring subagent ❌ verdicts'],
    },
  },
  {
    id: 'S7',
    zh: '交付',
    en: 'Deliver',
    purpose: {
      zh: '按固定五段输出：演练结果、疏漏清单、新版全文、变更说明、遗留风险与建议。',
      en: 'Deliver the fixed five sections: drill results, defect list, new prompt, change notes, risks.',
    },
    produce: ['deliverable'],
    required: ['deliverable'],
    steps: {
      zh: [
        '把 A–E 五段整理成单一交付文件 notes/deliverable.md（含自检表与验证 runId）。',
        '调用 prompt_forge_advance 记录 deliverable；状态进入 done。',
        '最后向用户复述交付路径与遗留风险。',
      ],
      en: [
        'Assemble sections A–E into notes/deliverable.md (with self-check table and verify runId).',
        'Call prompt_forge_advance with deliverable; state becomes done.',
        'Summarize paths and remnant risks to the user.',
      ],
    },
    acceptance: {
      zh: ['五段齐全', '可复制交付', '遗留风险与下一轮建议已写'],
      en: ['Five sections present', 'Copy-ready', 'Remnant risks and next-round advice written'],
    },
    pitfalls: {
      zh: ['交付物引用不存在的文件', '漏自检表/runId'],
      en: ['Referencing missing files', 'Omitting self-check/runId'],
    },
  },
]

/** Nine dimensions used by the scan and by verification verdicts. */
export const DIMENSIONS = [
  { id: 'coverage', zh: '覆盖性', en: 'Coverage' },
  { id: 'decision', zh: '裁决性', en: 'Decision authority' },
  { id: 'conflict', zh: '冲突性', en: 'Conflicts' },
  { id: 'traceability', zh: '可追溯性', en: 'Traceability' },
  { id: 'consistency', zh: '一致性', en: 'Consistency' },
  { id: 'timing', zh: '时序性', en: 'Timing' },
  { id: 'format', zh: '格式性', en: 'Format' },
  { id: 'executability', zh: '可执行性', en: 'Executability' },
  { id: 'failure', zh: '失败预判', en: 'Failure prediction' },
]

/** Artifact order for display. */
export const ARTIFACT_ORDER = Object.keys(ARTIFACTS)

/** Return the phase definition by id (or null). */
export function phaseById(id) {
  return PHASES.find(phase => phase.id === id) ?? null
}

/** Return the phase after `id`, or null when id is S7/done. */
export function nextPhaseId(id) {
  if (id === 'done') return null
  const index = PHASES.findIndex(phase => phase.id === id)
  return index >= 0 && index + 1 < PHASES.length ? PHASES[index + 1].id : null
}
