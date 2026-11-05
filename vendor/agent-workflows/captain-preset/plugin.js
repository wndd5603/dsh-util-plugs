/**
 * Captain preset bootstrap plugin (DSH host plugin, zero npm dependencies).
 * Role names below (captain/builder/verifier/scribe) are team roles, not teammate
 * names: normal teammates follow <domain>-<role> (e.g. toolbox-env); *-captain is
 * reserved for sessions that actually act as captains.
 *
 * Registers two profile-level global tools (global row), available in blank and
 * any-preset sessions; the captain preset only contributes persona/instructions:
 * - team_init:  initialize the project's team workspace (documents, member role
 *               files, zero-dependency audit CLIs, legacy file-based pipe2 templates).
 *               Idempotent: existing files are reported as skipped, never
 *               overwritten.
 * - team_members_check: verify the team structure (member files, six required sections,
 *               tools) and report problems.
 *
 * Templates ship beside this file under templates/ and are copied verbatim.
 * The scaffold root defaults to the calling session's working directory.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boolean, number, stringArray, defaultsOf, objectSchema } from '../lib/standard-schema.js'

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Declarative config schema (Standard Schema v1, zero dependency). All keys are
 * optional; the host validates and fills defaults before `apply`.
 */
export const Config = objectSchema({
  enabled: boolean(true, { description: 'Register the team_init / team_members_check tools.' }),
  schemaVersion: number(1, { description: 'Config schema version; newer values are rejected.', int: true, min: 1 }),
  roles: stringArray(['captain', 'builder', 'verifier', 'scribe'], {
    description: 'Default member roles used by team_init when the tool call omits roles.',
  }),
}, { description: 'Captain (team bootstrap) preset configuration.', schemaVersion: 1 })

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(HERE, 'templates')

/** Default team roles when the caller does not pass one. */
export const DEFAULT_ROLES = ['captain', 'builder', 'verifier', 'scribe']

/** Required section-heading fragments in every member AGENTS.md. */
const REQUIRED_SECTIONS = ['你是谁', '写范围', '六项回报义务', '上下文纪律', '禁止事项', '文件夹权限']

const TOOL_TEMPLATES = ['team_member_audit.js', 'team_structure_check.js', 'team_minutes_new.js']
const PIPE2_TEMPLATES = ['pipe2_tool.js', 'pipe2_watch.js']

function template(relative) {
  return readFileSync(join(TEMPLATE_DIR, relative), 'utf8')
}

function safeRole(role) {
  return String(role).replace(/[^a-zA-Z0-9._-]/g, '-')
}

/**
 * Create the team workspace under `root`. Never overwrites existing files.
 * @param {string} root absolute project root
 * @param {{ roles?: string[] }} options
 * @returns {{ root: string, roles: string[], created: string[], skipped: string[] }}
 */
export function scaffoldProject(root, options = {}) {
  const roles = Array.isArray(options.roles) && options.roles.length > 0
    ? options.roles.map(String)
    : DEFAULT_ROLES
  const preview = options.preview === true
  const created = []
  const skipped = []
  const write = (relative, content) => {
    const absolute = join(root, relative)
    if (existsSync(absolute)) {
      skipped.push(relative)
      return
    }
    // preview: report what WOULD be created without touching the filesystem.
    if (preview) {
      created.push(relative)
      return
    }
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
    created.push(relative)
  }

  write(join('team', 'TEAM.md'), template('TEAM.md'))
  write(join('team', 'meetings', 'MEETINGS.md'), template('MEETINGS.md'))
  for (const role of roles) {
    const dir = safeRole(role)
    write(join('team', 'members', dir, 'AGENTS.md'), template('AGENTS.md').replaceAll('{{ROLE}}', role))
    if (!preview) mkdirSync(join(root, 'team', 'members', dir, 'scratch'), { recursive: true })
  }
  for (const tool of TOOL_TEMPLATES) write(join('tools', tool), template(join('tools', tool)))
  for (const tool of PIPE2_TEMPLATES) write(join('team', tool), template(join('tools', tool)))

  return { root, roles, created, skipped }
}

/**
 * Check the team structure under `root`.
 * @param {string} root absolute project root
 * @param {string[]} [roles] roles to expect; defaults to the member directories present
 * @returns {{ ok: boolean, members: string[], problems: string[] }}
 */
