import { checkIncremental } from '../kernel/incremental-contract'
import { expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import { sequentialIds } from '../ids'
import { escalationResolutionSchema } from '../ontology'
import { MemoryBuildStore } from '../store/memory'
import {
  dispatchFailureBudget,
  dispatchFailureBudgetReducer,
  ensureDispatchBudget,
} from './dispatch-failure-budget'

const event = (seq: number, type: string, payload: unknown): AbEvent =>
  ({
    build: 'budget',
    seq,
    ts: '2026-01-01T00:00:00Z',
    actor: DISPATCHER,
    type,
    payload,
  }) as AbEvent
const failure = (seq: number, stage = 'comment') =>
  event(seq, 'dispatch.failed', { stage, error: 'offline', attempt: 99 })
const raise = (seq: number) =>
  event(seq, 'escalation.raised', {
    id: 'esc',
    source: 'policy',
    phase: 'setup',
    policyCause: 'dispatch-failure-limit',
    question: 'retry?',
  })

test('mixed stages share a budget, infrastructure ownership is explicit, attachment clears it', () => {
  const events = [
    failure(1, 'workspace'),
    failure(2, 'spec'),
    event(3, 'dispatch.comment-posted', {}),
    failure(4, 'launch'),
  ]
  expect(dispatchFailureBudget(events, false).count).toBe(3)
  expect(dispatchFailureBudget(events, true).count).toBe(2)
  expect(dispatchFailureBudget([...events, event(5, 'runner.attached', {})], false).count).toBe(0)
})

for (const resolution of escalationResolutionSchema.options) {
  test(`${resolution} answers consume only an open matching identity`, () => {
    const answer = event(3, 'escalation.answered', { id: 'esc', resolution })
    const events = [failure(1), raise(2), answer]
    expect(dispatchFailureBudget(events, false)).toMatchObject({
      count: resolution === 'abort' ? 1 : 0,
      parked: resolution === 'abort',
    })
    expect(dispatchFailureBudget([...events, failure(4), answer], false).count).toBe(
      resolution === 'abort' ? 2 : 1,
    )
    expect(dispatchFailureBudget([failure(1), answer], false).count).toBe(1)
  })
}

for (const limit of [1, 3]) {
  test(`repair and concurrent conditional appends raise once at limit ${limit}`, async () => {
    const store = new MemoryBuildStore()
    await store.createBuild({ slug: 'budget', repo: 'repo' })
    for (let i = 0; i < limit; i++)
      await store.append('budget', {
        actor: DISPATCHER,
        type: 'dispatch.failed',
        payload: { stage: 'comment', attempt: i + 1, error: 'offline' },
      })
    const ids = sequentialIds()
    expect(
      await Promise.all(
        [1, 2, 3].map(() => ensureDispatchBudget(store, ids, 'budget', limit, false)),
      ),
    ).toEqual([false, false, false])
    const events = await store.getEvents('budget')
    expect(events.filter((e) => e.type === 'escalation.raised')).toHaveLength(1)
    expect(events.at(-1)?.payload).toMatchObject({
      policyCause: 'dispatch-failure-limit',
      question: `maxDispatchAttempts (${limit}) exhausted during comment: offline`,
    })
  })
}

test('other policy answers do not reset dispatch failures', () => {
  for (const policyCause of [
    'setup-failure-limit',
    'infrastructure-failure-limit',
    'phase-attempt-limit',
  ]) {
    const events = [
      failure(1),
      event(2, 'escalation.raised', { id: 'other', source: 'policy', policyCause }),
      event(3, 'escalation.answered', { id: 'other', resolution: 'retry' }),
    ]
    expect(dispatchFailureBudget(events, false).count).toBe(1)
  }
})

test('dispatch budget obeys prefix and partition equivalence for both ownership modes', () => {
  const events = [
    failure(1, 'workspace'),
    failure(2),
    raise(3),
    event(4, 'escalation.answered', { id: 'esc', resolution: 'guidance' }),
    failure(5, 'launch'),
    event(6, 'runner.attached', {}),
    failure(7),
  ]
  for (const owned of [false, true]) checkIncremental(dispatchFailureBudgetReducer(owned), events)
})
