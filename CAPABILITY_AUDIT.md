# Capability audit — dsh-util-plugs

`dsh-util-plugs` ships **eleven switchable rows**. DSH-native agent/session/team identity is authoritative;
the bundle keeps durable memory, global boards, meetings, aliases, leases and operator utilities.

## 1. Capability classes

| Class | Meaning | Examples |
|---|---|---|
| **Callable** | Tool/skill present in the session catalog | `collaboration_recall`, `message_*`, `bulletin_*`, `meeting_*`, `memory_*`, `apartment_lease_*`, `auto_backup_status`, `restart_status` |
| **Conditional** | Row/config/operator/human gate | `message_purge`, `message_route_register`, `restart_dsh` step 2, `prompt_forge_*` |
| **UI-only** | Browser panels; model has no DOM | 协作网络, 插件控制台, Restart button, native Plugins |
| **Automatic hook** | Host events | `[ctx %]`, archive reminder, write policy, delegation advisor, auto-backup, kill fence |

## 2. Rows and current tools

| Row | Tools / UI |
|---|---|
| `context-sentinel` | `context_guard_status`, `team_hooks_status`; `[ctx %]`, archive/write/delegation hooks |
| `message-bus` | `message_send/queue/read/ack/routes/status/purge*`, `message_route_register*`; 协作网络; Web delete default off |
| `bulletin-board` | `bulletin_board_*`, `bulletin_task_*`, `bulletin_digest`; global task board |
| `agent-apartment` | `apartment_agent_*`, `apartment_lease_*`, `apartment_experience_*`, backup/verify/root/migrate, `apartment_collaboration_brief`, `collaboration_recall` |
| `agent-memory` | `memory_remember/search/list/digest/quality/supersede/forget` |
| `team-bus` | `network_info`, `pitfalls`, `alias_register*`, `workspace_agents_init*`, `meeting_*`; skills |
| `agent-workflows` | `prompt_forge_*`; skill `prompt-forge` (captain team tools retired) |
| `workbench-bundle` | `workbench_status`, `artifact_manifest`; first-turn pointer |
| `auto-backup` | `auto_backup_status`; pre-write snapshots |
| `host-relaunch` | `restart_dsh` (step 2 human gate), `restart_status`; header button; kill fence |
| `plugin-console` | 插件控制台 UI (cards/config/extension contributions); host row is a presentation companion |

`*` conditional/operator-gated.

## 3. Team boundary

- DSH-native `agentTeams`/session identity are authoritative.
- Retired: `team_init`, `team_members_check`, `apartment_team_*`, `apartment_task_role_*`, `apartment_team_task_list`.
- Kept: global `bulletin-board`, `meeting_*`, aliases/routes, leases.
- Historical team/task_role rows remain in the DB read-only; they are not exposed by plugin tools.
- `collaboration_recall` returns identity/aliases/global-board tasks/leases/memory keys/artifact only.

## 4. Operator boundaries

| Capability | Boundary |
|---|---|
| `message_purge` | `confirm:"PURGE"` + `allowPurge:true`; explicit human confirmation |
| `message_route_register` | `allowRouteRegister:false` by default |
| Web delete | `webUi.allowDelete:false` by default |
| `restart_dsh` step 2 | token + PID suffix + `allowRealRestart:true` |
| `prompt-forge` S6 | fresh-context `subagent`, recorded verdict |
| `auto-backup` restore | operator; backup manifest verified |

## 5. Consistency

```sh
npm test          # 45+ tests
npm run verify    # 11 rows, zero npm deps
npm run verify:client
```

Row/tool changes must update this page in the same commit. Native `plugins.row.config` is not used yet:
DSH requires namespace == rowId, while bundle rows use full entryIds; plugin-console is the current settings UI.
