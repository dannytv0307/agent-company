// The setup (what Claude Code loads in this folder) against the turn on screen: which agent definitions,
// commands, skills and MCP servers are in use, by whom, and whether that work is still going.
import type { SessionView, Setup, SetupItem, SetupKind, SetupScope } from '../../shared/model.ts'

export const GROUPS: { kind: SetupKind; title: string; glyph: string; hint: string; always?: boolean }[] = [
  { kind: 'memory', title: 'Memory', glyph: '¶', hint: 'No CLAUDE.md — add one at the folder root', always: true },
  { kind: 'agent', title: 'Agents', glyph: '✦', hint: 'Add agents in .claude/agents/*.md', always: true },
  { kind: 'command', title: 'Slash commands', glyph: '/', hint: 'Add commands in .claude/commands/*.md', always: true },
  { kind: 'skill', title: 'Skills', glyph: '◆', hint: 'Add skills in .claude/skills/<name>/SKILL.md', always: true },
  { kind: 'mcp', title: 'MCP servers', glyph: '⧉', hint: 'Add servers in .mcp.json', always: true },
  { kind: 'hook', title: 'Hooks', glyph: '↯', hint: '' },
  { kind: 'plugin', title: 'Plugins', glyph: '⬡', hint: '' },
  { kind: 'settings', title: 'Settings', glyph: '⚙', hint: '' },
]
export const groupOf = (kind: SetupKind) => GROUPS.find((g) => g.kind === kind)!

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
}

export const keyOf = (i: SetupItem) => `${i.kind}|${i.scope}|${i.plugin ?? ''}|${i.name}|${i.path ?? ''}`

const ORDER: SetupScope[] = ['project', 'local', 'user', 'plugin', 'builtin', 'connector']

export function scopeLabel(i: SetupItem): string {
  if (i.scope === 'plugin') return i.plugin ?? 'plugin'
  if (i.scope === 'builtin') return 'built-in'
  return i.scope
}

/** How an item is named on screen: commands with their slash, claude.ai connectors without the prefix. */
export function displayName(i: SetupItem): string {
  if (i.kind === 'command') return `/${i.name}`
  if (i.scope === 'connector') return i.name.replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return i.name
}

/** Items of a group, those in use first (live ones on top), then by where they come from. */
export function sorted(model: SetupModel, kind: SetupKind): SetupItem[] {
  const rank = (i: SetupItem) => {
    const u = model.uses.get(keyOf(i))
    return u?.some((x) => x.live) ? 0 : u?.length ? 1 : 2
  }
  return model.items
    .filter((i) => i.kind === kind)
    .map((item, n) => ({ item, n }))
    .sort((a, b) => rank(a.item) - rank(b.item) || ORDER.indexOf(a.item.scope) - ORDER.indexOf(b.item.scope) || a.n - b.n)
    .map((x) => x.item)
}

export function buildSetup(view: SessionView, setup: Setup | undefined): SetupModel {
  const items = [...(setup?.items ?? [])]
  const uses = new Map<string, Use[]>()
  const working = view.status === 'working'

  const use = (item: SetupItem, u: Use) => {
    const list = uses.get(keyOf(item)) ?? []
    const same = list.find((x) => x.node === u.node)
    if (same) same.live ||= u.live
    else list.push(u)
    uses.set(keyOf(item), list)
  }
  /** By its name as Claude Code calls it: "name", or "plugin:name" for a plugin's. Project before user. */
  const find = (kind: SetupKind, called: string) => {
    const c = called.trim().toLowerCase()
    const mine = items.filter((i) => i.kind === kind)
    return (
      mine.find((i) => i.plugin && `${i.plugin}:${i.name}`.toLowerCase() === c) ??
      mine.find((i) => i.name.toLowerCase() === c) ??
      (c.includes(':') ? mine.find((i) => c.endsWith(`:${i.name.toLowerCase()}`)) : undefined)
    )
  }
  const add = (item: SetupItem) => {
    items.push(item)
    return item
  }

  for (const m of items.filter((i) => i.kind === 'memory')) use(m, { node: 'agent:main', live: false, why: 'Loaded into Claude’s context' })

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
    const who = main ? 'Claude' : agent.type
    for (const s of agent.steps) {
      if (s.tool === 'Skill' && s.label) {
        const def = find('skill', s.label) ?? add({ kind: 'skill', name: s.label, scope: 'builtin' })
        use(def, { node, live: running, why: `${who} loaded it` })
      } else if (s.tool.includes(' · ')) {
        const server = s.tool.split(' · ')[0]
        const def =
          items.find((i) => i.kind === 'mcp' && (i.name === server || (i.plugin && server === `plugin_${i.plugin}_${i.name}`))) ??
          add({ kind: 'mcp', name: server, scope: 'connector', description: 'Used, but not configured in any file here (a claude.ai connector or a managed server).' })
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
  return { items, uses, byNode }
}

/** "project agent", "user skill", "built-in command", "remotion skill"… */
export function originOf(i: SetupItem): string {
  const what = i.kind === 'agent' ? 'agent' : i.kind === 'command' ? 'command' : i.kind === 'skill' ? 'skill' : i.kind
  return `${scopeLabel(i)} ${what}`
}
