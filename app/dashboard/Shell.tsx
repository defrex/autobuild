'use client'

import type { ReactNode } from 'react'
import type { Imperative } from './imperative'

export interface OperatorShellProps {
  repo: string
  repositories: readonly string[]
  identity: string
  /** The one word the header carries, or nothing when nothing needs a human. */
  imperative?: Imperative
  /** The last poll's wall clock, formatted; absent before the first frame. */
  clock?: string
  pending?: boolean
  error?: string
  onRepo: (repo: string) => void
  onSignOut: () => void
  children: ReactNode
}

/**
 * The frame every operator page shares: a one-row masthead carrying the
 * repository, one imperative, and the poll clock; then the control line.
 * Pure presentation so a fixture can render the same frame the operator sees.
 */
export function OperatorShell({
  repo,
  repositories,
  identity,
  imperative,
  clock,
  pending,
  error,
  onRepo,
  onSignOut,
  children,
}: OperatorShellProps) {
  return (
    <main className="frame">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span>{repo || 'no repository configured'}</span>
        </h1>
        <p
          className="masthead-copy imperative"
          data-tone={imperative?.tone}
          aria-live="polite"
          aria-atomic
        >
          {imperative && (
            <span>
              {imperative.word}
              {imperative.count > 1 ? ` ×${imperative.count}` : ''}
            </span>
          )}
        </p>
        <span className="clock" data-pending={pending ? '' : undefined}>
          <span className="sr-only">last poll </span>
          {clock ?? '--:--:--'}
        </span>
      </header>
      <nav className="line navline" aria-label="Operator controls">
        {repositories.length > 1 && (
          <label className="repo">
            <span className="slack">repo </span>
            <span className="selectwrap">
              <select value={repo} onChange={(event) => onRepo(event.target.value)}>
                {repositories.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </span>
          </label>
        )}
        <span className="spacer" />
        <span className="identity">
          <span>{identity}</span>
          <button type="button" className="word" onClick={onSignOut}>
            sign out
          </button>
        </span>
      </nav>
      <div className="shell-body">
        {error && (
          <p className="alert notice shell-notice" role="alert">
            {error}
          </p>
        )}
        {children}
      </div>
    </main>
  )
}
