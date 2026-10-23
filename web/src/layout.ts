// Positions for the flow, left to right, each part in a frame of its own, the frames level at the top: the
// factories (the setup each agent loads here — the Claude factory above the Codex factory — folded into a
// tab or not, each kind of it too), the prompt (and the slash command it ran), then a lane per agent: its
// main agent, what it set to work (subagents, then its latest tool calls) and what came out (its reply, the
// subagents' reports, the files written). The Claude lane comes first, the Codex lane under it; a task one
// hands the other runs between their main agents.
import type { Edge, Node } from '@xyflow/react'
import type { Engine, Handoff, SessionView } from '../../shared/model.ts'
import { alwaysShown, factoryName, GROUPS, keyOf, sorted, type GroupKey, type SetupModel } from './setup.ts'

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
/** Between two lanes: room for the hand-over between them, and its label. */
const LANE_GAP = 72
/** The main agent's latest tool calls on the canvas; the rest are in its details. */
export const SHOWN_STEPS = 8
const FILES_SHOWN = 8
export const filesHeight = (n: number) => 44 + Math.min(n, FILES_SHOWN) * 24 + (n > FILES_SHOWN ? 22 : 0)
/** Items listed in a setup card; the rest are in its details. */
export const SETUP_ROWS = 4
export const setupHeight = (n: number, folded = false) => (folded ? FOLDED_H : 48 + Math.max(1, Math.min(n, SETUP_ROWS)) * 22 + (n > SETUP_ROWS ? 20 : 0))
/** A folded setup card: its header alone. */
const FOLDED_H = 46
/** A factory folded into a tab, as wide as its frame. */
export const FACTORY_TAB_H = 44

/** What is folded away: whole factories, or some kinds of one ("claude:skill"). */
export interface Fold {
  factory: Engine[]
  groups: string[]
}
/** A fold remembered by an earlier version (one factory, kinds without their engine) read as today's. */
export const foldOf = (f: unknown): Fold => {
  const x = (f ?? {}) as { factory?: unknown; groups?: unknown }
  const factory = Array.isArray(x.factory) ? (x.factory as Engine[]) : x.factory === true ? (['claude'] as Engine[]) : []
  const groups = Array.isArray(x.groups) ? (x.groups as string[]).map((g) => (g.includes(':') ? g : `claude:${g}`)) : []
  return { factory, groups }
}

/** One agent's part of the flow. */
export interface Lane {
  engine: Engine
  view: SessionView
  setup: SetupModel
  /** Nothing here yet in this trace: drawn quiet. */
  idle?: boolean
}

/** Node ids of a lane: the Claude lane's as they always were, the Codex lane's prefixed. */
export const laneId = (lane: Engine, id: string) => (lane === 'codex' ? `x:${id}` : id)

export type NodeData =
  | { kind: 'prompt' }
  | { kind: 'command'; lane: Engine }
  | { kind: 'agent'; lane: Engine; agentId: string }
  | { kind: 'step'; lane: Engine; stepId: string }
  | { kind: 'result'; lane: Engine; of: string }
  | { kind: 'files'; lane: Engine }
  | { kind: 'setup'; lane: Engine; group: GroupKey; folded: boolean }
  /** A factory folded into a tab. */
  | { kind: 'factory'; lane: Engine; title: string }
  /** A titled border around one part of the flow (a factory, the prompt, the subagents…), behind its cards. */
  | { kind: 'frame'; title: string; members: string[]; fold?: Engine; idle?: boolean }

