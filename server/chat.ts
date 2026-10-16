// 1:1 chat between the owner and any agent.
// Routing: CEO mid-run → injected live; busy member → inbox (read via check_messages);
// idle agent → a direct session resumed per agent, so each conversation keeps its context.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentRef, ChatMessage, OrgDef, ProjectRef } from '../shared/types.ts'
import { bus, tagRun } from './events.ts'
import { DATA_DIR, findAgentIn, loadOrg } from './org.ts'
import { ceoPrompt, compileOrg, MCP_SERVER, writeCompiled } from './compile.ts'
import { isBusy } from './assignments.ts'
import { runClaudeDirect } from './runners/claude.ts'
import { repoContext, runCodexAgent } from './runners/codex.ts'
import { expandCommand, parseSlash } from './commands.ts'
import { startWork } from './work.ts'
import type { ChildProcess } from 'node:child_process'

const CHAT_DIR = path.join(DATA_DIR, 'chats')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
mkdirSync(CHAT_DIR, { recursive: true })

const threads = new Map<string, ChatMessage[]>()
// Direct sessions are per agent *and* project ("mei@main"): a session only resumes in the folder it ran in.
const sessions: Record<string, string> = existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) : {}
const key = (agentId: string, projectId: string) => `${agentId}@${projectId}`

// Which version of the app's tools each session started with. A session keeps the tool schemas it
// first saw, so after the app's tools change (new parameters, new tools) an old session would insist
// they do not exist: such sessions start fresh, with a recap of the conversation.
const TOOLS_FILE = path.join(DATA_DIR, 'session-tools.json')
const TOOLS_VERSION = createHash('sha1').update(readFileSync(MCP_SERVER, 'utf8')).digest('hex').slice(0, 12)
const sessionTools: Record<string, string> = existsSync(TOOLS_FILE) ? JSON.parse(readFileSync(TOOLS_FILE, 'utf8')) : {}
/** The session to resume for agent@project, unless it predates the current tools. */
const resumable = (k: string) => (sessions[k] && sessionTools[k] === TOOLS_VERSION ? sessions[k] : undefined)

/** The last part of the owner's conversation with an agent in a project, for a session that starts over. */
function recap(agentId: string, projectId: string): string {
  const recent = thread(agentId)
    .filter((m) => m.projectId === projectId && m.role !== 'note')
    .slice(-13, -1) // the newest message is the one being sent now
  if (!recent.length) return ''
  const lines = recent.map((m) => `${m.role === 'owner' ? 'Owner' : 'You'}: ${m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text}`)
  return `[Your earlier conversation with the owner in this project, for context. The app's tools were updated since then: rely on the tools and instructions you have now, not on what was said about them earlier.]\n${lines.join('\n\n')}\n[End of earlier conversation]`
}
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

export function addMessage(
  agentId: string,
  role: ChatMessage['role'],
  text: string,
  projectId?: string,
  extra: { ask?: boolean; checkpointId?: string; proposalId?: string } = {},
): ChatMessage {
  const m: ChatMessage = {
    id: randomUUID(),
    ts: Date.now(),
    agentId,
    role,
    text,
    ...(projectId ? { projectId } : {}),
    ...(extra.ask ? { ask: true } : {}),
    ...(extra.checkpointId ? { checkpointId: extra.checkpointId } : {}),
    ...(extra.proposalId ? { proposalId: extra.proposalId } : {}),
  }
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
    for (const x of t) if (x.ask && !x.checkpointId && x.ts > lastOwner) out.push({ agentId: id, projectId: x.projectId, text: x.text, ts: x.ts })
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
  // A slash command must be the whole message for Claude Code to run it; Codex gets the command expanded.
  if (parseSlash(text)) {
    if (a.runtime !== 'codex') return text
    const expanded = expandCommand(project.dir, text)
    if (expanded) return expanded
  }
  return [
    `[Direct message from the owner, ${org.owner.name.en}, about the project "${project.name}" (the current folder). Reply in ${org.owner.preferences?.reportLanguage ?? 'the language the owner writes in'}, conversationally and concisely. If they ask you to do work, do it in this folder, then summarise what changed.]`,
    ...(resumable(key(a.id, project.id)) ? [] : [recentWork(a.id), sessions[key(a.id, project.id)] ? recap(a.id, project.id) : '']),
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

/**
 * Continue an agent's 1:1 session with a message that is not the owner typing (e.g. their answer to
 * a check-in, already shown in the chat). Waits its turn if the agent is still replying.
 */
export async function continueDirect(agentId: string, text: string, project: ProjectRef): Promise<void> {
  const org = await loadOrg()
  const a = findAgentIn(org, agentId, project)
  if (!a) throw new Error(`Unknown agent "${agentId}"`)
  if (replying.has(agentId)) queued.set(agentId, [...(queued.get(agentId) ?? []), { text, project }])
  else startDirect(org, a, text, project)
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
  const job = startWork({ id: runId, kind: 'chat', projectId: project.id, agentId, engine: a.runtime === 'codex' ? 'codex' : 'claude', title: text.split('\n')[0].slice(0, 120), runId, aid: runId })
  let child: ChildProcess | undefined
  job.attach(() => child)
  void (async () => {
    try {
      await writeCompiled(project.dir, compileOrg(org, project))
      const prompt = directPrompt(org, a, project, text)
      let reply: string
      if (a.runtime === 'codex') {
        // A Codex CEO gets its full brief (team, plan tools) on a fresh thread, like a company run.
        const intro = a.isCeo ? `${ceoPrompt(org, a, project)}${repoContext(project.dir)}` : undefined
        reply = await runCodexAgent(org, a, org.owner.id, prompt, runId, { dir: project.dir, aid: runId, raw: true, intro, resume: resumable(k), onThread: (id) => saveSession(k, id), onChild: (c) => (child = c) })
      } else {
        reply = await runClaudeDirect(org, a, prompt, { runId, project, resume: resumable(k), onSession: (id) => saveSession(k, id), onChild: (c) => (child = c) })
      }
      addMessage(agentId, 'agent', reply.trim() || '(no reply)', project.id)
    } catch (e) {
      note(job.stopped ? `Stopped — ${a.name.en} did not finish this reply.` : `Could not reach ${a.name.en}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      job.end()
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
  sessionTools[k] = TOOLS_VERSION
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
  writeFileSync(TOOLS_FILE, JSON.stringify(sessionTools, null, 2))
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
