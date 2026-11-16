/**
 * `ab wait-on` (SPEC §11 "Ticket waits"): every local refusal writes nothing,
 * and a declaration appends exactly one `wait.requested` that ends the
 * session's terminal allowance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { MemoryBuildStore } from '../store/memory'
import { escalate, waitOn } from './terminals'
import { BUILD, makeDeps, makeEnv, seedStore } from './testkit'

let store: MemoryBuildStore

beforeEach(async () => {
  store = await seedStore()
})

afterEach(async () => {
  await store.close()
})

const deps = () => makeDeps({ store, env: makeEnv({ phase: 'implement', round: 2 }) })
const eventCount = async () => (await store.getEvents(BUILD)).length

describe('ab wait-on', () => {
  test('local refusals append nothing', async () => {
    const before = await eventCount()
    const cases: [string[], string, RegExp][] = [
      [[], 'reason', /one or more nonblank ticket ids/],
      [['ENG-7', ' '], 'reason', /nonblank ticket ids/],
      [['ENG-7', ' ENG-7'], 'reason', /more than once/],
      [Array.from({ length: 21 }, (_, i) => `ENG-${i + 100}`), 'reason', /at most 20/],
      [['ENG-7'], '   ', /requires --reason/],
      [['ENG-42'], 'reason', /this build's own ticket/],
    ]
    for (const [tickets, reason, message] of cases)
      await expect(waitOn(deps(), { tickets, reason })).rejects.toThrow(message)
    expect(await eventCount()).toBe(before)
  })

  test('a node build cannot declare a wait', async () => {
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        kind: 'node',
        ticket: { source: 'linear', id: 'ENG-42' },
        repo: 'acme/app',
        baseBranch: 'main',
      },
    })
    const before = await eventCount()
    await expect(waitOn(deps(), { tickets: ['ENG-7'], reason: 'r' })).rejects.toThrow(
      /a node build cannot declare a ticket wait/,
    )
    expect(await eventCount()).toBe(before)
  })

  test('a declaration appends one wait.requested and is the session terminal', async () => {
    const event = await waitOn(deps(), {
      tickets: [' ENG-7', 'ENG-8'],
      reason: ' needs the ENG-7 schema ',
    })
    expect(event.type).toBe('wait.requested')
    expect(event.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_test' })
    expect(event.payload).toEqual({
      id: 'wait_1',
      phase: 'implement',
      round: 2,
      tickets: ['ENG-7', 'ENG-8'],
      reason: 'needs the ENG-7 schema',
    })
    const after = await eventCount()
    await expect(waitOn(deps(), { tickets: ['ENG-9'], reason: 'again' })).rejects.toThrow(
      /already declared a wait/,
    )
    await expect(escalate(deps(), { question: 'and a question' })).rejects.toThrow(
      /already declared a wait/,
    )
    expect(await eventCount()).toBe(after)
  })

  test('a session that already escalated cannot declare a wait', async () => {
    await escalate(deps(), { question: 'which API?' })
    await expect(waitOn(deps(), { tickets: ['ENG-7'], reason: 'r' })).rejects.toThrow(
      /already escalated/,
    )
  })
})
