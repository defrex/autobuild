/** Overlapping dispatcher-run journals for the reported-dispatch-run tests
 * (#1279): hosted cron invocations that yield, and ones that take over. */
import { DISPATCHER, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'

const COUNTERS = {
  merged: 0,
  closed: 0,
  conflicted: 0,
  abandoned: 0,
  discarded: 0,
  janitorFailed: 0,
  recovered: 0,
  dispatchFailed: 0,
  resumed: 0,
  swept: 0,
  dispatched: 0,
  authored: 0,
  bounced: 0,
  claimRaces: 0,
  invalidTickets: 0,
  dependencyBlocked: 0,
  harvestStarted: 0,
  harvestResumed: 0,
  harvestCompleted: 0,
  harvestEscalated: 0,
  harvestFailed: 0,
}

/** Builds a repository journal with consecutive seqs. */
export function dispatchJournal(repo = '/repo') {
  const events: RepositoryEvent[] = []
  const push = <T extends RepositoryEvent['type']>(
    type: T,
    payload: Extract<RepositoryEvent, { type: T }>['payload'],
  ): RepositoryEvent => {
    const seq = events.length + 1
    const event = {
      repo,
      seq,
      ts: new Date(seq * 1_000).toISOString(),
      actor: type === 'dispatcher.operator-reported' ? humanActor('operator') : DISPATCHER,
      type,
      payload,
    } as RepositoryEvent
    events.push(event)
    return event
  }
  return {
    events,
    start: (run: string, rev = 0, roleWarnings: string[] = []) =>
      push('dispatcher.run-started', {
        run,
        pid: 1,
        effectiveConfig: { kind: 'dispatcher-effective-config', rev },
        roleWarnings,
      }),
    tick: (run: string, queued: number, diagnostics: string[] = [], triage?: number) => {
      push('dispatcher.tick-started', { run })
      return push('dispatcher.tick-completed', {
        run,
        queued,
        counters: COUNTERS,
        janitorDiagnostics: diagnostics,
        ticketDiagnostics: [],
        dependencyDiagnostics: [],
        ...(triage === undefined ? {} : { triage }),
      })
    },
    forgeFailure: (run: string) =>
      push('dispatcher.forge-readiness-failed', {
        run,
        forge: 'github',
        rootBranch: 'main',
        check: 'squash',
        detail: `${run} cannot squash`,
        remediation: 'enable squash merges',
      }),
    yielded: (run: string, holder: string) => push('dispatcher.tick-yielded', { run, holder }),
    stop: (run: string, outcome: 'normal' | 'abnormal' = 'normal', reason?: 'superseded') =>
      push('dispatcher.run-stopped', {
        run,
        outcome,
        ...(reason === undefined ? {} : { reason }),
      }),
    push,
  }
}

/** Holder A ticks with every start and tick fact; newcomer B starts, yields
 * and stops; A then ticks again with queue 11. Mirrors the flint evidence. */
export function yieldedNewcomerJournal(): RepositoryEvent[] {
  const j = dispatchJournal()
  j.start('run-a', 0, ['A role warning'])
  j.forgeFailure('run-a')
  j.push('dispatcher.upgrade-available', { run: 'run-a', version: '9.9.9' })
  j.push('dispatcher.operator-reported', { run: 'run-a', level: 'warning', message: 'A notice' })
  j.tick('run-a', 4, ['A first diagnostic'], 3)
  j.start('run-b', 1, ['B role warning'])
  j.yielded('run-b', 'run-a')
  j.stop('run-b')
  j.tick('run-a', 11, ['A later diagnostic'], 3)
  return j.events
}

/** Holder A ticks; newcomer B records its own start facts, then takes over
 * with a tick boundary while A is live; A then stops as superseded. */
export function takeoverJournal(): RepositoryEvent[] {
  const j = dispatchJournal()
  j.start('run-a', 0, ['A role warning'])
  j.tick('run-a', 4)
  j.start('run-b', 1, ['B role warning'])
  j.forgeFailure('run-b')
  j.tick('run-b', 7)
  j.stop('run-a', 'normal', 'superseded')
  return j.events
}
