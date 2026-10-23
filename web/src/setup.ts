// The setup (what Claude Code loads in this folder) against the turn on screen: which agent definitions,
// commands, skills and MCP servers are in use, by whom, and whether that work is still going.
//
// Two sources, one truth: the extension's file scan says what is defined where; the session's own
// listings (view.loaded) say what Claude Code actually loaded. When the session tells, it wins — every
// way of configuring Claude Code resolves to the same listings — and the scan explains the rest. For MCP
// servers a third, fresher source wins over both: the Claude Code run here, asked how they are now.
import type { Engine, McpLive, SessionView, Setup, SetupItem, SetupKind, SetupScope } from '../../shared/model.ts'

/** The cards of the setup: one per kind, and one for what is here but not loaded. */
export type GroupKey = SetupKind | 'found'

export const GROUPS: { kind: GroupKey; title: string; glyph: string; hint: string; always?: boolean }[] = [
  { kind: 'memory', title: 'Memory', glyph: '¶', hint: 'No CLAUDE.md — add one at the folder root', always: true },
  { kind: 'agent', title: 'Agents', glyph: '✦', hint: 'Add agents in .claude/agents/*.md', always: true },
  { kind: 'command', title: 'Slash commands', glyph: '/', hint: 'Add commands in .claude/commands/*.md', always: true },
  { kind: 'skill', title: 'Skills', glyph: '◆', hint: 'Add skills in .claude/skills/<name>/SKILL.md', always: true },
  { kind: 'mcp', title: 'MCP servers', glyph: '⧉', hint: 'Add servers in .mcp.json', always: true },
  { kind: 'hook', title: 'Hooks', glyph: '↯', hint: '' },
  { kind: 'plugin', title: 'Plugins', glyph: '⬡', hint: '' },
  { kind: 'settings', title: 'Settings', glyph: '⚙', hint: '' },
  { kind: 'found', title: 'Here, not loaded', glyph: '⊘', hint: '' },
]
export const groupOf = (kind: GroupKey) => GROUPS.find((g) => g.kind === kind)!

/** Codex's setup has no agents or slash commands of its own: only what it has is shown, plus these. */
const CODEX_ALWAYS: GroupKey[] = ['memory', 'skill', 'mcp']
const CODEX_HINTS: Partial<Record<GroupKey, string>> = {
  memory: 'No AGENTS.md — add one at the repo root',
  skill: 'Add skills in .agents/skills/<name>/SKILL.md',
  mcp: 'Add servers in ~/.codex/config.toml ([mcp_servers.<name>])',
}
/** A card shown even when empty, for this engine. */
export const alwaysShown = (g: (typeof GROUPS)[number], engine: Engine) => !!g.always && (engine !== 'codex' || CODEX_ALWAYS.includes(g.kind))
/** What an empty card suggests, for this engine. */
export const hintOf = (kind: GroupKey, engine: Engine) => (engine === 'codex' ? (CODEX_HINTS[kind] ?? '') : groupOf(kind).hint)
/** "Claude factory" or "Codex factory". */
export const factoryName = (engine: Engine) => (engine === 'codex' ? 'Codex factory' : 'Claude factory')

/** Something on the canvas an item is used by. `node` is the flow node, or '' when nothing to point at. */
export interface Use {
  node: string
  live: boolean
  why: string
}

export interface SetupModel {
  items: SetupItem[]
  uses: Map<string, Use[]>
  /** The other way round: for a flow node, the setup items it runs on (its agent definition, its command…). */
  byNode: Map<string, SetupItem[]>
  /** Checked against the session's own listings (or as the agent reports it), or only read from the files. */
  source: 'session' | 'files'
  /** Whose setup: Claude Code's or Codex's. */
  engine: Engine
  /** MCP servers: as the Claude Code run here reports them now (and when it did), else as the session started. */
  mcp: { at?: number; reconnecting: string[] }
}

/** The MCP side of the chat on screen, when there is one. */
export interface McpNow {
  servers?: McpLive[]
  at?: number
  reconnecting?: string[]
}

