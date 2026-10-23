import { Fragment, useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import type { Ask, ChatLine, ChatState, CliState, Decision, Effort, Engine, Mode, SessionSummary, SlashCmd, Target } from '../../../shared/model.ts'
import { agentName, ago, productName } from '../context.ts'
import { send } from '../vscode.ts'

export const decide = (requestId: string, decision: Decision) => send({ type: 'chat.decide', requestId, decision })

/** Just enough Markdown for replies: code blocks, inline code, bold. */
function Text({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <pre key={i} className="md-code">
            {p}
          </pre>
        ) : (
          <Fragment key={i}>
            {p.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((s, j): ReactNode =>
              s.startsWith('`') && s.endsWith('`') && s.length > 2 ? (
                <code key={j}>{s.slice(1, -1)}</code>
              ) : s.startsWith('**') && s.endsWith('**') && s.length > 4 ? (
                <b key={j}>{s.slice(2, -2)}</b>
              ) : (
                s
              ),
            )}
          </Fragment>
        ),
      )}
    </>
  )
}

/** The agent a line or a request comes from, as a small mark: C for Claude, X for Codex. */
const Mark = ({ e }: { e?: Engine }) => (e ? <span className={`who-mark eng-${e}`} title={agentName(e)}>{e === 'codex' ? 'X' : 'C'}</span> : null)

function Line({ l, both }: { l: ChatLine; both: boolean }) {
  if (l.kind === 'user') {
    // A task one agent handed the other.
    if (l.from)
      return (
        <div className={`msg handover eng-${l.engine}`}>
          <span className="handover-head">
            <Mark e={l.from} /> {agentName(l.from)} → {agentName(l.engine)}
          </span>
          <span className="handover-task">{l.text}</span>
        </div>
      )
    return (
      <div className="msg user">
        {both && l.to && <span className="sent-to">→ {l.to.length > 1 ? 'Claude and Codex' : agentName(l.to[0])}</span>}
        {l.text}
      </div>
    )
  }
  if (l.kind === 'assistant')
    return (
      <div className={`msg assistant${l.streaming ? ' streaming' : ''}${both ? ' marked' : ''}`}>
        {both && <Mark e={l.engine} />}
        <div className="said">
          <Text text={l.text} />
        </div>
      </div>
    )
  if (l.kind === 'tool')
    return (
      <div className={`msg tool st-${l.status}`}>
        {both && <Mark e={l.engine} />}
        <span className="tool-mark">{l.status === 'running' ? '◌' : l.status === 'error' ? '✗' : '✓'}</span>
        <b>{l.tool}</b> <span>{l.label}</span>
      </div>
    )
  if (l.kind === 'result')
    return (
      <div className={`msg result${l.error ? ' bad' : ''}`}>
        {both && l.engine && `${agentName(l.engine)} · `}
        {l.text}
      </div>
    )
  return (
    <div className="msg error">
      {both && l.engine && `${agentName(l.engine)}: `}
      {l.text}
    </div>
  )
}

