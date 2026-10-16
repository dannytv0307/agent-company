import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HireSpec, ManualTask, OrgDesign, OrgDef, ProjectSummary, ProposalKind, RuntimeStatus, TeamMode } from '../shared/types.ts'
import { bus, projectOfRun, tagRun } from './events.ts'
import { allAgents, DATA_DIR, findAgent, findAgentIn, loadOrg, mainCeo, projectOf, projectsOf, projectTeam, ROOT } from './org.ts'
import { compileOrg, DEFAULT_MAX_CONCURRENT, persona, PORT, syncProjects, writeCompiled } from './compile.ts'
import { loadPlan, planText, progress, setPlan, taskIdIn, updateTask, type PlanInput } from './plans.ts'
import { activeAssignments, assignmentsOf } from './assignments.ts'
import { detectRuntimes } from './detect.ts'
import { runClaudeTask } from './runners/claude.ts'
import { startCeoRun, withCeoRuntime, type CeoRun } from './runners/ceo.ts'
import { codexChildren, runCodexAgent } from './runners/codex.ts'
import { demoRunning, startDemo, stopDemo } from './demo.ts'
import { addMessage, anyReplying, chatHistory, clearConversation, isReplying, openQuestions, readInbox, resetProjectSessions, resetSession, sendToAgent } from './chat.ts'
import { projectChanges, fileDiff } from './changes.ts'
import { decide, listProposals, propose } from './proposals.ts'
import { addProject, removeProject, setActiveProject, updateAgent, updateProfile, updateProject, type AgentPatch } from './orgStore.ts'

const app = new Hono()

// ── run state: at most one company run per project, projects run in parallel ──
const active = new Map<string, { runId: string; ceoId: string; run: CeoRun }>()

// ── delegation jobs (called by the MCP server) ───────────────
type Job = { to: string; status: 'running' | 'done' | 'error'; result?: string; error?: string }
const jobs = new Map<string, Job>()
const MAX_CODEX = 3
let codexRunning = 0
const codexQueue: (() => void)[] = []
const acquire = () => new Promise<void>((r) => (codexRunning < MAX_CODEX ? (codexRunning++, r()) : codexQueue.push(() => (codexRunning++, r()))))
const release = () => {
  codexRunning--
  codexQueue.shift()?.()
}
// Each agent also has its own limit (maxConcurrent, default 2); extra work waits in line.
const perAgent = new Map<string, { running: number; waiting: (() => void)[] }>()
function acquireAgent(id: string, limit: number) {
  const s = perAgent.get(id) ?? { running: 0, waiting: [] }
  perAgent.set(id, s)
  return new Promise<void>((r) => (s.running < limit ? (s.running++, r()) : s.waiting.push(() => (s.running++, r()))))
}
function releaseAgent(id: string) {
  const s = perAgent.get(id)
  if (!s) return
  s.running--
  s.waiting.shift()?.()
}

// ── manual inbox (Antigravity) ───────────────────────────────
const DONE_FILE = path.join(DATA_DIR, 'manual-done.json')
const manualDone = new Set<string>(existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, 'utf8')) : [])

let runtimeCache: { at: number; data: RuntimeStatus[] } | null = null

app.onError((err, c) => c.json({ error: err.message }, 500))

// Agents run commands on this machine, so block cross-site requests: a custom header forces a CORS
// preflight, which this server never approves.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.header('x-agent-company') !== '1') return c.json({ error: 'Missing x-agent-company header' }, 403)
  await next()
})

app.get('/api/org', async (c) => {
  const org = await loadOrg()
  const projects = projectsOf(org)
  // Each project's own repo agents, shown on the chart when that project is selected.
  const projectAgents = Object.fromEntries(projects.map((p) => [p.id, projectTeam(org, p)]))
  return c.json({ org, agents: allAgents(org), projects, projectAgents, activeProject: projectOf(org).id })
})

app.get('/api/assignments', (c) => c.json(activeAssignments()))

