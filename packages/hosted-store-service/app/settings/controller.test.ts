import { expect, test } from 'bun:test'
import { settingsController, type SettingsState } from './controller'
import type { ProjectSettings } from '../../src/web/project-secrets'
const empty: ProjectSettings = { secrets: [], accounts: [], configuration: 'available' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
test('pending writes never invent rows, acknowledge before reread and fence earlier polls', async () => {
  const old = deferred<ProjectSettings>(),
    fresh = deferred<ProjectSettings>(),
    write = deferred<void>()
  let reads = 0,
    acknowledged = 0
  const states: SettingsState[] = []
  const c = settingsController({
    read: () => (++reads === 1 ? old.promise : fresh.promise),
    write: () => write.promise,
    changed: (state) => states.push(state),
    acknowledged: () => {
      acknowledged++
    },
  })
  const poll = c.refresh()
  const submission = c.write('set', 'TOKEN', 'sentinel-secret')
  expect(states.at(-1)?.pending).toBe('TOKEN')
  expect(states.at(-1)?.data).toBeUndefined()
  expect(await c.write('remove', 'TOKEN')).toBe(false)
  await c.poll()
  expect(reads).toBe(1)
  write.resolve()
  expect(await submission).toBe(true)
  expect(acknowledged).toBe(1)
  fresh.resolve(empty)
  await Promise.resolve()
  old.resolve({ ...empty, configuration: 'unavailable' })
  await poll
  expect(states.at(-1)?.data).toEqual(empty)
  expect(JSON.stringify(states)).not.toContain('sentinel-secret')
})
test('acknowledged writes followed by failed rereads remain successful; arbitrary refusals are safe and persistent', async () => {
  let state: SettingsState = {},
    failWrite = false
  const c = settingsController({
    read: async () => {
      throw Error('sentinel-secret')
    },
    write: async () => {
      if (failWrite) throw Error('sentinel-secret')
    },
    changed: (next) => {
      state = next
    },
    acknowledged: () => {},
  })
  expect(await c.write('set', 'TOKEN', 'sentinel-secret')).toBe(true)
  await Promise.resolve()
  expect(state.readError).toContain('refresh')
  expect(state.writeError).toBeUndefined()
  failWrite = true
  expect(await c.write('set', 'TOKEN', 'sentinel-secret')).toBe(false)
  await c.refresh()
  expect(state.writeError).toContain('refused')
  expect(JSON.stringify(state)).not.toContain('sentinel-secret')
})
test('a project switch or unmount ignores old reads and write completion', async () => {
  const read = deferred<ProjectSettings>(),
    write = deferred<void>()
  const states: SettingsState[] = []
  let acknowledged = false
  const c = settingsController({
    read: () => read.promise,
    write: () => write.promise,
    changed: (s) => states.push(s),
    acknowledged: () => {
      acknowledged = true
    },
  })
  const pendingRead = c.refresh(),
    pendingWrite = c.write('set', 'TOKEN', 'sentinel-secret')
  c.dispose()
  const count = states.length
  read.resolve(empty)
  write.resolve()
  await pendingRead
  await pendingWrite
  expect(states).toHaveLength(count)
  expect(acknowledged).toBe(false)
})
