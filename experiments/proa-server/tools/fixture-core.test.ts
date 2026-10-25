import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { humanActor, KERNEL, DISPATCHER } from '../../../packages/core/src/events/envelope'
import { installCollector, collectedStreams } from './capture-scenario-logs'
import {
  catalog,
  reducerVersions,
  deduplicateFixtures,
  gzipCorpus,
  expected,
  schemas,
  unknownEvent,
  witness,
  witnessEvent,
} from './fixture-core'
import { checkEventSchemas, checkFixtures } from './check-fixtures'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  childEnvironment,
  normalizeEvents,
  publishFixtures,
  scenarioFiles,
} from './generate-fixtures'

test('every catalog payload has a schema-validated generated witness', () => {
  for (const entries of Object.values(schemas))
    for (const schema of Object.values(entries))
      expect(schema.safeParse(witness(schema)).success).toBe(true)
})
test('freshness fails for changed outputs, source closure, and unrepresented catalog names', () => {
  const fixture = { id: 'empty', scope: 'build', events: [], expected: expected('build', []) }
  const corpus = {
    manifest: { sources: {}, catalog: catalog(), versions: reducerVersions() },
    fixtures: [fixture],
  }
  expect(() => checkFixtures(corpus, { changed: 'digest' })).toThrow('source closure')
  expect(() => checkFixtures(corpus, {}, { ...catalog(), build: ['new.event'] })).toThrow(
    'catalog changed',
  )
  fixture.expected = { build: { wrong: true } }
  expect(() => checkFixtures(corpus, {})).toThrow('stale TypeScript')
})
test('producer environment excludes phase and production storage credentials', () => {
  const environment = childEnvironment()
  expect(
    Object.keys(environment).some((name) => /^(AB_|AWS_|VERCEL_|DATABASE_URL$)/.test(name)),
  ).toBe(false)
})
test('collector observes successful atomic and conditional persistence exactly once and retains store identities', async () => {
  const originalAppend = MemoryBuildStore.prototype.append
  const uninstall = installCollector()
  try {
    const store = new MemoryBuildStore()
    const other = new MemoryBuildStore()
    await store.createBuild({ slug: 'collector', repo: 'repo' })
    await other.createBuild({ slug: 'collector', repo: 'repo' })
    await store.createBuild({
      slug: 'created',
      repo: 'repo',
      created: {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket: { source: 'test', id: '1' }, repo: 'repo', baseBranch: 'main' },
      },
    })
    const event = { actor: KERNEL, type: 'build.paused' as const, payload: {} }
    await store.append('collector', event)
    await store.appendIfCurrent('collector', 1, event)
    expect(await store.appendIfCurrent('collector', 1, event)).toBeNull()
    await store.appendWithArtifacts('collector', [], () => event)
    await store.appendWithArtifactsIfCurrent('collector', 3, [], () => event)
    expect(await store.appendWithArtifactsIfCurrent('collector', 1, [], () => event)).toBeNull()
    await store.ensureRepo('repo')
    const repoEvent = {
      actor: humanActor('test'),
      type: 'dispatcher.intake-set' as const,
      payload: { enabled: true },
    }
    await store.appendRepo('repo', repoEvent)
    await store.appendRepoWithArtifacts('repo', [], () => repoEvent)
    await store.claimRepoLease('repo', 'run', 60_000)
    await store.beginRepoTick('repo', 'run')
    await store.finishRepoTick('repo', 'run', { outcome: 'failed', error: 'test' }, [
      { actor: DISPATCHER, type: 'dispatcher.tick-started', payload: { run: 'run' } },
      { actor: DISPATCHER, type: 'dispatcher.tick-failed', payload: { run: 'run', error: 'test' } },
    ])
    const session = await store.createSession({ repo: 'repo', operator: 'test' })
    const sessionEvent = {
      actor: humanActor('test'),
      type: 'session.wake-set' as const,
      payload: { globs: [] },
    }
    await store.appendSessionEvent(session.id, sessionEvent)
    await store.appendSessionEventIfCurrent(session.id, 2, sessionEvent)
    expect(await store.appendSessionEventIfCurrent(session.id, 1, sessionEvent)).toBeNull()
    await store.appendSessionWithArtifacts(session.id, [], () => sessionEvent)
    const captured = collectedStreams()
    expect(
      captured
        .filter((stream) => stream.scope === 'build' && stream.id.endsWith('/collector'))
        .map((stream) => stream.events.length),
    ).toEqual([4, 0])
    expect(captured.find((stream) => stream.id.endsWith('/created'))!.events).toMatchObject([
      { type: 'build.created', seq: 1 },
    ])
    expect(captured.find((stream) => stream.scope === 'repository')!.events).toHaveLength(4)
    expect(captured.find((stream) => stream.scope === 'repository')!.events.slice(2)).toMatchObject(
      [
        { type: 'dispatcher.tick-started', seq: 3 },
        { type: 'dispatcher.tick-failed', seq: 4 },
      ],
    )
    expect(captured.find((stream) => stream.scope === 'session')!.events).toHaveLength(4)
    await store.close()
  } finally {
    uninstall()
  }
  expect(MemoryBuildStore.prototype.append).toBe(originalAppend)
  expect(collectedStreams()).toEqual([])
})

