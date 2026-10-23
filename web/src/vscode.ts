import type { FromWebview } from '../../shared/model.ts'

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void }

// Outside VS Code (e.g. `npm run dev:web` in a browser) there is no extension to talk to.
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined

export const send = (m: FromWebview) => api?.postMessage(m)

/** What the page remembers across reloads of the tab (VS Code keeps it with the webview). */
export function remembered<T extends object>(fallback: T): T {
  const s = api?.getState()
  return s && typeof s === 'object' ? { ...fallback, ...(s as Partial<T>) } : fallback
}
export const remember = (s: object) => api?.setState({ ...((api?.getState() as object) ?? {}), ...s })
