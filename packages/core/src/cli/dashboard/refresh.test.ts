import { expect, test } from 'bun:test'
import { FakeRefreshScheduler } from '../../testing/refresh-scheduler'
import { DashboardRefresh, presentationReader } from './refresh'

for (const state of ['paused', 'idle', 'live'] as const) {
  test(`a simulated minute of ${state} pins refresh starts`, async () => {
    const time = new FakeRefreshScheduler()
    let reads = 0
    const controller = new DashboardRefresh(async () => {
      reads++
    }, time)
    controller.activity(state === 'live')
    if (state === 'paused') controller.focus(false)
    else void controller.request()
    await time.advance(60_000)
    expect(reads).toBe(state === 'paused' ? 0 : state === 'idle' ? 12 : 120)
    controller.stop()
  })
}

test('keys wake a paused controller once and hold fast cadence for thirty seconds', async () => {
  const time = new FakeRefreshScheduler()
  let reads = 0
  const controller = new DashboardRefresh(async () => {
    reads++
  }, time)
  controller.activity(false)
  controller.focus(false)
  controller.interaction()
  await time.settle()
  expect(reads).toBe(1)
  await time.advance(60_000)
  expect(reads).toBe(1)
  controller.focus(true)
  await time.settle()
  expect(reads).toBe(2)
  controller.interaction()
  await time.settle()
  const start = reads
  await time.advance(30_000)
  expect(reads - start).toBe(59)
  await time.advance(1)
  const after = reads
  await time.advance(4999)
  expect(reads).toBe(after)
  controller.stop()
})

test('loss between asynchronous read stages fences subsequent calls and focus gain is retained', async () => {
  const time = new FakeRefreshScheduler()
  let release!: () => void
  let reads = 0
  let controller!: DashboardRefresh
  const reader = presentationReader(
    {
      async getFirst() {
        reads++
        await new Promise<void>((done) => {
          release = done
        })
      },
      async getSecond() {
        reads++
      },
    },
    () => controller.admitted,
  )
  controller = new DashboardRefresh(async () => {
    await reader.getFirst()
    await reader.getSecond()
  }, time)
  void controller.request()
  await time.settle()
  controller.focus(false)
  release()
  await time.settle()
  expect(reads).toBe(1)
  controller.focus(true)
  await time.settle()
  expect(reads).toBe(2)
  controller.focus(false)
  controller.focus(true)
  release()
  await time.settle()
  expect(reads).toBe(4) // second stage then a fresh focus-in refresh
  controller.stop()
  release()
  await time.settle()
  expect(reads).toBe(4)
})

test('slow failures stay single flight and retry without a timer backlog', async () => {
  const time = new FakeRefreshScheduler()
  let reject!: (error: Error) => void
  let starts = 0
  const controller = new DashboardRefresh(() => {
    starts++
    return new Promise((_, fail) => {
      reject = fail
    })
  }, time)
  void controller.request()
  await time.settle()
  controller.interaction()
  await time.advance(60_000)
  expect(starts).toBe(1)
  reject(new Error('offline'))
  await time.settle()
  await time.advance(51)
  expect(starts).toBe(2)
  controller.stop()
  reject(new Error('offline'))
  await time.advance(60_000)
  expect(starts).toBe(2)
})

test('an action permit survives awaits without admitting automatic reads in that action context', async () => {
  const { interactionRead } = await import('./refresh')
  const time = new FakeRefreshScheduler()
  let reads = 0
  const reader = presentationReader(
    {
      async getValue() {
        reads++
      },
    },
    () => false,
  )
  const controller = new DashboardRefresh(async () => {
    await reader.getValue()
  }, time)
  await interactionRead(async () => {
    await Promise.resolve()
    await reader.getValue()
    await controller.request() // Automatic reads explicitly clear the action intent.
  })
  expect(reads).toBe(1)
  controller.stop()
})
