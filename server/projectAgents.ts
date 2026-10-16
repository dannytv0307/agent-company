// A project's team lives in its repo as agent files: .claude/agents/<id>.md (Claude Code) and .codex/agents/<id>.md (Codex).
// Approved hires are written there for the owner to keep and edit. Removed agents are moved aside, never deleted.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { HireSpec, OrgDef, ProjectRef } from '../shared/types.ts'
import { CREATED_MARK, rescan } from './projectScan.ts'
import { slug } from './orgStore.ts'

const agentsDir = (project: ProjectRef, runtime: 'claude' | 'codex' = 'claude') => path.join(project.dir, `.${runtime}`, 'agents')

// Claude Code model aliases; anything else falls back to the session's default model.
const CLAUDE_MODEL = /^(opus|sonnet|haiku|inherit|claude-[\w.-]+)$/

function agentFile(spec: HireSpec, id: string, org: OrgDef): string {
  const codex = spec.runtime === 'codex'
  const fm = [
    '---',
    `name: ${id}`,
    `description: ${JSON.stringify(spec.description.trim())}`,
    !codex && spec.tools?.length ? `tools: ${spec.tools.join(', ')}` : null,
    // Codex agents keep Codex model names; a Claude alias there would mean nothing.
    spec.model && (codex ? !CLAUDE_MODEL.test(spec.model) : CLAUDE_MODEL.test(spec.model)) ? `model: ${spec.model}` : null,
    codex ? `sandbox: ${spec.sandbox ?? 'workspace-write'}` : null,
    '---',
  ].filter((l) => l !== null)
  const day = new Date().toISOString().slice(0, 10)
  return [
    fm.join('\n'),
    `<!-- ${CREATED_MARK} on ${day} for ${org.owner.name.en}. This file is yours: edit it freely. -->`,
    '',
    spec.prompt?.trim() ?? '',
    '',
    'Follow this repo\'s CLAUDE.md and use its skills where they fit.',
    'If your task came with an id like [T3], start your final report with it. When you finish, reply with a short report (max 6 lines): what you did, files touched, open issues.',
    '',
  ].join('\n')
}

/** The file that defines agent `id` in this repo (by file name, else by its `name:` field), in either engine's folder. */
function fileOf(project: ProjectRef, id: string): string | undefined {
  if (!/^[a-z0-9][\w-]*$/i.test(id)) return undefined
  const named = new RegExp(`^name:\\s*["']?${id}["']?\\s*$`, 'm')
  for (const dir of [agentsDir(project, 'claude'), agentsDir(project, 'codex')]) {
    if (!existsSync(dir)) continue
    const direct = path.join(dir, `${id}.md`)
    if (existsSync(direct)) return direct
    const found = readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => path.join(dir, n))
      .find((f) => named.test(readFileSync(f, 'utf8')))
    if (found) return found
  }
  return undefined
}

/** Write approved hires into the repo. Existing files are never overwritten: a clashing id gets a suffix. */
export function writeAgents(org: OrgDef, project: ProjectRef, specs: HireSpec[], reserved: string[]): string[] {
  if (!project.exists) throw new Error(`The folder of project "${project.name}" does not exist: ${project.dir}`)
  const taken = new Set([...reserved, ...(project.scan?.agents.map((a) => a.id) ?? [])])
  const ids: string[] = []
  for (const spec of specs) {
    const dir = agentsDir(project, spec.runtime === 'codex' ? 'codex' : 'claude')
    mkdirSync(dir, { recursive: true })
    const base = slug(spec.id)
    let id = base
    for (let i = 2; taken.has(id) || fileOf(project, id) || existsSync(path.join(dir, `${id}.md`)); i++) id = `${base}-${i}`
    taken.add(id)
    writeFileSync(path.join(dir, `${id}.md`), agentFile(spec, id, org))
    ids.push(id)
  }
  rescan(project.dir)
  return ids
}

/** The file of an agent on the team, or why it cannot be removed. */
export function removable(project: ProjectRef, id: string): { file: string } | { error: string } {
  const file = fileOf(project, id)
  return file ? { file } : { error: `"${id}" is not on the team of ${project.name}` }
}

/**
 * Take an agent off the project's team. Its file is moved to .agent-company/removed-agents/ (not
 * deleted), so the owner can put it back. Returns where it went, relative to the project.
 */
export function removeAgent(project: ProjectRef, id: string): string {
  const r = removable(project, id)
  if ('error' in r) throw new Error(r.error)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const engine = r.file.includes(`${path.sep}.codex${path.sep}`) ? 'codex-' : ''
  const dest = path.join(project.dir, '.agent-company', 'removed-agents', `${engine}${path.basename(r.file, '.md')}-${stamp}.md`)
  mkdirSync(path.dirname(dest), { recursive: true })
  renameSync(r.file, dest)
  rescan(project.dir)
  return path.relative(project.dir, dest).split(path.sep).join('/')
}
