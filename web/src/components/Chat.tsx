import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRef, ChatMessage } from '../../../shared/types.ts'
import { api, get, post } from '../api.ts'
import { useT } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'

export function Chat({ agent }: { agent: AgentRef }) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  // The server's copy of the thread, and when it was asked for. Only messages newer than that are
  // taken from the event stream: older copies there may belong to a conversation that was cleared.
  const [loaded, setLoaded] = useState<{ messages: ChatMessage[]; since: number }>({ messages: [], since: Infinity })
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const latest = useRef(agent.id)
  const pid = company.project?.id ?? ''

  const reload = () => {
    const id = agent.id
    const since = Date.now()
    return get<{ messages: ChatMessage[] }>(`/api/chat/${id}`)
      .then((r) => latest.current === id && setLoaded({ messages: r.messages, since })) // ignore answers for an agent we already left
      .catch((e) => setErr(String(e.message ?? e)))
  }

  useEffect(() => {
    latest.current = agent.id
    setLoaded({ messages: [], since: Infinity })
    setErr(null)
    void reload()
  }, [agent.id])

  // Cleared in another window: start over from the server's copy.
  const lastClear = company.events.findLast((e) => e.meta?.chatCleared === agent.id)
  useEffect(() => {
    if (lastClear) void reload()
  }, [lastClear?.id])

  // The conversation in the selected project only: each project has its own session with the agent,
  // so a clear empties exactly what is on screen.
  const messages = useMemo(() => {
    const live = company.events
      .filter((e) => e.kind === 'chat' && e.agent === agent.id && e.meta?.message)
      .map((e) => e.meta!.message as ChatMessage)
      .filter((m) => m.ts >= loaded.since)
    const byId = new Map<string, ChatMessage>()
    for (const m of [...loaded.messages, ...live]) if (!m.projectId || m.projectId === pid) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.ts - b.ts)
  }, [loaded, company.events, agent.id, pid])

  const multi = company.projects.length > 1
  const pending = messages.length > 0 && messages[messages.length - 1].role === 'owner'
  const st = company.states[agent.id]

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, pending])

  const clear = async () => {
    const where = company.projects.length > 1 ? ` (${company.project?.name})` : ''
    if (!confirm(`${t('clearConfirm').replace('{name}', l(agent.name))}${where}`)) return
    setErr(null)
    try {
      const r = await api<{ clearedAt: number }>('DELETE', `/api/chat/${agent.id}?project=${encodeURIComponent(pid ?? '')}`)
      // Drop this project's messages right away; the reload confirms what the server kept.
      setLoaded((l) => ({ messages: l.messages.filter((m) => m.projectId && m.projectId !== pid), since: r.clearedAt }))
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setText('')
    setErr(null)
    try {
      await post(`/api/chat/${agent.id}`, { text: body, projectId: company.project?.id })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setText(body)
    }
  }

  return (
    <div className="chat">
      {messages.length > 0 && (
        <div className="chat-tools">
          <button className="link small danger" disabled={pending} onClick={clear} title={pending ? t('typing') : undefined}>
            {t('clearChat')}
          </button>
        </div>
      )}
      <div className="chat-log">
        {messages.length === 0 && <p className="muted small chat-empty">{t('chatEmpty')}</p>}
        {messages.map((m) =>
          m.role === 'note' ? (
            <div key={m.id} className="note-line">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className="msg">
                <p>{m.text}</p>
                <span className="t">
                  {m.role === 'owner' ? t('you') : l(agent.name)} · {hhmm(m.ts)}
                </span>
              </div>
            </div>
          ),
        )}
        {pending && (
          <div className="typing">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            {l(agent.name)} {t('typing')}
            {st?.status === 'working' && st.bubble && <em>{st.bubble.replace(/^[^\p{L}\p{N}$]+/u, '')}</em>}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="chat-input">
        <textarea
          rows={1}
          value={text}
          placeholder={multi ? `${t('messageTo')} ${l(agent.name)} · ${company.project?.name}…` : `${t('messageTo')} ${l(agent.name)}…`}
          disabled={agent.manual}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="btn solid" disabled={!text.trim() || agent.manual} onClick={send}>
          {t('send')}
        </button>
      </div>
    </div>
  )
}
