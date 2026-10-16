// Mutations of org.yaml: owner profile, approved org designs, hires and dismissals.
import { writeFileSync } from 'node:fs'
import YAML from 'yaml'
import type { AgentDef, DivisionDef, HireSpec, OrgDef, OrgDesign, OwnerDef, ProjectDef, Runtime, TeamMode } from '../shared/types.ts'
import { allAgents, loadOrg, ORG_FILE } from './org.ts'

const HEADER = `# ─────────────────────────────────────────────────────────────
#  Agent Company — single source of truth.
#  Maintained by the app (owner profile, approved org changes). Hand edits are fine too.
#  A full example lives in templates/software-company.yaml.
# ─────────────────────────────────────────────────────────────

`

// Serialise writes so concurrent approvals never interleave.
let queue: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (org: OrgDef) => T): Promise<T> {
  const next = queue.then(async () => {
    const org = await loadOrg()
    const result = fn(org)
    writeFileSync(ORG_FILE, HEADER + YAML.stringify(org, { lineWidth: 0 }))
    return result
  })
  queue = next.catch(() => {})
  return next
}

const PALETTE = ['#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#22d3ee', '#60a5fa', '#f87171', '#2dd4bf', '#818cf8', '#fb923c']
const colorFor = (id: string) => PALETTE[[...id].reduce((h, c) => h + c.charCodeAt(0), 0) % PALETTE.length]

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'a$1').slice(0, 24) || 'agent'

function divisionFor(org: OrgDef, runtime: Runtime = 'claude'): DivisionDef {
  return org.divisions.find((d) => d.runtime === runtime) ?? org.divisions[0]
}

function toAgent(spec: Omit<HireSpec, 'department'>): AgentDef {
  const id = slug(spec.id)
  return {
    id,
    name: spec.name,
    role: spec.role,
    avatar: [...(spec.name.en || id)][0].toUpperCase(),
    color: colorFor(id),
    description: spec.description,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.prompt ? { prompt: spec.prompt } : {}),
    ...(spec.tools?.length ? { tools: spec.tools } : {}),
    ...(spec.sandbox ? { sandbox: spec.sandbox } : spec.runtime === 'codex' ? { sandbox: 'read-only' as const } : {}),
  }
}

function addMember(org: OrgDef, spec: HireSpec): AgentDef {
  const taken = new Set([org.owner.id, ...allAgents(org).map((a) => a.id)])
  const agent = toAgent(spec)
  let id = agent.id
  for (let i = 2; taken.has(id); i++) id = `${agent.id}-${i}`
  agent.id = id
  const div = divisionFor(org, spec.runtime)
  const depId = slug(spec.department.id)
  let dep = div.departments.find((d) => d.id === depId)
  if (!dep) {
    const name = spec.department.name ?? org.divisions.flatMap((d) => d.departments).find((d) => d.id === depId)?.name ?? { en: depId, ja: depId }
    dep = { id: depId, name, icon: '', members: [] }
    div.departments.push(dep)
  }
  dep.members.push(agent)
  return agent
}

export function updateProfile(patch: { owner?: Partial<OwnerDef>; company?: Partial<Pick<OrgDef['company'], 'name' | 'mission' | 'rules'>> }) {
  return mutate((org) => {
    if (patch.owner) {
      const { id: _ignored, ...rest } = patch.owner
      org.owner = { ...org.owner, ...rest, preferences: { ...org.owner.preferences, ...rest.preferences } }
      if (rest.name?.en) org.owner.avatar = [...rest.name.en][0].toUpperCase()
    }
    if (patch.company) {
      // The workspace only moves through /api/workspace, which validates the folder.
      const { name, mission, rules } = patch.company
      org.company = { ...org.company, ...(name ? { name } : {}), ...(mission !== undefined ? { mission } : {}), ...(rules !== undefined ? { rules } : {}) }
    }
    return org
  })
}

/** Turn the legacy single `workspace` into an explicit project list before editing it. */
function ensureProjects(org: OrgDef): ProjectDef[] {
  if (!org.company.projects?.length) {
    org.company.projects = [{ id: 'main', name: 'Main', path: org.company.workspace ?? './workspace' }]
    org.company.activeProject ??= 'main'
  }
  delete org.company.workspace
  return org.company.projects
}

export function addProject(name: string, storedPath: string) {
  return mutate((org) => {
    const list = ensureProjects(org)
    const base = slug(name) || 'project'
    let id = base
    for (let i = 2; list.some((p) => p.id === id); i++) id = `${base}-${i}`
    const p: ProjectDef = { id, name: name.trim(), path: storedPath }
    list.push(p)
    return p
  })
}

