import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Handle, Position, ReactFlow, getSmoothStepPath, useReactFlow, useUpdateNodeInternals, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { agentOf, duration, ago, shortPath, stepOf, useFlow, type Selection } from '../context.ts'
import { buildLayout, filesHeight, lineage, livePath, SETUP_ROWS, type EdgeData, type NodeData } from '../layout.ts'
import { displayName, groupOf, keyOf, kindLabel, originOf, scopeLabel, sorted, STATUS_TEXT } from '../setup.ts'
import { send } from '../vscode.ts'
import { pendingStep, waitingText } from '../../../shared/waiting.ts'

type FlowNode = Node<NodeData>
type FlowEdge = Edge<EdgeData>

const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' }
const In = () => <Handle type="target" position={Position.Left} id="left" style={hidden} />
const Out = () => <Handle type="source" position={Position.Right} id="right" style={hidden} />
/** Where setup edges come in, from above or below. */
const FromSetup = () => (
  <>
    <Handle type="target" position={Position.Top} id="top" style={hidden} />
    <Handle type="target" position={Position.Bottom} id="bottom" style={hidden} />
  </>
)

const same = (a: Selection | null, b: Selection) => !!a && JSON.stringify(a) === JSON.stringify(b)

/** The nodes in focus — the path under the pointer, or where work is going on — or null for all. */
const FocusContext = createContext<Set<string> | null>(null)
/** The nodes work is going through right now. */
const LiveContext = createContext<Set<string> | null>(null)

/** Tool → a glyph for its chip. */
function glyph(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return '›_'
  if (tool === 'Read' || tool === 'NotebookRead') return '◱'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') return '✎'
  if (tool === 'Grep' || tool === 'Glob') return '⌕'
  if (tool === 'WebFetch' || tool === 'WebSearch') return '◎'
  if (tool === 'TodoWrite') return '☑'
  if (tool === 'Skill') return '✦'
  if (tool.includes(' · ')) return '⧉' // MCP
  return '•'
}

function PromptNode() {
  const { view, selected } = useFlow()
  const t = view.turn
  return (
    <div className={`node prompt${same(selected, { kind: 'prompt' }) ? ' selected' : ''}`}>
      <Out />
      <div className="node-head">
        <span className="kicker">You</span>
        {t && <span className="when">{ago(t.start)}</span>}
      </div>
      <div className="prompt-text">{t?.prompt ?? 'No prompt yet'}</div>
    </div>
  )
}

function CommandNode() {
  const { view, setup } = useFlow()
  const c = view.turn?.command
  if (!c) return null
  const def = setup.byNode.get('command')?.[0]
  return (
    <div className={`hex${view.status === 'working' ? ' live' : ''}`} title={c.args ? `/${c.name} ${c.args}` : `/${c.name}`}>
      <In />
      <Out />
      <FromSetup />
      <svg className="hex-shape" viewBox="0 0 210 58" preserveAspectRatio="none" aria-hidden>
        <polygon points="18,0.75 192,0.75 209.25,29 192,57.25 18,57.25 0.75,29" />
      </svg>
      <div className="hex-body">
        <span className="hex-name">/{c.name}</span>
        <span className="hex-desc">{def ? originOf(def) : 'slash command'}</span>
      </div>
    </div>
  )
}

