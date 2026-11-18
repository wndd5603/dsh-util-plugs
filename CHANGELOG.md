## 2026.11.17-38 (dev)

- **Embedded subenv uses host `ctx.llm`**: removed the separate `SUBENV_PROVIDER_JSON`/API-key requirement for embedded mode; provider/model are selected from DSH (`subenv.provider/model`, empty = first available). The task runner consumes the host LLM stream. External RPC mode remains opt-in.

## 2026.11.17-37 (dev)

- **Memory operator reveal**: `memoryPage` masks content again; `memoryReveal({id,confirm:"REVEAL"})` is gated by `webUi.allowMemoryReveal` (default false), returns one memory body, and appends a body-free `reveal-audit.jsonl` row. 协作网络 shows a per-row “显示内容” action. Tests cover config/confirm/audit.

## 2026.11.17-36 (dev)

- **Single collaboration tab**: removed the duplicate `collaboration` sidebar/main/settings entry; the existing 协作网络 page remains the single operational console.
- **Subenv section**: 协作网络 now includes an embedded Subenv card with status/provider and task results/conversation content.
- **Legacy detail restored**: Web `tasksPage/taskDetail/memoryPage/meetingDetail` return full content again for the operational console; the new visibility API remains the redacted read-only layer.

## 2026.11.17-35 (dev)

- **Subenv visibility**: visibilitySummary now surfaces embedded subenv state/mode/provider (degraded = partial) and the collaboration overview shows the mode/provider note; the Subenv row renders its meta instead of only "degraded".

## 2026.11.17-34 (dev)

- **Embedded subenv**: same-process provider adapter + task runner; no port/token; Subenv tab reads embedded status; `subenv_task_submit/get/list/cancel` tools. `subenv.mode` defaults `embedded`; external RPC remains opt-in.

## 2026.11.17-33 (dev)

- **Collaboration UI filters**: Inbox/Tasks/Meetings/Memory now expose a keyword input, status select (tasks/meetings), Apply/Clear, and Enter-to-apply; all filters go through `visibilityPage`.

## 2026.11.17-32 (dev)

- **Subenv UI bridge**: host `subenvStatus` probes the local sidecar (health/capabilities/provider/tasks) with a bearer token from `SUBENV_TOKEN`; the Collaboration Center Subenv tab shows online/offline/provider/task status, never the token. 3 regression tests.
- **Legacy Web redaction**: Web Remote `tasksPage`/`taskDetail` strip description/metadata; `memoryPage` strips content; `meetingDetail` recursively removes body/content. Tool APIs keep full data.

## 2026.11.17-31 (dev)

- **Visibility filters**: `visibilityPage` now forwards task status/assignee/query, meeting status/query, memory scope/query, and message keyword filters; the response echoes `filters`.

## 2026.11.17-30 (dev)

- **Read-only capability declaration**: `visibilitySummary` now returns `capabilities:{reads:true,writes:false,reveal:false}`; the collaboration center is explicitly read-only (no unauthenticated destructive controls). README scope wording updated.

## 2026.11.17-29 (dev)

- **Task evidence JSON fix**: `visibilityDetailOf` now parses SQLite text metadata before reading `completion.evidence`; corrupt metadata degrades to no evidence instead of throwing. Tests cover object, JSON-string, and corrupt forms.

## 2026.11.17-28 (dev)

- **Host-enforced scope**: removed client-supplied `profileId`/`workspaceId`; summary returns `scope:{mode:"host",enforced:true}`. One host serves one DSH profile, so there is no fake multi-profile selector.

## 2026.11.17-27 (dev)

- **Detail projection tests**: `visibilityDetailOf` is a pure projection; tests cover body-free messages, nested task evidence, redaction, and NOT_FOUND. Host `visibilityDetail` delegates to it.

## 2026.11.17-26 (dev)

- **Visibility contract hardening**: `visibilitySummary` now exposes an aggregate `state` (`partial` when any card is unavailable); `visibilityPage` returns stable `version`, `nextCursor`, and `error:null` via `visibilityPageMeta`; tests cover pagination fields.

