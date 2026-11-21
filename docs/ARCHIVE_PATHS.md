# 归档路径与只读策略

## 正式路径

```text
team/members/<role>/ARCHIVE_<YYYYMMDD_HHMMSS>.md
```

`team_hooks_status.archivePath` 只接受 `ARCHIVE_*.md` 且不在 `scratch/` 下；优先使用观测到的正式归档，否则取角色目录下最新的正式归档。

## 可写性

`roleWritePolicy` 默认：

```text
allowOwnMemberDir: true
allowSegments: ['scratch', 'file_backups']
```

因此本角色自己的：

```text
team/members/<own role>/
```

是可写的，归档不需要落到 `scratch`。`scratch/archive_s*.md` 只是中间草稿，不应作为正式归档路径。

若某个角色仍被策略拒绝写 `team/members/<role>/`：

1. 不要改 `team_hooks_status` 路径去指向 scratch；
2. 由 operator 调整该角色的 `roleWritePolicy.allowOwnMemberDir` 或 `allowSegments`；
3. 或把正式归档放到策略允许的目录，并在归档状态里明确注明（当前版本尚未提供自动替代根目录，属于已知未完成项）。

若是用脚本写作（bash/node fs.writeFileSync）合并归档，`archivePathSource` 会保持
`latest-or-canonical`，因为该字段只记录 write/edit 工具调用观察到的路径；这不表示归档失效。
此时路径仍由“本角色归档根目录下最新 ARCHIVE_*.md”扫描得到。

Windows 路径大小写不敏感；当前状态里可能出现 `lead` 而实际目录是 `Lead`，可解析，但不要把它当作路径不一致的证据。

## 提醒去重

- 归档提醒只在 `phase=archive` 的周期内按 `reminderEveryNTurns` 提醒；
- 已观测到正式归档后，不应再把 scratch 草稿当作 `archivePath`；
- 若路径为空或不存在，提醒会要求按规范创建/补全，不会新建第二个周期归档。
