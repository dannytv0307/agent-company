# Changelog

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
