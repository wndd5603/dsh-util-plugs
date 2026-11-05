# dsh-message-bus — 跨会话消息总线

Cross-session messaging for DeepSeek Harness: a local SQLite message bus with wake envelopes, dedupe, priorities, read receipts, inspection tools and a Web message center.

为 DeepSeek Harness 提供跨会话消息总线：本地 SQLite、轻量唤醒信封、去重/优先级、已读回执、只读检查工具与 Web 消息中心。

> Row version: 2026.11.5-1 · bundle 2026.11.5-1 (preview) · npm HOLD: install from GitHub source.

## English

### What it brings

- One local SQLite queue shared by DSH sessions.
- Lightweight wake envelopes: the message body stays in the store, not in the wake event.
- Dedupe keys, priority delivery, read receipts and optional route registration.
- Read-only inspection: `message_queue`, `message_read`, `message_ack`, `message_routes`, `message_bus_status`.
- **Web message center** — a sidebar Messages page to search, paginate, read details, delete with a typed confirmation and copy an “ask the agent” prompt. It reads/writes through the local `messageBus` Remote; the browser stores nothing and the model cannot click the UI.

Example:

```text
message_send({ to: "lead", subject: "status", body: "task done", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### Install (GitHub source; npm HOLD)

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

The self-contained bundle adds seven switchable rows; enable `message-bus`. The npm package is not published during the HOLD — do not use `dsh plugin add dsh-message-bus` yet.

### Usage

Send with `message_send`; read with `message_queue` / `message_read`; acknowledge with `message_ack`; inspect routes/status with `message_routes` / `message_bus_status`. Open the sidebar **Messages** page for the same data in the Web UI (search/pagination/delete). The model receives only a lightweight envelope and reads the body on demand.

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

From a source checkout: `npm test`. The GitHub bundle can be checked with `npm run verify`.

Disable or remove the plugin row in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its rows. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 功能

- 所有 DSH 会话共享一个本地 SQLite 队列。
- 轻量唤醒信封：正文留在消息库中，不进入唤醒事件。
- 支持去重键、优先级投递、已读回执与可选路由注册。
- 只读检查：`message_queue`、`message_read`、`message_ack`、`message_routes`、`message_bus_status`。
- **Web 消息中心**：左栏「消息」页支持搜索、分页、详情、输入确认词删除、复制「向智能体询问」入口。窗口通过本地 `messageBus` Remote 读写；浏览器不留存数据，模型不能操作该 UI。

示例：

```text
message_send({ to: "lead", subject: "status", body: "任务完成", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### 安装（GitHub source；npm 暂缓）

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

bundle 会加入 7 个可切换 row；启用 `message-bus` 即使用本插件。npm 包在 HOLD 期间未发布，请勿使用 `dsh plugin add dsh-message-bus`。

### 使用

用 `message_send` 发送，`message_queue` / `message_read` 读取，`message_ack` 标记已读；`message_routes` / `message_bus_status` 检查路由与状态。Web 端打开左栏「消息」页可搜索/分页/删除同一份消息。模型只收到轻量信封，需要时再取正文。

### 配置

`dbPath`（默认 `$DSH_HOME/message-bus/bus.sqlite`）、`enabled`、优先级/去重窗口与可选路由。`message_purge` 是破坏性操作，需要显式确认。

### 仅操作员 / 人工确认

- `message_purge`：永久删除消息、投递与已读状态，必须提供 `confirm:"PURGE"` 和 `before`（ISO 时间）或 `all:true`；
  先说明影响范围并取得操作员/用户明确确认，**不得**用来掩盖投递失败。
- `message_route_register`：修改别名→会话路由；默认关闭（`allowRouteRegister:false`），需操作员配置后才存在；
  不要假设可用，也不要用它劫持其他会话别名。
- `message_send` 可由模型调用，但“已投递 ≠ ACK”；确认与跨会话协议见 `message_read`/`message_ack` 和
  team-bootstrap 能力索引。

### 权限、兼容与隐私

- 仅本地 SQLite；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 卸载不会删除数据库，便于恢复；需要时再手动清理。

### 测试与卸载

源码目录内运行 `npm test`；GitHub bundle 可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应 row；若不再使用整个 bundle，可从 profile 移除。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
