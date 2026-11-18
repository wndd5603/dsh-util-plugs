import { createTaskRunner } from './tasks.mjs'

function safeProvider(provider) {
  const desc = provider.describe()
  return {
    configured: desc.configured === true,
    id: desc.id ?? null,
    model: desc.model ?? null,
    hasApiKey: desc.hasApiKey === true,
    llmEnabled: desc.llmEnabled === true,
  }
}

function taskSummary(task) {
  return { id: task.id, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt }
}

/** In-process subenv: no port, no token, lifecycle owned by the host. */
export function createEmbeddedSubenv({ provider }) {
  const tasks = createTaskRunner({ provider })
  return {
    mode: 'embedded',
    status() {
      const safe = safeProvider(provider)
      return {
        ok: true,
        state: safe.llmEnabled ? 'online' : 'degraded',
        mode: 'embedded',
        provider: safe,
        tasks: tasks.list().tasks.map(taskSummary),
        asOf: new Date().toISOString(),
      }
    },
    submit(args) { return tasks.submit(args) },
    get(args) { return tasks.get(args) },
    list() {
      return {
        ok: true,
        tasks: tasks.list().tasks.map(task => {
          const view = { ...taskSummary(task) }
          if (task.result !== undefined) view.result = task.result
          if (task.error !== undefined) view.error = task.error
          return view
        }),
      }
    },
    cancel(args) { return tasks.cancel(args) },
  }
}
