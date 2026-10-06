import { describe, expect, test } from 'bun:test'
import { defineReducer } from '../kernel/incremental'
import { createBuildScopedStore } from './build-scope'
import { sampleBuildInput, sampleEventWrite } from './contract'
import { MemoryBuildStore } from './memory'
import { PhaseSessionError, scopeLocalStoreToPhaseSession } from './phase-session'
import { SessionScopeError, createSessionScopedStore } from './session-handle'
import {
  loadReducerSnapshot,
  persistReducerSnapshot,
  snapshotScopeKey,
  snapshotSupersedes,
} from './snapshots'

const stub = (version: number) =>
  defineReducer<{ n: number }, { seq: number }, number>({
    version,
    initial: () => ({ n: 0 }),
    fold: (acc, events) => {
      acc.n += events.length
    },
    finish: (acc) => acc.n,
  })

async function seeded(): Promise<MemoryBuildStore> {
  const store = new MemoryBuildStore()
  await store.createBuild(sampleBuildInput('snap-a'))
  await store.createBuild(sampleBuildInput('snap-b'))
  await store.append('snap-a', sampleEventWrite('one'))
  await store.append('snap-a', sampleEventWrite('two'))
  await store.ensureRepo('acme/snap')
  return store
}

describe('reducer snapshot helpers', () => {
  test('a snapshot written under reducer version N is ignored under N+1 and replaced by the next write', async () => {
    const store = await seeded()
    const scope = { kind: 'build', slug: 'snap-a' } as const
    const v1 = stub(1)
    const v2 = stub(2)
    const acc = v1.advance(v1.initial(), [{ seq: 1 }, { seq: 2 }])
    expect(
      await persistReducerSnapshot(store, scope, 'stub', { version: 1, cursor: 2, state: acc }),
    ).toBe(true)
    expect((await loadReducerSnapshot(store, scope, 'stub', v1))?.cursor).toBe(2)
    expect(await loadReducerSnapshot(store, scope, 'stub', v2)).toBeNull()
    // The upgraded reducer replaces the old shape at an unchanged tail.
    expect(
      await persistReducerSnapshot(store, scope, 'stub', {
        version: 2,
        cursor: 2,
        state: { n: 2, extra: true },
      }),
    ).toBe(true)
    expect(await loadReducerSnapshot(store, scope, 'stub', v1)).toBeNull()
    expect((await loadReducerSnapshot(store, scope, 'stub', v2))?.state).toEqual({
      n: 2,
      extra: true,
    })
  })

  test('a failing or absent snapshot port degrades to a miss and never throws', async () => {
    const scope = { kind: 'repo', repo: 'acme/snap' } as const
    const throwing = {
      getReducerSnapshot: async () => {
        throw new Error('boom')
      },
      putReducerSnapshot: async () => {
        throw new Error('boom')
      },
    }
    expect(await loadReducerSnapshot(throwing, scope, 'j', stub(1))).toBeNull()
    expect(
      await persistReducerSnapshot(throwing, scope, 'j', { version: 1, cursor: 0, state: {} }),
    ).toBe(false)
    // An older adapter has no snapshot methods at all.
    expect(await loadReducerSnapshot({}, scope, 'j', stub(1))).toBeNull()
    expect(await persistReducerSnapshot({}, scope, 'j', { version: 1, cursor: 0, state: {} })).toBe(
      false,
    )
    // A row whose version disagrees with the reducer is a miss even if the
    // adapter returned it.
    const wrong = { getReducerSnapshot: async () => ({ version: 9, cursor: 1, state: {} }) }
    expect(await loadReducerSnapshot(wrong, scope, 'j', stub(1))).toBeNull()
  })

  test('supersession: higher cursor wins, equal cursor needs a higher version', () => {
    expect(snapshotSupersedes({ version: 1, cursor: 1 }, undefined)).toBe(true)
    expect(snapshotSupersedes({ version: 1, cursor: 2 }, { version: 9, cursor: 1 })).toBe(true)
    expect(snapshotSupersedes({ version: 9, cursor: 1 }, { version: 1, cursor: 2 })).toBe(false)
    expect(snapshotSupersedes({ version: 2, cursor: 2 }, { version: 1, cursor: 2 })).toBe(true)
    expect(snapshotSupersedes({ version: 1, cursor: 2 }, { version: 1, cursor: 2 })).toBe(false)
  })

  test('scope keys keep build and repository namespaces apart', () => {
    expect(snapshotScopeKey({ kind: 'build', slug: 'x' })).not.toBe(
      snapshotScopeKey({ kind: 'repo', repo: 'x' }),
    )
  })
})

describe('scoped handles', () => {
  test('a build-scoped handle reaches only its own build; session handles and phase sessions are guarded', async () => {
    const store = await seeded()
    const scoped = createBuildScopedStore(store, 'snap-a')
    const own = { kind: 'build', slug: 'snap-a' } as const
    expect(
      await scoped.putReducerSnapshot(own, 'build', { version: 1, cursor: 1, state: {} }),
    ).toBe(true)
    expect((await scoped.getReducerSnapshot(own, 'build', 1))?.cursor).toBe(1)
    await expect(
      scoped.getReducerSnapshot({ kind: 'build', slug: 'snap-b' }, 'build', 1),
    ).rejects.toThrow()
    await expect(
      scoped.putReducerSnapshot({ kind: 'repo', repo: 'acme/snap' }, 'j', {
        version: 1,
        cursor: 0,
        state: {},
      }),
    ).rejects.toThrow()

    const session = createSessionScopedStore(store, 's_one')
    await expect(session.getReducerSnapshot(own, 'build', 1)).rejects.toBeInstanceOf(
      SessionScopeError,
    )

    const phase = scopeLocalStoreToPhaseSession(store, {
      kind: 'build',
      id: 'snap-a',
      session: 's_one',
    })
    expect((await phase.getReducerSnapshot(own, 'build', 1))?.cursor).toBe(1)
    await expect(
      phase.getReducerSnapshot({ kind: 'build', slug: 'snap-b' }, 'build', 1),
    ).rejects.toBeInstanceOf(PhaseSessionError)
    await expect(
      phase.putReducerSnapshot({ kind: 'repo', repo: 'acme/snap' }, 'j', {
        version: 1,
        cursor: 0,
        state: {},
      }),
    ).rejects.toBeInstanceOf(PhaseSessionError)
  })
})
