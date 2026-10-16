import { copyFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import type { AgentRef, OrgDef, ProjectRef } from '../shared/types.ts'
import { humanize, scanProject } from './projectScan.ts'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const ORG_FILE = path.join(ROOT, 'org.yaml')
export const DATA_DIR = path.join(ROOT, 'data')

export async function loadOrg(): Promise<OrgDef> {
  // org.yaml is the owner's own company and stays out of git; a fresh clone starts from the template.
  if (!existsSync(ORG_FILE)) copyFileSync(path.join(ROOT, 'templates', 'blank-company.yaml'), ORG_FILE)
  const org = YAML.parse(await readFile(ORG_FILE, 'utf8')) as OrgDef
  validate(org)
  return org
}

/** Every project the company works on. Older configs with one `workspace` get a single "Main" project. */
export function projectsOf(org: OrgDef): ProjectRef[] {
  const list = org.company.projects?.length ? org.company.projects : [{ id: 'main', name: 'Main', path: org.company.workspace ?? './workspace' }]
  return list.map((p) => {
    const dir = path.resolve(ROOT, p.path)
    const scan = scanProject(dir)
    const mode = p.team ?? (scan?.agents.length ? 'mixed' : 'company')
    return { ...p, dir, exists: existsSync(dir), scan, mode }
  })
}

/** The repo's own agents for a project, as read-only team members reporting to the CEO. */
export function projectTeam(org: OrgDef, project: ProjectRef): AgentRef[] {
  const ceo = org.divisions.find((d) => d.runtime === 'claude' && d.ceo)?.ceo
  const taken = new Set(allAgents(org).map((a) => a.id))
  return (project.scan?.agents ?? [])
    .filter((a) => !taken.has(a.id))
    .map((a) => ({
      id: a.id,
      name: { en: humanize(a.id), ja: humanize(a.id) },
      role: { en: a.role, ja: a.role },
      avatar: humanize(a.id)[0],
      color: '#94a3b8',
      description: a.description,
      tools: a.tools,
      model: a.model,
      divisionId: `project:${project.id}`,
      departmentId: 'repo',
      runtime: 'claude' as const,
      isCeo: false,
      manual: false,
      managerId: ceo?.id ?? org.owner.id,
      external: project.id,
    }))
}

/** A company agent, or one of the project's own agents. */
export function findAgentIn(org: OrgDef, id: string, project?: ProjectRef): AgentRef | undefined {
  return findAgent(org, id) ?? (project ? projectTeam(org, project).find((a) => a.id === id) : undefined)
}

/** The requested project, else the active one, else the first. */
export function projectOf(org: OrgDef, id?: string | null): ProjectRef {
  const all = projectsOf(org)
  return all.find((p) => p.id === id) ?? all.find((p) => p.id === org.company.activeProject) ?? all[0]
}

export function allAgents(org: OrgDef): AgentRef[] {
  const out: AgentRef[] = []
  for (const div of org.divisions) {
    const manual = div.mode === 'manual'
    // Divisions without a CEO report to the first automated CEO (the "main" CEO).
    const fallbackManager = org.divisions.find((d) => d.ceo && d.mode !== 'manual')?.ceo?.id ?? org.owner.id
    const managerId = div.ceo?.id ?? fallbackManager
    if (div.ceo) {
      out.push({ ...div.ceo, divisionId: div.id, departmentId: null, runtime: div.ceo.runtime ?? div.runtime, isCeo: true, manual, managerId: org.owner.id })
    }
    for (const dep of div.departments) {
      for (const m of dep.members) {
        out.push({ ...m, divisionId: div.id, departmentId: dep.id, runtime: div.runtime, isCeo: false, manual, managerId })
      }
    }
  }
  return out
}

export function findAgent(org: OrgDef, id: string): AgentRef | undefined {
  return allAgents(org).find((a) => a.id === id)
}

function validate(org: OrgDef) {
  if (!org?.company) throw new Error('org.yaml: company is required')
  if (!org.owner?.id) throw new Error('org.yaml: owner.id is required')
  const seen = new Set<string>([org.owner.id])
  for (const a of allAgents(org)) {
    if (!/^[a-z][a-z0-9-]*$/.test(a.id)) throw new Error(`org.yaml: invalid agent id "${a.id}" (use lowercase letters, digits, -)`)
    if (seen.has(a.id)) throw new Error(`org.yaml: duplicate id "${a.id}"`)
    seen.add(a.id)
  }
}

/** The company CEO: the lead of the main (first automated) division, whatever engine runs them. */
export function mainCeo(org: OrgDef): AgentRef | undefined {
  const div = org.divisions.find((d) => d.ceo && d.mode !== 'manual')
  return div ? allAgents(org).find((a) => a.id === div.ceo!.id) : undefined
}
