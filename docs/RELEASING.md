# Release workflow (dev → master → tag → GitHub Release)

Everything is driven by `scripts/release.mjs`; do **not** paste release notes through the shell. Notes are read from a UTF-8 file, so Chinese/emoji/backticks are preserved.

## 1. Prepare notes on dev

```text
docs/releases/<tag>.md   # UTF-8, Chinese/English markdown
```

Commit the notes and any release tooling on **dev**:

```sh
git switch dev
git add docs/releases/<tag>.md scripts/release.mjs
git commit -m "release: prepare <tag>"
git push origin dev
```

## 2. Run the script

```sh
node scripts/release.mjs --tag 0.0.2 --notes docs/releases/0.0.2.md
```

What the script does:

1. Requires a clean worktree.
2. `git fetch origin --tags`; `git checkout master`; `git merge --ff-only dev`; `git push origin master`.
3. Creates an annotated tag and pushes it. If the tag already exists, pass `--force` to move it.
4. Builds the release asset with `npm pack` through Node's `npm-cli.js` (Windows-safe), renames it to `dsh-util-plugs-<tag>.tgz`.
5. Creates or updates the GitHub Release, with `body` read verbatim from the UTF-8 notes file.
6. Uploads/replaces the `.tgz` asset.

Auth: `GITHUB_TOKEN`, or the password from `git credential fill` for github.com. The token is never printed.

## 3. Verify

```sh
node scripts/release.mjs --tag 0.0.2 --notes docs/releases/0.0.2.md --skip-git
```

or check the API/GitHub UI:

- Release body has no control characters (`\n`, `\t` allowed).
- Asset `dsh-util-plugs-<tag>.tgz` exists.
- `master` == `origin/master`; tag points to master; worktree clean.

## Re-release an existing tag

```sh
node scripts/release.mjs --tag 0.0.2 --notes docs/releases/0.0.2.md --force
```

This moves the tag to current master and replaces the release body/asset. Do not hand-edit release text with `gh release edit`/shell heredocs.

## Versioning

- Git/Release tag: semver (`0.0.2`).
- `package.json` keeps the date package version (`2026.11.17-1`); the release asset is named by the Git tag.
