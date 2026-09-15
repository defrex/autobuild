/**
 * The per-stream mutex primitive (AUT-348) in isolation: strict mutual
 * exclusion per key, FIFO launch order, release-on-throw without poisoning
 * later holders, error/result passthrough, and full independence between
 * keys.
 */
import { describe, expect, test } from 'bun:test'
import { StreamLocks } from './lock'

describe('StreamLocks', () => {
  test('concurrent holders on one key never overlap (strict mutual exclusion)', async () => {
    const locks = new StreamLocks()
    let depth = 0
    let overlaps = 0
    const holder = () =>
      locks.run('stream-a', async () => {
        depth += 1
        if (depth > 1) overlaps += 1
        // A suspension point wide enough for any other holder to intrude if
        // the mutex failed — the overlap count, not timing, is the assertion.
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        depth -= 1
      })
    await Promise.all(Array.from({ length: 6 }, holder))
    expect(overlaps).toBe(0)
    expect(depth).toBe(0)
  })

  test('holders run in FIFO launch order', async () => {
    const locks = new StreamLocks()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        locks.run('stream-a', async () => {
          order.push(index)
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  test('a throwing holder releases the key and does not poison later holders', async () => {
    const locks = new StreamLocks()
    const failed = locks.run('stream-a', async () => {
      throw new Error('holder failed')
    })
    const later = locks.run('stream-a', async () => 'later ran')
    const err = await failed.catch((e: unknown) => e)
    expect((err as Error).message).toBe('holder failed')
    expect(await later).toBe('later ran')
    // The key still works for holders enqueued after the failure.
    expect(await locks.run('stream-a', () => 'after failure')).toBe('after failure')
  })

  test('results and errors pass through to each caller', async () => {
    const locks = new StreamLocks()
    expect(await locks.run('k', () => Promise.resolve(42))).toBe(42)
    const err = await locks
      .run('k', () => Promise.reject(new Error('boom')))
      .catch((e: unknown) => e)
    expect((err as Error).message).toBe('boom')
  })

  test('keys are independent: a held key never blocks another', async () => {
    const locks = new StreamLocks()
    let releaseA!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const held = locks.run('stream-a', () => gate)
    // Stream B completes while stream A's holder is still suspended.
    expect(await locks.run('stream-b', () => Promise.resolve('b done'))).toBe('b done')
    releaseA()
    await held
  })
})
