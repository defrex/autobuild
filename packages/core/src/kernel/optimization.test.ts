import { describe, expect, test } from 'bun:test'
import {
  OptimizationLogBuilder,
  commandObjective,
  optimizationLog,
  panelObjective,
  panelOptimizationLog,
} from './generators/optimization-log'
import { attemptCreationKey } from './attempt-creation-key'
import {
  exhaustedStopDue,
  isNearMiss,
  isProposerWakeEvent,
  optimizationSignal,
  proposalEligible,
  proposalFilingDue,
  proposalWithdrawalDue,
  proposeAdmissible,
  proposerAdmissible,
  proposerBlocker,
  proposerRoom,
  proposeRunDue,
  proposeStarted,
  PROPOSER_WAKE_EVENT_TYPES,
  signalDue,
  optimizationAdmission,
  optimizationAttempt,
  optimizationCompletionBlocker,
  optimizationElapsedHours,
  optimizationLedgerReducer,
  optimizationProposerAdmissible,
  optimizationReducer,
  optimizationRejection,
  optimizationStopActions,
  optimizationStopCause,
  optimizationStopEligibility,
  type OptimizationAttemptBuild,
  type OptimizationState,
} from './optimization'
import { integrationComplete } from './integration-state'
import { reduceBuild } from './reducer'
import { DISPATCHER as DISPATCHER_ACTOR } from '../events/envelope'
import { terminalGuardReducer } from './terminal-guard'
import { reduceBuildDigest } from '../store/digest'
import { REDUCERS } from './reducer-registry'
import { DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import { OPTIMIZATION_SHA } from './generators/optimization-log'

/** Digest rows exactly as the store's adapter builds them. */
function digestRows(events: readonly import('../events/catalog').AbEvent[]) {
  const read = REDUCERS.buildDigest!.valueRead
  if ('excluded' in read) throw new Error('buildDigest has no value read')
  return read.adapt(events as never) as Parameters<typeof reduceBuildDigest>[0]
}

const START = Date.parse('2026-11-17T00:00:00Z')
const at = (hours: number) => new Date(START + hours * 3_600_000)

/** `hours` of one attempt run on the node's clock, ending at the builder's
 * clock after it advances by `hours`. */
function ran(builder: OptimizationLogBuilder, hours: number, build = 'attempt-run') {
  return builder.wait(hours * 60).activity([
    [build, 1, 'started', 'run', hours * 60],
    [build, 2, 'ended', 'run', 0],
  ])
}

function digest(builder: OptimizationLogBuilder): OptimizationState {
  const state = optimizationReducer.reduce(builder.events)
  if (state === null) throw new Error('no objective accepted')
  return state
}

describe('optimization digest', () => {
  test('derives every field from a command node log', () => {
    const state = digest(Object.assign(new OptimizationLogBuilder(), { events: optimizationLog() }))
    expect(state.accepted).toMatchObject({ revision: 1, specRev: 0, harnessPin: 'a'.repeat(40) })
    expect(state.openedAt).toBe('2026-11-17T00:00:00.000Z')
    expect(state.revision).toBe(2)
    expect(state.revisedFields).toEqual(['threshold', 'epsilon', 'plateau'])
    expect(state.objective.target).toEqual({ threshold: 35, epsilon: { absolute: 2 } })
    expect(state.objective.stop.plateau).toEqual({ attempts: 8 })
    expect(state.rulerRevision).toBe(1)
    expect(state.starting).toEqual({ value: 50, spread: 1.6, head: 'a'.repeat(40) })
    expect(state.current).toBe(44)
    expect(state.best).toBe(44)
    expect(state.attempts).toEqual({ filed: 4, accepted: 1, rejected: 3, unmeasured: 0 })
    expect(state.inFlight).toEqual([])
    expect(state.plateau).toBe(2)
    expect(state.emptyProposals).toBe(0)
    expect(state.stopped).toEqual({ cause: 'plateau', mode: 'drain', at: state.openedAt })
  })

  test('a plain build has no digest', () => {
    expect(optimizationReducer.reduce([])).toBeNull()
    expect(reduceBuild([]).optimization).toBeUndefined()
  })

  test('BuildState embeds the digest once accepted', () => {
    const log = optimizationLog()
    expect(reduceBuild(log).optimization).toEqual(optimizationReducer.reduce(log)!)
    expect(reduceBuild(log.slice(0, 1)).optimization).toBeUndefined()
  })

  test('the starting value is the baseline median and current falls back to it', () => {
    const state = digest(
      new OptimizationLogBuilder().accept(commandObjective(), 1).baseline(1, 50, 2),
    )
    expect(state.starting?.value).toBe(50)
    expect(state.current).toBe(50)
    expect(state.best).toBe(50)
  })

  test('best follows the direction and current follows the latest accepted head', () => {
    const maximize = commandObjective({
      metric: { ...commandObjective().metric, direction: 'maximize' } as never,
    })
    const state = digest(
      new OptimizationLogBuilder()
        .accept(maximize, 1)
        .baseline(1, 10, 1)
        .propose('r', ['a', 'b'])
        .settle('a', 'accepted', { revision: 1, baseline: 10, candidate: 14, delta: 4 })
        .settle('b', 'accepted', { revision: 1, baseline: 14, candidate: 12, delta: -2 }),
    )
    expect(state.current).toBe(12)
    expect(state.best).toBe(14)
  })

  test('a panel starts at 0.5 and its current value is the head-against-start win rate', () => {
    const state = optimizationReducer.reduce(panelOptimizationLog())!
    expect(state.starting).toEqual({ value: 0.5, spread: 0.05, head: 'a'.repeat(40) })
    expect(state.current).toBe(0.7)
    expect(state.best).toBe(0.7)
    expect(state.progressQueue).toEqual(['d'.repeat(40)])
    const before = digest(new OptimizationLogBuilder().accept(panelObjective(), 1))
    expect(before.current).toBe(0.5)
  })

  test('the plateau counter counts no-improvement and declined, resets on accepted, holds through stopped and aborted', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .baseline(1, 50, 1)
      .propose('r', ['a', 'b', 'c', 'd', 'e', 'f'])
      .settle('a', 'no-improvement', { revision: 1, baseline: 50, candidate: 50, delta: 0 })
      .settle('b', 'declined')
    expect(digest(builder).plateau).toBe(2)
    builder.settle('c', 'stopped').settle('d', 'aborted')
    expect(digest(builder).plateau).toBe(2)
    builder.settle('e', 'accepted', { revision: 1, baseline: 50, candidate: 45, delta: 5 })
    expect(digest(builder).plateau).toBe(0)
    builder.settle('f', 'declined')
    const state = digest(builder)
    expect(state.plateau).toBe(1)
    expect(state.attempts).toEqual({ filed: 6, accepted: 1, rejected: 5, unmeasured: 0 })
  })

  test('running attempts are the unsettled proposals', () => {
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .propose('r', ['a', 'b', 'c'])
        .settle('b', 'declined'),
    )
    expect(state.inFlight.map((attempt) => attempt.proposal)).toEqual(['a', 'c'])
  })

  test('consecutive empty proposals are counted', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r1', [], 'none')
      .propose('r2', [], 'none')
    expect(digest(builder).emptyProposals).toBe(2)
    builder.propose('r3', ['a'])
    expect(digest(builder).emptyProposals).toBe(0)
  })

  test('a metric-changing re-acceptance starts a new ruler and ignores older measurements', () => {
    const changed = commandObjective({
      metric: { ...commandObjective().metric, harness: ['bench/v2/**'] } as never,
    })
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .baseline(1, 50, 1)
      .propose('r', ['a', 'b'])
      .settle('a', 'accepted', { revision: 1, baseline: 50, candidate: 44, delta: 6 })
      .revise({ threshold: 30 }, 2)
      .accept(changed, 3, 1)
    let state = digest(builder)
    expect(state.rulerRevision).toBe(3)
    expect(state.revision).toBe(3)
    expect(state.revisedFields).toEqual([])
    expect(state.objective.target.threshold).toBe(40)
    expect(state.starting).toBeUndefined()
    expect(state.current).toBeUndefined()
    // A measurement taken under the old ruler is history.
    builder.settle('b', 'accepted', { revision: 2, baseline: 44, candidate: 40, delta: 4 })
    state = digest(builder)
    expect(state.current).toBeUndefined()
    builder.baseline(3, 60, 2, 'c'.repeat(40))
    state = digest(builder)
    expect(state.starting).toEqual({ value: 60, spread: 2, head: 'c'.repeat(40) })
    expect(state.current).toBe(60)
    expect(state.attempts.accepted).toBe(2)
  })

  test('a re-acceptance with the same metric keeps the ruler and its values', () => {
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .baseline(1, 50, 1)
        .accept(commandObjective({ purpose: 'reworded' }), 2, 1),
    )
    expect(state.rulerRevision).toBe(1)
    expect(state.starting?.value).toBe(50)
    expect(state.objective.purpose).toBe('reworded')
  })

  test('the first stop is kept', () => {
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .stop('budget', 'abort')
        .stop('operator', 'drain'),
    )
    expect(state.stopped).toMatchObject({ cause: 'budget', mode: 'abort' })
  })
})

