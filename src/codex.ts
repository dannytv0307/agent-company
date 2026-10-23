// Codex, the user's own Codex CLI (installed and signed in by them), driven through its app-server: the
// JSON-RPC channel Codex's own VS Code extension uses. Agent Trace never signs in and ships no Codex.
// From it come the chat (threads, turns, approvals), the flow (each turn's items, drawn as a session),
// and the Codex factory: the setup as Codex itself loaded it for this folder — AGENTS.md, skills, MCP
// servers, plugins, hooks and its config layers.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Agent, Ask, ChatLine, Engine, ChatState, CliState, Decision, Effort, FileTouch, McpLive, McpStatus, Mode, ModelChoice, SessionSummary, SessionView, Setup, SetupItem, SetupScope, SlashCmd, Step } from '../shared/model.ts'

// ── the user's Codex ──────────────────────────────────────────────────────

/** The native binary behind npm's `codex` shim, which can be spawned without a shell. */
function nativeBehind(shim: string): string | undefined {
  const pkg = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex')
  if (!existsSync(pkg)) return undefined
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const look = (dir: string, depth: number): string | undefined => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return undefined
    }
    if (names.includes('bin') && existsSync(path.join(dir, 'bin', exe)) && dir.includes('vendor')) return path.join(dir, 'bin', exe)
    if (depth === 0) return undefined
    for (const n of names) {
      if (n === '.bin' || n === 'bin') continue
      const hit = look(path.join(dir, n), depth - 1)
      if (hit) return hit
    }
    return undefined
  }
  return look(path.join(pkg, 'node_modules'), 5) ?? look(path.join(pkg, 'vendor'), 2)
}

