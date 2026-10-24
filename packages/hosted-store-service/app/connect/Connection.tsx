'use client'

import { useRef, useState } from 'react'
import type { ConnectionOutcome } from '@defrex/autobuild/connection'

export interface ApprovalView extends ConnectionOutcome {
  code: string
}
export interface ApprovalAssignment {
  assignment: 'new' | 'fixed'
  organizations: { id: string; name: string; membershipRole: 'owner' | 'member' | null }[]
}
export function approvalOrganization(
  context?: ApprovalAssignment,
  selected?: string,
): string | undefined {
  if (context?.assignment !== 'new') return undefined
  if (context.organizations.length === 1)
    return context.organizations[0]!.membershipRole === null
      ? context.organizations[0]!.id
      : undefined
  return context.organizations.find((org) => org.id === selected)?.id
}
export function approvalBlocked(context?: ApprovalAssignment, selected?: string): boolean {
  return (
    context?.assignment === 'new' &&
    (context.organizations.length === 0 ||
      (context.organizations.length > 1 && !approvalOrganization(context, selected)))
  )
}
export function ConnectionView({
  code,
  connection,
  pending = false,
  error,
  context,
  selectedOrganization,
  onOrganization,
  onCode,
  onLookup,
  onDecision,
}: {
  code: string
  context?: ApprovalAssignment
  selectedOrganization?: string
  onOrganization?: (id: string) => void
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
              <p className="connection-code">
                <span className="sr-only">Connection code: </span>
                <code>{connection.code}</code>
              </p>
              <p>
                Repository: <strong className="project">{connection.repo}</strong>
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
                  {context?.assignment === 'new' && context.organizations.length > 1 && (
                    <fieldset className="connection-organizations">
                      <legend>Add it to an organization</legend>
                      <p className="slack">
                        Everyone in the organization you pick can reach this project.
                      </p>
                      {context.organizations.map((org) => (
                        <label key={org.id}>
                          <input
                            type="radio"
                            name="organization"
                            value={org.id}
                            checked={selectedOrganization === org.id}
                            disabled={pending}
                            onChange={() => onOrganization?.(org.id)}
                          />
                          {org.name}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {context?.assignment === 'new' && !context.organizations.length && (
                    <p className="warn">
                      No organization is available. A super user must create an organization before
                      this project can be approved.
                    </p>
                  )}
                  <div className="providers">
                    <button
                      className="btn primary"
                      type="button"
                      disabled={pending || approvalBlocked(context, selectedOrganization)}
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
  const [context, setContext] = useState<ApprovalAssignment>()
  const [selectedOrganization, setSelectedOrganization] = useState<string>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const busy = useRef(false)
  async function send(action: 'lookup' | 'decide', approve?: boolean) {
    if (busy.current || (approve && approvalBlocked(context, selectedOrganization))) return
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
          ...(approve && approvalOrganization(context, selectedOrganization)
            ? { organizationId: approvalOrganization(context, selectedOrganization) }
            : {}),
        }),
      })
      if (response.status === 401) {
        window.location.assign(
          `/sign-in?returnTo=${encodeURIComponent(`/connect?code=${encodeURIComponent(code)}`)}`,
        )
        return
      }
      const body = (await response.json()) as Partial<ApprovalAssignment> & {
        connection?: ApprovalView
        error?: string
      }
      if (!response.ok)
        throw new Error(body.error || 'Could not confirm the connection. Try again.')
      if (!body.connection) throw new Error('Unknown connection code. Check the code in your CLI.')
      setConnection(body.connection)
      if (action === 'lookup') {
        setContext(
          body.assignment
            ? { assignment: body.assignment, organizations: body.organizations ?? [] }
            : undefined,
        )
        setSelectedOrganization(undefined)
      }
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
      context={context}
      selectedOrganization={selectedOrganization}
      onOrganization={setSelectedOrganization}
      onCode={(value) => {
        setCode(value)
        setContext(undefined)
        setSelectedOrganization(undefined)
        setConnection(undefined)
      }}
      onLookup={() => void send('lookup')}
      onDecision={(approve) => void send('decide', approve)}
    />
  )
}