// ── portfolio: every project at a glance ─────────────────────
app.get('/api/portfolio', async (c) => {
  const org = await loadOrg()
  const projects = projectsOf(org)
  const events = bus.history(3000)
  const working = activeAssignments()
  const pending = listProposals().filter((p) => p.status === 'pending')
  const everyone = [...allAgents(org), ...projects.flatMap((p) => projectTeam(org, p))].map((a) => a.id)
  const questions = openQuestions([...new Set(everyone)])
  const manualOpen = bus
    .history(3000)
    .filter((e) => e.kind === 'manual' && !e.meta?.proposalId && e.to && findAgent(org, e.to)?.manual && !manualDone.has(e.id))
  const summaries: ProjectSummary[] = projects.map((p) => {
    const plan = loadPlan(p.id)
    const counts = { todo: 0, doing: 0, review: 0, done: 0, blocked: 0 } as ProjectSummary['counts']
    for (const t of plan.tasks) counts[t.status]++
    const current = plan.milestones.find((m) => plan.tasks.some((t) => t.milestone === m.id && t.status !== 'done'))
    const next = plan.tasks.find((t) => t.status === 'doing') ?? plan.tasks.find((t) => t.status === 'todo')
    const mine = events.filter((e) => e.projectId === p.id)
    return {
      id: p.id,
      name: p.name,
      dir: p.dir,
      exists: p.exists,
      mode: p.mode,
      running: active.has(p.id),
      progress: progress(plan),
      counts,
      milestone: current?.title,
      next: next && { id: next.id, title: next.title, assignee: next.assignee },
      working: working.filter((w) => w.projectId === p.id).map((w) => ({ agentId: w.agentId, title: w.title })),
      lastActivity: mine.filter((e) => e.kind !== 'system').at(-1)?.ts,
      costUsd: mine.reduce((s, e) => s + (typeof e.meta?.costUsd === 'number' ? e.meta.costUsd : 0), 0),
      needs: {
        approvals: pending.filter((x) => x.projectId === p.id).length,
        questions: questions.filter((q) => q.projectId === p.id).length,
        blocked: counts.blocked,
        manual: manualOpen.filter((e) => e.projectId === p.id).length,
      },
    }
  })
  return c.json(summaries)
})

// ── what actually changed in a project (read-only git) ───────
app.get('/api/projects/:id/changes', async (c) => {
  const p = projectsOf(await loadOrg()).find((x) => x.id === c.req.param('id'))
  if (!p) return c.json({ error: 'Unknown project' }, 404)
  return c.json(await projectChanges(p.id, p.dir))
})

app.get('/api/projects/:id/diff', async (c) => {
  const p = projectsOf(await loadOrg()).find((x) => x.id === c.req.param('id'))
  if (!p) return c.json({ error: 'Unknown project' }, 404)
  return c.json({ diff: await fileDiff(p.dir, c.req.query('file') ?? '') })
})

// Company agents plus the repo's own agents of the project the caller's run belongs to.
app.get('/api/colleagues', async (c) => {
  const org = await loadOrg()
  const project = projectOf(org, projectOfRun(c.req.query('runId')))
  const repo = project.mode === 'company' ? [] : projectTeam(org, project)
  return c.json({ project: project.name, agents: [...allAgents(org), ...repo] })
})

// ── plans (per project) ──────────────────────────────────────
app.get('/api/plans', async (c) => {
  const org = await loadOrg()
  return c.json(projectsOf(org).map((p) => ({ plan: loadPlan(p.id), progress: progress(loadPlan(p.id)) })))
})
app.get('/api/plans/:projectId', (c) => {
  const plan = loadPlan(c.req.param('projectId'))
  return c.json({ plan, progress: progress(plan) })
})

// Agent-side plan tools (MCP). The project comes from the run the agent belongs to.
const planProject = async (runId?: string) => projectOf(await loadOrg(), projectOfRun(runId))
app.get('/api/agent-plan', async (c) => {
  const p = await planProject(c.req.query('runId'))
  return c.json({ text: `Project: ${p.name}\n${planText(loadPlan(p.id))}` })
})
app.post('/api/agent-plan/set', async (c) => {
  const body = await c.req.json<PlanInput & { runId?: string }>()
  if (!body.tasks?.length) return c.json({ error: 'tasks is empty' }, 400)
  const p = await planProject(body.runId)
  return c.json({ text: `Plan saved for ${p.name}.\n${planText(setPlan(p.id, body))}` })
})
app.post('/api/agent-plan/update', async (c) => {
  const body = await c.req.json<{ runId?: string; task_id: string; status?: string; note?: string; assignee?: string; title?: string; milestone?: string }>()
  const p = await planProject(body.runId)
  const t = updateTask(p.id, body)
  return c.json({ text: `${t.id} is now ${t.status}.` })
})

