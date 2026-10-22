import { DISPATCHER } from '../packages/core/src/events/envelope'
import {
  validateRepositoryEventWrite,
  type RepositoryEvent,
} from '../packages/core/src/events/repository'
import {
  buildDashboardFromProjected,
  type DashboardModel,
} from '../packages/core/src/cli/dashboard/model'

export const HANDOFF_DEADLINE = '2026-07-15T12:15:00.000Z'
export function handoffEvents(
  slug: string,
  stage: 'active' | 'settled' | 'completed' = 'active',
): RepositoryEvent[] {
  const runtime = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    source: { kind: 'package' as const, location: '/runtime/old' },
  }
  const identity = {
    correlation: 'capture-upgrade',
    run: 'old',
    lineage: 'capture',
    from: runtime,
    to: { ...runtime, version: '1.1.0', commit: 'b'.repeat(40) },
    root: '/runtime/new',
    cacheId: 'new',
    target: { mode: 'installed' as const, key: 'new', source: '/runtime' },
  }
  const entries: [string, unknown][] = [
    ['dispatcher.target-prepared', identity],
    [
      'dispatcher.yield-requested',
      { ...identity, successor: 'new', mode: 'drain', evidence: 'compatible' },
    ],
    [
      'dispatcher.handoff-started',
      {
        ...identity,
        successor: 'new',
        mode: 'drain',
        deadline: HANDOFF_DEADLINE,
        builds: [{ slug, instance: 'old-execution' }],
      },
    ],
  ]
  if (stage !== 'active')
    entries.push([
      'dispatcher.drain-settled',
      { ...identity, slug, instance: 'old-execution', outcome: 'drained' },
    ])
  if (stage === 'completed')
    entries.push(['dispatcher.handoff-completed', { ...identity, successor: 'new' }])
  return entries.map(
    ([type, payload], index) =>
      ({
        ...validateRepositoryEventWrite({ actor: DISPATCHER, type, payload }),
        repo: 'capture',
        seq: index + 1,
        ts: '2026-07-15T12:10:00.000Z',
      }) as RepositoryEvent,
  )
}

export function handoffCapture(
  model: DashboardModel,
  stage: 'active' | 'settled' | 'completed' = 'active',
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
    handoffEvents(model.builds[0]?.slug ?? 'old-build', stage),
  )
  return { ...model, builds: frame.builds, handoffs: frame.handoffs }
}
