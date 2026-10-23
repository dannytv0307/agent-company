// Reads Claude Code's own session transcripts (~/.claude/projects/<folder>/<session>.jsonl) and turns
// them into the session view the webview draws. Nothing here talks to Claude Code: it only reads the
// files it writes, as they grow. The transcript format is not a public API, so every field is optional
// and anything unexpected is skipped rather than trusted.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Agent, ChatLine, FileTouch, Loaded, McpStatus, SessionSummary, SessionView, Step } from '../shared/model.ts'

/** Where Claude Code keeps its data (CLAUDE_CONFIG_DIR moves it). */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** Claude Code's folder for a workspace: the path with every non-alphanumeric character turned into "-". */
export function projectDirFor(folder: string): string | undefined {
  const root = path.join(claudeHome(), 'projects')
  if (!existsSync(root)) return undefined
  const want = folder.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
  // The drive letter's case depends on who started the session ("c:\" in VS Code, "C:\" in a terminal).
  const hit = readdirSync(root).find((d) => d.toLowerCase() === want)
  return hit ? path.join(root, hit) : undefined
}

// ── sessions open right now ───────────────────────────────────────────────

export interface Live {
  status: 'busy' | 'idle' | 'waiting' | string
  waitingFor?: string
  since: number
  /** When the Claude Code process running the session started. */
  startedAt?: number
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, not ours to signal
  }
}

/**
 * Every open Claude Code session by session id, as Claude Code reports it in ~/.claude/sessions/<pid>.json:
 * busy, idle, or waiting for the user (and for what). Files of processes that have gone are skipped.
 */
export function liveSessions(): Map<string, Live> {
  const dir = path.join(claudeHome(), 'sessions')
  const out = new Map<string, Live>()
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))
  } catch {
    return out
  }
  for (const n of names) {
    let j: any
    try {
      j = JSON.parse(readFileSync(path.join(dir, n), 'utf8'))
    } catch {
      continue
    }
    if (typeof j?.sessionId !== 'string' || typeof j.status !== 'string') continue
    if (typeof j.pid === 'number' && !alive(j.pid)) continue
    out.set(j.sessionId, {
      status: j.status,
      waitingFor: typeof j.waitingFor === 'string' ? j.waitingFor : undefined,
      since: Number(j.statusUpdatedAt) || Date.now(),
      startedAt: Number(j.startedAt) || undefined,
    })
  }
  return out
}

// ── reading files as they grow ────────────────────────────────────────────

/** Reads a JSONL file from an offset, handing out whole lines only. */
class Tail {
  offset = 0
  private carry = ''
  constructor(readonly file: string) {}

  /** Start `window` bytes before the end (skipping the cut line), or at the start for small files. */
  seekTail(window: number) {
    const size = statSync(this.file).size
    this.offset = Math.max(0, size - window)
    this.carry = ''
    return this.offset > 0
  }

  read(): string[] {
    let size: number
    try {
      size = statSync(this.file).size
    } catch {
      return []
    }
    if (size < this.offset) {
      // Rewritten from scratch (e.g. a cleared conversation): start over.
      this.offset = 0
      this.carry = ''
    }
    if (size === this.offset) return []
    const fd = openSync(this.file, 'r')
    const chunks: string[] = []
    try {
      const buf = Buffer.alloc(Math.min(8 << 20, size - this.offset))
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset)
        if (n <= 0) break
        this.offset += n
        chunks.push(buf.toString('utf8', 0, n))
      }
    } finally {
      closeSync(fd)
    }
    const text = this.carry + chunks.join('')
    const lines = text.split('\n')
    this.carry = lines.pop() ?? ''
    return lines
  }
}

// ── summaries for the session list ────────────────────────────────────────

const summaries = new Map<string, { mtime: number; title: string }>()

/** The tail of a file, for the bits of metadata Claude Code repeats as it goes (title, last prompt). */
function tailText(file: string, bytes: number): string {
  const size = statSync(file).size
  const fd = openSync(file, 'r')
  try {
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function titleOf(file: string): string {
  const text = tailText(file, 512 << 10)
  let title = ''
  let prompt = ''
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"') && !line.includes('"last-prompt"') && !line.includes('"summary"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'ai-title' && e.aiTitle) title = String(e.aiTitle)
      else if (e.type === 'summary' && e.summary) title ||= String(e.summary)
      else if (e.type === 'last-prompt' && e.lastPrompt) prompt = String(e.lastPrompt)
    } catch {
      // the cut first line, or a line still being written
    }
  }
  return title || clip(prompt, 60) || 'Untitled session'
}

