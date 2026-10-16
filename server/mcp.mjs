// Agent Company MCP server (stdio). Claude Code and Codex load it to delegate to a project's team,
// build that team (organizer), keep the plan, and talk with the owner. Every call goes through the app,
// so the dashboard sees each hand-off.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE = process.env.AGENT_COMPANY_URL ?? 'http://127.0.0.1:4317'
const RUN = process.env.AGENT_COMPANY_RUN

async function api(path, init) {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', 'x-agent-company': '1' } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const text = (t) => ({ content: [{ type: 'text', text: t }] })
const fail = (e) => ({ ...text(`Failed: ${e.message}`), isError: true })

// One agent of a project's team; approved, it becomes .claude/agents/<id>.md in the repo.
const agentSpec = {
  id: z.string().describe('Short lowercase handle that says the role, e.g. "api-engineer", "level-designer"'),
  description: z.string().describe('"<Role>. Use for …" — tells the organizer when to delegate to this agent'),
  prompt: z.string().optional().describe('3–8 lines of working instructions specific to this project (stack, conventions, done criteria)'),
  tools: z.array(z.string()).optional().describe('Least-privilege tool list, e.g. ["Read","Write","Edit","Glob","Grep","Bash"]. Omit to inherit all tools.'),
  model: z.string().optional().describe('Claude: opus | sonnet | haiku. Codex: a Codex model name, or omit. Omit for the default.'),
  runtime: z.enum(['claude', 'codex']).optional().describe('claude (default) → .claude/agents; codex → .codex/agents, for independent reviews and second opinions'),
  sandbox: z.enum(['read-only', 'workspace-write']).optional().describe('Codex only: read-only for pure reviewers; workspace-write (default) when it writes files'),
}

const server = new McpServer({ name: 'agent-company', version: '0.4.0' })

server.registerTool(
  'list_colleagues',
  { description: "List everyone you can work with: the organizer and this project's team (its .claude/agents)." },
  async () => {
    const { agents } = await api(`/api/colleagues?runId=${encodeURIComponent(RUN ?? '')}`)
    return text(agents.map((a) => `${a.id} — ${a.external ? a.role.en : `${a.name.en}, ${a.role.en}`} (${a.runtime}${a.manual ? ', manual' : ''})`).join('\n'))
  },
)

server.registerTool(
  'delegate',
  {
    description:
      "Delegate a focused task to an agent of this project's team and wait for their report.",
    inputSchema: {
      from: z.string().describe('Your own agent id'),
      to: z.string().describe('Target agent id'),
      task: z.string().describe('What to do, with all context needed (files, criteria, expected output)'),
      wait: z
        .boolean()
        .optional()
        .describe('Default true: wait for the report. false: start it and return a job id at once — run several in parallel, then call wait_for_reports.'),
    },
  },
  async ({ from, to, task, wait }) => {
    try {
      const { jobId } = await post('/api/delegate', { from, to, task, runId: RUN })
      if (wait === false) return text(`Started job ${jobId} for ${to}. Collect it with wait_for_reports.`)
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const job = await api(`/api/delegate/${jobId}`)
        if (job.status === 'done') return text(job.result)
        if (job.status === 'error') return fail(new Error(job.error))
      }
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'wait_for_reports',
  {
    description: 'Wait until the given delegated jobs (from delegate with wait = false) have all finished, and return every report.',
    inputSchema: { job_ids: z.array(z.string()).min(1) },
  },
  async ({ job_ids }) => {
    try {
      const done = new Map()
      while (done.size < job_ids.length) {
        for (const id of job_ids) {
          if (done.has(id)) continue
          const job = await api(`/api/delegate/${id}`)
          if (job.status !== 'running') done.set(id, job)
        }
        if (done.size < job_ids.length) await new Promise((r) => setTimeout(r, 2000))
      }
      return text(job_ids.map((id) => { const j = done.get(id); return `## ${j.to} (${id.slice(0, 8)}) — ${j.status}\n${j.result ?? j.error ?? ''}` }).join('\n\n'))
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'propose_team',
  {
    description:
      "Organizer only. Propose a team of agents for THIS project in one call. Approved, each becomes .claude/agents/<id>.md in the repo " +
      '(existing agents are kept). Waits for the owner unless they auto-approve.',
    inputSchema: {
      from: z.string().describe('Your own agent id'),
      reason: z.string().describe("One or two sentences: why this team fits the project's work"),
      agents: z.array(z.object(agentSpec)).min(1).max(8).describe('2–6 agents, each with one clear responsibility'),
    },
  },
  async ({ from, reason, agents }) => {
    try {
      return text((await post('/api/proposals', { kind: 'design', from, reason, design: { agents }, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'hire',
  {
    description: "Organizer only. Add one agent to this project's team (.claude/agents/<id>.md). Waits for the owner unless they auto-approve.",
    inputSchema: { from: z.string().describe('Your own agent id'), reason: z.string().describe('Why this agent is needed now'), ...agentSpec },
  },
  async ({ from, reason, ...spec }) => {
    try {
      return text((await post('/api/proposals', { kind: 'hire', from, reason, hire: spec, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'dismiss',
  {
    description: "Organizer only. Remove an agent from this project's team. Waits for the owner unless they auto-approve; the file is moved to .agent-company/removed-agents/, not deleted.",
    inputSchema: { from: z.string(), reason: z.string(), id: z.string().describe('Agent id to remove') },
  },
  async ({ from, reason, id }) => {
    try {
      return text((await post('/api/proposals', { kind: 'dismiss', from, reason, dismiss: { id }, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'request_permission',
  {
    description:
      "Organizer only. Ask the owner to allow tools in THIS project when you or a team member was refused one (e.g. WebSearch, WebFetch, a Bash command), " +
      'or when Codex agents need network access inside their sandbox (downloads, APIs). Waits for the owner unless they auto-approve; approved permissions apply from the next session, so re-run the affected tasks afterwards.',
    inputSchema: {
      from: z.string().describe('Your own agent id'),
      reason: z.string().describe('What the team needs it for, in one or two sentences'),
      tools: z.array(z.string()).optional().describe('Claude Code permission rules, as narrow as works: "WebSearch", "WebFetch", "WebFetch(domain:example.com)", "Bash(python *)"'),
      codex_network: z.boolean().optional().describe('true: let Codex agents use the network inside their sandbox'),
    },
  },
  async ({ from, reason, tools, codex_network }) => {
    try {
      return text((await post('/api/proposals', { kind: 'permission', from, reason, permission: { tools, codexNetwork: codex_network }, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'get_plan',
  { description: "Show this project's plan: milestones, tasks (T1, T2…), their status and assignee, and overall progress." },
  async () => {
    try {
      return text((await api(`/api/agent-plan?runId=${encodeURIComponent(RUN ?? '')}`)).text)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'set_plan',
  {
    description:
      "Create or restructure this project's plan. Pass the full list: milestones (M1…) and small tasks (T1…) with an assignee. " +
      'Reuse existing task ids to keep their progress. Then tag each delegation with its id, e.g. "[T3] …".',
    inputSchema: {
      goal: z.string().optional().describe('What done looks like for this project, in one sentence'),
      milestones: z.array(z.object({ id: z.string().describe('M1, M2…'), title: z.string() })).optional(),
      tasks: z
        .array(
          z.object({
            id: z.string().optional().describe('T1, T2… (omit for new tasks)'),
            title: z.string(),
            milestone: z.string().optional().describe('Milestone id, e.g. M1'),
            assignee: z.string().optional().describe('Agent id'),
            status: z.enum(['todo', 'doing', 'review', 'done', 'blocked']).optional(),
            note: z.string().optional(),
          }),
        )
        .min(1),
    },
  },
  async (input) => {
    try {
      return text((await post('/api/agent-plan/set', { ...input, runId: RUN })).text)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'update_task',
  {
    description:
      'Update one task: status (todo | doing | review | done | blocked), a short note (e.g. why it is blocked), assignee or title. ' +
      'Passing an unknown id with a title adds the task.',
    inputSchema: {
      task_id: z.string().describe('e.g. T3'),
      status: z.enum(['todo', 'doing', 'review', 'done', 'blocked']).optional(),
      note: z.string().optional(),
      assignee: z.string().optional(),
      title: z.string().optional(),
      milestone: z.string().optional(),
    },
  },
  async (input) => {
    try {
      return text((await post('/api/agent-plan/update', { ...input, runId: RUN })).text)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'check_messages',
  {
    description: 'Read notes the owner sent you while you were working. Call between major steps; follow what they say.',
    inputSchema: { agent_id: z.string().describe('Your own agent id') },
  },
  async ({ agent_id }) => {
    try {
      const { notes } = await post(`/api/inbox/${encodeURIComponent(agent_id)}/read`, {})
      return text(notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'No new messages from the owner.')
    } catch (e) {
      return fail(e)
    }
  },
)

// How long ask_owner waits before telling the organizer to pause (tool calls time out at 30 minutes).
const ASK_WAIT_MS = 25 * 60_000

server.registerTool(
  'ask_owner',
  {
    description:
      'Stop at a check-in and get the owner\'s decision: a spec or plan to confirm, a finished milestone, or a choice between options. ' +
      'Shows the owner a card with Approve / Request changes (or your options) and WAITS for the answer. ' +
      'If the owner does not answer in time it says so: then end your turn with a short status; their answer will resume your session. ' +
      'For a heads-up that needs no answer, use message_owner instead.',
    inputSchema: {
      agent_id: z.string().describe('Your own agent id'),
      kind: z.enum(['spec', 'plan', 'milestone', 'decision']),
      title: z.string().describe('One line, e.g. "Booking flow — spec v1" or "M1 done: login works"'),
      body: z
        .string()
        .describe('Markdown the owner reads before deciding (max ~30 lines): spec = goal, scope, out of scope, acceptance criteria, open questions; plan = milestones, tasks, owners, risks; milestone = what was delivered, how to check it, next; decision = the question and trade-offs.'),
      file: z.string().optional().describe('Path (relative to the project) of a document with the full text, if you wrote one'),
      options: z.array(z.string()).min(2).max(4).optional().describe('For decisions: the choices, shortest first'),
    },
  },
  async ({ agent_id, ...input }) => {
    try {
      const { id } = await post('/api/checkpoints', { agentId: agent_id, ...input, runId: RUN })
      const deadline = Date.now() + ASK_WAIT_MS
      while (Date.now() < deadline) {
        const r = await post(`/api/checkpoints/${id}/poll`, {})
        if (r.text) return text(r.text)
        if (r.status !== 'open') return text('This check-in was replaced or closed without an answer. Continue with what you know, or check in again.')
        await new Promise((res) => setTimeout(res, 3000))
      }
      return text(
        'No answer from the owner yet. Do not continue past this check-in: end your turn now with two or three lines on where things stand. ' +
          "The owner's answer will resume this session.",
      )
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'message_owner',
  {
    description: 'Send the owner a short message in your chat with them — a question, a decision you need, or a heads-up. Does not wait for a reply.',
    inputSchema: { agent_id: z.string().describe('Your own agent id'), text: z.string() },
  },
  async ({ agent_id, text: t }) => {
    try {
      await post(`/api/chat/${encodeURIComponent(agent_id)}/from-agent`, { text: t, runId: RUN })
      return text('Sent. The owner will answer in your chat; check_messages later.')
    } catch (e) {
      return fail(e)
    }
  },
)

await server.connect(new StdioServerTransport())
