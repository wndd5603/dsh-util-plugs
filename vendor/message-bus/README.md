# dsh-message-bus — 跨会话消息总线

Cross-session messaging for DeepSeek Harness: a local SQLite message bus with wake envelopes, dedupe, priorities, read receipts and inspection tools.

为 DeepSeek Harness 提供跨会话消息总线：本地 SQLite、轻量唤醒信封、去重/优先级、已读回执与只读检查工具。

> Version: 2026.11.5-1 · Not yet published on npm; install from GitHub.

## English

### What it brings

- One local SQLite queue shared by DSH sessions.
- Lightweight wake envelopes: the message body stays in the store, not in the wake event.
- Dedupe keys, priority delivery, read receipts and optional route registration.
- Read-only inspection: `message_queue`, `message_read`, `message_ack`, `message_routes`, `message_bus_status`.

Example:

```text
message_send({ to: "lead", subject: "status", body: "task done", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-3
```

The self-contained bundle adds eight independently switchable plugins; enable `message-bus`. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-message-bus`.

### Usage

Send with `message_send`; read with `message_queue` / `message_read`; acknowledge with `message_ack`; inspect routes/status with `message_routes` / `message_bus_status`. The model receives only a lightweight envelope and reads the body on demand.

### Configuration

`dbPath` (default `$DSH_HOME/message-bus/bus.sqlite`), `enabled`, priority/dedupe windows and optional routes. `message_purge` is destructive and requires explicit confirmation.

### Operator-only / human confirmation

- `message_purge` — destructive permanent deletion of messages, deliveries and read-state rows. It requires
  `confirm:"PURGE"` plus `before` (ISO timestamp) or `all:true`; show the impact and get explicit operator/user
  confirmation first. Never use it to hide a delivery failure.
- `message_route_register` — changes alias → session routing; disabled by default (`allowRouteRegister:false`) and
  only exists after an operator enables it. Do not assume it is available or use it to hijack another session's alias.
- `message_send` is model-callable, but delivery ≠ ACK; use `message_read`/`message_ack` and the team-bootstrap
  capability index for cross-session protocol.

### Permissions, compatibility & privacy

- Local SQLite only; no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Uninstall leaves the database for recovery; delete it manually when appropriate.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 功能

- 所有 DSH 会话共享一个本地 SQLite 队列。
- 轻量唤醒信封：正文留在消息库中，不进入唤醒事件。
- 支持去重键、优先级投递、已读回执与可选路由注册。
- 只读检查：`message_queue`、`message_read`、`message_ack`、`message_routes`、`message_bus_status`。

示例：

```text
message_send({ to: "lead", subject: "status", body: "任务完成", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-3
```

安装包会加入 8 个可独立启用的插件项；启用 `message-bus` 即使用本插件。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-message-bus`。

### 使用

用 `message_send` 发送，`message_queue` / `message_read` 读取，`message_ack` 标记已读；`message_routes` / `message_bus_status` 检查路由与状态。模型只收到轻量信封，需要时再取正文。

### 配置

`dbPath`（默认 `$DSH_HOME/message-bus/bus.sqlite`）、`enabled`、优先级/去重窗口与可选路由。`message_purge` 是破坏性操作，需要显式确认。

### 人工确认

- `message_purge`：永久删除消息、投递与已读状态，需要显式提供范围并确认影响；操作前请说明将删除的内容。
- `message_route_register`：维护本地别名到会话的路由；默认关闭，开启后才可用。
- `message_send` 可由模型调用；投递成功不等于对方已读，可用 `message_read` / `message_ack` 确认。

### 权限、兼容与隐私

- 仅本地 SQLite；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 卸载不会删除数据库，便于恢复；需要时再手动清理。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
