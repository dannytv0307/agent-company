// Org changes proposed by agents. The owner approves them (or auto-approves in their preferences).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Proposal } from '../shared/types.ts'
import { bus, projectOfRun } from './events.ts'
import { DATA_DIR, loadOrg } from './org.ts'
import { applyDesign, dismiss, hire } from './orgStore.ts'
import { syncProjects } from './compile.ts'

const FILE = path.join(DATA_DIR, 'proposals.json')
const proposals: Proposal[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []
const save = () => writeFileSync(FILE, JSON.stringify(proposals.slice(-200), null, 2))

export const listProposals = () => [...proposals].reverse()

function summary(p: Proposal): string {
  if (p.kind === 'design') {
    const n = p.design!.departments.reduce((s, d) => s + d.members.length, 0)
    return `Company design: ${p.design!.departments.length} departments, ${n} people`
  }
  if (p.kind === 'hire') return `Hire ${p.hire!.name.en} — ${p.hire!.role.en}`
  return `Dismiss ${p.dismiss!.id}`
}

/** Returns a message for the agent that proposed the change. */
export async function propose(input: Omit<Proposal, 'id' | 'ts' | 'status'>, runId?: string): Promise<string> {
  const p: Proposal = { ...input, id: randomUUID(), ts: Date.now(), status: 'pending', projectId: projectOfRun(runId) }
  proposals.push(p)
  save()
  const org = await loadOrg()
  if (org.owner.preferences?.approval === 'auto') {
    await decide(p.id, true)
    return `${summary(p)} — applied (owner auto-approves org changes).`
  }
  bus.emit({ runId, kind: 'manual', from: p.from, to: org.owner.id, text: `Approval needed: ${summary(p)}`, meta: { proposalId: p.id } })
  return `${summary(p)} — submitted for the owner's approval (id ${p.id.slice(0, 8)}). Continue with other work; do not resubmit.`
}

export async function decide(id: string, approve: boolean): Promise<Proposal> {
  const p = proposals.find((x) => x.id === id)
  if (!p) throw new Error('Unknown proposal')
  if (p.status !== 'pending') return p
  if (approve) {
    if (p.kind === 'design') await applyDesign(p.design!)
    else if (p.kind === 'hire') await hire(p.hire!)
    else await dismiss(p.dismiss!.id)
    await syncProjects(await loadOrg())
  }
  p.status = approve ? 'approved' : 'rejected'
  save()
  bus.emit({ kind: 'system', from: p.from, text: `${approve ? 'Approved' : 'Rejected'}: ${summary(p)}`, meta: { proposalId: p.id, orgChanged: approve } })
  return p
}
