// Team changes proposed by the organizer: a team for a project, one hire, or one dismissal. They change the
// project's own agent files, so the owner approves them (or auto-approves in their preferences).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HireSpec, Proposal } from '../shared/types.ts'
import { bus, projectOfRun } from './events.ts'
import { allAgents, DATA_DIR, loadOrg, projectsOf } from './org.ts'
import { removable, removeAgent, writeAgents } from './projectAgents.ts'
import { grantPermissions } from './orgStore.ts'
import { syncProjects } from './compile.ts'
import { addMessage } from './chat.ts'

const FILE = path.join(DATA_DIR, 'proposals.json')
type Legacy = Proposal & { design?: { departments?: { members: (HireSpec & { role?: { en: string } })[] }[] } }
// Proposals from the department era carry `design.departments`; read them as a flat list of agents.
const proposals: Proposal[] = (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Legacy[]) : []).map((p) =>
  p.design && !p.design.agents ? { ...p, design: { agents: (p.design.departments ?? []).flatMap((d) => d.members) } } : p,
)
const save = () => writeFileSync(FILE, JSON.stringify(proposals.slice(-200), null, 2))

export const listProposals = () => [...proposals].reverse()

const permissionLabel = (p: Proposal) => [...(p.permission?.tools ?? []), ...(p.permission?.codexNetwork ? ['network for Codex'] : [])].join(', ')

/** A request for something the project already allows, or already waiting for the owner, is not repeated. */
export async function hasPermissionRequest(projectId: string, tools: string[], codexNetwork: boolean): Promise<boolean> {
  const project = projectsOf(await loadOrg()).find((x) => x.id === projectId)
  const allowed = new Set(project?.allow ?? [])
  const pending = proposals.filter((x) => x.kind === 'permission' && x.status === 'pending' && x.projectId === projectId)
  const asked = new Set(pending.flatMap((x) => x.permission?.tools ?? []))
  const networkCovered = !codexNetwork || project?.codexNetwork || pending.some((x) => x.permission?.codexNetwork)
  return tools.every((t) => allowed.has(t) || asked.has(t)) && !!networkCovered
}

async function projectName(id?: string) {
  return projectsOf(await loadOrg()).find((p) => p.id === id)?.name ?? id ?? '?'
}

async function summary(p: Proposal): Promise<string> {
  const where = await projectName(p.projectId)
  if (p.kind === 'design') return `Team for ${where}: ${p.design!.agents.map((a) => a.id).join(', ')}`
  if (p.kind === 'hire') return `Add ${p.hire!.id} to ${where}`
  if (p.kind === 'permission') return `Allow ${permissionLabel(p)} in ${where}`
  return `Remove ${p.dismiss!.id} from ${where}`
}

/** Returns a message for the agent that proposed the change. */
export async function propose(input: Omit<Proposal, 'id' | 'ts' | 'status' | 'projectId'>, runId?: string): Promise<string> {
  const projectId = projectOfRun(runId)
  if (!projectId) throw new Error('Team changes are made from inside a project run or chat.')
  if (input.kind === 'dismiss') {
    // Say so now rather than after the owner approves.
    const project = projectsOf(await loadOrg()).find((x) => x.id === projectId)
    const r = project ? removable(project, input.dismiss!.id) : { error: 'Unknown project' }
    if ('error' in r) throw new Error(r.error)
  }
  const p: Proposal = { ...input, id: randomUUID(), ts: Date.now(), status: 'pending', projectId }
  proposals.push(p)
  save()
  const org = await loadOrg()
  if (org.owner.preferences?.approval === 'auto') {
    await decide(p.id, true)
    return `${await summary(p)} — applied (owner auto-approves team changes). New agents can be used from the next session.`
  }
  bus.emit({ runId, kind: 'manual', from: p.from, to: org.owner.id, projectId, text: `Approval needed: ${await summary(p)}`, meta: { proposalId: p.id } })
  addMessage(p.from, 'agent', `Approval needed: ${await summary(p)}`, projectId, { proposalId: p.id })
  return `${await summary(p)} — submitted for the owner's approval (id ${p.id.slice(0, 8)}). Continue with other work; do not resubmit.`
}

export async function decide(id: string, approve: boolean): Promise<Proposal> {
  const p = proposals.find((x) => x.id === id)
  if (!p) throw new Error('Unknown proposal')
  if (p.status !== 'pending') return p
  if (approve) {
    const org = await loadOrg()
    const project = projectsOf(org).find((x) => x.id === p.projectId)
    if (!project) throw new Error('The project of this proposal no longer exists')
    const reserved = [org.owner.id, ...allAgents(org).map((a) => a.id)]
    if (p.kind === 'design') writeAgents(org, project, p.design!.agents, reserved)
    else if (p.kind === 'hire') writeAgents(org, project, [p.hire!], reserved)
    else if (p.kind === 'permission') await grantPermissions(project.id, p.permission!)
    else removeAgent(project, p.dismiss!.id)
    await syncProjects(await loadOrg()) // the organizer's brief lists the new team and permissions
  }
  p.status = approve ? 'approved' : 'rejected'
  save()
  // A note, not an owner message: nobody should wait for a reply to it.
  addMessage(p.from, 'note', `${approve ? '✓ Approved' : '✗ Declined'}: ${await summary(p)}`, p.projectId)
  bus.emit({ kind: 'system', from: p.from, projectId: p.projectId, text: `${approve ? 'Approved' : 'Rejected'}: ${await summary(p)}`, meta: { proposalId: p.id, orgChanged: approve } })
  return p
}
