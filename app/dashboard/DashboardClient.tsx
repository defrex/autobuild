'use client'

import type { OperatorAnswerRequest, OperatorDashboardSnapshot } from 'autobuild/operator-api'
import {
  buildActionAvailability,
  parseTranscript,
  repositoryActionAvailability,
  type DashboardBuild,
  type TranscriptPresentation,
} from 'autobuild/operator-presentation'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { formatElapsed, reconcileDashboard } from './view-model'

const glyph = { done: '✓', current: '▶', provisional: '!', pending: '·' } as const

function Transcript({ value }: { value: TranscriptPresentation }) {
  if (value.kind === 'raw') return <pre>{value.text}</pre>
  return (
    <div className="transcript">
      {'notice' in value && <p>{value.notice}</p>}
      {value.turns.map((turn, index) => (
        <article key={`${turn.prompt}-${turn.text}`}>
          <h4>Turn {index + 1}</h4>
          <p>
            <strong>Prompt:</strong> {turn.prompt}
          </p>
          <pre>{turn.text}</pre>
          {turn.failure && <p className="error">Failure: {turn.failure}</p>}
          {turn.usage && (
            <p>
              Usage: {turn.usage.inputTokens} input · {turn.usage.outputTokens} output
              {turn.usage.turns ? ` · ${turn.usage.turns} turns` : ''}
            </p>
          )}
        </article>
      ))}
    </div>
  )
}

function StepList({ build, now }: { build: DashboardBuild; now: number }) {
  return (
    <ol className="steps" aria-label={`${build.slug} pipeline`}>
      {build.steps.map((step) => (
        <li key={step.label} data-state={step.state}>
          <span aria-hidden>{glyph[step.state]}</span> <span>{step.label}</span>
          {step.qualifier && <small> ({step.qualifier})</small>}
          {step.count && step.count > 1 ? <small> /{step.count}</small> : null}
          {step.timing && <time> {formatElapsed(step.timing, now)}</time>}
          <span className="sr-only"> {step.state}</span>
        </li>
      ))}
    </ol>
  )
}