describe('optimization selectors', () => {
  test('budget hours are active hours, never time since opening', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .wait(90)
      .accept(commandObjective(), 2)
    expect(optimizationElapsedHours(digest(builder), at(3))).toBe(0)
    ran(builder, 2)
    expect(optimizationElapsedHours(digest(builder), at(3.5))).toBe(2)
    expect(optimizationElapsedHours(digest(builder), at(10))).toBe(2)
  })

  test('threshold eligibility follows the direction', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .baseline(1, 50, 1)
      .propose('r', ['a'])
    expect(optimizationStopEligibility(digest(builder), at(0)).threshold).toBe(false)
    builder.settle('a', 'accepted', { revision: 1, baseline: 50, candidate: 40, delta: 10 })
    expect(optimizationStopEligibility(digest(builder), at(0)).threshold).toBe(true)

    const panel = new OptimizationLogBuilder()
      .accept(panelObjective(), 1)
      .baseline(1, 0.5, 0)
      .progress(1, 0.79)
    expect(optimizationStopEligibility(digest(panel), at(0)).threshold).toBe(false)
    panel.progress(1, 0.8)
    expect(optimizationStopEligibility(digest(panel), at(0)).threshold).toBe(true)
  })

  test('a panel threshold reads recorded progress against the start, never a settlement win rate', () => {
    const panel = new OptimizationLogBuilder()
      .accept(panelObjective(), 1)
      .baseline(1, 0.5, 0)
      .propose('r', ['a'])
      .settle(
        'a',
        'accepted',
        { revision: 1, baseline: 0.5, candidate: 0.9, delta: 0.4 },
        undefined,
        { head: 'c'.repeat(40) },
      )
    expect(digest(panel).current).toBe(0.5)
    expect(optimizationStopCause(digest(panel), at(0))).toBeUndefined()
    panel.progress(1, 0.8, 'c'.repeat(40))
    expect(optimizationStopCause(digest(panel), at(0))).toBe('threshold')
    expect(digest(panel).progressQueue).toBeUndefined()
  })

  test('no threshold is never eligible', () => {
    const objective = commandObjective({ target: { epsilon: { absolute: 1 } } })
    const state = digest(new OptimizationLogBuilder().accept(objective, 1).baseline(1, 0, 0))
    expect(optimizationStopEligibility(state, at(0)).threshold).toBe(false)
  })

  test('plateau eligibility uses the effective limit', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r', ['a', 'b'])
      .settle('a', 'declined')
      .settle('b', 'declined')
    expect(optimizationStopEligibility(digest(builder), at(0)).plateau).toBe(false)
    builder.revise({ plateau: 2 }, 2)
    expect(optimizationStopEligibility(digest(builder), at(0)).plateau).toBe(true)
    const none = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective({ stop: { mode: 'abort' } }), 1)
        .propose('r', ['a'])
        .settle('a', 'declined'),
    )
    expect(optimizationStopEligibility(none, at(0)).plateau).toBe(false)
  })

  test('budget eligibility names its cause', () => {
    const objective = commandObjective({ budget: { maxAttempts: 2, maxHours: 5 } })
    const builder = ran(new OptimizationLogBuilder().accept(objective, 1), 4).propose('r', ['a'])
    expect(optimizationStopEligibility(digest(builder), at(4))).toEqual({
      threshold: false,
      plateau: false,
      budget: false,
    })
    ran(builder, 1, 'attempt-more')
    expect(optimizationStopEligibility(digest(builder), at(5))).toMatchObject({
      budget: true,
      budgetCause: 'hours',
    })
    builder.propose('r2', ['b'])
    expect(optimizationStopEligibility(digest(builder), at(5))).toMatchObject({
      budget: true,
      budgetCause: 'attempts',
    })
  })

  test('admission reports stop, attempt room and free slots', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective({ budget: { maxAttempts: 5 } }), 1)
      .propose('r', ['a', 'b', 'c'])
    expect(optimizationAdmission(digest(builder), at(0))).toEqual({
      stopped: false,
      attemptRoom: 2,
      slots: 1,
    })
    builder.settle('a', 'declined').revise({ concurrency: 1 }, 2)
    expect(optimizationAdmission(digest(builder), at(0))).toEqual({
      stopped: false,
      attemptRoom: 2,
      slots: 0,
    })
    builder.stop('operator', 'abort')
    expect(optimizationAdmission(digest(builder), at(0)).stopped).toBe(true)
    const hoursOnly = digest(
      new OptimizationLogBuilder().accept(commandObjective({ budget: { maxHours: 1 } }), 1),
    )
    expect(optimizationAdmission(hoursOnly, at(0)).attemptRoom).toBeNull()
  })

  test('an attempt is a build whose ticket a recorded proposal created', () => {
    const state = digest(
      new OptimizationLogBuilder().accept(commandObjective(), 1).propose('r', ['a']),
    )
    expect(optimizationAttempt(state, { source: 'file', id: 'T-a' })).toEqual({
      proposal: 'a',
      ticket: { source: 'file', id: 'T-a' },
    })
    expect(optimizationAttempt(state, { source: 'file', id: 'T-other' })).toBeUndefined()
    expect(optimizationAttempt(undefined, { source: 'file', id: 'T-a' })).toBeUndefined()
  })

  test('revisions leave running attempts and counts unchanged', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r', ['a', 'b'])
    const before = digest(builder)
    builder.revise({ threshold: 10, maxHours: 100, stopMode: 'drain' }, 2)
    const after = digest(builder)
    expect(after.inFlight).toEqual(before.inFlight)
    expect(after.attempts).toEqual(before.attempts)
    expect(after.revisedFields).toEqual(['threshold', 'maxHours', 'stopMode'])
  })
})

