'use client'
import { useCallback, useEffect, useState, useRef } from 'react'
import {
  request,
  projectManagement,
  orgPath,
  canDelete,
  validDeletionPreview,
  deleteHostedProject,
  deletionUnknown,
  type DeletionPreview,
} from '../access/api'
import { useAccess } from '../access/useAccess'
import { confirmedTarget, type Confirmation } from '../access/state'
import { ProjectsView } from './ProjectsView'
export function ProjectsClient({
  identity,
  isOwner,
  isSuperUser,
}: {
  identity: string
  isOwner?: boolean
  isSuperUser: boolean
}) {
  const [typed, setTyped] = useState('')
  const [vacated, setVacated] = useState<Record<string, number>>({})
  const [unknown, setUnknown] = useState<Record<string, number>>({})
  const retained = useRef<Record<string, number>>({})
  type Management = Awaited<ReturnType<typeof projectManagement>>
  const [frozen, setFrozen] = useState<Management>()
  const attemptRevision = useRef(0)
  const [deleting, setDeleting] = useState<string>()
  const deletionSource = useRef<string | undefined>(undefined)
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreview>()
  const [deletionError, setDeletionError] = useState<string>()
  const [hidden, setHidden] = useState<string[]>([])
  const [deletionPending, setDeletionPending] = useState(false)
  const deletionBusy = useRef(false)
  const previewRevision = useRef(0)
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [destinations, setDestinations] = useState<Record<string, string>>({})
  const load = useCallback(
    (signal: AbortSignal) => projectManagement(isSuperUser, signal),
    [isSuperUser],
  )
  const state = useAccess(load)
  // Hide only until discovery acknowledges the completed purge. A later
  // reconnection with the same repository name must be visible again.
  useEffect(() => {
    if (state.data && !frozen) setHidden([])
  }, [state.data, frozen])
  const sourceOf = (repo: string | undefined) =>
    state.data?.pendingDeletions.includes(repo ?? '')
      ? 'pending-deletion'
      : state.data?.snapshots.find((s) => repo && s.projects.includes(repo))?.organization.id
  const activeConfirmation = confirmedTarget(confirmation, sourceOf(confirmation?.target))
  useEffect(() => {
    if (confirmation && !activeConfirmation) setConfirmation(undefined)
  }, [confirmation, activeConfirmation])
  useEffect(() => {
    if (
      deleting &&
      ((!isSuperUser &&
        deletionSource.current !== 'pending-deletion' &&
        state.data?.snapshots.find(
          (snapshot) => snapshot.organization.id === deletionSource.current,
        )?.organization.membershipRole !== 'owner') ||
        (deletionSource.current !== sourceOf(deleting) && !deletionError)) &&
      !deletionBusy.current
    ) {
      previewRevision.current++
      setDeleting(undefined)
      setDeletionPreview(undefined)
    }
  })
  async function assign(repo: string) {
    const source = state.data?.snapshots.find((s) => s.projects.includes(repo))?.organization.id
    const options = state.data?.snapshots.filter((s) => s.organization.id !== source) ?? []
    const target = options.find((s) => s.organization.id === destinations[repo]) ?? options[0]
    if (
      target &&
      (await state.write(`${orgPath(target.organization.id)}/projects`, 'PUT', { repo }))
    )
      setConfirmation(undefined)
  }
  async function previewDelete(repo: string) {
    if (deletionBusy.current || retained.current[repo] || state.forbidden) return
    const revision = ++previewRevision.current
    setTyped('')
    setConfirmation(undefined)
    deletionSource.current = sourceOf(repo)
    setDeleting(repo)
    setDeletionPreview(undefined)
    setDeletionError(undefined)
    try {
      const preview = await request<DeletionPreview>(
        `projects/deletion?repo=${encodeURIComponent(repo)}`,
      )
      if (!validDeletionPreview(preview, repo))
        throw new Error('Preview unavailable. Reload to check.')
      if (revision === previewRevision.current) {
        setTyped('')
        setDeletionPreview(preview)
      }
    } catch (error) {
      if (revision === previewRevision.current)
        setDeletionError(error instanceof Error ? error.message : 'Preview unavailable. Try again.')
    }
  }
  async function deleteProject(repo: string) {
    const source = sourceOf(repo)
    const permitted =
      isSuperUser ||
      source === 'pending-deletion' ||
      state.data?.snapshots.find((s) => s.organization.id === source)?.organization
        .membershipRole === 'owner'
    if (
      deletionBusy.current ||
      state.pending ||
      state.forbidden ||
      !permitted ||
      !source ||
      deleting !== repo ||
      deletionSource.current !== source ||
      retained.current[repo] ||
      !canDelete(repo, typed, deletionPreview)
    )
      return
    const token = deletionPreview!.token
    attemptRevision.current++
    setFrozen((previous) => previous ?? state.data)
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-project]')).find(
      (el) => el.dataset.project === repo,
    )
    const rowHeight = row?.getBoundingClientRect().height || 90
    retained.current = { ...retained.current, [repo]: rowHeight }
    deletionBusy.current = true
    setDeletionPending(true)
    setDeletionError(undefined)
    try {
      await deleteHostedProject(repo, token)
      const remaining = { ...retained.current }
      delete remaining[repo]
      retained.current = remaining
      setUnknown(remaining)
      if (!Object.keys(remaining).length) {
        setFrozen(undefined)
        setVacated({})
      } else
        setVacated((previous) => ({
          ...previous,
          [repo]: rowHeight,
        }))
      setTyped('')
      setDeleting(undefined)
      setDeletionPreview(undefined)
      setHidden((previous) => [...previous, repo])
      state.reload()
    } catch {
      setUnknown({ ...retained.current })
      setDeletionPreview(undefined)
      setTyped('')
      setDeletionError(deletionUnknown)
    } finally {
      deletionBusy.current = false
      setDeletionPending(false)
    }
  }
  const display = state.forbidden ? undefined : (frozen ?? state.data)
  const visibleSnapshots = display?.snapshots.map((snapshot) => ({
    ...snapshot,
    organization: {
      ...snapshot.organization,
      membershipRole:
        state.data?.snapshots.find((s) => s.organization.id === snapshot.organization.id)
          ?.organization.membershipRole ?? null,
    },
    projects: snapshot.projects.filter(
      (repo) =>
        (!hidden.includes(repo) || !!vacated[repo]) && !display.pendingDeletions.includes(repo),
    ),
  }))
  async function refreshUnknown() {
    if (deletionBusy.current) return
    const revision = attemptRevision.current
    try {
      const fresh = await state.refresh()
      if (fresh && revision === attemptRevision.current && !deletionBusy.current) {
        retained.current = {}
        setUnknown({})
        setVacated({})
        setFrozen(undefined)
        setHidden([])
      }
    } catch {
      /* Unsuccessful discovery cannot establish absence. */
    }
  }
  return (
    <ProjectsView
      identity={identity}
      isOwner={isOwner}
      isSuperUser={isSuperUser}
      {...display}
      snapshots={visibleSnapshots}
      pendingDeletions={display?.pendingDeletions.filter(
        (repo) => !hidden.includes(repo) || !!vacated[repo],
      )}
      pending={state.pending || deletionPending}
      vacatedRows={vacated}
      unknownDeletions={unknown}
      deletionIdentity={typed}
      onDeletionIdentity={setTyped}
      deleting={deleting}
      deletionPreview={deletionPreview}
      deletionError={deletionError}
      onDelete={(repo) => void previewDelete(repo)}
      onDeleteConfirm={(repo) => void deleteProject(repo)}
      error={state.error}
      forbidden={state.forbidden}
      confirmation={activeConfirmation}
      destinations={destinations}
      onDestination={(repo, id) => setDestinations((prev) => ({ ...prev, [repo]: id }))}
      onAssign={(repo) => void assign(repo)}
      onMove={(target) => {
        setTyped('')
        previewRevision.current++
        setDeleting(undefined)
        setDeletionPreview(undefined)
        const context = sourceOf(target)
        if (context) setConfirmation({ context, target })
      }}
      onConfirm={(repo) => {
        if (activeConfirmation === repo) void assign(repo)
      }}
      onCancel={() => {
        setTyped('')
        previewRevision.current++
        setDeleting(undefined)
        setDeletionPreview(undefined)
        setDeletionError(undefined)
        setConfirmation(undefined)
      }}
      onRefresh={() => {
        setConfirmation(undefined)
        void refreshUnknown()
      }}
    />
  )
}
