import { useState } from 'react'
import type { Checkpoint } from '../../../shared/types.ts'
import { post } from '../api.ts'
import { useT, type StringKey } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'

const KIND: Record<Checkpoint['kind'], StringKey> = { spec: 'ckSpec', plan: 'ckPlan', milestone: 'ckMilestone', decision: 'ckDecision' }

/** A break point where the organizer waits for the owner: read it, then approve, ask for changes or pick an option. */
export function CheckIn({ cp, showProject, inChat }: { cp: Checkpoint; showProject?: boolean; inChat?: boolean }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const project = showProject ? company.projects.find((p) => p.id === cp.projectId)?.name : undefined

  const answer = async (decision: string) => {
    setBusy(true)
    setErr(null)
    try {
      await post(`/api/checkpoints/${cp.id}/answer`, { decision, comment })
      setComment('')
      await company.refreshCheckpoints()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const done = cp.status !== 'open'
  const a = cp.answer
  const outcome = !a
    ? ''
    : a.decision === 'approve'
      ? t('ckApproved')
      : a.decision === 'changes'
        ? t('ckChanged')
        : a.decision === 'reply'
          ? t('ckReplied')
          : `${t('ckChose')}: ${a.decision}`

  return (
    <article className={`checkin k-${cp.kind}${done ? ' done' : ''}${inChat ? ' in-chat' : ''}`}>
      <header>
        <span className="kind">
          {t(KIND[cp.kind])}
          {project && <span className="muted"> · {project}</span>}
        </span>
        <span className="t">{hhmm(cp.ts)}</span>
      </header>
      <h4>{cp.title}</h4>
      {!(done && inChat) && <div className="checkin-body">{cp.body}</div>}
      {cp.file && <code className="agent-file">{cp.file}</code>}
      {done ? (
        <p className={`checkin-outcome d-${a?.decision === 'approve' ? 'ok' : a?.decision === 'changes' ? 'changes' : 'other'}`}>
          {outcome}
          {a?.comment && a.decision !== 'reply' && <span className="muted"> — {a.comment}</span>}
        </p>
      ) : (
        <>
          <textarea rows={2} value={comment} placeholder={t('ckComment')} onChange={(e) => setComment(e.target.value)} disabled={busy} />
          <div className="row checkin-actions">
            {cp.options?.length ? (
              cp.options.map((o) => (
                <button key={o} className="btn solid" disabled={busy} onClick={() => answer(o)}>
                  {o}
                </button>
              ))
            ) : (
              <button className="btn solid" disabled={busy} onClick={() => answer('approve')}>
                {t('ckApprove')}
              </button>
            )}
            <button className="btn" disabled={busy || !comment.trim()} title={comment.trim() ? undefined : t('ckWhat')} onClick={() => answer('changes')}>
              {t('ckChanges')}
            </button>
          </div>
          {err && <div className="error">{err}</div>}
          {!inChat && <p className="hint">{t('ckChatHint')}</p>}
        </>
      )}
    </article>
  )
}
