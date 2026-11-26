/**
 * Ticket waits (SPEC §11 "Ticket waits"): the reducer's request/outcome and
 * wait folding, the engine's parking and resume routing per declaring phase,
 * capacity parking, and the terminal guard. Every fixture write passes
 * `validateEventWrite`, and every reduced log is held to the incremental
 * contract.
 */
import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { parseConfig } from '../config/load'
import { KERNEL, humanActor, type Actor } from '../events/envelope'
import {
  allowedActorKinds,
  validateEventWrite,
  type AbEvent,
  type EventWrite,
} from '../events/catalog'
import type { eventPayloadSchemas, EventType } from '../events/payloads'
import type { Phase } from '../ontology'
import { steppingClock } from '../testing/fixed'
import {
  dispatchCapacity,
  intakeCapacity,
  occupiesCapacity,
  slotRequest,
  type CapacityBuild,
} from './dispatch-capacity'
import { decideNext } from './engine'
import { leafTransaction } from './generators/leaf-restack-log'
import { checkIncremental } from './incremental-contract'
import { logIndexReducer } from './log-index'
import { leafBaseInUse, leafRestackedBase } from './leaf-restack-state'
import { buildReducer, reduceBuild as reduceBuildWhole, type BuildState } from './reducer'
import { terminalGuardReducer } from './terminal-guard'
import { leafVerifiedRestack } from './verify-stages'
import {
  openTicketWait,
  pendingWaitRequest,
  ticketWaitRelease,
  ticketWaitStatus,
  waitBlock,
  waitParked,
  waitResumeDue,
  waitResumeSupersedes,
  waitUnresolvableQuestion,
} from './ticket-wait'

const BUILD = 'waits-on-a'

const config = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
test = "bun test"

