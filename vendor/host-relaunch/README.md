# dsh-host-relaunch — 安全重启宿主

Safe host restart for DeepSeek Harness: read-only preflight, two-step confirmation, a Web header button and a detached supervisor that relaunches the host and resumes sessions.

为 DeepSeek Harness 提供安全的宿主重启：只读预检、两步确认、Web 顶栏按钮，以及重启后恢复会话的独立 supervisor。

> Version: 2026.11.4-2 (bundle 2026.11.5-5) · Not yet published on npm; install from GitHub.

## English

### What's new

- **Two-step model tool** — `restart_dsh()` without `confirm` returns a read-only preflight and a one-time token; `restart_dsh({ confirm, confirmPidSuffix })` performs the confirmed restart and resumes sessions.
- **Web header button** — a「重启 DSH」button appears while the browser has `relaunch` access. It opens an in-page panel (no `window.confirm`) showing the safety lock, PID suffix and running blockers; when safe, type `RESTART` to confirm. The token stays in component state only.
- **Remote endpoints** — `relaunch/status`, `relaunch/prepare`, `relaunch/confirm` back the UI and reuse the same preflight/token/blocker gates. `restart_status()` reports the last restart and audit metadata.

Example:

```text
restart_status()
→ enabled / allowRealRestart / locked / blockers / lastReplay
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

The bundle adds eight plugins; enable `host-relaunch`. The bundle also ships the Web client that renders the header button. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-host-relaunch`.

### Usage

1. Call `restart_status()` for a read-only summary.
2. Model path: `restart_dsh()` for the preflight/token, then `restart_dsh({ confirm, confirmPidSuffix })`.
3. UI path: click the header button and type `RESTART` when the panel is unlocked and unblocked.

### Configuration

- `allowRealRestart` (default **false**): real restarts stay locked until explicitly enabled.
- `enabled`: register the tool, Remote endpoints and client.
- Optional reason/continue prompt for the model path; the token TTL and PID-suffix check are enforced by the host.

### Human confirmation / operator-only

- Step 1 (`restart_dsh()` without `confirm`) is read-only preflight; it is the only model-safe restart action.
- Step 2 (`confirm` + `confirmPidSuffix`) is a human/operator gate. A real restart requires both gates **and**
  `allowRealRestart:true`; with the shipped default `allowRealRestart:false`, confirm is refused before any side
  effect (no token consumption, handoff, spawn or exit). Do not promise a model-driven restart.
- The Web panel is UI-only: the user types `RESTART` and the browser calls the same Remote endpoints. The model
  cannot click it. `/compact` is also a manual operator action, not a restart/tool shortcut.

### Permissions, compatibility & privacy

- Real restarts require the explicit safety lock to be released; preflight always refuses active blockers.
- Windows-first; other platforms degrade to the available restart path.
- Local JSONL audit/handoff files under `$DSH_HOME`; no network calls and no credentials. Tokens are never persisted in plaintext.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 新功能与示例

- **两步模型工具**：`restart_dsh()`（不带 `confirm`）只读预检并返回一次性令牌；`restart_dsh({ confirm, confirmPidSuffix })` 执行确认重启并恢复会话。
- **Web 顶栏按钮**：浏览器有 `relaunch` 权限时显示「重启 DSH」按钮；点击打开页内确认面板（不使用 `window.confirm`），展示安全锁、PID 后四位与运行中阻塞项；安全时输入 `RESTART` 确认。令牌只保存在组件状态中。
- **远程接口**：`relaunch/status`、`relaunch/prepare`、`relaunch/confirm` 支撑 UI，复用同一套预检、令牌与阻塞项校验；`restart_status()` 查看最近重启与审计元数据。

示例：

```text
restart_status()
→ enabled / allowRealRestart / locked / blockers / lastReplay
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-5
```

安装包会加入 8 个插件项；启用 `host-relaunch`。安装包还包含用于渲染顶栏按钮的 Web 客户端。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-host-relaunch`。

### 使用

1. 调用 `restart_status()` 查看只读摘要。
2. 模型路径：先 `restart_dsh()` 获取预检/令牌，再 `restart_dsh({ confirm, confirmPidSuffix })`。
3. UI 路径：面板未锁定且无 blocker 时点击顶栏按钮并输入 `RESTART`。

### 配置

- `allowRealRestart`（默认 **false**）：未显式开启前真实重启保持锁定。
- `enabled`：注册工具、远程接口与客户端。
- 模型路径可选 reason/continue prompt；令牌有效期与 PID 后四位校验由宿主强制执行。

### 人工确认

- 第一步 `restart_dsh()` 是只读预检，可安全由模型执行。
- 第二步需要人工确认：真实重启必须同时满足 `confirm` + `confirmPidSuffix` 且 `allowRealRestart:true`；默认关闭时不会产生任何副作用。
- Web 面板由用户操作：输入 `RESTART` 后浏览器调用同一组远程接口；模型不能点击面板。

### 权限、兼容与隐私

- 真实重启需要显式解除安全锁；预检遇到运行中阻塞项会拒绝。
- Windows-first；其他平台降级到可用的重启路径。
- 本地 JSONL 审计与交接文件保存在 `$DSH_HOME`；无网络请求、无凭据；令牌不会以明文保存。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
