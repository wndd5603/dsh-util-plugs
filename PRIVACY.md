# Privacy and local data

`dsh-util-plugs` is local-first. It makes no network calls, collects no telemetry
and stores no credentials.

## What is stored where

| Component | Data | Location |
|---|---|---|
| context-sentinel | team-hooks state (archive cycle baselines, write-policy dedupe keys) | `$DSH_HOME/team-hooks-state.json` |
| message-bus | cross-session messages, routes, read receipts | `$DSH_HOME` SQLite database (component config) |
| message-bus Web message center | no browser storage: list/search/detail/delete go through the local `messageBus` Remote; search state is in memory | nothing persisted by the client |
| team-bus | session network/identity/meeting registry | `$DSH_HOME` data directory (component config) |
| workbench-bundle | read-only status; one-time pointer marker in session log | no new files |
| auto-backup | pre-write file snapshots + retention metadata | workspace `file_backups/` |
| host-relaunch | pending token hash, handoff record, JSONL audit, supervisor log | `$DSH_HOME/restart/` |
| host-relaunch Web header button | no browser storage: status/prepare/confirm go through the local `relaunch` Remote | nothing persisted by the client |

- Tokens are stored only as SHA-256 hashes; no plaintext token is written to
  disk or audit logs.
- Host command lines/audit diagnostics are redacted by default
  (`diagnostics: redacted`); `full` is an explicit opt-in.
- `CAPABILITY_AUDIT.md` / `OPERATOR_ONLY_BOUNDARIES.md` contain no user data.
- Auto-backup copies are local project files and may contain user content; they
  are intended to be committed/ignored according to the project's own policy.

## Cleanup

Remove the bundle from the profile and its dependency entry. Data directories
listed above are intentionally not deleted automatically (they may contain
useful messages/backups); delete them manually only after confirming their
contents are no longer needed.

## Release hygiene

The package `files` whitelist ships runtime code and public documentation only.
No tests, internal design docs, absolute paths, user names, API keys or session
UUIDs are included. `npm run verify` scans the shipped files for internal paths,
and the source-workspace privacy gate must report 0 errors / 0 warnings before
publishing.
