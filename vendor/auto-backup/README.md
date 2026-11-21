# dsh-auto-backup — 自动备份

Automatic pre-write file backups for DeepSeek Harness: snapshot files before edits, keep a **lossless** project-local history (older snapshots are gzipped, never deleted), and inspect or diff any two versions anytime.

为 DeepSeek Harness 提供写前自动备份：编辑前保存快照，**不删除任何历史**（旧快照压缩为 `.gz`），并可随时查看状态、对比任意两个版本。

> Version: 2026.11.4-1 · Not yet published on npm; install from GitHub.

## English

### What it brings

- Before a write/edit tool runs, copy the existing target into the project's `file_backups/` directory.
- Lossless history: snapshots are never deleted; only the newest plain window per file stays uncompressed, older ones are gzipped when the plain-file or total-size budget is crossed.
- The whole directory counts: `current` (names written by this hook), `legacy` (older stamp formats) and `unknown` (a `_改前_` name with no usable stamp) are all included in the totals, the global budgets, and compaction. Names without a stamp are ordered by mtime.
- `auto_backup_status()` — read-only health and summary (`formatCounts`, `thresholds`, `statsCrossCheck` compares the counted total with an independent scan of the directory).
- `auto_backup_history({file})` / `auto_backup_show({file, stamp})` — list snapshots and read one (`.gz` decompressed transparently) to diff any two versions; matching is by basename suffix, so pre-redesign snapshots are included.
- `auto_backup_compact()` — gzip-only maintenance (dry-run by default); physical delete requires `allowDelete:true` plus `mode:"delete"`.
- Shell commands that write files are **not guaranteed** to be backed up.

Example:

```text
auto_backup_status()
→ enabled, project root, count/size (plain vs compressed), formatCounts, threshold state
```

### Install from GitHub

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

The bundle adds eight plugins; enable `auto-backup`. The packages are not published on npm yet; install from GitHub instead of `dsh plugin add dsh-auto-backup`.

### Usage

Use the normal write/edit tools; existing files are copied before the edit. Check `auto_backup_status()` to confirm the project root and snapshot totals.

### Configuration

`enabled`, the plain (uncompressed) window and project-root resolution (per session workspace). Backups stay under the project's `file_backups/`; `allowDelete` defaults to `false` and the hook never deletes a snapshot.

### Keeping a long-lived rollback point (out-of-pool anchors)

The plain window and the global budget decide which snapshots stay readable as
plain text, and both sort by time — so **any snapshot can eventually be gzipped**,
including one you created by hand. If you need a rollback point that stays plain
text forever, keep it **outside the snapshot pool**:

```text
file_backups/_改前_auto_…_levels.lua           ← pool: may be gzipped later
file_backups/rollback-anchors-20261121/        ← subdirectory: never scanned
  01_before-refactor_levels.lua
  02_before-bugfix_levels.lua
  README.txt
```

- The hook scans **regular files directly inside `backupDir`** (`_改前_*`). Any entry
  that is a directory is skipped and **never descended into**, so nesting depth does
  not matter: `anchors/a/` and `anchors/a/b/c/` are both invisible — never counted,
  compressed, or deleted.
- Copy (do not move) the snapshot you want to keep, then verify the copy:
  `sha256sum` both files and compare; the copy is independent of the pool.
- Trade-off: an anchor is not tracked by `auto_backup_status` / `auto_backup_history`,
  and it does not follow later edits — that is the point: it must not move.
- Recommended: add a short `README.txt` in the anchor directory explaining what each
  file is and how to restore it, so the intent survives without external notes.

### Permissions, compatibility & privacy

- Local backups only; no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Uninstall does not delete existing backups; remove them manually when appropriate.

### Tests & uninstall

Run `npm test` from a source checkout; after installing the bundle, run `npm run verify`.

