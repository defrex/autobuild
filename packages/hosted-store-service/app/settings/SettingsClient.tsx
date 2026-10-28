'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import * as api from '../dashboard/api'
import { DispatcherControls } from '../dashboard/BuildsView'
import { reconcileDashboard } from '../dashboard/view-model'
import type { DashboardModel } from '@defrex/autobuild/operator-presentation'
import { OperatorShell } from '../dashboard/Shell'
import { ViewTabs, useTicketMeta } from '../dashboard/tickets'
import { tabLink } from '../dashboard/project-selection'
import { SettingsView } from './SettingsView'
import { settingsController, type SettingsState } from './controller'

export function SettingsClient(props: {
  identity: string
  isOwner?: boolean
  isSuperUser?: boolean
  initialSelection: string
  repositories: readonly string[]
}) {
  const router = useRouter()
  const query = useSearchParams()
  const repo = props.initialSelection
  const [state, setState] = useState<SettingsState>({})
  const [removing, setRemoving] = useState<string>()
  const [model, setModel] = useState<DashboardModel>()
  const [controlPending, setControlPending] = useState<string>()
  const [controlError, setControlError] = useState<string>()
  const ticketMeta = useTicketMeta(repo, 0)
  const [controller] = useState(() =>
    settingsController({
      read: () => api.projectSettings(repo),
      write: (operation, name, value) =>
        operation === 'set'
          ? api.setProjectSecret(repo, name, value!)
          : api.removeProjectSecret(repo, name),
      changed: setState,
      acknowledged: () => setRemoving(undefined),
    }),
  )
  useEffect(() => {
    controller.activate()
    if (repo) void controller.refresh()
    const timer = setInterval(() => {
      if (!document.hidden && repo) void controller.poll()
    }, 2000)
    return () => {
      controller.dispose()
      clearInterval(timer)
    }
  }, [controller, repo])
  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      try {
        const snapshot = await api.dashboard(repo, abort.signal)
        if (!abort.signal.aborted) setModel((old) => reconcileDashboard(old, snapshot.model))
      } catch {
        /* Settings does not depend on a dispatcher. */
      }
    }
    if (repo) void load()
    const timer = setInterval(() => {
      if (repo && !document.hidden) void load()
    }, 2000)
    return () => {
      abort.abort()
      clearInterval(timer)
    }
  }, [repo])
  async function control(action: string, write: () => Promise<unknown>) {
    setControlPending(action)
    setControlError(undefined)
    try {
      await write()
      const snapshot = await api.dashboard(repo)
      setModel((old) => reconcileDashboard(old, snapshot.model))
    } catch {
      setControlError('Repository control was refused. Refresh and try again.')
    } finally {
      setControlPending(undefined)
    }
  }
  return (
    <OperatorShell
      {...props}
      repo={repo}
      error={controlError}
      controls={
        model ? (
          <DispatcherControls
            model={model}
            pending={controlPending}
            onSetting={(name, enabled) => {
              void control(name, () => api.setting(repo, name, enabled))
            }}
            onHarvest={(body) => {
              void control('harvest', () => api.harvest(repo, body))
            }}
            onBulk={(action) => {
              void control(action, () => api.bulk(repo, action))
            }}
          />
        ) : null
      }
      tabs={
        <ViewTabs
          repo={repo}
          current="settings"
          page
          counts={{
            triage: ticketMeta.names && ticketMeta.counts?.[ticketMeta.names.triage],
            active: model ? `${model.active.current}/${model.active.limit}` : undefined,
            queue: ticketMeta.names && ticketMeta.counts?.[ticketMeta.names.ready],
          }}
        />
      }
      onRepo={(next) => router.push(tabLink(next, 'settings', query.toString()))}
      onSignOut={async () => {
        await fetch('/api/auth/sign-out', { method: 'POST' })
        window.location.assign('/sign-in')
      }}
    >
      {repo ? (
        <SettingsView
          key={repo}
          data={state.data}
          pending={state.pending}
          error={state.writeError ?? state.readError}
          removing={removing}
          onSet={(name, value) => controller.write('set', name, value)}
          onRemove={setRemoving}
          onConfirm={() => {
            if (removing) void controller.write('remove', removing)
          }}
        />
      ) : (
        <p>No project is available.</p>
      )}
    </OperatorShell>
  )
}
