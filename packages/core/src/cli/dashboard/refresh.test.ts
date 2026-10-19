import { expect, test } from 'bun:test'
import { FakeRefreshScheduler } from '../../testing/refresh-scheduler'
import { DashboardRefresh, presentationReader } from './refresh'

for (const network of [false, true]) {
  for (const focused of [false, true]) {
    for (const live of [false, true]) {
      test(`cadence network=${network} focused=${focused} live=${live}`, async () => {
        const time = new FakeRefreshScheduler()
        const starts: number[] = []
        const controller = new DashboardRefresh(
          async () => {
            starts.push(time.now())
          },
          time,
          network,
        )
        controller.activity(live)
        controller.focus(focused)
        await controller.request()
        await time.advance(10_001)
        const interval = network && !focused ? 5000 : live ? 500 : 5000
        expect(starts.slice(0, 3)).toEqual([0, interval, interval * 2])
        controller.stop()
      })
    }
  }
}

test('network keys wake immediately but never accelerate unfocused automatic polling', async () => {
  const time = new FakeRefreshScheduler()
  const starts: number[] = []
  const controller = new DashboardRefresh(
    async () => {
      starts.push(time.now())
    },
    time,
    true,
  )
  controller.focus(false)
  controller.interaction()
  await time.settle()
  await time.advance(1000)
  controller.focus(false)
  controller.interaction()
  await time.settle()
  await time.advance(4999)
  expect(starts).toEqual([0, 1000])
  await time.advance(2)
  expect(starts).toEqual([0, 1000, 6000])
  controller.stop()
})

for (const fence of ['focus', 'suspend', 'stop'] as const) {
  test(`asynchronous stages survive focus but respect ${fence}`, async () => {
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
    if (fence === 'focus') controller.focus(false)
    else controller[fence]()
    release()
    await time.settle()
    expect(reads).toBe(fence === 'focus' ? 2 : 1)
    controller.stop()
  })
}

test('slow unfocused network failures wait a full idle interval after completion', async () => {
  const time = new FakeRefreshScheduler()
  let reject!: (error: Error) => void
  const starts: number[] = []
  const controller = new DashboardRefresh(
    () => {
      starts.push(time.now())
      return new Promise((_, fail) => {
        reject = fail
      })
    },
    time,
    true,
  )
  controller.focus(false)
  void controller.request()
  await time.advance(10_000)
  reject(new Error('offline'))
  await time.settle()
  await time.advance(4999)
  expect(starts).toEqual([0])
  await time.advance(2)
  expect(starts).toEqual([0, 15_000])
  controller.stop()
  reject(new Error('offline'))
  await time.settle()
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

test('focus-out recalculates network deadline once without delaying local cadence', async () => {
  for (const network of [false, true]) {
    const time = new FakeRefreshScheduler()
    const starts: number[] = []
    const controller = new DashboardRefresh(
      async () => {
        starts.push(time.now())
      },
      time,
      network,
    )
    await controller.request()
    await time.advance(200)
    controller.focus(false)
    await time.advance(200)
    controller.focus(false)
    await time.advance(network ? 4599 : 99)
    expect(starts).toEqual([0])
    await time.advance(2)
    expect(starts).toEqual([0, network ? 5000 : 500])
    controller.stop()
  }
})

test('resume refreshes immediately even if suspension began focused', async () => {
  const time = new FakeRefreshScheduler()
  let reads = 0
  const controller = new DashboardRefresh(async () => {
    reads++
  }, time)
  await controller.request()
  controller.suspend()
  await time.advance(10_000)
  expect(reads).toBe(1)
  controller.resume()
  await time.settle()
  expect(reads).toBe(2)
  await time.advance(501)
  expect(reads).toBe(3)
  controller.stop()
})

test('a key during an outstanding read retains one immediate wakeup', async () => {
  const time = new FakeRefreshScheduler()
  let release!: () => void
  let reads = 0
  const controller = new DashboardRefresh(
    async () => {
      if (++reads === 1)
        await new Promise<void>((done) => {
          release = done
        })
    },
    time,
    true,
  )
  controller.focus(false)
  void controller.request()
  await time.settle()
  controller.interaction()
  controller.interaction()
  release()
  await time.settle()
  expect(reads).toBe(2)
  await time.advance(4999)
  expect(reads).toBe(2)
  controller.stop()
})
