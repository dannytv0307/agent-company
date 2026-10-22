// Agent Flow: shows what Claude Code is doing in this folder, live. It reads Claude Code's own session
// transcripts — nothing to configure, nothing sent anywhere — and draws the current turn in an editor
// tab: the prompt, the main agent, the subagents it spawns, each tool call, the files it touches and
// what comes out. A sidebar lists the folder's sessions; the status bar says what is running now.
import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FromWebview, SessionSummary, SessionView, Setup, SetupItem, SetupKind, ToWebview } from '../shared/model.ts'
import { listSessions, projectDirFor, SessionReader } from './claude.ts'
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

function show(id: string) {
  const s = sessions.find((x) => x.id === id)
  if (!s) return
  try {
    reader = new SessionReader(s.id, s.file)
    current = reader.snapshot()
  } catch (e) {
    reader = undefined
    current = undefined
    void vscode.window.showWarningMessage(`Agent Flow could not read session ${id}: ${e instanceof Error ? e.message : String(e)}`)
  }
  publish()
}

// ── telling everyone ──────────────────────────────────────────────────────

function publish() {
  // The list shows the session on screen with its exact status, the rest by how recently they moved.
  const list = sessions.map((s) => (current && s.id === current.id ? { ...s, title: current.title, status: current.status } : s))
  const msg: ToWebview = { type: 'state', sessions: list.map(({ file: _f, ...s }) => s), current, following, folder, claudeDir, setup }
  void panel?.webview.postMessage(msg)
  changed.fire()
  updateStatus()
}

function updateStatus() {
  const v = current
  const running = v?.status === 'working'
  if (!running) {
    status.text = '$(type-hierarchy) Agent Flow'
    status.tooltip = v ? `Claude Code is idle — ${v.title}` : 'Agent Flow: no Claude Code session in this folder yet'
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
  panel = vscode.window.createWebviewPanel('agentFlow.flow', 'Agent Flow', vscode.ViewColumn.Active, {
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
  getChildren() {
    return sessions.map((s) => (current && s.id === current.id ? { ...s, title: current.title, status: current.status } : s))
  }
  getTreeItem(s: SessionSummary) {
    const item = new vscode.TreeItem(s.title)
    const onScreen = current?.id === s.id
    item.description = `${s.status === 'working' ? 'working · ' : ''}${ago(s.last)}${onScreen ? (following ? ' · following' : ' · shown') : ''}`
    item.iconPath = new vscode.ThemeIcon(s.status === 'working' ? 'sync~spin' : onScreen ? 'eye' : 'comment-discussion')
    item.tooltip = `${s.title}\n${s.id}`
    item.command = { command: 'agentFlow.showSession', title: 'Show', arguments: [s.id] }
    return item
  }
}

// ── the setup list ────────────────────────────────────────────────────────

const GROUPS: [SetupKind, string, string][] = [
  ['memory', 'Memory (CLAUDE.md)', 'book'],
  ['agent', 'Agents', 'hubot'],
  ['command', 'Slash commands', 'terminal'],
  ['skill', 'Skills', 'sparkle'],
  ['mcp', 'MCP servers', 'plug'],
  ['hook', 'Hooks', 'zap'],
  ['plugin', 'Plugins', 'extensions'],
  ['settings', 'Settings', 'gear'],
]
const scopeLabel = (i: SetupItem) => (i.scope === 'plugin' ? `plugin ${i.plugin}` : i.scope === 'builtin' ? 'built-in' : i.scope)

type SetupNode = { group: SetupKind } | { item: SetupItem }

class SetupTree implements vscode.TreeDataProvider<SetupNode> {
  readonly onDidChangeTreeData = setupChanged.event
  getChildren(node?: SetupNode): SetupNode[] {
    const items = setup?.items ?? []
    if (!node) return GROUPS.filter(([k]) => items.some((i) => i.kind === k)).map(([group]) => ({ group }))
    if ('group' in node) return items.filter((i) => i.kind === node.group).map((item) => ({ item }))
    return []
  }
  getTreeItem(node: SetupNode) {
    if ('group' in node) {
      const [, label, icon] = GROUPS.find(([k]) => k === node.group)!
      const t = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed)
      t.description = String(setup?.items.filter((i) => i.kind === node.group).length ?? 0)
      t.iconPath = new vscode.ThemeIcon(icon)
      return t
    }
    const i = node.item
    const t = new vscode.TreeItem(i.kind === 'command' ? `/${i.name}` : i.name)
    t.description = scopeLabel(i)
    t.tooltip = [i.name, i.description, ...(i.facts ?? []), i.path].filter(Boolean).join('\n')
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
  let ticks = 0
  const timer = setInterval(() => {
    if (ticks % 8 === 7 && refreshSetup()) publish()
    if (++ticks % 4 === 0) {
      const before = `${current?.id}|${sessions.map((s) => `${s.id}:${s.last}`).join(',')}`
      refreshSessions()
      if (before !== `${current?.id}|${sessions.map((s) => `${s.id}:${s.last}`).join(',')}`) publish()
    }
    if (reader?.poll()) {
      current = reader.snapshot()
      publish()
    } else if (current && current.status === 'working' && reader) {
      // Nothing new, but a long-silent turn may have gone stale.
      const next = reader.snapshot()
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshSessions()
      publish()
    }),
  )
}

export function deactivate() {}
