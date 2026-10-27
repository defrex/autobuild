'use client'
import { useCallback, useEffect, useState } from 'react'
import { request, snapshot, orgPath, membersLink, type Discovery } from '../access/api'
import { useAccess } from '../access/useAccess'
import { confirmedTarget, type Confirmation } from '../access/state'
import { MembersView } from './MembersView'
export function MembersClient({
  identity,
  isSuperUser,
  initialOrg,
  signInUrl,
}: {
  identity: string
  isSuperUser: boolean
  initialOrg?: string
  signInUrl: string
}) {
  const [requested, setRequested] = useState(initialOrg)
  const [email, setEmail] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const load = useCallback(
    async (signal: AbortSignal) => {
      const discovery = await request<Discovery>('orgs', 'GET', undefined, signal)
      const selected =
        discovery.organizations.find((o) => o.id === requested) ?? discovery.organizations[0]
      return { ...discovery, selected: selected ? await snapshot(selected.id, signal) : undefined }
    },
    [requested],
  )
  const state = useAccess(load)
  const selected = state.data?.selected
  const context = selected?.organization.id
  const activeConfirmation = selected?.members.some(
    (member) => member.email === confirmation?.target,
  )
    ? confirmedTarget(confirmation, context)
    : undefined
  useEffect(() => {
    if (confirmation && !activeConfirmation) setConfirmation(undefined)
  }, [confirmation, activeConfirmation])
  async function write(suffix: string, method: string, body: unknown) {
    if (!selected) return
    if (await state.write(`${orgPath(selected.organization.id)}/${suffix}`, method, body)) {
      setConfirmation(undefined)
      setEmail('')
    }
  }
  return (
    <MembersView
      identity={identity}
      isSuperUser={state.data?.isSuperUser ?? isSuperUser}
      organizations={state.data?.organizations ?? []}
      selected={selected}
      pending={state.pending}
      error={state.error}
      forbidden={state.forbidden}
      email={email}
      signInUrl={signInUrl}
      confirmation={activeConfirmation}
      onRefresh={() => {
        setConfirmation(undefined)
        state.reload()
      }}
      onEmail={setEmail}
      onOrg={(id) => {
        setConfirmation(undefined)
        setRequested(id)
        window.history.replaceState(null, '', membersLink(id))
      }}
      onAdd={() => void write('members', 'POST', { email })}
      onRemove={(target) => {
        if (context) setConfirmation({ context, target })
      }}
      onCancel={() => setConfirmation(undefined)}
      onConfirm={() => {
        if (activeConfirmation) void write('members', 'DELETE', { email: activeConfirmation })
      }}
      onOwner={(value) => void write('owner', 'PUT', { email: value || null })}
    />
  )
}