app.get('/api/runtimes', async (c) => {
  if (!runtimeCache || Date.now() - runtimeCache.at > 30_000 || c.req.query('refresh')) {
    runtimeCache = { at: Date.now(), data: await detectRuntimes(await loadOrg()) }
  }
  return c.json(runtimeCache.data)
})

app.get('/api/events', (c) => c.json(bus.history(Number(c.req.query('limit') ?? 500))))

app.get('/api/stream', (c) =>
  streamSSE(c, async (stream) => {
    const unsub = bus.subscribe((e) => void stream.writeSSE({ event: 'agent', data: JSON.stringify(e) }))
    stream.onAbort(unsub)
    while (!stream.aborted) {
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) })
      await stream.sleep(10_000) // the UI treats ~25s of silence as a dead connection
    }
    unsub()
  }),
)

app.get('/api/state', (c) =>
  c.json({
    runs: [...active.entries()].map(([projectId, a]) => ({ projectId, runId: a.runId })),
    demo: demoRunning(),
    codexRunning,
  }),
)

app.get('/api/compile', async (c) => {
  const org = await loadOrg()
  return c.json(compileOrg(org, projectOf(org, c.req.query('project'))))
})

app.post('/api/compile', async (c) => {
  const org = await loadOrg()
  const project = projectOf(org, c.req.query('project'))
  const files = compileOrg(org, project)
  const { workspace, skipped } = await writeCompiled(project.dir, files)
  bus.emit({ kind: 'system', projectId: project.id, text: `Deployed ${files.length - skipped.length} config files to ${path.basename(workspace)}/` })
  return c.json({ workspace, files, skipped })
})

// ── projects (one folder each) ───────────────────────────────
const APP_DIRS = ['server', 'web', 'shared', 'data', 'templates', 'node_modules', '.git', 'dist'].map((d) => path.join(ROOT, d))
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Validate (and create if needed) a project folder. Agents can write anywhere inside it. */
function prepareFolder(input: string): { stored: string; created: boolean } {
  if (!input?.trim()) throw new Error('Enter a folder path')
  const target = path.resolve(ROOT, input.trim())
  if (target === path.parse(target).root) throw new Error('A drive root cannot be a project folder')
  if (target === os.homedir() || inside(os.homedir(), target)) throw new Error('Your home folder (or a parent of it) cannot be a project folder — pick a folder inside it')
  if (target === ROOT || APP_DIRS.some((d) => inside(target, d))) throw new Error('That folder belongs to Agent Company itself')
  let created = false
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error('That path is a file, not a folder')
  } else {
    if (!existsSync(path.dirname(target))) throw new Error(`Parent folder does not exist: ${path.dirname(target)}`)
    mkdirSync(target)
    created = true
  }
  return { stored: inside(target, ROOT) ? `./${path.relative(ROOT, target).split(path.sep).join('/')}` : target, created }
}

app.post('/api/projects', async (c) => {
  const { name, path: folder } = await c.req.json<{ name: string; path: string }>()
  if (!name?.trim()) return c.json({ error: 'Give the project a name' }, 400)
  const org0 = await loadOrg()
  const { stored, created } = prepareFolder(folder)
  const target = path.resolve(ROOT, stored)
  if (projectsOf(org0).some((p) => p.dir === target)) return c.json({ error: 'Another project already uses that folder' }, 400)
  const p = await addProject(name, stored)
  const org = await loadOrg()
  const { skipped } = await writeCompiled(target, compileOrg(org, projectOf(org, p.id)))
  bus.emit({ kind: 'system', projectId: p.id, text: `Project "${p.name}" added`, meta: { orgChanged: true } })
  return c.json({ project: p, created, skipped })
})

