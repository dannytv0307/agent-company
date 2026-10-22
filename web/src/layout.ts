// Positions for the flow, left to right, each part in a frame of its own: the setup (what Claude Code
// loads here), the prompt (and the slash command it ran), the main agent, what it set to work
// (subagents, then its latest tool calls), and what came out (its reply, the subagents' reports, the
// files written).
import type { Edge, Node } from '@xyflow/react'
import type { SessionView } from '../../shared/model.ts'
import { GROUPS, keyOf, sorted, type GroupKey, type SetupModel } from './setup.ts'

export const SIZE = {
  prompt: { w: 270, h: 104 },
  command: { w: 210, h: 58 },
  main: { w: 280, h: 120 },
  sub: { w: 270, h: 96 },
  step: { w: 270, h: 40 },
  output: { w: 310, h: 80 },
  setup: { w: 250 },
}
const GAP = 14
/** A frame's padding around its cards, and the room for its title. */
const PAD = 16
const HEAD = 34
/** Between two frames: where edges turn. */
const GUTTER = 80
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
  | { kind: 'setup'; group: GroupKey }
  /** A titled border around one part of the flow (the setup, the prompt, the subagents…), behind its cards. */
  | { kind: 'frame'; title: string; members: string[] }

export type Tone = 'ok' | 'bad' | 'quiet'
export interface EdgeData extends Record<string, unknown> {
  /** Work is going along it right now: lit, with comets. */
  live?: boolean
  tone?: Tone
  /** From the setup to what uses it: drawn dashed. */
  setup?: boolean
  /** A route of its own, corner by corner, kept to the gaps between frames so no card hides it. */
  points?: [number, number][]
}

