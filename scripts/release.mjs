#!/usr/bin/env node
/**
 * Release workflow: dev -> master -> annotated tag -> GitHub Release + npm pack asset.
 *
 * Usage:
 *   node scripts/release.mjs --tag 0.0.2 --notes docs/releases/0.0.2.md --force
 *   node scripts/release.mjs --tag 0.0.3 --notes docs/releases/0.0.3.md
 *
 * The notes file is read as UTF-8 and sent as-is; no shell text is interpolated.
 * Auth: GITHUB_TOKEN, or the password from `git credential fill` for github.com.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = name => args.includes(name)
const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const tag = opt('--tag')
const notesPath = opt('--notes')
const force = flag('--force')
const skipGit = flag('--skip-git')
if (!tag || !notesPath) {
  console.error('usage: node scripts/release.mjs --tag <tag> --notes <utf8.md> [--force] [--skip-git]')
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+$/.test(tag)) {
  console.error('tag must be semver x.y.z, got ' + tag)
  process.exit(2)
}
const notes = readFileSync(resolve(repoRoot, notesPath), 'utf8')
if (!notes.trim()) {
  console.error('release notes are empty: ' + notesPath)
  process.exit(2)
}

const git = (gitArgs, opts = {}) => execFileSync('git', gitArgs, { cwd: repoRoot, encoding: 'utf8', stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'], ...opts })
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: repoRoot, encoding: 'utf8', stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'], ...opts })

if (!skipGit) {
  const dirty = git(['status', '--porcelain']).trim()
  if (dirty) throw new Error('worktree is not clean:\n' + dirty)
  git(['fetch', 'origin', '--tags'], { stdio: 'inherit' })
  git(['checkout', 'master'], { stdio: 'inherit' })
  git(['merge', '--ff-only', 'dev'], { stdio: 'inherit' })
  git(['push', 'origin', 'master'], { stdio: 'inherit' })

  const existing = git(['tag', '--list', tag]).trim()
  if (existing && !force) throw new Error(`tag ${tag} already exists (use --force to move it)`)
  git(['tag', '-f', '-a', tag, '-m', `dsh-util-plugs ${tag}`], { stdio: 'inherit' })
  git(['push', '--force', 'origin', tag], { stdio: 'inherit' })
  console.log(`git: master pushed, tag ${tag} pushed`)
} else {
  console.log('git: skipped (release-only)')
}

// Build the release asset from the checked-out tree, then rename by release tag.
const temp = mkdtempSync(join(tmpdir(), 'dsh-release-'))
let assetPath
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const out = run(npm, ['pack', '--pack-destination', temp], { stdio: ['ignore', 'pipe', 'pipe'] })
  const packed = out.trim().split(/\r?\n/).filter(Boolean).pop()
  if (!packed) throw new Error('npm pack produced no filename')
  assetPath = join(temp, `dsh-util-plugs-${tag}.tgz`)
  renameSync(join(temp, packed), assetPath)
  console.log(`asset: ${assetPath} (${readFileSync(assetPath).length} bytes)`)

  const token = process.env.GITHUB_TOKEN || (() => {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: repoRoot,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const line = out.split(/\r?\n/).find(l => l.startsWith('password='))
    if (!line) throw new Error('no GitHub credential found (set GITHUB_TOKEN)')
    return line.slice('password='.length)
  })()
  const api = async (path, init = {}) => {
    const res = await fetch('https://api.github.com' + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers || {}),
      },
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${path}: ${text}`)
    return data
  }
  const repoPath = '/repos/wndd5603/dsh-util-plugs'
  let release = null
  try {
    release = await api(`${repoPath}/releases/tags/${tag}`)
  } catch (error) {
    if (!String(error.message).includes('404')) throw error
  }
  const payload = {
    tag_name: tag,
    target_commitish: 'master',
    name: `dsh-util-plugs ${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  }
  release = release
    ? await api(`${repoPath}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })
    : await api(`${repoPath}/releases`, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })

  const assetName = `dsh-util-plugs-${tag}.tgz`
  for (const asset of release.assets ?? []) {
    if (asset.name === assetName) await api(`${repoPath}/releases/assets/${asset.id}`, { method: 'DELETE' })
  }
  const upload = await fetch(`https://uploads.github.com${repoPath}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/gzip',
    },
    body: readFileSync(assetPath),
  })
  if (!upload.ok) throw new Error(`asset upload failed ${upload.status}: ${await upload.text()}`)
  console.log(`release: ${release.html_url}`)
  console.log(`asset: ${assetName}`)
} finally {
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true })
}
