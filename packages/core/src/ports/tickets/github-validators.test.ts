import { describe, expect, test } from 'bun:test'
import { MemoryGitHubValidatorStore } from './github-validators'
const DAY = 24 * 60 * 60 * 1000
const ENTRY = { etag: '"v1"', json: [{ number: 1 }], link: '<x>; rel="next"' }

describe('MemoryGitHubValidatorStore', () => {
  test('evicts by age with the same touch throttle, never by count', async () => {
    let now = 0
    const store = new MemoryGitHubValidatorStore({ now: () => now })
    for (let i = 0; i < 5000; i++) await store.set(`GET ${i}?`, ENTRY)
    expect(store.size).toBe(5000)
    now = 6 * DAY
    await store.touch('GET 1?')
    now = 8 * DAY
    expect(await store.get('GET 1?')).toEqual(ENTRY)
    expect(await store.get('GET 2?')).toBeUndefined()
    expect(store.size).toBe(1)
  })
})
