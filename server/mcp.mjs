// Agent Company MCP server (stdio). Claude Code and Codex load it to delegate across divisions,
// change the org (CEO/HR), and talk with the owner. Every call goes through the app, so the
// dashboard sees each hand-off.
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

const l10n = z.object({ en: z.string(), ja: z.string() })
const runtime = z.enum(['claude', 'codex', 'antigravity'])
const role = {
  id: z.string().describe('Short lowercase handle, letters/digits/-'),
  name: l10n.describe('Friendly first name in English and Japanese'),
  role: l10n.describe('Job title in English and Japanese'),
  description: z.string().describe('"<Role>. Use for …" — tells managers when to delegate to this person'),
  prompt: z.string().optional().describe('2–5 lines of working instructions for this business'),
  tools: z.array(z.string()).optional().describe('Least-privilege tool list, e.g. ["Read","Write","Edit","Glob","Grep","WebSearch"]'),
  model: z.string().optional().describe('claude: opus | sonnet | haiku. Omit for the default.'),
  runtime: runtime.optional().describe('claude (default) | codex | antigravity (manual)'),
}

const server = new McpServer({ name: 'agent-company', version: '0.3.0' })

server.registerTool(
  'list_colleagues',
  { description: "List everyone you can work with: the company's agents and this project's own repo agents (id, role, department, runtime)." },
  async () => {
    const { agents } = await api(`/api/colleagues?runId=${encodeURIComponent(RUN ?? '')}`)
    const where = (a) => (a.external ? 'repo team' : (a.departmentId ?? 'leadership'))
    return text(agents.map((a) => `${a.id} — ${a.external ? a.role.en : `${a.name.en}, ${a.role.en}`} [${where(a)}] (${a.runtime}${a.manual ? ', manual' : ''})`).join('\n'))
  },
)

server.registerTool(
  'delegate',
  {
    description:
      'Delegate a focused task to an agent in another division (e.g. the Codex partner) and wait for their report. ' +
      'Manual agents (Antigravity) get the task queued for the owner and this returns immediately.',
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
  'propose_org',
  {
    description:
      'CEO only. Propose the complete company structure for the owner\'s business in ONE call: departments and the roles in each. ' +
      'Replaces all non-core departments when approved (the CEO and HR always stay).',
    inputSchema: {
      from: z.string().describe('Your own agent id'),
      reason: z.string().describe('One or two sentences: why this structure fits the business'),
      company: z
        .object({ name: l10n.optional(), mission: z.string().optional().describe('What the business does, in one or two sentences') })
        .optional(),
      departments: z
        .array(z.object({ id: z.string(), name: l10n, members: z.array(z.object(role)).min(1) }))
        .min(1)
        .describe('3–7 departments with 1–3 roles each'),
    },
  },
  async ({ from, reason, company, departments }) => {
    try {
      return text((await post('/api/proposals', { kind: 'design', from, reason, design: { company, departments }, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'hire',
  {
    description: 'HR/CEO. Hire one new agent into a department (existing id, or a new id with a name). Waits for owner approval unless auto-approved.',
    inputSchema: {
      from: z.string().describe('Your own agent id'),
      reason: z.string().describe('Why this role is needed now'),
      ...role,
      department: z.object({ id: z.string(), name: l10n.optional().describe('Required when creating a new department') }),
    },
  },
  async ({ from, reason, department, ...spec }) => {
    try {
      return text((await post('/api/proposals', { kind: 'hire', from, reason, hire: { ...spec, department }, runId: RUN })).message)
    } catch (e) {
      return fail(e)
    }
  },
)

server.registerTool(
  'dismiss',
  {
    description: 'HR/CEO. Remove an agent who is no longer needed. Core roles (CEO, HR) cannot be dismissed.',
    inputSchema: { from: z.string(), reason: z.string(), id: z.string().describe('Agent id to dismiss') },
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
