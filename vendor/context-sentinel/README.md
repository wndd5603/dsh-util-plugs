# dsh-context-sentinel — 上下文哨兵

Context awareness and workflow guard for DeepSeek Harness: live occupancy, a per-turn context signal, optional session guard rails and a bounded archive-reminder loop.

为 DeepSeek Harness 提供上下文可见性与工作流护栏：实时占用、每轮上下文提示、可选会话护栏，以及有状态的归档提醒循环。

> Version: 2026.11.4-1 · Not yet published on npm; install from GitHub.

## English

### What's new

- **Per-turn context signal** — at the first model step of each turn the plugin may prepend a tiny line, `[ctx 65%]` (or `[ctx 65% 649k/1M]` with usage detail). It is model input, not a user message, never blocks a turn, and is suppressed when a threshold advisory is already present.
- **Archive-reminder loop** — at ≥50% occupancy create/update the session snapshot; remind every 2 turns; when occupancy drops ≥15 points, read the latest snapshot, verify memory and reset the cycle. State survives compaction and restart.
- **Read-only diagnostics** — `context_usage` and `context_guard_status` show occupancy, headroom and guard state.
- **Optional guard rails** — archive reminders, role-based write policy, delegation audit, write gate and recurring-problem observation; most are opt-in and read-only by default.

Example:

```text
[ctx 65%]
[ctx 65% 649k/1M]   (usage detail on)
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-8
```

The self-contained bundle adds eight independently switchable plugins; enable `context-sentinel` for this plugin. No npm registry is used. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-context-sentinel`.

### Usage

Ask the agent to call `context_usage()` for a read-only occupancy report, or `context_guard_status()` for guard/health details. Start a new session with the context-discipline preset to keep long sessions focused. The per-turn `[ctx …]` line appears automatically.

### Configuration

- `turnInjection` (default on): prepend the tiny context line; set `false` to silence it.
- `turnInjectionUsage` (default off): use the `[ctx 65% 649k/1M]` form.
- `archiveReminder`: enable/disable the loop and tune `archiveThreshold` (default 50%), `reminderEveryNTurns` (2) and `dropThreshold` (15 points).

### Permissions, compatibility & privacy

- Read-only by default; write-related guard rails are opt-in.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Local-first: no network calls and no credentials. State stays under `$DSH_HOME`.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 新功能与示例

- **每轮上下文提示**：每轮第一次模型调用前可能自动插入一行极小提示 `[ctx 65%]`（开启用量明细时为 `[ctx 65% 649k/1M]`）。它是模型输入，不是用户消息；不阻塞轮次，且同一轮已有阈值提示时不重复。
- **归档提醒循环**：占用 ≥50% 时创建/更新会话快照；每 2 轮提醒；占用下降 ≥15 点时读取最新快照、核对记忆并重置循环。状态可跨压缩/重启保留。
- **只读诊断**：`context_usage`、`context_guard_status` 查看占用、剩余空间与护栏状态。
- **可选会话护栏**：归档提醒、按角色的写策略、委派审计、写入门与重复问题观察；多数默认关闭且只读。

示例：

```text
[ctx 65%]
[ctx 65% 649k/1M]   （开启用量明细）
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-8
```

安装包自带运行代码，会加入 8 个可独立启用的插件项；启用 `context-sentinel` 即使用本插件。安装无需 npm registry；目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-context-sentinel`。

### 使用

让智能体调用 `context_usage()` 获取只读占用报告，或 `context_guard_status()` 查看护栏/健康状态；新会话可选择上下文纪律 preset。`[ctx …]` 提示会自动出现。

### 配置

- `turnInjection`（默认开）：是否插入上下文提示；设 `false` 关闭。
- `turnInjectionUsage`（默认关）：是否显示 `[ctx 65% 649k/1M]` 形式。
- `archiveReminder`：开关归档提醒循环，可调 `archiveThreshold`（默认 50%）、`reminderEveryNTurns`（2）、`dropThreshold`（15 点）。

### 权限、兼容与隐私

- 默认只读；写相关护栏需显式开启。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 本地优先：无网络请求、无凭据；状态保存在 `$DSH_HOME`。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
