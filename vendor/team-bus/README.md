# dsh-team-bus — 团队协作总线

Team collaboration suite for DeepSeek Harness: session network, identity/alias registry, meetings, shared pitfalls, coordination skills and a local message bus in one install.

为 DeepSeek Harness 提供团队协作套件：会话网络、身份/别名注册、会议、共享坑点、协作技能与本地消息总线，一次安装。

> Version: 2026.11.4-1 · Not yet published on npm; install from GitHub.

## English

### What it brings

- **Session network** — `network_info()` shows sessions, aliases, liveness and contacts (read-only).
- **Identity & meetings** — alias registry, meeting records and shared pitfalls across sessions.
- **Five coordination skills** — `network-intro`, `session-meeting`, `team-bootstrap`, `delegation-priority`, `workspace-agents`.
  `team-bootstrap` is the single capability index: four classes (callable / conditional / UI-only /
  automatic hook), human-confirmation boundaries and three common misreads; it points to
  `CAPABILITY_AUDIT.md`.
- **Local message bus** — send/read/ack cross-session messages without a network service.

Example:

```text
network_info()                 # who is reachable, aliases, roles
skill("team-bootstrap")        # start a team workspace
message_send({ to: "<alias>", body: "status: green" })
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

The bundle adds eight plugins; enable `team-bus`. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-team-bus`.

### Usage

Use `network_info()` to inspect the local session network; load a coordination skill when starting or joining a team; send messages with `message_send` and read them with `message_queue` / `message_read`.

### Configuration

Enable/disable the plugin and set its local data directory. Identity/alias/meeting state stays under the profile data directory; workspace files are read only where the session permission allows it.

### Permissions, compatibility & privacy

- Local SQLite and workspace reads only; no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Team data is local; uninstall retains data for recovery.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 功能

- **会话网络**：`network_info()` 只读展示会话、别名、活跃度与联系方式。
- **身份与会议**：跨会话别名注册、会议记录、共享坑点。
- **5 个协作技能**：`network-intro`、`session-meeting`、`team-bootstrap`、`delegation-priority`、`workspace-agents`。
- **本地消息总线**：无需网络服务即可收/发/确认跨会话消息。

示例：

```text
network_info()                 # 可达会话、别名、角色
skill("team-bootstrap")        # 初始化团队工作区
message_send({ to: "<alias>", body: "状态：正常" })
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

安装包会加入 8 个插件项；启用 `team-bus`。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-team-bus`。

### 使用

用 `network_info()` 查看本地会话网络；开始/加入团队时加载协作技能；用 `message_send` 发送、`message_queue` / `message_read` 读取消息。

### 配置

可启用/禁用插件并设置本地数据目录。身份/别名/会议状态保存在 profile 数据目录；工作区文件仅在会话权限允许时读取。

### 权限、兼容与隐私

- 仅本地 SQLite 与允许的工作区读取；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 团队数据保存在本地；卸载后保留以便恢复。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
