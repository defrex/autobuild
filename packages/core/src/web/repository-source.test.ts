import { expect, test } from 'bun:test'
import { repositoryReadFactsReducer } from '../kernel/read-facts'
import { yieldedNewcomerJournal } from '../testing/dispatch-journals'
import { projectRepositoryFrame } from './repository-source'

test('a yielded newcomer leaves the frame on the live holder', () => {
  const facts = repositoryReadFactsReducer.reduce(yieldedNewcomerJournal())
  const { frame, live } = projectRepositoryFrame('/repo', facts)
  expect(live).toBe(true)
  expect(facts.status).toMatchObject({ run: 'run-a', queued: 11 })
  // The header's queue depth is the latest ticket scan's (#1278); this journal records none.
  expect(frame.repository).toMatchObject({ queued: 0, triage: 3 })
  expect(JSON.stringify(frame.repository)).toContain('A role warning')
  expect(JSON.stringify(frame.repository)).not.toContain('B role warning')
})
