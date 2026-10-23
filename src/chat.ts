// A chat with Claude Code, run through the user's own Claude Code CLI (the one they installed and logged
// into): Agent Trace never logs in, never sees a token, never ships a CLI. The Agent SDK drives it over the
// CLI's stream-json channel — the same channel Claude Code's own VS Code extension uses — so permission
// prompts and questions come here, to be answered in the chat or on the flow.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query, type CanUseTool, type EffortLevel, type McpServerConfig, type McpServerStatus, type PermissionMode, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mcpKey } from './claude.ts'
import type { Engine } from '../shared/model.ts'
import type { Ask, ChatLine, ChatState, CliState, Decision, Effort, McpLive, McpStatus, Mode, ModelChoice, SlashCmd } from '../shared/model.ts'

// ── the user's CLI ────────────────────────────────────────────────────────

/** Where the user's `claude` is: the setting, else PATH, else where its installer puts it. */
export function findCli(configured?: string): CliState {
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  } catch {
    // not on PATH
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'))
  // On Windows `where` may list a shell shim first; the .exe is what can be spawned.
  const found = candidates.find((c) => existsSync(c) && (process.platform !== 'win32' || /\.exe$/i.test(c)))
  if (!found)
    return { problem: 'Claude Code is not installed. Install it (see code.claude.com/docs), run `claude` once in a terminal and log in with /login, then reopen Agent Trace.' }
  try {
    const version = execFileSync(found, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim().split(/\s/)[0]
    return { path: found, version }
  } catch (e) {
    return { path: found, problem: `Claude Code at ${found} did not start: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── a queue of prompts, for the SDK's streaming input ─────────────────────

class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting?: (r: IteratorResult<SDKUserMessage>) => void
  private closed = false
  push(m: SDKUserMessage) {
    if (this.waiting) {
      const w = this.waiting
      this.waiting = undefined
      w({ value: m, done: false })
    } else this.items.push(m)
  }
  close() {
    this.closed = true
    this.waiting?.({ value: undefined, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift()
        if (m) return Promise.resolve({ value: m, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((r) => (this.waiting = r))
      },
    }
  }
}

// ── one chat ──────────────────────────────────────────────────────────────

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** A tool call in a few words, for the chat line. */
function labelOf(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  return clip(s('command') || s('file_path') || s('pattern') || s('url') || s('query') || s('description') || s('skill') || s('prompt'), 90)
}

let counter = 0

const MCP_STATUSES: McpStatus[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'approval']
const mcpStatus = (s: string): McpStatus => (MCP_STATUSES.includes(s as McpStatus) ? (s as McpStatus) : 'pending')
/** While the CLI runs, how often its MCP servers are asked about: a server can drop, or finish connecting. */
const MCP_EVERY = 10_000
const MCP_SOON = 2_000

export class Chat {
  readonly engine = 'claude' as const
  readonly key = `chat-${Date.now()}-${++counter}`
  sessionId?: string
  /** Unset: the user's own default from their Claude Code settings. */
  permissionMode?: PermissionMode
  lines: ChatLine[] = []
  busy = false
  commands?: SlashCmd[]
  model?: string
  effort?: Effort
  mode?: Mode
  models?: ModelChoice[]
  mcp?: { servers: McpLive[]; at: number }
  private reconnecting = new Set<string>()
  private mcpTimer?: ReturnType<typeof setInterval>
  private mcpSoon?: ReturnType<typeof setTimeout>
  private asks = new Map<string, { ask: Ask; input: Record<string, unknown>; suggestions?: unknown; resolve: (r: PermissionResult) => void }>()
  private inbox?: Inbox
  private q?: Query
  private abort?: AbortController

  constructor(
    private readonly cwd: string,
    private readonly cli: string,
    /** Continue this session (its earlier lines come from its transcript). */
    resume: string | undefined,
    history: ChatLine[],
    private readonly changed: () => void,
    /** MCP servers of Agent Trace's own for this chat (the hand-over to Codex). */
    private readonly tools?: Record<string, McpServerConfig>,
    /** What Claude is told about where it runs (appended to Claude Code's own system prompt). */
    private readonly about?: string,
  ) {
    this.sessionId = resume
    this.lines = history
  }

  /** A turn asked for by the other agent: settled with Claude's last words once the turn ends. */
  private pending?: { resolve: (text: string) => void; reject: (e: Error) => void }

  /** Hand Claude a task and wait for its answer (the other agent delegating). */
  run(text: string, from: Engine): Promise<string> {
    if (this.busy) return Promise.reject(new Error('Claude is busy with another turn.'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.send(text, from)
    })
  }

  state(): ChatState {
    return { engine: 'claude', key: this.key, sessionId: this.sessionId, lines: this.lines.slice(-200), busy: this.busy, asks: [...this.asks.values()].map((a) => a.ask), commands: this.commands, model: this.model, effort: this.effort, mode: this.mode, models: this.models, mcp: this.mcp, reconnecting: [...this.reconnecting] }
  }

  /** The MCP servers as this Claude Code has them right now (starts the CLI if needed, sends nothing). */
  async checkMcp(quiet = false) {
    if (!this.q) this.start()
    const q = this.q!
    let list: McpServerStatus[]
    try {
      list = await q.mcpServerStatus()
    } catch (e) {
      // Asked by the user (or by Claude Code's first answer): say why it could not be told. The regular
      // checks stay quiet.
      if (!quiet) {
        this.lines.push({ kind: 'error', text: `Could not ask Claude Code about its MCP servers: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
        this.changed()
      }
      return
    }
    const servers = list.map((s) => ({ name: s.name, status: mcpStatus(s.status), error: s.error, scope: s.source ?? s.scope, tools: s.tools?.length, info: s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : undefined }))
    this.mcp = { servers, at: Date.now() }
    this.changed()
    // Servers still connecting are looked at again soon, so their outcome shows as it comes.
    clearTimeout(this.mcpSoon)
    if (servers.some((s) => s.status === 'pending')) this.mcpSoon = setTimeout(() => this.q && void this.checkMcp(true), MCP_SOON)
  }

  /** Reconnect MCP servers, as /mcp does in Claude Code, then look at them again. */
  async reconnectMcp(asked: string[]) {
    if (!this.q) this.start()
    const q = this.q!
    // The page may only know a server by its tool prefix ("plugin_x_y"): find the name Claude Code uses.
    if (!this.mcp?.servers.some((s) => s.tools !== undefined || s.error)) await this.checkMcp()
    const names = asked.map((n) => this.mcp?.servers.find((s) => s.name === n || mcpKey(s.name) === mcpKey(n))?.name ?? n)
    for (const n of names) this.reconnecting.add(n)
    this.changed()
    await Promise.all(
      names.map(async (n) => {
        try {
          await q.reconnectMcpServer(n)
        } catch (e) {
          const s = this.mcp?.servers.find((x) => x.name === n)
          if (s) Object.assign(s, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
        } finally {
          this.reconnecting.delete(n)
        }
      }),
    )
    await this.checkMcp()
    this.changed()
  }

  /**
   * The slash commands Claude Code offers here: its own, the user's and the project's, skills, plugins'.
   * Starts the CLI if it is not running yet (no message is sent), and keeps it for the first prompt.
   */
  /** The models the user's Claude Code offers (starts the CLI if needed, sends nothing). */
  async loadModels() {
    if (this.models) return
    if (!this.q) this.start()
    try {
      const list = await this.q!.supportedModels()
      this.models = list.map((m) => ({ value: m.value, name: m.displayName, description: m.description, efforts: m.supportsEffort ? (m.supportedEffortLevels as Effort[] | undefined) : undefined }))
    } catch {
      this.models = []
    }
    this.changed()
  }

  /**
   * Model, effort and permission mode, as Claude Code's own pickers set them: applied to the running CLI
   * at once, and to the next start. null goes back to the user's default.
   */
  async configure(s: { model?: string | null; effort?: Effort | null; mode?: Mode | null }) {
    if (s.model !== undefined) this.model = s.model ?? undefined
    if (s.effort !== undefined) this.effort = s.effort ?? undefined
    if (s.mode !== undefined) this.mode = s.mode ?? undefined
    this.changed()
    const q = this.q
    if (!q) return
    try {
      if (s.model !== undefined) await q.setModel(s.model ?? undefined)
      if (s.effort !== undefined) await q.applyFlagSettings({ effortLevel: s.effort as EffortLevel | null })
      if (s.mode !== undefined) await q.setPermissionMode((s.mode ?? 'default') as PermissionMode)
    } catch (e) {
      this.lines.push({ kind: 'error', text: `Could not change the setting: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
      this.changed()
    }
  }

  async loadCommands() {
    if (this.commands) return
    if (!this.q) this.start()
    try {
      const list = await this.q!.supportedCommands()
      this.commands = list
        .filter((c) => !c.name.startsWith('__'))
        .map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined, builtin: c.builtin }))
        .sort((a, b) => Number(!!a.builtin) - Number(!!b.builtin) || a.name.localeCompare(b.name))
    } catch {
      this.commands = []
    }
    this.changed()
  }

  /** Send a prompt; the CLI starts with the first one (resuming the session, if any). */
  send(text: string, from?: Engine, hidden = false) {
    if (!text.trim()) return
    // Hidden: a trace shows the user's message itself, once for both agents.
    this.lines.push({ kind: 'user', text, at: Date.now(), ...(from ? { from } : {}), ...(hidden ? { hidden } : {}) })
    this.busy = true
    if (!this.q) this.start()
    this.inbox!.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage)
    this.changed()
  }

  /** Stop the turn, as Esc does in Claude Code. */
  async stop() {
    try {
      await this.q?.interrupt()
    } catch {
      // nothing running
    }
  }

  decide(requestId: string, d: Decision) {
    const a = this.asks.get(requestId)
    if (!a) return
    this.asks.delete(requestId)
    if (d.kind === 'deny') a.resolve({ behavior: 'deny', message: d.message || 'The user said no.' })
    else if (d.kind === 'answers') a.resolve({ behavior: 'allow', updatedInput: { ...a.input, answers: d.answers } })
    else if (d.kind === 'always' && Array.isArray(a.suggestions)) a.resolve({ behavior: 'allow', updatedInput: a.input, updatedPermissions: a.suggestions as never })
    else a.resolve({ behavior: 'allow', updatedInput: a.input })
    this.changed()
  }

  dispose() {
    clearInterval(this.mcpTimer)
    clearTimeout(this.mcpSoon)
    for (const a of this.asks.values()) a.resolve({ behavior: 'deny', message: 'The chat was closed.', interrupt: true })
    this.asks.clear()
    this.inbox?.close()
    this.abort?.abort()
  }

  private start() {
    this.inbox = new Inbox()
    this.abort = new AbortController()
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: this.cwd,
        pathToClaudeCodeExecutable: this.cli,
        // The user's own setup: their settings, CLAUDE.md, agents, skills, MCP servers, plugins.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(this.about ? { append: this.about } : {}) },
        resume: this.sessionId,
        ...(this.mode ?? this.permissionMode ? { permissionMode: (this.mode ?? this.permissionMode) as PermissionMode } : {}),
        ...(this.mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort as EffortLevel } : {}),
        includePartialMessages: true,
        abortController: this.abort,
        canUseTool: this.canUseTool,
        ...(this.tools ? { mcpServers: this.tools } : {}),
      },
    })
    void this.pump(this.q)
    clearInterval(this.mcpTimer)
    this.mcpTimer = setInterval(() => this.q && void this.checkMcp(true), MCP_EVERY)
  }

  /** Claude Code asks: show it, and wait for the user's answer. */
  private canUseTool: CanUseTool = (tool, input, opts) =>
    new Promise<PermissionResult>((resolve) => {
      // Agent Trace's own tools (the hand-over to Codex) are the user's choice already: no prompt.
      if (tool.startsWith('mcp__agent_trace__')) return resolve({ behavior: 'allow', updatedInput: input })
      const requestId = `${opts.toolUseID ?? tool}-${Date.now()}`
      const at = Date.now()
      let ask: Ask
      if (tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
        ask = { kind: 'question', requestId, toolUseId: opts.toolUseID, questions: input.questions as never, at }
      } else if (tool === 'ExitPlanMode') {
        ask = { kind: 'plan', requestId, toolUseId: opts.toolUseID, plan: typeof input.plan === 'string' ? input.plan : '', at }
      } else {
        const title = opts.title ?? `Claude wants to use ${opts.displayName ?? tool}${labelOf(tool, input) ? `: ${labelOf(tool, input)}` : ''}`
        ask = { kind: 'permission', requestId, toolUseId: opts.toolUseID, tool, title, detail: opts.description ?? opts.decisionReason, canAlways: !opts.suppressAlwaysAllowRule && !!opts.suggestions?.length, at }
      }
      this.asks.set(requestId, { ask, input, suggestions: opts.suggestions, resolve })
      opts.signal.addEventListener('abort', () => {
        if (this.asks.delete(requestId)) this.changed()
      })
      this.changed()
    })

  private async pump(q: Query) {
    try {
      for await (const m of q) this.onMessage(m)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.lines.push({
        kind: 'error',
        text: /login|auth|401|credential/i.test(msg) ? `Claude Code is not logged in: run \`claude\` in a terminal and use /login. (${msg})` : msg,
        at: Date.now(),
      })
    }
    // The CLI has gone: the next prompt starts it again, resuming the session.
    clearInterval(this.mcpTimer)
    this.q = undefined
    this.inbox = undefined
    this.busy = false
    this.pending?.reject(new Error('Claude Code stopped.'))
    this.pending = undefined
    this.changed()
  }

  private onMessage(m: SDKMessage) {
    const now = Date.now()
    const last = this.lines[this.lines.length - 1]
    switch (m.type) {
      case 'system':
        if ('session_id' in m && m.session_id) this.sessionId = m.session_id
        // The servers as the CLI starts them; the full picture (errors, tools) comes from asking.
        if (m.subtype === 'init') {
          this.mcp = { servers: m.mcp_servers.map((s) => ({ name: s.name, status: mcpStatus(s.status), scope: s.source })), at: now }
          void this.checkMcp()
        }
        break
      case 'stream_event': {
        if (m.parent_tool_use_id) return // a subagent's: the flow shows it
        const ev = m.event as { type: string; delta?: { type: string; text?: string } }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          if (last?.kind === 'assistant' && last.streaming) last.text += ev.delta.text
          else this.lines.push({ kind: 'assistant', text: ev.delta.text, at: now, streaming: true })
        } else return
        break
      }
      case 'assistant': {
        if (m.parent_tool_use_id) return
        // The whole message: it replaces what was streamed of it.
        if (last?.kind === 'assistant' && last.streaming) this.lines.pop()
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text.trim()) this.lines.push({ kind: 'assistant', text: b.text, at: now })
          else if (b.type === 'tool_use') this.lines.push({ kind: 'tool', id: b.id, tool: b.name.replace(/^mcp__(.+?)__/, '$1 · '), label: labelOf(b.name, (b.input ?? {}) as Record<string, unknown>), status: 'running', at: now })
        }
        break
      }
      case 'user': {
        const content = m.message.content
        if (!Array.isArray(content)) return
        for (const b of content)
          if (b.type === 'tool_result') {
            const line = this.lines.find((l): l is Extract<ChatLine, { kind: 'tool' }> => l.kind === 'tool' && l.id === b.tool_use_id)
            if (line) line.status = b.is_error ? 'error' : 'done'
          }
        break
      }
      case 'result': {
        this.busy = false
        void this.checkMcp()
        const secs = Math.round(m.duration_ms / 1000)
        if (m.subtype === 'success') this.lines.push({ kind: 'result', text: `Done in ${secs}s`, at: now })
        else this.lines.push({ kind: 'result', text: `Stopped (${m.subtype.replace(/_/g, ' ')}) after ${secs}s`, at: now, error: true })
        const p = this.pending
        this.pending = undefined
        if (p) {
          const said = [...this.lines].reverse().find((l) => l.kind === 'assistant')
          if (m.subtype === 'success') p.resolve('result' in m && typeof m.result === 'string' && m.result ? m.result : (said?.text ?? ''))
          else p.reject(new Error(`Claude stopped (${m.subtype.replace(/_/g, ' ')}).`))
        }
        break
      }
      default:
        return
    }
    this.changed()
  }
}