Disable or remove the plugin entry in Settings → Plugins. Remove the bundle from the profile if you no longer need any of its plugins. Local data under `$DSH_HOME` is not deleted automatically.

### License

MIT © 2026 wndd5603

## 中文

### 功能

- write/edit 工具执行前，把已存在的目标文件复制到项目的 `file_backups/`。
- **无损历史**：快照永不删除；每个文件最新几份保留明文，明文份数或总大小超阈值时从最旧开始压缩为 `.gz`。
- **统计覆盖整个目录**：`current`（本钩子写的）/ `legacy`（旧时间戳格式）/ `unknown`（`_改前_` 开头但无可解析时间戳）三类都会计入总量、全局阈值与压缩范围；无时间戳的按 mtime 排序。
- `auto_backup_status()`：只读查看健康状态与摘要（`formatCounts`、`thresholds`；`statsCrossCheck` 会把"计入数"与独立扫描磁盘的数对比）。
- `auto_backup_history({file})` / `auto_backup_show({file, stamp})`：列出某文件的全部快照、读取某一份（`.gz` 自动解压），用于对比任意两个版本；按 basename 后缀匹配，旧命名快照同样可查。
- `auto_backup_compact()`：只压缩的维护工具（默认 dry-run）；物理删除需 `allowDelete:true` 且 `mode:"delete"`。
- 通过 shell 写文件**不保证**被备份。

示例：

```text
auto_backup_status()
→ 启用状态、项目根、数量/大小（明文 vs 压缩）、formatCounts、阈值状态
```

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:wndd5603/dsh-util-plugs#v2026.11.5-9
```

安装包会加入 8 个插件项；启用 `auto-backup`。目前尚未发布到 npm，请从 GitHub 安装；不要使用 `dsh plugin add dsh-auto-backup`。

### 使用

照常使用 write/edit 工具；已存在文件会在编辑前被复制。用 `auto_backup_status()` 确认项目根与快照总量。

### 配置

`enabled`、明文（未压缩）窗口与项目根解析（按会话工作区）。备份保存在项目的 `file_backups/` 下；`allowDelete` 默认 `false`，钩子永不删除快照。

### 长期保留一个"回滚锚点"（出池法）

明文窗口与全局预算都按时间排序决定谁保持明文 ⇒ **任何快照最终都可能被压缩**，
包括你手工建的那份。若需要"永远保持明文"的回滚点，把它**放到快照池之外**：

```text
file_backups/_改前_auto_…_levels.lua           ← 池内：将来可能被压成 .gz
file_backups/回滚锚点_20261121/                 ← 子目录：永不被扫描
  01_重构前_levels.lua
  02_修复前_levels.lua
  README.txt
```

- 钩子只扫 `backupDir` **直属的普通文件**（`_改前_*`）；**任何目录条目一律跳过，且从不进入**，
  所以嵌套层级无关紧要：`锚点/a/` 与 `锚点/a/b/c/` 同样不可见，都不计数、不压缩、不删除。
- 用**复制**（不是移动）：复制后用 `sha256sum` 对比两份文件一致；复制件独立于快照池。
- 代价：锚点不出现在 `auto_backup_status` / `auto_backup_history` 里，也不跟随后续编辑
  —— 这正是它的目的：不允许它变。
- 建议在锚点目录里放一份 `README.txt` 说明每份文件是什么、怎么还原，意图不依赖外部笔记。

### 权限、兼容与隐私

- 仅本地备份；无网络请求、无凭据。
- 兼容 DeepSeek Harness `>=0.2.0 <0.3.0`、Node.js `>=24`。
- 卸载不会删除已有备份；需要时手动清理。

### 测试与卸载

源码目录内运行 `npm test`；安装包可用 `npm run verify` 自检。

在「设置 → 插件」中禁用或移除对应插件项；若不再使用整套插件包，可从 profile 卸载。`$DSH_HOME` 下的本地数据不会自动删除。

### 许可证

MIT © 2026 wndd5603