export const keyOf = (i: SetupItem) => `${i.kind}|${i.scope}|${i.plugin ?? ''}|${i.name}|${i.path ?? ''}`

const ORDER: SetupScope[] = ['project', 'local', 'user', 'plugin', 'builtin', 'connector', 'session']
const KINDS: SetupKind[] = ['agent', 'command', 'skill', 'memory', 'hook', 'mcp', 'plugin', 'settings']

export function scopeLabel(i: SetupItem): string {
  if (i.scope === 'plugin') return i.plugin ?? 'plugin'
  if (i.scope === 'builtin') return 'built-in'
  if (i.scope === 'connector') return i.name.startsWith('claude_ai_') ? 'claude.ai' : 'connector'
  return i.scope
}

/** What an item is, in a word: for the "not loaded" card, where kinds mix. */
export const kindLabel = (i: SetupItem) => (i.kind === 'memory' ? 'rule' : i.kind === 'mcp' ? 'MCP' : i.kind)

/** How an item is named on screen: commands with their slash, claude.ai connectors without the prefix. */
export function displayName(i: SetupItem): string {
  if (i.kind === 'command') return `/${i.name}`
  if (i.scope === 'connector') return i.name.replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return i.name
}

const inGroup = (i: SetupItem, g: GroupKey) => (g === 'found' ? !!i.unloaded : i.kind === g && !i.unloaded)

/** MCP servers by where they are configured: this folder's first, then the user's, then the rest. */
const MCP_ORDER: SetupScope[] = ['project', 'local', 'user', 'plugin', 'connector', 'session', 'builtin']

/**
 * Items of a card, those in use first (live ones on top), then loaded ones, then by where they come from.
 * MCP servers go by where they come from first (project, user, then the rest), and within that the ones
 * in use, then the ones in trouble.
 */
export function sorted(model: SetupModel, group: GroupKey): SetupItem[] {
  const rank = (i: SetupItem) => {
    const u = model.uses.get(keyOf(i))
    return u?.some((x) => x.live) ? 0 : u?.length ? 1 : i.status === 'failed' || i.status === 'needs-auth' ? 2 : 3
  }
  return model.items
    .filter((i) => inGroup(i, group))
    .map((item, n) => ({ item, n }))
    .sort(
      (a, b) =>
        (group === 'found' ? KINDS.indexOf(a.item.kind) - KINDS.indexOf(b.item.kind) : 0) ||
        (group === 'mcp' ? MCP_ORDER.indexOf(a.item.scope) - MCP_ORDER.indexOf(b.item.scope) : 0) ||
        rank(a.item) - rank(b.item) ||
        ORDER.indexOf(a.item.scope) - ORDER.indexOf(b.item.scope) ||
        a.n - b.n,
    )
    .map((x) => x.item)
}

/** By its name as Claude Code calls it: "name", or "plugin:name" for a plugin's. Project before user. */
function finder(items: SetupItem[]) {
  return (kind: SetupKind, called: string, loadedOnly = true) => {
    const c = called.trim().toLowerCase()
    const mine = items.filter((i) => i.kind === kind && (!loadedOnly || !i.unloaded))
    return (
      mine.find((i) => i.plugin && `${i.plugin}:${i.name}`.toLowerCase() === c) ??
      mine.find((i) => i.name.toLowerCase() === c) ??
      (c.includes(':') ? mine.find((i) => c.endsWith(`:${i.name.toLowerCase()}`)) : undefined)
    )
  }
}

/** "plugin:playwright:playwright" and "plugin_playwright_playwright" alike. */
const mcpKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')
const serverOf = (i: SetupItem) => (i.plugin ? mcpKey(`plugin:${i.plugin}:${i.name}`) : mcpKey(i.name))
/** An MCP server's name to reconnect it by: as Claude Code reported it, or as near as the files say. */
export const serverName = (i: SetupItem) => i.server ?? (i.plugin ? `plugin:${i.plugin}:${i.name}` : i.name)

