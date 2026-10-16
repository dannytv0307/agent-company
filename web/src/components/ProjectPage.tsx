import { useEffect, useMemo, useState } from 'react'
import type { AgentEvent, ProjectChanges } from '../../../shared/types.ts'
import { get } from '../api.ts'
import { useT } from '../i18n.ts'
import { ago, hhmm, useCompanyCtx } from '../context.ts'
import { monogram } from './OrgChart.tsx'
import { PlanView } from './PlanView.tsx'

const STALL_MS = 5 * 60_000
const clean = (s: string) => s.replace(/^[^\p{L}\p{N}$]+/u, '')

/** Everyone working in this project right now, with what they are doing. */
function NowStrip() {
  const { company, select } = useCompanyCtx()
  const { t, l } = useT()
  const pid = company.project?.id
  const rows = company.agents.flatMap((a) =>
    (company.states[a.id]?.active ?? []).filter((w) => w.projectId === pid).map((w) => ({ agent: a, w })),
  )
  if (!rows.length) return <div className="now-strip empty muted">{company.running ? t('starting') : t('nobodyWorking')}</div>
  return (
    <div className="now-strip">
      {rows.map(({ agent, w }) => {
        const stalled = company.now - w.ts > STALL_MS
        return (
          <button key={w.aid} className={`now-chip${stalled ? ' stalled' : ''}`} onClick={() => select(agent.id)} title={clean(w.title)}>
            <span className="mono xs">{monogram(l(agent.name))}</span>
            <b>{l(agent.name)}</b>
            <span className="what">{stalled ? `${t('quietFor')} ${ago(w.ts, t)}` : clean(w.text)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** The project's events grouped by plan task, newest group first. */
function ActivityByTask() {
  const { company, select } = useCompanyCtx()
  const { t, l } = useT()
  const [who, setWho] = useState('')
  const [detail, setDetail] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const pid = company.project?.id
  const name = (id?: string) =>
    company.org && id === company.org.owner.id ? l(company.org.owner.name) : l(company.agents.find((a) => a.id === id)?.name) || id || ''

  const groups = useMemo(() => {
    const evs = company.events.filter((e) => e.projectId === pid && e.kind !== 'system' && e.kind !== 'chat')
    const byKey = new Map<string, AgentEvent[]>()
    for (const e of evs) {
      if (who && e.agent !== who && e.from !== who && e.to !== who) continue
      if (!detail && e.kind === 'activity') continue
      const key = typeof e.meta?.taskId === 'string' ? e.meta.taskId : '—'
      byKey.set(key, [...(byKey.get(key) ?? []), e])
    }
    return [...byKey.entries()].sort((a, b) => b[1][b[1].length - 1].ts - a[1][a[1].length - 1].ts)
  }, [company.events, pid, who, detail])

  const people = [...new Set(company.events.filter((e) => e.projectId === pid).map((e) => e.agent ?? e.from).filter(Boolean))] as string[]
  const task = (id: string) => company.plan?.tasks.find((x) => x.id === id)

  return (
    <div className="by-task">
      <div className="filters">
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('everyone')}</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {name(p)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} /> {t('showSteps')}
        </label>
      </div>
      {groups.length === 0 && <p className="muted">{t('noActivity')}</p>}
      {groups.map(([key, evs], i) => {
        const x = key !== '—' ? task(key) : undefined
        const isOpen = open[key] ?? i < 3
        const first = evs[0].ts
        const lastTs = evs[evs.length - 1].ts
        return (
          <section key={key} className={`tgroup${x ? ` s-${x.status}` : ''}`}>
            <button className="tgroup-head" onClick={() => setOpen({ ...open, [key]: !isOpen })}>
              <span className="caret">{isOpen ? '▾' : '▸'}</span>
              {x ? (
                <>
                  <span className="tid">{x.id}</span>
                  <span className="tt">{x.title}</span>
                  <span className="meta">
                    {x.assignee && `${name(x.assignee)} · `}
                    {t(({ todo: 'tTodo', doing: 'tDoing', review: 'tReview', done: 'tDone', blocked: 'tBlocked' } as const)[x.status])}
                    {' · '}
                    {Math.max(1, Math.round((lastTs - first) / 60000))} min
                  </span>
                </>
              ) : (
                <span className="tt">{key === '—' ? t('general') : key}</span>
              )}
            </button>
            {isOpen && (
              <ol className="timeline">
                {evs.map((e) => (
                  <li key={e.id} className={`k-${e.kind}`}>
                    <span className="t">{hhmm(e.ts)}</span>
                    <div>
                      <div className="who">
                        <button className="link small" onClick={() => select(e.from ?? e.agent ?? null)}>
                          {name(e.from ?? e.agent)}
                        </button>
                        {e.to && <span className="arrow"> → </span>}
                        {e.to && name(e.to)}
                        {typeof e.meta?.file === 'string' && <code className="file">{e.meta.file}</code>}
                      </div>
                      <p>{e.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** Files changed in the project (git, read-only) and who touched them. */
function Changes() {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const pid = company.project?.id
  const [data, setData] = useState<ProjectChanges | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const load = () => pid && get<ProjectChanges>(`/api/projects/${pid}/changes`).then(setData).catch(() => setData(null))
  useEffect(() => {
    setData(null)
    setFile(null)
    void load()
  }, [pid])
  useEffect(() => {
    if (!file || !pid) return setDiff('')
    get<{ diff: string }>(`/api/projects/${pid}/diff?file=${encodeURIComponent(file)}`).then((r) => setDiff(r.diff))
  }, [file, pid])

  if (!data) return <div className="loading">…</div>
  const name = (id: string) => l(company.agents.find((a) => a.id === id)?.name) || id
  const added = data.files.reduce((s, f) => s + (f.added ?? 0), 0)
  const removed = data.files.reduce((s, f) => s + (f.removed ?? 0), 0)

  return (
    <div className="changes">
      <div className="changes-head">
        <span>
          <b>{data.files.length}</b> {t('filesChanged')} <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
          {data.branch && <span className="muted"> · {data.branch}</span>}
          {!data.git && <span className="muted"> · {t('notGit')}</span>}
        </span>
        <button className="link small" onClick={() => void load()}>
          {t('refresh')}
        </button>
      </div>
      <div className="changes-body">
        <ul className="file-list">
          {data.files.length === 0 && <li className="muted">{t('noChanges')}</li>}
          {data.files.map((f) => (
            <li key={f.path} className={file === f.path ? 'on' : ''} onClick={() => setFile(file === f.path ? null : f.path)}>
              <span className={`fstat s${f.status.replace('?', 'U')[0] ?? ''}`}>{f.status === '??' ? 'new' : f.status || '·'}</span>
              <code>{f.path}</code>
              <span className="lines">
                {f.added ? <span className="plus">+{f.added}</span> : null} {f.removed ? <span className="minus">−{f.removed}</span> : null}
              </span>
              {f.by.length > 0 && (
                <span className="by">
                  {[...new Set(f.by.map((b) => b.agentId))].slice(0, 3).map(name).join(', ')}
                  {f.by[0].taskId && ` · ${f.by[0].taskId}`}
                </span>
              )}
            </li>
          ))}
        </ul>
        {file && (
          <pre className="diff">
            {diff.split('\n').map((line, i) => (
              <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </div>
      {data.commits.length > 0 && (
        <>
          <h3>{t('commits')}</h3>
          <ul className="commits">
            {data.commits.map((c) => (
              <li key={c.hash}>
                <code>{c.hash}</code> {c.subject} <span className="muted">· {c.author} · {c.when}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export function ProjectPage({ onBack, onOrg }: { onBack: () => void; onOrg: () => void }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [tab, setTab] = useState<'plan' | 'activity' | 'changes'>('plan')
  const p = company.project
  if (!p) return null
  const team = p.scan?.agents.length ?? 0

  return (
    <div className="project-page">
      <div className="pp-head">
        <button className="link small" onClick={onBack}>
          ← {t('projects')}
        </button>
        <div className="pp-title">
          <h1>{p.name}</h1>
          <span className={`pstate ${company.running ? 'run' : 'idle'}`}>{company.running ? t('running') : t('idle')}</span>
        </div>
        <div className="pp-meta muted">
          <code>{p.dir}</code> · {team ? `${team} ${team === 1 ? t('agentOne') : t('agentsCount')}` : t('noTeam')}
          {' · '}
          <button className="link small" onClick={onOrg}>
            {t('viewOnChart')}
          </button>
        </div>
        <div className="pp-progress">
          <span className="bar big">
            <i style={{ width: `${company.progress.pct}%` }} />
          </span>
          <span>{company.progress.total ? `${company.progress.pct}% · ${company.progress.done}/${company.progress.total} ${t('tasksDone')}` : t('noPlanShort')}</span>
        </div>
      </div>
      <NowStrip />
      <div className="tabs">
        {(['plan', 'activity', 'changes'] as const).map((k) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {t(k === 'plan' ? 'plan' : k === 'activity' ? 'activity' : 'changesTab')}
          </button>
        ))}
      </div>
      <div className="pp-body">
        {tab === 'plan' && <PlanView />}
        {tab === 'activity' && <ActivityByTask />}
        {tab === 'changes' && <Changes />}
      </div>
    </div>
  )
}
