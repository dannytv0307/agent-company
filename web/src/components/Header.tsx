import { ACCENTS, type Accent, type SessionSummary, type SessionView } from '../../../shared/model.ts'
import { ago, duration } from '../context.ts'
import { send } from '../vscode.ts'
import { waitingText } from '../../../shared/waiting.ts'

const ACCENT_NAMES: Record<Accent, string> = { vscode: 'VS Code theme', gold: 'Gold', claude: 'Terracotta', ocean: 'Ocean', teal: 'Teal', violet: 'Violet', rose: 'Rose' }

/** The flow's main colour, one dot per choice. */
function AccentPicker({ accent, onAccent }: { accent: Accent; onAccent: (a: Accent) => void }) {
  return (
    <div className="accents" role="radiogroup" aria-label="Colour">
      {ACCENTS.map((a) => (
        <button
          key={a}
          role="radio"
          aria-checked={a === accent}
          className={`swatch sw-${a}${a === accent ? ' on' : ''}`}
          title={ACCENT_NAMES[a]}
          onClick={() => onAccent(a)}
        />
      ))}
    </div>
  )
}

/** The session on screen: which one, whether the agent is at work, and how much it has changed. */
export function Header({
  view,
  sessions,
  following,
  now,
  accent,
  onAccent,
}: {
  view?: SessionView
  sessions: SessionSummary[]
  following: boolean
  now: number
  accent: Accent
  onAccent: (a: Accent) => void
}) {
  const working = view?.status === 'working'
  return (
    <header className="header">
      <div className="brand">
        <span className="wordmark">Agent Trace</span>
        {sessions.length > 0 && (
          <select
            className="session-pick"
            value={following ? '__follow__' : (view?.id ?? '')}
            onChange={(e) => send(e.target.value === '__follow__' ? { type: 'follow' } : { type: 'select', id: e.target.value })}
            aria-label="Session"
          >
            <option value="__follow__">Follow the latest session</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.waiting ? '🔔 ' : s.status === 'working' ? '● ' : ''}
                {s.title} — {ago(s.last, now)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="header-end">
        {view && (
          <div className="facts">
            <span className={`pill${waitingText(view) ? ' waiting' : working ? ' busy' : ''}`} title={waitingText(view)}>
              <i />
              {waitingText(view)
                ? `Needs you · ${duration(now - (view.waiting?.since ?? view.last))}`
                : working
                  ? `Working · ${duration(now - (view.turn?.start ?? now))}`
                  : `Idle · ${ago(view.last, now)}`}
            </span>
            {view.title && (
              <span className="fact title" title={view.title}>
                {view.title}
              </span>
            )}
            {view.branch && (
              <span className="fact branch" title="Git branch">
                ⎇ {view.branch}
              </span>
            )}
            {view.linesAdded || view.linesRemoved ? (
              <span className="fact lines" title="Lines changed this session">
                <b className="add">+{view.linesAdded ?? 0}</b> <b className="del">−{view.linesRemoved ?? 0}</b>
              </span>
            ) : null}
          </div>
        )}
        <AccentPicker accent={accent} onAccent={onAccent} />
      </div>
    </header>
  )
}
