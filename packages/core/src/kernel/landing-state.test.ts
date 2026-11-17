import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { validateEventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { evaluateLandingPolicy } from './landing-policy'
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

const deferred = (seq: number, replacement = candidate) =>
  event(seq, {
    actor: DISPATCHER,
    type: 'landing.deferred',
    payload: {
      candidate: replacement,
      reason: 'paths-unrecorded',
      rule: { index: 0, snapshot: { within: ['docs/**'], mode: 'auto' } },
      policy: 'sha256:policy',
    },
  })

describe('durable landing state', () => {
  test('a path deferral folds; a later decision or accepted reparent clears it', () => {
    const next = { ...candidate, head: 'next' }
    const state = buildReducer.reduce([decided(), deferred(2, next)]).landing
    expect(state?.deferral).toMatchObject({
      seq: 2,
      candidate: next,
      policy: 'sha256:policy',
    })
    expect(state?.decision?.candidate).toEqual(candidate)
    expect(landingAuthorized(state)).toBe(false)
    expect(buildReducer.reduce([deferred(1), decided(2)]).landing?.deferral).toBeUndefined()
    const moved = event(2, {
      actor: DISPATCHER,
      type: 'node.parent-accepted',
      payload: {
        id: 'move',
        old: { target: null, branch: 'main' },
        next: {
          target: { ticket: { source: 'file', id: 'Q' }, build: 'q' },
          branch: 'ab-node/q',
        },
        revision: 'r2',
      },
    })
    expect(buildReducer.reduce([deferred(1), moved]).landing?.deferral).toBeUndefined()
  })

  test('accepted reparent revokes land and policy, preserves holds and evaluates the new destination', () => {
    const moved = event(4, {
      actor: DISPATCHER,
      type: 'node.parent-accepted',
      payload: {
        id: 'move',
        old: { target: null, branch: 'main' },
        next: {
          target: { ticket: { source: 'file', id: 'Q' }, build: 'q' },
          branch: 'ab-node/q',
        },
        revision: 'r2',
      },
    })
    const state = buildReducer.reduce([decided(), land(2), ack(3, 2), moved]).landing
    expect(state?.command).toBeUndefined()
    expect(state?.acknowledgedSeq).toBeUndefined()
    expect(state?.decision).toBeUndefined()
    expect(landingAuthorized(state)).toBe(false)
    const held = buildReducer.reduce([decided(), hold(2), ack(3, 2), moved]).landing
    expect(held?.command).toEqual({ kind: 'hold', seq: 2 })
    expect(held?.acknowledgedSeq).toBe(2)
    expect(landingAuthorized(held)).toBe(false)
    const replacement = event(5, {
      actor: DISPATCHER,
      type: 'landing.decided',
      payload: {
        ...decision,
        from: 'node',
        into: { kind: 'node', ticket: 'Q' },
        ...evaluateLandingPolicy(
          [
            { into: 'root', mode: 'consent' },
            { into: 'Q', mode: 'auto' },
          ],
          {
            from: 'node',
            into: { kind: 'node', ticket: 'Q' },
            labels: decision.labels,
          },
        ),
      },
    })
    expect(
      landingAuthorized(buildReducer.reduce([decided(), land(2), moved, replacement]).landing),
    ).toBe(true)
    expect(
      landingAuthorized(buildReducer.reduce([decided(), hold(2), moved, replacement]).landing),
    ).toBe(false)
  })

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

  test('consent records the head of the decision it named and keeps it across replacements', () => {
    const log = [decided(), land(2)]
    expect(buildReducer.reduce(log).landing?.command).toEqual({
      kind: 'land',
      seq: 2,
      decisionSeq: 1,
      head: 'head',
    })
    log.push(decided(3, { ...candidate, head: 'replacement' }))
    const replaced = buildReducer.reduce(log).landing
    expect(replaced?.command?.head).toBe('head')
    expect(replaced?.decision?.candidate.head).toBe('replacement')
    expect(landingAuthorized(replaced)).toBe(true)
    log.push(hold(4))
    expect(buildReducer.reduce(log).landing?.command).toEqual({
      kind: 'hold',
      seq: 4,
    })
    // A consent naming a superseded decision records no head.
    expect(buildReducer.reduce([decided(), decided(2), land(3)]).landing?.command?.head).toBe(
      undefined,
    )
    const legacy = event(1, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    expect(buildReducer.reduce([legacy]).landing?.command).toEqual({
      kind: 'land',
      seq: 1,
      legacy: true,
    })
  })

  test('consent captures a path-predicate rule; a matching revocation clears only that consent', () => {
    const protectedRule = { index: 0, snapshot: { paths: ['autobuild.toml'], mode: 'consent' } }
    const pathDecided = (seq: number, head: string, rule: object = protectedRule) =>
      event(seq, {
        actor: KERNEL,
        type: 'landing.decided',
        payload: {
          ...decision,
          candidate: { ...candidate, head },
          rule,
          ...('index' in rule ? { paths: { total: 1, preview: ['autobuild.toml'] } } : {}),
        } as never,
      })
    const consent = (seq: number, decisionSeq: number) =>
      event(seq, {
        actor: humanActor('operator'),
        type: 'build.land-requested',
        payload: { decisionSeq },
      })
    const revoked = (seq: number, commandSeq: number) =>
      event(seq, {
        actor: KERNEL,
        type: 'landing.consent-revoked',
        payload: {
          commandSeq,
          source: 'reconcile',
          rule: protectedRule as never,
          previousHead: 'head',
          head: 'next',
          paths: { total: 1, preview: ['autobuild.toml'] },
        },
      })
    const log = [pathDecided(1, 'head'), consent(2, 1), ack(3, 2)]
    expect(buildReducer.reduce(log).landing?.command).toEqual({
      kind: 'land',
      seq: 2,
      decisionSeq: 1,
      head: 'head',
      rule: protectedRule as never,
    })
    // Rules without path predicates and the default capture nothing.
    for (const rule of [{ index: 0, snapshot: { mode: 'consent' } }, { default: true }])
      expect(
        buildReducer.reduce([pathDecided(1, 'head', rule), consent(2, 1)]).landing?.command?.rule,
      ).toBeUndefined()
    log.push(pathDecided(4, 'next'), revoked(5, 2))
    const revokedState = buildReducer.reduce(log).landing
    expect(revokedState?.command).toBeUndefined()
    expect(revokedState?.acknowledgedSeq).toBeUndefined()
    expect(landingAuthorized(revokedState)).toBe(false)
    log.push(consent(6, 4))
    expect(landingAuthorized(buildReducer.reduce(log).landing)).toBe(true)
    // A stale revocation never clears a later hold or a fresh consent.
    expect(buildReducer.reduce([...log, revoked(7, 2)]).landing?.command?.seq).toBe(6)
    expect(
      buildReducer.reduce([pathDecided(1, 'head'), consent(2, 1), hold(3), revoked(4, 2)]).landing
        ?.command,
    ).toEqual({ kind: 'hold', seq: 3 })
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