export interface Layout {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const SPAWNS = new Set(['Agent', 'Task'])

export function buildLayout(v: SessionView, setup: SetupModel): Layout {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const boxes = new Map<string, Box>()
  const place = (id: string, x: number, y: number, size: { w: number; h: number }, data: NodeData) => {
    nodes.push({ id, position: { x, y }, width: size.w, height: size.h, data, type: data.kind, draggable: false, selectable: false })
    boxes.set(id, { x, y, w: size.w, h: size.h })
  }
  const frames: { id: string; title: string; members: string[] }[] = []
  const frame = (id: string, title: string, members: string[]) => {
    if (members.length) frames.push({ id, title, members })
  }
  const link = (source: string, target: string, data: EdgeData) =>
    edges.push({ id: `${source}->${target}`, source, target, sourceHandle: 'right', targetHandle: 'left', type: 'flow', data })

  const working = v.status === 'working'
  const own = v.main.steps.filter((s) => !SPAWNS.has(s.tool)) // spawns are drawn as the subagent
  const steps = own.slice(-SHOWN_STEPS)
  const groups = GROUPS.filter((g) => g.always || sorted(setup, g.kind).length)

  // Columns, left to right, each in its frame: setup · prompt · Claude · subagents and tools · output.
  const frameW = (content: number) => content + 2 * PAD
  const xSetup = PAD
  const xIn = groups.length ? frameW(SIZE.setup.w) + GUTTER + PAD : PAD
  const inW = v.turn?.command ? SIZE.prompt.w + 64 + SIZE.command.w : SIZE.prompt.w
  const xMain = xIn + inW + PAD + GUTTER + PAD
  const xWork = xMain + SIZE.main.w + PAD + GUTTER + PAD
  const xOut = xWork + SIZE.sub.w + PAD + GUTTER + PAD

  // ── what the main agent set to work: subagents, then its own latest tools ──
  let y = HEAD
  if (v.subagents.length) {
    for (const a of v.subagents) {
      place(`agent:${a.id}`, xWork, y, SIZE.sub, { kind: 'agent', agentId: a.id })
      link('agent:main', `agent:${a.id}`, { live: a.status === 'running', tone: a.status === 'error' ? 'bad' : 'quiet' })
      y += SIZE.sub.h + GAP
    }
    frame('frame:subs', `Subagents · ${v.subagents.length}`, v.subagents.map((a) => `agent:${a.id}`))
    y += PAD + 28 + HEAD - GAP
  }
  if (steps.length) {
    for (const s of steps) {
      place(`step:${s.id}`, xWork, y, SIZE.step, { kind: 'step', stepId: s.id })
      link('agent:main', `step:${s.id}`, { live: s.status === 'running', tone: s.status === 'error' ? 'bad' : 'quiet' })
      y += SIZE.step.h + 8
    }
    frame('frame:tools', own.length > steps.length ? `Claude’s tools · ${own.length} (latest ${steps.length})` : `Claude’s tools · ${own.length}`, steps.map((s) => `step:${s.id}`))
    y -= 8
  }
  const workH = Math.max(y, HEAD + SIZE.main.h)

  // ── the prompt and the main agent, centred on what they set to work ──
  const mid = HEAD + (workH - HEAD) / 2
  place('prompt', xIn, mid - SIZE.prompt.h / 2, SIZE.prompt, { kind: 'prompt' })
  if (v.turn?.command) {
    place('command', xIn + SIZE.prompt.w + 64, mid - SIZE.command.h / 2, SIZE.command, { kind: 'command' })
    link('prompt', 'command', { live: working })
    link('command', 'agent:main', { live: working })
  } else {
    link('prompt', 'agent:main', { live: working })
  }
  frame('frame:in', v.turn?.command ? 'Prompt · slash command' : 'Prompt', v.turn?.command ? ['prompt', 'command'] : ['prompt'])
  place('agent:main', xMain, mid - SIZE.main.h / 2, SIZE.main, { kind: 'agent', agentId: 'main' })
  frame('frame:main', 'Main agent', ['agent:main'])

  // ── what came out ──
  let yo = HEAD
  const outs: [string, string][] = []
  if (v.main.output) outs.push(['main', 'agent:main'])
  for (const a of v.subagents) if (a.output) outs.push([a.id, `agent:${a.id}`])
  for (const [of, from] of outs) {
    place(`out:${of}`, xOut, yo, SIZE.output, { kind: 'result', of })
    link(from, `out:${of}`, { tone: 'ok' })
    yo += SIZE.output.h + GAP
  }
  const written = v.files.filter((f) => f.writes > 0)
  if (written.length) {
    place('files', xOut, yo, { w: SIZE.output.w, h: filesHeight(written.length) }, { kind: 'files' })
    for (const id of new Set(written.flatMap((f) => f.by))) {
      const from = `agent:${id}`
      const writer = id === 'main' ? v.main : v.subagents.find((a) => a.id === id)
      if (boxes.has(from)) link(from, 'files', { tone: 'quiet', live: writer?.status === 'running' && (id !== 'main' || working) })
    }
  }
  frame('frame:out', 'Output', [...outs.map(([of]) => `out:${of}`), ...(written.length ? ['files'] : [])])

  // ── the setup, on the far left ──
  const setupEdges: { id: string; target: string; handle: string; fromY: number; live: boolean; kind: GroupKey }[] = []
  if (groups.length) {
    const heights = groups.map((g) => setupHeight(sorted(setup, g.kind).length))
    const total = heights.reduce((a, h) => a + h + GAP, -GAP)
    let ys = mid - total / 2
    groups.forEach((g, n) => {
      const top = ys
      place(`setup:${g.kind}`, xSetup, ys, { w: SIZE.setup.w, h: heights[n] }, { kind: 'setup', group: g.kind })
      ys += heights[n] + GAP
      // Each edge leaves from the row of the item in use (the card itself for memory, which is all loaded,
      // and for items beyond the rows shown).
      sorted(setup, g.kind).forEach((item, row) => {
        const handle = g.kind !== 'memory' && row < SETUP_ROWS ? `row${row}` : 'right'
        const fromY = handle === 'right' ? top + heights[n] / 2 : top + 52 + row * 22
        for (const u of setup.uses.get(keyOf(item)) ?? []) {
          if (!boxes.has(u.node)) continue
          const id = `setup:${g.kind}:${handle}->${u.node}`
          const same = setupEdges.find((e) => e.id === id)
          if (same) same.live ||= u.live
          else setupEdges.push({ id, target: u.node, handle, fromY, live: u.live, kind: g.kind })
        }
      })
    })
    frame('frame:setup', setup.source === 'session' ? 'Setup · as loaded this session' : 'Setup · read from files', groups.map((g) => `setup:${g.kind}`))
  }

  // ── the frames, from their cards' bounds, behind everything ──
  const frameBox = new Map<string, Box>()
  for (const f of frames) {
    const bs = f.members.map((m) => boxes.get(m)).filter((b): b is Box => !!b)
    const x = Math.min(...bs.map((b) => b.x)) - PAD
    const top = Math.min(...bs.map((b) => b.y)) - HEAD
    const w = Math.max(...bs.map((b) => b.x + b.w)) + PAD - x
    const h = Math.max(...bs.map((b) => b.y + b.h)) + PAD - top
    frameBox.set(f.id, { x, y: top, w, h })
    nodes.unshift({
      id: f.id,
      position: { x, y: top },
      width: w,
      height: h,
      data: { kind: 'frame', title: f.title, members: f.members },
      type: 'frame',
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      style: { pointerEvents: 'none' },
    })
  }

  // ── setup edges: out into the gap past the setup, along a bus above or below everything, then into the
  // card that uses the item (from above or below for Claude and the command, from the left for a subagent) ──
  const rest = [...frameBox.entries()].filter(([id]) => id !== 'frame:setup').map(([, b]) => b)
  const topBus = Math.min(...rest.map((b) => b.y)) - 22
  const bottomBus = Math.max(...rest.map((b) => b.y + b.h)) + 22
  const gapX = frameW(SIZE.setup.w) + GUTTER / 2
  setupEdges.forEach((e, lane) => {
    const to = boxes.get(e.target)!
    const above = e.fromY <= mid
    const bus = above ? topBus - lane * 6 : bottomBus + lane * 6
    const x1 = gapX - 18 + lane * 6
    const start: [number, number] = [xSetup + SIZE.setup.w, e.fromY]
    let points: [number, number][]
    let targetHandle: string
    if (e.target.startsWith('agent:') && e.target !== 'agent:main') {
      // A subagent: down the inside edge of its frame, then in from the left at its name.
      const xEdge = to.x - 7 - (lane % 3) * 3
      const ty = to.y + 18
      points = [start, [x1, e.fromY], [x1, bus], [xEdge, bus], [xEdge, ty], [to.x, ty]]
      targetHandle = 'left'
    } else {
      const tx = to.x + to.w / 2 + (lane % 4) * 8 - 12
      const ty = above ? to.y : to.y + to.h
      points = [start, [x1, e.fromY], [x1, bus], [tx, bus], [tx, ty]]
      targetHandle = above ? 'top' : 'bottom'
    }
    edges.push({ id: e.id, source: `setup:${e.kind}`, target: e.target, sourceHandle: e.handle, targetHandle, type: 'flow', data: { live: e.live, tone: 'quiet', setup: true, points } })
  })
  return { nodes, edges }
}

/** A node with everything upstream and downstream of it: the path the work took through it. */
export function lineage(edges: Edge<EdgeData>[], id: string): Set<string> {
  const out = new Set([id])
  for (const [from, to] of [['source', 'target'], ['target', 'source']] as const) {
    const queue = [id]
    while (queue.length) {
      const at = queue.shift()!
      for (const e of edges) if (e[from] === at && !out.has(e[to])) (out.add(e[to]), queue.push(e[to]))
    }
  }
  return out
}

/** Where work is going on now: the ends of every live edge. */
export function livePath(edges: Edge<EdgeData>[]): Set<string> | null {
  const live = edges.filter((e) => e.data?.live)
  return live.length ? new Set(live.flatMap((e) => [e.source, e.target])) : null
}