interface ClientProps {
  identity: string
  repositories: readonly string[]
}
export function DashboardClient({ identity, repositories }: ClientProps) {
  const [repo, setRepo] = useState(repositories[0] ?? '')
  const [snapshot, setSnapshot] = useState<OperatorDashboardSnapshot>()
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [transcript, setTranscript] = useState<TranscriptPresentation>()
  const sequence = useRef(0)

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      if (!repo) return
      const current = ++sequence.current
      try {
        const next = await api.dashboard(repo, signal)
        if (current !== sequence.current) return
        setSnapshot((old) => ({ ...next, model: reconcileDashboard(old?.model, next.model) }))
        setError(undefined)
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [repo],
  )

  useEffect(() => {
    setSnapshot(undefined)
    setSelected(undefined)
    setTranscript(undefined)
    const controller = new AbortController()
    void poll(controller.signal)
    const timer = window.setInterval(() => void poll(controller.signal), 2000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [poll])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const act = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key)
    setError(undefined)
    try {
      await operation()
      await poll()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      await poll()
    } finally {
      setPending(undefined)
    }
  }
  const model = snapshot?.model
  const build = model?.builds.find((row) => row.slug === selected)
  const repoActions = model ? repositoryActionAvailability(model) : undefined

  const loadTranscript = async (row: DashboardBuild, kind: string, rev: number) => {
    setPending(`transcript:${row.slug}`)
    try {
      const response = await fetch(
        `/api/web/repos/${encodeURIComponent(repo)}/builds/${encodeURIComponent(row.slug)}/artifacts/${encodeURIComponent(kind)}?rev=${rev}`,
        { cache: 'no-store' },
      )
      if (response.status === 401) return window.location.assign('/sign-in')
      if (!response.ok) throw new Error(`transcript unavailable (${response.status})`)
      setTranscript(parseTranscript(await response.text()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(undefined)
    }
  }

  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">Autobuild operator</p>
          <h1>{repo || 'No repository configured'}</h1>
        </div>
        <div className="identity">
          <span>{identity}</span>
          <button
            type="button"
            onClick={async () => {
              await fetch('/api/auth/sign-out', { method: 'POST' })
              window.location.assign('/sign-in')
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <nav aria-label="Repository">
        <label>
          Repository{' '}
          <select value={repo} onChange={(event) => setRepo(event.target.value)}>
            {repositories.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </nav>
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      {!model ? (
        <p aria-live="polite">Loading dashboard…</p>
      ) : (
        <>
          <section className="statusbar" aria-label="Dispatcher settings">
            <strong>
              active {model.active.current}/{model.active.limit}
            </strong>
            <span>queued {model.queued}</span>
            <span>
              unclaimed observations {model.observations.current}/{model.observations.limit}
            </span>
            <button
              type="button"
              disabled={!!pending}
              onClick={() => act('intake', () => api.setting(repo, 'intake', model.drained))}
            >
              intake {model.drained ? 'OFF' : 'ON'}
            </button>
            <button
              type="button"
              disabled={!!pending}
              onClick={() =>
                act('default-merge', () =>
                  api.setting(repo, 'auto-merge-default', !model.defaultAutoMerge),
                )
              }
            >
              auto merge {model.defaultAutoMerge ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              disabled={!!pending}
              onClick={() =>
                act('harvest-toggle', () => api.harvest(repo, { action: 'toggle-gate' }))
              }
            >
              harvest {model.harvestPaused ? 'OFF' : 'ON'}
            </button>
            <button
              type="button"
              disabled={!!pending || !repoActions?.bulkPause}
              onClick={() => act('bulk-pause', () => api.bulk(repo, 'pause'))}
            >
              Pause all
            </button>
            <button
              type="button"
              disabled={!!pending || !repoActions?.bulkResume}
              onClick={() => act('bulk-resume', () => api.bulk(repo, 'resume'))}
            >
              Resume all
            </button>
          </section>
          {model.warningLines?.map((line) => (
            <p className="warning" key={line}>
              {line}
            </p>
          ))}
          <section className="tableRegion" aria-label="Build pipelines">
            <table>
              <thead>
                <tr>
                  <th>Build</th>
                  <th>Status</th>
                  <th>Pipeline</th>
                  <th>Pull request</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {model.builds.map((row) => {
                  const available = buildActionAvailability(row)
                  return (
                    <tr key={row.slug} className={selected === row.slug ? 'selected' : ''}>
                      <th scope="row">
                        <button
                          type="button"
                          className="linkButton"
                          onClick={() => {
                            setSelected(row.slug)
                            setTranscript(undefined)
                          }}
                        >
                          {row.ticketId ? `${row.ticketId} · ` : ''}
                          {row.slug}
                        </button>
                        {row.dispatch && <small>{row.dispatch}</small>}
                        {row.setupError && <small className="error">{row.setupError}</small>}
                      </th>
                      <td>
                        <strong>{row.status.toUpperCase()}</strong>
                        {row.alsoPaused && <small>also paused</small>}
                        {row.abortProgress && <small>{row.abortProgress}</small>}
                      </td>
                      <td>
                        <StepList build={row} now={now} />
                      </td>
                      <td>
                        {row.pr ? <a href={row.pr.url}>{row.pr.state}</a> : '—'}
                        <small>auto merge {row.autoMerge}</small>
                      </td>
                      <td>
                        <div className="controls">
                          {available.primary && (
                            <button
                              type="button"
                              disabled={!!pending}
                              onClick={() =>
                                act(`${row.slug}:primary`, () =>
                                  api.buildControl(repo, row.slug, { action: available.primary! }),
                                )
                              }
                            >
                              {available.primary}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={!!pending || !available.autoMerge}
                            onClick={() =>
                              act(`${row.slug}:merge`, () =>
                                api.buildControl(repo, row.slug, {
                                  action:
                                    row.autoMerge === 'off' ? 'auto-merge-on' : 'auto-merge-off',
                                }),
                              )
                            }
                          >
                            {row.autoMerge === 'off' ? 'Enable' : 'Disable'} auto merge
                          </button>
                          {available.discard && (
                            <button
                              type="button"
                              disabled={!!pending}
                              onClick={() =>
                                act(`${row.slug}:discard`, () =>
                                  api.buildControl(repo, row.slug, { action: 'discard' }),
                                )
                              }
                            >
                              Discard
                            </button>
                          )}
                          <button
                            type="button"
                            className="danger"
                            disabled={!!pending || !available.abort}
                            onClick={() => {
                              if (window.confirm(`Abort ${row.slug}?`))
                                void act(`${row.slug}:abort`, () =>
                                  api.buildControl(repo, row.slug, { action: 'abort' }),
                                )
                            }}
                          >
                            Abort
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {model.harvest && (
                  <tr>
                    <th scope="row">
                      <button type="button" className="linkButton">
                        Harvest · {model.harvest.run}
                      </button>
                    </th>
                    <td>
                      <strong>{model.harvest.status.toUpperCase()}</strong>
                      <small>
                        {model.harvest.observations} observations · {model.harvest.rounds} rounds
                      </small>
                    </td>
                    <td>
                      <ol className="steps">
                        {model.harvest.steps.map((step) => (
                          <li key={step.label}>
                            {glyph[step.state]} {step.label} {formatElapsed(step.timing, now)}
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td>—</td>
                    <td>
                      <button
                        type="button"
                        disabled={!!pending || !model.harvest.action}
                        onClick={() =>
                          act('harvest-run', () =>
                            api.harvest(repo, { action: 'run', run: model.harvest!.run }),
                          )
                        }
                      >
                        {model.harvest.action ?? 'Running'}
                      </button>
                    </td>
                  </tr>
                )}
                {!model.harvest && (
                  <tr>
                    <th scope="row">Harvest</th>
                    <td>{model.harvestPaused ? 'PAUSED' : 'IDLE'}</td>
                    <td>—</td>
                    <td>—</td>
                    <td>
                      <button
                        type="button"
                        disabled={!!pending || model.harvestPaused}
                        onClick={() =>
                          act('harvest-run', () =>
                            api.harvest(repo, { action: 'run', run: crypto.randomUUID() }),
                          )
                        }
                      >
                        Run harvest
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          {build && (
            <BuildDetail
              build={build}
              transcript={transcript}
              pending={pending}
              onTranscript={loadTranscript}
              onAnswer={(body) =>
                act(`${build.slug}:answer`, () => api.answerBuild(repo, build.slug, body))
              }
              onClose={() => {
                setSelected(undefined)
                setTranscript(undefined)
              }}
            />
          )}
        </>
      )}
    </main>
  )
}

type AnswerChoice = OperatorAnswerRequest['resolution'] | 'revise-spec-ticket'

function BuildDetail({
  build,
  transcript,
  pending,
  onTranscript,
  onAnswer,
  onClose,
}: {
  build: DashboardBuild
  transcript?: TranscriptPresentation
  pending?: string
  onTranscript: (build: DashboardBuild, kind: string, rev: number) => void
  onAnswer: (body: OperatorAnswerRequest) => void
  onClose: () => void
}) {
  const [resolution, setResolution] = useState<AnswerChoice>('guidance')
  const [text, setText] = useState('')
  const [ceiling, setCeiling] = useState(1)
  const submit = () => {
    const body: OperatorAnswerRequest =
      resolution === 'guidance'
        ? { resolution, text }
        : resolution === 'retry'
          ? { resolution }
          : resolution === 'dismiss'
            ? { resolution, ...(text ? { text } : {}) }
            : resolution === 'review-round-ceiling'
              ? { resolution, ceiling, ...(text ? { text } : {}) }
              : {
                  resolution: 'revise-spec',
                  origin: resolution === 'revise-spec-ticket' ? 'ticket' : 'body',
                  body: text,
                }
    onAnswer(body)
  }
  return (
    <aside className="detail" aria-labelledby="detail-title">
      <div className="detailHead">
        <h2 id="detail-title">Build detail · {build.slug}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p>
        <strong>Status:</strong> {build.status}
        {build.alsoPaused ? ' (also paused)' : ''}
      </p>
      {build.reviewRoundCeilings && (
        <p>
          Review ceilings: plan {build.reviewRoundCeilings.plan ?? 'default'}, code{' '}
          {build.reviewRoundCeilings.code ?? 'default'}
        </p>
      )}
      <StepList build={build} now={Date.now()} />
      {build.blockers.length > 0 && (
        <section>
          <h3>Escalations</h3>
          {build.blockers.map((item) => (
            <pre key={item}>{item}</pre>
          ))}
          <label>
            Resolution{' '}
            <select
              value={resolution}
              onChange={(event) => setResolution(event.target.value as typeof resolution)}
            >
              <option value="guidance">Guidance</option>
              <option value="retry">Retry</option>
              <option value="dismiss">Dismiss</option>
              <option value="review-round-ceiling">Review ceiling</option>
              <option value="revise-spec">Supply revised spec</option>
              <option value="revise-spec-ticket">Use amended ticket body</option>
            </select>
          </label>
          {resolution === 'review-round-ceiling' && (
            <label>
              Ceiling{' '}
              <input
                type="number"
                min="1"
                value={ceiling}
                onChange={(event) => setCeiling(event.target.valueAsNumber)}
              />
            </label>
          )}
          {resolution !== 'retry' && (
            <label>
              {resolution === 'revise-spec' || resolution === 'revise-spec-ticket'
                ? 'Revised body'
                : 'Message'}
              <textarea value={text} onChange={(event) => setText(event.target.value)} />
            </label>
          )}
          <button
            type="button"
            disabled={!!pending || (resolution === 'guidance' && !text.trim())}
            onClick={submit}
          >
            Answer escalation
          </button>
        </section>
      )}
      <section>
        <h3>Sessions and transcripts</h3>
        {build.sessions?.length ? (
          <ul>
            {build.sessions.map((session) => (
              <li key={session.id}>
                <strong>{session.role}</strong> · {session.phase}
                {session.round ? ` /${session.round}` : ''} · {session.runtime}
                {session.model ? ` ${session.model}` : ''} · {session.status}
                {session.usage &&
                  ` · ${session.usage.inputTokens} in / ${session.usage.outputTokens} out / ${session.usage.turns} turns`}{' '}
                {session.transcript && (
                  <button
                    type="button"
                    disabled={!!pending}
                    onClick={() =>
                      onTranscript(build, session.transcript!.kind, session.transcript!.rev)
                    }
                  >
                    Open transcript
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No sessions recorded.</p>
        )}
        {transcript && <Transcript value={transcript} />}
      </section>
    </aside>
  )
}
