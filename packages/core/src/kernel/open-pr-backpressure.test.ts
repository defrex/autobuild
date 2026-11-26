import { describe, expect, test } from 'bun:test'
import { configSchema } from '../config/schema'
import { DISPATCHER } from '../events/envelope'
import { validateRepositoryEventWrite, type RepositoryEvent } from '../events/repository'
import { capacityExplanation, dispatchCapacity, type CapacityBuild } from './dispatch-capacity'
import {
  backpressureExplanation,
  backpressureStatusLine,
  backpressureTransition,
  openPrBackpressure,
  openPrBackpressurePolicy,
  openPrCount,
  openRootPr,
} from './open-pr-backpressure'
import { openPrBackpressureReducer } from './open-pr-backpressure-state'
import { reduceBuild } from './reducer'

const now = new Date('2026-11-20T12:00:00Z')
const PR = { number: 1, url: 'https://example.test/pr/1', headSha: 'a'.repeat(40) }

function build(
  slug: string,
  opts: {
    kind?: 'work' | 'node'
    status?: CapacityBuild['state']['status']
    prState?: 'open' | 'merged' | 'closed' | 'conflicted'
    target?: string
    hold?: boolean
  } = {},
): CapacityBuild {
  const state = reduceBuild([])
  return {
    record: {
      slug,
      repo: 'repo',
      ticket: { source: 'file', id: slug },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    state: {
      ...state,
      kind: opts.kind ?? 'work',
      status: opts.status ?? 'running',
      ...(opts.prState ? { pr: PR, prState: opts.prState } : {}),
      ...(opts.target
        ? { target: { build: opts.target, ticket: { source: 'file', id: opts.target } } }
        : {}),
      ...(opts.hold ? { landing: { command: { kind: 'hold' as const, seq: 1 } } } : {}),
    },
    workspace: false,
  }
}

const policy = (maxOpenPrs: number, resumeOpenPrs?: number, excludeHeld = false) =>
  openPrBackpressurePolicy({
    maxOpenPrs,
    ...(resumeOpenPrs === undefined ? {} : { resumeOpenPrs }),
    excludeHeldOpenPrs: excludeHeld,
  })
const open = (n: number) => Array.from({ length: n }, (_, i) => build(`b${i}`, { prState: 'open' }))

describe('open root PR count', () => {
  test.each([
    ['open root leaf', build('a', { prState: 'open' }), true, true],
    ['conflicted root leaf', build('a', { prState: 'conflicted' }), true, true],
    ['merged', build('a', { prState: 'merged' }), false, false],
    ['closed', build('a', { prState: 'closed' }), false, false],
    ['no PR', build('a'), false, false],
    ['child of an integration node', build('a', { prState: 'open', target: 'n' }), false, false],
    ['root integration node', build('n', { kind: 'node', prState: 'open' }), true, true],
    ['terminal', build('a', { prState: 'open', status: 'done' }), false, false],
    ['aborted', build('a', { prState: 'open', status: 'aborted' }), false, false],
    ['held', build('a', { prState: 'open', hold: true }), true, false],
  ])('%s', (_, candidate, counted, countedExcludingHeld) => {
    expect(openRootPr(candidate, false)).toBe(counted)
    expect(openRootPr(candidate, true)).toBe(countedExcludingHeld)
  })

  test('a duplicated slug counts once', () => {
    const a = build('a', { prState: 'open' })
    expect(openPrCount([a, a, build('b', { prState: 'open' })], false)).toBe(2)
  })
})

describe('policy resolution', () => {
  test('unset maxOpenPrs disables backpressure, whatever else is set', () => {
    expect(openPrBackpressurePolicy(undefined)).toBeUndefined()
    expect(openPrBackpressurePolicy({ resumeOpenPrs: 3, excludeHeldOpenPrs: true })).toBeUndefined()
  })
  test('resume defaults to one below the high watermark', () => {
    expect(policy(5)).toEqual({ maxOpenPrs: 5, resumeOpenPrs: 4, excludeHeld: false })
    expect(policy(1)).toEqual({ maxOpenPrs: 1, resumeOpenPrs: 0, excludeHeld: false })
  })
})

describe('hysteresis', () => {
  test.each([
    // [max, resume, count, engaged, active]
    [3, 1, 2, false, false],
    [3, 1, 3, false, true],
    [3, 1, 4, false, true],
    [3, 1, 2, true, true],
    [3, 1, 1, true, false],
    [3, 1, 0, true, false],
    [3, 3, 3, false, true],
    [3, 3, 3, true, true],
    [3, 3, 2, true, false],
    [1, 0, 1, false, true],
    [1, 0, 0, true, false],
  ])(
    'max %d resume %d at %d open (engaged %p) → active %p',
    (max, resume, count, engaged, active) => {
      expect(openPrBackpressure(open(count), policy(max, resume), engaged)?.active).toBe(active)
    },
  )

  test('resume == max never flaps at the watermark', () => {
    const bp = openPrBackpressure(open(3), policy(3, 3), false)
    expect(backpressureTransition(bp, false)?.type).toBe('dispatcher.open-pr-backpressure-engaged')
    const after = openPrBackpressure(open(3), policy(3, 3), true)
    expect(backpressureTransition(after, true)).toBeUndefined()
  })

  test('held exclusion changes the count', () => {
    const builds = [...open(2), build('held', { prState: 'open', hold: true })]
    expect(openPrBackpressure(builds, policy(3), false)?.active).toBe(true)
    expect(openPrBackpressure(builds, policy(3, undefined, true), false)).toEqual({
      active: false,
      openPrs: 2,
      maxOpenPrs: 3,
      resumeOpenPrs: 2,
      excludeHeld: true,
    })
  })
})

describe('transitions', () => {
  test('engage, steady, drain, disable', () => {
    expect(backpressureTransition(openPrBackpressure(open(2), policy(2), false), false)).toEqual({
      type: 'dispatcher.open-pr-backpressure-engaged',
      payload: { openPrs: 2, maxOpenPrs: 2, resumeOpenPrs: 1, excludeHeld: false },
    })
    expect(
      backpressureTransition(openPrBackpressure(open(2), policy(2), true), true),
    ).toBeUndefined()
    expect(
      backpressureTransition(openPrBackpressure(open(1), policy(2), false), false),
    ).toBeUndefined()
    expect(backpressureTransition(openPrBackpressure(open(1), policy(2), true), true)).toEqual({
      type: 'dispatcher.open-pr-backpressure-cleared',
      payload: { openPrs: 1, reason: 'drained' },
    })
    expect(backpressureTransition(undefined, true, 4)).toEqual({
      type: 'dispatcher.open-pr-backpressure-cleared',
      payload: { openPrs: 4, reason: 'disabled' },
    })
    expect(backpressureTransition(undefined, false)).toBeUndefined()
  })

  test('every transition is a valid dispatcher-authored repository write', () => {
    for (const transition of [
      backpressureTransition(openPrBackpressure(open(2), policy(2), false), false),
      backpressureTransition(openPrBackpressure(open(1), policy(2), true), true),
      backpressureTransition(undefined, true),
    ]) {
      const write = { actor: DISPATCHER, ...transition! }
      expect(validateRepositoryEventWrite(write)).toEqual(write)
    }
    expect(() =>
      validateRepositoryEventWrite({
        actor: DISPATCHER,
        type: 'dispatcher.open-pr-backpressure-engaged',
        payload: { openPrs: 1, maxOpenPrs: 0, resumeOpenPrs: 0, excludeHeld: false },
      }),
    ).toThrow()
  })
})

describe('engagement reducer', () => {
  const event = (seq: number, write: NonNullable<ReturnType<typeof backpressureTransition>>) =>
    ({
      repo: 'repo',
      seq,
      ts: `2026-11-20T00:00:0${seq}.000Z`,
      actor: DISPATCHER,
      ...write,
    }) as RepositoryEvent
  const engaged = backpressureTransition(openPrBackpressure(open(2), policy(2), false), false)!
  const cleared = backpressureTransition(openPrBackpressure(open(1), policy(2), true), true)!

  test('engaged, cleared, re-engaged', () => {
    expect(openPrBackpressureReducer.reduce([])).toBeUndefined()
    expect(openPrBackpressureReducer.reduce([event(1, engaged)])).toEqual({
      openPrs: 2,
      maxOpenPrs: 2,
      resumeOpenPrs: 1,
      excludeHeld: false,
      seq: 1,
      since: '2026-11-20T00:00:01.000Z',
    })
    expect(openPrBackpressureReducer.reduce([event(1, engaged), event(2, cleared)])).toBeUndefined()
    expect(
      openPrBackpressureReducer.reduce([event(1, engaged), event(2, cleared), event(3, engaged)])
        ?.seq,
    ).toBe(3)
  })

  test('split folding matches a single fold', () => {
    const events = [event(1, engaged), event(2, cleared), event(3, engaged)]
    for (let cut = 0; cut <= events.length; cut++) {
      const acc = openPrBackpressureReducer.advance(
        openPrBackpressureReducer.advance(
          openPrBackpressureReducer.initial(),
          events.slice(0, cut),
        ),
        events.slice(cut),
      )
      expect(openPrBackpressureReducer.finish(acc)).toEqual(
        openPrBackpressureReducer.reduce(events),
      )
    }
  })
})

describe('projection and wording', () => {
  test('dispatchCapacity without the option is unchanged', () => {
    const builds = open(3)
    expect(dispatchCapacity(builds, 4, now)).toEqual({
      configured: 4,
      occupied: 3,
      effective: 4,
      borrowingNodes: [],
    })
    expect(dispatchCapacity(builds, 4, now, { openPrs: { policy: {}, engaged: true } })).toEqual(
      dispatchCapacity(builds, 4, now),
    )
  })

  test('an active backpressure clause joins the shared control-line wording', () => {
    const capacity = dispatchCapacity(open(2), 4, now, {
      openPrs: { policy: { maxOpenPrs: 2, excludeHeldOpenPrs: false }, engaged: false },
    })
    expect(capacity.backpressure).toEqual({
      active: true,
      openPrs: 2,
      maxOpenPrs: 2,
      resumeOpenPrs: 1,
      excludeHeld: false,
    })
    expect(capacityExplanation(capacity)).toBe(
      ' (4 configured; open-PR backpressure: 2 open root PRs ≥ maxOpenPrs 2; normal claims paused until ≤ 1 (urgent still claimed))',
    )
    const inactive = dispatchCapacity(open(1), 4, now, {
      openPrs: { policy: { maxOpenPrs: 2, excludeHeldOpenPrs: false }, engaged: false },
    })
    expect(inactive.backpressure?.active).toBe(false)
    expect(capacityExplanation(inactive)).toBe('')
  })

  test('backpressure retains urgent claim reservations in the shared projection', () => {
    const capacity = dispatchCapacity(open(2), 4, now, {
      urgentClaims: 1,
      openPrs: { policy: { maxOpenPrs: 2 }, engaged: false },
    })
    expect(capacity.urgentClaims).toBe(1)
    expect(capacity.backpressure?.active).toBe(true)
    expect(capacityExplanation(capacity)).toContain('urgent ticket claim waiting ahead')
    expect(capacityExplanation(capacity)).toContain('normal claims paused')
  })

  test('explanation and status lines', () => {
    const active = openPrBackpressure(open(12), policy(12, 11, true), false)!
    expect(backpressureExplanation(active)).toBe(
      'open-PR backpressure: 12 open root PRs ≥ maxOpenPrs 12; normal claims paused until ≤ 11 (urgent still claimed); held PRs excluded',
    )
    expect(backpressureStatusLine(active)).toBe(
      'open-PR backpressure: active — 12 open root PRs (max 12, resume 11, held excluded); normal-priority claims paused, urgent still claimed',
    )
    const inactive = openPrBackpressure(open(1), policy(12), false)!
    expect(backpressureExplanation(inactive)).toBe('')
    expect(backpressureStatusLine(inactive)).toBe(
      'open-PR backpressure: inactive — 1 open root PR (max 12, resume 11)',
    )
  })
})

describe('[policy] configuration', () => {
  const parse = (policy: Record<string, unknown>) =>
    configSchema.safeParse({
      capacity: 2,
      tickets: { source: 'file', readyState: 'ready' },
      policy,
    })

  test('accepts the watermark combinations and defaults to disabled', () => {
    for (const policy of [
      { maxOpenPrs: 4 },
      { maxOpenPrs: 4, resumeOpenPrs: 2 },
      { maxOpenPrs: 4, resumeOpenPrs: 4 },
      { maxOpenPrs: 4, resumeOpenPrs: 0, excludeHeldOpenPrs: true },
      { resumeOpenPrs: 9 },
    ])
      expect(parse(policy).success).toBe(true)
    const defaults = parse({})
    expect(defaults.success && openPrBackpressurePolicy(defaults.data.policy)).toBeUndefined()
    expect(defaults.success && defaults.data.policy.excludeHeldOpenPrs).toBe(false)
  })

  test('rejects a resume above the high watermark and a zero high watermark', () => {
    const resume = parse({ maxOpenPrs: 2, resumeOpenPrs: 3 })
    expect(resume.success).toBe(false)
    expect(resume.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['policy', 'resumeOpenPrs'],
        message:
          'policy.resumeOpenPrs must not exceed policy.maxOpenPrs (resumeOpenPrs = 3, maxOpenPrs = 2)',
      }),
    )
    expect(parse({ maxOpenPrs: 0 }).success).toBe(false)
    expect(parse({ maxOpenPrs: 2, resumeOpenPrs: -1 }).success).toBe(false)
  })
})
