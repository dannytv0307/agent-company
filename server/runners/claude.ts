// Runs Claude Code headless (`claude -p`, stream-json in and out) and maps its stream to events.
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AgentRef, OrgDef, ProjectRef } from '../../shared/types.ts'
import { bus } from '../events.ts'
import { allAgents, projectTeam } from '../org.ts'
import { taskIdIn } from '../plans.ts'
import { CEO_PROMPT_FILE, MCP_CONFIG_FILE } from '../compile.ts'
import { onLines, resolveBin, spawnCli } from '../proc.ts'
import { short, summarizeClaudeTool } from './summarize.ts'

type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : '')).join(' ')
  return ''
}

/** Strip Claude Code's hand-back frame and usage footer, keeping only the subagent's own report. */
function subagentReport(raw: string): string {
  const marker = raw.indexOf('The report follows:')
  let body = marker >= 0 ? raw.slice(marker + 'The report follows:'.length) : raw
  body = body.split(/\n(?=agentId: |<usage>)/)[0]
  return body
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
}

interface StartOpts {
  runId: string
  project: ProjectRef
  /** The agent this session runs as. The CEO uses its compiled system prompt; members use `--agent`. */
  agentId: string
  isCeo: boolean
  model?: string
  resume?: string
  onSession?: (id: string) => void
  /** Emit each result as a report to the owner (company runs); direct chats return the text instead. */
  reportResults: boolean
  /** Assignment and plan task the session's own work belongs to (delegated tasks). */
  aid?: string
  taskId?: string
}

/**
 * Starts a headless Claude Code session with streaming input, so more user messages can be
 * injected while it runs. Closes stdin once every sent message has produced a result.
 */
