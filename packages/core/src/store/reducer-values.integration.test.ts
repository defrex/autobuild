import { describe, expect, test } from 'bun:test'
import type { AbEvent } from '../events/catalog'
import type { RepositoryEvent } from '../events/repository'
import { REDUCERS } from '../kernel/reducer-registry'
import { randomBuildLog } from '../kernel/generators/build-log'
import {
  randomStatusJournal,
  randomHarvestJournal,
  randomSandboxJournal,
  randomSettingsJournal,
} from '../kernel/generators/repository-journals'
import {
  readReducerValue,
  resolveReducerValue,
  type ReducerValueRequest,
  type ValueCacheRow,
  type ReducerValueStorage,
} from './reducer-values'
import type { ReducerSnapshot, SnapshotScope } from './snapshots'
import { validateAccumulator, validateReducerValue } from './reducer-value-validation'

const build: SnapshotScope = { kind: 'build', slug: 'b' }
const repo: SnapshotScope = { kind: 'repo', repo: 'r' }
export const valueArguments: Record<string, NonNullable<ReducerValueRequest['args']>[]> = {
  dispatchStatus: [{ run: 'run-a' }, { run: 'run-b' }],
  dispatcherRunFacts: [{ run: 'run-a' }, { run: 'run-b' }],
  openTick: [{ run: 'run-a' }, { run: 'run-b' }],
  terminalGuard: [
    { phase: 'plan', round: 1, session: 'session-a' },
    { phase: 'implement', round: 2, session: 'session-b' },
  ],
  phaseFailures: [
    { phase: 'plan', round: 1 },
    { phase: 'verify:unit', round: 2 },
  ],
  dispatchFailureBudget: [
    { infrastructureOwnsWorkspace: false },
    { infrastructureOwnsWorkspace: true },
  ],
}
function cache(events: (AbEvent | RepositoryEvent)[]) {
  const rows = new Map<string, ValueCacheRow>()
  const costs: number[] = []
  const storage: ReducerValueStorage = {
    highWater: async () => events.at(-1)?.seq ?? 0,
    events: async (since, through) => {
      const delta = events.filter((event) => event.seq > since && event.seq <= through)
      costs.push(delta.length)
      return structuredClone(delta)
    },
    read: async (key) => structuredClone(rows.get(key) ?? null),
    put: async (key, snapshot) => {
      const prior = rows.get(key)
      if (prior && prior.snapshot.cursor >= snapshot.cursor) return false
      rows.set(key, { snapshot: structuredClone(snapshot), token: JSON.stringify(snapshot) })
      return true
    },
    repair: async (key, observed, snapshot) => {
      if (rows.get(key)?.token !== observed.token) return false
      rows.set(key, { snapshot: structuredClone(snapshot), token: JSON.stringify(snapshot) })
      return true
    },
  }
  return { rows, costs, storage }
}
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

