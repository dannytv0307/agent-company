// Agent Trace: chat with Claude Code and Codex and watch them work, side by side. A trace is one
// conversation with both: each message goes to Claude, to Codex or to both, and with hand-over on each can
// give the other a task. They run as the user's own Claude Code CLI (through the Agent SDK) and Codex CLI
// (through its app-server), installed and signed in by them. The flow draws a lane per agent — the prompt,
// the main agent, the subagents, each tool call, the files touched and what comes out — against the setup
// each loaded: the Claude factory and the Codex factory. Sessions run elsewhere (a terminal, the agents' own
// panels) show too. Permission prompts and questions are answered in the chat or on the flow.
import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ACCENTS, type Accent, type ChatLine, type CliState, type Engine, type FromWebview, type SessionSummary, type SessionView, type Setup, type SetupItem, type SetupKind, type Target, type ToWebview } from '../shared/model.ts'
import { waitingText } from '../shared/waiting.ts'
import { Chat, findCli } from './chat.ts'
import { listSessions, liveSessions, projectDirFor, readHistory, SessionReader, type Live } from './claude.ts'
import { CodexChat, CodexServer, codexSetup, findCodex, listThreads, type CodexThread } from './codex.ts'
import { readSetup } from './setup.ts'
import { Trace } from './trace.ts'

let ctx: vscode.ExtensionContext
let panel: vscode.WebviewPanel | undefined
let status: vscode.StatusBarItem
let folder: string | undefined
let claudeDir: string | undefined
let sessions: (SessionSummary & { file: string })[] = []
/** Open sessions as Claude Code reports them (busy, idle, waiting for the user), by session id. */
let live = new Map<string, Live>()
/** What Claude Code loads in this folder: CLAUDE.md, agents, commands, skills, MCP, hooks, plugins, settings. */
let setup: Setup | undefined
let setupKey = ''
let cli: CliState = {}
/** The user's Codex, when installed: its app-server for this folder, its threads here, its setup. */
let codexCli: CliState = {}
let codex: CodexServer | undefined
let threads: CodexThread[] = []
let codexFactory: Setup | undefined
let codexFactoryKey = ''
/** Traces started or continued here, by key; the one on screen. */
const chats = new Map<string, Trace>()
let chat: Trace | undefined
/** The transcript of the chat on screen, read for the flow. */
let reader: SessionReader | undefined
let current: SessionView | undefined
/** Waits already announced, so each one is announced once. */
const announced = new Set<string>()

const cfg = () => vscode.workspace.getConfiguration('agentTrace')
const changed = new vscode.EventEmitter<void>()
const setupChanged = new vscode.EventEmitter<void>()
const log = vscode.window.createOutputChannel('Agent Trace')

// ── where, and what ───────────────────────────────────────────────────────

function pickFolder(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document.uri
  const f = (doc && vscode.workspace.getWorkspaceFolder(doc)) ?? vscode.workspace.workspaceFolders?.[0]
  return f?.uri.scheme === 'file' ? f.uri.fsPath : undefined
}

function refreshSessions() {
  const f = pickFolder()
  if (f !== folder) {
    folder = f
    reader = undefined
    current = undefined
    chat = undefined
    codex?.stop()
    codex = undefined
    threads = []
    codexFactory = undefined
    refreshSetup()
  }
  claudeDir = folder ? projectDirFor(folder) : undefined
  sessions = claudeDir ? listSessions(claudeDir) : []
  // An open session says itself whether it is at work; the transcript's age is only a guess.
  for (const s of sessions) {
    const l = live.get(s.id)
    if (l) {
      s.status = l.status === 'idle' ? 'idle' : 'working'
      s.waiting = l.status === 'waiting'
    }
    const mine = traceWith(s.id)?.claude
    if (mine) {
      s.status = mine.busy ? 'working' : s.status
      s.waiting = mine.state().asks.length > 0
    }
  }
  // A new chat's transcript appears once Claude Code has started it: start reading it then.
  const id = chat?.claude?.sessionId
  if (id && reader?.id !== id) {
    const s = sessions.find((x) => x.id === id)
    if (s) reader = new SessionReader(s.id, s.file)
  }
}

