import { expect, test } from 'bun:test'
import { canDelete, validDeletionPreview } from './api'
const repo = 'https://github.com/acme/one'
const preview = { repo, token: 'one', builds: 1, tickets: 2, secrets: 0, subscriptionAccounts: 0 }
test('exact identity and complete repository-bound preview are required', () => {
  for (const typed of [
    '',
    `${repo}/`,
    repo.toUpperCase(),
    ` ${repo}`,
    'https://github.com/acme/two',
  ])
    expect(canDelete(repo, typed, preview)).toBe(false)
  expect(canDelete(repo, repo, preview)).toBe(true)
  for (const value of [
    null,
    {},
    { ...preview, token: '' },
    { ...preview, repo: 'other' },
    { ...preview, builds: -1 },
  ])
    expect(validDeletionPreview(value, repo)).toBe(false)
})