describe('named reducer values', () => {
  for (const [name, entry] of Object.entries(REDUCERS)) {
    const eligibility = entry.valueRead
    if ('excluded' in eligibility) {
      test(`${name} has a reason and rejects before storage access`, async () => {
        expect(eligibility.excluded.length).toBeGreaterThan(10)
        await expect(
          readReducerValue(build, { reducer: name }, {} as ReducerValueStorage),
        ).rejects.toThrow('excluded')
      })
      continue
    }
    for (const args of valueArguments[name] ?? [{}]) {
      test(`${name} ${JSON.stringify(args)} restores nested state and equals replay`, async () => {
        const scope = eligibility.scope === 'build' ? build : repo
        const logs =
          eligibility.scope === 'build'
            ? [randomBuildLog(2, 100), randomBuildLog(4, 100)]
            : [
                randomStatusJournal(2, 80),
                randomHarvestJournal(2, 80),
                randomSandboxJournal(3, 50),
                randomSettingsJournal(2, 30),
              ]
        for (const log of logs) {
          const events = (log as (AbEvent | RepositoryEvent)[]).map((event, index) => ({
            ...event,
            seq: index + 1,
          }))
          const h = cache(events)
          const request = { reducer: name, args }
          const resolved = resolveReducerValue(scope, request)
          const expectedInput =
            name === 'buildDigest'
              ? events.map((event) => ({
                  ...event,
                  ...event.payload,
                  ...(event.type === 'integration.landed'
                    ? { auditRequested: !!event.payload.operation }
                    : {}),
                  ...(event.type === 'pr.merged' ? { mergedSha: event.payload.sha } : {}),
                  ...(event.type === 'node.contribution-recorded'
                    ? { nodeContribution: event.payload }
                    : {}),
                }))
              : events
          const expected = json(resolved.reducer.reduce(expectedInput))
          const cold = await readReducerValue(scope, request, h.storage)
          expect(cold.value).toEqual(expected)
          expect(cold.cursor).toBe(events.length)
          expect(
            validateAccumulator(
              name,
              (h.rows.get(resolved.key)!.snapshot.state as { acc: unknown }).acc,
            ),
          ).toBe(true)
          expect(await readReducerValue(scope, request, h.storage)).toEqual(cold)
          expect(h.costs.at(-1)).toBe(0)
          // A nested corrupt row must replay and repair even at the same cursor.
          const bad: ReducerSnapshot = {
            version: cold.version,
            cursor: cold.cursor,
            state: { identity: resolved.identity, acc: { invalid: { nested: true } } },
          }
          h.rows.set(resolved.key, { snapshot: bad, token: 'bad' })
          expect(await readReducerValue(scope, request, h.storage)).toEqual(cold)
          expect(h.costs.at(-1)).toBe(events.length)
          expect(await readReducerValue(scope, request, h.storage)).toEqual(cold)
          expect(h.costs.at(-1)).toBe(0)
        }
      })
    }
  }
  test('invalid requests and wrong scopes never access storage', async () => {
    for (const request of [
      { reducer: 'unknown' },
      { reducer: 'openTick', args: {} },
      { reducer: 'openTick', args: { run: 12 } },
      { reducer: 'build', args: { extra: true } },
    ])
      await expect(
        readReducerValue(build, request as ReducerValueRequest, {} as ReducerValueStorage),
      ).rejects.toThrow()
    await expect(
      readReducerValue(repo, { reducer: 'build' }, {} as ReducerValueStorage),
    ).rejects.toThrow('scope')
  })
  test('append during read is limited to the captured prefix; foreign advances are adopted', async () => {
    const events = randomBuildLog(2, 50).map((event, index) => ({ ...event, seq: index + 1 }))
    const h = cache(events.slice(0, 20))
    let boundary = 20
    h.storage.highWater = async () => boundary
    h.storage.events = async (since, through) =>
      events.filter((event) => event.seq > since && event.seq <= through)
    const first = await readReducerValue(build, { reducer: 'build' }, h.storage)
    expect(first.cursor).toBe(20)
    boundary = 50
    const advanced = await readReducerValue(build, { reducer: 'build' }, h.storage)
    h.storage.highWater = async () => {
      h.storage.highWater = async () => 50
      return 20
    }
    expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(advanced)
  })
  test('unreadable cache replays; failed log reads and sequence gaps propagate', async () => {
    const h = cache(
      randomBuildLog(2, 20)
        .slice(0, 20)
        .map((event, index) => ({ ...event, seq: index + 1 })),
    )
    h.storage.read = async () => {
      throw new Error('cache unavailable')
    }
    expect((await readReducerValue(build, { reducer: 'build' }, h.storage)).cursor).toBe(20)
    h.storage.events = async () => {
      throw new Error('log unavailable')
    }
    await expect(readReducerValue(build, { reducer: 'build' }, h.storage)).rejects.toThrow(
      'log unavailable',
    )
    h.storage.events = async () => []
    await expect(readReducerValue(build, { reducer: 'build' }, h.storage)).rejects.toThrow(
      'incomplete',
    )
  })
})

