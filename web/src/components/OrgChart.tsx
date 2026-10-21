import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Handle, Position, ReactFlow, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { useT } from '../i18n.ts'
import { ago, useCompanyCtx } from '../context.ts'
import { cmdNode, ENTRY, OUT_W, type EdgeData, type NodeData } from '../layout.ts'
import type { Pulse } from '../store.ts'
import { ACTIVITY } from './AgentPanel.tsx'
import type { AgentRef, L10n } from '../../../shared/types.ts'

type FlowNode = Node<NodeData>
type FlowEdge = Edge<EdgeData & { pulses?: Pulse[] }>

const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' }

/**
 * The nodes lit up by the pointer or by what is being typed. Passed by context, not as new node
 * objects: React Flow hides a changed node until it has measured it again, which made them blink.
 */
const Hot = createContext<Set<string>>(new Set())
/** Commands running right now (sent from the chat and still being worked on). */
const Live = createContext<Set<string>>(new Set())

export const monogram = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '·'

/** The line under an agent's name: their role — or, when the role just repeats the name, what they do. */
export function subtitle(a: AgentRef, l: (v?: L10n) => string, t: (k: 'leadsAll') => string): string {
  if (l(a.role) !== l(a.name)) return l(a.role)
  if (a.isCeo) return t('leadsAll')
  // "Art Director — defines the visual style…" → "defines the visual style…"
  const rest = a.description.replace(/^[^—–:.]*[—–:.]\s*/, '').trim()
  return rest ? rest[0].toUpperCase() + rest.slice(1) : l(a.role)
}

function AgentNode({ id }: NodeProps<FlowNode>) {
  const { company, select, focus } = useCompanyCtx()
  const hot = useContext(Hot).has(id)
  const { t, l } = useT()
  const a = company.agents.find((x) => x.id === id)
  const s = company.states[id]
  const faded = focus && !company.involved.has(id)
  if (!a || !s) return null
  const live = !!s.bubble && ['working', 'waiting', 'error'].includes(s.status)
  const projectName = (pid?: string) => company.projects.find((p) => p.id === pid)?.name
  const many = s.active.length > 1
  const tip = s.active.length
    ? s.active.map((w) => `• ${w.text.replace(/^[^\p{L}\p{N}$]+/u, '')}${projectName(w.projectId) ? `  — ${projectName(w.projectId)}` : ''}`).join('\n')
    : s.bubble
  return (
    <div
      className={`card st-${s.status}${a.external ? ' external' : ''}${hot ? ' hot' : ''}${faded ? ' faded' : ''}`}
      style={{ '--c': a.color } as CSSProperties}
      title={tip}
    >
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <Handle type="source" position={Position.Right} id="right" style={hidden} />
      <span className="mono">{monogram(l(a.name))}</span>
      <div className="who">
        <div className="name">{l(a.name)}</div>
        <div className={`sub${live ? ' live' : ''}`}>
          {live ? s.bubble!.replace(/^[^\p{L}\p{N}$]+/u, '') : subtitle(a, l, t)}
        </div>
      </div>
      {many ? <span className="count-badge">×{s.active.length}</span> : <span className="dot" title={t(s.status)} />}
      <button
        className="card-info"
        title={t('details')}
        aria-label={t('details')}
        onClick={(e) => {
          e.stopPropagation() // the card itself calls the agent in the chat
          select(id)
        }}
      >
        i
      </button>
    </div>
  )
}

function CommandNode({ id, data }: NodeProps<FlowNode>) {
  const { typingCommand } = useCompanyCtx()
  const hot = useContext(Hot).has(id)
  const live = useContext(Live).has(id)
  if (data.kind !== 'command') return null
  const c = data.command
  return (
    <div className={`hex${typingCommand === c.name || live ? ' typing' : ''}${live ? ' live' : ''}${hot ? ' hot' : ''}`} title={[c.description, c.argumentHint && `/${c.name} ${c.argumentHint}`].filter(Boolean).join('\n\n')}>
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <Handle type="source" position={Position.Right} id="right" style={hidden} />
      <svg className="hex-shape" viewBox="0 0 210 58" preserveAspectRatio="none" aria-hidden>
        <polygon points="18,0.75 192,0.75 209.25,29 192,57.25 18,57.25 0.75,29" />
      </svg>
      <div className="hex-body">
        <span className="hex-name">/{c.name}</span>
        {c.description && <span className="hex-desc">{c.description}</span>}
      </div>
    </div>
  )
}

