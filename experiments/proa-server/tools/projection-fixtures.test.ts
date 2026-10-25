import { expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { experiment, readCorpus } from './fixture-core'
import { checkProjection } from './projection-fixtures'

function stored() {
  return JSON.parse(
    gunzipSync(readFileSync(resolve(experiment, 'fixtures/projection.json.gz'))).toString('utf8'),
  )
}
test('display oracle covers every build log, preserves aliases and recomputes TypeScript answers', () => {
  const corpus = stored()
  expect(corpus.fixtures.map((fixture: { id: string }) => fixture.id)).toEqual(
    readCorpus()
      .fixtures.filter((fixture) => fixture.scope === 'build')
      .map((fixture) => fixture.id),
  )
  checkProjection(corpus)
  corpus.fixtures[0].expected.row = { slug: 'invented' }
  expect(() => checkProjection(corpus)).toThrow('stale projection oracle')
}, 60000)
test('stream metadata can close a displayed stream without a build event', () => {
  const corpus = stored()
  expect(
    corpus.sessionCases.some((fixture: { streams?: unknown[] }) => fixture.streams === undefined),
  ).toBe(true)
  expect(
    corpus.sessionCases.some((fixture: { streams?: unknown[] }) => fixture.streams?.length === 0),
  ).toBe(true)
  expect(
    corpus.sessionCases.some(
      (fixture: { expected: { row?: { sessions?: { streamStatus: string }[] } } }) =>
        fixture.expected.row?.sessions?.some((session) => session.streamStatus === 'open'),
    ),
  ).toBe(true)
  expect(
    corpus.sessionCases.some(
      (fixture: { expected: { row?: { sessions?: { streamStatus: string }[] } } }) =>
        fixture.expected.row?.sessions?.some((session) => session.streamStatus === 'closed'),
    ),
  ).toBe(true)
})