describe('pending rejections', () => {
  test('a non-accepted settlement transfers the attempt from inFlight until its ticket moves', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r', ['a', 'b', 'c'])
      .settle('a', 'no-improvement', { revision: 1, baseline: 50, candidate: 49.9, delta: 0.1 })
      .settle('b', 'accepted', { revision: 1, baseline: 50, candidate: 40, delta: 10 })
    let state = digest(builder)
    expect(state.inFlight.map((entry) => entry.proposal)).toEqual(['c'])
    expect(state.rejections).toEqual([
      {
        proposal: 'a',
        ticket: { source: 'file', id: 'T-a' },
        build: 'attempt-a',
        outcome: 'no-improvement',
      },
    ])
    expect(optimizationRejection(state, { source: 'file', id: 'T-a' })?.proposal).toBe('a')
    expect(optimizationRejection(state, { source: 'file', id: 'T-b' })).toBeUndefined()
    builder.settle('a', 'aborted')
    expect(digest(builder).rejections).toHaveLength(1)
    builder.ticketRejected('a')
    state = digest(builder)
    expect(state.rejections).toEqual([])
    expect(optimizationRejection(state, { source: 'file', id: 'T-a' })).toBeUndefined()
  })

  test('a settlement for a proposal that was not in flight adds no entry', () => {
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .propose('r', ['a'])
        .settle('ghost', 'stopped'),
    )
    expect(state.rejections).toEqual([])
    expect(state.inFlight.map((entry) => entry.proposal)).toEqual(['a'])
  })

  test('every non-accepted outcome is pending, and entries survive a ruler change', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r', ['a', 'b', 'c', 'd'])
      .settle('a', 'no-improvement', { revision: 1, baseline: 50, candidate: 50, delta: 0 })
      .settle('b', 'declined')
      .settle('c', 'stopped')
      .settle('d', 'aborted')
      .accept(
        commandObjective({
          metric: {
            kind: 'command',
            command: 'bun bench/other.ts',
            direction: 'minimize',
            samples: 7,
            harness: ['bench/search/**'],
          },
        }),
        2,
      )
    expect(digest(builder).rejections.map((entry) => entry.outcome)).toEqual([
      'no-improvement',
      'declined',
      'stopped',
      'aborted',
    ])
  })

  test('admission counts pending rejections as occupied slots', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective({ proposer: { concurrency: 2 } }), 1)
      .baseline(1, 100, 0)
      .propose('r', ['a', 'b'])
      .settle('a', 'declined')
    expect(optimizationAdmission(digest(builder), at(0)).slots).toBe(0)
    expect(proposerRoom(digest(builder), at(0))).toBe(0)
    expect(signalDue(optimizationSignal(digest(builder)), at(0))).toBeUndefined()
    builder.ticketRejected('a')
    expect(optimizationAdmission(digest(builder), at(0)).slots).toBe(1)
    expect(proposerRoom(digest(builder), at(0))).toBe(1)
    expect(signalDue(optimizationSignal(digest(builder)), at(0))).toBe('request')
  })

  test('inFlight plus rejections never exceeds concurrency under admission', () => {
    // A seeded walk over proposals, settlements and delayed or failing moves.
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const concurrency = 3
    const builder = new OptimizationLogBuilder().accept(
      commandObjective({ proposer: { concurrency } }),
      1,
    )
    let next = 0
    for (let step = 0; step < 400; step += 1) {
      const state = digest(builder)
      expect(state.inFlight.length + state.rejections.length).toBeLessThanOrEqual(concurrency)
      const roll = random()
      if (roll < 0.35) {
        const slots = optimizationAdmission(state, at(0)).slots
        if (slots > 0)
          builder.propose(
            `r${step}`,
            Array.from({ length: Math.ceil(random() * slots) }, () => `p${next++}`),
          )
      } else if (roll < 0.7 && state.inFlight.length > 0) {
        const attempt = state.inFlight[Math.floor(random() * state.inFlight.length)]!
        const outcomes = [
          'declined',
          'stopped',
          'aborted',
          'accepted',
          'merged-unmeasured',
        ] as const
        const outcome = outcomes[Math.floor(random() * outcomes.length)]!
        if (outcome === 'merged-unmeasured' && attempt.unmeasuredMerge === undefined)
          builder.markUnmeasured(attempt.proposal, 'absent')
        else
          builder.settle(
            attempt.proposal,
            outcome,
            outcome === 'accepted'
              ? { revision: 1, baseline: 50, candidate: 40, delta: 10 }
              : undefined,
            undefined,
            outcome === 'merged-unmeasured'
              ? { policy: 'release-unmeasured' }
              : outcome === 'declined'
                ? { branch: `ab/attempt-${attempt.proposal}` }
                : {},
          )
      } else if (roll < 0.8 && state.rejections.length > 0) {
        // A move that succeeds; the remaining rolls model a tracker refusing it.
        const entry = state.rejections[0]!
        if (entry.branch !== undefined) builder.branchCleanup(entry.proposal, entry.branch)
        else builder.ticketRejected(entry.proposal)
      } else if (roll < 0.85 && state.rejections.some((entry) => entry.branch !== undefined)) {
        const entry = state.rejections.find((rejection) => rejection.branch !== undefined)!
        builder.branchCleanup(entry.proposal, entry.branch!, `failed at step ${step}`)
      }
    }
  })
})

