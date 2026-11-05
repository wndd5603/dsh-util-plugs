## 2026.11.5-4

- Host-native session communication sync: message-bus target resolution via live agents + host
  `sessionDirectory` (header alias/display name via agent list), `SESSION_GONE` for missing/inactive
  targets instead of silent queueing, same-team delivery preference over follow-up; store opens with
  WAL/`synchronous=NORMAL` + checkpoint and tracks `(sessionId,messageId)` envelope delivered/consumed
  state so consumed messages produce no duplicate envelope. `message_bus_status` exposes transport,
  directory/joined state and WAL/checkpoint facts.
- team-bus: session-network exposes the host-native `sessionDirectory` service over the existing host DB
  (resolve/listJoined/upsert/remove/status; only the caller may register/remove its own alias; wildcards
  rejected; stale aliases filtered via live agents); `network_info` reads host-registry agents + joined
  aliases with `source:'host-registry'` and no PEERS/ACL/workspace writes.
- Vendored runtime sync: `vendor/message-bus/index.js` + `src/store.js`, `vendor/team-bus/session-network/`
  `index.js`/`src/db.js`/`src/tools.js` and new `src/session-directory.js`; bundle still one install +
  eight rows with zero npm dependencies. Docs: message-bus README host-native delivery bullet;
  team-bootstrap capability references kept bundle-local.
- Candidate verification: verify-scaffold / verify-client pass, npm pack dry-run clean, source-workspace
  privacy gate 0/0. Not tagged, not pushed, not installed into a live profile.
## 2026.11.5-3

- Public README wording cleanup (root + 8 plugin READMEs); remove internal planning terms; natural zh/en install/usage copy.
- Workflow tools are now provided by profile-level global rows: `team-tools` (`team_init` / `team_members_check`) and `prompt-forge-tools` (`prompt_forge_*` ×6 + prompt-forge skill); captain/prompt-architect presets keep only persona/instructions.
- Bundle sync: vendored workflow/team-bus changes; 1 bundle + 8 rows; client still composes 3 halves.
- Verification: clean profile install/dump 8 rows; blank/default preset session header.tools 62 tools with 20/20 targets; workflow 29/29; check-rules 23/23; verify-scaffold/client PASS; privacy 0/0.
## 2026.11.5-2

- Include the Web plugin console as the eighth switchable row (vendored client+host wrapper); message center left label renamed to 跨会话消息 / Cross-session messages; compose three client halves in the root client module.

# Changelog — dsh-plugs

## 2026.11.5-1 

- **Web message center** (`message-bus`): host Remote (`messageBus` namespace) plus a
  client half — sidebar **Messages** page with search, pagination, detail/read state,
  typed-confirmation delete and an “ask the agent” copy entry. Local data only; the
  browser stores nothing.
- **One composed Web client** (`client.js`): the message-center and host-relaunch halves
  are composed into a single `dsh.client` module registered under the bundle name
  `dsh-plugs` (the previous scaffold registered only the restart half under a stale id,
  so the browser row could never materialize). `scripts/build-client.mjs` rebuilds it;
  `scripts/verify-client.mjs` checks the registration id, slots, Remotes and locales.
- **session-meeting task triage** (skill §0.5): decide whether a meeting is needed, its
  scale, stage and quorum before R1/R2/R3; synced into the vendored skill set.
- **team-bootstrap capability index**: four capability classes, human-confirmation
  boundaries and three common misreads, pointing at the new public
  [`CAPABILITY_AUDIT.md`](CAPABILITY_AUDIT.md); vendored skill paths are bundle-adapted.
- **Operator-only boundary page**: [`OPERATOR_ONLY_BOUNDARIES.md`](OPERATOR_ONLY_BOUNDARIES.md)
  and per-plugin README sections for `message_purge`, route registration, `alias_register`,
  `team_init` preview, `workspace_agents_init`, restart step 2 and prompt-forge S6.
- **Bilingual docs**: root README and all seven plugin READMEs rewritten in zh/en with the
  requested install/usage/config/permissions/privacy/uninstall structure.
- Vendor refresh from the source packages: message-bus host/client + store, team-hooks2 and
  context-meter guard rails, captain/prompt-forge tools and skills, auto-backup, host-relaunch
  (2026.11.4-2), workbench status. Vendored copies rewrite internal doc paths to the public
  `CAPABILITY_AUDIT.md` / `OPERATOR_ONLY_BOUNDARIES.md`; repository-name literals in the
  kill fence are pattern-escaped so the privacy gate stays clean.
- Version unified: bundle `2026.11.5-1`; rows keep their source-package versions
  (message-bus `2026.11.5-1`, host-relaunch `2026.11.4-2`, the rest `2026.11.4-1`).
- Still one self-contained bundle, exactly eight rows, zero npm dependencies; verified by
  local `git+file://` install into a clean profile (`dump-config`: 1 bundle + 7 rows,
  0 duplicate ids), `npm run verify`, `npm run verify:client`, privacy gate and pack dry-run.

## 2026.11.4-1 

- Initial single-repository GitHub scaffold: root package `dsh-plugs` with one
  bundle patch inserting exactly eight switchable rows (`context-sentinel`,
  `message-bus`, `team-bus`, `agent-workflows`, `workbench-bundle`,
  `auto-backup`, `host-relaunch`).
- Self-contained runtime: the seven plugin modules are vendored under
  `vendor/` and exposed through `exports`/`plugins`; the bundle has **no npm
  dependencies and no workspace resolution**, so `git+file://` and `github:`
  installs work offline. The host-relaunch Web header button client half is
  included as `client.js` via `dsh.client` (not enabled in a headless test).
- Local Git install verified in a clean DSH home/profile; `dump-config` shows
  one bundle + eight rows and zero duplicate ids; each row registers its tools.
- MIT license, README, privacy/data notes, files whitelist and repository
  metadata prepared. Nothing pushed/published; no npm package is built yet.

