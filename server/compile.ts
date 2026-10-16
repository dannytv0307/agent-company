// Compiles org.yaml into the native config formats each runtime reads, per project.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentRef, CompiledFile, OrgDef, ProjectRef } from '../shared/types.ts'
import { allAgents, mainCeo, projectsOf, projectTeam, ROOT } from './org.ts'
import { capture } from './proc.ts'
import { GENERATED_MARK } from './projectScan.ts'

export const PORT = Number(process.env.PORT ?? 4317)
export const CEO_PROMPT_FILE = '.agent-company/ceo-prompt.md'
export const MCP_CONFIG_FILE = '.agent-company/mcp.json'
export const MCP_SERVER = path.join(ROOT, 'server', 'mcp.mjs')
export const DEFAULT_MAX_CONCURRENT = 2

const HEADER = `<!-- ${GENERATED_MARK} from org.yaml. Edit org.yaml, not this file. -->`

const dept = (org: OrgDef, a: AgentRef) =>
  a.external
    ? 'Repo team'
    : (org.divisions.find((d) => d.id === a.divisionId)?.departments.find((d) => d.id === a.departmentId)?.name.en ?? 'Leadership')

function rosterLine(org: OrgDef, a: AgentRef): string {
  const manual = a.manual ? ' — MANUAL: the owner runs these tasks by hand, the tool returns immediately' : ''
  const name = a.external ? a.role.en : `${a.name.en} (${a.name.ja}), ${a.role.en}`
  return `- \`${a.id}\` — ${name} [${dept(org, a)}]: ${a.description}${manual}`
}

// Company subagents may read owner notes, ask the owner, and use the repo's skills.
const EXTRA_TOOLS = [
  'mcp__agent-company__check_messages',
  'mcp__agent-company__message_owner',
  'mcp__agent-company__delegate',
  'mcp__agent-company__list_colleagues',
  'Skill',
]

function companyContext(org: OrgDef): string {
  const lines = [
    org.company.mission?.trim() ? `What the company does: ${org.company.mission.trim()}` : 'The company has no defined business yet.',
    org.owner.bio?.trim() ? `About the owner (${org.owner.name.en}): ${org.owner.bio.trim()}` : '',
    `Write anything addressed to the owner in ${org.owner.preferences?.reportLanguage ?? 'English'}.`,
  ]
  return lines.filter(Boolean).join('\n')
}

