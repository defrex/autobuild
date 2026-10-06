import { describe, expect, test } from 'bun:test'
import { KERNEL } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { checkIncremental, pick, seededRandom, shuffled } from '../kernel/incremental-contract'
import {
  REPOSITORY_STATE_EVENTS_REDUCER_VERSION,
  REPOSITORY_STATE_EVENT_TYPES,
  projectRepositoryStateEvents,
  repositoryStateEventsReducer,
} from './repo-state-events'

const STATE = new Set<string>(REPOSITORY_STATE_EVENT_TYPES)

function ev(seq: number, type: string): RepositoryEvent {
  return {
    repo: 'acme/a',
    seq,
    ts: new Date(Date.parse('2026-09-17T12:00:00.000Z') + seq).toISOString(),
    actor: KERNEL,
    type,
    payload: { run: 'r' },
  } as unknown as RepositoryEvent
}

/** The original two-pass derivation, as the oracle. */
function oracle(events: readonly RepositoryEvent[]): RepositoryEvent[] {
  let anchor: number | undefined
  for (const e of events) if (e.type === 'dispatcher.run-started') anchor = e.seq
  return events.filter((e) => STATE.has(e.type) || (anchor !== undefined && e.seq >= anchor))
}

const TYPES = [
  'harvest.started',
  'orchestrator.sandbox.provisioned',
  'dispatcher.intake-set',
  'dispatcher.tick-started',
  'dispatcher.tick-completed',
  'dispatcher.run-stopped',
  'dispatcher.config-reloaded',
]

/** Random journals. `ordered` keeps run-started seqs nondecreasing in array
 * order (every real read); other events are shuffled around them. */
function generated(seed: number, shuffleAll: boolean): RepositoryEvent[] {
  const rand = seededRandom(seed)
  const n = 5 + Math.floor(rand() * 25)
  const log: RepositoryEvent[] = []
  for (let seq = 1; seq <= n; seq++) {
    log.push(ev(seq, rand() < 0.15 ? 'dispatcher.run-started' : pick(rand, TYPES)))
  }
  if (shuffleAll) return shuffled(rand, log)
  // Shuffle non-run-started events only, keeping run-started in array order.
  const slots = log.map((e, i) => (e.type === 'dispatcher.run-started' ? -1 : i))
  const others = shuffled(
    rand,
    log.filter((e) => e.type !== 'dispatcher.run-started'),
  )
  let next = 0
  return log.map((e, i) => (slots[i] === -1 ? e : (others[next++] as RepositoryEvent)))
}

const fixtures: Record<string, RepositoryEvent[]> = {
  empty: [],
  noAnchor: [ev(1, 'harvest.started'), ev(2, 'dispatcher.tick-started')],
  anchored: [
    ev(1, 'dispatcher.run-started'),
    ev(2, 'dispatcher.tick-started'),
    ev(3, 'harvest.started'),
    ev(4, 'dispatcher.run-stopped'),
    ev(5, 'dispatcher.run-started'),
    ev(6, 'dispatcher.tick-started'),
    ev(7, 'dispatcher.tick-completed'),
  ],
  anchorLast: [ev(1, 'dispatcher.tick-started'), ev(2, 'dispatcher.run-started')],
}

describe('repositoryStateEventsReducer', () => {
  test('version starts at 1', () => {
    expect(REPOSITORY_STATE_EVENTS_REDUCER_VERSION).toBe(1)
  })

  for (const [name, log] of Object.entries(fixtures)) {
    test(`contract on fixture: ${name}`, () => {
      expect(projectRepositoryStateEvents(log)).toEqual(oracle(log))
      checkIncremental(repositoryStateEventsReducer, log)
    })
  }

  for (let seed = 1; seed <= 20; seed++) {
    test(`contract on generated journal, anchors in order, other events shuffled: seed ${seed}`, () => {
      const log = generated(seed, false)
      expect(projectRepositoryStateEvents(log)).toEqual(oracle(log))
      checkIncremental(repositoryStateEventsReducer, log)
    })
  }

  test('whole-array form is exact for a fully shuffled journal', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const log = generated(seed, true)
      expect(projectRepositoryStateEvents(log)).toEqual(oracle(log))
    }
  })

  test('the carried state drops events below the anchor', () => {
    const acc = repositoryStateEventsReducer.advance(
      repositoryStateEventsReducer.initial(),
      fixtures.anchored as RepositoryEvent[],
    )
    expect(acc.anchor).toBe(5)
    expect(acc.retained.map((e) => e.seq)).toEqual([3, 5, 6, 7])
  })
})
