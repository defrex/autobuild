import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { buildCreatedWrite, sampleBuildInput } from '../store/contract'
import { readBuildFacts } from '../store/reduced-reads'
import { newerFact, seedNewerMemoryFact } from '../testing/newer-writer'
import { manualClock } from '../testing/fixed'
import { deferMixedVersion, withDrainingExecution } from './mixed-version'

function fixture() {
  const store = new MemoryBuildStore({ clock: manualClock() })
  const seed = (seq: number, classification: 'advisory' | 'decisive' = 'decisive') =>
    seedNewerMemoryFact(store, newerFact(seq, classification))
  return { store, seed }
}

test('durable deferral attention names only decisive unknown types and releases', async () => {
  const { store, seed } = fixture()
  await store.createBuild(sampleBuildInput('mixed'))
  await store.append('mixed', buildCreatedWrite())
  seedNewerMemoryFact(store, {
    ...newerFact(2, 'advisory'),
    type: 'future.advisory',
    compatibility: { classification: 'advisory', writerVersion: 'advisory-release' },
  })
  await readBuildFacts(store, 'mixed') // Persist before the decisive delta.
  seed(3)
  expect(await deferMixedVersion(store, 'mixed')).toBe(true)
  const events = await store.getEvents('mixed')
  const attention = events.find((event) => event.type === 'build.compatibility-deferred')!
  expect(attention.payload).toMatchObject({
    types: [newerFact(3).type],
    writerVersions: [newerFact(3).compatibility!.writerVersion],
    legacyVersionUnavailable: false,
    boundary: 3,
  })
  expect(JSON.stringify(attention.payload)).not.toContain('future.advisory')
  expect(JSON.stringify(attention.payload)).not.toContain('advisory-release')
  expect((await readBuildFacts(store, 'mixed')).value.state.compatibility.unknownFacts).toBe(2)
})

test('only matching unsettled build-log drain authorization suppresses restart attention', async () => {
  const { store, seed } = fixture()
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  await store.createBuild(sampleBuildInput('mixed'))
  await store.append('mixed', buildCreatedWrite())
  await store.append('mixed', {
    actor: { kind: 'dispatcher' },
    type: 'execution.drain-authorized',
    payload: { correlation: 'handoff', run: 'old-run', instance: 'old-execution', runtime },
  })
  seed(3)
  const old = withDrainingExecution(store.scopeBuild('mixed'), 'old-execution', runtime)
  expect(await deferMixedVersion(old, 'mixed')).toBe(true)
  expect(
    (await store.getEvents('mixed')).some((event) => event.type === 'build.compatibility-deferred'),
  ).toBe(false)
  const unrelated = withDrainingExecution(store.scopeBuild('mixed'), 'new-execution', runtime)
  expect(await deferMixedVersion(unrelated, 'mixed')).toBe(true)
  expect(
    (await store.getEvents('mixed')).filter(
      (event) => event.type === 'build.compatibility-deferred',
    ),
  ).toHaveLength(1)
  await store.append('mixed', {
    actor: { kind: 'dispatcher' },
    type: 'execution.drain-settled',
    payload: { correlation: 'handoff', instance: 'old-execution' },
  })
  seed(6)
  expect(await deferMixedVersion(old, 'mixed')).toBe(true)
  expect(
    (await store.getEvents('mixed')).filter(
      (event) => event.type === 'build.compatibility-deferred',
    ),
  ).toHaveLength(2)
})

test('an execution end fences drain authorization in either write order', async () => {
  const runtime = {
    version: '1.0.0',
    commit: 'unknown',
    source: { kind: 'package' as const, location: '/old' },
  }
  for (const endedFirst of [true, false]) {
    const { store, seed } = fixture()
    await store.createBuild(sampleBuildInput('mixed'))
    await store.append('mixed', buildCreatedWrite())
    const authorized = {
      actor: { kind: 'dispatcher' as const },
      type: 'execution.drain-authorized' as const,
      payload: { correlation: 'drain', run: 'old', runtime, instance: 'execution' },
    }
    const ended = {
      actor: { kind: 'dispatcher' as const },
      type: 'execution.ended' as const,
      payload: { instance: 'execution', workspaceRef: 'ws', outcome: 'completed' as const },
    }
    for (const event of endedFirst ? [ended, authorized] : [authorized, ended])
      await store.append('mixed', event)
    seed(4)
    expect(
      await deferMixedVersion(
        withDrainingExecution(store.scopeBuild('mixed'), 'execution', runtime),
        'mixed',
      ),
    ).toBe(true)
    expect(
      (await store.getEvents('mixed')).filter(
        (event) => event.type === 'build.compatibility-deferred',
      ),
    ).toHaveLength(1)
  }
})