/**
 * A delivery: a team agent's latest one — fresh (just reported), or older while they work on something
 * new — or a spawned helper's, which fades out shortly before the helper leaves the canvas.
 */
function OutputNode({ id, data }: NodeProps<FlowNode>) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const hot = useContext(Hot).has(id)
  if (data.kind !== 'result') return null
  const helper = data.aid ? company.spawned.get(data.aid) : undefined
  const e = data.aid ? undefined : company.outputs.get(data.agentId)
  const out = helper?.output !== undefined ? { full: helper.output, ts: helper.endedAt ?? helper.startedAt, taskId: undefined, failed: helper.status === 'error' } : e
    ? { full: typeof e.meta?.full === 'string' ? e.meta.full : e.text, ts: e.ts, taskId: e.meta?.taskId, failed: false }
    : undefined
  if (!out) return null
  const st = company.states[data.agentId]
  const state = helper ? (company.now - out.ts > 35_000 ? ' leaving' : ' fresh') : st?.status === 'done' ? ' fresh' : st?.status === 'working' ? ' stale' : ''
  const { full } = out
  return (
    <div className={`output${state}${out.failed ? ' failed' : ''}${hot ? ' hot' : ''}`} style={{ width: OUT_W }} title={full}>
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <div className="output-head">
        <span className="check">{out.failed ? '!' : '✓'}</span>
        {out.failed ? t('error') : t('delivered')}
        {out.taskId ? <span className="task">{String(out.taskId)}</span> : null}
        <span className="when">{ago(out.ts, t)}</span>
      </div>
      <div className="output-text">{full.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')}</div>
    </div>
  )
}

/** A helper Claude Code spawned for itself: its type, what it was asked, what it is doing now. */
function SpawnedNode({ id, data }: NodeProps<FlowNode>) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const hot = useContext(Hot).has(id)
  if (data.kind !== 'spawned') return null
  const s = company.spawned.get(data.aid)
  if (!s) return null
  const status = s.status === 'running' ? 'working' : s.status
  const line = s.status === 'running' ? (s.activity ?? s.title).replace(/^[^\p{L}\p{N}$]+/u, '') : s.status === 'stopped' ? t('stoppedShort') : s.title
  const leaving = s.endedAt && company.now - s.endedAt > 35_000
  return (
    <div className={`card spawned st-${status}${hot ? ' hot' : ''}${leaving ? ' leaving' : ''}`} title={`${s.type}: ${s.title}${s.activity ? `\n\n${s.activity}` : ''}`}>
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <Handle type="source" position={Position.Right} id="right" style={hidden} />
      <span className="mono">{s.type === 'Explore' ? '⌕' : s.type === 'Plan' ? '◇' : '✦'}</span>
      <div className="who">
        <div className="name">
          {s.type}
          <span className="spawned-tag">{t('spawnedTag')}</span>
        </div>
        <div className={`sub${s.status === 'running' ? ' live' : ''}`}>{line}</div>
      </div>
      <span className="dot" title={t(status === 'stopped' ? 'idle' : status)} />
    </div>
  )
}

function LabelNode({ data }: NodeProps<FlowNode>) {
  const { t } = useT()
  if (data.kind !== 'label') return null
  const text =
    data.section === 'commands' ? t('slashCommands') : data.section === 'outputs' ? t('outputs') : data.section === 'spawned' ? t('spawned') : data.section === 'codex' ? 'Codex' : 'Claude Code'
  return (
    <div className={`section-label sec-${data.section}`}>
      {text}
      <span className="count">{data.count}</span>
    </div>
  )
}

