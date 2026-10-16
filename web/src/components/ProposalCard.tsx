import { useState } from 'react'
import type { Proposal } from '../../../shared/types.ts'
import { post } from '../api.ts'
import { useT } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'

/** What approving does: agent files written into (or removed from) the project's repo. */
function Details({ p }: { p: Proposal }) {
  const { t } = useT()
  const agents = p.kind === 'design' ? (p.design?.agents ?? []) : p.kind === 'hire' && p.hire ? [p.hire] : []
  if (p.kind === 'permission') {
    return (
      <div className="design">
        <p className="muted small">{t('grants')}</p>
        <div className="perm-chips">
          {(p.permission?.tools ?? []).map((r) => (
            <code key={r} className="perm-chip">
              {r}
            </code>
          ))}
          {p.permission?.codexNetwork && <span className="perm-chip eng-codex">{t('codexNetwork')}</span>}
        </div>
      </div>
    )
  }
  if (p.kind === 'dismiss') {
    return (
      <div className="design">
        <p className="muted small">{t('removes')}</p>
        <code className="agent-file">{p.dismiss?.id}</code>
      </div>
    )
  }
  return (
    <div className="design">
      <p className="muted small">{t('writesTo')}</p>
      <ul className="agent-list">
        {agents.map((a) => (
          <li key={a.id}>
            <code className="agent-file">.{a.runtime === 'codex' ? 'codex' : 'claude'}/agents/{a.id}.md</code>
            <span className={`tag eng-${a.runtime === 'codex' ? 'codex' : 'claude'}`}>{a.runtime === 'codex' ? 'Codex' : 'Claude Code'}</span>
            {a.model && <span className="tag">{a.model}</span>}
            <p>{a.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A team change waiting for the owner, decided in place — in Approvals or right in the chat. */
export function ProposalCard({ p, inChat }: { p: Proposal; inChat?: boolean }) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const kind = { design: t('kindDesign'), hire: t('kindHire'), dismiss: t('kindDismiss'), permission: t('kindPermission') }[p.kind]
  const project = company.projects.find((x) => x.id === p.projectId)?.name
  const proposer = l(company.agents.find((a) => a.id === p.from)?.name) || p.from
  const pending = p.status === 'pending'

  const decide = async (approve: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await post(`/api/proposals/${p.id}/decide`, { approve })
      await Promise.all([company.refreshProposals(), company.refreshOrg()])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`proposal${inChat ? ' in-chat' : ''}${pending ? '' : ' done'}`}>
      <header>
        <span className="kind">
          {kind}
          {project && !inChat && <span className="muted"> · {project}</span>}
        </span>
        <span className="t">{hhmm(p.ts)}</span>
      </header>
      {!inChat && (
        <p className="muted small">
          {t('proposedBy')} {proposer}
          {p.reason && ` — ${p.reason}`}
        </p>
      )}
      {inChat && p.reason && <p className="muted small">{p.reason}</p>}
      {(pending || !inChat) && <Details p={p} />}
      {pending ? (
        <div className="row">
          <button className="btn solid" disabled={busy} onClick={() => decide(true)}>
            {t('approve')}
          </button>
          <button className="btn" disabled={busy} onClick={() => decide(false)}>
            {t('reject')}
          </button>
        </div>
      ) : (
        <p className={`checkin-outcome d-${p.status === 'approved' ? 'ok' : 'changes'}`}>
          {p.status === 'approved' ? t('approved') : t('rejected')}
          {p.kind === 'design' && p.design && <span className="muted"> · {p.design.agents.map((a) => a.id).join(', ')}</span>}
          {p.kind === 'hire' && p.hire && <span className="muted"> · {p.hire.id}</span>}
          {p.kind === 'dismiss' && p.dismiss && <span className="muted"> · {p.dismiss.id}</span>}
          {p.kind === 'permission' && p.permission && (
            <span className="muted"> · {[...(p.permission.tools ?? []), ...(p.permission.codexNetwork ? [t('codexNetwork')] : [])].join(', ')}</span>
          )}
        </p>
      )}
      {err && <div className="error">{err}</div>}
    </article>
  )
}
