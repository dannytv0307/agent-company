import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRef, ChatMessage } from '../../../shared/types.ts'
import { api, get, post } from '../api.ts'
import { useT } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'

export function Chat({ agent }: { agent: AgentRef }) {
  const { company } = useCompanyCtx()
  const { t, l } = useT()
  const [loaded, setLoaded] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [clearedAt, setClearedAt] = useState(0)
  const bottom = useRef<HTMLDivElement>(null)
  const pid = company.project?.id

  const reload = () =>
    get<{ messages: ChatMessage[] }>(`/api/chat/${agent.id}`)
      .then((r) => setLoaded(r.messages))
      .catch((e) => setErr(String(e.message ?? e)))

  useEffect(() => {
    setLoaded([])
    setErr(null)
    setClearedAt(0)
    void reload()
  }, [agent.id])

  // Cleared elsewhere (another window): start over from the server's copy.
  const lastClear = company.events.findLast((e) => e.meta?.chatCleared === agent.id && e.projectId === pid)
  useEffect(() => {
    if (!lastClear) return
    setClearedAt((c) => Math.max(c, lastClear.ts))
    void reload()
  }, [lastClear?.id])

  // History from the server, plus anything that arrived live over the event stream.
  const messages = useMemo(() => {
    const live = company.events
      .filter((e) => e.kind === 'chat' && e.agent === agent.id && e.meta?.message)
      .map((e) => e.meta!.message as ChatMessage)
      // Live copies of messages that were cleared in this project must not come back.
      .filter((m) => !(m.ts <= clearedAt && (!m.projectId || m.projectId === pid)))
    const byId = new Map<string, ChatMessage>()
    for (const m of [...loaded, ...live]) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.ts - b.ts)
  }, [loaded, company.events, agent.id, clearedAt, pid])

  const multi = company.projects.length > 1
  const projectName = (id: string) => company.projects.find((p) => p.id === id)?.name ?? id
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
      setClearedAt(r.clearedAt)
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
                  {multi && m.projectId && ` · ${projectName(m.projectId)}`}
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