export function persona(org: OrgDef, a: AgentRef): string {
  const live = a.manual
    ? ''
    : `The owner may message you while you work. Between major steps, call \`check_messages\` (agent_id = "${a.id}") and follow any notes. ` +
      `If you are blocked on a decision only the owner can make, ask with \`message_owner\` and continue with sensible defaults.`
  return [
    `You are ${a.name.en} (${a.name.ja}), ${a.role.en} at ${org.company.name.en}.`,
    a.description,
    a.prompt?.trim() ?? '',
    companyContext(org),
    org.company.rules ? `Company rules:\n${org.company.rules.trim()}` : '',
    'Each project may have its own CLAUDE.md, AGENTS.md, skills and conventions. Inside a project, those take precedence over the company rules.',
    a.manual || a.isCeo
      ? ''
      : `To hand part of your work to a colleague — including the project's own repo agents, who know its codebase best — use \`delegate\` (from = "${a.id}") and wait for their report. Use \`list_colleagues\` to see who is available. Keep your task id (e.g. [T3]) at the start of anything you delegate.`,
    live,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** What this repo brings, and how the CEO should use it. */
function projectSection(project: ProjectRef, repoTeam: AgentRef[], codex = false): string {
  const s = project.scan
  const lines = [`# This project: ${project.name}`, `Folder: ${project.dir}`]
  if (s?.claudeMd) lines.push('- The repo has its own CLAUDE.md. Its rules and conventions take precedence over the company rules here.')
  if (s?.agentsMd) lines.push('- The repo has its own AGENTS.md (read by Codex).')
  if (s?.skills.length) {
    lines.push(
      codex
        ? '- Repo skills (read .claude/skills/<name>/SKILL.md before that kind of work; tell your team to use them):'
        : '- Repo skills (use them via the Skill tool; prefer them over improvising, and tell your team to use them):',
    )
    for (const k of s.skills) lines.push(`  - \`${k.name}\`: ${k.description}`)
  }
  if (s?.commands.length) lines.push(`- Repo commands: ${s.commands.map((c) => `/${c}`).join(', ')}`)
  if (s?.roadmap) {
    lines.push(
      `- The repo keeps its own roadmap in \`${s.roadmap}\`. Read it first and mirror its current stage and next steps into set_plan — do not invent a parallel roadmap.`,
    )
  }
  if (project.mode !== 'company' && repoTeam.length) {
    lines.push(`- Team mode: ${project.mode === 'project' ? 'REPO TEAM — delegate project work to the repo specialists below' : 'MIXED — the repo specialists know this codebase best; use company roles for what they do not cover'}.`)
    lines.push(
      codex
        ? '- You can direct the repo specialists yourself with `delegate`, or let a company lead coordinate them.'
        : '- You can direct the repo specialists yourself (Agent tool), or let a company lead coordinate them: company members hand work to them with the `delegate` tool.',
    )
  }
  return lines.join('\n')
}

export function ceoPrompt(org: OrgDef, ceo: AgentRef, project?: ProjectRef): string {
  const agents = allAgents(org)
  const mode = project?.mode ?? 'company'
  const codex = ceo.runtime === 'codex'
  const repoTeam = project && mode !== 'company' ? projectTeam(org, project) : []
  const company = agents.filter((a) => a.divisionId === ceo.divisionId && !a.isCeo && (mode !== 'project' || a.core))
  const partners = agents.filter((a) => a.divisionId !== ceo.divisionId)
  const hr = company.find((a) => a.core)
  const none = '- (nobody yet)'
  // Claude Code delegates to its own team with the Agent tool; on Codex everything goes through `delegate`.
  const viaTeam = codex ? `the \`delegate\` tool (from = "${ceo.id}", to = id)` : 'the Agent tool (also called Task), subagent_type = id'
  const viaPartner = codex ? `the \`delegate\` tool (from = "${ceo.id}")` : `\`mcp__agent-company__delegate\` (from = "${ceo.id}")`
  const tool = (name: string) => (codex ? `the \`${name}\` tool` : `\`mcp__agent-company__${name}\``)
  return `# Role
You are ${ceo.name.en} (${ceo.name.ja}), ${ceo.role.en} of ${org.company.name.en}. You report to the owner, ${org.owner.name.en}, who makes the final decisions.
${ceo.prompt?.trim() ?? ''}
${codex ? `\nYou run on Codex. Your colleagues run on Claude Code or Codex; you reach every one of them through the agent-company MCP tools.\n` : ''}
# Company
${companyContext(org)}

${project ? projectSection(project, repoTeam, codex) + '\n\n' : ''}${repoTeam.length ? `# Repo specialists (this project's own agents) — delegate with ${viaTeam}
${repoTeam.map((a) => rosterLine(org, a)).join('\n')}

` : ''}# Your team — delegate with ${viaTeam}
${company.map((a) => rosterLine(org, a)).join('\n') || none}

# Partner divisions — delegate with ${viaPartner}
${partners.map((a) => rosterLine(org, a)).join('\n') || none}

# Building the company
The company is not tied to any industry: it becomes whatever the owner's business needs.
- When the company has no departments yet, or the owner asks to set up or restructure it: design 3–7 departments with 1–3 roles each that fit the business, then submit the whole design in ONE call to ${tool('propose_org')}. Give each role a precise description ("<Role>. Use for …"), short working instructions, least-privilege tools and a runtime (claude by default; codex for independent engineering or review; antigravity only for hands-on visual design the owner does by hand).
- To add, replace or remove a single role later, delegate to ${hr ? `HR (\`${hr.id}\`)` : 'HR'}, who uses hire/dismiss.
- Org changes wait for the owner's approval unless they auto-approve. New people join from the next session, so finish the current request with the team you have and say what is pending.

# Planning and progress — the owner tracks every project from your plan
1. Before delegating, call ${tool('get_plan')}. If there is no plan, or the request adds work, call ${tool('set_plan')} with milestones (M1, M2…) and small tasks (T1, T2…), each with an assignee. Keep existing task ids when you update the plan.
2. Start every delegation's description with its task id in brackets, e.g. "[T3] Build the booking API". The app uses this tag to move tasks to doing/done automatically.
3. Use ${tool('update_task')} for anything the app cannot see: review, blocked (with the reason), or a task you finished yourself.
4. Each person handles at most ${DEFAULT_MAX_CONCURRENT} tasks at a time — spread parallel work across people.
${codex ? `5. To run work in parallel, call \`delegate\` with wait = false for each task (it returns a job id at once), then call \`wait_for_reports\` with those job ids.\n` : ''}
# How you work
1. Plan (above), then delegate: one focused task per delegation, with the context it needs. Run independent tasks in parallel.
2. Review: for important output, ask the partner division for an independent review, then have your team fix the key findings.
3. Report: finish with a short report to the owner — outcome, progress against the plan, open issues, next steps.
${codex ? `The owner may send you messages while you work: call \`check_messages\` (agent_id = "${ceo.id}") between steps and treat them as top priority.` : 'The owner may send you messages mid-run; treat them as top priority.'}

# Company rules
${org.company.rules?.trim() ?? ''}
`
}

function claudeSubagent(org: OrgDef, a: AgentRef): string {
  const fm = [
    '---',
    `name: ${a.id}`,
    `description: ${JSON.stringify(a.description)}`,
    a.tools?.length ? `tools: ${[...new Set([...a.tools, ...EXTRA_TOOLS])].join(', ')}` : null,
    a.model ? `model: ${a.model}` : null,
    '---',
  ].filter((l) => l !== null)
  return `${fm.join('\n')}\n${HEADER}\n\n${persona(org, a)}\n\nIf your task came with an id like [T3], start your final report with it. When you finish, reply with a short report for your manager (max 6 lines).\n`
}

/** Config files for one project. In "repo team" mode only core company roles are added to the repo. */
export function compileOrg(org: OrgDef, project?: ProjectRef): CompiledFile[] {
  const agents = allAgents(org)
  const files: CompiledFile[] = []
  const mode = project?.mode ?? 'company'
  const claudeAgents = agents.filter((a) => a.runtime === 'claude' && (mode !== 'project' || a.core || a.isCeo))
  const codexAgents = agents.filter((a) => a.runtime === 'codex')
  const manualAgents = agents.filter((a) => a.manual)

  files.push({
    path: 'CLAUDE.md',
    runtime: 'claude',
    content: `${HEADER}\n\n# ${org.company.name.en}\n\n## Company rules\n${org.company.rules?.trim() ?? ''}\n\n## Organisation\n${agents
      .map((a) => rosterLine(org, a))
      .join('\n')}\n`,
  })

  // The CEO's brief is generated whichever engine runs them (Claude reads it as a system prompt,
  // Codex gets it at the top of the task).
  const ceo = mainCeo(org)
  if (ceo) files.push({ path: CEO_PROMPT_FILE, runtime: ceo.runtime, agentId: ceo.id, content: ceoPrompt(org, ceo, project) })
  for (const a of claudeAgents) {
    if (!a.isCeo) files.push({ path: `.claude/agents/${a.id}.md`, runtime: 'claude', agentId: a.id, content: claudeSubagent(org, a) })
  }

  files.push({
    path: MCP_CONFIG_FILE,
    runtime: 'shared',
    content:
      JSON.stringify(
        { mcpServers: { 'agent-company': { command: 'node', args: [MCP_SERVER], env: { AGENT_COMPANY_URL: `http://127.0.0.1:${PORT}` } } } },
        null,
        2,
      ) + '\n',
  })

  files.push({
    path: 'AGENTS.md',
    runtime: 'codex',
    content: `${HEADER}\n\n# ${org.company.name.en} — Codex division\n\nYou are part of an independent division that reviews and challenges the Claude Code division's work.\nYour exact persona is given at the start of each task.\n\n## Company rules\n${org.company.rules?.trim() ?? ''}\n\n## Codex division\n${codexAgents
      .map((a) => rosterLine(org, a))
      .join('\n')}\n`,
  })

  // Antigravity: workspace rules (verify the folder your Antigravity version reads).
  if (manualAgents.length) {
    files.push({
      path: '.agent/rules/agent-company.md',
      runtime: 'antigravity',
      content: `${HEADER}\n\n${manualAgents.map((a) => `## ${a.name.en}\n\n${persona(org, a)}`).join('\n\n')}\n`,
    })
  }
  return files
}

