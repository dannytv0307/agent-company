import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentRef, Checkpoint, ManualTask, OrgDef, Plan, ProjectChanges, ProjectRef, Proposal, RuntimeStatus, WorkItem } from '../../shared/types.ts'
import { get } from './api.ts'
import { buildLayout, outNode, spawnedNode, type Layout } from './layout.ts'

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

/** A helper Claude Code spawned for itself (general-purpose, Explore, Plan…), not one of the team. */
export interface Spawned {
  /** The Agent call's id; its events carry it as their assignment id. */
  aid: string
  runId?: string
  type: string
  title: string
  by?: string
  startedAt: number
  status: 'running' | 'done' | 'error' | 'stopped'
  /** What it is doing now. */
  activity?: string
  output?: string
  endedAt?: number
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
/** How long a spawned helper stays on the canvas after it finished, its output showing. */
const SPAWNED_LINGER_MS = 45_000
const STALE_MS = 10 * 60_000

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
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [work, setWork] = useState<WorkItem[]>([])
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
  // Each team agent's latest delivery in the selected project, shown to the right of the agent.
  const outputs = useMemo(() => {
    const out = new Map<string, AgentEvent>()
    if (!project) return out
    const team = new Set(repoTeam.map((a) => a.id))
    for (const e of events) if (e.kind === 'report' && e.from && team.has(e.from) && e.projectId === project.id) out.set(e.from, e)
    return out
  }, [events, project?.id, repoTeam])
  const delivered = [...outputs.keys()].sort().join(',')

  // Helpers spawned in the selected project: shown while they run, then with their output for a
  // little while, then gone.
  const spawned = useMemo(() => {
    const all = new Map<string, Spawned>()
    if (!project) return all
    for (const e of events) {
      const aid = typeof e.meta?.aid === 'string' ? e.meta.aid : undefined
      if (e.kind === 'dispatch' && typeof e.meta?.subagentType === 'string' && aid && e.projectId === project.id) {
        all.set(aid, { aid, runId: e.runId, type: e.meta.subagentType, title: e.text, by: e.from, startedAt: e.ts, status: 'running' })
        continue
      }
      const s = aid ? all.get(aid) : undefined
      if (s && s.status === 'running') {
        if (e.kind === 'activity') s.activity = e.text
        else if (e.kind === 'report' || e.kind === 'error') {
          s.status = e.kind === 'report' ? 'done' : 'error'
          s.output = typeof e.meta?.full === 'string' ? e.meta.full : e.text
          s.endedAt = e.ts
        }
      }
      if (e.kind === 'system' && e.meta?.end) {
        const ended = (e.meta.runIds as string[] | undefined) ?? (e.runId ? [e.runId] : null)
        for (const x of all.values()) if (x.status === 'running' && (!ended || ended.includes(x.runId ?? ''))) Object.assign(x, { status: 'stopped', endedAt: e.ts })
      }
    }
    for (const [aid, s] of all) {
      const gone = s.endedAt ? now - s.endedAt > SPAWNED_LINGER_MS : now - s.startedAt > STALE_MS
      if (gone) all.delete(aid)
    }
    return all
  }, [events, project?.id, now])
  const spawnedIds = [...spawned.keys()].join(',')
  const finished = [...spawned.values()].filter((s) => s.output).map((s) => s.aid).join(',')

