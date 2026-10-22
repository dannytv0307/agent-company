// Agent Trace: shows what Claude Code is doing in this folder, live. It reads Claude Code's own session
// transcripts — nothing to configure, nothing sent anywhere — and draws the current turn in an editor
// tab: the prompt, the main agent, the subagents it spawns, each tool call, the files it touches and
// what comes out. A sidebar lists the folder's sessions; the status bar says what is running now.
import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ACCENTS, type Accent, type FromWebview, type SessionSummary, type SessionView, type Setup, type SetupItem, type SetupKind, type ToWebview } from '../shared/model.ts'
import { waitingText } from '../shared/waiting.ts'
import { listSessions, liveSessions, projectDirFor, SessionReader, type Live } from './claude.ts'
import { readSetup } from './setup.ts'

let ctx: vscode.ExtensionContext
let panel: vscode.WebviewPanel | undefined
let status: vscode.StatusBarItem
let folder: string | undefined
let claudeDir: string | undefined
let sessions: (SessionSummary & { file: string })[] = []
let reader: SessionReader | undefined
let current: SessionView | undefined
/** Show whichever session moved last (true), or the one picked in the list. */
let following = true
/** What Claude Code loads in this folder: CLAUDE.md, agents, commands, skills, MCP, hooks, plugins, settings. */
let setup: Setup | undefined
let setupKey = ''
/** Open sessions as Claude Code reports them (busy, idle, waiting for the user), by session id. */
let live = new Map<string, Live>()
/** Waits already announced, so each one is announced once. */
const announced = new Set<string>()

const changed = new vscode.EventEmitter<void>()
const setupChanged = new vscode.EventEmitter<void>()

// ── where to look ─────────────────────────────────────────────────────────

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
    refreshSetup()
  }
  claudeDir = folder ? projectDirFor(folder) : undefined
  sessions = claudeDir ? listSessions(claudeDir) : []
  // An open session says itself whether it is at work; the transcript's age is only a guess.
  for (const s of sessions) {
    const l = live.get(s.id)
    if (!l) continue
    s.status = l.status === 'idle' ? 'idle' : 'working'
    s.waiting = l.status === 'waiting'
  }
  const wanted = following ? sessions[0] : (sessions.find((s) => s.id === reader?.id) ?? sessions[0])
  if (wanted && wanted.id !== reader?.id) show(wanted.id)
  if (!wanted) {
    reader = undefined
    current = undefined
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

/** The reader's view, with what Claude Code says about the session right now. */
function snap(r: SessionReader): SessionView {
  const l = live.get(r.id)
  const v = r.snapshot(Date.now(), l?.startedAt)
  return l?.status === 'waiting' ? { ...v, waiting: { reason: l.waitingFor, since: l.since } } : v
}

function show(id: string) {
  const s = sessions.find((x) => x.id === id)
  if (!s) return
  try {
    reader = new SessionReader(s.id, s.file)
    current = snap(reader)
  } catch (e) {
    reader = undefined
    current = undefined
    void vscode.window.showWarningMessage(`Agent Trace could not read session ${id}: ${e instanceof Error ? e.message : String(e)}`)
  }
  publish()
}

// ── telling everyone ──────────────────────────────────────────────────────

/** The colour picked in the settings (or in the flow's header). */
function accent(): Accent {
  const a = vscode.workspace.getConfiguration('agentTrace').get<string>('accentColor')
  return (ACCENTS as readonly string[]).includes(a ?? '') ? (a as Accent) : 'vscode'
}

function publish() {
  // The list shows the session on screen with its exact status, the rest by how recently they moved.
  const list = sessions.map((s) => (current && s.id === current.id ? { ...s, title: current.title, status: current.status, waiting: !!waitingText(current) } : s))
  const msg: ToWebview = { type: 'state', sessions: list.map(({ file: _f, ...s }) => s), current, following, folder, claudeDir, setup, accent: accent() }
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
  if (!vscode.workspace.getConfiguration('agentTrace').get<boolean>('notifyWhenWaiting', true)) return
  const text = waitingText(current)
  const waits: { key: string; message: string }[] = []
  if (current && text) waits.push({ key: `${current.id}:${current.waiting?.since ?? current.turn?.start}:${text}`, message: `Claude Code needs you: ${text}` })
  for (const s of sessions)
    if (s.waiting && s.id !== current?.id) waits.push({ key: `${s.id}:${live.get(s.id)?.since}`, message: `Claude Code needs you in “${s.title}”` })
  for (const w of waits) {
    if (announced.has(w.key)) continue
    announced.add(w.key)
    void vscode.window.showWarningMessage(w.message, 'Open Claude Code', 'Show flow').then(async (pick) => {
      if (pick === 'Show flow') openFlow()
      else if (pick === 'Open Claude Code') {
        const commands = await vscode.commands.getCommands(true)
        const focus = ['claude-vscode.focus', 'claude-vscode.sidebar.open', 'claude-vscode.editor.openLast'].find((c) => commands.includes(c))
        if (focus) await vscode.commands.executeCommand(focus)
      }
    })
  }
}

function updateStatus() {
  const v = current
  const running = v?.status === 'working'
  const wait = waitingText(v)
  status.backgroundColor = wait ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  if (wait) {
    status.text = `$(bell-dot) ${wait.length > 48 ? `${wait.slice(0, 47)}…` : wait}`
    status.tooltip = `Claude Code is waiting for you — answer it in Claude Code. ${v?.title ?? ''}`
    return
  }
  if (!running) {
    status.text = '$(type-hierarchy) Agent Trace'
    status.tooltip = v ? `Claude Code is idle — ${v.title}` : 'Agent Trace: no Claude Code session in this folder yet'
    return
  }
  const step = [...v.main.steps].reverse().find((s) => s.status === 'running')
  const subs = v.subagents.filter((a) => a.status === 'running').length
  const doing = step ? `${step.tool} ${step.label}`.trim() : 'thinking'
  status.text = `$(sync~spin) Claude · ${doing.length > 40 ? `${doing.slice(0, 39)}…` : doing}${subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}`
  status.tooltip = `${v.title} — open the flow`
}

// ── the flow tab ──────────────────────────────────────────────────────────

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

function openFlow() {
  if (panel) {
    panel.reveal()
    return
  }
  panel = vscode.window.createWebviewPanel('agentFlow.flow', 'Agent Trace', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'out', 'webview')],
  })
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png')
  panel.webview.html = webviewHtml(panel.webview)
  panel.webview.onDidReceiveMessage((m: FromWebview) => void onMessage(m))
  panel.onDidDispose(() => (panel = undefined))
}

