import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

/** "Company / Project ▾" — choose which folder new tasks and chats go to. */
export function ProjectSwitcher() {
  const { company, openProjects } = useCompanyCtx()
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!company.project) return null
  const others = [...company.busyProjects].filter((id) => id !== company.project!.id).length

  return (
    <div className="switcher" ref={ref}>
      <span className="slash">/</span>
      <button className="switch-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className={`pdot${company.busyProjects.has(company.project.id) ? ' busy' : ''}`} />
        {company.project.name}
        {others > 0 && <span className="badge quiet">+{others}</span>}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          {company.projects.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === company.project?.id}
              className={p.id === company.project?.id ? 'on' : ''}
              onClick={() => {
                setOpen(false)
                void company.selectProject(p.id)
              }}
            >
              <span className={`pdot${company.busyProjects.has(p.id) ? ' busy' : ''}`} />
              <span className="pname">{p.name}</span>
              <code className="ppath">{p.dir}</code>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false)
              openProjects()
            }}
          >
            {t('manageProjects')}
          </button>
        </div>
      )}
    </div>
  )
}