function AgentNode({ data, id }: NodeProps<FlowNode>) {
  const { view, setup, now, selected } = useFlow()
  if (data.kind !== 'agent') return null
  const a = agentOf(view, data.agentId)
  if (!a) return null
  const main = a.kind === 'main'
  const running = a.status === 'running' && (!main || view.status === 'working')
  const step = [...a.steps].reverse().find((s) => s.status === 'running')
  const wait = waitingText(view)
  const asking = !!wait && pendingStep(view)?.agent.id === a.id
  const doing = asking ? `Waiting for you: ${wait}` : main && !view.turn ? 'Waiting for a prompt' : running ? (step ? `${step.tool} ${step.label}` : main ? (a.said ? 'Writing…' : 'Thinking…') : 'Starting…') : a.status === 'error' ? (main ? 'Stopped' : 'Failed') : 'Done'
  const elapsed = (a.end ?? (running ? now : a.start)) - a.start
  const def = setup.byNode.get(id)?.find((i) => i.kind === 'agent')
  return (
    <div className={`node agent ${main ? 'main' : 'sub'} st-${asking ? 'waiting' : running ? 'running' : a.status}${same(selected, { kind: 'agent', id: a.id }) ? ' selected' : ''}`}>
      <In />
      <Out />
      <FromSetup />
      <div className="node-head">
        <span className="avatar">{main ? 'C' : a.type === 'Explore' ? '⌕' : a.type === 'Plan' ? '◇' : '✦'}</span>
        <span className="agent-name" title={main ? 'Claude' : a.type}>
          {main ? 'Claude' : a.type}
        </span>
        <span className="dot" />
      </div>
      {main && a.model && <div className="agent-model">{a.model.replace(/^claude-/, '')}</div>}
      {!main && <div className="agent-title">{a.title}</div>}
      <div className={`agent-doing${asking ? ' waiting' : running ? ' live' : ''}`}>{doing}</div>
      <div className="agent-meta">
        {!main && def && (
          <span className={`scope sc-${def.scope}`} title={def.path ?? originOf(def)}>
            {scopeLabel(def)}
          </span>
        )}
        {!main && a.background && <span className="tag">background</span>}
        <span>
          {a.steps.length} tool{a.steps.length === 1 ? '' : 's'} · {duration(elapsed)}
        </span>
      </div>
    </div>
  )
}

function StepNode({ data }: NodeProps<FlowNode>) {
  const { view, now, selected } = useFlow()
  if (data.kind !== 'step') return null
  const hit = stepOf(view, data.stepId)
  if (!hit) return null
  const s = hit.step
  return (
    <div className={`node step st-${waitingText(view) && pendingStep(view)?.step.id === s.id ? 'waiting' : s.status}${same(selected, { kind: 'step', id: s.id }) ? ' selected' : ''}`} title={`${s.tool} ${s.label}`}>
      <In />
      <span className="glyph">{glyph(s.tool)}</span>
      <span className="step-tool">{s.tool}</span>
      <span className="step-label">{s.label}</span>
      <span className="step-time">
        {waitingText(view) && pendingStep(view)?.step.id === s.id ? 'needs you' : s.status === 'running' ? duration(now - s.start) : s.end ? duration(s.end - s.start) : ''}
      </span>
      <span className="step-mark">{s.status === 'error' ? '✗' : s.status === 'done' ? '✓' : ''}</span>
    </div>
  )
}