test('a delayed writer and stale repair never overwrite a newer winner', async () => {
  const events = randomBuildLog(2, 50)
    .slice(0, 50)
    .map((event, index) => ({ ...event, seq: index + 1 }))
  const h = cache(events)
  let boundary = 20
  h.storage.highWater = async () => boundary
  const put = h.storage.put
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  h.storage.put = async (key, snapshot) => {
    if (snapshot.cursor === 20) {
      entered()
      await gate
    }
    return put(key, snapshot)
  }
  const delayed = readReducerValue(build, { reducer: 'build' }, h.storage)
  await started
  boundary = 50
  const winner = await readReducerValue(build, { reducer: 'build' }, h.storage)
  release()
  expect((await delayed).cursor).toBe(20)
  expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(winner)
  const resolved = resolveReducerValue(build, { reducer: 'build' })
  h.rows.set(resolved.key, {
    token: 'poison',
    snapshot: { version: resolved.reducer.version, cursor: 500, state: null },
  })
  const repair = h.storage.repair
  h.storage.repair = async (key, observed, snapshot) => {
    h.rows.set(key, {
      snapshot: {
        version: winner.version,
        cursor: winner.cursor,
        state: {
          identity: resolved.identity,
          acc: resolved.reducer.advance(resolved.reducer.initial(), events),
        },
      },
      token: 'valid-winner',
    })
    return repair(key, observed, snapshot)
  }
  expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(winner)
  expect(h.rows.get(resolved.key)!.token).toBe('valid-winner')
  h.storage.repair = repair
  h.rows.set(resolved.key, {
    token: 'ahead',
    snapshot: { version: resolved.reducer.version, cursor: 500, state: null },
  })
  expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(winner)
  expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(winner)
  expect(h.costs.at(-1)).toBe(0)
  h.rows.clear()
  expect(await readReducerValue(build, { reducer: 'build' }, h.storage)).toEqual(winner)
})

test('own malformed rows repair once; foreign versions remain untouched', async () => {
  const events = randomBuildLog(3, 40)
    .slice(0, 40)
    .map((event, index) => ({ ...event, seq: index + 1 }))
  const request = { reducer: 'build' }
  const resolved = resolveReducerValue(build, request)
  const valid = resolved.reducer.advance(resolved.reducer.initial(), events)
  const nested = json(valid)
  nested.plan.approved = { invalid: true }
  expect(validateAccumulator('build', nested)).toBe(false)
  for (const snapshot of [
    {
      version: resolved.reducer.version,
      cursor: 40,
      state: { identity: resolved.identity, acc: nested },
    },
    {
      version: resolved.reducer.version + 1,
      cursor: 40,
      state: { identity: resolved.identity, acc: valid },
    },
    {
      version: resolved.reducer.version,
      cursor: 40,
      state: { identity: 'other-scope', acc: valid },
    },
  ]) {
    const h = cache(events)
    h.rows.set(resolved.key, { snapshot, token: 'invalid-row' })
    const answer = await readReducerValue(build, request, h.storage)
    expect(answer.value).toEqual(json(resolved.reducer.reduce(events)))
    expect(await readReducerValue(build, request, h.storage)).toEqual(answer)
    expect(h.costs.at(-1)).toBe(snapshot.version === resolved.reducer.version ? 0 : 40)
    if (snapshot.version !== resolved.reducer.version)
      expect(h.rows.get(resolved.key)?.snapshot).toEqual(snapshot)
  }
})

test('repository persisted configuration state does not contain irrelevant ticks', async () => {
  const events = Array.from({ length: 4000 }, (_, index) => ({
    repo: 'r',
    seq: index + 1,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'human', user: 'op' },
    type: 'dispatcher.intake-set',
    payload: { enabled: true },
  })) as RepositoryEvent[]
  events[0] = {
    repo: 'r',
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'dispatcher' },
    type: 'dispatcher.run-started',
    payload: {
      run: 'long-run',
      pid: 1,
      roleWarnings: [],
      effectiveConfig: { kind: 'config', rev: 0 },
    },
  }
  for (let index = 1; index < events.length; index++)
    events[index] = {
      ...events[index]!,
      actor: { kind: 'dispatcher' },
      type: 'dispatcher.tick-started',
      payload: { run: 'long-run' },
    }
  const h = cache(events)
  let boundary = 1000
  h.storage.highWater = async () => boundary
  const request = { reducer: 'effectiveConfig' }
  await readReducerValue(repo, request, h.storage)
  const key = resolveReducerValue(repo, request).key
  const before = JSON.stringify(h.rows.get(key)!.snapshot.state)
  boundary = 4000
  await readReducerValue(repo, request, h.storage)
  expect(JSON.stringify(h.rows.get(key)!.snapshot.state)).toBe(before)
  expect(before).not.toContain('dispatcher.tick-started')
})

