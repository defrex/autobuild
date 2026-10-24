'use client'
import { useCallback, useState } from 'react'
import {
  request,
  AccessRequestError,
  snapshots,
  organizationSlug,
  type Discovery,
} from '../access/api'
import { useAccess } from '../access/useAccess'
import { OrganizationsView } from './OrganizationsView'
export function OrganizationsClient({
  identity,
  isSuperUser,
}: {
  identity: string
  isSuperUser: boolean
}) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const load = useCallback(async (signal: AbortSignal) => {
    const discovery = await request<Discovery>('orgs', 'GET', undefined, signal)
    if (!discovery.isSuperUser) throw new AccessRequestError(403, 'super user required')
    return snapshots(discovery.organizations, signal)
  }, [])
  const state = useAccess(load)
  async function create() {
    setLocalError(undefined)
    let slug: string
    try {
      slug = organizationSlug(name)
    } catch (error) {
      setLocalError((error as Error).message)
      return
    }
    // The mutation gate owns writes; its saved response identifies the new roster.
    if (await state.write('orgs', 'POST', { name, slug })) {
      setName('')
      setCreated(slug)
    }
  }
  const createdId = state.data?.find((s) => s.organization.slug === created)?.organization.id
  return (
    <OrganizationsView
      identity={identity}
      isSuperUser={isSuperUser}
      snapshots={state.data}
      name={name}
      created={createdId}
      forbidden={state.forbidden}
      pending={state.pending}
      error={localError ?? state.error}
      onName={setName}
      onCreate={() => void create()}
      onRefresh={state.reload}
    />
  )
}
