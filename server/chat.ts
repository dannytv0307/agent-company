// 1:1 chat between the owner and any agent.
// Routing: CEO mid-run → injected live; busy member → inbox (read via check_messages);
// idle agent → a direct session resumed per agent, so each conversation keeps its context.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentRef, ChatMessage, OrgDef, ProjectRef } from '../shared/types.ts'
import { bus, tagRun } from './events.ts'
import { DATA_DIR, findAgentIn, loadOrg } from './org.ts'
import { ceoPrompt, compileOrg, writeCompiled } from './compile.ts'
import { isBusy } from './assignments.ts'
import { runClaudeDirect } from './runners/claude.ts'
import { repoContext, runCodexAgent } from './runners/codex.ts'

const CHAT_DIR = path.join(DATA_DIR, 'chats')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
mkdirSync(CHAT_DIR, { recursive: true })

const threads = new Map<string, ChatMessage[]>()
// Direct sessions are per agent *and* project ("mei@main"): a session only resumes in the folder it ran in.
const sessions: Record<string, string> = existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) : {}
const key = (agentId: string, projectId: string) => `${agentId}@${projectId}`
const inbox = new Map<string, string[]>()
const replying = new Set<string>()
// Messages sent while the agent is still answering the previous one.
const queued = new Map<string, { text: string; project: ProjectRef }[]>()

function thread(agentId: string): ChatMessage[] {
  let t = threads.get(agentId)
  if (!t) {
    const file = path.join(CHAT_DIR, `${agentId}.jsonl`)
    t = existsSync(file)
      ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChatMessage)
      : []
    threads.set(agentId, t)
  }
  return t
}

export function addMessage(agentId: string, role: ChatMessage['role'], text: string, projectId?: string, ask = false): ChatMessage {
  const m: ChatMessage = { id: randomUUID(), ts: Date.now(), agentId, role, text, ...(projectId ? { projectId } : {}), ...(ask ? { ask } : {}) }
  thread(agentId).push(m)
  appendFileSync(path.join(CHAT_DIR, `${agentId}.jsonl`), JSON.stringify(m) + '\n')
  bus.emit({ kind: 'chat', agent: agentId, projectId, text: text.slice(0, 140), meta: { message: m } })
  return m
}

export const chatHistory = (agentId: string) => thread(agentId).slice(-200)

/** Questions agents asked the owner that have no owner reply after them yet, per project. */
export function openQuestions(agentIds: string[]): { agentId: string; projectId?: string; text: string; ts: number }[] {
  const out: { agentId: string; projectId?: string; text: string; ts: number }[] = []
  for (const id of agentIds) {
    const t = thread(id)
    const lastOwner = t.reduce((m, x) => (x.role === 'owner' ? Math.max(m, x.ts) : m), 0)
    for (const x of t) if (x.ask && x.ts > lastOwner) out.push({ agentId: id, projectId: x.projectId, text: x.text, ts: x.ts })
  }
  return out
}
export const isReplying = (agentId: string) => replying.has(agentId)
export const anyReplying = () => replying.size > 0

/** Owner notes waiting for a busy agent; reading them clears the inbox. */
export function readInbox(agentId: string): string[] {
  const notes = inbox.get(agentId) ?? []
  inbox.delete(agentId)
  return notes
}

function recentWork(agentId: string): string {
  const lines = bus
    .history(400)
    .filter((e) => e.kind !== 'chat' && e.kind !== 'system' && (e.agent === agentId || e.from === agentId || e.to === agentId))
    .slice(-8)
    .map((e) => `- ${new Date(e.ts).toLocaleTimeString()} ${e.kind}: ${e.text}`)
  return lines.length ? `Your recent work in the company:\n${lines.join('\n')}` : 'You have no recent work in the company yet.'
}

function directPrompt(org: OrgDef, a: AgentRef, project: ProjectRef, text: string): string {
  return [
    `[Direct message from the owner, ${org.owner.name.en}, about the project "${project.name}" (the current folder). Reply in ${org.owner.preferences?.reportLanguage ?? 'the language the owner writes in'}, conversationally and concisely. If they ask you to do work, do it in this folder, then summarise what changed.]`,
    sessions[key(a.id, project.id)] ? '' : recentWork(a.id),
    '',
    text,
  ].join('\n')
}

export interface LiveCeo {
  ceoId: string
  send: (text: string) => boolean
}

