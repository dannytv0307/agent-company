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
  /** Launched in an earlier turn (a background subagent, still shown). */
  earlier?: boolean
  /** Its transcript's latest line. */
  last?: number
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
  /** What Claude Code says it loaded in this session, when its transcript tells (see Loaded). */
  loaded?: Loaded
  /** Claude Code is waiting for the user: a permission to grant, a question, a dialog (see waiting.ts). */
  waiting?: Waiting
}

/** As Claude Code reports it in ~/.claude/sessions/<pid>.json while the session is open. */
export interface Waiting {
  /** Claude Code's own word for it: "input needed", "dialog open", "sandbox request"… */
  reason?: string
  since: number
}

export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending'

/**
 * The setup as Claude Code itself resolved it, from the listings it writes into the transcript: every
 * rule of precedence, plugin, managed setting and disabled item already applied. The ground truth the
 * file scan is checked against.
 */
export interface Loaded {
  /** Skill names, plugin ones as "plugin:skill". */
  skills: string[]
  /** Agent types, built-in ones included. */
  agents: string[]
  builtinAgents: string[]
  /** MCP servers by their tool prefix ("github", "plugin_playwright_playwright", "claude_ai_Gmail"). */
  mcp: { name: string; status: McpStatus; error?: string }[]
  /** Instruction files Claude Code reported loading (auto memory, nested CLAUDE.md…). */
  instructions: { path: string; type: string }[]
}

export interface SessionSummary {
  id: string
  title: string
  last: number
  status: SessionStatus
  /** Claude Code is waiting for the user in this session. */
  waiting?: boolean
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
 * - connector: an MCP server seen in use but not configured in any file (e.g. a claude.ai connector);
 * - session: loaded by Claude Code, from somewhere no file here explains (e.g. managed by an organisation).
 */
export type SetupScope = 'project' | 'local' | 'user' | 'plugin' | 'builtin' | 'connector' | 'session'

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
  /** Here, but not loaded by Claude Code — and why, with what to do about it. */
  unloaded?: string
  /** Confirmed loaded by the session's own listing. */
  loaded?: boolean
  /** For an MCP server, how its connection went in the session. */
  status?: McpStatus
  error?: string
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
