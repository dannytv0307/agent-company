import { useEffect, useState } from 'react'
import type { AgentRef } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

type Form = { nameEn: string; nameJa: string; roleEn: string; roleJa: string; model: string; description: string; prompt: string; runtime: string }

const fromAgent = (a: AgentRef): Form => ({
  nameEn: a.name.en,
  nameJa: a.name.ja,
  roleEn: a.role.en,
  roleJa: a.role.ja,
  model: a.model ?? '',
  description: a.description,
  prompt: (a.prompt ?? '').trim(),
  runtime: a.runtime,
})

const CLAUDE_MODELS = ['', 'opus', 'sonnet', 'haiku']

/** Lets the owner rename an employee and adjust their brief. The id (handle) never changes. */
export function AgentEditor({ agent }: { agent: AgentRef }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [form, setForm] = useState<Form>(() => fromAgent(agent))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle')

  // Switching to another agent resets the form.
  useEffect(() => {
    setForm(fromAgent(agent))
    setState('idle')
  }, [agent.id])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setState('idle')
  }

  const original = fromAgent(agent)
  // Only the company CEO can switch engines; everyone else runs where their division runs.
  const isMainCeo = agent.isCeo && !agent.external && company.org?.divisions.find((d) => d.ceo && d.mode !== 'manual')?.ceo?.id === agent.id
  const setRuntime = (r: string) => {
    // Model names belong to one engine; switching resets to that engine's default.
    setForm((f) => ({ ...f, runtime: r, model: r === original.runtime ? original.model : '' }))
    setState('idle')
  }
  const dirty = (Object.keys(form) as (keyof Form)[]).some((k) => form[k] !== original[k])

  const save = async () => {
    setState('saving')
    try {
      await api('PUT', `/api/agents/${agent.id}`, {
        name: { en: form.nameEn, ja: form.nameJa },
        role: { en: form.roleEn, ja: form.roleJa },
        description: form.description,
        prompt: form.prompt,
        ...(agent.manual ? {} : { model: form.model }),
        ...(isMainCeo && form.runtime !== original.runtime ? { runtime: form.runtime } : {}),
      })
      await company.refreshOrg()
      setState('saved')
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e))
    }
  }

  const input = (k: keyof Form, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={form[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  )

  return (
    <div className="profile">
      <div className="grid2">
        {input('nameEn', t('nameEn'))}
        {input('nameJa', t('nameJa'))}
        {input('roleEn', t('roleEn'))}
        {input('roleJa', t('roleJa'))}
      </div>
      {isMainCeo && (
        <div className="field">
          <span>{t('runsOn')}</span>
          <div className="seg2" role="group">
            {(['claude', 'codex'] as const).map((r) => (
              <button key={r} className={form.runtime === r ? 'on' : ''} onClick={() => form.runtime !== r && setRuntime(r)}>
                {r === 'claude' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </div>
          <p className="hint">{form.runtime === 'codex' ? t('ceoOnCodex') : t('ceoOnClaude')}</p>
        </div>
      )}
      {!agent.manual && (
        <label className="field">
          <span>{t('model')}</span>
          {form.runtime === 'claude' ? (
            <select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {[...new Set([...CLAUDE_MODELS, form.model])].map((m) => (
                <option key={m} value={m}>
                  {m || t('modelDefault')}
                </option>
              ))}
            </select>
          ) : (
            <input value={form.model} placeholder={t('modelDefault')} onChange={(e) => set('model', e.target.value)} />
          )}
        </label>
      )}
      <label className="field">
        <span>{t('jobDescription')}</span>
        <textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <label className="field">
        <span>{t('instructions')}</span>
        <textarea rows={5} value={form.prompt} placeholder={t('instructionsPh')} onChange={(e) => set('prompt', e.target.value)} />
      </label>
      <div className="row save-row">
        <button className="btn solid" disabled={!dirty || state === 'saving'} onClick={save}>
          {t('save')}
        </button>
        {state === 'saved' && <span className="muted small">{t('saved')}</span>}
        {!['idle', 'saving', 'saved'].includes(state) && <span className="error">{state}</span>}
      </div>
      <p className="muted small">
        ID <code>{agent.id}</code> · {t('idNote')}
      </p>
    </div>
  )
}
