import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './styles.css'
import type { Lang } from '../../shared/types.ts'
import { LangContext } from './i18n.ts'
import { CompanyContext } from './context.ts'
import { useCompany } from './store.ts'
import { Header, type Theme } from './components/Header.tsx'
import { Composer } from './components/Composer.tsx'
import { OrgChart } from './components/OrgChart.tsx'
import { ACTIVITY, APPROVALS, AgentPanel, PLAN } from './components/AgentPanel.tsx'
import { ConfigModal } from './components/ConfigModal.tsx'
import { ProjectsModal } from './components/ProjectsModal.tsx'
import { Portfolio } from './components/Portfolio.tsx'
import { ProjectPage } from './components/ProjectPage.tsx'

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable — keep in memory only
  }
}

const loadLang = (): Lang => (load('lang') === 'ja' ? 'ja' : 'en')
const loadTheme = (): Theme => {
  const t = load('theme')
  return t === 'light' || t === 'dark' ? t : 'system'
}

function App() {
  const company = useCompany()
  const [lang, setLangState] = useState<Lang>(loadLang)
  const [theme, setThemeState] = useState<Theme>(loadTheme)
  const [selected, select] = useState<string | null>(null)
  const [configs, setConfigs] = useState(false)
  const closeConfigs = useCallback(() => setConfigs(false), [])
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [view, setView] = useState<'org' | 'portfolio' | 'project'>('org')
  const [focus, setFocus] = useState(false)
  const closeProjects = useCallback(() => setProjectsOpen(false), [])

  const setLang = (l: Lang) => {
    setLangState(l)
    save('lang', l)
  }
  const setTheme = (t: Theme) => {
    setThemeState(t)
    save('theme', t)
  }
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <LangContext.Provider value={lang}>
      <CompanyContext.Provider value={{ company, selected, select, openProjects: () => setProjectsOpen(true), focus, setFocus }}>
        <div className="app" lang={lang}>
          <Header
            lang={lang}
            setLang={setLang}
            theme={theme}
            setTheme={setTheme}
            onActivity={() => select(selected === ACTIVITY ? null : ACTIVITY)}
            onApprovals={() => select(selected === APPROVALS ? null : APPROVALS)}
            onPlan={() => (view === 'project' ? undefined : select(selected === PLAN ? null : PLAN))}
            view={view}
            setView={(v) => {
              select(null)
              setView(v)
            }}
            onConfigs={() => setConfigs(true)}
          />
          {/* The work area and the side panel sit side by side: opening a panel narrows the chart instead of covering it. */}
          <div className="body">
            <div className="work">
              <Composer />
              <main className={`stage${Object.values(company.states).some((s) => s.status === 'working') ? ' busy' : ''}`}>
                {view === 'org' && (
                  <ReactFlowProvider>
                    <OrgChart />
                  </ReactFlowProvider>
                )}
                {view === 'portfolio' && (
                  <Portfolio
                    onOpen={(id) => {
                      void company.selectProject(id)
                      setView('project')
                    }}
                  />
                )}
                {view === 'project' && (
                  <ProjectPage
                    onBack={() => setView('portfolio')}
                    onOrg={() => setView('org')}
                  />
                )}
              </main>
            </div>
            <AgentPanel />
          </div>
          {configs && <ConfigModal onClose={closeConfigs} />}
          {projectsOpen && <ProjectsModal onClose={closeProjects} />}
        </div>
      </CompanyContext.Provider>
    </LangContext.Provider>
  )
}

// The side panel's width, as the owner last dragged it.
const dock = Number(load('dock'))
if (dock >= 340) document.documentElement.style.setProperty('--dock', `${dock}px`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