describe('unmeasured merges', () => {
  const marked = () =>
    new OptimizationLogBuilder()
      .accept(commandObjective({ proposer: { concurrency: 2 } }), 1)
      .baseline(1, 50, 1.6)
      .propose('r', ['a', 'b'])
      .markUnmeasured('a', 'stale-head', undefined, 'c'.repeat(40))

  test('the marker folds onto the in-flight entry, which keeps its slot', () => {
    const state = digest(marked())
    expect(state.inFlight[0]!.unmeasuredMerge).toEqual({
      build: 'attempt-a',
      sha: 'd'.repeat(40),
      reason: 'stale-head',
      measuredCandidate: 'c'.repeat(40),
      at: state.inFlight[0]!.unmeasuredMerge!.at,
    })
    expect(optimizationAdmission(state, at(0)).slots).toBe(0)
  })

  test('a repeated marker is ignored, and a marker for a settled attempt adds nothing', () => {
    const state = digest(
      marked().markUnmeasured('a', 'absent').settle('b', 'stopped').markUnmeasured('b', 'absent'),
    )
    expect(state.inFlight).toHaveLength(1)
    expect(state.inFlight[0]!.unmeasuredMerge!.reason).toBe('stale-head')
  })

  test('merged-unmeasured releases the slot once and moves no value', () => {
    const before = digest(marked())
    const builder = marked().settle('a', 'merged-unmeasured', undefined, undefined, {
      policy: 'release-unmeasured',
      mergedSha: 'd'.repeat(40),
    })
    const state = digest(builder)
    expect(state.inFlight.map((attempt) => attempt.proposal)).toEqual(['b'])
    expect(state.rejections).toEqual([])
    expect(state.attempts).toEqual({ ...before.attempts, unmeasured: 1 })
    expect([state.current, state.best, state.plateau]).toEqual([
      before.current,
      before.best,
      before.plateau,
    ])
    expect(optimizationAdmission(state, at(0)).slots).toBe(1)
    // A duplicate settlement for the same proposal counts nothing again.
    builder.settle('a', 'merged-unmeasured', undefined, undefined, {
      policy: 'release-unmeasured',
    })
    expect(digest(builder).attempts.unmeasured).toBe(1)
  })

  test('the ledger records it without a measurement or a near miss', () => {
    const ledger = optimizationLedgerReducer.reduce(
      marked().settle('a', 'merged-unmeasured', undefined, 'released', {
        policy: 'release-unmeasured',
        mergedSha: 'd'.repeat(40),
      }).events,
    )
    const entry = ledger.entries[0]!
    expect(entry).toMatchObject({
      proposal: 'a',
      outcome: 'merged-unmeasured',
      mergedSha: 'd'.repeat(40),
      policy: 'release-unmeasured',
      note: 'released',
    })
    expect([entry.delta, entry.baseline, entry.candidate, entry.nearMiss]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test('a stopped node names unmeasured merges apart from running attempts', () => {
    const state = digest(marked().stop('operator', 'drain'))
    expect(optimizationCompletionBlocker({ optimization: state })).toBe(
      'attempts still in flight: T-b; merged without a landing measurement, awaiting operator settlement: T-a',
    )
  })
})

describe('branch cleanup obligations', () => {
  const settled = () =>
    new OptimizationLogBuilder()
      .accept(commandObjective(), 1)
      .propose('r', ['a', 'b'])
      .settle('a', 'declined', undefined, undefined, { branch: 'ab/attempt-a' })
      .settle('b', 'declined')

  test('a published settlement carries its branch into the pending rejection', () => {
    const state = digest(settled())
    expect(state.rejections.map((entry) => [entry.proposal, entry.branch])).toEqual([
      ['a', 'ab/attempt-a'],
      ['b', undefined],
    ])
  })

  test('a failure records its error; a deletion clears the obligation', () => {
    const builder = settled().branchCleanup('a', 'ab/attempt-a', 'forge down')
    expect(digest(builder).rejections[0]).toMatchObject({
      branch: 'ab/attempt-a',
      branchCleanupError: 'forge down',
    })
    builder.branchCleanup('a', 'ab/attempt-a')
    const entry = digest(builder).rejections[0]!
    expect(entry.branch).toBeUndefined()
    expect(entry.branchCleanupError).toBeUndefined()
    // The pending rejection stays until its ticket moves.
    expect(entry.proposal).toBe('a')
  })

  test('facts naming another branch or proposal change nothing', () => {
    const state = digest(
      settled().branchCleanup('a', 'ab/other').branchCleanup('b', 'ab/attempt-a', 'x'),
    )
    expect(state.rejections[0]).toMatchObject({ branch: 'ab/attempt-a' })
    expect(state.rejections[0]!.branchCleanupError).toBeUndefined()
    expect(state.rejections[1]!.branchCleanupError).toBeUndefined()
  })
})

describe('optimization stopping', () => {
  test('the stop cause follows precedence threshold, plateau, budget', () => {
    const objective = commandObjective({
      budget: { maxAttempts: 2, maxHours: 5 },
      stop: { plateau: { attempts: 1 }, mode: 'abort' },
    })
    const builder = new OptimizationLogBuilder().accept(objective, 1).baseline(1, 50, 1)
    expect(optimizationStopCause(digest(builder), at(0))).toBeUndefined()
    builder.propose('r', ['a', 'b'])
    expect(optimizationStopCause(digest(builder), at(0))).toBe('budget')
    builder.settle('a', 'declined')
    expect(optimizationStopCause(digest(builder), at(0))).toBe('plateau')
    builder.settle('b', 'accepted', { revision: 1, baseline: 50, candidate: 39, delta: 11 })
    expect(optimizationStopCause(digest(builder), at(0))).toBe('threshold')
    builder.stop('threshold', 'abort')
    expect(optimizationStopCause(digest(builder), at(0))).toBeUndefined()
  })

  test('threshold stops in the objective direction', () => {
    const maximize = commandObjective({
      metric: { ...commandObjective().metric, direction: 'maximize' } as never,
    })
    expect(
      optimizationStopCause(
        digest(new OptimizationLogBuilder().accept(maximize, 1).baseline(1, 40, 1)),
        at(0),
      ),
    ).toBe('threshold')
    expect(
      optimizationStopCause(
        digest(new OptimizationLogBuilder().accept(maximize, 1).baseline(1, 39, 1)),
        at(0),
      ),
    ).toBeUndefined()
    expect(
      optimizationStopCause(
        digest(new OptimizationLogBuilder().accept(commandObjective(), 1).baseline(1, 40, 1)),
        at(0),
      ),
    ).toBe('threshold')
  })

  test('the hours budget fires from the clock alone while a run is open', () => {
    const idle = digest(
      new OptimizationLogBuilder().accept(commandObjective({ budget: { maxHours: 2 } }), 1),
    )
    expect(optimizationStopCause(idle, at(72))).toBeUndefined()
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective({ budget: { maxHours: 2 } }), 1)
        .activity([['attempt-run', 1, 'started', 'run', 0]]),
    )
    expect(optimizationStopCause(state, at(1.9))).toBeUndefined()
    expect(optimizationStopCause(state, at(2))).toBe('budget')
  })

  test('a quick revision changes the stop cause on the next evaluation', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective({ budget: { maxAttempts: 3 } }), 1)
      .baseline(1, 50, 1)
      .propose('r', ['a', 'b'])
      .settle('a', 'declined')
      .settle('b', 'declined')
    expect(optimizationStopCause(digest(builder), at(0))).toBeUndefined()
    builder.revise({ threshold: 60 }, 2)
    expect(optimizationStopCause(digest(builder), at(0))).toBe('threshold')
    builder.revise({ threshold: 30, plateau: 2 }, 3)
    expect(optimizationStopCause(digest(builder), at(0))).toBe('plateau')
    builder.revise({ plateau: 10, maxAttempts: 2 }, 4)
    expect(optimizationStopCause(digest(builder), at(0))).toBe('budget')
    builder.revise({ maxAttempts: 20 }, 5)
    expect(optimizationStopCause(digest(builder), at(0))).toBeUndefined()
  })

  test('no proposer is admissible after a stop or while a cause is eligible', () => {
    const builder = new OptimizationLogBuilder()
      .accept(commandObjective({ budget: { maxAttempts: 3 } }), 1)
      .baseline(1, 50, 1)
    expect(optimizationProposerAdmissible(digest(builder), at(0))).toBe(true)
    builder.revise({ threshold: 60 }, 2)
    expect(optimizationProposerAdmissible(digest(builder), at(0))).toBe(false)
    builder.revise({ threshold: 30 }, 3).stop('operator', 'drain')
    expect(optimizationProposerAdmissible(digest(builder), at(0))).toBe(false)
    const full = new OptimizationLogBuilder()
      .accept(commandObjective({ proposer: { concurrency: 1 } }), 1)
      .baseline(1, 50, 1)
      .propose('r', ['a'])
    expect(optimizationProposerAdmissible(digest(full), at(0))).toBe(false)
  })

  test('stopped settlements fold into the bounded stopped-ticket list', () => {
    const state = digest(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .propose('r', ['a', 'b', 'c'])
        .stop('operator', 'abort')
        .settle('a', 'stopped')
        .settle('b', 'aborted')
        .settle('c', 'stopped'),
    )
    expect(state.stoppedTickets).toEqual([
      { source: 'file', id: 'T-a' },
      { source: 'file', id: 'T-c' },
    ])
    expect(state.inFlight).toEqual([])
    expect(state.plateau).toBe(0)
  })

  const attempt = (id: string) => ({ proposal: id, ticket: { source: 'file', id: `T-${id}` } })
  const queued = { status: 'queued' as const, pendingCommands: [] }
  const running = {
    status: 'running' as const,
    pendingCommands: [],
    currentPhase: { phase: 'implement' } as never,
  }
  const cases: [string, OptimizationAttemptBuild | undefined, string, string][] = [
    ['no build', undefined, 'settle', 'settle'],
    ['a queued build', { slug: 'b', state: queued }, 'abort', 'abort'],
    ['a running build', { slug: 'b', state: running }, 'abort', 'none'],
    [
      'a running build with a pending abort',
      {
        slug: 'b',
        state: {
          ...running,
          pendingCommands: [{ command: 'abort', seq: 9, actor: DISPATCHER_ACTOR }],
        },
      },
      'none',
      'none',
    ],
    ['an aborted build', { slug: 'b', terminal: 'aborted' }, 'none', 'none'],
    [
      'an abandoned build after abort cleanup',
      {
        slug: 'b',
        terminal: 'done',
        state: { status: 'done', outcome: 'abandoned', pendingCommands: [] },
      },
      'none',
      'none',
    ],
    [
      'a done build',
      {
        slug: 'b',
        terminal: 'done',
        state: { status: 'done', outcome: 'closed-unmerged', pendingCommands: [] },
      },
      'none',
      'none',
    ],
    ['a merged build', { slug: 'b', merged: true }, 'none', 'none'],
  ]
  for (const [name, build, abortMode, drainMode] of cases)
    test(`stop actions for ${name}: ${abortMode} on abort, ${drainMode} on drain`, () => {
      for (const [mode, expected] of [
        ['abort', abortMode],
        ['drain', drainMode],
      ] as const) {
        const actions = optimizationStopActions(
          { slug: 'node', stopped: { cause: 'operator', mode, at: 'now' } },
          [{ attempt: attempt('a'), ...(build !== undefined ? { build } : {}) }],
        )
        const kind =
          actions.settle.length > 0 ? 'settle' : actions.abort.length > 0 ? 'abort' : 'none'
        expect(kind).toBe(expected)
        if (kind === 'settle')
          expect(actions.settle[0]).toEqual({
            attempt: attempt('a'),
            ...(build !== undefined ? { build: build.slug } : {}),
          })
        if (kind === 'abort')
          expect(actions.abort[0]).toEqual({
            slug: 'b',
            reason: `optimization node node stopped (operator, ${mode})`,
          })
      }
    })

  test('completion requires a stop and nothing in flight', () => {
    const builder = new OptimizationLogBuilder().accept(commandObjective(), 1).propose('r', ['a'])
    const observation = {
      observation: {
        openChildren: [],
        diagnostics: [],
        contributions: [{ build: 'c' }],
      } as never,
    }
    const of = () => ({ optimization: digest(builder), integration: observation })
    expect(optimizationCompletionBlocker({})).toBeUndefined()
    expect(integrationComplete({ integration: observation })).toBe(true)
    expect(optimizationCompletionBlocker(of())).toBe('the optimization node has not stopped')
    expect(integrationComplete(of())).toBe(false)
    builder.stop('operator', 'drain')
    expect(optimizationCompletionBlocker(of())).toBe('attempts still in flight: T-a')
    expect(integrationComplete(of())).toBe(false)
    builder.settle('a', 'stopped')
    expect(optimizationCompletionBlocker(of())).toBeUndefined()
    expect(integrationComplete(of())).toBe(true)
    expect(integrationComplete({ optimization: digest(builder) })).toBe(false)
  })
})