/** Where a server of the same name wins: Claude Code takes local over project over user. */
const MCP_WINS: SetupScope[] = ['local', 'project', 'user']

/** A server defined in two places runs from one: the other is marked so, and gets no status. */
function shadowMcp(items: SetupItem[]) {
  const byKey = new Map<string, SetupItem[]>()
  for (const i of items) if (i.kind === 'mcp' && !i.unloaded && MCP_WINS.includes(i.scope)) byKey.set(serverOf(i), [...(byKey.get(serverOf(i)) ?? []), i])
  for (const same of byKey.values()) {
    if (same.length < 2) continue
    const [win, ...rest] = [...same].sort((a, b) => MCP_WINS.indexOf(a.scope) - MCP_WINS.indexOf(b.scope))
    for (const i of rest) i.unloaded = `Also defined as a ${win.scope} server: Claude Code runs that one, not this.`
  }
}

/** Built in, configured by no one: Claude Code's own link to the editor, and Agent Trace's hand-over to Codex. */
const IDE = /^(claude-vscode|ide|agent_trace)$/
const BUILTIN_MCP: Record<string, string> = {
  agent_trace: 'Agent Trace’s hand-over: lets Claude give Codex a task (ask_codex). Only in chats run here, with hand-over on.',
}

/** MCP servers' connections, by name as Claude Code gives it; servers no file here explains are added. */
function applyMcp(items: SetupItem[], list: (McpLive & { tools?: number })[], live = false) {
  for (const m of list) {
    const key = mcpKey(m.name)
    if (IDE.test(key)) {
      const ide = items.find((i) => i.kind === 'mcp' && i.scope === 'builtin' && i.name === key)
      if (ide) Object.assign(ide, { status: m.status, error: m.error, loaded: m.status === 'connected' })
      else items.push({ kind: 'mcp', name: key, scope: 'builtin', status: m.status, error: m.error, loaded: m.status === 'connected', description: BUILTIN_MCP[key] ?? 'Claude Code’s own link to your editor (open files, selection, diagnostics). Built in.' })
      continue
    }
    const fields = { status: m.status, error: m.error, loaded: m.status === 'connected', ...(live ? { server: m.name, tools: m.tools } : {}) }
    const hit = items.find((i) => i.kind === 'mcp' && !i.unloaded && serverOf(i) === key)
    if (hit) Object.assign(hit, fields)
    else {
      const plugin = key.match(/^plugin_([^_]+(?:-[^_]+)*)_(.+)$/)
      const account = /^claude[._ ]?ai/i.test(m.name) || m.scope === 'claudeai'
      items.push({
        kind: 'mcp',
        name: plugin ? plugin[2] : account ? key : m.name,
        plugin: plugin?.[1],
        scope: plugin ? 'plugin' : account || !live ? 'connector' : 'session',
        ...fields,
        description: plugin
          ? `From the plugin “${plugin[1]}”.`
          : account || !live
            ? 'Connected through your account (a claude.ai connector) or managed for you; no file here configures it.'
            : `Configured outside this folder’s files${m.scope ? ` (${m.scope})` : ''}.`,
      })
    }
  }
}

