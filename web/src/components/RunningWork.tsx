import { useState } from 'react'
import type { WorkItem } from '../../../shared/types.ts'
import { post } from '../api.ts'
import { useT, type StringKey } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

const KIND: Record<WorkItem['kind'], StringKey> = { run: 'wkRun', chat: 'wkChat', task: 'wkTask' }

/** "12m 05s" */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`
}

/** Everything running right now — organizer runs, chat replies, delegated tasks — each with a Stop button. */
export function RunningWork({ agentId }: { agentId?: string } = {}) {
  const { company, select } = useCompanyCtx()
  const items = agentId ? company.work.filter((w) => w.agentId === agentId) : company.work
  const { t, l } = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const name = (id?: string) => (id ? l(company.agents.find((a) => a.id === id)?.name) || id : '')
  const projectName = (id: string) => company.projects.find((p) => p.id === id)?.name ?? id
  // What it is doing now: its latest step in the event stream.
  const latest = (w: WorkItem) =>
    company.events.findLast((e) => e.kind === 'activity' && ((w.aid && e.meta?.aid === w.aid) || (w.kind === 'run' && e.runId === w.runId && e.agent === w.agentId)))?.text
  // Inside an organizer run, its own subagents (they stop with the run).
  const subagents = (w: WorkItem) => (w.kind === 'run' ? Object.entries(company.states).flatMap(([id, s]) => s.active.filter((x) => x.runId === w.runId && id !== w.agentId && !company.work.some((o) => o.aid === x.aid)).map((x) => ({ id, ...x }))) : [])
  const waiting = (w: WorkItem) => company.openCheckIns.some((c) => c.agentId === w.agentId && c.projectId === w.projectId)
  const limit = company.org?.owner.preferences?.autoStopMinutes

  const stop = async (w: WorkItem) => {
    if (!confirm(t('wkStopConfirm').replace('{what}', `${name(w.agentId)} — ${w.title}`))) return
    setBusy(w.id)
    setErr(null)
    try {
      await post(`/api/work/${w.id}/stop`)
      await company.refreshWork()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // In an agent's panel the list only appears while that agent is working.
  if (agentId && !items.length) return null

  return (
    <section className="running">
      <h3>
        {t('wkTitle')}
        {limit ? <span className="muted"> · {t('wkLimit').replace('{n}', String(limit))}</span> : null}
      </h3>
      {err && <div className="error">{err}</div>}
      {items.length === 0 && <p className="muted small">{t('wkNone')}</p>}
      <ul className="work-list">
        {items.map((w) => {
          const age = company.now - w.startedAt
          const level = age > 30 * 60_000 ? ' long' : age > 15 * 60_000 ? ' slow' : ''
          const subs = subagents(w)
          return (
            <li key={w.id} className={`work-item${level}`}>
              <div className="work-top">
                <span className={`work-kind k-${w.kind}`}>{t(KIND[w.kind])}</span>
                <button className="link small who" onClick={() => select(w.agentId)}>
                  {name(w.agentId)}
                </button>
                {w.from && <span className="muted small">← {name(w.from)}</span>}
                <span className={`tag eng-${w.engine}`}>{w.engine === 'codex' ? 'Codex' : 'Claude Code'}</span>
                <span className="work-time">{w.status === 'queued' ? t('wkQueued') : elapsed(age)}</span>
                <button className="btn quiet work-stop" disabled={busy === w.id} onClick={() => stop(w)}>
                  {t('wkStop')}
                </button>
              </div>
              <div className="work-title">{w.title}</div>
              <div className="work-meta muted small">
                {projectName(w.projectId)}
                {waiting(w) ? <span className="work-waiting"> · {t('wkWaiting')}</span> : latest(w) && <> · {latest(w)!.replace(/^[^\p{L}\p{N}$/]+/u, '')}</>}
              </div>
              {subs.length > 0 && (
                <ul className="work-subs">
                  {subs.map((s) => (
                    <li key={s.aid}>
                      <b>{name(s.id)}</b> <span className="muted">{s.text.replace(/^[^\p{L}\p{N}$/]+/u, '')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
