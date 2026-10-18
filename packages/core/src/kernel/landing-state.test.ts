import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { validateEventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { buildReducer } from './reducer'
import { landingAuthorized, nativeLandingApplied } from './landing-state'

const candidate = { head: 'head', parent: 'parent', cycle: 'cycle' }
const decision = {
  candidate,
  from: 'leaf' as const,
  into: { kind: 'root' as const },
  labels: ['release'],
  mode: 'consent' as const,
  rule: { default: true as const },
}
const event = (seq: number, write: EventWrite): AbEvent =>
  ({
    ...validateEventWrite(write),
    build: 'test',
    seq,
    ts: new Date(0).toISOString(),
  }) as AbEvent
const decided = (seq = 1, replacement = candidate) =>
  event(seq, {
    actor: KERNEL,
    type: 'landing.decided',
    payload: { ...decision, candidate: replacement },
  })
const land = (seq: number) =>
  event(seq, {
    actor: humanActor('operator'),
    type: 'build.land-requested',
    payload: { decisionSeq: 1 },
  })
const hold = (seq: number) =>
  event(seq, {
    actor: humanActor('operator'),
    type: 'build.hold-requested',
    payload: {},
  })
const ack = (seq: number, commandSeq: number) =>
  event(seq, {
    actor: KERNEL,
    type: 'landing.command-acknowledged',
    payload: { commandSeq },
  })

describe('durable landing state', () => {
  test('land survives replacement decisions; old native receipts cannot acknowledge new candidates', () => {
    const log = [
      decided(),
      land(2),
      ack(3, 2),
      event(4, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: true, candidate, decisionSeq: 1, commandSeq: 2 },
      }),
    ]
    expect(nativeLandingApplied(buildReducer.reduce(log).landing)).toBe(true)
    log.push(decided(5, { ...candidate, head: 'replacement' }))
    const state = buildReducer.reduce(log).landing
    expect(landingAuthorized(state)).toBe(true)
    expect(state?.acknowledgedSeq).toBe(2)
    expect(state?.command?.decisionSeq).toBe(1)
    expect(nativeLandingApplied(state)).toBe(false)
    expect(state?.decision?.labels).toEqual(['release'])
  })

  test('latest command wins; holds survive candidate changes and stale acknowledgements', () => {
    const log = [hold(1), decided(2), land(3), hold(4), ack(5, 3), decided(6)]
    const state = buildReducer.reduce(log).landing
    expect(landingAuthorized(state)).toBe(false)
    expect(state?.command).toEqual({ kind: 'hold', seq: 4 })
    expect(state?.acknowledgedSeq).toBeUndefined()
    log.push(ack(7, 4), land(8), ack(9, 4))
    expect(buildReducer.reduce(log).landing?.acknowledgedSeq).toBe(4)
    expect(landingAuthorized(buildReducer.reduce(log).landing)).toBe(true)
  })

  test('legacy explicit commands map to consent/hold; default seeds never grant consent', () => {
    const historical = event(1, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    expect(landingAuthorized(buildReducer.reduce([historical]).landing)).toBe(true)
    const log = [
      decided(),
      event(2, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: { defaultSeq: 1 },
      }),
    ]
    expect(landingAuthorized(buildReducer.reduce(log).landing)).toBe(false)
    log.push(
      event(3, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      }),
    )
    expect(landingAuthorized(buildReducer.reduce(log).landing)).toBe(true)
    log.push(
      hold(4),
      event(5, {
        actor: humanActor('operator'),
        type: 'build.auto-merge-requested',
        payload: {},
      }),
    )
    expect(landingAuthorized(buildReducer.reduce(log).landing)).toBe(false)
  })

  test('enable uncertainty survives replay until a confirmed native application', () => {
    const log = [
      decided(),
      event(2, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: false },
      }),
      event(3, {
        actor: DISPATCHER,
        type: 'landing.native-enable-started',
        payload: {},
      }),
    ]
    expect(buildReducer.reduce(log).landing?.nativeEnablePending).toBe(3)
    log.push(
      event(4, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: false },
      }),
    )
    expect(buildReducer.reduce(log).landing?.nativeEnablePending).toBe(3)
    log.push(
      event(5, {
        actor: KERNEL,
        type: 'landing.native-applied',
        payload: { enabled: false, enableSeq: 3 },
      }),
    )
    expect(buildReducer.reduce(log).landing?.nativeEnablePending).toBeUndefined()
    for (let split = 0; split <= log.length; split++) {
      const first = buildReducer.advance(buildReducer.initial(), log.slice(0, split))
      expect(
        buildReducer.finish(buildReducer.advance(structuredClone(first), log.slice(split))),
      ).toEqual(buildReducer.reduce(log))
    }
  })

  test('incremental reduction equals replay at every interruption', () => {
    const log = [hold(1), decided(2), ack(3, 1), land(4), ack(5, 4), decided(6)]
    for (let split = 0; split <= log.length; split++) {
      const first = buildReducer.advance(buildReducer.initial(), log.slice(0, split))
      const result = buildReducer.finish(
        buildReducer.advance(structuredClone(first), log.slice(split)),
      )
      expect(result).toEqual(buildReducer.reduce(log))
    }
  })
})