function startClaude(org: OrgDef, first: string, o: StartOpts) {
  const bin = resolveBin('claude')
  if (!bin) throw new Error('Claude Code CLI not found. Install it and run `claude` once to sign in.')
  const division = org.divisions.find((d) => d.runtime === 'claude')
  if (!division) throw new Error('org.yaml has no Claude division')
  const ws = o.project.dir
  // Company members plus the repo's own agents, so their work is attributed to them.
  const subagents = new Set([
    ...allAgents(org).filter((a) => a.divisionId === division.id && !a.isCeo).map((a) => a.id),
    ...projectTeam(org, o.project).map((a) => a.id),
  ])
  // Our MCP server plus the project's own .mcp.json — but not every MCP server from the user's global config.
  const repoMcp = path.join(ws, '.mcp.json')

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', path.join(ws, MCP_CONFIG_FILE), ...(existsSync(repoMcp) ? [repoMcp] : []),
    '--strict-mcp-config',
    '--permission-mode', division.permissions?.mode ?? 'acceptEdits',
  ]
  if (o.isCeo) args.push('--append-system-prompt-file', path.join(ws, CEO_PROMPT_FILE))
  else args.push('--agent', o.agentId)
  if (o.model) args.push('--model', o.model)
  if (o.resume) args.push('--resume', o.resume)
  // Variadic flag goes last; prompts are streamed on stdin.
  const allow = [...new Set([...(division.permissions?.allow ?? []), ...(o.project.allow ?? [])])]
  if (allow.length) args.push('--allowedTools', ...allow)

  const child = spawnCli(bin, args, {
    cwd: ws,
    env: { ...process.env, MCP_TOOL_TIMEOUT: String(30 * 60_000), AGENT_COMPANY_RUN: o.runId },
  })

  let sent = 0
  let results = 0
  let started = false
  let lastResult = ''
  let failed = ''
  const send = (text: string): boolean => {
    if (!child.stdin || child.stdin.writableEnded || child.exitCode !== null) return false
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
    sent++
    return true
  }

  // tool_use id of each Agent/Task call → the subagent working under it (and its plan task)
  const owners = new Map<string, { agent: string; taskId?: string }>()
  // Agent calls that run in the background: the tool returns at once and completion arrives later
  // as a task_notification. The session stays open until all of them are back.
  const background = new Set<string>()
  const runId = o.runId
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(ws, path.resolve(ws, p)).split(path.sep).join('/') : undefined)

  onLines(child.stdout, (line) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    const parent = msg.parent_tool_use_id ? owners.get(msg.parent_tool_use_id) : undefined
    const actor = parent?.agent ?? o.agentId
    // Assignment id: the Agent call a subagent runs under, else the session itself.
    const aid = parent ? msg.parent_tool_use_id : (o.aid ?? runId)
    const taskId = parent ? parent.taskId : o.taskId

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id) o.onSession?.(msg.session_id)
      // Later turns (after a background agent reports back) re-send init; announce only the first.
      if (o.reportResults && !started) bus.emit({ runId, kind: 'system', agent: o.agentId, text: `Session started (${msg.model ?? 'claude'})`, meta: { sessionId: msg.session_id } })
      started = true
      return
    }

    if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.tool_use_id) {
      const worker = owners.get(msg.tool_use_id)
      background.delete(msg.tool_use_id)
      if (worker) {
        const summary = String(msg.summary ?? '')
        const meta = { full: summary, aid: msg.tool_use_id, taskId: worker.taskId }
        if (msg.status === 'completed') bus.emit({ runId, kind: 'report', from: worker.agent, to: o.agentId, text: short(summary || 'Done', 100), meta })
        else bus.emit({ runId, kind: 'error', agent: worker.agent, text: short(`${msg.status ?? 'stopped'}: ${summary}`, 160), meta })
        owners.delete(msg.tool_use_id)
      }
      return
    }

    if (msg.type === 'assistant') {
      for (const b of (msg.message?.content ?? []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) {
          bus.emit({ runId, kind: 'activity', agent: actor, text: short(b.text, 90), meta: { full: b.text, aid, taskId } })
        } else if (b.type === 'tool_use' && b.name) {
          if ((b.name === 'Agent' || b.name === 'Task') && b.id) {
            const target = String(b.input?.subagent_type ?? '')
            const to = subagents.has(target) ? target : actor
            const tid = taskIdIn(b.input?.description) ?? taskIdIn(b.input?.prompt)
            owners.set(b.id, { agent: to, taskId: tid })
            // Not one of the team: a helper Claude Code spawns for itself (general-purpose, Explore, Plan…).
            // Its work stays attributed to the caller; the type lets the app show it while it runs.
            const spawned = to === actor ? { subagentType: target || 'general-purpose' } : {}
            bus.emit({ runId, kind: 'dispatch', from: actor, to, text: short(b.input?.description ?? b.input?.prompt, 80), meta: { prompt: b.input?.prompt, aid: b.id, taskId: tid, ...spawned } })
          } else if (b.name === 'ToolSearch' || /^mcp__agent-company__(delegate|check_messages|get_plan)$/.test(b.name)) {
            // delegate: the endpoint emits dispatch/report itself. The rest is internal noise.
          } else {
            const file = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name) ? rel(b.input?.file_path ?? b.input?.notebook_path) : undefined
            bus.emit({ runId, kind: 'activity', agent: actor, text: summarizeClaudeTool(b.name, b.input), meta: { aid, taskId, ...(file ? { file } : {}) } })
          }
        }
      }
      return
    }

    if (msg.type === 'user') {
      for (const b of (msg.message?.content ?? []) as Block[]) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const worker = owners.get(b.tool_use_id)
        if (worker && worker.agent !== actor) {
          const raw = resultText(b.content)
          if (/^\s*Async agent launched/i.test(raw)) {
            background.add(b.tool_use_id) // started, not finished — wait for its task_notification
            continue
          }
          const report = subagentReport(raw)
          bus.emit({ runId, kind: 'report', from: worker.agent, to: actor, text: short(report, 100), meta: { full: report, aid: b.tool_use_id, taskId: worker.taskId } })
          owners.delete(b.tool_use_id)
        }
      }
      return
    }

    if (msg.type === 'result') {
      // Tools the session wanted but was not allowed (headless runs cannot ask): the app turns these
      // into a permission request for the owner.
      const denied = Array.isArray(msg.permission_denials) ? (msg.permission_denials as { tool_name?: string; tool_input?: Record<string, unknown> }[]) : []
      if (denied.length) {
        bus.emit({ runId, kind: 'system', agent: o.agentId, text: `Not allowed: ${[...new Set(denied.map((d) => d.tool_name))].join(', ')}`, meta: { permissionDenied: denied.map((d) => ({ tool: d.tool_name, input: d.tool_input })) } })
      }
      results++
      const ok = msg.subtype === 'success' && !msg.is_error
      lastResult = String(msg.result ?? '')
      if (!ok) failed = lastResult || String(msg.subtype)
      const final = background.size === 0
      // An interim turn ("waiting for the team…") while background agents still work is already
      // shown as the CEO's activity; only the final result is a report to the owner.
      if (o.reportResults && final) {
        bus.emit({
          runId,
          kind: ok ? 'report' : 'error',
          from: o.agentId,
          to: org.owner.id,
          agent: o.agentId,
          text: short(msg.result ?? msg.subtype, 140),
          meta: { full: msg.result, costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, turns: msg.num_turns, aid: runId },
        })
      }
      if (results >= sent && final) child.stdin?.end()
    }
  })

  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code && code !== 0 && !lastResult) reject(new Error(short(stderr || `claude exited with code ${code}`, 300)))
      else if (failed && !lastResult) reject(new Error(failed))
      else resolve(lastResult)
    })
  })

  send(first)
  return { child, send, done }
}

