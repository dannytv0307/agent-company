// Where a CLI the user installed may be. VS Code does not always see the user's PATH (on macOS, opened from
// the Dock, it gets a short one), and installers put their command in different places: so look on the
// PATH, in the user's login shell, and where the usual installers put it.
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const win = process.platform === 'win32'

/** The npm global folder holding installed commands, as npm itself says (empty when npm is not there). */
let npmBin: string | undefined
function npmGlobalBin(): string | undefined {
  if (npmBin !== undefined) return npmBin || undefined
  npmBin = ''
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
    if (prefix) npmBin = win ? prefix : path.join(prefix, 'bin')
  } catch {
    // no npm
  }
  return npmBin || undefined
}

/** Paths that may hold `name`, most likely first, without duplicates; they may not exist. */
export function candidates(name: string, configured?: string): string[] {
  const out: string[] = []
  if (configured) out.push(configured)
  try {
    const found = execFileSync(win ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    out.push(...found.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  } catch {
    // not on the PATH VS Code has
  }
  if (!win) {
    // The PATH the user's own terminal has.
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      const found = execFileSync(shell, ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop()
      if (found && found.startsWith('/')) out.push(found)
    } catch {
      // no login shell to ask
    }
  }
  const home = os.homedir()
  const exe = win ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  const dirs = win
    ? [path.join(home, '.local', 'bin'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(home, '.bun', 'bin'), npmGlobalBin()]
    : [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'), npmGlobalBin()]
  for (const d of dirs) if (d) for (const e of exe) out.push(path.join(d, e))
  return [...new Set(out)].filter((p) => existsSync(p))
}
