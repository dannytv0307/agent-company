// Reads what Claude Code loads for a folder: its CLAUDE.md files, agents, slash commands, skills, MCP
// servers, hooks, plugins and settings — from the folder's .claude/, from ~/.claude and from the enabled
// plugins. Only names, descriptions and a few safe facts are kept: never env values, headers or args.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Setup, SetupItem, SetupScope } from '../shared/model.ts'
import { claudeHome } from './claude.ts'

/** Until a session says which agents are built in (they vary by version), the usual ones. */
const BUILTIN_AGENTS: [string, string][] = [
  ['general-purpose', 'Researches, searches code and runs multi-step tasks.'],
  ['Explore', 'Read-only search across many files.'],
  ['Plan', 'Designs an implementation plan.'],
  ['claude-code-guide', 'Answers questions about Claude Code itself.'],
  ['statusline-setup', 'Sets up the status line.'],
]

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(file: string): any {
  const text = readText(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const list = (dir: string) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** The YAML front matter of a markdown file, flat keys only (enough for name / description / model / tools). */
function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    // Block scalars (">-", "|") and plain values continued on indented lines.
    const block = /^[>|][-+]?$/.test(value)
    if (block) value = ''
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += (value ? ' ' : '') + lines[++i].trim()
    meta[kv[1]] = value.replace(/^(["'])(.*)\1$/, '$2')
  }
  return { meta, body: text.slice(m[0].length) }
}

/** The first line of prose in a markdown body, for files without a description. */
const firstLine = (body: string) =>
  body
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l && !l.startsWith('<!--')) ?? ''

/** Markdown files under a folder, recursively, with their path relative to it. */
function markdownFiles(dir: string, depth = 3): string[] {
  const out: string[] = []
  for (const n of list(dir)) {
    const p = path.join(dir, n)
    if (n.toLowerCase().endsWith('.md')) out.push(p)
    else if (depth > 0 && isDir(p)) out.push(...markdownFiles(p, depth - 1))
  }
  return out
}

interface Source {
  scope: SetupScope
  plugin?: string
  /** Found, but Claude Code does not load it: why. */
  unloaded?: string
}

function agents(dir: string, src: Source, out: SetupItem[]) {
  for (const file of markdownFiles(dir)) {
    const { meta, body } = frontMatter(readText(file) ?? '')
    const facts = [meta.model && `model: ${meta.model}`, meta.tools && `tools: ${clip(meta.tools, 80)}`].filter(Boolean) as string[]
    out.push({ kind: 'agent', name: meta.name || path.basename(file, '.md'), ...src, description: clip(meta.description || firstLine(body), 240), path: file, facts })
  }
}

function commands(dir: string, src: Source, out: SetupItem[]) {
  for (const file of markdownFiles(dir)) {
    const { meta, body } = frontMatter(readText(file) ?? '')
    const folder = path.relative(dir, path.dirname(file)).split(path.sep).join('/')
    const facts = [folder && `folder: ${folder}`, meta['argument-hint'] && `args: ${meta['argument-hint']}`, meta.model && `model: ${meta.model}`].filter(Boolean) as string[]
    out.push({ kind: 'command', name: path.basename(file, '.md'), ...src, description: clip(meta.description || firstLine(body), 240), path: file, facts })
  }
}

/** <dir>/<skill>/SKILL.md, one level of grouping folders allowed. */
function skills(dir: string, src: Source, out: SetupItem[], depth = 1) {
  for (const n of list(dir)) {
    const sub = path.join(dir, n)
    if (!isDir(sub)) continue
    const file = path.join(sub, 'SKILL.md')
    if (existsSync(file)) {
      const { meta, body } = frontMatter(readText(file) ?? '')
      out.push({ kind: 'skill', name: meta.name || n, ...src, description: clip(meta.description || firstLine(body), 240), path: file })
    } else if (depth > 0) skills(sub, src, out, depth - 1)
  }
}

/** A server's kind and where it runs — never its args, env or headers, which may hold secrets. */
function mcpFacts(cfg: any): string[] {
  if (!cfg || typeof cfg !== 'object') return []
  const type = String(cfg.type ?? (cfg.url ? 'http' : 'stdio'))
  if (typeof cfg.url === 'string') {
    try {
      return [`${type} · ${new URL(cfg.url).host}`]
    } catch {
      return [type]
    }
  }
  return typeof cfg.command === 'string' ? [`${type} · ${path.basename(cfg.command)}`] : [type]
}

function mcpServers(servers: any, src: Source, file: string, out: SetupItem[]) {
  if (!servers || typeof servers !== 'object') return
  for (const [name, cfg] of Object.entries(servers)) out.push({ kind: 'mcp', name, ...src, path: file, facts: mcpFacts(cfg) })
}

function hooks(config: any, src: Source, file: string, out: SetupItem[]) {
  if (!config || typeof config !== 'object') return
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      const cmds = (Array.isArray(g?.hooks) ? g.hooks : []).map((h: any) => clip(String(h?.command ?? h?.prompt ?? h?.type ?? ''), 120)).filter(Boolean)
      const matcher = typeof g?.matcher === 'string' && g.matcher ? g.matcher : ''
      out.push({ kind: 'hook', name: matcher ? `${event} · ${clip(matcher, 60)}` : event, ...src, path: file, facts: cmds })
    }
  }
}

