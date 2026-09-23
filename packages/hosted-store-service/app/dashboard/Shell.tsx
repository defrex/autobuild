'use client'

import type { ReactNode } from 'react'
import { Menu } from './Menu'

export interface OperatorShellProps {
  repo: string
  repositories: readonly string[]
  identity: string
  /** The last poll's wall clock, formatted; absent before the first frame. */
  clock?: string
  pending?: boolean
  error?: string
  onRepo: (repo: string) => void
  onSignOut: () => void
  /** Page-specific facts and controls placed in the shared operator landmark. */
  controls: ReactNode
  children: ReactNode
}

/**
 * The frame every operator page shares: a one-row masthead carrying the
 * repository title and the account menu; then the control line
 * with the poll clock pinned right. Pure presentation so a fixture can render
 * the same frame the operator sees.
 */
export function OperatorShell({
  repo,
  repositories,
  identity,
  clock,
  pending,
  error,
  onRepo,
  onSignOut,
  controls,
  children,
}: OperatorShellProps) {
  return (
    <main className="frame">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span>{repo || 'no repository configured'}</span>
        </h1>
        <Menu
          className="account"
          label={<span className="identity">{identity}</span>}
          items={[{ label: 'sign out', onSelect: onSignOut }]}
        />
      </header>
      <nav className="line navline" aria-label="Operator controls">
        {repositories.length > 1 && (
          <label className="repo">
            <span className="slack">repo </span>
            <span className="selectwrap repo-selectwrap">
              <select value={repo} onChange={(event) => onRepo(event.target.value)}>
                {repositories.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </span>
          </label>
        )}
        {controls}
        <span className="spacer" />
        <span className="clock" data-pending={pending ? '' : undefined}>
          <span className="sr-only">last poll </span>
          {clock ?? '--:--:--'}
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
