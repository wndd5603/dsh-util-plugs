/**
 * dsh-session-network · structured pitfalls + fast probe (P1-B)
 *
 * The source of truth is the user skill `~/.agents/skills/dsh-dev-pitfalls/SKILL.md`
 * (symptom index + per-section 机理/诊断/方法论). We parse the symptom index into
 * structured items instead of returning raw markdown fragments.
 *
 * Contract (P1 task packet):
 *   buildPitfalls({file?, query?, limit?, probe?}) -> {
 *     count, items: [{symptom, action, sourceLine}], sourceFile,
 *     probe: { ok: 'ok'|'fail', checks: [{name, ok, detail?}], elapsedMs }
 *   }
 * All checks are fail-open (never throw) and bounded (~200ms): no pwsh process
 * spawn — availability is probed via `where.exe pwsh` (fast) only.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const PITFALLS_SKILL_NAME = 'dsh-dev-pitfalls'
export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 10
export const PROBE_BUDGET_MS = 200

export function defaultPitfallsFile({ env = process.env } = {}) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  return join(home, '.agents', 'skills', PITFALLS_SKILL_NAME, 'SKILL.md')
}

function clampLimit(value) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, number))
}

/** Parse YAML frontmatter conservatively (name/description presence only). */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
  if (match === null) return { present: false, name: null, description: null }
  const block = match[1]
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? null
  const description = /\bdescription:\s*([\s\S]*?)(?=\n[a-z][a-z0-9_-]*:\s|\s*$)/i.exec(block)?.[1]?.trim() ?? null
  return { present: true, name, description: description === null || description === '' ? null : description }
}

function cleanInline(text) {
  return String(text)
    .replace(/`[^`]*`/g, match => match) // keep inline code (useful in symptom text)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse the `## 快速上手（症状索引）` code block: `症状？ → §N 标题`.
 * Each symptom maps to the matching `## N. 标题` section; action is assembled from
 * the section's 机理/方法论/诊断 bullets (not the markdown headings).
 */
export function parsePitfallsText(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const sections = new Map()
  let current = null
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+([0-9]+)\.\s*(.+)$/.exec(lines[index])
    if (heading !== null) {
      current = { number: heading[1], title: cleanInline(heading[2]), startLine: index + 1, bullets: [] }
      sections.set(current.number, current)
      continue
    }
    if (current !== null) {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(lines[index])
      if (bullet !== null) current.bullets.push({ line: index + 1, text: cleanInline(bullet[1]) })
      else if (lines[index].trim() !== '' && !/^#{1,4}\s/.test(lines[index])) {
        current.bullets.push({ line: index + 1, text: cleanInline(lines[index]) })
      }
    }
  }
  const items = []
  for (let index = 0; index < lines.length; index += 1) {
    const row = /^\s*(.+?)\s*→\s*§\s*([0-9]+)\s*(.*)$/.exec(lines[index])
    if (row === null) continue
    const symptom = cleanInline(row[1])
    if (symptom === '') continue
    const section = sections.get(row[2])
    if (section === undefined) continue
    const action = section.bullets.slice(0, 4).map(bullet => bullet.text).join(' ').slice(0, 400)
    items.push({
      symptom,
      action,
      sourceLine: index + 1,
      line: index + 1,
      source: PITFALLS_SKILL_NAME,
      section: '§' + section.number + ' ' + section.title,
    })
  }
  return { items, sectionCount: sections.size }
}

function probeResult(checks, startedAt) {
  const ok = checks.some(check => check.ok) && !checks.some(check => check.ok === false && check.critical === true)
  return {
    ok: ok ? 'ok' : 'fail',
    checks,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  }
}

function findOnPath(names, env) {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '')
  for (const name of names) {
    for (const dir of pathValue.split(delimiter)) {
      if (dir === '') continue
      try {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      } catch { /* ignore */ }
    }
  }
  return null
}

function checkPwsh(checks, env) {
  try {
    let found = null
    for (const executable of ['pwsh', 'powershell']) {
      try {
        execFileSync('where.exe', [executable], { timeout: 100, stdio: 'ignore', windowsHide: true })
        found = executable
        break
      } catch { /* try next */ }
    }
    if (found === null) found = findOnPath(['pwsh.exe', 'powershell.exe'], env)
    if (found !== null) checks.push({ name: 'pwsh', ok: true, detail: 'shell available: ' + found, critical: false })
    else checks.push({ name: 'pwsh', ok: false, detail: 'no pwsh/powershell found on PATH', critical: false })
  } catch (error) {
    checks.push({ name: 'pwsh', ok: false, detail: 'probe error: ' + String(error?.code ?? error?.message ?? error), critical: false })
  }
}

function checkLossless(checks) {
  try {
    const roundTrip = JSON.parse(JSON.stringify({ probe: [1, 2, 3], text: 'x' }))
    const ok = Array.isArray(roundTrip.probe) && roundTrip.probe.length === 3
    checks.push({ name: 'lossless', ok, detail: ok ? 'JSON round-trip sanity ok' : 'JSON round-trip lost structure', critical: false })
  } catch (error) {
    checks.push({ name: 'lossless', ok: false, detail: 'lossless check threw: ' + String(error?.message ?? error), critical: false })
  }
}

function checkSkillFile(file, text, checks) {
  const exists = existsSync(file)
  checks.push({ name: 'skill-file', ok: exists, detail: exists ? file : 'missing: ' + file, critical: true })
  if (!exists) return
  const frontmatter = parseFrontmatter(text)
  const catalogOk = frontmatter.present && frontmatter.name === PITFALLS_SKILL_NAME && typeof frontmatter.description === 'string'
  checks.push({
    name: 'skill-catalog',
    ok: catalogOk,
    detail: catalogOk ? 'frontmatter name+description present (catalog-visible)' : 'frontmatter missing/incomplete → catalog silently ignores this skill',
    critical: false,
  })
}

/**
 * @param {{file?: string, query?: string, limit?: number, probe?: boolean, env?: object}} [options]
 */
export function buildPitfalls({ file, query, limit, probe = true, env = process.env } = {}) {
  const startedAt = Date.now()
  const sourceFile = typeof file === 'string' && file.trim() !== '' ? file.trim() : defaultPitfallsFile({ env })
  const checks = []
  const max = clampLimit(limit)
  let text = ''
  if (probe === true) {
    checkPwsh(checks, env)
    checkLossless(checks)
    try { text = existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8') : '' } catch { text = '' }
    checkSkillFile(sourceFile, text, checks)
  } else {
    try { text = existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8') : '' } catch { text = '' }
  }
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  let items = []
  if (text !== '') {
    const parsed = parsePitfallsText(text)
    items = parsed.items
      .filter(item => q === '' || item.symptom.toLowerCase().includes(q) || item.action.toLowerCase().includes(q))
      .slice(0, max)
    checks.push({ name: 'symptom-index', ok: parsed.items.length > 0, detail: `${parsed.items.length} structured symptoms / ${parsed.sectionCount} sections`, critical: false })
  } else if (probe === true) {
    checks.push({ name: 'symptom-index', ok: false, detail: 'no source text available', critical: false })
  }
  const probeInfo = probe === true ? probeResult(checks, startedAt) : { ok: 'ok', checks: [], elapsedMs: Math.max(0, Date.now() - startedAt) }
  return {
    count: items.length,
    items,
    sourceFile,
    probe: probeInfo,
    ...(q === '' ? {} : { query: q }),
  }
}

export default { buildPitfalls, parsePitfallsText, defaultPitfallsFile, PITFALLS_SKILL_NAME }
