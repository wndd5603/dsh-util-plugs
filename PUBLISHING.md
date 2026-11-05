# Publishing / tag checklist — dsh-util-plugs

The latest published tag is **`v2026.11.5-7`** (`wndd5603/dsh-util-plugs`). Future pushes and tags are **author actions**:
agents prepare and verify locally, then wait for explicit author confirmation. Nothing below is
executed automatically by an agent.

## Why this repository is self-contained

Two packaging routes were tested from a local Git repository (offline pnpm):

1. **workspace monorepo with `workspace:*` deps**: failed with
   `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`; a Git dependency's workspace is not the
   consuming profile's workspace.
2. **`file:` deps variant**: installed and booted locally, but pnpm packs the
   child packages as nested `node_modules` inside the Git dependency; this is
   not a standard workspace link and is less deterministic for GitHub-only
   installation.

Therefore every runtime module lives inside this package under `plugins/` +
`vendor/`, the root package has **zero npm dependencies**, and the eight rows
delegate to those local modules. `node scripts/verify-scaffold.mjs` checks the
one-bundle/eight-row/no-dependency invariants.

## Build and verification (before tagging)

```sh
node scripts/build-client.mjs   # rebuild client.js from the vendored client halves
npm run verify                  # scaffold invariants + client registration + shipped-file scan
npm run verify:client           # composed client: slots, Remotes, locales
node --check client.js && node --check plugins/*.js
```

The client bundle is a **single** `dsh.client` module for the package. All browser
halves (message center + restart button + plugin console) are composed into it and
registered under the package name (`dsh-util-plugs`), which is what the client module
system keys the bundle's client row by. Re-run `build:client` whenever a vendored
client half changes.

## Local Git verification (no registry, no network)

```sh
# from the repository root
git init
git add -A
git -c user.email=you@example.invalid -c user.name=you commit -m "dsh-util-plugs 2026.11.5-7"
git tag v2026.11.5-7

# isolated DSH home/profile
export DSH_HOME=/tmp/dsh-util-plugs-test
dsh plugin --profile plugs-test add --offline "git+file:///absolute/path/to/dsh-util-plugs#v2026.11.5-7"
dsh --profile plugs-test --dump-config
dsh --profile plugs-test --dump-config-schema
```

Expected: one bundle (`dsh-util-plugs`) and exactly eight rows
(`context-sentinel`, `message-bus`, `team-bus`, `agent-workflows`,
`workbench-bundle`, `auto-backup`, `host-relaunch`, `plugin-console`), no duplicate ids. Each row
already has all runtime code under `vendor/`; there are no npm dependencies.
Booting `--profile plugs-test web --port <spare>` must serve the composed client bundle and the boot
payload must list the client row; `npm run verify:client` covers the registration/slots without a browser.

## Push / tag gate (author confirmation required)

1. **Accumulate locally.** Documentation/small fixes stay uncommitted-to-release; do not push or tag for
   every edit. Batch them into the next version boundary.
2. **One push = one version = one tag.** Never mix multiple versions in a single push.
3. **Ask the author before pushing/tagging.** Report version, change summary, verification evidence,
   branch/tag plan and rollback. Wait for an explicit “push/tag is OK”; never push first and report later.
4. **Local empty-profile test reminder.** If this version has not yet been installed and inspected in a
   local empty profile (temporary `DSH_HOME` → install → `--dump-config` → boot/key entries), the agent must
   ask the author “this version has not been tested in a local empty profile — test before pushing?”.
   Do not skip by default and do not test only after pushing.
5. **CHANGELOG after the tag, not before.** The source-workspace root `CHANGELOG.MD` only records tagged
   versions; untagged changes are not written. Update it after push+tag with version/date/artifact/change/
   verification/install command.
6. **Public copy check.** No internal planning language (`HOLD`, `preview`, `unreleased`, task ids,
   TODO/roadmap, internal document paths, local absolute paths) in public README/intro. With no npm build,
   only advertise the GitHub source install.

## Release gate (capability consistency + privacy)

1. `CAPABILITY_AUDIT.md` four-class table, `OPERATOR_ONLY_BOUNDARIES.md`, the rows in
   `cordis.patch.yml` and the tool registrations in `vendor/` must agree. Update all
   four in the same change.
2. `npm run verify` must print `SCAFFOLD-OK`; `npm run verify:client` must print
   `CLIENT-OK`; the shipped-file scan must find no internal paths (`docs/…`,
   `packages/…`, absolute user paths) in user-facing files.
3. The source-workspace privacy gate (`check-privacy.mjs`, strict) must report
   0 errors / 0 warnings for this directory.
4. `npm pack --dry-run --json` must list exactly the whitelisted runtime/docs files
   (no tests, no internal docs, no `.git`, no tarballs).
5. Install in a **clean** DSH home/profile via `git+file://` (offline) and confirm
   1 bundle + 8 rows / 0 duplicate ids before touching any live profile.

## GitHub release path (author action)

1. Push `main` and the version tag (for example `v2026.11.5-7`) after author confirmation.
2. Create a GitHub Release named after the tag; attach a source tarball/zip and
   a `sha256` checksum.
3. Install command (no npm publish):
   `dsh plugin --profile <profile> add github:wndd5603/dsh-util-plugs#<tag>`.
4. No npm package is built yet; do not run `npm publish`/`pnpm publish` for this
   scaffold until a separate publish decision and identity review.
5. Before pushing, run the release gate above and inspect the staged file list
   (`git status --short`) to confirm no tests/internal docs/absolute paths are present.

## What must stay out of this repository

- `node_modules/`, pnpm store, tarballs, local logs.
- API keys, `.credentials*`, session UUIDs, user-home paths.
- Internal design docs that are not part of the public README/privacy/capability story.
  This repository intentionally contains only runtime code and public docs; the
  machine-readable capability audit and incident evidence stay in the source workspace.
