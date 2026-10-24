'use client'
import { AccessFrame, type FrameProps } from '../access/Frame'
import { membersLink, type Snapshot } from '../access/api'
export function OrganizationsView(
  props: FrameProps & {
    snapshots?: Snapshot[]
    name?: string
    created?: string
    forbidden?: boolean
    onName?: (name: string) => void
    onCreate?: () => void
  },
) {
  return (
    <AccessFrame {...props} title="Organizations">
      <p className="slack access-lede">
        Each organization owns projects. Its members reach all of them. Super users reach
        everything.
      </p>
      {!props.forbidden && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            props.onCreate?.()
          }}
        >
          <label htmlFor="organization-name">
            <strong>New organization</strong>
          </label>
          <div className="access-add">
            <input
              id="organization-name"
              required
              maxLength={100}
              placeholder="Organization name"
              value={props.name ?? ''}
              disabled={props.pending}
              onChange={(e) => props.onName?.(e.target.value)}
            />
            <button type="submit" className="btn primary" disabled={props.pending}>
              Create
            </button>
          </div>
          <p className="slack access-help">
            You won't become a member. Add members and choose an owner next.
          </p>
        </form>
      )}
      {props.created && (
        <p>
          <a href={membersLink(props.created)}>Add members and choose an owner</a>
        </p>
      )}
      {props.snapshots &&
        (props.snapshots.length ? (
          <>
            <h2>{props.snapshots.length} organizations</h2>
            <div className="access-rows">
              {props.snapshots.map(({ organization: org, members, projects }) => (
                <div className="access-row organization-row" key={org.id}>
                  <a href={membersLink(org.id)}>
                    <strong>{org.name}</strong>
                  </a>
                  <span>
                    {org.ownerEmail ? (
                      <>
                        Owner <span className="project">{org.ownerEmail}</span>
                      </>
                    ) : (
                      <span className="warn">No owner yet</span>
                    )}
                  </span>
                  <span>
                    {members.length} {members.length === 1 ? 'member' : 'members'}
                  </span>
                  <span>
                    {projects.length} {projects.length === 1 ? 'project' : 'projects'}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="access-empty">
            <strong>No organizations yet.</strong>
            <p className="slack">
              Create the first one above, then add people by email. Until a project belongs to an
              organization, only super users can see it.
            </p>
            <a href="/projects">See projects waiting for an organization</a>
          </div>
        ))}
    </AccessFrame>
  )
}
