import { describe, expect, test } from 'bun:test'
import {
  buildTrailers,
  hasBuildTrailer,
  historyContainsBuild,
  withBuildTrailer,
} from './build-identity'

describe('build identity', () => {
  test('normalizes only terminal identity trailers and keeps unrelated bytes', () => {
    const body =
      'A title\n\nA body mentioning Autobuild-Build: example\n\nCo-authored-by: A <a@example.test>\nAutobuild-Build: old\nAutobuild-Build: duplicate\nReviewed-by: B\n'
    const expected =
      'A title\n\nA body mentioning Autobuild-Build: example\n\nCo-authored-by: A <a@example.test>\nReviewed-by: B\nAutobuild-Build: example\n'
    expect(withBuildTrailer(body, 'example')).toBe(expected)
    expect(withBuildTrailer(expected, 'example')).toBe(expected)
    expect(buildTrailers(expected)).toEqual(['example'])
  })
  test('empty body, separator and newline contract', () => {
    expect(withBuildTrailer('', 'example')).toBe('Autobuild-Build: example\n')
    expect(withBuildTrailer('Subject\n', 'example')).toBe('Subject\n\nAutobuild-Build: example\n')
    expect(withBuildTrailer('Subject\n\nCo-authored-by: X\n', 'example')).toBe(
      'Subject\n\nCo-authored-by: X\nAutobuild-Build: example\n',
    )
  })
  test('exact values, terminal block and continuations', () => {
    expect(hasBuildTrailer('Subject\n\nAutobuild-Build: example', 'example')).toBe(true)
    for (const message of [
      'Mention Autobuild-Build: example',
      'Autobuild-Build: example-long',
      'Autobuild-Build: example\n\nProse',
      'Autobuild-Build: example\n continued',
    ]) {
      expect(hasBuildTrailer(message, 'example')).toBe(false)
    }
    expect(buildTrailers('Subject\n\nAutobuild-Build: first\nAutobuild-Build: second')).toEqual([
      'first',
      'second',
    ])
    expect(() => withBuildTrailer('', 'bad\nInjected: value')).toThrow('invalid build slug')
  })
  test('history stops on proof and propagates inspection errors', async () => {
    async function* messages() {
      yield 'prose'
      yield 'Subject\n\nAutobuild-Build: example'
      throw new Error('not reached')
    }
    expect(await historyContainsBuild(messages(), 'example')).toBe(true)
    await expect(historyContainsBuild(messages(), 'absent')).rejects.toThrow('not reached')
  })
})

test('CRLF prefixes and unrelated trailers retain bytes and normalize idempotently', () => {
  const source = 'Subject\r\n\r\nCo-authored-by: A\r\nAutobuild-Build: old\r\n'
  const normalized = withBuildTrailer(source, 'example')
  expect(normalized).toBe('Subject\r\n\r\nCo-authored-by: A\r\nAutobuild-Build: example\n')
  expect(withBuildTrailer(normalized, 'example')).toBe(normalized)
  expect(hasBuildTrailer(normalized, 'example')).toBe(true)
  const identityOnly = 'Subject\r\n\r\nAutobuild-Build: example\n'
  expect(withBuildTrailer(identityOnly, 'example')).toBe(identityOnly)
})

test('subject mentions are not trailers; Git signoffs admit mixed terminal blocks', () => {
  expect(hasBuildTrailer('Autobuild-Build: example\n', 'example')).toBe(false)
  const mixed = 'Subject\n\nProse\nSigned-off-by: A\nAutobuild-Build: example\n'
  expect(hasBuildTrailer(mixed, 'example')).toBe(true)
  expect(withBuildTrailer(mixed, 'example')).toBe(mixed)
})

test('full messages preserve trailer-like subjects, and empty subjects get a trailer block', () => {
  const subject = 'Autobuild-Build: old'
  const normalized = withBuildTrailer(subject, 'example', { includesSubject: true })
  expect(normalized).toBe('Autobuild-Build: old\n\nAutobuild-Build: example\n')
  expect(buildTrailers(normalized)).toEqual(['example'])
  expect(withBuildTrailer(normalized, 'example', { includesSubject: true })).toBe(normalized)
  const empty = withBuildTrailer('', 'example', { includesSubject: true })
  expect(empty).toBe('\n\nAutobuild-Build: example\n')
  expect(hasBuildTrailer(empty, 'example')).toBe(true)
})

test('multiple blank separators keep the original prefix and one canonical trailer', () => {
  const normalized = withBuildTrailer('Subject\n\n\nAutobuild-Build: old\n', 'example')
  expect(normalized).toBe('Subject\n\n\nAutobuild-Build: example\n')
  expect(buildTrailers(normalized)).toEqual(['example'])
  expect(withBuildTrailer(normalized, 'example')).toBe(normalized)
})
