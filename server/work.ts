// Everything running right now that the owner can stop: organizer runs, 1:1 chat replies and
// delegated tasks. Each entry knows how to stop its own process (and everything that process started).
import type { ChildProcess } from 'node:child_process'
import type { WorkItem } from '../shared/types.ts'
import { bus } from './events.ts'
import { loadOrg } from './org.ts'
import { killTree } from './proc.ts'
import { openCheckpointOf } from './checkpoints.ts'

interface Entry extends WorkItem {
  child?: () => ChildProcess | undefined
  /** Set when the owner stopped it, so the failure that follows reads "stopped", not "crashed". */
  stopped?: boolean
}

const work = new Map<string, Entry>()

export function startWork(item: Omit<WorkItem, 'startedAt' | 'status'> & { status?: WorkItem['status'] }) {
  const entry: Entry = { status: 'running', ...item, startedAt: Date.now() }
  work.set(item.id, entry)
  bus.emit({ kind: 'system', runId: item.runId, projectId: item.projectId, agent: item.agentId, text: 'Work started', meta: { work: item.id } })
  return {
    /** How to reach the process doing the work (it may not exist yet, e.g. while queued). */
    attach(child: () => ChildProcess | undefined) {
      entry.child = child
      entry.status = 'running'
      entry.startedAt = Date.now()
      const c = child()
      if (entry.stopped && c) killTree(c) // stopped while it was still queued
      bus.emit({ kind: 'system', runId: item.runId, projectId: item.projectId, agent: item.agentId, text: 'Work running', meta: { work: item.id } })
    },
    get stopped() {
      return !!entry.stopped
    },
    end() {
      work.delete(item.id)
      bus.emit({ kind: 'system', runId: item.runId, projectId: item.projectId, agent: item.agentId, text: 'Work ended', meta: { work: item.id } })
    },
  }
}

export type WorkHandle = ReturnType<typeof startWork>

export const listWork = (): WorkItem[] =>
  [...work.values()].map(({ child: _c, stopped: _s, ...w }) => w).sort((a, b) => a.startedAt - b.startedAt)

/** Stop one piece of work. Returns false when it is not running (any more). */
export function stopWork(id: string, reason = 'Stopped by owner'): boolean {
  const w = work.get(id)
  if (!w || w.stopped) return false
  w.stopped = true
  const c = w.child?.()
  if (c) killTree(c)
  bus.emit({ kind: 'system', runId: w.runId, projectId: w.projectId, agent: w.agentId, text: `${reason}: ${w.title}`, meta: { work: id } })
  if (!c) work.delete(id) // still queued: it will never start
  return true
}

export const isStopped = (id: string) => !!work.get(id)?.stopped

// The owner's optional time limit. Work waiting on the owner's answer to a check-in is not counted.
setInterval(async () => {
  const limit = (await loadOrg().catch(() => null))?.owner.preferences?.autoStopMinutes
  if (!limit) return
  for (const w of work.values()) {
    if (w.status !== 'running' || w.stopped || Date.now() - w.startedAt < limit * 60_000) continue
    if (openCheckpointOf(w.agentId, w.projectId)) continue
    stopWork(w.id, `Stopped automatically after ${limit} min`)
  }
}, 30_000).unref()
