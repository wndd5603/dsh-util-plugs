# dsh-agent-apartment

Centralized **Agent Apartment** for DSH:
- per-agent home directories (`agents/<id>/AGENTS.md`, `skills/`, `tools/`)
- workspace leases (`work/<taskId>/`)
- teams/memberships (many-to-many agents↔teams)
- task-role bindings (task↔agent/team/role)
- experience records and legacy `team/members` import
- root backup with manifest/sha256, verification and migration pointer

Default root: `$DSH_HOME/apartment`; override with `root` config or
`apartment_set_root`/`apartment_migrate`.

Tools: `apartment_status`, `apartment_agent_*`, `apartment_team_*`,
`apartment_lease*`, `apartment_task_role_*`, `apartment_experience_*`,
`apartment_import_legacy`, `apartment_backup`, `apartment_verify`,
`apartment_set_root`, `apartment_migrate`.