/** Re-read the setup; true when it changed. */
function refreshSetup(): boolean {
  let next: Setup | undefined
  try {
    next = folder ? readSetup(folder) : undefined
  } catch {
    next = undefined
  }
  const key = JSON.stringify(next ?? null)
  if (key === setupKey) return false
  setupKey = key
  setup = next
  setupChanged.fire()
  return true
}

/** Each agent's view of the trace on screen, with "waiting" when it (or Claude Code elsewhere) waits for the user. */
function snapAll(): { claude?: SessionView; codex?: SessionView } {
  const out: { claude?: SessionView; codex?: SessionView } = {}
  if (chat?.codex) {
    const v = chat.codex.view.view
    const asks = chat.codex.state().asks
    out.codex = asks.length ? { ...v, waiting: { reason: 'permission', since: asks[0].at } } : { ...v }
  }
  if (reader) {
    const l = live.get(reader.id)
    const v = reader.snapshot(Date.now(), l?.startedAt)
    const asks = chat?.claude?.sessionId === reader.id ? chat.claude.state().asks : []
    out.claude = asks.length ? { ...v, waiting: { reason: 'permission', since: asks[0].at } } : l?.status === 'waiting' ? { ...v, waiting: { reason: l.waitingFor, since: l.since } } : v
  }
  return out
}

/** The view drawn first and named in the header: the lead agent's. */
const leadOf = (v: { claude?: SessionView; codex?: SessionView }) => (chat?.lead === 'codex' ? (v.codex ?? v.claude) : (v.claude ?? v.codex))

/** The trace holding a session (Claude Code) or a thread (Codex). */
const traceWith = (id: string) => [...chats.values()].find((t) => t.claude?.sessionId === id || t.codex?.sessionId === id)

/** Claude Code sessions and Codex threads that make one trace, both ways. */
const links = () => ctx.workspaceState.get<Record<string, string>>('agentTrace.links') ?? {}
function link(t: Trace) {
  const a = t.claude?.sessionId
  const b = t.codex?.sessionId
  if (!a || !b || links()[a] === b) return
  void ctx.workspaceState.update('agentTrace.links', { ...links(), [a]: b, [b]: a })
}