/** Check the file scan against what the session says it loaded, adding what the files do not explain. */
function reconcile(items: SetupItem[], view: SessionView) {
  const L = view.loaded
  if (!L) return
  const find = finder(items)
  const notInSession = 'Defined here, but not loaded in this session: Claude Code skipped it (check its front matter), or it was added after the session started.'

  // Skills: the listing is complete. Commands may be listed with them.
  if (L.skills.length) {
    const listed = new Set(L.skills.map((s) => s.toLowerCase()))
    for (const i of items) {
      if (i.unloaded || (i.kind !== 'skill' && i.kind !== 'command')) continue
      const on = listed.has(i.name.toLowerCase()) || (!!i.plugin && listed.has(`${i.plugin}:${i.name}`.toLowerCase()))
      if (on) i.loaded = true
      else if (i.kind === 'skill') i.unloaded = notInSession
    }
    for (const name of L.skills) {
      if (find('skill', name) || find('command', name)) continue
      const [plugin, bare] = name.includes(':') ? [name.slice(0, name.indexOf(':')), name.slice(name.indexOf(':') + 1)] : [undefined, name]
      items.push({ kind: 'skill', name: bare, plugin, scope: plugin ? 'plugin' : 'session', loaded: true, description: plugin ? `From the plugin “${plugin}”.` : 'Loaded in this session, from a place no file here explains.' })
    }
  }

  // Agents: built-in ones as the session lists them, custom ones checked.
  if (L.agents.length) {
    const types = new Set(L.agents.map((t) => t.toLowerCase()))
    const builtin = new Set(L.builtinAgents.map((t) => t.toLowerCase()))
    for (let n = items.length - 1; n >= 0; n--) {
      const i = items[n]
      if (i.kind !== 'agent' || i.unloaded) continue
      if (i.scope === 'builtin') {
        if (builtin.size && !builtin.has(i.name.toLowerCase())) items.splice(n, 1) // not in this version
        else i.loaded = true
      } else if (types.has(i.name.toLowerCase()) || (!!i.plugin && types.has(`${i.plugin}:${i.name}`.toLowerCase()))) i.loaded = true
      else i.unloaded = notInSession
    }
    for (const t of L.agents) {
      if (find('agent', t)) continue
      const plugin = t.includes(':') ? t.slice(0, t.indexOf(':')) : undefined
      items.push({ kind: 'agent', name: plugin ? t.slice(plugin.length + 1) : t, plugin, scope: builtin.has(t.toLowerCase()) ? 'builtin' : plugin ? 'plugin' : 'session', loaded: true })
    }
  }

  // MCP servers: how each one's connection went (a server the session did not list keeps what the files say).
  applyMcp(items, L.mcp)

  // Plugins: any the session's skills, agents or servers come from, even if no settings file here enables it.
  const plugins = new Set(items.filter((i) => i.scope === 'plugin' && i.loaded && i.plugin).map((i) => i.plugin!))
  for (const p of plugins) {
    const known = items.find((i) => i.kind === 'plugin' && i.name === p)
    if (known) known.loaded = true
    else items.push({ kind: 'plugin', name: p, scope: 'session', loaded: true, description: 'Enabled for you outside this folder’s settings files (by your account or organisation).' })
  }

  // Instruction files the session reported (auto memory, nested CLAUDE.md…).
  for (const f of L.instructions) {
    const same = items.find((i) => i.kind === 'memory' && i.path && i.path.toLowerCase() === f.path.toLowerCase())
    if (same) same.loaded = true
    else {
      const name = f.type === 'AutoMem' ? 'Auto memory' : (f.path.split(/[\\/]/).slice(-2).join('/') ?? f.path)
      items.push({ kind: 'memory', name, scope: f.type === 'AutoMem' ? 'user' : /local/i.test(f.type) ? 'local' : /user/i.test(f.type) ? 'user' : 'project', path: f.path, loaded: true })
    }
  }
}