/** A session counts as working while its transcript keeps moving. */
const LIVE_MS = 90_000

export function listSessions(dir: string): (SessionSummary & { file: string })[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: (SessionSummary & { file: string })[] = []
  for (const n of names) {
    const file = path.join(dir, n)
    let mtime: number
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    let s = summaries.get(file)
    if (!s || s.mtime !== mtime) {
      s = { mtime, title: titleOf(file) }
      summaries.set(file, s)
    }
    out.push({ id: n.replace(/\.jsonl$/, ''), file, title: s.title, last: mtime, status: Date.now() - mtime < LIVE_MS ? 'working' : 'idle' })
  }
  return out.sort((a, b) => b.last - a.last)
}

// ── turning transcript lines into the view ────────────────────────────────

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
const trimText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…` : s)

/** The text of a tool result or a message: a string, or blocks of text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text ?? '') : '')).join('\n')
  return ''
}

const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READS = new Set(['Read', 'NotebookRead'])
const SPAWNS = new Set(['Agent', 'Task'])

/** What a tool call is about, in a few words. */
function labelOf(tool: string, input: Record<string, unknown>, cwd?: string): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const rel = (p: string) => {
    if (!p) return ''
    const r = cwd ? path.relative(cwd, p) : p
    return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p).split(path.sep).join('/')
  }
  if (tool === 'Bash' || tool === 'PowerShell') return clip(str('command').split('\n')[0], 90)
  if (WRITES.has(tool) || READS.has(tool)) return rel(str('file_path') || str('notebook_path'))
  if (tool === 'Grep') return clip(`"${str('pattern')}"${str('path') ? ` in ${rel(str('path'))}` : ''}`, 90)
  if (tool === 'Glob') return clip(str('pattern'), 90)
  if (tool === 'WebFetch') return clip(str('url').replace(/^https?:\/\//, ''), 90)
  if (tool === 'WebSearch') return clip(str('query'), 90)
  if (SPAWNS.has(tool)) return clip(str('description') || str('prompt'), 90)
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`
  if (tool === 'Skill') return clip(str('skill') || str('command'), 90)
  const first = Object.values(input).find((v) => typeof v === 'string')
  return clip(typeof first === 'string' ? first : '', 90)
}

/** "mcp__github__create_issue" → "github · create_issue" */
const toolName = (name: string) => {
  const m = name.match(/^mcp__(.+?)__(.+)$/)
  return m ? `${m[1]} · ${m[2]}` : name
}

/** What the owner typed, from a user line — undefined when the line is not a real prompt. */
function promptOf(e: any): { prompt: string; command?: { name: string; args: string } } | undefined {
  if (e.isMeta || e.isSidechain) return undefined
  const content = e.message?.content
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return undefined
  const text = textOf(content).trim()
  if (!text) return undefined
  const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/)
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
    return { prompt: args || `/${cmd[1]}`, command: { name: cmd[1].trim(), args } }
  }
  if (/^<(local-command-|system-reminder|task-notification|bash-|user-memory)/.test(text) || text.startsWith('[Request interrupted')) return undefined
  if (text.startsWith('Caveat:')) return undefined
  return { prompt: text }
}

function newAgent(id: string, kind: Agent['kind'], type: string, title: string, start: number): Agent {
  return { id, kind, type, title, start, status: 'running', steps: [] }
}

const STEP_LIMIT = 80

/** One session: the main transcript plus its subagents' transcripts, folded into a SessionView. */
export class SessionReader {
  private main: Tail
  private subs = new Map<string, { tail: Tail; agent?: Agent; prompt?: string; pending: any[]; ignored?: boolean }>()
  private view: SessionView
  /** Every running or recent tool call, by tool_use id. */
  private steps = new Map<string, { step: Step; owner: Agent }>()
  /** Subagents by the id of the Agent call that spawned them, and by Claude Code's own agent id. */
  private byCall = new Map<string, Agent>()
  private byAgentId = new Map<string, Agent>()
  private dirty = true
  /** Claude Code notes the latest prompt as it goes: the turn's prompt when the read began after it. */
  private lastPrompt = ''
  /** Tool names Claude Code announced, for the MCP servers they belong to. */
  private tools = new Set<string>()
  /** MCP servers not connected, as the last delta that listed them said, by tool prefix. */
  private mcpWaits = new Map<string, { status: McpStatus; error?: string }>()

