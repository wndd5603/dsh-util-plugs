window.__ModuleLoader__.load({
	id: "dsh-plugin-console",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

/**
 * Pure console-domain logic for the unified plugin console.
 *
 * This module is shared by `lib/client.js` (inlined at build time by
 * `scripts/build-client.mjs`) and the unit tests. It must stay browser-safe and
 * dependency-free: no imports, no DOM, no React.
 */

/** Keys of the sidebar panel and the main slot this plugin registers. */
const PANEL_ID = 'plugin-console'
/** Locale namespace owned by this plugin. */
const LOCALE_NS = 'pluginConsole'

/** Sentinel state filter values accepted by `filterCards`. */
const FILTERS = ['all', 'configurable', 'disabled']

/** Page-size options the pagination control offers (default first). */
const PAGE_SIZES = [12, 24, 48]
/** Default page size for the card list. */
const DEFAULT_PAGE_SIZE = PAGE_SIZES[0]

/** localStorage schema version for the first-screen cache. */
const CACHE_SCHEMA_VERSION = 1

/** One manifest label from a string or a `{ name }`-style record. */
function labelOf(value) {
  if (typeof value === 'string' && value !== '') return value
  if (value !== null && typeof value === 'object') {
    for (const key of ['name', 'title', 'label']) {
      if (typeof value[key] === 'string' && value[key] !== '') return value[key]
    }
  }
  return undefined
}

/** Read a possibly localized manifest field (`meta` is `{zh:{name}, en:{name}}` or `{zh:'…'}`). */
function localized(value, fallback) {
  const direct = labelOf(value)
  if (direct !== undefined) return direct
  if (value !== null && typeof value === 'object') {
    for (const key of ['zh', 'en']) {
      const label = labelOf(value[key])
      if (label !== undefined) return label
    }
    for (const candidate of Object.values(value)) {
      const label = labelOf(candidate)
      if (label !== undefined) return label
    }
  }
  return fallback
}

/** Entry id of a bundle row, when the Host could resolve it. */
function rowEntryId(row) {
  return typeof row?.entryId === 'string' && row.entryId !== '' ? row.entryId : undefined
}

/**
 * The settings namespace view for one entry, when the Host serves a live form.
 * Include rows are addressed differently in the two Host views (`rowId` vs the
 * settings namespace, or an `include:`-prefixed Loader entry id), so every
 * candidate spelling is matched.
 */
function namespaceOf(namespaces, entryId, rowId) {
  const candidates = []
  if (typeof entryId === 'string' && entryId !== '') candidates.push(entryId, entryId.replace(/^include:/, ''))
  if (typeof rowId === 'string' && rowId !== '') candidates.push(rowId)
  if (candidates.length === 0) return undefined
  return namespaces.find(view => candidates.some(candidate => view.ns === candidate || view.ns.endsWith(`:${candidate}`) || candidate.endsWith(`:${view.ns}`)))
}

/** Status bucket of one card: `failed | restart | readonly | disabled | running | pending`. */
function cardStatus(card) {
  if (card.error !== undefined) return 'failed'
  if (card.restartRequired === true) return 'restart'
  if (card.readOnlyReason !== undefined) return 'readonly'
  if (card.enabled === false) return 'disabled'
  if (card.fiberPhase === 'failed') return 'failed'
  if (card.fiberPhase === 'pending' || card.fiberPhase === 'loading') return 'pending'
  return 'running'
}

function entryStatus(entry) {
  if (entry?.fiberPhase === 'failed') return 'failed'
  if (entry?.enabled === false) return 'disabled'
  if (entry?.fiberPhase === 'pending' || entry?.fiberPhase === 'loading') return 'pending'
  return 'running'
}

/** Merge a bundle with the live Loader entries and the served settings namespaces. */
function bundleCard(bundle, entriesById, namespaces) {
  const rows = (bundle.rows ?? []).map(row => {
    const entryId = rowEntryId(row)
    const entry = entryId === undefined ? undefined : entriesById.get(entryId)
    const configView = namespaceOf(namespaces, entryId, row.rowId)
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      entryId,
      entryPresent: entry !== undefined,
      enabled: entry === undefined ? true : entry.enabled !== false,
      fiberPhase: entry === undefined ? null : entry.fiberPhase ?? null,
      configurable: configView !== undefined,
      configNs: configView?.ns,
      title: localized(row.meta?.name, row.rowId),
      description: localized(row.meta?.description, undefined),
    }
  })
  const configurable = rows.filter(row => row.configurable).length
  const failedRows = rows.filter(row => row.fiberPhase === 'failed').length
  const disabledRows = rows.filter(row => row.enabled === false).length
  return {
    kind: 'bundle',
    key: `bundle:${bundle.name}`,
    packageName: bundle.name,
    title: localized(bundle.meta?.name, bundle.name),
    description: localized(bundle.meta?.description, bundle.description),
    version: bundle.version,
    official: bundle.official === true,
    installed: bundle.installed === true,
    enabled: bundle.enabled !== false,
    availability: bundle.availability,
    removable: bundle.removable === true,
    updatable: bundle.updatable === true,
    officialOnDemand: bundle.installTarget !== undefined,
    error: bundle.error?.diagnostic !== undefined ? bundle.error.diagnostic : (bundle.error !== undefined ? String(bundle.error.code ?? 'error') : undefined),
    readOnlyReason: bundle.readOnlyReason,
    rows,
    configurable,
    failedRows,
    disabledRows,
    fiberPhase: failedRows > 0 ? 'failed' : (bundle.enabled === false ? null : 'active'),
  }
}

/** One Loader entry that no bundle row claims (built-in or preset row). */
function entryCard(entry, namespaces) {
  const configView = namespaceOf(namespaces, entry.entryId)
  return {
    kind: 'entry',
    key: `entry:${entry.entryId}`,
    packageName: entry.moduleName,
    entryId: entry.entryId,
    title: localized(entry.meta?.name, entry.moduleName),
    description: localized(entry.meta?.description, undefined),
    enabled: entry.enabled !== false,
    fiberPhase: entry.fiberPhase ?? null,
    rows: [],
    configurable: configView === undefined ? 0 : 1,
    configNs: configView?.ns,
    failedRows: entry.fiberPhase === 'failed' ? 1 : 0,
    disabledRows: entry.enabled === false ? 1 : 0,
  }
}

/** Normalize the two Host reads into cards grouped for display. */
function buildConsoleModel(input) {
  const inventory = input?.inventory
  const bundles = Array.isArray(input?.bundles) ? input.bundles : []
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : []
  const namespaces = Array.isArray(input?.namespaces) ? input.namespaces : []
  const entriesById = new Map(entries.map(entry => [entry.entryId, entry]))
  const seenEntries = new Set()
  const cards = bundles.map(bundle => {
    const card = bundleCard(bundle, entriesById, namespaces)
    for (const row of card.rows) if (row.entryId !== undefined) seenEntries.add(row.entryId)
    return card
  })
  for (const entry of entries) {
    if (seenEntries.has(entry.entryId)) continue
    cards.push(entryCard(entry, namespaces))
  }
  const newKeys = new Set(input?.newKeys ?? [])
  for (const card of cards) card.isNew = newKeys.has(card.key)
  const optional = cards.filter(card => card.kind === 'bundle' && card.installed === false && card.availability === 'missing')
  const optionalSet = new Set(optional)
  const remaining = cards.filter(card => !optionalSet.has(card))
  const disabled = remaining.filter(card => card.enabled === false)
  const disabledSet = new Set(disabled)
  const enabled = remaining.filter(card => !disabledSet.has(card))
  const configurable = remaining.filter(card => card.configurable > 0)
  const fresh = cards.filter(card => card.isNew === true)
  return {
    status: input?.status ?? 'ready',
    error: input?.error,
    writable: input?.writable === true,
    fromCache: input?.fromCache === true,
    cachedAt: input?.cachedAt,
    cards,
    groups: { enabled, disabled, optional },
    stats: {
      total: cards.length,
      enabled: enabled.length,
      disabled: disabled.length,
      new: fresh.length,
      configurable: configurable.length,
      optional: optional.length,
      entries: entries.length,
      bundles: bundles.length,
    },
  }
}

/** Apply the search text and filter chip to the model's groups. */
function filterCards(model, query, filter) {
  const text = String(query ?? '').trim().toLowerCase()
  const matches = card => {
    if (filter === 'configurable' && !(card.configurable > 0)) return false
    if (filter === 'disabled' && card.enabled !== false) return false
    if (text === '') return true
    const haystack = [card.title, card.packageName, card.description, ...(card.rows ?? []).map(row => row.moduleName), ...(card.rows ?? []).map(row => row.title)]
    return haystack.some(value => typeof value === 'string' && value.toLowerCase().includes(text))
  }
  const pick = list => list.filter(matches)
  return { ...model, groups: { enabled: pick(model.groups.enabled), disabled: pick(model.groups.disabled), optional: pick(model.groups.optional ?? []) } }
}

/**
 * Keys that appeared since the previous visit: an absent `knownKeys` is the
 * first run and marks nothing (never flood a new deployment with NEW badges).
 */
function diffNewKeys(currentKeys, knownKeys) {
  if (!Array.isArray(knownKeys)) return []
  const known = new Set(knownKeys)
  return currentKeys.filter(key => !known.has(key))
}

/**
 * Merge one refresh result into the session's NEW set. A reset refresh (manual
 * refresh, plugin-manager change) replaces the set with what appeared since the
 * last known baseline; an automatic refresh merges additions so the first cache
 * paint stays marked until the next explicit refresh. The returned known keys
 * become the baseline for the next refresh.
 */
function mergeNewKeys(currentKeys, knownKeys, sessionNew, reset) {
  const incoming = diffNewKeys(currentKeys, knownKeys)
  const merged = reset === true
    ? incoming
    : [...new Set([...(Array.isArray(sessionNew) ? sessionNew : []), ...incoming])]
  return { newKeys: merged.filter(key => currentKeys.includes(key)), knownKeys: currentKeys }
}

/**
 * Slice the filtered groups into one page while keeping group titles and
 * display order (`enabled`, `disabled`, `optional`). No card is rendered twice.
 */
function paginateCards(model, page, pageSize) {
  const sizes = PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE
  const order = ['enabled', 'disabled', 'optional']
  const groups = order.map(id => ({ id, cards: Array.isArray(model?.groups?.[id]) ? model.groups[id] : [] }))
  const total = groups.reduce((sum, group) => sum + group.cards.length, 0)
  const pageCount = Math.max(1, Math.ceil(total / sizes))
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount)
  const offset = (current - 1) * sizes
  let remaining = Math.min(sizes, Math.max(0, total - offset))
  let cursor = 0
  const slices = []
  for (const group of groups) {
    const start = Math.max(0, offset - cursor)
    const cards = group.cards.slice(start, start + remaining)
    if (cards.length > 0) slices.push({ id: group.id, cards })
    remaining -= cards.length
    cursor += group.cards.length
    if (remaining <= 0) break
  }
  const from = total === 0 ? 0 : offset + 1
  const to = total === 0 ? 0 : Math.min(total, offset + sizes)
  return { groups: slices, page: current, pageCount, pageSize: sizes, total, from, to }
}

