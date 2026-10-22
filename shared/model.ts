// What the webview draws: one Claude Code session, as read from its transcript. Built by the extension
// (src/claude.ts), sent to the webview as plain JSON.

export type StepStatus = 'running' | 'done' | 'error'

/** One tool call: Bash, Edit, Read, Grep, an MCP tool… */
export interface Step {
  id: string
  tool: string
  /** Short human summary, e.g. "npm test" or "src/auth.ts". */
  label: string
  /** The call's input, as compact JSON (trimmed). */
  input?: string
  start: number
  end?: number
  status: StepStatus
  /** The result (trimmed). */
  output?: string
  /** A file the step read or wrote, absolute. */
  file?: string
  writes?: boolean
}

export interface Agent {
  /** "main", or the id of the Agent tool call that spawned it. */
  id: string
  kind: 'main' | 'sub'
  /** "Claude" for the main agent; the subagent type (Explore, general-purpose, code-reviewer…) otherwise. */
  type: string
  /** What it was asked: the subagent's description, or the prompt for the main agent. */
  title: string
  prompt?: string
  model?: string
  start: number
  end?: number
  status: StepStatus
  /** Runs in the background: the main agent went on without waiting. */
  background?: boolean
  /** Tool calls of the current turn, oldest first. */
  steps: Step[]
  /** Its latest words (thinking out loud between tools). */
  said?: string
  /** What it handed back: the subagent's report, or the main agent's final reply. */
  output?: string
}

export interface FileTouch {
  path: string
  /** Agent ids that wrote it. */
  by: string[]
  writes: number
  reads: number
  last: number
}

/** The owner's latest message and everything that followed it. */
export interface Turn {
  prompt: string
  /** A slash command the turn started with, e.g. { name: 'review-code', args: '…' }. */
  command?: { name: string; args: string }
  start: number
  end?: number
}

export type SessionStatus = 'working' | 'idle'

export interface SessionView {
  id: string
  title: string
  cwd?: string
  branch?: string
  version?: string
  status: SessionStatus
  /** Last line written to the transcript. */
  last: number
  start?: number
  turn?: Turn
  /** How many turns the session has had, as far as the transcript read so far shows. */
  turns: number
  main: Agent
  subagents: Agent[]
  files: FileTouch[]
  cost?: number
  linesAdded?: number
  linesRemoved?: number
}

export interface SessionSummary {
  id: string
  title: string
  last: number
  status: SessionStatus
}

// ── the setup: what Claude Code loads for this folder ────────────────────────

export type SetupKind = 'memory' | 'agent' | 'command' | 'skill' | 'mcp' | 'hook' | 'plugin' | 'settings'
/**
 * Where an item comes from:
 * - project: the folder's .claude/ (shared through git);
 * - local: the folder's untracked files (settings.local.json, CLAUDE.local.md, ~/.claude.json for this folder);
 * - user: ~/.claude;
 * - plugin: an enabled plugin;
 * - builtin: part of Claude Code;
 * - connector: an MCP server seen in use but not configured in any file (e.g. a claude.ai connector).
 */
export type SetupScope = 'project' | 'local' | 'user' | 'plugin' | 'builtin' | 'connector'

export interface SetupItem {
  kind: SetupKind
  /** As Claude Code calls it: the agent type, the command or skill name, the MCP server, the hook event… */
  name: string
  scope: SetupScope
  /** The plugin it comes with. */
  plugin?: string
  description?: string
  /** The file that defines it. */
  path?: string
  /** A few short facts: "model: sonnet", "stdio · npx", "48 allow rules"… */
  facts?: string[]
}

export interface Setup {
  items: SetupItem[]
}

/** The colour that marks work in progress, everywhere in the flow (setting agentTrace.accentColor). */
export const ACCENTS = ['vscode', 'gold', 'claude', 'ocean', 'teal', 'violet', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]

/** Extension → webview. */
export type ToWebview =
  | { type: 'state'; sessions: SessionSummary[]; current?: SessionView; following: boolean; folder?: string; claudeDir?: string; setup?: Setup; accent?: Accent }

/** Webview → extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; path: string }
  | { type: 'diff'; path: string }
  | { type: 'select'; id: string }
  | { type: 'follow' }
  | { type: 'accent'; accent: Accent }
