'use client'
import { Menu } from '../dashboard/Menu'
export function AccountMenu({
  identity,
  isSuperUser = false,
  menuOpen,
  onSignOut,
}: {
  identity: string
  isSuperUser?: boolean
  menuOpen?: boolean
  onSignOut?: () => void
}) {
  return (
    <Menu
      className="account"
      initiallyOpen={menuOpen}
      label={<span className="identity">{identity}</span>}
      items={[
        { label: 'Builds', href: '/' },
        { label: 'Members', href: '/members' },
        ...(isSuperUser
          ? [
              { label: 'Organizations', href: '/organizations' },
              { label: 'Projects', href: '/projects' },
            ]
          : []),
        {
          label: 'sign out',
          onSelect:
            onSignOut ??
            (() => {
              void fetch('/api/auth/sign-out', { method: 'POST' }).then(() =>
                window.location.assign('/sign-in'),
              )
            }),
        },
      ]}
    />
  )
}
