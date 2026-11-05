# Capability audit — what this bundle can and cannot call

`dsh-util-plugs` ships **eight plugin rows**. This page is the public, bundle-scoped
capability index behind the `team-bootstrap` skill: it separates what the model
can call from what needs a human/operator, what is UI-only and what is an
automatic hook. The source workspace's internal audit (per-file evidence,
incident history) is not shipped here.

> Rule of thumb: **a tool exists in your session ⇒ callable; a panel exists in
> the browser ⇒ you (the model) cannot operate it; a hook exists ⇒ observe its
> status and act on its advice.**

## 1. Four capability classes

| Class | Meaning | Examples in this bundle | How the model uses it |
|---|---|---|---|
| **Callable** | A tool or skill in the session's catalog | `context_guard_status`, `team_hooks_status`, `message_send/queue/read/ack/routes/status`, `network_info`, `pitfalls`, `workbench_status`, `auto_backup_status`, `restart_dsh` (step 1 only), `restart_status`; skills `team-bootstrap`, `network-intro`, `session-meeting`, `delegation-priority`, `workspace-agents`, `context-usage`, `prompt-forge` | Call the tool or load the skill. Check `nextSkill` returned by `network_info` / `pitfalls` first. |
| **Conditional** | Depends on row enablement, operator configuration or a human pre-step | `team_init` / `team_members_check` (agent-workflows row; use `preview:true` before writing), `prompt_forge_*` (agent-workflows row), `alias_register` / `workspace_agents_init` (after confirmation), `message_route_register` (operator sets `allowRouteRegister:true`), `restart_dsh` step 2 (token + PID suffix + `allowRealRestart:true`) | Satisfy the condition or state what is missing; never fake it. |
| **UI-only** | Browser panels; the model has no DOM | sidebar **Messages** page (message-bus client), conversation-header **Restart DSH** button (host-relaunch client), native Settings / Plugins pages, preset selector | Tell the user where to click; do not look for a same-named tool. |
| **Automatic hook** | Runs on host events; the model cannot trigger it | per-turn `[ctx %]`, `[context-meter]` threshold advisory, archive-reminder loop, `roleWritePolicy`, delegation advisor, `writeGate` (default off), `problemLoop` (default off), auto-backup pre-write snapshot, kill/terminate fence | Observe via status tools; enable/disable is an operator config action. |

## 2. Callable surface per row

| Row (`cordis.patch.yml` id) | Tools / skills it registers |
|---|---|
| `context-sentinel` | `context_guard_status`, `team_hooks_status`, skill `context-usage`; hooks: `[ctx %]`, threshold advisory, archive loop, write policy, delegation advisor, optional write gate/problem loop |
| `message-bus` | `message_send`, `message_queue`, `message_read`, `message_ack`, `message_routes`, `message_bus_status`, `message_purge` (operator), `message_route_register` (conditional); Web message center |
| `team-bus` | `network_info`, `pitfalls`, `alias_register` (conditional), `workspace_agents_init` (conditional); skills `network-intro`, `session-meeting`, `team-bootstrap`, `delegation-priority`, `workspace-agents` |
| `agent-workflows` | `team_init`, `team_members_check`, `prompt_forge_status/next/advance/verify_dispatch/verify_record/reset_subagent`; skill `prompt-forge` |
| `workbench-bundle` | `workbench_status` (read-only overview) + first-turn capability pointer |
| `auto-backup` | `auto_backup_status`; pre-write snapshot hook |
| `host-relaunch` | `restart_dsh` (step 1 preflight is model-safe; step 2 is human/operator), `restart_status`; Web header button; kill fence |

## 3. Operator-only / human-confirmation boundaries

| Capability | Boundary |
|---|---|
| `message_purge` | Permanent deletion of messages, deliveries and read-state rows. Requires `confirm:"PURGE"` plus `before` (ISO timestamp) or `all:true`; show impact and get explicit confirmation. Never use it to hide a delivery failure. |
| `message_route_register` | Changes alias → session routing. Disabled by default (`allowRouteRegister:false`); only exists after an operator enables it. |
| `alias_register` | Changes a session alias/route. Preview (`dryRun`) first; get human/meeting confirmation before applying. |
| `team_init` | Writes `team/` templates. Call with `preview:true` first; the captain/user confirms the created/skipped list before a real write. Root stays inside the session workspace. |
| `workspace_agents_init` | Writes the workspace `AGENTS.md` on first use. Ask the user for the purpose first; never overwrite an existing file. |
| `restart_dsh` step 2 | Real restart needs a one-time token **and** the host PID suffix **and** `allowRealRestart:true`. With the shipped default `allowRealRestart:false` the confirm is refused before any side effect. Never promise a model-driven restart. |
| `prompt-forge` S6 | Must be verified by a fresh-context `subagent` (never `subagent_fork`) and recorded with `prompt_forge_verify_record`; a fallback reason is an explicit degradation, not self-certification. |

Common rules:

1. Read state / preview first (`dryRun`, `preview`, `restart_status`), then ask for explicit confirmation.
2. “Not refused” is not consent; “delivered/read” is not an ACK.
3. When a lock or parameter is missing, report it — do not retry around it.
4. Irreversible actions need an evidence/rollback path (audit, backup, meeting FINAL/ACK).

See [`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md) for the dedicated page.

## 4. Three common misreads

1. **The Web UI is not a model capability.** The Messages page and the Restart button are
   browser panels; the model cannot open or click them.
2. **A real restart is a human gate.** `restart_dsh` step 1 is read-only; step 2 needs
   token + PID suffix + `allowRealRestart:true` (currently `false` in the shipped patch).
3. **`writeGate` / `problemLoop` default off.** `team_hooks_status` shows their state; enabling
   them is an operator configuration + authorization action, not a model action.

## 5. Consistency gate

This document, each row's tool registrations and the seven `cordis.patch.yml` rows are
checked together before packaging:

```sh
npm run verify        # one bundle + seven rows, no npm deps, no internal paths
npm run verify:client # composed Web client halves + slots
```

If you change a row or a tool, update this page in the same change. The bundle never
registers preset rows (`preset-*`); the `agent-workflows` row provides the runtime tools,
not the agent-preset registry entries of the source packages.