export function updateProject(id: string, patch: { name?: string; path?: string; team?: TeamMode }) {
  return mutate((org) => {
    const p = ensureProjects(org).find((x) => x.id === id)
    if (!p) throw new Error(`No project "${id}"`)
    if (patch.name?.trim()) p.name = patch.name.trim()
    if (patch.path) p.path = patch.path
    if (patch.team) p.team = patch.team
    return p
  })
}

export function removeProject(id: string) {
  return mutate((org) => {
    const list = ensureProjects(org)
    if (list.length <= 1) throw new Error('The company needs at least one project')
    org.company.projects = list.filter((p) => p.id !== id)
    if (org.company.activeProject === id) org.company.activeProject = org.company.projects[0].id
  })
}

export function setActiveProject(id: string) {
  return mutate((org) => {
    if (!ensureProjects(org).some((p) => p.id === id)) throw new Error(`No project "${id}"`)
    org.company.activeProject = id
  })
}

export type AgentPatch = Partial<Pick<AgentDef, 'name' | 'role' | 'description' | 'prompt' | 'model' | 'runtime'>>

/** Owner edits to one agent. The id stays the same — it is the agent's handle everywhere. */
export function updateAgent(id: string, patch: AgentPatch) {
  return mutate((org) => {
    const all = org.divisions.flatMap((d) => [...(d.ceo ? [d.ceo] : []), ...d.departments.flatMap((dep) => dep.members)])
    const a = all.find((x) => x.id === id)
    if (!a) throw new Error(`No agent "${id}"`)
    if (patch.name) {
      a.name = { en: patch.name.en.trim() || a.name.en, ja: patch.name.ja.trim() || patch.name.en.trim() || a.name.ja }
      a.avatar = [...a.name.en][0].toUpperCase()
    }
    if (patch.role) a.role = { en: patch.role.en.trim() || a.role.en, ja: patch.role.ja.trim() || a.role.ja }
    if (patch.description !== undefined && patch.description.trim()) a.description = patch.description.trim()
    if (patch.prompt !== undefined) {
      if (patch.prompt.trim()) a.prompt = patch.prompt.trim() + '\n'
      else delete a.prompt
    }
    if (patch.runtime !== undefined) {
      const isCeo = org.divisions.find((d) => d.ceo && d.mode !== 'manual')?.ceo?.id === id
      if (!isCeo) throw new Error('Only the CEO can switch engines')
      if (!['claude', 'codex'].includes(patch.runtime)) throw new Error('The CEO runs on claude or codex')
      // A model name only makes sense for one engine; switching engines resets it unless one is given.
      if (patch.runtime !== (a.runtime ?? 'claude') && patch.model === undefined) delete a.model
      if (patch.runtime === 'claude') delete a.runtime
      else a.runtime = patch.runtime
    }
    if (patch.model !== undefined) {
      if (patch.model.trim()) a.model = patch.model.trim()
      else delete a.model
    }
    return a
  })
}

/** Replace every non-core department with the CEO's design. Core roles (CEO, HR) stay. */
export function applyDesign(design: OrgDesign) {
  return mutate((org) => {
    if (design.company?.name) org.company.name = design.company.name
    if (design.company?.mission !== undefined) org.company.mission = design.company.mission
    if (design.company?.rules) org.company.rules = design.company.rules
    for (const div of org.divisions) {
      div.departments = div.departments
        .map((d) => ({ ...d, members: d.members.filter((m) => m.core) }))
        .filter((d) => d.members.length)
    }
    const added: string[] = []
    for (const dep of design.departments) {
      for (const m of dep.members) added.push(addMember(org, { ...m, department: { id: dep.id, name: dep.name } }).id)
    }
    return added
  })
}

export function hire(spec: HireSpec) {
  return mutate((org) => addMember(org, spec))
}

export function dismiss(id: string) {
  return mutate((org) => {
    const a = allAgents(org).find((x) => x.id === id)
    if (!a) throw new Error(`No agent "${id}"`)
    if (a.core || a.isCeo) throw new Error(`${id} is a core role and cannot be dismissed`)
    for (const div of org.divisions) {
      for (const dep of div.departments) dep.members = dep.members.filter((m) => m.id !== id)
      div.departments = div.departments.filter((d) => d.members.length)
    }
    return a
  })
}
