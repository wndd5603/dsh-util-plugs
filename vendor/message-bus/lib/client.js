window.__ModuleLoader__.load({
	id: "dsh-message-bus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

/**
 * Pure client-domain helpers for the DSH message center (task-95).
 * Inlined into lib/client.js by scripts/build-client.mjs; also unit-tested.
 */

/** Locale namespace owned by the client half. */
const LOCALE_NS = 'messageBusClient'
const REMOTE_NAMESPACE = 'messageBus'
const REMOTE_SERVICE = 'messageBusRemote'
const PAGE_SIZES = [10, 20, 50]
const DEFAULT_PAGE_SIZE = 20
const DELETE_CONFIRM_WORD = 'DELETE'

/** One strict identity codec: the Host revalidates with its own descriptor. */
function identityCodec(typeSymbol) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse: value => value }) }
}

/** JSON parameter descriptor for one named wire argument. */
function jsonParameter(name) {
  return { name, wire: name, source: 'json', codec: identityCodec(`dsh-message-bus#${name}:json`) }
}

/** Generated-contribution shape for the five message-center endpoints. */
function createRemoteContribution() {
  return {
    package: 'dsh-message-bus',
    descriptors: [
      {
        id: 'dsh-message-bus/messageBus/list',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'list',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query'), jsonParameter('limit'), jsonParameter('offset'), jsonParameter('readBy')],
        result: identityCodec('dsh-message-bus#messageBus/list:result'),
        description: 'Paginated message list/search; read-only except the optional readBy join.',
      },
      {
        id: 'dsh-message-bus/messageBus/search',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'search',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('keyword'), jsonParameter('limit'), jsonParameter('offset'), jsonParameter('readBy')],
        result: identityCodec('dsh-message-bus#messageBus/search:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/get',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'get',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('messageId'), jsonParameter('readBy'), jsonParameter('markRead')],
        result: identityCodec('dsh-message-bus#messageBus/get:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/delete',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'delete',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('messageId'), jsonParameter('confirm')],
        result: identityCodec('dsh-message-bus#messageBus/delete:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/send',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'send',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('to'), jsonParameter('subject'), jsonParameter('body'), jsonParameter('from')],
        result: identityCodec('dsh-message-bus#messageBus/send:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/tasksPage',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'tasksPage',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/tasksPage:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/memoryPage',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'memoryPage',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/memoryPage:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/memoryForget',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'memoryForget',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/memoryForget:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/meetingsPage',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'meetingsPage',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/meetingsPage:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/meetingDetail',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'meetingDetail',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/meetingDetail:result'),
      },
    ],
  }
}

/** Error text from a failed RemoteResult, without exposing internals. */
function remoteErrorText(result) {
  const error = result?.error
  if (error === null || typeof error !== 'object') return 'unknown error'
  if (typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error.code === 'string' && error.code !== '') return error.code
  return 'unknown error'
}

