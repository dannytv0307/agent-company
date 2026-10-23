// A trace: one conversation with Claude Code and Codex. Each message goes to Claude, to Codex or to
// both; with hand-over on, each agent gets a tool of Agent Trace's own to give the other a task
// (ask_codex for Claude, ask_claude for Codex), and the flow draws that hand-over between their lanes.
// The two sessions stay ordinary ones: a Claude Code session and a Codex thread.
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { BOTH_NOTE, type Ask, type ChatLine, type ChatState, type Decision, type Effort, type Engine, type Handoff, type Mode, type Target } from '../shared/model.ts'
import type { Chat } from './chat.ts'
import type { CodexChat, CodexTools } from './codex.ts'

const NAME: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' }
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** What a hand-over tool tells the agent that has it. */
const ASK_DESC: Record<Engine, string> = {
  codex:
    'Hand a self-contained task to Codex, the user’s other coding agent, working in the same folder, and wait for its answer. Use it when the user asks for Codex, or when a second agent’s implementation, review or opinion helps. Give the task in full: Codex does not see this conversation.',
  claude:
    'Hand a self-contained task to Claude (Claude Code), the user’s other coding agent, working in the same folder, and wait for its answer. Use it when the user asks for Claude, or when a second agent’s review, plan or opinion helps. Give the task in full: Claude does not see this conversation.',
}

/**
 * What each agent is told about where it runs: inside Agent Trace, started through an SDK, with the
 * user's own setup — and what the hand-over tool is, so neither takes it for something foreign.
 */
