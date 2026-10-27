'use client'
import type { ReactNode } from 'react'
import { AccountMenu } from './AccountMenu'
export interface FrameProps {
  identity: string
  isOwner?: boolean
  isSuperUser: boolean
  pending?: boolean
  error?: string
  onRefresh?: () => void
  menuOpen?: boolean
}
export function AccessFrame({
  identity,
  isOwner,
  isSuperUser,
  pending,
  error,
  onRefresh,
  menuOpen,
  title,
  children,
}: FrameProps & { title: string; children: ReactNode }) {
  return (
    <main className="frame access-frame">
      <header className="masthead">
        <span className="brand">Autobuild</span>
        <a className="slack" href="/">
          Builds
        </a>
        <span className="spacer" />
        {isSuperUser && <span className="slack">super user</span>}
        <AccountMenu
          identity={identity}
          isOwner={isOwner}
          isSuperUser={isSuperUser}
          menuOpen={menuOpen}
        />
      </header>
      <section className={`access-page access-${title.toLowerCase()}`}>
        <div className="access-heading">
          <h1>{title}</h1>
          {onRefresh && (
            <button type="button" className="word" disabled={pending} onClick={onRefresh}>
              Refresh
            </button>
          )}
        </div>
        {pending && (
          <p role="status" className="slack">
            Loading acknowledged state…
          </p>
        )}
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        {children}
      </section>
    </main>
  )
}