## 2026.11.17-25 (dev)

- **Explicit single-profile scope**: `visibilitySummary` now returns `scopeMode:"single-profile"` and `warnings:["db-scope-not-enforced"]`; the UI states this limitation instead of implying multi-profile isolation. MF-3 remains a WARN until a host scope API exists.

## 2026.11.17-24 (dev)

- **Visibility review fixes**: task page rows now strip `description`/`metadata` via `safeTaskView`; task evidence is read from `detail.task.metadata.completion.evidence`; Overview now consumes `visibilitySummary` and shows its as-of.

## 2026.11.17-23 (dev)

- **Runtime/evidence view**: the Runtime tab reads apartment status (counts only, no paths); task/message detail now renders a separate evidence block and redaction markers. Subenv remains an explicit `SUBENV_NOT_CONFIGURED` state until its bridge lands.

## 2026.11.17-22 (dev)

- **Collaboration Inbox/Tasks views**: tabs now call `visibilityPage`; Inbox and Tasks render read-only lists and load `visibilityDetail` on selection, with redaction markers. No body/content is rendered by default.

## 2026.11.17-21 (dev)

- **Visibility page/detail API**: `visibilityPage` returns safe message/task/meeting/memory rows (no body/content) with `ready|empty|unavailable`; `visibilityDetail` returns a body-free message or task detail plus evidence/redacted fields. Unknown domains return `DOMAIN_UNAVAILABLE`.

## 2026.11.17-20 (dev)

- **Visibility summary API**: `visibilitySummary({profileId,workspaceId})` returns six read-only cards (`ready|empty|unavailable`), per-domain state, counts, as-of, and no body/content; missing scope returns `SCOPE_REQUIRED`. Runtime/subenv remain explicitly unavailable until later waves.

## 2026.11.17-19 (dev)

- **Collaboration Center shell**: a second sidebar entry (`collaboration`, order 3) with a six-card overview and tabs for inbox/tasks/meetings/memory/runtime/subenv; the page reads existing message/task/memory/meeting remotes, defaults to no body, and marks unavailable domains instead of showing fake zeros. A settings section is registered at order 25.

## 2026.11.17-18 (dev)

- **Meeting action lifecycle**: `meeting_action_update` lets a participant/convener set one sidecar action's status/owner/due; completed/closed/cancelled actions stop appearing in `meeting_digest`, while the sidecar remains auditable.

## 2026.11.17-17 (dev)

- **Read audit**: every successful `message_read` appends a body-free row to `read-audit.jsonl` (actor, target, from/to, offset/limit, result). This extends send/purge auditing to reads without exposing body text.

## 2026.11.17-16 (dev)

- **Memory supersede**: `memory_supersede` inserts a replacement row under a derived audit key and sets the old row's `superseded_by`; `memory_search`/`memory_list` hide superseded rows by default and expose them with `includeSuperseded:true`. The old row is retained, never silently overwritten.

## 2026.11.17-15 (dev)

- **Web forget audit + purge test**: the Web Remote `memoryForget` path now appends a body-free `forget-audit.jsonl` row; the enabled `message_purge` path is covered by a regression test asserting `purge-audit.jsonl`.

## 2026.11.17-14 (dev)

- **Memory-forget operator identity**: `memory_forget` now requires `sandboxPolicy.resolve(session).mode === 'danger-full-access'` in addition to `allowForget:true`; a normal workspace-write session is FORBIDDEN even when the config flag is on.
- **Purge tombstone**: `message_purge` appends a body-free `purge-audit.jsonl` tombstone (actor/all/before/deletedMessages) before returning; the default path is still disabled (`allowPurge:false`).

## 2026.11.17-13 (dev)