[verify]
steps = ["unit", "e2e"]

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"
`)

type PayloadInput<T extends EventType> = z.input<(typeof eventPayloadSchemas)[T]>

function defaultActor(type: EventType): Actor {
  switch (allowedActorKinds[type][0]) {
    case 'kernel':
      return KERNEL
    case 'dispatcher':
      return { kind: 'dispatcher' }
    case 'human':
      return humanActor('aron')
    case 'agent':
      return { kind: 'agent', role: 'test-role', session: 's_test' }
    default:
      return { kind: 'ingester', source: 'test' }
  }
}

function ev<T extends EventType>(
  type: T,
  payload: PayloadInput<T>,
  actor: Actor = defaultActor(type),
): EventWrite {
  return validateEventWrite({ actor, type, payload })
}

function toLog(writes: EventWrite[]): AbEvent[] {
  const clock = steppingClock()
  const log = writes.map(
    (write, index) =>
      ({
        build: BUILD,
        seq: index + 1,
        ts: clock().toISOString(),
        actor: write.actor,
        type: write.type,
        payload: write.payload,
      }) as AbEvent,
  )
  // Verify-phase fixtures begin after the entry restack has completed.
  const approval = log.findLast(
    (e) => e.type === 'code-review.verdict' && e.payload.verdict === 'approve',
  )
  const firstVerify = log.findIndex(
    (e) => approval !== undefined && e.seq > approval.seq && e.type === 'verify.started',
  )
  if (approval && firstVerify >= 0) {
    log.splice(firstVerify, 0, {
      build: BUILD,
      seq: 0,
      ts: clock().toISOString(),
      actor: KERNEL,
      type: 'restack.completed',
      payload: { ...leafTransaction, cycle: approval.seq, headSha: 'e'.repeat(40) },
    } as AbEvent)
    log.forEach((event, index) => {
      event.seq = index + 1
    })
  }
  checkIncremental(logIndexReducer, log, { stepwise: false })
  checkIncremental(buildReducer, log, { stepwise: false })
  return log
}

const reduce = (writes: EventWrite[]): BuildState => reduceBuildWhole(toLog(writes))
const decide = (writes: EventWrite[]) => decideNext(toLog(writes), config)

const agent = (session: string, role = 'agent'): Actor => ({ kind: 'agent', role, session })

function prelude(): EventWrite[] {
  return [
    ev('build.created', {
      ticket: { source: 'file', id: 'A' },
      repo: 'repo',
      baseBranch: 'main',
    }),
    ev('workspace.provisioned', {
      provider: 'worktree',
      ref: '/ws/a',
      branch: 'ab/a',
      base: { source: 'remote', sha: 'base-sha' },
    }),
    ev('spec.imported', {
      artifact: { kind: 'spec', rev: 0 },
      ticket: { source: 'file', id: 'A' },
    }),
    ev('runner.attached', { instance: 'runner-1', host: 'local' }),
  ]
}

function session(id: string, phase: Phase, round: number): EventWrite {
  return ev('session.started', { session: id, phase, round, role: 'agent', runner: 'scripted' })
}

function request(id: string, phase: Phase, round: number, sessionId: string, tickets = ['B']) {
  return ev(
    'wait.requested',
    { id, phase, round, tickets, reason: 'needs the B schema' },
    agent(sessionId),
  )
}

function entered(id: string, escalation: string, tickets = ['B']): EventWrite {
  return ev('wait.entered', {
    id,
    escalation,
    tickets: tickets.map((ticket) => ({ source: 'file', id: ticket })),
    reason: 'needs the B schema',
    question: `Waiting on ${tickets.join(', ')} to complete`,
  })
}

const ended = (id: string): EventWrite =>
  ev('session.ended', {
    session: id,
    outcome: 'reclaimed',
    reclaimedBy: { instance: 'old', resumedFromSeq: 0 },
  })

/** plan@1 declares a wait on B, the dispatcher enters it. */
function planWait(): EventWrite[] {
  return [
    ...prelude(),
    ev('plan.started', { round: 1 }),
    session('s_plan', 'plan', 1),
    request('wait_1', 'plan', 1, 's_plan'),
    ended('s_plan'),
  ]
}

describe('ticket-wait events', () => {
  test('ticket ids are 1..20, trimmed, nonblank and unique', () => {
    const write = (tickets: string[]) =>
      validateEventWrite({
        actor: agent('s'),
        type: 'wait.requested',
        payload: { id: 'w', phase: 'plan', round: 1, tickets, reason: 'r' },
      })
    expect(write([' B ']).payload).toMatchObject({ tickets: ['B'] })
    expect(() => write([])).toThrow()
    expect(() => write([' '])).toThrow()
    expect(() => write(['B', ' B'])).toThrow('duplicate ticket id')
    expect(() => write(Array.from({ length: 21 }, (_, i) => `T-${i}`))).toThrow()
    expect(() =>
      validateEventWrite({
        actor: agent('s'),
        type: 'wait.requested',
        payload: { id: 'w', phase: 'plan', round: 1, tickets: ['B'], reason: '  ' },
      }),
    ).toThrow()
  })

  test('actors: agents request, the dispatcher decides, any operator surface may end', () => {
    expect(allowedActorKinds['wait.requested']).toEqual(['agent'])
    expect(allowedActorKinds['wait.refused']).toEqual(['dispatcher'])
    expect(allowedActorKinds['wait.entered']).toEqual(['dispatcher'])
    expect(allowedActorKinds['wait.ended']).toEqual(['dispatcher', 'kernel', 'human'])
    expect(() =>
      validateEventWrite({
        actor: KERNEL,
        type: 'wait.requested',
        payload: { id: 'w', phase: 'plan', round: 1, tickets: ['B'], reason: 'r' },
      }),
    ).toThrow()
  })
})

describe('reducer: ticket waits', () => {
  test('a request waits for its outcome; mismatched outcomes are ignored', () => {
    const pending = reduce(planWait())
    expect(pendingWaitRequest(pending)).toMatchObject({
      id: 'wait_1',
      session: 's_plan',
      phase: 'plan',
      round: 1,
      tickets: ['B'],
    })
    expect(ticketWaitStatus(pending)).toMatchObject({ state: 'requested', tickets: ['B'] })
    const stray = reduce([
      ...planWait(),
      entered('wait_other', 'esc_other'),
      ev('wait.refused', { id: 'wait_other', cause: 'completed', tickets: ['B'], message: 'm' }),
    ])
    expect(pendingWaitRequest(stray)).toBeDefined()
    expect(stray.wait).toBeUndefined()
    expect(stray.openEscalations).toEqual([])
  })

  test('a refusal records its cause and opens nothing', () => {
    const state = reduce([
      ...planWait(),
      ev('wait.refused', {
        id: 'wait_1',
        cause: 'completed',
        tickets: ['B'],
        message: 'already completed: B',
      }),
    ])
    expect(pendingWaitRequest(state)).toBeUndefined()
    expect(state.waitRequest?.outcome).toMatchObject({ kind: 'refused', cause: 'completed' })
    expect(state.wait).toBeUndefined()
    expect(state.status).toBe('running')
    expect(waitBlock(state, 'plan', 1)).toMatchObject({ outcome: 'refused', tickets: ['B'] })
    expect(waitBlock(state, 'plan', 2)).toBeUndefined()
  })

  test('entering opens a blocked wait escalation owned by the declaring session', () => {
    const state = reduce([...planWait(), entered('wait_1', 'esc_w')])
    expect(state.status).toBe('blocked')
    expect(state.openEscalations).toEqual([
      expect.objectContaining({
        id: 'esc_w',
        phase: 'plan',
        round: 1,
        source: 'agent',
        session: 's_plan',
        wait: { id: 'wait_1' },
        refs: ['B'],
      }),
    ])
    expect(openTicketWait(state)).toMatchObject({ id: 'wait_1', tickets: [{ id: 'B' }] })
    expect(waitParked(state)).toBe(true)
    expect(ticketWaitStatus(state)).toMatchObject({ state: 'waiting', escalation: 'esc_w' })
  })

  test('an operator answer ends the wait; the next session start resumes it', () => {
    const answered = [
      ...planWait(),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'B landed', resolution: 'guidance' }),
    ]
    const state = reduce(answered)
    expect(state.status).toBe('running')
    expect(state.wait?.ended).toMatchObject({ cause: 'operator', message: 'B landed' })
    expect(state.answeredEscalations.at(-1)).toMatchObject({ wait: { id: 'wait_1' } })
    expect(waitParked(state)).toBe(true)
    expect(ticketWaitStatus(state)).toMatchObject({ state: 'ended', cause: 'operator' })
    expect(waitBlock(state, 'plan', 1)).toMatchObject({ outcome: 'ended', cause: 'operator' })
    const resumed = reduce([...answered, session('s_plan2', 'plan', 1)])
    expect(resumed.wait?.resumedSeq).toBeDefined()
    expect(waitParked(resumed)).toBe(false)
    expect(ticketWaitStatus(resumed)).toBeUndefined()
  })

  test('wait.ended closes the escalation as guidance; a duplicate or unknown end is ignored', () => {
    const state = reduce([
      ...planWait(),
      entered('wait_1', 'esc_w'),
      ev('wait.ended', { id: 'wait_1', cause: 'automatic', message: 'B completed' }),
      ev('wait.ended', { id: 'wait_1', cause: 'operator', message: 'again' }),
      ev('wait.ended', { id: 'wait_9', cause: 'operator', message: 'unknown' }),
    ])
    expect(state.openEscalations).toEqual([])
    expect(state.wait?.ended).toMatchObject({ cause: 'automatic', message: 'B completed' })
    expect(state.answeredEscalations).toEqual([
      expect.objectContaining({ id: 'esc_w', resolution: 'guidance', answer: 'B completed' }),
    ])
  })

  test('a spec revision resumes the wait and a terminal status ends parking', () => {
    const base = [
      ...planWait(),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'new spec', resolution: 'revise-spec' }),
    ]
    expect(waitParked(reduce(base))).toBe(true)
    const revised = reduce([
      ...base,
      ev('spec.revised', { artifact: { kind: 'spec', rev: 1 }, escalation: base.length - 1 }),
    ])
    expect(revised.wait?.resumedSeq).toBeDefined()
    const aborted = reduce([...planWait(), entered('wait_1', 'esc_w'), ev('build.aborted', {})])
    expect(waitParked(aborted)).toBe(false)
    expect(openTicketWait(aborted)).toBeUndefined()
  })
})

describe('engine: ticket waits', () => {
  test('a pending request parks the build; an entered wait is blocked', () => {
    expect(decide(planWait())).toEqual({ kind: 'wait', reason: 'ticket-wait' })
    expect(decide([...planWait(), entered('wait_1', 'esc_w')])).toEqual({
      kind: 'wait',
      reason: 'blocked',
    })
  })

  test('an ended plan wait re-runs plan at the same round with the answer', () => {
    expect(
      decide([
        ...planWait(),
        entered('wait_1', 'esc_w'),
        ev('escalation.answered', { id: 'esc_w', answer: 'B landed', resolution: 'guidance' }),
      ]),
    ).toEqual({
      kind: 'run-phase',
      phase: 'plan',
      round: 1,
      feedback: { guidance: { escalation: 'esc_w', answer: 'B landed' } },
    })
    expect(
      decide([
        ...planWait(),
        entered('wait_1', 'esc_w'),
        ev('wait.ended', { id: 'wait_1', cause: 'automatic', message: 'B completed' }),
      ]),
    ).toMatchObject({
      phase: 'plan',
      round: 1,
      feedback: { guidance: { escalation: 'esc_w', answer: 'B completed' } },
    })
  })

  test('an implement refusal re-runs implement with the refusal, delivered once', () => {
    const refused = [
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('implement.started', { round: 1 }),
      session('s_impl', 'implement', 1),
      request('wait_1', 'implement', 1, 's_impl'),
      ended('s_impl'),
      ev('wait.refused', {
        id: 'wait_1',
        cause: 'completed',
        tickets: ['B'],
        message: 'already completed: B; continue without waiting on them',
      }),
    ]
    const guidance = {
      guidance: {
        escalation: 'wait_1',
        answer: 'already completed: B; continue without waiting on them',
      },
    }
    expect(decide(refused)).toEqual({
      kind: 'run-phase',
      phase: 'implement',
      round: 1,
      feedback: guidance,
    })
    expect(
      decide([
        ...refused,
        ev('implement.started', { round: 1, feedback: guidance }),
        session('s_impl2', 'implement', 1),
      ]),
    ).toEqual({ kind: 'run-phase', phase: 'implement', round: 1 })
  })

  test('a code-review wait re-runs the same review round without feeding the producer', () => {
    const log = [
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('implement.started', { round: 1 }),
      ev('implement.completed', {
        round: 1,
        commits: { base: 'sha-base', head: 'sha-1' },
        artifact: { kind: 'implement-notes', rev: 0 },
      }),
      ev('code-review.started', { round: 1 }),
      session('s_review', 'code-review', 1),
      request('wait_1', 'code-review', 1, 's_review'),
      ended('s_review'),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'B landed', resolution: 'guidance' }),
    ]
    expect(decide(log)).toEqual({ kind: 'run-phase', phase: 'code-review', round: 1 })
  })

  test('an agent verifier wait re-runs the same step and attempt with its answer', () => {
    const log = [
      ...prelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('implement.started', { round: 1 }),
      ev('implement.completed', {
        round: 1,
        commits: { base: 'sha-base', head: 'sha-1' },
        artifact: { kind: 'implement-notes', rev: 0 },
      }),
      ev('code-review.started', { round: 1 }),
      ev('code-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'code-review', rev: 0 },
      }),
      ev('verify.started', { step: 'unit', attempt: 1 }),
      ev('verify.completed', { step: 'unit', attempt: 1, pass: true }),
      ev('verify.started', { step: 'e2e', attempt: 1 }),
      session('s_e2e', 'verify:e2e', 1),
      request('wait_1', 'verify:e2e', 1, 's_e2e'),
      ended('s_e2e'),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'B landed', resolution: 'guidance' }),
    ]
    expect(decide(log)).toEqual({
      kind: 'run-agent-verify',
      step: 'e2e',
      skill: 'ab-verify-e2e',
      attempt: 1,
      feedback: { guidance: { escalation: 'esc_w', answer: 'B landed' } },
    })
  })
})

describe('automatic release and unresolvable waits', () => {
  const node = (resolved: boolean, extra: { exists?: boolean; rejected?: boolean } = {}) => ({
    exists: extra.exists ?? true,
    resolved,
    ...(extra.rejected ? { rejected: true, state: 'Canceled' } : {}),
  })

  test('ticketWaitRelease: complete only when every ticket completed', () => {
    const nodes = new Map([
      ['B', node(true)],
      ['C', node(false)],
      ['R', node(false, { rejected: true })],
      ['M', node(false, { exists: false })],
    ])
    expect(ticketWaitRelease(['B'], nodes)).toEqual({ kind: 'complete' })
    expect(ticketWaitRelease(['B', 'C'], nodes)).toBeUndefined()
    expect(ticketWaitRelease(['B', 'X'], nodes)).toBeUndefined()
    expect(ticketWaitRelease(['R'], nodes)).toEqual({
      kind: 'unresolvable',
      tickets: [{ id: 'R', why: 'rejected', state: 'Canceled' }],
    })
    expect(ticketWaitRelease(['M'], nodes)).toEqual({
      kind: 'unresolvable',
      tickets: [{ id: 'M', why: 'missing' }],
    })
    expect(ticketWaitRelease(['C', 'R', 'M'], nodes)).toEqual({
      kind: 'unresolvable',
      tickets: [
        { id: 'R', why: 'rejected', state: 'Canceled' },
        { id: 'M', why: 'missing' },
      ],
    })
  })

  test('the unresolvable question names each ticket and why', () => {
    expect(
      waitUnresolvableQuestion(
        ['B', 'C'],
        [
          { id: 'B', why: 'rejected', state: 'Canceled' },
          { id: 'C', why: 'missing' },
        ],
        'linear',
      ),
    ).toBe(
      'Waiting on B, C can never end: B was rejected (state "Canceled"); C no longer exists in the linear ticket source. Answer with guidance to resume the declaring phase without it, revise the spec, or abort.',
    )
  })

  const unresolvable = (id = 'esc_u') =>
    ev(
      'escalation.raised',
      {
        id,
        phase: 'plan',
        round: 1,
        source: 'policy',
        policyCause: 'wait-unresolvable',
        question: 'Waiting on B can never end: B was rejected',
        refs: ['B'],
      },
      { kind: 'dispatcher' },
    )
  const raised = () => [...planWait(), entered('wait_1', 'esc_w'), unresolvable()]

  test('the dispatcher may raise wait-unresolvable', () => {
    expect(() => unresolvable()).not.toThrow()
  })

  test('the raise ends the wait, closes its escalation and blocks on the marked one', () => {
    const state = reduce(raised())
    expect(state.wait?.ended).toMatchObject({ cause: 'unresolvable' })
    expect(state.status).toBe('blocked')
    expect(state.openEscalations).toEqual([
      expect.objectContaining({
        id: 'esc_u',
        source: 'policy',
        policyCause: 'wait-unresolvable',
        wait: { id: 'wait_1' },
      }),
    ])
    expect(state.answeredEscalations).toEqual([
      expect.objectContaining({ id: 'esc_w', resolution: 'guidance' }),
    ])
    expect(openTicketWait(state)).toBeUndefined()
    expect(waitParked(state)).toBe(false)
    expect(waitResumeDue(state)).toBe(false)
    expect(waitBlock(state, 'plan', 1)).toMatchObject({ outcome: 'ended', cause: 'unresolvable' })
  })

  test('answering it resumes the declaring phase; revise-spec keeps it parked', () => {
    const answered = reduce([
      ...raised(),
      ev('escalation.answered', { id: 'esc_u', answer: 'drop B', resolution: 'guidance' }),
    ])
    expect(waitParked(answered)).toBe(true)
    expect(waitResumeDue(answered)).toBe(true)
    expect(answered.wait?.ended).toMatchObject({ cause: 'unresolvable' })
    const revise = reduce([
      ...raised(),
      ev('escalation.answered', { id: 'esc_u', answer: 'rewrite', resolution: 'revise-spec' }),
    ])
    expect(waitParked(revise)).toBe(true)
    expect(waitResumeDue(revise)).toBe(false)
  })

  test('a raise against an ended wait leaves the wait alone', () => {
    const state = reduce([
      ...planWait(),
      entered('wait_1', 'esc_w'),
      ev('wait.ended', { id: 'wait_1', cause: 'automatic', message: 'B completed' }),
      unresolvable(),
    ])
    expect(state.wait?.ended).toMatchObject({ cause: 'automatic' })
    expect(state.openEscalations).toEqual([
      expect.not.objectContaining({ wait: expect.anything() }),
    ])
  })
})

describe('capacity: ticket waits', () => {
  const now = new Date('2026-11-16T15:00:00Z')
  function capacityBuild(slug: string, state: BuildState, lease = false): CapacityBuild {
    return {
      record: {
        slug,
        repo: 'repo',
        ticket: { source: 'file', id: slug },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        ...(lease
          ? {
              lease: {
                holder: 'runner',
                expiresAt: new Date(now.getTime() + 60_000).toISOString(),
              },
            }
          : {}),
      },
      state,
      workspace: true,
    }
  }
  const execution = (type: 'execution.started' | 'execution.ended') =>
    type === 'execution.started'
      ? ev(type, { provider: 'local', workspaceRef: '/ws/a', instance: 'i1' })
      : ev(type, { instance: 'i1', workspaceRef: '/ws/a', outcome: 'completed' })
  // Its runner ran the declaring phase and stopped on the declaration.
  const stoppedWait = () => [
    ...planWait().slice(0, prelude().length),
    execution('execution.started'),
    ...planWait().slice(prelude().length),
    execution('execution.ended'),
  ]
  const open = () => reduce([...stoppedWait(), entered('wait_1', 'esc_w')])
  const answered = () =>
    reduce([
      ...stoppedWait(),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'B landed', resolution: 'guidance' }),
    ])

  test('an open waiting leaf with no runner holds no slot and requests none', () => {
    const waiting = capacityBuild('a', open())
    expect(occupiesCapacity(waiting, now)).toBe(false)
    expect(slotRequest(waiting, now)).toBeUndefined()
    expect(dispatchCapacity([waiting, capacityBuild('c', reduce(prelude()))], 1, now)).toEqual({
      configured: 1,
      occupied: 1,
      effective: 1,
      borrowingNodes: [],
      slots: { a: { state: 'none' }, c: { state: 'held' } },
    })
  })

  test('an entered wait holds no slot once its runner stops, whatever its lease or a co-open question', () => {
    expect(occupiesCapacity(capacityBuild('a', open(), true), now)).toBe(false)
    // Until its execution ends, the runner is still working (#1348).
    const executing = reduce([...stoppedWait().slice(0, -1), entered('wait_1', 'esc_w')])
    expect(occupiesCapacity(capacityBuild('a', executing), now)).toBe(true)
    const questioned = reduce([
      ...stoppedWait(),
      entered('wait_1', 'esc_w'),
      ev(
        'escalation.raised',
        { id: 'esc_q', phase: 'plan', round: 1, source: 'agent', question: 'which API?' },
        agent('s_other'),
      ),
    ])
    expect(occupiesCapacity(capacityBuild('a', questioned), now)).toBe(false)
    expect(slotRequest(capacityBuild('a', questioned), now)).toBeUndefined()
  })

  test('pending and refused requests keep the slot', () => {
    expect(occupiesCapacity(capacityBuild('a', reduce(planWait())), now)).toBe(true)
    const refused = reduce([
      ...stoppedWait(),
      ev('wait.refused', { id: 'wait_1', cause: 'completed', tickets: ['B'], message: 'done' }),
    ])
    expect(occupiesCapacity(capacityBuild('a', refused), now)).toBe(true)
  })

  test('an ended wait requests a resume slot ahead of normal claims until admitted', () => {
    const automatic = reduce([
      ...stoppedWait(),
      entered('wait_1', 'esc_w'),
      ev('wait.ended', { id: 'wait_1', cause: 'automatic', message: 'B completed' }),
    ])
    for (const ended of [answered(), automatic]) {
      const resuming = capacityBuild('a', ended)
      expect(occupiesCapacity(resuming, now)).toBe(false)
      expect(slotRequest(resuming, now)).toBe('resume')
      const capacity = dispatchCapacity([resuming], 1, now)
      expect(capacity.waitingBuilds).toEqual([{ slug: 'a', request: 'resume' }])
      expect(intakeCapacity(capacity)).toBe(0)
    }
    const admitted = capacityBuild(
      'a',
      reduce([
        ...stoppedWait(),
        entered('wait_1', 'esc_w'),
        ev('wait.ended', { id: 'wait_1', cause: 'automatic', message: 'B completed' }),
        ev('slot.admitted', { request: 'resume' }),
      ]),
    )
    expect(occupiesCapacity(admitted, now)).toBe(true)
    expect(slotRequest(admitted, now)).toBeUndefined()
  })

  test('a paused or revise-spec wait requests no slot', () => {
    const paused = answered()
    paused.status = 'paused'
    expect(slotRequest(capacityBuild('a', paused), now)).toBeUndefined()
    const revise = reduce([
      ...stoppedWait(),
      entered('wait_1', 'esc_w'),
      ev('escalation.answered', { id: 'esc_w', answer: 'rewrite', resolution: 'revise-spec' }),
    ])
    expect(slotRequest(capacityBuild('a', revise), now)).toBeUndefined()
  })
})

test('terminal guard: after wait.requested this session can run no other terminal', () => {
  const log = toLog(planWait().slice(0, -1))
  const guard = terminalGuardReducer({ phase: 'plan', round: 1, session: 's_plan' })
  expect(guard.reduce(log).diagnostic).toContain('already declared a wait')
  const other = terminalGuardReducer({ phase: 'plan', round: 1, session: 's_other' })
  expect(other.reduce(log).diagnostic).toBeUndefined()
})

describe('wait-resume restack', () => {
  const BASE = '1'.repeat(40)
  const T1 = '2'.repeat(40)
  const T2 = '3'.repeat(40)
  const HEAD = '4'.repeat(40)

  function oidPrelude(): EventWrite[] {
    return prelude().map((write) =>
      write.type === 'workspace.provisioned'
        ? ev('workspace.provisioned', {
            provider: 'worktree',
            ref: '/ws/a',
            branch: 'ab/a',
            base: { source: 'remote', sha: BASE },
          })
        : write,
    )
  }
  const moved = (sha: string) => ev('target.moved', { branch: 'main', sha })
  const answer = ev('escalation.answered', {
    id: 'esc_w',
    answer: 'B landed',
    resolution: 'guidance',
  })
  /** toLog inserts nothing for these fixtures, so seq is index + 1. */
  const seqOf = (writes: EventWrite[], write: EventWrite) => writes.indexOf(write) + 1

  function plannedWait(): EventWrite[] {
    return [
      ...oidPrelude(),
      ev('plan.started', { round: 1 }),
      session('s_plan', 'plan', 1),
      request('wait_1', 'plan', 1, 's_plan'),
      ended('s_plan'),
      entered('wait_1', 'esc_w'),
      answer,
    ]
  }

  function approvedThroughCode(): EventWrite[] {
    return [
      ...oidPrelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('implement.started', { round: 1 }),
      ev('implement.completed', {
        round: 1,
        commits: { base: BASE, head: HEAD },
        artifact: { kind: 'implement-notes', rev: 0 },
      }),
      ev('code-review.started', { round: 1 }),
      ev('code-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'code-review', rev: 0 },
      }),
    ]
  }

  const transaction = (
    trigger: 'verify-entry' | 'wait-resume',
    targetBase: string,
    id = 'rs-1',
  ) => ({
    ...leafTransaction,
    id,
    trigger,
    oldBase: BASE,
    oldHead: HEAD,
    targetBase,
  })

  const {
    trigger: _trigger,
    cycle: _cycle,
    observation: _observation,
    message: _message,
    ...reconcileTx
  } = transaction('verify-entry', T1)

  /** Verify entry conflicts onto T1; the reconcile session waits on B. */
  function reconcileWait(): EventWrite[] {
    return [
      ...approvedThroughCode(),
      moved(T1),
      ev('restack.prepared', transaction('verify-entry', T1)),
      ev('restack.replayed', { id: 'rs-1', conflicted: true }),
      ev('reconcile.started', { attempt: 1, baseSha: T1, restackId: 'rs-1' }),
      session('s_rec', 'reconcile', 1),
      request('wait_1', 'reconcile', 1, 's_rec'),
      ended('s_rec'),
      entered('wait_1', 'esc_w'),
      answer,
    ]
  }

  test('an ended wait whose target moved restacks before the declaring phase', () => {
    const log = [...plannedWait(), moved(T1)]
    expect(decide(log)).toEqual({
      kind: 'restack',
      trigger: 'wait-resume',
      cycle: seqOf(log, answer),
    })
  })

  test('an unchanged target resumes the declaring phase without a restack', () => {
    expect(decide([...plannedWait(), moved(BASE)])).toMatchObject({
      kind: 'run-phase',
      phase: 'plan',
      round: 1,
    })
    // No observation at all also resumes directly.
    expect(decide(plannedWait())).toMatchObject({ kind: 'run-phase', phase: 'plan' })
  })

  test('a fast-forward resumes the phase, promotes the base and ends parking', () => {
    const log = [...plannedWait(), moved(T1)]
    const cycle = seqOf(log, answer)
    const advanced = [
      ...log,
      ev('restack.advanced', {
        trigger: 'wait-resume',
        cycle,
        observation: cycle + 1,
        branch: 'ab/a',
        from: BASE,
        to: T1,
      }),
    ]
    expect(decide(advanced)).toMatchObject({ kind: 'run-phase', phase: 'plan', round: 1 })
    const state = reduce(advanced)
    expect(state.implement.contributionBase).toBe(T1)
    expect(state.wait?.resumedSeq).toBeDefined()
    expect(waitParked(state)).toBe(false)
    const index = logIndexReducer.reduce(toLog(advanced))
    expect(leafRestackedBase(index.restack)).toBe(T1)
    expect(leafBaseInUse(index)).toBe(T1)
  })

  test('a wait-resume transaction runs ahead of the loops: conflict reconciles, clean restacks', () => {
    const base = [
      ...oidPrelude(),
      ev('plan.started', { round: 1 }),
      ev('plan.completed', { round: 1, artifact: { kind: 'plan', rev: 0 } }),
      ev('plan-review.started', { round: 1 }),
      ev('plan-review.verdict', {
        round: 1,
        verdict: 'approve',
        findings: [],
        artifact: { kind: 'plan-review', rev: 0 },
      }),
      ev('implement.started', { round: 1 }),
      session('s_impl', 'implement', 1),
      request('wait_1', 'implement', 1, 's_impl'),
      ended('s_impl'),
      entered('wait_1', 'esc_w'),
      answer,
      moved(T1),
      ev('restack.prepared', { ...transaction('wait-resume', T1), cycle: 9 }),
    ]
    const resumed = reduce(base)
    expect(resumed.wait?.resumedSeq).toBeDefined()
    expect(decide(base)).toEqual({ kind: 'restack', trigger: 'wait-resume', cycle: 9 })
    const conflicted = [...base, ev('restack.replayed', { id: 'rs-1', conflicted: true })]
    expect(decide(conflicted)).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1 },
    })
    const reconciling = [
      ...conflicted,
      ev('reconcile.started', { attempt: 1, baseSha: T1, restackId: 'rs-1' }),
    ]
    expect(logIndexReducer.reduce(toLog(reconciling)).restack.initialVerification).toBe(true)
    const completed = [
      ...base,
      ev('restack.completed', { ...transaction('wait-resume', T1), cycle: 9, headSha: HEAD }),
    ]
    expect(decide(completed)).toMatchObject({ kind: 'run-phase', phase: 'implement', round: 1 })
    expect(reduce(completed).implement.contributionBase).toBe(T1)
  })

  test('a later target move after the build resumed does not restack it mid-phase', () => {
    const log = [...plannedWait(), moved(BASE), session('s_plan2', 'plan', 1), moved(T1)]
    expect(decide(log)).toMatchObject({ kind: 'run-phase', phase: 'plan' })
  })

  test('a revise-spec answer parks for the revision instead of restacking', () => {
    const log = [
      ...plannedWait().slice(0, -1),
      ev('escalation.answered', { id: 'esc_w', answer: 'new spec', resolution: 'revise-spec' }),
      moved(T1),
    ]
    expect(decide(log)).toEqual({ kind: 'wait', reason: 'awaiting-spec' })
  })

  test('a reconcile wait supersedes its frozen occurrence when the target moved', () => {
    const log = [...reconcileWait(), moved(T2)]
    expect(decide(log)).toEqual({
      kind: 'restack',
      trigger: 'wait-resume',
      cycle: seqOf(log, answer),
    })
    const index = logIndexReducer.reduce(toLog(log))
    expect(index.openReconcile).toMatchObject({ attempt: 1, baseSha: T1, intended: false })
    expect(waitResumeSupersedes(reduce(log), index)).toBe(true)
  })

  test('a reconcile wait keeps its attempt when the target is unchanged or intent exists', () => {
    expect(decide(reconcileWait())).toEqual({
      kind: 'run-phase',
      phase: 'reconcile',
      round: 1,
      reconcile: { attempt: 1 },
    })
    const withIntent = [
      ...approvedThroughCode(),
      moved(T1),
      ev('restack.prepared', transaction('verify-entry', T1)),
      ev('restack.replayed', { id: 'rs-1', conflicted: true }),
      ev('reconcile.started', { attempt: 1, baseSha: T1, restackId: 'rs-1' }),
      ev(
        'reconcile.publish-intended',
        {
          ...reconcileTx,
          attempt: 1,
          restackId: 'rs-1',
          headSha: HEAD,
          conflicted: true,
          artifact: { kind: 'reconcile-notes', rev: 0 },
        } as never,
        KERNEL,
      ),
    ]
    const index = logIndexReducer.reduce(toLog(withIntent))
    expect(index.openReconcile?.intended).toBe(true)
  })

  test('superseding closes the occurrence, its automatic restack and its phase', () => {
    const log = [...reconcileWait(), moved(T2)]
    const cycle = seqOf(log, answer)
    const superseded = [
      ...log,
      ev('reconcile.superseded', { attempt: 1, cycle, cause: 'wait-resume', restackId: 'rs-1' }),
    ]
    const index = logIndexReducer.reduce(toLog(superseded))
    expect(index.openReconcile).toBeUndefined()
    expect(index.restack.active).toBeUndefined()
    expect(index.conflictReconcileStarted).toBeUndefined()
    const state = reduce(superseded)
    expect(state.currentPhase).toBeUndefined()
    // The next decision restacks onto T2.
    expect(decide(superseded)).toEqual({ kind: 'restack', trigger: 'wait-resume', cycle })
  })

  test('a wait during a wait-resume conflict supersedes that transaction too', () => {
    const log = [
      ...approvedThroughCode(),
      moved(T1),
      ev('restack.prepared', { ...transaction('wait-resume', T1), cycle: 3 }),
      ev('restack.replayed', { id: 'rs-1', conflicted: true }),
      ev('reconcile.started', { attempt: 1, baseSha: T1, restackId: 'rs-1' }),
      session('s_rec', 'reconcile', 1),
      request('wait_2', 'reconcile', 1, 's_rec'),
      ended('s_rec'),
      entered('wait_2', 'esc_w'),
      answer,
      moved(T2),
    ]
    expect(decide(log)).toEqual({
      kind: 'restack',
      trigger: 'wait-resume',
      cycle: seqOf(log, answer),
    })
  })

  test('implement wait publication: requested, published and lost', () => {
    const publication = { branch: 'ab/a', base: BASE, sha: HEAD }
    const requested = [
      ...oidPrelude(),
      ev(
        'publication.requested',
        { operation: 'wait', id: 'wait_1', ...publication },
        agent('s_impl'),
      ),
      ev(
        'wait.requested',
        {
          id: 'wait_1',
          phase: 'implement',
          round: 1,
          tickets: ['B'],
          reason: 'needs B',
          publication: { ...publication, settlement: 'requested' },
        },
        agent('s_impl'),
      ),
    ]
    const state = reduce(requested)
    expect(state.waitRequest?.publication).toEqual({
      ...publication,
      published: false,
      requestSeq: seqOf(requested, requested.at(-2)!),
    })
    const published = [...requested, ev('wait.published', { id: 'wait_1', sha: HEAD })]
    expect(reduce(published).waitRequest?.publication?.published).toBe(true)
    const lost = [
      ...requested,
      ev('publication.lost', {
        request: seqOf(requested, requested.at(-2)!),
        operation: 'wait',
        reason: 'workspace released',
        branch: publication.branch,
        sha: publication.sha,
      }),
    ]
    expect(reduce(lost).waitRequest?.publication?.lost).toBe(true)
    const local = [
      ...oidPrelude(),
      ev(
        'wait.requested',
        {
          id: 'wait_1',
          phase: 'implement',
          round: 1,
          tickets: ['B'],
          reason: 'needs B',
          publication: { ...publication, settlement: 'published' },
        },
        agent('s_impl'),
      ),
    ]
    expect(reduce(local).waitRequest?.publication?.published).toBe(true)
  })

  test('implement wait publication settled before its declaration is retained', () => {
    const publication = { branch: 'ab/a', base: BASE, sha: HEAD }
    const prelude = [
      ...oidPrelude(),
      ev(
        'publication.requested',
        { operation: 'wait', id: 'wait_1', ...publication },
        agent('s_impl'),
      ),
    ]
    const requestSeq = seqOf(prelude, prelude.at(-1)!)
    const declared = ev(
      'wait.requested',
      {
        id: 'wait_1',
        phase: 'implement',
        round: 1,
        tickets: ['B'],
        reason: 'needs B',
        publication: { ...publication, settlement: 'requested' },
      },
      agent('s_impl'),
    )
    const published = reduce([
      ...prelude,
      ev('wait.published', { id: 'wait_1', sha: HEAD }),
      declared,
    ])
    expect(published.waitRequest?.publication).toEqual({
      ...publication,
      published: true,
      requestSeq,
    })
    const lost = reduce([
      ...prelude,
      ev('publication.lost', {
        request: requestSeq,
        operation: 'wait',
        reason: 'workspace released',
        branch: publication.branch,
        sha: publication.sha,
      }),
      declared,
    ])
    expect(lost.waitRequest?.publication).toEqual({
      ...publication,
      published: false,
      requestSeq,
      lost: true,
    })
    // A settlement for another wait id, or another sha, does not publish this one.
    const foreign = reduce([
      ...prelude,
      ev('wait.published', { id: 'wait_2', sha: HEAD }),
      declared,
    ])
    expect(foreign.waitRequest?.publication?.published).toBe(false)
  })

  test('without a fast-forward the restacked base is the last completion, else the provision', () => {
    const index = logIndexReducer.reduce(toLog(approvedThroughCode()))
    expect(leafRestackedBase(index.restack)).toBe(BASE)
    const completed = [
      ...approvedThroughCode(),
      moved(T1),
      ev('restack.completed', { ...transaction('verify-entry', T1), headSha: HEAD }),
    ]
    expect(leafRestackedBase(logIndexReducer.reduce(toLog(completed)).restack)).toBe(T1)
    // A never-waited build keeps its contribution range on the commits.
    expect(reduce(completed).implement).toMatchObject({ commits: { base: T1, head: HEAD } })
    expect(reduce(completed).implement.contributionBase).toBeUndefined()
  })

  // ── Verify and finalize waits resumed across a moved target (AUT-1208) ──
  const finalizeConfig = parseConfig(`
