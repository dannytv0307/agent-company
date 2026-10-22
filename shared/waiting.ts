// When Claude Code is waiting for the user — to allow a tool, answer a question, approve a plan — and
// what for, in words. Shared by the extension (status bar, notification) and the webview (the flow).
import type { Agent, SessionView, Step } from './model.ts'

/** The tool call still open, most recent first: what a permission prompt or a question is about. */
export function pendingStep(v: SessionView): { step: Step; agent: Agent } | undefined {
  let best: { step: Step; agent: Agent } | undefined
  for (const agent of [v.main, ...v.subagents])
    for (const step of agent.steps) if (step.status === 'running' && (!best || step.start > best.step.start)) best = { step, agent }
  return best
}

/** Tools that always wait for the user, whatever else Claude Code says. */
const ASKS: Record<string, string> = {
  AskUserQuestion: 'Claude asked you a question',
  ExitPlanMode: 'Claude wants your OK on its plan',
}

/** What Claude is waiting for, or undefined when it is not. */
export function waitingText(v: SessionView | undefined): string | undefined {
  if (!v || !v.turn || v.turn.end) return undefined
  const p = pendingStep(v)
  if (p && ASKS[p.step.tool]) return ASKS[p.step.tool]
  if (!v.waiting) return undefined
  const who = p && p.agent.kind === 'sub' ? p.agent.type : 'Claude'
  switch (v.waiting.reason) {
    case 'input needed':
      return `${who} needs your input`
    case 'sandbox request':
      return 'A command needs network access'
    case 'worker request':
      return 'A worker needs your OK'
  }
  if (p) return `${who} asks to run ${p.step.tool}${p.step.label ? ` ${p.step.label}` : ''}`
  if (v.waiting.reason === 'dialog open') return 'A dialog is open in Claude Code'
  return v.waiting.reason ? `Claude is waiting: ${v.waiting.reason}` : 'Claude is waiting for you'
}