- **Queue default scoping**: `message_queue()` without `to` now defaults to the caller session instead of listing the whole global queue; explicit cross-recipient `to` remains FORBIDDEN.
- **Web memory-forget gate**: the Web Remote `memoryForget` method is disabled unless `webUi.allowMemoryForget:true` and now requires `confirm:"FORGET"`; the message-bus tool path is separately gated by `allowForget`.

## 2026.11.17-12 (dev)

- **Ack/queue recipient checks**: `message_ack` now marks only messages the caller may read; a third-party or missing caller receives `denied` entries and no read receipt. `message_queue({to})` rejects a target that is not the caller. This closes the remaining P0-2 bypass found by the fourth verification while `message_purge` remains disabled unless `allowPurge:true`.

## 2026.11.17-11 (dev)

- **Lease fencing and ownership**: apartment leases add a monotonic `fencing_token` per task, reject a second active lease for the same task with `LEASE_CONFLICT`, require the lease owner on release, and return `released:false` for an already released lease. Existing databases get the additive column migration.

## 2026.11.17-10 (dev)

- **Send audit**: every accepted `message_send` appends one body-free row to `send-audit.jsonl` (actor, target, messageId, subject, bytes, sha256, priority/test/projectScope, targetState). This closes the 0-send-audit gap without changing delivery semantics.

## 2026.11.17-9 (dev)

- **Caller-scoped job reaper**: `job_reap` lists only the calling session's live jobs older than `staleMs` (default 15 min); it is dry-run by default, and `dryRun:false` + `confirm:"REAP"` requests cancellation for exactly those jobs. This is a real reaper, not only a digest warning.

## 2026.11.17-8 (dev)

- **Memory forget operator gate**: `memory_forget` is disabled unless `allowForget:true`; when enabled it requires `confirm:"FORGET"` and appends an id/scope/key/source-session audit row to `memory/forget-audit.jsonl` before returning.

## 2026.11.17-7 (dev)

- **Web body exposure default-off**: `webUi.exposeBody` defaults to false. Because the Web Remote has no caller identity, `messageBus.get` returns `bodyRedacted:true` and list/snippet text is empty unless an operator explicitly opts in. This prevents the browser UI path from becoming an unauthenticated body disclosure channel.

## 2026.11.17-6 (dev)

- **Default stale digest**: `bulletin_digest` now applies `staleAfterHours=24` when the caller supplies neither an SLA nor `updatedBefore`; stale active tasks are visible without requiring a remembered SLA. Explicit filters still win.

## 2026.11.17-5 (dev)

- **Archive ownership**: the manual-compaction reminder resolves the caller's own `team/members/<role>/ARCHIVE_*.md`; a remembered foreign archive path is ignored, and the fallback is the latest archive in the caller's role directory. This prevents cross-role recovery from injecting another agent's conclusions.

## 2026.11.17-4 (dev)

- **Artifact manifest + current pointer**: new `artifact_manifest` tool hashes a real build artifact, writes an immutable content-addressed manifest under `$DSH_HOME/artifacts/manifests/`, and optionally promotes it to the single `artifacts/current.json` pointer; prior pointers are archived under `history/`. Promotion is explicit, so a rebuild cannot silently overwrite the final pointer without a manifest.

## 2026.11.17-3 (dev)

- **Task completion evidence**: `bulletin_task_complete` now requires `{artifactId, sha256, checkResult}`; invalid/missing evidence is rejected, the completion is stored in task metadata, and state+event are written in one transaction. The generic `bulletin_task_update` path can no longer set `status=completed`.
- **Workbench self-report**: `workbench_status` now reports the installed `dsh-util-plugs` bundle itself, not only its component package names.

## 2026.11.17-2 (dev)

- **Message-bus P0 hardening**: `message_read` (and its legacy alias) now allows only the recipient or sender; a missing or third-party caller session returns `FORBIDDEN` without writing a read receipt. Legacy `pipe2_queue` is caller-scoped and rejects cross-recipient `to`; it no longer exposes another recipient's body. Wake envelopes carry `source.kind:'peer-message'` with `fromSession`/`fromDisplay` instead of pretending to be a human `kind:'user'` turn; mixed-sender/remote batches are unattributed. Absence detection adds `unreadSummary`/`counts.unread`, and the pending reminder also fires for unread messages. Root and vendor message-bus versions bumped to 2026.11.17-2.

