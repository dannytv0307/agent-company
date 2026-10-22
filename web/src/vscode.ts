import type { FromWebview } from '../../shared/model.ts'

declare function acquireVsCodeApi(): { postMessage(m: unknown): void }

// Outside VS Code (e.g. `npm run dev:web` in a browser) there is no extension to talk to.
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined

export const send = (m: FromWebview) => api?.postMessage(m)
