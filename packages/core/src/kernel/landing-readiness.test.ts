import { describe, expect, test } from 'bun:test'
import type { AbEvent, EventWrite } from '../events/catalog'
import { validateEventWrite } from '../events/catalog'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import type { LeafRestackState } from './leaf-restack-state'
import {
  actionableCommands,
  candidateHeadMatches,
  currentCandidateHead,
  landPreconditions,
  landRefusalReason,
  leafLandingCandidate,
  leafLandingDeclineReason,
  leafLandingUndecidedReason,
} from './landing-readiness'
import { buildReducer } from './reducer'

const event = (seq: number, write: EventWrite): AbEvent =>
  ({
    ...validateEventWrite(write),
    build: 'test',
    seq,
    ts: new Date(0).toISOString(),
  }) as AbEvent
const finalized = (head = 'head'): EventWrite => ({
  actor: KERNEL,
  type: 'finalize.completed',
  payload: { pr: { number: 1, url: 'https://forge/1', headSha: head } },
})
const decided = (head = 'head'): EventWrite => ({
  actor: DISPATCHER,
  type: 'landing.decided',
  payload: {
    candidate: { head, parent: 'base', cycle: '1' },
    from: 'leaf',
    into: { kind: 'root' },
    labels: [],
    mode: 'consent',
    rule: { default: true },
  },
})
const reduce = (...writes: EventWrite[]) =>
  buildReducer.reduce(writes.map((write, i) => event(i + 1, write)))
const idle: LeafRestackState = { gates: {} }

describe('land refusal reasons', () => {
  const cases: Array<{
    name: string
    writes: EventWrite[]
    restack?: LeafRestackState
    reason: string | undefined
  }> = [
    { name: 'ready leaf candidate', writes: [finalized(), decided()], reason: undefined },
    {
      name: 'no decision',
      writes: [finalized()],
      reason: 'no merge candidate has been decided yet',
    },
    {
      name: 'paused',
      writes: [finalized(), decided(), { actor: KERNEL, type: 'build.paused', payload: {} }],
      reason: 'the build is paused',
    },
    {
      name: 'open escalation',
      writes: [
        finalized(),
        decided(),
        {
          actor: agentActor('implement', 'session-1'),
          type: 'escalation.raised',
          payload: { id: 'esc', phase: 'implement', round: 1, source: 'agent', question: 'Q?' },
        },
      ],
      reason: 'the build has open escalations to answer',
    },
    {
      name: 'stale head',
      writes: [finalized('newer'), decided()],
      reason: "the merge candidate's head is stale",
    },
    {
      name: 'active restack',
      writes: [finalized(), decided()],
      restack: { gates: {}, active: {} as NonNullable<LeafRestackState['active']> },
      reason: 'a restack is in progress',
    },
  ]
  for (const item of cases)
    test(item.name, () => {
      const state = reduce(...item.writes)
      const restack = item.restack ?? idle
      expect(landRefusalReason(state, restack)).toBe(item.reason)
      expect(landPreconditions(state, restack)).toBe(item.reason === undefined)
    })
})

const human = humanActor('operator')
const pauseRequested: EventWrite = { actor: human, type: 'build.pause-requested', payload: {} }
const resumeRequested: EventWrite = { actor: human, type: 'build.resume-requested', payload: {} }
const paused: EventWrite = { actor: KERNEL, type: 'build.paused', payload: {} }
const janitorFailed: EventWrite = {
  actor: DISPATCHER,
  type: 'build.janitor-attempt-failed',
  payload: {
    firstFailureAt: '2026-11-14T00:31:00.000Z',
    attempt: 2,
    message: 'provider unavailable',
    nextAttemptAt: '2026-11-14T00:33:00.000Z',
  },
}

describe('controls that still block work (#944)', () => {
  test('a resume that cancelled an unacknowledged pause is inert on a running build', () => {
    const state = reduce(finalized(), pauseRequested, resumeRequested)
    expect(state.pendingCommands.map((c) => c.command)).toEqual(['resume'])
    expect(actionableCommands(state)).toEqual([])
  })

  test('a resume on a paused build is actionable', () => {
    const state = reduce(finalized(), pauseRequested, paused, resumeRequested)
    expect(state.status).toBe('paused')
    expect(actionableCommands(state).map((c) => c.command)).toEqual(['resume'])
  })

  test('pause and abort requests are always actionable', () => {
    expect(actionableCommands(reduce(finalized(), pauseRequested)).map((c) => c.command)).toEqual([
      'pause',
    ])
    const abort: EventWrite = { actor: human, type: 'build.abort-requested', payload: {} }
    expect(actionableCommands(reduce(finalized(), abort)).map((c) => c.command)).toEqual(['abort'])
  })

  test('the land guard ignores an inert resume and still refuses a pending pause', () => {
    expect(
      landRefusalReason(reduce(finalized(), pauseRequested, resumeRequested, decided()), idle),
    ).toBeUndefined()
    expect(landRefusalReason(reduce(finalized(), decided(), pauseRequested), idle)).toBe(
      'earlier controls are awaiting acknowledgement',
    )
  })
})

