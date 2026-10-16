// Turns raw tool calls into short, human "speech bubble" lines.

const short = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const base = (p: unknown) => String(p ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')

export function summarizeClaudeTool(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case 'Read':
      return `Reading ${base(input.file_path)}`
    case 'Write':
      return `Writing ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(input.file_path)}`
    case 'Glob':
      return `Looking for ${short(input.pattern, 40)}`
    case 'Grep':
      return `Searching "${short(input.pattern, 40)}"`
    case 'Bash':
      return `$ ${short(input.command, 56)}`
    case 'WebFetch':
    case 'WebSearch':
      return `Researching ${short(input.query ?? input.url, 48)}`
    case 'TodoWrite':
      return 'Updating the plan'
    case 'mcp__agent-company__ask_owner':
      return `⏸ Waiting for your answer: ${short(input.title, 50)}`
    case 'Skill':
      return `Running /${short(input.skill ?? input.command, 40)}`
    default:
      if (name.startsWith('mcp__')) return `Using ${name.split('__').slice(1).join('.')}`
      return `Using ${name}`
  }
}

export { short }
