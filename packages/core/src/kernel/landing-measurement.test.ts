import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL } from '../events/envelope'
import type { EventPayload } from '../events/payloads'
import {
  OptimizationLogBuilder,
  OPTIMIZATION_SHA as sha,
  commandObjective,
  panelObjective,
} from './generators/optimization-log'
import {
  advanceLandingMeasurement,
  classifyLanding,
  landingMeasurementGate,
  measurementApplies,
  mergedAttemptMeasurement,
  selectTurnHolder,
  settlementMeasurement,
  type LandingGateInput,
  type LandingMeasurementState,
  type TurnCandidate,
} from './landing-measurement'
import { measurementThreshold } from './measurement'
import { optimizationReducer, type OptimizationState } from './optimization'
import { reduceBuild } from './reducer'

const PIN = sha('a')
const NODE = sha('b')
const HEAD = sha('c')

function digest(objective = commandObjective({ target: { epsilon: { absolute: 2 } } })) {
  return optimizationReducer.reduce(
    new OptimizationLogBuilder().accept(objective, 1).propose('r', ['a1', 'a2', 'a3']).events,
  ) as OptimizationState
}

let seq = 0
const event = (write: Pick<AbEvent, 'type' | 'payload'>, actor = DISPATCHER) =>
  ({ ...write, actor, seq: ++seq, build: 'child', ts: '2026-11-17T00:00:00.000Z' }) as AbEvent

const request = (id: string, baseline = NODE, candidate = HEAD, revision = 1) =>
  event({
    type: 'attempt.measurement-requested',
    payload: { id, node: 'opt-node', candidate, baseline, harnessPin: PIN, revision },
  } as never)

const measured = (
  id: string,
  delta: number,
  extra: Partial<EventPayload<'attempt.measured'>> = {},
) =>
  event(
    {
      type: 'attempt.measured',
      payload: {
        request: id,
        candidate: HEAD,
        baseline: NODE,
        harnessPin: PIN,
        revision: 1,
        samples: 7,
        medians: { candidate: 50 - delta, baseline: 50 },
        delta,
        decision: delta > 0 ? 'improved' : 'no-improvement',
        ...extra,
      },
    } as never,
    KERNEL,
  )

function fold(...events: AbEvent[]): LandingMeasurementState | undefined {
  return events.reduce<LandingMeasurementState | undefined>(advanceLandingMeasurement, undefined)
}

function gate(input: Partial<LandingGateInput> = {}) {
  return landingMeasurementGate({
    digest: digest(),
    attempt: 'in-flight',
    lm: undefined,
    candidate: HEAD,
    nodeHead: NODE,
    self: 'child',
    ...input,
  })
}

describe('landing measurement fold', () => {
  test('a new baseline counts an overtake and clears the result', () => {
    const lm = fold(request('m1'), measured('m1', 3), request('m2', sha('d')))
    expect(lm?.overtakes).toBe(1)
    expect(lm?.request?.id).toBe('m2')
    expect(lm?.result).toBeUndefined()
    expect(fold(request('m1'), request('m2', sha('d')), request('m3', sha('e')))?.overtakes).toBe(2)
  })

  test('a result for a stale request is history', () => {
    const lm = fold(request('m1'), request('m2', sha('d')), measured('m1', 3))
    expect(lm?.result).toBeUndefined()
    expect(fold(measured('m1', 3))).toBeUndefined()
  })

  test('a same-baseline re-request is not an overtake', () => {
    // After a failed measurement, a restack (new candidate), or a re-measure
    // after an answered regression, the node head is the same.
    const lm = fold(request('m1'), measured('m1', -5), request('m2'), request('m3', NODE, sha('f')))
    expect(lm?.overtakes).toBe(0)
  })

  test('BuildState carries the child measurement state', () => {
    expect(reduceBuild([request('m1'), measured('m1', 3)]).landingMeasurement).toMatchObject({
      request: { id: 'm1' },
      result: { request: 'm1', delta: 3 },
      overtakes: 0,
    })
    expect(reduceBuild([]).landingMeasurement).toBeUndefined()
  })
})

