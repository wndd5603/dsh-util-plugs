# dsh-agent-memory

Persistent project/agent memory for DSH:
- SQLite WAL at `$DSH_HOME/memory/memory.sqlite`
- `memory_remember` (upsert by scope+key), `memory_search`, `memory_list`, `memory_forget`, `memory_status`
- scope: `project` / `agent` / `global`; tags and source session recorded
- no automatic context injection; use the `persistent-memory` skill / `memory_search` before complex tasks