## 2026.11.17-1 (dev)

- **Agent Hub reliability**: panel/slot stays registered without an active conversation; the apartment remote is resolved lazily with scope.get, so an unmounted apartment no longer removes the whole entry.
- **Delivery policy**: targetState/deliveryState/reasonCode/route, maxBodyChars 100000, notFoundPolicy default reject, queue/audit paging and undelivered filters.
- **Task/meeting/apartment safety**: bulletin owner/CAS/pagination and full overview counts; meeting participant/convener checks, legacy claim, finalize CAS and cross-process sidecar lock; migrate/restore restart gate and root validation.
- **Web UI**: meeting detail load-more, read-only Web receipts, README demo GIFs.
- **Clean-profile E2E**: dsh e2e-ui2 profile-selection and install freshness verified.

## 2026.11.16-4 (dev)

- **Removed `local-worker` row/tools**: local models now use DSH's own provider selection (`llm-pi-ai` Local Ollama) with `subagent` or a new session; no separate worker plugin. Bundle is 11 rows.

## 2026.11.16-3 (dev)

- **Panel naming**: the former Agent Network entry is now **协作网络 / Agent Hub** with page title **智能体协作网络 / Agent Collaboration Network**, covering boards/tasks, apartment storage and messages; technical row ids remain stable.
- **Agent Memory (new row `agent-memory`)**: persistent SQLite memory (`$DSH_HOME/memory/memory.sqlite`) with `memory_remember/search/list/forget/status`, scope/key upsert, tags and source session.
- **Bulletin board interaction**: board selection, per-board status filters, task list with assignee/priority/dependency/blocked state and expandable task detail; message-list snapshots now carry full task fields.

## 2026.11.16-2 (dev)

- **Agent Apartment (new row `agent-apartment`)**: centralized agent homes/AGENTS.md/skills/tools, workspace leases, many-to-many teams/memberships, task-role bindings, experience records, legacy `team/members` import, root pointer + backup/migration/restore tools (`apartment_set_root`, `apartment_migrate`, `apartment_backup`, `apartment_restore`, `apartment_lease_reap`, `apartment_verify`); destructive root operations require danger-full-access; Agent Network panel has storage/migrate/backup/restore/verify buttons.
- **Agent Network UI polish**: network-node sidebar icon, hero header, bulletin-board card grid/status pills, apartment action bar with busy/disabled state and success/danger feedback; fixed apartment Remote parameter descriptors (`backup(label)` etc.) and embedded read-only network snapshots for race-free rendering.
- **Bulletin board / task board (new row `bulletin-board`)**: shared SQLite boards and tasks with statuses, workspace/assignee association, dependencies, atomic claim and digest queries.
- **Cross-permission guard**: `crossPermissionGuard` (default true) blocks confined senders from messaging danger-full-access targets via direct id, alias, header or autoResume.
- **Agent Network panel**: the former “跨会话消息 / Cross-session messages” panel is now “智能体网络 / Agent Network”; it adds a live bulletin-board/task section (boards, task counts by status) above the existing message-center tools. **The plugin console remains a separate panel** with its original cards/configuration/status/extensions. The bulletin-board host exposes a read-only `bulletinBoard` Remote.
- **Subagent progress**: `agent_progress` reads `team/progress/<sessionId>.json` heartbeats plus the live agent roster and classifies starting/running/stalled/inactive/failed; documented in the `subagent-progress` skill.
- **Context guard self-heal**: context-meter and team-hooks2 re-scan `agents.list()` every 5s (idempotent), so turn-stopping listeners and archive reminders attach even when the first agents exist before plugin mount/restart.
- Bundle is now 11 rows; existing rows remain switchable and zero npm dependencies.

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

