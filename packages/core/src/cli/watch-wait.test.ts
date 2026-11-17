/** Ticket waits in the watch stream: routine lines, never default attention
 * (SPEC §11 "Ticket waits"). */
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import { BUILD_ATTENTION_EVENTS, projectRecord, summarizeEvent } from './watch'

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
