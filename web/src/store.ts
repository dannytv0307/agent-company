import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDef, AgentEvent, AgentRef, ManualTask, OrgDef, Plan, ProjectRef, Proposal, RuntimeStatus } from '../../shared/types.ts'
import { get } from './api.ts'
import { buildLayout, findPath, REPO_DIVISION, type Layout } from './layout.ts'

export type Status = 'idle' | 'working' | 'done' | 'waiting' | 'error' | 'offline'

/** One hand-off an agent is working on right now. An agent can hold several at once. */
export interface ActiveWork {
  aid: string
  projectId?: string
  runId?: string
  title: string
  text: string
  ts: number
}

export interface AgentState {
  status: Status
  bubble?: string
  lastTs: number
  reports: number
  /** Project of the agent's latest work. */
  projectId?: string
  active: ActiveWork[]
}

export interface Pulse {
  id: string
  edgeId: string
  forward: boolean
  delay: number
  dur: number
  color: string
}

const STEP_MS = 650
const STALE_MS = 10 * 60_000
const PULSE_COLORS: Partial<Record<AgentEvent['kind'], string>> = {
  task: 'var(--warn)',
  dispatch: 'var(--accent)',
  report: 'var(--ok)',
  manual: 'var(--warn)',
  error: 'var(--bad)',
}

// The selected project is per browser: two windows can look at different projects.
function loadSelected(): string {
  try {
    return localStorage.getItem('project') ?? ''
  } catch {
    return ''
  }
}
function saveSelected(id: string) {
  try {
    localStorage.setItem('project', id)
  } catch {
    // storage unavailable — keep in memory only
  }
}

const aidOf = (e: AgentEvent) => (typeof e.meta?.aid === 'string' ? e.meta.aid : undefined)

export function deriveStates(events: AgentEvent[], agents: AgentRef[], manual: ManualTask[], runtimes: RuntimeStatus[], now: number) {
  const st: Record<string, AgentState> = {}
  const runOf: Record<string, string | undefined> = {}
  const work: Record<string, Map<string, ActiveWork>> = {}
  for (const a of agents) {
    st[a.id] = { status: 'idle', lastTs: 0, reports: 0, active: [] }
    work[a.id] = new Map()
  }
  let current: AgentEvent
  const set = (id: string | undefined, status: Status, bubble: string | undefined, ts: number) => {
    if (!id || !st[id]) return
    st[id].status = status
    st[id].bubble = bubble
    st[id].lastTs = ts
    st[id].projectId = current.projectId
    runOf[id] = current.runId
  }
  const open = (agent: string | undefined, e: AgentEvent, title: string, text: string) => {
    const aid = aidOf(e)
    if (!agent || !aid || !work[agent]) return
    const prev = work[agent].get(aid)
    work[agent].set(aid, { aid, projectId: e.projectId ?? prev?.projectId, runId: e.runId ?? prev?.runId, title: prev?.title || title, text, ts: e.ts })
  }
  const close = (agent: string | undefined, e: AgentEvent) => {
    const aid = aidOf(e)
    if (agent && aid) work[agent]?.delete(aid)
  }

  for (const e of events) {
    current = e
    switch (e.kind) {
      case 'task':
      case 'dispatch':
        set(e.to, 'working', `📥 ${e.text}`, e.ts)
        open(e.to, e, e.text, `📥 ${e.text}`)
        if (e.kind === 'dispatch' && st[e.from ?? '']?.status === 'working') st[e.from!].bubble = `📤 ${e.text}`
        break
      case 'activity':
        set(e.agent, 'working', e.text, e.ts)
        open(e.agent, e, '', e.text)
        break
      case 'report':
        if (e.from && st[e.from]) st[e.from].reports++
        set(e.from, 'done', `✅ ${e.text}`, e.ts)
        close(e.from, e)
        break
      case 'error':
        set(e.agent, 'error', `⚠️ ${e.text}`, e.ts)
        close(e.agent, e)
        break
      case 'system':
        if (e.meta?.end) {
          const ended = (e.meta.runIds as string[] | undefined) ?? (e.runId ? [e.runId] : null)
          for (const [id, s] of Object.entries(st)) if (s.status === 'working' && (!ended || ended.includes(runOf[id] ?? ''))) s.status = 'idle'
          for (const m of Object.values(work)) for (const [aid, w] of m) if (!ended || ended.includes(w.runId ?? '')) m.delete(aid)
        }
        if (typeof e.meta?.chatEnd === 'string') {
          if (st[e.meta.chatEnd]?.status === 'working') st[e.meta.chatEnd].status = 'idle'
          close(e.meta.chatEnd, e)
        }
        break
    }
  }
  for (const [id, s] of Object.entries(st)) {
    s.active = [...work[id].values()].filter((w) => now - w.ts < STALE_MS).sort((a, b) => b.ts - a.ts)
    const age = now - s.lastTs
    if (s.active.length) {
      // Several parallel assignments: the card shows the most recent one and a count.
      s.status = 'working'
      s.bubble = s.active[0].text
    } else if (s.status === 'working' && age > 90_000) {
      s.status = 'idle'
    }
    if (s.status === 'done' && age > 60_000) s.status = 'idle'
    if (s.status === 'error' && age > 5 * 60_000) s.status = 'idle'
    if (s.status === 'idle') s.bubble = undefined
  }
  for (const m of manual) {
    if (!m.done && st[m.to]) {
      st[m.to].status = 'waiting'
      st[m.to].bubble = `🕒 ${m.task.slice(0, 60)}`
    }
  }
  for (const a of agents) {
    const rt = runtimes.find((r) => r.runtime === a.runtime)
    if (rt && !rt.installed && st[a.id].status === 'idle') st[a.id].status = 'offline'
  }
  return st
}