/**
 * Whitelist the cache payload: the first screen gets inventory/bundles plus the
 * config schema+values needed to draw badges; user/base sections and secret
 * descriptors are never persisted (the Host already redacts secret values).
 */
function serializeConsoleCache(input, now = Date.now()) {
  const namespaces = (Array.isArray(input?.namespaces) ? input.namespaces : []).map(view => ({
    ns: view.ns,
    schema: view.schema,
    value: view.value,
    revision: view.revision,
    autoGenerate: view.autoGenerate === true,
    applies: view.applies,
  }))
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    savedAt: now,
    inventory: input?.inventory,
    bundles: Array.isArray(input?.bundles) ? input.bundles : [],
    namespaces,
    writable: input?.writable === true,
  }
}

/** Validate and sanitize a localStorage cache payload; malformed entries are ignored. */
function parseConsoleCache(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-object' }
  if (raw.schemaVersion !== CACHE_SCHEMA_VERSION) return { ok: false, reason: 'schema-version' }
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt)) return { ok: false, reason: 'saved-at' }
  if (raw.inventory === null || typeof raw.inventory !== 'object' || !Array.isArray(raw.inventory?.entries)) return { ok: false, reason: 'inventory' }
  if (!Array.isArray(raw.bundles)) return { ok: false, reason: 'bundles' }
  if (!Array.isArray(raw.namespaces)) return { ok: false, reason: 'namespaces' }
  const namespaces = raw.namespaces.filter(view => view !== null && typeof view === 'object' && typeof view.ns === 'string' && view.schema !== undefined)
  return {
    ok: true,
    cache: {
      schemaVersion: CACHE_SCHEMA_VERSION,
      savedAt: raw.savedAt,
      inventory: raw.inventory,
      bundles: raw.bundles,
      namespaces,
      writable: raw.writable === true,
    },
  }
}

/** Find one card by its key in every group. */
function findCard(model, key) {
  for (const group of Object.values(model.groups)) {
    const found = group.find(card => card.key === key)
    if (found !== undefined) return found
  }
  return undefined
}

const UNSUPPORTED = { kind: 'unsupported' }

function fieldLabel(node, key) {
  const meta = node?.meta ?? {}
  return typeof meta.title === 'string' && meta.title !== '' ? meta.title : key
}

/** Field kind for a serialized schemastery node; unknown shapes stay read-only. */
function fieldKind(node) {
  if (node === null || typeof node !== 'object') return 'unsupported'
  if (node.type === 'boolean') return 'boolean'
  if (node.type === 'number') return 'number'
  if (node.type === 'string') return node.meta?.role === 'secret' ? 'secret' : 'string'
  if (node.type === 'union') {
    const options = (node.list ?? []).flatMap(item => item?.type === 'const' && 'value' in item ? [item.value] : [])
    if (options.length === (node.list ?? []).length && options.length > 0) return 'enum'
    return 'unsupported'
  }
  if (node.type === 'const' || node.type === 'literal') return 'unsupported'
  if (node.type === 'object' && node.dict !== null && typeof node.dict === 'object') return 'object'
  return 'unsupported'
}

function childrenFields(node, parentPath, depth) {
  if (depth > 2) return []
  return Object.entries(node.dict ?? {}).map(([key, child]) => fieldDescriptor(key, child, [...parentPath, key], depth))
}

function fieldDescriptor(key, node, path, depth) {
  const meta = node?.meta ?? {}
  const kind = fieldKind(node)
  const base = {
    key,
    path,
    label: fieldLabel(node, key),
    description: typeof meta.description === 'string' ? meta.description : undefined,
    required: meta.required === true,
    default: meta.default,
  }
  switch (kind) {
    case 'boolean':
    case 'number':
    case 'string':
    case 'secret':
      return { ...base, kind, ...(kind === 'number' ? { min: meta.min, max: meta.max, step: meta.step } : {}) }
    case 'enum':
      return { ...base, kind, options: (node.list ?? []).map(item => item.value) }
    case 'object':
      return { ...base, kind, children: childrenFields(node, path, depth + 1) }
    default:
      return { ...base, kind: 'unsupported', node }
  }
}

/**
 * Rehydrate schemastery's compact serialized form (`{uid, refs:{id:node}}`):
 * child nodes are numeric ids pointing into `refs`. Plain object schemas pass
 * through unchanged, so both wire shapes render.
 */
function resolveSerializedSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const refs = schema.refs !== null && typeof schema.refs === 'object' ? schema.refs : undefined
  if (refs === undefined || schema.uid === undefined) return schema
  const resolve = node => (typeof node === 'number' || typeof node === 'string') && refs[node] !== undefined ? refs[node] : node
  const walk = node => {
    const source = resolve(node)
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return source
    const copy = { ...source }
    if (source.dict !== null && typeof source.dict === 'object' && !Array.isArray(source.dict)) {
      copy.dict = Object.fromEntries(Object.entries(source.dict).map(([key, child]) => [key, walk(child)]))
    }
    if (source.inner !== undefined) copy.inner = walk(source.inner)
    if (Array.isArray(source.list)) copy.list = source.list.map(walk)
    return copy
  }
  return walk(schema.uid)
}

/** Renderable field tree for one serialized settings schema; empty when not an object form. */
function schemaFields(schema) {
  const root = resolveSerializedSchema(schema)
  if (root === undefined || root === null || typeof root !== 'object' || root.type !== 'object' || root.dict === null || typeof root.dict !== 'object') return []
  return Object.entries(root.dict).map(([key, node]) => fieldDescriptor(key, node, [key], 0))
}

/** Read a nested value by path. */
function valueAt(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** Walk every editable leaf (scalar kinds only) of a field tree. */
function editableFields(fields) {
  const result = []
  const visit = list => {
    for (const field of list) {
      if (field.kind === 'object') visit(field.children ?? [])
      else if (field.kind !== 'unsupported' && field.kind !== 'secret') result.push(field)
    }
  }
  visit(fields)
  return result
}

/** Initial draft values for a form, keyed by field path joined with `.`. */
function draftFromFields(fields, value) {
  const draft = {}
  for (const field of editableFields(fields)) {
    const current = valueAt(value, field.path)
    draft[field.path.join('.')] = field.kind === 'boolean' ? current === true : (current === undefined ? '' : current)
  }
  return draft
}

/** Compare a draft with the resolved value and build atomic Host writes. */
function buildConfigOps(fields, draft, value) {
  const ops = []
  for (const field of editableFields(fields)) {
    const key = field.path.join('.')
    const next = draft[key]
    const current = valueAt(value, field.path)
    if (field.kind === 'boolean') {
      const nextBool = next === true
      if (nextBool !== (current === true)) ops.push({ op: 'set', path: field.path, value: nextBool })
      continue
    }
    if (field.kind === 'number') {
      const text = String(next ?? '').trim()
      if (text === '') {
        if (current !== undefined) ops.push({ op: 'unset', path: field.path })
        continue
      }
      const number = Number(text)
      if (!Number.isFinite(number)) continue
      if (number !== current) ops.push({ op: 'set', path: field.path, value: number })
      continue
    }
    const text = String(next ?? '')
    if (text !== String(current ?? '')) ops.push({ op: 'set', path: field.path, value: text })
  }
  return ops
}

/** A tiny snapshot store the page consumes through the slot hook face. */
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Basic contribution registry exposed as the `pluginConsoleContributions`
 * client service. A contribution may describe a panel rendered inside one
 * plugin's detail page and safe read-only actions.
 *
 * @param {(() => void) | undefined} onError reports a failed listener instead of
 *   letting one plugin break the console.
 */
function createContributionRegistry(onError) {
  const items = new Map()
  const report = error => { if (onError !== undefined) onError(error) }
  const validate = contribution => {
    if (contribution === null || typeof contribution !== 'object') throw new Error('pluginConsoleContributions: contribution must be an object')
    if (typeof contribution.id !== 'string' || contribution.id === '') throw new Error('pluginConsoleContributions: contribution.id must be a non-empty string')
    if (typeof contribution.render !== 'function' && !Array.isArray(contribution.actions)) throw new Error('pluginConsoleContributions: contribution needs render or actions')
    return contribution
  }
  return {
    /** Register one contribution; returns the disposer. */
    register(raw) {
      const contribution = validate(raw)
      if (items.has(contribution.id)) throw new Error(`pluginConsoleContributions: duplicate contribution ${contribution.id}`)
      items.set(contribution.id, contribution)
      return () => { if (items.get(contribution.id) === contribution) items.delete(contribution.id) }
    },
    /** Snapshot of registered contributions in order. */
    list() {
      return [...items.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    },
    /** Contributions that match one subject: `match(subject)` decides; absent matches everything. */
    matching(subject) {
      return this.list().filter(contribution => {
        if (typeof contribution.match !== 'function') return true
        try { return contribution.match(subject) === true } catch (error) { report(error); return false }
      })
    },
    /** Run one contribution's render with an isolated error boundary. */
    render(contribution, subject, context) {
      if (typeof contribution.render !== 'function') return undefined
      try { return contribution.render(subject, context) } catch (error) { report(error); return { error } }
    },
  }
}


/**
 * Browser half of the unified plugin console.
 *
 * The build step (`scripts/build-client.mjs`) inlines `src/core.js` above this
 * file and wraps both in the `window.__ModuleLoader__.load({id, factory})`
 * registration the client module system consumes. `React` is declared by that
 * wrapper; every identifier from `core.js` is in the same factory scope.
 */

const zh = {
  panel: '插件控制台',
  title: '插件控制台',
  subtitle: '统一查看已安装插件的配置、状态与快捷入口。',
  refresh: '刷新',
  openManager: '打开插件管理器',
  searchPlaceholder: '搜索插件、包名或功能…',
  filterAll: '全部',
  filterConfigurable: '可配置',
  filterDisabled: '已禁用',
  newBadge: 'NEW',
  groupEnabled: '已启用',
  groupDisabled: '已禁用',
  groupOthers: '核心插件',
  groupOptional: '可安装（在插件管理器中打开）',
  pagePrev: '上一页',
  pageNext: '下一页',
  pageSizeLabel: '每页',
  pageInfo: '第 {page} / {count} 页 · 共 {total} 项',
  pageGap: '…',
  statusRunning: '运行中',
  statusDisabled: '已禁用',
  statusFailed: '异常',
  statusRestart: '需重启',
  statusReadonly: '只读',
  statusPending: '加载中',
  configurable: '可配置 {count} 项',
  back: '返回',
  tabConfig: '配置',
  tabStatus: '状态',
  tabExtensions: '插件扩展',
  tabAbout: '关于',
  readonly: '只读：当前部署不允许修改插件配置。',
  noConfig: '该插件没有可实时编辑的配置项；安装/卸载/启停请前往插件管理器。',
  noSchema: '配置表单暂不可用（该插件未提供可编辑 schema）。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  saveFailed: '保存失败：{error}',
  reset: '重置修改',
  secretsNote: '含密钥字段，出于安全不在此处显示或编辑。',
  noExtensions: '此插件尚未注册扩展；插件可通过 pluginConsoleContributions 添加状态、快捷操作或自定义面板。',
  contributionFailed: '扩展渲染失败：{error}',
  openInManager: '在插件管理器中打开',
  entryKind: '核心插件',
  bundleKind: '插件包',
  version: '版本',
  enabled: '启用',
  fiber: '运行阶段',
  error: '错误',
  readOnlyReason: '只读原因',
  aboutPackage: '包名',
  aboutModule: '模块',
  aboutRows: '插件行',
  aboutConfigNs: '配置命名空间',
  empty: '没有匹配的插件。',
  loadFailed: '加载失败：{error}',
  retry: '重试',
  refreshFailed: '刷新失败：{error}',
  loading: '正在读取插件…',
  stats: '共 {total} 项 · {new} 新增 · {configurable} 可配置',
  cacheView: '缓存视图',
  cacheRefreshing: '缓存视图 · 后台刷新中…',
  unmounted: '未载入',
}

const en = {
  panel: 'Plugin Console',
  title: 'Plugin Console',
  subtitle: 'One place for installed plugins: configuration, status, and shortcuts.',
  refresh: 'Refresh',
  openManager: 'Open plugin manager',
  searchPlaceholder: 'Search plugins, packages, or features…',
  filterAll: 'All',
  filterConfigurable: 'Configurable',
  filterDisabled: 'Disabled',
  newBadge: 'NEW',
  groupEnabled: 'Enabled',
  groupDisabled: 'Disabled',
  groupOthers: 'Core plugins',
  groupOptional: 'Available (open plugin manager)',
  pagePrev: 'Previous',
  pageNext: 'Next',
  pageSizeLabel: 'Per page',
  pageInfo: 'Page {page} / {count} · {total} entries',
  pageGap: '…',
  statusRunning: 'Running',
  statusDisabled: 'Disabled',
  statusFailed: 'Failed',
  statusRestart: 'Restart required',
  statusReadonly: 'Read-only',
  statusPending: 'Loading',
  configurable: '{count} configurable',
  back: 'Back',
  tabConfig: 'Configuration',
  tabStatus: 'Status',
  tabExtensions: 'Plugin extensions',
  tabAbout: 'About',
  readonly: 'Read-only: this deployment does not accept plugin configuration writes.',
  noConfig: 'No live-editable configuration here; install, remove, and enable/disable stay in the plugin manager.',
  noSchema: 'No editable schema is served for this plugin yet.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed: {error}',
  reset: 'Discard changes',
  secretsNote: 'Secret fields are hidden and not editable here.',
  noExtensions: 'This plugin has not registered extensions yet; plugins can add status, quick actions, or custom panels through pluginConsoleContributions.',
  contributionFailed: 'Extension failed: {error}',
  openInManager: 'Open in plugin manager',
  entryKind: 'Core plugin',
  bundleKind: 'Plugin package',
  version: 'Version',
  enabled: 'Enabled',
  fiber: 'Fiber',
  error: 'Error',
  readOnlyReason: 'Read-only reason',
  aboutPackage: 'Package',
  aboutModule: 'Module',
  aboutRows: 'Rows',
  aboutConfigNs: 'Config namespace',
  empty: 'No plugins match.',
  loadFailed: 'Failed to load: {error}',
  retry: 'Retry',
  refreshFailed: 'Refresh failed: {error}',
  loading: 'Reading plugins…',
  stats: '{total} entries · {new} new · {configurable} configurable',
  cacheView: 'Cached view',
  cacheRefreshing: 'Cached view · refreshing…',
  unmounted: 'Not loaded',
}

const inject = [
  'slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginManager',
  'configForms', 'layout', 'remoteAccess',
]

const panel = React.createElement

/** Scoped classes for the detail tabs; the injected sheet outranks global button chrome. */
const TAB_CLASS = 'dsh-plugin-console-tab'
const TABS_CLASS = 'dsh-plugin-console-tabs'
const TAB_CSS = `
.${TABS_CLASS} .${TAB_CLASS} {
  background: transparent !important;
  box-shadow: none !important;
  outline: none !important;
  border-bottom: 2px solid transparent !important;
}
.${TABS_CLASS} .${TAB_CLASS}[data-active="true"] {
  opacity: 1;
  border-bottom-color: rgba(79, 140, 255, 0.9) !important;
}
.${TABS_CLASS} .${TAB_CLASS}[data-active="false"] {
  border-bottom-color: transparent !important;
}
.${TABS_CLASS} .${TAB_CLASS}:focus-visible {
  outline: 2px solid rgba(79, 140, 255, 0.85) !important;
  outline-offset: 2px !important;
}
`

const style = {
  page: {
    // The page owns the main slot's full content area: no content-width cap, so
    // the outer frame cannot shrink with a short card list.
    padding: '24px 28px 40px', width: '100%', maxWidth: 'none', margin: 0, color: 'inherit', font: 'inherit',
    // The main slot is a fixed-height column: without its own scroll container a
    // long list is clipped and the page cannot be scrolled.
    height: '100%', maxHeight: '100%', boxSizing: 'border-box',
    overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain',
  },
  headerRow: { display: 'flex', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' },
  grow: { flex: '1 1 280px', minWidth: '220px' },
  title: { margin: '0 0 4px', fontSize: '22px', fontWeight: 600 },
  subtitle: { margin: 0, opacity: 0.72, fontSize: '13px', lineHeight: 1.5 },
  button: {
    appearance: 'none', border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.10)',
    color: 'inherit', borderRadius: '8px', padding: '7px 12px', fontSize: '13px', cursor: 'pointer', lineHeight: 1.3,
  },
  buttonPrimary: {
    appearance: 'none', border: '1px solid rgba(79,140,255,0.65)', background: 'rgba(79,140,255,0.16)',
    color: 'inherit', borderRadius: '8px', padding: '7px 12px', fontSize: '13px', cursor: 'pointer', lineHeight: 1.3,
  },
  buttonDisabled: { opacity: 0.55, cursor: 'default' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '18px 0 14px' },
  search: {
    flex: '1 1 260px', minWidth: '200px', padding: '8px 12px', borderRadius: '8px', fontSize: '13px',
    border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.08)', color: 'inherit', outline: 'none',
  },
  chip: {
    appearance: 'none', border: '1px solid rgba(127,127,127,0.28)', background: 'transparent', color: 'inherit',
    borderRadius: '999px', padding: '5px 12px', fontSize: '12.5px', cursor: 'pointer',
  },
  chipActive: { borderColor: 'rgba(79,140,255,0.8)', background: 'rgba(79,140,255,0.16)' },
  newBadge: {
    marginLeft: 'auto', padding: '1px 8px', borderRadius: '999px', fontSize: '10.5px',
    fontWeight: 700, letterSpacing: '0.06em', color: '#fff',
    background: 'rgba(79,140,255,0.92)', border: '1px solid rgba(79,140,255,0.92)',
  },
  pager: {
    display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
    marginTop: '22px', paddingTop: '14px', borderTop: '1px solid rgba(127,127,127,0.2)',
  },
  pagerSpacer: { flex: '1 1 auto' },
  groupTitle: { margin: '20px 0 10px', fontSize: '13px', fontWeight: 600, opacity: 0.75, textTransform: 'uppercase', letterSpacing: '0.04em' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px', listStyle: 'none', margin: 0, padding: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left', width: '100%', boxSizing: 'border-box',
    padding: '14px', borderRadius: '12px', border: '1px solid rgba(127,127,127,0.24)', background: 'rgba(127,127,127,0.06)',
    color: 'inherit', cursor: 'pointer', font: 'inherit',
  },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  cardTitle: { fontWeight: 600, fontSize: '14px' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', opacity: 0.68 },
  desc: { margin: 0, fontSize: '12.5px', lineHeight: 1.45, opacity: 0.78, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  metaRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px' },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '999px',
    fontSize: '11.5px', lineHeight: 1.6, border: '1px solid rgba(127,127,127,0.3)', background: 'rgba(127,127,127,0.08)',
  },
  badgeOk: { borderColor: 'rgba(46,160,67,0.55)', background: 'rgba(46,160,67,0.12)' },
  badgeWarn: { borderColor: 'rgba(210,153,34,0.6)', background: 'rgba(210,153,34,0.14)' },
  badgeDanger: { borderColor: 'rgba(248,81,73,0.6)', background: 'rgba(248,81,73,0.14)' },
  detailTop: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' },
  tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid rgba(127,127,127,0.24)', margin: '16px 0 18px', flexWrap: 'wrap' },
  tab: {
    appearance: 'none', border: 'none', background: 'transparent', color: 'inherit', padding: '8px 12px',
    fontSize: '13px', cursor: 'pointer', opacity: 0.65, borderBottom: '2px solid transparent', marginBottom: '-1px',
    outline: 'none', boxShadow: 'none',
  },
  tabActive: { opacity: 1, borderBottomColor: 'rgba(79,140,255,0.9)' },
  section: { marginBottom: '18px', padding: '14px', borderRadius: '12px', border: '1px solid rgba(127,127,127,0.22)' },
  sectionTitle: { margin: '0 0 10px', fontSize: '14px', fontWeight: 600, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '12px' },
  fieldLabel: { fontSize: '13px', fontWeight: 500 },
  fieldDescription: { fontSize: '12px', opacity: 0.65, margin: 0 },
  input: {
    padding: '7px 10px', borderRadius: '7px', fontSize: '13px', border: '1px solid rgba(127,127,127,0.35)',
    background: 'rgba(127,127,127,0.08)', color: 'inherit', maxWidth: '420px',
  },
  inputNarrow: { width: '140px' },
  checkbox: { width: '16px', height: '16px', accentColor: '#4f8cff' },
  actionsRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  notice: { fontSize: '12.5px', opacity: 0.8, margin: '6px 0 0', lineHeight: 1.5 },
  danger: { color: 'rgb(248,81,73)' },
  okText: { color: 'rgb(46,160,67)' },
  errorBox: {
    border: '1px solid rgba(248,81,73,0.5)', background: 'rgba(248,81,73,0.10)', borderRadius: '10px',
    padding: '10px 12px', fontSize: '12.5px', lineHeight: 1.5, margin: '10px 0',
  },
  empty: { padding: '28px 16px', textAlign: 'center', opacity: 0.7, fontSize: '13px' },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11.5px', opacity: 0.8 },
}

function badgeStyle(tone) {
  return tone === 'ok' ? { ...style.badge, ...style.badgeOk }
    : tone === 'warn' ? { ...style.badge, ...style.badgeWarn }
      : tone === 'danger' ? { ...style.badge, ...style.badgeDanger }
        : style.badge
}

function statusTone(status) {
  return status === 'failed' ? 'danger' : status === 'restart' ? 'warn' : status === 'disabled' || status === 'readonly' ? 'muted' : 'ok'
}

function statusLabel(status, t) {
  return status === 'failed' ? t('statusFailed')
    : status === 'restart' ? t('statusRestart')
      : status === 'readonly' ? t('statusReadonly')
      : status === 'disabled' ? t('statusDisabled')
        : status === 'pending' ? t('statusPending')
          : t('statusRunning')
}

/** Subscribe to one ConfigForm snapshot through React. */
function useConfigForm(form) {
  const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot())
  React.useEffect(() => {
    setSnapshot(form.getSnapshot())
    return form.subscribe(() => setSnapshot(form.getSnapshot()))
  }, [form])
  return snapshot
}

/** Read + write one configurable Host entry's live form. */
function ConfigEntryForm(props) {
  const { entry, t, store, writable } = props
  const ns = entry.ns ?? entry.entryId
  const view = store.namespace(ns)
  const form = React.useMemo(() => store.form(ns), [ns, store])
  const snapshot = useConfigForm(form)
  const fields = React.useMemo(() => schemaFields(view?.schema), [view])
  const [draft, setDraft] = React.useState(() => draftFromFields(fields, snapshot.value))
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState(undefined)
  React.useEffect(() => {
    setDraft(draftFromFields(fields, snapshot.value))
    setMessage(undefined)
  }, [fields, snapshot.value, snapshot.revision])
  const ops = buildConfigOps(fields, draft, snapshot.value)
  const canEdit = writable && snapshot.writable && snapshot.status === 'ready' && fields.length > 0
  const secrets = Array.isArray(view?.secrets) ? view.secrets.filter(secret => secret?.set === true) : []
  const update = (field, value) => setDraft(previous => ({ ...previous, [field.path.join('.')]: value }))
  const save = async () => {
    if (ops.length === 0 || saving) return
    setSaving(true)
    setMessage(undefined)
    try {
      const accepted = await form.mutate(ops, snapshot.revision)
      setMessage(accepted ? { tone: 'ok', text: t('saved') } : { tone: 'danger', text: t('saveFailed', { error: 'Host refused the write' }) })
    } catch (error) {
      setMessage({ tone: 'danger', text: t('saveFailed', { error: messageOf(error) }) })
    } finally {
      setSaving(false)
    }
  }
  const renderField = field => {
    if (field.kind === 'unsupported') {
      return panel('div', { key: field.path.join('.'), style: style.field },
        panel('span', { style: style.fieldLabel }, field.label),
        panel('span', { style: style.mono }, JSON.stringify(valueAt(view?.value, field.path) ?? null)))
    }
    if (field.kind === 'object') {
      return panel('fieldset', { key: field.path.join('.'), style: { border: '1px solid rgba(127,127,127,0.2)', borderRadius: '10px', padding: '12px', margin: '0 0 12px' } },
        panel('legend', { style: { fontSize: '12.5px', opacity: 0.75, padding: '0 6px' } }, field.label),
        (field.children ?? []).map(renderField))
    }
    const key = field.path.join('.')
    const value = draft[key]
    let control
    if (field.kind === 'boolean') {
      control = panel('label', { style: { ...style.actionsRow, cursor: canEdit ? 'pointer' : 'default' } },
        panel('input', { type: 'checkbox', checked: value === true, disabled: !canEdit, style: style.checkbox, onChange: event => update(field, event.target.checked) }),
        panel('span', { style: { fontSize: '12.5px', opacity: 0.7 } }, value === true ? 'true' : 'false'))
    } else if (field.kind === 'enum') {
      control = panel('select', {
        value: value ?? '', disabled: !canEdit, style: style.input,
        onChange: event => update(field, event.target.value),
      }, panel('option', { value: '' }, '—'), (field.options ?? []).map(option => panel('option', { key: String(option), value: String(option) }, String(option))))
    } else if (field.kind === 'secret') {
      control = panel('span', { style: style.notice }, t('secretsNote'))
    } else {
      control = panel('input', {
        type: field.kind === 'number' ? 'number' : 'text',
        value: value ?? '', disabled: !canEdit,
        ...(field.kind === 'number' ? { min: field.min, max: field.max, step: field.step } : {}),
        style: { ...style.input, ...(field.kind === 'number' ? style.inputNarrow : {}) },
        onChange: event => update(field, event.target.value),
      })
    }
    return panel('div', { key, style: style.field },
      panel('span', { style: style.fieldLabel }, field.label, field.required === true ? panel('span', { style: style.danger }, ' *') : null),
      field.description === undefined ? null : panel('p', { style: style.fieldDescription }, field.description),
      control)
  }
  if (view === undefined) return panel('p', { style: style.notice }, t('noConfig'))
  if (fields.length === 0) return panel('p', { style: style.notice }, t('noSchema'))
  return panel('div', null,
    panel('div', { style: style.sectionTitle }, entry.title, panel('code', { style: style.code }, entry.entryId ?? '')),
    writable ? null : panel('p', { style: style.notice }, t('readonly')),
    secrets.length > 0 ? panel('p', { style: style.notice }, t('secretsNote')) : null,
    panel('div', null, fields.map(renderField)),
    panel('div', { style: style.actionsRow },
      panel('button', { type: 'button', style: { ...style.buttonPrimary, ...(ops.length === 0 || saving || !canEdit ? style.buttonDisabled : {}) }, disabled: ops.length === 0 || saving || !canEdit, onClick: save }, saving ? t('saving') : t('save')),
      panel('button', { type: 'button', style: { ...style.button, ...(ops.length === 0 || saving ? style.buttonDisabled : {}) }, disabled: ops.length === 0 || saving, onClick: () => setDraft(draftFromFields(fields, snapshot.value)) }, t('reset')),
      message === undefined ? null : panel('span', { style: message.tone === 'ok' ? style.okText : style.danger }, message.text)),
  )
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Badge row for one card. */
function CardBadges(props) {
  const { card, t } = props
  const status = cardStatus(card)
  return panel('div', { style: style.metaRow },
    panel('span', { style: badgeStyle(statusTone(status)) }, statusLabel(status, t)),
    card.version === undefined ? null : panel('span', { style: style.mono }, `v${String(card.version)}`),
    card.configurable > 0 ? panel('span', { style: badgeStyle('ok') }, t('configurable', { count: String(card.configurable) })) : null,
    card.official ? panel('span', { style: badgeStyle('ok') }, 'official') : null,
    card.error === undefined ? null : panel('span', { style: badgeStyle('danger') }, t('error')))
}

function PluginCard(props) {
  const { card, t, onOpen } = props
  return panel('li', null,
    panel('button', { type: 'button', style: style.card, onClick: () => onOpen(card.key), 'data-console-card': card.key, ...(card.configurable > 0 ? { 'data-console-configurable': '' } : {}), ...(card.isNew === true ? { 'data-console-new': '' } : {}) },
      panel('div', { style: style.cardTitleRow },
        panel('span', { style: style.cardTitle }, card.title),
        card.title === card.packageName ? null : panel('span', { style: style.mono }, card.kind === 'bundle' ? card.packageName : (card.entryId ?? card.packageName)),
        card.isNew === true ? panel('span', { style: style.newBadge, 'data-console-new-badge': '' }, t('newBadge')) : null),
      card.description === undefined ? null : panel('p', { style: style.desc }, card.description),
      panel(CardBadges, { card, t }),
      card.rows.length > 0 ? panel('span', { style: style.mono }, `${card.rows.length} rows · ${card.rows.filter(row => row.fiberPhase === 'failed').length} failed`) : null))
}

function StatusTab(props) {
  const { card, t, store } = props
  const rows = card.rows
  return panel('div', null,
    panel('div', { style: style.section },
      panel('h3', { style: style.sectionTitle }, t('tabStatus')),
      panel('div', { style: style.metaRow },
        panel('span', { style: style.mono }, `${t('enabled')}: ${card.enabled === false ? 'false' : 'true'}`),
        panel('span', { style: style.mono }, `${t('fiber')}: ${card.fiberPhase ?? t('unmounted')}`)),
      card.error === undefined ? null : panel('p', { style: style.danger }, `${t('error')}: ${card.error}`),
      card.readOnlyReason === undefined ? null : panel('p', { style: style.notice }, `${t('readOnlyReason')}: ${card.readOnlyReason}`)),
    rows.length === 0 ? null : panel('div', { style: style.section },
      panel('h3', { style: style.sectionTitle }, t('aboutRows')),
      rows.map(row => panel('div', { key: row.rowId, style: { ...style.metaRow, padding: '5px 0', borderBottom: '1px solid rgba(127,127,127,0.14)' } },
        panel('code', { style: style.code }, row.rowId),
        panel('span', { style: style.mono }, row.moduleName),
        panel('span', { style: badgeStyle(statusTone(row.fiberPhase === 'failed' ? 'failed' : row.enabled === false ? 'disabled' : 'running')) }, row.fiberPhase === 'failed' ? t('statusFailed') : row.enabled === false ? t('statusDisabled') : t('statusRunning')),
        row.configurable ? panel('span', { style: badgeStyle('ok') }, t('tabConfig')) : null))),
  )
}

function PluginExtensions(props) {
  const { card, t, store } = props
  const subject = store.subject(card)
  const registered = store.contributions.matching(subject)
  if (registered.length === 0) {
    return panel('div', { style: style.section },
      panel('h3', { style: style.sectionTitle }, t('tabExtensions')),
      panel('p', { style: style.notice }, t('noExtensions')))
  }
  return panel('div', { style: style.section },
    panel('h3', { style: style.sectionTitle }, t('tabExtensions')),
    registered.map(contribution => {
      const node = store.contributions.render(contribution, subject, { t, store, card })
      if (node !== null && typeof node === 'object' && 'error' in node) {
        return panel('p', { key: contribution.id, style: style.danger }, t('contributionFailed', { error: messageOf(node.error) }))
      }
      return panel('div', { key: contribution.id, style: { marginBottom: '12px' } },
        contribution.title === undefined ? null : panel('h4', { style: { margin: '0 0 6px', fontSize: '13px' } }, contribution.title),
        node)
    }))
}

function AboutTab(props) {
  const { card, t, store } = props
  const view = card.rows.length > 0 && card.rows[0].configNs !== undefined ? store.namespace(card.rows[0].configNs) : (card.kind === 'entry' && card.configNs !== undefined ? store.namespace(card.configNs) : undefined)
  return panel('div', { style: style.section },
    panel('h3', { style: style.sectionTitle }, t('tabAbout')),
    panel('p', { style: style.mono }, `${t('aboutPackage')}: ${card.packageName}`),
    card.entryId === undefined ? null : panel('p', { style: style.mono }, `${t('aboutModule')}: ${card.entryId}`),
    view === undefined ? null : panel('p', { style: style.mono }, `${t('aboutConfigNs')}: ${view.ns}`),
    card.rows.length === 0 ? null : panel('div', { style: { marginTop: '8px' } },
      card.rows.map(row => panel('p', { key: row.rowId, style: style.mono }, `${row.rowId} · ${row.moduleName}${row.entryId === undefined ? '' : ` · ${row.entryId}`}`))))
}

function DetailView(props) {
  const { card, t, store, writable, onBack, onOpenManager } = props
  const [tab, setTab] = React.useState('config')
  if (card === undefined) return panel('div', { style: style.empty }, t('empty'))
  const configuredEntries = card.rows.filter(row => row.configurable).map(row => ({ rowId: row.rowId, entryId: row.entryId, ns: row.configNs, title: row.title }))
  if (card.kind === 'entry' && card.configurable && card.entryId !== undefined) configuredEntries.push({ rowId: card.entryId, entryId: card.entryId, ns: card.configNs, title: card.title })
  return panel('div', { 'data-console-detail': card.key },
    panel('div', { style: style.detailTop },
      panel('button', { type: 'button', style: style.button, onClick: onBack }, `← ${t('back')}`),
      panel('h2', { style: { ...style.title, flex: '1 1 auto' } }, card.title),
      panel('button', { type: 'button', style: style.button, onClick: onOpenManager }, t('openManager'))),
    panel('p', { style: style.mono }, card.kind === 'bundle' ? card.packageName : (card.entryId ?? card.packageName)),
    panel(CardBadges, { card, t }),
    panel('div', { style: style.tabs, className: TABS_CLASS },
      [['config', t('tabConfig')], ['status', t('tabStatus')], ['extensions', t('tabExtensions')], ['about', t('tabAbout')]].map(([id, label]) =>
        panel('button', {
          key: id,
          type: 'button',
          title: label,
          'aria-label': label,
          // Mouse clicks must not leave the button focused (the browser's focus
          // ring would linger beside the active underline); keyboard Tab still
          // focuses it, and the injected :focus-visible rule draws that ring.
          onMouseDown: event => event.preventDefault(),
          style: tab === id ? { ...style.tab, ...style.tabActive } : style.tab,
          className: TAB_CLASS,
          'data-console-detail-tab': id,
          'data-active': tab === id ? 'true' : 'false',
          'aria-selected': tab === id ? 'true' : 'false',
          onClick: () => setTab(id),
        }, label))),
    tab === 'config' ? panel('div', { 'data-console-tab': 'config' },
      writable ? null : panel('p', { style: style.notice }, t('readonly')),
      configuredEntries.length === 0 ? panel('p', { style: style.notice }, t('noConfig'))
        : configuredEntries.map(entry => panel(ConfigEntryForm, { key: entry.entryId, entry, t, store, writable }))) : null,
    tab === 'status' ? panel('div', { 'data-console-tab': 'status' }, panel(StatusTab, { card, t, store })) : null,
    tab === 'extensions' ? panel('div', { 'data-console-tab': 'extensions' }, panel(PluginExtensions, { card, t, store })) : null,
    tab === 'about' ? panel('div', { 'data-console-tab': 'about' }, panel(AboutTab, { card, t, store })) : null,
  )
}

const GROUP_TITLE_KEYS = { enabled: 'groupEnabled', disabled: 'groupDisabled', optional: 'groupOptional' }

/** Page numbers with first/last/current neighbours and an ellipsis gap. */
function Pager(props) {
  const { t, page, pageCount, pageSize, total, onPage, onPageSize } = props
  const tokens = []
  for (let index = 1; index <= pageCount; index += 1) {
    const near = index === 1 || index === pageCount || Math.abs(index - page) <= 1
    if (near) tokens.push(index)
    else if (tokens[tokens.length - 1] !== '…') tokens.push('…')
  }
  return panel('div', { style: style.pager, 'data-console-pager': '', 'data-console-page-count': String(pageCount) },
    panel('span', { style: style.mono }, t('pageInfo', { page: String(page), count: String(pageCount), total: String(total) })),
    panel('span', { style: style.pagerSpacer }),
    panel('button', { type: 'button', style: page <= 1 ? { ...style.button, ...style.buttonDisabled } : style.button, disabled: page <= 1, onClick: () => onPage(page - 1), 'data-console-page-prev': '' }, t('pagePrev')),
    tokens.map((token, index) => token === '…'
      ? panel('span', { key: `gap${index}`, style: style.mono }, t('pageGap'))
      : panel('button', { key: `p${token}`, type: 'button', style: token === page ? { ...style.chip, ...style.chipActive } : style.chip, onClick: () => onPage(token), 'data-console-page-number': String(token) }, String(token))),
    panel('button', { type: 'button', style: page >= pageCount ? { ...style.button, ...style.buttonDisabled } : style.button, disabled: page >= pageCount, onClick: () => onPage(page + 1), 'data-console-page-next': '' }, t('pageNext')),
    panel('label', { style: { ...style.metaRow, marginLeft: '8px' } }, t('pageSizeLabel'),
      panel('select', { value: String(pageSize), style: { ...style.input, ...style.inputNarrow }, onChange: event => onPageSize(Number(event.target.value)), 'data-console-page-size': '' },
        PAGE_SIZES.map(size => panel('option', { key: size, value: String(size) }, String(size))))))
}

function ConsolePage(props) {
  const { t, useConsole, store, contributions, openManager } = props
  const state = useConsole(snapshot => snapshot)
  const pageRoot = React.useRef(null)
  const pendingScroll = React.useRef(undefined)
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const model = state.model
  const filtered = model === undefined ? undefined : filterCards(model, query, filter)
  const paged = filtered === undefined ? undefined : paginateCards(filtered, page, pageSize)
  const pageCount = paged === undefined ? 1 : paged.pageCount
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])
  React.useLayoutEffect(() => {
    const top = pendingScroll.current
    if (top === undefined) return
    pendingScroll.current = undefined
    if (pageRoot.current !== null) pageRoot.current.scrollTop = top
  }, [page, pageSize, filter, query])
  const scrollTop = () => (pageRoot.current === null ? 0 : pageRoot.current.scrollTop)
  const changePage = next => {
    pendingScroll.current = scrollTop()
    setPage(Math.min(Math.max(1, next), pageCount))
  }
  const changeQuery = value => {
    pendingScroll.current = 0
    setQuery(value)
    setPage(1)
  }
  const changeFilter = id => {
    pendingScroll.current = 0
    setFilter(id)
    setPage(1)
  }
  const changePageSize = size => {
    pendingScroll.current = 0
    setPageSize(size)
    setPage(1)
  }
  const refresh = () => { void store.refresh({ clearCache: true }) }
  if (model === undefined && state.status !== 'ready') {
    if (state.status === 'error') {
      return panel('div', { style: style.page },
        panel('div', { style: style.errorBox }, t('loadFailed', { error: state.error ?? 'unknown' })),
        panel('button', { type: 'button', style: style.buttonPrimary, onClick: refresh }, t('retry')))
    }
    return panel('div', { style: style.page }, panel('p', { style: style.empty }, t('loading')))
  }
  if (model === undefined) return panel('div', { style: style.page }, panel('p', { style: style.empty }, t('empty')))
  const selected = state.detailKey === undefined ? undefined : findCard(model, state.detailKey)
  const cacheBadge = state.fromCache === true
    ? panel('span', { style: { ...style.badge, ...style.badgeWarn } }, state.status === 'refreshing' ? t('cacheRefreshing') : t('cacheView'))
    : null
  return panel('div', { ref: pageRoot, style: style.page, 'data-console-page': PANEL_ID, 'data-console-cache': state.fromCache === true ? 'cache' : 'live' },
    panel('div', { style: style.headerRow },
      panel('div', { style: style.grow },
        panel('h1', { style: style.title }, t('title')),
        panel('p', { style: style.subtitle }, t('subtitle')),
        panel('p', { style: { ...style.notice, marginTop: '8px' } },
          t('stats', { total: String(model.stats.total), new: String(model.stats.new), configurable: String(model.stats.configurable) }),
          cacheBadge === null ? null : ' ',
          cacheBadge)),
      panel('div', { style: style.actionsRow },
        panel('button', { type: 'button', style: style.button, disabled: state.status === 'refreshing', onClick: refresh }, state.status === 'refreshing' ? '…' : t('refresh')),
        panel('button', { type: 'button', style: style.buttonPrimary, onClick: openManager }, t('openManager')))),
    state.status === 'error' ? panel('div', { style: style.errorBox }, t('refreshFailed', { error: state.error ?? 'unknown' })) : null,
    selected === undefined ? panel('div', null,
      panel('div', { style: style.toolbar },
        panel('input', { type: 'search', value: query, placeholder: t('searchPlaceholder'), style: style.search, onChange: event => changeQuery(event.target.value), 'aria-label': t('searchPlaceholder') }),
        [['all', t('filterAll')], ['configurable', t('filterConfigurable')], ['disabled', t('filterDisabled')]].map(([id, label]) =>
          panel('button', { key: id, type: 'button', style: filter === id ? { ...style.chip, ...style.chipActive } : style.chip, onClick: () => changeFilter(id) }, label))),
      paged.total === 0
        ? panel('div', { style: style.empty }, t('empty'))
        : panel('div', null,
          paged.groups.map(slice => panel('section', { key: slice.id, 'data-console-group': slice.id },
            panel('h2', { style: style.groupTitle }, t(GROUP_TITLE_KEYS[slice.id])),
            panel('ul', { style: style.cards }, slice.cards.map(card => panel(PluginCard, { key: card.key, card, t, onOpen: store.select }))))),
          panel(Pager, { t, page: paged.page, pageCount: paged.pageCount, pageSize: paged.pageSize, total: paged.total, from: paged.from, to: paged.to, onPage: changePage, onPageSize: changePageSize })))
      : panel(DetailView, { card: selected, t, store, writable: model.writable, onBack: () => store.select(undefined), onOpenManager: () => openManager(selected) }),
  )
}

function ConsoleIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 18
  return panel('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': 'true' },
    panel('path', { d: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3' }),
    panel('circle', { cx: 15.5, cy: 7, r: 2.1 }),
    panel('circle', { cx: 9.5, cy: 12, r: 2.1 }),
    panel('circle', { cx: 15.5, cy: 17, r: 2.1 }))
}

const CACHE_KEY = 'dsh.plugin-console.cache.v1'
const KNOWN_KEY = 'dsh.plugin-console.known.v1'

function readJsonStorage(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch { return undefined }
}

function writeJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch { return false }
}

function removeStorage(key) {
  try { window.localStorage.removeItem(key) } catch { /* storage unavailable */ }
}

/**
 * One console store: cache-first first paint, two Host reads, the live settings
 * mirror, and the NEW-badge baseline persisted across visits.
 */
class ConsoleStore {
  constructor(ctx) {
    this.ctx = ctx
    this.snapshot = createSnapshotStore({ status: 'idle', error: undefined, model: undefined, detailKey: undefined, fromCache: false })
    this.inFlight = undefined
    this.generation = 0
    this.inventory = undefined
    this.bundles = []
    this.servedNamespaces = []
    this.writable = false
    this.networkLoaded = false
    this.cachedAt = undefined
    this.pendingNewReset = false
    this.sessionNew = undefined
    this.knownKeys = this.readKnown()
    const cached = parseConsoleCache(readJsonStorage(CACHE_KEY))
    if (cached.ok) {
      this.inventory = cached.cache.inventory
      this.bundles = cached.cache.bundles
      this.servedNamespaces = cached.cache.namespaces
      this.writable = cached.cache.writable
      this.cachedAt = cached.cache.savedAt
      this.publish({ fromCache: true, status: 'refreshing' })
    }
  }
  readKnown() {
    const stored = readJsonStorage(KNOWN_KEY)
    if (stored === null || typeof stored !== 'object' || !Array.isArray(stored.keys)) return undefined
    return stored.keys.filter(key => typeof key === 'string')
  }
  persistKnown(keys) {
    writeJsonStorage(KNOWN_KEY, { keys, savedAt: Date.now() })
  }
  clearCache() {
    removeStorage(CACHE_KEY)
  }
  get hooks() { return { getSnapshot: () => this.snapshot.getSnapshot(), subscribe: this.snapshot.subscribe } }
  refresh = (options = {}) => {
    if (options.clearCache === true) {
      this.clearCache()
      this.pendingNewReset = true
    }
    if (this.inFlight !== undefined) return this.inFlight
    this.snapshot.set({ ...this.snapshot.getSnapshot(), status: 'refreshing', error: undefined })
    const generation = ++this.generation
    const run = Promise.resolve().then(async () => {
      try {
        const inventory = await this.ctx.remote.pluginInventory.list()
        if (!inventory.ok) throw new Error(inventory.error.message)
        const bundles = await this.ctx.remote.pluginManager.listBundles()
        if (!bundles.ok) throw new Error(bundles.error.message)
        if (generation !== this.generation) return
        this.inventory = inventory.value
        this.bundles = bundles.value
        this.networkLoaded = true
        this.publish({ status: 'ready', computeNew: true })
      } catch (error) {
        if (generation !== this.generation) return
        this.snapshot.set({ ...this.snapshot.getSnapshot(), status: 'error', error: messageOf(error) })
      } finally {
        this.inFlight = undefined
      }
    })
    this.inFlight = run
    return run
  }
  syncSettings = () => {
    if (this.inventory !== undefined) this.publish()
  }
  publish = (options = {}) => {
    const view = this.ctx.configForms.describe().getSnapshot().view
    if (view !== undefined) {
      this.servedNamespaces = view.namespaces
      this.writable = view.writable === true
    }
    const previous = this.snapshot.getSnapshot()
    const base = {
      inventory: this.inventory,
      bundles: this.bundles,
      namespaces: this.servedNamespaces,
      writable: this.writable,
      status: 'ready',
      fromCache: options.fromCache === true,
      cachedAt: this.cachedAt,
    }
    const currentKeys = buildConsoleModel(base).cards.map(card => card.key)
    if (options.computeNew === true) {
      const resetNew = options.resetNew === true || this.pendingNewReset === true
      this.pendingNewReset = false
      const merged = mergeNewKeys(currentKeys, this.knownKeys, this.sessionNew, resetNew)
      this.sessionNew = merged.newKeys
      this.knownKeys = merged.knownKeys
      this.persistKnown(merged.knownKeys)
    } else if (this.sessionNew === undefined) {
      this.sessionNew = diffNewKeys(currentKeys, this.knownKeys)
    }
    const newKeys = (this.sessionNew ?? []).filter(key => currentKeys.includes(key))
    const model = newKeys.length === 0 ? buildConsoleModel(base) : buildConsoleModel({ ...base, newKeys })
    if (this.networkLoaded === true && view !== undefined) {
      writeJsonStorage(CACHE_KEY, serializeConsoleCache({
        inventory: this.inventory,
        bundles: this.bundles,
        namespaces: view.namespaces,
        writable: view.writable === true,
      }))
    }
    const refreshing = options.status === 'refreshing' || this.snapshot.getSnapshot().status === 'refreshing'
    this.snapshot.set({
      status: refreshing ? 'refreshing' : 'ready',
      error: undefined,
      model,
      detailKey: previous.detailKey,
      writable: model.writable,
      fromCache: options.fromCache === true,
      cachedAt: this.cachedAt,
    })
  }
  select = key => { this.snapshot.set({ ...this.snapshot.getSnapshot(), detailKey: key }) }
  namespaces = () => {
    const view = this.ctx.configForms.describe().getSnapshot().view
    return view === undefined ? this.servedNamespaces : view.namespaces
  }
  namespace = entryId => {
    if (entryId === undefined) return undefined
    const namespaces = this.namespaces()
    return namespaces.find(namespaceView => namespaceView.ns === entryId) ?? namespaceOf(namespaces, entryId)
  }
  form = entryId => this.ctx.configForms.get(entryId)
  subject = card => ({
    key: card.key,
    kind: card.kind,
    packageName: card.packageName,
    entryId: card.entryId,
    rows: card.rows.map(row => row.entryId).filter(id => id !== undefined),
  })
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'plugin-console: dictionaries')
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    const existing = document.querySelector('style[data-plugin="plugin-console-tabs"]')
    if (existing !== null) return () => existing.remove()
    const styleElement = document.createElement('style')
    styleElement.dataset.plugin = 'plugin-console-tabs'
    styleElement.textContent = TAB_CSS
    document.head.appendChild(styleElement)
    return () => styleElement.remove()
  }, 'plugin-console: tab styles')
  const t = ctx.locale.bind(LOCALE_NS)
  const store = new ConsoleStore(ctx)
  ctx.effect(() => () => {
    store.generation += 1
    try { store.snapshot.set({ status: 'idle', error: undefined, model: undefined, detailKey: undefined }) } catch { /* disposed */ }
  }, 'plugin-console: store')
  const contributions = createContributionRegistry(error => {
    try { console.error('[plugin-console] contribution failed', error) } catch { /* no console */ }
  })
  ctx.provide('pluginConsoleContributions', contributions)
  store.contributions = contributions
  store.renderSlot = undefined
  const openManager = card => {
    const navigation = ctx.get('pluginNavigation')
    if (navigation !== undefined) {
      if (card !== undefined && card.kind === 'bundle' && typeof navigation.openBundle === 'function') navigation.openBundle(card.packageName)
      else if (typeof navigation.openList === 'function') navigation.openList()
      return
    }
    try { ctx.layout.selectPanel('plugins') } catch (error) { console.error('[plugin-console] cannot open plugin manager', error) }
  }
  ctx.remoteAccess.whenAccess('pluginManager/listBundles', function* () {
    const describe = ctx.configForms.describe()
    yield describe.subscribe(() => store.syncSettings())
    void describe.ensure()
    void store.refresh()
    yield ctx.remote.$on('plugin-manager/changed', () => { void store.refresh({ clearCache: true }) })
    yield ctx.on('connection/reset', () => { void store.refresh({ clearCache: true }) })
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 1,
      locale: LOCALE_NS,
      label: () => t('panel'),
    }, ConsoleIcon))
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: LOCALE_NS,
      inject: () => ({
        hooks: { console: store.hooks },
        store,
        contributions,
        openManager: () => openManager(undefined),
      }),
    }, ConsolePage))
  })
}

exports.apply = apply
exports.inject = inject


		return module.exports;
	}
});
//# sourceURL=dsh-plugin-console/client.js