[tickets]
source = "file"
readyState = "ready"

[commands]
test = "bun test"
notes = "notes"

[verify]
steps = ["unit", "e2e"]

[verify.unit]
kind = "check"
command = "test"

[verify.e2e]
kind = "agent"
skill = "ab-verify-e2e"

[finalize]
steps = ["release-notes", "screenshots"]

[finalize.release-notes]
kind = "check"
command = "notes"

[finalize.screenshots]
kind = "agent"
skill = "custom-screenshot-skill"
`)
  const RESTACKED = '5'.repeat(40)
  const verified = (): EventWrite[] => [
    ...approvedThroughCode(),
    ev('verify.started', { step: 'unit', attempt: 1 }),
    ev('verify.completed', { step: 'unit', attempt: 1, pass: true }),
    ev('verify.started', { step: 'e2e', attempt: 1 }),
    ev('verify.completed', { step: 'e2e', attempt: 1, pass: true }),
  ]
  const finalized = ev('finalize.completed', {
    pr: { number: 7, url: 'https://forge/pr/7', headSha: HEAD },
  })
  /** The declaring session's wait, entered and answered. */
  const waitFrom = (phase: Phase, round: number, sessionId: string): EventWrite[] => [
    session(sessionId, phase, round),
    request('wait_1', phase, round, sessionId),
    ended(sessionId),
    entered('wait_1', 'esc_w'),
    answer,
  ]
  /** Each wait fixture verifies, so toLog inserts the entry restack before
   * the first verify start: the answer's seq is its index + 2. */
  const answerSeq = (writes: EventWrite[]) => writes.indexOf(answer) + 2
  const cleanResume = (writes: EventWrite[]): EventWrite[] => {
    const cycle = answerSeq(writes)
    const tx = { ...transaction('wait-resume', T1), cycle }
    return [
      ...writes,
      moved(T1),
      ev('restack.prepared', tx),
      ev('restack.replayed', { id: 'rs-1', conflicted: false }),
      ev('restack.publish-intended', { ...tx, headSha: RESTACKED }),
      ev('restack.completed', { ...tx, headSha: RESTACKED }),
    ]
  }
  const conflictedResume = (writes: EventWrite[]): EventWrite[] => {
    const tx = { ...transaction('wait-resume', T1), cycle: answerSeq(writes) }
    const prefix = [
      ...writes,
      moved(T1),
      ev('restack.prepared', tx),
      ev('restack.replayed', { id: 'rs-1', conflicted: true }),
      ev('reconcile.started', { attempt: 1, baseSha: T1, restackId: 'rs-1' }),
      ev('reconcile.completed', {
        headSha: RESTACKED,
        rewriteId: 'rs-1',
        artifact: { kind: 'reconcile-notes', rev: 0 },
      }),
    ]
    // The reconcile-linked completion carries the reconcile completion's seq.
    return [
      ...prefix,
      ev('restack.completed', { ...tx, cycle: prefix.length + 1, headSha: RESTACKED }),
    ]
  }
  const verifyWait = (): EventWrite[] => [
    ...approvedThroughCode(),
    ev('verify.started', { step: 'unit', attempt: 1 }),
    ev('verify.completed', { step: 'unit', attempt: 1, pass: true }),
    ev('verify.started', { step: 'e2e', attempt: 1 }),
    ...waitFrom('verify:e2e', 1, 's_e2e'),
  ]
  const finalizeWait = (): EventWrite[] => [...verified(), ...waitFrom('finalize', 1, 's_fin')]
  const postStepWait = (): EventWrite[] => [
    ...verified(),
    finalized,
    ev('finalize.step-completed', { step: 'release-notes', ok: true }),
    ...waitFrom('finalize', 1, 's_shots'),
  ]
  const guidance = { guidance: { escalation: 'esc_w', answer: 'B landed' } }

  const runUnit = (attempt: number) => ({
    kind: 'run-check' as const,
    step: 'unit',
    command: 'bun test',
    attempt,
  })
  const passed = (step: string, attempt: number): EventWrite[] => [
    ev('verify.started', { step, attempt }),
    ev('verify.completed', { step, attempt, outcome: 'pass' }),
  ]
  /** The clean completion's seq: the last event of a resumed fixture. */
  const completionSeq = (writes: EventWrite[]) => toLog(writes).at(-1)!.seq

  test('a clean resume of a verify wait re-verifies from the first step on the restacked base', () => {
    const log = cleanResume(verifyWait())
    const boundary = completionSeq(log)
    expect(decide(log)).toEqual(runUnit(2))
    const index = logIndexReducer.reduce(toLog(log))
    expect(index.waitResumeVerifyBoundary).toBe(boundary)
    // Verify facts cite the resume's restack, not the entry restack.
    expect(leafVerifiedRestack(index)).toMatchObject({ id: 'rs-1', targetBase: T1 })
    // The reducer's cycle agrees, so a landing decision recorded before the
    // resume no longer satisfies `landingReady`.
    expect(reduce(log).verify.cycleSince).toBe(boundary)
    // The declaring verifier re-runs at the new attempt and still gets the answer.
    expect(decide([...log, ...passed('unit', 2)])).toEqual({
      kind: 'run-agent-verify',
      step: 'e2e',
      skill: 'ab-verify-e2e',
      attempt: 2,
      feedback: guidance,
    })
    expect(decide([...log, ...passed('unit', 2), ...passed('e2e', 2)])).toEqual({
      kind: 'run-phase',
      phase: 'finalize',
      round: 1,
    })
  })

  test('a clean resume of a finalize wait re-verifies before finalizing', () => {
    const log = cleanResume(finalizeWait())
    expect(decide(log)).toEqual(runUnit(2))
    expect(reduce(log).verify.cycleSince).toBe(completionSeq(log))
    expect(decide([...log, ...passed('unit', 2)])).toMatchObject({
      kind: 'run-agent-verify',
      step: 'e2e',
      attempt: 2,
    })
    expect(decide([...log, ...passed('unit', 2), ...passed('e2e', 2)])).toEqual({
      kind: 'run-phase',
      phase: 'finalize',
      round: 1,
    })
    // A post-step wait re-verifies, then continues the remaining post-steps
    // without finalizing again.
    const post = cleanResume(postStepWait())
    expect(decideNext(toLog(post), finalizeConfig)).toEqual(runUnit(2))
    expect(
      decideNext(toLog([...post, ...passed('unit', 2), ...passed('e2e', 2)]), finalizeConfig),
    ).toEqual({
      kind: 'run-finalize-step',
      step: 'screenshots',
      action: { kind: 'agent', skill: 'custom-screenshot-skill' },
    })
  })

  test('a failure in the resumed cycle routes to implement and never finalizes', () => {
    const report = { kind: 'verify-report:unit', rev: 1 }
    for (const waited of [verifyWait(), finalizeWait()]) {
      const failed = [
        ...cleanResume(waited),
        ev('verify.started', { step: 'unit', attempt: 2 }),
        ev('verify.completed', { step: 'unit', attempt: 2, outcome: 'fail', report }),
      ]
      expect(decide(failed)).toMatchObject({ kind: 'run-phase', phase: 'implement', round: 2 })
    }
    const failed = [
      ...cleanResume(finalizeWait()),
      ev('verify.started', { step: 'unit', attempt: 2 }),
      ev('verify.completed', { step: 'unit', attempt: 2, outcome: 'fail', report }),
    ]
    expect(decide(failed)).toEqual({
      kind: 'run-phase',
      phase: 'implement',
      round: 2,
      feedback: { verify: { step: 'unit', report } },
    })
  })

  test('an interrupted resumed cycle re-decides the same step and attempt', () => {
    const log = cleanResume(verifyWait())
    const boundary = completionSeq(log)
    const index = logIndexReducer.reduce(toLog(log))
    // The completion satisfies its own gate: no second restack.
    expect(index.restack.gates[String(answerSeq(log))]).toBeDefined()
    expect(index.restack.active).toBeUndefined()
    expect(decide(log)).toEqual(runUnit(2))
    const captured = [
      ...log,
      ev('verify.config-captured', {
        cycle: boundary + 1,
        artifact: { kind: 'verify-cycle-config', rev: 1 },
        head: RESTACKED,
        identity: 'config-1',
        source: { ref: 'branch-head', commit: RESTACKED },
      }),
    ]
    expect(decide(captured)).toEqual(runUnit(2))
    const crashed = [...captured, ev('verify.started', { step: 'unit', attempt: 2 })]
    expect(decide(crashed)).toEqual(runUnit(2))
  })

  test('a conflicted resume of a verify wait reconciles, then re-verifies in full', () => {
    const log = conflictedResume(verifyWait())
    expect(decide(log)).toEqual(runUnit(2))
    const events = toLog(log)
    expect(events.filter((e) => e.type === 'reconcile.completed')).toHaveLength(1)
    expect(
      events.filter((e) => e.type === 'restack.completed' && e.payload.trigger === 'wait-resume'),
    ).toHaveLength(1)
    const index = logIndexReducer.reduce(events)
    // The reconcile completion is the boundary; the restack adds none.
    expect(index.waitResumeVerifyBoundary).toBe(0)
    expect(reduce(log).verify.cycleSince).toBe(index.lastReconcileCompletedSeq)
    expect(leafVerifiedRestack(index)).toMatchObject({ id: 'rs-1', targetBase: T1 })
  })

  test('an implement wait after a verify failure keeps the failure across a clean resume', () => {
    const report = { kind: 'verify-report:unit', rev: 1 }
    const waited = [
      ...approvedThroughCode(),
      ev('verify.started', { step: 'unit', attempt: 1 }),
      ev('verify.completed', { step: 'unit', attempt: 1, outcome: 'fail', report }),
      ev('implement.started', { round: 2, feedback: { verify: { step: 'unit', report } } }),
      ...waitFrom('implement', 2, 's_impl'),
    ]
    const log = cleanResume(waited)
    const events = toLog(log)
    const failSeq = events.find((e) => e.type === 'verify.completed')!.seq
    const index = logIndexReducer.reduce(events)
    expect(index.waitResumeVerifyBoundary).toBe(0)
    expect(leafVerifiedRestack(index)?.trigger).toBe('verify-entry')
    expect(reduce(log).verify.cycleSince).toBeLessThan(failSeq)
    expect(decide(log)).toMatchObject({ kind: 'run-phase', phase: 'implement', round: 2 })
  })

  test('a verify wait whose target did not move resumes the same step and attempt', () => {
    expect(decide([...verifyWait(), moved('c'.repeat(40))])).toEqual({
      kind: 'run-agent-verify',
      step: 'e2e',
      skill: 'ab-verify-e2e',
      attempt: 1,
      feedback: guidance,
    })
  })
})
