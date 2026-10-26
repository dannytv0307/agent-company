# Agent Trace

**Chat with Claude Code and Codex in VS Code, and watch them work, live.** Ask one, the other, or both. Let them hand each other tasks. Every turn is drawn as a flow: your prompt, each agent, the subagents it spawns, every tool call, the files it changes and the reply, beside the setup each agent loaded (the **Claude factory** and the **Codex factory**).

Agent Trace runs **your own** Claude Code and Codex, the CLIs you installed and signed into, with your settings, instructions, skills and MCP servers. It never signs in for you, never reads a token, and ships no agent of its own.

> Vietnamese: [README.vi.md](README.vi.md)

- [What you get](#what-you-get)
- [Set up](#set-up): Agent Trace, Claude Code, Codex
- [Using Agent Trace](#using-agent-trace)
- [Configure Claude Code and Codex](#configure-claude-code-and-codex)
- [Permissions](#permissions)
- [Settings](#settings)
- [Troubleshooting](#troubleshooting)
- [How it works, and your data](#how-it-works-and-your-data)

## What you get

- **One chat, two agents.** Above the message box, **Send to** picks who gets each message: Claude, Codex, or Both. With both, Codex makes the changes while Claude reviews and advises. Every line carries its agent's mark.
- **Hand-over.** With it on, Claude can give Codex a task (`ask_codex`) and Codex can give Claude one (`ask_claude`), one step only. The task and the answer show in the chat, and on the flow as a line between the two agents.
- **A live flow, a lane per agent.** Claude above, Codex below, each with its tools, subagents and reply. The **Now** bar says where work is going right now, e.g. `Claude → code-reviewer → Grep TODO`.
- **The factories:** what each agent loads in this folder, as it loaded it: CLAUDE.md or AGENTS.md, agents, slash commands, skills, MCP servers (with their connection), hooks, plugins and settings. Items light up while in use. Fold a factory, or one kind of it, out of the way.
- **Answer the agents where you are:** permissions (Allow, Always allow, Deny), questions and plans, in the chat or right on the waiting tool call.
- **MCP servers as they are now:** connected (with their tools), failed (with the error), waiting for sign-in. Check them again, or reconnect, without sending a message.
- **Your sessions:** every Claude Code session and Codex thread of the folder, in the sidebar. Continue one here, or keep using the agents in a terminal or their own extensions: those sessions show on the flow too.

## Set up

You need **VS Code 1.100 or later** (Cursor, Windsurf and other editors built on VS Code work too) and **at least one** of Claude Code and Codex. Install both to chat with both.

### 1. Install Agent Trace

Search for **Agent Trace** in the Extensions view (publisher `dannytv0307`) and install it. An **Agent Trace** icon appears in the activity bar.

### 2. Install Claude Code, and log in

Install it with one of these, in a terminal:

| System | Command |
|---|---|
| macOS, Linux, WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Any, with Node.js 18+ | `npm install -g @anthropic-ai/claude-code` |

Then log in once: run `claude`, type `/login`, and follow the steps (a Claude subscription or an Anthropic Console account). Check it with `claude --version`.

### 3. Install Codex, and sign in

| System | Command |
|---|---|
| Any, with Node.js | `npm install -g @openai/codex` |
| macOS (Homebrew) | `brew install --cask codex` |

Then sign in once: run `codex` and follow the sign-in (your ChatGPT account, or an API key). Check it with `codex --version`.

### 4. Open Agent Trace

Open a folder, then click the Agent Trace icon, the **Agent Trace** item in the status bar, or run **Agent Trace: Open** from the Command Palette.

- Only one of them installed? Agent Trace works with that one, and warns you once per session that the other was not found (a notification, and a banner in the chat), with how to install it. **Don’t show again** turns the notification off for that agent.
- Installed an agent while VS Code was open? Run **Agent Trace: Find Claude Code and Codex**, or reload the window.
- An agent Agent Trace cannot find shows a **Set up …** link beside **Send to**: it says what is missing and what to do.
- Installed it somewhere unusual? Set its path: `agentTrace.claudePath` or `agentTrace.codexPath` (see [Settings](#settings)).

## Using Agent Trace

### The chat

- **Send to:** Claude, Codex or Both. **Hand-over** (on by default) lets the agent you write to give the other a task when it helps.
- **Model, effort and mode** sit under the message box, for the agent you write to (with Both, the small C/X switch picks whose). Unset, they follow your own settings. What you pick is remembered for the next chat.
- **`/`** lists Claude Code's slash commands (yours, the project's, built-in, skills, plugins), or Codex's skills (inserting `$skill`).
- **Stop** ends the turn. **＋** starts a new chat. Drag the chat's right edge to make it wider; fold it away with **‹**.

### The flow

- From left to right: the factories, your prompt, the agents (a lane each), their tools and subagents, and what came out.
- Click any card for its details: a tool call's input and result, a subagent's task and report, a setup item and its file. Click a changed file to open its diff.
- Hover a card to trace the path through it. A new message starts the flow over; subagents still at work stay, marked *earlier*.

### The sidebar

- **Sessions:** the folder's Claude Code sessions and Codex threads. Open one to see its flow and continue it. Delete a Claude session (it goes to the trash) or archive a Codex thread (Codex can restore it).
- **Claude Factory** and **Codex Factory:** the same setup as trees; click an item to open its file.

## Configure Claude Code and Codex

Agent Trace starts each agent exactly as the CLI would in your folder, so everything below works the same in a terminal, in the agents' own extensions, and here. Changes take effect in the next chat (＋).

### Claude Code

| What | Project (shared through git) | Project, just you | You, every project |
|---|---|---|---|
| Instructions | `CLAUDE.md` | | `~/.claude/CLAUDE.md` |
| Settings and permissions | `.claude/settings.json` | `.claude/settings.local.json` | `~/.claude/settings.json` |
| Subagents | `.claude/agents/*.md` | | `~/.claude/agents/*.md` |
| Slash commands | `.claude/commands/*.md` | | `~/.claude/commands/*.md` |
| Skills | `.claude/skills/<name>/SKILL.md` | | `~/.claude/skills/<name>/SKILL.md` |
| MCP servers | `.mcp.json` (asks for your approval once) | | `claude mcp add …` |

A settings file with permissions, for example `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Read(./src/**)"],
    "deny": ["Read(./.env)", "Bash(rm -rf:*)"],
    "defaultMode": "acceptEdits"
  }
}
```

### Codex

| What | Where |
|---|---|
| Instructions | `AGENTS.md` at the repo root (and in subfolders), `~/.codex/AGENTS.md` for you |
| Settings | `~/.codex/config.toml`; a project's `.codex/config.toml` is used once you trust the project |
| Skills | `~/.agents/skills/<name>/SKILL.md` for you, `.agents/skills/<name>/SKILL.md` in the repo |
| MCP servers | `[mcp_servers.<name>]` in `config.toml` |

A `~/.codex/config.toml`, for example:

```toml
model = "…"                       # a model your account offers
model_reasoning_effort = "medium"
approval_policy = "on-request"    # ask when it needs more than the sandbox allows
sandbox_mode = "workspace-write"  # edit and run commands in the project

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_TOKEN"
```

The factories show what each agent actually loaded, and where it came from (`project`, `local`, `user`, a plugin, built in). Anything that sits in the folder but is not loaded goes to **Here, not loaded**, with the reason.

## Permissions

Each agent decides on its own permissions, from its own settings. Agent Trace only shows you what an agent asks.

- **Claude Code:** your `deny` rules always win, even in Bypass mode; `allow` rules run without asking; anything else is asked of you. **Always allow** adds the rule Claude Code suggests, as "don't ask again" does in a terminal (greyed out, with the reason, when it offers none).
- **Codex:** its `approval_policy` and `sandbox_mode` decide. **Always allow** lasts for the session.
- **Modes** you pick in the chat replace your default for that chat:

| Claude Code | | Codex | |
|---|---|---|---|
| Ask first | asks before edits and commands | Read only | reads; asks before changing anything |
| Accept edits | edits without asking, asks for commands | Auto | edits and runs commands in the project; asks for more |
| Plan | reads and plans, then asks you to approve | Full access | no sandbox, never asks |
| Auto | a classifier approves safe actions, asks about the rest | | |
| Bypass | never asks (only in a sandbox you trust) | | |

- **Hand-over** tools run without a prompt, as you turned hand-over on. Whatever the other agent then needs is asked of you.
- With **Both**, Claude is told to review and advise only; this is an instruction, not a lock. Pick Plan for Claude if it must not edit.

## Settings

| Setting | What it does |
|---|---|
| `agentTrace.claudePath` | Where your `claude` is, if Agent Trace does not find it. E.g. `C:\Users\you\.local\bin\claude.exe`, `/opt/homebrew/bin/claude`. |
| `agentTrace.codexPath` | Where your `codex` is, if Agent Trace does not find it. E.g. `/usr/local/bin/codex`; on Windows the `codex.exe` npm installed, or leave empty. |
| `agentTrace.notifyWhenWaiting` | A notification when an agent waits for you and the tab is out of sight. On by default. |
| `agentTrace.accentColor` | The colour of work in progress: your theme's, or gold, terracotta, ocean, teal, violet, rose. |

Commands: **Agent Trace: Open**, **New Chat**, **Find Claude Code and Codex**.

## Troubleshooting

**Codex (or Claude) does not appear, or its button is greyed out.** Agent Trace did not find it. Click **Set up …** beside **Send to** to see why. Install it ([Set up](#set-up)), run it once in a terminal to sign in, then run **Agent Trace: Find Claude Code and Codex**. On macOS, VS Code opened from the Dock may not see your terminal's PATH: Agent Trace also asks your login shell and looks in the usual places, but if it still misses it, set `agentTrace.codexPath` / `agentTrace.claudePath` to the output of `which codex` / `which claude`.

**"Not logged in" / "not signed in".** Run `claude` and `/login`, or run `codex` and sign in, in a terminal. Then start a new chat.

**The model is rejected (an error 400).** The model in your settings is not available to your account. Pick another one in the chat's model menu, or change `model` in your config.

**An MCP server needs sign-in or failed.** Open the MCP servers card for the error. Sign in from a terminal (Claude Code: `claude`, then `/mcp`; Codex: `codex mcp login <name>`), then click **Reconnect**. A project server from `.mcp.json` waits for your approval: run `claude` in the folder once and approve it.

**"This session is running in another window".** The session is at work in a terminal or an agent's own panel. Wait for it, or start a new chat.

**It asks for permission more often than Claude Code does.** You probably use another mode there (Auto, for example). Pick the same mode in the chat: it is remembered.

## How it works, and your data

- **Claude Code** runs through the Claude Agent SDK, over the same channel Claude Code's own VS Code extension uses. **Codex** runs through `codex app-server`, the channel Codex's own VS Code extension uses. Sessions stay ordinary ones: continue them with `/resume` in Claude Code, or in Codex's own list.
- The flow is drawn from each agent's own records: Claude Code's transcripts in `~/.claude/projects/` and Codex's threads. Agent Trace reads only what it draws; it never reads environment values, headers or MCP arguments.
- Agent Trace itself sends nothing anywhere. What you type goes to your Claude Code and Codex, which talk to Anthropic and OpenAI as they always do.
- Each agent is told it runs inside Agent Trace, and what the hand-over tool is.

## Build from source

```
npm install
npm run package          # → agent-trace.vsix
code --install-extension agent-trace.vsix
```

`npm run typecheck` checks the extension (`src/`) and the webview (`web/`, `shared/`).

---

Agent Trace is an independent project, not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex is a product of OpenAI.
