import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Handle, Position, ReactFlow, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { agentOf, duration, ago, shortPath, stepOf, useFlow, type Selection } from '../context.ts'
import { buildLayout, filesHeight, SETUP_ROWS, type EdgeData, type NodeData } from '../layout.ts'
import { displayName, groupOf, keyOf, scopeLabel, sorted } from '../setup.ts'
import { send } from '../vscode.ts'

type FlowNode = Node<NodeData>
type FlowEdge = Edge<EdgeData>

const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' }
const In = () => <Handle type="target" position={Position.Left} id="left" style={hidden} />
const Out = () => <Handle type="source" position={Position.Right} id="right" style={hidden} />

const same = (a: Selection | null, b: Selection) => !!a && JSON.stringify(a) === JSON.stringify(b)

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
  const { view } = useFlow()
  const c = view.turn?.command
  if (!c) return null
  return (
    <div className={`hex${view.status === 'working' ? ' live' : ''}`} title={c.args ? `/${c.name} ${c.args}` : `/${c.name}`}>
      <In />
      <Out />
      <svg className="hex-shape" viewBox="0 0 210 58" preserveAspectRatio="none" aria-hidden>
        <polygon points="18,0.75 192,0.75 209.25,29 192,57.25 18,57.25 0.75,29" />
      </svg>
      <div className="hex-body">
        <span className="hex-name">/{c.name}</span>
        <span className="hex-desc">slash command</span>
      </div>
    </div>
  )
}

function AgentNode({ data }: NodeProps<FlowNode>) {
  const { view, now, selected } = useFlow()
  if (data.kind !== 'agent') return null
  const a = agentOf(view, data.agentId)
  if (!a) return null
  const main = a.kind === 'main'
  const running = a.status === 'running' && (!main || view.status === 'working')
  const step = [...a.steps].reverse().find((s) => s.status === 'running')
  const doing = main && !view.turn ? 'Waiting for a prompt' : running ? (step ? `${step.tool} ${step.label}` : main ? (a.said ? 'Writing…' : 'Thinking…') : 'Starting…') : a.status === 'error' ? (main ? 'Stopped' : 'Failed') : 'Done'
  const elapsed = (a.end ?? (running ? now : a.start)) - a.start
  return (
    <div className={`node agent ${main ? 'main' : 'sub'} st-${running ? 'running' : a.status}${same(selected, { kind: 'agent', id: a.id }) ? ' selected' : ''}`}>
      <In />
      <Out />
      <div className="node-head">
        <span className="avatar">{main ? 'C' : a.type === 'Explore' ? '⌕' : a.type === 'Plan' ? '◇' : '✦'}</span>
        <span className="agent-name">{main ? 'Claude' : a.type}</span>
        {!main && a.background && <span className="tag">background</span>}
        <span className="dot" />
      </div>
      {main && a.model && <div className="agent-model">{a.model.replace(/^claude-/, '')}</div>}
      {!main && <div className="agent-title">{a.title}</div>}
      <div className={`agent-doing${running ? ' live' : ''}`}>{doing}</div>
      <div className="agent-meta">
        {a.steps.length} tool{a.steps.length === 1 ? '' : 's'} · {duration(elapsed)}
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
    <div className={`node step st-${s.status}${same(selected, { kind: 'step', id: s.id }) ? ' selected' : ''}`} title={`${s.tool} ${s.label}`}>
      <In />
      <span className="glyph">{glyph(s.tool)}</span>
      <span className="step-tool">{s.tool}</span>
      <span className="step-label">{s.label}</span>
      <span className="step-time">{s.status === 'running' ? duration(now - s.start) : s.end ? duration(s.end - s.start) : ''}</span>
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
function SetupNode({ data }: NodeProps<FlowNode>) {
  const { setup, selected, select } = useFlow()
  if (data.kind !== 'setup') return null
  const g = groupOf(data.group)
  const items = sorted(setup, data.group)
  const usedBy = (key: string) => setup.uses.get(key)
  const live = items.some((i) => usedBy(keyOf(i))?.some((u) => u.live))
  const used = items.filter((i) => usedBy(keyOf(i))?.length).length
  return (
    <div className={`node setup${live ? ' live' : used ? ' used' : ''}${selected?.kind === 'setup' && selected.group === data.group ? ' selected' : ''}`}>
      <Out />
      <div className="node-head">
        <span className="setup-glyph">{g.glyph}</span>
        <span className="setup-title">{g.title}</span>
        <span className="count">{items.length}</span>
        {used > 0 && data.group !== 'memory' && <span className="in-use">{used} in use</span>}
      </div>
      <ul>
        {items.length === 0 && <li className="hint">{g.hint}</li>}
        {items.slice(0, SETUP_ROWS).map((i) => {
          const u = usedBy(keyOf(i))
          const state = u?.some((x) => x.live) ? ' live' : u?.length ? ' used' : ''
          return (
            <li
              key={keyOf(i)}
              className={`setup-row${state}${i.scope === 'builtin' || i.scope === 'connector' ? ' soft' : ''}${selected?.kind === 'setup' && selected.item === keyOf(i) ? ' picked' : ''}`}
            >
              <button
                title={[displayName(i), i.description].filter(Boolean).join('\n')}
                onClick={(e) => {
                  e.stopPropagation()
                  select({ kind: 'setup', group: data.group, item: keyOf(i) })
                }}
              >
                <i />
                <span className="setup-name">{displayName(i)}</span>
                <span className={`scope sc-${i.scope}`}>{scopeLabel(i)}</span>
              </button>
            </li>
          )
        })}
        {items.length > SETUP_ROWS && <li className="more">+{items.length - SETUP_ROWS} more</li>}
      </ul>
    </div>
  )
}

function LabelNode({ data }: NodeProps<FlowNode>) {
  if (data.kind !== 'label') return null
  return <div className="section-label">{data.text}</div>
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
  const [d] = getSmoothStepPath({ ...props, borderRadius: 12, offset: 18 })
  const { sourceX: sx, sourceY: sy, targetX: x, targetY: y, data } = props
  const length = Math.abs(x - sx) + Math.abs(y - sy)
  return (
    <g className={`edge${data?.live ? ' live' : ''}${data?.tone ? ` ${data.tone}` : ''}${data?.setup ? ' from-setup' : ''}`}>
      <path d={d} className="edge-line" />
      {/* Every edge enters its target from the left, so the arrowhead points right. */}
      <path d={`M ${x - 8} ${y - 4.5} L ${x} ${y} L ${x - 8} ${y + 4.5} Z`} className="edge-head" />
      {data?.live && <Comets d={d} length={length} />}
    </g>
  )
}

const nodeTypes = { prompt: PromptNode, command: CommandNode, agent: AgentNode, step: StepNode, result: OutputNode, files: FilesNode, label: LabelNode, setup: SetupNode }
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

export function Flow() {
  const { view, setup, select } = useFlow()
  const layout = useMemo(() => buildLayout(view, setup), [view, setup])
  const nodes = useStable(layout.nodes)
  const { fitView } = useReactFlow()

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
    <div className="canvas" ref={box}>
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
      />
    </div>
  )
}
