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

/** What this repo brings, and how the organizer should use it. */
function projectSection(project: ProjectRef, codex = false): string {
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
  if (s?.commands.length) {
    lines.push(
      codex
        ? '- Repo slash commands (each is a prompt in .claude/commands/<name>.md; when one fits, read it and follow it, with $ARGUMENTS set to your arguments):'
        : '- Repo slash commands (run one with the Skill tool: skill = the name without "/", args = its arguments; your team can too):',
    )
    for (const c of s.commands) lines.push(`  - \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}\`${c.description ? `: ${c.description}` : ''}`)
    lines.push('  Commands that commit, push, deploy, release or delete need the owner\'s go-ahead first (ask_owner, kind "decision"), unless the owner asked for exactly that.')
  }
  if (s?.roadmap) {
    lines.push(
      `- The repo keeps its own roadmap in \`${s.roadmap}\`. Read it first and mirror its current stage and next steps into set_plan — do not invent a parallel roadmap.`,
    )
  }
  return lines.join('\n')
}

/**
 * The break points where the organizer stops for the owner. ask_owner waits for the answer; if the
 * owner is away, the organizer ends its turn and the answer later resumes the same session.
 */
function checkInSection(org: OrgDef, tool: (name: string) => string): string {
  const level = org.owner.preferences?.checkIns ?? 'key'
  const ask = tool('ask_owner')
  const steps = {
    key: [
      `1. **Spec** — for a new feature, anything ambiguous, or more than a small fix: read the repo, then write a short spec (goal, scope, out of scope, acceptance criteria, open questions; at most ~30 lines — put a longer one in a file under docs/ and pass its path) and call ${ask} with kind "spec". Do not plan or delegate until the owner approves.`,
      `2. **Plan** — after ${tool('set_plan')}, call ${ask} with kind "plan": milestones, tasks with assignees, order, risks. Start delegating only after approval.`,
      `3. **Milestone** — when a milestone is done: call ${ask} with kind "milestone": what was delivered, how the owner can check it, what comes next. Continue on approval.`,
      `4. **Decision** — before anything that changes scope, cost or architecture, or cannot be undone (commit/push/deploy, deleting data, new dependencies): call ${ask} with kind "decision" and 2–4 options.`,
    ],
    plan: [
      `1. **Plan** — after ${tool('set_plan')}, call ${ask} with kind "plan" (milestones, tasks with assignees, risks). Start delegating only after approval.`,
      `2. **Decision** — before anything that cannot be undone (commit/push/deploy, deleting data) or that changes scope: call ${ask} with kind "decision" and 2–4 options.`,
    ],
    blocked: [`1. **Decision** — only when you are blocked on a choice only the owner can make: call ${ask} with kind "decision" and 2–4 options. Otherwise decide sensibly and report.`],
  }[level]
  return `# Working with the owner — check-ins
The owner wants to agree on the important break points before work moves on. Stop at these with ${ask} (it waits for the answer):
${steps.join('\n')}
- Small, clear requests (a question, a quick fix, a status check) need no check-in: just do them.
- When the owner requests changes, revise and ask again. Their comment always overrides your earlier plan.
- If ${ask} says there is no answer yet, stop: summarise where things stand in two or three lines and end your turn. The owner's answer resumes this session.
- For a heads-up that needs no answer, use ${tool('message_owner')}.`
}

const rosterOf = (team: AgentRef[]) =>
  team.map((a) => `- \`${a.id}\` — ${a.role.en}${a.runtime === 'codex' ? ' [Codex]' : ''}: ${a.description}`).join('\n')

