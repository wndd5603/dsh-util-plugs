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

### 6.1 live 验证（2026-11-21，-90 重启后）

- 磁盘（验证时全库 2174 文件 / 24.5 MB）：符合当前快照格式的 **1484** 份**全部为 `.gz`**
  （11.77 MB），gzip 完整性逐份校验 **1484/1484 OK**。修复后新增写入使快照增至
  1494 份（明文 9 / gz 1485），属正常的明文窗口行为。
- 计数口径（-91 及以前）：`auto_backup_status.backupStats` 只统计当前格式（plain + `.gz`）；
  另有 **401** 份 `_改前_<旧命名>` 明文快照（见 6.2）不在该统计内。`-92` 起三类全部计入。
- 全部压缩的成因：`-90` 之前的 `compactGlobal()` 用“总文件数”做阈值（压缩不降低总数），
  一旦越线就会把明文快照全部压缩。21:28–21:35 的 `.gz` mtime 突发即那次旧代码所致，
  属无损结果；`-90` 改为按**明文份数**计量后不会再发生。
- 修复后行为：新快照先以明文写入，每文件保留最新 5 份明文，仅当全库明文数 >400
  或总大小 >200 MB 时从最旧开始压缩；`compactGlobal()` 每轮重算，压缩后即停。

### 6.2 旧命名快照（-92 起为一等公民）

- 旧命名分两类：`legacy`（时间戳可解析，如 `…_2026-11-04_222804.md`、
  `…_20261021_015421_AGENTS.md`、`…_20261116133341.md`）与 `unknown`
  （`_改前_` 开头但无可解析时间戳，如 `_改前_自述修正__AGENTS.md`）。
- **-92 之前**：两者都落在 `SNAPSHOT_RE` 之外 ⇒ 既不计入 `backupStats`，也不参与
  全局阈值 ⇒ 项目若以旧命名为主，压缩阈值永不触发（game-captain 在 780 份/82 MB
  的项目上实测：工具只看到 125 份/8.4 MB）。
- **-92 之后**：两类都计入 `count` / `totalMB` / 阈值 / 压缩范围；`formatCounts`
  给出三类分布；`statsCrossCheck` 用**独立扫描**对比“计入数 vs 磁盘数”。
- 排序：`legacy` 用归一化后的名字时间戳（`20261017_155816` → `20261017_155816000`），
  `unknown` 用 mtime（`stampSource:"mtime"`）。压缩本身是逐文件操作，不依赖能否解析
  文件名，因此"不可解析"不再等于"不可压缩"。
- 归因：`.backup_index.jsonl` 有 143 份的 `source` 记录，可精确对应源文件；其余早于
  账本或本身就是带时间戳的文档名，**不做启发式猜测**（避免把不同文件并进同一保留组）。
  历史检索改为按 basename 后缀匹配，旧快照同样能被 `auto_backup_history` 列出。

### 6.3 -92 修复与实测（2026-11-21）

- 起因：game-captain 报告 `backupStats` 只统计 125 份，磁盘实有 780 份。
  归因纠正：**不是 batch 过滤**（代码无 batch 条件），而是 `SNAPSHOT_RE` 只认
  `_YYYYMMDD_HHMMSSmmm_` 毫秒格式。
- 实测（修复后，同一目录）：
  - game-captain 项目：`count 658 / 磁盘 658`，`formatCounts{current 127, legacy 522, unknown 9}`，
    `overPlainBudget:true`（658 > 400）⇒ 阈值开始生效。
  - 本仓库：`count 1919 / 磁盘 1919`，`{current 1518, legacy 400, unknown 1}`，明文 421 > 400。
- 其他同批修复：`counters` 改 per-root（原先一个宿主进程内多 workspace 共用一个计数器，
  与 `root.path` 并排显示会误导）；`countersScope` 明确写成"仅本项目根"。
- 测试：`scripts/test-auto-backup-history.mjs`（-92 时 6 例，-93 增至 7 例；
  含 legacy/unknown 计入与压缩、仅旧命名即可撑破计数预算、旧快照按 basename 可查）。

### 6.4 -93 补齐两个口径漏洞

- `auto_backup_compact` 原本只裁"每文件明文窗口"，没有跑全局预算 ⇒ 快照分散在许多
  文件时（本仓库 423 份明文分布在数百个 basename 上）干跑报 `wouldChange: 0`，
  但明文数已超 400。现在干跑分列 `perFileWindow` 与 `global.wouldCompress`，
  真正执行时再调 `compactGlobal()` 跑与钩子相同的全局 pass。
- 计数单位写明为**普通文件**：`backupStatsScope` / `statsCrossCheck.note` 明确
  "目录名以 `_改前_` 开头也不算快照"。起因是 game-captain 用 `ls | wc -l` 时把
  31 个历史批次目录也算进了"份数"（780 vs 真实 654），随后自己认错——同一类
  "范围没标注"的问题，在字段文案层面消除。
- 实测（-93 live）：本仓库 `count 1925 / 磁盘 1925`、明文 423、gz 1502、
  20.53 MB 四项与磁盘逐项相等；`statsCrossCheck.matchesDisk:true`、
  `thresholds.overPlainBudget:true`。

## 七、如何用历史推导改动

```text
auto_backup_history({ file: "lua_scripts/levels.lua" })
  -> snapshots[...] 每行有 stamp / compressed / size

auto_backup_show({ file: "lua_scripts/levels.lua", stamp: "20261121_212207210" })
  -> content（.gz 自动解压）

# 两个版本 diff：
#   分别 show 两次到临时文件，再 diff；或直接读 file_backups 下的 .gz 用 gunzip 还原
```

## 七点五、长期回滚锚点：出池法（-95 采纳，替代"手工优先明文"改代码）

问题：明文窗口（`prune()`，`index.js:512-516`）与全局预算（`compactGlobal()`，
`index.js:533-542`）**都按时间排序**，与 batch 无关 ⇒ 手工快照同样会被压缩。
曾考虑改代码让"手工/批次快照优先保留明文"（排序优先级或 pin 名单），评估后**不采用**：

| 方案 | 结论 |
|---|---|
| A 排序优先（auto 先压、手工后压） | 与 400 明文预算会打架，需定义回落规则；收益仅限"手工快照很多"的场景 |
| B pin 名单（按 batch/glob 永压不动） | 意图显式，但多一份要维护的名单，容易忘 |
| **C 出池（采纳）** | 零代码、零风险，且**彻底脱离**压缩机制，不依赖优先级 |

做法：把要长期保持明文的快照**复制**到 `file_backups/` 下的子目录 —— 钩子只扫
`backupDir` 直属普通文件，子目录不计数、不压缩、不删除；复制后 `sha256sum` 比对两份一致。

- 代价：锚点不进 `status`/`history`，不跟随后续编辑（这是目的）。
- 已在 `vendor/auto-backup/README.md` 写成用户文档（中英各一节）。
  实现依据 `index.js:380-386`：`readdirSync(backupDir)` 只枚举直属条目，目录条目被
  `if (!info.isFile()) continue` 跳过且**从不下降** ⇒ **任意嵌套深度都不可见**（不只一层）。
- 实测依据：game-captain 项目 3 个锚点复制到 `回滚锚点_教程优化_20261121/`，
  sha 逐字一致，且未被 compact 触碰。

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
