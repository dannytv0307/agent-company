# Agent Trace

**Chat with Claude Code or Codex and watch it work, live, in VS Code.** Agent Trace draws each turn of a Claude Code session as a flow: your prompt, the main agent, the subagents it spawns, every tool call, the files it changes and the reply. Beside it is your setup (CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins). Each item lights up while something uses it.

Chat right next to the flow, with **your own Claude Code or Codex**: the CLI you installed and signed into, with your settings, instructions, skills and MCP servers. Or keep using them in their own VS Code extensions or in a terminal: those sessions show on the flow too.

> Vietnamese: [README.vi.md](README.vi.md)

## What you get

- **Claude, Codex, or both:** above the message box, **Send to** picks who gets each message. With both, Codex makes the changes while Claude reviews and advises. With **Hand-over** on, each can give the other a task (Claude has `ask_codex`, Codex has `ask_claude`, one step only): the task, the answer, and any permission the other agent needs show in the chat and on the flow. The flow has a lane per agent, Claude above Codex, with the two factories on the left:
  - **Claude factory**: what Claude Code loads here (CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins, settings);
  - **Codex factory**: what Codex loads here, as Codex itself reports it: AGENTS.md (yours in ~/.codex and the repo's), skills (yours, the repo's, built in), MCP servers with their connection, plugins, hooks and the config files (user, project, managed).
  - With Codex, `/` lists its skills and inserts `$skill`, as in Codex; the mode picker offers Codex's approvals: Read only, Auto, Full access.
- **The chat**, in a drawer on the left of the Agent Trace tab that folds away. Drag its right edge to make it wider or narrower (double-click the edge for the default width):
  - replies stream in, and tool calls show as lines (the flow has the details);
  - **Stop** ends a turn;
  - type `/` for slash commands: Claude Code's own, yours, the project's, skills and plugins';
  - pick the model and the permission mode, as in Claude Code, and the effort on a slider (drag it, click a level, or use the arrow keys). Unset, they follow your Claude Code settings.
- **Answer Claude in the chat or on the flow:**
  - a permission to run a tool: Allow, Always allow or Deny, also right on the waiting tool call;
  - a question: pick an option or write your own answer;
  - a plan: approve it, or keep planning.
- **MCP servers, as they are now.** Click the MCP servers card: once Claude Code runs here, their status comes live from it (connected with its tools, failed with the error, needs sign-in, disabled) and stays in sync while it runs. **Check now** asks Claude Code without sending any message; **Reconnect** retries a failed server, or all the failed ones at once. A server that needs sign-in is signed in with `/mcp` in Claude Code in a terminal, then reconnected here.
- **Sessions** of the open folder, in the sidebar and at the top of the chat: open one to see its flow and continue it, start a new chat, or delete one (it goes to the trash). Sessions are ordinary Claude Code sessions: continue them with `/resume` in a terminal or in Claude Code's extension, and the other way round.
- **The flow** (`Agent Trace: Open`, or click the status bar item), from left to right:
  - **Claude factory**: everything Claude Code loads in this folder (its setup), labelled by where it comes from. Fold it into a tab with its title, or fold one kind of it (agents, skills, MCP servers…) into its header with the arrow beside it:
    - `project`: the folder's `.claude/`;
    - `local`: files not checked into git;
    - `user`: `~/.claude`;
    - or the name of the plugin that provides it.
  - **Prompt**: your prompt, and the slash command it ran.
  - **Agents**: the main agent and what it is doing now, then its subagents (Explore, general-purpose, your own `.claude/agents`…).
  - **Tools**: the latest tool calls.
  - **Output**: the reply, each subagent's report, and the files changed. Click a file to open its diff.
- **The Now bar** at the top shows where work is going at a glance, e.g. `/ship (project command) → Claude → code-reviewer (project agent) → Grep TODO`. Each step is clickable.
- **When Claude needs you**, Agent Trace says what for: a permission to run a tool, a question, a plan to approve. It shows in four places:
  - the Now bar, e.g. *Needs you · Claude asks to run Bash npm test*;
  - the header;
  - the card and tool call that wait, in amber;
  - the status bar, and the sidebar with a bell.

  A notification shows once per wait while the tab is out of sight. For a session run elsewhere, it has a button to open Claude Code. Turn it off with `agentTrace.notifyWhenWaiting`.
