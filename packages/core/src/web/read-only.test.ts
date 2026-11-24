import { expect, test } from 'bun:test'
import { readOnlyStore } from './read-only'

class Fake {
  networkReads = true
  writes: string[] = []
  async getRepo(repo: string) {
    this.save(repo)
    return { repo }
  }
  listBuildsForRepo() {
    return []
  }
  close() {
    return 'closed'
  }
  append() {
    this.writes.push('append')
  }
  ensureRepo() {
    this.writes.push('ensureRepo')
  }
  private save(repo: string) {
    this.writes.push(`internal:${repo}`)
  }
}

test('reads pass through with the real store as this', async () => {
  const fake = new Fake()
  const guarded = readOnlyStore(fake)
  expect(await guarded.getRepo('r')).toEqual({ repo: 'r' })
  expect(guarded.listBuildsForRepo()).toEqual([])
  expect(guarded.close()).toBe('closed')
  expect(guarded.networkReads).toBe(true)
  expect(fake.writes).toEqual(['internal:r'])
})

test('every other method throws without reaching the store', () => {
  const fake = new Fake()
  const guarded = readOnlyStore(fake)
  expect(() => guarded.append()).toThrow('ab web is read-only: append')
  expect(() => guarded.ensureRepo()).toThrow('ab web is read-only: ensureRepo')
  expect(fake.writes).toEqual([])
})