/** Normalize one list/search RemoteResult into the page model. */
function normalizeListResult(result) {
  if (result?.ok !== true) return { ok: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  const items = Array.isArray(value.items) ? value.items.map(item => ({
    id: String(item?.id ?? ''),
    at: typeof item?.at === 'string' ? item.at : '',
    from: typeof item?.from === 'string' ? item.from : '',
    fromSession: typeof item?.fromSession === 'string' ? item.fromSession : null,
    to: typeof item?.to === 'string' ? item.to : '',
    subject: typeof item?.subject === 'string' ? item.subject : '',
    snippet: typeof item?.snippet === 'string' ? item.snippet : '',
    bytes: typeof item?.bytes === 'number' ? item.bytes : 0,
    priority: item?.priority === true,
    test: item?.test === true,
    readAt: typeof item?.readAt === 'string' ? item.readAt : null,
  })) : []
  return {
    ok: true,
    items,
    total: typeof value.total === 'number' ? value.total : items.length,
    limit: typeof value.limit === 'number' ? value.limit : DEFAULT_PAGE_SIZE,
    offset: typeof value.offset === 'number' ? value.offset : 0,
    readBy: typeof value.readBy === 'string' ? value.readBy : null,
    counts: value.counts !== null && typeof value.counts === 'object' ? value.counts : {},
    allowSend: value.capabilities?.send === true,
    strictMode: value.capabilities?.strictMode === true,
    autoResume: value.capabilities?.autoResume === true,
    network: value.network !== null && typeof value.network === 'object' ? value.network : undefined,
    apartment: value.apartment !== null && typeof value.apartment === 'object' ? value.apartment : undefined,
  }
}

/** Normalize one get RemoteResult. */
function normalizeGetResult(result) {
  if (result?.ok !== true) return { ok: false, gone: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  if (value.ok === false) return { ok: false, gone: value.gone === true, error: typeof value.error === 'string' ? value.error : 'message unavailable' }
  const item = value.item ?? {}
  return {
    ok: true,
    item: {
      id: String(item.id ?? ''),
      at: typeof item.at === 'string' ? item.at : '',
      from: typeof item.from === 'string' ? item.from : '',
      fromSession: typeof item.fromSession === 'string' ? item.fromSession : null,
      to: typeof item.to === 'string' ? item.to : '',
      subject: typeof item.subject === 'string' ? item.subject : '',
      body: typeof item.body === 'string' ? item.body : '',
      bytes: typeof item.bytes === 'number' ? item.bytes : 0,
      priority: item.priority === true,
      test: item.test === true,
      readAt: typeof item.readAt === 'string' ? item.readAt : (typeof value.readAt === 'string' ? value.readAt : null),
    },
  }
}

/** Normalize one delete RemoteResult. */
function normalizeDeleteResult(result) {
  if (result?.ok !== true) return { ok: false, gone: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  if (value.ok !== true) return { ok: false, gone: value.gone === true, error: typeof value.error === 'string' ? value.error : 'delete failed' }
  return { ok: true, deleted: value.deleted === true, messageId: String(value.messageId ?? '') }
}

/** Normalize one send RemoteResult. A non-live recipient is queued (still stored). */
function normalizeSendResult(result) {
  if (result?.ok !== true) return { ok: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  if (value.queued === true) {
    return {
      ok: true,
      queued: true,
      messageId: typeof value.messageId === 'string' ? value.messageId : '',
      duplicate: false,
      existingId: null,
    }
  }
  if (value.ok !== true && value.ok !== undefined) return { ok: false, error: typeof value.error === 'string' ? value.error : 'send failed' }
  return {
    ok: true,
    messageId: typeof value.messageId === 'string' ? value.messageId : '',
    duplicate: value.duplicate === true,
    queued: false,
    existingId: typeof value.existingId === 'string' ? value.existingId : null,
  }
}

/** Page count for a total/limit pair. */
function pageCount(total, limit) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(limit) || limit <= 0) return 1
  return Math.max(1, Math.ceil(total / limit))
}

/** Friendly local time; falls back to the raw string when unparsable. */
function formatTime(value) {
  if (typeof value !== 'string' || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/** Byte size label used by the list/detail meta row. */
function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Quote a message for pasting into a conversation (copy-only entry). */
function quoteMessage(item) {
  if (item === null || typeof item !== 'object') return ''
  const subject = typeof item.subject === 'string' && item.subject !== '' ? item.subject : '（无主题）'
  const from = typeof item.from === 'string' && item.from !== '' ? item.from : 'unknown'
  return '[消息 ' + String(item.id ?? '') + '] 来自 ' + from + ' 主题：' + subject + '\n\n' + String(item.body ?? '')
}

/** Whether a typed word unlocks the delete confirmation. */
function canDelete(typed) {
  return typed === DELETE_CONFIRM_WORD
}


/**
 * Browser half of the DSH message center (task-95): a sidebar entry plus a main
 * panel listing bus messages with keyword search, pagination, detail, copy,
 * optional send and a custom delete confirmation.
 *
 * `client-src/core.js` is inlined above this file by scripts/build-client.mjs;
 * React is the only external dependency of the module-loader factory.
 */

const zh = {
  panel: '协作网络',
  title: '智能体协作网络',
  subtitle: '公告栏/任务板、智能体公寓与跨会话消息统一入口。',
  networkTitle: '公告栏 / 任务板',
  networkSubtitle: '共享任务、依赖与状态；点击状态可快速定位当前工作。',
  networkLive: 'LIVE',
  boardsLabel: '公告栏',
  tasksLabel: '任务',
  allTasks: '全部',
  noTasks: '这个公告栏还没有任务。',
  boardTasks: '任务列表',
  taskDetail: '任务详情',
  closeTask: '收起',
  assignee: '负责人',
  dependencies: '依赖',
  related: '关联',
  priorityLabel: '优先级',
  blockedReason: '阻塞原因',
  taskSearch: '搜索任务（id / 标题 / 负责人 / 依赖）',
  pageInfo: '第 {page} / {pages} 页 · 共 {total} 项',
  pageSizeLabel: '每页',
  prevPage: '上一页',
  nextPage: '下一页',
  networkEmpty: '暂无公告栏。让 Agent 调用 bulletin_board_create 创建。',
  apartmentTitle: '智能体公寓 / 存储',
  apartmentSubtitle: '集中管理 Agent 主目录、租约、备份与根目录迁移。',
  apartmentStats: 'STORAGE',
  apartmentRootPlaceholder: '/path/to/apartment（当前根目录）',
  apartmentSaveRoot: '保存目录',
  apartmentMigrate: '迁移到此目录',
  apartmentBackup: '立即备份',
  apartmentRestore: '从目录恢复',
  apartmentVerify: '验证',
  memoryTitle: '智能体记忆库',
  memorySubtitle: '查询、分页和管理跨会话持久记忆。',
  memorySearch: '搜索记忆（内容 / key / tag）',
  memoryEmpty: '暂无记忆。',
  memoryDelete: '删除',
  memoryConfirmDelete: '确认删除',
  memoryCancel: '取消',
  memoryDeleted: '记忆已删除。',
  memoryExpand: '展开详情',
  memoryCollapse: '收起详情',
  memoryFailed: '记忆操作失败：{error}',
  memoryTotal: '共 {total} 条',
  memoryScopeAll: '全部 scope',
  meetingsTitle: '会议',
  meetingsSubtitle: '多轮会议记录、参与者和行动项；由 meeting_* 工具创建与推进。',
  meetingsSearch: '搜索会议（id / 标题 / 召集人）',
  meetingsEmpty: '暂无会议。',
  meetingParticipants: '参与者',
  meetingMessages: '消息',
  meetingStatus: '状态',
  working: '处理中…',
  stats: '共 {total} 条消息 · 已加载 {shown} 条',
  refresh: '刷新',
  loading: '正在加载消息…',
  loadFailed: '加载失败：{error}',
  searchPlaceholder: '关键词搜索（主题 / 正文 / 发送者 / id）',
  search: '搜索',
  clear: '清除',
  empty: '没有匹配的消息。',
  readByLabel: '读取回执会话（可选）',
  readByPlaceholder: 'session id，用于标记已读',
  allMessages: '全部消息',
  readAt: '已读：{time}',
  unread: '未读',
  detailTitle: '消息详情',
  close: '关闭',
  from: '发送者',
  to: '接收者',
  subject: '主题',
  body: '正文',
  noSubject: '（无主题）',
  copyBody: '复制正文',
  copyQuote: '复制为对话引用',
  copied: '已复制到剪贴板。',
  copyFailed: '复制失败，请手动选择正文。',
  delete: '删除',
  deleteTitle: '确认删除这条消息？',
  deleteHint: '删除会移除该消息及其投递/已读记录，不能撤销。请输入 {word} 确认。',
  deleteConfirm: '确认删除',
  cancel: '取消',
  deleting: '删除中…',
  deleted: '消息已删除。',
  deleteFailed: '删除失败：{error}',
  send: '发送新消息',
  sendTitle: '发送新消息',
  sendTo: '接收者（session id 或别名）',
  sendSubject: '主题（可选）',
  sendBody: '正文',
  sendSubmit: '发送',
  sending: '发送中…',
  sendSuccess: '已发送：{id}',
  sendDuplicate: '消息已存在（去重）：{id}',
  sendFailed: '发送失败：{error}',
  sendDisabled: '当前配置禁用了 Web 发送。',
  strictModeOn: '严格模式：开（直接 session-id 需审批）',
  strictModeOff: '严格模式：关',
  prev: '上一页',
  next: '下一页',
  page: '第 {page} / {pages} 页',
  priority: '优先',
  test: '测试',
  prevPage: '上一页',
  nextPage: '下一页',
}

const en = {
  panel: 'Agent Hub',
  title: 'Agent Collaboration Network',
  subtitle: 'One surface for boards/tasks, apartment storage and cross-session messages.',
  networkTitle: 'Bulletin board / task board',
  networkSubtitle: 'Shared tasks, dependencies and state; status pills show where work stands.',
  networkLive: 'LIVE',
  boardsLabel: 'Boards',
  tasksLabel: 'Tasks',
  allTasks: 'All',
  noTasks: 'No tasks on this board yet.',
  boardTasks: 'Tasks',
  taskDetail: 'Task detail',
  closeTask: 'Collapse',
  assignee: 'Assignee',
  dependencies: 'Depends on',
  related: 'Related',
  priorityLabel: 'Priority',
  blockedReason: 'Blocked reason',
  taskSearch: 'Search tasks (id / title / assignee / dependency)',
  pageInfo: 'Page {page} / {pages} · {total} items',
  pageSizeLabel: 'Per page',
  prevPage: 'Previous',
  nextPage: 'Next',
  networkEmpty: 'No boards yet. Ask an Agent to call bulletin_board_create.',
  apartmentTitle: 'Agent Apartment / storage',
  apartmentSubtitle: 'Central agent homes, leases, backups and root migration.',
  apartmentStats: 'STORAGE',
  apartmentRootPlaceholder: '/path/to/apartment (current root)',
  apartmentSaveRoot: 'Save root',
  apartmentMigrate: 'Migrate here',
  apartmentBackup: 'Backup now',
  apartmentRestore: 'Restore from dir',
  apartmentVerify: 'Verify',
  memoryTitle: 'Agent memory',
  memorySubtitle: 'Search, page and manage durable cross-session memory.',
  memorySearch: 'Search memory (content / key / tag)',
  memoryEmpty: 'No memories yet.',
  memoryDelete: 'Delete',
  memoryConfirmDelete: 'Confirm delete',
  memoryCancel: 'Cancel',
  memoryDeleted: 'Memory deleted.',
  memoryExpand: 'Show details',
  memoryCollapse: 'Hide details',
  memoryFailed: 'Memory operation failed: {error}',
  memoryTotal: '{total} entries',
  memoryScopeAll: 'All scopes',
  meetingsTitle: 'Meetings',
  meetingsSubtitle: 'Multi-round meetings, participants and action items; use meeting_* tools to create/advance.',
  meetingsSearch: 'Search meetings (id / title / convener)',
  meetingsEmpty: 'No meetings yet.',
  meetingParticipants: 'Participants',
  meetingMessages: 'Messages',
  meetingStatus: 'Status',
  working: 'Working…',
  stats: '{total} messages · {shown} shown',
  refresh: 'Refresh',
  loading: 'Loading messages…',
  loadFailed: 'Load failed: {error}',
  searchPlaceholder: 'Search subject / body / sender / id',
  search: 'Search',
  clear: 'Clear',
  empty: 'No matching messages.',
  readByLabel: 'Read-receipt session (optional)',
  readByPlaceholder: 'session id to mark read',
  allMessages: 'All messages',
  readAt: 'Read at {time}',
  unread: 'Unread',
  detailTitle: 'Message detail',
  close: 'Close',
  from: 'From',
  to: 'To',
  subject: 'Subject',
  body: 'Body',
  noSubject: '(no subject)',
  copyBody: 'Copy body',
  copyQuote: 'Copy as conversation quote',
  copied: 'Copied to clipboard.',
  copyFailed: 'Copy failed; select the body manually.',
  delete: 'Delete',
  deleteTitle: 'Delete this message?',
  deleteHint: 'Deleting removes the message plus its delivery/read rows and cannot be undone. Type {word} to confirm.',
  deleteConfirm: 'Confirm delete',
  cancel: 'Cancel',
  deleting: 'Deleting…',
  deleted: 'Message deleted.',
  deleteFailed: 'Delete failed: {error}',
  send: 'New message',
  sendTitle: 'Send a new message',
  sendTo: 'Recipient (session id or alias)',
  sendSubject: 'Subject (optional)',
  sendBody: 'Body',
  sendSubmit: 'Send',
  sending: 'Sending…',
  sendSuccess: 'Sent: {id}',
  sendDuplicate: 'Already exists (deduped): {id}',
  sendFailed: 'Send failed: {error}',
  sendDisabled: 'Web sending is disabled by configuration.',
  strictModeOn: 'Strict mode: on (direct session-id needs approval)',
  strictModeOff: 'Strict mode: off',
  prev: 'Previous',
  next: 'Next',
  page: 'Page {page} / {pages}',
  priority: 'priority',
  test: 'test',
  prevPage: 'Previous page',
  nextPage: 'Next page',
}

const inject = ['slots', 'locale', 'remote', 'remoteAccess']

const panel = React.createElement
const PANEL_ID = 'messages'
const SIDEBAR_CLASS = 'dsh-message-bus-sidebar'
const PAGE_CLASS = 'dsh-message-bus-page'
const CSS = `
.${SIDEBAR_CLASS} { display: inline-flex; }
.${PAGE_CLASS} { padding: 20px 24px; box-sizing: border-box; height: 100%; overflow-y: auto; color: inherit; }
.${PAGE_CLASS} input, .${PAGE_CLASS} textarea { font: inherit; color: inherit; box-sizing: border-box; }
.${PAGE_CLASS} button { font: inherit; }
.mb-row { display: grid; grid-template-columns: 150px minmax(90px, 160px) minmax(140px, 220px) 1fr; gap: 12px; align-items: center; width: 100%; text-align: left; border: 1px solid rgba(127,127,127,0.18); background: transparent; color: inherit; border-radius: 10px; padding: 10px 12px; margin: 6px 0; cursor: pointer; }
.mb-row:hover { background: rgba(127,127,127,0.12); }
.mb-row:focus-visible { outline: 2px solid rgba(79,140,255,0.8); outline-offset: 1px; }
.mb-row[data-selected="true"] { border-color: rgba(79,140,255,0.6); background: rgba(79,140,255,0.10); }
.mb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.mb-muted { opacity: 0.65; font-size: 12.5px; }
@media (max-width: 760px) { .mb-row { grid-template-columns: 1fr; } }
.mb-overlay { position: fixed; inset: 0; z-index: 10020; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
.mb-dialog { width: min(92vw, 720px); max-height: min(86vh, 760px); overflow: auto; box-sizing: border-box; border-radius: 14px; padding: 18px 20px 20px; background: rgb(32,33,36); border: 1px solid rgba(127,127,127,0.35); box-shadow: 0 18px 48px rgba(0,0,0,0.5); color: inherit; }
body[data-ds-dark-theme="false"] .mb-dialog { background: rgb(250,250,250); }
.mb-dialog input, .mb-dialog textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); }
.mb-dialog textarea { min-height: 180px; resize: vertical; }
.mb-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 14px; }
.mb-button { appearance: none; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
.mb-button:focus-visible { outline: 2px solid rgba(79,140,255,0.8); outline-offset: 1px; }
.mb-primary { border-color: rgba(79,140,255,0.7); background: rgba(79,140,255,0.2); }
.mb-danger { border-color: rgba(248,81,73,0.65); background: rgba(248,81,73,0.18); }
.mb-disabled { opacity: 0.5; cursor: default; }
.mb-field { margin-top: 12px; }
.mb-field label { display: block; font-size: 12.5px; opacity: 0.8; margin-bottom: 5px; }
.mb-hero { display: flex; gap: 14px; align-items: flex-start; padding: 16px 18px; border: 1px solid rgba(79,140,255,0.28); border-radius: 14px; background: linear-gradient(135deg, rgba(79,140,255,0.13), rgba(79,140,255,0.02) 60%, transparent); margin-bottom: 14px; }
.mb-heroIcon { width: 40px; height: 40px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: rgba(79,140,255,0.18); color: rgb(120,170,255); flex: 0 0 auto; }
.mb-heroBody { min-width: 0; flex: 1 1 auto; }
.mb-titleRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mb-kicker { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; opacity: .6; }
.mb-card { margin-bottom: 14px; padding: 14px 16px; border: 1px solid rgba(127,127,127,0.22); border-radius: 12px; background: rgba(127,127,127,0.045); }
.mb-cardHead { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
.mb-cardTitle { margin: 0; font-size: 15px; font-weight: 650; }
.mb-cardSub { margin: 3px 0 0; font-size: 12px; opacity: .62; }
.mb-statRow { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 10px; }
.mb-stat { display: inline-flex; align-items: baseline; gap: 5px; padding: 5px 9px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.22); background: rgba(127,127,127,0.08); font-size: 12px; }
.mb-stat strong { font-size: 13px; font-weight: 650; }
.mb-boardGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; }
.mb-board { min-width: 0; padding: 10px 11px; border-radius: 10px; border: 1px solid rgba(127,127,127,0.2); background: rgba(127,127,127,0.06); }
.mb-boardTop { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.mb-boardTitle { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-boardPath { margin-top: 6px; font-size: 11.5px; opacity: .58; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-board[data-active="true"] { border-color: rgba(79,140,255,0.55); background: rgba(79,140,255,0.10); }
.mb-board { cursor: pointer; text-align: left; color: inherit; }
.mb-board:focus-visible { outline: 2px solid rgba(79,140,255,0.8); outline-offset: 1px; }
.mb-taskList { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.mb-task { width: 100%; text-align: left; color: inherit; background: transparent; border: 1px solid rgba(127,127,127,0.16); border-radius: 8px; padding: 7px 9px; cursor: pointer; }
.mb-task:hover { background: rgba(127,127,127,0.10); }
.mb-task[data-active="true"] { border-color: rgba(79,140,255,0.5); }
.mb-taskTitle { display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 12.5px; }
.mb-taskMeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 11px; opacity: .65; }
.mb-detail { margin-top: 8px; padding: 9px 10px; border-left: 2px solid rgba(79,140,255,0.5); background: rgba(79,140,255,0.06); border-radius: 0 8px 8px 0; font-size: 12px; line-height: 1.55; }
.mb-detail p { margin: 4px 0; }
.mb-chipRow { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 9px; }
.mb-chipButton { appearance: none; border: 1px solid rgba(127,127,127,0.55); background: rgba(127,127,127,0.16); color: inherit; border-radius: 999px; padding: 4px 9px; font-size: 11px; font-weight: 600; cursor: pointer; }
.mb-chipButton:hover { background: rgba(127,127,127,0.26); border-color: rgba(127,127,127,0.75); }
.mb-chipButton[data-active="true"] { border-color: rgba(79,140,255,0.65); background: rgba(79,140,255,0.14); }
.mb-pill { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.25); font-size: 11px; white-space: nowrap; }
.mb-pill[data-status="completed"] { color: rgb(100,190,120); border-color: rgba(63,185,80,0.45); }
.mb-pill[data-status="blocked"] { color: rgb(235,145,120); border-color: rgba(248,81,73,0.45); }
.mb-pill[data-status="in_progress"] { color: rgb(120,170,255); border-color: rgba(79,140,255,0.45); }
.mb-actionRow { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.mb-feedback { margin: 10px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.mb-feedback[data-tone="danger"] { border: 1px solid rgba(248,81,73,0.45); background: rgba(248,81,73,0.10); }
.mb-feedback[data-tone="ok"] { border: 1px solid rgba(63,185,80,0.40); background: rgba(63,185,80,0.08); }
.mb-inlineInput { flex: 1 1 260px; min-width: 0; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.3); background: rgba(127,127,127,0.08); color: inherit; }
.mb-busy { opacity: .65; }
`

const style = {
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '22px', fontWeight: 600 },
  subtitle: { margin: '4px 0 0', fontSize: '12.5px', opacity: 0.7 },
  toolbar: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '18px' },
  input: { padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.10)', color: 'inherit', minWidth: '200px', flex: '1 1 260px' },
  narrow: { maxWidth: '240px', minWidth: '160px' },
  button: { appearance: 'none', border: '1px solid rgba(127,127,127,0.72)', background: 'rgba(127,127,127,0.24)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' },
  primary: { appearance: 'none', border: '1px solid rgba(79,140,255,0.95)', background: 'rgba(79,140,255,0.40)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' },
  danger: { appearance: 'none', border: '1px solid rgba(248,81,73,0.85)', background: 'rgba(248,81,73,0.30)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' },
  meta: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px', fontSize: '12.5px', opacity: 0.75 },
  errorBox: { marginTop: '12px', padding: '9px 11px', borderRadius: '9px', border: '1px solid rgba(248,81,73,0.5)', background: 'rgba(248,81,73,0.12)', fontSize: '12.5px' },
  okBox: { marginTop: '12px', padding: '9px 11px', borderRadius: '9px', border: '1px solid rgba(63,185,80,0.45)', background: 'rgba(63,185,80,0.10)', fontSize: '12.5px' },
  rowTime: { fontSize: '12px', opacity: 0.75 },
  rowText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailBody: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12.5px', lineHeight: 1.6, margin: '8px 0 0', padding: '10px 12px', borderRadius: '9px', background: 'rgba(127,127,127,0.10)', maxHeight: '42vh', overflow: 'auto' },
  metaRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12.5px', opacity: 0.8, marginTop: '8px' },
  pager: { display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'flex-end', marginTop: '12px', fontSize: '12.5px' },
  empty: { marginTop: '28px', fontSize: '13px', opacity: 0.7 },
}

function buttonStyle(tone, disabled) {
  const base = tone === 'primary' ? style.primary : tone === 'danger' ? style.danger : style.button
  return disabled ? { ...base, opacity: 0.5, cursor: 'default' } : base
}

function MessageBusIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 18
  return panel('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', className: SIDEBAR_CLASS },
    panel('circle', { cx: 12, cy: 12, r: 2.4 }),
    panel('circle', { cx: 5, cy: 6, r: 2 }),
    panel('circle', { cx: 19, cy: 6, r: 2 }),
    panel('circle', { cx: 5, cy: 18, r: 2 }),
    panel('circle', { cx: 19, cy: 18, r: 2 }),
    panel('path', { d: 'M7 7.2l3 3.2M17 7.2l-3 3.2M7 16.8l3-3.2M17 16.8l-3-3.2' }))
}

function errorTextOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function unwrapRemote(value) {
  return value !== null && typeof value === 'object' && value.ok === true && value.value !== undefined ? value.value : value
}

function messageText(item) {
  return item.from || item.fromSession || 'unknown'
}

function detailRow(label, value) {
  return panel('div', { style: style.metaRow }, panel('span', { style: { opacity: 0.65 } }, label), panel('span', { className: 'mb-mono' }, value))
}

function Toast(props) {
  if (props.text === undefined) return null
  return panel('div', { style: props.tone === 'danger' ? style.errorBox : style.okBox, 'data-message-toast': '' }, props.text)
}

function DeleteDialog(props) {
  const { t, item, busy, typed, onTyped, onCancel, onConfirm } = props
  return panel('div', { className: 'mb-overlay' },
    panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('deleteTitle'), 'data-message-delete-dialog': '' },
      panel('h2', { style: { margin: 0, fontSize: '16px' } }, t('deleteTitle')),
      panel('p', { style: { fontSize: '12.5px', lineHeight: 1.6, opacity: 0.8 } }, t('deleteHint', { word: DELETE_CONFIRM_WORD })),
      detailRow(t('from'), messageText(item)),
      detailRow(t('subject'), item.subject || t('noSubject')),
      detailRow('id', item.id),
      panel('div', { className: 'mb-field' },
        panel('input', {
          type: 'text',
          value: typed,
          autoComplete: 'off',
          spellCheck: false,
          disabled: busy,
          'aria-label': t('deleteHint', { word: DELETE_CONFIRM_WORD }),
          'data-message-delete-input': '',
          onChange: event => onTyped(event.target.value),
        })),
      panel('div', { className: 'mb-actions' },
        panel('button', { type: 'button', className: 'mb-button', onClick: onCancel, disabled: busy }, t('cancel')),
        panel('button', {
          type: 'button',
          className: 'mb-button mb-danger',
          onClick: onConfirm,
          disabled: busy || !canDelete(typed),
          'data-message-delete-confirm': '',
        }, busy ? t('deleting') : t('deleteConfirm')))))
}

function SendDialog(props) {
  const { t, sending, form, onField, onCancel, onSubmit, error } = props
  return panel('div', { className: 'mb-overlay' },
    panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('sendTitle'), 'data-message-send-dialog': '' },
      panel('h2', { style: { margin: 0, fontSize: '16px' } }, t('sendTitle')),
      error === undefined ? null : panel('div', { style: style.errorBox }, error),
      panel('div', { className: 'mb-field' },
        panel('label', null, t('sendTo')),
        panel('input', { type: 'text', value: form.to, autoComplete: 'off', spellCheck: false, 'data-message-send-to': '', onChange: event => onField('to', event.target.value) })),
      panel('div', { className: 'mb-field' },
        panel('label', null, t('sendSubject')),
        panel('input', { type: 'text', value: form.subject, autoComplete: 'off', spellCheck: false, 'data-message-send-subject': '', onChange: event => onField('subject', event.target.value) })),
      panel('div', { className: 'mb-field' },
        panel('label', null, t('sendBody')),
        panel('textarea', { value: form.body, spellCheck: false, 'data-message-send-body': '', onChange: event => onField('body', event.target.value) })),
      panel('div', { className: 'mb-actions' },
        panel('button', { type: 'button', className: 'mb-button', onClick: onCancel, disabled: sending }, t('cancel')),
        panel('button', {
          type: 'button',
          className: 'mb-button mb-primary',
          onClick: onSubmit,
          disabled: sending || form.to.trim() === '' || form.body.trim() === '',
          'data-message-send-submit': '',
        }, sending ? t('sending') : t('sendSubmit')))))
}

