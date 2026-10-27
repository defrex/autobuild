'use client'
import { useCallback, useEffect, useState, useRef } from 'react'
import { request, projectManagement, orgPath, type DeletionPreview } from '../access/api'
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
    if (state.data) setHidden([])
  }, [state.data])
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
    const revision = ++previewRevision.current
    setConfirmation(undefined)
    deletionSource.current = sourceOf(repo)
    setDeleting(repo)
    setDeletionPreview(undefined)
    setDeletionError(undefined)
    try {
      const preview = await request<DeletionPreview>(
        `projects/deletion?repo=${encodeURIComponent(repo)}`,
      )
      if (revision === previewRevision.current) setDeletionPreview(preview)
    } catch (error) {
      if (revision === previewRevision.current)
        setDeletionError(error instanceof Error ? error.message : 'Preview unavailable. Try again.')
    }
  }
  async function deleteProject(repo: string) {
    if (deletionBusy.current || deletionPreview?.repo !== repo) return
    deletionBusy.current = true
    setDeletionPending(true)
    setDeletionError(undefined)
    try {
      await request('projects/deletion', 'DELETE', { repo }, undefined, {
        'if-match': deletionPreview.token,
      })
      setDeleting(undefined)
      setDeletionPreview(undefined)
      setHidden((previous) => [...previous, repo])
      state.reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deletion failed. Try again.'
      if (error && typeof error === 'object' && 'status' in error && error.status === 412) {
        await previewDelete(repo)
      }
      setDeletionError(message)
    } finally {
      deletionBusy.current = false
      setDeletionPending(false)
    }
  }
  const visibleSnapshots = state.data?.snapshots.map((snapshot) => {
    const preserve =
      deletionError &&
      deleting &&
      deletionSource.current === snapshot.organization.id &&
      (isSuperUser || snapshot.organization.membershipRole === 'owner')
    const projects =
      preserve && !snapshot.projects.includes(deleting)
        ? [...snapshot.projects, deleting]
        : snapshot.projects
    return {
      ...snapshot,
      projects: projects.filter(
        (repo) => !hidden.includes(repo) && !state.data?.pendingDeletions.includes(repo),
      ),
    }
  })
  return (
    <ProjectsView
      identity={identity}
      isOwner={isOwner}
      isSuperUser={isSuperUser}
      {...state.data}
      snapshots={visibleSnapshots}
      pendingDeletions={state.data?.pendingDeletions.filter((repo) => !hidden.includes(repo))}
      pending={state.pending || deletionPending}
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
        previewRevision.current++
        setDeleting(undefined)
        setDeletionPreview(undefined)
        setDeletionError(undefined)
        setConfirmation(undefined)
      }}
      onRefresh={() => {
        setConfirmation(undefined)
        state.reload()
      }}
    />
  )
}
