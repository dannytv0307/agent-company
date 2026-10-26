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
  /** Unset: Claude Code. */
  engine?: Engine
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

/** "approval": a server of the folder's .mcp.json that Claude Code starts only once the user says yes. */
export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'approval'

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

/** Who does the work: Claude Code, or Codex. */
export type Engine = 'claude' | 'codex'

export interface SessionSummary {
  id: string
  /** Unset: Claude Code. */
  engine?: Engine
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
  /** For an MCP server, how its connection went in the session (or is now, in the Claude Code run here). */
  status?: McpStatus
  error?: string
  /** An MCP server as the Claude Code run here names it, to reconnect it by. */
  server?: string
  /** An MCP server's tools, when connected. */
  tools?: number
}

export interface Setup {
  items: SetupItem[]
  /** Whose setup: Claude Code's (unset) or Codex's. */
  engine?: Engine
  /** As the agent itself reported loading it, rather than read from files. */
  resolved?: boolean
}

/** The colour that marks work in progress, everywhere in the flow (setting agentTrace.accentColor). */
export const ACCENTS = ['vscode', 'gold', 'claude', 'ocean', 'teal', 'violet', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]

/** Extension → webview. */
export type ToWebview =
  | {
      type: 'state'
      sessions: SessionSummary[]
      current?: SessionView
      following: boolean
      folder?: string
      claudeDir?: string
      setup?: Setup
      accent?: Accent
      /** The chat on screen, when there is one. */
      chat?: ChatState
      /** The user's own Claude Code CLI, which the chat runs. */
      cli?: CliState
      /** The user's own Codex CLI, when installed. */
      codex?: CliState
      /** Both agents' sessions of the trace on screen, for a flow with a lane each. */
      views?: { claude?: SessionView; codex?: SessionView }
      /** The Codex factory, beside the Claude factory (`setup`). */
      codexSetup?: Setup
      /** Hand-overs of the latest turn, and the agents the user's prompt went to. */
      handoffs?: Handoff[]
      direct?: Engine[]
    }

// ── chat: the user's Claude Code CLI, driven from here ──────────────

export interface CliState {
  path?: string
  version?: string
  /** Not found, or not working: what to do. */
  problem?: string
}

/** A line of the chat; `engine` says whose it is when a chat holds both agents. */
export type ChatLine = (
  /** `from`: handed over by the other agent rather than typed by the user; `to`: whom the user sent it to. */
  | { kind: 'user'; text: string; at: number; from?: Engine; to?: Engine[]; hidden?: boolean }
  | { kind: 'assistant'; text: string; at: number; streaming?: boolean }
  /** A tool call of the main agent, in a line; the flow has the details. */
  | { kind: 'tool'; id: string; tool: string; label: string; status: 'running' | 'done' | 'error'; at: number }
  | { kind: 'result'; text: string; at: number; error?: boolean }
  | { kind: 'error'; text: string; at: number }
) & { engine?: Engine }

/** An agent asking the user: a permission, a question, a plan. `engine` says which agent asks. */
export type Ask = (
  | {
      kind: 'permission'
      requestId: string
      toolUseId?: string
      tool: string
      /** What it wants to do, in a sentence, when the CLI gives one. */
      title: string
      detail?: string
      /** A persistent "always allow" is allowed for this one. */
      canAlways: boolean
      at: number
    }
  | {
      kind: 'question'
      requestId: string
      toolUseId?: string
      questions: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[]
      at: number
    }
  | { kind: 'plan'; requestId: string; toolUseId?: string; plan: string; at: number }
) & { engine?: Engine }