function MessageDetail(props) {
  const { t, item, readBy, onClose, onDelete, onCopyBody, onCopyQuote } = props
  return panel('div', null,
    panel('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' } },
      panel('h2', { style: { margin: 0, fontSize: '16px' } }, t('detailTitle')),
      panel('button', { type: 'button', style: style.button, onClick: onClose, 'aria-label': t('close') }, t('close'))),
    detailRow(t('from'), messageText(item)),
    detailRow(t('to'), item.to),
    detailRow(t('subject'), item.subject || t('noSubject')),
    detailRow(t('readAt', { time: item.readAt ?? '—' }), readBy === '' ? t('unread') : (item.readAt ?? '—')),
    panel('p', { style: style.detailBody, 'data-message-detail-body': '' }, item.body),
    panel('div', { className: 'mb-actions', style: { justifyContent: 'flex-start' } },
      panel('button', { type: 'button', className: 'mb-button', onClick: onCopyBody, 'data-message-copy': '' }, t('copyBody')),
      panel('button', { type: 'button', className: 'mb-button', onClick: onCopyQuote, 'data-message-quote': '' }, t('copyQuote')),
      panel('button', { type: 'button', className: 'mb-button mb-danger', onClick: onDelete, 'data-message-delete': '' }, t('delete'))))
}

function MessageRow(props) {
  const { t, item, selected, onOpen } = props
  return panel('button', {
    type: 'button',
    className: 'mb-row',
    onClick: () => onOpen(item),
    'data-message-row': item.id,
    'data-selected': selected ? 'true' : 'false',
  },
  panel('div', { className: 'mb-rowTime' }, formatTime(item.at)),
  panel('div', { style: style.rowText, title: item.fromSession ?? item.from }, messageText(item)),
  panel('div', { style: { ...style.rowText, fontSize: '13px' } }, item.subject || t('noSubject')),
  panel('div', { className: 'mb-muted', style: style.rowText }, item.snippet))
}

const BOARD_REMOTE_METHODS = [
  { method: 'overview', invocation: { kind: 'direct' } },
  { method: 'boards', invocation: { kind: 'direct' } },
  { method: 'tasks', invocation: { kind: 'direct' } },
]
const APARTMENT_REMOTE_METHODS = [
  { method: 'status', invocation: { kind: 'direct' }, parameters: [] },
  { method: 'setRoot', invocation: { kind: 'direct' }, parameters: ['root'] },
  { method: 'migrate', invocation: { kind: 'direct' }, parameters: ['to'] },
  { method: 'backup', invocation: { kind: 'direct' }, parameters: ['label'] },
  { method: 'restore', invocation: { kind: 'direct' }, parameters: ['from'] },
  { method: 'verify', invocation: { kind: 'direct' }, parameters: [] },
  { method: 'data', invocation: { kind: 'direct' }, parameters: ['query'] },
]
const apartmentParameter = name => ({
  name,
  wire: name,
  source: 'json',
  codec: { mode: 'strict', typeSymbol: `dsh-agent-apartment#${name}:json`, create: () => ({ parse: value => value }) },
})
const boardResultCodec = name => ({ mode: 'strict', typeSymbol: `dsh-bulletin-board#${name}:result`, create: () => ({ parse: value => value }) })
const apartmentResultCodec = name => ({ mode: 'strict', typeSymbol: `dsh-agent-apartment#${name}:result`, create: () => ({ parse: value => value }) })
function remoteContribution(pkg, namespace, service, methods, codec) {
  return {
    package: pkg,
    descriptors: methods.map(entry => ({
      id: `${pkg}/${namespace}/${entry.method}`,
      service,
      namespace,
      method: entry.method,
      invocation: { kind: 'direct' },
      parameters: (entry.parameters ?? []).map(apartmentParameter),
      result: codec(entry.method),
    })),
  }
}
function createBoardRemoteContribution() {
  return remoteContribution('dsh-bulletin-board', 'bulletinBoard', 'bulletinBoardRemote', BOARD_REMOTE_METHODS, boardResultCodec)
}
function createApartmentRemoteContribution() {
  return remoteContribution('dsh-agent-apartment', 'agentApartment', 'agentApartmentRemote', APARTMENT_REMOTE_METHODS, apartmentResultCodec)
}

function NetworkSection(props) {
  const { t, network, api } = props
  const boards = Array.isArray(network.boards) ? network.boards : []
  const tasks = Array.isArray(network.tasks) ? network.tasks : []
  const counts = network.counts ?? {}
  const statuses = ['pending', 'in_progress', 'blocked', 'suspended', 'completed', 'terminated']
  const [selectedBoardId, setSelectedBoardId] = React.useState(boards[0]?.id)
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [selectedTaskId, setSelectedTaskId] = React.useState(undefined)
  const [taskQuery, setTaskQuery] = React.useState('')
  const [taskPage, setTaskPage] = React.useState(0)
  const [serverPage, setServerPage] = React.useState(undefined)
  const [taskLoading, setTaskLoading] = React.useState(false)
  const taskPageSize = 20
  const activeBoard = boards.find(board => board.id === selectedBoardId) ?? boards[0]
  const boardTasks = activeBoard === undefined ? [] : tasks.filter(task => (task.boardId ?? task.board_id) === activeBoard.id)
  const normalizedQuery = taskQuery.trim().toLowerCase()
  const filteredTasks = boardTasks.filter(task => {
    if (statusFilter !== 'all' && task.status !== statusFilter) return false
    if (normalizedQuery === '') return true
    return [task.id, task.title, task.assigneeAlias, task.assigneeSession, task.status,
      ...(Array.isArray(task.dependsOn) ? task.dependsOn : []), ...(Array.isArray(task.relatedTasks) ? task.relatedTasks : [])]
      .filter(value => typeof value === 'string').some(value => value.toLowerCase().includes(normalizedQuery))
  })
  const localPageCount = Math.max(1, Math.ceil(filteredTasks.length / taskPageSize))
  const safeTaskPage = Math.min(taskPage, localPageCount - 1)
  const localPageTasks = filteredTasks.slice(safeTaskPage * taskPageSize, safeTaskPage * taskPageSize + taskPageSize)
  const pageData = serverPage
  const totalTasks = pageData?.total ?? filteredTasks.length
  const taskPageCount = Math.max(1, Math.ceil(totalTasks / taskPageSize))
  const pageTasks = Array.isArray(pageData?.tasks) ? pageData.tasks : localPageTasks
  const selectedTask = pageTasks.find(task => task.id === selectedTaskId) ?? tasks.find(task => task.id === selectedTaskId)
  const selectBoard = boardId => { setSelectedBoardId(boardId); setSelectedTaskId(undefined); setTaskPage(0); setServerPage(undefined) }

  React.useEffect(() => {
    if (activeBoard === undefined || typeof api?.tasksPage !== 'function') { setServerPage(undefined); return }
    let cancelled = false
    setTaskLoading(true)
    setServerPage(undefined)
    Promise.resolve(api.tasksPage({
      boardId: activeBoard.id,
      status: statusFilter === 'all' ? undefined : statusFilter,
      query: taskQuery.trim(),
      offset: taskPage * taskPageSize,
      limit: taskPageSize,
    })).then(result => {
      if (cancelled) return
      const value = result?.ok === true && result.value !== undefined ? result.value : result
      if (value !== undefined && value !== null) setServerPage(value)
    }).catch(() => { if (!cancelled) setServerPage(undefined) }).finally(() => { if (!cancelled) setTaskLoading(false) })
    return () => { cancelled = true }
  }, [api, activeBoard?.id, statusFilter, taskQuery, taskPage])

  const boardGrid = panel('div', { className: 'mb-boardGrid' }, boards.slice(0, 8).map(board => {
    const active = activeBoard?.id === board.id
    return panel('article', {
      key: board.id,
      className: 'mb-board',
      role: 'button',
      tabIndex: 0,
      'data-active': active ? 'true' : 'false',
      'aria-label': board.title,
      onClick: () => selectBoard(board.id),
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectBoard(board.id) } },
    },
    panel('div', { className: 'mb-boardTop' },
      panel('span', { className: 'mb-boardTitle', title: board.title }, board.title),
      panel('span', { className: 'mb-pill', 'data-status': board.status }, board.status)),
    panel('div', { className: 'mb-boardPath' }, board.workspace || board.id))
  }))

  const taskChips = panel('div', { className: 'mb-chipRow' }, ['all', ...statuses].map(status => panel('button', {
    key: status,
    type: 'button',
    className: 'mb-chipButton',
    'data-active': statusFilter === status ? 'true' : 'false',
    onClick: () => { setStatusFilter(status); setTaskPage(0) },
  }, status === 'all' ? t('allTasks') : status, ' ', String(status === 'all' ? boardTasks.length : boardTasks.filter(task => task.status === status).length))))

  const taskList = pageTasks.length === 0
    ? panel('p', { className: 'mb-muted', style: { marginTop: 8 } }, t('noTasks'))
    : panel('div', { className: 'mb-taskList' }, pageTasks.map(task => panel('button', {
      key: task.id,
      type: 'button',
      className: 'mb-task',
      'data-active': selectedTask?.id === task.id ? 'true' : 'false',
      onClick: () => setSelectedTaskId(current => current === task.id ? undefined : task.id),
    },
    panel('div', { className: 'mb-taskTitle' },
      panel('span', null, task.title),
      panel('span', { className: 'mb-pill', 'data-status': task.status }, task.status)),
    panel('div', { className: 'mb-taskMeta' },
      task.assigneeAlias || task.assigneeSession ? panel('span', null, `${t('assignee')}: ${task.assigneeAlias || task.assigneeSession}`) : null,
      task.priority ? panel('span', null, `${t('priorityLabel')} ${task.priority}`) : null,
      Array.isArray(task.dependsOn) && task.dependsOn.length > 0 ? panel('span', null, `${t('dependencies')} ${task.dependsOn.length}`) : null,
      task.blockedReason ? panel('span', null, t('blockedReason')) : null))))

  const taskDetail = selectedTask === undefined ? null : panel('div', { className: 'mb-detail' },
    panel('div', { className: 'mb-taskTitle' },
      panel('strong', null, selectedTask.title),
      panel('button', { type: 'button', className: 'mb-chipButton', onClick: () => setSelectedTaskId(undefined) }, t('closeTask'))),
    selectedTask.description ? panel('p', null, selectedTask.description) : null,
    panel('p', { className: 'mb-muted' }, `${t('assignee')}: ${selectedTask.assigneeAlias || selectedTask.assigneeSession || '—'}`),
    selectedTask.dependsOn?.length ? panel('p', null, `${t('dependencies')}: ${selectedTask.dependsOn.join(', ')}`) : null,
    selectedTask.relatedTasks?.length ? panel('p', null, `${t('related')}: ${selectedTask.relatedTasks.join(', ')}`) : null,
    selectedTask.blockedReason ? panel('p', null, `${t('blockedReason')}: ${selectedTask.blockedReason}`) : null)

  const taskPanel = activeBoard === undefined ? null : panel('div', { style: { marginTop: 12 } },
    panel('div', { className: 'mb-cardSub', style: { marginBottom: 4 } }, `${t('boardTasks')} · ${activeBoard.title}`),
    panel('input', {
      type: 'search',
      value: taskQuery,
      placeholder: t('taskSearch'),
      className: 'mb-inlineInput',
      'aria-label': t('taskSearch'),
      'data-task-search': '',
      onChange: event => { setTaskQuery(event.target.value); setTaskPage(0); setSelectedTaskId(undefined) },
    }),
    taskChips, taskList,
    panel('div', { className: 'mb-actionRow', style: { justifyContent: 'space-between' } },
      panel('span', { className: 'mb-muted', 'data-task-page': String(safeTaskPage + 1) },
        taskLoading ? t('working') : t('pageInfo', { page: safeTaskPage + 1, pages: taskPageCount, total: totalTasks })),
      panel('div', { style: { display: 'flex', gap: 6 } },
        panel('button', { type: 'button', className: 'mb-chipButton', disabled: safeTaskPage <= 0, onClick: () => setTaskPage(Math.max(0, safeTaskPage - 1)) }, t('prevPage')),
        panel('button', { type: 'button', className: 'mb-chipButton', disabled: safeTaskPage >= taskPageCount - 1, onClick: () => setTaskPage(Math.min(taskPageCount - 1, safeTaskPage + 1)) }, t('nextPage')))),
    taskDetail)

  const content = boards.length === 0
    ? panel('p', { className: 'mb-muted' }, t('networkEmpty'))
    : panel('div', null, boardGrid, taskPanel)

  const countsRow = tasks.length === 0 ? null : panel('div', { className: 'mb-statRow', style: { marginBottom: 0 } },
    statuses.map(status => panel('span', {
      key: status,
      className: 'mb-pill',
      'data-status': status,
      style: { opacity: counts[status] ? 1 : 0.5 },
    }, status, ' ', String(counts[status] ?? 0))))

  return panel('section', { 'data-agent-network': '', className: 'mb-card' },
    panel('div', { className: 'mb-cardHead' },
      panel('div', null,
        panel('h2', { className: 'mb-cardTitle' }, t('networkTitle')),
        panel('p', { className: 'mb-cardSub' }, t('networkSubtitle'))),
      panel('span', { className: 'mb-kicker' }, t('networkLive'))),
    panel('div', { className: 'mb-statRow' },
      panel('span', { className: 'mb-stat' }, t('boardsLabel'), ' ', panel('strong', null, boards.length)),
      panel('span', { className: 'mb-stat' }, t('tasksLabel'), ' ', panel('strong', null, tasks.length))),
    content,
    countsRow)
}

