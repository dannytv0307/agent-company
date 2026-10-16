import { useEffect, useState } from 'react'
import type { ProjectRef } from '../../../shared/types.ts'
import { api } from '../api.ts'
import { useT } from '../i18n.ts'
import { useCompanyCtx } from '../context.ts'

async function remove(id: string) {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE', headers: { 'x-agent-company': '1' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
}

function Row({ p }: { p: ProjectRef }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(p.name)
  const [folder, setFolder] = useState(p.path)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const busy = company.busyProjects.has(p.id)
  const isActive = company.project?.id === p.id

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null)
    try {
      await fn()
      await company.refreshOrg()
      if (ok) setMsg({ ok: true, text: ok })
      setEditing(false)
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <li className={`project-row${isActive ? ' on' : ''}`}>
      {editing ? (
        <div className="project-edit">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('projectName')} />
          <input className="mono-input" value={folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} aria-label={t('folder')} />
          <div className="row">
            <button className="btn solid" onClick={() => run(() => api('PUT', `/api/projects/${p.id}`, { name, path: folder }), t('saved'))}>
              {t('save')}
            </button>
            <button className="link small" onClick={() => setEditing(false)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="project-main" onClick={() => run(() => company.selectProject(p.id))} title={t('switchTo')}>
            <span className={`pdot${busy ? ' busy' : ''}`} />
            <span className="pname">{p.name}</span>
            {isActive && <span className="tag">{t('current')}</span>}
            <code className={`ppath${p.exists ? '' : ' missing'}`}>{p.exists ? p.dir : `${p.dir} — ${t('folderMissing')}`}</code>
          </button>
          <div className="row">
            <button className="link small" onClick={() => setEditing(true)}>
              {t('edit')}
            </button>
            {company.projects.length > 1 && (
              <button className="link small danger" disabled={busy} onClick={() => confirm(t('removeConfirm')) && run(() => remove(p.id))}>
                {t('remove')}
              </button>
            )}
          </div>
        </>
      )}
      {!editing && p.scan && <RepoSummary p={p} />}
      {msg && <p className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</p>}
    </li>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the repo already brings. (The "who works here" switch is hidden for now: repo agents have
 * their own frame and both the CEO and company members can direct them, so "both" is the default.)
 */
function RepoSummary({ p }: { p: ProjectRef }) {
  const { t } = useT()
  const s = p.scan!
  const chips = [
    s.claudeMd && 'CLAUDE.md',
    s.agentsMd && 'AGENTS.md',
    s.agents.length && plural(s.agents.length, 'agent'),
    s.skills.length && plural(s.skills.length, 'skill'),
    s.commands.length && plural(s.commands.length, 'command'),
    s.mcp && '.mcp.json',
    s.settings && 'settings',
    s.roadmap,
  ].filter(Boolean) as string[]
  if (!chips.length) return null
  return (
    <div className="repo-summary">
      <span className="label">{t('repoBrings')}</span>
      {chips.map((c) => (
        // File names in monospace, counts in the regular face.
        <span key={c} className={`repo-chip${/[./]/.test(c) ? ' file' : ''}`}>
          {c}
        </span>
      ))}
    </div>
  )
}

export function ProjectsModal({ onClose }: { onClose: () => void }) {
  const { company } = useCompanyCtx()
  const { t } = useT()
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const add = async () => {
    setMsg(null)
    try {
      const r = await api<{ project: ProjectRef; created: boolean; skipped: string[] }>('POST', '/api/projects', { name, path: folder })
      await company.selectProject(r.project.id)
      setName('')
      setFolder('')
      setMsg({ ok: true, text: `${r.created ? t('workspaceCreated') : t('projectAdded')}${r.skipped.length ? ` ${t('workspaceSkipped')} ${r.skipped.join(', ')}` : ''}` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('projects')}</h2>
            <p className="muted small">{t('projectsHint')}</p>
          </div>
          <button className="close static" onClick={onClose} aria-label={t('close')}>
            ×
          </button>
        </div>
        <div className="modal-scroll">
          <ul className="project-list">
            {company.projects.map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </ul>
          <h3>{t('newProject')}</h3>
          <div className="project-add">
            <input value={name} placeholder={t('projectName')} onChange={(e) => setName(e.target.value)} />
            <input className="mono-input" value={folder} spellCheck={false} placeholder="C:\Users\you\projects\website" onChange={(e) => setFolder(e.target.value)} />
            <button className="btn solid" disabled={!name.trim() || !folder.trim()} onClick={add}>
              {t('add')}
            </button>
          </div>
          <p className="hint">{t('workspaceHint')}</p>
          {msg && <p className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</p>}
        </div>
      </div>
    </div>
  )
}