function OutputNode({ data }: NodeProps<FlowNode>) {
  const { view, selected } = useFlow()
  if (data.kind !== 'result') return null
  const a = agentOf(view, data.of)
  if (!a?.output) return null
  const failed = a.status === 'error'
  return (
    <div className={`node output${failed ? ' failed' : ''}${same(selected, { kind: 'output', of: a.id }) ? ' selected' : ''}`} title={a.output}>
      <In />
      <div className="node-head">
        <span className="kicker">{failed ? '! ' : '✓ '}{a.kind === 'main' ? 'Reply' : `${a.type} report`}</span>
        {a.end && <span className="when">{ago(a.end)}</span>}
      </div>
      <div className="output-text">{a.output.replace(/^#+\s*/gm, '').replace(/\*\*/g, '')}</div>
    </div>
  )
}

function FilesNode() {
  const { view, selected } = useFlow()
  const files = view.files.filter((f) => f.writes > 0).sort((a, b) => b.last - a.last)
  return (
    <div className={`node files${same(selected, { kind: 'files' }) ? ' selected' : ''}`} style={{ height: filesHeight(files.length) }}>
      <In />
      <div className="node-head">
        <span className="kicker">Files changed · {files.length}</span>
      </div>
      <ul>
        {files.slice(0, 8).map((f) => (
          <li key={f.path}>
            <button
              className="file-link"
              title={`${f.path}\nOpen the change`}
              onClick={(e) => {
                e.stopPropagation()
                send({ type: 'diff', path: f.path })
              }}
            >
              {shortPath(f.path, view.cwd)}
            </button>
            <span className="edits">×{f.writes}</span>
          </li>
        ))}
        {files.length > 8 && <li className="more">+{files.length - 8} more</li>}
      </ul>
    </div>
  )
}

/** One kind of setup — agents, skills, MCP servers… — with the items in use lit up. */
function SetupNode({ data, id }: NodeProps<FlowNode>) {
  const { setup, selected, select } = useFlow()
  const group = data.kind === 'setup' ? data.group : 'memory'
  const items = sorted(setup, group)
  const rows = group === 'memory' ? 0 : Math.min(items.length, SETUP_ROWS)
  // React Flow measures handles once; new rows need it to look again.
  const updateInternals = useUpdateNodeInternals()
  useEffect(() => updateInternals(id), [rows, id, updateInternals])
  if (data.kind !== 'setup') return null
  const g = groupOf(data.group)
  const usedBy = (key: string) => setup.uses.get(key)
  const live = items.some((i) => usedBy(keyOf(i))?.some((u) => u.live))
  const used = items.filter((i) => usedBy(keyOf(i))?.length).length
  const found = data.group === 'found'
  const trouble = items.filter((i) => i.status === 'failed' || i.status === 'needs-auth').length
  return (
    <div className={`node setup${found ? ' found' : live ? ' live' : used ? ' used' : ''}${selected?.kind === 'setup' && selected.group === data.group ? ' selected' : ''}`}>
      <Out />
      {/* One handle per row, so an edge leaves from the very item in use. Rows start 41px down (border,
          padding, header) and are 22px high. */}
      {Array.from({ length: rows }, (_, n) => (
        <Handle key={n} type="source" position={Position.Right} id={`row${n}`} style={{ ...hidden, top: 52 + n * 22 }} />
      ))}
      <div className="node-head">
        <span className="setup-glyph">{g.glyph}</span>
        <span className="setup-title">{g.title}</span>
        <span className="count">{items.length}</span>
        {used > 0 && data.group !== 'memory' && <span className="in-use">{used} in use</span>}
        {!used && trouble > 0 && <span className="in-use trouble">{trouble} not connected</span>}
      </div>
      <ul>
        {items.length === 0 && <li className="hint">{g.hint}</li>}
        {items.slice(0, SETUP_ROWS).map((i) => {
          const u = usedBy(keyOf(i))
          const state = u?.some((x) => x.live) ? ' live' : u?.length ? ' used' : ''
          return (
            <li
              key={keyOf(i)}
              className={`setup-row${state}${i.status ? ` ms-${i.status}` : ''}${i.scope === 'builtin' || i.scope === 'connector' ? ' soft' : ''}${selected?.kind === 'setup' && selected.item === keyOf(i) ? ' picked' : ''}`}
            >
              <button
                title={[displayName(i), i.status && (i.error ? `${STATUS_TEXT[i.status]}: ${i.error}` : STATUS_TEXT[i.status]), i.unloaded ?? i.description]
                  .filter(Boolean)
                  .join('\n')}
                onClick={(e) => {
                  e.stopPropagation()
                  select({ kind: 'setup', group: data.group, item: keyOf(i) })
                }}
              >
                <i />
                <span className="setup-name">{displayName(i)}</span>
                <span className={`scope sc-${found ? 'found' : i.scope}`}>{found ? kindLabel(i) : scopeLabel(i)}</span>
              </button>
            </li>
          )
        })}
        {items.length > SETUP_ROWS && <li className="more">+{items.length - SETUP_ROWS} more</li>}
      </ul>
    </div>
  )
}

/** A titled border around one part of the flow; lit while work goes through it. */
function FrameNode({ data }: NodeProps<FlowNode>) {
  const live = useContext(LiveContext)
  if (data.kind !== 'frame') return null
  const on = !!live && data.members.some((m) => live.has(m))
  return (
    <div className={`frame${on ? ' on' : ''}`}>
      <span className="frame-title">{data.title}</span>
    </div>
  )
}

/** An orthogonal path through the given corners, rounded. */
function routed(points: [number, number][], r = 10): string {
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]
    const next = points[i + 1]
    if (!next) {
      d += ` L ${x} ${y}`
      break
    }
    const [px, py] = points[i - 1]
    const k = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(next[0] - x, next[1] - y) / 2)
    const ax = x - Math.sign(x - px) * k
    const ay = y - Math.sign(y - py) * k
    const bx = x + Math.sign(next[0] - x) * k
    const by = y + Math.sign(next[1] - y) * k
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`
  }
  return d
}

/**
 * Information flowing along an edge for as long as the work behind it lasts: comets running one after
 * another from source to target, at an even speed whatever the edge's length.
 */
function Comets({ d, length }: { d: string; length: number }) {
  const dur = Math.max(1.4, length / 150)
  const n = Math.max(2, Math.min(4, Math.round(length / 180)))
  return (
    <g className="flow" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <g key={i}>
          <ellipse rx={15} ry={3.2} cx={-10} className="comet" />
          <circle r={3.8} className="comet-head" />
          <animateMotion dur={`${dur}s`} begin={`${-(i * dur) / n}s`} repeatCount="indefinite" rotate="auto" path={d} />
        </g>
      ))}
    </g>
  )
}

function FlowEdgeView(props: EdgeProps<FlowEdge>) {
  const focus = useContext(FocusContext)
  const { data } = props
  const dim = !!focus && !(focus.has(props.source) && focus.has(props.target))
  const pts = data?.points
  const d = pts ? routed(pts) : getSmoothStepPath({ ...props, borderRadius: 12, offset: 18 })[0]
  const [x, y] = pts ? pts[pts.length - 1] : [props.targetX, props.targetY]
  const length = pts ? pts.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]), 0) : Math.abs(x - props.sourceX) + Math.abs(y - props.sourceY)
  // The arrowhead points the way the last stretch runs.
  const into = pts ? (pts[pts.length - 2][1] === y ? (pts[pts.length - 2][0] < x ? 'right' : 'left') : pts[pts.length - 2][1] < y ? 'down' : 'up') : props.targetPosition === Position.Top ? 'down' : props.targetPosition === Position.Bottom ? 'up' : 'right'
  const head =
    into === 'down'
      ? `M ${x - 4.5} ${y - 8} L ${x} ${y} L ${x + 4.5} ${y - 8} Z`
      : into === 'up'
        ? `M ${x - 4.5} ${y + 8} L ${x} ${y} L ${x + 4.5} ${y + 8} Z`
        : into === 'left'
          ? `M ${x + 8} ${y - 4.5} L ${x} ${y} L ${x + 8} ${y + 4.5} Z`
          : `M ${x - 8} ${y - 4.5} L ${x} ${y} L ${x - 8} ${y + 4.5} Z`
  return (
    <g className={`edge${data?.live ? ' live' : ''}${data?.tone ? ` ${data.tone}` : ''}${data?.setup ? ' from-setup' : ''}${dim ? ' dim' : ''}`}>
      <path d={d} className="edge-line" />
      <path d={head} className="edge-head" />
      {data?.live && <Comets d={d} length={length} />}
    </g>
  )
}

const nodeTypes = { prompt: PromptNode, command: CommandNode, agent: AgentNode, step: StepNode, result: OutputNode, files: FilesNode, frame: FrameNode, setup: SetupNode }
const edgeTypes = { flow: FlowEdgeView }
const FIT = { padding: 0.08, maxZoom: 1 }

/**
 * Nodes keep their object while their place is unchanged: React Flow hides a node it is handed anew
 * until it has measured it, which made the whole canvas blink on every update.
 */
function useStable(next: FlowNode[]): FlowNode[] {
  const prev = useRef(new Map<string, FlowNode>())
  return useMemo(() => {
    const out = next.map((n) => {
      const p = prev.current.get(n.id)
      return p && p.position.x === n.position.x && p.position.y === n.position.y && p.height === n.height && p.type === n.type ? p : n
    })
    prev.current = new Map(out.map((n) => [n.id, n]))
    return out
  }, [next])
}

interface Chip {
  label: string
  /** Where it comes from: "project agent", "built-in command"… */
  origin?: string
  kind: 'command' | 'main' | 'sub' | 'step' | 'state'
  live?: boolean
  to?: Selection
}

/**
 * The paths work is taking right now: what started it (/command → Claude), then one branch per thing at
 * work — a subagent and its tool, or a tool of Claude's own.
 */
function pathsOf(view: ReturnType<typeof useFlow>['view'], setup: ReturnType<typeof useFlow>['setup']): { head: Chip[]; branches: Chip[][] } | null {
  const turn = view.turn
  if (!turn) return null
  const working = view.status === 'working'
  const cmdDef = setup.byNode.get('command')?.[0]
  const head: Chip[] = [
    ...(turn.command ? [{ label: `/${turn.command.name}`, origin: cmdDef ? originOf(cmdDef) : undefined, kind: 'command' as const, to: { kind: 'prompt' } as Selection }] : []),
    { label: 'Claude', kind: 'main', live: working, to: { kind: 'agent', id: 'main' } },
  ]
  const background = view.subagents.some((a) => a.status === 'running')
  if (!working && !background) {
    const done = view.main.status === 'error' ? 'Stopped' : view.main.output ? 'Replied' : 'Idle'
    return { head, branches: [[{ label: done, kind: 'state', to: view.main.output ? { kind: 'output', of: 'main' } : undefined }]] }
  }
  const branches: Chip[][] = []
  for (const a of view.subagents.filter((x) => x.status === 'running')) {
    const def = setup.byNode.get(`agent:${a.id}`)?.find((i) => i.kind === 'agent')
    const step = [...a.steps].reverse().find((s) => s.status === 'running')
    branches.push([
      { label: a.type, origin: def ? originOf(def) : undefined, kind: 'sub', live: true, to: { kind: 'agent', id: a.id } },
      ...(step ? [{ label: `${step.tool} ${step.label}`.trim(), kind: 'step' as const, live: true, to: { kind: 'step', id: step.id } as Selection }] : []),
    ])
  }
  for (const step of view.main.steps.filter((s) => s.status === 'running' && s.tool !== 'Agent' && s.tool !== 'Task'))
    branches.push([{ label: `${step.tool} ${step.label}`.trim(), kind: 'step', live: true, to: { kind: 'step', id: step.id } }])
  if (!branches.length) branches.push([{ label: view.main.said ? 'Writing…' : 'Thinking…', kind: 'state', live: true }])
  // Claude replied, its background subagents still at work.
  if (!working) branches.push([{ label: view.main.output ? 'Replied' : 'Idle', kind: 'state', to: view.main.output ? { kind: 'output', of: 'main' } : undefined }])
  return { head, branches }
}

function Chips({ chips }: { chips: Chip[] }) {
  const { select } = useFlow()
  return (
    <>
      {chips.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="chain-arrow">→</span>}
          <button className={`chip ck-${c.kind}${c.live ? ' live' : ''}`} disabled={!c.to} onClick={() => c.to && select(c.to)} title={c.origin ? `${c.label} · ${c.origin}` : c.label}>
            <span className="chip-label">{c.label}</span>
            {c.origin && <em>{c.origin}</em>}
          </button>
        </Fragment>
      ))}
    </>
  )
}

function NowBar() {
  const { view, setup, select } = useFlow()
  const paths = pathsOf(view, setup)
  if (!paths) return null
  const working = view.status === 'working'
  const background = !working && view.subagents.some((a) => a.status === 'running')
  const wait = waitingText(view)
  const asked = pendingStep(view)
  // The call waiting for an answer is already the first chip: not again in its branch.
  const branches = wait && asked ? paths.branches.map((b) => b.filter((c) => !(c.to?.kind === 'step' && c.to.id === asked.step.id))).filter((b) => b.length) : paths.branches
  const shown = branches.slice(0, 4)
  return (
    <div className={`now${wait ? ' waiting' : working || background ? ' live' : ''}`}>
      <span className="now-label">{wait ? 'Needs you' : working ? 'Now' : background ? 'In background' : 'Last turn'}</span>
      <div className="chain">
        <Chips chips={paths.head} />
        <span className="chain-arrow">→</span>
      </div>
      <div className={`branches${shown.length > 1 ? ' many' : ''}`}>
        {wait && (
          <div className="chain ask">
            <button className="chip ck-ask" onClick={() => asked && select({ kind: 'step', id: asked.step.id })} title="Answer it in Claude Code">
              <span className="chip-label">{wait}</span>
              <em>answer in Claude Code</em>
            </button>
          </div>
        )}
        {shown.map((b, n) => (
          <div className="chain" key={n}>
            <Chips chips={b} />
          </div>
        ))}
        {branches.length > shown.length && <span className="chain-more">+{branches.length - shown.length} more at work</span>}
      </div>
    </div>
  )
}

export function Flow() {
  const { view, setup, select } = useFlow()
  const layout = useMemo(() => buildLayout(view, setup), [view, setup])
  const nodes = useStable(layout.nodes)
  const { fitView } = useReactFlow()

  // In focus: the path under the pointer, else the path work is taking now (a background subagent counts,
  // even after Claude has replied). Nothing at work: everything as it is.
  const [hover, setHover] = useState<string | null>(null)
  const live = useMemo(() => livePath(layout.edges), [layout])
  const focus = useMemo(() => (hover && layout.nodes.some((n) => n.id === hover) ? lineage(layout.edges, hover) : live), [hover, layout, live])
  // Nodes are dimmed by a stylesheet, so their objects (and React Flow's measurements) stay as they are.
  const focusCss = focus
    ? `.canvas .react-flow__node:not(.react-flow__node-frame){opacity:.72;filter:grayscale(.9)}${[...focus].map((id) => `.canvas .react-flow__node[data-id="${id.replace(/"/g, '')}"]`).join(',')}{opacity:1;filter:none}`
    : ''

  // Refit when the shape changes (a new turn, a subagent, more tools) or the tab is resized.
  const shape = nodes.map((n) => n.id).join('|')
  useEffect(() => {
    const t = setTimeout(() => void fitView({ ...FIT, duration: 250 }), 50)
    return () => clearTimeout(t)
  }, [shape, view.id, fitView])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    let t: ReturnType<typeof setTimeout>
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(() => void fitView(FIT), 60)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [fitView])

  return (
    <div className="flow-wrap">
      <NowBar />
      <FocusContext.Provider value={focus}>
        <LiveContext.Provider value={live}>
          <div className="canvas" ref={box}>
            <style>{focusCss}</style>
            <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
              <defs>
                <linearGradient id="comet-tail" x1="0" x2="1" y1="0" y2="0">
                  <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
                  <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0.9 }} />
                </linearGradient>
              </defs>
            </svg>
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={layout.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={FIT}
              minZoom={0.25}
              maxZoom={1.6}
              nodesConnectable={false}
              nodesDraggable={false}
              elementsSelectable={false}
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, n) => {
                const d = n.data
                if (d.kind === 'prompt' || d.kind === 'command') select({ kind: 'prompt' })
                else if (d.kind === 'agent') select({ kind: 'agent', id: d.agentId })
                else if (d.kind === 'step') select({ kind: 'step', id: d.stepId })
                else if (d.kind === 'result') select({ kind: 'output', of: d.of })
                else if (d.kind === 'files') select({ kind: 'files' })
                else if (d.kind === 'setup') select({ kind: 'setup', group: d.group })
              }}
              onPaneClick={() => select(null)}
              onNodeMouseEnter={(_, n) => n.type !== 'frame' && setHover(n.id)}
              onNodeMouseLeave={() => setHover(null)}
            />
          </div>
        </LiveContext.Provider>
      </FocusContext.Provider>
    </div>
  )
}