export interface ChatState {
  /** Unset: Claude Code. */
  engine?: Engine
  /** Stable for the chat's life. */
  key: string
  /** Claude Code's session id, once it has given one. */
  sessionId?: string
  lines: ChatLine[]
  busy: boolean
  asks: Ask[]
  /** The slash commands this session offers (asked for when the user first types "/"). */
  commands?: SlashCmd[]
  /** Chosen here; unset means the user's own default from their Claude Code settings. */
  model?: string
  effort?: Effort
  mode?: Mode
  /** The models the user's Claude Code offers, once asked for. */
  models?: ModelChoice[]
  /** MCP servers as the Claude Code run here reports them right now, and when it last did. */
  mcp?: { servers: McpLive[]; at: number }
  /** MCP servers being reconnected. */
  reconnecting?: string[]
  /** The session runs in another Claude Code window: what is done here does not reach it. */
  elsewhere?: boolean
  /** A trace: whom the next message goes to, whether the agents may hand work to each other, and each one's part. */
  target?: Target
  delegate?: boolean
  claude?: ChatState
  codex?: ChatState
}

/** Whom a message goes to. */
export type Target = Engine | 'both'

/** One agent handing a task to the other (ask_codex / ask_claude), in the latest turn. */
export interface Handoff {
  id: string
  from: Engine
  to: Engine
  task: string
  status: 'running' | 'done' | 'error'
  at: number
  /** What came back, in short. */
  result?: string
}

export interface McpLive {
  /** As Claude Code names it: "github", "plugin:playwright:playwright", "claude.ai Gmail"… */
  name: string
  status: McpStatus
  error?: string
  /** Where it is configured: project, user, local, plugin, claudeai, managed… */
  scope?: string
  tools?: number
  /** What the server says it is: "name version". */
  info?: string
}

/** Claude Code's levels; Codex may offer others ("minimal", "ultra"…). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {})
/** Claude Code's permission modes, and Codex's approval presets (read-only, workspace, full-access). */
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'read-only' | 'workspace' | 'full-access'

export interface ModelChoice {
  value: string
  name: string
  description?: string
  /** Effort levels it accepts; none: no effort setting. */
  efforts?: Effort[]
}

export interface SlashCmd {
  name: string
  description: string
  argumentHint?: string
  /** Claude Code's own, rather than the user's, a project's or a plugin's. */
  builtin?: boolean
  /** What picking it puts in the prompt, when not "/name " (a Codex skill: "$name "). */
  insert?: string
  /** A Codex skill's SKILL.md, sent along with the prompt that names it. */
  path?: string
}

export type Decision = { kind: 'allow' } | { kind: 'always' } | { kind: 'deny'; message?: string } | { kind: 'answers'; answers: Record<string, string> }

/** Webview → extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; path: string }
  | { type: 'diff'; path: string }
  | { type: 'select'; id: string }
  | { type: 'follow' }
  | { type: 'accent'; accent: Accent }
  /** A new chat, with Claude Code (default) or Codex. */
  | { type: 'chat.new'; engine?: Engine }
  /** Something went wrong in the page: to the Output panel. */
  | { type: 'log'; text: string; error?: boolean }
  | { type: 'chat.send'; text: string; target?: Target; delegate?: boolean }
  /** The recipient and the hand-over switch, as set in the composer. */
  | { type: 'chat.route'; target?: Target; delegate?: boolean }
  | { type: 'chat.stop' }
  | { type: 'chat.commands'; engine?: Engine }
  | { type: 'chat.models'; engine?: Engine }
  /** null: back to the user's default. */
  | { type: 'chat.settings'; engine?: Engine; model?: string | null; effort?: Effort | null; mode?: Mode | null }
  | { type: 'session.delete'; id: string }
  /** An agent was not found: how to set it up, or look for it again. */
  | { type: 'setup.help'; engine: Engine }
  /** Ask the Claude Code run here how its MCP servers are, starting it if need be (nothing is sent). */
  | { type: 'mcp.check'; engine?: Engine }
  | { type: 'mcp.reconnect'; engine?: Engine; names: string[] }
  | { type: 'chat.decide'; requestId: string; decision: Decision }

/** What a trace adds for Claude when a message goes to both agents; shown without it. */
export const BOTH_NOTE = '\n\n(Codex is working on this in parallel and makes the changes. Review and advise only: do not edit files.)'