  constructor(
    readonly id: string,
    readonly file: string,
  ) {
    this.main = new Tail(file)
    this.view = {
      id,
      title: titleOf(file),
      status: 'idle',
      last: 0,
      turns: 0,
      main: newAgent('main', 'main', 'Claude', '', 0),
      subagents: [],
      files: [],
    }
    // Long sessions run to tens of megabytes; the current turn is near the end.
    // What Claude Code loaded is announced at the start, and the start may be before the tail read.
    if (this.main.seekTail(24 << 20)) for (const line of headLines(file, Math.min(6 << 20, this.main.offset))) if (line.includes('"type":"attachment"')) this.ingest([line], undefined)
    this.ingest(this.main.read(), undefined)
    this.pollSubagents()
  }

  /** Read whatever was written since last time. True when the view changed. */
  poll(): boolean {
    const lines = this.main.read()
    if (lines.length) this.ingest(lines, undefined)
    this.pollSubagents()
    const changed = this.dirty
    this.dirty = false
    return changed
  }

  /**
   * The view as of now. `processStart`: when the Claude Code process now running the session started —
   * a subagent still "running" but quiet since before then belonged to a process that has ended, and
   * will never report back.
   */
  snapshot(now = Date.now(), processStart?: number): SessionView {
    const v = this.view
    const working = !!v.turn && !v.turn.end && now - v.last < 10 * 60_000
    const subagents = v.subagents.map((a) =>
      processStart && a.status === 'running' && (a.last ?? a.start) < processStart - 2000
        ? { ...a, status: 'error' as const, end: a.last ?? a.start, output: a.output ?? 'Stopped: the Claude Code process that ran it has ended, so it never finished.' }
        : a,
    )
    return { ...v, status: working ? 'working' : 'idle', main: { ...v.main, steps: v.main.steps.slice(-STEP_LIMIT) }, subagents }
  }

