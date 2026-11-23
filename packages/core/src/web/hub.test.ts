import { expect, test } from 'bun:test'
import { FakeRefreshScheduler } from '../testing/refresh-scheduler'
import { WebModelHub } from './hub'
import type { WebFrame, WebFrameSource } from './protocol'

class CountingSource implements WebFrameSource {
  reads = 0
  frame: WebFrame = { notice: 'one' }
  live = false
  fail: Error | undefined
  async read() {
    this.reads++
    if (this.fail) throw this.fail
    return { frame: this.frame, live: this.live }
  }
}

function setup() {
  const source = new CountingSource()
  const time = new FakeRefreshScheduler()
  const errors: unknown[] = []
  const hub = new WebModelHub({
    source,
    networkReads: false,
    scheduler: time,
    onError: (error) => errors.push(error),
  })
  return { source, time, hub, errors }
}

test('no subscribers read nothing and leave no timer', async () => {
  const { source, time, hub } = setup()
  await time.advance(60_000)
  expect(source.reads).toBe(0)
  expect(time.tasks.size).toBe(0)
  expect(hub.subscribers).toBe(0)
})

test('ten subscribers cost the same reads as one, and each gets every changed frame once', async () => {
  const counts: number[] = []
  for (const n of [1, 10]) {
    const { source, time, hub } = setup()
    const received: string[][] = Array.from({ length: n }, () => [])
    for (const list of received) hub.subscribe((json) => list.push(json))
    await hub.join()
    await time.advance(5_000 * 3)
    source.frame = { notice: 'two' }
    await time.advance(5_000 * 3)
    counts.push(source.reads)
    for (const list of received)
      expect(list).toEqual([JSON.stringify({ notice: 'one' }), JSON.stringify({ notice: 'two' })])
    hub.close()
  }
  expect(counts[0]).toBe(counts[1])
  expect(counts[0]).toBeGreaterThan(2)
})

test('the last unsubscribe stops reads; a resubscribe gets the cached frame first', async () => {
  const { source, time, hub } = setup()
  const first: string[] = []
  const off = hub.subscribe((json) => first.push(json))
  await hub.join()
  expect(first).toEqual([JSON.stringify({ notice: 'one' })])
  off()
  off()
  expect(hub.subscribers).toBe(0)
  const reads = source.reads
  await time.advance(60_000)
  expect(source.reads).toBe(reads)
  expect(time.tasks.size).toBe(0)
  source.frame = { notice: 'later' }
  const second: string[] = []
  hub.subscribe((json) => second.push(json))
  expect(second).toEqual([JSON.stringify({ notice: 'one' })])
  await hub.join()
  expect(source.reads).toBe(reads + 1)
  expect(second).toEqual([JSON.stringify({ notice: 'one' }), JSON.stringify({ notice: 'later' })])
  hub.close()
})

test('a throwing listener is removed without breaking the fan-out', async () => {
  const { source, hub } = setup()
  const good: string[] = []
  hub.subscribe(() => {
    throw new Error('closed socket')
  })
  hub.subscribe((json) => good.push(json))
  await hub.join()
  expect(good).toHaveLength(1)
  expect(hub.subscribers).toBe(1)
  expect(source.reads).toBe(1)
  hub.close()
})

test('a failure publishes a notice and reports once per streak', async () => {
  const { source, time, hub, errors } = setup()
  const received: string[] = []
  source.fail = new Error('store down')
  hub.subscribe((json) => received.push(json))
  await hub.join()
  await time.advance(20_000)
  expect(received).toEqual([JSON.stringify({ notice: 'Viewer unavailable: store down' })])
  expect(errors).toHaveLength(1)
  source.fail = undefined
  await time.advance(5_000)
  expect(received.at(-1)).toBe(JSON.stringify({ notice: 'one' }))
  source.fail = new Error('again')
  await time.advance(5_000)
  expect(errors).toHaveLength(2)
  hub.close()
})

test('live frames ask for the fast cadence', async () => {
  const { source, time, hub } = setup()
  source.live = true
  hub.subscribe(() => {})
  await hub.join()
  const reads = source.reads
  await time.advance(5_000)
  expect(source.reads - reads).toBeGreaterThanOrEqual(9)
  hub.close()
})
