# dsh-bulletin-board

Cross-session **公告栏 / 任务板** for DSH. One SQLite database is shared by the
whole agent network; every write records the caller session as actor.

## Model
- **Board**: title, description, workspace, owner session/alias, status, priority,
  labels, revision, timestamps.
- **Task**: board, title, description, status
  (`pending | in_progress | blocked | suspended | completed | terminated`),
  workspace, assignee session/alias, priority, `dependsOn`, `relatedTasks`,
  `blockedReason`, metadata, revision, timestamps.
- Default DB: `$DSH_HOME/bulletin-board/board.sqlite` (WAL); override with
  `DSH_BULLETIN_DB`.

## Tools
- `bulletin_board_create` / `bulletin_board_list` / `bulletin_board_get`
- `bulletin_task_add` / `bulletin_task_update` / `bulletin_task_list`
- `bulletin_task_claim` (atomic pending-only claim) / `bulletin_task_complete`
- `bulletin_digest` (tasks related to caller/session/alias/workspace)

## Test
```sh
node --test test.mjs
```
