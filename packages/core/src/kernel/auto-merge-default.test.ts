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
  // A created build: `build.created` has landed, so `lastSeq > 0`. The empty
  // log (lastSeq 0) is its own excluded case, tested below.
  const state = { ...reduceBuild([]), lastSeq: 1 }
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

  test('with an enabled filter, the newest fact matching that value wins', () => {
    const journal = [defaultSet(3, true), defaultSet(6, false), defaultSet(8, true)]
    expect(latestAutoMergeDefault(journal, true)).toEqual({
      enabled: true,
      seq: 8,
      actor: operator,
    })
    expect(latestAutoMergeDefault(journal, false)).toEqual({
      enabled: false,
      seq: 6,
      actor: operator,
    })
    // A journal whose newest ON fact is older than an OFF fact: the filtered
    // scan is what lets a stale-ON claim seed cite seq 3, leaving the OFF fact
    // (seq 6) strictly newer than the seed's provenance (f_b851c0e8).
    expect(latestAutoMergeDefault([defaultSet(3, true), defaultSet(6, false)], true)).toEqual({
      enabled: true,
      seq: 3,
      actor: operator,
    })
    expect(latestAutoMergeDefault([defaultSet(6, false)], true)).toBeUndefined()
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

  test('an outstanding discard request excludes a build on its way out', () => {
    // `discardRequest` is present exactly while a discard request is
    // outstanding and the build is non-terminal — the reducer settles it only
    // by terminal completion (reducer.ts), symmetric with the pending-abort
    // clause above. Direction-blind: an OFF fan-out skipping it withdraws
    // nothing that survives the settlement.
    expect(
      autoMergeDefaultEligible(
        build({ status: 'queued', discardRequest: { seq: 4, actor: operator } }),
      ),
    ).toBe(false)
    // The inert, raced-runner-attachment shape: the discard landed in the
    // queued window before the runner attached, leaving a running build that
    // carries the request.
    expect(
      autoMergeDefaultEligible(
        build({ status: 'running', discardRequest: { seq: 4, actor: operator } }),
      ),
    ).toBe(false)
  })

  test('a record with no build.created yet — an empty log — is excluded', () => {
    // The crash or one-await window between `createBuild` and the first
    // append: an auto-merge command written ahead of `build.created` would
    // leave the log unrecoverable for dispatch recovery (f_647d40be).
    expect(autoMergeDefaultEligible(reduceBuild([]))).toBe(false)
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

  test('records a matching fact as observed so a later per-build toggle stands', () => {
    // The state already matches the fact, but the fact is not yet answered:
    // the tick must advance provenance (as an observed marker, not a duplicate
    // command), or the next per-build toggle is reverted on the tick after it
    // (f_28b3fba1).
    expect(autoMergeDefaultTarget(build({ autoMerge: { requested: true } }), ON)).toBe('observed')
    expect(autoMergeDefaultTarget(build({ autoMerge: { requested: false } }), OFF)).toBe('observed')

    // A no-op fact recorded as observed, then a bare per-build command that
    // flips the state: the command stands against the same fact.
    expect(
      autoMergeDefaultTarget(build({ autoMerge: { requested: true, defaultSeq: OFF.seq } }), OFF),
    ).toBeUndefined()
    expect(
      autoMergeDefaultTarget(build({ autoMerge: { requested: false, defaultSeq: ON.seq } }), ON),
    ).toBeUndefined()

    // Provenance already current (or newer): nothing at all.
    expect(
      autoMergeDefaultTarget(build({ autoMerge: { requested: true, defaultSeq: ON.seq } }), ON),
    ).toBeUndefined()
    expect(
      autoMergeDefaultTarget(build({ autoMerge: { requested: false, defaultSeq: OFF.seq } }), OFF),
    ).toBeUndefined()
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

  test('an in-flight discard is never a fan-out target, either direction', () => {
    const doomed = build({ status: 'queued', discardRequest: { seq: 4, actor: operator } })
    expect(autoMergeDefaultTarget(doomed, ON)).toBeUndefined()
    expect(autoMergeDefaultTarget(doomed, OFF)).toBeUndefined()
  })
})