for (const warm of [false, true]) {
  for (const boundary of ['highWater', 'read', 'events', 'put'] as const) {
    test(`repository prefix invariant: ${warm ? 'warm' : 'cold'} concurrent ${boundary}`, async () => {
      const events: RepositoryEvent[] = []
      const { storage } = cache(events)
      const request = { reducer: 'repositoryReadFacts' }
      const { entry, reducer } = resolveReducerValue(repo, request)
      const append = (type: RepositoryEvent['type'], payload: unknown) => {
        events.push({
          repo: 'r',
          seq: events.length + 1,
          ts: '2026-10-20T19:06:38.000Z',
          actor: { kind: 'dispatcher' },
          type,
          payload,
        } as RepositoryEvent)
      }
      append('dispatcher.ticket-source-degraded', {
        source: 'linear',
        operation: 'ready-scan',
        cause: 'rate-limited',
        message: 'limited',
        resetAt: '2026-10-20T19:07:38.000Z',
      })
      if (warm) await readReducerValue(repo, request, storage)
      append('dispatcher.ticket-source-dependency-limited', { source: 'linear' })
      let release!: () => void
      let entered!: () => void
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const arrived = new Promise<void>((resolve) => {
        entered = resolve
      })
      let held = false
      const intercepted = {
        ...storage,
        [boundary]: async (...args: unknown[]) => {
          // Sampling before the barrier forces a reader with an older boundary
          // to observe the second reader's newer checkpoint on release.
          const result = await (storage[boundary] as (...args: unknown[]) => Promise<unknown>)(
            ...args,
          )
          if (!held) {
            held = true
            entered()
            await blocked
          }
          return result
        },
      } as ReducerValueStorage
      const first = readReducerValue(repo, request, intercepted)
      await arrived
      append('dispatcher.ticket-source-dependency-limited', { source: 'linear' })
      append('dispatcher.ticket-source-recovered', {
        source: 'linear',
        operation: 'ready-scan',
        cause: 'rate-limited',
      })
      append('dispatcher.tick-started', { run: 'r', startedAt: '2026-10-20T19:06:38.000Z' })
      append('dispatcher.tick-failed', { run: 'r', error: 'probe' })
      const second = await readReducerValue(repo, request, storage)
      release()
      for (const answer of [await first, second]) {
        expect(validateReducerValue('repositoryReadFacts', answer.value)).toBe(true)
        const acc = reducer.advance(reducer.initial(), entry.adapt(events.slice(0, answer.cursor)))
        expect(answer.value).toEqual(entry.value(reducer.finish(acc)))
      }
    })
  }
}

for (const [scope, name, log] of [
  [build, 'buildStreamSeed', randomBuildLog(2, 100)],
  [repo, 'repositoryAttention', randomStatusJournal(2, 100)],
] as const) {
  test(`${name} repairs legacy advancement from the latest checkpoint`, async () => {
    const events = log.map((event, index) => ({ ...event, seq: index + 1 })) as (
      | AbEvent
      | RepositoryEvent
    )[]
    const gap = events.splice(-7)
    const h = cache(events)
    const request = { reducer: name }
    const checkpoints = new Map<number, ReducerSnapshot>()
    const storage: ReducerValueStorage = {
      ...h.storage,
      checkpoints: {
        coverage: async (_key, cursor) => checkpoints.has(cursor),
        latest: async (_key, through) =>
          checkpoints.get(Math.max(-1, ...[...checkpoints.keys()].filter((c) => c <= through))) ??
          null,
        publish: async (key, snapshot, captured) => {
          for (const checkpoint of captured) checkpoints.set(checkpoint.cursor, checkpoint)
          h.rows.set(key, { snapshot, token: JSON.stringify(snapshot) })
        },
      },
    }
    await readReducerValue(scope, request, storage)
    events.push(...gap)
    // The still-live pre-change server uses the same canonical key but has no sink.
    const legacy = await readReducerValue(scope, request, h.storage)
    const recovered = await readReducerValue(scope, request, storage)
    expect(recovered).toEqual(legacy)
    expect(h.costs.at(-1)).toBe(7)
    expect(checkpoints.has(recovered.cursor)).toBe(true)
    expect(await readReducerValue(scope, request, storage)).toEqual(recovered)
    expect(h.costs.at(-1)).toBe(0)
    // Initial legacy adoption is recoverable even when no checkpoint exists.
    checkpoints.clear()
    expect(await readReducerValue(scope, request, storage)).toEqual(legacy)
    expect(h.costs.at(-1)).toBe(events.length)
    expect(checkpoints.has(recovered.cursor)).toBe(true)
  })
}
