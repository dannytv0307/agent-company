import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './styles.css'
import type { Accent, SessionView, ToWebview } from '../../shared/model.ts'
import { FlowContext, type Selection } from './context.ts'
import { Flow } from './components/Flow.tsx'
import { Header } from './components/Header.tsx'
import { Inspector } from './components/Inspector.tsx'
import { buildSetup } from './setup.ts'
import { send } from './vscode.ts'

type State = Extract<ToWebview, { type: 'state' }>

// Follow VS Code's theme: the webview's body carries vscode-light / vscode-dark / vscode-high-contrast,
// and VS Code hands the theme's colours over as --vscode-* variables, which styles.css builds on.
function syncTheme() {
  const cls = document.body.classList
  const light = cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  const host = [...cls].some((c) => c.startsWith('vscode-'))
  if (host) document.documentElement.dataset.host = 'vscode'
  else delete document.documentElement.dataset.host
}
syncTheme()
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] })

function Empty({ state }: { state?: State }) {
  if (!state) return <div className="empty">Loading…</div>
  return <div className="empty">Open a folder: Agent Trace shows the Claude Code sessions run in it.</div>
}

/** Before the folder's first session: the setup on its own, with Claude waiting. */
const NO_SESSION: SessionView = {
  id: '',
  title: '',
  status: 'idle',
  last: 0,
  turns: 0,
  main: { id: 'main', kind: 'main', type: 'Claude', title: '', start: 0, status: 'done', steps: [] },
  subagents: [],
  files: [],
}

function App() {
  const [state, setState] = useState<State>()
  const [selected, select] = useState<Selection | null>(null)
  const [now, setNow] = useState(Date.now())
  // Picked here, shown at once; the setting catches up with the next state.
  const [picked, setPicked] = useState<Accent>()
  const accent = picked ?? state?.accent ?? 'vscode'
  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])
  useEffect(() => setPicked(undefined), [state?.accent])

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => e.data?.type === 'state' && setState(e.data)
    window.addEventListener('message', onMessage)
    send({ type: 'ready' })
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearInterval(t)
    }
  }, [])

  // Another session or a new turn: what was selected may be gone.
  const view = state?.current ?? (state?.folder ? NO_SESSION : undefined)
  useEffect(() => select(null), [view?.id, view?.turn?.start])
  const setup = useMemo(() => (view ? buildSetup(view, state?.setup) : undefined), [view, state?.setup])

  return (
    <div className="app">
      <Header
        view={state?.current}
        sessions={state?.sessions ?? []}
        following={state?.following ?? true}
        now={now}
        accent={accent}
        onAccent={(a) => {
          setPicked(a)
          send({ type: 'accent', accent: a })
        }}
      />
      {view && setup ? (
        <FlowContext.Provider value={{ view, setup, now, selected, select }}>
          <div className={`body${selected ? ' with-inspector' : ''}`}>
            <ReactFlowProvider>
              <Flow />
            </ReactFlowProvider>
            <Inspector />
          </div>
        </FlowContext.Provider>
      ) : (
        <Empty state={state} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
