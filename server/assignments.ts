// Who is working on what right now. An assignment is one hand-off: an agent, a task, a project.
// One agent can hold several at once (parallel sessions), so busy-ness is counted, not a flag.
import { bus } from './events.ts'

export interface Assignment {
  id: string
  agentId: string
  projectId?: string
  runId?: string
  taskId?: string
  title: string
  startedAt: number
}

const active = new Map<string, Assignment>()

bus.subscribe((e) => {
  const aid = typeof e.meta?.aid === 'string' ? e.meta.aid : undefined
  if ((e.kind === 'dispatch' || e.kind === 'task') && e.to && aid) {
    active.set(aid, {
      id: aid,
      agentId: e.to,
      projectId: e.projectId,
      runId: e.runId,
      taskId: typeof e.meta?.taskId === 'string' ? e.meta.taskId : undefined,
      title: e.text,
      startedAt: e.ts,
    })
  } else if ((e.kind === 'report' || e.kind === 'error') && aid) {
    active.delete(aid)
  } else if (e.kind === 'system' && e.meta?.end) {
    // A run ending (or being stopped) closes everything that was handed out inside it.
    const ended = (e.meta.runIds as string[] | undefined) ?? (e.runId ? [e.runId] : null)
    for (const [id, a] of active) if (!ended || (a.runId && ended.includes(a.runId))) active.delete(id)
  }
})

export const assignmentsOf = (agentId: string) => [...active.values()].filter((a) => a.agentId === agentId)
export const isBusy = (agentId: string) => assignmentsOf(agentId).length > 0
export const activeAssignments = () => [...active.values()]
