import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '../../../shared/types.ts'
import { get, post } from '../api.ts'
import { useT } from '../i18n.ts'
import { ago, useCompanyCtx } from '../context.ts'
import { monogram } from './OrgChart.tsx'

/** Re-fetch the portfolio when the company does something, at most every ~1.5s. */
export function usePortfolio() {
  const { company } = useCompanyCtx()
  const [items, setItems] = useState<ProjectSummary[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = () => get<ProjectSummary[]>('/api/portfolio').then(setItems).catch(() => {})
  useEffect(() => {
    void load()
  }, [])
  const last = company.events[company.events.length - 1]
  useEffect(() => {
    if (!last || last.kind === 'chat') return
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      void load()
    }, 1500)
  }, [last?.id])
  return { items, reload: load }
}

const needsTotal = (p: ProjectSummary) => p.needs.approvals + p.needs.questions + p.needs.blocked + p.needs.manual

/** Projects that need the owner first, then running ones, then by latest activity. */
const order = (a: ProjectSummary, b: ProjectSummary) =>
  Number(needsTotal(b) > 0) - Number(needsTotal(a) > 0) || Number(b.running) - Number(a.running) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0)

function MultiAssign({ items, onDone }: { items: ProjectSummary[]; onDone: () => void }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const filled = Object.entries(rows).filter(([, v]) => v.trim())

  const assignAll = async () => {
    setBusy(true)
    setMsg(null)
    const failed: string[] = []
    for (const [projectId, task] of filled) {
      try {
        await post('/api/run', { projectId, task })
      } catch (e) {
        failed.push(`${items.find((p) => p.id === projectId)?.name}: ${e instanceof Error ? e.message : e}`)
      }
    }
    setBusy(false)
    setRows({})
    setMsg(failed.length ? { ok: false, text: failed.join(' · ') } : { ok: true, text: t('assignedAll') })
    await company.refreshState()
    onDone()
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        {t('assignMany')}
      </button>
    )
  }
  return (
    <div className="multi">
      <div className="multi-head">
        <h3>{t('assignMany')}</h3>
        <button className="link small" onClick={() => setOpen(false)}>
          {t('close')}
        </button>
      </div>
      {items.map((p) => (
        <label key={p.id} className={`multi-row${p.running ? ' busy' : ''}`}>
          <span className="pname">{p.name}</span>
          <input
            value={rows[p.id] ?? ''}
            disabled={p.running || !p.exists}
            placeholder={p.running ? t('alreadyRunning') : t('composer')}
            onChange={(e) => setRows({ ...rows, [p.id]: e.target.value })}
          />
        </label>
      ))}
      <div className="row">
        <button className="btn solid" disabled={busy || !filled.length} onClick={assignAll}>
          {t('assignAll')} {filled.length > 0 && `(${filled.length})`}
        </button>
        {msg && <span className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</span>}
      </div>
    </div>
  )
}

export function Portfolio({ onOpen }: { onOpen: (id: string) => void }) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const { items, reload } = usePortfolio()
  if (!items) return <div className="loading">…</div>
  const sorted = [...items].sort(order)
  const name = (id: string) => l(company.agents.find((a) => a.id === id)?.name) || id

  return (
    <div className="portfolio">
      <div className="portfolio-head">
        <div>
          <h1>{t('projects')}</h1>
          <p className="muted">
            {items.filter((p) => p.running).length} {t('runningNow')} · {items.filter((p) => needsTotal(p) > 0).length} {t('needYou')}
          </p>
        </div>
        <MultiAssign items={items} onDone={reload} />
      </div>
      <div className="cards">
        {sorted.map((p) => {
          const needs = needsTotal(p)
          const people = [...new Set(p.working.map((w) => w.agentId))]
          return (
            <button key={p.id} className={`pcard${needs ? ' attention' : ''}${p.running ? ' running' : ''}`} onClick={() => onOpen(p.id)}>
              <div className="pcard-top">
                <span className="pcard-name">{p.name}</span>
                <span className={`pstate ${needs ? 'needs' : p.running ? 'run' : 'idle'}`}>
                  {needs ? t('needsYou') : p.running ? t('running') : t('idle')}
                </span>
              </div>
              <div className="pcard-progress">
                <span className="bar big">
                  <i style={{ width: `${p.progress.pct}%` }} />
                </span>
                <span className="pct">{p.progress.total ? `${p.progress.pct}%` : '—'}</span>
              </div>
              <div className="pcard-line muted">
                {p.progress.total ? `${p.progress.done}/${p.progress.total} ${t('tasksDone')}` : t('noPlanShort')}
                {p.milestone && ` · ${p.milestone}`}
              </div>
              {needs > 0 && (
                <div className="pcard-needs">
                  {p.needs.approvals > 0 && <span>{p.needs.approvals} {t('nApprovals')}</span>}
                  {p.needs.questions > 0 && <span>{p.needs.questions} {t('nQuestions')}</span>}
                  {p.needs.blocked > 0 && <span>{p.needs.blocked} {t('nBlocked')}</span>}
                  {p.needs.manual > 0 && <span>{p.needs.manual} {t('nManual')}</span>}
                </div>
              )}
              <div className="pcard-people">
                {people.length ? (
                  <>
                    <span className="stack">
                      {people.slice(0, 5).map((id) => (
                        <span key={id} className="mono xs" title={name(id)}>
                          {monogram(name(id))}
                        </span>
                      ))}
                    </span>
                    <span>
                      {people.length} {t('atWork')}
                    </span>
                  </>
                ) : p.next ? (
                  <span className="muted">
                    {t('next')}: <b>{p.next.id}</b> {p.next.title}
                  </span>
                ) : (
                  <span className="muted">{t('allQuiet')}</span>
                )}
              </div>
              <div className="pcard-foot muted">
                <span>{p.lastActivity ? ago(p.lastActivity, t) : t('noActivityYet')}</span>
                {p.costUsd > 0 && <span>${p.costUsd.toFixed(2)}</span>}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
