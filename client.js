window.__ModuleLoader__.load({
	id: "dsh-plugs",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		// messageCenter client half (source: vendor/message-bus/lib/client.js)
		const messageCenter = (() => {


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
  panel: '消息',
  title: '消息中心',
  subtitle: '查看跨会话消息总线：搜索、详情、删除与可选发送。',
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
  prev: '上一页',
  next: '下一页',
  page: '第 {page} / {pages} 页',
  priority: '优先',
  test: '测试',
  prevPage: '上一页',
  nextPage: '下一页',
}

const en = {
  panel: 'Messages',
  title: 'Message center',
  subtitle: 'Browse the cross-session message bus: search, detail, delete and optional send.',
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
`

const style = {
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '22px', fontWeight: 600 },
  subtitle: { margin: '4px 0 0', fontSize: '12.5px', opacity: 0.7 },
  toolbar: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '18px' },
  input: { padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.10)', color: 'inherit', minWidth: '200px', flex: '1 1 260px' },
  narrow: { maxWidth: '240px', minWidth: '160px' },
  button: { appearance: 'none', border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.12)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', cursor: 'pointer' },
  primary: { appearance: 'none', border: '1px solid rgba(79,140,255,0.7)', background: 'rgba(79,140,255,0.2)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', cursor: 'pointer' },
  danger: { appearance: 'none', border: '1px solid rgba(248,81,73,0.65)', background: 'rgba(248,81,73,0.18)', color: 'inherit', borderRadius: '8px', padding: '8px 12px', fontSize: '13px', cursor: 'pointer' },
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
  return panel('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', className: SIDEBAR_CLASS },
    panel('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
    panel('path', { d: 'M4 7l8 6 8-6' }))
}

function errorTextOf(error) {
  return error instanceof Error ? error.message : String(error)
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
  const [counts, setCounts] = React.useState({})
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
        setCounts(normalized.counts)
      }
    } catch (caught) {
      setError(errorTextOf(caught))
    } finally {
      setLoading(false)
    }
  }, [api, keyword, limit, offset, readBy])

  React.useEffect(() => { void load({ offset: 0 }) }, []) // initial load

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
  const pageNumber = Math.floor(offset / limit) + 1

  return panel('div', { className: PAGE_CLASS, 'data-message-bus-page': '' },
    panel('div', { style: style.header },
      panel('div', null,
        panel('h1', { style: style.title }, t('title')),
        panel('p', { style: style.subtitle }, t('subtitle'))),
      panel('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        allowSend ? panel('button', { type: 'button', style: buttonStyle('primary', false), onClick: () => { setSendOpen(true); setSendError(undefined) }, 'data-message-send-open': '' }, t('send')) : null,
        panel('button', { type: 'button', style: style.button, onClick: () => { void load({ offset }) } }, t('refresh')))),
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
    detail === undefined ? null : panel('div', { className: 'mb-overlay', onMouseDown: event => { if (event.target === event.currentTarget) { setSelected(undefined); setDetail(undefined) } } },
      panel('div', { className: 'mb-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('detailTitle'), 'data-message-detail': '' },
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
    await owner.remote.$mount(createRemoteContribution())
  })
  ctx.inject(['remote.messageBus'], scope => {
    scope.remoteAccess.whenAccess('messageBus/list', function* () {
      const t = scope.locale.bind(LOCALE_NS)
      const api = {
        list: (keyword, limit, offset, readBy) => scope.remote.messageBus.list(keyword, limit, offset, readBy),
        search: (keyword, limit, offset, readBy) => scope.remote.messageBus.search(keyword, limit, offset, readBy),
        get: (messageId, readBy, markRead) => scope.remote.messageBus.get(messageId, readBy, markRead),
        delete: (messageId, confirm) => scope.remote.messageBus.delete(messageId, confirm),
        send: (to, subject, body, from) => scope.remote.messageBus.send(to, subject, body, from),
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
			return { apply, inject }
		})()

		// hostRelaunch client half (source: vendor/host-relaunch/lib/client.js)
		const hostRelaunch = (() => {


/**
 * Pure client-domain logic for the host relaunch button/panel.
 *
 * Shared by `lib/client.js` (inlined by `scripts/build-client.mjs`) and the
 * unit tests. Browser-safe, dependency-free.
 */

/** The exact word the operator types before a real restart. */
const CONFIRM_WORD = 'RESTART'
/** Locale namespace owned by the client half. */
const LOCALE_NS = 'hostRelaunch'
/** Remote namespace and service exposed by the host plugin. */
const REMOTE_NAMESPACE = 'relaunch'
const REMOTE_SERVICE = 'relaunchRemote'

/** Error text carried by a failed RemoteResult, without internal paths. */
function remoteErrorText(result) {
  if (result === null || typeof result !== 'object') return 'unknown error'
  const error = result.error
  if (error === null || typeof error !== 'object') return 'unknown error'
  if (typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error.code === 'string' && error.code !== '') return error.code
  return 'unknown error'
}

/** Short, non-addressable session label for blocker rows. */
function shortSessionId(value) {
  const text = typeof value === 'string' ? value.replace(/[^A-Za-z0-9-]/g, '').replace(/^-+|-+$/g, '') : ''
  return text === '' ? 'unknown' : text.slice(0, 8)
}

/** Blocker rows: identity, state and hint only; never a working directory. */
function normalizeBlockers(blockers) {
  if (!Array.isArray(blockers)) return []
  return blockers.map(blocker => ({
    sessionId: shortSessionId(blocker?.sessionId),
    status: typeof blocker?.status === 'string' ? blocker.status : 'running',
    hint: typeof blocker?.hint === 'string' ? blocker.hint : undefined,
  }))
}

/** Normalize one `relaunch/status` RemoteResult. */
function normalizeStatus(result) {
  if (result?.ok !== true) return { ok: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  const allow = value.allowRealRestart === true
  const locked = value.locked === true || !allow
  return {
    ok: true,
    status: {
      enabled: value.enabled === true,
      allowRealRestart: allow,
      locked,
      lockReason: typeof value.lockReason === 'string' && value.lockReason !== ''
        ? value.lockReason
        : (allow ? undefined : 'allowRealRestart is disabled'),
      pidSuffix: typeof value.pidSuffix === 'string' ? value.pidSuffix : '',
      blockers: normalizeBlockers(value.blockers),
      pendingTtlMs: typeof value.pendingTtlMs === 'number' ? value.pendingTtlMs : 120000,
    },
  }
}

/** Normalize one `relaunch/prepare` RemoteResult (locked, blocked or prepared). */
function normalizePrepare(result) {
  if (result?.ok !== true) return { ok: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  const phase = typeof value.phase === 'string' ? value.phase : 'unknown'
  const locked = value.locked === true || phase === 'locked' || (value.canRestart !== true && value.token === null && phase !== 'warning')
  const token = typeof value.token === 'string' && /^[0-9a-f]{12}$/i.test(value.token) ? value.token : null
  return {
    ok: true,
    prepared: {
      phase,
      locked,
      canRestart: value.canRestart === true && token !== null,
      token,
      expiresInMs: typeof value.expiresInMs === 'number' ? value.expiresInMs : 0,
      pidSuffix: typeof value.pidSuffix === 'string' ? value.pidSuffix : '',
      lockReason: typeof value.lockReason === 'string' ? value.lockReason : undefined,
      blockers: normalizeBlockers(value.blockers),
    },
  }
}

/** Normalize one `relaunch/confirm` RemoteResult (confirmed or refused). */
function normalizeConfirm(result) {
  if (result?.ok !== true) return { ok: false, error: remoteErrorText(result) }
  const value = result.value ?? {}
  const phase = typeof value.phase === 'string' ? value.phase : 'unknown'
  return {
    ok: true,
    confirmed: phase === 'confirmed',
    phase,
    locked: value.locked === true,
    message: typeof value.message === 'string' ? value.message : undefined,
  }
}

/** Remaining token lifetime in whole seconds, never negative. */
function remainingSeconds(expiresAt, now) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 0
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** Whether an operator may request a fresh prepare from the current status. */
function canPrepare(status) {
  return status !== undefined && status.enabled === true
    && status.locked !== true && Array.isArray(status.blockers) && status.blockers.length === 0
}

/** Whether the typed word allows the confirm action in the prepared state. */
function viewState(input) {
  const status = input?.status
  const prepared = input?.prepared
  const now = typeof input?.now === 'number' ? input.now : Date.now()
  const seconds = prepared === undefined || prepared.expiresInMs <= 0 ? 0 : remainingSeconds((input.preparedAt ?? now) + prepared.expiresInMs, now)
  const expired = prepared !== undefined && prepared.expiresInMs > 0 && seconds <= 0
  const blockers = status === undefined || !Array.isArray(status.blockers) ? [] : status.blockers
  const locked = status === undefined || status.locked === true || prepared?.locked === true
  const typed = input?.typed === CONFIRM_WORD
  return {
    locked,
    blockers,
    canPrepare: canPrepare(status),
    hasToken: prepared?.token !== null && prepared?.token !== undefined,
    expired,
    seconds: expired ? 0 : seconds,
    canConfirm: prepared !== undefined && prepared.token !== null && !locked && blockers.length === 0 && !expired && typed,
    needsTypedWord: prepared !== undefined && prepared.token !== null && !locked && blockers.length === 0 && !expired,
  }
}

/**
 * One strict, identity codec. The Gateway's client contribution validation only
 * requires `mode:'strict'`; arguments and results are JSON values the Host
 * revalidates with its own descriptor, so the client parser is the identity.
 */
function identityCodec(typeSymbol) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: value => value }),
  }
}

/** JSON parameter descriptor for a named wire argument. */
function jsonParameter(name) {
  return { name, wire: name, source: 'json', codec: identityCodec(`dsh-host-relaunch#${name}:json`) }
}

/** The generated-contribution shape for the three relaunch endpoints. */
function createRemoteContribution() {
  return {
    package: 'dsh-host-relaunch',
    descriptors: [
      {
        id: 'dsh-host-relaunch/relaunch/status',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'status',
        invocation: { kind: 'direct' },
        parameters: [],
        result: identityCodec('dsh-host-relaunch#relaunch/status:result'),
        description: 'Read-only relaunch status; signs no token.',
      },
      {
        id: 'dsh-host-relaunch/relaunch/prepare',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'prepare',
        invocation: { kind: 'direct' },
        parameters: [],
        result: identityCodec('dsh-host-relaunch#relaunch/prepare:result'),
        description: 'Preflight a restart; the token is only present when unlocked and unblocked.',
      },
      {
        id: 'dsh-host-relaunch/relaunch/confirm',
        service: REMOTE_SERVICE,
        namespace: REMOTE_NAMESPACE,
        method: 'confirm',
        invocation: { kind: 'direct' },
        parameters: [jsonParameter('token'), jsonParameter('pidSuffix')],
        result: identityCodec('dsh-host-relaunch#relaunch/confirm:result'),
        description: 'Confirm a restart with the one-time token and the Host PID suffix.',
      },
    ],
  }
}


/**
 * Browser half of the host relaunch button: a session-header button that opens
 * an in-page confirmation panel (never window.confirm) and speaks the Host
 * `relaunch` Remote namespace.
 *
 * The build step inlines `client-src/core.js` above this file and wraps both in
 * `window.__ModuleLoader__.load({id, factory})`; `React` is declared by the
 * wrapper and the core identifiers are in the same factory scope.
 */

const zh = {
  button: '重启 DSH',
  dialogTitle: '重启 DSH',
  close: '关闭',
  statusSection: '主机状态',
  allowOn: '允许真实重启：是',
  allowOff: '允许真实重启：否（安全锁已启用）',
  pidSuffixLabel: 'PID 后 4 位',
  blockersLabel: '运行中的会话',
  noBlockers: '没有运行中的会话',
  blockedHint: '有会话正在运行，确认已禁用；请等这些会话空闲后重试。',
  lockedTitle: '重启已锁定',
  lockedHint: '安全锁 allowRealRestart 当前为关闭。只有在插件配置中打开该选项并完成预检后才能重启。',
  prepare: '准备重启',
  preparing: '预检中…',
  prepareHint: '预检只读，不会停止任何进程。',
  preparedTitle: '确认重启',
  preparedHint: '将重启宿主并恢复当前会话。页面会短暂断开，随后自动重连。',
  expireLabel: '确认令牌剩余 {seconds} 秒',
  expiredHint: '确认令牌已过期，请重新准备。',
  confirmWordLabel: '输入 {word} 以确认',
  cancel: '取消',
  confirm: '确认重启',
  confirming: '重启中…',
  confirmedTitle: '重启已触发',
  confirmedHint: '宿主正在重启，页面会短暂断开并自动重连。',
  error: '操作失败：{error}',
  retry: '重试',
  loading: '正在读取主机状态…',
  statusUnavailable: '无法读取重启状态。',
}

const en = {
  button: 'Restart DSH',
  dialogTitle: 'Restart DSH',
  close: 'Close',
  statusSection: 'Host status',
  allowOn: 'Real restart allowed: yes',
  allowOff: 'Real restart allowed: no (safety lock enabled)',
  pidSuffixLabel: 'PID suffix',
  blockersLabel: 'Running sessions',
  noBlockers: 'No running sessions',
  blockedHint: 'A session is running, so confirmation is disabled; retry once those sessions are idle.',
  lockedTitle: 'Restart locked',
  lockedHint: 'The allowRealRestart safety lock is off. Enable it in the plugin configuration and pass preflight before restarting.',
  prepare: 'Prepare restart',
  preparing: 'Running preflight…',
  prepareHint: 'Preflight is read-only and stops no process.',
  preparedTitle: 'Confirm restart',
  preparedHint: 'The Host will restart and resume the current session. This page reconnects shortly.',
  expireLabel: 'Confirmation token expires in {seconds}s',
  expiredHint: 'The confirmation token expired; prepare again.',
  confirmWordLabel: 'Type {word} to confirm',
  cancel: 'Cancel',
  confirm: 'Confirm restart',
  confirming: 'Restarting…',
  confirmedTitle: 'Restart triggered',
  confirmedHint: 'The Host is restarting; this page reconnects shortly.',
  error: 'Operation failed: {error}',
  retry: 'Retry',
  loading: 'Reading host status…',
  statusUnavailable: 'Could not read the restart status.',
}

const inject = ['slots', 'locale', 'remote', 'remoteAccess']

const panel = React.createElement
const BUTTON_CLASS = 'dsh-host-relaunch-button'
const BACKDROP_CLASS = 'dsh-host-relaunch-backdrop'
const DIALOG_CLASS = 'dsh-host-relaunch-dialog'
const CLIENT_CSS = `
.${BUTTON_CLASS} {
  appearance: none; border: none; background: transparent; color: inherit; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border-radius: 7px; opacity: 0.82;
}
.${BUTTON_CLASS}:hover { background: rgba(127,127,127,0.16); opacity: 1; }
.${BUTTON_CLASS}:focus-visible { outline: 2px solid rgba(79,140,255,0.85); outline-offset: 1px; opacity: 1; }
.${BACKDROP_CLASS} {
  position: fixed; inset: 0; z-index: 10000; background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
}
.${DIALOG_CLASS} {
  width: min(92vw, 440px); max-height: min(86vh, 640px); overflow: auto; box-sizing: border-box;
  border-radius: 14px; padding: 18px 20px 20px; color: inherit;
  background: rgb(32, 33, 36); border: 1px solid rgba(127,127,127,0.35);
  box-shadow: 0 18px 48px rgba(0,0,0,0.5); font: inherit;
}
body[data-ds-dark-theme="false"] .${DIALOG_CLASS} { background: rgb(250, 250, 250); }
.${DIALOG_CLASS} h2 { margin: 0; font-size: 16px; font-weight: 600; }
.${DIALOG_CLASS} input {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; font: inherit;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.12); color: inherit;
}
.${DIALOG_CLASS} input:focus-visible { outline: 2px solid rgba(79,140,255,0.8); outline-offset: 1px; }
.${DIALOG_CLASS} button { font: inherit; }
`

const style = {
  section: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid rgba(127,127,127,0.22)' },
  sectionTitle: { margin: '0 0 8px', fontSize: '12.5px', opacity: 0.7, fontWeight: 600 },
  row: { display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', padding: '3px 0' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12px' },
  blockers: { margin: '6px 0 0', paddingLeft: '18px', fontSize: '12.5px', lineHeight: 1.5 },
  notice: { margin: '10px 0 0', fontSize: '12.5px', lineHeight: 1.5, opacity: 0.85 },
  errorBox: {
    marginTop: '12px', padding: '8px 10px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
    border: '1px solid rgba(248,81,73,0.5)', background: 'rgba(248,81,73,0.12)',
  },
  warnBox: {
    marginTop: '12px', padding: '8px 10px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
    border: '1px solid rgba(210,153,34,0.55)', background: 'rgba(210,153,34,0.12)',
  },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px', flexWrap: 'wrap' },
  button: {
    appearance: 'none', border: '1px solid rgba(127,127,127,0.4)', background: 'rgba(127,127,127,0.12)',
    color: 'inherit', borderRadius: '8px', padding: '7px 12px', fontSize: '13px', cursor: 'pointer', lineHeight: 1.3,
  },
  primary: {
    appearance: 'none', border: '1px solid rgba(79,140,255,0.7)', background: 'rgba(79,140,255,0.2)',
    color: 'inherit', borderRadius: '8px', padding: '7px 12px', fontSize: '13px', cursor: 'pointer', lineHeight: 1.3,
  },
  danger: {
    appearance: 'none', border: '1px solid rgba(248,81,73,0.65)', background: 'rgba(248,81,73,0.18)',
    color: 'inherit', borderRadius: '8px', padding: '7px 12px', fontSize: '13px', cursor: 'pointer', lineHeight: 1.3,
  },
  disabled: { opacity: 0.5, cursor: 'default' },
  icon: { width: 16, height: 16, display: 'block' },
}

function buttonStyle(tone, disabled) {
  const base = tone === 'primary' ? style.primary : tone === 'danger' ? style.danger : style.button
  return disabled ? { ...base, ...style.disabled } : base
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function RestartIcon() {
  return panel('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true', style: style.icon },
    panel('path', { d: 'M12 3v8' }),
    panel('path', { d: 'M6.7 6.2a8 8 0 1 0 10.6 0' }))
}

function StatusRows(props) {
  const { t, status } = props
  return panel('div', { style: style.section },
    panel('h3', { style: style.sectionTitle }, t('statusSection')),
    panel('div', { style: style.row }, panel('span', null, status.allowRealRestart ? t('allowOn') : t('allowOff'))),
    panel('div', { style: style.row },
      panel('span', null, t('pidSuffixLabel')),
      panel('span', { style: style.mono }, status.pidSuffix === '' ? '—' : status.pidSuffix)),
    panel('div', { style: style.row },
      panel('span', null, t('blockersLabel')),
      panel('span', { style: style.mono }, String(status.blockers.length))))
}

function BlockersSection(props) {
  const { t, blockers } = props
  if (blockers.length === 0) {
    return panel('div', { style: style.section },
      panel('h3', { style: style.sectionTitle }, t('blockersLabel')),
      panel('p', { style: style.notice }, t('noBlockers')))
  }
  return panel('div', { style: style.section },
    panel('h3', { style: style.sectionTitle }, t('blockersLabel')),
    panel('ul', { style: style.blockers }, blockers.map((blocker, index) => panel('li', { key: `${blocker.sessionId}:${index}` },
      panel('span', { style: style.mono }, blocker.sessionId),
      ' ',
      panel('span', { style: { opacity: 0.7 } }, blocker.status),
      blocker.hint === undefined ? null : panel('span', { style: { opacity: 0.7 } }, ` · ${blocker.hint}`)))))
}

function LockedNotice(props) {
  const { t, status } = props
  if (status.locked) {
    return panel('div', { style: style.warnBox },
      panel('strong', null, t('lockedTitle')),
      panel('p', { style: { margin: '4px 0 0' } }, t('lockedHint')))
  }
  if (status.blockers.length > 0) return panel('div', { style: style.warnBox }, t('blockedHint'))
  return null
}

function ConfirmedView(props) {
  const { t, close } = props
  return panel('div', null,
    panel('div', { style: { ...style.section, borderTop: 'none' } },
      panel('h3', { style: style.sectionTitle }, t('confirmedTitle')),
      panel('p', { style: style.notice }, t('confirmedHint'))),
    panel('div', { style: style.actions },
      panel('button', { type: 'button', style: style.button, onClick: close }, t('close'))))
}

function PrepareActions(props) {
  const { t, canPrepare, busy, onPrepare, onClose } = props
  return panel('div', null,
    panel('p', { style: style.notice }, t('prepareHint')),
    panel('div', { style: style.actions },
      panel('button', { type: 'button', style: style.button, onClick: onClose }, t('cancel')),
      panel('button', {
        type: 'button',
        style: buttonStyle('primary', busy || !canPrepare),
        disabled: busy || !canPrepare,
        onClick: onPrepare,
        'data-relaunch-prepare': '',
      }, busy ? t('preparing') : t('prepare'))))
}

function PreparedForm(props) {
  const { t, typed, seconds, canConfirm, busy, inputRef, onTyped, onConfirm, onClose } = props
  return panel('div', null,
    panel('div', { style: style.section },
      panel('h3', { style: style.sectionTitle }, t('preparedTitle')),
      panel('p', { style: style.notice }, t('preparedHint')),
      panel('p', { style: style.notice }, t('expireLabel', { seconds: String(seconds) }))),
    panel('label', { style: { display: 'block', marginTop: '12px', fontSize: '12.5px' } },
      panel('span', null, t('confirmWordLabel', { word: CONFIRM_WORD })),
      panel('input', {
        ref: inputRef,
        type: 'text',
        value: typed,
        autoComplete: 'off',
        spellCheck: false,
        'aria-label': t('confirmWordLabel', { word: CONFIRM_WORD }),
        'data-relaunch-confirm-input': '',
        style: { marginTop: '6px' },
        onChange: onTyped,
      })),
    panel('div', { style: style.actions },
      panel('button', { type: 'button', style: style.button, onClick: onClose }, t('cancel')),
      panel('button', {
        type: 'button',
        style: buttonStyle('danger', busy || !canConfirm),
        disabled: busy || !canConfirm,
        onClick: onConfirm,
        'data-relaunch-confirm': '',
      }, busy ? t('confirming') : t('confirm'))))
}

function PanelBody(props) {
  const { t, status, prepared, view, error, busy, confirmed, typed, inputRef, close, loadStatus, prepare, confirm, onTyped } = props
  if (status === undefined) {
    return panel('div', null,
      panel('div', { style: style.errorBox }, error ?? t('statusUnavailable')),
      panel('div', { style: style.actions },
        panel('button', { type: 'button', style: style.button, onClick: () => { void loadStatus() } }, t('retry'))))
  }
  let content
  if (confirmed) content = panel(ConfirmedView, { t, close })
  else if (prepared === undefined) content = panel(PrepareActions, { t, canPrepare: view.canPrepare, busy, onPrepare: () => { void prepare() }, onClose: close })
  else content = panel(PreparedForm, {
    t, typed, seconds: view.seconds, canConfirm: view.canConfirm, busy, inputRef,
    onTyped: event => onTyped(event.target.value),
    onConfirm: () => { void confirm() },
    onClose: close,
  })
  return panel('div', null,
    panel(StatusRows, { t, status }),
    panel(LockedNotice, { t, status }),
    panel(BlockersSection, { t, blockers: status.blockers }),
    error === undefined ? null : panel('div', { style: style.errorBox }, error),
    content)
}

function RestartPanel(props) {
  const { t, api, onClose } = props
  const [loading, setLoading] = React.useState(true)
  const [status, setStatus] = React.useState(undefined)
  const [prepared, setPrepared] = React.useState(undefined)
  const [preparedAt, setPreparedAt] = React.useState(0)
  const [typed, setTyped] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(undefined)
  const [confirmed, setConfirmed] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const inputRef = React.useRef(null)

  const close = () => { setPrepared(undefined); setTyped(''); onClose() }

  const loadStatus = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const normalized = normalizeStatus(await api.status())
      if (!normalized.ok) setError(normalized.error)
      else setStatus(normalized.status)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [api])

  const prepare = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      const normalized = normalizePrepare(await api.prepare())
      if (!normalized.ok) setError(normalized.error)
      else if (normalized.prepared.locked) setError(t('lockedHint'))
      else if (normalized.prepared.token === null) setError(t('statusUnavailable'))
      else {
        setPrepared(normalized.prepared)
        setPreparedAt(Date.now())
        setTyped('')
      }
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (busy || prepared === undefined || prepared.token === null || !view.canConfirm) return
    setBusy(true)
    setError(undefined)
    try {
      const normalized = normalizeConfirm(await api.confirm(prepared.token, prepared.pidSuffix || status?.pidSuffix || ''))
      setPrepared(undefined)
      setTyped('')
      if (!normalized.ok) setError(normalized.error)
      else if (normalized.confirmed) setConfirmed(true)
      else setError(normalized.message ?? t('statusUnavailable'))
    } catch (caught) {
      setPrepared(undefined)
      setTyped('')
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  React.useEffect(() => { void loadStatus() }, [loadStatus])
  React.useEffect(() => {
    if (prepared === undefined) return undefined
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [prepared])
  React.useEffect(() => {
    if (prepared !== undefined && prepared.expiresInMs > 0 && remainingSeconds(preparedAt + prepared.expiresInMs, now) <= 0) {
      setPrepared(undefined)
      setTyped('')
      setError(t('expiredHint'))
    }
  }, [now, prepared, preparedAt, t])
  React.useEffect(() => {
    if (prepared !== undefined && inputRef.current !== null) inputRef.current.focus()
  }, [prepared])
  React.useEffect(() => {
    const onKeyDown = event => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const view = viewState({ status, prepared, preparedAt, typed, now })
  return panel('div', {
    className: BACKDROP_CLASS,
    onMouseDown: event => { if (event.target === event.currentTarget) close() },
  },
  panel('div', {
    className: DIALOG_CLASS,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('dialogTitle'),
    'data-relaunch-dialog': '',
  },
  panel('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } },
    panel('h2', null, t('dialogTitle')),
    panel('button', { type: 'button', style: style.button, 'aria-label': t('close'), onClick: close }, t('close'))),
  loading
    ? panel('p', { style: style.notice }, t('loading'))
    : panel(PanelBody, { t, status, prepared, view, error, busy, confirmed, typed, inputRef, close, loadStatus, prepare, confirm, onTyped: setTyped })))
}

function RestartButton(props) {
  const { t, api } = props
  const [open, setOpen] = React.useState(false)
  return panel('span', { style: { display: 'inline-flex', alignItems: 'center' } },
    panel('button', {
      type: 'button',
      className: BUTTON_CLASS,
      'aria-label': t('button'),
      title: t('button'),
      onClick: () => setOpen(true),
      'data-relaunch-button': '',
    }, panel(RestartIcon, null)),
    open ? panel(RestartPanel, { t, api, onClose: () => setOpen(false) }) : null)
}

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'host-relaunch client: dictionaries')
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    const existing = document.querySelector('style[data-plugin="host-relaunch"]')
    if (existing !== null) return () => existing.remove()
    const styleElement = document.createElement('style')
    styleElement.dataset.plugin = 'host-relaunch'
    styleElement.textContent = CLIENT_CSS
    document.head.appendChild(styleElement)
    return () => styleElement.remove()
  }, 'host-relaunch client: styles')
  // Mount the generated-shape contribution for the source-mode service. The
  // fiber owns the namespace; it disappears with the client plugin.
  ctx.plugin(async function mountRelaunchRemote(owner) {
    await owner.remote.$mount(createRemoteContribution())
  })
  ctx.inject(['remote.relaunch'], scope => {
    scope.remoteAccess.whenAccess('relaunch/status', function* () {
      const api = {
        status: () => scope.remote.relaunch.status(),
        prepare: () => scope.remote.relaunch.prepare(),
        confirm: (token, pidSuffix) => scope.remote.relaunch.confirm(token, pidSuffix),
      }
      yield scope.slots.inject('conversation.session.header.utilities', () => scope.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'host-relaunch',
        order: 10,
        locale: LOCALE_NS,
        inject: () => ({ api }),
      }, RestartButton))
    })
  })
}
			return { apply, inject }
		})()

		// Compose both browser halves into the bundle's single client module.
		function apply(ctx) {
			messageCenter.apply(ctx);
			hostRelaunch.apply(ctx);
		}
		const inject = [...new Set([...messageCenter.inject, ...hostRelaunch.inject])];
		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
//# sourceURL=dsh-plugs/client.js