describe('leaf landing decline reasons', () => {
  const cases: Array<{ name: string; writes: EventWrite[]; reason: string | undefined }> = [
    {
      name: 'clean leaf with an inert resume',
      writes: [finalized(), pauseRequested, resumeRequested],
      reason: undefined,
    },
    {
      name: 'open session',
      writes: [
        finalized(),
        {
          actor: KERNEL,
          type: 'session.started',
          payload: { session: 's1', role: 'reconcile', runner: 'claude', phase: 'reconcile' },
        },
      ],
      reason: 'session s1 (reconcile) is still open',
    },
    {
      name: 'paused',
      writes: [finalized(), pauseRequested, paused],
      reason: 'the build is paused',
    },
    {
      name: 'aborted',
      writes: [
        finalized(),
        { actor: human, type: 'build.abort-requested', payload: {} },
        { actor: KERNEL, type: 'build.aborted', payload: {} },
      ],
      reason: 'the build is aborted',
    },
    {
      name: 'open escalation',
      writes: [
        finalized(),
        {
          actor: agentActor('implement', 'session-1'),
          type: 'escalation.raised',
          payload: { id: 'esc', phase: 'implement', round: 1, source: 'agent', question: 'Q?' },
        },
      ],
      reason: 'the build has open escalations to answer',
    },
    {
      name: 'pending pause',
      writes: [finalized(), pauseRequested],
      reason: 'a pause request awaits acknowledgement',
    },
  ]
  for (const item of cases)
    test(item.name, () => {
      expect(leafLandingDeclineReason(reduce(...item.writes))).toBe(item.reason)
    })
})

describe('leaf landing candidate', () => {
  const state = reduce(finalized('pr-head'))
  test('names the restacked base', () => {
    const restack = {
      gates: {},
      initialBase: 'initial',
      completed: { targetBase: 'restacked' },
    } as unknown as LeafRestackState
    expect(leafLandingCandidate(state, restack)).toEqual({
      head: 'pr-head',
      parent: 'restacked',
      cycle: String(state.finalizeCompletedSeq),
    })
  })
  test('falls back to the initial base', () => {
    expect(leafLandingCandidate(state, { gates: {}, initialBase: 'initial' })?.parent).toBe(
      'initial',
    )
    expect(leafLandingCandidate(state, idle)?.parent).toBe('')
  })
  test('is absent without a PR', () => {
    expect(leafLandingCandidate(reduce(pauseRequested), idle)).toBeUndefined()
  })
})

describe('why an awaiting-pr leaf is undecided', () => {
  const based: LeafRestackState = { gates: {}, initialBase: 'base' }
  test('a state guard outranks a janitor episode', () => {
    expect(
      leafLandingUndecidedReason(reduce(finalized(), janitorFailed, pauseRequested), based),
    ).toBe('a pause request awaits acknowledgement')
  })
  test('compatibility deferral', () => {
    const state = reduce(finalized())
    expect(
      leafLandingUndecidedReason(
        {
          ...state,
          compatibility: {
            ...state.compatibility,
            decisiveFacts: 1,
            decisiveTypes: ['future.fact'],
            decisiveWriterVersions: ['9.0.0'],
          },
        },
        based,
      ),
    ).toStartWith('deferred for compatibility — Kernel decisions deferred')
  })
  test('janitor episode, with and without escalation', () => {
    expect(leafLandingUndecidedReason(reduce(finalized(), janitorFailed), based)).toBe(
      'dispatcher janitor attempt 2 failed — provider unavailable; next attempt 2026-11-14T00:33:00.000Z',
    )
    const state = reduce(finalized(), janitorFailed)
    expect(
      leafLandingUndecidedReason(
        { ...state, janitor: { ...state.janitor!, escalation: 'e' } },
        based,
      ),
    ).toEndWith(' (escalated)')
  })
  test('unreadable pipeline', () => {
    expect(leafLandingUndecidedReason(reduce(finalized()), based, 'artifact@3: bad')).toBe(
      "the dispatcher cannot read this build's pipeline configuration (artifact@3: bad); landing decisions are withheld until it is restored",
    )
  })
  test('missing candidate base', () => {
    expect(leafLandingUndecidedReason(reduce(finalized()), idle)).toBe(
      'no base is recorded for the merge candidate',
    )
  })
  test('fallback', () => {
    expect(leafLandingUndecidedReason(reduce(finalized()), based)).toStartWith(
      'no refusal is recorded; the dispatcher decides at its next janitor poll',
    )
  })
})

describe('consent head matching', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  test('names the live head of a leaf and of a node', () => {
    expect(
      currentCandidateHead({
        kind: 'leaf',
        pr: { number: 1, url: 'u', headSha: 'leaf-head' },
        integration: undefined,
      } as never),
    ).toBe('leaf-head')
    expect(
      currentCandidateHead({
        kind: 'node',
        pr: { number: 1, url: 'u', headSha: 'pr-head' },
        integration: { cycle: { head: 'cycle-head' } },
      } as never),
    ).toBe('cycle-head')
    expect(currentCandidateHead({ kind: 'leaf' } as never)).toBeUndefined()
  })

  test('matches exact heads, case-insensitively, and hexadecimal prefixes of seven or more', () => {
    expect(candidateHeadMatches(sha, sha)).toBe(true)
    expect(candidateHeadMatches(sha.toUpperCase(), sha)).toBe(true)
    expect(candidateHeadMatches(sha.slice(0, 7), sha)).toBe(true)
    expect(candidateHeadMatches(sha.slice(0, 12).toUpperCase(), sha)).toBe(true)
    expect(candidateHeadMatches(sha.slice(0, 6), sha)).toBe(false)
    expect(candidateHeadMatches('head', 'head')).toBe(true)
    expect(candidateHeadMatches('head', 'headless')).toBe(false)
    expect(candidateHeadMatches('feature-', 'feature-branch')).toBe(false)
    expect(candidateHeadMatches('1234567', sha)).toBe(false)
    expect(candidateHeadMatches(sha, undefined)).toBe(false)
  })
})
