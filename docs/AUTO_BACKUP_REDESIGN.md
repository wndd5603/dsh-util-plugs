# auto-backup 改造方案（不删备份 + 阈值压缩）

作者原意：**尽量多保留历史，能推导“从某一次到当前”的全部改动**；因此不应删除任何快照。

## 一、现状与问题（接口/逻辑/调用链）

### 接口（对外）

| 接口 | 类型 | 行为 |
|---|---|---|
| `tools/pre-execute` hook | 写前钩子 | `manager.backup(target)` |
| `auto_backup_status` | 只读工具 | 配置/统计/计数 |
| `auto_backup_prune` | 写工具（-85 新增） | 按 basename 保留 N 份，其余 **删除** |

`createBackupManager(config)` 暴露：`shouldBackup` / `backup` / `prune` / `targetFromArguments` / `detectBashWrite` / `existingBackups` / `allBackupFiles` / `totalBackupMB` / `stats` 等。

### 调用链（backup）

```text
backup(targetPath)
  -> shouldBackup()            白名单/排除判定
  -> existingBackups()[0]      取最新快照
  -> sha256 比对               相同则跳过（幂等）
  -> copyFileSync              写 _改前_<batch>_<ts>_<basename>
  -> appendFileSync            追加 .backup_index.jsonl
  -> prune(absolute,size,rel)  ★ 超出 retentionFor() 直接 unlink
  -> 大文件 WARN
  -> enforceTotalLimit(overMB) ★ 超过 maxTotalMB 直接 unlink 最旧
```

### 问题

1. `prune()` / `enforceTotalLimit()` 都 **物理删除**，与“保留全部历史”冲突。
2. `retentionFor()` 的 `keepPerFile=30` / `largeRetention=5` 实际是“删到只剩 N 份”。
3. `maxTotalMB=800` 超限即删，最坏情况把唯一历史删掉。
4. 已有 1596 份快照、742 份待删（dry-run），按原逻辑继续会持续丢历史。

## 二、方案评估

### 方案 A：保留全部 + 阈值触发 gzip 压缩（推荐）

- 永不删除；超过阈值时把**较旧**的快照 gzip 成 `<原名>.gz`。
- 最新 `keepUncompressedPerFile` 份保持明文，便于快速 diff。
- 压缩是**无损**的，`gunzip` 后可完整 diff，满足“推导全部改动”。
- 零外部依赖，纯 Node `node:zlib`。
- 代价：压缩后读取需解压；压缩率取决于文本，通常 5–10×。

### 方案 B：结合 git（内容寻址）

- 在 `file_backups/.git` 建私有仓库，把每次快照写成 blob/commit。
- 优点：自动去重（相同内容只存一份）、内置 zlib 压缩、`git diff <a> <b>` 直接可得改动。
- 缺点：
  - 依赖宿主有 git 可执行文件；
  - 备份目录在项目内，需避免被项目自身 git 跟踪（`.gitignore`）；
  - 并发写（多会话同时备份）需要锁，失败模式更多；
  - 与 DSH 的 `workspace-changes` 会话快照职责部分重叠。
- 结论：**作为后续可选增强**，不作为本轮主方案；先在文档写明可切换。

### 方案 C：两者并存（A 为主，git 可选）

- 默认 A；`mode: "git"` 时用 git 存 blob。
- 实现复杂度与测试成本最高，本轮不做。

### 决策

采用 **方案 A**，并预留文档说明 B 的可行性。

## 三、改造后语义

| 配置 | 默认 | 含义 |
|---|---|---|
| `keepUncompressedPerFile` | 5 | 每文件保留明文份数（更新的明文） |
| `compressWhenFilesOver` | 400 | 快照文件总数超过则压缩最旧明文 |
| `compressWhenTotalMBOver` | 200 | 备份总占用超过（MB）则压缩最旧明文 |
| `allowDelete` | false | 唯一允许物理删除的开关；hook **永不**删除 |

- `backup()` 不再调用删除型 `prune`；改为 `compactAfterBackup()`：
  1. 该文件明文份数 > `keepUncompressedPerFile` ⇒ 压缩最旧明文；
  2. 全局文件数/总占用超阈值 ⇒ 压缩最旧明文，直到回到阈值内；
  3. 仍超限且 `allowDelete=false` ⇒ 仅 WARN，不删。
