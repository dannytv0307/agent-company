// Computes absolute positions for the project canvas: the repo's slash commands on the left, its
// agents in the middle (Claude Code above Codex), their latest delivered output on the right, and the
// edges between them. The organizer (the chat on the left) comes in along a lane at the bottom.
import type { Edge, Node } from '@xyflow/react'
import type { AgentRef, RepoCommand } from '../../shared/types.ts'

export const CARD_W = 228
export const CARD_H = 62
export const CMD_W = 210
export const CMD_H = 58
const GAP = 16
const PAD = 36
const HEAD = 108
const LABEL_H = 34
/** Between the command column and the agent column: room for the edges to turn. */
const MID = 210
const SECTION_GAP = 30
/** Left of the commands: where the chat comes in. */
const ENTRY_W = 28
const NOTE_H = 72
/** Under everything: the lane the organizer's arrows run along to the agents at work. */
const LANE_H = 52
/** The organizer's arrows turn up this far left of the agent column. */
const LANE_IN = 30
const OUT_GAP = 64
export const OUT_W = 270

export type Engine = 'claude' | 'codex'
export type Section = 'commands' | Engine | 'outputs' | 'spawned'

export type NodeData =
  | { kind: 'frame'; title: string; width: number; height: number }
  | { kind: 'label'; section: Section; count: number }
  | { kind: 'command'; command: RepoCommand }
  | { kind: 'agent'; agentId: string }
  /** An output: a team agent's latest delivery (by agent id), or a spawned helper's (by `aid`). */
  | { kind: 'result'; agentId: string; aid?: string }
  | { kind: 'spawned'; aid: string }
  | { kind: 'entry' }
  | { kind: 'note'; note: 'noCommands' | 'noAgents' }

/** entry: chat → command. link: command → agent. lead: organizer → agent at work. output: agent → its output. */
export type EdgeVariant = 'entry' | 'link' | 'lead' | 'output'
export type EdgeData = {
  variant: EdgeVariant
  hot?: boolean
  /** Work is going along this arrow right now: it stays lit and flows until the work ends. */
  live?: boolean
  /** Run right along the source's row, up (or down) at this x, then right into the target. */
  lane?: number
}

/** Where messages from the chat enter the canvas. */
export const ENTRY = 'entry'
export const cmdNode = (name: string) => `cmd:${name}`
export const outNode = (agentId: string) => `out:${agentId}`
export const spawnedNode = (aid: string) => `spawned:${aid}`

export interface Layout {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
}

/**
 * `outputs`: the agents that have delivered something in this project. `spawned`: helpers Claude Code
 * spawned for itself (by their Agent call id), shown under the team; `finished`: those with an output.
 */
export function buildLayout(
  title: string,
  commands: RepoCommand[],
  team: AgentRef[],
  outputs: string[] = [],
  spawned: string[] = [],
  finished: string[] = [],
): Layout {
  const nodes: Node<NodeData>[] = []
  const edges: Edge<EdgeData>[] = []
  const place = (id: string, x: number, y: number, data: NodeData, extra: Partial<Node<NodeData>> = {}) =>
    nodes.push({ id, position: { x, y }, data, type: data.kind, draggable: false, selectable: false, ...extra })
  const link = (source: string, target: string, variant: EdgeVariant, lane?: number) =>
    edges.push({ id: `${source}->${target}`, source, target, sourceHandle: 'right', targetHandle: 'left', type: 'pulse', data: { variant, lane } })

  // ── left column: slash commands ────────────────────────────
  const x0 = PAD + ENTRY_W
  let left = HEAD
  place('label:commands', x0, left, { kind: 'label', section: 'commands', count: commands.length })
  left += LABEL_H
  if (!commands.length) {
    place('note:commands', x0, left, { kind: 'note', note: 'noCommands' })
    left += NOTE_H
  }
  for (const c of commands) {
    place(cmdNode(c.name), x0, left, { kind: 'command', command: c })
    left += CMD_H + GAP
  }

  // ── right column: the team, one section per engine ────────
  const x1 = x0 + CMD_W + MID
  let right = HEAD
  const ids = new Set(team.map((a) => a.id))
  const sections = (['claude', 'codex'] as const)
    .map((rt) => ({ rt, members: team.filter((a) => (a.runtime === 'codex' ? 'codex' : 'claude') === rt) }))
    .filter((s) => s.members.length)
  if (!sections.length && !spawned.length) {
    place('note:agents', x1, right + LABEL_H, { kind: 'note', note: 'noAgents' })
    right += LABEL_H + NOTE_H
  }
  // ── outputs: each agent's latest delivery, on its row ─────
  const x2 = x1 + CARD_W + OUT_GAP
  const delivered = new Set(outputs.filter((id) => ids.has(id)))
  const done = new Set(finished)
  const outCount = delivered.size + spawned.filter((aid) => done.has(aid)).length
  if (outCount) place('label:outputs', x2, HEAD, { kind: 'label', section: 'outputs', count: outCount })
  sections.forEach(({ rt, members }, i) => {
    if (i) right += SECTION_GAP - GAP
    place(`label:${rt}`, x1, right, { kind: 'label', section: rt, count: members.length })
    right += LABEL_H
    for (const a of members) {
      place(a.id, x1, right, { kind: 'agent', agentId: a.id })
      if (delivered.has(a.id)) {
        place(outNode(a.id), x2, right, { kind: 'result', agentId: a.id })
        link(a.id, outNode(a.id), 'output')
      }
      right += CARD_H + GAP
    }
  })
  // Helpers Claude Code spawned on its own: under the team while they run, then their output.
  if (spawned.length) {
    if (sections.length) right += SECTION_GAP - GAP
    place('label:spawned', x1, right, { kind: 'label', section: 'spawned', count: spawned.length })
    right += LABEL_H
    for (const aid of spawned) {
      const id = spawnedNode(aid)
      place(id, x1, right, { kind: 'spawned', aid })
      if (done.has(aid)) {
        place(outNode(id), x2, right, { kind: 'result', agentId: id, aid })
        link(id, outNode(id), 'output')
      }
      right += CARD_H + GAP
    }
  }

  const width = (outCount ? x2 + OUT_W : x1 + CARD_W) + PAD
  const height = Math.max(left, right) - GAP + LANE_H + PAD / 2
  place('frame', 0, 0, { kind: 'frame', title, width, height }, { zIndex: -1 })

  // The chat (and the organizer behind it) comes in at the bottom left, like the message box beside it.
  place(ENTRY, PAD / 2, height - PAD / 2 - LANE_H + 12, { kind: 'entry' })
  for (const c of commands) {
    link(ENTRY, cmdNode(c.name), 'entry')
    for (const id of c.agents ?? []) if (ids.has(id)) link(cmdNode(c.name), id, 'link')
  }
  // The organizer to every agent: shown while that agent is at work.
  for (const a of team) link(ENTRY, a.id, 'lead', x1 - LANE_IN)
  for (const aid of spawned) link(ENTRY, spawnedNode(aid), 'lead', x1 - LANE_IN)
  return { nodes, edges }
}
