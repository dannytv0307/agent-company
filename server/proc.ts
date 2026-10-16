import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Runtime } from '../shared/types.ts'

const isWin = process.platform === 'win32'

/** Spawn a CLI safely. `.cmd`/`.bat` shims on Windows need a shell, so quote args ourselves. */
export function spawnCli(bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const needsShell = isWin && /\.(cmd|bat)$/i.test(bin)
  const quote = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return spawn(needsShell ? quote(bin) : bin, needsShell ? args.map(quote) : args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: needsShell,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Stop a CLI and every process it started (MCP servers, shells…). On Windows that takes taskkill /T. */
export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  else child.kill('SIGTERM')
}

export function capture(bin: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawnCli(bin, args)
    } catch (e) {
      resolve({ code: -1, out: String(e) })
      return
    }
    const t = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: -1, out: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out: out.trim() })
    })
    child.stdin?.end()
  })
}

/** Split a stream into lines and call `onLine` for each complete line. */
export function onLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void) {
  let buf = ''
  stream?.setEncoding?.('utf8')
  stream?.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine(line)
    }
  })
  stream?.on('end', () => {
    if (buf.trim()) onLine(buf.trim())
  })
}

function whichAll(name: string): string[] {
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const hits: string[] = []
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, name + ext)
      try {
        if (existsSync(p) && statSync(p).isFile()) hits.push(p)
      } catch {
        // ignore unreadable PATH entries
      }
    }
  }
  return hits
}

/** Codex also ships inside the ChatGPT/Codex IDE extension — use that binary if not on PATH. */
function codexFromExtensions(): string | undefined {
  const home = os.homedir()
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.antigravity'].map((r) => path.join(home, r, 'extensions'))
  const candidates: { p: string; mtime: number }[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      if (!/^openai\.chatgpt-/i.test(dir)) continue
      const binRoot = path.join(root, dir, 'bin')
      if (!existsSync(binRoot)) continue
      for (const plat of readdirSync(binRoot)) {
        const p = path.join(binRoot, plat, isWin ? 'codex.exe' : 'codex')
        if (existsSync(p)) candidates.push({ p, mtime: statSync(p).mtimeMs })
      }
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.p
}

/** npm installs Codex as a `.cmd` shim; prefer the native exe it wraps so args never pass through cmd.exe. */
function codexNativeFromNpmShim(shim: string): string | undefined {
  const vendor = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'node_modules')
  if (!existsSync(vendor)) return undefined
  for (const pkg of readdirSync(path.join(vendor, '@openai')).filter((d) => d.startsWith('codex-win32-'))) {
    const vendorDir = path.join(vendor, '@openai', pkg, 'vendor')
    if (!existsSync(vendorDir)) continue
    for (const triple of readdirSync(vendorDir)) {
      const exe = path.join(vendorDir, triple, 'bin', 'codex.exe')
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}

const BIN_NAMES: Record<Runtime, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy' }

export function resolveBin(runtime: Runtime): string | undefined {
  const env = process.env[`AGENT_COMPANY_${runtime.toUpperCase()}_BIN`]
  if (env && existsSync(env)) return env
  const hit = whichAll(BIN_NAMES[runtime])[0]
  if (hit && runtime === 'codex' && /\.cmd$/i.test(hit)) return codexNativeFromNpmShim(hit) ?? hit
  if (hit) return hit
  if (runtime === 'codex') return codexFromExtensions()
  return undefined
}
