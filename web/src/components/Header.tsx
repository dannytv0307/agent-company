import type { Lang } from '../../../shared/types.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'
import { ProjectSwitcher } from './ProjectSwitcher.tsx'
import { monogram } from './OrgChart.tsx'

export type Theme = 'system' | 'light' | 'dark'

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON: Record<Theme, string> = { system: '◐', light: '○', dark: '●' }

interface Props {
  lang: Lang
  setLang: (l: Lang) => void
  theme: Theme
  setTheme: (t: Theme) => void
  onActivity: () => void
  onApprovals: () => void
  onPlan: () => void
  onConfigs: () => void
  onOwner: () => void
  view: 'org' | 'portfolio' | 'project'
  setView: (v: 'org' | 'portfolio' | 'project') => void
}

export function Header({ lang, setLang, theme, setTheme, onActivity, onApprovals, onPlan, onConfigs, onOwner, view, setView }: Props) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const working = Object.values(company.states).filter((s) => s.status === 'working').length
  const status = !company.connected ? t('offlineServer') : working ? `${working} ${t('atWork')}` : t('allQuiet')

  return (
    <header className="header">
      <div className="brand">
        <span className="wordmark">{l(company.org?.company.name)}</span>
        <ProjectSwitcher />
        <button className="progress-pill" onClick={onPlan} title={t('plan')}>
          {company.progress.total ? (
            <>
              <span className="bar">
                <i style={{ width: `${company.progress.pct}%` }} />
              </span>
              {company.progress.pct}% · {company.progress.done}/{company.progress.total}
            </>
          ) : (
            t('noPlanShort')
          )}
        </button>
        <button className={`pulse${company.connected ? (working || company.work.length ? ' busy' : '') : ' off'}`} onClick={onActivity} title={t('wkTitle')}>
          <i />
          {company.work.length ? `${company.work.length} ${t('wkRunningShort')}` : status}
        </button>
      </div>
      <nav className="actions">
        <div className="views" role="tablist">
          <button role="tab" aria-selected={view === 'org'} className={view === 'org' ? 'on' : ''} onClick={() => setView('org')}>
            {t('viewBoard')}
          </button>
          <button role="tab" aria-selected={view !== 'org'} className={view !== 'org' ? 'on' : ''} onClick={() => setView('portfolio')}>
            {t('viewAll')}
          </button>
        </div>
        <span className="sep" />
        {company.attention > 0 && (
          <button className="link attention" onClick={onApprovals}>
            {t('approvals')}
            <span className="badge">{company.attention}</span>
          </button>
        )}
        <button className="link" onClick={onActivity}>
          {t('activity')}
        </button>
        <button className="link" onClick={onConfigs}>
          {t('configs')}
        </button>
        <span className="sep" />
        <button className="icon" onClick={() => setTheme(NEXT_THEME[theme])} title={`${t('theme')}: ${theme}`} aria-label={`${t('theme')}: ${theme}`}>
          {THEME_ICON[theme]}
        </button>
        <button className="icon text" onClick={() => setLang(lang === 'en' ? 'ja' : 'en')} aria-label="Language">
          {lang === 'en' ? '日本語' : 'EN'}
        </button>
        {company.org && (
          <button className="icon owner-btn" onClick={onOwner} title={`${l(company.org.owner.name)} · ${t('owner')}`} aria-label={t('owner')}>
            {monogram(l(company.org.owner.name))}
          </button>
        )}
      </nav>
    </header>
  )
}
