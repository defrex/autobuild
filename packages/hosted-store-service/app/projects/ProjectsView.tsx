'use client'
import { AccessFrame, type FrameProps } from '../access/Frame'
import { ConfirmDialog } from '../dashboard/ConfirmDialog'
import type { Snapshot } from '../access/api'
export function ProjectsView(
  props: FrameProps & {
    snapshots?: Snapshot[]
    unassigned?: string[]
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
  return (
    <AccessFrame {...props} title="Projects">
      <p className="slack access-lede">
        A project belongs to one organization. Moving it changes who can reach it immediately.
      </p>
      {props.snapshots && !snapshots.length && (
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
      {props.snapshots && (
        <>
          <h2>{snapshots.reduce((n, s) => n + s.projects.length, 0)} assigned</h2>
          <div className="access-rows">
            {snapshots.flatMap(({ organization: org, projects }) =>
              projects.map((repo) => (
                <div className="access-row project-row" key={repo}>
                  <span className="project">{repo}</span>
                  <span>{org.name}</span>
                  <button
                    type="button"
                    className="word slack"
                    disabled={pending || forbidden || !destination(repo, org.id)}
                    onClick={() => props.onMove?.(repo)}
                  >
                    Move…
                  </button>
                </div>
              )),
            )}
          </div>
          {(() => {
            const owner = snapshots.find((snapshot) =>
              snapshot.projects.includes(props.confirmation ?? ''),
            )
            const repo = owner ? props.confirmation! : ''
            const members = owner?.members.length ?? 0
            return (
              <ConfirmDialog
                open={owner !== undefined}
                title={`Move ${repo}?`}
                confirmLabel="Move project"
                pending={pending}
                disabled={forbidden || !destination(repo, owner?.organization.id)}
                onConfirm={() => props.onConfirm?.(repo)}
                onCancel={() => props.onCancel?.()}
              >
                <p>
                  {owner?.organization.name}’s {members}{' '}
                  {members === 1 ? 'member loses' : 'members lose'} its organization grant to this
                  project. Other memberships and super-user access still apply.
                </p>
                {owner && select(repo, owner.organization.id)}
              </ConfirmDialog>
            )
          })()}
        </>
      )}
    </AccessFrame>
  )
}
