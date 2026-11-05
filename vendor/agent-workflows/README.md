# dsh-agent-workflows — 智能体工作流预设

Agent workflow presets for DeepSeek Harness: a team-coordination preset for multi-agent project setup and a staged prompt-iteration preset.

为 DeepSeek Harness 提供智能体工作流预设：多智能体项目协作的 Team Coordinator，以及分阶段提示词迭代的 Prompt Studio。

> Row version: 2026.11.4-1 · bundle 2026.11.5-1 (preview) · npm HOLD: install from GitHub source.

## English

### What it brings

- **Team Coordinator preset** — scaffolds a team workspace (roles, meeting notes, audit helpers) and provides `team_init` / `team_members_check`.
- **Prompt Studio preset** — a staged S0–S7 prompt-iteration workflow with `prompt_forge_*` tools, verification packets and recorded verdicts.
- Tools mount **only inside their own preset sessions**; writes stay inside the session workspace.

Example:

```text
team_init({ preview: true })       # show what Team Coordinator would create
team_members_check()               # verify the team workspace
prompt_forge_status()              # current Prompt Studio stage/next step
```

### Install (GitHub source; npm HOLD)

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

The bundle adds seven rows; enable `agent-workflows` for the runtime tools. The declarative presets ship with the source package; until npm is available, use the source package/checkout for full preset sessions. npm is on HOLD — do not use `dsh plugin add dsh-agent-workflows` yet.

### Usage

Start a new session and select the Team Coordinator or Prompt Studio preset. Team Coordinator tools are scoped to that preset; Prompt Studio exposes the `prompt_forge_*` workflow and its verification gates.

### Configuration

Enable/disable the plugin row and the preset-level tools. The presets keep their own configuration; writes are limited to the session workspace.

### Permissions, compatibility & privacy

- Preset-scoped tools; writes confined to the session workspace.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Local-first: no network calls and no credentials; state stays in the workspace or `$DSH_HOME`.

### Human confirmation / operator boundaries

- `team_init` writes team templates. Call it with `preview:true` first and let the captain/user confirm the
  created/skipped list before a real write; it is scoped to the session workspace.
- `prompt-forge` S6 must be verified by a **fresh-context** `subagent` (never `subagent_fork`) and recorded with
  `prompt_forge_verify_record`. A fallback reason is an explicit degradation, not model self-certification;
  S7 is not allowed while the S6 gate is missing.
- `team_members_check` is read-only. The preset-scoped tools are model-callable only inside the matching preset
  session; outside it they are absent (see `team-bootstrap` §2 capability index).

### Tests & uninstall

From a source checkout: `npm test`. The GitHub bundle can be checked with `npm run verify`.

Disable or remove the plugin row in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its rows. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 新功能与示例

- **Team Coordinator 预设**：搭建团队工作区（角色、会议记录、审计辅助），提供 `team_init` / `team_members_check`。
- **Prompt Studio 预设**：分阶段 S0–S7 的提示词迭代工作流，含 `prompt_forge_*` 工具、验证包与书面结论。
- 工具**只在自己的预设会话中挂载**；写入限制在会话工作区内。

示例：

```text
team_init({ preview: true })       # 预览 Team Coordinator 会创建什么
team_members_check()               # 校验团队工作区
prompt_forge_status()              # 当前 Prompt Studio 阶段/下一步
```

### 安装（GitHub source；npm 暂缓）

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

bundle 会加入 7 个 row；启用 `agent-workflows` 获得运行时工具。声明式预设随源码包提供；npm 可用前，完整预设会话请使用源码包/checkout。npm 在 HOLD 期间未发布，请勿使用 `dsh plugin add dsh-agent-workflows`。

### 使用

新会话选择 Team Coordinator 或 Prompt Studio 预设。Team Coordinator 工具仅在该预设内可见；Prompt Studio 提供 `prompt_forge_*` 工作流及验证门禁。

### 配置

可启用/禁用插件 row 与预设级工具；各预设保留自己的配置；写入仅限会话工作区。

### 权限、兼容与隐私

- 工具按预设隔离；写入限制在会话工作区。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 本地优先：无网络请求、无凭据；状态保存在工作区或 `$DSH_HOME`。

### 人工确认 / 操作员边界

- `team_init`：会写入团队模板。先 `preview:true`，由队长/用户确认 created/skipped 后再写盘；root 限于会话
  工作区。
- `prompt-forge` S6：必须由**空上下文** `subagent`（禁用 `subagent_fork`）验证，并用
  `prompt_forge_verify_record` 记录九维结果。`verifyFallbackReason` 是显式降级，不是模型自证；S6 门禁缺失时
  不允许进入 S7。
- `team_members_check` 只读；预设工具仅在对应预设会话中可调用，不在预设内时不存在
  （见 `team-bootstrap` §2 能力索引）。

### 测试与卸载

源码目录内运行 `npm test`；GitHub bundle 可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应 row；若不再使用整个 bundle，可从 profile 移除。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