/** One question of AskUserQuestion: its options, and "other" for an answer of one's own. */
function QuestionAsk({ ask, who }: { ask: Extract<Ask, { kind: 'question' }>; who: string }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const toggle = (q: string, label: string, multi?: boolean) =>
    setPicked((p) => ({ ...p, [q]: multi ? (p[q]?.includes(label) ? p[q].filter((x) => x !== label) : [...(p[q] ?? []), label]) : [label] }))
  const answers = Object.fromEntries(ask.questions.map((q) => [q.question, (other[q.question]?.trim() || (picked[q.question] ?? []).join(', ')) ?? '']))
  const ready = ask.questions.every((q) => answers[q.question])
  return (
    <div className="ask question">
      <div className="ask-kicker">{who} asks</div>
      {ask.questions.map((q) => (
        <div key={q.question} className="q">
          <div className="q-text">
            {q.header && <span className="q-head">{q.header}</span>} {q.question}
          </div>
          <div className="q-options">
            {q.options.map((o) => (
              <button key={o.label} className={`opt${picked[q.question]?.includes(o.label) ? ' on' : ''}`} title={o.description} onClick={() => toggle(q.question, o.label, q.multiSelect)}>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </button>
            ))}
          </div>
          <input className="q-other" placeholder="Or type your own answer" value={other[q.question] ?? ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />
        </div>
      ))}
      <div className="ask-actions">
        <button className="btn primary" disabled={!ready} onClick={() => decide(ask.requestId, { kind: 'answers', answers })}>
          Answer
        </button>
        <button className="btn" onClick={() => decide(ask.requestId, { kind: 'deny', message: 'The user chose not to answer.' })}>
          Skip
        </button>
      </div>
    </div>
  )
}

export function AskCard({ ask, who = 'Claude' }: { ask: Ask; who?: string }) {
  if (ask.kind === 'question') return <QuestionAsk ask={ask} who={who} />
  if (ask.kind === 'plan')
    return (
      <div className="ask plan">
        <div className="ask-kicker">{who}’s plan — approve to start</div>
        <div className="plan-text">
          <Text text={ask.plan} />
        </div>
        <div className="ask-actions">
          <button className="btn primary" onClick={() => decide(ask.requestId, { kind: 'allow' })}>
            Approve plan
          </button>
          <button className="btn" onClick={() => decide(ask.requestId, { kind: 'deny', message: 'Keep planning: the user did not approve this plan yet.' })}>
            Keep planning
          </button>
        </div>
      </div>
    )
  return (
    <div className="ask permission">
      <div className="ask-kicker">Permission · {ask.tool}</div>
      <div className="ask-title">{ask.title}</div>
      {ask.detail && <div className="ask-detail">{ask.detail}</div>}
      <div className="ask-actions">
        <button className="btn primary" onClick={() => decide(ask.requestId, { kind: 'allow' })}>
          Allow
        </button>
        {ask.canAlways && (
          <button className="btn" onClick={() => decide(ask.requestId, { kind: 'always' })} title="Allow, and don’t ask again for this">
            Always allow
          </button>
        )}
        <button className="btn deny" onClick={() => decide(ask.requestId, { kind: 'deny' })}>
          Deny
        </button>
      </div>
    </div>
  )
}

/** The chat, folded away: a slim tab on the left edge that opens it again. */
export function ChatTab({ asking, busy, onOpen }: { asking: boolean; busy: boolean; onOpen: () => void }) {
  return (
    <button className={`chat-tab${asking ? ' asking' : busy ? ' busy' : ''}`} onClick={onOpen} title={asking ? 'The agent needs you: open the chat' : 'Open the chat'}>
      <span className="chat-tab-icon">›</span>
      <span className="chat-tab-label">Chat</span>
      {(asking || busy) && <i />}
    </button>
  )
}

/** Whom the next message goes to: Claude, Codex, or both at once. */
function Recipient({ target, claude, codex }: { target: Target; claude?: CliState; codex?: CliState }) {
  const pick = (t: Target) => t !== target && send({ type: 'chat.route', target: t })
  const no = (e: Engine) => !(e === 'codex' ? codex : claude)?.path
  const options: { t: Target; label: string; off: boolean; why?: string }[] = [
    { t: 'claude', label: 'Claude', off: no('claude'), why: claude?.problem },
    { t: 'codex', label: 'Codex', off: no('codex'), why: codex?.problem },
    { t: 'both', label: 'Both', off: no('claude') || no('codex') },
  ]
  return (
    <div className={`recipient to-${target}`} role="radiogroup" aria-label="Send to">
      {options.map((o) => (
        <button key={o.t} role="radio" aria-checked={target === o.t} className={`to-${o.t}${target === o.t ? ' on' : ''}`} disabled={o.off} title={o.off ? (o.why ?? `${o.label} was not found.`) : o.t === 'both' ? 'Send to both: Codex makes the changes, Claude reviews and advises' : `Send to ${o.label}`} onClick={() => pick(o.t)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ChatPanel({
  chat,
  cli,
  codex,
  folder,
  sessions,
  now,
  onClose,
}: {
  chat?: ChatState
  /** Claude Code's CLI and Codex's: whichever the chat sends to. */
  cli?: CliState
  codex?: CliState
  folder?: string
  sessions: SessionSummary[]
  now: number
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const lines = chat?.lines ?? []
  const asks = chat?.asks ?? []
  const target: Target = chat?.target ?? 'claude'
  const delegate = chat?.delegate ?? true
  const twoAgents = !!cli?.path && !!codex?.path
  // Lines carry their agent's mark once both have spoken in this chat, or both are at hand.
  const both = twoAgents || lines.some((l) => l.engine === 'codex') && lines.some((l) => l.engine === 'claude')
  // Settings, commands and skills are the recipient's; with both, the one picked here.
  const [settingsFor, setSettingsFor] = useState<Engine>('claude')
  const engine: Engine = target === 'both' ? settingsFor : target
  const part = chat?.[engine]
  const who = target === 'both' ? 'Claude and Codex' : agentName(target)
  const missing = (target === 'both' ? (['claude', 'codex'] as Engine[]) : [target]).map((e) => (e === 'codex' ? codex : cli)).find((c) => !c?.path)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines.length, lines[lines.length - 1], asks.length])
  const busyFor = (target === 'both' ? (['claude', 'codex'] as Engine[]) : [target]).some((e) => chat?.[e]?.busy)
  const submit = () => {
    if (!draft.trim() || busyFor) return
    send({ type: 'chat.send', text: draft, target, delegate })
    setDraft('')
  }

  // "/" at the start: the recipient's slash commands (Claude Code) or skills (Codex), filtered as one types.
  const slash = /^\/([^\s]*)$/.exec(draft)?.[1]
  const [pick, setPick] = useState(0)
  const [asked, setAsked] = useState<string>()
  useEffect(() => {
    const k = `${chat?.key ?? ''}:${engine}`
    if (slash !== undefined && !part?.commands && asked !== k) {
      setAsked(k)
      send({ type: 'chat.commands', engine })
    }
  }, [slash, part?.commands, chat?.key, engine, asked])
  const matches =
    slash === undefined
      ? []
      : (part?.commands ?? [])
          .filter((c) => c.name.toLowerCase().includes(slash.toLowerCase()))
          .sort((a, b) => Number(!b.name.toLowerCase().startsWith(slash.toLowerCase())) - Number(!a.name.toLowerCase().startsWith(slash.toLowerCase())))
          .slice(0, 50)
  useEffect(() => {
    setPick(0)
  }, [slash])
  const complete = (c: SlashCmd) => setDraft(c.insert ?? `/${c.name} `)
  const working = (['claude', 'codex'] as Engine[]).filter((e) => chat?.[e]?.busy && !asks.some((a) => a.engine === e))

  const title = sessions.find((x) => x.id === chat?.sessionId)?.title ?? (chat?.sessionId ? 'Session' : 'New chat')
  return (
    <section className="chat">
      <header className="chat-head">
        <select
          className="chat-session"
          value={chat?.sessionId ?? ''}
          onChange={(e) => send(e.target.value ? { type: 'select', id: e.target.value } : { type: 'chat.new' })}
          title="Switch session"
        >
          {!chat?.sessionId && <option value="">{title}</option>}
          {sessions.map((x) => (
            <option key={x.id} value={x.id}>
              {x.waiting ? '🔔 ' : x.status === 'working' ? '● ' : ''}
              {x.engine === 'codex' ? '[Codex] ' : ''}
              {x.title} — {ago(x.last, now)}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="New chat" onClick={() => send({ type: 'chat.new' })}>
          ＋
        </button>
        <button className="icon-btn" title="Fold the chat away" onClick={onClose}>
          ‹
        </button>
      </header>
      {missing?.problem && <div className="cli-problem">{missing.problem}</div>}
      <div className="chat-scroll">
        {!lines.length && (
          <div className="chat-empty">
            <h2>{twoAgents ? 'Chat with Claude, Codex, or both' : `Chat with ${productName(cli?.path ? 'claude' : 'codex')}`}</h2>
            <p>
              Runs your own {twoAgents ? 'Claude Code and Codex' : productName(cli?.path ? 'claude' : 'codex')} in <code>{folder ?? 'this folder'}</code>, with your login, settings, instructions and skills. Watch the work on the right;
              answer permissions here or on the flow.
            </p>
            {twoAgents && <p>Pick whom each message goes to below. With hand-over on, one can give the other a task: it shows on the flow, between their lanes.</p>}
          </div>
        )}
        {lines.map((l, i) => (
          <Line key={i} l={l} both={both} />
        ))}
        {asks.map((a) => (
          <AskCard key={a.requestId} ask={a} who={agentName(a.engine)} />
        ))}
        {working.length > 0 && lines[lines.length - 1]?.kind !== 'assistant' && <div className="msg thinking">{working.map(agentName).join(' and ')} {working.length > 1 ? 'are' : 'is'} working…</div>}
        <div ref={end} />
      </div>
      <div className="composer">
        {slash !== undefined && (
          <ul className="slash-menu" role="listbox">
            {!part?.commands && <li className="slash-note">Loading {engine === 'codex' ? 'skills' : 'commands'}…</li>}
            {part?.commands && !matches.length && <li className="slash-note">Nothing matches “/{slash}”</li>}
            {matches.map((c, i) => (
              <li key={`${c.name}${c.builtin ? '·b' : ''}`} role="option" aria-selected={i === pick}>
                <button className={`slash-item${i === pick ? ' on' : ''}`} onMouseEnter={() => setPick(i)} onClick={() => complete(c)}>
                  <b>{c.insert ? c.insert.trim() : `/${c.name}`}</b>
                  {c.argumentHint && <i>{c.argumentHint}</i>}
                  <span>{c.description}</span>
                  {c.builtin && <em>built-in</em>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {twoAgents && (
          <div className="route-row">
            <span className="route-label">Send to</span>
            <Recipient target={target} claude={cli} codex={codex} />
            {target !== 'both' && (
              <label className="handover" title={`Let ${agentName(target)} hand a task to ${agentName(target === 'claude' ? 'codex' : 'claude')} when it helps (ask_${target === 'claude' ? 'codex' : 'claude'})`}>
                <input type="checkbox" checked={delegate} onChange={(e) => send({ type: 'chat.route', delegate: e.target.checked })} />
                <span>Hand-over</span>
              </label>
            )}
          </div>
        )}
        <textarea
          value={draft}
          placeholder={busyFor ? `${who} ${target === 'both' ? 'are' : 'is'} working — you can type the next message` : `Ask ${who}… (/ for ${engine === 'codex' ? 'skills' : 'commands'}, Enter to send, Shift+Enter for a new line)`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && matches[pick] && (matches[pick].insert ?? `/${matches[pick].name} `).trim() !== draft.trim())) {
                e.preventDefault()
                complete(matches[pick])
                return
              }
            }
            if (e.key === 'Escape' && slash !== undefined) {
              setDraft('')
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
        />
        <div className="composer-row">
          <div className="settings-for">
            {target === 'both' && (
              <div className="mini-seg" role="radiogroup" aria-label="Settings of">
                {(['claude', 'codex'] as Engine[]).map((e) => (
                  <button key={e} role="radio" aria-checked={settingsFor === e} className={`eng-${e}${settingsFor === e ? ' on' : ''}`} onClick={() => setSettingsFor(e)} title={`${agentName(e)}’s model, effort and mode`}>
                    <Mark e={e} />
                  </button>
                ))}
              </div>
            )}
            <Settings chat={part} engine={engine} />
          </div>
          <div className="composer-actions">
            {chat?.busy ? (
              <button className="btn deny" onClick={() => send({ type: 'chat.stop' })}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!draft.trim() || !!missing} onClick={submit}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_NAMES: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
const effortText = (e: Effort) => EFFORT_NAMES[e] ?? e.charAt(0).toUpperCase() + e.slice(1)
const CODEX_MODES: { value: Mode; label: string; icon: string; hint: string }[] = [
  { value: 'read-only', label: 'Read only', icon: '◇', hint: 'Reads and answers; asks before changing anything' },
  { value: 'workspace', label: 'Auto', icon: '◉', hint: 'Edits and runs commands in this folder; asks for anything beyond' },
  { value: 'full-access', label: 'Full access', icon: '⚠', hint: 'No sandbox and never asks. Only where you trust it' },
]
const MODES: { value: Mode; label: string; icon: string; hint: string }[] = [
  { value: 'default', label: 'Ask first', icon: '✋', hint: 'Asks before editing files or running commands' },
  { value: 'acceptEdits', label: 'Accept edits', icon: '✎', hint: 'Edits files without asking; still asks for commands' },
  { value: 'plan', label: 'Plan', icon: '◇', hint: 'Reads and plans only, then asks you to approve' },
  { value: 'auto', label: 'Auto', icon: '◉', hint: 'A classifier approves safe actions and asks about the rest' },
  { value: 'bypassPermissions', label: 'Bypass', icon: '⚠', hint: 'Never asks. Only in a sandbox you trust' },
]

/** Bars for an effort level: one to five. */
const Bars = ({ level }: { level?: Effort }) => (
  <span className="bars" aria-hidden>
    {EFFORTS.map((e, i) => (
      <i key={e} className={level && i <= (EFFORTS.includes(level) ? EFFORTS.indexOf(level) : level === 'minimal' ? 0 : 4) ? 'on' : ''} />
    ))}
  </span>
)

/** A chip that opens a small menu above it. */
function Picker({
  label,
  className,
  menuClass,
  children,
  onOpen,
}: {
  label: ReactNode
  className?: string
  menuClass?: string
  children: (close: () => void) => ReactNode
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', off)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  return (
    <div className="picker" ref={box}>
      <button
        className={`chip-btn${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(!open)
        }}
      >
        {label}
        <span className="caret">▾</span>
      </button>
      {open && <div className={`menu${menuClass ? ` ${menuClass}` : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

function MenuItem({ on, onPick, title, hint, icon }: { on: boolean; onPick: () => void; title: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <button className={`menu-item${on ? ' on' : ''}`} onClick={onPick}>
      {icon !== undefined && <span className="mi-icon">{icon}</span>}
      <span className="mi-text">
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      {on && <span className="mi-check">✓</span>}
    </button>
  )
}

/** What each effort level means, in a few words. */
const EFFORT_HINT: Record<string, string> = {
  minimal: 'The least thinking, fastest answers',
  ultra: 'Thinks the longest, for the hardest work',
  low: 'Quick answers, the least thinking',
  medium: 'Balanced: speed and depth',
  high: 'Thinks carefully on harder work',
  xhigh: 'Thinks longer, for tricky problems',
  max: 'Thinks as long as it needs',
}

/**
 * Effort as a slider: one stop per level the model accepts. Drag the knob (it snaps to a stop when let go),
 * click a stop, or use the arrow keys. Unset, the knob waits hollow in the middle: the user's own default.
 */
function EffortPanel({ levels, value, model, engineSettings, onPick }: { levels: Effort[]; value?: Effort; model: string; engineSettings: string; onPick: (e: Effort | null) => void }) {
  const track = useRef<HTMLDivElement>(null)
  /** Where the knob is while dragged, in stops (fractional). */
  const [drag, setDrag] = useState<number | null>(null)
  const last = Math.max(1, levels.length - 1)
  const at = value ? levels.indexOf(value) : -1
  const pos = drag ?? (at >= 0 ? at : last / 2)
  const shown = drag !== null ? levels[Math.round(drag)] : value
  const stopAt = (x: number) => {
    const r = track.current!.getBoundingClientRect()
    const knob = r.height
    return Math.max(0, Math.min(1, (x - r.left - knob / 2) / (r.width - knob))) * last
  }
  const step = (d: number) => onPick(levels[Math.max(0, Math.min(levels.length - 1, (at >= 0 ? at : Math.round(last / 2)) + d))])
  return (
    <div className="effort">
      <div className="effort-head">
        <div className="effort-title">
          <b key={shown ?? 'default'} className={shown ? '' : 'unset'}>
            {shown ? effortText(shown) : 'Default'}
          </b>
          <small>{shown ? (EFFORT_HINT[shown] ?? '') : `From your ${engineSettings} settings`}</small>
          <span className="effort-model">{model}</span>
        </div>
        <button className="effort-reset" disabled={!value} title="Back to your default" aria-label="Back to your default" onClick={() => onPick(null)}>
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M12.5 1.8v2.8H9.7" />
          </svg>
        </button>
      </div>
      <div
        ref={track}
        className={`effort-track${drag !== null ? ' dragging' : ''}${shown ? '' : ' unset'}`}
        style={{ '--f': pos / last } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={levels.length - 1}
        aria-valuenow={at >= 0 ? at : undefined}
        aria-valuetext={value ? effortText(value) : 'Default'}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(stopAt(e.clientX))
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) setDrag(stopAt(e.clientX))
        }}
        onPointerUp={() => {
          if (drag === null) return
          const k = Math.round(drag)
          setDrag(null)
          if (levels[k] !== value) onPick(levels[k])
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1)
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1)
          else if (e.key === 'Home') onPick(levels[0])
          else if (e.key === 'End') onPick(levels[levels.length - 1])
          else return
          e.preventDefault()
        }}
      >
        <span className="effort-fill" />
        {levels.map((l, i) => (
          <span key={l} className={`effort-stop${i <= pos ? ' passed' : ''}`} style={{ '--i': i / last } as CSSProperties} />
        ))}
        <span className="effort-knob" />
      </div>
      <div className="effort-scale" aria-hidden>
        {levels.map((l, i) => (
          <button key={l} className={l === shown ? 'on' : ''} style={{ '--i': i / last } as CSSProperties} tabIndex={-1} onClick={() => onPick(l)}>
            {effortText(l)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Model, effort and permission mode, like Claude Code's pickers. Default: the user's own setting. */
function Settings({ chat, engine }: { chat?: ChatState; engine: Engine }) {
  const codex = engine === 'codex'
  const modes = codex ? CODEX_MODES : MODES
  /** Where defaults come from: "Claude Code" settings or "Codex" config. */
  const settingsOf = codex ? 'Codex' : 'Claude Code'
  const models = chat?.models
  const set = (x: { model?: string | null; effort?: Effort | null; mode?: Mode | null }) => send({ type: 'chat.settings', engine, ...x })
  const fallback = models?.find((m) => m.value === 'default')
  const model = models?.find((m) => m.value === chat?.model)
  const modelName = model?.name ?? chat?.model ?? (fallback?.description?.split(/[·(]/)[0].trim() || 'Default model')
  const efforts = model ? (model.efforts ?? []) : (fallback?.efforts ?? EFFORTS)
  const mode = modes.find((m) => m.value === chat?.mode)
  return (
    <div className="chat-settings">
      <Picker label={<span className="chip-text">✦ {modelName}</span>} className={chat?.model ? 'set' : ''} onOpen={() => !models && send({ type: 'chat.models', engine })}>
        {(close) => (
          <>
            <div className="menu-title">Model</div>
            <MenuItem on={!chat?.model} onPick={() => (set({ model: null }), close())} title="Default" hint={fallback?.description ?? `From your ${settingsOf} settings`} />
            {!models && <div className="menu-note">Loading models…</div>}
            {models
              ?.filter((m) => m.value !== 'default')
              .map((m) => (
                <MenuItem key={m.value} on={chat?.model === m.value} onPick={() => (set({ model: m.value }), close())} title={m.name} hint={m.description} />
              ))}
          </>
        )}
      </Picker>
      {efforts.length > 0 && (
        <Picker
          label={
            <span className="chip-text">
              <Bars level={chat?.effort} /> {chat?.effort ? effortText(chat.effort) : 'Effort'}
            </span>
          }
          className={chat?.effort ? 'set' : ''}
          menuClass="effort-menu"
        >
          {() => <EffortPanel levels={efforts} value={chat?.effort} model={modelName} engineSettings={settingsOf} onPick={(effort) => set({ effort })} />}
        </Picker>
      )}
      <Picker
        label={<span className="chip-text">{mode ? `${mode.icon} ${mode.label}` : '✋ Mode'}</span>}
        className={chat?.mode === 'bypassPermissions' || chat?.mode === 'full-access' ? 'danger' : chat?.mode ? 'set' : ''}
      >
        {(close) => (
          <>
            <div className="menu-title">{codex ? 'Approvals' : 'Permission mode'}</div>
            <MenuItem on={!chat?.mode} onPick={() => (set({ mode: null }), close())} title="Default" hint={`From your ${settingsOf} settings`} icon="·" />
            {modes.map((m) => (
              <MenuItem key={m.value} on={chat?.mode === m.value} onPick={() => (set({ mode: m.value }), close())} title={m.label} hint={m.hint} icon={m.icon} />
            ))}
          </>
        )}
      </Picker>
    </div>
  )
}