describe('classification', () => {
  const objective = commandObjective({ target: { epsilon: { absolute: 2 } } })
  test('an attempt lands at exactly ε and not just under it', () => {
    expect(classifyLanding(objective, 'improve', { delta: 2 })).toBe('land')
    expect(classifyLanding(objective, 'improve', { delta: 1.999 })).toBe('no-improvement')
  })

  test('a non-attempt lands at −ε and regresses just below it', () => {
    expect(classifyLanding(objective, 'non-regress', { delta: -2 })).toBe('land')
    expect(classifyLanding(objective, 'non-regress', { delta: -2.001 })).toBe('regressed')
  })

  test('a relative ε scales with the baseline median', () => {
    const relative = commandObjective({ target: { epsilon: { relative: 0.03 } } })
    const medians = { candidate: 0, baseline: -200 }
    expect(measurementThreshold(relative, { medians })).toBeCloseTo(6)
    expect(classifyLanding(relative, 'improve', { medians, delta: 6 })).toBe('land')
    expect(classifyLanding(relative, 'improve', { medians, delta: 5.9 })).toBe('no-improvement')
  })

  test('a panel uses its absolute ε on the win-rate delta', () => {
    expect(classifyLanding(panelObjective(), 'improve', { delta: 0.1 })).toBe('land')
    expect(classifyLanding(panelObjective(), 'improve', { delta: 0.05 })).toBe('no-improvement')
  })

  test('the settlement records medians, or 0.5 and the win rate for a panel', () => {
    expect(
      settlementMeasurement({ revision: 2, medians: { candidate: 40, baseline: 44 }, delta: 4 }),
    ).toEqual({ revision: 2, baseline: 44, candidate: 40, delta: 4 })
    expect(settlementMeasurement({ revision: 1, winRate: 0.7, delta: 0.2 })).toEqual({
      revision: 1,
      baseline: 0.5,
      candidate: 0.7,
      delta: 0.2,
    })
  })
})

describe('freshness', () => {
  const lm = fold(request('m1'), measured('m1', 3))
  test('a result applies only to its exact pair, pin and ruler', () => {
    expect(measurementApplies(digest(), lm, HEAD, NODE)).toBe(true)
    // The node head moved: stale baseline.
    expect(measurementApplies(digest(), lm, HEAD, sha('d'))).toBe(false)
    // A restack: stale candidate.
    expect(measurementApplies(digest(), lm, sha('e'), NODE)).toBe(false)
    expect(measurementApplies(digest(), lm, undefined, NODE)).toBe(false)
  })

  test('an older ruler revision or another harness pin never applies', () => {
    const reaccepted = optimizationReducer.reduce(
      new OptimizationLogBuilder().accept(commandObjective(), 1).accept(
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
      ).events,
    ) as OptimizationState
    expect(reaccepted.rulerRevision).toBe(2)
    expect(measurementApplies(reaccepted, lm, HEAD, NODE)).toBe(false)
    const repinned = optimizationReducer.reduce(
      new OptimizationLogBuilder().accept(commandObjective(), 1, 0, sha('9')).events,
    ) as OptimizationState
    expect(measurementApplies(repinned, lm, HEAD, NODE)).toBe(false)
  })
})

describe('gate', () => {
  test('requests, waits, then classifies', () => {
    expect(gate()).toBe('request')
    expect(gate({ lm: fold(request('m1')) })).toBe('pending')
    expect(gate({ lm: fold(request('m1'), measured('m1', 2)) })).toBe('land')
    expect(gate({ lm: fold(request('m1'), measured('m1', 1)) })).toBe('no-improvement')
  })

  test('a stale result or request asks again for the current pair', () => {
    const lm = fold(request('m1'), measured('m1', 5))
    expect(gate({ lm, nodeHead: sha('d') })).toBe('request')
    expect(gate({ lm, candidate: sha('e') })).toBe('request')
    expect(gate({ lm: fold(request('m1')), nodeHead: sha('d') })).toBe('request')
  })

  test('an unknown head is stale, and a settled attempt only closes', () => {
    expect(gate({ candidate: undefined })).toBe('stale')
    expect(gate({ nodeHead: undefined })).toBe('stale')
    expect(gate({ attempt: 'settled', lm: fold(request('m1'), measured('m1', 5)) })).toBe('settled')
  })

  test('a non-attempt lands unless it regresses, and an answered regression re-measures', () => {
    const regressed = fold(request('m1'), measured('m1', -3))
    expect(gate({ attempt: 'none', lm: fold(request('m1'), measured('m1', -2)) })).toBe('land')
    expect(gate({ attempt: 'none', lm: regressed })).toBe('regressed')
    expect(gate({ attempt: 'none', lm: regressed, regressionAnswered: true })).toBe('request')
  })

  test('another holder of the turn makes every other candidate wait', () => {
    const lm = fold(request('m1'), measured('m1', 5))
    expect(gate({ lm, turn: 'other' })).toBe('wait-turn')
    expect(gate({ turn: 'other' })).toBe('wait-turn')
    expect(gate({ lm, turn: 'child' })).toBe('land')
  })
})

