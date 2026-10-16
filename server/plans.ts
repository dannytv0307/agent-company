// One plan per project: milestones and tasks, kept by the CEO and advanced automatically from events.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Plan, PlanTask, TaskStatus } from '../shared/types.ts'
import { bus } from './events.ts'
import { DATA_DIR } from './org.ts'

const DIR = path.join(DATA_DIR, 'plans')
mkdirSync(DIR, { recursive: true })
const file = (projectId: string) => path.join(DIR, `${projectId.replace(/[^a-z0-9-]/gi, '_')}.json`)
const STATUSES: TaskStatus[] = ['todo', 'doing', 'review', 'done', 'blocked']

export function loadPlan(projectId: string): Plan {
  const f = file(projectId)
  if (existsSync(f)) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as Plan
    } catch {
      // fall through to an empty plan
    }
  }
  return { projectId, milestones: [], tasks: [], updatedAt: 0 }
}

function save(plan: Plan, why: string) {
  plan.updatedAt = Date.now()
  writeFileSync(file(plan.projectId), JSON.stringify(plan, null, 2))
  bus.emit({ kind: 'system', projectId: plan.projectId, text: why, meta: { planChanged: plan.projectId } })
}

export function progress(plan: Plan) {
  const total = plan.tasks.length
  const done = plan.tasks.filter((t) => t.status === 'done').length
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
}

const nextId = (plan: Plan) => `T${plan.tasks.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, '')) || 0), 0) + 1}`
const normId = (id?: string) => (id ? id.trim().toUpperCase().replace(/^(\d+)$/, 'T$1') : undefined)
const status = (s?: string): TaskStatus | undefined => (STATUSES.includes(s as TaskStatus) ? (s as TaskStatus) : undefined)

export interface PlanInput {
  goal?: string
  milestones?: { id: string; title: string }[]
  tasks: { id?: string; title: string; milestone?: string; assignee?: string; status?: string; note?: string }[]
}

/** Replace the plan's structure. Tasks keep their progress when their id is reused. */
export function setPlan(projectId: string, input: PlanInput): Plan {
  const old = loadPlan(projectId)
  const plan: Plan = { projectId, goal: input.goal ?? old.goal, milestones: input.milestones ?? old.milestones, tasks: [], updatedAt: 0 }
  for (const t of input.tasks) {
    const id = normId(t.id) ?? nextId(plan)
    const prev = old.tasks.find((x) => x.id === id)
    plan.tasks.push({
      id,
      title: t.title,
      milestone: t.milestone ?? prev?.milestone,
      assignee: t.assignee ?? prev?.assignee,
      status: status(t.status) ?? prev?.status ?? 'todo',
      note: t.note ?? prev?.note,
      updatedAt: Date.now(),
    })
  }
  save(plan, `Plan set: ${plan.tasks.length} tasks`)
  return plan
}

export function updateTask(projectId: string, u: { task_id: string; status?: string; note?: string; assignee?: string; title?: string; milestone?: string }): PlanTask {
  const plan = loadPlan(projectId)
  const id = normId(u.task_id)!
  let t = plan.tasks.find((x) => x.id === id)
  if (!t) {
    if (!u.title) throw new Error(`No task ${id} in the plan. Pass a title to add it, or call set_plan.`)
    t = { id, title: u.title, status: 'todo', updatedAt: Date.now() }
    plan.tasks.push(t)
  }
  if (u.title) t.title = u.title
  if (u.milestone) t.milestone = u.milestone
  if (u.assignee) t.assignee = u.assignee
  if (u.note !== undefined) t.note = u.note
  const s = status(u.status)
  if (u.status && !s) throw new Error(`Unknown status "${u.status}". Use ${STATUSES.join(' | ')}`)
  if (s) t.status = s
  t.updatedAt = Date.now()
  save(plan, `${t.id} → ${t.status}`)
  return t
}

export function planText(plan: Plan): string {
  if (!plan.tasks.length) return 'No plan yet for this project. Create one with set_plan.'
  const p = progress(plan)
  const lines = [`${plan.goal ? `Goal: ${plan.goal}\n` : ''}Progress: ${p.done}/${p.total} done (${p.pct}%)`]
  const groups = plan.milestones.length ? plan.milestones : [{ id: '', title: 'Tasks' }]
  for (const m of groups) {
    const ts = plan.tasks.filter((t) => (m.id ? t.milestone === m.id : true))
    if (!ts.length) continue
    lines.push(`\n${m.id ? `${m.id} ` : ''}${m.title}`)
    for (const t of ts) lines.push(`  ${t.id} [${t.status}] ${t.title}${t.assignee ? ` — ${t.assignee}` : ''}${t.note ? ` (${t.note})` : ''}`)
  }
  const loose = plan.milestones.length ? plan.tasks.filter((t) => !plan.milestones.some((m) => m.id === t.milestone)) : []
  if (loose.length) lines.push('\nOther', ...loose.map((t) => `  ${t.id} [${t.status}] ${t.title}`))
  return lines.join('\n')
}

/** "[T3] Build the API" → "T3" */
export const taskIdIn = (text?: unknown) => (typeof text === 'string' ? text.match(/\[(T\d+)\]/i)?.[1]?.toUpperCase() : undefined)

// Advance tasks from what actually happens, so progress never depends on agents remembering to report it.
bus.subscribe((e) => {
  const taskId = typeof e.meta?.taskId === 'string' ? e.meta.taskId : undefined
  if (!taskId || !e.projectId) return
  const plan = loadPlan(e.projectId)
  const t = plan.tasks.find((x) => x.id === taskId)
  if (!t) return
  let changed = false
  if (e.kind === 'dispatch' && t.status !== 'done') {
    t.status = 'doing'
    if (!t.assignee && e.to) t.assignee = e.to
    changed = true
  } else if (e.kind === 'report' && t.status !== 'done') {
    t.status = 'done'
    changed = true
  } else if (e.kind === 'error') {
    t.status = 'blocked'
    t.note = e.text.slice(0, 120)
    changed = true
  }
  if (changed) {
    t.updatedAt = Date.now()
    save(plan, `${t.id} → ${t.status}`) // synchronous, so quick successive events never overwrite each other
  }
})
