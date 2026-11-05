# dsh-util-plugs — DSH 工具箱插件集

A single install that adds eight independently switchable plugins to DeepSeek Harness.

一次安装，为 DeepSeek Harness 增加 8 个可独立启用的插件。

> Version: 2026.11.5-5 · Not yet published on npm; install from GitHub.

## English

### What it adds

The `dsh-util-plugs` package gives DeepSeek Harness context awareness, cross-session messaging with a Web message center, team collaboration, agent workflows, a workbench status overview, automatic file backups, safe host restart and a unified plugin console. Install once, then enable only the plugins you need in Settings → Plugins.

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

The package is self-contained: the eight runtime plugins live under `vendor/`, and an install works without publishing them to npm. No npm package is published yet.

### The eight plugins

| Plugin | What it adds | Docs |
|---|---|---|
| `context-sentinel` | Context occupancy, a per-turn `[ctx]` signal, archive reminders and optional guard rails. | [`vendor/context-sentinel/README.md`](vendor/context-sentinel/README.md) |
| `message-bus` | Local SQLite cross-session messaging, read receipts, priorities and a Web message center. | [`vendor/message-bus/README.md`](vendor/message-bus/README.md) |
| `team-bus` | Session network, alias/meeting registry, shared pitfalls and five coordination skills. | [`vendor/team-bus/README.md`](vendor/team-bus/README.md) |
| `agent-workflows` | Team Coordinator and Prompt Studio workflow tools. | [`vendor/agent-workflows/README.md`](vendor/agent-workflows/README.md) |
| `workbench-bundle` | A read-only `workbench_status()` overview and a first-turn capability pointer. | [`vendor/workbench-bundle/README.md`](vendor/workbench-bundle/README.md) |
| `auto-backup` | Pre-write file snapshots with retention and `auto_backup_status()`. | [`vendor/auto-backup/README.md`](vendor/auto-backup/README.md) |
| `host-relaunch` | Two-step safe restart, a Web header button and session resume. | [`vendor/host-relaunch/README.md`](vendor/host-relaunch/README.md) |
| `plugin-console` | A unified plugin console with cards, live configuration and extension contributions. | [`vendor/plugin-console/README.md`](vendor/plugin-console/README.md) |

Each plugin can be enabled, disabled and configured independently. The package version is 2026.11.5-5; individual plugins keep their own versions.

### Web UI

One shared client module powers three browser surfaces:

- **Messages** — a sidebar page for the local message bus: search, pagination, message detail with read state, delete with typed confirmation, and a copy-ready “ask the agent” prompt.
- **Restart DSH** — a conversation-header button with an in-page confirmation panel: PID suffix, typed confirmation, and a block while sessions run or the safety lock is off.
- **Plugin Console** — plugin cards, status and configuration forms, plugin extension contributions and deep links to the native plugin manager.

All three surfaces are UI-only for the model: agents can read or request the same information through tools but cannot click the panels.

### Configuration, permissions and data

- Enable/disable and configure each plugin in Settings → Plugins.
- Local-first: no network calls and no credentials. SQLite databases, JSONL audits and backups stay under `$DSH_HOME` or the session workspace.
- Safe defaults: write-related guards and real host restarts are opt-in (`allowRealRestart:false`).
- See [`PRIVACY.md`](PRIVACY.md) for local data locations and cleanup.

### Compatibility and uninstall

- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`; host restart is Windows-first.
- Remove the package from the profile or use the plugin manager. Data under `$DSH_HOME` is not deleted automatically.

### Verify

```sh
npm run verify        # package structure and plugin entries
npm run verify:client # shared client registration
```

### License

MIT © 2026 wndd5603

## 中文

### 这个安装包增加什么

`dsh-util-plugs` 一次安装，为 DeepSeek Harness 增加 8 个可独立启用的插件：上下文感知、带 Web 消息中心的跨会话消息、团队协作、智能体工作流、工作台状态总览、自动备份、安全宿主重启和统一插件控制台。安装后在「设置 → 插件」中按需启用即可。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

安装包自带全部运行代码（8 个插件位于 `vendor/`），无需先把它们发布到 npm。目前尚未发布 npm 包。

### 8 个插件

| 插件 | 提供什么 | 文档 |
|---|---|---|
| `context-sentinel` | 上下文占用、每轮 `[ctx]` 提示、归档提醒与可选护栏。 | [`vendor/context-sentinel/README.md`](vendor/context-sentinel/README.md) |
| `message-bus` | 本地 SQLite 跨会话消息、已读回执、优先级与 Web 消息中心。 | [`vendor/message-bus/README.md`](vendor/message-bus/README.md) |
| `team-bus` | 会话网络、别名/会议注册、共享坑点与 5 个协作技能。 | [`vendor/team-bus/README.md`](vendor/team-bus/README.md) |
| `agent-workflows` | Team Coordinator 与 Prompt Studio 工作流工具。 | [`vendor/agent-workflows/README.md`](vendor/agent-workflows/README.md) |
| `workbench-bundle` | 只读 `workbench_status()` 总览与首轮能力提示。 | [`vendor/workbench-bundle/README.md`](vendor/workbench-bundle/README.md) |
| `auto-backup` | 写前文件快照、保留策略与 `auto_backup_status()`。 | [`vendor/auto-backup/README.md`](vendor/auto-backup/README.md) |
| `host-relaunch` | 两步安全重启、Web 顶栏按钮与会话恢复。 | [`vendor/host-relaunch/README.md`](vendor/host-relaunch/README.md) |
| `plugin-console` | 统一插件控制台：插件卡片、实时配置与扩展贡献。 | [`vendor/plugin-console/README.md`](vendor/plugin-console/README.md) |

每个插件项都可独立启用、禁用和配置。安装包版本为 2026.11.5-5，各插件保留自己的版本号。

### Web 界面

同一份 client 模块提供三个浏览器入口：

- **消息**：左栏消息页，支持搜索、分页、查看消息详情与已读状态、输入确认词删除，以及复制「向智能体询问」提示。
- **重启 DSH**：会话顶栏按钮，打开页内确认面板：PID 后四位、输入确认词；有会话运行或安全锁关闭时禁用。
- **插件控制台**：插件卡片、状态与配置表单、插件扩展贡献，以及指向原生插件管理器的深链。

这三个界面都只供人操作：智能体可通过工具读取或请求同样的信息，但不能点击面板。

### 配置、权限与数据

- 在「设置 → 插件」中逐个启用/禁用/配置插件项。
- 本地优先：无网络请求、无凭据；SQLite、JSONL 审计与备份保存在 `$DSH_HOME` 或会话工作区。
- 安全默认：写相关护栏与真实宿主重启均需显式开启（`allowRealRestart:false`）。
- 本地数据位置与清理见 [`PRIVACY.md`](PRIVACY.md)。

### 兼容与卸载

- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`；宿主重启优先支持 Windows。
- 从 profile 移除安装包，或使用插件管理器卸载。`$DSH_HOME` 下的数据不会自动删除。

### 自检

```sh
npm run verify        # 安装包结构与插件项
npm run verify:client # 共享 client 注册
```

### 许可证

MIT © 2026 wndd5603
