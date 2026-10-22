import type { ReactNode } from 'react'
import type { Agent, Step } from '../../../shared/model.ts'
import { agentOf, ago, duration, shortPath, stepOf, useFlow, type Selection } from '../context.ts'
import { displayName, groupOf, keyOf, kindLabel, scopeLabel, sorted, STATUS_TEXT, type GroupKey } from '../setup.ts'
import { send } from '../vscode.ts'

function FileActions({ file, writes }: { file: string; writes?: boolean }) {
  return (
    <div className="actions-row">
      <button className="btn" onClick={() => send({ type: 'open', path: file })}>
        Open file
      </button>
      {writes && (
        <button className="btn" onClick={() => send({ type: 'diff', path: file })}>
          Open change
        </button>
      )}
    </div>
  )
}

function StepDetails({ step, agent }: { step: Step; agent: Agent }) {
  const { view, now } = useFlow()
  return (
    <>
      <h2>
        {step.tool} <span className="muted">{step.label}</span>
      </h2>
      <div className={`status-line st-${step.status}`}>
        <span className="dot" />
        {step.status === 'running' ? 'Running' : step.status === 'error' ? 'Failed' : 'Done'} · {duration((step.end ?? now) - step.start)} · by{' '}
        {agent.kind === 'main' ? 'Claude' : agent.type}
      </div>
      {step.file && <FileActions file={step.file} writes={step.writes} />}
      {step.file && <p className="muted small">{shortPath(step.file, view.cwd)}</p>}
      <h3>Input</h3>
      <pre className="code">{step.input ?? '—'}</pre>
      <h3>Result</h3>
      <pre className="code">{step.output ?? (step.status === 'running' ? 'Still running…' : '—')}</pre>
    </>
  )
}

