import { createContext, useContext } from 'react'
import type { Agent, SessionView, SetupKind, Step } from '../../shared/model.ts'
import type { SetupModel } from './setup.ts'

/** What the inspector on the right shows. */
export type Selection =
  | { kind: 'prompt' }
  | { kind: 'agent'; id: string }
  | { kind: 'step'; id: string }
  | { kind: 'output'; of: string }
  | { kind: 'files' }
  /** A setup card, or one item of it (by keyOf). */
  | { kind: 'setup'; group: SetupKind; item?: string }

export interface Ctx {
  view: SessionView
  setup: SetupModel
  /** Ticks every second, for running durations. */
  now: number
  selected: Selection | null
  select: (s: Selection | null) => void
}

export const FlowContext = createContext<Ctx | null>(null)

export function useFlow(): Ctx {
  const c = useContext(FlowContext)
  if (!c) throw new Error('FlowContext missing')
  return c
}

export const agentOf = (v: SessionView, id: string): Agent | undefined => (id === 'main' ? v.main : v.subagents.find((a) => a.id === id))

export function stepOf(v: SessionView, id: string): { step: Step; agent: Agent } | undefined {
  for (const agent of [v.main, ...v.subagents]) {
    const step = agent.steps.find((s) => s.id === id)
    if (step) return { step, agent }
  }
  return undefined
}

/** 4s, 1m 12s, 1h 03m */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function ago(ts: number, now = Date.now()): string {
  const s = (now - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p

/** A path shown relative to the session's folder when it is inside it. */
export function shortPath(p: string, cwd?: string): string {
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase())) return p.slice(cwd.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return p.replace(/\\/g, '/')
}
