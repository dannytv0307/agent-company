// Builds the extension: the webview UI with Vite into out/webview, the extension host code with
// esbuild into out/extension.cjs. `npm run package` then makes the .vsix.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
rmSync(path.join(root, 'out'), { recursive: true, force: true })

execSync('npx vite build', { cwd: root, stdio: 'inherit' })
await build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'out', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  logLevel: 'info',
})
console.log('Agent Flow built in out/')
