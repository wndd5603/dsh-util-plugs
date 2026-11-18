# dsh-agent-workflows — prompt-forge workflow

Prompt-forge workflow preset for DeepSeek Harness: a staged S0–S7 prompt-iteration workflow with `prompt_forge_*` tools, verification packets and recorded verdicts.

> DSH-native agent teams/session identity are authoritative. The former Team Coordinator/captain tools (`team_init`, `team_members_check`, pipe2 templates) are retired from this bundle.

## What it brings

- `prompt_forge_status` / `prompt_forge_next`
- `prompt_forge_advance` / `prompt_forge_reset_subagent`
- `prompt_forge_verify_dispatch` / `prompt_forge_verify_record`
- Runtime skill `prompt-forge`

## Usage

```text
prompt_forge_status()          # current stage / next step
prompt_forge_next()            # exact phase instructions
prompt_forge_advance(...)      # record artifacts and advance
```

S6 must be verified by a fresh-context `subagent` (never `subagent_fork`) and recorded via
`prompt_forge_verify_record`; a fallback reason is an explicit degradation.

## Boundaries

- DSH-native teams are authoritative; this row does not create plugin team rosters/tasks.
- Local-first: no network calls and no credentials.
- DeepSeek Harness `>=0.2.0 <0.3.0`; Node.js `>=24`.
- Writes stay in the workspace or `$DSH_HOME`.

## License

MIT © 2026 wndd5603