function ApartmentSection(props) {
  const { t, api, rootInput, setRootInput, busy, message, onSetRoot, onMigrate, onBackup, onRestore, onVerify } = props
  const [section, setSection] = React.useState('agents')
  const [detailQuery, setDetailQuery] = React.useState('')
  const [detailPage, setDetailPage] = React.useState(0)
  const [detail, setDetail] = React.useState(undefined)
  const [detailBusy, setDetailBusy] = React.useState(false)
  const apartment = unwrapRemote(props.apartment)
  const loadDetail = async (next = {}) => {
    if (typeof api?.apartmentData !== 'function') return
    const targetSection = next.section ?? section
    const targetPage = next.page ?? detailPage
    const targetQuery = next.query ?? detailQuery
    setDetailBusy(true)
    try {
      const raw = await api.apartmentData({ section: targetSection, query: targetQuery, limit: 10, offset: targetPage * 10 })
      const value = unwrapRemote(raw)
      setDetail(value ?? { items: [], total: 0, limit: 10, offset: 0 })
      setSection(targetSection)
      setDetailPage(targetPage)
    } catch (caught) {
      setDetail({ items: [], total: 0, error: errorTextOf(caught) })
    } finally { setDetailBusy(false) }
  }
  React.useEffect(() => { void loadDetail({ section: 'agents', page: 0, query: '' }) }, [])
  if (apartment === undefined || apartment === null) return null
  const feedback = message !== null && typeof message === 'object' ? message : (message === undefined ? undefined : { text: String(message), tone: 'ok' })
  const sections = [['agents', 'Agent'], ['teams', 'Teams'], ['leases', 'Leases'], ['roles', 'Roles'], ['experiences', 'Experience'], ['backups', 'Backups']]
  const items = Array.isArray(detail?.items) ? detail.items : []
  const pages = Math.max(1, Math.ceil((detail?.total ?? 0) / 10))
  const rowText = item => section === 'agents' ? `${item.name ?? item.id} · ${item.status ?? ''} · ${item.home ?? ''}`
    : section === 'teams' ? `${item.name ?? item.id} · ${item.purpose ?? ''}`
      : section === 'leases' ? `${item.agent_id ?? ''} · ${item.workspace ?? ''} · ${item.state ?? ''}`
        : section === 'roles' ? `${item.task_id ?? ''} · ${item.agent_id ?? item.team_id ?? ''} · ${item.role ?? ''}`
          : section === 'experiences' ? `${item.agent_id ?? ''} · ${item.summary ?? ''}`
            : `${item.name ?? item.path ?? ''} · files ${item.files ?? 0}`
  return panel('section', { 'data-apartment': '', className: 'mb-card' },
    panel('div', { className: 'mb-cardHead' },
      panel('div', null,
        panel('h2', { className: 'mb-cardTitle' }, t('apartmentTitle')),
        panel('p', { className: 'mb-cardSub' }, t('apartmentSubtitle'))),
      panel('span', { className: 'mb-kicker' }, t('apartmentStats'))),
    panel('div', { className: 'mb-statRow' },
      panel('span', { className: 'mb-stat' }, 'agents ', panel('strong', null, apartment.agents ?? 0)),
      panel('span', { className: 'mb-stat' }, 'teams ', panel('strong', null, apartment.teams ?? 0)),
      panel('span', { className: 'mb-stat' }, 'leases ', panel('strong', null, apartment.leases ?? 0)),
      panel('span', { className: 'mb-stat' }, 'roles ', panel('strong', null, apartment.taskRoles ?? 0)),
      panel('span', { className: 'mb-stat' }, 'experience ', panel('strong', null, apartment.experiences ?? 0))),
    panel('div', { className: 'mb-actionRow' },
      panel('input', {
        type: 'text',
        value: rootInput,
        placeholder: t('apartmentRootPlaceholder'),
        className: 'mb-inlineInput',
        'aria-label': t('apartmentRootPlaceholder'),
        onChange: event => setRootInput(event.target.value),
      }),
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: onSetRoot }, t('apartmentSaveRoot')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onMigrate }, t('apartmentMigrate')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onBackup }, t('apartmentBackup')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onRestore }, t('apartmentRestore')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onVerify }, t('apartmentVerify'))),
    panel('div', { className: 'mb-actionRow', 'data-apartment-sections': '' },
      sections.map(([id, label]) => panel('button', {
        key: id, type: 'button', className: 'mb-chipButton', 'data-active': section === id ? 'true' : 'false',
        onClick: () => { void loadDetail({ section: id, page: 0 }) },
      }, label))),
    panel('div', { className: 'mb-actionRow' },
      panel('input', {
        type: 'search', value: detailQuery, className: 'mb-inlineInput', placeholder: '搜索当前列表',
        'aria-label': '搜索当前列表', onChange: event => setDetailQuery(event.target.value),
      }),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: detailBusy, onClick: () => { void loadDetail({ page: 0 }) } }, t('search')),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: detailBusy || detailPage <= 0, onClick: () => { void loadDetail({ page: detailPage - 1 }) } }, t('prevPage')),
      panel('span', { className: 'mb-muted' }, t('pageInfo', { page: detailPage + 1, pages, total: detail?.total ?? 0 })),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: detailBusy || detailPage >= pages - 1, onClick: () => { void loadDetail({ page: detailPage + 1 }) } }, t('nextPage'))),
    detail?.error ? panel('p', { className: 'mb-feedback', 'data-tone': 'danger' }, detail.error) : null,
    items.length === 0 ? panel('p', { className: 'mb-muted' }, '暂无数据') : panel('div', { className: 'mb-taskList' }, items.map((item, index) => panel('article', { key: item.id ?? item.name ?? index, className: 'mb-task' },
      panel('p', { style: { margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, rowText(item))))),
    feedback === undefined ? null : panel('p', {
      className: 'mb-feedback',
      'data-tone': feedback.tone === 'danger' ? 'danger' : 'ok',
      role: 'status',
      'aria-live': 'polite',
    }, feedback.text))
}