/** Show a session of this folder: its chat if open here, else a chat that will continue it. */
function show(id: string) {
  const open = traceWith(id)
  // A Claude Code session and a Codex thread linked as one trace open together.
  const thread = threads.find((x) => x.id === id) ? id : threads.find((x) => x.id === links()[id])?.id
  const s = sessions.find((x) => x.id === id) ?? sessions.find((x) => x.id === links()[id])
  if (!thread && !s) return
  reader = undefined
  if (s) {
    try {
      reader = new SessionReader(s.id, s.file)
    } catch (e) {
      void vscode.window.showWarningMessage(`Agent Trace could not read session ${s.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  chat = open ?? newTrace({ ...(s ? { claude: { resume: s.id, history: readHistory(s.file) } } : {}), ...(thread ? { codex: { resume: thread } } : {}) })
  publish()
  void refreshCodexFactory()
}

// ── Codex: its server, its threads here, its factory ─────────────────────

/** Codex's app-server for this folder, started on first need. */
function codexServer(): CodexServer | undefined {
  if (!codexCli.path || !folder) return undefined
  if (!codex) {
    codex = new CodexServer(codexCli.path, folder)
    codex.listeners.add((m) => {
      if (m === 'skills/changed') void refreshCodexFactory()
      else if (m === 'thread/started' || m === 'thread/status/changed' || m === 'thread/name/updated') void refreshThreads()
    })
  }
  return codex
}

/** The folder's Codex threads; true when the list changed. */
async function refreshThreads(): Promise<boolean> {
  const s = codexServer()
  if (!s || !folder) return false
  let next: CodexThread[]
  try {
    next = await listThreads(s, folder)
  } catch {
    return false
  }
  for (const t of next) {
    const mine = traceWith(t.id)?.codex
    if (mine) {
      t.status = mine.busy ? 'working' : t.status
      t.waiting = mine.state().asks.length > 0
    }
  }
  const key = (l: CodexThread[]) => JSON.stringify(l.map((t) => [t.id, t.last, t.status, t.waiting, t.title]))
  if (key(next) === key(threads)) return false
  threads = next
  // A thread on screen that runs elsewhere has moved: read it again.
  void chat?.codex?.refresh()
  publish()
  return true
}

/** The Codex factory, as Codex reports it for this folder. */
async function refreshCodexFactory() {
  const s = codexServer()
  if (!s || !folder) return
  let next: Setup
  try {
    next = await codexSetup(s, folder)
  } catch {
    return
  }
  const key = JSON.stringify(next)
  if (key === codexFactoryKey) return
  codexFactoryKey = key
  codexFactory = next
  setupChanged.fire()
  publish()
}

/** Nothing picked yet: show what Claude Code is doing in this folder right now, if anything. */
function showAtWork() {
  if (chat) return
  const s = sessions.find((x) => x.waiting || live.get(x.id)?.status === 'busy')
  if (s) show(s.id)
}

// ── telling everyone ──────────────────────────────────────────────────────

/** A part of a trace whose session another window is running: what is done here does not reach that run. */
const partElsewhere = (e: Engine, c?: { sessionId?: string; busy: boolean }) =>
  !!c?.sessionId && !c.busy && (e === 'codex' ? !!threads.find((t) => t.id === c.sessionId)?.active : ['busy', 'waiting'].includes(live.get(c.sessionId)?.status ?? ''))
const runsElsewhere = (t: Trace) => partElsewhere('claude', t.claude) || partElsewhere('codex', t.codex)

/** Whom a new trace sends to, and whether its agents may hand work over: as last set. */
const lastTarget = (): Target => {
  const t = ctx.workspaceState.get<Target>('agentTrace.target') ?? 'claude'
  return t !== 'claude' && !codexCli.path ? 'claude' : t === 'claude' && !cli.path && codexCli.path ? 'codex' : t
}
const lastDelegate = () => ctx.workspaceState.get<boolean>('agentTrace.delegate') ?? true

/** The folder's sessions, both agents', newest first. */
const allSessions = (): SessionSummary[] => [...sessions.map(({ file: _f, ...s }) => s), ...threads.map(({ active: _a, ...t }) => t)].sort((a, b) => b.last - a.last)

/** The colour picked in the settings (or in the flow's header). */
function accent(): Accent {
  const a = cfg().get<string>('accentColor')
  return (ACCENTS as readonly string[]).includes(a ?? '') ? (a as Accent) : 'vscode'
}

function publish() {
  const views = snapAll()
  current = leadOf(views)
  const msg: ToWebview = {
    type: 'state',
    sessions: allSessions(),
    current,
    following: false,
    folder,
    claudeDir,
    setup,
    codexSetup: codexFactory,
    views,
    handoffs: chat?.handoffs ?? [],
    direct: chat?.direct ?? [],
    accent: accent(),
    chat: chat ? { ...chat.state(), elsewhere: runsElsewhere(chat) } : { key: 'none', lines: [], busy: false, asks: [], target: lastTarget(), delegate: lastDelegate() },
    cli,
    codex: codexCli,
  }
  void panel?.webview.postMessage(msg)
  changed.fire()
  updateStatus()
  announce()
}

/**
 * Claude Code waiting for the user — a permission, a question, a plan to approve — is easy to miss while
 * looking elsewhere: say so once per wait, with a way to get there (setting agentTrace.notifyWhenWaiting).
 */
function announce() {
  const on = cfg().get<boolean>('notifyWhenWaiting', true)
  // A chat of ours asking: answered in the chat, so said only while the tab is out of sight.
  for (const c of chats.values())
    for (const a of c.state().asks) {
      const key = `${c.key}:${a.requestId}`
      if (announced.has(key)) continue
      announced.add(key)
      if (!on || panel?.visible) continue
      const id = c.state().sessionId
      const title = allSessions().find((s) => s.id === id)?.title
      void vscode.window.showWarningMessage(`${a.engine === 'codex' ? 'Codex' : 'Claude Code'} needs your answer${title ? ` in “${title}”` : ''}.`, 'Show').then((pick) => {
        if (pick !== 'Show') return
        openFlow()
        if (chat !== c) {
          chat = c
          reader = undefined
          refreshSessions()
          publish()
        }
      })
    }
  // A session run elsewhere (the terminal, Claude Code's panel) waiting there: answered there.
  for (const s of sessions) {
    const l = live.get(s.id)
    if (!s.waiting || l?.status !== 'waiting' || traceWith(s.id)?.claude?.busy) continue
    const key = `${s.id}:${l.since}`
    if (announced.has(key)) continue
    announced.add(key)
    if (!on) continue
    const text = s.id === current?.id ? waitingText(current) : undefined
    void vscode.window.showWarningMessage(text ? `Claude Code needs you: ${text}` : `Claude Code needs you in “${s.title}”`, 'Open Claude Code', 'Show flow').then(async (pick) => {
      if (pick === 'Show flow') {
        openFlow()
        show(s.id)
      } else if (pick === 'Open Claude Code') {
        const commands = await vscode.commands.getCommands(true)
        const focus = ['claude-vscode.focus', 'claude-vscode.sidebar.open', 'claude-vscode.editor.openLast'].find((c) => commands.includes(c))
        if (focus) await vscode.commands.executeCommand(focus)
      }
    })
  }
}

function updateStatus() {
  const v = current
  const asking = [...chats.values()].flatMap((c) => c.state().asks)[0]
  const wait = waitingText(v) ?? (asking ? `${asking.engine === 'codex' ? 'Codex' : 'Claude'} needs your answer` : undefined)
  status.backgroundColor = wait ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  if (wait) {
    status.text = `$(bell-dot) ${wait.length > 48 ? `${wait.slice(0, 47)}…` : wait}`
    status.tooltip = asking ? 'Claude Code is waiting for you — answer it in Agent Trace.' : `Claude Code is waiting for you — answer it in Claude Code. ${v?.title ?? ''}`
    return
  }
  if (v?.status !== 'working') {
    const busy = [...chats.values()].filter((c) => c.busy).length
    status.text = busy ? `$(sync~spin) Agent Trace · ${busy} working` : '$(type-hierarchy) Agent Trace'
    status.tooltip = v ? `Claude Code is idle — ${v.title}` : 'Agent Trace: chat with Claude Code and watch it work'
    return
  }
  const step = [...v.main.steps].reverse().find((s) => s.status === 'running')
  const subs = v.subagents.filter((a) => a.status === 'running').length
  const doing = step ? `${step.tool} ${step.label}`.trim() : 'thinking'
  status.text = `$(sync~spin) ${v.main.type} · ${doing.length > 40 ? `${doing.slice(0, 39)}…` : doing}${subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}`
  status.tooltip = `${v.title} — open the flow`
}

// ── the sessions list ─────────────────────────────────────────────────────

const ago = (ts: number) => {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

class SessionsTree implements vscode.TreeDataProvider<SessionSummary> {
  readonly onDidChangeTreeData = changed.event
  getChildren() {
    return allSessions()
  }
  getTreeItem(s: SessionSummary) {
    const item = new vscode.TreeItem(s.title)
    const open = !!chat && (chat.claude?.sessionId === s.id || chat.codex?.sessionId === s.id)
    item.description = `${s.engine === 'codex' ? 'Codex · ' : ''}${s.waiting ? 'needs you · ' : s.status === 'working' ? 'working · ' : ''}${ago(s.last)}${open ? ' · open' : ''}`
    item.iconPath = s.waiting
      ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(s.status === 'working' ? 'sync~spin' : open ? 'comment-discussion' : 'comment')
    item.tooltip = `${s.title}\n${s.id}`
    item.command = { command: 'agentFlow.showSession', title: 'Open', arguments: [s.id] }
    item.contextValue = 'session'
    item.id = s.id
    return item
  }
}

// ── the setup list ────────────────────────────────────────────────────────

type GroupKey = SetupKind | 'found'
const GROUPS: [GroupKey, string, string][] = [
  ['memory', 'Memory (CLAUDE.md)', 'book'],
  ['agent', 'Agents', 'hubot'],
  ['command', 'Slash commands', 'terminal'],
  ['skill', 'Skills', 'sparkle'],
  ['mcp', 'MCP servers', 'plug'],
  ['hook', 'Hooks', 'zap'],
  ['plugin', 'Plugins', 'extensions'],
  ['settings', 'Settings', 'gear'],
  ['found', 'Here, not loaded', 'warning'],
]
const scopeLabel = (i: SetupItem) => (i.scope === 'plugin' ? `plugin ${i.plugin}` : i.scope === 'builtin' ? 'built-in' : i.scope)

type SetupNode = { group: GroupKey } | { item: SetupItem }
/** Items not loaded go in their own group, out of their kind's. */
const inGroup = (i: SetupItem, g: GroupKey) => (g === 'found' ? !!i.unloaded : i.kind === g && !i.unloaded)

/** A factory as a tree: Claude's (the setup read here, checked by sessions) or Codex's (as Codex reports it). */
class SetupTree implements vscode.TreeDataProvider<SetupNode> {
  readonly onDidChangeTreeData = setupChanged.event
  constructor(private readonly engine: Engine) {}
  private get setup() {
    return this.engine === 'codex' ? codexFactory : setup
  }
  getChildren(node?: SetupNode): SetupNode[] {
    const setup = this.setup
    const items = setup?.items ?? []
    if (!node) return GROUPS.filter(([k]) => items.some((i) => inGroup(i, k))).map(([group]) => ({ group }))
    if ('group' in node) return items.filter((i) => inGroup(i, node.group)).map((item) => ({ item }))
    return []
  }
  getTreeItem(node: SetupNode) {
    const setup = this.setup
    if ('group' in node) {
      const [, name, icon] = GROUPS.find(([k]) => k === node.group)!
      const label = this.engine === 'codex' && node.group === 'memory' ? 'Memory (AGENTS.md)' : this.engine === 'codex' && node.group === 'settings' ? 'Config' : name
      const t = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed)
      t.description = String(setup?.items.filter((i) => inGroup(i, node.group)).length ?? 0)
      t.iconPath = new vscode.ThemeIcon(icon)
      return t
    }
    const i = node.item
    const t = new vscode.TreeItem(i.kind === 'command' ? `/${i.name}` : i.name)
    t.description = scopeLabel(i)
    t.tooltip = [i.name, i.unloaded, i.description, ...(i.facts ?? []), i.path].filter(Boolean).join('\n')
    if (i.path) {
      t.resourceUri = vscode.Uri.file(i.path)
      t.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(i.path)] }
    }
    return t
  }
}

// ── files Claude is editing, marked in the Explorer ───────────────────────

class EditedFiles implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this.emitter.event
  private marked = new Set<string>()
  constructor() {
    changed.event(() => {
      const now = new Set((current?.status === 'working' ? current.files.filter((f) => f.writes > 0) : []).map((f) => vscode.Uri.file(f.path).toString()))
      const diff = [...now, ...this.marked].filter((u) => now.has(u) !== this.marked.has(u))
      this.marked = now
      if (diff.length) this.emitter.fire(diff.map((u) => vscode.Uri.parse(u)))
    })
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.marked.has(uri.toString())) return undefined
    return { badge: '●', tooltip: 'Being edited by Claude Code', color: new vscode.ThemeColor('charts.yellow') }
  }
}

// ── the tab ───────────────────────────────────────────────────────────────

function webviewHtml(webview: vscode.Webview): string {
  const root = vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview')
  let html = readFileSync(path.join(root.fsPath, 'index.html'), 'utf8')
  // Vite writes relative asset paths; the webview needs them as webview URIs.
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_m, attr, rel) => `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(root, rel))}"`)
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${webview.cspSource} https://fonts.gstatic.com`,
  ].join('; ')
  return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
}

