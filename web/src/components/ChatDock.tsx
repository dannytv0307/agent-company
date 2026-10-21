import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'
import { DockHandle } from './AgentPanel.tsx'
import { Chat } from './Chat.tsx'
import { monogram, subtitle } from './OrgChart.tsx'

/**
 * The project's one chat, docked on the left of every view. It talks to the organizer; "@agent-id"
 * sends a message straight to one of the team's agents, and their replies land in the same thread.
 */
export function ChatDock() {
  const { company, select } = useCompanyCtx()
  const { t, l } = useT()
  const organizer = company.agents.find((a) => a.id === company.org?.divisions[0]?.ceo?.id)
  if (!organizer) {
    return (
      <aside className="chat-dock">
        <div className="loading">…</div>
      </aside>
    )
  }
  const st = company.states[organizer.id]
  // A project without a team yet: offer the organizer the usual first asks.
  const suggestions = company.repoTeam.length ? [] : [t('ex1'), t('ex2'), t('ex3')]

  return (
    <aside className="chat-dock">
      <DockHandle side="left" />
      <div className="dock-head">
        <span className={`mono${st?.status === 'working' ? ' busy' : ''}`}>{monogram(l(organizer.name))}</span>
        <div className="who">
          <div className="dock-name">{l(organizer.name)}</div>
          <div className={`sub st-${st?.status ?? 'idle'}`}>
            <span className="dot" />
            {st ? t(st.status) : ''} · {subtitle(organizer, l, t)}
          </div>
        </div>
        <button className="link small" onClick={() => select(organizer.id)}>
          {t('details')}
        </button>
      </div>
      <Chat lead={organizer} team={company.repoTeam} suggestions={suggestions} />
    </aside>
  )
}
