import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentEvent, CompiledFile } from '../../../shared/types.ts'
import { get, post } from '../api.ts'
import { useT, type StringKey } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'
import { monogram } from './OrgChart.tsx'
import { Chat } from './Chat.tsx'
import { Approvals } from './Approvals.tsx'
import { OwnerProfile } from './OwnerProfile.tsx'
import { AgentEditor } from './AgentEditor.tsx'
import { PlanView } from './PlanView.tsx'

export const ACTIVITY = '__activity__'
export const APPROVALS = '__approvals__'
export const PLAN = '__plan__'

function Timeline({ events, name, full }: { events: AgentEvent[]; name: (id?: string) => string; full?: boolean }) {
  const { t } = useT()
  const { company } = useCompanyCtx()
  // Only label events with their project when there is more than one.
  const projectName = (id?: string) => (company.projects.length > 1 && id ? company.projects.find((p) => p.id === id)?.name : undefined)
  if (!events.length) return <p className="muted">{t('noActivity')}</p>
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id} className={`k-${e.kind}`}>
          <span className="t">{hhmm(e.ts)}</span>
          <div>
            {projectName(e.projectId) && <span className="ptag">{projectName(e.projectId)}</span>}
            {(e.from || e.to) && (
              <div className="who">
                {name(e.from ?? e.agent)}
                {e.to && <span className="arrow"> → </span>}
                {e.to && name(e.to)}
              </div>
            )}
            {!e.from && !e.to && e.agent && <div className="who">{name(e.agent)}</div>}
            <p>{full && typeof e.meta?.full === 'string' ? e.meta.full : e.text}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, StringKey, number?][]; value: T; onChange: (v: T) => void }) {
  const { t } = useT()
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label, badge]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>
          {t(label)}
          {badge ? <span className="badge">{badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

const DOCK_MIN = 340

/** Drag the panel's left edge to make it wider or narrower; the width is remembered. */
function DockHandle() {
  const { t } = useT()
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const max = () => Math.max(DOCK_MIN, Math.min(760, window.innerWidth * 0.6))
    let w = 0
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(max(), Math.max(DOCK_MIN, window.innerWidth - ev.clientX)))
      document.documentElement.style.setProperty('--dock', `${w}px`)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      try {
        if (w) localStorage.setItem('dock', String(w))
      } catch {
        // storage unavailable — the width lasts for this visit only
      }
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className="dock-handle" onPointerDown={start} title={t('resizePanel')} />
}

export function AgentPanel() {
  const { company, selected, select } = useCompanyCtx()
  const { t, l } = useT()
  const [files, setFiles] = useState<CompiledFile[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [tab, setTab] = useState<'chat' | 'activity' | 'profile'>('chat')
  const [ownerTab, setOwnerTab] = useState<'profile' | 'approvals' | 'activity'>('profile')

  useEffect(() => {
    setTab('chat')
    if (selected && ![ACTIVITY, APPROVALS, PLAN].includes(selected)) get<CompiledFile[]>(`/api/compile?project=${encodeURIComponent(company.project?.id ?? '')}`).then(setFiles).catch(() => setFiles([]))
  }, [selected])
  useEffect(() => {
    // Open the owner panel on approvals when something is waiting, otherwise on the profile.
    if (selected === company.org?.owner.id) setOwnerTab(company.pending.length ? 'approvals' : 'profile')
  }, [selected])
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-bg') && select(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, select])

  if (!selected || !company.org) return null
  const owner = company.org.owner
  const name = (id?: string) => (id === owner.id ? l(owner.name) : l(company.agents.find((x) => x.id === id)?.name) || id || '')
  const meaningful = company.events.filter((e) => e.kind !== 'system' && e.kind !== 'chat')
  const close = (
    <>
      <DockHandle />
      <button className="close" onClick={() => select(null)} aria-label={t('close')}>
        ×
      </button>
    </>
  )

  if (selected === PLAN) {
    return (
      <aside className="panel">
        {close}
        <h2 className="panel-title">
          {t('plan')} <span className="muted small">· {company.project?.name}</span>
        </h2>
        <div className="tab-body">
          <PlanView />
        </div>
      </aside>
    )
  }

  if (selected === ACTIVITY || selected === APPROVALS) {
    return (
      <aside className="panel">
        {close}
        <h2 className="panel-title">{selected === ACTIVITY ? t('activity') : t('approvals')}</h2>
        <div className="tab-body">
          {selected === ACTIVITY ? <Timeline events={meaningful.filter((e) => e.kind !== 'activity').slice(-80).reverse()} name={name} /> : <Approvals />}
        </div>
      </aside>
    )
  }

  // ── owner ──────────────────────────────────────────────────
  if (selected === owner.id) {
    const reports = meaningful.filter((e) => e.to === owner.id && e.kind === 'report').slice(-30).reverse()
    return (
      <aside className="panel">
        {close}
        <div className="panel-head">
          <span className="mono lg">{monogram(l(owner.name))}</span>
          <div>
            <h2>{l(owner.name)}</h2>
            <div className="muted">{l(owner.title)}</div>
          </div>
        </div>
        <Tabs
          tabs={[
            ['profile', 'profile'],
            ['approvals', 'approvals', company.pending.length],
            ['activity', 'activity'],
          ]}
          value={ownerTab}
          onChange={setOwnerTab}
        />
        <div className="tab-body">
          {ownerTab === 'profile' && <OwnerProfile />}
          {ownerTab === 'approvals' && <Approvals />}
          {ownerTab === 'activity' && <Timeline events={reports} name={name} full />}
        </div>
      </aside>
    )
  }

  // ── agent ──────────────────────────────────────────────────
  const a = company.agents.find((x) => x.id === selected)
  if (!a) return null
  const st = company.states[a.id]
  const related = meaningful.filter((e) => e.agent === a.id || e.from === a.id || e.to === a.id).slice(-40).reverse()
  const file = files.find((f) => f.agentId === a.id)
  const inbox = a.manual ? company.manual.filter((m) => m.to === a.id && !m.done) : []
  // Repo agents are not in a company division; label them by their project.
  const projectOfAgent = a.external ? company.projects.find((p) => p.id === a.external) : undefined
  const runtimeLabel = projectOfAgent
    ? { en: `${projectOfAgent.name} · repo agent`, ja: `${projectOfAgent.name}・リポジトリ` }
    : a.isCeo && a.runtime === 'codex'
      ? { en: 'Codex', ja: 'Codex' } // the CEO's own engine, not their division's
      : company.org.divisions.find((d) => d.id === a.divisionId)?.label
  const clean = (s: string) => s.replace(/^[^\p{L}\p{N}$]+/u, '')
  const projectName = (pid?: string) => (company.projects.length > 1 ? company.projects.find((p) => p.id === pid)?.name : undefined)
  const now = st?.active.length ? null : st?.status === 'working' && st.bubble ? clean(st.bubble) : null

  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <aside className="panel agent-panel">
      {close}
      <div className="panel-head">
        <span className="mono lg">{monogram(l(a.name))}</span>
        <div>
          <h2>{l(a.name)}</h2>
          <div className="muted">{l(a.role)}</div>
        </div>
      </div>
      {st && (
        <div className={`status-line st-${st.status}`}>
          <span className="dot" />
          {t(st.status)}
          <span className="sep">·</span>
          {l(runtimeLabel)}
          {a.model && (
            <>
              <span className="sep">·</span>
              {a.model}
            </>
          )}
        </div>
      )}
      {now && (
        <div className="now">
          <span className="label">{t('now')}</span>
          {now}
        </div>
      )}
      {st && st.active.length > 0 && (
        <div className="now">
          <span className="label">
            {t('now')}
            {st.active.length > 1 && ` · ${st.active.length} ${t('inParallel')}`}
          </span>
          <ul className="now-list">
            {st.active.map((w) => (
              <li key={w.aid}>
                {projectName(w.projectId) && <span className="ptag">{projectName(w.projectId)}</span>}
                {w.title && <b>{clean(w.title)}</b>}
                <span>{clean(w.text)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Tabs
        tabs={[
          ['chat', 'chat'],
          ['activity', 'activity'],
          ['profile', 'profile'],
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'chat' &&
        (a.manual ? (
          <section className="tab-body">
            <p className="muted small">{t('manualNote')}</p>
            {inbox.map((m) => (
              <div key={m.id} className="inbox-item">
                <p>{m.task}</p>
                <div className="row">
                  <button className="link small" onClick={() => copy(m.id, m.prompt)}>
                    {copied === m.id ? t('copied') : t('copyPrompt')}
                  </button>
                  <button className="link small" onClick={() => post(`/api/manual/${m.id}/done`).then(company.refreshManual)}>
                    {t('markDone')}
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : (
          <Chat agent={a} />
        ))}

      {tab === 'activity' && (
        <div className="tab-body">
          <Timeline events={related} name={name} />
        </div>
      )}

      {tab === 'profile' && (
        <section className="tab-body">
          {a.external ? (
            <>
              <p className="note">{t('repoAgentNote').replace('{file}', `.claude/agents/${a.id}.md`).replace('{project}', company.projects.find((p) => p.id === a.external)?.name ?? '')}</p>
              <h3>{t('about')}</h3>
              <p>{a.description}</p>
            </>
          ) : (
            <AgentEditor agent={a} />
          )}
          {a.tools?.length ? (
            <>
              <h3>{t('tools')}</h3>
              <p className="muted small">{a.tools.join(' · ')}</p>
            </>
          ) : null}
          {(file || a.prompt) && (
            <>
              <h3>{file ? `${t('generated')} · ${file.path}` : t('prompt')}</h3>
              <pre className="code">{file?.content ?? a.prompt}</pre>
            </>
          )}
        </section>
      )}
    </aside>
  )
}
