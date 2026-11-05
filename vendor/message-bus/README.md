# dsh-message-bus — 跨会话消息总线

Cross-session messaging for DeepSeek Harness: a local SQLite message bus with wake envelopes, dedupe, priorities, read receipts and inspection tools.

为 DeepSeek Harness 提供跨会话消息总线：本地 SQLite、轻量唤醒信封、去重/优先级、已读回执与只读检查工具。

> Version: 2026.11.5-1 · Not yet published on npm; install from GitHub.

## English

### What it brings

- One local SQLite queue shared by DSH sessions.
- Lightweight wake envelopes: the message body stays in the store, not in the wake event.
- Dedupe keys, priority delivery, read receipts and optional route registration.
- Host-native target resolution: session-id → live `agents.get`, alias → host
  `sessionDirectory`, header alias/displayName → `agents.list`; missing/inactive targets fail with
  `SESSION_GONE`, and same-Team targets prefer `agentTeams.sendMessage` over `followup`.
- Read-only inspection: `message_queue`, `message_read`, `message_ack`, `message_routes`, `message_bus_status`.

Example:

```text
message_send({ to: "lead", subject: "status", body: "task done", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

The self-contained bundle adds eight independently switchable plugins; enable `message-bus`. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-message-bus`.

### Usage

Send with `message_send`; read with `message_queue` / `message_read`; acknowledge with `message_ack`; inspect routes/status with `message_routes` / `message_bus_status`. The model receives only a lightweight envelope and reads the body on demand.

### Configuration

`dbPath` (default `$DSH_HOME/message-bus/bus.sqlite`), `enabled`, `strictMode` (default `true`), `autoResume` (default `true`), `resumeModel`, priority/dedupe windows and optional routes. `message_purge` is destructive and requires explicit confirmation.

### Strict mode (default true)

- `strictMode:true` forbids direct `session-<uuid>` delivery; register/join an alias first (preferred).
- A direct session-id may still be sent after a **one-time approval**: the tool calls
  `ctx.get('approval').request({agent, toolName:'message_send', callId, reason, displayReason, signal})`;
  only `allowed-once` proceeds. `rejected`/`cancelled`/`unavailable`/missing approval returns
  `STRICT_SESSION_ID_DENIED` ("join first or retry approval").
- Alias/join delivery never asks for approval. `strictMode:false` keeps the legacy direct-id behavior.
- The Web message center is a human surface and is exempt from the tool approval gate.
- `message_bus_status` exposes the effective `strictMode`.

### Auto-resume (default true)

- An inactive `session-<uuid>`/alias target is resumed before delivery: `agents.resume({resumeSessionId, agentOptions?, setup})`.
  `setup` resolves the session's preset via `sessionQuery.observeSession` → `agentPresets.resolve` → `agentPresets.mount`; a
  missing preset refuses resume rather than creating a half-composed session.
- Model: `agentDefaultModel.currentSelection()` first, then config `resumeModel` (`{provider,model}`).
- Archived sessions (`workspaceRegistry.archivedSessionIds`) are never resumed. Concurrent sends share one in-flight
  resume (`resuming` map); handles are kept in `resumedHandles`.
- A failed/refused resume is **accepted into the persisted queue** (`ok:true, accepted:true, stored:true, delivered:false,
  queued:true, wakeError`), not `SESSION_GONE`. When the session becomes live, `agent/created`/`agent/status` flush the
  queued envelopes and mark deliveries delivered. `message_bus_status` exposes `autoResume` and `resumedCount`.
- Set `autoResume:false` to disable resume: inactive targets are still accepted into the persisted queue
  (`queued:true`, `wakeError:'autoResume-disabled'`) and are flushed when the session becomes live.
  Alias/join and strictMode approval remain unchanged.
- Auto-resume is per-caller rate-limited (`autoResumeRateLimitPerMinute`, default 12/min); excess
  stays queued with `wakeError:'autoResume-rate-limited'`. `message_bus_status` exposes the limit.

