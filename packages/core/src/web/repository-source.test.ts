import { expect, test } from 'bun:test'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { yieldedNewcomerJournal } from '../testing/dispatch-journals'
import { projectRepositoryFrame } from './repository-source'

test('a yielded newcomer leaves the frame on the live holder', () => {
  const { frame, live } = projectRepositoryFrame(
    '/repo',
    repositoryReadFactsReducer.reduce(yieldedNewcomerJournal()),
  )
  expect(live).toBe(true)
  expect(frame.repository).toMatchObject({ queued: 11, triage: 3 })
  expect(JSON.stringify(frame.repository)).toContain('A role warning')
  expect(JSON.stringify(frame.repository)).not.toContain('B role warning')
})
