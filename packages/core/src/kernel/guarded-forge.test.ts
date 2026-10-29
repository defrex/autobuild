import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { FakeForge } from '../ports/forge/fake'
import { ForgeFailure, isForgeFailure } from '../ports/forge-failure'
import { manualClock } from '../testing/fixed'
import { readForgeHealth } from '../store/reduced-reads'
import { guardForge, ForgeCooldown } from './guarded-forge'

test('classified limits persist across wrappers, gate subsequent calls, and recover only on success', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  const raw = new FakeForge()
  let calls = 0
  const resetAt = new Date(now().getTime() + 60_000).toISOString()
  raw.getPrState = async () => {
    calls++
    throw {
      forgeFailure: 'autobuild.forge-failure.v1',
      message: 'secondary limit',
      details: { kind: 'rate-limited', resetAt },
    }
  }
  let forge = guardForge(raw, { store, repo: 'r', name: 'plugin', now })
  await expect(forge.getPrState('/r', 1)).rejects.toMatchObject({ message: 'secondary limit' })
  expect((await readForgeHealth(store, 'r'))?.resetAt).toBe(resetAt)
  forge = guardForge(raw, { store, repo: 'r', name: 'plugin', now })
  await expect(forge.getPrState('/r', 1)).rejects.toBeInstanceOf(ForgeCooldown)
  expect(calls).toBe(1)
  now.advance(60_000)
  raw.getPrState = async () => {
    throw new Error('ordinary failure')
  }
  await expect(forge.getPrState('/r', 1)).rejects.toThrow('ordinary failure')
  expect(await readForgeHealth(store, 'r')).toBeDefined()
  raw.setPrState(1, { state: 'open', mergeable: null })
  raw.getPrState = FakeForge.prototype.getPrState.bind(raw)
  await forge.getPrState('/r', 1)
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
  expect((await store.getRepoEvents('r')).map((e) => e.type)).toEqual([
    'dispatcher.forge-degraded',
    'dispatcher.forge-recovered',
  ])
})

test('failure discriminants validate fields without requiring shared class identity', () => {
  expect(
    isForgeFailure(new ForgeFailure('network', { kind: 'transient', retry: 'retryable' })),
  ).toBe(true)
  expect(
    isForgeFailure({
      forgeFailure: 'autobuild.forge-failure.v1',
      message: 'limit',
      details: { kind: 'rate-limited', resetAt: 'bad' },
    }),
  ).toBe(false)
  expect(isForgeFailure(new Error('API rate limit exceeded'))).toBe(false)
})

test('runner composition retries a new limit only after durable dispatcher recovery', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  const append = store.appendRepo.bind(store)
  store.appendRepo = (async (repo, event) => {
    const result = await append(repo, event)
    if (event.type === 'dispatcher.forge-degraded') {
      now.advance(60_000)
      await append(repo, {
        actor: { kind: 'dispatcher' },
        type: 'dispatcher.forge-recovered',
        payload: { forge: 'plugin' },
      })
    }
    return result
  }) as typeof store.appendRepo
  let calls = 0
  const raw = new FakeForge()
  raw.getPrState = async () => {
    if (++calls === 1)
      throw new ForgeFailure('limit', {
        kind: 'rate-limited',
        resetAt: new Date(now().getTime() + 60_000).toISOString(),
      })
    return { state: 'open', mergeable: true }
  }
  const forge = guardForge(raw, { store, repo: 'r', name: 'plugin', now, wait: true })
  expect(await forge.getPrState('/r', 1)).toEqual({ state: 'open', mergeable: true })
  expect(calls).toBe(2)
  expect((await store.getRepoEvents('r')).map((e) => e.type)).toEqual([
    'dispatcher.forge-degraded',
    'dispatcher.forge-recovered',
  ])
})

test('scope callbacks and observation cache hits cannot prove forge recovery', async () => {
  const { GitHubForge } = await import('../ports/forge/github')
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  let calls = 0
  const raw = new GitHubForge({
    repository: 'acme/repo',
    transport: async () => {
      calls++
      return { status: 200, headers: {}, json: { commit: { sha: 'head' } } }
    },
  })
  const forge = guardForge(raw, { store, repo: 'r', name: 'github', now })
  await forge.withReadScope!(async () => {
    expect(await forge.remoteBranchSha!('main')).toBe('head')
    await store.appendRepo('r', {
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.forge-degraded',
      payload: {
        forge: 'github',
        message: 'limit',
        firstFailureAt: now().toISOString(),
        resetAt: now().toISOString(),
      },
    })
    expect(await forge.remoteBranchSha!('main')).toBe('head')
    expect(calls).toBe(1)
  })
  expect(await readForgeHealth(store, 'r')).toBeDefined()
  await forge.withReadScope!(async () => {})
  expect(await readForgeHealth(store, 'r')).toBeDefined()
  await forge.remoteBranchSha!('main')
  expect(calls).toBe(2)
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
})

test('an explicit override permits a probe but a real limit restores the observed cooldown', async () => {
  const { clearForgeDegradation } = await import('../operator/control')
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  const raw = new FakeForge()
  const resetAt = new Date(+now() + 60_000).toISOString()
  raw.getPrState = async () => {
    throw new ForgeFailure('limit', { kind: 'rate-limited', resetAt })
  }
  const forge = guardForge(raw, { store, repo: 'r', name: 'github', now })
  await expect(forge.getPrState('r', 1)).rejects.toThrow('limit')
  await clearForgeDegradation({
    store,
    repo: 'r',
    user: 'Ada',
    forge: 'github',
    reason: 'override erroneous state',
  })
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
  await expect(forge.getPrState('r', 1)).rejects.toThrow('limit')
  expect((await readForgeHealth(store, 'r'))?.resetAt).toBe(resetAt)
})
