// Scripted run generated from the current org, so the dashboard can be explored without spending quota.
import type { AgentEvent, AgentRef } from '../shared/types.ts'
import { bus, tagRun } from './events.ts'
import { allAgents, loadOrg, projectOf } from './org.ts'

type Step = [delayMs: number, e: Omit<AgentEvent, 'id' | 'ts' | 'runId'>]

let timer: NodeJS.Timeout | null = null

function script(ownerId: string, agents: AgentRef[]): Step[] {
  const ceo = agents.find((a) => a.isCeo && !a.manual && a.runtime === 'claude')
  if (!ceo) return []
  const team = agents.filter((a) => a.divisionId === ceo.divisionId && !a.isCeo && !a.core)
  const partner = agents.find((a) => a.isCeo && a.divisionId !== ceo.divisionId)
  const partnerTeam = partner ? agents.filter((a) => a.divisionId === partner.divisionId && !a.isCeo).slice(0, 2) : []
  // One person from each department, at most four, does a piece of the work.
  const workers: AgentRef[] = []
  for (const a of team) if (!workers.some((w) => w.departmentId === a.departmentId) && workers.length < 4) workers.push(a)

  const s: Step[] = [
    [0, { kind: 'task', from: ownerId, to: ceo.id, text: 'Prepare the launch plan for this month' }],
    [1200, { kind: 'activity', agent: ceo.id, text: 'Breaking the request into steps…' }],
  ]
  workers.forEach((w, i) => {
    s.push([i ? 400 : 1300, { kind: 'dispatch', from: ceo.id, to: w.id, text: `Draft the ${w.role.en.toLowerCase()} part of the plan`, meta: { aid: w.id } }])
  })
  // The first worker also takes a second task in parallel, to show one person holding two assignments.
  if (workers[0]) s.push([400, { kind: 'dispatch', from: ceo.id, to: workers[0].id, text: 'Collect references and examples', meta: { aid: `${workers[0].id}-2` } }])
  workers.forEach((w) => {
    s.push([900, { kind: 'activity', agent: w.id, text: 'Researching options' }])
  })
  workers.forEach((w) => {
    s.push([1200, { kind: 'activity', agent: w.id, text: `Writing plan/${w.id}.md` }])
  })
  workers.forEach((w) => {
    s.push([1500, { kind: 'report', from: w.id, to: ceo.id, text: `${w.role.en}: draft ready, 3 open questions`, meta: { aid: w.id } }])
  })
  if (workers[0]) s.push([900, { kind: 'report', from: workers[0].id, to: ceo.id, text: '12 references collected', meta: { aid: `${workers[0].id}-2` } }])
  if (partner) {
    s.push([1000, { kind: 'dispatch', from: ceo.id, to: partner.id, text: 'Independent review of the launch plan' }])
    s.push([1100, { kind: 'activity', agent: partner.id, text: 'Reading plan/*.md' }])
    partnerTeam.forEach((p) => s.push([600, { kind: 'dispatch', from: partner.id, to: p.id, text: `Check the plan from a ${p.role.en.toLowerCase()} angle` }]))
    partnerTeam.forEach((p) => s.push([1500, { kind: 'report', from: p.id, to: partner.id, text: '2 risks found, both fixable' }]))
    s.push([1300, { kind: 'report', from: partner.id, to: ceo.id, text: 'Review: plan is sound; tighten the budget and timeline' }])
  }
  s.push([1200, { kind: 'activity', agent: ceo.id, text: 'Merging drafts into plan/launch.md' }])
  s.push([1500, { kind: 'report', from: ceo.id, to: ownerId, text: 'Launch plan ready in plan/launch.md — 3 decisions need you' }])
  return s
}

export async function startDemo(projectId?: string): Promise<string> {
  stopDemo()
  const org = await loadOrg()
  const steps = script(org.owner.id, allAgents(org))
  const runId = `demo-${Date.now()}`
  tagRun(runId, projectOf(org, projectId).id)
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
