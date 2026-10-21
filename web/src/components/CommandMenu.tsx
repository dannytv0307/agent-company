import { useEffect, useState, type KeyboardEvent } from 'react'
import type { AgentRef, RepoCommand } from '../../../shared/types.ts'
import { useT } from '../i18n.ts'

/**
 * Suggestions for the repo's slash commands while the owner types "/…" in a message box.
 * Returns the menu to render above the box and a key handler: ↑/↓ move, Tab or Enter picks.
 */
export function useCommandMenu(text: string, setText: (v: string) => void, commands: RepoCommand[]) {
  const { t } = useT()
  const [index, setIndex] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const typing = /^\/[\w:.-]*$/.test(text) && closedFor !== text
  const query = typing ? text.slice(1).toLowerCase() : ''
  const matches = typing ? commands.filter((c) => c.name.toLowerCase().startsWith(query)).slice(0, 8) : []
  // Already typed a whole command name: nothing left to suggest.
  const open = matches.length > 0 && !(matches.length === 1 && matches[0].name.toLowerCase() === query)

  useEffect(() => setIndex(0), [query])

  const pick = (c: RepoCommand) => setText(`/${c.name} `)

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return true
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
      e.preventDefault()
      pick(matches[index] ?? matches[0])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosedFor(text)
      return true
    }
    return false
  }

  const menu = open ? (
    <div className="cmd-menu" role="listbox" aria-label={t('cmdHint')}>
      <div className="cmd-menu-head">{t('cmdHint')}</div>
      {matches.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'on' : ''}
          onMouseDown={(e) => e.preventDefault()} // keep focus in the box
          onClick={() => pick(c)}
        >
          <span className="cmd-name">
            /{c.name}
            {c.argumentHint && <em> {c.argumentHint}</em>}
          </span>
          {c.description && <span className="cmd-desc">{c.description}</span>}
        </button>
      ))}
    </div>
  ) : null

  return { menu, onKeyDown }
}

/** Typing "@…" in the chat lists the team's agents; picking one fills in "@agent-id " to call them. */
export function useAgentMenu(text: string, setText: (v: string) => void, agents: AgentRef[]) {
  const { t, l } = useT()
  const [index, setIndex] = useState(0)
  const [closedFor, setClosedFor] = useState<string | null>(null)
  const typing = /^@[\w.-]*$/.test(text) && closedFor !== text
  const query = typing ? text.slice(1).toLowerCase() : ''
  const matches = typing
    ? agents.filter((a) => a.id.toLowerCase().startsWith(query) || l(a.name).toLowerCase().startsWith(query)).slice(0, 8)
    : []
  const open = matches.length > 0

  useEffect(() => setIndex(0), [query])

  const pick = (a: AgentRef) => setText(`@${a.id} `)

  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
      return true
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
      e.preventDefault()
      pick(matches[index] ?? matches[0])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setClosedFor(text)
      return true
    }
    return false
  }

  const menu = open ? (
    <div className="cmd-menu" role="listbox" aria-label={t('agentHint')}>
      <div className="cmd-menu-head">{t('agentHint')}</div>
      {matches.map((a, i) => (
        <button
          key={a.id}
          role="option"
          aria-selected={i === index}
          className={i === index ? 'on' : ''}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(a)}
        >
          <span className="cmd-name">
            @{a.id}
            <em> · {a.runtime === 'codex' ? 'Codex' : 'Claude Code'}</em>
          </span>
          <span className="cmd-desc">{l(a.role)}</span>
        </button>
      ))}
    </div>
  ) : null

  return { menu, onKeyDown }
}
