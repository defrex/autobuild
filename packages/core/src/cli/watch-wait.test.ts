/** Ticket waits in the watch stream: routine lines, never default attention,
 * and a wait-only build is not build attention (SPEC §11 "Ticket waits"). */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, humanActor } from '../events/envelope'
import { currentDeferralObservationReducer } from '../kernel/auto-merge'
import { reduceBuild } from '../kernel/reducer'
import { buildNeedsAttention } from './attention'
import { matchEvent, matchState, parseConditions } from './wait'
import { BUILD_ATTENTION_EVENTS, projectRecord, summarizeEvent, watchRecordId } from './watch'

function event(seq: number, type: string, payload: unknown, actor: unknown = DISPATCHER): AbEvent {
  return {
    build: 'waits',
    seq,
    ts: `2026-11-16T00:00:0${seq}.000Z`,
    actor,
    type,
    payload,
  } as AbEvent
}

const created = event(1, 'build.created', {
  ticket: { source: 'file', id: 'A' },
  repo: '/repo',
  baseBranch: 'main',
})
const requested = event(
  2,
  'wait.requested',
  { id: 'wait_1', phase: 'implement', round: 1, tickets: ['B', 'C'], reason: 'needs B' },
  { kind: 'agent', role: 'implement', session: 's_impl' },
)
const entered = event(3, 'wait.entered', {
  id: 'wait_1',
  escalation: 'esc_w',
  tickets: [
    { source: 'file', id: 'B' },
    { source: 'file', id: 'C' },
  ],
  reason: 'needs B',
  question: 'Waiting on B, C to complete: needs B.',
})

function after(...log: AbEvent[]) {
  return reduceBuild(log)
}

test('no wait event is default attention', () => {
  expect(BUILD_ATTENTION_EVENTS.some((type) => type.startsWith('wait.'))).toBe(false)
})

test('requested, refused and entered waits read as plain lines', () => {
  expect(summarizeEvent(requested, after(created, requested))).toBe(
    'wait requested on B, C: needs B',
  )
  const refused = event(3, 'wait.refused', {
    id: 'wait_1',
    cause: 'unknown-ticket',
    tickets: ['C'],
    message: 'C does not exist',
  })
  expect(summarizeEvent(refused, after(created, requested, refused))).toBe(
    'wait on C refused (unknown-ticket): C does not exist',
  )
  const state = after(created, requested, entered)
  expect(summarizeEvent(entered, state)).toBe('waiting on B, C — needs B')
  expect(projectRecord(entered, state, 'c').state?.wait).toMatchObject({
    state: 'waiting',
    tickets: ['B', 'C'],
  })
})

test('leaving a wait names its tickets, by wait.ended or by the answer that ended it', () => {
  const ended = event(4, 'wait.ended', {
    id: 'wait_1',
    cause: 'automatic',
    message: 'B and C done',
  })
  expect(summarizeEvent(ended, after(created, requested, entered, ended))).toBe(
    'wait on B, C ended (automatic): B and C done',
  )
  const answered = event(
    4,
    'escalation.answered',
    { id: 'esc_w', answer: 'go ahead', resolution: 'guidance' },
    humanActor('aron'),
  )
  const state = after(created, requested, entered, answered)
  expect(summarizeEvent(answered, state)).toBe('wait on B, C ended (operator): go ahead')
  expect(projectRecord(answered, state, 'c').state?.wait).toMatchObject({ state: 'ended' })
})

test('an answer to another escalation keeps its ordinary summary', () => {
  const raised = event(4, 'escalation.raised', {
    id: 'esc_other',
    phase: 'implement',
    round: 1,
    source: 'policy',
    policyCause: 'execution-no-progress',
    question: 'other',
  })
  const answered = event(
    5,
    'escalation.answered',
    { id: 'esc_other', answer: 'retry it', resolution: 'retry' },
    humanActor('aron'),
  )
  const line = summarizeEvent(answered, after(created, requested, entered, raised, answered))
  expect(line).not.toContain('wait')
  expect(line).toContain('retry it')
})

