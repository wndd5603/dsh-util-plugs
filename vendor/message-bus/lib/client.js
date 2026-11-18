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
/** CR1/F3: meeting-detail pages are bounded, but the dialog can append pages. */
const MEETING_DETAIL_PAGE_SIZE = 50
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
        id: 'dsh-message-bus/messageBus/taskDetail',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'taskDetail',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/taskDetail:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/visibilitySummary',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'visibilitySummary',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/visibilitySummary:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/visibilityPage',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'visibilityPage',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/visibilityPage:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/visibilityDetail',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'visibilityDetail',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/visibilityDetail:result'),
      },
      {
        id: 'dsh-message-bus/messageBus/subenvStatus',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'subenvStatus',
        invocation: { kind: 'direct' },
        parameters: [],
        result: identityCodec('dsh-message-bus#messageBus/subenvStatus:result'),
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
      {
        id: 'dsh-message-bus/messageBus/networkPage',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'networkPage',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/networkPage:result'),
        description: 'Paginated read-only sessions/aliases directory from the session network.',
      },
      {
        id: 'dsh-message-bus/messageBus/messageAudit',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'messageAudit',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('query')],
        result: identityCodec('dsh-message-bus#messageBus/messageAudit:result'),
        description: 'Read-only delivery/read-receipt/envelope/routing audit for one message; never returns the body.',
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

/**
 * CR1/F3: append the next meetingDetail page to the already rendered dialog.
 * Rows are de-duplicated by msgId so an offset shifted by a concurrent post
 * cannot render the same speech twice. A different meeting replaces the page.
 */
function mergeMeetingDetailPage(previous, page, append = true) {
  if (page === null || typeof page !== 'object') return page
  if (append !== true || previous === null || typeof previous !== 'object') return page
  const previousId = previous.meeting?.meetingId
  const nextId = page.meeting?.meetingId
  if (typeof previousId === 'string' && typeof nextId === 'string' && previousId !== nextId) return page
  const existing = Array.isArray(previous.messages) ? previous.messages : []
  const seen = new Set(existing.map(message => message?.msgId))
  const incoming = Array.isArray(page.messages)
    ? page.messages.filter(message => message !== null && typeof message === 'object' && !seen.has(message.msgId))
    : []
  return { ...page, messages: [...existing, ...incoming] }
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
  directoryTitle: '成员 / 别名',
  directorySubtitle: '只读浏览会话与别名；支持搜索、分页和长名称折叠。',
  sessionsLabel: '会话',
  aliasesLabel: '别名',
  sessionsSearch: '搜索会话 / 别名（名称 / shortId / 角色 / 别名）',
  sessionsEmpty: '暂无会话。',
  aliasesEmpty: '暂无别名。',
  lastSeen: '最近活动',
  roleLabel: '角色',
  rootLabel: '根',
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
  meetingDetailCount: '已显示 {shown} / 共 {total} 条消息',
  meetingLoadMore: '加载更多',
  meetingLoadingMore: '正在加载…',
  meetingAllLoaded: '已全部加载（共 {total} 条）',
  webReadOnly: 'Web 端只读：不显示或修改已读回执。',
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
  auditTitle: '投递 / 回执 / 审计',
  auditReadOnly: '只读',
  auditDeliveries: '投递',
  auditReadState: '回执',
  auditEnvelopes: '信封',
  auditRoutes: '路由',
  auditEmpty: '暂无审计记录。',
  auditNone: '暂无记录',
  auditGone: '消息已不存在，无法读取审计。',
  auditFailed: '审计加载失败：{error}',
  deliveredAt: '投递于',
  consumedAt: '消费于',
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
  directoryTitle: 'Sessions / aliases',
  directorySubtitle: 'Read-only session and alias directory with search, paging and long-name folding.',
  sessionsLabel: 'Sessions',
  aliasesLabel: 'Aliases',
  sessionsSearch: 'Search sessions / aliases (name / shortId / role / alias)',
  sessionsEmpty: 'No sessions yet.',
  aliasesEmpty: 'No aliases yet.',
  lastSeen: 'Last seen',
  roleLabel: 'Role',
  rootLabel: 'Root',
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
  meetingDetailCount: '{shown} of {total} messages shown',
  meetingLoadMore: 'Load more',
  meetingLoadingMore: 'Loading…',
  meetingAllLoaded: 'All {total} messages loaded',
  webReadOnly: 'Web view is read-only: read receipts are neither shown nor modified here.',
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
  auditTitle: 'Delivery / read receipts / audit',
  auditReadOnly: 'read-only',
  auditDeliveries: 'Deliveries',
  auditReadState: 'Read receipts',
  auditEnvelopes: 'Envelopes',
  auditRoutes: 'Routes',
  auditEmpty: 'No audit records yet.',
  auditNone: 'No records',
  auditGone: 'The message no longer exists; audit unavailable.',
  auditFailed: 'Audit load failed: {error}',
  deliveredAt: 'Delivered',
  consumedAt: 'Consumed',
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
.mb-subsection { margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(127,127,127,0.18); }
.mb-subsection summary { cursor: pointer; font-size: 13px; font-weight: 600; }
.mb-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-nameFold { min-width: 0; }
.mb-nameFold > summary { cursor: pointer; }
.mb-auditFlags { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.mb-flag { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.25); font-size: 11px; white-space: nowrap; opacity: .5; }
.mb-flag[data-on="true"] { opacity: 1; color: rgb(120,170,255); border-color: rgba(79,140,255,0.45); }
.mb-subhead { margin: 12px 0 4px; font-size: 12.5px; font-weight: 600; }
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

/** First non-empty field, accepting both camelCase (plan) and snake_case (DB rows). */
function fieldOf(row, camel, snake) {
  if (row === null || typeof row !== 'object') return undefined
  if (row[camel] !== undefined && row[camel] !== null) return row[camel]
  return snake === undefined ? undefined : (row[snake] ?? undefined)
}

function aliasNamesOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(entry => typeof entry === 'string' ? entry : entry?.alias)
    .filter(name => typeof name === 'string' && name !== '')
}

/** Short label that folds long display names into a native <details> disclosure. */
function LongName(props) {
  const raw = props.value
  const value = typeof raw === 'string' && raw !== '' ? raw : '—'
  const limit = typeof props.limit === 'number' && props.limit > 8 ? props.limit : 40
  if (value.length <= limit) return panel('span', { className: 'mb-ellipsis', title: value }, value)
  return panel('details', { className: 'mb-nameFold', 'data-long-name': '' },
    panel('summary', { className: 'mb-ellipsis', title: value }, value.slice(0, limit) + '…'),
    panel('div', { className: 'mb-mono', style: { whiteSpace: 'normal', overflowWrap: 'anywhere', marginTop: 4 } }, value))
}

function SessionRow(props) {
  const { t, session } = props
  const sessionId = fieldOf(session, 'sessionId', 'session_id')
  const shortId = fieldOf(session, 'shortId', 'short_id')
  const displayName = fieldOf(session, 'displayName', 'display_name')
  const roleName = fieldOf(session, 'roleName', 'role_name')
  const lastSeen = fieldOf(session, 'lastSeen', 'last_seen')
  const status = fieldOf(session, 'status')
  const aliases = aliasNamesOf(fieldOf(session, 'aliases'))
  return panel('article', {
    className: 'mb-task',
    'data-network-session': typeof sessionId === 'string' ? sessionId : (typeof shortId === 'string' ? shortId : ''),
  },
  panel('div', { className: 'mb-taskTitle' },
    panel(LongName, { value: displayName || shortId || sessionId || '—' }),
    panel('span', { className: 'mb-pill', 'data-status': typeof status === 'string' ? status : '' }, typeof status === 'string' && status !== '' ? status : '—')),
  panel('div', { className: 'mb-taskMeta' },
    typeof shortId === 'string' && shortId !== '' ? panel('span', { className: 'mb-mono', title: shortId }, shortId) : null,
    typeof roleName === 'string' && roleName !== '' ? panel('span', null, `${t('roleLabel')}: ${roleName}`) : null,
    aliases.length > 0 ? panel('span', { className: 'mb-ellipsis', style: { maxWidth: '100%' }, title: aliases.join(', ') }, `${t('aliasesLabel')}: ${aliases.join(', ')}`) : null,
    typeof lastSeen === 'string' && lastSeen !== '' ? panel('span', null, `${t('lastSeen')}: ${formatTime(lastSeen)}`) : null))
}

function AliasRow(props) {
  const { t, alias } = props
  const aliasName = typeof alias?.alias === 'string' && alias.alias !== '' ? alias.alias : '—'
  const sessionId = fieldOf(alias, 'sessionId', 'session_id')
  const rootName = fieldOf(alias, 'rootName', 'root_name')
  const roleName = fieldOf(alias, 'roleName', 'role_name')
  const status = fieldOf(alias, 'status')
  return panel('article', { className: 'mb-task', 'data-network-alias': aliasName },
    panel('div', { className: 'mb-taskTitle' },
      panel('span', { className: 'mb-mono mb-ellipsis', title: aliasName }, aliasName),
      panel('span', { className: 'mb-pill', 'data-status': typeof status === 'string' ? status : '' }, typeof status === 'string' && status !== '' ? status : '—')),
    panel('div', { className: 'mb-taskMeta' },
      typeof sessionId === 'string' && sessionId !== '' ? panel('span', { className: 'mb-mono', title: sessionId }, sessionId) : null,
      typeof rootName === 'string' && rootName !== '' ? panel('span', null, `${t('rootLabel')}: ${rootName}`) : null,
      typeof roleName === 'string' && roleName !== '' ? panel('span', null, `${t('roleLabel')}: ${roleName}`) : null))
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

function AuditList(props) {
  const { label, rows, empty, render } = props
  return panel('div', { style: { marginTop: 10 } },
    panel('h4', { className: 'mb-subhead' }, `${label} (${rows.length})`),
    rows.length === 0
      ? panel('p', { className: 'mb-muted', style: { margin: '4px 0' } }, empty)
      : panel('div', { className: 'mb-taskList', style: { maxHeight: '28vh', overflow: 'auto' } }, rows.map((row, index) => panel('article', {
        key: row?.id ?? row?.sessionId ?? row?.session_id ?? row?.alias ?? index,
        className: 'mb-task',
      }, render(row, index)))))
}

function MessageDetail(props) {
  const { t, api, item, onClose, onDelete, onCopyBody, onCopyQuote } = props
  const auditPageSize = 20
  const [auditOpen, setAuditOpen] = React.useState(false)
  const [auditPage, setAuditPage] = React.useState(0)
  const [audit, setAudit] = React.useState(undefined)
  const [auditBusy, setAuditBusy] = React.useState(false)
  const [auditError, setAuditError] = React.useState(undefined)

  React.useEffect(() => {
    setAudit(undefined)
    setAuditPage(0)
    setAuditError(undefined)
  }, [item.id])

  React.useEffect(() => {
    if (!auditOpen || typeof api?.messageAudit !== 'function') return undefined
    let cancelled = false
    setAuditBusy(true)
    setAuditError(undefined)
    Promise.resolve().then(() => api.messageAudit({ messageId: item.id, limit: auditPageSize, offset: auditPage * auditPageSize }))
      .then(result => {
        if (cancelled) return
        if (result !== null && typeof result === 'object' && result.ok === false) {
          setAuditError(result.gone === true
            ? t('auditGone')
            : (typeof result.error === 'string' ? result.error : remoteErrorText(result)))
          return
        }
        const value = unwrapRemote(result)
        if (value !== null && typeof value === 'object' && value.ok === false) {
          setAuditError(value.gone === true
            ? t('auditGone')
            : (typeof value.error === 'string' ? value.error : 'message audit unavailable'))
          return
        }
        if (value !== null && typeof value === 'object') setAudit(value)
      })
      .catch(caught => { if (!cancelled) setAuditError(errorTextOf(caught)) })
      .finally(() => { if (!cancelled) setAuditBusy(false) })
    return () => { cancelled = true }
  }, [api, item.id, auditOpen, auditPage])

  const deliveries = Array.isArray(audit?.deliveries) ? audit.deliveries : []
  const readState = Array.isArray(audit?.readState) ? audit.readState : (Array.isArray(audit?.read_state) ? audit.read_state : [])
  const envelopes = Array.isArray(audit?.envelopes) ? audit.envelopes : []
  const routes = Array.isArray(audit?.routes) ? audit.routes : []
  const auditLimit = typeof audit?.limit === 'number' && audit.limit > 0 ? audit.limit : auditPageSize
  const auditTotal = typeof audit?.total === 'number' ? audit.total : deliveries.length
  const auditPages = pageCount(auditTotal, auditLimit)
  const auditOffset = typeof audit?.offset === 'number' ? audit.offset : auditPage * auditLimit
  const auditPageNumber = Math.floor(Math.max(0, auditOffset) / auditLimit) + 1
  const auditEmpty = !auditBusy && audit !== undefined && deliveries.length === 0 && readState.length === 0 && envelopes.length === 0 && routes.length === 0

  const sessionIdOf = row => {
    const value = fieldOf(row, 'sessionId', 'session_id')
    return typeof value === 'string' && value !== '' ? value : '—'
  }
  const renderDelivery = delivery => panel('div', null,
    panel('div', { className: 'mb-taskTitle' },
      panel('span', { className: 'mb-mono mb-ellipsis', title: sessionIdOf(delivery) }, sessionIdOf(delivery)),
      panel('span', { className: 'mb-muted' }, formatTime(delivery?.at))),
    panel('div', { className: 'mb-taskMeta' },
      typeof delivery?.id === 'string' && delivery.id !== '' ? panel('span', { className: 'mb-mono', title: delivery.id }, delivery.id) : null,
      panel('span', { className: 'mb-auditFlags' }, ['duplicate', 'suppressed', 'delivered', 'coalesced', 'resumed'].map(flag => panel('span', {
        key: flag,
        className: 'mb-flag',
        'data-on': delivery?.[flag] === true ? 'true' : 'false',
      }, flag))),
      typeof delivery?.error === 'string' && delivery.error !== '' ? panel('span', { style: { color: 'rgb(235,145,120)' }, title: delivery.error }, 'error: ' + delivery.error) : null))

  const renderReadState = entry => panel('div', null,
    panel('div', { className: 'mb-taskTitle' },
      panel('span', { className: 'mb-mono mb-ellipsis', title: sessionIdOf(entry) }, sessionIdOf(entry)),
      panel('span', { className: 'mb-muted' }, formatTime(fieldOf(entry, 'readAt', 'read_at')))))

  const renderEnvelope = entry => panel('div', null,
    panel('div', { className: 'mb-taskTitle' },
      panel('span', { className: 'mb-mono mb-ellipsis', title: sessionIdOf(entry) }, sessionIdOf(entry)),
      panel('span', { className: 'mb-muted' }, `${t('deliveredAt')}: ${formatTime(fieldOf(entry, 'deliveredAt', 'delivered_at'))}`)),
    panel('div', { className: 'mb-taskMeta' },
      panel('span', null, `${t('consumedAt')}: ${formatTime(fieldOf(entry, 'consumedAt', 'consumed_at'))}`)))

  const renderRoute = entry => panel('div', null,
    panel('div', { className: 'mb-taskTitle' },
      panel('span', { className: 'mb-mono mb-ellipsis', title: String(entry?.alias ?? '') }, String(entry?.alias ?? '—')),
      panel('span', { className: 'mb-muted mb-ellipsis', title: String(entry?.displayName ?? '') }, String(entry?.displayName ?? ''))),
    panel('div', { className: 'mb-taskMeta' },
      panel('span', { className: 'mb-mono', title: sessionIdOf(entry) }, sessionIdOf(entry))))

  return panel('div', null,
    panel('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' } },
      panel('h2', { style: { margin: 0, fontSize: '16px' } }, t('detailTitle')),
      panel('button', { type: 'button', style: style.button, onClick: onClose, 'aria-label': t('close') }, t('close'))),
    detailRow(t('from'), messageText(item)),
    detailRow(t('to'), item.to),
    detailRow(t('subject'), item.subject || t('noSubject')),
    panel('p', { className: 'mb-muted', 'data-message-readonly': '' }, t('webReadOnly')),
    panel('p', { style: style.detailBody, 'data-message-detail-body': '' }, item.body),
    panel('div', { className: 'mb-actions', style: { justifyContent: 'flex-start' } },
      panel('button', { type: 'button', className: 'mb-button', onClick: onCopyBody, 'data-message-copy': '' }, t('copyBody')),
      panel('button', { type: 'button', className: 'mb-button', onClick: onCopyQuote, 'data-message-quote': '' }, t('copyQuote')),
      panel('button', { type: 'button', className: 'mb-button mb-danger', onClick: onDelete, 'data-message-delete': '' }, t('delete'))),
    panel('details', {
      className: 'mb-subsection',
      'data-message-audit': '',
      onToggle: event => setAuditOpen(event.currentTarget.open === true),
    },
    panel('summary', { 'data-message-audit-summary': '' }, t('auditTitle'), ' ', panel('span', { className: 'mb-muted' }, `(${t('auditReadOnly')})`)),
    auditError === undefined ? null : panel('p', { className: 'mb-feedback', 'data-tone': 'danger', role: 'status' }, t('auditFailed', { error: auditError })),
    auditBusy && audit === undefined ? panel('p', { className: 'mb-muted' }, t('loading')) : null,
    audit?.message ? panel('div', { className: 'mb-taskMeta', style: { marginTop: 8 } },
      typeof audit.message.id === 'string' ? panel('span', { className: 'mb-mono' }, audit.message.id) : null,
      typeof audit.message.bytes === 'number' ? panel('span', null, formatBytes(audit.message.bytes)) : null,
      typeof audit.message.sha256 === 'string' && audit.message.sha256 !== '' ? panel('span', { className: 'mb-mono', title: audit.message.sha256 }, audit.message.sha256.slice(0, 12) + '…') : null,
      typeof audit.message.readAt === 'string' && audit.message.readAt !== '' ? panel('span', null, t('readAt', { time: formatTime(audit.message.readAt) })) : null) : null,
    audit === undefined ? null : (auditEmpty
      ? panel('p', { className: 'mb-muted', style: { marginTop: 8 } }, t('auditEmpty'))
      : panel('div', null,
        panel(AuditList, { label: t('auditDeliveries'), rows: deliveries, empty: t('auditNone'), render: renderDelivery }),
        panel(AuditList, { label: t('auditReadState'), rows: readState, empty: t('auditNone'), render: renderReadState }),
        panel(AuditList, { label: t('auditEnvelopes'), rows: envelopes, empty: t('auditNone'), render: renderEnvelope }),
        panel(AuditList, { label: t('auditRoutes'), rows: routes, empty: t('auditNone'), render: renderRoute }))),
    audit === undefined ? null : panel('div', { className: 'mb-actionRow', style: { justifyContent: 'space-between', marginTop: 10 } },
      panel('span', { className: 'mb-muted', 'data-message-audit-page': String(auditPageNumber) },
        auditBusy ? t('working') : t('pageInfo', { page: auditPageNumber, pages: auditPages, total: auditTotal })),
      panel('div', { style: { display: 'flex', gap: 6 } },
        panel('button', {
          type: 'button', className: 'mb-chipButton', disabled: auditBusy || auditPage <= 0,
          onClick: () => setAuditPage(Math.max(0, auditPage - 1)),
        }, t('prevPage')),
        panel('button', {
          type: 'button', className: 'mb-chipButton', disabled: auditBusy || auditPage >= auditPages - 1,
          onClick: () => setAuditPage(auditPage + 1),
        }, t('nextPage'))))))
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
  const { t, network: networkValue, api } = props
  // The bulletin-board snapshot is optional: a clean profile has no board DB,
  // but the session/alias directory must still render. Boards/tasks then keep
  // their explicit empty state instead of hiding the whole section.
  const network = networkValue !== null && typeof networkValue === 'object' ? networkValue : {}
  const boards = Array.isArray(network.boards) ? network.boards : []
  const tasks = Array.isArray(network.tasks) ? network.tasks : []
  const counts = network.counts !== null && typeof network.counts === 'object' ? network.counts : {}
  const statuses = ['pending', 'in_progress', 'blocked', 'suspended', 'completed', 'terminated']
  const currentSessionId = typeof network.sessionId === 'string' ? network.sessionId : null
  const currentWorkspace = typeof network.workspace === 'string' ? network.workspace : null
  const preferredBoard = (currentWorkspace === null ? undefined : boards.find(board => board.workspace === currentWorkspace))
    ?? (currentSessionId === null ? undefined : boards.find(board => board.ownerSession === currentSessionId))
  const orderedBoards = preferredBoard === undefined ? boards : [preferredBoard, ...boards.filter(board => board.id !== preferredBoard.id)]
  const [selectedBoardId, setSelectedBoardId] = React.useState(preferredBoard?.id ?? boards[0]?.id)
  const [statusFilter, setStatusFilter] = React.useState('all')
  const [selectedTaskId, setSelectedTaskId] = React.useState(undefined)
  const [taskQuery, setTaskQuery] = React.useState('')
  const [taskPage, setTaskPage] = React.useState(0)
  const [serverPage, setServerPage] = React.useState(undefined)
  const [taskLoading, setTaskLoading] = React.useState(false)
  const [taskDetailData, setTaskDetailData] = React.useState(undefined)
  const [directoryQueryInput, setDirectoryQueryInput] = React.useState('')
  const [directoryQuery, setDirectoryQuery] = React.useState('')
  const [directoryPage, setDirectoryPage] = React.useState(0)
  const [directoryData, setDirectoryData] = React.useState(undefined)
  const [directoryBusy, setDirectoryBusy] = React.useState(false)
  const [directoryError, setDirectoryError] = React.useState(undefined)
  const taskPageSize = 20
  const directoryPageSize = 10
  const activeBoard = orderedBoards.find(board => board.id === selectedBoardId) ?? orderedBoards[0]
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
  const directorySessions = Array.isArray(directoryData?.sessions) ? directoryData.sessions : []
  const directoryAliases = Array.isArray(directoryData?.aliases) ? directoryData.aliases : []
  const directoryCounts = directoryData?.counts !== null && directoryData?.counts !== undefined && typeof directoryData.counts === 'object' ? directoryData.counts : {}
  const directoryTotal = typeof directoryData?.total === 'number' ? directoryData.total : (typeof directoryCounts.sessions === 'number' ? directoryCounts.sessions : directorySessions.length)
  const directoryPages = pageCount(directoryTotal, directoryPageSize)
  const directoryAliasTotal = typeof directoryCounts.aliases === 'number' ? directoryCounts.aliases : directoryAliases.length
  const selectBoard = boardId => { setSelectedBoardId(boardId); setSelectedTaskId(undefined); setTaskPage(0); setServerPage(undefined) }
  const openTaskDetail = async id => {
    if (typeof api?.taskDetail !== 'function') return
    try { setTaskDetailData(unwrapRemote(await api.taskDetail({ id }))) } catch (caught) { setTaskDetailData({ ok: false, error: errorTextOf(caught) }) }
  }

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

  React.useEffect(() => {
    if (typeof api?.networkPage !== 'function') return undefined
    let cancelled = false
    setDirectoryBusy(true)
    setDirectoryError(undefined)
    Promise.resolve().then(() => api.networkPage({
      query: directoryQuery,
      limit: directoryPageSize,
      offset: directoryPage * directoryPageSize,
    })).then(result => {
      if (cancelled) return
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setDirectoryError(typeof result.error === 'string' ? result.error : remoteErrorText(result))
        setDirectoryData({ sessions: [], aliases: [], total: 0 })
        return
      }
      const value = unwrapRemote(result)
      if (value !== null && typeof value === 'object' && value.ok === false) {
        setDirectoryError(typeof value.error === 'string' ? value.error : 'network page unavailable')
        setDirectoryData({ sessions: [], aliases: [], total: 0 })
        return
      }
      setDirectoryData(value !== null && typeof value === 'object' ? value : { sessions: [], aliases: [], total: 0 })
    }).catch(caught => { if (!cancelled) setDirectoryError(errorTextOf(caught)) })
      .finally(() => { if (!cancelled) setDirectoryBusy(false) })
    return () => { cancelled = true }
  }, [api, directoryQuery, directoryPage])

  const boardGrid = panel('div', { className: 'mb-boardGrid' }, orderedBoards.slice(0, 8).map(board => {
    const active = activeBoard?.id === board.id
    return panel('article', {
      key: board.id,
      className: 'mb-board',
      role: 'button',
      tabIndex: 0,
      'data-active': active ? 'true' : 'false',
      'data-current': preferredBoard?.id === board.id ? 'true' : 'false',
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
      onClick: () => { setSelectedTaskId(current => current === task.id ? undefined : task.id); void openTaskDetail(task.id) },
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
    selectedTask.blockedReason ? panel('p', null, `${t('blockedReason')}: ${selectedTask.blockedReason}`) : null,
    taskDetailData?.task?.metadata ? panel('details', null,
      panel('summary', { className: 'mb-muted' }, 'metadata'),
      panel('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '28vh', overflow: 'auto', fontSize: 11.5 } }, taskDetailData.task.metadata)) : null,
    Array.isArray(taskDetailData?.events) && taskDetailData.events.length > 0 ? panel('details', null,
      panel('summary', { className: 'mb-muted' }, `events (${taskDetailData.events.length})`),
      panel('ul', { style: { maxHeight: '32vh', overflow: 'auto', fontSize: 11.5 } },
        taskDetailData.events.slice(0, 50).map(event => panel('li', { key: event.id }, `${event.at} · ${event.actor ?? ''} · ${event.action} · ${event.detail ?? ''}`)))) : null)

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

  const submitDirectorySearch = event => {
    if (event !== undefined) event.preventDefault()
    setDirectoryQuery(directoryQueryInput.trim())
    setDirectoryPage(0)
  }

  const directoryPanel = panel('div', { className: 'mb-subsection', 'data-network-directory': '' },
    panel('div', { className: 'mb-cardHead' },
      panel('div', null,
        panel('h3', { className: 'mb-cardTitle', style: { fontSize: '13.5px' } }, t('directoryTitle')),
        panel('p', { className: 'mb-cardSub' }, t('directorySubtitle'))),
      panel('span', { className: 'mb-kicker' }, t('pageInfo', { page: directoryPage + 1, pages: directoryPages, total: directoryTotal }))),
    panel('form', { className: 'mb-actionRow', onSubmit: submitDirectorySearch },
      panel('input', {
        type: 'search',
        value: directoryQueryInput,
        placeholder: t('sessionsSearch'),
        className: 'mb-inlineInput',
        'aria-label': t('sessionsSearch'),
        'data-network-search': '',
        onChange: event => setDirectoryQueryInput(event.target.value),
      }),
      panel('button', { type: 'submit', className: 'mb-chipButton', 'data-network-search-submit': '' }, t('search')),
      panel('button', {
        type: 'button',
        className: 'mb-chipButton',
        onClick: () => { setDirectoryQueryInput(''); setDirectoryQuery(''); setDirectoryPage(0) },
      }, t('clear'))),
    directoryError === undefined ? null : panel('p', { className: 'mb-feedback', 'data-tone': 'danger', role: 'status' }, t('loadFailed', { error: directoryError })),
    panel('h4', { className: 'mb-subhead' }, `${t('sessionsLabel')} (${directorySessions.length}/${directoryTotal})`),
    directorySessions.length === 0
      ? panel('p', { className: 'mb-muted', style: { margin: '4px 0' } }, directoryBusy ? t('working') : t('sessionsEmpty'))
      : panel('div', { className: 'mb-taskList', style: { maxHeight: '32vh', overflow: 'auto' } }, directorySessions.map((session, index) => panel(SessionRow, {
        key: session.sessionId ?? session.shortId ?? session.short_id ?? index,
        t,
        session,
      }))),
    panel('h4', { className: 'mb-subhead' }, `${t('aliasesLabel')} (${directoryAliasTotal})`),
    directoryAliases.length === 0
      ? panel('p', { className: 'mb-muted', style: { margin: '4px 0' } }, directoryBusy ? t('working') : t('aliasesEmpty'))
      : panel('div', { className: 'mb-taskList', style: { maxHeight: '32vh', overflow: 'auto' } }, directoryAliases.map((alias, index) => panel(AliasRow, {
        key: alias.alias ?? index,
        t,
        alias,
      }))),
    panel('div', { className: 'mb-actionRow', style: { justifyContent: 'space-between' } },
      panel('span', { className: 'mb-muted', 'data-network-page': String(directoryPage + 1) },
        directoryBusy ? t('working') : t('pageInfo', { page: directoryPage + 1, pages: directoryPages, total: directoryTotal })),
      panel('div', { style: { display: 'flex', gap: 6 } },
        panel('button', {
          type: 'button', className: 'mb-chipButton', disabled: directoryBusy || directoryPage <= 0,
          onClick: () => setDirectoryPage(Math.max(0, directoryPage - 1)),
        }, t('prevPage')),
        panel('button', {
          type: 'button', className: 'mb-chipButton', disabled: directoryBusy || directoryPage >= directoryPages - 1,
          onClick: () => setDirectoryPage(directoryPage + 1),
        }, t('nextPage')))))

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
    countsRow,
    directoryPanel)
}

function ApartmentSection(props) {
  const { t, api, rootInput, setRootInput, busy, message, onSetRoot, onMigrate, onBackup, onRestore, onVerify } = props
  const [section, setSection] = React.useState('agents')
  const [detailQuery, setDetailQuery] = React.useState('')
  const [detailPage, setDetailPage] = React.useState(0)
  const [detail, setDetail] = React.useState(undefined)
  const [detailBusy, setDetailBusy] = React.useState(false)
  const [dialog, setDialog] = React.useState(undefined)
  const [pathInput, setPathInput] = React.useState('')
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
  const openDialog = kind => {
    setDialog(kind)
    setPathInput(kind === 'restore' ? '' : (rootInput || apartment?.root || ''))
  }
  const confirmDialog = () => {
    const path = pathInput.trim()
    if (dialog === 'setRoot') onSetRoot(path)
    else if (dialog === 'migrate') onMigrate(path)
    else if (dialog === 'restore') onRestore(path)
    setDialog(undefined)
  }
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
      panel('span', { className: 'mb-muted', 'data-apartment-root': '' }, apartment.root ?? rootInput ?? ''),
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: () => openDialog('setRoot') }, '切换根目录'),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: () => openDialog('migrate') }, t('apartmentMigrate')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onBackup }, t('apartmentBackup')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: () => openDialog('restore') }, t('apartmentRestore')),
      panel('button', { type: 'button', style: buttonStyle('default', busy), disabled: busy, onClick: onVerify }, t('apartmentVerify'))),
    feedback === undefined ? null : panel('p', {
      className: 'mb-feedback',
      'data-tone': feedback.tone === 'danger' ? 'danger' : 'ok',
      role: 'status',
      'aria-live': 'polite',
    }, feedback.text),
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
      panel('p', { style: { margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, rowText(item)),
      section === 'agents' && (item.agentsMd || item.skills?.length || item.tools?.length) ? panel('details', { style: { marginTop: 6 } },
        panel('summary', { className: 'mb-muted' }, 'AGENTS.md / skills / tools'),
        item.agentsMd ? panel('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '28vh', overflow: 'auto', fontSize: 11.5 } }, item.agentsMd) : null,
        item.skills?.length ? panel('p', { className: 'mb-muted' }, 'skills: ' + item.skills.join(', ')) : null,
        item.tools?.length ? panel('p', { className: 'mb-muted' }, 'tools: ' + item.tools.join(', ')) : null) : null))),
    dialog === undefined ? null : panel('div', { className: 'mb-overlay', onMouseDown: event => { if (event.target === event.currentTarget) setDialog(undefined) } },
      panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '公寓目录操作', 'data-apartment-dialog': dialog },
        panel('h3', { style: { marginTop: 0 } }, dialog === 'setRoot' ? '切换公寓根目录' : dialog === 'migrate' ? '迁移公寓到此目录' : '从备份目录恢复'),
        panel('p', { className: 'mb-muted' }, dialog === 'migrate' ? '将复制 agents/work/manifests/backups 与 apartment.sqlite，校验通过后切换指针；需要重启宿主。' : dialog === 'restore' ? '输入备份目录（含 manifest.json），恢复前会自动创建安全备份。' : '切换指针到新的公寓根目录；不会复制数据，适合已存在的目录。'),
        panel('input', {
          type: 'text', value: pathInput, className: 'mb-inlineInput', style: { width: '100%', marginTop: 10 },
          placeholder: '输入绝对路径，例如 E:\\work\\agents\\apartment', 'aria-label': '目录路径',
          onChange: event => setPathInput(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') confirmDialog() },
        }),
        panel('div', { className: 'mb-actionRow', style: { justifyContent: 'flex-end' } },
          panel('button', { type: 'button', className: 'mb-chipButton', onClick: () => setDialog(undefined) }, '取消'),
          panel('button', { type: 'button', style: buttonStyle('primary', busy || pathInput.trim() === ''), disabled: busy || pathInput.trim() === '', onClick: confirmDialog }, dialog === 'restore' ? '恢复' : dialog === 'migrate' ? '迁移' : '切换')))),
    )
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
      memoryRow.source_session ? panel('span', null, 'source: ' + memoryRow.source_session) : null,
      memoryRow.created_at ? panel('span', null, 'created: ' + memoryRow.created_at) : null,
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
      panel('option', { value: 'team' }, 'team'),
      panel('option', { value: 'agent' }, 'agent'),
      panel('option', { value: 'global' }, 'global'))),
    panel('div', { className: 'mb-actionRow' },
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: () => onSearch(query) }, t('search')),
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
  const { t, detail, busy, loadingMore, onLoadMore, onClose } = props
  const messages = Array.isArray(detail?.messages) ? detail.messages : []
  const total = typeof detail?.messageTotal === 'number'
    ? detail.messageTotal
    : (typeof detail?.total === 'number' ? detail.total : messages.length)
  const hasMore = detail?.hasMore === true
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
      Array.isArray(detail?.messages) ? panel('div', { className: 'mb-taskList' }, messages.map(message => panel('article', { key: message.msgId, className: 'mb-task', 'data-meeting-message': message.msgId },
        panel('div', { className: 'mb-taskTitle' },
          panel('span', null, message.round ?? 'note'),
          panel('span', { className: 'mb-pill' }, message.from ?? '')),
        panel('p', { style: { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '36vh', overflow: 'auto' } }, message.body ?? '(body unavailable)')))) : null,
      detail?.meeting ? panel('div', { className: 'mb-actionRow', 'data-meeting-pagination': '' },
        panel('span', {
          className: 'mb-muted',
          'data-meeting-message-count': '',
          'data-meeting-message-total': String(total),
        }, hasMore
          ? t('meetingDetailCount', { shown: String(messages.length), total: String(total) })
          : t('meetingAllLoaded', { total: String(total) })),
        hasMore ? panel('button', {
          type: 'button',
          className: 'mb-chipButton',
          disabled: loadingMore === true,
          onClick: onLoadMore,
          'data-meeting-load-more': '',
        }, loadingMore === true ? t('meetingLoadingMore') : t('meetingLoadMore')) : null) : null,
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
      ['open', 'r1', 'r2', 'final', 'cancelled'].map(state => panel('option', { key: state, value: state }, state))),
      panel('button', { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: () => onSearch(query, status) }, t('search'))),
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
    message === undefined ? null : panel('p', { className: 'mb-feedback', 'data-tone': message.tone === 'danger' ? 'danger' : 'ok', role: 'status' }, message.text))
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
  const [meetingDetailId, setMeetingDetailId] = React.useState(undefined)
  const [meetingDetailBusy, setMeetingDetailBusy] = React.useState(false)
  const [meetingDetailMoreBusy, setMeetingDetailMoreBusy] = React.useState(false)
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

  const fetchMeetingDetailPage = async (meetingId, pageOffset) => {
    const raw = await api.meetingDetail({
      meetingId,
      limit: MEETING_DETAIL_PAGE_SIZE,
      offset: pageOffset,
    })
    const value = unwrapRemote(raw)
    if (value === null || typeof value !== 'object') throw new Error('meeting detail unavailable')
    if (value.ok === false) throw new Error(typeof value.error === 'string' ? value.error : 'meeting detail failed')
    return value
  }

  const openMeetingDetail = async meetingId => {
    if (meetingDetailBusy || typeof api.meetingDetail !== 'function') return
    setMeetingDetailBusy(true)
    setMeetingDetailId(meetingId)
    setMeetingDetail({})
    try {
      const page = await fetchMeetingDetailPage(meetingId, 0)
      setMeetingDetail(previous => previous === undefined ? previous : page)
    } catch (caught) {
      setMeetingDetail(previous => previous === undefined ? previous : { error: errorTextOf(caught) })
    } finally { setMeetingDetailBusy(false) }
  }

  const loadMoreMeetingDetail = async () => {
    if (meetingDetailMoreBusy || meetingDetailBusy || typeof api.meetingDetail !== 'function') return
    const meetingId = meetingDetailId
    const current = meetingDetail
    if (typeof meetingId !== 'string' || current === null || typeof current !== 'object' || current.hasMore !== true) return
    const nextOffset = typeof current.nextOffset === 'number'
      ? current.nextOffset
      : (typeof current.offset === 'number' ? current.offset : 0) + (Array.isArray(current.messages) ? current.messages.length : 0)
    setMeetingDetailMoreBusy(true)
    try {
      const page = await fetchMeetingDetailPage(meetingId, nextOffset)
      setMeetingDetail(previous => previous === undefined ? previous : mergeMeetingDetailPage(previous, page, true))
    } catch (caught) {
      setMeetingDetail(previous => previous === undefined ? previous : { ...previous, error: errorTextOf(caught) })
    } finally { setMeetingDetailMoreBusy(false) }
  }

  const load = React.useCallback(async (options = {}) => {
    const nextOffset = options.offset ?? offset
    const nextKeyword = options.keyword ?? keyword
    setLoading(true)
    setError(undefined)
    try {
      const result = nextKeyword.trim() === ''
        ? await api.list('', limit, nextOffset)
        : await api.search(nextKeyword.trim(), limit, nextOffset)
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
  }, [api, keyword, limit, offset, loadAux])

  React.useEffect(() => { void load({ offset: 0 }) }, []) // initial load
  React.useEffect(() => { void loadMemory({ page: 0 }); void loadMeetings({ page: 0 }) }, [])

  const apartmentAction = async (kind, pathArg) => {
    if (apartmentBusy) return
    setApartmentBusy(true)
    setApartmentMessage({ text: t('working'), tone: 'ok' })
    try {
      const root = (pathArg ?? rootInput).trim()
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
  const openDetail = async item => {
    setSelected(item)
    setDetail(undefined)
    try {
      const normalized = normalizeGetResult(await api.get(item.id))
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
    panel(NetworkSection, { t, network, api }),
    panel(ApartmentSection, {
      t, api, apartment, rootInput, setRootInput, busy: apartmentBusy, message: apartmentMessage,
      onSetRoot: path => { void apartmentAction('setRoot', path) },
      onMigrate: path => { void apartmentAction('migrate', path) },
      onBackup: () => { void apartmentAction('backup') },
      onRestore: path => { void apartmentAction('restore', path) },
      onVerify: () => { void apartmentAction('verify') },
    }),
    panel(MemorySection, {
      t, memory, query: memoryQuery, scope: memoryScope, setQuery: setMemoryQuery, setScope: setMemoryScope,
      page: memoryPage, pageCount: memoryPages, busy: memoryBusy, message: memoryMessage, pendingDelete: memoryDeleteId,
      onSearch: nextQuery => { void loadMemory({ page: 0, query: nextQuery }) },
      onPage: next => { void loadMemory({ page: Math.max(0, Math.min(memoryPages - 1, next)) }) },
      onAskDelete: id => setMemoryDeleteId(id),
      onCancelDelete: () => setMemoryDeleteId(undefined),
      onConfirmDelete: id => { void deleteMemory(id) },
    }),
    panel(MeetingsSection, {
      t, meetings, query: meetingQuery, status: meetingStatus, setQuery: setMeetingQuery, setStatus: setMeetingStatus,
      page: meetingPage, pageCount: meetingPages, busy: meetingBusy, message: meetingMessage,
      onSearch: (nextQuery, nextStatus) => { void loadMeetings({ page: 0, query: nextQuery, status: nextStatus }) },
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
      panel('button', { type: 'button', style: style.button, onClick: clearSearch }, t('clear'))),
    panel('div', { style: style.meta },
      panel('span', null, t('stats', { total: String(total), shown: String(items.length) })),
      typeof counts.messages === 'number' ? panel('span', null, 'DB messages: ' + String(counts.messages)) : null,
      panel('span', { className: 'mb-muted', 'data-message-readonly': '' }, t('webReadOnly'))),
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
      loadingMore: meetingDetailMoreBusy,
      onLoadMore: () => { void loadMoreMeetingDetail() },
      onClose: () => { setMeetingDetail(undefined); setMeetingDetailId(undefined) },
    }),
    detail === undefined ? null : panel('div', { className: 'mb-overlay', onMouseDown: event => { if (event.target === event.currentTarget) { setSelected(undefined); setDetail(undefined) } } },      panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('detailTitle'), 'data-message-detail': '' },
        panel(MessageDetail, {
          key: detail.id,
          t,
          api,
          item: detail,
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

function CollaborationIcon(props) {
  const size = typeof props.size === 'number' ? props.size : 18
  return panel('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', className: SIDEBAR_CLASS },
    panel('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
    panel('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
    panel('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
    panel('path', { d: 'M14 17.5h7M17.5 14v7' }))
}

function collabValue(result) {
  return result?.ok === true && result.value !== undefined ? result.value : result
}

const COLLAB_STYLE = {
  page: { padding: '24px', height: '100%', overflow: 'auto', boxSizing: 'border-box' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '22px', fontWeight: 600 },
  subtitle: { margin: '4px 0 0', fontSize: '12.5px', opacity: 0.7 },
  tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '18px' },
  tab: { appearance: 'none', border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '6px 12px', fontSize: '12.5px', cursor: 'pointer' },
  tabActive: { appearance: 'none', border: '1px solid rgba(79,140,255,0.9)', background: 'rgba(79,140,255,0.18)', color: 'inherit', borderRadius: '999px', padding: '6px 12px', fontSize: '12.5px', cursor: 'pointer', fontWeight: 600 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px', marginTop: '18px' },
  card: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: '12px', padding: '14px', background: 'rgba(127,127,127,0.06)' },
  cardLabel: { fontSize: '12px', opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.04em' },
  cardValue: { fontSize: '28px', fontWeight: 650, margin: '7px 0 2px' },
  cardNote: { fontSize: '12px', opacity: 0.68, minHeight: '16px' },
  cardMeta: { fontSize: '11.5px', opacity: 0.65, marginTop: '8px' },
  error: { marginTop: '14px', padding: '9px 11px', borderRadius: '9px', border: '1px solid rgba(248,81,73,0.5)', background: 'rgba(248,81,73,0.10)', fontSize: '12.5px' },
  empty: { marginTop: '18px', fontSize: '13px', opacity: 0.7 },
  list: { display: 'grid', gap: '8px', marginTop: '16px' },
  row: { textAlign: 'left', width: '100%', border: '1px solid rgba(127,127,127,0.25)', background: 'rgba(127,127,127,0.04)', color: 'inherit', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', display: 'grid', gap: '3px' },
  rowActive: { textAlign: 'left', width: '100%', border: '1px solid rgba(79,140,255,0.8)', background: 'rgba(79,140,255,0.12)', color: 'inherit', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', display: 'grid', gap: '3px' },
  rowTitle: { fontSize: '13px', fontWeight: 600 },
  rowMeta: { fontSize: '11.5px', opacity: 0.7 },
  detail: { marginTop: '16px', border: '1px solid rgba(127,127,127,0.25)', borderRadius: '12px', padding: '14px', background: 'rgba(127,127,127,0.05)' },
  pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px', lineHeight: 1.6, margin: '8px 0 0', maxHeight: '40vh', overflow: 'auto' },
}

const COLLAB_TABS = [
  ['overview', '总览'], ['inbox', '收件箱'], ['tasks', '任务'],
  ['meetings', '会议'], ['memory', '记忆'], ['runtime', '运行与存储'], ['subenv', '子环境'],
]

function CollaborationDomainView({ api, domain, label }) {
  const [page, setPage] = React.useState(undefined)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(undefined)
  const [selected, setSelected] = React.useState(undefined)
  const [detail, setDetail] = React.useState(undefined)
  const [filterText, setFilterText] = React.useState('')
  const [filterStatus, setFilterStatus] = React.useState('')

  const load = React.useCallback(async (rawFilters = {}) => {
    setLoading(true)
    setError(undefined)
    try {
      if (domain === 'runtime') {
        if (typeof api.apartmentStatus !== 'function') throw new Error('runtime unavailable')
        const value = collabValue(await api.apartmentStatus())
        if (value === undefined || value === null) throw new Error('runtime unavailable')
        setPage({ state: 'ready', items: [{ id: 'runtime', title: '公寓/租约', status: 'status', counts: value.counts ?? null }], total: 1 })
        return
      }
      if (domain === 'subenv') {
        if (typeof api.subenvStatus !== 'function') throw new Error('subenvStatus unavailable')
        const value = collabValue(await api.subenvStatus())
        if (value?.state === 'online') {
          setPage({ state: 'ready', total: 1, items: [{ id: 'subenv', title: 'Subenv', status: value.state, meta: `tasks ${value.tasks?.length ?? 0} · llm ${value.provider?.llmEnabled === true ? 'on' : 'off'}` }] })
        } else {
          setPage({ state: 'unavailable', total: 0, items: [], error: value?.code ?? 'SUBENV_UNAVAILABLE' })
        }
        return
      }
      if (typeof api.visibilityPage !== 'function') throw new Error('visibilityPage unavailable')
      const filters = {}
      if (typeof rawFilters.query === 'string' && rawFilters.query.trim() !== '') filters.query = rawFilters.query.trim()
      if (typeof rawFilters.status === 'string' && rawFilters.status !== '') filters.status = rawFilters.status
      const result = await api.visibilityPage({ domain, limit: 50, filters })
      const value = collabValue(result)
      if (value?.ok === false) throw new Error(value.error ?? value.code ?? 'load failed')
      setPage(value ?? { items: [], total: 0, state: 'empty' })
    } catch (caught) {
      setError(errorTextOf(caught))
      setPage(undefined)
    } finally {
      setLoading(false)
    }
  }, [api, domain])

  React.useEffect(() => {
    setSelected(undefined)
    setDetail(undefined)
    void load()
  }, [load])

  const select = async item => {
    setSelected(item)
    setDetail(undefined)
    if (!['messages', 'tasks'].includes(domain) || typeof api.visibilityDetail !== 'function') return
    try {
      const result = await api.visibilityDetail({ domain, id: item.id })
      const value = collabValue(result)
      setDetail(value?.ok === false ? { error: value.error ?? value.code } : value)
    } catch (caught) {
      setDetail({ error: errorTextOf(caught) })
    }
  }

  const items = Array.isArray(page?.items) ? page.items : []
  return panel('div', null,
    panel('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginTop: '18px' } },
      panel('div', { style: COLLAB_STYLE.cardLabel }, `${label} · ${page?.total ?? 0}`),
      panel('button', { type: 'button', style: style.button, onClick: () => { void load() }, disabled: loading }, loading ? '加载中…' : '刷新')),
    ['messages', 'tasks', 'meetings', 'memory'].includes(domain) ? panel('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      panel('input', {
        style: { ...style.input, maxWidth: '280px' }, placeholder: '关键词 / 负责人', value: filterText,
        onChange: event => setFilterText(event.target.value),
        onKeyDown: event => { if (event.key === 'Enter') void load({ query: filterText, status: filterStatus }) },
      }),
      ['tasks', 'meetings'].includes(domain) ? panel('select', {
        style: { ...style.input, maxWidth: '150px' }, value: filterStatus,
        onChange: event => setFilterStatus(event.target.value),
      },
        panel('option', { value: '' }, '全部状态'),
        ...['pending', 'in_progress', 'blocked', 'completed', 'terminated', 'finalized', 'open', 'r1', 'r2'].map(status => panel('option', { key: status, value: status }, status))) : null,
      panel('button', { type: 'button', style: style.button, onClick: () => { void load({ query: filterText, status: filterStatus }) } }, '应用'),
      panel('button', { type: 'button', style: style.button, onClick: () => { setFilterText(''); setFilterStatus(''); void load() } }, '清空')) : null,
    error !== undefined ? panel('div', { style: COLLAB_STYLE.error }, error) : null,
    page?.state === 'empty' ? panel('div', { style: COLLAB_STYLE.empty }, '没有记录。') : null,
    panel('div', { style: COLLAB_STYLE.list }, items.map((item, index) => {
      const id = item.id ?? item.meetingId ?? `row-${index}`
      const title = item.subject ?? item.title ?? item.key ?? item.meetingId ?? item.id ?? '(untitled)'
      const meta = [item.status, item.assignee, item.from, item.to, item.at, item.scope].filter(Boolean).join(' · ')
      return panel('button', { key: id, type: 'button', style: selected?.id === item.id ? COLLAB_STYLE.rowActive : COLLAB_STYLE.row, onClick: () => { void select(item) } },
        panel('span', { style: COLLAB_STYLE.rowTitle }, String(title)),
        meta !== '' ? panel('span', { style: COLLAB_STYLE.rowMeta }, String(meta)) : null)
    })),
    selected !== undefined ? panel('div', { style: COLLAB_STYLE.detail },
      panel('div', { style: COLLAB_STYLE.cardLabel }, '详情 · 默认脱敏'),
      detail === undefined ? panel('div', { style: COLLAB_STYLE.empty }, '加载中…') : null,
      detail?.error !== undefined ? panel('div', { style: COLLAB_STYLE.error }, String(detail.error)) : null,
      detail?.item !== undefined ? panel('pre', { style: COLLAB_STYLE.pre }, JSON.stringify(detail.item, null, 2)) : null,
      detail?.evidence !== undefined && detail.evidence !== null ? panel('div', null,
        panel('div', { style: COLLAB_STYLE.cardLabel }, '证据'),
        panel('pre', { style: COLLAB_STYLE.pre }, JSON.stringify(detail.evidence, null, 2))) : null,
      Array.isArray(detail?.redacted) && detail.redacted.length > 0 ? panel('div', { style: COLLAB_STYLE.cardMeta }, `已隐藏：${detail.redacted.join(', ')}`) : null) : null)
}

function CollaborationPage(props) {
  const { api } = props
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(undefined)
  const [cards, setCards] = React.useState([])
  const [view, setView] = React.useState('overview')

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    if (typeof api.visibilitySummary === 'function') {
      try {
        const raw = await api.visibilitySummary({})
        const value = collabValue(raw)
        if (value?.ok === true && value.cards !== undefined) {
          const cards = Object.entries(value.cards).map(([id, card]) => ({
            id,
            label: id === 'messages' ? '未读/消息' : id === 'tasks' ? '任务' : id === 'meetings' ? '会议 action' : id === 'memory' ? '记忆' : id === 'runtime' ? '运行与存储' : '子环境',
            state: card.state,
            count: card.count,
            note: [card.unread !== undefined ? `未读 ${card.unread}` : null, card.stale !== undefined ? `stale ${card.stale}` : null, card.blocked !== undefined ? `blocked ${card.blocked}` : null, value.generatedAt].filter(Boolean).join(' · '),
          }))
          setCards(cards)
          setLoading(false)
          return
        }
      } catch { /* fall through to per-domain readers */ }
    }
    const [messages, tasks, memory, meetings] = await Promise.allSettled([
      typeof api.list === 'function' ? api.list('', 1, 0) : Promise.reject(new Error('messages unavailable')),
      typeof api.tasksPage === 'function' ? api.tasksPage({ limit: 1 }) : Promise.reject(new Error('tasks unavailable')),
      typeof api.memoryPage === 'function' ? api.memoryPage({ limit: 1 }) : Promise.reject(new Error('memory unavailable')),
      typeof api.meetingsPage === 'function' ? api.meetingsPage({ limit: 1 }) : Promise.reject(new Error('meetings unavailable')),
    ])
    const countOf = (result, keys) => {
      if (result.status !== 'fulfilled') return { state: 'unavailable', count: null, note: '不可用' }
      const value = collabValue(result.value) ?? {}
      const count = typeof value.total === 'number' ? value.total : (Array.isArray(value[keys]) ? value[keys].length : 0)
      return { state: count === 0 ? 'empty' : 'ready', count, note: count === 0 ? '无记录' : '已加载' }
    }
    const taskValue = tasks.status === 'fulfilled' ? (collabValue(tasks.value) ?? {}) : {}
    const meetingValue = meetings.status === 'fulfilled' ? (collabValue(meetings.value) ?? {}) : {}
    setCards([
      { id: 'messages', label: '未读/消息', ...countOf(messages, 'items') },
      { id: 'tasks', label: '任务', ...countOf(tasks, 'items'), note: taskValue.counts ? `stale ${taskValue.counts.stale ?? 0} · blocked ${taskValue.counts.blocked ?? 0}` : undefined },
      { id: 'meetings', label: '会议 action', ...countOf(meetings, 'meetings'), note: typeof meetingValue.total === 'number' ? '摘要可用' : undefined },
      { id: 'memory', label: '记忆', ...countOf(memory, 'memories') },
      { id: 'runtime', label: '运行与存储', state: 'unavailable', count: null, note: 'Wave C' },
      { id: 'subenv', label: '子环境', state: 'unavailable', count: null, note: '未配置' },
    ])
    setLoading(false)
  }, [api])

  React.useEffect(() => { void load() }, [load])

  return panel('div', { style: COLLAB_STYLE.page },
    panel('div', { style: COLLAB_STYLE.header },
      panel('div', null,
        panel('h1', { style: COLLAB_STYLE.title }, '协作中心'),
        panel('p', { style: COLLAB_STYLE.subtitle }, '总览 · 证据 · 运行状态；默认脱敏，不显示正文。当前 host 单实例作用域（一个 host 只服务一个 DSH profile）。')),
      panel('button', { type: 'button', style: style.button, onClick: () => { void load() }, disabled: loading }, loading ? '刷新中…' : '刷新')),
    panel('div', { style: COLLAB_STYLE.tabs }, COLLAB_TABS.map(([id, label]) => panel('button', {
      key: id, type: 'button', style: view === id ? COLLAB_STYLE.tabActive : COLLAB_STYLE.tab,
      onClick: () => setView(id),
    }, label))),
    view === 'overview'
      ? panel('div', { style: COLLAB_STYLE.grid }, cards.map(card => panel('div', { key: card.id, style: COLLAB_STYLE.card },
        panel('div', { style: COLLAB_STYLE.cardLabel }, card.label),
        panel('div', { style: COLLAB_STYLE.cardValue }, card.count === null ? '—' : String(card.count)),
        panel('div', { style: COLLAB_STYLE.cardNote }, card.state === 'unavailable' ? '不可用' : (card.note ?? '')))))
      : panel(CollaborationDomainView, { api, domain: view, label: COLLAB_TABS.find(([id]) => id === view)?.[1] ?? view }),
    error !== undefined ? panel('div', { style: COLLAB_STYLE.error }, String(error)) : null)
}

function CollaborationSettings() {
  return panel('div', { style: COLLAB_STYLE.page },
    panel('h1', { style: COLLAB_STYLE.title }, '协作可见性'),
    panel('p', { style: COLLAB_STYLE.subtitle }, '默认脱敏；operator reveal 将在后续 Wave 接入。'),
    panel('ul', { style: { marginTop: '18px', lineHeight: 1.9, fontSize: '13px' } },
      panel('li', null, '正文默认隐藏'),
      panel('li', null, '危险操作仅 operator'),
      panel('li', null, '子环境 token 不进入浏览器')))
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
  ctx.inject(['remote.messageBus'], scope => {
    // `remote.agentApartment` is not in this scope's inject set: a direct
    // property access throws "cannot get property ... without inject" inside
    // the Cordis Context get trap. Read lazily via ctx.get() (no inject
    // requirement) at each call so a late-mounted apartment Remote is picked
    // up and its absence degrades to undefined instead of aborting apply().
    const apartmentRemote = () => scope.get('remote.agentApartment')
    const t = scope.locale.bind(LOCALE_NS)
    const api = {
      // CR2-02: the Web Remote has no caller identity (host ignores readBy and
      // never marks read), so the UI must not pretend to collect one.
      list: (keyword, limit, offset) => scope.remote.messageBus.list(keyword, limit, offset, null),
      search: (keyword, limit, offset) => scope.remote.messageBus.search(keyword, limit, offset, null),
      get: messageId => scope.remote.messageBus.get(messageId, null, false),
      delete: (messageId, confirm) => scope.remote.messageBus.delete(messageId, confirm),
      send: (to, subject, body, from) => scope.remote.messageBus.send(to, subject, body, from),
      apartmentStatus: () => apartmentRemote()?.status?.(),
      apartmentData: query => apartmentRemote()?.data?.(query),
      apartmentSetRoot: root => apartmentRemote()?.setRoot?.(root),
      apartmentMigrate: to => apartmentRemote()?.migrate?.(to),
      apartmentBackup: label => apartmentRemote()?.backup?.(label),
      apartmentRestore: from => apartmentRemote()?.restore?.(from),
      apartmentVerify: () => apartmentRemote()?.verify?.(),
      tasksPage: query => scope.remote.messageBus.tasksPage(query),
      taskDetail: query => scope.remote.messageBus.taskDetail(query),
      visibilitySummary: query => scope.remote.messageBus.visibilitySummary(query),
      visibilityPage: query => scope.remote.messageBus.visibilityPage(query),
      visibilityDetail: query => scope.remote.messageBus.visibilityDetail(query),
      subenvStatus: () => scope.remote.messageBus.subenvStatus(),
      memoryPage: query => scope.remote.messageBus.memoryPage(query),
      memoryForget: query => scope.remote.messageBus.memoryForget(query),
      meetingsPage: query => scope.remote.messageBus.meetingsPage(query),
      meetingDetail: query => scope.remote.messageBus.meetingDetail(query),
      networkPage: query => scope.remote.messageBus.networkPage(query),
      messageAudit: query => scope.remote.messageBus.messageAudit(query),
    }
    // Register the panel even while no conversation is selected; individual
    // Remote calls still enforce their own access checks when a panel is used.
    ctx.effect(() => {
      const disposeSidebar = scope.slots.inject('sidebar.panellist', () => scope.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        locale: LOCALE_NS,
        label: () => t('panel'),
      }, MessageBusIcon))
      const disposeMain = scope.slots.inject('main', () => scope.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({ api }),
      }, MessageCenterPage))
      return () => {
        if (typeof disposeMain === 'function') disposeMain()
        if (typeof disposeSidebar === 'function') disposeSidebar()
      }
    }, 'message-bus client: panels')
    ctx.effect(() => {
      const disposeSidebar = scope.slots.inject('sidebar.panellist', () => scope.slots.register({
        name: 'sidebar.panellist',
        id: 'collaboration',
        order: 3,
        label: () => '协作中心',
      }, CollaborationIcon))
      const disposeMain = scope.slots.inject('main', () => scope.slots.register({
        name: 'main',
        key: 'collaboration',
        inject: () => ({ api }),
      }, CollaborationPage))
      const disposeSettings = scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section',
        id: 'collaboration-settings',
        order: 25,
        label: () => '协作可见性',
      }, CollaborationSettings))
      return () => {
        if (typeof disposeSettings === 'function') disposeSettings()
        if (typeof disposeMain === 'function') disposeMain()
        if (typeof disposeSidebar === 'function') disposeSidebar()
      }
    }, 'message-bus client: collaboration center')
  })
}

exports.apply = apply
exports.inject = inject


		return module.exports;
	}
});
//# sourceURL=dsh-message-bus/client.js
