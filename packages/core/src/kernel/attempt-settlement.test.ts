import { describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { readBuildFacts } from '../store/reduced-reads'
import { settleAttempt } from './attempt-settlement'
import { commandObjective, OPTIMIZATION_SHA } from './generators/optimization-log'

const ticket = { source: 'file', id: 'T-a' }
const measurement = { revision: 1, baseline: 50, candidate: 50, delta: 0 }

async function node() {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: 'opt-node', repo: 'repo', branch: 'ab-node/opt' })
  await store.append('opt-node', {
    actor: DISPATCHER,
    type: 'optimization.objective-accepted',
    payload: {
      objective: commandObjective(),
      revision: 1,
      harnessPin: OPTIMIZATION_SHA('a'),
      specRev: 0,
    },
  })
  await store.append('opt-node', {
    actor: DISPATCHER,
    type: 'optimization.attempts-proposed',
    payload: {
      request: 'r',
      proposals: [{ id: 'a', ticket, title: 'Attempt a', strategy: 'strategy a' }],
    },
  })
  return store
}

const settled = async (store: MemoryBuildStore) =>
  (await store.getEvents('opt-node')).filter((event) => event.type === 'attempt.settled')

describe('settleAttempt', () => {
  test('settles an in-flight attempt exactly once', async () => {
    const store = await node()
    const attempt = { proposal: 'a', ticket, build: 'attempt-a' }
    expect(await settleAttempt(store, 'opt-node', attempt, 'no-improvement', measurement)).toBe(
      true,
    )
    // A retry, and a different terminal path racing it, write nothing.
    expect(await settleAttempt(store, 'opt-node', attempt, 'no-improvement', measurement)).toBe(
      false,
    )
    expect(await settleAttempt(store, 'opt-node', attempt, 'aborted')).toBe(false)
    expect(await settled(store)).toHaveLength(1)
    const state = (await readBuildFacts(store, 'opt-node')).value.state.optimization!
    expect(state.inFlight).toEqual([])
    expect(state.rejections).toEqual([
      { proposal: 'a', ticket, build: 'attempt-a', outcome: 'no-improvement' },
    ])
  })

  test('a concurrent append on the node log is re-read, not overwritten', async () => {
    const store = await node()
    const appendIfCurrent = store.appendIfCurrent.bind(store)
    let raced = false
    store.appendIfCurrent = (async (slug: string, expected: number, event: never) => {
      if (!raced) {
        raced = true
        await store.append('opt-node', {
          actor: DISPATCHER,
          type: 'node.poll-checked',
          payload: {
            activityKey: 'k',
            unchangedSince: '2026-11-17T00:00:00.000Z',
            nodeIdleAfterSeconds: 60,
            nodeIdlePollSeconds: 60,
          },
        })
      }
      return appendIfCurrent(slug, expected, event)
    }) as typeof store.appendIfCurrent
    expect(
      await settleAttempt(store, 'opt-node', { proposal: 'a', ticket }, 'accepted', {
        ...measurement,
        candidate: 40,
        delta: 10,
      }),
    ).toBe(true)
    expect(await settled(store)).toHaveLength(1)
    expect((await settled(store))[0]!.payload).toMatchObject({ outcome: 'accepted' })
  })

  test('an unknown proposal never settles', async () => {
    const store = await node()
    expect(await settleAttempt(store, 'opt-node', { proposal: 'z', ticket }, 'aborted')).toBe(false)
    expect(await settled(store)).toEqual([])
  })
})
