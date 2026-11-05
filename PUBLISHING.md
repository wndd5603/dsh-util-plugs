# Publishing / tag checklist — dsh-plugs

This scaffold is intentionally **not** pushed and **not** published from the
agent workspace. The author creates `wndd5603/dsh-util-plugs` and pushes.

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
`vendor/`, the root package has **zero npm dependencies**, and the seven rows
delegate to those local modules. `node scripts/verify-scaffold.mjs` checks the
one-bundle/seven-row/no-dependency invariants.

## Build and verification (before tagging)

```sh
node scripts/build-client.mjs   # rebuild client.js from both vendored client halves
npm run verify                  # scaffold invariants + client registration + shipped-file scan
npm run verify:client           # composed client: slots, Remotes, locales
node --check client.js && node --check plugins/*.js
```

The client bundle is a **single** `dsh.client` module for the package. Both browser
halves (message center + restart button) are composed into it and registered under
the package name (`dsh-plugs`), which is what the client module system keys the
bundle's client row by. Re-run `build:client` whenever a vendored client half changes.

## Local Git verification (no registry, no network)

```sh
# from the repository root
git init
git add -A
git -c user.email=you@example.invalid -c user.name=you commit -m "dsh-plugs 2026.11.5-1"
git tag v2026.11.5-1

# isolated DSH home/profile
export DSH_HOME=/tmp/dsh-plugs-test
dsh plugin --profile plugs-test add --offline "git+file:///absolute/path/to/dsh-plugs#v2026.11.5-1"
dsh --profile plugs-test --dump-config
dsh --profile plugs-test --dump-config-schema
```

Expected: one bundle (`dsh-plugs`) and exactly seven rows
(`context-sentinel`, `message-bus`, `team-bus`, `agent-workflows`,
`workbench-bundle`, `auto-backup`, `host-relaunch`), no duplicate ids. Each row
already has all runtime code under `vendor/`; there are no npm dependencies.
Booting `--profile plugs-test web --port <spare>` must serve
`/plugins/dsh-plugs/client.js` and the boot payload must list the client row;
`npm run verify:client` covers the registration/slots without a browser.

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
   1 bundle + 7 rows / 0 duplicate ids before touching any live profile.

## GitHub release path (later, author action)

1. Create `wndd5603/dsh-util-plugs`, push `main` and tag `v2026.11.5-1`.
2. Create a GitHub Release named `v2026.11.5-1`; attach a source tarball/zip and
   a `sha256` checksum.
3. Suggested install command (no npm publish):
   `dsh plugin --profile <profile> add github:wndd5603/dsh-util-plugs#v2026.11.5-1`.
4. npm remains **HOLD**; do not run `npm publish`/`pnpm publish` for this
   scaffold until a separate publish decision and identity review.
5. Before pushing, run the release gate above and inspect the staged file list
   (`git status --short`) to confirm no tests/internal docs/absolute paths are present.

## What must stay out of this repository

- `node_modules/`, pnpm store, tarballs, local logs.
- API keys, `.credentials*`, session UUIDs, user-home paths.
- Internal design docs that are not part of the public README/privacy/capability story.
  This repository intentionally contains only runtime code and public docs; the
  machine-readable capability audit and incident evidence stay in the source workspace.