export function buildSetup(view: SessionView, setup: Setup | undefined, now?: McpNow): SetupModel {
  const items = (setup?.items ?? []).map((i) => ({ ...i }))
  shadowMcp(items)
  reconcile(items, view)
  if (now?.servers) applyMcp(items, now.servers, true)
  // Being reconnected: connecting again, whatever went before.
  for (const i of items) if (i.server && now?.reconnecting?.includes(i.server)) Object.assign(i, { status: 'pending', error: undefined })
  const uses = new Map<string, Use[]>()
  const working = view.status === 'working'
  const find = finder(items)

  const use = (item: SetupItem, u: Use) => {
    const list = uses.get(keyOf(item)) ?? []
    const same = list.find((x) => x.node === u.node)
    if (same) same.live ||= u.live
    else list.push(u)
    uses.set(keyOf(item), list)
  }
  const add = (item: SetupItem) => {
    items.push(item)
    return item
  }

  for (const m of items.filter((i) => i.kind === 'memory' && !i.unloaded)) use(m, { node: 'agent:main', live: false, why: `Loaded into ${view.main.type}’s context` })

  for (const a of view.subagents) {
    const def = find('agent', a.type) ?? add({ kind: 'agent', name: a.type, scope: 'builtin' })
    use(def, { node: `agent:${a.id}`, live: a.status === 'running', why: a.title || a.type })
  }

  const cmd = view.turn?.command
  if (cmd) {
    const def = find('command', cmd.name) ?? find('skill', cmd.name) ?? add({ kind: 'command', name: cmd.name, scope: 'builtin', description: 'Built into Claude Code.' })
    use(def, { node: 'command', live: working, why: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ''}` })
  }

  for (const agent of [view.main, ...view.subagents]) {
    const main = agent.kind === 'main'
    const node = main ? 'agent:main' : `agent:${agent.id}`
    const running = agent.status === 'running' && (!main || working)
    const who = main ? view.main.type : agent.type
    for (const s of agent.steps) {
      // Codex uses a skill by reading its SKILL.md.
      const skillFile = s.file && /SKILL\.md$/i.test(s.file) ? items.find((i) => i.kind === 'skill' && i.path && i.path.toLowerCase() === s.file!.toLowerCase()) : undefined
      if (skillFile) use(skillFile, { node, live: running && s.status === 'running', why: `${who} read it` })
      if (s.tool === 'Skill' && s.label) {
        const def = find('skill', s.label) ?? add({ kind: 'skill', name: s.label, scope: 'builtin' })
        use(def, { node, live: running, why: `${who} loaded it` })
      } else if (s.tool.includes(' · ')) {
        const server = s.tool.split(' · ')[0]
        const def =
          items.find((i) => i.kind === 'mcp' && !i.unloaded && serverOf(i) === mcpKey(server)) ??
          add(IDE.test(mcpKey(server)) ? { kind: 'mcp', name: mcpKey(server), scope: 'builtin', description: BUILTIN_MCP[mcpKey(server)] } : { kind: 'mcp', name: server, scope: 'connector', description: 'Used, but not configured in any file here (a claude.ai connector or a managed server).' })
        use(def, { node, live: s.status === 'running', why: `${who}: ${s.tool.split(' · ')[1] ?? s.tool}` })
      }
    }
  }

  const byNode = new Map<string, SetupItem[]>()
  for (const i of items) for (const u of uses.get(keyOf(i)) ?? []) if (u.node && i.kind !== 'memory') byNode.set(u.node, [...(byNode.get(u.node) ?? []), i])

  // A plugin is in use when anything it brings is.
  for (const p of items.filter((i) => i.kind === 'plugin')) {
    const from = items.filter((i) => i.plugin === p.name && uses.has(keyOf(i)))
    for (const i of from) use(p, { node: '', live: !!uses.get(keyOf(i))?.some((u) => u.live), why: `${groupOf(i.kind).title.replace(/s$/, '')} ${displayName(i)}` })
  }
  return { items, uses, byNode, source: view.loaded || setup?.resolved ? 'session' : 'files', engine: setup?.engine ?? view.engine ?? 'claude', mcp: { at: now?.servers ? now.at : undefined, reconnecting: now?.reconnecting ?? [] } }
}

/** "project agent", "user skill", "built-in command", "remotion skill"… */
export function originOf(i: SetupItem): string {
  const what = i.kind === 'agent' ? 'agent' : i.kind === 'command' ? 'command' : i.kind === 'skill' ? 'skill' : i.kind
  return `${scopeLabel(i)} ${what}`
}

export const STATUS_TEXT: Record<NonNullable<SetupItem['status']>, string> = {
  connected: 'Connected',
  failed: 'Failed to connect',
  'needs-auth': 'Needs sign-in',
  pending: 'Connecting…',
  disabled: 'Disabled',
  approval: 'Waiting for your approval',
}