export type Tone = 'ok' | 'bad' | 'quiet'
export interface EdgeData extends Record<string, unknown> {
  /** Work is going along it right now: lit, with comets. */
  live?: boolean
  tone?: Tone
  /** From the setup to what uses it: drawn dashed. */
  setup?: boolean
  /** A route of its own, corner by corner, kept to the gaps between frames so no card hides it. */
  points?: [number, number][]
  /** A task handed from one agent to the other (or its answer coming back), named on the line. */
  label?: string
  handoff?: Engine
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
const NAME: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' }

export function buildLayout(lanes: Lane[], fold: Fold = { factory: [], groups: [] }, handoffs: Handoff[] = [], direct: Engine[] = []): Layout {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const boxes = new Map<string, Box>()
  const place = (id: string, x: number, y: number, size: { w: number; h: number }, data: NodeData) => {
    nodes.push({ id, position: { x, y }, width: size.w, height: size.h, data, type: data.kind, draggable: false, selectable: false })
    boxes.set(id, { x, y, w: size.w, h: size.h })
  }
  const frames: { id: string; title: string; members: string[]; fold?: Engine; idle?: boolean }[] = []
  const frame = (id: string, title: string, members: string[], fold?: Engine, idle?: boolean) => {
    if (members.length) frames.push({ id, title, members, fold, idle })
  }
  const link = (source: string, target: string, data: EdgeData, handles: { source?: string; target?: string } = {}) =>
    edges.push({ id: `${source}->${target}`, source, target, sourceHandle: handles.source ?? 'right', targetHandle: handles.target ?? 'left', type: 'flow', data })

  const first = lanes[0]
  const many = lanes.length > 1
  const groupsOf = (l: Lane) => GROUPS.filter((g) => alwaysShown(g, l.setup.engine) || sorted(l.setup, g.kind).length)
  const anyFactory = lanes.some((l) => groupsOf(l).length)
  // The slash command belongs to Claude's turn: it sits beside the prompt.
  const command = lanes.find((l) => l.engine === 'claude' && !l.idle)?.view.turn?.command

  // Columns, left to right: factories · prompt · main agents · subagents and tools · output.
  const frameW = (content: number) => content + 2 * PAD
  const xSetup = PAD
  const xIn = anyFactory ? frameW(SIZE.setup.w) + GUTTER + PAD : PAD
  const inW = command ? SIZE.prompt.w + 64 + SIZE.command.w : SIZE.prompt.w
  const xMain = xIn + inW + PAD + GUTTER + PAD
  const xWork = xMain + SIZE.main.w + PAD + GUTTER + PAD
  const xOut = xWork + SIZE.sub.w + PAD + GUTTER + PAD

  // ── the prompt, at the top like every frame; its edge leaves level with the first agent's middle ──
  const line = HEAD + SIZE.main.h / 2
  place('prompt', xIn, HEAD, SIZE.prompt, { kind: 'prompt' })
  if (command) place('command', xIn + SIZE.prompt.w + 64, line - SIZE.command.h / 2, SIZE.command, { kind: 'command', lane: 'claude' })
  frame('frame:in', command ? 'Prompt · slash command' : 'Prompt', command ? ['prompt', 'command'] : ['prompt'])

  // ── a lane per agent, one under the other ──
  const mains: Record<string, Box> = {}
  let top = HEAD
  for (const lane of lanes) {
    const v = lane.view
    const id = (s: string) => laneId(lane.engine, s)
    const name = NAME[lane.engine]
    const working = v.status === 'working'
    const own = v.main.steps.filter((s) => !SPAWNS.has(s.tool)) // spawns are drawn as the subagent
    const steps = own.slice(-SHOWN_STEPS)
    const main = id('agent:main')

    // What the main agent set to work: subagents, then its own latest tools.
    let y = top
    if (v.subagents.length) {
      for (const a of v.subagents) {
        place(id(`agent:${a.id}`), xWork, y, SIZE.sub, { kind: 'agent', lane: lane.engine, agentId: a.id })
        link(main, id(`agent:${a.id}`), { live: a.status === 'running', tone: a.status === 'error' ? 'bad' : 'quiet' })
        y += SIZE.sub.h + GAP
      }
      frame(id('frame:subs'), `${many ? `${name}’s subagents` : 'Subagents'} · ${v.subagents.length}`, v.subagents.map((a) => id(`agent:${a.id}`)))
      y += PAD + 28 + HEAD - GAP
    }
    if (steps.length) {
      for (const s of steps) {
        place(id(`step:${s.id}`), xWork, y, SIZE.step, { kind: 'step', lane: lane.engine, stepId: s.id })
        link(main, id(`step:${s.id}`), { live: s.status === 'running', tone: s.status === 'error' ? 'bad' : 'quiet' })
        y += SIZE.step.h + 8
      }
      frame(id('frame:tools'), own.length > steps.length ? `${name}’s tools · ${own.length} (latest ${steps.length})` : `${name}’s tools · ${own.length}`, steps.map((s) => id(`step:${s.id}`)))
      y -= 8
    }

    place(main, xMain, top, SIZE.main, { kind: 'agent', lane: lane.engine, agentId: 'main' })
    mains[lane.engine] = { x: xMain, y: top, w: SIZE.main.w, h: SIZE.main.h }
    frame(id('frame:main'), many ? name : 'Main agent', [main], undefined, lane.idle)

    // The prompt reaches the agents it was sent to; a lane given its task by the other agent gets it
    // from there instead (below).
    const reached = !many || direct.includes(lane.engine) || (!direct.length && lane === first)
    if (reached && !lane.idle) {
      if (lane === first) {
        if (command && lane.engine === 'claude') {
          link('prompt', 'command', { live: working })
          link('command', main, { live: working })
        } else link('prompt', main, { live: working })
      } else {
        // Down from the prompt, then across into this lane's agent.
        const px = xIn + SIZE.prompt.w / 2
        const my = top + SIZE.main.h / 2
        link('prompt', main, { live: working, points: [[px, HEAD + SIZE.prompt.h], [px, my], [xMain, my]] }, { source: 'bottom' })
      }
    }

    // What came out.
    let yo = top
    const outs: [string, string][] = []
    if (v.main.output) outs.push(['main', main])
    for (const a of v.subagents) if (a.output) outs.push([a.id, id(`agent:${a.id}`)])
    for (const [of, from] of outs) {
      place(id(`out:${of}`), xOut, yo, SIZE.output, { kind: 'result', lane: lane.engine, of })
      link(from, id(`out:${of}`), { tone: 'ok' })
      yo += SIZE.output.h + GAP
    }
    const written = v.files.filter((f) => f.writes > 0)
    if (written.length) {
      place(id('files'), xOut, yo, { w: SIZE.output.w, h: filesHeight(written.length) }, { kind: 'files', lane: lane.engine })
      for (const who of new Set(written.flatMap((f) => f.by))) {
        const from = id(`agent:${who}`)
        const writer = who === 'main' ? v.main : v.subagents.find((a) => a.id === who)
        if (boxes.has(from)) link(from, id('files'), { tone: 'quiet', live: writer?.status === 'running' && (who !== 'main' || working) })
      }
      yo += filesHeight(written.length) + GAP
    }

    const bottom = Math.max(top + SIZE.main.h, y, yo - GAP)
    top = bottom + PAD + LANE_GAP + HEAD
  }
  // One output frame for every lane.
  const outIds = nodes.filter((n) => n.data.kind === 'result' || n.data.kind === 'files').map((n) => n.id)
  frame('frame:out', 'Output', outIds)

  // ── hand-overs: down or up between the two main agents, the task one way and the answer back ──
  const c = mains.claude
  const x = mains.codex
  if (c && x) {
    const latest = new Map<string, Handoff>()
    for (const h of handoffs) latest.set(`${h.from}>${h.to}`, h)
    for (const h of latest.values()) {
      const from = mains[h.from]
      const to = mains[h.to]
      const down = from.y < to.y
      const ask = from.x + from.w / 3
      const back = from.x + (2 * from.w) / 3
      const [fromEdge, toEdge] = down ? [from.y + from.h, to.y] : [from.y, to.y + to.h]
      const src = laneId(h.from, 'agent:main')
      const dst = laneId(h.to, 'agent:main')
      link(src, dst, { live: h.status === 'running', handoff: h.from, label: h.to === 'codex' ? 'ask_codex' : 'ask_claude', points: [[ask, fromEdge], [ask, down ? toEdge - 1 : toEdge + 1]] }, { source: down ? 'bottom' : 'top', target: down ? 'top' : 'bottom' })
      if (h.status !== 'running')
        edges.push({ id: `${dst}->${src}:back`, source: dst, target: src, sourceHandle: down ? 'top' : 'bottom', targetHandle: down ? 'bottom' : 'top', type: 'flow', data: { tone: h.status === 'error' ? 'bad' : 'ok', handoff: h.to, label: h.status === 'error' ? 'failed' : 'answer', points: [[back, toEdge], [back, down ? fromEdge + 1 : fromEdge - 1]] } })
    }
  }

  // ── the factories, on the far left, one under the other: a card per kind of setup, or a tab ──
  const setupEdges: { id: string; source: string; target: string; handle: string; fromX: number; fromY: number; live: boolean; lane: Engine }[] = []
  const edgeFrom = (lane: Engine, source: string, handle: string, fromX: number, fromY: number, node: string, live: boolean) => {
    if (!boxes.has(node)) return
    const id = `${source}:${handle}->${node}`
    const same = setupEdges.find((e) => e.id === id)
    if (same) same.live ||= live
    else setupEdges.push({ id, source, target: node, handle, fromX, fromY, live, lane })
  }
  let fy = 0
  for (const lane of lanes) {
    const groups = groupsOf(lane)
    if (!groups.length) continue
    const setup = lane.setup
    const e = lane.engine
    const node = (u: string) => laneId(e, u)
    if (fold.factory.includes(e)) {
      // The tab stands where the frame would, and everything in use leaves from it.
      const used = groups.reduce((n, g) => n + sorted(setup, g.kind).filter((i) => setup.uses.get(keyOf(i))?.length).length, 0)
      const tab = `setup:${e}:factory`
      place(tab, 0, fy, { w: frameW(SIZE.setup.w), h: FACTORY_TAB_H }, { kind: 'factory', lane: e, title: used ? `${factoryName(e)} · ${used} in use` : `${factoryName(e)} · ${groups.length} kinds` })
      for (const g of groups)
        for (const item of sorted(setup, g.kind)) for (const u of setup.uses.get(keyOf(item)) ?? []) if (u.node) edgeFrom(e, tab, 'right', frameW(SIZE.setup.w), fy + FACTORY_TAB_H / 2, node(u.node), u.live)
      fy += FACTORY_TAB_H + 24
      continue
    }
    let ys = fy + HEAD
    for (const g of groups) {
      const at = ys
      const folded = fold.groups.includes(`${e}:${g.kind}`)
      const h = setupHeight(sorted(setup, g.kind).length, folded)
      const card = `setup:${e}:${g.kind}`
      place(card, xSetup, ys, { w: SIZE.setup.w, h }, { kind: 'setup', lane: e, group: g.kind, folded })
      ys += h + GAP
      // Each edge leaves from the row of the item in use (the card itself for memory, which is all loaded,
      // for items beyond the rows shown, and for a folded card).
      sorted(setup, g.kind).forEach((item, row) => {
        const handle = !folded && g.kind !== 'memory' && row < SETUP_ROWS ? `row${row}` : 'right'
        const fromY = handle === 'right' ? at + h / 2 : at + 52 + row * 22
        for (const u of setup.uses.get(keyOf(item)) ?? []) if (u.node) edgeFrom(e, card, handle, xSetup + SIZE.setup.w, fromY, node(u.node), u.live)
      })
    }
    frame(`frame:setup:${e}`, setup.source === 'session' ? factoryName(e) : `${factoryName(e)} · from files`, groups.map((g) => `setup:${e}:${g.kind}`), e)
    fy = ys - GAP + PAD + 40
  }

  // ── the frames, from their cards' bounds, behind everything ──
  const frameBox = new Map<string, Box>()
  for (const f of frames) {
    const bs = f.members.map((m) => boxes.get(m)).filter((b): b is Box => !!b)
    if (!bs.length) continue
    const x0 = Math.min(...bs.map((b) => b.x)) - PAD
    const y0 = Math.min(...bs.map((b) => b.y)) - HEAD
    const w = Math.max(...bs.map((b) => b.x + b.w)) + PAD - x0
    const h = Math.max(...bs.map((b) => b.y + b.h)) + PAD - y0
    frameBox.set(f.id, { x: x0, y: y0, w, h })
    nodes.unshift({
      id: f.id,
      position: { x: x0, y: y0 },
      width: w,
      height: h,
      data: { kind: 'frame', title: f.title, members: f.members, fold: f.fold, idle: f.idle },
      type: 'frame',
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      style: { pointerEvents: 'none' },
    })
  }

  // ── setup edges: out into the gap past the factories, along a bus above or below everything, then into
  // the card that uses the item (from above or below for an agent or the command, from the left for a
  // subagent). With two lanes, Claude's run above and Codex's below; with one, by where the item sits ──
  const rest = [...frameBox.entries()].filter(([id]) => !id.startsWith('frame:setup')).map(([, b]) => b)
  const topBus = Math.min(...rest.map((b) => b.y)) - 22
  const bottomBus = Math.max(...rest.map((b) => b.y + b.h)) + 22
  const half = (Math.min(...rest.map((b) => b.y)) + Math.max(...rest.map((b) => b.y + b.h))) / 2
  const gapX = frameW(SIZE.setup.w) + GUTTER / 2
  setupEdges.forEach((e, n) => {
    const to = boxes.get(e.target)!
    const above = many ? e.lane === first.engine : e.fromY <= half
    const bus = above ? topBus - n * 6 : bottomBus + n * 6
    const x1 = gapX - 18 + n * 6
    const start: [number, number] = [e.fromX, e.fromY]
    let points: [number, number][]
    let targetHandle: string
    const sub = /agent:/.test(e.target) && !/agent:main$/.test(e.target)
    if (sub) {
      // A subagent: down the inside edge of its frame, then in from the left at its name.
      const xEdge = to.x - 7 - (n % 3) * 3
      const ty = to.y + 18
      points = [start, [x1, e.fromY], [x1, bus], [xEdge, bus], [xEdge, ty], [to.x, ty]]
      targetHandle = 'left'
    } else {
      const tx = to.x + to.w / 2 + (n % 4) * 8 - 12
      const ty = above ? to.y : to.y + to.h
      points = [start, [x1, e.fromY], [x1, bus], [tx, bus], [tx, ty]]
      targetHandle = above ? 'top' : 'bottom'
    }
    edges.push({ id: e.id, source: e.source, target: e.target, sourceHandle: e.handle, targetHandle, type: 'flow', data: { live: e.live, tone: 'quiet', setup: true, points } })
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