async function onMessage(m: FromWebview) {
  switch (m.type) {
    case 'ready':
      publish()
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
    case 'select':
      following = false
      show(m.id)
      return
    case 'accent':
      await vscode.workspace.getConfiguration('agentTrace').update('accentColor', m.accent, vscode.ConfigurationTarget.Global)
      return
    case 'follow':
      following = true
      refreshSessions()
      publish()
      return
  }
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
  /** Only sessions at work: Claude mid-turn, or subagents still running in the background. */
  getChildren() {
    return sessions
      .map((s) => (current && s.id === current.id ? { ...s, title: current.title, status: current.status } : s))
      .map((s) => (current && s.id === current.id ? { ...s, waiting: !!waitingText(current) } : s))
      .filter((s) => s.waiting || s.status === 'working' || (current?.id === s.id && current.subagents.some((a) => a.status === 'running')))
  }
  getTreeItem(s: SessionSummary) {
    const item = new vscode.TreeItem(s.title)
    const onScreen = current?.id === s.id
    item.description = `${s.waiting ? 'needs you · ' : s.status === 'working' ? 'working · ' : ''}${ago(s.last)}${onScreen ? (following ? ' · following' : ' · shown') : ''}`
    item.iconPath = s.waiting
      ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(s.status === 'working' ? 'sync~spin' : onScreen ? 'eye' : 'comment-discussion')
    item.tooltip = `${s.title}\n${s.id}`
    item.command = { command: 'agentFlow.showSession', title: 'Show', arguments: [s.id] }
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

class SetupTree implements vscode.TreeDataProvider<SetupNode> {
  readonly onDidChangeTreeData = setupChanged.event
  getChildren(node?: SetupNode): SetupNode[] {
    const items = setup?.items ?? []
    if (!node) return GROUPS.filter(([k]) => items.some((i) => inGroup(i, k))).map(([group]) => ({ group }))
    if ('group' in node) return items.filter((i) => inGroup(i, node.group)).map((item) => ({ item }))
    return []
  }
  getTreeItem(node: SetupNode) {
    if ('group' in node) {
      const [, label, icon] = GROUPS.find(([k]) => k === node.group)!
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

// ── wiring ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  ctx = context
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.command = 'agentFlow.open'
  status.show()

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
    if (ticks % 8 === 7 && refreshSetup()) publish()
    if (++ticks % 4 === 0 || liveMoved) {
      // A session that goes quiet changes status without a write: that counts too.
      const key = () => `${current?.id}|${sessions.map((s) => `${s.id}:${s.last}:${s.status}:${s.waiting}`).join(',')}`
      const before = key()
      refreshSessions()
      if (before !== key()) publish()
    }
    if (reader?.poll() || (reader && liveMoved)) {
      current = snap(reader)
      publish()
    } else if (current && current.status === 'working' && reader) {
      // Nothing new, but a long-silent turn may have gone stale.
      const next = snap(reader)
      if (next.status !== current.status) {
        current = next
        publish()
      }
    }
  }, 700)

  context.subscriptions.push(
    status,
    { dispose: () => clearInterval(timer) },
    vscode.window.registerTreeDataProvider('agentFlow.sessions', new SessionsTree()),
    vscode.window.registerTreeDataProvider('agentFlow.setup', new SetupTree()),
    vscode.window.registerFileDecorationProvider(new EditedFiles()),
    vscode.commands.registerCommand('agentFlow.open', openFlow),
    vscode.commands.registerCommand('agentFlow.follow', () => void onMessage({ type: 'follow' })),
    vscode.commands.registerCommand('agentFlow.showSession', (id: string) => {
      void onMessage({ type: 'select', id })
      openFlow()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentTrace.accentColor')) publish()
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshSessions()
      publish()
    }),
  )
}

export function deactivate() {}
