// Scripted run generated from the project's team, so the dashboard can be explored without spending quota.
import type { AgentEvent, AgentRef } from '../shared/types.ts'
import { bus, tagRun } from './events.ts'
import { loadOrg, mainCeo, projectOf, projectTeam } from './org.ts'

type Step = [delayMs: number, e: Omit<AgentEvent, 'id' | 'ts' | 'runId'>]

let timer: NodeJS.Timeout | null = null

function script(ownerId: string, ceo: AgentRef, team: AgentRef[]): Step[] {
  // Up to four of the project's agents each do a piece of the work.
  const workers = team.slice(0, 4)
  const s: Step[] = [
    [0, { kind: 'task', from: ownerId, to: ceo.id, text: 'Prepare the plan for the next milestone' }],
    [1200, { kind: 'activity', agent: ceo.id, text: 'Breaking the request into steps…' }],
  ]
  if (!workers.length) {
    // No team yet: the CEO works alone and suggests one.
    s.push([1300, { kind: 'activity', agent: ceo.id, text: 'Reading the repo' }])
    s.push([1500, { kind: 'activity', agent: ceo.id, text: 'Writing plan/next.md' }])
    s.push([1500, { kind: 'report', from: ceo.id, to: ownerId, text: 'Plan ready in plan/next.md — I suggest a team of 3 agents for this project' }])
    return s
  }
  workers.forEach((w, i) => {
    s.push([i ? 400 : 1300, { kind: 'dispatch', from: ceo.id, to: w.id, text: `Draft the ${w.role.en.toLowerCase()} part of the plan`, meta: { aid: w.id } }])
  })
  // The first worker also takes a second task in parallel, to show one agent holding two assignments.
  s.push([400, { kind: 'dispatch', from: ceo.id, to: workers[0].id, text: 'Collect references and examples', meta: { aid: `${workers[0].id}-2` } }])
  workers.forEach((w) => s.push([900, { kind: 'activity', agent: w.id, text: 'Reading the codebase' }]))
  workers.forEach((w) => s.push([1200, { kind: 'activity', agent: w.id, text: `Writing plan/${w.id}.md` }]))
  workers.forEach((w) => s.push([1500, { kind: 'report', from: w.id, to: ceo.id, text: `${w.role.en}: draft ready, 3 open questions`, meta: { aid: w.id } }]))
  s.push([900, { kind: 'report', from: workers[0].id, to: ceo.id, text: '12 references collected', meta: { aid: `${workers[0].id}-2` } }])
  s.push([1200, { kind: 'activity', agent: ceo.id, text: 'Merging drafts into plan/next.md' }])
  s.push([1500, { kind: 'report', from: ceo.id, to: ownerId, text: 'Plan ready in plan/next.md — 3 decisions need you' }])
  return s
}

export async function startDemo(projectId?: string): Promise<string> {
  stopDemo()
  const org = await loadOrg()
  const project = projectOf(org, projectId)
  const ceo = mainCeo(org)
  const steps = ceo ? script(org.owner.id, ceo, projectTeam(org, project)) : []
  const runId = `demo-${Date.now()}`
  tagRun(runId, project.id)
  bus.emit({ runId, kind: 'system', text: 'Demo run started (no quota used)', meta: { demo: true } })
  let i = 0
  const next = () => {
    if (i >= steps.length) {
      bus.emit({ runId, kind: 'system', text: 'Run finished', meta: { end: true, demo: true } })
      timer = null
      return
    }
    const [, e] = steps[i++]
    // Assignment ids are made unique per demo run.
    bus.emit({ ...e, runId, meta: { ...e.meta, ...(e.meta?.aid ? { aid: `${runId}:${e.meta.aid}` } : {}), demo: true } })
    timer = setTimeout(next, steps[i]?.[0] ?? 800)
  }
  timer = setTimeout(next, 300)
  return runId
}

export const demoRunning = () => timer !== null

export function stopDemo(): boolean {
  if (!timer) return false
  clearTimeout(timer)
  timer = null
  return true
}
