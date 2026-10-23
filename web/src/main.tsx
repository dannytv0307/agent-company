import { StrictMode, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './styles.css'
import type { Accent, Engine, SessionView, ToWebview } from '../../shared/model.ts'
import type { Lane } from './layout.ts'
import { FlowContext, type Selection, productName } from './context.ts'
import { Flow } from './components/Flow.tsx'
import { Header } from './components/Header.tsx'
import { Inspector } from './components/Inspector.tsx'
import { ChatPanel, ChatTab } from './components/Chat.tsx'
import { buildSetup } from './setup.ts'
import { remember, remembered, send } from './vscode.ts'

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
// A page that fails shows nothing at all: report errors to the Output panel, and on the page.
const report = (text: string) => {
  send({ type: 'log', text, error: true })
  const el = document.getElementById('fatal') ?? Object.assign(document.body.appendChild(document.createElement('pre')), { id: 'fatal' })
  el.textContent = `Agent Trace hit an error:\n${text}`
}
window.addEventListener('error', (e) => {
  // Harmless, and common with React Flow: not worth a red box.
  if (/ResizeObserver loop/.test(e.message)) return
  report(`${e.message}\n${e.error?.stack ?? ''}`)
})
window.addEventListener('unhandledrejection', (e) => report(String(e.reason?.stack ?? e.reason)))

syncTheme()
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] })