export function auditProject(root, roles) {
  const problems = []
  const members = []
  const teamDir = join(root, 'team')
  if (!existsSync(join(teamDir, 'TEAM.md'))) problems.push('缺少 team/TEAM.md')
  if (!existsSync(join(teamDir, 'meetings', 'MEETINGS.md'))) problems.push('缺少 team/meetings/MEETINGS.md')
  for (const tool of TOOL_TEMPLATES) {
    if (!existsSync(join(root, 'tools', tool))) problems.push('缺少 tools/' + tool)
  }
  for (const tool of PIPE2_TEMPLATES) {
    if (!existsSync(join(teamDir, tool))) problems.push('缺少 team/' + tool)
  }

  const membersDir = join(teamDir, 'members')
  if (existsSync(membersDir)) {
    for (const entry of readdirSync(membersDir)) {
      const absolute = join(membersDir, entry)
      let isDirectory = false
      try { isDirectory = statSync(absolute).isDirectory() } catch { isDirectory = false }
      if (!isDirectory) continue
      members.push(entry)
      const agentsFile = join(absolute, 'AGENTS.md')
      if (!existsSync(agentsFile)) {
        problems.push('team/members/' + entry + '/AGENTS.md 缺失')
        continue
      }
      const content = readFileSync(agentsFile, 'utf8')
      for (const section of REQUIRED_SECTIONS) {
        if (!content.includes(section)) problems.push('team/members/' + entry + '/AGENTS.md 缺少「' + section + '」')
      }
      if (!existsSync(join(absolute, 'scratch'))) problems.push('team/members/' + entry + '/scratch 缺失')
    }
  } else {
    problems.push('缺少 team/members/ 目录')
  }

  if (Array.isArray(roles) && roles.length > 0) {
    const present = new Set(members.map(member => safeRole(member)))
    for (const role of roles) {
      if (!present.has(safeRole(role))) problems.push('缺少成员角色：' + role)
    }
  }
  if (members.length === 0 && existsSync(membersDir)) problems.push('team/members/ 下没有任何成员')

  return { ok: problems.length === 0, members, problems }
}

export const inject = ['tools']

export function apply(ctx, config) {
  config = {
    ...defaultsOf(Config),
    ...(config !== null && typeof config === 'object' ? config : {}),
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[captain-preset] disabled by config (enabled=false); no tools registered')
    return
  }
  /** Roles from the tool argument win; config.roles is the fallback. */
  const rolesFor = (argsRoles) => (Array.isArray(argsRoles) && argsRoles.length > 0
    ? argsRoles
    : config.roles)
  const sessionRoots = (agent) => {
    const roots = []
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const value = workingDirectory?.get(agent.session)
      if (typeof value === 'string' && value.trim() !== '') roots.push(value)
    } catch { /* ignore service errors */ }
    for (const value of [agent?.session?.header?.cwd, agent?.workspace?.cwd, agent?.workspace?.root]) {
      if (typeof value === 'string' && value.trim() !== '') roots.push(value)
    }
    const unique = []
    for (const value of roots) {
      const resolved = resolve(value)
      if (!unique.some(existing => existing.toLowerCase() === resolved.toLowerCase())) unique.push(resolved)
    }
    return unique
  }
  /** Confine team_init/team_members_check to the calling session's workspace. */
  const assertRootAllowed = (agent, root) => {
    const resolved = resolve(String(root))
    const bases = sessionRoots(agent)
    if (bases.length === 0) {
      throw new Error('team_init/team_members_check require a session working directory; refusing an unconstrained root')
    }
    const inside = bases.some(base => {
      const rel = relative(base, resolved)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!inside) throw new Error('root must stay inside the session workspace: ' + resolved)
    return resolved
  }
  const rootFor = (agent) => {
    const bases = sessionRoots(agent)
    if (bases.length === 0) throw new Error('session working directory unavailable; refusing process cwd fallback')
    return bases[0]
  }

  ctx.tools.register({
    name: 'team_init',
    description:
      'Initialize the team workspace for this project: team/TEAM.md, team/meetings/MEETINGS.md, '
      + 'team/members/<role>/AGENTS.md per role, zero-dependency audit CLIs under tools/, and the '
      + 'and legacy file-based pipe2 templates under team/ (legacy-only; prefer the installed '
      + 'message-bus/team-bus tools for cross-session messaging). Idempotent: existing files are skipped, never overwritten. '
      + 'Defaults the root to the session working directory and roles to '
      + DEFAULT_ROLES.join(', ') + '. Set preview:true to list what would be created without writing anything. '
      + 'Call it once at session start, then read team/TEAM.md. Human confirmation: preview before the first write; '
      + 'see team-bootstrap §2 / OPERATOR_ONLY_BOUNDARIES.md.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Absolute project root; defaults to the session working directory.' },
        roles: { type: 'array', items: { type: 'string' }, description: 'Member role names to scaffold.' },
        preview: { type: 'boolean', description: 'Dry-run: return wouldCreate/wouldSkip without touching the filesystem.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('team_init requires an Agent-backed session')
      const requestedRoot = typeof args.root === 'string' && args.root.length > 0 ? args.root : rootFor(agent)
      const root = assertRootAllowed(agent, requestedRoot)
      const preview = args.preview === true
      const result = scaffoldProject(root, { roles: rolesFor(args.roles), preview })
      return {
        plugin: 'dsh-workflow-presets/captain-preset',
        version: PLUGIN_VERSION,
        preview,
        ...result,
        ...(preview ? { audit: null } : { audit: auditProject(root, result.roles) }),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Initialize team workspace', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'team_members_check',
    description:
      'Verify the team structure of this project: required team documents, every member AGENTS.md section, '
      + 'scratch directories, and the zero-dependency tools. Read-only; returns the problems it finds.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Absolute project root; defaults to the session working directory.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('team_members_check requires an Agent-backed session')
      const requestedRoot = typeof args.root === 'string' && args.root.length > 0 ? args.root : rootFor(agent)
      const root = assertRootAllowed(agent, requestedRoot)
      return { plugin: 'dsh-workflow-presets/captain-preset', version: PLUGIN_VERSION, root, ...auditProject(root) }
    },
    presentCall: () => ({ card: 'generic', title: 'Audit team workspace', kind: 'read' }),
  })
}