- `auto_backup_prune`：
  - 默认 `mode: "compress"`，`dryRun: true`；
  - `mode: "delete"` 需 `allowDelete: true` + `confirm: "PRUNE"`。
- 新增只读工具：
  - `auto_backup_history({ file?, limit? })`：列出快照（明文/压缩、时间、大小）。
  - `auto_backup_show({ file, timestamp? })`：输出某份快照内容（自动解压），用于 diff。

## 四、执行步骤

1. 配置与常量：新增 `keepUncompressedPerFile` / `compressWhenFilesOver` / `compressWhenTotalMBOver` / `allowDelete`；修正注释。
2. 快照索引：`existingBackups` / `allBackupFiles` 同时识别 `.gz`；按文件名时间戳排序（而非 mtime）。
3. 幂等比对：最新快照为 `.gz` 时先解压再 sha256。
4. `backup()`：删除 `prune` + `enforceTotalLimit` 调用，改为 `compactAfterBackup()`。
5. 实现 `compressOne()` / `compactGroup()` / `compactGlobal()`；压缩失败只 WARN。
6. `auto_backup_prune` 改为压缩优先，删除需双开关。
7. 新增 `auto_backup_history` / `auto_backup_show`。
8. 测试：`npm test` + 新增用例（压缩后仍可读、幂等、幂等对比 gz）。
9. 安装、重启、live 验证（history 显示既有明文，compact 不删除）。
10. 文档 + 版本 + push dev（不 tag/release）。

## 五、回滚

- 代码回滚到上一 commit 即可；`.gz` 快照仍可用 `gunzip` 还原，**不丢数据**。

## 六、实施结果（2026-11-21，-89）

已落地：

- 配置：`keepUncompressedPerFile`(5) / `compressWhenFilesOver`(400) / `compressWhenTotalMBOver`(200) / `allowDelete`(false)。
- `backup()` 不再删快照：`prune()` 改为“超出明文窗口的旧快照 gzip”，新增 `compactGlobal()` 处理全局阈值。
- 快照索引：`existingBackups`/`allBackupFiles` 同时识别 `.gz`，按文件名时间戳排序；`readSnapshot()` 透明解压；幂等比对支持最新为 `.gz`。
- 工具：
  - `auto_backup_compact`（原 `auto_backup_prune`）：默认只压缩；`mode:"delete"` 需 `allowDelete:true` + `confirm:"COMPACT"`。
  - `auto_backup_history({file})`：列出某文件全部快照（明文/压缩）。
  - `auto_backup_show({file, stamp})`：输出某份快照内容（自动解压），用于 diff。
- 测试：`scripts/test-auto-backup-history.mjs`（保留全部、压缩窗口、gz 幂等、阈值不删除）。

未做：git 方案（见方案 B 的取舍），留作文档化的可选增强。

## 七、如何用历史推导改动

```text
auto_backup_history({ file: "lua_scripts/levels.lua" })
  -> snapshots[...] 每行有 stamp / compressed / size

auto_backup_show({ file: "lua_scripts/levels.lua", stamp: "20261121_212207210" })
  -> content（.gz 自动解压）

# 两个版本 diff：
#   分别 show 两次到临时文件，再 diff；或直接读 file_backups 下的 .gz 用 gunzip 还原
```

## 八、git 方案评估（未采用）

| 维度 | 方案 A（gzip 保留全部，已采用） | 方案 B（git blob） |
|---|---|---|
| 依赖 | 仅 Node | 需宿主有 git |
| 去重 | 无（同内容重复存） | 内容寻址，自动去重 |
| 压缩 | gzip | 内置 zlib |
| diff | 解压后 diff | `git diff` 直接可用 |
| 失败模式 | 低 | 锁、索引损坏、git 缺失 |
| 与 DSH 重叠 | 无 | 与 workspace-changes 职责部分重叠 |

结论：先 A；若未来历史体量导致空间压力明显，再评估在 `backupDir/.git` 建私有仓库做内容寻址（需先解决并发锁与 `.gitignore`）。