describe('optimization ledger', () => {
  test('one entry per settlement, with strategy, outcome, delta and note', () => {
    const ledger = optimizationLedgerReducer.reduce(optimizationLog())
    expect(ledger.pending).toEqual({})
    expect(ledger.entries.map((entry) => [entry.proposal, entry.outcome])).toEqual([
      ['a1', 'accepted'],
      ['a2', 'no-improvement'],
      ['a3', 'declined'],
      ['a4', 'stopped'],
    ])
    expect(ledger.entries[1]).toEqual({
      seq: ledger.entries[1]!.seq,
      proposal: 'a2',
      ticket: { source: 'file', id: 'T-a2' },
      build: 'attempt-a2',
      title: 'Attempt a2',
      strategy: 'strategy a2',
      outcome: 'no-improvement',
      delta: 1,
      baseline: 44,
      candidate: 43,
      note: 'noise',
      nearMiss: true,
    })
    expect(ledger.entries[0]!.nearMiss).toBeUndefined()
  })

  test('near misses use the ε in effect, absolute or relative', () => {
    expect(isNearMiss({ outcome: 'no-improvement', delta: 1, baseline: 50 }, { absolute: 2 })).toBe(
      true,
    )
    expect(isNearMiss({ outcome: 'no-improvement', delta: 2, baseline: 50 }, { absolute: 2 })).toBe(
      false,
    )
    expect(isNearMiss({ outcome: 'no-improvement', delta: 0, baseline: 50 }, { absolute: 2 })).toBe(
      false,
    )
    expect(isNearMiss({ outcome: 'accepted', delta: 1, baseline: 50 }, { absolute: 2 })).toBe(false)
    expect(
      isNearMiss({ outcome: 'no-improvement', delta: 1, baseline: -50 }, { relative: 0.03 }),
    ).toBe(true)
    expect(
      isNearMiss({ outcome: 'no-improvement', delta: 2, baseline: 50 }, { relative: 0.03 }),
    ).toBe(false)
    const relative = optimizationLedgerReducer.reduce(
      new OptimizationLogBuilder()
        .accept(commandObjective(), 1)
        .propose('r', ['a'])
        .settle('a', 'no-improvement', { revision: 1, baseline: 50, candidate: 49, delta: 1 })
        .events,
    )
    expect(relative.entries[0]!.nearMiss).toBe(true)
  })
})