const webviewOptions = (): vscode.WebviewOptions & vscode.WebviewPanelOptions => ({
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview')],
})

/** Give a panel — new, or one VS Code restores after a reload — its page and its messages. */
function adopt(p: vscode.WebviewPanel) {
  panel = p
  p.webview.options = webviewOptions()
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png')
  p.webview.html = webviewHtml(p.webview)
  p.webview.onDidReceiveMessage((m: FromWebview) => void onMessage(m))
  p.onDidDispose(() => {
    if (panel === p) panel = undefined
  })
}

function openFlow() {
  if (panel) {
    panel.reveal()
    return
  }
  adopt(vscode.window.createWebviewPanel('agentFlow.flow', 'Agent Trace', vscode.ViewColumn.Active, webviewOptions()))
}

/**
 * Delete a session: its transcript and its folder (subagents, tool output) go to the trash, so a mistake
 * can be undone from there. Never one that is running, here or in another Claude Code window.
 */
async function deleteSession(id: string) {
  const t = threads.find((x) => x.id === id)
  if (t) return archiveThread(t)
  const s = sessions.find((x) => x.id === id)
  if (!s) return
  const mine = traceWith(id)
  const l = live.get(id)
  if (mine?.claude?.busy || l?.status === 'busy' || l?.status === 'waiting') {
    void vscode.window.showWarningMessage(`“${s.title}” is running. Stop it (or close it in the other Claude Code window) before deleting it.`)
    return
  }
  const pick = await vscode.window.showWarningMessage(
    `Delete the session “${s.title}”?`,
    { modal: true, detail: 'Its transcript moves to the trash: it leaves Agent Trace, Claude Code’s history and /resume. Restore it from the trash if you change your mind.' },
    'Delete',
  )
  if (pick !== 'Delete') return
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(s.file), { useTrash: true })
    const dir = path.join(path.dirname(s.file), id)
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true, useTrash: true })
    } catch {
      // no folder of its own
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not delete “${s.title}”: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  if (mine) {
    mine.dispose()
    chats.delete(mine.key)
  }
  if ((mine && chat === mine) || reader?.id === id) {
    chat = undefined
    reader = undefined
  }
  refreshSessions()
  publish()
}

