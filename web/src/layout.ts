// Positions for the flow, left to right: the setup (what Claude Code loads here), the prompt (and the
// slash command it ran), the main agent, what it set to work (subagents, then its latest tool calls),
// and what came out (its reply, the subagents' reports, the files written).
import type { Edge, Node } from '@xyflow/react'
import type { SessionView, SetupKind } from '../../shared/model.ts'
import { GROUPS, keyOf, type SetupModel } from './setup.ts'

export const SIZE = {
  prompt: { w: 270, h: 104 },
  command: { w: 210, h: 58 },
  main: { w: 280, h: 120 },
  sub: { w: 270, h: 96 },
  step: { w: 270, h: 40 },
  output: { w: 310, h: 80 },
  label: { w: 270, h: 26 },
  setup: { w: 250 },
}
const GAP = 14
const COL = 96
/** The main agent's latest tool calls on the canvas; the rest are in its details. */
export const SHOWN_STEPS = 8
const FILES_SHOWN = 8
export const filesHeight = (n: number) => 44 + Math.min(n, FILES_SHOWN) * 24 + (n > FILES_SHOWN ? 22 : 0)
/** Items listed in a setup card; the rest are in its details. */
export const SETUP_ROWS = 4
export const setupHeight = (n: number) => 48 + Math.max(1, Math.min(n, SETUP_ROWS)) * 22 + (n > SETUP_ROWS ? 20 : 0)

export type NodeData =
  | { kind: 'prompt' }
  | { kind: 'command' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'step'; stepId: string }
  | { kind: 'result'; of: string }
  | { kind: 'files' }
  | { kind: 'label'; text: string }
  | { kind: 'setup'; group: SetupKind }

export type Tone = 'ok' | 'bad' | 'quiet'
export interface EdgeData extends Record<string, unknown> {
  /** Work is going along it right now: lit, with comets. */
  live?: boolean
  tone?: Tone
  /** From the setup to what uses it: drawn dashed. */
  setup?: boolean
}

export interface Layout {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

export function buildLayout(v: SessionView, setup: SetupModel): Layout {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const place = (id: string, x: number, y: number, size: { w: number; h: number }, data: NodeData) =>
    nodes.push({ id, position: { x, y }, width: size.w, height: size.h, data, type: data.kind, draggable: false, selectable: false })
  const link = (source: string, target: string, data: EdgeData) =>
    edges.push({ id: `${source}->${target}`, source, target, sourceHandle: 'right', targetHandle: 'left', type: 'flow', data })

  const working = v.status === 'working'
  const steps = v.main.steps.slice(-SHOWN_STEPS)
  const groups = GROUPS.filter((g) => g.always || setup.items.some((i) => i.kind === g.kind))
  const x0 = groups.length ? SIZE.setup.w + COL + 24 : 0

  // ── what the main agent set to work ──
  const xMain = x0 + (v.turn?.command ? SIZE.prompt.w + COL + SIZE.command.w + COL : SIZE.prompt.w + COL)
  const xWork = xMain + SIZE.main.w + COL
  let y = 0
  if (v.subagents.length) {
    place('label:subs', xWork, y, SIZE.label, { kind: 'label', text: `Subagents · ${v.subagents.length}` })
    y += SIZE.label.h + 6
    for (const a of v.subagents) {
      place(`agent:${a.id}`, xWork, y, SIZE.sub, { kind: 'agent', agentId: a.id })
      link('agent:main', `agent:${a.id}`, { live: a.status === 'running', tone: a.status === 'error' ? 'bad' : 'quiet' })
      y += SIZE.sub.h + GAP
    }
    y += 10
  }
  if (steps.length) {
    const total = v.main.steps.length
    place('label:tools', xWork, y, SIZE.label, { kind: 'label', text: total > steps.length ? `Tools · ${total} (latest ${steps.length})` : `Tools · ${total}` })
    y += SIZE.label.h + 6
    for (const s of steps) {
      if (s.tool === 'Agent' || s.tool === 'Task') continue // drawn as the subagent
      place(`step:${s.id}`, xWork, y, SIZE.step, { kind: 'step', stepId: s.id })
      link('agent:main', `step:${s.id}`, { live: s.status === 'running', tone: s.status === 'error' ? 'bad' : 'quiet' })
      y += SIZE.step.h + 8
    }
  }
  const workH = Math.max(y - GAP, SIZE.main.h)

  // ── the prompt and the main agent, centred on what they set to work ──
  const mid = workH / 2
  const yMain = mid - SIZE.main.h / 2
  place('prompt', x0, mid - SIZE.prompt.h / 2, SIZE.prompt, { kind: 'prompt' })
  if (v.turn?.command) {
    place('command', x0 + SIZE.prompt.w + COL, mid - SIZE.command.h / 2, SIZE.command, { kind: 'command' })
    link('prompt', 'command', { live: working })
    link('command', 'agent:main', { live: working })
  } else {
    link('prompt', 'agent:main', { live: working })
  }
  place('agent:main', xMain, yMain, SIZE.main, { kind: 'agent', agentId: 'main' })

  // ── what came out ──
  const xOut = xWork + SIZE.sub.w + COL
  let yo = 0
  const outs: [string, string][] = []
  if (v.main.output) outs.push(['main', 'agent:main'])
  for (const a of v.subagents) if (a.output) outs.push([a.id, `agent:${a.id}`])
  const written = v.files.filter((f) => f.writes > 0)
  if (outs.length || written.length) {
    place('label:out', xOut, yo, SIZE.label, { kind: 'label', text: 'Output' })
    yo += SIZE.label.h + 6
  }
  for (const [of, from] of outs) {
    place(`out:${of}`, xOut, yo, SIZE.output, { kind: 'result', of })
    link(from, `out:${of}`, { tone: 'ok' })
    yo += SIZE.output.h + GAP
  }
  if (written.length) {
    place('files', xOut, yo, { w: SIZE.output.w, h: filesHeight(written.length) }, { kind: 'files' })
    const writers = new Set(written.flatMap((f) => f.by))
    for (const id of writers) {
      const from = `agent:${id}`
      if (nodes.some((n) => n.id === from)) link(from, 'files', { tone: 'quiet', live: working && (id === 'main' ? v.main.status === 'running' : v.subagents.find((a) => a.id === id)?.status === 'running') })
    }
  }

  // ── the setup, on the far left, each card pointing at what uses it ──
  if (groups.length) {
    const heights = groups.map((g) => setupHeight(setup.items.filter((i) => i.kind === g.kind).length))
    const total = SIZE.label.h + 6 + heights.reduce((a, h) => a + h + GAP, -GAP)
    let ys = mid - total / 2
    place('label:setup', 0, ys, { w: SIZE.setup.w, h: SIZE.label.h }, { kind: 'label', text: 'Setup · .claude' })
    ys += SIZE.label.h + 6
    const ids = new Set(nodes.map((n) => n.id))
    groups.forEach((g, n) => {
      place(`setup:${g.kind}`, 0, ys, { w: SIZE.setup.w, h: heights[n] }, { kind: 'setup', group: g.kind })
      ys += heights[n] + GAP
      const targets = new Map<string, boolean>()
      for (const item of setup.items) {
        if (item.kind !== g.kind) continue
        for (const u of setup.uses.get(keyOf(item)) ?? []) if (u.node && ids.has(u.node)) targets.set(u.node, (targets.get(u.node) ?? false) || u.live)
      }
      for (const [target, live] of targets) link(`setup:${g.kind}`, target, { live, tone: 'quiet', setup: true })
    })
  }
  return { nodes, edges }
}
