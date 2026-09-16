import { describe, expect, test } from 'bun:test'
import { KERNEL, humanActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { reduceBuild, type BuildState } from './reducer'
import {
  autoMergeDefaultEligible,
  autoMergeDefaultTarget,
  latestAutoMergeDefault,
  type AutoMergeDefaultFact,
} from './auto-merge-default'

const repo = 'acme/repo'
const ts = '2026-07-20T00:00:00.000Z'
const operator = humanActor('toggling-operator')

function defaultSet(seq: number, enabled: boolean, actor = operator): RepositoryEvent {
  return {
    repo,
    seq,
    ts,
    actor,
    type: 'dispatcher.auto-merge-default-set',
    payload: { enabled },
  }
}

const ON: AutoMergeDefaultFact = { enabled: true, seq: 7, actor: operator }
const OFF: AutoMergeDefaultFact = { enabled: false, seq: 9, actor: operator }

function build(over: Partial<BuildState> = {}): BuildState {
  const state = reduceBuild([])
  return { ...state, ...over }
}

describe('latestAutoMergeDefault', () => {
  test('undefined for a journal with no default fact', () => {
    expect(latestAutoMergeDefault([])).toBeUndefined()
  })

  test('the newest fact wins, scanning from the tail', () => {
    expect(
      latestAutoMergeDefault([
        defaultSet(3, true),
        defaultSet(4, true),
        { repo, seq: 5, ts, actor: KERNEL, type: 'harvest.paused', payload: {} },
        defaultSet(6, false),
      ]),
    ).toEqual({ enabled: false, seq: 6, actor: operator })
  })

  test('the fact carries the toggling human actor verbatim (via marker included)', () => {
    const delegated = humanActor('the-operator', { kind: 'session', id: 'os_1' })
    expect(latestAutoMergeDefault([defaultSet(2, true, delegated)])?.actor).toEqual(delegated)
  })
})

describe('autoMergeDefaultEligible', () => {
  test('terminal builds are excluded', () => {
    expect(autoMergeDefaultEligible(build({ status: 'done' }))).toBe(false)
    expect(autoMergeDefaultEligible(build({ status: 'aborted' }))).toBe(false)
  })

  test('a pending abort excludes a build on its way out', () => {
    expect(
      autoMergeDefaultEligible(
        build({
          status: 'running',
          pendingCommands: [{ command: 'abort', seq: 4, reason: undefined, actor: operator }],
        }),
      ),
    ).toBe(false)
  })

  test('queued, running, paused, and blocked builds are eligible', () => {
    for (const status of ['queued', 'running', 'paused', 'blocked'] as const) {
      expect(autoMergeDefaultEligible(build({ status }))).toBe(true)
    }
  })
})

describe('autoMergeDefaultTarget', () => {
  test('requests on a strictly newer seq', () => {
    const state = build({ autoMerge: { requested: false } })
    expect(autoMergeDefaultTarget(state, ON)).toBe('request')
  })

  test('no-ops when the requested state already equals the default', () => {
    expect(autoMergeDefaultTarget(build({ autoMerge: { requested: true } }), ON)).toBeUndefined()
    expect(autoMergeDefaultTarget(build({ autoMerge: { requested: false } }), OFF)).toBeUndefined()
  })

  test('no-ops when the build already answered this fact — the per-build-override case', () => {
    // A per-build cancel made after the ON fan-out: provenance is current, the
    // requested state disagrees, and the override stands until the default
    // moves again.
    expect(
      autoMergeDefaultTarget(
        build({ autoMerge: { requested: false, commandSeq: 8, defaultSeq: 7 } }),
        ON,
      ),
    ).toBeUndefined()
    // The same for an explicit ON seed sampled from this fact at claim time.
    expect(
      autoMergeDefaultTarget(
        build({ autoMerge: { requested: true, commandSeq: 8, defaultSeq: 7 } }),
        ON,
      ),
    ).toBeUndefined()
  })

  test('cancels when turning off, and re-applies after a newer fact', () => {
    const consented = build({ autoMerge: { requested: true, commandSeq: 5, defaultSeq: 3 } })
    expect(autoMergeDefaultTarget(consented, OFF)).toBe('cancel')
    // After answering the OFF fact, a newer ON fact re-requests.
    const withdrawn = build({
      autoMerge: { requested: false, commandSeq: 10, defaultSeq: 9 },
    })
    expect(autoMergeDefaultTarget(withdrawn, { ...ON, seq: 12 })).toBe('request')
  })

  test('ineligible builds are never targets', () => {
    expect(autoMergeDefaultTarget(build({ status: 'done' }), ON)).toBeUndefined()
    expect(autoMergeDefaultTarget(build({ status: 'aborted' }), OFF)).toBeUndefined()
  })
})
