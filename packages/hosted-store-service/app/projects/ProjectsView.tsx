'use client'
import { AccessFrame, type FrameProps } from '../access/Frame'
import type { Snapshot, DeletionPreview } from '../access/api'
export function ProjectsView(
  props: FrameProps & {
    snapshots?: Snapshot[]
    unassigned?: string[]
    pendingDeletions?: string[]
    deleting?: string
    deletionPreview?: DeletionPreview
    deletionError?: string
    onDelete?: (repo: string) => void
    onDeleteConfirm?: (repo: string) => void
    confirmation?: string
    destinations?: Record<string, string>
    forbidden?: boolean
    onDestination?: (repo: string, id: string) => void
    onAssign?: (repo: string) => void
    onMove?: (repo: string) => void
    onConfirm?: (repo: string) => void
    onCancel?: () => void
  },
) {
  const { snapshots = [], destinations = {}, pending, forbidden } = props
  const destination = (repo: string, source?: string) =>
    snapshots.find((s) => s.organization.id === destinations[repo] && s.organization.id !== source)
      ?.organization ?? snapshots.find((s) => s.organization.id !== source)?.organization
  const select = (repo: string, source?: string) => (
    <select
      aria-label={`Organization for ${repo}`}
      disabled={pending || forbidden || !destination(repo, source)}
      value={destination(repo, source)?.id ?? ''}
      onChange={(e) => props.onDestination?.(repo, e.target.value)}
    >
      {!destination(repo, source) && <option value="">No destination available</option>}
      {snapshots
        .filter((s) => s.organization.id !== source)
        .map(({ organization: o }) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
    </select>
  )
  const deletionConfirmation = (repo: string) => (
    <section className="access-confirm" key={repo} aria-label={`Confirm deleting ${repo}`}>
      <p>
        Permanently delete <span className="project">{repo}</span> from the service? This cannot be
        undone. Local repository files and configuration are not affected. Connected clients lose
        access immediately; every project credential stops working.
      </p>
      {props.deletionPreview?.repo === repo ? (
        <p>
          This deletes {props.deletionPreview.builds} builds, {props.deletionPreview.tickets} hosted
          tickets, {props.deletionPreview.secrets} project secrets, and{' '}
          {props.deletionPreview.subscriptionAccounts} subscription accounts, including their stored
          artifacts and assets.
        </p>
      ) : (
        <p role="status">Loading deletion preview…</p>
      )}
      {props.deletionError && (
        <p className="danger" role="alert">
          {props.deletionError}
        </p>
      )}
      <div className="access-actions">
        <button
          type="button"
          className="btn danger"
          disabled={pending || forbidden || props.deletionPreview?.repo !== repo}
          onClick={() => props.onDeleteConfirm?.(repo)}
        >
          {props.pendingDeletions?.includes(repo) ? 'Finish deletion' : 'Delete project'}
        </button>
        <button type="button" className="word" disabled={pending} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
  return (
    <AccessFrame {...props} title="Projects">
      <p className="slack access-lede">
        A project belongs to one organization. Moving it changes who can reach it immediately.
      </p>
      {props.isSuperUser && props.snapshots && !snapshots.length && (
        <p>
          <a href="/organizations">Create an organization</a> before assigning projects.
        </p>
      )}
      {props.unassigned && (
        <>
          <h2 className="warn">{props.unassigned.length} waiting for an organization</h2>
          <p className="slack access-help">Only super users can see these until you assign them.</p>
          <div className="access-rows">
            {props.unassigned.map((repo) => (
              <div className="access-row project-row" key={repo}>
                <span className="project">{repo}</span>
                <div className="access-actions">
                  {select(repo)}
                  <button
                    type="button"
                    className="btn"
                    disabled={pending || forbidden || !destination(repo)}
                    onClick={() => props.onAssign?.(repo)}
                  >
                    Assign
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {!!props.pendingDeletions?.length && (
        <>
          <h2>
            {props.pendingDeletions.length} unfinished{' '}
            {props.pendingDeletions.length === 1 ? 'deletion' : 'deletions'}
          </h2>
          <p className="slack access-help">
            Access is already revoked. Finish cleanup to remove the remaining service data and allow
            a fresh connection.
          </p>
          <div className="access-rows">
            {props.pendingDeletions.map((repo) =>
              props.deleting === repo ? (
                deletionConfirmation(repo)
              ) : (
                <div className="access-row project-row" key={repo}>
                  <span className="project">{repo}</span>
                  <span className="warn">Deletion unfinished</span>
                  <div className="access-actions">
                    <button
                      type="button"
                      className="word danger"
                      disabled={pending || forbidden}
                      onClick={() => props.onDelete?.(repo)}
                    >
                      Finish deletion…
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        </>
      )}
      {props.snapshots && (
        <>
          <h2>{snapshots.reduce((n, s) => n + s.projects.length, 0)} assigned</h2>
          <div className="access-rows">
            {snapshots.flatMap(({ organization: org, projects, members }) =>
              projects.map((repo) =>
                props.deleting === repo ? (
                  deletionConfirmation(repo)
                ) : props.confirmation === repo ? (
                  <section
                    className="access-confirm"
                    key={repo}
                    aria-label={`Confirm moving ${repo}`}
                  >
                    <p>
                      Move <span className="project">{repo}</span> to{' '}
                      {destination(repo, org.id)?.name}? {org.name}’s {members.length}{' '}
                      {members.length === 1 ? 'member loses' : 'members lose'} its organization
                      grant to this project. Other memberships and super-user access still apply.
                    </p>
                    <div className="access-actions">
                      {select(repo, org.id)}
                      <button
                        type="button"
                        className="btn danger"
                        disabled={pending || forbidden || !destination(repo, org.id)}
                        onClick={() => props.onConfirm?.(repo)}
                      >
                        Move project
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
                ) : (
                  <div className="access-row project-row" key={repo}>
                    <span className="project">{repo}</span>
                    <span>{org.name}</span>
                    <div className="access-actions">
                      {props.isSuperUser && (
                        <button
                          type="button"
                          className="word slack"
                          disabled={pending || forbidden || !destination(repo, org.id)}
                          onClick={() => props.onMove?.(repo)}
                        >
                          Move…
                        </button>
                      )}
                      {(props.isSuperUser || org.membershipRole === 'owner') && (
                        <button
                          type="button"
                          className="word danger"
                          disabled={pending || forbidden}
                          onClick={() => props.onDelete?.(repo)}
                        >
                          Delete…
                        </button>
                      )}
                    </div>
                  </div>
                ),
              ),
            )}
          </div>
        </>
      )}
    </AccessFrame>
  )
}
