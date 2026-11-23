import { expect, test } from 'bun:test'
import { FakeRefreshScheduler } from '../testing/refresh-scheduler'
import { WebModelHub } from './hub'
import { type WebFrame, type WebFrameSource, WebReadFencedError } from './protocol'

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

/** A source whose reads stay pending until the test settles them. */
class DeferredSource implements WebFrameSource {
  active = 0
  peak = 0
  started = 0
  admitted: (() => boolean)[] = []
  private pending: ((frame: WebFrame) => void)[] = []
  read(admitted?: () => boolean) {
    this.started++
    this.active++
    this.peak = Math.max(this.peak, this.active)
    if (admitted) this.admitted.push(admitted)
    return new Promise<{ frame: WebFrame; live: boolean }>((resolve) => {
      this.pending.push((frame) => {
        this.active--
        resolve({ frame, live: false })
      })
    })
  }
  settle(frame: WebFrame) {
    this.pending.shift()?.(frame)
  }
}

test('a reconnect during a pending read joins it instead of starting another', async () => {
  const source = new DeferredSource()
  const time = new FakeRefreshScheduler()
  const hub = new WebModelHub({ source, networkReads: true, scheduler: time })
  const off = hub.subscribe(() => {})
  await time.settle()
  expect(source.started).toBe(1)
  off()
  // The pending read is now fenced: nobody wants its frame.
  expect(source.admitted[0]!()).toBe(false)
  const received: string[] = []
  hub.subscribe((json) => received.push(json))
  await time.settle()
  expect(source.started).toBe(1)
  expect(source.peak).toBe(1)
  // The reconnected tab admits the shared read again.
  expect(source.admitted[0]!()).toBe(true)
  // Repeated reloads while the read is pending still share it.
  for (let i = 0; i < 5; i++) hub.subscribe(() => {})()
  await time.settle()
  expect(source.started).toBe(1)
  source.settle({ notice: 'joined' })
  await hub.join()
  expect(received).toEqual([JSON.stringify({ notice: 'joined' })])
  expect(source.peak).toBe(1)
  hub.close()
})

test('a fenced read publishes nothing and reports no failure', async () => {
  const errors: unknown[] = []
  const time = new FakeRefreshScheduler()
  let reject!: (error: unknown) => void
  const source: WebFrameSource = {
    read: () =>
      new Promise((_, fail) => {
        reject = fail
      }),
  }
  const hub = new WebModelHub({
    source,
    networkReads: false,
    scheduler: time,
    onError: (error) => errors.push(error),
  })
  const off = hub.subscribe(() => {})
  await time.settle()
  off()
  reject(new WebReadFencedError())
  await hub.join()
  expect(hub.current).toBeUndefined()
  expect(errors).toEqual([])
  await time.advance(60_000)
  expect(time.tasks.size).toBe(0)
  hub.close()
})
