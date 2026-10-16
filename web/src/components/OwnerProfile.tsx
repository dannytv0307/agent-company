import { useEffect, useState } from 'react'
import type { OrgDef } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

type Form = {
  nameEn: string
  nameJa: string
  titleEn: string
  titleJa: string
  bio: string
  reportLanguage: string
  approval: 'manual' | 'auto'
  companyEn: string
  companyJa: string
  mission: string
}

const fromOrg = (org: OrgDef): Form => ({
  nameEn: org.owner.name.en,
  nameJa: org.owner.name.ja,
  titleEn: org.owner.title.en,
  titleJa: org.owner.title.ja,
  bio: org.owner.bio ?? '',
  reportLanguage: org.owner.preferences?.reportLanguage ?? 'English',
  approval: org.owner.preferences?.approval ?? 'manual',
  companyEn: org.company.name.en,
  companyJa: org.company.name.ja,
  mission: org.company.mission ?? '',
})

export function OwnerProfile() {
  const { company, openProjects } = useCompanyCtx()
  const { t } = useT()
  const [form, setForm] = useState<Form | null>(company.org ? fromOrg(company.org) : null)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle')

  useEffect(() => {
    if (company.org && !form) setForm(fromOrg(company.org))
  }, [company.org, form])

  if (!form) return null
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm({ ...form, [k]: v })
    setState('idle')
  }

  const save = async () => {
    setState('saving')
    try {
      await api('PUT', '/api/profile', {
        owner: {
          name: { en: form.nameEn.trim() || 'Owner', ja: form.nameJa.trim() || form.nameEn.trim() },
          title: { en: form.titleEn.trim(), ja: form.titleJa.trim() },
          bio: form.bio.trim(),
          preferences: { approval: form.approval, reportLanguage: form.reportLanguage.trim() || 'English' },
        },
        company: { name: { en: form.companyEn.trim() || 'My Company', ja: form.companyJa.trim() || form.companyEn.trim() }, mission: form.mission.trim() },
      })
      await company.refreshOrg()
      setState('saved')
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e))
    }
  }

  const field = (k: keyof Form, label: string, ph?: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={form[k]} placeholder={ph} onChange={(e) => set(k, e.target.value as never)} />
    </label>
  )

  return (
    <div className="profile">
      <h3>{t('yourProfile')}</h3>
      <div className="grid2">
        {field('nameEn', t('nameEn'))}
        {field('nameJa', t('nameJa'))}
        {field('titleEn', t('titleEn'))}
        {field('titleJa', t('titleJa'))}
      </div>
      <label className="field">
        <span>{t('bio')}</span>
        <textarea rows={3} value={form.bio} placeholder={t('bioPh')} onChange={(e) => set('bio', e.target.value)} />
      </label>
      {field('reportLanguage', t('reportLang'), 'English, Tiếng Việt, 日本語…')}
      <div className="field">
        <span>{t('approvalMode')}</span>
        <div className="seg2" role="group">
          <button className={form.approval === 'manual' ? 'on' : ''} onClick={() => set('approval', 'manual')}>
            {t('askMe')}
          </button>
          <button className={form.approval === 'auto' ? 'on' : ''} onClick={() => set('approval', 'auto')}>
            {t('autoApprove')}
          </button>
        </div>
      </div>

      <h3>{t('company')}</h3>
      <div className="grid2">
        {field('companyEn', t('companyEn'))}
        {field('companyJa', t('companyJa'))}
      </div>
      <label className="field">
        <span>{t('mission')}</span>
        <textarea rows={2} value={form.mission} placeholder={t('missionPh')} onChange={(e) => set('mission', e.target.value)} />
      </label>

      <div className="row save-row">
        <button className="btn solid" disabled={state === 'saving'} onClick={save}>
          {t('save')}
        </button>
        {state === 'saved' && <span className="muted small">{t('saved')}</span>}
        {!['idle', 'saving', 'saved'].includes(state) && <span className="error">{state}</span>}
      </div>

      <h3>{t('projects')}</h3>
      <ul className="project-summary">
        {company.projects.map((p) => (
          <li key={p.id}>
            <b>{p.name}</b>
            <code>{p.dir}</code>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={openProjects}>
        {t('manageProjects')}
      </button>
    </div>
  )
}
