import { useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import { Handle, Position, ReactFlow, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'
import { REPO_DIVISION, type EdgeData, type NodeData } from '../layout.ts'
import type { Pulse } from '../store.ts'

type FlowNode = Node<NodeData>
type FlowEdge = Edge<EdgeData & { pulses?: Pulse[] }>

const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' }

export const monogram = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '·'

function AgentNode({ id }: NodeProps<FlowNode>) {
  const { company, selected, focus } = useCompanyCtx()
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
      className={`card st-${s.status}${a.isCeo ? ' ceo' : ''}${a.external ? ' external' : ''}${selected === id ? ' selected' : ''}${faded ? ' faded' : ''}`}
      style={{ '--c': a.color } as CSSProperties}
      title={tip}
    >
      <Handle type="target" position={Position.Top} id="top" style={hidden} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={hidden} />
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <Handle type="source" position={Position.Left} id="left-src" style={hidden} />
      <Handle type="source" position={Position.Right} id="right" style={hidden} />
      <span className="mono">{monogram(l(a.name))}</span>
      <div className="who">
        <div className="name">
          {l(a.name)}
          {a.isCeo && a.runtime === 'codex' && company.view?.divisions.find((d) => d.id === a.divisionId)?.runtime !== 'codex' && (
            <span className="engine-tag">Codex</span>
          )}
        </div>
        <div className={`sub${live ? ' live' : ''}`}>{live ? s.bubble!.replace(/^[^\p{L}\p{N}$]+/u, '') : l(a.role)}</div>
      </div>
      {many ? <span className="count-badge">×{s.active.length}</span> : <span className="dot" title={t(s.status)} />}
    </div>
  )
}

function OwnerNode({ id }: NodeProps<FlowNode>) {
  const { company, selected } = useCompanyCtx()
  const { t, l } = useT()
  const owner = company.org?.owner
  if (!owner) return null
  return (
    <div className={`card owner${selected === id ? ' selected' : ''}`}>
      <Handle type="source" position={Position.Bottom} id="bottom" style={hidden} />
      <span className="mono">{monogram(l(owner.name))}</span>
      <div className="who">
        <div className="name">{l(owner.name)}</div>
        <div className="sub">{t('owner')}</div>
      </div>
    </div>
  )
}

function DeptNode({ data }: NodeProps<FlowNode>) {
  const { company } = useCompanyCtx()
  const { l } = useT()
  if (data.kind !== 'dept') return null
  const dep = company.view?.divisions.find((d) => d.id === data.divisionId)?.departments.find((d) => d.id === data.deptId)
  if (!dep) return null
  const busy = dep.members.some((m) => company.states[m.id]?.status === 'working')
  return (
    <div className={`dept${data.compact ? ' compact' : ''}${busy ? ' busy' : ''}${data.divisionId === REPO_DIVISION ? ' repo' : ''}`}>
      <Handle type="target" position={Position.Top} id="top" style={hidden} />
      <Handle type="target" position={Position.Left} id="left" style={hidden} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ ...hidden, left: 11 }} />
      <span className="dept-label" title={l(dep.name)}>
        {l(dep.name)}
      </span>
    </div>
  )
}

function DivisionNode({ data }: NodeProps<FlowNode>) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  if (data.kind !== 'division') return null
  const div = company.view?.divisions.find((d) => d.id === data.divisionId)
  if (!div) return null
  const rt = company.runtimes.find((r) => r.runtime === div.runtime)
  const note =
    div.id === REPO_DIVISION ? '' : !rt ? '' : !rt.installed ? t('offline') : div.mode === 'manual' ? 'manual' : (rt.version?.match(/\d+\.\d+\.\d+/)?.[0] ?? '')
  return (
    <div className={`division${div.id === REPO_DIVISION ? ' repo' : ''}`} style={{ width: data.width, height: data.height }}>
      <div className="division-head">
        <span className="title">{l(div.label)}</span>
        <span className={`note${rt && !rt.installed ? ' bad' : ''}`} title={rt?.note ?? rt?.path}>
          {note}
        </span>
      </div>
    </div>
  )
}

