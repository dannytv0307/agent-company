import { useState } from 'react'
import { post } from '../api.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'
import { monogram } from './OrgChart.tsx'

export function Composer() {
  const { company, select } = useCompanyCtx()
  const { t, l } = useT()
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const claude = company.runtimes.find((r) => r.runtime === 'claude')
  const ceo = company.org?.divisions[0]?.ceo
  const ceoEngine = ceo?.runtime === 'codex' ? 'Codex' : null

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      await company.refreshState()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const run = () =>
    act(async () => {
      await post('/api/run', { task, projectId: company.project?.id })
      setTask('')
    })

  const canRun = !busy && !company.running && !!task.trim() && !!claude?.installed
  // A fresh company has only its core roles (CEO, HR, partner): invite the owner to describe the business.
  const blank = company.agents.length > 0 && company.agents.every((a) => a.core || a.isCeo)
  const onDuty = company.agents
    .filter((a) => company.states[a.id]?.status === 'working')
    .sort((x, y) => (company.states[y.id]?.lastTs ?? 0) - (company.states[x.id]?.lastTs ?? 0))

  return (
    <section className="composer">
      <div className="composer-box">
        <span className="to">
          {l(ceo?.name)}
          {ceoEngine && <em> · {ceoEngine}</em>}
          {company.projects.length > 1 && <em> · {company.project?.name}</em>}
        </span>
        <input
          value={task}
          placeholder={blank ? t('composerBlank') : t('composer')}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canRun) void run()
          }}
        />
        {company.running ? (
          <button className="btn quiet" disabled={busy} onClick={() => act(() => post('/api/stop', { projectId: company.project?.id }))}>
            {t('stop')}
          </button>
        ) : (
          <button className="btn solid" disabled={!canRun} onClick={run}>
            {t('run')}
          </button>
        )}
      </div>
      <div className="composer-foot">
        {err || company.error ? (
          <span className="error">{err ?? company.error}</span>
        ) : onDuty.length ? (
          <div className="on-duty">
            {onDuty.slice(0, 4).map((a) => (
              <button key={a.id} className="duty" onClick={() => select(a.id)} title={company.states[a.id]?.bubble}>
                <span className="mono xs">{monogram(l(a.name))}</span>
                <b>{l(a.name)}</b>
                <span className="what">{company.states[a.id]?.bubble?.replace(/^[^\p{L}\p{N}$]+/u, '')}</span>
              </button>
            ))}
            {onDuty.length > 4 && <span className="duty more">+{onDuty.length - 4}</span>}
          </div>
        ) : blank && !company.running ? (
          <div className="examples">
            <span className="muted small">{t('startHint')}</span>
            {(['ex1', 'ex2', 'ex3'] as const).map((k) => (
              <button key={k} className="example" onClick={() => setTask(t(k))}>
                {t(k).replace(/^[^:：]+[:：]\s*/, '')}
              </button>
            ))}
          </div>
        ) : (
          !company.running && (
            <button className="link small" disabled={busy} onClick={() => act(() => post('/api/demo', { projectId: company.project?.id }))}>
              {t('demo')}
            </button>
          )
        )}
      </div>
    </section>
  )
}