function aboutHere(e: Engine, handOver: boolean): string {
  const how = e === 'claude' ? 'this Claude Code session through the Claude Agent SDK' : 'this Codex thread through codex app-server'
  const tool =
    e === 'claude'
      ? 'The `agent_trace` MCP server comes from Agent Trace itself, not from the user’s configuration: its tool `ask_codex` hands a self-contained task to Codex (OpenAI’s Codex CLI, the user’s other coding agent) in the same folder and returns its answer. Agent Trace allows it without a prompt because the user turned hand-over on.'
      : 'The tool `ask_claude` comes from Agent Trace itself, not from the user’s configuration: it hands a self-contained task to Claude Code (the user’s other coding agent) in the same folder and returns its answer.'
  return [
    `You are running inside Agent Trace, a VS Code extension the user installed to chat with their coding agents and watch them work. Agent Trace started ${how}, in the user’s folder, with the user’s own settings, instructions, skills and MCP servers. Permission prompts and questions reach the user in Agent Trace’s chat and on its flow.`,
    handOver ? tool : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** What the trace needs from the extension: the agents themselves. */
export interface TraceDeps {
  has(e: Engine): boolean
  makeClaude(resume: string | undefined, history: ChatLine[], tools: Record<string, McpServerConfig> | undefined, changed: () => void, about: string): Chat
  makeCodex(resume: string | undefined, tools: CodexTools | undefined, changed: () => void, about: string): CodexChat | undefined
}

let counter = 0

export class Trace {
  readonly key = `trace-${Date.now()}-${++counter}`
  claude?: Chat
  codex?: CodexChat
  target: Target
  delegate = true
  /** The user's own messages (shown once, whoever they went to) and the trace's notes. */
  private own: ChatLine[] = []
  /** Hand-overs since the user's latest message. */
  handoffs: Handoff[] = []
  /** The agents the user's latest message went to. */
  direct: Engine[] = []

  constructor(
    private readonly deps: TraceDeps,
    private readonly changed: () => void,
    target: Target,
    open?: { claude?: { resume: string; history: ChatLine[] }; codex?: { resume: string } },
  ) {
    this.target = target
    if (open?.claude) this.claude = this.makeClaude(open.claude.resume, open.claude.history)
    if (open?.codex) this.codex = this.makeCodex(open.codex.resume)
    this.direct = [this.claude, this.codex].filter((c) => !!c).map((c) => c!.engine)
  }

  /** The agent in front: the one the user's latest message went to (Claude first, with both). */
  get lead(): Engine {
    return this.direct.find((e) => this.part(e)) ?? (this.claude || !this.codex ? 'claude' : 'codex')
  }

  get busy() {
    return !!(this.claude?.busy || this.codex?.busy)
  }

  part(e: Engine): Chat | CodexChat | undefined {
    return e === 'claude' ? this.claude : this.codex
  }

  /** The agent's chat, started on first need. */
  ensure(e: Engine): Chat | CodexChat | undefined {
    if (e === 'claude') return (this.claude ??= this.deps.has('claude') ? this.makeClaude(undefined, []) : undefined)
    return (this.codex ??= this.deps.has('codex') ? this.makeCodex(undefined) : undefined)
  }

  private makeClaude(resume: string | undefined, history: ChatLine[]) {
    const tools = this.claudeTools()
    return this.deps.makeClaude(resume, history, tools, this.changed, aboutHere('claude', !!tools))
  }

  private makeCodex(resume: string | undefined) {
    const tools = this.codexTools()
    return this.deps.makeCodex(resume, tools, this.changed, aboutHere('codex', !!tools))
  }

  // ── hand-over ──────────────────────────────────────────────────────────

  /** Claude's tool to hand Codex a task (only when Codex is there to take it). */
  private claudeTools(): Record<string, McpServerConfig> | undefined {
    if (!this.deps.has('codex')) return undefined
    const ask = tool(
      'ask_codex',
      ASK_DESC.codex,
      { task: z.string().describe('The task for Codex, complete and self-contained.'), context: z.string().optional().describe('What Codex needs to know from this conversation.') },
      async (a) => {
        try {
          return { content: [{ type: 'text', text: await this.handOver('claude', 'codex', a.task, a.context) }] }
        } catch (e) {
          return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }
        }
      },
    )
    return { agent_trace: createSdkMcpServer({ name: 'agent_trace', version: '1.0.0', tools: [ask] }) }
  }

  /** Codex's tool to hand Claude a task (only when Claude Code is there to take it). */
  private codexTools(): CodexTools | undefined {
    if (!this.deps.has('claude')) return undefined
    return {
      specs: [
        {
          type: 'function',
          name: 'ask_claude',
          description: ASK_DESC.claude,
          inputSchema: {
            type: 'object',
            properties: { task: { type: 'string', description: 'The task for Claude, complete and self-contained.' }, context: { type: 'string', description: 'What Claude needs to know from this conversation.' } },
            required: ['task'],
            additionalProperties: false,
          },
        },
      ],
      call: (name, args) => {
        if (name !== 'ask_claude') return Promise.reject(new Error(`Unknown tool ${name}`))
        return this.handOver('codex', 'claude', String(args?.task ?? ''), typeof args?.context === 'string' ? args.context : undefined)
      },
    }
  }

  /** One agent gives the other a task; its answer goes back as the tool's result. One step only. */
  private async handOver(from: Engine, to: Engine, task: string, context?: string): Promise<string> {
    if (!this.delegate) throw new Error(`The user has turned hand-over off: do this yourself, without ${NAME[to]}.`)
    if (this.handoffs.some((h) => h.to === from && h.status === 'running')) throw new Error(`You are working on a task ${NAME[to]} handed you: hand-over goes one step only. Do it yourself.`)
    if (!task.trim()) throw new Error('Give the task.')
    const chat = this.ensure(to)
    if (!chat) throw new Error(`${NAME[to]} is not available here.`)
    const h: Handoff = { id: `h${Date.now()}`, from, to, task: clip(task, 300), status: 'running', at: Date.now() }
    this.handoffs.push(h)
    this.changed()
    try {
      const answer = await chat.run(context ? `${task}\n\nContext from ${NAME[from]}:\n${context}` : task, from)
      h.status = 'done'
      h.result = clip(answer, 200)
      return answer
    } catch (e) {
      h.status = 'error'
      h.result = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      this.changed()
    }
  }

  // ── the conversation ───────────────────────────────────────────────────

  send(text: string, target: Target) {
    if (!text.trim()) return
    this.target = target
    const to: Engine[] = (target === 'both' ? (['claude', 'codex'] as Engine[]) : [target]).filter((e) => this.deps.has(e))
    if (!to.length) return
    this.direct = to
    this.handoffs = []
    this.own.push({ kind: 'user', text, at: Date.now(), to })
    for (const e of to) {
      const chat = this.ensure(e)
      // Both at once: Codex makes the changes, Claude looks and says what it thinks (said to Claude).
      const said = target === 'both' && e === 'claude' ? text + BOTH_NOTE : text
      chat?.send(said, undefined, true)
    }
    if (target === 'both') this.own.push({ kind: 'result', text: 'Sent to both: Codex makes the changes, Claude reviews and advises.', at: Date.now() + 1 })
    this.changed()
  }

  stop() {
    void this.claude?.stop()
    void this.codex?.stop()
  }

  decide(requestId: string, d: Decision) {
    this.claude?.decide(requestId, d)
    this.codex?.decide(requestId, d)
  }

  configure(e: Engine, s: { model?: string | null; effort?: Effort | null; mode?: Mode | null }) {
    return this.ensure(e)?.configure(s)
  }

  route(target?: Target, delegate?: boolean) {
    if (target) this.target = target
    if (delegate !== undefined) this.delegate = delegate
    this.changed()
  }

  state(): ChatState {
    const c = this.claude?.state()
    const x = this.codex?.state()
    const tag = (e: Engine) => (l: ChatLine) => ({ ...l, engine: e })
    const lines = [...(c?.lines ?? []).map(tag('claude')), ...(x?.lines ?? []).map(tag('codex')), ...this.own]
      .filter((l) => !(l.kind === 'user' && l.hidden))
      .sort((a, b) => a.at - b.at)
      .slice(-240)
    const asks: Ask[] = [...(c?.asks ?? []).map((a) => ({ ...a, engine: 'claude' as Engine })), ...(x?.asks ?? []).map((a) => ({ ...a, engine: 'codex' as Engine }))]
    const lead = this.lead === 'claude' ? c : x
    return {
      key: this.key,
      engine: this.lead,
      sessionId: lead?.sessionId,
      lines,
      busy: this.busy,
      asks,
      target: this.target,
      delegate: this.delegate,
      claude: c,
      codex: x,
    }
  }

  dispose() {
    this.claude?.dispose()
    this.codex?.dispose()
  }
}