function AgentDetails({ a }: { a: Agent }) {
  const { view, now, select } = useFlow()
  const main = a.kind === 'main'
  return (
    <>
      <h2>{main ? 'Claude' : a.type}</h2>
      <div className={`status-line st-${a.status}`}>
        <span className="dot" />
        {a.status === 'running' && (!main || view.status === 'working') ? 'Working' : a.status === 'error' ? 'Stopped' : 'Done'} ·{' '}
        {duration((a.end ?? now) - a.start)}
        {a.model ? ` · ${a.model}` : ''}
      </div>
      {!main && a.title && <p className="lead">{a.title}</p>}
      {a.prompt && (
        <>
          <h3>{main ? 'Prompt' : 'Asked to'}</h3>
          <pre className="code">{a.prompt}</pre>
        </>
      )}
      {a.said && !a.output && (
        <>
          <h3>Latest words</h3>
          <pre className="code">{a.said}</pre>
        </>
      )}
      {a.output && (
        <>
          <h3>{main ? 'Reply' : 'Report'}</h3>
          <pre className="code">{a.output}</pre>
        </>
      )}
      <h3>Tools · {a.steps.length}</h3>
      {a.steps.length ? (
        <ol className="step-list">
          {[...a.steps].reverse().map((s) => (
            <li key={s.id} className={`st-${s.status}`}>
              <button onClick={() => select({ kind: 'step', id: s.id })}>
                <b>{s.tool}</b> <span>{s.label}</span>
                <em>{s.status === 'error' ? '✗' : s.status === 'done' ? duration((s.end ?? s.start) - s.start) : '…'}</em>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No tool calls yet.</p>
      )}
    </>
  )
}

/** What an agent handed back: its reply or report, and the files it wrote — nothing about how. */
function OutputDetails({ a }: { a: Agent }) {
  const { view } = useFlow()
  const main = a.kind === 'main'
  const files = view.files.filter((f) => f.writes > 0 && f.by.includes(a.id)).sort((x, y) => y.last - x.last)
  return (
    <>
      <h2>{main ? 'Reply' : `${a.type} report`}</h2>
      <div className={`status-line st-${a.status}`}>
        <span className="dot" />
        {a.status === 'error' ? 'Stopped' : 'Done'}
        {a.end ? ` · ${ago(a.end)}` : ''}
      </div>
      {!main && a.title && <p className="lead">{a.title}</p>}
      <pre className="code reply">{a.output ?? '—'}</pre>
      {files.length > 0 && (
        <>
          <h3>Files changed · {files.length}</h3>
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.path}>
                <button className="file-link" onClick={() => send({ type: 'diff', path: f.path })} title="Open the change">
                  {shortPath(f.path, view.cwd)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/** The flow node a setup item is used by, as a selection. */
function selectionFor(node: string): Selection | null {
  if (node === 'command') return { kind: 'prompt' }
  if (node.startsWith('agent:')) return { kind: 'agent', id: node.slice(6) }
  return null
}

const SCOPES = 'project: this folder’s .claude/ (in git) · local: this folder, not in git · user: ~/.claude, every folder'

function SetupDetails({ group, item }: { group: GroupKey; item?: string }) {
  const { setup, view, select } = useFlow()
  const g = groupOf(group)
  const items = sorted(setup, group)
  const it = item ? items.find((i) => keyOf(i) === item) : undefined
  const usesOf = (key: string) => setup.uses.get(key) ?? []

  if (it) {
    const uses = usesOf(keyOf(it))
    const live = uses.some((u) => u.live)
    return (
      <>
        <button className="crumb" onClick={() => select({ kind: 'setup', group })}>
          ← {g.title}
        </button>
        <h2>{displayName(it)}</h2>
        <div className={`status-line${live ? ' st-running' : uses.length ? ' st-done' : it.status === 'failed' ? ' st-error' : it.unloaded || it.status === 'needs-auth' ? ' st-warn' : ''}`}>
          <span className="dot" />
          {it.unloaded
            ? 'Not loaded'
            : live
              ? 'In use now'
              : uses.length
                ? group === 'memory'
                  ? 'Loaded'
                  : 'Used this turn'
                : it.loaded
                  ? 'Loaded, not used this turn'
                  : 'Not used this turn'}
          <span className={`scope sc-${it.scope}`}>{scopeLabel(it)}</span>
        </div>
        {it.unloaded && <p className="notice">{it.unloaded}</p>}
        {it.status && (
          <p className={`notice ms-${it.status}`}>
            <b>{STATUS_TEXT[it.status]}</b>
            {it.error ? ` — ${it.error}` : it.status === 'needs-auth' ? ' — sign in with /mcp in Claude Code.' : ''}
          </p>
        )}
        {it.description && <p className="lead">{it.description}</p>}
        {!!it.facts?.length && (
          <ul className="fact-list">
            {it.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        {it.path && (
          <>
            <div className="actions-row">
              <button className="btn" onClick={() => send({ type: 'open', path: it.path! })}>
                Open file
              </button>
            </div>
            <p className="muted small">{shortPath(it.path, view.cwd)}</p>
          </>
        )}
        {uses.length > 0 && group !== 'memory' && (
          <>
            <h3>Used by</h3>
            <ul className="use-list">
              {uses.map((u) => {
                const to = selectionFor(u.node)
                return (
                  <li key={u.node + u.why} className={u.live ? 'live' : ''}>
                    <button disabled={!to} onClick={() => to && select(to)}>
                      {u.why}
                    </button>
                    {u.live && <em>live</em>}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </>
    )
  }

  const used = items.filter((i) => usesOf(keyOf(i)).length).length
  return (
    <>
      <h2>{g.title}</h2>
      <div className="status-line">
        {items.length} {items.length === 1 ? 'item' : 'items'}
        {group !== 'memory' && ` · ${used} used this turn`}
      </div>
      {group === 'found' ? (
        <p className="notice">
          Claude Code configuration that sits in this folder, but that Claude Code does not load from here. Each item says why, and what would load it.
        </p>
      ) : (
        <p className="muted small">
          {SCOPES}
          {setup.source === 'session' ? ' · checked against what this session loaded' : ' · read from files: no session to check against yet'}
        </p>
      )}
      {items.length === 0 && <p className="lead">{g.hint}</p>}
      <ul className="setup-list">
        {items.map((i) => {
          const u = usesOf(keyOf(i))
          return (
            <li key={keyOf(i)} className={`${u.some((x) => x.live) ? 'live' : u.length ? 'used' : ''}${i.status ? ` ms-${i.status}` : ''}`}>
              <button onClick={() => select({ kind: 'setup', group, item: keyOf(i) })}>
                <span className="setup-line">
                  <i />
                  <b>{displayName(i)}</b>
                  <span className={`scope sc-${group === 'found' ? 'found' : i.scope}`}>{group === 'found' ? kindLabel(i) : scopeLabel(i)}</span>
                </span>
                {(i.status && i.status !== 'connected' ? `${STATUS_TEXT[i.status]}${i.error ? `: ${i.error}` : ''}` : i.description) && (
                  <small>{i.status && i.status !== 'connected' ? `${STATUS_TEXT[i.status]}${i.error ? `: ${i.error}` : ''}` : i.description}</small>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** The right-hand panel: everything about what was clicked. */
export function Inspector() {
  const { view, selected, select } = useFlow()
  if (!selected) return null
  let body: ReactNode = null
  if (selected.kind === 'prompt') {
    const t = view.turn
    body = (
      <>
        <h2>Your prompt</h2>
        {t && <div className="status-line">{ago(t.start)} · turn {view.turns}</div>}
        {t?.command && (
          <p className="lead">
            Ran <code>/{t.command.name}</code>
          </p>
        )}
        <pre className="code">{t?.prompt ?? '—'}</pre>
      </>
    )
  } else if (selected.kind === 'agent') {
    const a = agentOf(view, selected.id)
    body = a ? <AgentDetails a={a} /> : null
  } else if (selected.kind === 'output') {
    const a = agentOf(view, selected.of)
    body = a ? <OutputDetails a={a} /> : null
  } else if (selected.kind === 'step') {
    const hit = stepOf(view, selected.id)
    body = hit ? <StepDetails step={hit.step} agent={hit.agent} /> : null
  } else if (selected.kind === 'setup') {
    body = <SetupDetails group={selected.group} item={selected.item} />
  } else if (selected.kind === 'files') {
    const files = view.files.filter((f) => f.writes > 0).sort((a, b) => b.last - a.last)
    body = (
      <>
        <h2>Files changed</h2>
        <div className="status-line">
          {files.length} file{files.length === 1 ? '' : 's'} this turn
        </div>
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path}>
              <button className="file-link" onClick={() => send({ type: 'diff', path: f.path })} title="Open the change">
                {shortPath(f.path, view.cwd)}
              </button>
              <span className="muted small">
                ×{f.writes} by {f.by.map((id) => (id === 'main' ? 'Claude' : (agentOf(view, id)?.type ?? id))).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </>
    )
  }
  if (!body) return null
  return (
    <aside className="inspector">
      <button className="close" onClick={() => select(null)} aria-label="Close">
        ×
      </button>
      <div className="inspector-body">{body}</div>
    </aside>
  )
}
