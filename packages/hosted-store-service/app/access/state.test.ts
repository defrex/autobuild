import { expect, test } from 'bun:test'
import { latestRequest, mutationGate } from './state'
import { organizationSlug } from './api'
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
test('latest request excludes switched organization and unmounted responses', () => {
  const gate = latestRequest()
  const old = gate.start()
  const current = gate.start()
  expect(gate.current(old)).toBe(false)
  expect(gate.current(current)).toBe(true)
  gate.invalidate()
  expect(gate.current(current)).toBe(false)
})
test('writes are excluded immediately; acknowledged refresh precedes success', async () => {
  const write = deferred(),
    refresh = deferred(),
    gate = mutationGate()
  let writes = 0
  let reads = 0
  const run = () =>
    gate(
      async () => {
        writes++
        await write.promise
      },
      async () => {
        reads++
        await refresh.promise
      },
      () => {},
    )
  const first = run()
  expect(await run()).toBe(false)
  expect(writes).toBe(1)
  expect(reads).toBe(0)
  write.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(reads).toBe(1)
  refresh.resolve()
  expect(await first).toBe(true)
})
test('refusal text and saved-but-refresh-failed remain distinct', async () => {
  const gate = mutationGate()
  let error = ''
  let reads = 0
  expect(
    await gate(
      async () => {
        throw new Error('owners cannot remove themselves')
      },
      async () => {
        reads++
      },
      (s) => {
        error = s
      },
    ),
  ).toBe(false)
  expect(error).toBe('owners cannot remove themselves')
  expect(reads).toBe(0)
  expect(
    await gate(
      async () => {},
      async () => {
        throw new Error('offline')
      },
      (s) => {
        error = s
      },
    ),
  ).toBe(false)
  expect(error).toContain('Change saved, but refresh failed: offline')
})
test('organization slug is deterministic, bounded, and rejects missing letters/numbers', () => {
  expect(organizationSlug(' Équipe / Product ')).toBe('equipe-product')
  expect(organizationSlug('A'.repeat(110))).toHaveLength(100)
  expect(() => organizationSlug('---')).toThrow('letters or numbers')
})
