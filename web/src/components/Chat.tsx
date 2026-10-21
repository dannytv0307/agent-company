import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRef, ChatMessage } from '../../../shared/types.ts'
import { api, get, post } from '../api.ts'
import { useT } from '../i18n.ts'
import { hhmm, useCompanyCtx } from '../context.ts'
import { CheckIn } from './CheckIn.tsx'
import { ProposalCard } from './ProposalCard.tsx'
import { useAgentMenu, useCommandMenu } from './CommandMenu.tsx'

/** "@game-dev fix the HUD" → the agent called and the rest of the message. */
function mentionOf(text: string, team: AgentRef[]): { agent?: AgentRef; rest: string } {
  const m = text.match(/^@([\w.-]+)\s*([\s\S]*)$/)
  const agent = m ? team.find((a) => a.id.toLowerCase() === m[1].toLowerCase()) : undefined
  return agent ? { agent, rest: m![2] } : { rest: text }
}

/**
 * The one conversation of the selected project. Messages go to the organizer, or straight to one
 * of the team's agents when they start with "@agent-id"; every reply lands in this same thread.
 */
export function Chat({ lead, team, suggestions = [] }: { lead: AgentRef; team: AgentRef[]; suggestions?: string[] }) {
  const { company, setTypingCommand, setTypingAgent, prefill } = useCompanyCtx()
  const { t, l } = useT()
  const everyone = useMemo(() => [lead, ...team], [lead, team])
  const key = everyone.map((a) => a.id).join(',')
  // The server's copy of each agent's thread, and when it was asked for. Only messages newer than that
  // are taken from the event stream: older copies there may belong to a conversation that was cleared.
  const [loaded, setLoaded] = useState<{ messages: ChatMessage[]; since: number }>({ messages: [], since: Infinity })
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(key)
  const pid = company.project?.id ?? ''
  const nameOf = (id: string) => l(everyone.find((a) => a.id === id)?.name) || id

  const reload = () => {
    const k = key
    const since = Date.now()
    return Promise.all(everyone.map((a) => get<{ messages: ChatMessage[] }>(`/api/chat/${a.id}`).then((r) => r.messages.map((m) => ({ ...m, agentId: m.agentId ?? a.id })))))
      .then((all) => latest.current === k && setLoaded({ messages: all.flat(), since })) // ignore answers for a team we already left
      .catch((e) => setErr(String(e.message ?? e)))
  }

  useEffect(() => {
    latest.current = key
    setLoaded({ messages: [], since: Infinity })
    setErr(null)
    void reload()
  }, [key])

  // Cleared in another window: start over from the server's copy.
  const lastClear = company.events.findLast((e) => typeof e.meta?.chatCleared === 'string' && everyone.some((a) => a.id === e.meta!.chatCleared))
  useEffect(() => {
    if (lastClear) void reload()
  }, [lastClear?.id])

  // Everyone's messages in the selected project only: each project has its own session with each agent.
  const messages = useMemo(() => {
    const ids = new Set(everyone.map((a) => a.id))
    const live = company.events
      .filter((e) => e.kind === 'chat' && e.agent && ids.has(e.agent) && e.meta?.message)
      .map((e) => ({ ...(e.meta!.message as ChatMessage), agentId: (e.meta!.message as ChatMessage).agentId ?? e.agent! }))
      .filter((m) => m.ts >= loaded.since)
    const byId = new Map<string, ChatMessage>()
    for (const m of [...loaded.messages, ...live]) if (!m.projectId || m.projectId === pid) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) => a.ts - b.ts)
  }, [loaded, company.events, everyone, pid])

  const repoCommands = company.project?.scan?.commands ?? []
  const commands = useCommandMenu(text, setText, repoCommands)
  const mentions = useAgentMenu(text, setText, team)
  const { agent: called, rest } = mentionOf(text, team)
  // "/name …" with one of the repo's commands, and "@agent": light them up on the canvas while typing.
  const command = repoCommands.find((c) => c.name === rest.match(/^\/([\w:.-]+)/)?.[1])
  useEffect(() => {
    setTypingCommand(command?.name ?? null)
  }, [command?.name])
  useEffect(() => {
    setTypingAgent(called?.id ?? null)
  }, [called?.id])
  useEffect(
    () => () => {
      setTypingCommand(null)
      setTypingAgent(null)
    },
    [],
  )

  // "@agent " from an agent card on the canvas, or a command: put it in the box, ready for the rest.
  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    box.current?.focus()
  }, [prefill])

  // Who still owes a reply: their last message in the thread is the owner's. A note after it (delivered
  // live, put in the inbox, queued) means the answer comes another way.
  const lastByAgent = new Map<string, ChatMessage>()
  for (const m of messages) lastByAgent.set(m.agentId, m)
  const waitingOn = [...lastByAgent.values()].filter((m) => m.role === 'owner')
  // The server has nothing running for that agent here, yet no reply came: it was lost (e.g. a restart).
  const stalled = (m: ChatMessage) =>
    !company.work.some((w) => w.agentId === m.agentId && w.projectId === pid) && company.connected && company.now - m.ts > 20_000
  const retry = async (agentId: string) => {
    setErr(null)
    try {
      await post(`/api/chat/${agentId}/retry`, { projectId: company.project?.id })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, waitingOn.length])

  const clear = async () => {
    const talked = everyone.filter((a) => messages.some((m) => m.agentId === a.id))
    const where = company.projects.length > 1 ? ` (${company.project?.name})` : ''
    if (!confirm(`${t('clearConfirm').replace('{name}', talked.map((a) => l(a.name)).join(', '))}${where}`)) return
    setErr(null)
    try {
      let clearedAt = Date.now()
      for (const a of talked) clearedAt = (await api<{ clearedAt: number }>('DELETE', `/api/chat/${a.id}?project=${encodeURIComponent(pid)}`)).clearedAt
      // Drop this project's messages right away; the reload confirms what the server kept.
      setLoaded((x) => ({ messages: x.messages.filter((m) => m.projectId && m.projectId !== pid), since: clearedAt }))
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const send = async () => {
    const to = called ?? lead
    const body = (called ? rest : text).trim()
    if (!body) return
    setText('')
    setErr(null)
    // Show the message going in: to the agent called, and through the command to the agents it calls.
    const route: string[][] = []
    if (command) route.push([`entry->cmd:${command.name}`], (command.agents ?? []).map((id) => `cmd:${command.name}->${id}`))
    else if (called) route.push([`entry->${called.id}`])
    if (route.length) company.pulseRoute(route, 'var(--accent)')
    try {
      await post(`/api/chat/${to.id}`, { text: body, projectId: company.project?.id })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setText(called ? `@${called.id} ${body}` : body)
    }
  }

  return (
    <div className="chat">
      {messages.length > 0 && (
        <div className="chat-tools">
          <button className="link small danger" disabled={waitingOn.length > 0} onClick={clear} title={waitingOn.length ? t('typing') : undefined}>
            {t('clearChat')}
          </button>
        </div>
      )}
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="muted small">{t('chatEmpty')}</p>
            {suggestions.length > 0 && (
              <div className="examples">
                {suggestions.map((s) => (
                  <button key={s} className="example" onClick={() => setText(s)}>
                    {s.replace(/^[^:：]+[:：]\s*/, '')}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => {
          const cp = m.checkpointId ? company.checkpoints.find((c) => c.id === m.checkpointId) : undefined
          if (cp) return <CheckIn key={m.id} cp={cp} inChat />
          const proposal = m.proposalId ? company.proposals.find((p) => p.id === m.proposalId) : undefined
          if (proposal) return <ProposalCard key={m.id} p={proposal} inChat />
          const direct = m.agentId !== lead.id
          return m.role === 'note' ? (
            <div key={m.id} className="note-line">
              {direct && <b>{nameOf(m.agentId)} · </b>}
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`bubble-row ${m.role}${direct ? ' direct' : ''}`}>
              <div className="msg">
                {m.role === 'owner' && direct && <span className="to-tag">@{m.agentId}</span>}
                <p>{m.text}</p>
                <span className="t">
                  {m.role === 'owner' ? t('you') : nameOf(m.agentId)} · {hhmm(m.ts)}
                </span>
              </div>
            </div>
          )
        })}
        {waitingOn.map((m) =>
          stalled(m) ? (
            <div key={m.agentId} className="note-line stalled">
              {m.agentId !== lead.id && <b>{nameOf(m.agentId)} · </b>}
              {t('noReply')}{' '}
              <button className="link small" onClick={() => retry(m.agentId)}>
                {t('retry')}
              </button>
            </div>
          ) : (
            <div key={m.agentId} className="typing">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              {nameOf(m.agentId)} {t('typing')}
              {company.states[m.agentId]?.status === 'working' && company.states[m.agentId]?.bubble && (
                <em>{company.states[m.agentId].bubble!.replace(/^[^\p{L}\p{N}$]+/u, '')}</em>
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="chat-input">
        {commands.menu}
        {mentions.menu}
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={`${t('messageTo')} ${l(called?.name ?? lead.name)}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (commands.onKeyDown(e) || mentions.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button className="btn solid" disabled={!(called ? rest : text).trim()} onClick={send}>
          {t('send')}
        </button>
      </div>
      {(repoCommands.length > 0 || team.length > 0) && <div className="chat-keys">{t('chatKeys')}</div>}
    </div>
  )
}
