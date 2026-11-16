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
import { buildReducer, reduceBuild as reduceBuildWhole, type BuildState } from './reducer'
import { terminalGuardReducer } from './terminal-guard'
import {
  openTicketWait,
  pendingWaitRequest,
  ticketWaitStatus,
  waitBlock,
  waitParked,
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
  const open = () => reduce([...planWait(), entered('wait_1', 'esc_w')])
  const answered = () =>
    reduce([
      ...planWait(),
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
    })
  })

  test('a live lease, an open execution or a co-open question keeps the slot', () => {
    expect(occupiesCapacity(capacityBuild('a', open(), true), now)).toBe(true)
    const executing = open()
    executing.openExecution = {
      provider: 'vercel-sandbox',
      workspaceRef: 'ws',
      instance: 'i',
      commandId: 'cmd',
      seq: 1,
    } as BuildState['openExecution'] & object
    expect(occupiesCapacity(capacityBuild('a', executing), now)).toBe(true)
    const questioned = reduce([
      ...planWait(),
      entered('wait_1', 'esc_w'),
      ev(
        'escalation.raised',
        { id: 'esc_q', phase: 'plan', round: 1, source: 'agent', question: 'which API?' },
        agent('s_other'),
      ),
    ])
    expect(occupiesCapacity(capacityBuild('a', questioned), now)).toBe(true)
  })

  test('pending and refused requests keep the slot', () => {
    expect(occupiesCapacity(capacityBuild('a', reduce(planWait())), now)).toBe(true)
    const refused = reduce([
      ...planWait(),
      ev('wait.refused', { id: 'wait_1', cause: 'completed', tickets: ['B'], message: 'done' }),
    ])
    expect(occupiesCapacity(capacityBuild('a', refused), now)).toBe(true)
  })

  test('an ended wait requests a resume slot ahead of new claims', () => {
    const resuming = capacityBuild('a', answered())
    expect(occupiesCapacity(resuming, now)).toBe(false)
    expect(slotRequest(resuming, now)).toBe('resume')
    const capacity = dispatchCapacity([resuming], 1, now)
    expect(capacity.waitingBuilds).toEqual([{ slug: 'a', request: 'resume' }])
    expect(intakeCapacity(capacity)).toBe(0)
  })

  test('a paused or revise-spec wait requests no slot', () => {
    const paused = answered()
    paused.status = 'paused'
    expect(slotRequest(capacityBuild('a', paused), now)).toBeUndefined()
    const revise = reduce([
      ...planWait(),
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