function FrameNode({ data }: NodeProps<FlowNode>) {
  if (data.kind !== 'frame') return null
  return (
    <div className="frame" style={{ width: data.width, height: data.height }}>
      <div className="frame-title">{data.title}</div>
      <GitLine />
    </div>
  )
}

/** Under the project's name: its branch, what is not committed yet, and the latest commit. */
function GitLine() {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const g = company.git
  if (!g) return <div className="git-line" />
  if (!g.git) return <div className="git-line muted">{t('noGit')}</div>
  const changed = g.files.filter((f) => f.status)
  const last = g.commits[0]
  const tip = [
    changed.length ? `${t('uncommitted')}:` : t('clean'),
    ...changed.slice(0, 12).map((f) => `  ${f.status} ${f.path}`),
    ...(changed.length > 12 ? ['  …'] : []),
    ...(g.commits.length ? ['', `${t('recentCommits')}:`, ...g.commits.slice(0, 5).map((c) => `  ${c.hash} ${c.subject} (${c.when})`)] : []),
  ].join('\n')
  return (
    <div className="git-line" title={tip}>
      <span className="branch">
        <svg viewBox="0 0 16 16" aria-hidden>
          <circle cx="4" cy="3.5" r="1.8" />
          <circle cx="4" cy="12.5" r="1.8" />
          <circle cx="12" cy="5.5" r="1.8" />
          <path d="M4 5.3v5.4M12 7.3c0 2.5-3 2.7-6.6 4.4" />
        </svg>
        {g.branch ?? 'HEAD'}
      </span>
      <span className={changed.length ? 'dirty' : 'clean'}>{changed.length ? `${changed.length} ${t('changedFiles')}` : t('clean')}</span>
      {last && (
        <span className="commit">
          <code>{last.hash}</code> {last.subject} · {last.when}
        </span>
      )}
    </div>
  )
}

/** The chat and the organizer behind it: where messages and hand-offs come in. */
function EntryNode() {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const organizer = company.agents.find((a) => a.id === company.org?.divisions[0]?.ceo?.id)
  const busy = company.states[organizer?.id ?? '']?.status === 'working'
  return (
    <div className={`entry${busy ? ' busy' : ''}`} title={t('entryHint')}>
      <Handle type="source" position={Position.Right} id="right" style={hidden} />
      <span className="entry-label">{l(organizer?.name)}</span>
    </div>
  )
}

function NoteNode({ data }: NodeProps<FlowNode>) {
  const { t } = useT()
  if (data.kind !== 'note') return null
  return <div className="canvas-note">{t(data.note)}</div>
}

/** Trail behind a moving packet: how far back each dot sits (px) and how big it is. */
const TRAIL = [
  { back: 0, r: 4.2 },
  { back: 7, r: 3.2 },
  { back: 14, r: 2.4 },
  { back: 21, r: 1.7 },
  { back: 28, r: 1.1 },
]

/** A packet of information running once along an edge: a glowing head with a fading trail, eased in and out. */
function PulseDot({ pathRef, p }: { pathRef: RefObject<SVGPathElement | null>; p: Pulse }) {
  const group = useRef<SVGGElement>(null)
  useEffect(() => {
    const path = pathRef.current
    const g = group.current
    if (!path || !g) return
    const dots = [...g.querySelectorAll('circle')]
    const len = path.getTotalLength()
    const start = performance.now() + p.delay
    const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)
    let raf = 0
    const tick = (now: number) => {
      const k = (now - start) / p.dur
      if (k < 0 || k > 1) {
        g.style.opacity = '0'
        if (k > 1) return
      } else {
        const at = len * ease(k)
        dots.forEach((c, i) => {
          const d = Math.max(0, at - TRAIL[i].back)
          const pt = path.getPointAtLength(p.forward ? d : len - d)
          c.setAttribute('cx', String(pt.x))
          c.setAttribute('cy', String(pt.y))
        })
        g.style.opacity = '1'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pathRef, p])
  return (
    <g ref={group} className="packet" style={{ opacity: 0, '--pc': p.color } as CSSProperties}>
      {TRAIL.map((t, i) => (
        <circle key={i} r={t.r} style={{ opacity: 1 - i * 0.18 }} />
      ))}
    </g>
  )
}

/**
 * Information flowing along an edge for as long as the work behind it lasts: comets running one after
 * another from source to target, at an even speed whatever the edge's length.
 */
function Flow({ d, length }: { d: string; length: number }) {
  const dur = Math.max(1.4, length / 150)
  const n = Math.max(2, Math.min(4, Math.round(length / 180)))
  return (
    <g className="flow" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <g key={i}>
          <ellipse rx={15} ry={3.2} cx={-10} className="comet" />
          <circle r={3.8} className="comet-head" />
          <animateMotion dur={`${dur}s`} begin={`${-(i * dur) / n}s`} repeatCount="indefinite" rotate="auto" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
        </g>
      ))}
    </g>
  )
}

