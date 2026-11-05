# dsh-util-plugs — DSH 工具箱插件集

One self-contained DeepSeek Harness bundle with seven switchable plugin rows.

一个自包含的 DeepSeek Harness bundle，包含 7 个可独立开关的插件 row。

> Version: 2026.11.5-1 (preview) · npm HOLD: install from GitHub source.

## English

### What this repository adds

One GitHub-installable bundle (`dsh-plugs`) gives DeepSeek Harness seven independent capabilities: context awareness, cross-session messaging with a Web message center, team collaboration with coordination skills, agent workflows, a workbench status overview, automatic file backups and safe host restart. Install the bundle once, then enable only the rows you need in Settings → Plugins.

The repository is **self-contained**: all seven runtime plugins live under `vendor/`, exposed through `plugins/*` subpath exports. It has **no npm dependencies and no workspace resolution**, so a GitHub source install works without publishing seven npm packages. npm is on **HOLD**.

### What's new in 2026.11.5-1

- **Web message center** (`message-bus`): a sidebar **Messages** page — list/search/paginate, read details and read receipts, delete with a typed confirmation, and copy an “ask the agent” prompt. It talks to the host over the local `messageBus` Remote; the browser stores nothing.
- **One composed Web client** (`client.js`): the message center and the conversation-header **Restart DSH** button now share one client module registered under the bundle name, so both surfaces load from a single `dsh.client` row.
- **Session-meeting task triage** (`session-meeting` §0.5): decide whether to hold a meeting at all, its scale, stage and quorum before R1/R2/R3.
- **Capability index** (`team-bootstrap`): the single entry for four capability classes (callable / conditional / UI-only / automatic hook), the human-confirmation boundary and three common misreads, backed by [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md).
- **Operator-only boundary page**: [`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md) separates model-callable actions from human/operator gates (`message_purge`, routes, `team_init` preview, restart step 2, prompt-forge S6, …).
- **Bilingual docs**: the root README and all seven plugin READMEs are zh/en.
- Vendor refresh from the source packages: message-bus host Remote + client, team-hooks2 / context-meter guard rails, captain/prompt-forge workflow tools, auto-backup and host-relaunch updates, plus bundle-adapted skill/doc paths.

### Install (GitHub source; npm HOLD)

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

No npm registry is used. **npm is on HOLD** — do not use `dsh plugin add <npm-name>` yet.

### Seven plugins

| Row id | What it adds | Docs |
|---|---|---|
| `context-sentinel` | Context occupancy, per-turn `[ctx]` signal, archive reminder loop and optional guard rails. | [`vendor/context-sentinel/README.md`](vendor/context-sentinel/README.md) |
| `message-bus` | Local SQLite cross-session message bus with dedupe, priorities, read receipts, inspection tools and the Web message center. | [`vendor/message-bus/README.md`](vendor/message-bus/README.md) |
| `team-bus` | Session network, identity/alias registry, meetings, shared pitfalls and five coordination skills (incl. §0.5 meeting triage). | [`vendor/team-bus/README.md`](vendor/team-bus/README.md) |
| `agent-workflows` | Team Coordinator and Prompt Studio workflow tools. | [`vendor/agent-workflows/README.md`](vendor/agent-workflows/README.md) |
| `workbench-bundle` | One read-only `workbench_status()` overview and first-turn capability pointer. | [`vendor/workbench-bundle/README.md`](vendor/workbench-bundle/README.md) |
| `auto-backup` | Pre-write file snapshots with retention and `auto_backup_status()`. | [`vendor/auto-backup/README.md`](vendor/auto-backup/README.md) |
| `host-relaunch` | Two-step safe restart, Web header button and session resume. | [`vendor/host-relaunch/README.md`](vendor/host-relaunch/README.md) |

Each row can be enabled, disabled and configured independently; there are no duplicate ids. Row versions follow their source packages (message-bus 2026.11.5-1, host-relaunch 2026.11.4-2, the others 2026.11.4-1); the bundle version is 2026.11.5-1.

### Web UI

The one bundle ships two browser surfaces through a single `client.js`:

- **Messages** — a sidebar entry plus a main page for the local message bus (search, pagination, detail with read state, delete with typed confirmation, “ask the agent” copy entry).
- **Restart DSH** — a conversation-header button that opens an in-page confirmation panel (PID suffix + typed word, blocked while sessions run or the safety lock is off).

Both are **UI-only** for the model: agents can read/ask for the same data through tools, but cannot click these panels.

### Capability model, permissions & data

- [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md) — four capability classes, per-row callable surface and the consistency gate.
- [`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md) — actions that need a human/operator.
- Enable/disable and configure each row in Settings → Plugins.
- Local-first: no network calls and no credentials. SQLite databases, JSONL audits and backups stay under `$DSH_HOME` or the session workspace.
- Safe defaults: write-related guards and real host restarts are opt-in (`allowRealRestart:false`).

### Compatibility, privacy & uninstall

- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`; Windows-first for host restart, other platforms degrade where a host feature is unavailable.
- See [`PRIVACY.md`](PRIVACY.md) for local data locations and cleanup.
- Remove the bundle from the profile or use the plugin manager; data under `$DSH_HOME` is not deleted automatically.

### Verification

```sh
npm run verify        # one bundle, seven rows, zero npm dependencies, no internal paths
npm run verify:client # composed client halves: registration id + slots/Remotes/locales
node scripts/build-client.mjs  # rebuild client.js after changing a vendor client half
```

### License

MIT © 2026 wndd5603

## 中文

### 这个仓库为 DSH 增加什么

通过一个可从 GitHub 安装的 bundle（`dsh-plugs`），为 DeepSeek Harness 提供 7 项独立能力：上下文感知、带 Web 消息中心的跨会话消息、团队协作与协作技能、智能体工作流、工作台状态总览、自动备份与安全宿主重启。安装一次 bundle，然后在「设置 → 插件」中按需启用 row。

仓库是**自包含**的：7 个插件运行代码都在 `vendor/` 下，通过 `plugins/*` 子路径导出。**没有 npm 依赖、不依赖 workspace 解析**，因此无需先发布 7 个 npm 包即可从 GitHub source 安装。npm 处于 **HOLD**。

### 本版新增（2026.11.5-1）

- **Web 消息中心**（`message-bus`）：左栏「消息」页 —— 列表/搜索/分页、详情与已读状态、输入确认词删除、复制「向智能体询问」入口。通过本地 `messageBus` Remote 访问主机；浏览器不留存数据。
- **单一组合 Web client**（`client.js`）：消息中心与顶栏 **重启 DSH** 按钮共用一个注册在 bundle 名下的 client 模块，同一 `dsh.client` row 加载两个界面。
- **会议任务分诊**（`session-meeting` §0.5）：在 R1/R2/R3 之前先判断要不要开会、规模、阶段与 quorum。
- **能力索引**（`team-bootstrap`）：四类能力（可调用/条件可调用/UI-only/自动 hook）、人工确认边界与 3 个易误解项的单一入口，配套 [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md)。
- **operator-only 边界页**：[`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md) 区分模型可调用与人工/操作员门禁（`message_purge`、路由、`team_init` preview、restart step2、prompt-forge S6 等）。
- **双语文档**：根 README 与 7 个插件 README 中英双语。
- 同步源码包最新改动：message-bus host Remote + client、team-hooks2 / context-meter 护栏、captain/prompt-forge 工作流工具、auto-backup 与 host-relaunch 更新，以及 bundle 内的 skill/文档路径适配。

### 安装（GitHub source；npm 暂缓）

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

安装不依赖 npm registry；bundle 自带 runtime 代码。**npm 处于 HOLD**，请勿使用 `dsh plugin add <npm 包名>`。

### 7 个插件

| Row id | 提供什么 | 文档 |
|---|---|---|
| `context-sentinel` | 上下文占用、每轮 `[ctx]` 提示、归档提醒循环与可选护栏。 | [`vendor/context-sentinel/README.md`](vendor/context-sentinel/README.md) |
| `message-bus` | 本地 SQLite 跨会话消息总线：去重/优先级/已读回执/检查工具 + Web 消息中心。 | [`vendor/message-bus/README.md`](vendor/message-bus/README.md) |
| `team-bus` | 会话网络、身份/别名注册、会议、共享坑点与 5 个协作技能（含 §0.5 会议分诊）。 | [`vendor/team-bus/README.md`](vendor/team-bus/README.md) |
| `agent-workflows` | Team Coordinator 与 Prompt Studio 工作流工具。 | [`vendor/agent-workflows/README.md`](vendor/agent-workflows/README.md) |
| `workbench-bundle` | 只读 `workbench_status()` 总览 + 首轮能力提示。 | [`vendor/workbench-bundle/README.md`](vendor/workbench-bundle/README.md) |
| `auto-backup` | 写前文件快照 + 保留策略 + `auto_backup_status()`。 | [`vendor/auto-backup/README.md`](vendor/auto-backup/README.md) |
| `host-relaunch` | 两步安全重启、Web 顶栏按钮与会话恢复。 | [`vendor/host-relaunch/README.md`](vendor/host-relaunch/README.md) |

每个 row 可独立启用/禁用/配置，不存在重复 id。row 版本跟随源码包（message-bus 2026.11.5-1、host-relaunch 2026.11.4-2，其余 2026.11.4-1）；bundle 版本为 2026.11.5-1。

### Web 界面

一个 bundle 通过同一份 `client.js` 提供两个浏览器入口：

- **消息**：左栏入口 + 主页面（搜索、分页、详情已读状态、输入确认词删除、复制「向智能体询问」）。
- **重启 DSH**：会话顶栏按钮 → 页内确认面板（PID 后缀 + 输入确认词；有会话运行或安全锁关闭时禁用）。

两个界面对模型都是 **UI-only**：agent 可通过工具读取/请求同样的数据，但不能点击这些面板。

### 能力模型、权限与数据

- [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md)：四类能力、每个 row 的可调用面与一致性门禁。
- [`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md)：需要人工/操作员确认的动作。
- 在「设置 → 插件」中逐个启用/禁用/配置 row。
- 本地优先：无网络请求、无凭据；SQLite、JSONL 审计与备份保存在 `$DSH_HOME` 或会话工作区。
- 安全默认：写相关护栏与真实宿主重启均需显式开启（`allowRealRestart:false`）。

### 兼容、隐私与卸载

- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`；宿主重启 Windows-first，其他平台在宿主能力不可用时降级。
- 本地数据位置与清理见 [`PRIVACY.md`](PRIVACY.md)。
- 从 profile 移除 bundle 或使用插件管理器；`$DSH_HOME` 下数据不会自动删除。

### 自检

```sh
npm run verify        # 1 bundle / 7 rows / 0 npm 依赖 / 无内部路径
npm run verify:client # 组合 client 的注册 id 与 slots/Remotes/locales
node scripts/build-client.mjs  # 改动 vendor client half 后重建 client.js
```

### 许可证

MIT © 2026 wndd5603
