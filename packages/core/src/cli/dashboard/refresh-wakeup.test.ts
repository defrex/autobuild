import { expect, test } from 'bun:test'
import { FakeRefreshScheduler } from '../../testing/refresh-scheduler'
import { DashboardRefresh } from './refresh'

test('a focus round trip ending unfocused cannot leave a duplicate wakeup on the next gain', async () => {
  const time = new FakeRefreshScheduler()
  let reads = 0
  let release!: () => void
  const controller = new DashboardRefresh(async () => {
    reads++
    if (reads === 1)
      await new Promise<void>((done) => {
        release = done
      })
  }, time)
  controller.activity(false)
  void controller.request()
  await time.settle()
  controller.focus(false)
  controller.focus(true)
  controller.focus(false)
  release()
  await time.settle()
  controller.focus(true)
  await time.settle()
  expect(reads).toBe(2)
  await time.advance(4999)
  expect(reads).toBe(2)
  controller.stop()
})

test('a refresh finishing just before its deadline keeps the cadence from its start', async () => {
  const time = new FakeRefreshScheduler()
  let reads = 0
  let release!: () => void
  const controller = new DashboardRefresh(async () => {
    reads++
    if (reads === 1)
      await new Promise<void>((done) => {
        release = done
      })
  }, time)
  void controller.request()
  await time.advance(480)
  release()
  await time.settle()
  await time.advance(21)
  expect(reads).toBe(2)
  controller.stop()
})

test('each repeated key renews the entire thirty-second fast hold', async () => {
  const time = new FakeRefreshScheduler()
  let reads = 0
  const controller = new DashboardRefresh(async () => {
    reads++
  }, time)
  controller.activity(false)
  controller.interaction()
  await time.advance(29_000)
  controller.interaction()
  await time.advance(29_999)
  expect(reads).toBe(118)
  await time.advance(2)
  expect(reads).toBe(119)
  await time.advance(4998)
  expect(reads).toBe(119)
  controller.stop()
})
