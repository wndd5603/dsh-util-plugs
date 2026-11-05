# dsh-auto-backup — 自动备份

Automatic pre-write file backups for DeepSeek Harness: snapshot files before edits, keep project-local backups with retention, and inspect status anytime.

为 DeepSeek Harness 提供写前自动备份：编辑前保存快照、项目内保留策略，以及随时可查的只读状态。

> Row version: 2026.11.4-1 · bundle 2026.11.5-1 (preview) · npm HOLD: install from GitHub source.

## English

### What it brings

- Before a write/edit tool runs, copy the existing target into the project's `file_backups/` directory.
- Retention controls for per-file, large-file and total backup size.
- `auto_backup_status()` — read-only health and summary.
- Shell commands that write files are **not guaranteed** to be backed up.

Example:

```text
auto_backup_status()
→ enabled, project root, backup count/size and retention
```

### Install (GitHub source; npm HOLD)

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

The bundle adds seven rows; enable `auto-backup`. npm is on HOLD — do not use `dsh plugin add dsh-auto-backup` yet.

### Usage

Use the normal write/edit tools; existing files are copied before the edit. Check `auto_backup_status()` to confirm the project root and retained backups.

### Configuration

`enabled`, retention limits and project-root resolution (per session workspace). Backups stay under the project's `file_backups/`.

### Permissions, compatibility & privacy

- Local backups only; no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Uninstall does not delete existing backups; remove them manually when appropriate.

### Tests & uninstall

From a source checkout: `npm test`. The GitHub bundle can be checked with `npm run verify`.

Disable or remove the plugin row in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its rows. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 功能

- write/edit 工具执行前，把已存在的目标文件复制到项目的 `file_backups/`。
- 支持单文件、大文件与总容量的保留策略。
- `auto_backup_status()`：只读查看健康状态与摘要。
- 通过 shell 写文件**不保证**被备份。

示例：

```text
auto_backup_status()
→ 启用状态、项目根、备份数量/大小与保留策略
```

### 安装（GitHub source；npm 暂缓）

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-1
```

bundle 会加入 7 个 row；启用 `auto-backup`。npm 在 HOLD 期间未发布，请勿使用 `dsh plugin add dsh-auto-backup`。

### 使用

照常使用 write/edit 工具；已存在文件会在编辑前被复制。用 `auto_backup_status()` 确认项目根与保留的备份。

### 配置

`enabled`、保留上限与项目根解析（按会话工作区）。备份保存在项目的 `file_backups/` 下。

### 权限、兼容与隐私

- 仅本地备份；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 卸载不会删除已有备份；需要时手动清理。

### 测试与卸载

源码目录内运行 `npm test`；GitHub bundle 可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应 row；若不再使用整个 bundle，可从 profile 移除。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
