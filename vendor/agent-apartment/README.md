# dsh-agent-apartment

Centralized **Agent Apartment** for DSH:
- per-agent home directories (`agents/<id>/AGENTS.md`, `skills/`, `tools/`)
- workspace leases (`work/<taskId>/`)
- experience records
- root backup with manifest/sha256, verification and migration pointer
- read-only `collaboration_recall` (identity, aliases, global-board tasks, leases, memory keys, artifact)

Default root: `$DSH_HOME/apartment`; override with `root` config or `apartment_set_root`/`apartment_migrate`.

Tools: `apartment_status`, `apartment_agent_*`, `apartment_lease_*`,
`apartment_experience_*`, `apartment_collaboration_brief`, `collaboration_recall`,
`apartment_import_legacy`, `apartment_backup`, `apartment_verify`,
`apartment_set_root`, `apartment_migrate`.

> DSH-native agent/session/team identity is authoritative. The former team/membership/
> task-role tools are retired; historical rows stay read-only in the DB.
