# Changelog

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