test('watch record ids derive only from durable identities', () => {
  expect(watchRecordId({ event: event(4, 'escalation.raised', { id: 'e' }) })).toBe('build:waits:4')
  expect(
    watchRecordId({
      event: {
        repo: 'r',
        seq: 9,
        ts: '2026-01-01T00:00:00.000Z',
        actor: DISPATCHER,
        type: 'dispatcher.tick-failed',
        payload: { run: 'r1', error: 'x' },
      } as never,
    }),
  ).toBe('repo:9')
  expect(watchRecordId({ observation: 'build.consent-ready', identity: '["consent","b",3]' })).toBe(
    'build.consent-ready:["consent","b",3]',
  )
  expect(
    watchRecordId({ observation: 'dispatcher.tick-failure-persistent', identity: 'tick:7' }),
  ).toBe('dispatcher.tick-failure-persistent:tick:7')
  expect(watchRecordId({ lost: 'run-1' })).toBe('dispatcher.lost:run-1')
})

const forAttention = parseConditions(['attention'], []).conditions

/** `ab wait --for attention` at registration and on `last`, plus the
 * canonical build-attention predicate, over one log. */
function attention(log: AbEvent[], last = log[log.length - 1]!) {
  const state = reduceBuild(log)
  const facts = { state, deferral: currentDeferralObservationReducer.reduce(log) }
  return {
    state,
    onStart: matchState(forAttention, state, facts),
    onEvent: matchEvent(last, forAttention, [], facts),
    needs: buildNeedsAttention(log, state),
  }
}

test('a wait-only build is not attention, on registration or on later events', () => {
  const parked = attention([created, requested, entered])
  expect(parked).toMatchObject({ onStart: null, onEvent: null, needs: false })
  const observed = event(4, 'observation.recorded', {
    id: 'obs_1',
    kind: 'followup',
    summary: 'later',
  })
  expect(attention([created, requested, entered, observed])).toMatchObject({
    onStart: null,
    onEvent: null,
    needs: false,
  })
  // The wait-only build stays `blocked` in the status model.
  expect(matchState(parseConditions(['blocked'], []).conditions, parked.state)).toBe('blocked')
})

test('an unrelated escalation beside an open wait is attention', () => {
  const raised = event(
    4,
    'escalation.raised',
    { id: 'esc_other', phase: 'implement', round: 1, source: 'agent', question: 'other?' },
    { kind: 'agent', role: 'implement', session: 's_impl' },
  )
  const result = attention([created, requested, entered, raised])
  expect(result.state.wait?.ended).toBeUndefined()
  expect(result).toMatchObject({ onStart: 'attention', onEvent: 'attention', needs: true })
})

test('a janitor escalation beside an open wait is attention', () => {
  const janitor = event(4, 'build.janitor-escalated', {
    id: 'esc_janitor',
    operation: 'cleanup',
    message: 'stuck',
    attempt: 3,
    firstFailureAt: '2026-11-16T00:00:00.000Z',
    question: 'cleanup is stuck',
  })
  expect(attention([created, requested, entered, janitor])).toMatchObject({
    onStart: 'attention',
    onEvent: 'attention',
    needs: true,
  })
})

test('an unresolvable blocker ends the wait and is attention', () => {
  const unresolvable = event(4, 'escalation.raised', {
    id: 'esc_unresolvable',
    phase: 'implement',
    round: 1,
    source: 'policy',
    policyCause: 'wait-unresolvable',
    question: 'B was rejected.',
  })
  const result = attention([created, requested, entered, unresolvable])
  expect(result.state.wait?.ended).toBeDefined()
  expect(result).toMatchObject({ onStart: 'attention', onEvent: 'attention', needs: true })
})

test('leaving a wait, automatically or by an answer, is not attention', () => {
  const ended = event(4, 'wait.ended', { id: 'wait_1', cause: 'automatic', message: 'done' })
  expect(attention([created, requested, entered, ended])).toMatchObject({
    onStart: null,
    onEvent: null,
    needs: false,
  })
  const answered = event(
    4,
    'escalation.answered',
    { id: 'esc_w', answer: 'go ahead', resolution: 'guidance' },
    humanActor('aron'),
  )
  expect(attention([created, requested, entered, answered])).toMatchObject({
    onStart: null,
    onEvent: null,
    needs: false,
  })
})
