'use client'

import type { ReactNode } from 'react'
import { AccountMenu } from '../access/AccountMenu'
import { useMenuDisclosure } from './Menu'

export interface OperatorShellProps {
  repo: string
  repositories: readonly string[]
  identity: string
  isSuperUser?: boolean
  /** Initial account-menu disclosure for offline presentation fixtures. */
  menuOpen?: boolean
  /** Initial project-picker disclosure for offline presentation fixtures. */
  projectMenuOpen?: boolean
  error?: string
  onRepo: (repo: string) => void
  onSignOut: () => void
  /** The view tabs, leading the line under the masthead. */
  tabs?: ReactNode
  /** Repository settings and controls, right-aligned after the tabs. */
  controls: ReactNode
  children: ReactNode
}

/**
 * The frame every operator page shares: a one-row masthead carrying the
 * project picker and the account menu; then one line with the view tabs on
 * the left and the repository controls on the right. Pure presentation so a
 * fixture can render the same frame the operator sees.
 */
export function OperatorShell({
  repo,
  repositories,
  identity,
  isSuperUser,
  menuOpen,
  projectMenuOpen,
  error,
  onRepo,
  onSignOut,
  tabs,
  controls,
  children,
}: OperatorShellProps) {
  return (
    <main className="frame">
      <header className="masthead">
        <h1 className="masthead-copy title">
          <span className="brand">Autobuild</span>{' '}
          <ProjectMenu
            repo={repo}
            repositories={repositories}
            initiallyOpen={projectMenuOpen}
            onRepo={onRepo}
          />
        </h1>
        <AccountMenu
          identity={identity}
          isSuperUser={isSuperUser}
          menuOpen={menuOpen}
          onSignOut={onSignOut}
        />
      </header>
      <div className="line navline">
        {tabs}
        <span className="spacer" />
        <fieldset className="controls-line" aria-label="Operator controls">
          {controls}
        </fieldset>
      </div>
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

/** A repository identity without its URL scheme: `github.com/org/repo`. */
export function projectLabel(repo: string): string {
  return repo.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
}

/**
 * The masthead's project name doubles as the project picker when more than
 * one project is reachable: the same ghost-word trigger and outlined panel as
 * the account menu, anchored left under the name.
 */
function ProjectMenu({
  repo,
  repositories,
  initiallyOpen,
  onRepo,
}: {
  repo: string
  repositories: readonly string[]
  initiallyOpen?: boolean
  onRepo: (repo: string) => void
}) {
  const { open, setOpen, close, rootRef, triggerRef, listRef, listId, onListKey, onTriggerKey } =
    useMenuDisclosure('project', initiallyOpen)
  if (repositories.length < 2) {
    return <span className="project">{repo ? projectLabel(repo) : 'no repository configured'}</span>
  }
  return (
    <span ref={rootRef} className="menu project-menu">
      <button
        ref={triggerRef}
        type="button"
        className="word menu-trigger project"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Project ${projectLabel(repo)}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKey}
      >
        <span className="menu-label">{projectLabel(repo)}</span>{' '}
        <span className="menu-glyph" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className="menu-list" role="menu" id={listId} onKeyDown={onListKey}>
          <div className="menu-label-heading">Projects</div>
          {repositories.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={name === repo}
              data-autofocus={name === repo || undefined}
              className="word menu-item project"
              onClick={() => {
                close()
                if (name !== repo) onRepo(name)
              }}
            >
              {projectLabel(name)}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
