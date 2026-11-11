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

test('a runner guard obeys a dispatcher-recorded cooldown and proceeds after dispatcher recovery', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  await store.appendRepo('r', {
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.forge-degraded',
    payload: {
      forge: 'plugin',
      message: 'limit',
      resetAt: new Date(now().getTime() + 60_000).toISOString(),
      firstFailureAt: now().toISOString(),
    },
  })
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    now.advance(60_000)
    await store.appendRepo('r', {
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.forge-recovered',
      payload: { forge: 'plugin' },
    })
  }
  let calls = 0
  const raw = new FakeForge()
  raw.getPrState = async () => {
    calls++
    return { state: 'open', mergeable: true }
  }
  const forge = guardForge(raw, {
    store,
    repo: 'r',
    name: 'plugin',
    now,
    wait: true,
    sleep,
    scope: { process: 'build-runner b' },
  })
  expect(await forge.getPrState('/r', 1)).toEqual({ state: 'open', mergeable: true })
  expect(sleeps).toEqual([30_000])
  expect(calls).toBe(1)
  expect((await store.getRepoEvents('r')).map((e) => e.type)).toEqual([
    'dispatcher.forge-degraded',
    'dispatcher.forge-recovered',
  ])
})

const anonymousLimit = (resetAt: string) =>
  new ForgeFailure('API rate limit exceeded for 3.86.63.34. (request was unauthenticated: unset)', {
    kind: 'rate-limited',
    resetAt,
    unauthenticated: 'GITHUB_TOKEN and GH_TOKEN are unset',
  })

test('an unauthenticated guest limit never defers the dispatcher and is reported once as attention', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  const resetAt = new Date(now().getTime() + 60_000).toISOString()
  const guestRaw = new FakeForge()
  let guestCalls = 0
  guestRaw.getPrState = async () => {
    if (++guestCalls <= 2) throw anonymousLimit(resetAt)
    return { state: 'open', mergeable: true }
  }
  const sleeps: number[] = []
  let dispatcherDuringWait: unknown
  const dispatcherRaw = new FakeForge()
  dispatcherRaw.setPrState(1, { state: 'open', mergeable: null })
  const dispatcher = guardForge(dispatcherRaw, { store, repo: 'r', name: 'github', now })
  const guest = guardForge(guestRaw, {
    store,
    repo: 'r',
    name: 'github',
    now,
    wait: true,
    scope: { process: 'build-runner b' },
    sleep: async (ms) => {
      sleeps.push(ms)
      // The incident: a concurrent dispatcher request while the guest waits.
      if (dispatcherDuringWait === undefined)
        dispatcherDuringWait = await dispatcher.getPrState('/r', 1)
      now.advance(ms)
    },
  })
  expect(await guest.getPrState('/r', 1)).toEqual({ state: 'open', mergeable: true })
  expect(dispatcherDuringWait).toMatchObject({ state: 'open' })
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
  // The second failure carries the same reset: no second fact.
  expect(guestCalls).toBe(3)
  expect(sleeps.length).toBeGreaterThan(0)
  const events = await store.getRepoEvents('r')
  expect(events.map((e) => e.type)).toEqual(['forge.credential-limited'])
  expect(events[0]!.payload).toEqual({
    forge: 'github',
    process: 'build-runner b',
    credential: 'unauthenticated',
    missingCredential: 'GITHUB_TOKEN and GH_TOKEN are unset',
    message: anonymousLimit(resetAt).message,
    resetAt,
  })
})

test('a process-scoped authenticated limit stays local to the process', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  const resetAt = new Date(now().getTime() + 60_000).toISOString()
  const raw = new FakeForge()
  raw.getPrState = async () => {
    throw new ForgeFailure('limit', { kind: 'rate-limited', resetAt })
  }
  const forge = guardForge(raw, {
    store,
    repo: 'r',
    name: 'github',
    now,
    scope: { process: 'phase session s (build b)' },
  })
  await expect(forge.getPrState('/r', 1)).rejects.toThrow('limit')
  await expect(forge.getPrState('/r', 1)).rejects.toBeInstanceOf(ForgeCooldown)
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
  const events = await store.getRepoEvents('r')
  expect(events.map((e) => e.type)).toEqual(['forge.credential-limited'])
  expect(events[0]!.payload).toMatchObject({
    process: 'phase session s (build b)',
    credential: 'process',
  })
  expect(events[0]!.payload).not.toHaveProperty('missingCredential')
})

test('a dispatcher unauthenticated limit cools down locally, then succeeds', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  const resetAt = new Date(now().getTime() + 60_000).toISOString()
  const raw = new FakeForge()
  raw.getPrState = async () => {
    throw anonymousLimit(resetAt)
  }
  const forge = guardForge(raw, { store, repo: 'r', name: 'github', now })
  await expect(forge.getPrState('/r', 1)).rejects.toThrow('API rate limit')
  await expect(forge.getPrState('/r', 1)).rejects.toBeInstanceOf(ForgeCooldown)
  expect(await readForgeHealth(store, 'r')).toBeUndefined()
  const events = await store.getRepoEvents('r')
  expect(events.map((e) => e.type)).toEqual(['forge.credential-limited'])
  expect(events[0]!.payload).toMatchObject({ process: 'dispatcher', credential: 'unauthenticated' })
  now.advance(60_000)
  raw.setPrState(1, { state: 'open', mergeable: null })
  raw.getPrState = FakeForge.prototype.getPrState.bind(raw)
  expect(await forge.getPrState('/r', 1)).toMatchObject({ state: 'open' })
})

test('a rejected attention append never changes the limited outcome', async () => {
  const now = manualClock()
  const store = new MemoryBuildStore({ clock: now })
  await store.ensureRepo('r')
  store.appendRepo = (async () => {
    throw new Error('unknown event type')
  }) as typeof store.appendRepo
  const resetAt = new Date(now().getTime() + 60_000).toISOString()
  const raw = new FakeForge()
  let calls = 0
  raw.getPrState = async () => {
    if (++calls === 1) throw anonymousLimit(resetAt)
    return { state: 'open', mergeable: true }
  }
  const failingRaw = new FakeForge()
  failingRaw.getPrState = async () => {
    throw anonymousLimit(resetAt)
  }
  const failing = guardForge(failingRaw, { store, repo: 'r', name: 'github', now })
  await expect(failing.getPrState('/r', 1)).rejects.toThrow('API rate limit')
  const waiting = guardForge(raw, {
    store,
    repo: 'r',
    name: 'github',
    now,
    wait: true,
    scope: { process: 'build-runner b' },
    sleep: async (ms) => now.advance(ms),
  })
  expect(await waiting.getPrState('/r', 1)).toEqual({ state: 'open', mergeable: true })
  expect(calls).toBe(2)
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