/** An opened, measured optimization node: concurrency 4, 60 attempts, 24 hours. */
function openedNode(objective = commandObjective()): OptimizationLogBuilder {
  return new OptimizationLogBuilder()
    .push({
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: 'repo',
        ticket: { source: 'file', id: 'node' },
        baseBranch: 'main',
        kind: 'node',
      },
    })
    .accept(objective, 1)
    .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } })
    .baseline(1, 50, 1.5)
}

describe('proposer state', () => {
  test('a request opens a proposal at the next round; a deposit and filing close it', () => {
    const log = openedNode().request('r1', 3)
    let state = digest(log)
    expect(state.requests).toBe(1)
    expect(state.proposal).toMatchObject({ id: 'r1', room: 3, round: 1 })
    expect(proposeRunDue(state)).toBe(true)
    log.deposit('wrong', 1, ['x'])
    expect(digest(log).proposal?.deposited).toBeUndefined()
    log.deposit('r1', 1, ['a', 'b'])
    state = digest(log)
    expect(state.proposal?.deposited).toMatchObject({ ids: ['a', 'b'] })
    expect(proposeRunDue(state)).toBe(false)
    expect(proposalFilingDue(state)).toBe(true)
    log.file('r1', ['a', 'b'])
    state = digest(log)
    expect(state.proposal).toBeUndefined()
    expect(state.attempts.filed).toBe(2)
    expect(state.inFlight.map((attempt) => attempt.proposal)).toEqual(['a', 'b'])
    expect(digest(log.request('r2', 2)).proposal?.round).toBe(2)
  })

  test('a withdrawal clears only an undeposited request and never counts as empty', () => {
    const withdrawn = digest(openedNode().request('r1', 3).withdraw('r1', 'budget'))
    expect(withdrawn.proposal).toBeUndefined()
    expect(withdrawn.emptyProposals).toBe(0)
    const deposited = digest(
      openedNode().request('r1', 3).deposit('r1', 1, ['a']).withdraw('r1', 'stopped'),
    )
    expect(deposited.proposal?.deposited?.ids).toEqual(['a'])
    // The build digest's signal folds the same way.
    expect(
      reduceBuildDigest(
        digestRows(
          openedNode().request('r1', 3).deposit('r1', 1, ['a']).withdraw('r1', 'stopped').events,
        ),
      ).optimization,
    ).toMatchObject({ proposal: { request: 'r1', deposited: { ids: ['a'] } } })
  })

  test('room is the free slots capped by the attempts budget, and 0 once a budget is spent', () => {
    const state = digest(openedNode())
    expect(proposerRoom(state, at(1))).toBe(4)
    expect(proposerRoom(state, at(25))).toBe(4)
    expect(proposerRoom(digest(ran(openedNode(), 25)), at(25))).toBe(0)
    const tight = digest(openedNode(commandObjective({ budget: { maxAttempts: 2 } })))
    expect(proposerRoom(tight, at(1))).toBe(2)
    const running = digest(openedNode().propose('r1', ['a', 'b', 'c']))
    expect(proposerRoom(running, at(1))).toBe(1)
  })

  test('admission refuses each condition in turn and admits otherwise', () => {
    const now = at(1)
    expect(proposerAdmissible(reduceBuild(openedNode().events), now)).toBe(true)
    const refused = (builder: OptimizationLogBuilder, when = now) =>
      expect(proposerAdmissible(reduceBuild(builder.events), when)).toBe(false)
    refused(openedNode().stop('operator', 'abort'))
    refused(
      new OptimizationLogBuilder()
        .push({
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            repo: 'repo',
            ticket: { source: 'file', id: 'node' },
            baseBranch: 'main',
            kind: 'node',
          },
        })
        .accept(commandObjective(), 1)
        .push({ actor: DISPATCHER, type: 'node.opened', payload: { sha: OPTIMIZATION_SHA('a') } }),
    )
    refused(openedNode().request('r1', 4))
    refused(openedNode(commandObjective({ budget: { maxAttempts: 2 } })).propose('r1', ['a', 'b']))
    refused(ran(openedNode(), 25), at(25))
    refused(openedNode().propose('r1', ['a', 'b', 'c', 'd']))
    refused(openedNode().propose('r1', [], 'none').propose('r2', [], 'none'))
    refused(openedNode().push({ actor: KERNEL, type: 'build.paused', payload: {} }))
    refused(
      openedNode().push({
        actor: KERNEL,
        type: 'escalation.raised',
        payload: { id: 'e1', phase: 'propose', source: 'agent', question: 'why?' },
      }),
    )
  })

  test('threshold and plateau eligibility block new and waiting proposers before the stop is recorded', () => {
    const now = at(1)
    for (const builder of [
      openedNode().revise({ threshold: 100 }, 2),
      openedNode().revise({ plateau: 1 }, 2),
    ]) {
      const build = reduceBuild(builder.events)
      if (build.optimization!.objective.stop.plateau !== undefined) build.optimization!.plateau = 1
      expect(proposerAdmissible(build, now)).toBe(false)
      builder.request('r1', 4)
      const state = digest(builder)
      if (state.objective.stop.plateau !== undefined) state.plateau = 1
      expect(proposeAdmissible(state, now)).toBe(false)
      expect(proposalWithdrawalDue(state, now)).toBe('stopped')
    }
  })

  test('a waiting request stays eligible only while it fits current state', () => {
    const now = at(1)
    const fits = digest(openedNode().request('r1', 4))
    expect(proposalEligible(fits, now)).toBe(true)
    expect(proposeAdmissible(fits, now)).toBe(true)
    expect(proposalWithdrawalDue(fits, now)).toBeUndefined()
    expect(proposalWithdrawalDue(fits, at(25))).toBeUndefined()
    expect(proposalWithdrawalDue(digest(ran(openedNode().request('r1', 4), 25)), at(25))).toBe(
      'budget',
    )
    const stopped = digest(openedNode().request('r1', 4).stop('operator', 'abort'))
    expect(proposalWithdrawalDue(stopped, now)).toBe('stopped')
    const budget = digest(openedNode().request('r1', 4).revise({ maxAttempts: 1 }, 2))
    expect(proposalWithdrawalDue(budget, now)).toBe('budget')
    const concurrency = digest(openedNode().request('r1', 4).revise({ concurrency: 2 }, 2))
    expect(proposalWithdrawalDue(concurrency, now)).toBe('concurrency')
    expect(proposeAdmissible(concurrency, now)).toBe(false)
    // Deposited requests are never withdrawn.
    const deposited = digest(
      openedNode().request('r1', 4).deposit('r1', 1, ['a']).stop('operator', 'abort'),
    )
    expect(proposalWithdrawalDue(deposited, now)).toBeUndefined()
  })

  test('a started session is admitted whatever later revisions say', () => {
    const log = openedNode().request('r1', 4)
    expect(proposeStarted(reduceBuild(log.events))).toBe(false)
    log.push({ actor: KERNEL, type: 'propose.started', payload: { round: 1, request: 'r1' } })
    log.revise({ concurrency: 1 }, 2)
    const state = reduceBuild(log.events)
    expect(state.currentPhase).toMatchObject({ phase: 'propose', round: 1 })
    expect(proposeStarted(state)).toBe(true)
    expect(proposeAdmissible(state.optimization, at(1))).toBe(false)
  })

  test('two consecutive empty proposals make the exhausted stop due', () => {
    expect(exhaustedStopDue(digest(openedNode().propose('r1', [], 'none')))).toBe(false)
    const twice = openedNode().propose('r1', [], 'none').propose('r2', [], 'none')
    expect(exhaustedStopDue(digest(twice))).toBe(true)
    expect(exhaustedStopDue(digest(twice.stop('exhausted', 'abort')))).toBe(false)
  })

  test('attempt creation keys are deterministic version-4 UUIDs per node and proposal', () => {
    const key = attemptCreationKey('acme/repo', 'node-a', 'cache')
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(attemptCreationKey('acme/repo', 'node-a', 'cache')).toBe(key)
    expect(attemptCreationKey('acme/repo', 'node-b', 'cache')).not.toBe(key)
    expect(attemptCreationKey('acme/repo', 'node-a', 'index')).not.toBe(key)
  })
})