### Auto-resume 中文说明（默认开启）

- 非 live 的 session-id/alias 目标会先 `agents.resume`；setup 通过 `sessionQuery.observeSession` 读取 preset，
  再 `agentPresets.resolve` + `mount`；无 preset 不 resume；模型优先 `agentDefaultModel.currentSelection()`，
  否则用 `resumeModel`。
- 归档会话不 resume；并发消息共享同一 in-flight resume；resume 句柄放入 `resumedHandles`。
- resume 失败/拒绝时消息**入库并接受**（`ok:true, accepted:true, stored:true, delivered:false, queued:true, wakeError`），
  不再抛 `SESSION_GONE`；会话后续存活时通过 `agent/created`/`agent/status` 自动补投并标记 delivered。
- `message_bus_status` 暴露 `autoResume`/`resumedCount`；`autoResume:false` 仍按队列语义接受消息
  （`queued:true`, `wakeError:'autoResume-disabled'`），后续 live 时补投。
- 自动 resume 按调用方限频（`autoResumeRateLimitPerMinute`，默认 12/分钟），超限消息保留下队
  并标记 `wakeError:'autoResume-rate-limited'`；status 暴露该阈值。

### Retired legacy surfaces (intentional)

- `PEERS.json`, file-based pipe2 routes/inboxes, `team_audit`/`pipe2_*` bridge tools and their
  file-watch behavior are **intentionally retired** in the host-native v2 line. They are not
  reimplemented and must not be used for new work; use `network_info`, the host
  `sessionDirectory`/alias path and `message_*` tools instead. `legacyTools:true` only registers
  a minimal compatibility alias surface where still mounted; see CHANGELOG.

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
- Host-native 投递：session-id 通过在线 agent 解析，别名经宿主 `sessionDirectory`，header 别名/显示名经在线 agent 列表；目标不存在或非 active 时走 autoResume/队列语义；同团队目标优先走团队消息通道。

示例：

```text
message_send({ to: "lead", subject: "status", body: "任务完成", dedupeKey: "status-1" })
message_queue({ unreadOnly: true })
message_read({ messageId: "msg-..." })
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

安装包会加入 8 个可独立启用的插件项；启用 `message-bus` 即使用本插件。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-message-bus`。

### 使用

用 `message_send` 发送，`message_queue` / `message_read` 读取，`message_ack` 标记已读；`message_routes` / `message_bus_status` 检查路由与状态。模型只收到轻量信封，需要时再取正文。

### 配置

`dbPath`（默认 `$DSH_HOME/message-bus/bus.sqlite`）、`enabled`、`strictMode`（默认 `true`）、`autoResume`（默认 `true`）、`resumeModel`、优先级/去重窗口与可选路由。`message_purge` 是破坏性操作，需要显式确认。

### 严格模式（默认开启）

- `strictMode:true` 时**禁止直接 session-<uuid> 投递**；优先先 `alias_register` join。
- 直接 session-id 可通过**一次性审批**放行：工具调用
  `ctx.get('approval').request({agent, toolName:'message_send', callId, reason, displayReason, signal})`；
  仅 `allowed-once` 放行；`rejected`/`cancelled`/`unavailable`/无审批通道返回
  `STRICT_SESSION_ID_DENIED`（提示先 join 或重试审批）。
- alias/join 路径不触发审批；`strictMode:false` 保持原直接 session-id 行为。
- Web 消息中心是人工界面，不受工具审批门禁影响。
- `message_bus_status` 暴露生效的 `strictMode`。

### 有意退役的旧接口

- `PEERS.json`、文件式 pipe2 routes/inbox、`team_audit`/`pipe2_*` bridge 工具及其 file-watch 行为
  在 host-native v2 线中**有意退役**，不再实现，也不用于新工作；请使用 `network_info`、host
  `sessionDirectory`/alias 路径和 `message_*` 工具。`legacyTools:true` 仅保留最小兼容别名面。

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