export type ClaudeRun = ReturnType<typeof startClaude>

/**
 * The company run: the owner's task goes to the organizer, who delegates to the team. `resume`
 * continues an earlier run's session (e.g. with the owner's late answer to a check-in).
 */
export function runClaudeCeo(
  org: OrgDef,
  runId: string,
  task: string,
  project: ProjectRef,
  o: { resume?: string; onSession?: (id: string) => void } = {},
): ClaudeRun {
  const ceo = org.divisions.find((d) => d.runtime === 'claude' && d.ceo)?.ceo
  if (!ceo) throw new Error('org.yaml has no Claude division with a CEO')
  // A slash command must be the whole message for Claude Code to run it.
  const first = o.resume || task.startsWith('/') ? task : `[Project: ${project.name} — the current folder]\n\n${task}`
  const run = startClaude(org, first, { runId, project, agentId: ceo.id, isCeo: true, model: ceo.model, reportResults: true, resume: o.resume, onSession: o.onSession })
  run.done
    .catch((e) => bus.emit({ runId, kind: 'error', agent: ceo.id, text: short(e instanceof Error ? e.message : String(e), 200) }))
    .finally(() => bus.emit({ runId, kind: 'system', text: 'Run finished', meta: { end: true } }))
  bus.emit({ runId, kind: 'task', from: org.owner.id, to: ceo.id, text: short(task, 120), meta: { full: task, aid: runId } })
  return run
}

/** A 1:1 conversation with one Claude agent; resumes its previous session when there is one. */
export function runClaudeDirect(
  org: OrgDef,
  agent: AgentRef,
  prompt: string,
  o: { runId: string; project: ProjectRef; resume?: string; onSession: (id: string) => void; onChild?: (c: ChildProcess) => void },
): Promise<string> {
  const run = startClaude(org, prompt, {
    runId: o.runId,
    project: o.project,
    agentId: agent.id,
    isCeo: agent.isCeo,
    model: agent.model,
    resume: o.resume,
    onSession: o.onSession,
    reportResults: false,
  })
  o.onChild?.(run.child)
  return run.done
}

/**
 * One delegated task for a Claude agent — a company member or one of the repo's own agents —
 * run as its own session in the project folder. This is how members coordinate each other:
 * Claude Code subagents cannot start subagents themselves, so they ask the app via `delegate`.
 */
export function runClaudeTask(
  org: OrgDef,
  agent: AgentRef,
  prompt: string,
  o: { runId: string; project: ProjectRef; aid: string; taskId?: string; onChild?: (c: ChildProcess) => void },
): Promise<string> {
  const run = startClaude(org, prompt, {
    runId: o.runId,
    project: o.project,
    agentId: agent.id,
    isCeo: false,
    model: agent.model,
    reportResults: false,
    aid: o.aid,
    taskId: o.taskId,
  })
  o.onChild?.(run.child)
  return run.done
}
