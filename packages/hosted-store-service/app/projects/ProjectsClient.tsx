'use client'
import { useCallback, useState } from 'react'
import { request, snapshots, orgPath, type Discovery } from '../access/api'
import { useAccess } from '../access/useAccess'
import { ProjectsView } from './ProjectsView'
export function ProjectsClient({
  identity,
  isSuperUser,
}: {
  identity: string
  isSuperUser: boolean
}) {
  const [confirmation, setConfirmation] = useState<string>()
  const [destinations, setDestinations] = useState<Record<string, string>>({})
  const load = useCallback(async (signal: AbortSignal) => {
    const discovery = await request<Discovery>('orgs', 'GET', undefined, signal)
    const [assigned, waiting] = await Promise.all([
      snapshots(discovery.organizations, signal),
      request<{ projects: string[] }>('projects/unassigned', 'GET', undefined, signal),
    ])
    return { snapshots: assigned, unassigned: waiting.projects }
  }, [])
  const state = useAccess(load)
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
  return (
    <ProjectsView
      identity={identity}
      isSuperUser={isSuperUser}
      {...state.data}
      pending={state.pending}
      error={state.error}
      forbidden={state.forbidden}
      confirmation={confirmation}
      destinations={destinations}
      onDestination={(repo, id) => setDestinations((prev) => ({ ...prev, [repo]: id }))}
      onAssign={(repo) => void assign(repo)}
      onMove={setConfirmation}
      onConfirm={(repo) => void assign(repo)}
      onCancel={() => setConfirmation(undefined)}
      onRefresh={() => {
        setConfirmation(undefined)
        state.reload()
      }}
    />
  )
}