test('new scenario files are discovered without a maintained allowlist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proa-discovery-'))
  try {
    writeFileSync(join(directory, 'a.test.ts'), '')
    expect(scenarioFiles(directory)).toHaveLength(1)
    writeFileSync(join(directory, 'new.test.ts'), '')
    writeFileSync(join(directory, 'harness.ts'), '')
    expect(scenarioFiles(directory)).toHaveLength(2)
  } finally {
    rmSync(directory, { recursive: true })
  }
})
test('catalog name without an actual event witness fails coverage', () => {
  const corpus = {
    manifest: { sources: {}, catalog: catalog(), versions: reducerVersions() },
    fixtures: [],
  }
  expect(() => checkFixtures(corpus, {})).toThrow('missing decoding witness')
})

test('hand-edited event decoding schemas fail freshness', () => {
  expect(() => checkEventSchemas({})).toThrow('stale event decoding schemas')
})

test('temporary-root normalization preserves identity and distinct roots', () => {
  expect(
    normalizeEvents([{ a: '/tmp/first/a', b: '/tmp/second/a', again: '/tmp/first/b' }]),
  ).toEqual([
    { a: '/tmp/proa-fixture-1/a', b: '/tmp/proa-fixture-2/a', again: '/tmp/proa-fixture-1/b' },
  ])
})

test('unknown classification uses each scope catalog and never excludes known-only histories', () => {
  for (const scope of Object.keys(schemas) as (keyof typeof schemas)[]) {
    for (const type of Object.keys(schemas[scope]))
      expect(unknownEvent(scope, [{ type, seq: 1 }])).toBeUndefined()
    expect(unknownEvent(scope, [{ type: 'future.event', seq: 7 }])).toEqual({
      type: 'future.event',
      seq: 7,
    })
  }
})

test('lossless deduplication preserves independent producer identities and deterministic gzip headers', () => {
  const base = { id: 'store-1', scope: 'build', events: [], expected: expected('build', []) }
  const unique = deduplicateFixtures([base, { ...base, id: 'store-2' }])
  expect(unique).toHaveLength(1)
  expect(unique[0]!.aliases).toEqual(['store-1', 'store-2'])
  const bytes = gzipCorpus({ fixtures: unique })
  expect(bytes.readUInt32LE(4)).toBe(0)
  expect(gzipCorpus({ fixtures: unique })).toEqual(bytes)
})

test('reducer version metadata cannot silently drift', () => {
  expect(() =>
    checkFixtures(
      { manifest: { sources: {}, catalog: catalog(), versions: {} }, fixtures: [] },
      {},
    ),
  ).toThrow('reducer versions changed')
})

test('failed candidate publication restores the previous corpus and retains the candidate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proa-publication-'))
  const candidate = join(directory, 'candidate')
  const destination = join(directory, 'fixtures')
  mkdirSync(candidate)
  mkdirSync(destination)
  writeFileSync(join(candidate, 'new.json'), 'new')
  writeFileSync(join(destination, 'old.json'), 'old')
  try {
    expect(() =>
      publishFixtures(candidate, destination, () => {
        throw new Error('simulated publication failure')
      }),
    ).toThrow('simulated publication failure')
    expect(readFileSync(join(destination, 'old.json'), 'utf8')).toBe('old')
    expect(readFileSync(join(candidate, 'new.json'), 'utf8')).toBe('new')
    expect(existsSync(join(destination, 'new.json'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('a newly catalogued name without a witness fails even after catalog metadata is refreshed', () => {
  const extendedCatalog = { ...catalog(), build: [...catalog().build!, 'future.event'] }
  const decodingWitnesses = Object.entries(schemas).flatMap(([scope, entries]) =>
    Object.entries(entries).map(([type, schema]) => ({
      scope,
      event: witnessEvent(scope as keyof typeof schemas, type, schema),
    })),
  )
  const corpus = {
    manifest: { sources: {}, catalog: extendedCatalog, versions: reducerVersions() },
    fixtures: [],
    decodingWitnesses,
  }
  expect(() => checkFixtures(corpus, {}, extendedCatalog)).toThrow(
    'missing decoding witness future.event',
  )
})
