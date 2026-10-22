# Agent Trace

**See what Claude Code is doing, live, in VS Code.** Agent Trace draws each turn of a Claude Code session as a flow: your prompt, the main agent, the subagents it spawns, every tool call, the files it changes and the reply. Beside it is your setup (CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins). Each item lights up while something uses it.

Agent Trace only watches. It runs no agents, has no chat and needs no configuration. Keep using Claude Code as usual, in its VS Code extension or in a terminal, and Agent Trace follows along.

> Vietnamese: [README.vi.md](README.vi.md)

## What you get

- **The Flow tab** (`Agent Trace: Open Flow`, or click the status bar item), from left to right:
  - **Setup**: everything Claude Code loads in this folder, labelled by where it comes from:
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
  - the status bar.

  A notification shows once per wait, with a button to open Claude Code. Turn it off with `agentTrace.notifyWhenWaiting`. The signal is Claude Code's own session status (`~/.claude/sessions`), so nothing is installed or changed.
- **Live edges** glow while work is in progress, with comets running along them. An edge from the setup leaves from the exact agent, command, skill or MCP server in use. While Claude works, everything off the current path fades. Hover any card to trace its path instead.
- **Frames** separate the parts of the flow: setup, prompt and slash command, main agent, subagents, tools and output. A frame lights up while work goes through it. Items not used in this turn are faded.
- **Looks like part of VS Code**: backgrounds, cards, lines and text follow your colour theme, whether light, dark or high contrast. The accent that marks work in progress follows your theme too, or you can pick gold, terracotta, ocean, teal, violet or rose with the dots in the header, or set `agentTrace.accentColor`.
- **Click any card for details**: a tool call's input and result, a subagent's task and report, or a setup item's description with a link to its file.
- **The Agent Trace sidebar** lists the Claude Code sessions at work in this folder right now, and its setup. The Flow tab follows the latest session unless you pick one from its session list.
- **The status bar** shows what is running now, e.g. `Claude · Bash npm test · 2 subagents`.
- **The Explorer** marks files being edited in the current turn with a ● badge.

## Setup as Claude Code loaded it

People organise their Claude Code configuration in many ways: `.claude/` folders, `~/.claude`, plugins with their own folders, settings managed by an organisation, repos of configs to copy from. Agent Trace does not guess. At the start of a session, Claude Code writes into its transcript what it loaded: skills, agents, MCP servers and whether they connected, and instruction files. Agent Trace shows that, and uses the files only to say where each item is defined. What sits in the folder but is not loaded goes in a card of its own, **Here, not loaded**, with the reason and what to do about it. Before a folder's first session, the setup is read from the files alone, and the title says so.

## How it works

Claude Code writes a transcript of every session to `~/.claude/projects/<folder>/<session>.jsonl`, and one per subagent next to it. Agent Trace reads what is appended to these files about every 0.7 s and redraws the current turn. The setup comes from `.claude/`, `.mcp.json`, `~/.claude` and the enabled plugins.

Agent Trace keeps only names, descriptions and a few harmless facts from these files. It never reads environment values, headers or arguments of MCP servers, and nothing leaves your machine.

The transcript format is not a public API of Claude Code. Agent Trace skips lines it does not understand instead of failing.

## Requirements

- VS Code 1.100 or later. Editors built on VS Code (Cursor, Windsurf, Antigravity…) work too.
- Claude Code, used in the folder you have open.

## Build from source

```
npm install
npm run package          # → agent-trace.vsix
code --install-extension agent-trace.vsix
```

`npm run typecheck` checks both the extension (`src/`) and the webview (`web/`, `shared/`).

---

Agent Trace is an independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
