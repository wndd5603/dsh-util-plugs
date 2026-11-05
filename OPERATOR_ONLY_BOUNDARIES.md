# Operator-only / human-confirmation boundaries

Irreversible or identity-changing actions in `dsh-util-plugs` are separated from normal
tool calls. The model may prepare, preview and explain them; a human/operator must
confirm. Capability inventory: [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md) and the
`team-bootstrap` skill.

## 1. Boundaries

| Capability | Boundary | The model may | The model must not | Docs |
|---|---|---|---|---|
| `message_purge` | destructive permanent deletion; requires `confirm:"PURGE"` + `before` or `all:true` | show the impact, request explicit confirmation | delete on its own; call “cleanup” instead of confirmation | `vendor/message-bus/README.md` |
| `message_route_register` | changes alias → session routing; default `allowRouteRegister:false` | explain that an operator must enable it; inspect current state | pretend it exists; hijack another session's alias | `vendor/message-bus/README.md` |
| `alias_register` | changes session alias/route; cross-session identity | preview with `dryRun`; request human/meeting confirmation | change an alias without confirmation; overwrite someone else's route | `vendor/team-bus/README.md` |
| `team_init` | writes `team/` templates; recommend preview | call `team_init({preview:true})` and show created/skipped | overwrite existing team files; skip user confirmation | `vendor/agent-workflows/README.md` |
| `workspace_agents_init` | first write of a workspace `AGENTS.md` | explain what will be created; ask the purpose first | overwrite an existing `AGENTS.md`; fall back to host cwd | `vendor/team-bus/README.md` |
| `restart_dsh` step 2 | real restart needs token + PID suffix + human/author authorization; `allowRealRestart:false` refuses confirm | step 1 preflight and `restart_status`; explain the lock | claim it can restart the host; bypass `allowRealRestart`/blockers | `vendor/host-relaunch/README.md` |
| `prompt-forge` S6 | fresh-context `subagent` verification with nine-dimension verdicts | dispatch the packet and record verdicts; explain the gate | self-certify in the same context; silently skip via `prompt_forge_advance` | `vendor/agent-workflows/prompt-architect/skills/prompt-forge/SKILL.md` |

## 2. Rules

1. Read state / preview first (`dryRun`, `preview`, `restart_status`), then ask for explicit confirmation.
2. “Not refused” is not consent; “delivered/read” is not an ACK.
3. When a lock or a parameter is missing, report it — do not retry around it.
4. Irreversible actions need a rollback or evidence path (audit, backup, meeting FINAL/ACK).

## 3. Three common misreads

1. **The Web UI is UI-only.** The Messages page and the Restart button cannot be operated by the model.
2. **Real restart is a human gate.** Step 1 is read-only; step 2 needs token + PID suffix and is
   refused while `allowRealRestart:false` (the shipped default).
3. **`writeGate` / `problemLoop` default off.** `team_hooks_status` only displays their state;
   enabling them is an operator configuration + authorization action.

## 4. Acceptance

- Every boundary above has an explicit section in the corresponding `vendor/*/README.md` or skill;
- the `team-bootstrap` skill's four-class table and `CAPABILITY_AUDIT.md` stay consistent;
- `npm run verify` and the privacy gate pass before packaging.