function MemoryRow(props) {
  const { t, memoryRow, pendingDelete, onAskDelete, onCancelDelete, onConfirmDelete } = props
  const [expanded, setExpanded] = React.useState(false)
  const content = typeof memoryRow.content === 'string' ? memoryRow.content : ''
  const long = content.length > 280
  const visible = expanded || !long ? content : content.slice(0, 280) + '…'
  return panel('article', { key: memoryRow.id, className: 'mb-task', 'data-memory-row': memoryRow.id },
    panel('div', { className: 'mb-taskTitle' },
      panel('span', null, memoryRow.key || memoryRow.id),
      panel('span', { className: 'mb-pill' }, memoryRow.scope)),
    panel('p', { style: { margin: '6px 0', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, 'data-memory-content': expanded ? 'expanded' : 'collapsed' }, visible),
    long
      ? panel('button', {
        type: 'button', className: 'mb-chipButton', 'data-memory-toggle': '',
        'aria-expanded': expanded ? 'true' : 'false',
        onClick: () => setExpanded(value => !value),
      }, expanded ? t('memoryCollapse') : t('memoryExpand'))
      : null,
    panel('div', { className: 'mb-taskMeta' },
      panel('span', null, memoryRow.updated_at ?? ''),
      (memoryRow.tags ?? []).map(tag => panel('span', { key: tag, className: 'mb-pill' }, tag)),
      pendingDelete === memoryRow.id
        ? panel('span', null,
          panel('button', { type: 'button', className: 'mb-chipButton', onClick: onCancelDelete }, t('memoryCancel')),
          ' ',
          panel('button', { type: 'button', className: 'mb-chipButton', onClick: () => onConfirmDelete(memoryRow.id) }, t('memoryConfirmDelete')))
        : panel('button', { type: 'button', className: 'mb-chipButton', onClick: () => onAskDelete(memoryRow.id) }, t('memoryDelete'))))
}

function MemorySection(props) {
  const { t, memory, query, scope, setQuery, setScope, page, pageCount, busy, message, pendingDelete, onSearch, onPage, onAskDelete, onCancelDelete, onConfirmDelete } = props
  if (memory === undefined || memory === null) return null
  const memories = Array.isArray(memory.memories) ? memory.memories : []
  return panel('section', { 'data-agent-memory': '', className: 'mb-card' },
    panel('div', { className: 'mb-cardHead' },
      panel('div', null,
        panel('h2', { className: 'mb-cardTitle' }, t('memoryTitle')),
        panel('p', { className: 'mb-cardSub' }, t('memorySubtitle'))),
      panel('span', { className: 'mb-kicker' }, t('memoryTotal', { total: memory.total ?? memories.length }))),
    panel('div', { className: 'mb-actionRow' },
      panel('input', {
        type: 'search', value: query, placeholder: t('memorySearch'), className: 'mb-inlineInput',
        'aria-label': t('memorySearch'), 'data-memory-search': '',
        onChange: event => setQuery(event.target.value),
      }),
      panel('select', {
        value: scope,
        className: 'mb-inlineInput',
        style: { flex: '0 1 150px' },
        'aria-label': t('memoryScopeAll'),
        onChange: event => setScope(event.target.value),
      },
      panel('option', { value: '' }, t('memoryScopeAll')),
      panel('option', { value: 'project' }, 'project'),
      panel('option', { value: 'agent' }, 'agent'),
      panel('option', { value: 'global' }, 'global'))),
    panel('div', { className: 'mb-actionRow' },
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: onSearch }, t('search')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: () => onPage(0) }, t('clear'))),
    memories.length === 0
      ? panel('p', { className: 'mb-muted', style: { marginTop: 8 } }, t('memoryEmpty'))
      : panel('div', { className: 'mb-taskList' }, memories.map(memoryRow => panel(MemoryRow, {
        key: memoryRow.id, t, memoryRow, pendingDelete,
        onAskDelete, onCancelDelete, onConfirmDelete,
      }))),
    panel('div', { className: 'mb-actionRow' },
      panel('span', { className: 'mb-muted' }, t('pageInfo', { page: page + 1, pages: pageCount, total: memory.total ?? memories.length })),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: page <= 0, onClick: () => onPage(page - 1) }, t('prevPage')),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: page >= pageCount - 1, onClick: () => onPage(page + 1) }, t('nextPage'))),
    message === undefined ? null : panel('p', { className: 'mb-feedback', 'data-tone': message.tone === 'danger' ? 'danger' : 'ok', role: 'status' }, message.text))
}

function MeetingDetailDialog(props) {
  const { t, detail, busy, onClose } = props
  return panel('div', { className: 'mb-overlay', onMouseDown: event => { if (event.target === event.currentTarget) onClose() } },
    panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '会议详情', 'data-meeting-detail': '' },
      panel('div', { className: 'mb-actionRow', style: { justifyContent: 'space-between' } },
        panel('h3', { style: { margin: 0 } }, detail?.meeting?.title ?? '会议详情'),
        panel('button', { type: 'button', className: 'mb-chipButton', onClick: onClose }, '关闭')),
      busy ? panel('p', { className: 'mb-muted' }, t('loading')) : null,
      detail?.error ? panel('p', { className: 'mb-feedback', 'data-tone': 'danger' }, detail.error) : null,
      detail?.meeting ? panel('div', { className: 'mb-taskMeta' },
        panel('span', null, detail.meeting.meetingId),
        panel('span', { className: 'mb-pill' }, detail.meeting.status),
        detail.meeting.convener ? panel('span', null, detail.meeting.convener) : null,
        detail.meeting.updatedAt ? panel('span', null, detail.meeting.updatedAt) : null) : null,
      detail?.summaryText ? panel('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, detail.summaryText) : null,
      Array.isArray(detail?.participants) && detail.participants.length > 0 ? panel('p', { className: 'mb-muted' }, 'Participants: ' + detail.participants.map(p => p.sessionId).join(', ')) : null,
      Array.isArray(detail?.messages) ? panel('div', { className: 'mb-taskList' }, detail.messages.map(message => panel('article', { key: message.msgId, className: 'mb-task' },
        panel('div', { className: 'mb-taskTitle' },
          panel('span', null, message.round ?? 'note'),
          panel('span', { className: 'mb-pill' }, message.from ?? '')),
        panel('p', { style: { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '36vh', overflow: 'auto' } }, message.body ?? '(body unavailable)')))) : null,
      Array.isArray(detail?.decisions) && detail.decisions.length > 0 ? panel('div', null,
        panel('h4', null, 'Decisions'),
        panel('ul', null, detail.decisions.map((decision, index) => panel('li', { key: decision.id ?? index }, decision.text ?? JSON.stringify(decision))))) : null,
      Array.isArray(detail?.actions) && detail.actions.length > 0 ? panel('div', null,
        panel('h4', null, 'Actions'),
        panel('ul', null, detail.actions.map((action, index) => panel('li', { key: action.id ?? index }, `${action.text ?? ''} · ${action.owner ?? ''} · ${action.status ?? ''}`)))) : null))
}

function MeetingsSection(props) {
  const { t, meetings, query, status, setQuery, setStatus, page, pageCount, busy, message, onSearch, onPage, onOpen } = props
  if (meetings === undefined || meetings === null) return null
  const items = Array.isArray(meetings.meetings) ? meetings.meetings : []
  return panel('section', { 'data-agent-meetings': '', className: 'mb-card' },
    panel('div', { className: 'mb-cardHead' },
      panel('div', null,
        panel('h2', { className: 'mb-cardTitle' }, t('meetingsTitle')),
        panel('p', { className: 'mb-cardSub' }, t('meetingsSubtitle'))),
      panel('span', { className: 'mb-kicker' }, t('memoryTotal', { total: meetings.total ?? items.length }))),
    panel('div', { className: 'mb-actionRow' },
      panel('input', {
        type: 'search', value: query, placeholder: t('meetingsSearch'), className: 'mb-inlineInput',
        'aria-label': t('meetingsSearch'), 'data-meeting-search': '',
        onChange: event => setQuery(event.target.value),
      }),
      panel('select', {
        value: status, className: 'mb-inlineInput', style: { flex: '0 1 150px' },
        'aria-label': t('meetingStatus'), onChange: event => setStatus(event.target.value),
      },
      panel('option', { value: '' }, t('allTasks')),
      ['open', 'r1', 'r2', 'final', 'cancelled'].map(state => panel('option', { key: state, value: state }, state)),
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: onSearch }, t('search'))),
    items.length === 0
      ? panel('p', { className: 'mb-muted', style: { marginTop: 8 } }, t('meetingsEmpty'))
      : panel('div', { className: 'mb-taskList' }, items.map(item => panel('article', { key: item.meetingId, className: 'mb-task' },
        panel('div', { className: 'mb-taskTitle' },
          panel('span', null, item.title || item.meetingId),
          panel('span', { className: 'mb-pill', 'data-status': item.status }, item.status)),
        panel('div', { className: 'mb-taskMeta' },
          panel('span', null, item.meetingId),
          panel('span', null, `${t('meetingParticipants')} ${item.participants ?? 0}`),
          panel('span', null, `${t('meetingMessages')} ${item.messages ?? 0}`),
          item.convener ? panel('span', null, item.convener) : null,
          typeof onOpen === 'function' ? panel('button', { type: 'button', className: 'mb-chipButton', onClick: () => onOpen(item.meetingId) }, '详情') : null)))),
    panel('div', { className: 'mb-actionRow' },
      panel('span', { className: 'mb-muted' }, t('pageInfo', { page: page + 1, pages: pageCount, total: meetings.total ?? items.length })),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: page <= 0, onClick: () => onPage(page - 1) }, t('prevPage')),
      panel('button', { type: 'button', className: 'mb-chipButton', disabled: page >= pageCount - 1, onClick: () => onPage(page + 1) }, t('nextPage'))),
    message === undefined ? null : panel('p', { className: 'mb-feedback', 'data-tone': message.tone === 'danger' ? 'danger' : 'ok', role: 'status' }, message.text)))
}