export async function sendToAgent(agentId: string, text: string, project: ProjectRef, live: LiveCeo | null): Promise<void> {
  const org = await loadOrg()
  const a = findAgentIn(org, agentId, project)
  if (!a) throw new Error(`Unknown agent "${agentId}"`)
  const note = (t: string) => addMessage(agentId, 'note', t, project.id)
  addMessage(agentId, 'owner', text, project.id)

  if (a.manual) {
    note(`${a.name.en} works by hand in Antigravity — copy this into Antigravity to continue the conversation.`)
    return
  }
  if (live && live.ceoId === agentId && live.send(`[Message from the owner during this run]\n${text}`)) {
    note(`Delivered live to ${a.name.en}'s current session in ${project.name}.`)
    return
  }
  if (isBusy(agentId) && !replying.has(agentId)) {
    inbox.set(agentId, [...(inbox.get(agentId) ?? []), text])
    note(`${a.name.en} is busy on a task — the message is in their inbox and they will read it at their next step.`)
    return
  }
  if (replying.has(agentId)) {
    queued.set(agentId, [...(queued.get(agentId) ?? []), { text, project }])
    note(`Queued — ${a.name.en} will read this right after finishing the current reply.`)
    return
  }
  if (!project.exists) throw new Error(`The folder of project "${project.name}" no longer exists: ${project.dir}`)
  startDirect(org, a, text, project)
}

/** A 1:1 session with an idle agent. Queued follow-ups are sent together once it answers. */
function startDirect(org: OrgDef, a: AgentRef, text: string, project: ProjectRef) {
  const agentId = a.id
  const runId = `chat-${agentId}-${Date.now()}`
  tagRun(runId, project.id)
  const k = key(agentId, project.id)
  const note = (t: string) => addMessage(agentId, 'note', t, project.id)
  replying.add(agentId)
  bus.emit({ runId, kind: 'activity', agent: agentId, text: 'Reading your message…', meta: { aid: runId } })
  void (async () => {
    try {
      await writeCompiled(project.dir, compileOrg(org, project))
      const prompt = directPrompt(org, a, project, text)
      let reply: string
      if (a.runtime === 'codex') {
        // A Codex CEO gets its full brief (team, plan tools) on a fresh thread, like a company run.
        const intro = a.isCeo ? `${ceoPrompt(org, a, project)}${repoContext(project.dir)}` : undefined
        reply = await runCodexAgent(org, a, org.owner.id, prompt, runId, { dir: project.dir, aid: runId, raw: true, intro, resume: sessions[k], onThread: (id) => saveSession(k, id) })
      } else {
        reply = await runClaudeDirect(org, a, prompt, { runId, project, resume: sessions[k], onSession: (id) => saveSession(k, id) })
      }
      addMessage(agentId, 'agent', reply.trim() || '(no reply)', project.id)
    } catch (e) {
      note(`Could not reach ${a.name.en}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      replying.delete(agentId)
      bus.emit({ runId, kind: 'system', agent: agentId, text: 'Chat reply finished', meta: { chatEnd: agentId, aid: runId } })
      const next = queued.get(agentId)
      if (next?.length) {
        queued.delete(agentId)
        // Follow-ups for the same project go together; others wait their turn.
        const same = next.filter((m) => m.project.id === next[0].project.id)
        const rest = next.filter((m) => m.project.id !== next[0].project.id)
        if (rest.length) queued.set(agentId, rest)
        startDirect(org, a, same.map((m) => m.text).join('\n\n'), next[0].project)
      }
    }
  })()
}

function saveSession(k: string, id: string) {
  sessions[k] = id
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

/** Forget the sessions of one project (its folder moved, so they can't be resumed there). */
export function resetProjectSessions(projectId: string) {
  for (const k of Object.keys(sessions)) if (k.endsWith(`@${projectId}`)) delete sessions[k]
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

/** Forget an agent's direct sessions in every project (e.g. after a dismissal or a rename). */
export function resetSession(agentId: string) {
  for (const k of Object.keys(sessions)) if (k === agentId || k.startsWith(`${agentId}@`)) delete sessions[k]
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

/**
 * Clear the owner's conversation with an agent in one project: its messages, queued follow-ups
 * and the resumable session, so the agent starts fresh. Other projects' conversations stay.
 */
export function clearConversation(agentId: string, projectId: string): number {
  if (replying.has(agentId)) throw new Error('The agent is still replying — try again in a moment.')
  const t = thread(agentId)
  // Messages from before projects existed have no project; they belong to whichever is cleared.
  const keep = t.filter((m) => m.projectId && m.projectId !== projectId)
  const removed = t.length - keep.length
  threads.set(agentId, keep)
  writeFileSync(path.join(CHAT_DIR, `${agentId}.jsonl`), keep.map((m) => JSON.stringify(m) + '\n').join(''))
  const rest = (queued.get(agentId) ?? []).filter((q) => q.project.id !== projectId)
  if (rest.length) queued.set(agentId, rest)
  else queued.delete(agentId)
  delete sessions[key(agentId, projectId)]
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
  bus.emit({ kind: 'system', agent: agentId, projectId, text: 'Conversation cleared', meta: { chatCleared: agentId } })
  return removed
}