/** Right along the source's row to x = lane, up or down to the target's row, then right into it — rounded. */
function lanePath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty }: EdgeProps<FlowEdge>, lane: number) {
  const r = Math.max(0, Math.min(12, Math.abs(ty - sy) / 2, lane - sx, tx - lane))
  const dir = ty < sy ? -1 : 1
  return `M ${sx} ${sy} H ${lane - r} Q ${lane} ${sy} ${lane} ${sy + r * dir} V ${ty - r * dir} Q ${lane} ${ty} ${lane + r} ${ty} H ${tx}`
}

function PulseEdge(props: EdgeProps<FlowEdge>) {
  const ref = useRef<SVGPathElement>(null)
  const lane = props.data?.lane
  const d = lane === undefined ? getSmoothStepPath({ ...props, borderRadius: 12, offset: 18 })[0] : lanePath(props, lane)
  const pulses = props.data?.pulses ?? []
  const active = pulses.length > 0
  const { sourceX: sx, sourceY: sy, targetX: x, targetY: y } = props
  // The paths only turn at right angles, so this is their length (give or take the rounded corners).
  const length = lane === undefined ? Math.abs(x - sx) + Math.abs(y - sy) : Math.abs(lane - sx) + Math.abs(y - sy) + Math.abs(x - lane)
  return (
    <g
      className={`edge ${props.data?.variant ?? 'link'}${props.data?.hot ? ' hot' : ''}${props.data?.live ? ' live' : ''}${active ? ' active' : ''}`}
      style={active ? ({ '--pc': pulses[pulses.length - 1].color } as CSSProperties) : undefined}
    >
      <path d={d} className="edge-line" />
      {/* Every edge enters its target from the left, so the arrowhead points right. */}
      <path d={`M ${x - 8} ${y - 4.5} L ${x} ${y} L ${x - 8} ${y + 4.5} Z`} className="edge-head" />
      <path ref={ref} d={d} fill="none" stroke="none" />
      {props.data?.live && <Flow d={d} length={length} />}
      {pulses.map((p) => (
        <PulseDot key={p.id} pathRef={ref} p={p} />
      ))}
    </g>
  )
}

// Never blow a small project up past 100%.
const FIT = { padding: 0.06, maxZoom: 1 }

const nodeTypes = { agent: AgentNode, spawned: SpawnedNode, result: OutputNode, command: CommandNode, label: LabelNode, frame: FrameNode, entry: EntryNode, note: NoteNode }
const edgeTypes = { pulse: PulseEdge }

