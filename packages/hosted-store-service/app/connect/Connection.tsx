'use client'

import { useRef, useState } from 'react'
import type { ConnectionOutcome } from '@defrex/autobuild/connection'

export interface ApprovalView extends ConnectionOutcome {
  code: string
}
export function ConnectionView({
  code,
  connection,
  pending = false,
  error,
  onCode,
  onLookup,
  onDecision,
}: {
  code: string
  connection?: ApprovalView
  pending?: boolean
  error?: string
  onCode?: (value: string) => void
  onLookup?: () => void
  onDecision?: (approve: boolean) => void
}) {
  return (
    <main className="frame signin">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span>Autobuild operator</span>
        </h1>
      </header>
      <div className="signin-centre">
        <section className="card" aria-labelledby="connect-title">
          <h2 id="connect-title">Connect project</h2>
          {connection ? (
            <>
              <p>
                Repository: <strong>{connection.repo}</strong>
              </p>
              <p>
                Connection code: <code>{connection.code}</code>
              </p>
              {connection.status === 'pending' ? (
                <>
                  <p>
                    Approve durable project access for the CLI that displays this code. It can read
                    and manage this project's builds and tickets.
                  </p>
                  <p>
                    Approve only if you started this connection and the repository and code match
                    your CLI.
                  </p>
                  <div className="providers">
                    <button
                      className="btn"
                      type="button"
                      disabled={pending}
                      onClick={() => onDecision?.(true)}
                    >
                      <span>{pending ? 'Submitting...' : 'Approve project'}</span>
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={pending}
                      onClick={() => onDecision?.(false)}
                    >
                      <span>Deny</span>
                    </button>
                  </div>
                </>
              ) : (
                <p
                  className={connection.status === 'approved' ? 'ok notice' : 'warn notice'}
                  role="status"
                >
                  Connection {connection.status}.{' '}
                  {connection.status === 'approved'
                    ? 'Return to the CLI to finish connecting.'
                    : 'Start ab connect again to request access.'}
                </p>
              )}
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                onLookup?.()
              }}
            >
              <p>Enter the connection code shown by ab connect.</p>
              <label htmlFor="connection-code">Connection code</label>
              <input
                id="connection-code"
                value={code}
                onChange={(event) => onCode?.(event.target.value)}
                autoComplete="off"
                maxLength={10}
                required
              />
              <button className="btn" disabled={pending} type="submit">
                <span>{pending ? 'Checking...' : 'Review project'}</span>
              </button>
            </form>
          )}
          {error && (
            <p className="alert notice" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
export function Connection({ initialCode = '' }: { initialCode?: string }) {
  const [code, setCode] = useState(initialCode)
  const [connection, setConnection] = useState<ApprovalView>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const busy = useRef(false)
  async function send(action: 'lookup' | 'decide', approve?: boolean) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError(undefined)
    try {
      const response = await fetch(`/connect/v1/browser/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: connection?.code ?? code,
          ...(approve === undefined ? {} : { approve }),
        }),
      })
      if (response.status === 401) {
        window.location.assign(
          `/sign-in?returnTo=${encodeURIComponent(`/connect?code=${encodeURIComponent(code)}`)}`,
        )
        return
      }
      const body = (await response.json()) as { connection?: ApprovalView; error?: string }
      if (!response.ok)
        throw new Error(body.error || 'Could not confirm the connection. Try again.')
      if (!body.connection) throw new Error('Unknown connection code. Check the code in your CLI.')
      setConnection(body.connection)
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Connection service unavailable. Try again.',
      )
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <ConnectionView
      code={code}
      connection={connection}
      pending={pending}
      error={error}
      onCode={setCode}
      onLookup={() => void send('lookup')}
      onDecision={(approve) => void send('decide', approve)}
    />
  )
}
