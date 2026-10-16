// Computes absolute positions for the org chart and the structural edges between nodes.
import type { Edge, Node } from '@xyflow/react'
import type { OrgDef } from '../../shared/types.ts'

export const CARD_W = 188
export const CEO_W = 200
export const CARD_H = 62
const INDENT = 22
const COL_W = CARD_W + INDENT
const COL_GAP = 16
const ROW_GAP = 16
const PAD = 22
const HEAD = 52
const DEPT_H = 28
const LABEL_H = 26
const DIV_GAP = 56
const TOP = 120
const SIDE_GAP = 24
const REPO_GAP = 48

export type NodeData =
  | { kind: 'owner' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'dept'; divisionId: string; deptId: string; compact: boolean }
  | { kind: 'division'; divisionId: string; width: number; height: number }

export type EdgeVariant = 'tree' | 'cross' | 'manual'
export type EdgeData = {
  variant: EdgeVariant
  centerX?: number
  /** Route along a vertical gutter at this x (left of the source), instead of a smooth-step. */
  gutter?: number
}

/** The selected project's own agents get their own frame under the main division. */
export const REPO_DIVISION = 'repo'

export interface Layout {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  adjacency: Map<string, { edgeId: string; other: string; forward: boolean }[]>
}

export function buildLayout(org: OrgDef): Layout {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const place = (id: string, x: number, y: number, data: NodeData, extra: Partial<Node<NodeData>> = {}) =>
    nodes.push({ id, position: { x, y }, data, type: data.kind, draggable: false, ...extra })
  let gutterX: number | undefined
  const edge = (source: string, target: string, sourceHandle: string, targetHandle: string, variant: EdgeVariant = 'tree', gutter?: number) =>
    edges.push({
      id: `${source}->${target}`, source, target, sourceHandle, targetHandle, type: 'pulse',
      // Cross-division edges run down the gap between divisions instead of through them.
      data: { variant, centerX: variant === 'tree' ? undefined : gutterX, gutter },
    })

  const [main, ...rest] = org.divisions
  const repo = rest.find((d) => d.id === REPO_DIVISION)
  // Divisions with nobody in them (e.g. Antigravity before any hire) stay off the chart.
  const side = rest.filter((d) => d.id !== REPO_DIVISION && (d.ceo || d.departments.some((dep) => dep.members.length)))
  const mainCeo = main?.ceo?.id

  // ── main division: departments as columns ──────────────────
  let mainW = 0
  let mainBottom = TOP
  if (main) {
    const n = Math.max(1, main.departments.length)
    mainW = Math.max(PAD * 2 + n * COL_W + (n - 1) * COL_GAP, CEO_W + PAD * 2 + 120)
    const ceoY = TOP + HEAD + 8
    const deptY = ceoY + CARD_H + 56
    const memberY = deptY + DEPT_H + 20
    const maxMembers = Math.max(1, ...main.departments.map((d) => d.members.length))
    const height = memberY - TOP + maxMembers * (CARD_H + ROW_GAP) + PAD
    mainBottom = TOP + height
    place(`div:${main.id}`, 0, TOP, { kind: 'division', divisionId: main.id, width: mainW, height }, { selectable: false, zIndex: -1 })
    if (main.ceo) place(main.ceo.id, mainW / 2 - CEO_W / 2, ceoY, { kind: 'agent', agentId: main.ceo.id })
    main.departments.forEach((dep, i) => {
      const x = (mainW - (n * COL_W + (n - 1) * COL_GAP)) / 2 + i * (COL_W + COL_GAP)
      const deptId = `dept:${main.id}:${dep.id}`
      place(deptId, x, deptY, { kind: 'dept', divisionId: main.id, deptId: dep.id, compact: false }, { selectable: false })
      if (main.ceo) edge(main.ceo.id, deptId, 'bottom', 'top')
      dep.members.forEach((m, j) => {
        place(m.id, x + INDENT, memberY + j * (CARD_H + ROW_GAP), { kind: 'agent', agentId: m.id })
        edge(deptId, m.id, 'bottom', 'left')
      })
    })
  }

  // ── the project's own agents: a frame of their own under the main division, in one row.
  // The CEO reaches it down the left gutter; company members reach it through `delegate`.
  if (main && repo) {
    const members = repo.departments.flatMap((d) => d.members)
    const head = repo.departments[0]
    if (head && members.length) {
      const rowW = members.length * CARD_W + (members.length - 1) * COL_GAP
      const w = Math.max(mainW, rowW + PAD * 2)
      const x0 = (mainW - w) / 2
      const top = mainBottom + REPO_GAP
      const headerY = top + HEAD + 4
      const rowY = headerY + DEPT_H + 34
      const headId = `dept:${repo.id}:${head.id}`
      place(`div:${repo.id}`, x0, top, { kind: 'division', divisionId: repo.id, width: w, height: rowY - top + CARD_H + PAD }, { selectable: false, zIndex: -1 })
      place(headId, x0 + PAD, headerY, { kind: 'dept', divisionId: repo.id, deptId: head.id, compact: false }, { selectable: false })
      if (mainCeo) edge(mainCeo, headId, 'left-src', 'left', 'tree', Math.min(0, x0) - DIV_GAP / 2)
      members.forEach((m, i) => {
        place(m.id, x0 + (w - rowW) / 2 + i * (CARD_W + COL_GAP), rowY, { kind: 'agent', agentId: m.id })
        edge(headId, m.id, 'bottom', 'top')
      })
    }
  }

  // ── side divisions: right-hand column. Divisions with a CEO stack downward from the
  // main division's top; CEO-less (manual) studios sit above them, beside the owner,
  // which keeps the chart short so it renders larger.
  const sideX = mainW + DIV_GAP
  gutterX = mainW + DIV_GAP / 2
  const sideW = PAD * 2 + COL_W + 8
  const heightOf = (div: (typeof side)[number]) =>
    HEAD + 8 + (div.ceo ? CARD_H + 22 : 0) +
    div.departments.reduce((h, dep) => h + LABEL_H + 8 + dep.members.length * (CARD_H + ROW_GAP), 0) + PAD - ROW_GAP + 6
  const placeSide = (div: (typeof side)[number], top: number) => {
    let cy = top + HEAD + 8
    if (div.ceo) {
      place(div.ceo.id, sideX + PAD, cy, { kind: 'agent', agentId: div.ceo.id })
      if (mainCeo) edge(mainCeo, div.ceo.id, 'right', 'left', 'cross')
      cy += CARD_H + 22
    }
    for (const dep of div.departments) {
      place(`dept:${div.id}:${dep.id}`, sideX + PAD, cy, { kind: 'dept', divisionId: div.id, deptId: dep.id, compact: true }, { selectable: false })
      cy += LABEL_H + 8
      for (const m of dep.members) {
        place(m.id, sideX + PAD + INDENT, cy, { kind: 'agent', agentId: m.id })
        if (div.ceo) edge(div.ceo.id, m.id, 'left-src', 'left')
        else if (mainCeo) edge(mainCeo, m.id, 'right', 'left', div.mode === 'manual' ? 'manual' : 'cross')
        cy += CARD_H + ROW_GAP
      }
    }
    place(`div:${div.id}`, sideX, top, { kind: 'division', divisionId: div.id, width: sideW, height: heightOf(div) }, { selectable: false, zIndex: -1 })
  }
  let below = TOP
  for (const div of side.filter((d) => d.ceo)) {
    placeSide(div, below)
    below += heightOf(div) + SIDE_GAP
  }
  let above = TOP - SIDE_GAP
  for (const div of side.filter((d) => !d.ceo)) {
    above -= heightOf(div)
    placeSide(div, above)
    above -= SIDE_GAP
  }

  // ── owner on top ───────────────────────────────────────────
  const totalW = side.length ? sideX + sideW : mainW
  place(org.owner.id, main ? mainW / 2 + 40 : totalW / 2 - 120, 0, { kind: 'owner' })
  if (mainCeo) edge(org.owner.id, mainCeo, 'bottom', 'top')

  const adjacency: Layout['adjacency'] = new Map()
  const link = (a: string, b: string, edgeId: string, forward: boolean) => {
    if (!adjacency.has(a)) adjacency.set(a, [])
    adjacency.get(a)!.push({ edgeId, other: b, forward })
  }
  for (const e of edges) {
    link(e.source, e.target, e.id, true)
    link(e.target, e.source, e.id, false)
  }
  return { nodes, edges, adjacency }
}

/** Shortest path of edges between two nodes (undirected BFS). */
export function findPath(layout: Layout, from: string, to: string): { edgeId: string; forward: boolean }[] | null {
  if (from === to) return []
  const prev = new Map<string, { node: string; edgeId: string; forward: boolean }>()
  const queue = [from]
  const seen = new Set([from])
  while (queue.length) {
    const cur = queue.shift()!
    for (const n of layout.adjacency.get(cur) ?? []) {
      if (seen.has(n.other)) continue
      seen.add(n.other)
      prev.set(n.other, { node: cur, edgeId: n.edgeId, forward: n.forward })
      if (n.other === to) {
        const path: { edgeId: string; forward: boolean }[] = []
        let at = to
        while (at !== from) {
          const p = prev.get(at)!
          path.unshift({ edgeId: p.edgeId, forward: p.forward })
          at = p.node
        }
        return path
      }
      queue.push(n.other)
    }
  }
  return null
}
