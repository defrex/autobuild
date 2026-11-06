import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileGitHubValidatorStore,
  MemoryGitHubValidatorStore,
  VALIDATOR_SWEEP_INTERVAL_MS,
  VALIDATOR_TOUCH_INTERVAL_MS,
} from './github-validators'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function dir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-github-validators-'))
  roots.push(root)
  return join(root, 'validators')
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ENTRY = { etag: '"v1"', json: [{ number: 1 }], link: '<x>; rel="next"' }

describe('FileGitHubValidatorStore', () => {
  test('round-trips entries, and a second instance reads the first one’s files', async () => {
    const path = await dir()
    const first = new FileGitHubValidatorStore(path)
    expect(await first.get('GET a?')).toBeUndefined()
    await first.set('GET a?', ENTRY)
    expect(await first.get('GET a?')).toEqual(ENTRY)
    expect(await new FileGitHubValidatorStore(path).get('GET a?')).toEqual(ENTRY)
    expect(await new FileGitHubValidatorStore(path).get('GET b?')).toBeUndefined()
  })

  test('a corrupt or foreign file is a miss and is overwritten', async () => {
    const path = await dir()
    const store = new FileGitHubValidatorStore(path)
    await store.set('GET a?', ENTRY)
    const [file] = (await readdir(path)).filter((name) => name.endsWith('.json'))
    await writeFile(join(path, file!), '{ torn')
    const fresh = new FileGitHubValidatorStore(path)
    expect(await fresh.get('GET a?')).toBeUndefined()
    await fresh.set('GET a?', { ...ENTRY, etag: '"v2"' })
    expect(await new FileGitHubValidatorStore(path).get('GET a?')).toEqual({
      ...ENTRY,
      etag: '"v2"',
    })
  })

  test('two instances writing one key leave one readable entry', async () => {
    const path = await dir()
    const a = new FileGitHubValidatorStore(path)
    const b = new FileGitHubValidatorStore(path)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).set('GET a?', { etag: `"v${i}"`, json: i }),
      ),
    )
    const read = await new FileGitHubValidatorStore(path).get('GET a?')
    expect(read?.etag).toMatch(/^"v\d+"$/)
    expect((await readdir(path)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  test('hits refresh last use at most once an hour', async () => {
    const path = await dir()
    let now = Date.parse('2026-11-06T00:00:00Z')
    const touches: string[] = []
    const store = new FileGitHubValidatorStore(path, {
      now: () => now,
      utimes: async (file, at) => {
        touches.push(file)
        await utimes(file, at, at)
      },
    })
    await store.set('GET a?', ENTRY)
    for (let i = 0; i < 10; i++) {
      now += 5 * 60 * 1000
      await store.touch('GET a?')
    }
    expect(touches).toHaveLength(0)
    now += VALIDATOR_TOUCH_INTERVAL_MS
    await store.touch('GET a?')
    await store.touch('GET a?')
    expect(touches).toHaveLength(1)
    // A rewrite with the same ETag is a use, not a write.
    now += VALIDATOR_TOUCH_INTERVAL_MS + 1
    await store.set('GET a?', ENTRY)
    expect(touches).toHaveLength(2)
  })

  test('the daily sweep evicts entries unused for seven days and keeps recent ones', async () => {
    const path = await dir()
    const start = Date.parse('2026-11-06T00:00:00Z')
    let now = start
    const writer = new FileGitHubValidatorStore(path, { now: () => now })
    await writer.set('GET old?', ENTRY)
    now = start + 2 * DAY
    await writer.set('GET recent?', ENTRY)
    now = start + 8 * DAY
    const reader = new FileGitHubValidatorStore(path, { now: () => now })
    expect(await reader.get('GET recent?')).toEqual(ENTRY)
    expect(await reader.get('GET old?')).toBeUndefined()
    expect((await readdir(path)).filter((name) => name.endsWith('.json'))).toHaveLength(1)
    // The sweep marker gates the next directory listing for a day: an aged
    // entry stays on disk (and reads as a miss) until the next sweep.
    await reader.set('GET planted?', ENTRY)
    const planted = (await readdir(path)).filter((name) => name.endsWith('.json'))
    for (const name of planted) await utimes(join(path, name), new Date(start), new Date(start))
    now += HOUR
    const gated = new FileGitHubValidatorStore(path, { now: () => now })
    expect(await gated.get('GET planted?')).toBeUndefined()
    expect((await readdir(path)).filter((name) => name.endsWith('.json'))).toHaveLength(2)
    now += VALIDATOR_SWEEP_INTERVAL_MS
    await new FileGitHubValidatorStore(path, { now: () => now }).get('GET planted?')
    expect((await readdir(path)).filter((name) => name.endsWith('.json'))).toHaveLength(0)
  })
})

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