/** Archive a Codex thread: it leaves the lists, and Codex can restore it. Never one at work. */
async function archiveThread(t: CodexThread) {
  const mine = traceWith(t.id)
  if (mine?.codex?.busy || t.active) {
    void vscode.window.showWarningMessage(`“${t.title}” is running. Stop it before archiving it.`)
    return
  }
  const pick = await vscode.window.showWarningMessage(`Archive the Codex thread “${t.title}”?`, { modal: true, detail: 'It leaves Agent Trace and Codex’s list of threads. Codex keeps it, archived: restore it from there if you change your mind.' }, 'Archive')
  if (pick !== 'Archive') return
  try {
    await codexServer()?.call('thread/archive', { threadId: t.id })
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not archive “${t.title}”: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  if (mine) {
    mine.dispose()
    chats.delete(mine.key)
    if (chat === mine) chat = undefined
  }
  await refreshThreads()
  publish()
}

/** The model, effort and mode last picked for an agent: a new chat starts with them, as in Claude Code's own panel. */
type Prefs = { model?: string; effort?: string; mode?: string }
const prefsOf = (e: Engine) => ctx.globalState.get<Prefs>(`agentTrace.prefs.${e}`) ?? {}
function withPrefs<T extends Chat | CodexChat>(e: Engine, chat: T): T {
  const p = prefsOf(e)
  if (p.model || p.effort || p.mode) void chat.configure(p as never)
  return chat
}
async function rememberPrefs(e: Engine, s: { model?: string | null; effort?: string | null; mode?: string | null }) {
  const next: Prefs = { ...prefsOf(e) }
  for (const k of ['model', 'effort', 'mode'] as const) if (s[k] !== undefined) next[k] = s[k] ?? undefined
  await ctx.globalState.update(`agentTrace.prefs.${e}`, next)
}

/** A trace: Claude Code and Codex in one conversation, each started when first needed. */
function newTrace(open?: { claude?: { resume: string; history: ChatLine[] }; codex?: { resume: string } }): Trace | undefined {
  if (!folder) return undefined
  const cwd = folder
  const t: Trace = new Trace(
    {
      has: (e) => (e === 'claude' ? !!cli.path : !!codexCli.path),
      makeClaude: (resume, history, tools, changed, about) => withPrefs('claude', new Chat(cwd, cli.path ?? 'claude', resume, history, changed, tools, about)),
      makeCodex: (resume, tools, changed, about) => {
        const s = codexServer()
        return s ? withPrefs('codex', new CodexChat(s, cwd, resume, changed, tools, about)) : undefined
      },
    },
    () => {
      refreshSessions()
      link(t)
      publish()
    },
    lastTarget(),
    open,
  )
  t.delegate = lastDelegate()
  chats.set(t.key, t)
  return t
}

/** The trace a message is for: the one on screen, or a new one. */
const ensureChat = () => (chat ??= newTrace())
/** The CLI of an agent. */
const cliOf = (e: Engine) => (e === 'codex' ? codexCli : cli)
/** The agent a setting, a command list or an MCP check is about. */
const engineOf = (e?: Engine): Engine => e ?? (chat?.target === 'codex' ? 'codex' : (chat?.lead ?? (lastTarget() === 'codex' ? 'codex' : 'claude')))

async function onMessage(m: FromWebview) {
  switch (m.type) {
    case 'ready':
      showAtWork()
      publish()
      void refreshThreads()
      void refreshCodexFactory()
      return
    case 'log':
      log.appendLine(`[webview] ${m.text}`)
      if (m.error) log.show(true)
      return
    case 'open':
      await vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside })
      return
    case 'diff':
      try {
        await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(m.path))
      } catch {
        await vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true, viewColumn: vscode.ViewColumn.Beside })
      }
      return
    case 'accent':
      await cfg().update('accentColor', m.accent, vscode.ConfigurationTarget.Global)
      return
    case 'chat.new':
      if (m.engine) await ctx.workspaceState.update('agentTrace.target', m.engine)
      chat = newTrace()
      reader = undefined
      publish()
      void refreshCodexFactory()
      return
    case 'chat.route':
      if (m.target) await ctx.workspaceState.update('agentTrace.target', m.target)
      if (m.delegate !== undefined) await ctx.workspaceState.update('agentTrace.delegate', m.delegate)
      if (chat) chat.route(m.target, m.delegate)
      else publish()
      return
    case 'select':
      show(m.id)
      return
    case 'chat.send': {
      const target = m.target ?? chat?.target ?? lastTarget()
      const to: Engine[] = target === 'both' ? ['claude', 'codex'] : [target]
      const missing = to.map(cliOf).find((c) => c.problem && !c.path)
      if (missing) {
        void vscode.window.showErrorMessage(missing.problem!)
        return
      }
      // Someone else's run of this session (the terminal, an agent's own panel) must finish first.
      if (chat && to.some((e) => partElsewhere(e, chat!.part(e)))) {
        void vscode.window.showWarningMessage('This session is running in another window. Wait for it to finish, or start a new chat.')
        return
      }
      const t = ensureChat()
      if (!t) return
      if (m.delegate !== undefined) t.delegate = m.delegate
      await ctx.workspaceState.update('agentTrace.target', target)
      t.send(m.text, target)
      return
    }
    case 'chat.models': {
      const e = engineOf(m.engine)
      if (!cliOf(e).path) return
      const part = ensureChat()?.ensure(e)
      publish()
      await part?.loadModels()
      return
    }
    case 'chat.settings':
      await rememberPrefs(engineOf(m.engine), m)
      await ensureChat()?.configure(engineOf(m.engine), m)
      return
    case 'chat.commands': {
      const e = engineOf(m.engine)
      if (!cliOf(e).path) return
      const part = ensureChat()?.ensure(e)
      publish()
      await part?.loadCommands()
      return
    }
    case 'chat.stop':
      chat?.stop()
      return
    case 'chat.decide':
      for (const c of chats.values()) c.decide(m.requestId, m.decision)
      return
    case 'mcp.check':
    case 'mcp.reconnect': {
      const e = engineOf(m.engine)
      if (!cliOf(e).path) return
      const t = ensureChat()
      if (!t || partElsewhere(e, t.part(e))) return
      const part = t.ensure(e)
      publish()
      if (m.type === 'mcp.check') await part?.checkMcp()
      else await part?.reconnectMcp(m.names)
      publish()
      return
    }
    case 'session.delete':
      await deleteSession(m.id)
      return
    case 'follow':
      return
  }
}