/** The selected project: its slash commands, its agents, and which agents each command calls. */
export function OrgChart() {
  const { company, select, fill, typingCommand, typingAgent } = useCompanyCtx()
  const { layout, pulses } = company
  const { fitView } = useReactFlow()
  const [hover, setHover] = useState<string | null>(null)

  // Keep the whole project in view whenever the canvas changes size: the window, or a side panel
  // opening, closing or being dragged wider.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    let t: ReturnType<typeof setTimeout>
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => void fitView({ ...FIT, duration: document.body.classList.contains('resizing') ? 0 : 220 }), 40)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [fitView, !!layout])

  // Refit whenever the layout itself changes (another project, a new agent or command).
  useEffect(() => {
    if (!layout) return
    const t = setTimeout(() => void fitView(FIT), 60)
    return () => clearTimeout(t)
  }, [layout, fitView])

  // Light up what the pointer is on, or the command or agent being typed, and everything wired to it.
  const pid = company.project?.id
  // Commands still running: work in this project whose message started with "/name".
  const running = useMemo(() => {
    const names = new Set((company.project?.scan?.commands ?? []).map((c) => c.name))
    const out = new Set<string>()
    for (const w of company.work) {
      const name = w.projectId === pid ? w.title.match(/^\/([\w:.-]+)/)?.[1] : undefined
      if (name && names.has(name)) out.add(cmdNode(name))
    }
    return out
  }, [company.work, company.project, pid])

  // Light up what the pointer is on, the command or agent being typed, and — for as long as the work
  // lasts — every arrow to a command that is running and to an agent at work.
  const { hotNodes, edges } = useMemo(() => {
    const hotNodes = new Set<string>()
    if (!layout) return { hotNodes, edges: [] }
    const by = new Map<string, Pulse[]>()
    for (const p of pulses) by.set(p.edgeId, [...(by.get(p.edgeId) ?? []), p])
    const typing = typingCommand ? cmdNode(typingCommand) : null
    if (typingAgent) hotNodes.add(typingAgent)
    const busy = (id: string) => {
      if (id.startsWith('spawned:')) return company.spawned.get(id.slice('spawned:'.length))?.status === 'running'
      return company.states[id]?.status === 'working' || company.work.some((w) => w.agentId === id && w.projectId === pid)
    }
    // Agents reached through a running command get their arrow from it, not a second one from the organizer.
    const viaCommand = new Set(layout.edges.filter((e) => e.data!.variant === 'link' && running.has(e.source) && busy(e.target)).map((e) => e.target))
    const edges = layout.edges.map((e) => {
      const v = e.data!.variant
      let hot = false
      let live = false
      if (v === 'lead') {
        live = busy(e.target) && !viaCommand.has(e.target)
        hot = live || e.target === typingAgent
      } else if (v === 'entry') {
        live = running.has(e.target)
        hot = live || e.target === typing
      } else if (v === 'link') {
        live = running.has(e.source) && busy(e.target)
        hot = live || running.has(e.source) || e.source === hover || e.target === hover || e.source === typing
      } else {
        hot = e.source === hover || e.target === hover || company.states[e.source]?.status === 'done' || e.source.startsWith('spawned:')
      }
      if (hot && v !== 'lead') {
        hotNodes.add(e.source)
        hotNodes.add(e.target)
      }
      return { ...e, data: { ...e.data!, hot, live, pulses: by.get(e.id) } }
    })
    hotNodes.delete(ENTRY)
    return { hotNodes, edges }
  }, [layout, pulses, hover, typingCommand, typingAgent, running, pid, company.states, company.spawned, company.work])

  if (!layout) return <div className="loading">…</div>

  return (
    <div className="chart" ref={box}>
      {/* The comets' tails: transparent behind, solid at the head (they are drawn pointing right). */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <linearGradient id="comet-tail" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0.9 }} />
          </linearGradient>
        </defs>
      </svg>
      <Hot.Provider value={hotNodes}>
      <Live.Provider value={running}>
      <ReactFlow<FlowNode, FlowEdge>
        nodes={layout.nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={FIT}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeMouseEnter={(_, n) => (['agent', 'spawned', 'command', 'result'].includes(n.data.kind) ? setHover(n.id) : undefined)}
        onNodeMouseLeave={() => setHover(null)}
        onNodeClick={(_, n) => {
          // An agent or a command: start calling it in the chat. An output: open that agent's activity,
          // where the full report is.
          if (n.data.kind === 'agent') fill(`@${n.id} `)
          else if (n.data.kind === 'command') fill(`/${n.data.command.name} `)
          else if (n.data.kind === 'result') select(n.data.aid ? ACTIVITY : n.data.agentId)
        }}
        onPaneClick={() => select(null)}
      />
      </Live.Provider>
      </Hot.Provider>
    </div>
  )
}