app.put('/api/projects/active', async (c) => {
  const { id } = await c.req.json<{ id: string }>()
  await setActiveProject(id)
  bus.emit({ kind: 'system', projectId: id, text: 'Active project changed', meta: { orgChanged: true } })
  return c.json({ ok: true })
})

app.put('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  const { name, path: folder, team } = await c.req.json<{ name?: string; path?: string; team?: TeamMode }>()
  if (team && !['company', 'project', 'mixed'].includes(team)) return c.json({ error: 'Unknown team mode' }, 400)
  const org0 = await loadOrg()
  const current = projectsOf(org0).find((p) => p.id === id)
  if (!current) return c.json({ error: 'Unknown project' }, 404)
  let created = false
  let skipped: string[] = []
  let stored: string | undefined
  if (folder !== undefined && path.resolve(ROOT, folder.trim()) !== current.dir) {
    if (active.has(id) || anyReplying()) return c.json({ error: 'Wait until the work in this project finishes before moving its folder.' }, 409)
    ;({ stored, created } = prepareFolder(folder))
    const target = path.resolve(ROOT, stored)
    if (projectsOf(org0).some((p) => p.id !== id && p.dir === target)) return c.json({ error: 'Another project already uses that folder' }, 400)
  }
  await updateProject(id, { name, path: stored, team })
  const org1 = await loadOrg()
  if (stored) resetProjectSessions(id) // Claude sessions only resume in the folder they ran in
  if (stored || team) ({ skipped } = await writeCompiled(projectOf(org1, id).dir, compileOrg(org1, projectOf(org1, id))))
  bus.emit({ kind: 'system', projectId: id, text: 'Project updated', meta: { orgChanged: true } })
  return c.json({ ok: true, created, skipped })
})

app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id')
  if (active.has(id)) return c.json({ error: 'This project has a run in progress' }, 409)
  await removeProject(id) // the folder itself is left untouched
  resetProjectSessions(id)
  bus.emit({ kind: 'system', text: 'Project removed', meta: { orgChanged: true } })
  return c.json({ ok: true })
})

// ── runs ─────────────────────────────────────────────────────
app.post('/api/run', async (c) => {
  const { task, projectId, ceoRuntime } = await c.req.json<{ task: string; projectId?: string; ceoRuntime?: 'claude' | 'codex' }>()
  if (!task?.trim()) return c.json({ error: 'Task is empty' }, 400)
  if (ceoRuntime && !['claude', 'codex'].includes(ceoRuntime)) return c.json({ error: 'ceoRuntime is claude or codex' }, 400)
  // Optional per-run override of the CEO's engine (the owner's setting is the default).
  const org = withCeoRuntime(await loadOrg(), ceoRuntime)
  const project = projectOf(org, projectId)
  if (active.has(project.id)) return c.json({ error: `A run is already in progress in ${project.name}` }, 409)
  if (!project.exists) return c.json({ error: `The folder of "${project.name}" no longer exists: ${project.dir}` }, 400)
  await writeCompiled(project.dir, compileOrg(org, project)) // always run with configs that match org.yaml
  const runId = `run-${Date.now()}`
  tagRun(runId, project.id)
  const run = startCeoRun(org, runId, task.trim(), project)
  active.set(project.id, { runId, ceoId: mainCeo(org)?.id ?? '', run })
  void run.done
    .catch(() => {})
    .finally(() => {
      if (active.get(project.id)?.runId === runId) active.delete(project.id)
    })
  return c.json({ runId, projectId: project.id })
})

app.post('/api/demo', async (c) => {
  const { projectId } = await c.req.json<{ projectId?: string }>().catch(() => ({ projectId: undefined }))
  return c.json({ runId: await startDemo(projectId) })
})