/** Where the user's `codex` is: the setting, else PATH; on Windows npm's shim is followed to its binary. */
export function findCodex(configured?: string): CliState {
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    candidates.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  } catch {
    // not on PATH
  }
  let found: string | undefined
  for (const c of candidates) {
    if (!existsSync(c)) continue
    if (process.platform !== 'win32' || /\.exe$/i.test(c)) {
      found = c
      break
    }
    const native = nativeBehind(c)
    if (native) {
      found = native
      break
    }
  }
  if (!found) return { problem: 'Codex is not installed. Install it (npm install -g @openai/codex), run `codex` once in a terminal and sign in, then reopen Agent Trace.' }
  try {
    const version = execFileSync(found, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim().split(/\s/).pop()
    return { path: found, version }
  } catch (e) {
    return { path: found, problem: `Codex at ${found} did not start: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── the app-server: one per folder, shared by its chats ────────────────────

type Json = any
type Handler = (method: string, params: Json, id?: number | string) => void

/** `codex app-server`: requests out, answers and notifications in, and requests from Codex (approvals). */
export class CodexServer {
  private proc?: ChildProcess
  private buf = ''
  private next = 0
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private ready?: Promise<void>
  /** Who wants to hear what Codex says: each chat, and the extension (for the setup). */
  readonly listeners = new Set<Handler>()
  /** The last reason it stopped, for the chat to show. */
  failure?: string

  constructor(
    private readonly bin: string,
    private readonly cwd: string,
  ) {}

  get running() {
    return !!this.proc && this.proc.exitCode === null
  }

  /** Started on first use; again after it has stopped. */
  start(): Promise<void> {
    if (this.running && this.ready) return this.ready
    const pkg = this.bin.match(/^(.*[\\/]node_modules[\\/]@openai[\\/]codex)[\\/]/)?.[1]
    const p = spawn(this.bin, ['app-server'], {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, ...(pkg ? { CODEX_MANAGED_PACKAGE_ROOT: pkg, CODEX_MANAGED_BY_NPM: '1' } : {}) },
    })
    this.proc = p
    this.buf = ''
    p.stdout!.setEncoding('utf8')
    p.stdout!.on('data', (d: string) => this.read(d))
    let err = ''
    p.stderr!.setEncoding('utf8')
    p.stderr!.on('data', (d: string) => (err = (err + d).slice(-2000)))
    p.on('exit', (code) => {
      this.failure = code ? `Codex stopped (exit ${code}). ${err.trim().split('\n').pop() ?? ''}`.trim() : undefined
      for (const w of this.waiting.values()) w.reject(new Error(this.failure ?? 'Codex stopped.'))
      this.waiting.clear()
      this.ready = undefined
      for (const l of this.listeners) l('agentTrace/exited', { error: this.failure })
    })
    p.on('error', (e) => (this.failure = e.message))
    this.ready = this.call('initialize', { clientInfo: { name: 'agent_trace', title: 'Agent Trace', version: '0.4.0' }, capabilities: { experimentalApi: true } }, true).then(() => this.notify('initialized'))
    return this.ready
  }

  stop() {
    this.proc?.kill()
    this.proc = undefined
    this.ready = undefined
  }

  /** A request; it waits for the server to be up (except initialize itself). */
  async call<T = Json>(method: string, params: Json, raw = false): Promise<T> {
    if (!raw) await this.start()
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next
      this.waiting.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: Json) {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** The answer to one of Codex's own requests (an approval, a question). */
  answer(id: number | string, result: Json) {
    this.write({ id, result })
  }

  private write(m: Json) {
    this.proc?.stdin?.write(`${JSON.stringify(m)}\n`)
  }

  private read(d: string) {
    this.buf += d
    let n: number
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n).trim()
      this.buf = this.buf.slice(n + 1)
      if (!line) continue
      let m: Json
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (m.id !== undefined && !m.method) {
        const w = this.waiting.get(m.id)
        this.waiting.delete(m.id)
        if (m.error) w?.reject(new Error(m.error.message ?? JSON.stringify(m.error)))
        else w?.resolve(m.result)
      } else if (m.method) for (const l of this.listeners) l(m.method, m.params ?? {}, m.id)
    }
  }
}

// ── the folder's Codex threads ────────────────────────────────────────────

export interface CodexThread extends SessionSummary {
  /** Codex says it is at work (in this app-server or another). */
  active: boolean
}

/** Threads of this folder, most recent first. */
export async function listThreads(server: CodexServer, cwd: string): Promise<CodexThread[]> {
  const r = await server.call('thread/list', { cwd, limit: 40, sortKey: 'updated_at' }).catch(() => server.call('thread/list', { cwd, limit: 40 }))
  return (r?.data ?? []).map((t: Json) => ({
    id: t.id,
    engine: 'codex',
    title: clip(t.name || t.preview || 'Codex thread', 80),
    last: (t.updatedAt ?? 0) * 1000,
    status: t.status?.type === 'active' ? 'working' : 'idle',
    waiting: (t.status?.activeFlags ?? []).some((f: string) => /approval|input/i.test(f)),
    active: t.status?.type === 'active',
  }))
}

// ── the Codex factory ─────────────────────────────────────────────────────

const SKILL_SCOPE: Record<string, SetupScope> = { user: 'user', repo: 'project', system: 'builtin', admin: 'session' }

/** Where a config layer comes from, as Agent Trace's scopes say it. */
function layerScope(name: Json): SetupScope {
  switch (name?.type) {
    case 'user':
      return 'user'
    case 'project':
      return 'project'
    case 'system':
    case 'mdm':
    case 'managedConfig':
      return 'session'
    default:
      return 'builtin'
  }
}

/** Instruction files: AGENTS.md (or its override) in ~/.codex and from the repo root down to the folder. */
function agentsFiles(cwd: string): SetupItem[] {
  const out: SetupItem[] = []
  const pick = (dir: string) => ['AGENTS.override.md', 'AGENTS.md'].map((n) => path.join(dir, n)).find((f) => existsSync(f))
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const user = pick(home)
  if (user) out.push({ kind: 'memory', name: `~/.codex/${path.basename(user)}`, scope: 'user', path: user, loaded: true })
  // From the repo root (where .git is) down to the folder; without git, the folder alone.
  const chain: string[] = []
  for (let d = cwd; ; d = path.dirname(d)) {
    chain.unshift(d)
    if (existsSync(path.join(d, '.git')) || path.dirname(d) === d) break
  }
  if (!existsSync(path.join(chain[0], '.git'))) chain.splice(0, chain.length - 1)
  for (const d of chain) {
    const f = pick(d)
    if (f) out.push({ kind: 'memory', name: path.relative(path.dirname(cwd), f).split(path.sep).join('/') || path.basename(f), scope: 'project', path: f, loaded: true })
  }
  return out
}

const MCP_FROM: Record<string, McpStatus> = {
  connected: 'connected',
  starting: 'pending',
  notStarted: 'pending',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
}

/** An MCP server's status as Codex reports it, in Agent Trace's words. */
export function mcpLive(s: Json): McpLive {
  const tools = Object.keys(s.tools ?? {}).length
  let status: McpStatus = s.runtimeStatus ? (MCP_FROM[s.runtimeStatus] ?? 'pending') : s.toolsError ? 'failed' : s.authStatus === 'notLoggedIn' ? 'needs-auth' : 'connected'
  if (status === 'connected' && s.toolsError) status = 'failed'
  return { name: s.name, status, error: s.toolsError ?? undefined, scope: s.pluginId ? 'plugin' : undefined, tools: status === 'connected' ? tools : undefined, info: s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : undefined }
}

/** The setup as Codex loaded it for this folder: what the app-server reports, and AGENTS.md from the files. */
export async function codexSetup(server: CodexServer, cwd: string): Promise<Setup> {
  const items: SetupItem[] = [...agentsFiles(cwd)]
  const [skills, hooks, mcp, plugins, config] = await Promise.all([
    server.call('skills/list', { cwds: [cwd] }).catch(() => undefined),
    server.call('hooks/list', { cwds: [cwd] }).catch(() => undefined),
    server.call('mcpServerStatus/list', {}).catch(() => undefined),
    server.call('plugin/installed', { cwds: [cwd] }).catch(() => undefined),
    server.call('config/read', { includeLayers: true, cwd }).catch(() => undefined),
  ])

  for (const s of skills?.data?.[0]?.skills ?? []) {
    const plugin = s.pluginId ? String(s.pluginId).split('@')[0] : undefined
    items.push({
      kind: 'skill',
      name: s.name,
      scope: plugin ? 'plugin' : (SKILL_SCOPE[s.scope] ?? 'session'),
      plugin,
      description: clip(s.shortDescription || s.description || '', 240),
      path: s.path,
      loaded: s.enabled !== false,
      ...(s.enabled === false ? { unloaded: 'Turned off in your Codex config (skills).' } : {}),
    })
  }
  for (const e of skills?.data?.[0]?.errors ?? []) items.push({ kind: 'skill', name: path.basename(path.dirname(String(e.path ?? 'skill'))), scope: 'project', path: e.path, unloaded: `Codex could not load it: ${e.message ?? 'invalid SKILL.md'}` })

  for (const h of hooks?.data?.[0]?.hooks ?? []) {
    const what = h.handlerType === 'command' ? h.command : h.handlerType === 'mcpTool' ? `${h.server} · ${h.tool}` : h.handlerType
    items.push({
      kind: 'hook',
      name: `${h.eventName}${h.matcher ? ` (${h.matcher})` : ''}`,
      scope: h.pluginId ? 'plugin' : h.isManaged ? 'session' : layerScopeOfPath(h.sourcePath, cwd),
      plugin: h.pluginId ? String(h.pluginId).split('@')[0] : undefined,
      path: h.sourcePath,
      facts: [clip(String(what ?? ''), 80)],
      ...(h.enabled === false ? { unloaded: 'Turned off.' } : h.trustStatus && !/trusted|approved/i.test(String(h.trustStatus)) ? { unloaded: `Not trusted yet (${h.trustStatus}): Codex asks before running it.` } : {}),
    })
  }

  // MCP servers: where each is configured (config origins), and how its connection is going.
  const origins = config?.origins ?? {}
  const configured = config?.config?.mcp_servers ?? {}
  const seen = new Set<string>()
  for (const s of mcp?.data ?? []) {
    seen.add(s.name)
    const live = mcpLive(s)
    const origin = Object.entries(origins).find(([k]) => k.startsWith(`mcp_servers.${s.name}.`))?.[1] as Json
    const plugin = s.pluginId ? String(s.pluginId).split('@')[0] : undefined
    items.push({
      kind: 'mcp',
      name: s.name,
      scope: plugin ? 'plugin' : origin ? layerScope(origin.name) : 'connector',
      plugin,
      path: origin?.name?.file,
      status: live.status,
      error: live.error,
      server: s.name,
      tools: live.tools,
      loaded: live.status === 'connected',
      description: origin ? undefined : plugin ? `From the plugin “${plugin}”.` : 'Built into Codex, or connected through your ChatGPT account (apps).',
      facts: s.httpOrigin ? [`http · ${String(s.httpOrigin).replace(/^https?:\/\//, '')}`] : undefined,
    })
  }
  for (const [name, cfg] of Object.entries(configured) as [string, Json][]) {
    if (seen.has(name)) continue
    const origin = Object.entries(origins).find(([k]) => k.startsWith(`mcp_servers.${name}.`))?.[1] as Json
    items.push({ kind: 'mcp', name, scope: origin ? layerScope(origin.name) : 'user', path: origin?.name?.file, status: cfg?.enabled === false ? 'disabled' : 'pending', server: name, error: cfg?.enabled === false ? 'Turned off in the config (enabled = false).' : undefined })
  }

  for (const m of plugins?.marketplaces ?? [])
    for (const p of m.plugins ?? []) {
      if (!p.installed) continue
      items.push({
        kind: 'plugin',
        name: p.interface?.displayName || p.name,
        scope: 'user',
        description: clip(p.interface?.shortDescription ?? '', 200),
        facts: [m.interface?.displayName || m.name].filter(Boolean),
        loaded: p.enabled !== false,
        ...(p.enabled === false ? { unloaded: p.disabledReason ? `Turned off: ${p.disabledReason}` : 'Installed, but turned off.' } : {}),
      })
    }

  // Config layers: the files that make up Codex's settings here, most specific first.
  for (const l of config?.layers ?? []) {
    const keys = Object.keys(l.config ?? {})
    const file = l.name?.file
    if (!file) continue
    const scope = layerScope(l.name)
    const c = l.config ?? {}
    items.push({
      kind: 'settings',
      name: scope === 'project' ? 'Project config' : scope === 'user' ? 'User config' : 'Managed config',
      scope,
      path: file,
      facts: [
        typeof c.model === 'string' && `model: ${c.model}`,
        typeof c.model_reasoning_effort === 'string' && `effort: ${c.model_reasoning_effort}`,
        typeof c.approval_policy === 'string' && `approvals: ${c.approval_policy}`,
        typeof c.sandbox_mode === 'string' && `sandbox: ${c.sandbox_mode}`,
        c.profiles && `${Object.keys(c.profiles).length} profiles`,
        !keys.length && 'empty',
      ].filter(Boolean) as string[],
      ...(l.disabledReason ? { unloaded: `Not used: ${l.disabledReason}` } : {}),
    })
  }
  // Codex's own agent roles (multi-agent), when the config defines some.
  for (const [name, a] of Object.entries(config?.config?.agents ?? {}) as [string, Json][])
    if (a && typeof a === 'object' && (a.description || a.config_file)) items.push({ kind: 'agent', name, scope: 'user', description: clip(String(a.description ?? ''), 200), path: a.config_file })
  return { items, engine: 'codex', resolved: true }
}

/** A hook's file: the project's when it sits under the folder, the user's otherwise. */
function layerScopeOfPath(file: string | undefined, cwd: string): SetupScope {
  return file && path.resolve(file).toLowerCase().startsWith(path.resolve(cwd).toLowerCase()) ? 'project' : 'user'
}

// ── a Codex thread, drawn as a session ────────────────────────────────────

/** An error as Codex passes it on: often the API's own JSON, whose message is what matters. */
const errorText = (e: Json): string => {
  const raw = String(e?.message ?? e ?? '')
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{')))
    return j?.error?.message ?? j?.message ?? raw
  } catch {
    return raw
  }
}

const clip = (s: string, n: number) => {
  const one = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
const compact = (v: unknown, n = 1500) => {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s && s.length > n ? `${s.slice(0, n)}…` : s
  } catch {
    return undefined
  }
}

/** A command without the shell that wraps it: `powershell.exe -Command 'npm test'` → `npm test`. */
function shellCommand(command: unknown): string {
  const c = Array.isArray(command) ? command.join(' ') : String(command ?? '')
  return c
    .replace(/^"?(?:[A-Za-z]:)?[^"]*?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:(?:-NoProfile|-NoLogo|-l)\s+)*(?:-Command|-lc|-c|\/c)\s+/i, '')
    .replace(/^(['"])([\s\S]*)\1$/, '$2')
}

/** A tool call as the flow shows it, from one of Codex's items (or undefined for words). */
function stepOf(item: Json, at: number, cwd: string): Step | undefined {
  const status = (s: string) => (s === 'inProgress' ? 'running' : s === 'completed' ? 'done' : 'error') as Step['status']
  switch (item.type) {
    case 'commandExecution': {
      const read = (item.commandActions ?? []).find((a: Json) => a.type === 'read')
      const cmd = shellCommand(item.command)
      return {
        id: item.id,
        tool: read ? 'Read' : 'Shell',
        label: clip(read ? path.relative(cwd, read.path) || read.path : cmd, 120),
        input: compact({ command: item.command, cwd: item.cwd }),
        start: at,
        end: item.durationMs ? at + item.durationMs : undefined,
        status: item.status === 'completed' && item.exitCode ? 'error' : status(item.status),
        output: item.aggregatedOutput ? compact(item.aggregatedOutput, 4000) : undefined,
        file: read?.path,
      }
    }
    case 'fileChange': {
      const first = item.changes?.[0]
      const more = (item.changes?.length ?? 0) > 1 ? ` +${item.changes.length - 1}` : ''
      return {
        id: item.id,
        tool: first?.kind?.type === 'add' ? 'Write' : 'Edit',
        label: first ? `${path.relative(cwd, first.path) || first.path}${more}` : 'files',
        input: compact((item.changes ?? []).map((c: Json) => ({ path: c.path, kind: c.kind?.type }))),
        start: at,
        status: status(item.status),
        output: compact((item.changes ?? []).map((c: Json) => c.diff).join('\n'), 4000),
        file: first?.path,
        writes: true,
      }
    }
    case 'mcpToolCall':
      return {
        id: item.id,
        tool: `${item.server} · ${item.tool}`,
        label: clip(compact(item.arguments, 200) ?? '', 90),
        input: compact(item.arguments),
        start: at,
        end: item.durationMs ? at + item.durationMs : undefined,
        status: status(item.status),
        output: compact(item.error?.message ?? item.result, 4000),
      }
    case 'dynamicToolCall':
      return { id: item.id, tool: item.tool, label: clip(compact(item.arguments, 200) ?? '', 90), input: compact(item.arguments), start: at, status: item.status === 'inProgress' ? 'running' : item.success === false ? 'error' : 'done' }
    case 'webSearch':
      return { id: item.id, tool: 'WebSearch', label: clip(item.query ?? '', 90), start: at, status: 'done' }
    case 'imageView':
      return { id: item.id, tool: 'Read', label: path.relative(cwd, item.path) || item.path, start: at, status: 'done', file: item.path }
    case 'collabAgentToolCall':
      return item.tool === 'spawnAgent' ? undefined : { id: item.id, tool: item.tool, label: clip(item.prompt ?? '', 90), start: at, status: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'error' : 'done' }
    default:
      return undefined
  }
}

/** The text of a user message item. */
const userText = (item: Json) =>
  (item.content ?? [])
    .map((c: Json) => (c.type === 'text' ? c.text : c.type === 'skill' ? `$${c.name}` : c.type === 'mention' ? `@${c.name}` : ''))
    .join(' ')
    .trim()

/**
 * The flow's view of a thread: its latest turn, item by item. Codex's items carry no times, so a live
 * item is stamped when it arrives; a turn read back from history uses the turn's own start.
 */
export class CodexView {
  view: SessionView
  /** When each item was first seen. */
  private seen = new Map<string, number>()
  private items: Json[] = []
  private turnId?: string

  constructor(
    id: string,
    private readonly cwd: string,
    title = 'New Codex thread',
  ) {
    const now = Date.now()
    this.view = {
      id,
      engine: 'codex',
      title,
      cwd,
      status: 'idle',
      last: now,
      turns: 0,
      main: { id: 'main', kind: 'main', type: 'Codex', title: '', start: now, status: 'done', steps: [] },
      subagents: [],
      files: [],
    }
  }

  /** A whole thread read back (thread/read or thread/resume): its latest turn drawn. */
  load(thread: Json) {
    const turns: Json[] = thread.turns ?? []
    this.view.title = clip(thread.name || thread.preview || this.view.title, 80)
    this.view.turns = turns.length
    this.view.last = (thread.updatedAt ?? 0) * 1000 || this.view.last
    const t = turns[turns.length - 1]
    if (!t) return
    this.turnId = t.id
    this.items = []
    this.seen.clear()
    const at = (t.startedAt ?? thread.updatedAt ?? 0) * (t.startedAt && t.startedAt < 1e12 ? 1000 : 1) || Date.now()
    for (const it of t.items ?? []) {
      this.seen.set(it.id, at)
      this.items.push(it)
    }
    this.rebuild(t.status, at, t.completedAt ? (t.completedAt < 1e12 ? t.completedAt * 1000 : t.completedAt) : undefined, t.error ? errorText(t.error) : undefined)
  }

  turnStarted(turn: Json) {
    this.turnId = turn.id
    this.items = []
    this.seen.clear()
    this.view.turns++
    this.rebuild('inProgress', Date.now())
  }

  item(item: Json, startedAtMs?: number) {
    if (!this.seen.has(item.id)) this.seen.set(item.id, startedAtMs ?? Date.now())
    const i = this.items.findIndex((x) => x.id === item.id)
    if (i >= 0) this.items[i] = item
    else this.items.push(item)
    this.rebuild('inProgress', this.view.turn?.start ?? Date.now())
  }

  /** Streamed words of the agent: what it is saying, live. */
  delta(itemId: string, text: string) {
    const it = this.items.find((x) => x.id === itemId)
    if (it) it.text = (it.text ?? '') + text
    else this.items.push({ type: 'agentMessage', id: itemId, text })
    this.seen.set(itemId, this.seen.get(itemId) ?? Date.now())
    this.rebuild('inProgress', this.view.turn?.start ?? Date.now())
  }

  turnCompleted(turn: Json) {
    for (const it of turn.items ?? []) {
      const i = this.items.findIndex((x) => x.id === it.id)
      if (i >= 0) this.items[i] = it
      else this.items.push(it)
    }
    this.rebuild(turn.status, this.view.turn?.start ?? Date.now(), Date.now(), turn.error ? errorText(turn.error) : undefined)
  }

  private rebuild(status: string, start: number, end?: number, error?: string) {
    const v = this.view
    const running = status === 'inProgress'
    const prompt = this.items.find((x) => x.type === 'userMessage')
    if (prompt && v.title === 'New Codex thread') v.title = clip(userText(prompt), 80)
    v.turn = { prompt: prompt ? userText(prompt) : (v.turn?.prompt ?? ''), start, end: running ? undefined : (end ?? Date.now()) }
    v.status = running ? 'working' : 'idle'
    v.last = Math.max(v.last, ...[...this.seen.values()], end ?? 0)
    const steps: Step[] = []
    const subagents: Agent[] = []
    const files = new Map<string, FileTouch>()
    let said: string | undefined
    let output: string | undefined
    for (const it of this.items) {
      const at = this.seen.get(it.id) ?? start
      if (it.type === 'agentMessage') {
        said = it.text
        output = it.text
      } else if (it.type === 'collabAgentToolCall' && it.tool === 'spawnAgent') {
        for (const tid of it.receiverThreadIds ?? []) {
          const st = it.agentsStates?.[tid]
          const s = st?.status
          subagents.push({
            id: tid,
            kind: 'sub',
            type: 'Codex agent',
            title: clip(it.prompt ?? 'Subagent', 120),
            prompt: it.prompt ?? undefined,
            model: it.model ?? undefined,
            start: at,
            status: s === 'running' || s === 'pendingInit' ? 'running' : s === 'errored' || s === 'interrupted' ? 'error' : 'done',
            steps: [],
            output: st?.message ?? undefined,
          })
        }
      } else {
        const s = stepOf(it, at, this.cwd)
        if (!s) continue
        if (!running && s.status === 'running') s.status = 'error'
        steps.push(s)
        for (const c of it.type === 'fileChange' ? (it.changes ?? []) : s.file ? [{ path: s.file }] : []) {
          const p = path.isAbsolute(c.path) ? c.path : path.join(this.cwd, c.path)
          const f = files.get(p) ?? { path: p, by: ['main'], writes: 0, reads: 0, last: at }
          if (it.type === 'fileChange') f.writes++
          else f.reads++
          f.last = at
          files.set(p, f)
        }
      }
    }
    v.main = {
      ...v.main,
      title: v.turn.prompt,
      prompt: v.turn.prompt,
      start,
      end: running ? undefined : v.turn.end,
      status: running ? 'running' : error || status === 'failed' ? 'error' : 'done',
      steps,
      said: running ? said : undefined,
      output: running ? undefined : error ? `Stopped: ${error}` : status === 'interrupted' ? (output ? `${output}\n\n(interrupted)` : 'Interrupted') : output,
    }
    v.subagents = subagents
    v.files = [...files.values()]
  }

  setModel(model?: string) {
    if (model) this.view.main.model = model
  }
}

// ── one chat with Codex ───────────────────────────────────────────────────

/** Approval presets, as Codex's own /approvals offers them. */
const MODES: Record<string, { approvalPolicy: string; sandbox: string; sandboxPolicy: Json }> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  workspace: { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
}

let counter = 0

/** Tools a thread started here gets from Agent Trace (Codex's dynamic tools), and how they run. */
export interface CodexTools {
  specs: Json[]
  call: (tool: string, args: Json) => Promise<string>
}

export class CodexChat {
  readonly engine = 'codex' as const
  readonly key = `codex-${Date.now()}-${++counter}`
  sessionId?: string
  lines: ChatLine[] = []
  busy = false
  commands?: SlashCmd[]
  model?: string
  effort?: Effort
  mode?: Mode
  models?: ModelChoice[]
  mcp?: { servers: McpLive[]; at: number }
  readonly view: CodexView
  private reconnecting = new Set<string>()
  private asks = new Map<string, { ask: Ask; id: number | string; method: string; params: Json }>()
  private turnId?: string
  /** The thread is loaded in this app-server (started or resumed here). */
  private attached = false
  private started?: number
  private listener: Handler

  constructor(
    private readonly server: CodexServer,
    private readonly cwd: string,
    resume: string | undefined,
    private readonly changed: () => void,
    /** Tools of Agent Trace's own for a thread started here (the hand-over to Claude). */
    private readonly tools?: CodexTools,
  ) {
    this.sessionId = resume
    this.view = new CodexView(resume ?? `new-${this.key}`, cwd)
    this.listener = (m, p, id) => this.onServer(m, p, id)
    server.listeners.add(this.listener)
    if (resume) void this.readBack(resume)
  }

  state(): ChatState {
    return {
      engine: 'codex',
      key: this.key,
      sessionId: this.sessionId,
      lines: this.lines.slice(-200),
      busy: this.busy,
      asks: [...this.asks.values()].map((a) => a.ask),
      commands: this.commands,
      model: this.model,
      effort: this.effort,
      mode: this.mode,
      models: this.models,
      mcp: this.mcp,
      reconnecting: [...this.reconnecting],
    }
  }

  /** An earlier thread: its conversation into the chat, its latest turn onto the flow. */
  private async readBack(id: string) {
    try {
      const r = await this.server.call('thread/read', { threadId: id, includeTurns: true })
      const t = r?.thread ?? r
      this.view.load(t)
      const lines: ChatLine[] = []
      for (const turn of (t.turns ?? []).slice(-30)) {
        const at = turn.startedAt ? (turn.startedAt < 1e12 ? turn.startedAt * 1000 : turn.startedAt) : 0
        for (const it of turn.items ?? []) {
          if (it.type === 'userMessage') lines.push({ kind: 'user', text: userText(it), at })
          else if (it.type === 'agentMessage' && it.text?.trim()) lines.push({ kind: 'assistant', text: it.text, at })
        }
      }
      this.lines = [...lines.slice(-60), ...this.lines]
    } catch (e) {
      this.lines.push({ kind: 'error', text: `Could not read the Codex thread: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
    }
    this.changed()
  }

  /** Reread a thread run elsewhere (Codex's own panel, a terminal), when it has moved. */
  async refresh() {
    if (!this.sessionId || this.attached) return
    try {
      const r = await this.server.call('thread/read', { threadId: this.sessionId, includeTurns: true })
      this.view.load(r?.thread ?? r)
      this.changed()
    } catch {
      // gone, or not readable now
    }
  }

  /** A turn asked for by the other agent: settled with Codex's last words once the turn ends. */
  private pending?: { resolve: (text: string) => void; reject: (e: Error) => void }

  /** Hand Codex a task and wait for its answer (the other agent delegating). */
  run(text: string, from: Engine): Promise<string> {
    if (this.busy) return Promise.reject(new Error('Codex is busy with another turn.'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      this.send(text, from)
    })
  }

  private threadOptions() {
    const m = MODES[this.mode ?? ''] ?? undefined
    return { cwd: this.cwd, ...(this.model ? { model: this.model } : {}), ...(m ? { approvalPolicy: m.approvalPolicy, sandbox: m.sandbox } : {}) }
  }

  /** The thread loaded here: started, or resumed when it is an earlier one. */
  private async attach() {
    if (this.attached && this.sessionId) return this.sessionId
    const r = this.sessionId ? await this.server.call('thread/resume', { threadId: this.sessionId, ...this.threadOptions(), excludeTurns: true }) : await this.server.call('thread/start', { ...this.threadOptions(), ...(this.tools ? { dynamicTools: this.tools.specs } : {}) })
    this.sessionId = r.thread.id
    this.view.view.id = r.thread.id
    this.view.setModel(r.model)
    this.attached = true
    return r.thread.id as string
  }

  send(text: string, from?: Engine, hidden = false) {
    if (!text.trim()) return
    // Hidden: a trace shows the user's message itself, once for both agents.
    this.lines.push({ kind: 'user', text, at: Date.now(), ...(from ? { from } : {}), ...(hidden ? { hidden } : {}) })
    this.busy = true
    this.started = Date.now()
    this.changed()
    void (async () => {
      try {
        const threadId = await this.attach()
        // "$skill" names a skill for this turn, as in Codex's own composer.
        const skills = [...text.matchAll(/(?:^|\s)\$([\w:.-]+)/g)]
          .map((m) => this.commands?.find((c) => c.name === m[1] && c.path))
          .filter((c): c is SlashCmd => !!c)
          .map((c) => ({ type: 'skill', name: c.name, path: c.path }))
        const mode = MODES[this.mode ?? '']
        const r = await this.server.call('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }, ...skills],
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          ...(mode ? { approvalPolicy: mode.approvalPolicy, sandboxPolicy: mode.sandboxPolicy } : {}),
        })
        this.turnId = r?.turn?.id ?? this.turnId
      } catch (e) {
        this.busy = false
        this.lines.push({ kind: 'error', text: this.explain(e), at: Date.now() })
        this.changed()
      }
    })()
  }

  private explain(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return /login|auth|401|unauthori[sz]ed/i.test(msg) ? `Codex is not signed in: run \`codex\` in a terminal and sign in. (${msg})` : msg
  }

  async stop() {
    if (!this.sessionId || !this.turnId) return
    await this.server.call('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }).catch(() => undefined)
  }

  decide(requestId: string, d: Decision) {
    const a = this.asks.get(requestId)
    if (!a) return
    this.asks.delete(requestId)
    const yes = d.kind === 'allow' || d.kind === 'always' || d.kind === 'answers'
    switch (a.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.server.answer(a.id, { decision: d.kind === 'always' ? 'acceptForSession' : yes ? 'accept' : 'decline' })
        break
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.server.answer(a.id, { decision: d.kind === 'always' ? 'approved_for_session' : yes ? 'approved' : 'denied' })
        break
      case 'item/permissions/requestApproval':
        this.server.answer(a.id, yes ? { permissions: { ...(a.params.permissions?.network ? { network: a.params.permissions.network } : {}), ...(a.params.permissions?.fileSystem ? { fileSystem: a.params.permissions.fileSystem } : {}) }, scope: d.kind === 'always' ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' })
        break
      case 'item/tool/requestUserInput': {
        const answers: Record<string, { answers: string[] }> = {}
        if (d.kind === 'answers') for (const q of a.params.questions ?? []) answers[q.id] = { answers: [d.answers[q.question] ?? ''].filter(Boolean) }
        this.server.answer(a.id, { answers })
        break
      }
      case 'mcpServer/elicitation/request':
        this.server.answer(a.id, { action: yes ? 'accept' : 'decline', content: yes ? {} : null, _meta: null })
        break
    }
    this.changed()
  }

  /** Codex asks: show it, and wait for the user's answer. */
  private ask(method: string, p: Json, id: number | string) {
    const requestId = `${method}:${id}`
    const at = Date.now()
    let ask: Ask
    if (method === 'item/tool/requestUserInput') {
      ask = { kind: 'question', requestId, toolUseId: p.itemId, questions: (p.questions ?? []).map((q: Json) => ({ question: q.question, header: q.header, options: (q.options ?? []).map((o: Json) => ({ label: o.label, description: o.description })) })), at }
    } else if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = shellCommand(p.command)
      ask = { kind: 'permission', requestId, toolUseId: p.itemId, tool: 'Shell', title: `Codex wants to run: ${clip(cmd || 'a command', 160)}`, detail: p.reason ?? (p.networkApprovalContext ? 'It needs network access.' : undefined), canAlways: true, at }
    } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      ask = { kind: 'permission', requestId, toolUseId: p.itemId, tool: 'Edit', title: p.grantRoot ? `Codex wants to write in ${p.grantRoot}` : 'Codex wants to change files', detail: p.reason ?? undefined, canAlways: true, at }
    } else if (method === 'item/permissions/requestApproval') {
      const what = [p.permissions?.network && 'network access', p.permissions?.fileSystem && 'more file access'].filter(Boolean).join(' and ')
      ask = { kind: 'permission', requestId, toolUseId: p.itemId, tool: 'Permissions', title: `Codex asks for ${what || 'more permissions'}`, detail: p.reason ?? undefined, canAlways: true, at }
    } else {
      ask = { kind: 'permission', requestId, tool: p.serverName ?? 'MCP', title: clip(p.message ?? `${p.serverName} asks for your input`, 200), detail: p.url ? `Opens ${p.url}` : undefined, canAlways: false, at }
    }
    this.asks.set(requestId, { ask, id, method, params: p })
    this.changed()
  }

  private onServer(method: string, p: Json, id?: number | string) {
    if (method === 'agentTrace/exited') {
      this.attached = false
      this.pending?.reject(new Error(p.error ?? 'Codex stopped.'))
      this.pending = undefined
      if (this.busy) {
        this.busy = false
        this.lines.push({ kind: 'error', text: p.error ?? 'Codex stopped.', at: Date.now() })
      }
      this.asks.clear()
      this.changed()
      return
    }
    // MCP servers changing state belong to every chat of the folder.
    if (method === 'mcpServer/startupStatus/updated') {
      if (!this.mcp) return
      const s = this.mcp.servers.find((x) => x.name === p.name)
      const status: McpStatus = p.status === 'ready' ? 'connected' : p.status === 'starting' ? 'pending' : 'failed'
      if (s) Object.assign(s, { status, error: p.error ?? undefined })
      this.changed()
      return
    }
    if (!this.sessionId || p.threadId !== this.sessionId) return
    if (id !== undefined && method === 'item/tool/call') return void this.callTool(p, id)
    if (id !== undefined && /requestApproval|requestUserInput|elicitation|Approval$/.test(method)) return this.ask(method, p, id)
    const now = Date.now()
    const last = this.lines[this.lines.length - 1]
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn.id
        this.busy = true
        this.view.turnStarted(p.turn)
        break
      case 'item/started':
      case 'item/completed': {
        const it = p.item
        this.view.item(it, p.startedAtMs)
        if (it.type === 'agentMessage' && method === 'item/completed') {
          if (last?.kind === 'assistant' && last.streaming) this.lines.pop()
          if (it.text?.trim()) this.lines.push({ kind: 'assistant', text: it.text, at: now })
        } else if (it.type !== 'agentMessage' && it.type !== 'userMessage' && it.type !== 'reasoning') {
          const s = stepOf(it, now, this.cwd)
          if (!s) break
          const line = this.lines.find((l): l is Extract<ChatLine, { kind: 'tool' }> => l.kind === 'tool' && l.id === it.id)
          const st = s.status === 'running' ? 'running' : s.status === 'error' ? 'error' : 'done'
          if (line) line.status = st
          else this.lines.push({ kind: 'tool', id: it.id, tool: s.tool, label: s.label, status: st, at: now })
        }
        break
      }
      case 'item/agentMessage/delta':
        this.view.delta(p.itemId, p.delta)
        if (last?.kind === 'assistant' && last.streaming) last.text += p.delta
        else this.lines.push({ kind: 'assistant', text: p.delta, at: now, streaming: true })
        break
      case 'turn/completed': {
        this.busy = false
        this.view.turnCompleted(p.turn)
        const secs = Math.round((p.turn.durationMs ?? now - (this.started ?? now)) / 1000)
        if (p.turn.status === 'completed') this.lines.push({ kind: 'result', text: `Done in ${secs}s`, at: now })
        else this.lines.push({ kind: 'result', text: `${p.turn.status === 'interrupted' ? 'Stopped' : 'Failed'} after ${secs}s${p.turn.error ? `: ${errorText(p.turn.error)}` : ''}`, at: now, error: true })
        for (const [k, a] of this.asks) if (a.params.turnId === p.turn.id) this.asks.delete(k)
        void this.checkMcp(true)
        const pend = this.pending
        this.pending = undefined
        if (pend) {
          const said = [...(p.turn.items ?? [])].reverse().find((x: Json) => x.type === 'agentMessage')?.text
          if (p.turn.status === 'completed') pend.resolve(said ?? [...this.lines].reverse().find((l) => l.kind === 'assistant')?.text ?? '')
          else pend.reject(new Error(`Codex ${p.turn.status === 'interrupted' ? 'was stopped' : 'failed'}${p.turn.error ? `: ${errorText(p.turn.error)}` : ''}.`))
        }
        break
      }
      case 'serverRequest/resolved':
        for (const [k, a] of this.asks) if (a.id === p.requestId) this.asks.delete(k)
        break
      case 'error':
        if (!p.willRetry) this.lines.push({ kind: 'error', text: p.error ? errorText(p.error) : 'Codex reported an error.', at: now })
        break
      case 'thread/name/updated':
        this.view.view.title = clip(p.name ?? this.view.view.title, 80)
        break
      default:
        return
    }
    this.changed()
  }

  /** Codex calls one of Agent Trace's own tools: run it, and answer with what it gave. */
  private async callTool(p: Json, id: number | string) {
    let text: string
    let success = true
    try {
      if (!this.tools) throw new Error(`Unknown tool ${p.tool}`)
      text = await this.tools.call(p.tool, p.arguments ?? {})
    } catch (e) {
      text = e instanceof Error ? e.message : String(e)
      success = false
    }
    this.server.answer(id, { contentItems: [{ type: 'inputText', text: text || '(no answer)' }], success })
  }

  async loadModels() {
    if (this.models) return
    try {
      const r = await this.server.call('model/list', {})
      const cfg = await this.server.call('config/read', { cwd: this.cwd }).catch(() => undefined)
      const list: Json[] = r?.data ?? []
      const def = list.find((m) => m.id === cfg?.config?.model) ?? list.find((m) => m.isDefault)
      this.models = [
        { value: 'default', name: 'Default', description: def ? `${def.displayName} · from your Codex config` : 'From your Codex config', efforts: def?.supportedReasoningEfforts?.map((e: Json) => e.reasoningEffort ?? e) },
        ...list.filter((m) => !m.hidden).map((m) => ({ value: m.id, name: m.displayName || m.id, description: clip(m.description ?? '', 120), efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => e.reasoningEffort ?? e) })),
      ]
    } catch {
      this.models = []
    }
    this.changed()
  }

  async configure(s: { model?: string | null; effort?: Effort | null; mode?: Mode | null }) {
    if (s.model !== undefined) this.model = s.model ?? undefined
    if (s.effort !== undefined) this.effort = s.effort ?? undefined
    if (s.mode !== undefined) this.mode = s.mode ?? undefined
    this.changed()
  }

  /** Codex's skills, offered when "/" is typed; picking one puts "$name" in the prompt, as Codex does. */
  async loadCommands() {
    if (this.commands) return
    try {
      const r = await this.server.call('skills/list', { cwds: [this.cwd] })
      this.commands = (r?.data?.[0]?.skills ?? [])
        .filter((s: Json) => s.enabled !== false)
        .map((s: Json) => ({ name: s.name, description: clip(s.shortDescription || s.description || '', 140), builtin: s.scope === 'system', insert: `$${s.name} `, path: s.path }))
        .sort((a: SlashCmd, b: SlashCmd) => Number(!!a.builtin) - Number(!!b.builtin) || a.name.localeCompare(b.name))
    } catch {
      this.commands = []
    }
    this.changed()
  }

  async checkMcp(quiet = false) {
    try {
      const r = await this.server.call('mcpServerStatus/list', this.sessionId && this.attached ? { threadId: this.sessionId } : {})
      this.mcp = { servers: (r?.data ?? []).map(mcpLive), at: Date.now() }
    } catch (e) {
      if (!quiet) this.lines.push({ kind: 'error', text: `Could not ask Codex about its MCP servers: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
    }
    this.changed()
  }

  /** Codex reloads its MCP servers all at once (as after a config change), then they are looked at again. */
  async reconnectMcp(names: string[]) {
    for (const n of names) this.reconnecting.add(n)
    this.changed()
    try {
      await this.server.call('config/mcpServer/reload', undefined)
    } catch (e) {
      this.lines.push({ kind: 'error', text: `Codex could not reload its MCP servers: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
    }
    this.reconnecting.clear()
    await this.checkMcp(true)
  }

  dispose() {
    for (const [, a] of this.asks) this.decide(a.ask.requestId, { kind: 'deny' })
    this.server.listeners.delete(this.listener)
    if (this.sessionId && this.attached) void this.server.call('thread/unsubscribe', { threadId: this.sessionId }).catch(() => undefined)
  }
}