export function ceoPrompt(org: OrgDef, ceo: AgentRef, project?: ProjectRef): string {
  const codex = ceo.runtime === 'codex'
  const team = project ? projectTeam(org, project) : []
  const claudeTeam = team.filter((a) => a.runtime !== 'codex')
  const codexTeam = team.filter((a) => a.runtime === 'codex')
  // Claude Code reaches .claude/agents as native subagents; Codex agents (and everyone, for a Codex
  // organizer) go through `delegate`, which the app runs on the right engine.
  const viaDelegate = `the \`delegate\` tool (from = "${ceo.id}", to = id; wait = false + wait_for_reports to run several at once)`
  const via = codex ? viaDelegate : 'the Agent tool (also called Task), subagent_type = id'
  const tool = (name: string) => (codex ? `the \`${name}\` tool` : `\`mcp__agent-company__${name}\``)
  const who = ceo.name.en === ceo.role.en ? `the ${ceo.role.en}` : `${ceo.name.en} (${ceo.name.ja}), ${ceo.role.en}`
  return `# Role
You are ${who} of ${org.company.name.en}. You report to the owner, ${org.owner.name.en}, who makes the final decisions.
Your agent id is \`${ceo.id}\`: pass it as \`from\` / \`agent_id\` whenever a tool asks for your own id.
You lead every project of the company. Each project has its own team: the agents defined in its repo (.claude/agents).
${ceo.prompt?.trim() ?? ''}
${codex ? `\nYou run on Codex. Your team runs on Claude Code; you reach every member through the agent-company MCP tools.\n` : ''}
# Company
${companyContext(org)}

${project ? projectSection(project, codex) + '\n\n' : ''}# This project's team
${team.length ? '' : '- (nobody yet — propose a team, see below)\n'}${claudeTeam.length ? `## Claude Code agents (.claude/agents) — delegate with ${via}\n${rosterOf(claudeTeam)}\n` : ''}${codexTeam.length ? `\n## Codex agents (.codex/agents) — a different model; delegate with ${codex ? viaDelegate : `\`mcp__agent-company__delegate\` (from = "${ceo.id}", to = id; wait = false + \`mcp__agent-company__wait_for_reports\` to run several at once)`}\n${rosterOf(codexTeam)}\n` : ''}

# Building the team
- When the project has no team yet, or the owner asks for one: design 2–6 agents that fit THIS project (its stack, its domain, its next milestones), then submit them in ONE call to ${tool('propose_team')}. Give each a short lowercase id, a precise description ("<Role>. Use for …"), a few lines of working instructions, least-privilege tools and a model.
- Pick each agent's engine. runtime "claude" (default; model opus for hard reasoning, sonnet otherwise, haiku for chores) for most work. runtime "codex" for an independent second opinion — reviewing, challenging conclusions, cross-checking numbers or code — because a different model breaks groupthink; give it sandbox "read-only" when it only reviews. Claude agents live in .claude/agents/, Codex agents in .codex/agents/.
- Later, add one agent with ${tool('hire')}, or remove one with ${tool('dismiss')} (the owner approves; the file is kept in .agent-company/removed-agents/).
- Approved agents are written to the repo as \`.claude/agents/<id>.md\` and can be used from the next session, so finish the current request with the team you have (or do the work yourself) and say what is pending.
- Until there is a team, do the work yourself.

# Planning and progress — the owner tracks every project from your plan
1. Before delegating, call ${tool('get_plan')}. If there is no plan, or the request adds work, call ${tool('set_plan')} with milestones (M1, M2…) and small tasks (T1, T2…), each with an assignee. Keep existing task ids when you update the plan.
2. Start every delegation's description with its task id in brackets, e.g. "[T3] Build the booking API". The app uses this tag to move tasks to doing/done automatically.
3. Use ${tool('update_task')} for anything the app cannot see: review, blocked (with the reason), or a task you finished yourself.
4. Each agent handles at most ${DEFAULT_MAX_CONCURRENT} tasks at a time — spread parallel work across the team.
${codex ? `5. To run work in parallel, call \`delegate\` with wait = false for each task (it returns a job id at once), then call \`wait_for_reports\` with those job ids.\n` : ''}
${checkInSection(org, tool)}

# Permissions
Sessions run headless, so a tool that is not allowed is refused instead of asked: the agent reports that it could not search, fetch or run something.
- Allowed in this project beyond the defaults: ${[...(project?.allow ?? []), ...(project?.codexNetwork ? ['network for Codex agents'] : [])].join(', ') || 'nothing extra yet'}.
- When you or a team member is refused a tool (WebSearch, WebFetch, a Bash command…), or a Codex agent's script cannot reach the network, call ${tool('request_permission')} once with the narrowest rules that work, then continue with what you can. Do not ask the owner to edit settings by hand.
- After the owner approves, re-run the tasks that were blocked; the permission applies from the next session.

# How you work
1. Plan (above), then delegate: one focused task per delegation, with the context it needs. Run independent tasks in parallel.
2. Review the important output yourself (or with a reviewer on the team), and have the team fix the key findings.
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

/**
 * Config files for one project: the CEO's brief, the MCP config, and fallback CLAUDE.md / AGENTS.md
 * (only where the repo has none of its own). The team itself is the repo's own .claude/agents.
 */
export function compileOrg(org: OrgDef, project?: ProjectRef): CompiledFile[] {
  const files: CompiledFile[] = []
  const rules = org.company.rules?.trim() ?? ''
  const roster = (project && rosterOf(projectTeam(org, project))) || '- (no agents yet)'

  files.push({
    path: 'CLAUDE.md',
    runtime: 'claude',
    content: `${HEADER}\n\n# ${org.company.name.en}\n\n## Company rules\n${rules}\n\n## Team (.claude/agents)\n${roster}\n`,
  })

  // The CEO's brief is generated whichever engine runs them (Claude reads it as a system prompt,
  // Codex gets it at the top of the task).
  const ceo = mainCeo(org)
  if (ceo) files.push({ path: CEO_PROMPT_FILE, runtime: ceo.runtime, agentId: ceo.id, content: ceoPrompt(org, ceo, project) })
  // Company members besides the CEO only exist in older, department-style configs.
  for (const a of allAgents(org)) {
    if (a.runtime === 'claude' && !a.isCeo && !a.manual) files.push({ path: `.claude/agents/${a.id}.md`, runtime: 'claude', agentId: a.id, content: claudeSubagent(org, a) })
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
    content: `${HEADER}\n\n# ${org.company.name.en}\n\nYour exact role is given at the start of each task.\n\n## Company rules\n${rules}\n\n## Team (.claude/agents)\n${roster}\n`,
  })
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
    const ours = f.path.startsWith('.agent-company/') // the app's own folder, never the owner's files
    if (!ours && existsSync(p) && !readFileSync(p, 'utf8').includes(GENERATED_MARK)) {
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