const samePath = (a: string, b: string) => path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase()

/** ~/.claude.json, cached by mtime: it is large and rewritten often. */
let globalCache: { mtime: number; json: any } | undefined
function globalConfig(): { file: string; json: any } {
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json')
  try {
    const mtime = statSync(file).mtimeMs
    if (globalCache?.mtime !== mtime) globalCache = { mtime, json: readJson(file) }
  } catch {
    globalCache = undefined
  }
  return { file, json: globalCache?.json }
}

/** Everything Claude Code loads when it runs in `folder`. */
export function readSetup(folder: string): Setup {
  const home = claudeHome()
  const dot = path.join(folder, '.claude')
  const items: SetupItem[] = []
  const project: Source = { scope: 'project' }
  const local: Source = { scope: 'local' }
  const user: Source = { scope: 'user' }

  // ── memory: CLAUDE.md here and in every folder above, the user's own, rules ──
  const memory = (file: string, src: Source, name?: string) => {
    if (!existsSync(file)) return
    const text = readText(file) ?? ''
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length
    items.push({ kind: 'memory', name: name ?? path.basename(file), ...src, description: clip(firstLine(text), 200), path: file, facts: [`${lines} lines`] })
  }
  memory(path.join(home, 'CLAUDE.md'), user, '~/.claude/CLAUDE.md')
  for (let dir = path.dirname(folder); path.dirname(dir) !== dir; dir = path.dirname(dir)) memory(path.join(dir, 'CLAUDE.md'), project, `../${path.basename(dir)}/CLAUDE.md`)
  memory(path.join(folder, 'CLAUDE.md'), project, 'CLAUDE.md')
  memory(path.join(dot, 'CLAUDE.md'), project, '.claude/CLAUDE.md')
  memory(path.join(folder, 'CLAUDE.local.md'), local, 'CLAUDE.local.md')
  for (const file of markdownFiles(path.join(dot, 'rules'))) memory(file, project, `rules/${path.relative(path.join(dot, 'rules'), file).split(path.sep).join('/')}`)
  for (const file of markdownFiles(path.join(home, 'rules'))) memory(file, user, `~/rules/${path.relative(path.join(home, 'rules'), file).split(path.sep).join('/')}`)

  // ── settings files, their hooks and the plugins they enable ──
  const settings: [string, Source, string][] = [
    [path.join(home, 'settings.json'), user, 'User settings'],
    [path.join(dot, 'settings.json'), project, 'Project settings'],
    [path.join(dot, 'settings.local.json'), local, 'Local settings'],
  ]
  const enabled = new Map<string, Source>()
  for (const [file, src, name] of settings) {
    const s = readJson(file)
    if (!s || typeof s !== 'object') continue
    const allow = Array.isArray(s.permissions?.allow) ? s.permissions.allow.length : 0
    const deny = Array.isArray(s.permissions?.deny) ? s.permissions.deny.length : 0
    const facts = [
      typeof s.model === 'string' && `model: ${s.model}`,
      typeof s.permissions?.defaultMode === 'string' && `mode: ${s.permissions.defaultMode}`,
      (allow || deny) && `${allow} allow · ${deny} deny rules`,
      s.env && typeof s.env === 'object' && `${Object.keys(s.env).length} env vars`,
    ].filter(Boolean) as string[]
    items.push({ kind: 'settings', name, ...src, path: file, facts })
    hooks(s.hooks, src, file, items)
    for (const [key, on] of Object.entries(s.enabledPlugins ?? {})) {
      if (on === true) enabled.set(key, src)
      else enabled.delete(key)
    }
  }

  // ── project and user definitions ──
  agents(path.join(dot, 'agents'), project, items)
  agents(path.join(home, 'agents'), user, items)
  commands(path.join(dot, 'commands'), project, items)
  commands(path.join(home, 'commands'), user, items)
  skills(path.join(dot, 'skills'), project, items)
  skills(path.join(home, 'skills'), user, items)
  for (const [name, desc] of BUILTIN_AGENTS) items.push({ kind: 'agent', name, scope: 'builtin', description: desc })

  // ── MCP servers: the folder's .mcp.json, ~/.claude.json (user-wide and for this folder) ──
  const mcpJson = path.join(folder, '.mcp.json')
  const g = globalConfig()
  const here = (g.json && (Object.entries(g.json.projects ?? {}).find(([p]) => samePath(p, folder))?.[1] as any)) || {}
  const first = items.length
  mcpServers(readJson(mcpJson)?.mcpServers, project, mcpJson, items)
  // The folder's .mcp.json servers start only once approved (here, or for all of them in the settings),
  // and any server can be turned off for this folder with /mcp.
  const listed = (k: string) => [here[k], ...settings.map(([f]) => readJson(f)?.[k])].flatMap((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []))
  const allProject = here.enableAllProjectMcpServers === true || settings.some(([f]) => readJson(f)?.enableAllProjectMcpServers === true)
  const approved = new Set(listed('enabledMcpjsonServers'))
  const refused = new Set(listed('disabledMcpjsonServers'))
  for (const i of items.slice(first)) {
    if (refused.has(i.name)) Object.assign(i, { status: 'disabled', error: 'Turned down for this folder: Claude Code does not start it here.' })
    else if (!allProject && !approved.has(i.name)) Object.assign(i, { status: 'approval', error: 'Claude Code asks you when it starts in this folder.' })
  }
  if (g.json) {
    mcpServers(g.json.mcpServers, user, g.file, items)
    mcpServers(here.mcpServers, local, g.file, items)
  }
  const off = new Set(Array.isArray(here.disabledMcpServers) ? here.disabledMcpServers.filter((x: unknown) => typeof x === 'string') : [])
  for (const i of items.slice(first)) if (off.has(i.name)) Object.assign(i, { status: 'disabled', error: 'Turned off for this folder (with /mcp).' })

  // ── enabled plugins and what they bring ──
  const installed = readJson(path.join(home, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  for (const [key, src] of enabled) {
    const entries: any[] = Array.isArray(installed[key]) ? installed[key] : []
    const entry = entries.find((e) => e?.projectPath && samePath(e.projectPath, folder)) ?? entries.find((e) => e?.scope === 'user') ?? entries[0]
    const name = key.split('@')[0]
    const dir = typeof entry?.installPath === 'string' ? entry.installPath : undefined
    const manifestFile = dir ? path.join(dir, '.claude-plugin', 'plugin.json') : undefined
    const manifest = manifestFile ? readJson(manifestFile) : undefined
    items.push({
      kind: 'plugin',
      name,
      scope: src.scope,
      description: clip(String(manifest?.description ?? ''), 240) || undefined,
      path: manifestFile && existsSync(manifestFile) ? manifestFile : undefined,
      facts: [key.includes('@') && `from ${key.split('@')[1]}`, entry?.version && `version ${entry.version}`, !dir && 'not installed'].filter(Boolean) as string[],
    })
    if (!dir || !isDir(dir)) continue
    pluginContent(dir, manifest, { scope: 'plugin', plugin: name }, items)
  }

  foundHere(folder, new Set([...enabled.keys()].map((k) => k.split('@')[0])), items)
  return { items }
}

/** Folders a plugin manifest names for one kind of content, on top of the default one. */
function manifestPaths(dir: string, manifest: any, key: string): string[] {
  const v = manifest?.[key]
  const extra = (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []).map((p: string) => path.resolve(dir, p))
  return [...new Set([path.join(dir, key), ...extra])]
}

/** What a plugin brings: agents, commands, skills, MCP servers, hooks — where its manifest says. */
function pluginContent(dir: string, manifest: any, from: Source, items: SetupItem[]) {
  for (const d of manifestPaths(dir, manifest, 'agents')) agents(d, from, items)
  for (const d of manifestPaths(dir, manifest, 'commands')) commands(d, from, items)
  for (const d of manifestPaths(dir, manifest, 'skills')) skills(d, from, items)
  const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json')
  const pluginMcp = typeof manifest?.mcpServers === 'string' ? path.resolve(dir, manifest.mcpServers) : path.join(dir, '.mcp.json')
  const mcp = manifest?.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : readJson(pluginMcp)
  // .mcp.json is either { mcpServers: {…} } or the servers themselves.
  mcpServers(mcp?.mcpServers ?? mcp, from, manifest?.mcpServers && typeof manifest.mcpServers === 'object' ? manifestFile : pluginMcp, items)
  const hooksFile = typeof manifest?.hooks === 'string' ? path.resolve(dir, manifest.hooks) : path.join(dir, 'hooks', 'hooks.json')
  hooks(readJson(hooksFile)?.hooks, from, hooksFile, items)
}

/**
 * Claude Code configuration that sits in this folder but that Claude Code does not load from here:
 * a plugin's source (loaded only once installed), or agents/, commands/, skills/, rules/ kept at the root
 * of a repo of configs (loaded only from .claude/ or ~/.claude). Shown apart, with what to do.
 */
function foundHere(folder: string, enabledPlugins: Set<string>, items: SetupItem[]) {
  const manifest = readJson(path.join(folder, '.claude-plugin', 'plugin.json'))
  const covered = new Set<string>()
  if (manifest && typeof manifest === 'object') {
    const name = String(manifest.name ?? path.basename(folder))
    for (const k of ['agents', 'commands', 'skills', 'hooks']) for (const d of manifestPaths(folder, manifest, k)) covered.add(path.resolve(d))
    if (!enabledPlugins.has(name))
      pluginContent(folder, manifest, { scope: 'project', plugin: name, unloaded: `Part of the plugin “${name}”, which is this folder: Claude Code loads a plugin only once it is installed. To use it, run /plugin marketplace add ./ and then /plugin install ${name}.` }, items)
  }
  const loose = (dir: string, what: string) =>
    `In ./${dir}, where Claude Code does not look: it loads ${what} from .claude/${dir} (this project) or ~/.claude/${dir} (every project). Copy it there to use it.`
  const at = (d: string) => path.join(folder, d)
  if (!covered.has(path.resolve(at('agents')))) agents(at('agents'), { scope: 'project', unloaded: loose('agents', 'agents') }, items)
  if (!covered.has(path.resolve(at('commands')))) commands(at('commands'), { scope: 'project', unloaded: loose('commands', 'slash commands') }, items)
  if (!covered.has(path.resolve(at('skills')))) skills(at('skills'), { scope: 'project', unloaded: loose('skills', 'skills') }, items)
  for (const file of markdownFiles(at('rules'), 1)) {
    const text = readText(file) ?? ''
    items.push({ kind: 'memory', name: `rules/${path.basename(file)}`, scope: 'project', description: clip(firstLine(text), 200), path: file, unloaded: loose('rules', 'rules') })
  }
  if (!covered.has(path.resolve(at('hooks')))) {
    const file = path.join(at('hooks'), 'hooks.json')
    hooks(readJson(file)?.hooks, { scope: 'project', unloaded: `In ./hooks/hooks.json, which Claude Code does not read: hooks go in the "hooks" of .claude/settings.json (this project) or ~/.claude/settings.json.` }, file, items)
  }
}