- **Live edges** glow while work is in progress, with comets running along them. An edge from the setup leaves from the exact agent, command, skill or MCP server in use. While Claude works, everything off the current path fades. Hover any card to trace its path instead.
- **Frames** separate the parts of the flow, all level at the top: the Claude factory, prompt and slash command, main agent, subagents, tools and output. A frame lights up while work goes through it. Items not used in this turn are faded.
- **Looks like part of VS Code**: backgrounds, cards, lines and text follow your colour theme, whether light, dark or high contrast. The accent that marks work in progress follows your theme too, or you can pick gold, terracotta, ocean, teal, violet or rose with the dots in the header, or set `agentTrace.accentColor`.
- **Click any card for details**: a tool call's input and result, a subagent's task and report, or a setup item's description with a link to its file.
- **The Agent Trace sidebar** lists the folder's sessions (Claude Code and Codex), those at work marked, then the Claude Factory and the Codex Factory as trees: click an item to open its file. Opening the tab while Claude Code works in another window shows that session.
- **The status bar** shows what is running now, e.g. `Claude · Bash npm test · 2 subagents`.
- **The Explorer** marks files being edited in the current turn with a ● badge.

## Setup as Claude Code loaded it

People organise their Claude Code configuration in many ways: `.claude/` folders, `~/.claude`, plugins with their own folders, settings managed by an organisation, repos of configs to copy from. Agent Trace does not guess. At the start of a session, Claude Code writes into its transcript what it loaded: skills, agents, MCP servers and whether they connected, and instruction files. Agent Trace shows that, and uses the files only to say where each item is defined. What sits in the folder but is not loaded goes in a card of its own, **Here, not loaded**, with the reason and what to do about it. Before a folder's first session, the setup is read from the files alone, and the title says so.

## How it runs Claude and Codex

The chat runs **your own Claude Code CLI**, the `claude` you installed and logged into. It drives it through the Claude Agent SDK, over the same stream-json channel Claude Code's own VS Code extension uses. Agent Trace never logs in, never reads a token, and ships no CLI of its own. If `claude` is not on PATH, set `agentTrace.claudePath`.

With Codex it runs **your own Codex CLI** through `codex app-server`, the channel Codex's own VS Code extension uses: the same sign-in, config, threads and approvals. Threads stay ordinary Codex threads, listed in Codex too. Archiving one here archives it in Codex, which can restore it. If `codex` is not on PATH, set `agentTrace.codexPath`.

## How it draws the flow

Claude Code writes a transcript of every session to `~/.claude/projects/<folder>/<session>.jsonl`, and one per subagent next to it. Agent Trace reads what is appended to these files about every 0.7 s and redraws the current turn. The setup comes from `.claude/`, `.mcp.json`, `~/.claude` and the enabled plugins.

Agent Trace keeps only names, descriptions and a few harmless facts from these files. It never reads environment values, headers or arguments of MCP servers. Agent Trace itself sends nothing anywhere: what you type in the chat goes to your Claude Code CLI, which talks to Anthropic as it always does.

The transcript format is not a public API of Claude Code. Agent Trace skips lines it does not understand instead of failing.

## Requirements

- VS Code 1.100 or later. Editors built on VS Code (Cursor, Windsurf, Antigravity…) work too.
- Claude Code installed and logged in: run `claude` once in a terminal, then `/login`.
- For Codex (optional): Codex installed and signed in: `npm install -g @openai/codex`, then run `codex` once.

## Build from source

```
npm install
npm run package          # → agent-trace.vsix
code --install-extension agent-trace.vsix
```

`npm run typecheck` checks both the extension (`src/`) and the webview (`web/`, `shared/`).

---

Agent Trace is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
