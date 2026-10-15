import { expect, test } from 'bun:test'
import { legacyProjectRepositories, normalizeProjectRepository } from './projects'

test('normalizes network git origins and legacy CSV without losing identity', () => {
  expect(normalizeProjectRepository('git@GitHub.com:acme/app.git')).toBe(
    'https://github.com/acme/app',
  )
  expect(
    legacyProjectRepositories({
      AB_WEB_REPOSITORIES: 'git@github.com:acme/app.git, https://github.com/acme/app',
    }),
  ).toEqual(['https://github.com/acme/app'])
  expect(legacyProjectRepositories({})).toEqual([])
})
test.each([
  '',
  '/tmp/repo',
  'acme/app',
  'https://user:password@github.com/a/b',
  'https://user@github.com/a/b',
  'https://github.com',
  'https://github.com/a/b?query',
  'https://github.com/a/b#hash',
  'file:///tmp/repo',
  'https://github.com/a/ b',
])('rejects unsafe identity %s', (repo) => {
  expect(() => normalizeProjectRepository(repo)).toThrow()
})