describe('turn', () => {
  const key = (ref: { source: string; id: string }) => `${ref.source}:${ref.id}`
  const overtaken = (times: number) => {
    const events = [request('t0', sha('0'))]
    for (let i = 1; i <= times; i++) events.push(request(`t${i}`, sha(String(i))))
    return fold(...events)
  }
  const candidate = (
    proposal: string,
    times: number,
    state: Partial<TurnCandidate['state']> = {},
  ): TurnCandidate => ({
    slug: `attempt-${proposal}`,
    ticket: { source: 'file', id: `T-${proposal}` },
    state: {
      status: 'running',
      prState: 'open',
      openEscalations: [],
      pendingCommands: [],
      landingMeasurement: overtaken(times),
      ...state,
    } as TurnCandidate['state'],
  })

  test('three overtakes take the turn, two do not', () => {
    expect(selectTurnHolder(digest(), [candidate('a1', 2), candidate('a2', 2)], key)).toBe(
      undefined,
    )
    expect(selectTurnHolder(digest(), [candidate('a1', 2), candidate('a2', 3)], key)).toBe(
      'attempt-a2',
    )
  })

  test('the first holder in inFlight order wins', () => {
    expect(selectTurnHolder(digest(), [candidate('a3', 4), candidate('a1', 3)], key)).toBe(
      'attempt-a1',
    )
  })

  test('an escalated, paused or closed holder releases the turn', () => {
    const escalated = candidate('a1', 3, {
      openEscalations: [{ id: 'landing-harness-x' } as never],
    })
    expect(selectTurnHolder(digest(), [escalated, candidate('a2', 3)], key)).toBe('attempt-a2')
    const janitor = candidate('a1', 3, {
      openEscalations: [{ id: 'janitor:x', janitor: true } as never],
    })
    expect(selectTurnHolder(digest(), [janitor], key)).toBe('attempt-a1')
    expect(selectTurnHolder(digest(), [candidate('a1', 3, { status: 'paused' })], key)).toBe(
      undefined,
    )
    expect(selectTurnHolder(digest(), [candidate('a1', 3, { prState: 'merged' })], key)).toBe(
      undefined,
    )
  })

  test('a child that is not an in-flight attempt never holds the turn', () => {
    const outsider = { ...candidate('zz', 5), ticket: { source: 'file', id: 'T-zz' } }
    expect(selectTurnHolder(digest(), [outsider], key)).toBe(undefined)
  })
})

describe('merged attempt measurement', () => {
  test('a result for the merged head under the node is measured', () => {
    const lm = fold(request('m1'), measured('m1', 5))
    const verdict = mergedAttemptMeasurement(lm, 'opt-node', HEAD)
    expect(verdict.kind).toBe('measured')
    if (verdict.kind === 'measured') expect(verdict.result.candidate).toBe(HEAD)
  })

  test('no recorded result is absent, with or without a request', () => {
    expect(mergedAttemptMeasurement(undefined, 'opt-node', HEAD)).toEqual({
      kind: 'unmeasured',
      reason: 'absent',
    })
    expect(mergedAttemptMeasurement(fold(request('m1')), 'opt-node', HEAD)).toEqual({
      kind: 'unmeasured',
      reason: 'absent',
    })
  })

  test('a result for another candidate is a stale head', () => {
    const lm = fold(request('m1'), measured('m1', 5))
    expect(mergedAttemptMeasurement(lm, 'opt-node', sha('9'))).toEqual({
      kind: 'unmeasured',
      reason: 'stale-head',
      measuredCandidate: HEAD,
    })
  })

  test("another node's request is unrelated, even for the merged head", () => {
    const lm = fold(request('m1'), measured('m1', 5))
    expect(mergedAttemptMeasurement(lm, 'other-node', HEAD)).toEqual({
      kind: 'unmeasured',
      reason: 'unrelated',
    })
  })
})
