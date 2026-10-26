# Changelog

## 1.0.2

- **Claude Code and Codex are found in more places:** the PATH of your login shell (on macOS, VS Code opened from the Dock does not see it), npm's global folder, Homebrew, `~/.local/bin`, and Claude Code installed with npm on Windows.
- **An agent not found is no longer silently missing:** **Send to** shows a **Set up …** link that says what is missing and offers the guide, the path setting, or a new look. New command: **Agent Trace: Find Claude Code and Codex**, to look again after installing one.
- **A new README:** how to install Claude Code and Codex and sign in, where each one's configuration lives (instructions, settings and permissions, agents, commands, skills, MCP servers), how permissions and modes work, and what to do when something does not show.

## 1.0.1

- **Codex Factory in the sidebar**, under the Claude Factory, when Codex is installed.
- **A new message starts the flow over:** finished subagents and their reports of the turn before are cleared (those still at work stay, marked earlier), and an agent the message did not go to waits in an empty lane instead of showing its old reply.

## 1.0.0

Agent Trace now has a chat: talk to Claude Code and Codex — one of them, or both — and watch them work, side by side, in one tab.

- **Claude and Codex in one chat:** each message goes to Claude, to Codex, or to both (Send to, above the message box). With both, Codex makes the changes and Claude reviews and advises. Every line in the chat carries its agent's mark.
- **Hand-over:** with it on, Claude can give Codex a task (`ask_codex`) and Codex can give Claude one (`ask_claude`), one step only. The task and the answer show in the chat, and on the flow as a line between the two agents. Whatever the other agent asks permission for is asked of you, in the chat or on the flow.
- **A lane per agent:** the flow draws Claude above Codex, each with its tools, subagents and reply; the Claude factory and the Codex factory sit one above the other on the left, each foldable. A Claude session and the Codex thread of the same chat are remembered together and open together.
- **Codex, as your own Codex runs it** (through `codex app-server`, as Codex's VS Code extension does): replies stream in, its commands, file changes, MCP calls and subagents go on the flow, and its approvals (commands, file changes, more permissions, questions) are answered in the chat or on the flow. Its threads of the folder are listed with Claude's sessions, continued here, or archived.
- **The Codex factory**, as Codex reports it for the folder: AGENTS.md, skills, MCP servers and their connection, plugins, hooks and config files. A skill lights up when Codex reads it.
- With Codex, `/` lists its skills (inserting `$skill`), the model and effort pickers show its models and levels, and the mode picker its approvals: Read only, Auto, Full access.
- **New setting** `agentTrace.codexPath`: where your `codex` is, if it is not on PATH.

- **Chat with your own Claude Code** (the CLI you installed and logged into, with your settings, agents, skills and MCP servers). It sits in a drawer on the left of the tab that folds away, as wide as you drag it:
  - replies stream in;
  - **Stop** ends a turn;
  - type `/` for slash commands;
  - pick the model, the permission mode, and the effort on a slider: drag it, click a level, or use the arrow keys; the arrow button goes back to your default.
- **Answer Claude in the chat or on the flow:**
  - permissions: Allow, Always allow or Deny, also right on the waiting tool call;
  - questions: pick an option or write your own answer;
  - plans: approve, or keep planning.
- **MCP servers in sync with Claude Code:** in the MCP servers card and its details, the status comes live from the Claude Code run here, checked again while it runs. **Check now** and **Reconnect** (one server, or all the failed ones) work without sending a message.
- **MCP servers listed by where they are configured:** this folder's first (project, then local), then yours (user), then plugins, claude.ai connectors and the rest.
- **MCP statuses that stay right:**
  - a failed or signed-out server no longer loses its status when Claude Code later reports other tools;
  - the card says what is wrong first, e.g. *1 failed* in red or *14 need sign-in* in amber, and each server shows *Connected · 47 tools*, *Failed to connect: …* or *Needs sign-in*;
  - a server of the folder's .mcp.json not yet approved says *Waiting for your approval*, and one turned off for the folder says *Disabled*;
  - a server defined both for the project and for you shows once, from the scope Claude Code uses; the other moves to *Here, not loaded*;
  - Claude Code's own link to VS Code is marked built-in instead of passing for a connector;
  - while servers are still connecting, they are checked again every 2 seconds.
- **Continue any session of the folder**: open it from the sidebar or the chat's session list. Sessions stay ordinary Claude Code sessions, so `/resume` works on them in a terminal or in Claude Code's extension.
- **Delete a session** from the sidebar. It goes to the trash, so it can be restored.
- **Sessions run elsewhere still show.** Opening the tab while Claude Code works in a terminal or in its extension shows that session's flow, and a wait there still gets a notification.
- **The sidebar lists all the folder's sessions**, with the ones at work marked, instead of only the active ones.
- **The tab comes back after a reload of VS Code.**
- **The setup is now the Claude factory**, in the flow and in the sidebar, and in the flow it folds:
  - click its title to fold it into a tab; what is in use still has its edges;
  - each kind (agents, slash commands, skills, MCP servers…) folds into its header with the arrow beside it;
  - what is folded is remembered with the tab.
- **All frames are level at the top**: the Claude factory, the prompt, the main agent, the tools and the output start on the same row.
- **New setting** `agentTrace.claudePath`: where your `claude` is, if it is not on PATH.
- The Follow command is gone: the tab shows the session you open, or the new chat you start.
- **The model, effort and mode you pick are remembered** for each agent: a new chat starts with them, as in Claude Code's own panel. Pick Auto once and Claude asks as often as it does there.
- **Each agent knows it runs inside Agent Trace**, and what the hand-over tool is. Claude no longer takes the `agent_trace` server for something foreign. Your own Codex developer instructions are kept, Agent Trace's come after them.
- **Always allow** is on the waiting tool call on the flow too. In the chat it always shows: greyed out, with the reason, when the agent offers no lasting rule.

## 0.3.1

Subagents now match Claude Code's own agent map:
- **Background subagents are marked finished.** Newer Claude Code versions report completion as queued commands, which Agent Trace now reads.
- **Background subagents of earlier turns stay on the canvas**, marked *earlier*: all running ones, plus the latest finished ones.
- **A subagent left behind by an ended Claude Code process is marked stopped.** For example, after a restart such a subagent shows as stopped instead of running forever.
- **Subagent files are trusted on completion:** when a subagent's own file says it finished, it counts as done even without a notification.

## 0.3.0

- **Claude needs you:** when Claude Code waits for you, Agent Trace says so and names what it waits for: a permission to run a tool, a question, a plan to approve, a dialog. The signal comes from Claude Code's own session status. It shows in four places:
  - the Now bar: *Needs you · Claude asks to run Bash npm test*;
  - the header;
  - the waiting card and tool call, in amber;
  - the status bar, and the sidebar with a bell.
- **Notification for waits:** a notification shows once per wait, with a button to open Claude Code. Turn it off with `agentTrace.notifyWhenWaiting`.
- **Setup as Claude Code loaded it:** the setup is checked against what Claude Code itself announced in the session: its skills, agents, MCP servers and instruction files. It is right however your configuration is organised (plugins, managed settings, custom plugin paths, disabled servers…). With no session yet, it is read from files and says so.
- **MCP connection status:** connected, failed (with the error) or waiting for sign-in.
- **"Here, not loaded" card:** configuration that sits in the folder but that Claude Code does not load from there, each item with the reason and what to do about it. Examples:
  - a plugin's source, which is loaded only once installed;
  - agents/, commands/, skills/ or rules/ kept at the root of a repo of configs;
  - a skill Claude Code skipped.
- **Plugin manifests** that add their own folders for agents, commands, skills, hooks and MCP servers are followed.
- **Clearer on and off:**
  - cards off the current path turn grey instead of fading out;
  - unused setup items keep readable text;
  - items used this turn get a green tint, items at work an accent one.

## 0.2.0

- **Now bar:** shows the path work is taking, e.g. `/ship → Claude → code-reviewer → Grep TODO`. Each step names where it comes from, and the bar keeps following subagents that run in the background after Claude replies.
- **Frames:** each part of the flow sits in its own frame. A frame lights up while work goes through it; the rest fades.
- **Edges from the setup:**
  - they leave from the exact agent, command, skill or MCP server in use;
  - they run in the gaps between frames, so no card hides them.
- **Origins on the cards:** subagent cards and the slash command say where they come from (project, user, built-in, or the plugin's name).
- **Hover a card** to trace the path through it.
- **Follows your VS Code theme** (light, dark, high contrast). The accent colour follows the theme too, or you can pick one of six in the header or in the `agentTrace.accentColor` setting.
- **Output details** show only the reply or report and the files changed.
- **The sidebar** lists only the sessions at work right now.

## 0.1.0

First public release.

- **Flow tab:**
  - shows the prompt, slash command, main agent, subagents, latest tool calls, reply, subagent reports and files changed;
  - edges glow while work is in progress;
  - click any card to see its details.
- **Setup:** shows CLAUDE.md, agents, slash commands, skills, MCP servers, hooks, plugins and settings with where each comes from. Items light up while they are in use.
- **Sidebar:** lists the folder's sessions and its setup.
- **Status bar:** shows what is running now.
- **Explorer:** a badge marks files being edited.
