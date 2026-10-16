// What actually changed in a project: git status/diff (read-only) joined with which agent touched each file.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { FileChange, ProjectChanges } from '../shared/types.ts'
import { bus } from './events.ts'
import { onLines, spawnCli } from './proc.ts'
import { GENERATED_MARK } from './projectScan.ts'

/** Run a read-only git command and return stdout only (git prints CRLF warnings on stderr). */
function git(dir: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const lines: string[] = []
    const child = spawnCli('git', ['-C', dir, '-c', 'core.quotepath=off', '-c', 'core.safecrlf=false', ...args])
    const timer = setTimeout(() => child.kill(), 15_000)
    onLines(child.stdout, (l) => lines.push(l))
    child.on('error', () => resolve({ code: -1, out: '' }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out: lines.join('\n') })
    })
    child.stdin?.end()
  })
}

const posix = (p: string) => p.split(path.sep).join('/')

/** Files agents wrote in this project, from the event log (newest first per file). */
function touched(projectId: string): Map<string, FileChange['by']> {
  const out = new Map<string, FileChange['by']>()
  for (const e of bus.history(3000)) {
    const file = typeof e.meta?.file === 'string' ? e.meta.file : undefined
    if (!file || e.projectId !== projectId || !e.agent) continue
    const list = out.get(file) ?? []
    list.unshift({ agentId: e.agent, taskId: typeof e.meta?.taskId === 'string' ? e.meta.taskId : undefined, ts: e.ts })
    out.set(file, list)
  }
  return out
}

export async function projectChanges(projectId: string, dir: string): Promise<ProjectChanges> {
  const by = touched(projectId)
  const isGit = existsSync(dir) && (await git(dir, ['rev-parse', '--is-inside-work-tree'])).out === 'true'
  if (!isGit) {
    return { git: false, files: [...by].map(([p, b]) => ({ path: p, status: '', by: b })), commits: [] }
  }
  const [status, numstat, log, branch] = await Promise.all([
    git(dir, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(dir, ['diff', 'HEAD', '--numstat']),
    git(dir, ['log', '-15', '--date=relative', '--pretty=format:%h%x09%an%x09%ad%x09%s']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  const files = new Map<string, FileChange>()
  for (const line of status.out.split('\n').filter(Boolean)) {
    // "XY path" — the captured output is trimmed, so the first line may have lost its leading space.
    const m = line.match(/^([ MADRCU?!]{1,2}) (.+)$/)
    if (!m) continue
    const code = m[1].trim() || '?'
    let p = m[2]
    if (p.includes(' -> ')) p = p.split(' -> ')[1]
    p = p.replace(/^"|"$/g, '')
    files.set(p, { path: p, status: code, by: by.get(p) ?? [] })
  }
  for (const line of numstat.out.split('\n').filter(Boolean)) {
    const [a, r, p] = line.split('\t')
    const f = files.get(p)
    if (f) {
      f.added = Number(a) || 0
      f.removed = Number(r) || 0
    }
  }
  // Files agents touched that are now committed still deserve a mention.
  for (const [p, b] of by) if (!files.has(p)) files.set(p, { path: p, status: '', by: b })
  // Untracked files have no diff against HEAD; count their lines instead.
  for (const f of files.values()) {
    if (f.status !== '??' || f.added !== undefined) continue
    const abs = path.join(dir, f.path)
    if (existsSync(abs) && statSync(abs).isFile() && statSync(abs).size < 1_000_000) f.added = readFileSync(abs, 'utf8').split('\n').filter(Boolean).length
  }
  // The app's own generated config is not the project's work — leave it out.
  for (const p of [...files.keys()]) {
    const abs = path.join(dir, p)
    const generated = p.startsWith('.agent-company/') || (existsSync(abs) && statSync(abs).isFile() && readFileSync(abs, 'utf8').includes(GENERATED_MARK))
    if (generated) files.delete(p)
  }
  const commits = log.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, when, ...rest] = l.split('\t')
      return { hash, author, when, subject: rest.join('\t') }
    })
  return { git: true, branch: branch.out || undefined, files: [...files.values()], commits }
}

/** The diff of one file against HEAD (or the file itself when untracked). Read-only. */
export async function fileDiff(dir: string, file: string): Promise<string> {
  const norm = path.normalize(file)
  if (!file || norm.startsWith('..') || path.isAbsolute(norm)) return ''
  const rel = posix(norm)
  const d = await git(dir, ['diff', 'HEAD', '--', rel])
  if (d.out) return d.out.slice(0, 60_000)
  const u = await git(dir, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', rel])
  return u.out.slice(0, 60_000)
}
