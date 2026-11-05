## 2026.11.5-9

- Host-relaunch config is now exposed in the plugin console: `allowRealRestart` is marked volatile and the restart schema emits Schemastery-compatible `{uid,refs}` JSON for the settings form.
- Message-bus autoResume/strict-mode behavior unchanged from v8.

## 2026.11.5-8

- **Inactive-session recovery (`autoResume`, default true)**: a non-live session-id/alias target is resumed
  before delivery through the host agents API with a properly composed preset setup (`sessionQuery` →
  `agentPresets.resolve`/`mount`), falling back to `resumeModel` when no current model selection exists;
  archived sessions and missing presets refuse resume instead of creating a half-composed session;
  concurrent sends share one in-flight resume, stale resumed handles are revalidated against live state and
  dropped when the agent is disposed.
- **Queue semantics and hardening**: failed/refused/rate-limited resumes stay accepted into the persisted
  queue (`accepted:true, stored:true, queued:true, wakeError`) instead of `SESSION_GONE`; queued envelopes are
  flushed exactly once when the target becomes live (in-flight dedupe by delivery id, restart/initial flush
  covered). Auto-resume is per-caller rate-limited (`autoResumeRateLimitPerMinute`, default 12/min); extra
  sends stay queued with `wakeError:'autoResume-rate-limited'`. `message_bus_status` exposes
  `autoResume`/`resumedCount`/`strictMode` and the limit.
- **Permission binding / strict mode**: strict mode stays default-on and is bound to the session sandbox
  mode — direct session-id delivery needs an `allowed-once` approval in confined modes (`workspace-write`/
  `read-only`); with no approval answerer it returns `STRICT_SESSION_ID_DENIED` without storing/delivering;
  `danger-full-access` bypasses the approval gate (no answerer) per product semantics. Alias/join delivery
  never asks for approval, and the Web message center remains exempt.
- **Web message center**: the page header now shows the effective strict-mode state; the single composed Web
  client was rebuilt for the final bundle (three halves, registered id `dsh-util-plugs`).
- **Vendored sync**: message-bus host module, store, client half, README and CHANGELOG aligned with the
  workspace; only public-document path adaptations remain (recorded in the release audit notes). Bundle stays
  one install + eight switchable rows, zero npm dependencies.
- **Final candidate verification**: verify-scaffold / verify-client pass, `node --check` 56/56, npm pack
  dry-run clean (shasum recorded in the source-workspace packaging report), privacy 0/0; the four release
  warnings were closed by an independent re-check. Not tagged, not pushed, not installed into a live profile.
## 2026.11.5-7

- Strict mode is now tied to the session sandbox mode: it enforces direct session-id approval only in confined modes (`workspace-write` / `read-only`); `danger-full-access` has no approval answerer, so strict mode is automatically bypassed there instead of failing closed.
- `strictMode` config description documents this; new unit test covers danger-full-access bypass; message-bus 30/30.
## 2026.11.5-6

- **Plugin console settings exposure**: message-bus `strictMode` is marked as a live (volatile) config field; the zero-dependency schema now emits Schemastery-compatible `{uid,refs}` JSON so the host can render the volatile form.
- **Console namespace mapping**: bundle rows whose entry id contains a package subpath now also match a settings namespace by its leaf id, so message-bus appears in the plugin-console Config tab.
- **Bundle patch**: message-bus row declares an explicit `strictMode: true` config entry for the settings form.
- Verified: plugin console shows `message-bus` under Config with `严格模式/Strict mode`; message-bus 29/29 and console tests PASS; bundle 8 rows / 3 client halves.
## 2026.11.5-5

- Package rename: bundle package name `dsh-plugs` → **`dsh-util-plugs`** (matches the repository name);
  bundle rows now resolve as `dsh-util-plugs/plugins/*`, and the package-root row (`workbench-bundle`)
  mounts `dsh-util-plugs`, so the single Web client module registers under the new package name.
- Strict session delivery sync (message-bus): new `strictMode` config (default `true`) denies direct
  `session-<uuid>` delivery unless the user approves once via the host approval request; only
  `allowed-once` proceeds, otherwise `STRICT_SESSION_ID_DENIED` with a join-first hint. Alias/join
  delivery is unaffected; `strictMode:false` keeps the legacy behavior. `send` is async and
  `message_bus_status` exposes `strictMode`. Bilingual README sections added.
- Rebuilt composed Web client for the new id (`dsh-util-plugs`, three client halves); vendored
  message-bus host module synced; docs/assertions updated. Bundle still one install + eight rows,
  zero npm dependencies.
- Candidate verification: verify-scaffold / verify-client pass, npm pack dry-run clean, privacy 0/0.
  Not tagged, not pushed, not installed into a live profile.
﻿## 2026.11.5-4

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

# Changelog — dsh-util-plugs

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

