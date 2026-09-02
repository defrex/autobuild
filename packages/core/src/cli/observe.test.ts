/**
 * `ab observe` tests (SPEC §8.2, §12): structured observations at the point
 * of capture — NOT a terminal, so any phase, any time, any number of times.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sequentialIds } from '../ids'
import type { MemoryBuildStore } from '../store/memory'
import { observe } from './observe'
import { BUILD, makeEnv, seedStore } from './testkit'

let store: MemoryBuildStore

beforeEach(async () => {
  store = await seedStore()
})

afterEach(async () => {
  await store.close()
})

describe('observe', () => {
  test('round-trips a structured observation with a stamped id', async () => {
    const deps = { store, env: makeEnv({ phase: 'implement', round: 1 }), ids: sequentialIds() }
    const event = await observe(deps, {
      kind: 'refactor',
      summary: 'rate limiter should be middleware',
      files: ['src/auth.ts'],
      refs: ['ENG-7'],
    })
    expect(event.type).toBe('observation.recorded')
    expect(event.payload).toEqual({
      id: 'obs_1',
      kind: 'refactor',
      summary: 'rate limiter should be middleware',
      files: ['src/auth.ts'],
      refs: ['ENG-7'],
    })
    expect(event.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_test' })
  })

  test('not a terminal: usable repeatedly, even after the phase terminal exists', async () => {
    const deps = { store, env: makeEnv({ phase: 'plan', round: 1 }), ids: sequentialIds() }
    await observe(deps, { kind: 'followup', summary: 'first' })
    await observe(deps, { kind: 'latent-bug', summary: 'second' })
    // A recorded terminal does not block observations (§8.2 — terminal? no).
    await store.putArtifact(BUILD, { kind: 'plan', content: 'plan\n' })
    await store.append(BUILD, {
      actor: { kind: 'agent', role: 'plan', session: 's_test' },
      type: 'plan.completed',
      payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
    })
    const third = await observe(deps, { kind: 'refactor', summary: 'third' })
    expect(third.payload.id).toBe('obs_3')
    const observations = (await store.getEvents(BUILD)).filter(
      (event) => event.type === 'observation.recorded',
    )
    expect(observations).toHaveLength(3)
  })

  test('an unknown kind is rejected naming the vocabulary', async () => {
    const deps = { store, env: makeEnv(), ids: sequentialIds() }
    await expect(observe(deps, { kind: 'idea', summary: 'nope' })).rejects.toThrow(
      /--kind "idea" is not an observation kind.*followup \| refactor \| latent-bug/s,
    )
  })

  test('an empty summary is rejected', async () => {
    const deps = { store, env: makeEnv(), ids: sequentialIds() }
    await expect(observe(deps, { kind: 'followup', summary: '  ' })).rejects.toThrow(
      /non-empty <summary>/,
    )
  })
})
