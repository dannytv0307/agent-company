import { useState } from 'react'
import type { Proposal } from '../../../shared/types.ts'
import { post } from '../api.ts'
import { useT } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'

function Details({ p }: { p: Proposal }) {
  const { l } = useT()
  if (p.kind === 'design' && p.design) {
    return (
      <div className="design">
        {p.design.company?.mission && <p className="mission">{p.design.company.mission}</p>}
        {p.design.departments.map((d) => (
          <div key={d.id} className="dep">
            <div className="dep-name">{l(d.name)}</div>
            <ul>
              {d.members.map((m) => (
                <li key={m.id}>
                  <b>{l(m.name)}</b> · {l(m.role)}
                  {m.runtime && m.runtime !== 'claude' && <span className="tag">{m.runtime}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    )
  }
  if (p.kind === 'hire' && p.hire) {
    return (
      <div className="design">
        <p>
          <b>{l(p.hire.name)}</b> · {l(p.hire.role)}
          {p.hire.runtime && p.hire.runtime !== 'claude' && <span className="tag">{p.hire.runtime}</span>}
        </p>
        <p className="muted small">{p.hire.description}</p>
      </div>
    )
  }
  return <p className="design">{p.dismiss?.id}</p>
}

export function Approvals() {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const name = (id: string) => l(company.agents.find((a) => a.id === id)?.name) || id
  const kind = { design: t('kindDesign'), hire: t('kindHire'), dismiss: t('kindDismiss') }
  const done = company.proposals.filter((p) => p.status !== 'pending').slice(0, 12)

  const decide = async (id: string, approve: boolean) => {
    setBusy(id)
    setErr(null)
    try {
      await post(`/api/proposals/${id}/decide`, { approve })
      await Promise.all([company.refreshProposals(), company.refreshOrg()])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="approvals">
      {err && <div className="error">{err}</div>}
      {company.pending.length === 0 && <p className="muted">{t('noApprovals')}</p>}
      {company.pending.map((p) => (
        <article key={p.id} className="proposal">
          <header>
            <span className="kind">{kind[p.kind]}</span>
            <span className="t">{hhmm(p.ts)}</span>
          </header>
          <p className="muted small">
            {t('proposedBy')} {name(p.from)}
            {p.reason && ` — ${p.reason}`}
          </p>
          <Details p={p} />
          <div className="row">
            <button className="btn solid" disabled={busy === p.id} onClick={() => decide(p.id, true)}>
              {t('approve')}
            </button>
            <button className="btn" disabled={busy === p.id} onClick={() => decide(p.id, false)}>
              {t('reject')}
            </button>
          </div>
        </article>
      ))}
      {done.length > 0 && (
        <>
          <h3>{t('history')}</h3>
          <ul className="history">
            {done.map((p) => (
              <li key={p.id}>
                <span className={`state ${p.status}`}>{p.status === 'approved' ? t('approved') : t('rejected')}</span>
                {kind[p.kind]}
                {p.kind === 'hire' && p.hire && ` · ${l(p.hire.name)}`}
                {p.kind === 'dismiss' && p.dismiss && ` · ${p.dismiss.id}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