/** The org as drawn: the selected project's own repo agents get a frame of their own. */
function chartOrg(org: OrgDef, project: ProjectRef | undefined, repo: AgentRef[]): OrgDef {
  if (!project || project.mode === 'company' || !repo.length) return org
  const [main, ...rest] = org.divisions
  // In "repo team" mode the company keeps only its core roles (HR) on this project.
  const mainView = project.mode === 'project' ? { ...main, departments: main.departments.filter((d) => d.members.some((m) => m.core)) } : main
  const frame: OrgDef['divisions'][number] = {
    id: REPO_DIVISION,
    runtime: 'claude',
    label: { en: `${project.name} · own agents`, ja: `${project.name}・専用エージェント` },
    color: '#94a3b8',
    departments: [{ id: 'team', name: { en: `From the repo · ${repo.length}`, ja: `リポジトリ由来・${repo.length}` }, icon: '', members: repo as AgentDef[] }],
  }
  return { ...org, divisions: [mainView, ...rest, frame] }
}

export function useCompany() {
  const [org, setOrg] = useState<OrgDef | null>(null)
  const [companyAgents, setCompanyAgents] = useState<AgentRef[]>([])
  const [projectAgents, setProjectAgents] = useState<Record<string, AgentRef[]>>({})
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [activeProject, setActiveProjectId] = useState(loadSelected)
  const [runs, setRuns] = useState<{ projectId: string; runId: string }[]>([])
  const [demo, setDemo] = useState(false)
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [manual, setManual] = useState<ManualTask[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [now, setNow] = useState(Date.now())
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const project = projects.find((p) => p.id === activeProject) ?? projects[0]
  const repoTeam = useMemo(() => (project ? (projectAgents[project.id] ?? []) : []), [project, projectAgents])
  // Every agent the app may see events from: the company plus every project's repo agents.
  const agents = useMemo(() => {
    const seen = new Set<string>()
    return [...companyAgents, ...Object.values(projectAgents).flat()].filter((a) => !seen.has(a.id) && seen.add(a.id))
  }, [companyAgents, projectAgents])
  const view = useMemo(() => (org ? chartOrg(org, project, repoTeam) : null), [org, project, repoTeam])

  const layout: Layout | null = useMemo(() => (view ? buildLayout(view) : null), [view])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const refreshManual = useCallback(() => get<ManualTask[]>('/api/manual').then(setManual).catch(() => {}), [])
  const refreshProposals = useCallback(() => get<Proposal[]>('/api/proposals').then(setProposals).catch(() => {}), [])
  const refreshState = useCallback(
    () =>
      get<{ runs: { projectId: string; runId: string }[]; demo: boolean }>('/api/state')
        .then((s) => {
          setRuns(s.runs)
          setDemo(s.demo)
        })
        .catch(() => {}),
    [],
  )
  const refreshOrg = useCallback(async () => {
    try {
      const o = await get<{ org: OrgDef; agents: AgentRef[]; projects: ProjectRef[]; projectAgents: Record<string, AgentRef[]>; activeProject: string }>('/api/org')
      setOrg(o.org)
      setCompanyAgents(o.agents)
      setProjectAgents(o.projectAgents ?? {})
      setProjects(o.projects)
      // Keep this browser's choice while it still exists; otherwise fall back to the server default.
      setActiveProjectId((prev) => (prev && o.projects.some((p) => p.id === prev) ? prev : o.activeProject))
      setError(null)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }, [])

  const projectIdRef = useRef<string | undefined>(undefined)
  projectIdRef.current = project?.id
  const refreshPlan = useCallback(() => {
    const id = projectIdRef.current
    if (!id) return
    get<{ plan: Plan }>(`/api/plans/${encodeURIComponent(id)}`)
      .then((r) => projectIdRef.current === id && setPlan(r.plan))
      .catch(() => {})
  }, [])
  useEffect(() => {
    setPlan(null)
    refreshPlan()
  }, [project?.id, refreshPlan])

  const animate = useCallback((e: AgentEvent) => {
    const lay = layoutRef.current
    const color = PULSE_COLORS[e.kind]
    if (!lay || !color || !e.from || !e.to) return
    const path = findPath(lay, e.from, e.to)
    if (!path?.length) return
    const batch = path.map((p, i) => ({ id: `${e.id}:${i}`, edgeId: p.edgeId, forward: p.forward, delay: i * STEP_MS, dur: STEP_MS, color }))
    setPulses((ps) => [...ps, ...batch])
    const ids = new Set(batch.map((b) => b.id))
    setTimeout(() => setPulses((ps) => ps.filter((p) => !ids.has(p.id))), batch.length * STEP_MS + 1600)
  }, [])

  useEffect(() => {
    void refreshOrg()
    get<RuntimeStatus[]>('/api/runtimes').then(setRuntimes).catch(() => {})
    void refreshManual()
    void refreshProposals()
    void refreshState()
    let es: EventSource | null = null
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let lastSeen = Date.now()
    const loadHistory = () =>
      get<AgentEvent[]>('/api/events?limit=1500')
        .then((hist) => setEvents(hist))
        .catch(() => {})
    // EventSource gives up for good when the server answers with an error (e.g. while it restarts
    // behind the dev proxy), so reconnect ourselves and catch up on anything missed.
    const connect = (catchUp: boolean) => {
      if (cancelled) return
      es = new EventSource('/api/stream')
      lastSeen = Date.now()
      es.addEventListener('ping', () => (lastSeen = Date.now()))
      es.onopen = () => {
        lastSeen = Date.now()
        setConnected(true)
        if (catchUp) {
          void loadHistory()
          void refreshOrg()
          void refreshState()
          void refreshProposals()
          refreshPlan()
        }
      }
      es.onerror = () => {
        setConnected(false)
        if (es?.readyState === EventSource.CLOSED) {
          es.close()
          retry = setTimeout(() => connect(true), 2000)
        }
      }
      es.addEventListener('agent', (msg) => {
          lastSeen = Date.now()
          const e = JSON.parse((msg as MessageEvent).data) as AgentEvent
          setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev.slice(-2999), e]))
          setNow(Date.now())
          animate(e)
          if (e.kind === 'manual' || e.meta?.manualId) void refreshManual()
          if (e.kind === 'task' || e.kind === 'system') void refreshState()
          if (e.meta?.proposalId) void refreshProposals()
          if (e.meta?.orgChanged) void refreshOrg()
          if (e.meta?.planChanged && e.meta.planChanged === projectIdRef.current) refreshPlan()
      })
    }
    void loadHistory().finally(() => connect(false))
    const tick = setInterval(() => {
      setNow(Date.now())
      // A proxy can keep a dead stream "open" after the server restarts; the server pings every
      // 10s, so silence means the connection is gone.
      if (es && Date.now() - lastSeen > 25_000) {
        es.close()
        setConnected(false)
        clearTimeout(retry)
        connect(true)
      }
    }, 5000)
    return () => {
      cancelled = true
      clearTimeout(retry)
      es?.close()
      clearInterval(tick)
    }
  }, [animate, refreshManual, refreshOrg, refreshPlan, refreshProposals, refreshState])

  const states = useMemo(() => deriveStates(events, agents, manual, runtimes, now), [events, agents, manual, runtimes, now])

  const pending = useMemo(() => proposals.filter((p) => p.status === 'pending'), [proposals])
  // "running" means the selected project is busy; other projects may run at the same time.
  const running = demo || runs.some((r) => r.projectId === project?.id)
  const busyProjects = useMemo(() => new Set(runs.map((r) => r.projectId)), [runs])
  // People who belong to the selected project: the CEO, plan assignees, anyone with events there, the repo team.
  const involved = useMemo(() => {
    const ids = new Set<string>()
    if (!project) return ids
    const ceo = org?.divisions.find((d) => d.runtime === 'claude')?.ceo?.id
    if (ceo) ids.add(ceo)
    for (const x of plan?.tasks ?? []) if (x.assignee) ids.add(x.assignee)
    for (const e of events) if (e.projectId === project.id) for (const id of [e.agent, e.from, e.to]) if (id) ids.add(id)
    if (project.mode !== 'company') for (const a of repoTeam) ids.add(a.id)
    return ids
  }, [project, org, plan, events, repoTeam])

  const progress = useMemo(() => {
    const total = plan?.tasks.length ?? 0
    const done = plan?.tasks.filter((t) => t.status === 'done').length ?? 0
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
  }, [plan])

  const selectProject = useCallback(async (id: string) => {
    setActiveProjectId(id)
    saveSelected(id)
  }, [])

  return {
    org, view, agents, runtimes, events, manual, proposals, pending, running, pulses, states, layout, connected, error, now,
    projects, project, repoTeam, busyProjects, selectProject, plan, progress, involved,
    refreshManual, refreshState, refreshOrg, refreshProposals, refreshPlan,
  }
}

export type Company = ReturnType<typeof useCompany>