  // Newer Claude Code versions write each subagent to <session>/subagents/*.jsonl.
  private pollSubagents() {
    const dir = path.join(path.dirname(this.file), this.id, 'subagents')
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return
    }
    for (const n of names) {
      const file = path.join(dir, n)
      let sub = this.subs.get(file)
      if (!sub) {
        sub = { tail: new Tail(file), pending: [] }
        this.subs.set(file, sub)
      }
      if (sub.ignored) continue
      // Beside each transcript, a .meta.json names the Agent call that spawned it.
      const meta = !sub.agent || sub.agent.status === 'running' ? readMeta(file) : undefined
      if (!sub.agent && meta?.toolUseId) sub.agent = this.byCall.get(meta.toolUseId)
      const lines = sub.tail.read()
      for (const line of lines) {
        const e = parse(line)
        if (!e) continue
        // Its first message is the prompt it was given: that too names the Agent call.
        if (!sub.prompt && e.type === 'user') sub.prompt = textOf(e.message?.content).trim()
        if (!sub.agent) sub.agent = this.findSub(e.agentId, sub.prompt, n)
        if (sub.agent) this.apply(e, sub.agent)
        else sub.pending.push(e)
      }
      if (!sub.agent) {
        // A subagent of an earlier turn, spawned before the part of the transcript read: not ours to show.
        if (meta?.finished || sub.pending.length > 5000) {
          sub.ignored = true
          sub.pending = []
        }
        continue
      }
      for (const e of sub.pending) this.apply(e, sub.agent)
      sub.pending = []
      if (meta?.finished && sub.agent.status === 'running') {
        sub.agent.status = 'done'
        sub.agent.end = sub.agent.last ?? Date.now()
        this.dirty = true
      }
    }
  }

  private findSub(agentId: string | undefined, prompt: string | undefined, fileName: string): Agent | undefined {
    if (agentId && this.byAgentId.has(agentId)) return this.byAgentId.get(agentId)
    for (const [id, a] of this.byAgentId) if (fileName.includes(id)) return a
    if (prompt) return this.view.subagents.find((a) => a.prompt?.trim() === prompt) ?? [...this.byCall.values()].find((a) => a.prompt?.trim() === prompt)
    return undefined
  }

  private ingest(lines: string[], owner: Agent | undefined) {
    for (const line of lines) {
      const e = parse(line)
      if (e) this.apply(e, owner)
    }
  }

  /** Fold one transcript line into the view. `owner`: the subagent whose own transcript this is. */
  private apply(e: any, owner: Agent | undefined) {
    const v = this.view
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN
    if (!owner) {
      if (Number.isFinite(ts)) v.last = Math.max(v.last, ts)
      if (e.gitBranch) v.branch = e.gitBranch
      if (e.cwd) v.cwd = e.cwd
      if (e.version) v.version = e.version
    }
    const at = Number.isFinite(ts) ? ts : v.last
    if (owner && Number.isFinite(ts)) owner.last = Math.max(owner.last ?? 0, ts)

    switch (e.type) {
      case 'ai-title':
        if (e.aiTitle) v.title = String(e.aiTitle)
        this.dirty = true
        return
      case 'last-prompt':
        if (e.lastPrompt) this.lastPrompt = String(e.lastPrompt)
        return
      case 'summary':
        if (e.summary && v.title === 'Untitled session') v.title = String(e.summary)
        return
      case 'cost-state':
        if (typeof e.totalLinesAdded === 'number') v.linesAdded = e.totalLinesAdded
        if (typeof e.totalLinesRemoved === 'number') v.linesRemoved = e.totalLinesRemoved
        if (typeof e.startTime === 'number') v.start = e.startTime
        this.dirty = true
        return
      case 'user':
        this.onUser(e, owner, at)
        return
      case 'assistant':
        this.onAssistant(e, owner, at)
        return
      case 'attachment':
        if (owner) return
        // Background subagents report back as a queued command.
        if (e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string') this.onTaskNotification(e.attachment.prompt, at)
        else this.onListing(e.attachment)
        return
      case 'queue-operation':
        // …queued the moment they finish.
        if (!owner && e.operation === 'enqueue' && typeof e.content === 'string') this.onTaskNotification(e.content, at)
        return
    }
  }

  /** A background subagent reporting back: <task-notification> with its call, status and result. True if it was one. */
  private onTaskNotification(text: string, at: number): boolean {
    const note = text.match(/<task-notification>[\s\S]*?<\/task-notification>/)?.[0]
    if (!note) return false
    const call = note.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
    const sub = call ? this.byCall.get(call.trim()) : undefined
    if (sub && sub.status === 'running') {
      const failed = /<status>(failed|error|killed|stopped)/i.test(note)
      sub.end = at
      sub.status = failed ? 'error' : 'done'
      sub.output = trimText((note.match(/<result>([\s\S]*?)<\/result>/)?.[1] ?? note.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').trim(), 8000)
      this.dirty = true
    }
    return true
  }

  /**
   * Claude Code's own listings of what it loaded: skills, agents, MCP tools and servers, instruction
   * files. Initial ones at the start of a session, deltas as things change.
   */
  private onListing(a: any) {
    if (!a || typeof a !== 'object') return
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : [])
    const L: Loaded = (this.view.loaded ??= { skills: [], agents: [], builtinAgents: [], mcp: [], instructions: [] })
    switch (a.type) {
      case 'skill_listing':
        if (Array.isArray(a.names)) L.skills = strings(a.names)
        break
      case 'agent_listing_delta': {
        const types = new Set(a.isInitial ? [] : L.agents)
        for (const t of strings(a.addedTypes)) types.add(t)
        for (const t of strings(a.removedTypes)) types.delete(t)
        L.agents = [...types]
        if (Array.isArray(a.builtInTypes)) L.builtinAgents = strings(a.builtInTypes)
        break
      }
      case 'deferred_tools_delta': {
        const added = [...strings(a.addedNames), ...strings(a.readdedNames)]
        for (const t of added) this.tools.add(t)
        for (const t of strings(a.removedNames)) this.tools.delete(t)
        const serverOf = (t: string) => t.match(/^mcp__(.+?)__/)?.[1]
        // Servers not connected come as whole lists, but only in the deltas that carry them: a delta
        // without them (tools of a skill, say) leaves them as they were. A server whose tools come back
        // has connected since.
        if (['pendingMcpServers', 'needsAuthMcpServers', 'failedMcpServers'].some((k) => k in a)) {
          this.mcpWaits.clear()
          for (const n of strings(a.pendingMcpServers)) this.mcpWaits.set(mcpKey(n), { status: 'pending' })
          for (const n of strings(a.needsAuthMcpServers)) this.mcpWaits.set(mcpKey(n), { status: 'needs-auth' })
          for (const f of Array.isArray(a.failedMcpServers) ? a.failedMcpServers : [])
            if (f && typeof f.name === 'string') this.mcpWaits.set(mcpKey(f.name), { status: 'failed', error: typeof f.error === 'string' ? f.error : undefined })
        } else for (const t of added) this.mcpWaits.delete(serverOf(t) ?? '')
        const status = new Map<string, { status: McpStatus; error?: string }>()
        for (const t of this.tools) {
          const server = serverOf(t)
          if (server) status.set(server, { status: 'connected' })
        }
        for (const [n, s] of this.mcpWaits) status.set(n, s)
        L.mcp = [...status].map(([name, s]) => ({ name, ...s }))
        break
      }
      case 'instructions':
        for (const f of Array.isArray(a.files) ? a.files : [])
          if (f && typeof f.path === 'string' && !L.instructions.some((x) => x.path === f.path)) L.instructions.push({ path: f.path, type: String(f.type ?? '') })
        break
      default:
        return
    }
    this.dirty = true
  }

  /** Lines of older Claude Code versions, where subagents write into the main transcript. */
  private sidechainOwner(e: any): Agent | undefined {
    if (e.agentId && this.byAgentId.has(e.agentId)) return this.byAgentId.get(e.agentId)
    if (e.type === 'user') {
      const text = textOf(e.message?.content).trim()
      const hit = this.view.subagents.find((a) => a.status === 'running' && a.prompt?.trim() === text)
      if (hit) {
        if (e.agentId) this.byAgentId.set(e.agentId, hit)
        return hit
      }
    }
    return [...this.view.subagents].reverse().find((a) => a.status === 'running')
  }

  private onUser(e: any, owner: Agent | undefined, at: number) {
    const v = this.view
    if (!owner && e.isSidechain) owner = this.sidechainOwner(e)
    const content = e.message?.content

    // Tool results: a step finishes (or a subagent, when the step spawned one).
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue
        const hit = this.steps.get(b.tool_use_id)
        const text = textOf(b.content)
        if (hit) {
          hit.step.end = at
          hit.step.status = b.is_error ? 'error' : 'done'
          hit.step.output = trimText(text, 6000)
          this.steps.delete(b.tool_use_id)
        }
        const sub = this.byCall.get(b.tool_use_id)
        if (sub) {
          const result = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : {}
          const agentId = result.agentId ?? text.match(/agentId:\s*([\w-]+)/)?.[1]
          if (agentId) this.byAgentId.set(String(agentId), sub)
          if (/^\s*Async agent launched/i.test(text) || result.status === 'async_launched') sub.background = true
          else {
            sub.end = at
            sub.status = b.is_error || /^(failed|error|killed)/i.test(String(result.status ?? '')) ? 'error' : 'done'
            // A report handed back as a message stays out of the tool result; the result keeps a copy.
            const report = typeof result.handbackReport?.text === 'string' ? result.handbackReport.text : text
            sub.output = trimText(report.replace(/\n*agentId:[\s\S]*$/, '').trim(), 8000)
          }
        }
        this.dirty = true
      }
      if (content.some((b: any) => b?.type === 'tool_result')) return
    }
    if (owner) return

    // A background subagent reporting back to the main agent (older versions: as a user message).
    const text = textOf(content)
    if (this.onTaskNotification(text, at)) return

    // Stopped with Esc: the turn ends where it was.
    if (text.trim().startsWith('[Request interrupted') && v.turn && !v.turn.end) {
      v.turn.end = at
      v.main.end = at
      v.main.status = 'error'
      v.main.output = 'Interrupted by you.'
      for (const s of v.main.steps) if (s.status === 'running') Object.assign(s, { status: 'error', end: at })
      this.dirty = true
      return
    }

    const p = promptOf(e)
    if (!p) return
    // A new turn: the canvas starts over. Only subagents still at work stay (marked earlier); finished
    // ones, and the reports they gave, belong to the turn that is over.
    v.turn = { prompt: p.prompt, command: p.command, start: at }
    v.turns++
    v.main = { ...newAgent('main', 'main', 'Claude', p.prompt, at), model: v.main.model, prompt: p.prompt }
    v.subagents = v.subagents.filter((a) => a.status === 'running')
    for (const a of v.subagents) a.earlier = true
    v.files = []
    for (const [id, s] of this.steps) if (s.owner.kind === 'main') this.steps.delete(id)
    this.dirty = true
  }

  private onAssistant(e: any, owner: Agent | undefined, at: number) {
    const v = this.view
    if (!owner && e.isSidechain) owner = this.sidechainOwner(e)
    // Reading began in the middle of a turn: open it with the prompt Claude Code last noted.
    if (!owner && !v.turn) {
      v.turn = { prompt: this.lastPrompt || '(an earlier prompt)', start: at }
      v.turns++
      v.main.title = v.turn.prompt
      v.main.start = at
    }
    const agent = owner ?? v.main
    const msg = e.message ?? {}
    if (msg.model && msg.model !== '<synthetic>') agent.model = msg.model
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        agent.said = trimText(b.text.trim(), 4000)
        this.dirty = true
      } else if (b?.type === 'tool_use' && b.id && b.name) {
        const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
        const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
        const step: Step = {
          id: b.id,
          tool: toolName(String(b.name)),
          label: labelOf(String(b.name), input, v.cwd),
          input: trimText(JSON.stringify(input, null, 2), 4000),
          start: at,
          status: 'running',
          ...(file ? { file: path.isAbsolute(file) || !v.cwd ? file : path.join(v.cwd, file), writes: WRITES.has(String(b.name)) } : {}),
        }
        agent.steps.push(step)
        if (agent.steps.length > STEP_LIMIT * 2) agent.steps.splice(0, agent.steps.length - STEP_LIMIT)
        this.steps.set(b.id, { step, owner: agent })
        if (step.file) this.touch(step.file, agent, !!step.writes, at)
        if (SPAWNS.has(String(b.name))) {
          const sub = newAgent(b.id, 'sub', String(input.subagent_type || 'general-purpose'), String(input.description ?? ''), at)
          sub.prompt = typeof input.prompt === 'string' ? input.prompt : undefined
          sub.background = input.run_in_background === true
          v.subagents.push(sub)
          this.byCall.set(b.id, sub)
        }
        this.dirty = true
      }
    }
    // The main agent finished its reply: the turn is over.
    if (!owner && msg.stop_reason === 'end_turn' && v.turn) {
      v.turn.end = at
      v.main.end = at
      v.main.status = 'done'
      v.main.output = v.main.said
      this.dirty = true
    }
  }

  private touch(file: string, agent: Agent, writes: boolean, at: number) {
    const v = this.view
    let f = v.files.find((x) => x.path === file)
    if (!f) {
      f = { path: file, by: [], writes: 0, reads: 0, last: at } satisfies FileTouch
      v.files.push(f)
    }
    if (writes) {
      f.writes++
      if (!f.by.includes(agent.id)) f.by.push(agent.id)
    } else f.reads++
    f.last = at
  }
}

