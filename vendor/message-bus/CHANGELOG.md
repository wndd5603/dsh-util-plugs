# Changelog — dsh-message-bus

## Unreleased v2026.11.5-8 (2026-11-05) — WARN fixes / audit hardening

- Web message center shows `strictMode` in the page header (`data-message-strict-mode` +
  localized on/off label); `capabilities` exposes `strictMode`/`autoResume`; config drill-down
  still renders the full Config (strictMode/autoResume/resumeModel).
- Unavailable approval: workspace-write + approval policy never yields
  `STRICT_SESSION_ID_DENIED` without storing/delivering the message (tested).
- Auto-resume hardening: per-caller `autoResumeRateLimitPerMinute` (default 12), stale
  `resumedHandles` validation, `agent/disposed` cleanup, flush in-flight guard, and initialFlush
  exactly-once delivery. Failure/autoResume-off all return
  `ok:true, accepted:true, stored:true, delivered:false, queued:true, wakeError`.
- Vendor v8 re-sync: only public-path adaptations vs workspace (see release audit notes).

## Unreleased (2026-11-05) — auto-resume inactive targets

- New config `autoResume` (default `true`) and `resumeModel`: inactive session-id/alias targets are
  resumed through `agents.resume` with a preset `setup` (`sessionQuery.observeSession` →
  `agentPresets.resolve`/`mount`), model from `agentDefaultModel.currentSelection()` or
  `resumeModel`; archived sessions and missing presets refuse resume; concurrent sends share one
  in-flight resume.
- Resume failure is accepted into the persisted queue instead of `SESSION_GONE`
  (`ok:true, accepted:true, stored:true, delivered:false, queued:true, wakeError`); same queue
  semantics when `autoResume:false` (`wakeError:'autoResume-disabled'`). When the session later
  becomes live, `agent/created`/`agent/status` flush queued envelopes and mark deliveries delivered
  (old pipe2 bridge watcher equivalent).
- `resumedHandles` entries are validated against live/status before reuse; stale handles are
  discarded and resumed again.
- PEERS.json/file pipe2 routes/`team_audit`/`pipe2_*` are documented as intentionally retired in
  the host-native line; no legacy audit implementation is added.
- `message_bus_status` exposes `autoResume`/`resumedCount`; strictMode approval, alias/join and
  no-PEERS/ACL/workspace guarantees remain unchanged.

## Unreleased (2026-11-05) — strict mode

- New config `strictMode` (default `true`): direct `session-<uuid>` delivery is denied unless the
  user approves it once via `ctx.get('approval').request(...)`; only `allowed-once` proceeds,
  otherwise `STRICT_SESSION_ID_DENIED` with a "join alias first or retry approval" hint.
  Alias/join delivery is unaffected and never asks for approval; `strictMode:false` preserves the
  legacy direct-id behavior. The Web message center is a human surface and is exempt.
- `send` is async; `message_bus_status` exposes `strictMode`; bilingual README config docs.

## Unreleased (2026-11-05) — host-native transport

- `resolveTarget` is host-native: session-id → live `agents.get`; alias → host
  `sessionDirectory`; header alias/displayName → `agents.list`; legacy route fallback. Missing or
  inactive targets now fail with `SESSION_GONE` (no silent queue); same-Team targets prefer
  `agentTeams.sendMessage`, otherwise `Agent.followup`.
- `message_bus_status` exposes `transport`, `directory`/`joinedCount`, host DB WAL/checkpoint facts
  and `(sessionId,messageId)` envelope delivered/consumed state. `message_read`/`message_ack`
  mark consumed envelopes; no duplicate envelope after consumption.
- Store opens with WAL + `synchronous=NORMAL` + busy timeout; new `envelope_state` table and
  `checkpoint()`; no PEERS/ACL/workspace writes.

## 2026.11.5-1 (2026-11-05)

- **Web message center** (existing plugin, client half added): `dsh.client` + `lib/client.js`
  registers the sidebar「消息」entry and a `main` message-center page (list/search/pagination/detail,
  copy / copy-as-quote, custom `DELETE` confirmation, optional send).
- Host Remote `messageBusRemote` (namespace `messageBus`): `list/search/get/delete/send`. Reuses the
  existing SQLite store and the existing `send()` dedupe/coalesce/priority path; `get` reuses per-session
  readAt; `delete` removes one message plus deliveries/read rows only (never bulk purge) and appends a
  no-body audit row; `send` is gated by `webUi.allowSend`. New config `webUi`
  (`enabled/allowSend/pageSize/audit`).
- Store: `listMessages` gains keyword/offset, new `countMessages`, `getReadAt`, `deleteMessage`; existing
  purge/read semantics unchanged. Tests: 21/21 (`test-web-remote.mjs`, extended store test, client tests).

## 2026.11.4-1 (2026-11-04)

- Public package name for release: **dsh-message-bus**.

- Unreleased date-semver version: **2026.11.4-1** (date major.minor.patch + daily sequence; resets next day).
  Publishing copies rename it to x.y.z. No functional change in this version bump.
- Version policy: `PUBLISHING.md`.

## 0.3.1 (2026-11-04)

- Publish hygiene: replace internal legacy asset name in shipped README/config/tool description with
  generic "legacy pipe2 bridge" wording; no behavior change.

## 0.3.0 (2026-11-04)

- 0.2.0: declarative Config, `message_bus_status`, `enabled` switch, config-aware unknown-recipient error, README rewrite.
- 0.3.0: operator `message_purge` (confirm token) + `retentionDays` auto-prune + data-lifecycle docs + native settings-form graph.

## Earlier

- See git history / the workspace UX audit reports (`docs/ux-audit/V1_REPORT.md`, `V2_FIXES.md`).