app.post('/api/stop', async (c) => {
  const { projectId } = await c.req.json<{ projectId?: string }>().catch(() => ({ projectId: undefined }))
  const stopped: string[] = []
  if (stopDemo()) stopped.push('demo')
  for (const [pid, a] of active) {
    if (projectId && pid !== projectId) continue
    a.run.child?.kill()
    stopped.push(a.runId)
  }
  if (!projectId || active.size <= 1) for (const ch of codexChildren) ch.kill()
  if (stopped.length) bus.emit({ kind: 'system', projectId, text: 'Stopped by owner', meta: { end: true, runIds: stopped } })
  return c.json({ stopped })
})

app.post('/api/delegate', async (c) => {
  const { from, to, task, runId } = await c.req.json<{ from: string; to: string; task: string; runId?: string }>()
  const org = await loadOrg()
  const project = projectOf(org, projectOfRun(runId))
  const target = findAgentIn(org, to, project)
  if (!target) return c.json({ error: `Unknown agent "${to}". Call list_colleagues first.` }, 404)
  const jobId = randomUUID()
  const rid = runId || active.get(project.id)?.runId
  // A hand-off inherits the plan task its sender is working on, so sub-work counts toward it.
  const taskId = taskIdIn(task) ?? assignmentsOf(from).find((a) => a.taskId && a.projectId === project.id)?.taskId

  if (target.manual) {
    bus.emit({ runId: rid, kind: 'manual', from, to, text: task.slice(0, 120), meta: { full: task } })
    jobs.set(jobId, { to, status: 'done', result: `${target.name.en} works manually in Antigravity. The task was queued for the owner; do not wait for it.` })
    return c.json({ jobId })
  }
  if (target.id === mainCeo(org)?.id) {
    return c.json({ error: 'The CEO coordinates the work — report back to the CEO instead of delegating to them.' }, 400)
  }

  jobs.set(jobId, { to, status: 'running' })
  const meta = { aid: jobId, taskId }
  bus.emit({ runId: rid, kind: 'dispatch', from, to, text: task.slice(0, 120), meta: { ...meta, full: task, crossDivision: target.runtime !== 'claude' } })
  void (async () => {
    await acquireAgent(to, target.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    await acquire()
    try {
      const notes = readInbox(to)
      const full = notes.length ? `${task}\n\nNotes from the owner for you:\n${notes.map((n) => `- ${n}`).join('\n')}` : task
      // Claude agents (company members or the repo's own agents) run as their own session in the
      // project; Codex agents go through codex exec.
      const result =
        target.runtime === 'claude'
          ? await runClaudeTask(org, target, `[Task from ${from}, delegated through the company]\n${full}\n\nWhen done, reply with a concise report (max 10 lines).`, {
              runId: rid ?? jobId,
              project,
              ...meta,
            })
          : await runCodexAgent(org, target, from, full, rid, { dir: project.dir, ...meta })
      bus.emit({ runId: rid, kind: 'report', from: to, to: from, text: result.replace(/\s+/g, ' ').slice(0, 140), meta: { ...meta, full: result } })
      jobs.set(jobId, { to, status: 'done', result })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      bus.emit({ runId: rid, kind: 'error', agent: to, text: msg.slice(0, 200), meta })
      jobs.set(jobId, { to, status: 'error', error: msg })
    } finally {
      release()
      releaseAgent(to)
    }
  })()
  return c.json({ jobId })
})

app.get('/api/delegate/:id', (c) => {
  const job = jobs.get(c.req.param('id'))
  return job ? c.json(job) : c.json({ error: 'unknown job' }, 404)
})

app.get('/api/manual', async (c) => {
  const org = await loadOrg()
  const items: ManualTask[] = bus
    .history(3000)
    .filter((e) => e.kind === 'manual' && e.to && !e.meta?.proposalId && findAgent(org, e.to)?.manual)
    .map((e) => {
      const agent = findAgent(org, e.to!)
      const task = String(e.meta?.full ?? e.text)
      return {
        id: e.id,
        ts: e.ts,
        from: e.from ?? '',
        to: e.to!,
        task,
        prompt: agent ? `${persona(org, agent)}\n\n---\nTask from ${e.from}:\n${task}` : task,
        done: manualDone.has(e.id),
      }
    })
  return c.json(items.reverse())
})

app.post('/api/manual/:id/done', (c) => {
  manualDone.add(c.req.param('id'))
  writeFileSync(DONE_FILE, JSON.stringify([...manualDone]))
  bus.emit({ kind: 'system', text: 'Manual task marked done', meta: { manualId: c.req.param('id') } })
  return c.json({ ok: true })
})

// ── owner profile ────────────────────────────────────────────
app.put('/api/profile', async (c) => {
  const patch = await c.req.json<{ owner?: Partial<OrgDef['owner']>; company?: Partial<OrgDef['company']> }>()
  await syncProjects(await updateProfile(patch))
  bus.emit({ kind: 'system', text: 'Owner profile updated', meta: { orgChanged: true } })
  return c.json({ ok: true })
})

// ── edit one agent (name, role, instructions, model) ─────────
app.put('/api/agents/:id', async (c) => {
  const id = c.req.param('id')
  const patch = await c.req.json<AgentPatch>()
  await updateAgent(id, patch)
  await syncProjects(await loadOrg())
  // A renamed or re-briefed agent starts fresh 1:1 sessions so it doesn't answer as its old self.
  if (patch.name || patch.prompt !== undefined || patch.description !== undefined) resetSession(id)
  bus.emit({ kind: 'system', agent: id, text: 'Agent profile updated', meta: { orgChanged: true } })
  return c.json({ ok: true })
})

// ── org proposals (CEO designs, HR hires) ────────────────────
app.get('/api/proposals', (c) => c.json(listProposals()))

app.post('/api/proposals', async (c) => {
  const body = await c.req.json<{ kind: ProposalKind; from: string; reason?: string; design?: OrgDesign; hire?: HireSpec; dismiss?: { id: string }; runId?: string }>()
  if (body.kind === 'design' && !body.design?.departments?.length) return c.json({ error: 'design.departments is empty' }, 400)
  if (body.kind === 'hire' && !body.hire?.id) return c.json({ error: 'hire spec is missing' }, 400)
  if (body.kind === 'dismiss' && !body.dismiss?.id) return c.json({ error: 'dismiss.id is missing' }, 400)
  const message = await propose(
    { kind: body.kind, from: body.from, reason: body.reason ?? '', design: body.design, hire: body.hire, dismiss: body.dismiss },
    body.runId,
  )
  return c.json({ message })
})

app.post('/api/proposals/:id/decide', async (c) => {
  const { approve } = await c.req.json<{ approve: boolean }>()
  const p = await decide(c.req.param('id'), approve)
  if (approve && p.kind === 'dismiss' && p.dismiss) resetSession(p.dismiss.id)
  return c.json(p)
})

// ── chat ─────────────────────────────────────────────────────
app.get('/api/chat/:id', (c) => c.json({ messages: chatHistory(c.req.param('id')), replying: isReplying(c.req.param('id')) }))

app.post('/api/chat/:id', async (c) => {
  const { text, projectId } = await c.req.json<{ text: string; projectId?: string }>()
  if (!text?.trim()) return c.json({ error: 'Message is empty' }, 400)
  const project = projectOf(await loadOrg(), projectId)
  const run = active.get(project.id)
  const live = run ? { ceoId: run.ceoId, send: (t: string) => run.run.send(t) } : null
  await sendToAgent(c.req.param('id'), text.trim(), project, live)
  return c.json({ ok: true })
})

app.delete('/api/chat/:id', async (c) => {
  const project = projectOf(await loadOrg(), c.req.query('project'))
  try {
    return c.json({ removed: clearConversation(c.req.param('id'), project.id), clearedAt: Date.now() })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409)
  }
})

// Agent-side tools (called by the MCP server).
app.post('/api/inbox/:id/read', (c) => c.json({ notes: readInbox(c.req.param('id')) }))

app.post('/api/chat/:id/from-agent', async (c) => {
  const { text, runId } = await c.req.json<{ text: string; runId?: string }>()
  addMessage(c.req.param('id'), 'agent', text, projectOfRun(runId), true)
  return c.json({ ok: true })
})

// Production: serve the built UI.
const dist = path.join(ROOT, 'dist')
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }))
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  console.log(`Agent Company server → http://127.0.0.1:${PORT}`)
})