function Empty({ state }: { state?: State }) {
  if (!state) return <div className="empty">Loading…</div>
  return <div className="empty">Open a folder: Agent Trace runs Claude Code or Codex in it and shows their sessions.</div>
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
const NO_CODEX: SessionView = { ...NO_SESSION, engine: 'codex', main: { ...NO_SESSION.main, type: 'Codex' } }

/** The chat's width, until the user drags its edge. */
const CHAT_WIDTH = 380
const MIN_CHAT = 280
/** Room the flow keeps beside the chat. */
const MIN_FLOW = 320

/** The chat's right edge: drag it (or use the arrow keys) to make the chat wider or narrower; double-click for the default. */
function Resizer({ width, onWidth }: { width: number; onWidth: (w: number, keep?: boolean) => void }) {
  const clamp = (w: number, box: HTMLElement | null) => Math.round(Math.max(MIN_CHAT, Math.min(w, (box?.clientWidth ?? 1200) - MIN_FLOW)))
  return (
    <div
      className="chat-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Chat width"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize the chat · double-click for the default width"
      onPointerDown={(e) => {
        const bar = e.currentTarget
        const box = bar.closest<HTMLElement>('.studio')
        const left = box?.getBoundingClientRect().left ?? 0
        bar.setPointerCapture(e.pointerId)
        bar.classList.add('dragging')
        let w = width
        const move = (ev: PointerEvent) => {
          w = clamp(ev.clientX - left, box)
          onWidth(w, false)
        }
        const up = () => {
          bar.classList.remove('dragging')
          bar.removeEventListener('pointermove', move)
          onWidth(w)
        }
        bar.addEventListener('pointermove', move)
        bar.addEventListener('pointerup', up, { once: true })
        bar.addEventListener('pointercancel', up, { once: true })
        e.preventDefault()
      }}
      onDoubleClick={() => onWidth(CHAT_WIDTH)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        onWidth(clamp(width + (e.key === 'ArrowRight' ? 24 : -24), e.currentTarget.closest('.studio')))
      }}
    />
  )
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
  useEffect(() => {
    setPicked(undefined)
  }, [state?.accent])

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

  const chat = state?.chat
  // A lane per agent installed: its session in this trace, or a quiet one waiting for a prompt. Each
  // lane has its own factory, its MCP servers as that agent reports them when it runs here.
  const lanes = useMemo<Lane[]>(() => {
    if (!state?.folder) return []
    const has: Record<Engine, boolean> = { claude: !!state.cli?.path, codex: !!state.codex?.path }
    const out: Lane[] = []
    for (const e of ['claude', 'codex'] as Engine[]) {
      // The latest message went elsewhere and nothing was handed to this agent: its last turn is over and
      // done with, so its lane waits, empty, rather than showing an old reply.
      const direct = state.direct ?? []
      const involved = !direct.length || direct.includes(e) || (state.handoffs ?? []).some((h) => h.to === e)
      const v = involved ? state.views?.[e] : undefined
      if (!v && !has[e]) continue
      const view = v ?? (e === 'codex' ? NO_CODEX : NO_SESSION)
      const part = state.chat?.[e]
      const mcp = { servers: part?.mcp?.servers, at: part?.mcp?.at, reconnecting: part?.reconnecting }
      out.push({ engine: e, view, setup: buildSetup(view, e === 'codex' ? state.codexSetup : state.setup, mcp), idle: !v })
    }
    if (!out.length) out.push({ engine: 'claude', view: NO_SESSION, setup: buildSetup(NO_SESSION, state.setup), idle: true })
    return out
  }, [state?.folder, state?.views, state?.direct, state?.handoffs, state?.setup, state?.codexSetup, state?.cli?.path, state?.codex?.path, state?.chat?.claude?.mcp, state?.chat?.codex?.mcp, state?.chat?.claude?.reconnecting?.join(), state?.chat?.codex?.reconnecting?.join()])
  const lead = lanes.find((l) => !l.idle && l.view.id === state?.current?.id) ?? lanes.find((l) => !l.idle) ?? lanes[0]
  const view = lead?.view
  const setup = lead?.setup
  // Another session or a new turn: what was selected may be gone.
  useEffect(() => {
    select(null)
  }, [view?.id, view?.turn?.start])

  // MCP servers are checked and reconnected in the agent run here: not for a run in another window.
  const control = (e: Engine) => {
    const c = e === 'codex' ? state?.codex : state?.cli
    if (!c?.path) return { can: false, why: c?.problem ?? `${productName(e)} was not found.` }
    if (chat?.elsewhere) return { can: false, why: e === 'codex' ? 'This thread runs in another Codex window: check its servers there.' : 'This session runs in another Claude Code window: check or reconnect its servers there, with /mcp.' }
    return { can: true }
  }
  const mcpControl = { claude: control('claude'), codex: control('codex') }

  // The flow is the main thing: the chat is a drawer on the left that folds away (and is remembered so).
  const [ui, setUi] = useState(() => remembered({ chat: true, chatWidth: CHAT_WIDTH }))
  const setChatOpen = (chat: boolean) =>
    setUi((u) => {
      const next = { ...u, chat }
      remember(next)
      return next
    })
  const setChatWidth = (chatWidth: number, keep = true) =>
    setUi((u) => {
      const next = { ...u, chatWidth }
      if (keep) remember(next)
      return next
    })
  // The prompt on the flow leads to the chat: open it and put the cursor in the box.
  const openChat = () => {
    select(null)
    setChatOpen(true)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
  }
  // A question or a plan needs the chat to answer: open it. (Permissions can be answered on the flow.)
  const asks = state?.chat?.asks ?? []
  const needsChat = asks.some((a) => a.kind !== 'permission')
  useEffect(() => {
    if (needsChat) setChatOpen(true)
  }, [needsChat])

  return (
    <div className="app">
      <Header
        view={state?.current}
        sessions={[]}
        following
        now={now}
        accent={accent}
        onAccent={(a) => {
          setPicked(a)
          send({ type: 'accent', accent: a })
        }}
      />
      {view && setup ? (
        <FlowContext.Provider value={{ view, setup, lanes, handoffs: state?.handoffs ?? [], direct: state?.direct ?? [], now, selected, select, asks: state?.chat?.asks ?? [], openChat, mcpControl }}>
          <div className={`studio${ui.chat ? '' : ' chat-closed'}`} style={{ '--chat-w': `${ui.chatWidth}px` } as CSSProperties}>
            {ui.chat ? (
              <div className="chat-col">
                <ChatPanel chat={state?.chat} cli={state?.cli} codex={state?.codex} folder={state?.folder} sessions={state?.sessions ?? []} now={now} onClose={() => setChatOpen(false)} />
                <Resizer width={ui.chatWidth} onWidth={setChatWidth} />
              </div>
            ) : (
              <ChatTab asking={asks.length > 0} busy={!!state?.chat?.busy} onOpen={() => setChatOpen(true)} />
            )}
            <div className={`body${selected ? ' with-inspector' : ''}`}>
              <ReactFlowProvider>
                <Flow />
              </ReactFlowProvider>
              <Inspector />
            </div>
          </div>
        </FlowContext.Provider>
      ) : (
        <Empty state={state} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!, { onUncaughtError: (e) => report(e instanceof Error ? `${e.message}\n${e.stack}` : String(e)) }).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