function PulseDot({ pathRef, p }: { pathRef: RefObject<SVGPathElement | null>; p: Pulse }) {
  const dot = useRef<SVGCircleElement>(null)
  useEffect(() => {
    const path = pathRef.current
    const c = dot.current
    if (!path || !c) return
    const len = path.getTotalLength()
    const start = performance.now() + p.delay
    let raf = 0
    const tick = (now: number) => {
      const k = (now - start) / p.dur
      if (k < 0 || k > 1) {
        c.style.opacity = '0'
        if (k > 1) return
      } else {
        const pt = path.getPointAtLength(len * (p.forward ? k : 1 - k))
        c.setAttribute('cx', String(pt.x))
        c.setAttribute('cy', String(pt.y))
        c.style.opacity = '1'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pathRef, p])
  return <circle ref={dot} r={3} style={{ fill: p.color, opacity: 0 }} />
}

/** Left out of the source, down a gutter at x = g, then right into the target — with rounded corners. */
function gutterPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty }: EdgeProps<FlowEdge>, g: number) {
  const r = Math.max(0, Math.min(14, (sx - g) / 2, Math.abs(ty - sy) / 2, (tx - g) / 2))
  const down = ty > sy ? 1 : -1
  return `M ${sx} ${sy} H ${g + r} Q ${g} ${sy} ${g} ${sy + r * down} V ${ty - r * down} Q ${g} ${ty} ${g + r} ${ty} H ${tx}`
}

function PulseEdge(props: EdgeProps<FlowEdge>) {
  const ref = useRef<SVGPathElement>(null)
  const g = props.data?.gutter
  const [d] = g === undefined ? getSmoothStepPath({ ...props, borderRadius: 14, offset: 16, centerX: props.data?.centerX }) : [gutterPath(props, g)]
  const pulses = props.data?.pulses ?? []
  const active = pulses.length > 0
  return (
    <>
      <path
        d={d}
        className={`edge ${props.data?.variant ?? 'tree'}${active ? ' active' : ''}`}
        style={active ? ({ '--pc': pulses[pulses.length - 1].color } as CSSProperties) : undefined}
      />
      <path ref={ref} d={d} fill="none" stroke="none" />
      {pulses.map((p) => (
        <PulseDot key={p.id} pathRef={ref} p={p} />
      ))}
    </>
  )
}

// Never blow a small company up past 100%.
const FIT = { padding: 0.04, maxZoom: 1 }

const nodeTypes = { agent: AgentNode, owner: OwnerNode, dept: DeptNode, division: DivisionNode }
const edgeTypes = { pulse: PulseEdge }

export function OrgChart() {
  const { company, select } = useCompanyCtx()
  const { layout, pulses } = company
  const { fitView } = useReactFlow()

  // Keep the whole company in view when the window is resized.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(t)
      t = setTimeout(() => void fitView({ ...FIT, duration: 200 }), 120)
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [fitView])

  // Refit whenever the layout itself changes (org.yaml edited, first load).
  useEffect(() => {
    if (!layout) return
    const t = setTimeout(() => void fitView(FIT), 60)
    return () => clearTimeout(t)
  }, [layout, fitView])

  const edges = useMemo<FlowEdge[]>(() => {
    if (!layout) return []
    const by = new Map<string, Pulse[]>()
    for (const p of pulses) by.set(p.edgeId, [...(by.get(p.edgeId) ?? []), p])
    return layout.edges.map((e) => ({ ...e, data: { ...e.data!, pulses: by.get(e.id) } }))
  }, [layout, pulses])

  if (!layout) return <div className="loading">…</div>

  return (
    <>
    <FocusToggle />
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
      onNodeClick={(_, n) => (n.data.kind === 'agent' || n.data.kind === 'owner' ? select(n.id) : undefined)}
      onPaneClick={() => select(null)}
    />
    </>
  )
}

/** "Everyone / Only <project>" — fade people who are not part of the selected project. */
function FocusToggle() {
  const { company, focus, setFocus } = useCompanyCtx()
  const { t } = useT()
  if (!company.project || company.projects.length < 2) return null
  return (
    <div className="focus-toggle seg2" role="group">
      <button className={!focus ? 'on' : ''} onClick={() => setFocus(false)}>
        {t('everyone')}
      </button>
      <button className={focus ? 'on' : ''} onClick={() => setFocus(true)}>
        {company.project.name}
      </button>
    </div>
  )
}
