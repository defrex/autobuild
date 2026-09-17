import { humanActor, type Via } from '../events/envelope'
import type { RepositoryEventEnvelope } from '../events/repository'
import { reduceDispatchSettings } from '../kernel/dispatch-settings'
import { reduceHarvest } from '../kernel/harvest'
import type { BuildStore } from '../store/types'
import { projectHarvest, type HarvestRunAction } from '../cli/dashboard/model'

export class OperatorControlError extends Error {
  constructor(
    readonly code:
      | 'stale-harvest-run'
      | 'harvest-paused'
      | 'harvest-pending'
      | 'harvest-unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'OperatorControlError'
  }
}

export type RepositorySetting = 'intake' | 'auto-merge-default'

export async function setRepositorySetting(opts: {
  store: BuildStore
  repo: string
  user: string
  setting: RepositorySetting
  enabled: boolean
  /** Delegated-write attribution marker threaded onto the event's actor. */
  via?: Via
  /** Dispatcher invocation that performed the write. Present on the
   * dashboard/launch-flag write paths so the two are distinguishable in the
   * journal; optional so the operator API (which has no run) is unchanged. */
  run?: string
}): Promise<{ enabled: boolean; event: RepositoryEventEnvelope }> {
  await opts.store.ensureRepo(opts.repo)
  const payload = {
    enabled: opts.enabled,
    ...(opts.run !== undefined ? { run: opts.run } : {}),
  }
  const event =
    opts.setting === 'intake'
      ? await opts.store.appendRepo(opts.repo, {
          actor: humanActor(opts.user, opts.via),
          type: 'dispatcher.intake-set',
          payload,
        })
      : await opts.store.appendRepo(opts.repo, {
          actor: humanActor(opts.user, opts.via),
          type: 'dispatcher.auto-merge-default-set',
          payload,
        })
  return { enabled: opts.enabled, event }
}

export async function toggleRepositorySetting(opts: {
  store: BuildStore
  repo: string
  user: string
  setting: RepositorySetting
  via?: Via
  /** Dispatcher invocation that performed the write (see setRepositorySetting). */
  run?: string
}): Promise<{ enabled: boolean; event: RepositoryEventEnvelope }> {
  await opts.store.ensureRepo(opts.repo)
  const settings = reduceDispatchSettings(await opts.store.getRepoEvents(opts.repo))
  const enabled = opts.setting === 'intake' ? !settings.intake : !settings.defaultAutoMerge
  return setRepositorySetting({ ...opts, enabled })
}

export async function toggleHarvestGate(opts: {
  store: BuildStore
  repo: string
  user: string
  via?: Via
}): Promise<{ command: 'pause' | 'resume'; event: RepositoryEventEnvelope }> {
  await opts.store.ensureRepo(opts.repo)
  const state = reduceHarvest(await opts.store.getRepoEvents(opts.repo))
  const pending = state.pendingCommands.at(-1)
  const requestedPaused = pending === undefined ? state.paused : pending.command === 'pause'
  const command = requestedPaused ? 'resume' : 'pause'
  const event = await opts.store.appendRepo(opts.repo, {
    actor: humanActor(opts.user, opts.via),
    type: command === 'resume' ? 'harvest.resume-requested' : 'harvest.pause-requested',
    payload: {},
  })
  return { command, event }
}

/** Act only on the concrete dashboard run captured by the caller. */
export async function controlHarvestRun(opts: {
  store: BuildStore
  repo: string
  user: string
  run: string
  via?: Via
}): Promise<{ action: HarvestRunAction; event: RepositoryEventEnvelope }> {
  await opts.store.ensureRepo(opts.repo)
  const events = await opts.store.getRepoEvents(opts.repo)
  const state = reduceHarvest(events)
  const projected = projectHarvest(events)
  if (projected === undefined || projected.run !== opts.run) {
    throw new OperatorControlError(
      'stale-harvest-run',
      'harvest run action ignored: selected run is no longer active',
    )
  }
  if (state.paused) {
    throw new OperatorControlError(
      'harvest-paused',
      'harvest run action unavailable while harvest is OFF; select Dispatcher and press h',
    )
  }
  if (state.pendingCommands.some((command) => command.command === 'resume')) {
    throw new OperatorControlError('harvest-pending', 'harvest run: resume acknowledgement pending')
  }
  if (projected.action === undefined) {
    throw new OperatorControlError('harvest-unavailable', 'harvest run has no available action')
  }
  const event = await opts.store.appendRepo(opts.repo, {
    actor: humanActor(opts.user, opts.via),
    type: 'harvest.resume-requested',
    payload: {},
  })
  return { action: projected.action, event }
}
