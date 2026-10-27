'use client'
import { Fragment, useEffect, useState } from 'react'
import { AccessFrame, type FrameProps } from '../access/Frame'
import type { Organization, Snapshot } from '../access/api'
export interface MembersProps extends FrameProps {
  organizations: Organization[]
  selected?: Snapshot
  confirmation?: string
  forbidden?: boolean
  email?: string
  /** The deployment's sign-in page, which an owner sends to the people they add. */
  signInUrl?: string
  onEmail?: (email: string) => void
  onOrg?: (id: string) => void
  onAdd?: () => void
  onRemove?: (email: string) => void
  onConfirm?: () => void
  onCancel?: () => void
  onOwner?: (email: string) => void
}
export function MembersView(props: MembersProps) {
  const { selected, organizations, identity, isSuperUser, pending, forbidden, confirmation } = props
  const org = selected?.organization
  const manage = !forbidden && (isSuperUser || org?.membershipRole === 'owner')
  return (
    <AccessFrame {...props} title="Members">
      {!org ? (
        !pending &&
        !props.error && (
          <p>
            {organizations.length
              ? 'Select an organization to see its members.'
              : 'You do not belong to an organization yet.'}{' '}
            {isSuperUser && <a href="/organizations">Create an organization</a>}
          </p>
        )
      ) : (
        <>
          <div className="access-org">
            <strong>{org.name}</strong>
            {organizations.length > 1 && (
              <label>
                <span className="sr-only">Switch organization</span>
                <select
                  value={org.id}
                  disabled={pending}
                  onChange={(e) => props.onOrg?.(e.target.value)}
                >
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <p className="slack access-lede">
            Members can see and operate every project {org.name} owns:{' '}
            {selected.projects.length
              ? selected.projects.map((repo, i) => (
                  <Fragment key={repo}>
                    {i > 0 && ', '}
                    <span className="project">{repo}</span>
                  </Fragment>
                ))
              : 'no projects yet'}
            .
          </p>
          {manage ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                props.onAdd?.()
              }}
            >
              <label htmlFor="member-email">
                <strong>Add a member</strong>
              </label>
              <div className="access-add">
                <input
                  id="member-email"
                  type="email"
                  required
                  maxLength={320}
                  placeholder="name@company.com"
                  value={props.email ?? ''}
                  disabled={pending}
                  onChange={(e) => props.onEmail?.(e.target.value)}
                />
                <button type="submit" className="btn primary" disabled={pending}>
                  Add member
                </button>
              </div>
              <p className="slack access-help">
                After you add someone, ask them to sign up via{' '}
                {props.signInUrl ? (
                  <>
                    <span className="project">{props.signInUrl}</span>{' '}
                    <CopyLink value={props.signInUrl} />
                  </>
                ) : (
                  'the sign-in page.'
                )}
              </p>
            </form>
          ) : (
            <p className="slack">
              You can view members. An organization owner or super user manages access.
            </p>
          )}
          <h2>
            {selected.members.length} {selected.members.length === 1 ? 'person' : 'people'}
          </h2>
          <div className="access-rows">
            {selected.members.map((member) => (
              <Fragment key={member.email}>
                {confirmation === member.email && manage && (
                  <section
                    className="access-confirm"
                    aria-label={`Confirm removing ${member.email}`}
                  >
                    <p>
                      Remove {member.name ?? member.email}? They lose {org.name}’s grant to{' '}
                      {selected.projects.length}{' '}
                      {selected.projects.length === 1 ? 'project' : 'projects'} on their next
                      request. Other organization grants and super-user access still apply.
                    </p>
                    <div className="access-actions">
                      <button
                        type="button"
                        className="btn danger"
                        disabled={pending}
                        onClick={props.onConfirm}
                      >
                        Remove {member.name ?? member.email}
                      </button>
                      <button
                        type="button"
                        className="word"
                        disabled={pending}
                        onClick={props.onCancel}
                      >
                        Cancel
                      </button>
                    </div>
                  </section>
                )}
                <div className="access-row member-row">
                  <div>
                    {member.name && <strong>{member.name} </strong>}
                    {member.email === identity && <span className="slack">(you)</span>}
                    <div className="project slack">{member.email}</div>
                  </div>
                  <span className="slack">
                    {member.role === 'owner' ? 'Owner · manages members' : 'Member'}
                  </span>
                  <strong className={`machine ${member.status === 'joined' ? 'ok' : 'warn'}`}>
                    {member.status.toUpperCase()}
                  </strong>
                  <span className="access-action">
                    {manage && (isSuperUser || member.email !== identity) && (
                      <button
                        type="button"
                        className="word slack"
                        disabled={pending}
                        onClick={() => props.onRemove?.(member.email)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
          {isSuperUser && !forbidden && (
            <label className="access-owner">
              Owner{' '}
              <select
                aria-label="Organization owner"
                value={org.ownerEmail ?? ''}
                disabled={pending}
                onChange={(e) => props.onOwner?.(e.target.value)}
              >
                <option value="">No owner yet</option>
                {selected.members.map((m) => (
                  <option key={m.email} value={m.email}>
                    {m.email}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="slack access-help">
            Only a super user can change the owner. Removing someone takes effect on their next
            request.
          </p>
        </>
      )}
    </AccessFrame>
  )
}

/** A bare glyph button, so the help text keeps flowing around it. */
function CopyLink({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={`copy-link${copied ? ' copied' : ''}`}
      aria-label="Copy sign-up link"
      title={copied ? 'Copied' : 'Copy sign-up link'}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        )
      }}
    >
      <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
        <path
          d="M5.5 5.5h8v8h-8z M10.5 2.5h-8v8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  )
}
