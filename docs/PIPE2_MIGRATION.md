# pipe2 / 旧工具迁移对照

`pipe2_*` 与旧 team 工具已下线；当前环境不再注册这些名字。调用会得到 `unknown tool`。

| 旧工具 | 状态 | 当前替代 |
|---|---|---|
| `pipe2_session_post` | 已下线 | `message_send` |
| `pipe2_queue` | 已下线 | `message_queue` |
| `pipe2_read_message` | 已下线 | `message_read` |
| `team_init` | 已退役 | 无；DSH-native `agentTeams` / session identity 为准 |
| `team_members_check` | 已退役 | 无；用 `network_info` / `apartment_binding_list` |
| `apartment_team_*` | 已退役 | 无；历史数据只读保留 |
| `apartment_task_role_*` | 已退役 | 无；全局任务板由 `bulletin_board_*` 承担 |
| `subenv_task_submit` | 默认关闭/退役 | 无；自定义 embedded runner 已停用 |

跨会话消息使用：

```text
message_send -> message_queue / message_read -> message_ack
```

全局任务与会议收口：

```text
bulletin_board_* / bulletin_task_*
meeting_* / meeting_action_update
```

若旧文档或旧记忆仍引用 `pipe2_*`/team 工具，按本表替换。

> `message_route_register` 默认关闭（`allowRouteRegister:false`）；存量 route 仍可解析，`retired` 只表示不再用于新注册/展示。