/** An MCP server's name as its tools carry it: "plugin:playwright:playwright" → "plugin_playwright_playwright". */
export const mcpKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** The whole lines in the first `bytes` of a file. */
function headLines(file: string, bytes: number): string[] {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    const lines = buf.toString('utf8', 0, n).split('\n')
    lines.pop() // cut
    return lines
  } finally {
    closeSync(fd)
  }
}

/** <name>.meta.json beside a subagent transcript: { toolUseId, agentType, description, finished }. */
function readMeta(file: string): { toolUseId?: string; finished?: boolean } | undefined {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
  } catch {
    return undefined
  }
}

function parse(line: string): any {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A session's conversation so far, for a chat that continues it: the prompts and Claude's replies. */
export function readHistory(file: string, limit = 60): ChatLine[] {
  const out: ChatLine[] = []
  let text: string
  try {
    text = tailText(file, 6 << 20)
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const e = parse(line)
    if (!e || e.isSidechain) continue
    const at = e.timestamp ? Date.parse(e.timestamp) : 0
    if (e.type === 'user') {
      const p = promptOf(e)
      if (p) out.push({ kind: 'user', text: p.command ? `/${p.command.name} ${p.command.args}`.trim() : p.prompt, at })
    } else if (e.type === 'assistant') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : [])
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'assistant', text: b.text, at })
    }
  }
  return out.slice(-limit)
}

