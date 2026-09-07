'use client'

import type { ReactNode } from 'react'
import type { Imperative } from './imperative'

export type Surface = 'builds' | 'tickets'

export interface OperatorShellProps {
  repo: string
  repositories: readonly string[]
  identity: string
  surface: Surface
  /** The one word the header carries, or nothing when nothing needs a human. */
  imperative?: Imperative
  /** The last poll's wall clock, formatted; absent before the first frame. */
  clock?: string
  pending?: boolean
  error?: string
  onSurface: (surface: Surface) => void
  onRepo: (repo: string) => void
  onSignOut: () => void
  children: ReactNode
}

/**
 * The frame every operator page shares: a double-height masthead carrying
 * the repository, one imperative, and the poll clock; then the surface line.
 * Pure presentation so a fixture can render the same frame the operator sees.
 */
export function OperatorShell({
  repo,
  repositories,
  identity,
  surface,
  imperative,
  clock,
  pending,
  error,
  onSurface,
  onRepo,
  onSignOut,
  children,
}: OperatorShellProps) {
  return (
    <main className="frame">
      <header className="masthead">
        <h1 className="dh title">
          <span>{repo || 'no repository configured'}</span>
        </h1>
        <p className="dh imperative" data-tone={imperative?.tone} aria-live="polite" aria-atomic>
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
      <nav className="line navline" aria-label="Operator surface">
        <button
          type="button"
          className="tab"
          aria-pressed={surface === 'builds'}
          onClick={() => onSurface('builds')}
        >
          BUILDS
        </button>
        <button
          type="button"
          className="tab"
          aria-pressed={surface === 'tickets'}
          onClick={() => onSurface('tickets')}
        >
          TICKETS
        </button>
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
        <span className="spacer" />
        <span className="identity">
          <span>{identity}</span>
          <button type="button" className="word" onClick={onSignOut}>
            sign out
          </button>
        </span>
      </nav>
      {error && (
        <p className="alert notice" role="alert">
          {error}
        </p>
      )}
      {children}
    </main>
  )
}
