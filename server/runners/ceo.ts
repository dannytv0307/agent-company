// Starts the organizer on whichever engine the owner chose: Claude Code or Codex.
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { OrgDef, ProjectRef } from '../../shared/types.ts'
import { bus } from '../events.ts'
import { DATA_DIR, mainCeo } from '../org.ts'
import { ceoPrompt } from '../compile.ts'
import { expandCommand } from '../commands.ts'
import { runClaudeCeo } from './claude.ts'
import { repoContext, runCodexAgent } from './codex.ts'
import { short } from './summarize.ts'

// Each run's session (Claude) or thread (Codex), so a later answer can resume exactly where it stopped.
const SESSIONS_FILE = path.join(DATA_DIR, 'run-sessions.json')
const runSessions: Record<string, { engine: 'claude' | 'codex'; id: string }> = existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) : {}
function rememberSession(runId: string, engine: 'claude' | 'codex', id: string) {
  runSessions[runId] = { engine, id }
  const recent = Object.entries(runSessions).slice(-200)
  writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(recent), null, 2))
}
export const sessionOfRun = (runId?: string) => (runId ? runSessions[runId] : undefined)

export interface CeoRun {
  child?: ChildProcess
  /** Inject an owner message into the running session (Claude only; Codex reads its inbox instead). */
  send: (text: string) => boolean
  done: Promise<string>
}

export function startCeoRun(org: OrgDef, runId: string, task: string, project: ProjectRef, opts: { resume?: string } = {}): CeoRun {
  const ceo = mainCeo(org)
  if (!ceo) throw new Error('org.yaml has no CEO')
  if (ceo.runtime !== 'codex') return runClaudeCeo(org, runId, task, project, { resume: opts.resume, onSession: (id) => rememberSession(runId, 'claude', id) })

  // Codex has no subagents and no mid-run input: the CEO coordinates through the agent-company
  // MCP tools (delegate, plan, inbox), and owner messages wait in its inbox.
  const run: CeoRun = { send: () => false, done: Promise.resolve('') }
  bus.emit({ runId, kind: 'task', from: org.owner.id, to: ceo.id, text: short(task, 120), meta: { full: task, aid: runId } })
  // Codex has no slash commands: the app expands the repo's command file into the prompt.
  const body = expandCommand(project.dir, task) ?? task
  run.done = runCodexAgent(org, ceo, org.owner.id, opts.resume ? body : `[Project: ${project.name} — the current folder]\n\n${body}`, runId, {
    dir: project.dir,
    raw: true,
    intro: `${ceoPrompt(org, ceo, project)}${repoContext(project.dir)}`,
    aid: runId,
    sandbox: ceo.sandbox ?? 'workspace-write',
    resume: opts.resume,
    onThread: (id) => rememberSession(runId, 'codex', id),
    onChild: (c) => (run.child = c),
  })
  run.done
    .then((text) => bus.emit({ runId, kind: 'report', from: ceo.id, to: org.owner.id, agent: ceo.id, text: short(text, 140), meta: { full: text, aid: runId } }))
    .catch((e) => bus.emit({ runId, kind: 'error', agent: ceo.id, text: short(e instanceof Error ? e.message : String(e), 200), meta: { aid: runId } }))
    .finally(() => bus.emit({ runId, kind: 'system', text: 'Run finished', meta: { end: true } }))
  return run
}

/** The org with the CEO's engine overridden for one run (e.g. "lead this task with Codex"). */
export function withCeoRuntime(org: OrgDef, runtime?: 'claude' | 'codex'): OrgDef {
  if (!runtime) return org
  return {
    ...org,
    // Switching engines drops the model: each engine has its own model names.
    divisions: org.divisions.map((d) =>
      d.ceo && d.ceo.id === mainCeo(org)?.id ? { ...d, ceo: { ...d.ceo, runtime, ...((d.ceo.runtime ?? 'claude') !== runtime ? { model: undefined } : {}) } } : d,
    ),
  }
}
