import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../../../packages/core/src/store/memory'
import { humanActor, KERNEL } from '../../../packages/core/src/events/envelope'
import { installCollector, collectedStreams } from './capture-scenario-logs'
import { catalog, expected, schemas, unknownEvent, witness } from './fixture-core'
import { checkEventSchemas, checkFixtures } from './check-fixtures'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnvironment, normalizeEvents, scenarioFiles } from './generate-fixtures'

test('every catalog payload has a schema-validated generated witness', () => {
  for (const entries of Object.values(schemas))
    for (const schema of Object.values(entries))
      expect(schema.safeParse(witness(schema)).success).toBe(true)
})
test('freshness fails for changed outputs, source closure, and unrepresented catalog names', () => {
  const fixture = { id: 'empty', scope: 'build', events: [], expected: expected('build', []) }
  const corpus = { manifest: { sources: {}, catalog: catalog() }, fixtures: [fixture] }
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
  installCollector()
  const store = new MemoryBuildStore()
  const other = new MemoryBuildStore()
  await store.createBuild({ slug: 'collector', repo: 'repo' })
  await other.createBuild({ slug: 'collector', repo: 'repo' })
  const event = { actor: KERNEL, type: 'build.paused' as const, payload: {} }
  await store.append('collector', event)
  await store.appendIfCurrent('collector', 1, event)
  expect(await store.appendIfCurrent('collector', 1, event)).toBeNull()
  await store.appendWithArtifacts('collector', [], () => event)
  await store.appendWithArtifactsIfCurrent('collector', 3, [], () => event)
  await store.ensureRepo('repo')
  const repoEvent = {
    actor: humanActor('test'),
    type: 'dispatcher.intake-set' as const,
    payload: { enabled: true },
  }
  await store.appendRepo('repo', repoEvent)
  await store.appendRepoWithArtifacts('repo', [], () => repoEvent)
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
  expect(captured.find((stream) => stream.scope === 'repository')!.events).toHaveLength(2)
  expect(captured.find((stream) => stream.scope === 'session')!.events).toHaveLength(4)
  await store.close()
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
  const corpus = { manifest: { sources: {}, catalog: catalog() }, fixtures: [] }
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
