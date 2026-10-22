import { DISPATCHER } from '../packages/core/src/events/envelope'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
} from '../packages/core/src/events/repository'
import {
  buildDashboardFromProjected,
  type DashboardModel,
} from '../packages/core/src/cli/dashboard/model'

export const ROLLBACK_AT = '2026-07-15T12:10:00.000Z'
export function rollbackFact(type: string, payload: unknown, seq = 1): RepositoryEvent {
  return {
    ...validateRepositoryEventWrite({ actor: DISPATCHER, type, payload }),
    repo: 'capture',
    seq,
    ts: ROLLBACK_AT,
  } as RepositoryEvent
}

export function rollbackRun(run: string, lineage?: string): RepositoryEvent {
  return rollbackFact('dispatcher.run-started', {
    run,
    ...(lineage ? { lineage } : {}),
    pid: 123,
    effectiveConfig: { kind: 'dispatcher-effective-config', rev: 0 },
    roleWarnings: [],
  })
}

export function rollbackEvents(
  stage: 'active' | 'cleared' | 'restarted' = 'active',
): RepositoryEvent[] {
  const restored = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    source: { kind: 'package' as const, location: '/runtime/old' },
  }
  const target = { mode: 'installed' as const, key: 'failed', source: '/runtime' }
  const events = [
    rollbackRun('restored', 'capture'),
    rollbackFact('dispatcher.runtime-rolled-back', {
      correlation: 'capture-rollback',
      run: 'restored',
      lineage: 'capture',
      predecessor: 'old',
      successor: 'failed',
      handoff: 'capture-upgrade',
      takeoverAt: '2026-07-15T12:00:00.000Z',
      failures: 3,
      failed: { ...restored, version: '1.1.0', commit: 'b'.repeat(40) },
      restored,
      failedRoot: '/runtime/new',
      restoredRoot: '/runtime/old',
      target,
      reason: 'three failed exits',
    }),
  ]
  if (stage === 'cleared')
    events.push(
      rollbackFact('dispatcher.rollback-hold-cleared', {
        correlation: 'capture-rollback',
        run: 'restored',
        lineage: 'capture',
        target: { ...target, key: 'replacement' },
      }),
    )
  if (stage === 'restarted')
    events.push(
      rollbackRun('operator', 'fresh'),
      rollbackFact('dispatcher.tick-started', { run: 'operator' }),
    )
  return events.map((event, index) => ({ ...event, seq: index + 1 }))
}

export function rollbackCapture(
  model: DashboardModel,
  stage: 'active' | 'cleared' | 'restarted' = 'active',
): DashboardModel {
  const frame = buildDashboardFromProjected(
    model.builds,
    {
      repo: model.repo,
      queued: model.queued,
      activeCount: model.active.current,
      capacity: model.active.limit,
      observationCount: model.observations.current,
      observationLimit: model.observations.limit,
    },
    rollbackEvents(stage),
  )
  return { ...model, rollback: frame.rollback }
}