function MessageCenterPage(props) {
  const { t, api } = props
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(undefined)
  const [items, setItems] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [offset, setOffset] = React.useState(0)
  const [limit, setLimit] = React.useState(DEFAULT_PAGE_SIZE)
  const [keyword, setKeyword] = React.useState('')
  const [queryInput, setQueryInput] = React.useState('')
  const [readByInput, setReadByInput] = React.useState('')
  const [readBy, setReadBy] = React.useState('')
  const [allowSend, setAllowSend] = React.useState(false)
  const [strictMode, setStrictMode] = React.useState(true)
  const [counts, setCounts] = React.useState({})
  const [network, setNetwork] = React.useState(undefined)
  const [apartment, setApartment] = React.useState(undefined)
  const [rootInput, setRootInput] = React.useState('')
  const [memory, setMemory] = React.useState(undefined)
  const [memoryQuery, setMemoryQuery] = React.useState('')
  const [memoryScope, setMemoryScope] = React.useState('')
  const [memoryPage, setMemoryPage] = React.useState(0)
  const [memoryBusy, setMemoryBusy] = React.useState(false)
  const [memoryMessage, setMemoryMessage] = React.useState(undefined)
  const [memoryDeleteId, setMemoryDeleteId] = React.useState(undefined)
  const [meetings, setMeetings] = React.useState(undefined)
  const [meetingQuery, setMeetingQuery] = React.useState('')
  const [meetingStatus, setMeetingStatus] = React.useState('')
  const [meetingPage, setMeetingPage] = React.useState(0)
  const [meetingBusy, setMeetingBusy] = React.useState(false)
  const [meetingMessage, setMeetingMessage] = React.useState(undefined)
  const [meetingDetail, setMeetingDetail] = React.useState(undefined)
  const [meetingDetailBusy, setMeetingDetailBusy] = React.useState(false)
  const [apartmentBusy, setApartmentBusy] = React.useState(false)
  const [apartmentMessage, setApartmentMessage] = React.useState(undefined)
  const [selected, setSelected] = React.useState(undefined)
  const [detail, setDetail] = React.useState(undefined)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleteTyped, setDeleteTyped] = React.useState('')
  const [deleting, setDeleting] = React.useState(false)
  const [sendOpen, setSendOpen] = React.useState(false)
  const [sendForm, setSendForm] = React.useState({ to: '', subject: '', body: '' })
  const [sending, setSending] = React.useState(false)
  const [sendError, setSendError] = React.useState(undefined)
  const [toast, setToast] = React.useState(undefined)

  const showToast = (text, tone = 'ok') => {
    setToast({ text, tone })
    if (showToast.timer !== undefined) clearTimeout(showToast.timer)
    showToast.timer = setTimeout(() => setToast(undefined), 4000)
  }
  React.useEffect(() => () => { if (showToast.timer !== undefined) clearTimeout(showToast.timer) }, [])

  const loadAux = React.useCallback(async (attempt = 0) => {
    let missing = false
    try {
      const rawStatus = await api.apartmentStatus?.()
      const status = unwrapRemote(rawStatus)
      if (status !== undefined && status !== null) {
        setApartment(status)
        setRootInput(current => current === '' ? (status.root ?? '') : current)
      } else missing = true
    } catch { missing = true }
    if (missing && attempt < 6) setTimeout(() => { void loadAux(attempt + 1) }, 300)
  }, [api])

  const loadMemory = React.useCallback(async (options = {}) => {
    if (memoryBusy || typeof api.memoryPage !== 'function') return
    const page = Number.isInteger(options.page) ? options.page : memoryPage
    setMemoryBusy(true)
    if (!options.preserveMessage) setMemoryMessage(undefined)
    try {
      const result = await api.memoryPage({
        query: options.query ?? memoryQuery,
        scope: options.scope ?? memoryScope,
        offset: page * 20,
        limit: 20,
      })
      const value = result?.ok === true && result.value !== undefined ? result.value : result
      setMemory(value ?? { memories: [], total: 0 })
      setMemoryPage(page)
    } catch (caught) {
      setMemoryMessage({ text: t('memoryFailed', { error: errorTextOf(caught) }), tone: 'danger' })
    } finally {
      setMemoryBusy(false)
    }
  }, [api, memoryBusy, memoryPage, memoryQuery, memoryScope, t])

  const loadMeetings = React.useCallback(async (options = {}) => {
    if (meetingBusy || typeof api.meetingsPage !== 'function') return
    const page = Number.isInteger(options.page) ? options.page : meetingPage
    setMeetingBusy(true)
    setMeetingMessage(undefined)
    try {
      const result = await api.meetingsPage({
        query: options.query ?? meetingQuery,
        status: options.status ?? meetingStatus,
        offset: page * 20,
        limit: 20,
      })
      const value = result?.ok === true && result.value !== undefined ? result.value : result
      setMeetings(value ?? { meetings: [], total: 0 })
      setMeetingPage(page)
    } catch (caught) {
      setMeetingMessage({ text: t('memoryFailed', { error: errorTextOf(caught) }), tone: 'danger' })
    } finally {
      setMeetingBusy(false)
    }
  }, [api, meetingBusy, meetingPage, meetingQuery, meetingStatus, t])

  const openMeetingDetail = async meetingId => {
    if (meetingDetailBusy || typeof api.meetingDetail !== 'function') return
    setMeetingDetailBusy(true)
    setMeetingDetail({})
    try {
      const raw = await api.meetingDetail({ meetingId })
      setMeetingDetail(unwrapRemote(raw))
    } catch (caught) {
      setMeetingDetail({ error: errorTextOf(caught) })
    } finally { setMeetingDetailBusy(false) }
  }

  const load = React.useCallback(async (options = {}) => {
    const nextOffset = options.offset ?? offset
    const nextKeyword = options.keyword ?? keyword
    const nextReadBy = options.readBy ?? readBy
    setLoading(true)
    setError(undefined)
    try {
      const result = nextKeyword.trim() === ''
        ? await api.list('', limit, nextOffset, nextReadBy)
        : await api.search(nextKeyword.trim(), limit, nextOffset, nextReadBy)
      const normalized = normalizeListResult(result)
      if (!normalized.ok) setError(normalized.error)
      else {
        setItems(normalized.items)
        setTotal(normalized.total)
        setOffset(normalized.offset)
        setLimit(normalized.limit)
        setAllowSend(normalized.allowSend)
        setStrictMode(normalized.strictMode)
        setCounts(normalized.counts)
        if (normalized.network !== undefined) setNetwork(normalized.network)
        if (normalized.apartment !== undefined) {
          setApartment(normalized.apartment)
          setRootInput(current => current === '' ? (normalized.apartment.root ?? '') : current)
        }
        void loadAux()
      }
    } catch (caught) {
      setError(errorTextOf(caught))
    } finally {
      setLoading(false)
    }
  }, [api, keyword, limit, offset, readBy, loadAux])

  React.useEffect(() => { void load({ offset: 0 }) }, []) // initial load
  React.useEffect(() => { void loadMemory({ page: 0 }); void loadMeetings({ page: 0 }) }, [])

  const apartmentAction = async (kind) => {
    if (apartmentBusy) return
    setApartmentBusy(true)
    setApartmentMessage({ text: t('working'), tone: 'ok' })
    try {
      const root = rootInput.trim()
      if ((kind === 'setRoot' || kind === 'migrate') && root === '') throw new Error('root path is required')
      let result
      if (kind === 'setRoot') result = await api.apartmentSetRoot?.(root)
      else if (kind === 'migrate') result = await api.apartmentMigrate?.(root)
      else if (kind === 'backup') result = await api.apartmentBackup?.('manual-ui')
      else if (kind === 'restore') result = await api.apartmentRestore?.(root)
      else result = await api.apartmentVerify?.()
      result = unwrapRemote(result)
      const text = kind === 'backup'
        ? `备份完成${result?.backup ? '：' + result.backup : ''}`
        : kind === 'verify'
          ? (result?.ok === false ? '验证发现问题' : '验证通过')
          : JSON.stringify(result ?? { ok: true })
      setApartmentMessage({ text, tone: result?.ok === false ? 'danger' : 'ok' })
      const rawStatus = await api.apartmentStatus?.()
      const status = unwrapRemote(rawStatus)
      if (status !== undefined && status !== null) { setApartment(status); setRootInput(status.root ?? root) }
    } catch (caught) {
      setApartmentMessage({ text: errorTextOf(caught), tone: 'danger' })
    } finally {
      setApartmentBusy(false)
    }
  }

  const deleteMemory = async id => {
    if (typeof api.memoryForget !== 'function') return
    setMemoryBusy(true)
    try {
      const result = await api.memoryForget({ id, confirm: 'DELETE' })
      if (result?.ok === false) throw new Error(result.error ?? 'delete failed')
      setMemoryDeleteId(undefined)
      setMemoryMessage({ text: t('memoryDeleted'), tone: 'ok' })
      await loadMemory({ page: memoryPage, preserveMessage: true })
    } catch (caught) {
      setMemoryMessage({ text: t('memoryFailed', { error: errorTextOf(caught) }), tone: 'danger' })
    } finally {
      setMemoryBusy(false)
    }
  }

  const search = event => {
    if (event !== undefined) event.preventDefault()
    const nextKeyword = queryInput.trim()
    setKeyword(nextKeyword)
    setSelected(undefined)
    setDetail(undefined)
    void load({ offset: 0, keyword: nextKeyword })
  }
  const clearSearch = () => {
    setQueryInput('')
    setKeyword('')
    setSelected(undefined)
    setDetail(undefined)
    void load({ offset: 0, keyword: '' })
  }
  const applyReadBy = () => {
    const next = readByInput.trim()
    setReadBy(next)
    void load({ offset: 0, readBy: next })
  }
  const openDetail = async item => {
    setSelected(item)
    setDetail(undefined)
    try {
      const normalized = normalizeGetResult(await api.get(item.id, readBy, readBy !== ''))
      if (!normalized.ok) {
        if (normalized.gone) showToast(t('loadFailed', { error: 'gone' }), 'danger')
        else showToast(t('loadFailed', { error: normalized.error }), 'danger')
        setSelected(undefined)
      } else setDetail(normalized.item)
    } catch (caught) {
      showToast(t('loadFailed', { error: errorTextOf(caught) }), 'danger')
    }
  }
  const copyText = async text => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('copied'))
    } catch {
      try {
        const area = document.createElement('textarea')
        area.value = text
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
        showToast(t('copied'))
      } catch {
        showToast(t('copyFailed'), 'danger')
      }
    }
  }
  const confirmDelete = async () => {
    if (detail === undefined || deleting) return
    setDeleting(true)
    try {
      const normalized = normalizeDeleteResult(await api.delete(detail.id, DELETE_CONFIRM_WORD))
      setDeleting(false)
      setDeleteOpen(false)
      setDeleteTyped('')
      if (!normalized.ok) {
        showToast(t('deleteFailed', { error: normalized.error }), 'danger')
        return
      }
      showToast(t('deleted'))
      setSelected(undefined)
      setDetail(undefined)
      void load({ offset: 0 })
    } catch (caught) {
      setDeleting(false)
      showToast(t('deleteFailed', { error: errorTextOf(caught) }), 'danger')
    }
  }
  const submitSend = async () => {
    if (sending) return
    setSending(true)
    setSendError(undefined)
    try {
      const normalized = normalizeSendResult(await api.send(sendForm.to.trim(), sendForm.subject, sendForm.body, 'Web UI'))
      setSending(false)
      if (!normalized.ok) {
        setSendError(normalized.error)
        return
      }
      setSendOpen(false)
      setSendForm({ to: '', subject: '', body: '' })
      if (normalized.duplicate) showToast(t('sendDuplicate', { id: normalized.existingId ?? '' }))
      else showToast(t('sendSuccess', { id: normalized.messageId }))
      void load({ offset: 0 })
    } catch (caught) {
      setSending(false)
      setSendError(errorTextOf(caught))
    }
  }

  const pages = pageCount(total, limit)
  const memoryPages = Math.max(1, Math.ceil((memory?.total ?? 0) / 20))
  const meetingPages = Math.max(1, Math.ceil((meetings?.total ?? 0) / 20))
  const pageNumber = Math.floor(offset / limit) + 1

  return panel('div', { className: PAGE_CLASS, 'data-message-bus-page': '' },
    panel('div', { className: 'mb-hero' },
      panel('div', { className: 'mb-heroIcon' }, panel(MessageBusIcon, { size: 24 })),
      panel('div', { className: 'mb-heroBody' },
        panel('div', { className: 'mb-titleRow' },
          panel('h1', { style: style.title }, t('title')),
          panel('span', {
            className: 'mb-pill',
            'data-message-strict-mode': strictMode ? 'on' : 'off',
            style: { fontSize: 11.5 },
          }, strictMode ? t('strictModeOn') : t('strictModeOff'))),
        panel('p', { style: style.subtitle }, t('subtitle')),
        panel('div', { className: 'mb-kicker', style: { marginTop: 6 } }, t('networkLive'))),
      panel('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        allowSend ? panel('button', { type: 'button', style: buttonStyle('primary', false), onClick: () => { setSendOpen(true); setSendError(undefined) }, 'data-message-send-open': '' }, t('send')) : null,
        panel('button', { type: 'button', style: buttonStyle('default', loading), onClick: () => { void load({ offset }) }, disabled: loading }, loading ? t('loading') : t('refresh')))),
    network === undefined ? null : panel(NetworkSection, { t, network, api }),
    panel(ApartmentSection, {
      t, api, apartment, rootInput, setRootInput, busy: apartmentBusy, message: apartmentMessage,
      onSetRoot: () => { void apartmentAction('setRoot') },
      onMigrate: () => { void apartmentAction('migrate') },
      onBackup: () => { void apartmentAction('backup') },
      onRestore: () => { void apartmentAction('restore') },
      onVerify: () => { void apartmentAction('verify') },
    }),
    panel(MemorySection, {
      t, memory, query: memoryQuery, scope: memoryScope, setQuery: setMemoryQuery, setScope: setMemoryScope,
      page: memoryPage, pageCount: memoryPages, busy: memoryBusy, message: memoryMessage, pendingDelete: memoryDeleteId,
      onSearch: () => { void loadMemory({ page: 0 }) },
      onPage: next => { void loadMemory({ page: Math.max(0, Math.min(memoryPages - 1, next)) }) },
      onAskDelete: id => setMemoryDeleteId(id),
      onCancelDelete: () => setMemoryDeleteId(undefined),
      onConfirmDelete: id => { void deleteMemory(id) },
    }),
    panel(MeetingsSection, {
      t, meetings, query: meetingQuery, status: meetingStatus, setQuery: setMeetingQuery, setStatus: setMeetingStatus,
      page: meetingPage, pageCount: meetingPages, busy: meetingBusy, message: meetingMessage,
      onSearch: () => { void loadMeetings({ page: 0 }) },
      onPage: next => { void loadMeetings({ page: Math.max(0, Math.min(meetingPages - 1, next)) }) },
      onOpen: id => { void openMeetingDetail(id) },
    }),
    panel('form', { style: style.toolbar, onSubmit: search },
      panel('input', {
        type: 'search',
        value: queryInput,
        placeholder: t('searchPlaceholder'),
        style: style.input,
        'aria-label': t('searchPlaceholder'),
        'data-message-search': '',
        onChange: event => setQueryInput(event.target.value),
      }),
      panel('button', { type: 'submit', style: style.primary, 'data-message-search-submit': '' }, t('search')),
      panel('button', { type: 'button', style: style.button, onClick: clearSearch }, t('clear')),
      panel('input', {
        type: 'text',
        value: readByInput,
        placeholder: t('readByPlaceholder'),
        style: { ...style.input, ...style.narrow },
        'aria-label': t('readByLabel'),
        'data-message-readby': '',
        onChange: event => setReadByInput(event.target.value),
        onBlur: applyReadBy,
      })),
    panel('div', { style: style.meta },
      panel('span', null, t('stats', { total: String(total), shown: String(items.length) })),
      typeof counts.messages === 'number' ? panel('span', null, 'DB messages: ' + String(counts.messages)) : null,
      readBy === '' ? null : panel('span', null, t('readByLabel') + ': ' + readBy)),
    error === undefined ? null : panel('div', { style: style.errorBox }, t('loadFailed', { error })),
    panel(Toast, { text: toast?.text, tone: toast?.tone }),
    loading ? panel('p', { style: style.empty }, t('loading')) : null,
    !loading && items.length === 0 ? panel('p', { style: style.empty }, t('empty')) : null,
    panel('div', null, items.map(item => panel(MessageRow, {
      key: item.id,
      t,
      item,
      selected: selected?.id === item.id,
      onOpen: open => { void openDetail(open) },
    }))),
    panel('div', { style: style.pager },
      panel('button', {
        type: 'button',
        style: buttonStyle(null, offset <= 0),
        disabled: offset <= 0,
        onClick: () => { void load({ offset: Math.max(0, offset - limit) }) },
        'data-message-prev': '',
      }, t('prevPage')),
      panel('span', null, t('page', { page: String(pageNumber), pages: String(pages) })),
      panel('button', {
        type: 'button',
        style: buttonStyle(null, offset + limit >= total),
        disabled: offset + limit >= total,
        onClick: () => { void load({ offset: offset + limit }) },
        'data-message-next': '',
      }, t('nextPage'))),
    meetingDetail === undefined ? null : panel(MeetingDetailDialog, {
      t,
      detail: meetingDetail,
      busy: meetingDetailBusy,
      onClose: () => setMeetingDetail(undefined),
    }),
    detail === undefined ? null : panel('div', { className: 'mb-overlay', onMouseDown: event => { if (event.target === event.currentTarget) { setSelected(undefined); setDetail(undefined) } } },      panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('detailTitle'), 'data-message-detail': '' },
        panel(MessageDetail, {
          t,
          item: detail,
          readBy,
          onClose: () => { setSelected(undefined); setDetail(undefined) },
          onDelete: () => { setDeleteTyped(''); setDeleteOpen(true) },
          onCopyBody: () => { void copyText(detail.body) },
          onCopyQuote: () => { void copyText(quoteMessage(detail)) },
        }))),
    deleteOpen && detail !== undefined ? panel(DeleteDialog, {
      t,
      item: detail,
      busy: deleting,
      typed: deleteTyped,
      onTyped: setDeleteTyped,
      onCancel: () => { setDeleteOpen(false); setDeleteTyped('') },
      onConfirm: () => { void confirmDelete() },
    }) : null,
    sendOpen ? panel(SendDialog, {
      t,
      sending,
      form: sendForm,
      error: sendError,
      onField: (field, value) => setSendForm(previous => ({ ...previous, [field]: value })),
      onCancel: () => { setSendOpen(false); setSendError(undefined) },
      onSubmit: () => { void submitSend() },
    }) : null)
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'message-bus client: dictionaries')
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    const existing = document.querySelector('style[data-plugin="message-bus"]')
    if (existing !== null) return () => existing.remove()
    const styleElement = document.createElement('style')
    styleElement.dataset.plugin = 'message-bus'
    styleElement.textContent = CSS
    document.head.appendChild(styleElement)
    return () => styleElement.remove()
  }, 'message-bus client: styles')
  ctx.plugin(async function mountMessageBusRemote(owner) {
    // Mount the auxiliary Agent Network remotes first; the messageBus Remote
    // access gate below then guarantees the board/apartment data is reachable.
    try { await owner.remote.$mount(createBoardRemoteContribution()) } catch { /* bulletin-board row may be absent */ }
    try { await owner.remote.$mount(createApartmentRemoteContribution()) } catch { /* apartment row may be absent */ }
    await owner.remote.$mount(createRemoteContribution())
  })
  ctx.inject(['remote.messageBus', 'remote.agentApartment'], scope => {
    scope.remoteAccess.whenAccess('messageBus/list', function* () {
      const t = scope.locale.bind(LOCALE_NS)
      const api = {
        list: (keyword, limit, offset, readBy) => scope.remote.messageBus.list(keyword, limit, offset, readBy),
        search: (keyword, limit, offset, readBy) => scope.remote.messageBus.search(keyword, limit, offset, readBy),
        get: (messageId, readBy, markRead) => scope.remote.messageBus.get(messageId, readBy, markRead),
        delete: (messageId, confirm) => scope.remote.messageBus.delete(messageId, confirm),
        send: (to, subject, body, from) => scope.remote.messageBus.send(to, subject, body, from),
        apartmentStatus: () => scope.remote.agentApartment.status(),
        apartmentData: query => scope.remote.agentApartment.data(query),
        apartmentSetRoot: root => scope.remote.agentApartment.setRoot(root),
        apartmentMigrate: to => scope.remote.agentApartment.migrate(to),
        apartmentBackup: label => scope.remote.agentApartment.backup(label),
        apartmentRestore: from => scope.remote.agentApartment.restore(from),
        apartmentVerify: () => scope.remote.agentApartment.verify(),
        tasksPage: query => scope.remote.messageBus.tasksPage(query),
        memoryPage: query => scope.remote.messageBus.memoryPage(query),
        memoryForget: query => scope.remote.messageBus.memoryForget(query),
        meetingsPage: query => scope.remote.messageBus.meetingsPage(query),
        meetingDetail: query => scope.remote.messageBus.meetingDetail(query),
      }
      yield scope.slots.inject('sidebar.panellist', () => scope.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        locale: LOCALE_NS,
        label: () => t('panel'),
      }, MessageBusIcon))
      yield scope.slots.inject('main', () => scope.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({ api }),
      }, MessageCenterPage))
    })
  })
}

exports.apply = apply
exports.inject = inject


		return module.exports;
	}
});
//# sourceURL=dsh-message-bus/client.js
