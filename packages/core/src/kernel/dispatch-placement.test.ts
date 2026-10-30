import { expect, test } from 'bun:test'
import { dispatchPlacementReducer, dispatchPlacementSchema } from './dispatch-placement'
import { prepareRepositoryEventWrite, type RepositoryEvent } from '../events/repository'
import { decodeStoredEvent } from '../events/compatibility'

test('placement is unknown until service publication and follows the latest fact', () => {
  expect(dispatchPlacementReducer.reduce([])).toEqual({ status: 'unknown', reason: 'unrecorded' })
  const write = prepareRepositoryEventWrite({
    type: 'dispatcher.placement-set',
    actor: { kind: 'kernel' },
    payload: { hosted: true, origin: 'https://store.test' },
  })
  expect(write.compatibility?.classification).toBe('advisory')
  const event = { ...write, repo: 'repo', seq: 1, ts: new Date().toISOString() } as RepositoryEvent
  expect(dispatchPlacementReducer.reduce([event])).toEqual({
    status: 'known',
    placement: { hosted: true, origin: 'https://store.test' },
  })
  expect(
    dispatchPlacementReducer.reduce([
      event,
      { ...event, seq: 2, payload: { hosted: false } } as RepositoryEvent,
    ]),
  ).toEqual({ status: 'known', placement: { hosted: false } })
  expect(decodeStoredEvent({ ...event, type: 'future.advisory' })).toBeNull()
  for (const origin of [
    'not-a-url',
    'https://',
    'https://user:secret@store.test',
    'https://store.test/path',
    'file:///tmp',
    'https://store.test?secret=x',
  ])
    expect(
      dispatchPlacementSchema.safeParse({ status: 'known', placement: { hosted: true, origin } })
        .success,
    ).toBe(false)
})
