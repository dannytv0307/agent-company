import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrgDef, Runtime, RuntimeStatus } from '../shared/types.ts'
import { capture, resolveBin } from './proc.ts'

const home = os.homedir()

// We only check that a login file exists — tokens are never read. Each CLI handles its own auth.
function authFileExists(runtime: Runtime): RuntimeStatus['auth'] {
  if (runtime === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return 'ok'
    if (existsSync(path.join(home, '.claude', '.credentials.json'))) return 'ok'
    return process.platform === 'darwin' ? 'unknown' : 'missing' // macOS keeps it in Keychain
  }
  if (runtime === 'codex') {
    const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex')
    return existsSync(path.join(codexHome, 'auth.json')) || process.env.CODEX_API_KEY ? 'ok' : 'missing'
  }
  return 'unknown'
}

function antigravityInstalled(): boolean {
  const local = process.env.LOCALAPPDATA ?? ''
  if (local && existsSync(path.join(local, 'Programs', 'Antigravity'))) return true
  if (existsSync('/Applications/Antigravity.app')) return true
  const ext = path.join(home, '.vscode', 'extensions')
  return existsSync(ext) && readdirSync(ext).some((d) => d.startsWith('google.google-antigravity'))
}

export async function detectRuntimes(org: OrgDef): Promise<RuntimeStatus[]> {
  const modeOf = (rt: Runtime) => (org.divisions.find((d) => d.runtime === rt)?.mode === 'manual' ? 'manual' : 'auto')
  const out: RuntimeStatus[] = []
  for (const runtime of ['claude', 'codex', 'antigravity'] as Runtime[]) {
    const bin = resolveBin(runtime)
    let version: string | undefined
    if (bin) {
      const r = await capture(bin, ['--version'])
      if (r.code === 0) version = r.out.split('\n')[0]
    }
    const status: RuntimeStatus = {
      runtime,
      installed: !!version || (runtime === 'antigravity' && antigravityInstalled()),
      version,
      path: bin,
      auth: authFileExists(runtime),
      mode: modeOf(runtime),
    }
    if (runtime === 'antigravity') {
      status.note = 'Consumer plans do not support wrapping `agy` in apps — tasks are queued for you to run in Antigravity.'
    }
    out.push(status)
  }
  return out
}
