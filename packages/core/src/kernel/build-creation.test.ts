import { expect, test } from 'bun:test'
import { CREATION_KEY, creationBuildSlug, projectBuildSlugBase } from './build-creation'

test('a keyed creation derives one deterministic canonical slug per repository, request and key', () => {
  const slug = creationBuildSlug('repo', 'fix-login', 'prep_1a2b3c4d')
  expect(slug).toMatch(/^fix-login-[a-f0-9]{24}$/)
  expect(creationBuildSlug('repo', 'fix-login', 'prep_1a2b3c4d')).toBe(slug)
  expect(creationBuildSlug('other', 'fix-login', 'prep_1a2b3c4d')).not.toBe(slug)
  expect(creationBuildSlug('repo', 'fix-logout', 'prep_1a2b3c4d')).not.toBe(
    slug.replace('fix-login', 'fix-logout'),
  )
  expect(creationBuildSlug('repo', 'fix-login', 'prep_9a2b3c4d')).not.toBe(slug)
})

test('the slug base matches the allocating server normalization', () => {
  const long = `${'a'.repeat(59)}-${'b'.repeat(10)}`
  expect(projectBuildSlugBase(long)).toBe('a'.repeat(59))
  expect(creationBuildSlug('repo', long, 'k')).toMatch(
    new RegExp(`^${'a'.repeat(59)}-[a-f0-9]{24}$`),
  )
  expect(projectBuildSlugBase('trailing---')).toBe('trailing')
  expect(projectBuildSlugBase('plain')).toBe('plain')
})

test('creation keys are bounded attempt identifiers', () => {
  expect(CREATION_KEY.test('prep_1a2b3c4d')).toBe(true)
  expect(CREATION_KEY.test('')).toBe(false)
  expect(CREATION_KEY.test('a'.repeat(129))).toBe(false)
  expect(CREATION_KEY.test('has space')).toBe(false)
})