// ── wiring ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  ctx = context
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.command = 'agentFlow.open'
  status.show()
  cli = findCli(cfg().get<string>('claudePath') || undefined)
  codexCli = findCodex(cfg().get<string>('codexPath') || undefined)
  void vscode.commands.executeCommand('setContext', 'agentTrace.hasCodex', !!codexCli.path)
  const codexTree = vscode.window.createTreeView('agentFlow.codexSetup', { treeDataProvider: new SetupTree('codex') })

  live = liveSessions()
  refreshSessions()
  publish()

  // The open session is read every ~0.7 s (only what was appended); the list every few seconds.
  // Claude Code's own session files are read every tick too: a permission prompt writes nothing to the
  // transcript, only "waiting" there.
  let ticks = 0
  let liveKey = ''
  const timer = setInterval(() => {
    live = liveSessions()
    const nextLive = JSON.stringify([...live].map(([id, l]) => [id, l.status, l.waitingFor]))
    const liveMoved = nextLive !== liveKey
    liveKey = nextLive
    if (++ticks % 8 === 0 && refreshSetup()) publish()
    // Codex's threads (and a thread on screen run elsewhere) every few seconds, while the tab is open;
    // its factory less often.
    if (panel && codex?.running && ticks % 6 === 0) void refreshThreads()
    if (panel && codex?.running && ticks % 40 === 0) void refreshCodexFactory()
    if (ticks % 4 === 0 || liveMoved) {
      const before = JSON.stringify(sessions.map((s) => [s.id, s.last, s.status, s.waiting]))
      refreshSessions()
      if (before !== JSON.stringify(sessions.map((s) => [s.id, s.last, s.status, s.waiting]))) publish()
    }
    if (reader?.poll() || (reader && liveMoved)) publish()
    else if (reader && current?.status === 'working' && reader.snapshot(Date.now(), live.get(reader.id)?.startedAt).status !== 'working') {
      // Nothing new, but a long-silent turn may have gone stale.
      publish()
    }
  }, 700)

  context.subscriptions.push(
    status,
    log,
    { dispose: () => clearInterval(timer) },
    { dispose: () => chats.forEach((c) => c.dispose()) },
    { dispose: () => codex?.stop() },
    vscode.commands.registerCommand('agentFlow.open', openFlow),
    // After a reload VS Code brings the tab back empty unless someone fills it again.
    vscode.window.registerWebviewPanelSerializer('agentFlow.flow', { deserializeWebviewPanel: async (p) => adopt(p) }),
    vscode.window.registerTreeDataProvider('agentFlow.sessions', new SessionsTree()),
    vscode.window.registerTreeDataProvider('agentFlow.setup', new SetupTree('claude')),
    // Codex's factory comes from Codex itself: opening the view asks it (starting its app-server).
    codexTree,
    codexTree.onDidChangeVisibility((e) => {
      if (e.visible) void refreshCodexFactory()
    }),
    vscode.window.registerFileDecorationProvider(new EditedFiles()),
    vscode.commands.registerCommand('agentFlow.deleteSession', (s?: SessionSummary | string) => {
      const id = typeof s === 'string' ? s : s?.id
      if (id) void deleteSession(id)
    }),
    vscode.commands.registerCommand('agentFlow.showSession', (id: string) => {
      openFlow()
      show(id)
    }),
    vscode.commands.registerCommand('agentFlow.newChat', () => {
      openFlow()
      void onMessage({ type: 'chat.new' })
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentTrace.claudePath')) cli = findCli(cfg().get<string>('claudePath') || undefined)
      if (e.affectsConfiguration('agentTrace.codexPath')) {
        codexCli = findCodex(cfg().get<string>('codexPath') || undefined)
        void vscode.commands.executeCommand('setContext', 'agentTrace.hasCodex', !!codexCli.path)
        codex?.stop()
        codex = undefined
      }
      if (e.affectsConfiguration('agentTrace')) publish()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshSessions()
      publish()
    }),
  )
}

export function deactivate() {
  chats.forEach((c) => c.dispose())
  codex?.stop()
}
