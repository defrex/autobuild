import { describe, expect, test } from 'bun:test'
import { EVENT_WAIT_POLL_MS as fromAdapter } from '@defrex/autobuild/store-adapter'
import { EVENT_WAIT_POLL_MS as fromStore } from './store'

describe('EVENT_WAIT_POLL_MS unification (AUT-388)', () => {
  test('the postgres-store export is the core binding, not a copy', () => {
    expect(fromStore).toBe(fromAdapter)
  })
})
