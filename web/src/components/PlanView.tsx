import type { PlanTask, TaskStatus } from '../../../shared/types.ts'
import { useT, type StringKey } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

const ICON: Record<TaskStatus, string> = { todo: '○', doing: '◐', review: '◑', done: '●', blocked: '!' }
const LABEL: Record<TaskStatus, StringKey> = { todo: 'tTodo', doing: 'tDoing', review: 'tReview', done: 'tDone', blocked: 'tBlocked' }

/** The selected project's plan: goal, progress, milestones and their tasks. Updated live. */
export function PlanView() {
  const { company, select } = useCompanyCtx()
  const { t, l } = useT()
  const plan = company.plan
  if (!plan || !plan.tasks.length) return <p className="muted">{t('noPlan')}</p>

  const name = (id?: string) => (id ? l(company.agents.find((a) => a.id === id)?.name) || id : '')
  const groups = plan.milestones.length ? plan.milestones.map((m) => ({ ...m, tasks: plan.tasks.filter((x) => x.milestone === m.id) })) : []
  const loose = plan.tasks.filter((x) => !plan.milestones.some((m) => m.id === x.milestone))
  if (loose.length) groups.push({ id: '', title: plan.milestones.length ? t('other') : t('tasks'), tasks: loose })
  const counts = (ts: PlanTask[]) => `${ts.filter((x) => x.status === 'done').length}/${ts.length}`
  const blocked = plan.tasks.filter((x) => x.status === 'blocked').length

  return (
    <div className="plan">
      {plan.goal && <p className="plan-goal">{plan.goal}</p>}
      <div className="plan-progress">
        <span className="bar big">
          <i style={{ width: `${company.progress.pct}%` }} />
        </span>
        <span>
          <b>{company.progress.pct}%</b> · {company.progress.done}/{company.progress.total} {t('tasksDone')}
          {blocked > 0 && <span className="blocked-count"> · {blocked} {t('tBlocked').toLowerCase()}</span>}
        </span>
      </div>
      {groups.map((g) => (
        <section key={g.id || g.title} className="milestone">
          <h3>
            {g.id && <span className="mid">{g.id}</span>} {g.title} <span className="muted">{counts(g.tasks)}</span>
          </h3>
          <ul>
            {g.tasks.map((x) => (
              <li key={x.id} className={`task s-${x.status}`}>
                <span className="ticon" title={t(LABEL[x.status])}>
                  {ICON[x.status]}
                </span>
                <div>
                  <div className="ttitle">
                    <span className="tid">{x.id}</span> {x.title}
                  </div>
                  <div className="tmeta">
                    {t(LABEL[x.status])}
                    {x.assignee && (
                      <>
                        {' · '}
                        <button className="link small" onClick={() => select(x.assignee!)}>
                          {name(x.assignee)}
                        </button>
                      </>
                    )}
                    {x.note && <span className="tnote"> · {x.note}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
