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

  describe('concurrent verifiers', () => {
    const verifier = (step: string, session: string) => {
      const out = makeDeps({ store, env: makeEnv({ phase: `verify:${step}`, round: 1, session }) })
      out.ids = (prefix) => `${prefix}_${step}`
      return out
    }
    const waits = async () =>
      (await store.getEvents(BUILD)).filter((event) => event.type === 'wait.requested')

    test('a second session cannot replace an undecided wait', async () => {
      await waitOn(verifier('a', 's_a'), { tickets: ['ENG-7'], reason: 'needs ENG-7' })
      await expect(
        waitOn(verifier('b', 's_b'), { tickets: ['ENG-8'], reason: 'needs ENG-8' }),
      ).rejects.toThrow(/session "s_a" already declared wait "wait_a" on ENG-7/)
      expect((await waits()).map((event) => event.payload.id)).toEqual(['wait_a'])
      // The other session keeps its ordinary terminals.
      await escalate(verifier('b', 's_b'), { question: 'also needs ENG-8' })
    })

    test('the declaration that loses the append race is refused, not lost', async () => {
      const b = verifier('b', 's_b')
      const append = store.appendWithArtifactsIfCurrent.bind(store)
      let raced = false
      b.store = Object.assign(Object.create(store), {
        appendWithArtifactsIfCurrent: async (...args: Parameters<typeof append>) => {
          if (!raced) {
            raced = true
            await waitOn(verifier('a', 's_a'), { tickets: ['ENG-7'], reason: 'needs ENG-7' })
          }
          return append(...args)
        },
      })
      await expect(waitOn(b, { tickets: ['ENG-8'], reason: 'needs ENG-8' })).rejects.toThrow(
        /already declared wait "wait_a"/,
      )
      expect(raced).toBe(true)
      expect((await waits()).map((event) => event.payload.id)).toEqual(['wait_a'])
    })

    test('a refused, ended or answered wait frees the declaration', async () => {
      const ends = [
        (id: string) => ({
          type: 'wait.refused' as const,
          payload: {
            id,
            cause: 'unknown-ticket' as const,
            tickets: ['ENG-7'],
            message: 'no such ticket',
          },
        }),
        (id: string) => ({
          type: 'wait.ended' as const,
          payload: { id, cause: 'operator' as const, message: 'ended' },
        }),
      ]
      for (const [index, end] of ends.entries()) {
        const step = `s${index}`
        await waitOn(verifier(step, `s_${step}`), { tickets: ['ENG-7'], reason: 'r' })
        await store.append(BUILD, { actor: DISPATCHER, ...end(`wait_${step}`) })
      }
      await waitOn(verifier('c', 's_c'), { tickets: ['ENG-7'], reason: 'r' })
      await store.append(BUILD, {
        actor: DISPATCHER,
        type: 'wait.entered',
        payload: {
          id: 'wait_c',
          escalation: 'esc_wait',
          tickets: [{ source: 'linear', id: 'ENG-7' }],
          reason: 'r',
          question: 'waiting on ENG-7',
        },
      })
      await expect(
        waitOn(verifier('d', 's_d'), { tickets: ['ENG-8'], reason: 'r' }),
      ).rejects.toThrow(/already declared wait "wait_c"/)
      await store.append(BUILD, {
        actor: { kind: 'human' as const, user: 'operator' },
        type: 'escalation.answered',
        payload: { id: 'esc_wait', answer: 'go on', resolution: 'retry' },
      })
      await waitOn(verifier('d', 's_d'), { tickets: ['ENG-8'], reason: 'r' })
      expect((await waits()).map((event) => event.payload.id)).toEqual([
        'wait_s0',
        'wait_s1',
        'wait_c',
        'wait_d',
      ])
    })
  })
})