  const layout: Layout | null = useMemo(
    () =>
      project
        ? buildLayout(project.name, project.scan?.commands ?? [], repoTeam, delivered ? delivered.split(',') : [], spawnedIds ? spawnedIds.split(',') : [], finished ? finished.split(',') : [])
        : null,
    [project, repoTeam, delivered, spawnedIds, finished],
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const refreshManual = useCallback(() => get<ManualTask[]>('/api/manual').then(setManual).catch(() => {}), [])
  const refreshProposals = useCallback(() => get<Proposal[]>('/api/proposals').then(setProposals).catch(() => {}), [])
  const refreshCheckpoints = useCallback(() => get<Checkpoint[]>('/api/checkpoints').then(setCheckpoints).catch(() => {}), [])
  const refreshWork = useCallback(() => get<WorkItem[]>('/api/work').then(setWork).catch(() => {}), [])
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

  // The selected project's git state: branch, uncommitted files, latest commit. Refreshed every 30 s,
  // and a few seconds after an agent writes a file or reports (a burst of edits asks once).
  const [git, setGit] = useState<ProjectChanges | null>(null)
  const gitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshGit = useCallback(() => {
    const id = projectIdRef.current
    if (!id) return
    get<ProjectChanges>(`/api/projects/${encodeURIComponent(id)}/changes`)
      .then((r) => projectIdRef.current === id && setGit(r))
      .catch(() => {})
  }, [])
  const refreshGitSoon = useCallback(() => {
    clearTimeout(gitTimer.current)
    gitTimer.current = setTimeout(refreshGit, 3000)
  }, [refreshGit])
  useEffect(() => {
    setGit(null)
    refreshGit()
    const t = setInterval(refreshGit, 30_000)
    return () => clearInterval(t)
  }, [project?.id, refreshGit])

  /** Run a dot along these edges, one group after another (a group's edges at the same time). */
  const pulseRoute = useCallback((steps: string[][], color: string) => {
    const stamp = `${Date.now()}-${Math.random()}`
    const batch = steps.flatMap((group, i) => group.map((edgeId) => ({ id: `${stamp}:${edgeId}`, edgeId, forward: true, delay: i * STEP_MS, dur: STEP_MS, color })))
    if (!batch.length) return
    setPulses((ps) => [...ps, ...batch])
    const ids = new Set(batch.map((b) => b.id))
    setTimeout(() => setPulses((ps) => ps.filter((p) => !ids.has(p.id))), steps.length * STEP_MS + 1600)
  }, [])

  // Hand-offs to an agent run in from the organizer's lane; deliveries run out to the agent's output.
  const animate = useCallback(
    (e: AgentEvent) => {
      const has = (id: string) => !!layoutRef.current?.edges.some((x) => x.id === id)
      if ((e.kind === 'task' || e.kind === 'dispatch') && e.to && has(`entry->${e.to}`)) pulseRoute([[`entry->${e.to}`]], 'var(--accent)')
      // A spawned helper's card (and its output) appear with the event itself: run the dot once laid out.
      const aid = typeof e.meta?.aid === 'string' ? e.meta.aid : ''
      if (e.kind === 'dispatch' && e.meta?.subagentType) setTimeout(() => pulseRoute([[`entry->${spawnedNode(aid)}`]], 'var(--accent)'), 120)
      if (e.kind === 'report' && aid && layoutRef.current?.nodes.some((n) => n.id === spawnedNode(aid)))
        setTimeout(() => pulseRoute([[`${spawnedNode(aid)}->${outNode(spawnedNode(aid))}`]], 'var(--ok)'), 120)
      // The output node appears with this very event, so its edge may not be laid out yet.
      if (e.kind === 'report' && e.from && layoutRef.current?.nodes.some((n) => n.id === e.from)) setTimeout(() => pulseRoute([[`${e.from}->out:${e.from}`]], 'var(--ok)'), 120)
    },
    [pulseRoute],
  )

  useEffect(() => {
    void refreshOrg()
    get<RuntimeStatus[]>('/api/runtimes').then(setRuntimes).catch(() => {})
    void refreshManual()
    void refreshProposals()
    void refreshCheckpoints()
    void refreshWork()
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
          void refreshCheckpoints()
          void refreshWork()
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
          if ((e.meta?.file || e.kind === 'report') && e.projectId === projectIdRef.current) refreshGitSoon()
          if (e.kind === 'manual' || e.meta?.manualId) void refreshManual()
          if (e.kind === 'task' || e.kind === 'system') void refreshState()
          if (e.meta?.proposalId) void refreshProposals()
          if (e.meta?.checkpointId) void refreshCheckpoints()
          if (e.meta?.work || e.meta?.end) void refreshWork()
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
  }, [animate, refreshGitSoon, refreshCheckpoints, refreshManual, refreshOrg, refreshPlan, refreshProposals, refreshState, refreshWork])

  const states = useMemo(() => deriveStates(events, agents, manual, runtimes, now), [events, agents, manual, runtimes, now])

  const pending = useMemo(() => proposals.filter((p) => p.status === 'pending'), [proposals])
  const openCheckIns = useMemo(() => checkpoints.filter((c) => c.status === 'open'), [checkpoints])
  // Everything waiting on the owner: team changes and check-ins.
  const attention = pending.length + openCheckIns.length
  // "running" means the selected project is busy; other projects may run at the same time.
  const running = demo || runs.some((r) => r.projectId === project?.id)
  const busyProjects = useMemo(() => new Set(runs.map((r) => r.projectId)), [runs])
  // People who belong to the selected project: the CEO, plan assignees, anyone with events there, the team.
  const involved = useMemo(() => {
    const ids = new Set<string>()
    if (!project) return ids
    const ceo = org?.divisions.find((d) => d.runtime === 'claude')?.ceo?.id
    if (ceo) ids.add(ceo)
    for (const x of plan?.tasks ?? []) if (x.assignee) ids.add(x.assignee)
    for (const e of events) if (e.projectId === project.id) for (const id of [e.agent, e.from, e.to]) if (id) ids.add(id)
    for (const a of repoTeam) ids.add(a.id)
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
    org, agents, runtimes, events, manual, proposals, pending, checkpoints, openCheckIns, attention, work, running, pulses, states, layout, connected, error, now, pulseRoute, outputs, git, spawned,
    projects, project, repoTeam, busyProjects, selectProject, plan, progress, involved,
    refreshManual, refreshState, refreshOrg, refreshProposals, refreshCheckpoints, refreshWork, refreshPlan,
  }
}

export type Company = ReturnType<typeof useCompany>
