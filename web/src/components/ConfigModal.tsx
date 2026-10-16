import { useEffect, useState } from 'react'
import type { CompiledFile } from '../../../shared/types.ts'
import { get, post } from '../api.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

export function ConfigModal({ onClose }: { onClose: () => void }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [files, setFiles] = useState<CompiledFile[]>([])
  const [sel, setSel] = useState(0)
  const [state, setState] = useState<'idle' | 'writing' | 'written' | string>('idle')

  useEffect(() => {
    get<CompiledFile[]>(`/api/compile?project=${encodeURIComponent(company.project?.id ?? '')}`).then(setFiles).catch((e) => setState(String(e)))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const write = async () => {
    setState('writing')
    try {
      await post(`/api/compile?project=${encodeURIComponent(company.project?.id ?? '')}`)
      setState('written')
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e))
    }
  }

  const f = files[sel]
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('configs')}</h2>
            <p className="muted small">
              {t('configsHint')} <code>{company.project?.dir}</code>
            </p>
          </div>
          <div className="row">
            <button className="btn solid" onClick={write} disabled={state === 'writing'}>
              {state === 'written' ? t('written') : t('write')}
            </button>
            <button className="close static" onClick={onClose} aria-label={t('close')}>
              ×
            </button>
          </div>
        </div>
        {!['idle', 'writing', 'written'].includes(state) && <div className="error pad">{state}</div>}
        <div className="modal-body">
          <ul className="files">
            {files.map((x, i) => (
              <li key={x.path} className={i === sel ? 'on' : ''} onClick={() => setSel(i)}>
                <span className="kind">{x.runtime}</span>
                <code>{x.path}</code>
              </li>
            ))}
          </ul>
          <pre className="code big">{f?.content}</pre>
        </div>
      </div>
    </div>
  )
}
