// Check-ins: break points where the organizer stops for the owner (a spec, a plan, a milestone, a choice).
// The organizer's ask_owner tool polls until the owner answers. If it gave up waiting (the owner was
// away), the answer is delivered another way: into the live session, or by resuming the session.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Checkpoint, CheckpointKind } from '../shared/types.ts'
import { bus, projectOfRun } from './events.ts'
import { DATA_DIR } from './org.ts'
import { addMessage } from './chat.ts'

const FILE = path.join(DATA_DIR, 'checkpoints.json')
const all: Checkpoint[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []
const save = () => writeFileSync(FILE, JSON.stringify(all.slice(-300), null, 2))

// Runtime only: when ask_owner last polled, and whether it has picked up the answer.
const lastPoll = new Map<string, number>()
const delivered = new Set<string>()
const POLL_GRACE_MS = 8000

const KIND: Record<CheckpointKind, string> = { spec: 'Spec', plan: 'Plan', milestone: 'Milestone', decision: 'Decision' }

export const listCheckpoints = () => [...all].reverse().slice(0, 100)
export const openCheckpoints = () => all.filter((c) => c.status === 'open')

/** The check-in an agent is waiting on in a project, if any (the owner's next chat message answers it). */
export const openCheckpointOf = (agentId: string, projectId: string) =>
  all.findLast((c) => c.status === 'open' && c.agentId === agentId && c.projectId === projectId)

export function createCheckpoint(
  input: { agentId: string; kind: CheckpointKind; title: string; body: string; file?: string; options?: string[] },
  runId?: string,
): Checkpoint {
  const projectId = projectOfRun(runId)
  if (!projectId) throw new Error('Check-ins are made from inside a project run or chat.')
  if (!KIND[input.kind]) throw new Error(`Unknown check-in kind "${input.kind}"`)
  // A newer check-in from the same agent replaces one it never got an answer to.
  for (const c of all) if (c.status === 'open' && c.agentId === input.agentId && c.projectId === projectId) c.status = 'answered'
  const cp: Checkpoint = {
    id: randomUUID(),
    ts: Date.now(),
    projectId,
    runId,
    agentId: input.agentId,
    kind: input.kind,
    title: input.title.trim(),
    body: input.body.trim(),
    ...(input.file ? { file: input.file } : {}),
    ...(input.options?.length ? { options: input.options.slice(0, 4) } : {}),
    status: 'open',
  }
  all.push(cp)
  save()
  addMessage(cp.agentId, 'agent', `${KIND[cp.kind]}: ${cp.title}`, projectId, { ask: true, checkpointId: cp.id })
  bus.emit({ runId, kind: 'manual', from: cp.agentId, to: 'owner', projectId, text: `Check-in · ${KIND[cp.kind]}: ${cp.title}`, meta: { checkpointId: cp.id } })
  return cp
}

/** What the organizer reads back. */
export function answerText(cp: Checkpoint): string {
  const a = cp.answer!
  const note = a.comment?.trim() ? `\nOwner's comment: ${a.comment.trim()}` : ''
  if (a.decision === 'approve') return `The owner APPROVED the ${cp.kind} "${cp.title}".${note}\nContinue.`
  if (a.decision === 'changes') return `The owner REQUESTED CHANGES to the ${cp.kind} "${cp.title}".${note}\nRevise, then check in again before going on.`
  if (a.decision === 'reply') return `The owner replied about the ${cp.kind} "${cp.title}":\n${a.comment ?? ''}`
  return `The owner chose: ${a.decision} (for "${cp.title}").${note}`
}

/** Called by ask_owner while it waits. Marks the check-in as watched, and hands over the answer once. */
export function pollCheckpoint(id: string): { status: Checkpoint['status']; text?: string } {
  const cp = all.find((c) => c.id === id)
  if (!cp) throw new Error('Unknown check-in')
  lastPoll.set(id, Date.now())
  if (cp.status === 'answered' && cp.answer && !delivered.has(id)) {
    delivered.add(id)
    return { status: 'answered', text: answerText(cp) }
  }
  return { status: cp.status }
}

type Deliver = (cp: Checkpoint, text: string) => Promise<void>
let deliverLate: Deliver = async () => {}
/** How an answer reaches an organizer that stopped waiting (set by the server: live session, inbox or resume). */
export const onLateAnswer = (fn: Deliver) => (deliverLate = fn)

const label = (decision: string) => (decision === 'approve' ? '✓ Approved' : decision === 'changes' ? '✎ Changes requested' : decision === 'reply' ? '' : `→ ${decision}`)

export async function answerCheckpoint(id: string, answer: { decision: string; comment?: string }, opts: { fromChat?: boolean } = {}): Promise<Checkpoint> {
  const cp = all.find((c) => c.id === id)
  if (!cp) throw new Error('Unknown check-in')
  if (cp.status !== 'open') throw new Error('This check-in was already answered')
  cp.status = 'answered'
  cp.answer = { decision: answer.decision, ...(answer.comment?.trim() ? { comment: answer.comment.trim() } : {}), ts: Date.now() }
  save()
  // Keep the chat readable: the owner's answer shows up in the thread (a chat reply is already there).
  if (!opts.fromChat) addMessage(cp.agentId, 'owner', [label(cp.answer.decision), cp.answer.comment].filter(Boolean).join(' — '), cp.projectId)
  bus.emit({ kind: 'system', projectId: cp.projectId, agent: cp.agentId, text: `Check-in answered: ${cp.title}`, meta: { checkpointId: cp.id } })

  // If ask_owner is still polling it takes the answer itself; otherwise deliver it another way.
  const watched = Date.now() - (lastPoll.get(id) ?? 0) < POLL_GRACE_MS
  setTimeout(
    () => {
      if (delivered.has(id)) return
      delivered.add(id)
      void deliverLate(cp, answerText(cp)).catch((e) =>
        bus.emit({ kind: 'error', projectId: cp.projectId, agent: cp.agentId, text: `Could not deliver your answer: ${e instanceof Error ? e.message : String(e)}` }),
      )
    },
    watched ? POLL_GRACE_MS : 0,
  )
  return cp
}
