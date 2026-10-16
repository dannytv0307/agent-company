import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'
import { CheckIn } from './CheckIn.tsx'
import { ProposalCard } from './ProposalCard.tsx'

export function Approvals() {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const projectName = (id?: string) => company.projects.find((x) => x.id === id)?.name
  const kind = { design: t('kindDesign'), hire: t('kindHire'), dismiss: t('kindDismiss'), permission: t('kindPermission') }
  const done = company.proposals.filter((p) => p.status !== 'pending').slice(0, 12)

  return (
    <div className="approvals">
      {company.attention === 0 && <p className="muted">{t('noApprovals')}</p>}
      {company.openCheckIns.map((cp) => (
        <CheckIn key={cp.id} cp={cp} showProject />
      ))}
      {company.pending.map((p) => (
        <ProposalCard key={p.id} p={p} />
      ))}
      {done.length > 0 && (
        <>
          <h3>{t('history')}</h3>
          <ul className="history">
            {done.map((p) => (
              <li key={p.id}>
                <span className={`state ${p.status}`}>{p.status === 'approved' ? t('approved') : t('rejected')}</span>
                {kind[p.kind]}
                {p.kind === 'hire' && p.hire && ` · ${p.hire.id}`}
                {p.kind === 'design' && p.design && ` · ${p.design.agents.map((a) => a.id).join(', ')}`}
                {p.kind === 'dismiss' && p.dismiss && ` · ${p.dismiss.id}`}
                {p.kind === 'permission' && p.permission && ` · ${[...(p.permission.tools ?? []), ...(p.permission.codexNetwork ? [t('codexNetwork')] : [])].join(', ')}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
