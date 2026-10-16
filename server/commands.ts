// Repo slash commands (.claude/commands/<name>.md). Claude Code runs "/name args" itself; for Codex the
// app expands the command file into a plain prompt the same way Claude Code would.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** "/fix-bug login fails" → { name: "fix-bug", args: "login fails" } */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/)
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : undefined
}

/** The command as a prompt: frontmatter dropped, $ARGUMENTS / $1… filled in. Undefined when the repo has no such command. */
export function expandCommand(dir: string, text: string): string | undefined {
  const slash = parseSlash(text)
  if (!slash) return undefined
  const file = path.join(dir, '.claude', 'commands', ...slash.name.split(':')) + '.md'
  if (!existsSync(file)) return undefined
  const words = slash.args.split(/\s+/).filter(Boolean)
  const body = readFileSync(file, 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/\$ARGUMENTS/g, slash.args)
    .replace(/\$(\d)/g, (_, n: string) => words[Number(n) - 1] ?? '')
  return `The owner ran the repo command /${slash.name}${slash.args ? ` ${slash.args}` : ''}. Follow it:\n\n${body.trim()}`
}
