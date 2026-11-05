window.__ModuleLoader__.load({
	id: "dsh-host-relaunch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

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

exports.apply = apply
exports.inject = inject


		return module.exports;
	}
});
//# sourceURL=dsh-host-relaunch/client.js
