/**
 * Minimal in-process task runner for the sidecar. Tasks are intentionally
 * ephemeral: no task survives a process restart, and the UI must show unknown
 * rather than pretending a lost task is still running.
 */
import { randomUUID } from 'node:crypto'

function taskView(task) {
  const view = {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.status === 'completed') view.result = task.result
  if (task.error !== undefined && task.error !== null) view.error = task.error
  return view
}

export function createTaskRunner({ provider, now = () => new Date().toISOString() } = {}) {
  if (provider === undefined || provider === null) throw new Error('provider is required')
  const tasks = new Map()

  function set(id, patch) {
    const task = tasks.get(id)
    if (task === undefined) return undefined
    Object.assign(task, patch, { updatedAt: now() })
    return task
  }

  async function run(task) {
    set(task.id, { status: 'running' })
    const result = await provider.chat({ messages: task.messages })
    if (task.status === 'cancelled') return
    if (result?.ok === true) set(task.id, { status: 'completed', result: result.text })
    else set(task.id, { status: 'failed', error: result?.code ?? 'TASK_FAILED' })
  }

  return {
    submit({ prompt, messages } = {}) {
      const normalized = Array.isArray(messages) && messages.length > 0
        ? messages
        : (typeof prompt === 'string' && prompt.trim() !== '' ? [{ role: 'user', content: prompt.trim() }] : null)
      if (normalized === null) return { ok: false, code: 'INVALID_ARGUMENT', message: 'prompt or messages is required' }
      if (provider.enabled !== true) return { ok: false, code: 'LLM_DISABLED', message: 'provider LLM is not enabled' }
      const at = now()
      const task = { id: 'task-' + randomUUID().slice(0, 8), status: 'queued', createdAt: at, updatedAt: at, messages: normalized }
      tasks.set(task.id, task)
      setImmediate(() => { void run(task) })
      return { ok: true, task: taskView(task) }
    },
    get({ id } = {}) {
      const task = tasks.get(id)
      return task === undefined ? { ok: false, code: 'TASK_NOT_FOUND' } : { ok: true, task: taskView(task) }
    },
    list() {
      return { ok: true, tasks: [...tasks.values()].map(taskView) }
    },
    cancel({ id } = {}) {
      const task = tasks.get(id)
      if (task === undefined) return { ok: false, code: 'TASK_NOT_FOUND' }
      if (task.status === 'completed' || task.status === 'failed') return { ok: true, task: taskView(task), alreadyFinished: true }
      if (task.status === 'cancelled') return { ok: true, task: taskView(task), alreadyFinished: true }
      set(id, { status: 'cancelled' })
      return { ok: true, task: taskView(task) }
    },
  }
}
