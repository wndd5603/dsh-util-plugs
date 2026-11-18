# P0 message-bus hardening — validation (2026-11-18, dev)

## Scope

- `message_read` / legacy `pipe2_read_message`: only recipient or sender; missing/third-party caller is FORBIDDEN and writes no read receipt.
- Wake envelope source: `source.kind:"peer-message"` + `fromSession`/`fromDisplay`; never `kind:"user"`.
- Absence detection: `counts.unread`, `pendingSummary.unread`, pending reminder fires for unread-only sessions.
- Version `2026.11.17-2`.

## Unit tests (temporary SQLite, mock tool context)

```text
node --test scripts/test-message-bus-p0.mjs
tests 5 / pass 5 / fail 0
```

Covered: target/sender/third/missing session; `createPeerMessage`; distinct unread counts with dedupe/suppressed/foreign read receipts; apply-level FORBIDDEN without read receipt; unread-only reminder.

## Scaffold

```text
npm run verify
SCAFFOLD-OK: one bundle, 11 rows, zero npm dependencies, one composed client module
```

## Blank-profile install (tarball, separate DSH_HOME)

```text
npm pack -> dsh-util-plugs-2026.11.17-2.tgz (485,715 B)
DSH_HOME=E:\work\tests\dsh-p0-blank-20261118
dsh plugin --profile p0-blank add --offline <tarball>  # PASS
```

- `--profile p0-blank --dump-config`: 11 rows, all expected ids.
- Web-template profile `p0-webcopy` + tarball: boot at `127.0.0.1:13400`; `__DSH_BOOT__.entries=73`; sidebar shows 插件控制台/协作网络; plugin console shows `dsh-util-plugs v2026.11.17-2 ... 11 rows · 0 failed`; console errors 0.
- UI screenshot outside the repo: `E:\work\tests\dsh-p0-blank-20261118\blank-plugin-console.png`.

## Limits

- No live two-session E2E for FORBIDDEN; the apply-level mock and store tests are the evidence.
- Web Remote message reads are not covered by this patch (no caller identity in that path); treat as remaining WARN.
- Merged wake envelopes use the first item's `fromSession` for the source; envelope text still lists each sender. This is an attribution approximation, not a per-item source.
- No commit/tag/release in this validation; author decides release.