describe('proposer digest signal', () => {
  test('the build digest signal equals the BuildState digest signal', () => {
    const log = optimizationLog()
    const state = reduceBuild(log).optimization!
    const signal = reduceBuildDigest(digestRows(log)).optimization
    expect(signal).toMatchObject(optimizationSignal(state))
  })

  test('a plain node signals false and a leaf has no signal', () => {
    const node = reduceBuildDigest(
      digestRows([
        {
          actor: DISPATCHER,
          type: 'build.created',
          payload: {
            repo: 'r',
            ticket: { source: 'file', id: 'n' },
            baseBranch: 'm',
            kind: 'node',
          },
          build: 'n',
          seq: 1,
          ts: '2026-11-17T00:00:00.000Z',
        } as never,
      ]),
    )
    expect(node.optimization).toBe(false)
    expect(reduceBuildDigest([]).optimization).toBeUndefined()
  })

  test('due work follows the signal; a deferral holds until a wake fact', () => {
    const now = at(1)
    const signal = (builder: OptimizationLogBuilder) =>
      reduceBuildDigest(digestRows(builder.events)).optimization || undefined
    expect(signalDue(signal(openedNode())!, now)).toBe('request')
    expect(signalDue(signal(openedNode())!, at(25))).toBe('request')
    expect(signalDue(signal(ran(openedNode(), 25))!, at(25))).toBeUndefined()
    expect(signalDue(signal(openedNode())!, now, true)).toBeUndefined()
    expect(signalDue(signal(openedNode().request('r1', 4))!, now)).toBeUndefined()
    expect(signalDue(signal(openedNode().request('r1', 4).deposit('r1', 1, ['a']))!, now)).toBe(
      'filing',
    )
    const exhausted = openedNode().propose('r1', [], 'none').propose('r2', [], 'none')
    expect(signalDue(signal(exhausted)!, now)).toBe('exhausted')
    const deferred = openedNode().defer('paused')
    expect(signalDue(signal(deferred)!, now)).toBeUndefined()
    deferred.push({ actor: KERNEL, type: 'build.resumed', payload: {} })
    expect(signalDue(signal(deferred)!, now)).toBe('request')
  })

  test('the signal is the same size at 10 and 10,000 settled attempts', () => {
    const settled = (count: number) => {
      const log = openedNode(commandObjective({ budget: { maxAttempts: 20_000 } }))
      for (let index = 0; index < count; index += 1)
        log
          .propose(`r${index}`, [`a${index}`])
          .settle(`a${index}`, 'declined')
          .ticketRejected(`a${index}`)
      return JSON.stringify(reduceBuildDigest(digestRows(log.events)).optimization).length
    }
    // Only the counters' digit widths may differ.
    expect(Math.abs(settled(10_000) - settled(10))).toBeLessThan(16)
  })
})

