import type { RepositoryEvent } from '../events/repository'
import type { ArtifactRef } from '../ontology'

export type DispatchHealth = 'starting' | 'running' | 'stopped' | 'failed'

/** Store-only projection consumed by terminal (and future) frontends. */
export interface DispatchStatus {
  run: string
  health: DispatchHealth
  effectiveConfig?: ArtifactRef
  queued?: number
  availableUpgrade?: string
  roleWarnings: string[]
  diagnostics: string[]
  notice?: string
  lastSeq: number
}

function errorNotice(prefix: string, error: string): string {
  return `${prefix}: ${error}`
}

/** Reduce one correlated dispatch run without consulting process-local state.
 * An optional prior projection permits strictly newer repository deltas.
 * Successful ticks supersede standing diagnostics; failures retain the last
 * known queue/config values instead of fabricating replacements. */
export function reduceDispatchStatus(
  events: readonly RepositoryEvent[],
  run: string,
  previous?: Readonly<DispatchStatus>,
): DispatchStatus {
  if (previous !== undefined && previous.run !== run) {
    throw new Error(`cannot continue dispatch run "${run}" from "${previous.run}" status`)
  }
  const state: DispatchStatus =
    previous === undefined
      ? {
          run,
          health: 'starting',
          roleWarnings: [],
          diagnostics: [],
          lastSeq: 0,
        }
      : {
          ...previous,
          roleWarnings: [...previous.roleWarnings],
          diagnostics: [...previous.diagnostics],
        }
  for (const event of events) {
    if (event.seq <= state.lastSeq) continue
    const payload = event.payload as { run?: string }
    if (payload.run !== run) continue
    state.lastSeq = event.seq
    switch (event.type) {
      case 'dispatcher.run-started':
        state.health = 'running'
        state.effectiveConfig = event.payload.effectiveConfig
        state.roleWarnings = [...event.payload.roleWarnings]
        state.notice = undefined
        break
      case 'dispatcher.config-reloaded':
        if (event.payload.effectiveConfig !== undefined) {
          state.effectiveConfig = event.payload.effectiveConfig
        }
        if (event.payload.roleWarnings !== undefined) {
          state.roleWarnings = [...event.payload.roleWarnings]
        }
        state.notice =
          event.payload.restartRequired.length > 0
            ? `autobuild.toml reload requires dispatch restart for: ${event.payload.restartRequired.join(', ')}`
            : 'autobuild.toml reloaded'
        break
      case 'dispatcher.config-rejected':
        state.notice = errorNotice('config reload rejected', event.payload.error)
        break
      case 'dispatcher.config-publication-failed':
        state.notice = errorNotice(
          'config reload not applied because its durable trace failed',
          event.payload.error,
        )
        break
      case 'dispatcher.tick-completed':
        state.queued = event.payload.queued
        state.diagnostics = [
          ...event.payload.janitorDiagnostics,
          ...event.payload.ticketDiagnostics,
          ...event.payload.dependencyDiagnostics,
        ]
        break
      case 'dispatcher.tick-failed':
        state.notice = errorNotice('tick failed', event.payload.error)
        break
      case 'dispatcher.runner-settled':
        if (event.payload.outcome === 'parked') {
          state.notice = `build ${event.payload.slug} parked (${event.payload.status ?? 'unknown'})`
        } else if (event.payload.outcome === 'lease-held') {
          state.notice = `build ${event.payload.slug} already held by another runner — skipped`
        } else {
          state.notice = `build ${event.payload.slug} runner failed: ${event.payload.error ?? event.payload.outcome}`
        }
        break
      case 'dispatcher.harvest-runner-failed':
        state.notice = errorNotice('harvest runner failed', event.payload.error)
        break
      case 'dispatcher.upgrade-available':
        state.availableUpgrade = event.payload.version
        break
      case 'dispatcher.operator-reported':
        state.notice = event.payload.message
        break
      case 'dispatcher.run-stopped':
        state.health = event.payload.outcome === 'normal' ? 'stopped' : 'failed'
        state.notice =
          event.payload.outcome === 'normal'
            ? state.notice
            : `dispatcher stopped unexpectedly${
                event.payload.error !== undefined ? `: ${event.payload.error}` : ''
              }`
        break
      default:
        break
    }
  }
  return state
}
