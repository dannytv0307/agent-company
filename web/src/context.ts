import { createContext, useContext } from 'react'
import type { Agent, Ask, Engine, Handoff, SessionView, Step } from '../../shared/model.ts'
import type { Lane } from './layout.ts'
import type { GroupKey, SetupModel } from './setup.ts'

/** What the inspector on the right shows; `lane` is the agent it belongs to (unset: the first lane). */
export type Selection =
  | { kind: 'prompt' }
  | { kind: 'agent'; id: string; lane?: Engine }
  | { kind: 'step'; id: string; lane?: Engine }
  | { kind: 'output'; of: string; lane?: Engine }
  | { kind: 'files'; lane?: Engine }
  /** A setup card, or one item of it (by keyOf). */
  | { kind: 'setup'; group: GroupKey; item?: string; lane?: Engine }

export interface Ctx {
  /** The lane in hand: the first one, or the one a card or the inspector is about (see useLane). */
  view: SessionView
  setup: SetupModel
  /** Every agent's lane, the first on top; and the one in hand (unset: the first). */
  lanes: Lane[]
  lane?: Engine
  /** Tasks the agents handed each other in the latest turn, and whom the user's prompt went to. */
  handoffs: Handoff[]
  direct: Engine[]
  /** Ticks every second, for running durations. */
  now: number
  selected: Selection | null
  select: (s: Selection | null) => void
  /** What Claude is asking the user right now, to answer on the flow too. */
  asks: Ask[]
  /** The prompt leads to the chat (open it, ready to type) rather than to its details. */
  openChat?: () => void
  /** Whether each agent's MCP servers can be checked and reconnected here, and if not, why. */
  mcpControl?: Partial<Record<Engine, { can: boolean; why?: string }>>
}

export const FlowContext = createContext<Ctx | null>(null)

export function useFlow(): Ctx {
  const c = useContext(FlowContext)
  if (!c) throw new Error('FlowContext missing')
  return c
}

/** The context with one agent's lane in hand: its view and its setup. */
export function laneCtx(c: Ctx, lane?: Engine): Ctx {
  const l = lane ? c.lanes.find((x) => x.engine === lane) : undefined
  return l ? { ...c, view: l.view, setup: l.setup, lane: l.engine } : c
}
export const useLane = (lane?: Engine): Ctx => laneCtx(useFlow(), lane)

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

/** The agent and its product, by engine: "Claude" / "Claude Code", "Codex" / "Codex". */
export const agentName = (e?: Engine) => (e === 'codex' ? 'Codex' : 'Claude')
export const productName = (e?: Engine) => (e === 'codex' ? 'Codex' : 'Claude Code')

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