describe('proposer wake set', () => {
  // Each blocker is built from facts, then cleared by a fact that must wake
  // the node; compatibility clears by upgrade, which the digest observes.
  const opened = () => openedNode()
  const cases: {
    reason: NonNullable<ReturnType<typeof proposerBlocker>>
    block: (log: OptimizationLogBuilder) => OptimizationLogBuilder
    clear: (log: OptimizationLogBuilder) => OptimizationLogBuilder
  }[] = [
    {
      reason: 'paused',
      block: (log) => log.push({ actor: KERNEL, type: 'build.paused', payload: {} }),
      clear: (log) => log.push({ actor: KERNEL, type: 'build.resumed', payload: {} }),
    },
    {
      reason: 'command',
      block: (log) =>
        log.push({ actor: humanActor('ada'), type: 'build.pause-requested', payload: {} }),
      clear: (log) => log.push({ actor: KERNEL, type: 'build.paused', payload: {} }),
    },
    {
      reason: 'blocked',
      block: (log) =>
        log.push({
          actor: KERNEL,
          type: 'escalation.raised',
          payload: { id: 'e1', phase: 'propose', source: 'agent', question: 'why?' },
        }),
      clear: (log) =>
        log.push({
          actor: humanActor('ada'),
          type: 'escalation.answered',
          payload: { id: 'e1', answer: 'because', resolution: 'guidance' },
        }),
    },
  ]
  for (const { reason, block, clear } of cases)
    test(`${reason} is cleared by a wake fact`, () => {
      const blocked = block(opened())
      expect(proposerBlocker(reduceBuild(blocked.events))).toBe(reason)
      const cleared = clear(blocked)
      const last = cleared.events.at(-1)!
      expect(isProposerWakeEvent(last)).toBe(true)
      // `command` clears to `paused`, which `build.resumed` then wakes.
      const after = proposerBlocker(reduceBuild(cleared.events))
      expect(after === undefined || after === 'paused').toBe(true)
    })

  test('every structural blocker has a clearing fact in the wake set', () => {
    const wake = new Set<string>(PROPOSER_WAKE_EVENT_TYPES)
    const clearing: Record<string, string[]> = {
      paused: ['build.resumed'],
      blocked: ['escalation.answered', 'wait.ended'],
      command: ['build.paused', 'build.resumed', 'build.aborted'],
      restack: ['node.item-replayed', 'node.writer-settled'],
      integration: ['integration.abandoned', 'integration.landed'],
      landing: ['pr.opened'],
    }
    for (const types of Object.values(clearing))
      for (const type of types) expect(wake.has(type)).toBe(true)
    expect(wake.has('optimization.proposal-deferred')).toBe(false)
  })
})

test('the stop and admission inputs and the ledger have bounded read cost', async () => {
  const { optimizationReadBudget } = await import('../testing/reduced-read-budget')
  await optimizationReadBudget()
}, 120_000)

test('panel progress selection reads zero idle event rows at 100 and 100,000 events', async () => {
  const { panelProgressReadBudget } = await import('../testing/reduced-read-budget')
  await panelProgressReadBudget()
}, 120_000)

test('judge panel sessions on the session rows have bounded read cost', async () => {
  const { judgePanelSessionReadBudget } = await import('../testing/reduced-read-budget')
  await judgePanelSessionReadBudget()
}, 120_000)

test('the landing gate and the rejected-role sweep have bounded read cost', async () => {
  const { optimizationLandingReadBudget } = await import('../testing/reduced-read-budget')
  await optimizationLandingReadBudget()
}, 120_000)

test('the store read tripwire sees historical build and repository rows', async () => {
  const { storeReadMetricsTripwire } = await import('../testing/reduced-read-budget')
  await storeReadMetricsTripwire()
})

test('a second propose terminal for the round is refused', () => {
  const log = new OptimizationLogBuilder()
    .accept(commandObjective(), 1)
    .request('r1', 2)
    .push({ actor: KERNEL, type: 'propose.started', payload: { round: 1, request: 'r1' } })
    .deposit('r1', 1, ['a'])
  const guard = terminalGuardReducer({ phase: 'propose', round: 1, session: 'sess-propose' })
  expect(guard.reduce(log.events).diagnostic).toMatch(/second terminal call rejected/)
  const next = terminalGuardReducer({ phase: 'propose', round: 2, session: 'sess-propose' })
  expect(next.reduce(log.events).diagnostic).toBeUndefined()
})
