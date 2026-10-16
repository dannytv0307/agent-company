import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '../shared/types.ts'
import { DATA_DIR } from './org.ts'

const LOG_FILE = path.join(DATA_DIR, 'events.jsonl')
const KEEP = 3000

type Listener = (e: AgentEvent) => void

// runId → projectId, so every event of a run (including delegated Codex work) knows its project.
const runProjects = new Map<string, string>()
export const tagRun = (runId: string, projectId: string) => void runProjects.set(runId, projectId)
export const projectOfRun = (runId?: string) => (runId ? runProjects.get(runId) : undefined)

/** In-memory event bus, persisted as JSONL so the dashboard survives restarts. */
class EventBus {
  private events: AgentEvent[] = []
  private listeners = new Set<Listener>()

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
    if (existsSync(LOG_FILE)) {
      const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-KEEP)
      for (const line of lines) {
        try {
          this.events.push(JSON.parse(line))
        } catch {
          // skip corrupt line
        }
      }
    }
  }

  emit(e: Omit<AgentEvent, 'id' | 'ts'>): AgentEvent {
    const projectId = e.projectId ?? projectOfRun(e.runId)
    const full: AgentEvent = { id: randomUUID(), ts: Date.now(), ...e, ...(projectId ? { projectId } : {}) }
    this.events.push(full)
    if (this.events.length > KEEP) this.events.splice(0, this.events.length - KEEP)
    appendFileSync(LOG_FILE, JSON.stringify(full) + '\n')
    for (const l of this.listeners) l(full)
    return full
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  history(limit = 500): AgentEvent[] {
    return this.events.slice(-limit)
  }
}

export const bus = new EventBus()