/**
 * Writes the compiled files into the workspace. Files the owner wrote themselves (no generated
 * header) are never overwritten — they are reported in `skipped` instead.
 */
export async function writeCompiled(ws: string, files: CompiledFile[]): Promise<{ workspace: string; skipped: string[] }> {
  const fresh = !existsSync(ws) || readdirSync(ws).length === 0
  mkdirSync(ws, { recursive: true })
  const skipped: string[] = []
  for (const f of files) {
    const p = path.join(ws, f.path)
    if (existsSync(p) && !readFileSync(p, 'utf8').includes(GENERATED_MARK)) {
      skipped.push(f.path)
      continue
    }
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, f.content)
  }
  // Remove subagents we generated earlier for people who have since left (or are not used here).
  const agentsDir = path.join(ws, '.claude', 'agents')
  const keep = new Set(files.map((f) => path.join(ws, f.path)))
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) {
      const p = path.join(agentsDir, name)
      if (name.endsWith('.md') && !keep.has(p) && readFileSync(p, 'utf8').includes(GENERATED_MARK)) unlinkSync(p)
    }
  }
  // Only set up git in a folder we created; an existing project keeps its own setup.
  if (fresh) {
    writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\ndist/\n.env\n')
    await capture('git', ['-C', ws, 'init', '-q'])
  }
  return { workspace: ws, skipped }
}

/** Refresh the configs in every project folder that exists (after org or profile changes). */
export async function syncProjects(org: OrgDef) {
  for (const p of projectsOf(org)) if (p.exists) await writeCompiled(p.dir, compileOrg(org, p))
}
